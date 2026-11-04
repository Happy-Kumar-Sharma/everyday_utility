"""Shared endpoints: service list, settings, background jobs, file upload/browse/preview."""

from __future__ import annotations

import asyncio
import json
import os
import re
import uuid
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from . import config, context
from .tabular import SUPPORTED_EXTS, TabularError, describe, resolve_file

router = APIRouter(prefix="/api")


# ---- services & settings ------------------------------------------------------------------------
@router.get("/services")
def list_services():
    return [s.to_public() for s in context.services.values()]


@router.get("/services-failed")
def list_failed_services():
    return context.failed_services


@router.get("/search")
def search(q: str = Query("", max_length=200), limit: int = Query(8, ge=1, le=50)):
    """Global search (Ctrl+K): asks every service that has a search provider. A failing provider is skipped."""
    q = q.strip()
    if not q:
        return []
    groups = []
    for service in context.services.values():
        if service.search is None:
            continue
        try:
            results = list(service.search(q))[:limit]
        except Exception as e:  # noqa: BLE001 - one broken provider must not break search
            results = [{"title": f"search failed: {e}", "subtitle": "", "icon": "⚠️", "ref": ""}]
        if results:
            groups.append({"service": service.id, "title": service.title, "icon": service.icon,
                           "results": [{**r, "service": service.id} for r in results]})
    return groups


@router.get("/audit")
def audit_log(limit: int = Query(200, ge=1, le=5000), kind: str | None = None, q: str | None = None):
    from . import audit

    return audit.recent(limit, kind=kind or None, query=q or None)


def _service(service_id: str):
    service = context.services.get(service_id)
    if not service:
        raise HTTPException(404, f"unknown service '{service_id}'")
    return service


@router.get("/services/{service_id}/settings")
def get_settings(service_id: str):
    return context.settings.load(_service(service_id))


def _audit_settings(action: str, service_id: str, before: dict, after: dict) -> None:
    from . import audit

    # keys only: values may be private paths
    changed = sorted(k for k in after if before.get(k) != after[k])
    audit.record("settings", action, service_id, detail={"changed": changed})


@router.put("/services/{service_id}/settings")
def save_settings(service_id: str, values: dict):
    service = _service(service_id)
    before = context.settings.load(service)
    try:
        after = context.settings.save(service, values)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    _audit_settings("save", service_id, before, after)
    return after


@router.delete("/services/{service_id}/settings")
def reset_settings(service_id: str):
    service = _service(service_id)
    before = context.settings.load(service)
    after = context.settings.reset(service)
    _audit_settings("reset", service_id, before, after)
    return after


# ---- jobs -----------------------------------------------------------------------------------------
def _job(job_id: str):
    job = context.jobs.get(job_id)
    if not job:
        raise HTTPException(404, f"unknown job '{job_id}'")
    return job


@router.get("/jobs")
def list_jobs():
    return [j.to_dict() for j in context.jobs.list()]


@router.get("/jobs/{job_id}")
def get_job(job_id: str, since: int = 0):
    job = _job(job_id)
    return {**job.to_dict(), "output": job.output_since(since)}


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    _job(job_id)
    return context.jobs.cancel(job_id).to_dict()


@router.get("/jobs/{job_id}/log")
def download_log(job_id: str):
    job = _job(job_id)
    return FileResponse(job.log_path, media_type="text/plain", filename=job.log_path.name)


@router.get("/jobs/{job_id}/stream")
async def stream_job(job_id: str, request: Request, since: int = 0):
    """Server-sent events: `output` events with new lines, then one `done` event with the final job state."""
    job = _job(job_id)

    async def events():
        idx, last_partial = since, None
        while True:
            if await request.is_disconnected():
                return
            finished = job.done  # read before output, so nothing written after it is missed
            out = job.output_since(idx)
            if out["lines"] or out["partial"] != last_partial:
                idx = out["start"] + len(out["lines"])
                last_partial = out["partial"]
                yield f"event: output\ndata: {json.dumps(out)}\n\n"
            if finished:
                yield f"event: done\ndata: {json.dumps(job.to_dict())}\n\n"
                return
            await asyncio.sleep(0.3)

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


# ---- files ----------------------------------------------------------------------------------------
_SAFE_NAME = re.compile(r"[^A-Za-z0-9._ -]+")


@router.post("/files/upload")
async def upload(file: UploadFile = File(...)):
    name = _SAFE_NAME.sub("_", Path(file.filename or "upload").name) or "upload"
    if Path(name).suffix.lower() not in SUPPORTED_EXTS:
        raise HTTPException(400, f"Unsupported file type. Use one of: {', '.join(sorted(SUPPORTED_EXTS))}")
    dest = config.UPLOADS_DIR / uuid.uuid4().hex[:12] / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    with dest.open("wb") as f:
        while chunk := await file.read(1 << 20):
            f.write(chunk)
    return {"path": str(dest), "name": name}


@router.get("/files/inspect")
def inspect(path: str, sheet: str | None = None, rows: int = Query(10, ge=0, le=500)):
    try:
        return describe(resolve_file(path), sheet or None, preview_rows=rows)
    except TabularError as e:
        raise HTTPException(400, str(e)) from e


@router.get("/files/download")
def download(path: str):
    p = Path(path).expanduser()
    if not p.is_file():
        raise HTTPException(404, f"File not found: {p}")
    return FileResponse(p, filename=p.name)


@router.get("/fs/list")
def list_dir(path: str = "", only_tabular: bool = True, show_hidden: bool = False):
    """Directory listing for the in-app file browser (hidden entries skipped unless show_hidden)."""
    p = Path(path).expanduser() if path else Path.home()
    if p.is_file():
        p = p.parent
    if not p.is_dir():
        raise HTTPException(404, f"Folder not found: {p}")
    dirs, files = [], []
    try:
        entries = list(os.scandir(p))
    except PermissionError as e:
        raise HTTPException(403, str(e)) from e
    for e in entries:
        if e.name.startswith(".") and not (show_hidden and e.is_file()):
            continue
        try:
            if e.is_dir():
                dirs.append({"name": e.name, "path": e.path})
            elif not only_tabular or Path(e.name).suffix.lower() in SUPPORTED_EXTS:
                st = e.stat()
                files.append({"name": e.name, "path": e.path, "size": st.st_size, "mtime": st.st_mtime})
        except OSError:
            continue
    dirs.sort(key=lambda d: d["name"].lower())
    files.sort(key=lambda f: f["mtime"], reverse=True)  # newest first: usually the file you just downloaded
    return {"path": str(p), "parent": str(p.parent) if p.parent != p else None, "dirs": dirs, "files": files}
