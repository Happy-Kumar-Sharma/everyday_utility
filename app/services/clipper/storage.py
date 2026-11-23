"""Owner-only, atomic file writes and the clips folder layout (history, safe file paths, trash)."""

from __future__ import annotations

import json
import os
import re
import tempfile
import time
import unicodedata
from pathlib import Path

from app.core.platform import chmod_private, fchmod_private

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$")


class ClipError(ValueError):
    pass


def write_bytes(path: Path, data: bytes) -> None:
    """Atomic (temp file + rename), mode 600."""
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=str(path.parent))
    f = None
    try:
        fchmod_private(fd, 0o600)
        f = os.fdopen(fd, "wb")
        f.write(data)
        f.close()
        os.replace(tmp, path)
    except BaseException:
        if f is not None and not f.closed:
            f.close()
        else:
            try:
                os.close(fd)
            except OSError:
                pass
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def write_text(path: Path, text: str) -> None:
    write_bytes(path, text.encode("utf-8"))


def make_dir(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    chmod_private(path, 0o700)


def slugify(text: str, limit: int = 60) -> str:
    s = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    s = re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-").lower()
    if len(s) > limit:
        cut = s[:limit]
        s = cut.rsplit("-", 1)[0] if "-" in cut[limit // 2:] else cut
    return s.strip("-") or "clip"


def publish(tmp_dir: Path, clips_dir: Path, base_name: str) -> Path:
    """Move the finished temp folder to a unique <clips_dir>/<base_name>[-2, -3…] (rename = atomic)."""
    for i in range(1, 10000):
        name = base_name if i == 1 else f"{base_name}-{i}"
        target = clips_dir / name
        if target.exists() or target.is_symlink():
            continue
        try:
            os.rename(tmp_dir, target)
            return target
        except OSError:
            if target.exists():
                continue
            raise
    raise ClipError("could not find a free folder name")


# ---- reading clips ---------------------------------------------------------------------------------------------


def clip_dir(clips_dir: Path, name: str) -> Path:
    """The folder of one clip; refuses odd names, dot folders and anything resolving outside clips_dir."""
    if not NAME_RE.match(name or "") or name.startswith("."):
        raise ClipError("invalid clip name")
    root = clips_dir.resolve()
    d = clips_dir / name
    if d.is_symlink():
        raise ClipError("clip folder is a symlink")
    real = d.resolve()
    if real.parent != root or not real.is_dir():
        raise ClipError("no such clip")
    return real


def clip_file(clips_dir: Path, name: str, rel: str) -> Path:
    """A regular file inside one clip; refuses ../, absolute paths and symlinks pointing anywhere outside."""
    base = clip_dir(clips_dir, name)
    rel = (rel or "").replace("\\", "/")
    parts = [p for p in rel.split("/") if p not in ("", ".")]
    if not parts or rel.startswith("/") or any(p == ".." for p in parts):
        raise ClipError("invalid file path")
    candidate = base.joinpath(*parts)
    try:
        real = candidate.resolve(strict=True)
    except (OSError, RuntimeError) as e:
        raise ClipError("no such file") from e
    if base not in real.parents or clips_dir.resolve() not in real.parents:
        raise ClipError("path escapes the clip folder")
    if not real.is_file():
        raise ClipError("not a file")
    return real


def _dir_size(d: Path) -> int:
    total = 0
    for root, _dirs, files in os.walk(d, followlinks=False):
        for f in files:
            try:
                total += os.lstat(os.path.join(root, f)).st_size
            except OSError:
                pass
    return total


def read_meta(d: Path) -> dict | None:
    try:
        meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return meta if isinstance(meta, dict) else None


def list_clips(clips_dir: Path) -> list[dict]:
    if not clips_dir.is_dir():
        return []
    out = []
    for d in clips_dir.iterdir():
        if d.name.startswith(".") or d.is_symlink() or not d.is_dir():
            continue
        meta = read_meta(d)
        if meta is None:
            continue
        counts = meta.get("counts") or {}
        out.append({
            "name": d.name,
            "title": meta.get("title") or d.name,
            "url": meta.get("url") or "",
            "final_url": meta.get("final_url") or "",
            "clipped_at": meta.get("clipped_at") or "",
            "clipped_ts": meta.get("clipped_ts") or d.stat().st_mtime,
            "words": meta.get("words") or 0,
            "images_saved": counts.get("saved", 0),
            "images_failed": counts.get("failed", 0),
            "images_deduped": counts.get("deduped", 0),
            "images_found": counts.get("found", 0),
            "bytes": meta.get("bytes") if isinstance(meta.get("bytes"), int) else _dir_size(d),
            "mode": meta.get("mode"),
        })
    out.sort(key=lambda c: c["clipped_ts"], reverse=True)
    return out


def trash(clips_dir: Path, name: str) -> str:
    """Move a clip to <clips_dir>/.trash/<timestamp>-<name> (never deleted outright)."""
    d = clip_dir(clips_dir, name)
    tdir = clips_dir / ".trash"
    make_dir(tdir)
    target = tdir / f"{time.strftime('%Y%m%d-%H%M%S')}-{name}"
    i = 2
    while target.exists():
        target = tdir / f"{time.strftime('%Y%m%d-%H%M%S')}-{name}-{i}"
        i += 1
    os.rename(d, target)
    return target.name
