"""One clip, end to end: fetch (static / browser / auto) -> extract -> images -> Markdown -> folder."""

from __future__ import annotations

import json
import shutil
import tempfile
import time
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from app.core.platform import chmod_private

from . import extract, fetcher
from .htmltree import parse
from .images import Downloader, Item
from .markdown import collect_images, to_markdown
from .netguard import BlockedURL, FetchError, Policy, check_url, make_client, public_only, strip_query
from .storage import make_dir, publish, slugify, write_text

DEFAULTS = {
    "user_agent": ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/142.0.0.0 Safari/537.36"),
    "timeout_s": 30, "max_html_mb": 60, "max_images": 3000, "max_image_mb": 40, "image_workers": 6,
    "browser_wait_ms": 15000,
}
MODES = ("auto", "static", "browser")
CONTENTS = ("main", "full")
BrowserRunner = Callable[..., str]


class ClipFailed(RuntimeError):
    pass


def _yaml(v) -> str:
    return json.dumps(v, ensure_ascii=False)  # a JSON string is a valid YAML double-quoted scalar


def front_matter(fields: dict) -> str:
    lines = ["---"]
    for k, v in fields.items():
        if v not in (None, ""):
            lines.append(f"{k}: {_yaml(v)}")
    lines.append("---")
    return "\n".join(lines) + "\n"


def _analyse(html: str, url: str, content: str) -> dict:
    raw = parse(html)
    meta = extract.page_meta(raw, url)
    shell = extract.looks_js_rendered  # signals need the unpruned tree: compute them before pruning
    probe = _shell_probe(raw)
    extract.prune(raw, meta["base"], content)
    sel = extract.select_content(raw, content, meta["title"])
    main_len = sel.tl
    is_shell, why = shell(probe, main_len)
    return {"root": raw, "meta": meta, "content": sel, "text_len": main_len, "js_shell": is_shell, "js_reason": why}


def _shell_probe(raw):
    """A copy of just what looks_js_rendered needs (noscript texts, app-root divs, script count) — the real
    tree is pruned in place afterwards."""
    from .htmltree import Node
    probe = Node("#document")
    body = Node("body", parent=probe)
    probe.children.append(body)
    for n in raw.iter():
        if n.tag == "script":
            body.children.append(Node("script", parent=body))
        elif n.tag == "noscript":
            ns = Node("noscript", parent=body)
            ns.children.append(n.text(limit=2000))
            body.children.append(ns)
        elif n.tag == "div" and n.get("id").lower() in ("root", "app", "__next", "__nuxt", "svelte", "main-app",
                                                          "react-root"):
            d = Node("div", {"id": n.get("id")}, parent=body)
            d.children.append(n.text(limit=4000))
            body.children.append(d)
    return probe


def _words(node) -> int:
    count = 0
    stack = [node]
    while stack:
        n = stack.pop()
        if isinstance(n, str):
            count += len(n.split())
        elif n.tag not in ("script", "style", "template"):
            stack.extend(n.children)
    return count


def clip(url: str, clips_dir: Path, *, mode: str = "auto", content: str = "main", download_images: bool = True,
         save_html: bool = False, settings: dict | None = None, policy: Policy = public_only,
         chrome: str | None | bool = True, browser_runner: BrowserRunner | None = None,
         log: Callable[[str], None] = print) -> dict:
    """Clip `url` into a new folder under `clips_dir`; returns the summary dict (also the CLIP_DONE payload).

    chrome: True = detect, None/False = no browser, str = that binary. browser_runner(url, ...) -> html
    replaces the real Chrome run (tests)."""
    t0 = time.monotonic()
    s = {**DEFAULTS, **{k: v for k, v in (settings or {}).items() if v not in (None, "")}}
    if mode not in MODES:
        raise ClipFailed(f"unknown mode {mode!r}")
    if content not in CONTENTS:
        raise ClipFailed(f"unknown content mode {content!r}")
    url = url.strip()
    log(f"fetching… {strip_query(url)}")
    check_url(url, policy)
    chrome_path = fetcher.find_chrome() if chrome is True else (chrome or None)
    runner = browser_runner or fetcher.run_chrome
    max_html = int(float(s["max_html_mb"]) * 1048576)
    wait_ms = int(s["browser_wait_ms"])

    def browser(target: str) -> str:
        if not chrome_path and browser_runner is None:
            raise ClipFailed("browser mode needs Google Chrome or Chromium, and none was found")
        log(f"mode: browser (rendering with headless Chrome, up to {wait_ms / 1000:.0f} s)…")
        return runner(chrome_path, target, user_agent=s["user_agent"], wait_ms=wait_ms, max_bytes=max_html,
                      policy=policy)

    client = make_client(policy, user_agent=s["user_agent"], timeout=float(s["timeout_s"]))
    try:
        used = "static"
        final_url = url
        redirects: list[str] = []
        html = None
        info = None
        js_reason = ""
        if mode in ("auto", "static"):
            try:
                html, resp = fetcher.fetch_static(client, url, policy, max_bytes=max_html)
                final_url, redirects = resp.url, resp.redirects
                if redirects:
                    log(f"redirected to {strip_query(final_url)}")
                log(f"mode: static ({len(resp.body):,} bytes)")
            except fetcher.HTTPStatusError as e:
                if mode == "auto" and (chrome_path or browser_runner) and e.status in (401, 403, 406, 429, 503):
                    log(f"static fetch refused ({e}); trying the browser")
                else:
                    raise
            except (httpx.TimeoutException, httpx.TransportError) as e:
                if mode == "auto" and (chrome_path or browser_runner):
                    log(f"static fetch failed ({type(e).__name__}); trying the browser")
                else:
                    raise FetchError(f"{type(e).__name__}: {e}") from e
            if html is not None:
                info = _analyse(html, final_url, content)
                if mode == "auto" and info["js_shell"]:
                    js_reason = info["js_reason"]
                    if chrome_path or browser_runner:
                        log(f"looks rendered by JavaScript ({info['js_reason']}): switching to the browser")
                        html = None
                    else:
                        log(f"looks rendered by JavaScript ({info['js_reason']}) but no Chrome/Chromium was found; "
                            "keeping the static result")
        if html is None:
            static_meta = info["meta"] if info else None
            if mode == "browser":
                final_url = fetcher.resolve_redirects(client, url, policy)
            html = browser(final_url)
            used = "browser"
            info = _analyse(html, final_url, content)
            if static_meta:
                for k, v in static_meta.items():
                    if not info["meta"].get(k):
                        info["meta"][k] = v
        meta = info["meta"]
        sel = info["content"]
        words = _words(sel)
        log(f"content: {words:,} words ({content})")

        parts = urlsplit(final_url)
        title = meta["title"] or f"{parts.hostname}{parts.path}".rstrip("/")
        clipped = datetime.now(timezone.utc).astimezone()
        make_dir(clips_dir)
        tmp_dir = Path(tempfile.mkdtemp(prefix=".tmp-clip-", dir=str(clips_dir)))
        chmod_private(tmp_dir, 0o700)
        try:
            refs = collect_images(sel, meta["base"])
            items = [Item(i + 1, key, payload) for i, (key, payload) in enumerate(refs)]
            log(f"images: {len(items):,} found" + ("" if download_images else " (downloads off: keeping remote links)"))
            dl = Downloader(client, policy, referer=final_url, max_bytes=int(float(s["max_image_mb"]) * 1048576),
                            workers=int(s["image_workers"]), out_dir=tmp_dir / "images", log=log)
            res = dl.run(items, meta["covers"] if download_images else [], max_images=int(s["max_images"]),
                         network=download_images)
            failed = len([f for f in res.failures if not f["reason"].startswith("skipped: over")])
            log(f"images: {res.saved + res.deduped}/{len(items)} saved ({failed} failed, {res.deduped} duplicates)")

            body = to_markdown(sel, meta["base"], {**{k: "" for k in res.dropped}, **res.mapping})
            fm = front_matter({
                "title": title, "source": url, "final_url": final_url,
                "author": meta["author"], "published": meta["published"], "site": meta["site"],
                "cover": res.cover or "", "clipped_at": clipped.isoformat(timespec="seconds"),
            })
            md = f"{fm}\n# {title}\n\n{body}"
            write_text(tmp_dir / "index.md", md)
            if save_html:
                write_text(tmp_dir / "page.html", html)
            if not any((tmp_dir / "images").iterdir()):
                (tmp_dir / "images").rmdir()
            elapsed = round(time.monotonic() - t0, 2)
            summary = {
                "url": url, "final_url": final_url, "redirects": redirects, "title": title,
                "author": meta["author"], "published": meta["published"], "cover": res.cover,
                "mode": used, "content": content, "words": words, "js_reason": js_reason,
                "download_images": download_images, "saved_html": save_html,
                "counts": {"found": res.found, "saved": res.saved, "failed": failed, "deduped": res.deduped,
                           "skipped": res.skipped, "cover": bool(res.cover)},
                "failures": res.failures, "elapsed": elapsed,
                "clipped_at": clipped.isoformat(timespec="seconds"), "clipped_ts": time.time(),
            }
            size = sum(f.stat().st_size for f in tmp_dir.rglob("*") if f.is_file()) + 2048
            summary["bytes"] = size
            write_text(tmp_dir / "meta.json", json.dumps(summary, indent=2, ensure_ascii=False))
            date = clipped.strftime("%Y-%m-%d")
            slug = slugify(meta["title"] or f"{parts.hostname} {parts.path}")
            final_dir = publish(tmp_dir, clips_dir, f"{date}-{slug}")
        except BaseException:
            shutil.rmtree(tmp_dir, ignore_errors=True)  # only our own unfinished temp folder
            raise
        return {"out_dir": str(final_dir), "name": final_dir.name, "title": title, "mode": used,
                "words": words, "counts": summary["counts"], "elapsed": elapsed}
    finally:
        client.close()


__all__ = ["clip", "ClipFailed", "BlockedURL", "FetchError", "DEFAULTS"]
