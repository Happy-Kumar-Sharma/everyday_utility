"""Parsing and persisting the list of image ids a pipeline run works on."""

from __future__ import annotations

import re
import shutil
import time
from pathlib import Path

_SPLIT = re.compile(r"[\s,;()\[\]'\"]+")


def parse_ids(values: list[str] | str) -> dict:
    """Ints in first-seen order, plus what was dropped. Accepts raw text (any separators) or cell values."""
    tokens = _SPLIT.split(values) if isinstance(values, str) else [t for v in values for t in _SPLIT.split(str(v))]
    ids: list[int] = []
    invalid: list[str] = []
    for t in tokens:
        if not t:
            continue
        if t.isdigit():
            ids.append(int(t))
        elif re.fullmatch(r"\d+\.0+", t):  # 6838864.0 from a float-typed Excel column
            ids.append(int(t.split(".")[0]))
        else:
            invalid.append(t)
    unique = list(dict.fromkeys(ids))
    return {
        "ids": unique,
        "count": len(unique),
        "duplicates": len(ids) - len(unique),
        "invalid_count": len(invalid),
        "invalid_sample": invalid[:10],
    }


def read_ids_file(path: Path) -> list[int]:
    if not path.is_file():
        return []
    return parse_ids(path.read_text(encoding="utf-8"))["ids"]


def write_ids_file(path: Path, ids: list[int]) -> Path | None:
    """Write one id per line; the previous file is kept as <name>.<timestamp>.bak. Returns the backup path."""
    if not ids:
        raise ValueError("no ids to write")
    path.parent.mkdir(parents=True, exist_ok=True)
    backup = None
    if path.exists():
        backup = path.with_name(f"{path.name}.{time.strftime('%Y%m%d-%H%M%S')}.bak")
        shutil.copy2(path, backup)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text("\n".join(map(str, ids)) + "\n", encoding="utf-8")
    tmp.replace(path)
    return backup
