"""Optional login for remote access (e.g. a phone over Tailscale); loopback requests never need it.

The password is stored as an scrypt hash in data/auth/password.json. Sessions live in memory only, so a
server restart logs everyone out, and changing or removing the password invalidates existing sessions.

CLI:  python3 -m app.core.auth set-password | status | disable
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import hmac
import json
import math
import os
import secrets
import sys
import threading
import time
from collections import deque
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from . import audit, config
from .platform import O_BINARY, chmod_private

COOKIE = "eu_session"
MIN_PASSWORD_LEN = 10
LOCAL_HOSTS = frozenset({"127.0.0.1", "localhost", "::1", "testserver"})
SCRYPT = {"n": 2 ** 14, "r": 8, "p": 1}
MAX_FAILURES, FAILURE_WINDOW = 5, 600
# second line of defence when the client key (X-Forwarded-For) is spoofable: cap failures across all clients
MAX_GLOBAL_FAILURES = 50
SET_PASSWORD_HINT = "remote access needs a password: run: python3 -m app.core.auth set-password"

_lock = threading.Lock()
_sessions: dict[str, tuple[float, str]] = {}  # sha256(token) -> (expires at, salt of the password it was issued for)
_failures: dict[str, deque[float]] = {}


# ---- password ------------------------------------------------------------------------------------------
def _password_path() -> Path:
    return config.DATA_DIR / "auth" / "password.json"


def _hash(password: str, salt: bytes, n: int, r: int, p: int) -> bytes:
    return hashlib.scrypt(password.encode(), salt=salt, n=n, r=r, p=p, dklen=32)


def load_password() -> dict | None:
    try:
        return json.loads(_password_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def password_set() -> bool:
    return load_password() is not None


def set_password(password: str) -> None:
    if len(password) < MIN_PASSWORD_LEN:
        raise ValueError(f"password must be at least {MIN_PASSWORD_LEN} characters")
    salt = secrets.token_bytes(16)
    data = {"algo": "scrypt", **SCRYPT, "salt": salt.hex(), "hash": _hash(password, salt, **SCRYPT).hex()}
    path = _password_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    chmod_private(path.parent, 0o700)
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | O_BINARY, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f)
    chmod_private(tmp, 0o600)
    os.replace(tmp, path)


def clear_password() -> bool:
    try:
        _password_path().unlink()
        return True
    except FileNotFoundError:
        return False


def check_password(password: str) -> bool:
    stored = load_password()
    if not stored:
        return False
    try:
        digest = _hash(password, bytes.fromhex(stored["salt"]), stored["n"], stored["r"], stored["p"])
        return hmac.compare_digest(digest, bytes.fromhex(stored["hash"]))
    except (KeyError, ValueError, TypeError):
        return False


# ---- sessions ------------------------------------------------------------------------------------------
def _token_key(token: str) -> str:
    # dict lookups aren't constant-time; looking up a hash of the token leaks nothing useful about it
    return hashlib.sha256(token.encode()).hexdigest()


def create_session() -> str:
    token = secrets.token_urlsafe(32)
    salt = (load_password() or {}).get("salt", "")
    with _lock:
        _sessions[_token_key(token)] = (time.time() + config.SESSION_HOURS * 3600, salt)
    return token


def valid_session(token: str | None) -> bool:
    if not token:
        return False
    stored = load_password()
    now = time.time()
    with _lock:
        for k in [k for k, (exp, _) in _sessions.items() if exp <= now]:
            del _sessions[k]
        entry = _sessions.get(_token_key(token))
    return bool(entry and stored and hmac.compare_digest(entry[1], stored.get("salt", "")))


def drop_session(token: str | None) -> None:
    if token:
        with _lock:
            _sessions.pop(_token_key(token), None)


# ---- request helpers -----------------------------------------------------------------------------------
def hostname(host_header: str) -> str:
    """'Box.ts.net:443' -> 'box.ts.net', '[::1]:8765' -> '::1'."""
    host = host_header.strip().lower()
    if host.startswith("["):
        return host[1:host.find("]")] if "]" in host else host
    return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


def is_remote(request: Request) -> bool:
    headers = request.headers
    if hostname(headers.get("host", "")) not in LOCAL_HOSTS:
        return True
    # with remote access on, forwarded headers mean the proxy is in front even if it rewrote Host to 127.0.0.1;
    # with it off, local proxy setups keep working exactly as before
    return bool(config.REMOTE_HOSTS) and ("x-forwarded-for" in headers or "x-forwarded-host" in headers)


def is_authenticated(request: Request) -> bool:
    return not is_remote(request) or valid_session(request.cookies.get(COOKIE))


def client_key(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    return forwarded or (request.client.host if request.client else "unknown")


def _is_https(request: Request) -> bool:
    return request.url.scheme == "https" or request.headers.get("x-forwarded-proto", "").lower() == "https"


# ---- rate limit ----------------------------------------------------------------------------------------
def _reserve_attempt(key: str) -> int:
    """Count an attempt against the limits up front, so parallel guesses can't all slip past the check.

    Returns seconds until another attempt is allowed (nothing reserved), or 0 when the attempt may proceed."""
    now = time.time()
    cutoff = now - FAILURE_WINDOW
    with _lock:
        for k in list(_failures):
            q = _failures[k]
            while q and q[0] <= cutoff:
                q.popleft()
            if not q:
                del _failures[k]
        mine = _failures.get(key, ())
        waits = []
        if len(mine) >= MAX_FAILURES:
            waits.append(mine[-MAX_FAILURES] - cutoff)
        everyone = sorted(t for q in _failures.values() for t in q)
        if len(everyone) >= MAX_GLOBAL_FAILURES:
            waits.append(everyone[-MAX_GLOBAL_FAILURES] - cutoff)
        if waits:
            return max(1, math.ceil(max(waits)))
        _failures.setdefault(key, deque()).append(now)
    return 0


def reset_state() -> None:
    """Forget sessions and failures (tests)."""
    with _lock:
        _sessions.clear()
        _failures.clear()


# ---- API -----------------------------------------------------------------------------------------------
router = APIRouter(prefix="/api/auth")


@router.get("/status")
def status(request: Request):
    return {"remote": is_remote(request), "authenticated": is_authenticated(request), "password_set": password_set()}


@router.post("/login")
async def login(request: Request):
    # exempt from the CSRF header; a JSON content type can't be sent cross-site without a preflight instead
    if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
        raise HTTPException(415, "expected application/json")
    origin = request.headers.get("origin")
    if origin and hostname(urlsplit(origin).netloc) != hostname(request.headers.get("host", "")):
        raise HTTPException(403, "cross-origin login refused")
    key = client_key(request)
    wait = _reserve_attempt(key)
    if wait:
        audit.record("auth", "login", key, status="rate-limited")
        return JSONResponse({"detail": f"too many failed attempts, try again in {wait} s"}, status_code=429,
                            headers={"Retry-After": str(wait)})
    try:
        password = (await request.json()).get("password", "")
    except (ValueError, AttributeError):
        raise HTTPException(400, "invalid JSON body") from None
    # scrypt is slow on purpose; keep it off the event loop so the local user's streams stay live
    if not isinstance(password, str) or not await run_in_threadpool(check_password, password):
        audit.record("auth", "login", key, status="failed")
        raise HTTPException(401, "wrong password")
    with _lock:
        _failures.pop(key, None)
    audit.record("auth", "login", key, status="ok")
    response = JSONResponse({"ok": True})
    response.set_cookie(COOKIE, create_session(), max_age=int(config.SESSION_HOURS * 3600), path="/",
                        httponly=True, samesite="strict", secure=_is_https(request))
    return response


@router.post("/logout")
def logout(request: Request):
    drop_session(request.cookies.get(COOKIE))
    audit.record("auth", "logout", client_key(request))
    response = JSONResponse({"ok": True})
    response.delete_cookie(COOKIE, path="/", httponly=True, samesite="strict", secure=_is_https(request))
    return response


# ---- CLI -----------------------------------------------------------------------------------------------
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m app.core.auth", description="Remote-access password.")
    parser.add_argument("command", choices=["set-password", "status", "disable"])
    cmd = parser.parse_args(argv).command
    if cmd == "set-password":
        first = getpass.getpass(f"New password (min {MIN_PASSWORD_LEN} chars): ")
        if first != getpass.getpass("Repeat: "):
            print("Passwords don't match.", file=sys.stderr)
            return 1
        try:
            set_password(first)
        except ValueError as e:
            print(e, file=sys.stderr)
            return 1
        audit.record("auth", "set-password", "cli")
        print(f"Password saved to {_password_path()}. Existing sessions are logged out.")
    elif cmd == "disable":
        removed = clear_password()
        if removed:
            audit.record("auth", "disable", "cli")
        print("Password removed: remote access is refused." if removed else "No password was set.")
    else:
        hosts = ", ".join(config.REMOTE_HOSTS) or "none (EU_REMOTE_HOSTS not set)"
        print(f"Password: {'set' if password_set() else 'not set'} ({_password_path()})\nRemote hosts: {hosts}\n"
              f"Session length: {config.SESSION_HOURS:g} h")
    return 0


if __name__ == "__main__":
    sys.exit(main())
