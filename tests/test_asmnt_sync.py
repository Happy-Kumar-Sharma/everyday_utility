"""Prod → Staging Sync tab. The two repo scripts are ALWAYS fakes written into a temp "repo" (whose path has a
space in it): they print exactly the real scripts' messages. No database, VPN or AWS is ever contacted."""

import csv
import json
import shlex
import socket
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.services.asmnt_sync import commands, parse, vpn
from app.services.asmnt_sync.ids import parse_ids
from app.services.asmnt_sync.store import RunStore

H = {"x-everyday-utility": "1"}
API = "/api/asmnt-sync"
SECRET = "sk_fake_SHOULD_NEVER_LEAK_42"

# behaviour by id prefix: a=success, b=not found, c=no uploadUrl, d=exception, e=HTTP 403, f=prod mongo timeout
# (uncaught -> traceback, script dies), s=slow (for the lock test)
FAKE_SYNC = r'''
import json, os, sys, time, uuid
args = sys.argv[1:]
if os.environ.get("FAKE_ARGS"):
    with open(os.environ["FAKE_ARGS"], "a") as f:
        f.write(json.dumps({"script": "sync", "argv": args, "cwd": os.getcwd()}) + "\n")
assert args[0] == "sync_ids" and args[1] == "--ids"
reupload = "--reupload" in args
for aid in [a for a in args[2:] if a != "--reupload"]:
    print(f"Processing assessment_id: {aid}")
    kind = aid[0]
    if kind == "s":
        time.sleep(60)
    if kind == "f":
        raise SystemExit("Traceback (most recent call last):\n  File \"utilities-og.py\", line 254\n"
                         "pymongo.errors.ServerSelectionTimeoutError: prod-db.invalid:27017: timed out, Timeout: 30s")
    if kind == "b":
        print(f"⚠️ No entry found for assessment_id: {aid}")
        continue
    try:
        if kind == "d":
            raise RuntimeError("Unable to locate credentials")
        if kind == "c":
            print(f"Failed to get uploadUrl for assessment_id: {aid}")
            continue
        code = 403 if kind == "e" else 200
        print(f"Status code on uploading {aid}: {code}")
        if code == 200:
            new = ("pj-" + aid) if reupload else str(uuid.uuid4())
            print(f"Successfully uploaded: {new}.json for assessment_id: {aid}")
    except Exception as e:
        print(f"Error processing {aid}: {str(e)}")
'''

# json ids starting "proc" -> processing, "miss" -> not found, else found. FAKE_LOOKUP_MODE=timeout -> no VPN
FAKE_LOOKUP = r'''
import argparse, csv, json, os, sys
p = argparse.ArgumentParser()
p.add_argument("--ids", nargs="+", required=True)
p.add_argument("--timeout", type=int, default=10)
p.add_argument("--output")
a = p.parse_args()
if os.environ.get("FAKE_ARGS"):
    with open(os.environ["FAKE_ARGS"], "a") as f:
        f.write(json.dumps({"script": "lookup", "argv": sys.argv[1:]}) + "\n")
print(f"Connecting to Staging MongoDB (timeout: {a.timeout}s)...")
if os.environ.get("FAKE_LOOKUP_MODE") == "timeout":
    print("\n❌ Connection timed out!")
    print("👉 Please ensure you are connected to the Staging VPN and try again.")
    sys.exit(1)
print(f"Querying {len(a.ids)} JSON ID(s) from Staging...\n")
rows = []
for jid in a.ids:
    if jid.startswith("proc"):
        rows.append([jid, "⚠️ (Processing / No ID yet)", 3, "7025", "2026-11-20 10:00:00", True])
    elif jid.startswith("miss"):
        rows.append([jid, "❌ Not found", "N/A", "N/A", "N/A", False])
    else:
        rows.append([jid, "stg-" + jid[:8], 27, "7025.0", "2026-11-20 10:00:00", True])
for r in rows:
    print(f"| {r[0]} | {r[1]} | {r[3]} | {r[2]} |")
if a.output:
    with open(a.output, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["json_id", "assessment_id", "status", "otp", "created_date", "found"])
        w.writerows(rows)
    print(f"\n📁 Results saved to {a.output}")
'''

PA = "a1111111-0000-4000-8000-000000000001"   # success
PA2 = "a2222222-0000-4000-8000-000000000002"  # success
PB = "b3333333-0000-4000-8000-000000000003"   # not found
PC = "c4444444-0000-4000-8000-000000000004"   # no uploadUrl
PD = "d5555555-0000-4000-8000-000000000005"   # exception (AWS)
PE = "e6666666-0000-4000-8000-000000000006"   # HTTP 403
PF = "f7777777-0000-4000-8000-000000000007"   # prod mongo timeout, script dies
PG = "a8888888-0000-4000-8000-000000000008"   # never reached (after the crash)


@pytest.fixture()
def repo(tmp_path):
    r = tmp_path / "my sync repo"
    r.mkdir()
    (r / "utilities-og.py").write_text(FAKE_SYNC)
    (r / "lookup_staging_assessments.py").write_text(FAKE_LOOKUP)
    (r / ".env").write_text(f"PROD_AWS_SECRET_ACCESS_KEY={SECRET}\nMONGO_URL_PROD=mongodb://u:{SECRET}@x/\n")
    return r


@pytest.fixture()
def client(tmp_path, monkeypatch, repo):
    from app.core import config, context
    from app.core.jobs import JobManager
    from app.core.settings_store import SettingsStore

    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(context, "jobs", JobManager(tmp_path / "jobs"))
    monkeypatch.setattr(context, "settings", SettingsStore(tmp_path / "settings"))
    monkeypatch.setenv("FAKE_ARGS", str(tmp_path / "args.jsonl"))
    monkeypatch.delenv("FAKE_LOOKUP_MODE", raising=False)
    from app.main import app

    with TestClient(app) as c:
        r = c.put("/api/services/asmnt-sync/settings", headers=H,
                  json={"repo_dir": str(repo), "python": sys.executable, "lookup_timeout": 7})
        assert r.status_code == 200, r.text
        yield c
        for j in context.jobs.list():
            context.jobs.cancel(j.id, grace=1)


def _args(tmp_path, script):
    p = tmp_path / "args.jsonl"
    return [json.loads(l) for l in p.read_text().splitlines() if json.loads(l)["script"] == script] if p.exists() else []


def _wait_job(job_id, timeout=15):
    from app.core import context
    deadline = time.time() + timeout
    while time.time() < deadline:
        j = context.jobs.get(job_id)
        if j and j.done:
            return j
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} did not finish")


def _sync(client, ids, reupload=False):
    r = client.post(f"{API}/runs", headers=H, json={"ids": ids, "reupload": reupload})
    assert r.status_code == 200, r.text
    run = r.json()
    _wait_job(run["sync_job_id"])
    return client.get(f"{API}/runs/{run['id']}").json()


def _lookup_only(client, ids):
    r = client.post(f"{API}/lookup", headers=H, json={"ids": ids})
    assert r.status_code == 200, r.text
    run = r.json()
    _wait_job(run["job"]["id"])
    return client.get(f"{API}/runs/{run['id']}").json()


def _by(run, key):
    return {i[key]: i for i in run["items"]}


# ---- ids ------------------------------------------------------------------------------------------
def test_parse_ids_separators_dedupe_and_rejects():
    text = f"""assessment_id
"{PA}",{PB}  {PA} ; '{PC}' {PB};
{PD}\t$(id) a;rm --reupload [{PE}] `{PF}` short x{PA}
"""
    r = parse_ids(text)
    assert r["ids"] == [PA, PB, PC, PD, PE, PF, f"x{PA}"]
    assert r["duplicates"] == 1
    for bad in ("assessment_id", "$(id)", "a;rm", "--reupload", "short", f"{PB};"):
        assert bad in r["rejected"]
    assert all("$" not in i and ";" not in i for i in r["ids"])


def test_parse_ids_json_suffix():
    j = "1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d"
    assert parse_ids(f"{j}.json, {j}", json_ids=True)["ids"] == [j]
    assert parse_ids(f"{j}.json")["ids"] == []  # prod ids never take a .json
    assert parse_ids("a" * 65)["ids"] == [] and parse_ids("-" + "1" * 10)["ids"] == []


# ---- commands -------------------------------------------------------------------------------------
def test_command_quoting_round_trip(tmp_path):
    repo = tmp_path / "dir with spaces; $(x)"
    s = {"repo_dir": str(repo), "python": "~/venv dir/bin/python", "sync_script": "utilities-og.py",
         "lookup_script": "lookup x.py", "lookup_timeout": 9}
    cmd = commands.sync(s, [PA, PB], reupload=True)
    parts = shlex.split(cmd.script)
    assert parts == ["cd", str(repo), "&&", "exec", str(Path("~/venv dir/bin/python").expanduser()),
                     "utilities-og.py", "sync_ids", "--ids", PA, PB, "--reupload"]
    assert cmd.display == cmd.script and cmd.env["PYTHONUNBUFFERED"] == "1"
    assert "--reupload" not in commands.sync(s, [PA], reupload=False).script
    out = tmp_path / "out dir" / "lookup-1.csv"
    parts = shlex.split(commands.lookup(s, ["j1234567"], out).script)
    assert parts[5:] == ["lookup x.py", "--ids", "j1234567", "--timeout", "9", "--output", str(out)]
    assert shlex.split(commands.sync({**s, "python": "python3"}, [PA], False).script)[4] == "python3"


# ---- step 1 parsing -------------------------------------------------------------------------------
def test_parse_sync_states_and_hints():
    lines = [
        f"Processing assessment_id: {PA}", f"Status code on uploading {PA}: 200",
        f"Successfully uploaded: 1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d.json for assessment_id: {PA}",
        f"Processing assessment_id: {PB}", f"⚠️ No entry found for assessment_id: {PB}",
        f"Processing assessment_id: {PC}", f"Failed to get uploadUrl for assessment_id: {PC}",
        f"Processing assessment_id: {PD}", f"Error processing {PD}: An error occurred (InvalidAccessKeyId) when calling the HeadObject operation",
        f"Processing assessment_id: {PE}", f"Status code on uploading {PE}: 403",
        f"Processing assessment_id: {PF}", "Traceback (most recent call last):", '  File "x.py", line 1',
        "pymongo.errors.ServerSelectionTimeoutError: db:27017: timed out",
    ]
    ids = [PA, PB, PC, PD, PE, PF, PG]
    r = parse.parse_sync(lines, ids, done=True)["items"]
    assert r[PA]["sync_state"] == "synced" and r[PA]["json_id"] == "1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d"
    assert r[PB]["sync_state"] == "not_found" and r[PB]["sync_hint"] == parse.NOT_IN_PROD
    assert r[PC]["sync_state"] == "failed" and "uploadUrl" in r[PC]["sync_error"]
    assert r[PD]["sync_state"] == "failed" and r[PD]["sync_hint"] == parse.AWS
    assert r[PE]["sync_state"] == "failed" and "HTTP 403" in r[PE]["sync_error"]
    assert r[PF]["sync_state"] == "failed" and r[PF]["sync_hint"] == parse.PROD_VPN
    assert "ServerSelectionTimeoutError" in r[PF]["sync_error"]
    assert PG not in r  # never mentioned -> stays pending
    # while running, the id being processed is not failed yet
    running = parse.parse_sync(lines[:4], ids, done=False)["items"]
    assert running[PB] == {**running[PB], "sync_state": "pending", "active": True}


def test_hints():
    assert parse.hint("socket.gaierror: [Errno -2] Name or service not known") == parse.PROD_VPN
    assert parse.hint("botocore.exceptions.NoCredentialsError: Unable to locate credentials") == parse.AWS
    assert parse.hint("ModuleNotFoundError: No module named 'pymongo'") == parse.NO_DEPS
    assert parse.hint("⚠️ No entry found for assessment_id: x") == parse.NOT_IN_PROD
    assert parse.hint("timed out", "staging") == parse.STAGING_VPN
    assert parse.hint("all good") == ""


# ---- end to end: step 1 ---------------------------------------------------------------------------
def test_sync_run_end_to_end(client, tmp_path, repo):
    run = _sync(client, f"{PA}\n{PB}, {PC} {PD} {PE} {PF} {PG} $(id) {PA}")
    items = _by(run, "prod_id")
    assert list(items) == [PA, PB, PC, PD, PE, PF, PG]
    assert items[PA]["sync_state"] == "synced" and len(items[PA]["json_id"]) == 36
    assert items[PB]["sync_state"] == "not_found" and items[PB]["sync_hint"] == "not found in prod"
    assert items[PC]["sync_state"] == "failed"
    assert items[PD]["sync_state"] == "failed" and "AWS credentials" in items[PD]["sync_hint"]
    assert items[PE]["sync_state"] == "failed" and "403" in items[PE]["sync_error"]
    assert items[PF]["sync_state"] == "failed" and "PROD VPN" in items[PF]["sync_hint"]
    assert items[PG]["sync_state"] == "pending"
    assert run["sync_job"]["status"] == "failed" and run["sync_message"]["hint"] == parse.PROD_VPN
    assert run["counts"]["sync_synced"] == 1 and run["counts"]["sync_pending"] == 1
    call = _args(tmp_path, "sync")[0]
    assert call["argv"] == ["sync_ids", "--ids", PA, PB, PC, PD, PE, PF, PG]
    assert Path(call["cwd"]) == repo
    # job meta + display
    from app.core import context
    job = context.jobs.get(run["sync_job_id"])
    assert job.meta == {"step": "asmnt-sync", "run": run["id"], "stage": "sync", "env": "prod"}
    assert job.lock_key == "asmnt-sync:step1" and "sync_ids --ids" in job.display


def test_reupload_keeps_prod_json_uuid(client, tmp_path):
    run = _sync(client, PA2, reupload=True)
    assert run["reupload"] is True and run["items"][0]["json_id"] == f"pj-{PA2}"
    assert _args(tmp_path, "sync")[0]["argv"][-1] == "--reupload"


def test_bad_input_and_settings(client, tmp_path):
    r = client.post(f"{API}/runs", headers=H, json={"ids": "$(id) a;rm"})
    assert r.status_code == 400 and "no valid ids" in r.json()["detail"]
    client.put("/api/services/asmnt-sync/settings", headers=H, json={"repo_dir": str(tmp_path / "nope")})
    r = client.post(f"{API}/runs", headers=H, json={"ids": PA})
    assert r.status_code == 400 and "repo folder not found" in r.json()["detail"]
    assert client.post(f"{API}/runs", json={"ids": PA}).status_code == 403  # header required


def test_one_sync_at_a_time(client):
    slow = "s9999999-0000-4000-8000-000000000009"
    r = client.post(f"{API}/runs", headers=H, json={"ids": slow})
    assert r.status_code == 200
    r2 = client.post(f"{API}/runs", headers=H, json={"ids": PA})
    assert r2.status_code == 409
    assert len(client.get(f"{API}/runs").json()) == 1  # the refused run is not stored
    run_id = r.json()["id"]
    assert client.delete(f"{API}/runs/{run_id}", headers=H).status_code == 409  # still running
    deadline = time.time() + 10
    while time.time() < deadline:  # wait for "Processing assessment_id: …"
        live = client.get(f"{API}/runs/{run_id}").json()
        if live["items"][0]["active"]:
            break
        time.sleep(0.05)
    assert live["running"] and live["items"][0]["active"] is True and live["items"][0]["sync_state"] == "pending"
    from app.core import context
    context.jobs.cancel(r.json()["sync_job_id"], grace=1)
    _wait_job(r.json()["sync_job_id"])
    run = client.get(f"{API}/runs/{run_id}").json()
    assert run["sync_job"]["status"] == "cancelled" and run["items"][0]["sync_state"] == "failed"
    assert client.delete(f"{API}/runs/{run_id}", headers=H).status_code == 200
    assert client.get(f"{API}/runs/{run_id}").status_code == 404


# ---- end to end: step 2 ---------------------------------------------------------------------------
def test_lookup_after_sync_and_only_missing(client, tmp_path):
    run = _sync(client, f"{PA} {PA2} {PB}")
    r = client.post(f"{API}/runs/{run['id']}/lookup", headers=H, json={})
    assert r.status_code == 200, r.text
    from app.core import context
    job = context.jobs.get(r.json()["job"]["id"])
    assert job.meta["stage"] == "lookup" and job.meta["env"] == "staging" and job.lock_key == "asmnt-sync:step2"
    _wait_job(job.id)
    run = client.get(f"{API}/runs/{run['id']}").json()
    items = _by(run, "prod_id")
    for pid in (PA, PA2):
        it = items[pid]
        assert it["lookup_state"] == "found" and it["staging_id"] == "stg-" + it["json_id"][:8]
        assert it["otp"] == "7025" and it["status"] == "27" and it["created_date"].startswith("2026-11-20")
    assert items[PB]["lookup_state"] == "pending"  # no json id, never looked up
    argv = _args(tmp_path, "lookup")[0]["argv"]
    assert argv[argv.index("--timeout") + 1] == "7"
    assert Path(argv[argv.index("--output") + 1]).name == f"lookup-{run['id']}-1.csv"
    # everything is found now: only_missing has nothing to do, a full re-lookup does
    r = client.post(f"{API}/runs/{run['id']}/lookup", headers=H, json={"only_missing": True})
    assert r.status_code == 400 and "nothing to look up" in r.json()["detail"]
    r = client.post(f"{API}/runs/{run['id']}/lookup", headers=H, json={"only_missing": False})
    assert r.status_code == 200
    _wait_job(r.json()["job"]["id"])
    assert len(client.get(f"{API}/runs/{run['id']}").json()["lookup_job_ids"]) == 2


def test_lookup_only_run_states_and_retry(client, tmp_path):
    found, proc, miss = "1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d", "proc1234-aaaa", "miss5678-bbbb"
    run = _lookup_only(client, f"{found}.json\n{proc}, '{miss}' {found}")
    assert run["kind"] == "lookup"
    items = _by(run, "json_id")
    assert list(items) == [found, proc, miss]
    assert all(i["prod_id"] == "" and i["sync_state"] == "skipped" for i in items.values())
    assert items[found]["lookup_state"] == "found" and items[found]["staging_id"] == "stg-1a2b3c4d"
    assert items[proc]["lookup_state"] == "processing" and "retry" in items[proc]["lookup_hint"]
    assert items[miss]["lookup_state"] == "not_found" and items[miss]["staging_id"] == ""
    assert items[miss]["otp"] == "" and items[miss]["status"] == ""
    # retry (only missing) asks for the processing / not-found ones only
    r = client.post(f"{API}/runs/{run['id']}/lookup", headers=H, json={"only_missing": True})
    assert r.status_code == 200, r.text
    _wait_job(r.json()["job"]["id"])
    argv = _args(tmp_path, "lookup")[-1]["argv"]
    assert argv[argv.index("--ids") + 1: argv.index("--timeout")] == [proc, miss]


def test_lookup_timeout_marks_failed(client, monkeypatch):
    monkeypatch.setenv("FAKE_LOOKUP_MODE", "timeout")
    run = _lookup_only(client, "1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d 0a7d8e9f-1111")
    assert all(i["lookup_state"] == "failed" for i in run["items"])
    assert run["items"][0]["lookup_error"] == "Staging DB not reachable — connect the STAGING VPN"
    assert run["lookup_job"]["status"] == "failed" and "STAGING VPN" in run["lookup_message"]["hint"]


def test_lookup_csv_parsing_pandas_style(tmp_path):
    p = tmp_path / "x.csv"
    p.write_text("json_id,assessment_id,status,otp,created_date,found\n"
                 "j1234567,9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b,27,7025.0,2026-01-01 00:00:00,True\n"
                 "j2345678,⚠️ (Processing / No ID yet),N/A,,N/A,True\n"
                 "j3456789,❌ Not found,N/A,N/A,N/A,False\n", encoding="utf-8")
    r = parse.parse_lookup_csv(p)
    assert r["j1234567"]["staging_id"] == "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b" and r["j1234567"]["otp"] == "7025"
    assert r["j2345678"]["lookup_state"] == "processing" and r["j3456789"]["lookup_state"] == "not_found"


# ---- export, persistence, search, audit ---------------------------------------------------------
def test_export_csv_and_markdown(client):
    run = _lookup_only(client, "1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d miss5678-bbbb")
    r = client.get(f"{API}/runs/{run['id']}/export", params={"format": "csv"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    rows = list(csv.reader(r.text.splitlines()))
    assert rows[0] == ["prod_id", "json_id", "staging_assessment_id", "otp", "status", "created_date", "states"]
    assert rows[1] == ["", "1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d", "stg-1a2b3c4d", "7025", "27",
                       "2026-11-20 10:00:00", "sync:skipped lookup:found"]
    assert rows[2][6] == "sync:skipped lookup:not_found"
    md = client.get(f"{API}/runs/{run['id']}/export", params={"format": "md"}).text.splitlines()
    assert md[0].startswith("| prod_id | json_id |") and md[1].startswith("|---|")
    assert "| stg-1a2b3c4d |" in md[2] and len(md) == 4
    assert client.get(f"{API}/runs/{run['id']}/export", params={"format": "xml"}).status_code == 400


def test_persistence_across_fresh_store(client, monkeypatch):
    run = _sync(client, PA)
    import importlib
    router = importlib.import_module("app.services.asmnt_sync.router")
    fresh = RunStore()
    again = fresh.get(run["id"])
    assert again["items"][0]["sync_state"] == "synced" and run["sync_job_id"] in again["finalized"]
    assert "active" not in again["items"][0]
    monkeypatch.setattr(router, "store", fresh)
    listed = client.get(f"{API}/runs").json()
    assert [r["id"] for r in listed] == [run["id"]] and listed[0]["items"][0]["json_id"] == run["items"][0]["json_id"]
    # a job that is gone from memory (server restart) is recovered from its log file
    from app.core import context
    from app.core.jobs import JobManager
    log_dir = context.jobs.log_dir
    monkeypatch.setattr(context, "jobs", JobManager(log_dir))
    data = fresh.load()
    data[0]["finalized"] = []
    for i in data[0]["items"]:
        i.update(sync_state="pending", json_id="")
    fresh.save(data)
    rec = client.get(f"{API}/runs/{run['id']}").json()
    assert rec["items"][0]["sync_state"] == "synced" and rec["sync_job"]["gone"] is True


def test_keeps_last_200_runs(tmp_path):
    s = RunStore(tmp_path / "runs.json")
    s.save([{"id": f"r{i}", "created_at": i, "items": []} for i in range(205)])
    runs = s.load()
    assert len(runs) == 200 and runs[0]["id"] == "r204"


def test_search(client):
    run = _sync(client, PA)
    json_id = run["items"][0]["json_id"]
    from app.services.asmnt_sync.router import search
    hits = search(json_id[:13])
    assert hits[0]["ref"] == run["id"] and hits[0]["title"] == json_id and PA in hits[0]["subtitle"]
    groups = client.get("/api/search", params={"q": PA[:12]}).json()
    assert any(g["service"] == "asmnt-sync" for g in groups)
    assert search("zz") == []


def test_audit_counts_no_secrets(client, tmp_path):
    from app.core import audit, config
    run = _sync(client, f"{PA} {PB}")
    events = [e for e in audit.recent(50, kind="asmnt-sync")]
    finish = next(e for e in events if e["action"] == "sync" and e["status"] != "started")
    assert finish["target"] == f"run {run['id']}" and finish["env"] == "prod"
    assert finish["detail"]["count"] == 2 and finish["detail"]["succeeded"] == 1
    _lookup_only(client, "1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d")
    look = next(e for e in audit.recent(50, kind="asmnt-sync") if e["action"] == "lookup" and e["status"] != "started")
    assert look["env"] == "staging" and look["detail"] == {**look["detail"], "count": 1, "succeeded": 1}
    for f in (config.DATA_DIR / "audit" / "audit.jsonl", config.DATA_DIR / "asmnt_sync" / "runs.json"):
        assert SECRET not in f.read_text()


# ---- status / VPN ---------------------------------------------------------------------------------
def test_status_and_probes(client, repo):
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    open_port = srv.getsockname()[1]
    closed = socket.socket()
    closed.bind(("127.0.0.1", 0))
    closed_port = closed.getsockname()[1]
    closed.close()
    try:
        client.put("/api/services/asmnt-sync/settings", headers=H,
                   json={"prod_probe": f"127.0.0.1:{open_port}", "staging_probe": f"127.0.0.1:{closed_port}"})
        s = client.get(f"{API}/status").json()
        assert s["repo_dir"]["exists"] and s["scripts"]["sync_script"]["exists"] and s["scripts"]["lookup_script"]["exists"]
        assert s["python"]["found"] is True and isinstance(s["vpn_interfaces"], list)
        assert s["prod_probe"]["ok"] is True and s["staging_probe"]["ok"] is False
        assert client.get(f"{API}/probe/staging").json()["ok"] is False
        client.put("/api/services/asmnt-sync/settings", headers=H, json={"prod_probe": "", "staging_probe": "bad host"})
        s = client.get(f"{API}/status").json()
        assert s["prod_probe"] == {"configured": False, "ok": None, "detail": "not configured"}
        assert s["staging_probe"]["ok"] is False and "invalid" in s["staging_probe"]["detail"]
    finally:
        srv.close()


def test_vpn_interfaces(tmp_path, monkeypatch):
    for name in ("eth0", "lo", "tun0", "tap1", "wg0", "ppp0", "utun3", "myvpn", "wlp2s0"):
        (tmp_path / name).mkdir()
    (tmp_path / "tap1" / "operstate").write_text("up\n")
    monkeypatch.setattr(vpn, "SYS_NET", tmp_path)
    got = vpn.interfaces()
    assert [i["name"] for i in got] == ["myvpn", "ppp0", "tap1", "tun0", "utun3", "wg0"]
    assert next(i for i in got if i["name"] == "tap1")["state"] == "up"
    assert vpn.parse_target("[::1]:5432") == ("::1", 5432)
    for bad in ("host", "host:0", "a b:1", "$(id):1", "h:99999"):
        with pytest.raises(ValueError):
            vpn.parse_target(bad)


# ---- review regressions -----------------------------------------------------------------------------
def test_finalize_reads_status_before_output(client, monkeypatch):
    """The job finishing between the output snapshot and the done check must not finalize stale output."""
    from app.core import context
    from app.core.jobs import Job
    orig = Job.output_since

    def slow(self, since):
        out = orig(self, since)
        if self.meta.get("stage") == "sync" and not self.done:
            for _ in range(300):  # imitate a thread switch: the job ends right after the snapshot
                if self.done:
                    break
                time.sleep(0.02)
        return out

    monkeypatch.setattr(Job, "output_since", slow)
    run = client.post(f"{API}/runs", headers=H, json={"ids": PA}).json()
    client.get(f"{API}/runs/{run['id']}")
    _wait_job(run["sync_job_id"])
    r = client.get(f"{API}/runs/{run['id']}").json()
    assert r["items"][0]["sync_state"] == "synced" and r["items"][0]["json_id"]
    assert context.jobs.get(run["sync_job_id"]).done


def test_job_gone_from_memory_keeps_real_status(client):
    from app.core import audit, context
    run = client.post(f"{API}/runs", headers=H, json={"ids": f"{PA}\n{PA2}"}).json()
    _wait_job(run["sync_job_id"])
    context.jobs._jobs.pop(run["sync_job_id"])  # server restart / pruned before any GET finalized the run
    r = client.get(f"{API}/runs/{run['id']}").json()
    assert [i["sync_state"] for i in r["items"]] == ["synced", "synced"]
    assert r["sync_job"]["status"] == "succeeded" and r["sync_job"]["gone"]
    assert r["sync_message"] is None
    ev = [e for e in audit.recent(50, kind="asmnt-sync") if e["action"] == "sync" and e["status"] != "started"]
    assert ev[0]["status"] == "succeeded" and ev[0]["detail"]["succeeded"] == 2


def test_job_gone_without_audit_inferred_from_complete_output(client, monkeypatch):
    from app.core import context
    import importlib
    r_mod = importlib.import_module("app.services.asmnt_sync.router")
    run = client.post(f"{API}/runs", headers=H, json={"ids": f"{PA}\n{PB}"}).json()
    _wait_job(run["sync_job_id"])
    context.jobs._jobs.pop(run["sync_job_id"])
    monkeypatch.setattr(r_mod, "_recovered_status", lambda job_id: "lost")
    r = client.get(f"{API}/runs/{run['id']}").json()
    assert r["sync_job"]["status"] == "succeeded" and r["sync_message"] is None


def test_upload_200_without_json_id_is_flagged():
    lines = [f"Processing assessment_id: {PA}", f"Status code on uploading {PA}: 200"]
    parsed = parse.parse_sync(lines, [PA], done=True)
    item = parsed["items"][PA]
    assert item["sync_state"] == "failed" and item["sync_uploaded"] is True
    assert "HTTP 200" in item["sync_error"] and "check staging" in item["sync_hint"]
    assert not parsed["complete"]
    other = parse.parse_sync([f"Processing assessment_id: {PA}"], [PA], done=True)["items"][PA]
    assert other["sync_uploaded"] is False and other["sync_state"] == "failed"


def test_lookup_all_again_without_vpn_keeps_found(client, tmp_path, monkeypatch):
    found, proc = "found111-aaaa-bbbb", "proc2222-aaaa-bbbb"
    run = _lookup_only(client, f"{found}\n{proc}")
    assert _by(run, "json_id")[found]["lookup_state"] == "found"
    monkeypatch.setenv("FAKE_LOOKUP_MODE", "timeout")
    r = client.post(f"{API}/runs/{run['id']}/lookup", headers=H, json={"only_missing": False})
    assert r.status_code == 200, r.text
    _wait_job(r.json()["job"]["id"])
    run = client.get(f"{API}/runs/{run['id']}").json()
    items = _by(run, "json_id")
    assert items[found]["lookup_state"] == "found" and items[found]["staging_id"] == "stg-found111"
    assert items[found]["lookup_error"] == ""
    assert items[proc]["lookup_state"] == "failed"
    assert "STAGING VPN" in run["lookup_message"]["hint"]
    csv_text = client.get(f"{API}/runs/{run['id']}/export?format=csv").text
    assert "sync:skipped lookup:found" in csv_text
    # the next "only missing" lookup leaves the found one alone
    monkeypatch.delenv("FAKE_LOOKUP_MODE")
    r = client.post(f"{API}/runs/{run['id']}/lookup", headers=H, json={"only_missing": True})
    _wait_job(r.json()["job"]["id"])
    argv = _args(tmp_path, "lookup")[-1]["argv"]
    assert argv[argv.index("--ids") + 1: argv.index("--timeout")] == [proc]
