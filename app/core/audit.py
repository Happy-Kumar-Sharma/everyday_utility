"""Append-only audit log: what ran, against which environment, when — never secret values.

One JSON object per line in data/audit/audit.jsonl:
    {"ts": 1793800000.0, "kind": "job", "action": "start", "target": "Batched predictions",
     "env": "local", "status": null, "detail": {...}}

kinds used across the app: job, library, credentials, env-files, backup, settings, auth, pipeline.
Callers pass names, paths, counts and titles only — passwords, env values and file contents must
never be recorded (``detail`` is size-capped as a second line of defence).
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

from . import config

MAX_DETAIL_CHARS = 2000
_lock = threading.Lock()


def _path() -> Path:
    # read config at call time so tests (and EU_DATA_DIR) can redirect it
    return config.DATA_DIR / "audit" / "audit.jsonl"


def record(kind: str, action: str, target: str = "", *, env: str | None = None, status: str | None = None,
           detail: dict | None = None) -> dict:
    """Append one event. Never raises: auditing must not break the action being audited."""
    event = {"ts": time.time(), "kind": kind, "action": action, "target": str(target)[:500],
             "env": env, "status": status, "detail": detail or {}}
    try:
        text = json.dumps(event["detail"], default=str)
        if len(text) > MAX_DETAIL_CHARS:
            event["detail"] = {"truncated": text[:MAX_DETAIL_CHARS]}
        line = json.dumps(event, default=str)
        with _lock:
            p = _path()
            p.parent.mkdir(parents=True, exist_ok=True)
            with p.open("a", encoding="utf-8") as f:
                f.write(line + "\n")
    except Exception:  # noqa: BLE001 - see docstring
        pass
    return event


def recent(limit: int = 100, *, kind: str | None = None, query: str | None = None,
           since: float | None = None) -> list[dict]:
    """Newest first, optionally filtered by kind, a case-insensitive text match, or a minimum timestamp."""
    p = _path()
    if not p.is_file():
        return []
    q = (query or "").lower()
    out: list[dict] = []
    with _lock:
        lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
    for line in reversed(lines):
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if kind and e.get("kind") != kind:
            continue
        if since is not None and e.get("ts", 0) < since:
            break  # file is chronological: everything further back is older
        if q and q not in line.lower():
            continue
        out.append(e)
        if len(out) >= limit:
            break
    return out
