import importlib
import subprocess
import time
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from app.core import audit, config, context
from app.core.jobs import JobManager
from app.core.settings_store import SettingsStore
from app.main import create_app
from app.services.home import summary as home
from app.services.planner.store import PlannerStore

planner_router = importlib.import_module("app.services.planner.router")
library_router = importlib.import_module("app.services.library.router")


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(context, "jobs", JobManager(tmp_path / "jobs"))
    monkeypatch.setattr(context, "settings", SettingsStore(tmp_path / "settings"))
    monkeypatch.setattr(planner_router, "store", PlannerStore(tmp_path / "planner.json"))
    monkeypatch.setattr(library_router, "_root", lambda: tmp_path / "lib")  # outside the app and any git repo
    client = TestClient(create_app())  # no lifespan: nothing is created under the real data dir
    yield client
    context.jobs.shutdown(grace=0.5)


def summary(client) -> dict:
    r = client.get("/api/home/summary")
    assert r.status_code == 200
    return r.json()


def test_empty_data_dir(env):
    s = summary(env)
    assert s["date"]["today"] == date.today().isoformat()
    p = s["planner"]
    assert p["overdue"] == p["today"] == p["doing"] == [] and p["next_reminder"] is None and p["timer"] is None
    assert p["done_today"] == p["done_week"] == 0
    assert s["jobs"] == {"running": [], "finished": []}
    assert s["backup"] == {"last": None, "age_days": None, "stale": True}
    assert s["library"]["favourites"] == [] and "does not exist" in s["library"]["hint"]
    assert s["activity"] == {"events": []}


def test_planner_classification(env):
    store = planner_router.store
    today = date.today()
    late = store.add({"title": "late", "due": (today - timedelta(days=2)).isoformat(), "priority": "high",
                      "checklist": [{"text": "a", "done": True}, {"text": "b"}]})
    store.add({"title": "now", "due": today.isoformat()})
    doing = store.add({"title": "wip", "status": "doing"})
    store.add({"title": "later", "due": (today + timedelta(days=3)).isoformat(), "remind_at": time.time() + 600})
    store.add({"title": "soon", "remind_at": time.time() + 60})
    finished = store.add({"title": "fin", "due": today.isoformat()})
    store.update(finished["id"], {"status": "done"})

    p = summary(env)["planner"]
    assert [t["title"] for t in p["overdue"]] == ["late"]
    assert p["overdue"][0]["checklist"] == {"done": 1, "total": 2} and p["overdue"][0]["id"] == late["id"]
    assert [t["title"] for t in p["today"]] == ["now"]
    assert [t["title"] for t in p["doing"]] == ["wip"]
    assert p["next_reminder"]["title"] == "soon"
    assert p["done_today"] == 1 and p["done_week"] == 1
    assert p["timer"] is None

    # timer fields may be written by the planner (not validated by its store yet): read with .get()
    data = store._load()
    for t in data["tasks"]:
        if t["id"] == doing["id"]:
            t.update(timer_started_at=time.time() - 90, time_spent=300)
    store._save(data)
    timer = summary(env)["planner"]["timer"]
    assert timer["id"] == doing["id"] and timer["time_spent"] == 300


def test_backup_fresh_and_stale(env, monkeypatch):
    audit.record("backup", "create", "/backups/eu-1.zip", status="ok")
    b = summary(env)["backup"]
    assert b["last"]["target"] == "/backups/eu-1.zip" and b["stale"] is False and b["age_days"] == 0

    real = time.time
    monkeypatch.setattr(time, "time", lambda: real() + 8 * 86400)
    assert summary(env)["backup"]["stale"] is True


def test_jobs(env):
    context.jobs.start("quick", "true")
    running = context.jobs.start("sleeper", "sleep 5")
    deadline = time.time() + 5
    while not all(j.done for j in context.jobs.list() if j.title == "quick") and time.time() < deadline:
        time.sleep(0.05)
    j = summary(env)["jobs"]
    assert [x["id"] for x in j["running"]] == [running.id]
    assert [x["title"] for x in j["finished"]] == ["quick"] and j["finished"][0]["status"] == "succeeded"
    assert "display" not in j["running"][0]


def test_library_favourites_and_recent(env, tmp_path):
    lib = library_router.Library(tmp_path / "lib")
    a = lib.create("Prod queries", "daily", "sql", "SELECT 1;", {"favorite": True})
    lib.create("", "templ", "sql", "SELECT {{ids}};", {"favorite": True})
    lib.create("", "plain", "md", "x", {})
    lib.touch_use(a["path"])
    lib_s = summary(env)["library"]
    assert lib_s["hint"] is None and lib_s["total"] == 3
    assert [i["name"] for i in lib_s["favourites"]] == ["daily", "templ"]
    assert lib_s["favourites"][0]["content"] == "SELECT 1;"
    assert [i["path"] for i in lib_s["recent"]] == [a["path"]]
    assert lib_s["warning"] is None


def test_library_in_git_repo_warns(env, tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    monkeypatch.setattr(library_router, "_root", lambda: repo / "lib")
    item = library_router.Library(repo / "lib").create("sql", "q", "sql", "select 1;", {"favorite": True})
    lib_s = summary(env)["library"]
    assert [i["path"] for i in lib_s["favourites"]] == [item["path"]]
    assert "not ignored" in lib_s["warning"] and str(repo) in lib_s["warning"]
    # the usage ping Home would send is refused in this state, which is why Home skips it
    r = env.post("/api/library/items/use", json={"path": item["path"]}, headers={"x-everyday-utility": "1"})
    assert r.status_code == 409


def test_activity_and_broken_section(env, monkeypatch):
    audit.record("job", "start", "Batched predictions", env="local")

    def boom():
        raise RuntimeError("planner file is corrupt")

    monkeypatch.setattr(home, "planner_section", boom)
    s = summary(env)
    assert s["planner"] == {"error": "RuntimeError: planner file is corrupt"}
    assert s["activity"]["events"][0]["target"] == "Batched predictions"
    assert "running" in s["jobs"] and "stale" in s["backup"]
