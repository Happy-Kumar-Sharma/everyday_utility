"""Running SQL against a Postgres database described by a ``export KEY=VALUE`` credentials script.

Queries go through ``psql`` (no Python driver needed in this app's environment). SQL is always passed as
a file because an ``IN (...)`` list of 20k ids is larger than Linux's single-argument limit (128 KiB).
"""

from __future__ import annotations

import shlex
from pathlib import Path

REQUIRED = ("POSTGRES_USER", "POSTGRES_HOST", "POSTGRES_DB")


class PostgresConfigError(ValueError):
    pass


def read_env_file(path: Path) -> dict:
    """Parse ``export KEY=VALUE`` lines (later lines win, comments ignored) — same rules as the aicdb scripts."""
    env: dict[str, str] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line.startswith("export "):
            continue
        try:
            tokens = shlex.split(line[len("export ") :], comments=True)
        except ValueError:
            continue
        if tokens and "=" in tokens[0]:
            key, value = tokens[0].split("=", 1)
            env[key] = value
    return env


def pg_env(env_file: str | Path, read_only: bool = True) -> dict:
    path = Path(env_file).expanduser()
    if not path.is_file():
        raise PostgresConfigError(f"credentials file not found: {path}")
    env = read_env_file(path)
    missing = [k for k in REQUIRED if not env.get(k)]
    if missing:
        raise PostgresConfigError(f"{path}: missing {', '.join(missing)}")
    out = {
        "PGHOST": env["POSTGRES_HOST"],
        "PGPORT": env.get("POSTGRES_PORT") or "5432",
        "PGUSER": env["POSTGRES_USER"],
        "PGPASSWORD": env.get("POSTGRES_PASSWORD", ""),
        "PGDATABASE": env["POSTGRES_DB"],
        "PGAPPNAME": "everyday_utility",
    }
    if read_only:
        # the server rejects INSERT/UPDATE/DELETE/DDL in these sessions
        out["PGOPTIONS"] = "-c default_transaction_read_only=on"
    return out


def describe_target(env: dict) -> str:
    return f"{env['PGUSER']}@{env['PGHOST']}:{env['PGPORT']}/{env['PGDATABASE']}"


def export_csv_script(sql_file: Path, out_csv: Path) -> tuple[str, str]:
    """(script, display) that runs sql_file and writes the result set to out_csv with a header."""
    q_sql, q_out = shlex.quote(str(sql_file)), shlex.quote(str(out_csv))
    # psql truncates its -o file before connecting; writing to a temp file keeps the previous CSV
    # intact when the query fails
    q_tmp = shlex.quote(str(out_csv) + ".partial")
    script = (
        "set -euo pipefail\n"
        f'echo "connecting to $PGUSER@$PGHOST:$PGPORT/$PGDATABASE"\n'
        f"mkdir -p {shlex.quote(str(out_csv.parent))}\n"
        f"trap 'rm -f {q_tmp}' EXIT\n"
        f"psql -X -q -v ON_ERROR_STOP=1 --csv -f {q_sql} -o {q_tmp}\n"
        f"mv -f {q_tmp} {q_out}\n"
        f'echo "wrote {out_csv} ($(( $(wc -l < {q_out}) - 1 )) lines)"\n'
    )
    display = f"psql --csv -f {q_sql} -o {q_out}   # PG* env from credentials file"
    return script, display
