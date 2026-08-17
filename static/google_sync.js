import { initializeApp } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-app.js";
import {
  getFirestore,
  enableMultiTabIndexedDbPersistence,
  collection,
  doc,
  query,
  where,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";

// Read the Firebase web config from window.FIREBASE_CONFIG, which is populated
// by the inline <script src="/firebase-config.js"></script> in templates/.
// That endpoint reads FIREBASE_* env vars on the server so prod / dev /
// staging can be switched without editing client code. The hardcoded fallback
// here matches the prod project — used only when this script is opened in a
// page that didn't load /firebase-config.js (defensive, shouldn't happen).
const firebaseConfig = (typeof window !== "undefined" && window.FIREBASE_CONFIG) || {
  apiKey: "AIzaSyAj_K8Bq8IA0mYH94pu03s3DeDxc2pyCF4",
  authDomain: "cibara-software-61512.firebaseapp.com",
  projectId: "cibara-software-61512",
  storageBucket: "cibara-software-61512.firebasestorage.app",
  messagingSenderId: "117552649945",
  appId: "1:117552649945:web:5d4983739b1a8c077e50c8",
  measurementId: "G-5VY26JYPN0",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ─── Offline persistence (READ-COST CRITICAL) ──────────────────────────────
// Without this, the Firestore SDK keeps its cache in memory only. Every page
// load / PWA resume therefore starts cold: each onSnapshot below re-downloads
// its ENTIRE result set and every one of those documents is a billed read.
// With ~175 documents across the listeners in this file, a device that
// reloads the app 50 times a day burns ~9 000 reads/day on its own — and we
// have several devices.
//
// With IndexedDB persistence the SDK stores the previous query results plus a
// resume token. On re-attach it replays the token and the backend sends only
// what changed since, so a reload costs a handful of reads instead of ~175.
//
// enableMultiTabIndexedDbPersistence (rather than the single-tab variant)
// also makes several open tabs on the same device share ONE backend
// connection instead of one listener set each.
//
// Constraints, deliberately handled:
//   • Must be called before any other Firestore operation. It is — the
//     onSnapshot calls below run later in this module.
//   • Returns a promise that rejects on 'failed-precondition' (another tab
//     already owns a *single*-tab lease) or 'unimplemented' (Safari private
//     mode, IndexedDB disabled). Both are non-fatal: the SDK silently falls
//     back to the in-memory cache and every listener still works exactly as
//     before. We swallow the rejection so it never surfaces as an unhandled
//     promise error in the console.
//   • Resume tokens are not infinitely valid server-side. A device that has
//     been closed for a long stretch still pays a full re-read on its first
//     attach. The saving is on the many reloads WITHIN a working session,
//     which is where the volume actually is.
//
// Migration note: this API is deprecated in favour of
//   initializeFirestore(app, { localCache: persistentLocalCache({
//     tabManager: persistentMultipleTabManager() }) })
// which needs Firebase JS SDK >= 9.22. We are pinned to 9.15 above, so the
// deprecated call is used here to keep this change to a single file with no
// SDK version bump. Switch when the pin moves.
enableMultiTabIndexedDbPersistence(db).catch((err) => {
  const code = (err && err.code) || "unknown";
  console.warn(
    "Cibara: Firestore offline persistence unavailable (" + code + "). " +
      "Live sync still works; read costs will be higher on this device.",
  );
});

// ─── Listener-first mode ───────────────────────────────────────────────────
// Resolved by script.js from settings/ui_config.listener_first, with a
// per-device localStorage override. See the CibaraState block in script.js.
//
//   OFF (legacy): script.js calls /get_data at boot and paints from it. Every
//     listener below therefore SKIPS its first snapshot, because that HTTP
//     call already delivered the same documents. Net effect: the app pays for
//     rooms / totals / today's payments TWICE on every open, once server-side
//     and once client-side.
//
//   ON: the boot HTTP calls are skipped entirely and these listeners are the
//     source of truth. The first snapshot is used to SEED state and paint —
//     served from IndexedDB, so the screen is populated before the network
//     even answers, at zero billed reads. Everything after that is a delta.
//
// The legacy path below is left exactly as it was so the flag is a true kill
// switch, not a rewrite you cannot back out of.
const S = () => window.CibaraState;
const LISTENER_FIRST = !!(window.CibaraState && window.CibaraState.listenerFirst);
console.info(
  "Cibara sync: " + (LISTENER_FIRST ? "listener-first" : "legacy /get_data") + " mode",
);

// Format a Date using LOCAL (IST) calendar components. The backend stores each
// document's `date` as the IST calendar day, so the date-filtered listener
// queries below must compare against the IST day too. `.toISOString()` would
// convert to UTC first and, between 00:00 and 05:30 IST, point the listeners at
// the previous day — silently dropping the current day's live updates.
function _localYMD(d) {
  d = d || new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Today's date string (YYYY-MM-DD) — computed once at load time.
// All date-filtered listeners use this so they all share the same boundary.
const _todayStr = _localYMD();

// Tomorrow's date string (used by bookings listener)
const _tomorrowDate = new Date();
_tomorrowDate.setDate(_tomorrowDate.getDate() + 1);
const _tomorrowStr = _localYMD(_tomorrowDate);

// Upper bound for the bookings listener. Without it the query is open-ended
// into the future, so the initial snapshot grows for the life of the
// business and every attach costs one read per far-future reservation.
// 180 days is well past any realistic lodge reservation; anything beyond it
// still loads normally via /get_bookings when the Bookings tab is opened, it
// just does not push live cross-device updates.
const BOOKINGS_HORIZON_DAYS = 180;
const _horizonDate = new Date();
_horizonDate.setDate(_horizonDate.getDate() + BOOKINGS_HORIZON_DAYS);
const _horizonStr = _localYMD(_horizonDate);

// ─── Day rollover ──────────────────────────────────────────────────────────
// _todayStr is frozen at page load, and four listeners below are scoped to it.
// A device left open across midnight (night shift) therefore keeps watching
// YESTERDAY: new payments, bills and expenses made on other devices stop
// appearing. Re-subscribing in place would mean restructuring the listener
// block; a reload achieves the same thing and also refreshes the rest of the
// page state.
//
// Two guards on the reload, both deliberate:
//   • Tab must be HIDDEN — so it can never interrupt someone mid-check-in.
//   • Device must be ONLINE — the service worker serves navigations
//     network-first with an offline-page fallback, so reloading while offline
//     would strand the user on offline.html.
// If either guard fails we simply wait; the app is then no more stale than it
// is today, which is the current behaviour, not a regression.
(function scheduleDayRollover() {
  const now = new Date();
  const nextMidnight = new Date(
    now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 30, 0,
  );
  const msUntil = nextMidnight.getTime() - now.getTime();
  // Guard against a negative or absurd delay from a mis-set device clock.
  if (!(msUntil > 0) || msUntil > 26 * 60 * 60 * 1000) return;

  setTimeout(function onRollover() {
    function ready() {
      return document.visibilityState === "hidden" && navigator.onLine !== false;
    }
    function attempt() {
      if (!ready()) return;
      document.removeEventListener("visibilitychange", attempt);
      window.removeEventListener("online", attempt);
      window.location.reload();
    }
    if (ready()) {
      window.location.reload();
      return;
    }
    document.addEventListener("visibilitychange", attempt);
    window.addEventListener("online", attempt);
  }, msUntil);
})();

// ─── Rooms listener ────────────────────────────────────────────────────────
// Skip the first snapshot (page already loaded via fetchData on startup).
// For subsequent snapshots, patch only the changed docs into the global
// `rooms` object and re-render — no full round-trip to Flask needed.
let roomsInitialLoad = true;

onSnapshot(collection(db, "rooms"), (snapshot) => {
  if (roomsInitialLoad) {
    roomsInitialLoad = false;
    if (!LISTENER_FIRST) return;
    // Seed the grid from this snapshot. With persistence on, this normally
    // arrives from IndexedDB within a few ms of page load (fromCache === true)
    // and costs nothing; a second callback follows with the server delta only
    // if something actually changed while we were away.
    const map = {};
    snapshot.forEach((d) => { map[d.id] = d.data(); });
    S().setRooms(map);
    S().paint({ rooms: true, stats: true });
    console.log(
      "⚡ Rooms seeded from listener (" + snapshot.size + " docs, " +
        (snapshot.metadata.fromCache ? "cache" : "server") + ")",
    );
    return;
  }

  // Only react to changes that originated from another device/tab.
  // hasPendingWrites == true  →  this browser made the change (already patched locally).
  // fromCache == true         →  SDK restoring from offline cache, skip.
  if (snapshot.metadata.hasPendingWrites || snapshot.metadata.fromCache) {
    return;
  }

  let changed = false;

  snapshot.docChanges().forEach((change) => {
    const roomId = change.doc.id; // e.g. "101"

    if (change.type === "removed") {
      // Room document deleted — clear it from local state
      if (typeof rooms !== "undefined" && rooms[roomId]) {
        delete rooms[roomId];
        changed = true;
      }
      return;
    }

    // "added" or "modified" — patch the room in-place
    if (typeof rooms !== "undefined") {
      rooms[roomId] = { ...rooms[roomId], ...change.doc.data() };
      changed = true;
    }
  });

  if (changed) {
    console.log("⚡ Remote room update — patching local state");
    if (typeof renderRooms === "function") renderRooms();
    // Notify Register & Bills modules so they re-fetch their data too.
    // This covers changes made on ANY device, not just the current browser.
    window.dispatchEvent(new CustomEvent("cibaraRoomUpdate", { detail: { type: "remote_sync" } }));
    showSyncToast();
  }
});

// ─── Totals listener ───────────────────────────────────────────────────────
// Keeps the dashboard stats bar in sync without a full fetchData() call.
let totalsInitialLoad = true;

onSnapshot(doc(db, "totals", "current_totals"), (snap) => {
  if (totalsInitialLoad) {
    totalsInitialLoad = false;
    if (!LISTENER_FIRST) return;
    if (snap.exists()) {
      // /get_data fills in any missing keys with 0; do the same so the stats
      // bar never renders "undefined".
      const t = Object.assign(
        { cash: 0, online: 0, balance: 0, refunds: 0,
          advance_bookings: 0, expenses: 0 },
        snap.data() || {},
      );
      S().setTotals(t);
      S().paint({ stats: true });
    }
    return;
  }

  if (!snap.exists() || snap.metadata.fromCache) return;

  if (typeof totals !== "undefined" && snap.data()) {
    Object.assign(totals, snap.data());
    if (typeof updateStats === "function") updateStats();
    console.log("⚡ Remote totals update — stats refreshed");
  }
});

// ─── UI config listener ───────────────────────────────────────────────────
// Single-doc listener on settings/ui_config. Carries flags like
// hide_register_tab. The initial state is already injected server-side into
// window.__initialUIConfig (so first paint has correct visibility); this
// listener only fires for SUBSEQUENT remote changes — i.e. another device
// flipping a toggle.
//
// hasPendingWrites: this device just wrote — script.js already updated the UI
// optimistically, so don't double-apply.
// fromCache: SDK restoring offline state — ignore.
let uiConfigInitialLoad = true;

onSnapshot(doc(db, "settings", "ui_config"), (snap) => {
  if (uiConfigInitialLoad) {
    uiConfigInitialLoad = false;
    return;
  }
  if (snap.metadata.hasPendingWrites || snap.metadata.fromCache) return;

  const cfg = snap.exists() ? snap.data() : {};
  console.log("⚡ Remote ui_config change", cfg);
  // Hand off to script.js — it owns DOM mutation + active-tab switching.
  window.dispatchEvent(
    new CustomEvent("cibaraUIConfigChanged", { detail: cfg || {} }),
  );
});

// ─── Payments listener (today only) ───────────────────────────────────────
// Filtered to today's date so only ~today's docs are transferred on load.
// Previously listened to the full collection (~2 000+ docs) — very costly.
// Each payment is its own Firestore document so docChanges() gives exactly
// the one record that was added — no array diffing needed.
let paymentsInitialLoad = true;

// ── Today's logs, listener-first ──────────────────────────────────────────
// `logs` needs BOTH today's payments and today's expenses, and they arrive as
// two independent snapshots. Hold the latest full set of each and rebuild
// whenever either lands. A snapshot always carries the complete current result
// set (not just the changes), so rebuilding wholesale is both correct and
// cheap — one day is a few dozen rows — and it sidesteps the incremental
// patching that the legacy path needs.
let _todayPayments = [];
let _todayExpenses = [];
function _rebuildLogs() {
  S().setLogs(S().buildLogs(_todayPayments, _todayExpenses));
  S().paint({ txns: true });
}

onSnapshot(
  query(collection(db, "payments"), where("date", "==", _todayStr)),
  (snapshot) => {
    if (LISTENER_FIRST) {
      _todayPayments = snapshot.docs.map((d) => d.data());
      _rebuildLogs();
      const wasFirst = paymentsInitialLoad;
      paymentsInitialLoad = false;
      // The seed snapshot is not "news" — it is the page loading. Skip the
      // per-change events and toasts for it, and for cache replays, so the
      // user does not get a burst of "payment added" toasts on every open.
      if (wasFirst || snapshot.metadata.fromCache) return;
      snapshot.docChanges().forEach((change) => {
        const p = change.doc.data();
        if (!p || !p.date) return;
        if (change.type === "modified" || change.type === "removed") {
          window.dispatchEvent(
            new CustomEvent("cibaraTransactionRevised", { detail: { date: p.date } }),
          );
          showSyncToast("✏️ Transaction Updated");
          return;
        }
        if (change.type !== "added") return;
        // No _patchLocalLogs / _smoothInsertPaymentRow here: _rebuildLogs()
        // above already rebuilt state from the authoritative snapshot and
        // repainted the list. Doing both would double-insert the row.
        window.dispatchEvent(new CustomEvent("cibaraPaymentAdded", { detail: p }));
        showSyncToast();
      });
      return;
    }

    if (paymentsInitialLoad) {
      paymentsInitialLoad = false;
      return;
    }

    if (snapshot.metadata.hasPendingWrites || snapshot.metadata.fromCache) return;

    snapshot.docChanges().forEach((change) => {
      const p = change.doc.data();
      if (!p || !p.date) return;

      // Edits and deletes made on another device. The in-memory `logs` cache
      // can't be surgically patched safely for these, so signal the
      // Transaction tab to re-pull the affected range. Previously these were
      // assumed to be "handled by room sync", but room sync re-renders rooms,
      // not the transactions list — so remote edits/deletes never showed up
      // on other devices.
      if (change.type === "modified" || change.type === "removed") {
        console.log("⚡ Remote payment " + change.type + " — refreshing transactions");
        window.dispatchEvent(
          new CustomEvent("cibaraTransactionRevised", { detail: { date: p.date } }),
        );
        showSyncToast("✏️ Transaction Updated");
        return;
      }

      if (change.type !== "added") return;

      console.log("⚡ Remote payment added — patching transactions");

      // 1. Patch the local `logs` cache so the in-memory state stays correct
      _patchLocalLogs(p);

      // 2. If the transactions tab is open AND this payment is in the currently
      //    displayed date range, smooth-insert the row without re-rendering everything.
      _smoothInsertPaymentRow(p);

      // 3. Fire a lightweight event so bills + register can react to new payments
      //    without waiting for a room-level change (e.g. mid-stay add-on payments).
      window.dispatchEvent(new CustomEvent("cibaraPaymentAdded", { detail: p }));

      showSyncToast();
    });
  }
);

// ─── Bills listener (today only) ──────────────────────────────────────────
// Filtered to bills checked out today. `checkout_time` is stored as
// "YYYY-MM-DD HH:MM" so a >= / <= range on the date prefix works cleanly.
// Previously listened to all historical bills — very costly.
let billsInitialLoad = true;

onSnapshot(
  query(
    collection(db, "bills"),
    where("checkout_time", ">=", _todayStr + " 00:00"),
    where("checkout_time", "<=", _todayStr + " 23:59")
  ),
  (snapshot) => {
    if (billsInitialLoad) {
      billsInitialLoad = false;
      return;
    }

    if (snapshot.metadata.hasPendingWrites || snapshot.metadata.fromCache) return;

    snapshot.docChanges().forEach((change) => {
      if (change.type === "added" || change.type === "modified") {
        // Inject the Firestore document ID — `change.doc.data()` doesn't
        // include it by default, but Register/Bills key entries by `id`.
        const bill = { id: change.doc.id, ...change.doc.data() };
        console.log("⚡ Remote bill change — notifying tabs", change.type, bill.id);
        window.dispatchEvent(new CustomEvent("cibaraBillChanged", {
          detail: { ...bill, _changeType: change.type },
        }));
        showSyncToast();
      }
    });
  }
);

// ─── Bookings listener (today .. +BOOKINGS_HORIZON_DAYS) ──────────────────
// Watches bookings checking in between today and the horizon so that any new
// booking, or any status change (e.g. cancellation), is immediately reflected
// on all devices without a manual refresh.
//
// The upper bound was added to stop the initial snapshot growing without limit
// as far-future reservations accumulate — every document in the result set is
// a billed read on each attach. Two range filters on the SAME field need no
// composite index, so this is a query-shape change only.
let bookingsInitialLoad = true;

onSnapshot(
  query(
    collection(db, "bookings"),
    where("check_in_date", ">=", _todayStr),
    where("check_in_date", "<=", _horizonStr)
  ),
  (snapshot) => {
    if (LISTENER_FIRST) {
      // Rebuild the arrival-indicator map from the documents this listener
      // already holds. In legacy mode this map came from a separate
      // /get_upcoming_bookings HTTP call that re-read the very same bookings
      // server-side.
      S().setUpcoming(
        S().buildUpcoming(snapshot.docs.map((d) => ({ id: d.id, data: d.data() }))),
      );
      S().paint({ rooms: true });
      const wasFirst = bookingsInitialLoad;
      bookingsInitialLoad = false;
      if (wasFirst || snapshot.metadata.fromCache) return;
      // booking.js still drives its own list off these events.
      snapshot.docChanges().forEach((change) => {
        const booking = change.doc.data();
        if (change.type === "added") {
          window.dispatchEvent(new CustomEvent("cibaraBookingAdded", { detail: booking }));
          showSyncToast("📋 New Booking — " + (booking.guest_name || "Guest"));
        } else if (change.type === "modified") {
          window.dispatchEvent(new CustomEvent("cibaraBookingModified", { detail: booking }));
          showSyncToast("📋 Booking Updated");
        } else if (change.type === "removed") {
          window.dispatchEvent(new CustomEvent("cibaraBookingModified", {
            detail: { ...booking, _removed: true },
          }));
          showSyncToast("📋 Booking Updated");
        }
      });
      return;
    }

    if (bookingsInitialLoad) {
      bookingsInitialLoad = false;
      return;
    }

    if (snapshot.metadata.hasPendingWrites || snapshot.metadata.fromCache) return;

    let hasAdded = false, hasModified = false;

    snapshot.docChanges().forEach((change) => {
      const booking = change.doc.data();
      if (change.type === "added") {
        hasAdded = true;
        console.log("⚡ Remote booking added:", booking.room, booking.check_in_date);
        window.dispatchEvent(new CustomEvent("cibaraBookingAdded", { detail: booking }));
        showSyncToast("📋 New Booking — " + (booking.guest_name || "Guest"));
      } else if (change.type === "modified") {
        hasModified = true;
        console.log("⚡ Remote booking modified:", booking.room, booking.status);
        window.dispatchEvent(new CustomEvent("cibaraBookingModified", { detail: booking }));
      } else if (change.type === "removed") {
        hasModified = true;
        window.dispatchEvent(new CustomEvent("cibaraBookingModified", { detail: { ...change.doc.data(), _removed: true } }));
      }
    });

    if (hasModified && !hasAdded) showSyncToast("📋 Booking Updated");
  }
);

// ─── Expenses listener (today only) ───────────────────────────────────────
// Expenses are written to the `expenses` collection (not `payments`).
// Listen for new expenses so the transaction tab stays current on all devices.
let expensesInitialLoad = true;

onSnapshot(
  query(collection(db, "expenses"), where("date", "==", _todayStr)),
  (snapshot) => {
    if (LISTENER_FIRST) {
      // `_doc_id` is NOT optional. The server adds it in
      // expense_service.query_expenses_by_date_range, and the Transactions
      // tab keys the edit / delete / attach-photo / GST-invoice actions off
      // it (transaction-tracking.js:840-976, expense.js:1311). Omit it and
      // expense rows silently render without their action buttons.
      _todayExpenses = snapshot.docs.map((d) =>
        Object.assign({}, d.data(), { _doc_id: d.id }),
      );
      _rebuildLogs();
      const wasFirst = expensesInitialLoad;
      expensesInitialLoad = false;
      if (wasFirst || snapshot.metadata.fromCache) return;
      snapshot.docChanges().forEach((change) => {
        const exp = change.doc.data();
        if (!exp) return;
        if (change.type === "modified" || change.type === "removed") {
          window.dispatchEvent(
            new CustomEvent("cibaraTransactionRevised", { detail: { date: exp.date } }),
          );
          showSyncToast("✏️ Expense Updated");
          return;
        }
        if (change.type !== "added") return;
        window.dispatchEvent(new CustomEvent("cibaraExpenseAdded", { detail: exp }));
        showSyncToast("🧾 Expense Added");
      });
      return;
    }

    if (expensesInitialLoad) { expensesInitialLoad = false; return; }
    if (snapshot.metadata.hasPendingWrites || snapshot.metadata.fromCache) return;

    snapshot.docChanges().forEach((change) => {
      const exp = change.doc.data();
      if (!exp) return;

      if (change.type === "modified" || change.type === "removed") {
        console.log("⚡ Remote expense " + change.type + " — refreshing transactions");
        window.dispatchEvent(
          new CustomEvent("cibaraTransactionRevised", { detail: { date: exp.date } }),
        );
        showSyncToast("✏️ Expense Updated");
        return;
      }

      if (change.type !== "added") return;
      console.log("⚡ Remote expense added — notifying transactions");
      window.dispatchEvent(new CustomEvent("cibaraExpenseAdded", { detail: exp }));
      showSyncToast("🧾 Expense Added");
    });
  }
);

// ─── Daily serial counter (listener-first only) ───────────────────────────
// Replaces the /get_transaction_metadata call that lived inside fetchData().
// That endpoint did a single-doc read of daily_counters/<today> and returned
// { [today]: count }, which is exactly what this listener delivers — except it
// also stays live, so the next check-in serial is correct on every device
// without a refresh. One document: the cheapest listener in this file.
if (LISTENER_FIRST) {
  onSnapshot(doc(db, "daily_counters", _todayStr), (snap) => {
    const count = snap.exists() ? ((snap.data() || {}).count || 0) : 0;
    const map = {};
    map[_todayStr] = count;
    S().setDailyCounters(map);
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Patch the global `logs` object (used by renderEnhancedLogs) with one new
 * payment document so the in-memory cache stays consistent with Firestore.
 */
function _patchLocalLogs(p) {
  if (typeof logs === "undefined") return;

  const _refundTypes = new Set([
    "refund", "checkout_refund", "manual_refund", "booking_cancel_refund",
  ]);
  const type = p.type || "";
  const method = p.method || "";

  let bucket = null;
  if (_refundTypes.has(type)) {
    bucket = "refunds";
  } else if (method === "cash" || method === "pay_later") {
    bucket = "cash";
  } else if (method === "online") {
    bucket = "online";
  }

  if (!bucket) return;
  if (!logs[bucket]) logs[bucket] = [];

  // Avoid duplicates — the local browser may have already added it
  const key = `${p.date}_${p.time}_${p.room}_${p.amount}`;
  const already = logs[bucket].some(
    (e) => `${e.date}_${e.time}_${e.room}_${e.amount}` === key
  );
  if (!already) logs[bucket].unshift(p);   // newest first
}

/**
 * Smooth-insert a single payment row into the visible transactions list.
 * Only runs when the transactions tab is open and the payment's date is
 * within the currently displayed range. No full re-render.
 */
function _smoothInsertPaymentRow(p) {
  if (typeof transactionLogManager === "undefined") return;

  const container = document.getElementById("transaction-log");
  if (!container) return;

  // Only act when the transactions tab is actually visible
  const txnTab = document.getElementById("transaction-tab");
  if (!txnTab || txnTab.classList.contains("hidden")) return;

  // Check if this payment's date falls in the currently rendered range
  if (typeof txnActiveDateRange !== "undefined" && txnActiveDateRange.fromDate) {
    if (p.date < txnActiveDateRange.fromDate || p.date > txnActiveDateRange.toDate) return;
  }

  const _refundTypes = new Set([
    "refund", "checkout_refund", "manual_refund", "booking_cancel_refund",
  ]);
  const type = p.type || "";
  const method = p.method || "";

  let logType = "cash";
  if (_refundTypes.has(type))   logType = "refunds";
  else if (type === "expense")  logType = "expenses";
  else if (method === "online") logType = "online";

  // Build the HTML for just this one row
  const html = transactionLogManager.renderEnhancedLogItem({ ...p, logType }, logType);

  // Find or create the date-group header for this payment's date
  const dateHeaderId = `log-date-${p.date}`;
  let dateHeader = document.getElementById(dateHeaderId);

  if (!dateHeader) {
    // Date group doesn't exist yet — prepend a new one at the top
    const todayStr  = _localYMD();
    const yest      = new Date(); yest.setDate(yest.getDate() - 1);
    const yesterStr = _localYMD(yest);
    const dateObj   = new Date(p.date + "T00:00:00");
    const label     = dateObj.toLocaleDateString("en-IN", { weekday: "long", month: "short", day: "numeric" });
    const prefix    = p.date === todayStr ? "Today — " : p.date === yesterStr ? "Yesterday — " : "";

    const groupDiv  = document.createElement("div");
    groupDiv.innerHTML = `<div id="${dateHeaderId}" class="log-date-header">${prefix}${label}<span class="log-date-total"></span></div>`;
    container.insertBefore(groupDiv.firstElementChild, container.firstChild);
    dateHeader = document.getElementById(dateHeaderId);
  }

  // Insert the new row right after its date header, with a fade-in animation
  const tempDiv = document.createElement("div");
  tempDiv.innerHTML = html.trim();
  const newRow = tempDiv.firstElementChild;
  if (!newRow) return;

  newRow.style.animation = "cibaraFadeIn 0.35s ease";
  dateHeader.insertAdjacentElement("afterend", newRow);

  // Inject the animation keyframe once
  if (!document.getElementById("cibara-fadein-style")) {
    const s = document.createElement("style");
    s.id = "cibara-fadein-style";
    s.textContent = `
      @keyframes cibaraFadeIn {
        from { opacity: 0; transform: translateY(-6px); }
        to   { opacity: 1; transform: translateY(0); }
      }
    `;
    document.head.appendChild(s);
  }
}

// ─── Toast helper ──────────────────────────────────────────────────────────
function showSyncToast(message = "☁️ Data Updated Automatically") {
  const toast = document.createElement("div");
  toast.innerHTML = message;
  toast.style.cssText = `
    position: fixed; bottom: 20px; right: 20px;
    background: #34495e; color: white; padding: 12px 24px;
    border-radius: 8px; font-size: 13px; z-index: 9999;
    box-shadow: 0 4px 15px rgba(0,0,0,0.3);
    transition: opacity 0.5s;
  `;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 500);
  }, 2500);
}
