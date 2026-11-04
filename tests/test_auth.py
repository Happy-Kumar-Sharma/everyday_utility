import asyncio
import json
import re
import shutil
import subprocess
from collections import Counter

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core import auth

H = {"x-everyday-utility": "1"}
REMOTE = "mybox.tail1234.ts.net"
PASSWORD = "correct horse battery"


@pytest.fixture()
def make_client(tmp_path, monkeypatch):
    from app.core import config, context
    from app.core.jobs import JobManager
    from app.core.settings_store import SettingsStore

    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "UPLOADS_DIR", tmp_path / "uploads")
    monkeypatch.setattr(context, "jobs", JobManager(tmp_path / "jobs"))
    monkeypatch.setattr(context, "settings", SettingsStore(tmp_path / "settings"))
    auth.reset_state()
    clients = []

    def make(remote_hosts=(), password=None, host="testserver"):
        monkeypatch.setattr(config, "REMOTE_HOSTS", tuple(remote_hosts))
        if password:
            auth.set_password(password)
        from app.main import create_app

        c = TestClient(create_app(), base_url=f"http://{host}")
        c.__enter__()
        clients.append(c)
        return c

    yield make
    for c in clients:
        c.__exit__(None, None, None)
    auth.reset_state()


def login(c, password, **headers):
    return c.post("/api/auth/login", json={"password": password}, headers=headers)


def audit_lines(tmp_path):
    p = tmp_path / "audit" / "audit.jsonl"
    return p.read_text() if p.exists() else ""


def test_default_mode_needs_no_login(make_client):
    c = make_client()
    assert c.get("/").status_code == 200
    assert c.get("/api/services").status_code == 200
    assert c.get("/api/auth/status").json() == {"remote": False, "authenticated": True, "password_set": False}
    assert c.get("/", headers={"host": "localhost:8765"}).status_code == 200
    assert c.get("/", headers={"host": "evil.example.com"}).status_code == 400


def test_untrusted_host_rejected_with_remote_configured(make_client):
    c = make_client([REMOTE], PASSWORD)
    assert c.get("/", headers={"host": "evil.example.com"}).status_code == 400


def test_remote_requires_login(make_client, tmp_path):
    c = make_client([REMOTE], PASSWORD, host=REMOTE)
    assert c.get("/api/services").status_code == 401
    r = c.get("/?x=1", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "/login?next=%2F%3Fx%3D1"
    assert c.get("/static/js/app.js", follow_redirects=False).status_code == 302
    # the login page and what it needs are public
    assert c.get("/login").status_code == 200
    assert c.get("/static/css/app.css").status_code == 200
    assert c.get("/api/auth/status").json() == {"remote": True, "authenticated": False, "password_set": True}
    assert c.post("/api/auth/logout", headers=H).status_code == 401

    r = login(c, "wrong password!")
    assert r.status_code == 401
    events = [json.loads(line) for line in audit_lines(tmp_path).splitlines()]
    assert events[-1]["kind"] == "auth" and events[-1]["status"] == "failed" and events[-1]["target"]

    r = login(c, PASSWORD)
    assert r.status_code == 200
    cookie = r.headers["set-cookie"]
    assert "eu_session=" in cookie and "HttpOnly" in cookie and "SameSite=strict" in cookie.replace("Strict", "strict")
    assert "Secure" not in cookie
    assert c.get("/api/services").status_code == 200
    assert c.get("/").status_code == 200
    assert c.get("/api/auth/status").json()["authenticated"] is True

    # logout keeps the CSRF header requirement
    assert c.post("/api/auth/logout").status_code == 403
    token = c.cookies.get("eu_session")
    assert c.post("/api/auth/logout", headers=H).status_code == 200
    c.cookies.set("eu_session", token)  # replaying the old cookie must not work
    assert c.get("/api/services").status_code == 401
    assert PASSWORD not in audit_lines(tmp_path)


def test_proxied_loopback_request_counts_as_remote(make_client):
    c = make_client([REMOTE], PASSWORD)
    assert c.get("/api/services").status_code == 200
    assert c.get("/api/services", headers={"x-forwarded-for": "100.64.0.9"}).status_code == 401
    assert c.get("/api/services", headers={"x-forwarded-host": REMOTE}).status_code == 401


def test_forwarded_headers_ignored_when_remote_off(make_client):
    # a local reverse/dev proxy in front of 127.0.0.1 keeps working when remote access isn't configured
    c = make_client()
    assert c.get("/api/services", headers={"x-forwarded-for": "127.0.0.1"}).status_code == 200
    assert c.get("/", headers={"x-forwarded-host": "127.0.0.1:8765"}).status_code == 200


def test_secure_cookie_behind_https_proxy(make_client):
    c = make_client([REMOTE], PASSWORD, host=REMOTE)
    r = login(c, PASSWORD, **{"x-forwarded-proto": "https"})
    assert "Secure" in r.headers["set-cookie"]


def test_rate_limit(make_client, tmp_path):
    c = make_client([REMOTE], PASSWORD, host=REMOTE)
    for _ in range(5):
        assert login(c, "nope nope nope").status_code == 401
    r = login(c, PASSWORD)  # even the right password is refused while locked out
    assert r.status_code == 429 and int(r.headers["retry-after"]) > 0
    # a different client is unaffected
    assert login(c, PASSWORD, **{"x-forwarded-for": "100.64.0.9, 127.0.0.1"}).status_code == 200
    assert PASSWORD not in audit_lines(tmp_path) and "nope nope" not in audit_lines(tmp_path)


def test_rate_limit_holds_under_parallel_logins(make_client, tmp_path):
    c = make_client([REMOTE], PASSWORD, host=REMOTE)

    async def burst():
        transport = httpx.ASGITransport(app=c.app)
        async with httpx.AsyncClient(transport=transport, base_url=f"http://{REMOTE}") as ac:
            return await asyncio.gather(*(ac.post("/api/auth/login", json={"password": f"guess number {i}"})
                                          for i in range(40)))

    codes = Counter(r.status_code for r in asyncio.run(burst()))
    assert codes == {401: auth.MAX_FAILURES, 429: 40 - auth.MAX_FAILURES}
    assert audit_lines(tmp_path).count('"failed"') == auth.MAX_FAILURES


def test_global_failure_cap(make_client):
    c = make_client([REMOTE], PASSWORD, host=REMOTE)
    for i in range(auth.MAX_GLOBAL_FAILURES // auth.MAX_FAILURES):
        for _ in range(auth.MAX_FAILURES):
            assert login(c, "nope nope nope", **{"x-forwarded-for": f"100.64.0.{i}"}).status_code == 401
    assert login(c, PASSWORD, **{"x-forwarded-for": "100.64.1.1"}).status_code == 429


@pytest.mark.skipif(not shutil.which("node"), reason="node not installed")
def test_login_next_stays_same_origin():
    from app.core import config

    html = (config.WEB_DIR / "login.html").read_text()
    fn = re.search(r"function nextPath\(\) \{.*?\n    \}", html, re.S).group(0)
    cases = {"?next=/%09/evil.example.com/phish": "/", "?next=/%0A%5Cevil.example.com": "/",
             "?next=//evil.com": "/", "?next=/%5Cevil.com": "/", "?next=https://evil.com": "/",
             "?next=javascript:alert(1)": "/", "?next=/.//evil.com": "https://box.ts.net//evil.com",
             "?next=/%3Fx%3D1": "https://box.ts.net/?x=1", "": "https://box.ts.net/"}
    script = (f"const location = {{origin: 'https://box.ts.net', search: ''}};\n{fn}\n"
              f"console.log(JSON.stringify({json.dumps(list(cases))}.map(q => (location.search = q, nextPath()))));")
    out = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True).stdout
    assert dict(zip(cases, json.loads(out))) == cases


def test_login_requires_json_and_same_origin(make_client):
    c = make_client([REMOTE], PASSWORD, host=REMOTE)
    assert c.post("/api/auth/login", data={"password": PASSWORD}).status_code == 415
    assert login(c, PASSWORD, origin="https://evil.example.com").status_code == 403
    assert login(c, PASSWORD, origin=f"https://{REMOTE}").status_code == 200


def test_remote_without_password_is_refused(make_client):
    c = make_client([REMOTE])
    r = c.get("/api/services", headers={"host": REMOTE})
    assert r.status_code == 503 and "set-password" in r.json()["detail"]
    assert c.get("/", headers={"host": REMOTE}).status_code == 503
    assert c.get("/login", headers={"host": REMOTE}).status_code == 503
    assert c.get("/api/services").status_code == 200


def test_changing_password_ends_sessions(make_client):
    c = make_client([REMOTE], PASSWORD, host=REMOTE)
    assert login(c, PASSWORD).status_code == 200
    assert c.get("/api/services").status_code == 200
    auth.set_password("another long password")
    assert c.get("/api/services").status_code == 401
    assert auth.clear_password() and not auth.password_set()


def test_password_storage(tmp_path, monkeypatch):
    from app.core import config

    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    with pytest.raises(ValueError):
        auth.set_password("short")
    auth.set_password(PASSWORD)
    p = tmp_path / "auth" / "password.json"
    assert p.stat().st_mode & 0o777 == 0o600
    assert PASSWORD not in p.read_text() and json.loads(p.read_text())["n"] == 2 ** 14
    assert auth.check_password(PASSWORD) and not auth.check_password(PASSWORD + "x")


def test_hostname_parsing():
    assert auth.hostname("MyBox.ts.net:443") == "mybox.ts.net"
    assert auth.hostname("[::1]:8765") == "::1"
    assert auth.hostname("127.0.0.1") == "127.0.0.1"
