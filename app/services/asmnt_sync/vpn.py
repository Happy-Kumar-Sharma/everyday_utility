"""VPN hints: VPN-looking network interfaces, and optional TCP probes of a host only reachable on a VPN."""

from __future__ import annotations

import re
import socket
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from app.core import platform as plat

PREFIXES = ("tun", "tap", "wg", "ppp", "utun")
PROBE_TIMEOUT = 3.0
_HOST_RE = re.compile(r"^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$")
SYS_NET = Path("/sys/class/net")


def _is_vpn(name: str) -> bool:
    n = name.lower()
    return n.startswith(PREFIXES) or "vpn" in n


def interfaces() -> list[dict]:
    if plat.IS_WINDOWS:
        return [{"name": a["name"], "state": a["state"]} for a in plat.windows_vpn_adapters()]
    names: list[str] = []
    try:
        names = sorted(p.name for p in SYS_NET.iterdir())
    except OSError:
        try:
            names = sorted(n for _, n in socket.if_nameindex())
        except OSError:
            names = []
    out = []
    for name in names:
        if not _is_vpn(name):
            continue
        state = ""
        try:
            state = (SYS_NET / name / "operstate").read_text().strip()
        except OSError:
            pass
        out.append({"name": name, "state": state})
    return out


def parse_target(value: str) -> tuple[str, int]:
    """'host:port' or '[v6]:port' -> (host, port); ValueError when malformed."""
    value = (value or "").strip()
    m = re.match(r"^\[([0-9A-Fa-f:.]{2,45})\]:(\d{1,5})$", value)
    if m:
        host, port = m.group(1), int(m.group(2))
    else:
        host, sep, port_s = value.rpartition(":")
        if not sep or not port_s.isdigit() or not _HOST_RE.match(host):
            raise ValueError("expected host:port")
        port = int(port_s)
    if not 1 <= port <= 65535:
        raise ValueError("port out of range")
    return host, port


def probe(value: str, timeout: float = PROBE_TIMEOUT) -> dict:
    if not (value or "").strip():
        return {"configured": False, "ok": None, "detail": "not configured"}
    try:
        host, port = parse_target(value)
    except ValueError as e:
        return {"configured": True, "ok": False, "detail": f"invalid probe '{value}': {e}"}
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return {"configured": True, "ok": True, "detail": f"{host}:{port} reachable"}
    except socket.timeout:
        return {"configured": True, "ok": False, "detail": f"{host}:{port}: timed out after {timeout:g}s"}
    except OSError as e:
        return {"configured": True, "ok": False, "detail": f"{host}:{port}: {e.strerror or e}"}


def probe_many(values: dict[str, str]) -> dict[str, dict]:
    """Run probes in parallel so a status check takes at most one timeout."""
    with ThreadPoolExecutor(max_workers=max(1, len(values))) as ex:
        futures = {k: ex.submit(probe, v) for k, v in values.items()}
        return {k: f.result() for k, f in futures.items()}
