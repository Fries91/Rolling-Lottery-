// ==UserScript==
// @name         Fries91's Giveaway
// @namespace    Fries91.Torn.RollingGiveaway
// @version      1.0.28
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

  function fmtTime(ts) {
    if (!ts) return "Not set";
    return new Date(Number(ts) * 1000).toLocaleString();
  }

  function countdownText(ts) {
    if (!ts) return "No end time";
    const diff = Number(ts) * 1000 - Date.now();
    if (diff <= 0) return "Ended";
    const mins = Math.floor(diff / 60000);
    const hrs = Math.floor(mins / 60);
    const days = Math.floor(hrs / 24);
    if (days > 0) return `${days}d ${hrs % 24}h`;
    if (hrs > 0) return `${hrs}h ${mins % 60}m`;
    return `${Math.max(0, mins)}m`;
  }

  function statusPill(status) {
    const s = String(status || "none").toLowerCase();
    return `<span class="fg-status fg-status-${esc(s)}">${esc(s.toUpperCase())}</span>`;
  }

  function isAdmin() {
    return !!(user && user.is_admin) || !!(state && state.is_admin);
  }

  function updateTopbarJackpot() {
    const el = $(".fg-top-marquee");
    if (!el) return;
    if (state && typeof state.total_pool !== "undefined") {
      el.textContent = "Current Jackpot: " + money(state.total_pool);
    } else {
      el.textContent = "Current Jackpot loading...";
    }
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
      <span class="fg-top-marquee">Current Jackpot loading...</span>
    `;
    bar.addEventListener("click", togglePanel);
    document.body.appendChild(bar);
    updateTopbarJackpot();
    silentTopbarRefresh();
  }

  function ensurePanel() {
    if ($("#fries-giveaway-panel")) return;
    const panel = document.createElement("div");
    panel.id = "fries-giveaway-panel";
    panel.innerHTML = `
      <div class="fg-head">
        <div>
          <div class="fg-title">🎁 Fries91's Giveaway</div>
          <div class="fg-sub">Rolling jackpot • Admin approval required</div>
        </div>
        <button class="fg-close">×</button>
      </div>
      <div class="fg-tabs">
        <button data-tab="overview">Overview</button>
        <button data-tab="entry">Entry</button>
        <button data-tab="points">Points</button>
        <button data-tab="winners">Winners</button>
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

  async function silentTopbarRefresh() {
    try {
      if (state) return updateTopbarJackpot();
      const res = await api("/api/state");
      state = res.giveaway;
      user = res.user || null;
      updateTopbarJackpot();
    } catch (e) {
      // keep launcher quiet if backend is sleeping
    }
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
      updateTopbarJackpot();
      render();
      checkAdminWinnerNotifications();
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
    if (activeTab === "points") return renderPoints();
    if (activeTab === "winners") return renderWinners();
    if (activeTab === "admin" && isAdmin()) return renderAdmin();
    return renderOverview();
  }

  async function checkAdminWinnerNotifications() {
    try {
      if (!isAdmin()) return;
      const res = await api("/api/admin/winner-notifications");
      const winners = res.winners || [];
      const seenKey = "fries91_giveaway_seen_winners_v1";
      const seen = new Set(JSON.parse(localStorage.getItem(seenKey) || "[]"));
      const fresh = winners.filter(w => !seen.has(String(w.id)));
      if (fresh.length) {
        const msg = fresh.map(w => `#${w.id} ${w.title}: ${w.winner_name} [${w.winner_player_id}]`).join("\\n");
        alert("New event winner(s):\\n" + msg + "\\n\\nCheck Winners tab and send reward.");
        fresh.forEach(w => seen.add(String(w.id)));
        localStorage.setItem(seenKey, JSON.stringify([...seen].slice(-100)));
      }
    } catch (e) {}
  }

  function renderOverview() {
    const g = state;
    setTabClasses();
    $(".fg-body").innerHTML = `
      <div class="fg-hero">
        <div class="fg-kicker">${esc(g.status).toUpperCase()}</div>
        <h2>${esc(g.title || "Fries91's Giveaway")}</h2>
        <div class="fg-big">${money(g.total_pool)}</div>
        <div class="fg-subline">Players Cut: ${money(g.player_cut)}</div>
        <div class="fg-subline small">Next Pot: ${money(g.next_starting_jackpot || g.rollover_cut || 0)}</div>
      </div>

      <div id="fg-event-overview-boxes"></div>
      <button class="fg-secondary" id="fg-refresh">Refresh</button>
    `;
    $("#fg-refresh").addEventListener("click", refresh);
    renderEventOverviewBoxes();
    updateTopbarJackpot();
  }

  async function renderEventOverviewBoxes() {
    try {
      const res = await api("/api/draws");
      const box = $("#fg-event-overview-boxes");
      if (!box) return;

      const nowSec = Math.floor(Date.now() / 1000);
      const events = (res.draws || [])
        .filter(d => (d.draw_type || "rolling") === "event")
        .filter(d => !d.winner_name)
        .filter(d => d.status !== "drawn" && d.status !== "deleted")
        .filter(d => d.status === "closed" || !d.end_at || Number(d.end_at) > nowSec)
        .slice(0, 5);
      if (!events.length) {
        box.innerHTML = "";
        return;
      }

      box.innerHTML = `
        <div class="fg-section-title">Other Events</div>
        ${events.map((d, idx) => `
          <div class="fg-card fg-event-card fg-event-color-${idx % 5}">
            <b>#${esc(d.id)} — ${esc(d.title)}</b>
            <span>Prize: ${esc(d.event_prize || d.prize_label || "Prize")}</span>
            <span>Cost: ${esc(d.point_cost || 1)} point(s)</span>
            <span>Max per player: ${esc(d.max_entries_per_player || 1)}</span>
            <span>Starts: ${esc(fmtTime(d.start_at))}</span>
            <span>Ends: ${esc(fmtTime(d.end_at))} • ${esc(countdownText(d.end_at))}</span>
            <span>Entered: ${esc(d.total_entry_count || d.entry_count || 0)}</span>
            ${d.status === "closed" ? `<span class="fg-preview-line">Pending</span>` : ""}
            <span>Status: ${d.status === "closed" ? "Pending" : esc(d.status)}</span>
            ${d.winner_name ? `<span class="fg-winner-line">Winner: ${esc(d.winner_name)} [${esc(d.winner_player_id)}] — Admin send reward</span>` : ""}
          </div>
        `).join("")}
      `;
    } catch (e) {
      // silent overview failure
    }
  }

  function renderEntry() {
    setTabClasses();
    const savedKey = localStorage.getItem(KEY_KEY) || "";
    const entryStatus = state.entry_status
      ? `${statusPill(state.entry_status)} ${state.user_entry?.points_spent ? `<span class="fg-muted">• ${esc(state.user_entry.points_spent)} pts requested</span>` : ""}`
      : `<span class="fg-muted">Not entered</span>`;

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
        <p class="fg-muted">Entries are automatic. Points are deducted when you enter.</p>
      </div>

      <div class="fg-card">
        <b>Your Entry</b>
        <p>Select which draw you want to enter.</p>
        <select class="fg-input" id="fg-entry-draw-select">
          <option value="">Loading draws...</option>
        </select>
        <p id="fg-selected-entry-status" class="fg-muted"></p>
        <label>Points to Use</label>
        <input class="fg-input" id="fg-entry-points" type="number" min="1" value="1">
        <p class="fg-muted">Enter at least the draw cost. Extra points can add extra weight. Points are deducted when you submit the entry request.</p>
        <button class="fg-primary" id="fg-enter">Enter Draw</button>
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

    loadEntryDraws();

    $("#fg-enter").addEventListener("click", async () => {
      try {
        const drawId = Number($("#fg-entry-draw-select")?.value || 0);
        if (!drawId) return alert("Pick an open draw first.");
        const pointsSpent = Number($("#fg-entry-points")?.value || 0);
        if (pointsSpent <= 0) return alert("Enter at least 1 point.");
        await api("/api/enter", { method: "POST", body: { draw_id: drawId, points_spent: pointsSpent } });
        await refresh();
      } catch (e) {
        alert(e.message);
      }
    });
  }

  async function renderPoints() {
    setTabClasses();

    if (!user) {
      const savedKey = localStorage.getItem(KEY_KEY) || "";
      $(".fg-body").innerHTML = `
        <div class="fg-card">
          <b>Points Login</b>
          <p>Login first to view your free points balance.</p>
          <input class="fg-input" id="fg-points-api-key" placeholder="Paste Torn API key" value="${esc(savedKey)}">
          <button class="fg-primary" id="fg-points-login">Login / Save Key</button>
        </div>
      `;
      $("#fg-points-login").addEventListener("click", async () => {
        const key = $("#fg-points-api-key").value.trim();
        localStorage.setItem(KEY_KEY, key);
        try {
          const res = await api("/api/login", { method: "POST", body: { api_key: key } });
          localStorage.setItem(LS_KEY, res.token);
          await refresh();
          activeTab = "points";
          render();
        } catch (e) {
          alert(e.message);
        }
      });
      return;
    }

    $(".fg-body").innerHTML = `<div class="fg-card"><b>Loading Points...</b><span>Checking your free point balance.</span></div>`;

    try {
      const res = await api("/api/points");
      const p = res.points || {};
      $(".fg-body").innerHTML = `
        <div class="fg-hero">
          <div class="fg-kicker">FREE POINTS</div>
          <h2>${esc(user.name)} [${esc(user.player_id)}]</h2>
          <div class="fg-big">${Number(p.balance || 0).toLocaleString()} pts</div>
          <div class="fg-muted">Points are free credits. They cannot be bought, sold, traded, or exchanged.</div>
        </div>

        <div class="fg-card">
          <b>Daily Free Claim</b>
          <p>${res.claimed_today ? "You already claimed today's free point." : "Claim 1 free point today."}</p>
          <button class="fg-primary" id="fg-claim-daily" ${res.claimed_today ? "disabled" : ""}>${res.claimed_today ? "Claimed Today" : "Claim 1 Free Point"}</button>
        </div>

        <div class="fg-card">
          <b>Request Points</b>
          <p class="fg-muted">Ask admin for free points. Admin approval is required before points are added.</p>
          <label>Amount Requested</label>
          <input class="fg-input" id="fg-request-points-amount" type="number" min="1" placeholder="Example: 10">
          <label>Reason</label>
          <input class="fg-input" id="fg-request-points-reason" placeholder="Example: event participation">
          <button class="fg-primary" id="fg-request-points-submit">Send Point Request</button>
          <button class="fg-secondary" id="fg-load-my-point-requests">My Requests</button>
          <div id="fg-my-point-requests"></div>
        </div>

        <div class="fg-card">
          <b>Point History</b>
          <div id="fg-point-history">
            ${
              (res.ledger || []).length
                ? res.ledger.map(x => `<div class="fg-entry"><b>${Number(x.delta) > 0 ? "+" : ""}${esc(x.delta)} pts</b><br><span>${esc(x.reason)}</span></div>`).join("")
                : `<div class="fg-muted">No point history yet.</div>`
            }
          </div>
        </div>
      `;

      $("#fg-claim-daily")?.addEventListener("click", async () => {
        try {
          await api("/api/points/claim-daily", { method: "POST", body: {} });
          await refresh();
          activeTab = "points";
          render();
        } catch (e) {
          alert(e.message);
        }
      });

      $("#fg-request-points-submit")?.addEventListener("click", submitPointRequest);
      $("#fg-load-my-point-requests")?.addEventListener("click", loadMyPointRequests);
    } catch (e) {
      renderError(e.message);
    }
  }


  async function loadEntryDraws() {
    try {
      const res = await api("/api/draws");
      const sel = $("#fg-entry-draw-select");
      if (!sel) return;

      const draws = (res.draws || []).filter(d => d.status === "open");
      sel.innerHTML = draws.length
        ? draws.map(d => `<option value="${esc(d.id)}">#${esc(d.id)} • ${esc(d.title)} • Prize: ${esc(d.event_prize || d.prize_label || "Prize")} • Cost: ${esc(d.point_cost || 1)} pt(s) • Max: ${esc(d.max_entries_per_player || 1)} • Max: ${esc(d.max_entries_per_player || 1)}</option>`).join("")
        : `<option value="">No open draws</option>`;

      $("#fg-selected-entry-status").textContent = draws.length
        ? "Entries go in right away. Points are deducted when submitted."
        : "No open draws are available right now.";
    } catch (e) {
      const sel = $("#fg-entry-draw-select");
      if (sel) sel.innerHTML = `<option value="">Could not load draws</option>`;
    }
  }

  async function submitPointRequest() {
    try {
      const amount = Number($("#fg-request-points-amount")?.value || 0);
      const reason = $("#fg-request-points-reason")?.value.trim() || "";
      if (!amount || amount <= 0) return alert("Enter a point amount.");

      await api("/api/points/request", {
        method: "POST",
        body: { amount, reason }
      });

      alert("Point request sent to admin for approval.");
      await loadMyPointRequests();
    } catch (e) {
      alert(e.message);
    }
  }

  async function loadMyPointRequests() {
    try {
      const res = await api("/api/points/requests");
      const box = $("#fg-my-point-requests");
      if (!box) return;

      box.innerHTML = (res.requests || []).length
        ? res.requests.map(r => `<div class="fg-entry"><b>${esc(r.amount)} pts</b> ${statusPill(r.status)}<br><span>${esc(r.reason || "No reason")}</span></div>`).join("")
        : `<div class="fg-muted">No point requests yet.</div>`;
    } catch (e) {
      alert(e.message);
    }
  }


  async function renderWinners() {
    setTabClasses();
    $(".fg-body").innerHTML = `<div class="fg-card"><b>Loading winners...</b></div>`;
    try {
      const res = await api("/api/winners");
      const winners = res.winners || [];
      $(".fg-body").innerHTML = `
        <div class="fg-hero">
          <div class="fg-kicker">WINNERS</div>
          <h2>Finished Draws</h2>
          <div class="fg-muted">Winners from completed events and jackpot draws.</div>
        </div>
        ${
          winners.length
            ? winners.map((w, idx) => `
              <div class="fg-card fg-event-card fg-event-color-${idx % 5}">
                <b>#${esc(w.id)} — ${esc(w.title)}</b>
                <span>Prize: ${esc(w.event_prize || w.prize_label || "Prize")}</span>
                <span class="fg-winner-line">Winner: ${esc(w.winner_name)} [${esc(w.winner_player_id)}]</span>
                <span>Status: ${esc(w.status)}</span>
                ${w.draw_type === "event" ? `<span>Event ended: ${esc(fmtTime(w.end_at))}</span>` : ""}
              </div>
            `).join("")
            : `<div class="fg-card"><b>No winners yet</b><span>Finished event winners will show here.</span></div>`
        }
      `;
    } catch (e) {
      renderError(e.message);
    }
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
        <b>Rolling Jackpot Controls</b>
        <label>Title</label>
        <input class="fg-input" id="fg-title" value="${esc(state.title || "Fries91's Giveaway")}">

        <label>Prize Label</label>
        <input class="fg-input" id="fg-prize-label" value="${esc(state.prize_label)}">

        <label>Starting Jackpot</label>
        <input class="fg-input" id="fg-base-payout" type="number" value="${esc(state.base_payout)}">

        <label>Entry Item Name</label>
        <input class="fg-input" id="fg-entry-item-name" value="${esc(state.entry_item_name)}">

        <label>Entry Item Value</label>
        <input class="fg-input" id="fg-entry-item-value" type="number" value="${esc(state.entry_item_value)}">

        <label>Draw Time</label>
        <input class="fg-input" id="fg-draw-at" type="datetime-local" value="${esc(drawVal)}">

        <div class="fg-split">
          <div>Approved Entries: <b>${state.approved_entry_count}</b></div>
          <div>Pending Entries: <b>${state.pending_entry_count}</b></div>
          <div>Starting Jackpot: <b>${money(state.base_payout)}</b></div>
          <div>Approved Points × Value: <b>${state.approved_points_total || 0} × ${money(state.entry_item_value)} = ${money(state.entry_growth_total)}</b></div>
          <div>Rolling Jackpot: <b>${money(state.total_pool)}</b></div>
          <div>Player 60%: <b>${money(state.player_cut)}</b></div>
          <div>Rollover 20%: <b>${money(state.rollover_cut)}</b></div>
          <div>Next Starting Jackpot: <b>${money(state.next_starting_jackpot || state.rollover_cut)}</b></div>
          <div>Tier/Admin 20%: <b>${money(state.reserve_cut)}</b></div>
        </div>

        <button class="fg-primary" id="fg-save">Save Settings</button>
        <button class="fg-secondary" id="fg-open">Open Giveaway</button>
        <button class="fg-secondary" id="fg-close-giveaway">Close Giveaway</button>
        <button class="fg-warn" id="fg-draw">Draw Winner</button>
        <button class="fg-secondary" id="fg-roll">Start Next Roll From Rollover</button>
      </div>

      <div class="fg-card private">
        <b>Add Points</b>
        <label>Player ID</label>
        <input class="fg-input" id="fg-add-points-player-id" type="number" placeholder="Torn player ID">
        <label>Player Name</label>
        <input class="fg-input" id="fg-add-points-player-name" placeholder="Optional name">
        <label>Points to Add</label>
        <input class="fg-input" id="fg-add-points-amount" type="number" min="1" placeholder="Example: 10">
        <label>Reason</label>
        <input class="fg-input" id="fg-add-points-reason" value="admin free points">
        <button class="fg-primary" id="fg-add-points-save">Add Points</button>
      </div>

      <div class="fg-card private">
        <b>Remove Points</b>
        <label>Player ID</label>
        <input class="fg-input" id="fg-remove-points-player-id" type="number" placeholder="Torn player ID">
        <label>Player Name</label>
        <input class="fg-input" id="fg-remove-points-player-name" placeholder="Optional name">
        <label>Points to Remove</label>
        <input class="fg-input" id="fg-remove-points-amount" type="number" min="1" placeholder="Example: 5">
        <label>Reason</label>
        <input class="fg-input" id="fg-remove-points-reason" value="admin removed points">
        <button class="fg-warn" id="fg-remove-points-save">Remove Points</button>
      </div>

      <div class="fg-card private">
        <b>Point Requests</b>
        <button class="fg-secondary" id="fg-load-point-requests">Load Point Requests</button>
        <div id="fg-point-requests"></div>
      </div>

      <div class="fg-card private">
        <b>Point Balances</b>
        <button class="fg-secondary" id="fg-points-load">Load Balances</button>
        <div id="fg-points-balances"></div>
      </div>

      <div class="fg-card private">
        <b>Other Events / Draws</b>
        <p class="fg-muted">5 event slots. Create saves a pending preview on Overview. Activate opens it for 1 week. Use Test Event below for custom start/end.</p>
        <button class="fg-secondary" id="fg-load-draws">Refresh Event Slots</button>
        <div id="fg-event-slots"></div>

        <div class="fg-card fg-event-slot" id="fg-test-event-box">
          <b>Test Event</b>
          <p class="fg-muted">Use this to test start/end countdown and auto winner quickly.</p>
          <label>Test Event Title</label>
          <input class="fg-input" id="fg-test-title" value="Test Event">
          <label>Prize</label>
          <input class="fg-input" id="fg-test-prize" value="Test Prize">
          <label>Cost of Entry Per Point</label>
          <input class="fg-input" id="fg-test-point-cost" type="number" min="1" value="1">
          <label>Max Entries/Points Per Player</label>
          <input class="fg-input" id="fg-test-max" type="number" min="1" value="1">
          <label>Start Time</label>
          <input class="fg-input" id="fg-test-start" type="datetime-local">
          <label>End Time</label>
          <input class="fg-input" id="fg-test-end" type="datetime-local">
          <button class="fg-primary" id="fg-create-test-event">Create Test Event</button>
        </div>

        <div id="fg-draws-list" style="display:none"></div>
      </div>
    `;

    $("#fg-save").addEventListener("click", saveAdmin);
    $("#fg-roll").addEventListener("click", rollAdmin);
    $("#fg-draw").addEventListener("click", drawAdmin);
    $("#fg-add-points-save")?.addEventListener("click", adminAddPoints);
    $("#fg-remove-points-save")?.addEventListener("click", adminRemovePoints);
    $("#fg-points-load")?.addEventListener("click", adminLoadPoints);
    $("#fg-load-point-requests")?.addEventListener("click", adminLoadPointRequests);
    $("#fg-load-draws")?.addEventListener("click", renderEventSlots);
    renderEventSlots();
    $("#fg-create-test-event")?.addEventListener("click", createTestEvent);
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
      rollover_pool: 0,
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
      const res = await api("/api/admin/roll", { method: "POST", body: adminPayload() });
      alert("Next roll started. New starting jackpot: " + money(res.next_base_payout || 0));
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
            <div>${statusPill(x.status)} <span class="fg-muted">• ${esc(x.points_spent || 1)} pts</span></div>
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

  async function adminAddPoints() {
    try {
      const playerId = Number($("#fg-add-points-player-id").value || 0);
      const name = $("#fg-add-points-player-name").value.trim();
      const amount = Number($("#fg-add-points-amount").value || 0);
      const reason = $("#fg-add-points-reason").value.trim() || "admin free points";

      if (!playerId) return alert("Enter a player ID.");
      if (!amount || amount <= 0) return alert("Enter a positive point amount.");

      const res = await api("/api/admin/points", {
        method: "POST",
        body: { player_id: playerId, name, amount, reason }
      });

      alert("Added points. New balance: " + res.balance + " pts");
      await adminLoadPoints();
    } catch (e) {
      alert(e.message);
    }
  }

  async function adminRemovePoints() {
    try {
      const playerId = Number($("#fg-remove-points-player-id").value || 0);
      const name = $("#fg-remove-points-player-name").value.trim();
      const amount = Number($("#fg-remove-points-amount").value || 0);
      const reason = $("#fg-remove-points-reason").value.trim() || "admin removed points";

      if (!playerId) return alert("Enter a player ID.");
      if (!amount || amount <= 0) return alert("Enter a positive point amount.");

      const res = await api("/api/admin/points", {
        method: "POST",
        body: { player_id: playerId, name, amount: -Math.abs(amount), reason }
      });

      alert("Removed points. New balance: " + res.balance + " pts");
      await adminLoadPoints();
    } catch (e) {
      alert(e.message);
    }
  }

  async function adminLoadPointRequests() {
    try {
      const res = await api("/api/admin/points/requests");
      const box = $("#fg-point-requests");
      if (!box) return;

      box.innerHTML = (res.requests || []).length
        ? res.requests.map(r => `
          <div class="fg-entry">
            <div><b>${esc(r.name)} [${esc(r.player_id)}]</b></div>
            <div>${esc(r.amount)} pts ${statusPill(r.status)}</div>
            <div class="fg-muted">${esc(r.reason || "No reason")}</div>
            ${r.status === "pending" ? `
              <div class="fg-entry-actions">
                <button data-point-approve="${r.id}" class="fg-mini good">Approve</button>
                <button data-point-reject="${r.id}" class="fg-mini badbtn">Reject</button>
              </div>
            ` : ""}
          </div>
        `).join("")
        : `<div class="fg-muted">No point requests.</div>`;

      box.querySelectorAll("[data-point-approve]").forEach(b => b.addEventListener("click", () => adminReviewPointRequest(Number(b.dataset.pointApprove), "approve")));
      box.querySelectorAll("[data-point-reject]").forEach(b => b.addEventListener("click", () => adminReviewPointRequest(Number(b.dataset.pointReject), "reject")));
    } catch (e) {
      alert(e.message);
    }
  }

  async function adminReviewPointRequest(requestId, action) {
    try {
      await api("/api/admin/points/requests", {
        method: "POST",
        body: { request_id: requestId, action }
      });
      await adminLoadPointRequests();
      await adminLoadPoints();
    } catch (e) {
      alert(e.message);
    }
  }


  async function adminLoadPoints() {
    try {
      const res = await api("/api/admin/points");
      const box = $("#fg-points-balances");
      box.innerHTML = (res.balances || []).length
        ? res.balances.map(x => `<div class="fg-entry"><b>${esc(x.name)} [${esc(x.player_id)}]</b><br><span>${esc(x.balance)} pts</span></div>`).join("")
        : `<div class="fg-muted">No point balances yet.</div>`;
    } catch (e) {
      alert(e.message);
    }
  }


  function eventSlotHtml(slotNum, event) {
    const title = event?.title || `Event Slot ${slotNum}`;
    const prize = event?.event_prize || event?.prize_label || "";
    const pointCost = event?.point_cost || 1;
    const maxEntries = event?.max_entries_per_player || 1;
    const idLine = event ? `#${event.id} • ${event.status === "closed" ? "Pending" : event.status}` : "Empty slot";
    const endLine = event?.end_at ? `Ends: ${fmtTime(event.end_at)} • ${countdownText(event.end_at)}` : "Not activated";

    return `
      <div class="fg-card fg-event-slot fg-event-color-${(slotNum - 1) % 5}" data-slot="${slotNum}" data-draw-id="${event?.id || ""}">
        <b>Event ${slotNum}</b>
        <div class="fg-muted">${esc(idLine)}</div>
        <div class="fg-muted">${esc(endLine)}</div>

        <label>Event Title</label>
        <input class="fg-input" id="fg-event-${slotNum}-title" value="${esc(title)}">

        <label>Prize</label>
        <input class="fg-input" id="fg-event-${slotNum}-prize" value="${esc(prize)}" placeholder="Prize">

        <label>Cost of Entry Per Point</label>
        <input class="fg-input" id="fg-event-${slotNum}-point-cost" type="number" min="1" value="${esc(pointCost)}">

        <label>Max Entries/Points Per Player</label>
        <input class="fg-input" id="fg-event-${slotNum}-max" type="number" min="1" value="${esc(maxEntries)}">

        ${event?.winner_name ? `<div class="fg-winner-line">Winner: ${esc(event.winner_name)} [${esc(event.winner_player_id)}]</div>` : ""}

        <div class="fg-slot-actions">
          <button class="fg-mini good" data-slot-save="${slotNum}">${event ? "Update" : "Create"}</button>
          <button class="fg-mini good" data-slot-open="${slotNum}" ${event ? "" : "disabled"}>Activate 1 Week</button>
          <button class="fg-mini" data-slot-close="${slotNum}" ${event ? "" : "disabled"}>Disable</button>
          <button class="fg-mini" data-slot-clear="${slotNum}" ${event ? "" : "disabled"}>Clear</button>
          <button class="fg-mini badbtn" data-slot-delete="${slotNum}" ${event ? "" : "disabled"}>Delete</button>
        </div>
      </div>
    `;
  }

  async function createTestEvent() {
    try {
      const startVal = $("#fg-test-start")?.value || "";
      const endVal = $("#fg-test-end")?.value || "";
      const start_at = startVal ? Math.floor(new Date(startVal).getTime() / 1000) : null;
      const end_at = endVal ? Math.floor(new Date(endVal).getTime() / 1000) : null;

      if (!start_at) return alert("Pick test start time.");
      if (!end_at) return alert("Pick test end time.");
      if (end_at <= start_at) return alert("End time must be after start time.");

      const payload = {
        title: $("#fg-test-title")?.value.trim() || "Test Event",
        prize_label: $("#fg-test-prize")?.value.trim() || "Test Prize",
        event_prize: $("#fg-test-prize")?.value.trim() || "Test Prize",
        point_cost: Number($("#fg-test-point-cost")?.value || 1),
        max_entries_per_player: Number($("#fg-test-max")?.value || 1),
        base_payout: 0,
        entry_item_name: "Free Points/Event",
        entry_item_value: 0,
        rollover_pool: 0,
        status: "open",
        draw_type: "event",
        start_at,
        end_at
      };

      const res = await api("/api/admin/draws", { method: "POST", body: payload });
      alert("Created test event #" + res.draw_id);
      await refresh();
      activeTab = "overview";
      render();
    } catch (e) {
      alert(e.message);
    }
  }

  async function renderEventSlots() {
    try {
      const res = await api("/api/draws");
      const box = $("#fg-event-slots");
      if (!box) return;

      const events = (res.draws || [])
        .filter(d => (d.draw_type || "rolling") === "event")
        .slice(0, 5);

      box.innerHTML = [1, 2, 3, 4, 5].map(i => eventSlotHtml(i, events[i - 1])).join("");

      box.querySelectorAll("[data-slot-save]").forEach(b => b.addEventListener("click", () => saveEventSlot(Number(b.dataset.slotSave))));
      box.querySelectorAll("[data-slot-open]").forEach(b => b.addEventListener("click", () => setSlotStatus(Number(b.dataset.slotOpen), "open")));
      box.querySelectorAll("[data-slot-close]").forEach(b => b.addEventListener("click", () => setSlotStatus(Number(b.dataset.slotClose), "closed")));
      box.querySelectorAll("[data-slot-clear]").forEach(b => b.addEventListener("click", () => clearSlot(Number(b.dataset.slotClear))));
      box.querySelectorAll("[data-slot-delete]").forEach(b => b.addEventListener("click", () => deleteSlot(Number(b.dataset.slotDelete))));
    } catch (e) {
      alert(e.message);
    }
  }

  function slotPayload(slotNum) {
    return {
      title: $(`#fg-event-${slotNum}-title`)?.value.trim() || `Event Slot ${slotNum}`,
      prize_label: $(`#fg-event-${slotNum}-prize`)?.value.trim() || "Event Prize",
      event_prize: $(`#fg-event-${slotNum}-prize`)?.value.trim() || "Event Prize",
      point_cost: Number($(`#fg-event-${slotNum}-point-cost`)?.value || 1),
      max_entries_per_player: Number($(`#fg-event-${slotNum}-max`)?.value || 1),
      base_payout: 0,
      entry_item_name: "Free Points/Event",
      entry_item_value: 0,
      rollover_pool: 0,
      status: "closed",
      draw_type: "event",
      start_at: null,
      end_at: null
    };
  }

  function slotDrawId(slotNum) {
    return Number($(`.fg-event-slot[data-slot="${slotNum}"]`)?.dataset.drawId || 0);
  }

  async function saveEventSlot(slotNum) {
    try {
      const drawId = slotDrawId(slotNum);
      const payload = slotPayload(slotNum);
      if (!payload.point_cost || payload.point_cost < 1) return alert("Cost must be at least 1 point.");
      if (!payload.max_entries_per_player || payload.max_entries_per_player < 1) return alert("Max entries must be at least 1.");
      if (drawId) {
        await api("/api/admin/draws/update", { method: "POST", body: { ...payload, draw_id: drawId } });
        alert("Updated event #" + drawId + ". Pending preview refreshed on Overview.");
      } else {
        const res = await api("/api/admin/draws", { method: "POST", body: payload });
        alert("Created event #" + res.draw_id + ". It is closed and showing as Pending on Overview.");
      }

      await refresh();
      activeTab = "overview";
      render();
    } catch (e) {
      alert(e.message);
    }
  }

  async function setSlotStatus(slotNum, status) {
    const drawId = slotDrawId(slotNum);
    if (!drawId) return alert("No event in this slot.");
    if (status === "open") {
      const res = await api("/api/admin/draws/activate", {
        method: "POST",
        body: { draw_id: drawId, duration_seconds: 7 * 24 * 60 * 60 }
      });
      alert("Event activated for 1 week. Ends: " + fmtTime(res.end_at));
    } else {
      await setDrawStatus(drawId, status);
    }
    await renderEventSlots();
    await refresh();
  }

  async function clearSlot(slotNum) {
    const drawId = slotDrawId(slotNum);
    if (!drawId) return alert("No event in this slot.");
    await clearDraw(drawId);
    await renderEventSlots();
  }

  async function deleteSlot(slotNum) {
    const drawId = slotDrawId(slotNum);
    if (!drawId) return alert("No event in this slot.");
    await deleteDraw(drawId);
    await renderEventSlots();
  }


  async function createDrawFromSettings() {
    try {
      const title = $("#fg-event-title")?.value.trim() || "Other Event Draw";
      const eventPrize = $("#fg-event-prize")?.value.trim() || "Event Prize";
      const pointCost = Number($("#fg-event-point-cost")?.value || 1);
      const maxEntries = Number($("#fg-event-max-entries")?.value || 1);
      const base = 0;
      const entryValue = 0;
      const eventStart = $("#fg-event-start")?.value ? Math.floor(new Date($("#fg-event-start").value).getTime() / 1000) : null;
      const eventEnd = $("#fg-event-end")?.value ? Math.floor(new Date($("#fg-event-end").value).getTime() / 1000) : null;

      if (!title) return alert("Enter an event title.");
      if (!eventPrize) return alert("Enter a prize.");
      if (!pointCost || pointCost < 1) return alert("Cost of entry must be at least 1 point.");
      if (!maxEntries || maxEntries < 1) return alert("Max entries must be at least 1.");
      if (!eventStart) return alert("Pick a start time.");
      if (!eventEnd) return alert("Pick an end time.");
      if (eventEnd <= eventStart) return alert("End time must be after start time.");

      const res = await api("/api/admin/draws", {
        method: "POST",
        body: {
          title,
          prize_label: eventPrize,
          event_prize: eventPrize,
          point_cost: pointCost,
          base_payout: base,
          entry_item_name: "Free Points/Event",
          entry_item_value: entryValue,
          rollover_pool: 0,
          status: "open",
          draw_type: "event",
          start_at: eventStart,
          end_at: eventEnd,
          max_entries_per_player: maxEntries
        }
      });

      alert("Created event draw #" + res.draw_id + ". It will now show on Overview.");
      await refresh();
      activeTab = "overview";
      render();
    } catch (e) {
      alert(e.message);
    }
  }

  async function loadDraws() {
    try {
      const res = await api("/api/draws");
      const box = $("#fg-draws-list");
      if (!box) return;

      box.innerHTML = (res.draws || []).length
        ? res.draws.map(d => `
          <div class="fg-entry">
            <div><b>#${esc(d.id)} — ${esc(d.title)}</b></div>
            <div>${statusPill(d.status)}</div>
            <div class="fg-muted">Prize: ${esc(d.event_prize || d.prize_label || "Prize")} • Cost: ${esc(d.point_cost || 1)} pt(s) • Max: ${esc(d.max_entries_per_player || 1)}</div>
            <div class="fg-muted">Starts: ${esc(fmtTime(d.start_at))} • Ends: ${esc(fmtTime(d.end_at))} • ${esc(countdownText(d.end_at))}</div>
            <div class="fg-muted">Jackpot: ${money(d.total_pool)} • Approved: ${esc(d.approved_entry_count || d.entry_count || 0)} • Points: ${esc(d.approved_points_total || 0)} • Pending: ${esc(d.pending_entry_count || 0)}</div>
            ${d.winner_name ? `<div class="fg-winner-line">Winner: ${esc(d.winner_name)} [${esc(d.winner_player_id)}] — Give reward</div>` : ""}
            <div class="fg-muted">Next Start: ${money(d.next_starting_jackpot || d.rollover_cut || 0)}</div>
            <div class="fg-entry-actions">
              <button data-draw-open="${d.id}" class="fg-mini good">Open</button>
              <button data-draw-close="${d.id}" class="fg-mini">Close</button>
              <button data-draw-clear="${d.id}" class="fg-mini">Clear</button>
              <button data-draw-delete="${d.id}" class="fg-mini badbtn">Delete</button>
            </div>
          </div>
        `).join("")
        : `<div class="fg-muted">No draws found.</div>`;

      box.querySelectorAll("[data-draw-open]").forEach(b => b.addEventListener("click", () => setDrawStatus(Number(b.dataset.drawOpen), "open")));
      box.querySelectorAll("[data-draw-close]").forEach(b => b.addEventListener("click", () => setDrawStatus(Number(b.dataset.drawClose), "closed")));
      box.querySelectorAll("[data-draw-clear]").forEach(b => b.addEventListener("click", () => clearDraw(Number(b.dataset.drawClear))));
      box.querySelectorAll("[data-draw-delete]").forEach(b => b.addEventListener("click", () => deleteDraw(Number(b.dataset.drawDelete))));
    } catch (e) {
      alert(e.message);
    }
  }

  async function setDrawStatus(drawId, status) {
    try {
      await api("/api/admin/draws/status", { method: "POST", body: { draw_id: drawId, status } });
      await refresh();
      activeTab = "admin";
      render();
      await loadDraws();
    } catch (e) {
      alert(e.message);
    }
  }

  async function clearDraw(drawId) {
    if (!confirm("Clear event draw #" + drawId + "? This removes its entries and winner and closes it.")) return;
    try {
      await api("/api/admin/draws/clear", { method: "POST", body: { draw_id: drawId } });
      await refresh();
      activeTab = "admin";
      render();
      await loadDraws();
    } catch (e) {
      alert(e.message);
    }
  }

  async function deleteDraw(drawId) {
    if (!confirm("Delete draw #" + drawId + "? This hides it from the app.")) return;
    try {
      await api("/api/admin/draws/delete", { method: "POST", body: { draw_id: drawId } });
      await refresh();
      activeTab = "admin";
      render();
      await loadDraws();
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
    .fg-subline { margin-top:6px; font-size:16px; font-weight:800; color:#f4f2ff; }
    .fg-subline.small { font-size:13px; color:#c8c0dc; }
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
    .fg-primary:disabled { opacity:.55; cursor:not-allowed; }
    .fg-secondary { background:#2f3447; }
    .fg-warn { background:#a15b13; }
    .fg-split { display:grid; gap:6px; background:#11131a; border-radius:12px; padding:10px; margin:10px 0; }
    .fg-entry { padding:10px; border:1px solid rgba(255,255,255,.1); border-radius:12px; margin:8px 0; background:#11131a; }
    .fg-section-title { font-weight:900; margin:14px 0 8px; color:#ffe9a8; }
    .fg-event-card { border-width:1px; }
    .fg-event-card span { margin:3px 0; }
    .fg-event-color-0 { background:#142326; border-color:#3bb7c9; }
    .fg-event-color-1 { background:#261f14; border-color:#d49b3f; }
    .fg-event-color-2 { background:#1d1426; border-color:#ad70d6; }
    .fg-event-color-3 { background:#14261b; border-color:#55bf78; }
    .fg-event-color-4 { background:#261417; border-color:#d65f73; }
    .fg-winner-line { color:#9affc3 !important; font-weight:900; }
    .fg-preview-line { color:#ffe49a !important; font-weight:900; }
    .fg-entry-actions { display:grid; grid-template-columns:1fr 1fr 1fr 1fr; gap:6px; margin-top:8px; }
    .fg-slot-actions { display:grid; grid-template-columns:1fr 1fr 1fr 1fr 1fr; gap:6px; margin-top:8px; }
    .fg-event-slot { margin-top:10px; }
    .fg-mini { padding:7px; border:0; border-radius:9px; background:#2f3447; color:white; font-weight:800; }
    .fg-mini:disabled { opacity:.45; cursor:not-allowed; }
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
