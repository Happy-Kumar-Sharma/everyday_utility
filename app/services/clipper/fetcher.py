"""Getting the page: static (httpx, guarded) or rendered by headless Chrome."""

from __future__ import annotations

import codecs
import os
import re
import shutil
import signal
import subprocess
import tempfile
import threading

import httpx

from .netguard import FetchError, Policy, Response, TooLarge, check_url, fetch, open_stream

CHROME_NAMES = ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome")
_META_CHARSET = re.compile(rb"""<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_.:-]+)""", re.I)
_ACTIVE: set[subprocess.Popen] = set()
_ACTIVE_LOCK = threading.Lock()


class HTTPStatusError(FetchError):
    def __init__(self, status: int, url: str):
        super().__init__(f"HTTP {status} for the page")
        self.status = status


class NotHTML(FetchError):
    pass


def find_chrome() -> str | None:
    for name in CHROME_NAMES:
        path = shutil.which(name)
        if path:
            return path
    for path in ("/usr/bin/google-chrome", "/usr/bin/chromium", "/snap/bin/chromium"):
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return None


def _codec(name: str | None) -> str | None:
    if not name:
        return None
    try:
        return codecs.lookup(name.strip().strip("\"'")).name
    except LookupError:
        return None


def decode_html(body: bytes, content_type: str = "") -> str:
    """HTTP charset, then a BOM, then <meta charset>, then UTF-8 with replacement."""
    m = re.search(r"charset\s*=\s*\"?([^\s;\"]+)", content_type or "", re.I)
    enc = _codec(m.group(1)) if m else None
    if enc is None:
        for bom, name in ((codecs.BOM_UTF8, "utf-8-sig"), (codecs.BOM_UTF16_LE, "utf-16"), (codecs.BOM_UTF16_BE, "utf-16")):
            if body.startswith(bom):
                enc = name
                break
    if enc is None:
        mm = _META_CHARSET.search(body[:16384])
        enc = _codec(mm.group(1).decode("ascii", "replace")) if mm else None
    if enc in ("ascii", "iso8859-1", "latin-1"):  # browsers treat these labels as windows-1252
        enc = "cp1252"
    return body.decode(enc or "utf-8", errors="replace")


def fetch_static(client: httpx.Client, url: str, policy: Policy, *, max_bytes: int) -> tuple[str, Response]:
    resp = fetch(client, url, policy, limit=max_bytes,
                 headers={"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"})
    if resp.status >= 400:
        raise HTTPStatusError(resp.status, resp.url)
    ctype = resp.headers.get("content-type", "").lower()
    kind = ctype.split(";", 1)[0].strip()
    if kind and not (kind in ("text/html", "application/xhtml+xml", "application/xml", "text/xml")
                     or kind.startswith("text/")):
        raise NotHTML(f"not a web page (content-type {kind})")
    text = decode_html(resp.body, ctype)
    if kind.startswith("text/") and kind not in ("text/html", "text/xml"):
        # plain text documents: wrap so the converter keeps them verbatim
        from html import escape
        text = f"<html><body><pre>{escape(text)}</pre></body></html>"
    return text, resp


def resolve_redirects(client: httpx.Client, url: str, policy: Policy) -> str:
    """Follow (and SSRF-check) the redirect chain without downloading the body; the final URL."""
    try:
        with open_stream(client, url, policy) as (resp, _hops):
            return str(resp.url)
    except (httpx.HTTPError, FetchError):
        return url


def chrome_command(chrome: str, url: str, *, user_agent: str, wait_ms: int, profile: str) -> list[str]:
    return [chrome, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
            "--mute-audio", "--hide-scrollbars", "--disable-extensions", "--disable-sync",
            f"--user-data-dir={profile}", "--window-size=1366,30000", f"--virtual-time-budget={int(wait_ms)}",
            "--run-all-compositor-stages-before-draw", f"--user-agent={user_agent}", "--dump-dom", url]


def kill_active() -> None:
    """Kill every running Chrome process group (cancel / SIGTERM of the clipper process)."""
    with _ACTIVE_LOCK:
        procs = list(_ACTIVE)
    for p in procs:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass


def run_chrome(chrome: str, url: str, *, user_agent: str, wait_ms: int, max_bytes: int, policy: Policy) -> str:
    """The rendered DOM of `url` (after JavaScript and lazy loading) via `chrome --dump-dom`."""
    check_url(url, policy)  # Chrome itself fetches the page and its subresources
    profile = tempfile.mkdtemp(prefix="eu-clipper-chrome-")
    proc = None
    try:
        proc = subprocess.Popen(chrome_command(chrome, url, user_agent=user_agent, wait_ms=wait_ms, profile=profile),
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                start_new_session=True)
        with _ACTIVE_LOCK:
            _ACTIVE.add(proc)
        try:
            out, err = proc.communicate(timeout=wait_ms / 1000 + 60)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.communicate()
            raise FetchError(f"Chrome did not finish within {wait_ms / 1000 + 60:.0f} s") from None
        if len(out) > max_bytes:
            raise TooLarge(f"rendered page larger than the {max_bytes / 1048576:.0f} MB limit")
        if proc.returncode != 0 or not out.strip():
            tail = err.decode("utf-8", "replace").strip().splitlines()[-1:] if err else []
            raise FetchError(f"Chrome failed (exit {proc.returncode}){': ' + tail[0][:300] if tail else ''}")
        return out.decode("utf-8", errors="replace")
    finally:
        if proc is not None:
            with _ACTIVE_LOCK:
                _ACTIVE.discard(proc)
            try:
                os.killpg(proc.pid, signal.SIGKILL)  # leftover renderer / zygote processes
            except (ProcessLookupError, PermissionError):
                pass
        shutil.rmtree(profile, ignore_errors=True)
