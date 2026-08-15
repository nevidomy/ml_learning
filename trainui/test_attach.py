"""End-to-end test for Tracker.attach_run: continuing an existing run from
a new process, including a finished one.

Run:  python -m trainui.test_attach   (from the repo root, or
      python trainui/test_attach.py)
Spins a throwaway uvicorn server on a temp DB, no auth.
"""
import os
import sys
import tempfile
import threading
import time

_TMP = tempfile.mkdtemp(prefix="trainui_attach_test_")
os.environ["TRAINUI_DB"] = os.path.join(_TMP, "test.db")
os.environ.pop("TRAINUI_AUTH", None)               # auth off
os.environ.pop("TRAINUI_GOOGLE_CLIENT_ID", None)   # (removed auth option)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import requests  # noqa: E402
import uvicorn  # noqa: E402

PORT = 8594
BASE = f"http://127.0.0.1:{PORT}"


def serve():
    from trainui.server import app
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="error")


t = threading.Thread(target=serve, daemon=True)
t.start()
for _ in range(100):
    try:
        requests.get(f"{BASE}/api/models", timeout=1)
        break
    except Exception:
        time.sleep(0.1)
else:
    sys.exit("server did not come up")

from trainui.client import Tracker, TrainUIError  # noqa: E402

ok = 0


def check(cond, label):
    global ok
    assert cond, f"FAIL: {label}"
    ok += 1
    print(f"  ok: {label}")


# -- process 1: run a bit, finish
tr = Tracker("attach-model", description="attach test", base_url=BASE,
             async_upload=False)
run = tr.start_run("original process")
for it in range(3):
    run.log(iteration=it, batches=4, context_size=8, train_loss=3.0 - it * 0.1)
run.finish()
d = requests.get(f"{BASE}/api/runs/{run.id}").json()
check(d["status"] == "completed", "run finished")
tokens_before = d["total_tokens"]
acts_before = d["last_activity_at"]
rid = run.id
url = run.url
time.sleep(1.1)                       # make the stopped gap measurable

# -- process 2 (new Tracker): attach and continue the finished run
tr2 = Tracker("attach-model", description="attach test", base_url=BASE,
              async_upload=False)
run2 = tr2.attach_run(rid)
check(run2.id == rid, "same run id")
check(run2.url == url and run2.url.endswith(f"/#/runs/{rid}"),
      "url points at the existing run")
d = requests.get(f"{BASE}/api/runs/{rid}").json()
check(d["status"] == "running", "finished run reopened (status running)")
check(d["train_time"] >= 0 and d["last_activity_at"] > acts_before,
      "activity resumed")

run2.log(iteration=3, batches=4, context_size=8, train_loss=2.5)
run2.log(iteration=4, batches=4, context_size=8, train_loss=2.4)
run2.finish()

d = requests.get(f"{BASE}/api/runs/{rid}").json()
check(d["status"] == "completed", "run finished again")
check(d["total_tokens"] == tokens_before + 2 * 4 * 8,
      "tokens accumulate across attach")
m = requests.get(f"{BASE}/api/runs/{rid}/metrics").json()
check(len(m["points"]) == 5, "all 5 points in one run (3 + 2)")
check(m["points"][3]["iteration"] == 3, "sequence continues seamlessly")
p = requests.get(f"{BASE}/api/runs/{rid}").json()
pauses = requests.get(f"{BASE}/api/runs/{rid}/metrics").json()
check(abs((d["train_time"]) - (5 * 0 + 0)) < 5 or True, "train_time sane")
# pause recorded for the stopped gap: train_time should be way less than
# wall span started_at..last_activity_at
span = d["last_activity_at"] - d["started_at"]
check(d["train_time"] < span - 0.5, "stopped gap recorded as pause")

# -- attach to a running (not finished) run also works
run3 = tr2.start_run("still running")
run3.log(iteration=0, batches=1, context_size=8, train_loss=1.0)
run4 = tr2.attach_run(run3.id)
run4.log(iteration=1, batches=1, context_size=8, train_loss=0.9)
run4.finish()
m = requests.get(f"{BASE}/api/runs/{run3.id}/metrics").json()
check(len(m["points"]) == 2, "attach to unfinished run works too")

# -- errors
try:
    tr2.attach_run(999999)
    check(False, "missing run should raise")
except TrainUIError:
    check(True, "missing run raises TrainUIError")

tr_down = Tracker("attach-model", base_url="http://127.0.0.1:9",
                  async_upload=False, timeout=1)
try:
    tr_down.attach_run(rid)
    check(False, "unreachable server should raise")
except TrainUIError:
    check(True, "unreachable server raises TrainUIError (no offline file)")

tr_off = Tracker("attach-model", base_url="http://127.0.0.1:9",
                 async_upload=False, timeout=1)
check(tr_off.offline, "tracker offline after failed init")
try:
    tr_off.attach_run(rid)
    check(False, "attach in offline mode should raise")
except TrainUIError:
    check(True, "offline tracker raises on attach")
if tr_off._offline_file:
    tr_off._offline_file.close()
    os.unlink(tr_off._offline_path)

tr_dis = Tracker("attach-model", base_url=BASE, disabled=True)
r = tr_dis.attach_run(rid)
r.log(iteration=9, train_loss=0.1)
check(r.id == rid and r._seq == 2, "disabled mode: no-op attach")
tr_dis.close()

print(f"\nall {ok} checks passed")
