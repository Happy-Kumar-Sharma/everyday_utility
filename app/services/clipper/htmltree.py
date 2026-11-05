"""A lightweight, forgiving HTML element tree built with the stdlib parser.

Written for huge and hostile pages: building, walking and measuring the tree are all iterative (a page
nested 10,000 levels deep never hits Python's recursion limit), void elements and unclosed tags are handled,
and entities are decoded by html.parser (convert_charrefs).
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from html import escape
from html.parser import HTMLParser

VOID = frozenset("area base br col embed hr img input keygen link meta param source track wbr".split())
# a start tag of one of these closes an open <p>
CLOSES_P = frozenset(
    "address article aside blockquote details dialog div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 "
    "header hgroup hr main menu nav ol p pre section table ul".split())
# implicit end tags: starting `key` closes an open element in the set, unless a boundary element is in between
IMPLIED = {
    "li": ({"li"}, {"ul", "ol", "menu"}),
    "dt": ({"dt", "dd"}, {"dl"}),
    "dd": ({"dt", "dd"}, {"dl"}),
    "tr": ({"tr", "td", "th"}, {"table", "thead", "tbody", "tfoot"}),
    "td": ({"td", "th"}, {"tr", "table"}),
    "th": ({"td", "th"}, {"tr", "table"}),
    "thead": ({"thead", "tbody", "tfoot", "tr", "td", "th"}, {"table"}),
    "tbody": ({"thead", "tbody", "tfoot", "tr", "td", "th"}, {"table"}),
    "tfoot": ({"thead", "tbody", "tfoot", "tr", "td", "th"}, {"table"}),
    "option": ({"option"}, {"select", "datalist", "optgroup"}),
}
BOUNDARY_SCAN = 64  # how far down the open-element stack implied closes look


class Node:
    __slots__ = ("tag", "attrs", "children", "parent", "tl", "ll", "commas", "score")

    def __init__(self, tag: str, attrs: dict | None = None, parent: Node | None = None):
        self.tag = tag
        self.attrs = attrs or {}
        self.children: list = []  # Node or str
        self.parent = parent
        self.tl = 0  # text length of the subtree
        self.ll = 0  # text length inside links
        self.commas = 0
        self.score = 0.0

    def get(self, name: str, default: str = "") -> str:
        v = self.attrs.get(name)
        return default if v is None else v

    def classid(self) -> str:
        return f"{self.attrs.get('class') or ''} {self.attrs.get('id') or ''}".lower()

    def iter(self) -> Iterator[Node]:
        """Pre-order over element nodes (self included), iterative."""
        stack = [self]
        while stack:
            n = stack.pop()
            yield n
            for c in reversed(n.children):
                if isinstance(c, Node):
                    stack.append(c)

    def find_all(self, *tags: str) -> Iterator[Node]:
        want = set(tags)
        return (n for n in self.iter() if n.tag in want)

    def find(self, *tags: str) -> Node | None:
        return next(self.find_all(*tags), None)

    def text(self, limit: int | None = None) -> str:
        """All text of the subtree (scripts and styles included only if they are this node)."""
        out: list[str] = []
        size = 0
        stack: list = [self]
        while stack:
            n = stack.pop()
            if isinstance(n, str):
                out.append(n)
                size += len(n)
                if limit is not None and size >= limit:
                    break
                continue
            if n is not self and n.tag in ("script", "style", "template"):
                continue
            stack.extend(reversed(n.children))
        return "".join(out)

    def remove(self) -> None:
        if self.parent is not None:
            kids = self.parent.children
            for i, c in enumerate(kids):
                if c is self:
                    del kids[i]
                    break
            self.parent = None

    def replace_with(self, nodes: list) -> None:
        if self.parent is None:
            return
        kids = self.parent.children
        for i, c in enumerate(kids):
            if c is self:
                for x in nodes:
                    if isinstance(x, Node):
                        x.parent = self.parent
                kids[i:i + 1] = nodes
                break
        self.parent = None

    def __repr__(self) -> str:  # pragma: no cover
        return f"<{self.tag} {self.attrs!r}>"


class TreeBuilder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("#document")
        self.stack: list[Node] = [self.root]
        self.open_counts: dict[str, int] = {}

    def _push(self, node: Node) -> None:
        self.stack.append(node)
        self.open_counts[node.tag] = self.open_counts.get(node.tag, 0) + 1

    def _pop_to(self, index: int) -> None:
        while len(self.stack) > index:
            n = self.stack.pop()
            self.open_counts[n.tag] -= 1

    def _close_implied(self, tag: str) -> None:
        if tag in CLOSES_P and self.open_counts.get("p"):
            self._close_nearest("p", boundary={"button", "table", "td", "th", "li", "blockquote", "div", "section",
                                               "article", "body", "html"} - {tag})
        rule = IMPLIED.get(tag)
        if rule:
            targets, boundary = rule
            lo = max(1, len(self.stack) - BOUNDARY_SCAN)
            for i in range(len(self.stack) - 1, lo - 1, -1):
                t = self.stack[i].tag
                if t in targets:
                    self._pop_to(i)
                    return
                if t in boundary:
                    return

    def _close_nearest(self, tag: str, boundary: set[str] | None = None) -> bool:
        if not self.open_counts.get(tag):
            return False
        for i in range(len(self.stack) - 1, 0, -1):
            t = self.stack[i].tag
            if t == tag:
                self._pop_to(i)
                return True
            if boundary and t in boundary:
                return False
        return False

    def handle_starttag(self, tag, attrs):
        self._close_implied(tag)
        parent = self.stack[-1]
        node = Node(tag, {k: (v if v is not None else "") for k, v in attrs}, parent)
        parent.children.append(node)
        if tag not in VOID:
            self._push(node)

    def handle_startendtag(self, tag, attrs):
        self._close_implied(tag)
        parent = self.stack[-1]
        parent.children.append(Node(tag, {k: (v if v is not None else "") for k, v in attrs}, parent))

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        self._close_nearest(tag)  # stray end tags (nothing open with that name) are O(1) no-ops

    def handle_data(self, data):
        if not data:
            return
        kids = self.stack[-1].children
        if kids and isinstance(kids[-1], str):
            kids[-1] += data
        else:
            kids.append(data)


def remove_nodes(nodes: list[Node]) -> None:
    """Detach many nodes at once: one pass over each affected parent's children (not one per node)."""
    by_parent: dict[int, tuple[Node, set[int]]] = {}
    for n in nodes:
        if n.parent is not None:
            by_parent.setdefault(id(n.parent), (n.parent, set()))[1].add(id(n))
    for parent, ids in by_parent.values():
        parent.children = [c for c in parent.children if id(c) not in ids]
    for n in nodes:
        n.parent = None


def parse(html: str, chunk: int = 1 << 20) -> Node:
    b = TreeBuilder()
    for i in range(0, len(html), chunk):
        b.feed(html[i:i + chunk])
    b.close()
    return b.root


def compute_stats(root: Node) -> None:
    """Fill tl (text length), ll (link text length) and commas for every element, bottom-up, iteratively."""
    order: list[Node] = []
    stack = [root]
    while stack:
        n = stack.pop()
        order.append(n)
        for c in n.children:
            if isinstance(c, Node):
                stack.append(c)
    for n in reversed(order):  # children before parents
        tl = ll = commas = 0
        if n.tag in ("script", "style", "template", "noscript"):
            n.tl = n.ll = n.commas = 0
            continue
        for c in n.children:
            if isinstance(c, str):
                s = len(c.strip())
                if s:
                    tl += len(" ".join(c.split()))
                    commas += c.count(",")
            else:
                tl += c.tl
                ll += c.ll
                commas += c.commas
        if n.tag == "a":
            ll = tl
        n.tl, n.ll, n.commas = tl, ll, commas


# ---- SVG serialisation (html.parser lower-cases names; SVG is case-sensitive) ---------------------------------
_SVG_CASE = {s.lower(): s for s in (
    "viewBox preserveAspectRatio gradientUnits gradientTransform patternUnits patternContentUnits patternTransform "
    "clipPath clipPathUnits linearGradient radialGradient foreignObject textPath markerWidth markerHeight "
    "markerUnits refX refY maskUnits maskContentUnits stdDeviation baseFrequency numOctaves feGaussianBlur "
    "feOffset feBlend feColorMatrix feComposite feFlood feMerge feMergeNode feMorphology feTurbulence "
    "feDropShadow filterUnits primitiveUnits startOffset textLength lengthAdjust pathLength spreadMethod "
    "tableValues kernelMatrix attributeName attributeType repeatCount calcMode keyTimes keySplines "
    "animateTransform animateMotion").split()}
_SVG_DROP_ATTR = re.compile(r"^on|^(href|xlink:href)$")


def serialize_svg(svg: Node) -> str:
    """Standalone SVG document text for an inline <svg>. Scripts and event handlers are dropped and only
    fragment (#id) hrefs are kept, so the file stays an inert picture."""
    out: list[str] = []
    stack: list = [(svg, False)]
    while stack:
        n, closing = stack.pop()
        if isinstance(n, str):
            out.append(escape(n, quote=False))
            continue
        name = _SVG_CASE.get(n.tag, n.tag)
        if closing:
            out.append(f"</{name}>")
            continue
        if n.tag in ("script", "foreignobject", "iframe"):
            continue
        attrs = []
        for k, v in n.attrs.items():
            if _SVG_DROP_ATTR.search(k) and not (k.endswith("href") and v.startswith("#")):
                continue
            attrs.append(f' {_SVG_CASE.get(k, k)}="{escape(v)}"')
        if n is svg and "xmlns" not in n.attrs:
            attrs.insert(0, ' xmlns="http://www.w3.org/2000/svg"')
        if not n.children:
            out.append(f"<{name}{''.join(attrs)}/>")
            continue
        out.append(f"<{name}{''.join(attrs)}>")
        stack.append((n, True))
        for c in reversed(n.children):
            stack.append((c, False))
    return "".join(out)
