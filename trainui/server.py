"""trainui HTTP server: metric ingestion API + static web UI.

Run with:  python -m trainui.server [--host 127.0.0.1] [--port 8501]
"""
from __future__ import annotations

import argparse
import os
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .auth import config as auth_config
from .auth import require_auth
from .db import Database, NotFound, SequenceConflict

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

app = FastAPI(title="trainui")
db = Database()


class InitRequest(BaseModel):
    model_id: str
    description: str = ""
    param_count: Optional[int] = None
    context_width: Optional[int] = None
    metrics_decl: Optional[list[str]] = None
    chars_per_token: Optional[float] = None


class StartRunRequest(BaseModel):
    model_id: str
    description: str = ""
    started_at: Optional[float] = None  # set by the offline-log uploader


class LogRequest(BaseModel):
    seq: int
    iteration: int
    batches: int = 0
    context_size: Optional[int] = None
    metrics: dict[str, float] = {}
    ts: Optional[float] = None  # original timestamp (offline replay)


class BulkLogRequest(BaseModel):
    points: list[LogRequest]


class ResumeRequest(BaseModel):
    next_seq: Optional[int] = None
    end_ts: Optional[float] = None  # pause end (offline replay)


class PinRequest(BaseModel):
    pinned: bool


@app.exception_handler(NotFound)
def _not_found(_, exc: NotFound):
    return JSONResponse(status_code=404, content={"detail": str(exc)})


@app.exception_handler(SequenceConflict)
def _seq_conflict(_, exc: SequenceConflict):
    return JSONResponse(
        status_code=409,
        content={
            "detail": {
                "error": "sequence_conflict",
                "message": str(exc),
                "run_id": exc.run_id,
                "expected_seq": exc.expected,
                "received_seq": exc.received,
            }
        },
    )


# ----- ingestion API (used by the python client) -----

@app.get("/api/config")
def public_config():
    return auth_config()


@app.post("/api/init", dependencies=[Depends(require_auth)])
def init_model(req: InitRequest):
    return db.upsert_model(
        req.model_id, req.description, req.param_count, req.context_width,
        req.metrics_decl, req.chars_per_token,
    )


@app.post("/api/runs", dependencies=[Depends(require_auth)])
def start_run(req: StartRunRequest):
    return db.create_run(req.model_id, req.description, req.started_at)


@app.post("/api/runs/{run_id}/log", dependencies=[Depends(require_auth)])
def log_point(run_id: int, req: LogRequest):
    return db.log_point(
        run_id, req.seq, req.iteration, req.batches, req.metrics, req.context_size,
        req.ts,
    )


@app.post("/api/runs/{run_id}/log_bulk", dependencies=[Depends(require_auth)])
def log_bulk(run_id: int, req: BulkLogRequest):
    return db.log_bulk(run_id, [p.model_dump() for p in req.points])


@app.post("/api/runs/{run_id}/resume", dependencies=[Depends(require_auth)])
def resume_run(run_id: int, req: ResumeRequest):
    try:
        return db.resume_run(run_id, req.next_seq, req.end_ts)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/runs/{run_id}/finish", dependencies=[Depends(require_auth)])
def finish_run(run_id: int):
    return db.finish_run(run_id)


# ----- UI query API -----

@app.get("/api/overview", dependencies=[Depends(require_auth)])
def overview():
    return db.overview()


@app.get("/api/models", dependencies=[Depends(require_auth)])
def list_models(q: str = "", limit: int = 50, offset: int = 0):
    limit = max(1, min(limit, 500))
    return {
        "items": db.list_models(q=q, limit=limit, offset=max(0, offset)),
        "total": db.count_models(q=q),
    }


@app.get("/api/models/{model_id}", dependencies=[Depends(require_auth)])
def get_model(model_id: str):
    return db.get_model(model_id)


@app.post("/api/models/{model_id}/pin", dependencies=[Depends(require_auth)])
def pin_model(model_id: str, req: PinRequest):
    return db.set_model_pinned(model_id, req.pinned)


@app.delete("/api/models/{model_id}", dependencies=[Depends(require_auth)])
def delete_model(model_id: str):
    db.delete_model(model_id)
    return {"ok": True}


@app.get("/api/runs", dependencies=[Depends(require_auth)])
def list_runs(
    model_id: Optional[str] = None,
    q: str = "",
    date_from: Optional[float] = None,
    date_to: Optional[float] = None,
    limit: int = 50,
    offset: int = 0,
    unpinned: bool = False,
):
    limit = max(1, min(limit, 500))
    return {
        "items": db.list_runs(
            model_id=model_id, q=q, date_from=date_from, date_to=date_to,
            limit=limit, offset=max(0, offset), unpinned=unpinned,
        ),
        "total": db.count_runs(
            model_id=model_id, q=q, date_from=date_from, date_to=date_to,
            unpinned=unpinned,
        ),
    }


@app.get("/api/runs/{run_id}", dependencies=[Depends(require_auth)])
def get_run(run_id: int):
    return db.run_detail(run_id)


@app.post("/api/runs/{run_id}/pin", dependencies=[Depends(require_auth)])
def pin_run(run_id: int, req: PinRequest):
    return db.set_run_pinned(run_id, req.pinned)


@app.delete("/api/runs/{run_id}", dependencies=[Depends(require_auth)])
def delete_run(run_id: int):
    db.delete_run(run_id)
    return {"ok": True}


@app.get("/api/runs/{run_id}/metrics", dependencies=[Depends(require_auth)])
def run_metrics(run_id: int, keys: Optional[str] = None):
    key_set = None if keys is None else {k for k in keys.split(",") if k}
    return db.run_metrics(run_id, key_set)


# ----- static UI -----

@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def main():
    parser = argparse.ArgumentParser(description="trainui server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8501)
    parser.add_argument("--db", default=None, help="path to sqlite database file")
    args = parser.parse_args()

    global db
    if args.db:
        db = Database(args.db)

    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
