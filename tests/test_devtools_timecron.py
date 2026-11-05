"""Dev Tools — time & cron group: ⏰ cron, 🧾 env, ⏳ duration.

The pure logic modules (web/js/services/devtools/tools/<key>.logic.js) are run with node, like test_devtools.py.
"""

import json
import os
import re
import shutil
import subprocess

import pytest
from fastapi.testclient import TestClient

from app.core import config

TOOLS_DIR = config.WEB_DIR / "js" / "services" / "devtools" / "tools"
KEYS = ("cron", "env", "duration")


def _run(script, tz="UTC"):
    """Runs `script` as an ES module with C / E / D = cron / env / duration logic; returns its printed JSON."""
    if not shutil.which("node"):
        pytest.skip("node is not installed")
    imports = "\n".join(f"import * as {alias} from '{(TOOLS_DIR / f'{key}.logic.js').as_uri()}';"
                        for alias, key in (("C", "cron"), ("E", "env"), ("D", "duration")))
    out = subprocess.run(["node", "--input-type=module", "-e", f"{imports}\n{script}"],
                         capture_output=True, text=True, check=True, env={**os.environ, "TZ": tz})
    return json.loads(out.stdout)


# ------------------------------------------------------------------ files / wiring
def test_tool_modules_registered_and_served():
    index = (TOOLS_DIR / "index.js").read_text()
    from app.main import app

    with TestClient(app) as c:
        for key in KEYS:
            assert f"key: '{key}'" in index
            for name in (f"{key}.js", f"{key}.logic.js"):
                assert c.get(f"/static/js/services/devtools/tools/{name}").status_code == 200
        assert c.get("/static/css/devtools-timecron.css").status_code == 200


@pytest.mark.parametrize("key", KEYS)
def test_module_contract_and_no_html_injection(key):
    src = (TOOLS_DIR / f"{key}.js").read_text()
    assert "export default function build()" in src
    assert "loadCss('/static/css/devtools-timecron.css')" in src
    for name in (f"{key}.js", f"{key}.logic.js"):
        code = (TOOLS_DIR / name).read_text()
        assert not re.search(r"innerHTML|outerHTML|insertAdjacentHTML|document\.write", code), name
        assert not re.search(r"https?://(?!127\.0\.0\.1)", re.sub(r"//.*", "", code)), f"{name} must work offline"
    logic = (TOOLS_DIR / f"{key}.logic.js").read_text()
    assert "document." not in logic and "window." not in logic


@pytest.mark.parametrize("key", KEYS)
def test_js_syntax(key):
    if not shutil.which("node"):
        pytest.skip("node is not installed")
    for name in (f"{key}.js", f"{key}.logic.js"):
        subprocess.run(["node", "--check", str(TOOLS_DIR / name)], check=True, capture_output=True)


# ------------------------------------------------------------------ cron
def test_cron_descriptions():
    exprs = ["0 21 * * 1-5", "*/5 * * * *", "*/30 9-17 * * mon-fri", "0 0 1,15 * 1", "0 9,12,17 * * *",
             "@weekly", "@reboot", "15 10 * jan-mar 5", "0 0 1 1,4,7,10 *"]
    r = _run(f"console.log(JSON.stringify({json.dumps(exprs)}.map((e) => C.describeCron(C.parseCron(e)))));")
    assert r == [
        "At 21:00, Monday through Friday",
        "Every 5 minutes",
        "Every 30 minutes, between 09:00 and 17:59, Monday through Friday",
        "At 00:00, on the 1st and 15th of the month or on Monday",
        "At 09:00, 12:00 and 17:00",
        "At 00:00, only on Sunday",
        "Once, at system startup (@reboot)",
        "At 10:15, only on Friday, in January through March",
        "At 00:00, on the 1st of the month, in January, April, July and October",
    ]


def test_cron_field_parsing():
    r = _run("""const v = (e) => C.parseCron(e).fields.map((f) => f.values);
    console.log(JSON.stringify([v('1-10/3 */6 L * *').length, v('1-10/3 */6 1 * *'), v('0 0 * * 5-7'), v('0 0 * * sun,SAT'),
      v('5/20 * * feb-apr *')[0], v('5/20 * * feb-apr *')[3], C.parseCron('@HOURLY').fields.map((f) => f.raw).join(' ')]));""")
    assert r[0] == 5  # "L" errors but every field is still reported
    assert r[1][0] == [1, 4, 7, 10] and r[1][1] == [0, 6, 12, 18] and r[1][2] == [1]
    assert r[2][4] == [0, 5, 6]  # 7 = Sunday
    assert r[3][4] == [0, 6]
    assert r[4] == [5, 25, 45] and r[5] == [2, 3, 4]
    assert r[6] == "0 * * * *"


@pytest.mark.parametrize("expr, field, fragment", [
    ("61 * * * *", "minute", "out of range 0–59"),
    ("* 24 * * *", "hour", "out of range 0–23"),
    ("* * 0 * *", "dom", "out of range 1–31"),
    ("* * * 13 *", "month", "out of range 1–12"),
    ("* * * * 8", "dow", "out of range 0–7"),
    ("* * * foo *", "month", "not a number or a name"),
    ("*/0 * * * *", "minute", "step /0"),
    ("10-5 * * * *", "minute", "backwards"),
    ("1,,2 * * * *", "minute", "empty list item"),
    ("* * * *", None, "Expected 5 fields"),
    ("0 0 * * * *", None, "6 fields"),
    ("@sometimes", None, "Unknown macro"),
    ("", None, "Enter a cron expression"),
])
def test_cron_validation_points_at_field(expr, field, fragment):
    r = _run(f"console.log(JSON.stringify(C.parseCron({json.dumps(expr)})));")
    assert not r["ok"]
    assert r["errors"][0]["field"] == field
    assert fragment in r["errors"][0]["message"]


def test_cron_next_runs_month_end_leap_year_and_vixie_or():
    r = _run("""const iso = (e, from, n, tz) => C.nextRuns(C.parseCron(e), Date.parse(from), n, tz).map((x) => new Date(x.t).toISOString());
    console.log(JSON.stringify([
      iso('0 0 31 * *', '2026-11-05T00:00:00Z', 3, 'UTC'),
      iso('0 0 29 2 *', '2026-11-05T00:00:00Z', 2, 'UTC'),
      iso('0 0 1,15 * 1', '2026-11-05T00:00:00Z', 4, 'UTC'),
      iso('0 0 */10 * 1', '2026-11-05T00:00:00Z', 3, 'UTC'),
      iso('0 0 30 2 *', '2026-11-05T00:00:00Z', 3, 'UTC'),
      iso('*/15 * * * *', '2026-11-05T10:07:30Z', 2, 'UTC'),
      iso('0 21 * * 1-5', '2026-11-05T21:00:00Z', 2, 'UTC'),
      iso('30 9 * * *', '2026-11-05T00:00:00Z', 1, 'Asia/Kolkata'),
    ]));""")
    assert r[0] == ["2026-12-31T00:00:00.000Z", "2027-01-31T00:00:00.000Z", "2027-03-31T00:00:00.000Z"]
    assert r[1] == ["2028-02-29T00:00:00.000Z", "2032-02-29T00:00:00.000Z"]
    # both restricted: 1st, 15th OR Mondays (Nov 9 and 16 are Mondays)
    assert r[2] == ["2026-11-09T00:00:00.000Z", "2026-11-15T00:00:00.000Z", "2026-11-16T00:00:00.000Z", "2026-11-23T00:00:00.000Z"]
    # "*/10" starts with * so DOM counts as unrestricted: Mondays only, which must also be day 1/11/21/31
    assert r[3] == ["2026-12-21T00:00:00.000Z", "2027-01-11T00:00:00.000Z", "2027-02-01T00:00:00.000Z"]
    assert r[4] == []
    assert r[5] == ["2026-11-05T10:15:00.000Z", "2026-11-05T10:30:00.000Z"]
    assert r[6] == ["2026-11-06T21:00:00.000Z", "2026-11-09T21:00:00.000Z"]  # strictly after, skips the weekend
    assert r[7] == ["2026-11-05T04:00:00.000Z"]


def test_cron_next_runs_across_dst():
    r = _run("""const runs = (e, from, n, tz) => C.nextRuns(C.parseCron(e), Date.parse(from), n, tz).map((x) => [new Date(x.t).toISOString(), x.note || '']);
    console.log(JSON.stringify([
      runs('30 2 * * *', '2027-03-27T12:00:00Z', 2, 'Europe/Berlin'),
      runs('30 * * * *', '2027-03-28T00:00:00Z', 3, 'Europe/Berlin'),
      runs('30 2 * * *', '2027-10-30T12:00:00Z', 2, 'Europe/Berlin'),
      runs('30 * * * *', '2027-10-30T23:00:00Z', 4, 'Europe/Berlin'),
      runs('0 9 * * *', '2027-03-13T12:00:00Z', 2, 'America/New_York'),
      runs('0 9 * * *', '2027-03-13T12:00:00Z', 2),
    ]));""", tz="America/New_York")
    # spring forward: 02:30 does not exist; a fixed-time job runs when the gap ends (03:00 CEST = 01:00Z)
    assert r[0] == [["2027-03-28T01:00:00.000Z", "dst-gap"], ["2027-03-29T00:30:00.000Z", ""]]
    # wildcard-hour job: the missing 02:30 is skipped
    assert r[1] == [["2027-03-28T00:30:00.000Z", ""], ["2027-03-28T01:30:00.000Z", ""], ["2027-03-28T02:30:00.000Z", ""]]
    # fall back: 02:30 happens twice; a fixed-time job runs once
    assert r[2] == [["2027-10-31T00:30:00.000Z", "dst-repeat"], ["2027-11-01T01:30:00.000Z", ""]]
    # wildcard-hour job runs in both copies of the repeated hour
    assert [t for t, _ in r[3]] == ["2027-10-30T23:30:00.000Z", "2027-10-31T00:30:00.000Z", "2027-10-31T01:30:00.000Z", "2027-10-31T02:30:00.000Z"]
    # 09:00 local keeps its wall time across the US change; tz=undefined uses the process zone
    assert r[4] == [["2027-03-13T14:00:00.000Z", ""], ["2027-03-14T13:00:00.000Z", ""]]
    assert r[5] == r[4]


def test_cron_builder_and_crontab_line():
    r = _run("""const b = (o) => { try { return C.buildCron(o); } catch (e) { return 'ERR ' + e.message; } };
    console.log(JSON.stringify([
      b({ kind: 'everyN', n: 5 }), b({ kind: 'everyN', n: 1 }), b({ kind: 'hourly', minute: 15 }),
      b({ kind: 'daily', hour: 21, minute: 0 }), b({ kind: 'weekdays', hour: 9, minute: 30 }),
      b({ kind: 'weekly', days: [1, 2, 3, 5], hour: 8, minute: 0 }), b({ kind: 'monthly', dom: 31, hour: 0, minute: 5 }),
      b({ kind: 'daily', hour: 24, minute: 0 }), b({ kind: 'weekly', days: [] }),
      C.crontabLine('0 9 * * 1-5', ''), C.crontabLine('@daily', 'backup.sh'), C.compactList([0, 1, 2, 4, 5, 6]),
    ]));""")
    assert r[:7] == ["*/5 * * * *", "* * * * *", "15 * * * *", "0 21 * * *", "30 9 * * 1-5", "0 8 * * 1-3,5", "5 0 31 * *"]
    assert r[7].startswith("ERR Hour") and r[8].startswith("ERR Pick at least one day")
    assert r[9] == "0 9 * * 1-5 /path/to/command >> /tmp/job.log 2>&1"
    assert r[10] == "@daily backup.sh"
    assert r[11] == "0-2,4-6"


def test_cron_presets_all_parse():
    r = _run("console.log(JSON.stringify(C.PRESETS.map(([, e]) => C.parseCron(e).ok)));")
    assert all(r)


# ------------------------------------------------------------------ env
DOTENV = r'''# comment
export DB_HOST=localhost
DB_PASSWORD="p@ss \"w\"
line2"
NAME=hello world # trailing comment
EMPTY=
DB_HOST=db
1BAD=x
LITERAL='keep $HOME \n'
API_TOKEN=abc123
'''


def test_env_dotenv_parse_and_warnings():
    r = _run(f"""const r = E.parseEnv({json.dumps(DOTENV)});
    console.log(JSON.stringify({{ format: r.format, vars: r.vars.map((v) => [v.key, v.value, v.secret]),
      flags: Object.fromEntries(Object.entries(r.flags).map(([k, s]) => [k, [...s].sort()])), issues: r.issues.map((i) => i.kind + ' ' + i.message) }}));""")
    assert r["format"] == "dotenv"
    assert r["vars"] == [
        ["DB_PASSWORD", 'p@ss "w"\nline2', True], ["NAME", "hello world", False], ["EMPTY", "", False],
        ["DB_HOST", "db", False], ["1BAD", "x", False], ["LITERAL", "keep $HOME \\n", False], ["API_TOKEN", "abc123", True],
    ]
    assert r["flags"]["DB_HOST"] == ["dup"]
    assert r["flags"]["1BAD"] == ["invalid"]
    assert r["flags"]["EMPTY"] == ["empty"]
    assert r["flags"]["NAME"] == ["spaces"]
    assert r["flags"]["DB_PASSWORD"] == ["secret", "spaces"]
    joined = "\n".join(r["issues"])
    assert "DB_HOST is defined more than once (again on line 7); the last value wins." in joined
    assert "NAME has spaces in an unquoted value" in joined
    assert '"1BAD" is not a valid variable name' in joined


@pytest.mark.parametrize("text, fmt, expected", [
    ("export A='it'\\''s'\nexport B=\"x y\"\nexport C=plain", "shell", [["A", "it's"], ["B", "x y"], ["C", "plain"]]),
    ('{"A": "1", "B": 2, "C": null}', "json", [["A", "1"], ["B", "2"], ["C", ""]]),
    ('[{"name": "A", "value": "1"}]', "json", [["A", "1"]]),
    ("docker run --rm \\\n  -e A=1 \\\n  --env \"B=two words\" --env=C=3 -eD=4 nginx", "docker",
     [["A", "1"], ["B", "two words"], ["C", "3"], ["D", "4"]]),
    ("services:\n  web:\n    environment:\n      - A=1\n      - \"B=two words\"\n    ports: []", "compose", [["A", "1"], ["B", "two words"]]),
    ("environment:\n  A: \"1\"\n  B: 'it''s'\n  C: plain # c", "compose", [["A", "1"], ["B", "it's"], ["C", "plain"]]),
    ("env:\n  - name: A\n    value: \"1\"\n  - name: S\n    valueFrom:\n      secretKeyRef:\n        name: x\n        key: y\n  - value: b\n    name: B",
     "k8s", [["A", "1"], ["B", "b"]]),
    ("A=1\nB=2", "dotenv", [["A", "1"], ["B", "2"]]),
])
def test_env_formats_auto_detected(text, fmt, expected):
    r = _run(f"const r = E.parseEnv({json.dumps(text)}); console.log(JSON.stringify([r.format, r.vars.map((v) => [v.key, v.value])]));")
    assert r == [fmt, expected]


def test_env_docker_host_vars_and_env_file_reported():
    r = _run("""const r = E.parseEnv('docker run -e HOSTVAR --env-file ./prod.env img');
    console.log(JSON.stringify([r.vars.map((v) => [v.key, v.value]), r.issues.map((i) => i.message)]));""")
    assert r[0] == [["HOSTVAR", ""]]
    assert any("host environment" in m for m in r[1]) and any("--env-file ./prod.env" in m for m in r[1])


def test_env_outputs_quote_correctly_and_round_trip():
    r = _run(f"""const r = E.parseEnv({json.dumps(DOTENV)});
    const vars = r.vars.filter((v) => v.key !== '1BAD');
    const out = Object.fromEntries(E.OUTPUT_FORMATS.map(([f]) => [f, E.formatEnv(vars, f)]));
    const back = ['dotenv', 'shell', 'json', 'docker', 'compose', 'k8s'].map((f) => {{
      const p = E.parseEnv(out[f], f); return JSON.stringify(p.vars.map((v) => [v.key, v.value])) === JSON.stringify(vars.map((v) => [v.key, v.value]));
    }});
    console.log(JSON.stringify({{ out, back, sorted: E.formatEnv(vars, 'dotenv', {{ sort: true }}).split('\\n').map((l) => l.split('=')[0]) }}));""")
    out = r["out"]
    assert r["back"] == [True] * 6
    assert 'DB_PASSWORD="p@ss \\"w\\"\\nline2"' in out["dotenv"]
    assert "NAME='hello world'" in out["dotenv"] and "EMPTY=\n" in out["dotenv"]
    assert "export DB_PASSWORD='p@ss \"w\"\nline2'" in out["shell"] and "export EMPTY=''" in out["shell"]
    assert "-e 'NAME=hello world' \\\n-e EMPTY= \\\n-e DB_HOST=db" in out["docker"]
    assert out["compose"].startswith("environment:\n  DB_PASSWORD: \"p@ss")
    assert "  - name: API_TOKEN\n    value: \"abc123\"" in out["k8s"]
    assert out["github"].startswith("env:\n") and "  DB_HOST: db" in out["github"]
    assert json.loads(out["json"])["LITERAL"] == "keep $HOME \\n"
    assert r["sorted"] == sorted(r["sorted"])


def test_env_yaml_quotes_ambiguous_scalars():
    r = _run("""console.log(JSON.stringify(['true', 'no', '1.5', '0x1F', '', '~', 'plain', 'a: b', '#x'].map((v) => E.yamlQuote(v))));""")
    assert r == ['"true"', '"no"', '"1.5"', '"0x1F"', '""', '"~"', "plain", '"a: b"', '"#x"']


def test_env_masking_hides_values_but_keeps_length():
    r = _run("""const vars = E.parseEnv('SECRET_KEY=hunter2\\nEMPTY=\\nURL=https://x.io/a b').vars;
    console.log(JSON.stringify(['dotenv', 'shell', 'json', 'docker', 'compose', 'k8s', 'github'].map((f) => E.formatEnv(vars, f, { masked: true }))));""")
    for text in r:
        assert "hunter2" not in text and "x.io" not in text
        assert "•••(7)" in text and "•••(16)" in text


def test_env_diff():
    r = _run("""console.log(JSON.stringify(E.diffEnv(E.parseEnv('A=1\\nB=2\\nC=3').vars, E.parseEnv('{"A":"1","B":"3","D":"4"}').vars)));""")
    assert r == {"added": [{"key": "D", "to": "4"}], "removed": [{"key": "C", "from": "3"}],
                 "changed": [{"key": "B", "from": "2", "to": "3"}], "same": 1}


def test_env_bad_input_is_reported_not_thrown():
    r = _run("""console.log(JSON.stringify(['{bad json', 'A="unclosed\\nB=2', 'just some words', "-e 'A=1"].map((t) => {
      const r = E.parseEnv(t); return [r.vars.length, r.issues.map((i) => i.kind)];
    })));""")
    assert r[0] == [0, ["err"]]
    assert r[1][0] == 1 and "err" in r[1][1]  # unclosed quote reads to the end
    assert r[2] == [0, ["err"]]
    assert r[3] == [0, ["err"]]


# ------------------------------------------------------------------ duration
def test_duration_parse_date_times():
    inputs = ["2026-11-05T10:30:00Z", "2026-11-05 10:30", "2026-11-05", "1762338600", "1762338600123",
              "05/Nov/2026:10:30:00 +0530", "[05/Nov/2026:10:30:00 +0530]", "Nov 5 10:30:00", "Dec 25 10:30:00",
              "Thu, 05 Nov 2026 10:30:00 +0000", "Nov 5, 2026 10:30", "2026-11-05T10:30:00.123+05:30",
              "2026/11/05 10:30:00", "2026-02-30", "garbage", "now"]
    r = _run(f"""const now = Date.parse('2026-11-05T12:00:00Z');
    console.log(JSON.stringify({json.dumps(inputs)}.map((s) => {{ const r = D.parseDateTime(s, {{ tz: 'Asia/Kolkata', now }});
      return r && [new Date(r.ms).toISOString(), r.kind, r.assumedYear ?? null]; }})));""")
    iso = [x and x[0] for x in r]
    assert iso[0] == "2026-11-05T10:30:00.000Z"
    assert iso[1] == "2026-11-05T05:00:00.000Z"  # wall time read in Asia/Kolkata
    assert iso[2] == "2026-11-04T18:30:00.000Z"
    assert r[3] == ["2025-11-05T10:30:00.000Z", "epoch s", None]
    assert r[4] == ["2025-11-05T10:30:00.123Z", "epoch ms", None]
    assert iso[5] == iso[6] == "2026-11-05T05:00:00.000Z"
    assert r[7] == ["2026-11-05T05:00:00.000Z", "syslog (no year)", 2026]
    assert r[8] == ["2025-12-25T05:00:00.000Z", "syslog (no year)", 2025]  # would be in the future → last year
    assert iso[9] == "2026-11-05T10:30:00.000Z"
    assert iso[10] == "2026-11-05T05:00:00.000Z"
    assert iso[11] == "2026-11-05T05:00:00.123Z"
    assert iso[12] == "2026-11-05T05:00:00.000Z"
    assert r[13] is None and r[14] is None
    assert r[15] == ["2026-11-05T12:00:00.000Z", "now", None]


def test_duration_compare_and_business_days():
    r = _run("""const c = D.compare(Date.parse('2026-11-02T10:00:00Z'), Date.parse('2026-11-06T10:30:05.007Z'), 'UTC');
    const bd = (a, b) => D.businessDays(Date.parse(a), Date.parse(b), 'UTC');
    console.log(JSON.stringify([c.text, c.iso, c.parts, c.totals.hours, c.business,
      bd('2026-11-07T00:00Z', '2026-11-09T00:00Z'), bd('2026-11-06T09:00Z', '2026-11-06T17:00Z'),
      bd('1969-12-29T00:00Z', '1970-01-05T00:00Z'), bd('2026-11-30T00:00Z', '2026-11-02T00:00Z'),
      D.compare(Date.parse('2026-11-06T00:00Z'), Date.parse('2026-11-05T22:30Z'), 'UTC').text]));""")
    assert r[0] == "4d 30m 5s 7ms"
    assert r[1] == "P4DT30M5.007S"
    assert r[2] == {"sign": 1, "d": 4, "h": 0, "m": 30, "s": 5, "ms": 7}
    assert r[3] == pytest.approx(96.501390833)
    assert r[4] == {"elapsed": 4, "inclusive": 5, "calendarDays": 4}  # Mon → Fri
    assert r[5] == {"elapsed": 0, "inclusive": 1, "calendarDays": 2}  # Sat → Mon
    assert r[6] == {"elapsed": 0, "inclusive": 1, "calendarDays": 0}
    assert r[7] == {"elapsed": 5, "inclusive": 6, "calendarDays": 7}  # before the epoch
    assert r[8] == {"elapsed": 20, "inclusive": 21, "calendarDays": 28}  # order-independent
    assert r[9] == "−1h 30m"


@pytest.mark.parametrize("text, desc, fixed", [
    ("3d 4h 30m", "3 days 4h 30m", (3 * 24 + 4) * 3600000 + 30 * 60000),
    ("1w2d", "1 week 2 days", 9 * 86400000),
    ("90m", "90m", 5400000),
    ("-1.5h", "−1.5h", 5400000),
    ("PT1H30M", "1h 30m", 5400000),
    ("P1Y2M3DT4H", "1 year 2 months 3 days 4h", 3 * 86400000 + 4 * 3600000),
    ("-P1D", "−1 day", 86400000),
    ("P2W", "2 weeks", 14 * 86400000),
    ("01:30:00", "1h 30m", 5400000),
    ("2 days and 3 hours", "2 days 3h", 51 * 3600000),
    ("500ms", "500ms", 500),
])
def test_duration_parse_durations(text, desc, fixed):
    r = _run(f"const d = D.parseDuration({json.dumps(text)}); console.log(JSON.stringify([D.describeDuration(d), D.fixedMs(d.parts)]));")
    assert r == [desc, fixed]


@pytest.mark.parametrize("text, fragment", [
    ("5", "needs a unit"), ("3x", 'Unknown unit "x"'), ("P", "incomplete"), ("PT", "incomplete"),
    ("1.5mo", "Fractional"), ("", "Enter a duration"), ("3d banana", "Could not read"),
])
def test_duration_bad_durations(text, fragment):
    r = _run(f"try {{ D.parseDuration({json.dumps(text)}); console.log('null'); }} catch (e) {{ console.log(JSON.stringify(e.message)); }}")
    assert r and fragment in r


def test_duration_add_is_calendar_aware_across_dst_and_month_ends():
    r = _run("""const add = (iso, d, tz) => D.isoInZone(D.addDuration(Date.parse(iso), D.parseDuration(d), tz), tz);
    console.log(JSON.stringify([
      add('2027-03-27T09:00:00Z', '1d', 'Europe/Berlin'), add('2027-03-27T09:00:00Z', '24h', 'Europe/Berlin'),
      add('2026-01-31T10:00:00Z', '1mo', 'UTC'), add('2028-02-29T10:00:00Z', '-1y', 'UTC'), add('2028-02-29T10:00:00Z', '1y', 'UTC'),
      add('2026-11-05T10:00:00Z', '-PT90M', 'UTC'), add('2026-11-05T10:00:00Z', '1w2d', 'Asia/Kolkata'),
      add('2026-12-31T23:59:59.500Z', '500ms', 'UTC'), add('2026-03-31T10:00:00Z', '-1mo', 'UTC'),
    ]));""")
    assert r == [
        "2027-03-28T10:00:00+02:00",  # same wall clock the next day
        "2027-03-28T11:00:00+02:00",  # exactly 24 h later
        "2026-02-28T10:00:00+00:00", "2027-02-28T10:00:00+00:00", "2029-02-28T10:00:00+00:00",
        "2026-11-05T08:30:00+00:00", "2026-11-14T15:30:00+05:30", "2027-01-01T00:00:00+00:00",
        "2026-02-28T10:00:00+00:00",
    ]


def test_duration_formatting_helpers():
    r = _run("""console.log(JSON.stringify([D.formatDuration(-93784005), D.formatDuration(0), D.toIsoDuration(-5400000),
      D.toIsoDuration(0), D.offsetText(Date.parse('2026-11-05T00:00Z'), 'Asia/Kolkata'), D.offsetText(Date.parse('2026-07-01T00:00Z'), 'America/St_Johns'),
      D.formatWall(Date.parse('2026-11-05T10:30:00.042Z'), 'UTC')]));""")
    assert r == ["−1d 2h 3m 4s 5ms", "0s", "-PT1H30M", "PT0S", "+05:30", "-02:30", "2026-11-05 10:30:00.042"]


def test_duration_scan_log_finds_stamps_gaps_and_backwards():
    log = "\n".join([
        "2026-11-05 10:00:00 INFO start",
        "2026-11-05 10:00:05 INFO step",
        "  continuation without stamp",
        "2026-11-05T10:05:00.250Z WARN slow",
        '127.0.0.1 - - [05/Nov/2026:10:04:00 +0000] "GET / HTTP/1.1" 200',
        "Nov  5 10:30:00 host app[1]: done",
        "ts=1793875800 epoch line",
        "",
    ])
    r = _run(f"""const r = D.scanLog({json.dumps(log)}, {{ tz: 'UTC', now: Date.parse('2026-11-05T12:00:00Z'), gapSeconds: 60 }});
    console.log(JSON.stringify({{ stamps: r.stamps.map((s) => [s.line, s.kind, new Date(s.ms).toISOString()]),
      gaps: r.gaps.map((g) => [g.from.line, g.to.line, g.ms]), back: r.backwards.map((g) => [g.from.line, g.to.line, g.ms]),
      first: new Date(r.first).toISOString(), last: new Date(r.last).toISOString(), span: r.spanMs, lines: r.lines }}));""")
    assert r["stamps"] == [
        [1, "ISO 8601", "2026-11-05T10:00:00.000Z"], [2, "ISO 8601", "2026-11-05T10:00:05.000Z"],
        [4, "ISO 8601", "2026-11-05T10:05:00.250Z"], [5, "Apache / nginx", "2026-11-05T10:04:00.000Z"],
        [6, "syslog (no year)", "2026-11-05T10:30:00.000Z"], [7, "epoch s", "2026-11-05T10:50:00.000Z"],
    ]
    assert r["gaps"] == [[2, 4, 295250], [5, 6, 1560000], [6, 7, 1200000]]
    assert r["back"] == [[4, 5, -60250]]
    assert (r["first"], r["last"], r["span"], r["lines"]) == ("2026-11-05T10:00:00.000Z", "2026-11-05T10:50:00.000Z", 3000000, 7)
