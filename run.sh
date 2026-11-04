#!/usr/bin/env bash
# Start Everyday Utility on http://127.0.0.1:${EU_PORT:-8765}
set -euo pipefail
cd "$(dirname "$0")"
if [[ -d .venv ]]; then source .venv/bin/activate; fi
exec python3 -m uvicorn app.main:app --host "${EU_HOST:-127.0.0.1}" --port "${EU_PORT:-8765}" "$@"
