"""Planner data: tasks (with checklists, reminders, recurrence) and per-day notes, in one JSON file."""

from __future__ import annotations

import calendar
import json
import shutil
import threading
import time
import uuid
from datetime import date, timedelta
from pathlib import Path

STATUSES = ("todo", "doing", "done")
PRIORITIES = ("low", "normal", "high")
REPEATS = ("none", "daily", "weekdays", "weekly", "monthly")


class PlannerError(ValueError):
    pass


def _new_id() -> str:
    return uuid.uuid4().hex[:10]


def _parse_date(value) -> str | None:
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10]).isoformat()
    except ValueError as e:
        raise PlannerError(f"bad date '{value}', use YYYY-MM-DD") from e


def _add_month(d: date) -> date:
    y, m = (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)
    return d.replace(year=y, month=m, day=min(d.day, calendar.monthrange(y, m)[1]))


def next_due(due: date, repeat: str) -> date:
    if repeat == "daily":
        return due + timedelta(days=1)
    if repeat == "weekdays":
        nxt = due + timedelta(days=1)
        while nxt.weekday() >= 5:
            nxt += timedelta(days=1)
        return nxt
    if repeat == "weekly":
        return due + timedelta(days=7)
    if repeat == "monthly":
        return _add_month(due)
    raise PlannerError(f"unknown repeat '{repeat}'")


class PlannerStore:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.RLock()

    # ---- persistence ----------------------------------------------------------------------------
    def _load(self) -> dict:
        if self.path.is_file():
            data = json.loads(self.path.read_text())
        else:
            data = {}
        data.setdefault("tasks", [])
        data.setdefault("notes", {})
        return data

    def _save(self, data: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.exists():
            shutil.copy2(self.path, self.path.with_suffix(".json.bak"))
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=1))
        tmp.replace(self.path)

    # ---- tasks ----------------------------------------------------------------------------------
    @staticmethod
    def _clean(patch: dict, base: dict | None = None) -> dict:
        t = dict(base or {
            "title": "", "notes": "", "status": "todo", "priority": "normal", "due": None, "remind_at": None,
            "reminded": False, "tags": [], "checklist": [], "repeat": "none", "done_at": None,
        })
        for key in ("title", "notes"):
            if key in patch:
                t[key] = str(patch[key] or "").strip()
        if "status" in patch:
            if patch["status"] not in STATUSES:
                raise PlannerError(f"status must be one of {STATUSES}")
            t["status"] = patch["status"]
        if "priority" in patch:
            if patch["priority"] not in PRIORITIES:
                raise PlannerError(f"priority must be one of {PRIORITIES}")
            t["priority"] = patch["priority"]
        if "repeat" in patch:
            if patch["repeat"] not in REPEATS:
                raise PlannerError(f"repeat must be one of {REPEATS}")
            t["repeat"] = patch["repeat"]
        if "due" in patch:
            t["due"] = _parse_date(patch["due"])
        if "remind_at" in patch:
            # epoch seconds from the browser, so the user's local timezone is already applied
            t["remind_at"] = float(patch["remind_at"]) if patch["remind_at"] else None
            t["reminded"] = False
        if "tags" in patch:
            tags = patch["tags"]
            if isinstance(tags, str):
                tags = tags.split(",")
            t["tags"] = list(dict.fromkeys(str(x).strip().lstrip("#").lower() for x in tags if str(x).strip()))
        if "checklist" in patch:
            t["checklist"] = [
                {"id": i.get("id") or _new_id(), "text": str(i.get("text", "")).strip(), "done": bool(i.get("done"))}
                for i in patch["checklist"] if str(i.get("text", "")).strip()
            ]
        if not t["title"]:
            raise PlannerError("a task needs a title")
        return t

    def tasks(self) -> list[dict]:
        return self._load()["tasks"]

    def _find(self, data: dict, task_id: str) -> dict:
        for t in data["tasks"]:
            if t["id"] == task_id:
                return t
        raise PlannerError(f"no task {task_id}")

    def add(self, patch: dict) -> dict:
        with self._lock:
            data = self._load()
            now = time.time()
            task = {"id": _new_id(), **self._clean(patch), "created_at": now, "updated_at": now}
            if task["status"] == "done":
                task["done_at"] = now
            data["tasks"].append(task)
            self._save(data)
            return task

    def update(self, task_id: str, patch: dict) -> dict:
        """Partial update. Completing a repeating task spawns its next occurrence; returns {task, spawned}."""
        with self._lock:
            data = self._load()
            task = self._find(data, task_id)
            was_done = task["status"] == "done"
            task.update(self._clean(patch, task), updated_at=time.time())
            spawned = None
            if task["status"] == "done" and not was_done:
                task["done_at"] = time.time()
                if task["repeat"] != "none":
                    spawned = self._spawn_next(task)
                    data["tasks"].append(spawned)
            elif task["status"] != "done":
                task["done_at"] = None
            self._save(data)
            return {"task": task, "spawned": spawned}

    def _spawn_next(self, task: dict) -> dict:
        base = date.fromisoformat(task["due"]) if task["due"] else date.today()
        due = next_due(max(base, date.today()) if task["repeat"] != "monthly" else base, task["repeat"])
        shift = (due - base).days * 86400
        now = time.time()
        return {
            **task,
            "id": _new_id(),
            "status": "todo",
            "due": due.isoformat(),
            "remind_at": task["remind_at"] + shift if task["remind_at"] else None,
            "reminded": False,
            "checklist": [{**i, "done": False} for i in task["checklist"]],
            "done_at": None,
            "created_at": now,
            "updated_at": now,
        }

    def delete(self, task_id: str) -> None:
        with self._lock:
            data = self._load()
            self._find(data, task_id)
            data["tasks"] = [t for t in data["tasks"] if t["id"] != task_id]
            self._save(data)

    def clear_done(self, before_days: int = 30) -> int:
        cutoff = time.time() - before_days * 86400
        with self._lock:
            data = self._load()
            keep = [t for t in data["tasks"] if not (t["status"] == "done" and (t["done_at"] or 0) < cutoff)]
            removed = len(data["tasks"]) - len(keep)
            data["tasks"] = keep
            self._save(data)
            return removed

    # ---- reminders ------------------------------------------------------------------------------
    def due_reminders(self, now: float | None = None) -> list[dict]:
        now = now or time.time()
        return [t for t in self.tasks()
                if t.get("remind_at") and t["remind_at"] <= now and not t.get("reminded") and t["status"] != "done"]

    def ack_reminder(self, task_id: str, snooze_minutes: int = 0) -> dict:
        with self._lock:
            data = self._load()
            task = self._find(data, task_id)
            if snooze_minutes > 0:
                task["remind_at"] = time.time() + snooze_minutes * 60
                task["reminded"] = False
            else:
                task["reminded"] = True
            self._save(data)
            return task

    # ---- daily notes ----------------------------------------------------------------------------
    def notes_index(self) -> list[dict]:
        notes = self._load()["notes"]
        return [{"date": d, "chars": len(t)} for d, t in sorted(notes.items(), reverse=True) if t.strip()]

    def get_note(self, day: str) -> str:
        return self._load()["notes"].get(_parse_date(day), "")

    def set_note(self, day: str, text: str) -> None:
        day = _parse_date(day)
        with self._lock:
            data = self._load()
            if text.strip():
                data["notes"][day] = text
            else:
                data["notes"].pop(day, None)
            self._save(data)

    # ---- export ---------------------------------------------------------------------------------
    def export_text(self) -> str:
        data = self._load()
        tasks = data["tasks"]
        open_ = sorted([t for t in tasks if t["status"] != "done"], key=lambda t: (t["due"] or "9999", -PRIORITIES.index(t["priority"])))
        done = sorted([t for t in tasks if t["status"] == "done"], key=lambda t: t["done_at"] or 0, reverse=True)

        def line(t: dict) -> list[str]:
            box = {"todo": "[ ]", "doing": "[~]", "done": "[x]"}[t["status"]]
            bits = [f"{box} {t['title']}"]
            if t["priority"] != "normal":
                bits.append(f"!{t['priority']}")
            if t["due"]:
                bits.append(f"due {t['due']}")
            if t["repeat"] != "none":
                bits.append(f"repeats {t['repeat']}")
            if t.get("remind_at"):
                bits.append("remind " + time.strftime("%Y-%m-%d %H:%M", time.localtime(t["remind_at"])))
            bits += [f"#{x}" for x in t["tags"]]
            out = ["  ".join(bits)]
            out += [f"      {'[x]' if i['done'] else '[ ]'} {i['text']}" for i in t["checklist"]]
            out += [f"      > {n}" for n in t["notes"].splitlines()]
            return out

        lines = [f"# Planner export — {time.strftime('%Y-%m-%d %H:%M')}", "", f"## Open tasks ({len(open_)})", ""]
        for t in open_:
            lines += line(t)
        lines += ["", f"## Done ({len(done)})", ""]
        last_day = None
        for t in done:
            day = time.strftime("%Y-%m-%d", time.localtime(t["done_at"] or 0))
            if day != last_day:
                lines += ["", f"### {day}"]
                last_day = day
            lines += line(t)
        lines += ["", "## Daily notes", ""]
        for day, text in sorted(data["notes"].items(), reverse=True):
            lines += [f"### {day}", text.rstrip(), ""]
        return "\n".join(lines) + "\n"
