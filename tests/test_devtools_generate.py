"""Dev Tools — Generate group: fake data (fake.logic.js) and the from-scratch QR encoder (qr.logic.js).

The pure JS logic runs under node (skipped when node is missing). QR output is checked against the worked
"HELLO WORLD" 1-Q example (Thonky QR tutorial / ISO 18004 annex), BCH tables, structural invariants for every
version, and — when OpenCV happens to be installed — by actually decoding the rendered symbols.
"""

import json
import shutil
import subprocess

import pytest

from app.core import config

TOOLS_DIR = config.WEB_DIR / "js" / "services" / "devtools" / "tools"


def _run(module, script):
    """Runs `script` as an ES module with <module>.logic.js imported as L; returns its printed JSON."""
    if not shutil.which("node"):
        pytest.skip("node is not installed")
    src = f"import * as L from '{(TOOLS_DIR / f'{module}.logic.js').as_uri()}';\n{script}"
    out = subprocess.run(["node", "--input-type=module", "-e", src], capture_output=True, text=True, check=True, timeout=120)
    return json.loads(out.stdout)


@pytest.fixture()
def client(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from app.core import context
    from app.core.jobs import JobManager
    from app.core.settings_store import SettingsStore

    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(context, "jobs", JobManager(tmp_path / "jobs"))
    monkeypatch.setattr(context, "settings", SettingsStore(tmp_path / "settings"))
    from app.main import app

    with TestClient(app) as c:
        yield c


def test_frontend_files_served(client):
    for path in ("js/services/devtools/tools/fake.js", "js/services/devtools/tools/fake.logic.js",
                 "js/services/devtools/tools/qr.js", "js/services/devtools/tools/qr.logic.js", "css/devtools-generate.css"):
        assert client.get(f"/static/{path}").status_code == 200, path


@pytest.mark.parametrize("name", ["fake.js", "fake.logic.js", "qr.js", "qr.logic.js"])
def test_js_syntax_and_no_html_injection(name):
    src = (TOOLS_DIR / name).read_text()
    for sink in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"):
        assert sink not in src, f"{name} uses {sink}"
    assert "http://" not in src.replace("http://www.w3.org/2000/svg", "")  # offline: no CDN / network URLs
    if shutil.which("node"):
        subprocess.run(["node", "--check", str(TOOLS_DIR / name)], check=True)


# ====================================================================== QR
def test_qr_hello_world_1q_codewords():
    r = _run("qr", """const r = L.encodeQr('HELLO WORLD', {ecl: 'Q'});
    console.log(JSON.stringify({v: r.version, mode: r.mode, size: r.size, data: r.dataCodewords, cw: r.codewords}));""")
    assert (r["v"], r["mode"], r["size"]) == (1, "alphanumeric", 21)
    assert bytes(r["data"]).hex(" ") == "20 5b 0b 78 d1 72 dc 4d 43 40 ec 11 ec"
    assert r["cw"][13:] == [168, 72, 22, 82, 217, 54, 156, 0, 46, 15, 180, 122, 16]  # EC codewords from the worked example


def _reference_v1(codewords, format_string, mask):
    """Independent version-1 builder (no shared code with qr.logic.js): function patterns, zig-zag placement,
    mask, and a 15-char format string taken from the published table (char 0 = most significant bit)."""
    n = 21
    m = [[None] * n for _ in range(n)]
    for r0, c0 in ((0, 0), (0, 14), (14, 0)):
        for r in range(-1, 8):
            for c in range(-1, 8):
                if 0 <= r0 + r < n and 0 <= c0 + c < n:
                    m[r0 + r][c0 + c] = 0 <= r <= 6 and 0 <= c <= 6 and (r in (0, 6) or c in (0, 6) or (2 <= r <= 4 and 2 <= c <= 4))
    for i in range(8, 13):
        m[6][i] = m[i][6] = i % 2 == 0
    m[13][8] = True  # dark module at (4v + 9, 8)
    f = [ch == "1" for ch in format_string]
    for i, (r, c) in enumerate([(8, 0), (8, 1), (8, 2), (8, 3), (8, 4), (8, 5), (8, 7), (8, 8), (7, 8),
                                (5, 8), (4, 8), (3, 8), (2, 8), (1, 8), (0, 8)]):
        m[r][c] = f[i]
    for i in range(7):
        m[20 - i][8] = f[i]
    for i in range(7, 15):
        m[8][13 + i - 7] = f[i]
    bits = [b >> (7 - k) & 1 for b in codewords for k in range(8)]
    k, col, up = 0, 20, True
    while col > 0:
        if col == 6:
            col = 5
        for r in (range(20, -1, -1) if up else range(21)):
            for c in (col, col - 1):
                if m[r][c] is None:
                    dark = bits[k] == 1
                    k += 1
                    m[r][c] = dark != mask(r, c)
        col -= 2
        up = not up
    assert k == len(bits) == 208
    return ["".join("1" if x else "0" for x in row) for row in m]


def test_qr_hello_world_1q_full_matrix():
    """Full module matrix of the worked example vs an independent builder, for all 8 masks."""
    data = [0x20, 0x5B, 0x0B, 0x78, 0xD1, 0x72, 0xDC, 0x4D, 0x43, 0x40, 0xEC, 0x11, 0xEC]
    ec = [168, 72, 22, 82, 217, 54, 156, 0, 46, 15, 180, 122, 16]
    q_formats = ["011010101011111", "011000001101000", "011111100110001", "011101000000110",
                 "010010010110100", "010000110000011", "010111011011010", "010101111101101"]
    masks = [lambda r, c: (r + c) % 2 == 0, lambda r, c: r % 2 == 0, lambda r, c: c % 3 == 0,
             lambda r, c: (r + c) % 3 == 0, lambda r, c: (r // 2 + c // 3) % 2 == 0,
             lambda r, c: (r * c) % 2 + (r * c) % 3 == 0, lambda r, c: ((r * c) % 2 + (r * c) % 3) % 2 == 0,
             lambda r, c: ((r + c) % 2 + (r * c) % 3) % 2 == 0]
    r = _run("qr", """console.log(JSON.stringify([0,1,2,3,4,5,6,7].map((k) =>
      L.encodeQr('HELLO WORLD', {ecl: 'Q', mask: k}).modules.map((row) => row.map((c) => (c ? 1 : 0)).join('')))));""")
    for k in range(8):
        assert r[k] == _reference_v1(data + ec, q_formats[k], masks[k]), f"mask {k}"


@pytest.mark.parametrize("ecl, mask, bits", [
    ("L", 0, "111011111000100"), ("L", 7, "110100101110110"), ("M", 0, "101010000010010"), ("M", 5, "100000011001110"),
    ("Q", 0, "011010101011111"), ("Q", 6, "010111011011010"), ("H", 0, "001011010001001"), ("H", 7, "000100000111011"),
])
def test_qr_format_bits_table(ecl, mask, bits):
    assert _run("qr", f"console.log(JSON.stringify(L.formatBits('{ecl}', {mask})))") == int(bits, 2)


def test_qr_version_bits_table():
    r = _run("qr", "console.log(JSON.stringify([7, 8, 21, 40].map(L.versionBits)))")
    assert r == [0x07C94, 0x085BC, 0x15683, 0x28C69]


def test_qr_generator_polynomials_and_tables():
    r = _run("qr", """const log = (p) => p.map((c) => { for (let e = 0; e < 255; e++) { let x = 1; for (let i = 0; i < e; i++) { x <<= 1; if (x & 256) x ^= 0x11D; } if (x === c) return e; } });
    console.log(JSON.stringify({g7: log(L.rsGenerator(7)), g10: log(L.rsGenerator(10)),
      cap: [[1,'L'],[1,'H'],[10,'M'],[40,'L'],[40,'H'],[5,'Q']].map(([v, e]) => L.dataCapacity(v, e)),
      raw: [1, 7, 40].map(L.totalCodewords), align: [1, 2, 7, 22, 32, 40].map(L.alignmentPositions),
      max: [L.maxCapacity('numeric','L'), L.maxCapacity('alphanumeric','L'), L.maxCapacity('byte','L'), L.maxCapacity('byte','H')]}));""")
    assert r["g7"] == [0, 87, 229, 146, 149, 238, 102, 21]  # α exponents of the degree-7 generator (ISO 18004 annex A)
    assert r["g10"] == [0, 251, 67, 46, 61, 118, 70, 64, 94, 32, 45]
    assert r["cap"] == [19, 9, 216, 2956, 1276, 62]
    assert r["raw"] == [26, 196, 3706]
    assert r["align"] == [[], [6, 18], [6, 22, 38], [6, 26, 50, 74, 98], [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142, 170]]
    assert r["max"] == [7089, 4296, 2953, 1273]


def test_qr_mode_selection_and_segments():
    r = _run("qr", """console.log(JSON.stringify({
      modes: ['0123', 'HELLO WORLD', 'hello', 'é', ''].map(L.pickMode),
      num: L.buildSegment('01234567', 'numeric').bits.join(''),
      v: ['https://example.com', 'x'.repeat(2953)].map((t) => L.encodeQr(t, {ecl: 'L'}).version),
      tooLong: (() => { try { L.encodeQr('x'.repeat(2954), {ecl: 'L'}); } catch (e) { return e.message; } })(),
      utf8: L.encodeQr('日本', {ecl: 'M'}).count }));""")
    assert r["modes"] == ["numeric", "alphanumeric", "byte", "byte", "numeric"]
    assert r["num"] == "000000110001010110011000011"  # 012 345 67 from the standard's numeric example
    assert r["v"] == [2, 40]
    assert "Too long" in r["tooLong"]
    assert r["utf8"] == 6  # byte mode counts UTF-8 bytes


def test_qr_structure_every_version():
    r = _run("qr", r"""const out = [];
    for (let v = 1; v <= 40; v++) for (const ecl of ['L', 'H']) {
      const q = L.encodeQr(String(v), {ecl, minVersion: v});
      const m = q.modules, n = m.length;
      const finderOk = [[0, 0], [n - 7, 0], [0, n - 7]].every(([x0, y0]) => {
        for (let y = -1; y <= 7; y++) for (let x = -1; x <= 7; x++) {
          const X = x0 + x, Y = y0 + y;
          if (X < 0 || Y < 0 || X >= n || Y >= n) continue;
          const d = Math.max(Math.abs(x - 3), Math.abs(y - 3));
          if (m[Y][X] !== (d !== 2 && d !== 4)) return false;
        }
        return true;
      });
      let timingOk = true;
      for (let i = 8; i < n - 8; i++) if (m[6][i] !== (i % 2 === 0) || m[i][6] !== (i % 2 === 0)) timingOk = false;
      const al = L.alignmentPositions(v);
      let alignOk = true;
      for (const ay of al) for (const ax of al) {
        if ((ax === 6 && ay === 6) || (ax === 6 && ay === n - 7) || (ax === n - 7 && ay === 6)) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)
          if (m[ay + dy][ax + dx] !== (Math.max(Math.abs(dx), Math.abs(dy)) !== 1)) alignOk = false;
      }
      const f1 = L.readFormat(m, 1), f2 = L.readFormat(m, 2);
      let ver = null;
      if (v >= 7) { ver = [0, 0]; for (let i = 0; i < 18; i++) { const a = n - 11 + (i % 3), b = Math.floor(i / 3); ver[0] |= (m[b][a] ? 1 : 0) << i; ver[1] |= (m[a][b] ? 1 : 0) << i; } }
      out.push({v, ecl, version: q.version, n, finderOk, timingOk, alignOk, dark: m[n - 8][8], f1, f2,
        fmt: L.formatBits(ecl, q.mask), ver, verBits: v >= 7 ? L.versionBits(v) : null, used: q.dataBits <= q.capacityBits});
    }
    console.log(JSON.stringify(out));""")
    assert len(r) == 80
    for q in r:
        where = f"v{q['v']}-{q['ecl']}"
        assert q["version"] == q["v"] and q["n"] == 17 + 4 * q["v"], where
        assert q["finderOk"] and q["timingOk"] and q["alignOk"] and q["dark"], where
        assert q["f1"] == q["f2"] == q["fmt"], where
        if q["v"] >= 7:
            assert q["ver"] == [q["verBits"], q["verBits"]], where
        assert q["used"], where


def test_qr_format_bch_codes_are_valid():
    """Every format word, unmasked, must be divisible by the BCH(15,5) generator 0x537."""
    r = _run("qr", "console.log(JSON.stringify(['L','M','Q','H'].flatMap((e) => [0,1,2,3,4,5,6,7].map((k) => L.formatBits(e, k)))))")

    def mod(x, g, deg):
        for i in range(x.bit_length() - 1, deg - 1, -1):
            if x >> i & 1:
                x ^= g << (i - deg)
        return x

    assert len(set(r)) == 32
    assert all(mod(w ^ 0x5412, 0x537, 10) == 0 for w in r)


def test_qr_presets_escape():
    r = _run("qr", r"""console.log(JSON.stringify([
      L.wifiString({ssid: 'My;Net,"x":\\', password: 'p;a:s,s"\\', security: 'WPA'}),
      L.wifiString({ssid: 'Open', security: 'nopass', hidden: true}),
      L.vcardString({first: 'Ada', last: 'Lovelace', org: 'Engines; Ltd', email: 'ada@example.com'}),
      L.toSvg([[true, false], [false, true]], {quiet: 1, scale: 2, title: '<x>&"', dark: 'red"/><script>', light: '#ffffff'}),
      L.contrastRatio('#000000', '#ffffff'), L.contrastRatio('#777777', '#888888') < 3]));""")
    assert r[0] == 'WIFI:T:WPA;S:My\\;Net\\,\\"x\\"\\:\\\\;P:p\\;a\\:s\\,s\\"\\\\;;'
    assert r[1] == "WIFI:T:nopass;S:Open;H:true;;"
    assert "N:Lovelace;Ada;;;" in r[2] and "ORG:Engines\\; Ltd" in r[2] and r[2].endswith("END:VCARD")
    svg = r[3]
    assert "<title>&lt;x&gt;&amp;&quot;</title>" in svg and "<script" not in svg and 'fill="#000000"' in svg
    assert "M1 1h1v1h-1z" in svg and "M2 2h1v1h-1z" in svg
    assert round(r[4], 1) == 21.0 and r[5] is True


def test_qr_decodes_with_opencv():
    """Round trip through a real decoder when OpenCV is available (not a hard dependency)."""
    cv2 = pytest.importorskip("cv2")
    np = pytest.importorskip("numpy")
    cases = [("HELLO WORLD", "Q", -1), ("01234567890123456789", "M", -1), ("https://example.com/a?b=c", "L", -1),
             ("héllo wörld ✓ 日本語", "H", -1), ("x" * 300, "M", -1), ("WIFI:T:WPA;S:home\\;net;P:secret;;", "M", -1)]
    cases += [("mask test 123", "Q", k) for k in range(8)]
    payload = json.dumps(cases)
    r = _run("qr", f"""console.log(JSON.stringify({payload}.map(([t, e, k]) => {{
      const q = L.encodeQr(t, {{ecl: e, mask: k}}); return {{t, m: q.modules.map((row) => row.map(Number)), mask: q.mask}}; }})));""")
    dets = [cv2.QRCodeDetector()]
    if hasattr(cv2, "QRCodeDetectorAruco"):
        dets.append(cv2.QRCodeDetectorAruco())
    for q in r:
        img = np.pad(np.where(np.array(q["m"], dtype=np.uint8) == 1, 0, 255).astype(np.uint8), 4, constant_values=255)
        decoded = set()
        for det in dets:
            for f in (3, 4, 6, 8):
                s, _, _ = det.detectAndDecode(cv2.resize(img, None, fx=f, fy=f, interpolation=cv2.INTER_NEAREST))
                decoded.add(s)
        assert q["t"] in decoded, (q["t"], q["mask"], decoded)


# ====================================================================== fake data
SCHEMA = [
    {"name": "id", "type": "sequence", "start": 100},
    {"name": "first", "type": "first_name"}, {"name": "last", "type": "last_name"}, {"name": "full", "type": "full_name"},
    {"name": "email", "type": "email"}, {"name": "user", "type": "username"},
    {"name": "phone_in", "type": "phone", "format": "in"}, {"name": "phone_us", "type": "phone", "format": "us"},
    {"name": "uid", "type": "uuid"}, {"name": "n", "type": "int", "min": -5, "max": 5},
    {"name": "f", "type": "float", "min": 1, "max": 2, "decimals": 3}, {"name": "b", "type": "bool"},
    {"name": "d", "type": "date", "from": "2024-02-01", "to": "2024-02-03"},
    {"name": "dt", "type": "datetime", "from": "2024-02-01", "to": "2024-02-01"},
    {"name": "iso", "type": "iso"}, {"name": "ep", "type": "epoch", "from": "2024-01-01", "to": "2024-01-01"},
    {"name": "e", "type": "enum", "values": "a, b ,c"}, {"name": "w", "type": "lorem_words", "count": 4},
    {"name": "s", "type": "lorem_sentence"}, {"name": "p", "type": "lorem_paragraph"},
    {"name": "city", "type": "city"}, {"name": "country", "type": "country"}, {"name": "co", "type": "company"},
    {"name": "street", "type": "street"}, {"name": "ip4", "type": "ipv4"}, {"name": "ip6", "type": "ipv6"},
    {"name": "url", "type": "url"}, {"name": "color", "type": "hex_color"}, {"name": "key", "type": "s3_key", "pattern": "raw/{uuid}.jpg"},
    {"name": "obj", "type": "json"}, {"name": "maybe", "type": "int", "min": 1, "max": 1, "nullPct": 100},
]


def _gen(schema, rows, seed, fmt="json", extra=""):
    return _run("fake", f"""const out = L.generate({json.dumps(schema)}, {{rows: {rows}, seed: {json.dumps(seed)}, format: '{fmt}'{extra}}});
    console.log(JSON.stringify(out));""")


def test_fake_every_type_has_the_right_shape():
    import re

    rows = json.loads(_gen(SCHEMA, 200, "types"))
    assert len(rows) == 200
    for i, r in enumerate(rows):
        assert r["id"] == 100 + i
        assert r["full"] == f"{r['first']} {r['last']}"  # one person per row
        local, domain = r["email"].split("@")
        assert domain in ("example.com", "test.local") and local.startswith(r["first"].lower()[:1])
        assert re.fullmatch(r"\+91 [6-9]\d{4} \d{5}", r["phone_in"]) and re.fullmatch(r"\+1 \(\d{3}\) 555-01\d\d", r["phone_us"])
        assert re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", r["uid"])
        assert -5 <= r["n"] <= 5 and isinstance(r["n"], int)
        assert 1 <= r["f"] <= 2 and round(r["f"], 3) == r["f"] and isinstance(r["b"], bool)
        assert r["d"] in ("2024-02-01", "2024-02-02", "2024-02-03") and r["dt"].startswith("2024-02-01 ")
        assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", r["iso"]) and 1704067200 <= r["ep"] < 1704067200 + 86400
        assert r["e"] in ("a", "b", "c") and len(r["w"].split()) == 4 and r["s"].endswith(".") and r["p"].count(".") >= 3
        assert all(r[k] for k in ("city", "country", "co", "street", "user"))
        assert re.fullmatch(r"(\d{1,3}\.){3}\d{1,3}", r["ip4"]) and r["ip6"].startswith("2001:db8:") and len(r["ip6"].split(":")) == 8
        assert r["url"].startswith("https://example.com/") and re.fullmatch(r"#[0-9a-f]{6}", r["color"])
        assert re.fullmatch(r"raw/[0-9a-f-]{36}\.jpg", r["key"])
        assert set(r["obj"]) == {"id", "tag", "active", "score"} and r["maybe"] is None


def test_fake_same_seed_same_data_and_chunking():
    a = _gen(SCHEMA, 50, "abc")
    assert a == _gen(SCHEMA, 50, "abc")
    assert a != _gen(SCHEMA, 50, "abd")
    r = _run("fake", f"""const s = {json.dumps(SCHEMA)};
    const g1 = L.createGenerator(s, 'chunk'), g2 = L.createGenerator(s, 'chunk');
    const all = g1.next(1200);
    const parts = [g2.next(500), g2.next(500), g2.next(200)];
    const fmts = ['csv', 'json', 'jsonl', 'sql', 'md'].map((f) => [
      L.formatRows(f, g1.columns, all, {{table: 't'}}),
      parts.map((p, i) => L.formatRows(f, g1.columns, p, {{table: 't', first: i === 0, last: i === 2}})).join('')]);
    console.log(JSON.stringify({{same: JSON.stringify(all) === JSON.stringify(parts.flat()), fmts: fmts.map(([x, y]) => x === y)}}));""")
    assert r == {"same": True, "fmts": [True] * 5}


def test_fake_null_percent_and_validation():
    r = _run("fake", """const g = L.createGenerator([{name: 'x', type: 'int', min: 1, max: 9, nullPct: 30}], 's');
    const rows = g.next(5000).map((r) => r[0]);
    console.log(JSON.stringify({nulls: rows.filter((v) => v === null).length,
      errs: L.validateSchema([{name: '', type: 'int', min: 5, max: 1}, {name: 'a', type: 'date', from: '2025-01-02', to: '2025-01-01'},
        {name: 'a', type: 'enum', values: ' , '}].map(L.normalizeColumn)),
      ok: L.validateSchema(L.EXAMPLE_SCHEMA), empty: L.validateSchema([]),
      safe: ['example.com', 'test.local', 'a.test', 'gmail.com', 'example.org.evil.com'].map(L.isSafeDomain)}));""")
    assert 1300 < r["nulls"] < 1700
    assert len(r["errs"]) == 5 and any("no name" in e for e in r["errs"]) and any("Duplicate" in e for e in r["errs"])
    assert r["ok"] == [] and r["empty"] == ["Add at least one column."]
    assert r["safe"] == [True, True, True, False, False]


def test_fake_output_formats_escape():
    schema = [{"name": "id", "type": "sequence", "start": 1}, {"name": "my col", "type": "enum", "values": "it's|x"},
              {"name": "obj", "type": "json"}, {"name": "gone", "type": "bool", "nullPct": 100}]
    r = _run("fake", f"""const g = L.createGenerator({json.dumps(schema)}, 'f');
    const rows = g.next(2); rows[1][1] = 'a "b", c\\nd';
    console.log(JSON.stringify(Object.fromEntries(['csv', 'json', 'jsonl', 'sql', 'md'].map((f) =>
      [f, L.formatRows(f, g.columns, rows, {{table: 'my table'}})]))));""")
    csv = r["csv"].splitlines()
    assert csv[0] == "id,my col,obj,gone" and csv[1].startswith("1,it's|x,\"{\"\"id\"\":") and csv[1].endswith(",")
    assert '"a ""b"", c' in r["csv"]
    parsed = json.loads(r["json"])
    assert parsed[0]["id"] == 1 and parsed[0]["gone"] is None and isinstance(parsed[0]["obj"], dict)
    assert [json.loads(line)["id"] for line in r["jsonl"].splitlines()] == [1, 2]
    assert r["sql"].startswith('INSERT INTO "my table" (id, "my col", obj, gone) VALUES\n  (1, \'it\'\'s|x\', \'{"id":')
    assert r["sql"].rstrip().endswith("NULL);")
    md = r["md"].splitlines()
    assert md[0] == "| id | my col | obj | gone |" and md[1] == "| --- | --- | --- | --- |"
    assert "it's\\|x" in md[2] and "<br>d" in md[3]
    assert json.loads(_gen([{"name": "a", "type": "bool"}], 0, "x")) == []


def test_fake_editing_one_column_keeps_the_others():
    r = _run("fake", """const base = [{name: 'id', type: 'uuid'}, {name: 'who', type: 'full_name'}, {name: 'n', type: 'int', min: 1, max: 1000}];
    const a = L.createGenerator(base, 's').next(30);
    const b = L.createGenerator([base[0], {name: 'extra', type: 'lorem_sentence'}, base[1], {...base[2], nullPct: 50}], 's').next(30);
    console.log(JSON.stringify({ids: a.every((r, i) => r[0] === b[i][0]), names: a.every((r, i) => r[1] === b[i][2]),
      ints: a.every((r, i) => b[i][3] === null || r[2] === b[i][3]), someNull: b.some((r) => r[3] === null)}));""")
    assert r == {"ids": True, "names": True, "ints": True, "someNull": True}
