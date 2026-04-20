// ==UserScript==
// @name         Torn Giveaway Overlay
// @namespace    torn.giveaway.overlay
// @version      1.0.0
// @description  Giveaway overlay for Torn with entry requirement, reward, countdown, entrants, and winners.
// @match        https://www.torn.com/*
// @match        https://torn.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  const BASE_URL = (GM_getValue('giveaway_base_url', 'https://your-render-service.onrender.com') || '').replace(/\/$/, '');
  const K_API_KEY = 'giveaway_api_key';
  const K_SESSION = 'giveaway_session';
  const K_OVERLAY_OPEN = 'giveaway_overlay_open';
  const K_SHIELD_POS = 'giveaway_shield_pos';
  const K_OVERLAY_POS = 'giveaway_overlay_pos';
  const K_ACTIVE_TAB = 'giveaway_active_tab';
  const K_REFRESH = 'giveaway_refresh_seconds';

  let state = {
    user: null,
    current: null,
    history: [],
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
        url: `${BASE_URL}${path}`,
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
    const title = prompt('Giveaway title', current.title || '');
    if (title === null) return;
    const entry_requirement = prompt('Entry requirement', current.entry_requirement || '1 free entry');
    if (entry_requirement === null) return;
    const reward = prompt('Reward', current.reward || '');
    if (reward === null) return;
    const rules = prompt('Rules', current.rules || '');
    if (rules === null) return;
    const startRaw = prompt('Start date/time (example: 2026-04-20 18:00)', current.start_ts ? new Date(current.start_ts * 1000).toISOString().slice(0,16).replace('T',' ') : '');
    if (startRaw === null) return;
    const endRaw = prompt('End date/time (example: 2026-04-20 20:00)', current.end_ts ? new Date(current.end_ts * 1000).toISOString().slice(0,16).replace('T',' ') : '');
    if (endRaw === null) return;
    const maxEntries = prompt('Max entries per user', String(current.max_entries_per_user || 1));
    if (maxEntries === null) return;
    const status = prompt('Status: draft/open/closed/drawn', current.status || 'draft');
    if (status === null) return;

    function parseLocal(value) {
      if (!value.trim()) return 0;
      const dt = new Date(value.replace(' ', 'T'));
      return Number.isNaN(dt.getTime()) ? 0 : Math.floor(dt.getTime() / 1000);
    }

    try {
      const data = await req('/api/giveaway/admin/save', 'POST', {
        id: current.id || 0,
        title,
        entry_requirement,
        reward,
        rules,
        start_ts: parseLocal(startRaw),
        end_ts: parseLocal(endRaw),
        max_entries_per_user: Number(maxEntries) || 1,
        status,
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
#giveaway-shield{position:fixed;right:14px;top:50%;transform:translateY(-50%);z-index:2147483647;width:58px;height:58px;border-radius:50%;background:radial-gradient(circle at 30% 30%, #ff6767, #8e1010 60%, #240000 100%);box-shadow:0 4px 14px rgba(0,0,0,.55);border:2px solid rgba(255,255,255,.18);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:13px;cursor:pointer;user-select:none}
#giveaway-overlay{position:fixed;right:78px;top:110px;width:min(420px,92vw);max-height:78vh;overflow:auto;z-index:2147483646;background:#111;border:1px solid #571818;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.6);color:#eee;font:14px/1.35 Arial,sans-serif}
#giveaway-overlay.hidden{display:none}
.gw-head{position:sticky;top:0;background:linear-gradient(180deg,#2b0b0b,#120606);padding:10px 12px;border-bottom:1px solid #4e1717;display:flex;justify-content:space-between;align-items:center;z-index:2}
.gw-title{font-size:16px;font-weight:800}
.gw-body{padding:10px}
.gw-tabs{display:grid;grid-template-columns:repeat(6,1fr);gap:6px;margin-bottom:10px}
.gw-tab,.gw-btn{background:#220b0b;color:#f2d7d7;border:1px solid #5a2020;border-radius:10px;padding:8px 9px;text-align:center;cursor:pointer}
.gw-tab.active{background:#5a1717;color:#fff}
.gw-card{background:#181818;border:1px solid #2e2e2e;border-radius:12px;padding:10px;margin-bottom:10px}
.gw-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.gw-label{font-size:11px;color:#bfa1a1;text-transform:uppercase;letter-spacing:.08em}
.gw-value{font-size:14px;font-weight:700;margin-top:2px;word-break:break-word}
.gw-list{display:flex;flex-direction:column;gap:6px}
.gw-row{display:flex;justify-content:space-between;gap:8px;padding:8px;border-radius:10px;background:#151515;border:1px solid #2b2b2b}
.gw-note{padding:8px 10px;border-radius:10px;margin-bottom:10px}
.gw-note.ok{background:#112814;border:1px solid #1f6d2d;color:#bff1c7}
.gw-note.err{background:#2b1010;border:1px solid #7f2323;color:#ffc7c7}
.gw-mini{font-size:12px;color:#b9b9b9}
.gw-spacer{height:6px}
@media (max-width:640px){#giveaway-overlay{right:4vw;left:4vw;width:auto;top:80px;max-height:82vh}.gw-tabs{grid-template-columns:repeat(3,1fr)}#giveaway-shield{right:10px;width:54px;height:54px}}
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
      shield.textContent = 'GW';
      document.body.appendChild(shield);
      shield.addEventListener('click', toggleOverlay);
      makeDraggable(shield, K_SHIELD_POS);
      applyStoredPos(shield, K_SHIELD_POS, { right: '14px', top: '50%' });
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
    if (!g) return `<div class="gw-card"><div class="gw-value">No giveaway created yet</div></div>`;
    return `
      <div class="gw-card">
        <div class="gw-grid">
          <div><div class="gw-label">Title</div><div class="gw-value">${esc(g.title || '-')}</div></div>
          <div><div class="gw-label">Status</div><div class="gw-value">${esc(g.status || '-')}</div></div>
          <div><div class="gw-label">Entry Requirement</div><div class="gw-value">${esc(g.entry_requirement || '-')}</div></div>
          <div><div class="gw-label">Reward</div><div class="gw-value">${esc(g.reward || '-')}</div></div>
          <div><div class="gw-label">Ends</div><div class="gw-value">${esc(fmtTs(g.end_ts))}</div></div>
          <div><div class="gw-label">Countdown</div><div class="gw-value">${esc(countdownText(g.end_ts))}</div></div>
          <div><div class="gw-label">Entrants</div><div class="gw-value">${c.entrant_count}</div></div>
          <div><div class="gw-label">Total Entries</div><div class="gw-value">${c.total_entries}</div></div>
          <div><div class="gw-label">My Entries</div><div class="gw-value">${c.my_entries}</div></div>
          <div><div class="gw-label">Max Per User</div><div class="gw-value">${g.max_entries_per_user || 1}</div></div>
        </div>
      </div>
      <div class="gw-card">
        <div class="gw-label">Winner</div>
        <div class="gw-value">${esc(g.winner_name || 'Not drawn yet')}</div>
      </div>
      <div class="gw-card">
        <div class="gw-label">Rules</div>
        <div class="gw-value">${esc(g.rules || 'No rules set')}</div>
      </div>
    `;
  }

  function enterTab() {
    const g = state.current?.giveaway;
    const c = state.current?.counts || { my_entries: 0 };
    return `
      <div class="gw-card">
        <div class="gw-label">Your Status</div>
        <div class="gw-value">${state.user ? `Logged in as ${esc(state.user.user_name)}` : 'Not logged in'}</div>
        <div class="gw-spacer"></div>
        <div class="gw-mini">Entries used: ${c.my_entries} / ${(g && g.max_entries_per_user) || 1}</div>
      </div>
      <div class="gw-card">
        <div class="gw-label">Entry Requirement</div>
        <div class="gw-value">${esc(g?.entry_requirement || '-')}</div>
        <div class="gw-spacer"></div>
        <div class="gw-btn" id="gw-enter-btn">Enter Giveaway</div>
      </div>
    `;
  }

  function entrantsTab() {
    const entrants = state.current?.entrants || [];
    return `
      <div class="gw-card">
        <div class="gw-label">Entrants</div>
        <div class="gw-list">
          ${entrants.length ? entrants.map(e => `<div class="gw-row"><div>${esc(e.user_name)} <span class="gw-mini">[${e.user_id}]</span></div><div>${e.entries} entry</div></div>`).join('') : '<div class="gw-row"><div>No entrants yet</div></div>'}
        </div>
      </div>
    `;
  }

  function winnersTab() {
    return `
      <div class="gw-card">
        <div class="gw-label">Winner History</div>
        <div class="gw-list">
          ${state.history.length ? state.history.map(h => `<div class="gw-row"><div><b>${esc(h.user_name)}</b><div class="gw-mini">${esc(h.title || 'Giveaway')}</div></div><div>${esc(h.reward || '-')}</div></div>`).join('') : '<div class="gw-row"><div>No winners yet</div></div>'}
        </div>
      </div>
    `;
  }

  function adminTab() {
    if (!state.user || state.user.role !== 'admin') {
      return `<div class="gw-card"><div class="gw-value">Admin access only</div></div>`;
    }
    return `
      <div class="gw-card">
        <div class="gw-grid">
          <div class="gw-btn" id="gw-admin-save">Create / Edit</div>
          <div class="gw-btn" id="gw-admin-open">Open</div>
          <div class="gw-btn" id="gw-admin-close">Close</div>
          <div class="gw-btn" id="gw-admin-draft">Draft</div>
        </div>
        <div class="gw-spacer"></div>
        <div class="gw-btn" id="gw-admin-draw">Draw Winner</div>
      </div>
    `;
  }

  function settingsTab() {
    return `
      <div class="gw-card">
        <div class="gw-grid">
          <div><div class="gw-label">Backend URL</div><div class="gw-value">${esc(BASE_URL || '-')}</div></div>
          <div><div class="gw-label">Refresh</div><div class="gw-value">${getVal(K_REFRESH, 20)}s</div></div>
        </div>
        <div class="gw-spacer"></div>
        <div class="gw-grid">
          <div class="gw-btn" id="gw-login-btn">${state.user ? 'Re-Login' : 'Login'}</div>
          <div class="gw-btn" id="gw-logout-btn">Logout</div>
        </div>
      </div>
    `;
  }

  function bindEvents() {
    document.querySelectorAll('.gw-tab').forEach(el => el.onclick = () => { setVal(K_ACTIVE_TAB, el.dataset.tab); render(); });
    document.getElementById('gw-enter-btn')?.addEventListener('click', () => state.user ? enterGiveaway() : login());
    document.getElementById('gw-login-btn')?.addEventListener('click', login);
    document.getElementById('gw-logout-btn')?.addEventListener('click', logout);
    document.getElementById('gw-admin-save')?.addEventListener('click', adminSave);
    document.getElementById('gw-admin-open')?.addEventListener('click', () => adminStatus('open'));
    document.getElementById('gw-admin-close')?.addEventListener('click', () => adminStatus('closed'));
    document.getElementById('gw-admin-draft')?.addEventListener('click', () => adminStatus('draft'));
    document.getElementById('gw-admin-draw')?.addEventListener('click', adminDraw);
  }

  function render() {
    const overlay = document.getElementById('giveaway-overlay');
    if (!overlay) return;
    const tab = getVal(K_ACTIVE_TAB, 'overview');
    const body = {
      overview: overviewTab,
      enter: enterTab,
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
          ${tabBtn('entrants', 'Entrants')}
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
    setInterval(() => {
      ensureDom();
      const g = state.current?.giveaway;
      if (g && g.status === 'open') render();
    }, 1000);
    setInterval(refreshAll, Math.max(10, Number(getVal(K_REFRESH, 20))) * 1000);
  }

  function boot() {
    ensureDom();
    refreshAll();
    startWatch();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
