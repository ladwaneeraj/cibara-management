// Room Cleaning Status Management with Quality Check

// Initialize cleaning feature on page load
function initializeCleaningFeature() {
  console.log("Cleaning feature initialized");
  createQualityCheckModals();
  addQualityCheckStyles();   // inject once at init, not on first open
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

// Create quality check modals (only created once)
function createQualityCheckModals() {
  // Premium room modal (3 items for 200-206)
  createPremiumCheckModal();
  // Standard room modal (3 items for 207-228)
  createStandardCheckModal();
  // Regular room modal (1 item for others)
  createRegularCheckModal();
}

// Create premium room quality check modal (3 items for rooms 200-206)
function createPremiumCheckModal() {
  if (document.getElementById("premium-check-modal")) {
    return;
  }

  const modalHTML = `
    <div class="modal-backdrop" id="premium-check-modal">
      <div class="modal-content" style="max-width: 400px;">
        <div class="modal-header" style="padding: 1rem 1.5rem;">
          <h2 style="font-size: 1.1rem;">Room <span id="premium-room-number"></span> - Quality Check</h2>
          <button class="close-btn" aria-label="Close">&times;</button>
        </div>
        <div class="modal-body" style="padding: 1rem 1.5rem;">
          <div class="quality-checklist">
            <label class="quality-check-item compact">
              <input type="checkbox" class="quality-checkbox premium-checkbox">
              <span class="checkmark"></span>
              <span class="check-label">🚿 Washroom is clean</span>
            </label>
            
            <label class="quality-check-item compact">
              <input type="checkbox" class="quality-checkbox premium-checkbox">
              <span class="checkmark"></span>
              <span class="check-label">☕ Coffee maker ready</span>
            </label>
            
            <label class="quality-check-item compact">
              <input type="checkbox" class="quality-checkbox premium-checkbox">
              <span class="checkmark"></span>
              <span class="check-label">🧺 Towels placed (3 sets)</span>
            </label>
          </div>
        </div>
        <div class="modal-footer" style="padding: 1rem 1.5rem; gap: 0.5rem;">
          <button class="premium-cancel-btn action-btn btn-secondary" style="flex: 1;">
            Cancel
          </button>
          <button id="premium-approve-btn" class="action-btn btn-success" style="flex: 1;" disabled>
            Mark as Clean ✓
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML("beforeend", modalHTML);
  setupPremiumModalListeners();
}

// Create standard room quality check modal (3 items for rooms 207-228)
function createStandardCheckModal() {
  if (document.getElementById("standard-check-modal")) {
    return;
  }

  const modalHTML = `
    <div class="modal-backdrop" id="standard-check-modal">
      <div class="modal-content" style="max-width: 400px;">
        <div class="modal-header" style="padding: 1rem 1.5rem;">
          <h2 style="font-size: 1.1rem;">Room <span id="standard-room-number"></span> - Quality Check</h2>
          <button class="close-btn" aria-label="Close">&times;</button>
        </div>
        <div class="modal-body" style="padding: 1rem 1.5rem;">
          <div class="quality-checklist">
            <label class="quality-check-item compact">
              <input type="checkbox" class="quality-checkbox standard-checkbox">
              <span class="checkmark"></span>
              <span class="check-label">🚿 Washroom is clean</span>
            </label>
            
            <label class="quality-check-item compact">
              <input type="checkbox" class="quality-checkbox standard-checkbox">
              <span class="checkmark"></span>
              <span class="check-label">🗑️ Dustbin cleaned</span>
            </label>
            
            <label class="quality-check-item compact">
              <input type="checkbox" class="quality-checkbox standard-checkbox">
              <span class="checkmark"></span>
              <span class="check-label">🧺 Towels placed</span>
            </label>
          </div>
        </div>
        <div class="modal-footer" style="padding: 1rem 1.5rem; gap: 0.5rem;">
          <button class="standard-cancel-btn action-btn btn-secondary" style="flex: 1;">
            Cancel
          </button>
          <button id="standard-approve-btn" class="action-btn btn-success" style="flex: 1;" disabled>
            Mark as Clean ✓
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML("beforeend", modalHTML);
  setupStandardModalListeners();
}

// Create regular room quick check modal (1 item for other rooms)
function createRegularCheckModal() {
  if (document.getElementById("regular-check-modal")) {
    return;
  }

  const modalHTML = `
    <div class="modal-backdrop" id="regular-check-modal">
      <div class="modal-content" style="max-width: 380px;">
        <div class="modal-header" style="padding: 1rem 1.5rem;">
          <h2 style="font-size: 1.1rem;">Room <span id="regular-room-number"></span> - Quick Check</h2>
          <button class="close-btn" aria-label="Close">&times;</button>
        </div>
        <div class="modal-body" style="padding: 1rem 1.5rem;">
          <div class="quality-checklist">
            <label class="quality-check-item compact">
              <input type="checkbox" id="regular-checkbox" class="quality-checkbox">
              <span class="checkmark"></span>
              <span class="check-label">✨ Room is cleaned and ready</span>
            </label>
          </div>
        </div>
        <div class="modal-footer" style="padding: 1rem 1.5rem; gap: 0.5rem;">
          <button class="regular-cancel-btn action-btn btn-secondary" style="flex: 1;">
            Cancel
          </button>
          <button id="regular-approve-btn" class="action-btn btn-success" style="flex: 1;" disabled>
            Mark as Clean ✓
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML("beforeend", modalHTML);
  setupRegularModalListeners();
}

// Add CSS for compact quality check modals
function addQualityCheckStyles() {
  if (document.getElementById("quality-check-styles")) {
    return;
  }

  const style = document.createElement("style");
  style.id = "quality-check-styles";
  style.textContent = `
    /* QC modals open instantly — skip the generic 0.3s backdrop fade */
    #premium-check-modal, #standard-check-modal, #regular-check-modal {
      transition: none;
    }
    #premium-check-modal .modal-content,
    #standard-check-modal .modal-content,
    #regular-check-modal .modal-content {
      transition: none;
      animation: none;
    }
    .cleaned-btn { touch-action: manipulation; }

    .quality-checklist {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    
    .quality-check-item {
      display: flex;
      align-items: center;
      padding: 0.75rem 1rem;
      border: 2px solid #e0e0e0;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s ease;
      position: relative;
    }
    
    .quality-check-item.compact {
      padding: 0.6rem 0.85rem;
    }
    
    .quality-check-item:hover {
      border-color: var(--primary);
      background-color: #f8f9fa;
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
      transition: all 0.2s ease;
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
      color: var(--text);
      transition: all 0.2s ease;
    }
    
    #premium-approve-btn:disabled,
    #regular-approve-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      background-color: #ccc;
    }
    
    #premium-approve-btn:not(:disabled),
    #regular-approve-btn:not(:disabled) {
      background-color: var(--success);
    }
    
    #premium-approve-btn:not(:disabled):hover,
    #regular-approve-btn:not(:disabled):hover {
      background-color: #27ae60;
    }
  `;
  document.head.appendChild(style);
}

// Setup premium modal listeners
function setupPremiumModalListeners() {
  const modal = document.getElementById("premium-check-modal");
  const closeBtn = modal.querySelector(".close-btn");
  const cancelBtn = modal.querySelector(".premium-cancel-btn");
  const approveBtn = document.getElementById("premium-approve-btn");
  const checkboxes = modal.querySelectorAll(".premium-checkbox");

  // Close modal handlers
  const closeModal = () => {
    modal.classList.remove("show");
    resetPremiumModal();
  };

  closeBtn.addEventListener("click", closeModal);
  cancelBtn.addEventListener("click", closeModal);

  // Update button state when checkboxes change
  checkboxes.forEach((checkbox) => {
    checkbox.addEventListener("change", updatePremiumButton);
  });

  // Approve button click
  approveBtn.addEventListener("click", async () => {
    const roomNumber = document.getElementById(
      "premium-room-number",
    ).textContent;
    approveBtn.disabled = true;   // no double-fire while request is in flight
    try { await completeRoomCleaning(roomNumber); }
    finally { approveBtn.disabled = false; }
  });
}

// Setup standard modal listeners
function setupStandardModalListeners() {
  const modal = document.getElementById("standard-check-modal");
  const closeBtn = modal.querySelector(".close-btn");
  const cancelBtn = modal.querySelector(".standard-cancel-btn");
  const approveBtn = document.getElementById("standard-approve-btn");
  const checkboxes = modal.querySelectorAll(".standard-checkbox");

  // Close modal handlers
  const closeModal = () => {
    modal.classList.remove("show");
    resetStandardModal();
  };

  closeBtn.addEventListener("click", closeModal);
  cancelBtn.addEventListener("click", closeModal);

  // Update button state when checkboxes change
  checkboxes.forEach((checkbox) => {
    checkbox.addEventListener("change", updateStandardButton);
  });

  // Approve button click
  approveBtn.addEventListener("click", async () => {
    const roomNumber = document.getElementById(
      "standard-room-number",
    ).textContent;
    approveBtn.disabled = true;   // no double-fire while request is in flight
    try { await completeRoomCleaning(roomNumber); }
    finally { approveBtn.disabled = false; }
  });
}

// Setup regular modal listeners
function setupRegularModalListeners() {
  const modal = document.getElementById("regular-check-modal");
  const closeBtn = modal.querySelector(".close-btn");
  const cancelBtn = modal.querySelector(".regular-cancel-btn");
  const approveBtn = document.getElementById("regular-approve-btn");
  const checkbox = document.getElementById("regular-checkbox");

  // Close modal handlers
  const closeModal = () => {
    modal.classList.remove("show");
    resetRegularModal();
  };

  closeBtn.addEventListener("click", closeModal);
  cancelBtn.addEventListener("click", closeModal);

  // Update button state when checkbox changes
  checkbox.addEventListener("change", updateRegularButton);

  // Approve button click
  approveBtn.addEventListener("click", async () => {
    const roomNumber = document.getElementById(
      "regular-room-number",
    ).textContent;
    approveBtn.disabled = true;   // no double-fire while request is in flight
    try { await completeRoomCleaning(roomNumber); }
    finally { approveBtn.disabled = false; }
  });
}

// Update premium modal button state
function updatePremiumButton() {
  const checkboxes = document.querySelectorAll(".premium-checkbox");
  const checkedCount = Array.from(checkboxes).filter((cb) => cb.checked).length;
  const approveBtn = document.getElementById("premium-approve-btn");

  if (approveBtn) {
    approveBtn.disabled = checkedCount !== checkboxes.length;
  }
}

// Update standard modal button state
function updateStandardButton() {
  const checkboxes = document.querySelectorAll(".standard-checkbox");
  const checkedCount = Array.from(checkboxes).filter((cb) => cb.checked).length;
  const approveBtn = document.getElementById("standard-approve-btn");

  if (approveBtn) {
    approveBtn.disabled = checkedCount !== checkboxes.length;
  }
}

// Update regular modal button state
function updateRegularButton() {
  const checkbox = document.getElementById("regular-checkbox");
  const approveBtn = document.getElementById("regular-approve-btn");

  if (approveBtn && checkbox) {
    approveBtn.disabled = !checkbox.checked;
  }
}

// Reset premium modal
function resetPremiumModal() {
  const checkboxes = document.querySelectorAll(".premium-checkbox");
  checkboxes.forEach((cb) => {
    cb.checked = false;
  });
  updatePremiumButton();
}

// Reset standard modal
function resetStandardModal() {
  const checkboxes = document.querySelectorAll(".standard-checkbox");
  checkboxes.forEach((cb) => {
    cb.checked = false;
  });
  updateStandardButton();
}

// Reset regular modal
function resetRegularModal() {
  const checkbox = document.getElementById("regular-checkbox");
  if (checkbox) {
    checkbox.checked = false;
  }
  updateRegularButton();
}

// Show premium quality check modal
function showPremiumCheckModal(roomNumber) {
  addQualityCheckStyles();
  const modal = document.getElementById("premium-check-modal");
  const roomNumberSpan = document.getElementById("premium-room-number");

  if (!modal || !roomNumberSpan) {
    console.error("Premium check modal elements not found");
    return;
  }

  roomNumberSpan.textContent = roomNumber;
  resetPremiumModal();
  modal.classList.add("show");
}

// Show standard quality check modal
function showStandardCheckModal(roomNumber) {
  addQualityCheckStyles();
  const modal = document.getElementById("standard-check-modal");
  const roomNumberSpan = document.getElementById("standard-room-number");

  if (!modal || !roomNumberSpan) {
    console.error("Standard check modal elements not found");
    return;
  }

  roomNumberSpan.textContent = roomNumber;
  resetStandardModal();
  modal.classList.add("show");
}

// Show regular quick check modal
function showRegularCheckModal(roomNumber) {
  addQualityCheckStyles();
  const modal = document.getElementById("regular-check-modal");
  const roomNumberSpan = document.getElementById("regular-room-number");

  if (!modal || !roomNumberSpan) {
    console.error("Regular check modal elements not found");
    return;
  }

  roomNumberSpan.textContent = roomNumber;
  resetRegularModal();
  modal.classList.add("show");
}

// Check if room is premium (requires quality check)
function isPremiumRoom(roomNumber) {
  const num = parseInt(roomNumber);
  return num >= 200 && num <= 206;
}

// Check if room is standard (requires 3-item check)
function isStandardRoom(roomNumber) {
  const num = parseInt(roomNumber);
  return num >= 207 && num <= 228;
}

// Mark room as cleaned - shows appropriate modal based on room type
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

    // For premium rooms (200-206), show 3-item quality check modal
    if (isPremiumRoom(roomNumber)) {
      showPremiumCheckModal(roomNumber);
      return false; // Don't mark as cleaned yet, wait for quality check
    }

    // For standard rooms (207-228), show 3-item standard check modal
    if (isStandardRoom(roomNumber)) {
      showStandardCheckModal(roomNumber);
      return false; // Don't mark as cleaned yet, wait for quality check
    }

    // For regular rooms, show 1-item quick check modal
    showRegularCheckModal(roomNumber);
    return false; // Don't mark as cleaned yet, wait for confirmation
  } catch (error) {
    console.error("Error marking room as cleaned:", error);
    showNotification("Error marking room as cleaned", "error");
    return false;
  }
}

// Complete room cleaning (called after quality check confirmation).
//
// Routing by role (RBAC):
//   • Housekeeping → POST /mark_room_cleaned
//       Sets cleaning_status="ready_to_inspect" (the room stays in
//       status="cleaning" until an admin/manager approves it).
//   • Admin / Manager → POST /mark_room_ready_for_checkin
//       Skips the inspection wait and clears the room to vacant in one
//       step. Works whether the room is currently in_progress or
//       ready_to_inspect.
//
// In-flight guard: a double-tap on the QC approve button used to fire two
// racing requests, producing duplicate audit entries (rooms then showed up
// twice in Daily Insights). Repeat calls for the same room are ignored
// until the first request settles. The server also rejects the loser via
// a transactional claim — this guard just avoids the wasted round-trip.
var _cleaningInflight = {};

async function completeRoomCleaning(roomNumber) {
  if (_cleaningInflight[roomNumber]) return false;
  _cleaningInflight[roomNumber] = true;
  try {
    return await _completeRoomCleaningInner(roomNumber);
  } finally {
    delete _cleaningInflight[roomNumber];
  }
}

async function _completeRoomCleaningInner(roomNumber) {
  try {
    const _auth = window.CibaraAuth;
    const _canApprove = _auth && _auth.userCan && _auth.userCan("room.inspection.approve");
    const endpoint = _canApprove
      ? "/mark_room_ready_for_checkin"
      : "/mark_room_cleaned";

    const response = await apiFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        room: roomNumber,
      }),
    });

    if (!response.ok) {
      throw new Error(`Server responded with status: ${response.status}`);
    }

    const result = await response.json();
    if (result.success) {
      // Update local room data so the card re-renders with the right
      // state immediately (the next /get_data fetch will confirm).
      const roomInfo = rooms[roomNumber];
      if (roomInfo) {
        if (_canApprove) {
          // Admin/manager approved: room is now vacant
          roomInfo.status = "vacant";
          roomInfo.cleaning_status = null;
          roomInfo.cleaning_start_time = null;
        } else {
          // Housekeeping done: stays in cleaning, but flagged for inspection
          roomInfo.cleaning_status = "ready_to_inspect";
        }
      }

      // Close all modals if they're open
      const premiumModal = document.getElementById("premium-check-modal");
      const standardModal = document.getElementById("standard-check-modal");
      const regularModal = document.getElementById("regular-check-modal");

      if (premiumModal) {
        premiumModal.classList.remove("show");
      }
      if (standardModal) {
        standardModal.classList.remove("show");
      }
      if (regularModal) {
        regularModal.classList.remove("show");
      }

      showNotification(
        _canApprove
          ? `Room ${roomNumber} is ready for check-in`
          : `Room ${roomNumber} cleaned. Awaiting inspection.`,
        "success",
      );

      // Refresh the rooms display
      renderRooms();

      console.log(`Room ${roomNumber} ${_canApprove ? "approved ready" : "marked cleaned"} successfully`);
      return true;
    } else {
      showNotification(
        result.message || "Error marking room as cleaned",
        "error",
      );
      return false;
    }
  } catch (error) {
    console.error("Error completing room cleaning:", error);
    showNotification("Error marking room as cleaned", "error");
    return false;
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
