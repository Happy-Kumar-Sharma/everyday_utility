"""Server-side request sender for the 📡 API tester tool.

Browsers refuse most cross-origin calls, so the API tester asks this endpoint to send the request instead.
It lives under /api/devtools like every other service route, so it inherits the app's CSRF header check and,
when remote access is on, the login requirement (see app/main.py) — there is no unauthenticated path.

Privacy: request/response headers and bodies are never logged. The audit log gets the method, the target as
scheme://host[:port]/path (no user info, no query string, no fragment) and the status code only.
"""

from __future__ import annotations

import base64
import binascii
import logging
import re
import time
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.core import audit

router = APIRouter()

# httpx logs every request URL (with its query string) at INFO and httpcore logs headers at DEBUG: keep them quiet
for _name in ("httpx", "httpcore"):
    logging.getLogger(_name).setLevel(max(logging.getLogger(_name).level, logging.WARNING))

MAX_RESPONSE_BYTES = 5 * 1024 * 1024  # response bodies are cut here (streamed, then the connection is dropped)
MAX_REQUEST_BYTES = 10 * 1024 * 1024
MAX_REDIRECTS = 10
_METHOD = re.compile(r"^[A-Z][A-Z0-9_-]{0,19}$")
_HEADER_NAME = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
# headers httpx computes itself; a stale hand-typed value would only break the request
_DROP_HEADERS = {"content-length", "transfer-encoding", "connection"}


class SendReq(BaseModel):
    method: str = "GET"
    url: str
    headers: list[list[str]] = Field(default_factory=list)
    body: str | None = None
    body_base64: str | None = None
    timeout_s: float = Field(30, ge=1, le=120)
    follow_redirects: bool = True
    verify_tls: bool = True


def audit_target(url: str) -> str:
    """scheme://host[:port]/path — never the user info, query string or fragment."""
    try:
        p = urlsplit(url)
        host = p.hostname or ""
        if ":" in host:
            host = f"[{host}]"
        port = f":{p.port}" if p.port else ""
    except ValueError:
        return "(invalid url)"
    return f"{p.scheme}://{host}{port}{p.path}"


def _check(req: SendReq) -> tuple[str, list[tuple[str, str]], bytes | None]:
    method = req.method.strip().upper()
    if not _METHOD.match(method):
        raise HTTPException(400, f"invalid HTTP method: {req.method[:30]!r}")
    url = req.url.strip()
    try:
        parts = urlsplit(url)
        parts.port  # noqa: B018 - raises ValueError on a bad port
    except ValueError as e:
        raise HTTPException(400, f"invalid URL: {e}") from e
    if parts.scheme.lower() not in ("http", "https"):
        raise HTTPException(400, "only http:// and https:// URLs can be sent")
    if not parts.hostname:
        raise HTTPException(400, "the URL has no host")
    headers: list[tuple[str, str]] = []
    for pair in req.headers:
        if len(pair) != 2:
            raise HTTPException(400, "headers must be [name, value] pairs")
        name, value = pair[0].strip(), pair[1]
        if not name:
            continue
        if not _HEADER_NAME.match(name):
            raise HTTPException(400, f"invalid header name: {name[:60]!r}")
        if any(c in value for c in "\r\n\0"):
            raise HTTPException(400, f"header {name} contains a line break")
        if name.lower() not in _DROP_HEADERS:
            headers.append((name, value))
    content: bytes | None = None
    if req.body_base64 is not None:
        try:
            content = base64.b64decode(req.body_base64, validate=True)
        except (binascii.Error, ValueError) as e:
            raise HTTPException(400, "body_base64 is not valid base64") from e
    elif req.body is not None:
        content = req.body.encode("utf-8")
    if content is not None and len(content) > MAX_REQUEST_BYTES:
        raise HTTPException(413, f"request body is larger than {MAX_REQUEST_BYTES // (1024 * 1024)} MB")
    return method, headers, content


def _error_message(e: Exception, timeout: float) -> str:
    text = str(e) or type(e).__name__
    if isinstance(e, httpx.TimeoutException):
        kind = {httpx.ConnectTimeout: "connecting", httpx.ReadTimeout: "waiting for the response",
                httpx.WriteTimeout: "sending the request", httpx.PoolTimeout: "waiting for a connection"}
        return f"Timed out after {timeout:g} s while {kind.get(type(e), 'sending the request')}"
    if isinstance(e, httpx.TooManyRedirects):
        return f"Too many redirects (more than {MAX_REDIRECTS})"
    low = text.lower()
    if "certificate" in low or "ssl" in low or "tls" in low:
        return f"TLS error: {text} (untick “Verify TLS” to accept self-signed certificates)"
    if isinstance(e, httpx.ConnectError):
        if any(s in low for s in ("name or service not known", "nodename nor servname", "getaddrinfo",
                                  "no address associated", "temporary failure in name resolution")):
            return f"DNS lookup failed: {text}"
        if "refused" in low:
            return f"Connection refused: {text}"
        return f"Could not connect: {text}"
    if isinstance(e, httpx.RemoteProtocolError):
        return f"The server sent an invalid response: {text}"
    return f"Request failed: {text}"


def _decode_text(data: bytes, truncated: bool) -> str | None:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        if truncated:  # the cut may have split a multi-byte character
            for cut in (1, 2, 3):
                try:
                    return data[:-cut].decode("utf-8")
                except UnicodeDecodeError:
                    continue
        return None


@router.post("/api/send")
def send(req: SendReq):
    method, headers, content = _check(req)
    url = req.url.strip()
    target = audit_target(url)
    started = time.perf_counter()
    try:
        with httpx.Client(verify=req.verify_tls, timeout=req.timeout_s, follow_redirects=req.follow_redirects,
                          max_redirects=MAX_REDIRECTS) as client:
            request = client.build_request(method, url, headers=headers, content=content)
            resp = client.send(request, stream=True)
            try:
                chunks, size, truncated = [], 0, False
                for chunk in resp.iter_bytes():
                    room = MAX_RESPONSE_BYTES - size
                    if len(chunk) > room:
                        chunks.append(chunk[:room])
                        size += room
                        truncated = True
                        break
                    chunks.append(chunk)
                    size += len(chunk)
                data = b"".join(chunks)
                result = {
                    "status": resp.status_code,
                    "reason": resp.reason_phrase,
                    "http_version": resp.http_version,
                    "headers": [[k.decode("latin-1"), v.decode("latin-1")] for k, v in resp.headers.raw],  # as sent (case kept)
                    # every URL the redirects led to, ending with the final one
                    "redirects": [str(r.url) for r in resp.history[1:]] + [str(resp.url)] if resp.history else [],
                    "url": str(resp.url),
                }
            finally:
                resp.close()
    except (httpx.InvalidURL, httpx.LocalProtocolError, UnicodeError) as e:
        raise HTTPException(400, f"Invalid request: {e}") from None
    except (httpx.HTTPError, OSError, ValueError) as e:
        audit.record("http", method, target=target, status="error")
        raise HTTPException(502, _error_message(e, req.timeout_s)) from None
    text = _decode_text(data, truncated)
    result.update({
        "body_text": text,
        "body_base64": None if text is not None else base64.b64encode(data).decode("ascii"),
        "size": size,
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 1),
        "truncated": truncated,
    })
    audit.record("http", method, target=target, status=str(result["status"]))
    return result
