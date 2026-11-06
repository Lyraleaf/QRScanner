/* Transmittal QR — business rules, shared by the page, the Apps Script server and the tests.
 * Copied as-is to apps-script/TqrRules.gs.
 *
 * Steps: pending (For Transmittal) -> legal (Transmitted to Legal) -> returned -> printed (Transmitted / All Data).
 * A record moves one step forward, or back to any earlier step.
 * Offline conflicts: the FIRST change to reach the server wins. Every move/scan op carries
 * `from` (the step the person's screen showed); if the server record is somewhere else, the op is
 * refused with TAKEN and the person is told in "Sync issues".
 *
 * Store adapter: find(uuid) · findByKey(dataKey) · insert(rec) · edit(rec) · save(rec) · remove(rec)
 */
var TqrRules = (function () {
  'use strict';

  var MAX_DATA = 1000, MAX_NAME = 200;
  var STAGES = ['pending', 'legal', 'returned', 'printed'];
  var STAGE_LABEL = { pending: 'For Transmittal', legal: 'Transmitted to Legal', returned: 'Returned', printed: 'Transmitted / All Data' };

  var RULES_DISPLAY_ORDER = [
    { code: 'bpa', label: 'Building Permit' },
    { code: 'occ', label: 'Occupancy Permit' },
    { code: 'tel', label: 'Telco Permit' },
    { code: 'cacc', label: 'Certificate of Use - Accelerograph' },
    { code: 'acc', label: 'Accelerograph Permit' },
    { code: 'cel', label: 'Certificate of Use - Electronics' },
    { code: 'el', label: 'Electronics Permit' },
    { code: 'dp', label: 'Demolition Permit' },
    { code: 'rp', label: 'Repair Permit' },
    { code: 'fp', label: 'Fencing Permit' },
    { code: 'swp', label: 'Sidewalk Permit' },
    { code: 'exg', label: 'Groundprep' }
  ];
  var PREFIX_RULES = RULES_DISPLAY_ORDER.slice().sort(function (a, b) { return b.code.length - a.code.length; });

  function detectCategory(data) {
    var v = String(data || '').trim().toLowerCase();
    if (!v) return null;
    for (var i = 0; i < PREFIX_RULES.length; i++) if (v.indexOf(PREFIX_RULES[i].code) === 0) return PREFIX_RULES[i].label;
    return null;
  }

  function stamp(rec, stage, stp, actor, actorName) {
    rec[stage + 'Date'] = stp.date; rec[stage + 'Time'] = stp.time; rec[stage + 'Timestamp'] = stp.ts;
    rec[stage + 'By'] = actor; rec[stage + 'ByName'] = actorName;
    rec.stageAt = stp.ts;
  }
  function unstamp(rec, stage) {
    ['Date', 'Time', 'Timestamp', 'By', 'ByName'].forEach(function (k) { rec[stage + k] = null; });
  }
  function move(rec, target, stp, actor, actorName) {
    var to = STAGES.indexOf(target), from = STAGES.indexOf(rec.status);
    for (var i = Math.max(to + 1, 1); i < STAGES.length; i++) unstamp(rec, STAGES[i]);
    rec.status = target;
    if (to > from) stamp(rec, target, stp, actor, actorName); else rec.stageAt = stp.ts;
  }

  function ok(entry, extra) { var r = { ok: true, entry: entry || null }; if (extra) for (var k in extra) r[k] = extra[k]; return r; }
  function fail(code, error, extra) { var r = { ok: false, code: code, error: error }; if (extra) for (var k in extra) r[k] = extra[k]; return r; }

  function newRecord(op, data, actor, actorName) {
    return {
      id: null, uuid: op.uuid, data: data, name: '', category: detectCategory(data),
      source: op.source === 'manual' ? 'manual' : 'camera', status: 'pending',
      scannedBy: actor, scannedByName: actorName,
      date: op.stamp.date, time: op.stamp.time, timestamp: op.stamp.ts, stageAt: op.stamp.ts,
      legalDate: null, legalTime: null, legalTimestamp: null, legalBy: null, legalByName: null,
      returnedDate: null, returnedTime: null, returnedTimestamp: null, returnedBy: null, returnedByName: null,
      printedDate: null, printedTime: null, printedTimestamp: null, printedBy: null, printedByName: null,
      deleted: '', note: ''
    };
  }

  function movedMsg(rec) { return 'Someone already moved this record — it is now in "' + (STAGE_LABEL[rec.status] || rec.status) + '".'; }

  // Same value = ignoring capitals, leading/trailing spaces and repeated spaces.
  function dataKey(d) { return String(d == null ? '' : d).trim().replace(/\s+/g, ' ').toLowerCase(); }

  // op.type 'scan': a camera/manual entry of `data`. It only ever ADDS a new record; data that
  // already exists in any step is reported as a duplicate. Moving a record is a separate 'move' op.
  function opScan(op, st, actor, actorName) {
    var data = String(op.data == null ? '' : op.data).trim().slice(0, MAX_DATA);
    if (!data) return fail('EMPTY', 'No data provided.');
    if (!op.uuid) return fail('INVALID', 'Missing record id.');
    var again = st.findAny ? st.findAny(op.uuid) : st.find(op.uuid);
    if (again) return ok(again.deleted ? null : again, { noop: true });
    var existing = st.findByKey(dataKey(data));
    if (existing) return ok(existing, { duplicate: true });
    var rec = newRecord(op, data, actor, actorName);
    st.insert(rec);
    return ok(rec);
  }

  function opMove(op, st, actor, actorName) {
    var rec = st.find(op.uuid);
    if (!rec) return fail('GONE', 'That record no longer exists.');
    var to = STAGES.indexOf(op.to);
    if (to < 0) return fail('INVALID', 'Invalid status.');
    if (op.from && op.from !== rec.status) {
      // Already exactly where this person wanted it? Then nothing to do.
      if (rec.status === op.to) return ok(rec, { noop: true });
      return fail('TAKEN', movedMsg(rec), { entry: rec });
    }
    var cur = STAGES.indexOf(rec.status);
    if (to === cur) return ok(rec, { noop: true });
    if (to > cur + 1) return fail('INVALID', 'A record moves one step at a time.');
    var r = st.edit(rec);
    move(r, op.to, op.stamp, actor, actorName);
    st.save(r);
    return ok(r, { direction: to > cur ? 'forward' : 'back' });
  }

  function opRename(op, st) {
    var rec = st.find(op.uuid);
    if (!rec) return fail('GONE', 'That record no longer exists.');
    var name = String(op.name == null ? '' : op.name).trim().slice(0, MAX_NAME);
    if (rec.name === name) return ok(rec, { noop: true });
    var r = st.edit(rec); r.name = name; st.save(r);
    return ok(r);
  }

  function opDelete(op, st) {
    var rec = st.find(op.uuid);
    if (!rec) return ok(null, { noop: true });
    st.remove(rec, 'deleted');
    return ok(null);
  }

  function applyOp(op, st, actor, actorName) {
    if (!op || !op.type) return fail('INVALID', 'Bad request.');
    if (!op.stamp || !op.stamp.ts || !op.stamp.date || !op.stamp.time) return fail('INVALID', 'Missing time stamp.');
    switch (op.type) {
      case 'scan': return opScan(op, st, actor, actorName);
      case 'move': return opMove(op, st, actor, actorName);
      case 'rename': return opRename(op, st);
      case 'delete': return opDelete(op, st);
    }
    return fail('INVALID', 'Unknown request.');
  }

  return {
    STAGES: STAGES, STAGE_LABEL: STAGE_LABEL, DUE_MINUTES: 10, dataKey: dataKey,
    RULES_DISPLAY_ORDER: RULES_DISPLAY_ORDER, detectCategory: detectCategory, applyOp: applyOp
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TqrRules;
