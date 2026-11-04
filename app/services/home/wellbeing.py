"""Home wellbeing cards: screen time today, water, and the daily standup reminder.

Storage (all under config.DATA_DIR/home, read at call time so tests can redirect it):
    screen/<YYYY-MM-DD>.json  {"minutes": [active minute-of-day indexes]} — minutes only, nothing about what was on screen
    water.json                {"YYYY-MM-DD": [epoch of each glass]}
    standup.json              {"YYYY-MM-DD": {"status": "done"|"skipped", "at": epoch}, "snooze_until": epoch|null}

Screen time comes from GNOME's idle monitor (sampled by a background thread every 30 s) when that works, otherwise
from browser heartbeats sent while a tab of the app is visible and in use. Only one source counts at a time, and the
minute sets dedupe, so nothing is double-counted.

Every function takes an optional `now` (epoch) so the day / hour maths can be tested around midnight.
"""

from __future__ import annotations

import importlib
import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from datetime import date, datetime, timedelta
from datetime import time as dtime
from pathlib import Path

from app.core import audit, config, context
from app.core.registry import SettingField

log = logging.getLogger(__name__)

SERVICE_ID = "home"
SAMPLE_SECONDS = 30
NO_GDBUS_RETRY_SECONDS = 300   # gdbus isn't installed: don't spawn a failing process every 30 s
GNOME_FRESH_SECONDS = 120      # the GNOME source counts as live while it answered this recently
STREAK_MAX_DIFF = 2            # active minutes 2 apart (one missing minute) still belong to one session
COMMAND_TIMEOUT = 2
HISTORY_DAYS = 7
KEEP_DAYS = 400                # water / standup entries older than this are pruned on write
DAY_NAMES = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
TIME_RE = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")
PRIO_RANK = {"high": 0, "normal": 1, "low": 2}

SETTINGS = (
    SettingField("screen_idle_seconds", "Idle after (seconds)", 120, "int",
                 "A minute counts as screen time when there was input within this many seconds and the screen "
                 "isn't locked (30–3600).", "Screen time"),
    SettingField("screen_break_minutes", "Break nudge after (minutes)", 50, "int",
                 "Suggest a short break after this long at the screen without one. 0 = no break nudges.", "Screen time"),
    SettingField("water_goal", "Daily goal (glasses)", 8, "int", "1–40 glasses.", "Water"),
    SettingField("glass_ml", "Glass size (ml)", 250, "int", "50–2000 ml.", "Water"),
    SettingField("water_remind_minutes", "Remind every (minutes)", 60, "int",
                 "During work hours, while under the goal. 0 = no water reminders.", "Water"),
    SettingField("work_start", "Work day starts", "09:30", "text", "HH:MM, 24-hour.", "Water"),
    SettingField("work_end", "Work day ends", "19:00", "text", "HH:MM, 24-hour, after the start.", "Water"),
    SettingField("standup_enabled", "Standup reminder", True, "bool", "Pop a reminder at standup time.", "Standup"),
    SettingField("standup_time", "Standup time", "10:30", "text", "HH:MM, 24-hour.", "Standup"),
    SettingField("standup_days", "Standup days", "mon,tue,wed,thu,fri", "text",
                 "Comma-separated: mon,tue,wed,thu,fri,sat,sun. “Yesterday” in the summary is the previous one of "
                 "these days (Monday → Friday).", "Standup"),
)
DEFAULTS = {f.key: f.default for f in SETTINGS}
LABELS = {f.key: f.label for f in SETTINGS}
INT_BOUNDS = {"screen_idle_seconds": (30, 3600), "screen_break_minutes": (0, 600), "water_goal": (1, 40),
              "glass_ml": (50, 2000), "water_remind_minutes": (0, 600)}

_lock = threading.RLock()  # guards every read-modify-write of the files above
# in-memory source state: when GNOME last answered (0 = never in this process)
_state = {"gnome_ok_at": 0.0}


# ---- helpers ---------------------------------------------------------------------------------------
def _home_dir() -> Path:
    return config.DATA_DIR / "home"


def _local(now: float) -> datetime:
    return datetime.fromtimestamp(now)


def _at(d: date, hhmm: str) -> float:
    h, m = (int(x) for x in hhmm.split(":"))
    return datetime.combine(d, dtime(h, m)).timestamp()


def _midnight(d: date) -> float:
    return datetime.combine(d, dtime()).timestamp()


def _hhmm(minute: int) -> str:
    return f"{minute // 60:02d}:{minute % 60:02d}"


def _read_json(path: Path, default):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default
    except (OSError, ValueError):
        log.warning("unreadable %s, starting from empty", path)
        return default
    return data if isinstance(data, type(default)) else default


def _write_json(path: Path, data) -> None:
    """Atomic: a crash mid-write leaves the previous file, never a half-written one."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, path)


def _prune(data: dict, today: date) -> None:
    cutoff = (today - timedelta(days=KEEP_DAYS)).isoformat()
    for key in [k for k in data if re.fullmatch(r"\d{4}-\d{2}-\d{2}", k) and k < cutoff]:
        del data[key]


# ---- settings --------------------------------------------------------------------------------------
def raw_settings() -> dict:
    if SERVICE_ID in context.services:
        return context.service_settings(SERVICE_ID)
    return dict(DEFAULTS)  # module used on its own (tests, scripts)


def parse_days(value) -> list[int] | None:
    """'mon, Tue,friday' -> [0, 1, 4]; None when empty or any name is unknown."""
    names = [x.strip().lower()[:3] for x in re.split(r"[,\s]+", str(value or "")) if x.strip()]
    if not names or any(n not in DAY_NAMES for n in names):
        return None
    return sorted({DAY_NAMES.index(n) for n in names})


def validate(raw: dict) -> tuple[dict, list[str]]:
    """Checked settings plus human-readable problems; a bad value falls back to its default, never breaks Home.
    (The generic settings API only coerces types, so ranges / HH:MM / day names are checked here.)"""
    values = {**DEFAULTS, **{k: v for k, v in (raw or {}).items() if k in DEFAULTS}}
    errors: list[str] = []

    def bad(key: str, why: str) -> None:
        errors.append(f"{LABELS[key]}: {why} — using {DEFAULTS[key]}.")
        values[key] = DEFAULTS[key]

    for key, (lo, hi) in INT_BOUNDS.items():
        try:
            v = int(values[key])
            if isinstance(values[key], float) and values[key] != v:
                raise ValueError
        except (TypeError, ValueError):
            bad(key, "not a whole number")
            continue
        if not lo <= v <= hi:
            bad(key, f"must be between {lo} and {hi}")
        else:
            values[key] = v
    for key in ("work_start", "work_end", "standup_time"):
        m = TIME_RE.match(str(values[key]).strip())
        if m:
            values[key] = f"{int(m.group(1)):02d}:{m.group(2)}"
        else:
            bad(key, "use HH:MM (24-hour)")
    if values["work_end"] <= values["work_start"]:
        bad("work_end", "must be after the start of the work day")
        if values["work_end"] <= values["work_start"]:  # the start was the odd one out
            bad("work_start", "must be before the end of the work day")
    days = parse_days(values["standup_days"])
    if days is None:
        bad("standup_days", "use day names like mon,tue,wed,thu,fri")
        days = parse_days(DEFAULTS["standup_days"])
    values["standup_days"] = ",".join(DAY_NAMES[d] for d in days)
    values["standup_days_list"] = days
    values["standup_enabled"] = bool(values["standup_enabled"])
    return values, errors


def settings() -> tuple[dict, list[str]]:
    return validate(raw_settings())


# ---- screen time: storage ---------------------------------------------------------------------------
def _screen_path(d: date) -> Path:
    return _home_dir() / "screen" / f"{d.isoformat()}.json"


def load_minutes(d: date) -> set[int]:
    data = _read_json(_screen_path(d), {})
    return {int(m) for m in data.get("minutes", []) if isinstance(m, int) and 0 <= m < 1440}


def mark_active(now: float) -> bool:
    """Mark the local minute containing `now` active. Writes only when the minute is new; True if it was."""
    lt = _local(now)
    minute = lt.hour * 60 + lt.minute
    with _lock:
        minutes = load_minutes(lt.date())
        if minute in minutes:
            return False
        minutes.add(minute)
        _write_json(_screen_path(lt.date()), {"minutes": sorted(minutes)})
        return True


# ---- screen time: sources -------------------------------------------------------------------------
def current_source(now: float | None = None) -> str:
    now = time.time() if now is None else now
    return "gnome" if now - _state["gnome_ok_at"] < GNOME_FRESH_SECONDS else "browser"


def _dbus_env() -> dict:
    env = dict(os.environ)
    if not env.get("DBUS_SESSION_BUS_ADDRESS") and hasattr(os, "getuid"):
        sock = f"/run/user/{os.getuid()}/bus"
        if os.path.exists(sock):  # e.g. running as a systemd --user service without the session env
            env["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path={sock}"
    return env


def _gdbus(dest: str, path: str, method: str) -> str:
    out = subprocess.run(["gdbus", "call", "--session", "--dest", dest, "--object-path", path, "--method", method],
                         capture_output=True, text=True, timeout=COMMAND_TIMEOUT, env=_dbus_env(), check=True)
    return out.stdout.strip()


def gnome_idle() -> tuple[int | None, bool | None]:
    """(idle milliseconds, screen locked) from GNOME; (None, None) when the idle monitor can't be read.
    Raises FileNotFoundError when gdbus isn't installed (the sampler then retries rarely)."""
    try:
        out = _gdbus("org.gnome.Mutter.IdleMonitor", "/org/gnome/Mutter/IdleMonitor/Core",
                     "org.gnome.Mutter.IdleMonitor.GetIdletime")
    except FileNotFoundError:
        raise
    except (subprocess.SubprocessError, OSError):
        return None, None
    m = re.search(r"uint64\s+(\d+)", out)
    if not m:
        return None, None
    locked = None
    try:
        active = _gdbus("org.gnome.ScreenSaver", "/org/gnome/ScreenSaver", "org.gnome.ScreenSaver.GetActive")
        locked = True if "true" in active else False if "false" in active else None
    except (subprocess.SubprocessError, OSError):
        pass  # unknown: the idle time alone decides
    return int(m.group(1)), locked


IdleSource = Callable[[], "tuple[int | None, bool | None]"]


def sample(read_idle: IdleSource | None = None, now: float | None = None, values: dict | None = None) -> dict:
    """One sampler tick. The current minute is active when input was more recent than screen_idle_seconds and the
    screen isn't locked. Returns {"source", "active"} (active is None when the idle source didn't answer)."""
    now = time.time() if now is None else now
    values = values or settings()[0]
    idle_ms, locked = (read_idle or gnome_idle)()
    if idle_ms is None:
        return {"source": current_source(now), "active": None}
    _state["gnome_ok_at"] = now
    active = idle_ms < values["screen_idle_seconds"] * 1000 and locked is not True
    if active:
        mark_active(now)
    return {"source": "gnome", "active": active}


def heartbeat(now: float | None = None) -> dict:
    """Browser fallback: the frontend reports recent input in a visible tab. Ignored while GNOME is the source."""
    now = time.time() if now is None else now
    source = current_source(now)
    if source == "gnome":
        return {"accepted": False, "source": source}
    mark_active(now)
    return {"accepted": True, "source": source}


# ---- screen time: sampler thread -------------------------------------------------------------------
_sampler: dict = {"thread": None, "stop": None}
_sampler_lock = threading.Lock()


def sampler_allowed() -> bool:
    if os.environ.get("EU_ENABLE_SAMPLER") == "1":
        return True
    if os.environ.get("EU_DISABLE_SAMPLER"):
        return False
    return "pytest" not in sys.modules and "PYTEST_CURRENT_TEST" not in os.environ


def _run(stop: threading.Event) -> None:
    while not stop.is_set():
        wait = SAMPLE_SECONDS
        try:
            sample()
        except FileNotFoundError:
            wait = NO_GDBUS_RETRY_SECONDS
        except Exception:  # noqa: BLE001 - the sampler must outlive a bad tick (corrupt file, odd settings …)
            log.exception("screen-time sample failed")
        stop.wait(wait)


def start_sampler() -> bool:
    """Service.startup hook. Idempotent; does nothing under pytest unless EU_ENABLE_SAMPLER=1."""
    with _sampler_lock:
        t = _sampler["thread"]
        if t is not None and t.is_alive():
            return False
        if not sampler_allowed():
            return False
        stop = threading.Event()
        t = threading.Thread(target=_run, args=(stop,), name="home-screen-sampler", daemon=True)
        _sampler.update(thread=t, stop=stop)
        t.start()
        return True


def stop_sampler() -> None:
    """Service.shutdown hook. Idempotent."""
    with _sampler_lock:
        t, stop = _sampler["thread"], _sampler["stop"]
        _sampler.update(thread=None, stop=None)
    if stop is not None:
        stop.set()
    if t is not None and t.is_alive():
        t.join(timeout=COMMAND_TIMEOUT * 2 + 1)


def sampler_running() -> bool:
    t = _sampler["thread"]
    return bool(t and t.is_alive())


# ---- screen time: payload ----------------------------------------------------------------------------
def screen_payload(now: float, values: dict) -> dict:
    lt = _local(now)
    today = lt.date()
    yesterday = today - timedelta(days=1)
    tm, ym = load_minutes(today), load_minutes(yesterday)
    hourly = [0] * 24
    for m in tm:
        hourly[m // 60] += 1

    # current session: active minutes (yesterday's shifted by -1440, so it continues across midnight) ending
    # at most STREAK_MAX_DIFF minutes ago, with no hole of STREAK_MAX_DIFF minutes or more inside
    cur = lt.hour * 60 + lt.minute
    active = sorted([m - 1440 for m in ym] + [m for m in tm if m <= cur])
    streak, streak_start = 0, None
    if active and cur - active[-1] <= STREAK_MAX_DIFF:
        start = active[-1]
        for m in reversed(active[:-1]):
            if start - m > STREAK_MAX_DIFF:
                break
            start = m
        streak = active[-1] - start + 1
        streak_start = (datetime.combine(today, dtime()) + timedelta(minutes=start)).timestamp()

    return {
        "source": current_source(now),
        "sampler": sampler_running(),
        "idle_seconds": values["screen_idle_seconds"],
        "break_minutes": values["screen_break_minutes"],
        "today_minutes": len(tm),
        "hourly": hourly,
        "first_active": _hhmm(min(tm)) if tm else None,
        "last_active": _hhmm(max(tm)) if tm else None,
        "current_streak_minutes": streak,
        "current_streak_start": streak_start,
        "yesterday_minutes": len(ym),
        "week": [{"date": (today - timedelta(days=i)).isoformat(),
                  "minutes": len(tm) if i == 0 else len(ym) if i == 1 else len(load_minutes(today - timedelta(days=i)))}
                 for i in range(HISTORY_DAYS - 1, -1, -1)],
    }


# ---- water ---------------------------------------------------------------------------------------
def _water_path() -> Path:
    return _home_dir() / "water.json"


def load_water() -> dict:
    data = _read_json(_water_path(), {})
    return {k: [float(x) for x in v if isinstance(x, (int, float))] for k, v in data.items() if isinstance(v, list)}


def water_change(delta: int, now: float | None = None) -> int:
    """+1 logs a glass now; -1 removes today's latest (never below 0). Returns today's count."""
    if delta not in (1, -1):
        raise ValueError("delta must be 1 or -1")
    now = time.time() if now is None else now
    today = _local(now).date()
    key = today.isoformat()
    with _lock:
        data = load_water()
        glasses = sorted(data.get(key, []))
        if delta == 1:
            glasses.append(now)
        elif glasses:
            glasses.pop()
        else:
            return 0  # nothing to undo: don't touch the file
        data[key] = glasses
        _prune(data, today)
        _write_json(_water_path(), data)
        return len(glasses)


def water_next_reminder(now: float, count: int, last_at: float | None, values: dict) -> float | None:
    """When the next water reminder is due: remind_minutes after the last glass (or after the start of work),
    only inside today's work hours and while under the goal; otherwise the first one of the next work day."""
    step = values["water_remind_minutes"] * 60
    if not step:
        return None
    today = _local(now).date()
    start, end = _at(today, values["work_start"]), _at(today, values["work_end"])
    if count < values["water_goal"]:
        nxt = max(last_at, start) + step if last_at else start + step
        if nxt <= end and now <= end:
            return nxt  # may be in the past: then it is due
    return _at(today + timedelta(days=1), values["work_start"]) + step


def water_payload(now: float, values: dict) -> dict:
    today = _local(now).date()
    data = load_water()
    glasses = sorted(data.get(today.isoformat(), []))
    count = len(glasses)
    last_at = glasses[-1] if glasses else None
    nxt = water_next_reminder(now, count, last_at, values)
    start, end = _at(today, values["work_start"]), _at(today, values["work_end"])
    return {
        "count": count, "goal": values["water_goal"], "glass_ml": values["glass_ml"],
        "ml": count * values["glass_ml"], "goal_ml": values["water_goal"] * values["glass_ml"],
        "last_at": last_at,
        "history": [{"date": (d := today - timedelta(days=i)).isoformat(), "count": len(data.get(d.isoformat(), []))}
                    for i in range(HISTORY_DAYS - 1, -1, -1)],
        "next_reminder_at": nxt,
        "due_now": nxt is not None and count < values["water_goal"] and start <= now <= end and nxt <= now,
        "remind_minutes": values["water_remind_minutes"],
        "work_start": values["work_start"], "work_end": values["work_end"],
    }


# ---- standup -------------------------------------------------------------------------------------
def _standup_path() -> Path:
    return _home_dir() / "standup.json"


def load_standup() -> dict:
    return _read_json(_standup_path(), {})


def standup_action(action: str, minutes: int | None = None, now: float | None = None) -> dict:
    now = time.time() if now is None else now
    today = _local(now).date()
    key = today.isoformat()
    with _lock:
        data = load_standup()
        if action in ("done", "skip"):
            data[key] = {"status": "done" if action == "done" else "skipped", "at": now}
            data["snooze_until"] = None
            audit.record("home", f"standup-{action}", target=key)  # the date only, never the summary
        elif action == "snooze":
            data["snooze_until"] = now + max(1, min(int(minutes or 10), 240)) * 60
        else:
            raise ValueError("action must be done, skip or snooze")
        _prune(data, today)
        _write_json(_standup_path(), data)
        return data


def previous_working_day(d: date, days: list[int]) -> date:
    """The last standup day before `d` (Monday → Friday for mon–fri); the day before when no days are set."""
    for i in range(1, 8):
        c = d - timedelta(days=i)
        if c.weekday() in days:
            return c
    return d - timedelta(days=1)


def standup_state(now: float, values: dict, data: dict | None = None) -> dict:
    data = load_standup() if data is None else data
    lt = _local(now)
    today = lt.date()
    days = values["standup_days_list"]
    enabled = values["standup_enabled"]
    at = _at(today, values["standup_time"])
    entry = data.get(today.isoformat())
    status_today = entry.get("status") if isinstance(entry, dict) else None
    snooze = data.get("snooze_until")
    snoozed = isinstance(snooze, (int, float)) and snooze > now
    is_day = today.weekday() in days
    due_now = bool(enabled and is_day and now >= at and not status_today and not snoozed)

    next_at = None
    if enabled:
        if is_day and not status_today and (now < at or not snoozed):
            next_at = at
        elif is_day and not status_today:
            next_at = snooze
        else:
            for i in range(1, 8):
                d = today + timedelta(days=i)
                if d.weekday() in days:
                    next_at = _at(d, values["standup_time"])
                    break
    return {"enabled": enabled, "time": values["standup_time"], "days": values["standup_days"],
            "is_standup_day": is_day, "due_now": due_now, "status_today": status_today,
            "snooze_until": snooze if snoozed else None, "next_at": next_at}


def _brief(t: dict, note: str = "") -> dict:
    return {"kind": "task", "id": t.get("id"), "title": t.get("title", ""), "priority": t.get("priority", "normal"),
            "due": t.get("due"), "note": note}


def _rank(tasks: list[dict]) -> list[dict]:
    return sorted(tasks, key=lambda t: (PRIO_RANK.get(t.get("priority"), 1), t.get("due") or "9999", t.get("created_at") or 0))


def _marker(item: dict) -> str:
    return {"high": "[high] ", "low": "[low] "}.get(item.get("priority"), "")


def standup_summary(now: float, values: dict) -> dict:
    """Yesterday / Today / Blockers from the planner (and failed jobs), plus the same as markdown text."""
    tasks = importlib.import_module("app.services.planner.router").store.tasks()
    today = _local(now).date()
    t_iso = today.isoformat()
    prev = previous_working_day(today, values["standup_days_list"])
    since, until = _midnight(prev), _midnight(today)

    # everything finished since the start of the previous working day, so Monday also picks up weekend work
    done = sorted((t for t in tasks if t.get("status") == "done" and since <= (t.get("done_at") or 0) < until),
                  key=lambda t: t.get("done_at") or 0)
    open_ = [t for t in tasks if t.get("status") != "done"]
    doing = [t for t in open_ if t.get("status") == "doing"]
    due_today = [t for t in open_ if t.get("due") == t_iso and t.get("status") != "doing"]
    overdue = [t for t in open_ if t.get("due") and t["due"] < t_iso and t.get("status") != "doing"]

    def overdue_days(t: dict) -> int:
        return (today - date.fromisoformat(t["due"])).days if t.get("due") else 0

    today_items = ([_brief(t, "in progress") for t in _rank(doing)]
                   + [_brief(t, "due today") for t in _rank(due_today)]
                   + [_brief(t, f"overdue {overdue_days(t)} d") for t in _rank(overdue)])
    blockers = []
    for t in _rank(open_):
        late, postponed = overdue_days(t), int(t.get("postponed") or 0)
        if late > 1 or postponed > 0:
            notes = [f"overdue {late} d" if late > 1 else "", f"postponed {postponed}×" if postponed else ""]
            blockers.append(_brief(t, ", ".join(n for n in notes if n)))
    for e in audit.recent(200, kind="job", since=since):
        if e.get("action") == "finish" and e.get("status") == "failed":
            blockers.append({"kind": "job", "id": None, "title": f"Job failed: {e.get('target') or 'unnamed'}",
                             "priority": "normal", "due": None,
                             "note": _local(e.get("ts", 0)).strftime("%a %H:%M")})

    yesterday_items = [_brief(t) for t in done]

    def section(title: str, items: list[dict]) -> list[str]:
        return [f"**{title}**", *([f"- {_marker(i)}{i['title']}" for i in items] or ["- —"])]

    label = "Yesterday" if prev == today - timedelta(days=1) else f"Yesterday ({prev.strftime('%a %d %b')})"
    text = "\n".join([*section(label, yesterday_items), "", *section("Today", today_items), "",
                      *section("Blockers", blockers)])
    return {"previous_day": prev.isoformat(), "yesterday": yesterday_items, "today": today_items,
            "blockers": blockers, "text": text}


# ---- payload ---------------------------------------------------------------------------------------
def _safe(fn, *args) -> dict:
    try:
        return fn(*args)
    except Exception as e:  # noqa: BLE001 - one broken card must not break the others
        log.exception("wellbeing section failed")
        return {"error": f"{type(e).__name__}: {e}"}


def wellbeing(now: float | None = None) -> dict:
    now = time.time() if now is None else now
    try:
        values, errors = settings()
    except Exception as e:  # noqa: BLE001 - unreadable settings file
        values, errors = validate({})
        errors = [f"Couldn't read the Home settings ({type(e).__name__}: {e}) — using defaults."]
    standup = _safe(standup_state, now, values)
    if "error" not in standup:
        standup["summary"] = _safe(standup_summary, now, values)
    return {
        "now": now,
        "today": _local(now).date().isoformat(),
        "errors": errors,
        "screen": _safe(screen_payload, now, values),
        "water": _safe(water_payload, now, values),
        "standup": standup,
    }
