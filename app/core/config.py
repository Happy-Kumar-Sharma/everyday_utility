"""App-wide paths and runtime settings."""

from __future__ import annotations

import os
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
WEB_DIR = ROOT_DIR / "web"
DATA_DIR = Path(os.environ.get("EU_DATA_DIR", ROOT_DIR / "data")).expanduser()

UPLOADS_DIR = DATA_DIR / "uploads"
JOBS_DIR = DATA_DIR / "jobs"
SETTINGS_DIR = DATA_DIR / "settings"

HOST = os.environ.get("EU_HOST", "127.0.0.1")
PORT = int(os.environ.get("EU_PORT", "8765"))


def _hostnames(value: str) -> tuple[str, ...]:
    """'Box.ts.net:443, other' -> ('box.ts.net', 'other'): hosts are matched without port, case-insensitive."""
    return tuple(h.strip().lower().rsplit(":", 1)[0] if h.count(":") == 1 else h.strip().lower()
                 for h in value.split(",") if h.strip())


# extra hostnames served behind a login (e.g. "mybox.tail1234.ts.net" via `tailscale serve`); empty = local only
REMOTE_HOSTS = _hostnames(os.environ.get("EU_REMOTE_HOSTS", ""))
SESSION_HOURS = float(os.environ.get("EU_SESSION_HOURS", "12"))

# rows returned by preview endpoints, keeps the browser responsive on 20k+ row files
PREVIEW_ROWS = 50
# lines of job output kept in memory per job (the full log is always on disk)
JOB_LOG_MEMORY_LINES = 5000


def ensure_dirs() -> None:
    for d in (UPLOADS_DIR, JOBS_DIR, SETTINGS_DIR):
        d.mkdir(parents=True, exist_ok=True)
