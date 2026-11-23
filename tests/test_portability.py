"""Windows / POSIX differences (app.core.platform and its callers). Windows is simulated on Linux by patching
IS_WINDOWS, os.environ, shutil.which, os.path.isfile and subprocess; nothing here needs a real Windows box."""

import json
import ntpath
import os
import signal
import stat
import subprocess
import sys
import time
from pathlib import PureWindowsPath

import pytest

from app.core import config, gitsafety, jobs, postgres
from app.core import platform as plat
from app.core.jobs import CANCELLED, FAILED, JobManager
from app.services.asmnt_sync import commands as asmnt_commands
from app.services.asmnt_sync import vpn
from app.services.clipper import fetcher
from app.services.home import wellbeing as wb
from app.services.inference_pipeline import commands as ip_commands
from app.services.jupyter import checks as jchecks

PF, PF86, LAD = r"C:\Program Files", r"C:\Program Files (x86)", r"C:\Users\me\AppData\Local"
GIT_PF = ntpath.join(PF, "Git", "bin", "bash.exe")
GIT_LAD = ntpath.join(LAD, "Programs", "Git", "bin", "bash.exe")
WSL_BASH = r"C:\Windows\System32\bash.exe"


def _which_on(files):
    """shutil.which(name, path=folder) over the fake file system (Windows: bash -> bash.exe)."""
    def which(name, path=None):
        for folder in (path or "").split(";"):
            cand = ntpath.join(folder, name + ".exe") if folder else ""
            if cand in files:
                return cand
        return None
    return which


@pytest.fixture()
def windows(monkeypatch):
    """Simulated Windows: IS_WINDOWS, the usual env vars, and a fake file system of existing files."""
    monkeypatch.setattr(plat, "IS_WINDOWS", True)
    for k, v in (("ProgramFiles", PF), ("ProgramFiles(x86)", PF86), ("LocalAppData", LAD),
                 ("USERPROFILE", r"C:\Users\me"), ("PATH", r"C:\Windows\System32;C:\Windows")):
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("EU_BASH", raising=False)
    files: set[str] = set()
    monkeypatch.setattr(os.path, "isfile", lambda p: str(p) in files)
    monkeypatch.setattr(plat.shutil, "which", _which_on(files))
    return files


# ---- find_bash -------------------------------------------------------------------------------------
def test_find_bash_posix_uses_path(monkeypatch):
    monkeypatch.setattr(plat, "IS_WINDOWS", False)
    monkeypatch.setattr(plat.shutil, "which", lambda name: f"/usr/bin/{name}")
    assert plat.find_bash() == "/usr/bin/bash"


def test_find_bash_skips_wsl_launcher_and_picks_git(windows, monkeypatch):
    windows.update({WSL_BASH, GIT_PF, GIT_LAD})
    assert plat.find_bash() == GIT_PF
    windows.discard(GIT_PF)
    assert plat.find_bash() == GIT_LAD
    apps = r"C:\Users\me\AppData\Local\Microsoft\WindowsApps"
    windows.add(apps + r"\bash.exe")
    monkeypatch.setenv("PATH", apps)
    assert plat.find_bash() == GIT_LAD
    windows.discard(GIT_LAD)
    scoop = r"C:\Users\me\scoop\apps\git\current\bin\bash.exe"
    windows.add(scoop)
    assert plat.find_bash() == scoop


def test_find_bash_wsl_first_git_later_on_path(windows, monkeypatch):
    """System32 (WSL launcher) precedes the user PATH; a Git bash further down (Scoop shim, portable) must win."""
    shim = r"C:\Users\me\scoop\shims\bash.exe"
    windows.update({WSL_BASH, shim})
    monkeypatch.setenv("PATH", r'C:\Windows\System32;;"C:\Users\me\scoop\shims";C:\Windows')
    assert plat.find_bash() == shim


def test_find_bash_prefers_non_wsl_bash_on_path(windows, monkeypatch):
    other = r"D:\tools\Git\usr\bin\bash.exe"
    windows.update({GIT_PF, other})
    monkeypatch.setenv("PATH", r"D:\tools\Git\usr\bin")
    assert plat.find_bash() == other


def test_find_bash_eu_bash_override(windows, monkeypatch):
    custom = r"E:\msys64\usr\bin\bash.exe"
    windows.update({GIT_PF, custom})
    monkeypatch.setenv("EU_BASH", f'"{custom}"')
    assert plat.find_bash() == custom
    monkeypatch.setenv("EU_BASH", r"E:\missing\bash.exe")  # a stale override falls back to the usual search
    assert plat.find_bash() == GIT_PF


def test_find_bash_none_on_windows_without_git(windows, monkeypatch):
    windows.add(WSL_BASH)
    assert plat.find_bash() is None


@pytest.mark.parametrize("path, wsl", [(WSL_BASH, True), (r"c:/windows/system32/BASH.EXE", True),
                                       (r"C:\Windows\Sysnative\bash.exe", True),
                                       (r"C:\Users\me\AppData\Local\Microsoft\WindowsApps\bash.exe", True),
                                       (GIT_PF, False), ("/usr/bin/bash", False)])
def test_wsl_launcher_detection(path, wsl):
    assert plat._is_wsl_launcher(path) is wsl


# ---- jobs --------------------------------------------------------------------------------------------
def test_job_fails_cleanly_without_bash(tmp_path, monkeypatch):
    monkeypatch.setattr(jobs, "find_bash", lambda: None)
    monkeypatch.setattr(subprocess, "Popen", lambda *a, **k: pytest.fail("must not spawn"))
    job = JobManager(tmp_path).start("t", "echo hi")
    assert job.done and job.status == FAILED and job.exit_code == -1
    text = "\n".join(job.output_since(0)["lines"])
    assert "Git for Windows" in text and "WSL" in text
    assert plat.BASH_MISSING in job.log_path.read_text(encoding="utf-8")


def test_job_popen_args_on_windows(tmp_path, monkeypatch):
    seen = {}

    def fake_popen(argv, **kw):
        seen.update(argv=argv, **kw)
        raise OSError("simulated")

    monkeypatch.setattr(plat, "IS_WINDOWS", True)
    monkeypatch.setattr(jobs, "find_bash", lambda: GIT_PF)
    monkeypatch.setattr(subprocess, "Popen", fake_popen)
    job = JobManager(tmp_path).start("t", "echo hi")
    assert seen["argv"] == [GIT_PF, "-c", "echo hi"]
    assert seen["creationflags"] == plat.CREATE_NEW_PROCESS_GROUP | plat.CREATE_NO_WINDOW == 0x08000200
    assert "start_new_session" not in seen
    assert job.status == FAILED and "failed to start: simulated" in job.output_since(0)["lines"][0]


def test_job_cancel_goes_through_kill_process_tree(tmp_path, monkeypatch):
    calls = []
    real = jobs.kill_process_tree
    monkeypatch.setattr(jobs, "kill_process_tree", lambda proc, force=False: calls.append(force) or real(proc, force))
    jm = JobManager(tmp_path)
    job = jm.start("t", "sleep 30")
    jm.cancel(job.id, grace=5)
    for _ in range(100):
        if job.done:
            break
        time.sleep(0.05)
    assert job.status == CANCELLED and calls[0] is False


def test_job_python_children_write_utf8(tmp_path, monkeypatch):
    """Windows pipes default to the ANSI code page (strict); simulated with PYTHONIOENCODING=cp1252 in our env."""
    monkeypatch.setenv("PYTHONIOENCODING", "cp1252")
    script = f"{sys.executable} -c \"print('caf\\u00e9 \\u65e5\\u672c \\U0001f680')\""
    jm = JobManager(tmp_path)
    for env, want in ((None, "café 日本 🚀"), ({"PYTHONIOENCODING": "ascii:backslashreplace"}, "caf\\xe9")):
        job = jm.start("t", script, env=env)  # a caller's own env still wins
        for _ in range(200):
            if job.done:
                break
            time.sleep(0.05)
        assert job.exit_code == 0 and want in job.output_since(0)["lines"][0]


def test_clipper_cli_reconfigures_non_utf8_stdout(monkeypatch):
    import io
    from app.services.clipper import cli
    raw = io.BytesIO()
    out = io.TextIOWrapper(raw, encoding="cp1252", errors="strict", write_through=True)
    monkeypatch.setattr(sys, "stdout", out)
    monkeypatch.setattr(cli.audit, "record", lambda *a, **k: None)
    monkeypatch.setattr(cli.signal, "signal", lambda *a: None)  # keep pytest's own SIGTERM handling
    result = {"title": "日本語 — 🚀 café", "counts": {"found": 0, "saved": 0, "failed": 0, "deduped": 0},
              "mode": "static", "words": 1}
    monkeypatch.setattr(cli, "clip", lambda *a, **k: result)
    assert cli.main(["--url", "https://example.com/", "--out", "/tmp/x"]) == 0
    assert "日本語 — 🚀 café" in raw.getvalue().decode("utf-8")


# ---- kill_process_tree / popen kwargs ----------------------------------------------------------------
def test_kill_process_tree_windows_uses_taskkill(monkeypatch):
    runs = []

    def fake_run(argv, **kw):
        runs.append((argv, kw))
        return subprocess.CompletedProcess(argv, 0 if len(runs) < 3 else 128)

    monkeypatch.setattr(plat, "IS_WINDOWS", True)
    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(os, "killpg", lambda *a: pytest.fail("no killpg on Windows"), raising=False)

    class P:
        pid = 4242

        def send_signal(self, sig):
            pytest.fail("CTRL_BREAK_EVENT could reach our own console")

    assert plat.kill_process_tree(P(), force=False) is True
    assert plat.kill_process_tree(P(), force=True) is True
    assert plat.kill_process_tree(P(), force=True) is False  # 128: no such process
    assert all(a == ["taskkill", "/PID", "4242", "/T", "/F"] for a, _ in runs)
    assert runs[0][1]["creationflags"] == plat.CREATE_NO_WINDOW


def test_kill_process_tree_windows_without_taskkill(monkeypatch):
    monkeypatch.setattr(plat, "IS_WINDOWS", True)

    def missing(*a, **k):
        raise FileNotFoundError("taskkill")

    monkeypatch.setattr(subprocess, "run", missing)
    assert plat.kill_process_tree(type("P", (), {"pid": 1})(), force=True) is False


def test_kill_process_tree_posix_kills_the_group():
    proc = subprocess.Popen(["bash", "-c", "sleep 30 & wait"], **plat.popen_group_kwargs())
    assert plat.popen_group_kwargs() == {"start_new_session": True}
    assert plat.kill_process_tree(proc) is True
    assert proc.wait(timeout=5) == -signal.SIGTERM
    assert plat.kill_process_tree(proc, force=True) is False  # the group is gone


def test_no_window_kwargs(monkeypatch):
    assert plat.no_window_kwargs() == {}
    monkeypatch.setattr(plat, "IS_WINDOWS", True)
    assert plat.no_window_kwargs() == {"creationflags": plat.CREATE_NO_WINDOW}


# ---- permissions -------------------------------------------------------------------------------------
def test_chmod_helpers_noop_on_windows(tmp_path, monkeypatch):
    f = tmp_path / "secret"
    f.write_text("x")
    f.chmod(0o644)
    monkeypatch.setattr(plat, "IS_WINDOWS", True)
    monkeypatch.setattr(os, "chmod", lambda *a: pytest.fail("os.chmod on Windows"))
    monkeypatch.setattr(os, "fchmod", lambda *a: pytest.fail("os.fchmod on Windows"), raising=False)
    plat.chmod_private(f, 0o600)
    fd = os.open(f, os.O_RDONLY)
    try:
        plat.fchmod_private(fd, 0o600)
    finally:
        os.close(fd)
    assert stat.S_IMODE(f.stat().st_mode) == 0o644


def test_chmod_helpers_enforce_on_posix(tmp_path):
    f, d = tmp_path / "secret", tmp_path / "dir"
    f.write_text("x")
    d.mkdir()
    plat.chmod_private(d, 0o700)
    fd = os.open(f, os.O_RDONLY)
    try:
        plat.fchmod_private(fd, 0o600)
    finally:
        os.close(fd)
    assert stat.S_IMODE(f.stat().st_mode) == 0o600 and stat.S_IMODE(d.stat().st_mode) == 0o700


def test_jupyter_key_check_uses_acl_on_windows(tmp_path, monkeypatch):
    key = tmp_path / "id"
    key.write_text("k")
    key.chmod(0o644)
    assert not jchecks.key_check(str(key))["ok"]  # Linux: ssh refuses group/other-readable keys
    monkeypatch.setattr(plat, "IS_WINDOWS", True)
    monkeypatch.setenv("USERNAME", "me")
    monkeypatch.setenv("USERDOMAIN", "PC")
    calls = []

    def fake_icacls(acl, rc=0):
        def run(argv, **kw):
            calls.append(argv)
            return subprocess.CompletedProcess(argv, rc, acl, "")
        monkeypatch.setattr(subprocess, "run", run)

    fake_icacls(f"{key} NT AUTHORITY\\SYSTEM:(F)\n         PC\\me:(R)\n")
    r = jchecks.key_check(str(key))  # mode bits mean nothing there; no broad group seen -> info, never a plain "ok"
    assert r["ok"] and r["level"] == "info" and "icacls" in r["hint"] and calls[-1] == ["icacls", str(key)]
    fake_icacls(f"{key} BUILTIN\\Users:(I)(RX)\n         NT AUTHORITY\\Authenticated Users:(I)(M)\n")
    r = jchecks.key_check(str(key))
    assert not r["ok"] and r["level"] == "err" and "builtin\\users" in r["detail"] and "/inheritance:r" in r["hint"]
    fake_icacls("", rc=5)  # icacls failed: unknown, still a hint
    assert jchecks.key_check(str(key))["level"] == "info"
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(FileNotFoundError("icacls")))
    assert jchecks.key_check(str(key))["level"] == "info"
    fake_icacls("processed 1 files")
    assert jchecks.fix_key_perms(str(key)) == str(key)
    assert calls[-1] == ["icacls", str(key), "/inheritance:r", "/grant:r", "PC\\me:R"]
    fake_icacls("Access is denied.", rc=5)
    with pytest.raises(PermissionError):
        jchecks.fix_key_perms(str(key))
    assert stat.S_IMODE(key.stat().st_mode) == 0o644  # no chmod on Windows


# ---- VPN adapters ------------------------------------------------------------------------------------
@pytest.mark.parametrize("name, desc, vpn_like", [
    ("Ethernet", "Intel(R) Ethernet Connection", False),
    ("Wi-Fi", "Intel(R) Wi-Fi 6 AX201", False),
    ("Ethernet 2", "TAP-Windows Adapter V9", True),
    ("OpenVPN Wintun", "Wintun Userspace Tunnel", True),
    ("corp", "WireGuard Tunnel", True),
    ("Local Area Connection", "Fortinet SSL VPN Virtual Ethernet Adapter", True),
    ("Ethernet 3", "Cisco AnyConnect Secure Mobility Client Virtual Miniport Adapter", True),
    ("Ethernet 4", "PANGP Virtual Ethernet Adapter", True),
    ("GlobalProtect", "", True),
    ("Zscaler", "", True),
])
def test_vpn_adapter_matching(name, desc, vpn_like):
    assert plat.is_vpn_adapter(name, desc) is vpn_like


def _fake_powershell(monkeypatch, payload, rc=0):
    def fake_run(argv, **kw):
        assert argv[0] == "powershell" and "Get-NetAdapter" in argv[-1]
        return subprocess.CompletedProcess(argv, rc, json.dumps(payload), "")
    monkeypatch.setattr(subprocess, "run", fake_run)


def test_windows_adapters_from_powershell(monkeypatch):
    monkeypatch.setattr(plat, "IS_WINDOWS", True)
    _fake_powershell(monkeypatch, [{"Name": "Wi-Fi", "InterfaceDescription": "Intel", "Status": "Up"},
                                   {"Name": "Ethernet 2", "InterfaceDescription": "TAP-Windows Adapter V9",
                                    "Status": "Disconnected"}])
    assert vpn.interfaces() == [{"name": "Ethernet 2", "state": "disconnected"}]  # the UI shows the state
    assert jchecks.vpn_interfaces() == []  # an installed but disconnected TAP adapter is not a VPN
    _fake_powershell(monkeypatch, {"Name": "wg-corp", "InterfaceDescription": "WireGuard Tunnel", "Status": "Up"})
    assert vpn.interfaces() == [{"name": "wg-corp", "state": "up"}]  # a single adapter is not wrapped in a list


def test_windows_adapters_fall_back_to_if_nameindex(monkeypatch):
    monkeypatch.setattr(plat, "IS_WINDOWS", True)

    def missing(*a, **k):
        raise FileNotFoundError("powershell")

    monkeypatch.setattr(subprocess, "run", missing)
    monkeypatch.setattr(plat.socket, "if_nameindex", lambda: [(1, "ethernet_32769"), (7, "OpenVPN-TAP")])
    assert [a["name"] for a in plat.windows_vpn_adapters()] == ["OpenVPN-TAP"]
    monkeypatch.setattr(plat.socket, "if_nameindex", lambda: (_ for _ in ()).throw(OSError("nope")))
    assert vpn.interfaces() == [] and jchecks.vpn_interfaces() == []


# ---- screen time -------------------------------------------------------------------------------------
@pytest.fixture()
def home(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(wb, "_state", {"gnome_ok_at": 0.0})
    return wb.validate(dict(wb.DEFAULTS))[0]


def test_wellbeing_uses_windows_idle_source(home, monkeypatch):
    monkeypatch.setattr(plat, "IS_WINDOWS", True)
    monkeypatch.setattr(wb, "gnome_idle", lambda: pytest.fail("gdbus on Windows"))
    monkeypatch.setattr(wb, "windows_idle", lambda: (1_000, False))
    t = time.time()
    assert wb.sample(now=t, values=home) == {"source": "windows", "active": True}
    assert wb.current_source(t + 1) == "windows"
    assert wb.heartbeat(t + 1) == {"accepted": False, "source": "windows"}
    monkeypatch.setattr(wb, "windows_idle", lambda: (1_000, True))  # locked: not screen time
    assert wb.sample(now=t + 60, values=home)["active"] is False
    monkeypatch.setattr(wb, "windows_idle", lambda: (None, None))
    later = t + 60 + wb.GNOME_FRESH_SECONDS + 5
    assert wb.sample(now=later, values=home) == {"source": "browser", "active": None}
    assert wb.heartbeat(later)["accepted"] is True


def test_windows_idle_reads_last_input_info(monkeypatch):
    class User32:
        desk = 0
        switch = 1

        def GetLastInputInfo(self, ref):
            ref._obj.dwTime = 0xFFFFF000  # tick count wrapped since the last input
            return 1

        def OpenInputDesktop(self, *a):
            return self.desk

        def SwitchDesktop(self, h):
            return self.switch

        def CloseDesktop(self, h):
            return 1

    class Kernel32:
        def GetTickCount64(self):
            return (1 << 32) + 0x1000

    user32 = User32()
    monkeypatch.setattr(wb, "_win32", lambda: (user32, Kernel32()))
    assert wb.windows_idle() == (0x2000, None)  # no input desktop: lock state unknown
    user32.desk = 7
    assert wb.windows_idle() == (0x2000, False)
    user32.switch = 0
    assert wb.windows_idle() == (0x2000, True)


def test_windows_idle_unavailable_off_windows():
    if sys.platform != "win32":
        assert wb.windows_idle() == (None, None)


# ---- paths in generated scripts ----------------------------------------------------------------------
def test_bash_path(monkeypatch):
    assert plat.bash_path(r"C:\x\y") == r"C:\x\y"  # POSIX: untouched (backslash is a legal file name char)
    monkeypatch.setattr(plat, "IS_WINDOWS", True)
    assert plat.bash_path(r"C:\Users\me\data\out.csv") == "C:/Users/me/data/out.csv"


def test_scripts_use_forward_slashes_on_windows(monkeypatch):
    monkeypatch.setattr(plat, "IS_WINDOWS", True)
    script, _ = postgres.export_csv_script(PureWindowsPath(r"C:\d\q.sql"), PureWindowsPath(r"C:\d\out\r.csv"))
    assert "-f C:/d/q.sql -o C:/d/out/r.csv.partial" in script and "mkdir -p C:/d/out" in script
    assert "\\" not in script
    assert ip_commands._activate(r"C:\envs\svc") == "source C:/envs/svc/Scripts/activate"
    s = {"repo_dir": r"C:\repo", "python": r"C:\venv\Scripts\python.exe", "sync_script": "s.py"}
    assert asmnt_commands.python_arg(s) == "C:/venv/Scripts/python.exe"
    assert asmnt_commands.sync(s, ["a"], False).script.startswith("cd C:/repo && exec C:/venv/Scripts/python.exe s.py")


def test_scripts_unchanged_on_posix():
    assert ip_commands._activate("/opt/v") == "source /opt/v/bin/activate"
    assert asmnt_commands.python_arg({"python": "python3"}) == "python3"


def test_find_chrome_on_windows(windows, monkeypatch):
    monkeypatch.setattr(os, "access", lambda p, mode: True)
    edge = ntpath.join(PF86, "Microsoft", "Edge", "Application", "msedge.exe")
    windows.add(edge)
    assert fetcher.find_chrome() == edge
    chrome = LAD + r"\Google\Chrome\Application\chrome.exe"
    windows.add(chrome)
    assert fetcher.find_chrome() == chrome


def test_gitsafety_without_git(tmp_path, monkeypatch):
    def missing(*a, **k):
        raise FileNotFoundError("git")

    monkeypatch.setattr(subprocess, "run", missing)
    assert gitsafety.git_tracked(tmp_path, "x") is False
    assert gitsafety.git_ignored(tmp_path, "x") is False  # unknown = not safe
