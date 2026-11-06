/* Approval Sheet apps — shared page core (offline-first).
 *
 * Every change is a small "op":
 *   1. checked and applied on this device at once (same rules as the server),
 *   2. saved in IndexedDB (the "outbox"),
 *   3. sent to the Apps Script server whenever there is internet; the server re-checks it.
 * What you see = the last list from the server + the ops still waiting in the outbox.
 * One Google sign-in is shared by all modules (QR Scanner, Transmittal QR, Manual Prechecking).
 */
(function () {
  'use strict';
  const CFG = window.QR_CONFIG || {};
  const LIVE_MS = CFG.LIVE_REFRESH_MS || 12000;
  const RETRY_MS = CFG.RETRY_MS || 15000;
  const $ = (id) => document.getElementById(id);
  function on(id, evt, fn, opts) {
    const el = $(id);
    if (!el) { console.warn('#' + id + ' not found'); return; }
    el.addEventListener(evt, fn, opts);
  }
  const pad = (n) => String(n).padStart(2, '0');
  function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
  }
  // Local (not UTC) date/time — the Philippines is UTC+8. ts is a UTC ISO string, only used for ordering.
  function nowStamp() {
    const d = new Date();
    return {
      date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()),
      time: pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()),
      ts: d.toISOString()
    };
  }
  const todayStr = () => nowStamp().date;
  const localDateOf = (iso) => {
    const d = new Date(iso); if (isNaN(d)) return '';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  };

  function toast(msg, ms) {
    const box = $('toast-container'); if (!box) return;
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
    box.appendChild(t); setTimeout(() => t.remove(), ms || 5000);
  }
  function confirmBox(message, okLabel) {
    return new Promise((resolve) => {
      $('confirm-message').textContent = message;
      $('confirm-ok').textContent = okLabel || 'Confirm';
      $('confirm-modal').classList.remove('hidden');
      const done = (v) => { $('confirm-modal').classList.add('hidden'); $('confirm-ok').onclick = $('confirm-cancel').onclick = null; resolve(v); };
      $('confirm-ok').onclick = () => done(true);
      $('confirm-cancel').onclick = () => done(false);
    });
  }

  // ---------------------------------------------------------------- IndexedDB (with an in-memory fallback)
  const DB_NAME = 'approval-sheet-db';
  let dbp = null;
  const memKV = new Map();
  let memOutbox = []; let memSeq = 0;
  function openDb() {
    if (dbp) return dbp;
    dbp = new Promise((resolve) => {
      if (!window.indexedDB) return resolve(null);
      let req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { return resolve(null); }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
    return dbp;
  }
  function idb(store, mode, fn) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      if (!db) return reject(new Error('nodb'));
      let tx; try { tx = db.transaction(store, mode); } catch (e) { return reject(e); }
      const s = tx.objectStore(store);
      let out;
      const r = fn(s);
      if (r) r.onsuccess = () => { out = r.result; };
      tx.oncomplete = () => resolve(out);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('idb'));
    }));
  }
  async function kvGet(k, dflt) {
    try { const v = await idb('kv', 'readonly', (s) => s.get(k)); return v === undefined ? dflt : v; }
    catch (e) { return memKV.has(k) ? memKV.get(k) : dflt; }
  }
  async function kvSet(k, v) {
    memKV.set(k, v);
    try { await idb('kv', 'readwrite', (s) => s.put(v, k)); } catch (e) { /* memory copy only */ }
  }
  async function outboxLoad() {
    try { return (await idb('outbox', 'readonly', (s) => s.getAll())) || []; } catch (e) { return memOutbox.slice(); }
  }
  async function outboxAdd(item) {
    try { const seq = await idb('outbox', 'readwrite', (s) => s.add(item)); item.seq = seq; return item; }
    catch (e) { item.seq = ++memSeq + 1e9; memOutbox.push(item); return item; }
  }
  async function outboxDelete(seqs) {
    if (!seqs.length) return;
    memOutbox = memOutbox.filter((o) => seqs.indexOf(o.seq) < 0);
    try { await idb('outbox', 'readwrite', (s) => { seqs.forEach((q) => s.delete(q)); return null; }); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- modules
  const MODULES = {};              // id -> module definition (registered by qr-module.js etc.)
  const MOD_IDS = ['pc', 'qr', 'tqr'];
  const RULES = () => ({ qr: window.QRRules, tqr: window.TqrRules, pc: window.PcRules });

  // ---------------------------------------------------------------- state
  let sessions = {};            // email -> { token, me }
  let me = null;                // { email, name, displayName, admin }
  let outbox = [];              // [{ seq, actor (email), mod, label, op }]
  let issues = [];
  let base = { qr: new Map(), tqr: new Map(), pc: new Map() };
  let baseRev = 0, secRev = '';
  let namesMap = {};
  let baseSubcats = {};
  let lives = {};               // mod -> LocalStore (base + my queued ops)
  let viewCache = {};
  let queued = new Set();       // uuids with changes waiting to sync
  let online = navigator.onLine;
  let lastSyncAt = null;
  let clockOffset = 0;

  // ---------------------------------------------------------------- local store used with the rules
  function LocalStore(mod, recs, subcats) {
    this.mod = mod; this.recs = recs; this._sub = subcats;
    this.byUuid = new Map(); this.index = new Map();
    recs.forEach((r) => { this.byUuid.set(r.uuid, r); this._idx(r, true); });
  }
  LocalStore.prototype._key = function (r) {
    return this.mod === 'qr' ? r.data : this.mod === 'tqr' ? window.TqrRules.dataKey(r.data) : null;
  };
  LocalStore.prototype._idx = function (r, add) {
    const k = this._key(r); if (k === null || k === undefined) return;
    if (add) { if (!r.deleted) this.index.set(k, r); } else if (this.index.get(k) === r) this.index.delete(k);
  };
  LocalStore.prototype.findAny = function (u) { return this.byUuid.get(u) || null; };
  LocalStore.prototype.find = function (u) { const r = this.byUuid.get(u); return r && !r.deleted ? r : null; };
  LocalStore.prototype.findByData = function (d) { return this.index.get(d) || null; };
  LocalStore.prototype.findByKey = function (k) { return this.index.get(k) || null; };
  LocalStore.prototype.insert = function (r) { this.recs.push(r); this.byUuid.set(r.uuid, r); this._idx(r, true); };
  LocalStore.prototype.remove = function (r) { this._idx(r, false); r.deleted = '1'; };
  LocalStore.prototype.replace = function (old, nu) { this.remove(old); this.insert(nu); };
  LocalStore.prototype.edit = function (r) { return r; };
  LocalStore.prototype.save = function () {};
  LocalStore.prototype.subcats = function () { return this._sub; };
  LocalStore.prototype.addSubcat = function (c, n) { (this._sub[c] = this._sub[c] || []).push(n); };

  function rebuildLive(only) {
    (only ? [only] : MOD_IDS).forEach((mod) => {
      const recs = []; base[mod].forEach((r) => recs.push(Object.assign({}, r)));
      const sub = {}; Object.keys(baseSubcats).forEach((k) => { sub[k] = baseSubcats[k].slice(); });
      lives[mod] = new LocalStore(mod, recs, sub);
      delete viewCache[mod];
    });
    queued = new Set();
    if (me) {
      outbox.forEach((o) => {
        if (o.actor !== me.email) return;
        queued.add(o.op.uuid);
        if (!lives[o.mod]) return;
        if (only && o.mod !== only) return;
        try { RULES()[o.mod].applyOp(o.op, lives[o.mod], me.name, me.displayName); } catch (e) { /* skip a broken op */ }
      });
    }
  }
  function visibleRec(mod, r) {
    if (r.deleted) return false;
    if (mod === 'qr') return window.QRRules.isVisibleTo(r, me.name);
    if (mod === 'pc') return window.PcRules.isVisibleTo(r, me.name);
    return true;
  }
  function view(mod) {
    if (!me || !lives[mod]) return [];
    if (!viewCache[mod]) viewCache[mod] = lives[mod].recs.filter((r) => visibleRec(mod, r));
    return viewCache[mod];
  }

  // ---------------------------------------------------------------- server calls
  async function api(body) {
    if (!CFG.API_URL || /PASTE_YOUR/.test(CFG.API_URL)) throw Object.assign(new Error('The server address is not set yet (config.js).'), { config: true });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30000);
    let res;
    try {
      res = await fetch(CFG.API_URL, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow', signal: ctl.signal });
    } catch (e) { throw Object.assign(new Error('No connection to the server.'), { network: true }); }
    finally { clearTimeout(timer); }
    let data;
    try { data = await res.json(); } catch (e) { throw Object.assign(new Error('The server sent an unreadable answer.'), { network: true }); }
    if (data && data.now) { const t = Date.parse(data.now); if (t) { clockOffset = t - Date.now(); kvSet('clockOffset', clockOffset); } }
    return data;
  }
  const serverNow = () => Date.now() + clockOffset;

  // ---------------------------------------------------------------- status bar
  function renderStatus() {
    const bar = $('statusbar'); if (!bar) return;
    bar.classList.toggle('hidden', !me && !outbox.length);
    bar.classList.toggle('offline', !online);
    $('sb-net').textContent = online ? 'Online' : 'Offline — changes are saved on this device';
    const mine = outbox.length;
    const w = $('sb-wait'); w.classList.toggle('hidden', !mine); w.textContent = 'Waiting to sync: ' + mine;
    const i = $('sb-issue'); i.classList.toggle('hidden', !issues.length); i.textContent = 'Sync issues: ' + issues.length;
    $('sb-last').textContent = lastSyncAt ? 'Last sync ' + lastSyncAt : '';
  }
  on('sb-issue', 'click', () => showIssues());
  on('sb-sync', 'click', () => { syncNow({ force: true, manual: true }); });
  on('issues-close', 'click', () => $('issues-modal').classList.add('hidden'));
  on('issues-clear', 'click', async () => { issues = []; await kvSet('issues', issues); $('issues-modal').classList.add('hidden'); renderStatus(); });
  function showIssues() {
    const ul = $('issues-list'); ul.innerHTML = '';
    issues.slice().reverse().forEach((it) => {
      const li = document.createElement('li');
      li.innerHTML = esc(it.msg) + '<small>' + esc(it.when) + '</small>';
      ul.appendChild(li);
    });
    $('issues-modal').classList.remove('hidden');
  }
  async function addIssue(msg) {
    const st = nowStamp();
    issues.push({ msg, when: st.date + ' ' + st.time });
    if (issues.length > 100) issues = issues.slice(-100);
    await kvSet('issues', issues);
    renderStatus();
  }
  window.addEventListener('online', () => { online = true; renderStatus(); loadGsi(); syncNow({ force: true }); });
  window.addEventListener('offline', () => { online = false; renderStatus(); });

  // ---------------------------------------------------------------- sync engine
  let syncing = false, syncAgain = false, syncAgainForce = false;
  const waiters = new Map();      // outbox seq -> resolver (screens wait briefly for the server's answer)

  function describeOp(o) {
    const m = MODULES[o.mod];
    if (m && m.describe) return m.describe(o);
    return o.op.type + ' ' + (o.label || '');
  }

  async function persistBase() {
    if (!me) return;
    const dump = { rev: baseRev, names: namesMap, subcats: baseSubcats, secRev };
    MOD_IDS.forEach((m) => { dump[m] = Array.from(base[m].values()); });
    await kvSet('base:' + me.email, dump);
  }

  function applyResponse(res) {
    // res.changes / res.gone / res.full / res.rev / res.names / res.subcats
    if (!res.changes) return false;
    MOD_IDS.forEach((mod) => {
      const ch = res.changes[mod] || [];
      if (res.full) base[mod] = new Map();
      ch.forEach((r) => base[mod].set(r.uuid, r));
      ((res.gone || {})[mod] || []).forEach((u) => base[mod].delete(u));
    });
    baseRev = res.rev; if (res.names) namesMap = res.names; if (res.subcats) baseSubcats = res.subcats;
    return true;
  }

  async function handleSessionInfo(res) {
    const sess = me && sessions[me.email];
    if (res.me && sess) {
      sess.me = res.me;
      if (res.token) sess.token = res.token;
      me = Object.assign({}, res.me);
      kvSet('sessions', sessions);
      paintUser();
    } else if (res.token && sess) { sess.token = res.token; kvSet('sessions', sessions); }
    if (res.alerts && res.alerts.length && me && me.admin) showAlerts(res.alerts, res.secRev);
    else if (res.secRev !== undefined && res.alerts === undefined && me && me.admin) secRev = String(res.secRev);
  }

  async function syncNow(opt) {
    opt = opt || {};
    if (syncing) { syncAgain = true; syncAgainForce = syncAgainForce || !!opt.force; return; }
    if (!navigator.onLine && !opt.manual) { online = false; renderStatus(); return; }
    syncing = true;
    let changedData = false, changedMods = {};
    try {
      // 1) send queued changes, one person's token at a time, in order
      let guard = 0;
      while (outbox.length && guard++ < 50) {
        const actor = outbox[0].actor;
        const sess = sessions[actor];
        if (!sess) break;                                  // signed out: keep the changes, send them after the next sign-in
        const batch = outbox.filter((o) => o.actor === actor).slice(0, 100);
        const isMe = me && me.email === actor;
        const res = await api({ action: 'sync', token: sess.token, ops: batch.map((o) => Object.assign({ opId: o.seq, mod: o.mod }, o.op)), since: isMe ? baseRev : 0, secRev: isMe ? secRev : undefined });
        online = true;
        if (!res.ok) {
          if (res.code === 'AUTH') { sessionExpired(actor, res.error); break; }
          await dropBatch(batch, res.error || 'The server refused these changes.');
          continue;
        }
        await handleResults(batch, res.results || []);
        if (isMe) {
          await handleSessionInfo(res);
          if (applyResponse(res)) { changedData = true; await persistBase(); }
        }
        lastSyncAt = nowStamp().time;
      }
      // 2) refresh the lists for the person using the page
      if (me && sessions[me.email] && !outbox.some((o) => o.actor === me.email)) {
        const res = await api({ action: 'sync', token: sessions[me.email].token, ops: [], since: baseRev, force: !!opt.force, secRev });
        online = true;
        if (res.ok) {
          await handleSessionInfo(res);
          if (!res.unchanged && applyResponse(res)) { changedData = true; await persistBase(); }
          lastSyncAt = nowStamp().time;
        } else if (res.code === 'AUTH') sessionExpired(me.email, res.error);
      }
    } catch (e) {
      if (e.network) online = false;
      else if (e.config) { if (opt.manual) toast(e.message); }
      else console.error('sync', e);
    } finally {
      syncing = false;
      if (changedData) { rebuildLive(); notifyData(); }
      renderStatus();
      if (syncAgain) { const f = syncAgainForce; syncAgain = false; syncAgainForce = false; setTimeout(() => syncNow({ force: f }), 50); }
    }
  }

  async function dropBatch(batch, msg) {
    for (const o of batch) await addIssue(describeOp(o) + ' — ' + msg);
    const seqs = batch.map((o) => o.seq);
    outbox = outbox.filter((o) => seqs.indexOf(o.seq) < 0);
    await outboxDelete(seqs);
    waiters.forEach((fn, seq) => { if (seqs.indexOf(seq) >= 0) fn(null); });
    rebuildLive(); notifyData();
  }

  async function handleResults(batch, results) {
    const done = [];
    for (const o of batch) {
      const r = results.find((x) => x.opId === o.seq);
      if (!r) continue;                                    // not answered: keep it for the next round
      done.push(o.seq);
      const waiter = waiters.get(o.seq);
      const shownLive = !!waiter;
      const m = MODULES[o.mod];
      if (!r.ok) {
        if (!shownLive) await addIssue(describeOp(o) + ' — ' + (r.error || 'not accepted'));
      } else if (!shownLive && m && m.issueFor) {
        const msg = m.issueFor(o, r); if (msg) await addIssue(msg);
      }
      if (waiter) waiter(r);
    }
    outbox = outbox.filter((o) => done.indexOf(o.seq) < 0);
    await outboxDelete(done);
  }

  function sessionExpired(actor, msg) {
    delete sessions[actor]; kvSet('sessions', sessions);
    kvSet('base:' + actor, null);                          // no private lists left on a device that is no longer allowed
    toast((msg || 'Your sign-in ended.') + ' Sign in again — your waiting changes are kept.', 9000);
    if (me && me.email === actor) { logout(true); $('login-error').textContent = msg || 'Your sign-in ended. Please sign in again.'; }
  }

  // Put a change on this device; the rules decide first. Returns the rules' answer.
  async function submit(mod, op, label, opts) {
    opts = opts || {};
    if (!me) return { ok: false, error: 'Not signed in.' };
    if (!lives[mod]) rebuildLive();
    op.mod = mod;
    op.stamp = op.stamp || nowStamp();
    const r = RULES()[mod].applyOp(op, lives[mod], me.name, me.displayName);
    delete viewCache[mod];
    if (!r.ok || r.duplicate || r.noop) { return r; }
    const item = await outboxAdd({ actor: me.email, mod, label: label || op.data || op.name || '', op });
    outbox.push(item);
    queued.add(op.uuid);
    renderStatus();
    notifyData();
    let answer = null;
    if (opts.wait && navigator.onLine) {
      const p = new Promise((resolve) => { waiters.set(item.seq, resolve); setTimeout(() => resolve(undefined), 4500); });
      syncNow();
      answer = await p;
      waiters.delete(item.seq);
    } else syncNow();
    r.server = answer || null;
    return r;
  }

  // ---------------------------------------------------------------- redraw (never in the middle of a click / typing)
  let lastInteractionAt = 0;
  ['mousedown', 'touchstart', 'keydown', 'input', 'focusin'].forEach((evt) => document.addEventListener(evt, () => { lastInteractionAt = Date.now(); }, true));
  function editingInTable() {
    const a = document.activeElement;
    return !!(a && a.tagName === 'INPUT' && a.closest('table') && a.closest('.content-panel'));
  }
  let notifyTimer = null;
  function notifyData() {
    if (notifyTimer) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      if (editingInTable() || Date.now() - lastInteractionAt < 1200) { return notifyData(); }
      MOD_IDS.forEach((id) => { const m = MODULES[id]; if (m && m.onData) { try { m.onData(); } catch (e) { console.error('render ' + id, e); } } });
      renderStatus();
    }, 60);
  }

  async function liveRefresh() {
    if (!me || document.hidden || syncing) return;
    if (Date.now() - lastInteractionAt < 1500 || editingInTable()) return;
    if ($('app-screen').classList.contains('hidden')) return;
    syncNow();
  }
  setInterval(liveRefresh, LIVE_MS);
  setInterval(() => { if (outbox.length) syncNow(); }, RETRY_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) liveRefresh(); });

  // ---------------------------------------------------------------- Excel download (built in the browser, works offline)
  function downloadXlsx(filename, sheets) {
    try {
      const bytes = XlsxLite.buildXlsx(sheets);
      const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    } catch (e) { alert('Could not build the Excel file: ' + e.message); }
  }

  // ---------------------------------------------------------------- sidebar / modules
  let activeModule = null;
  function showModule(id) {
    if (!MODULES[id]) return;
    if (activeModule && activeModule !== id && MODULES[activeModule].onHide) MODULES[activeModule].onHide();
    activeModule = id;
    document.querySelectorAll('.sidebar-tab').forEach((b) => b.classList.toggle('active', b.getAttribute('data-target') === MODULES[id].panel));
    MOD_IDS.forEach((m) => { const el = $(MODULES[m].panel); if (el) el.classList.toggle('hidden', m !== id); });
    try { localStorage.setItem('activeModule', id); } catch (e) { /* ignore */ }
    if (MODULES[id].onShow) MODULES[id].onShow();
  }
  document.querySelectorAll('.sidebar-tab').forEach((b) => b.addEventListener('click', () => {
    const id = MOD_IDS.find((m) => MODULES[m] && MODULES[m].panel === b.getAttribute('data-target'));
    if (id) showModule(id);
  }));

  // ---------------------------------------------------------------- sign-in (Google)
  function clientInfo() {
    let device = '';
    try { device = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || ''; } catch (e) { /* ignore */ }
    const ua = navigator.userAgent || '';
    const browser = (ua.match(/(Edg|OPR|Chrome|Firefox|Safari)\/[\d.]+/) || [ua.slice(0, 40)])[0];
    let tz = ''; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { /* ignore */ }
    return { browser, device: device + (/Mobile|Android|iPhone/i.test(ua) ? ' (mobile)' : ''), screen: screen.width + 'x' + screen.height, lang: navigator.language || '', tz };
  }
  let gsiState = 'none';
  function loadGsi() {
    if (gsiState !== 'none' || !navigator.onLine) return;
    if (window.google && window.google.accounts) return initGoogle();
    gsiState = 'loading';
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = () => { gsiState = 'none'; initGoogle(); };
    s.onerror = () => { gsiState = 'none'; s.remove(); };
    document.head.appendChild(s);
  }
  function initGoogle() {
    try {
      if (!window.google || !google.accounts || !google.accounts.id) return;
      if (!CFG.GOOGLE_CLIENT_ID || /PASTE/.test(CFG.GOOGLE_CLIENT_ID)) { $('login-error').textContent = 'The Google Client ID is not set yet (config.js).'; return; }
      google.accounts.id.initialize({ client_id: CFG.GOOGLE_CLIENT_ID, callback: onGoogleCredential, auto_select: false });
      const host = $('g-btn'); host.innerHTML = '';
      google.accounts.id.renderButton(host, { theme: 'outline', size: 'large', text: 'signin_with', width: 280 });
      gsiState = 'ready';
    } catch (e) { console.warn('google sign-in', e); }
  }
  async function onGoogleCredential(resp) {
    const err = $('login-error'); err.textContent = '';
    if (!resp || !resp.credential) { err.textContent = 'Google sign-in was cancelled.'; return; }
    try {
      const res = await api({ action: 'login', idToken: resp.credential, info: clientInfo() });
      online = true;
      if (!res.ok) { err.textContent = res.error || 'Sign-in failed.'; return; }
      sessions[res.me.email] = { token: res.token, me: res.me };
      await kvSet('sessions', sessions);
      await enterApp(res.me.email);
    } catch (e) {
      err.textContent = e.network ? 'No connection. Without internet you can only continue as a person already signed in on this device.' : e.message;
      if (e.network) online = false;
    }
  }
  function renderAccounts() {
    const box = $('login-accounts'); box.innerHTML = '';
    const list = Object.keys(sessions);
    $('login-accounts-title').classList.toggle('hidden', !list.length);
    list.forEach((email) => {
      const s = sessions[email], row = document.createElement('div'); row.className = 'login-account';
      row.innerHTML = '<button type="button" class="login-continue"></button><button type="button" class="login-forget" title="Remove from this device">×</button>';
      row.querySelector('.login-continue').textContent = 'Continue as ' + ((s.me && s.me.displayName) || email) + ' (' + email + ')';
      row.querySelector('.login-continue').addEventListener('click', () => enterApp(email));
      row.querySelector('.login-forget').addEventListener('click', async () => {
        const waiting = outbox.filter((o) => o.actor === email).length;
        if (!await confirmBox('Remove ' + email + ' from this device?' + (waiting ? ' ' + waiting + ' change(s) not yet synced will stay saved and be sent after the next sign-in.' : ''), 'Remove')) return;
        delete sessions[email]; await kvSet('sessions', sessions); await kvSet('base:' + email, null); renderAccounts();
      });
      box.appendChild(row);
    });
  }
  function showLogin() {
    $('app-screen').classList.add('hidden');
    $('login-screen').classList.remove('hidden');
    $('login-offline-hint').classList.toggle('hidden', navigator.onLine);
    renderAccounts(); loadGsi(); renderStatus();
  }
  function paintUser() {
    if (!me) return;
    $('current-user').textContent = me.displayName;
    $('admin-btn').classList.toggle('hidden', !me.admin);
  }
  async function enterApp(email) {
    const sess = sessions[email]; if (!sess) return;
    me = Object.assign({}, sess.me);
    try { localStorage.setItem('currentUserEmail', email); } catch (e) { /* ignore */ }
    const cached = await kvGet('base:' + email, null);
    base = { qr: new Map(), tqr: new Map(), pc: new Map() }; baseRev = 0; namesMap = {}; baseSubcats = {}; secRev = '';
    if (cached) {
      MOD_IDS.forEach((m) => (cached[m] || []).forEach((r) => base[m].set(r.uuid, r)));
      baseRev = cached.rev || 0; namesMap = cached.names || {}; baseSubcats = cached.subcats || {}; secRev = cached.secRev || '';
    }
    if (!Object.keys(baseSubcats).length && window.PcRules) baseSubcats = JSON.parse(JSON.stringify(PcRules.DEFAULT_SUBCATEGORIES));
    rebuildLive();
    paintUser();
    $('login-screen').classList.add('hidden');
    $('app-screen').classList.remove('hidden');
    let want = 'pc'; try { want = localStorage.getItem('activeModule') || 'pc'; } catch (e) { /* ignore */ }
    activeModule = null;
    showModule(MODULES[want] ? want : 'pc');
    notifyData();
    renderStatus();
    asksPersist();
    syncNow({ force: true });
  }
  async function logout(keepErr) {
    if (activeModule && MODULES[activeModule].onHide) MODULES[activeModule].onHide();
    activeModule = null;
    MOD_IDS.forEach((m) => { if (MODULES[m] && MODULES[m].onLogout) MODULES[m].onLogout(); });
    me = null; lives = {}; viewCache = {};
    try { localStorage.removeItem('currentUserEmail'); } catch (e) { /* ignore */ }
    if (!keepErr) $('login-error').textContent = '';
    showLogin();
  }
  on('logout-btn', 'click', () => logout(false));

  // ---------------------------------------------------------------- persistent storage + install
  async function asksPersist() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
        if (!already) await navigator.storage.persist();
      }
    } catch (e) { /* not supported */ }
  }
  let installEvt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('sb-install').classList.remove('hidden'); });
  window.addEventListener('appinstalled', () => { installEvt = null; $('sb-install').classList.add('hidden'); });
  on('sb-install', 'click', async () => { if (!installEvt) return; installEvt.prompt(); try { await installEvt.userChoice; } catch (e) { /* ignore */ } installEvt = null; $('sb-install').classList.add('hidden'); });

  // ---------------------------------------------------------------- admin (people, where signed in, log, alerts, backups)
  async function adminCall(body) {
    if (!me || !sessions[me.email]) return { ok: false, error: 'Not signed in.' };
    try {
      const r = await api(Object.assign({ token: sessions[me.email].token }, body));
      if (!r.ok && r.code === 'AUTH') { sessionExpired(me.email, r.error); }
      return r;
    } catch (e) { return { ok: false, error: e.network ? 'The admin screen needs an internet connection.' : e.message }; }
  }
  let adminTab = 'people', adminData = null;
  function adminModal() { return $('admin-modal'); }
  on('admin-btn', 'click', async () => {
    adminModal().classList.remove('hidden');
    $('admin-body').innerHTML = '<p class="empty-state">Loading…</p>';
    const r = await adminCall({ action: 'adminOverview' });
    if (!r.ok) { adminModal().classList.add('hidden'); alert(r.error || 'Could not reach the server.'); return; }
    adminData = r; renderAdmin();
  });
  on('admin-close', 'click', () => adminModal().classList.add('hidden'));
  document.querySelectorAll('#admin-tabs [data-tab]').forEach((b) => b.addEventListener('click', () => { adminTab = b.getAttribute('data-tab'); renderAdmin(); }));

  function table(headers, rows) {
    if (!rows.length) return '<p class="empty-state">Nothing here yet.</p>';
    return '<div class="admin-table-wrap"><table class="admin-table"><thead><tr>' + headers.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' +
      rows.map((r) => '<tr>' + r.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
  }
  function renderAdmin() {
    document.querySelectorAll('#admin-tabs [data-tab]').forEach((b) => b.classList.toggle('active', b.getAttribute('data-tab') === adminTab));
    const body = $('admin-body'), d = adminData;
    if (adminTab === 'people') {
      body.innerHTML = `
        <p class="manage-hint">Only the Google accounts listed here can sign in. Type each person's Google email exactly as it appears on their account. Removing or turning off a person blocks them at once.</p>
        <div class="manage-add-row col">
          <input id="np-email" type="email" placeholder="Google email (e.g. juan@gmail.com)" autocomplete="off" />
          <input id="np-name" type="text" placeholder="User name shown on records (e.g. Juan)" autocomplete="off" />
          <input id="np-display" type="text" placeholder="Display name (optional)" autocomplete="off" />
          <label class="admin-check"><input id="np-admin" type="checkbox" /> Admin</label>
          <button id="np-add">Add person</button>
        </div>
        <p id="np-error" class="error"></p>
        <ul id="people-list" class="registered-list"></ul>`;
      const ul = $('people-list');
      d.users.forEach((u) => {
        const li = document.createElement('li');
        li.innerHTML = `<div class="registered-info">
            <span class="registered-login-name">${esc(u.name)}${u.admin ? ' <span class="lock-badge">admin</span>' : ''}${u.active ? '' : ' <span class="lock-badge off">turned off</span>'}</span>
            <span class="registered-display-row"><span class="registered-display-label">Display name:</span> <span class="registered-display-value">${esc(u.displayName)}</span></span>
            <span class="registered-email">${esc(u.email)}</span></div>
          <div class="registered-btn-group">
            <button class="edit-name-btn" data-act="edit">Edit</button>
            <button class="reset-browser-btn" data-act="toggle">${u.active ? 'Turn off' : 'Turn on'}</button>
            <button data-act="admin">${u.admin ? 'Remove admin' : 'Make admin'}</button>
            <button data-act="remove">Remove</button></div>`;
        li.addEventListener('click', async (e) => {
          const act = e.target.getAttribute('data-act'); if (!act) return;
          let r;
          if (act === 'edit') {
            const ne = window.prompt('Google email:', u.email); if (ne === null) return;
            const nn = window.prompt('User name shown on records (renaming updates their old records too):', u.name); if (nn === null) return;
            const nd = window.prompt('Display name:', u.displayName); if (nd === null) return;
            r = await adminCall({ action: 'adminEditUser', email: u.email, newEmail: ne, name: nn, displayName: nd });
          } else if (act === 'toggle') r = await adminCall({ action: 'adminEditUser', email: u.email, active: !u.active });
          else if (act === 'admin') r = await adminCall({ action: 'adminEditUser', email: u.email, admin: !u.admin });
          else if (act === 'remove') {
            if (!await confirmBox('Remove ' + u.email + '? They are blocked at once. Their records stay.', 'Remove')) return;
            r = await adminCall({ action: 'adminRemoveUser', email: u.email });
          }
          if (!r.ok) return alert(r.error); adminData.users = r.users; renderAdmin();
        });
        ul.appendChild(li);
      });
      on('np-add', 'click', async () => {
        const r = await adminCall({ action: 'adminAddUser', email: $('np-email').value, name: $('np-name').value, displayName: $('np-display').value, admin: $('np-admin').checked });
        if (!r.ok) { $('np-error').textContent = r.error; return; }
        adminData.users = r.users; renderAdmin();
      });
    } else if (adminTab === 'where') {
      body.innerHTML = '<p class="manage-hint">The app cannot see IP addresses. It shows the time of each sign-in and the browser, device, screen size, language and time zone that the page reports.</p>' +
        table(['Person', 'Email', 'Last sign-in', 'Last active', 'Browser / device'], d.users.map((u) => [esc(u.displayName), esc(u.email), esc(u.lastLoginAt || '—'), esc(u.lastSeen || '—'), esc(u.lastLoginInfo || '—')]));
    } else if (adminTab === 'log') {
      body.innerHTML = table(['Time', 'Person', 'Module', 'Action', 'Detail'], d.log.map((l) => [esc(l.time), esc(l.user), esc(l.module), esc(l.action), esc(l.detail)]));
    } else if (adminTab === 'alerts') {
      body.innerHTML = table(['Time', 'What', 'Email', 'Detail'], d.alerts.map((a) => [esc(a.time), esc(a.type), esc(a.email), esc(a.detail)]));
    } else if (adminTab === 'backups') {
      body.innerHTML = `<p class="manage-hint">A copy of the whole Google Sheet is saved in your Google Drive every Sunday (the newest 8 are kept). You can also make one now.</p>
        <button id="backup-now" class="primary-btn">Back up now</button><p id="backup-msg" class="manage-hint"></p>` +
        table(['Backup', 'Saved'], d.backups.map((b) => [esc(b.name), esc(b.at)]));
      on('backup-now', 'click', async () => {
        $('backup-msg').textContent = 'Working…';
        const r = await adminCall({ action: 'adminBackupNow' });
        if (!r.ok) { $('backup-msg').textContent = r.error; return; }
        adminData.backups = r.backups; renderAdmin(); $('backup-msg').textContent = 'Saved: ' + r.backup.name;
      });
    }
  }
  let alertsOpen = false;
  function showAlerts(list, rev) {
    if (alertsOpen) return;
    alertsOpen = true;
    $('alerts-list').innerHTML = list.map((a) => '<li><b>' + esc(a.type) + '</b> ' + esc(a.email) + '<br>' + esc(a.detail) + '<small>' + esc(a.time) + '</small></li>').join('');
    $('alerts-modal').classList.remove('hidden');
    $('alerts-ok').onclick = async () => {
      $('alerts-modal').classList.add('hidden'); alertsOpen = false;
      const r = await adminCall({ action: 'adminAckAlerts' });
      if (r.ok) { secRev = ''; syncNow({ force: false }); }
    };
  }

  // ---------------------------------------------------------------- start
  async function init() {
    sessions = await kvGet('sessions', {}) || {};
    issues = await kvGet('issues', []) || [];
    clockOffset = await kvGet('clockOffset', 0) || 0;
    outbox = await outboxLoad();
    renderStatus();
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('service worker', e));
    }
    let cur = '';
    try { cur = localStorage.getItem('currentUserEmail') || ''; } catch (e) { /* ignore */ }
    if (cur && sessions[cur]) await enterApp(cur); else showLogin();
    if (outbox.length) syncNow({ force: true });
  }

  window.Core = {
    $, on, esc, uuid, nowStamp, todayStr, localDateOf, toast, confirmBox, downloadXlsx, serverNow,
    register(def) { MODULES[def.id] = def; },
    submit, view, store: (m) => lives[m], me: () => me, names: () => namesMap, subcats: () => (lives.pc ? lives.pc.subcats() : baseSubcats),
    isQueued: (u) => queued.has(u), syncNow, showModule, activeModule: () => activeModule, online: () => online,
    editingInTable, lastInteraction: () => lastInteractionAt, notifyData, rebuild: rebuildLive,
    get outbox() { return outbox; }, get base() { return base; }
  };
  window.__core = window.Core;
  // Modules register themselves while their scripts load, then the page starts.
  window.addEventListener('DOMContentLoaded', init);
})();
