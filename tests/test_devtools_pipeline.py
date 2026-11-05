"""Dev Tools — pipeline group: Box / polygon viewer (bbox) and JSONL inspector (jsonl).

The pure logic lives in web/js/services/devtools/tools/<key>.logic.js and runs under node (skipped without node).
"""

import json
import shutil
import subprocess

import pytest
from fastapi.testclient import TestClient

from app.core import config

TOOLS_DIR = config.WEB_DIR / "js" / "services" / "devtools" / "tools"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    from app.core import context
    from app.core.jobs import JobManager
    from app.core.settings_store import SettingsStore

    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(context, "jobs", JobManager(tmp_path / "jobs"))
    monkeypatch.setattr(context, "settings", SettingsStore(tmp_path / "settings"))
    from app.main import app

    with TestClient(app) as c:
        yield c


def _node():
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    return node


def _run(module, script):
    """Runs `script` as an ES module with tools/<module>.logic.js imported as L; returns its printed JSON."""
    src = f"import * as L from '{(TOOLS_DIR / f'{module}.logic.js').as_uri()}';\n{script}"
    out = subprocess.run([_node(), "--input-type=module", "-e", src], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def bbox(script):
    return _run("bbox", script)


def jsonl(script):
    return _run("jsonl", script)


# ------------------------------------------------------------------ files

def test_frontend_files_served(client):
    for path in ("js/services/devtools/tools/bbox.js", "js/services/devtools/tools/bbox.logic.js",
                 "js/services/devtools/tools/jsonl.js", "js/services/devtools/tools/jsonl.logic.js",
                 "css/devtools-pipeline.css"):
        assert client.get(f"/static/{path}").status_code == 200, path


@pytest.mark.parametrize("name", ["bbox.js", "bbox.logic.js", "jsonl.js", "jsonl.logic.js"])
def test_js_syntax_and_no_html_injection(name):
    path = TOOLS_DIR / name
    subprocess.run([_node(), "--check", str(path)], check=True, capture_output=True)
    src = path.read_text()
    for bad in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "fetch(", "XMLHttpRequest"):
        assert bad not in src, f"{name} uses {bad}"
    if not name.endswith(".logic.js"):
        assert "export default function build" in src
        assert "loadCss('/static/css/devtools-pipeline.css')" in src
    else:
        assert "document." not in src and "window." not in src  # pure logic


def test_registered_in_manifest_and_search():
    from app.services.devtools import TOOLS, search

    index = (TOOLS_DIR / "index.js").read_text()
    assert "key: 'bbox'" in index and "key: 'jsonl'" in index
    assert {"bbox", "jsonl"} <= set(TOOLS)
    assert "bbox" in [r["ref"] for r in search("iou")]
    assert "jsonl" in [r["ref"] for r in search("ndjson")]


# ------------------------------------------------------------------ bbox: parsing

@pytest.mark.parametrize("text, expected", [
    ("[10,20,110,80]", {"type": "box", "box": [10, 20, 110, 80], "fmtHint": None, "label": "", "score": None}),
    ("dent 0.91: [10,20,110,80]", {"type": "box", "box": [10, 20, 110, 80], "label": "dent", "score": 0.91}),
    ("dent 0.91 10 20 110 80", {"type": "box", "box": [10, 20, 110, 80], "label": "dent", "score": 0.91}),
    ("scratch (91%): [1,2,3,4]", {"label": "scratch", "score": 0.91}),
    ('{"x": 1, "y": 2, "w": 3, "h": 4}', {"type": "box", "box": [1, 2, 3, 4], "fmtHint": "xywh"}),
    ('{"x":1,"y":2,"width":3,"height":4}', {"box": [1, 2, 3, 4], "fmtHint": "xywh"}),
    ('{"xmin":1,"ymin":2,"xmax":5,"ymax":6}', {"box": [1, 2, 5, 6], "fmtHint": "xyxy"}),
    ('{"cx":5,"cy":5,"w":4,"h":2}', {"box": [5, 5, 4, 2], "fmtHint": "cxcywh"}),
    ('{"bbox": [1,2,3,4]}', {"type": "box", "box": [1, 2, 3, 4]}),
    ("[[1,2,3,4]]", {"type": "box", "box": [1, 2, 3, 4]}),
    ("[[0,0],[10,0],[10,10]]", {"type": "poly", "points": [[0, 0], [10, 0], [10, 10]]}),
    ("[[[0,0],[10,0],[10,10]]]", {"type": "poly", "points": [[0, 0], [10, 0], [10, 10]]}),
    ("1,2,3,4,5,6", {"type": "poly", "points": [[1, 2], [3, 4], [5, 6]]}),
    ("[{'x':1,'y':2},{'x':3,'y':2},{'x':3,'y':5}]", {"type": "poly", "points": [[1, 2], [3, 2], [3, 5]]}),
    ('{"points": [[0,0],[4,0],[4,4],[0,4]]}', {"type": "poly"}),
    ('{"type":"Polygon","coordinates":[[[0,0],[4,0],[4,4],[0,0]]]}', {"type": "poly"}),
    ("{1,2,3,4}", {"type": "box", "box": [1, 2, 3, 4]}),                                  # Postgres array
    ("{{0,0},{4,0},{4,4}}", {"type": "poly", "points": [[0, 0], [4, 0], [4, 4]]}),
    ("((1,2),(3,4),(5,6))", {"type": "poly", "points": [[1, 2], [3, 4], [5, 6]]}),       # Postgres polygon
    ("(3,4),(1,2)", {"type": "box", "box": [1, 2, 3, 4], "fmtHint": "xyxy"}),            # Postgres box
    ("0 0.5 0.5 0.2 0.3", {"type": "box", "box": [0.5, 0.5, 0.2, 0.3], "fmtHint": "yolo", "unitHint": "normalized", "label": "class 0"}),
    ("2 0.1 0.1 0.5 0.1 0.5 0.5", {"type": "poly", "unitHint": "normalized", "label": "class 2"}),
])
def test_parse_shape(text, expected):
    got = bbox(f"console.log(JSON.stringify(L.parseShape({json.dumps(text)})))")
    assert "error" not in got, got
    assert {k: got.get(k) for k in expected} == expected


@pytest.mark.parametrize("text", ["", "abc", "[1,2,3]", "[1,2,3,4,5]", "{\"foo\": 1}", "[[1,2]]", "{not json"])
def test_parse_shape_errors_are_reported_not_thrown(text):
    got = bbox(f"console.log(JSON.stringify(L.parseShape({json.dumps(text)})))")
    assert set(got) == {"error"} and got["error"]


def test_parse_rows_csv_tsv_and_psql():
    csv = ('image_id,damage_name,score,bounding_box,polygon\n'
           '1,dent,0.9,"[10,20,110,80]","[[10,20],[110,20],[60,80]]"\n'
           '2,scratch,91,"{""x"":1,""y"":2,""w"":3,""h"":4}",\n'
           '3,crack,0.4,bad,NULL\n')
    got = bbox(f"console.log(JSON.stringify(L.parseRows({json.dumps(csv)})))")
    assert got["delimiter"] == ","
    assert [(s["label"], s["type"], s["source"], s["row"]) for s in got["shapes"]] == [
        ("dent", "box", "box", 2), ("dent", "poly", "polygon", 2), ("scratch", "box", "box", 3)]
    assert got["shapes"][2]["score"] == 0.91  # percent → fraction
    assert got["errors"] == [{"line": 4, "error": got["errors"][0]["error"]}] and "bounding_box" in got["errors"][0]["error"]

    tsv = "id\tlabel\tbbox\n7\tdent\t{1,2,3,4}\n"
    got = bbox(f"console.log(JSON.stringify(L.parseRows({json.dumps(tsv)})))")
    assert got["delimiter"] == "\t" and got["shapes"][0]["box"] == [1, 2, 3, 4] and got["shapes"][0]["label"] == "dent"

    psql = " id | damage_name | bounding_box \n----+-------------+--------------\n  1 | dent        | [1,2,3,4]\n(1 row)\n"
    got = bbox(f"console.log(JSON.stringify(L.parseRows({json.dumps(psql)})))")
    assert got["delimiter"] == "|" and len(got["shapes"]) == 1 and got["shapes"][0]["label"] == "dent"

    got = bbox("console.log(JSON.stringify(L.parseRows('id,name\\n1,x')))")
    assert got["shapes"] == [] and "No bounding_box" in got["errors"][0]["error"]


def test_parse_input_switches_between_lines_and_rows():
    got = bbox("""console.log(JSON.stringify([
      L.parseInput('# comment\\n\\ndent: [1,2,3,4]\\nnope\\n[[0,0],[1,0],[1,1]]'),
      L.parseInput('damage_name\\tbounding_box\\ndent\\t[1,2,3,4]'),
    ]))""")
    lines, rows = got
    assert [s["row"] for s in lines["shapes"]] == [3, 5] and lines["errors"][0]["line"] == 4
    assert rows["shapes"][0]["label"] == "dent"


# ------------------------------------------------------------------ bbox: formats

@pytest.mark.parametrize("box, src, dst, expected", [
    ([10, 20, 110, 80], "xyxy", "xywh", [10, 20, 100, 60]),
    ([10, 20, 110, 80], "xyxy", "coco", [10, 20, 100, 60]),
    ([10, 20, 110, 80], "xyxy", "cxcywh", [60, 50, 100, 60]),
    ([10, 20, 110, 80], "xyxy", "yolo", [0.3, 0.5, 0.5, 0.6]),
    ([10, 20, 110, 80], "xyxy", "xyxyn", [0.05, 0.2, 0.55, 0.8]),
    ([10, 20, 110, 80], "xyxy", "xywhn", [0.05, 0.2, 0.5, 0.6]),
    ([0.3, 0.5, 0.5, 0.6], "yolo", "xyxy", [10, 20, 110, 80]),
    ([0.3, 0.5, 0.5, 0.6], "cxcywhn", "xywh", [10, 20, 100, 60]),
    ([10, 20, 100, 60], "xywh", "xyxy", [10, 20, 110, 80]),
    ([60, 50, 100, 60], "cxcywh", "yolo", [0.3, 0.5, 0.5, 0.6]),
])
def test_convert(box, src, dst, expected):
    got = bbox(f"console.log(JSON.stringify(L.convert({box}, '{src}', '{dst}', 200, 100)))")
    assert got == pytest.approx(expected)


def test_convert_round_trips_every_format():
    got = bbox("""
      const fm = ['xyxy','xywh','cxcywh','coco','yolo','xyxyn','xywhn','cxcywhn'];
      const px = [12.5, 7, 140, 99];
      const bad = [];
      for (const a of fm) for (const b of fm) {
        const back = L.convert(L.convert(L.convert(px, 'xyxy', a, 640, 480), a, b, 640, 480), b, 'xyxy', 640, 480);
        if (back.some((v, i) => Math.abs(v - px[i]) > 1e-9)) bad.push([a, b, back]);
      }
      console.log(JSON.stringify(bad));""")
    assert got == []


def test_resolve_auto_detects_format_and_units():
    got = bbox("""
      const P = (t) => L.parseShape(t);
      const r1 = L.resolve([P('[0.1,0.2,0.5,0.6]'), P('[[0.1,0.1],[0.2,0.1],[0.2,0.2]]')], { w: 200, h: 100 });
      const r2 = L.resolve([P('[10,20,5,5]')], { w: 200, h: 100 });             // x2 < x1 → must be xywh
      const r3 = L.resolve([P('[10,20,110,80]')], { format: 'cxcywh', w: 200, h: 100 });
      const r4 = L.resolve([P('[0.5,0.5,0.2,0.2]')], { units: 'pixel', w: 200, h: 100 });
      const r5 = L.resolve([P('0 0.5 0.5 0.2 0.2'), P('[10,20,30,40]')], { w: 200, h: 100 });  // yolo line stays normalized
      console.log(JSON.stringify([r1, r2, r3, r4, r5]));""")
    r1, r2, r3, r4, r5 = got
    assert r1["normalized"] is True
    assert r1["shapes"][0]["px"] == pytest.approx([20, 20, 100, 60])
    assert r1["shapes"][1]["pts"] == [[20, 10], [40, 10], [40, 20]] and r1["shapes"][1]["px"] == [20, 10, 40, 20]
    assert r2["shapes"][0]["fmt"] == "xywh" and r2["shapes"][0]["px"] == [10, 20, 15, 25]
    assert r3["shapes"][0]["px"] == [-45, -20, 65, 60]
    assert r4["shapes"][0]["normalized"] is False and r4["shapes"][0]["px"] == pytest.approx([0.5, 0.5, 0.7, 0.7])  # x2<x1 → xywh
    assert r5["shapes"][0]["px"] == pytest.approx([80, 40, 120, 60]) and r5["shapes"][1]["px"] == [10, 20, 30, 40]


# ------------------------------------------------------------------ bbox: geometry

def test_box_iou_area_and_bbox():
    got = bbox("""console.log(JSON.stringify([
      L.iouBoxes([0,0,10,10],[5,5,15,15]), L.iouBoxes([0,0,10,10],[0,0,10,10]), L.iouBoxes([0,0,1,1],[2,2,3,3]),
      L.iouBoxes([0,0,0,0],[0,0,0,0]),
      L.polygonArea([[0,0],[10,0],[10,10],[0,10]]), L.polygonArea([[0,10],[10,10],[10,0],[0,0]]),
      L.polygonBBox([[3,1],[9,4],[5,8],[-2,6]]),
    ]))""")
    assert got[0] == pytest.approx({"iou": 25 / 175, "intersection": 25, "union": 175})
    assert got[1]["iou"] == 1 and got[2]["iou"] == 0 and got[3]["iou"] == 0
    assert got[4] == got[5] == 100
    assert got[6] == [-2, 1, 9, 8]


def test_polygon_iou_is_exact_for_concave_polygons():
    got = bbox("""
      const sq = (x, y, s) => [[x,y],[x+s,y],[x+s,y+s],[x,y+s]];
      const Lshape = [[0,0],[10,0],[10,4],[4,4],[4,10],[0,10]];   // area 64, concave
      console.log(JSON.stringify([
        L.iouPolygons(sq(0,0,10), sq(5,5,10)),
        L.iouPolygons(Lshape, [...Lshape].reverse()),                 // orientation does not matter
        L.iouPolygons(Lshape, sq(5,5,4)),                             // inside the notch → disjoint
        L.iouPolygons(Lshape, sq(2,2,6)),                             // 12 + 8 = 20 overlap
        L.iouPolygons([[0,0],[4,0],[4,4],[0,4]], [[2,-1],[6,-1],[6,5],[2,5]]),
        L.polygonIntersectionArea([[0,0],[10,0],[10,10],[5,2],[0,10]], sq(0,0,10)),  // concave "M" fully inside
      ]))""")
    assert got[0]["iou"] == pytest.approx(25 / 175)
    assert got[1]["iou"] == pytest.approx(1) and got[1]["intersection"] == pytest.approx(64)
    assert got[2]["intersection"] == pytest.approx(0, abs=1e-9)
    assert got[3]["intersection"] == pytest.approx(20) and got[3]["union"] == pytest.approx(64 + 36 - 20)
    assert got[4]["iou"] == pytest.approx(8 / (16 + 24 - 8))
    assert got[5] == pytest.approx(60)  # 100 − triangle notch (10·8/2)
    assert "exact" in got[0]["method"]


def test_iou_shapes_mixes_boxes_and_polygons():
    got = bbox("""
      const [a, b, c] = L.resolve([L.parseShape('[0,0,10,10]'), L.parseShape('[5,5,15,15]'),
        L.parseShape('[[5,5],[15,5],[15,15],[5,15]]')], { units: 'pixel' }).shapes;
      console.log(JSON.stringify([L.iouShapes(a, b), L.iouShapes(a, c)]))""")
    assert got[0]["iou"] == pytest.approx(got[1]["iou"]) == pytest.approx(25 / 175)
    assert got[0]["method"].startswith("exact (box")


def test_point_in_polygon_and_label_hue():
    got = bbox("""console.log(JSON.stringify([
      L.pointInPolygon([2,2], [[0,0],[10,0],[10,4],[4,4],[4,10],[0,10]]),
      L.pointInPolygon([8,8], [[0,0],[10,0],[10,4],[4,4],[4,10],[0,10]]),
      L.labelHue('dent') === L.labelHue('dent'), L.labelHue('dent') !== L.labelHue('scratch'),
    ]))""")
    assert got == [True, False, True, True]


# ------------------------------------------------------------------ jsonl

def test_parse_line():
    got = jsonl("""console.log(JSON.stringify([L.parseLine('{"a":1}'), L.parseLine('   '), L.parseLine('\\uFEFF[1]'),
      L.parseLine('{"a":'), L.parseLine('{"a":1}\\r')]))""")
    assert got[0] == {"value": {"a": 1}} and got[1] == {"blank": True} and got[2] == {"value": [1]}
    assert set(got[3]) == {"error"} and got[4] == {"value": {"a": 1}}


def test_key_paths():
    got = jsonl("""console.log(JSON.stringify(L.keyPaths(
      {id: 1, meta: {w: 2.5, tags: ['x'], deep: {deeper: {deepest: 1}}}, predictions: [{label: 'dent', score: 0.9}, {label: 'x', box: null}]}, 3)))""")
    assert dict(got) == {
        "id": "integer", "meta": "object", "meta.w": "number", "meta.tags": "array", "meta.deep": "object",
        "meta.deep.deeper": "object", "predictions": "array", "predictions[].label": "string",
        "predictions[].score": "number", "predictions[].box": "null",
    }
    assert dict(jsonl("console.log(JSON.stringify(L.keyPaths({a: {b: {c: 1}}}, 1)))")) == {"a": "object"}


def test_get_path():
    got = jsonl("""
      const o = {image_id: 7, predictions: [{score: 0.9, label: 'dent'}, {score: 0.2}], m: {'a': {b: [1, 2]}}, z: 0, n: null};
      const g = (p) => { const v = L.getPath(o, p); return v === undefined ? '<missing>' : v; };
      console.log(JSON.stringify(['image_id', 'predictions.0.score', 'predictions[1].score', 'predictions[].score',
        'predictions.*.label', 'm.a.b.1', 'nope', 'image_id.x', 'z', 'n', 'predictions.5.score'].map(g)))""")
    assert got == [7, 0.9, 0.2, [0.9, 0.2], ["dent"], 2, "<missing>", "<missing>", 0, None, "<missing>"]


@pytest.mark.parametrize("expr, expected", [
    ("score > 0.5", True), ("score < 0.5", False), ("score >= 0.9", True), ("score <= 0.8", False),
    ("label == dent", True), ('label == "dent"', True), ("label != dent", False), ("label contains EN", True),
    ("image_id == 7", True), ("image_id == \"7\"", True), ("image_id > 6", True),
    ("tags contains rear", True), ("tags contains front", False),
    ("predictions[].score > 0.8", True), ("predictions[].score > 0.95", False),
    ("predictions[].label == scratch", True), ("predictions.1.label == scratch", True),
    ("missing exists", False), ("missing !exists", True), ("missing not exists", True), ("score exists", True),
    ("n == null", True), ("label !contains den", False), ("label not contains xyz", True),
    ("missing > 1", False), ("label > a", True),
])
def test_match_filter(expr, expected):
    row = {"image_id": 7, "score": 0.9, "label": "dent", "tags": ["rear", "door"], "n": None,
           "predictions": [{"label": "dent", "score": 0.91}, {"label": "scratch", "score": 0.3}]}
    assert jsonl(f"console.log(JSON.stringify(L.matchFilter({json.dumps(row)}, {json.dumps(expr)})))") is expected


@pytest.mark.parametrize("expr", ["", "score", "score ~ 1", "score >", "score exists 1"])
def test_parse_filter_errors(expr):
    got = jsonl(f"console.log(JSON.stringify(L.parseFilter({json.dumps(expr)})))")
    assert set(got) == {"error"}


def test_line_splitter_handles_chunk_boundaries():
    got = jsonl("""
      const s = L.lineSplitter();
      const out = [...s.push('{"a":1}\\r'), ...s.push('\\n{"a"'), ...s.push(':2}\\n\\n'), ...s.push('{"a":3}'), ...s.end()];
      const s2 = L.lineSplitter(); const out2 = [...s2.push('x\\n'), ...s2.end()];
      console.log(JSON.stringify([out, out2]))""")
    assert got == [['{"a":1}', '{"a":2}', '', '{"a":3}'], ["x"]]


def test_stats():
    lines = ['{"id":1,"p":[{"s":0.5}]}', "", "not json", '{"id":2}', "[1,2]", '{"id":"x","extra":true}', "   "]
    got = jsonl(f"""
      const st = L.createStats({{ preview: 2, maxInvalid: 50 }});
      for (const l of {json.dumps(lines)}) st.add(l);
      console.log(JSON.stringify(st.result()))""")
    assert (got["total"], got["valid"], got["invalid"], got["blank"], got["objects"]) == (7, 4, 1, 2, 3)
    assert got["invalidLines"][0]["line"] == 3 and got["invalidLines"][0]["text"] == "not json"
    assert [p["line"] for p in got["preview"]] == [1, 4]
    keys = {k["path"]: k for k in got["keys"]}
    assert keys["id"]["count"] == 3 and keys["id"]["pct"] == pytest.approx(100)
    assert set(keys["id"]["types"]) == {"integer", "string"}
    assert keys["p[].s"]["count"] == 1 and keys["extra"]["types"] == ["boolean"]
    assert got["keys"][0]["path"] == "id"
    assert got["rootTypes"] == {"object": 3, "array": 1}
    assert got["maxLen"] == len(lines[0]) == 24 and got["maxLine"] == 1 and got["minLen"] == 5


def test_stats_caps_invalid_and_paths():
    got = jsonl("""
      const st = L.createStats({ maxInvalid: 3, maxPaths: 5 });
      for (let i = 0; i < 10; i++) st.add('bad' + i);
      for (let i = 0; i < 10; i++) st.add(JSON.stringify({['k' + i]: i}));
      const r = st.result();
      console.log(JSON.stringify([r.invalid, r.invalidLines.length, r.keys.length, r.pathsTruncated]))""")
    assert got == [10, 3, 5, True]


def test_csv_column():
    got = jsonl("""console.log(JSON.stringify(L.toCsvColumn('predictions[].label', ['a', 'b,c', 'say "hi"', 3, null, {x: 1}])))""")
    assert got == 'predictions[].label\na\n"b,c"\n"say ""hi"""\n3\nnull\n"{""x"":1}"\n'
