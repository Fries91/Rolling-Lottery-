// ==UserScript==
// @name         Fries91's Giveaway
// @namespace    Fries91.Torn.RollingGiveaway
// @version      1.0.10
// @description  Free-entry rolling giveaway overlay for Torn. Overview, Entry, Admin tabs.
// @author       Fries91
// @match        https://www.torn.com/*
// @match        https://*.torn.com/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      sinner-s-lottery.onrender.com
// @connect      raw.githubusercontent.com
// @connect      *
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/Fries91/Rolling-Lottery-/main/static/rolling-giveaway.user.js
// @updateURL    https://raw.githubusercontent.com/Fries91/Rolling-Lottery-/main/static/rolling-giveaway.user.js
// ==/UserScript==

(function () {
  "use strict";

  const API_BASE = "https://sinner-s-lottery.onrender.com";
  const LS_KEY = "fries91_giveaway_session_v1";
  const KEY_KEY = "fries91_giveaway_api_key_v1";

  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let state = null;
  let user = null;
  let activeTab = "overview";
  let loading = false;

  function api(path, opts = {}) {
    const token = localStorage.getItem(LS_KEY) || "";
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: opts.method || "GET",
        url: API_BASE + path,
        headers: {
          "Content-Type": "application/json",
          "X-Giveaway-Session": token
        },
        data: opts.body ? JSON.stringify(opts.body) : undefined,
        timeout: 20000,
        onload: (res) => {
          const text = String(res.responseText || "").trim();
          try {
            const json = JSON.parse(text || "{}");
            if (!json.ok) {
              const details = json.detail ? " — " + json.detail : "";
              return reject(new Error((json.error || "Request failed") + details));
            }
            resolve(json);
          } catch (e) {
            if (res.status >= 500) return reject(new Error("Backend server error " + res.status + ". Check Render logs."));
            if (res.status === 404) return reject(new Error("Backend not found. Check Render URL."));
            reject(new Error("Backend did not return JSON. Test " + API_BASE + "/api/health"));
          }
        },
        onerror: () => reject(new Error("Network error")),
        ontimeout: () => reject(new Error("Request timed out"))
      });
    });
  }

  function money(n) {
    return "$" + Number(n || 0).toLocaleString();
  }

  function drawDate(ts) {
    if (!ts) return "Not set";
    return new Date(Number(ts) * 1000).toLocaleString();
  }

  function statusPill(status) {
    const s = String(status || "none").toLowerCase();
    return `<span class="fg-status fg-status-${esc(s)}">${esc(s.toUpperCase())}</span>`;
  }

  function isAdmin() {
    return !!(user && user.is_admin) || !!(state && state.is_admin);
  }

  function ensureButton() {
    if ($("#fries-giveaway-topbar")) return;
    const bar = document.createElement("button");
    bar.id = "fries-giveaway-topbar";
    bar.type = "button";
    bar.title = "Open Fries91's Giveaway";
    bar.innerHTML = `
      <span class="fg-top-icon">🏆</span>
      <span class="fg-top-text">FRIES91'S GIVEAWAY</span>
      <span class="fg-top-marquee">Free rolling giveaway • Approval required</span>
    `;
    bar.addEventListener("click", togglePanel);
    document.body.appendChild(bar);
  }

  function ensurePanel() {
    if ($("#fries-giveaway-panel")) return;
    const panel = document.createElement("div");
    panel.id = "fries-giveaway-panel";
    panel.innerHTML = `
      <div class="fg-head">
        <div>
          <div class="fg-title">🎁 Fries91's Giveaway</div>
          <div class="fg-sub">Free entry • Admin approval required</div>
        </div>
        <button class="fg-close">×</button>
      </div>
      <div class="fg-tabs">
        <button data-tab="overview">Overview</button>
        <button data-tab="entry">Entry</button>
        <button data-tab="admin" class="fg-admin-tab">Admin</button>
      </div>
      <div class="fg-body"></div>
    `;
    document.body.appendChild(panel);
    $(".fg-close", panel).addEventListener("click", () => panel.classList.remove("open"));
    panel.querySelectorAll("[data-tab]").forEach(btn => {
      btn.addEventListener("click", () => {
        activeTab = btn.dataset.tab;
        render();
      });
    });
  }

  async function togglePanel() {
    ensurePanel();
    const panel = $("#fries-giveaway-panel");
    panel.classList.toggle("open");
    if (panel.classList.contains("open")) {
      if (!state) await refresh();
      else render();
    }
  }

  function setTabClasses() {
    const panel = $("#fries-giveaway-panel");
    if (!panel) return;
    const adminTab = $(".fg-admin-tab", panel);
    if (adminTab) adminTab.style.display = isAdmin() ? "" : "none";
    if (activeTab === "admin" && !isAdmin()) activeTab = "overview";
    panel.querySelectorAll("[data-tab]").forEach(btn => btn.classList.toggle("active", btn.dataset.tab === activeTab));
  }

  async function refresh() {
    if (loading) return;
    loading = true;
    ensurePanel();
    try {
      $(".fg-body").innerHTML = `<div class="fg-card"><b>Loading...</b><span>Checking giveaway status.</span></div>`;
      const res = await api("/api/state");
      state = res.giveaway;
      user = res.user || null;
      render();
    } catch (e) {
      renderError(e.message);
    } finally {
      loading = false;
    }
  }

  function renderError(msg) {
    $(".fg-body").innerHTML = `
      <div class="fg-card bad">
        <b>Error</b>
        <span>${esc(msg)}</span>
        <p class="fg-muted">Test backend: ${esc(API_BASE)}/api/health</p>
        <button class="fg-secondary" id="fg-retry">Retry</button>
      </div>
    `;
    $("#fg-retry")?.addEventListener("click", refresh);
  }

  function render() {
    if (!state) return refresh();
    setTabClasses();
    if (activeTab === "overview") return renderOverview();
    if (activeTab === "entry") return renderEntry();
    if (activeTab === "admin" && isAdmin()) return renderAdmin();
    return renderOverview();
  }

  function renderOverview() {
    const g = state;
    setTabClasses();
    $(".fg-body").innerHTML = `
      <div class="fg-hero">
        <div class="fg-kicker">${esc(g.status).toUpperCase()}</div>
        <h2>${esc(g.title || "Fries91's Giveaway")}</h2>
        <div class="fg-big">${money(g.total_pool)}</div>
        <div class="fg-muted">Current pot • Approved entries only</div>
      </div>

      <div class="fg-grid">
        <div class="fg-card"><b>Player Prize 60%</b><span>${money(g.player_cut)}</span></div>
        <div class="fg-card"><b>Approved Entries</b><span>${g.approved_entry_count}</span></div>
        <div class="fg-card"><b>Pending Entries</b><span>${g.pending_entry_count}</span></div>
        <div class="fg-card"><b>Rejected Entries</b><span>${g.rejected_entry_count}</span></div>
        <div class="fg-card"><b>Entry Value</b><span>${money(g.entry_item_value)}</span></div>
        <div class="fg-card"><b>Rollover 20%</b><span>${money(g.rollover_cut)}</span></div>
      </div>

      <div class="fg-card">
        <b>Pot Formula</b>
        <span>Base ${money(g.base_payout)} + Approved Entries ${g.approved_entry_count} × ${money(g.entry_item_value)} = ${money(g.total_pool)}</span>
      </div>

      ${g.winner_name ? `
        <div class="fg-card win">
          <b>Last Winner</b>
          <span>${esc(g.winner_name)} [${esc(g.winner_player_id)}]</span>
        </div>
      ` : ""}

      ${g.is_admin ? `
        <div class="fg-card private">
          <b>Admin Only</b>
          <span>Tier/Admin 20%: ${money(g.reserve_cut)}</span>
        </div>
      ` : ""}

      <button class="fg-secondary" id="fg-refresh">Refresh</button>
    `;
    $("#fg-refresh").addEventListener("click", refresh);
  }

  function renderEntry() {
    setTabClasses();
    const savedKey = localStorage.getItem(KEY_KEY) || "";
    const entryStatus = state.entry_status ? statusPill(state.entry_status) : `<span class="fg-muted">Not entered</span>`;

    $(".fg-body").innerHTML = `
      <div class="fg-card">
        <b>Login</b>
        <p>Use your Torn API key so the app can confirm your Torn name and ID.</p>
        ${user ? `<p class="fg-muted">Logged in as ${esc(user.name)} [${esc(user.player_id)}]${user.is_admin ? " • Admin" : ""}</p>` : ""}
        <input class="fg-input" id="fg-api-key" placeholder="Paste Torn API key" value="${esc(savedKey)}">
        <button class="fg-primary" id="fg-login">Login / Save Key</button>
      </div>

      <div class="fg-card">
        <b>Entry Status</b>
        <p>${entryStatus}</p>
        <p class="fg-muted">Entries are submitted as pending. Only admin-approved entries count toward the draw and pot.</p>
      </div>

      <div class="fg-card">
        <b>Your Entry</b>
        <p>${state.entered ? "You already submitted an entry request." : "You have not submitted an entry request yet."}</p>
        <button class="fg-primary" id="fg-enter">${state.entered ? "Entry Submitted" : "Submit Entry Request"}</button>
      </div>
    `;

    $("#fg-login").addEventListener("click", async () => {
      const key = $("#fg-api-key").value.trim();
      localStorage.setItem(KEY_KEY, key);
      try {
        const res = await api("/api/login", { method: "POST", body: { api_key: key } });
        localStorage.setItem(LS_KEY, res.token);
        await refresh();
        activeTab = res.user?.is_admin ? "admin" : "entry";
        render();
      } catch (e) {
        alert(e.message);
      }
    });

    $("#fg-enter").addEventListener("click", async () => {
      try {
        await api("/api/enter", { method: "POST", body: {} });
        await refresh();
      } catch (e) {
        alert(e.message);
      }
    });
  }

  function renderAdmin() {
    if (!isAdmin()) {
      activeTab = "overview";
      return renderOverview();
    }

    setTabClasses();
    const drawVal = state.draw_at ? new Date(state.draw_at * 1000).toISOString().slice(0, 16) : "";
    $(".fg-body").innerHTML = `
      <div class="fg-card private">
        <b>Admin Pot Controls</b>
        <label>Title</label>
        <input class="fg-input" id="fg-title" value="${esc(state.title || "Fries91's Giveaway")}">

        <label>Prize Label</label>
        <input class="fg-input" id="fg-prize-label" value="${esc(state.prize_label)}">

        <label>Starting Payout / Base Pot</label>
        <input class="fg-input" id="fg-base-payout" type="number" value="${esc(state.base_payout)}">

        <label>Entry Item Name</label>
        <input class="fg-input" id="fg-entry-item-name" value="${esc(state.entry_item_name)}">

        <label>Entry Item Value</label>
        <input class="fg-input" id="fg-entry-item-value" type="number" value="${esc(state.entry_item_value)}">

        <label>Rollover Pool</label>
        <input class="fg-input" id="fg-rollover" type="number" value="${esc(state.rollover_pool)}">

        <label>Draw Time</label>
        <input class="fg-input" id="fg-draw-at" type="datetime-local" value="${esc(drawVal)}">

        <div class="fg-split">
          <div>Approved Entries: <b>${state.approved_entry_count}</b></div>
          <div>Pending Entries: <b>${state.pending_entry_count}</b></div>
          <div>Base Payout: <b>${money(state.base_payout)}</b></div>
          <div>Approved × Value: <b>${state.approved_entry_count} × ${money(state.entry_item_value)} = ${money(state.entry_growth_total)}</b></div>
          <div>Total Pot: <b>${money(state.total_pool)}</b></div>
          <div>Player 60%: <b>${money(state.player_cut)}</b></div>
          <div>Rollover 20%: <b>${money(state.rollover_cut)}</b></div>
          <div>Tier/Admin 20%: <b>${money(state.reserve_cut)}</b></div>
        </div>

        <button class="fg-primary" id="fg-save">Save Settings</button>
        <button class="fg-secondary" id="fg-open">Open Giveaway</button>
        <button class="fg-secondary" id="fg-close-giveaway">Close Giveaway</button>
        <button class="fg-warn" id="fg-draw">Draw Winner</button>
        <button class="fg-secondary" id="fg-roll">Start New Roll</button>
      </div>

      <div class="fg-card">
        <b>Entry Approvals</b>
        <button class="fg-secondary" id="fg-load-entries">Load Entries</button>
        <div id="fg-entries"></div>
      </div>
    `;

    $("#fg-save").addEventListener("click", saveAdmin);
    $("#fg-roll").addEventListener("click", rollAdmin);
    $("#fg-draw").addEventListener("click", drawAdmin);
    $("#fg-load-entries").addEventListener("click", loadEntries);
    $("#fg-open").addEventListener("click", () => setStatus("open"));
    $("#fg-close-giveaway").addEventListener("click", () => setStatus("closed"));
  }

  function adminPayload() {
    const dt = $("#fg-draw-at").value;
    const draw_at = dt ? Math.floor(new Date(dt).getTime() / 1000) : null;
    return {
      title: $("#fg-title").value.trim(),
      prize_label: $("#fg-prize-label").value.trim(),
      base_payout: Number($("#fg-base-payout").value || 0),
      entry_item_name: $("#fg-entry-item-name").value.trim(),
      entry_item_value: Number($("#fg-entry-item-value").value || 0),
      rollover_pool: Number($("#fg-rollover").value || 0),
      draw_at
    };
  }

  async function saveAdmin() {
    try {
      await api("/api/admin/giveaway", { method: "POST", body: adminPayload() });
      await refresh();
    } catch (e) {
      alert(e.message);
    }
  }

  async function setStatus(status) {
    try {
      await api("/api/admin/status", { method: "POST", body: { status } });
      await refresh();
    } catch (e) {
      alert(e.message);
    }
  }

  async function setEntryStatus(entryId, status) {
    try {
      await api("/api/admin/entry-status", { method: "POST", body: { entry_id: entryId, status } });
      await refresh();
      activeTab = "admin";
      render();
      await loadEntries();
    } catch (e) {
      alert(e.message);
    }
  }

  async function rollAdmin() {
    try {
      await api("/api/admin/roll", { method: "POST", body: adminPayload() });
      await refresh();
    } catch (e) {
      alert(e.message);
    }
  }

  async function drawAdmin() {
    try {
      const res = await api("/api/admin/draw", { method: "POST", body: {} });
      alert("Winner: " + res.winner.name + " [" + res.winner.player_id + "]");
      await refresh();
    } catch (e) {
      alert(e.message);
    }
  }

  async function loadEntries() {
    try {
      const res = await api("/api/admin/entries");
      $("#fg-entries").innerHTML = res.entries.length
        ? res.entries.map(x => `
          <div class="fg-entry">
            <div><b>${esc(x.name)} [${esc(x.player_id)}]</b></div>
            <div>${statusPill(x.status)}</div>
            <div class="fg-entry-actions">
              <button data-approve="${x.id}" class="fg-mini good">Approve</button>
              <button data-reject="${x.id}" class="fg-mini badbtn">Reject</button>
              <button data-pending="${x.id}" class="fg-mini">Pending</button>
            </div>
          </div>
        `).join("")
        : `<div class="fg-muted">No entries yet.</div>`;

      $("#fg-entries").querySelectorAll("[data-approve]").forEach(b => b.addEventListener("click", () => setEntryStatus(Number(b.dataset.approve), "approved")));
      $("#fg-entries").querySelectorAll("[data-reject]").forEach(b => b.addEventListener("click", () => setEntryStatus(Number(b.dataset.reject), "rejected")));
      $("#fg-entries").querySelectorAll("[data-pending]").forEach(b => b.addEventListener("click", () => setEntryStatus(Number(b.dataset.pending), "pending")));
    } catch (e) {
      alert(e.message);
    }
  }

  GM_addStyle(`
    #fries-giveaway-topbar {
      position: fixed; top: 0; left: 0; right: 0; z-index: 999998;
      min-height: 34px; width: 100%; border: 0; border-bottom: 1px solid rgba(255,255,255,.16);
      background: linear-gradient(90deg,#18111f,#321d50,#18111f);
      color: #fff; cursor: pointer; display: flex; align-items: center; justify-content: center;
      gap: 10px; padding: 6px 12px; box-shadow: 0 5px 18px rgba(0,0,0,.35);
      font-family: Arial, sans-serif; overflow: hidden;
    }
    .fg-top-icon { width: 24px; height: 24px; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center; background: radial-gradient(circle at 35% 20%,#ffeaa5,#b77414 60%,#6b3a08); color: #1b1205; font-size: 15px; flex: 0 0 auto; }
    .fg-top-text { font-weight: 900; text-transform: uppercase; letter-spacing: .08em; font-size: 13px; color: #ffe9a8; text-shadow: 0 1px 1px rgba(0,0,0,.7); flex: 0 0 auto; }
    .fg-top-marquee { color: #d9d1f5; font-size: 12px; white-space: nowrap; opacity: .95; overflow: hidden; text-overflow: ellipsis; }
    #fries-giveaway-panel { position: fixed; right: 12px; top: 46px; z-index: 999999; width: min(430px, calc(100vw - 24px)); max-height: calc(100vh - 58px); display: none; overflow: hidden; border-radius: 18px; background: #11131a; color: #f4f2ff; border: 1px solid rgba(255,255,255,.16); box-shadow: 0 18px 60px rgba(0,0,0,.55); font-family: Arial, sans-serif; }
    #fries-giveaway-panel.open { display: block; }
    .fg-head { display:flex; align-items:center; justify-content:space-between; padding: 14px; background: linear-gradient(135deg,#1b102b,#301a50); }
    .fg-title { font-weight: 800; font-size: 18px; }
    .fg-sub, .fg-muted { color: #c8c0dc; font-size: 12px; }
    .fg-close { background: transparent; color: white; border: 0; font-size: 28px; cursor:pointer; }
    .fg-tabs { display:flex; gap: 6px; padding: 10px; background:#151722; border-bottom:1px solid rgba(255,255,255,.1); }
    .fg-tabs button { flex:1; padding: 9px 8px; border-radius: 10px; border:1px solid rgba(255,255,255,.12); background:#202333; color:#e9e3ff; cursor:pointer; }
    .fg-tabs button.active { background:#6b38b6; border-color:#9c6cff; }
    .fg-body { padding: 12px; overflow:auto; max-height: calc(100vh - 180px); }
    .fg-hero { padding:18px; border-radius:18px; background: radial-gradient(circle at top left,#7143bd,#21152f 55%); border:1px solid rgba(255,255,255,.16); margin-bottom: 10px; }
    .fg-kicker { font-size:11px; letter-spacing:.1em; color:#d7c6ff; }
    .fg-hero h2 { margin: 8px 0; font-size: 22px; }
    .fg-big { font-size: 32px; font-weight: 900; }
    .fg-grid { display:grid; grid-template-columns:1fr 1fr; gap: 10px; }
    .fg-card { background:#191c28; border:1px solid rgba(255,255,255,.12); border-radius:16px; padding:12px; margin-bottom:10px; }
    .fg-card b { display:block; margin-bottom:6px; }
    .fg-card span { display:block; font-size:14px; color:#f4f2ff; }
    .fg-card.private { border-color: rgba(255,210,90,.5); background: #251f14; }
    .fg-card.win { border-color: rgba(90,255,170,.4); background:#13251d; }
    .fg-card.bad { border-color: rgba(255,90,90,.45); background:#2b1518; }
    .fg-input { width:100%; box-sizing:border-box; padding:10px; margin:7px 0 10px; border-radius:10px; border:1px solid rgba(255,255,255,.18); background:#0e1017; color:white; }
    .fg-primary, .fg-secondary, .fg-warn { width:100%; padding:10px; margin:5px 0; border-radius:12px; border:0; color:white; font-weight:800; cursor:pointer; }
    .fg-primary { background:#6b38b6; }
    .fg-secondary { background:#2f3447; }
    .fg-warn { background:#a15b13; }
    .fg-split { display:grid; gap:6px; background:#11131a; border-radius:12px; padding:10px; margin:10px 0; }
    .fg-entry { padding:10px; border:1px solid rgba(255,255,255,.1); border-radius:12px; margin:8px 0; background:#11131a; }
    .fg-entry-actions { display:grid; grid-template-columns:1fr 1fr 1fr; gap:6px; margin-top:8px; }
    .fg-mini { padding:7px; border:0; border-radius:9px; background:#2f3447; color:white; font-weight:800; }
    .fg-mini.good { background:#176b3a; }
    .fg-mini.badbtn { background:#7a2020; }
    .fg-status { display:inline-block; padding:4px 8px; border-radius:999px; font-size:11px; font-weight:900; margin:3px 0; }
    .fg-status-approved { background:#154f2e; color:#9affc3; }
    .fg-status-pending { background:#5a4315; color:#ffe49a; }
    .fg-status-rejected { background:#5a1717; color:#ff9a9a; }
    @media (max-width: 520px) {
      #fries-giveaway-topbar { min-height: 36px; padding: 6px 8px; gap: 7px; }
      .fg-top-text { font-size: 12px; }
      .fg-top-marquee { font-size: 11px; max-width: 45vw; }
      #fries-giveaway-panel { right: 8px; left: 8px; width: auto; top: 48px; max-height: calc(100vh - 60px); }
      .fg-grid { grid-template-columns:1fr; }
    }
  `);

  ensureButton();
})();
