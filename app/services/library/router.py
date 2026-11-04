from __future__ import annotations

import re
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.core import config, context
from app.core.gitsafety import dir_safety
from app.core.jobs import JobConflict

from .starters import STARTERS
from .store import DEFAULT_EXT, ENVS, TYPES, Library, LibraryError

SERVICE_ID = "library"

router = APIRouter()

_PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::([^}]*))?\}\}")


def render_template(text: str, values: dict) -> str:
    """{{name}} / {{name:default}} placeholders; {{today}} and {{now}} are built in."""
    builtins = {"today": time.strftime("%Y-%m-%d"), "now": time.strftime("%Y-%m-%d %H:%M:%S")}

    def sub(m: re.Match) -> str:
        name, default = m.group(1), m.group(2)
        if name in values and str(values[name]) != "":
            return str(values[name])
        if name in builtins:
            return builtins[name]
        if default is not None:
            return default
        raise LibraryError(f"no value for {{{{{name}}}}}")

    return _PLACEHOLDER.sub(sub, text)


def _root() -> Path:
    value = str(context.service_settings(SERVICE_ID)["library_dir"] or "").strip()
    return Path(value).expanduser()


def _status() -> dict:
    root = _root()
    problem = None
    if not root.is_absolute():
        problem = "library folder must be an absolute path (⚙ Settings)"
    else:
        app_root = config.ROOT_DIR.resolve()
        r = root.resolve()
        if (r == app_root or app_root in r.parents) and (app_root / "private") not in [r, *r.parents]:
            problem = f"inside the app folder only {app_root / 'private'}/ may hold the library"
    git = {"in_repo": False, "safe": False}
    if not problem:
        git = dir_safety(root, config.ROOT_DIR)
    return {"root": str(root), "exists": root.is_dir(), "problem": problem, "git": git}


def _lib(write: bool = False) -> Library:
    if write:
        st = _status()
        if st["problem"]:
            raise HTTPException(409, st["problem"])
        if not st["git"]["safe"]:
            raise HTTPException(409, f"{st['root']} is inside git repo {st['git'].get('repo')} and not ignored — "
                                     "queries may hold prod details; add it to .gitignore or pick another folder in ⚙ Settings")
    return Library(_root())


def _call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except (LibraryError, OSError) as e:
        raise HTTPException(400, str(e)) from e


class ItemIn(BaseModel):
    collection: str = ""
    name: str
    ext: str = ""
    type: str = "note"
    content: str = ""
    description: str = ""
    tags: list[str] | str = Field(default_factory=list)
    env: str = ""
    favorite: bool = False


class ItemUpdate(BaseModel):
    path: str
    expected_mtime: float | None = None
    collection: str | None = None
    name: str | None = None
    ext: str | None = None
    content: str | None = None
    description: str | None = None
    tags: list[str] | str | None = None
    env: str | None = None
    favorite: bool | None = None


class PathReq(BaseModel):
    path: str


class RunReq(BaseModel):
    path: str
    values: dict = Field(default_factory=dict)


class CollectionReq(BaseModel):
    name: str
    new_name: str = ""


@router.get("/items")
def items():
    st = _status()
    lib = Library(_root())
    return {
        **st,
        "collections": _call(lib.collections) if st["exists"] and not st["problem"] else [],
        "items": _call(lib.items) if st["exists"] and not st["problem"] else [],
        "types": sorted(set(TYPES.values())),
        "default_ext": DEFAULT_EXT,
        "envs": list(ENVS),
    }


@router.post("/items")
def create(item: ItemIn):
    ext = item.ext if item.ext != "" else DEFAULT_EXT.get(item.type, "txt")
    meta = item.model_dump(include={"description", "tags", "env", "favorite"})
    return _call(_lib(True).create, item.collection, item.name, ext, item.content, meta)


@router.put("/items")
def update(req: ItemUpdate):
    meta = {k: v for k, v in req.model_dump(include={"description", "tags", "env", "favorite"}).items() if v is not None}
    return _call(_lib(True).update, req.path, content=req.content, meta=meta, expected_mtime=req.expected_mtime,
                 collection=req.collection, name=req.name, ext=req.ext)


@router.post("/items/delete")
def delete(req: PathReq):
    return {"trash_id": _call(_lib(True).delete, req.path)}


@router.post("/items/duplicate")
def duplicate(req: PathReq):
    return _call(_lib(True).duplicate, req.path)


@router.post("/items/use")
def use(req: PathReq):
    return _call(_lib(True).touch_use, req.path)


@router.get("/trash")
def trash():
    return _call(_lib().trash)


@router.post("/trash/restore")
def restore(req: PathReq):
    return _call(_lib(True).restore, req.path)


@router.post("/collections")
def create_collection(req: CollectionReq):
    return {"name": _call(_lib(True).create_collection, req.name)}


@router.post("/collections/rename")
def rename_collection(req: CollectionReq):
    return {"name": _call(_lib(True).rename_collection, req.name, req.new_name)}


@router.post("/collections/delete")
def delete_collection(req: CollectionReq):
    _call(_lib(True).delete_collection, req.name)
    return {"ok": True}


@router.post("/seed")
def seed():
    return {"created": _call(_lib(True).seed, STARTERS)}


@router.post("/run")
def run(req: RunReq):
    """Run a shell item as a background job (the UI confirms first and shows the rendered command)."""
    lib = _lib()
    item = _call(lib.get, req.path)
    if item["type"] != "shell":
        raise HTTPException(400, "only shell items (.sh) can be run")
    script = _call(render_template, item["content"], req.values)
    try:
        job = context.jobs.start(f"Library: {item['name']}", script, cwd=str(Path.home()),
                                 lock_key=f"{SERVICE_ID}:{req.path}", meta={"step": "library", "path": req.path})
    except JobConflict as e:
        raise HTTPException(409, str(e)) from e
    if _status()["git"]["safe"]:
        _call(lib.touch_use, req.path)
    return job.to_dict()
