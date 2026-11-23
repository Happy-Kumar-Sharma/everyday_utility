"""Desktop launcher (launcher.py), the Linux installer scripts and the icon generator.

Windows is simulated (sys.platform, os.path.exists, the helper-command runner); nothing here opens a dialog or a
browser, and the installers only ever see a temporary HOME / XDG dirs.
"""

import http.server
import importlib.util
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("eu_launcher", ROOT / "launcher.py")
launcher = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(launcher)

WIN_FLAGS = 0x00000008 | 0x00000200 | 0x08000000


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("EU_LAUNCHER_NO_DIALOG", "1")
    monkeypatch.setenv("EU_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))  # no real ~/.config/everyday-utility.env
    monkeypatch.delenv("EU_PORT", raising=False)
    monkeypatch.setattr(launcher, "dialog", lambda *a, **k: pytest.fail("dialog shown"))
    return tmp_path


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def fake_server():
    """fake_server(status, body) -> port of a tiny HTTP server answering every GET with that response."""
    servers = []

    def start(status: int, body, delay: float = 0.0):
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                time.sleep(delay)
                data = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        servers.append(srv)
        return srv.server_address[1]

    yield start
    for srv in servers:
        srv.shutdown()
        srv.server_close()


# ---- ours / not ours ------------------------------------------------------------------------------
def test_probe_detects_our_server(fake_server):
    assert launcher.probe(fake_server(200, [{"id": "planner"}, {"id": "home", "title": "Home"}])) == "ours"


@pytest.mark.parametrize("status,body", [(200, [{"id": "planner"}]), (200, {"id": "home"}), (404, {"detail": "x"}),
                                         (200, b"<html>not json</html>")])
def test_probe_other_programs(fake_server, status, body):
    assert launcher.probe(fake_server(status, body)) == "other"


def test_probe_free_port_and_raw_tcp_listeners():
    assert launcher.probe(free_port()) == "free"
    with socket.socket() as s:  # something listening that never answers: can't tell yet
        s.bind(("127.0.0.1", 0))
        s.listen()
        assert launcher.probe(s.getsockname()[1], timeout=0.3) == "busy"
    with socket.socket() as s:  # a non-HTTP listener that answers garbage
        s.bind(("127.0.0.1", 0))
        s.listen()

        def garbage():
            conn, _ = s.accept()
            conn.sendall(b"SSH-2.0-OpenSSH\r\n")
            conn.close()

        threading.Thread(target=garbage, daemon=True).start()
        assert launcher.probe(s.getsockname()[1]) == "other"


def test_slow_answer_from_our_server_is_not_a_port_conflict(fake_server, monkeypatch):
    """Our server briefly busy (> 1 s to answer): retried with a longer timeout, never 'used by another program'."""
    port = fake_server(200, [{"id": "home"}], delay=1.3)
    assert launcher.probe(port) == "busy"
    assert launcher.settled_probe(port) == "ours"
    opened = []
    monkeypatch.setattr(launcher, "spawn_server", lambda *a, **k: pytest.fail("must not start a second server"))
    monkeypatch.setattr(launcher, "open_window", opened.append)
    assert launcher.main(["--port", str(port)]) == 0 and opened


def test_silent_port_is_reported_without_blaming_another_program(monkeypatch, capsys):
    monkeypatch.setattr(launcher, "probe", lambda port, timeout=1.0: "busy")
    monkeypatch.setattr(launcher, "spawn_server", lambda *a, **k: pytest.fail("must not start a server"))
    assert launcher.main(["--port", "8765", "--no-window"]) == 1
    err = capsys.readouterr().err
    assert "nothing answered" in err and "used by another program" not in err


def test_probe_ignores_http_proxy(fake_server, monkeypatch):
    monkeypatch.setenv("http_proxy", "http://127.0.0.1:9")
    assert launcher.probe(fake_server(200, [{"id": "home"}])) == "ours"


def test_port_taken_by_other_program_is_an_error(fake_server, monkeypatch, capsys):
    monkeypatch.setattr(launcher, "spawn_server", lambda *a, **k: pytest.fail("must not start a server"))
    port = fake_server(200, [])
    assert launcher.main(["--port", str(port), "--no-window"]) == 1
    assert "EU_PORT" in capsys.readouterr().err


def test_already_running_only_opens_the_window(fake_server, monkeypatch):
    opened = []
    monkeypatch.setattr(launcher, "spawn_server", lambda *a, **k: pytest.fail("must not start a second server"))
    monkeypatch.setattr(launcher, "open_window", opened.append)
    port = fake_server(200, [{"id": "home"}])
    assert launcher.main(["--port", str(port)]) == 0
    assert opened == [f"http://127.0.0.1:{port}/"]
    assert launcher.main(["--port", str(port), "--server-only"]) == 0
    assert len(opened) == 1


def test_env_file_supplies_settings_but_environment_wins(tmp_path, monkeypatch):
    env = tmp_path / "eu.env"
    env.write_text("# comment\n#EU_DATA_DIR=/nope\nEU_PORT=9123\nEU_REMOTE_HOSTS='box.ts.net'\nOTHER=1\n")
    monkeypatch.setenv("EU_REMOTE_HOSTS", "keep")
    monkeypatch.delenv("OTHER", raising=False)
    launcher.load_env_file(env)
    assert os.environ["EU_PORT"] == "9123" and os.environ["EU_REMOTE_HOSTS"] == "keep"
    assert "OTHER" not in os.environ and os.environ["EU_DATA_DIR"] != "/nope"


# ---- server command per OS ------------------------------------------------------------------------
def test_server_command_linux_uses_venv_python(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    py = tmp_path / "venv" / "bin" / "python"
    py.parent.mkdir(parents=True)
    py.touch()
    monkeypatch.setenv("EU_VENV", str(tmp_path / "venv"))
    cmd = launcher.server_command(8800)
    assert cmd == [str(py), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8800"]
    assert "--reload" not in cmd
    assert launcher.detach_kwargs() == {"start_new_session": True}


def test_server_command_falls_back_to_current_python(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setenv("EU_VENV", str(tmp_path / "missing"))
    assert launcher.server_command(8765)[0] == sys.executable


def test_server_command_windows_uses_pythonw_detached(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    pyw = tmp_path / "venv" / "Scripts" / "pythonw.exe"
    pyw.parent.mkdir(parents=True)
    pyw.touch()
    monkeypatch.setenv("EU_VENV", str(tmp_path / "venv"))
    assert launcher.server_command(8765)[0] == str(pyw)
    assert launcher.detach_kwargs() == {"creationflags": WIN_FLAGS}
    assert launcher.hidden_kwargs() == {"creationflags": 0x08000000}


def test_spawn_server_logs_and_detaches(monkeypatch):
    seen = {}

    class FakeProc:
        pid = 4321

    def fake_popen(cmd, **kw):
        seen.update(kw, cmd=cmd)
        return FakeProc()

    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(launcher.subprocess, "Popen", fake_popen)
    launcher.spawn_server(8899)
    assert seen["cwd"] == str(ROOT) and seen["start_new_session"] is True
    assert seen["env"]["EU_PORT"] == "8899" and seen["stdin"] == subprocess.DEVNULL
    assert "launcher starts" in (launcher.log_dir() / "server.log").read_text()


def test_start_failure_shows_the_server_log(monkeypatch, capsys):
    class DeadProc:
        pid = 99999999

        def poll(self):
            return 1

    def fake_spawn(port, detach=True):
        launcher.log_dir().mkdir(parents=True, exist_ok=True)
        (launcher.log_dir() / "server.log").write_text("".join(f"line {i}\n" for i in range(50)) + "ImportError: x\n")
        return DeadProc()

    monkeypatch.setattr(launcher, "spawn_server", fake_spawn)
    monkeypatch.setattr(launcher, "READY_TIMEOUT", 1.0)
    assert launcher.main(["--port", str(free_port()), "--no-window"]) == 1
    err = capsys.readouterr().err
    assert "ImportError: x" in err and "line 21" in err and "line 20\n" not in err  # last 30 lines
    assert not launcher.pid_file().exists()


# ---- browser discovery ----------------------------------------------------------------------------
def test_linux_browser_order(monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    installed = {"chromium": "/usr/bin/chromium", "microsoft-edge": "/usr/bin/microsoft-edge"}
    monkeypatch.setattr(launcher.shutil, "which", installed.get)
    assert launcher.find_app_browser() == "/usr/bin/chromium"
    installed["google-chrome"] = "/usr/bin/google-chrome"
    assert launcher.find_app_browser() == "/usr/bin/google-chrome"
    cmd = launcher.browser_command("/usr/bin/google-chrome", "http://127.0.0.1:8765/")
    assert cmd == ["/usr/bin/google-chrome", "--app=http://127.0.0.1:8765/", "--class=EverydayUtility"]
    monkeypatch.setattr(launcher.shutil, "which", lambda name: None)
    assert launcher.find_app_browser() is None


def test_windows_browser_order(monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setenv("ProgramFiles", r"C:\Program Files")
    monkeypatch.setenv("ProgramFiles(x86)", r"C:\Program Files (x86)")
    monkeypatch.setenv("LOCALAPPDATA", r"C:\Users\me\AppData\Local")
    chrome_user = r"C:\Users\me\AppData\Local\Google\Chrome\Application\chrome.exe"
    edge = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    present = {chrome_user}
    monkeypatch.setattr(launcher.os.path, "exists", lambda p: p in present)
    assert launcher.find_app_browser() == chrome_user
    present.add(edge)
    assert launcher.find_app_browser() == edge
    assert launcher.browser_command(edge, "http://127.0.0.1:8765/") == [edge, "--app=http://127.0.0.1:8765/"]
    present.clear()
    assert launcher.find_app_browser() is None


def test_open_window_falls_back_to_default_browser(monkeypatch):
    urls = []
    monkeypatch.setattr(launcher, "find_app_browser", lambda: None)
    monkeypatch.setattr(launcher.webbrowser, "open", urls.append)
    assert launcher.open_window("http://127.0.0.1:1/") == "default browser"
    assert urls == ["http://127.0.0.1:1/"]


def test_open_window_uses_app_mode_without_own_profile(monkeypatch):
    calls = []
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(launcher, "find_app_browser", lambda: "/usr/bin/google-chrome")
    monkeypatch.setattr(launcher.subprocess, "Popen", lambda cmd, **kw: calls.append(cmd))
    launcher.open_window("http://127.0.0.1:8765/")
    assert calls[0][1] == "--app=http://127.0.0.1:8765/"
    assert not any(a.startswith("--user-data-dir") for a in calls[0])


# ---- pid file, --stop, --status -------------------------------------------------------------------
def test_pid_file_roundtrip():
    assert launcher.read_pid() is None
    launcher.write_pid(1234)
    assert launcher.read_pid() == 1234
    launcher.remove_pid(only=999)
    assert launcher.read_pid() == 1234
    launcher.remove_pid()
    assert launcher.read_pid() is None
    launcher.pid_file().write_text("garbage")
    assert launcher.read_pid() is None


@pytest.fixture
def child():
    procs = []

    def start(*extra, cwd=None):
        p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", *extra], cwd=cwd)
        procs.append(p)
        time.sleep(0.2)
        return p

    yield start
    for p in procs:
        p.kill()
        p.wait()


def test_stop_refuses_to_kill_a_process_that_is_not_ours(child, capsys):
    other = child()
    launcher.write_pid(other.pid)
    assert launcher.main(["--stop", "--port", str(free_port())]) == 1
    assert other.poll() is None  # still alive
    assert not launcher.pid_file().exists()
    assert "Nothing was stopped" in capsys.readouterr().err


def uvicorn_args(port):
    return ("-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port))


def test_stop_terminates_our_server_process(child):
    port = free_port()
    ours = child(*uvicorn_args(port), cwd=ROOT)  # our uvicorn: app.main:app, --port, runs in this repo
    launcher.write_pid(ours.pid, port)
    assert launcher.pid_file().read_text().splitlines()[1] == f"port {port}"
    assert launcher.main(["--stop", "--port", str(port)]) == 0
    assert ours.wait(timeout=5) is not None
    assert not launcher.pid_file().exists()


def test_stop_spares_other_fastapi_projects_and_reused_pids(child, tmp_path, capsys):
    """A stale / reused pid of another app.main:app process is never killed."""
    port = free_port()
    elsewhere = tmp_path / "other-project"
    elsewhere.mkdir()
    cases = [(child(*uvicorn_args(port), cwd=elsewhere), {}),         # another FastAPI project (other cwd)
             (child(*uvicorn_args(9999), cwd=ROOT), {}),              # another port
             (child(*uvicorn_args(port), cwd=ROOT), {"start": "1"})]  # pid reused after a reboot / crash
    for proc, extra in cases:
        launcher.write_pid(proc.pid)
        if extra:
            launcher.pid_file().write_text(f"{proc.pid}\nport {port}\nstart {extra['start']}\n")
        assert launcher.main(["--stop", "--port", str(port)]) == 1
        assert "Nothing was stopped" in capsys.readouterr().err
        assert proc.poll() is None and not launcher.pid_file().exists()


def test_stop_with_pid_file_of_another_port_keeps_it(child, capsys):
    port = free_port()
    ours = child(*uvicorn_args(port), cwd=ROOT)
    launcher.write_pid(ours.pid, port)
    assert launcher.main(["--stop", "--port", str(port + 1)]) == 1
    assert f"--stop --port {port}" in capsys.readouterr().err
    assert ours.poll() is None and launcher.read_pid() == ours.pid


def test_stop_with_stale_pid_file(child, capsys):
    gone = child()
    gone.kill()
    gone.wait()
    launcher.write_pid(gone.pid)
    assert launcher.main(["--stop", "--port", str(free_port())]) == 0
    assert not launcher.pid_file().exists()
    assert "not running" in capsys.readouterr().out


def test_stop_leaves_a_server_started_elsewhere_alone(fake_server, capsys):
    port = fake_server(200, [{"id": "home"}])
    assert launcher.main(["--stop", "--port", str(port)]) == 1
    assert "started elsewhere" in capsys.readouterr().err


def test_status(fake_server, capsys):
    assert launcher.main(["--status", "--port", str(free_port())]) == 3
    assert "stopped" in capsys.readouterr().out
    port = fake_server(200, [{"id": "home"}])
    assert launcher.main(["--status", "--port", str(port)]) == 0
    assert f"running on http://127.0.0.1:{port}/" in capsys.readouterr().out


def test_windows_process_checks(monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    answers = {}
    monkeypatch.setattr(launcher, "_run", lambda cmd, timeout=15: answers.get(cmd[0], ""))
    answers["powershell"] = r'"C:\eu\.venv\Scripts\pythonw.exe" -m uvicorn app.main:app --port 8765' + "\r\n"
    assert launcher.looks_like_server(42, 8765)
    assert not launcher.looks_like_server(42, 8766)  # same kind of server, other port: not ours
    answers["powershell"] = r"C:\Windows\notepad.exe"
    assert not launcher.looks_like_server(42, 8765)
    answers.clear()  # no command line available: a python image that serves our app on the port
    answers["tasklist"] = '"pythonw.exe","42","Console","1","40,000 K"\r\n'
    monkeypatch.setattr(launcher, "probe", lambda port, timeout=1.0: "ours")
    assert launcher.looks_like_server(42, 8765) and launcher.pid_alive(42)
    monkeypatch.setattr(launcher, "probe", lambda port, timeout=1.0: "free")
    assert not launcher.looks_like_server(42, 8765)
    answers["tasklist"] = '"notepad.exe","42","Console","1","4,000 K"\r\n'
    assert not launcher.looks_like_server(42, 8765)
    answers["tasklist"] = "INFO: No tasks are running which match the specified criteria.\r\n"
    assert not launcher.pid_alive(42)


def test_windows_terminate_is_one_forced_taskkill(monkeypatch):
    """A windowless pythonw ignores a plain taskkill (WM_CLOSE), so don't wait 5 s for it: /T /F right away."""
    monkeypatch.setattr(sys, "platform", "win32")
    calls, alive = [], iter([True, False])
    monkeypatch.setattr(launcher, "_run", lambda cmd, timeout=15: calls.append(cmd) or "")
    monkeypatch.setattr(launcher, "pid_alive", lambda pid: next(alive))
    t0 = time.monotonic()
    launcher.terminate(77)
    assert calls == [["taskkill", "/PID", "77", "/T", "/F"]] and time.monotonic() - t0 < 2


def test_start_lock_lets_one_launcher_start(monkeypatch):
    state = {"probe": "free"}
    monkeypatch.setattr(launcher, "probe", lambda port, timeout=1.0: state["probe"])
    with launcher.start_lock(1) as first:
        assert first
        with launcher.start_lock(1, timeout=0.5) as second:  # held: waits, then gives up
            assert not second
        state["probe"] = "ours"
        t0 = time.monotonic()
        with launcher.start_lock(1, timeout=10) as third:  # held, but the server came up: done waiting
            assert not third and time.monotonic() - t0 < 1
    with launcher.start_lock(1) as again:
        assert again


def test_pid_written_only_for_the_process_that_serves(monkeypatch):
    """A server that lost the bind race (still exiting while the winner answers) never gets the pid file."""
    class Loser:
        pid = 99999999

        def poll(self):
            return 1

    monkeypatch.setattr(launcher, "spawn_server", lambda port, detach=True: Loser())
    answers = iter(["free", "free", "ours"])
    monkeypatch.setattr(launcher, "probe", lambda port, timeout=1.0: next(answers, "ours"))
    assert launcher.main(["--port", "8765", "--no-window"]) == 0
    assert not launcher.pid_file().exists()


def test_real_server_start_status_stop(tmp_path):
    """End to end: the launcher starts the real app detached on a free port, reports it, and stops it."""
    port = str(free_port())
    env = dict(os.environ, EU_VENV=str(tmp_path / "no-venv"))
    run = lambda *a: subprocess.run([sys.executable, str(ROOT / "launcher.py"), "--port", port, *a],  # noqa: E731
                                    env=env, capture_output=True, text=True, timeout=60)
    started = run("--server-only")
    try:
        assert started.returncode == 0, started.stderr
        pid = launcher.read_pid()
        assert pid and launcher.looks_like_server(pid, int(port), launcher.read_pid_record().get("start"))
        assert launcher.listens_on(pid, int(port)) is True
        assert launcher.probe(int(port)) == "ours"
        assert run("--server-only").returncode == 0 and launcher.read_pid() == pid  # single instance
        status = run("--status")
        assert status.returncode == 0 and f"pid {pid}" in status.stdout
    finally:
        stopped = run("--stop")
    assert stopped.returncode == 0, stopped.stderr
    assert launcher.probe(int(port)) == "free" and not launcher.pid_file().exists()
    assert "app.main:app" in (tmp_path / "data" / "logs" / "server.log").read_text()


@pytest.mark.skipif(not Path("/proc/net/tcp").exists(), reason="needs Linux /proc")
def test_concurrent_launchers_leave_the_serving_pid(tmp_path):
    """Three clicks at once: one server, server.pid names the process that serves, and --stop stops it."""
    port = str(free_port())
    env = dict(os.environ, EU_VENV=str(tmp_path / "no-venv"))
    cmd = [sys.executable, str(ROOT / "launcher.py"), "--port", port]
    procs = []
    for _ in range(3):
        procs.append(subprocess.Popen([*cmd, "--server-only"], env=env, stdout=subprocess.DEVNULL,
                                      stderr=subprocess.DEVNULL))
        time.sleep(0.1)
    try:
        assert [p.wait(timeout=60) for p in procs] == [0, 0, 0]
        pid = launcher.read_pid()
        assert pid and launcher.listens_on(pid, int(port)) is True
        assert (tmp_path / "data" / "server.log").exists() is False  # logs live under data/logs
        assert (tmp_path / "data" / "logs" / "server.log").read_text().count("launcher starts") == 1
    finally:
        stopped = subprocess.run([*cmd, "--stop"], env=env, capture_output=True, text=True, timeout=30)
    assert stopped.returncode == 0, stopped.stderr
    assert launcher.probe(int(port)) == "free"


# ---- Linux installer ------------------------------------------------------------------------------
def unquote_exec(value: str) -> list[str]:
    """Exec= value -> argv, per the Desktop Entry spec (string unescape, then the quoting rules, then %%)."""
    s = value.replace("\\\\", "\0").replace("\\s", " ").replace("\0", "\\")
    args, cur, quoted, i = [], "", False, 0
    while i < len(s):
        c = s[i]
        if quoted and c == "\\" and i + 1 < len(s):
            cur += s[i + 1]
            i += 2
            continue
        if c == '"':
            quoted = not quoted
        elif c == " " and not quoted:
            args.append(cur)
            cur = ""
        else:
            cur += c
        i += 1
    args.append(cur)
    return [a.replace("%%", "%") for a in args if a != ""]


def desktop_values(path: Path) -> dict:
    out = {}
    for line in path.read_text().splitlines():
        if "=" in line and not line.startswith(("#", "[")):
            key, _, val = line.partition("=")
            out.setdefault(key, val)
    return out


@pytest.fixture
def fake_repo(tmp_path):
    """A copy of the installable parts in a folder whose name needs quoting, plus a stand-in venv."""
    repo = tmp_path / "my apps" / "eu 100% $HOME"
    (repo / "scripts").mkdir(parents=True)
    for rel in ("launcher.py", "requirements.txt", "scripts/install_linux.sh", "scripts/uninstall_linux.sh",
                "scripts/make_icons.py"):
        shutil.copy(ROOT / rel, repo / rel)
    shutil.copytree(ROOT / "assets", repo / "assets")
    (repo / "data").mkdir()
    (repo / "data" / "keep.json").write_text("{}")
    venv = tmp_path / "venv"
    (venv / "bin").mkdir(parents=True)
    (venv / "bin" / "python").symlink_to(sys.executable)
    (venv / "pyvenv.cfg").write_text("home = /usr\n")
    return repo


def installer_env(tmp_path) -> dict:
    # no XDG dirs and no session bus: gio / update-desktop-database can only touch the temporary HOME
    env = {k: v for k, v in os.environ.items() if not k.startswith(("XDG_", "DBUS_"))}
    env.update(HOME=str(tmp_path / "home"), EU_VENV=str(tmp_path / "venv"), GIO_USE_VFS="local")
    (tmp_path / "home").mkdir(exist_ok=True)
    return env


def all_files(root: Path) -> list[Path]:
    return sorted(p for p in root.rglob("*") if p.is_file())


def test_install_linux_dry_run_changes_nothing(fake_repo, tmp_path):
    env = installer_env(tmp_path)
    out = subprocess.run(["bash", str(fake_repo / "scripts/install_linux.sh"), "--dry-run", "--autostart",
                          "--desktop-shortcut"], env=env, capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    assert all_files(tmp_path / "home") == []
    assert "[Desktop Entry]" in out.stdout and "StartupWMClass=EverydayUtility" in out.stdout
    assert "--server-only --no-window" in out.stdout and "Actions=stop;status;" in out.stdout
    exec_line = next(line.strip() for line in out.stdout.splitlines() if line.strip().startswith("Exec="))
    assert unquote_exec(exec_line[5:]) == [str(tmp_path / "venv/bin/python"), str(fake_repo / "launcher.py")]


def test_install_linux_real_run_and_uninstall(fake_repo, tmp_path):
    env = installer_env(tmp_path)
    home = tmp_path / "home"
    out = subprocess.run(["bash", str(fake_repo / "scripts/install_linux.sh"), "--no-deps", "--autostart",
                          "--desktop-shortcut"], env=env, capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    apps = home / ".local/share/applications/everyday-utility.desktop"
    autostart = home / ".config/autostart/everyday-utility.desktop"
    icons = [home / ".local/share/icons/hicolor" / p for p in
             ("48x48/apps/everyday-utility.png", "256x256/apps/everyday-utility.png", "scalable/apps/everyday-utility.svg")]
    desktop_copy = next((home).glob("*/everyday-utility.desktop"), None)
    assert apps.is_file() and autostart.is_file() and all(p.is_file() for p in icons)
    assert desktop_copy is not None and os.access(desktop_copy, os.X_OK)

    values = desktop_values(apps)
    assert values["Name"] == "Everyday Utility" and values["Icon"] == "everyday-utility"
    assert values["Terminal"] == "false" and values["StartupWMClass"] == "EverydayUtility"
    assert values["Categories"] == "Development;Utility;"
    py, script = str(tmp_path / "venv/bin/python"), str(fake_repo / "launcher.py")
    assert unquote_exec(values["Exec"]) == [py, script]
    assert unquote_exec(apps.read_text().split("[Desktop Action stop]")[1].split("Exec=")[1].splitlines()[0]) == \
        [py, script, "--stop"]
    assert unquote_exec(desktop_values(autostart)["Exec"]) == [py, script, "--server-only", "--no-window"]
    if shutil.which("desktop-file-validate"):
        for f in (apps, autostart):
            check = subprocess.run(["desktop-file-validate", str(f)], capture_output=True, text=True)
            assert check.returncode == 0 and "error" not in check.stdout.lower(), check.stdout

    # idempotent: a second run (without the flags) refreshes the same files, autostart included
    again = subprocess.run(["bash", str(fake_repo / "scripts/install_linux.sh"), "--no-deps"], env=env,
                           capture_output=True, text=True, timeout=120)
    assert again.returncode == 0 and autostart.is_file() and apps.read_text().count("[Desktop Entry]") == 1

    foreign = home / ".config/autostart/other.desktop"
    foreign.write_text("[Desktop Entry]\nName=Other\n")
    gone = subprocess.run(["bash", str(fake_repo / "scripts/install_linux.sh"), "--uninstall", "--purge-venv"],
                          env=env, capture_output=True, text=True, timeout=60)
    assert gone.returncode == 0, gone.stderr
    assert not apps.exists() and not autostart.exists() and not desktop_copy.exists()
    assert not any(p.exists() for p in icons)
    assert foreign.exists() and (fake_repo / "data" / "keep.json").exists()
    assert not (tmp_path / "venv").exists()


def test_uninstall_keeps_files_it_did_not_write(fake_repo, tmp_path):
    env = installer_env(tmp_path)
    mine = tmp_path / "home/.local/share/applications/everyday-utility.desktop"
    mine.parent.mkdir(parents=True)
    mine.write_text("[Desktop Entry]\nName=Hand made\n")
    out = subprocess.run(["bash", str(fake_repo / "scripts/uninstall_linux.sh")], env=env, capture_output=True,
                         text=True, timeout=60)
    assert out.returncode == 0 and mine.exists()


# ---- Windows scripts (static checks: no PowerShell here) -----------------------------------------
@pytest.mark.parametrize("name", ["install_windows.ps1", "uninstall_windows.ps1", "install_windows.bat",
                                  "uninstall_windows.bat"])
def test_windows_scripts_are_ascii(name):
    data = (ROOT / "scripts" / name).read_bytes()
    assert data.isascii()  # Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page
    if name.endswith(".bat"):
        assert b"\r\n" in data and b"\n" not in data.replace(b"\r\n", b"")
        assert f'-File "%~dp0{name[:-4]}.ps1" %*'.encode() in data


# ---- icons ----------------------------------------------------------------------------------------
def test_make_icons(tmp_path):
    from PIL import Image

    spec = importlib.util.spec_from_file_location("make_icons", ROOT / "scripts" / "make_icons.py")
    make_icons = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(make_icons)
    png, png48, ico = make_icons.main(tmp_path)
    assert Image.open(png).size == (256, 256) and Image.open(png48).size == (48, 48)
    assert set(Image.open(ico).info["sizes"]) == {(s, s) for s in (16, 24, 32, 48, 64, 128, 256)}
    img = Image.open(png).convert("RGBA")
    assert img.getpixel((0, 0))[3] == 0 and img.getpixel((128, 30))[3] == 255  # transparent corner, solid tile
    for name in ("icon.png", "icon-48.png", "icon.ico", "icon.svg"):
        assert (ROOT / "assets" / name).is_file()
