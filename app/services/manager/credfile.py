"""Credentials kept in a plain-text file at a location the user picks (never inside git's reach).

File format (readable and hand-editable; this module reads it back):

    # Everyday Utility credentials — PLAIN TEXT, local only, do not commit
    === GitHub (personal) ===
    URL      : https://github.com/login
    Username : me@example.com
    Password : hunter2
    Tags     : personal, git
    Notes    :
      anything, one or more lines,
      indented by two spaces

Blocks start with ``=== title ===``. Values are trimmed; a password with leading/trailing spaces (or one
starting with a double quote) is written as a JSON string, e.g. ``Password : "  x "``. Unknown
``Key : value`` lines are kept by folding them into the notes, so hand-written extras are never lost.

Safety rules enforced here (see validate_location / git_safety):
* the file must be UTF-8 and either new, empty, created by this app, or already in this exact format;
* inside this app's folder only ``private/`` is allowed;
* git must ignore the file and its .bak / temp siblings — asked of git itself, never guessed.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
import time
from pathlib import Path

from app.core.gitsafety import all_safe, git_tracked

FIELDS = ("url", "username", "password", "tags")
LABELS = {"url": "URL", "username": "Username", "password": "Password", "tags": "Tags"}
ALIASES = {"url": "url", "link": "url", "website": "url", "site": "url", "login": "url",
           "username": "username", "user": "username", "email": "username", "login id": "username",
           "password": "password", "pass": "password", "pwd": "password", "tags": "tags", "tag": "tags"}
HEADER = "# Everyday Utility credentials — PLAIN TEXT, local only, do not commit\n"
_TITLE = re.compile(r"^\s*===\s*(.*?)\s*===\s*$")
_KV = re.compile(r"^([A-Za-z][A-Za-z ]{0,20}?)\s*:\s?(.*)$")


class CredError(ValueError):
    pass


def _lines(text: str) -> list[str]:
    # only \n (and \r\n) break lines, so reader and writer agree; clean() rejects every other line break
    return text.replace("\r\n", "\n").split("\n")


# ---- parse / render ---------------------------------------------------------------------------------
def _read_password(raw: str) -> str:
    v = raw.strip()
    if len(v) >= 2 and v.startswith('"') and v.endswith('"'):
        try:
            decoded = json.loads(v)
            if isinstance(decoded, str):
                return decoded
        except ValueError:
            pass
    return v


def _write_password(pw: str) -> str:
    return json.dumps(pw, ensure_ascii=False) if pw != pw.strip() or pw.startswith('"') else pw


def parse(text: str) -> list[dict]:
    entries: list[dict] = []
    cur: dict | None = None
    in_notes = False
    for raw in _lines(text):
        m = _TITLE.match(raw)
        if m:
            cur = {"title": m.group(1), "url": "", "username": "", "password": "", "tags": "", "notes": ""}
            entries.append(cur)
            in_notes = False
            continue
        if cur is None:
            continue  # preamble before the first block
        if in_notes and (raw.startswith("  ") or not raw.strip()):
            cur["notes"] += ("\n" if cur["notes"] else "") + raw[2:]
            continue
        in_notes = False
        if not raw.strip():
            continue
        kv = _KV.match(raw)
        key = kv and kv.group(1).strip().lower()
        if key == "notes":
            in_notes = True
            if kv.group(2).strip():
                cur["notes"] += ("\n" if cur["notes"] else "") + kv.group(2).strip()
        elif key in ALIASES and not cur[ALIASES[key]]:
            field = ALIASES[key]
            cur[field] = _read_password(kv.group(2)) if field == "password" else kv.group(2).strip()
        else:  # anything else is kept verbatim in the notes
            cur["notes"] += ("\n" if cur["notes"] else "") + raw.strip()
    for e in entries:
        e["notes"] = e["notes"].strip("\n")
    return entries


def preamble(text: str) -> str:
    """Text before the first block that the user wrote (our own header lines are regenerated on save)."""
    keep = []
    for line in _lines(text):
        if _TITLE.match(line):
            break
        if line == HEADER.rstrip("\n") or line.startswith("# last saved "):
            continue
        keep.append(line)
    return "\n".join(keep).strip("\n")


def render(entries: list[dict], pre: str = "") -> str:
    out = [HEADER, f"# last saved {time.strftime('%Y-%m-%d %H:%M:%S')} · {len(entries)} entries\n"]
    if pre:
        out.append(f"\n{pre}\n")
    for e in entries:
        out.append(f"\n=== {e['title']} ===\n")
        for f in FIELDS:
            if e.get(f):
                value = _write_password(e[f]) if f == "password" else e[f]
                out.append(f"{LABELS[f]:<9}: {value}\n")
        if e.get("notes"):
            out.append("Notes    :\n")
            out.extend(f"  {line}\n" for line in _lines(e["notes"]))
    return "".join(out)


def fingerprint(entry: dict) -> str:
    """Identifies the exact entry a page loaded, so a stale edit/delete never hits the wrong block."""
    data = {k: entry.get(k, "") for k in ("title", "url", "username", "password", "tags", "notes")}
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()[:16]


def clean(data: dict) -> dict:
    e = {k: str(data.get(k) or "").strip() for k in ("title", "url", "username", "tags")}
    e["password"] = str(data.get("password") or "")
    e["notes"] = str(data.get("notes") or "").replace("\r\n", "\n").strip("\n")
    for k in ("title", "url", "username", "password", "tags"):
        if len(e[k].splitlines()) > 1 or "\r" in e[k] or "\n" in e[k]:
            raise CredError(f"{k} must be a single line")
    if e["notes"] and len(e["notes"].splitlines()) != len(e["notes"].split("\n")):
        raise CredError("notes contain unusual line-break characters; use plain new lines")
    if not e["title"]:
        e["title"] = e["url"] or e["username"]
    if not e["title"]:
        raise CredError("give the entry a title, URL or username")
    if "===" in e["title"]:
        raise CredError("title cannot contain '==='")
    return e


# ---- git safety -------------------------------------------------------------------------------------
def siblings(path: Path) -> list[Path]:
    """Every file this module writes for `path`: the file, its backup and its temp files."""
    return [path, path.with_name(path.name + ".bak"), path.with_name(path.name + ".tmp-x")]


def git_safety(path: Path, app_root: Path) -> dict:
    """Could this file (or its .bak / temp copy) end up in a commit?"""
    return all_safe(siblings(path.resolve()), app_root)


def add_to_gitignore(repo: Path, rel: str) -> None:
    if (repo / ".git").exists() and git_tracked(repo, rel):
        raise CredError(f"{rel} is already tracked by git; run `git rm --cached {rel}` first")
    gi = repo / ".gitignore"
    text = gi.read_text() if gi.exists() else ""
    line = f"/{rel}*"  # the file plus its .bak / .tmp-* siblings
    if line in text.splitlines():
        return
    sep = "" if not text or text.endswith("\n") else "\n"
    gi.write_text(f"{text}{sep}\n# added by Everyday Utility: private credentials file (+ .bak / temp)\n{line}\n")


# ---- location rules ---------------------------------------------------------------------------------
def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8-sig") if path.is_file() else ""  # -sig: Windows BOM tolerated
    except UnicodeDecodeError as e:
        raise CredError(f"{path} is not UTF-8 text; convert it first (e.g. iconv -f latin1 -t utf-8)") from e


_KV_SPACING = re.compile(r"^([A-Za-z][A-Za-z ]{0,20}?)\s*:\s*")


def _body(text: str) -> str:
    """Content for round-trip checks: our header lines, blank lines and the spacing around a key's ':' are
    formatting; anything else (indentation, wording, order) must survive a save unchanged."""
    lines = []
    for ln in _lines(text):
        if ln == HEADER.rstrip("\n") or ln.startswith("# last saved ") or not ln.strip():
            continue
        lines.append(_KV_SPACING.sub(lambda m: f"{m.group(1).strip().lower()}:", ln.rstrip()))
    return "\n".join(lines)


def _roundtrips(text: str) -> bool:
    return _body(render(parse(text), preamble(text))) == _body(text)


def validate_location(path: Path, app_root: Path) -> None:
    """Raise CredError unless writing credentials to `path` is harmless for the file and for git."""
    if not path.is_absolute():
        raise CredError("use an absolute path (or ~/…)")
    path, app_root = path.resolve(), app_root.resolve()
    if path == app_root or app_root in path.parents:
        private = app_root / "private"
        if private not in path.parents:
            raise CredError(f"inside the app folder only {private}/ may hold the credentials file")
    if path.exists() and not path.is_file():
        raise CredError(f"{path} is not a file")
    text = read_text(path)
    if text.strip() and not text.startswith(HEADER) and not _roundtrips(text):
        # an existing file the app did not create: only accepted if saving would not change a single line
        raise CredError(f"{path.name} already has content that is not in the credentials format; "
                        "choose a new file name (the app never rewrites other files)")


# ---- file store -------------------------------------------------------------------------------------
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock_for(path: Path) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(str(path), threading.Lock())


def _atomic_write(path: Path, data: bytes) -> None:
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".tmp-")  # unique, matches the /<rel>* rule
    f = None
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(fd, 0o600)  # owner-only from the first byte
        f = os.fdopen(fd, "wb")
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
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


class CredFile:
    def __init__(self, path: Path):
        self.path = path
        self._lock = _lock_for(path)

    def read(self) -> list[dict]:
        return [{**e, "hash": fingerprint(e)} for e in parse(read_text(self.path))]

    def _write(self, entries: list[dict]) -> None:
        old = read_text(self.path)
        if old.strip() and not old.startswith(HEADER) and not _roundtrips(old):
            raise CredError("refusing to overwrite a file that is not in the credentials format")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.exists():
            _atomic_write(self.path.with_name(self.path.name + ".bak"), self.path.read_bytes())
        _atomic_write(self.path, render(entries, preamble(old)).encode("utf-8"))

    def _locate(self, entries: list[dict], index: int, expected_hash: str) -> None:
        # the file may have changed since the page loaded (hand edit, another tab): never touch the wrong entry
        if not (0 <= index < len(entries)) or fingerprint(entries[index]) != expected_hash:
            raise CredError("the file changed since it was loaded — reload and try again")

    def add(self, data: dict) -> dict:
        with self._lock:
            entries = parse(read_text(self.path))
            entry = clean(data)
            entries.append(entry)
            self._write(entries)
            return entry

    def update(self, index: int, expected_hash: str, data: dict) -> dict:
        with self._lock:
            entries = parse(read_text(self.path))
            self._locate(entries, index, expected_hash)
            entries[index] = clean(data)
            self._write(entries)
            return entries[index]

    def delete(self, index: int, expected_hash: str) -> None:
        with self._lock:
            entries = parse(read_text(self.path))
            self._locate(entries, index, expected_hash)
            del entries[index]
            self._write(entries)
