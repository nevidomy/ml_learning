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

import os
import time
from typing import Optional

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
    def __init__(self, tracker: "Tracker", run_id: int):
        self.tracker = tracker
        self.id = run_id
        self._seq = 1
        self._finished = False

    def log(
        self,
        iteration: int,
        batches: int = 0,
        context_size: Optional[int] = None,
        **metrics: float,
    ) -> None:
        """Log one training point. Metric keys may vary between calls.

        `context_size` is the per-batch sequence length; together with
        `batches` it lets the UI compute tokens/sec. If omitted, the model's
        `context_width` (set on the Tracker) is used as the default.
        """
        if self._finished:
            raise TrainUIError(f"run {self.id} is finished")
        payload = {
            "seq": self._seq,
            "iteration": iteration,
            "batches": batches,
            "context_size": context_size,
            "metrics": metrics,
        }
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
                    raise
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
        resp = self.tracker._post(
            f"/api/runs/{self.id}/resume", {"next_seq": next_seq}
        )
        self._check(resp)
        self._seq = resp.json()["next_seq"]
        self._finished = False

    def finish(self) -> None:
        resp = self.tracker._post(f"/api/runs/{self.id}/finish", {})
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
    ):
        self.base_url = (
            base_url or os.environ.get("TRAINUI_URL") or DEFAULT_URL
        ).rstrip("/")
        self.model_id = model_id
        self.timeout = timeout
        payload = {"model_id": model_id, "description": description}
        if param_count is not None:
            payload["param_count"] = param_count
        if context_width is not None:
            payload["context_width"] = context_width
        resp = self._post("/api/init", payload)
        Run._check(resp)

    def start_run(self) -> Run:
        resp = self._post("/api/runs", {"model_id": self.model_id})
        Run._check(resp)
        return Run(self, resp.json()["id"])

    def _post(self, path: str, payload: dict) -> requests.Response:
        try:
            return requests.post(
                self.base_url + path, json=payload, timeout=self.timeout
            )
        except (requests.ConnectionError, requests.Timeout) as e:
            raise TrainUIError(
                f"trainui server at {self.base_url} unreachable or too slow: {e}"
            ) from e
