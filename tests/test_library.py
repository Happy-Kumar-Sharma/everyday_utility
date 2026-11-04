import subprocess

import pytest
from fastapi.testclient import TestClient

from app.services.library.router import render_template
from app.services.library.starters import STARTERS
from app.services.library.store import Library, LibraryError

H = {"x-everyday-utility": "1"}


@pytest.fixture()
def lib(tmp_path):
    return Library(tmp_path / "lib")


def test_create_list_update_move(lib):
    item = lib.create("Prod queries", "daily", "sql", "SELECT 1;\n", {"tags": "#Reports, daily", "env": "prod", "favorite": True})
    assert item["path"] == "Prod queries/daily.sql" and item["type"] == "sql"
    assert item["tags"] == ["reports", "daily"] and item["env"] == "prod" and item["favorite"]
    assert (lib.root / "Prod queries" / "daily.sql").read_text() == "SELECT 1;\n"
    with pytest.raises(LibraryError, match="exists"):
        lib.create("Prod queries", "daily", "sql", "", {})
    moved = lib.update(item["path"], content="SELECT 2;\n", meta={"description": "d"}, expected_mtime=item["mtime"],
                       collection="Staging queries", name="daily2")
    assert moved["path"] == "Staging queries/daily2.sql" and moved["favorite"] and moved["description"] == "d"
    assert not (lib.root / "Prod queries" / "daily.sql").exists()
    with pytest.raises(LibraryError, match="changed"):
        lib.update(moved["path"], content="x", meta={}, expected_mtime=moved["mtime"] - 100)


def test_hand_made_files_show_up(lib):
    (lib.root / "Commands").mkdir(parents=True)
    (lib.root / "Commands" / "deploy.sh").write_text("echo hi\n")
    (lib.root / "Commands" / ".hidden").write_text("x")
    [item] = lib.items()
    assert item["type"] == "shell" and item["uses"] == 0 and item["collection"] == "Commands"
    assert lib.collections() == ["Commands"]


def test_paths_cannot_escape(lib):
    lib.create("", "a", "sql", "", {})
    for bad in ("../x", "/etc/passwd", ".trash/x", "a/../../x"):
        with pytest.raises(LibraryError):
            lib.get(bad)
    for bad in ("..", ".git", "a/b"):
        with pytest.raises(LibraryError):
            lib.create("", bad, "sql", "", {})
    with pytest.raises(LibraryError):
        lib.create("../outside", "x", "sql", "", {})


def test_trash_and_restore(lib):
    lib.create("C", "q", "sql", "SELECT 1", {"favorite": True})
    tid = lib.delete("C/q.sql")
    assert lib.items() == [] and lib.trash()[0]["path"] == "C/q.sql"
    restored = lib.restore(tid)
    assert restored["path"] == "C/q.sql" and restored["favorite"]


def test_collections(lib):
    assert lib.create_collection("Prod queries/Reports") == "Prod queries/Reports"
    lib.create("Prod queries/Reports", "r", "sql", "", {"tags": ["x"]})
    assert lib.rename_collection("Prod queries", "Prod") == "Prod"
    [item] = lib.items()
    assert item["path"] == "Prod/Reports/r.sql" and item["tags"] == ["x"]  # metadata followed the move
    with pytest.raises(LibraryError, match="not empty"):
        lib.delete_collection("Prod")


def test_uses_and_seed(lib):
    created = lib.seed(STARTERS)
    assert created == len(STARTERS) and lib.seed(STARTERS) == 0  # idempotent
    path = lib.items()[0]["path"]
    lib.touch_use(path)
    lib.touch_use(path)
    assert lib.get(path)["uses"] == 2 and lib.get(path)["last_used"]


def test_render_template():
    assert render_template("IN ({{ids}}) AND t IN ({{types:1,2}})", {"ids": "5,6"}) == "IN (5,6) AND t IN (1,2)"
    assert render_template("{{today}}", {}).count("-") == 2
    with pytest.raises(LibraryError):
        render_template("{{missing}}", {})


def test_api_blocks_unignored_folder_and_runs_shell(tmp_path, monkeypatch):
    from app.core import context
    from app.core.jobs import JobManager
    from app.core.settings_store import SettingsStore
    from app.main import app

    monkeypatch.setattr(context, "settings", SettingsStore(tmp_path / "settings"))
    monkeypatch.setattr(context, "jobs", JobManager(tmp_path / "jobs"))
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    with TestClient(app) as c:
        c.put("/api/services/library/settings", json={"library_dir": str(repo / "lib")}, headers=H)
        st = c.get("/api/library/items").json()
        assert not st["git"]["safe"]
        assert c.post("/api/library/items", json={"name": "x", "type": "sql"}, headers=H).status_code == 409

        c.put("/api/services/library/settings", json={"library_dir": str(tmp_path / "lib")}, headers=H)
        r = c.post("/api/library/items", json={"collection": "Commands", "name": "hello", "type": "shell",
                                               "content": "echo hi {{who:there}}"}, headers=H)
        assert r.status_code == 200 and r.json()["path"] == "Commands/hello.sh"
        job = c.post("/api/library/run", json={"path": "Commands/hello.sh", "values": {"who": "you"}}, headers=H).json()
        j = context.jobs.get(job["id"])
        import time
        for _ in range(100):
            if j.done:
                break
            time.sleep(0.05)
        assert j.output_since(0)["lines"] == ["hi you"]
        assert c.get("/api/library/items").json()["items"][0]["uses"] == 1
        assert c.post("/api/library/run", json={"path": "../etc/passwd"}, headers=H).status_code == 400


def test_large_file_content_never_overwritten(lib):
    from app.services.library import store

    lib.create("", "big", "sql", "x" * (store.MAX_CONTENT + 10), {})
    item = lib.get("big.sql")
    assert item["truncated"] and item["content"] == ""
    with pytest.raises(LibraryError, match="too large"):
        lib.update("big.sql", content="", meta={}, expected_mtime=item["mtime"])
    lib.update("big.sql", content=None, meta={"favorite": True}, expected_mtime=item["mtime"])  # metadata still editable
    assert (lib.root / "big.sql").stat().st_size == store.MAX_CONTENT + 10


# ---- regressions from the Library review ---------------------------------------------------------
def test_trash_ids_unique_and_restore_never_overwrites(lib):
    lib.create("a", "b", "sql", "FIRST", {})
    lib.create("", "a__b", "sql", "SECOND", {})
    t1, t2 = lib.delete("a/b.sql"), lib.delete("a__b.sql")
    assert t1 != t2 and len(lib.trash()) == 2
    ids = []
    for v in ("v1", "v2"):
        lib.create("C", "q", "sql", v, {})
        ids.append(lib.delete("C/q.sql"))
    lib.create("C", "q", "sql", "v3", {})
    restored = sorted(lib.restore(t)["content"] for t in ids)
    assert restored == ["v1", "v2"] and lib.get("C/q.sql")["content"] == "v3"


def test_symlinks_outside_are_ignored(lib, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.sql").write_text("SECRET")
    lib.create("C", "ok", "sql", "x", {})
    (lib.root / "Linked").symlink_to(outside)
    (lib.root / "C" / "link.sql").symlink_to(outside / "secret.sql")
    (lib.root / "C" / "dangling.sql").symlink_to(tmp_path / "nope.sql")
    assert [i["path"] for i in lib.items()] == ["C/ok.sql"] and lib.collections() == ["C"]


def test_rename_into_itself_and_hidden_files_protected(lib):
    lib.create_collection("R")
    with pytest.raises(LibraryError, match="itself"):
        lib.rename_collection("R", "R/S")
    (lib.root / "R" / ".notes").write_text("keep me")
    with pytest.raises(LibraryError, match="not empty"):
        lib.delete_collection("R")
    lib.create_collection("Empty/Sub")
    lib.delete_collection("Empty")
    assert "Empty" not in lib.collections()


def test_files_preserved_byte_for_byte(lib):
    import os
    import stat

    (lib.root / "Cmd").mkdir(parents=True)
    script = lib.root / "Cmd" / "deploy.sh"
    script.write_bytes(b"echo a\r\necho b\r\n")
    os.chmod(script, 0o755)
    (lib.root / "Makefile").write_text("all:\n")
    (lib.root / "latin.sql").write_bytes("SELECT 'caf\xe9';".encode("latin-1"))

    item = lib.get("Cmd/deploy.sh")
    assert item["content"] == "echo a\r\necho b\r\n"  # CRLF kept
    lib.update("Cmd/deploy.sh", content="echo c\n", meta={}, expected_mtime=item["mtime"])
    assert stat.S_IMODE(script.stat().st_mode) == 0o755  # execute bit kept

    mk = lib.get("Makefile")
    assert mk["ext"] == "" and lib.update("Makefile", content=None, meta={"tags": "build"}, expected_mtime=mk["mtime"])["path"] == "Makefile"

    lat = lib.get("latin.sql")
    assert lat["binary"] and lat["content"] == ""
    with pytest.raises(LibraryError, match="not UTF-8"):
        lib.update("latin.sql", content="x", meta={}, expected_mtime=lat["mtime"])


def test_duplicate_copies_bytes(lib):
    from app.services.library import store

    lib.create("", "big", "sql", "y" * (store.MAX_CONTENT + 1), {"favorite": True})
    dup = lib.duplicate("big.sql")
    assert dup["path"] == "big copy.sql" and dup["size"] == store.MAX_CONTENT + 1 and not dup["favorite"]
    assert lib.duplicate("big.sql")["path"] == "big copy 2.sql"


def test_concurrent_metadata_updates(tmp_path):
    import threading

    root = tmp_path / "lib"
    Library(root).create("", "q", "sql", "x", {})
    threads = [threading.Thread(target=lambda: Library(root).touch_use("q.sql")) for _ in range(30)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert Library(root).get("q.sql")["uses"] == 30


def test_dir_safety_covers_every_extension_and_tracked_files(tmp_path):
    from app.core.gitsafety import dir_safety

    repo = tmp_path / "repo"
    (repo / "snips").mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    (repo / ".gitignore").write_text("*.sql\n.library.json\n")
    assert not dir_safety(repo / "snips", tmp_path)["safe"]  # .sh / .trash would still be committed
    (repo / ".gitignore").write_text("snips/\n")
    assert dir_safety(repo / "snips", tmp_path)["safe"]

    repo2 = tmp_path / "repo2"
    (repo2 / "lib" / "Commands").mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(repo2)], check=True)
    (repo2 / "lib" / "Commands" / "x.sh").write_text("echo")
    subprocess.run(["git", "-C", str(repo2), "add", "-A"], check=True)
    (repo2 / ".gitignore").write_text("lib/\n")
    assert not dir_safety(repo2 / "lib", tmp_path)["safe"]  # ignored now, but x.sh is already tracked
