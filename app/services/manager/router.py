from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

from app.core import config, context

from . import credfile, envfiles
from .credfile import CredError, CredFile
from .envfiles import EnvError, RepoStore

SERVICE_ID = "manager"
STORE_DIR = config.DATA_DIR / SERVICE_ID

router = APIRouter()
repos = RepoStore(STORE_DIR / "repos.json")


def _settings() -> dict:
    return context.service_settings(SERVICE_ID)


def _text_download(text: str, filename: str) -> PlainTextResponse:
    return PlainTextResponse(text, headers={"Content-Disposition": f'attachment; filename="{filename}"'})


# ---- credentials text file ------------------------------------------------------------------------
class Location(BaseModel):
    path: str


class CredEntry(BaseModel):
    title: str = ""
    url: str = ""
    username: str = ""
    password: str = ""
    notes: str = ""
    tags: str = ""


class CredUpdate(CredEntry):
    original_hash: str  # fingerprint of the entry as loaded: guards against editing the wrong block


def _cred_path(s: dict | None = None) -> Path | None:
    value = str((s or _settings())["credentials_file"] or "").strip()
    return Path(value).expanduser() if value else None


def _cred_status() -> dict:
    path = _cred_path()
    if path is None:
        return {"configured": False, "suggested": str(config.ROOT_DIR / "private" / "credentials.txt")}
    status = {"configured": True, "path": str(path), "exists": path.is_file(), "problem": None,
              "git": {"in_repo": False, "safe": False}}
    try:
        # re-checked on every use: the location may also have been set through the generic settings form
        credfile.validate_location(path, config.ROOT_DIR)
        status["path"] = str(path.resolve())
        status["git"] = credfile.git_safety(path, config.ROOT_DIR)
    except CredError as e:
        status["problem"] = str(e)
    return status


def _safe_file() -> CredFile:
    """The configured file, only if git can't pick it up: never write secrets somewhere a push would take them."""
    status = _cred_status()
    if not status["configured"]:
        raise HTTPException(400, "choose where the credentials file lives first")
    if status["problem"]:
        raise HTTPException(409, status["problem"])
    if not status["git"]["safe"]:
        g = status["git"]
        raise HTTPException(409, f"{status['path']} is inside the git repo {g['repo']} and not ignored — "
                                 "add it to .gitignore or pick a location outside the repo")
    return CredFile(Path(status["path"]))


def _cred_call(fn, *args):
    try:
        return fn(*args)
    except CredError as e:
        raise HTTPException(400, str(e)) from e


@router.get("/creds")
def creds():
    status = _cred_status()
    entries = []
    if status["configured"] and status["exists"] and not status["problem"]:
        try:
            entries = [{"index": i, **e} for i, e in enumerate(CredFile(Path(status["path"])).read())]
        except CredError as e:
            status["problem"] = str(e)
    return {**status, "entries": entries}


@router.post("/creds/location")
def creds_location(req: Location):
    raw = req.path.strip()
    if not raw:
        raise HTTPException(400, "path is empty")
    path = Path(raw).expanduser()
    if path.is_dir() or raw.endswith("/"):
        path = path / "credentials.txt"
    _cred_call(credfile.validate_location, path, config.ROOT_DIR)
    context.settings.save(context.services[SERVICE_ID], {"credentials_file": str(path.resolve())})
    return creds()


@router.post("/creds/gitignore")
def creds_gitignore():
    status = _cred_status()
    if not status["configured"] or status["problem"] or not status["git"].get("in_repo"):
        raise HTTPException(400, status.get("problem") or "file is not inside a repository")
    _cred_call(credfile.add_to_gitignore, Path(status["git"]["repo"]), status["git"]["rel"])
    return creds()


@router.post("/creds/entries")
def creds_add(entry: CredEntry):
    return _cred_call(_safe_file().add, entry.model_dump())


@router.put("/creds/entries/{index}")
def creds_update(index: int, entry: CredUpdate):
    data = entry.model_dump(exclude={"original_hash"})
    return _cred_call(_safe_file().update, index, entry.original_hash, data)


@router.delete("/creds/entries/{index}")
def creds_delete(index: int, hash: str):
    _cred_call(_safe_file().delete, index, hash)
    return {"ok": True}


# ---- env files ------------------------------------------------------------------------------------
class RepoPath(BaseModel):
    path: str


class RepoFile(BaseModel):
    repo: str
    path: str


class ExportRequest(BaseModel):
    repos: list[str] = Field(default_factory=list, description="repo paths; empty = all")


def _scan_opts(s: dict) -> tuple[list[str], int]:
    return envfiles.parse_patterns(s["env_patterns"]), int(s["max_depth"])


def _env_call(fn, *args):
    try:
        return fn(*args)
    except EnvError as e:
        raise HTTPException(400, str(e)) from e


@router.get("/env/repos")
def env_repos():
    patterns, depth = _scan_opts(_settings())
    out = []
    for r in repos.repos():
        out.append({**r, "exists": Path(r["path"]).is_dir(), "files": envfiles.repo_files(r, patterns, depth)})
    return out


@router.post("/env/repos")
def env_add_repo(req: RepoPath):
    return _env_call(repos.add_repo, req.path)


@router.post("/env/repos/remove")
def env_remove_repo(req: RepoPath):
    repos.remove_repo(req.path)
    return {"ok": True}


@router.post("/env/files")
def env_add_file(req: RepoFile):
    return _env_call(repos.add_file, req.repo, req.path)


@router.post("/env/files/remove")
def env_remove_file(req: RepoFile):
    repos.remove_file(req.repo, req.path)
    return {"ok": True}


@router.get("/env/scan")
def env_scan(root: str = ""):
    """Sub-folders of root that look like repos (have .git or env files), for bulk-adding."""
    s = _settings()
    patterns, depth = _scan_opts(s)
    base = Path(root or s["workspace_root"]).expanduser()
    if not base.is_dir():
        raise HTTPException(400, f"folder not found: {base}")
    registered = {r["path"] for r in repos.repos()}
    out = []
    for d in sorted(p for p in base.iterdir() if p.is_dir() and not p.name.startswith(".")):
        files = envfiles.discover(d, patterns, depth)
        if files or (d / ".git").exists():
            out.append({"path": str(d.resolve()), "name": d.name, "env_files": len(files),
                        "git": (d / ".git").exists(), "registered": str(d.resolve()) in registered})
    return {"root": str(base), "candidates": out}


def _allowed_file(path: str) -> Path:
    """Only files that belong to a registered repo can be read through this service."""
    patterns, depth = _scan_opts(_settings())
    for r in repos.repos():
        for f in envfiles.repo_files(r, patterns, depth):
            if f["path"] == path and f["exists"]:
                return Path(path)
    raise HTTPException(404, "file is not part of a registered repository")


@router.get("/env/file")
def env_file(path: str):
    p = _allowed_file(path)
    text = _env_call(envfiles.read_text, p)
    return {"path": str(p), "content": text, "vars": envfiles.parse_vars(text)}


@router.post("/env/export")
def env_export(req: ExportRequest):
    patterns, depth = _scan_opts(_settings())
    selected = [r for r in repos.repos() if not req.repos or r["path"] in req.repos]
    if not selected:
        raise HTTPException(400, "no repositories registered")
    name = "env_export.txt" if len(selected) != 1 else f"env_export_{selected[0]['name']}.txt"
    return _text_download(envfiles.export_text(selected, patterns, depth), name)
