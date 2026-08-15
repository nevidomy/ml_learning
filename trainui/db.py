"""SQLite storage layer for trainui.

Concurrency model: WAL mode with one connection per thread (thread-local).
Reads run concurrently and never block writes; writes are serialized through
a single lock. This keeps training log calls fast even while the UI polls
large metric payloads.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time

DEFAULT_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "trainui.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS models (
    id TEXT PRIMARY KEY,
    description TEXT NOT NULL DEFAULT '',
    param_count INTEGER,
    context_width INTEGER,
    metrics_decl TEXT,
    chars_per_token REAL,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL,
    last_used_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id TEXT NOT NULL REFERENCES models(id),
    started_at REAL NOT NULL,
    last_activity_at REAL NOT NULL,
    expected_seq INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'running',
    pinned INTEGER NOT NULL DEFAULT 0,
    last_metrics TEXT,
    description TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_runs_model ON runs(model_id);

CREATE TABLE IF NOT EXISTS metric_points (
    run_id INTEGER NOT NULL REFERENCES runs(id),
    seq INTEGER NOT NULL,
    ts REAL NOT NULL,
    iteration INTEGER NOT NULL,
    batches INTEGER NOT NULL DEFAULT 0,
    context_size INTEGER,
    metrics TEXT NOT NULL,
    PRIMARY KEY (run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_points_run ON metric_points(run_id);

CREATE TABLE IF NOT EXISTS pauses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES runs(id),
    start_ts REAL NOT NULL,
    end_ts REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pauses_run ON pauses(run_id);

-- invite-only email/password auth (see auth.py)
CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,            -- lowercased, allowlisted at signup
    pw_hash TEXT NOT NULL,             -- pbkdf2$iters$salt$hash (never plain)
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
    token_hash TEXT PRIMARY KEY,       -- sha256 of the emailed token
    email TEXT NOT NULL,
    created_at REAL NOT NULL,
    expires_at REAL NOT NULL,
    used_at REAL                       -- single-use
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,       -- sha256 of the bearer token
    email TEXT NOT NULL,
    created_at REAL NOT NULL,
    expires_at REAL NOT NULL
);
"""


class SequenceConflict(Exception):
    def __init__(self, run_id: int, expected: int, received: int):
        self.run_id = run_id
        self.expected = expected
        self.received = received
        super().__init__(
            f"run {run_id}: expected seq {expected}, received {received}. "
            "Call resume to continue from a new sequence point."
        )


class NotFound(Exception):
    pass


class Database:
    def __init__(self, path: str | None = None):
        self.path = path or os.environ.get("TRAINUI_DB", DEFAULT_DB_PATH)
        self._write_lock = threading.Lock()
        self._local = threading.local()
        with self._write_lock, self._conn() as conn:
            conn.executescript(SCHEMA)
            self._migrate(conn)

    def _conn(self) -> sqlite3.Connection:
        """One connection per thread; WAL allows concurrent readers + 1 writer."""
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self.path, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA foreign_keys=ON")
            conn.execute("PRAGMA busy_timeout=10000")
            self._local.conn = conn
        return conn

    def _migrate(self, conn: sqlite3.Connection) -> None:
        """Add columns introduced after the initial schema to existing DBs."""
        model_cols = {r[1] for r in conn.execute("PRAGMA table_info(models)")}
        if "param_count" not in model_cols:
            conn.execute("ALTER TABLE models ADD COLUMN param_count INTEGER")
        if "context_width" not in model_cols:
            conn.execute("ALTER TABLE models ADD COLUMN context_width INTEGER")
        if "metrics_decl" not in model_cols:
            conn.execute("ALTER TABLE models ADD COLUMN metrics_decl TEXT")
        if "chars_per_token" not in model_cols:
            conn.execute("ALTER TABLE models ADD COLUMN chars_per_token REAL")
        point_cols = {r[1] for r in conn.execute("PRAGMA table_info(metric_points)")}
        if "context_size" not in point_cols:
            conn.execute("ALTER TABLE metric_points ADD COLUMN context_size INTEGER")
        run_cols = {r[1] for r in conn.execute("PRAGMA table_info(runs)")}
        if "description" not in run_cols:
            conn.execute(
                "ALTER TABLE runs ADD COLUMN description TEXT NOT NULL DEFAULT ''"
            )
        if "last_metrics" not in run_cols:
            conn.execute("ALTER TABLE runs ADD COLUMN last_metrics TEXT")
            # backfill: cumulative last value per metric key from existing points
            run_ids = [r[0] for r in conn.execute("SELECT id FROM runs").fetchall()]
            for rid in run_ids:
                acc: dict = {}
                for (mj,) in conn.execute(
                    "SELECT metrics FROM metric_points WHERE run_id=? ORDER BY seq",
                    (rid,),
                ):
                    acc.update(json.loads(mj))
                if acc:
                    conn.execute(
                        "UPDATE runs SET last_metrics=? WHERE id=?",
                        (json.dumps(acc), rid),
                    )
        if "total_tokens" not in run_cols:
            conn.execute(
                "ALTER TABLE runs ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0"
            )
            # backfill: batches * (per-point context_size, falling back to the
            # model's context_width) summed over existing points
            conn.execute(
                """UPDATE runs SET total_tokens = COALESCE((
                     SELECT SUM(p.batches * COALESCE(p.context_size, m.context_width, 0))
                     FROM metric_points p JOIN models m ON m.id = runs.model_id
                     WHERE p.run_id = runs.id), 0)"""
            )
        # favorites split from pins: existing stars become favorites and the
        # pinned flag starts fresh (pin = subtle highlight, favorite = filterable)
        if "favorite" not in model_cols:
            conn.execute(
                "ALTER TABLE models ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0"
            )
            conn.execute("UPDATE models SET favorite = pinned")
            conn.execute("UPDATE models SET pinned = 0")
        if "favorite" not in run_cols:
            conn.execute(
                "ALTER TABLE runs ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0"
            )
            conn.execute("UPDATE runs SET favorite = pinned")
            conn.execute("UPDATE runs SET pinned = 0")

    # ----- auth (users / invites / sessions) -----

    def user(self, email: str) -> dict | None:
        row = self._conn().execute(
            "SELECT email, pw_hash, created_at FROM users WHERE email=?",
            (email.lower(),),
        ).fetchone()
        return dict(row) if row else None

    def add_user(self, email: str, pw_hash: str) -> None:
        with self._write_lock, self._conn() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO users (email, pw_hash, created_at)"
                " VALUES (?,?,?)",
                (email.lower(), pw_hash, time.time()),
            )

    def token_create(self, token_hash: str, email: str, kind: str,
                     ttl: float) -> None:
        """kind: 'invite' | 'session'. Also sweeps expired tokens."""
        now = time.time()
        table = "invites" if kind == "invite" else "sessions"
        with self._write_lock, self._conn() as conn:
            conn.execute(
                f"INSERT INTO {table} (token_hash, email, created_at,"
                f" expires_at) VALUES (?,?,?,?)",
                (token_hash, email, now, now + ttl),
            )
            conn.execute(f"DELETE FROM {table} WHERE expires_at<?", (now,))

    def token_peek(self, token_hash: str, kind: str) -> str | None:
        """-> email if the token is valid/unused/unexpired (no consume)."""
        now = time.time()
        if kind == "invite":
            row = self._conn().execute(
                "SELECT email FROM invites WHERE token_hash=?"
                " AND used_at IS NULL AND expires_at>=?",
                (token_hash, now),
            ).fetchone()
        else:
            row = self._conn().execute(
                "SELECT email FROM sessions WHERE token_hash=? AND expires_at>=?",
                (token_hash, now),
            ).fetchone()
        return row["email"] if row else None

    def invite_consume(self, token_hash: str) -> str | None:
        email = self.token_peek(token_hash, "invite")
        if email is None:
            return None
        with self._write_lock, self._conn() as conn:
            conn.execute(
                "UPDATE invites SET used_at=? WHERE token_hash=?",
                (time.time(), token_hash),
            )
        return email

    def session_drop(self, token_hash: str) -> None:
        with self._write_lock, self._conn() as conn:
            conn.execute("DELETE FROM sessions WHERE token_hash=?",
                         (token_hash,))

    # ----- models -----

    def upsert_model(
        self,
        model_id: str,
        description: str,
        param_count: int | None = None,
        context_width: int | None = None,
        metrics_decl: list[str] | None = None,
        chars_per_token: float | None = None,
    ) -> dict:
        now = time.time()
        decl_json = json.dumps(metrics_decl) if metrics_decl is not None else None
        with self._write_lock, self._conn() as conn:
            conn.execute(
                """INSERT INTO models (id, description, param_count, context_width,
                                       metrics_decl, chars_per_token,
                                       created_at, last_used_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET
                       description=excluded.description,
                       last_used_at=excluded.last_used_at,
                       param_count=COALESCE(excluded.param_count, models.param_count),
                       context_width=COALESCE(excluded.context_width, models.context_width),
                       metrics_decl=COALESCE(excluded.metrics_decl, models.metrics_decl),
                       chars_per_token=COALESCE(excluded.chars_per_token, models.chars_per_token)""",
                (model_id, description, param_count, context_width, decl_json,
                 chars_per_token, now, now),
            )
        return self.get_model(model_id)

    def get_model(self, model_id: str) -> dict:
        row = self._conn().execute(
            "SELECT * FROM models WHERE id=?", (model_id,)
        ).fetchone()
        if row is None:
            raise NotFound(f"model {model_id!r} not found")
        return dict(row)

    def list_models(
        self, q: str = "", limit: int = 200, offset: int = 0, fav: bool = False
    ) -> list[dict]:
        like = f"%{q}%"
        rows = self._conn().execute(
            """SELECT m.*, (SELECT COUNT(*) FROM runs r WHERE r.model_id = m.id) AS run_count
               FROM models m
               WHERE (? = '' OR m.id LIKE ? OR m.description LIKE ?)
                 AND (? = 0 OR m.favorite = 1)
               ORDER BY m.last_used_at DESC
               LIMIT ? OFFSET ?""",
            (q, like, like, 1 if fav else 0, limit, offset),
        ).fetchall()
        return [dict(r) for r in rows]

    def count_models(self, q: str = "", fav: bool = False) -> int:
        like = f"%{q}%"
        return self._conn().execute(
            "SELECT COUNT(*) FROM models m"
            " WHERE (? = '' OR m.id LIKE ? OR m.description LIKE ?)"
            " AND (? = 0 OR m.favorite = 1)",
            (q, like, like, 1 if fav else 0),
        ).fetchone()[0]

    def set_model_pinned(self, model_id: str, pinned: bool) -> dict:
        with self._write_lock, self._conn() as conn:
            cur = conn.execute(
                "UPDATE models SET pinned=? WHERE id=?", (int(pinned), model_id)
            )
            if cur.rowcount == 0:
                raise NotFound(f"model {model_id!r} not found")
        return self.get_model(model_id)

    def set_model_favorite(self, model_id: str, favorite: bool) -> dict:
        with self._write_lock, self._conn() as conn:
            cur = conn.execute(
                "UPDATE models SET favorite=? WHERE id=?", (int(favorite), model_id)
            )
            if cur.rowcount == 0:
                raise NotFound(f"model {model_id!r} not found")
        return self.get_model(model_id)

    def _touch_model(self, conn: sqlite3.Connection, model_id: str) -> None:
        conn.execute(
            "UPDATE models SET last_used_at=? WHERE id=?", (time.time(), model_id)
        )

    # ----- runs -----

    def create_run(
        self, model_id: str, description: str = "", started_at: float | None = None
    ) -> dict:
        now = time.time()
        started = started_at or now
        with self._write_lock, self._conn() as conn:
            row = conn.execute("SELECT id FROM models WHERE id=?", (model_id,)).fetchone()
            if row is None:
                raise NotFound(f"model {model_id!r} not found")
            cur = conn.execute(
                "INSERT INTO runs (model_id, started_at, last_activity_at, description)"
                " VALUES (?, ?, ?, ?)",
                (model_id, started, started, description),
            )
            self._touch_model(conn, model_id)
            run_id = cur.lastrowid
        return self.get_run(run_id)

    def get_run(self, run_id: int) -> dict:
        conn = self._conn()
        row = conn.execute(
            "SELECT * FROM runs WHERE id=?", (run_id,)
        ).fetchone()
        if row is None:
            raise NotFound(f"run {run_id} not found")
        d = dict(row)
        d["train_time"] = self._train_time(conn, d)
        return d

    @staticmethod
    def _train_time(conn, run: dict) -> float:
        """Active training time: point span minus recorded pauses."""
        paused = conn.execute(
            "SELECT COALESCE(SUM(end_ts - start_ts), 0) FROM pauses WHERE run_id=?",
            (run["id"],),
        ).fetchone()[0]
        return max(0.0, run["last_activity_at"] - run["started_at"] - paused)

    @staticmethod
    def _run_clauses(
        model_id: str | None,
        q: str,
        date_from: float | None,
        date_to: float | None,
        fav: bool = False,
    ) -> tuple[str, list]:
        clauses, params = [], []
        if model_id is not None:
            clauses.append("r.model_id = ?")
            params.append(model_id)
        if fav:
            clauses.append("r.favorite = 1")
        if q:
            clauses.append("(CAST(r.id AS TEXT) LIKE ? OR r.model_id LIKE ?)")
            params += [f"%{q}%", f"%{q}%"]
        if date_from is not None:
            clauses.append("r.started_at >= ?")
            params.append(date_from)
        if date_to is not None:
            clauses.append("r.started_at <= ?")
            params.append(date_to)
        return ("WHERE " + " AND ".join(clauses)) if clauses else "", params

    def list_runs(
        self,
        model_id: str | None = None,
        q: str = "",
        date_from: float | None = None,
        date_to: float | None = None,
        limit: int = 200,
        offset: int = 0,
        fav: bool = False,
    ) -> list[dict]:
        where, params = self._run_clauses(model_id, q, date_from, date_to, fav)
        rows = self._conn().execute(
            f"""SELECT r.*, m.param_count AS model_param_count,
                       m.chars_per_token AS model_chars_per_token,
                       (SELECT COUNT(*) FROM metric_points p WHERE p.run_id = r.id) AS point_count,
                       (r.last_activity_at - r.started_at - COALESCE((
                           SELECT SUM(end_ts - start_ts) FROM pauses p2
                           WHERE p2.run_id = r.id), 0)) AS train_time
                FROM runs r JOIN models m ON m.id = r.model_id {where}
                ORDER BY r.started_at DESC
                LIMIT ? OFFSET ?""",
            (*params, limit, offset),
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["last_metrics"] = json.loads(d["last_metrics"]) if d["last_metrics"] else {}
            out.append(d)
        return out

    def count_runs(
        self,
        model_id: str | None = None,
        q: str = "",
        date_from: float | None = None,
        date_to: float | None = None,
        fav: bool = False,
    ) -> int:
        where, params = self._run_clauses(model_id, q, date_from, date_to, fav)
        return self._conn().execute(
            f"SELECT COUNT(*) FROM runs r {where}", params
        ).fetchone()[0]

    def set_run_pinned(self, run_id: int, pinned: bool) -> dict:
        with self._write_lock, self._conn() as conn:
            cur = conn.execute(
                "UPDATE runs SET pinned=? WHERE id=?", (int(pinned), run_id)
            )
            if cur.rowcount == 0:
                raise NotFound(f"run {run_id} not found")
        return self.get_run(run_id)

    def set_run_favorite(self, run_id: int, favorite: bool) -> dict:
        with self._write_lock, self._conn() as conn:
            cur = conn.execute(
                "UPDATE runs SET favorite=? WHERE id=?", (int(favorite), run_id)
            )
            if cur.rowcount == 0:
                raise NotFound(f"run {run_id} not found")
        return self.get_run(run_id)

    def delete_model(self, model_id: str) -> None:
        with self._write_lock, self._conn() as conn:
            run_ids = [
                r[0]
                for r in conn.execute(
                    "SELECT id FROM runs WHERE model_id=?", (model_id,)
                ).fetchall()
            ]
            for rid in run_ids:
                conn.execute("DELETE FROM metric_points WHERE run_id=?", (rid,))
                conn.execute("DELETE FROM pauses WHERE run_id=?", (rid,))
            conn.execute("DELETE FROM runs WHERE model_id=?", (model_id,))
            cur = conn.execute("DELETE FROM models WHERE id=?", (model_id,))
            if cur.rowcount == 0:
                raise NotFound(f"model {model_id!r} not found")

    def delete_run(self, run_id: int) -> None:
        with self._write_lock, self._conn() as conn:
            conn.execute("DELETE FROM metric_points WHERE run_id=?", (run_id,))
            conn.execute("DELETE FROM pauses WHERE run_id=?", (run_id,))
            cur = conn.execute("DELETE FROM runs WHERE id=?", (run_id,))
            if cur.rowcount == 0:
                raise NotFound(f"run {run_id} not found")

    # ----- logging -----

    def log_point(
        self,
        run_id: int,
        seq: int,
        iteration: int,
        batches: int,
        metrics: dict,
        context_size: int | None = None,
        ts: float | None = None,
    ) -> dict:
        now = time.time()
        ts = ts or now
        clean = {k: float(v) for k, v in metrics.items()}
        with self._write_lock, self._conn() as conn:
            run = conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
            if run is None:
                raise NotFound(f"run {run_id} not found")
            if run["status"] == "completed" or seq != run["expected_seq"]:
                raise SequenceConflict(run_id, run["expected_seq"], seq)
            tokens = batches * self._effective_ctx(conn, run["model_id"], context_size)
            conn.execute(
                "INSERT INTO metric_points (run_id, seq, ts, iteration, batches,"
                " context_size, metrics) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (run_id, seq, ts, iteration, batches, context_size, json.dumps(clean)),
            )
            last = json.loads(run["last_metrics"]) if run["last_metrics"] else {}
            last.update(clean)
            conn.execute(
                "UPDATE runs SET expected_seq=?, last_activity_at=?, status='running',"
                " last_metrics=?, total_tokens=total_tokens+? WHERE id=?",
                (seq + 1, ts, json.dumps(last), tokens, run_id),
            )
            self._touch_model(conn, run["model_id"])
        return {"ok": True, "next_seq": seq + 1, "ts": ts}

    @staticmethod
    def _effective_ctx(conn, model_id: str, context_size: int | None) -> int:
        if context_size:
            return context_size
        row = conn.execute(
            "SELECT context_width FROM models WHERE id=?", (model_id,)
        ).fetchone()
        return int(row[0]) if row and row[0] else 0

    def log_bulk(self, run_id: int, points: list[dict]) -> dict:
        """Insert many points atomically (used by the offline-log uploader).

        Points with seq below the server's expected sequence are skipped
        (idempotent re-upload); a seq above it raises SequenceConflict.
        """
        now = time.time()
        with self._write_lock, self._conn() as conn:
            run = conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
            if run is None:
                raise NotFound(f"run {run_id} not found")
            if run["status"] == "completed":
                raise SequenceConflict(run_id, run["expected_seq"], -1)
            expected = run["expected_seq"]
            last = json.loads(run["last_metrics"]) if run["last_metrics"] else {}
            applied = skipped = 0
            total_tokens = 0
            last_ts = run["last_activity_at"]
            for p in points:
                seq = int(p["seq"])
                if seq < expected:
                    skipped += 1
                    continue
                if seq > expected:
                    raise SequenceConflict(run_id, expected, seq)
                clean = {k: float(v) for k, v in (p.get("metrics") or {}).items()}
                ts = p.get("ts") or now
                batches = int(p.get("batches") or 0)
                total_tokens += batches * self._effective_ctx(
                    conn, run["model_id"], p.get("context_size")
                )
                conn.execute(
                    "INSERT INTO metric_points (run_id, seq, ts, iteration, batches,"
                    " context_size, metrics) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (run_id, seq, ts, int(p["iteration"]), batches,
                     p.get("context_size"), json.dumps(clean)),
                )
                last.update(clean)
                last_ts = max(last_ts, ts)
                expected = seq + 1
                applied += 1
            if applied:
                conn.execute(
                    "UPDATE runs SET expected_seq=?, last_activity_at=?, status='running',"
                    " last_metrics=?, total_tokens=total_tokens+? WHERE id=?",
                    (expected, last_ts, json.dumps(last), total_tokens, run_id),
                )
                self._touch_model(conn, run["model_id"])
        return {"ok": True, "applied": applied, "skipped": skipped, "next_seq": expected}

    def resume_run(
        self,
        run_id: int,
        next_seq: int | None = None,
        end_ts: float | None = None,
    ) -> dict:
        """Close a pause gap and set the sequence the next log call must use."""
        now = time.time()
        end = end_ts or now
        with self._write_lock, self._conn() as conn:
            run = conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
            if run is None:
                raise NotFound(f"run {run_id} not found")
            seq = next_seq if next_seq is not None else run["expected_seq"]
            if seq < 1:
                raise ValueError("next_seq must be >= 1")
            if run["last_activity_at"] < end:
                conn.execute(
                    "INSERT INTO pauses (run_id, start_ts, end_ts) VALUES (?, ?, ?)",
                    (run_id, run["last_activity_at"], end),
                )
            conn.execute(
                "UPDATE runs SET expected_seq=?, last_activity_at=?, status='running' WHERE id=?",
                (seq, end, run_id),
            )
            self._touch_model(conn, run["model_id"])
        return {"ok": True, "next_seq": seq, "resumed_at": end}

    def finish_run(self, run_id: int) -> dict:
        with self._write_lock, self._conn() as conn:
            cur = conn.execute(
                "UPDATE runs SET status='completed', last_activity_at=? WHERE id=?",
                (time.time(), run_id),
            )
            if cur.rowcount == 0:
                raise NotFound(f"run {run_id} not found")
        return self.get_run(run_id)

    # ----- queries for UI -----

    def run_detail(self, run_id: int) -> dict:
        run = self.get_run(run_id)
        pauses = [
            dict(r)
            for r in self._conn()
            .execute(
                "SELECT start_ts, end_ts FROM pauses WHERE run_id=? ORDER BY start_ts",
                (run_id,),
            )
            .fetchall()
        ]
        run["pauses"] = pauses
        run["last_metrics"] = (
            json.loads(run["last_metrics"]) if run.get("last_metrics") else {}
        )
        model = self.get_model(run["model_id"])
        run["model_param_count"] = model.get("param_count")
        run["model_context_width"] = model.get("context_width")
        run["model_chars_per_token"] = model.get("chars_per_token")
        try:
            run["model_metrics_decl"] = json.loads(model.get("metrics_decl") or "[]")
        except ValueError:
            run["model_metrics_decl"] = []
        return run

    def run_metrics(
        self,
        run_id: int,
        keys: set[str] | None = None,
        since: int | None = None,
        limit: int | None = None,
    ) -> dict:
        """Return points (optionally filtered to `keys`) plus the last value of
        every metric key, so the UI can show current values for charts whose
        series it chose not to fetch. With `since`, only points with seq > since
        are returned (incremental refresh); `last` then comes from the cached
        runs.last_metrics instead of being recomputed over all rows."""
        run = self.get_run(run_id)
        sql = (
            "SELECT seq, ts, iteration, batches, context_size, metrics FROM metric_points"
            " WHERE run_id=?"
        )
        params: list = [run_id]
        if since is not None:
            sql += " AND seq>?"
            params.append(since)
        sql += " ORDER BY seq"
        if limit is not None:
            sql += " LIMIT ?"
            params.append(limit)
        rows = self._conn().execute(sql, params).fetchall()
        points = []
        last: dict[str, float] = {}
        for r in rows:
            metrics = json.loads(r["metrics"])
            last.update(metrics)
            if keys is not None:
                metrics = {k: v for k, v in metrics.items() if k in keys}
            points.append(
                {
                    "seq": r["seq"],
                    "ts": r["ts"],
                    "iteration": r["iteration"],
                    "batches": r["batches"],
                    "context_size": r["context_size"],
                    "metrics": metrics,
                }
            )
        if since is not None or limit is not None:
            # partial result set: serve the cached full last-values map
            raw = run.get("last_metrics")
            last = json.loads(raw) if raw else {}
        return {"points": points, "last": last}

    def overview(self, recent_models: int = 6, recent_runs: int = 6) -> dict:
        models = self.list_models(limit=recent_models)
        runs = self.list_runs(limit=recent_runs)
        return {"models": models, "runs": runs}
