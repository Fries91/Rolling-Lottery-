// ==UserScript==
// @name         Torn Giveaway Overlay
// @namespace    torn.giveaway.overlay
// @version      1.3.4
// @description  Giveaway overlay for Torn with entry requirement, reward, countdown, entrants, winners, and admin controls.
// @author       OpenAI
// @match        https://www.torn.com/*
// @match        https://torn.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      *
// @downloadURL  https://sinner-s-lottery.onrender.com/static/giveaway.user.js
// @updateURL    https://sinner-s-lottery.onrender.com/static/giveaway.user.js
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  const DEFAULT_BASE_URL = 'https://sinner-s-lottery.onrender.com';
  const K_BASE_URL = 'giveaway_base_url';
  const K_API_KEY = 'giveaway_api_key';
  const K_SESSION = 'giveaway_session';
  const K_OVERLAY_OPEN = 'giveaway_overlay_open';
  const K_SHIELD_POS = 'giveaway_shield_pos';
  const K_OVERLAY_POS = 'giveaway_overlay_pos';
  const K_ACTIVE_TAB = 'giveaway_active_tab';
  const K_REFRESH = 'giveaway_refresh_seconds';

  const APP_KEY = '__torn_giveaway_overlay_running__';
  let watchStarted = false;
  let ensureTimer = null;
  let refreshTimer = null;

  if (window[APP_KEY]) return;
  window[APP_KEY] = true;


  function getBaseUrl() {
    return String(getVal(K_BASE_URL, DEFAULT_BASE_URL) || DEFAULT_BASE_URL).replace(/\/$/, '');
  }

  function setBaseUrl(url) {
    const clean = String(url || '').trim().replace(/\/$/, '');
    if (!clean) return false;
    setVal(K_BASE_URL, clean);
    return true;
  }

  let state = {
    user: null,
    current: null,
    history: [],
    entrantSearch: '',
    entrantSort: 'az',
    loading: false,
    message: '',
    error: '',
  };

  function getVal(key, fallback) {
    try { return GM_getValue(key, fallback); } catch (_) { return fallback; }
  }
  function setVal(key, value) {
    try { GM_setValue(key, value); } catch (_) {}
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }
  function fmtTs(ts) {
    if (!ts) return '-';
    const d = new Date(Number(ts) * 1000);
    return d.toLocaleString();
  }
  function countdownText(ts) {
    if (!ts) return '-';
    let diff = Number(ts) * 1000 - Date.now();
    if (diff <= 0) return 'Ended';
    const s = Math.floor(diff / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${d}d ${h}h ${m}m ${sec}s`;
  }

  function req(path, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
      const headers = { 'Content-Type': 'application/json' };
      const token = getVal(K_SESSION, '');
      if (token) headers['X-Session-Token'] = token;
      GM_xmlhttpRequest({
        method,
        url: `${getBaseUrl()}${path}`,
        headers,
        data: body ? JSON.stringify(body) : null,
        onload: (r) => {
          try {
            const data = JSON.parse(r.responseText || '{}');
            if (r.status >= 200 && r.status < 300) resolve(data);
            else reject(data);
          } catch (e) {
            reject({ error: `Bad response: ${e}` });
          }
        },
        onerror: () => reject({ error: 'Network error' }),
      });
    });
  }

  function showMsg(msg, isErr = false) {
    state.message = isErr ? '' : msg;
    state.error = isErr ? msg : '';
    render();
    if (msg) setTimeout(() => {
      if (state.message === msg) state.message = '';
      if (state.error === msg) state.error = '';
      render();
    }, 3000);
  }

  async function login() {
    const apiKey = prompt('Enter your Torn API key');
    if (!apiKey) return;
    setVal(K_API_KEY, apiKey.trim());
    try {
      const data = await req('/api/login', 'POST', { api_key: apiKey.trim() });
      if (!data.ok) throw data;
      setVal(K_SESSION, data.token || '');
      state.user = data.user || null;
      showMsg(`Logged in as ${state.user?.user_name || 'user'}`);
      await refreshAll();
    } catch (e) {
      showMsg(e.error || 'Login failed', true);
    }
  }


  async function tryAutoLogin() {
    const token = getVal(K_SESSION, '');
    if (token) return;
    const apiKey = String(getVal(K_API_KEY, '') || '').trim();
    if (!apiKey) return;
    try {
      const data = await req('/api/login', 'POST', { api_key: apiKey });
      if (!data.ok) throw data;
      setVal(K_SESSION, data.token || '');
      state.user = data.user || null;
    } catch (_) {}
  }

  async function logout() {
    try { await req('/api/logout', 'POST', {}); } catch (_) {}
    setVal(K_SESSION, '');
    state.user = null;
    showMsg('Logged out');
    await refreshAll();
  }

  async function refreshCurrent() {
    try {
      const data = await req('/api/giveaway/current');
      state.current = data;
    } catch (e) {
      showMsg(e.error || 'Failed loading giveaway', true);
    }
  }

  async function refreshHistory() {
    try {
      const data = await req('/api/giveaway/history');
      state.history = data.history || [];
    } catch (_) {}
  }

  async function refreshMe() {
    try {
      const data = await req('/api/me');
      state.user = data.user || null;
    } catch (_) {
      state.user = null;
    }
  }

  async function refreshAll() {
    if (state.loading) return;
    state.loading = true;
    render();
    await Promise.all([refreshMe(), refreshCurrent(), refreshHistory()]);
    state.loading = false;
    render();
  }

  async function enterGiveaway() {
    try {
      const data = await req('/api/giveaway/enter', 'POST', {});
      if (!data.ok) throw data;
      state.current = data;
      showMsg(data.message || 'Entry added');
    } catch (e) {
      showMsg(e.error || 'Could not enter giveaway', true);
    }
  }

  async function adminSave() {
    if (!state.user || state.user.role !== 'admin') return showMsg('Admin access required', true);
    const current = state.current?.giveaway || {};

    const title = String(document.getElementById('gw-admin-title')?.value || '').trim();
    const entry_requirement = String(document.getElementById('gw-admin-entry')?.value || '').trim();
    const reward = String(document.getElementById('gw-admin-reward')?.value || '').trim();
    const rules = String(current.rules || '').trim();
    const startRaw = String(document.getElementById('gw-admin-start')?.value || '').trim();
    const endRaw = String(document.getElementById('gw-admin-end')?.value || '').trim();
    const maxEntries = Number(document.getElementById('gw-admin-max')?.value || current.max_entries_per_user || 1) || 1;
    const status = String(document.getElementById('gw-admin-status')?.value || current.status || 'draft').trim();

    if (!title) return showMsg('Enter a giveaway title', true);
    if (!reward) return showMsg('Enter a reward', true);

    function parseLocal(value) {
      if (!value.trim()) return 0;
      const dt = new Date(value);
      return Number.isNaN(dt.getTime()) ? 0 : Math.floor(dt.getTime() / 1000);
    }

    try {
      const data = await req('/api/giveaway/admin/save', 'POST', {
        id: current.id || 0,
        title,
        entry_requirement: entry_requirement || '1 free entry',
        reward,
        rules,
        start_ts: parseLocal(startRaw),
        end_ts: parseLocal(endRaw),
        max_entries_per_user: Math.max(1, maxEntries),
        status: status || 'draft',
      });
      if (!data.ok) throw data;
      showMsg('Giveaway saved');
      await refreshAll();
    } catch (e) {
      showMsg(e.error || 'Save failed', true);
    }
  }

  async function adminStatus(status) {
    try {
      const current = state.current?.giveaway || {};
      const data = await req('/api/giveaway/admin/status', 'POST', { id: current.id || 0, status });
      if (!data.ok) throw data;
      showMsg(`Status set to ${status}`);
      await refreshAll();
    } catch (e) {
      showMsg(e.error || 'Status update failed', true);
    }
  }

  async function adminDraw() {
    if (!confirm('Draw a winner now?')) return;
    try {
      const current = state.current?.giveaway || {};
      const data = await req('/api/giveaway/admin/draw', 'POST', { id: current.id || 0 });
      if (!data.ok) throw data;
      showMsg(`Winner: ${data.giveaway?.winner_name || 'Unknown'}`);
      await refreshAll();
    } catch (e) {
      showMsg(e.error || 'Draw failed', true);
    }
  }

  function css() {
    return `
#giveaway-shield{position:fixed;right:0;top:165px;transform:none;z-index:2147483647;width:120px;height:40px;border-radius:14px 0 0 14px;background:linear-gradient(180deg,#a51515 0%, #5e0d0d 100%);box-shadow:0 4px 14px rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.15);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:13px;cursor:pointer;user-select:none;letter-spacing:.5px;writing-mode:horizontal-tb;text-orientation:mixed;white-space:nowrap}
#giveaway-overlay{position:fixed;right:78px;top:110px;width:min(440px,92vw);max-height:78vh;overflow:auto;z-index:2147483646;background:#111;border:1px solid #571818;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.6);color:#eee;font:14px/1.35 Arial,sans-serif}
#giveaway-overlay.hidden{display:none}
.gw-head{position:sticky;top:0;background:linear-gradient(180deg,#2b0b0b,#120606);padding:10px 12px;border-bottom:1px solid #4e1717;display:flex;justify-content:space-between;align-items:center;z-index:2}
.gw-title{font-size:16px;font-weight:800}
.gw-body{padding:10px}
.gw-tabs{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-bottom:10px}
.gw-tab,.gw-btn{background:#220b0b;color:#f2d7d7;border:1px solid #5a2020;border-radius:10px;padding:8px 9px;text-align:center;cursor:pointer}
.gw-tab.active{background:#5a1717;color:#fff}
.gw-btn.primary{background:#7c1717;color:#fff;border-color:#a82b2b;font-weight:800}
.gw-btn.warn{background:#5b4110;border-color:#8d6720;color:#ffe2a2}
.gw-card{background:#181818;border:1px solid #2e2e2e;border-radius:12px;padding:10px;margin-bottom:10px}
.gw-hero{background:linear-gradient(180deg,#1f0c0c,#140909);border:1px solid #5f1f1f}
.gw-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.gw-grid-entrants-tools{align-items:end}
.gw-grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.gw-label{font-size:11px;color:#bfa1a1;text-transform:uppercase;letter-spacing:.08em}
.gw-value{font-size:14px;font-weight:700;margin-top:2px;word-break:break-word}
.gw-list{display:flex;flex-direction:column;gap:6px}
.gw-row{display:flex;justify-content:space-between;gap:8px;padding:8px;border-radius:10px;background:#151515;border:1px solid #2b2b2b}
.gw-note{padding:8px 10px;border-radius:10px;margin-bottom:10px}
.gw-note.ok{background:#112814;border:1px solid #1f6d2d;color:#bff1c7}
.gw-note.err{background:#2b1010;border:1px solid #7f2323;color:#ffc7c7}
.gw-mini{font-size:12px;color:#b9b9b9}
.gw-spacer{height:6px}
.gw-hero-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:10px}
.gw-hero-title{font-size:18px;font-weight:900;line-height:1.15}
.gw-status-pill{display:inline-flex;align-items:center;justify-content:center;min-width:74px;padding:6px 10px;border-radius:999px;background:#2b1212;border:1px solid #6f2424;font-size:12px;font-weight:800;text-transform:uppercase}
.gw-stat{background:#141414;border:1px solid #2a2a2a;border-radius:12px;padding:10px}
.gw-stat .gw-value{font-size:16px}
.gw-form{display:flex;flex-direction:column;gap:10px}
.gw-field{display:flex;flex-direction:column;gap:5px}
.gw-input,.gw-textarea,.gw-select{width:100%;box-sizing:border-box;background:#101010;border:1px solid #3a1a1a;border-radius:10px;color:#f3e6e6;padding:10px;font:14px Arial,sans-serif}
.gw-textarea{min-height:86px;resize:vertical}
.gw-actions{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
.gw-actions-3{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.gw-subtle{color:#c8b4b4;font-size:12px}
.gw-overview-hero{padding:12px 12px 14px}
.gw-overview-main{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px}
.gw-overview-title{font-size:20px;font-weight:900;line-height:1.1;margin-top:4px}
.gw-overview-countdown .gw-value{font-size:22px;line-height:1.05}
.gw-overview-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px}
.gw-highlight{border-color:#5e2020;background:linear-gradient(180deg,#211010,#151010)}
.gw-enter-main{margin-top:10px}
.gw-winner-big{font-size:18px;font-weight:900}
.gw-detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
@media (max-width:640px){
  #giveaway-overlay{right:4vw;left:4vw;width:auto;top:80px;max-height:82vh}
  .gw-tabs{grid-template-columns:repeat(3,1fr)}
  .gw-grid,.gw-grid-3,.gw-actions,.gw-actions-3,.gw-overview-stats,.gw-detail-grid{grid-template-columns:1fr}
  #giveaway-shield{right:0;top:145px;width:104px;height:36px;border-radius:12px 0 0 12px;font-size:12px}
}
    `;
  }

  function ensureDom() {
    if (!document.getElementById('giveaway-style')) {
      GM_addStyle(css());
      const marker = document.createElement('div');
      marker.id = 'giveaway-style';
      marker.style.display = 'none';
      document.body.appendChild(marker);
    }
    let shield = document.getElementById('giveaway-shield');
    if (!shield) {
      shield = document.createElement('div');
      shield.id = 'giveaway-shield';
      shield.textContent = 'GIVEAWAY';
      document.body.appendChild(shield);
      shield.addEventListener('click', toggleOverlay);
      makeDraggable(shield, K_SHIELD_POS);
      applyStoredPos(shield, K_SHIELD_POS, { right: '0', top: '165px', transform: 'none' });
    }
    let overlay = document.getElementById('giveaway-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'giveaway-overlay';
      document.body.appendChild(overlay);
      if (!getVal(K_OVERLAY_OPEN, false)) overlay.classList.add('hidden');
      makeDraggable(overlay, K_OVERLAY_POS, '.gw-head');
      applyStoredPos(overlay, K_OVERLAY_POS, { right: '78px', top: '110px' });
    }
    render();
  }

  function applyStoredPos(el, key, fallback) {
    const p = getVal(key, null);
    if (p && typeof p === 'object') {
      Object.assign(el.style, { left: `${p.left}px`, top: `${p.top}px`, right: 'auto', transform: 'none' });
    } else {
      Object.assign(el.style, fallback);
    }
  }

  function makeDraggable(el, key, handleSel) {
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    const handle = handleSel ? () => el.querySelector(handleSel) : () => el;
    el.addEventListener('mousedown', (e) => {
      const h = handle();
      if (h && !h.contains(e.target)) return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect();
      ox = r.left; oy = r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const left = ox + (e.clientX - sx);
      const top = oy + (e.clientY - sy);
      Object.assign(el.style, { left: `${left}px`, top: `${top}px`, right: 'auto', transform: 'none' });
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      const r = el.getBoundingClientRect();
      setVal(key, { left: Math.round(r.left), top: Math.round(r.top) });
    });
  }

  function toggleOverlay() {
    const overlay = document.getElementById('giveaway-overlay');
    if (!overlay) return;
    overlay.classList.toggle('hidden');
    setVal(K_OVERLAY_OPEN, !overlay.classList.contains('hidden'));
  }

  function tabBtn(key, label) {
    const active = getVal(K_ACTIVE_TAB, 'overview') === key ? 'active' : '';
    return `<div class="gw-tab ${active}" data-tab="${key}">${label}</div>`;
  }

  function overviewTab() {
    const g = state.current?.giveaway;
    const c = state.current?.counts || { total_entries: 0, entrant_count: 0, my_entries: 0 };
    const canEnter = !!g && g.status === 'open';
    const loginLabel = state.user ? `Logged in as ${esc(state.user.user_name)}` : 'Login needed to enter';
    if (!g) return `<div class="gw-card"><div class="gw-value">No giveaway created yet</div></div>`;
    return `
      <div class="gw-card gw-hero gw-overview-hero">
        <div class="gw-overview-main">
          <div>
            <div class="gw-label">Current Giveaway</div>
            <div class="gw-overview-title">${esc(g.title || '-')}</div>
            <div class="gw-mini">${esc(loginLabel)}</div>
          </div>
          <div class="gw-status-pill">${esc(g.status || '-')}</div>
        </div>
        <div class="gw-grid" style="margin-bottom:8px;">
          <div class="gw-stat">
            <div class="gw-label">Reward</div>
            <div class="gw-value">${esc(g.reward || '-')}</div>
          </div>
          <div class="gw-stat gw-overview-countdown">
            <div class="gw-label">Countdown</div>
            <div class="gw-value" id="gw-live-countdown">${esc(countdownText(g.end_ts))}</div>
          </div>
        </div>
        <div class="gw-overview-stats">
          <div class="gw-stat"><div class="gw-label">Entrants</div><div class="gw-value">${c.entrant_count}</div></div>
          <div class="gw-stat"><div class="gw-label">Total Entries</div><div class="gw-value">${c.total_entries}</div></div>
          <div class="gw-stat"><div class="gw-label">My Entries</div><div class="gw-value">${c.my_entries}</div></div>
          <div class="gw-stat"><div class="gw-label">Max Per User</div><div class="gw-value">${g.max_entries_per_user || 1}</div></div>
        </div>
        <div class="gw-btn primary gw-enter-main" id="gw-overview-enter-btn">${canEnter ? 'Enter Giveaway' : 'Giveaway Not Open'}</div>
      </div>
      <div class="gw-card gw-highlight">
        <div class="gw-label">Winner</div>
        <div class="gw-winner-big">${esc(g.winner_name || 'Not drawn yet')}</div>
      </div>
      <div class="gw-card">
        <div class="gw-label">Giveaway Details</div>
        <div class="gw-spacer"></div>
        <div class="gw-detail-grid">
          <div><div class="gw-label">Entry Requirement</div><div class="gw-value">${esc(g.entry_requirement || '-')}</div></div>
          <div><div class="gw-label">Start</div><div class="gw-value">${esc(fmtTs(g.start_ts))}</div></div>
          <div><div class="gw-label">End</div><div class="gw-value">${esc(fmtTs(g.end_ts))}</div></div>
          <div><div class="gw-label">Status</div><div class="gw-value">${esc(g.status || '-')}</div></div>
        </div>
      </div>
    `;
  }


  function entrantsTab() {
    if (!state.user || state.user.role !== 'admin') {
      return `<div class="gw-card"><div class="gw-value">Admin access only</div></div>`;
    }
    const rawEntrants = Array.isArray(state.current?.entrants) ? [...state.current.entrants] : [];
    const search = String(state.entrantSearch || '').trim().toLowerCase();
    const sort = state.entrantSort || 'az';
    const entrants = rawEntrants
      .filter(e => !search || String(e.user_name || '').toLowerCase().includes(search) || String(e.user_id || '').includes(search))
      .sort((a, b) => {
        if (sort === 'entries_desc') return Number(b.entries || 0) - Number(a.entries || 0) || String(a.user_name || '').localeCompare(String(b.user_name || ''));
        if (sort === 'entries_asc') return Number(a.entries || 0) - Number(b.entries || 0) || String(a.user_name || '').localeCompare(String(b.user_name || ''));
        return String(a.user_name || '').localeCompare(String(b.user_name || ''));
      });

    return `
      <div class="gw-card">
        <div class="gw-grid gw-grid-entrants-tools">
          <div class="gw-field">
            <label class="gw-label" for="gw-entrant-search">Search</label>
            <input class="gw-input" id="gw-entrant-search" type="text" value="${esc(state.entrantSearch || '')}" placeholder="Name or ID">
          </div>
          <div class="gw-field">
            <label class="gw-label" for="gw-entrant-sort">Sort</label>
            <select class="gw-select" id="gw-entrant-sort">
              <option value="az" ${sort === 'az' ? 'selected' : ''}>A-Z</option>
              <option value="entries_desc" ${sort === 'entries_desc' ? 'selected' : ''}>Most Entries</option>
              <option value="entries_asc" ${sort === 'entries_asc' ? 'selected' : ''}>Least Entries</option>
            </select>
          </div>
        </div>
        <div class="gw-spacer"></div>
        <div class="gw-grid">
          <div><div class="gw-label">Visible Entrants</div><div class="gw-value">${entrants.length}</div></div>
          <div><div class="gw-label">Total Entrants</div><div class="gw-value">${rawEntrants.length}</div></div>
        </div>
      </div>
      <div class="gw-card">
        <div class="gw-label">Entrants</div>
        <div class="gw-list">
          ${entrants.length ? entrants.map(e => `<div class="gw-row"><div><b>${esc(e.user_name)}</b> <span class="gw-mini">[${e.user_id}]</span></div><div>${Number(e.entries || 0)} ${Number(e.entries || 0) === 1 ? 'entry' : 'entries'}</div></div>`).join('') : '<div class="gw-row"><div>No matching entrants</div></div>'}
        </div>
      </div>
    `;
  }

  function winnersTab() {
    const g = state.current?.giveaway || {};
    const winnerName = g.winner_name || 'Not drawn yet';
    const winnerId = g.winner_user_id || 0;
    const drawnAt = g.drawn_ts ? fmtTs(g.drawn_ts) : '-';
    return `
      <div class="gw-card gw-hero">
        <div class="gw-winner-top">
          <div>
            <div class="gw-label">Current Winner</div>
            <div class="gw-countdown-big">${esc(winnerName)}</div>
            <div class="gw-mini">${winnerId ? `Torn ID: ${winnerId}` : 'No winner selected yet'}</div>
          </div>
          <div class="gw-winner-badge">${g.status === 'drawn' ? 'Drawn' : 'Pending'}</div>
        </div>
        <div class="gw-spacer"></div>
        <div class="gw-grid">
          <div class="gw-stat">
            <div class="gw-stat-num">${esc(g.reward || '-')}</div>
            <div class="gw-stat-label">Reward</div>
          </div>
          <div class="gw-stat">
            <div class="gw-stat-num">${esc(drawnAt)}</div>
            <div class="gw-stat-label">Draw Time</div>
          </div>
        </div>
      </div>
      <div class="gw-card">
        <div class="gw-label">Winner History</div>
        <div class="gw-spacer"></div>
        <div class="gw-list">
          ${state.history.length ? state.history.map(h => `
            <div class="gw-history-row">
              <div class="gw-history-main">
                <div class="gw-history-name">${esc(h.user_name || 'Unknown')}</div>
                <div class="gw-mini">${esc(h.title || 'Giveaway')}</div>
                <div class="gw-mini">${esc(h.drawn_ts ? fmtTs(h.drawn_ts) : '-')}</div>
              </div>
              <div class="gw-history-reward">${esc(h.reward || '-')}</div>
            </div>
          `).join('') : '<div class="gw-empty">No winners yet</div>'}
        </div>
      </div>
    `;
  }

  function settingsTab() {
    const apiKeySaved = String(getVal(K_API_KEY, '') || '').trim();
    return `
      <div class="gw-card">
        <div class="gw-label">Account</div>
        <div class="gw-spacer"></div>
        <div class="gw-grid">
          <div class="gw-info-box">
            <div class="gw-label">Logged In As</div>
            <div class="gw-value">${state.user ? esc(state.user.user_name || '-') : 'Not logged in'}</div>
          </div>
          <div class="gw-info-box">
            <div class="gw-label">Role</div>
            <div class="gw-value">${state.user ? esc(state.user.role || 'user') : '-'}</div>
          </div>
        </div>
        <div class="gw-spacer"></div>
        <div class="gw-grid">
          <div class="gw-btn" id="gw-login-btn">${state.user ? 'Re-Login' : 'Login'}</div>
          <div class="gw-btn" id="gw-logout-btn">Logout</div>
        </div>
      </div>

      <div class="gw-card">
        <div class="gw-label">Storage</div>
        <div class="gw-spacer"></div>
        <div class="gw-grid">
          <div class="gw-info-box">
            <div class="gw-label">API Key Saved</div>
            <div class="gw-value">${apiKeySaved ? 'Yes' : 'No'}</div>
          </div>
          <div class="gw-info-box">
            <div class="gw-label">Session Saved</div>
            <div class="gw-value">${getVal(K_SESSION, '') ? 'Yes' : 'No'}</div>
          </div>
        </div>
        <div class="gw-spacer"></div>
        <div class="gw-grid">
          <div class="gw-btn" id="gw-clear-session-btn">Clear Session</div>
          <div class="gw-btn" id="gw-clear-apikey-btn">Clear API Key</div>
        </div>
      </div>

      <div class="gw-card">
        <div class="gw-label">ToS</div>
        <div class="gw-spacer"></div>
        <div class="gw-tos">
          This overlay should be used in line with Torn's rules and API terms. Use your own API key only. Do not share your API key with other players. The script stores your API key and session locally in your userscript storage on your device so it can log you in and keep the overlay working. This script should only use your key for giveaway login and related giveaway data requests.
        </div>
      </div>

      <div class="gw-card">
        <div class="gw-label">API Key Storage & Use</div>
        <div class="gw-spacer"></div>
        <div class="gw-tos">
          Your API key is saved locally in userscript storage on your device, not shown openly in the overlay, and reused for login when needed. Your saved session token is also stored locally to reduce repeated logins. Clear either one anytime using the storage buttons above.
        </div>
      </div>
    `;
  }

  function bindEvents() {
    document.querySelectorAll('.gw-tab').forEach(el => el.onclick = () => { setVal(K_ACTIVE_TAB, el.dataset.tab); render(); });
    document.getElementById('gw-enter-btn')?.addEventListener('click', () => state.user ? enterGiveaway() : login());
    document.getElementById('gw-overview-enter-btn')?.addEventListener('click', () => {
      const g = state.current?.giveaway;
      if (!g || g.status !== 'open') return showMsg('Giveaway is not open', true);
      return state.user ? enterGiveaway() : login();
    });
    document.getElementById('gw-login-btn')?.addEventListener('click', login);
    document.getElementById('gw-logout-btn')?.addEventListener('click', logout);
    document.getElementById('gw-clear-session-btn')?.addEventListener('click', () => {
      setVal(K_SESSION, '');
      state.user = null;
      showMsg('Saved session cleared');
      refreshAll();
    });
    document.getElementById('gw-clear-apikey-btn')?.addEventListener('click', () => {
      setVal(K_API_KEY, '');
      showMsg('Saved API key cleared');
      render();
    });
    document.getElementById('gw-entrant-search')?.addEventListener('input', (e) => {
      state.entrantSearch = e.target.value || '';
      render();
    });
    document.getElementById('gw-entrant-sort')?.addEventListener('change', (e) => {
      state.entrantSort = e.target.value || 'az';
      render();
    });
    document.getElementById('gw-admin-save')?.addEventListener('click', adminSave);
    document.getElementById('gw-admin-open')?.addEventListener('click', () => adminStatus('open'));
    document.getElementById('gw-admin-close')?.addEventListener('click', () => adminStatus('closed'));
  }

  function render() {
    const overlay = document.getElementById('giveaway-overlay');
    if (!overlay) return;
    let tab = getVal(K_ACTIVE_TAB, 'overview');
    if (tab === 'entrants' && (!state.user || state.user.role !== 'admin')) {
      tab = 'overview';
      setVal(K_ACTIVE_TAB, 'overview');
    }
    const body = {
      overview: overviewTab,
      entrants: entrantsTab,
      winners: winnersTab,
      admin: adminTab,
      settings: settingsTab,
    }[tab] || overviewTab;

    overlay.innerHTML = `
      <div class="gw-head">
        <div class="gw-title">Torn Giveaway</div>
        <div class="gw-btn" id="gw-close">Close</div>
      </div>
      <div class="gw-body">
        ${state.message ? `<div class="gw-note ok">${esc(state.message)}</div>` : ''}
        ${state.error ? `<div class="gw-note err">${esc(state.error)}</div>` : ''}
        <div class="gw-tabs">
          ${tabBtn('overview', 'Overview')}
          ${tabBtn('enter', 'Enter')}
          ${state.user && state.user.role === 'admin' ? tabBtn('entrants', 'Entrants') : ''}
          ${tabBtn('winners', 'Winners')}
          ${tabBtn('admin', 'Admin')}
          ${tabBtn('settings', 'Settings')}
        </div>
        ${state.loading ? '<div class="gw-card"><div class="gw-value">Loading...</div></div>' : body()}
      </div>
    `;
    document.getElementById('gw-close')?.addEventListener('click', toggleOverlay);
    bindEvents();
  }

  function startWatch() {
    if (watchStarted) return;
    watchStarted = true;

    ensureTimer = setInterval(() => {
      ensureDom();
      const g = state.current?.giveaway;
      const overlay = document.getElementById('giveaway-overlay');
      if (g && g.status === 'open' && overlay && !overlay.classList.contains('hidden')) {
        const countdownEl = document.getElementById('gw-live-countdown');
        if (countdownEl) countdownEl.textContent = countdownText(g.end_ts);
      }
    }, 1000);

    refreshTimer = setInterval(() => {
      refreshAll();
    }, Math.max(10, Number(getVal(K_REFRESH, 20))) * 1000);
  }

  async function boot() {
    if (document.body?.dataset?.giveawayBooted === '1') return;
    if (document.body) document.body.dataset.giveawayBooted = '1';

    ensureDom();
    await tryAutoLogin();
    await refreshAll();
    startWatch();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
