# trainui documentation

trainui is a lightweight metric-tracking system for ML training. Training code
posts metrics over HTTP to a small FastAPI server, which stores them in SQLite
and serves a web UI with aligned, zoomable, auto-refreshing charts.

```
training script  --HTTP-->  trainui server (FastAPI + SQLite)  <--browser--  you
```

---

## Quick start

```bash
pip install -r trainui/requirements.txt
python -m trainui.server --port 8501     # open http://127.0.0.1:8501
```

```python
from trainui.client import Tracker

tracker = Tracker(model_id="gpt-v6", description="6-layer GPT on names")
with tracker.start_run(description="baseline, lr=3e-4") as run:
    for it in range(1000):
        run.log(iteration=it, batches=32, train_loss=loss, lr=lr)
```

---

## Python client API

### `Tracker(...)`

Declares a model. Calling it again with the same `model_id` **updates** the
description and any parameters passed (omitted parameters keep old values).

| Parameter | Default | Meaning |
|---|---|---|
| `model_id` | (required) | Unique model identifier. |
| `description` | `""` | Free text, updated on every init. |
| `base_url` | `$TRAINUI_URL` or `http://127.0.0.1:8501` | Server address. |
| `timeout` | `30.0` | HTTP timeout per request (seconds). |
| `param_count` | — | Model size; shown in the UI (formatted as 3.20M / 1.26B). |
| `context_width` | — | Default sequence length, used for the tokens/sec chart. |
| `chars_per_token` | — | Enables BPC display for loss charts (see below). |
| `metrics` | — | List of custom metric names declared up front; the UI creates chart panels for them even before data arrives. |
| `token` | `$TRAINUI_API_TOKEN` | Bearer token for auth-enabled servers. |
| `disabled` | `False` | Dry-run mode: every call is a local no-op, no HTTP requests at all. |

### `tracker.start_run(description="") -> Run`

Starts a new run. `description` is an optional note shown in run lists and on
the run page. Use it as a context manager — `run.finish()` is called
automatically on exit.

### `run.log(iteration, batches=0, context_size=None, lr2=None, **metrics)`

Logs one point. Rules and behavior:

- Each call carries a strictly increasing sequence number, managed
  automatically. If the server detects a gap (e.g. the process crashed and
  restarted), `log` raises `SequenceError` — see `run.resume()`.
- `**metrics` — arbitrary named values, e.g. `train_loss=2.1, lr=1e-4`.
  Keys may vary between calls; sparse metrics (logged occasionally) are drawn
  interpolated across gaps with dots at measured points.
- `lr2` — optional secondary learning rate. All learning-rate-like keys
  (`lr`, `lr2`, `main_lr`, `learning_rate`, …) share one chart.
- `batches` + `context_size` feed the derived **tokens/sec** chart
  (`batches * context_size / elapsed-active-time`). If `context_size` is
  omitted, the model's `context_width` is used.
- Transient network errors are retried automatically (3 attempts with
  backoff); a timed-out request that was actually applied server-side is
  deduplicated via the sequence check.
- If the server stays unreachable, the tracker switches to **offline mode**
  (see below) instead of ever killing your training run.

### Metric naming conventions (chart grouping)

The UI groups related metrics onto shared charts by key name:

| Convention | Example | Result |
|---|---|---|
| `train_*` / `test_*` / `val_*` / `eval_*` | `train_loss`, `test_loss` | one "loss" chart |
| learning-rate-like keys | `lr`, `lr2`, `backbone_lr` | one "lr" chart |
| `group/name` | `grad_norm/layer0` … `grad_norm/layer19` | one "grad_norm" chart with 20 toggleable series |
| anything else | `mmlu` | its own chart |

On multi-series charts, **click a legend entry** to hide/show that metric and
**double-click to isolate** it (double-click again to restore all). Hidden
state persists per run across page reloads.

### `run.resume(next_seq=None)`

Closes a gap in logging: the time since the last log call is recorded as a
**pause** (excluded from chart time axes and statistics), and logging
continues from the server's expected sequence. Typical crash-recovery pattern:

```python
run = tracker.start_run()
try:
    run.log(iteration=it, ...)
except SequenceError:
    run.resume()
    run.log(iteration=it, ...)
```

### `run.finish()`

Marks the run completed. Further `log` calls raise `TrainUIError`.

### Offline mode (server unreachable)

If a request fails repeatedly (server down, network issue), the tracker stops
sending and appends every request to a local JSONL file instead — training
continues untouched. The file is created in the working directory as
`trainui-offline-<model>-<hash>-<timestamp>-<pid>.jsonl` (exclusive create, so
concurrent processes never clobber each other), and a warning with the path is
printed to stderr. All operations are recorded: model init, run creation,
points (with their original timestamps), resumes, finishes.

When the server is back, upload with the bundled CLI:

```bash
python -m trainui.upload trainui-offline-mymodel-a1b2c3d4-....jsonl \
    --url http://127.0.0.1:8501 --token <api token if auth is on>
```

Upload is idempotent (points already on the server are skipped) and preserves
original timestamps, so time-axis charts look as if the outage never happened.
On success the file is renamed to `*.uploaded`.

Runs that were created while offline get fresh server-side run ids on upload
(the local refs are remapped automatically); runs that existed before the
outage simply continue their sequence.

---

## Web UI

### Pages

- **Home** — pinned + recently used models, pinned runs, and a paginated
  recent-runs list.
- **Models** — searchable list; star to pin; ✕ to delete (cascades to runs).
- **Model page** — the model's runs, searchable by id and start-date range.
- **Run page** — the metrics dashboard (below).

Long lists are **paginated**: a `per page 25 50 100 200` selector sits at the
top right of the list (default 50), page links appear below it. The chosen
page size and the current page of each list persist in the browser
(`localStorage`), and changing any search filter jumps back to page 1.

Run rows everywhere show start time, point count, total train time (pauses
excluded), total tokens trained on, model parameter count, the run
description, and last known losses — `val_loss` first and highlighted, then
`test_loss` / `train_loss`, each with BPC in parentheses when the model
declares `chars_per_token`. Tokens are shown as a multiple of the parameter
count (Chinchilla-style) with the absolute number in parentheses:

```
run #17 · gpt-ua-120m — baseline, lr=3e-4        running
started Aug 10, 3:12 PM · 12,403 points · trained 2h 14m
120.55M params · tokens 13.5× (1.63B)
val 4.2123 (bpc 1.784) · test 4.2210 (bpc 1.788) · train 4.0123 (bpc 1.734)
```

Total tokens accumulate per log call as `batches × context_size` (falling back
to the model's `context_width` when `context_size` is omitted); train time and
token totals are also shown in the run page header and update live.

### Run page

- **Charts** — aligned on a shared x-axis: *iterations* (default) or *time*
  (pause gaps removed). Related metrics share a chart; the second chart is
  the derived tokens/sec performance graph.
- **Zoom/pan** — drag to pan, `+` / `−` / `fit all` buttons, double-click to
  fit. Zoom state persists across reloads; switching x-axis mode keeps an
  open fullscreen chart in place.
- **Hover** — a fixed-height details strip shows values at the cursor for the
  hovered chart only; sparse series show linear estimates prefixed with `~`.
  Each chart also has a small in-chart hover frame (top right); **click the
  chart to pin it** (a solid vertical line marks the pinned point while the
  hover cursor keeps moving freely), click another point to re-pin,
  **shift-click to pin the same point on every open chart**, `✕` to release.
- **Moving average** — per-run window control; raw series can be toggled off.
- **Per-chart options** — `log y` toggle (auto-disabled for non-positive
  data), `bpc` toggle on loss charts (when `chars_per_token` is set),
  collapse/expand, fullscreen (`⤢`). All graphs except "loss" start
  collapsed; collapsed charts show live current values in their headers and
  cost no data transfer (series are fetched on demand). Collapsing or
  expanding a chart never disturbs the others (pins and zoom survive), and a
  re-expanded chart adopts the zoom range of the currently open charts.
- **Fullscreen** — the chart plus the full control bar; auto-refresh then
  updates only that chart. `Esc` or `✕` exits.
- **Live updates** — auto-refresh with selectable period (5s–1m) and a
  *follow last* mode (`30s`, `10m`, `2h`, `1d`) pinning the view to the most
  recent window. Refresh stops automatically when the run completes.
- **Notifications** — enable *notify on finish* (the browser asks for
  notification permission once) and you get a desktop notification when the
  open run completes **while you're not looking** (another tab/app or the
  window unfocused). The notification shows final losses and train time;
  clicking it focuses the tab. The preference is global across runs.
- **Persistence** — every UI option (x-mode, avg window, zoom, follow,
  collapsed state, log-y, hidden series) is stored per run in
  `localStorage`; the `bpc` toggle is stored globally so it applies to every
  run you open.

### BPC (bits per character)

When a model declares `chars_per_token`, loss charts get a `bpc` toggle and
run lists show both forms:

```
bpc = loss / chars_per_token / ln(2)
```

---

## Server

```bash
python -m trainui.server [--host 127.0.0.1] [--port 8501] [--db PATH]
```

Database path defaults to `trainui/trainui.db` (`--db` or `TRAINUI_DB`).
Schema migrations run automatically at startup.

### HTTP API

| Endpoint | Purpose |
|---|---|
| `POST /api/init` | upsert model (description, params, metrics_decl, chars_per_token) |
| `POST /api/runs` | start run (`model_id`, `description`) |
| `POST /api/runs/{id}/log` | log point (`seq`, `iteration`, `batches`, `context_size`, `metrics`, optional `ts`) |
| `POST /api/runs/{id}/log_bulk` | atomic multi-point insert used by the offline uploader (skips already-applied seqs) |
| `POST /api/runs/{id}/resume` | close pause gap, adopt expected seq |
| `POST /api/runs/{id}/finish` | mark completed |
| `GET /api/overview` | landing data |
| `GET /api/models`, `GET /api/models/{id}` | model lists/detail |
| `GET /api/runs`, `GET /api/runs/{id}` | run lists/detail |
| `GET /api/runs/{id}/metrics?keys=a,b` | points, optionally filtered to metric keys; always includes `last` value per key |
| `POST /api/{models,runs}/{id}/pin` | pin/unpin |
| `DELETE /api/models/{id}`, `DELETE /api/runs/{id}` | delete (model cascades) |
| `GET /api/config` | public auth config for the UI |

Sequence conflicts return HTTP 409 with `expected_seq` / `received_seq`.

### Authentication (public deployment)

Auth is **disabled by default**. Enable with environment variables (read once
at startup):

```bash
export TRAINUI_GOOGLE_CLIENT_ID="…apps.googleusercontent.com"   # enables auth
export TRAINUI_ALLOWED_EMAILS="you@gmail.com,teammate@gmail.com"
export TRAINUI_API_TOKEN="$(openssl rand -hex 32)"              # for training scripts
```

- Browser users sign in with Google; the ID token is verified server-side and
  the email must be whitelisted.
- Training scripts authenticate with `TRAINUI_API_TOKEN` (client reads the
  same env var, or pass `token=` to `Tracker`).
- Google Sign-In requires HTTPS on non-localhost origins — put the server
  behind Caddy/nginx (`reverse_proxy 127.0.0.1:8501`) and add the origin to
  the OAuth client's *Authorized JavaScript origins*.

---

## Demo

```bash
python -m trainui.example
```
