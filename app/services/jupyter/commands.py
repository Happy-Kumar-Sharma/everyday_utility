"""ssh / remote shell commands for a profile (pure builders, no I/O).

Quoting happens twice and on purpose:
* the REMOTE script (cd, conda bootstrap, jupyter) quotes every profile value with shlex.quote, so the
  remote shell sees them as plain words;
* the whole remote script is ONE ssh argument, and every ssh argument is shlex.quote'd again in the local
  bash script the job runs.
"""

from __future__ import annotations

import shlex
from dataclasses import dataclass
from pathlib import Path

from .profiles import parse_extra_args

SSH = "ssh"  # resolved via PATH (tests put a stub first on PATH)
CONDA_DIRS = ("$HOME/miniconda3", "$HOME/anaconda3", "$HOME/miniforge3", "$HOME/mambaforge",
              "/opt/conda", "/opt/miniconda3", "/opt/anaconda3")
BASE_OPTS = ("-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
             "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
             "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=10")


@dataclass
class Command:
    title: str
    argv: list[str]  # ssh argv (argv[0] == "ssh")
    script: str  # what the job runs (bash)
    display: str  # what the UI shows / copies (no secrets: the token is never part of a command)


def key_path(profile: dict) -> str:
    return str(Path(profile["key_path"]).expanduser())


def _q(argv: list[str]) -> str:
    return " ".join(shlex.quote(a) for a in argv)


_KEY_MARK = "__EU_KEY_PATH__"


def qpath(path: str) -> str:
    """Shell-quote a path but keep a leading ~/ expandable (as the user typed it)."""
    if path.startswith("~/"):
        return "~/" + shlex.quote(path[2:])
    return shlex.quote(path)


def _display(argv_marked: list[str], profile: dict) -> str:
    return _q(argv_marked).replace(_KEY_MARK, qpath(profile["key_path"]))


def conda_bootstrap() -> str:
    """Make `conda activate` work in a non-interactive ssh shell (~/.bashrc usually returns early there).

    * conda missing from PATH: source etc/profile.d/conda.sh of the first usual install that has it;
    * conda on PATH as a plain executable (not the shell function): source conda.sh of its base install.
    POSIX sh only, so it also works when the remote login shell is not bash."""
    dirs = " ".join(f'"{d}"' for d in CONDA_DIRS)
    return (
        "if ! command -v conda >/dev/null 2>&1; then "
        f"for d in {dirs}; do "
        'if [ -f "$d/etc/profile.d/conda.sh" ]; then . "$d/etc/profile.d/conda.sh"; break; fi; '
        "done; fi; "
        'case "$(command -v conda 2>/dev/null)" in /*) '
        '_cb="$(conda info --base 2>/dev/null)"; '
        'if [ -n "$_cb" ] && [ -f "$_cb/etc/profile.d/conda.sh" ]; then . "$_cb/etc/profile.d/conda.sh"; fi;; '
        "esac"
    )


def _login_shell(profile: dict, script: str) -> str:
    """Run `script` the way a manual `ssh` session would: bash as a login + interactive shell, so ~/.profile
    (e.g. ~/.local/bin on PATH) and ~/.bashrc (conda init) apply. Off -> plain non-interactive shell."""
    if not profile.get("login_shell", True):
        return script
    return f"exec bash -lic {shlex.quote(script)}"


def _jupyter(args: str) -> str:
    # `jupyter` may not be on PATH even when the package is installed in the env: fall back to python -m
    return (f"if command -v jupyter >/dev/null 2>&1; then exec jupyter {args}; "
            f"else exec python -m jupyter {args}; fi")


def remote_script(profile: dict) -> str:
    ip = "127.0.0.1" if profile["mode"] == "tunnel" else "0.0.0.0"
    steps = [ln for ln in (profile.get("startup_steps") or "").splitlines() if ln.strip()]
    return _login_shell(profile, "\n".join([
        f"cd {shlex.quote(profile['remote_dir'])} || exit 1",
        conda_bootstrap(),
        f"conda activate {shlex.quote(profile['conda_env'])} || exit 1",
        *steps,  # the user's own commands, deliberately not quoted (they run on the user's own server)
        # port_retries=0: fail fast instead of silently moving to another port (would break the tunnel)
        _jupyter(f"lab --no-browser --ip {ip} --port {int(profile['remote_port'])} --ServerApp.port_retries=0"),
    ]))


def list_servers_script(profile: dict) -> str:
    return _login_shell(profile, "\n".join([
        conda_bootstrap(),
        f"conda activate {shlex.quote(profile['conda_env'])} || exit 1",
        "{ jupyter server list --json || python -m jupyter server list --json; } 2>/dev/null"
        " || jupyter server list || python -m jupyter server list",
    ]))


def _base(profile: dict, *, tty: bool, key: str) -> list[str]:
    argv = [SSH]
    if tty:
        argv.append("-tt")  # force a tty: the remote jupyter gets SIGHUP when we disconnect
    argv += ["-i", key, *BASE_OPTS]
    return argv


def _forward(profile: dict, remote_port: int) -> list[str]:
    return ["-L", f"127.0.0.1:{int(profile['local_port'])}:127.0.0.1:{int(remote_port)}"]


def _dest(profile: dict) -> str:
    return f"{profile['user']}@{profile['host']}"


def _wrap(argv: list[str]) -> str:
    # exec: ssh replaces bash, so the job's process group is just ssh
    return f"exec {_q(argv)}\n"


def start(profile: dict) -> Command:
    extra = parse_extra_args(profile.get("extra_ssh_args", ""))

    def build(key: str) -> list[str]:
        argv = _base(profile, tty=True, key=key)
        if profile["mode"] == "tunnel":
            argv += _forward(profile, profile["remote_port"])
        return argv + extra + [_dest(profile), remote_script(profile)]

    argv = build(key_path(profile))
    return Command(f"Jupyter · {profile['name']}", argv, _wrap(argv), _display(build(_KEY_MARK), profile))


def tunnel_only(profile: dict, remote_port: int) -> Command:
    """Forward to an already running remote server (no remote command)."""
    extra = parse_extra_args(profile.get("extra_ssh_args", ""))

    def build(key: str) -> list[str]:
        return _base(profile, tty=False, key=key) + ["-N", *_forward(profile, remote_port), *extra, _dest(profile)]

    argv = build(key_path(profile))
    return Command(f"Jupyter tunnel · {profile['name']}", argv, _wrap(argv), _display(build(_KEY_MARK), profile))


def list_servers(profile: dict) -> list[str]:
    """argv for the 'find running servers' subprocess (no tty, BatchMode)."""
    extra = parse_extra_args(profile.get("extra_ssh_args", ""))
    return _base(profile, tty=False, key=key_path(profile)) + extra + [_dest(profile), list_servers_script(profile)]


def plain(profile: dict) -> dict:
    """Copyable commands for doing it by hand."""
    key = qpath(profile["key_path"])
    extra = " ".join(shlex.quote(a) for a in parse_extra_args(profile.get("extra_ssh_args", "")))
    extra = f" {extra}" if extra else ""
    dest = _dest(profile)
    ip = "127.0.0.1" if profile["mode"] == "tunnel" else "0.0.0.0"
    lp, rp = int(profile["local_port"]), int(profile["remote_port"])
    login = f"ssh -i {key}{extra} {dest}"
    steps = [
        login,
        f"cd {shlex.quote(profile['remote_dir'])}",
        f"conda activate {shlex.quote(profile['conda_env'])}",
        f"jupyter lab --no-browser --ip {ip} --port {rp}",
    ]
    out = {
        "ssh_login": login,
        "manual_steps": "\n".join(steps),
        "start": start(profile).display,
    }
    if profile["mode"] == "tunnel":
        out["tunnel"] = f"ssh -i {key} -N -L 127.0.0.1:{lp}:127.0.0.1:{rp}{extra} {dest}"
        out["open"] = f"http://127.0.0.1:{lp}/lab?token=<token from the jupyter output>"
    else:
        out["open"] = f"http://{profile['host']}:{rp}/lab?token=<token from the jupyter output>"
    return out
