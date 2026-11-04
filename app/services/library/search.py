"""Global search provider: library items by name, description, tags, collection and content."""

from __future__ import annotations

import importlib

from app.services.planner.search import first_line, rank

from .store import Library

router = importlib.import_module(".router", __package__)  # the module, not the re-exported APIRouter

LIMIT = 50
ICONS = {"sql": "🗄️", "mongo": "🍃", "shell": "💻", "python": "🐍", "json": "🧾", "yaml": "📐", "link": "🔗", "note": "📝"}


def _subtitle(item: dict, q: str) -> str:
    line = first_line(item["content"], q) or item["description"]
    return " · ".join(x for x in (item["collection"] or "No collection", line) if x)


def search(query: str, limit: int = LIMIT) -> list[dict]:
    q = query.strip().lower()
    if not q:
        return []
    status = router._status()
    if status["problem"] or not status["exists"]:  # missing or disallowed folder: nothing to search, not an error
        return []
    found = []
    for item in Library(router._root()).items():
        r = rank(q, item["name"], item["description"], " ".join(item["tags"]), item["collection"], item["content"])
        if r is not None:
            found.append(((r, -(item.get("last_used") or 0), item["name"].lower()), {
                "title": item["name"], "subtitle": _subtitle(item, q),
                "icon": ICONS.get(item["type"], "📄"), "ref": item["path"]}))
    found.sort(key=lambda x: x[0])
    return [res for _, res in found[:limit]]
