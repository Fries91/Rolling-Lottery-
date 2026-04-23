// ==UserScript==
// @name         Torn Giveaway Overlay
// @namespace    torn.giveaway.overlay
// @version      1.4.1
// @description  Giveaway overlay for Torn with entry requirement, reward, countdown, entrants, winners, and admin controls, plus a visual wheel tab.
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
  const K_WHEEL_LAYOUTS = 'giveaway_wheel_layouts';
  const K_WHEEL_SPINS = 'giveaway_wheel_spins';

  const APP_KEY = '__torn_giveaway_overlay_running__';
  let watchStarted = false;
  let ensureTimer = null;
  let refreshTimer = null;
  let wheelAnimFrame = null;
  let wheelState = {
    rotation: 0,
    spinning: false,
    lastSpinKey: '',
  };

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


  function safeJsonParse(raw, fallback) {
    try {
      const value = JSON.parse(raw);
      return value && typeof value === 'object' ? value : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function getStoredObject(key) {
    const raw = getVal(key, '');
    if (!raw) return {};
    if (typeof raw === 'object' && raw) return raw;
    return safeJsonParse(String(raw), {});
  }

  function setStoredObject(key, value) {
    setVal(key, JSON.stringify(value || {}));
  }

  function getGiveawayId() {
    const g = state.current?.giveaway || {};
    return String(g.id || g.giveaway_id || g.draw_id || 'default');
  }

  function normalizeEntrants() {
    const raw = Array.isArray(state.current?.entrants) ? state.current.entrants : [];
    const slices = [];
    raw.forEach((entry, idx) => {
      const count = Math.max(1, Number(entry?.entries || 1));
      const userId = Number(entry?.user_id || 0) || 0;
      const userName = String(entry?.user_name || `Entrant ${idx + 1}`);
      for (let i = 0; i < count; i += 1) {
        slices.push({
          user_id: userId,
          user_name: userName,
          entry_index: i + 1,
          slice_key: `${userId || 'u'}:${userName}:${i + 1}`,
        });
      }
    });
    return slices;
  }

  function entrantSignature(slices) {
    return slices.map(s => `${s.user_id}:${s.user_name}:${s.entry_index}`).sort().join('|');
  }

  function shuffleArray(items) {
    const arr = items.slice();
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function getWheelSlices() {
    const slices = normalizeEntrants();
    const giveawayId = getGiveawayId();
    const signature = entrantSignature(slices);
    const store = getStoredObject(K_WHEEL_LAYOUTS);
    const saved = store[giveawayId];
    if (saved && saved.signature === signature && Array.isArray(saved.order) && saved.order.length === slices.length) {
      const byKey = new Map(slices.map(s => [s.slice_key, s]));
      const restored = saved.order.map(key => byKey.get(key)).filter(Boolean);
      if (restored.length === slices.length) return restored;
    }
    const shuffled = shuffleArray(slices);
    store[giveawayId] = {
      signature,
      order: shuffled.map(s => s.slice_key),
      created_at: Date.now(),
    };
    setStoredObject(K_WHEEL_LAYOUTS, store);
    return shuffled;
  }

  function getWheelDisplayName(slice) {
    if (!slice) return '-';
    return slice.entry_index > 1 ? `${slice.user_name} (${slice.entry_index})` : slice.user_name;
  }

  function getWinnerSliceIndex(slices) {
    const winnerId = Number(state.current?.giveaway?.winner_user_id || 0);
    if (!winnerId) return -1;
    return slices.findIndex(s => Number(s.user_id || 0) === winnerId);
  }

  function getWheelCanvas() {
    return document.getElementById('gw-wheel-canvas');
  }

  function resizeWheelCanvas(canvas) {
    if (!canvas) return;
    const parent = canvas.parentElement;
    const width = Math.max(260, Math.min(380, Math.floor((parent?.clientWidth || 320) - 8)));
    canvas.width = width;
    canvas.height = width;
  }

  function drawWheel(rotationOverride) {
    const canvas = getWheelCanvas();
    if (!canvas) return;
    resizeWheelCanvas(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const slices = getWheelSlices();
    const size = canvas.width;
    const cx = size / 2;
    const cy = size / 2;
    const outerRadius = size * 0.46;
    const innerRadius = size * 0.16;
    const rotation = typeof rotationOverride === 'number' ? rotationOverride : wheelState.rotation || 0;

    ctx.clearRect(0, 0, size, size);

    if (!slices.length) {
      ctx.fillStyle = '#141414';
      ctx.beginPath();
      ctx.arc(cx, cy, outerRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#f4dddd';
      ctx.font = `700 ${Math.max(18, Math.floor(size * 0.05))}px Arial`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No entrants yet', cx, cy);
      return;
    }

    const anglePer = (Math.PI * 2) / slices.length;
    const colors = ['#8f1f1f', '#b53333', '#6c1515', '#c24a4a', '#7b2323', '#a82d2d'];

    slices.forEach((slice, index) => {
      const start = rotation + (index * anglePer) - (Math.PI / 2);
      const end = start + anglePer;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, outerRadius, start, end);
      ctx.closePath();
      ctx.fillStyle = colors[index % colors.length];
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#1a0909';
      ctx.stroke();

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(start + anglePer / 2);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff5f5';
      ctx.font = `700 ${Math.max(11, Math.floor(size * 0.032))}px Arial`;
      const label = getWheelDisplayName(slice).slice(0, 20);
      ctx.fillText(label, outerRadius - 12, 0);
      ctx.restore();
    });

    ctx.beginPath();
    ctx.arc(cx, cy, innerRadius, 0, Math.PI * 2);
    ctx.fillStyle = '#190909';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#e3b9b9';
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = `900 ${Math.max(16, Math.floor(size * 0.06))}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('WHEEL', cx, cy);
  }

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function markSpinDone(key) {
    const store = getStoredObject(K_WHEEL_SPINS);
    store[key] = Date.now();
    setStoredObject(K_WHEEL_SPINS, store);
  }

  function hasSpinBeenDone(key) {
    const store = getStoredObject(K_WHEEL_SPINS);
    return !!store[key];
  }

  function spinWheelToIndex(index, spinKey, opts = {}) {
    const slices = getWheelSlices();
    if (!slices.length || index < 0 || index >= slices.length) return;
    if (wheelAnimFrame) cancelAnimationFrame(wheelAnimFrame);

    const anglePer = (Math.PI * 2) / slices.length;
    const targetCenter = (index * anglePer) + (anglePer / 2);
    const baseTarget = (Math.PI * 2) - targetCenter;
    const current = wheelState.rotation || 0;
    const normalizedCurrent = ((current % (Math.PI * 2)) + (Math.PI * 2)) % (Math.PI * 2);
    let delta = baseTarget - normalizedCurrent;
    while (delta <= 0) delta += Math.PI * 2;
    const extraTurns = opts.extraTurns || 6;
    const target = current + delta + (Math.PI * 2 * extraTurns);
    const duration = opts.duration || 5200;
    const start = performance.now();

    wheelState.spinning = true;

    function frame(now) {
      const progress = Math.min(1, (now - start) / duration);
      const eased = easeOutCubic(progress);
      wheelState.rotation = current + ((target - current) * eased);
      drawWheel(wheelState.rotation);
      if (progress < 1) {
        wheelAnimFrame = requestAnimationFrame(frame);
      } else {
        wheelState.rotation = target % (Math.PI * 2);
        wheelState.spinning = false;
        wheelState.lastSpinKey = spinKey || '';
        drawWheel(wheelState.rotation);
        if (spinKey) markSpinDone(spinKey);
      }
    }

    wheelAnimFrame = requestAnimationFrame(frame);
  }

  function maybeSpinWinningWheel() {
    const g = state.current?.giveaway || {};
    const slices = getWheelSlices();
    if (!slices.length) return;
    const winnerIndex = getWinnerSliceIndex(slices);
    if (winnerIndex < 0) return;
    const spinKey = `${getGiveawayId()}:${g.winner_user_id || 0}:${g.drawn_ts || 0}`;
    if (wheelState.spinning || hasSpinBeenDone(spinKey) || wheelState.lastSpinKey === spinKey) return;
    spinWheelToIndex(winnerIndex, spinKey, { extraTurns: 7, duration: 5600 });
  }

  function spinPreviewWheel() {
    const slices = getWheelSlices();
    if (!slices.length || wheelState.spinning) return;
    const randomIndex = Math.floor(Math.random() * slices.length);
    spinWheelToIndex(randomIndex, '', { extraTurns: 4, duration: 2600 });
  }

  function wheelTab() {
    const slices = getWheelSlices();
    const g = state.current?.giveaway || {};
    const winnerName = g.winner_name || 'Not drawn yet';
    const winnerId = g.winner_user_id || 0;
    const canPreview = !!slices.length;
    return `
      <div class="gw-card gw-hero">
        <div class="gw-label">Wheel Draw</div>
        <div class="gw-spacer"></div>
        <div class="gw-wheel-wrap">
          <div class="gw-wheel-pointer"></div>
          <canvas id="gw-wheel-canvas" class="gw-wheel-canvas" width="320" height="320"></canvas>
        </div>
        <div class="gw-spacer"></div>
        <div class="gw-grid">
          <div class="gw-stat">
            <div class="gw-label">Slices</div>
            <div class="gw-value">${slices.length}</div>
          </div>
          <div class="gw-stat">
            <div class="gw-label">Status</div>
            <div class="gw-value">${esc(g.status || '-')}</div>
          </div>
        </div>
        <div class="gw-spacer"></div>
        <div class="gw-actions">
          <div class="gw-btn ${canPreview ? '' : 'warn'}" id="gw-wheel-preview-btn">${canPreview ? 'Spin Preview' : 'Waiting For Entrants'}</div>
          <div class="gw-btn" id="gw-wheel-refresh-btn">Refresh Wheel</div>
        </div>
      </div>
      <div class="gw-card gw-highlight">
        <div class="gw-label">Winner</div>
        <div class="gw-winner-big">${esc(winnerName)}</div>
        <div class="gw-mini">${winnerId ? `Torn ID: ${winnerId}` : 'The wheel will land on the backend winner when the draw is done.'}</div>
      </div>
      <div class="gw-card">
        <div class="gw-label">How It Works</div>
        <div class="gw-spacer"></div>
        <div class="gw-mini">Entrants are shuffled into random wheel positions for this draw. When the giveaway is drawn, the wheel animates to the backend winner instead of choosing one on its own.</div>
      </div>
      ${!slices.length ? `<div class="gw-card"><div class="gw-value">No entrant list is available yet. If your backend does not return entrants for this endpoint, the wheel cannot build slices until that data is included.</div></div>` : ''}
    `;
  }

  function initWheelTab() {
    if (getVal(K_ACTIVE_TAB, 'overview') !== 'wheel') return;
    const canvas = getWheelCanvas();
    if (!canvas) return;
    drawWheel();
    window.requestAnimationFrame(() => {
      drawWheel();
      maybeSpinWinningWheel();
    });
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
    if (!confirm('Pick a winner for the current draw now?')) return;
    try {
      const current = state.current?.giveaway || {};
      const data = await req('/api/giveaway/admin/draw', 'POST', { id: current.id || 0 });
      if (!data.ok) throw data;
      wheelState.lastSpinKey = '';
      showMsg(`Winner picked: ${data.giveaway?.winner_name || 'Unknown'}`);
      await refreshAll();
    } catch (e) {
      showMsg(e.error || 'Draw failed', true);
    }
  }

  function css() {
    return `
#giveaway-shield{position:fixed;right:0;top:50vh;transform:translateY(-50%);z-index:2147483647;width:120px;height:40px;border-radius:14px 0 0 14px;background:linear-gradient(180deg,#a51515 0%, #5e0d0d 100%);box-shadow:0 4px 14px rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.15);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:13px;cursor:pointer;user-select:none;letter-spacing:.5px;writing-mode:horizontal-tb;text-orientation:mixed;white-space:nowrap}
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

.gw-wheel-wrap{position:relative;display:flex;align-items:center;justify-content:center;padding-top:18px}
.gw-wheel-canvas{display:block;width:min(100%,380px);height:auto;background:radial-gradient(circle at center,#241010 0%,#140909 65%,#0f0808 100%);border:1px solid #5a2020;border-radius:50%;box-shadow:0 10px 30px rgba(0,0,0,.35)}
.gw-wheel-pointer{position:absolute;top:0;left:50%;transform:translateX(-50%);width:0;height:0;border-left:14px solid transparent;border-right:14px solid transparent;border-top:0;border-bottom:26px solid #f6df90;filter:drop-shadow(0 2px 2px rgba(0,0,0,.5));z-index:2}
.gw-history-row{display:flex;justify-content:space-between;gap:10px;padding:8px;border-radius:10px;background:#151515;border:1px solid #2b2b2b}
.gw-history-main{display:flex;flex-direction:column;gap:2px}
.gw-history-name{font-weight:800}
.gw-history-reward{font-weight:700;text-align:right}
.gw-countdown-big{font-size:22px;font-weight:900;line-height:1.05}
.gw-winner-top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
.gw-winner-badge{padding:6px 10px;border-radius:999px;background:#2b1212;border:1px solid #6f2424;font-size:12px;font-weight:800}
.gw-info-box,.gw-tos{background:#141414;border:1px solid #2a2a2a;border-radius:12px;padding:10px}
.gw-stat-num{font-size:16px;font-weight:800;word-break:break-word}
.gw-stat-label{font-size:11px;color:#bfa1a1;text-transform:uppercase;letter-spacing:.08em;margin-top:3px}
.gw-linkbtn{text-decoration:none;display:inline-flex;align-items:center;justify-content:center}
.gw-empty{padding:8px;border-radius:10px;background:#151515;border:1px solid #2b2b2b}

@media (max-width:640px){
  #giveaway-overlay{right:4vw;left:4vw;width:auto;top:80px;max-height:82vh}
  .gw-tabs{grid-template-columns:repeat(3,1fr)}
  .gw-grid,.gw-grid-3,.gw-actions,.gw-actions-3,.gw-overview-stats,.gw-detail-grid{grid-template-columns:1fr}
  #giveaway-shield{right:0;top:50vh;transform:translateY(-50%);width:104px;height:36px;border-radius:12px 0 0 12px;font-size:12px}
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
      applyStoredPos(shield, K_SHIELD_POS, { right: '0', top: '50vh', transform: 'translateY(-50%)' });
    }

    let overlay = document.getElementById('giveaway-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'giveaway-overlay';
      document.body.appendChild(overlay);
      if (!getVal(K_OVERLAY_OPEN, false)) overlay.classList.add('hidden');
      makeDraggable(overlay, K_OVERLAY_POS, '.gw-head');
      applyStoredPos(overlay, K_OVERLAY_POS, { right: '78px', top: '90px' });

      render();
    }
  }

  function applyStoredPos(el, key, fallback) {
    const p = getVal(key, null);
    const vw = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
    const vh = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);

    if (p && typeof p === 'object') {
      const left = Number(p.left);
      const top = Number(p.top);
      const width = Math.max(80, el.offsetWidth || 120);
      const height = Math.max(36, el.offsetHeight || 40);
      const isValid = Number.isFinite(left) && Number.isFinite(top)
        && left > -width + 16
        && top > 0
        && left < vw - 16
        && top < vh - 16;

      if (isValid) {
        Object.assign(el.style, { left: `${left}px`, top: `${top}px`, right: 'auto', transform: 'none' });
        return;
      }

      setVal(key, null);
    }

    Object.assign(el.style, fallback);
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

  function adminTab() {
    if (!state.user || state.user.role !== 'admin') {
      return `<div class="gw-card"><div class="gw-value">Admin access only</div></div>`;
    }
    const g = state.current?.giveaway || {};
    const c = state.current?.counts || { total_entries: 0, entrant_count: 0 };
    const winnerName = g.winner_name || 'Not picked yet';
    const winnerId = g.winner_user_id || 0;
    const drawnAt = g.drawn_ts ? fmtTs(g.drawn_ts) : '-';

    return `
      <div class="gw-card">
        <div class="gw-label">Giveaway Setup</div>
        <div class="gw-spacer"></div>
        <div class="gw-grid">
          <div>
            <div class="gw-label">Title</div>
            <input class="gw-input" id="gw-admin-title" value="${esc(g.title || '')}" placeholder="Giveaway title" />
          </div>
          <div>
            <div class="gw-label">Entry Requirement</div>
            <input class="gw-input" id="gw-admin-entry" value="${esc(g.entry_requirement || '')}" placeholder="Entry requirement" />
          </div>
          <div>
            <div class="gw-label">Reward</div>
            <input class="gw-input" id="gw-admin-reward" value="${esc(g.reward || '')}" placeholder="Reward" />
          </div>
          <div>
            <div class="gw-label">Max Entries</div>
            <input class="gw-input" id="gw-admin-max" type="number" min="1" value="${Number(g.max_entries_per_user || 1)}" />
          </div>
          <div>
            <div class="gw-label">Start</div>
            <input class="gw-input" id="gw-admin-start" value="${g.start_ts ? new Date(g.start_ts * 1000).toISOString().slice(0,16).replace('T',' ') : ''}" placeholder="YYYY-MM-DD HH:MM" />
          </div>
          <div>
            <div class="gw-label">End</div>
            <input class="gw-input" id="gw-admin-end" value="${g.end_ts ? new Date(g.end_ts * 1000).toISOString().slice(0,16).replace('T',' ') : ''}" placeholder="YYYY-MM-DD HH:MM" />
          </div>
        </div>
        <div class="gw-spacer"></div>
        <div class="gw-grid">
          <div class="gw-stat">
            <div class="gw-stat-num">${esc(g.status || '-')}</div>
            <div class="gw-stat-label">Status</div>
          </div>
          <div class="gw-stat">
            <div class="gw-stat-num">${c.entrant_count}</div>
            <div class="gw-stat-label">Entrants</div>
          </div>
          <div class="gw-stat">
            <div class="gw-stat-num">${c.total_entries}</div>
            <div class="gw-stat-label">Total Entries</div>
          </div>
          <div class="gw-stat">
            <div class="gw-stat-num">${esc(drawnAt)}</div>
            <div class="gw-stat-label">Draw Time</div>
          </div>
        </div>
        <div class="gw-spacer"></div>
        <div class="gw-grid">
          <div class="gw-btn" id="gw-admin-save">Save</div>
          <div class="gw-btn" id="gw-admin-open">Open</div>
          <div class="gw-btn" id="gw-admin-close">Close</div>
          <div class="gw-btn" id="gw-admin-pick">Pick Winner</div>
        </div>
      </div>

      <div class="gw-card">
        <div class="gw-label">Winner</div>
        <div class="gw-spacer"></div>
        <div class="gw-winner-top">
          <div>
            <div class="gw-value">${esc(winnerName)}</div>
            <div class="gw-mini">${winnerId ? `Torn ID: ${winnerId}` : 'No winner picked yet'}</div>
          </div>
          <div class="gw-winner-badge">${g.status === 'drawn' ? 'Picked' : 'Waiting'}</div>
        </div>
        <div class="gw-spacer"></div>
        ${winnerId ? `<a class="gw-btn gw-linkbtn" href="https://www.torn.com/profiles.php?XID=${winnerId}" target="_blank" rel="noopener noreferrer">Open Winner Profile</a>` : ''}
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
    document.getElementById('gw-wheel-preview-btn')?.addEventListener('click', () => {
      if (!getWheelSlices().length) return showMsg('No entrants to place on the wheel yet', true);
      spinPreviewWheel();
    });
    document.getElementById('gw-wheel-refresh-btn')?.addEventListener('click', () => {
      const giveawayId = getGiveawayId();
      const store = getStoredObject(K_WHEEL_LAYOUTS);
      delete store[giveawayId];
      setStoredObject(K_WHEEL_LAYOUTS, store);
      wheelState.rotation = 0;
      wheelState.lastSpinKey = '';
      drawWheel();
      render();
    });
    document.getElementById('gw-admin-save')?.addEventListener('click', async () => {
      if (!state.user || state.user.role !== 'admin') return showMsg('Admin access required', true);
      const current = state.current?.giveaway || {};
      const title = document.getElementById('gw-admin-title')?.value || '';
      const entry_requirement = document.getElementById('gw-admin-entry')?.value || '';
      const reward = document.getElementById('gw-admin-reward')?.value || '';
      const maxEntries = document.getElementById('gw-admin-max')?.value || '1';
      const startRaw = document.getElementById('gw-admin-start')?.value || '';
      const endRaw = document.getElementById('gw-admin-end')?.value || '';

      function parseLocal(value) {
        if (!String(value).trim()) return 0;
        const dt = new Date(String(value).replace(' ', 'T'));
        return Number.isNaN(dt.getTime()) ? 0 : Math.floor(dt.getTime() / 1000);
      }

      try {
        const data = await req('/api/giveaway/admin/save', 'POST', {
          id: current.id || 0,
          title,
          entry_requirement,
          reward,
          rules: current.rules || '',
          start_ts: parseLocal(startRaw),
          end_ts: parseLocal(endRaw),
          max_entries_per_user: Number(maxEntries) || 1,
          status: current.status || 'closed',
        });
        if (!data.ok) throw data;
        showMsg('Giveaway saved');
        await refreshAll();
      } catch (e) {
        showMsg(e.error || 'Save failed', true);
      }
    });
    document.getElementById('gw-admin-open')?.addEventListener('click', () => adminStatus('open'));
    document.getElementById('gw-admin-close')?.addEventListener('click', () => adminStatus('closed'));
    document.getElementById('gw-admin-pick')?.addEventListener('click', adminDraw);
  }

  function render() {
    const overlay = document.getElementById('giveaway-overlay');
    if (!overlay) return;
    let tab = getVal(K_ACTIVE_TAB, 'overview');
    if (tab === 'enter') {
      tab = 'overview';
      setVal(K_ACTIVE_TAB, 'overview');
    }
    if (tab === 'entrants' && (!state.user || state.user.role !== 'admin')) {
      tab = 'overview';
      setVal(K_ACTIVE_TAB, 'overview');
    }
    const body = {
      overview: overviewTab,
      wheel: wheelTab,
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
          ${tabBtn('wheel', 'Wheel')}
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
    initWheelTab();
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
      if (overlay && !overlay.classList.contains('hidden') && getVal(K_ACTIVE_TAB, 'overview') === 'wheel') {
        drawWheel();
        maybeSpinWinningWheel();
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
  let refreshTimer = null;
  let wheelAnimFrame = null;
  let wheelState = {
    rotation: 0,
    spinning: false,
    lastSpinKey: '',
  };

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


  function safeJsonParse(raw, fallback) {
    try {
      const value = JSON.parse(raw);
      return value && typeof value === 'object' ? value : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function getStoredObject(key) {
    const raw = getVal(key, '');
    if (!raw) return {};
    if (typeof raw === 'object' && raw) return raw;
    return safeJsonParse(String(raw), {});
  }

  function setStoredObject(key, value) {
    setVal(key, JSON.stringify(value || {}));
  }

  function getGiveawayId() {
    const g = state.current?.giveaway || {};
    return String(g.id || g.giveaway_id || g.draw_id || 'default');
  }

  function normalizeEntrants() {
    const raw = Array.isArray(state.current?.entrants) ? state.current.entrants : [];
    const slices = [];
    raw.forEach((entry, idx) => {
      const count = Math.max(1, Number(entry?.entries || 1));
      const userId = Number(entry?.user_id || 0) || 0;
      const userName = String(entry?.user_name || `Entrant ${idx + 1}`);
      for (let i = 0; i < count; i += 1) {
        slices.push({
          user_id: userId,
          user_name: userName,
          entry_index: i + 1,
          slice_key: `${userId || 'u'}:${userName}:${i + 1}`,
        });
      }
    });
    return slices;
  }

  function entrantSignature(slices) {
    return slices.map(s => `${s.user_id}:${s.user_name}:${s.entry_index}`).sort().join('|');
  }

  function shuffleArray(items) {
    const arr = items.slice();
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function getWheelSlices() {
    const slices = normalizeEntrants();
    const giveawayId = getGiveawayId();
    const signature = entrantSignature(slices);
    const store = getStoredObject(K_WHEEL_LAYOUTS);
    const saved = store[giveawayId];
    if (saved && saved.signature === signature && Array.isArray(saved.order) && saved.order.length === slices.length) {
      const byKey = new Map(slices.map(s => [s.slice_key, s]));
      const restored = saved.order.map(key => byKey.get(key)).filter(Boolean);
      if (restored.length === slices.length) return restored;
    }
    const shuffled = shuffleArray(slices);
    store[giveawayId] = {
      signature,
      order: shuffled.map(s => s.slice_key),
      created_at: Date.now(),
    };
    setStoredObject(K_WHEEL_LAYOUTS, store);
    return shuffled;
  }

  function getWheelDisplayName(slice) {
    if (!slice) return '-';
    return slice.entry_index > 1 ? `${slice.user_name} (${slice.entry_index})` : slice.user_name;
  }

  function getWinnerSliceIndex(slices) {
    const winnerId = Number(state.current?.giveaway?.winner_user_id || 0);
    if (!winnerId) return -1;
    return slices.findIndex(s => Number(s.user_id || 0) === winnerId);
  }

  function getWheelCanvas() {
    return document.getElementById('gw-wheel-canvas');
  }

  function resizeWheelCanvas(canvas) {
    if (!canvas) return;
    const parent = canvas.parentElement;
    const width = Math.max(260, Math.min(380, Math.floor((parent?.clientWidth || 320) - 8)));
    canvas.width = width;
    canvas.height = width;
  }

  function drawWheel(rotationOverride) {
    const canvas = getWheelCanvas();
    if (!canvas) return;
    resizeWheelCanvas(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const slices = getWheelSlices();
    const size = canvas.width;
    const cx = size / 2;
    const cy = size / 2;
    const outerRadius = size * 0.46;
    const innerRadius = size * 0.16;
    const rotation = typeof rotationOverride === 'number' ? rotationOverride : wheelState.rotation || 0;

    ctx.clearRect(0, 0, size, size);

    if (!slices.length) {
      ctx.fillStyle = '#141414';
      ctx.beginPath();
      ctx.arc(cx, cy, outerRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#f4dddd';
      ctx.font = `700 ${Math.max(18, Math.floor(size * 0.05))}px Arial`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No entrants yet', cx, cy);
      return;
    }

    const anglePer = (Math.PI * 2) / slices.length;
    const colors = ['#8f1f1f', '#b53333', '#6c1515', '#c24a4a', '#7b2323', '#a82d2d'];

    slices.forEach((slice, index) => {
      const start = rotation + (index * anglePer) - (Math.PI / 2);
      const end = start + anglePer;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, outerRadius, start, end);
      ctx.closePath();
      ctx.fillStyle = colors[index % colors.length];
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#1a0909';
      ctx.stroke();

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(start + anglePer / 2);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff5f5';
      ctx.font = `700 ${Math.max(11, Math.floor(size * 0.032))}px Arial`;
      const label = getWheelDisplayName(slice).slice(0, 20);
      ctx.fillText(label, outerRadius - 12, 0);
      ctx.restore();
    });

    ctx.beginPath();
    ctx.arc(cx, cy, innerRadius, 0, Math.PI * 2);
    ctx.fillStyle = '#190909';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#e3b9b9';
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = `900 ${Math.max(16, Math.floor(size * 0.06))}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('WHEEL', cx, cy);
  }

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function markSpinDone(key) {
    const store = getStoredObject(K_WHEEL_SPINS);
    store[key] = Date.now();
    setStoredObject(K_WHEEL_SPINS, store);
  }

  function hasSpinBeenDone(key) {
    const store = getStoredObject(K_WHEEL_SPINS);
    return !!store[key];
  }

  function spinWheelToIndex(index, spinKey, opts = {}) {
    const slices = getWheelSlices();
    if (!slices.length || index < 0 || index >= slices.length) return;
    if (wheelAnimFrame) cancelAnimationFrame(wheelAnimFrame);

    const anglePer = (Math.PI * 2) / slices.length;
    const targetCenter = (index * anglePer) + (anglePer / 2);
    const baseTarget = (Math.PI * 2) - targetCenter;
    const current = wheelState.rotation || 0;
    const normalizedCurrent = ((current % (Math.PI * 2)) + (Math.PI * 2)) % (Math.PI * 2);
    let delta = baseTarget - normalizedCurrent;
    while (delta <= 0) delta += Math.PI * 2;
    const extraTurns = opts.extraTurns || 6;
    const target = current + delta + (Math.PI * 2 * extraTurns);
    const duration = opts.duration || 5200;
    const start = performance.now();

    wheelState.spinning = true;

    function frame(now) {
      const progress = Math.min(1, (now - start) / duration);
      const eased = easeOutCubic(progress);
      wheelState.rotation = current + ((target - current) * eased);
      drawWheel(wheelState.rotation);
      if (progress < 1) {
        wheelAnimFrame = requestAnimationFrame(frame);
      } else {
        wheelState.rotation = target % (Math.PI * 2);
        wheelState.spinning = false;
        wheelState.lastSpinKey = spinKey || '';
        drawWheel(wheelState.rotation);
        if (spinKey) markSpinDone(spinKey);
      }
    }

    wheelAnimFrame = requestAnimationFrame(frame);
  }

  function maybeSpinWinningWheel() {
    const g = state.current?.giveaway || {};
    const slices = getWheelSlices();
    if (!slices.length) return;
    const winnerIndex = getWinnerSliceIndex(slices);
    if (winnerIndex < 0) return;
    const spinKey = `${getGiveawayId()}:${g.winner_user_id || 0}:${g.drawn_ts || 0}`;
    if (wheelState.spinning || hasSpinBeenDone(spinKey) || wheelState.lastSpinKey === spinKey) return;
    spinWheelToIndex(winnerIndex, spinKey, { extraTurns: 7, duration: 5600 });
  }

  function spinPreviewWheel() {
    const slices = getWheelSlices();
    if (!slices.length || wheelState.spinning) return;
    const randomIndex = Math.floor(Math.random() * slices.length);
    spinWheelToIndex(randomIndex, '', { extraTurns: 4, duration: 2600 });
  }

  function wheelTab() {
    const slices = getWheelSlices();
    const g = state.current?.giveaway || {};
    const winnerName = g.winner_name || 'Not drawn yet';
    const winnerId = g.winner_user_id || 0;
    const canPreview = !!slices.length;
    return `
      <div class="gw-card gw-hero">
        <div class="gw-label">Wheel Draw</div>
        <div class="gw-spacer"></div>
        <div class="gw-wheel-wrap">
          <div class="gw-wheel-pointer"></div>
          <canvas id="gw-wheel-canvas" class="gw-wheel-canvas" width="320" height="320"></canvas>
        </div>
        <div class="gw-spacer"></div>
        <div class="gw-grid">
          <div class="gw-stat">
            <div class="gw-label">Slices</div>
            <div class="gw-value">${slices.length}</div>
          </div>
          <div class="gw-stat">
            <div class="gw-label">Status</div>
            <div class="gw-value">${esc(g.status || '-')}</div>
          </div>
        </div>
        <div class="gw-spacer"></div>
        <div class="gw-actions">
          <div class="gw-btn ${canPreview ? '' : 'warn'}" id="gw-wheel-preview-btn">${canPreview ? 'Spin Preview' : 'Waiting For Entrants'}</div>
          <div class="gw-btn" id="gw-wheel-refresh-btn">Refresh Wheel</div>
        </div>
      </div>
      <div class="gw-card gw-highlight">
        <div class="gw-label">Winner</div>
        <div class="gw-winner-big">${esc(winnerName)}</div>
        <div class="gw-mini">${winnerId ? `Torn ID: ${winnerId}` : 'The wheel will land on the backend winner when the draw is done.'}</div>
      </div>
      <div class="gw-card">
        <div class="gw-label">How It Works</div>
        <div class="gw-spacer"></div>
        <div class="gw-mini">Entrants are shuffled into random wheel positions for this draw. When the giveaway is drawn, the wheel animates to the backend winner instead of choosing one on its own.</div>
      </div>
      ${!slices.length ? `<div class="gw-card"><div class="gw-value">No entrant list is available yet. If your backend does not return entrants for this endpoint, the wheel cannot build slices until that data is included.</div></div>` : ''}
    `;
  }

  function initWheelTab() {
    if (getVal(K_ACTIVE_TAB, 'overview') !== 'wheel') return;
    const canvas = getWheelCanvas();
    if (!canvas) return;
    drawWheel();
    window.requestAnimationFrame(() => {
      drawWheel();
      maybeSpinWinningWheel();
    });
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
    if (!confirm('Pick a winner for the current draw now?')) return;
    try {
      const current = state.current?.giveaway || {};
      const data = await req('/api/giveaway/admin/draw', 'POST', { id: current.id || 0 });
      if (!data.ok) throw data;
      wheelState.lastSpinKey = '';
      showMsg(`Winner picked: ${data.giveaway?.winner_name || 'Unknown'}`);
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

.gw-wheel-wrap{position:relative;display:flex;align-items:center;justify-content:center;padding-top:18px}
.gw-wheel-canvas{display:block;width:min(100%,380px);height:auto;background:radial-gradient(circle at center,#241010 0%,#140909 65%,#0f0808 100%);border:1px solid #5a2020;border-radius:50%;box-shadow:0 10px 30px rgba(0,0,0,.35)}
.gw-wheel-pointer{position:absolute;top:0;left:50%;transform:translateX(-50%);width:0;height:0;border-left:14px solid transparent;border-right:14px solid transparent;border-top:0;border-bottom:26px solid #f6df90;filter:drop-shadow(0 2px 2px rgba(0,0,0,.5));z-index:2}
.gw-history-row{display:flex;justify-content:space-between;gap:10px;padding:8px;border-radius:10px;background:#151515;border:1px solid #2b2b2b}
.gw-history-main{display:flex;flex-direction:column;gap:2px}
.gw-history-name{font-weight:800}
.gw-history-reward{font-weight:700;text-align:right}
.gw-countdown-big{font-size:22px;font-weight:900;line-height:1.05}
.gw-winner-top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
.gw-winner-badge{padding:6px 10px;border-radius:999px;background:#2b1212;border:1px solid #6f2424;font-size:12px;font-weight:800}
.gw-info-box,.gw-tos{background:#141414;border:1px solid #2a2a2a;border-radius:12px;padding:10px}
.gw-stat-num{font-size:16px;font-weight:800;word-break:break-word}
.gw-stat-label{font-size:11px;color:#bfa1a1;text-transform:uppercase;letter-spacing:.08em;margin-top:3px}
.gw-linkbtn{text-decoration:none;display:inline-flex;align-items:center;justify-content:center}
.gw-empty{padding:8px;border-radius:10px;background:#151515;border:1px solid #2b2b2b}

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

      render();
    }
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

  function adminTab() {
    if (!state.user || state.user.role !== 'admin') {
      return `<div class="gw-card"><div class="gw-value">Admin access only</div></div>`;
    }
    const g = state.current?.giveaway || {};
    const c = state.current?.counts || { total_entries: 0, entrant_count: 0 };
    const winnerName = g.winner_name || 'Not picked yet';
    const winnerId = g.winner_user_id || 0;
    const drawnAt = g.drawn_ts ? fmtTs(g.drawn_ts) : '-';

    return `
      <div class="gw-card">
        <div class="gw-label">Giveaway Setup</div>
        <div class="gw-spacer"></div>
        <div class="gw-grid">
          <div>
            <div class="gw-label">Title</div>
            <input class="gw-input" id="gw-admin-title" value="${esc(g.title || '')}" placeholder="Giveaway title" />
          </div>
          <div>
            <div class="gw-label">Entry Requirement</div>
            <input class="gw-input" id="gw-admin-entry" value="${esc(g.entry_requirement || '')}" placeholder="Entry requirement" />
          </div>
          <div>
            <div class="gw-label">Reward</div>
            <input class="gw-input" id="gw-admin-reward" value="${esc(g.reward || '')}" placeholder="Reward" />
          </div>
          <div>
            <div class="gw-label">Max Entries</div>
            <input class="gw-input" id="gw-admin-max" type="number" min="1" value="${Number(g.max_entries_per_user || 1)}" />
          </div>
          <div>
            <div class="gw-label">Start</div>
            <input class="gw-input" id="gw-admin-start" value="${g.start_ts ? new Date(g.start_ts * 1000).toISOString().slice(0,16).replace('T',' ') : ''}" placeholder="YYYY-MM-DD HH:MM" />
          </div>
          <div>
            <div class="gw-label">End</div>
            <input class="gw-input" id="gw-admin-end" value="${g.end_ts ? new Date(g.end_ts * 1000).toISOString().slice(0,16).replace('T',' ') : ''}" placeholder="YYYY-MM-DD HH:MM" />
          </div>
        </div>
        <div class="gw-spacer"></div>
        <div class="gw-grid">
          <div class="gw-stat">
            <div class="gw-stat-num">${esc(g.status || '-')}</div>
            <div class="gw-stat-label">Status</div>
          </div>
          <div class="gw-stat">
            <div class="gw-stat-num">${c.entrant_count}</div>
            <div class="gw-stat-label">Entrants</div>
          </div>
          <div class="gw-stat">
            <div class="gw-stat-num">${c.total_entries}</div>
            <div class="gw-stat-label">Total Entries</div>
          </div>
          <div class="gw-stat">
            <div class="gw-stat-num">${esc(drawnAt)}</div>
            <div class="gw-stat-label">Draw Time</div>
          </div>
        </div>
        <div class="gw-spacer"></div>
        <div class="gw-grid">
          <div class="gw-btn" id="gw-admin-save">Save</div>
          <div class="gw-btn" id="gw-admin-open">Open</div>
          <div class="gw-btn" id="gw-admin-close">Close</div>
          <div class="gw-btn" id="gw-admin-pick">Pick Winner</div>
        </div>
      </div>

      <div class="gw-card">
        <div class="gw-label">Winner</div>
        <div class="gw-spacer"></div>
        <div class="gw-winner-top">
          <div>
            <div class="gw-value">${esc(winnerName)}</div>
            <div class="gw-mini">${winnerId ? `Torn ID: ${winnerId}` : 'No winner picked yet'}</div>
          </div>
          <div class="gw-winner-badge">${g.status === 'drawn' ? 'Picked' : 'Waiting'}</div>
        </div>
        <div class="gw-spacer"></div>
        ${winnerId ? `<a class="gw-btn gw-linkbtn" href="https://www.torn.com/profiles.php?XID=${winnerId}" target="_blank" rel="noopener noreferrer">Open Winner Profile</a>` : ''}
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
    document.getElementById('gw-wheel-preview-btn')?.addEventListener('click', () => {
      if (!getWheelSlices().length) return showMsg('No entrants to place on the wheel yet', true);
      spinPreviewWheel();
    });
    document.getElementById('gw-wheel-refresh-btn')?.addEventListener('click', () => {
      const giveawayId = getGiveawayId();
      const store = getStoredObject(K_WHEEL_LAYOUTS);
      delete store[giveawayId];
      setStoredObject(K_WHEEL_LAYOUTS, store);
      wheelState.rotation = 0;
      wheelState.lastSpinKey = '';
      drawWheel();
      render();
    });
    document.getElementById('gw-admin-save')?.addEventListener('click', async () => {
      if (!state.user || state.user.role !== 'admin') return showMsg('Admin access required', true);
      const current = state.current?.giveaway || {};
      const title = document.getElementById('gw-admin-title')?.value || '';
      const entry_requirement = document.getElementById('gw-admin-entry')?.value || '';
      const reward = document.getElementById('gw-admin-reward')?.value || '';
      const maxEntries = document.getElementById('gw-admin-max')?.value || '1';
      const startRaw = document.getElementById('gw-admin-start')?.value || '';
      const endRaw = document.getElementById('gw-admin-end')?.value || '';

      function parseLocal(value) {
        if (!String(value).trim()) return 0;
        const dt = new Date(String(value).replace(' ', 'T'));
        return Number.isNaN(dt.getTime()) ? 0 : Math.floor(dt.getTime() / 1000);
      }

      try {
        const data = await req('/api/giveaway/admin/save', 'POST', {
          id: current.id || 0,
          title,
          entry_requirement,
          reward,
          rules: current.rules || '',
          start_ts: parseLocal(startRaw),
          end_ts: parseLocal(endRaw),
          max_entries_per_user: Number(maxEntries) || 1,
          status: current.status || 'closed',
        });
        if (!data.ok) throw data;
        showMsg('Giveaway saved');
        await refreshAll();
      } catch (e) {
        showMsg(e.error || 'Save failed', true);
      }
    });
    document.getElementById('gw-admin-open')?.addEventListener('click', () => adminStatus('open'));
    document.getElementById('gw-admin-close')?.addEventListener('click', () => adminStatus('closed'));
    document.getElementById('gw-admin-pick')?.addEventListener('click', adminDraw);
  }

  function render() {
    const overlay = document.getElementById('giveaway-overlay');
    if (!overlay) return;
    let tab = getVal(K_ACTIVE_TAB, 'overview');
    if (tab === 'enter') {
      tab = 'overview';
      setVal(K_ACTIVE_TAB, 'overview');
    }
    if (tab === 'entrants' && (!state.user || state.user.role !== 'admin')) {
      tab = 'overview';
      setVal(K_ACTIVE_TAB, 'overview');
    }
    const body = {
      overview: overviewTab,
      wheel: wheelTab,
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
          ${tabBtn('wheel', 'Wheel')}
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
    initWheelTab();
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
      if (overlay && !overlay.classList.contains('hidden') && getVal(K_ACTIVE_TAB, 'overview') === 'wheel') {
        drawWheel();
        maybeSpinWinningWheel();
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
