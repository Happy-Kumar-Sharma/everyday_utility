"""Global search provider: logins (title / URL / username), env repos (name) and env files (path, KEY names).

Passwords, notes and env values are never searched or returned: a query equal to a secret finds nothing."""

from __future__ import annotations

import importlib
from pathlib import Path

from app.services.planner.search import rank

from . import envfiles
from .credfile import CredError, CredFile
from .envfiles import EnvError

router = importlib.import_module(".router", __package__)  # the module, not the re-exported APIRouter

LIMIT = 50


def _logins(q: str) -> list[tuple]:
    status = router._cred_status()
    if not status["configured"] or not status.get("exists") or status["problem"]:
        return []
    try:
        entries = CredFile(Path(status["path"])).read()
    except CredError:
        return []
    out = []
    for i, e in enumerate(entries):
        r = rank(q, e["title"], e["url"], e["username"], e["tags"])
        if r is not None:
            out.append(((r, 0), {"title": e["title"], "subtitle": e["url"] or e["username"], "icon": "🔑",
                                 "ref": f"login:{i}:{e['hash']}"}))
    return out


def _env(q: str) -> list[tuple]:
    patterns, depth = router._scan_opts(router._settings())
    out = []
    for repo in router.repos.repos():
        r = rank(q, repo["name"])
        if r is not None:
            out.append(((r, 1), {"title": repo["name"], "subtitle": repo["path"], "icon": "📁", "ref": f"repo:{repo['path']}"}))
        try:
            files = envfiles.repo_files(repo, patterns, depth)
        except (EnvError, OSError):  # e.g. a root-owned .env: skip this repo's files, keep everything else
            continue
        for f in files:
            if not f["exists"]:
                continue
            try:
                keys = [v["key"] for v in envfiles.parse_vars(envfiles.read_text(Path(f["path"])))]
            except (EnvError, OSError):
                keys = []
            hits = [k for k in keys if q in k.lower()]
            r = rank(q, f["rel"])
            if r is None and hits:
                r = 4
            if r is not None:
                sub = f"{repo['name']} · {', '.join(hits[:5])}" if hits else repo["name"]
                out.append(((r, 2), {"title": f["rel"], "subtitle": sub, "icon": "🧾", "ref": f"envfile:{f['path']}"}))
    return out


def search(query: str, limit: int = LIMIT) -> list[dict]:
    q = query.strip().lower()
    if not q:
        return []
    found = []
    for part in (_logins, _env):  # one failing part must not hide the other's results
        try:
            found += part(q)
        except (CredError, EnvError, OSError):
            pass
    found.sort(key=lambda x: x[0])
    return [res for _, res in found[:limit]]
