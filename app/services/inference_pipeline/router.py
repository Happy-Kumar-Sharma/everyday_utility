from __future__ import annotations

import time
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.core import audit, config, context
from app.core.jobs import JobConflict
from app.core.postgres import PostgresConfigError, describe_target, export_csv_script, pg_env
from app.core.tabular import TabularError
from app.services.column_extractor.router import extract_column

from . import commands, sql
from .ids import parse_ids, read_ids_file, write_ids_file

SERVICE_ID = "inference-pipeline"
OUTPUT_DIR = config.DATA_DIR / "outputs" / SERVICE_ID

router = APIRouter()


class WithSettings(BaseModel):
    settings: dict = Field(default_factory=dict, description="unsaved overrides on top of the saved settings")


class IdsRequest(WithSettings):
    source: Literal["text", "file"]
    text: str = ""
    path: str = ""
    column: str = ""
    sheet: str | None = None


class RunOptions(BaseModel):
    dry_run: bool = False
    replace: bool = False
    batch_size: int | None = Field(None, ge=1)


class RunRequest(WithSettings):
    options: RunOptions = Field(default_factory=RunOptions)


def _settings(overrides: dict) -> dict:
    try:
        return context.service_settings(SERVICE_ID, overrides)
    except (TypeError, ValueError) as e:
        raise HTTPException(400, f"invalid setting: {e}") from e


def _path(value: str) -> Path:
    return Path(str(value)).expanduser()


# path -> (inode, head fingerprint, bytes counted, newlines in those bytes); the predictions JSONL is ~1 GB
# and only ever appended to while a run is in progress, so re-polling only reads what was added since
_line_counts: dict[str, tuple[int, bytes, int, int]] = {}


def _count_lines(path: Path) -> int:
    st = path.stat()
    with path.open("rb") as f:
        head = f.read(4096)
        inode, cached_head, offset, n = _line_counts.get(str(path), (st.st_ino, head, 0, 0))
        # replaced, truncated or rewritten in place: start over
        if inode != st.st_ino or st.st_size < offset or cached_head != head[: len(cached_head)] or len(cached_head) < min(4096, offset):
            offset, n = 0, 0
        f.seek(offset)
        while chunk := f.read(1 << 20):
            n += chunk.count(b"\n")
            offset += len(chunk)
    _line_counts[str(path)] = (st.st_ino, head, offset, n)
    return n


def _file_info(path: Path, header: bool = False) -> dict:
    if not path.is_file():
        return {"path": str(path), "exists": False}
    lines = _count_lines(path)
    return {
        "path": str(path),
        "exists": True,
        "rows": max(lines - 1, 0) if header else lines,
        "size": path.stat().st_size,
        "mtime": path.stat().st_mtime,
    }


def _damage_ids(s: dict) -> list[int]:
    try:
        return sql.parse_int_list(s["damage_type_ids"])
    except ValueError as e:
        raise HTTPException(400, f"Damage type ids: {e}") from e


# ---- read-only views ------------------------------------------------------------------------------
@router.post("/status")
def status(req: WithSettings):
    s = _settings(req.settings)
    ids_path = _path(s["ids_file"])
    ids = read_ids_file(ids_path)
    db = {"ok": False}
    try:
        db = {"ok": True, "target": describe_target(pg_env(s["local_env_file"]))}
    except PostgresConfigError as e:
        db = {"ok": False, "error": str(e)}
    missing = [
        label
        for key, label in [
            ("aicdb_repo", "AI CDB repo"),
            ("aicdb_venv", "AI CDB venv"),
            ("model_dir", "Model folder"),
            ("services_venv", "Model venv"),
        ]
        if not _path(s[key]).is_dir()
    ]
    return {
        "ids": {**_file_info(ids_path), "count": len(ids), "sample": ids[:8]},
        "pred_input_csv": _file_info(_path(s["pred_input_csv"]), header=True),
        "pred_output_jsonl": _file_info(_path(s["pred_output_jsonl"])),
        "db": db,
        "missing_paths": missing,
    }


@router.post("/plan")
def plan(req: WithSettings):
    """Every step's command / SQL for the current settings, so the UI can show and copy them."""
    s = _settings(req.settings)
    ids = read_ids_file(_path(s["ids_file"]))
    try:
        images_sql = sql.images_for_prediction(ids)
    except ValueError:
        images_sql = "-- set image ids in step 1 first"
    try:
        preds_sql = sql.predictions(ids, sql.parse_int_list(s["damage_type_ids"]))
    except ValueError as e:
        preds_sql = f"-- {e}" if ids else "-- set image ids in step 1 first"
    return {
        "migrate": commands.migrate(s).display,
        "export_images": images_sql,
        "predict": commands.predict_batched(s).display,
        "predict_single": commands.predict_single(s).display,
        "load": commands.load_predictions(s).display,
        "query_predictions": preds_sql,
    }


# ---- step 1: ids ----------------------------------------------------------------------------------
def _collect_ids(req: IdsRequest) -> dict:
    try:
        values = req.text if req.source == "text" else extract_column(req.path, req.column, req.sheet)
    except TabularError as e:
        raise HTTPException(400, str(e)) from e
    return parse_ids(values)


@router.post("/ids/parse")
def ids_parse(req: IdsRequest):
    parsed = _collect_ids(req)
    return {k: v for k, v in parsed.items() if k != "ids"} | {"sample": parsed["ids"][:8]}


@router.post("/ids/write")
def ids_write(req: IdsRequest):
    s = _settings(req.settings)
    parsed = _collect_ids(req)
    if not parsed["ids"]:
        raise HTTPException(400, "no valid integer ids found")
    target = _path(s["ids_file"])
    backup = write_ids_file(target, parsed["ids"])
    audit.record("pipeline", "ids-write", str(target), env="local",
                 detail={"count": len(parsed["ids"]), "backup": str(backup) if backup else None})
    return {
        "path": str(target),
        "backup": str(backup) if backup else None,
        **{k: v for k, v in parsed.items() if k != "ids"},
    }


# ---- steps 2-6: jobs ------------------------------------------------------------------------------
def _start(cmd: commands.Command, step: str, meta: dict | None = None, env: dict | None = None) -> dict:
    try:
        job = context.jobs.start(
            cmd.title,
            cmd.script,
            display=cmd.display,
            env={**cmd.env, **(env or {})},
            lock_key=f"{SERVICE_ID}:{step}",
            meta={"step": step, **(meta or {})},
        )
    except JobConflict as e:
        raise HTTPException(409, str(e)) from e
    return job.to_dict()


def _sql_job(s: dict, step: str, title: str, query: str, out_csv: Path) -> dict:
    try:
        env = pg_env(s["local_env_file"], read_only=True)
    except PostgresConfigError as e:
        raise HTTPException(400, str(e)) from e
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    sql_file = OUTPUT_DIR / f"{step}-{time.strftime('%Y%m%d-%H%M%S')}.sql"
    sql_file.write_text(query, encoding="utf-8")
    script, display = export_csv_script(sql_file, out_csv)
    cmd = commands.Command(title, script, display)
    # db target is user@host:port/db, never the password
    return _start(cmd, step, meta={"output": str(out_csv), "db": describe_target(env), "env": "local"}, env=env)


@router.post("/run/{step}")
def run(step: str, req: RunRequest):
    s = _settings(req.settings)
    o = req.options
    if step == "migrate":
        if not read_ids_file(_path(s["ids_file"])):
            raise HTTPException(400, "the ids file is empty, set image ids in step 1")
        return _start(commands.migrate(s, dry_run=o.dry_run, replace=o.replace, batch_size=o.batch_size), step)
    if step == "export_images":
        ids = read_ids_file(_path(s["ids_file"]))
        try:
            query = sql.images_for_prediction(ids)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        return _sql_job(s, step, "Export images CSV", query, _path(s["pred_input_csv"]))
    if step in ("predict", "predict_single"):
        if not _path(s["pred_input_csv"]).is_file():
            raise HTTPException(400, f"input CSV not found: {s['pred_input_csv']} (run step 3)")
        cmd = commands.predict_batched(s) if step == "predict" else commands.predict_single(s)
        # both variants append to the same JSONL, so they share one lock
        return _start(cmd, "predict", meta={"variant": step, "output": str(_path(s["pred_output_jsonl"]))})
    if step == "load":
        if not _path(s["pred_output_jsonl"]).is_file():
            raise HTTPException(400, f"predictions file not found: {s['pred_output_jsonl']} (run step 4)")
        return _start(commands.load_predictions(s, dry_run=o.dry_run, replace=o.replace), step)
    if step == "query_predictions":
        ids = read_ids_file(_path(s["ids_file"]))
        try:
            query = sql.predictions(ids, _damage_ids(s))
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        out = OUTPUT_DIR / f"predictions-{time.strftime('%Y%m%d-%H%M%S')}.csv"
        return _sql_job(s, step, "Query predictions", query, out)
    raise HTTPException(404, f"unknown step '{step}'")
