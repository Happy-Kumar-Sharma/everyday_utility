"""Dev Tools — web & ops group: 📡 API tester (backend proxy + api.logic.js) and 🖼️ Image tool (image.logic.js)."""

from __future__ import annotations

import base64
import json
import shutil
import socket
import struct
import subprocess
import threading
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient

H = {"x-everyday-utility": "1"}
SEND = "/api/devtools/api/send"


# ------------------------------------------------------------------ fixtures
@pytest.fixture()
def client(tmp_path, monkeypatch):
    from app.core import config, context
    from app.core.jobs import JobManager
    from app.core.settings_store import SettingsStore

    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(context, "jobs", JobManager(tmp_path / "jobs"))
    monkeypatch.setattr(context, "settings", SettingsStore(tmp_path / "settings"))
    for var in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.delenv(var, raising=False)
    from app.main import app

    with TestClient(app) as c:
        yield c


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # keep test output quiet
        pass

    def _send(self, code, body: bytes, ctype="application/json", extra=()):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in extra:
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _handle(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        path = self.path
        if path.startswith("/redirect"):
            return self._send(302, b"", "text/plain", [("Location", "/hop")])
        if path.startswith("/hop"):
            return self._send(301, b"", "text/plain", [("Location", "/echo?after=redirect")])
        if path.startswith("/big"):
            return self._send(200, b"x" * (6 * 1024 * 1024), "text/plain")
        if path.startswith("/bin"):
            return self._send(200, bytes(range(256)) * 4, "application/octet-stream")
        if path.startswith("/slow"):
            time.sleep(3)
            return self._send(200, b"late", "text/plain")
        if path.startswith("/status/"):
            return self._send(int(path.split("/")[2]), b'{"error": "nope"}')
        echo = {"method": self.command, "path": path, "headers": dict(self.headers.items()),
                "body": body.decode("utf-8", "replace")}
        return self._send(200, json.dumps(echo).encode(), extra=[("X-Multi", "a"), ("X-Multi", "b")])

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = _handle


@pytest.fixture(scope="module")
def server():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def audit_text(tmp_path) -> str:
    p = tmp_path / "audit" / "audit.jsonl"
    return p.read_text() if p.exists() else ""


# ------------------------------------------------------------------ backend: sending
def test_send_get_echo(client, server):
    r = client.post(SEND, json={"method": "get", "url": f"{server}/echo?a=1&b=two",
                                "headers": [["X-Test", "yes"], ["Accept", "application/json"]]}, headers=H)
    assert r.status_code == 200, r.text
    d = r.json()
    assert (d["status"], d["reason"], d["http_version"]) == (200, "OK", "HTTP/1.1")
    echo = json.loads(d["body_text"])
    assert echo["method"] == "GET" and echo["path"] == "/echo?a=1&b=two"
    assert echo["headers"]["X-Test"] == "yes"
    assert d["body_base64"] is None and d["truncated"] is False and d["redirects"] == []
    assert d["size"] == len(d["body_text"].encode()) and d["elapsed_ms"] >= 0
    assert ["X-Multi", "a"] in d["headers"] and ["X-Multi", "b"] in d["headers"]  # repeated headers kept


def test_send_post_body_and_base64_body(client, server):
    r = client.post(SEND, json={"method": "POST", "url": f"{server}/echo", "headers": [["Content-Type", "application/json"]],
                                "body": '{"name": "Zoë"}'}, headers=H).json()
    echo = json.loads(r["body_text"])
    assert echo["method"] == "POST" and echo["body"] == '{"name": "Zoë"}'
    r = client.post(SEND, json={"method": "PUT", "url": f"{server}/echo",
                                "body_base64": base64.b64encode(b"raw-bytes").decode()}, headers=H).json()
    assert json.loads(r["body_text"])["body"] == "raw-bytes"


def test_send_drops_stale_content_length(client, server):
    r = client.post(SEND, json={"method": "POST", "url": f"{server}/echo", "headers": [["Content-Length", "999"]],
                                "body": "abc"}, headers=H).json()
    assert json.loads(r["body_text"])["headers"]["Content-Length"] == "3"


def test_binary_body_is_base64(client, server):
    d = client.post(SEND, json={"url": f"{server}/bin"}, headers=H).json()
    assert d["body_text"] is None
    assert base64.b64decode(d["body_base64"]) == bytes(range(256)) * 4
    assert d["size"] == 1024


def test_large_body_truncated_at_5mb(client, server):
    d = client.post(SEND, json={"url": f"{server}/big"}, headers=H).json()
    assert d["truncated"] is True and d["size"] == 5 * 1024 * 1024 and len(d["body_text"]) == 5 * 1024 * 1024


def test_redirects_followed_or_not(client, server):
    d = client.post(SEND, json={"url": f"{server}/redirect", "follow_redirects": True}, headers=H).json()
    assert d["status"] == 200
    assert [u.split("127.0.0.1")[1].split("/", 1)[1] for u in d["redirects"]] == ["hop", "echo?after=redirect"]
    d = client.post(SEND, json={"url": f"{server}/redirect", "follow_redirects": False}, headers=H).json()
    assert d["status"] == 302 and ["Location", "/hop"] in [[k.title(), v] for k, v in d["headers"]] and d["redirects"] == []


def test_error_status_is_returned_not_raised(client, server):
    d = client.post(SEND, json={"url": f"{server}/status/404"}, headers=H).json()
    assert d["status"] == 404 and d["body_text"] == '{"error": "nope"}'


def test_head_request(client, server):
    d = client.post(SEND, json={"method": "HEAD", "url": f"{server}/echo"}, headers=H).json()
    assert d["status"] == 200 and d["size"] == 0


@pytest.mark.parametrize("url", ["ftp://example.com/x", "file:///etc/passwd", "javascript:alert(1)", "gopher://h/", "example.com", "http://"])
def test_rejects_non_http_urls(client, url):
    r = client.post(SEND, json={"url": url}, headers=H)
    assert r.status_code == 400


@pytest.mark.parametrize("payload", [
    {"method": "GE T"}, {"headers": [["Bad Header", "x"]]}, {"headers": [["X-A", "line\r\nInjected: 1"]]},
    {"headers": [["only-one"]]}, {"body_base64": "not base64!!"},
])
def test_rejects_bad_requests(client, server, payload):
    r = client.post(SEND, json={"url": f"{server}/echo", **payload}, headers=H)
    assert r.status_code == 400, r.text


@pytest.mark.parametrize("timeout", [0, 0.5, 121])
def test_timeout_range(client, server, timeout):
    assert client.post(SEND, json={"url": f"{server}/echo", "timeout_s": timeout}, headers=H).status_code == 422


def test_connection_refused_is_502(client):
    r = client.post(SEND, json={"url": f"http://127.0.0.1:{free_port()}/"}, headers=H)
    assert r.status_code == 502 and "refused" in r.json()["detail"].lower()


def test_dns_failure_is_502(client):
    r = client.post(SEND, json={"url": "http://no-such-host.invalid/"}, headers=H)
    assert r.status_code == 502
    assert r.json()["detail"].startswith(("DNS lookup failed", "Could not connect"))


def test_timeout_is_502(client, server):
    t = time.time()
    r = client.post(SEND, json={"url": f"{server}/slow", "timeout_s": 1}, headers=H)
    assert r.status_code == 502 and "Timed out after 1 s" in r.json()["detail"]
    assert time.time() - t < 2.8


def test_tls_error_is_502(client, server):
    # an https request to a plain-http port fails the TLS handshake
    r = client.post(SEND, json={"url": server.replace("http://", "https://") + "/echo", "timeout_s": 5}, headers=H)
    assert r.status_code == 502
    assert r.json()["detail"]


def test_requires_csrf_header(client, server):
    assert client.post(SEND, json={"url": f"{server}/echo"}).status_code == 403


def test_remote_requires_login(tmp_path, monkeypatch, server):
    from app.core import auth, config, context
    from app.core.jobs import JobManager
    from app.core.settings_store import SettingsStore

    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(context, "jobs", JobManager(tmp_path / "jobs"))
    monkeypatch.setattr(context, "settings", SettingsStore(tmp_path / "settings"))
    monkeypatch.setattr(config, "REMOTE_HOSTS", ("mybox.tail1234.ts.net",))
    auth.reset_state()
    auth.set_password("correct horse battery")
    from app.main import create_app

    try:
        with TestClient(create_app(), base_url="http://mybox.tail1234.ts.net") as c:
            r = c.post(SEND, json={"url": f"{server}/echo"}, headers=H)
            assert r.status_code == 401
    finally:
        auth.reset_state()


def test_audit_has_no_query_headers_body_or_userinfo(client, server, tmp_path):
    host_port = server.split("://")[1]
    url = f"http://alice:PASSW0RDX@{host_port}/echo/items?token=QUERYSECRET&x=1#frag"
    r = client.post(SEND, json={"method": "POST", "url": url, "headers": [["Authorization", "Bearer HEADERSECRET"]],
                                "body": "BODYSECRET"}, headers=H)
    assert r.status_code == 200
    client.post(SEND, json={"url": f"http://127.0.0.1:{free_port()}/down?key=QUERYSECRET2"}, headers=H)
    text = audit_text(tmp_path)
    for secret in ("QUERYSECRET", "HEADERSECRET", "BODYSECRET", "PASSW0RDX", "alice", "token=", "frag"):
        assert secret not in text
    events = [json.loads(line) for line in text.splitlines()]
    http = [e for e in events if e["kind"] == "http"]
    assert http[0]["action"] == "POST" and http[0]["target"] == f"http://{host_port}/echo/items" and http[0]["status"] == "200"
    assert http[1]["status"] == "error" and http[1]["target"].endswith("/down")


def test_audit_target_helper():
    from app.services.devtools.api_proxy import audit_target

    assert audit_target("https://u:p@Example.com:8443/a/b?q=1#x") == "https://example.com:8443/a/b"
    assert audit_target("http://[::1]:80/x?y") == "http://[::1]:80/x"


# ------------------------------------------------------------------ node: logic modules
def _node(module: str, script: str):
    from app.core import config

    if not shutil.which("node"):
        pytest.skip("node is not installed")
    logic = (config.WEB_DIR / "js" / "services" / "devtools" / "tools" / module).as_uri()
    src = f"import * as L from '{logic}';\n{script}"
    out = subprocess.run(["node", "--input-type=module", "-e", src], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def api(script):
    return _node("api.logic.js", script)


def img(script):
    return _node("image.logic.js", script)


def test_api_query_sync_keeps_placeholders():
    r = api("""console.log(JSON.stringify([
      L.parseQuery('https://x.io/a?b=1&c=hello%20world&flag&d=a+b#top'),
      L.withQuery('https://x.io/a?old=1#top', [{key: 'q', value: 'a b&c', on: true}, {key: 'id', value: '{{id}}', on: true},
        {key: 'off', value: '1', on: false}, {key: 'flag', value: '', on: true, bare: true}]),
      L.withQuery('{{base}}/items?x=1', []),
      L.splitUrl('{{base}}/p?q={{v}}#h'),
    ]));""")
    assert r[0] == [{"key": "b", "value": "1", "on": True}, {"key": "c", "value": "hello world", "on": True},
                    {"key": "flag", "value": "", "on": True, "bare": True}, {"key": "d", "value": "a b", "on": True}]
    assert r[1] == "https://x.io/a?q=a%20b%26c&id={{id}}&flag#top"
    assert r[2] == "{{base}}/items"
    assert r[3] == {"base": "{{base}}/p", "query": "q={{v}}", "hash": "#h"}


def test_api_build_request_auth_body_and_variables():
    r = api("""const s = {method: 'post', url: '{{base}}/users?id={{id}}', headers: [{key: 'X-Env', value: '{{env}}', on: true},
      {key: 'X-Off', value: 'no', on: false}], bodyType: 'json', body: '{"id": {{id}}}', auth: {type: 'bearer', token: '{{token}}'}};
    const basic = {method: 'GET', url: 'http://h/', headers: [], bodyType: 'form', form: [{key: 'a b', value: 'x&y', on: true}],
      auth: {type: 'basic', user: 'zoë', password: 'p:w'}};
    console.log(JSON.stringify([
      L.buildRequest(s, {base: 'https://api.test', id: '7', env: 'dev', token: 'T0K'}),
      L.buildRequest(s, {base: 'https://api.test'}).problems,
      L.buildRequest(basic, {}),
      L.buildRequest({...s, url: 'ftp://x'}, {id: '1', env: 'e', token: 't'}).problems,
      L.buildRequest({...s, body: '{bad'}, {base: 'http://x', id: '1', env: 'e', token: 't'}).problems,
      L.requestVariables(s),
    ]));""")
    full = r[0]
    assert full["method"] == "POST" and full["url"] == "https://api.test/users?id=7"
    assert full["headers"] == [["X-Env", "dev"], ["Authorization", "Bearer T0K"], ["Content-Type", "application/json"]]
    assert full["body"] == '{"id": 7}' and full["problems"] == []
    assert any("{{id}}" in p and "{{token}}" in p for p in r[1])
    b = r[2]
    assert b["body"] == "a+b=x%26y"
    assert ["Authorization", "Basic " + base64.b64encode("zoë:p:w".encode()).decode()] in b["headers"]
    assert ["Content-Type", "application/x-www-form-urlencoded"] in b["headers"]
    assert any("http://" in p for p in r[3])
    assert any(p.startswith("Body is not valid JSON") for p in r[4])
    assert r[5] == ["base", "id", "env", "token"]


def test_api_curl_and_status_kind():
    r = api("""console.log(JSON.stringify([
      L.toCurl({method: 'GET', url: 'https://x.io/a?b=1', headers: [], body: null}, {follow: false}),
      L.toCurl({method: 'POST', url: 'https://x.io/a', headers: [['Content-Type', 'application/json']], body: `{"it's": 1}`}, {insecure: true}),
      L.toCurl({method: 'HEAD', url: 'http://h/', headers: [], body: null}, {follow: false}),
      [200, 204, 301, 304, 404, 500, 99].map(L.statusKind),
    ]));""")
    assert r[0] == "curl 'https://x.io/a?b=1'"
    assert r[1] == ("curl \\\n  -X POST \\\n  -L \\\n  -k \\\n  https://x.io/a \\\n  -H 'Content-Type: application/json' \\\n"
                    "  --data-raw '{\"it'\\''s\": 1}'")
    assert r[2] == "curl -I http://h/"
    assert r[3] == ["ok", "ok", "warn", "warn", "err", "err", "err"]


def test_api_saved_roundtrip_and_secret_warnings():
    r = api("""const s = {method: 'PATCH', url: '{{base}}/x?q=1', headers: [{key: 'Authorization', value: 'Bearer {{token}}', on: true},
      {key: 'X-Off', value: '1', on: false}], bodyType: 'json', body: '{"a": 1}', form: [], auth: {type: 'none'}};
    const leaky = {...s, headers: [{key: 'Cookie', value: 'sid=abc', on: true}, {key: 'authorization', value: 'Bearer real', on: true}],
      auth: {type: 'basic', user: 'u', password: 'hunter2'}};
    const saved = L.toSaved(s);
    const err = (t) => { try { L.fromSaved(t); return null; } catch (e) { return e.message; } };
    console.log(JSON.stringify([JSON.parse(saved), L.fromSaved(saved), L.literalSecrets(s), L.literalSecrets(leaky),
      L.fromSaved('{"method": "post", "url": "http://h", "headers": {"A": "1"}, "body": {"k": 2}}'),
      [err('nope'), err('[1]'), err('{"method": "GET"}')],
      ['{{t}}', 'Bearer {{t}}', 'Bearer x{{t}}', '', 'Basic abc'].map(L.isPlaceholderOnly)]));""")
    saved, back, ok, leaky, loose, errors, ph = r
    assert saved == {"method": "PATCH", "url": "{{base}}/x?q=1", "headers": [["Authorization", "Bearer {{token}}"], ["X-Off", "1", False]],
                     "body": '{"a": 1}', "bodyType": "json"}
    assert back["method"] == "PATCH" and back["url"] == "{{base}}/x?q=1" and back["bodyType"] == "json"
    assert back["headers"] == [{"key": "Authorization", "value": "Bearer {{token}}", "on": True}, {"key": "X-Off", "value": "1", "on": False}]
    assert ok == []
    assert leaky == ["Cookie header", "authorization header", "Basic auth password"]
    assert loose["method"] == "POST" and loose["headers"] == [{"key": "A", "value": "1", "on": True}]
    assert loose["bodyType"] == "json" and json.loads(loose["body"]) == {"k": 2}
    assert all(errors)
    assert ph == [True, True, False, True, False]


def test_api_body_kind_and_filename():
    r = api("""console.log(JSON.stringify([
      L.bodyKind({headers: [['Content-Type', 'application/json']], body_text: '{"a":1}'}),
      L.bodyKind({headers: [['Content-Type', 'text/plain']], body_text: '[1, 2]'}),
      L.bodyKind({headers: [['content-type', 'image/png']], body_text: null, body_base64: 'AA=='}),
      L.bodyKind({headers: [], body_text: null, body_base64: 'AA=='}),
      L.bodyKind({headers: [['Content-Type', 'text/html']], body_text: '<p>'}),
      L.bodyFilename('https://x.io/files/report.csv?x=1', 'text/csv'),
      L.bodyFilename('https://x.io/api/users', 'application/json; charset=utf-8'),
      L.bodyFilename('https://x.io/', ''),
    ]));""")
    assert r == ["json", "json", "image", "binary", "text", "report.csv", "response.json", "response.bin"]


# ------------------------------------------------------------------ image fixtures (built byte by byte)
def _ifd(entries, order, base, next_ifd=0):
    """entries: [(tag, type, count, payload_bytes)] -> (ifd bytes, data bytes) laid out at offset `base`."""
    e = "<" if order == "II" else ">"
    n = len(entries)
    data_off = base + 2 + n * 12 + 4
    head, data = struct.pack(e + "H", n), b""
    for tag, typ, count, payload in entries:
        if len(payload) <= 4:
            head += struct.pack(e + "HHI", tag, typ, count) + payload.ljust(4, b"\0")
        else:
            head += struct.pack(e + "HHII", tag, typ, count, data_off + len(data))
            data += payload + (b"\0" if len(payload) % 2 else b"")
    return head + struct.pack(e + "I", next_ifd) + data


def make_tiff(order="II", gps=True, orientation=6):
    e = "<" if order == "II" else ">"
    asc = lambda s: (s.encode() + b"\0")  # noqa: E731
    rat = lambda *pairs: b"".join(struct.pack(e + "II", a, b) for a, b in pairs)  # noqa: E731
    short = lambda v: struct.pack(e + "H", v)  # noqa: E731
    long_ = lambda v: struct.pack(e + "I", v)  # noqa: E731
    # sizes are computed in two passes: build with placeholder pointers, then rebuild with real offsets
    def build(exif_off, gps_off):
        ifd0 = [(0x010F, 2, 6, asc("Canon")), (0x0110, 2, 13, asc("Canon EOS R5")), (0x0112, 3, 1, short(orientation)),
                (0x0131, 2, 8, asc("GIMP 3")), (0x8769, 4, 1, long_(exif_off))]
        if gps:
            ifd0.append((0x8825, 4, 1, long_(gps_off)))
        b0 = _ifd(ifd0, order, 8)
        exif = [(0x829A, 5, 1, rat((1, 250))), (0x829D, 5, 1, rat((28, 10))), (0x8827, 3, 1, short(400)),
                (0x9003, 2, 20, asc("2024:05:01 10:20:30")), (0x920A, 5, 1, rat((50, 1))), (0xA434, 2, 15, asc("RF24-70mm F2.8"))]
        b1 = _ifd(exif, order, 8 + len(b0))
        g = [(1, 2, 2, asc("S")), (2, 5, 3, rat((33, 1), (51, 1), (5400, 100))), (3, 2, 2, asc("E")), (4, 5, 3, rat((151, 1), (12, 1), (3600, 100)))]
        b2 = _ifd(g, order, 8 + len(b0) + len(b1)) if gps else b""
        return b0, b1, b2
    b0, b1, _ = build(0, 0)
    b0, b1, b2 = build(8 + len(b0), 8 + len(b0) + len(b1))
    return (b"II*\0" if order == "II" else b"MM\0*") + struct.pack(e + "I", 8) + b0 + b1 + b2


def make_jpeg(tiff: bytes) -> bytes:
    app1 = b"Exif\0\0" + tiff
    app0 = b"JFIF\0\x01\x01\0\0\x01\0\x01\0\0"
    return (b"\xff\xd8" + b"\xff\xe0" + struct.pack(">H", len(app0) + 2) + app0
            + b"\xff\xe1" + struct.pack(">H", len(app1) + 2) + app1
            + b"\xff\xdb" + struct.pack(">H", 4) + b"\0\0" + b"\xff\xda" + struct.pack(">H", 2) + b"\x12\x34\xff\xd9")


def png_chunk(typ: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + typ + data + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)


def make_png(extra=()) -> bytes:
    ihdr = struct.pack(">IIBBBBB", 2, 1, 8, 6, 0, 0, 0)
    idat = zlib.compress(b"\0" + b"\xff\0\0\xff" * 2)
    return b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", ihdr) + b"".join(extra) + png_chunk(b"IDAT", idat) + png_chunk(b"IEND", b"")


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


BYTES_JS = "const bytes = (s) => new Uint8Array(Buffer.from(s, 'base64'));"


@pytest.mark.parametrize("order", ["II", "MM"])
def test_image_exif_both_byte_orders(order):
    jpeg = make_jpeg(make_tiff(order))
    r = img(f"""{BYTES_JS}
    const m = L.readMetadata(bytes('{_b64(jpeg)}'));
    console.log(JSON.stringify(m));""")
    assert r["mime"] == "image/jpeg" and "exifError" not in r
    rows = dict(r["exif"]["rows"])
    assert rows["Make"] == "Canon" and rows["Model"] == "Canon EOS R5" and rows["Lens"] == "RF24-70mm F2.8"
    assert rows["Date taken"] == "2024:05:01 10:20:30" and rows["Software"] == "GIMP 3"
    assert rows["Exposure"] == "1/250 s" and rows["Aperture"] == "f/2.8" and rows["ISO"] == "400" and rows["Focal length"] == "50 mm"
    assert rows["Orientation"].startswith("6 —") and r["exif"]["orientation"] == 6
    lat = -(33 + 51 / 60 + 54 / 3600)
    lon = 151 + 12 / 60 + 36 / 3600
    assert abs(r["exif"]["gps"]["lat"] - lat) < 1e-6 and abs(r["exif"]["gps"]["lon"] - lon) < 1e-6
    assert r["exif"]["byteOrder"].endswith(f"({order})")


def test_image_exif_without_gps_and_strip():
    jpeg = make_jpeg(make_tiff("II", gps=False, orientation=1))
    r = img(f"""{BYTES_JS}
    const b = bytes('{_b64(jpeg)}');
    const stripped = L.stripJpegExif(b);
    console.log(JSON.stringify([L.readMetadata(b).exif.gps, L.jpegExifSegments(b).length, L.jpegExifSegments(stripped).length,
      b.length - stripped.length, L.readMetadata(stripped).exif, Array.from(stripped.subarray(0, 4))]));""")
    assert r[0] is None and r[1] == 1 and r[2] == 0
    assert r[3] == len(b"Exif\0\0" + make_tiff("II", gps=False, orientation=1)) + 4
    assert r[4] is None and r[5] == [0xFF, 0xD8, 0xFF, 0xE0]


def test_image_corrupt_inputs_are_reported_not_thrown():
    bad_tiff = make_jpeg(b"XX\0*\0\0\0\x08")
    truncated = make_jpeg(make_tiff("MM"))[:60]
    hello, short_png = _b64(b"hello world"), _b64(b"\x89PNG\r\n\x1a\n" + b"\0\0\0\x50IHDR")
    r = img(f"""{BYTES_JS}
    console.log(JSON.stringify([L.readMetadata(bytes('{_b64(bad_tiff)}')).exifError, L.readMetadata(bytes('{_b64(truncated)}')).exifError,
      L.readMetadata(bytes('{hello}')), L.readMetadata(bytes('{short_png}')).exifError]));""")
    assert "byte order" in r[0]
    assert r[1]  # corrupt / truncated JPEG gives a message
    assert r[2] == {"mime": None, "exif": None, "text": []}
    assert "Corrupt PNG" in r[3]


def test_image_png_text_and_exif_chunk():
    itxt = b"Description\0\0\0en\0Beschreibung\0" + "Zoë’s photo".encode()
    png = make_png([png_chunk(b"tEXt", b"Software\0paint.net 5"), png_chunk(b"iTXt", itxt),
                    png_chunk(b"zTXt", b"Comment\0\0" + zlib.compress(b"hi")), png_chunk(b"eXIf", make_tiff("MM", gps=False))])
    r = img(f"""{BYTES_JS}
    const m = L.readMetadata(bytes('{_b64(png)}'));
    console.log(JSON.stringify(m));""")
    assert r["mime"] == "image/png"
    assert r["text"][0] == {"chunk": "tEXt", "keyword": "Software", "text": "paint.net 5"}
    assert r["text"][1]["keyword"] == "Description" and r["text"][1]["text"] == "Zoë’s photo" and r["text"][1]["lang"] == "en"
    assert r["text"][2]["compressed"] is True
    assert dict(r["exif"]["rows"])["Make"] == "Canon" and r["exif"]["gps"] is None


def test_image_sniff_and_aspect():
    gif = b"GIF89a" + b"\0" * 10
    webp = b"RIFF\0\0\0\0WEBPVP8 "
    bmp = _b64(b"BM....")
    r = img(f"""{BYTES_JS}
    console.log(JSON.stringify([
      ['{_b64(make_png())}', '{_b64(make_jpeg(make_tiff()))}', '{_b64(gif)}', '{_b64(webp)}', '{bmp}'].map((s) => L.sniffMime(bytes(s))),
      L.aspectRatio(1920, 1080), L.aspectRatio(4000, 3000), L.aspectRatio(1, 1), L.aspectRatio(1921, 1080).ratio, L.aspectRatio(0, 5),
    ]));""")
    assert r[0] == ["image/png", "image/jpeg", "image/gif", "image/webp", None]
    assert r[1] == {"ratio": "16:9", "decimal": 1.778} and r[2]["ratio"] == "4:3" and r[3]["ratio"] == "1:1"
    assert r[4] == "≈ 16:9"
    assert r[5] == {"ratio": "", "decimal": 0}


def test_image_orientation_and_rotation_matrices():
    # map the corners of a 4x2 raw image through each matrix and check where the top-left pixel lands
    r = img("""const out = {};
    for (let o = 1; o <= 8; o++) {
      const m = L.orientationMatrix(o, 4, 2);
      out[o] = [m.width, m.height, L.apply(m.matrix, 0.5, 0.5).map((v) => Math.floor(v))];
    }
    const rot = [0, 90, 180, 270].map((d) => { const m = L.rotateMatrix(d, false, false, 4, 2); return [m.width, m.height, L.apply(m.matrix, 0.5, 0.5).map(Math.floor)]; });
    const flips = [[true, false], [false, true], [true, true]].map(([a, b]) => L.apply(L.rotateMatrix(90, a, b, 4, 2).matrix, 0.5, 0.5).map(Math.floor));
    console.log(JSON.stringify({out, rot, flips}));""")
    o = r["out"]
    assert o["1"] == [4, 2, [0, 0]] and o["2"] == [4, 2, [3, 0]] and o["3"] == [4, 2, [3, 1]] and o["4"] == [4, 2, [0, 1]]
    assert o["5"] == [2, 4, [0, 0]] and o["6"] == [2, 4, [1, 0]] and o["7"] == [2, 4, [1, 3]] and o["8"] == [2, 4, [0, 3]]
    assert r["rot"] == [[4, 2, [0, 0]], [2, 4, [1, 0]], [4, 2, [3, 1]], [2, 4, [0, 3]]]
    assert r["flips"] == [[0, 0], [1, 3], [0, 3]]


def test_image_resize_and_crop_math():
    r = img("""console.log(JSON.stringify([
      L.resizeTo(4000, 3000, {mode: 'px', width: 800, lock: true, changed: 'width'}),
      L.resizeTo(4000, 3000, {mode: 'px', width: 800, height: 300, lock: true, changed: 'height'}),
      L.resizeTo(4000, 3000, {mode: 'px', width: 800, height: 300, lock: false}),
      L.resizeTo(4000, 3000, {mode: 'pct', pct: 25}),
      L.resizeTo(3, 3, {mode: 'pct', pct: 1}),
      L.resizeTo(100, 100, {mode: 'px', width: '', height: '', lock: true}).error,
      L.resizeTo(100, 100, {mode: 'px', width: 50, height: '', lock: false}).error,
      L.resizeTo(100, 100, {mode: 'pct', pct: 0}).error,
      L.resizeTo(100, 100, {mode: 'pct', pct: 100000}).error,
      L.clampCrop({x: -5, y: 10, w: 500, h: 0}, 200, 100),
      L.clampCrop({x: 250, y: 250, w: 10, h: 10}, 200, 100),
      L.rectFromPoints(50, 40, 10, 5, 200, 100),
      L.base64Size(3), L.base64Size(4), L.toHex(255, 8, 0), L.exportName('my photo.JPG', 'png'), L.exportName('', 'webp', 'clean'),
    ]));""")
    assert r[0] == {"width": 800, "height": 600}
    assert r[1] == {"width": 400, "height": 300}
    assert r[2] == {"width": 800, "height": 300}
    assert r[3] == {"width": 1000, "height": 750}
    assert r[4] == {"width": 1, "height": 1}
    assert all(isinstance(e, str) and e for e in r[5:9])
    assert r[9] == {"x": 0, "y": 10, "w": 200, "h": 1}
    assert r[10] == {"x": 199, "y": 99, "w": 1, "h": 1}
    assert r[11] == {"x": 10, "y": 5, "w": 40, "h": 35}
    assert r[12:] == [4, 8, "#ff0800", "my_photo-edited.png", "image-clean.webp"]


def test_frontend_modules_syntax_and_no_html_injection():
    from app.core import config

    tools = config.WEB_DIR / "js" / "services" / "devtools" / "tools"
    for name in ("api.js", "api.logic.js", "image.js", "image.logic.js"):
        src = (tools / name).read_text()
        for bad in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "http://cdn", "https://cdn"):
            assert bad not in src, f"{bad} in {name}"
        if shutil.which("node"):
            subprocess.run(["node", "--check", str(tools / name)], check=True)
    css = (config.WEB_DIR / "css" / "devtools-netimg.css").read_text()
    assert "@import" not in css and "url(http" not in css
    for name in ("api.js", "image.js"):
        assert "loadCss('/static/css/devtools-netimg.css')" in (tools / name).read_text()
