# trainui

A small local metric-tracking system for ML training: a Python client posts
training metrics over HTTP to a local server, which stores them in SQLite and
serves a web UI with aligned, zoomable charts.

See [DOCUMENTATION.md](DOCUMENTATION.md) for the full client API reference,
UI feature guide, and deployment instructions.

## Layout

- `trainui/server.py` — FastAPI app: ingestion API + static web UI
- `trainui/db.py` — SQLite storage (models, runs, metric points, pauses)
- `trainui/client.py` — Python client (`Tracker`, `Run`)
- `trainui/static/` — web UI (vanilla JS + uPlot, vendored, works offline)
- `trainui/example.py` — simulated training loop incl. pause/resume

## Setup

```bash
pip install -r trainui/requirements.txt
```

## Run the server

```bash
python -m trainui.server --port 8501
# open http://127.0.0.1:8501
```

The database is stored at `trainui/trainui.db` (override with `--db PATH` or
the `TRAINUI_DB` env var).

## Log from training code

```python
from trainui.client import Tracker, SequenceError

tracker = Tracker(
    model_id="gpt-v6",
    description="6-layer GPT on names",
    param_count=3_200_000,   # optional, shown in the UI
    context_width=128,       # optional, default context size for tokens/sec
    metrics=["mmlu", "hellaswag"],  # optional: declare custom metrics to get
                                    # charts for them even before data arrives
    # disabled=True,  # dry run: every call is a no-op, no requests are made
)
# re-initing an existing model_id updates description (and params if given)

with tracker.start_run() as run:
    for it in range(1000):
        ...
        run.log(iteration=it, batches=32, train_loss=loss, lr=lr, lr2=lr_backbone)
        # lr2=... optional secondary learning rate; all *lr* metrics share one chart
        # context_size=... optional per call; defaults to model context_width
        if it % 100 == 0:
            run.log(iteration=it, test_loss=test_loss)  # sparse metrics are fine
```

Each `log` call carries a strictly increasing sequence number. If the server
sees an unexpected sequence (e.g. your process crashed and restarted),
`run.log` raises `SequenceError`. Resume with:

```python
try:
    run.log(...)
except SequenceError:
    run.resume()   # records the gap as a pause, adopts the server's next seq
    run.log(...)
```

To keep logging into an existing run from a **new process** (even a finished
run), attach to it by id — the stopped gap becomes a pause and the sequence
is adopted automatically:

```python
run = tracker.attach_run(42)   # raises TrainUIError if server down / no run
```

If the server is unreachable, the client never kills your training run: after
a few retries it switches to offline mode and appends every request to a
`trainui-offline-<model>-<hash>-<ts>-<pid>.jsonl` file in the working
directory (a warning with the path goes to stderr). When the server is back:

```bash
python -m trainui.upload trainui-offline-....jsonl
```

Original timestamps are preserved, upload is idempotent, and the file is
renamed to `*.uploaded` on success.
```

Pauses are excluded from the chart time axis ("active time"), so gaps don't
distort the graphs or the moving averages.

## Web UI

- **Home** — recently used models, paginated recent runs
- **Models** — searchable list (id / description); star to favorite
  (★ favorites filter on every list; favorites don't float to the top)
- **Model page** — its runs, searchable by id and start-date range
- **Run page** — charts aligned on a shared x-axis (active time or
  iteration). Related metrics share a chart: `train_loss`, `test_loss`,
  `val_loss` all plot on one "loss" chart (prefixes `train_`/`test_`/`val_`/
  `eval_` are stripped to group them). Sparse metrics like `test_loss` are
  interpolated across gaps and drawn with points at measured values.
  The second chart is a derived **tokens/sec** performance graph, computed
  from `batches * context_size` over active time (pauses don't skew it).
  Drag to pan, `+`/`−`/`fit all` buttons or double-click to zoom, hover for
  exact values, moving-average window control, per-chart log-y toggle,
  dashed markers where pauses were cut out
- **Live view** — auto-refresh with selectable period (5s/10s/30s/1m) and a
  "follow last N" mode (e.g. `30s`, `10m`, `2h`, `1d`) that keeps the view
  pinned to the most recent window as data arrives
- **Delete** — models and runs have a ✕ button (with confirmation);
  deleting a model cascades to its runs and metrics

## Demo

```bash
python -m trainui.example
```

## Authentication (running on the public web)

Auth is **disabled by default** (local use). To run on the public web:

```bash
export TRAINUI_ALLOWED_EMAILS="nevidomy.vitaliy@gmail.com"   # invite allowlist
export TRAINUI_API_TOKEN="$(openssl rand -hex 32)"           # for training scripts
export TRAINUI_PUBLIC_URL="https://trainui.example.com"      # used in invite emails
python -m trainui.server --global --port 8501
```

`--global` listens on `0.0.0.0` and enables **invite-only email/password auth**
— no Google Cloud project needed. Flow: an allowlisted user enters their email
on the sign-in page → the server emails a single-use 24h setup link → they
choose a password → 30-day session. Passwords are stored only as salted
PBKDF2 hashes, tokens only as SHA-256 digests.

Every `/api/*` request then needs one of:

- a session token from the login flow (the web UI handles this automatically),
- the shared `TRAINUI_API_TOKEN` as a bearer token (python client), or
- nothing at all from **direct loopback connections** — local tools and the
  uploader keep working. The exemption is void if proxy headers
  (`X-Forwarded-For` etc.) are present, so a same-host reverse proxy can't be
  used to sneak in as "localhost". Disable with `TRAINUI_ALLOW_LOCALHOST=0`.

Mail delivery: without SMTP the invite link is printed to the **server log**
(fine for inviting yourself). For real email delivery:

```bash
export TRAINUI_SMTP_HOST=smtp.gmail.com TRAINUI_SMTP_PORT=587
export TRAINUI_SMTP_USER=you@gmail.com TRAINUI_SMTP_PASS=<app password>
```

Serve `--global` behind **HTTPS** (Caddy/nginx/any tunnel) — passwords are
submitted over the wire. Point remote training scripts at the public URL with
the API token:

```python
import os
os.environ["TRAINUI_URL"] = "https://trainui.example.com"
os.environ["TRAINUI_API_TOKEN"] = "<same token as the server>"
# or: Tracker(..., base_url="https://trainui.example.com", token="...")
```
