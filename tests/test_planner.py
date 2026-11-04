import time
from datetime import date, timedelta

import pytest

from app.services.planner.store import PlannerError, PlannerStore, next_due


@pytest.fixture()
def store(tmp_path):
    return PlannerStore(tmp_path / "planner.json")


def test_add_update_done(store):
    t = store.add({"title": "  Write report ", "tags": "#Work, home,work", "priority": "high"})
    assert t["title"] == "Write report" and t["tags"] == ["work", "home"] and t["status"] == "todo"
    r = store.update(t["id"], {"status": "done"})
    assert r["task"]["done_at"] and r["spawned"] is None
    r = store.update(t["id"], {"status": "todo"})
    assert r["task"]["done_at"] is None


def test_validation(store):
    with pytest.raises(PlannerError):
        store.add({"title": ""})
    with pytest.raises(PlannerError):
        store.add({"title": "x", "due": "tomorrow"})
    with pytest.raises(PlannerError):
        store.add({"title": "x", "priority": "urgent"})
    t = store.add({"title": "x"})
    with pytest.raises(PlannerError):
        store.update(t["id"], {"title": ""})


def test_checklist_cleaning(store):
    t = store.add({"title": "x", "checklist": [{"text": "a"}, {"text": "  "}, {"text": "b", "done": True}]})
    assert [(i["text"], i["done"]) for i in t["checklist"]] == [("a", False), ("b", True)]
    assert all(i["id"] for i in t["checklist"])


def test_repeat_spawns_next(store):
    due = date.today().isoformat()
    t = store.add({"title": "standup", "repeat": "daily", "due": due, "remind_at": time.time() - 10,
                   "checklist": [{"text": "a", "done": True}]})
    r = store.update(t["id"], {"status": "done"})
    nxt = r["spawned"]
    assert nxt["status"] == "todo" and nxt["due"] == (date.today() + timedelta(days=1)).isoformat()
    assert nxt["checklist"][0]["done"] is False and nxt["remind_at"] > t["remind_at"]
    assert len(store.tasks()) == 2


def test_next_due():
    assert next_due(date(2026, 1, 31), "monthly") == date(2026, 2, 28)
    assert next_due(date(2026, 11, 6), "weekdays") == date(2026, 11, 9)  # Friday -> Monday
    assert next_due(date(2026, 11, 4), "weekly") == date(2026, 11, 11)


def test_reminders(store):
    t = store.add({"title": "call", "remind_at": time.time() - 1})
    store.add({"title": "later", "remind_at": time.time() + 3600})
    assert [x["id"] for x in store.due_reminders()] == [t["id"]]
    store.ack_reminder(t["id"], snooze_minutes=10)
    assert store.due_reminders() == []
    assert store.due_reminders(now=time.time() + 601)[0]["id"] == t["id"]
    store.ack_reminder(t["id"])
    assert store.due_reminders(now=time.time() + 10_000) == [x for x in store.due_reminders(now=time.time() + 10_000) if x["title"] == "later"]


def test_notes_and_export(store):
    store.set_note("2026-11-04", "deployed v2")
    store.set_note("2026-11-03", "  ")  # blank removes
    assert store.notes_index() == [{"date": "2026-11-04", "chars": 11}]
    store.add({"title": "open one", "due": "2026-11-05", "checklist": [{"text": "sub"}]})
    t = store.add({"title": "closed one"})
    store.update(t["id"], {"status": "done"})
    text = store.export_text()
    assert "[ ] open one" in text and "[ ] sub" in text and "[x] closed one" in text and "deployed v2" in text


def test_clear_done(store):
    t = store.add({"title": "old"})
    store.update(t["id"], {"status": "done"})
    assert store.clear_done(before_days=30) == 0
    assert store.clear_done(before_days=0) == 1
