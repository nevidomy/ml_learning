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

### Non-blocking upload (default)

By default (`async_upload=True`), `run.log()` never touches the network: it
appends the point to an in-memory queue (~2 µs per call) and returns. A
single background daemon thread drains the queue **in order** — sequentiality
per run is strictly preserved — batching points into `log_bulk` requests
(every `flush_interval=2.0`s at the latest, or every 500 points).

- `run.finish()` enqueues the finish marker behind the pending points and
  waits for the queue to drain, but never longer than `flush_timeout=5.0`s.
- `tracker.flush()` / `tracker.close()` do the same bounded wait; `close()`
  is also registered with `atexit`, so a normal process exit flushes
  everything — and whatever couldn't be sent in time is dumped to the
  offline file (nothing is lost even if the server is hung).
- Every failure path in the client — network errors, 5xx, unexpected client
  bugs — is caught and falls back to the offline file. Metric collection
  never blocks the training loop (beyond the bounded `finish()` flush) and
  never raises for service problems. (Client-side usage errors like logging
  after `finish()` still raise.)
- With `async_upload=False` the old behavior is kept: every `log()` is a
  synchronous POST (useful for debugging or tiny scripts).

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

### `tracker.attach_run(run_id)`

Attach to an **existing** run from a new process and continue logging to it —
including a completely stopped or finished run (e.g. training crashed and
restarted, and you want the continuation in the same run instead of a new
one):

```python
run = tracker.attach_run(42)   # reopen run #42
run.log(iteration=it, ...)     # continues seamlessly
run.finish()
```

The run is reopened (status `running`), the gap since its last activity is
recorded as a **pause** (excluded from time axes and statistics), and the
returned `Run` starts from the server's expected sequence — no
`SequenceError` handling needed.

Unlike the rest of the API, `attach_run` is **online-only**: it must learn
the server's sequence state, so it raises `TrainUIError` if the server is
unreachable or the run doesn't exist (catch it and fall back to
`start_run()` if a fresh run is acceptable). It also raises if this tracker
is already in offline mode — upload the offline log first, then attach from
a fresh process. `run.url` gives the run's web UI link.

### Offline mode (server unreachable)

If a request fails repeatedly (server down, network issue), the tracker stops
sending and appends every request to a local JSONL file instead — training
continues untouched. In async mode all records keep flowing through the
single worker queue, so the file stays strictly ordered even across the
online→offline transition. The file is created in the working directory as
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

- **Home** — recently used models and a paginated recent-runs list.
- **Models** — searchable list; star to favorite; ✕ to delete (cascades to runs).

Lists are purely chronological (favorites are *not* floated to the top). Every
list page — home, models, runs, model page — has a **★ favorites** filter
toggle in the toolbar that narrows the list to starred items; the toggle is
global (one state shared by all list pages) and persists in the browser
across reloads.

Two independent markers exist per model/run:

- **★ favorite** — filterable via the ★ favorites toggle.
- **◆ pin** — just a visual marker: pinned rows get a subtle blue background.
  **Running** runs are highlighted more strongly (warm yellow) so in-progress
  training stands out in any list.
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
  Refresh ticks are **incremental**: the browser tracks the highest `seq` it
  has and the server returns only newer points (`?since=N`), so refresh cost
  is proportional to newly logged points, not run length (a full re-fetch
  happens only when a previously unseen metric key appears).
- **Chunked initial load** — opening a run fetches history in 10k-point
  chunks (`?since=N&limit=10000`) instead of one giant request: the server
  stays responsive to other clients (including your training process posting
  points), and the charts render progressively as chunks arrive — the first
  10k points appear almost immediately even for very long runs. The same
  chunking is used by every full (re)load path: expanding a chart whose
  series weren't fetched, leaving fullscreen, and the compare view's
  per-run loads.
- **Load status indicators** — while a chart is fetching, a `loading…` tag
  sits at its bottom-right corner and the plot is greyed out; if a fetch
  fails (e.g. server unreachable), the tag turns red (`⚠ load failed —
  will retry`, hover for the error) and clears itself on the next
  successful tick. Works in fullscreen too.
- **Notifications** — enable *notify on finish* (the browser asks for
  notification permission once) and you get a desktop notification when the
  open run completes **while you're not looking** (another tab/app or the
  window unfocused). The notification shows final losses and train time;
  clicking it focuses the tab. The preference is global across runs.
- **Persistence** — every UI option (x-mode, avg window, zoom, follow,
  collapsed state, log-y, hidden series) is stored per run in
  `localStorage`; the `bpc` toggle is stored globally so it applies to every
  run you open.

### Comparing runs

Every run row has a checkbox on the left. Tick runs on any list page (the
selection survives page flips and navigation — it's kept in `localStorage`)
and a bar appears at the bottom of the screen; hit **compare →** (needs ≥ 2
runs) to open the compare view at `#/compare?ids=1,2,3`.

- **Same chart layout as a run page** — one chart per metric group (loss,
  tokens/sec, lr, custom groups…), but every chart overlays all selected runs.
- **One color per run**, shown in the header next to the run link; when a
  group holds several metrics (e.g. `train_loss` + `test_loss`) the second,
  third… metric of the same run is dashed/dotted.
- **X-axis** — *iterations* (default) or *time* (each run on its own
  pause-free clock). Runs with different point sequences are aligned on a
  union axis; missing points are interpolated across.
- **Collapse/expand** — all charts except *loss* start collapsed; collapsed
  headers show live per-run last values. Collapse state is remembered across
  visits (shared by all compare sessions).
- **Fullscreen** — `⤢` opens a chart full-screen with the compared-runs
  legend (colors + live status badges) on top and the full control bar;
  zoom and pinned frames carry over, `Esc` or `✕` exits.
- **Sticky frames** — hovering shows a per-chart values frame; **click to
  pin it** (a solid vertical line marks the pinned x), **shift-click pins
  the same x on every open chart**. Values are grouped metric-major — the
  same metric's runs sit side by side, each tagged with its run color and
  id; runs without a point at that x show an interpolated `~` estimate.
- **Controls** — moving-average window (smoothing is per run, applied before
  the union-axis mapping), raw toggle, drag to pan, `+` / `−` / `fit all`,
  double-click to fit. Hovering also shows live values in each chart's
  legend.
- **Y-axis** — `log y` toggle per chart (auto-disabled for non-positive
  data, remembered across visits). **Drag vertically on the y-axis itself to
  clip the range** to the dragged band (a shaded band shows the selection);
  once clipped, **drag the axis again to resize the clip proportionally**
  around its center (up = larger, down = smaller) and **drag vertically on
  the plot to slide the clip window up/down** (grab-the-graph direction,
  like x-panning; both log-aware when `log y` is on). Click the axis to
  reset, or `fit all` / double-click the plot to restore the full view on
  both axes. The clip holds while panning, zooming, and during live
  updates.
- **Legend toggles** — clicking a legend row under a chart hides/shows that
  whole logical series (both the raw and smoothed lines of that
  run + metric together); double-click isolates it, double-click again
  restores all. Hidden state survives rebuilds and fullscreen.
- **BPC** — loss charts get a `bpc` toggle when any compared run's model
  declares `chars_per_token`; each run is converted with its own model's
  ratio (`loss / chars_per_token / ln(2)`), runs without one stay in nats.
  The preference is global and shared with run pages.
- **On-chart legend** — the `legend` button on a chart header overlays a
  compact per-run summary directly on the graph:
  `#130 P1_init_… p=120.55M tr=13.5× (1.63B) - baseline, lr=3e-4`
  (color-coded run id, model, params, tokens-trained multiplier,
  description). Works in fullscreen too, updates live as tokens
  accumulate, and the toggle is remembered across visits.
- **Live updates** — while any compared run is still running, auto-refresh
  (5s–1m) pulls new points for all runs and updates charts in place without
  disturbing your zoom; in fullscreen only that chart is updated. Refresh
  stops once every run is completed. Fetches are incremental per run
  (`?since=N`), with a full re-fetch of a run only when it starts reporting
  a new metric key. Initial loads use the same 10k-point chunking as the
  single-run view.

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
| `POST /api/{models,runs}/{id}/pin` | pin/unpin (highlight) |
| `POST /api/{models,runs}/{id}/favorite` | favorite/unfavorite (filterable) |
| `DELETE /api/models/{id}`, `DELETE /api/runs/{id}` | delete (model cascades) |
| `GET /api/config` | public auth config for the UI (`{"auth_enabled": bool}`) |
| `POST /api/auth/signup` | request an invite (email; allowlist-gated, non-enumerating) |
| `GET /api/auth/invite/{token}` | invite landing info (masked email or 410) |
| `POST /api/auth/invite/{token}` | set password (single-use; returns a session token) |
| `POST /api/auth/login` | email + password → session token |
| `POST /api/auth/logout` | drop the bearer session |

Sequence conflicts return HTTP 409 with `expected_seq` / `received_seq`.

### Authentication (public deployment)

Auth is **disabled by default**. `python -m trainui.server --global` listens
on `0.0.0.0` and enables **invite-only email/password auth** (or set
`TRAINUI_AUTH=1` yourself). No Google Cloud project is needed.

Flow: an allowlisted visitor enters their email on the sign-in page → the
server emails a single-use, 24h password-setup link → they choose a password
→ they get a 30-day session token. Sign-up responses are deliberately
non-enumerating (unknown and already-registered emails get the same answer,
minus the email).

Security properties:

- Passwords are never stored or logged in plaintext — salted
  PBKDF2-HMAC-SHA256, 260k iterations, constant-time compare.
- Invite/session tokens are 256-bit random, stored only as SHA-256 digests;
  invites expire in 24h and are single-use, sessions in 30 days.
- Serve `--global` behind **HTTPS** (Caddy/nginx/tunnel) — passwords cross
  the wire at login and password setup.

Accepted credentials per `/api/*` request (any one):

1. `Authorization: Bearer <session token>` — from the login flow (web UI).
2. `Authorization: Bearer <TRAINUI_API_TOKEN>` — shared secret for training
   scripts (the client reads the same env var, or pass `token=` to `Tracker`).
3. Nothing, from **direct loopback connections** — local tools and the
   offline-log uploader keep working. The exemption is void whenever proxy
   headers (`X-Forwarded-For`, `X-Real-IP`, `Forwarded`) are present, so a
   same-host reverse proxy can't masquerade as localhost; disable entirely
   with `TRAINUI_ALLOW_LOCALHOST=0`.

Configuration:

```bash
export TRAINUI_ALLOWED_EMAILS="you@gmail.com,teammate@gmail.com"  # invite allowlist
export TRAINUI_API_TOKEN="$(openssl rand -hex 32)"                # training scripts
export TRAINUI_PUBLIC_URL="https://trainui.example.com"           # invite email links
# mail delivery — without SMTP the invite link is printed to the server log:
export TRAINUI_SMTP_HOST=smtp.gmail.com TRAINUI_SMTP_PORT=587
export TRAINUI_SMTP_USER=you@gmail.com TRAINUI_SMTP_PASS=<app password>
python -m trainui.server --global --port 8501
```

---

## Demo

```bash
python -m trainui.example
```
