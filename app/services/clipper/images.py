"""Downloading a page's images: concurrent, SSRF-guarded, size-capped, type-checked and de-duplicated."""

from __future__ import annotations

import hashlib
import io
import re
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import unquote, urlsplit

import httpx

from app.core.platform import chmod_private

from .markdown import decode_data_uri
from .netguard import BlockedURL, FetchError, Policy, open_stream, read_capped, strip_query
from .storage import write_bytes

EXT_BY_TYPE = {
    "image/jpeg": "jpg", "image/jpg": "jpg", "image/pjpeg": "jpg", "image/png": "png", "image/apng": "png",
    "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "image/bmp": "bmp", "image/x-ms-bmp": "bmp",
    "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico", "image/svg+xml": "svg", "image/tiff": "tif",
    "image/heic": "heic", "image/heif": "heif", "image/jxl": "jxl",
}


def sniff(data: bytes) -> str | None:
    """File extension from magic bytes, or None."""
    head = data[:64]
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if head.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand in (b"avif", b"avis"):
            return "avif"
        if brand in (b"heic", b"heix", b"mif1", b"msf1"):
            return "heic"
    if head.startswith(b"BM") and len(data) > 26:
        return "bmp"
    if head.startswith(b"\x00\x00\x01\x00"):
        return "ico"
    if head.startswith((b"II*\x00", b"MM\x00*")):
        return "tif"
    if head.startswith(b"\xff\x0a") or head.startswith(b"\x00\x00\x00\x0cJXL "):
        return "jxl"
    text = data[:4096].lstrip(b"\xef\xbb\xbf \t\r\n").lower()
    if text.startswith(b"<") and b"<svg" in text and b"<html" not in text[:512]:
        return "svg"
    return None


def tiny_dimensions(data: bytes) -> tuple[int, int] | None:
    """(w, h) when the image is a 1x1 / 2x2 tracking pixel or spacer, else None."""
    try:
        from PIL import Image
        with Image.open(io.BytesIO(data)) as im:
            w, h = im.size
    except Exception:  # noqa: BLE001 - not decodable by Pillow (svg, avif…): not a pixel we can judge
        return None
    return (w, h) if w <= 2 and h <= 2 else None


def _stem(key: str) -> str:
    if key.startswith("data:"):
        return "inline-" + hashlib.sha256(key.encode()).hexdigest()[:8]
    if key.startswith("svg:"):
        return "svg-" + key[4:12]
    name = unquote(urlsplit(key).path.rstrip("/").rsplit("/", 1)[-1])
    name = name.rsplit(".", 1)[0] if "." in name else name
    name = re.sub(r"[^A-Za-z0-9_-]+", "-", name).strip("-_")[:40]
    return name or hashlib.sha256(key.encode()).hexdigest()[:10]


@dataclass
class Item:
    index: int  # 1-based position (NNN) or 0 for the cover
    key: str
    payload: str | None = None  # SVG text for inline SVGs


@dataclass
class Result:
    mapping: dict[str, str] = field(default_factory=dict)  # key -> "images/NNN-name.ext"
    cover: str | None = None
    found: int = 0
    saved: int = 0
    deduped: int = 0
    failures: list[dict] = field(default_factory=list)
    skipped: int = 0
    dropped: set[str] = field(default_factory=set)  # tracking pixels: left out of the Markdown entirely


class Downloader:
    def __init__(self, client: httpx.Client | None, policy: Policy, *, referer: str, max_bytes: int,
                 workers: int, out_dir: Path, log: Callable[[str], None]):
        self.client = client
        self.policy = policy
        self.referer = referer
        self.max_bytes = max_bytes
        self.workers = max(1, min(int(workers or 1), 32))
        self.out_dir = out_dir
        self.log = log
        self.by_hash: dict[str, str] = {}
        self.lock = threading.Lock()

    # ---- getting bytes ----------------------------------------------------------------------------------------
    def _get(self, url: str) -> tuple[bytes, str]:
        if self.client is None:
            raise FetchError("downloads disabled")
        headers = {"Referer": self.referer,
                   "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"}
        last: Exception | None = None
        for attempt in range(2):  # one retry on 5xx / timeout / connection trouble
            try:
                with open_stream(self.client, url, self.policy, headers=headers) as (resp, _hops):
                    if resp.status_code >= 500:
                        last = FetchError(f"HTTP {resp.status_code}")
                    elif resp.status_code >= 400:
                        raise FetchError(f"HTTP {resp.status_code}")
                    else:
                        ctype = resp.headers.get("content-type", "").split(";", 1)[0].strip().lower()
                        return read_capped(resp, self.max_bytes), ctype
            except (BlockedURL, FetchError):
                raise
            except (httpx.TimeoutException, httpx.TransportError) as e:
                last = FetchError(f"{type(e).__name__}: {e}" if str(e) else type(e).__name__)
            if attempt == 0:
                time.sleep(0.5)
        raise last or FetchError("download failed")

    def _bytes(self, item: Item) -> tuple[bytes, str]:
        if item.payload is not None:  # inline SVG
            data = item.payload.encode("utf-8")
            if len(data) > self.max_bytes:
                raise FetchError("inline SVG larger than the size limit")
            return data, "image/svg+xml"
        if item.key.startswith("data:"):
            try:
                return decode_data_uri(item.key, self.max_bytes)
            except ValueError as e:
                raise FetchError(str(e)) from e
        return self._get(item.key)

    @staticmethod
    def _ext(data: bytes, ctype: str) -> str:
        magic = sniff(data)
        if magic:
            return magic
        if ctype.startswith("image/"):
            if ctype in EXT_BY_TYPE:
                return EXT_BY_TYPE[ctype] if ctype != "image/svg+xml" else "svg"
            raise FetchError(f"unrecognised image data ({ctype})")
        raise FetchError(f"not an image ({ctype or 'no content-type'})")

    # ---- one item ---------------------------------------------------------------------------------------------
    def process(self, item: Item, cover: bool = False) -> tuple[str, str]:
        """Downloads, checks and saves one image. Returns (relative path, "saved" | "deduped")."""
        data, ctype = self._bytes(item)
        if not data:
            raise FetchError("empty response")
        ext = self._ext(data, ctype)
        if ext == "svg" and sniff(data) != "svg":
            raise FetchError("declared SVG but the content is not SVG")
        tiny = tiny_dimensions(data) if ext in ("gif", "png", "webp", "bmp", "jpg") else None
        if tiny:
            raise FetchError(f"skipped: tracking pixel / spacer ({tiny[0]}x{tiny[1]})")
        digest = hashlib.sha256(data).hexdigest()
        with self.lock:
            if digest in self.by_hash:
                return self.by_hash[digest], "deduped"
            name = f"cover.{ext}" if cover else f"{item.index:03d}-{_stem(item.key)}.{ext}"
            rel = f"images/{name}"
            self.by_hash[digest] = rel
        write_bytes(self.out_dir / name, data)
        return rel, "saved"

    def run(self, items: list[Item], covers: list[str], *, max_images: int, network: bool = True) -> Result:
        res = Result()
        res.found = len(items)
        self.out_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        chmod_private(self.out_dir, 0o700)

        if network:
            for url in covers[:3]:
                try:
                    rel, _ = self.process(Item(0, url), cover=True)
                    res.cover = rel
                    break
                except (BlockedURL, FetchError, OSError) as e:
                    res.failures.append({"url": url, "reason": f"cover: {e}"})

        todo: list[Item] = []
        for it in items:
            remote = not it.key.startswith(("data:", "svg:"))
            if remote and not network:
                continue
            if len(todo) >= max_images:
                res.skipped += 1
                res.failures.append({"url": _short(it.key), "reason": f"skipped: over the max_images limit ({max_images})"})
                continue
            todo.append(it)
        if res.skipped:
            self.log(f"images: {res.skipped:,} more images skipped (max_images = {max_images:,})")

        total = len(todo)
        done = failed = 0
        last_log = 0.0
        pool = ThreadPoolExecutor(max_workers=self.workers, thread_name_prefix="img")
        ok = False
        try:
            futures = {pool.submit(self.process, it): it for it in todo}
            for fut in as_completed(futures):
                it = futures[fut]
                try:
                    rel, how = fut.result()
                    res.mapping[it.key] = rel
                    if how == "deduped":
                        res.deduped += 1
                    else:
                        res.saved += 1
                except (BlockedURL, FetchError, OSError, httpx.HTTPError, ValueError) as e:
                    failed += 1
                    if "tracking pixel" in str(e):
                        res.dropped.add(it.key)
                    res.failures.append({"url": _short(it.key), "reason": str(e)[:300] or type(e).__name__})
                done += 1
                now = time.monotonic()
                if now - last_log > 1.0 or done == total:
                    last_log = now
                    self.log(f"images: {res.saved + res.deduped}/{total} saved ({failed} failed)")
            ok = True
        finally:
            # on cancel / error: do not wait for downloads still in flight
            pool.shutdown(wait=ok, cancel_futures=not ok)
        return res


def _short(key: str) -> str:
    if key.startswith("data:"):
        return key[:80] + ("…" if len(key) > 80 else "")
    if key.startswith("svg:"):
        return "inline <svg>"
    return key


__all__ = ["Downloader", "Item", "Result", "sniff", "strip_query"]
