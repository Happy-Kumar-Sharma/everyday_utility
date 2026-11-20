"""Prod → Staging assessment sync: step 1 (sync_ids on the PROD VPN) and step 2 (staging lookup on the
STAGING VPN) as background jobs, with their results merged into persisted runs.

Only ids, json ids, staging ids, OTPs and statuses are stored (data/asmnt_sync/runs.json). Nothing from the
sync repo's .env is ever read here; the scripts read it themselves.
"""

from __future__ import annotations

import copy
import csv
import io
import re
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

from app.core import audit, context
from app.core.jobs import RUNNING, JobConflict

from . import commands, parse, vpn
from .ids import MAX_IDS, parse_ids
from .store import RunStore, data_dir, new_item, new_run

SERVICE_ID = "asmnt-sync"
LOCK_SYNC = f"{SERVICE_ID}:step1"
LOCK_LOOKUP = f"{SERVICE_ID}:step2"
RUN_ID_RE = re.compile(r"^[0-9A-Za-z-]{1,64}$")

router = APIRouter()
store = RunStore()


# ---- helpers --------------------------------------------------------------------------------------
def _settings() -> dict:
    return context.service_settings(SERVICE_ID)


def _ready(s: dict, script_key: str) -> None:
    repo = commands.repo_dir(s)
    if not repo.is_dir():
        raise HTTPException(400, f"sync repo folder not found: {repo} — set it in ⚙ Settings")
    if not (repo / s[script_key]).is_file():
        raise HTTPException(400, f"script not found: {repo / s[script_key]} — check ⚙ Settings")
    if not commands.python_info(s)["found"]:
        raise HTTPException(400, f"Python interpreter not found: {s['python']} — check ⚙ Settings")


def _run_or_404(run_id: str) -> dict:
    if not RUN_ID_RE.match(run_id):
        raise HTTPException(404, "run not found")
    run = store.get(run_id)
    if run is None:
        raise HTTPException(404, "run not found")
    return run


def _recovered_status(job_id: str) -> str:
    """The final status of a job no longer in memory, from the jobs audit 'finish' event ('lost' if none)."""
    for e in audit.recent(20, kind="job", query=job_id):
        if e.get("action") == "finish" and (e.get("detail") or {}).get("job") == job_id and e.get("status"):
            return str(e["status"])
    return "lost"


def _job_output(job_id: str) -> tuple[list[str], bool, str]:
    """(lines, done, status) from the live job, or from its log file after a server restart / prune."""
    job = context.jobs.get(job_id)
    if job is not None:
        # status first: the pump flushes the last output before it flips the status, so output read after
        # seeing "done" is complete (reading output first could finalize the run with a stale snapshot)
        status = job.status
        done = status != RUNNING
        out = job.output_since(0)
        lines = out["lines"] + ([out["partial"]] if out["partial"] else [])
        return lines, done, status
    log_path = context.jobs.log_dir / f"{job_id}.log"
    if log_path.is_file():
        lines = log_path.read_text(encoding="utf-8", errors="replace").split("\n")
        if lines and lines[0].startswith("$ "):
            lines = lines[2:]  # "$ <display>" header + blank line
        return lines, True, _recovered_status(job_id)
    return [], True, _recovered_status(job_id)


def _items_by_json(run: dict) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for item in run["items"]:
        if item.get("json_id"):
            out.setdefault(item["json_id"], []).append(item)
    return out


def _apply_sync(run: dict, lines: list[str], done: bool, status: str) -> str:
    """Merges step-1 output into the items; returns the (possibly recovered) job status."""
    parsed = parse.parse_sync(lines, [i["prod_id"] for i in run["items"] if i["prod_id"]], done=done)
    for item in run["items"]:
        r = parsed["items"].get(item["prod_id"])
        if r:
            item.update(r)
    if done and status == "lost" and parsed["complete"]:
        status = "succeeded"  # recovered from the log and every id has its result line: the script ran to the end
    if done:
        msg = None
        if status != "succeeded" or not parsed["items"]:
            text = parse.last_error_line(parsed["orphan"]) or parse.last_error_line(lines)
            msg = {"status": status, "text": text or ("job lost (server restarted)" if status == "lost" else ""),
                   "hint": parse.hint(text) or parse.hint("\n".join(lines))}
        run["sync_message"] = msg
    return status


def _apply_lookup(run: dict, job_id: str, lines: list[str], done: bool, status: str) -> str:
    """Merges a step-2 result (its CSV) into the items; returns the (possibly recovered) job status.
    An item that was already found before this lookup keeps 'found' when this lookup gives no answer for it."""
    info = run.get("lookups", {}).get(job_id) or {}
    ids = info.get("ids", [])
    prev_found = set(info.get("prev_found", []))
    by_json = _items_by_json(run)

    def keep_found(item: dict) -> bool:
        if item.get("json_id") in prev_found and item.get("staging_id"):
            item.update(lookup_state="found", lookup_error="", lookup_hint="")
            return True
        return False
    if not done:
        for jid in ids:
            for item in by_json.get(jid, []):
                item["active"] = True
        return status
    output = Path(info.get("output", ""))
    if info.get("output") and output.is_file():
        try:
            results = parse.parse_lookup_csv(output)
        except (OSError, csv.Error) as e:
            results, err = {}, f"lookup CSV unreadable: {e}"
        else:
            err = "not in the lookup output"
        for jid in ids:
            for item in by_json.get(jid, []):
                if jid in results:
                    item.update(results[jid])
                elif not keep_found(item):
                    item.update(lookup_state="failed", lookup_error=err, lookup_hint="")
        run["lookup_message"] = None
        if status == "lost":
            status = "succeeded"  # recovered from the log: the script wrote its CSV, so it ran to the end
    else:
        err, h = parse.lookup_failure(lines)
        if status == "lost" and not lines:
            err, h = "job lost (server restarted)", "run the lookup again"
        for jid in ids:
            for item in by_json.get(jid, []):
                if not keep_found(item):
                    item.update(lookup_state="failed", lookup_error=err, lookup_hint=h)
        run["lookup_message"] = {"status": status, "text": err, "hint": h}
    return status


def _audit_finish(run: dict, stage: str, status: str, job_id: str) -> None:
    if stage == "sync":
        items = [i for i in run["items"] if i["prod_id"]]
        detail = {"count": len(items), "succeeded": sum(i["sync_state"] == "synced" for i in items),
                  "not_found": sum(i["sync_state"] == "not_found" for i in items),
                  "failed": sum(i["sync_state"] == "failed" for i in items)}
        env = "prod"
    else:
        ids = set(run.get("lookups", {}).get(job_id, {}).get("ids", []))
        items = [i for i in run["items"] if i.get("json_id") in ids]
        detail = {"count": len(ids), "succeeded": sum(i["lookup_state"] == "found" for i in items),
                  "processing": sum(i["lookup_state"] == "processing" for i in items),
                  "not_found": sum(i["lookup_state"] == "not_found" for i in items)}
        env = "staging"
    audit.record(SERVICE_ID, stage, target=f"run {run['id']}", env=env, status=status, detail=detail)


def _refresh(run: dict) -> bool:
    """Merge the output of this run's unfinished jobs into its items. True when a job got finalized
    (the caller then persists; merging is idempotent so re-parsing a running job is harmless)."""
    finalized = run.setdefault("finalized", [])
    statuses = run.setdefault("job_status", {})
    changed = False
    jid = run.get("sync_job_id")
    if jid and jid not in finalized:
        lines, done, status = _job_output(jid)
        status = _apply_sync(run, lines, done, status)
        if done:
            finalized.append(jid)
            statuses[jid] = status
            _audit_finish(run, "sync", status, jid)
            changed = True
    for jid in run.get("lookup_job_ids", []):
        if jid in finalized:
            continue
        lines, done, status = _job_output(jid)
        status = _apply_lookup(run, jid, lines, done, status)
        if done:
            finalized.append(jid)
            statuses[jid] = status
            _audit_finish(run, "lookup", status, jid)
            changed = True
    return changed


def _job_view(run: dict, job_id: str | None) -> dict | None:
    if not job_id:
        return None
    job = context.jobs.get(job_id)
    if job is not None:
        return job.to_dict()
    return {"id": job_id, "status": run.get("job_status", {}).get(job_id, "lost"), "gone": True}


def _counts(items: list[dict]) -> dict:
    c = {"total": len(items)}
    for key in ("synced", "not_found", "failed", "pending", "skipped"):
        c[f"sync_{key}"] = sum(i["sync_state"] == key for i in items)
    for key in ("found", "processing", "not_found", "failed", "pending"):
        c[f"lookup_{key}"] = sum(i["lookup_state"] == key for i in items)
    c["with_json"] = sum(bool(i.get("json_id")) for i in items)
    return c


def _public(run: dict) -> dict:
    out = copy.deepcopy(run)
    out.pop("finalized", None)
    out["sync_job"] = _job_view(run, run.get("sync_job_id"))
    out["lookup_job"] = _job_view(run, run["lookup_job_ids"][-1] if run.get("lookup_job_ids") else None)
    out["running"] = any(j and j["status"] == RUNNING for j in (out["sync_job"], out["lookup_job"]))
    out["counts"] = _counts(run["items"])
    for item in out["items"]:
        item.setdefault("active", False)
    return out


def _refreshed(run_id: str | None = None) -> list[dict]:
    with store.lock:
        runs = store.load()
        targets = [r for r in runs if run_id is None or r["id"] == run_id]
        if any([_refresh(r) for r in targets]):  # list: refresh every run, not just up to the first change
            store.save(runs)
        return targets


def _start(cmd: commands.Command, lock_key: str, meta: dict):
    try:
        return context.jobs.start(cmd.title, cmd.script, display=cmd.display, env=cmd.env, lock_key=lock_key,
                                  meta={"step": SERVICE_ID, **meta})
    except JobConflict as e:
        raise HTTPException(409, str(e)) from e


def _start_lookup(run: dict, json_ids: list[str], s: dict) -> dict:
    """Starts step 2 for json_ids and records it on `run` (not persisted here)."""
    n = len(run.get("lookup_job_ids", [])) + 1
    out_dir = data_dir()
    out_dir.mkdir(parents=True, exist_ok=True)
    output = out_dir / f"lookup-{run['id']}-{n}.csv"
    output.unlink(missing_ok=True)
    job = _start(commands.lookup(s, json_ids, output), LOCK_LOOKUP,
                 {"run": run["id"], "stage": "lookup", "env": "staging", "output": str(output)})
    wanted = set(json_ids)
    prev_found = sorted({i["json_id"] for i in run["items"]
                         if i.get("json_id") in wanted and i["lookup_state"] == "found" and i.get("staging_id")})
    run.setdefault("lookup_job_ids", []).append(job.id)
    run.setdefault("lookups", {})[job.id] = {"ids": json_ids, "output": str(output), "prev_found": prev_found}
    for item in run["items"]:
        if item.get("json_id") in wanted:
            item.update(lookup_state="pending", lookup_error="", lookup_hint="")
    run["lookup_message"] = None
    return job.to_dict()


# ---- status ---------------------------------------------------------------------------------------
@router.get("/status")
def status():
    """Sync def: runs in the threadpool, so the (up to 3 s) probes never block the event loop."""
    s = _settings()
    repo = commands.repo_dir(s)
    probes = vpn.probe_many({"prod": s["prod_probe"], "staging": s["staging_probe"]})
    return {
        "repo_dir": {"path": str(repo), "exists": repo.is_dir()},
        "scripts": {k: {"name": s[k], "exists": repo.is_dir() and (repo / s[k]).is_file()}
                    for k in ("sync_script", "lookup_script")},
        "python": commands.python_info(s),
        "vpn_interfaces": vpn.interfaces(),
        "prod_probe": probes["prod"],
        "staging_probe": probes["staging"],
    }


@router.get("/probe/{env}")
def probe(env: str):
    if env not in ("prod", "staging"):
        raise HTTPException(404, "unknown env")
    return {**vpn.probe(_settings()[f"{env}_probe"]), "vpn_interfaces": vpn.interfaces()}


class IdsText(BaseModel):
    text: str = Field("", max_length=200_000)
    json_ids: bool = False


@router.post("/ids/check")
def ids_check(req: IdsText):
    return parse_ids(req.text, json_ids=req.json_ids)


def _ids(text: str, *, json_ids: bool) -> list[str]:
    parsed = parse_ids(text, json_ids=json_ids)
    if not parsed["ids"]:
        extra = f" (rejected: {', '.join(parsed['rejected'][:5])})" if parsed["rejected"] else ""
        raise HTTPException(400, f"no valid ids found{extra}")
    if len(parsed["ids"]) > MAX_IDS:
        raise HTTPException(400, f"too many ids ({len(parsed['ids'])}); at most {MAX_IDS} per run")
    return parsed["ids"]


# ---- runs -----------------------------------------------------------------------------------------
class SyncRequest(BaseModel):
    ids: str = Field(..., max_length=200_000)
    reupload: bool = False


class LookupRequest(BaseModel):
    only_missing: bool = True


class LookupOnlyRequest(BaseModel):
    ids: str = Field(..., max_length=200_000)


class RunPatch(BaseModel):
    notes: str = Field("", max_length=5000)


@router.get("/runs")
def list_runs():
    return [_public(r) for r in _refreshed()]


@router.get("/runs/{run_id}")
def get_run(run_id: str):
    _run_or_404(run_id)
    runs = _refreshed(run_id)
    if not runs:
        raise HTTPException(404, "run not found")
    return _public(runs[0])


@router.post("/runs")
def create_run(req: SyncRequest):
    s = _settings()
    ids = _ids(req.ids, json_ids=False)
    _ready(s, "sync_script")
    run = new_run(kind="sync", reupload=req.reupload, items=[new_item(prod_id=i) for i in ids])
    job = _start(commands.sync(s, ids, req.reupload), LOCK_SYNC,
                 {"run": run["id"], "stage": "sync", "env": "prod"})
    run["sync_job_id"] = job.id
    store.add(run)
    audit.record(SERVICE_ID, "sync", target=f"run {run['id']}", env="prod", status="started",
                 detail={"count": len(ids), "reupload": req.reupload})
    return _public(run)


@router.post("/runs/{run_id}/lookup")
def lookup_run(run_id: str, req: LookupRequest):
    _run_or_404(run_id)
    s = _settings()
    _ready(s, "lookup_script")
    with store.lock:
        runs = _refreshed(run_id)
        if not runs:
            raise HTTPException(404, "run not found")
        run = runs[0]
        sync_job = _job_view(run, run.get("sync_job_id"))
        if sync_job and sync_job["status"] == RUNNING:
            raise HTTPException(409, "step 1 is still running for this run")
        json_ids: list[str] = []
        for item in run["items"]:
            jid = item.get("json_id")
            if jid and jid not in json_ids and not (req.only_missing and item["lookup_state"] == "found"):
                json_ids.append(jid)
        if not json_ids:
            raise HTTPException(400, "nothing to look up: no json ids" + (" without a staging id" if req.only_missing else ""))
        job = _start_lookup(run, json_ids, s)
        store.update(run_id, lambda r: r.update(copy.deepcopy(run)))
        audit.record(SERVICE_ID, "lookup", target=f"run {run_id}", env="staging", status="started",
                     detail={"count": len(json_ids)})
        return {**_public(run), "job": job}


@router.post("/lookup")
def lookup_only(req: LookupOnlyRequest):
    s = _settings()
    ids = _ids(req.ids, json_ids=True)
    _ready(s, "lookup_script")
    run = new_run(kind="lookup", items=[new_item(json_id=i, sync_state="skipped") for i in ids])
    with store.lock:
        job = _start_lookup(run, ids, s)
        store.add(run)
    audit.record(SERVICE_ID, "lookup", target=f"run {run['id']}", env="staging", status="started",
                 detail={"count": len(ids)})
    return {**_public(run), "job": job}


@router.patch("/runs/{run_id}")
def patch_run(run_id: str, req: RunPatch):
    _run_or_404(run_id)
    run = store.update(run_id, lambda r: r.update(notes=req.notes))
    if run is None:
        raise HTTPException(404, "run not found")
    return {"id": run_id, "notes": run["notes"]}


@router.delete("/runs/{run_id}")
def delete_run(run_id: str):
    run = _run_or_404(run_id)
    for jid in [run.get("sync_job_id"), *run.get("lookup_job_ids", [])]:
        job = context.jobs.get(jid) if jid else None
        if job is not None and not job.done:
            raise HTTPException(409, "a job of this run is still running — cancel it first")
    store.delete(run_id)
    for info in run.get("lookups", {}).values():
        out = Path(info.get("output", ""))
        if out.parent == data_dir() and out.name.startswith("lookup-"):
            out.unlink(missing_ok=True)
    audit.record(SERVICE_ID, "delete", target=f"run {run_id}", detail={"count": len(run["items"])})
    return {"deleted": run_id}


# ---- export ---------------------------------------------------------------------------------------
EXPORT_COLUMNS = ("prod_id", "json_id", "staging_assessment_id", "otp", "status", "created_date", "states")


def export_rows(run: dict) -> list[list[str]]:
    return [[i["prod_id"], i["json_id"], i["staging_id"], i["otp"], i["status"], i["created_date"],
             f"sync:{i['sync_state']} lookup:{i['lookup_state']}"] for i in run["items"]]


def to_csv(run: dict) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(EXPORT_COLUMNS)
    w.writerows(export_rows(run))
    return buf.getvalue()


def to_markdown(run: dict) -> str:
    def cell(v: str) -> str:
        return (str(v) or " ").replace("\\", "\\\\").replace("|", "\\|").replace("\n", " ")
    lines = ["| " + " | ".join(EXPORT_COLUMNS) + " |", "|" + "---|" * len(EXPORT_COLUMNS)]
    lines += ["| " + " | ".join(cell(v) for v in row) + " |" for row in export_rows(run)]
    return "\n".join(lines) + "\n"


@router.get("/runs/{run_id}/export")
def export_run(run_id: str, format: str = "csv"):
    _run_or_404(run_id)
    runs = _refreshed(run_id)
    if not runs:
        raise HTTPException(404, "run not found")
    if format == "csv":
        body, media, ext = to_csv(runs[0]), "text/csv", "csv"
    elif format == "md":
        body, media, ext = to_markdown(runs[0]), "text/markdown", "md"
    else:
        raise HTTPException(400, "format must be csv or md")
    return PlainTextResponse(body, media_type=media,
                             headers={"Content-Disposition": f'attachment; filename="asmnt-sync-{run_id}.{ext}"'})


# ---- global search --------------------------------------------------------------------------------
def search(query: str, limit: int = 20) -> list[dict]:
    q = (query or "").strip().lower()
    if len(q) < 3:
        return []
    out = []
    for run in store.load():
        date = time.strftime("%Y-%m-%d %H:%M", time.localtime(run.get("created_at", 0)))
        for item in run.get("items", []):
            hit = next((item[k] for k in ("prod_id", "json_id", "staging_id") if q in (item.get(k) or "").lower()), None)
            if hit is None:
                continue
            mapping = " → ".join(item.get(k) or "—" for k in ("prod_id", "json_id", "staging_id"))
            out.append({"title": hit, "subtitle": f"{mapping} · {date}", "icon": "🔁", "ref": run["id"]})
            if len(out) >= limit:
                return out
    return out
