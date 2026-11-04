"""🧾 Activity tab: the audit log (app/core/audit.py) as a filterable timeline, with export."""

from __future__ import annotations

import json
import time
from collections import Counter
from typing import Literal

from fastapi import APIRouter, Query
from fastapi.responses import PlainTextResponse

from app.core import audit
from app.core.registry import Service

router = APIRouter()

SCAN_LIMIT = 50_000  # events read per request; the whole log of a single-user app fits easily
KIND_ICONS = {"job": "⚙️", "library": "📚", "credentials": "🔑", "env-files": "🧾", "backup": "💾",
              "settings": "🛠️", "auth": "🔐", "pipeline": "🧠"}


def _has(text: str, q: str) -> bool:
    return q.lower() in text.lower()


def _events(*, kind: str | None, q: str | None, since: float | None, until: float | None,
            status: str | None, env: str | None) -> tuple[list[dict], Counter]:
    """Matching events (newest first) plus per-kind counts of the window before the kind filter."""
    # matched on the decoded event, not audit.recent(query=): the raw log line escapes non-ASCII (café → caf\\u00e9)
    window = audit.recent(SCAN_LIMIT, since=since)
    if q:
        window = [e for e in window if _has(json.dumps(e, ensure_ascii=False, default=str), q)]
    if until is not None:
        window = [e for e in window if e.get("ts", 0) <= until]
    if status:
        window = [e for e in window if e.get("status") == status]
    if env:
        window = [e for e in window if (e.get("env") or "none") == env]
    kinds = Counter(e.get("kind", "") for e in window)
    return [e for e in window if not kind or e.get("kind") == kind], kinds


def _stats() -> dict:
    now = time.time()
    midnight = time.mktime(time.localtime(now)[:3] + (0, 0, 0, 0, 0, -1))
    week = audit.recent(SCAN_LIMIT, since=now - 7 * 86400)
    backups = audit.recent(50, kind="backup")
    last_ok = next((b for b in backups if b.get("status") == "succeeded"), None)
    return {
        "today": sum(e.get("ts", 0) >= midnight for e in week),
        "jobs_failed_7d": sum(e.get("kind") == "job" and e.get("status") == "failed" for e in week),
        "last_backup": backups[0] if backups else None,
        "last_backup_ok": last_ok,
    }


@router.get("/events")
def events(limit: int = Query(300, ge=1, le=5000), kind: str | None = None, q: str | None = None,
           since: float | None = None, until: float | None = None, status: str | None = None,
           env: str | None = None):
    matched, kinds = _events(kind=kind, q=q, since=since, until=until, status=status, env=env)
    return {
        "events": matched[:limit],
        "total": len(matched),
        "kinds": [{"kind": k, "count": n, "icon": KIND_ICONS.get(k, "•")} for k, n in sorted(kinds.items())],
        "stats": _stats(),
    }


def _text_line(e: dict) -> str:
    when = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(e.get("ts", 0)))
    head = "  ".join(x for x in (when, e.get("kind", ""), e.get("action", ""), e.get("target", "")) if x)
    tags = " ".join(f"[{x}]" for x in (e.get("env"), e.get("status")) if x)
    detail = "; ".join(f"{k}={json.dumps(v) if not isinstance(v, str) else v}" for k, v in (e.get("detail") or {}).items())
    return "  ".join(x for x in (head, tags) if x) + (f"\n    {detail}" if detail else "")


@router.get("/export")
def export(format: Literal["txt", "jsonl"] = "txt", kind: str | None = None, q: str | None = None,
           since: float | None = None, status: str | None = None, env: str | None = None):
    matched, _ = _events(kind=kind, q=q, since=since, until=None, status=status, env=env)
    matched.reverse()  # files read top to bottom: oldest first, like the log itself
    if format == "jsonl":
        body = "".join(json.dumps(e, default=str) + "\n" for e in matched)
    else:
        body = f"Everyday Utility activity — {len(matched)} events, exported {time.strftime('%Y-%m-%d %H:%M')}\n\n"
        body += "\n".join(_text_line(e) for e in matched) + "\n"
    name = f"activity_{time.strftime('%Y%m%d-%H%M%S')}.{format}"
    return PlainTextResponse(body, headers={"Content-Disposition": f'attachment; filename="{name}"'})


def search(query: str) -> list[dict]:
    out = []
    for e in audit.recent(SCAN_LIMIT):
        if not _has(f"{e.get('action', '')} {e.get('target', '')}", query):
            continue  # detail is too noisy for global search
        when = time.strftime("%Y-%m-%d %H:%M", time.localtime(e.get("ts", 0)))
        out.append({"title": f"{e.get('action', '')} · {e.get('target', '')}",
                    "subtitle": " · ".join(x for x in (e.get("kind"), when, e.get("env"), e.get("status")) if x),
                    "icon": KIND_ICONS.get(e.get("kind", ""), "🧾"), "ref": str(e.get("ts"))})
        if len(out) >= 8:
            break
    return out


SERVICE = Service(
    id="activity",
    title="Activity",
    description="Everything that ran or changed — jobs, library, logins, env files, backups, settings — newest first.",
    icon="🧾",
    order=90,
    router=router,
    search=search,
)
