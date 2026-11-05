"""Dev Tools — formats group: YAML ⇄ JSON backend, plus the pure JS logic of the YAML, Markdown and Unicode tools
(run through node, skipped when node is not installed — same pattern as tests/test_devtools.py)."""

import json
import shutil
import subprocess

import pytest
from fastapi.testclient import TestClient

H = {"x-everyday-utility": "1"}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    from app.core import config, context
    from app.core.jobs import JobManager
    from app.core.settings_store import SettingsStore

    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(context, "jobs", JobManager(tmp_path / "jobs"))
    monkeypatch.setattr(context, "settings", SettingsStore(tmp_path / "settings"))
    from app.main import app

    with TestClient(app) as c:
        yield c


def to_json(client, text, **kw):
    r = client.post("/api/devtools/yaml/to-json", json={"text": text, **kw}, headers=H)
    assert r.status_code == 200, r.text
    return r.json()


def from_json(client, text, **kw):
    r = client.post("/api/devtools/yaml/from-json", json={"text": text, **kw}, headers=H)
    assert r.status_code == 200, r.text
    return r.json()


# ------------------------------------------------------------------ YAML → JSON

def test_yaml_to_json_basic(client):
    r = to_json(client, "name: api\nreplicas: 2\nports: [80, 443]\nenabled: yes\nnothing: ~\n")
    assert r["ok"] is True
    assert r["data"] == {"name": "api", "replicas": 2, "ports": [80, 443], "enabled": True, "nothing": None}
    assert json.loads(r["json"]) == r["data"]
    assert r["json"].startswith('{\n  "name"')


def test_yaml_to_json_options_and_big_ints(client):
    r = to_json(client, "b: 1\na: 12345678901234567890\n", indent=0, sort_keys=True)
    assert r["json"] == '{"a":12345678901234567890,"b":1}'  # exact digits survive in the JSON text
    assert '\n    "a"' in to_json(client, "a: 1", indent=4)["json"]


def test_yaml_merge_keys_and_anchors(client):
    r = to_json(client, "base: &b {cpu: 1, mem: 2}\nlimits:\n  <<: *b\n  mem: 4\n")
    assert r["data"]["limits"] == {"cpu": 1, "mem": 4}


def test_yaml_multi_document(client):
    text = "a: 1\n---\nb: 2\n---\n- x\n"
    r = to_json(client, text, multi=True)
    assert r["ok"] and r["documents"] == [{"a": 1}, {"b": 2}, ["x"]] and r["count"] == 3
    single = to_json(client, text)
    assert single["ok"] is False and "single document" in single["error"]["message"]


def test_yaml_error_has_line_and_column(client):
    r = to_json(client, "ok: 1\nlist: [1, 2\nnext: 3\n")
    assert r["ok"] is False
    err = r["error"]
    assert err["line"] == 3 and err["column"] >= 1 and err["message"]
    bad_indent = to_json(client, "a:\n  b: 1\n c: 2\n")
    assert bad_indent["ok"] is False and bad_indent["error"]["line"] == 3


def test_yaml_unsafe_tags_are_not_constructed(client, tmp_path):
    marker = tmp_path / "pwned"
    for text in (f"!!python/object/apply:os.system ['touch {marker}']",
                 "!!python/object/new:subprocess.Popen [['true']]",
                 "a: !!python/name:os.system"):
        r = to_json(client, text)
        assert r["ok"] is False and "constructor" in r["error"]["message"]
    assert not marker.exists()


def test_yaml_unusual_values_become_json(client):
    r = to_json(client, "when: 2024-05-01\nat: 2024-05-01T10:00:00Z\n2: two\ntrue: t\ninf: .inf\nbin: !!binary aGk=\ns: !!set {x}\n")
    d = r["data"]
    assert r["ok"] and d["when"] == "2024-05-01" and d["at"].startswith("2024-05-01T10:00:00")
    assert d["2"] == "two" and d["true"] == "t" and d["inf"] == ".inf" and d["bin"] == "aGk=" and d["s"] == ["x"]
    assert len(r["notes"]) >= 4


def test_yaml_lone_surrogate_does_not_break_response(client):
    r = to_json(client, 'a: "\\ud800x"\n')
    assert r["ok"] and r["data"]["a"] == "\ufffdx" and any("surrogate" in n for n in r["notes"])


def billion_laughs(levels=9, width=9):
    lines = [f'a0: &a0 [{", ".join(["lol"] * width)}]']
    for i in range(1, levels):
        lines.append(f'a{i}: &a{i} [{", ".join([f"*a{i-1}"] * width)}]')
    return "\n".join(lines) + "\n"


def test_yaml_alias_bomb_is_refused(client):
    r = to_json(client, billion_laughs())  # 9^9 ≈ 387 million values if expanded
    assert r["ok"] is False and "alias bomb" in r["error"]["message"]
    r = to_json(client, "ok: 1\n---\n" + billion_laughs(), multi=True)
    assert r["ok"] is False and "alias bomb" in r["error"]["message"]


def test_yaml_small_alias_reuse_is_fine(client):
    r = to_json(client, billion_laughs(levels=4, width=5))  # 5^4 = 625 values
    assert r["ok"] is True and len(r["data"]["a3"]) == 5


def test_yaml_expanded_size_counts_shared_nodes():
    import yaml

    from app.services.devtools.yaml_api import MAX_EXPANDED_NODES, expanded_size

    node = yaml.compose(billion_laughs(levels=3, width=3), Loader=yaml.SafeLoader)
    # root mapping (1) + 3 keys + a0 (1+3) + a1 (1+3*4) + a2 (1+3*13) = 1 + 3 + 4 + 13 + 40
    assert expanded_size(node) == 61
    big = yaml.compose(billion_laughs(), Loader=yaml.SafeLoader)
    assert expanded_size(big) == MAX_EXPANDED_NODES + 1  # capped, not computed in full


def test_yaml_recursive_alias_is_refused(client):
    r = to_json(client, "a: &a [1, *a]\n")
    assert r["ok"] is False and "refers to itself" in r["error"]["message"] and r["error"]["line"] == 1


def test_yaml_deep_nesting_is_an_error_not_a_crash(client):
    r = to_json(client, "[" * 50_000)
    assert r["ok"] is False and "deeply" in r["error"]["message"]


def test_yaml_size_limit(client):
    from app.services.devtools.yaml_api import MAX_BYTES

    r = client.post("/api/devtools/yaml/to-json", json={"text": "a" * (MAX_BYTES + 1)}, headers=H)
    assert r.status_code == 413
    r = client.post("/api/devtools/yaml/from-json", json={"text": "é" * (MAX_BYTES // 2 + 1)}, headers=H)
    assert r.status_code == 413  # counted in UTF-8 bytes, not characters


def test_yaml_requires_app_header(client):
    r = client.post("/api/devtools/yaml/to-json", json={"text": "a: 1"})
    assert r.status_code == 403


def test_yaml_empty_document(client):
    assert to_json(client, "")["data"] is None
    assert to_json(client, "# only a comment\n", multi=True)["documents"] == []


# ------------------------------------------------------------------ JSON → YAML

def test_json_to_yaml_block_and_flow(client):
    r = from_json(client, '{"name": "café", "ports": [80, 443], "nested": {"k": null}}')
    assert r["ok"] and r["yaml"] == "name: café\nports:\n- 80\n- 443\nnested:\n  k: null\n"
    flow = from_json(client, '{"a": [1, 2]}', flow=True)["yaml"]
    assert flow.strip() == "{a: [1, 2]}"


def test_json_to_yaml_options(client):
    r = from_json(client, '{"b": {"x": 1}, "a": 2}', sort_keys=True, indent=4)
    assert r["yaml"] == "a: 2\nb:\n    x: 1\n"
    unsorted = from_json(client, '{"b": 1, "a": 2}')["yaml"]
    assert unsorted.index("b:") < unsorted.index("a:")


def test_json_to_yaml_multi_documents_round_trip(client):
    r = from_json(client, '[{"a": 1}, {"b": 2}]', multi=True)
    assert r["yaml"] == "---\na: 1\n---\nb: 2\n"
    back = to_json(client, r["yaml"], multi=True)
    assert back["documents"] == [{"a": 1}, {"b": 2}]


def test_json_to_yaml_quotes_ambiguous_strings(client):
    import yaml

    r = from_json(client, '{"v": "yes", "n": "007", "t": "true", "e": ""}')
    assert yaml.safe_load(r["yaml"]) == {"v": "yes", "n": "007", "t": "true", "e": ""}


def test_json_to_yaml_error_position(client):
    r = from_json(client, '{\n  "a": 1,\n  "b": \n}')
    assert r["ok"] is False and r["error"]["line"] == 4 and r["error"]["column"] == 1


def test_json_to_yaml_deep_nesting(client):
    r = from_json(client, "[" * 100_000 + "]" * 100_000)
    assert r["ok"] is False and "deeply" in r["error"]["message"]


def test_frontend_files_served(client):
    for path in ("js/services/devtools/tools/yaml.js", "js/services/devtools/tools/yaml.logic.js",
                 "js/services/devtools/tools/markdown.js", "js/services/devtools/tools/markdown.logic.js",
                 "js/services/devtools/tools/unicode.js", "js/services/devtools/tools/unicode.logic.js",
                 "css/devtools-formats.css"):
        assert client.get(f"/static/{path}").status_code == 200


def test_no_unsafe_dom_sinks_or_network_in_frontend():
    from app.core import config

    tools = config.WEB_DIR / "js" / "services" / "devtools" / "tools"
    for name in ("yaml", "markdown", "unicode"):
        for path in (tools / f"{name}.js", tools / f"{name}.logic.js"):
            src = path.read_text()
            for sink in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"):
                assert sink not in src, f"{path.name} uses {sink}"
            assert "fetch(" not in src
    logic = [(tools / f"{n}.logic.js").read_text() for n in ("yaml", "markdown", "unicode")]
    assert all("document." not in s and "window." not in s for s in logic)  # pure logic


def test_requirements_has_pyyaml():
    from app.core import config

    req = (config.WEB_DIR.parent / "requirements.txt").read_text().splitlines()
    assert "pyyaml>=6" in req


# ------------------------------------------------------------------ JS logic via node

def run_node(module, script):
    """Runs `script` as an ES module with tools/<module>.logic.js imported as M; returns its printed JSON."""
    from app.core import config

    if not shutil.which("node"):
        pytest.skip("node is not installed")
    path = (config.WEB_DIR / "js" / "services" / "devtools" / "tools" / f"{module}.logic.js").as_uri()
    src = f"import * as M from '{path}';\n{script}"
    out = subprocess.run(["node", "--input-type=module", "-e", src], capture_output=True, text=True, check=True, timeout=60)
    return json.loads(out.stdout)


def md(text):
    return run_node("markdown", f"console.log(JSON.stringify(M.toHtml(M.parseMarkdown({json.dumps(text)}))));")


def test_yaml_line_col_offset():
    r = run_node("yaml", "console.log(JSON.stringify([M.lineColToOffset('ab\\ncde\\nf', 2, 2), M.lineColToOffset('ab', 9, 9), M.lineColToOffset('', 1, 1)]));")
    assert r == [4, 2, 0]


def test_markdown_blocks():
    html = md("Title\n=====\n\n## Sub ##\n\npara *em* **strong** ~~del~~ `code`\n\n---\n\n> quote\nlazy\n\n    indented\n")
    assert '<h1 id="title">Title</h1>' in html and '<h2 id="sub">Sub</h2>' in html
    assert "<p>para <em>em</em> <strong>strong</strong> <del>del</del> <code>code</code></p>" in html
    assert "<hr>" in html and "<blockquote>\n<p>quote\nlazy</p>\n</blockquote>" in html
    assert "<pre><code>indented</code></pre>" in html


def test_markdown_lists_and_tasks():
    html = md("- a\n- b\n  - nested\n- [ ] todo\n- [x] done\n\n3. three\n4. four\n")
    assert '<ul class="contains-task-list">' in html
    assert "<li>b<ul>\n<li>nested</li>\n</ul>\n</li>" in html
    assert '<li class="task-list-item"><input type="checkbox" disabled> todo</li>' in html
    assert '<li class="task-list-item"><input type="checkbox" disabled checked> done</li>' in html
    assert '<ol start="3">\n<li>three</li>\n<li>four</li>\n</ol>' in html
    loose = md("- a\n\n- b\n")
    assert "<li><p>a</p>\n</li>" in loose


def test_markdown_fenced_code_and_table():
    html = md("```python\nprint('<x>')\n```\n\n| L | C | R |\n|:--|:-:|--:|\n| a | `b|c` | c \\| d |\n")
    assert '<pre><code class="language-python">print(&#39;&lt;x&gt;&#39;)</code></pre>' in html
    assert '<th style="text-align: left">L</th><th style="text-align: center">C</th><th style="text-align: right">R</th>' in html
    assert '<td style="text-align: center"><code>b|c</code></td><td style="text-align: right">c | d</td>' in html


def test_markdown_html_stays_text():
    html = md('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)> **<b>x</b>**')
    assert "<script" not in html and "<img src=x" not in html
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in html and "&lt;b&gt;x&lt;/b&gt;" in html


@pytest.mark.parametrize("src", [
    "[x](javascript:alert(1))", "[x](JAVASCRIPT:alert(1))", "[x](java\tscript:alert(1))", "[x](data:text/html,hi)",
    "[x](vbscript:msgbox)", "<javascript:alert(1)>", "[x][r]\n\n[r]: javascript:alert(1)",
])
def test_markdown_unsafe_links_are_text(src):
    html = md(src)
    assert "<a " not in html and "href" not in html


@pytest.mark.parametrize("src, href", [
    ("[x](https://example.com/a_(b))", "https://example.com/a_(b)"), ("[x](mailto:me@example.com)", "mailto:me@example.com"),
    ("[x](./docs/readme.md)", "./docs/readme.md"), ("[x](#install)", "#install"), ("<http://a.example>", "http://a.example"),
    ("see www.example.com.", "https://www.example.com"), ("[x][R]\n\n[r]: https://ref.example \"T\"", "https://ref.example"),
    ("<me@example.com>", "mailto:me@example.com"),
])
def test_markdown_safe_links(src, href):
    assert f'href="{href}"' in md(src)


def test_markdown_images():
    assert '<img src="https://x.example/i.png" alt="alt text" title="T">' in md('![alt *text*](https://x.example/i.png "T")')
    assert '<img src="data:image/png;base64,AAAA" alt="d">' in md("![d](data:image/png;base64,AAAA)")
    for bad in ("![a](javascript:x)", "![a](data:text/html,<b>)", "![a](./local.png)", "![a](file:///etc/passwd)"):
        assert "<img" not in md(bad)


def test_markdown_breaks_and_escapes():
    html = md("one  \ntwo\\\nthree\nfour \\*not em\\*")
    assert html == "<p>one<br>two<br>three\nfour *not em*</p>\n"


def test_markdown_headings_toc_and_stats():
    r = run_node("markdown", """const t = M.parseMarkdown('# Intro\\n## Set *up*\\n# Intro\\n\\nSome words here, five words.');
    console.log(JSON.stringify([M.headings(t), M.stats('', t).words]));""")
    assert r[0] == [{"level": 1, "text": "Intro", "id": "intro"}, {"level": 2, "text": "Set up", "id": "set-up"},
                    {"level": 1, "text": "Intro", "id": "intro-1"}]
    assert r[1] == 9


def test_markdown_pathological_inputs_are_fast():
    r = run_node("markdown", """const cases = ['['.repeat(50000), '[a]('.repeat(20000), '*a '.repeat(30000), '> '.repeat(5000) + 'x',
      Array.from({length: 3000}, (_, i) => '`'.repeat(i % 50 + 1)).join(' '), '*a '.repeat(5000) + 'b' + ' c*'.repeat(5000),
      '![!['.repeat(3000) + 'x](y)'.repeat(3000), '- '.repeat(3000) + 'x'];
    const t = Date.now(); for (const c of cases) M.toHtml(M.parseMarkdown(c)); console.log(Date.now() - t);""")
    assert r < 5000


def test_markdown_html_document_escapes_title():
    r = run_node("markdown", "console.log(JSON.stringify(M.htmlDocument(M.parseMarkdown('# a'), '</title><script>')));")
    assert "<title>&lt;/title&gt;&lt;script&gt;</title>" in r and '<h1 id="a">a</h1>' in r


def test_unicode_char_info():
    r = run_node("unicode", """console.log(JSON.stringify([0x200B, 0xFEFF, 0x00A0, 0x202E, 0x0430, 0x1F600, 0x41, 0xD800, 0x0301]
      .map((cp) => { const i = M.charInfo(cp); return [i.hex, i.name, i.category, i.utf8, i.invisible, i.flags, i.looksLike]; })));""")
    zwsp, bom, nbsp, rlo, cyr_a, emoji, a, lone, comb = r
    assert zwsp[:5] == ["U+200B", "ZERO WIDTH SPACE", "format", "E2 80 8B", True]
    assert bom[1].endswith("BYTE ORDER MARK") and "bom" in bom[5]
    assert nbsp[1] == "NO-BREAK SPACE" and nbsp[4] is True and "odd-space" in nbsp[5]
    assert rlo[1] == "RIGHT-TO-LEFT OVERRIDE" and "bidi-control" in rlo[5]
    assert cyr_a[1] == "CYRILLIC SMALL LETTER A" and cyr_a[6] == "a" and "homoglyph" in cyr_a[5]
    assert emoji[2] == "emoji" and emoji[3] == "F0 9F 98 80"
    assert a[2] == "letter" and a[4] is False and a[5] == []
    assert lone[2] == "surrogate" and lone[3] is None
    assert comb[2] == "mark"


def test_unicode_analyze_graphemes_and_summary():
    r = run_node("unicode", r"""const a = M.analyze('\uFEFFp\u0430y\u200Bl\r\nx\ny\rz e\u0301 👨‍👩‍👧 🇩🇪 \u202Eevil\u202C \uD800');
    console.log(JSON.stringify({ chars: a.chars.map((c) => [c.display, c.cps.length]), s: a.summary }));""")
    chars = dict(r["chars"])
    assert chars["BOM"] == 1 and chars["ZWSP"] == 1 and chars["␍␊"] == 2 and chars["e\u0301"] == 2
    assert chars["👨‍👩‍👧"] == 5 and chars["🇩🇪"] == 2 and chars["RLO"] == 1 and chars["◌"] == 1
    s = r["s"]
    assert (s["lineEndings"], s["lf"], s["crlf"], s["cr"]) == ("mixed", 1, 1, 1)
    assert s["bom"] is True and s["trojan"] == 2 and s["homoglyphs"] == 1 and s["loneSurrogates"] == 1
    assert s["mixedScripts"]["words"][0]["word"] == "pаy" and s["mixedScripts"]["words"][0]["scripts"] == ["Latin", "Cyrillic"]
    assert s["invisible"] == 7  # BOM, ZWSP, 2×ZWJ, RLO, PDF, lone surrogate — and no false positives for CR/LF
    assert s["utf16Units"] == 39 and s["codePoints"] == 34


def test_unicode_summary_line_endings():
    r = run_node("unicode", r"""console.log(JSON.stringify(['a\nb\n', 'a\r\nb\r\n', 'a\rb', 'abc', ''].map((t) => M.summarize(t).lineEndings)));""")
    assert r == ["LF", "CRLF", "CR", "none", "none"]


def test_unicode_render_cap():
    r = run_node("unicode", "const a = M.analyze('x'.repeat(6000)); console.log(JSON.stringify([a.chars.length, a.truncated, a.graphemes, a.summary.codePoints]));")
    assert r == [5000, True, 6000, 6000]


def test_unicode_clean_steps():
    r = run_node("unicode", r"""const t = '\uFEFFa\u200Bb\u00A0c\u202Fd\r\ne\rf\u202Eg\u2066h\u2069 👨‍👩‍👧 Crème “Straße” — p\u0430yp\u0430l Привет';
    console.log(JSON.stringify([
      M.applyClean(t, ['bom']).startsWith('a'),
      M.applyClean(t, ['zw']).includes('\u200B'), M.applyClean(t, ['zw']).includes('👨‍👩‍👧'),
      M.applyClean('a\u00A0b\u202Fc', ['nbsp']),
      M.applyClean('a\r\nb\rc\nd', ['eol'], { eol: 'LF' }), M.applyClean('a\nb\r\nc', ['eol'], { eol: 'CRLF' }),
      M.applyClean('x\u202Ey\u2066z\u2069\u200E', ['bidi']),
      M.applyClean('e\u0301', ['normalize'], { form: 'NFC' }), M.applyClean('é', ['normalize'], { form: 'NFD' }).length,
      M.applyClean('ﬁ①', ['normalize'], { form: 'NFKC' }),
      M.applyClean('Crème “Straße” — Łódź…', ['fold']),
      M.applyClean('p\u0430yp\u0430l Привет', ['homoglyphs']),
    ]));""")
    assert r == [True, False, True, "a b c", "a\nb\nc\nd", "a\r\nb\r\nc", "xyz", "é", 2, "fi1",
                 'Creme "Strasse" - Lodz...', "paypal Привет"]
