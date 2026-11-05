"""Page metadata, boilerplate removal and main-content selection (Readability-style), all iterative."""

from __future__ import annotations

import json
import re
from urllib.parse import urljoin

from .htmltree import Node, compute_stats, remove_nodes
from .imgsrc import NOSCRIPT_ATTR, img_url, is_icon_svg

# ---- metadata -------------------------------------------------------------------------------------------------


def _clean(s: str) -> str:
    return " ".join((s or "").split())


def _ld_objects(root: Node) -> list[dict]:
    out: list[dict] = []
    for s in root.find_all("script"):
        if "ld+json" not in s.get("type").lower():
            continue
        try:
            data = json.loads(s.text(limit=2_000_000).strip())
        except ValueError:
            continue
        todo = [data]
        while todo and len(out) < 200:
            d = todo.pop()
            if isinstance(d, list):
                todo.extend(d)
            elif isinstance(d, dict):
                out.append(d)
                if isinstance(d.get("@graph"), list):
                    todo.extend(d["@graph"])
    return out


def _ld_author(v) -> str:
    if isinstance(v, str):
        return v
    if isinstance(v, dict):
        return str(v.get("name") or "")
    if isinstance(v, list):
        return ", ".join(x for x in (_ld_author(i) for i in v[:5]) if x)
    return ""


def page_meta(root: Node, url: str) -> dict:
    """title, author, published, cover image URLs, base URL, site name, description."""
    metas: dict[str, str] = {}
    base = url
    title_tag = ""
    for n in root.iter():
        if n.tag == "meta":
            key = (n.get("property") or n.get("name") or n.get("itemprop")).lower().strip()
            if key and key not in metas and n.get("content").strip():
                metas[key] = n.get("content").strip()
        elif n.tag == "base" and n.get("href") and base == url:
            try:
                base = urljoin(url, n.get("href").strip())
            except ValueError:
                pass
        elif n.tag == "title" and not title_tag:
            title_tag = _clean(n.text())
    ld = _ld_objects(root)
    h1 = root.find("h1")
    title = _clean(metas.get("og:title") or metas.get("twitter:title") or title_tag or (h1.text() if h1 else ""))

    author = metas.get("author") or metas.get("article:author") or metas.get("parsely-author") or ""
    if author.startswith("http"):
        author = ""
    if not author:
        for d in ld:
            author = _ld_author(d.get("author"))
            if author:
                break
    if not author:
        for n in root.iter():
            if n.tag == "a" and "author" in n.get("rel").lower().split():
                author = n.text()
                break
            if n.tag in ("span", "div", "p", "address") and re.search(r"\b(byline|author-name)\b", n.classid()):
                t = _clean(n.text())
                if 0 < len(t) < 100:
                    author = re.sub(r"^by\s+", "", t, flags=re.I)
                    break
    published = (metas.get("article:published_time") or metas.get("datepublished") or metas.get("date")
                 or metas.get("pubdate") or metas.get("publish-date") or metas.get("dc.date")
                 or metas.get("dc.date.issued") or "")
    if not published:
        for d in ld:
            if d.get("datePublished"):
                published = str(d["datePublished"])
                break
    if not published:
        t = root.find("time")
        for n in root.find_all("time"):
            if n.get("datetime"):
                t = n
                break
        if t is not None and t.get("datetime"):
            published = t.get("datetime")

    covers: list[str] = []
    for key in ("og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"):
        if metas.get(key):
            covers.append(metas[key])
    for n in root.find_all("link"):
        if "image_src" in n.get("rel").lower().split() and n.get("href"):
            covers.append(n.get("href"))
    resolved = []
    for c in covers:
        try:
            full = urljoin(base, c.strip())
        except ValueError:
            continue
        if full.startswith(("http://", "https://")) and full not in resolved:
            resolved.append(full)
    return {"title": title, "author": _clean(author)[:200], "published": _clean(published)[:64],
            "covers": resolved, "base": base, "site": _clean(metas.get("og:site_name", ""))[:200],
            "description": _clean(metas.get("og:description") or metas.get("description") or "")[:500]}


# ---- pruning --------------------------------------------------------------------------------------------------

ALWAYS_DROP = frozenset("script style template head title meta link base select textarea option datalist "
                        "canvas map object param".split())
MAIN_DROP = frozenset("nav footer aside form button dialog menu".split())
_HIDDEN_STYLE = re.compile(r"(^|;)\s*(display\s*:\s*none|visibility\s*:\s*hidden)", re.I)
# strong boilerplate: removed even when the class also says "article"/"content"
_STRONG_JUNK = re.compile(
    r"(?:^|[\s_-])(cookie|consent|gdpr|subscribe|subscription|newsletter|share|sharing|social|advert\w*|ads?|ad-\w+|"
    r"sponsor\w*|promo\w*|popup|modal|related|recommend\w*|outbrain|taboola|paywall|signup|sign-up)(?:$|[\s_-])")
_WEAK_JUNK = re.compile(
    r"(?:^|[\s_-])(banner|sidebar|side-bar|comments?|disqus|footer|nav|navbar|navigation|menu|breadcrumbs?|"
    r"masthead|skip|toolbar|pagination|pager|widget|tags|meta-?nav)(?:$|[\s_-])")
_MAYBE_CONTENT = re.compile(r"(?:^|[\s_-])(article|body|content|entry|main|post|story|text|column)(?:$|[\s_-])")
_POSITIVE = re.compile(r"article|body|content|entry|hentry|h-entry|main|page|pagination|post|text|blog|story", re.I)
_NEGATIVE = re.compile(r"hidden|banner|combx|comment|com-|contact|foot|footer|footnote|masthead|media|meta|outbrain|"
                       r"promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|tool|widget|"
                       r"cookie|consent|newsletter|subscribe|social|nav|menu|breadcrumb|popup|modal|advert", re.I)
_JS_ASK = re.compile(r"(enable|turn on|activate)\s+javascript|javascript\s+(is\s+)?(required|disabled|must be enabled)|"
                     r"requires\s+javascript|need(s)?\s+(to\s+)?(enable\s+)?javascript", re.I)


def is_hidden(n: Node) -> bool:
    a = n.attrs
    if "hidden" in a or a.get("aria-hidden", "").lower() == "true":
        return True
    if n.tag == "input" and a.get("type", "").lower() == "hidden":
        return True
    return bool(_HIDDEN_STYLE.search(a.get("style") or ""))


def _resolve_noscripts(root: Node, base: str) -> None:
    """<noscript><img></noscript> right after a lazy <img>: becomes that img's fallback source; a noscript with
    images and no such sibling is replaced by its images; any other noscript is dropped. One pass per parent."""
    parents: dict[int, Node] = {}
    for ns in root.find_all("noscript"):
        if ns.parent is not None:
            parents[id(ns.parent)] = ns.parent
    for parent in parents.values():
        new: list = []
        prev: Node | None = None
        for c in parent.children:
            if isinstance(c, str):
                new.append(c)
                if c.strip():
                    prev = None
                continue
            if c.tag != "noscript":
                new.append(c)
                prev = c
                continue
            imgs = [i for i in c.find_all("img") if i.get("src") or i.get("srcset")]
            c.parent = None
            if not imgs:
                continue
            prev_img = None if prev is None else (prev if prev.tag == "img" else prev.find("img"))
            if prev_img is not None:
                if img_url(prev_img, base) is None:
                    prev_img.attrs[NOSCRIPT_ATTR] = imgs[0].get("src") or imgs[0].get("srcset").split()[0]
                continue
            for i in imgs:
                i.parent = parent
                new.append(i)
            prev = imgs[-1]
        parent.children = new


def prune(root: Node, base: str, content: str = "main") -> None:
    """Remove scripts, hidden elements and (content="main") navigation and boilerplate, in place."""
    _resolve_noscripts(root, base)
    compute_stats(root)
    body = root.find("body") or root
    total = max(body.tl, 1)
    stack: list[tuple[Node, bool]] = [(root, False)]
    doomed: list[Node] = []
    while stack:
        n, in_article = stack.pop()
        drop = False
        if n.tag in ALWAYS_DROP or (n.tag in ("input", "button") and n.get("type").lower() != "image"
                                    and content == "full"):
            drop = True
        elif n.tag not in ("html", "body", "#document") and is_hidden(n):
            drop = True
        elif n.tag == "svg" and is_icon_svg(n):
            drop = True
        elif content == "main" and n.tag not in ("html", "body", "#document", "article", "main"):
            if n.tag in MAIN_DROP:
                drop = not (n.tag == "form" and n.tl > total * 0.5)  # some sites wrap the whole page in a form
            elif n.tag == "input" and n.get("type").lower() != "image":
                drop = True
            elif n.tag == "header" and not in_article:
                drop = n.tl < total * 0.5
            elif n.tag == "iframe":
                w, h = n.get("width"), n.get("height")
                drop = w in ("0", "1") or h in ("0", "1") or bool(re.search(r"doubleclick|googlesyndication|adservice",
                                                                         n.get("src")))
            else:
                ci = n.classid().strip()
                role = n.get("role").lower()
                if role in ("navigation", "banner", "contentinfo", "complementary", "dialog", "alertdialog",
                            "search", "menu", "menubar"):
                    drop = n.tl < total * 0.5
                elif ci and n.tl < total * 0.5 and (
                        _STRONG_JUNK.search(ci) or (_WEAK_JUNK.search(ci) and not _MAYBE_CONTENT.search(ci))):
                    drop = True
        if drop:
            doomed.append(n)
            continue
        child_in_article = in_article or n.tag in ("article", "main") or n.get("role") == "main"
        for c in n.children:
            if isinstance(c, Node):
                stack.append((c, child_in_article))
    remove_nodes(doomed)
    compute_stats(root)


def looks_js_rendered(raw_root: Node, main_text_len: int) -> tuple[bool, str]:
    """Heuristics on the *unpruned* static document: is the real content rendered by JavaScript?"""
    if main_text_len < 400:
        return True, f"only {main_text_len} characters of text"
    body = raw_root.find("body") or raw_root
    scripts = sum(1 for _ in raw_root.find_all("script"))
    for n in body.iter():
        if n.tag == "div" and n.get("id").lower() in ("root", "app", "__next", "__nuxt", "svelte", "main-app", "react-root"):
            if len(" ".join(n.text(limit=4000).split())) < 200 and scripts:
                return True, f'empty <div id="{n.get("id")}"> app shell'
    for ns in raw_root.find_all("noscript"):
        if _JS_ASK.search(ns.text(limit=2000)) and main_text_len < 1500:
            return True, "the page asks to enable JavaScript"
    return False, ""


# ---- main content -----------------------------------------------------------------------------------------------


def _link_density(n: Node) -> float:
    return (n.ll / n.tl) if n.tl else 0.0


def _class_weight(n: Node) -> int:
    w = 0
    for v in (n.get("class"), n.get("id")):
        if not v:
            continue
        if _NEGATIVE.search(v):
            w -= 25
        if _POSITIVE.search(v):
            w += 25
    return w


_TAG_SCORE = {"div": 5, "article": 10, "section": 3, "main": 5, "pre": 3, "td": 3, "blockquote": 3,
              "address": -3, "ol": -3, "ul": -3, "dl": -3, "dd": -3, "dt": -3, "li": -3, "form": -3,
              "h1": -5, "h2": -5, "h3": -5, "h4": -5, "h5": -5, "h6": -5, "th": -5}


def _direct_text(n: Node) -> int:
    return sum(len(c.strip()) for c in n.children if isinstance(c, str))


def _score(body: Node) -> Node | None:
    scored: dict[int, Node] = {}
    for n in body.iter():
        n.score = 0.0
    for n in body.iter():
        is_para = n.tag in ("p", "pre", "td", "blockquote") or (n.tag in ("div", "section") and _direct_text(n) >= 25)
        if not is_para or n.tl < 25:
            continue
        own = (n.tl if n.tag != "div" and n.tag != "section" else _direct_text(n))
        points = 1 + n.commas + min(own // 100, 3)
        anc, level = n.parent, 0
        while anc is not None and level < 5 and anc.tag != "#document":
            if id(anc) not in scored:
                anc.score = _TAG_SCORE.get(anc.tag, 0) + _class_weight(anc)
                scored[id(anc)] = anc
            anc.score += points / (1 if level == 0 else 2 if level == 1 else level * 3)
            anc, level = anc.parent, level + 1
    best = None
    for n in scored.values():
        n.score *= (1 - _link_density(n))
        if best is None or n.score > best.score:
            best = n
    return best


def _with_siblings(top: Node) -> Node:
    container = Node("div", {"data-eu": "content"})
    parent = top.parent
    if parent is None or parent.tag in ("#document", "html"):
        container.children = [top]
        return container
    threshold = max(10.0, top.score * 0.2)
    tcls = top.get("class")
    for s in parent.children:
        if s is top:
            container.children.append(s)
            continue
        if not isinstance(s, Node):
            continue
        bonus = top.score * 0.2 if tcls and s.get("class") == tcls else 0
        keep = s.score + bonus >= threshold and s.score > 0
        if not keep and s.tag == "p":
            ld = _link_density(s)
            text = s.text(limit=2000)
            keep = (s.tl > 80 and ld < 0.25) or (0 < s.tl <= 80 and ld == 0 and re.search(r"\.( |$)", text))
        if not keep and s.tag in ("figure", "picture", "img") and s.ll == 0:
            keep = True
        if keep:
            container.children.append(s)
    return container


def _clean_conditionally(content: Node) -> None:
    """Drop link farms (share bars, tag clouds, "more stories") left inside the content. Link and media counts
    are computed bottom-up in one pass, so this stays linear on deep pages."""
    order: list[Node] = []
    stack = [content]
    while stack:
        n = stack.pop()
        order.append(n)
        stack.extend(c for c in n.children if isinstance(c, Node))
    links: dict[int, int] = {}
    media: dict[int, bool] = {}
    doomed = []
    for n in reversed(order):
        k = 1 if n.tag == "a" else 0
        m = n.tag in ("img", "picture", "pre", "video", "svg")
        for c in n.children:
            if isinstance(c, Node):
                k += links[id(c)]
                m = m or media[id(c)]
        links[id(n)], media[id(n)] = k, m
        if n is content or n.tag not in ("div", "section", "ul"):
            continue
        if k >= 3 and n.tl < 300 and _link_density(n) > 0.6 and not m:
            if n.tag == "ul" and _class_weight(n) >= 0:
                continue  # plain link lists inside an article (references, steps) stay
            doomed.append(n)
    _remove_all(content, doomed)


def _remove_all(content: Node, nodes: list[Node]) -> None:
    ids = {id(n) for n in nodes}
    content.children = [c for c in content.children if id(c) not in ids]  # synthetic container: not their parent
    remove_nodes(nodes)


def select_content(root: Node, content: str = "main", title: str = "") -> Node:
    """After prune(): the node(s) to convert. For "main" a Readability-style pick, for "full" the body."""
    body = root.find("body") or root
    if content == "full":
        return body
    total = body.tl
    chosen: Node | None = None
    articles = [a for a in body.find_all("article") if not _has_ancestor(a, "article")]
    if articles:
        best = max(articles, key=lambda a: a.tl)
        all_tl = sum(a.tl for a in articles)
        if (best.tl >= 250 or best.tl >= total * 0.4) and best.tl >= all_tl * 0.5:
            chosen = best
    if chosen is None:
        mains = [n for n in body.iter() if n.tag == "main" or n.get("role").lower() == "main"]
        if mains:
            m = max(mains, key=lambda x: x.tl)
            if m.tl >= 250 or m.tl >= total * 0.4:
                chosen = m
    if chosen is not None:
        wrapper = Node("div", {"data-eu": "content"})
        wrapper.children = [chosen]
        result = wrapper
    else:
        top = _score(body)
        result = _with_siblings(top) if top is not None else body
    compute_stats(result)
    if result.tl < 200 and total > max(2 * result.tl, 200):
        result = body
    _clean_conditionally(result)
    _drop_title_h1(result, title)
    compute_stats(result)
    return result


def _has_ancestor(n: Node, tag: str) -> bool:
    p = n.parent
    while p is not None:
        if p.tag == tag:
            return True
        p = p.parent
    return False


def _norm(s: str) -> str:
    return re.sub(r"\W+", " ", s).strip().lower()


def _drop_title_h1(content: Node, title: str) -> None:
    if not title:
        return
    t = _norm(title)
    for h in content.find_all("h1"):
        ht = _norm(h.text(limit=1000))
        if ht and (ht == t or t.startswith(ht)):
            _remove_all(content, [h])
        return
