from __future__ import annotations

import re
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.core import audit, config, context
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


def _audit(action: str, target: str, env: str | None = None, **detail) -> None:
    # paths and names only: item content may hold prod details
    audit.record("library", action, target, env=env or None, detail=detail)


def _env_of(lib: Library, path: str) -> str | None:
    try:
        return lib.get(path)["env"] or None
    except (LibraryError, OSError):
        return None


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
    created = _call(_lib(True).create, item.collection, item.name, ext, item.content, meta)
    _audit("create", created["path"], created["env"], type=created["type"])
    return created


@router.put("/items")
def update(req: ItemUpdate):
    meta = {k: v for k, v in req.model_dump(include={"description", "tags", "env", "favorite"}).items() if v is not None}
    lib = _lib(True)
    before = _call(lib.get, req.path)
    after = _call(lib.update, req.path, content=req.content, meta=meta, expected_mtime=req.expected_mtime,
                  collection=req.collection, name=req.name, ext=req.ext)
    detail = {"content_changed": req.content is not None and req.content != before["content"],
              "meta_changed": sorted(k for k in meta if before.get(k) != after.get(k))}
    if after["path"] != req.path:
        detail["renamed"] = {"from": req.path, "to": after["path"]}
    _audit("update", after["path"], after["env"], **detail)
    return after


@router.post("/items/delete")
def delete(req: PathReq):
    lib = _lib(True)
    env = _env_of(lib, req.path)
    trash_id = _call(lib.delete, req.path)
    _audit("delete", req.path, env, trash_id=trash_id)
    return {"trash_id": trash_id}


@router.post("/items/duplicate")
def duplicate(req: PathReq):
    copy = _call(_lib(True).duplicate, req.path)
    _audit("duplicate", copy["path"], copy["env"], source=req.path)
    return copy


@router.post("/items/use")
def use(req: PathReq):
    lib = _lib(True)
    used = _call(lib.touch_use, req.path)
    _audit("use", req.path, _env_of(lib, req.path))
    return used


@router.get("/trash")
def trash():
    return _call(_lib().trash)


@router.post("/trash/restore")
def restore(req: PathReq):
    restored = _call(_lib(True).restore, req.path)
    _audit("restore", restored["path"], restored["env"], trash_id=req.path)
    return restored


@router.post("/collections")
def create_collection(req: CollectionReq):
    name = _call(_lib(True).create_collection, req.name)
    _audit("collection-create", name)
    return {"name": name}


@router.post("/collections/rename")
def rename_collection(req: CollectionReq):
    name = _call(_lib(True).rename_collection, req.name, req.new_name)
    _audit("collection-rename", name, renamed={"from": req.name, "to": name})
    return {"name": name}


@router.post("/collections/delete")
def delete_collection(req: CollectionReq):
    _call(_lib(True).delete_collection, req.name)
    _audit("collection-delete", req.name)
    return {"ok": True}


@router.post("/seed")
def seed():
    created = _call(_lib(True).seed, STARTERS)
    _audit("seed", str(_root()), created=created)
    return {"created": created}


@router.post("/run")
def run(req: RunReq):
    """Run a shell item as a background job (the UI confirms first and shows the rendered command)."""
    lib = _lib()
    item = _call(lib.get, req.path)
    if item["type"] != "shell":
        raise HTTPException(400, "only shell items (.sh) can be run")
    script = _call(render_template, item["content"], req.values)
    env = item["env"] or None
    try:
        job = context.jobs.start(f"Library: {item['name']}", script, cwd=str(Path.home()),
                                 lock_key=f"{SERVICE_ID}:{req.path}",
                                 meta={"step": "library", "path": req.path, "env": env})
    except JobConflict as e:
        raise HTTPException(409, str(e)) from e
    _audit("run", req.path, env, job=job.id)
    if _status()["git"]["safe"]:
        _call(lib.touch_use, req.path)
    return job.to_dict()
