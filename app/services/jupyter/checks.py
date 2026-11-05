"""Pre-flight checks before connecting: key file, VPN / reachability, local port, ssh binary."""

from __future__ import annotations

import os
import shlex
import shutil
import socket
import stat
from pathlib import Path

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
    os.chmod(p, 0o600)
    return str(p)


def vpn_interfaces() -> list[str]:
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
                      "" if ssh else "Install the OpenSSH client: sudo apt install openssh-client"))
    return out
