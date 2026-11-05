"""Reading Jupyter / ssh output: the server URL, known failures (with hints) and `jupyter server list`."""

from __future__ import annotations

import json
import re
from urllib.parse import parse_qs, urlsplit

# http(s)://host[:port]/[base/](lab|tree|)?token=...  — also "(hostname or 127.0.0.1)" and token-less URLs
URL_RE = re.compile(
    r"(https?)://(\[[0-9A-Fa-f:]+\]|\([^)\s]*(?:\s[^)\s]*)*\)|[A-Za-z0-9._-]+)(?::(\d{1,5}))?"
    r"(/[^\s?#]*)?(?:\?token=([A-Za-z0-9_-]+))?")
_RUNNING_AT = re.compile(r"(Jupyter Server|Jupyter Notebook|Jupyter).*is running at", re.I)


def find_url(text: str) -> dict | None:
    """First Jupyter URL in the output -> {scheme, port, path, token}. Token may be "" (auth disabled)."""
    lines = text.splitlines()
    after_running_at = False
    for line in lines:
        if _RUNNING_AT.search(line):
            after_running_at = True
        for m in URL_RE.finditer(line):
            scheme, _host, port, path, token = m.groups()
            path = path or "/"
            leaf = path.rstrip("/").rsplit("/", 1)[-1]
            if leaf in ("lab", "tree") or token or (after_running_at and path == "/"):
                if leaf not in ("lab", "tree"):
                    path = path.rstrip("/") + "/lab"
                return {"scheme": scheme, "port": int(port) if port else None, "path": path, "token": token or ""}
    return None


def build_url(scheme: str, host: str, port: int, path: str, token: str) -> str:
    host = f"[{host}]" if ":" in host and not host.startswith("[") else host
    return f"{scheme}://{host}:{port}{path}" + (f"?token={token}" if token else "")


VPN_HINT = "Can't reach the server — connect to the VPN first (and check the host / IP)."
# (pattern, error, hint) — first match wins; order matters (specific before generic)
ERRORS: list[tuple[re.Pattern, str, str]] = [
    (re.compile(r"Permission denied \(publickey"), "ssh key rejected (Permission denied (publickey))",
     "Check the user name and the key file. BatchMode is on, so a key with a passphrase must be loaded in ssh-agent."),
    (re.compile(r"UNPROTECTED PRIVATE KEY FILE|bad permissions", re.I), "ssh refused the key: permissions too open",
     "Run chmod 600 on the key file (or use “Fix permissions” in the pre-flight checks)."),
    (re.compile(r"Connection timed out|No route to host|Operation timed out|Network is unreachable", re.I),
     "Connection timed out / no route to host", VPN_HINT),
    (re.compile(r"Connection refused", re.I), "Connection refused on the ssh port",
     "The host is reachable but nothing accepts ssh there — check the host / port."),
    (re.compile(r"Could not resolve hostname", re.I), "Could not resolve hostname",
     "Typo in the host, or the name only resolves on the VPN — connect to the VPN or use the IP."),
    (re.compile(r"Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED", re.I),
     "Host key verification failed", "The server's host key changed. Check with the server owner, then remove the old entry with ssh-keygen -R <host>."),
    (re.compile(r"Address already in use|local port forwarding failed|cannot listen to port", re.I),
     "Local port already in use", "Another program (maybe an old tunnel) uses the local port — stop it or pick another local port."),
    (re.compile(r"remote port forwarding failed", re.I), "Remote port forwarding failed",
     "Pick another port in the profile."),
    (re.compile(r"conda: (command )?not found", re.I), "conda not found on the server",
     "conda isn't on PATH for non-interactive shells and wasn't found in the usual install folders."),
    (re.compile(r"EnvironmentNameNotFound|Could not find conda environment|environment does not exist", re.I),
     "conda environment not found", "Check the environment name (on the server: conda env list)."),
    (re.compile(r"jupyter: (command )?not found|No such file or directory: 'jupyter'", re.I),
     "jupyter not found in the conda environment", "Install it in that env: conda install -c conda-forge jupyterlab."),
    (re.compile(r"port \d+ is already in use|already in use, trying another", re.I),
     "Jupyter port already in use on the server",
     "A Jupyter server is probably already running there — use “Find running servers” and Reuse it, or change the remote port."),
    (re.compile(r"cd: .*(No such file or directory|can't cd)", re.I), "Remote folder not found",
     "Check the remote folder (is the EFS / disk mounted?)."),
]


def translate_error(text: str) -> dict | None:
    for pattern, error, hint in ERRORS:
        if pattern.search(text):
            return {"error": error, "hint": hint}
    return None


def parse_server_list(text: str) -> list[dict]:
    """`jupyter server list --json` (one JSON object per line) or the plain text list
    ("http://host:8888/?token=abc :: /root/dir") -> [{url, token, port, root_dir, pid}]."""
    out: list[dict] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("{"):
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if not isinstance(d, dict):
                continue
            url = str(d.get("url") or "")
            port = d.get("port") or urlsplit(url).port
            out.append({"url": url, "token": str(d.get("token") or ""), "port": int(port) if port else None,
                        "root_dir": str(d.get("root_dir") or d.get("notebook_dir") or ""),
                        "pid": d.get("pid"), "base_url": str(d.get("base_url") or "/")})
            continue
        m = re.match(r"^(https?://\S+)\s*::\s*(.*)$", line)
        if m:
            url, root = m.groups()
            parts = urlsplit(url)
            token = (parse_qs(parts.query).get("token") or [""])[0]
            out.append({"url": url.split("?")[0], "token": token, "port": parts.port, "root_dir": root.strip(),
                        "pid": None, "base_url": parts.path or "/"})
    return out
