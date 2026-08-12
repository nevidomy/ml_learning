/* trainui frontend: hash-routed SPA + uPlot charts */
"use strict";

const app = document.getElementById("app");
let refreshTimer = null;
let resizeHandler = null;

// ---------- auth ----------

let authConfig = { auth_enabled: false, google_client_id: null };
const getToken = () => localStorage.getItem("trainui:idtoken") || "";
const setToken = t => t
  ? localStorage.setItem("trainui:idtoken", t)
  : localStorage.removeItem("trainui:idtoken");

class AuthError extends Error {}

function showLogin(message = "") {
  cleanup();
  app.innerHTML = `
    <div class="login-box">
      <h2>Sign in to trainui</h2>
      <p class="login-hint">Access is restricted to whitelisted Google accounts.</p>
      <div id="gsi-btn"></div>
      <p class="login-err">${esc(message)}</p>
    </div>`;
  const render = () => {
    if (!window.google?.accounts?.id) return false;
    google.accounts.id.initialize({
      client_id: authConfig.google_client_id,
      callback: resp => { setToken(resp.credential); route(); },
    });
    google.accounts.id.renderButton(document.getElementById("gsi-btn"), {
      theme: "filled_black", size: "large", text: "signin_with",
    });
    return true;
  };
  if (!render()) {
    const timer = setInterval(() => { if (render()) clearInterval(timer); }, 200);
    setTimeout(() => clearInterval(timer), 10000);
  }
}

// ---------- helpers ----------

async function api(path, opts = {}) {
  const token = getToken();
  const headers = { ...(opts.headers || {}) };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const resp = await fetch(path, { ...opts, headers });
  if (resp.status === 401) {
    const hadToken = !!token;
    setToken("");
    if (authConfig.auth_enabled) {
      showLogin(hadToken ? "Session expired or account not whitelisted — sign in again." : "");
    }
    throw new AuthError("unauthorized");
  }
  if (!resp.ok) throw new Error(`${resp.status} ${await resp.text()}`);
  return resp.json();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function fmtDate(ts) {
  return new Date(ts * 1000).toLocaleString();
}

function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return sec + "s";
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60), mm = m % 60;
  if (h < 24) return mm ? `${h}h ${mm}m` : `${h}h`;
  const d = Math.floor(h / 24), hh = h % 24;
  return hh ? `${d}d ${hh}h` : `${d}d`;
}

function fmtNum(v) {
  if (v == null || !isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return v.toExponential(3);
  return Number(v.toPrecision(5)).toString();
}

function fmtParams(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

// rates, e.g. 65.37 k/s, 1.26 M/s, 3.60 B/s
function fmtRate(v) {
  if (v == null || !isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + " B/s";
  if (a >= 1e6) return (v / 1e6).toFixed(2) + " M/s";
  if (a >= 1e3) return (v / 1e3).toFixed(2) + " k/s";
  return v.toFixed(1) + " /s";
}

// per-metric value formatter (tokens/sec gets rate suffixes)
function fmtVal(key, v) {
  return key === "tokens_per_sec" ? fmtRate(v) : fmtNum(v);
}

// total tokens for a run, as "13.5× (7.34B)" when params are known
function fmtTokens(r) {
  const t = r.total_tokens || 0;
  if (!t) return "";
  const mult = r.model_param_count ? `${fmtNum(t / r.model_param_count)}× ` : "";
  return `${mult}(${fmtParams(t)})`;
}

function pinBtn(kind, id, pinned) {
  return `<button class="pin-btn ${pinned ? "pinned" : ""}" data-pin-kind="${kind}"
    data-pin-id="${esc(id)}" data-pinned="${pinned ? 1 : 0}"
    title="${pinned ? "unpin" : "pin"}">${pinned ? "★" : "☆"}</button>`;
}

function delBtn(kind, id, parent) {
  return `<button class="del-btn" data-del-kind="${kind}" data-del-id="${esc(id)}"
    ${parent ? `data-del-parent="${esc(parent)}"` : ""}
    title="delete">✕</button>`;
}

// event delegation for pin buttons
document.addEventListener("click", async e => {
  const btn = e.target.closest(".pin-btn");
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const kind = btn.dataset.pinKind, id = btn.dataset.pinId;
  const pinned = btn.dataset.pinned !== "1";
  const path = kind === "model"
    ? `/api/models/${encodeURIComponent(id)}/pin`
    : `/api/runs/${id}/pin`;
  await api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pinned }),
  });
  route();
});

// event delegation for delete buttons
document.addEventListener("click", async e => {
  const btn = e.target.closest(".del-btn");
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const kind = btn.dataset.delKind, id = btn.dataset.delId;
  const label = kind === "model"
    ? `model "${id}" and ALL its runs`
    : `run #${id}`;
  if (!confirm(`Delete ${label}? This cannot be undone.`)) return;
  const path = kind === "model"
    ? `/api/models/${encodeURIComponent(id)}`
    : `/api/runs/${id}`;
  await api(path, { method: "DELETE" });
  const hash = location.hash;
  if (kind === "model" && hash.startsWith(`#/models/${encodeURIComponent(id)}`)) {
    location.hash = "#/models";
  } else if (kind === "run" && hash === `#/runs/${id}`) {
    location.hash = btn.dataset.delParent
      ? `#/models/${encodeURIComponent(btn.dataset.delParent)}`
      : "#/runs";
  } else {
    route();
  }
});

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// bpc toggle: global across runs, keyed by chart group name
function loadBpc() {
  try { return JSON.parse(localStorage.getItem("trainui.bpc")) || {}; }
  catch { return {}; }
}

function saveBpc(bpc) {
  try { localStorage.setItem("trainui.bpc", JSON.stringify(bpc)); } catch { }
}

// "notify on finish" is a global browser preference
function loadNotify() {
  return localStorage.getItem("trainui.notify") === "1";
}

function saveNotify(on) {
  try { localStorage.setItem("trainui.notify", on ? "1" : "0"); } catch { }
}

// browser notification when a watched run completes while the user is elsewhere
function maybeNotifyFinished(state) {
  if (!state.notify) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (!document.hidden && document.hasFocus()) return;  // user is looking
  const run = state.run;
  const lm = run.last_metrics || {};
  const bits = [];
  for (const [k, label] of [["val_loss", "val"], ["test_loss", "test"], ["train_loss", "train"]])
    if (lm[k] != null) bits.push(`${label} ${fmtNum(lm[k])}`);
  if (run.train_time) bits.push(fmtDur(run.train_time));
  const n = new Notification(`trainui: run #${run.id} completed`, {
    body: `${run.model_id}${bits.length ? " — " + bits.join(" · ") : ""}`,
    tag: `trainui-run-${run.id}`,
  });
  n.onclick = () => { window.focus(); n.close(); };
}

// per-run UI options persisted across page reloads
function loadRunOpts(runId) {
  try {
    return JSON.parse(localStorage.getItem(`trainui:run:${runId}:opts`)) || {};
  } catch { return {}; }
}

function saveRunOpts(runId, state) {
  const el = eid => document.getElementById(eid);
  try {
    localStorage.setItem(`trainui:run:${runId}:opts`, JSON.stringify({
      xmode: state.xmode,
      avgWin: state.avgWin,
      showRaw: state.showRaw,
      refresh: parseInt(el("refreshsel")?.value || "0"),
      follow: el("follow")?.checked || false,
      followWin: el("followwin")?.value || "1h",
      logY: state.logY,
      hiddenKeys: state.hiddenKeys,
      collapsed: state.collapsed,
      keys: state.keys,
      xrange: currentRange(state),
    }));
  } catch { /* storage unavailable */ }
}

function cleanup() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  if (resizeHandler) { window.removeEventListener("resize", resizeHandler); resizeHandler = null; }
  const overlay = document.querySelector(".fs-overlay");
  if (overlay) overlay.remove();
  document.body.style.overflow = "";
}

// ---------- list rendering ----------

function modelCard(m) {
  return `<a class="card" href="#/models/${encodeURIComponent(m.id)}">
    <div class="card-title">${pinBtn("model", m.id, m.pinned)} ${esc(m.id)}
      <span style="flex:1"></span>${delBtn("model", m.id)}</div>
    <div class="desc">${esc(m.description || "")}</div>
    <div class="meta"><span>${m.run_count} run${m.run_count === 1 ? "" : "s"}</span>
      ${m.param_count ? `<span>${fmtParams(m.param_count)} params</span>` : ""}
      ${m.context_width ? `<span>ctx ${m.context_width}</span>` : ""}
      <span>last used ${fmtDate(m.last_used_at)}</span></div>
  </a>`;
}

function runRow(r, showModel) {
  const lm = r.last_metrics || {};
  const cpt = r.model_chars_per_token;
  const losses = [["val_loss", "val", true], ["test_loss", "test", false],
                  ["train_loss", "train", false]]
    .filter(([k]) => lm[k] != null)
    .map(([k, label, hl]) => {
      const bpc = cpt ? ` (bpc ${fmtNum(lm[k] / cpt / Math.LN2)})` : "";
      const s = `${label} <b>${fmtNum(lm[k])}</b>${bpc}`;
      return hl ? `<b class="hl">${s}</b>` : s;
    })
    .join(" · ");
  const params = r.model_param_count
    ? `<b class="hl2">${fmtParams(r.model_param_count)}</b> params` : "";
  const trained = r.train_time ? ` · trained ${fmtDur(r.train_time)}` : "";
  const tokens = fmtTokens(r) ? `tokens <b class="hl">${fmtTokens(r)}</b>` : "";
  const sizeLine = [params, tokens].filter(Boolean).join(" · ");
  const desc = r.description ? ` — ${esc(r.description)}` : "";
  return `<a class="row" href="#/runs/${r.id}">
    ${pinBtn("run", r.id, r.pinned)}
    <div class="row-main">
      <div class="row-title">run #${r.id}${showModel ? ` · ${esc(r.model_id)}` : ""}${desc}</div>
      <div class="row-sub">started ${fmtDate(r.started_at)} · ${r.point_count} points${trained}</div>
      ${sizeLine ? `<div class="row-sub">${sizeLine}</div>` : ""}
      ${losses ? `<div class="row-sub">${losses}</div>` : ""}
    </div>
    <span class="badge ${r.status}">${r.status}</span>
    ${delBtn("run", r.id)}
  </a>`;
}

// ---------- pagination ----------

const PAGE_SIZES = [25, 50, 100, 200];

function pageState(viewKey) {
  let size = +localStorage.getItem("trainui.pageSize") || 50;
  if (!PAGE_SIZES.includes(size)) size = 50;
  const pages = JSON.parse(localStorage.getItem("trainui.pages") || "{}");
  return { size, page: pages[viewKey] || 0 };
}

function savePageState(viewKey, size, page) {
  localStorage.setItem("trainui.pageSize", size);
  const pages = JSON.parse(localStorage.getItem("trainui.pages") || "{}");
  pages[viewKey] = page;
  localStorage.setItem("trainui.pages", JSON.stringify(pages));
}

function resetPage(viewKey) {
  savePageState(viewKey, pageState(viewKey).size, 0);
}

async function fetchPage(viewKey, path, params = {}) {
  const { size, page } = pageState(viewKey);
  const call = p => {
    const qs = new URLSearchParams(
      Object.entries({ ...params, limit: size, offset: p * size })
        .filter(([, v]) => v != null && v !== "")
    );
    return api(`${path}?${qs}`);
  };
  let data = await call(page);
  const last = Math.max(0, Math.ceil(data.total / size) - 1);
  if (page > last) {  // filters shrank the list; clamp to the last page
    savePageState(viewKey, size, last);
    data = await call(last);
    return { data, size, page: last };
  }
  return { data, size, page };
}

function pagerTopHtml(size) {
  return `<span class="pager pager-top"><span>per page</span>${
    PAGE_SIZES.map(n => `<a class="pg ${n === size ? "on" : ""}" data-size="${n}">${n}</a>`).join("")
  }</span>`;
}

function pagerBottomHtml(page, size, total) {
  const pages = Math.ceil(total / size);
  if (pages <= 1) return "";
  const nums = [];
  const lo = Math.max(0, page - 3), hi = Math.min(pages - 1, page + 3);
  if (lo > 0) nums.push(`<a class="pg" data-page="0">1</a>${lo > 1 ? '<span class="pg-gap">…</span>' : ""}`);
  for (let i = lo; i <= hi; i++)
    nums.push(`<a class="pg ${i === page ? "on" : ""}" data-page="${i}">${i + 1}</a>`);
  if (hi < pages - 1)
    nums.push(`${hi < pages - 2 ? '<span class="pg-gap">…</span>' : ""}<a class="pg" data-page="${pages - 1}">${pages}</a>`);
  return `<div class="pager pager-bottom">
    <a class="pg ${page === 0 ? "off" : ""}" data-page="${page - 1}">‹ prev</a>
    ${nums.join("")}
    <a class="pg ${page >= pages - 1 ? "off" : ""}" data-page="${page + 1}">next ›</a>
  </div>`;
}

function bindPager(viewKey, rerender) {
  const { size } = pageState(viewKey);
  app.querySelectorAll(".pg[data-size]").forEach(a =>
    a.addEventListener("click", () => {
      savePageState(viewKey, +a.dataset.size, 0);
      rerender();
    }));
  app.querySelectorAll(".pg[data-page]").forEach(a =>
    a.addEventListener("click", () => {
      if (a.classList.contains("off")) return;
      savePageState(viewKey, size, +a.dataset.page);
      rerender();
    }));
}

// ---------- views ----------

async function viewLanding() {
  const data = await api("/api/overview");
  const { data: runsData, size, page } = await fetchPage("home-runs", "/api/runs",
    { unpinned: 1 });
  const pinnedModels = data.models.filter(m => m.pinned);
  const recentModels = data.models.filter(m => !m.pinned);
  const pinnedRuns = data.runs.filter(r => r.pinned);
  const recentRuns = runsData.items;
  app.innerHTML = `
    <h1>Overview</h1>
    ${pinnedModels.length ? `<h2>Pinned models</h2><div class="card-grid">${pinnedModels.map(modelCard).join("")}</div>` : ""}
    <h2>Recent models</h2>
    ${recentModels.length ? `<div class="card-grid">${recentModels.map(modelCard).join("")}</div>` : `<div class="empty">no models yet</div>`}
    ${pinnedRuns.length ? `<h2>Pinned runs</h2><div class="rows">${pinnedRuns.map(r => runRow(r, true)).join("")}</div>` : ""}
    <div class="toolbar" style="justify-content:space-between">
      <h2 style="margin:0">Recent runs</h2>${pagerTopHtml(size)}
    </div>
    ${recentRuns.length ? `<div class="rows">${recentRuns.map(r => runRow(r, true)).join("")}</div>` : `<div class="empty">no runs yet</div>`}
    ${pagerBottomHtml(page, size, runsData.total)}
    <div class="toolbar" style="margin-top:24px">
      <a href="#/models">all models →</a>&nbsp;&nbsp;<a href="#/runs">all runs →</a>
    </div>`;
  bindPager("home-runs", viewLanding);
}

async function viewModels(q = "") {
  const { data, size, page } = await fetchPage("models", "/api/models", { q });
  const models = data.items;
  app.innerHTML = `
    <h1>Models</h1>
    <div class="toolbar"><input type="search" id="q" placeholder="search by id or description…"
      value="${esc(q)}" style="flex:1;max-width:420px">${pagerTopHtml(size)}</div>
    ${models.length ? `<div class="card-grid">${models.map(modelCard).join("")}</div>`
                    : `<div class="empty">no models match</div>`}
    ${pagerBottomHtml(page, size, data.total)}`;
  bindPager("models", () => viewModels(q));
  const input = document.getElementById("q");
  input.addEventListener("input", debounce(() => {
    history.replaceState(null, "", `#/models?q=${encodeURIComponent(input.value)}`);
    resetPage("models");
    viewModels(input.value).then(() => {
      const el = document.getElementById("q");
      el.focus(); el.setSelectionRange(el.value.length, el.value.length);
    });
  }, 250));
}

async function viewAllRuns(params = {}) {
  const { data, size, page } = await fetchPage("runs", "/api/runs", params);
  const runs = data.items;
  app.innerHTML = `
    <h1>Runs</h1>
    ${runsToolbar(params, size)}
    ${runs.length ? `<div class="rows">${runs.map(r => runRow(r, true)).join("")}</div>`
                  : `<div class="empty">no runs match</div>`}
    ${pagerBottomHtml(page, size, data.total)}`;
  bindPager("runs", () => viewAllRuns(params));
  bindRunsToolbar("runs", p => viewAllRuns(p));
}

function runsToolbar(params, size) {
  const toLocal = ts => ts ? new Date(ts * 1000).toISOString().slice(0, 16) : "";
  return `<div class="toolbar">
    <input type="search" id="q" placeholder="search run id / model…" value="${esc(params.q || "")}">
    <label style="color:var(--text-dim);font-size:13px">from
      <input type="datetime-local" id="from" value="${toLocal(params.date_from)}"></label>
    <label style="color:var(--text-dim);font-size:13px">to
      <input type="datetime-local" id="to" value="${toLocal(params.date_to)}"></label>
    ${pagerTopHtml(size)}
  </div>`;
}

function bindRunsToolbar(viewKey, render) {
  const q = document.getElementById("q");
  const from = document.getElementById("from");
  const to = document.getElementById("to");
  const go = () => {
    resetPage(viewKey);
    render({
      q: q.value,
      date_from: from.value ? new Date(from.value).getTime() / 1000 : null,
      date_to: to.value ? new Date(to.value).getTime() / 1000 : null,
    });
  };
  q.addEventListener("input", debounce(go, 250));
  from.addEventListener("change", go);
  to.addEventListener("change", go);
}

async function viewModelDetail(id, params = {}) {
  const viewKey = `model:${id}`;
  const model = await api(`/api/models/${encodeURIComponent(id)}`);
  const { data, size, page } = await fetchPage(viewKey, "/api/runs",
    { model_id: id, ...params });
  const runs = data.items;
  app.innerHTML = `
    <h1>${pinBtn("model", model.id, model.pinned)} ${esc(model.id)} ${delBtn("model", model.id)}</h1>
    <p style="color:var(--text-dim)">${esc(model.description || "no description")}</p>
    <div class="run-stats">
      ${model.param_count ? `<span>params <b>${fmtParams(model.param_count)}</b></span>` : ""}
      ${model.context_width ? `<span>context width <b>${model.context_width}</b></span>` : ""}
    </div>
    <h2>Runs</h2>
    ${runsToolbar(params, size)}
    ${runs.length ? `<div class="rows">${runs.map(r => runRow(r, false)).join("")}</div>`
                  : `<div class="empty">no runs match</div>`}
    ${pagerBottomHtml(page, size, data.total)}`;
  bindPager(viewKey, () => viewModelDetail(id, params));
  bindRunsToolbar(viewKey, p => viewModelDetail(id, p));
}

// ---------- run detail / charts ----------

const CHART_COLORS = ["#4f8ef7", "#34c98e", "#f7b24f", "#e5646e", "#a78bfa", "#4fd1d9"];

async function viewRunDetail(id) {
  const run = await api(`/api/runs/${id}`);
  const saved = loadRunOpts(id);
  const xmode = saved.xmode === "time" ? "time" : "iteration";  // iterations by default
  const completed = run.status === "completed";
  const refresh = completed ? 0 : (saved.refresh ?? 5);
  const refreshOpt = v => `<option value="${v}" ${refresh === v ? "selected" : ""}>${
    v === 0 ? "off" : v === 60 ? "1m" : v + "s"}</option>`;
  const dis = completed ? "disabled" : "";

  app.innerHTML = `
    <div class="run-head">
      <span class="crumb"><a href="#/models/${encodeURIComponent(run.model_id)}">${esc(run.model_id)}</a> /</span>
      <h1 style="margin:0">${pinBtn("run", run.id, run.pinned)} run #${run.id}
        ${delBtn("run", run.id, run.model_id)}</h1>
      <span class="badge ${run.status}">${run.status}</span>
    </div>
    ${run.description ? `<div class="run-desc">${esc(run.description)}</div>` : ""}
    <div class="run-stats">
      <span>started <b>${fmtDate(run.started_at)}</b></span>
      <span>points <b id="stat-points">…</b></span>
      <span>pauses <b id="stat-pauses">${run.pauses.length}</b></span>
      <span>paused for <b id="stat-paused">${fmtDur(run.pauses.reduce((s, p) => s + p.end_ts - p.start_ts, 0))}</b></span>
      <span>train time <b id="stat-traintime">${fmtDur(run.train_time || 0)}</b></span>
      ${run.total_tokens ? `<span>tokens <b id="stat-tokens">${fmtTokens(run)}</b></span>` : `<span id="stat-tokens-span" hidden>tokens <b id="stat-tokens"></b></span>`}
      ${run.model_param_count ? `<span>params <b>${fmtParams(run.model_param_count)}</b></span>` : ""}
      ${run.model_context_width ? `<span>context <b>${run.model_context_width}</b></span>` : ""}
    </div>
    <div class="chart-controls">
      <label>x-axis
        <select id="xmode">
          <option value="iteration" ${xmode === "iteration" ? "selected" : ""}>iterations</option>
          <option value="time" ${xmode === "time" ? "selected" : ""}>time</option>
        </select>
      </label>
      <label>avg window <input type="number" id="avgwin" min="1" max="10000"
        value="${saved.avgWin || 20}"></label>
      <label><input type="checkbox" id="showraw" ${saved.showRaw !== false ? "checked" : ""}> raw</label>
      <label>refresh
        <select id="refreshsel" ${dis}>${[0, 5, 10, 30, 60].map(refreshOpt).join("")}</select>
      </label>
      <label><input type="checkbox" id="follow" ${saved.follow !== false ? "checked" : ""}> follow last</label>
      <input type="text" id="followwin" value="${esc(saved.followWin || "1h")}" title="e.g. 30s, 10m, 2h, 1d">
      <label title="browser notification when this run finishes while you're not looking">
        <input type="checkbox" id="notify" ${dis}
          ${loadNotify() && "Notification" in window && Notification.permission === "granted" ? "checked" : ""}>
        notify on finish</label>
      <span class="zoom-btns">
        <button id="zin" title="zoom in">+</button>
        <button id="zout" title="zoom out">−</button>
        <button id="zfit" title="fit all data">fit all</button>
      </span>
      <span class="hint">drag to pan · dbl-click to fit · click to pin values · shift-click to pin all · dashed lines = pauses</span>
    </div>
    <div class="hover-panel" id="hoverpanel"><span class="hp-item">hover a chart for details</span></div>
    <div id="charts"></div>`;

  const state = {
    runId: id,
    run,
    points: [],
    lastVals: {},
    xmode,
    avgWin: saved.avgWin || 20,
    showRaw: saved.showRaw !== false,
    charts: [],       // {group, u, logY, body, panel}
    // declared custom metrics get charts even before their first data point
    keys: [...new Set([...(run.model_metrics_decl || []), ...(saved.keys || [])])],
    logY: saved.logY || {},
    bpc: loadBpc(),
    hiddenKeys: saved.hiddenKeys || {},
    charsPerToken: run.model_chars_per_token || null,
    collapsed: saved.collapsed || {},
    expanded: null,   // chart object currently fullscreen, or null
    fsOverlay: null,
    sync: null,
    applyFollow: null,
    persist: null,
    notify: loadNotify() && "Notification" in window && Notification.permission === "granted",
  };
  state.persist = debounce(() => saveRunOpts(id, state), 300);

  // click on a chart (without dragging) pins its hover frame at that point
  // (with a marker line); clicking another point re-pins it; ✕ releases it.
  // shift-click pins the same data point on every open chart.
  state.onChartClick = chart => pinChart(state, chart, chart.lastIdx);
  state.onChartShiftClick = chart => {
    for (const c of state.charts) if (c.u) pinChart(state, c, chart.lastIdx);
  };

  // initial fetch: if we know the metric keys from a previous visit, fetch only
  // what the visible charts need; otherwise fetch everything to discover keys
  const initKeys = state.keys.length
    ? neededKeys(groupsFromKeys(state.keys), state.collapsed, null)
    : null;
  const added0 = mergeMetrics(state, await api(metricsUrl(id, initKeys)));
  if (added0) {
    // saved key list was stale (run has new metrics); refetch for visible charts
    mergeMetrics(state, await api(metricsUrl(id, stateNeededKeys(state))));
  }
  const elPoints0 = document.getElementById("stat-points");
  if (elPoints0) elPoints0.textContent = state.points.length;
  renderCharts(state);

  const notifyCb = document.getElementById("notify");
  if (notifyCb) notifyCb.addEventListener("change", async () => {
    if (notifyCb.checked && "Notification" in window) {
      if (Notification.permission === "default")
        await Notification.requestPermission();
      if (Notification.permission !== "granted") notifyCb.checked = false;
    } else if (notifyCb.checked) {
      notifyCb.checked = false;  // notifications unsupported here
    }
    state.notify = notifyCb.checked;
    saveNotify(state.notify);
  });

  const followCb = document.getElementById("follow");
  const followIn = document.getElementById("followwin");
  state.applyFollow = () => {
    if (!followCb.checked || !state.points.length) return;
    const sec = parsePeriod(followIn.value);
    followIn.classList.toggle("invalid", sec == null);
    if (sec == null) return;
    const maxT = state.xsTime[state.xsTime.length - 1];
    const minT = Math.max(state.xsTime[0], maxT - sec);
    if (state.xmode === "time") {
      setAllScales(state, minT, maxT);
    } else {
      // map the active-time window onto the iteration axis
      let lo = 0;
      while (lo < state.xsTime.length && state.xsTime[lo] < minT) lo++;
      setAllScales(state, state.xsIter[lo], state.xsIter[state.xsIter.length - 1]);
    }
  };
  followCb.addEventListener("change", () => { state.applyFollow(); state.persist(); });
  followIn.addEventListener("input", debounce(() => { state.applyFollow(); state.persist(); }, 200));

  // restore previous zoom; follow (if enabled) wins over the saved range
  if (saved.xmode === state.xmode && saved.xrange && saved.xrange.min != null) {
    setAllScales(state, saved.xrange.min, saved.xrange.max);
  }
  state.applyFollow();

  document.getElementById("xmode").addEventListener("change", e => {
    state.xmode = e.target.value;
    buildChartState(state);
    if (state.fsOverlay && state.expanded) {
      // rebuild only the fullscreen chart; the main view rebuilds on close
      const c = state.expanded;
      if (c.u) c.u.destroy();
      makeChart(state, c, state.sync);
      fitAll(state);
    } else {
      renderCharts(state);
    }
    state.applyFollow();
    state.persist();
  });
  document.getElementById("avgwin").addEventListener("input", debounce(e => {
    state.avgWin = Math.max(1, parseInt(e.target.value) || 1);
    updateSeries(state);
    state.persist();
  }, 150));
  document.getElementById("showraw").addEventListener("change", e => {
    state.showRaw = e.target.checked;
    const r = currentRange(state);
    renderCharts(state);
    if (r) setAllScales(state, r.min, r.max);
    state.persist();
  });
  document.getElementById("refreshsel").addEventListener("change", e => {
    setAutoRefresh(id, state, parseInt(e.target.value));
    state.persist();
  });
  document.getElementById("zin").addEventListener("click", () => { disableFollow(); zoomBy(state, 0.5); });
  document.getElementById("zout").addEventListener("click", () => { disableFollow(); zoomBy(state, 2); });
  document.getElementById("zfit").addEventListener("click", () => { disableFollow(); fitAll(state); });

  if (refresh) setAutoRefresh(id, state, refresh);
}

function currentRange(state) {
  const c = state.charts.find(c => c.u);
  if (!c) return null;
  const { min, max } = c.u.scales.x;
  return min == null ? null : { min, max };
}

function setAllScales(state, min, max) {
  for (const c of state.charts) if (c.u) c.u.setScale("x", { min, max });
  if (state.persist) state.persist();
}

function isCollapsed(state, name) {
  if (name in state.collapsed) return state.collapsed[name];
  return name !== "loss";  // only the loss chart starts expanded
}

function rerender(state) {
  const r = currentRange(state);
  renderCharts(state);
  if (r) setAllScales(state, r.min, r.max);
}

function disableFollow() {
  const cb = document.getElementById("follow");
  if (cb) cb.checked = false;
}

function zoomBy(state, factor) {
  const c = state.charts.find(c => c.u);
  if (!c) return;
  const { min, max } = c.u.scales.x;
  if (min == null || max == null) return;
  const center = (min + max) / 2;
  const half = ((max - min) * factor) / 2;
  setAllScales(state, center - half, center + half);
}

function fitAll(state) {
  const xs = state.xmode === "time" ? state.xsTime : state.xsIter;
  if (!xs.length) return;
  setAllScales(state, xs[0], xs[xs.length - 1]);
}

// "30s", "10m", "10min", "2h", "1d" -> seconds; null if unparseable
function parsePeriod(s) {
  const m = String(s || "").trim().match(/^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|d)$/i);
  if (!m) return null;
  const mult = { s: 1, sec: 1, m: 60, min: 60, h: 3600, hr: 3600, d: 86400 }[m[2].toLowerCase()];
  return parseFloat(m[1]) * mult;
}

// drag pans the view window instead of zooming
function panPlugin(state, chart) {
  let panning = false, startX = 0, startMin = 0, startMax = 0;
  return {
    hooks: {
      ready: u => {
        u.over.addEventListener("mouseenter", () => { chart.hovered = true; });
        u.over.addEventListener("mouseleave", () => {
          chart.hovered = false;
          updateHoverPanel(state, null, chart);
        });
        u.over.addEventListener("mousedown", e => {
          if (e.button !== 0) return;
          panning = true;
          startX = e.clientX;
          startMin = u.scales.x.min;
          startMax = u.scales.x.max;
          u.over.style.cursor = "grabbing";
          e.preventDefault();
        });
        document.addEventListener("mousemove", e => {
          if (!panning) return;
          const range = startMax - startMin;
          const shift = (-(e.clientX - startX) / u.bbox.width) * range;
          disableFollow();
          setAllScales(state, startMin + shift, startMax + shift);
        });
        document.addEventListener("mouseup", e => {
          // a press without movement is a click -> pin the hover frame(s)
          if (panning && Math.abs(e.clientX - startX) < 4) {
            if (e.shiftKey && state.onChartShiftClick) state.onChartShiftClick(chart);
            else if (state.onChartClick) state.onChartClick(chart);
          }
          panning = false;
          u.over.style.cursor = "";
        });
        u.over.addEventListener("dblclick", () => {
          disableFollow();
          fitAll(state);
        });
      },
    },
  };
}

function setAutoRefresh(runId, state, periodSec) {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  if (!periodSec) return;
  refreshTimer = setInterval(async () => {
    try {
      const [run, mdata] = await Promise.all([
        api(`/api/runs/${runId}`),
        api(metricsUrl(runId, stateNeededKeys(state))),
      ]);
      const prevStatus = state.run ? state.run.status : null;
      state.run = run;
      const added = mergeMetrics(state, mdata);
      // reflect status / counters in the header (and the fullscreen overlay)
      for (const badge of document.querySelectorAll(".run-head .badge, .fs-head .badge")) {
        if (badge.textContent !== run.status) {
          badge.textContent = run.status;
          badge.className = `badge ${run.status}`;
        }
      }
      const elPoints = document.getElementById("stat-points");
      if (elPoints) elPoints.textContent = state.points.length;
      const elPauses = document.getElementById("stat-pauses");
      if (elPauses) elPauses.textContent = run.pauses.length;
      const elPaused = document.getElementById("stat-paused");
      if (elPaused) {
        elPaused.textContent = fmtDur(run.pauses.reduce((s, p) => s + p.end_ts - p.start_ts, 0));
      }
      const elTrainTime = document.getElementById("stat-traintime");
      if (elTrainTime) elTrainTime.textContent = fmtDur(run.train_time || 0);
      const elTokens = document.getElementById("stat-tokens");
      if (elTokens && run.total_tokens) {
        elTokens.textContent = fmtTokens(run);
        const span = document.getElementById("stat-tokens-span");
        if (span) span.hidden = false;
      }
      if (added) {
        // new metric keys discovered via the `last` map; refetch so visible
        // charts get their series (collapsed ones keep showing last values)
        mergeMetrics(state, await api(metricsUrl(runId, stateNeededKeys(state))));
        if (!state.expanded) rerender(state);
        else updateSeries(state, true);
      } else {
        updateSeries(state, true);
      }
      if (state.applyFollow) state.applyFollow();
      if (run.status === "completed") {
        // running -> completed transition: notify if the user is elsewhere
        if (prevStatus && prevStatus !== "completed") maybeNotifyFinished(state);
        // final update done above; stop polling and grey out the refresh control
        // (follow stays enabled -- it's just a zoom shortcut to the last period)
        setAutoRefresh(runId, state, 0);
        const sel = document.getElementById("refreshsel");
        if (sel) { sel.value = "0"; sel.disabled = true; }
      }
    } catch (e) { /* transient */ }
  }, periodSec * 1000);
}

function collectKeys(points) {
  const keys = [];
  const seen = new Set();
  for (const p of points) {
    for (const k of Object.keys(p.metrics)) {
      if (!seen.has(k)) { seen.add(k); keys.push(k); }
    }
  }
  return keys;
}

// keys=null -> fetch all; keys=[] -> fetch no metric keys (context_size etc. still come along)
function metricsUrl(runId, keys) {
  const base = `/api/runs/${runId}/metrics`;
  return keys == null ? base : `${base}?keys=${keys.map(encodeURIComponent).join(",")}`;
}

function groupsFromKeys(keys) {
  const groups = [];
  const gmap = new Map();
  for (const k of keys) {
    if (k === "tokens_per_sec") continue;
    const g = groupBaseName(k);
    if (!gmap.has(g)) {
      gmap.set(g, { name: g, keys: [] });
      groups.push(gmap.get(g));
    }
    gmap.get(g).keys.push(k);
  }
  return groups;
}

// metric keys the currently visible charts need (tokens/sec is derived client-side)
function neededKeys(groups, collapsed, expandedName) {
  const out = [];
  for (const g of groups) {
    const isCollapsed = g.name in collapsed ? collapsed[g.name] : g.name !== "loss";
    if (expandedName ? g.name !== expandedName : isCollapsed) continue;
    for (const k of g.keys) if (k !== "tokens_per_sec") out.push(k);
  }
  return out;
}

function stateNeededKeys(state) {
  if (!state.keys.length) return null;  // keys unknown yet -> fetch all
  return neededKeys(state.groups, state.collapsed,
    state.expanded ? state.expanded.group.name : null);
}

// store fetched points, discover new metric keys, rebuild derived state
function mergeMetrics(state, data) {
  state.points = data.points;
  state.lastVals = data.last || {};
  const have = new Set(state.keys);
  let added = false;
  const note = k => { if (!have.has(k)) { have.add(k); added = true; } };
  Object.keys(state.lastVals).forEach(note);
  collectKeys(state.points).forEach(note);
  state.keys = [...have];
  buildChartState(state);
  return added;
}

// "group/name" -> shared "group" chart (e.g. grad_norm/layer0..19);
// train_loss / test_loss / val_loss -> shared "loss" chart;
// lr / lr2 / main_lr / learning_rate... -> shared "lr" chart
function groupBaseName(key) {
  const slash = key.indexOf("/");
  if (slash > 0) return key.slice(0, slash);
  const m = key.match(/^(?:train|test|val|eval|valid)_(.+)$/);
  if (m) return m[1];
  if (/(^|_)lr\d*$/.test(key) || /^lr(_|$)/.test(key) || key.includes("learning_rate")) {
    return "lr";
  }
  return key;
}

// active time: wall time minus pause gaps, relative to run start
function buildChartState(state) {
  const { run, points } = state;
  const pauses = run.pauses;
  const pausedBefore = ts => {
    let s = 0;
    for (const p of pauses) {
      if (p.end_ts <= ts) s += p.end_ts - p.start_ts;
      else if (p.start_ts < ts) s += ts - p.start_ts;
    }
    return s;
  };
  state.xsTime = points.map(p => p.ts - pausedBefore(p.ts) - run.started_at);
  state.xsIter = points.map(p => p.iteration);
  // active-time position where each pause began (for markers)
  state.pauseMarks = pauses.map(p => p.start_ts - pausedBefore(p.start_ts) - run.started_at);
  // series only for keys actually present in the (possibly filtered) points
  state.seriesByKey = {};
  for (const k of collectKeys(points)) {
    state.seriesByKey[k] = points.map(p => (k in p.metrics ? p.metrics[k] : null));
  }
  // chart groups: related metrics (train_loss + test_loss) share a chart.
  // state.keys is the union of all known keys (managed by mergeMetrics), so
  // collapsed charts keep their group even when their series wasn't fetched.
  state.groups = groupsFromKeys(state.keys);
  // derived performance series: tokens/sec = batches * context_size / active-dt
  const ctxDefault = run.model_context_width;
  const tps = new Array(points.length).fill(null);
  for (let i = 1; i < points.length; i++) {
    const ctx = points[i].context_size ?? ctxDefault;
    const dt = state.xsTime[i] - state.xsTime[i - 1];
    if (ctx && dt > 0) tps[i] = (points[i].batches * ctx) / dt;
  }
  if (!state.keys.includes("tokens_per_sec")) state.keys.push("tokens_per_sec");
  state.seriesByKey["tokens_per_sec"] = tps;
  state.groups.splice(Math.min(1, state.groups.length), 0,
    { name: "tokens/sec", keys: ["tokens_per_sec"] });
}

function keyLabel(k) {
  if (k === "tokens_per_sec") return "tokens/sec";
  const slash = k.indexOf("/");
  return slash > 0 ? k.slice(slash + 1) : k;  // "grad_norm/layer3" -> "layer3"
}

function movingAvg(ys, win) {
  if (win <= 1) return ys.slice();
  const out = new Array(ys.length).fill(null);
  const q = [];
  let sum = 0;
  for (let i = 0; i < ys.length; i++) {
    const v = ys[i];
    if (v == null) continue;
    q.push(v); sum += v;
    if (q.length > win) sum -= q.shift();
    out[i] = sum / q.length;
  }
  return out;
}

// bpc = loss / chars_per_token / ln(2); returns null when not applicable
function chartTransform(state, chart) {
  return chart.bpc && state.charsPerToken
    ? v => v / state.charsPerToken / Math.LN2
    : null;
}

function rawSeries(state, key) {
  return state.seriesByKey[key] || new Array(state.points.length).fill(null);
}

function chartData(state, chart) {
  const xs = state.xmode === "time" ? state.xsTime : state.xsIter;
  const f = chartTransform(state, chart);
  const data = [xs];
  for (const key of chart.group.keys) {
    let raw = rawSeries(state, key);
    if (f) raw = raw.map(v => (v == null ? null : f(v)));
    const avg = movingAvg(raw, state.avgWin);
    if (state.showRaw) data.push(raw);
    data.push(avg);
  }
  return data;
}

function chartLastHtml(state, chart) {
  const f = chartTransform(state, chart);
  return chart.group.keys.map(k => {
    const series = state.seriesByKey[k];
    let last = series ? series.filter(v => v != null).slice(-1)[0] : undefined;
    if (last == null) last = state.lastVals?.[k];  // series not fetched (collapsed chart)
    if (last != null && f) last = f(last);
    return `<span style="color:${keyColor(state, k)}">${esc(keyLabel(k))}</span>: ${fmtVal(k, last)}`;
  }).join(" · ");
}

function updateSeries(state, keepRange) {
  for (const c of state.charts) {
    const lastEl = c.body.parentElement.querySelector(".chart-last");
    if (lastEl) lastEl.innerHTML = chartLastHtml(state, c);
    if (!c.u) continue;                          // collapsed: header values only
    if (state.expanded && c !== state.expanded) continue;  // fullscreen: update only it
    const range = keepRange ? { min: c.u.scales.x.min, max: c.u.scales.x.max } : null;
    c.u.setData(chartData(state, c), false);
    if (range && range.min != null) c.u.setScale("x", range);
  }
}

function renderCharts(state) {
  for (const c of state.charts) if (c.u) c.u.destroy();
  state.charts = [];
  const container = document.getElementById("charts");
  container.innerHTML = "";
  const sync = uPlot.sync("run-charts");
  state.sync = sync;

  state.groups.forEach(group => {
    const title = group.keys.length === 1 ? keyLabel(group.keys[0]) : group.name;
    const collapsed = isCollapsed(state, group.name);
    const logY = !!state.logY[group.name];
    const isLoss = group.name === "loss" || /loss/i.test(group.name);
    const showBpc = isLoss && !!state.charsPerToken;
    const bpc = !!state.bpc[group.name];
    const panel = document.createElement("div");
    panel.className = "chart-panel" + (collapsed ? " collapsed" : "");
    panel.innerHTML = `
      <div class="chart-head">
        <button data-collapse title="${collapsed ? "expand" : "collapse"}">${collapsed ? "▸" : "▾"}</button>
        <span class="chart-name">${esc(title)}</span>
        <span class="chart-last"></span>
        <span style="flex:1"></span>
        ${showBpc ? `<button data-bpc class="${bpc ? "active" : ""}" title="bits per character">bpc</button>` : ""}
        <button data-log class="${logY ? "active" : ""}">log y</button>
        <button data-expand title="fullscreen">⤢</button>
      </div>
      <div class="chart-body"${collapsed ? ' style="display:none"' : ""}></div>`;
    container.appendChild(panel);

    const chart = { group, logY, bpc, u: null, body: panel.querySelector(".chart-body"), panel };
    panel.querySelector(".chart-last").innerHTML = chartLastHtml(state, chart);

    const bpcBtn = panel.querySelector("[data-bpc]");
    if (bpcBtn) bpcBtn.addEventListener("click", e => {
      chart.bpc = !chart.bpc;
      state.bpc[group.name] = chart.bpc;
      saveBpc(state.bpc);  // bpc preference is global across runs
      e.target.classList.toggle("active", chart.bpc);
      if (chart.u) {
        const xrange = { min: chart.u.scales.x.min, max: chart.u.scales.x.max };
        chart.u.destroy();
        makeChart(state, chart, sync);
        if (xrange.min != null) chart.u.setScale("x", xrange);
      }
      panel.querySelector(".chart-last").innerHTML = chartLastHtml(state, chart);
      if (state.persist) state.persist();
    });

    panel.querySelector("[data-collapse]").addEventListener("click", async e => {
      const nowCollapsed = !isCollapsed(state, group.name);
      state.collapsed[group.name] = nowCollapsed;
      state.persist();
      e.target.textContent = nowCollapsed ? "▸" : "▾";
      e.target.title = nowCollapsed ? "expand" : "collapse";
      panel.classList.toggle("collapsed", nowCollapsed);
      if (nowCollapsed) {
        // only this chart is torn down; other charts keep pins/zoom untouched
        if (chart.u) { chart.u.destroy(); chart.u = null; }
        chart.body.style.display = "none";
      } else {
        // expanding: this chart's series may not have been fetched yet
        mergeMetrics(state, await api(metricsUrl(state.runId, stateNeededKeys(state))));
        chart.body.style.display = "";
        const r = currentRange(state);  // align with the other open charts
        makeChart(state, chart, state.sync);
        if (r) chart.u.setScale("x", r);
        else state.applyFollow && state.applyFollow();
      }
    });
    panel.querySelector("[data-expand]").addEventListener("click", () => {
      openFullscreen(state, chart);
    });
    panel.querySelector("[data-log]").addEventListener("click", e => {
      chart.logY = !chart.logY;
      state.logY[group.name] = chart.logY;
      e.target.classList.toggle("active", chart.logY);
      if (chart.u) {
        const xrange = { min: chart.u.scales.x.min, max: chart.u.scales.x.max };
        chart.u.destroy();
        makeChart(state, chart, sync);
        if (xrange.min != null) chart.u.setScale("x", xrange);
      }
      if (state.persist) state.persist();
    });

    if (!collapsed) makeChart(state, chart, sync);
    state.charts.push(chart);
  });

  resizeHandler = () => {
    for (const c of state.charts) {
      if (c.u) c.u.setSize({ width: c.body.clientWidth, height: chartHeight(c) });
    }
  };
  window.addEventListener("resize", resizeHandler);
}

function chartHeight(chart) {
  // fullscreen: leave room for the uPlot legend row below the plot
  return chart.body.classList.contains("fs-body")
    ? Math.max(300, chart.body.clientHeight - 36)
    : 260;
}

async function openFullscreen(state, chart) {
  if (state.fsOverlay) return;
  // a collapsed chart's series may not have been fetched yet
  const missing = chart.group.keys.some(k => k !== "tokens_per_sec" && !state.seriesByKey[k]);
  if (missing) {
    mergeMetrics(state, await api(metricsUrl(state.runId,
      neededKeys(state.groups, state.collapsed, chart.group.name))));
  }
  const title = chart.group.keys.length === 1 ? keyLabel(chart.group.keys[0]) : chart.group.name;
  const overlay = document.createElement("div");
  overlay.className = "fs-overlay";
  overlay.innerHTML = `
    <div class="fs-head">
      <span class="chart-name">${esc(title)}</span>
      <span class="badge ${state.run.status}">${state.run.status}</span>
      <span class="chart-last"></span>
      <span style="flex:1"></span>
      <button data-log class="${chart.logY ? "active" : ""}">log y</button>
      <button data-close title="close (Esc)">✕</button>
    </div>
    <div class="fs-controls"></div>
    <div class="fs-body"></div>`;
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";
  state.expanded = chart;
  state.fsOverlay = overlay;

  // move the main control bar (x-mode, avg, refresh, follow, zoom) into the overlay
  const controls = document.querySelector(".chart-controls");
  if (controls) {
    state.fsPlaceholder = document.createComment("chart-controls");
    controls.parentNode.insertBefore(state.fsPlaceholder, controls);
    overlay.querySelector(".fs-controls").appendChild(controls);
  }
  // ...and the hover details panel, so hover info is visible in fullscreen too
  const hover = document.getElementById("hoverpanel");
  if (hover) {
    state.fsHoverPlaceholder = document.createComment("hoverpanel");
    hover.parentNode.insertBefore(state.fsHoverPlaceholder, hover);
    overlay.querySelector(".fs-controls").appendChild(hover);
  }

  // preserve the current view: follow mode wins, otherwise keep the zoom range
  const prevRange = currentRange(state);
  const followOn = document.getElementById("follow")?.checked;

  if (chart.u) chart.u.destroy();
  chart.u = null;
  chart.body = overlay.querySelector(".fs-body");
  makeChart(state, chart, state.sync);
  overlay.querySelector(".chart-last").innerHTML = chartLastHtml(state, chart);
  if (followOn && state.applyFollow) state.applyFollow();
  else if (prevRange) chart.u.setScale("x", prevRange);

  overlay.querySelector("[data-log]").addEventListener("click", e => {
    chart.logY = !chart.logY;
    state.logY[chart.group.name] = chart.logY;
    e.target.classList.toggle("active", chart.logY);
    const r = { min: chart.u.scales.x.min, max: chart.u.scales.x.max };
    chart.u.destroy();
    makeChart(state, chart, state.sync);
    if (r.min != null) chart.u.setScale("x", r);
    state.persist();
  });
  overlay.querySelector("[data-close]").addEventListener("click", () => closeFullscreen(state));
  state.fsKeyHandler = e => { if (e.key === "Escape") closeFullscreen(state); };
  document.addEventListener("keydown", state.fsKeyHandler);
}

async function closeFullscreen(state) {
  if (!state.fsOverlay) return;
  document.removeEventListener("keydown", state.fsKeyHandler);
  // restore the control bar to its original spot in the page
  const controls = state.fsOverlay.querySelector(".chart-controls");
  if (controls && state.fsPlaceholder && state.fsPlaceholder.parentNode) {
    state.fsPlaceholder.parentNode.insertBefore(controls, state.fsPlaceholder);
    state.fsPlaceholder.remove();
  }
  const hover = state.fsOverlay.querySelector("#hoverpanel");
  if (hover && state.fsHoverPlaceholder && state.fsHoverPlaceholder.parentNode) {
    state.fsHoverPlaceholder.parentNode.insertBefore(hover, state.fsHoverPlaceholder);
    state.fsHoverPlaceholder.remove();
  }
  state.fsHoverPlaceholder = null;
  state.fsPlaceholder = null;
  state.fsOverlay.remove();
  state.fsOverlay = null;
  state.expanded = null;
  document.body.style.overflow = "";
  // ticks fetched only the fullscreen chart's keys; refetch for all visible charts
  mergeMetrics(state, await api(metricsUrl(state.runId, stateNeededKeys(state))));
  rerender(state);
}

function keyColor(state, key) {
  return CHART_COLORS[state.keys.indexOf(key) % CHART_COLORS.length];
}

function makeChart(state, chart, sync) {
  const isTime = state.xmode === "time";
  const data = chartData(state, chart);
  const allVals = chart.group.keys.flatMap(k => rawSeries(state, k));
  const allPositive = allVals.every(v => v == null || v > 0);

  const yFmt = chart.group.keys.includes("tokens_per_sec") ? fmtRate : fmtNum;
  const series = [{ label: isTime ? "active time" : "iteration" }];
  for (const key of chart.group.keys) {
    const color = keyColor(state, key);
    // sparse metrics (e.g. test_loss) interpolate across gaps and show points
    const raw = rawSeries(state, key);
    const sparse = raw.length === 0 || raw.some(v => v == null);
    if (state.showRaw) {
      series.push({
        label: keyLabel(key), stroke: color, width: 1,
        alpha: sparse ? 1 : 0.35,
        spanGaps: sparse,
        points: { show: sparse, size: 6 },
        value: (u, v) => fmtVal(key, v),
      });
    }
    series.push({
      label: state.showRaw && state.avgWin > 1 ? `${keyLabel(key)} avg` : keyLabel(key),
      stroke: color, width: state.showRaw ? 2 : 1.5,
      spanGaps: sparse,
      points: { show: !state.showRaw && sparse, size: 6 },
      value: (u, v) => fmtVal(key, v),
    });
  }

  const opts = {
    width: chart.body.clientWidth || 900,
    height: chartHeight(chart),
    plugins: [panPlugin(state, chart)],
    cursor: { sync: { key: sync.key, setSeries: false }, drag: { x: false, y: false } },
    scales: { x: { time: false }, y: { distr: chart.logY && allPositive ? 3 : 1 } },
    axes: [
      {
        stroke: "#9aa3b2",
        grid: { stroke: "rgba(255,255,255,0.06)", width: 1 },
        ticks: { stroke: "rgba(255,255,255,0.15)" },
        values: isTime ? (u, splits) => splits.map(fmtDur) : null,
      },
      {
        stroke: "#9aa3b2",
        grid: { stroke: "rgba(255,255,255,0.06)", width: 1 },
        ticks: { stroke: "rgba(255,255,255,0.15)" },
        values: (u, splits) => splits.map(yFmt),
        size: 80,
      },
    ],
    series,
    legend: { show: true },
    hooks: {
      setCursor: [u => {
        chart.lastIdx = u.cursor.idx;
        if (!chart.hovered) return;  // cursor synced from another chart
        updateHoverPanel(state, u.cursor.idx, chart);
      }],
      drawAxes: [u => drawPauseMarks(state, u)],
      draw: [u => drawPinnedMark(state, chart, u)],
    },
  };

  chart.u = new uPlot(opts, data, chart.body);

  // per-chart sticky hover frame (top-right inside the chart)
  let float = chart.body.querySelector(":scope > .chart-float");
  if (!float) {
    float = document.createElement("div");
    float.className = "chart-float";
    float.style.display = "none";
    float.addEventListener("click", e => {
      if (!e.target.closest(".hf-close")) return;
      unpinChart(chart);
    });
    chart.body.appendChild(float);
  }
  chart.float = float;
  chart.floatFrozen = false;
  chart.pinnedIdx = null;

  bindLegendToggles(state, chart);

  const lastEl = chart.body.parentElement.querySelector(".chart-last");
  if (lastEl) lastEl.innerHTML = chartLastHtml(state, chart);
}

// series index of key position j within the chart (series[0] is the x axis)
function keySeriesIdxs(state, j) {
  return state.showRaw ? [1 + j * 2, 2 + j * 2] : [1 + j];
}

function applyHiddenKeys(state, chart) {
  if (!chart.u) return;
  const hidden = new Set(state.hiddenKeys[chart.group.name] || []);
  chart.group.keys.forEach((k, j) => {
    const show = !hidden.has(k);
    for (const i of keySeriesIdxs(state, j)) chart.u.setSeries(i, { show });
  });
}

function setKeyHidden(state, chart, key, hide) {
  const name = chart.group.name;
  const list = new Set(state.hiddenKeys[name] || []);
  if (hide) list.add(key); else list.delete(key);
  state.hiddenKeys[name] = [...list];
  applyHiddenKeys(state, chart);
  if (state.persist) state.persist();
}

// legend click hides/shows a metric (raw+avg pair); double-click isolates it
function bindLegendToggles(state, chart) {
  applyHiddenKeys(state, chart);
  const rows = chart.u.root.querySelectorAll(".u-legend tr.u-series");
  rows.forEach((tr, i) => {
    const keyPos = state.showRaw ? Math.floor(i / 2) : i;
    const key = chart.group.keys[keyPos];
    if (!key) return;
    tr.style.cursor = "pointer";
    tr.title = "click to hide/show · double-click to isolate";
    tr.addEventListener("click", e => {
      e.preventDefault();
      const hidden = new Set(state.hiddenKeys[chart.group.name] || []);
      setKeyHidden(state, chart, key, !hidden.has(key));
    });
    tr.addEventListener("dblclick", e => {
      e.preventDefault();
      const name = chart.group.name;
      const hidden = new Set(state.hiddenKeys[name] || []);
      const others = chart.group.keys.filter(k => k !== key);
      const alreadyIsolated = others.every(k => hidden.has(k)) && !hidden.has(key);
      state.hiddenKeys[name] = alreadyIsolated ? [] : others;
      applyHiddenKeys(state, chart);
      if (state.persist) state.persist();
    });
  });
}

function drawPauseMarks(state, u) {
  if (state.xmode !== "time" || !state.pauseMarks.length) return;
  const { min, max } = u.scales.x;
  const ctx = u.ctx;
  ctx.save();
  ctx.strokeStyle = "rgba(247,178,79,0.45)";
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  for (const mark of state.pauseMarks) {
    if (mark < min || mark > max) continue;
    const x = u.valToPos(mark, "x", true);
    ctx.beginPath();
    ctx.moveTo(x, u.bbox.top);
    ctx.lineTo(x, u.bbox.top + u.bbox.height);
    ctx.stroke();
  }
  ctx.restore();
}

// linear interpolation of a sparse series at an index between measured points
function interpAt(xs, ys, idx) {
  let i = idx - 1;
  while (i >= 0 && ys[i] == null) i--;
  let j = idx + 1;
  while (j < ys.length && ys[j] == null) j++;
  if (i < 0 || j >= ys.length) return null;
  const dx = xs[j] - xs[i];
  if (dx <= 0) return ys[i];
  return ys[i] + (ys[j] - ys[i]) * ((xs[idx] - xs[i]) / dx);
}

function hoverItemsHtml(state, idx, chart) {
  const p = state.points[idx];
  const xs = state.xmode === "time" ? state.xsTime : state.xsIter;
  const x = state.xmode === "time" ? fmtDur(state.xsTime[idx]) : `iter ${state.xsIter[idx]}`;
  let html = `
    <span class="hp-item">x <b>${x}</b></span>
    <span class="hp-item">iter <b>${p.iteration}</b></span>
    <span class="hp-item">batches <b>${p.batches}</b></span>`;
  const f = chartTransform(state, chart);
  for (const k of chart.group.keys) {  // only the hovered chart's series
    const ys = state.seriesByKey[k];
    if (!ys) continue;
    let v = ys[idx], est = false;
    if (v == null) {  // sparse series: show a linear estimate, marked with ~
      v = interpAt(xs, ys, idx);
      est = v != null;
    }
    if (v == null) continue;
    if (f) v = f(v);
    html += `<span class="hp-item"><span class="hp-swatch"
      style="background:${keyColor(state, k)}"></span>${esc(keyLabel(k))} <b>${est ? "~" : ""}${fmtVal(k, v)}</b></span>`;
  }
  return html;
}

function pinChart(state, chart, idx) {
  if (idx == null || idx < 0 || idx >= state.points.length) return;
  chart.pinnedIdx = idx;
  chart.floatFrozen = true;
  const float = chart.float;
  if (float) {
    float.innerHTML = hoverItemsHtml(state, idx, chart);
    float.style.display = "";
    float.classList.add("frozen");
    if (!float.querySelector(".hf-close")) {
      const b = document.createElement("button");
      b.className = "hf-close";
      b.title = "unpin";
      b.textContent = "✕";
      float.prepend(b);
    }
  }
  if (chart.u) chart.u.redraw();
}

function unpinChart(chart) {
  chart.floatFrozen = false;
  chart.pinnedIdx = null;
  if (chart.float) {
    chart.float.classList.remove("frozen");
    chart.float.style.display = "none";
  }
  if (chart.u) chart.u.redraw();
}

// solid vertical marker at the pinned point (distinct from the hover cursor)
function drawPinnedMark(state, chart, u) {
  if (chart.pinnedIdx == null) return;
  const xs = state.xmode === "time" ? state.xsTime : state.xsIter;
  const xVal = xs[chart.pinnedIdx];
  if (xVal == null) return;
  const { min, max } = u.scales.x;
  if (xVal < min || xVal > max) return;
  const x = u.valToPos(xVal, "x", true);
  const ctx = u.ctx;
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.65)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, u.bbox.top);
  ctx.lineTo(x, u.bbox.top + u.bbox.height);
  ctx.stroke();
  ctx.restore();
}

function updateHoverPanel(state, idx, chart) {
  const valid = idx != null && idx >= 0 && idx < state.points.length;
  const items = valid ? hoverItemsHtml(state, idx, chart) : null;
  const panel = document.getElementById("hoverpanel");
  if (panel) {
    panel.innerHTML = items || `<span class="hp-item">hover a chart for details</span>`;
  }
  if (chart && chart.float && !chart.floatFrozen) {
    if (items) {
      chart.float.innerHTML = items;
      chart.float.style.display = "";
    } else {
      chart.float.style.display = "none";
    }
  }
}

// ---------- router ----------

function parseHash() {
  const hash = location.hash.slice(2) || "";
  const [pathPart, queryPart] = hash.split("?");
  const segs = pathPart.split("/").filter(Boolean).map(decodeURIComponent);
  const params = Object.fromEntries(new URLSearchParams(queryPart || ""));
  for (const k of ["date_from", "date_to"]) {
    if (params[k]) params[k] = parseFloat(params[k]);
  }
  return { segs, params };
}

async function route() {
  cleanup();
  if (authConfig.auth_enabled && !getToken()) { showLogin(); return; }
  const { segs, params } = parseHash();
  app.innerHTML = `<div class="loading">loading…</div>`;
  try {
    if (segs.length === 0) await viewLanding();
    else if (segs[0] === "models" && segs.length === 1) await viewModels(params.q || "");
    else if (segs[0] === "models") await viewModelDetail(segs[1], params);
    else if (segs[0] === "runs" && segs.length === 1) await viewAllRuns(params);
    else if (segs[0] === "runs") await viewRunDetail(parseInt(segs[1]));
    else app.innerHTML = `<div class="empty">unknown page</div>`;
  } catch (e) {
    if (e instanceof AuthError) return;  // login view already shown
    app.innerHTML = `<div class="empty">error: ${esc(e.message)}</div>`;
  }
}

async function boot() {
  try {
    authConfig = await api("/api/config");
  } catch { /* auth disabled or server unreachable */ }
  route();
}

window.addEventListener("hashchange", route);
boot();
