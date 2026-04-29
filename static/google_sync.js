import { initializeApp } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  query,
  where,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";

const firebaseConfig = {
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

// Today's date string (YYYY-MM-DD) — computed once at load time.
// All date-filtered listeners use this so they all share the same boundary.
const _todayStr = new Date().toISOString().split("T")[0];

// Tomorrow's date string (used by bookings listener)
const _tomorrowDate = new Date();
_tomorrowDate.setDate(_tomorrowDate.getDate() + 1);
const _tomorrowStr = _tomorrowDate.toISOString().split("T")[0];

// ─── Rooms listener ────────────────────────────────────────────────────────
// Skip the first snapshot (page already loaded via fetchData on startup).
// For subsequent snapshots, patch only the changed docs into the global
// `rooms` object and re-render — no full round-trip to Flask needed.
let roomsInitialLoad = true;

onSnapshot(collection(db, "rooms"), (snapshot) => {
  if (roomsInitialLoad) {
    roomsInitialLoad = false;
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
    return;
  }

  if (!snap.exists() || snap.metadata.fromCache) return;

  if (typeof totals !== "undefined" && snap.data()) {
    Object.assign(totals, snap.data());
    if (typeof updateStats === "function") updateStats();
    console.log("⚡ Remote totals update — stats refreshed");
  }
});

// ─── Payments listener (today only) ───────────────────────────────────────
// Filtered to today's date so only ~today's docs are transferred on load.
// Previously listened to the full collection (~2 000+ docs) — very costly.
// Each payment is its own Firestore document so docChanges() gives exactly
// the one record that was added — no array diffing needed.
let paymentsInitialLoad = true;

onSnapshot(
  query(collection(db, "payments"), where("date", "==", _todayStr)),
  (snapshot) => {
    if (paymentsInitialLoad) {
      paymentsInitialLoad = false;
      return;
    }

    if (snapshot.metadata.hasPendingWrites || snapshot.metadata.fromCache) return;

    snapshot.docChanges().forEach((change) => {
      if (change.type !== "added") return;   // edits/deletes handled by room sync
      const p = change.doc.data();
      if (!p || !p.date) return;

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

// ─── Bookings listener (all future bookings) ──────────────────────────────
// Watches all bookings with check_in_date >= today so that any new booking —
// regardless of how far in the future — or any status change (e.g. cancellation)
// is immediately reflected on all devices without a manual refresh.
let bookingsInitialLoad = true;

onSnapshot(
  query(
    collection(db, "bookings"),
    where("check_in_date", ">=", _todayStr)
  ),
  (snapshot) => {
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
    if (expensesInitialLoad) { expensesInitialLoad = false; return; }
    if (snapshot.metadata.hasPendingWrites || snapshot.metadata.fromCache) return;

    snapshot.docChanges().forEach((change) => {
      if (change.type !== "added") return;
      const exp = change.doc.data();
      console.log("⚡ Remote expense added — notifying transactions");
      window.dispatchEvent(new CustomEvent("cibaraExpenseAdded", { detail: exp }));
      showSyncToast("🧾 Expense Added");
    });
  }
);

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
    const todayStr  = new Date().toISOString().split("T")[0];
    const yest      = new Date(); yest.setDate(yest.getDate() - 1);
    const yesterStr = yest.toISOString().split("T")[0];
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
