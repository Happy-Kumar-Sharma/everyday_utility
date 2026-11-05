"""Remote Jupyter: profiles, pre-flight checks, start / stop / reuse sessions (ssh jobs) and their URLs.

The Jupyter token is a credential: it is parsed from the job output on demand and only returned by the
endpoints that need it (sessions, remote-servers). It never goes into profiles.json, job meta or the audit log.
"""

from __future__ import annotations

import socket
import subprocess
import threading

from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel, Field

from app.core import audit, context
from app.core.jobs import CANCELLED, FAILED, JobConflict

from . import checks, commands, parse, profiles
from .profiles import ProfileError

SERVICE_ID = "jupyter"
STEP = "jupyter"
LIST_TIMEOUT = 20

router = APIRouter()

# in memory only: job id -> parsed URL info. Started sessions cache what was parsed from their output (the
# in-memory log is bounded); reuse tunnels get the token of the server they forward to from the client.
_urls: dict[str, dict] = {}
_urls_lock = threading.Lock()


def _profile(profile_id: str) -> dict:
    p = profiles.get(profile_id)
    if p is None:
        raise HTTPException(404, "profile not found")
    return p


def _audit(action: str, p: dict, **detail) -> None:
    audit.record(SERVICE_ID, action, p.get("name", ""), detail={"profile": p.get("id"), "host": p.get("host"),
                                                                  "mode": p.get("mode"), **detail})


# ---- profiles -------------------------------------------------------------------------------------
@router.get("/profiles")
def list_profiles():
    return profiles.load()


@router.post("/profiles")
def create_profile(data: dict = Body(...)):
    try:
        p, warnings = profiles.create(data)
    except ProfileError as e:
        raise HTTPException(400, str(e)) from e
    _audit("profile-create", p)
    return {"profile": p, "warnings": warnings}


@router.put("/profiles/{profile_id}")
def update_profile(profile_id: str, data: dict = Body(...)):
    try:
        p, warnings = profiles.update(profile_id, data)
    except ProfileError as e:
        raise HTTPException(400, str(e)) from e
    except KeyError as e:
        raise HTTPException(404, "profile not found") from e
    _audit("profile-update", p)
    return {"profile": p, "warnings": warnings}


@router.delete("/profiles/{profile_id}")
def delete_profile(profile_id: str):
    try:
        p = profiles.delete(profile_id)
    except KeyError as e:
        raise HTTPException(404, "profile not found") from e
    _audit("profile-delete", p)
    return {"ok": True}


@router.get("/profiles/{profile_id}/commands")
def profile_commands(profile_id: str):
    try:
        return commands.plain(_profile(profile_id))
    except ProfileError as e:
        raise HTTPException(400, str(e)) from e


# ---- pre-flight -----------------------------------------------------------------------------------
def _running_job(profile_id: str):
    return next((j for j in context.jobs.list()
                 if j.lock_key == f"{SERVICE_ID}:{profile_id}" and not j.done), None)


@router.get("/profiles/{profile_id}/check")
def check(profile_id: str):
    p = _profile(profile_id)
    running = _running_job(profile_id)
    in_use = bool(running and running.meta.get("mode") == "tunnel" and running.meta.get("local_port") == p["local_port"])
    return checks.run(p, port_in_use_by_session=in_use)


@router.post("/profiles/{profile_id}/fix-key-perms")
def fix_key_perms(profile_id: str):
    p = _profile(profile_id)
    try:
        path = checks.fix_key_perms(p["key_path"])
    except FileNotFoundError as e:
        raise HTTPException(404, f"key file not found: {e}") from e
    except OSError as e:
        raise HTTPException(400, f"chmod failed: {e}") from e
    _audit("fix-key-perms", p, path=path)
    return checks.key_check(p["key_path"])


# ---- sessions -------------------------------------------------------------------------------------
def _start_job(cmd: commands.Command, p: dict, **meta) -> "object":
    try:
        return context.jobs.start(
            cmd.title, cmd.script, display=cmd.display, lock_key=f"{SERVICE_ID}:{p['id']}",
            meta={"step": STEP, "profile": p["id"], "name": p["name"], "mode": p["mode"],
                  "local_port": p["local_port"], "remote_port": p["remote_port"], "host": p["host"], **meta})
    except JobConflict as e:
        raise HTTPException(409, str(e)) from e


@router.post("/profiles/{profile_id}/start")
def start(profile_id: str):
    p = _profile(profile_id)
    try:
        cmd = commands.start(p)
    except ProfileError as e:
        raise HTTPException(400, str(e)) from e
    job = _start_job(cmd, p)
    return session(job)


class ReuseRequest(BaseModel):
    port: int = Field(..., ge=1, le=65535)
    token: str = Field("", max_length=200, pattern=r"^[A-Za-z0-9_-]*$")
    base_url: str = Field("/", max_length=200, pattern=r"^/[A-Za-z0-9_./~-]*$")
    scheme: str = Field("http", pattern=r"^https?$")


@router.post("/profiles/{profile_id}/reuse")
def reuse(profile_id: str, req: ReuseRequest):
    """Use a server that is already running: direct mode -> its URL; tunnel mode -> a tunnel-only job."""
    p = _profile(profile_id)
    path = req.base_url.rstrip("/") + "/lab"
    if p["mode"] == "direct":
        return {"url": parse.build_url(req.scheme, p["host"], req.port, path, req.token)}
    try:
        cmd = commands.tunnel_only(p, req.port)
    except ProfileError as e:
        raise HTTPException(400, str(e)) from e
    job = _start_job(cmd, p, reuse=True, remote_port=req.port)
    with _urls_lock:
        _urls[job.id] = {"scheme": req.scheme, "port": req.port, "path": path, "token": req.token}
    return session(job)


def _local_port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.3):
            return True
    except OSError:
        return False


def _url_info(job) -> tuple[dict | None, str]:
    """(parsed URL info, output text). The text is only used for error translation."""
    out = job.output_since(0)
    text = "\n".join(out["lines"]) + ("\n" + out["partial"] if out["partial"] else "")
    with _urls_lock:
        info = _urls.get(job.id)
        if info is None and not job.meta.get("reuse"):
            info = parse.find_url(text)
            if info:
                _urls[job.id] = info
    return info, text


def session(job) -> dict:
    m = job.meta
    info, text = _url_info(job)
    reuse_job = bool(m.get("reuse"))
    url = None
    if info:
        if m.get("mode") == "tunnel":
            url = parse.build_url(info["scheme"], "127.0.0.1", int(m["local_port"]), info["path"], info["token"])
        else:
            url = parse.build_url(info["scheme"], m["host"], int(info.get("port") or m["remote_port"]),
                                  info["path"], info["token"])
    if not job.done:
        ready = bool(info) and (not reuse_job or _local_port_open(int(m["local_port"])))
        state = "ready" if ready else "connecting"
    else:
        state = "stopped" if job.status == CANCELLED or (job.status != FAILED and info) else "failed"
    err = None
    if state in ("connecting", "failed"):
        err = parse.translate_error(text)
        if err is None and state == "failed":
            last = next((ln.strip() for ln in reversed(text.splitlines()) if ln.strip()), "")
            err = {"error": last[:300] or f"ssh exited with code {job.exit_code}", "hint": ""}
    return {
        "job_id": job.id, "profile_id": m.get("profile"), "name": m.get("name"), "status": job.status,
        "state": state, "url": url if state == "ready" else None,
        "mode": m.get("mode"), "host": m.get("host"), "local_port": m.get("local_port"),
        "remote_port": m.get("remote_port"), "reuse": reuse_job, "started_at": job.started_at,
        "duration": job.to_dict()["duration"], "exit_code": job.exit_code, "display": job.display,
        "title": job.title, "error": err["error"] if err else None, "hint": err["hint"] if err else None,
    }


def _jupyter_job(job_id: str):
    job = context.jobs.get(job_id)
    if job is None or job.meta.get("step") != STEP:
        raise HTTPException(404, "session not found")
    return job


@router.get("/sessions")
def sessions():
    jobs = [j for j in context.jobs.list() if j.meta.get("step") == STEP]
    with _urls_lock:  # forget URLs of jobs the job manager has pruned
        for job_id in set(_urls) - {j.id for j in jobs}:
            _urls.pop(job_id, None)
    return [session(j) for j in jobs]


@router.get("/sessions/{job_id}")
def get_session(job_id: str):
    return session(_jupyter_job(job_id))


@router.post("/sessions/{job_id}/stop")
def stop(job_id: str):
    job = _jupyter_job(job_id)
    context.jobs.cancel(job_id)  # SIGTERM to the ssh process group; with -tt the remote jupyter gets SIGHUP
    return session(job)


# ---- find running servers -------------------------------------------------------------------------
@router.post("/profiles/{profile_id}/remote-servers")
def remote_servers(profile_id: str):
    p = _profile(profile_id)
    try:
        argv = commands.list_servers(p)
    except ProfileError as e:
        raise HTTPException(400, str(e)) from e
    try:
        r = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=LIST_TIMEOUT,
                           start_new_session=True)
    except FileNotFoundError as e:
        raise HTTPException(500, "ssh not found on PATH") from e
    except subprocess.TimeoutExpired as e:
        raise HTTPException(504, f"no answer within {LIST_TIMEOUT} s — {parse.VPN_HINT}") from e
    servers = parse.parse_server_list(r.stdout)
    _audit("list-servers", p, found=len(servers), exit_code=r.returncode)
    if not servers and r.returncode != 0:
        err = parse.translate_error(r.stderr + "\n" + r.stdout)
        last = next((ln for ln in reversed((r.stderr or r.stdout).splitlines()) if ln.strip()), "")
        msg = f"{err['error']} — {err['hint']}" if err else (last.strip()[:300] or f"ssh exited with code {r.returncode}")
        raise HTTPException(502, msg)
    return {"servers": servers}


# ---- global search --------------------------------------------------------------------------------
def search(q: str) -> list[dict]:
    from app.services.planner.search import rank

    q = q.strip().lower()
    if not q:
        return []
    hits = []
    for p in profiles.load():
        r = rank(q, p["name"], p["host"], p["user"], p.get("notes", ""), p.get("conda_env", ""))
        if r is not None:
            hits.append((r, {"title": p["name"], "subtitle": f"{p['user']}@{p['host']} · {p['mode']}",
                             "icon": "🪐", "ref": p["id"]}))
    return [h for _r, h in sorted(hits, key=lambda x: x[0])][:20]


