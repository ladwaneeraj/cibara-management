/*
 * Guard tests for the business logic ported from Python into JavaScript.
 * ---------------------------------------------------------------------------
 * When settings/ui_config.listener_first is ON, the dashboard is built from the
 * Firestore onSnapshot listeners instead of /get_data. That required porting
 * three pieces of server logic into static/script.js (window.CibaraState):
 *
 *   CibaraState.dedupPayments   <- services/payment_service.py :: _dedup_payments
 *   CibaraState.buildLogs       <- routes/rooms.py            :: get_data (bucketing)
 *   CibaraState.buildUpcoming   <- routes/bookings.py         :: get_upcoming_bookings
 *
 * Two implementations of the same rules will drift. This file is the thing that
 * catches it. If you change any of the three Python functions above, change the
 * JS twin and add a case here in the SAME commit.
 *
 * It reads the real static/script.js rather than a copy, so it can never test a
 * stale duplicate of the code.
 *
 * RUN:  node tests/test_state_ports.js        (from the repo root; no deps)
 * Exits non-zero on failure, so it drops straight into CI.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// ── Load CibaraState out of the real script.js ────────────────────────────
// script.js is a browser classic script, so it cannot simply be require()d.
// Slice out the self-contained CibaraState IIFE and evaluate just that, with
// the handful of globals it closes over stubbed in.
function loadCibaraState() {
  const scriptPath = path.join(__dirname, '..', 'static', 'script.js');
  const src = fs.readFileSync(scriptPath, 'utf8');

  const startMarker = 'window.CibaraState = (function () {';
  const start = src.indexOf(startMarker);
  if (start === -1) {
    throw new Error(
      'Could not find the CibaraState block in static/script.js. If it was ' +
      'renamed or moved, update loadCibaraState() here.',
    );
  }
  // The IIFE ends at the first line that is exactly "})();" at column 0.
  const endMarker = '\n})();';
  const end = src.indexOf(endMarker, start);
  if (end === -1) throw new Error('Could not find the end of the CibaraState block.');
  const block = src.slice(start, end + endMarker.length);

  const sandbox = {
    // The bindings the IIFE's setters assign to.
    rooms: {}, logs: {}, totals: {}, upcomingBookings: {}, dailyCounters: {},
    window: { __initialUIConfig: {} },
    localStorage: { getItem: () => null },
    console,
    setTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // `let` declarations in the sandbox source would shadow the stubs above, so
  // declare them as context properties and run the block as a plain script.
  vm.runInContext(block, sandbox, { filename: 'script.js:CibaraState' });
  return sandbox.window.CibaraState;
}

const S = loadCibaraState();

// ── Tiny test harness ─────────────────────────────────────────────────────
let pass = 0;
const failures = [];
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok   ' + name);
  } catch (e) {
    failures.push(name);
    console.log('  FAIL ' + name + '\n       ' + e.message);
  }
}
function section(title) { console.log('\n' + title); }

// Default payment row. Override only what a case is about.
const P = (o) => Object.assign(
  { room: '1', name: 'G', amount: 100, date: '2026-08-14', time: '10:00',
    type: 'checkin', method: 'cash' }, o);

// ══════════════════════════════════════════════════════════════════════════
section('dedupPayments  <- payment_service._dedup_payments');
// ══════════════════════════════════════════════════════════════════════════

t('live vs live on an identical fingerprint keeps BOTH', () => {
  // Two genuine UPI payments can land in the same HH:MM minute. Collapsing
  // them would hide real money. This is the case the Python docstring calls
  // out by name.
  assert.strictEqual(S.dedupPayments([P({}), P({})]).length, 2);
});

t('migrated + live collapses to the live row', () => {
  const r = S.dedupPayments([P({ migrated: true, tag: 'm' }), P({ tag: 'live' })]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].tag, 'live');
});

t('live + migrated (reverse order) also collapses to the live row', () => {
  const r = S.dedupPayments([P({ tag: 'live' }), P({ migrated: true, tag: 'm' })]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].tag, 'live');
});

t('migrated + migrated keeps the first only', () => {
  const r = S.dedupPayments(
    [P({ migrated: true, tag: 'a' }), P({ migrated: true, tag: 'b' })]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].tag, 'a');
});

t('different fingerprints are never collapsed', () => {
  assert.strictEqual(S.dedupPayments([P({ amount: 100 }), P({ amount: 200 })]).length, 2);
});

t('field boundaries are unambiguous: room "1 2"/name "3" != room "1"/name "2 3"', () => {
  // Python fingerprints with a tuple, so fields cannot bleed into each other.
  // The JS twin must use a separator that cannot occur in the data; a plain
  // space would fingerprint these two identically and wrongly drop one.
  const r = S.dedupPayments([
    P({ room: '1 2', name: '3', migrated: true }),
    P({ room: '1',   name: '2 3' }),
  ]);
  assert.strictEqual(r.length, 2);
});

t('migrated must be strictly true - the string "true" is not a migration flag', () => {
  assert.strictEqual(S.dedupPayments([P({ migrated: 'true' }), P({})]).length, 2);
});

// ══════════════════════════════════════════════════════════════════════════
section('buildLogs  <- routes/rooms.py :: get_data');
// ══════════════════════════════════════════════════════════════════════════

t('cash / pay_later / already_paid all bucket as cash', () => {
  const l = S.buildLogs([
    P({ method: 'cash', amount: 1 }),
    P({ method: 'pay_later', amount: 2 }),
    P({ method: 'already_paid', amount: 3 }),
  ], []);
  assert.strictEqual(l.cash.length, 3);
  assert.strictEqual(l.online.length, 0);
});

t('all four refund types bucket as refunds and stay out of cash', () => {
  const l = S.buildLogs([
    P({ type: 'refund' }), P({ type: 'checkout_refund' }),
    P({ type: 'manual_refund' }), P({ type: 'booking_cancel_refund' }),
  ], []);
  assert.strictEqual(l.refunds.length, 4);
  assert.strictEqual(l.cash.length, 0);
});

t('expense and discount types are hidden from cash and online', () => {
  const l = S.buildLogs([P({ type: 'expense' }), P({ type: 'discount' })], []);
  assert.strictEqual(l.cash.length, 0);
  assert.strictEqual(l.online.length, 0);
});

t('online method buckets as online', () => {
  const l = S.buildLogs([P({ method: 'online' })], []);
  assert.strictEqual(l.online.length, 1);
  assert.strictEqual(l.cash.length, 0);
});

t('a cash settlement appears in settlements AND in cash', () => {
  // Mirrors routes/rooms.py exactly. NOTE: the comment above settlement_logs
  // there says settlements are "kept out of the cash/online/refund buckets so
  // day totals stay correct", but the code applies no such exclusion. Comment
  // and code disagree in the EXISTING backend; this port follows the CODE so
  // listener-first behaves identically to today. If you fix that in Python,
  // fix it here and flip this assertion in the same commit.
  const l = S.buildLogs([P({ type: 'settlement', method: 'cash' })], []);
  assert.strictEqual(l.settlements.length, 1);
  assert.strictEqual(l.cash.length, 1);
});

t('renewals are reshaped and the day number is parsed out of the note', () => {
  const l = S.buildLogs(
    [P({ type: 'renewal', note: 'Rent renewal Day 3 of stay', amount: 900 })], []);
  assert.strictEqual(l.renewals.length, 1);
  assert.strictEqual(l.renewals[0].day, '3');
  assert.strictEqual(l.renewals[0].transaction_type, 'rent_renewal');
  assert.strictEqual(l.renewals[0].amount, 900);
});

t('a renewal note with no "Day N" yields an empty day rather than throwing', () => {
  const l = S.buildLogs([P({ type: 'renewal', note: 'manual renewal' })], []);
  assert.strictEqual(l.renewals[0].day, '');
});

t('expenses pass through and keep _doc_id', () => {
  // _doc_id is what the Transactions tab keys edit / delete / attach-photo off
  // (transaction-tracking.js, expense.js). Losing it silently removes the
  // action buttons from every expense row.
  const l = S.buildLogs([], [{ _doc_id: 'x1', amount: 50 }]);
  assert.strictEqual(l.expenses.length, 1);
  assert.strictEqual(l.expenses[0]._doc_id, 'x1');
});

t('the always-empty buckets the frontend expects are present', () => {
  const l = S.buildLogs([], []);
  for (const k of ['balance', 'add_ons', 'booking_payments', 'discounts', 'room_shifts']) {
    assert.ok(Array.isArray(l[k]), 'missing bucket ' + k);
  }
});

t('null inputs do not throw', () => {
  const l = S.buildLogs(null, null);
  assert.strictEqual(l.cash.length, 0);
  assert.strictEqual(l.expenses.length, 0);
});

// ══════════════════════════════════════════════════════════════════════════
section('buildUpcoming  <- routes/bookings.py :: get_upcoming_bookings');
// ══════════════════════════════════════════════════════════════════════════

const NOW = new Date('2026-08-14T10:00:00');
const B = (id, o) => ({ id, data: Object.assign(
  { room: '205', guest_name: 'A', check_in_date: '2026-08-14',
    check_in_time: '14:00', check_out_date: '2026-08-15', status: 'confirmed',
    paid_amount: 0, total_amount: 1000 }, o) });

t('a booking 4h out is included with the right hours_until', () => {
  const u = S.buildUpcoming([B('b1', {})], NOW);
  assert.strictEqual(u['205'].hours_until, 4);
  assert.strictEqual(u['205'].booking_id, 'b1');
});

t('cancelled and checked_out are excluded, case-insensitively', () => {
  assert.strictEqual(Object.keys(S.buildUpcoming([B('b1', { status: 'cancelled' })], NOW)).length, 0);
  assert.strictEqual(Object.keys(S.buildUpcoming([B('b1', { status: 'CHECKED_OUT' })], NOW)).length, 0);
});

t('beyond +24h is dropped so far-future bookings do not show a dot forever', () => {
  assert.strictEqual(
    Object.keys(S.buildUpcoming([B('b1', { check_in_date: '2026-08-16' })], NOW)).length, 0);
});

t('an overdue arrival within -24h is KEPT (negative hours drive the red dot)', () => {
  const u = S.buildUpcoming(
    [B('b1', { check_in_date: '2026-08-13', check_in_time: '20:00' })], NOW);
  assert.strictEqual(u['205'].hours_until, -14);
});

t('overdue beyond -24h is dropped as abandoned', () => {
  assert.strictEqual(Object.keys(S.buildUpcoming(
    [B('b1', { check_in_date: '2026-08-12', check_in_time: '20:00' })], NOW)).length, 0);
});

t('a missing check_in_time defaults to noon, not midnight', () => {
  const u = S.buildUpcoming([B('b1', { check_in_time: '' })], NOW);
  assert.strictEqual(u['205'].hours_until, 2);
});

t('HH:MM:SS times are accepted as well as HH:MM', () => {
  const u = S.buildUpcoming([B('b1', { check_in_time: '14:00:00' })], NOW);
  assert.strictEqual(u['205'].hours_until, 4);
});

t('closest booking per room wins, measured on ABSOLUTE hours', () => {
  // An overdue arrival (-1h) outranks a future one (+3h) for the same room.
  const u = S.buildUpcoming([
    B('far',  { check_in_time: '13:00' }),
    B('near', { check_in_time: '09:00' }),
  ], NOW);
  assert.strictEqual(u['205'].booking_id, 'near');
});

t('a malformed date is skipped rather than rendered as a wrong dot', () => {
  assert.strictEqual(
    Object.keys(S.buildUpcoming([B('b1', { check_in_date: 'not-a-date' })], NOW)).length, 0);
});

t('a booking with no room is skipped', () => {
  assert.strictEqual(Object.keys(S.buildUpcoming([B('b1', { room: '' })], NOW)).length, 0);
});

t('multiple rooms are keyed independently', () => {
  const u = S.buildUpcoming([B('b1', {}), B('b2', { room: '207' })], NOW);
  assert.deepStrictEqual(Object.keys(u).sort(), ['205', '207']);
});

// ── Result ────────────────────────────────────────────────────────────────
console.log('\n' + pass + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  console.log('failed: ' + failures.join('; '));
  process.exit(1);
}
