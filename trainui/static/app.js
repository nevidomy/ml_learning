/* trainui frontend: hash-routed SPA + uPlot charts */
"use strict";

const app = document.getElementById("app");
let refreshTimer = null;
let resizeHandler = null;

// ---------- auth (invite-only email/password) ----------

let authConfig = { auth_enabled: false };
const getToken = () => localStorage.getItem("trainui:token") || "";
const setToken = t => t
  ? localStorage.setItem("trainui:token", t)
  : localStorage.removeItem("trainui:token");

class AuthError extends Error {}

function showLogin(message = "") {
  cleanup();
  renderAuthBox();
  app.innerHTML = `
    <div class="login-box">
      <h2>Sign in to trainui</h2>
      <p class="login-hint">Access is restricted to invited users.</p>
      <form id="login-form">
        <input type="email" id="login-email" placeholder="email"
               autocomplete="email" required>
        <input type="password" id="login-pw" placeholder="password"
               autocomplete="current-password" required>
        <button type="submit" class="btn primary">sign in</button>
      </form>
      <p class="login-err">${esc(message)}</p>
      <p class="login-hint">No account? <a href="#" id="to-signup">request an invite</a></p>
    </div>`;
  document.getElementById("login-form").addEventListener("submit", async e => {
    e.preventDefault();
    const err = app.querySelector(".login-err");
    err.textContent = "";
    try {
      const resp = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: document.getElementById("login-email").value,
          password: document.getElementById("login-pw").value,
        }),
      });
      if (!resp.ok) throw new Error((await resp.json()).detail || resp.status);
      setToken((await resp.json()).token);
      route();
    } catch (ex) { err.textContent = String(ex.message || ex); }
  });
  document.getElementById("to-signup").addEventListener("click", e => {
    e.preventDefault();
    showSignup();
  });
}

function showSignup(sent = false, message = "") {
  cleanup();
  app.innerHTML = `
    <div class="login-box">
      <h2>Request an invite</h2>
      <p class="login-hint">Sign-up is invite-only: if your email is on the
        allowlist you'll get a password-setup link.</p>
      ${sent
        ? `<p class="login-ok">If that email is allowed, an invite is on its way —
            check your inbox (or the server log if SMTP isn't configured).</p>`
        : `<form id="signup-form">
             <input type="email" id="signup-email" placeholder="email"
                    autocomplete="email" required>
             <button type="submit" class="btn primary">send invite</button>
           </form>`}
      <p class="login-err">${esc(message)}</p>
      <p class="login-hint"><a href="#" id="to-login">back to sign in</a></p>
    </div>`;
  if (!sent) {
    document.getElementById("signup-form").addEventListener("submit", async e => {
      e.preventDefault();
      try {
        const resp = await fetch("/api/auth/signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: document.getElementById("signup-email").value,
          }),
        });
        if (!resp.ok) throw new Error((await resp.json()).detail || resp.status);
        showSignup(true);
      } catch (ex) { showSignup(false, String(ex.message || ex)); }
    });
  }
  document.getElementById("to-login").addEventListener("click", e => {
    e.preventDefault();
    showLogin();
  });
}

// landing page for emailed invite links: #/setpw/<token>
async function viewSetPw(token) {
  cleanup();
  let email = null;
  try {
    email = (await api(`/api/auth/invite/${encodeURIComponent(token)}`)).email;
  } catch { /* shown as invalid below */ }
  app.innerHTML = `
    <div class="login-box">
      <h2>Set your password</h2>
      ${email === null
        ? `<p class="login-err">This invite link is expired or was already used —
           request a new one.</p>`
        : `<p class="login-hint">for <b>${esc(email)}</b></p>
           <form id="setpw-form">
             <input type="password" id="pw1" placeholder="password (8+ chars)"
                    autocomplete="new-password" required minlength="8">
             <input type="password" id="pw2" placeholder="repeat password"
                    autocomplete="new-password" required minlength="8">
             <button type="submit" class="btn primary">set password</button>
           </form>`}
      <p class="login-err"></p>
      <p class="login-hint"><a href="#" id="to-login">back to sign in</a></p>
    </div>`;
  if (email !== null) {
    document.getElementById("setpw-form").addEventListener("submit", async e => {
      e.preventDefault();
      const err = app.querySelector(".login-err");
      err.textContent = "";
      try {
        const resp = await fetch(`/api/auth/invite/${encodeURIComponent(token)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            password: document.getElementById("pw1").value,
            password2: document.getElementById("pw2").value,
          }),
        });
        if (!resp.ok) throw new Error((await resp.json()).detail || resp.status);
        setToken((await resp.json()).token);
        location.hash = "#/";
        route();
      } catch (ex) { err.textContent = String(ex.message || ex); }
    });
  }
  document.getElementById("to-login").addEventListener("click", e => {
    e.preventDefault();
    location.hash = "#/";
    showLogin();
  });
}

// "sign out" control in the topbar when auth is on
function renderAuthBox() {
  const box = document.getElementById("authbox");
  if (!box) return;
  if (authConfig.auth_enabled && getToken()) {
    box.innerHTML = `<a href="#" id="logout-link">sign out</a>`;
    document.getElementById("logout-link").addEventListener("click", async e => {
      e.preventDefault();
      const token = getToken();
      setToken("");
      try {
        await fetch("/api/auth/logout", {
          method: "POST",
          headers: { "Authorization": `Bearer ${token}` },
        });
      } catch { /* session drop is best-effort */ }
      showLogin();
    });
  } else {
    box.innerHTML = "";
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
      showLogin(hadToken ? "Session expired — sign in again." : "");
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

function favBtn(kind, id, fav) {
  return `<button class="pin-btn ${fav ? "pinned" : ""}" data-fav-kind="${kind}"
    data-fav-id="${esc(id)}" data-fav="${fav ? 1 : 0}"
    title="${fav ? "remove from favorites" : "add to favorites"}">${fav ? "★" : "☆"}</button>`;
}

function pinBtn(kind, id, pinned) {
  return `<button class="pin-btn pin-ico ${pinned ? "pinned" : ""}" data-pin-kind="${kind}"
    data-pin-id="${esc(id)}" data-pinned="${pinned ? 1 : 0}"
    title="${pinned ? "unpin" : "pin (highlight)"}">📌</button>`;
}

// "favorites only" filter toggle; the state is global across list pages and
// persists in localStorage
function loadFavFilter() {
  try { return localStorage.getItem("trainui.favfilter") === "1"; } catch { return false; }
}

function saveFavFilter(on) {
  try { localStorage.setItem("trainui.favfilter", on ? "1" : "0"); } catch { }
}

function favFilterHtml(on) {
  return `<a class="fav-filter ${on ? "on" : ""}" id="favfilter"
    title="show only favorites">★ favorites</a>`;
}

function delBtn(kind, id, parent) {
  return `<button class="del-btn" data-del-kind="${kind}" data-del-id="${esc(id)}"
    ${parent ? `data-del-parent="${esc(parent)}"` : ""}
    title="delete">✕</button>`;
}

// re-render after pin/favorite clicks without losing the scroll position
async function rerenderKeepScroll() {
  const y = window.scrollY;
  await route();
  window.scrollTo(0, y);
}

// event delegation for pin buttons
document.addEventListener("click", async e => {
  const btn = e.target.closest("[data-pin-kind]");
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
  rerenderKeepScroll();
});

// event delegation for favorite (star) buttons
document.addEventListener("click", async e => {
  const btn = e.target.closest("[data-fav-kind]");
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const kind = btn.dataset.favKind, id = btn.dataset.favId;
  const fav = btn.dataset.fav !== "1";
  const path = kind === "model"
    ? `/api/models/${encodeURIComponent(id)}/favorite`
    : `/api/runs/${id}/favorite`;
  await api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pinned: fav }),
  });
  rerenderKeepScroll();
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
  const skip =
    !state.notify ? "preference off" :
    !("Notification" in window) ? "Notification API unavailable (page must be on https or localhost)" :
    Notification.permission !== "granted" ? `permission=${Notification.permission}` :
    (!document.hidden && document.hasFocus()) ? "page is focused (by design)" :
    null;
  if (skip) { console.log(`trainui: notification skipped — ${skip}`); return; }
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
  n.onerror = e => console.warn("trainui: notification error", e);
  n.onshow = () => console.log("trainui: notification shown");
  console.log("trainui: notification requested");
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
  return `<a class="card ${m.pinned ? "pinned" : ""}" href="#/models/${encodeURIComponent(m.id)}">
    <div class="card-title">${favBtn("model", m.id, m.favorite)}${pinBtn("model", m.id, m.pinned)} ${esc(m.id)}
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
  return `<a class="row ${r.status === "running" ? "running" : ""} ${r.pinned ? "pinned" : ""}" href="#/runs/${r.id}">
    <input type="checkbox" class="cmp-box" data-cmp="${r.id}"
      title="select for comparison" ${getCompareSel().includes(r.id) ? "checked" : ""}>
    ${favBtn("run", r.id, r.favorite)}${pinBtn("run", r.id, r.pinned)}
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

// ---------- run comparison selection ----------

function getCompareSel() {
  try { return JSON.parse(localStorage.getItem("trainui.compare")) || []; }
  catch { return []; }
}

function setCompareSel(ids) {
  try { localStorage.setItem("trainui.compare", JSON.stringify(ids)); } catch { }
}

// fixed bottom bar with the current selection; shown on every page
function updateCompareBar() {
  let bar = document.getElementById("cmpbar");
  const sel = getCompareSel();
  if (!sel.length || location.hash.startsWith("#/compare")) {
    if (bar) bar.remove();
    document.body.style.paddingBottom = "";
    return;
  }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "cmpbar";
    bar.className = "cmp-bar";
    document.body.appendChild(bar);
  }
  bar.innerHTML = `<span>${sel.length} run${sel.length > 1 ? "s" : ""} selected</span>
    <button id="cmpgo" ${sel.length < 2 ? "disabled" : ""}>compare →</button>
    <button id="cmpclear">clear</button>`;
  document.body.style.paddingBottom = "56px";
  document.getElementById("cmpgo").addEventListener("click", () => {
    if (sel.length >= 2) location.hash = `#/compare?ids=${sel.join(",")}`;
  });
  document.getElementById("cmpclear").addEventListener("click", () => {
    setCompareSel([]);
    document.querySelectorAll(".cmp-box").forEach(b => b.checked = false);
    updateCompareBar();
  });
}

// checkbox inside a row link: preventDefault stops the navigation, but a
// canceled click also makes the browser restore the pre-click checked state
// AFTER dispatch -- so read the toggled value now and re-apply it afterwards
document.addEventListener("click", e => {
  const box = e.target.closest(".cmp-box");
  if (!box) return;
  const on = box.checked;  // browser has already toggled it
  e.preventDefault();
  e.stopPropagation();
  const id = +box.dataset.cmp;
  const sel = getCompareSel().filter(x => x !== id);
  if (on) sel.push(id);
  setCompareSel(sel);
  setTimeout(() => { box.checked = on; }, 0);
  updateCompareBar();
});

// ---------- views ----------

async function viewLanding() {
  const fav = loadFavFilter();
  const models = (await api(`/api/models?limit=6${fav ? "&fav=1" : ""}`)).items;
  const { data: runsData, size, page } = await fetchPage("home-runs", "/api/runs",
    fav ? { fav: 1 } : {});
  const recentRuns = runsData.items;
  app.innerHTML = `
    <h1>Overview</h1>
    <div class="toolbar">
      ${favFilterHtml(fav)}
      <span style="flex:1"></span>
      <a href="#/models">all models →</a>&nbsp;&nbsp;<a href="#/runs">all runs →</a>
    </div>
    <h2>${fav ? "Favorite" : "Recent"} models</h2>
    ${models.length ? `<div class="card-grid">${models.map(modelCard).join("")}</div>` : `<div class="empty">no models yet</div>`}
    <div class="toolbar" style="justify-content:space-between">
      <h2 style="margin:0">${fav ? "Favorite" : "Recent"} runs</h2>${pagerTopHtml(size)}
    </div>
    ${recentRuns.length ? `<div class="rows">${recentRuns.map(r => runRow(r, true)).join("")}</div>` : `<div class="empty">no runs yet</div>`}
    ${pagerBottomHtml(page, size, runsData.total)}`;
  bindPager("home-runs", viewLanding);
  document.getElementById("favfilter").addEventListener("click", () => {
    saveFavFilter(!fav);
    resetPage("home-runs");
    viewLanding();
  });
}

async function viewModels(q = "", fav = loadFavFilter()) {
  const { data, size, page } = await fetchPage("models", "/api/models",
    { q, fav: fav ? 1 : null });
  const models = data.items;
  app.innerHTML = `
    <h1>Models</h1>
    <div class="toolbar"><input type="search" id="q" placeholder="search by id or description…"
      value="${esc(q)}" style="flex:1;max-width:420px">
      ${favFilterHtml(fav)}${pagerTopHtml(size)}</div>
    ${models.length ? `<div class="card-grid">${models.map(modelCard).join("")}</div>`
                    : `<div class="empty">no models match</div>`}
    ${pagerBottomHtml(page, size, data.total)}`;
  bindPager("models", () => viewModels(q, fav));
  document.getElementById("favfilter").addEventListener("click", () => {
    saveFavFilter(!fav);
    resetPage("models");
    viewModels(q, !fav);
  });
  const input = document.getElementById("q");
  input.addEventListener("input", debounce(() => {
    history.replaceState(null, "", `#/models?q=${encodeURIComponent(input.value)}`);
    resetPage("models");
    viewModels(input.value, fav).then(() => {
      const el = document.getElementById("q");
      el.focus(); el.setSelectionRange(el.value.length, el.value.length);
    });
  }, 250));
}

async function viewAllRuns(params = {}) {
  params = { ...params, fav: loadFavFilter() ? 1 : null };
  const { data, size, page } = await fetchPage("runs", "/api/runs", params);
  const runs = data.items;
  app.innerHTML = `
    <h1>Runs</h1>
    ${runsToolbar(params, size)}
    ${runs.length ? `<div class="rows">${runs.map(r => runRow(r, true)).join("")}</div>`
                  : `<div class="empty">no runs match</div>`}
    ${pagerBottomHtml(page, size, data.total)}`;
  bindPager("runs", () => viewAllRuns(params));
  bindRunsToolbar("runs", params, p => viewAllRuns(p));
}

function runsToolbar(params, size) {
  const toLocal = ts => ts ? new Date(ts * 1000).toISOString().slice(0, 16) : "";
  return `<div class="toolbar">
    <input type="search" id="q" placeholder="search run id / model…" value="${esc(params.q || "")}">
    <label style="color:var(--text-dim);font-size:13px">from
      <input type="datetime-local" id="from" value="${toLocal(params.date_from)}"></label>
    <label style="color:var(--text-dim);font-size:13px">to
      <input type="datetime-local" id="to" value="${toLocal(params.date_to)}"></label>
    ${favFilterHtml(!!params.fav)}
    ${pagerTopHtml(size)}
  </div>`;
}

function bindRunsToolbar(viewKey, params, render) {
  const q = document.getElementById("q");
  const from = document.getElementById("from");
  const to = document.getElementById("to");
  const go = () => {
    resetPage(viewKey);
    render({
      q: q.value,
      date_from: from.value ? new Date(from.value).getTime() / 1000 : null,
      date_to: to.value ? new Date(to.value).getTime() / 1000 : null,
      fav: params.fav || null,
    });
  };
  q.addEventListener("input", debounce(go, 250));
  from.addEventListener("change", go);
  to.addEventListener("change", go);
  document.getElementById("favfilter").addEventListener("click", () => {
    const on = !params.fav;
    saveFavFilter(on);
    resetPage(viewKey);
    render({ ...params, fav: on ? 1 : null });
  });
}

async function viewModelDetail(id, params = {}) {
  const viewKey = `model:${id}`;
  params = { ...params, fav: loadFavFilter() ? 1 : null };
  const model = await api(`/api/models/${encodeURIComponent(id)}`);
  const { data, size, page } = await fetchPage(viewKey, "/api/runs",
    { model_id: id, ...params });
  const runs = data.items;
  app.innerHTML = `
    <h1>${favBtn("model", model.id, model.favorite)}${pinBtn("model", model.id, model.pinned)} ${esc(model.id)} ${delBtn("model", model.id)}</h1>
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
  bindRunsToolbar(viewKey, params, p => viewModelDetail(id, p));
}

// ---------- compare view ----------

// per-run series bundle for the compare view
function buildRunSeries(run, points, colorIdx) {
  const pauses = run.pauses || [];
  const pausedBefore = ts => {
    let s = 0;
    for (const p of pauses) {
      if (p.end_ts <= ts) s += p.end_ts - p.start_ts;
      else if (p.start_ts < ts) s += ts - p.start_ts;
    }
    return s;
  };
  const rd = {
    run,
    color: CHART_COLORS[colorIdx % CHART_COLORS.length],
    xsTime: points.map(p => p.ts - pausedBefore(p.ts) - run.started_at),
    xsIter: points.map(p => p.iteration),
    seriesByKey: {},
  };
  for (const k of collectKeys(points))
    rd.seriesByKey[k] = points.map(p => (k in p.metrics ? p.metrics[k] : null));
  // derived tokens/sec, same as the run page
  const tps = new Array(points.length).fill(null);
  for (let i = 1; i < points.length; i++) {
    const ctx = points[i].context_size ?? run.model_context_width;
    const dt = rd.xsTime[i] - rd.xsTime[i - 1];
    if (ctx && dt > 0) tps[i] = (points[i].batches * ctx) / dt;
  }
  rd.seriesByKey["tokens_per_sec"] = tps;
  return rd;
}

const CMP_DASHES = [null, [6, 3], [2, 2], [10, 4, 2, 4]];

// bpc = loss / chars_per_token / ln(2); each run uses its own model's
// chars_per_token, runs without one stay in nats
function cmpBpcTransform(chart, rd) {
  const cpt = rd.run.model_chars_per_token;
  return chart.bpc && cpt ? v => v / cpt / Math.LN2 : null;
}

// union x-axis across runs; each series is null where the run has no point.
// returns { data, meta } -- meta[i] describes data column i+1 (run + key + kind)
function cmpChartData(state, chart) {
  const group = chart.group;
  const xset = new Set();
  const perRun = [];
  for (const rd of state.runData) {
    const xs = state.xmode === "time" ? rd.xsTime : rd.xsIter;
    const f = cmpBpcTransform(chart, rd);
    const entries = [];
    for (const key of group.keys) {
      let rawOwn = rd.seriesByKey[key];
      if (!rawOwn || !rawOwn.length) continue;
      if (f) rawOwn = rawOwn.map(v => (v == null ? null : f(v)));
      const avgOwn = movingAvg(rawOwn, state.avgWin);
      const map = new Map();
      for (let i = 0; i < xs.length; i++) {
        if (rawOwn[i] == null) continue;
        map.set(xs[i], [rawOwn[i], avgOwn[i]]);
        xset.add(xs[i]);
      }
      entries.push({ key, map });
    }
    perRun.push({ rd, entries });
  }
  const xs = [...xset].sort((a, b) => a - b);
  const data = [xs];
  const meta = [];
  for (const { rd, entries } of perRun)
    for (const { key, map } of entries) {
      const raw = xs.map(x => { const v = map.get(x); return v ? v[0] : null; });
      const avg = xs.map(x => { const v = map.get(x); return v ? v[1] : null; });
      if (state.showRaw) { data.push(raw); meta.push({ rd, key, kind: "raw" }); }
      data.push(avg); meta.push({ rd, key, kind: "avg" });
    }
  return { data, meta };
}

function cmpSetAllScales(state, min, max) {
  for (const c of state.charts) if (c.u) c.u.setScale("x", { min, max });
}

function cmpRange(state) {
  let lo = Infinity, hi = -Infinity;
  for (const rd of state.runData) {
    const xs = state.xmode === "time" ? rd.xsTime : rd.xsIter;
    if (xs.length) { lo = Math.min(lo, xs[0]); hi = Math.max(hi, xs[xs.length - 1]); }
  }
  return lo <= hi ? { min: lo, max: hi } : null;
}

function cmpFitAll(state) {
  // fit all = full view on both axes: clear y clips; the setScale calls in
  // cmpSetAllScales re-evaluate the y auto-range with the clips cleared
  for (const c of state.charts) c.yClip = null;
  const r = cmpRange(state);
  if (r) cmpSetAllScales(state, r.min, r.max);
}

function cmpZoomBy(state, factor) {
  const c = state.charts.find(c => c.u);
  if (!c) return;
  const { min, max } = c.u.scales.x;
  if (min == null || max == null) return;
  const center = (min + max) / 2;
  const half = ((max - min) * factor) / 2;
  cmpSetAllScales(state, center - half, center + half);
}

// drag to pan, double-click to fit, click to pin the hover frame
// (shift-click pins the same x on every open chart)
function cmpPanPlugin(state, chart) {
  let panning = false, startX = 0, startY = 0, startMin = 0, startMax = 0;
  let startOffY = 0, startClip = null, axisLock = null;
  const rerange = u => u.setScale("x", { min: u.scales.x.min, max: u.scales.x.max });
  return {
    hooks: {
      ready: u => {
        u.over.addEventListener("mouseenter", () => { chart.hovered = true; });
        u.over.addEventListener("mouseleave", () => {
          chart.hovered = false;
          cmpUpdateHover(state, chart, null);
        });
        u.over.addEventListener("mousedown", e => {
          if (e.button !== 0) return;
          panning = true;
          axisLock = null;
          startX = e.clientX;
          startY = e.clientY;
          startMin = u.scales.x.min;
          startMax = u.scales.x.max;
          startOffY = e.clientY - u.over.getBoundingClientRect().top;
          startClip = chart.yClip ? { ...chart.yClip } : null;
          u.over.style.cursor = "grabbing";
          e.preventDefault();
        });
        document.addEventListener("mousemove", e => {
          if (!panning) return;
          const dx = e.clientX - startX;
          const dy = e.clientY - startY;
          // predominantly vertical drag with an active y clip slides the
          // clip up/down; otherwise it's the usual x pan
          if (!axisLock && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
            axisLock = startClip && Math.abs(dy) > Math.abs(dx) ? "y" : "x";
          }
          if (axisLock === "y") {
            const h = u.over.getBoundingClientRect().height;
            const off = Math.max(0, Math.min(h, startOffY + dy));
            chart.yClip = cmpSlideClip(chart, u, startOffY, off, startClip);
            rerange(u);
            return;
          }
          const range = startMax - startMin;
          const shift = (-dx / u.bbox.width) * range;
          cmpSetAllScales(state, startMin + shift, startMax + shift);
        });
        document.addEventListener("mouseup", e => {
          // a press without movement is a click -> pin the hover frame(s)
          if (panning && Math.abs(e.clientX - startX) < 4 && Math.abs(e.clientY - startY) < 4) {
            if (e.shiftKey) {
              for (const c of state.charts) if (c.u) cmpPin(state, c, chart.lastX);
            } else {
              cmpPin(state, chart, chart.lastX);
            }
          }
          panning = false;
          u.over.style.cursor = "";
        });
        u.over.addEventListener("dblclick", () => cmpFitAll(state));
      },
    },
  };
}

// slide a y clip by a drag from plot-offset offFrom to offTo (log-aware).
// grab-the-graph semantics (same as x-pan): dragging up pulls the content
// up, so the clip window moves down
function cmpSlideClip(chart, u, offFrom, offTo, clip) {
  const v0 = u.posToVal(offFrom, "y");
  const v1 = u.posToVal(offTo, "y");
  if (chart.logYActive) {
    const d = Math.log10(v0) - Math.log10(v1);
    return {
      min: 10 ** (Math.log10(clip.min) + d),
      max: 10 ** (Math.log10(clip.max) + d),
    };
  }
  const d = v0 - v1;
  return { min: clip.min + d, max: clip.max + d };
}

// scale a y clip proportionally around its center by a vertical drag of dy
// pixels (log-aware): drag up grows the range, drag down shrinks it
function cmpResizeClip(chart, clip, dy) {
  const factor = Math.exp(dy * 0.005);
  if (chart.logYActive) {
    const logC = (Math.log10(clip.min) + Math.log10(clip.max)) / 2;
    const half = ((Math.log10(clip.max) - Math.log10(clip.min)) / 2) * factor;
    return { min: 10 ** (logC - half), max: 10 ** (logC + half) };
  }
  const c = (clip.min + clip.max) / 2;
  const half = ((clip.max - clip.min) / 2) * factor;
  return { min: c - half, max: c + half };
}

// drag on the y-axis clips the y range to the dragged band; once clipped,
// dragging the axis resizes the clip proportionally (up = larger, down =
// smaller); a plain click (or double-click) on the axis resets to full range
function cmpYClipPlugin(state, chart) {
  let dragging = false, startOff = 0, startClip = null, band = null;
  // setScale x (even with an unchanged range) re-evaluates the y auto-range,
  // which applies the clip via the scale range hook. setData(data, false)
  // would NOT work -- it explicitly skips scale recalculation.
  const rerange = u => u.setScale("x", { min: u.scales.x.min, max: u.scales.x.max });
  return {
    hooks: {
      ready: u => {
        const axisEl = u.axes[1] && u.axes[1]._el;
        if (!axisEl) return;
        axisEl.style.cursor = "ns-resize";
        axisEl.title = "drag to clip y range · drag again to resize the clip · click to reset";
        axisEl.addEventListener("mousedown", e => {
          if (e.button !== 0) return;
          dragging = true;
          startOff = e.clientY - u.over.getBoundingClientRect().top;
          startClip = chart.yClip ? { ...chart.yClip } : null;
          if (!startClip) {
            // selection band shown while choosing a new clip region
            band = document.createElement("div");
            band.style.cssText = "position:absolute;left:0;right:0;pointer-events:none;"
              + "background:rgba(79,142,247,0.15);"
              + "border-top:1px solid rgba(79,142,247,0.6);border-bottom:1px solid rgba(79,142,247,0.6);";
            band.style.top = startOff + "px";
            band.style.height = "0px";
            u.over.appendChild(band);
          }
          e.preventDefault();
        });
        document.addEventListener("mousemove", e => {
          if (!dragging) return;
          const rect = u.over.getBoundingClientRect();
          const off = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
          if (startClip) {
            // resize the existing clip proportionally around its center
            chart.yClip = cmpResizeClip(chart, startClip, off - startOff);
            rerange(u);
          } else {
            band.style.top = Math.min(off, startOff) + "px";
            band.style.height = Math.abs(off - startOff) + "px";
          }
        });
        document.addEventListener("mouseup", e => {
          if (!dragging) return;
          dragging = false;
          const rect = u.over.getBoundingClientRect();
          const off = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
          if (band) { band.remove(); band = null; }
          if (Math.abs(off - startOff) < 4) {
            chart.yClip = null;  // plain click on the axis resets the clip
            rerange(u);
          } else if (!startClip) {
            const v0 = u.posToVal(startOff, "y");
            const v1 = u.posToVal(off, "y");
            chart.yClip = { min: Math.min(v0, v1), max: Math.max(v0, v1) };
            rerange(u);
          }
          // clip slides were already applied live on mousemove
        });
        axisEl.addEventListener("dblclick", () => {
          chart.yClip = null;
          rerange(u);
        });
      },
    },
  };
}

function cmpChartHeight(chart) {
  // fullscreen: leave room for the uPlot legend row below the plot
  return chart.body.classList.contains("fs-body")
    ? Math.max(300, chart.body.clientHeight - 36)
    : 300;
}

function makeCmpChart(state, chart) {
  const isTime = state.xmode === "time";
  const { data, meta } = cmpChartData(state, chart);
  chart.meta = meta;
  const multi = chart.group.keys.length > 1;
  const yFmt = chart.group.keys.includes("tokens_per_sec") ? fmtRate : fmtNum;
  const allPositive = chart.group.keys
    .flatMap(k => state.runData.flatMap(rd => rd.seriesByKey[k] || []))
    .every(v => v == null || v > 0);
  const logY = chart.logY && allPositive;
  chart.logYActive = logY;
  const series = [{ label: isTime ? "active time" : "iteration" }];
  for (const rd of state.runData) {
    chart.group.keys.forEach((key, ki) => {
      const rawOwn = rd.seriesByKey[key];
      if (!rawOwn || !rawOwn.length) return;
      const dash = CMP_DASHES[ki % CMP_DASHES.length] || undefined;
      const base = multi ? `#${rd.run.id} ${keyLabel(key)}` : `#${rd.run.id}`;
      if (state.showRaw) {
        series.push({
          label: base, stroke: rd.color, width: 1, alpha: 0.35, dash,
          spanGaps: true, points: { show: false },
          value: (u, v) => fmtVal(key, v),
        });
      }
      series.push({
        label: state.showRaw && state.avgWin > 1 ? `${base} avg` : base,
        stroke: rd.color, width: state.showRaw ? 2 : 1.5, dash,
        spanGaps: true, points: { show: false },
        value: (u, v) => fmtVal(key, v),
      });
    });
  }
  chart.u = new uPlot({
    width: chart.body.clientWidth || 900,
    height: cmpChartHeight(chart),
    plugins: [cmpPanPlugin(state, chart), cmpYClipPlugin(state, chart)],
    cursor: { sync: { key: state.sync.key, setSeries: false }, drag: { x: false, y: false } },
    scales: {
      x: { time: false },
      y: {
        distr: logY ? 3 : 1,
        // y clip overrides the auto range; for log scales uPlot works in
        // log10 space, so convert the clip bounds
        range: (u, dataMin, dataMax) => {
          const clip = chart.yClip;
          if (!clip) return [dataMin, dataMax];
          if (logY) {
            return [clip.min > 0 ? Math.log10(clip.min) : dataMin,
                    clip.max > 0 ? Math.log10(clip.max) : dataMax];
          }
          return [clip.min, clip.max];
        },
      },
    },
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
        chart.lastX = u.cursor.idx != null ? u.data[0][u.cursor.idx] : null;
        if (!chart.hovered) return;  // cursor synced from another chart
        cmpUpdateHover(state, chart, u.cursor.idx);
      }],
      draw: [u => cmpDrawPinnedMark(state, chart, u)],
    },
  }, data, chart.body);

  // per-chart sticky hover frame (top-right inside the chart)
  let float = chart.body.querySelector(":scope > .chart-float");
  if (!float) {
    float = document.createElement("div");
    float.className = "chart-float";
    float.style.display = "none";
    float.addEventListener("click", e => {
      if (!e.target.closest(".hf-close")) return;
      cmpUnpin(chart);
    });
    chart.body.appendChild(float);
  }
  chart.float = float;
  chart.floatFrozen = false;
  chart.pinnedX = null;

  if (!chart.hidden) chart.hidden = new Set();
  cmpBindLegendToggles(state, chart);
}

// values at a union-x index, grouped metric-major so the same metric's runs
// sit next to each other; every value tagged with its run color + id
function cmpHoverHtml(state, chart, idx) {
  const xs = chart.u.data[0];
  const x = xs[idx];
  if (x == null) return null;
  const xLabel = state.xmode === "time" ? fmtDur(x) : `iter ${x}`;
  let html = `<span class="hp-item">x <b>${xLabel}</b></span>`;
  for (const key of chart.group.keys) {
    // prefer the raw column; fall back to avg when raw is hidden
    const cols = chart.meta
      .map((m, i) => ({ m, col: i + 1 }))
      .filter(({ m }) => m.key === key && (m.kind === "raw" || !state.showRaw));
    const items = [];
    for (const { m, col } of cols) {
      const ys = chart.u.data[col];
      let v = ys[idx], est = false;
      if (v == null) {  // run has no point here: linear estimate, marked with ~
        v = interpAt(xs, ys, idx);
        est = v != null;
      }
      if (v == null) continue;
      items.push(`<span class="hp-item"><span class="hp-swatch"
        style="background:${m.rd.color}"></span>#${m.rd.run.id} <b>${est ? "~" : ""}${fmtVal(key, v)}</b></span>`);
    }
    if (!items.length) continue;
    if (chart.group.keys.length > 1)
      html += `<span class="hp-item" style="opacity:0.75">${esc(keyLabel(key))}:</span>`;
    html += items.join("");
  }
  return html;
}

function cmpUpdateHover(state, chart, idx) {
  if (!chart.float || chart.floatFrozen) return;
  const valid = idx != null && chart.u && idx >= 0 && idx < chart.u.data[0].length;
  const html = valid ? cmpHoverHtml(state, chart, idx) : null;
  if (html) {
    chart.float.innerHTML = html;
    chart.float.style.display = "";
  } else {
    chart.float.style.display = "none";
  }
}

// legend rows toggle logical series (run + metric pair = raw & avg rows
// together); uPlot's own per-series click fires first and gets overridden
function cmpApplyHidden(state, chart) {
  if (!chart.u || !chart.hidden) return;
  chart.meta.forEach((m, i) => {
    chart.u.setSeries(i + 1, { show: !chart.hidden.has(`${m.rd.run.id}|${m.key}`) });
  });
}

function cmpBindLegendToggles(state, chart) {
  cmpApplyHidden(state, chart);
  const rows = chart.u.root.querySelectorAll(".u-legend tr.u-series");
  // uPlot may render a row for the x series; detect and skip it
  const offset = rows.length - chart.meta.length;
  rows.forEach((tr, i) => {
    const mi = i - offset;
    if (mi < 0 || !chart.meta[mi]) return;  // x-axis row: inert
    const { rd, key } = chart.meta[mi];
    const id = `${rd.run.id}|${key}`;
    tr.style.cursor = "pointer";
    tr.title = "click to hide/show · double-click to isolate";
    tr.addEventListener("click", e => {
      e.preventDefault();
      if (chart.hidden.has(id)) chart.hidden.delete(id);
      else chart.hidden.add(id);
      cmpApplyHidden(state, chart);
    });
    tr.addEventListener("dblclick", e => {
      e.preventDefault();
      const ids = [...new Set(chart.meta.map(m => `${m.rd.run.id}|${m.key}`))];
      const others = ids.filter(x => x !== id);
      const alreadyIsolated = others.every(x => chart.hidden.has(x)) && !chart.hidden.has(id);
      chart.hidden = new Set(alreadyIsolated ? [] : others);
      cmpApplyHidden(state, chart);
    });
  });
}

// index of the value closest to x in a sorted array
function closestIdx(xs, x) {
  let lo = 0, hi = xs.length - 1;
  if (x <= xs[0]) return 0;
  if (x >= xs[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid; else hi = mid;
  }
  return x - xs[lo] <= xs[hi] - x ? lo : hi;
}

// pin by x VALUE (not index): each chart has its own union x-axis
function cmpPin(state, chart, xVal) {
  if (xVal == null || !chart.u) return;
  const idx = closestIdx(chart.u.data[0], xVal);
  chart.pinnedX = chart.u.data[0][idx];
  chart.floatFrozen = true;
  const float = chart.float;
  if (float) {
    float.innerHTML = cmpHoverHtml(state, chart, idx);
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
  chart.u.redraw();
}

function cmpUnpin(chart) {
  chart.floatFrozen = false;
  chart.pinnedX = null;
  if (chart.float) {
    chart.float.classList.remove("frozen");
    chart.float.style.display = "none";
  }
  if (chart.u) chart.u.redraw();
}

// solid vertical marker at the pinned x (distinct from the hover cursor)
function cmpDrawPinnedMark(state, chart, u) {
  if (chart.pinnedX == null) return;
  const { min, max } = u.scales.x;
  if (chart.pinnedX < min || chart.pinnedX > max) return;
  const x = u.valToPos(chart.pinnedX, "x", true);
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

// collapsed state is global for the compare view (same layout for any run set)
function loadCmpCollapsed() {
  try { return JSON.parse(localStorage.getItem("trainui.compare.collapsed")) || {}; }
  catch { return {}; }
}

function saveCmpCollapsed(obj) {
  try { localStorage.setItem("trainui.compare.collapsed", JSON.stringify(obj)); } catch { }
}

function loadCmpLogY() {
  try { return JSON.parse(localStorage.getItem("trainui.compare.logy")) || {}; }
  catch { return {}; }
}

function saveCmpLogY(obj) {
  try { localStorage.setItem("trainui.compare.logy", JSON.stringify(obj)); } catch { }
}

function loadCmpLegend() {
  try { return JSON.parse(localStorage.getItem("trainui.compare.legend")) || {}; }
  catch { return {}; }
}

function saveCmpLegend(obj) {
  try { localStorage.setItem("trainui.compare.legend", JSON.stringify(obj)); } catch { }
}

// on-chart legend overlay: one compact line per run --
// #id model p=<params> tr=<mult> (<tokens>) - description
function cmpChartLegendHtml(state) {
  return state.runData.map(rd => {
    const r = rd.run;
    const parts = [
      esc(r.model_id),
      r.model_param_count ? `p=${fmtParams(r.model_param_count)}` : null,
      fmtTokens(r) ? `tr=${fmtTokens(r)}` : null,
    ].filter(Boolean).join(" ");
    const desc = r.description ? ` - ${esc(r.description)}` : "";
    return `<div class="cmp-legend-line"><span class="hp-swatch"
      style="background:${rd.color}"></span><b>#${r.id}</b> ${parts}${desc}</div>`;
  }).join("");
}

function cmpRenderChartLegend(state, chart) {
  let el = chart.body.querySelector(":scope > .cmp-legend");
  if (!chart.legendOn) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement("div");
    el.className = "cmp-legend";
    chart.body.appendChild(el);
  }
  el.innerHTML = cmpChartLegendHtml(state);
}

function cmpIsCollapsed(state, name) {
  return name in state.collapsed ? state.collapsed[name] : name !== "loss";
}

// last value per run per metric, run-colored -- shown in collapsed headers
function cmpChartLastHtml(state, chart) {
  const multi = chart.group.keys.length > 1;
  return chart.group.keys.map(k => {
    const vals = state.runData.map(rd => {
      const ys = rd.seriesByKey[k];
      let last = ys ? ys.filter(v => v != null).slice(-1)[0] : null;
      const f = cmpBpcTransform(chart, rd);
      if (last != null && f) last = f(last);
      return last == null ? null
        : `<span style="color:${rd.color}">#${rd.run.id} ${fmtVal(k, last)}</span>`;
    }).filter(Boolean).join(" · ");
    return vals ? (multi ? `${esc(keyLabel(k))}: ${vals}` : vals) : null;
  }).filter(Boolean).join(" · ");
}

function cmpUpdateLast(state) {
  for (const chart of state.charts) {
    const el = chart.panel.querySelector(".chart-last");
    if (el) el.innerHTML = cmpChartLastHtml(state, chart);
    if (chart.legendOn) cmpRenderChartLegend(state, chart);  // tokens grow live
  }
  if (state.fsOverlay && state.expanded) {
    const el = state.fsOverlay.querySelector(".chart-last");
    if (el) el.innerHTML = cmpChartLastHtml(state, state.expanded);
  }
}

function cmpRunsLegendHtml(state) {
  return state.runData.map(rd => `<span class="cmp-legend-run">
    <a href="#/runs/${rd.run.id}" style="color:${rd.color}"><b>#${rd.run.id}</b></a>
    <span class="badge ${rd.run.status}" data-cmp-status="${rd.run.id}">${rd.run.status}</span>
  </span>`).join("");
}

// rebuild the fullscreen chart in place (after x-mode/raw/data-shape changes)
function cmpRebuildExpanded(state, pin) {
  const name = state.expanded.group.name;
  const chart = state.charts.find(c => c.group.name === name);
  state.expanded = chart;
  if (chart.u) chart.u.destroy();
  chart.u = null;
  chart.body = state.fsOverlay.querySelector(".fs-body");
  makeCmpChart(state, chart);
  chartRefreshTag(chart);  // body swapped: re-create the status tag
  if (pin != null) cmpPin(state, chart, pin);
  cmpRenderChartLegend(state, chart);
  return chart;
}

function renderCmpCharts(state, keepPins = false) {
  const pins = {};
  const hiddenCarry = {};
  if (keepPins) for (const c of state.charts) {
    if (c.pinnedX != null) pins[c.group.name] = c.pinnedX;
    if (c.hidden && c.hidden.size) hiddenCarry[c.group.name] = c.hidden;
  }
  for (const c of state.charts) if (c.u) c.u.destroy();
  state.charts = [];
  const container = document.getElementById("charts");
  container.innerHTML = "";
  state.sync = uPlot.sync("cmp-charts");

  for (const group of state.groups) {
    const title = group.keys.length === 1 ? keyLabel(group.keys[0]) : group.name;
    const collapsed = cmpIsCollapsed(state, group.name);
    const isLoss = group.name === "loss" || /loss/i.test(group.name);
    const showBpc = isLoss && state.runData.some(rd => rd.run.model_chars_per_token);
    const panel = document.createElement("div");
    panel.className = "chart-panel" + (collapsed ? " collapsed" : "");
    panel.innerHTML = `
      <div class="chart-head">
        <button data-collapse title="${collapsed ? "expand" : "collapse"}">${collapsed ? "▸" : "▾"}</button>
        <span class="chart-name">${esc(title)}</span>
        <span class="chart-last"></span>
        <span style="flex:1"></span>
        ${showBpc ? `<button data-bpc class="${state.bpc[group.name] ? "active" : ""}"
          title="bits per character">bpc</button>` : ""}
        <button data-log class="${state.logY[group.name] ? "active" : ""}">log y</button>
        <button data-legend class="${state.legend[group.name] ? "active" : ""}"
          title="show run legend on the chart">legend</button>
        <button data-expand title="fullscreen">⤢</button>
      </div>
      <div class="chart-body"${collapsed ? ' style="display:none"' : ""}></div>`;
    container.appendChild(panel);
    const chart = { group, u: null, body: panel.querySelector(".chart-body"), panel,
                    pinnedX: null, floatFrozen: false, hovered: false,
                    logY: !!state.logY[group.name], yClip: null,
                    legendOn: !!state.legend[group.name],
                    bpc: showBpc && !!state.bpc[group.name],
                    loading: !!state.loading, loadErr: state.loadErr || null,
                    hidden: hiddenCarry[group.name] || new Set() };
    panel.querySelector(".chart-last").innerHTML = cmpChartLastHtml(state, chart);
    chartRefreshTag(chart);

    panel.querySelector("[data-collapse]").addEventListener("click", e => {
      const nowCollapsed = !cmpIsCollapsed(state, group.name);
      state.collapsed[group.name] = nowCollapsed;
      saveCmpCollapsed(state.collapsed);
      e.target.textContent = nowCollapsed ? "▸" : "▾";
      e.target.title = nowCollapsed ? "expand" : "collapse";
      panel.classList.toggle("collapsed", nowCollapsed);
      if (nowCollapsed) {
        // only this chart is torn down; other charts keep pins/zoom untouched
        if (chart.u) { chart.u.destroy(); chart.u = null; }
        chart.body.style.display = "none";
      } else {
        chart.body.style.display = "";
        makeCmpChart(state, chart);
        cmpRenderChartLegend(state, chart);
        // align with the other open charts
        const other = state.charts.find(c => c !== chart && c.u);
        if (other) {
          const { min, max } = other.u.scales.x;
          if (min != null) chart.u.setScale("x", { min, max });
        }
      }
    });
    panel.querySelector("[data-expand]").addEventListener("click", () => {
      cmpOpenFullscreen(state, chart);
    });
    panel.querySelector("[data-legend]").addEventListener("click", e => {
      chart.legendOn = !chart.legendOn;
      state.legend[group.name] = chart.legendOn;
      saveCmpLegend(state.legend);
      e.target.classList.toggle("active", chart.legendOn);
      cmpRenderChartLegend(state, chart);
    });
    const bpcBtn = panel.querySelector("[data-bpc]");
    if (bpcBtn) bpcBtn.addEventListener("click", e => {
      chart.bpc = !chart.bpc;
      state.bpc[group.name] = chart.bpc;
      saveBpc(state.bpc);  // bpc preference is global, shared with run pages
      e.target.classList.toggle("active", chart.bpc);
      chart.yClip = null;  // units changed, the old clip no longer applies
      if (chart.u) {
        const xr = { min: chart.u.scales.x.min, max: chart.u.scales.x.max };
        const pin = chart.pinnedX;
        chart.u.destroy();
        chart.u = null;
        makeCmpChart(state, chart);
        if (xr.min != null) chart.u.setScale("x", xr);
        if (pin != null) cmpPin(state, chart, pin);
        cmpRenderChartLegend(state, chart);
      }
      panel.querySelector(".chart-last").innerHTML = cmpChartLastHtml(state, chart);
    });
    panel.querySelector("[data-log]").addEventListener("click", e => {
      chart.logY = !chart.logY;
      state.logY[group.name] = chart.logY;
      saveCmpLogY(state.logY);
      e.target.classList.toggle("active", chart.logY);
      if (chart.u) {
        const xr = { min: chart.u.scales.x.min, max: chart.u.scales.x.max };
        const pin = chart.pinnedX;
        chart.u.destroy();
        chart.u = null;
        makeCmpChart(state, chart);
        if (xr.min != null) chart.u.setScale("x", xr);
        if (pin != null) cmpPin(state, chart, pin);
      }
    });

    if (!collapsed) {
      makeCmpChart(state, chart);
      if (pins[group.name] != null) cmpPin(state, chart, pins[group.name]);
      cmpRenderChartLegend(state, chart);
    }
    state.charts.push(chart);
  }

  resizeHandler = () => {
    for (const c of state.charts) {
      if (c.u) c.u.setSize({ width: c.body.clientWidth, height: cmpChartHeight(c) });
    }
  };
  window.addEventListener("resize", resizeHandler);
}

function cmpOpenFullscreen(state, chart) {
  if (state.fsOverlay) return;
  const title = chart.group.keys.length === 1 ? keyLabel(chart.group.keys[0]) : chart.group.name;
  const isLoss = chart.group.name === "loss" || /loss/i.test(chart.group.name);
  const showBpc = isLoss && state.runData.some(rd => rd.run.model_chars_per_token);
  const overlay = document.createElement("div");
  overlay.className = "fs-overlay";
  overlay.innerHTML = `
    <div class="fs-head">
      <span class="chart-name">${esc(title)}</span>
      ${cmpRunsLegendHtml(state)}
      <span class="chart-last"></span>
      <span style="flex:1"></span>
      ${showBpc ? `<button data-bpc class="${chart.bpc ? "active" : ""}"
        title="bits per character">bpc</button>` : ""}
      <button data-log class="${chart.logY ? "active" : ""}">log y</button>
      <button data-legend class="${chart.legendOn ? "active" : ""}"
        title="show run legend on the chart">legend</button>
      <button data-close title="close (Esc)">✕</button>
    </div>
    <div class="fs-controls"></div>
    <div class="fs-body"></div>`;
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";
  state.expanded = chart;
  state.fsOverlay = overlay;

  // move the main control bar (x-mode, avg, raw, refresh, zoom) into the overlay
  const controls = document.querySelector(".chart-controls");
  if (controls) {
    state.fsPlaceholder = document.createComment("chart-controls");
    controls.parentNode.insertBefore(state.fsPlaceholder, controls);
    overlay.querySelector(".fs-controls").appendChild(controls);
  }

  // preserve the current view: zoom range and the pinned point
  const prevRange = chart.u ? { min: chart.u.scales.x.min, max: chart.u.scales.x.max } : null;
  const pin = chart.pinnedX;
  if (chart.u) chart.u.destroy();
  chart.u = null;
  chart.body = overlay.querySelector(".fs-body");
  makeCmpChart(state, chart);
  chartRefreshTag(chart);  // body swapped: re-create the status tag
  overlay.querySelector(".chart-last").innerHTML = cmpChartLastHtml(state, chart);
  if (prevRange && prevRange.min != null) chart.u.setScale("x", prevRange);
  if (pin != null) cmpPin(state, chart, pin);
  cmpRenderChartLegend(state, chart);

  overlay.querySelector("[data-legend]").addEventListener("click", e => {
    chart.legendOn = !chart.legendOn;
    state.legend[chart.group.name] = chart.legendOn;
    saveCmpLegend(state.legend);
    e.target.classList.toggle("active", chart.legendOn);
    cmpRenderChartLegend(state, chart);
  });
  const fsBpcBtn = overlay.querySelector("[data-bpc]");
  if (fsBpcBtn) fsBpcBtn.addEventListener("click", e => {
    chart.bpc = !chart.bpc;
    state.bpc[chart.group.name] = chart.bpc;
    saveBpc(state.bpc);
    e.target.classList.toggle("active", chart.bpc);
    chart.yClip = null;  // units changed, the old clip no longer applies
    const xr = { min: chart.u.scales.x.min, max: chart.u.scales.x.max };
    const pin = chart.pinnedX;
    chart.u.destroy();
    chart.u = null;
    makeCmpChart(state, chart);
    if (xr.min != null) chart.u.setScale("x", xr);
    if (pin != null) cmpPin(state, chart, pin);
    cmpRenderChartLegend(state, chart);
    overlay.querySelector(".chart-last").innerHTML = cmpChartLastHtml(state, chart);
  });

  overlay.querySelector("[data-log]").addEventListener("click", e => {
    chart.logY = !chart.logY;
    state.logY[chart.group.name] = chart.logY;
    saveCmpLogY(state.logY);
    e.target.classList.toggle("active", chart.logY);
    const xr = { min: chart.u.scales.x.min, max: chart.u.scales.x.max };
    const pin = chart.pinnedX;
    chart.u.destroy();
    chart.u = null;
    makeCmpChart(state, chart);
    if (xr.min != null) chart.u.setScale("x", xr);
    if (pin != null) cmpPin(state, chart, pin);
  });
  overlay.querySelector("[data-close]").addEventListener("click", () => cmpCloseFullscreen(state));
  state.fsKeyHandler = e => { if (e.key === "Escape") cmpCloseFullscreen(state); };
  document.addEventListener("keydown", state.fsKeyHandler);
}

function cmpCloseFullscreen(state) {
  if (!state.fsOverlay) return;
  document.removeEventListener("keydown", state.fsKeyHandler);
  // restore the control bar to its original spot in the page
  const controls = state.fsOverlay.querySelector(".chart-controls");
  if (controls && state.fsPlaceholder && state.fsPlaceholder.parentNode) {
    state.fsPlaceholder.parentNode.insertBefore(controls, state.fsPlaceholder);
    state.fsPlaceholder.remove();
  }
  state.fsPlaceholder = null;
  const xr = state.expanded && state.expanded.u
    ? { min: state.expanded.u.scales.x.min, max: state.expanded.u.scales.x.max } : null;
  state.fsOverlay.remove();
  state.fsOverlay = null;
  state.expanded = null;
  document.body.style.overflow = "";
  // ticks updated only the fullscreen chart; rebuild the rest with latest data
  renderCmpCharts(state, true);
  if (xr && xr.min != null) cmpSetAllScales(state, xr.min, xr.max);
}

function cmpGroups(runData) {
  const keys = [...new Set(runData.flatMap(rd => Object.keys(rd.seriesByKey)))]
    .filter(k => k !== "tokens_per_sec");
  const groups = groupsFromKeys(keys);
  groups.splice(Math.min(1, groups.length), 0,
    { name: "tokens/sec", keys: ["tokens_per_sec"] });
  return groups;
}

function setCmpRefresh(state, periodSec) {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  if (!periodSec) return;
  refreshTimer = setInterval(async () => {
    try {
      const runs = await Promise.all(state.ids.map(id => api(`/api/runs/${id}`)));
      // incremental: only points logged since the last tick, per run
      const mds = await Promise.all(state.ids.map((id, i) =>
        api(`/api/runs/${id}/metrics${state.maxSeqArr[i] ? `?since=${state.maxSeqArr[i]}` : ""}`)));
      state.runs = runs;
      for (let i = 0; i < state.ids.length; i++) {
        const newKeys = collectKeys(mds[i].points).filter(k => !state.keySetArr[i].has(k));
        if (newKeys.length) {
          // a run started reporting a new metric key: its history is missing
          // from the incremental tail -> one full (chunked) refetch for this run
          const pts = (await fetchMetricsChunked(state.ids[i], null)).points;
          state.pointsArr[i] = pts;
          state.keySetArr[i] = new Set(collectKeys(pts));
        } else {
          state.pointsArr[i] = state.pointsArr[i].concat(mds[i].points);
        }
        const arr = state.pointsArr[i];
        state.maxSeqArr[i] = arr.length ? arr[arr.length - 1].seq : 0;
      }
      state.runData = runs.map((run, i) => buildRunSeries(run, state.pointsArr[i], i));
      if (state.loadErr) chartsSetError(state, null);  // recovered
      for (const badge of document.querySelectorAll("[data-cmp-status]")) {
        const run = runs.find(r => r.id === +badge.dataset.cmpStatus);
        if (run && badge.textContent !== run.status) {
          badge.textContent = run.status;
          badge.className = `badge ${run.status}`;
        }
      }
      const groups = cmpGroups(state.runData);
      let changed = JSON.stringify(groups.map(g => g.name + g.keys)) !==
        JSON.stringify(state.groups.map(g => g.name + g.keys));
      if (!changed) {
        // a run may have started reporting a key another run already had:
        // that changes the column count without changing the group list
        for (const chart of state.charts) {
          if (!chart.u) continue;
          if (state.expanded && chart !== state.expanded) continue;
          if (cmpChartData(state, chart).data.length !== chart.u.data.length) {
            changed = true;
            break;
          }
        }
      }
      if (changed) {
        // series structure changed: rebuild, keeping zoom and pins
        const c = state.charts.find(c => c.u);
        const xr = c && c.u.scales.x.min != null
          ? { min: c.u.scales.x.min, max: c.u.scales.x.max } : null;
        const pin = state.expanded ? state.expanded.pinnedX : null;
        state.groups = groups;
        renderCmpCharts(state, true);
        if (state.expanded) cmpRebuildExpanded(state, pin);
        if (xr) cmpSetAllScales(state, xr.min, xr.max);
      } else {
        for (const chart of state.charts) {
          if (!chart.u) continue;                          // collapsed: header values only
          if (state.expanded && chart !== state.expanded) continue;  // fullscreen: update only it
          const xr = { min: chart.u.scales.x.min, max: chart.u.scales.x.max };
          const { data, meta } = cmpChartData(state, chart);
          chart.meta = meta;
          chart.u.setData(data, false);
          if (xr.min != null) chart.u.setScale("x", xr);
        }
      }
      cmpUpdateLast(state);
      if (runs.every(r => r.status === "completed")) {
        setCmpRefresh(state, 0);
        const sel = document.getElementById("refreshsel");
        if (sel) { sel.value = "0"; sel.disabled = true; }
      }
    } catch (e) {
      // transient failure: mark charts with a red tag, next tick clears it
      chartsSetError(state, String(e && e.message || e));
    }
  }, periodSec * 1000);
}

async function viewCompare(ids) {
  if (!ids.length) {
    app.innerHTML = `<h1>Compare runs</h1>
      <div class="empty">no runs selected — tick the checkboxes in run lists, then hit compare</div>`;
    return;
  }
  app.innerHTML = `<h1>Compare runs</h1><div class="empty">loading…</div>`;
  let runs, mds;
  try {
    runs = await Promise.all(ids.map(id => api(`/api/runs/${id}`)));
    // chunked initial load per run (chunks sequential per run, runs in parallel)
    mds = await Promise.all(ids.map(id => fetchMetricsChunked(id, null)));
  } catch (e) {
    app.innerHTML = `<h1>Compare runs</h1>
      <div class="empty" style="color:#e5646e; border-color:#e5646e">
        ⚠ failed to load: ${esc(String(e && e.message || e))}
        — <a href="" onclick="location.reload(); return false;">retry</a></div>`;
    return;
  }
  const anyRunning = runs.some(r => r.status === "running");
  const refresh = anyRunning ? 5 : 0;
  const refreshOpt = v => `<option value="${v}" ${refresh === v ? "selected" : ""}>${
    v === 0 ? "off" : v === 60 ? "1m" : v + "s"}</option>`;

  const state = {
    ids,
    runs,
    runData: runs.map((run, i) => buildRunSeries(run, mds[i].points, i)),
    xmode: "iteration",
    avgWin: 20,
    showRaw: true,
    collapsed: loadCmpCollapsed(),
    logY: loadCmpLogY(),
    legend: loadCmpLegend(),
    bpc: loadBpc(),
    expanded: null,
    fsOverlay: null,
    charts: [],
    sync: uPlot.sync("cmp-charts"),
  };
  // accumulated history per run; refresh ticks append only points with
  // seq > maxSeqArr[i] (full refetch per run only if new metric keys appear)
  state.pointsArr = mds.map(m => m.points);
  state.keySetArr = mds.map(m => new Set(collectKeys(m.points)));
  state.maxSeqArr = mds.map(m => m.points.length ? m.points[m.points.length - 1].seq : 0);
  state.groups = cmpGroups(state.runData);

  app.innerHTML = `
    <h1>Compare runs</h1>
    <div class="run-stats">
      ${state.runData.map(rd => `<span>
        <a href="#/runs/${rd.run.id}" style="color:${rd.color}"><b>#${rd.run.id}</b></a>
        <span class="badge ${rd.run.status}" data-cmp-status="${rd.run.id}">${rd.run.status}</span>
        ${esc(rd.run.model_id)}</span>`).join("")}
    </div>
    <div class="cmp-descs">
      ${state.runData.map(rd => `<div class="cmp-desc">
        <a href="#/runs/${rd.run.id}" style="color:${rd.color}"><b>run #${rd.run.id}</b></a>
        — ${esc(rd.run.description || rd.run.model_id)}</div>`).join("")}
    </div>
    <div class="chart-controls">
      <label>x-axis
        <select id="xmode">
          <option value="iteration" selected>iterations</option>
          <option value="time">time</option>
        </select>
      </label>
      <label>avg window <input type="number" id="avgwin" min="1" max="10000" value="20"></label>
      <label><input type="checkbox" id="showraw" checked> raw</label>
      <label>refresh
        <select id="refreshsel" ${anyRunning ? "" : "disabled"}>${[0, 5, 10, 30, 60].map(refreshOpt).join("")}</select>
      </label>
      <span class="zoom-btns">
        <button id="zin" title="zoom in">+</button>
        <button id="zout" title="zoom out">−</button>
        <button id="zfit" title="fit all data">fit all</button>
      </span>
      <span class="hint">each run has its own color · dashed = 2nd metric in a group · drag to pan · dbl-click to fit · click to pin · shift-click pins all · drag y-axis to clip / resize it, drag vertically on plot to slide it, click axis to reset</span>
    </div>
    <div id="charts"></div>`;

  renderCmpCharts(state);

  document.getElementById("xmode").addEventListener("change", e => {
    state.xmode = e.target.value;
    renderCmpCharts(state);  // x meaning changed: pins are cleared
    if (state.expanded) {
      const chart = cmpRebuildExpanded(state, null);
      const r = cmpRange(state);
      if (r) chart.u.setScale("x", r);
    } else {
      cmpFitAll(state);
    }
  });
  document.getElementById("avgwin").addEventListener("input", debounce(e => {
    state.avgWin = Math.max(1, parseInt(e.target.value) || 1);
    for (const chart of state.charts) {
      if (!chart.u) continue;
      if (state.expanded && chart !== state.expanded) continue;
      const xr = { min: chart.u.scales.x.min, max: chart.u.scales.x.max };
      const { data, meta } = cmpChartData(state, chart);
      chart.meta = meta;
      chart.u.setData(data, false);
      if (xr.min != null) chart.u.setScale("x", xr);
    }
  }, 150));
  document.getElementById("showraw").addEventListener("change", e => {
    state.showRaw = e.target.checked;
    const c = (state.expanded && state.expanded.u) ? state.expanded
      : state.charts.find(c => c.u);
    const xr = c && c.u.scales.x.min != null
      ? { min: c.u.scales.x.min, max: c.u.scales.x.max } : null;
    const pin = state.expanded ? state.expanded.pinnedX : null;
    renderCmpCharts(state, true);  // same x values: pins survive
    if (state.expanded) cmpRebuildExpanded(state, pin);
    if (xr) cmpSetAllScales(state, xr.min, xr.max);
  });
  document.getElementById("refreshsel").addEventListener("change", e => {
    setCmpRefresh(state, parseInt(e.target.value));
  });
  document.getElementById("zin").addEventListener("click", () => cmpZoomBy(state, 0.5));
  document.getElementById("zout").addEventListener("click", () => cmpZoomBy(state, 2));
  document.getElementById("zfit").addEventListener("click", () => cmpFitAll(state));

  if (refresh) setCmpRefresh(state, refresh);
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
      <h1 style="margin:0">${favBtn("run", run.id, run.favorite)}${pinBtn("run", run.id, run.pinned)} run #${run.id}
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
    maxSeq: 0,        // highest seq seen; refresh ticks fetch only seq > maxSeq
    lastVals: {},
    loading: true,    // chunked initial load in progress (charts greyed + tag)
    loadErr: null,
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
  // chunked progressive load: render after the first chunk, then extend the
  // series as further chunks arrive
  const chartsEl = document.getElementById("charts");
  if (chartsEl) chartsEl.innerHTML = `<div class="empty">loading…</div>`;
  let rendered = false;
  const onChunk = (pts, last) => {
    mergeMetrics(state, { points: pts, last });
    const elP = document.getElementById("stat-points");
    if (elP) elP.textContent = state.points.length;
    if (!rendered && state.points.length) { renderCharts(state); rendered = true; }
    else if (rendered) updateSeries(state, true);
  };
  try {
    const md0 = await fetchMetricsChunked(id, initKeys, onChunk);
    if (mergeMetrics(state, md0)) {
      // saved key list was stale (run has new metrics); refetch for visible charts
      mergeMetrics(state, await fetchMetricsChunked(id, stateNeededKeys(state)));
    }
    chartsSetError(state, null);
  } catch (e) {
    chartsSetError(state, String(e && e.message || e));
  }
  chartsSetLoading(state, false);
  if (!rendered) renderCharts(state);  // run with no points yet (or load failed)

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
    if (state.fsOverlay && state.expanded) {
      // rebuild only the fullscreen chart; the main view rebuilds on close
      const c = state.expanded;
      const xr = c.u ? { min: c.u.scales.x.min, max: c.u.scales.x.max } : null;
      if (c.u) c.u.destroy();
      makeChart(state, c, state.sync);
      if (xr && xr.min != null) c.u.setScale("x", xr);
    } else {
      const r = currentRange(state);
      renderCharts(state);
      if (r) setAllScales(state, r.min, r.max);
    }
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
        // incremental: only points logged since the last tick
        api(metricsUrl(runId, stateNeededKeys(state), state.maxSeq)),
      ]);
      const prevStatus = state.run ? state.run.status : null;
      state.run = run;
      if (state.loadErr) chartsSetError(state, null);
      const added = mergeMetrics(state, mdata, true);
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
        // new metric keys discovered via the `last` map; their history is
        // missing from the accumulated points, so do one full (chunked) refetch
        mergeMetrics(state, await fetchMetricsChunked(runId, stateNeededKeys(state)));
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
    } catch (e) {
      // transient failure: mark charts with a red tag, next tick clears it
      chartsSetError(state, String(e && e.message || e));
    }
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
// since=N -> only points with seq > N (incremental refresh)
// limit=N -> at most N points (chunked initial load)
function metricsUrl(runId, keys, since, limit) {
  const params = [];
  if (keys != null) params.push(`keys=${keys.map(encodeURIComponent).join(",")}`);
  if (since) params.push(`since=${since}`);
  if (limit) params.push(`limit=${limit}`);
  const base = `/api/runs/${runId}/metrics`;
  return params.length ? `${base}?${params.join("&")}` : base;
}

// initial load in 10k-point chunks so a huge run doesn't hit the server (and
// the browser's JSON parse) with one giant request; onChunk(points, last) is
// awaited after each chunk with the accumulated history so the UI can render
// progressively
const METRICS_CHUNK = 10000;
async function fetchMetricsChunked(runId, keys, onChunk) {
  let since = 0, all = [], last = {};
  for (;;) {
    const md = await api(metricsUrl(runId, keys, since, METRICS_CHUNK));
    all = all.concat(md.points);
    if (md.last && Object.keys(md.last).length) last = md.last;
    if (onChunk) await onChunk(all, last);
    if (md.points.length < METRICS_CHUNK) break;
    since = all[all.length - 1].seq;
  }
  return { points: all, last };
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

// store fetched points, discover new metric keys, rebuild derived state.
// append=true: data holds only points with seq > state.maxSeq (incremental
// refresh); they are appended to the accumulated history instead of replacing
// it. points are append-only with increasing seq, so a concat is safe.
function mergeMetrics(state, data, append = false) {
  state.points = append && state.points.length
    ? state.points.concat(data.points)
    : data.points;
  // incremental responses carry the full cached last map, so a replace is fine
  if (data.last && Object.keys(data.last).length) state.lastVals = data.last;
  state.maxSeq = state.points.length ? state.points[state.points.length - 1].seq : 0;
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

// bottom-right status tag on a chart body: "loading…" while fetching
// (plot greyed out via the .loading class), red mark on failure.
// Driven by chart.loading / chart.loadErr; safe to call after chart.body
// has been swapped (fullscreen moves the chart into .fs-body).
function chartRefreshTag(chart) {
  if (!chart.body) return;
  let tag = chart.body.querySelector(":scope > .load-tag");
  if (!tag) {
    tag = document.createElement("span");
    chart.body.appendChild(tag);
  }
  if (chart.loadErr) {
    tag.textContent = "⚠ load failed — will retry";
    tag.title = chart.loadErr;
    tag.className = "load-tag err";
    chart.body.classList.remove("loading");
  } else if (chart.loading) {
    tag.textContent = "loading…";
    tag.title = "";
    tag.className = "load-tag";
    chart.body.classList.add("loading");
  } else {
    tag.textContent = "";
    tag.className = "load-tag";
    tag.style.display = "none";
    chart.body.classList.remove("loading");
    return;
  }
  tag.style.display = "";
}

function chartsSetLoading(state, on) {
  state.loading = on;
  if (on) state.loadErr = null;
  for (const c of state.charts) {
    c.loading = on;
    if (on) c.loadErr = null;
    chartRefreshTag(c);
  }
}

function chartsSetError(state, msg) {
  state.loadErr = msg || null;
  for (const c of state.charts) { c.loadErr = state.loadErr; chartRefreshTag(c); }
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

    const chart = { group, logY, bpc, u: null, body: panel.querySelector(".chart-body"), panel,
                    loading: !!state.loading, loadErr: state.loadErr || null };
    panel.querySelector(".chart-last").innerHTML = chartLastHtml(state, chart);
    chartRefreshTag(chart);

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
        chart.loading = true; chart.loadErr = null; chartRefreshTag(chart);
        try {
          mergeMetrics(state, await fetchMetricsChunked(state.runId, stateNeededKeys(state)));
        } catch (e2) {
          chart.loadErr = String(e2 && e2.message || e2);
        }
        chart.loading = false; chartRefreshTag(chart);
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
    chart.loading = true; chart.loadErr = null; chartRefreshTag(chart);
    try {
      mergeMetrics(state, await fetchMetricsChunked(state.runId,
        neededKeys(state.groups, state.collapsed, chart.group.name)));
    } catch (e) {
      chart.loadErr = String(e && e.message || e);
    }
    chart.loading = false;
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
  chartRefreshTag(chart);  // body swapped: re-create the status tag
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
  try {
    mergeMetrics(state, await fetchMetricsChunked(state.runId, stateNeededKeys(state)));
    chartsSetError(state, null);
  } catch (e) {
    chartsSetError(state, String(e && e.message || e));
  }
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
  // uPlot may render a row for the x series; detect and skip it so rows
  // align with the per-key series
  const perKey = state.showRaw ? 2 : 1;
  const offset = rows.length - chart.group.keys.length * perKey;
  rows.forEach((tr, i) => {
    const si = i - offset;
    if (si < 0) return;  // x-axis row: inert
    const key = chart.group.keys[Math.floor(si / perKey)];
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
  const { segs, params } = parseHash();
  if (segs[0] === "setpw") { viewSetPw(segs[1] || ""); return; }
  if (authConfig.auth_enabled && !getToken()) { showLogin(); return; }
  renderAuthBox();
  app.innerHTML = `<div class="loading">loading…</div>`;
  try {
    if (segs.length === 0) await viewLanding();
    else if (segs[0] === "models" && segs.length === 1) await viewModels(params.q || "");
    else if (segs[0] === "models") await viewModelDetail(segs[1], params);
    else if (segs[0] === "runs" && segs.length === 1) await viewAllRuns(params);
    else if (segs[0] === "runs") await viewRunDetail(parseInt(segs[1]));
    else if (segs[0] === "compare") {
      const ids = (params.ids || "").split(",").filter(Boolean).map(Number);
      await viewCompare(ids);
    }
    else app.innerHTML = `<div class="empty">unknown page</div>`;
    updateCompareBar();
  } catch (e) {
    if (e instanceof AuthError) return;  // login view already shown
    app.innerHTML = `<div class="empty">error: ${esc(e.message)}</div>`;
  }
}

async function boot() {
  try {
    authConfig = await api("/api/config");
  } catch { /* auth disabled or server unreachable */ }
  renderAuthBox();
  route();
}

window.addEventListener("hashchange", route);
boot();
