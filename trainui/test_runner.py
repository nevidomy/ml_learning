"""DB-level test for the optional run `runner` label."""
import os
import tempfile

_TMP = tempfile.mkdtemp(prefix="trainui_runner_test_")
os.environ["TRAINUI_DB"] = os.path.join(_TMP, "test.db")
os.environ.pop("TRAINUI_AUTH", None)

from trainui.db import Database  # noqa: E402

db = Database()
db.upsert_model("m", "desc")

ok = 0


def check(name, cond):
    global ok
    assert cond, name
    ok += 1
    print(f"  ok: {name}")


r = db.create_run("m", description="baseline")
check("runner defaults to empty string", r["runner"] == "")
check("omitted runner not shown as None", r.get("runner") == "")

r2 = db.create_run("m", description="exp", runner="laptop")
check("runner stored", r2["runner"] == "laptop")
check("description still stored", r2["description"] == "exp")

listed = db.list_runs()
by_id = {x["id"]: x for x in listed}
check("list includes runner", by_id[r2["id"]]["runner"] == "laptop")
check("list empty runner stays empty", by_id[r["id"]]["runner"] == "")

hits = db.list_runs(q="laptop")
check("search by runner finds the run", [x["id"] for x in hits] == [r2["id"]])
check("search by runner count", db.count_runs(q="laptop") == 1)

# existing DBs: migrate adds the column
path2 = os.path.join(_TMP, "legacy.db")
import sqlite3
conn = sqlite3.connect(path2)
conn.executescript(
    "CREATE TABLE models (id TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '',"
    " pinned INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL, last_used_at REAL NOT NULL);"
    "CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, model_id TEXT NOT NULL,"
    " started_at REAL NOT NULL, last_activity_at REAL NOT NULL,"
    " expected_seq INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'running',"
    " pinned INTEGER NOT NULL DEFAULT 0);"
    "CREATE TABLE metric_points (run_id INTEGER NOT NULL, seq INTEGER NOT NULL,"
    " ts REAL NOT NULL, iteration INTEGER NOT NULL, batches INTEGER NOT NULL DEFAULT 0,"
    " metrics TEXT NOT NULL, PRIMARY KEY (run_id, seq));"
    "CREATE TABLE pauses (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL,"
    " start_ts REAL NOT NULL, end_ts REAL NOT NULL);"
)
conn.execute("INSERT INTO models VALUES ('old','',0,1,1)")
conn.commit()
conn.close()
legacy = Database(path2)
legacy.create_run("old", runner="phone")
check("migrated DB accepts runner", legacy.list_runs()[0]["runner"] == "phone")

# API token: minted once, reused on reopen
t1 = db.ensure_api_token()
check("API token minted", bool(t1) and len(t1) > 20)
db2 = Database(os.environ["TRAINUI_DB"])
check("API token stable across reopen", db2.ensure_api_token() == t1)

print(f"\n{ok} checks passed")
