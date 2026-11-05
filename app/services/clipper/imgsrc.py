"""Which URL an image element really points at (lazy loading, srcset, <picture>, noscript fallbacks…).

Shared by the image collector and the Markdown converter so both agree on the key of every image."""

from __future__ import annotations

import hashlib
import re
from urllib.parse import urljoin

from .htmltree import Node, serialize_svg

LAZY_ATTRS = ("data-src", "data-lazy-src", "data-original", "data-lazy", "data-url", "data-hi-res-src",
              "data-full-src", "data-orig-src", "data-actualsrc", "data-echo", "data-image", "data-img-src")
SRCSET_ATTRS = ("srcset", "data-srcset", "data-lazy-srcset")
NOSCRIPT_ATTR = "data-eu-noscript-src"
_PLACEHOLDER = re.compile(r"(^|/)([\w-]*placeholder[\w-]*|blank|spacer|transparent|pixel|1x1|grey|gray|loading|"
                          r"lazy-?load(er|ing)?|empty)\.(gif|png|svg|jpe?g|webp)$", re.I)
_BG_URL = re.compile(r"background(?:-image)?\s*:[^;]*?url\(\s*(['\"]?)(.*?)\1\s*\)", re.I)
COMMON_TYPES = ("image/jpeg", "image/png", "image/webp", "image/gif")


def parse_srcset(value: str) -> list[tuple[str, float]]:
    """[(url, weight)] where weight is the w descriptor, or density * 1e-6 when only x is given (w wins).
    Follows the HTML srcset parsing rules (URLs may contain commas)."""
    out: list[tuple[str, float]] = []
    s, i, n = value or "", 0, len(value or "")
    while i < n:
        while i < n and (s[i].isspace() or s[i] == ","):
            i += 1
        if i >= n:
            break
        j = i
        while j < n and not s[j].isspace():
            j += 1
        url = s[i:j]
        i = j
        desc = ""
        if url.endswith(","):
            url = url.rstrip(",")
        else:
            depth = 0
            k = i
            while k < n:
                ch = s[k]
                if ch == "(":
                    depth += 1
                elif ch == ")":
                    depth = max(0, depth - 1)
                elif ch == "," and depth == 0:
                    break
                k += 1
            desc = s[i:k].strip()
            i = k + 1
        if not url:
            continue
        weight = 1e-6
        for d in desc.split():
            try:
                if d.endswith("w"):
                    weight = float(d[:-1])
                elif d.endswith("x"):
                    weight = float(d[:-1]) * 1e-6
            except ValueError:
                pass
        out.append((url, weight))
    return out


def best_from_srcset(value: str) -> str | None:
    cands = parse_srcset(value)
    if not cands:
        return None
    return max(cands, key=lambda c: c[1])[0]


def is_placeholder(src: str) -> bool:
    s = src.strip()
    if not s:
        return True
    if s.startswith("data:"):
        return len(s) < 200 or (s.startswith("data:image/svg+xml") and len(s) < 600)
    return bool(_PLACEHOLDER.search(s.split("?", 1)[0]))


def _dim(v: str) -> float | None:
    m = re.match(r"\s*(\d+(?:\.\d+)?)\s*(px)?\s*$", v or "")
    return float(m.group(1)) if m else None


def is_tracking_pixel(node: Node) -> bool:
    w, h = _dim(node.get("width")), _dim(node.get("height"))
    if (w is not None and w <= 2) or (h is not None and h <= 2):
        return True
    style = node.get("style").replace(" ", "").lower()
    return bool(re.search(r"(^|;)(width|height):[0-2]px", style))


def resolve(base: str, url: str) -> str | None:
    url = (url or "").strip()
    if not url:
        return None
    if url.startswith("data:"):
        return url
    try:
        full = urljoin(base, url)
    except ValueError:
        return None
    return full if full.split(":", 1)[0].lower() in ("http", "https") else None


def img_url(node: Node, base: str) -> str | None:
    """Best source of an <img> (or <input type=image>)."""
    for a in SRCSET_ATTRS:
        if node.get(a).strip():
            best = best_from_srcset(node.get(a))
            if best and not is_placeholder(best):
                return resolve(base, best)
    for a in LAZY_ATTRS:
        v = node.get(a).strip()
        if v and not is_placeholder(v):
            return resolve(base, v)
    src = node.get("src").strip()
    if src and not is_placeholder(src):
        return resolve(base, src)
    if node.get(NOSCRIPT_ATTR):
        return resolve(base, node.get(NOSCRIPT_ATTR))
    return None


def picture_url(pic: Node, base: str) -> tuple[str | None, Node | None]:
    """Largest <source> of a <picture>, preferring common formats; falls back to its <img>."""
    img = pic.find("img")
    best: tuple[int, float, str] | None = None
    for src in pic.find_all("source"):
        srcset = src.get("srcset") or src.get("data-srcset")
        if not srcset:
            continue
        typ = src.get("type").lower()
        media = src.get("media").lower()
        common = 1 if (not typ or typ in COMMON_TYPES) else 0
        for url, w in parse_srcset(srcset):
            if is_placeholder(url):
                continue
            key = (common, w if "max-width" not in media else w * 0.5, url)
            if best is None or key[:2] > best[:2]:
                best = key
    if best:
        own = img_url(img, base) if img is not None else None
        if own and img is not None and best[1] <= _srcset_max(img):
            return own, img
        return resolve(base, best[2]), img
    return (img_url(img, base) if img is not None else None), img


def _srcset_max(img: Node) -> float:
    vals = [w for a in SRCSET_ATTRS for _, w in parse_srcset(img.get(a))]
    return max(vals) if vals else -1


def background_url(node: Node, base: str) -> str | None:
    m = _BG_URL.search(node.get("style"))
    if not m:
        return None
    u = m.group(2).strip()
    return None if is_placeholder(u) else resolve(base, u)


def svg_key(svg: Node) -> tuple[str, str]:
    text = serialize_svg(svg)
    return "svg:" + hashlib.sha256(text.encode()).hexdigest()[:24], text


def is_icon_svg(svg: Node) -> bool:
    w, h = _dim(svg.get("width")), _dim(svg.get("height"))
    if w is not None and h is not None and w <= 48 and h <= 48:
        return True
    if "icon" in svg.classid() or svg.get("aria-hidden") == "true" or svg.get("role") == "presentation":
        return True
    vb = svg.get("viewbox").split()
    if len(vb) == 4 and w is None and h is None:
        try:
            if float(vb[2]) <= 48 and float(vb[3]) <= 48:
                return True
        except ValueError:
            pass
    p = svg.parent
    for _ in range(3):
        if p is None:
            break
        if p.tag in ("button", "a"):
            return True
        p = p.parent
    return False
