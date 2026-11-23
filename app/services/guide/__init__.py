"""📖 Guide tab: how to run and use the app, plus backup / restore of everything private."""

from __future__ import annotations

import os
import time
import zipfile
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.core import audit, config, context
from app.core.platform import O_BINARY
from app.core.registry import Service

router = APIRouter()

# what a backup contains, relative to data/; uploads and job logs are re-creatable, so they're optional
DATA_PARTS = {
    "planner": "Planner tasks + daily notes",
    "settings": "Settings of every tab (paths, options)",
    "manager": "Env-files repo list",
    "outputs": "Pipeline query results (CSV)",
    "jobs": "Job logs",
    "uploads": "Uploaded CSV / Excel files",
}
DEFAULT_PARTS = ["planner", "settings", "manager"]


def _creds_path() -> Path | None:
    try:
        value = context.service_settings("manager").get("credentials_file") or ""
    except KeyError:
        return None
    return Path(value).expanduser() if value else None


def _library_dir() -> Path | None:
    try:
        value = context.service_settings("library").get("library_dir") or ""
    except KeyError:
        return None
    return Path(value).expanduser() if value else None


def _size(p: Path) -> int:
    if p.is_file():
        return p.stat().st_size
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) if p.is_dir() else 0


@router.get("/paths")
def paths():
    creds = _creds_path()
    return {
        "app_root": str(config.ROOT_DIR),
        "data_dir": str(config.DATA_DIR),
        "url": f"http://{config.HOST}:{config.PORT}",
        "credentials_file": str(creds) if creds else None,
        "credentials_exists": bool(creds and creds.is_file()),
        "library_dir": str(_library_dir() or ""),
        "library_size": _size(_library_dir()) if _library_dir() else 0,
        "parts": [
            {"key": k, "label": v, "path": str(config.DATA_DIR / k), "size": _size(config.DATA_DIR / k),
             "default": k in DEFAULT_PARTS}
            for k, v in DATA_PARTS.items()
        ],
        "default_backup_dir": str(Path.home() / "everyday_utility_backups"),
    }


class BackupRequest(BaseModel):
    dest_dir: str
    parts: list[str] = DEFAULT_PARTS
    include_credentials: bool = True
    include_library: bool = True
    include_env_files: bool = False


@router.post("/backup")
def backup(req: BackupRequest):
    """Every attempt is audited: the Home dashboard reads the last backup from audit.recent(1, kind="backup")."""
    flags = req.model_dump(include={"parts", "include_credentials", "include_library", "include_env_files"})
    try:
        result = _backup(req)
    except Exception as e:
        reason = str(e.detail) if isinstance(e, HTTPException) else f"{type(e).__name__}: {e}"
        audit.record("backup", "create", req.dest_dir, status="failed", detail={"reason": reason, **flags})
        raise
    audit.record("backup", "create", result["path"], status="succeeded",
                 detail={"size": result["size"], "contents": result["contents"], **flags})
    return result


def _backup(req: BackupRequest) -> dict:
    dest = Path(req.dest_dir).expanduser().resolve()
    root = config.ROOT_DIR.resolve()
    if dest == root or root in dest.parents:
        # inside the repo a backup could get committed; data/ is ignored, but don't rely on that
        raise HTTPException(400, "choose a backup folder outside the app folder (e.g. ~/everyday_utility_backups)")
    unknown = set(req.parts) - set(DATA_PARTS)
    if unknown:
        raise HTTPException(400, f"unknown parts: {', '.join(sorted(unknown))}")
    out = dest / f"everyday_utility_backup_{time.strftime('%Y%m%d-%H%M%S')}.zip"
    from app.services.manager.credfile import git_safety  # same git check as the Logins file

    safety = git_safety(out, config.ROOT_DIR)
    if not safety["safe"]:
        raise HTTPException(400, f"{dest} is inside the git repo {safety.get('repo')} and not ignored — "
                                 "a commit there would include your passwords; pick a folder outside any repo")
    dest.mkdir(parents=True, exist_ok=True)
    added: list[str] = []
    # owner-only from the first byte, never overwrite an existing file
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL | O_BINARY, 0o600)
    with os.fdopen(fd, "wb") as fh, zipfile.ZipFile(fh, "w", zipfile.ZIP_DEFLATED) as z:
        for part in req.parts:
            base = config.DATA_DIR / part
            for f in sorted(base.rglob("*")) if base.is_dir() else []:
                if f.is_file():
                    z.write(f, f"data/{f.relative_to(config.DATA_DIR).as_posix()}")
            if base.is_dir():
                added.append(f"data/{part}/")
        creds = _creds_path()
        if req.include_credentials and creds and creds.is_file():
            z.write(creds, f"credentials/{creds.name}")
            added.append(f"credentials/{creds.name}")
        lib = _library_dir()
        if req.include_library and lib and lib.is_dir():
            for f in sorted(lib.rglob("*")):
                if f.is_file() and not f.name.endswith(".tmp"):
                    z.write(f, f"library/{f.relative_to(lib).as_posix()}")
            added.append("library/")
        if req.include_env_files:
            from app.services.manager import envfiles  # optional: only when the Manager tab exists
            from app.services.manager.router import repos

            s = context.service_settings("manager")
            text = envfiles.export_text(repos.repos(), envfiles.parse_patterns(s["env_patterns"]), int(s["max_depth"]))
            z.writestr("env_files_export.txt", text)
            added.append("env_files_export.txt")
        z.writestr("RESTORE.txt", RESTORE_TEXT.format(root=config.ROOT_DIR, creds=creds or "(not set)"))
    return {"path": str(out), "size": out.stat().st_size, "contents": added}


RESTORE_TEXT = """Everyday Utility backup — how to restore
==========================================

1. Stop the app (Ctrl+C in the terminal running ./run.sh).
2. Copy the data/ folder from this zip into the app folder:
       unzip -o <this zip> 'data/*' -d {root}
3. Put credentials/<file> back where the Logins tab expects it:
       {creds}
   (or anywhere outside a git repo, then Manager → Logins → Change location).
4. library/ (if present) is your 📚 Library folder: copy it back to the folder set in Library → ⚙ Library folder.
5. env_files_export.txt (if present) is a plain-text copy of every repo's env / credentials files, for
   reference: copy values back into the repos by hand.
6. Start the app again: ./run.sh

This zip contains secrets in plain text. Keep it off GitHub and shared drives.
"""


SERVICE = Service(
    id="guide",
    title="Guide",
    description="How to run this app, what each tab does, and how to back up and restore your data.",
    icon="📖",
    order=99,
    router=router,
)
