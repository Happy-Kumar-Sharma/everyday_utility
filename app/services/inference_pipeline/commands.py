"""Shell commands for the script-backed pipeline steps.

Each builder returns a ``Command`` whose ``display`` is what you'd type in a terminal (shown + copyable in
the UI) and whose ``script`` is what the job runner executes. Every value coming from settings is quoted.
"""

from __future__ import annotations

import shlex
from dataclasses import dataclass, field
from pathlib import Path

from app.core import platform as plat


@dataclass
class Command:
    title: str
    script: str
    display: str
    env: dict = field(default_factory=dict)


def _p(value: str) -> str:
    """Expand ~ and shell-quote a path (C:/… on Windows, which Git bash and Windows programs both accept)."""
    return shlex.quote(plat.bash_path(Path(str(value)).expanduser()))


def _activate(venv: str) -> str:
    return f"source {_p(venv)}/{'Scripts' if plat.IS_WINDOWS else 'bin'}/activate"


def _render(steps: list[str]) -> tuple[str, str]:
    display = " && \\\n".join(steps)
    # -e: stop at the first failing step; pipefail so `a | b` failures are not hidden
    script = "set -eo pipefail\n" + "\n".join(steps) + "\n"
    return script, display


def migrate(s: dict, *, dry_run: bool = False, replace: bool = False, batch_size: int | None = None) -> Command:
    args = [
        "python", "var/prod_to_local_images_migration.py",
        "--ids-file", _p(s["ids_file"]),
        "--local-env", _p(s["local_env_file"]),
    ]
    if batch_size:
        args += ["--batch-size", str(int(batch_size))]
    if replace:
        args.append("--replace")
    if dry_run:
        args.append("--dry-run")
    script, display = _render([f"cd {_p(s['aicdb_repo'])}", _activate(s["aicdb_venv"]), " ".join(args)])
    return Command("Load images prod → local ai_cdb", script, display)


def _model_env(s: dict) -> list[str]:
    lines = [f"cd {_p(s['model_dir'])}", _activate(s["services_venv"])]
    if str(s.get("ld_library_path") or "").strip():
        lines.append(f"export LD_LIBRARY_PATH={shlex.quote(s['ld_library_path'])}:${{LD_LIBRARY_PATH:-}}")
    return lines


def predict_batched(s: dict) -> Command:
    args = [
        "python", "predict_from_csv_batched.py",  # the activated venv's python (no python3.exe on Windows)
        "-i", _p(s["pred_input_csv"]),
        "-o", _p(s["pred_output_jsonl"]),
        "--bucket", shlex.quote(s["bucket"]),
        "--prefetch-workers", str(int(s["prefetch_workers"])),
        "--queue-size", str(int(s["queue_size"])),
    ]
    if int(s.get("model_batch_size") or 1) > 1:
        args += ["--model-batch-size", str(int(s["model_batch_size"]))]
    if s.get("fp16"):
        args.append("--fp16")
    script, display = _render(_model_env(s) + [" ".join(args)])
    return Command("Batched predictions", script, display)


def predict_single(s: dict) -> Command:
    args = [
        "CUDA_LAUNCH_BLOCKING=1", "python", "predict_from_csv.py",
        "-i", _p(s["pred_input_csv"]),
        "-o", _p(s["pred_output_jsonl"]),
    ]
    script, display = _render(_model_env(s) + [" ".join(args)])
    return Command("Single-model predictions", script, display)


def load_predictions(s: dict, *, dry_run: bool = False, replace: bool = False) -> Command:
    args = [
        "python", "var/load_local_predictions_jsonl.py", _p(s["pred_output_jsonl"]),
        "--model-name", shlex.quote(s["model_name"]),
        "--model-version", shlex.quote(s["model_version"]),
        "--local-env", _p(s["local_env_file"]),
    ]
    if replace:
        args.append("--replace")
    if dry_run:
        args.append("--dry-run")
    script, display = _render([f"cd {_p(s['aicdb_repo'])}", _activate(s["aicdb_venv"]), " ".join(args)])
    return Command("Load predictions JSONL → local ai_cdb", script, display)
