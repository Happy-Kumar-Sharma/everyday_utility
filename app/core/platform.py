"""OS differences in one place: bash lookup, owner-only permissions, process groups and killing them.

Linux / macOS behaviour is unchanged (bash from PATH, chmod 600/700, own session + killpg). On Windows:

* bash scripts run with Git for Windows' bash (never the WSL launcher, which would run them Linux-side);
* chmod is skipped: os.chmod there only toggles the read-only flag and cannot express "owner only". Files under
  the user profile (where the app and its data normally live) are already restricted to that user by its ACLs;
* a job is its own process group without a console window and is stopped with ``taskkill /T /F``. There is no
  graceful step: CTRL_BREAK_EVENT only reaches processes sharing our console (CREATE_NO_WINDOW children don't),
  and for a group that isn't on our console Windows may deliver it to every process on it, the server included.

Everything is read at call time (IS_WINDOWS, os.environ) so tests can simulate Windows on Linux.
"""

from __future__ import annotations

import json
import ntpath
import os
import shutil
import signal
import socket
import subprocess

IS_WINDOWS = os.name == "nt"

BASH_MISSING = ("This feature runs a bash script. On Windows install Git for Windows "
                "(https://git-scm.com/download/win) or run the app inside WSL.")

# subprocess only defines these on Windows; the values are the documented Win32 flags
CREATE_NEW_PROCESS_GROUP = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
O_BINARY = getattr(os, "O_BINARY", 0)  # os.open on Windows is text mode (\n -> \r\n) without it

# where Git for Windows puts bash.exe: (env var holding the base folder, path below it)
_GIT_BASH = (("ProgramFiles", ("Git", "bin", "bash.exe")),
             ("ProgramFiles(x86)", ("Git", "bin", "bash.exe")),
             ("LocalAppData", ("Programs", "Git", "bin", "bash.exe")),
             ("USERPROFILE", ("scoop", "apps", "git", "current", "bin", "bash.exe")))


def _is_wsl_launcher(path: str) -> bool:
    """C:\\Windows\\System32\\bash.exe and the WindowsApps alias start WSL: scripts would run Linux-side."""
    p = str(path).replace("/", "\\").lower()
    return p.endswith(("\\system32\\bash.exe", "\\sysnative\\bash.exe")) or "\\windowsapps\\" in p


def find_bash() -> str | None:
    """bash to run job scripts with, or None. POSIX: bash on PATH. Windows: EU_BASH, then the first non-WSL bash on
    PATH (every PATH folder is checked: System32's WSL launcher usually comes first and must not hide a Git bash
    further down), then the usual Git for Windows install folders (incl. Scoop)."""
    if not IS_WINDOWS:
        return shutil.which("bash")
    override = os.environ.get("EU_BASH", "").strip().strip('"')
    if override and os.path.isfile(override):
        return override
    for folder in os.environ.get("PATH", "").split(";"):  # Windows PATH separator (also when simulated in tests)
        folder = folder.strip().strip('"')
        found = folder and shutil.which("bash", path=folder)
        if found and not _is_wsl_launcher(found):
            return found
    for var, parts in _GIT_BASH:
        base = os.environ.get(var)
        if base:
            cand = ntpath.join(base, *parts)
            if os.path.isfile(cand):
                return cand
    return None


def bash_path(path) -> str:
    """A local path as bash should see it: C:\\x\\y -> C:/x/y on Windows (Git bash and native tools accept it)."""
    s = str(path)
    return s.replace("\\", "/") if IS_WINDOWS else s


def chmod_private(path, mode: int) -> None:
    """os.chmod on POSIX; nothing on Windows (see the module docstring)."""
    if not IS_WINDOWS:
        os.chmod(path, mode)


def fchmod_private(fd: int, mode: int) -> None:
    """os.fchmod on POSIX; nothing on Windows (os.fchmod is missing before 3.13 and only sets read-only after)."""
    if not IS_WINDOWS and hasattr(os, "fchmod"):
        os.fchmod(fd, mode)


def popen_group_kwargs() -> dict:
    """Popen kwargs that put the child in its own process group, so the whole tree can be stopped."""
    if IS_WINDOWS:
        return {"creationflags": CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW}
    return {"start_new_session": True}


def no_window_kwargs() -> dict:
    """subprocess kwargs for a short helper command: no console window flashing up on Windows."""
    return {"creationflags": CREATE_NO_WINDOW} if IS_WINDOWS else {}


def kill_process_tree(proc: subprocess.Popen, force: bool = False) -> bool:
    """Stop a child started with popen_group_kwargs() and everything it spawned. Returns False when it is gone.

    POSIX: SIGTERM (or SIGKILL when force) to its session's process group.
    Windows: always ``taskkill /PID <pid> /T /F`` (see the module docstring for why there is no graceful step)."""
    if not IS_WINDOWS:
        try:
            os.killpg(proc.pid, signal.SIGKILL if force else signal.SIGTERM)
            return True
        except (ProcessLookupError, PermissionError):
            return False
    try:
        r = subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], stdin=subprocess.DEVNULL,
                           capture_output=True, timeout=15, **no_window_kwargs())
    except (OSError, subprocess.SubprocessError):
        return False
    return r.returncode == 0


# ---- network adapters (Windows has no /sys/class/net) ----------------------------------------------
VPN_WORDS = ("tap", "wintun", "wireguard", "openvpn", "vpn", "fortinet", "cisco anyconnect", "globalprotect",
             "pangp", "zscaler")
_ADAPTERS_PS = "Get-NetAdapter | Select-Object Name,InterfaceDescription,Status | ConvertTo-Json -Compress"


def is_vpn_adapter(*texts: str) -> bool:
    """True when an adapter's name or description looks like a VPN driver (TAP, Wintun, WireGuard, …)."""
    return any(w in (t or "").lower() for t in texts for w in VPN_WORDS)


def windows_adapters(timeout: float = 5.0) -> list[dict]:
    """[{name, description, state}] from PowerShell's Get-NetAdapter (friendly names such as "OpenVPN TAP-Windows6").
    Falls back to socket.if_nameindex(), whose Windows names are generic ("ethernet_32777") but better than nothing."""
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", _ADAPTERS_PS],
                           stdin=subprocess.DEVNULL, capture_output=True, text=True, errors="replace", timeout=timeout,
                           **no_window_kwargs())
        data = json.loads(r.stdout or "[]") if r.returncode == 0 else None
        if isinstance(data, dict):  # ConvertTo-Json unwraps a single adapter
            data = [data]
        if isinstance(data, list):
            return [{"name": str(d.get("Name") or ""), "description": str(d.get("InterfaceDescription") or ""),
                     "state": str(d.get("Status") or "").lower()} for d in data if isinstance(d, dict)]
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    try:
        return [{"name": n, "description": "", "state": ""} for _i, n in socket.if_nameindex()]
    except (OSError, AttributeError):
        return []


def windows_vpn_adapters() -> list[dict]:
    return sorted((a for a in windows_adapters() if is_vpn_adapter(a["name"], a["description"])),
                  key=lambda a: a["name"])
