/* Manual Prechecking — business rules, shared by the page, the Apps Script server and the tests.
 * Copied as-is to apps-script/PcRules.gs.
 *
 * Visibility: pending rows are seen only by whoever added them; remarks only by the owner.
 * Approve / disapprove: any signed-in person; the FIRST decision to reach the server wins
 * (op.from = status the person's screen showed; mismatch -> TAKEN).
 * Back to pending (Edit), edit, remarks, delete: only the person who added the row.
 *
 * Store adapter: find(uuid) · insert(rec) · edit(rec) · save(rec) · remove(rec) ·
 *                subcats() -> {Category:[names]} · addSubcat(category, name)
 */
var PcRules = (function () {
  'use strict';

  var TOP_LEVEL = ['Professionals', 'Applications', 'Electrical Applications', 'Signboard Applications'];
  var DEFAULT_SUBCATEGORIES = {
    'Professionals': ['Architect', 'Civil', 'Electrical', 'Master Electrician', 'Professional Electrical', 'Mechanical', 'Professional Mechanical', 'Electronics', 'Sanitary', 'Master Plumber', 'Geodetic'],
    'Applications': ['Building Permit', 'Occupancy Permit', 'Telco Permit', 'Demolition Permit', 'Electronics Permit', 'Certificate of Use - Electronics', 'Repair Permit', 'Fencing Permit', 'Sidewalk Permit', 'Groundprep', 'Accelerograph Permit', 'Certificate of Use - Accelerograph'],
    'Electrical Applications': ['Electrical'],
    'Signboard Applications': ['Signboard']
  };
  // Name prefix -> Applications subcategory (longest code first).
  var NAME_PREFIX_RULES = [
    ['cacc', 'Certificate of Use - Accelerograph'], ['bpa', 'Building Permit'], ['occ', 'Occupancy Permit'],
    ['tel', 'Telco Permit'], ['cel', 'Certificate of Use - Electronics'], ['acc', 'Accelerograph Permit'],
    ['swp', 'Sidewalk Permit'], ['exg', 'Groundprep'], ['el', 'Electronics Permit'], ['dp', 'Demolition Permit'],
    ['rp', 'Repair Permit'], ['fp', 'Fencing Permit']
  ];
  // Returns {category, subcategory} or null. EAO / SP anywhere in the name win.
  function detectFromName(name) {
    var v = String(name || '').trim().toLowerCase();
    if (!v) return null;
    if (v.indexOf('eao') !== -1) return { category: 'Electrical Applications', subcategory: 'Electrical' };
    if (v.indexOf('sp') !== -1) return { category: 'Signboard Applications', subcategory: 'Signboard' };
    for (var i = 0; i < NAME_PREFIX_RULES.length; i++) {
      if (v.indexOf(NAME_PREFIX_RULES[i][0]) === 0) return { category: 'Applications', subcategory: NAME_PREFIX_RULES[i][1] };
    }
    return null;
  }

  function isVisibleTo(rec, me) { return !rec.deleted && (rec.status !== 'pending' || rec.addedBy === me); }
  // What a given viewer is allowed to see of a record.
  function shape(rec, me) {
    var own = rec.addedBy === me, o = {};
    for (var k in rec) o[k] = rec[k];
    o.remarks = own ? (rec.remarks || '') : null;
    o.remarksLocked = !own;
    return o;
  }

  function ok(entry, extra) { var r = { ok: true, entry: entry || null }; if (extra) for (var k in extra) r[k] = extra[k]; return r; }
  function fail(code, error, extra) { var r = { ok: false, code: code, error: error }; if (extra) for (var k in extra) r[k] = extra[k]; return r; }
  function ownerOnly(rec, actor, what) { return rec.addedBy === actor ? '' : 'Only the person who added this entry can ' + what + '.'; }

  function opAdd(op, st, actor, actorName) {
    var name = String(op.name == null ? '' : op.name).trim().slice(0, 200);
    var subcategory = String(op.subcategory == null ? '' : op.subcategory).trim().slice(0, 100);
    var category = String(op.category == null ? '' : op.category).trim();
    if (!name) return fail('EMPTY', 'Name is required.');
    if (!subcategory) return fail('EMPTY', 'Subcategory is required.');
    if (!op.uuid) return fail('INVALID', 'Missing record id.');
    var again = st.findAny ? st.findAny(op.uuid) : st.find(op.uuid);
    if (again) return ok(again.deleted ? null : again, { noop: true });
    var rec = {
      id: null, uuid: op.uuid, name: name, category: category || null, subcategory: subcategory || null,
      status: 'pending', addedBy: actor, addedByName: actorName,
      decidedBy: null, decidedByName: null, decidedAt: null,
      createdAt: op.stamp.ts, updatedAt: op.stamp.ts, remarks: '', deleted: '', note: ''
    };
    st.insert(rec);
    return ok(rec);
  }

  function opDecision(op, st, actor, actorName) {
    var rec = st.find(op.uuid);
    if (!rec) return fail('GONE', 'That entry no longer exists (its owner deleted it).');
    var d = op.decision;
    if (['approved', 'disapproved', 'pending'].indexOf(d) < 0) return fail('INVALID', 'Invalid decision.');
    if (d === 'pending') {
      var m = ownerOnly(rec, actor, 'edit it');
      if (m) return fail('FORBIDDEN', m);
    }
    if (rec.status === d) return ok(rec, { noop: true });
    if (op.from && op.from !== rec.status) {
      var who = rec.decidedByName || 'someone else';
      return fail('TAKEN', rec.status === 'pending'
        ? 'This entry was sent back to pending by its owner.'
        : 'Already ' + rec.status + ' by ' + who + ' (their decision came first).', { entry: rec });
    }
    var r = st.edit(rec);
    r.status = d;
    r.decidedBy = d === 'pending' ? null : actor;
    r.decidedByName = d === 'pending' ? null : actorName;
    r.decidedAt = d === 'pending' ? null : op.stamp.ts;
    r.updatedAt = op.stamp.ts;
    st.save(r);
    return ok(r);
  }

  function opEdit(op, st, actor) {
    var rec = st.find(op.uuid);
    if (!rec) return fail('GONE', 'That entry no longer exists.');
    var m = ownerOnly(rec, actor, 'edit it');
    if (m) return fail('FORBIDDEN', m);
    var name = String(op.name == null ? '' : op.name).trim().slice(0, 200);
    if (!name) return fail('EMPTY', 'Name is required.');
    var r = st.edit(rec);
    r.name = name;
    if (op.category !== undefined) r.category = op.category || null;
    if (op.subcategory !== undefined) r.subcategory = String(op.subcategory || '').trim().slice(0, 100) || null;
    r.updatedAt = op.stamp.ts;
    st.save(r);
    return ok(r);
  }

  function opRemarks(op, st, actor) {
    var rec = st.find(op.uuid);
    if (!rec) return fail('GONE', 'That entry no longer exists.');
    var m = ownerOnly(rec, actor, 'edit its remarks');
    if (m) return fail('FORBIDDEN', m);
    var r = st.edit(rec);
    r.remarks = String(op.remarks == null ? '' : op.remarks).slice(0, 2000);
    r.updatedAt = op.stamp.ts;
    st.save(r);
    return ok(r);
  }

  function opDelete(op, st, actor) {
    var rec = st.find(op.uuid);
    if (!rec) return ok(null, { noop: true });
    var m = ownerOnly(rec, actor, 'delete it');
    if (m) return fail('FORBIDDEN', m);
    st.remove(rec, 'deleted by its owner');
    return ok(null);
  }

  function opSubcat(op, st) {
    var category = op.category;
    var sub = String(op.subcategory == null ? '' : op.subcategory).trim().slice(0, 100);
    if (TOP_LEVEL.indexOf(category) < 0) return fail('INVALID', 'Invalid category.');
    if (!sub) return fail('EMPTY', 'Subcategory name is required.');
    var list = st.subcats()[category] || [];
    var exists = list.some(function (s) { return s.toLowerCase() === sub.toLowerCase(); });
    if (!exists) st.addSubcat(category, sub);
    return ok(null, { subcategory: sub, added: !exists });
  }

  function applyOp(op, st, actor, actorName) {
    if (!op || !op.type) return fail('INVALID', 'Bad request.');
    if (!op.stamp || !op.stamp.ts || !op.stamp.date || !op.stamp.time) return fail('INVALID', 'Missing time stamp.');
    switch (op.type) {
      case 'add': return opAdd(op, st, actor, actorName);
      case 'decision': return opDecision(op, st, actor, actorName);
      case 'edit': return opEdit(op, st, actor);
      case 'remarks': return opRemarks(op, st, actor);
      case 'delete': return opDelete(op, st, actor);
      case 'subcat': return opSubcat(op, st);
    }
    return fail('INVALID', 'Unknown request.');
  }

  return {
    TOP_LEVEL: TOP_LEVEL, DEFAULT_SUBCATEGORIES: DEFAULT_SUBCATEGORIES, detectFromName: detectFromName,
    isVisibleTo: isVisibleTo, shape: shape, applyOp: applyOp
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PcRules;
