# trainui

A small local metric-tracking system for ML training: a Python client posts
training metrics over HTTP to a local server, which stores them in SQLite and
serves a web UI with aligned, zoomable charts.

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
)
# re-initing an existing model_id updates description (and params if given)

with tracker.start_run() as run:
    for it in range(1000):
        ...
        run.log(iteration=it, batches=32, train_loss=loss, lr=lr)
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

Pauses are excluded from the chart time axis ("active time"), so gaps don't
distort the graphs or the moving averages.

## Web UI

- **Home** — pinned + recently used models, pinned + latest runs
- **Models** — searchable list (id / description); star to pin
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
