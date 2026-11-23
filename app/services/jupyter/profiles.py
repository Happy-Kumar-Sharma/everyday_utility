"""Remote Jupyter server profiles: validation + an owner-only JSON store in data/jupyter/profiles.json.

Profiles are app data (data/ is git-ignored), never code. They hold paths and host names only; Jupyter
tokens are never written here.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import tempfile
import threading
import uuid
from pathlib import Path

from app.core import config
from app.core.platform import chmod_private, fchmod_private

MODES = ("tunnel", "direct")
HOST_RE = re.compile(r"^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$")
IPV6_RE = re.compile(r"^[0-9A-Fa-f:.]{2,45}$")
USER_RE = re.compile(r"^[a-z_][a-z0-9_.-]*$")
# ssh options that take a value (from ssh(1)); everything else in extra_ssh_args must be a flag
_ARG_FLAGS = set("BbcDEeFIiJLlmOoPpQRSWw")
# options that make ssh run a local command (or read a config that could)
_FORBIDDEN_FLAGS = {"F"}

FIELDS = ("name", "host", "user", "key_path", "remote_dir", "conda_env", "mode", "remote_port", "local_port",
          "extra_ssh_args", "notes", "login_shell", "startup_steps")
_lock = threading.Lock()


class ProfileError(ValueError):
    pass


def _path() -> Path:
    # read at call time so tests (EU_DATA_DIR) redirect it
    return config.DATA_DIR / "jupyter" / "profiles.json"


def _check_option(opt: str) -> None:
    """One -o value: refuse Match blocks and every *Command option (ProxyCommand, LocalCommand,
    PermitLocalCommand, KnownHostsCommand, ...)."""
    key = re.split(r"[=\s]+", opt.strip(), maxsplit=1)[0].lower()
    if key == "match" or "command" in opt.lower():
        raise ProfileError(f"extra ssh args: '-o {opt}' is not allowed (options that run local commands are refused)")


def parse_extra_args(value: str) -> list[str]:
    """shlex-split extra ssh arguments and refuse anything that could run a local command or change the
    destination (a bare word would become the host)."""
    try:
        args = shlex.split(value or "")
    except ValueError as e:
        raise ProfileError(f"extra ssh args: {e}") from e
    i = 0
    while i < len(args):
        tok = args[i]
        if "command" in tok.lower():
            raise ProfileError(f"extra ssh args: '{tok}' is not allowed (options that run local commands are refused)")
        if not tok.startswith("-") or len(tok) < 2 or tok.startswith("--"):
            raise ProfileError(f"extra ssh args: unexpected '{tok}' (only options like -p 2222 or -o Key=Value)")
        flag = tok[1]
        if flag in _FORBIDDEN_FLAGS:
            raise ProfileError(f"extra ssh args: -{flag} is not allowed")
        if flag in _ARG_FLAGS and len(tok) == 2:
            if i + 1 >= len(args):
                raise ProfileError(f"extra ssh args: {tok} needs a value")
            val = args[i + 1]
            if flag == "o":
                _check_option(val)
            elif "command" in val.lower():
                raise ProfileError(f"extra ssh args: '{tok} {val}' is not allowed")
            i += 2
        else:
            if flag == "o":
                _check_option(tok[2:])
            i += 1
    return args


def ssh_port(extra_args: str) -> int:
    """The ssh port the profile connects to (-p N or -o Port=N in extra args), default 22."""
    try:
        args = parse_extra_args(extra_args)
    except ProfileError:
        return 22
    port = 22
    for i, tok in enumerate(args):
        val = None
        if tok == "-p" and i + 1 < len(args):
            val = args[i + 1]
        elif tok.startswith("-p") and len(tok) > 2:
            val = tok[2:]
        elif tok in ("-o",) and i + 1 < len(args) and args[i + 1].lower().startswith("port"):
            val = re.split(r"[=\s]+", args[i + 1], maxsplit=1)[-1]
        elif tok.lower().startswith("-oport"):
            val = re.split(r"[=\s]+", tok[2:], maxsplit=1)[-1]
        if val and val.strip().isdigit():
            port = int(val.strip())
    return port


def _port(value, label: str) -> int:
    if isinstance(value, bool):
        raise ProfileError(f"{label} must be a number")
    try:
        n = int(str(value).strip())
    except (TypeError, ValueError) as e:
        raise ProfileError(f"{label} must be a number") from e
    if not 1 <= n <= 65535:
        raise ProfileError(f"{label} must be 1-65535")
    return n


def validate(data: dict) -> tuple[dict, list[str]]:
    """Normalised profile (without id) + non-fatal warnings. Raises ProfileError on invalid input."""
    if not isinstance(data, dict):
        raise ProfileError("profile must be an object")
    out: dict = {}
    s = lambda k: str(data.get(k) if data.get(k) is not None else "").strip()  # noqa: E731
    out["name"] = s("name")
    if not out["name"] or len(out["name"]) > 80:
        raise ProfileError("name is required (max 80 characters)")
    host = s("host")
    if not (HOST_RE.match(host) or (":" in host and IPV6_RE.match(host))):
        raise ProfileError("host must be a hostname or IP address (no spaces or shell characters)")
    out["host"] = host
    user = s("user")
    if not USER_RE.match(user) or len(user) > 32:
        raise ProfileError("user must match ^[a-z_][a-z0-9_.-]*$")
    out["user"] = user
    out["key_path"] = s("key_path")
    if not out["key_path"]:
        raise ProfileError("key file is required")
    if "\n" in out["key_path"] or "\0" in out["key_path"]:
        raise ProfileError("key file path is invalid")
    for k, label in (("remote_dir", "remote folder"), ("conda_env", "conda environment")):
        out[k] = s(k)
        if not out[k] or "\n" in out[k] or "\0" in out[k]:
            raise ProfileError(f"{label} is required (single line)")
    mode = s("mode") or "tunnel"
    if mode not in MODES:
        raise ProfileError("mode must be 'tunnel' or 'direct'")
    out["mode"] = mode
    out["remote_port"] = _port(data.get("remote_port") if data.get("remote_port") not in (None, "") else 8888, "remote port")
    out["local_port"] = _port(data.get("local_port") if data.get("local_port") not in (None, "") else 8888, "local port")
    out["extra_ssh_args"] = s("extra_ssh_args")
    parse_extra_args(out["extra_ssh_args"])
    out["notes"] = str(data.get("notes") or "")[:4000]
    # run like an interactive ssh session (bash -lic): same PATH / conda init as typing the commands by hand
    out["login_shell"] = data.get("login_shell", True) not in (False, "false", "0", 0)
    # the user's own extra lines, run on the server after `conda activate` and before Jupyter starts
    steps = str(data.get("startup_steps") or "").replace("\r\n", "\n")
    if "\0" in steps or len(steps) > 4000:
        raise ProfileError("startup steps are invalid (max 4000 characters)")
    out["startup_steps"] = steps.strip("\n")
    warnings = []
    key = Path(out["key_path"]).expanduser()
    if not key.exists():
        warnings.append(f"key file not found: {key}")
    return out, warnings


# ---- store ----------------------------------------------------------------------------------------
def load() -> list[dict]:
    p = _path()
    if not p.is_file():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [d for d in data if isinstance(d, dict) and d.get("id")] if isinstance(data, list) else []


def _save(profiles: list[dict]) -> None:
    p = _path()
    p.parent.mkdir(parents=True, exist_ok=True)
    try:
        chmod_private(p.parent, 0o700)
    except OSError:
        pass
    fd, tmp = tempfile.mkstemp(prefix=".profiles-", suffix=".json", dir=p.parent)
    f = None
    try:
        fchmod_private(fd, 0o600)
        f = os.fdopen(fd, "w", encoding="utf-8")
        json.dump(profiles, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
        f.close()
        os.replace(tmp, p)
        try:
            chmod_private(p, 0o600)
        except OSError:
            pass
    except BaseException:
        if f is not None and not f.closed:
            f.close()
        else:
            try:
                os.close(fd)
            except OSError:
                pass
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def get(profile_id: str) -> dict | None:
    return next((p for p in load() if p["id"] == profile_id), None)


def create(data: dict) -> tuple[dict, list[str]]:
    clean, warnings = validate(data)
    with _lock:
        profiles = load()
        profile = {"id": uuid.uuid4().hex[:10], **clean}
        profiles.append(profile)
        _save(profiles)
    return profile, warnings


def update(profile_id: str, data: dict) -> tuple[dict, list[str]]:
    clean, warnings = validate(data)
    with _lock:
        profiles = load()
        for i, p in enumerate(profiles):
            if p["id"] == profile_id:
                profiles[i] = {"id": profile_id, **clean}
                _save(profiles)
                return profiles[i], warnings
    raise KeyError(profile_id)


def delete(profile_id: str) -> dict:
    with _lock:
        profiles = load()
        keep = [p for p in profiles if p["id"] != profile_id]
        if len(keep) == len(profiles):
            raise KeyError(profile_id)
        _save(keep)
    return next(p for p in profiles if p["id"] == profile_id)
