"""YAML ⇄ JSON endpoints for the YAML tool.

Everything stays on this machine: the browser posts the text to this app's own server, PyYAML converts it and
nothing is stored or logged. Only the *safe* loader/dumper is used (yaml.safe_load / safe_load_all / safe_dump),
so YAML tags can never construct Python objects. Two extra guards:

* input size is capped (MAX_BYTES → 413), and
* alias bombs ("billion laughs": `a: &a [x, x]`, `b: &b [*a, *a]`, …) are refused before anything is built:
  the document is composed first (aliases stay shared node references), its *expanded* size is counted with
  memoisation, and documents that would expand past MAX_EXPANDED_NODES — or refer to themselves — are rejected.
"""

from __future__ import annotations

import base64
import datetime as dt
import json
import math
from typing import Any

import yaml
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter()

MAX_BYTES = 2 * 1024 * 1024
MAX_EXPANDED_NODES = 1_000_000
MAX_DOCUMENTS = 10_000


class ToJson(BaseModel):
    text: str
    multi: bool = False
    indent: int = Field(2, ge=0, le=8)
    sort_keys: bool = False


class FromJson(BaseModel):
    text: str
    indent: int = Field(2, ge=2, le=8)
    sort_keys: bool = False
    flow: bool = False
    multi: bool = False  # a top-level JSON array becomes one YAML document per item


class _Refused(Exception):
    def __init__(self, message: str, mark: Any = None):
        super().__init__(message)
        self.mark = mark


def _check_size(text: str) -> None:
    if len(text) > MAX_BYTES or len(text.encode("utf-8", "surrogatepass")) > MAX_BYTES:
        raise HTTPException(413, f"Input is larger than {MAX_BYTES // (1024 * 1024)} MB.")


def _error(message: str, mark: Any = None) -> dict:
    line = getattr(mark, "line", None)
    col = getattr(mark, "column", None)
    return {"ok": False, "error": {"message": message,
                                   "line": line + 1 if line is not None else None,
                                   "column": col + 1 if col is not None else None}}


def _children(node: yaml.Node) -> list:
    if isinstance(node, yaml.SequenceNode):
        return node.value
    if isinstance(node, yaml.MappingNode):
        return [n for pair in node.value for n in pair]
    return []


def expanded_size(root: yaml.Node, limit: int = MAX_EXPANDED_NODES) -> int:
    """Number of nodes the document has once every alias is expanded (capped at limit + 1).

    Iterative (no recursion limit) and memoised per node object, so a bomb is measured without being expanded.
    Raises _Refused for self-referencing documents (`&a [*a]`), which cannot be represented as JSON.
    """
    memo: dict[int, int] = {}
    active: set[int] = set()
    stack: list[tuple[yaml.Node, bool]] = [(root, False)]
    while stack:
        node, done = stack.pop()
        nid = id(node)
        if done:
            active.discard(nid)
            memo[nid] = min(limit + 1, 1 + sum(memo[id(c)] for c in _children(node)))
            continue
        if nid in memo:
            continue
        if nid in active:
            raise _Refused("The document refers to itself through an alias (recursive structure); JSON cannot represent it.",
                           node.start_mark)
        active.add(nid)
        stack.append((node, True))
        stack.extend((c, False) for c in _children(node) if id(c) not in memo)
    return memo[id(root)]


def _guard(text: str) -> int:
    """Composes every document (no objects are built) and refuses alias bombs. Returns the document count."""
    count = 0
    # pure-Python loader on purpose: libyaml's composer recurses in C and can crash on very deep nesting
    for node in yaml.compose_all(text, Loader=yaml.SafeLoader):
        count += 1
        if count > MAX_DOCUMENTS:
            raise _Refused(f"More than {MAX_DOCUMENTS:,} documents.")
        if node is not None and expanded_size(node) > MAX_EXPANDED_NODES:
            raise _Refused(f"Refused: aliases would expand this document to more than {MAX_EXPANDED_NODES:,} values "
                           "(an alias bomb / “billion laughs”).", node.start_mark)
    return count


def _text(s: str, notes: list[str]) -> str:
    """Lone surrogates ("\\ud800" in a double-quoted YAML string) cannot be sent as UTF-8; replace them."""
    if s.isascii():
        return s
    try:
        s.encode("utf-8")
        return s
    except UnicodeEncodeError:
        if "lone surrogates became U+FFFD" not in notes:
            notes.append("lone surrogates became U+FFFD")
        return "".join("\ufffd" if 0xD800 <= ord(ch) <= 0xDFFF else ch for ch in s)


def _key(k: Any, notes: list[str]) -> str:
    if isinstance(k, str):
        return _text(k, notes)
    if k is None:
        return "null"
    if isinstance(k, bool):
        return "true" if k else "false"
    return str(_jsonable(k, notes))


def _jsonable(value: Any, notes: list[str]) -> Any:
    """Converts what yaml.safe_load can produce into JSON-compatible values, noting lossy conversions."""
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            key = _key(k, notes)
            if not isinstance(k, str) and "non-string keys were converted to strings" not in notes:
                notes.append("non-string keys were converted to strings")
            out[key] = _jsonable(v, notes)
        return out
    if isinstance(value, (list, tuple)):
        return [_jsonable(v, notes) for v in value]
    if isinstance(value, set):
        if "!!set values became arrays" not in notes:
            notes.append("!!set values became arrays")
        return [_jsonable(v, notes) for v in sorted(value, key=repr)]
    if isinstance(value, (dt.datetime, dt.date)):
        if "dates/timestamps became ISO strings" not in notes:
            notes.append("dates/timestamps became ISO strings")
        return value.isoformat()
    if isinstance(value, bytes):
        if "!!binary values became base64 strings" not in notes:
            notes.append("!!binary values became base64 strings")
        return base64.b64encode(value).decode("ascii")
    if isinstance(value, str):
        return _text(value, notes)
    if isinstance(value, float) and not math.isfinite(value):
        if ".inf/.nan became strings" not in notes:
            notes.append(".inf/.nan became strings")
        return ".nan" if math.isnan(value) else (".inf" if value > 0 else "-.inf")
    return value


@router.post("/yaml/to-json")
def yaml_to_json(body: ToJson) -> dict:
    _check_size(body.text)
    try:
        _guard(body.text)
        if body.multi:
            docs = list(yaml.safe_load_all(body.text))
        else:
            docs = [yaml.safe_load(body.text)]
    except _Refused as e:
        return _error(str(e), e.mark)
    except yaml.MarkedYAMLError as e:
        parts = [p for p in (e.context, e.problem) if p]
        return _error("; ".join(parts) or str(e), e.problem_mark or e.context_mark)
    except yaml.YAMLError as e:
        return _error(str(e))
    except RecursionError:
        return _error("The document is nested too deeply.")
    notes: list[str] = []
    try:
        converted = [_jsonable(d, notes) for d in docs]
        payload = converted if body.multi else converted[0]
        text = json.dumps(payload, ensure_ascii=False, sort_keys=body.sort_keys,
                          indent=body.indent if body.indent else None,
                          separators=None if body.indent else (",", ":"))
    except RecursionError:
        return _error("The document is nested too deeply.")
    except (TypeError, ValueError) as e:
        return _error(f"Cannot be represented as JSON: {e}")
    result: dict[str, Any] = {"ok": True, "json": text, "notes": notes, "count": len(converted)}
    result["documents" if body.multi else "data"] = payload
    return result


@router.post("/yaml/from-json")
def json_to_yaml(body: FromJson) -> dict:
    _check_size(body.text)
    try:
        data = json.loads(body.text)
    except json.JSONDecodeError as e:
        return {"ok": False, "error": {"message": e.msg, "line": e.lineno, "column": e.colno}}
    except RecursionError:
        return _error("The JSON is nested too deeply.")
    opts = dict(allow_unicode=True, default_flow_style=body.flow, sort_keys=body.sort_keys,
                indent=body.indent, width=4096)
    try:
        if body.multi and isinstance(data, list):
            text = yaml.safe_dump_all(data, explicit_start=True, **opts)
        else:
            text = yaml.safe_dump(data, **opts)
    except RecursionError:
        return _error("The JSON is nested too deeply.")
    except yaml.YAMLError as e:
        return _error(str(e))
    return {"ok": True, "yaml": text}
