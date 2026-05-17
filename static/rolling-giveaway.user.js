// ==UserScript==
// @name         Fries91's Giveaway
// @namespace    Fries91.Torn.RollingGiveaway
// @version      1.0.55
// @description  Free-entry rolling giveaway overlay for Torn. Overview, Points, Rules, Winners, Admin tabs.
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

  function pointRowsHtml(conversion) {
    const c = conversion || {};
    const base = Math.max(1, Number(c.base_value || 850000));
    const items = c.items || [];
    if (!items.length) {
      return `<div class="fg-muted">No items set yet.</div>`;
    }
    return `
      <table class="fg-point-table">
        <thead><tr><th>Item</th><th>Value</th><th>Points</th></tr></thead>
        <tbody>
          ${items.map(item => `
            <tr>
              <td>${esc(item.name)}</td>
              <td>${money(item.value)}</td>
              <td><b>${Number(item.points || 0).toLocaleString()} pts</b></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  }


  function conversionOptionsHtml(conversion) {
    const items = (conversion && conversion.items) || [];
    return items.map(item => `<option value="${esc(item.name)}" data-value="${esc(item.value)}">${esc(item.name)} — ${money(item.value)} = ${esc(item.points)} pts</option>`).join("");
  }

  function calcRequestPreview(conversion) {
    const sel = $("#fg-request-item");
    const qtyEl = $("#fg-request-item-qty");
    const box = $("#fg-request-preview");
    if (!sel || !qtyEl || !box) return;
    const itemName = sel.value;
    const qty = Math.max(1, Number(qtyEl.value || 1));
    const c = conversion || {};
    const base = Math.max(1, Number(c.base_value || 820000));
    const item = ((c.items || []).find(x => String(x.name) === String(itemName))) || null;
    if (!item) {
      box.innerHTML = `<span class="fg-muted">Pick an item.</span>`;
      return;
    }
    const total = Number(item.value || 0) * qty;
    const pts = Math.floor(total / base);
    box.innerHTML = `
      <div class="fg-calc-line"><b>${esc(qty)} × ${esc(item.name)}</b><span>${money(total)}</span></div>
      <div class="fg-calc-line"><b>Points</b><span>${pts.toLocaleString()} pts</span></div>
      <div class="fg-warnline">Send item(s) to Fries91 [3679030], then tap Verify within 10 minutes.</div>
    `;
  }

  function requestTimeLeft(expiresAt) {
    if (!expiresAt) return "10 minutes";
    const diff = Number(expiresAt) * 1000 - Date.now();
    if (diff <= 0) return "Expired";
    const mins = Math.floor(diff / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    return `${mins}:${String(secs).padStart(2, "0")} left`;
  }

  function requestIsExpired(r) {
    return r.expires_at && (Number(r.expires_at) * 1000 <= Date.now());
  }

  function requestLine(r) {
    const itemBits = r.item_name
      ? `${esc(r.item_qty || 1)} × ${esc(r.item_name)} • ${money(r.total_value || 0)} → ${esc(r.amount)} pts`
      : `${esc(r.amount)} pts`;
    const open = (r.status === "pending_payment" || r.status === "pending") && !requestIsExpired(r);
    const verifyBtn = open
      ? `<button data-verify-request="${esc(r.id)}" class="fg-mini good">Verify</button>`
      : "";
    const expiryLine = (r.status === "pending_payment" || r.status === "pending")
      ? `<div class="fg-warnline">Time left: ${esc(requestTimeLeft(r.expires_at))}</div>`
      : "";
    return `
      <div class="fg-entry">
        <b>${itemBits}</b>
        <div>${statusPill(requestIsExpired(r) && (r.status === "pending_payment" || r.status === "pending") ? "expired" : r.status)}</div>
        ${expiryLine}
        ${r.verify_note ? `<div class="fg-muted">${esc(r.verify_note)}</div>` : ""}
        ${r.matched_log_id ? `<div class="fg-muted">Matched log: ${esc(r.matched_log_id)}</div>` : ""}
        ${verifyBtn ? `<div class="fg-entry-actions one">${verifyBtn}</div>` : ""}
      </div>
    `;
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

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 40 && r.height > 8 && r.bottom > 0 && r.top < window.innerHeight;
  }

  function findTornPageHeaderMount() {
    const selectors = [
      "#mainContainer",
      "#main-container",
      "#content",
      "#content-wrapper",
      ".content-wrapper",
      ".contentWrapper",
      ".main-content",
      ".mainContent",
      "main",
      "[class*='content-wrapper']",
      "[class*='ContentWrapper']"
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.isConnected && !el.closest("#fries-giveaway-panel") && !el.closest("#fries-giveaway-page-header")) {
        return el;
      }
    }

    const title = Array.from(document.querySelectorAll("h1,h2,.title,[class*='title'],[class*='Title']"))
      .find(el => isVisible(el) && !el.closest("#fries-giveaway-panel") && !el.closest("#fries-giveaway-page-header"));
    if (title && title.parentElement && title.parentElement.parentElement) {
      return title.parentElement.parentElement;
    }

    return document.body;
  }

  function mountGiveawayPageHeader() {
    if (!document.body) return false;

    let header = $("#fries-giveaway-page-header");
    if (!header) {
      header = document.createElement("div");
      header.id = "fries-giveaway-page-header";
      header.innerHTML = `
        <button id="fries-giveaway-topbar" type="button" title="Open Fries91's Giveaway">
          <span class="fg-top-icon">🏆</span>
          <span class="fg-top-text">FRIES91'S GIVEAWAY</span>
          <span class="fg-top-marquee">Current Jackpot loading...</span>
        </button>
      `;
      header.querySelector("#fries-giveaway-topbar")?.addEventListener("click", togglePanel);
    }

    const mount = findTornPageHeaderMount();
    if (!mount) return false;

    if (header.parentElement !== mount || mount.firstChild !== header) {
      mount.insertBefore(header, mount.firstChild || null);
    }
    return true;
  }

  function ensureButton() {
    const mounted = mountGiveawayPageHeader();
    if (mounted) {
      updateTopbarJackpot();
      silentTopbarRefresh();
    }
  }


  function makePanelDraggable(panel) {
    if (!panel || panel.dataset.dragReady === "1") return;
    panel.dataset.dragReady = "1";
    const head = panel.querySelector(".fg-head");
    if (!head) return;

    const saved = JSON.parse(localStorage.getItem("fries91_giveaway_panel_pos_v1") || "null");
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      panel.style.setProperty("left", Math.max(6, Math.min(saved.left, window.innerWidth - 80)) + "px", "important");
      panel.style.setProperty("top", Math.max(6, Math.min(saved.top, window.innerHeight - 80)) + "px", "important");
      panel.style.setProperty("right", "auto", "important");
      panel.style.setProperty("transform", "none", "important");
    }

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    const getPoint = (ev) => ev.touches && ev.touches[0] ? ev.touches[0] : ev;

    const down = (ev) => {
      if (ev.target && ev.target.closest && ev.target.closest("button,input,select,textarea")) return;
      const pt = getPoint(ev);
      const rect = panel.getBoundingClientRect();
      dragging = true;
      startX = pt.clientX;
      startY = pt.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      panel.classList.add("fg-dragging");
      panel.style.setProperty("left", rect.left + "px", "important");
      panel.style.setProperty("top", rect.top + "px", "important");
      panel.style.setProperty("right", "auto", "important");
      panel.style.setProperty("transform", "none", "important");
      ev.preventDefault();
    };

    const move = (ev) => {
      if (!dragging) return;
      const pt = getPoint(ev);
      const rect = panel.getBoundingClientRect();
      const maxLeft = Math.max(6, window.innerWidth - rect.width - 6);
      const maxTop = Math.max(6, window.innerHeight - 70);
      const left = Math.max(6, Math.min(maxLeft, startLeft + pt.clientX - startX));
      const top = Math.max(6, Math.min(maxTop, startTop + pt.clientY - startY));
      panel.style.setProperty("left", left + "px", "important");
      panel.style.setProperty("top", top + "px", "important");
      ev.preventDefault();
    };

    const up = () => {
      if (!dragging) return;
      dragging = false;
      panel.classList.remove("fg-dragging");
      const rect = panel.getBoundingClientRect();
      localStorage.setItem("fries91_giveaway_panel_pos_v1", JSON.stringify({ left: Math.round(rect.left), top: Math.round(rect.top) }));
    };

    head.addEventListener("mousedown", down);
    head.addEventListener("touchstart", down, { passive: false });
    window.addEventListener("mousemove", move, { passive: false });
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("mouseup", up);
    window.addEventListener("touchend", up);
  }

  function ensurePanel() {
    if ($("#fries-giveaway-panel")) return;
    const panel = document.createElement("div");
    panel.id = "fries-giveaway-panel";
    panel.innerHTML = `
      <div class="fg-head">
        <div>
          <div class="fg-title">🎁 Fries91's Giveaway</div>
          <div class="fg-sub">Monthly rolling jackpot • Points entry</div>
        </div>
        <button class="fg-close">×</button>
      </div>
      <div class="fg-tabs">
        <button data-tab="overview">Overview</button>
        <button data-tab="points">Points</button>
        <button data-tab="rules">Rules</button>
        <button data-tab="winners">Winners</button>
        <button data-tab="admin" class="fg-admin-tab">Admin</button>
      </div>
      <div class="fg-body"></div>
    `;
    document.body.appendChild(panel);
    makePanelDraggable(panel);
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
    if (activeTab === "entry") activeTab = "overview";
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
    if (activeTab === "points") return renderPoints();
    if (activeTab === "rules") return renderRules();
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
    const openRolling = g.status === "open" && !g.winner_name;
    const minCost = Number(g.point_cost || 1);
    const maxCost = Number(g.max_entries_per_player || 999999);
    $(".fg-body").innerHTML = `
      <div class="fg-hero">
        <div class="fg-kicker">${esc(g.status).toUpperCase()}</div>
        <h2>${esc(g.title || "Fries91's Giveaway")}</h2>
        <div class="fg-big">${money(g.total_pool)}</div>
        <div class="fg-subline">Players Cut: ${money(g.player_cut)}</div>
        <div class="fg-subline small">Next Pot: ${money(g.next_starting_jackpot || g.rollover_cut || 0)}</div>
        <div class="fg-subline small">Ends: ${esc(fmtTime(g.end_at || g.draw_at))} • ${esc(countdownText(g.end_at || g.draw_at))}</div>
        ${openRolling ? `
          <div class="fg-overview-entry-box fg-rolling-entry-box">
            <b>Enter Rolling Jackpot</b>
            <label>Points to use</label>
            <input class="fg-input" id="fg-rolling-entry-points" type="number" min="${esc(minCost)}" max="${esc(maxCost)}" value="${esc(minCost)}">
            <div class="fg-muted">Min ${esc(minCost)} point(s) to enter.</div>
            <button class="fg-primary" id="fg-enter-rolling-jackpot">Enter Rolling Jackpot</button>
          </div>
        ` : ""}
      </div>

      <div id="fg-event-overview-boxes"></div>
      <button class="fg-secondary" id="fg-refresh">Refresh</button>
    `;
    $("#fg-refresh").addEventListener("click", refresh);
    $("#fg-enter-rolling-jackpot")?.addEventListener("click", enterRollingJackpot);
    renderEventOverviewBoxes();
    updateTopbarJackpot();
  }

  async function enterRollingJackpot() {
    if (!user) {
      alert("Login from the Rules tab before entering.");
      activeTab = "rules";
      render();
      return;
    }
    const pointsSpent = Number($("#fg-rolling-entry-points")?.value || 0);
    if (pointsSpent <= 0) return alert("Enter at least 1 point.");
    try {
      await api("/api/enter", { method: "POST", body: { draw_id: state.id, points_spent: pointsSpent } });
      alert(`Entered rolling jackpot with ${pointsSpent} point(s).`);
      await refresh();
    } catch (e) {
      alert(e.message);
    }
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
            ${d.status === "open" && !d.winner_name ? `
              <div class="fg-overview-entry-box">
                <label>Points to use</label>
                <input class="fg-input fg-overview-entry-points" data-draw-id="${esc(d.id)}" type="number" min="${esc(d.point_cost || 1)}" max="${esc(d.max_entries_per_player || 1)}" value="${esc(d.point_cost || 1)}">
                <div class="fg-muted">Min ${esc(d.point_cost || 1)} • Max ${esc(d.max_entries_per_player || 1)}</div>
                <button class="fg-primary fg-overview-enter-btn" data-draw-id="${esc(d.id)}" data-title="${esc(d.title)}">Enter This Event</button>
              </div>
            ` : ""}
          </div>
        `).join("")}
      `;
      attachOverviewEntryHandlers();
    } catch (e) {
      // silent overview failure
    }
  }

  function attachOverviewEntryHandlers() {
    document.querySelectorAll(".fg-overview-enter-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!user) {
          alert("Login from the Rules tab before entering events.");
          activeTab = "rules";
          render();
          return;
        }
        const drawId = Number(btn.dataset.drawId || 0);
        const title = btn.dataset.title || "this event";
        const input = document.querySelector(`.fg-overview-entry-points[data-draw-id="${drawId}"]`);
        const pointsSpent = Number(input?.value || 0);
        if (!drawId) return alert("Could not read event ID.");
        if (pointsSpent <= 0) return alert("Enter at least 1 point.");
        try {
          btn.disabled = true;
          btn.textContent = "Entering...";
          await api("/api/enter", { method: "POST", body: { draw_id: drawId, points_spent: pointsSpent } });
          alert(`Entered ${title} with ${pointsSpent} point(s).`);
          await refresh();
        } catch (e) {
          alert(e.message);
          btn.disabled = false;
          btn.textContent = "Enter This Event";
        }
      });
    });
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
        <p class="fg-muted">API key login is now in the Rules tab at the bottom.</p>
        <button class="fg-secondary" id="fg-go-rules-login">Open Rules / Login</button>
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
        <p class="fg-muted">Enter at least the draw cost. Points are deducted when you submit.</p>
        <button class="fg-primary" id="fg-enter">Enter Draw</button>
      </div>
    `;
$("#fg-go-rules-login")?.addEventListener("click", () => {
      activeTab = "rules";
      render();
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
      $(".fg-body").innerHTML = `
        <div class="fg-card">
          <b>Login Required</b>
          <p class="fg-muted">Login with your API key from the Rules tab before viewing points.</p>
          <button class="fg-secondary" id="fg-points-go-rules">Open Rules / Login</button>
        </div>
      `;
      $("#fg-points-go-rules")?.addEventListener("click", () => {
        activeTab = "rules";
        render();
      });
      return;
    }

    $(".fg-body").innerHTML = `<div class="fg-card"><b>Loading Points...</b><span>Checking your free point balance.</span></div>`;

    try {
      const res = await api("/api/points");
      const p = res.points || {};
      $(".fg-body").innerHTML = `
        <div class="fg-hero">
          <h2>${esc(user.name)} [${esc(user.player_id)}]</h2>
          <div class="fg-big">${Number(p.balance || 0).toLocaleString()} pts</div>
          <div class="fg-muted">Points are credits for giveaway/event entries.</div>
        </div>

        <div class="fg-card">
          <b>Item → Points</b>
          ${pointRowsHtml(res.conversion)}
        </div>

        <div class="fg-card">
          <b>Request Points</b>
          <label>Item Sent</label>
          <select class="fg-input" id="fg-request-item">
            ${conversionOptionsHtml(res.conversion)}
          </select>
          <label>How Many</label>
          <input class="fg-input" id="fg-request-item-qty" type="number" min="1" value="1">
          <div id="fg-request-preview" class="fg-mini-preview"></div>
          <div class="fg-warning-box">You get 10 minutes after sending this request to send item(s) and verify.</div>
          <button class="fg-primary" id="fg-request-points-submit">Send Request</button>
          <button class="fg-secondary" id="fg-load-my-point-requests">My Requests</button>
          <div id="fg-my-point-requests"></div>
        </div>

        <details class="fg-card fg-details">
          <summary>Point History</summary>
          <div id="fg-point-history">
            ${
              (res.ledger || []).length
                ? res.ledger.map(x => `<div class="fg-entry"><b>${Number(x.delta) > 0 ? "+" : ""}${esc(x.delta)} pts</b><br><span>${esc(x.reason)}</span></div>`).join("")
                : `<div class="fg-muted">No point history yet.</div>`
            }
          </div>
        </details>
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

      $("#fg-request-item")?.addEventListener("change", () => calcRequestPreview(res.conversion));
      $("#fg-request-item-qty")?.addEventListener("input", () => calcRequestPreview(res.conversion));
      calcRequestPreview(res.conversion);
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
      const itemName = $("#fg-request-item")?.value || "";
      const quantity = Math.max(1, Number($("#fg-request-item-qty")?.value || 1));
      if (!itemName) return alert("Pick an item.");
      if (!quantity || quantity <= 0) return alert("Enter how many items.");

      const res = await api("/api/points/request", {
        method: "POST",
        body: { item_name: itemName, quantity }
      });

      alert(res.message || "Point request saved. You have 10 minutes to send the item and verify.");
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
        ? res.requests.map(requestLine).join("")
        : `<div class="fg-muted">No point requests yet.</div>`;

      box.querySelectorAll("[data-verify-request]").forEach(btn => {
        btn.addEventListener("click", async () => {
          try {
            const id = Number(btn.dataset.verifyRequest || 0);
            const out = await api("/api/points/verify", { method: "POST", body: { request_id: id } });
            alert(out.approved ? "Verified. Points added." : (out.note || "No matching item send found yet."));
            await loadMyPointRequests();
            await refresh();
            activeTab = "points";
            render();
          } catch (e) {
            alert(e.message);
          }
        });
      });
    } catch (e) {
      alert(e.message);
    }
  }



  function renderRules() {
    setTabClasses();
    const savedKey = localStorage.getItem(KEY_KEY) || "";
    $(".fg-body").innerHTML = `
      <div class="fg-hero">
        <div class="fg-kicker">RULES & LOGIN</div>
        <h2>Fries91's Giveaway</h2>
        <div class="fg-muted">Simple rules, winner info, and API login.</div>
      </div>

      <div class="fg-card fg-rules-card">
        <b>Rules</b>
        <ul class="fg-clean-list">
          <li>Use your points to enter open draws.</li>
          <li>Check the cost, prize, timer, and max entry limit before entering.</li>
          <li>Entries are final once submitted. Closed, cleared, or ended draws do not refund spent points.</li>
          <li>Do not spam requests, bypass limits, or use another player's API key.</li>
          <li>Admin may reject requests, adjust points, or disable entries if abuse is found.</li>
        </ul>
      </div>

      <div class="fg-card fg-rules-card">
        <b>Terms of Service</b>
        <ul class="fg-clean-list">
          <li>This is a player-made Torn helper, not an official Torn feature.</li>
          <li>Rewards are sent manually by Fries91/admin after winners are chosen.</li>
          <li>The app records your Torn name, Torn ID, points, entries, requests, and winner history.</li>
          <li>Using the app means you accept the draw rules shown in the app.</li>
          <li>Admin decisions are final for abuse, errors, duplicate requests, or invalid entries.</li>
        </ul>
      </div>

      <div class="fg-card fg-rules-card">
        <b>How Winners Are Chosen</b>
        <ul class="fg-clean-list">
          <li>Winners are picked with a fair random draw.</li>
          <li>Each valid entrant gets one equal chance in that draw.</li>
          <li>Using more points only pays the entry cost or event limit; it does not add extra winner weight.</li>
          <li>When a draw ends, the backend randomly picks one valid entrant.</li>
          <li>After a winner is picked, entries clear so the next draw starts fresh.</li>
          <li>The monthly rolling jackpot restarts automatically and carries rollover into the next pot.</li>
        </ul>
      </div>

      <div class="fg-card fg-rules-card">
        <b>API Key Use</b>
        <ul class="fg-clean-list">
          <li>Your Torn API key is used to confirm your Torn name and player ID.</li>
          <li>The app never needs your Torn password.</li>
          <li>The input is masked, and pasted spaces/new lines are removed before login.</li>
          <li>Use a Limited API key when possible.</li>
          <li>You can clear your saved key/session with the button below.</li>
        </ul>
      </div>

      <div class="fg-card private">
        <b>API Key Login</b>
        ${user ? `<p class="fg-muted">Logged in as ${esc(user.name)} [${esc(user.player_id)}]${user.is_admin ? " • Admin" : ""}</p>` : `<p class="fg-muted">Not logged in.</p>`}
        <label>Torn API Key</label>
        <input class="fg-input" id="fg-rules-api-key" type="password" autocomplete="off" placeholder="Paste Torn API key" value="${esc(savedKey)}">
        <button class="fg-primary" id="fg-rules-login">Login / Save Key</button>
        <button class="fg-secondary" id="fg-rules-clear-key">Clear Saved Key</button>
      </div>
    `;

    $("#fg-rules-login")?.addEventListener("click", async () => {
      const input = $("#fg-rules-api-key");
      const key = String(input?.value || "").replace(/\s+/g, "").trim();
      if (input) input.value = key;
      if (!key) return alert("Paste your Torn API key first.");
      localStorage.setItem(KEY_KEY, key);
      try {
        const res = await api("/api/login", { method: "POST", body: { api_key: key } });
        localStorage.setItem(LS_KEY, res.token);
        await refresh();
        activeTab = "overview";
        render();
      } catch (e) {
        alert(e.message);
      }
    });

    $("#fg-rules-clear-key")?.addEventListener("click", () => {
      localStorage.removeItem(KEY_KEY);
      localStorage.removeItem(LS_KEY);
      user = null;
      alert("Saved API key/session cleared from this browser.");
      render();
    });
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
        <b>Rolling Jackpot Points</b>
        <label>Title</label>
        <input class="fg-input" id="fg-title" value="${esc(state.title || "Fries91's Giveaway")}">

        <label>Starting Jackpot</label>
        <input class="fg-input" id="fg-base-payout" type="number" value="${esc(state.base_payout)}">

        <label>Points To Enter</label>
        <input class="fg-input" id="fg-rolling-point-cost" type="number" min="1" value="${esc(state.point_cost || 1)}">

        <label>Each Point Is Worth</label>
        <input class="fg-input" id="fg-entry-item-value" type="number" min="1" value="${esc(state.entry_item_value || 0)}">

        <div class="fg-split">
          <div>Status: <b>${esc(state.status)}</b></div>
          <div>Timer Ends: <b>${esc(fmtTime(state.end_at || state.draw_at))}</b></div>
          <div>Approved Points: <b>${state.approved_points_total || 0}</b></div>
          <div>Starting Jackpot: <b>${money(state.base_payout)}</b></div>
          <div>Points × Value: <b>${state.approved_points_total || 0} × ${money(state.entry_item_value)} = ${money(state.entry_growth_total)}</b></div>
          <div>Rolling Jackpot: <b>${money(state.total_pool)}</b></div>
          <div>Player 60%: <b>${money(state.player_cut)}</b></div>
          <div>Rollover 20%: <b>${money(state.rollover_cut)}</b></div>
          <div>Next Starting Jackpot: <b>${money(state.next_starting_jackpot || state.rollover_cut)}</b></div>
          <div>Tier/Admin 20%: <b>${money(state.reserve_cut)}</b></div>
        </div>

        <button class="fg-primary" id="fg-save">Save Settings</button>
        <button class="fg-secondary" id="fg-open">Open Giveaway / Start 30 Day Timer</button>
        <button class="fg-secondary" id="fg-close-giveaway">Close Giveaway</button>
        <button class="fg-warn" id="fg-draw">Draw Winner Now</button>
      </div>

      <div class="fg-card private">
        <b>Admin Stats</b>
        <button class="fg-secondary" id="fg-load-admin-stats">Load Stats</button>
        <div id="fg-admin-stats"></div>
      </div>

      <div class="fg-card private">
        <b>Point Conversion Items</b>
        <p class="fg-muted">Add up to 5 accepted items. Points use item value ÷ base point value, rounded down.</p>
        <label>Base Value Per 1 Point</label>
        <input class="fg-input" id="fg-point-base-value" type="number" min="1" value="850000">
        <div class="fg-point-admin-grid">
          ${[1,2,3,4,5].map(i => `
            <div class="fg-point-admin-row">
              <input class="fg-input" id="fg-point-item-name-${i}" placeholder="Item ${i} name">
              <input class="fg-input" id="fg-point-item-value-${i}" type="number" min="0" placeholder="Value">
            </div>
          `).join("")}
        </div>
        <button class="fg-primary" id="fg-save-point-conversions">Save Point Conversion Items</button>
        <button class="fg-secondary" id="fg-load-point-conversions">Reload Conversion Table</button>
        <div id="fg-point-conversion-preview" class="fg-mini-preview"></div>
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
    $("#fg-draw").addEventListener("click", drawAdmin);
    $("#fg-load-admin-stats")?.addEventListener("click", loadAdminStats);
    $("#fg-save-point-conversions")?.addEventListener("click", adminSavePointConversions);
    $("#fg-load-point-conversions")?.addEventListener("click", adminLoadPointConversions);
    adminLoadPointConversions();
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

  function fillPointConversionInputs(conversion) {
    const c = conversion || {};
    const base = Math.max(1, Number(c.base_value || 850000));
    const baseInput = $("#fg-point-base-value");
    if (baseInput) baseInput.value = base;

    for (let i = 1; i <= 5; i++) {
      const nameEl = $(`#fg-point-item-name-${i}`);
      const valueEl = $(`#fg-point-item-value-${i}`);
      if (nameEl) nameEl.value = "";
      if (valueEl) valueEl.value = "";
    }

    (c.items || []).slice(0, 5).forEach((item, idx) => {
      const i = idx + 1;
      const nameEl = $(`#fg-point-item-name-${i}`);
      const valueEl = $(`#fg-point-item-value-${i}`);
      if (nameEl) nameEl.value = item.name || "";
      if (valueEl) valueEl.value = Number(item.value || 0);
    });

    const preview = $("#fg-point-conversion-preview");
    if (preview) preview.innerHTML = pointRowsHtml(c);
  }

  async function adminLoadPointConversions() {
    try {
      const res = await api("/api/admin/point-conversions");
      fillPointConversionInputs(res.conversion);
    } catch (e) {
      const preview = $("#fg-point-conversion-preview");
      if (preview) preview.innerHTML = `<div class="fg-muted">${esc(e.message)}</div>`;
    }
  }

  async function adminSavePointConversions() {
    try {
      const baseValue = Math.max(1, Number($("#fg-point-base-value")?.value || 850000));
      const items = [];
      for (let i = 1; i <= 5; i++) {
        const name = $(`#fg-point-item-name-${i}`)?.value.trim() || "";
        const value = Number($(`#fg-point-item-value-${i}`)?.value || 0);
        if (name && value > 0) items.push({ name, value });
      }
      const res = await api("/api/admin/point-conversions", { method: "POST", body: { base_value: baseValue, items } });
      fillPointConversionInputs(res.conversion);
      alert("Point conversion items saved.");
    } catch (e) {
      alert(e.message);
    }
  }


  function adminPayload() {
    return {
      title: $("#fg-title").value.trim(),
      base_payout: Number($("#fg-base-payout").value || 0),
      point_cost: Number($("#fg-rolling-point-cost").value || 1),
      entry_item_value: Number($("#fg-entry-item-value").value || 0),
      rollover_pool: 0
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

  async function loadAdminStats() {
    try {
      const res = await api("/api/admin/stats");
      const box = $("#fg-admin-stats");
      if (!box) return;

      const pr = res.point_requests || {};
      const events = res.events || [];

      box.innerHTML = `
        <div class="fg-split">
          <div>Script Users: <b>${esc(res.script_users || 0)}</b></div>
          <div>Point Requests: <b>${esc(pr.total_count || 0)}</b></div>
          <div>Pending Requests: <b>${esc(pr.pending_count || 0)} (${esc(pr.pending_points || 0)} pts)</b></div>
          <div>Approved Requests: <b>${esc(pr.approved_count || 0)} (${esc(pr.approved_points || 0)} pts)</b></div>
          <div>Total Requested Points: <b>${esc(pr.total_points || 0)}</b></div>
        </div>

        <b style="display:block;margin-top:10px;">Points Used By Event</b>
        ${
          events.length
            ? events.map(ev => `
              <div class="fg-entry">
                <b>#${esc(ev.id)} — ${esc(ev.title)}</b><br>
                <span>Status: ${esc(ev.status)}</span><br>
                <span>Prize: ${esc(ev.event_prize || ev.prize_label || "Prize")}</span><br>
                <span>Users Entered: ${esc(ev.entrant_count || 0)}</span><br>
                <span>Points Used: ${esc(ev.points_used || 0)}</span>
              </div>
            `).join("")
            : `<div class="fg-muted">No events found.</div>`
        }
      `;
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
    if (!confirm("Clear event draw #" + drawId + "? This removes entries/winner and closes it. Points will NOT be refunded.")) return;
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
    #fries-giveaway-page-header {
      position: relative !important;
      display: block !important;
      width: 100% !important;
      box-sizing: border-box !important;
      z-index: 20 !important;
      margin: 6px 0 8px 0 !important;
      padding: 0 6px !important;
      clear: both !important;
      font-family: Arial, sans-serif !important;
    }
    #fries-giveaway-topbar {
      position: relative !important;
      inset: auto !important;
      width: 100% !important;
      min-height: 38px !important;
      border: 1px solid rgba(255,255,255,.16) !important;
      border-radius: 10px !important;
      background: linear-gradient(90deg,#18111f,#321d50,#18111f) !important;
      color: #fff !important;
      cursor: pointer !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      gap: 9px !important;
      padding: 7px 10px !important;
      box-shadow: 0 4px 12px rgba(0,0,0,.28) !important;
      overflow: hidden !important;
      box-sizing: border-box !important;
      font-family: Arial, sans-serif !important;
    }
    .fg-top-icon { width: 24px; height: 24px; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center; background: radial-gradient(circle at 35% 20%,#ffeaa5,#b77414 60%,#6b3a08); color: #1b1205; font-size: 15px; flex: 0 0 auto; }
    .fg-top-text { font-weight: 900; text-transform: uppercase; letter-spacing: .08em; font-size: 13px; color: #ffe9a8; text-shadow: 0 1px 1px rgba(0,0,0,.7); flex: 0 0 auto; }
    .fg-top-marquee { color: #d9d1f5; font-size: 12px; white-space: nowrap; opacity: .95; overflow: hidden; text-overflow: ellipsis; }
    #fries-giveaway-panel { position: fixed; right: 12px; top: 70px; z-index: 999999; width: min(430px, calc(100vw - 24px)); max-height: calc(100vh - 58px); display: none; overflow: hidden; border-radius: 18px; background: #11131a; color: #f4f2ff; border: 1px solid rgba(255,255,255,.16); box-shadow: 0 18px 60px rgba(0,0,0,.55); font-family: Arial, sans-serif; }
    #fries-giveaway-panel.open { display: block; }
    .fg-head { display:flex; align-items:center; justify-content:space-between; padding: 14px; background: linear-gradient(135deg,#1b102b,#301a50); cursor: move; touch-action: none; }
    #fries-giveaway-panel.fg-dragging { user-select: none !important; opacity: .96; }
    .fg-title { font-weight: 800; font-size: 18px; }
    .fg-sub, .fg-muted { color: #c8c0dc; font-size: 12px; }
    .fg-close { background: transparent; color: white; border: 0; font-size: 28px; cursor:pointer; }
    .fg-tabs { display:flex; gap: 6px; padding: 10px; background:#151722; border-bottom:1px solid rgba(255,255,255,.1); }
    .fg-tabs button { flex:1; padding: 9px 8px; border-radius: 10px; border:1px solid rgba(255,255,255,.12); background:#202333; color:#e9e3ff; cursor:pointer; }
    .fg-tabs button.active { background:#6b38b6; border-color:#9c6cff; }
    .fg-body { padding: 12px; overflow:auto; max-height: calc(100vh - 180px); }
    .fg-hero { padding:32px 18px 18px; border-radius:18px; background: radial-gradient(circle at top left,#7143bd,#21152f 55%); border:1px solid rgba(255,255,255,.16); margin-bottom: 10px; }
    .fg-kicker { font-size:11px; letter-spacing:.1em; display:block; margin-bottom:16px; line-height:1.25; color:#d7c6ff; }
    .fg-hero h2 { margin: 6px 0 12px; font-size: 22px; line-height:1.22; }

    .fg-rules-card { padding:14px 14px 12px; }
    .fg-clean-list { margin:8px 0 0; padding-left:18px; color:#f4f6ff; font-size:13px; line-height:1.35; }
    .fg-clean-list li { margin:5px 0; }
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
    .fg-status-pending_payment { background:#5a4315; color:#ffe49a; }
    .fg-status-expired { background:#3b1e1e; color:#ffb9b9; }
    .fg-status-rejected { background:#5a1717; color:#ff9a9a; }

    .fg-tabs [data-tab="entry"] { display:none !important; }
    .fg-overview-entry-box { margin-top:10px; padding:10px; border-radius:12px; border:1px solid rgba(255,255,255,.12); background:rgba(0,0,0,.22); }
    .fg-overview-entry-box label { display:block; margin-bottom:6px; font-weight:800; color:#fff; }

    @media (min-width: 721px) {
      /* PC / Firefox: lock launcher above Torn's news ticker, under the search/top nav */
      #fries-giveaway-page-header {
        position: fixed !important;
        top: 44px !important;
        left: 50% !important;
        right: auto !important;
        transform: translateX(-50%) !important;
        width: min(700px, calc(100vw - 430px)) !important;
        min-width: 520px !important;
        margin: 0 !important;
        padding: 0 !important;
        z-index: 99990 !important;
        pointer-events: none !important;
      }
      #fries-giveaway-topbar {
        pointer-events: auto !important;
      }
      #fries-giveaway-panel {
        left: 50% !important;
        right: auto !important;
        top: 112px !important;
        transform: translateX(-50%) !important;
        width: min(620px, calc(100vw - 24px)) !important;
        max-height: calc(100vh - 132px) !important;
      }
      .fg-body { max-height: calc(100vh - 220px) !important; }
    }
    @media (max-width: 720px) {
      #fries-giveaway-panel {
        left: 8px !important;
        right: 8px !important;
        top: 86px !important;
        transform: none !important;
        width: auto !important;
        max-height: calc(100vh - 104px) !important;
      }
    }

    @media (max-width: 520px) {
      #fries-giveaway-topbar { min-height: 36px; padding: 6px 8px; gap: 7px; }
      .fg-top-text { font-size: 12px; }
      .fg-top-marquee { font-size: 11px; max-width: 45vw; }
      #fries-giveaway-panel { right: 8px !important; left: 8px !important; width: auto !important; top: 86px !important; max-height: calc(100vh - 104px) !important; transform: none !important; }
      .fg-grid { grid-template-columns:1fr; }
    }

    .fg-point-admin-grid { display: grid; gap: 8px; margin: 8px 0; }
    .fg-point-admin-row { display: grid; grid-template-columns: 1fr 150px; gap: 8px; }
    .fg-mini-preview { margin-top: 10px; padding: 10px; border-radius: 14px; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.12); }
    .fg-point-table { width: 100%; border-collapse: separate; border-spacing: 0; margin-top: 8px; overflow: hidden; border-radius: 12px; border: 1px solid rgba(255,255,255,.18); background: rgba(5,5,12,.82); }
    .fg-point-table th, .fg-point-table td { text-align: left; padding: 9px 8px; border-bottom: 1px solid rgba(255,255,255,.12); color: #f7f1ff !important; }
    .fg-point-table td:nth-child(2), .fg-point-table td:nth-child(3) { color: #ffffff !important; font-weight: 800; }
    .fg-point-table th { font-size: 11px; text-transform: uppercase; color: #ffffff !important; background: rgba(107,56,182,.42); letter-spacing: .03em; }
    .fg-point-table tr:last-child td { border-bottom: 0; }
    .fg-calc-line { display:flex; justify-content:space-between; gap:10px; padding:7px 0; border-bottom:1px solid rgba(255,255,255,.10); color:#fff; }
    .fg-calc-line:last-child { border-bottom:0; }
    .fg-calc-line span { font-weight:900; color:#ffffff; }
    .fg-warning-box, .fg-warnline { margin-top:8px; padding:8px; border-radius:10px; background:rgba(255,183,77,.14); border:1px solid rgba(255,183,77,.35); color:#ffe6b0 !important; font-weight:800; }
    @media (max-width: 560px) {
      #fries-giveaway-page-header { padding: 0 4px !important; margin: 5px 0 7px 0 !important; } .fg-point-admin-row { grid-template-columns: 1fr; } .fg-point-table th, .fg-point-table td { padding: 8px 6px; font-size: 12px; } }
  `);

  ensureButton();
  setTimeout(ensureButton, 300);
  setTimeout(ensureButton, 900);
  setTimeout(ensureButton, 1800);
})();
