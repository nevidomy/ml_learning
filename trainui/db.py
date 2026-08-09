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
    pinned INTEGER NOT NULL DEFAULT 0
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
        point_cols = {r[1] for r in conn.execute("PRAGMA table_info(metric_points)")}
        if "context_size" not in point_cols:
            conn.execute("ALTER TABLE metric_points ADD COLUMN context_size INTEGER")

    # ----- models -----

    def upsert_model(
        self,
        model_id: str,
        description: str,
        param_count: int | None = None,
        context_width: int | None = None,
    ) -> dict:
        now = time.time()
        with self._write_lock, self._conn() as conn:
            conn.execute(
                """INSERT INTO models (id, description, param_count, context_width,
                                       created_at, last_used_at)
                   VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET
                       description=excluded.description,
                       last_used_at=excluded.last_used_at,
                       param_count=COALESCE(excluded.param_count, models.param_count),
                       context_width=COALESCE(excluded.context_width, models.context_width)""",
                (model_id, description, param_count, context_width, now, now),
            )
        return self.get_model(model_id)

    def get_model(self, model_id: str) -> dict:
        row = self._conn().execute(
            "SELECT * FROM models WHERE id=?", (model_id,)
        ).fetchone()
        if row is None:
            raise NotFound(f"model {model_id!r} not found")
        return dict(row)

    def list_models(self, q: str = "", limit: int = 200) -> list[dict]:
        like = f"%{q}%"
        rows = self._conn().execute(
            """SELECT m.*, (SELECT COUNT(*) FROM runs r WHERE r.model_id = m.id) AS run_count
               FROM models m
               WHERE (? = '' OR m.id LIKE ? OR m.description LIKE ?)
               ORDER BY m.pinned DESC, m.last_used_at DESC
               LIMIT ?""",
            (q, like, like, limit),
        ).fetchall()
        return [dict(r) for r in rows]

    def set_model_pinned(self, model_id: str, pinned: bool) -> dict:
        with self._write_lock, self._conn() as conn:
            cur = conn.execute(
                "UPDATE models SET pinned=? WHERE id=?", (int(pinned), model_id)
            )
            if cur.rowcount == 0:
                raise NotFound(f"model {model_id!r} not found")
        return self.get_model(model_id)

    def _touch_model(self, conn: sqlite3.Connection, model_id: str) -> None:
        conn.execute(
            "UPDATE models SET last_used_at=? WHERE id=?", (time.time(), model_id)
        )

    # ----- runs -----

    def create_run(self, model_id: str) -> dict:
        now = time.time()
        with self._write_lock, self._conn() as conn:
            row = conn.execute("SELECT id FROM models WHERE id=?", (model_id,)).fetchone()
            if row is None:
                raise NotFound(f"model {model_id!r} not found")
            cur = conn.execute(
                "INSERT INTO runs (model_id, started_at, last_activity_at) VALUES (?, ?, ?)",
                (model_id, now, now),
            )
            self._touch_model(conn, model_id)
            run_id = cur.lastrowid
        return self.get_run(run_id)

    def get_run(self, run_id: int) -> dict:
        row = self._conn().execute(
            "SELECT * FROM runs WHERE id=?", (run_id,)
        ).fetchone()
        if row is None:
            raise NotFound(f"run {run_id} not found")
        return dict(row)

    def list_runs(
        self,
        model_id: str | None = None,
        q: str = "",
        date_from: float | None = None,
        date_to: float | None = None,
        limit: int = 200,
    ) -> list[dict]:
        clauses, params = [], []
        if model_id is not None:
            clauses.append("r.model_id = ?")
            params.append(model_id)
        if q:
            clauses.append("(CAST(r.id AS TEXT) LIKE ? OR r.model_id LIKE ?)")
            params += [f"%{q}%", f"%{q}%"]
        if date_from is not None:
            clauses.append("r.started_at >= ?")
            params.append(date_from)
        if date_to is not None:
            clauses.append("r.started_at <= ?")
            params.append(date_to)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        rows = self._conn().execute(
            f"""SELECT r.*, (SELECT COUNT(*) FROM metric_points p WHERE p.run_id = r.id) AS point_count
                FROM runs r {where}
                ORDER BY r.pinned DESC, r.started_at DESC
                LIMIT ?""",
            (*params, limit),
        ).fetchall()
        return [dict(r) for r in rows]

    def set_run_pinned(self, run_id: int, pinned: bool) -> dict:
        with self._write_lock, self._conn() as conn:
            cur = conn.execute(
                "UPDATE runs SET pinned=? WHERE id=?", (int(pinned), run_id)
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
    ) -> dict:
        now = time.time()
        clean = {k: float(v) for k, v in metrics.items()}
        with self._write_lock, self._conn() as conn:
            run = conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
            if run is None:
                raise NotFound(f"run {run_id} not found")
            if run["status"] == "completed" or seq != run["expected_seq"]:
                raise SequenceConflict(run_id, run["expected_seq"], seq)
            conn.execute(
                "INSERT INTO metric_points (run_id, seq, ts, iteration, batches,"
                " context_size, metrics) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (run_id, seq, now, iteration, batches, context_size, json.dumps(clean)),
            )
            conn.execute(
                "UPDATE runs SET expected_seq=?, last_activity_at=?, status='running' WHERE id=?",
                (seq + 1, now, run_id),
            )
            self._touch_model(conn, run["model_id"])
        return {"ok": True, "next_seq": seq + 1, "ts": now}

    def resume_run(self, run_id: int, next_seq: int | None = None) -> dict:
        """Close a pause gap and set the sequence the next log call must use."""
        now = time.time()
        with self._write_lock, self._conn() as conn:
            run = conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
            if run is None:
                raise NotFound(f"run {run_id} not found")
            seq = next_seq if next_seq is not None else run["expected_seq"]
            if seq < 1:
                raise ValueError("next_seq must be >= 1")
            if run["last_activity_at"] < now:
                conn.execute(
                    "INSERT INTO pauses (run_id, start_ts, end_ts) VALUES (?, ?, ?)",
                    (run_id, run["last_activity_at"], now),
                )
            conn.execute(
                "UPDATE runs SET expected_seq=?, last_activity_at=?, status='running' WHERE id=?",
                (seq, now, run_id),
            )
            self._touch_model(conn, run["model_id"])
        return {"ok": True, "next_seq": seq, "resumed_at": now}

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
        model = self.get_model(run["model_id"])
        run["model_param_count"] = model.get("param_count")
        run["model_context_width"] = model.get("context_width")
        return run

    def run_metrics(self, run_id: int, keys: set[str] | None = None) -> dict:
        """Return points (optionally filtered to `keys`) plus the last value of
        every metric key, so the UI can show current values for charts whose
        series it chose not to fetch."""
        self.get_run(run_id)
        rows = self._conn().execute(
            "SELECT seq, ts, iteration, batches, context_size, metrics FROM metric_points"
            " WHERE run_id=? ORDER BY seq",
            (run_id,),
        ).fetchall()
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
        return {"points": points, "last": last}

    def overview(self, recent_models: int = 6, recent_runs: int = 6) -> dict:
        models = self.list_models(limit=recent_models)
        runs = self.list_runs(limit=recent_runs)
        return {"models": models, "runs": runs}
