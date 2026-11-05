"""SSRF guard and guarded HTTP fetching for the Web Clipper.

Every request (the page, each redirect hop, every image) goes through a *policy*: a callable
``policy(host, port) -> list[str]`` that resolves the host and returns the IP addresses that may be
connected to, or raises :class:`BlockedURL`. The default, :func:`public_only`, refuses anything that is not a
public unicast address. The same policy is enforced twice:

* before the request, on the URL (clear error messages, redirects are followed manually), and
* at connect time, inside httpcore's network backend: the socket is opened to an address the policy
  just approved, so a DNS answer that changes between the check and the connection (rebinding) cannot
  slip a private address in.

Tests inject :func:`allow_all` as a parameter for their 127.0.0.1 fixture server; there is deliberately no
environment variable or setting that turns the guard off.
"""

from __future__ import annotations

import ipaddress
import socket
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpcore
import httpx


class BlockedURL(ValueError):
    """The URL may not be fetched (scheme, host name or resolved address)."""


class FetchError(RuntimeError):
    pass


class TooLarge(FetchError):
    pass


Policy = Callable[[str, int], list[str]]

_BLOCKED_NAMES = ("localhost",)
_BLOCKED_SUFFIXES = (".localhost", ".local", ".internal", ".localdomain", ".home.arpa")
_CGNAT = ipaddress.ip_network("100.64.0.0/10")
_EXTRA_V4 = [ipaddress.ip_network(n) for n in ("0.0.0.0/8", "192.0.0.0/24", "198.18.0.0/15", "240.0.0.0/4")]
_EXTRA_V6 = [ipaddress.ip_network(n) for n in ("fc00::/7", "fe80::/10", "fec0::/10", "64:ff9b:1::/48", "2001:db8::/32")]


def ip_blocked_reason(ip: str) -> str | None:
    """Why this address must not be contacted, or None when it is a public unicast address."""
    try:
        addr = ipaddress.ip_address(ip.split("%", 1)[0])
    except ValueError:
        return "not an IP address"
    if isinstance(addr, ipaddress.IPv6Address):
        for embedded in (addr.ipv4_mapped, addr.sixtofour):
            if embedded is not None:
                inner = ip_blocked_reason(str(embedded))
                if inner:
                    return f"{inner} (IPv4 inside IPv6)"
        if addr.teredo:
            return "teredo address"
        # IPv4-compatible (deprecated) ::a.b.c.d
        if int(addr) >> 32 == 0 and int(addr) > 1:
            inner = ip_blocked_reason(str(ipaddress.IPv4Address(int(addr) & 0xFFFFFFFF)))
            if inner:
                return f"{inner} (IPv4 inside IPv6)"
    checks = (
        ("loopback", addr.is_loopback),
        ("unspecified", addr.is_unspecified),
        ("link-local", addr.is_link_local),
        ("multicast", addr.is_multicast),
        ("private", addr.is_private),
        ("reserved", addr.is_reserved),
        ("site-local", isinstance(addr, ipaddress.IPv6Address) and addr.is_site_local),
        ("shared address space (CGNAT)", isinstance(addr, ipaddress.IPv4Address) and addr in _CGNAT),
    )
    for name, hit in checks:
        if hit:
            return name
    nets = _EXTRA_V4 if isinstance(addr, ipaddress.IPv4Address) else _EXTRA_V6
    if any(addr in n for n in nets):
        return "non-public range"
    if not addr.is_global:
        return "not a public address"
    return None


def _hostname_reason(host: str) -> str | None:
    h = host.lower().rstrip(".")
    if not h:
        return "empty host"
    if h in _BLOCKED_NAMES or h.endswith(_BLOCKED_SUFFIXES):
        return f"local host name '{host}'"
    if "." not in h and ":" not in h:
        # a single-label name ("intranet", "router") resolves via the local search domain
        try:
            ipaddress.ip_address(h)
        except ValueError:
            return f"single-label host name '{host}' (local network)"
    return None


def public_only(host: str, port: int) -> list[str]:
    """Default policy: resolve `host` and allow it only if EVERY resolved address is public."""
    reason = _hostname_reason(host)
    if reason:
        raise BlockedURL(f"refused: {reason}")
    h = host.strip("[]")
    try:
        literal = ipaddress.ip_address(h.split("%", 1)[0])
    except ValueError:
        literal = None
    if literal is not None:
        why = ip_blocked_reason(str(literal))
        if why:
            raise BlockedURL(f"refused: {h} is a {why} address")
        return [str(literal)]
    try:
        infos = socket.getaddrinfo(h, port, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError) as e:
        raise BlockedURL(f"cannot resolve {host}: {e}") from e
    addrs = []
    for info in infos:
        ip = info[4][0]
        why = ip_blocked_reason(ip)
        if why:
            raise BlockedURL(f"refused: {host} resolves to {ip} ({why})")
        if ip not in addrs:
            addrs.append(ip)
    if not addrs:
        raise BlockedURL(f"cannot resolve {host}")
    return addrs


def allow_all(host: str, port: int) -> list[str]:
    """Test-only policy (passed explicitly by tests for their 127.0.0.1 fixture server)."""
    h = host.strip("[]")
    try:
        ipaddress.ip_address(h)
        return [h]
    except ValueError:
        pass
    infos = socket.getaddrinfo(h, port, type=socket.SOCK_STREAM)
    return list(dict.fromkeys(i[4][0] for i in infos))


def check_url(url: str, policy: Policy = public_only) -> tuple[str, int]:
    """Validate scheme + host of `url` against the policy; returns (host, port)."""
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError as e:
        raise BlockedURL(f"invalid URL: {e}") from e
    if parts.scheme not in ("http", "https"):
        raise BlockedURL(f"only http:// and https:// URLs can be clipped (got '{parts.scheme or 'none'}')")
    host = parts.hostname or ""
    if not host:
        raise BlockedURL("URL has no host")
    if parts.username or parts.password:
        raise BlockedURL("URLs with user:password@ are not supported")
    port = port or (443 if parts.scheme == "https" else 80)
    policy(host, port)
    return host, port


def strip_query(url: str) -> str:
    """scheme://host/path — what may appear in audit logs, job titles and job metadata."""
    try:
        p = urlsplit(url)
        host = p.hostname or ""
        if p.port:
            host = f"{host}:{p.port}"
        return urlunsplit((p.scheme, host, p.path, "", ""))
    except ValueError:
        return ""


# ---- connect-time enforcement -----------------------------------------------------------------------
class GuardedBackend(httpcore.SyncBackend):
    """Connects only to addresses the policy approves (re-resolved and checked at connect time)."""

    def __init__(self, policy: Policy):
        self.policy = policy

    def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        addrs = self.policy(host, port)
        last: Exception | None = None
        for ip in addrs:
            try:
                return super().connect_tcp(ip, port, timeout=timeout, local_address=local_address,
                                           socket_options=socket_options)
            except (httpcore.ConnectError, httpcore.ConnectTimeout) as e:
                last = e
        raise last or httpcore.ConnectError(f"cannot connect to {host}")

    def connect_unix_socket(self, *a, **k):  # pragma: no cover - never used
        raise httpcore.ConnectError("unix sockets are not allowed")


def make_client(policy: Policy, *, user_agent: str, timeout: float) -> httpx.Client:
    transport = httpx.HTTPTransport(retries=0)
    pool = getattr(transport, "_pool", None)
    if pool is None or not hasattr(pool, "_network_backend"):  # pragma: no cover - httpx internals moved
        raise RuntimeError("unsupported httpx version: cannot install the connect-time address guard")
    pool._network_backend = GuardedBackend(policy)
    return httpx.Client(
        transport=transport,
        follow_redirects=False,
        trust_env=False,  # no proxies from the environment: the guard must see the real destination
        timeout=httpx.Timeout(timeout, connect=min(timeout, 15.0)),
        headers={"User-Agent": user_agent, "Accept-Language": "en-US,en;q=0.9"},
    )


@dataclass
class Response:
    url: str  # final URL after redirects
    status: int
    headers: httpx.Headers
    body: bytes
    redirects: list[str]


@contextmanager
def open_stream(client: httpx.Client, url: str, policy: Policy, *, headers: dict | None = None,
                max_redirects: int = 10) -> Iterator[tuple[httpx.Response, list[str]]]:
    """GET with redirects followed by hand, each hop checked against the policy. Yields (response, hops)."""
    hops: list[str] = []
    current = url
    for _ in range(max_redirects + 1):
        check_url(current, policy)
        req = client.build_request("GET", current, headers=headers or {})
        resp = client.send(req, stream=True)
        if resp.status_code in (301, 302, 303, 307, 308) and resp.headers.get("location"):
            nxt = urljoin(current, resp.headers["location"].strip())
            resp.close()
            hops.append(current)
            current = nxt
            continue
        try:
            yield resp, hops
        finally:
            resp.close()
        return
    raise FetchError(f"too many redirects (more than {max_redirects})")


def read_capped(resp: httpx.Response, limit: int) -> bytes:
    declared = resp.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise TooLarge(f"larger than the {limit / 1048576:.0f} MB limit ({int(declared) / 1048576:.1f} MB)")
    chunks, total = [], 0
    for chunk in resp.iter_bytes(65536):
        total += len(chunk)
        if total > limit:
            raise TooLarge(f"larger than the {limit / 1048576:.0f} MB limit")
        chunks.append(chunk)
    return b"".join(chunks)


def fetch(client: httpx.Client, url: str, policy: Policy, *, limit: int, headers: dict | None = None) -> Response:
    with open_stream(client, url, policy, headers=headers) as (resp, hops):
        body = read_capped(resp, limit)
        return Response(url=str(resp.url), status=resp.status_code, headers=resp.headers, body=body, redirects=hops)
