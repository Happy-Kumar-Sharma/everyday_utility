"""Web Clipper: SSRF guard, HTML -> Markdown, extraction, images, the job/API and the files it writes.

No test touches the internet: pages are served by a local http.server on 127.0.0.1, and the tests that
fetch from it pass the test-only `allow_all` policy explicitly (or through a wrapper script for the job)."""

from __future__ import annotations

import io
import json
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.services.clipper import extract, netguard
from app.services.clipper.clip import clip
from app.services.clipper.htmltree import parse
from app.services.clipper.markdown import to_markdown
from app.services.clipper.netguard import BlockedURL, allow_all, check_url, public_only
from app.services.clipper.router import _syntax_check

H = {"x-everyday-utility": "1"}
ROOT = Path(__file__).resolve().parents[1]


def png(color=(255, 0, 0), size=(12, 10)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


def gif1x1() -> bytes:
    buf = io.BytesIO()
    Image.new("P", (1, 1)).save(buf, "GIF")
    return buf.getvalue()


# ---- fixture server ---------------------------------------------------------------------------------------------
class Site:
    def __init__(self):
        self.routes: dict[str, tuple[int, dict, bytes]] = {}
        self.hits: list[tuple[str, dict]] = []
        self.delay: dict[str, float] = {}
        site = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                site.hits.append((self.path, dict(self.headers)))
                time.sleep(site.delay.get(self.path.split("?", 1)[0], 0))
                status, headers, body = site.routes.get(self.path.split("?", 1)[0], (404, {"Content-Type": "text/plain"}, b"nope"))
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):  # the client aborted (size cap)
                    pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.base = f"http://127.0.0.1:{self.port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def add(self, path, body, ctype="text/html; charset=utf-8", status=200, **headers):
        if isinstance(body, str):
            body = body.encode()
        self.routes[path] = (status, {"Content-Type": ctype, **headers}, body)


@pytest.fixture()
def site():
    s = Site()
    yield s
    s.server.shutdown()


# ---- SSRF -----------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("url", [
    "http://127.0.0.1/", "http://127.1.2.3:8080/x", "http://[::1]/", "http://10.1.2.3/", "http://172.16.0.1/",
    "http://172.31.255.255/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/", "http://0.0.0.0/", "http://localhost/", "http://LOCALHOST:8765/",
    "http://foo.localhost/", "http://printer.local/", "http://metadata.google.internal/",
    "http://[::ffff:127.0.0.1]/", "http://[::ffff:10.0.0.1]/", "http://[::ffff:a9fe:a9fe]/", "http://[fd00::1]/",
    "http://[fe80::1]/", "http://224.0.0.1/", "http://intranet/", "file:///etc/passwd", "ftp://example.com/",
    "gopher://example.com/", "http://user:pw@example.com/",
])
def test_ssrf_policy_refuses(url):
    with pytest.raises(BlockedURL):
        check_url(url, public_only)


@pytest.mark.parametrize("url", ["http://169.254.169.254/", "http://localhost:8765/", "http://[::ffff:127.0.0.1]/",
                                 "file:///etc/passwd", "http://10.0.0.1/"])
def test_api_precheck_refuses_without_dns(url):
    with pytest.raises(BlockedURL):
        _syntax_check(url)


def test_ssrf_public_literal_allowed_and_any_port():
    assert check_url("http://93.184.216.34:8443/x", public_only) == ("93.184.216.34", 8443)
    assert check_url("https://[2606:4700::1111]/", public_only)[1] == 443


def test_ssrf_public_name_resolving_to_private(monkeypatch):
    def fake(host, port, *a, **k):
        ips = {"evil.example.com": ["93.184.216.34", "10.0.0.7"], "good.example.com": ["93.184.216.34"]}[host]
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port)) for ip in ips]
    monkeypatch.setattr(socket, "getaddrinfo", fake)
    with pytest.raises(BlockedURL, match="10.0.0.7"):
        check_url("https://evil.example.com/a", public_only)  # ANY private address is enough
    assert public_only("good.example.com", 443) == ["93.184.216.34"]


def test_redirect_from_public_to_private_is_blocked(site):
    site.add("/start", "", status=302, Location=f"{site.base}/secret")
    site.add("/secret", "<p>internal</p>")

    def policy(host, port):  # "public.example" is public and happens to live on our fixture server
        if host == "public.example":
            return ["127.0.0.1"]
        return public_only(host, port)

    client = netguard.make_client(policy, user_agent="t", timeout=5)
    with pytest.raises(BlockedURL):
        netguard.fetch(client, f"http://public.example:{site.port}/start", policy, limit=10**6)
    assert [p for p, _ in site.hits] == ["/start"]  # /secret was never requested


def test_connect_time_guard_rechecks(site, monkeypatch):
    """Even when the pre-check passed, the socket only opens to an address the policy approves."""
    site.add("/", "<p>x</p>")
    calls = []

    def policy(host, port):
        calls.append(host)
        if len(calls) > 1:
            raise BlockedURL("rebinding")
        return ["127.0.0.1"]
    client = netguard.make_client(policy, user_agent="t", timeout=5)
    with pytest.raises(BlockedURL, match="rebinding"):
        netguard.fetch(client, f"http://rebind.example:{site.port}/", policy, limit=1000)


# ---- HTML -> Markdown -----------------------------------------------------------------------------------------
def md(html: str, base: str = "https://ex.com/dir/page") -> str:
    return to_markdown(parse(html), base)


def test_headings_inline_and_entities():
    out = md("<h2>Tom &amp; Jerry&nbsp;<em>show</em></h2><p>a <b>bold</b>, <i>it</i> and <del>gone</del> &lt;tag&gt; &copy;</p>")
    assert "## Tom & Jerry *show*" in out
    assert "a **bold**, *it* and ~~gone~~ \\<tag> ©" in out


def test_nested_lists_with_indentation():
    out = md("<ul><li>one<ul><li>a</li><li>b<ol><li>x</li><li>y</li></ol></li></ul></li><li>two</li></ul>"
             "<ol start='3'><li>c</li><li>d</li></ol>")
    assert "- one\n  - a\n  - b\n    1. x\n    2. y\n- two" in out
    assert "3. c\n4. d" in out


def test_tables_with_pipes_colspan_and_newlines():
    out = md("<table><thead><tr><th>Name</th><th>A|B</th><th>C</th></tr></thead>"
             "<tbody><tr><td>x</td><td>line1<br>line2</td><td>z</td></tr><tr><td colspan='2'>wide</td><td>q</td></tr></tbody></table>")
    assert "| Name | A\\|B | C |\n| --- | --- | --- |\n| x | line1<br>line2 | z |\n| wide |  | q |" in out


def test_table_without_th_uses_first_row():
    out = md("<table><tr><td>h1</td><td>h2</td></tr><tr><td>1</td><td>2</td></tr></table>")
    assert "| h1 | h2 |\n| --- | --- |\n| 1 | 2 |" in out


def test_code_blocks_and_inline_code_with_backticks():
    out = md('<pre><code class="language-python">def f():\n    return "```"\n\n\n    # spaced\n</code></pre>'
             "<p>use <code>a `b` c</code> and <code>`x</code></p>")
    assert '````python\ndef f():\n    return "```"\n\n\n    # spaced\n````' in out
    assert "``a `b` c``" in out and "`` `x ``" in out


def test_links_relative_absolute_javascript_mailto():
    root = parse('<base href="https://cdn.ex.com/base/"><p><a href="../up?q=1#f">rel</a> <a href="javascript:void(0)">'
                 'js text</a> <a href="mailto:a@b.c">mail</a> <a href="/root path" title="T">sp</a></p>')
    base = extract.page_meta(root, "https://ex.com/dir/page")["base"]  # <base href> wins over the page URL
    out = to_markdown(root, base)
    assert "[rel](https://cdn.ex.com/up?q=1#f)" in out
    assert "js text" in out and "javascript" not in out
    assert "[mail](mailto:a@b.c)" in out
    assert '[sp](https://cdn.ex.com/root%20path "T")' in out


def test_markdown_escaping():
    out = md("<p># not a heading</p><p>- not a list</p><p>1. not ordered</p><p>&gt; not quote</p>"
             "<p>*stars* [brackets] back\\slash snake_case _under_ a|b</p>")
    for s in ("\\# not a heading", "\\- not a list", "1\\. not ordered", "\\> not quote",
              "\\*stars\\* \\[brackets\\] back\\\\slash snake_case \\_under\\_"):
        assert s in out, s


def test_whitespace_collapse_and_blank_lines():
    out = md("<div>\n\n  <p>  a \n\t b  </p>\n\n\n<div><div><p>c</p></div></div>  <p>d<br>e</p></div>")
    assert out == "a b\n\nc\n\nd  \ne\n"


def test_blockquote_figure_media_sup_dl_hr():
    out = md("<blockquote><p>q1</p><blockquote><p>q2</p></blockquote></blockquote>"
             "<figure><img src='/i.png' alt='Alt'><figcaption>Cap</figcaption></figure>"
             "<video src='/v.mp4'></video><p>x<sup>2</sup> H<sub>2</sub>O</p><dl><dt>T</dt><dd>D</dd></dl><hr>")
    assert "> q1\n>\n> > q2" in out
    assert "![Alt](https://ex.com/i.png)\n\n*Cap*" in out
    assert "▶ video: [https://ex.com/v.mp4](https://ex.com/v.mp4)" in out
    assert "x^2 H~2O" in out and "**T**\n: D" in out and "---" in out


def test_deeply_nested_page_no_recursion_error():
    depth = 10_000
    html = "<html><body>" + "<div><span>" * depth + "deep text" + "</span></div>" * depth + "</body></html>"
    t = time.monotonic()
    root = parse(html)
    extract.prune(root, "https://ex.com/", "main")
    content = extract.select_content(root, "main", "")
    out = to_markdown(content, "https://ex.com/")
    assert "deep text" in out
    nested_lists = "<ul><li>" * 3000 + "x" + "</li></ul>" * 3000 + "<blockquote>" * 3000 + "q" + "</blockquote>" * 3000
    out2 = md(nested_lists)
    assert "x" in out2 and "q" in out2
    assert time.monotonic() - t < 15


def test_fifty_thousand_paragraphs_fast():
    html = "<html><body><article>" + "".join(f"<p>Paragraph number {i}, with some words.</p>" for i in range(50_000)) + \
           "</article></body></html>"
    t = time.monotonic()
    root = parse(html)
    extract.prune(root, "https://ex.com/", "main")
    content = extract.select_content(root, "main", "")
    out = to_markdown(content, "https://ex.com/")
    assert out.count("Paragraph number") == 50_000 and "Paragraph number 49999, with some words." in out
    assert time.monotonic() - t < 20


def test_unclosed_and_void_tags():
    out = md("<p>one<p>two<br>three<ul><li>a<li>b</ul><p>after <img src=x.png alt=pic> end")
    assert "one\n\ntwo  \nthree" in out and "- a\n- b" in out and "after ![pic](https://ex.com/dir/x.png) end" in out


# ---- main content extraction ----------------------------------------------------------------------------------
ARTICLE_PAGE = """<html><head><title>Real Story - Site</title>
<meta property="og:title" content="Real Story"><meta name="author" content="Ann Writer">
<meta property="article:published_time" content="2026-01-02T03:04:05Z"></head><body>
<header><nav><a href="/">Home</a> <a href="/a">About</a> <a href="/b">Blog</a></nav></header>
<div class="cookie-banner">We use cookies to improve things, accept all cookies please.</div>
<div class="layout">
 <aside class="sidebar"><h3>Popular</h3><ul><li><a href="/1">Popular post one</a></li><li><a href="/2">Popular two</a></li></ul></aside>
 <div class="content">
  <h1>Real Story</h1>
  <p>The first paragraph of the real story has plenty of words, commas, and detail, so it scores well.</p>
  <p>A second paragraph continues the story, adding more text, more commas, and a sense of narrative.</p>
  <p>Third paragraph: the conclusion, wrapping up, with yet more text to make the article clearly the main part.</p>
 </div>
 <div class="share-buttons"><a href="/s1">Share on X</a> <a href="/s2">Share on Facebook</a> <a href="/s3">Email</a></div>
 <section id="comments"><p>Great article, thanks, I loved it, really, a lot, best ever!</p></section>
 <div class="related-posts"><a href="/r1">Related one</a><a href="/r2">Related two</a></div>
</div>
<footer>Copyright footer text, all rights reserved, contact us.</footer>
<div hidden>hidden text</div><div style="display: none">invisible text</div>
</body></html>"""


def test_main_content_picks_article_over_boilerplate():
    root = parse(ARTICLE_PAGE)
    meta = extract.page_meta(root, "https://ex.com/story")
    assert meta["title"] == "Real Story" and meta["author"] == "Ann Writer" and meta["published"].startswith("2026-01-02")
    extract.prune(root, meta["base"], "main")
    out = to_markdown(extract.select_content(root, "main", meta["title"]), meta["base"])
    assert "first paragraph of the real story" in out and "conclusion" in out
    for junk in ("Home", "cookies", "Popular", "Share on", "Great article", "Related one", "Copyright",
                 "hidden text", "invisible text", "# Real Story"):
        assert junk not in out, junk


def test_full_mode_keeps_page_but_not_hidden():
    root = parse(ARTICLE_PAGE)
    extract.prune(root, "https://ex.com/", "full")
    out = to_markdown(extract.select_content(root, "full", ""), "https://ex.com/")
    assert "Popular" in out and "Copyright" in out and "first paragraph" in out
    assert "hidden text" not in out and "invisible text" not in out


# ---- clipping with images (fixture server, allow_all policy passed explicitly) --------------------------------
def image_page(site) -> str:
    noise = Image.frombytes("RGB", (40, 40), bytes((i * 37) % 251 for i in range(40 * 40 * 3)))
    buf = io.BytesIO()
    noise.save(buf, "PNG")
    big_inline = "data:image/png;base64," + __import__("base64").b64encode(buf.getvalue()).decode()
    return f"""<html><head><title>Images</title><meta property="og:image" content="/cover.png"></head><body><article>
<h1>Images</h1>
<p>Plenty of text here so the article is the main content of the page, with commas, words, and more words.</p>
<p>Even more text in a second paragraph, describing images, lazy loading, and other modern web habits.</p>
<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/lazy.png" alt="lazy">
<img srcset="/small.png 300w, /large.png 1200w, /mid.png 600w" src="/small.png" alt="srcset">
<picture><source type="image/avif" srcset="/pic.avif 2000w"><source srcset="/pic-small.png 400w, /pic-big.png 1600w"><img src="/pic-fallback.png" alt="picture"></picture>
<img class="lazyload" src="/placeholder.gif" alt="ns"><noscript><img src="/noscript.png" alt="ns"></noscript>
<img src="{big_inline}" alt="inline">
<img src="/pixel.gif" width="1" height="1" alt="">
<img src="/pixel2.gif" alt="">
<img src="/dup1.png" alt="dup one"><img src="/dup2.png" alt="dup two">
<img src="/notimage.png" alt="html">
<img src="/huge.png" alt="huge">
<img src="/broken.png" alt="broken">
<svg width="300" height="200" viewBox="0 0 300 200"><rect width="300" height="200" fill="red"/><script>alert(1)</script></svg>
</article></body></html>"""


def serve_images(site):
    site.add("/page", image_page(site))
    for name, color in (("lazy", (1, 1, 1)), ("large", (2, 2, 2)), ("small", (3, 3, 3)), ("mid", (4, 4, 4)),
                        ("pic-big", (5, 5, 5)), ("pic-small", (6, 6, 6)), ("pic-fallback", (7, 7, 7)),
                        ("noscript", (8, 8, 8)), ("cover", (9, 9, 9))):
        site.add(f"/{name}.png", png(color), "image/png")
    site.add("/pic.avif", b"\x00\x00\x00\x1cftypavif" + b"\x00" * 30, "image/avif")
    site.add("/dup1.png", png((10, 10, 10)), "image/png")
    site.add("/dup2.png", png((10, 10, 10)), "application/octet-stream")  # same bytes, sniffed as png
    site.add("/pixel2.gif", gif1x1(), "image/gif")
    site.add("/notimage.png", "<html>not an image</html>", "text/html")
    site.add("/huge.png", png((11, 11, 11)) + b"\x00" * (1024 * 1024 + 10), "image/png")


def test_clip_images_end_to_end(site, tmp_path):
    serve_images(site)
    logs = []
    res = clip(f"{site.base}/page", tmp_path / "clips", mode="static", policy=allow_all, chrome=None,
               settings={"max_image_mb": 1, "image_workers": 4}, log=logs.append)
    d = Path(res["out_dir"])
    assert d.parent == tmp_path / "clips" and d.name.endswith("-images")
    meta = json.loads((d / "meta.json").read_text())
    text = (d / "index.md").read_text()
    files = sorted(p.name for p in (d / "images").iterdir())
    fails = {f["url"].rsplit("/", 1)[-1]: f["reason"] for f in meta["failures"]}

    assert 'title: "Images"' in text and "# Images" in text
    assert f"{site.base}/lazy.png" not in text and any(f.endswith("-lazy.png") for f in files)  # data-src beats the placeholder
    assert any(f.endswith("-large.png") for f in files) and not any("small" in f and "pic" not in f for f in files)
    assert any(f.endswith("-pic-big.png") for f in files)  # largest common-format <source>
    assert any(f.endswith("-noscript.png") for f in files) and "placeholder" not in text
    assert any(f.startswith(("0", "1")) and "inline-" in f for f in files)  # data: URI decoded and saved
    assert any(f.endswith(".svg") for f in files)
    svg = next(p for p in (d / "images").iterdir() if p.suffix == ".svg").read_text()
    assert "<rect" in svg and "viewBox" in svg and "script" not in svg
    assert any(f.startswith("cover.") for f in files) and 'cover: "images/cover.png"' in text
    assert not any("pixel" in f for f in files) and "pixel.gif" not in text
    assert "tracking pixel" in fails["pixel2.gif"]
    assert "not an image" in fails["notimage.png"] and "limit" in fails["huge.png"] and "404" in fails["broken.png"]
    assert meta["counts"]["deduped"] == 1 and len([f for f in files if "dup" in f]) == 1
    dup_file = next(f for f in files if "dup" in f)
    assert text.count(f"images/{dup_file}") == 2  # both images point at the one saved file
    # markdown links are relative to the clip folder and point at existing files
    import re
    for target in re.findall(r"\]\((images/[^)\s]+)", text):
        assert (d / target).is_file(), target
    assert f"]({site.base}/broken.png)" in text  # failed downloads keep the remote URL
    # referer is the page, every image request went through the guard
    img_hits = [h for p, h in site.hits if p.endswith(".png")]
    assert img_hits and all(h.get("Referer") == f"{site.base}/page" for h in img_hits)
    assert (d.stat().st_mode & 0o777) == 0o700 and ((d / "index.md").stat().st_mode & 0o777) == 0o600
    assert any(line.startswith("images: ") for line in logs) and any(line.startswith("content: ") for line in logs)


def test_max_images_cap_is_reported(site, tmp_path):
    body = "".join(f'<p>Paragraph {i}, with words, words and words to be the main content.</p><img src="/i{i}.png">'
                   for i in range(8))
    site.add("/p", f"<html><body><article>{body}</article></body></html>")
    for i in range(8):
        site.add(f"/i{i}.png", png((i, 0, 0)), "image/png")
    res = clip(f"{site.base}/p", tmp_path, mode="static", policy=allow_all, chrome=None, settings={"max_images": 3})
    meta = json.loads((Path(res["out_dir"]) / "meta.json").read_text())
    assert meta["counts"]["saved"] == 3 and meta["counts"]["skipped"] == 5
    assert sum("max_images" in f["reason"] for f in meta["failures"]) == 5


def test_default_policy_refuses_fixture_server(site, tmp_path):
    site.add("/page", "<p>x</p>")
    with pytest.raises(BlockedURL):
        clip(f"{site.base}/page", tmp_path, mode="static", chrome=None)
    assert site.hits == []


def test_auto_mode_switches_to_browser_for_js_shell(site, tmp_path):
    site.add("/app", '<html><head><title>App</title></head><body><div id="root"></div>'
                     '<noscript>You need to enable JavaScript to run this app.</noscript>'
                     '<script src="/main.js"></script></body></html>')
    calls = []

    def fake_chrome(chrome, url, **kw):
        calls.append((chrome, url, kw["wait_ms"]))
        return ("<html><head><title>App</title></head><body><div id='root'><article><h1>Rendered</h1>"
                + "<p>Rendered by JavaScript, with long text, many commas, and real content.</p>" * 20
                + "</article></div></body></html>")
    res = clip(f"{site.base}/app", tmp_path, mode="auto", policy=allow_all, chrome="/fake/chrome",
               browser_runner=fake_chrome)
    assert res["mode"] == "browser" and calls and calls[0][1] == f"{site.base}/app"
    meta = json.loads((Path(res["out_dir"]) / "meta.json").read_text())
    assert meta["mode"] == "browser" and meta["js_reason"]
    assert "Rendered by JavaScript" in (Path(res["out_dir"]) / "index.md").read_text()

    # a normal page stays static
    site.add("/plain", ARTICLE_PAGE.replace("</h1>", "</h1>" + "<p>More of the real story, with words, commas, and detail.</p>" * 10))
    res2 = clip(f"{site.base}/plain", tmp_path, mode="auto", policy=allow_all, chrome="/fake/chrome",
                browser_runner=fake_chrome)
    assert res2["mode"] == "static" and len(calls) == 1
    assert Path(res2["out_dir"]).name.endswith("real-story")


def test_unique_folder_names_and_raw_html(site, tmp_path):
    site.add("/plain", ARTICLE_PAGE)
    a = clip(f"{site.base}/plain", tmp_path, mode="static", policy=allow_all, chrome=None, save_html=True)
    b = clip(f"{site.base}/plain", tmp_path, mode="static", policy=allow_all, chrome=None)
    assert Path(b["out_dir"]).name == Path(a["out_dir"]).name + "-2"
    assert (Path(a["out_dir"]) / "page.html").read_text().startswith("<html>")
    assert not (Path(b["out_dir"]) / "page.html").exists()
    fm = (Path(a["out_dir"]) / "index.md").read_text().split("---")[1]
    assert 'author: "Ann Writer"' in fm and "published:" in fm and "clipped_at:" in fm and "source:" in fm


def test_charset_from_meta(site, tmp_path):
    body = '<html><head><meta charset="iso-8859-1"><title>Caf\xe9</title></head><body><article>' + \
           "<p>Un caf\xe9 tr\xe8s cr\xe9meux, avec du lait, du sucre, et beaucoup de texte pour l'article.</p>" * 10 + \
           "</article></body></html>"
    site.add("/fr", body.encode("latin-1"), "text/html")
    res = clip(f"{site.base}/fr", tmp_path, mode="static", policy=allow_all, chrome=None)
    assert "café très crémeux" in (Path(res["out_dir"]) / "index.md").read_text()


# ---- API + job --------------------------------------------------------------------------------------------------
@pytest.fixture()
def app_client(tmp_path, monkeypatch):
    from app.core import context
    from app.core.jobs import JobManager
    from app.core.settings_store import SettingsStore
    from app.main import app
    import importlib
    router_mod = importlib.import_module("app.services.clipper.router")  # the module, not the APIRouter

    monkeypatch.setattr(context, "settings", SettingsStore(tmp_path / "settings"))
    monkeypatch.setattr(context, "jobs", JobManager(tmp_path / "jobs"))
    # the worker is a separate process: a wrapper runs the real CLI with the test-only allow_all policy
    wrapper = tmp_path / "clip_worker.py"
    wrapper.write_text(
        "import sys\n"
        f"sys.path.insert(0, {str(ROOT)!r})\n"
        "from app.services.clipper import cli, netguard\n"
        "sys.exit(cli.main(sys.argv[1:], policy=netguard.allow_all, chrome=None))\n")
    monkeypatch.setattr(router_mod, "_python_cmd", lambda: [sys.executable, str(wrapper)])
    # the request-time pre-check refuses 127.0.0.1 too; the fixture server needs the test policy there as well
    monkeypatch.setattr(router_mod, "_syntax_check", lambda url: check_url(url, allow_all))
    with TestClient(app) as c:
        c.put("/api/services/clipper/settings", json={"clips_dir": str(tmp_path / "clips")}, headers=H)
        yield c, context, tmp_path


def wait_job(context, job_id, timeout=60):
    j = context.jobs.get(job_id)
    end = time.time() + timeout
    while not j.done and time.time() < end:
        time.sleep(0.05)
    assert j.done
    return j


def test_job_end_to_end_api(app_client, site):
    c, context, tmp_path = app_client
    serve_images(site)
    st = c.get("/api/clipper/status").json()
    assert st["writable"] and st["clips_dir"] == str(tmp_path / "clips")
    assert c.post("/api/clipper/clip", json={"url": "ftp://x.com/"}, headers=H).status_code == 400
    assert c.post("/api/clipper/clip", json={"url": "x"}).status_code == 403  # header required

    url = f"{site.base}/page?token=SECRET123&x=1"
    job = c.post("/api/clipper/clip", json={"url": url}, headers=H).json()
    assert "SECRET123" not in job["title"] and "SECRET123" not in json.dumps(job["meta"])
    assert "SECRET123" not in (job["lock_key"] or "")
    j = wait_job(context, job["id"])
    lines = j.output_since(0)["lines"]
    assert j.status == "succeeded", lines
    assert lines[0].startswith("fetching") and any(ln.startswith("mode: static") for ln in lines)
    done = json.loads(next(ln for ln in lines if ln.startswith("CLIP_DONE "))[len("CLIP_DONE "):])
    name = done["name"]

    hist = c.get("/api/clipper/clips").json()["clips"]
    assert hist[0]["name"] == name and hist[0]["images_saved"] >= 5 and hist[0]["bytes"] > 0
    detail = c.get(f"/api/clipper/clips/{name}").json()
    assert detail["markdown"].startswith("---") and detail["images"]
    assert detail["meta"]["url"] == url  # local meta.json keeps the full URL

    img = detail["images"][0]
    r = c.get(f"/api/clipper/clips/{name}/file", params={"path": img})
    assert r.status_code == 200 and r.headers["content-type"].startswith("image/")
    assert r.headers["x-content-type-options"] == "nosniff" and "sandbox" in r.headers["content-security-policy"]
    svg = next(i for i in detail["images"] if i.endswith(".svg"))
    r = c.get(f"/api/clipper/clips/{name}/file", params={"path": svg})
    assert r.headers["content-type"].startswith("image/svg+xml") and "sandbox" in r.headers["content-security-policy"]
    r = c.get(f"/api/clipper/clips/{name}/file", params={"path": "index.md"})
    assert r.status_code == 200 and "sandbox" in r.headers["content-security-policy"]

    z = c.get(f"/api/clipper/clips/{name}/zip")
    import zipfile
    names = zipfile.ZipFile(io.BytesIO(z.content)).namelist()
    assert f"{name}/index.md" in names and f"{name}/meta.json" in names and any("/images/" in n for n in names)

    # search provider
    from app.services.clipper.search import search
    assert search("images")[0]["ref"] == name

    # delete = move to trash
    assert c.post(f"/api/clipper/clips/{name}/delete", headers=H).status_code == 200
    clips = tmp_path / "clips"
    assert not (clips / name).exists()
    trashed = list((clips / ".trash").iterdir())
    assert len(trashed) == 1 and trashed[0].name.endswith(name) and (trashed[0] / "index.md").is_file()
    assert c.get("/api/clipper/clips").json()["clips"] == []

    # the audit log never holds the query string
    audit_file = Path(__import__("os").environ["EU_DATA_DIR"]) / "audit" / "audit.jsonl"
    events = [json.loads(x) for x in audit_file.read_text().splitlines()]
    clip_events = [e for e in events if e["kind"] == "clip"]
    assert {e["action"] for e in clip_events} >= {"create", "delete"}
    assert all("SECRET123" not in json.dumps(e) and "token=" not in json.dumps(e) for e in events)


def test_job_reports_errors(app_client, site):
    c, context, _ = app_client
    job = c.post("/api/clipper/clip", json={"url": f"{site.base}/missing"}, headers=H).json()
    j = wait_job(context, job["id"])
    assert j.status == "failed"
    assert any(ln.startswith("CLIP_ERROR ") and "404" in ln for ln in j.output_since(0)["lines"])


def test_job_cancel_stops_worker_and_leaves_nothing(app_client, site):
    c, context, tmp_path = app_client
    body = "".join(f'<p>Paragraph {i}, with words, words and words to be the main content.</p><img src="/slow{i}.png">'
                   for i in range(6))
    site.add("/slowpage", f"<html><body><article>{body}</article></body></html>")
    for i in range(6):
        site.add(f"/slow{i}.png", png((i, 9, 9)), "image/png")
        site.delay[f"/slow{i}.png"] = 20
    job = c.post("/api/clipper/clip", json={"url": f"{site.base}/slowpage"}, headers=H).json()
    j = context.jobs.get(job["id"])
    end = time.time() + 20
    while time.time() < end and not any(ln.startswith("images:") for ln in j.output_since(0)["lines"]):
        time.sleep(0.05)
    t = time.time()
    c.post(f"/api/jobs/{job['id']}/cancel", headers=H)
    wait_job(context, job["id"], timeout=15)
    assert j.status == "cancelled" and time.time() - t < 4  # no waiting for the 20 s downloads
    clips = tmp_path / "clips"
    assert not clips.exists() or [p.name for p in clips.iterdir()] == []  # temp folder removed, nothing published


def test_file_endpoint_refuses_escapes(app_client, tmp_path):
    c, _, _ = app_client
    clips = tmp_path / "clips"
    d = clips / "2026-01-01-x"
    (d / "images").mkdir(parents=True)
    (d / "meta.json").write_text(json.dumps({"title": "x", "url": "https://e.com"}))
    (d / "index.md").write_text("# x")
    secret = tmp_path / "secret.txt"
    secret.write_text("top secret")
    (d / "images" / "link.png").symlink_to(secret)
    (clips / "2026-01-01-y").symlink_to(tmp_path)  # a clip folder that is a symlink out of clips_dir
    for p in ("../../secret.txt", "../2026-01-01-x/index.md", "/etc/passwd", "images/../../../secret.txt",
              "images/link.png", "images"):
        r = c.get("/api/clipper/clips/2026-01-01-x/file", params={"path": p})
        assert r.status_code in (400, 404), p
        assert "top secret" not in r.text
    for name in ("..", ".trash", "2026-01-01-y", "a/b"):
        r = c.get(f"/api/clipper/clips/{name}/file", params={"path": "secret.txt"})
        assert r.status_code in (400, 404), name
    assert c.get("/api/clipper/clips/2026-01-01-x/file", params={"path": "index.md"}).text == "# x"


def test_writes_blocked_in_unignored_git_repo(app_client, tmp_path):
    c, _, _ = app_client
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    c.put("/api/services/clipper/settings", json={"clips_dir": str(repo / "clips")}, headers=H)
    st = c.get("/api/clipper/status").json()
    assert not st["writable"] and not st["git"]["safe"]
    r = c.post("/api/clipper/clip", json={"url": "https://example.com/"}, headers=H)
    assert r.status_code == 409 and "git" in r.json()["detail"]
    (repo / ".gitignore").write_text("clips/\n")
    assert c.get("/api/clipper/status").json()["writable"]
    # inside the app folder only private/ is allowed
    c.put("/api/services/clipper/settings", json={"clips_dir": str(ROOT / "web" / "clips")}, headers=H)
    st = c.get("/api/clipper/status").json()
    assert st["problem"] and not st["writable"]
    assert c.post("/api/clipper/clip", json={"url": "https://example.com/"}, headers=H).status_code == 409
