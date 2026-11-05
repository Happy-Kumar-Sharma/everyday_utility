"""Remote Jupyter tab. ssh is ALWAYS faked: a stub `ssh` script first on PATH prints Jupyter-like output
(or runs the remote command locally, to prove the quoting). No real host is ever contacted."""

import json
import os
import shlex
import socket
import stat
import sys
import time

import pytest
from fastapi.testclient import TestClient

from app.services.jupyter import commands, parse, profiles
from app.services.jupyter.profiles import ProfileError

H = {"x-everyday-utility": "1"}
TOKEN = "deadbeef0123456789abcdef"

STUB_SSH = r'''#!PYTHON
import json, os, signal, subprocess, sys, time
mode = os.environ.get("FAKE_SSH_MODE", "banner")
log = os.environ.get("FAKE_SSH_ARGS")
if log:
    with open(log, "a") as f:
        f.write(json.dumps(sys.argv[1:]) + "\n")
def hold():
    signal.signal(signal.SIGTERM, lambda *a: sys.exit(0))
    signal.signal(signal.SIGHUP, lambda *a: sys.exit(0))
    time.sleep(60)
if mode == "banner":
    print("Warning: Permanently added '10.0.0.5' (ED25519) to the list of known hosts.\r", flush=True)
    print("[I 2026-01-01 09:00:00.812 ServerApp] Jupyter Server 2.14.0 is running at:\r", flush=True)
    print("[I 2026-01-01 09:00:00.812 ServerApp] http://fake-host:8888/lab?token=TOKEN\r", flush=True)
    print("[C 2026-01-01 09:00:00.820 ServerApp]\r\n    To access the server, open this file in a browser:\r", flush=True)
    print("        file:///home/ubuntu/.local/share/jupyter/runtime/jpserver-1-open.html\r", flush=True)
    print("    Or copy and paste one of these URLs:\r\n        http://fake-host:8888/lab?token=TOKEN\r", flush=True)
    sys.stdout.write("        http://127.0.0.1:8888/lab?token=TOKEN")  # partial line, no newline yet
    sys.stdout.flush()
    hold()
elif mode == "tunnel":
    hold()
elif mode == "publickey":
    print("ubuntu@10.0.0.5: Permission denied (publickey).", file=sys.stderr); sys.exit(255)
elif mode == "timeout":
    print("ssh: connect to host 10.0.0.5 port 22: Connection timed out", file=sys.stderr); sys.exit(255)
elif mode == "conda":
    print("bash: line 3: conda: command not found", flush=True); sys.exit(1)
elif mode == "envnf":
    print("EnvironmentNameNotFound: Could not find conda environment: nope", flush=True); sys.exit(1)
elif mode == "list":
    print(json.dumps({"base_url": "/", "hostname": "0.0.0.0", "notebook_dir": "/srv/x", "password": False,
                      "pid": 4242, "port": 8890, "root_dir": "/srv/x", "secure": False, "sock": "",
                      "token": "cafe01", "url": "http://fake-host:8890/", "version": "2.14.0"}))
elif mode == "exec":  # act like the remote shell: run the single remote-command argument
    sys.exit(subprocess.call(["bash", "-c", sys.argv[-1]]))
'''.replace("PYTHON", sys.executable).replace("TOKEN", TOKEN)


@pytest.fixture()
def fake_ssh(tmp_path, monkeypatch):
    bin_dir = tmp_path / "fakebin"
    bin_dir.mkdir()
    ssh = bin_dir / "ssh"
    ssh.write_text(STUB_SSH)
    ssh.chmod(0o755)
    args_log = tmp_path / "ssh_args.jsonl"
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("FAKE_SSH_ARGS", str(args_log))
    monkeypatch.setenv("FAKE_SSH_MODE", "banner")
    return {"bin": bin_dir, "args": args_log}


@pytest.fixture()
def client(tmp_path, monkeypatch, fake_ssh):
    from app.core import config, context
    from app.core.jobs import JobManager
    from app.core.settings_store import SettingsStore

    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(context, "jobs", JobManager(tmp_path / "jobs"))
    monkeypatch.setattr(context, "settings", SettingsStore(tmp_path / "settings"))
    from app.main import app

    with TestClient(app) as c:
        yield c
        for j in context.jobs.list():
            context.jobs.cancel(j.id, grace=1)


@pytest.fixture()
def key(tmp_path):
    k = tmp_path / "keys" / "server.pem"
    k.parent.mkdir()
    k.write_text("not a real key\n")
    k.chmod(0o600)
    return k


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def profile_data(key, **kw):
    d = {"name": "staging", "host": "10.0.0.5", "user": "ubuntu", "key_path": str(key),
         "remote_dir": "/mnt/efs/cron_jobs/project", "conda_env": "dev_env", "mode": "tunnel",
         "remote_port": 8888, "local_port": _free_port(), "extra_ssh_args": "", "notes": ""}
    d.update(kw)
    return d


def _create(client, key, **kw):
    r = client.post("/api/jupyter/profiles", json=profile_data(key, **kw), headers=H)
    assert r.status_code == 200, r.text
    return r.json()["profile"]


def _wait_state(client, job_id, states, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        s = client.get(f"/api/jupyter/sessions/{job_id}").json()
        if s["state"] in states:
            return s
        time.sleep(0.1)
    raise AssertionError(f"session never reached {states}: {s}")


# ---- validation -----------------------------------------------------------------------------------
@pytest.mark.parametrize("field,value", [
    ("host", "10.0.0.5; rm -rf /"), ("host", "bad host"), ("host", "-oProxyCommand=x"), ("host", "$(id)"),
    ("host", ""), ("user", "Root"), ("user", "u;id"), ("user", "-l"), ("remote_port", 0),
    ("remote_port", 70000), ("local_port", "abc"), ("local_port", -1), ("mode", "both"), ("remote_dir", ""),
    ("conda_env", " "), ("name", ""),
])
def test_validation_rejects(key, field, value):
    with pytest.raises(ProfileError):
        profiles.validate(profile_data(key, **{field: value}))


def test_validation_ok_and_key_warning(tmp_path, key):
    p, warnings = profiles.validate(profile_data(key, host="ip-10-0-0-5.internal", user="ubuntu"))
    assert p["host"] == "ip-10-0-0-5.internal" and warnings == []
    _p, warnings = profiles.validate(profile_data(tmp_path / "missing.pem"))
    assert warnings and "not found" in warnings[0]


@pytest.mark.parametrize("extra", [
    "-o ProxyCommand=nc %h %p", "-oProxyCommand=evil", "-o LocalCommand=id", "-o PermitLocalCommand=yes",
    "-o KnownHostsCommand=/bin/x", "-o 'Match exec \"id\"'", "-F /tmp/evil_config", "otherhost",
    "-o", "-o proxycommand=x",
])
def test_extra_args_rejected(extra):
    with pytest.raises(ProfileError):
        profiles.parse_extra_args(extra)


def test_extra_args_allowed_and_port():
    assert profiles.parse_extra_args("-p 2222 -o Compression=yes -4") == ["-p", "2222", "-o", "Compression=yes", "-4"]
    assert profiles.ssh_port("-p 2222") == 2222
    assert profiles.ssh_port("-o Port=2200") == 2200
    assert profiles.ssh_port("") == 22


# ---- commands & quoting ---------------------------------------------------------------------------
def test_start_command_options_and_round_trip(key):
    p = {"id": "x", **profiles.validate(profile_data(key, local_port=9999, remote_dir="/a b/it's $(id)",
                                                       conda_env="env`id`", extra_ssh_args="-p 2222"))[0]}
    cmd = commands.start(p)
    argv = shlex.split(cmd.script.removeprefix("exec "))
    assert argv == cmd.argv
    assert argv[:2] == ["ssh", "-tt"] and "BatchMode=yes" in argv and "ExitOnForwardFailure=yes" in argv
    assert "StrictHostKeyChecking=accept-new" in argv and "ConnectTimeout=10" in argv
    assert argv[argv.index("-L") + 1] == "127.0.0.1:9999:127.0.0.1:8888"
    assert argv[-2] == "ubuntu@10.0.0.5" and "-p" in argv
    wrapper = shlex.split(argv[-1])  # run like a manual ssh session: exec bash -lic '<script>'
    assert wrapper[:3] == ["exec", "bash", "-lic"] and len(wrapper) == 4
    lines = wrapper[3].splitlines()
    assert shlex.split(lines[0]) == ["cd", "/a b/it's $(id)", "||", "exit", "1"]
    assert shlex.split(lines[2]) == ["conda", "activate", "env`id`", "||", "exit", "1"]
    jl = "lab --no-browser --ip 127.0.0.1 --port 8888 --ServerApp.port_retries=0"
    assert lines[-1] == (f"if command -v jupyter >/dev/null 2>&1; then exec jupyter {jl}; "
                         f"else exec python -m jupyter {jl}; fi")
    plain = commands.start({**p, "login_shell": False}).argv[-1]
    assert plain.splitlines()[0] == lines[0]  # plain mode sends the script itself
    direct = commands.start({**p, "mode": "direct"})
    assert "-L" not in direct.argv and "--ip 0.0.0.0" in direct.argv[-1]
    assert cmd.display.startswith("ssh -tt -i ") and "exec" not in cmd.display.split()[0]


def test_startup_steps_run_between_activate_and_jupyter(key):
    p = {"id": "x", **profiles.validate(profile_data(key, startup_steps="export A=1\r\n\ngit pull"))[0]}
    assert p["startup_steps"] == "export A=1\n\ngit pull" and p["login_shell"] is True
    lines = shlex.split(commands.start(p).argv[-1])[3].splitlines()
    i = next(n for n, ln in enumerate(lines) if ln.startswith("conda activate"))
    assert lines[i + 1:i + 3] == ["export A=1", "git pull"] and "jupyter" in lines[i + 3]
    with pytest.raises(profiles.ProfileError):
        profiles.validate(profile_data(key, startup_steps="x" * 5000))


def test_remote_command_quoting_never_executes(client, key, tmp_path, monkeypatch, fake_ssh):
    """End to end: the stub ssh runs the remote command with bash, like the server would."""
    work = tmp_path / "w"
    work.mkdir()
    monkeypatch.chdir(work)
    weird = work / "we ird $(touch PWNED1) `touch PWNED2` 'q\" ; touch PWNED3"
    weird.mkdir()
    fakebin = fake_ssh["bin"]
    (fakebin / "conda").write_text("#!/bin/sh\necho \"conda-args:$*\"\n")
    (fakebin / "jupyter").write_text("#!/bin/sh\necho \"cwd:$(pwd)\"\necho \"jupyter-args:$*\"\n")
    for f in ("conda", "jupyter"):
        (fakebin / f).chmod(0o755)
    monkeypatch.setenv("FAKE_SSH_MODE", "exec")
    # the login shell (bash -lic) reads ~/.profile / ~/.bashrc: use an empty HOME so the stubs stay on PATH
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    p = _create(client, key, remote_dir=str(weird), conda_env="env $(touch PWNED4); touch PWNED5",
                startup_steps="echo step-ran")
    job = client.post(f"/api/jupyter/profiles/{p['id']}/start", headers=H).json()
    s = _wait_state(client, job["job_id"], {"stopped", "failed"})
    from app.core import context
    text = "\n".join(context.jobs.get(job["job_id"]).output_since(0)["lines"])
    assert f"cwd:{weird}" in text
    assert "conda-args:activate env $(touch PWNED4); touch PWNED5" in text
    assert "step-ran" in text
    assert "jupyter-args:lab --no-browser --ip 127.0.0.1 --port 8888 --ServerApp.port_retries=0" in text
    assert not list(work.rglob("PWNED*")) and not list(tmp_path.glob("PWNED*")), s


# ---- profiles CRUD + storage ----------------------------------------------------------------------
def test_profile_crud_and_file_mode(client, key, tmp_path):
    from app.core import config
    p = _create(client, key)
    path = config.DATA_DIR / "jupyter" / "profiles.json"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert client.get("/api/jupyter/profiles").json()[0]["id"] == p["id"]
    r = client.put(f"/api/jupyter/profiles/{p['id']}", json=profile_data(key, name="prod", host="bad host"), headers=H)
    assert r.status_code == 400
    r = client.put(f"/api/jupyter/profiles/{p['id']}", json=profile_data(key, name="prod"), headers=H)
    assert r.json()["profile"]["name"] == "prod"
    assert client.post("/api/jupyter/profiles", json=profile_data(key), headers={}).status_code == 403
    groups = client.get("/api/search", params={"q": "prod"}).json()
    assert next(g for g in groups if g["service"] == "jupyter")["results"][0]["ref"] == p["id"]
    cmds = client.get(f"/api/jupyter/profiles/{p['id']}/commands").json()
    assert cmds["ssh_login"].startswith("ssh -i ") and "-N -L" in cmds["tunnel"]
    assert client.delete(f"/api/jupyter/profiles/{p['id']}", headers=H).json()["ok"]
    assert client.get("/api/jupyter/profiles").json() == []


# ---- pre-flight -----------------------------------------------------------------------------------
def test_check_closed_port_and_listening_socket(client, key):
    closed = _free_port()  # bound and released: nothing listens there
    p = _create(client, key, host="127.0.0.1", extra_ssh_args=f"-p {closed}")
    checks = {c["name"]: c for c in client.get(f"/api/jupyter/profiles/{p['id']}/check").json()}
    assert not checks["VPN / server reachable"]["ok"] and "VPN" in checks["VPN / server reachable"]["hint"]
    assert checks["Key file"]["ok"] and checks["ssh client"]["ok"] and checks["Local port"]["ok"]
    assert checks["VPN interface"]["level"] == "info"

    with socket.socket() as srv, socket.socket() as busy:
        srv.bind(("127.0.0.1", 0)); srv.listen()
        busy.bind(("127.0.0.1", 0)); busy.listen()
        p2 = _create(client, key, host="127.0.0.1", extra_ssh_args=f"-p {srv.getsockname()[1]}",
                     local_port=busy.getsockname()[1])
        checks = {c["name"]: c for c in client.get(f"/api/jupyter/profiles/{p2['id']}/check").json()}
        assert checks["VPN / server reachable"]["ok"]
        assert not checks["Local port"]["ok"] and checks["Local port"]["suggest_port"] > busy.getsockname()[1]


def test_key_permission_check_and_fix(client, key):
    key.chmod(0o644)
    p = _create(client, key)
    kc = next(c for c in client.get(f"/api/jupyter/profiles/{p['id']}/check").json() if c["name"] == "Key file")
    assert not kc["ok"] and kc["fixable"] and kc["hint"].startswith("chmod 600")
    r = client.post(f"/api/jupyter/profiles/{p['id']}/fix-key-perms", headers=H).json()
    assert r["ok"] and stat.S_IMODE(key.stat().st_mode) == 0o600


# ---- sessions -------------------------------------------------------------------------------------
def test_start_tunnel_ready_url_and_stop(client, key, fake_ssh):
    from app.core import config
    p = _create(client, key, local_port=18888)
    s = client.post(f"/api/jupyter/profiles/{p['id']}/start", headers=H).json()
    assert s["state"] in ("connecting", "ready")
    s = _wait_state(client, s["job_id"], {"ready", "failed"})
    assert s["state"] == "ready", s
    assert s["url"] == f"http://127.0.0.1:18888/lab?token={TOKEN}"
    assert client.post(f"/api/jupyter/profiles/{p['id']}/start", headers=H).status_code == 409
    argv = json.loads(fake_ssh["args"].read_text().splitlines()[0])
    assert argv[0] == "-tt" and "127.0.0.1:18888:127.0.0.1:8888" in argv
    assert any(x["job_id"] == s["job_id"] for x in client.get("/api/jupyter/sessions").json())

    client.post(f"/api/jupyter/sessions/{s['job_id']}/stop", headers=H)
    s = _wait_state(client, s["job_id"], {"stopped"})
    assert s["status"] == "cancelled" and s["url"] is None

    # the token is a credential: never in the audit log, the profiles file or job meta
    audit_text = (config.DATA_DIR / "audit" / "audit.jsonl").read_text()
    assert "jupyter" in audit_text and TOKEN not in audit_text
    assert TOKEN not in (config.DATA_DIR / "jupyter" / "profiles.json").read_text()
    assert TOKEN not in json.dumps(client.get("/api/jobs").json()[0]["meta"])


def test_start_direct_url(client, key):
    p = _create(client, key, mode="direct", remote_port=8888)
    s = client.post(f"/api/jupyter/profiles/{p['id']}/start", headers=H).json()
    s = _wait_state(client, s["job_id"], {"ready", "failed"})
    assert s["url"] == f"http://10.0.0.5:8888/lab?token={TOKEN}"
    client.post(f"/api/jupyter/sessions/{s['job_id']}/stop", headers=H)


@pytest.mark.parametrize("mode,needle,hint", [
    ("publickey", "publickey", "key"), ("timeout", "timed out", "VPN"),
    ("conda", "conda not found", "conda"), ("envnf", "environment not found", "conda env list"),
])
def test_error_translation(client, key, monkeypatch, mode, needle, hint):
    monkeypatch.setenv("FAKE_SSH_MODE", mode)
    p = _create(client, key)
    s = client.post(f"/api/jupyter/profiles/{p['id']}/start", headers=H).json()
    s = _wait_state(client, s["job_id"], {"failed"})
    assert needle in s["error"] and hint in s["hint"]


def test_translate_more_errors():
    assert "resolve" in parse.translate_error("ssh: Could not resolve hostname x: Name or service not known")["error"]
    assert "Local port" in parse.translate_error("bind [127.0.0.1]:8888: Address already in use")["error"]
    assert "remote folder" in parse.translate_error("bash: line 1: cd: /mnt/x: No such file or directory")["error"].lower()
    assert "jupyter not found" in parse.translate_error("bash: line 4: exec: jupyter: not found")["error"]
    assert "already in use on the server" in parse.translate_error("[C ServerApp] ERROR: the Jupyter server could not be started because port 8888 is already in use.")["error"]
    assert parse.translate_error("all good") is None


def test_find_url_variants():
    assert parse.find_url("http://localhost:8888/tree?token=ab12")["path"] == "/tree"
    no_auth = parse.find_url("[I ServerApp] Jupyter Server 2.1 is running at:\n[I ServerApp] http://h:8888/lab")
    assert no_auth == {"scheme": "http", "port": 8888, "path": "/lab", "token": ""}
    old = parse.find_url("The Jupyter Notebook is running at:\nhttp://(h or 127.0.0.1):8888/?token=ff")
    assert old["token"] == "ff" and old["port"] == 8888
    assert parse.find_url("file:///x/jpserver-1-open.html\nhttp://127.0.0.1:8888/api/kernels") is None


# ---- running servers ------------------------------------------------------------------------------
def test_parse_server_list():
    js = json.dumps({"url": "http://h:8890/", "token": "t1", "port": 8890, "root_dir": "/srv", "pid": 7})
    assert parse.parse_server_list(js + "\n\n") == [
        {"url": "http://h:8890/", "token": "t1", "port": 8890, "root_dir": "/srv", "pid": 7, "base_url": "/"}]
    text = "Currently running servers:\nhttp://h:8888/?token=abc :: /home/ubuntu/x\n"
    r = parse.parse_server_list(text)
    assert r[0]["token"] == "abc" and r[0]["port"] == 8888 and r[0]["root_dir"] == "/home/ubuntu/x"


def test_remote_servers_and_reuse(client, key, monkeypatch, fake_ssh):
    monkeypatch.setenv("FAKE_SSH_MODE", "list")
    lp = _free_port()
    p = _create(client, key, local_port=lp)
    servers = client.post(f"/api/jupyter/profiles/{p['id']}/remote-servers", headers=H).json()["servers"]
    assert servers[0]["port"] == 8890 and servers[0]["token"] == "cafe01"
    argv = json.loads(fake_ssh["args"].read_text().splitlines()[-1])
    assert "-tt" not in argv and "BatchMode=yes" in argv and "jupyter server list --json" in argv[-1]

    monkeypatch.setenv("FAKE_SSH_MODE", "tunnel")
    s = client.post(f"/api/jupyter/profiles/{p['id']}/reuse", json={"port": 8890, "token": "cafe01"}, headers=H).json()
    assert s["reuse"] and s["state"] == "connecting"  # nothing listens on the local port (stub tunnel)
    deadline = time.time() + 10
    while len(fake_ssh["args"].read_text().splitlines()) < 2 and time.time() < deadline:
        time.sleep(0.05)
    argv = json.loads(fake_ssh["args"].read_text().splitlines()[-1])
    assert "-N" in argv and f"127.0.0.1:{lp}:127.0.0.1:8890" in argv
    with socket.socket() as fake_tunnel:  # pretend the forward is up
        fake_tunnel.bind(("127.0.0.1", lp)); fake_tunnel.listen()
        s = client.get(f"/api/jupyter/sessions/{s['job_id']}").json()
        assert s["state"] == "ready" and s["url"] == f"http://127.0.0.1:{lp}/lab?token=cafe01"
    client.post(f"/api/jupyter/sessions/{s['job_id']}/stop", headers=H)

    d = _create(client, key, name="direct", mode="direct")
    r = client.post(f"/api/jupyter/profiles/{d['id']}/reuse", json={"port": 8890, "token": "cafe01"}, headers=H).json()
    assert r == {"url": "http://10.0.0.5:8890/lab?token=cafe01"}
    assert client.post(f"/api/jupyter/profiles/{d['id']}/reuse", json={"port": 8890, "token": "x y"}, headers=H).status_code == 422


def test_remote_servers_error(client, key, monkeypatch):
    monkeypatch.setenv("FAKE_SSH_MODE", "timeout")
    p = _create(client, key)
    r = client.post(f"/api/jupyter/profiles/{p['id']}/remote-servers", headers=H)
    assert r.status_code == 502 and "VPN" in r.json()["detail"]
