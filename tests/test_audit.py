import json
import time

import pytest
from fastapi.testclient import TestClient

from app.core import audit, config, context
from app.core.jobs import JobManager
from app.core.settings_store import SettingsStore

H = {"x-everyday-utility": "1"}
PASSWORD = "Zq9-unique-pa55word-7731"
USERNAME = "secret.user@example.invalid"
URL = "https://login.example.invalid/very-private"
ENV_VALUE = "env-value-should-never-appear-4411"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import importlib

    from app.main import create_app
    from app.services.manager.envfiles import RepoStore

    manager_router = importlib.import_module("app.services.manager.router")  # the package re-exports `router`

    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(context, "settings", SettingsStore(tmp_path / "settings"))
    monkeypatch.setattr(context, "jobs", JobManager(tmp_path / "jobs"))
    monkeypatch.setattr(manager_router, "repos", RepoStore(tmp_path / "repos.json"))
    # no lifespan: nothing is created under the real data dir
    return TestClient(create_app())


def _log(tmp_path) -> str:
    p = tmp_path / "data" / "audit" / "audit.jsonl"
    return p.read_text() if p.exists() else ""


def _wait(job, timeout=10):
    deadline = time.time() + timeout
    while not job.done and time.time() < deadline:
        time.sleep(0.05)
    time.sleep(0.05)  # the finish event is written right after the status flips


def test_job_start_and_finish_recorded(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    jm = JobManager(tmp_path / "jobs")
    ok = jm.start("Good job", "echo hi", lock_key="t:ok", meta={"step": "load", "env": "local", "output": "/x.csv"})
    bad = jm.start("Bad job", "exit 3", meta={"variant": "predict_single"})
    _wait(ok), _wait(bad)
    events = audit.recent(10, kind="job")
    starts = {e["target"]: e for e in events if e["action"] == "start"}
    finishes = {e["target"]: e for e in events if e["action"] == "finish"}
    assert starts["Good job"]["env"] == "local"
    assert starts["Good job"]["detail"] == {"job": ok.id, "lock_key": "t:ok", "step": "load", "output": "/x.csv"}
    assert starts["Bad job"]["detail"]["variant"] == "predict_single" and starts["Bad job"]["env"] is None
    assert finishes["Good job"]["status"] == "succeeded" and finishes["Good job"]["detail"]["exit_code"] == 0
    assert finishes["Bad job"]["status"] == "failed" and finishes["Bad job"]["detail"]["exit_code"] == 3
    assert {"duration", "log", "job"} <= set(finishes["Bad job"]["detail"])
    assert "echo hi" not in (tmp_path / "audit" / "audit.jsonl").read_text()  # never the script


def test_job_cancel_recorded(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    jm = JobManager(tmp_path / "jobs")
    job = jm.start("Sleeper", "sleep 30")
    time.sleep(0.2)
    jm.cancel(job.id, grace=1)
    _wait(job)
    assert audit.recent(1, kind="job")[0]["status"] == "cancelled"


def test_library_and_manager_never_log_secrets(client, tmp_path):
    lib_dir, creds = tmp_path / "lib", tmp_path / "vault" / "credentials.txt"
    assert client.put("/api/services/library/settings", json={"library_dir": str(lib_dir)}, headers=H).status_code == 200

    # ---- library
    r = client.post("/api/library/items", json={"collection": "Prod", "name": "q", "type": "sql", "env": "prod",
                                                  "content": f"SELECT '{PASSWORD}';"}, headers=H)
    assert r.status_code == 200, r.text
    item = r.json()
    r = client.put("/api/library/items", json={"path": item["path"], "content": f"-- {PASSWORD}\n", "name": "q2",
                                                 "tags": "x"}, headers=H)
    assert r.status_code == 200, r.text
    path = r.json()["path"]
    client.post("/api/library/items/use", json={"path": path}, headers=H)
    dup = client.post("/api/library/items/duplicate", json={"path": path}, headers=H).json()
    trash_id = client.post("/api/library/items/delete", json={"path": dup["path"]}, headers=H).json()["trash_id"]
    client.post("/api/library/trash/restore", json={"path": trash_id}, headers=H)
    client.post("/api/library/collections", json={"name": "Misc"}, headers=H)
    client.post("/api/library/collections/rename", json={"name": "Misc", "new_name": "Other"}, headers=H)
    client.post("/api/library/collections/delete", json={"name": "Other"}, headers=H)
    sh = client.post("/api/library/items", json={"name": "hello", "type": "shell", "env": "staging",
                                                   "content": f"echo {PASSWORD}"}, headers=H).json()
    job = client.post("/api/library/run", json={"path": sh["path"]}, headers=H).json()
    _wait(context.jobs.get(job["id"]))

    lib = {(e["action"], e["target"]): e for e in audit.recent(100, kind="library")}
    upd = lib[("update", path)]
    assert upd["env"] == "prod" and upd["detail"]["content_changed"] is True
    assert upd["detail"]["renamed"] == {"from": item["path"], "to": path} and upd["detail"]["meta_changed"] == ["tags"]
    assert lib[("delete", dup["path"])]["detail"]["trash_id"] == trash_id
    assert lib[("use", path)]["env"] == "prod"
    assert lib[("run", sh["path"])]["env"] == "staging"
    assert {("collection-create", "Misc"), ("collection-delete", "Other"), ("restore", dup["path"])} <= set(lib)
    run_start = [e for e in audit.recent(10, kind="job") if e["action"] == "start"][0]
    assert run_start["env"] == "staging" and run_start["detail"]["path"] == sh["path"]

    # ---- logins
    assert client.post("/api/manager/creds/location", json={"path": str(creds)}, headers=H).status_code == 200
    entry = {"title": "Bank portal", "url": URL, "username": USERNAME, "password": PASSWORD, "notes": PASSWORD}
    assert client.post("/api/manager/creds/entries", json=entry, headers=H).status_code == 200
    # untitled: the stored title falls back to the url, which must not leak into the log either
    assert client.post("/api/manager/creds/entries", json={**entry, "title": ""}, headers=H).status_code == 200
    e0 = client.get("/api/manager/creds").json()["entries"][0]
    r = client.put("/api/manager/creds/entries/0", json={**entry, "title": "Bank", "original_hash": e0["hash"]}, headers=H)
    assert r.status_code == 200, r.text
    e0 = client.get("/api/manager/creds").json()["entries"][0]
    assert client.delete(f"/api/manager/creds/entries/0?hash={e0['hash']}", headers=H).status_code == 200
    cred = [(e["action"], e["target"]) for e in reversed(audit.recent(20, kind="credentials"))]
    assert cred == [("location", str(creds.resolve())), ("add", "Bank portal"), ("add", "(untitled)"),
                    ("update", "Bank"), ("delete", "Bank")]

    # ---- env files
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / ".env").write_text(f"API_KEY={ENV_VALUE}\n")
    assert client.post("/api/manager/env/repos", json={"path": str(repo)}, headers=H).status_code == 200
    assert client.get("/api/manager/env/file", params={"path": str(repo / ".env")}).status_code == 200
    assert client.post("/api/manager/env/export", json={}, headers=H).status_code == 200
    client.post("/api/manager/env/repos/remove", json={"path": str(repo)}, headers=H)
    env = {e["action"]: e for e in audit.recent(20, kind="env-files")}
    assert env["view"]["target"] == str(repo / ".env")
    assert env["export"]["detail"] == {"repos": ["repo"], "files": 1}
    assert {"repo-add", "repo-remove"} <= set(env)

    log = _log(tmp_path)
    for secret in (PASSWORD, USERNAME, URL, ENV_VALUE, "API_KEY"):
        assert secret not in log, secret


def test_backup_recorded(client, tmp_path):
    (tmp_path / "data" / "planner").mkdir(parents=True)
    (tmp_path / "data" / "planner" / "planner.json").write_text("{}")
    r = client.post("/api/guide/backup", json={"dest_dir": str(tmp_path / "bk"), "parts": ["planner"],
                                                "include_library": False}, headers=H)
    assert r.status_code == 200, r.text
    last = audit.recent(1, kind="backup")[0]
    assert last["action"] == "create" and last["status"] == "succeeded" and last["target"] == r.json()["path"]
    assert last["detail"]["size"] == r.json()["size"] and last["detail"]["contents"] == ["data/planner/"]
    assert last["detail"]["include_library"] is False and last["detail"]["parts"] == ["planner"]

    r = client.post("/api/guide/backup", json={"dest_dir": str(config.ROOT_DIR / "nope")}, headers=H)
    assert r.status_code == 400
    failed = audit.recent(1, kind="backup")[0]
    assert failed["status"] == "failed" and "outside the app folder" in failed["detail"]["reason"]
    assert not (config.ROOT_DIR / "nope").exists()


def test_settings_event_lists_keys_not_values(client, tmp_path):
    secret_path = str(tmp_path / "my-very-private-folder")
    r = client.put("/api/services/library/settings", json={"library_dir": secret_path}, headers=H)
    assert r.status_code == 200
    e = audit.recent(1, kind="settings")[0]
    assert e["action"] == "save" and e["target"] == "library" and e["detail"] == {"changed": ["library_dir"]}
    assert client.delete("/api/services/library/settings", headers=H).status_code == 200
    e = audit.recent(1, kind="settings")[0]
    assert e["action"] == "reset" and e["detail"] == {"changed": ["library_dir"]}
    assert "my-very-private-folder" not in _log(tmp_path)


def test_ids_write_recorded(client, tmp_path):
    ids_file = tmp_path / "ids.txt"
    r = client.post("/api/inference-pipeline/ids/write",
                    json={"source": "text", "text": "1,2,3", "settings": {"ids_file": str(ids_file)}}, headers=H)
    assert r.status_code == 200, r.text
    e = audit.recent(1, kind="pipeline")[0]
    assert e["action"] == "ids-write" and e["target"] == str(ids_file) and e["detail"]["count"] == 3


def test_activity_events_export_and_search(client, tmp_path):
    audit.record("job", "finish", "Batched predictions", env="local", status="failed", detail={"exit_code": 1})
    audit.record("library", "run", "Prod/cleanup.sh", env="prod", detail={"job": "j1"})
    audit.record("backup", "create", "/bk/b.zip", status="succeeded", detail={"size": 10})

    data = client.get("/api/activity/events").json()
    assert [e["target"] for e in data["events"]] == ["/bk/b.zip", "Prod/cleanup.sh", "Batched predictions"]
    assert {k["kind"]: k["count"] for k in data["kinds"]} == {"backup": 1, "job": 1, "library": 1}
    assert data["stats"]["today"] == 3 and data["stats"]["jobs_failed_7d"] == 1
    assert data["stats"]["last_backup_ok"]["target"] == "/bk/b.zip"

    only = client.get("/api/activity/events", params={"kind": "job"}).json()
    assert [e["kind"] for e in only["events"]] == ["job"] and len(only["kinds"]) == 3  # chip counts ignore kind
    assert client.get("/api/activity/events", params={"env": "prod"}).json()["total"] == 1
    assert client.get("/api/activity/events", params={"status": "failed"}).json()["total"] == 1
    assert client.get("/api/activity/events", params={"since": time.time() + 60}).json()["total"] == 0

    r = client.get("/api/activity/export", params={"format": "jsonl"})
    assert r.status_code == 200 and "attachment" in r.headers["content-disposition"]
    rows = [json.loads(line) for line in r.text.splitlines()]
    assert [e["target"] for e in rows] == ["Batched predictions", "Prod/cleanup.sh", "/bk/b.zip"]  # oldest first
    txt = client.get("/api/activity/export", params={"format": "txt", "kind": "job"}).text
    assert "Batched predictions" in txt and "[local] [failed]" in txt and "exit_code=1" in txt and "cleanup" not in txt
    assert client.get("/api/activity/export", params={"format": "csv"}).status_code == 422

    groups = client.get("/api/search", params={"q": "cleanup"}).json()
    hit = next(g for g in groups if g["service"] == "activity")["results"][0]
    assert hit["title"] == "run · Prod/cleanup.sh" and float(hit["ref"]) == data["events"][1]["ts"]


def test_editing_url_of_untitled_login_never_logs_old_url(client, tmp_path):
    creds = tmp_path / "vault" / "credentials.txt"
    assert client.post("/api/manager/creds/location", json={"path": str(creds)}, headers=H).status_code == 200
    assert client.post("/api/manager/creds/entries", json={"url": URL, "password": PASSWORD}, headers=H).status_code == 200
    e0 = client.get("/api/manager/creds").json()["entries"][0]
    # what the edit form sends: every loaded field (title prefilled with the auto title) plus the change
    form = {k: e0[k] for k in ("title", "url", "username", "password", "notes", "tags")}
    r = client.put("/api/manager/creds/entries/0", json={**form, "url": "https://new.invalid", "original_hash": e0["hash"]}, headers=H)
    assert r.status_code == 200 and r.json()["title"] == "https://new.invalid"  # auto title follows the url
    e0 = client.get("/api/manager/creds").json()["entries"][0]
    assert client.delete(f"/api/manager/creds/entries/0?hash={e0['hash']}", headers=H).status_code == 200

    log = _log(tmp_path)
    assert "login.example.invalid" not in log and "new.invalid" not in log and PASSWORD not in log
    cred = [(e["action"], e["target"]) for e in audit.recent(kind="credentials")][::-1]
    assert cred[1:] == [("add", "(untitled)"), ("update", "(untitled)"), ("delete", "(untitled)")]


def test_activity_search_matches_non_ascii(client):
    audit.record("library", "create", "C/Café report.md")
    assert client.get("/api/activity/events", params={"q": "café"}).json()["total"] == 1
    assert client.get("/api/activity/events", params={"q": "CAFÉ"}).json()["total"] == 1
    groups = client.get("/api/search", params={"q": "café"}).json()
    hit = next(g for g in groups if g["service"] == "activity")["results"][0]
    assert hit["title"] == "create · C/Café report.md"
