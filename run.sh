#!/usr/bin/env bash
# Start Everyday Utility on http://127.0.0.1:${EU_PORT:-8765}
set -euo pipefail
cd "$(dirname "$0")"
if [[ -d .venv ]]; then
  if [[ -f .venv/bin/activate ]]; then
    source .venv/bin/activate
  elif [[ -f .venv/Scripts/activate ]]; then
    source .venv/Scripts/activate
  fi
fi

PYTHON=""
for cmd in python3 python py; do
  if command -v "$cmd" >/dev/null 2>&1 && "$cmd" --version >/dev/null 2>&1; then
    PYTHON="$cmd"
    break
  fi
done

if [[ -z "$PYTHON" ]]; then
  echo "Error: Python not found. Please install Python 3.10+ and add it to your PATH." >&2
  exit 1
fi

exec "$PYTHON" -m uvicorn app.main:app --host "${EU_HOST:-127.0.0.1}" --port "${EU_PORT:-8765}" "$@"
