"""Home dashboard: one read-only snapshot of the other tabs. Each section is computed independently so a
broken one (corrupt planner file, missing library folder …) becomes an error entry, not a failed page."""

from __future__ import annotations

import importlib
import time
from datetime import date, datetime, timedelta

from app.core import audit, context

TOP_TASKS = 8
FINISHED_JOBS = 5
RECENT_ITEMS = 5
FAVOURITES = 6
ACTIVITY = 8
BACKUP_STALE_DAYS = 7
MAX_COPY_CHARS = 20_000  # bigger items are opened in the Library instead of copied from Home
PRIO_RANK = {"high": 0, "normal": 1, "low": 2}


def _module(name: str):
    # imported per call: a tab that fails to import only breaks its own section, not Home. (importlib because
    # the packages re-export their APIRouter as `router`, which shadows the submodule on attribute import)
    return importlib.import_module(f"app.services.{name}")


def _midnight(d: date) -> float:
    return datetime.combine(d, datetime.min.time()).timestamp()


def date_section() -> dict:
    today = date.today()
    return {"today": today.isoformat(), "weekday": today.strftime("%A"), "week": today.isocalendar()[1]}


# ---- planner -------------------------------------------------------------------------------------
def _task_brief(t: dict) -> dict:
    checklist = t.get("checklist") or []
    return {
        "id": t["id"], "title": t.get("title", ""), "status": t.get("status"), "priority": t.get("priority", "normal"),
        "due": t.get("due"), "tags": t.get("tags") or [],
        "checklist": {"done": sum(1 for i in checklist if i.get("done")), "total": len(checklist)},
    }


def _ranked(tasks: list[dict]) -> list[dict]:
    tasks = sorted(tasks, key=lambda t: (PRIO_RANK.get(t.get("priority"), 1), t.get("due") or "9999", t.get("created_at") or 0))
    return [_task_brief(t) for t in tasks[:TOP_TASKS]]


def planner_section() -> dict:
    tasks = _module("planner.router").store.tasks()
    today = date.today()
    t_iso = today.isoformat()
    open_ = [t for t in tasks if t.get("status") != "done"]
    overdue = [t for t in open_ if t.get("due") and t["due"] < t_iso]
    due_today = [t for t in open_ if t.get("due") == t_iso]
    # in progress lists only what the two lists above don't already show
    doing = [t for t in open_ if t.get("status") == "doing" and not (t.get("due") and t["due"] <= t_iso)]

    pending = [t for t in open_ if t.get("remind_at") and not t.get("reminded")]
    nxt = min(pending, key=lambda t: t["remind_at"], default=None)

    timed = [t for t in open_ if t.get("timer_started_at")]
    running = max(timed, key=lambda t: t["timer_started_at"], default=None)

    done_at = [t.get("done_at") or 0 for t in tasks if t.get("status") == "done"]
    day_start = _midnight(today)
    week_start = _midnight(today - timedelta(days=today.weekday()))
    return {
        "overdue": _ranked(overdue), "today": _ranked(due_today), "doing": _ranked(doing),
        "counts": {"overdue": len(overdue), "today": len(due_today), "doing": len(doing), "open": len(open_)},
        "next_reminder": nxt and {**_task_brief(nxt), "remind_at": nxt["remind_at"]},
        "timer": running and {**_task_brief(running), "started_at": running["timer_started_at"],
                              "time_spent": running.get("time_spent") or 0},
        "done_today": sum(1 for ts in done_at if ts >= day_start),
        "done_week": sum(1 for ts in done_at if ts >= week_start),
    }


# ---- jobs ----------------------------------------------------------------------------------------
def _job_brief(job) -> dict:
    d = job.to_dict()
    return {k: d[k] for k in ("id", "title", "status", "exit_code", "started_at", "ended_at", "duration")}


def jobs_section() -> dict:
    jobs = context.jobs.list()  # newest first
    return {
        "running": [_job_brief(j) for j in jobs if not j.done],
        "finished": [_job_brief(j) for j in jobs if j.done][:FINISHED_JOBS],
    }


# ---- backup --------------------------------------------------------------------------------------
def backup_section() -> dict:
    last = next(iter(audit.recent(1, kind="backup")), None)
    if not last:
        return {"last": None, "age_days": None, "stale": True}
    age = (time.time() - last.get("ts", 0)) / 86400
    failed = last.get("status") in ("failed", "error")
    return {
        "last": {"ts": last.get("ts"), "target": last.get("target", ""), "status": last.get("status"), "action": last.get("action")},
        "age_days": round(age, 1),
        "stale": failed or age > BACKUP_STALE_DAYS,
    }


# ---- library -------------------------------------------------------------------------------------
def _item_brief(i: dict) -> dict:
    copyable = not i.get("binary") and not i.get("truncated") and len(i.get("content") or "") <= MAX_COPY_CHARS
    return {
        "path": i["path"], "name": i["name"], "collection": i["collection"], "type": i["type"], "env": i.get("env", ""),
        "favorite": bool(i.get("favorite")), "uses": i.get("uses") or 0, "last_used": i.get("last_used"),
        "content": i.get("content", "") if copyable else None,
    }


def library_section() -> dict:
    library_router = _module("library.router")
    st = library_router._status()
    if st["problem"] or not st["exists"]:
        hint = st["problem"] or f"The library folder {st['root']} does not exist yet — open the Library tab to create it."
        return {"root": st["root"], "hint": hint, "favourites": [], "recent": []}
    items = _module("library.store").Library(library_router._root()).items()
    favs = sorted((i for i in items if i.get("favorite")), key=lambda i: (-(i.get("uses") or 0), i["path"].lower()))
    used = sorted((i for i in items if i.get("last_used")), key=lambda i: -i["last_used"])
    # the Library refuses writes (usage counts included) while the folder could be committed: say so up front
    warning = None if st["git"]["safe"] else (
        f"{st['root']} is inside git repo {st['git'].get('repo')} and not ignored — queries may hold prod details; "
        "add it to .gitignore or pick another folder in ⚙ Settings. Copying still works, but usage isn't tracked.")
    return {
        "root": st["root"], "hint": None, "warning": warning, "total": len(items),
        "favourites": [_item_brief(i) for i in favs[:FAVOURITES]],
        "recent": [_item_brief(i) for i in used[:RECENT_ITEMS]],
    }


# ---- activity ------------------------------------------------------------------------------------
def activity_section() -> dict:
    return {"events": audit.recent(ACTIVITY)}


def _safe(fn) -> dict:
    try:
        return fn()
    except Exception as e:  # noqa: BLE001 - one broken section must not break the dashboard
        return {"error": f"{type(e).__name__}: {e}"}


def summary() -> dict:
    return {
        "now": time.time(),
        "date": _safe(date_section),
        "planner": _safe(planner_section),
        "jobs": _safe(jobs_section),
        "backup": _safe(backup_section),
        "library": _safe(library_section),
        "activity": _safe(activity_section),
    }
