"""Shell commands for the two steps. Every value is shlex-quoted; ids are validated before they get here."""

from __future__ import annotations

import os
import shlex
import shutil
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Command:
    title: str
    script: str
    display: str
    env: dict = field(default_factory=lambda: {"PYTHONUNBUFFERED": "1"})


def _expand(value: str) -> str:
    return str(Path(str(value)).expanduser())


def repo_dir(s: dict) -> Path:
    return Path(_expand(s["repo_dir"]))


def python_arg(s: dict) -> str:
    """A bare name stays a name (looked up on PATH); anything path-like is expanded."""
    value = str(s["python"]).strip()
    return _expand(value) if ("/" in value or value.startswith("~")) else value


def python_info(s: dict) -> dict:
    value = python_arg(s)
    if not value:
        return {"value": value, "found": False, "path": None}
    if "/" in value:
        ok = Path(value).is_file() and os.access(value, os.X_OK)
        return {"value": value, "found": ok, "path": value if ok else None}
    path = shutil.which(value)
    return {"value": value, "found": bool(path), "path": path}


def _render(s: dict, args: list[str]) -> str:
    return (f"cd {shlex.quote(str(repo_dir(s)))} && exec {shlex.quote(python_arg(s))} "
            + " ".join(shlex.quote(str(a)) for a in args))


def sync(s: dict, ids: list[str], reupload: bool) -> Command:
    if not ids:
        raise ValueError("no ids")
    args = [s["sync_script"], "sync_ids", "--ids", *ids] + (["--reupload"] if reupload else [])
    line = _render(s, args)
    n = len(ids)
    return Command(f"Prod → Staging sync ({n} id{'s' if n != 1 else ''})", line, line)


def lookup(s: dict, json_ids: list[str], output: Path) -> Command:
    if not json_ids:
        raise ValueError("no json ids")
    timeout = max(1, min(int(s.get("lookup_timeout") or 10), 600))
    args = [s["lookup_script"], "--ids", *json_ids, "--timeout", str(timeout), "--output", str(output)]
    line = _render(s, args)
    n = len(json_ids)
    return Command(f"Staging lookup ({n} id{'s' if n != 1 else ''})", line, line)
