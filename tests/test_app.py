import time
from pathlib import Path

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.core.jobs import JobManager
from app.services.column_extractor.logic import FormatOptions, format_values
from app.services.inference_pipeline import commands, sql
from app.services.inference_pipeline.ids import parse_ids, read_ids_file, write_ids_file

H = {"x-everyday-utility": "1"}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    from app.core import config, context
    from app.core.jobs import JobManager
    from app.core.settings_store import SettingsStore

    monkeypatch.setattr(config, "UPLOADS_DIR", tmp_path / "uploads")
    monkeypatch.setattr(context, "jobs", JobManager(tmp_path / "jobs"))
    monkeypatch.setattr(context, "settings", SettingsStore(tmp_path / "settings"))
    from app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture()
def csv_file(tmp_path):
    p = tmp_path / "ids.csv"
    # BOM + blanks + duplicates, like real exports
    p.write_bytes("﻿image_id,name\n10,a\n2,b\n\n10,c\n 7 ,d\n".encode())
    return p


# ---- column extractor ---------------------------------------------------------------------------
def test_format_basic():
    r = format_values(["1", "2", "3"], FormatOptions())
    assert r["text"] == "1,2,3" and r["count"] == 3


def test_format_quote_wrap_unique_sort():
    r = format_values(["b", "a", "b", "", "it's"], FormatOptions(
        delimiter="comma_space", quote="single", wrap="paren", unique=True, sort="asc"))
    assert r["text"] == "('a', 'b', 'it''s')"
    assert r["blank_skipped"] == 1 and r["duplicates_removed"] == 1


def test_format_numeric_sort_and_per_line():
    r = format_values(["10", "2", "1"], FormatOptions(sort="asc", numeric_sort=True, per_line=2))
    assert r["text"] == "1,2,\n10"


def test_format_custom_delimiter_escapes():
    assert format_values(["a", "b"], FormatOptions(delimiter="custom", custom_delimiter="\\n"))["text"] == "a\nb"
    with pytest.raises(ValueError):
        format_values(["a"], FormatOptions(delimiter="nope"))


def test_extract_endpoint_handles_bom(client, csv_file):
    r = client.post("/api/column-extractor/extract", headers=H,
                    json={"path": str(csv_file), "column": "image_id", "unique": True})
    assert r.status_code == 200, r.text
    assert r.json()["text"] == "10,2,7"


def test_extract_excel(client, tmp_path):
    p = tmp_path / "x.xlsx"
    pd.DataFrame({"id": ["007", "8"]}).to_excel(p, index=False)
    r = client.post("/api/column-extractor/extract", headers=H, json={"path": str(p), "column": "id", "delimiter": "dot"})
    assert r.json()["text"] == "007.8"


def test_extract_errors(client, csv_file):
    r = client.post("/api/column-extractor/extract", headers=H, json={"path": str(csv_file), "column": "missing"})
    assert r.status_code == 400 and "not found" in r.json()["detail"]
    r = client.post("/api/column-extractor/extract", headers=H, json={"path": "/nope.csv", "column": "x"})
    assert r.status_code == 400


def test_csrf_header_required(client, csv_file):
    r = client.post("/api/column-extractor/extract", json={"path": str(csv_file), "column": "image_id"})
    assert r.status_code == 403


def test_upload_and_inspect(client, csv_file):
    r = client.post("/api/files/upload", headers=H, files={"file": ("my ids.csv", csv_file.read_bytes())})
    path = r.json()["path"]
    info = client.get("/api/files/inspect", params={"path": path}).json()
    assert info["columns"] == ["image_id", "name"] and info["row_count"] == 4


# ---- pipeline -------------------------------------------------------------------------------------
def test_parse_ids():
    r = parse_ids("1, 2\n2 x 6838864.0 (3)")
    assert r["ids"] == [1, 2, 6838864, 3] and r["duplicates"] == 1 and r["invalid_sample"] == ["x"]


def test_write_ids_backup(tmp_path):
    p = tmp_path / "ids.txt"
    assert write_ids_file(p, [1, 2]) is None
    backup = write_ids_file(p, [3])
    assert read_ids_file(p) == [3] and backup and read_ids_file(backup) == [1, 2]


def test_sql_templates():
    q = sql.predictions([1, 2], [2, 6])
    assert "IN (\n    1,2\n)" in q and "dt.id IN (2,6)" in q
    assert "dt.id IN" not in sql.predictions([1], [])
    with pytest.raises(ValueError):
        sql.images_for_prediction([])
    with pytest.raises(ValueError):
        sql.parse_int_list("1, x")


def test_commands_quote_paths():
    s = {"aicdb_repo": "/tmp/a b", "aicdb_venv": "/tmp/v", "ids_file": "/tmp/ids;rm -rf ~.txt", "local_env_file": "/tmp/e.sh"}
    cmd = commands.migrate(s, dry_run=True, batch_size=10)
    assert "cd '/tmp/a b'" in cmd.script and "'/tmp/ids;rm -rf ~.txt'" in cmd.script
    assert cmd.script.rstrip().endswith("--batch-size 10 --dry-run")


def test_pipeline_ids_flow(client, csv_file, tmp_path):
    ids_file = tmp_path / "out" / "ids.txt"
    settings = {"ids_file": str(ids_file)}
    r = client.post("/api/inference-pipeline/ids/write", headers=H,
                    json={"settings": settings, "source": "file", "path": str(csv_file), "column": "image_id"})
    assert r.status_code == 200, r.text
    assert ids_file.read_text() == "10\n2\n7\n"
    st = client.post("/api/inference-pipeline/status", headers=H, json={"settings": settings}).json()
    assert st["ids"]["count"] == 3
    plan = client.post("/api/inference-pipeline/plan", headers=H, json={"settings": settings}).json()
    assert "10,2,7" in plan["export_images"]


def test_settings_roundtrip(client):
    r = client.put("/api/services/inference-pipeline/settings", headers=H, json={"prefetch_workers": "4", "bogus": 1})
    assert r.json()["prefetch_workers"] == 4 and "bogus" not in r.json()
    r = client.delete("/api/services/inference-pipeline/settings", headers=H)
    assert r.json()["prefetch_workers"] == 16


# ---- jobs -----------------------------------------------------------------------------------------
def _wait(job, timeout=10):
    end = time.time() + timeout
    while not job.done and time.time() < end:
        time.sleep(0.05)
    assert job.done


def test_job_output_and_progress_bars(tmp_path):
    jm = JobManager(tmp_path)
    job = jm.start("t", r"printf 'a\nb\n10%%\r20%%\r30%%\ndone'")
    _wait(job)
    out = job.output_since(0)
    assert out["lines"] == ["a", "b", "30%", "done"] and job.status == "succeeded"
    assert job.output_since(2)["lines"] == ["30%", "done"]


def test_job_failure_cancel_and_lock(tmp_path):
    jm = JobManager(tmp_path)
    bad = jm.start("bad", "exit 3")
    _wait(bad)
    assert bad.status == "failed" and bad.exit_code == 3

    slow = jm.start("slow", "sleep 30", lock_key="k")
    from app.core.jobs import JobConflict
    with pytest.raises(JobConflict):
        jm.start("slow2", "true", lock_key="k")
    jm.cancel(slow.id)
    _wait(slow)
    assert slow.status == "cancelled"


def test_job_stream_endpoint(client):
    from app.core import context
    job = context.jobs.start("echo", "echo hello")
    _wait(job)
    with client.stream("GET", f"/api/jobs/{job.id}/stream") as r:
        body = "".join(r.iter_text())
    assert "hello" in body and "event: done" in body
