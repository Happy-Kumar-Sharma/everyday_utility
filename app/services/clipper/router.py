from __future__ import annotations

import hashlib
import json
import os
import shlex
import sys
import tempfile
import zipfile
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
from starlette.background import BackgroundTask

from app.core import audit, config, context
from app.core.gitsafety import dir_safety
from app.core.jobs import JobConflict
from app.core.platform import bash_path

from . import fetcher, storage
from .netguard import BlockedURL, check_url, strip_query

SERVICE_ID = "clipper"
SETTING_KEYS = ("user_agent", "timeout_s", "max_html_mb", "max_images", "max_image_mb", "image_workers",
                "browser_wait_ms")
MAX_MD_RESPONSE = 4 * 1048576
IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
               ".avif": "image/avif", ".bmp": "image/bmp", ".ico": "image/x-icon", ".svg": "image/svg+xml",
               ".tif": "image/tiff", ".heic": "image/heic", ".heif": "image/heif", ".jxl": "image/jxl"}
TEXT_TYPES = {".md": "text/markdown; charset=utf-8", ".json": "application/json; charset=utf-8",
              ".html": "text/plain; charset=utf-8"}  # raw page HTML is never rendered in the app's origin
SAFE_HEADERS = {"Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
                "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600"}

router = APIRouter()


def _python_cmd() -> list[str]:
    """How the worker process is started (tests replace this with a wrapper that injects a test policy)."""
    return [bash_path(sys.executable), "-m", "app.services.clipper.cli"]  # this interpreter, not "python3"


def _root() -> Path:
    value = str(context.service_settings(SERVICE_ID)["clips_dir"] or "").strip()
    return Path(value).expanduser()


def _status() -> dict:
    root = _root()
    problem = None
    if not root.is_absolute():
        problem = "clips folder must be an absolute path (⚙ Settings)"
    else:
        app_root = config.ROOT_DIR.resolve()
        r = root.resolve()
        if (r == app_root or app_root in r.parents) and (app_root / "private") not in [r, *r.parents]:
            problem = f"inside the app folder only {app_root / 'private'}/ may hold clips"
    git = {"in_repo": False, "safe": False}
    if not problem:
        git = dir_safety(root, config.ROOT_DIR)
    return {"clips_dir": str(root), "exists": root.is_dir(), "problem": problem, "git": git,
            "writable": not problem and bool(git.get("safe"))}


def _writable_root() -> Path:
    st = _status()
    if st["problem"]:
        raise HTTPException(409, st["problem"])
    if not st["git"]["safe"]:
        raise HTTPException(409, f"{st['clips_dir']} is inside git repo {st['git'].get('repo')} and not ignored — "
                                 "clipped pages would be committed; add it to .gitignore or pick another folder "
                                 "in ⚙ Settings")
    return _root()


def _readable_root() -> Path:
    st = _status()
    if st["problem"]:
        raise HTTPException(409, st["problem"])
    return _root()


def _call(fn, *args):
    try:
        return fn(*args)
    except storage.ClipError as e:
        raise HTTPException(404 if "no such" in str(e) else 400, str(e)) from e


@router.get("/status")
def status():
    return {**_status(), "chrome": fetcher.find_chrome()}


class ClipReq(BaseModel):
    url: str
    mode: str = "auto"
    content: str = "main"
    download_images: bool = True
    save_html: bool = False


def _normalize(url: str) -> str:
    url = url.strip()
    if url and "://" not in url.split("?", 1)[0]:
        url = "https://" + url
    return url


def _syntax_check(url: str) -> None:
    """Scheme / host-name checks without DNS (the worker checks every resolved address)."""
    def no_dns(host: str, port: int) -> list[str]:
        from .netguard import _hostname_reason, ip_blocked_reason
        reason = _hostname_reason(host)
        if reason:
            raise BlockedURL(f"refused: {reason}")
        h = host.strip("[]")
        try:
            import ipaddress
            ipaddress.ip_address(h)
        except ValueError:
            return []
        why = ip_blocked_reason(h)
        if why:
            raise BlockedURL(f"refused: {h} is a {why} address")
        return [h]
    check_url(url, no_dns)


def _lock_key(url: str) -> str:
    # the query may hold tokens: lock keys show up in the jobs list and the audit log, so it is hashed
    short = strip_query(url)
    rest = url[len(short):] if url.startswith(short) else url
    return f"{SERVICE_ID}:{short}" + (f"#{hashlib.sha256(rest.encode()).hexdigest()[:10]}" if rest else "")


@router.post("/clip")
def start_clip(req: ClipReq):
    url = _normalize(req.url)
    if req.mode not in ("auto", "static", "browser") or req.content not in ("main", "full"):
        raise HTTPException(400, "mode must be auto|static|browser and content main|full")
    try:
        _syntax_check(url)
    except BlockedURL as e:
        raise HTTPException(400, str(e)) from e
    if req.mode == "browser" and not fetcher.find_chrome():
        raise HTTPException(400, "browser mode needs Google Chrome or Chromium, and none was found")
    root = _writable_root()
    settings = context.service_settings(SERVICE_ID)
    worker = {k: settings[k] for k in SETTING_KEYS}
    argv = [*_python_cmd(), "--url", url, "--out", bash_path(root), "--mode", req.mode, "--content", req.content,
            "--settings-json", json.dumps(worker)]
    if not req.download_images:
        argv.append("--no-images")
    if req.save_html:
        argv.append("--save-html")
    script = " ".join(shlex.quote(a) for a in argv)
    short = strip_query(url)
    display_argv = [a if a != url else short + (" (query hidden)" if short != url else "") for a in argv]
    try:
        job = context.jobs.start(f"Clip: {short}", script, display=" ".join(shlex.quote(a) for a in display_argv),
                                 cwd=str(config.ROOT_DIR), lock_key=_lock_key(url),
                                 meta={"step": "clipper", "url": short, "out_dir": str(root)})
    except JobConflict as e:
        raise HTTPException(409, str(e)) from e
    return job.to_dict()


@router.get("/clips")
def clips():
    st = _status()
    if st["problem"]:
        return {**st, "clips": []}
    return {**st, "clips": storage.list_clips(_root())}


@router.get("/clips/{name}")
def clip_detail(name: str):
    root = _readable_root()
    d = _call(storage.clip_dir, root, name)
    meta = storage.read_meta(d) or {}
    md_path = d / "index.md"
    text, truncated, size = "", False, 0
    try:
        size = md_path.stat().st_size
        with md_path.open("rb") as f:
            raw = f.read(MAX_MD_RESPONSE + 1)
        truncated = len(raw) > MAX_MD_RESPONSE
        text = raw[:MAX_MD_RESPONSE].decode("utf-8", errors="ignore")
    except OSError:
        pass
    images = []
    img_dir = d / "images"
    if img_dir.is_dir() and not img_dir.is_symlink():
        images = sorted(f"images/{p.name}" for p in img_dir.iterdir()
                        if p.is_file() and not p.is_symlink() and not p.name.startswith("."))
    return {"name": d.name, "path": str(d), "meta": meta, "markdown": text, "truncated": truncated,
            "markdown_bytes": size, "images": images}


@router.get("/clips/{name}/file")
def clip_file(name: str, path: str, download: bool = False):
    root = _readable_root()
    f = _call(storage.clip_file, root, name, path)
    ext = f.suffix.lower()
    media = IMAGE_TYPES.get(ext) or TEXT_TYPES.get(ext) or "application/octet-stream"
    attach = download or media == "application/octet-stream"
    return FileResponse(f, media_type=media, headers=dict(SAFE_HEADERS), filename=f.name if attach else None,
                        content_disposition_type="attachment")


@router.get("/clips/{name}/zip")
def clip_zip(name: str):
    root = _readable_root()
    d = _call(storage.clip_dir, root, name)
    fd, tmp = tempfile.mkstemp(prefix="eu-clip-", suffix=".zip")
    os.close(fd)
    try:
        with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as z:
            for dirpath, dirs, files in os.walk(d, followlinks=False):
                dirs[:] = sorted(x for x in dirs if not os.path.islink(os.path.join(dirpath, x)))
                for fname in sorted(files):
                    full = Path(dirpath) / fname
                    if full.is_symlink() or fname.startswith(".tmp-"):
                        continue
                    arc = f"{d.name}/{full.relative_to(d).as_posix()}"
                    ctype = zipfile.ZIP_STORED if full.suffix.lower() in (".jpg", ".png", ".gif", ".webp", ".avif") \
                        else zipfile.ZIP_DEFLATED
                    z.write(full, arc, compress_type=ctype)
    except BaseException:
        os.unlink(tmp)
        raise
    return FileResponse(tmp, media_type="application/zip", filename=f"{d.name}.zip",
                        background=BackgroundTask(os.unlink, tmp))


@router.post("/clips/{name}/delete")
def delete_clip(name: str):
    root = _writable_root()
    d = _call(storage.clip_dir, root, name)
    meta = storage.read_meta(d) or {}
    trashed = _call(storage.trash, root, name)
    counts = meta.get("counts") or {}
    audit.record("clip", "delete", strip_query(meta.get("url") or "") or name, status="ok",
                 detail={"name": name, "trash": trashed, "images_saved": counts.get("saved", 0)})
    return {"trash": trashed}


__all__ = ["router", "SERVICE_ID"]
