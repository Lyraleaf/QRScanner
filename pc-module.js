/* Manual Prechecking of Professionals and Applications — module screen (uses core.js).
 * Works offline: every change is saved on this device first and synced later.
 * Pending entries and remarks are private to the person who added them (enforced on the server too). */
(function () {
  'use strict';
  const { $, on } = Core;
  const esc = Core.esc;
  const PR = window.PcRules;
  const q = (u) => "'" + u + "'";
  const submit = (op, label, opts) => Core.submit('pc', op, label, opts);
  const me = () => Core.me();
  const ADD_NEW = '__add_new__';

  let scope = 'today', statusFilter = 'all', revealAll = false, statsSort = 'primary';
  window.__pcApp = { act: null };

  const entries = () => Core.view('pc');
  const isMine = (e) => me() && e.addedBy === me().name;
  const pad = (n) => String(n).padStart(2, '0');
  function hhmm(iso) { const d = new Date(iso); return isNaN(d) ? '' : pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  const decidedDate = (e) => (e.decidedAt ? Core.localDateOf(e.decidedAt) : '');
  const createdDate = (e) => (e.createdAt ? Core.localDateOf(e.createdAt) : '');
  const catClass = (c) => 'category-' + String(c || '').toLowerCase().replace(/\s+/g, '-');

  // ---------------------------------------------------------------- subcategory selects
  function subsFor(category) { return (Core.subcats()[category] || []).slice().sort((a, b) => a.localeCompare(b)); }
  function fillSub(sel, category, selected, withAdd) {
    const list = subsFor(category);
    sel.innerHTML = '<option value="">Subcategory…</option>' + list.map((s) => '<option value="' + esc(s) + '">' + esc(s) + '</option>').join('') +
      (withAdd ? '<option value="' + ADD_NEW + '">+ Add New</option>' : '');
    if (selected && list.indexOf(selected) < 0 && selected !== ADD_NEW) sel.insertAdjacentHTML('afterbegin', '<option value="' + esc(selected) + '">' + esc(selected) + '</option>');
    sel.value = selected || '';
    if (sel.value !== (selected || '')) sel.value = '';
  }
  async function askNewSub(category) {
    const name = (window.prompt('New subcategory under ' + category + ':') || '').trim();
    if (!name) return '';
    const r = await submit({ type: 'subcat', uuid: Core.uuid(), category, subcategory: name }, name);
    if (!r.ok) { alert(r.error); return ''; }
    return r.subcategory || name;
  }
  function refreshAddSub() {
    const cat = $('new-category').value, sel = $('new-subcategory'), keep = sel.value;
    fillSub(sel, cat, keep === ADD_NEW ? '' : keep, true);
  }
  on('new-category', 'change', refreshAddSub);
  on('new-subcategory', 'change', async (e) => {
    if (e.target.value !== ADD_NEW) return;
    const cat = $('new-category').value;
    const made = await askNewSub(cat);
    fillSub(e.target, cat, made, true);
  });
  // Name-prefix auto-detect while typing (client side only).
  on('new-name', 'input', (e) => {
    const hit = PR.detectFromName(e.target.value);
    if (!hit) return;
    $('new-category').value = hit.category;
    fillSub($('new-subcategory'), hit.category, hit.subcategory, true);
  });

  // ---------------------------------------------------------------- add (create, then decide)
  async function addWith(decision) {
    const name = $('new-name').value.trim(), category = $('new-category').value, sub = $('new-subcategory').value;
    if (!name) { alert('Enter the data first.'); $('new-name').focus(); return; }
    if (!sub || sub === ADD_NEW) { alert('Choose a subcategory.'); return; }
    const uuid = Core.uuid();
    const a = await submit({ type: 'add', uuid, name, category, subcategory: sub }, name);
    if (!a.ok) { alert(a.error || 'Could not add.'); return; }
    const d = await submit({ type: 'decision', uuid, decision, from: 'pending' }, name);
    if (!d.ok) { alert(d.error || 'Could not save the decision.'); render(); return; }
    $('new-name').value = '';
    render();
    $('new-name').focus();
  }
  on('add-approved-btn', 'click', () => addWith('approved'));
  on('add-disapproved-btn', 'click', () => addWith('disapproved'));
  on('new-name', 'keydown', (e) => { if (e.key === 'Enter') addWith('approved'); });

  // ---------------------------------------------------------------- filters
  function fillFilters() {
    const dsel = $('decided-by-filter'), cur = dsel.value;
    const people = new Map();
    entries().forEach((e) => { if (e.decidedBy) people.set(e.decidedBy, e.decidedByName || e.decidedBy); });
    dsel.innerHTML = '<option value="">Anyone</option>' + Array.from(people.entries()).sort((a, b) => a[1].localeCompare(b[1])).map(([k, v]) => '<option value="' + esc(k) + '">' + esc(v) + '</option>').join('');
    dsel.value = cur; if (dsel.value !== cur) dsel.value = '';
    const cat = $('category-filter').value, ssel = $('subcategory-filter'), sc = ssel.value;
    let subs;
    if (cat) subs = subsFor(cat);
    else { const all = new Set(); PR.TOP_LEVEL.forEach((c) => subsFor(c).forEach((s) => all.add(s))); subs = Array.from(all).sort((a, b) => a.localeCompare(b)); }
    ssel.innerHTML = '<option value="">All</option>' + subs.map((s) => '<option value="' + esc(s) + '">' + esc(s) + '</option>').join('');
    ssel.value = sc; if (ssel.value !== sc) ssel.value = '';
  }
  ['decided-by-filter', 'category-filter', 'subcategory-filter', 'date-filter-from', 'date-filter-to'].forEach((id) => on(id, 'change', () => {
    if (id === 'category-filter') $('subcategory-filter').value = '';
    render();
  }));
  on('search-input', 'input', render);
  document.querySelectorAll('#approval-panel .filter-btn').forEach((b) => b.addEventListener('click', () => {
    statusFilter = b.getAttribute('data-filter');
    document.querySelectorAll('#approval-panel .filter-btn').forEach((x) => x.classList.toggle('active', x === b));
    render();
  }));
  document.querySelectorAll('#approval-panel .scope-btn').forEach((b) => b.addEventListener('click', () => {
    scope = b.getAttribute('data-scope'); revealAll = false;
    document.querySelectorAll('#approval-panel .scope-btn').forEach((x) => x.classList.toggle('active', x === b));
    render();
  }));
  on('reveal-all-btn', 'click', () => { revealAll = true; render(); });
  on('clear-filters-btn', 'click', () => {
    ['search-input', 'decided-by-filter', 'category-filter', 'subcategory-filter', 'date-filter-from', 'date-filter-to'].forEach((id) => { $(id).value = ''; });
    statusFilter = 'all';
    document.querySelectorAll('#approval-panel .filter-btn').forEach((x) => x.classList.toggle('active', x.getAttribute('data-filter') === 'all'));
    render();
  });

  function filtered() {
    const text = ($('search-input').value || '').trim().toLowerCase();
    const by = $('decided-by-filter').value, cat = $('category-filter').value, sub = $('subcategory-filter').value;
    const from = $('date-filter-from').value, to = $('date-filter-to').value, today = Core.todayStr();
    let list = entries().filter((e) => {
      if (statusFilter !== 'all' && e.status !== statusFilter) return false;
      if (by && e.decidedBy !== by) return false;
      if (cat && e.category !== cat) return false;
      if (sub && e.subcategory !== sub) return false;
      if (text && !(e.name || '').toLowerCase().includes(text)) return false;
      if (from || to) { const d = decidedDate(e); if (!d || (from && d < from) || (to && d > to)) return false; }
      return true;
    });
    // "Today" = entries added today, unless a date range or a search is in use.
    if (scope === 'today' && !from && !to && !text) list = list.filter((e) => createdDate(e) === today || decidedDate(e) === today);
    list.sort((a, b) => String(b.decidedAt || b.createdAt || '').localeCompare(String(a.decidedAt || a.createdAt || '')));
    return list;
  }

  // ---------------------------------------------------------------- table
  function render() {
    if (!me()) return;
    if (document.activeElement !== $('new-subcategory')) refreshAddSub();
    fillFilters();
    const list = filtered();
    const hasRange = $('date-filter-from').value || $('date-filter-to').value || ($('search-input').value || '').trim();
    $('scope-hint').textContent = scope === 'today' && !hasRange ? 'Showing entries added today' : (scope === 'today' ? 'Date range / search applies to all data' : 'Showing all data');
    const gate = scope === 'all' && !revealAll && !hasRange && list.length > 0;
    const body = $('sheet-body');
    $('displayed-total').textContent = list.length + ' shown';
    const by = {}, st = {};
    list.forEach((e) => { by[e.category] = (by[e.category] || 0) + 1; st[e.status] = (st[e.status] || 0) + 1; });
    const cls = { 'Professionals': 'bd-professionals', 'Applications': 'bd-applications', 'Electrical Applications': 'bd-electrical', 'Signboard Applications': 'bd-signboard' };
    const parts = Object.keys(by).map((k) => '<span class="' + (cls[k] || '') + '">' + esc(k) + ': ' + by[k] + '</span>')
      .concat(['approved', 'disapproved', 'pending'].filter((k) => st[k]).map((k) => '<span class="bd-' + k + '">' + k[0].toUpperCase() + k.slice(1) + ': ' + st[k] + '</span>'));
    $('displayed-breakdown').innerHTML = parts.join(' <span class="bd-sep">·</span> ');
    $('empty-state').classList.toggle('hidden', list.length > 0);
    $('all-data-gate').classList.toggle('hidden', !gate);
    if (gate) $('all-data-gate-text').textContent = list.length + ' entr' + (list.length === 1 ? 'y' : 'ies') + ' in all data. Showing them all can be slow on a big list.';
    if (gate) { body.innerHTML = ''; } else body.innerHTML = list.map(rowHtml).join('');
    renderStats();
    fillEditSelects();
  }

  function rowHtml(e) {
    const mine = isMine(e), queued = Core.isQueued(e.uuid);
    const tag = queued ? ' <span class="qr-pending-tag" title="Saved on this device, waiting to reach the server">⏳</span>' : '';
    const idc = e.id || '…';
    if (e.status === 'pending' && mine) {
      // Pending = being edited (only its owner can see it): change the fields, then decide.
      return `<tr data-uuid="${esc(e.uuid)}" class="pc-edit-row">
        <td class="col-id">${idc}</td>
        <td class="col-name"><input class="edit-name-input" data-f="name" value="${esc(e.name)}" /></td>
        <td class="col-category">
          <select data-f="category">${PR.TOP_LEVEL.map((c) => '<option' + (c === e.category ? ' selected' : '') + '>' + esc(c) + '</option>').join('')}</select>
          <select data-f="sub"></select></td>
        <td class="col-status"><span class="badge pending">Pending</span>${tag}</td>
        <td class="col-by">—</td>
        <td class="col-date">${esc(createdDate(e))}</td>
        <td class="col-remarks">${remarksCell(e)}</td>
        <td class="col-actions"><div class="actions">
          <button class="approve" data-act="approve">✔ Approved</button>
          <button class="disapprove" data-act="disapprove">✘ Disapproved</button>
          <button class="delete" data-act="delete">🗑</button></div></td></tr>`;
    }
    const when = e.decidedAt ? Core.localDateOf(e.decidedAt) + ' ' + hhmm(e.decidedAt) : createdDate(e);
    return `<tr data-uuid="${esc(e.uuid)}">
      <td class="col-id">${idc}</td>
      <td class="col-name">${esc(e.name)}${tag}</td>
      <td class="col-category"><span class="badge ${catClass(e.category)}">${esc(e.category || '—')}</span><div class="pc-sub">${esc(e.subcategory || '')}</div></td>
      <td class="col-status"><span class="badge ${esc(e.status)}">${e.status === 'approved' ? 'Approved' : e.status === 'disapproved' ? 'Disapproved' : 'Pending'}</span></td>
      <td class="col-by">${esc(e.decidedByName || e.decidedBy || '—')}</td>
      <td class="col-date">${esc(when)}</td>
      <td class="col-remarks">${remarksCell(e)}</td>
      <td class="col-actions">${mine ? '<div class="actions"><button data-act="edit">✎ Edit</button><button class="delete" data-act="delete">🗑</button></div>' : ''}</td></tr>`;
  }
  function remarksCell(e) {
    if (!isMine(e) || e.remarksLocked) return '<div class="remarks-cell locked" title="Remarks are private to the person who added this entry">🔒</div>';
    return e.remarks
      ? '<div class="remarks-cell" data-act="remarks">' + esc(e.remarks) + '</div>'
      : '<div class="remarks-cell placeholder" data-act="remarks">+ add remarks</div>';
  }

  // Sub-selects of the edit rows need their options after the rows are in the page.
  function fillEditSelects() {
    document.querySelectorAll('#sheet-body tr.pc-edit-row').forEach((tr) => {
      const e = entries().find((x) => x.uuid === tr.getAttribute('data-uuid')); if (!e) return;
      fillSub(tr.querySelector('[data-f="sub"]'), tr.querySelector('[data-f="category"]').value, e.subcategory, true);
    });
  }

  on('sheet-body', 'change', async (ev) => {
    const el = ev.target, tr = el.closest('tr'); if (!tr) return;
    const f = el.getAttribute('data-f');
    if (f === 'category') fillSub(tr.querySelector('[data-f="sub"]'), el.value, '', true);
    if (f === 'sub' && el.value === ADD_NEW) {
      const made = await askNewSub(tr.querySelector('[data-f="category"]').value);
      fillSub(el, tr.querySelector('[data-f="category"]').value, made, true);
    }
  });
  on('sheet-body', 'click', async (ev) => {
    const el = ev.target.closest('[data-act]'); if (!el) return;
    const tr = el.closest('tr'), uuid = tr.getAttribute('data-uuid'), act = el.getAttribute('data-act');
    const e = entries().find((x) => x.uuid === uuid); if (!e) return;
    if (act === 'remarks') return editRemarks(el, e);
    if (act === 'delete') {
      if (!confirm('Delete this entry?')) return;
      const r = await submit({ type: 'delete', uuid }, e.name);
      if (!r.ok) alert(r.error); return render();
    }
    if (act === 'edit') {
      // Sending it back to pending (owner only) opens it for editing.
      const r = await submit({ type: 'decision', uuid, decision: 'pending', from: e.status }, e.name);
      if (!r.ok) alert(r.error); return render();
    }
    if (act === 'approve' || act === 'disapprove') {
      const name = tr.querySelector('[data-f="name"]').value.trim(), category = tr.querySelector('[data-f="category"]').value, sub = tr.querySelector('[data-f="sub"]').value;
      if (!name) return alert('Data is required.');
      if (!sub || sub === ADD_NEW) return alert('Choose a subcategory.');
      if (name !== e.name || category !== e.category || sub !== e.subcategory) {
        const r1 = await submit({ type: 'edit', uuid, name, category, subcategory: sub }, name);
        if (!r1.ok) return alert(r1.error);
      }
      const r2 = await submit({ type: 'decision', uuid, decision: act === 'approve' ? 'approved' : 'disapproved', from: 'pending' }, name);
      if (!r2.ok) alert(r2.error);
      render();
    }
  });
  function editRemarks(cell, e) {
    if (cell.querySelector('input')) return;
    cell.classList.remove('placeholder'); cell.innerHTML = '';
    const input = document.createElement('input');
    input.type = 'text'; input.value = e.remarks || ''; input.maxLength = 2000; input.placeholder = 'Private remarks';
    cell.appendChild(input); input.focus();
    let done = false;
    const save = async () => {
      if (done) return; done = true;
      if (input.value !== (e.remarks || '')) {
        const r = await submit({ type: 'remarks', uuid: e.uuid, remarks: input.value }, e.name);
        if (!r.ok) alert(r.error);
      }
      render();
    };
    input.addEventListener('blur', save);
    input.addEventListener('keydown', (k) => { if (k.key === 'Enter') input.blur(); if (k.key === 'Escape') { done = true; render(); } });
  }

  // ---------------------------------------------------------------- Reviewer Totals (worked out on this device from the last sync)
  function weekStart(d) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); const wd = (x.getDay() + 6) % 7; x.setDate(x.getDate() - wd); return x; }
  const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  function renderStats() {
    const now = new Date(), today = ymd(now), wk = ymd(weekStart(now)), mo = today.slice(0, 8) + '01';
    const per = new Map();
    entries().forEach((e) => {
      if (!e.decidedBy || !e.decidedAt) return;
      const d = decidedDate(e); if (!d) return;
      const k = e.decidedBy, row = per.get(k) || { name: e.decidedByName || k, primary: 0, week: 0, month: 0 };
      if (d === today) row.primary++;
      if (d >= wk && d <= today) row.week++;
      if (d >= mo && d <= today) row.month++;
      per.set(k, row);
    });
    const rows = Array.from(per.values()).sort((a, b) => (b[statsSort] - a[statsSort]) || a.name.localeCompare(b.name));
    $('stats-heading').innerHTML = 'Reviewer Totals <small class="stats-asof">' + (Core.online() ? '' : 'as of last sync') + '</small>';
    document.querySelectorAll('.stats-sortable').forEach((th) => th.classList.toggle('sorted', th.getAttribute('data-sort-col') === statsSort));
    $('stats-empty').classList.toggle('hidden', rows.length > 0);
    const cell = (n) => '<td class="stats-count' + (n ? '' : ' zero') + '">' + n + '</td>';
    const tot = { primary: 0, week: 0, month: 0 };
    rows.forEach((r) => { tot.primary += r.primary; tot.week += r.week; tot.month += r.month; });
    $('stats-body').innerHTML = rows.map((r) => '<tr><td class="stats-name">' + esc(r.name) + '</td>' + cell(r.primary) + cell(r.week) + cell(r.month) + '</tr>').join('') +
      (rows.length ? '<tr class="stats-total-row"><td class="stats-name">Total</td>' + cell(tot.primary) + cell(tot.week) + cell(tot.month) + '</tr>' : '');
  }
  document.querySelectorAll('.stats-sortable').forEach((th) => th.addEventListener('click', () => { statsSort = th.getAttribute('data-sort-col'); renderStats(); }));

  Core.register({
    id: 'pc', panel: 'approval-panel',
    onShow() { render(); },
    onHide() {},
    onLogout() { revealAll = false; scope = 'today'; },
    onData() { const p = $('approval-panel'); if (p && !p.classList.contains('hidden')) render(); },
    describe(o) {
      const t = o.op.type, what = o.label || '';
      return 'Manual Prechecking: ' + ({ add: 'Add ', decision: 'Decision (' + o.op.decision + ') ', edit: 'Edit ', remarks: 'Remarks on ', 'delete': 'Delete ', subcat: 'New subcategory ' }[t] || t + ' ') + what;
    },
    issueFor() { return null; }
  });
})();
