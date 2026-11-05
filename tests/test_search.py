import importlib
import os

import pytest
from fastapi.testclient import TestClient

from app.core.registry import Service

H = {"x-everyday-utility": "1"}
PASSWORD = "Zq9-hunter2-secret"
ENV_VALUE = "sk_live_TOPSECRETVALUE"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    from app.core import config, context
    from app.core.jobs import JobManager
    from app.core.settings_store import SettingsStore
    mgr = importlib.import_module("app.services.manager.router")
    from app.services.manager.envfiles import RepoStore
    planner = importlib.import_module("app.services.planner.router")
    from app.services.planner.store import PlannerStore

    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(context, "jobs", JobManager(tmp_path / "jobs"))
    monkeypatch.setattr(context, "settings", SettingsStore(tmp_path / "settings"))
    monkeypatch.setattr(planner, "store", PlannerStore(tmp_path / "planner.json"))
    monkeypatch.setattr(mgr, "repos", RepoStore(tmp_path / "repos.json"))
    from app.main import app

    with TestClient(app) as c:
        yield c


def _set(client, service, values):
    r = client.put(f"/api/services/{service}/settings", headers=H, json=values)
    assert r.status_code == 200, r.text


def _group(client, q, service):
    r = client.get("/api/search", params={"q": q, "limit": 50})
    assert r.status_code == 200, r.text
    return next((g for g in r.json() if g["service"] == service), None)


# ---- planner ------------------------------------------------------------------------------------
def test_planner_ranking_and_grouping(client):
    planner = importlib.import_module("app.services.planner.router")

    s = planner.store
    done = s.add({"title": "deploy", "status": "done"})
    s.add({"title": "Prepare deploy notes"})
    s.add({"title": "deployment checklist"})
    exact = s.add({"title": "Deploy"})
    s.add({"title": "Groceries", "checklist": [{"text": "check the deploy script"}], "tags": ["home"]})
    s.add({"title": "nothing here"})
    s.set_note("2026-11-01", "standup\nasked about the deploy window\n")

    g = _group(client, "deploy", "planner")
    assert g["title"] == "Planner" and g["icon"] == "✅"
    refs = [r["ref"] for r in g["results"]]
    titles = [r["title"] for r in g["results"]]
    assert refs[0] == f"task:{exact['id']}"  # exact
    assert titles[1] == "deployment checklist"  # prefix
    assert titles[2] == "Prepare deploy notes"  # word
    assert refs[-1] == f"task:{done['id']}"  # done ranked after every open match, even an exact one
    assert "nothing here" not in titles
    groceries = next(r for r in g["results"] if r["title"] == "Groceries")
    assert groceries["subtitle"] == "check the deploy script"
    note = next(r for r in g["results"] if r["ref"] == "note:2026-11-01")
    assert note["subtitle"] == "asked about the deploy window"
    assert all(r["service"] == "planner" for r in g["results"])


def test_search_empty_query_and_limit(client):
    planner = importlib.import_module("app.services.planner.router")

    for n in range(12):
        planner.store.add({"title": f"task {n}"})
    assert client.get("/api/search", params={"q": "  "}).json() == []
    g = next(g for g in client.get("/api/search", params={"q": "task"}).json() if g["service"] == "planner")
    assert len(g["results"]) == 8  # default limit per provider


# ---- library ------------------------------------------------------------------------------------
def test_library_search(client, tmp_path):
    from app.services.library.store import Library

    root = tmp_path / "lib"
    lib = Library(root)
    lib.create("Prod queries", "daily_assessments", "sql", "-- daily\nSELECT * FROM assessments\nWHERE day = now()", {"tags": ["reports"]})
    lib.create("Commands", "assessments", "sh", "echo hi", {})
    lib.create("Commands", "restart", "sh", "systemctl restart x", {"description": "restart the assessments worker"})
    _set(client, "library", {"library_dir": str(root)})

    g = _group(client, "assessments", "library")
    assert [r["title"] for r in g["results"]] == ["assessments", "daily_assessments", "restart"]
    daily = g["results"][1]
    assert daily["ref"] == "Prod queries/daily_assessments.sql" and daily["icon"] == "🗄️"
    assert daily["subtitle"] == "Prod queries · SELECT * FROM assessments"
    tagged = _group(client, "reports", "library")["results"]
    assert [r["title"] for r in tagged] == ["daily_assessments"]


def test_library_missing_or_unsafe_folder(client, tmp_path):
    from app.core import config

    _set(client, "library", {"library_dir": str(tmp_path / "does-not-exist")})
    r = client.get("/api/search", params={"q": "x"})
    assert r.status_code == 200 and _group(client, "x", "library") is None
    _set(client, "library", {"library_dir": str(config.ROOT_DIR / "app")})  # inside the app, outside private/
    assert _group(client, "registry", "library") is None


# ---- manager ------------------------------------------------------------------------------------
@pytest.fixture()
def manager_data(client, tmp_path):
    mgr = importlib.import_module("app.services.manager.router")
    from app.services.manager.credfile import CredFile

    cred = tmp_path / "outside" / "credentials.txt"
    cf = CredFile(cred)
    cf.add({"title": "GitHub", "url": "https://github.com/login", "username": "octo@example.com", "password": PASSWORD,
            "notes": f"recovery {PASSWORD}"})
    cf.add({"title": "Grafana prod", "url": "", "username": "admin", "password": "x"})
    _set(client, "manager", {"credentials_file": str(cred)})
    repo = tmp_path / "repos" / "billing-api"
    repo.mkdir(parents=True)
    (repo / ".env").write_text(f"STRIPE_KEY={ENV_VALUE}\nDATABASE_URL=postgres://u:{PASSWORD}@db/x\n")
    mgr.repos.add_repo(str(repo))
    return {"repo": repo.resolve(), "entries": cf.read()}


def test_manager_logins(client, manager_data):
    gh = manager_data["entries"][0]
    g = _group(client, "github", "manager")
    assert g["results"][0] == {"title": "GitHub", "subtitle": "https://github.com/login", "icon": "🔑",
                               "ref": f"login:0:{gh['hash']}", "service": "manager"}
    graf = _group(client, "admin", "manager")["results"]
    assert graf[0]["title"] == "Grafana prod" and graf[0]["subtitle"] == "admin"  # no URL: username instead


def test_manager_env(client, manager_data):
    repo = manager_data["repo"]
    g = _group(client, "billing", "manager")
    assert g["results"][0] == {"title": "billing-api", "subtitle": str(repo), "icon": "📁", "ref": f"repo:{repo}", "service": "manager"}
    hit = _group(client, "stripe", "manager")["results"]
    assert hit == [{"title": ".env", "subtitle": "billing-api · STRIPE_KEY", "icon": "🧾", "ref": f"envfile:{repo / '.env'}",
                    "service": "manager"}]


@pytest.mark.skipif(getattr(os, "geteuid", lambda: -1)() == 0, reason="root can read chmod 000 files")
def test_manager_unreadable_env_file(client, manager_data):
    bad = manager_data["repo"] / "secrets.env"
    bad.write_text("X=1\n")
    bad.chmod(0)
    try:
        titles = [r["title"] for r in _group(client, "github", "manager")["results"]]
        assert titles == ["GitHub"]  # logins survive; no "search failed" row
        assert _group(client, "billing", "manager")["results"][0]["title"] == "billing-api"
    finally:
        bad.chmod(0o600)


@pytest.mark.parametrize("q", [PASSWORD, PASSWORD.lower(), "hunter2", ENV_VALUE, "TOPSECRET", "recovery", "postgres://u"])
def test_secrets_never_searched_or_returned(client, manager_data, q):
    r = client.get("/api/search", params={"q": q, "limit": 50})
    assert r.status_code == 200
    body = r.text
    assert PASSWORD not in body and ENV_VALUE not in body
    assert _group(client, q, "manager") is None


def test_secrets_absent_from_broad_results(client, manager_data):
    for q in ("e", "a", "."):
        body = client.get("/api/search", params={"q": q, "limit": 50}).text
        assert PASSWORD not in body and ENV_VALUE not in body


# ---- robustness ---------------------------------------------------------------------------------
def test_failing_provider_does_not_break_search(client, monkeypatch):
    from dataclasses import replace

    from app.core import context
    planner = importlib.import_module("app.services.planner.router")

    planner.store.add({"title": "find me"})

    def boom(q):
        raise RuntimeError("provider exploded")

    bad = replace(context.services["library"], search=boom)
    monkeypatch.setitem(context.services, "library", bad)
    r = client.get("/api/search", params={"q": "find"})
    assert r.status_code == 200
    groups = {g["service"]: g for g in r.json()}
    assert groups["planner"]["results"][0]["title"] == "find me"
    assert groups["library"]["results"][0]["icon"] == "⚠️"


def test_service_without_search_is_skipped(client):
    from app.core import context

    assert isinstance(context.services["column-extractor"], Service)
    assert context.services["column-extractor"].search is None
    assert all(g["service"] != "column-extractor" for g in client.get("/api/search", params={"q": "a"}).json())
