"""Id parsing for pasted text: any separators, strict validation, order-preserving dedupe.

Every id ends up on a command line, so only plain UUID-ish tokens pass: letters, digits, '_' and '-'
(8-64 chars, starting with a letter or digit, at least one digit). Anything else is reported, never used.
"""

from __future__ import annotations

import re

ID_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z_-]{7,63}$")
# separators: whitespace, commas, quotes (pasted lists / CSV columns); everything else stays in the token
_SPLIT_RE = re.compile(r"[\s,'\"`]+")
_EDGE = "[](){}<>"
MAX_IDS = 500


def valid_id(value: str) -> bool:
    return bool(ID_RE.match(value)) and any(c.isdigit() for c in value)


def parse_ids(text: str, *, json_ids: bool = False) -> dict:
    """-> {"ids": [...], "rejected": [...], "duplicates": n}. json_ids: a trailing .json is accepted and stripped."""
    ids: list[str] = []
    seen: set[str] = set()
    rejected: list[str] = []
    duplicates = 0
    for raw in _SPLIT_RE.split(text or ""):
        token = raw.strip(_EDGE)
        if not token:
            continue
        value = token[:-5] if json_ids and token.lower().endswith(".json") else token
        if not valid_id(value):
            if raw not in rejected:
                rejected.append(raw[:80])
            continue
        if value in seen:
            duplicates += 1
            continue
        seen.add(value)
        ids.append(value)
    return {"ids": ids, "rejected": rejected[:50], "rejected_count": len(rejected), "duplicates": duplicates}
