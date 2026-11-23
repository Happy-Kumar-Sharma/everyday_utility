#!/usr/bin/env python3
"""Everyday Utility desktop launcher: start the local server in the background (once) and open the app window.

    launcher.py                 make sure the server runs, then open the app window
    launcher.py --server-only   only make sure the server runs (autostart at login)
    launcher.py --no-window     same, used by the WSL shortcut (Windows opens the window itself)
    launcher.py --stop          stop the server this launcher started
    launcher.py --status        running / stopped + URL
    launcher.py --foreground    run the server in this process until it stops (WSL shortcut keeps wsl.exe alive)
    --port N                    instead of EU_PORT / 8765

Standard library only: it runs before (and without) the venv packages. Works on Linux and Windows; on macOS
the window falls back to the default browser. The installers in scripts/ create the app-grid / Start menu entries.
Logs: <data>/logs/launcher.log and <data>/logs/server.log (data = EU_DATA_DIR or <repo>/data).
"""

from __future__ import annotations

import argparse
import contextlib
import http.client
import json
import ntpath
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from datetime import datetime
from pathlib import Path

try:  # the start lock: fcntl on Linux / macOS, msvcrt on Windows
    import fcntl
except ImportError:
    fcntl = None
try:
    import msvcrt
except ImportError:
    msvcrt = None

ROOT = Path(__file__).resolve().parent
APP_NAME = "Everyday Utility"
WM_CLASS = "EverydayUtility"  # matches StartupWMClass in the .desktop file so the dock groups the window
DEFAULT_PORT = 8765
READY_TIMEOUT = 30.0
STOP_TIMEOUT = 5.0
LINUX_BROWSERS = ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "brave-browser",
                  "microsoft-edge", "microsoft-edge-stable")
MAC_BROWSERS = ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                "/Applications/Chromium.app/Contents/MacOS/Chromium")
# Win32 process creation flags (subprocess only defines them on Windows)
DETACHED_PROCESS, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW = 0x00000008, 0x00000200, 0x08000000
# urllib without proxies: http_proxy in the environment must never see (or break) the loopback check
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def is_windows() -> bool:
    return sys.platform == "win32"  # read at call time so tests can simulate Windows


# ---- paths, settings, logging -----------------------------------------------------------------
def data_dir() -> Path:
    return Path(os.environ.get("EU_DATA_DIR") or ROOT / "data").expanduser()


def pid_file() -> Path:
    return data_dir() / "server.pid"


def log_dir() -> Path:
    return data_dir() / "logs"


def stamp() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def log(msg: str) -> None:
    try:
        log_dir().mkdir(parents=True, exist_ok=True)
        with open(log_dir() / "launcher.log", "a", encoding="utf-8") as f:
            f.write(f"{stamp()} [{os.getpid()}] {msg}\n")
    except OSError:
        pass


def load_env_file(path: Path | None = None) -> None:
    """EU_* settings shared with the systemd service (~/.config/everyday-utility.env); the environment wins."""
    try:
        lines = (path or Path.home() / ".config" / "everyday-utility.env").read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for line in lines:
        key, sep, value = line.strip().partition("=")
        if sep and key.strip().startswith("EU_"):  # '#EU_PORT=…' (commented out) doesn't start with EU_
            os.environ.setdefault(key.strip(), value.strip().strip("'\""))


def app_url(port: int, host: str = "127.0.0.1") -> str:
    return f"http://{host}:{port}/"


# ---- messages: terminal, or a dialog when there is no terminal (app grid, Start menu) -------------
def dialogs_wanted() -> bool:
    if os.environ.get("EU_LAUNCHER_NO_DIALOG"):
        return False
    out = sys.stdout
    return out is None or not out.isatty()  # pythonw has no stdout at all


def dialog(text: str, error: bool) -> None:
    title = APP_NAME
    try:
        if is_windows():
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, text, title, 0x10 if error else 0x40)  # MB_ICONERROR / INFO
            return
        if shutil.which("zenity"):
            subprocess.run(["zenity", "--error" if error else "--info", "--no-markup", "--width=560",
                            f"--title={title}", f"--text={text}"], stdin=subprocess.DEVNULL,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        elif shutil.which("notify-send"):
            subprocess.run(["notify-send", "--app-name", title, "-u", "critical" if error else "normal",
                            title, text], check=False)
        elif sys.platform == "darwin":
            subprocess.run(["osascript", "-e", f"display alert {json.dumps(title)} message {json.dumps(text)}"],
                           check=False)
    except Exception as exc:  # noqa: BLE001 - a dialog failing must never hide the message itself
        log(f"dialog failed: {exc}")


def tell(text: str, error: bool = False) -> None:
    log(("ERROR: " if error else "") + text)
    stream = sys.stderr if error else sys.stdout
    if stream is not None:
        print(text, file=stream)
    if dialogs_wanted():
        dialog(text, error)


# ---- is the server (ours) running? ----------------------------------------------------------------
def port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


def probe(port: int, timeout: float = 1.0) -> str:
    """'ours' (GET /api/services lists the home service), 'other' (a different HTTP answer or a non-HTTP
    listener), 'busy' (the port is open but no answer came in time: maybe ours, briefly busy) or 'free'."""
    try:
        with _OPENER.open(f"http://127.0.0.1:{port}/api/services", timeout=timeout) as resp:
            data = json.loads(resp.read(2_000_000))
    except urllib.error.HTTPError:
        return "other"
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, TimeoutError):
            return "busy" if port_open(port) else "free"
        return "other" if port_open(port) else "free"
    except TimeoutError:  # read timeout (socket.timeout is TimeoutError)
        return "busy" if port_open(port) else "free"
    except (http.client.HTTPException, OSError, ValueError):  # garbage / closed connection / not JSON
        return "other" if port_open(port) else "free"
    ours = isinstance(data, list) and any(isinstance(s, dict) and s.get("id") == "home" for s in data)
    return "ours" if ours else "other"


def settled_probe(port: int, retries: int = 3, timeout: float = 3.0) -> str:
    """probe(), asking again with a longer timeout while the port is open but silent ('busy')."""
    state = probe(port)
    for _ in range(retries):
        if state != "busy":
            break
        state = probe(port, timeout=timeout)
    return state


# ---- starting the server --------------------------------------------------------------------------
def venv_dir() -> Path:
    return Path(os.environ.get("EU_VENV") or ROOT / ".venv")


def server_python() -> str:
    """The venv's python (pythonw.exe on Windows: no console window), else the python running this script."""
    venv = venv_dir()
    cand = venv / "Scripts" / "pythonw.exe" if is_windows() else venv / "bin" / "python"
    if cand.exists():
        return str(cand)
    if is_windows():
        pythonw = ntpath.join(ntpath.dirname(sys.executable), "pythonw.exe")
        if os.path.exists(pythonw):
            return pythonw
    return sys.executable


def server_command(port: int) -> list[str]:
    return [server_python(), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port)]


def detach_kwargs() -> dict:
    """Popen options so the child outlives the launcher and has no console / terminal."""
    if is_windows():
        return {"creationflags": DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW}
    return {"start_new_session": True}


def hidden_kwargs() -> dict:
    """For short helper commands (tasklist, taskkill …) run from pythonw: no console window flashing up."""
    return {"creationflags": CREATE_NO_WINDOW} if is_windows() else {}


def spawn_server(port: int, detach: bool = True) -> subprocess.Popen:
    cmd = server_command(port)
    log_dir().mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, EU_PORT=str(port), PYTHONUNBUFFERED="1")
    with open(log_dir() / "server.log", "ab") as out:
        out.write(f"\n--- {stamp()} launcher starts: {' '.join(cmd)}\n".encode())
        out.flush()
        proc = subprocess.Popen(cmd, cwd=str(ROOT), env=env, stdin=subprocess.DEVNULL, stdout=out,
                                stderr=subprocess.STDOUT, **(detach_kwargs() if detach else {}))
    log(f"started server pid {proc.pid}: {' '.join(cmd)}")
    return proc


def wait_ready(proc: subprocess.Popen, port: int, timeout: float = READY_TIMEOUT) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if probe(port) == "ours":
            return True
        if proc.poll() is not None:  # exited: maybe another launcher won the race and its server is up
            time.sleep(0.3)
            return probe(port) == "ours"
        time.sleep(0.25)
    return False


def process_start_time(pid: int) -> str | None:
    """Linux: the process start time (/proc/<pid>/stat field 22) so a reused pid is never mistaken for ours."""
    try:
        return Path(f"/proc/{pid}/stat").read_text(encoding="ascii").rpartition(")")[2].split()[19]
    except (OSError, IndexError, UnicodeDecodeError):
        return None


def write_pid(pid: int, port: int | None = None) -> None:
    """server.pid: the pid, then 'port N' and 'start T' (Linux) lines checked by --stop."""
    pid_file().parent.mkdir(parents=True, exist_ok=True)
    lines = [str(pid)] + ([f"port {port}"] if port else [])
    start = process_start_time(pid)
    pid_file().write_text("\n".join(lines + ([f"start {start}"] if start else [])) + "\n", encoding="ascii")


def read_pid_record() -> dict:
    """{'pid': int, 'port': int?, 'start': str?} from server.pid, {} when missing or invalid."""
    try:
        first, *rest = pid_file().read_text(encoding="ascii").split("\n")
        rec = {"pid": int(first.strip())}
        for line in rest:
            key, _, value = line.strip().partition(" ")
            if key == "port":
                rec["port"] = int(value)
            elif key == "start" and value:
                rec["start"] = value
    except (OSError, ValueError, UnicodeDecodeError):
        return {}
    return rec if rec["pid"] > 0 else {}


def read_pid() -> int | None:
    return read_pid_record().get("pid")


def remove_pid(only: int | None = None) -> None:
    if only is not None and read_pid() != only:
        return
    try:
        pid_file().unlink()
    except OSError:
        pass


def tail(path: Path, lines: int = 30) -> str:
    try:
        return "\n".join(path.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:])
    except OSError:
        return "(no log yet)"


def port_in_use_message(port: int, state: str = "other") -> str:
    fix = (f"pick another port: set EU_PORT (e.g. EU_PORT=8766) in ~/.config/everyday-utility.env or the "
           f"environment, or run the launcher with --port 8766.")
    if state == "busy":
        return (f"Port {port} is open but nothing answered within a few seconds.\n\nIf {APP_NAME} is running "
                f"and busy, wait a moment and try again. If another program holds the port, close it or {fix}")
    return f"Port {port} is used by another program, not by {APP_NAME}.\n\nClose that program, or {fix}"


def _try_lock(f) -> bool:
    try:
        if fcntl is not None:
            fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        elif msvcrt is not None:
            f.seek(0)
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
        return True  # (no locking facility at all: proceed unlocked)
    except OSError:
        return False


@contextlib.contextmanager
def start_lock(port: int, timeout: float = READY_TIMEOUT + 5):
    """Serialise server starts between launchers (two quick clicks, autostart + click): yields True while this
    launcher holds <data>/launcher.lock, False when another launcher brought the server up meanwhile (or the
    wait timed out). The OS drops the lock if the holder dies; the server never inherits it (close_fds)."""
    data_dir().mkdir(parents=True, exist_ok=True)
    with open(data_dir() / "launcher.lock", "a+b") as f:
        deadline = time.monotonic() + timeout
        while not _try_lock(f):
            if probe(port) == "ours" or time.monotonic() > deadline:
                yield False
                return
            time.sleep(0.25)
        try:
            yield True
        finally:
            with contextlib.suppress(OSError):
                if fcntl is not None:
                    fcntl.flock(f.fileno(), fcntl.LOCK_UN)
                elif msvcrt is not None:
                    f.seek(0)
                    msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)


def listens_on(pid: int, port: int) -> bool | None:
    """Linux: does pid own the listening TCP socket on port? None when that can't be told (no /proc)."""
    inodes = set()
    for name in ("tcp", "tcp6"):
        try:
            rows = Path(f"/proc/net/{name}").read_text(encoding="ascii").splitlines()[1:]
        except OSError:
            continue
        for row in rows:
            f = row.split()  # sl local_address rem_address st ... inode (index 9)
            if len(f) > 9 and f[3] == "0A" and int(f[1].rpartition(":")[2], 16) == port:
                inodes.add(f"socket:[{f[9]}]")
    try:
        fds = os.listdir(f"/proc/{pid}/fd")
    except OSError:
        return None
    if not inodes:
        return False
    for fd in fds:
        with contextlib.suppress(OSError):
            if os.readlink(f"/proc/{pid}/fd/{fd}") in inodes:
                return True
    return False


def serving(proc: subprocess.Popen, port: int) -> bool:
    """After the port answered: is it really this process (not one that lost a bind race and is exiting)?"""
    owns = None if is_windows() else listens_on(proc.pid, port)
    if owns is None:
        time.sleep(1.0)  # no /proc: a process that failed to bind is gone by now
    return proc.poll() is None and owns is not False


def start_server(port: int, detach: bool = True) -> tuple[bool, subprocess.Popen | None]:
    """(running?, the server process this launcher started or None). Only one launcher starts at a time."""
    state = settled_probe(port)
    if state == "ours":
        log(f"server already running on port {port}")
        return True, None
    if state != "free":
        tell(port_in_use_message(port, state), error=True)
        return False, None
    with start_lock(port) as mine:
        if not mine:
            if probe(port) == "ours":
                log("another launcher started the server")
                return True, None
            tell(f"Another {APP_NAME} launcher is still starting the server. Try again in a moment.", error=True)
            return False, None
        state = settled_probe(port)  # it may have come up while we waited for the lock
        if state == "ours":
            return True, None
        if state != "free":
            tell(port_in_use_message(port, state), error=True)
            return False, None
        try:
            proc = spawn_server(port, detach=detach)
        except OSError as exc:
            tell(f"Could not start the server: {exc}", error=True)
            return False, None
        if wait_ready(proc, port):
            if serving(proc, port):  # only the process that actually serves gets the pid file
                write_pid(proc.pid, port)
            else:
                log(f"pid {proc.pid} is not the one serving port {port}: no pid file")
            return True, proc
        if proc.poll() is None:
            write_pid(proc.pid, port)  # still starting: keep --stop working
    server_log = log_dir() / "server.log"
    tell(f"{APP_NAME} did not start within {READY_TIMEOUT:.0f} s.\n\nLast lines of {server_log}:\n\n"
         f"{tail(server_log)}", error=True)
    return False, proc


def ensure_running(port: int) -> bool:
    return start_server(port)[0]


def run_foreground(port: int) -> int:
    """Run the server as a child and wait for it (keeps the calling wsl.exe alive); --stop still works."""
    ok, proc = start_server(port, detach=False)
    if proc is None or not ok:
        if proc is not None and proc.poll() is None:
            proc.terminate()  # did not get ready: don't leave it behind the closed wsl.exe
            remove_pid(only=proc.pid)
        return 0 if ok else 1
    try:
        code = proc.wait()
    except KeyboardInterrupt:
        proc.terminate()
        code = proc.wait()
    remove_pid(only=proc.pid)
    log(f"foreground server exited with {code}")
    return code


# ---- the app window -------------------------------------------------------------------------------
def windows_browsers() -> list[str]:
    env = os.environ
    edge = [ntpath.join(base, "Microsoft", "Edge", "Application", "msedge.exe")
            for base in (env.get("ProgramFiles(x86)"), env.get("ProgramFiles")) if base]
    chrome = [ntpath.join(base, "Google", "Chrome", "Application", "chrome.exe")
              for base in (env.get("ProgramFiles"), env.get("ProgramFiles(x86)"), env.get("LOCALAPPDATA")) if base]
    return edge + chrome


def find_app_browser() -> str | None:
    """A Chromium-based browser that can open an app-mode window (--app=URL), or None."""
    if is_windows():
        return next((p for p in windows_browsers() if os.path.exists(p)), None)
    if sys.platform == "darwin":
        return next((p for p in MAC_BROWSERS if os.path.exists(p)), None)
    return next((p for p in map(shutil.which, LINUX_BROWSERS) if p), None)


def browser_command(browser: str, url: str) -> list[str]:
    cmd = [browser, f"--app={url}"]
    if not is_windows() and sys.platform != "darwin":
        cmd.append(f"--class={WM_CLASS}")  # X11 / XWayland WM_CLASS, only applied when the browser starts fresh
    return cmd


def open_window(url: str) -> str:
    browser = find_app_browser()
    if browser:
        try:
            subprocess.Popen(browser_command(browser, url), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, **detach_kwargs())
            log(f"opened app window with {browser}")
            return browser
        except OSError as exc:
            log(f"{browser} failed ({exc}); using the default browser")
    webbrowser.open(url)
    log("opened the default browser (no Chrome / Edge / Chromium found for an app window)")
    return "default browser"


# ---- stop / status --------------------------------------------------------------------------------
def _run(cmd: list[str], timeout: float = 15) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False,
                              stdin=subprocess.DEVNULL, **hidden_kwargs()).stdout or ""
    except (OSError, subprocess.SubprocessError):
        return ""


def _tasklist_image(pid: int) -> str:
    """Image name of a running pid on Windows ('' when there is no such process)."""
    out = _run(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"]).strip()
    if not out.startswith('"'):
        return ""  # "INFO: No tasks are running which match the specified criteria."
    return out.split('","')[0].strip('"')


def pid_alive(pid: int) -> bool:
    if is_windows():
        return bool(_tasklist_image(pid))
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def process_cmdline(pid: int) -> str:
    """Full command line of pid ('' when it can't be read)."""
    if is_windows():
        out = _run(["powershell", "-NoProfile", "-NonInteractive", "-Command",
                    f"(Get-CimInstance Win32_Process -Filter 'ProcessId={pid}').CommandLine"])
        if out.strip():
            return out.strip()
        out = _run(["wmic", "process", "where", f"ProcessId={pid}", "get", "CommandLine"])  # older Windows
        return "\n".join(out.splitlines()[1:]).strip()
    try:
        return Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace").strip()
    except OSError:
        return _run(["ps", "-p", str(pid), "-o", "command="]).strip()  # macOS: no /proc


def looks_like_server(pid: int, port: int, start: str | None = None) -> bool:
    """Only ever kill this install's uvicorn: the command line names app.main:app and --port <port>; on Linux the
    working directory is this repo and the start time matches the one recorded in server.pid.
    Windows without a readable command line: a python image that is serving our app on that port."""
    cmdline = process_cmdline(pid)
    if not cmdline:
        return (is_windows() and _tasklist_image(pid).lower().startswith("python")
                and probe(port) == "ours")
    args = cmdline.replace('"', " ").split()
    if "app.main:app" not in args or not re.search(rf"(?:^|\s)--port[= ]{port}(?:\s|$)", " ".join(args)):
        return False
    if not is_windows() and Path("/proc").is_dir():
        try:
            if Path(os.readlink(f"/proc/{pid}/cwd")).resolve() != ROOT:
                return False
        except OSError:
            return False
        if start and process_start_time(pid) != start:
            return False
    return True


def terminate(pid: int) -> None:
    if is_windows():
        # A windowless pythonw server ignores a plain taskkill (it only sends WM_CLOSE), so Stop on Windows is a
        # hard kill: the app's shutdown hooks don't run (stored data is written as it changes, nothing is lost).
        _run(["taskkill", "/PID", str(pid), "/T", "/F"])
    else:
        os.kill(pid, signal.SIGTERM)  # uvicorn shuts down gracefully (jobs are stopped by the app)
    deadline = time.monotonic() + STOP_TIMEOUT
    while time.monotonic() < deadline:
        if not pid_alive(pid):
            return
        time.sleep(0.2)
    log(f"pid {pid} still running after {STOP_TIMEOUT:.0f} s: killing it")
    if is_windows():
        _run(["taskkill", "/PID", str(pid), "/T", "/F"])
    else:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def stop(port: int) -> int:
    rec = read_pid_record()
    pid = rec.get("pid")
    if pid is None or not pid_alive(pid):
        if pid is not None:
            remove_pid()
            log(f"removed stale pid file ({pid})")
        state = settled_probe(port)
        if state == "ours":
            tell(f"{APP_NAME} on {app_url(port)} was started elsewhere (./run.sh, the systemd service or a "
                 "terminal), so it is not stopped from here. Stop it where it runs: Ctrl+C in its terminal, or "
                 "systemctl --user stop everyday-utility.", error=True)
            return 1
        if state == "busy":
            tell(port_in_use_message(port, state), error=True)
            return 1
        tell(f"{APP_NAME} is not running.")
        return 0
    if rec.get("port", port) != port:
        tell(f"{pid_file()} belongs to the server on port {rec['port']}, not {port}. Nothing was stopped; "
             f"use --stop --port {rec['port']}.", error=True)
        return 1
    if not looks_like_server(pid, port, rec.get("start")):
        remove_pid()
        tell(f"Process {pid} from {pid_file()} is not the {APP_NAME} server (stale pid file, removed). "
             "Nothing was stopped.", error=True)
        return 1
    terminate(pid)
    remove_pid()
    tell(f"Stopped {APP_NAME} (pid {pid}).")
    return 0


def status(port: int) -> int:
    state, pid = settled_probe(port), read_pid()
    if state == "ours":
        how = f"pid {pid}" if pid and pid_alive(pid) else "started outside the launcher"
        tell(f"{APP_NAME} is running on {app_url(port)} ({how}).")
        return 0
    if state != "free":
        tell(port_in_use_message(port, state), error=True)
        return 1
    tell(f"{APP_NAME} is stopped ({app_url(port)}).")
    return 3


# ---- entry point ----------------------------------------------------------------------------------
def parse_args(argv: list[str] | None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="launcher.py", description=f"Start {APP_NAME} and open its window.")
    ap.add_argument("--server-only", action="store_true", help="start the server if needed, open no window")
    ap.add_argument("--no-window", action="store_true", help="same as --server-only")
    ap.add_argument("--stop", action="store_true", help="stop the server started by this launcher")
    ap.add_argument("--status", action="store_true", help="print whether the server runs, and its URL")
    ap.add_argument("--foreground", action="store_true", help="run the server in this process until it stops")
    ap.add_argument("--port", type=int, help="port (default: EU_PORT or 8765)")
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    load_env_file()
    try:
        port = args.port or int(os.environ.get("EU_PORT") or DEFAULT_PORT)
    except ValueError:
        tell(f"EU_PORT must be a number, got {os.environ.get('EU_PORT')!r}.", error=True)
        return 2
    log(f"launcher {' '.join(argv if argv is not None else sys.argv[1:]) or '(open)'} port={port}")
    if args.stop:
        return stop(port)
    if args.status:
        return status(port)
    if args.foreground:
        return run_foreground(port)
    if not ensure_running(port):
        return 1
    if not (args.server_only or args.no_window):
        open_window(app_url(port))
    return 0


if __name__ == "__main__":
    sys.exit(main())
