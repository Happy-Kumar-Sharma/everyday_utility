"""Global search provider (Ctrl+K): clips by title and URL."""

from __future__ import annotations

import importlib
from urllib.parse import urlsplit

from app.services.planner.search import rank

from . import storage

router = importlib.import_module(".router", __package__)  # the module, not the re-exported APIRouter

LIMIT = 30


def search(query: str, limit: int = LIMIT) -> list[dict]:
    q = query.strip().lower()
    if not q:
        return []
    st = router._status()
    if st["problem"] or not st["exists"]:
        return []
    found = []
    for c in storage.list_clips(router._root()):
        r = rank(q, c["title"], c["url"], c["final_url"], c["name"])
        if r is not None:
            host = urlsplit(c["url"]).hostname or ""
            found.append(((r, -c["clipped_ts"]), {"title": c["title"], "subtitle": f"{host} · {c['clipped_at'][:10]}",
                                                   "icon": "🗞", "ref": c["name"]}))
    found.sort(key=lambda x: x[0])
    return [res for _, res in found[:limit]]
