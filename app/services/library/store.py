"""Snippet library stored as plain files: collections are folders, items are files.

    <root>/
      Prod queries/daily_assessments.sql
      Mongo queries/find_by_uuid.js
      Commands/run_predictions.sh
      Favourite apps/grafana.url
      .library.json      metadata per item: description, tags, env, favorite, uses, last_used
      .trash/            deleted items (restorable)

Files created by hand (VS Code, cp, git pull of another repo …) show up automatically; metadata is optional.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import tempfile
import threading
import time
import uuid
from pathlib import Path

META_FILE = ".library.json"
TRASH = ".trash"
MAX_CONTENT = 512 * 1024  # bigger files are listed but not loaded into the browser
ENVS = ("", "local", "staging", "prod")

# extension -> type shown in the UI (and used for highlighting / actions)
TYPES = {
    "sql": "sql", "psql": "sql",
    "js": "mongo", "mongo": "mongo",
    "sh": "shell", "bash": "shell", "zsh": "shell",
    "py": "python",
    "json": "json", "yaml": "yaml", "yml": "yaml",
    "url": "link", "link": "link",
    "md": "note", "txt": "note",
}
DEFAULT_EXT = {"sql": "sql", "mongo": "js", "shell": "sh", "python": "py", "json": "json", "yaml": "yaml",
               "link": "url", "note": "md"}
_NAME_OK = re.compile(r"^[^/\\\x00]+$")

STARTER_COLLECTIONS = ["Prod queries", "Staging queries", "Local queries", "Mongo queries", "Commands", "Favourite apps"]


class LibraryError(ValueError):
    pass


def type_of(path: Path) -> str:
    return TYPES.get(path.suffix.lower().lstrip("."), "note")


def _check_name(name: str, what: str) -> str:
    name = name.strip()
    if not name or name in (".", "..") or name.startswith(".") or not _NAME_OK.match(name):
        raise LibraryError(f"invalid {what} name '{name}' (no slashes, may not start with '.')")
    return name


_locks: dict[str, threading.RLock] = {}
_locks_guard = threading.Lock()


def _lock_for(root: Path) -> threading.RLock:
    # one lock per library folder, shared by every Library() instance (the API builds one per request)
    with _locks_guard:
        return _locks.setdefault(str(root.expanduser().resolve()), threading.RLock())


class Library:
    def __init__(self, root: Path):
        self.root = root
        self._lock = _lock_for(root)

    # ---- paths ----------------------------------------------------------------------------------
    def _resolve(self, rel: str) -> Path:
        """Path inside root; anything escaping it (.., symlinks out) is refused."""
        p = (self.root / rel).resolve()
        root = self.root.resolve()
        if p != root and root not in p.parents:
            raise LibraryError(f"path outside the library: {rel}")
        if any(part.startswith(".") for part in p.relative_to(root).parts):
            raise LibraryError("hidden paths are not library items")
        return p

    def _rel(self, p: Path) -> str:
        return p.resolve().relative_to(self.root.resolve()).as_posix()

    # ---- metadata -------------------------------------------------------------------------------
    def _meta(self) -> dict:
        f = self.root / META_FILE
        if f.is_file():
            try:
                return json.loads(f.read_text())
            except ValueError:
                return {}
        return {}

    def _save_meta(self, meta: dict) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        _atomic(self.root / META_FILE, json.dumps(meta, indent=1, sort_keys=True).encode())

    @staticmethod
    def _clean_meta(m: dict, base: dict | None = None) -> dict:
        out = _full(base)
        if "description" in m:
            out["description"] = str(m["description"] or "").strip()
        if "tags" in m:
            tags = m["tags"].split(",") if isinstance(m["tags"], str) else m["tags"]
            out["tags"] = list(dict.fromkeys(str(t).strip().lstrip("#").lower() for t in tags if str(t).strip()))
        if "env" in m:
            if m["env"] not in ENVS:
                raise LibraryError(f"env must be one of {', '.join(e or '(none)' for e in ENVS)}")
            out["env"] = m["env"]
        if "favorite" in m:
            out["favorite"] = bool(m["favorite"])
        return out

    # ---- listing --------------------------------------------------------------------------------
    def _inside(self, p: Path) -> bool:
        """True if p (following symlinks) stays inside the library; links pointing elsewhere are ignored."""
        try:
            p.resolve().relative_to(self.root.resolve())
            return True
        except (ValueError, OSError):
            return False

    def collections(self) -> list[str]:
        if not self.root.is_dir():
            return []
        out = []
        for dirpath, dirnames, _ in os.walk(self.root):
            dirnames[:] = sorted(d for d in dirnames if not d.startswith(".") and self._inside(Path(dirpath) / d))
            for d in dirnames:
                out.append(self._rel(Path(dirpath) / d))
        return out

    def items(self) -> list[dict]:
        meta = self._meta()
        out = []
        if not self.root.is_dir():
            return out
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = [d for d in dirnames if not d.startswith(".") and self._inside(Path(dirpath) / d)]
            for name in filenames:
                if name.startswith(".") or name.endswith((".tmp", "~", ".swp")):
                    continue
                p = Path(dirpath) / name
                if not self._inside(p) or not p.is_file():  # symlink out of the library, dangling link, FIFO …
                    continue
                try:
                    out.append(self._item(p, meta.get(self._rel(p))))
                except OSError:
                    continue
        return sorted(out, key=lambda i: i["path"].lower())

    def _item(self, p: Path, m: dict | None) -> dict:
        st = p.stat()
        rel = self._rel(p)
        content, truncated, binary = "", False, False
        if st.st_size <= MAX_CONTENT:
            try:
                content = p.read_bytes().decode("utf-8")  # bytes -> str keeps CRLF exactly
            except UnicodeDecodeError:
                binary = True  # not UTF-8: shown read-only, never rewritten from the browser
        else:
            truncated = True
        coll = str(Path(rel).parent) if "/" in rel else ""
        return {
            "path": rel,
            "collection": "" if coll == "." else coll,
            "name": p.stem,
            "ext": p.suffix.lstrip("."),
            "type": type_of(p),
            "content": content,
            "truncated": truncated,
            "binary": binary,
            "size": st.st_size,
            "mtime": st.st_mtime,
            **_full(m),
        }

    def get(self, rel: str) -> dict:
        p = self._resolve(rel)
        if not p.is_file():
            raise LibraryError(f"not found: {rel}")
        return self._item(p, self._meta().get(rel))

    # ---- items ----------------------------------------------------------------------------------
    def _target(self, collection: str, name: str, ext: str) -> Path:
        name = _check_name(name, "item")
        ext = re.sub(r"[^A-Za-z0-9+_-]", "", ext or "")  # empty = no extension (Makefile, README …)
        coll = "/".join(_check_name(c, "collection") for c in collection.split("/") if c.strip()) if collection.strip() else ""
        if ext and name.lower().endswith(f".{ext.lower()}"):
            name = name[: -(len(ext) + 1)]
        filename = f"{name}.{ext}" if ext else name
        return self._resolve(f"{coll}/{filename}" if coll else filename)

    def create(self, collection: str, name: str, ext: str, content: str, meta: dict) -> dict:
        with self._lock:
            p = self._target(collection, name, ext)
            if p.exists():
                raise LibraryError(f"'{self._rel(p)}' already exists")
            p.parent.mkdir(parents=True, exist_ok=True)
            _atomic(p, content.encode("utf-8"))
            all_meta = self._meta()
            all_meta[self._rel(p)] = self._clean_meta(meta)
            self._save_meta(all_meta)
            return self.get(self._rel(p))

    def update(self, rel: str, *, content: str | None, meta: dict, expected_mtime: float | None,
               collection: str | None = None, name: str | None = None, ext: str | None = None) -> dict:
        with self._lock:
            p = self._resolve(rel)
            if not p.is_file():
                raise LibraryError(f"not found: {rel}")
            if expected_mtime is not None and abs(p.stat().st_mtime - expected_mtime) > 1e-3:
                raise LibraryError("the file changed on disk since it was opened — reload and try again")
            all_meta = self._meta()
            m = self._clean_meta(meta, all_meta.get(rel))
            target = p
            if collection is not None or name is not None or ext is not None:
                target = self._target(collection if collection is not None else (str(Path(rel).parent) if "/" in rel else ""),
                                      name if name is not None else p.stem, ext if ext is not None else p.suffix.lstrip("."))
                if target != p and target.exists():
                    raise LibraryError(f"'{self._rel(target)}' already exists")
            if content is not None:
                if p.stat().st_size > MAX_CONTENT or not _is_utf8(p):
                    # the browser never received this file's real content, so whatever it sent is not an edit of it
                    raise LibraryError("this file is too large or not UTF-8 text — edit it in your editor")
                _atomic(p, content.encode("utf-8"))
            if target != p:
                target.parent.mkdir(parents=True, exist_ok=True)
                os.replace(p, target)
                all_meta.pop(rel, None)
            all_meta[self._rel(target)] = m
            self._save_meta(all_meta)
            return self.get(self._rel(target))

    def touch_use(self, rel: str) -> dict:
        with self._lock:
            self._resolve(rel)
            all_meta = self._meta()
            m = _full(all_meta.get(rel))
            m["uses"] = int(m.get("uses") or 0) + 1
            m["last_used"] = time.time()
            all_meta[rel] = m
            self._save_meta(all_meta)
            return m

    def delete(self, rel: str) -> str:
        """Moves the item into .trash/ (restorable); returns its trash path."""
        with self._lock:
            p = self._resolve(rel)
            if not p.is_file():
                raise LibraryError(f"not found: {rel}")
            # unique even for two deletes in the same second or paths that flatten to the same name
            dest = self.root / TRASH / f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}__{rel.replace('/', '__')}"
            dest.parent.mkdir(parents=True, exist_ok=True)
            os.replace(p, dest)
            all_meta = self._meta()
            m = all_meta.pop(rel, None)
            trash_meta = all_meta.setdefault("__trash__", {})
            trash_meta[dest.name] = {"path": rel, "meta": m, "deleted_at": time.time()}
            self._save_meta(all_meta)
            return dest.name

    def trash(self) -> list[dict]:
        info = self._meta().get("__trash__", {})
        d = self.root / TRASH
        out = []
        for f in sorted(d.iterdir(), reverse=True) if d.is_dir() else []:
            i = info.get(f.name, {})
            out.append({"id": f.name, "path": i.get("path", f.name), "deleted_at": i.get("deleted_at", f.stat().st_mtime)})
        return out

    def restore(self, trash_id: str) -> dict:
        with self._lock:
            src = self.root / TRASH / _check_name(trash_id, "trash item")
            if not src.is_file():
                raise LibraryError("not in trash")
            all_meta = self._meta()
            info = all_meta.get("__trash__", {}).pop(trash_id, {})
            rel = info.get("path") or trash_id
            target = self._resolve(rel)
            base, n = target, 1
            while target.exists():  # never overwrite: q (restored).sql, q (restored 2).sql, …
                target = base.with_name(f"{base.stem} (restored{'' if n == 1 else f' {n}'}){base.suffix}")
                n += 1
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(src, target)
            if info.get("meta"):
                all_meta[self._rel(target)] = info["meta"]
            self._save_meta(all_meta)
            return self.get(self._rel(target))

    def duplicate(self, rel: str) -> dict:
        with self._lock:
            src = self._resolve(rel)
            if not src.is_file():
                raise LibraryError(f"not found: {rel}")
            n = 1
            while True:
                target = src.with_name(f"{src.stem} copy{'' if n == 1 else f' {n}'}{src.suffix}")
                if not target.exists():
                    break
                n += 1
            shutil.copy2(src, target)  # bytes + mode, also for files too large to load in the browser
            all_meta = self._meta()
            m = _full(all_meta.get(rel))
            m.update(favorite=False, uses=0, last_used=None)
            all_meta[self._rel(target)] = m
            self._save_meta(all_meta)
            return self.get(self._rel(target))

    # ---- collections ----------------------------------------------------------------------------
    def create_collection(self, name: str) -> str:
        parts = [_check_name(c, "collection") for c in name.split("/") if c.strip()]
        if not parts:
            raise LibraryError("collection name is empty")
        p = self._resolve("/".join(parts))
        p.mkdir(parents=True, exist_ok=True)
        return self._rel(p)

    def rename_collection(self, old: str, new: str) -> str:
        with self._lock:
            src = self._resolve(old)
            if not src.is_dir() or src == self.root.resolve():
                raise LibraryError(f"no collection '{old}'")
            old_rel = self._rel(src)
            parts = [_check_name(c, "collection") for c in new.split("/") if c.strip()]
            dst = self._resolve("/".join(parts))
            if dst == src or src in dst.parents:
                raise LibraryError("cannot move a collection into itself")
            if dst.exists():
                raise LibraryError(f"'{new}' already exists")
            dst.parent.mkdir(parents=True, exist_ok=True)
            os.replace(src, dst)
            new_rel = self._rel(dst)
            all_meta = self._meta()
            for key in [k for k in all_meta if k.startswith(old_rel + "/")]:
                all_meta[new_rel + key[len(old_rel):]] = all_meta.pop(key)
            self._save_meta(all_meta)
            return new_rel

    def delete_collection(self, name: str) -> None:
        with self._lock:
            p = self._resolve(name)
            if not p.is_dir() or p == self.root.resolve():
                raise LibraryError(f"no collection '{name}'")
            if any(not f.is_dir() for f in p.rglob("*")):  # hidden files count too: nothing is ever destroyed
                raise LibraryError("collection is not empty (it may contain hidden files) — move or delete them first")
            for d in sorted((x for x in p.rglob("*") if x.is_dir()), key=lambda x: len(x.parts), reverse=True):
                d.rmdir()
            p.rmdir()

    # ---- starter content ------------------------------------------------------------------------
    def seed(self, starters: list[dict]) -> int:
        made = 0
        for c in STARTER_COLLECTIONS:
            self.create_collection(c)
        for s in starters:
            try:
                self.create(s["collection"], s["name"], s["ext"], s["content"], s.get("meta", {}))
                made += 1
            except LibraryError:
                pass  # already there
        return made


_DEFAULT_META = {"description": "", "tags": [], "env": "", "favorite": False, "uses": 0, "last_used": None}


def _full(m: dict | None) -> dict:
    """Stored metadata with defaults for missing keys; unknown keys dropped."""
    return {k: (m or {}).get(k, v) if not isinstance(v, list) else list((m or {}).get(k, v)) for k, v in _DEFAULT_META.items()}


def _is_utf8(p: Path) -> bool:
    try:
        p.read_bytes().decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False


def _atomic(path: Path, data: bytes) -> None:
    # keep an existing file's permissions (e.g. the execute bit of a script); new files are owner-only
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    f = None
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(fd, mode)
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
        Path(tmp).unlink(missing_ok=True)
        raise
