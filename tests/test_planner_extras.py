import importlib
import json
import time
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from app.services.planner import store as store_mod
from app.services.planner.store import PlannerError, PlannerStore

H = {"x-everyday-utility": "1"}


class Clock:
    def __init__(self, t: float):
        self.t = t

    def __call__(self) -> float:
        return self.t


@pytest.fixture()
def clock(monkeypatch):
    c = Clock(time.time())
    monkeypatch.setattr(store_mod.time, "time", c)
    return c


@pytest.fixture()
def store(tmp_path):
    return PlannerStore(tmp_path / "planner.json")


@pytest.fixture()
def client(tmp_path, monkeypatch):
    from app.core import config, context
    from app.core.jobs import JobManager
    from app.core.settings_store import SettingsStore
    router = importlib.import_module("app.services.planner.router")  # the package re-exports the APIRouter as `router`

    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(context, "jobs", JobManager(tmp_path / "jobs"))
    monkeypatch.setattr(context, "settings", SettingsStore(tmp_path / "settings"))
    monkeypatch.setattr(router, "store", PlannerStore(tmp_path / "planner" / "planner.json"))
    from app.main import app

    with TestClient(app) as c:
        yield c


def test_single_running_timer(store, clock):
    a = store.add({"title": "a"})
    b = store.add({"title": "b"})
    store.timer(a["id"], "start")
    clock.t += 60
    started_b = store.timer(b["id"], "start")
    running = [t for t in store.tasks() if t["timer_started_at"]]
    assert [t["id"] for t in running] == [b["id"]] and started_b["status"] == "doing"
    assert next(t for t in store.tasks() if t["id"] == a["id"])["time_spent"] == pytest.approx(60)
    assert store.running()["id"] == b["id"]
    store.timer(b["id"], "stop")
    assert store.running() is None
    with pytest.raises(PlannerError):
        store.timer(a["id"], "pause")


def test_elapsed_accumulates(store, clock):
    t = store.add({"title": "x"})
    store.timer(t["id"], "start")
    clock.t += 90
    store.timer(t["id"], "start")  # already running: keeps the original start
    clock.t += 30
    assert store.timer(t["id"], "stop")["time_spent"] == pytest.approx(120)
    store.timer(t["id"], "start")
    clock.t += 600
    # back-dated stop (Pomodoro interval ended earlier)
    assert store.timer(t["id"], "stop", at=clock.t - 300)["time_spent"] == pytest.approx(420)


def test_done_stops_timer(store, clock):
    t = store.add({"title": "x", "repeat": "daily", "due": date.today().isoformat()})
    store.timer(t["id"], "start")
    clock.t += 45
    r = store.update(t["id"], {"status": "done"})
    assert r["task"]["timer_started_at"] is None and r["task"]["time_spent"] == pytest.approx(45)
    assert r["spawned"]["time_spent"] == 0 and r["spawned"]["timer_started_at"] is None
    with pytest.raises(PlannerError):
        store.timer(t["id"], "start")


def test_postponed_counter(store):
    t = store.add({"title": "x", "due": "2026-11-04"})
    store.update(t["id"], {"due": "2026-11-05"})
    store.update(t["id"], {"due": "2026-11-03"})  # earlier: not a postpone
    store.update(t["id"], {"title": "renamed"})
    assert store.update(t["id"], {"due": "2026-11-10"})["task"]["postponed"] == 2
    u = store.add({"title": "undated"})
    assert store.update(u["id"], {"due": "2026-12-01"})["task"]["postponed"] == 0


def test_old_data_loads(tmp_path):
    p = tmp_path / "planner.json"
    p.write_text(json.dumps({"tasks": [{
        "id": "old1", "title": "legacy", "notes": "", "status": "todo", "priority": "normal", "due": "2026-01-01",
        "remind_at": None, "reminded": False, "tags": [], "checklist": [], "repeat": "none", "done_at": None,
        "created_at": 1.0, "updated_at": 1.0}], "notes": {}}))
    s = PlannerStore(p)
    t = s.tasks()[0]
    assert (t["time_spent"], t["timer_started_at"], t["postponed"]) == (0.0, None, 0)
    assert s.update("old1", {"due": "2026-01-02"})["task"]["postponed"] == 1
    assert s.timer("old1", "start")["timer_started_at"]
    assert "legacy" in s.export_text() and s.review()["slipped"][0]["id"] == "old1"


def test_export_includes_time(store, clock):
    t = store.add({"title": "timed"})
    store.add({"title": "untimed"})
    store.timer(t["id"], "start")
    clock.t += 3900
    store.timer(t["id"], "stop")
    text = store.export_text()
    assert "[~] timed  time 1h 05m" in text
    assert "untimed  time" not in text


def test_review_numbers(store, clock):
    now = clock.t
    today = date.fromtimestamp(now)
    a = store.add({"title": "a", "tags": "ops"})
    b = store.add({"title": "b", "tags": "ops, home"})
    store.add({"title": "c"})
    late = store.add({"title": "late", "due": (today - timedelta(days=2)).isoformat()})
    slipped = store.add({"title": "slipped", "due": today.isoformat()})
    store.update(slipped["id"], {"due": (today + timedelta(days=1)).isoformat()})
    store.timer(a["id"], "start")
    clock.t += 600
    store.update(a["id"], {"status": "done"})
    clock.t += 1
    store.update(b["id"], {"status": "done"})
    store.timer(late["id"], "start")
    clock.t += 120  # still running: counted live

    r = store.review(days=7)
    assert len(r["days"]) == 7 and r["days"][-1] == {"date": today.isoformat(), "done": 2}
    assert r["done_count"] == 2 and r["created_count"] == 5
    assert r["time_total"] == pytest.approx(720)
    tags = {x["tag"]: x["seconds"] for x in r["time_by_tag"]}
    assert tags == {"ops": pytest.approx(600), "(untagged)": pytest.approx(120)}
    assert r["top_tags"][0] == {"tag": "ops", "count": 2}
    assert [x["title"] for x in r["done"][0]["tasks"]] == ["b", "a"]
    assert [x["title"] for x in r["slipped"]] == ["late", "slipped"]
    # a timezone far ahead of UTC can put "now" on the next local day
    assert len(store.review(days=1, tz_offset=-14 * 60)["days"]) == 1


def test_endpoints(client):
    a = client.post("/api/planner/tasks", json={"title": "a"}, headers=H).json()
    b = client.post("/api/planner/tasks", json={"title": "b"}, headers=H).json()
    assert client.get("/api/planner/timer").json() is None
    client.post(f"/api/planner/tasks/{a['id']}/timer", json={"action": "start"}, headers=H)
    client.post(f"/api/planner/tasks/{b['id']}/timer", json={"action": "start"}, headers=H)
    assert client.get("/api/planner/timer").json()["id"] == b["id"]
    assert client.post(f"/api/planner/tasks/{b['id']}/timer", json={"action": "go"}, headers=H).status_code == 422
    assert client.post("/api/planner/tasks/nope/timer", json={"action": "stop"}, headers=H).status_code == 400
    r = client.get("/api/planner/review", params={"days": 7, "tz": -330}).json()
    assert r["created_count"] == 2 and len(r["days"]) == 7
    assert client.get("/api/planner/review", params={"days": 0}).status_code == 422


def test_timer_endpoint_reflects_stops_made_elsewhere(client):
    # pomoTick asks GET /timer before ending a work interval, so a timer stopped or completed from Home or a
    # reminder toast must read back as "not running" for that task
    a = client.post("/api/planner/tasks", json={"title": "a"}, headers=H).json()
    timer = f"/api/planner/tasks/{a['id']}/timer"
    client.post(timer, json={"action": "start"}, headers=H)
    client.post(timer, json={"action": "stop"}, headers=H)
    assert client.get("/api/planner/timer").json() is None
    client.post(timer, json={"action": "start"}, headers=H)
    client.patch(f"/api/planner/tasks/{a['id']}", json={"status": "done"}, headers=H)
    assert client.get("/api/planner/timer").json() is None
    assert client.post(timer, json={"action": "start"}, headers=H).status_code == 400


def test_backdated_stop_keeps_interval_length(store, clock):
    # the page stops at start + the interval's own length; a later or future `at` never adds untracked time
    t = store.add({"title": "x"})
    t0 = clock.t
    store.timer(t["id"], "start")
    clock.t += 40 * 60
    assert store.timer(t["id"], "stop", at=t0 + 25 * 60)["time_spent"] == pytest.approx(25 * 60)
    store.timer(t["id"], "start")
    clock.t += 60
    assert store.timer(t["id"], "stop", at=clock.t + 999)["time_spent"] == pytest.approx(26 * 60)
