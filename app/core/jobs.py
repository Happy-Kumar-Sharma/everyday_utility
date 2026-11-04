"""Background shell jobs with live, resumable log output.

A job is a bash script run in its own process group (so cancel kills the whole tree, e.g. python + its
worker threads/processes). Output is captured from a merged stdout/stderr pipe:

* lines ended by ``\\n`` are *committed* and never change; they get absolute indexes so a client can
  resume with ``since=<n>`` after a reconnect;
* the trailing unterminated text is the *partial* line. A ``\\r`` (tqdm style progress bars) resets it,
  so progress bars update in place instead of flooding the log.

The full raw output is also written to ``data/jobs/<id>.log``.
"""

from __future__ import annotations

import codecs
import os
import signal
import subprocess
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

RUNNING, SUCCEEDED, FAILED, CANCELLED = "running", "succeeded", "failed", "cancelled"


class JobConflict(RuntimeError):
    pass


@dataclass
class Job:
    id: str
    title: str
    script: str
    display: str  # what the UI shows / lets the user copy (secrets masked)
    cwd: str | None
    log_path: Path
    lock_key: str | None = None
    meta: dict = field(default_factory=dict)
    status: str = RUNNING
    exit_code: int | None = None
    started_at: float = field(default_factory=time.time)
    ended_at: float | None = None
    max_lines: int = 5000

    def __post_init__(self):
        self._lines: deque[str] = deque(maxlen=self.max_lines)
        self._dropped = 0  # committed lines evicted from memory
        self._partial = ""
        self._cr = False  # a \r was seen; the next text replaces the partial line
        self._lock = threading.Lock()
        self._proc: subprocess.Popen | None = None
        self._cancel_requested = False

    # ---- output ---------------------------------------------------------------------------------
    def _feed(self, text: str) -> None:
        with self._lock:
            for i, chunk in enumerate(text.split("\n")):
                if i > 0:  # previous chunk ended with \n
                    self._commit(self._partial)
                    self._partial = ""
                    self._cr = False
                for j, seg in enumerate(chunk.split("\r")):
                    if j > 0:  # like a terminal: text after \r overwrites the line
                        self._cr = True
                    if seg:
                        self._partial = seg if self._cr else self._partial + seg
                        self._cr = False

    def _commit(self, line: str) -> None:
        if len(self._lines) == self._lines.maxlen:
            self._dropped += 1
        self._lines.append(line)

    def _flush(self) -> None:
        with self._lock:
            if self._partial:
                self._commit(self._partial)
                self._partial = ""

    def output_since(self, since: int) -> dict:
        """Committed lines with absolute index >= since, plus the current partial line."""
        with self._lock:
            total = self._dropped + len(self._lines)
            start = max(since, self._dropped)
            lines = list(self._lines)[start - self._dropped :] if start < total else []
            return {"start": start, "lines": lines, "partial": self._partial, "total": total}

    # ---- state ----------------------------------------------------------------------------------
    @property
    def done(self) -> bool:
        return self.status != RUNNING

    def to_dict(self) -> dict:
        end = self.ended_at or time.time()
        return {
            "id": self.id,
            "title": self.title,
            "display": self.display,
            "cwd": self.cwd,
            "status": self.status,
            "exit_code": self.exit_code,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "duration": round(end - self.started_at, 1),
            "lock_key": self.lock_key,
            "meta": self.meta,
            "log_path": str(self.log_path),
        }


class JobManager:
    def __init__(self, log_dir: Path, max_lines: int = 5000, keep: int = 100):
        self.log_dir = log_dir
        self.max_lines = max_lines
        self.keep = keep
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def start(
        self,
        title: str,
        script: str,
        *,
        display: str | None = None,
        cwd: str | None = None,
        env: dict | None = None,
        lock_key: str | None = None,
        meta: dict | None = None,
    ) -> Job:
        with self._lock:
            if lock_key:
                for j in self._jobs.values():
                    if j.lock_key == lock_key and not j.done:
                        raise JobConflict(f"'{j.title}' is already running (job {j.id})")
            job_id = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
            self.log_dir.mkdir(parents=True, exist_ok=True)
            job = Job(
                id=job_id,
                title=title,
                script=script,
                display=display or script,
                cwd=cwd,
                log_path=self.log_dir / f"{job_id}.log",
                lock_key=lock_key,
                meta=meta or {},
                max_lines=self.max_lines,
            )
            self._jobs[job_id] = job
            self._prune()

        full_env = {**os.environ, "PYTHONUNBUFFERED": "1", **(env or {})}
        try:
            proc = subprocess.Popen(
                ["bash", "-c", script],
                cwd=cwd or None,
                env=full_env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                start_new_session=True,  # own process group -> cancel kills children too
            )
        except OSError as e:
            job._feed(f"failed to start: {e}\n")
            job.status, job.exit_code, job.ended_at = FAILED, -1, time.time()
            return job
        job._proc = proc
        threading.Thread(target=self._pump, args=(job, proc), daemon=True, name=f"job-{job_id}").start()
        return job

    def _pump(self, job: Job, proc: subprocess.Popen) -> None:
        assert proc.stdout is not None
        fd = proc.stdout.fileno()
        # incremental: a multi-byte character split across two reads is decoded intact
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        log_file = None
        error = None
        try:
            try:
                log_file = job.log_path.open("wb")
                log_file.write(f"$ {job.display}\n\n".encode())
            except OSError as e:
                job._feed(f"[everyday-utility] cannot write log file: {e}\n")
                log_file = None
            while True:
                chunk = os.read(fd, 65536)
                if not chunk:
                    break
                if log_file:
                    try:
                        log_file.write(chunk)
                        log_file.flush()
                    except OSError as e:  # e.g. disk full: keep the job and the live view going
                        job._feed(f"\n[everyday-utility] log file write failed, continuing in memory: {e}\n")
                        log_file = None
                job._feed(decoder.decode(chunk))
            job._feed(decoder.decode(b"", final=True))
        except Exception as e:  # never leave a job stuck in RUNNING
            error = e
            job._feed(f"\n[everyday-utility] output reader crashed: {e!r}\n")
            self._kill_group(proc.pid, signal.SIGKILL)
        finally:
            if log_file:
                log_file.close()
            code = proc.wait()
            job._flush()
            job.exit_code = code
            job.ended_at = time.time()
            if job._cancel_requested:
                job.status = CANCELLED
            else:
                job.status = SUCCEEDED if code == 0 and error is None else FAILED

    @staticmethod
    def _kill_group(pgid: int, sig: int) -> bool:
        try:
            os.killpg(pgid, sig)
            return True
        except (ProcessLookupError, PermissionError):
            return False

    def _prune(self) -> None:
        finished = [j for j in self._jobs.values() if j.done]
        for j in sorted(finished, key=lambda j: j.started_at)[: max(0, len(self._jobs) - self.keep)]:
            self._jobs.pop(j.id, None)

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def list(self) -> list[Job]:
        return sorted(self._jobs.values(), key=lambda j: j.started_at, reverse=True)

    def cancel(self, job_id: str, grace: float = 5.0) -> Job | None:
        job = self._jobs.get(job_id)
        if not job or job.done or not job._proc:
            return job
        job._cancel_requested = True
        pgid = job._proc.pid  # start_new_session: the group id is the leader's pid
        if not self._kill_group(pgid, signal.SIGTERM):
            return job

        def _escalate():
            time.sleep(grace)
            # check the job, not the bash leader: children that ignore SIGTERM keep the pipe (and job) open
            if not job.done:
                self._kill_group(pgid, signal.SIGKILL)

        threading.Thread(target=_escalate, daemon=True).start()
        return job

    def shutdown(self, grace: float = 3.0) -> None:
        running = [j for j in self._jobs.values() if not j.done and j._proc]
        for job in running:
            self.cancel(job.id, grace=grace)
        # synchronous: daemon escalation threads die with the server, so finish the job here
        deadline = time.time() + grace
        while any(not j.done for j in running) and time.time() < deadline:
            time.sleep(0.1)
        for job in running:
            if not job.done:
                self._kill_group(job._proc.pid, signal.SIGKILL)
