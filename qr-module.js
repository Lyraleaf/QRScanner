/* QR Code Scanner for Electrical and Signboard — module screen (uses core.js). */
(function () {
  'use strict';
  const { $, on, esc: escapeHtml, uuid, todayStr: todayDateStr } = Core;
  const me = () => Core.me();
  let currentScans = [];
  const queuedTag0 = null;
  function recompute() {
    currentScans = Core.view('qr').slice().sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));   // newest first
  }
  const submit = (op, label, opts) => Core.submit('qr', op, label, opts).then((r) => { recompute(); return r; });
  const syncNow = (o) => Core.syncNow(o);
  const queuedUuids = { has: (u) => Core.isQueued(u) };
  const live = { findByData: (d) => Core.store('qr').findByData(d) };
  const QRRules_ = window.QRRules;
  function renderAll() {
    recompute();
    renderSafely(renderLogTable, 'For Evaluation');
    renderSafely(renderApprovedTable, 'Approved');
    renderSafely(renderDisapprovedTable, 'Disapproved');
    renderSafely(renderAllDataTable, 'All Data');
  }
  function renderSafely(fn, label) { try { fn(); } catch (e) { console.error('render ' + label, e); } }

  // ---------------------------------------------------------------- filters / tabs
  let categoryFilter = 'all';
  const scannerChoice = { log: null, alldata: 'all' };
  let qrTabNow = 'scan';
  function myLogin() { return me() ? me().name : ''; }
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
    const entry = (srv && srv.entry) || live.findByData(data) || { data, category: QRRules_.detectCategory(data), source, date: '', time: '', scannedByName: me().displayName };
    const badge = `<span class="qr-cat-badge ${categoryClass(entry.category)}">${categoryLabel(entry.category)}</span>`;
    const synced = !!(srv && srv.ok);
    flash.innerHTML = `
      <div class="qr-flash-heading">✔ Saved${synced ? '' : ' on this device'}</div>
      <div class="qr-flash-data">${sourceBadge(entry.source)} ${escapeHtml(entry.data)} ${badge}</div>
      <div class="qr-flash-meta">${escapeHtml((entry.date || '') + ' ' + (entry.time || ''))} · ${escapeHtml(entry.scannedByName || me().displayName)}${synced ? '' : ' · waiting to sync'}</div>`;
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

  // ---------------------------------------------------------------- row ownership helpers
  const isMine = (s) => !s.scannedBy || !me() || s.scannedBy === me().name;
  const isMyApproval = (s) => (s.approvedBy ? s.approvedBy === (me() && me().name) : isMine(s));

  // "Scanned by" dropdown
  let scannerOptionsKey = '';
  const scannerKey = (s) => s.scannedBy || s.scannedByName || '';
  const matchesScannerFilter = (s, tab) => { const f = scannerFilterFor(tab); return f === 'all' || scannerKey(s) === f; };
  function refreshScannerOptions() {
    const sel = $('qr-scanner-filter'); if (!sel) return;
    const people = new Map();
    const mine = myLogin();
    if (mine) people.set(mine, (me() && me().displayName) || mine);
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


  ['log', 'approved', 'disapproved', 'alldata'].forEach((t) => on('qr-refresh-' + t + '-btn', 'click', () => { syncNow({ force: true, manual: true }); renderAll(); }));

  // ---------------------------------------------------------------- module hooks
  Core.register({
    id: 'qr', panel: 'qr-panel',
    onShow() { switchQrTab('scan'); },
    onHide() { stopScanner(); },
    onLogout() { currentScans = []; scannerChoice.log = null; scannerChoice.alldata = 'all'; },
    onData() { const p = $('qr-panel'); if (p && !p.classList.contains('hidden')) renderAll(); },
    describe(o) {
      const t = o.op.type, what = o.label || '';
      return 'QR Scanner: ' + (t === 'add' ? 'Save ' : t === 'rename' ? 'Rename ' : t === 'delete' ? 'Delete ' : t === 'status' ? ('Move to ' + o.op.status + ': ') : '') + what;
    },
    issueFor(o, r) {
      if (r.duplicate) { const e = r.entry; return 'QR Scanner: ' + o.label + ' — already logged' + (e ? ' by ' + (e.scannedByName || e.scannedBy) + ' on ' + e.date + ' ' + e.time : '') + '. Your copy was not saved.'; }
      return null;
    }
  });
  { const df = $('qr-alldata-date-filter'); if (df && !df.value) df.value = todayDateStr(); }
})();
