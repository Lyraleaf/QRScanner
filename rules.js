/* QR Scan Logger — business rules, shared by the page, the Apps Script server and the tests.
 *
 * ONE source of truth: this file is copied as-is to apps-script/Rules.gs.
 * Every change a person makes (add / rename / delete / status) is an "op" that goes
 * through applyOp() — on the device first (optimistic) and again on the server (final say).
 *
 * `st` is a small store adapter supplied by the caller:
 *   find(uuid) · findByData(data) · insert(rec) · replace(old, new, note) · remove(rec, note)
 *   edit(rec) -> the object to mutate · save(rec)
 */
var QRRules = (function () {
  'use strict';

  var MAX_DATA = 1000;
  var MAX_NAME = 200;
  // Allowed moves. Everything else is refused.
  var TRANSITIONS = {
    pending: ['approved', 'disapproved'],
    approved: ['printed', 'pending'],
    disapproved: ['pending'],
    printed: ['approved']
  };

  // EAO anywhere -> electrical; SP anywhere -> signboard (EAO is checked first).
  function detectCategory(data) {
    var up = String(data || '').toUpperCase();
    if (up.indexOf('EAO') !== -1) return 'electrical';
    if (up.indexOf('SP') !== -1) return 'signboard';
    return null;
  }

  // Pending + printed: everyone. Approved / disapproved: only the person who decided
  // (old records with no decider fall back to the scanner).
  function isVisibleTo(rec, me) {
    if (rec.deleted) return false;
    if (rec.status === 'pending' || rec.status === 'printed') return true;
    var owner = rec.status === 'approved'
      ? (rec.approvedBy || rec.scannedBy)
      : (rec.disapprovedBy || rec.scannedBy);
    return !owner || owner === me;
  }

  function ownsScan(rec, actor) { return !rec.scannedBy || rec.scannedBy === actor; }

  function decisionOf(rec) {
    if (rec.status === 'approved') {
      return { by: rec.approvedBy || rec.scannedBy || '', byName: rec.approvedByName || rec.approvedBy || '', ts: rec.approvedTimestamp || '' };
    }
    if (rec.status === 'disapproved') {
      return { by: rec.disapprovedBy || rec.scannedBy || '', byName: rec.disapprovedByName || rec.disapprovedBy || '', ts: rec.disapprovedTimestamp || '' };
    }
    return null;
  }

  // '' when allowed, otherwise the message to show.
  function statusPermission(rec, to, actor) {
    var isScanner = ownsScan(rec, actor);
    var approverOwner = rec.approvedBy || rec.scannedBy;
    var disapproverOwner = rec.disapprovedBy || rec.scannedBy;
    var isApprover = !approverOwner || approverOwner === actor;
    var isDisapprover = !disapproverOwner || disapproverOwner === actor;
    var allowed;
    if (rec.status === 'pending') allowed = to === 'approved' || to === 'disapproved' || isScanner;
    else if (rec.status === 'approved' || rec.status === 'printed') allowed = isApprover;
    else allowed = isDisapprover;
    if (allowed) return '';
    return rec.status === 'pending'
      ? 'You can only change records you scanned.'
      : 'Only the person who ' + (rec.status === 'disapproved' ? 'disapproved' : 'approved') + ' this record can do that.';
  }

  function clearDecision(r) {
    r.approvedBy = null; r.approvedByName = null; r.approvedDate = null; r.approvedTime = null; r.approvedTimestamp = null;
    r.disapprovedBy = null; r.disapprovedByName = null; r.disapprovedDate = null; r.disapprovedTime = null; r.disapprovedTimestamp = null;
  }

  function applyStatusFields(r, to, prev, actor, actorName, stamp) {
    r.status = to;
    if (to === 'approved') {
      // Back from All Data keeps the original approver and time.
      if (prev !== 'printed') {
        r.approvedDate = stamp.date; r.approvedTime = stamp.time; r.approvedTimestamp = stamp.ts;
        r.approvedBy = actor; r.approvedByName = actorName;
      }
    } else if (to === 'disapproved') {
      r.disapprovedDate = stamp.date; r.disapprovedTime = stamp.time; r.disapprovedTimestamp = stamp.ts;
      r.disapprovedBy = actor; r.disapprovedByName = actorName;
    } else if (to === 'printed') {
      r.printedDate = stamp.date; r.printedTime = stamp.time; r.printedTimestamp = stamp.ts;
    } else {
      // Back to For Evaluation clears every stamp.
      clearDecision(r);
      r.printedDate = null; r.printedTime = null; r.printedTimestamp = null;
    }
  }

  function ok(entry, extra) {
    var r = { ok: true, entry: entry || null };
    if (extra) for (var k in extra) r[k] = extra[k];
    return r;
  }
  function fail(code, error, extra) {
    var r = { ok: false, code: code, error: error };
    if (extra) for (var k in extra) r[k] = extra[k];
    return r;
  }
  function earlier(a, b) { return String(a) < String(b); }   // ISO timestamps sort as text

  function publicDup(rec) {
    return {
      uuid: rec.uuid, data: rec.data, category: rec.category, source: rec.source,
      date: rec.date, time: rec.time, scannedBy: rec.scannedBy, scannedByName: rec.scannedByName
    };
  }

  function newRecord(op, data, category, actor, actorName) {
    return {
      id: null, uuid: op.uuid, data: data, name: '', category: category,
      source: op.source === 'manual' ? 'manual' : 'camera',
      status: 'pending',
      scannedBy: actor, scannedByName: actorName,
      date: op.stamp.date, time: op.stamp.time, timestamp: op.stamp.ts,
      approvedBy: null, approvedByName: null, approvedDate: null, approvedTime: null, approvedTimestamp: null,
      disapprovedBy: null, disapprovedByName: null, disapprovedDate: null, disapprovedTime: null, disapprovedTimestamp: null,
      printedDate: null, printedTime: null, printedTimestamp: null,
      deleted: '', note: ''
    };
  }

  function opAdd(op, st, actor, actorName) {
    var data = String(op.data == null ? '' : op.data).trim();
    if (!data) return fail('EMPTY', 'No data provided.');
    if (data.length > MAX_DATA) return fail('INVALID', 'That value is too long.');
    if (!op.uuid) return fail('INVALID', 'Missing record id.');

    var again = st.findAny ? st.findAny(op.uuid) : st.find(op.uuid);   // the same op sent twice
    if (again) return ok(again.deleted ? null : again, { noop: true });

    var ex = st.findByData(data);
    if (ex) {
      // Same data scanned on two devices: the earlier scan wins — but only while
      // the other one is still untouched in For Evaluation.
      if (ex.status === 'pending' && ex.scannedBy !== actor && earlier(op.stamp.ts, ex.timestamp)) {
        var cat0 = detectCategory(data);
        if (!cat0) return fail('NOT_RECOGNIZED', 'Not recognized: data must contain EAO (Electrical Applications) or SP (Signboard Applications).');
        var nu = newRecord(op, data, cat0, actor, actorName);
        st.replace(ex, nu, 'replaced by an earlier scan from ' + actorName);
        return ok(nu, { replaced: true });
      }
      return { ok: true, duplicate: true, entry: publicDup(ex) };
    }
    if (st.hiddenDuplicate && st.hiddenDuplicate(data)) {
      return { ok: true, duplicate: true, entry: null, hidden: true };
    }
    var category = detectCategory(data);
    if (!category) {
      return fail('NOT_RECOGNIZED', 'Not recognized: data must contain EAO (Electrical Applications) or SP (Signboard Applications).');
    }
    var rec = newRecord(op, data, category, actor, actorName);
    st.insert(rec);
    return ok(rec);
  }

  function opRename(op, st, actor) {
    var rec = st.find(op.uuid);
    if (!rec) return fail('GONE', 'That record no longer exists.');
    if (!ownsScan(rec, actor)) return fail('FORBIDDEN', 'You can only change records you scanned.');
    if (rec.status !== 'pending') return fail('LOCKED', 'Only records still in For Evaluation can be renamed.');
    var name = String(op.name == null ? '' : op.name).trim().slice(0, MAX_NAME);
    if (rec.name === name) return ok(rec, { noop: true });
    var r = st.edit(rec);
    r.name = name;
    st.save(r);
    return ok(r);
  }

  function opDelete(op, st, actor) {
    var rec = st.find(op.uuid);
    if (!rec) return ok(null, { noop: true });          // already gone
    if (!ownsScan(rec, actor)) return fail('FORBIDDEN', 'You can only change records you scanned.');
    if (rec.status !== 'pending') return fail('LOCKED', 'This record was already evaluated and can no longer be deleted.');
    st.remove(rec, 'deleted by its owner');
    return ok(null);
  }

  function opStatus(op, st, actor, actorName) {
    var rec = st.find(op.uuid);
    if (!rec) return fail('GONE', 'That record no longer exists (its owner deleted it).');
    var to = op.status;
    if (!TRANSITIONS[to]) return fail('INVALID', 'Invalid status.');
    var dec = decisionOf(rec);
    var isDecision = to === 'approved' || to === 'disapproved';

    // Two people decided the same record: the earlier decision wins.
    if (isDecision && dec && dec.by !== actor && dec.ts && earlier(op.stamp.ts, dec.ts)) {
      var o = st.edit(rec);
      clearDecision(o);
      applyStatusFields(o, to, 'pending', actor, actorName, op.stamp);
      st.save(o);
      return ok(o, { overrode: true });
    }

    if (rec.status === to) {                            // already there
      if (to === 'pending') return ok(rec, { noop: true });
      var owner = to === 'disapproved' ? (rec.disapprovedBy || rec.scannedBy) : (rec.approvedBy || rec.scannedBy);
      if (!owner || owner === actor) return ok(rec, { noop: true });
      return fail('TAKEN', 'Already ' + to + ' by ' + (dec ? dec.byName : 'someone else') + ' (their decision came first).');
    }
    // Someone else already decided it (their decision came first): say so plainly.
    if (isDecision && dec && dec.by !== actor) {
      return fail('TAKEN', 'Already ' + rec.status + ' by ' + dec.byName + ' (their decision came first).');
    }
    if (TRANSITIONS[rec.status].indexOf(to) < 0) {
      return fail('INVALID', 'That change is not allowed from "' + rec.status + '".');
    }
    var perm = statusPermission(rec, to, actor);
    if (perm) return fail('FORBIDDEN', perm);
    var r = st.edit(rec);
    applyStatusFields(r, to, r.status, actor, actorName, op.stamp);
    st.save(r);
    return ok(r);
  }

  // op: { type: 'add'|'rename'|'delete'|'status', uuid, ..., stamp: {date,time,ts} }
  function applyOp(op, st, actor, actorName) {
    if (!op || !op.type) return fail('INVALID', 'Bad request.');
    if (!op.stamp || !op.stamp.ts || !op.stamp.date || !op.stamp.time) return fail('INVALID', 'Missing time stamp.');
    switch (op.type) {
      case 'add': return opAdd(op, st, actor, actorName);
      case 'rename': return opRename(op, st, actor);
      case 'delete': return opDelete(op, st, actor);
      case 'status': return opStatus(op, st, actor, actorName);
    }
    return fail('INVALID', 'Unknown request.');
  }

  return {
    detectCategory: detectCategory,
    isVisibleTo: isVisibleTo,
    ownsScan: ownsScan,
    decisionOf: decisionOf,
    applyOp: applyOp,
    TRANSITIONS: TRANSITIONS
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = QRRules;
