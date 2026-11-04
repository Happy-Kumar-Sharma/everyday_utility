"""Home wellbeing cards: screen time sampling / heartbeat, water, standup reminder + summary, settings, audit."""

import importlib
import json
import subprocess
import time
from datetime import date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.core import audit, config, context
from app.core.settings_store import SettingsStore
from app.main import create_app
from app.services.home import wellbeing as wb
from app.services.planner.store import PlannerStore

planner_router = importlib.import_module("app.services.planner.router")
H = {"x-everyday-utility": "1"}

MON = date(2026, 11, 2)  # a Monday
FRI = MON - timedelta(days=3)
SAT = MON + timedelta(days=5)


def at(d: date, hh: int, mm: int = 0, ss: int = 0) -> float:
    return datetime(d.year, d.month, d.day, hh, mm, ss).timestamp()


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(context, "settings", SettingsStore(tmp_path / "settings"))
    monkeypatch.setattr(planner_router, "store", PlannerStore(tmp_path / "planner.json"))
    monkeypatch.setattr(wb, "_state", {"gnome_ok_at": 0.0})
    client = TestClient(create_app())  # no lifespan: the sampler thread is not started
    yield client
    wb.stop_sampler()


def values(**overrides) -> dict:
    return wb.validate({**wb.DEFAULTS, **overrides})[0]


# ---- screen time ------------------------------------------------------------------------------------
def test_sampling_with_fake_idle_source(env):
    v = values(screen_idle_seconds=120)
    t = at(MON, 9, 0, 5)
    assert wb.sample(lambda: (5_000, False), now=t, values=v) == {"source": "gnome", "active": True}
    assert wb.sample(lambda: (6_000, False), now=t + 30, values=v)["active"] is True   # same minute: still 1
    assert wb.sample(lambda: (200_000, False), now=t + 60, values=v)["active"] is False  # idle 200 s > 120 s
    assert wb.sample(lambda: (1_000, True), now=t + 120, values=v)["active"] is False   # locked screen
    assert wb.sample(lambda: (1_000, None), now=t + 180, values=v)["active"] is True    # lock state unknown
    assert wb.load_minutes(MON) == {9 * 60, 9 * 60 + 3}
    stored = json.loads((config.DATA_DIR / "home" / "screen" / f"{MON.isoformat()}.json").read_text())
    assert stored == {"minutes": [540, 543]}  # minutes only, nothing else
    # the idle monitor not answering marks nothing and does not claim GNOME
    wb._state["gnome_ok_at"] = 0.0
    assert wb.sample(lambda: (None, None), now=t + 240, values=v) == {"source": "browser", "active": None}
    assert wb.screen_payload(t + 240, v)["today_minutes"] == 2


def test_writes_only_new_minutes(env, monkeypatch):
    t = at(MON, 14, 10)
    assert wb.mark_active(t) is True
    writes = []
    monkeypatch.setattr(wb, "_write_json", lambda *a: writes.append(a))
    assert wb.mark_active(t + 20) is False and writes == []


def test_heartbeat_ignored_while_gnome_is_the_source(env):
    r = env.post("/api/home/screen/heartbeat", headers=H)
    assert r.status_code == 200 and r.json() == {"accepted": True, "source": "browser"}
    now = time.time()
    assert wb.load_minutes(datetime.fromtimestamp(now).date())  # counted

    wb.sample(lambda: (500, False), now=time.time(), values=values())
    assert env.post("/api/home/screen/heartbeat", headers=H).json() == {"accepted": False, "source": "gnome"}
    assert env.get("/api/home/wellbeing").json()["screen"]["source"] == "gnome"

    # GNOME stopped answering long enough ago: the browser fallback counts again
    t = at(MON, 11, 0)
    wb._state["gnome_ok_at"] = t - wb.GNOME_FRESH_SECONDS - 1
    assert wb.heartbeat(now=t)["accepted"] is True and 660 in wb.load_minutes(MON)
    assert env.post("/api/home/screen/heartbeat").status_code == 403  # CSRF header still required


def test_hourly_streak_and_yesterday_across_midnight(env):
    sun = MON - timedelta(days=1)
    wb._write_json(wb._screen_path(sun), {"minutes": list(range(23 * 60 + 30, 1440))})  # 23:30–23:59
    wb._write_json(wb._screen_path(MON), {"minutes": list(range(0, 21))})               # 00:00–00:20
    wb._write_json(wb._screen_path(MON - timedelta(days=6)), {"minutes": [1, 2, 3]})
    s = wb.screen_payload(at(MON, 0, 21, 30), values())
    assert s["today_minutes"] == 21 and s["yesterday_minutes"] == 30
    assert s["hourly"][0] == 21 and sum(s["hourly"]) == 21 and len(s["hourly"]) == 24
    assert s["first_active"] == "00:00" and s["last_active"] == "00:20"
    assert s["current_streak_minutes"] == 51  # 23:30 yesterday → 00:20 today
    assert s["current_streak_start"] == at(sun, 23, 30)
    assert [w["date"] for w in s["week"]] == [(MON - timedelta(days=i)).isoformat() for i in range(6, -1, -1)]
    assert [w["minutes"] for w in s["week"]] == [3, 0, 0, 0, 0, 30, 21]

    # 3 minutes since the last active one: the session is over
    assert wb.screen_payload(at(MON, 0, 23), values())["current_streak_minutes"] == 0
    assert wb.screen_payload(at(MON, 0, 23), values())["current_streak_start"] is None


def test_streak_gap_rules(env):
    # 10:00–10:09, one missing minute (10:10), 10:11–10:19 → one session; then a 2-minute hole before 10:23
    minutes = [*range(600, 610), *range(611, 620)]
    wb._write_json(wb._screen_path(MON), {"minutes": minutes})
    assert wb.screen_payload(at(MON, 10, 20), values())["current_streak_minutes"] == 20
    wb._write_json(wb._screen_path(MON), {"minutes": [*minutes, 622, 623]})
    s = wb.screen_payload(at(MON, 10, 23), values())
    assert s["current_streak_minutes"] == 2 and s["current_streak_start"] == at(MON, 10, 22)
    # minutes after "now" (clock skew) are ignored for the streak
    assert wb.screen_payload(at(MON, 9, 0), values())["current_streak_minutes"] == 0


# ---- water ---------------------------------------------------------------------------------------
def test_water_plus_minus_floors_at_zero_and_history(env):
    r = env.post("/api/home/water", json={"delta": -1}, headers=H)
    assert r.status_code == 200 and r.json()["water"]["count"] == 0
    assert not (config.DATA_DIR / "home" / "water.json").exists()  # nothing to undo: nothing written
    for _ in range(3):
        w = env.post("/api/home/water", json={"delta": 1}, headers=H).json()["water"]
    assert w["count"] == 3 and w["ml"] == 750 and w["goal"] == 8 and w["goal_ml"] == 2000 and w["last_at"]
    w = env.post("/api/home/water", json={"delta": -1}, headers=H).json()["water"]
    assert w["count"] == 2 and w["history"][-1] == {"date": date.today().isoformat(), "count": 2}
    assert env.post("/api/home/water", json={"delta": 5}, headers=H).status_code == 422

    # -1 removes today's latest glass only; earlier days are history
    t = at(MON, 12)
    wb.water_change(1, now=t - 86400)
    wb.water_change(1, now=t - 3600)
    wb.water_change(1, now=t - 60)
    assert wb.water_change(-1, now=t) == 1
    p = wb.water_payload(t, values())
    assert p["count"] == 1 and p["last_at"] == t - 3600
    assert [h["count"] for h in p["history"]][-2:] == [1, 1] and len(p["history"]) == 7
    assert wb.water_change(-1, now=t) == 0 and wb.water_change(-1, now=t) == 0


def test_water_reminder_timing(env):
    v = values(work_start="09:30", work_end="19:00", water_remind_minutes=60, water_goal=8)
    nxt = wb.water_next_reminder
    assert nxt(at(MON, 8), 0, None, v) == at(MON, 10, 30)          # an hour into the work day
    assert nxt(at(MON, 12), 2, at(MON, 11, 15), v) == at(MON, 12, 15)
    assert nxt(at(MON, 12), 1, at(MON, 8), v) == at(MON, 10, 30)    # before-work glass: counted from 09:30
    assert nxt(at(MON, 18, 30), 3, at(MON, 18, 20), v) == at(MON + timedelta(days=1), 10, 30)  # past 19:00
    assert nxt(at(MON, 20), 3, at(MON, 12), v) == at(MON + timedelta(days=1), 10, 30)          # after work
    assert nxt(at(MON, 12), 8, at(MON, 11), v) == at(MON + timedelta(days=1), 10, 30)          # goal reached
    assert nxt(at(MON, 12), 0, None, values(water_remind_minutes=0)) is None

    def due(now):
        return wb.water_payload(now, v)["due_now"]

    assert due(at(MON, 10, 29)) is False and due(at(MON, 10, 31)) is True
    assert due(at(MON, 8)) is False and due(at(MON, 19, 30)) is False   # outside work hours
    assert due(at(SAT, 11)) is True                                     # any day
    wb.water_change(1, now=at(MON, 10, 40))
    assert due(at(MON, 11, 0)) is False and due(at(MON, 11, 41)) is True


# ---- standup ---------------------------------------------------------------------------------------
def test_previous_working_day():
    weekdays = wb.parse_days("mon,tue,wed,thu,fri")
    assert wb.previous_working_day(MON, weekdays) == FRI
    assert wb.previous_working_day(MON + timedelta(days=2), weekdays) == MON + timedelta(days=1)
    assert wb.previous_working_day(SAT, weekdays) == SAT - timedelta(days=1)
    mon_wed = wb.parse_days("Mon, wednesday")
    assert mon_wed == [0, 2]
    assert wb.previous_working_day(MON + timedelta(days=2), mon_wed) == MON
    assert wb.previous_working_day(MON, mon_wed) == MON - timedelta(days=5)


def test_standup_due_now_across_days_times_snooze_and_done(env):
    v = values(standup_time="10:30", standup_days="mon,tue,wed,thu,fri")
    s = wb.standup_state(at(MON, 10), v)
    assert s["due_now"] is False and s["next_at"] == at(MON, 10, 30) and s["status_today"] is None
    s = wb.standup_state(at(MON, 10, 31), v)
    assert s["due_now"] is True and s["next_at"] == at(MON, 10, 30)
    s = wb.standup_state(at(SAT, 11), v)  # weekend: not a standup day
    assert s["due_now"] is False and s["is_standup_day"] is False and s["next_at"] == at(MON + timedelta(days=7), 10, 30)
    assert wb.standup_state(at(MON, 10, 31), values(standup_enabled=False))["due_now"] is False

    wb.standup_action("snooze", 10, now=at(MON, 10, 31))
    s = wb.standup_state(at(MON, 10, 35), v)
    assert s["due_now"] is False and s["next_at"] == at(MON, 10, 41) and s["snooze_until"] == at(MON, 10, 41)
    assert wb.standup_state(at(MON, 10, 42), v)["due_now"] is True

    wb.standup_action("done", now=at(MON, 10, 45))
    s = wb.standup_state(at(MON, 11), v)
    assert s["due_now"] is False and s["status_today"] == "done" and s["next_at"] == at(MON + timedelta(days=1), 10, 30)
    s = wb.standup_state(at(MON + timedelta(days=1), 10, 31), v)  # a new day: due again
    assert s["due_now"] is True and s["status_today"] is None

    wb.standup_action("skip", now=at(MON + timedelta(days=1), 10, 32))
    assert wb.standup_state(at(MON + timedelta(days=1), 12), v)["status_today"] == "skipped"
    with pytest.raises(ValueError):
        wb.standup_action("dance", now=at(MON, 12))


def test_standup_summary_from_planner(env):
    store = planner_router.store
    mon_iso = MON.isoformat()
    shipped = store.add({"title": "Ship release", "status": "done", "priority": "high"})
    weekend = store.add({"title": "Weekend fix", "status": "done"})
    old = store.add({"title": "Old thing", "status": "done"})
    store.add({"title": "Write docs", "status": "doing"})
    store.add({"title": "Review PR", "due": mon_iso, "priority": "high"})
    store.add({"title": "Late a bit", "due": (MON - timedelta(days=1)).isoformat()})
    store.add({"title": "Very late", "due": (MON - timedelta(days=3)).isoformat(), "priority": "low"})
    pushed = store.add({"title": "Pushed around", "due": (MON + timedelta(days=1)).isoformat()})
    store.update(pushed["id"], {"due": (MON + timedelta(days=3)).isoformat()})
    data = store._load()
    done_at = {shipped["id"]: at(FRI, 16), weekend["id"]: at(SAT - timedelta(days=7), 12), old["id"]: at(FRI - timedelta(days=1), 16)}
    for t in data["tasks"]:
        t["done_at"] = done_at.get(t["id"], t.get("done_at"))
    store._save(data)
    audit.record("job", "finish", "Batched predictions", status="failed")
    audit.record("job", "finish", "Fine job", status="succeeded")

    v = values()
    s = wb.standup_summary(at(MON, 10), v)
    assert s["previous_day"] == FRI.isoformat()
    assert [i["title"] for i in s["yesterday"]] == ["Ship release", "Weekend fix"]
    assert [i["title"] for i in s["today"]] == ["Write docs", "Review PR", "Late a bit", "Very late"]
    assert [i["note"] for i in s["today"]] == ["in progress", "due today", "overdue 1 d", "overdue 3 d"]
    assert [i["title"] for i in s["blockers"]] == ["Pushed around", "Very late", "Job failed: Batched predictions"]
    text = s["text"]
    assert text.startswith("**Yesterday (Fri 30 Oct)**\n- [high] Ship release\n- Weekend fix")
    assert "**Today**\n- Write docs\n- [high] Review PR\n- Late a bit\n- [low] Very late" in text
    assert "- Job failed: Batched predictions" in text and "Fine job" not in text and "Old thing" not in text

    # empty planner: every section says —
    planner_router.store = PlannerStore(config.DATA_DIR / "empty.json")
    empty = wb.standup_summary(at(MON + timedelta(days=1), 10), v)["text"]
    assert empty.count("- —") == 2 and "Job failed" in empty  # the failed job is still since Monday


def test_wellbeing_endpoint_and_standup_actions(env):
    r = env.get("/api/home/wellbeing")
    assert r.status_code == 200
    d = r.json()
    assert set(d) >= {"now", "today", "errors", "screen", "water", "standup"} and d["errors"] == []
    assert set(d["screen"]) >= {"source", "today_minutes", "hourly", "first_active", "last_active",
                                "current_streak_minutes", "yesterday_minutes", "week"}
    assert set(d["water"]) >= {"count", "goal", "ml", "goal_ml", "last_at", "history", "next_reminder_at"}
    assert set(d["standup"]) >= {"enabled", "time", "days", "due_now", "status_today", "next_at", "summary"}
    assert "text" in d["standup"]["summary"]

    d = env.post("/api/home/standup", json={"action": "done"}, headers=H).json()
    assert d["standup"]["status_today"] == "done" and d["standup"]["due_now"] is False
    assert env.post("/api/home/standup", json={"action": "snooze", "minutes": 9999}, headers=H).status_code == 422
    assert env.post("/api/home/standup", json={"action": "nope"}, headers=H).status_code == 422
    # the existing summary endpoint is untouched
    assert env.get("/api/home/summary").json()["date"]["today"] == date.today().isoformat()


def test_broken_section_is_isolated(env, monkeypatch):
    def boom(*_):
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(wb, "water_payload", boom)
    d = env.get("/api/home/wellbeing").json()
    assert d["water"] == {"error": "RuntimeError: disk on fire"} and "today_minutes" in d["screen"]


def test_audit_records_no_content(env):
    store = planner_router.store
    store.add({"title": "Secret project codename", "status": "doing"})
    env.post("/api/home/standup", json={"action": "done"}, headers=H)
    env.post("/api/home/standup", json={"action": "skip"}, headers=H)
    env.post("/api/home/standup", json={"action": "snooze", "minutes": 5}, headers=H)
    events = audit.recent(10, kind="home")
    assert [e["action"] for e in events] == ["standup-skip", "standup-done"]  # snooze is not audited
    assert all(e["target"] == date.today().isoformat() and e["detail"] == {} for e in events)
    assert "Secret" not in (config.DATA_DIR / "audit" / "audit.jsonl").read_text()


# ---- settings ------------------------------------------------------------------------------------
def test_settings_declared_on_home_service(env):
    services = {s["id"]: s for s in env.get("/api/services").json()}
    home = services["home"]
    assert home["background"] is True
    groups = {f["key"]: f["group"] for f in home["settings"]}
    assert groups["screen_idle_seconds"] == groups["screen_break_minutes"] == "Screen time"
    assert groups["water_goal"] == groups["work_start"] == "Water"
    assert groups["standup_time"] == groups["standup_days"] == groups["standup_enabled"] == "Standup"
    assert {f["key"]: f["default"] for f in home["settings"]}["screen_idle_seconds"] == 120


def test_settings_validation(env):
    v, errors = wb.validate({"work_start": "25:00", "work_end": "7:5", "standup_time": "9:05", "standup_days": "mon,funday",
                             "water_goal": 0, "screen_idle_seconds": "abc", "glass_ml": 330, "screen_break_minutes": 0})
    assert v["work_start"] == "09:30" and v["work_end"] == "19:00" and v["standup_time"] == "09:05"
    assert v["standup_days"] == "mon,tue,wed,thu,fri" and v["standup_days_list"] == [0, 1, 2, 3, 4]
    assert v["water_goal"] == 8 and v["screen_idle_seconds"] == 120 and v["glass_ml"] == 330 and v["screen_break_minutes"] == 0
    joined = " ".join(errors)
    for label in ("Work day starts", "Work day ends", "Standup days", "Daily goal", "Idle after"):
        assert label in joined
    assert "Glass size" not in joined and "Standup time" not in joined

    v, errors = wb.validate({"work_start": "18:00", "work_end": "08:00"})
    assert (v["work_start"], v["work_end"]) == ("18:00", "19:00") and len(errors) == 1
    assert wb.validate({"standup_days": "Sat, sunday"})[0]["standup_days"] == "sat,sun"

    # saved through the generic settings API: bad values fall back and are reported, good ones apply
    r = env.put("/api/services/home/settings", json={"work_start": "nine", "water_goal": 3, "glass_ml": 500}, headers=H)
    assert r.status_code == 200
    d = env.get("/api/home/wellbeing").json()
    assert d["water"]["goal"] == 3 and d["water"]["goal_ml"] == 1500 and d["water"]["work_start"] == "09:30"
    assert any("Work day starts" in e for e in d["errors"])
    assert env.put("/api/services/home/settings", json={"water_goal": "lots"}, headers=H).status_code == 400


# ---- GNOME source + sampler lifecycle -------------------------------------------------------------
def test_gnome_idle_parsing(monkeypatch):
    calls = []

    def fake_run(cmd, **kw):
        calls.append(kw)
        method = cmd[-1]
        if method.endswith("GetIdletime"):
            return subprocess.CompletedProcess(cmd, 0, "(uint64 656,)\n", "")
        if fail_lock:
            raise subprocess.CalledProcessError(1, cmd)
        return subprocess.CompletedProcess(cmd, 0, "(true,)\n", "")

    monkeypatch.setattr(subprocess, "run", fake_run)
    fail_lock = False
    assert wb.gnome_idle() == (656, True)
    assert all(kw["timeout"] == wb.COMMAND_TIMEOUT for kw in calls)
    fail_lock = True
    assert wb.gnome_idle() == (656, None)

    def broken(cmd, **kw):
        raise subprocess.TimeoutExpired(cmd, 2)

    monkeypatch.setattr(subprocess, "run", broken)
    assert wb.gnome_idle() == (None, None)


def test_sampler_lifecycle(env, monkeypatch):
    monkeypatch.delenv("EU_ENABLE_SAMPLER", raising=False)
    assert wb.sampler_allowed() is False and wb.start_sampler() is False  # never under pytest by default
    monkeypatch.setenv("EU_ENABLE_SAMPLER", "1")
    monkeypatch.setattr(wb, "gnome_idle", lambda: (1_000, False))
    assert wb.start_sampler() is True
    assert wb.start_sampler() is False  # idempotent
    today = date.today()
    deadline = time.time() + 5
    while not wb.load_minutes(today) and time.time() < deadline:
        time.sleep(0.05)
    assert wb.load_minutes(today) and wb.sampler_running()
    wb.stop_sampler()
    wb.stop_sampler()  # idempotent
    assert not wb.sampler_running()
    monkeypatch.setenv("EU_DISABLE_SAMPLER", "1")
    monkeypatch.delenv("EU_ENABLE_SAMPLER")
    assert wb.start_sampler() is False
