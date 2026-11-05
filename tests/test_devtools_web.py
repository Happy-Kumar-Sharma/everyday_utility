"""Dev Tools "web & ops" group: HTTP reference, curl converter, Docker / kubectl builder.

Pure logic lives in web/js/services/devtools/tools/<key>.logic.js and is exercised through node (skipped when node is
missing); the Library save the docker builder performs is checked against the real endpoint with a temp library folder.
"""

import importlib
import json
import shutil
import subprocess

import pytest
from fastapi.testclient import TestClient

from app.core import config, context
from app.core.jobs import JobManager
from app.core.settings_store import SettingsStore
from app.main import create_app

library_router = importlib.import_module("app.services.library.router")
TOOLS_DIR = config.WEB_DIR / "js" / "services" / "devtools" / "tools"
H = {"x-everyday-utility": "1"}


def _run(module, script):
    """Runs `script` as an ES module with tools/<module>.logic.js imported as L; returns its printed JSON."""
    if not shutil.which("node"):
        pytest.skip("node is not installed")
    src = f"import * as L from '{(TOOLS_DIR / f'{module}.logic.js').as_uri()}';\n{script}"
    out = subprocess.run(["node", "--input-type=module", "-e", src], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(context, "jobs", JobManager(tmp_path / "jobs"))
    monkeypatch.setattr(context, "settings", SettingsStore(tmp_path / "settings"))
    monkeypatch.setattr(library_router, "_root", lambda: tmp_path / "lib")  # outside the app and any git repo
    c = TestClient(create_app())
    yield c
    context.jobs.shutdown(grace=0.5)


# ------------------------------------------------------------------ files

def test_frontend_files_served(client):
    for path in ("http.js", "http.logic.js", "curl.js", "curl.logic.js", "docker.js", "docker.logic.js"):
        assert client.get(f"/static/js/services/devtools/tools/{path}").status_code == 200
    assert client.get("/static/css/devtools-web.css").status_code == 200


def test_no_html_injection_sinks():
    for name in ("http", "curl", "docker"):
        for suffix in (".js", ".logic.js"):
            src = (TOOLS_DIR / f"{name}{suffix}").read_text()
            for sink in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"):
                assert sink not in src, f"{name}{suffix} uses {sink}"


@pytest.mark.skipif(not shutil.which("node"), reason="node is not installed")
def test_js_syntax():
    for name in ("http", "curl", "docker"):
        for suffix in (".js", ".logic.js"):
            r = subprocess.run(["node", "--check", str(TOOLS_DIR / f"{name}{suffix}")], capture_output=True, text=True)
            assert r.returncode == 0, r.stderr


# ------------------------------------------------------------------ http

def test_http_reference_data_complete():
    r = _run("http", """console.log(JSON.stringify({
      codes: L.STATUS.map((s) => s.code),
      nonStd: L.STATUS.filter((s) => s.nonStandard).map((s) => s.code),
      headers: L.HEADERS.map((x) => x.name),
      incomplete: [...L.STATUS.filter((s) => !s.name || !s.desc || !s.causes || !s.check).map((s) => s.code),
                   ...L.HEADERS.filter((x) => !x.desc || !x.example || !x.kind).map((x) => x.name)],
    }));""")
    for code in (100, 101, 103, 200, 204, 206, 207, 208, 226, 301, 304, 307, 308, 400, 401, 403, 404, 409, 413, 415,
                 421, 422, 425, 426, 428, 429, 431, 451, 500, 502, 503, 504, 506, 507, 508, 510, 511):
        assert code in r["codes"]
    assert set(r["nonStd"]) >= {499, 520, 521, 522, 523, 524}
    assert len(r["headers"]) >= 60 and len(set(h.lower() for h in r["headers"])) == len(r["headers"])
    for name in ("Content-Security-Policy", "Strict-Transport-Security", "X-Content-Type-Options", "Referrer-Policy",
                 "Permissions-Policy", "Access-Control-Allow-Origin", "Cache-Control", "Set-Cookie", "Range", "X-Forwarded-For"):
        assert name in r["headers"]
    assert r["incomplete"] == []


def test_http_search_and_filters():
    r = _run("http", """const names = (q, f) => L.searchReference(q, f).map((e) => e.code ?? e.name);
    console.log(JSON.stringify({
      exact: names('404')[0], prefix: names('42'), cls: names('', '5xx').length === L.STATUS.filter((s) => s.cls === '5xx').length,
      byName: names('teapot'), byText: names('rate limit'), cors: names('', 'cors'), sec: names('', 'security'),
      req: names('', 'request').includes('Authorization') && !names('', 'request').includes('Set-Cookie'),
      none: names('zzzz-nothing'), header: names('etag')[0],
    }));""")
    assert r["exact"] == 404
    assert set(r["prefix"]) >= {421, 422, 425, 426, 428, 429}
    assert r["cls"] and r["req"]
    assert r["byName"] == [418] and 429 in r["byText"]
    assert "Access-Control-Allow-Origin" in r["cors"] and "Cache-Control" not in r["cors"]
    assert "Content-Security-Policy" in r["sec"]
    assert r["none"] == [] and r["header"] == "ETag"


def test_http_explain_response():
    r = _run("http", r"""const raw = 'HTTP/1.1 302 Found\r\nLocation: /next\r\n\r\nHTTP/2 200\r\ncontent-type: text/html\r\n'
      + 'cache-control: no-store, max-age=600\r\naccess-control-allow-origin: *\r\naccess-control-allow-credentials: true\r\n'
      + 'set-cookie: sessionid=abc; SameSite=None\r\nx-custom-thing: 1\r\nnot a header line\r\n';
    const good = 'HTTP/1.1 200 OK\nContent-Type: application/json\nStrict-Transport-Security: max-age=63072000; includeSubDomains\n'
      + 'X-Content-Type-Options: nosniff\nCache-Control: private, max-age=60\n';
    const a = L.explainResponse(raw), b = L.explainResponse(good);
    console.log(JSON.stringify({
      status: a.status, name: a.statusInfo.name, n: a.headers.length, unknown: a.headers.filter((x) => !x.info).map((x) => x.name),
      warn: a.warnings.map((w) => w.level + ':' + w.text), unparsed: a.unparsed,
      goodWarn: b.warnings.filter((w) => w.level !== 'info').map((w) => w.text), notes: b.headers.flatMap((x) => x.notes),
      empty: L.explainResponse('').headers.length,
    }));""")
    assert r["status"] == 200 and r["name"] == "OK" and r["n"] == 6  # the redirect's headers are replaced by the final response's
    assert r["unknown"] == ["x-custom-thing"] and r["unparsed"] == ["not a header line"]
    text = "\n".join(r["warn"])
    assert "err:Access-Control-Allow-Origin: * together with Allow-Credentials" in text
    assert "no-store" in text and "SameSite=None requires Secure" in text
    assert "Strict-Transport-Security" in text and "X-Content-Type-Options" in text and "Content-Security-Policy" in text
    assert r["goodWarn"] == []
    assert any("Fresh for 60 s" in n for n in r["notes"]) and any("including subdomains" in n for n in r["notes"])
    assert r["empty"] == 0


# ------------------------------------------------------------------ curl

CHROME_BASH = r"""curl 'https://api.example.com/v1/items?page=2' \
  -H 'accept: application/json' \
  -H 'authorization: Bearer eyJ.secret.sig' \
  -H 'content-type: application/json' \
  -b 'sid=s3cr3t; theme=dark' \
  --data-raw $'{"name":"it\'s","tags":["a","b"],"ok":true,"none":null}' \
  --compressed -sS"""

CHROME_CMD = 'curl ^"https://api.example.com/v1/items^" ^\n  -H ^"accept: */*^" ^\n  -H ^"content-type: application/json^" ^\n' \
             '  --data-raw ^"^{^\\^"a^\\^":1^}^" ^\n  --compressed'


def test_curl_tokenizer_quoting():
    r = _run("curl", r"""console.log(JSON.stringify([
      L.tokenize("curl 'a b' \"c \\\"d\\\" $e\" f\\ g \\\n  -H x"),
      L.tokenize("curl $'tab\\there\\x41\\u00e9\\'q'"),
      L.tokenize('curl ^"https://x.com/?a=1^&b=2^" ^\n -H ^"x: ^\\^"y^\\^"^"'),
    ]));""")
    assert r[0] == ["curl", "a b", 'c "d" $e', "f g", "-H", "x"]
    assert r[1] == ["curl", "tab\thereAé'q"]
    assert r[2] == ["curl", "https://x.com/?a=1&b=2", "-H", 'x: "y"']


def test_curl_parse_chrome_bash_and_cmd():
    r = _run("curl", f"""const a = L.parseCurl({json.dumps(CHROME_BASH)}), b = L.parseCurl({json.dumps(CHROME_CMD)});
    console.log(JSON.stringify({{a, b}}));""")
    a, b = r["a"], r["b"]
    assert a["method"] == "POST" and a["url"] == "https://api.example.com/v1/items?page=2"
    assert a["bodyKind"] == "json" and json.loads(a["body"])["name"] == "it's"
    assert a["cookies"] == "sid=s3cr3t; theme=dark" and a["compressed"] is True and a["warnings"] == []
    assert b["url"] == "https://api.example.com/v1/items" and b["body"] == '{"a":1}' and b["bodyKind"] == "json"


def test_curl_options_and_unknown_flags():
    r = _run("curl", r"""const p = (c) => L.parseCurl(c);
    console.log(JSON.stringify({
      get: p("curl -G -d q=hello --data-urlencode 'n=a b&c' example.com/s"),
      head: p('curl -I https://x.com'),
      put: p("curl -XPUT -u bob:pa:ss -A 'agent/1' -e https://ref.example -L -k --url https://x.com/u -d @body.json"),
      form: p("curl -F 'file=@/tmp/a.png;type=image/png' -F name=x https://x.com/up"),
      json: p(`curl --json '{"a":1}' https://x.com`),
      unknown: p('curl --frobnicate --max-time 5 -Z https://x.com'),
      urlenc: p('curl -d a=1 -d b=2 https://x.com'),
    }));""")
    assert r["get"]["method"] == "GET" and r["get"]["url"] == "http://example.com/s?q=hello&n=a%20b%26c" and r["get"]["body"] is None
    assert r["head"]["method"] == "HEAD"
    put = r["put"]
    assert put["method"] == "PUT" and put["url"] == "https://x.com/u" and put["auth"] == {"user": "bob", "pass": "pa:ss"}
    assert ["User-Agent", "agent/1"] in put["headers"] and ["Referer", "https://ref.example"] in put["headers"]
    assert put["follow"] and put["insecure"] and put["files"] == ["body.json"] and any("body.json" in n for n in put["notes"])
    form = r["form"]
    assert form["bodyKind"] == "form" and form["method"] == "POST"
    assert form["form"][0]["file"] == "/tmp/a.png" and form["form"][0]["type"] == "image/png" and form["form"][1]["value"] == "x"
    assert r["json"]["bodyKind"] == "json" and ["Content-Type", "application/json"] in r["json"]["headers"]
    w = " ".join(r["unknown"]["warnings"])
    assert "--frobnicate" in w and "-Z" in w and "--max-time" not in w  # known-but-irrelevant flags are notes, not warnings
    assert any("--max-time" in n for n in r["unknown"]["notes"])
    assert r["urlenc"]["body"] == "a=1&b=2" and r["urlenc"]["bodyKind"] == "urlencoded"


def test_curl_errors():
    r = _run("curl", r"""const err = (c) => { try { L.parseCurl(c); return null; } catch (e) { return e.message; } };
    console.log(JSON.stringify([err(''), err('wget x'), err("curl 'unterminated"), err('curl -H'), err('curl -s')]));""")
    assert r[0] and "curl" in r[1] and "quote" in r[2] and "needs a value" in r[3] and "No URL" in r[4]


def test_curl_outputs_and_redaction():
    r = _run("curl", f"""const plain = L.convertCurl({json.dumps(CHROME_BASH + ' -k -L')});
    const red = L.convertCurl({json.dumps(CHROME_BASH + ' -k')}, {{ redactSecrets: true }});
    const form = L.convertCurl("curl -F 'file=@a.png' -F name=x -u u:p https://x.com/up");
    console.log(JSON.stringify({{ plain: plain.outputs, secrets: plain.secrets, red: red.outputs, form: form.outputs }}));""")
    p = r["plain"]
    assert 'method: "POST"' in p["fetch"] and "JSON.stringify(" in p["fetch"] and '"authorization": "Bearer eyJ.secret.sig"' in p["fetch"]
    assert "requests.post(url, headers=headers, cookies=cookies, json=json_data, verify=False)" in p["requests"]
    assert '"ok": True' in p["requests"] and '"none": None' in p["requests"] and '"sid": "s3cr3t"' in p["requests"]
    assert 'httpx.request("POST", url' in p["httpx"] and "follow_redirects=True" in p["httpx"]
    assert 'import axios from "axios"' in p["axios"] and "rejectUnauthorized: false" in p["axios"]
    assert p["httpie"].startswith("http --verify=no --follow --raw ") and "POST 'https://api.example.com/v1/items?page=2'" in p["httpie"]
    assert p["curl"].startswith("curl -X POST 'https://api.example.com/v1/items?page=2'") and "-L -k --compressed" in p["curl"]
    assert set(r["secrets"]) == {"authorization", "Cookie (-b)"}
    for code in r["red"].values():
        assert "eyJ.secret.sig" not in code and "s3cr3t" not in code and "<REDACTED>" in code
    assert "Bearer <REDACTED>" in r["red"]["requests"]
    f = r["form"]
    assert 'open("a.png", "rb")' in f["requests"] and 'auth=("u", "p")' in f["requests"] and "allow_redirects=False" in f["requests"]
    assert "--multipart" in f["httpie"] and "file@a.png" in f["httpie"] and "-a u:p" in f["httpie"]
    assert "new FormData()" in f["fetch"] and "Authorization" in f["fetch"]


def test_curl_normalized_round_trips():
    r = _run("curl", f"""const a = L.parseCurl({json.dumps(CHROME_BASH)});
    const b = L.parseCurl(L.toCurl(a));
    console.log(JSON.stringify([a.method, a.url, a.headers, a.body, a.cookies, b.method, b.url, b.headers, b.body, b.cookies]));""")
    assert r[:5] == r[5:]


def test_fetch_to_curl():
    r = _run("curl", r"""const chrome = `fetch("https://x.com/api", {
      "headers": { "accept": "*/*", "content-type": "application/json" },
      "referrer": "https://x.com/",
      "body": "{\\"a\\":1}",
      "method": "POST",
      "mode": "cors",
      "credentials": "include"
    });`;
    const a = L.fetchToCurl(chrome);
    const b = L.fetchToCurl("await fetch('https://x.com/p', { method: 'put', headers: { Authorization: `Bearer t` }, body: JSON.stringify({ a: [1, true, null] }), })");
    const c = L.fetchToCurl("fetch('https://x.com')");
    const err = (s) => { try { L.fetchToCurl(s); return null; } catch (e) { return e.message; } };
    console.log(JSON.stringify({ a: a.curl, notes: a.notes, b: b.curl, bNotes: b.notes, c: c.curl,
      errs: [err('nothing'), err('fetch(url, {})'), err('fetch("x", { headers })'), err('fetch(`https://x/${id}`)')] }));""")
    assert r["a"].startswith("curl -X POST https://x.com/api") and "-H 'Referer: https://x.com/'" in r["a"]
    assert """--data-raw '{"a":1}'""" in r["a"] and any("mode" in n for n in r["notes"])
    assert "curl -X PUT https://x.com/p" in r["b"] and "--data-raw '{\"a\":[1,true,null]}'" in r["b"]
    assert any("Content-Type" in n for n in r["bNotes"])
    assert r["c"].startswith("curl -X GET https://x.com")
    assert all(r["errs"])


# ------------------------------------------------------------------ docker / kubectl

def test_docker_run_command_and_masking():
    r = _run("docker", r"""const o = { image: 'postgres:16', name: 'pg', detach: true, it: false, rm: false,
      ports: '127.0.0.1:5432:5432\n8080:80/udp\n# comment', volumes: 'pgdata:/var/lib/postgresql/data\n/srv/init:/docker-entrypoint-initdb.d:ro',
      env: "POSTGRES_PASSWORD=it's secret\nTZ", envFile: '.env', network: 'backend', restart: 'on-failure', retries: '3',
      user: '999', workdir: '/work', entrypoint: '', command: 'postgres -c "log statement=all"', labels: 'team=data', gpus: true };
    const r = L.buildDockerRun(o);
    console.log(JSON.stringify({ argv: r.argv, command: r.command, display: r.display, errors: r.errors, warnings: r.warnings,
      yaml: L.composeYaml(o), masked: L.composeYaml(o, { mask: true }),
      conflict: L.buildDockerRun({ image: 'x', rm: true, restart: 'always' }).errors,
      bad: L.buildDockerRun({ image: '', ports: '99999:80\nabc', volumes: 'nocolon', env: '1BAD=x', labels: 'nolabel' }).errors,
      entry: L.buildDockerRun({ image: 'alpine', entrypoint: '/bin/sh -c', command: "'echo hi'" }).argv,
      host: L.composeYaml({ image: 'x', network: 'host' }),
    }));""")
    assert r["errors"] == []
    argv = r["argv"]
    assert argv[:3] == ["docker", "run", "-d"] and argv[-4:] == ["postgres:16", "postgres", "-c", "log statement=all"]
    assert ["-p", "127.0.0.1:5432:5432"] == argv[argv.index("127.0.0.1:5432:5432") - 1:argv.index("127.0.0.1:5432:5432") + 1]
    assert "--restart" in argv and "on-failure:3" in argv and "--gpus" in argv and "-u" in argv
    assert "-e 'POSTGRES_PASSWORD=it'\\''s secret'" in r["command"] and "'log statement=all'" in r["command"]
    assert "it's secret" not in r["display"] and "POSTGRES_PASSWORD=****" in r["display"] and "-e TZ" in r["display"]
    assert any("all interfaces" in w for w in r["warnings"]) and any("--env-file" in w for w in r["warnings"])
    y = r["yaml"]
    assert "services:\n  pg:\n    image: \"postgres:16\"" in y and '- "8080:80/udp"' in y
    assert 'POSTGRES_PASSWORD: "it\'s secret"' in y and "    TZ:" not in y.replace("      TZ:", "") and "capabilities: [gpu]" in y
    assert "volumes:\n  pgdata: {}" in y and "networks:\n  backend:\n    external: true" in y and 'restart: "on-failure:3"' in y
    assert 'POSTGRES_PASSWORD: "****"' in r["masked"]
    assert "Conflicting" in r["conflict"][0]
    assert len(r["bad"]) == 6
    assert r["entry"] == ["docker", "run", "--entrypoint", "/bin/sh", "alpine", "-c", "echo hi"]
    assert 'network_mode: "host"' in r["host"] and "external" not in r["host"]


def test_docker_snippets():
    r = _run("docker", r"""console.log(JSON.stringify({
      logs: L.buildSnippet('logs', { container: 'web', tail: '50' }),
      exec: L.buildSnippet('exec', { container: 'web', shell: 'bash' }).command,
      prune: L.buildSnippet('prune', { volumes: true }),
      pruneSafe: L.buildSnippet('prune', {}),
      down: [L.buildSnippet('compose-down', {}).danger, L.buildSnippet('compose-down', { volumes: true }).danger],
      missing: L.buildSnippet('logs', { tail: 'x' }).errors,
      cp: L.buildSnippet('cp-out', { container: 'web', src: '/etc/my file.conf', dest: './' }).command,
      keys: L.SNIPPETS.map((s) => s.key),
    }));""")
    assert r["logs"]["command"] == "docker logs -f --tail 50 web" and r["logs"]["danger"] is None
    assert r["exec"] == "docker exec -it web bash"
    assert r["prune"]["command"] == "docker system prune -af --volumes" and "volumes" in r["prune"]["danger"]
    assert r["pruneSafe"]["command"] == "docker system prune -af" and r["pruneSafe"]["danger"]
    assert r["down"][0] is None and "volumes" in r["down"][1]
    assert len(r["missing"]) == 2
    assert r["cp"] == "docker cp 'web:/etc/my file.conf' ./"
    assert {"logs", "exec", "cp-out", "prune", "image-ls", "image-rm", "compose-up", "compose-down", "compose-logs"} <= set(r["keys"])


def test_kubectl_builder():
    r = _run("docker", r"""const k = (o) => L.buildKubectl(o);
    console.log(JSON.stringify({
      logs: k({ verb: 'logs', context: 'eks-prod', namespace: 'api', type: 'pods', name: 'web-1', follow: true, tail: '200', container: 'app', previous: true }).command,
      logsSel: k({ verb: 'logs', type: 'pods', selector: 'app=web', follow: false }).command,
      get: k({ verb: 'get', type: 'pods', selector: 'app=web', output: 'jsonpath', jsonpath: '{.items[*].metadata.name}', allNamespaces: true }).command,
      wide: k({ verb: 'get', type: 'deployments', namespace: 'x', output: 'wide' }).command,
      exec: k({ verb: 'exec', type: 'pods', name: 'p', container: 'c', cmd: 'bash -c "ls /"' }).command,
      pf: k({ verb: 'port-forward', type: 'services', name: 'db', ports: '5432:5432' }).command,
      restart: k({ verb: 'rollout-restart', type: 'deployments', name: 'web', namespace: 'n' }).command,
      undo: k({ verb: 'rollout-undo', type: 'deployments', name: 'web', revision: '3' }),
      scale0: k({ verb: 'scale', type: 'deployments', name: 'web', replicas: '0' }),
      apply: k({ verb: 'apply', file: 'k8s/', dryRun: true }).command,
      del: k({ verb: 'delete', context: 'prod', namespace: 'shop', type: 'deployments', name: 'web' }),
      delAll: k({ verb: 'delete', type: 'pods' }).errors,
      delDry: k({ verb: 'delete', type: 'pods', name: 'x', dryRun: true }),
      node: k({ verb: 'get', type: 'nodes', namespace: 'ignored' }).command,
      badRollout: k({ verb: 'rollout-status', type: 'pods', name: 'x' }).errors,
    }));""")
    assert r["logs"] == "kubectl --context eks-prod -n api logs web-1 -f --tail=200 -c app --previous"
    assert r["logsSel"] == "kubectl logs -l app=web --all-containers=true"
    assert r["get"] == "kubectl -A get pods -l app=web -o 'jsonpath={.items[*].metadata.name}'"
    assert r["wide"] == "kubectl -n x get deployments -o wide"
    assert r["exec"] == "kubectl exec -it p -c c -- bash -c 'ls /'"
    assert r["pf"] == "kubectl port-forward service/db 5432:5432"
    assert r["restart"] == "kubectl -n n rollout restart deployment/web"
    assert r["undo"]["command"] == "kubectl rollout undo deployment/web --to-revision=3" and r["undo"]["danger"]
    assert r["scale0"]["command"].endswith("--replicas=0") and "zero" in r["scale0"]["danger"]
    assert r["apply"] == "kubectl apply -f k8s/ --dry-run=server"
    d = r["del"]
    assert d["command"] == "kubectl --context prod -n shop delete deployments web" and d["errors"] == []
    assert '"shop"' in d["danger"] and '"prod"' in d["danger"] and d["confirm"]
    assert r["delAll"] and r["delDry"]["danger"] is None and r["delDry"]["confirm"] is None
    assert r["node"] == "kubectl get nodes"
    assert r["badRollout"]


def test_shell_quoting():
    r = _run("docker", r"""console.log(JSON.stringify([L.shq('plain-1.2/x:y'), L.shq(''), L.shq("it's"), L.shq('a b'), L.shq('$HOME'),
      L.splitWords(`a "b c" 'd e' f\\ g`)]));""")
    assert r == ["plain-1.2/x:y", "''", "'it'\\''s'", "'a b'", "'$HOME'", ["a", "b c", "d e", "f g"]]


# ------------------------------------------------------------------ Save to Library (what docker.js POSTs)

def test_save_command_to_library(client, tmp_path):
    body = {"collection": "Commands", "name": "docker run pg", "type": "shell", "content": "docker run -d postgres:16\n"}
    r = client.post("/api/library/items", json=body, headers=H)
    assert r.status_code == 200, r.text
    item = r.json()
    assert item["name"] == "docker run pg" and item["type"] == "shell"
    saved = list((tmp_path / "lib" / "Commands").glob("*.sh"))
    assert len(saved) == 1 and saved[0].read_text().startswith("docker run -d postgres:16")


def test_save_command_refused_when_library_not_git_safe(client, tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    monkeypatch.setattr(library_router, "_root", lambda: repo / "lib")
    r = client.post("/api/library/items", headers=H,
                    json={"collection": "Commands", "name": "x", "type": "shell", "content": "echo hi\n"})
    assert r.status_code == 409
    assert "not ignored" in r.json()["detail"]  # docker.js shows this message as-is
    assert not (repo / "lib").exists() or not any((repo / "lib").rglob("*.sh"))
