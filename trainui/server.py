"""trainui HTTP server: metric ingestion API + static web UI.

Run with:  python -m trainui.server [--host 127.0.0.1] [--port 8501]
"""
from __future__ import annotations

import argparse
import os
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import auth as _auth
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
    runner: str = ""  # optional "who is running this" label
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


class SignupRequest(BaseModel):
    email: str


class SetPasswordRequest(BaseModel):
    password: str
    password2: str


class LoginRequest(BaseModel):
    email: str
    password: str


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


# ----- auth (invite-only email/password; enabled by --global / TRAINUI_AUTH=1) -----

@app.get("/api/config")
def public_config():
    return auth_config()


@app.post("/api/auth/signup")
def signup(req: SignupRequest):
    """Request an invite. Allowlist-gated; deliberately non-enumerating --
    unknown emails get the same response as known ones, minus the email."""
    email = req.email.strip().lower()
    base = request_base()
    if email in _auth.ALLOWED_EMAILS and not db.user(email):
        token = _auth.create_invite(db, email)
        sent = _auth.send_invite(email, f"{base}/#/setpw/{token}")
        return {"ok": True, "sent": sent}
    return {"ok": True, "sent": True}


@app.get("/api/auth/invite/{token}")
def invite_info(token: str):
    """Landing page check for the emailed link (validity + masked email)."""
    email = _auth.peek_invite(db, token)
    if not email:
        raise HTTPException(status_code=410, detail="link expired or already used")
    return {"email": email}


@app.post("/api/auth/invite/{token}")
def set_password(token: str, req: SetPasswordRequest):
    if req.password != req.password2:
        raise HTTPException(status_code=400, detail="passwords don't match")
    if len(req.password) < 8:
        raise HTTPException(status_code=400,
                            detail="password must be at least 8 characters")
    email = _auth.consume_invite(db, token)
    if not email:
        raise HTTPException(status_code=410, detail="link expired or already used")
    db.add_user(email, _auth.hash_password(req.password))
    return {"ok": True, "token": _auth.create_session(db, email)}


@app.post("/api/auth/login")
def login(req: LoginRequest):
    u = db.user(req.email.strip().lower())
    if not u or not _auth.verify_password(req.password, u["pw_hash"]):
        raise HTTPException(status_code=401, detail="invalid email or password")
    return {"ok": True, "token": _auth.create_session(db, u["email"])}


@app.post("/api/auth/logout")
def logout(request: Request):
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        _auth.drop_session(db, auth[7:].strip())
    return {"ok": True}


def request_base() -> str:
    """Public URL for emailed links -- set TRAINUI_PUBLIC_URL when running
    --global (email links built from the request host break behind proxies)."""
    return os.environ.get("TRAINUI_PUBLIC_URL", "").rstrip("/") or "http://127.0.0.1:8501"


# ----- ingestion API (used by the python client) -----


@app.post("/api/init", dependencies=[Depends(require_auth)])
def init_model(req: InitRequest):
    return db.upsert_model(
        req.model_id, req.description, req.param_count, req.context_width,
        req.metrics_decl, req.chars_per_token,
    )


@app.post("/api/runs", dependencies=[Depends(require_auth)])
def start_run(req: StartRunRequest):
    return db.create_run(req.model_id, req.description, req.started_at, req.runner)


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
def list_models(q: str = "", limit: int = 50, offset: int = 0, fav: bool = False):
    limit = max(1, min(limit, 500))
    return {
        "items": db.list_models(q=q, limit=limit, offset=max(0, offset), fav=fav),
        "total": db.count_models(q=q, fav=fav),
    }


@app.get("/api/models/{model_id}", dependencies=[Depends(require_auth)])
def get_model(model_id: str):
    return db.get_model(model_id)


@app.post("/api/models/{model_id}/pin", dependencies=[Depends(require_auth)])
def pin_model(model_id: str, req: PinRequest):
    return db.set_model_pinned(model_id, req.pinned)


@app.post("/api/models/{model_id}/favorite", dependencies=[Depends(require_auth)])
def favorite_model(model_id: str, req: PinRequest):
    return db.set_model_favorite(model_id, req.pinned)


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
    fav: bool = False,
):
    limit = max(1, min(limit, 500))
    return {
        "items": db.list_runs(
            model_id=model_id, q=q, date_from=date_from, date_to=date_to,
            limit=limit, offset=max(0, offset), fav=fav,
        ),
        "total": db.count_runs(
            model_id=model_id, q=q, date_from=date_from, date_to=date_to, fav=fav,
        ),
    }


@app.get("/api/runs/{run_id}", dependencies=[Depends(require_auth)])
def get_run(run_id: int):
    return db.run_detail(run_id)


@app.post("/api/runs/{run_id}/pin", dependencies=[Depends(require_auth)])
def pin_run(run_id: int, req: PinRequest):
    return db.set_run_pinned(run_id, req.pinned)


@app.post("/api/runs/{run_id}/favorite", dependencies=[Depends(require_auth)])
def favorite_run(run_id: int, req: PinRequest):
    return db.set_run_favorite(run_id, req.pinned)


@app.delete("/api/runs/{run_id}", dependencies=[Depends(require_auth)])
def delete_run(run_id: int):
    db.delete_run(run_id)
    return {"ok": True}


@app.get("/api/runs/{run_id}/metrics", dependencies=[Depends(require_auth)])
def run_metrics(
    run_id: int,
    keys: Optional[str] = None,
    since: Optional[int] = None,
    limit: Optional[int] = None,
):
    key_set = None if keys is None else {k for k in keys.split(",") if k}
    return db.run_metrics(run_id, key_set, since, limit)


# ----- static UI -----

class NoCacheStaticFiles(StaticFiles):
    """Revalidate-on-every-load statics: the UI is small, and stale cached
    app.js/index.html after a server update is a recurring footgun."""

    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        resp.headers["Cache-Control"] = "no-cache"
        return resp


@app.get("/")
def index():
    return FileResponse(
        os.path.join(STATIC_DIR, "index.html"),
        headers={"Cache-Control": "no-cache"},
    )


app.mount("/static", NoCacheStaticFiles(directory=STATIC_DIR), name="static")


def main():
    parser = argparse.ArgumentParser(description="trainui server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8501)
    parser.add_argument("--db", default=None, help="path to sqlite database file")
    parser.add_argument(
        "--global", dest="global_", action="store_true",
        help="listen on 0.0.0.0 and require auth (invite-only email/password; "
             "TRAINUI_ALLOWED_EMAILS controls who can sign up, "
             "TRAINUI_API_TOKEN is the shared secret for the python client, "
             "direct loopback connections stay exempt)")
    args = parser.parse_args()

    if args.global_:
        args.host = "0.0.0.0"
        os.environ["TRAINUI_AUTH"] = "1"

    global db
    if args.db:
        db = Database(args.db)

    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
