"""Pre-flight checks before connecting: key file, VPN / reachability, local port, ssh binary."""

from __future__ import annotations

import os
import shlex
import shutil
import socket
import stat
import subprocess
from pathlib import Path

from app.core import platform as plat

from .profiles import ssh_port

VPN_PREFIXES = ("tun", "tap", "wg", "ppp", "utun")


def _check(name: str, ok: bool, detail: str = "", hint: str = "", *, level: str | None = None, **extra) -> dict:
    return {"name": name, "ok": ok, "detail": detail, "hint": hint, "level": level or ("ok" if ok else "err"), **extra}


def key_check(path: str) -> dict:
    p = Path(path).expanduser()
    if not p.exists():
        return _check("Key file", False, f"{p} not found", "Pick the .pem / private key file with Browse…")
    if not p.is_file():
        return _check("Key file", False, f"{p} is not a file", "Pick the private key file itself.")
    mode = stat.S_IMODE(p.stat().st_mode)
    if plat.IS_WINDOWS:  # st_mode carries no owner/group/other bits there; Windows OpenSSH checks the ACL instead
        return _windows_key_check(p)
    if mode & 0o077:
        return _check("Key file", False, f"{p} is readable by others (mode {mode:04o}); ssh refuses such keys",
                      f"chmod 600 {shlex.quote(str(p))}", fixable=True)
    if not os.access(p, os.R_OK):
        return _check("Key file", False, f"{p} is not readable by you (mode {mode:04o})", "Check the file owner.")
    return _check("Key file", True, f"{p} (mode {mode:04o})")


def fix_key_perms(path: str) -> str:
    p = Path(path).expanduser()
    if not p.is_file():
        raise FileNotFoundError(str(p))
    if plat.IS_WINDOWS:
        r = subprocess.run(_icacls_fix(p), stdin=subprocess.DEVNULL, capture_output=True, text=True, errors="replace",
                           timeout=15, **plat.no_window_kwargs())
        if r.returncode != 0:
            raise PermissionError((r.stdout + r.stderr).strip() or f"icacls failed ({r.returncode})")
        return str(p)
    plat.chmod_private(p, 0o600)
    return str(p)


# well-known groups whose access makes Windows OpenSSH refuse a key ("UNPROTECTED PRIVATE KEY FILE"); icacls prints
# localized names, so no match only means "not detected", never "safe"
_BROAD_GROUPS = ("everyone:", "builtin\\users:", "authenticated users:")


def _icacls_fix(p: Path) -> list[str]:
    user = os.environ.get("USERNAME", "")
    domain = os.environ.get("USERDOMAIN", "")
    who = f"{domain}\\{user}" if domain and user else user or "%USERNAME%"
    return ["icacls", str(p), "/inheritance:r", "/grant:r", f"{who}:R"]


def _windows_key_check(p: Path) -> dict:
    if not os.access(p, os.R_OK):
        return _check("Key file", False, f"{p} is not readable by you", "Check the file owner.")
    fix = subprocess.list2cmdline(_icacls_fix(p))
    try:
        r = subprocess.run(["icacls", str(p)], stdin=subprocess.DEVNULL, capture_output=True, text=True,
                           errors="replace", timeout=10, **plat.no_window_kwargs())
        acl = r.stdout.lower() if r.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        acl = ""
    broad = [g.rstrip(":") for g in _BROAD_GROUPS if g in acl]
    if broad:
        return _check("Key file", False, f"{p} is accessible to {', '.join(broad)}; Windows OpenSSH refuses such keys",
                      f"Run: {fix}  (or keep the key under %USERPROFILE%\\.ssh)")
    return _check("Key file", True, f"{p} (Windows OpenSSH checks the file's ACL when connecting)",
                  f"If ssh reports an UNPROTECTED PRIVATE KEY FILE, run: {fix}", level="info")


def vpn_interfaces() -> list[str]:
    if plat.IS_WINDOWS:
        # TAP / Wintun adapters stay installed while disconnected: only "up" ones (state "" = unknown, keep it)
        return [a["name"] for a in plat.windows_vpn_adapters() if a["state"] in ("up", "")]
    names: set[str] = set()
    try:
        names.update(os.listdir("/sys/class/net"))
    except OSError:
        pass
    try:
        names.update(n for _i, n in socket.if_nameindex())
    except (OSError, AttributeError):
        pass
    return sorted(n for n in names if n.lower().startswith(VPN_PREFIXES) or "vpn" in n.lower())


def tcp_reachable(host: str, port: int, timeout: float = 3.0) -> tuple[bool, str]:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True, f"{host}:{port} accepts connections"
    except socket.gaierror as e:
        return False, f"cannot resolve {host}: {e.strerror or e}"
    except TimeoutError:
        return False, f"{host}:{port} timed out after {timeout:g} s"
    except OSError as e:
        return False, f"{host}:{port}: {e.strerror or e}"


def port_free(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind((host, port))
        except OSError:
            return False
    return True


def next_free_port(start: int, tries: int = 50) -> int | None:
    for p in range(start + 1, min(start + 1 + tries, 65536)):
        if port_free(p):
            return p
    return None


def run(profile: dict, *, port_in_use_by_session: bool = False) -> list[dict]:
    out = [key_check(profile["key_path"])]

    port = ssh_port(profile.get("extra_ssh_args", ""))
    ok, detail = tcp_reachable(profile["host"], port)
    out.append(_check("VPN / server reachable", ok, detail,
                      "" if ok else "Connect to the VPN first (prod is only reachable over the VPN), then re-check."))
    ifaces = vpn_interfaces()
    out.append(_check("VPN interface", True,
                      f"found: {', '.join(ifaces)}" if ifaces else "no tun/tap/wg/ppp/vpn interface seen (some VPNs use other names)",
                      level="info"))

    if profile["mode"] == "tunnel":
        lp = int(profile["local_port"])
        if port_in_use_by_session:
            out.append(_check("Local port", True, f"127.0.0.1:{lp} is used by this profile's running session", level="info"))
        elif port_free(lp):
            out.append(_check("Local port", True, f"127.0.0.1:{lp} is free"))
        else:
            nxt = next_free_port(lp)
            out.append(_check("Local port", False, f"127.0.0.1:{lp} is already in use",
                              f"Stop what uses it or set the local port to {nxt}." if nxt else "Pick another local port.",
                              suggest_port=nxt))

    ssh = shutil.which("ssh")
    out.append(_check("ssh client", bool(ssh), ssh or "ssh not found on PATH",
                      "" if ssh else ("Install the OpenSSH client (Settings → Optional features) or Git for Windows"
                                     if plat.IS_WINDOWS else "Install the OpenSSH client: sudo apt install openssh-client")))
    return out
