"""Registry of repositories and discovery / parsing / export of their env and credentials files."""

from __future__ import annotations

import fnmatch
import json
import os
import shlex
import threading
import time
from pathlib import Path

SKIP_DIRS = {
    ".git", ".hg", ".svn", "venv", ".venv", "env", "node_modules", "__pycache__", "site-packages",
    "dist", "build", ".mypy_cache", ".pytest_cache", ".tox", ".idea", ".vscode", ".next", "target",
}
MAX_FILE_BYTES = 1_000_000


class EnvError(ValueError):
    pass


def parse_patterns(text: str) -> list[str]:
    return [p.strip() for p in text.replace("\n", ",").split(",") if p.strip()]


def _matches(name: str, patterns: list[str]) -> bool:
    if name.endswith(("Zone.Identifier", ".bak", ".swp")):  # Windows download markers, backups
        return False
    return any(fnmatch.fnmatch(name, p) for p in patterns)


def discover(repo: Path, patterns: list[str], max_depth: int) -> list[Path]:
    """Env-like files under repo, skipping virtualenvs / VCS / build folders."""
    found: list[Path] = []
    base_depth = len(repo.parts)
    for dirpath, dirnames, filenames in os.walk(repo):
        depth = len(Path(dirpath).parts) - base_depth
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and depth < max_depth]
        for name in filenames:
            if _matches(name, patterns):
                found.append(Path(dirpath) / name)
    return sorted(found)


def parse_vars(text: str) -> list[dict]:
    """KEY=VALUE pairs from .env files and `export KEY=VALUE` shell scripts (comments, blank lines skipped)."""
    out = []
    for n, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].lstrip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key.replace("_", "").isalnum():
            continue
        try:
            tokens = shlex.split(value, comments=True)
            value = tokens[0] if tokens else ""
        except ValueError:
            value = value.strip()
        out.append({"key": key, "value": value, "line": n})
    return out


def read_text(path: Path) -> str:
    if path.stat().st_size > MAX_FILE_BYTES:
        raise EnvError(f"{path} is larger than {MAX_FILE_BYTES // 1000} KB, not an env file?")
    return path.read_text(encoding="utf-8", errors="replace")


class RepoStore:
    """Registered repositories plus manually added files, persisted as JSON."""

    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()

    def _load(self) -> dict:
        if self.path.is_file():
            return json.loads(self.path.read_text(encoding="utf-8"))
        return {"repos": []}

    def _save(self, data: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
        tmp.replace(self.path)

    def repos(self) -> list[dict]:
        return self._load()["repos"]

    def add_repo(self, path: str) -> dict:
        p = Path(path).expanduser().resolve()
        if not p.is_dir():
            raise EnvError(f"folder not found: {p}")
        with self._lock:
            data = self._load()
            for r in data["repos"]:
                if r["path"] == str(p):
                    return r
            repo = {"path": str(p), "name": p.name, "extra_files": [], "added_at": time.time()}
            data["repos"].append(repo)
            data["repos"].sort(key=lambda r: r["name"].lower())
            self._save(data)
            return repo

    def remove_repo(self, path: str) -> None:
        with self._lock:
            data = self._load()
            data["repos"] = [r for r in data["repos"] if r["path"] != path]
            self._save(data)

    def add_file(self, repo_path: str, file_path: str) -> dict:
        f = Path(file_path).expanduser()
        if not f.is_absolute():
            f = Path(repo_path) / f
        f = f.resolve()
        if not f.is_file():
            raise EnvError(f"file not found: {f}")
        with self._lock:
            data = self._load()
            for r in data["repos"]:
                if r["path"] == repo_path:
                    if str(f) not in r["extra_files"]:
                        r["extra_files"].append(str(f))
                        self._save(data)
                    return r
        raise EnvError(f"repository not registered: {repo_path}")

    def remove_file(self, repo_path: str, file_path: str) -> None:
        with self._lock:
            data = self._load()
            for r in data["repos"]:
                if r["path"] == repo_path:
                    r["extra_files"] = [x for x in r["extra_files"] if x != file_path]
            self._save(data)


def repo_files(repo: dict, patterns: list[str], max_depth: int) -> list[dict]:
    root = Path(repo["path"])
    paths = discover(root, patterns, max_depth) if root.is_dir() else []
    extra = [Path(x) for x in repo.get("extra_files", [])]
    out, seen = [], set()
    for p in paths + extra:
        if str(p) in seen:
            continue
        seen.add(str(p))
        exists = p.is_file()
        try:
            rel = str(p.relative_to(root))
        except ValueError:
            rel = str(p)
        info = {"path": str(p), "rel": rel, "exists": exists, "manual": p in extra}
        if exists:
            try:
                st = p.stat()
                info.update(size=st.st_size, mtime=st.st_mtime)
                info["var_count"] = len(parse_vars(read_text(p)))
            except (EnvError, OSError):  # one unreadable file must not hide the repo's other files
                info["var_count"] = None
        out.append(info)
    return out


def export_text(repos: list[dict], patterns: list[str], max_depth: int) -> str:
    lines = [
        "# Everyday Utility — env files export (PLAIN TEXT, contains secrets)",
        f"# {time.strftime('%Y-%m-%d %H:%M:%S')} · {len(repos)} repositories",
        "",
    ]
    for repo in repos:
        files = [f for f in repo_files(repo, patterns, max_depth) if f["exists"]]
        lines += ["#" * 100, f"# REPO: {repo['name']}  ({repo['path']})  · {len(files)} files", "#" * 100, ""]
        for f in files:
            lines.append(f"==================== {f['rel']} ====================")
            try:
                lines.append(read_text(Path(f["path"])).rstrip("\n"))
            except (EnvError, OSError) as e:
                lines.append(f"!! could not read: {e}")
            lines.append("")
    return "\n".join(lines) + "\n"
