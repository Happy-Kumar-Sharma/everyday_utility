import pytest
from fastapi.testclient import TestClient

from app.services.devtools import SERVICE, TOOLS, search


@pytest.fixture()
def client(tmp_path, monkeypatch):
    from app.core import config, context
    from app.core.jobs import JobManager
    from app.core.settings_store import SettingsStore

    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(context, "jobs", JobManager(tmp_path / "jobs"))
    monkeypatch.setattr(context, "settings", SettingsStore(tmp_path / "settings"))
    from app.main import app

    with TestClient(app) as c:
        yield c


def test_service_definition():
    assert (SERVICE.id, SERVICE.title, SERVICE.icon, SERVICE.order) == ("devtools", "Dev Tools", "🛠", 15)
    assert SERVICE.search is search


@pytest.mark.parametrize("query, ref", [
    ("jwt", "jwt"), ("epoch", "time"), ("SHA256", "hash"), ("snake case", "text"),
    ("guid", "uuid"), ("query params", "url"), ("regexp", "regex"), ("b64", "base64"), ("pretty", "json"),
])
def test_search_by_keyword(query, ref):
    assert ref in [r["ref"] for r in search(query)]


def test_search_result_shape_and_no_match():
    results = search("diff")
    assert {r["ref"] for r in results} == {"json", "diff"}
    assert all(set(r) == {"title", "subtitle", "icon", "ref"} and r["ref"] in TOOLS for r in results)
    assert search("nothing-like-this") == []


def test_tool_keys_match_frontend():
    from app.core import config

    js = (config.WEB_DIR / "js" / "services" / "devtools.js").read_text()
    for key in TOOLS:
        assert f"['{key}'," in js


def test_global_search_endpoint(client):
    groups = client.get("/api/search", params={"q": "base64"}).json()
    group = next(g for g in groups if g["service"] == "devtools")
    assert group["results"][0] == {**group["results"][0], "ref": "base64", "service": "devtools"}
    assert any(s["id"] == "devtools" for s in client.get("/api/services").json())


def test_frontend_files_served(client):
    for path in ("js/services/devtools.js", "js/services/devtools/logic.js",
                 "js/services/devtools/regex-worker.js", "css/devtools.css"):
        assert client.get(f"/static/{path}").status_code == 200


def _run_logic(script):
    """Runs `script` as an ES module with logic.js imported as L; returns its printed JSON."""
    import json
    import shutil
    import subprocess

    from app.core import config

    if not shutil.which("node"):
        pytest.skip("node is not installed")
    logic = (config.WEB_DIR / "js" / "services" / "devtools" / "logic.js").as_uri()
    src = f"import * as L from '{logic}';\n{script}"
    out = subprocess.run(["node", "--input-type=module", "-e", src], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def test_json_diff_ignores_prototype_names():
    r = _run_logic("""console.log(JSON.stringify([
      L.jsonDiff(JSON.parse('{"constructor":1,"toString":2}'), {}),
      L.jsonDiff({}, JSON.parse('{"__proto__":{"x":1}}')),
      L.jsonDiff(JSON.parse('{"__proto__":1}'), {}),
    ]));""")
    assert [(c["op"], c["path"]) for c in r[0]] == [("removed", "$.constructor"), ("removed", "$.toString")]
    assert [(c["op"], c["path"]) for c in r[1]] == [("added", "$.__proto__")]
    assert [c["op"] for c in r[2]] == ["removed"]


def test_jwt_rejects_non_object_parts():
    r = _run_logic("""const err = (t) => { try { L.decodeJwt(t); return null; } catch (e) { return e.message; } };
    console.log(JSON.stringify([err('eyJhbGciOiJub25lIn0.bnVsbA.'), err('MQ.e30.'), err('eyJhbGciOiJub25lIn0.e30.')]));""")
    assert r == ["The payload is not a JSON object.", "The header is not a JSON object.", None]


def test_json_flags_unsafe_integers():
    r = _run_logic("""console.log(JSON.stringify([
      L.parseJson('{"id": 12345678901234567890, "s": "99999999999999999999", "n": [9007199254740991, -9007199254740993, 1e400, 1.5]}').unsafeInts,
      L.parseJson('[1, 2]').unsafeInts,
    ]));""")
    assert r == [["12345678901234567890", "-9007199254740993"], []]


def test_parse_url_tolerates_malformed_escapes():
    r = _run_logic("""const u = L.parseUrl('https://x.com/%E0%A4%A?q=1#a%ZZ');
    const ok = L.parseUrl('https://x.com/caf%C3%A9#%C3%A9');
    console.log(JSON.stringify([u.path, u.hash, u.params, ok.path, ok.hash]));""")
    assert r == ["/%E0%A4%A", "a%ZZ", [["q", "1"]], "/café", "é"]
