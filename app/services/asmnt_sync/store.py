"""Sync runs, persisted in data/asmnt_sync/runs.json (atomic write, newest first, last KEEP runs)."""

from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
import time
import uuid
from collections.abc import Callable
from pathlib import Path

from app.core import config

KEEP = 200
log = logging.getLogger(__name__)


def data_dir() -> Path:
    # read at call time so tests (EU_DATA_DIR / monkeypatched config) redirect it
    return config.DATA_DIR / "asmnt_sync"


def new_item(prod_id: str = "", json_id: str = "", *, sync_state: str = "pending") -> dict:
    return {"prod_id": prod_id, "json_id": json_id, "staging_id": "", "otp": "", "status": "", "created_date": "",
            "sync_state": sync_state, "sync_error": "", "sync_hint": "",
            "lookup_state": "pending", "lookup_error": "", "lookup_hint": ""}


def new_run(*, kind: str, reupload: bool = False, items: list[dict]) -> dict:
    return {"id": time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6], "created_at": time.time(), "kind": kind,
            "reupload": bool(reupload), "items": items, "sync_job_id": None, "lookup_job_ids": [], "lookups": {},
            "finalized": [], "job_status": {}, "sync_message": None, "lookup_message": None, "notes": ""}


class RunStore:
    def __init__(self, path: Path | None = None):
        self._path = path
        self.lock = threading.RLock()

    @property
    def path(self) -> Path:
        return self._path or data_dir() / "runs.json"

    def load(self) -> list[dict]:
        with self.lock:
            p = self.path
            if not p.is_file():
                return []
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
            except ValueError:
                backup = p.with_name(f"runs.corrupt-{int(time.time())}.json")
                log.warning("runs file unreadable, moved to %s", backup)
                p.replace(backup)
                return []
            return data if isinstance(data, list) else []

    def save(self, runs: list[dict]) -> None:
        with self.lock:
            for run in runs:  # transient, computed per request
                for item in run.get("items", []):
                    item.pop("active", None)
            runs = sorted(runs, key=lambda r: r.get("created_at", 0), reverse=True)[:KEEP]
            p = self.path
            p.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=p.parent, prefix=".runs-", suffix=".tmp")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(runs, f, indent=1, ensure_ascii=False)
                os.replace(tmp, p)
            except BaseException:
                Path(tmp).unlink(missing_ok=True)
                raise

    def get(self, run_id: str) -> dict | None:
        return next((r for r in self.load() if r.get("id") == run_id), None)

    def add(self, run: dict) -> dict:
        with self.lock:
            runs = self.load()
            runs.insert(0, run)
            self.save(runs)
        return run

    def update(self, run_id: str, fn: Callable[[dict], None]) -> dict | None:
        with self.lock:
            runs = self.load()
            run = next((r for r in runs if r.get("id") == run_id), None)
            if run is None:
                return None
            fn(run)
            self.save(runs)
            return run

    def delete(self, run_id: str) -> dict | None:
        with self.lock:
            runs = self.load()
            run = next((r for r in runs if r.get("id") == run_id), None)
            if run is not None:
                self.save([r for r in runs if r is not run])
            return run
