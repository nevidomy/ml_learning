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

Auth is **disabled by default** (local use). To enable it, set:

```bash
export TRAINUI_GOOGLE_CLIENT_ID="1234567890-abc.apps.googleusercontent.com"
export TRAINUI_ALLOWED_EMAILS="nevidomy.vitaliy@gmail.com"   # comma-separated whitelist
export TRAINUI_API_TOKEN="$(openssl rand -hex 32)"           # bearer token for training scripts
python -m trainui.server --host 0.0.0.0 --port 8501
```

When enabled, every `/api/*` endpoint requires either a Google ID token from a
whitelisted account (the web UI shows a "Sign in with Google" button and
handles this automatically) or the shared `TRAINUI_API_TOKEN`. Static assets
stay public; only the data API is protected.

Setup steps:

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) →
   create an OAuth client ID of type **Web application**, and add your origin
   (e.g. `https://trainui.example.com`) to *Authorized JavaScript origins*.
2. Serve trainui behind HTTPS — Google Sign-In requires it on non-localhost
   origins. Simplest: put it behind Caddy (`trainui.example.com { reverse_proxy
   127.0.0.1:8501 }`) or nginx with a Let's Encrypt certificate.
3. Point training scripts at the public URL with the API token:

```python
import os
os.environ["TRAINUI_URL"] = "https://trainui.example.com"
os.environ["TRAINUI_API_TOKEN"] = "<same token as the server>"
# or: Tracker(..., base_url="https://trainui.example.com", token="...")
```
