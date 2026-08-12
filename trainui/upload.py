"""Upload an offline metrics log to a trainui server.

The python client falls back to writing `trainui-offline-*.jsonl` files when
the server is unreachable. Once the server is back:

    python -m trainui.upload trainui-offline-mymodel-a1b2c3d4-....jsonl
    python -m trainui.upload file.jsonl --url http://127.0.0.1:8501 --token ...

The file is replayed in order: model inits, run creations (local run refs are
remapped to real server run ids), metric points (sent in bulk, preserving the
original timestamps), resumes, and finishes. Points already present on the
server are skipped, so re-uploading the same file is safe. On success the file
is renamed to `<file>.uploaded`.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import requests

from .client import DEFAULT_URL

CHUNK = 1000


def main() -> None:
    parser = argparse.ArgumentParser(description="Upload a trainui offline log")
    parser.add_argument("file", help="path to a trainui-offline-*.jsonl file")
    parser.add_argument("--url", default=os.environ.get("TRAINUI_URL", DEFAULT_URL))
    parser.add_argument("--token", default=os.environ.get("TRAINUI_API_TOKEN"))
    args = parser.parse_args()

    base = args.url.rstrip("/")
    headers = {"Authorization": f"Bearer {args.token}"} if args.token else {}

    def post(path: str, payload: dict) -> requests.Response:
        resp = requests.post(base + path, json=payload, headers=headers, timeout=60)
        return resp

    with open(args.file, encoding="utf-8") as f:
        lines = [json.loads(l) for l in f if l.strip()]

    id_map: dict[str, int] = {}  # "local-N" -> server run id
    pending: dict[object, list] = {}  # run ref -> buffered log points
    stats = {"applied": 0, "skipped": 0}
    failed = False

    def resolve(ref):
        return id_map.get(ref, ref)

    def flush(ref) -> None:
        nonlocal failed
        points = pending.pop(ref, [])
        rid = resolve(ref)
        for i in range(0, len(points), CHUNK):
            chunk = points[i : i + CHUNK]
            resp = post(f"/api/runs/{rid}/log_bulk", {"points": chunk})
            if resp.status_code == 409:
                # drop points the server already has and retry once
                detail = resp.json().get("detail", {})
                expected = detail.get("expected_seq", 0)
                kept = [p for p in chunk if p["seq"] >= expected]
                stats["skipped"] += len(chunk) - len(kept)
                chunk = kept
                if not chunk:
                    continue
                resp = post(f"/api/runs/{rid}/log_bulk", {"points": chunk})
            if resp.status_code >= 400:
                print(f"error uploading logs for run {rid}: {resp.status_code} {resp.text}",
                      file=sys.stderr)
                failed = True
                return
            body = resp.json()
            stats["applied"] += body.get("applied", 0)
            stats["skipped"] += body.get("skipped", 0)

    for line in lines:
        op = line.get("op")
        if op == "init":
            resp = post("/api/init", line["payload"])
            if resp.status_code >= 400:
                print(f"error on init: {resp.status_code} {resp.text}", file=sys.stderr)
                failed = True
        elif op == "start_run":
            resp = post("/api/runs", line["payload"])
            if resp.status_code >= 400:
                print(f"error creating run: {resp.status_code} {resp.text}", file=sys.stderr)
                failed = True
                continue
            id_map[line["local_run"]] = resp.json()["id"]
        elif op == "log":
            pending.setdefault(line["run"], []).append(line["payload"])
            if len(pending[line["run"]]) >= CHUNK:
                flush(line["run"])
            if failed:
                break
        elif op == "resume":
            flush(line["run"])
            if failed:
                break
            resp = post(f"/api/runs/{resolve(line['run'])}/resume", line["payload"])
            if resp.status_code >= 400:
                print(f"error on resume: {resp.status_code} {resp.text}", file=sys.stderr)
        elif op == "finish":
            flush(line["run"])
            resp = post(f"/api/runs/{resolve(line['run'])}/finish", {})
            if resp.status_code >= 400:
                print(f"error on finish: {resp.status_code} {resp.text}", file=sys.stderr)
    for ref in list(pending):
        flush(ref)

    runs_created = len(id_map)
    print(
        f"upload done: {runs_created} run(s) created, "
        f"{stats['applied']} point(s) applied, {stats['skipped']} skipped"
    )
    if failed:
        print("some requests failed; the file was NOT renamed — fix and retry",
              file=sys.stderr)
        sys.exit(1)
    os.rename(args.file, args.file + ".uploaded")
    print(f"renamed {args.file} -> {args.file}.uploaded")


if __name__ == "__main__":
    main()
