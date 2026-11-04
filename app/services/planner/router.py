from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

from app.core import config

from .store import PlannerError, PlannerStore

SERVICE_ID = "planner"

router = APIRouter()
store = PlannerStore(config.DATA_DIR / SERVICE_ID / "planner.json")


def _call(fn, *args):
    try:
        return fn(*args)
    except PlannerError as e:
        raise HTTPException(400, str(e)) from e


class Snooze(BaseModel):
    minutes: int = Field(0, ge=0, le=7 * 24 * 60)


class Note(BaseModel):
    text: str = ""


class ClearDone(BaseModel):
    older_than_days: int = Field(30, ge=0)


@router.get("/tasks")
def list_tasks():
    return store.tasks()


# task bodies are free-form patches validated by the store (only known keys are applied)
@router.post("/tasks")
def add_task(task: dict):
    return _call(store.add, task)


@router.patch("/tasks/{task_id}")
def update_task(task_id: str, patch: dict):
    return _call(store.update, task_id, patch)


@router.delete("/tasks/{task_id}")
def delete_task(task_id: str):
    _call(store.delete, task_id)
    return {"ok": True}


@router.post("/tasks/clear-done")
def clear_done(req: ClearDone):
    return {"removed": store.clear_done(req.older_than_days)}


@router.get("/reminders/due")
def due_reminders():
    return store.due_reminders()


@router.post("/reminders/{task_id}/ack")
def ack_reminder(task_id: str, req: Snooze):
    return _call(store.ack_reminder, task_id, req.minutes)


@router.get("/notes")
def notes_index():
    return store.notes_index()


@router.get("/notes/{day}")
def get_note(day: str):
    return {"date": day, "text": _call(store.get_note, day)}


@router.put("/notes/{day}")
def set_note(day: str, note: Note):
    _call(store.set_note, day, note.text)
    return {"ok": True}


@router.post("/export")
def export():
    return PlainTextResponse(store.export_text(), headers={"Content-Disposition": 'attachment; filename="planner_export.txt"'})
