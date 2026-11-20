"""Parsing the two scripts' output into per-id results, plus human hints for common failures.

Step 1 prints, per id (in order):
    Processing assessment_id: <id>
    Status code on uploading <id>: <code>
    Successfully uploaded: <json_uuid>.json for assessment_id: <id>
  or  ⚠️ No entry found for assessment_id: <id>
  or  Failed to get uploadUrl for assessment_id: <id>
  or  Error processing <id>: <message>
An exception outside the per-id try (e.g. the prod Mongo lookup timing out) ends the script with a traceback.

Step 2's results are read from the CSV it writes (--output), not from the printed table.
"""

from __future__ import annotations

import csv
import re
from pathlib import Path

_ID = r"([0-9A-Za-z][0-9A-Za-z_-]*)"
RE_PROCESSING = re.compile(rf"^Processing assessment_id: {_ID}\s*$")
RE_STATUS = re.compile(rf"^Status code on uploading {_ID}: (\d+)\s*$")
RE_SUCCESS = re.compile(rf"^Successfully uploaded: {_ID}\.json for assessment_id: {_ID}\s*$")
RE_NOT_FOUND = re.compile(rf"No entry found for assessment_id: {_ID}\s*$")
RE_NO_URL = re.compile(rf"^Failed to get uploadUrl for assessment_id: {_ID}\s*$")
RE_ERROR = re.compile(rf"^Error processing {_ID}: (.*)$")
RE_ERRORISH = re.compile(r"(Error|Exception|error:|Errno|❌|⚠️|timed out|not known|denied|refused)", re.I)

MAX_ERR = 300

PROD_VPN = "Prod not reachable — connect the PROD VPN"
STAGING_VPN = "Staging DB not reachable — connect the STAGING VPN"
AWS = "AWS credentials problem (check the repo .env)"
NOT_IN_PROD = "not found in prod"
NO_UPLOAD_URL = "staging did not return an upload URL (check the staging API / device)"
NO_DEPS = "the configured Python lacks the scripts' packages — set ⚙ Settings → Python interpreter"
NO_SCRIPT = "script not found — check the repo folder and script names in ⚙ Settings"
NO_ENV = "a setting is missing in the repo .env"
UPLOADED_NO_ID = "uploaded (HTTP 200) but the json id was not printed (job stopped)"
CHECK_STAGING = "the upload happened — check staging before re-syncing (a re-sync uploads a duplicate)"

_NET = ("serverselectiontimeouterror", "timed out", "name or service not known", "temporary failure in name resolution",
        "no route to host", "network is unreachable", "connection refused", "autoreconnect", "networktimeout")
_AWS = ("nocredentialserror", "unable to locate credentials", "partialcredentialserror", "invalidaccesskeyid",
        "signaturedoesnotmatch", "expiredtoken", "the aws access key id", "security token included in the request is invalid",
        "accessdenied", "(403) when calling", "clienterror", "botocore", "boto3")


def _clip(text: str) -> str:
    text = (text or "").strip()
    return text if len(text) <= MAX_ERR else text[: MAX_ERR - 1] + "…"


def hint(text: str, env: str = "prod") -> str:
    """A short, actionable hint for an error text ('' if nothing specific)."""
    t = (text or "").lower()
    if not t:
        return ""
    if "no entry found" in t:
        return NOT_IN_PROD
    if "no module named" in t or "modulenotfounderror" in t:
        return NO_DEPS
    if "can't open file" in t and ".py" in t:
        return NO_SCRIPT
    if "is not set in .env" in t:
        return NO_ENV
    if any(k in t for k in _AWS):
        return AWS
    if env == "staging" and ("staging vpn" in t or "failed to connect to staging mongodb" in t):
        return STAGING_VPN
    if any(k in t for k in _NET):
        return PROD_VPN if env == "prod" else STAGING_VPN
    if "failed to get uploadurl" in t:
        return NO_UPLOAD_URL
    return ""


def clean_lines(lines: list[str]) -> list[str]:
    out = []
    for line in lines:
        line = line.rsplit("\r", 1)[-1].rstrip()
        out.append(line)
    return out


def last_error_line(lines: list[str]) -> str:
    """The most telling line of a failed run: the last error-looking line, else the last non-empty one."""
    lines = [l for l in clean_lines(lines) if l.strip() and not l.startswith("Traceback (most recent")]
    for line in reversed(lines):
        if RE_ERRORISH.search(line):
            return _clip(line)
    return _clip(lines[-1]) if lines else ""


def parse_sync(lines: list[str], ids: list[str], *, done: bool) -> dict:
    """-> {"items": {prod_id: {sync_state, json_id?, sync_error, sync_hint, sync_uploaded}},
           "orphan": [lines before any id], "complete": every id has its result line}.

    Ids never mentioned are absent (stay pending). An id that was processed without a success line is failed
    once the job is done or a later id started (the script is sequential)."""
    blocks: dict[str, dict] = {}
    order: list[str] = []
    current: str | None = None
    orphan: list[str] = []
    wanted = set(ids)

    def block(i: str) -> dict:
        if i not in blocks:
            blocks[i] = {"result": None, "json_id": None, "error": "", "code": None, "other": []}
            order.append(i)
        return blocks[i]

    for line in clean_lines(lines):
        if not line.strip():
            continue
        if m := RE_PROCESSING.match(line):
            current = m.group(1)
            block(current)
            continue
        if m := RE_SUCCESS.match(line):
            b = block(m.group(2))
            b["result"], b["json_id"], b["error"] = "synced", m.group(1), ""
            continue
        if m := RE_STATUS.match(line):
            block(m.group(1))["code"] = int(m.group(2))
            continue
        if m := RE_NOT_FOUND.search(line):
            b = block(m.group(1))
            b["result"], b["error"] = "not_found", f"No entry found for assessment_id: {m.group(1)}"
            continue
        if m := RE_NO_URL.match(line):
            b = block(m.group(1))
            b["result"], b["error"] = "failed", line.strip()
            continue
        if m := RE_ERROR.match(line):
            b = block(m.group(1))
            if b["result"] != "synced":
                b["result"], b["error"] = "failed", _clip(m.group(2)) or line.strip()
            continue
        if current is None:
            orphan.append(line)
        else:
            blocks[current]["other"].append(line)

    items: dict[str, dict] = {}
    for idx, i in enumerate(order):
        if i not in wanted:
            continue
        b = blocks[i]
        finished = done or idx < len(order) - 1
        if b["result"] == "synced":
            items[i] = {"sync_state": "synced", "json_id": b["json_id"], "sync_error": "", "sync_hint": ""}
        elif b["result"] == "not_found":
            items[i] = {"sync_state": "not_found", "sync_error": b["error"], "sync_hint": NOT_IN_PROD}
        elif b["result"] == "failed":
            err = b["error"]
            extra = last_error_line(b["other"])
            items[i] = {"sync_state": "failed", "sync_error": err,
                        "sync_hint": hint(err) or hint(extra) or hint(" ".join(b["other"]))}
        elif finished and b["code"] == 200:
            # the upload went through but the script stopped before printing the json id: re-syncing would
            # create a duplicate in staging, so say so and flag it (the UI leaves it out of "Re-sync")
            items[i] = {"sync_state": "failed", "sync_error": UPLOADED_NO_ID, "sync_hint": CHECK_STAGING,
                        "sync_uploaded": True}
        elif finished:
            if b["other"]:
                err = last_error_line(b["other"])
            elif b["code"] is not None:
                err = f"upload returned HTTP {b['code']}"
            else:
                err = "no result in the script output (job stopped)"
            if b["code"] is not None and b["other"]:
                err = f"upload returned HTTP {b['code']}; {err}"
            items[i] = {"sync_state": "failed", "sync_error": _clip(err),
                        "sync_hint": hint(err) or hint(" ".join(b["other"]))}
        else:
            items[i] = {"sync_state": "pending", "sync_error": "", "sync_hint": "", "active": True}
        items[i].setdefault("sync_uploaded", False)
    # every requested id got its result line (synced / not found / failed): the script ran to its end
    complete = bool(ids) and all(i in blocks and blocks[i]["result"] is not None for i in ids)
    return {"items": items, "orphan": orphan, "complete": complete}


# ---- step 2 ---------------------------------------------------------------------------------------
def _na(value) -> str:
    v = str(value if value is not None else "").strip()
    if v.upper() in ("N/A", "NAN", "NONE", "NAT"):
        return ""
    if re.fullmatch(r"-?\d+\.0", v):  # pandas writes an int column with gaps as floats
        v = v[:-2]
    return v


def classify_assessment(value: str) -> str:
    v = (value or "").strip()
    if not v or "not found" in v.lower():
        return "not_found"
    if "processing" in v.lower() or "no id yet" in v.lower():
        return "processing"
    return "found"


def parse_lookup_csv(path: Path) -> dict[str, dict]:
    """json_id -> {lookup_state, staging_id, otp, status, created_date}."""
    out: dict[str, dict] = {}
    with path.open(newline="", encoding="utf-8-sig", errors="replace") as f:
        for row in csv.DictReader(f):
            jid = (row.get("json_id") or "").strip()
            if jid.lower().endswith(".json"):
                jid = jid[:-5]
            if not jid:
                continue
            raw = (row.get("assessment_id") or "").strip()
            state = classify_assessment(raw)
            out[jid] = {
                "lookup_state": state,
                "staging_id": raw if state == "found" else "",
                "otp": _na(row.get("otp")),
                "status": _na(row.get("status")),
                "created_date": _na(row.get("created_date")),
                "lookup_error": "",
                "lookup_hint": "retry in a minute — staging has not created the assessment yet"
                if state == "processing" else ("not in staging (yet?)" if state == "not_found" else ""),
            }
    return out


def lookup_failure(lines: list[str]) -> tuple[str, str]:
    """(error, hint) for a lookup run that produced no CSV."""
    text = "\n".join(clean_lines(lines))
    low = text.lower()
    if "connection timed out" in low or "staging vpn" in low:
        return STAGING_VPN, STAGING_VPN
    err = last_error_line(lines) or "the lookup script wrote no CSV"
    return err, hint(err, "staging") or hint(text, "staging")
