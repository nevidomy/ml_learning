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
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
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
        payload = {
            "seq": self._seq,
            "iteration": iteration,
            "batches": batches,
            "context_size": context_size,
            "metrics": metrics,
        }
        if self.tracker.offline:
            # server already known to be down: just append to the local log
            self.tracker._log_offline(
                {"op": "log", "run": self.id,
                 "payload": {**payload, "ts": time.time()}}
            )
            self._seq += 1
            return
        # Retry transient network failures. A timed-out request may still have
        # been applied server-side; the 409 dedup below detects that case.
        resp = None
        retried = False
        for attempt in range(3):
            try:
                resp = self.tracker._post(f"/api/runs/{self.id}/log", payload)
                break
            except TrainUIError:
                retried = True
                if attempt == 2:
                    # server unreachable: switch to offline logging instead of
                    # killing the training run; upload later with the CLI
                    self.tracker._go_offline()
                    self.tracker._log_offline(
                        {"op": "log", "run": self.id,
                         "payload": {**payload, "ts": time.time()}}
                    )
                    self._seq += 1
                    return
                time.sleep(0.5 * (attempt + 1))
        if resp.status_code == 409:
            detail = resp.json().get("detail", {})
            expected = detail.get("expected_seq", -1)
            if retried and expected == self._seq + 1:
                # an earlier timed-out attempt was applied; adopt its result
                self._seq = expected
                return
            raise SequenceError(
                run_id=self.id,
                expected_seq=expected,
                received_seq=self._seq,
                message=detail.get("message", "sequence conflict"),
            )
        self._check(resp)
        self._seq = resp.json()["next_seq"]

    def resume(self, next_seq: Optional[int] = None) -> None:
        """Mark the elapsed time since the last log as a pause and continue.

        The next `log` call will use the server's expected sequence (or
        `next_seq` if given). Pause gaps are excluded from graph time axes.
        """
        if self.tracker.disabled:
            self._finished = False
            return
        if self.tracker.offline:
            self.tracker._log_offline(
                {"op": "resume", "run": self.id,
                 "payload": {"next_seq": self._seq, "end_ts": time.time()}}
            )
            self._finished = False
            return
        try:
            resp = self.tracker._post(
                f"/api/runs/{self.id}/resume", {"next_seq": next_seq}
            )
        except TrainUIError:
            self.tracker._go_offline()
            self.tracker._log_offline(
                {"op": "resume", "run": self.id,
                 "payload": {"next_seq": self._seq, "end_ts": time.time()}}
            )
            self._finished = False
            return
        self._check(resp)
        self._seq = resp.json()["next_seq"]
        self._finished = False

    def finish(self) -> None:
        if self.tracker.disabled:
            pass
        elif self.tracker.offline:
            self.tracker._log_offline({"op": "finish", "run": self.id})
        else:
            try:
                resp = self.tracker._post(f"/api/runs/{self.id}/finish", {})
            except TrainUIError:
                self.tracker._go_offline()
                self.tracker._log_offline({"op": "finish", "run": self.id})
                self._finished = True
                return
            self._check(resp)
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

        If the server is unreachable, the tracker automatically switches to
        offline mode: every request is appended to a `trainui-offline-*.jsonl`
        file in the working directory instead, so training is never killed by
        metric collection. Upload later with `python -m trainui.upload <file>`.
        """
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
        try:
            resp = self._post("/api/init", payload)
        except TrainUIError:
            self._go_offline()
            self._log_offline({"op": "init", "payload": payload})
            return
        Run._check(resp)

    def start_run(self, description: str = "") -> Run:
        """Start a new run; `description` is an optional note shown in the UI."""
        if self.disabled:
            return Run(self, 0)
        payload = {"model_id": self.model_id, "description": description}
        if self.offline:
            return self._start_offline_run(payload)
        try:
            resp = self._post("/api/runs", payload)
        except TrainUIError:
            self._go_offline()
            return self._start_offline_run({**payload, "started_at": time.time()})
        Run._check(resp)
        return Run(self, resp.json()["id"])

    def _start_offline_run(self, payload: dict) -> Run:
        ref = f"local-{self._local_run_counter}"
        self._local_run_counter += 1
        payload.setdefault("started_at", time.time())
        self._log_offline({"op": "start_run", "local_run": ref, "payload": payload})
        return Run(self, ref)

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
        self._offline_file.write(json.dumps(record) + "\n")
        self._offline_file.flush()

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
