"""Clipper worker process: python3 -m app.services.clipper.cli --url URL --out CLIPS_DIR [...]

Run by the web server as a background job, so a long clip never blocks the server and Cancel (SIGTERM to the
job's process group) stops it cleanly. Prints progress lines and ends with one machine-readable line:
``CLIP_DONE {json}`` or ``CLIP_ERROR message``.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
from pathlib import Path

from app.core import audit

from . import fetcher
from .clip import ClipFailed, clip
from .netguard import BlockedURL, FetchError, Policy, public_only, strip_query


class Cancelled(BaseException):
    pass


def _on_term(signum, _frame):
    fetcher.kill_active()
    raise Cancelled()


def say(line: str) -> None:
    print(line, flush=True)


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="clipper")
    p.add_argument("--url", required=True)
    p.add_argument("--out", required=True, help="clips folder")
    p.add_argument("--mode", default="auto", choices=("auto", "static", "browser"))
    p.add_argument("--content", default="main", choices=("main", "full"))
    p.add_argument("--no-images", action="store_true")
    p.add_argument("--save-html", action="store_true")
    p.add_argument("--settings-json", default="{}", help="clipper settings as a JSON object")
    return p.parse_args(argv)


def main(argv: list[str] | None = None, *, policy: Policy = public_only, **clip_kwargs) -> int:
    args = parse_args(argv)
    signal.signal(signal.SIGTERM, _on_term)
    target = strip_query(args.url)
    try:
        settings = json.loads(args.settings_json)
        if not isinstance(settings, dict):
            raise ValueError("settings must be a JSON object")
        result = clip(args.url, Path(args.out), mode=args.mode, content=args.content,
                      download_images=not args.no_images, save_html=args.save_html, settings=settings,
                      policy=policy, log=say, **clip_kwargs)
    except Cancelled:
        say("CLIP_ERROR cancelled")
        audit.record("clip", "create", target, status="cancelled")
        sys.stdout.flush()
        os._exit(143)  # do not wait for download threads
    except (BlockedURL, FetchError, ClipFailed, ValueError, OSError) as e:
        msg = str(e) or type(e).__name__
        say(f"CLIP_ERROR {msg}")
        audit.record("clip", "create", target, status="failed", detail={"error": type(e).__name__})
        return 1
    except Exception as e:  # noqa: BLE001 - report, never a bare traceback only
        say(f"CLIP_ERROR unexpected {type(e).__name__}: {e}")
        audit.record("clip", "create", target, status="failed", detail={"error": type(e).__name__})
        raise
    c = result["counts"]
    audit.record("clip", "create", target, status="ok",
                 detail={"mode": result["mode"], "words": result["words"], "images_found": c["found"],
                         "images_saved": c["saved"], "images_failed": c["failed"], "images_deduped": c["deduped"]})
    say("CLIP_DONE " + json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
