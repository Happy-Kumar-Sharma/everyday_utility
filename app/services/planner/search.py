"""Global search provider: tasks (title, notes, tags, checklist) and daily notes.

`rank` and `first_line` are shared by the other tabs' providers."""

from __future__ import annotations

import importlib

# the module, not the APIRouter the package re-exports under the same name
router = importlib.import_module(".router", __package__)

LIMIT = 50
STATUS_ICON = {"todo": "⬜", "doing": "🔄", "done": "☑️"}


def rank(q: str, title: str, *fields: str) -> int | None:
    """0 exact title · 1 title prefix · 2 a title word starts with q · 3 q inside the title · 4 any other field
    (every word of q somewhere) · None = no match. q must be lower case."""
    t = title.lower()
    if t == q:
        return 0
    if t.startswith(q):
        return 1
    if any(w.startswith(q) for w in t.split()):
        return 2
    if q in t:
        return 3
    hay = " ".join((t, *fields)).lower()
    return 4 if all(w in hay for w in q.split()) else None


def first_line(text: str, q: str) -> str:
    """The first line of text containing q (or any word of q), trimmed for a one-line subtitle."""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    for needle in (q, *q.split()):
        for ln in lines:
            if needle in ln.lower():
                return ln[:120]
    return ""


def _task_subtitle(t: dict, q: str, r: int) -> str:
    if r == 4:
        texts = [t["notes"], *(i["text"] for i in t["checklist"])]
        hit = next((line for line in (first_line(x, q) for x in texts) if line), "")
        if hit:
            return hit
    bits = [t["status"].replace("todo", "to do").replace("doing", "in progress")]
    if t.get("due"):
        bits.append(f"due {t['due']}")
    bits += [f"#{x}" for x in t["tags"]]
    return " · ".join(bits)


def search(query: str, limit: int = LIMIT) -> list[dict]:
    q = query.strip().lower()
    if not q:
        return []
    data = router.store._load()  # one read for tasks and notes
    found = []  # (sort key, result)
    for t in data["tasks"]:
        r = rank(q, t["title"], t["notes"], " ".join(t["tags"]), *(i["text"] for i in t["checklist"]))
        if r is None:
            continue
        done = t["status"] == "done"
        found.append(((done, r, -(t.get("updated_at") or 0)), {
            "title": t["title"], "subtitle": _task_subtitle(t, q, r),
            "icon": STATUS_ICON.get(t["status"], "⬜"), "ref": f"task:{t['id']}"}))
    for day, text in data["notes"].items():
        r = rank(q, day, text)
        if r is None or not text.strip():
            continue
        found.append(((False, r, -int(day.replace("-", ""))), {
            "title": f"Daily note · {day}", "subtitle": first_line(text, q) or text.strip().splitlines()[0][:120],
            "icon": "🗒️", "ref": f"note:{day}"}))
    found.sort(key=lambda x: x[0])
    return [res for _, res in found[:limit]]
