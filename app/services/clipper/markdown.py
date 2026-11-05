"""Element tree -> GitHub-flavoured Markdown, iteratively (no recursion, any depth, any length).

Output is built from *pieces*: escaped text (T), pre-rendered inline Markdown (I), verbatim blocks (R) and
break markers. Elements that need post-processing (headings, emphasis, links, list items, quotes, table
cells…) collect their pieces in a frame that is rendered and handed to the parent frame on exit; every other
element just writes into the current frame, so long flat pages stay linear.
"""

from __future__ import annotations

import base64
import re
from collections.abc import Callable
from urllib.parse import quote, urljoin

from .htmltree import Node
from .imgsrc import background_url, img_url, is_tracking_pixel, picture_url, svg_key


class T(str):
    """plain text, already escaped"""


class I(str):  # noqa: E742
    """inline markdown"""


class R(str):
    """verbatim block"""


class Brk:
    __slots__ = ("rank", "text")

    def __init__(self, rank: int, text: str):
        self.rank, self.text = rank, text


BLOCK = Brk(3, "\n\n")
BR = Brk(2, "  \n")
LINE = Brk(1, "\n")

BLOCK_TAGS = frozenset(
    "address article aside body center details dialog div fieldset figure footer form header hgroup html main "
    "nav p section summary dl caption tfoot legend".split())
SKIP_TAGS = frozenset("script style template head title noscript meta link select textarea option datalist button "
                      "canvas map object param".split())
EMPHASIS = {"strong": "**", "b": "**", "em": "*", "i": "*", "cite": "*", "dfn": "*", "del": "~~", "s": "~~",
            "strike": "~~"}
CODE_TAGS = frozenset({"code", "kbd", "samp", "tt", "var"})
MEDIA = {"iframe": "embed", "video": "video", "audio": "audio", "embed": "embed"}
MAX_NEST = 20  # deeper quotes / lists are flattened (their prefixes would grow quadratically)

_WS = re.compile(r"\s+")
_ESC = re.compile(r"([\\`*\[\]])")
_UNDERSCORE = re.compile(r"(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])")
_HTMLISH = re.compile(r"<(?=[A-Za-z/!?])")
_ORDERED = re.compile(r"(\d{1,9})([.)])(?=\s|$)")
_LANG = re.compile(r"(?:^|\s)(?:language|lang|highlight-source|highlight)-([A-Za-z0-9_+#.-]+)")


def escape_text(s: str) -> str:
    s = _ESC.sub(r"\\\1", s)
    s = _UNDERSCORE.sub(r"\\_", s)
    s = s.replace("~~", r"\~\~")
    return _HTMLISH.sub(r"\\<", s)


def escape_line_start(s: str) -> str:
    if not s:
        return s
    c = s[0]
    if c in "#>=":
        return "\\" + s
    if c in "-+" and (len(s) == 1 or s[1] in " \t" or set(s.rstrip()) == {c}):
        return "\\" + s
    m = _ORDERED.match(s)
    if m:
        return m.group(1) + "\\" + s[len(m.group(1)):]
    return s


def render(pieces: list) -> str:
    out: list[str] = []
    pending: Brk | None = None
    at_start = True  # start of a line
    for p in pieces:
        if isinstance(p, Brk):
            if out and (pending is None or p.rank > pending.rank):
                pending = p
            continue
        if not p:
            continue
        s = str(p)
        if not isinstance(p, R) and (pending is not None or at_start or (out and out[-1].endswith(" "))):
            s = s.lstrip(" ")
            if not s:
                continue
        if pending is not None:
            while out and out[-1].endswith((" ", "\t")):
                out[-1] = out[-1].rstrip(" \t")
                if not out[-1]:
                    out.pop()
            if out:
                out.append(pending.text)
                at_start = True
            pending = None
        if at_start and isinstance(p, T):
            s = escape_line_start(s)
        out.append(s)
        at_start = False
    return "".join(out).rstrip()


def _edges(pieces: list) -> tuple[str, str]:
    """(' ' or '', ' ' or ''): whether the frame's content started / ended with whitespace."""
    texts = [p for p in pieces if isinstance(p, str) and p]
    if not texts:
        return "", ""
    first, last = texts[0], texts[-1]
    lead = " " if isinstance(first, T) and first[:1] == " " else ""
    trail = " " if isinstance(last, T) and last[-1:] == " " else ""
    return lead, trail


def inline(pieces: list) -> str:
    return re.sub(r"[ \t]*\n+[ \t]*", " ", render(pieces)).strip()


def code_span(text: str) -> str:
    text = _WS.sub(" ", text)
    if not text.strip():
        return ""
    longest = max((len(m) for m in re.findall(r"`+", text)), default=0)
    fence = "`" * (longest + 1)
    pad = " " if text.startswith("`") or text.endswith("`") or (text.startswith(" ") and text.endswith(" ")) else ""
    return f"{fence}{pad}{text}{pad}{fence}"


def code_fence(text: str, lang: str) -> str:
    longest = max((len(m) for m in re.findall(r"`{3,}", text)), default=0)
    fence = "`" * max(3, longest + 1)
    return f"{fence}{lang}\n{text}\n{fence}"


def md_url(url: str) -> str:
    return quote(url, safe="!#$%&'*+,/:;=?@[]~-._|^{}")


def _pre_text(pre: Node) -> str:
    out: list[str] = []
    stack: list = [pre]
    while stack:
        n = stack.pop()
        if isinstance(n, str):
            out.append(n)
        elif n.tag == "br":
            out.append("\n")
        elif n is pre or n.tag not in ("script", "style", "template"):
            if n.tag in ("div", "p", "li", "tr") and n is not pre:
                stack.append("\n")  # line-per-element highlighters
            stack.extend(reversed(n.children))
    text = "".join(out)
    if text.startswith("\r\n"):
        text = text[2:]
    elif text.startswith("\n"):
        text = text[1:]
    return text.rstrip("\n").replace("\r\n", "\n")


def _plain_text(n: Node) -> str:
    return _pre_text(n)


def _lang(pre: Node) -> str:
    cands = [pre.get("class"), pre.get("data-lang") and f"lang-{pre.get('data-lang')}"]
    code = pre.find("code")
    if code is not None:
        cands += [code.get("class"), code.get("data-lang") and f"lang-{code.get('data-lang')}"]
    if pre.parent is not None:
        cands.append(pre.parent.get("class"))
    for c in cands:
        m = _LANG.search(c or "")
        if m:
            return m.group(1).lower()
    return ""


class Frame:
    __slots__ = ("node", "kind", "pieces", "data")

    def __init__(self, node: Node | None, kind: str, data=None):
        self.node, self.kind, self.pieces, self.data = node, kind, [], data


class Converter:
    """convert(node) -> markdown. `images` maps image keys (resolved URL, data: URI or svg:<hash>) to the local
    relative path; unmapped http(s) images keep their remote URL. `on_image(key, payload)` sees every image
    (payload is the SVG text for inline SVGs), so a first pass can collect what to download."""

    def __init__(self, base: str, images: dict[str, str] | None = None,
                 on_image: Callable[[str, str | None], None] | None = None):
        self.base = base
        self.images = images or {}
        self.on_image = on_image
        self.frames: list[Frame] = []
        self.counts = {"blockquote": 0, "list": 0}
        self.marks: dict[str, int] = {}

    # ---- output helpers ---------------------------------------------------------------------------------------
    def emit(self, *pieces) -> None:
        self.frames[-1].pieces.extend(pieces)

    def push(self, node: Node, kind: str, data=None) -> Frame:
        f = Frame(node, kind, data)
        self.frames.append(f)
        return f

    def image_md(self, key: str | None, alt: str, title: str = "") -> str:
        if not key:
            return ""
        if self.on_image:
            self.on_image(key, None)
        target = self.images.get(key)
        if target == "":  # deliberately dropped (tracking pixel)
            return ""
        if target is None:
            if not key.startswith(("http://", "https://")):
                return ""
            target = md_url(key)
        alt = escape_text(_WS.sub(" ", alt).strip())
        t = f' "{title.replace(chr(34), chr(39))}"' if title.strip() else ""
        return f"![{alt}]({target}{t})"

    def link_target(self, href: str) -> str | None:
        href = (href or "").strip()
        if not href:
            return None
        low = href.lower().replace("\t", "").replace("\n", "")
        if low.startswith(("javascript:", "vbscript:", "data:")):
            return None
        if low.startswith(("mailto:", "tel:")):
            return md_url(href)
        try:
            full = urljoin(self.base, href)
        except ValueError:
            return None
        if not full.lower().startswith(("http://", "https://", "ftp://")):
            return None
        return md_url(full)

    # ---- the walk ---------------------------------------------------------------------------------------------
    def convert(self, node: Node) -> str:
        root = Frame(None, "root")
        self.frames = [root]
        stack: list = [(node, False)]
        while stack:
            n, leaving = stack.pop()
            if isinstance(n, str):
                if n:
                    self.emit(T(escape_text(_WS.sub(" ", n))))
                continue
            if leaving:
                self.leave(n)
                continue
            if self.enter(n):
                stack.append((n, True))
                for c in reversed(n.children):
                    stack.append((c, False))
        return render(root.pieces) + "\n"

    def enter(self, n: Node) -> bool:
        """Returns False to skip the children (and the leave() call)."""
        tag = n.tag
        if tag in SKIP_TAGS:
            return False
        if n.attrs.get("style") and "url(" in n.attrs["style"]:
            bg = background_url(n, self.base)
            if bg:
                self.emit(I(self.image_md(bg, n.get("aria-label") or n.get("title"))))
        if tag in BLOCK_TAGS:
            self.emit(BLOCK)
            return True
        if tag in EMPHASIS:
            mark = EMPHASIS[tag]
            self.marks[mark] = self.marks.get(mark, 0) + 1
            self.push(n, "em", mark)
            return True
        if len(tag) == 2 and tag[0] == "h" and tag[1] in "123456":
            self.push(n, "h", int(tag[1]))
            return True
        if tag == "a":
            self.push(n, "a")
            return True
        if tag == "br":
            self.emit(BR)
            return False
        if tag == "hr":
            self.emit(BLOCK, R("---"), BLOCK)
            return False
        if tag == "pre":
            text = _pre_text(n)
            if text.strip():
                self.emit(BLOCK, R(code_fence(text, _lang(n))), BLOCK)
            return False
        if tag in CODE_TAGS:
            span = code_span(_plain_text(n))
            if span:
                self.emit(I(span))
            return False
        if tag == "img" or (tag == "input" and n.get("type").lower() == "image"):
            if not is_tracking_pixel(n):
                self.emit(I(self.image_md(img_url(n, self.base), n.get("alt"), n.get("title"))))
            return False
        if tag == "picture":
            url, img = picture_url(n, self.base)
            if img is None or not is_tracking_pixel(img):
                self.emit(I(self.image_md(url, img.get("alt") if img is not None else "",
                                          img.get("title") if img is not None else "")))
            return False
        if tag == "svg":
            key, text = svg_key(n)
            if self.on_image:
                self.on_image(key, text)
            if key in self.images:
                self.emit(I(f"![{escape_text(n.get('aria-label') or 'svg')}]({self.images[key]})"))
            return False
        if tag == "source":
            return False
        if tag in MEDIA:
            src = n.get("src") or n.get("data-src")
            if not src:
                s = n.find("source")
                src = s.get("src") if s is not None else ""
            target = self.link_target(src)
            if target:
                self.emit(BLOCK, I(f"▶ {MEDIA[tag]}: [{target}]({target})"), BLOCK)
            return False
        if tag == "blockquote":
            self.counts["blockquote"] += 1
            if self.counts["blockquote"] > MAX_NEST:
                self.emit(BLOCK)
                return True
            self.push(n, "quote")
            return True
        if tag in ("ul", "ol", "menu"):
            self.counts["list"] += 1
            if self.counts["list"] > MAX_NEST:
                self.emit(BLOCK)
                return True
            start = 1
            if tag == "ol":
                try:
                    start = int(n.get("start") or 1)
                except ValueError:
                    start = 1
            self.push(n, "list", {"ordered": tag == "ol", "next": start})
            return True
        if tag == "li":
            if self.counts["list"] > MAX_NEST:
                self.emit(BLOCK)
                return True
            self.push(n, "li")
            return True
        if tag == "dt":
            self.push(n, "dt")
            return True
        if tag == "dd":
            self.push(n, "dd")
            return True
        if tag == "table":
            self.push(n, "table", {"rows": [], "head": [], "caption": ""})
            return True
        if tag == "tr":
            t = self._nearest("table")
            if t is not None:
                t.data["rows"].append([])
                t.data["head"].append(True)
            return True
        if tag in ("td", "th"):
            self.push(n, "cell")
            return True
        if tag == "caption":
            self.push(n, "caption")
            return True
        if tag == "figcaption":
            self.push(n, "figcaption")
            return True
        if tag in ("sup", "sub"):
            self.push(n, tag)
            return True
        if tag == "q":
            self.emit(I("“"))
            return True
        if tag in ("tbody", "thead", "tfoot", "colgroup", "col"):
            return tag not in ("colgroup", "col")
        return True  # span, small, u, mark, abbr, time, … : transparent

    def _nearest(self, kind: str) -> Frame | None:
        for f in reversed(self.frames):
            if f.kind == kind:
                return f
            if f.kind == "table" and kind != "table":
                return None
        return None

    def _pop(self, n: Node) -> Frame | None:
        if len(self.frames) > 1 and self.frames[-1].node is n:
            return self.frames.pop()
        return None

    def leave(self, n: Node) -> None:
        tag = n.tag
        if tag in BLOCK_TAGS:
            self.emit(BLOCK)
            return
        if tag == "q":
            self.emit(I("”"))
            return
        if tag == "blockquote":
            f = self._pop(n)
            self.counts["blockquote"] -= 1
            if f is None:
                self.emit(BLOCK)
                return
            text = render(f.pieces).strip("\n")
            if text:
                quoted = "\n".join(f"> {ln}" if ln.strip() else ">" for ln in text.split("\n"))
                self.emit(BLOCK, R(quoted), BLOCK)
            return
        if tag in ("ul", "ol", "menu"):
            f = self._pop(n)
            self.counts["list"] -= 1
            if f is None:
                self.emit(BLOCK)
                return
            text = render(f.pieces).strip("\n")
            if text:
                in_li = self.frames[-1].kind == "li"
                self.emit(LINE if in_li else BLOCK, R(text), LINE if in_li else BLOCK)
            return
        f = self._pop(n)
        if f is None:
            if tag == "li":
                self.emit(BLOCK)
            return
        kind = f.kind
        if kind == "em":
            self.marks[f.data] -= 1
            text = render(f.pieces)
            core = text.strip()
            if not core:
                if any(isinstance(p, T) for p in f.pieces):
                    self.emit(T(" "))
                return
            lead, trail = _edges(f.pieces)
            if self.marks[f.data] > 0:  # already inside the same emphasis
                self.emit(I(f"{lead}{core}{trail}"))
                return
            core = re.sub(r"\s*\n+\s*", " ", core)
            self.emit(I(f"{lead}{f.data}{core}{f.data}{trail}"))
        elif kind == "h":
            text = inline(f.pieces)
            if text:
                self.emit(BLOCK, R("#" * f.data + " " + text), BLOCK)
        elif kind == "a":
            text = inline(f.pieces)
            target = self.link_target(n.get("href"))
            if not text:
                return
            if target is None:
                lead, trail = _edges(f.pieces)
                self.emit(I(f"{lead}{text}{trail}"))
                return
            title = n.get("title").strip()
            t = f' "{title.replace(chr(34), chr(39))}"' if title else ""
            lead, trail = _edges(f.pieces)
            self.emit(I(f"{lead}[{text}]({target}{t}){trail}"))
        elif kind == "li":
            body = render(f.pieces).strip("\n")
            lst = self.frames[-1] if self.frames[-1].kind == "list" else None
            if lst is not None and lst.data["ordered"]:
                prefix = f"{lst.data['next']}. "
                lst.data["next"] += 1
            else:
                prefix = "- "
            if not body.strip():
                return
            pad = " " * len(prefix)
            lines = body.split("\n")
            item = prefix + lines[0] + "".join("\n" + (pad + ln if ln.strip() else "") for ln in lines[1:])
            self.emit(LINE, R(item), LINE)
        elif kind == "dt":
            text = inline(f.pieces)
            if text:
                self.emit(BLOCK, R(f"**{text}**"), LINE)
        elif kind == "dd":
            body = render(f.pieces).strip("\n")
            if body:
                lines = body.split("\n")
                self.emit(LINE, R(": " + lines[0] + "".join("\n" + ("  " + ln if ln.strip() else "")
                                                               for ln in lines[1:])), BLOCK)
        elif kind == "cell":
            text = render(f.pieces).strip()
            text = re.sub(r"[ \t]*\n+[ \t]*", "<br>", text)
            text = re.sub(r"(?<!\\)((?:\\\\)*)\|", r"\1\\|", text)
            t = self._nearest("table")
            if t is None:
                self.emit(T(" "), I(text), T(" "))
                return
            if not t.data["rows"]:
                t.data["rows"].append([])
                t.data["head"].append(True)
            try:
                span = max(1, min(int(n.get("colspan") or 1), 50))
            except ValueError:
                span = 1
            t.data["rows"][-1].extend([text] + [""] * (span - 1))
            if tag != "th":
                t.data["head"][-1] = False
        elif kind == "caption":
            t = self._nearest("table")
            text = inline(f.pieces)
            if t is not None:
                t.data["caption"] = text
            elif text:
                self.emit(BLOCK, I(text), BLOCK)
        elif kind == "table":
            self.emit_table(f)
        elif kind == "figcaption":
            text = inline(f.pieces)
            if text:
                self.emit(BLOCK, I(f"*{text}*"), BLOCK)
        elif kind in ("sup", "sub"):
            text = inline(f.pieces)
            if text:
                mark = "^" if kind == "sup" else "~"
                self.emit(I(f"{mark}{text}" if " " not in text else f"{mark}({text})"))

    def emit_table(self, f: Frame) -> None:
        rows = [r for r in f.data["rows"] if r]
        caption = f.data["caption"]
        leftover = render(f.pieces).strip()  # stray content between rows (rare)
        if not rows:
            if leftover:
                self.emit(BLOCK, R(leftover), BLOCK)
            return
        ncols = max(len(r) for r in rows)
        if ncols == 1:  # layout table: just the content
            self.emit(BLOCK, *(x for r in rows for x in (R(r[0].replace("<br>", "\n\n")), BLOCK)))
            return
        rows = [r + [""] * (ncols - len(r)) for r in rows]
        header, body = rows[0], rows[1:]
        lines = ["| " + " | ".join(header) + " |", "|" + "|".join(" --- " for _ in header) + "|"]
        lines += ["| " + " | ".join(r) + " |" for r in body]
        out = []
        if caption:
            out += [BLOCK, I(f"*{caption}*")]
        out += [BLOCK, R("\n".join(lines)), BLOCK]
        if leftover:
            out += [R(leftover), BLOCK]
        self.emit(*out)


def to_markdown(node: Node, base: str, images: dict[str, str] | None = None) -> str:
    return Converter(base, images).convert(node)


def collect_images(node: Node, base: str) -> list[tuple[str, str | None]]:
    """[(key, svg_text_or_None)] in document order, each key once."""
    seen: dict[str, str | None] = {}

    def on_image(key: str, payload: str | None) -> None:
        if key not in seen:
            seen[key] = payload

    Converter(base, on_image=on_image).convert(node)
    return list(seen.items())


def decode_data_uri(uri: str, limit: int) -> tuple[bytes, str]:
    """(bytes, declared mime) of a data: URI; raises ValueError."""
    head, _, payload = uri.partition(",")
    if not head.startswith("data:"):
        raise ValueError("not a data: URI")
    meta = head[5:].split(";")
    mime = (meta[0] or "text/plain").lower()
    if len(payload) > limit * 4 // 3 + 16:
        raise ValueError(f"inline image larger than the {limit / 1048576:.0f} MB limit")
    if "base64" in meta[1:]:
        data = base64.b64decode(re.sub(r"\s+", "", payload), validate=False)
    else:
        from urllib.parse import unquote_to_bytes
        data = unquote_to_bytes(payload)
    if len(data) > limit:
        raise ValueError(f"inline image larger than the {limit / 1048576:.0f} MB limit")
    return data, mime

