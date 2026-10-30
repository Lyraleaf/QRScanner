/* QR Code Scanner — serverless, offline-first page.
 *
 * Every change (add / rename / delete / status) is a small "op":
 *   1. checked and applied on this device at once (same rules as the server: rules.js),
 *   2. saved in IndexedDB (the "outbox"),
 *   3. sent to the Apps Script server whenever there is internet; the server re-checks it.
 * What you see = the last list from the server + the ops still waiting in the outbox.
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
  function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
  }
  // Local (not UTC) date/time — the Philippines is UTC+8. ts is UTC ISO, only used for ordering.
  function nowStamp() {
    const d = new Date();
    return {
      date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()),
      time: pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()),
      ts: d.toISOString()
    };
  }
  function todayDateStr() { return nowStamp().date; }

  // ---------------------------------------------------------------- tiny UI helpers
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
  const DB_NAME = 'qr-scanner-db';
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
    try {
      const seq = await idb('outbox', 'readwrite', (s) => s.add(item));
      item.seq = seq; return item;
    } catch (e) { item.seq = ++memSeq + 1e9; memOutbox.push(item); return item; }
  }
  async function outboxDelete(seqs) {
    if (!seqs.length) return;
    memOutbox = memOutbox.filter((o) => seqs.indexOf(o.seq) < 0);
    try { await idb('outbox', 'readwrite', (s) => { seqs.forEach((q) => s.delete(q)); return null; }); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- state
  let sessions = {};            // login name -> { token, displayName }
  let me = null;                // { name, displayName } of the person using this page
  let browserId = '';
  let outbox = [];              // [{ seq, actor, label, op }]
  let issues = [];              // things the server did not accept
  let base = [];                // last list from the server for `me`
  let baseRev = '';
  let namesMap = {};
  let live = null;              // LocalStore = base + my queued ops
  let currentScans = [];        // what the tables show
  let queuedUuids = new Set();
  let online = navigator.onLine;
  let lastSyncAt = null;

  function loadBrowserId() {
    let id = '';
    try { id = localStorage.getItem('qrBrowserId') || ''; } catch (e) { /* ignore */ }
    if (!id) { id = uuid(); try { localStorage.setItem('qrBrowserId', id); } catch (e) { /* ignore */ } }
    return id;
  }

  // ---------------------------------------------------------------- local store used with QRRules
  function LocalStore(recs) {
    this.recs = recs;
    this.byUuid = new Map(); this.byData = new Map();
    recs.forEach((r) => { this.byUuid.set(r.uuid, r); if (!r.deleted) this.byData.set(r.data, r); });
  }
  LocalStore.prototype.findAny = function (u) { return this.byUuid.get(u) || null; };
  LocalStore.prototype.find = function (u) { const r = this.byUuid.get(u); return r && !r.deleted ? r : null; };
  LocalStore.prototype.findByData = function (d) { return this.byData.get(d) || null; };
  LocalStore.prototype.insert = function (r) { this.recs.push(r); this.byUuid.set(r.uuid, r); this.byData.set(r.data, r); };
  LocalStore.prototype.replace = function (old, nu) {
    old.deleted = '1'; if (this.byData.get(old.data) === old) this.byData.delete(old.data); this.insert(nu);
  };
  LocalStore.prototype.remove = function (r) { r.deleted = '1'; if (this.byData.get(r.data) === r) this.byData.delete(r.data); };
  LocalStore.prototype.edit = function (r) { return r; };
  LocalStore.prototype.save = function () {};

  function rebuildLive() {
    const recs = base.map((r) => Object.assign({}, r));
    live = new LocalStore(recs);
    queuedUuids = new Set();
    if (me) {
      outbox.forEach((o) => {
        if (o.actor !== me.name) return;
        queuedUuids.add(o.op.uuid);
        try { QRRules.applyOp(o.op, live, me.name, me.displayName); } catch (e) { /* skip a broken op */ }
      });
    }
    recompute();
  }
  function recompute() {
    const name = me ? me.name : '';
    currentScans = live ? live.recs.filter((r) => !r.deleted && QRRules.isVisibleTo(r, name)) : [];
    currentScans.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));   // newest first
  }

  // ---------------------------------------------------------------- server calls
  async function api(body) {
    if (!CFG.API_URL || /PASTE_YOUR/.test(CFG.API_URL)) throw Object.assign(new Error('The server address is not set yet (config.js).'), { config: true });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25000);
    let res;
    try {
      res = await fetch(CFG.API_URL, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow', signal: ctl.signal });
    } catch (e) {
      throw Object.assign(new Error('No connection to the server.'), { network: true });
    } finally { clearTimeout(timer); }
    let data;
    try { data = await res.json(); } catch (e) { throw Object.assign(new Error('The server sent an unreadable answer.'), { network: true }); }
    return data;
  }

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
      li.innerHTML = escapeHtml(it.msg) + '<small>' + escapeHtml(it.when) + '</small>';
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
  window.addEventListener('online', () => { online = true; renderStatus(); syncNow({ force: true }); });
  window.addEventListener('offline', () => { online = false; renderStatus(); });

  // ---------------------------------------------------------------- sync engine
  let syncing = false, syncAgain = false, syncAgainForce = false;
  const waiters = new Map();      // outbox seq -> resolver (the Scan tab waits briefly for the server's answer)

  function describeOp(o) {
    const t = o.op.type;
    const what = o.label || '';
    return (t === 'add' ? 'Save ' : t === 'rename' ? 'Rename ' : t === 'delete' ? 'Delete ' : t === 'status' ? ('Move to ' + o.op.status + ': ') : '') + what;
  }

  async function setBase(scans, rev, names) {
    base = scans; baseRev = rev || ''; if (names) namesMap = names;
    await kvSet('scans:' + me.name, { scans: base, rev: baseRev, names: namesMap });
    rebuildLive();
    redrawSoon();
  }

  async function syncNow(opt) {
    opt = opt || {};
    if (syncing) { syncAgain = true; syncAgainForce = syncAgainForce || !!opt.force; return; }
    if (!navigator.onLine && !opt.manual) { online = false; renderStatus(); return; }
    syncing = true;
    try {
      // 1) send queued changes, one person's token at a time, in order
      let guard = 0;
      while (outbox.length && guard++ < 50) {
        const actor = outbox[0].actor;
        const sess = sessions[actor];
        if (!sess) { await dropActorOps(actor, 'No saved login for ' + actor + ' on this device.'); continue; }
        const batch = outbox.filter((o) => o.actor === actor).slice(0, 100);
        const res = await api({ action: 'sync', token: sess.token, ops: batch.map((o) => Object.assign({ opId: o.seq }, o.op)) });
        online = true;
        if (!res.ok) {
          if (res.code === 'AUTH') { sessionExpired(actor); break; }
          await dropBatch(batch, res.error || 'The server refused these changes.');
          continue;
        }
        await handleResults(batch, res.results || []);
        if (me && me.name === actor) await setBase(res.scans, res.rev, res.names);
        lastSyncAt = nowStamp().time;
      }
      // 2) refresh the list for the person using the page
      if (me && sessions[me.name] && !outbox.some((o) => o.actor === me.name)) {
        const res = await api({ action: 'sync', token: sessions[me.name].token, ops: [], rev: baseRev, force: !!opt.force });
        online = true;
        if (res.ok) {
          if (!res.unchanged) await setBase(res.scans, res.rev, res.names);
          if (res.displayName && res.displayName !== me.displayName) { me.displayName = res.displayName; sessions[me.name].displayName = res.displayName; await kvSet('sessions', sessions); }
          lastSyncAt = nowStamp().time;
        } else if (res.code === 'AUTH') sessionExpired(me.name);
      }
    } catch (e) {
      if (e.network) online = false;
      else if (e.config) { if (opt.manual) toast(e.message); }
      else console.error('sync', e);
    } finally {
      syncing = false;
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
  }
  async function dropActorOps(actor, msg) {
    await dropBatch(outbox.filter((o) => o.actor === actor), msg);
  }

  async function handleResults(batch, results) {
    const done = [];
    for (const o of batch) {
      const r = results.find((x) => x.opId === o.seq);
      if (!r) continue;                                    // not answered: keep it for the next round
      done.push(o.seq);
      const waiter = waiters.get(o.seq);
      const shownLive = !!waiter;
      if (!r.ok) {
        if (!shownLive) await addIssue(describeOp(o) + ' — ' + (r.error || 'not accepted'));
      } else if (r.duplicate && !shownLive) {
        const e = r.entry;
        await addIssue(o.label + ' — already logged' + (e ? ' by ' + (e.scannedByName || e.scannedBy) + ' on ' + e.date + ' ' + e.time : '') + '. Your copy was not saved.');
      }
      if (waiter) waiter(r);
    }
    outbox = outbox.filter((o) => done.indexOf(o.seq) < 0);
    await outboxDelete(done);
  }

  function sessionExpired(actor) {
    delete sessions[actor]; kvSet('sessions', sessions);
    toast('Your login for ' + actor + ' has expired or was reset. Log in again — your waiting changes are kept.', 9000);
    if (me && me.name === actor) { logout(true); $('login-name').value = actor; }
  }

  // Put a change on this device; the rules decide first. Returns the rules' answer.
  async function submit(op, label, opts) {
    opts = opts || {};
    if (!me) return { ok: false, error: 'Not logged in.' };
    if (!live) rebuildLive();
    op.stamp = op.stamp || nowStamp();
    const r = QRRules.applyOp(op, live, me.name, me.displayName);
    if (!r.ok || r.duplicate || r.noop) { recompute(); return r; }
    const item = await outboxAdd({ actor: me.name, label: label || op.data || '', op });
    outbox.push(item);
    queuedUuids.add(op.uuid);
    recompute();
    renderStatus();
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
  ['mousedown', 'touchstart', 'keydown', 'input', 'focusin'].forEach((evt) => on('qr-panel', evt, () => { lastInteractionAt = Date.now(); }, true));
  function editingInTable() {
    const a = document.activeElement, panel = $('qr-panel');
    return !!(a && panel && panel.contains(a) && a.tagName === 'INPUT' && a.closest('table'));
  }
  let redrawTimer = null;
  function redrawSoon() {
    if (redrawTimer) return;
    redrawTimer = setTimeout(() => { redrawTimer = null; if (editingInTable() || Date.now() - lastInteractionAt < 1200) return redrawSoon(); renderAll(); }, 60);
  }
  function renderAll() {
    renderSafely(renderLogTable, 'For Evaluation');
    renderSafely(renderApprovedTable, 'Approved');
    renderSafely(renderDisapprovedTable, 'Disapproved');
    renderSafely(renderAllDataTable, 'All Data');
    renderStatus();
  }
  function renderSafely(fn, label) { try { fn(); } catch (e) { console.error('render ' + label, e); } }

  // ---------------------------------------------------------------- filters / tabs
  let categoryFilter = 'all';
  const scannerChoice = { log: null, alldata: 'all' };
  let qrTabNow = 'scan';
  function myLogin() { return me ? me.name : ''; }
  function scannerFilterFor(tab) { const c = scannerChoice[tab]; return (c === null || c === undefined) ? (myLogin() || 'all') : c; }
  const CATEGORY_LABELS = { electrical: 'Electrical', signboard: 'Signboard' };
  const categoryLabel = (c) => CATEGORY_LABELS[c] || '—';
  const categoryClass = (c) => (c ? 'qr-cat-' + c : 'qr-cat-none');
  function sourceBadge(source) {
    return source === 'manual'
      ? '<span class="qr-source-badge qr-source-manual" title="Entered manually">M</span>'
      : '<span class="qr-source-badge qr-source-camera" title="Scanned with camera">QR</span>';
  }
  const queuedTag = (s) => (queuedUuids.has(s.uuid) ? '<span class="qr-pending-tag" title="Saved on this device, waiting to reach the server">⏳</span>' : '');
  const matchesCategoryFilter = (s) => categoryFilter === 'all' || s.category === categoryFilter;

  on('qr-category-filter', 'change', (e) => { categoryFilter = e.target.value; renderAll(); });

  function switchQrTab(tab) {
    qrTabNow = tab;
    const isScan = tab === 'scan', isLog = tab === 'log', isApproved = tab === 'approved', isDisapproved = tab === 'disapproved', isAllData = tab === 'alldata';
    $('qr-scan-tab').classList.toggle('hidden', !isScan);
    $('qr-log-tab').classList.toggle('hidden', !isLog);
    $('qr-approved-tab').classList.toggle('hidden', !isApproved);
    $('qr-disapproved-tab').classList.toggle('hidden', !isDisapproved);
    $('qr-alldata-tab').classList.toggle('hidden', !isAllData);
    const sf = $('qr-scanner-filter'); if (sf) sf.classList.toggle('hidden', !(isLog || isAllData));
    $('qr-tab-scan').classList.toggle('active', isScan);
    $('qr-tab-log').classList.toggle('active', isLog);
    $('qr-tab-approved').classList.toggle('active', isApproved);
    $('qr-tab-disapproved').classList.toggle('active', isDisapproved);
    $('qr-tab-alldata').classList.toggle('active', isAllData);
    if (isScan) startScanner(); else { stopScanner(); renderAll(); syncNow(); }
  }
  on('qr-tab-scan', 'click', () => switchQrTab('scan'));
  on('qr-tab-log', 'click', () => switchQrTab('log'));
  on('qr-tab-approved', 'click', () => switchQrTab('approved'));
  on('qr-tab-disapproved', 'click', () => switchQrTab('disapproved'));
  on('qr-tab-alldata', 'click', () => switchQrTab('alldata'));

  // ---------------------------------------------------------------- scanner (unchanged behaviour)
  let html5QrCode = null, scanning = false, scanSession = 0, lastScanText = '', lastScanTime = 0;
  function scanConfig(cameraChoice) {
    return {
      fps: 25, qrbox: { width: 240, height: 240 }, aspectRatio: 1.0, disableFlip: false,
      videoConstraints: Object.assign({
        width: { min: 480, ideal: 1920, max: 1920 }, height: { min: 480, ideal: 1920, max: 1920 },
        advanced: [{ focusMode: 'continuous' }]
      }, cameraChoice),
      experimentalFeatures: { useBarCodeDetectorIfSupported: true }
    };
  }
  function tryStartWith(cameraChoice) {
    $('qr-reader').innerHTML = '';
    const inst = new Html5Qrcode('qr-reader');
    return inst.start({ facingMode: 'environment' }, scanConfig(cameraChoice), onScanSuccess).then(() => inst);
  }
  function startScanner() {
    if (scanning) return;
    if (typeof Html5Qrcode === 'undefined') { $('qr-reader').innerHTML = '<div class="qr-empty">Camera library not loaded.</div>'; return; }
    const mySession = ++scanSession;
    const chain = tryStartWith({ facingMode: { exact: 'environment' } })
      .catch(() => { if (mySession !== scanSession) throw new Error('stale'); return tryStartWith({ facingMode: 'environment' }); })
      .catch(() => {
        if (mySession !== scanSession) throw new Error('stale');
        return Html5Qrcode.getCameras().then((cameras) => {
          if (mySession !== scanSession) throw new Error('stale');
          if (!cameras || !cameras.length) throw new Error('No camera found on this device.');
          const cam = cameras.find((c) => /back|rear|environment/i.test(c.label)) || cameras[cameras.length - 1];
          return tryStartWith({ deviceId: { exact: cam.id } });
        });
      });
    chain.then((inst) => {
      if (mySession !== scanSession) { inst.stop().then(() => inst.clear()).catch(() => {}); return; }
      html5QrCode = inst; scanning = true;
      $('qr-stop-scan-btn').classList.remove('hidden'); $('qr-start-scan-btn').classList.add('hidden');
    }).catch((err) => {
      if (mySession !== scanSession) return;
      $('qr-reader').innerHTML = '<div class="qr-empty">Camera error: ' + escapeHtml((err && err.message) ? err.message : err) + '</div>';
    });
  }
  function stopScanner() {
    scanSession++;
    if (html5QrCode && scanning) html5QrCode.stop().then(() => html5QrCode.clear()).catch(() => {});
    html5QrCode = null; scanning = false;
    $('qr-stop-scan-btn').classList.add('hidden'); $('qr-start-scan-btn').classList.remove('hidden');
  }
  on('qr-stop-scan-btn', 'click', stopScanner);
  on('qr-start-scan-btn', 'click', startScanner);

  async function onScanSuccess(decodedText) {
    const now = Date.now();
    if (decodedText === lastScanText && now - lastScanTime < 2500) return;
    lastScanText = decodedText; lastScanTime = now;
    await saveScanData(decodedText, 'camera');
  }

  // true once accepted (saved or recognized duplicate); false when rejected, so the typed value stays.
  async function saveScanData(rawData, source) {
    const data = (rawData || '').trim();
    if (!data) return false;
    const flash = $('qr-result-flash');
    flash.classList.remove('hidden', 'duplicate', 'error');
    const r = await submit({ type: 'add', uuid: uuid(), data, source }, data, { wait: true });
    if (!r.ok) {
      flash.classList.add('error');
      flash.innerHTML = '<div class="qr-flash-heading">Not saved</div><div class="qr-flash-meta">' + escapeHtml(r.error || 'Could not save.') + '</div>';
      return false;
    }
    const srv = r.server;
    if (srv && !srv.ok) {                                  // the server said no a moment later
      flash.classList.add('error');
      flash.innerHTML = '<div class="qr-flash-heading">Not saved</div><div class="qr-flash-meta">' + escapeHtml(srv.error || 'The server did not accept it.') + '</div>';
      return false;
    }
    const dupEntry = r.duplicate ? r.entry : (srv && srv.duplicate ? srv.entry : null);
    if (r.duplicate || (srv && srv.duplicate)) {
      const e = dupEntry;
      const badge = e ? `<span class="qr-cat-badge ${categoryClass(e.category)}">${categoryLabel(e.category)}</span>` : '';
      flash.classList.add('duplicate');
      flash.innerHTML = `
        <div class="qr-flash-heading">⚠ Already scanned</div>
        <div class="qr-flash-data">${e ? sourceBadge(e.source) : ''} ${escapeHtml(e ? e.data : data)} ${badge}</div>
        <div class="qr-flash-meta">${e ? 'First scanned ' + escapeHtml(e.date + ' ' + e.time) + ' · ' + escapeHtml(e.scannedByName || e.scannedBy) : 'Already logged by someone else.'}</div>`;
      return true;
    }
    const entry = (srv && srv.entry) || live.findByData(data) || { data, category: QRRules.detectCategory(data), source, date: '', time: '', scannedByName: me.displayName };
    const badge = `<span class="qr-cat-badge ${categoryClass(entry.category)}">${categoryLabel(entry.category)}</span>`;
    const synced = !!(srv && srv.ok);
    flash.innerHTML = `
      <div class="qr-flash-heading">✔ Saved${synced ? '' : ' on this device'}</div>
      <div class="qr-flash-data">${sourceBadge(entry.source)} ${escapeHtml(entry.data)} ${badge}</div>
      <div class="qr-flash-meta">${escapeHtml((entry.date || '') + ' ' + (entry.time || ''))} · ${escapeHtml(entry.scannedByName || me.displayName)}${synced ? '' : ' · waiting to sync'}</div>`;
    return true;
  }

  on('qr-manual-save-btn', 'click', async () => {
    const input = $('qr-manual-input');
    const value = input.value.trim();
    if (!value) { input.focus(); return; }
    const saved = await saveScanData(value, 'manual');
    if (saved) input.value = '';
    input.focus();
  });
  on('qr-manual-input', 'keydown', (e) => { if (e.key === 'Enter') $('qr-manual-save-btn').click(); });

  // ---------------------------------------------------------------- refresh buttons / live refresh
  ['log', 'approved', 'disapproved', 'alldata'].forEach((t) => on('qr-refresh-' + t + '-btn', 'click', () => { syncNow({ force: true, manual: true }); renderAll(); }));

  async function liveRefresh() {
    if (!me || document.hidden || syncing) return;
    if (Date.now() - lastInteractionAt < 1500) return;
    const panel = $('qr-panel');
    if (!panel || $('app-screen').classList.contains('hidden')) return;
    if (!$('qr-scan-tab').classList.contains('hidden')) { if (outbox.length) syncNow(); return; }
    if (editingInTable()) return;
    syncNow();
  }
  setInterval(liveRefresh, LIVE_MS);
  setInterval(() => { if (outbox.length) syncNow(); }, RETRY_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) liveRefresh(); });

  // ---------------------------------------------------------------- row ownership helpers
  const isMine = (s) => !s.scannedBy || !me || s.scannedBy === me.name;
  const isMyApproval = (s) => (s.approvedBy ? s.approvedBy === (me && me.name) : isMine(s));

  // "Scanned by" dropdown
  let scannerOptionsKey = '';
  const scannerKey = (s) => s.scannedBy || s.scannedByName || '';
  const matchesScannerFilter = (s, tab) => { const f = scannerFilterFor(tab); return f === 'all' || scannerKey(s) === f; };
  function refreshScannerOptions() {
    const sel = $('qr-scanner-filter'); if (!sel) return;
    const people = new Map();
    const mine = myLogin();
    if (mine) people.set(mine, (me && me.displayName) || mine);
    currentScans.forEach((s) => {
      if ((s.status !== 'pending' && s.status !== 'printed') || !scannerKey(s)) return;
      if (!people.has(scannerKey(s)) || scannerKey(s) === mine) people.set(scannerKey(s), s.scannedByName || scannerKey(s));
    });
    const list = [...people.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    const key = list.map(([l, n]) => l + '|' + n).join(';');
    if (key !== scannerOptionsKey) {
      scannerOptionsKey = key; sel.innerHTML = '';
      const all = document.createElement('option'); all.value = 'all'; all.textContent = 'Scanned By: All'; sel.appendChild(all);
      list.forEach(([l, n]) => { const o = document.createElement('option'); o.value = l; o.textContent = 'Scanned By: ' + n; sel.appendChild(o); });
    }
    const tab = qrTabNow === 'alldata' ? 'alldata' : 'log';
    const cur = scannerFilterFor(tab);
    if (cur !== 'all' && !people.has(cur)) scannerChoice[tab] = 'all';
    sel.value = scannerFilterFor(tab);
  }
  on('qr-scanner-filter', 'change', (e) => { scannerChoice[qrTabNow === 'alldata' ? 'alldata' : 'log'] = e.target.value; renderAll(); });

  // ---------------------------------------------------------------- tables
  const searchMatch = (s, q) => (s.data || '').toLowerCase().includes(q) || (s.name || '').toLowerCase().includes(q) || (s.scannedByName || '').toLowerCase().includes(q);
  const countText = (n) => 'Total: ' + n + ' record' + (n === 1 ? '' : 's');
  function nameContent(name) {
    return name ? '<span class="qr-name-display">' + escapeHtml(name) + '</span>' : '<span class="qr-name-placeholder">+ add name</span>';
  }

  function renderLogTable() {
    const wrap = $('qr-log-table-wrap');
    refreshScannerOptions();
    const pending = currentScans.filter((s) => s.status === 'pending' && matchesCategoryFilter(s) && matchesScannerFilter(s, 'log'));
    $('qr-log-count').textContent = countText(pending.length);
    if (!pending.length) { wrap.innerHTML = '<div class="qr-empty">No records for evaluation.</div>'; return; }
    let html = '<table><thead><tr><th>Data</th><th>Category</th><th>Name</th><th>By</th><th>Date</th><th>Time</th><th></th></tr></thead><tbody>';
    for (const s of pending) {
      const mine = isMine(s);
      html += `<tr class="${queuedUuids.has(s.uuid) ? 'qr-row-queued' : ''}">
        <td class="qr-data-cell" title="QR data is locked and cannot be edited">${sourceBadge(s.source)} ${escapeHtml(s.data)}${queuedTag(s)}</td>
        <td><span class="qr-cat-badge ${categoryClass(s.category)}">${categoryLabel(s.category)}</span></td>
        ${mine
          ? `<td class="qr-name-cell" data-act="edit-name" data-uuid="${escapeHtml(s.uuid)}">${nameContent(s.name)}</td>`
          : `<td title="Only ${escapeHtml(s.scannedByName)} can edit this name">${escapeHtml(s.name || '')}</td>`}
        <td>${escapeHtml(s.scannedByName)}</td>
        <td>${escapeHtml(s.date)}</td>
        <td>${escapeHtml(s.time)}</td>
        <td class="qr-row-actions">
          <button class="qr-approve-btn" data-act="status" data-to="approved" data-uuid="${escapeHtml(s.uuid)}">✔ Approved</button>
          <button class="qr-disapprove-btn" data-act="status" data-to="disapproved" data-uuid="${escapeHtml(s.uuid)}">✘ Disapproved</button>
          ${mine ? `<button class="qr-del-btn" data-act="delete" data-uuid="${escapeHtml(s.uuid)}">🗑</button>` : ''}
        </td>
      </tr>`;
    }
    wrap.innerHTML = html + '</tbody></table>';
  }

  function simpleListTable(opts) {
    const wrap = $(opts.wrap);
    const q = ($(opts.search).value || '').trim().toLowerCase();
    let results = currentScans.filter((s) => s.status === opts.status && matchesCategoryFilter(s));
    if (q) results = results.filter((s) => searchMatch(s, q));
    $(opts.count).textContent = countText(results.length);
    if (!results.length) { wrap.innerHTML = '<div class="qr-empty">' + opts.empty + '</div>'; return; }
    let html = '<table><thead><tr><th>Data</th><th>Category</th><th>Name</th><th>By</th><th>' + opts.label + ' By</th><th>' + opts.label + ' Date</th><th>' + opts.label + ' Time</th><th></th></tr></thead><tbody>';
    for (const s of results) {
      html += `<tr class="${queuedUuids.has(s.uuid) ? 'qr-row-queued' : ''}">
        <td class="qr-data-cell" title="QR data is locked and cannot be edited">${sourceBadge(s.source)} ${escapeHtml(s.data)}${queuedTag(s)}</td>
        <td><span class="qr-cat-badge ${categoryClass(s.category)}">${categoryLabel(s.category)}</span></td>
        <td>${escapeHtml(s.name || '')}</td>
        <td>${escapeHtml(s.scannedByName)}</td>
        <td>${escapeHtml(s[opts.key + 'ByName'] || s[opts.key + 'By'] || '—')}</td>
        <td>${escapeHtml(s[opts.key + 'Date'] || '—')}</td>
        <td>${escapeHtml(s[opts.key + 'Time'] || '—')}</td>
        <td><button class="qr-revert-btn" data-act="status" data-to="pending" data-uuid="${escapeHtml(s.uuid)}">↩ back to evaluation</button></td>
      </tr>`;
    }
    wrap.innerHTML = html + '</tbody></table>';
  }
  function renderApprovedTable() {
    simpleListTable({ wrap: 'qr-approved-table-wrap', search: 'qr-approved-search', count: 'qr-approved-count', status: 'approved', label: 'Approved', key: 'approved', empty: 'No approved records yet.' });
  }
  function renderDisapprovedTable() {
    simpleListTable({ wrap: 'qr-disapproved-table-wrap', search: 'qr-disapproved-search', count: 'qr-disapproved-count', status: 'disapproved', label: 'Disapproved', key: 'disapproved', empty: 'No disapproved records.' });
  }

  function allDataRows() {
    const q = ($('qr-alldata-search').value || '').trim().toLowerCase();
    const dateFilter = $('qr-alldata-date-filter').value || '';
    let results = currentScans.filter((s) => s.status === 'printed' && matchesCategoryFilter(s) && matchesScannerFilter(s, 'alldata'));
    if (q) results = results.filter((s) => searchMatch(s, q));
    else if (dateFilter) results = results.filter((s) => s.printedDate === dateFilter);
    results.sort((a, b) => String(b.printedTimestamp || '').localeCompare(String(a.printedTimestamp || '')));
    return results;
  }
  function renderAllDataTable() {
    const wrap = $('qr-alldata-table-wrap');
    refreshScannerOptions();
    const results = allDataRows();
    $('qr-alldata-count').textContent = countText(results.length);
    if (!results.length) { wrap.innerHTML = '<div class="qr-empty">No matching records.</div>'; return; }
    let html = '<table><thead><tr><th>Data</th><th>Category</th><th>Name</th><th>By</th><th>Scanned Date</th><th>Scanned Time</th><th>Approved By</th><th>Approved Date</th><th>Approved Time</th><th>Printed Date</th><th>Printed Time</th><th></th></tr></thead><tbody>';
    for (const s of results) {
      html += `<tr class="${queuedUuids.has(s.uuid) ? 'qr-row-queued' : ''}">
        <td class="qr-data-cell" title="QR data is locked and cannot be edited">${sourceBadge(s.source)} ${escapeHtml(s.data)}${queuedTag(s)}</td>
        <td><span class="qr-cat-badge ${categoryClass(s.category)}">${categoryLabel(s.category)}</span></td>
        <td>${escapeHtml(s.name || '')}</td>
        <td>${escapeHtml(s.scannedByName)}</td>
        <td>${escapeHtml(s.date || '—')}</td>
        <td>${escapeHtml(s.time || '—')}</td>
        <td>${escapeHtml(s.approvedByName || s.approvedBy || '—')}</td>
        <td>${escapeHtml(s.approvedDate || '—')}</td>
        <td>${escapeHtml(s.approvedTime || '—')}</td>
        <td>${escapeHtml(s.printedDate || '—')}</td>
        <td>${escapeHtml(s.printedTime || '—')}</td>
        <td>${isMyApproval(s) ? `<button class="qr-revert-btn" data-act="status" data-to="approved" data-uuid="${escapeHtml(s.uuid)}">↩ back to approved</button>` : ''}</td>
      </tr>`;
    }
    wrap.innerHTML = html + '</tbody></table>';
  }

  on('qr-approved-search', 'input', renderApprovedTable);
  on('qr-clear-approved-search-btn', 'click', () => { $('qr-approved-search').value = ''; renderApprovedTable(); });
  on('qr-disapproved-search', 'input', renderDisapprovedTable);
  on('qr-clear-disapproved-search-btn', 'click', () => { $('qr-disapproved-search').value = ''; renderDisapprovedTable(); });
  on('qr-alldata-search', 'input', renderAllDataTable);
  on('qr-clear-alldata-search-btn', 'click', () => { $('qr-alldata-search').value = ''; renderAllDataTable(); });
  on('qr-alldata-date-filter', 'change', renderAllDataTable);
  on('qr-clear-alldata-date-btn', 'click', () => { $('qr-alldata-date-filter').value = ''; renderAllDataTable(); });

  // ---------------------------------------------------------------- row actions (event delegation)
  ['qr-log-table-wrap', 'qr-approved-table-wrap', 'qr-disapproved-table-wrap', 'qr-alldata-table-wrap'].forEach((id) => {
    on(id, 'click', (e) => {
      const el = e.target.closest('[data-act]'); if (!el) return;
      const u = el.getAttribute('data-uuid');
      const act = el.getAttribute('data-act');
      if (act === 'edit-name') editName(el, u);
      else if (act === 'delete') deleteScan(u);
      else if (act === 'status') setStatus(u, el.getAttribute('data-to'));
    });
  });

  function editName(cell, id) {
    if (cell.querySelector('input')) return;
    const scan = currentScans.find((s) => s.uuid === id);
    cell.innerHTML = '';
    const input = document.createElement('input');
    input.type = 'text'; input.value = (scan && scan.name) || ''; input.placeholder = 'Enter name';
    cell.appendChild(input); input.focus(); input.select();
    let saved = false;
    const save = async () => {
      if (saved) return; saved = true;
      const r = await submit({ type: 'rename', uuid: id, name: input.value.trim() }, scan ? scan.data : '');
      if (!r.ok) alert('Could not save name: ' + r.error);
      renderLogTable();
    };
    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { saved = true; renderLogTable(); }
    });
  }

  async function deleteScan(id) {
    if (!confirm('Delete this scan record?')) return;
    const scan = currentScans.find((s) => s.uuid === id);
    const r = await submit({ type: 'delete', uuid: id }, scan ? scan.data : '');
    if (!r.ok) alert('Could not delete: ' + r.error);
    renderAll();
  }

  async function setStatus(id, status) {
    const scan = currentScans.find((s) => s.uuid === id);
    const r = await submit({ type: 'status', uuid: id, status }, scan ? scan.data : '');
    if (!r.ok) alert('Could not update record: ' + r.error);
    renderAll();
  }

  // ---------------------------------------------------------------- print transmittal (Approved -> All Data)
  on('qr-print-btn', 'click', printTransmittal);
  async function printTransmittal() {
    const selected = currentScans.filter((s) => s.status === 'approved' && isMyApproval(s) && matchesCategoryFilter(s));
    if (!selected.length) {
      const waiting = currentScans.some((s) => s.status === 'approved' && !isMyApproval(s));
      alert(waiting
        ? 'There are no records approved by you to print. Records approved by someone else are printed by that person.'
        : 'There are no approved records to print yet.');
      return;
    }
    const rows = selected.map((s, i) => `
      <tr><td>${i + 1}</td><td>${escapeHtml(s.data)}</td><td>${escapeHtml(s.name || '')}</td></tr>`).join('');
    const printedOn = new Date().toLocaleString();
    const docHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Transmittal</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; color: #111; padding: 40px; }
  h1 { text-align: center; letter-spacing: 2px; margin-bottom: 4px; }
  .meta { text-align: center; color: #555; font-size: 0.85rem; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; }
  th, td { border: 1px solid #333; padding: 8px 10px; font-size: 0.9rem; text-align: left; }
  th { background: #f0f0f0; }
  .signatures { display: flex; justify-content: space-between; margin-top: 70px; }
  .sig-block { width: 45%; text-align: center; }
  .sig-line { border-top: 1px solid #111; margin-top: 50px; padding-top: 6px; font-size: 0.85rem; }
  @media print { body { padding: 20px; } }
</style>
</head>
<body>
  <h1>TRANSMITTAL</h1>
  <div class="meta">Printed on ${escapeHtml(printedOn)}</div>
  <table>
    <thead><tr><th>Count</th><th>Application No.</th><th>Name</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="signatures">
    <div class="sig-block"><div class="sig-line">Received by</div></div>
    <div class="sig-block"><div class="sig-line">Endorsed by</div></div>
  </div>
  <script>window.onload = function() { window.print(); };<\/script>
</body>
</html>`;
    const printWindow = window.open('', '_blank');
    if (!printWindow) { alert('Please allow pop-ups to print the transmittal.'); return; }
    printWindow.document.open(); printWindow.document.write(docHtml); printWindow.document.close();
    let failed = 0;
    for (const s of selected) {
      const r = await submit({ type: 'status', uuid: s.uuid, status: 'printed' }, s.data);
      if (!r.ok) failed++;
    }
    if (failed) alert('Printed, but ' + failed + ' record(s) could not be moved to All Data.');
    renderAll();
  }

  // ---------------------------------------------------------------- Excel (built in the browser, works offline)
  const CAT_LABEL = { electrical: 'Electrical Applications', signboard: 'Signboard Applications' };
  on('qr-download-alldata-btn', 'click', () => {
    const rows = allDataRows();
    const headers = ['Data', 'Category', 'Source', 'Name', 'Scanned By', 'Scanned Date', 'Scanned Time', 'Approved By', 'Approved Date', 'Approved Time', 'Printed Date', 'Printed Time'];
    const widths = [30, 24, 10, 24, 18, 13, 13, 18, 13, 13, 13, 13];
    const toRow = (s) => [s.data || '', CAT_LABEL[s.category] || '', s.source === 'manual' ? 'Manual' : 'Camera', s.name || '',
      s.scannedByName || s.scannedBy || '', s.date || '', s.time || '', s.approvedByName || s.approvedBy || '', s.approvedDate || '', s.approvedTime || '', s.printedDate || '', s.printedTime || ''];
    const sheets = [{ name: 'All Data', headers, widths, rows: rows.map(toRow) }];
    if (categoryFilter === 'all') {
      sheets.push({ name: 'Electrical', headers, widths, rows: rows.filter((s) => s.category === 'electrical').map(toRow) });
      sheets.push({ name: 'Signboard', headers, widths, rows: rows.filter((s) => s.category === 'signboard').map(toRow) });
    }
    try {
      const bytes = XlsxLite.buildXlsx(sheets);
      const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'All-Data-' + ($('qr-alldata-date-filter').value || todayDateStr()) + '.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    } catch (e) { alert('Could not build the Excel file: ' + e.message); }
  });

  // ---------------------------------------------------------------- login / logout
  function showLogin() {
    $('app-screen').classList.add('hidden');
    $('login-screen').classList.remove('hidden');
    $('login-offline-hint').classList.toggle('hidden', navigator.onLine);
    renderStatus();
  }
  async function enterApp(name) {
    const sess = sessions[name];
    me = { name, displayName: (sess && sess.displayName) || name };
    try { localStorage.setItem('qrCurrentUser', name); } catch (e) { /* ignore */ }
    const cached = await kvGet('scans:' + name, null);
    base = cached ? cached.scans : []; baseRev = cached ? (cached.rev || '') : ''; namesMap = cached ? (cached.names || {}) : {};
    rebuildLive();
    $('current-user').textContent = me.displayName;
    $('login-screen').classList.add('hidden');
    $('app-screen').classList.remove('hidden');
    const df = $('qr-alldata-date-filter'); if (df && !df.value) df.value = todayDateStr();
    scannerChoice.log = null; scannerChoice.alldata = 'all';
    switchQrTab('scan');
    renderStatus();
    asksPersist();
    syncNow({ force: true });
  }
  async function doLogin() {
    const name = $('login-name').value.trim();
    const err = $('login-error'); err.textContent = '';
    if (!name) { err.textContent = 'Enter your name.'; return; }
    const btn = $('login-btn'); btn.disabled = true;
    try {
      let res = null;
      try { res = await api({ action: 'login', name, browserId }); online = true; }
      catch (e) {
        if (e.network && sessions[name]) { online = false; await enterApp(name); return; }
        if (e.network) { err.textContent = 'No connection. Only names that already signed in on this device can log in offline.'; online = false; return; }
        err.textContent = e.message; return;
      }
      if (!res.ok) { err.textContent = res.error || 'Login failed.'; return; }
      sessions[name] = { token: res.token, displayName: res.displayName || name };
      await kvSet('sessions', sessions);
      await enterApp(name);
    } finally { btn.disabled = false; }
  }
  on('login-btn', 'click', doLogin);
  on('login-name', 'keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  async function logout(keepName) {
    stopScanner();
    me = null; live = null; base = []; currentScans = [];
    try { localStorage.removeItem('qrCurrentUser'); } catch (e) { /* ignore */ }
    if (!keepName) $('login-name').value = '';
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

  // ---------------------------------------------------------------- admin: registered names
  let adminToken = '';
  const modal = () => $('manage-names-modal');
  function adminShow(state) {
    ['pw-setup-state', 'pw-lock-state', 'pw-change-state', 'manage-unlocked-state'].forEach((id) => $(id).classList.toggle('hidden', id !== state));
  }
  async function adminCall(body) {
    try { return await api(Object.assign({ adminToken }, body)); }
    catch (e) { return { ok: false, error: e.network ? 'The admin screen needs an internet connection.' : e.message }; }
  }
  on('manage-names-link', 'click', async () => {
    modal().classList.remove('hidden');
    const st = await adminCall({ action: 'adminStatus' });
    if (!st.ok) { modal().classList.add('hidden'); alert(st.error || 'Could not reach the server.'); return; }
    adminToken = '';
    ['setup-password', 'setup-password-confirm', 'unlock-password'].forEach((id) => { $(id).value = ''; });
    $('setup-error').textContent = ''; $('unlock-error').textContent = '';
    adminShow(st.passwordSet ? 'pw-lock-state' : 'pw-setup-state');
    setTimeout(() => $(st.passwordSet ? 'unlock-password' : 'setup-password').focus(), 50);
  });
  on('setup-cancel-btn', 'click', () => modal().classList.add('hidden'));
  on('unlock-cancel-btn', 'click', () => modal().classList.add('hidden'));
  on('close-manage-btn', 'click', () => { adminToken = ''; modal().classList.add('hidden'); });
  on('setup-password-btn', 'click', async () => {
    const p = $('setup-password').value, c = $('setup-password-confirm').value;
    if (p.length < 6) { $('setup-error').textContent = 'Use at least 6 characters.'; return; }
    if (p !== c) { $('setup-error').textContent = 'Passwords do not match.'; return; }
    const r = await adminCall({ action: 'adminSetup', password: p });
    if (!r.ok) { $('setup-error').textContent = r.error; return; }
    adminToken = r.adminToken; await adminOpenList();
  });
  async function unlock() {
    const r = await adminCall({ action: 'adminLogin', password: $('unlock-password').value });
    if (!r.ok) { $('unlock-error').textContent = r.error; return; }
    adminToken = r.adminToken; await adminOpenList();
  }
  on('unlock-btn', 'click', unlock);
  on('unlock-password', 'keydown', (e) => { if (e.key === 'Enter') unlock(); });
  on('change-password-link', 'click', () => { $('change-error').textContent = ''; $('change-old-password').value = ''; $('change-new-password').value = ''; adminShow('pw-change-state'); });
  on('change-cancel-btn', 'click', () => adminShow('manage-unlocked-state'));
  on('change-password-btn', 'click', async () => {
    const r = await adminCall({ action: 'adminChangePassword', oldPassword: $('change-old-password').value, password: $('change-new-password').value });
    if (!r.ok) { $('change-error').textContent = r.error; return; }
    toast('Admin password changed.'); adminShow('manage-unlocked-state');
  });
  async function adminOpenList() {
    adminShow('manage-unlocked-state');
    const r = await adminCall({ action: 'adminListUsers' });
    if (!r.ok) { $('register-error').textContent = r.error; return; }
    renderUsers(r.users);
  }
  function renderUsers(users) {
    const ul = $('registered-list'); ul.innerHTML = '';
    $('registered-empty').classList.toggle('hidden', !!users.length);
    users.forEach((u) => {
      const li = document.createElement('li');
      const mins = u.slotOpenForMs ? Math.ceil(u.slotOpenForMs / 60000) : 0;
      li.innerHTML = `
        <div class="registered-info">
          <span class="registered-login-name">${escapeHtml(u.name)}</span>
          <span class="registered-display-row"><span class="registered-display-label">Display name:</span> <span class="registered-display-value">${escapeHtml(u.displayName)}</span></span>
          <span class="registered-email ${u.email ? '' : 'empty'}">${u.email ? escapeHtml(u.email) : 'no email yet'}</span>
          <span class="lock-badge">${u.locked ? '🔒 locked to a browser' : 'not yet used'}${u.secondLinked ? ' · 2nd device linked' : ''}</span>
          <span class="device-slot-row">
            <span>2nd device:</span>
            <select class="device-slot-select" data-act="slot">
              <option value="closed"${u.slotMode === 'closed' ? ' selected' : ''}>Closed</option>
              <option value="once"${u.slotMode === 'once' ? ' selected' : ''}>Open once (10 min)</option>
              <option value="always"${u.slotMode === 'always' ? ' selected' : ''}>Always open</option>
            </select>
            ${mins ? `<span class="device-slot-note linked">open for ${mins} min</span>` : ''}
            ${u.secondLinked ? '<button class="unlink-second-btn" data-act="unlink">Unlink</button>' : ''}
          </span>
        </div>
        <div class="registered-btn-group">
          <button class="edit-name-btn" data-act="email">Email / name</button>
          <button class="reset-browser-btn" data-act="reset">Reset browser</button>
          <button data-act="remove">Remove</button>
        </div>`;
      li.addEventListener('click', async (e) => {
        const act = e.target.getAttribute('data-act'); if (!act || act === 'slot') return;
        if (act === 'email') {
          const email = window.prompt('Google account email for ' + u.name + ':', u.email || ''); if (email === null) return;
          const disp = window.prompt('Display name (shown in the lists):', u.displayName || u.name); if (disp === null) return;
          const r = await adminCall({ action: 'adminEditUser', name: u.name, email, displayName: disp });
          if (!r.ok) return alert(r.error); renderUsers(r.users);
        } else if (act === 'reset') {
          if (!await confirmBox('Reset the browser lock for "' + u.name + '"? Their next login claims the name again, and their current logins stop working.', 'Reset')) return;
          const r = await adminCall({ action: 'adminResetBrowser', name: u.name }); if (!r.ok) return alert(r.error); renderUsers(r.users);
        } else if (act === 'unlink') {
          const r = await adminCall({ action: 'adminUnlinkSecond', name: u.name }); if (!r.ok) return alert(r.error); renderUsers(r.users);
        } else if (act === 'remove') {
          if (!await confirmBox('Remove "' + u.name + '"? They will no longer be able to log in. Their records stay.', 'Remove')) return;
          const r = await adminCall({ action: 'adminRemoveUser', name: u.name }); if (!r.ok) return alert(r.error); renderUsers(r.users);
        }
      });
      li.querySelector('select').addEventListener('change', async (e) => {
        const r = await adminCall({ action: 'adminSetSlot', name: u.name, mode: e.target.value }); if (!r.ok) return alert(r.error); renderUsers(r.users);
      });
      ul.appendChild(li);
    });
  }
  on('register-name-btn', 'click', async () => {
    const name = $('new-registered-name').value.trim();
    const r = await adminCall({ action: 'adminAddUser', name, displayName: $('new-registered-display').value.trim(), email: $('new-registered-email').value.trim() });
    if (!r.ok) { $('register-error').textContent = r.error; return; }
    $('register-error').textContent = '';
    ['new-registered-name', 'new-registered-display', 'new-registered-email'].forEach((id) => { $(id).value = ''; });
    renderUsers(r.users);
  });

  // ---------------------------------------------------------------- start
  async function init() {
    browserId = loadBrowserId();
    sessions = await kvGet('sessions', {}) || {};
    issues = await kvGet('issues', []) || [];
    outbox = await outboxLoad();
    renderStatus();
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('service worker', e));
    }
    let cur = '';
    try { cur = localStorage.getItem('qrCurrentUser') || ''; } catch (e) { /* ignore */ }
    if (cur && sessions[cur]) await enterApp(cur); else showLogin();
    if (outbox.length) syncNow({ force: true });
  }
  window.__qrDebug = { get outbox() { return outbox; }, get base() { return base; }, get view() { return currentScans; }, syncNow, submit };
  init();
})();
