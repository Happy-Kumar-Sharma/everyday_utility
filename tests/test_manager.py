import pytest

from app.services.manager import envfiles
from app.services.manager.envfiles import RepoStore, discover, parse_vars
from app.services.manager import credfile
from app.services.manager.credfile import CredError, CredFile

PATTERNS = envfiles.parse_patterns(".env,.env.*,*.env,*credentials*.sh")


# ---- credentials text file ----------------------------------------------------------------------
def test_credfile_roundtrip(tmp_path):
    cf = CredFile(tmp_path / "creds.txt")
    cf.add({"title": "GitHub", "url": "https://github.com", "username": "me", "password": " p@ss: word ",
            "notes": "line1\n\nline3", "tags": "git"})
    cf.add({"url": "aws.amazon.com", "password": "x"})
    text = cf.path.read_text()
    assert "=== GitHub ===" in text and "Password : " in text and "  line3" in text
    assert oct(cf.path.stat().st_mode & 0o777) == "0o600"
    a, b = cf.read()
    assert a["password"] == " p@ss: word " and a["notes"] == "line1\n\nline3" and b["title"] == "aws.amazon.com"
    cf.update(0, a["hash"], {**a, "title": "GitHub (personal)"})
    assert cf.read()[0]["title"] == "GitHub (personal)" and (tmp_path / "creds.txt.bak").exists()
    with pytest.raises(CredError, match="changed"):
        cf.delete(0, a["hash"])  # stale: entry 0 changed since `a` was read
    cf.delete(1, b["hash"])
    assert [e["title"] for e in cf.read()] == ["GitHub (personal)"]


def test_credfile_parses_hand_written_text():
    text = """# my notes
=== Jenkins ===
link: http://ci.local
user : admin
Password: s3cret
Port : 8080
Notes :
  first
  second
=== Empty ===
"""
    jenkins, empty = credfile.parse(text)
    assert jenkins["url"] == "http://ci.local" and jenkins["username"] == "admin" and jenkins["password"] == "s3cret"
    assert jenkins["notes"] == "Port : 8080\nfirst\nsecond"  # unknown keys are kept, not dropped
    assert empty["title"] == "Empty"
    # render -> parse is lossless
    assert credfile.parse(credfile.render([jenkins])) == [jenkins]


def test_credfile_validation():
    with pytest.raises(CredError):
        credfile.clean({"notes": "x"})
    with pytest.raises(CredError):
        credfile.clean({"title": "a", "password": "multi\nline"})


def test_git_safety(tmp_path):
    import subprocess

    outside = tmp_path / "elsewhere" / "creds.txt"
    assert credfile.git_safety(outside, tmp_path / "app")["safe"]

    # app folder that is not a git repo yet: judged by its .gitignore
    app = tmp_path / "app"
    app.mkdir()
    (app / ".gitignore").write_text("private/\n")
    assert credfile.git_safety(app / "private" / "c.txt", app)["safe"]
    st = credfile.git_safety(app / "notes" / "c.txt", app)
    assert not st["safe"] and st["rel"] == "notes/c.txt"
    credfile.add_to_gitignore(app, st["rel"])
    assert credfile.git_safety(app / "notes" / "c.txt", app)["safe"]  # covers the .bak as well

    # a real git repo
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    st = credfile.git_safety(repo / "c.txt", app)
    assert st["in_repo"] and not st["safe"]
    credfile.add_to_gitignore(repo, "c.txt")
    assert credfile.git_safety(repo / "c.txt", app)["safe"]


def test_creds_api_blocks_unsafe_location(tmp_path, monkeypatch):
    import importlib
    import subprocess

    from fastapi.testclient import TestClient

    from app.core import context
    from app.core.settings_store import SettingsStore
    from app.main import app

    monkeypatch.setattr(context, "settings", SettingsStore(tmp_path / "settings"))
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    H = {"x-everyday-utility": "1"}
    with TestClient(app) as c:
        r = c.post("/api/manager/creds/location", json={"path": str(repo)}, headers=H).json()
        assert r["path"].endswith("repo/credentials.txt") and not r["git"]["safe"]
        assert c.post("/api/manager/creds/entries", json={"title": "x", "password": "p"}, headers=H).status_code == 409
        assert not (repo / "credentials.txt").exists()
        r = c.post("/api/manager/creds/gitignore", headers=H).json()
        assert r["git"]["safe"]
        assert c.post("/api/manager/creds/entries", json={"title": "x", "password": "p"}, headers=H).status_code == 200
        r = c.get("/api/manager/creds").json()
        e = r["entries"][0]
        assert e["password"] == "p" and e["index"] == 0
        assert c.put("/api/manager/creds/entries/0", json={"title": "y", "original_hash": e["hash"]}, headers=H).status_code == 200
        assert c.put("/api/manager/creds/entries/0", json={"title": "z", "original_hash": e["hash"]}, headers=H).status_code == 400
        h2 = c.get("/api/manager/creds").json()["entries"][0]["hash"]
        assert c.delete("/api/manager/creds/entries/0", params={"hash": h2}, headers=H).status_code == 200


def test_parse_vars():
    text = "# c\nexport A=1\nB='two words' # comment\nexport C=\"x=y\"\nnot a var\n  D = 4\n"
    assert [(v["key"], v["value"]) for v in parse_vars(text)] == [("A", "1"), ("B", "two words"), ("C", "x=y"), ("D", "4")]


def test_discover_skips_venv(tmp_path):
    (tmp_path / "var").mkdir()
    (tmp_path / "var" / "local_credentials.sh").write_text("export A=1\n")
    (tmp_path / ".env").write_text("A=1\n")
    (tmp_path / "dev.env").write_text("A=1\n")
    (tmp_path / ".env.Zone.Identifier").write_text("")
    (tmp_path / "venv").mkdir()
    (tmp_path / "venv" / ".env").write_text("A=1\n")
    names = [p.relative_to(tmp_path).as_posix() for p in discover(tmp_path, PATTERNS, 4)]
    assert names == [".env", "dev.env", "var/local_credentials.sh"]


def test_repo_store_and_export(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / ".env").write_text("SECRET=abc\n")
    (repo / "config.txt").write_text("X=1\n")
    store = RepoStore(tmp_path / "repos.json")
    store.add_repo(str(repo))
    store.add_repo(str(repo))  # idempotent
    store.add_file(str(repo), "config.txt")
    [r] = store.repos()
    files = envfiles.repo_files(r, PATTERNS, 4)
    assert [f["rel"] for f in files] == [".env", "config.txt"] and files[1]["manual"]
    text = envfiles.export_text(store.repos(), PATTERNS, 4)
    assert "REPO: repo" in text and "SECRET=abc" in text and "==== config.txt ====" in text


def test_env_api_restricts_reads(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from app.core import context
    from app.core.settings_store import SettingsStore
    from app.main import app
    import importlib

    mgr = importlib.import_module("app.services.manager.router")

    monkeypatch.setattr(mgr, "repos", RepoStore(tmp_path / "repos.json"))
    monkeypatch.setattr(context, "settings", SettingsStore(tmp_path / "settings"))
    repo = tmp_path / "r"
    repo.mkdir()
    (repo / ".env").write_text("K=v\n")
    H = {"x-everyday-utility": "1"}
    with TestClient(app) as c:
        assert c.post("/api/manager/env/repos", json={"path": str(repo)}, headers=H).status_code == 200
        r = c.get("/api/manager/env/file", params={"path": str(repo / ".env")}).json()
        assert r["vars"] == [{"key": "K", "value": "v", "line": 1}]
        assert c.get("/api/manager/env/file", params={"path": "/etc/passwd"}).status_code == 404
        assert c.post("/api/manager/env/export", json={}).status_code == 403  # header required
        assert "K=v" in c.post("/api/manager/env/export", json={}, headers=H).text


def test_guide_backup(tmp_path, monkeypatch):
    import zipfile

    from fastapi.testclient import TestClient

    from app.core import config, context
    from app.core.settings_store import SettingsStore
    from app.main import app

    data = tmp_path / "data"
    (data / "planner").mkdir(parents=True)
    (data / "planner" / "planner.json").write_text("{}")
    monkeypatch.setattr(config, "DATA_DIR", data)
    monkeypatch.setattr(context, "settings", SettingsStore(tmp_path / "settings"))
    creds = tmp_path / "outside" / "credentials.txt"
    creds.parent.mkdir()
    creds.write_text("=== a ===\nPassword : p\n")
    H = {"x-everyday-utility": "1"}
    with TestClient(app) as c:
        c.put("/api/services/manager/settings", json={"credentials_file": str(creds)}, headers=H)
        assert c.post("/api/guide/backup", json={"dest_dir": str(config.ROOT_DIR / "x")}, headers=H).status_code == 400
        r = c.post("/api/guide/backup", json={"dest_dir": str(tmp_path / "bk"), "parts": ["planner"]}, headers=H).json()
        names = zipfile.ZipFile(r["path"]).namelist()
        assert "data/planner/planner.json" in names and "credentials/credentials.txt" in names and "RESTORE.txt" in names


def test_credfile_keeps_existing_text(tmp_path):
    f = tmp_path / "notes.txt"
    f.write_text("my old notes\nline two\n")
    cf = CredFile(f)
    cf.add({"title": "x", "password": "p"})
    cf.add({"title": "y"})
    text = f.read_text()
    assert text.count("my old notes\nline two") == 1 and text.count("# Everyday Utility credentials") == 1
    assert [e["title"] for e in cf.read()] == ["x", "y"]



# ---- regressions from the secret-safety review --------------------------------------------------
def _app_copy(tmp_path):
    app = tmp_path / "app"
    app.mkdir()
    (app / ".gitignore").write_text("private/\n")
    return app


def test_git_safety_uses_real_git_rules(tmp_path):
    app = _app_copy(tmp_path)
    credfile.add_to_gitignore(app, "logins.txt")  # anchored: /logins.txt*
    assert credfile.git_safety(app / "logins.txt", app)["safe"]
    assert not credfile.git_safety(app / "notes" / "logins.txt", app)["safe"]  # anchored rule != any depth
    (app / ".gitignore").write_text("vault*\n!vault.txt\n")
    assert not credfile.git_safety(app / "vault.txt", app)["safe"]  # negation honoured


def test_location_rules(tmp_path):
    app = _app_copy(tmp_path)
    (app / "main.py").write_text("print('hi')\n")
    with pytest.raises(CredError, match="only"):
        credfile.validate_location(app / "main.py", app)  # source files are off-limits
    with pytest.raises(CredError, match="absolute"):
        credfile.validate_location(credfile.Path("rel.txt"), app)
    notes = tmp_path / "notes.txt"
    notes.write_text("=== Heading ===\nUser: bob\n\n\tindented\n")
    with pytest.raises(CredError, match="not in the credentials format"):
        credfile.validate_location(notes, app)
    latin = tmp_path / "latin.txt"
    latin.write_bytes("caf\xe9".encode("latin-1"))
    with pytest.raises(CredError, match="UTF-8"):
        credfile.validate_location(latin, app)
    credfile.validate_location(app / "private" / "c.txt", app)  # fine
    credfile.validate_location(tmp_path / "new.txt", app)  # fine


def test_duplicate_titles_and_bom(tmp_path):
    f = tmp_path / "c.txt"
    f.write_bytes("\ufeff=== Same ===\nPassword : a\n=== Same ===\nPassword : b\n".encode())
    cf = CredFile(f)
    first, second = cf.read()
    assert first["password"] == "a"  # BOM no longer hides the first block
    cf.delete(1, second["hash"])
    with pytest.raises(CredError):
        cf.delete(1, second["hash"])  # repeated delete does not remove the other "Same"
    assert [e["password"] for e in cf.read()] == ["a"]


def test_password_alignment_and_odd_linebreaks(tmp_path):
    assert credfile.parse("=== a ===\nPassword:   hunter2\n")[0]["password"] == "hunter2"
    with pytest.raises(CredError):
        credfile.clean({"title": "a", "username": "x\u2028y"})


def test_concurrent_adds_keep_every_entry(tmp_path):
    import threading

    cf = CredFile(tmp_path / "c.txt")
    threads = [threading.Thread(target=cf.add, args=({"title": f"t{i}"},)) for i in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(cf.read()) == 20
    assert not list(tmp_path.glob("c.txt.tmp-*"))


def test_backup_refuses_git_repo(tmp_path, monkeypatch):
    import subprocess

    from fastapi.testclient import TestClient

    from app.core import context
    from app.core.settings_store import SettingsStore
    from app.main import app

    monkeypatch.setattr(context, "settings", SettingsStore(tmp_path / "settings"))
    other = tmp_path / "other"
    other.mkdir()
    subprocess.run(["git", "init", "-q", str(other)], check=True)
    with TestClient(app) as c:
        r = c.post("/api/guide/backup", json={"dest_dir": str(other), "parts": []}, headers={"x-everyday-utility": "1"})
        assert r.status_code == 400 and "git repo" in r.json()["detail"]


def test_unreadable_env_file_does_not_break_listing(tmp_path):
    import os

    repo = tmp_path / "r"
    repo.mkdir()
    (repo / ".env").write_text("A=1\n")
    bad = repo / "dev.env"
    bad.write_text("B=2\n")
    os.chmod(bad, 0)
    try:
        files = envfiles.repo_files({"path": str(repo)}, PATTERNS, 4)
        assert {f["rel"]: f["var_count"] for f in files}[".env"] == 1
    finally:
        os.chmod(bad, 0o600)
