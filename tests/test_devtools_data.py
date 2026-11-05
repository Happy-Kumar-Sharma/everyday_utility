"""Dev Tools — data group (sql, csv, s3): pure logic run through node, plus the frontend files being served."""

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


def run(module, script):
    """Runs `script` as an ES module with tools/<module>.logic.js imported as L; returns its printed JSON."""
    if not shutil.which("node"):
        pytest.skip("node is not installed")
    logic = (TOOLS_DIR / f"{module}.logic.js").as_uri()
    src = f"import * as L from '{logic}';\n{script}"
    out = subprocess.run(["node", "--input-type=module", "-e", src], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def test_frontend_files_served(client):
    for path in ("css/devtools-data.css", *(f"js/services/devtools/tools/{k}{s}.js" for k in ("sql", "csv", "s3") for s in ("", ".logic"))):
        assert client.get(f"/static/{path}").status_code == 200, path


def test_js_files_parse():
    if not shutil.which("node"):
        pytest.skip("node is not installed")
    for k in ("sql", "csv", "s3"):
        for s in ("", ".logic"):
            subprocess.run(["node", "--check", str(TOOLS_DIR / f"{k}{s}.js")], check=True, capture_output=True)


def test_no_html_injection_sinks():
    for k in ("sql", "csv", "s3"):
        for s in ("", ".logic"):
            src = (TOOLS_DIR / f"{k}{s}.js").read_text()
            for sink in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"):
                assert sink not in src, f"{k}{s}.js uses {sink}"


# ------------------------------------------------------------------ sql
TRICKY_SQL = [
    "select a, b.c as \"Weird \"\"Col\"\"\", count(*) filter (where x > 1), -1, a::text, j->>'k', $1 from t "
    "left outer join u on u.id = t.id and u.x between 1 and 2 where a = 'it''s -- not a comment' and (b or c) "
    "or d in (select id from z where q = $$ body ; 'x' $$) group by 1 order by 2 desc limit 10; -- tail\n"
    "insert into t (a,b) values (1,'x'),(2,'y') on conflict (a) do update set b = excluded.b returning *",
    "with x as (select 1), y as (select * from x) select distinct on (a) a, case when a and b then 1 else 2 end "
    "from y /* keep   me  /* nested */ still */ where e'a\\'b' = 'c' and z is distinct from 3 for update",
    "SELECT extract(year from ts), array_agg(x order by y), arr[1], -x, a - -1, a<-1, b @> '{1}', c ~~* 'x' "
    "FROM t WHERE %s = :name AND d = :'q' AND e = %(id)s",
    "create function f() returns int as $fn$ select   1;  -- inner\n $fn$ language sql;\nselect 'a\nb', \"x\ny\" from\tt",
    "select 1 -- trailing comment with 'quote\nfrom t where x='--' and y = '/* no */'",
    "SELECT U&'d\\0061t' , B'101', X'1F', 1.5e10, .5, 0x1F, 1_000 FROM t",
    "select a from t where a = 'unterminated",
]


def test_sql_format_and_minify_keep_tokens():
    r = run("sql", f"""const qs = {json.dumps(TRICKY_SQL)};
    const norm = (s, comments = true) => L.significant(s, {{ comments }}).map((t) => (t.type === 'word' ? t.v.toLowerCase() : t.v));
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    console.log(JSON.stringify(qs.map((q) => {{
      const f2 = L.formatSql(q, {{ indent: 2 }}), f4 = L.formatSql(q, {{ indent: 4, keywordCase: 'lower' }}), fp = L.formatSql(q, {{ keywordCase: 'preserve' }});
      const m = L.minifySql(q), ms = L.minifySql(q, {{ stripComments: true }});
      return [eq(norm(q), norm(f2)), eq(norm(q), norm(f4)), eq(norm(q), norm(fp)),
              eq(L.significant(q).map((t) => t.v), L.significant(m).map((t) => t.v)), eq(norm(q, false), norm(ms, false)),
              L.formatSql(f2) === f2, L.tokenize(q).map((t) => t.v).join('') === q];
    }})));""")
    for q, checks in zip(TRICKY_SQL, r):
        assert all(checks), (q, checks)


def test_sql_format_layout():
    r = run("sql", r"""console.log(JSON.stringify([
      L.formatSql("select a, b from t join u on u.id = t.id where x = 1 and y in (select id from z) order by a"),
      L.formatSql("SELECT A FROM T", { keywordCase: 'lower', indent: 4 }),
      L.formatSql("select x from t where a between 1 and 2 and b = 1; select 2"),
      L.formatSql("select 1 -- c\nfrom t"),
    ]));""")
    assert r[0] == ("SELECT\n  a,\n  b\nFROM t\nJOIN u ON u.id = t.id\nWHERE x = 1\n  AND y IN (\n    SELECT\n      id\n"
                    "    FROM z\n  )\nORDER BY a")
    assert r[1] == "select\n    A\nfrom T"
    assert r[2] == "SELECT\n  x\nFROM t\nWHERE a BETWEEN 1 AND 2\n  AND b = 1;\n\nSELECT\n  2"
    assert r[3] == "SELECT\n  1 -- c\nFROM t"  # a line comment is always followed by a line break


def test_sql_strings_and_comments_untouched():
    r = run("sql", r"""const q = "select 'select  from   where' as s, \"Mixed  Case\" -- keep   this\nfrom t /* and   this */";
    console.log(JSON.stringify([L.formatSql(q), L.minifySql(q), L.minifySql(q, { stripComments: true }), L.sqlWarnings("select 'x"), L.sqlWarnings('select 1')]));""")
    assert "'select  from   where'" in r[0] and '"Mixed  Case"' in r[0] and "-- keep   this\n" in r[0] and "/* and   this */" in r[0]
    assert r[1] == "select 'select  from   where' as s,\"Mixed  Case\" -- keep   this\nfrom t /* and   this */"
    assert r[2] == "select 'select  from   where' as s,\"Mixed  Case\" from t"
    assert r[3] and "Unterminated string" in r[3][0] and r[4] == []


def test_sql_minify_never_glues_tokens():
    r = run("sql", r"""console.log(JSON.stringify(["a - -1", "e 'x'", "a $$b$$", "x / *y", "a-/*c*/1", "select 1 --c\n, 2"].map((q) => L.minifySql(q))));""")
    assert r == ["a- -1", "e 'x'", "a $$b$$", "x/ *y", "a- /*c*/ 1", "select 1 --c\n,2"]


def test_in_list_builder():
    r = run("sql", r"""const b = (t, o) => L.buildInList(t, o);
    console.log(JSON.stringify([
      L.parseValues("1\n2, 3;4\t5|6"), L.parseValues("(a b, 'c, d', \"e\"\"f\")"), L.parseValues("x y  z"),
      b("3\n1\n3\n2", { column: 'id' }),
      b("a\nO'Brien\na", { dedupe: false }),
      b("007\n8", {}), b("1\nx\n2", { quote: 'number' }), b("1\n2", { quote: 'string' }),
      b("1\n2\n3\n4\n5", { column: 'id', chunk: 2 }), b("1\n2\n3", { chunk: 2, join: 'separate', template: 'DELETE FROM t WHERE id {list};' }),
      b('a\nb c\nx"y\nnull\n', { format: 'any', column: 'name' }), b("1\n2", { format: 'values' }), b("1\n2", { perLine: true }),
    ]));""")
    assert r[0] == ["1", "2", "3", "4", "5", "6"]
    assert r[1] == ["a b", "c, d", 'e"f']
    assert r[2] == ["x", "y", "z"]
    assert r[3]["text"] == "id IN (3, 1, 2)" and (r[3]["total"], r[3]["unique"], r[3]["duplicates"], r[3]["count"]) == (4, 3, 1, 3)
    assert r[4]["text"] == "IN ('a', 'O''Brien', 'a')" and r[4]["quoted"] is True
    assert r[5]["text"] == "IN ('007', '8')" and r[5]["notes"]  # leading zeros keep values as strings
    assert r[6]["text"] == "IN (1, 2)" and r[6]["invalid"] == ["x"]
    assert r[7]["text"] == "IN ('1', '2')"
    assert r[8]["text"] == "(\n  id IN (1, 2)\n  OR id IN (3, 4)\n  OR id IN (5)\n)" and r[8]["chunks"] == 3
    assert r[9]["text"] == "DELETE FROM t WHERE id IN (1, 2);\nDELETE FROM t WHERE id IN (3);"
    assert r[10]["text"] == r"""name = ANY('{a,"b c","x\"y","null"}')"""
    assert r[11]["text"] == "VALUES (1), (2)"
    assert r[12]["text"] == "IN (\n  1,\n  2\n)"


# ------------------------------------------------------------------ csv
def test_csv_parse_rfc4180_and_detect():
    r = run("csv", r"""console.log(JSON.stringify([
      L.parseCsv('\uFEFFid;name;note\r\n1;"Smith; J";"line1\nline2 \x22\x22q\x22\x22\x22\r\n2;x;\n\n'),
      L.parseCsv('a\tb\n1\t2').delimiter, L.parseCsv('a|b|c\n1|2|3').delimiter, L.parseCsv('a,b\n1,2').delimiter,
      L.parseCsv('a,b\n1,"open').warnings.length, L.parseCsv('a,b\n1\n2,3,4').warnings.length,
      L.toTable([['id', '', 'id'], ['1', '2', '3', '4']]),
      L.toTable([['1', '2']], { header: false }),
    ]));""")
    p = r[0]
    assert p["delimiter"] == ";" and p["warnings"] == []
    assert p["rows"] == [["id", "name", "note"], ["1", "Smith; J", 'line1\nline2 "q"'], ["2", "x", ""]]
    assert r[1:4] == ["\t", "|", ","]
    assert r[4] == 1 and r[5] == 1
    assert r[6] == {"columns": ["id", "column_2", "id_2", "column_4"], "records": [["1", "2", "3", "4"]]}
    assert r[7] == {"columns": ["column_1", "column_2"], "records": [["1", "2"]]}


def test_csv_outputs():
    r = run("csv", r"""const cols = ['id', 'Name', 'ok', 'score', 'zip', 'select'];
    const recs = [['1', "O'Neil <b>", 'true', '1.5', '007', 'x\ty'], ['2', '', 'false', '', '01234', ''], ['12345678901234567890', 'z', '', '2', '9', 'NULL']];
    const R = (f, o) => L.render(cols, recs, f, o);
    console.log(JSON.stringify([
      L.columnTypes(cols, recs).map((c) => c.type),
      JSON.parse(R('json')), JSON.parse(R('json', { infer: false, nullEmpty: false })),
      R('jsonl').split('\n').length, JSON.parse(R('arrays'))[0],
      R('markdown'), R('insert', { table: 'public.My Table', batch: 2 }), R('copy', { table: 't' }), R('html'),
      L.quoteIdent('user'), L.quoteIdent('Name'), L.quoteIdent('a"b'), L.quoteTable('"S".tbl'),
    ]));""")
    assert r[0] == ["integer", "string", "boolean", "number", "string", "string"]
    assert r[1][0] == {"id": 1, "Name": "O'Neil <b>", "ok": True, "score": 1.5, "zip": "007", "select": "x\ty"}
    assert r[1][1] == {"id": 2, "Name": None, "ok": False, "score": None, "zip": "01234", "select": None}
    assert r[1][2]["id"] == "12345678901234567890"  # beyond 2^53: kept as a string, no digits lost
    assert r[1][2]["select"] == "NULL"  # string column: the text NULL stays text
    assert r[2][1] == {"id": "2", "Name": "", "ok": "false", "score": "", "zip": "01234", "select": ""}
    assert r[3] == 3 and r[4] == ["id", "Name", "ok", "score", "zip", "select"]
    assert r[5].split("\n")[:3] == ["| id | Name | ok | score | zip | select |", "| --- | --- | --- | --- | --- | --- |",
                                    "| 1 | O'Neil <b> | true | 1.5 | 007 | x\ty |"]
    assert r[6] == ('INSERT INTO public."My Table" (id, "Name", ok, score, zip, "select") VALUES\n'
                    "  (1, 'O''Neil <b>', TRUE, 1.5, '007', 'x\ty'),\n  (2, NULL, FALSE, NULL, '01234', NULL);\n\n"
                    'INSERT INTO public."My Table" (id, "Name", ok, score, zip, "select") VALUES\n'
                    "  (12345678901234567890, 'z', NULL, 2, '9', 'NULL');")
    assert r[7] == ('COPY t (id, "Name", ok, score, zip, "select") FROM stdin;\n1\tO\'Neil <b>\ttrue\t1.5\t007\tx\\ty\n'
                    "2\t\\N\tfalse\t\\N\t01234\t\\N\n12345678901234567890\tz\t\\N\t2\t9\tNULL\n\\.")
    assert "<td>O&#39;Neil &lt;b&gt;</td>" in r[8] and "<b>" not in r[8].replace("<td>O&#39;Neil &lt;b&gt;</td>", "")
    assert r[9:] == ['"user"', '"Name"', '"a""b"', '"S".tbl']


def test_json_to_csv():
    r = run("csv", r"""const t1 = L.jsonToTable('[{"a":1,"b":{"x":[1]}},{"c":"q,\\"r","a":null}]');
    const t2 = L.jsonToTable('{"a":1}\n{"b":" lead"}');
    const t3 = L.jsonToTable('[["h1","h2"],[1,true],[2]]');
    const t4 = L.jsonToTable('[1,"x"]');
    let err = null; try { L.jsonToTable('{"a":1}\n{bad'); } catch (e) { err = e.message; }
    console.log(JSON.stringify([t1, L.toCsv(t1.columns, t1.records), L.toCsv(t2.columns, t2.records, { delimiter: ';' }),
      L.toCsv(t3.columns, t3.records, { quoteAll: true, eol: '\r\n' }), t4, err]));""")
    assert r[0]["columns"] == ["a", "b", "c"]
    assert r[1] == 'a,b,c\n1,"{""x"":[1]}",\n,,"q,""r"'
    assert r[2] == 'a;b\n1;\n;" lead"'
    assert r[3] == '"h1","h2"\r\n"1","true"\r\n"2",""'
    assert r[4] == {"columns": ["value"], "records": [["1"], ["x"]]}
    assert r[5].startswith("Line 2 is not valid JSON")


# ------------------------------------------------------------------ s3
def test_s3_parse_forms():
    r = run("s3", r"""const P = (u) => { try { const p = L.parseS3(u); return [p.bucket, p.key, p.region, p.style]; } catch (e) { return ['ERR', e.message]; } };
    console.log(JSON.stringify([
      P('s3://my-bucket/a b/c+d.tar.gz'), P('s3a://b1/k'),
      P('https://my-bucket.s3.amazonaws.com/a%20b/caf%C3%A9.json'),
      P('https://my.dotted.bucket.s3.eu-west-1.amazonaws.com/x/y.csv'),
      P('https://s3.us-west-2.amazonaws.com/bkt/k/l.txt'), P('https://s3.amazonaws.com/bkt/k'),
      P('https://s3-ap-south-1.amazonaws.com/bkt/k'), P('https://bkt.s3-us-west-1.amazonaws.com/k'),
      P('https://s3-external-1.amazonaws.com/bkt/k'), P('bkt.s3.dualstack.us-east-2.amazonaws.com/x'),
      P('arn:aws:s3:::bkt/dir/'), P('https://s3.console.aws.amazon.com/s3/object/bkt?region=us-east-2&prefix=a+b/c.txt'),
      P('https://bkt.s3.cn-north-1.amazonaws.com.cn/k'), P('bkt/some/key'),
      P('https://example.com/x'), P(''), P('hello world'),
    ]));""")
    assert r[0] == ["my-bucket", "a b/c+d.tar.gz", None, "s3 URI"]
    assert r[1] == ["b1", "k", None, "s3 URI"]
    assert r[2] == ["my-bucket", "a b/café.json", None, "virtual-hosted"]
    assert r[3] == ["my.dotted.bucket", "x/y.csv", "eu-west-1", "virtual-hosted"]
    assert r[4] == ["bkt", "k/l.txt", "us-west-2", "path-style"]
    assert r[5] == ["bkt", "k", None, "path-style"]
    assert r[6] == ["bkt", "k", "ap-south-1", "path-style"]
    assert r[7] == ["bkt", "k", "us-west-1", "virtual-hosted"]
    assert r[8] == ["bkt", "k", "us-east-1", "path-style"]
    assert r[9] == ["bkt", "x", "us-east-2", "virtual-hosted"]
    assert r[10] == ["bkt", "dir/", None, "ARN"]
    assert r[11] == ["bkt", "a b/c.txt", "us-east-2", "console URL"]
    assert r[12] == ["bkt", "k", "cn-north-1", "virtual-hosted"]
    assert r[13] == ["bkt", "some/key", None, "bucket/key"]
    assert [x[0] for x in r[14:]] == ["ERR"] * 3


def test_s3_presigned_and_warnings():
    r = run("s3", r"""const v4 = L.parseS3('https://bkt.s3.amazonaws.com/k.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20240101%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20240101T000000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=abc');
    const v2 = L.parseS3('https://bkt.s3.amazonaws.com/k?AWSAccessKeyId=AKIA&Expires=1700000000&Signature=xyz');
    const plus = L.parseS3('https://bkt.s3.amazonaws.com/a+b');
    const dots = L.parseS3('s3://a.b/k');
    const ver = L.parseS3('https://bkt.s3.us-east-1.amazonaws.com/k?versionId=v1');
    console.log(JSON.stringify([v4.presigned, v4.region, v4.warnings, v2.presigned, plus.warnings, dots.warnings, ver.versionId,
      L.parseS3('s3://Bad_Bucket/k').warnings]));""")
    assert r[0] == {"version": "SigV4", "signedAt": 1704067200000, "seconds": 3600, "expiresAt": 1704070800000}
    assert r[1] == "us-east-1"  # taken from X-Amz-Credential
    assert any("presigned" in w for w in r[2])
    assert r[3]["version"] == "SigV2" and r[3]["expiresAt"] == 1700000000000
    assert any("%2B" in w for w in r[4])
    assert any("path-style" in w for w in r[5])
    assert r[6] == "v1"
    assert any("not a valid bucket name" in w for w in r[7])


def test_s3_output_forms_and_encoding():
    r = run("s3", r"""const f = (p, o) => Object.fromEntries(L.forms(p, o).map((x) => [x.id, x.value]));
    console.log(JSON.stringify([
      f({ bucket: 'bkt', key: "a b/c+d (1)'ü.txt", region: 'eu-west-1' }),
      f({ bucket: 'bkt', key: 'dir/sub/', region: null }, { defaultRegion: 'us-gov-west-1' }),
      f({ bucket: 'bkt', key: 'k', region: null }),
      L.keyParts('a/b/file.tar.gz'), L.keyParts('a/.env'), L.keyParts('noext'),
      L.encodeKey('a b/c+d~e!*'),
      L.parseMany('s3://b1/k1\nnot valid\n\nhttps://b2.s3.us-east-1.amazonaws.com/x%20y', { defaultRegion: 'eu-west-1' }).map((x) => [x.error ? 'ERR' : x.s3, x.region || null, x.virtual || null]),
    ]));""")
    a = r[0]
    assert a["s3"] == "s3://bkt/a b/c+d (1)'ü.txt"
    assert a["virtual"] == "https://bkt.s3.eu-west-1.amazonaws.com/a%20b/c%2Bd%20%281%29%27%C3%BC.txt"
    assert a["path"] == "https://s3.eu-west-1.amazonaws.com/bkt/a%20b/c%2Bd%20%281%29%27%C3%BC.txt"
    assert a["arn"] == "arn:aws:s3:::bkt/a b/c+d (1)'ü.txt"
    assert a["console"] == "https://s3.console.aws.amazon.com/s3/object/bkt?region=eu-west-1&prefix=a%20b%2Fc%2Bd%20%281%29%27%C3%BC.txt"
    assert a["cli-cp"] == "aws s3 cp 's3://bkt/a b/c+d (1)'\\''ü.txt' . --region eu-west-1"
    assert a["cli-ls"] == "aws s3 ls 's3://bkt/a b/' --region eu-west-1"
    b = r[1]
    assert b["arn"] == "arn:aws-us-gov:s3:::bkt/dir/sub/"
    assert b["console"].startswith("https://s3.console.aws.amazon.com/s3/buckets/bkt?region=us-gov-west-1&prefix=dir%2Fsub%2F")
    assert b["cli-cp"] == "aws s3 cp s3://bkt/dir/sub/ sub/ --recursive --region us-gov-west-1"
    assert r[2]["virtual"] == "https://bkt.s3.amazonaws.com/k" and r[2]["cli-cp"] == "aws s3 cp s3://bkt/k ."
    assert r[3] == {"prefix": "a/b/", "filename": "file.tar.gz", "extension": "gz"}
    assert r[4] == {"prefix": "a/", "filename": ".env", "extension": ""}
    assert r[5] == {"prefix": "", "filename": "noext", "extension": ""}
    assert r[6] == "a%20b/c%2Bd~e%21%2A"
    assert r[7] == [["s3://b1/k1", "eu-west-1", "https://b1.s3.eu-west-1.amazonaws.com/k1"], ["ERR", None, None],
                    ["s3://b2/x y", "us-east-1", "https://b2.s3.us-east-1.amazonaws.com/x%20y"]]
