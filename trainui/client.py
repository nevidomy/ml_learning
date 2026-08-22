"""Python client for logging training metrics to a trainui server.

Usage:
    from trainui.client import Tracker

    tracker = Tracker(model_id="gpt-v6", description="6-layer GPT on names")
    with tracker.start_run() as run:
        for it in range(1000):
            ...
            run.log(iteration=it, batches=32, train_loss=loss, lr=lr)
            if it % 100 == 0:
                run.log(iteration=it, test_loss=test_loss)

If the server reports a sequence inconsistency (e.g. the process crashed and
restarted), `run.log` raises `SequenceError`. Call `run.resume()` to mark the
gap as a pause and continue logging from the server's expected sequence.

To continue an existing run from a NEW process (even a finished one), use
`tracker.attach_run(run_id)`.
"""
from __future__ import annotations

import atexit
import hashlib
import json
import os
import queue
import re
import sys
import threading
import time
from typing import Optional, Union

import requests

DEFAULT_URL = "http://127.0.0.1:8501"


class TrainUIError(Exception):
    pass


class SequenceError(TrainUIError):
    """Raised when the server rejects a log call due to a sequence gap."""

    def __init__(self, run_id: int, expected_seq: int, received_seq: int, message: str):
        self.run_id = run_id
        self.expected_seq = expected_seq
        self.received_seq = received_seq
        super().__init__(message)


class Run:
    def __init__(self, tracker: "Tracker", run_id: Union[int, str]):
        # run_id is the server id when online, or a "local-N" ref when the
        # tracker has fallen back to offline logging
        self.tracker = tracker
        self.id = run_id
        self._seq = 1
        self._finished = False

    @property
    def url(self) -> Optional[str]:
        """Direct link to this run's page in the web UI.

        None while the run exists only offline (a "local-N" ref) -- it gets
        a real server id, and with it a URL, once the log is uploaded."""
        if isinstance(self.id, str):
            return None
        return f"{self.tracker.base_url}/#/runs/{self.id}"

    def log(
        self,
        iteration: int,
        batches: int = 0,
        context_size: Optional[int] = None,
        lr2: Optional[float] = None,
        **metrics: float,
    ) -> None:
        """Log one training point. Metric keys may vary between calls.

        `context_size` is the per-batch sequence length; together with
        `batches` it lets the UI compute tokens/sec. If omitted, the model's
        `context_width` (set on the Tracker) is used as the default.

        `lr2` is an optional secondary learning rate; it is displayed on the
        same chart as the primary `lr` (pass `lr=...` as a metric).
        """
        if self._finished:
            raise TrainUIError(f"run {self.id} is finished")
        if self.tracker.disabled:
            self._seq += 1
            return
        if lr2 is not None:
            metrics["lr2"] = lr2
        record = {
            "op": "log",
            "run": self.id,
            "payload": {
                "seq": self._seq,
                "iteration": iteration,
                "batches": batches,
                "context_size": context_size,
                "metrics": metrics,
                "ts": time.time(),
            },
        }
        try:
            if self.tracker.async_upload:
                # never blocks: the background worker preserves ordering
                # (single FIFO queue) and falls back to the offline file
                self.tracker._enqueue(record)
                self._seq += 1
                return
            if self.tracker.offline:
                # server already known to be down: just append to the local log
                self.tracker._log_offline(record)
                self._seq += 1
                return
            self._seq = self._log_sync(record)
        except SequenceError:
            raise
        except Exception as e:
            # absolute last resort: metric collection must never kill the
            # training loop -- go offline and keep the point
            self._seq += 1
            self.tracker._fallback_offline(
                record, f"unexpected client error: {e!r}"
            )

    def _log_sync(self, record: dict) -> int:
        """Synchronous send with retry/dedup (async_upload=False mode).

        Returns the sequence number to use for the next log call."""
        payload = record["payload"]
        # Retry transient network failures. A timed-out request may still have
        # been applied server-side; the 409 dedup below detects that case.
        resp = None
        retried = False
        for attempt in range(3):
            try:
                resp = self.tracker._post(
                    f"/api/runs/{self.id}/log",
                    {k: v for k, v in payload.items() if k != "ts"},
                )
                break
            except TrainUIError:
                retried = True
                if attempt == 2:
                    raise
                time.sleep(0.5 * (attempt + 1))
        if resp.status_code == 409:
            detail = resp.json().get("detail", {})
            expected = detail.get("expected_seq", -1)
            if retried and expected == self._seq + 1:
                # an earlier timed-out attempt was applied; adopt its result
                return expected
            raise SequenceError(
                run_id=self.id,
                expected_seq=expected,
                received_seq=self._seq,
                message=detail.get("message", "sequence conflict"),
            )
        self._check(resp)
        return resp.json()["next_seq"]

    def resume(self, next_seq: Optional[int] = None) -> None:
        """Mark the elapsed time since the last log as a pause and continue.

        The next `log` call will use the server's expected sequence (or
        `next_seq` if given). Pause gaps are excluded from graph time axes.
        """
        if self.tracker.disabled:
            self._finished = False
            return
        record = {"op": "resume", "run": self.id,
                  "payload": {"next_seq": self._seq, "end_ts": time.time()}}
        if self.tracker.offline:
            self.tracker._enqueue_or_file(record)
            self._finished = False
            return
        try:
            if self.tracker.async_upload:
                # preserve ordering: queued logs must land before the resume
                self.tracker.flush()
            resp = self.tracker._post(
                f"/api/runs/{self.id}/resume", {"next_seq": next_seq}
            )
            self._check(resp)
            self._seq = resp.json()["next_seq"]
        except Exception:
            self.tracker._go_offline()
            self.tracker._enqueue_or_file(record)
        self._finished = False

    def finish(self) -> None:
        if self._finished:
            return
        record = {"op": "finish", "run": self.id}
        if self.tracker.disabled:
            pass
        elif self.tracker.async_upload and not self.tracker.offline:
            # enqueue behind any pending logs (ordering preserved by the
            # worker), then wait briefly so the run shows completed promptly;
            # if the server is hanging this gives up after flush_timeout and
            # close()/atexit dumps the rest to the offline file
            self.tracker._enqueue(record)
            self.tracker.flush()
        elif self.tracker.offline:
            self.tracker._enqueue_or_file(record)
        else:
            try:
                resp = self.tracker._post(f"/api/runs/{self.id}/finish", {})
                self._check(resp)
            except Exception:
                self.tracker._go_offline()
                self.tracker._log_offline(record)
        self._finished = True

    def __enter__(self) -> "Run":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if not self._finished:
            self.finish()

    @staticmethod
    def _check(resp: requests.Response) -> None:
        if resp.status_code >= 400:
            raise TrainUIError(f"{resp.status_code}: {resp.text}")


class Tracker:
    def __init__(
        self,
        model_id: str,
        description: str = "",
        base_url: Optional[str] = None,
        timeout: float = 30.0,
        param_count: Optional[int] = None,
        context_width: Optional[int] = None,
        metrics: Optional[list[str]] = None,
        token: Optional[str] = None,
        disabled: bool = False,
        chars_per_token: Optional[float] = None,
        async_upload: bool = True,
        flush_interval: float = 2.0,
        flush_timeout: float = 5.0,
    ):
        """Declare a model and its metrics.

        `metrics` declares custom metric names up front; the UI then shows a
        chart for each one even before (or unless) data for it arrives.

        `token` is the bearer token for servers with auth enabled; defaults to
        the TRAINUI_API_TOKEN environment variable.

        `disabled=True` runs the tracker as a dry run: no HTTP requests are
        made at all, and every call is a no-op.

        `chars_per_token` enables BPC (bits per character) display for loss
        charts: bpc = loss / chars_per_token / ln(2).

        `async_upload=True` (default) makes `run.log()` non-blocking: points
        go onto an in-memory queue and a single daemon thread uploads them in
        order, batched (every `flush_interval` seconds at the latest).
        Ordering per run is strictly preserved. `finish()` waits for the
        queue to drain, but never longer than `flush_timeout` seconds.
        With `async_upload=False` every `log()` is a synchronous HTTP POST.

        If the server is unreachable (or anything else goes wrong while
        sending), the tracker automatically switches to offline mode: every
        request is appended to a `trainui-offline-*.jsonl` file in the
        working directory instead, so training is never blocked or killed by
        metric collection. Upload later with `python -m trainui.upload <file>`.
        """
        self.async_upload = async_upload
        self.flush_interval = flush_interval
        self.flush_timeout = flush_timeout
        self._queue: Optional[queue.Queue] = None
        self._worker: Optional[threading.Thread] = None
        self._sentinel = object()
        self._buffered = 0
        self._inflight = 0
        self._idle = threading.Condition()
        self._file_lock = threading.Lock()
        self._closed = False
        self.base_url = (
            base_url or os.environ.get("TRAINUI_URL") or DEFAULT_URL
        ).rstrip("/")
        self.model_id = model_id
        self.timeout = timeout
        self.disabled = disabled
        self.token = token if token is not None else os.environ.get("TRAINUI_API_TOKEN")
        self.offline = False
        self._offline_file = None
        self._offline_path = None
        self._local_run_counter = 0
        # fingerprint used in the offline file name
        self._fingerprint = hashlib.sha1(
            json.dumps(
                {
                    "url": self.base_url,
                    "model_id": model_id,
                    "description": description,
                    "param_count": param_count,
                    "context_width": context_width,
                    "metrics": metrics,
                    "chars_per_token": chars_per_token,
                },
                sort_keys=True,
            ).encode()
        ).hexdigest()[:8]
        if disabled:
            return
        payload = {"model_id": model_id, "description": description}
        if param_count is not None:
            payload["param_count"] = param_count
        if context_width is not None:
            payload["context_width"] = context_width
        if metrics is not None:
            payload["metrics_decl"] = list(metrics)
        if chars_per_token is not None:
            payload["chars_per_token"] = chars_per_token
        if async_upload:
            # worker runs even if init already went offline: all records flow
            # through the single queue so the offline file stays strictly
            # ordered
            self._queue = queue.Queue()
            self._worker = threading.Thread(
                target=self._worker_loop, name="trainui-upload", daemon=True
            )
            self._worker.start()
            atexit.register(self.close)
        try:
            resp = self._post("/api/init", payload)
            Run._check(resp)
        except Exception:
            self._go_offline()
            self._log_offline({"op": "init", "payload": payload})

    def start_run(self, description: str = "", runner: str = "") -> Run:
        """Start a new run.

        `description` is an optional note shown in the UI. `runner` is an
        optional label for who/what is running it (hostname, user, machine);
        when set it is shown in run lists.
        """
        if self.disabled:
            return Run(self, 0)
        payload = {
            "model_id": self.model_id,
            "description": description,
            "runner": runner,
        }
        if self.offline:
            return self._start_offline_run(payload)
        try:
            if self.async_upload:
                # ordering with pending finish/resume of previous runs is not
                # required (different runs), but a hung server shouldn't block
                # here longer than a bounded flush + one request timeout
                self.flush()
            resp = self._post("/api/runs", payload)
            Run._check(resp)
            return Run(self, resp.json()["id"])
        except Exception:
            self._go_offline()
            return self._start_offline_run({**payload, "started_at": time.time()})

    def _start_offline_run(self, payload: dict) -> Run:
        ref = f"local-{self._local_run_counter}"
        self._local_run_counter += 1
        payload.setdefault("started_at", time.time())
        self._enqueue_or_file({"op": "start_run", "local_run": ref, "payload": payload})
        return Run(self, ref)

    def attach_run(self, run_id: int) -> Run:
        """Attach to an EXISTING run and continue logging to it -- including
        a completely stopped or finished one (e.g. training restarted in a
        new process and should keep writing to the same run).

        The run is reopened (status running), the gap since its last
        activity is recorded as a pause (excluded from time axes and
        statistics), and the returned Run logs from the server's expected
        sequence, so no SequenceError dance is needed.

        Unlike the rest of the API this is deliberately online-only: it has
        to learn the server's sequence state, so it raises TrainUIError if
        the server is unreachable or the run does not exist (catch it and
        fall back to start_run() if you'd rather begin a fresh run).
        """
        if self.disabled:
            return Run(self, run_id)
        if self.offline:
            raise TrainUIError(
                "tracker is in offline mode; upload the offline log first "
                "and attach from a fresh process"
            )
        if self.async_upload:
            # pending records of other runs must land before we reopen this
            # one (same ordering guarantee start_run relies on)
            self.flush()
        resp = self._post(f"/api/runs/{run_id}/resume", {"next_seq": None})
        Run._check(resp)
        run = Run(self, run_id)
        run._seq = resp.json()["next_seq"]
        print(f"trainui: attached to run #{run_id}: {run.url}",
              file=sys.stderr)
        return run

    # ----- offline fallback -----

    def _go_offline(self) -> None:
        if self.offline:
            return
        safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", self.model_id)
        base = f"trainui-offline-{safe}-{self._fingerprint}-{int(time.time())}-{os.getpid()}"
        for i in range(100):
            path = os.path.abspath(f"{base}{'-' + str(i) if i else ''}.jsonl")
            try:
                # exclusive create: never clobber another process's log
                self._offline_file = open(path, "x", encoding="utf-8")
                self._offline_path = path
                break
            except FileExistsError:
                continue
            except OSError:
                break
        self.offline = True
        print(
            f"trainui: server unreachable; logging metrics offline to "
            f"{self._offline_path or '<nowhere: could not create file>'}. "
            f"Upload later with: python -m trainui.upload <file>",
            file=sys.stderr,
        )

    def _log_offline(self, record: dict) -> None:
        if self._offline_file is None:
            return
        with self._file_lock:
            self._offline_file.write(json.dumps(record) + "\n")
            self._offline_file.flush()

    def _fallback_offline(self, record: dict, why: str) -> None:
        """Last-resort path: keep the data, warn once per transition."""
        try:
            self._go_offline()
            self._log_offline(record)
        except Exception:
            pass
        print(f"trainui: {why}; logging offline", file=sys.stderr)

    # ----- async upload worker -----

    def _enqueue(self, record: dict) -> None:
        """Non-blocking hand-off to the worker (or the file in sync mode)."""
        if self._queue is not None:
            self._queue.put(record)  # unbounded queue: put never blocks
        elif self.offline:
            self._log_offline(record)

    def _enqueue_or_file(self, record: dict) -> None:
        if self._queue is not None:
            self._queue.put(record)
        else:
            self._log_offline(record)

    def flush(self, timeout: Optional[float] = None) -> bool:
        """Wait until every queued record has been sent (or filed offline).

        Bounded by `timeout` (default `flush_timeout`); returns False if the
        queue did not drain in time (the data is still safe: it stays queued
        and close()/atexit will dump it to the offline file)."""
        if self._queue is None:
            return True
        deadline = time.time() + (self.flush_timeout if timeout is None else timeout)
        with self._idle:
            while not (
                self._queue.empty()
                and self._buffered == 0
                and self._inflight == 0
            ):
                remaining = deadline - time.time()
                if remaining <= 0:
                    return False
                self._idle.wait(min(remaining, 0.05))
        return True

    def close(self, timeout: Optional[float] = None) -> None:
        """Flush pending records and stop the worker. Idempotent; registered
        with atexit. On timeout, whatever is still queued is dumped to the
        offline file, so data survives even a hung server."""
        if self._closed:
            return
        self._closed = True
        if self._queue is None:
            return
        ok = self.flush(timeout)
        try:
            self._queue.put(self._sentinel)
        except Exception:
            pass
        self._worker.join(timeout=(timeout or self.flush_timeout) + 2)
        if not ok:
            # worker stuck (e.g. inside a 30s HTTP timeout): take the rest
            self._go_offline()
            while True:
                try:
                    rec = self._queue.get_nowait()
                except queue.Empty:
                    break
                if rec is not self._sentinel:
                    self._log_offline(rec)
        if self._offline_file is not None:
            try:
                self._offline_file.close()
            except Exception:
                pass

    def _worker_loop(self) -> None:
        buf: list[dict] = []
        last_dispatch = time.monotonic()
        while True:
            try:
                rec = self._queue.get(timeout=self.flush_interval)
            except queue.Empty:
                rec = None
            except Exception:
                rec = None
            if rec is self._sentinel:
                if buf:
                    self._dispatch(buf)
                with self._idle:
                    self._buffered = 0
                    self._idle.notify_all()
                return
            if rec is not None:
                buf.append(rec)
                while len(buf) < 500:
                    try:
                        nxt = self._queue.get_nowait()
                    except queue.Empty:
                        break
                    if nxt is self._sentinel:
                        self._queue.put(self._sentinel)  # re-arm for the top loop
                        break
                    buf.append(nxt)
                with self._idle:
                    self._buffered = len(buf)
                    self._idle.notify_all()
            # dispatch when the queue went quiet, the batch is full, or the
            # flush interval has elapsed (steady logging keeps `rec` non-None,
            # so without the time check points would only go out every 500)
            if buf and (
                rec is None
                or len(buf) >= 500
                or time.monotonic() - last_dispatch >= self.flush_interval
            ):
                with self._idle:
                    self._inflight += 1
                try:
                    self._dispatch(buf)
                finally:
                    with self._idle:
                        self._inflight -= 1
                        self._buffered = 0
                        self._idle.notify_all()
                    buf = []
                    last_dispatch = time.monotonic()

    def _dispatch(self, buf: list[dict]) -> None:
        """Send a batch of records in order. Any failure offs the remaining
        ones (inclusive) to the offline file."""
        if self.offline:
            for rec in buf:
                self._log_offline(rec)
            return
        i = 0
        try:
            while i < len(buf):
                rec = buf[i]
                if rec["op"] == "log":
                    # consecutive logs for the same run -> one bulk request
                    rid = rec["run"]
                    pts = []
                    j = i
                    while j < len(buf) and buf[j]["op"] == "log" and buf[j]["run"] == rid:
                        pts.append(buf[j]["payload"])
                        j += 1
                    self._send_bulk(rid, pts)
                    i = j
                elif rec["op"] in ("finish", "resume"):
                    resp = self._post(
                        f"/api/runs/{rec['run']}/{rec['op']}", rec.get("payload") or {}
                    )
                    if resp.status_code >= 400:
                        raise TrainUIError(f"{resp.status_code}: {resp.text}")
                    i += 1
                else:
                    # start_run/init records only appear when offline; if we
                    # are online they were queued after a failure -- keep them
                    # safe by moving to the offline file rather than replaying
                    raise TrainUIError(f"cannot replay op {rec['op']} while online")
        except Exception as e:
            self._go_offline()
            for rec in buf[i:]:
                self._log_offline(rec)
            print(
                f"trainui: upload failed ({e!r}); remaining metrics are being "
                f"logged offline to {self._offline_path}",
                file=sys.stderr,
            )

    def _send_bulk(self, run_id, points: list[dict]) -> None:
        resp = self._post(f"/api/runs/{run_id}/log_bulk", {"points": points})
        if resp.status_code == 409:
            # server already has some of these (e.g. retry after timeout):
            # drop what it has and retry once
            detail = resp.json().get("detail", {})
            expected = detail.get("expected_seq", 0)
            points = [p for p in points if p["seq"] >= expected]
            if not points:
                return
            resp = self._post(f"/api/runs/{run_id}/log_bulk", {"points": points})
        if resp.status_code >= 400:
            raise TrainUIError(f"{resp.status_code}: {resp.text}")

    def _post(self, path: str, payload: dict) -> requests.Response:
        headers = {}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        try:
            return requests.post(
                self.base_url + path, json=payload, headers=headers,
                timeout=self.timeout,
            )
        except (requests.ConnectionError, requests.Timeout) as e:
            raise TrainUIError(
                f"trainui server at {self.base_url} unreachable or too slow: {e}"
            ) from e
