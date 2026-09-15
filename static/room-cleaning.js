// Room Cleaning Status Management with Quality Check

// Initialize cleaning feature on page load
function initializeCleaningFeature() {
  console.log("Cleaning feature initialized");
  createQualityCheckModal();   // modal + styles once at init, not on first open
  _initQcButtonDelegation();
}

/* ── Race-proof, instant handling for the Ready/Cleaned buttons ───────────
 * The room grid is re-rendered live by Firestore snapshot listeners. With
 * inline onclick, a re-render between finger-down and finger-up destroyed
 * the button node and the click never fired — the tap "did nothing".
 * Instead we capture the intent at pointerdown on the ORIGINAL node and
 * act on pointerup anywhere: immune to re-renders, and the modal opens the
 * moment the finger lifts (no synthesized-click wait).
 * Buttons are matched by [data-qc-room] (see script.js card renderer). */
function _initQcButtonDelegation() {
  let pending = null;
  let handledAt = 0;

  document.addEventListener("pointerdown", function (e) {
    // A new gesture: its click is a real one. Without this reset a row
    // tapped within 400ms of the modal opening lost its tick.
    handledAt = 0;
    const btn = e.target && e.target.closest
      ? e.target.closest("[data-qc-room]") : null;
    pending = btn
      ? { room: btn.getAttribute("data-qc-room"),
          x: e.clientX, y: e.clientY, t: Date.now() }
      : null;
  }, true);

  document.addEventListener("pointerup", function (e) {
    if (!pending) return;
    const p = pending;
    pending = null;
    if (Date.now() - p.t > 700) return;                 // long-press → ignore
    if (Math.abs(e.clientX - p.x) > 14 ||
        Math.abs(e.clientY - p.y) > 14) return;         // scroll/drag → ignore
    handledAt = Date.now();
    markRoomAsCleaned(String(p.room));
  }, true);

  // Swallow the click that follows a handled pointerup so the room card's
  // own click handler doesn't also fire (that's what stopPropagation in the
  // old inline handlers used to do).
  document.addEventListener("click", function (e) {
    if (Date.now() - handledAt < 400) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);
}

/* ── Quality check modal ────────────────────────────────────────────────────
 * One modal serves every room type; only the checklist differs. Item keys
 * are sent to the server as `checklist: {washroom: true, ...}` and kept in
 * the audit log, so a label may change freely but a key must never be
 * renamed or old entries stop lining up with new ones. */
const QC_CHECKLISTS = {
  // Rooms 200-206
  premium: {
    title: "Quality Check",
    items: [
      { key: "washroom", label: "🚿 Washroom is clean" },
      { key: "coffee",   label: "☕ Coffee maker ready" },
      { key: "towels",   label: "🧺 Towels placed (3 sets)" },
    ],
  },
  // Rooms 207-228
  standard: {
    title: "Quality Check",
    items: [
      { key: "washroom", label: "🚿 Washroom is clean" },
      { key: "dustbin",  label: "🗑️ Dustbin cleaned" },
      { key: "towels",   label: "🧺 Towels placed" },
    ],
  },
  // Every other room
  regular: {
    title: "Quick Check",
    items: [
      { key: "room_ready", label: "✨ Room is cleaned and ready" },
    ],
  },
};

function qcChecklistFor(roomNumber) {
  const num = parseInt(roomNumber, 10);
  if (num >= 200 && num <= 206) return QC_CHECKLISTS.premium;
  if (num >= 207 && num <= 228) return QC_CHECKLISTS.standard;
  return QC_CHECKLISTS.regular;
}

// Room the modal is showing, as a string; null while closed.
let _qcRoom = null;

// Built once at init. Opening only swaps in the rows for the room type.
function createQualityCheckModal() {
  if (document.getElementById("room-qc-modal")) {
    return;
  }
  addQualityCheckStyles();

  document.body.insertAdjacentHTML("beforeend", `
    <div class="modal-backdrop" id="room-qc-modal">
      <div class="modal-content" style="max-width: 400px;">
        <div class="modal-header" style="padding: 1rem 1.5rem;">
          <h2 style="font-size: 1.1rem;">Room <span id="room-qc-room"></span> - <span id="room-qc-title"></span></h2>
          <button class="close-btn" aria-label="Close">&times;</button>
        </div>
        <div class="modal-body" style="padding: 1rem 1.5rem;">
          <div class="quality-checklist" id="room-qc-list"></div>
        </div>
        <div class="modal-footer" style="padding: 1rem 1.5rem; gap: 0.5rem;">
          <button type="button" class="room-qc-cancel action-btn btn-secondary" style="flex: 1;">
            Cancel
          </button>
          <button type="button" id="room-qc-approve" class="action-btn btn-success" style="flex: 1;" disabled></button>
        </div>
      </div>
    </div>
  `);

  const modal = document.getElementById("room-qc-modal");
  modal.querySelector(".close-btn").addEventListener("click", () => closeQualityCheckModal());
  modal.querySelector(".room-qc-cancel").addEventListener("click", () => closeQualityCheckModal());
  // Each row is a <label> around its checkbox, so a tap anywhere on the row
  // toggles it natively; one delegated listener keeps the button in step.
  document.getElementById("room-qc-list").addEventListener("change", updateQualityCheckButton);
  document.getElementById("room-qc-approve").addEventListener("click", submitQualityCheck);

  // Listening on document rather than the modal keeps Enter working after a
  // tap on the backdrop has moved focus to <body>. A focused button keeps
  // its own Enter (Cancel must not approve).
  document.addEventListener("keydown", (e) => {
    if (!modal.classList.contains("show") || e.isComposing) return;
    if (e.key === "Escape") {
      closeQualityCheckModal();
    } else if (e.key === "Enter" && !(e.target.closest && e.target.closest("button"))) {
      e.preventDefault();
      submitQualityCheck();
    }
  });
}

function addQualityCheckStyles() {
  if (document.getElementById("quality-check-styles")) {
    return;
  }

  const style = document.createElement("style");
  style.id = "quality-check-styles";
  style.textContent = `
    /* The QC modal opens instantly: skip the generic backdrop fade */
    #room-qc-modal,
    #room-qc-modal .modal-content {
      transition: none;
      animation: none;
    }
    .cleaned-btn { touch-action: manipulation; }

    .quality-checklist {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    /* No transitions anywhere on the check state: a tick has to show on the
       frame the finger lifts, or the whole check feels slow. */
    .quality-check-item {
      display: flex;
      align-items: center;
      padding: 0.6rem 0.85rem;
      border: 2px solid #e0e0e0;
      border-radius: 6px;
      cursor: pointer;
      position: relative;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
      -webkit-user-select: none;
      user-select: none;
    }

    /* Real pointers only: on touch screens :hover sticks to the last tapped
       row, which read as a selection after the row was unticked. */
    @media (hover: hover) {
      .quality-check-item:hover {
        border-color: var(--primary);
        background-color: #f8f9fa;
      }
    }

    .quality-check-item:active {
      background-color: #f1f3f5;
    }

    .quality-check-item.is-checked {
      border-color: var(--success);
    }

    .quality-check-item input[type="checkbox"] {
      position: absolute;
      opacity: 0;
      cursor: pointer;
    }

    .quality-check-item .checkmark {
      width: 22px;
      height: 22px;
      border: 2px solid #ccc;
      border-radius: 4px;
      margin-right: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    /* The real checkbox is invisible, so keyboard focus shows on its box */
    .quality-check-item input[type="checkbox"]:focus-visible ~ .checkmark {
      outline: 2px solid var(--primary);
      outline-offset: 2px;
    }

    .quality-check-item input[type="checkbox"]:checked ~ .checkmark {
      background-color: var(--success);
      border-color: var(--success);
    }

    .quality-check-item input[type="checkbox"]:checked ~ .checkmark:after {
      content: "✓";
      color: white;
      font-size: 14px;
      font-weight: bold;
    }

    .quality-check-item input[type="checkbox"]:checked ~ .check-label {
      color: var(--success);
      font-weight: 500;
    }

    .check-label {
      font-size: 0.95rem;
    }

    /* Enables the instant the last row is ticked, without the 0.3s fade
       every .action-btn has. */
    #room-qc-approve {
      transition: none;
      touch-action: manipulation;
    }

    #room-qc-approve:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      background-color: #ccc;
    }
  `;
  document.head.appendChild(style);
}

function showQualityCheckModal(roomNumber) {
  const modal = document.getElementById("room-qc-modal");
  if (!modal) {
    console.error("Quality check modal not found");
    return;
  }

  const checklist = qcChecklistFor(roomNumber);
  _qcRoom = String(roomNumber);
  document.getElementById("room-qc-room").textContent = _qcRoom;
  document.getElementById("room-qc-title").textContent = checklist.title;
  // Rebuilt on every open, which is also the reset between rooms.
  document.getElementById("room-qc-list").innerHTML = checklist.items.map((item) => `
    <label class="quality-check-item">
      <input type="checkbox" class="quality-checkbox" data-qc-key="${item.key}">
      <span class="checkmark"></span>
      <span class="check-label">${item.label}</span>
    </label>`).join("");
  updateQualityCheckButton();
  modal.classList.add("show");
  // Space ticks and Tab moves on from the keyboard straight away. A checkbox
  // raises no on-screen keyboard, so this costs nothing on a phone.
  modal.querySelector(".quality-checkbox").focus({ preventScroll: true });
}

// With a room number, closes only while the modal still shows that room: a
// save that settles late must not close a check opened since for another.
function closeQualityCheckModal(roomNumber) {
  const modal = document.getElementById("room-qc-modal");
  if (!modal || (roomNumber != null && String(roomNumber) !== _qcRoom)) return;
  modal.classList.remove("show");
  _qcRoom = null;
  // Hidden rows keep focus otherwise, and a stray Space would tick one.
  if (modal.contains(document.activeElement)) document.activeElement.blur();
}

// Approve unlocks the moment the last row is ticked and shows progress
// until then. Also re-run when a save for the shown room starts or settles.
function updateQualityCheckButton() {
  const approveBtn = document.getElementById("room-qc-approve");
  if (!approveBtn) return;
  const boxes = document.querySelectorAll("#room-qc-list .quality-checkbox");
  let ticked = 0;
  boxes.forEach((cb) => {
    cb.parentNode.classList.toggle("is-checked", cb.checked);
    if (cb.checked) ticked++;
  });
  const complete = ticked === boxes.length;
  const saving = !!(_qcRoom && _cleaningInflight[_qcRoom]);
  approveBtn.disabled = !complete || saving;
  approveBtn.textContent = saving ? "Saving…"
    : complete ? "Mark as Clean ✓"
    : `Mark as Clean (${ticked}/${boxes.length})`;
}

function submitQualityCheck() {
  const approveBtn = document.getElementById("room-qc-approve");
  if (!_qcRoom || !approveBtn || approveBtn.disabled) return;
  const roomNumber = _qcRoom;

  // The Firestore listener may have moved the room on (another device
  // approved it) while this check was open. Say so now rather than flash a
  // success that the server then rejects.
  if (!isRoomCleaning(roomNumber)) {
    closeQualityCheckModal();
    showNotification("This room is not in cleaning status", "error");
    return;
  }

  const checklist = {};
  document.querySelectorAll("#room-qc-list .quality-checkbox").forEach((cb) => {
    checklist[cb.dataset.qcKey] = cb.checked;
  });
  _completeCleaningOptimistic(roomNumber, { checklist: checklist });
}

// Mark room as cleaned - opens the check for the room's type
async function markRoomAsCleaned(roomNumber) {
  try {
    const roomInfo = rooms[roomNumber];
    if (!roomInfo) {
      showNotification("Room not found", "error");
      return false;
    }

    // Verify room is in cleaning status before marking as cleaned
    if (roomInfo.status !== "cleaning") {
      showNotification("This room is not in cleaning status", "error");
      return false;
    }

    // Photo steps for 200-block rooms (static/room-photos.js): a manager
    // approving takes inspection photos, housekeeping marking cleaned takes
    // cleaning photos, each behind its Settings switch. Admin and anyone
    // whose switch is off fall through to the checklist below unchanged.
    if (window.RoomPhotos) {
      const _a = window.CibaraAuth;
      const _ctx = _a && _a.userCan && _a.userCan("room.inspection.approve") ? "inspection" : "cleaning";
      if (RoomPhotos.wantsPhotoCheck(roomNumber, _ctx)) {
        RoomPhotos.open({ room: roomNumber, context: _ctx });
        return false;
      }
    }

    showQualityCheckModal(roomNumber);
    return false; // Don't mark as cleaned yet, wait for the check
  } catch (error) {
    console.error("Error marking room as cleaned:", error);
    showNotification("Error marking room as cleaned", "error");
    return false;
  }
}

// ── Completing the step ────────────────────────────────────────────────────
// Routing by role (RBAC):
//   • Housekeeping → POST /mark_room_cleaned
//       Sets cleaning_status="ready_to_inspect" (the room stays in
//       status="cleaning" until an admin/manager approves it).
//   • Admin / Manager → POST /mark_room_ready_for_checkin
//       Skips the inspection wait and clears the room to vacant in one
//       step. Works whether the room is currently in_progress or
//       ready_to_inspect.
// `patch` is the local end state that write produces, so the card can show
// it without waiting for the Firestore listener.
function _cleaningStep(roomNumber) {
  const _auth = window.CibaraAuth;
  if (_auth && _auth.userCan && _auth.userCan("room.inspection.approve")) {
    return {
      endpoint: "/mark_room_ready_for_checkin",
      patch: { status: "vacant", cleaning_status: null, cleaning_start_time: null },
      toast: `Room ${roomNumber} is ready for check-in`,
      label: `room ${roomNumber} inspection`,
    };
  }
  return {
    endpoint: "/mark_room_cleaned",
    patch: { cleaning_status: "ready_to_inspect" },
    toast: `Room ${roomNumber} cleaned. Awaiting inspection.`,
    label: `room ${roomNumber} cleaning`,
  };
}

// The one request both the checklist and the photo flow send. Resolves to
// the server's reply. A 400 carries a real message (e.g. photos missing), so
// it resolves as that success:false reply rather than a bare status error.
async function _postCleaningStep(step, roomNumber, extra) {
  const response = await apiFetch(step.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(Object.assign({ room: roomNumber }, extra)),
  });
  const result = await response.json().catch(function () { return {}; });
  if (!response.ok && !result.message) {
    throw new Error(`Server responded with status: ${response.status}`);
  }
  return result;
}

// Writes step.patch into the room, closes the check, toasts and re-renders.
// Returns what _revertCleaningStep needs to undo exactly those fields.
function _applyCleaningStep(roomNumber, step) {
  const info = rooms[roomNumber];
  const prior = {};
  if (info) {
    Object.keys(step.patch).forEach((k) => {
      if (k in info) prior[k] = info[k];
      info[k] = step.patch[k];
    });
  }
  closeQualityCheckModal(roomNumber);
  showNotification(step.toast, "success");
  renderRooms();
  return { info: info, prior: prior, patch: step.patch };
}

// Rollback for a rejected background write. The listener and a full refresh
// replace the room object rather than edit it, so a different object means
// newer server state has already landed; it wins and nothing is restored.
function _revertCleaningStep(roomNumber, snap) {
  const info = rooms[roomNumber];
  if (!info || info !== snap.info) return;
  Object.keys(snap.patch).forEach((k) => {
    if (k in snap.prior) info[k] = snap.prior[k];
    else delete info[k];
  });
  renderRooms();
}

// In-flight guard: a double-tap on the QC approve button used to fire two
// racing requests, producing duplicate audit entries (rooms then showed up
// twice in Daily Insights). Repeat calls for the same room are ignored
// until the first request settles. The server also rejects the loser via
// a transactional claim; this guard just avoids the wasted round-trip.
var _cleaningInflight = {};

function _claimCleaning(roomNumber) {
  if (_cleaningInflight[roomNumber]) return false;
  _cleaningInflight[roomNumber] = true;
  updateQualityCheckButton();
  return true;
}

function _releaseCleaning(roomNumber) {
  delete _cleaningInflight[roomNumber];
  updateQualityCheckButton();
}

// Checklist path: the card flips and the modal closes on the tap, and the
// write persists in the background through static/optimistic.js, queued per
// room behind any other pending write for it. A rejected write reverts the
// card with a loud error toast. With optimistic writes switched off (the
// optimistic.js kill-switch) the same call saves first while the modal
// shows "Saving…".
function _completeCleaningOptimistic(roomNumber, extra) {
  // Defensive fallback: if optimistic.js failed to load, use the old flow.
  if (typeof window.optimisticWrite !== "function") {
    completeRoomCleaning(roomNumber, extra);
    return;
  }
  if (!_claimCleaning(roomNumber)) return;

  const step = _cleaningStep(roomNumber);
  const release = () => _releaseCleaning(roomNumber);
  window.optimisticWrite({
    // The room-number string, the same queue check-in uses: a guest checked
    // in straight after this approval reaches the server after it.
    key: roomNumber,
    label: step.label,
    apply: () => _applyCleaningStep(roomNumber, step),
    rollback: (snap) => _revertCleaningStep(roomNumber, snap),
    // optimisticWrite reads a Response and reports any non-2xx as a bare
    // "HTTP 400". Hand it the parsed reply instead so the server's own
    // message reaches the error toast.
    request: () => _postCleaningStep(step, roomNumber, extra)
      .then((result) => ({ ok: true, json: () => Promise.resolve(result) })),
    // A write queued behind this one (a check-in made while the card showed
    // vacant) replaces the room, so the rollback above leaves it alone and
    // that write's own rollback would restore the vacant card. Re-sync from
    // the server once the room's queue drains so the grid ends on the truth.
    onError: () => window.cibaraWrites.pendingFor(roomNumber).then(() => {
      if (typeof debouncedFetchData === "function") debouncedFetchData(0);
    }),
  }).then(release, release);
}

// Awaited path: resolves true only once the server has confirmed. The photo
// modal (static/room-photos.js) awaits this and stays open on false, which
// matters because the server enforces the photo rule. `extra` is merged into
// the request body; the photo flow passes { photos, notes }.
async function completeRoomCleaning(roomNumber, extra) {
  if (!_claimCleaning(roomNumber)) return false;
  try {
    const step = _cleaningStep(roomNumber);
    const result = await _postCleaningStep(step, roomNumber, extra);
    if (!result.success) {
      showNotification(result.message || "Error marking room as cleaned", "error");
      return false;
    }
    _applyCleaningStep(roomNumber, step);
    return true;
  } catch (error) {
    console.error("Error completing room cleaning:", error);
    showNotification("Error marking room as cleaned", "error");
    return false;
  } finally {
    _releaseCleaning(roomNumber);
  }
}

// Check if room is in cleaning status
function isRoomCleaning(roomNumber) {
  const roomInfo = rooms[roomNumber];
  return roomInfo && roomInfo.status === "cleaning";
}

// Get cleaning time for display
function getCleaningTime(roomNumber) {
  const roomInfo = rooms[roomNumber];
  if (!roomInfo || !roomInfo.cleaning_start_time) {
    return "0m";
  }

  try {
    const startTime = new Date(roomInfo.cleaning_start_time);
    const now = new Date();
    const diffMs = now - startTime;
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 60) {
      return `${diffMins}m`;
    }
    const hours = Math.floor(diffMins / 60);
    const mins = diffMins % 60;
    return `${hours}h ${mins}m`;
  } catch (e) {
    return "0m";
  }
}

// ── Mistake-checkout revert (3-hour window) ────────────────────────────────
// Two-step flow:
//   1. User clicks the small undo icon on a cleaning room card.
//   2. Existing manager-password modal opens (shared look-and-feel).
//   3. On password verify, the captured password is held briefly in a
//      closure and the redesigned reason modal opens showing context
//      (room, guest, time-since-checkout). User enters a reason and
//      confirms — we POST /revert_checkout with the cached password.
//   4. Password is cleared from memory after the request finishes (or
//      after a 60s safety timeout) so it never lingers.
//
// Server is the source of truth for the 3-hour window. The frontend hides
// the icon after the local computation says it expired, but the server
// re-checks on submit so device clock skew can never extend the window.

const REVERT_CHECKOUT_WINDOW_MS = 3 * 60 * 60 * 1000;  // 3 hours

// Inject the icon's CSS eagerly so the button is correctly positioned
// on the very first render of a cleaning card. The modal-related CSS
// is still injected lazily on first click.
(function ensureRevertIconStyle() {
  if (typeof document === "undefined") return;
  if (document.getElementById("revert-checkout-icon-style")) return;
  const s = document.createElement("style");
  s.id = "revert-checkout-icon-style";
  s.textContent = `
    .revert-checkout-icon {
      position: absolute;
      top: 8px;
      right: 8px;
      width: 26px;
      height: 26px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      line-height: 1;
      color: #475569;
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 50%;
      cursor: pointer;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06);
      transition: background 0.15s ease, color 0.15s ease,
                  border-color 0.15s ease, transform 0.15s ease;
      z-index: 3;
    }
    .revert-checkout-icon:hover {
      color: #0f172a;
      background: #f8fafc;
      border-color: #cbd5e1;
      transform: scale(1.06);
    }
    .revert-checkout-icon:active { transform: scale(0.94); }
    .revert-checkout-icon i { font-size: 11px; }
  `;
  (document.head || document.documentElement).appendChild(s);
})();

/** True if the room (in cleaning state) is still inside the revert window. */
function isRevertEligible(roomInfo) {
  if (!roomInfo || roomInfo.status !== "cleaning") return false;
  if (!roomInfo.last_bill_id) return false;
  if (!roomInfo.last_checkout_at) return false;
  try {
    const ts = new Date(roomInfo.last_checkout_at).getTime();
    if (!isFinite(ts)) return false;
    const ageMs = Date.now() - ts;
    return ageMs >= 0 && ageMs <= REVERT_CHECKOUT_WINDOW_MS;
  } catch (e) {
    return false;
  }
}

/** "2h 14m left" / "37m left" / "expired" */
function formatRevertTimeLeft(roomInfo) {
  try {
    const ts = new Date(roomInfo.last_checkout_at).getTime();
    const remainingMs = REVERT_CHECKOUT_WINDOW_MS - (Date.now() - ts);
    if (remainingMs <= 0) return "expired";
    const mins = Math.floor(remainingMs / 60000);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
  } catch (e) {
    return "";
  }
}

/** "12 minutes ago" / "1 hour 23 minutes ago" */
function formatTimeSinceCheckout(roomInfo) {
  try {
    const ts = new Date(roomInfo.last_checkout_at).getTime();
    const ageMs = Date.now() - ts;
    if (ageMs < 0) return "just now";
    const mins = Math.floor(ageMs / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (m === 0) return `${h} hour${h === 1 ? "" : "s"} ago`;
    return `${h}h ${m}m ago`;
  } catch (e) {
    return "";
  }
}

// ── Click handler — step 1: open the password gate ─────────────────────────
function handleRevertCheckoutClick(event, roomNumber) {
  if (event && event.stopPropagation) event.stopPropagation();
  if (event && event.preventDefault)  event.preventDefault();

  const roomInfo = (typeof rooms !== "undefined" && rooms) ? rooms[roomNumber] : null;
  if (!roomInfo) return;
  if (!isRevertEligible(roomInfo)) {
    if (typeof showNotification === "function") {
      showNotification("Revert window has expired (3-hour limit).", "info");
    }
    return;
  }

  // Use the existing manager password modal for consistency. After it
  // verifies the password server-side and fires our callback, we read the
  // typed value out of the modal's input (still in the DOM at that point,
  // closeMgrAccessModal does not clear it) and stash it in a closure for
  // the second step.
  if (typeof openMgrAccessModal !== "function") {
    // Defensive fallback — should never trigger in production.
    alert("Manager auth modal unavailable. Reload the page and try again.");
    return;
  }

  openMgrAccessModal(
    "Revert checkout",
    `Authorise the revert for Room ${roomNumber}.`,
    "fa-undo",
    function () {
      const pwdEl = document.getElementById("mgr-access-pwd");
      const pwd   = pwdEl ? (pwdEl.value || "").trim() : "";
      // Defensive: if for some reason the input was cleared between verify
      // and callback, fall back to re-prompting in the second modal.
      openRevertConfirmModal(roomNumber, roomInfo, pwd);
    }
  );
}

// ── Step 2: redesigned reason / confirm modal ──────────────────────────────

let _revertCachedPassword = null;
let _revertPasswordTimer  = null;

function _clearCachedRevertPassword() {
  _revertCachedPassword = null;
  if (_revertPasswordTimer) {
    clearTimeout(_revertPasswordTimer);
    _revertPasswordTimer = null;
  }
}

function ensureRevertConfirmModal() {
  if (document.getElementById("revert-confirm-modal")) return;

  const style = document.createElement("style");
  style.id = "revert-confirm-modal-style";
  style.textContent = `

    /* ── Modal shell ─────────────────────────────────────────────────────── */
    #revert-confirm-modal {
      display: none; position: fixed; inset: 0; z-index: 10000;
      background: rgba(15, 23, 42, 0.45);
      align-items: center; justify-content: center;
      animation: rcFadeIn 0.15s ease-out;
      font-family: inherit;
    }
    #revert-confirm-modal.show { display: flex; }
    @keyframes rcFadeIn { from { opacity: 0; } to { opacity: 1; } }

    .rc-card {
      background: #ffffff;
      border-radius: 12px;
      width: 92%;
      max-width: 440px;
      box-shadow: 0 20px 50px rgba(15, 23, 42, 0.18),
                  0 4px 12px rgba(15, 23, 42, 0.08);
      overflow: hidden;
      animation: rcSlideUp 0.18s ease-out;
    }
    @keyframes rcSlideUp {
      from { transform: translateY(8px); opacity: 0.6; }
      to   { transform: translateY(0);   opacity: 1; }
    }

    /* ── Header ──────────────────────────────────────────────────────────── */
    .rc-header {
      display: flex; align-items: center; gap: 12px;
      padding: 16px 20px;
      border-bottom: 1px solid #f1f5f9;
    }
    .rc-header-icon {
      width: 36px; height: 36px;
      display: inline-flex; align-items: center; justify-content: center;
      background: #f1f5f9; color: #0f172a;
      border-radius: 8px; font-size: 14px;
    }
    .rc-header-text h3 {
      margin: 0; font-size: 1.0rem; font-weight: 600;
      color: #0f172a; letter-spacing: -0.01em;
    }
    .rc-header-text .rc-sub {
      margin: 2px 0 0; font-size: 0.78rem; color: #64748b;
    }

    /* ── Context block ───────────────────────────────────────────────────── */
    .rc-context {
      padding: 14px 20px;
      background: #fafbfc;
      border-bottom: 1px solid #f1f5f9;
    }
    .rc-context-row {
      display: flex; justify-content: space-between; align-items: baseline;
      gap: 12px; padding: 3px 0;
      font-size: 0.85rem;
    }
    .rc-context-row .rc-k {
      color: #64748b; font-weight: 500;
    }
    .rc-context-row .rc-v {
      color: #0f172a; font-weight: 600;
      text-align: right; word-break: break-word;
    }
    .rc-window-pill {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 2px 8px;
      background: #ecfdf5; color: #047857;
      border: 1px solid #a7f3d0;
      border-radius: 999px;
      font-size: 0.72rem; font-weight: 600;
    }
    .rc-window-pill.warn {
      background: #fff7ed; color: #c2410c; border-color: #fed7aa;
    }

    /* ── Body / form ─────────────────────────────────────────────────────── */
    .rc-body { padding: 16px 20px 8px; }
    .rc-body label {
      display: block; font-size: 0.78rem; color: #475569;
      margin: 0 0 6px; font-weight: 600; letter-spacing: 0.01em;
    }
    .rc-body textarea {
      width: 100%; box-sizing: border-box;
      padding: 9px 11px;
      font-size: 0.88rem; font-family: inherit;
      color: #0f172a;
      border: 1px solid #e2e8f0; border-radius: 8px;
      background: #ffffff;
      resize: vertical; min-height: 64px;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    .rc-body textarea:focus {
      outline: none;
      border-color: #94a3b8;
      box-shadow: 0 0 0 3px rgba(148, 163, 184, 0.18);
    }
    .rc-body textarea::placeholder { color: #94a3b8; }

    .rc-error {
      color: #b91c1c; font-size: 0.8rem;
      margin-top: 8px; min-height: 1em;
    }

    /* ── Footer / actions ────────────────────────────────────────────────── */
    .rc-actions {
      display: flex; justify-content: flex-end; gap: 8px;
      padding: 14px 20px 18px;
    }
    .rc-btn {
      padding: 8px 16px;
      font-size: 0.85rem; font-weight: 600; font-family: inherit;
      border-radius: 8px; cursor: pointer;
      border: 1px solid transparent;
      transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
    }
    .rc-cancel {
      background: #ffffff; color: #475569; border-color: #e2e8f0;
    }
    .rc-cancel:hover { background: #f8fafc; border-color: #cbd5e1; }
    .rc-confirm {
      background: #0f172a; color: #ffffff;
    }
    .rc-confirm:hover:not(:disabled) { background: #1e293b; }
    .rc-confirm:disabled { opacity: 0.6; cursor: wait; }
  `;
  document.head.appendChild(style);

  const modal = document.createElement("div");
  modal.id = "revert-confirm-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.innerHTML = `
    <div class="rc-card" role="document">
      <div class="rc-header">
        <div class="rc-header-icon"><i class="fas fa-undo"></i></div>
        <div class="rc-header-text">
          <h3>Revert checkout</h3>
          <p class="rc-sub">Restore the room to its pre-checkout state.</p>
        </div>
      </div>

      <div class="rc-context">
        <div class="rc-context-row">
          <span class="rc-k">Room</span>
          <span class="rc-v" id="rc-ctx-room">—</span>
        </div>
        <div class="rc-context-row">
          <span class="rc-k">Guest</span>
          <span class="rc-v" id="rc-ctx-guest">—</span>
        </div>
        <div class="rc-context-row">
          <span class="rc-k">Checked out</span>
          <span class="rc-v" id="rc-ctx-when">—</span>
        </div>
        <div class="rc-context-row">
          <span class="rc-k">Window</span>
          <span class="rc-v"><span class="rc-window-pill" id="rc-ctx-window">—</span></span>
        </div>
      </div>

      <div class="rc-body">
        <label for="rc-reason">Reason</label>
        <textarea id="rc-reason"
                  placeholder="e.g. Wrong room — guest was still staying"></textarea>
        <div class="rc-error" id="rc-error"></div>
      </div>

      <div class="rc-actions">
        <button class="rc-btn rc-cancel"  id="rc-cancel-btn"  type="button">Cancel</button>
        <button class="rc-btn rc-confirm" id="rc-confirm-btn" type="button">Revert checkout</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  document.getElementById("rc-cancel-btn").addEventListener("click", closeRevertConfirmModal);
  document.getElementById("rc-confirm-btn").addEventListener("click", submitRevertCheckout);
  modal.addEventListener("click", function (e) {
    if (e.target === modal) closeRevertConfirmModal();
  });
  // Esc to close
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && modal.classList.contains("show")) {
      closeRevertConfirmModal();
    }
  });
}

let _revertTargetRoom   = null;
let _revertTargetStayId = null;

function openRevertConfirmModal(roomNumber, roomInfo, password) {
  ensureRevertConfirmModal();

  _revertTargetRoom   = roomNumber;
  _revertTargetStayId = roomInfo.last_bill_id;
  _revertCachedPassword = password || null;

  // Auto-clear the cached password after 60s as a safety net.
  if (_revertPasswordTimer) clearTimeout(_revertPasswordTimer);
  _revertPasswordTimer = setTimeout(_clearCachedRevertPassword, 60 * 1000);

  // Populate context block
  const ctxRoom   = document.getElementById("rc-ctx-room");
  const ctxGuest  = document.getElementById("rc-ctx-guest");
  const ctxWhen   = document.getElementById("rc-ctx-when");
  const ctxWindow = document.getElementById("rc-ctx-window");

  if (ctxRoom)  ctxRoom.textContent  = roomNumber;
  // Guest name is no longer on the room (cleared at checkout). We don't
  // fetch the bill from here to keep the modal snappy; show "—" so the
  // row layout stays consistent. The audit log on the server has the
  // guest details if anyone needs to look them up.
  if (ctxGuest) ctxGuest.textContent = (roomInfo.guest && roomInfo.guest.name) || "—";
  if (ctxWhen)  ctxWhen.textContent  = formatTimeSinceCheckout(roomInfo);
  if (ctxWindow) {
    ctxWindow.textContent = formatRevertTimeLeft(roomInfo);
    // Warn-color the pill once we're inside the last 30 minutes.
    try {
      const ts = new Date(roomInfo.last_checkout_at).getTime();
      const remainingMs = REVERT_CHECKOUT_WINDOW_MS - (Date.now() - ts);
      ctxWindow.classList.toggle("warn", remainingMs <= 30 * 60 * 1000);
    } catch (e) { /* noop */ }
  }

  const reasonEl = document.getElementById("rc-reason");
  const errEl    = document.getElementById("rc-error");
  const btn      = document.getElementById("rc-confirm-btn");
  if (reasonEl) reasonEl.value = "";
  if (errEl)    errEl.textContent = "";
  if (btn)      { btn.disabled = false; btn.textContent = "Revert checkout"; }

  document.getElementById("revert-confirm-modal").classList.add("show");
  setTimeout(() => { if (reasonEl) reasonEl.focus(); }, 100);
}

function closeRevertConfirmModal() {
  const modal = document.getElementById("revert-confirm-modal");
  if (modal) modal.classList.remove("show");
  _revertTargetRoom = null;
  _revertTargetStayId = null;
  _clearCachedRevertPassword();
}

async function submitRevertCheckout() {
  const reasonEl = document.getElementById("rc-reason");
  const errEl    = document.getElementById("rc-error");
  const btn      = document.getElementById("rc-confirm-btn");

  const reason = (reasonEl && reasonEl.value || "").trim();

  if (!reason) {
    if (errEl) errEl.textContent = "Please enter a reason.";
    return;
  }
  if (!_revertTargetStayId) {
    if (errEl) errEl.textContent = "Missing stay reference — close and try again.";
    return;
  }
  // Password gate removed — RBAC (booking.revert permission) is now the
  // sole authorisation check; backend re-verifies via @requires_permission.
  // The legacy _revertCachedPassword is kept for the body field below for
  // backwards compatibility but the backend ignores it.

  if (errEl) errEl.textContent = "";
  if (btn)   {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin" style="margin-right:6px"></i>Reverting…';
  }

  try {
    const fetchFn = (typeof apiFetch === "function") ? apiFetch : fetch;
    const res = await fetchFn("/revert_checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stay_id:  _revertTargetStayId,
        password: _revertCachedPassword,
        reason:   reason,
      }),
    });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }

    if (!res.ok) {
      const msg = (data && data.message) || `Server returned ${res.status}`;
      if (errEl) errEl.textContent = msg;
      if (btn)   { btn.disabled = false; btn.innerHTML = '<i class="fas fa-undo" style="margin-right:6px"></i>Revert checkout'; }
      return;
    }
    if (!data || !data.success) {
      const msg = (data && data.message) || "Revert failed.";
      if (errEl) errEl.textContent = msg;
      if (btn)   { btn.disabled = false; btn.innerHTML = '<i class="fas fa-undo" style="margin-right:6px"></i>Revert checkout'; }
      return;
    }

    closeRevertConfirmModal();
    _clearCachedRevertPassword();
    if (typeof showNotification === "function") {
      const cnNote = data.credit_note_number ? ` (Credit Note ${data.credit_note_number} issued)` : "";
      showNotification(`Checkout reverted for Room ${data.room || ""}${cnNote}.`, "success");
    }
    // Reload room data so the UI reflects the restored stay.
    if (typeof fetchData === "function") fetchData();
    else if (typeof loadInitialData === "function") loadInitialData();

  } catch (err) {
    if (errEl) errEl.textContent = "Network error: " + (err && err.message || err);
    if (btn)   { btn.disabled = false; btn.innerHTML = '<i class="fas fa-undo" style="margin-right:6px"></i>Revert checkout'; }
  }
}

// Expose globally for the inline onclicks in the rendered modal.
window.handleRevertCheckoutClick = handleRevertCheckoutClick;
window.submitRevertCheckout      = submitRevertCheckout;
window.closeRevertConfirmModal   = closeRevertConfirmModal;
