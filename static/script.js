// ── Disable mouse-wheel value change on number inputs ────────────────────────
// Browser default for <input type="number">: when the input is focused and
// the user scrolls over it, the value increments/decrements. This causes
// silent edits to amounts (rent, payment, GST, etc.) when the user means to
// scroll the page. We block the default only when the wheel event is fired
// directly on a focused number input — page scrolling and arrow-key changes
// are unaffected. A single document-level listener covers every number
// input currently in the DOM and any rendered later (including dynamically-
// generated ones in bills.js, register.js, laundry.js, etc.).
//
// passive:false is required because preventDefault() is a no-op on the
// default-passive wheel listener.
document.addEventListener(
  "wheel",
  function (e) {
    const t = e.target;
    if (
      t &&
      t.tagName === "INPUT" &&
      t.type === "number" &&
      document.activeElement === t
    ) {
      e.preventDefault();
    }
  },
  { passive: false },
);

// Global variables
let rooms = {};
let dailyCounters = {}; // today's check-in serial counter, keyed by date string
// Upcoming bookings map: roomNumber (string) → booking info object
let upcomingBookings = {};

// Keep logs and totals variables as they're used throughout the app
let logs = {
  cash: [],
  online: [],
  balance: [],
  add_ons: [],
  refunds: [],
  renewals: [],
  expenses: [], // Added expenses array
  discounts: [], // Added discounts array
};
let totals = { cash: 0, online: 0, balance: 0, refunds: 0 };
let activePaymentMethod = "cash";
let currentFilter = "all";
let searchTerm = "";
let capturedPhotoData = null; // For storing camera photo
let uploadedPhotoUrl = null; // For storing uploaded photo URL
let mediaStream = null; // For camera access
let selectedService = null; // For tracking selected service
let servicePaymentMethod = "cash"; // Default payment method for services
let isAccommodationCharge = false; // Whether the selected service is an accommodation charge (AC/Extra Bed)

// DOM Elements - with null checks
const roomsGrid = document.getElementById("rooms-grid");
const vacantCount = document.getElementById("vacant-count");
const occupiedCount = document.getElementById("occupied-count");
const pendingBalance = document.getElementById("pending-balance");
const todayRevenue = document.getElementById("today-revenue");
const cashTotal = document.getElementById("cash-total");
const onlineTotal = document.getElementById("online-total");
const refundTotal = document.getElementById("refund-total");
const totalRevenue = document.getElementById("total-revenue");
const transactionLog = document.getElementById("transaction-log");
const roomSearch = document.getElementById("room-search");
const refreshBtn = document.getElementById("refresh-btn");
const settingsBtn = document.getElementById("settings-btn");
const fullscreenBtn = document.getElementById("fullscreen-btn");
const paymentOrRefundSection = document.getElementById(
  "payment-or-refund-section",
);
const notificationContainer = document.getElementById("notification-container");

// Initialize modals
const checkinModal = document.getElementById("checkin-modal");
const checkoutModal = document.getElementById("checkout-modal");
const editTimeModal = document.getElementById("edit-time-modal");
const rentRenewalModal = document.getElementById("rent-renewal-modal");
const roomDetailsModal = document.getElementById("room-details-modal");
const addRoomModal = document.getElementById("add-room-modal");

// Service form elements
const serviceForm = document.getElementById("service-form");
const serviceName = document.getElementById("service-name");
const servicePrice = document.getElementById("service-price");
const servicePaymentMethodInput = document.getElementById(
  "service-payment-method",
);

// Camera functionality
function initCamera() {
  const cameraBtn = document.getElementById("camera-btn");
  const cameraContainer = document.getElementById("camera-container");
  const cameraFeed = document.getElementById("camera-feed");
  const captureBtn = document.getElementById("capture-photo-btn");
  const cancelCameraBtn = document.getElementById("cancel-camera-btn");
  const photoPreviewContainer = document.getElementById(
    "photo-preview-container",
  );
  const photoPreview = document.getElementById("photo-preview");
  const retakePhotoBtn = document.getElementById("retake-photo-btn");
  const fileInput = document.getElementById("guest-photo");

  if (!cameraBtn || !fileInput) {
    debugLog("Camera elements not found");
    return;
  }

  // File input change event
  fileInput.addEventListener("change", function (event) {
    const file = event.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = function (e) {
        if (photoPreview && photoPreviewContainer) {
          photoPreview.src = e.target.result;
          photoPreviewContainer.style.display = "block";
          capturedPhotoData = e.target.result;
        }

        // Upload the photo to server
        uploadPhoto(file);
      };
      reader.readAsDataURL(file);
    }
  });

  // Camera button click event
  cameraBtn.addEventListener("click", async function () {
    try {
      // Close camera first if it's already open
      if (mediaStream) {
        mediaStream.getTracks().forEach((track) => track.stop());
      }

      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      });

      if (cameraFeed && cameraContainer) {
        cameraFeed.srcObject = mediaStream;
        cameraContainer.style.display = "block";
        if (photoPreviewContainer) {
          photoPreviewContainer.style.display = "none";
        }
      }
    } catch (error) {
      console.error("Error accessing camera:", error);
      showNotification(
        "Error accessing camera. Please check permissions.",
        "error",
      );
    }
  });

  // Capture photo button click event
  if (captureBtn) {
    captureBtn.addEventListener("click", function () {
      if (!cameraFeed) {
        debugLog("Camera feed element not found");
        return;
      }

      const canvas = document.createElement("canvas");
      canvas.width = cameraFeed.videoWidth;
      canvas.height = cameraFeed.videoHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(cameraFeed, 0, 0, canvas.width, canvas.height);

      capturedPhotoData = canvas.toDataURL("image/jpeg");

      if (photoPreview && photoPreviewContainer && cameraContainer) {
        photoPreview.src = capturedPhotoData;
        photoPreviewContainer.style.display = "block";
        cameraContainer.style.display = "none";
      }

      // Convert data URL to Blob
      const byteString = atob(capturedPhotoData.split(",")[1]);
      const mimeString = capturedPhotoData
        .split(",")[0]
        .split(":")[1]
        .split(";")[0];
      const ab = new ArrayBuffer(byteString.length);
      const ia = new Uint8Array(ab);
      for (let i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i);
      }
      const blob = new Blob([ab], { type: mimeString });

      // Create a File from the Blob
      const file = new File([blob], "camera-capture.jpg", {
        type: "image/jpeg",
      });

      // Upload the photo
      uploadPhoto(file);

      // Stop camera stream
      if (mediaStream) {
        mediaStream.getTracks().forEach((track) => track.stop());
        mediaStream = null;
      }
    });
  }

  // Cancel camera button click event
  if (cancelCameraBtn) {
    cancelCameraBtn.addEventListener("click", function () {
      if (cameraContainer) {
        cameraContainer.style.display = "none";
      }

      // Stop camera stream
      if (mediaStream) {
        mediaStream.getTracks().forEach((track) => track.stop());
        mediaStream = null;
      }
    });
  }

  // Retake photo button click event
  if (retakePhotoBtn) {
    retakePhotoBtn.addEventListener("click", function () {
      if (photoPreviewContainer) {
        photoPreviewContainer.style.display = "none";
      }
      capturedPhotoData = null;
      uploadedPhotoUrl = null;

      // Clear file input
      if (fileInput) {
        fileInput.value = "";
      }
    });
  }
}

// Debug log function
function debugLog(message) {
  console.log("[DEBUG] " + message);
}

// Notification system
function showNotification(message, type = "info", duration = 5000) {
  if (!notificationContainer) {
    debugLog("Notification container not found");
    console.error(message);
    return null;
  }

  const notification = document.createElement("div");
  notification.className = `notification ${type}`;

  // Create icon based on notification type
  let icon = "";
  switch (type) {
    case "success":
      icon = '<i class="fas fa-check-circle"></i>';
      break;
    case "error":
      icon = '<i class="fas fa-exclamation-circle"></i>';
      break;
    case "warning":
      icon = '<i class="fas fa-exclamation-triangle"></i>';
      break;
    default:
      icon = '<i class="fas fa-info-circle"></i>';
  }

  notification.innerHTML = `
    <div class="notification-icon">${icon}</div>
    <div class="notification-content">
      <div class="notification-message">${message}</div>
    </div>
    <button class="notification-dismiss">&times;</button>
    <div class="notification-progress">
      <div class="notification-progress-bar"></div>
    </div>
  `;

  // Add notification to container
  notificationContainer.appendChild(notification);

  // Set up dismiss button
  const dismissBtn = notification.querySelector(".notification-dismiss");
  dismissBtn.addEventListener("click", () => {
    closeNotification(notification);
  });

  // Auto-close after duration
  setTimeout(() => {
    closeNotification(notification);
  }, duration);

  return notification;
}

function closeNotification(notification) {
  if (!notificationContainer) return;
  if (!notification || !notification.classList) return;

  if (!notification.classList.contains("closing")) {
    notification.classList.add("closing");
    setTimeout(() => {
      if (notificationContainer.contains(notification)) {
        notificationContainer.removeChild(notification);
      }
    }, 300);
  }
}

// Function to render room cards

function renderRooms() {
  if (!roomsGrid) {
    debugLog("roomsGrid element not found");
    return;
  }

  roomsGrid.innerHTML = "";
  let roomCount = 0;

  Object.entries(rooms).forEach(([roomNumber, info]) => {
    // Initialize cleaning_status if it doesn't exist
    if (!info.hasOwnProperty("cleaning_status")) {
      info.cleaning_status = null;
    }

    // Apply filters
    if (currentFilter === "vacant" && info.status !== "vacant") {
      return;
    }

    if (currentFilter === "occupied" && info.status !== "occupied") {
      return;
    }

    if (currentFilter === "cleaning") {
      const sc = info.service_cleaning || {};
      const hasHkRequest = !!(sc.room || sc.bathroom);
      if (info.status !== "cleaning" && !hasHkRequest) return;
    }

    if (
      currentFilter === "balances" &&
      (info.status !== "occupied" || info.balance <= 0)
    ) {
      return;
    }

    if (
      searchTerm &&
      !roomNumber.toLowerCase().includes(searchTerm) &&
      !(info.guest && info.guest.name.toLowerCase().includes(searchTerm))
    ) {
      return;
    }

    roomCount++;

    const roomCard = document.createElement("div");
    roomCard.className = "room-card";
    roomCard.id = `room-card-${roomNumber}`;

    // Determine display status
    let displayStatus = info.status;
    if (info.status === "cleaning") {
      displayStatus = "cleaning";
    }

    roomCard.setAttribute(
      "aria-label",
      `Room ${roomNumber} - ${displayStatus}`,
    );

    // Create basic room structure
    let roomContent = `
      <div class="room-status ${displayStatus}"></div>
      <div class="room-content">
    `;

    // For cleaning rooms, show cleaning button
    // For cleaning rooms, show cleaning button
    if (info.status === "cleaning") {
      const cleaningTime = getCleaningTime(roomNumber);
      roomContent += `
        <div class="room-number">${roomNumber}</div>
        <div class="guest-name" style="color: #f39c12; font-weight: bold;">🧹 Cleaning</div>
        <div style="font-size: 12px; color: #666; margin-top: 4px;">${cleaningTime}</div>
        <button class="cleaned-btn" onclick="handleCleanedClick(event, '${roomNumber}')">
          <i class="fas fa-check"></i> Cleaned
        </button>
      `;
    }
    // For occupied rooms, add AC indicator and guest count
    else if (info.status === "occupied" && info.guest) {
      const guestCount = info.guest.guests || 1;
      const roomNum = parseInt(roomNumber);
      const isPremiumACRoom = roomNum >= 200 && roomNum <= 206;
      const isAcRoom = isPremiumACRoom && info.guest.isAC === true;

      const isMmtRoom = info.guest.payment === "ota";
      roomContent += `
        <div class="room-number-row">
          ${
            isAcRoom
              ? '<span class="ac-indicator">❄️</span>'
              : '<span class="ac-indicator-placeholder"></span>'
          }
          <div class="room-number">${roomNumber}</div>
          <span class="guest-count-indicator" data-guests="${guestCount}">
            <i class="fas fa-user" style="font-size: 0.7rem; margin-right: 2px;"></i>${guestCount}
          </span>
        </div>
        <div class="guest-name">
          ${isMmtRoom ? '<span style="background:#0c6fcd;color:#fff;font-size:0.6rem;font-weight:700;padding:1px 5px;border-radius:4px;margin-right:4px;letter-spacing:0.03em;vertical-align:middle;">MMT</span>' : ''}${info.guest.name}
        </div>
      `;

      const renewalStatus = getRoomRenewalStatus(info);

      if (renewalStatus.dayNumber > 1) {
        roomContent += `<div class="day-indicator">D${renewalStatus.dayNumber}</div>`;
      }

      roomContent += `
        <div class="enhanced-footer">
          <div>₹${info.guest.price}</div>
          <div>${info.checkin_time ? info.checkin_time.split(" ")[1] : ""}</div>
        </div>
      `;

      if (renewalStatus.expired) {
        roomContent += `
          <div class="renewal-badge" id="renewal-badge-${roomNumber}">Renewal Due</div>
        `;
      } else if (renewalStatus.hoursLeft <= 2) {
        const isWarning = renewalStatus.hoursLeft < 2;
        let timerText = `${renewalStatus.hoursLeft}h ${renewalStatus.minutesLeft}m left`;

        if (renewalStatus.hoursLeft === 0 && renewalStatus.minutesLeft <= 30) {
          timerText = `<strong>⚠️ ${renewalStatus.minutesLeft}m left</strong>`;
        }

        roomContent += `
          <div class="room-timer ${
            isWarning ? "warning" : ""
          }" id="timer-${roomNumber}">
            ${timerText}
          </div>
        `;
      }

      if (info.balance > 0 && !isMmtRoom) {
        roomContent += `<div class="badge" style="background-color:#ff9191;">₹${info.balance}</div>`;
      } else if (info.balance < 0) {
        roomContent += `<div class="badge" style="background-color: var(--success);">₹${Math.abs(
          info.balance,
        )}</div>`;
      }

      // Mid-stay housekeeping — compact icon chips at bottom of card
      const sc = info.service_cleaning || {};
      if (sc.room || sc.bathroom) {
        roomContent += `<div class="hk-card-icons">`;
        if (sc.room)
          roomContent += `<span class="hk-card-icon" onclick="markHousekeepingDone(event,'${roomNumber}','room')" title="Room cleaning — tap when done">🧹</span>`;
        if (sc.bathroom)
          roomContent += `<span class="hk-card-icon" onclick="markHousekeepingDone(event,'${roomNumber}','bathroom')" title="Bathroom cleaning — tap when done">🚿</span>`;
        roomContent += `</div>`;
      }
    } else {
      // For vacant rooms
      roomContent += `
        <div class="room-number">${roomNumber}</div>
        <div class="guest-name">Vacant</div>
        <div class="room-footer">
          <div>Available</div>
        </div>
      `;
    }

    roomContent += `</div>`; // close room-content

    // ── Upcoming booking indicator dot ──────────────────────────────────────
    // Shown on any room with a booking arriving within 24 hrs (not cancelled/checked_in)
    const upcoming = upcomingBookings[roomNumber];
    if (upcoming) {
      const hrs = upcoming.hours_until;
      let dotColor, pulseClass;
      if (hrs <= 0) {
        dotColor = "#f44336"; pulseClass = "pulse-red";     // overdue
      } else if (hrs <= 4) {
        dotColor = "#ff9800"; pulseClass = "pulse-orange";  // urgent <4hrs
      } else {
        dotColor = "#2196F3"; pulseClass = "pulse-blue";    // normal <24hrs
      }
      // Backend returns `name`; tolerate `guest_name` for forward-compat.
      const guestName = upcoming.name || upcoming.guest_name || "Guest";
      const checkInTime = upcoming.check_in_time || "";
      const arrivalLabel = hrs <= 0
        ? `Overdue — ${guestName}`
        : `${guestName} arriving${checkInTime ? " at " + checkInTime : ""}`;
      // Escape double quotes so the title attribute can't be broken by guest names.
      const safeLabel = arrivalLabel.replace(/"/g, "&quot;");
      roomContent += `<div class="booking-indicator-dot ${pulseClass}" style="background:${dotColor};" title="${safeLabel}"></div>`;
    }

    roomCard.innerHTML = roomContent;

    // Setup click handlers
    roomCard.addEventListener("click", () => {
      // Prevent interaction with cleaning rooms
      if (info.status === "cleaning") {
        showNotification("Room is being cleaned", "info");
        return;
      }

      if (info.status === "vacant") {
        showCheckinModal(roomNumber);
      } else if (info.status === "occupied") {
        // Prefetch payment history as soon as user taps the room card
        // so data is ready (or loading) by the time the modal opens.
        if (typeof prefetchPaymentLogs === "function") prefetchPaymentLogs(roomNumber);
        showCheckoutModal(roomNumber);
      }
    });

    // Setup long-press for detailed view
    let longPressTimer;
    const longPressThreshold = 500;

    roomCard.addEventListener("mousedown", function (e) {
      if (info.status !== "cleaning") {
        longPressTimer = setTimeout(() => {
          showRoomDetailsModal(roomNumber);
        }, longPressThreshold);
      }
    });

    roomCard.addEventListener("mouseup", function () {
      clearTimeout(longPressTimer);
    });

    roomCard.addEventListener("mouseleave", function () {
      clearTimeout(longPressTimer);
    });

    roomCard.addEventListener("touchstart", function (e) {
      if (info.status !== "cleaning") {
        longPressTimer = setTimeout(() => {
          showRoomDetailsModal(roomNumber);
        }, longPressThreshold);
      }
    });

    roomCard.addEventListener("touchend", function () {
      clearTimeout(longPressTimer);
    });

    roomCard.addEventListener("touchcancel", function () {
      clearTimeout(longPressTimer);
    });

    roomsGrid.appendChild(roomCard);
  });

  if (roomCount === 0) {
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";
    emptyState.innerHTML = `
      <i class="fas fa-search fa-3x"></i>
      <p>No rooms match your filter criteria</p>
    `;
    roomsGrid.appendChild(emptyState);
  }
}

// Handle cleaned button click
function handleCleanedClick(event, roomNumber) {
  event.stopPropagation();
  markRoomAsCleaned(roomNumber);
}

// ─────────────────────────────────────────────────────────────────────────────
// Mid-stay Housekeeping logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Called when staff taps a 🧹 or 🚿 icon on the room card.
 * Shows a minimal confirmation before marking done.
 */
function markHousekeepingDone(event, roomNumber, type) {
  event.stopPropagation();
  showHkConfirm(roomNumber, type);
}

/**
 * Shows the mini confirmation overlay for a housekeeping task.
 */
function showHkConfirm(roomNumber, type) {
  const overlay   = document.getElementById("hk-confirm-overlay");
  const emojiEl   = document.getElementById("hk-confirm-emoji");
  const titleEl   = document.getElementById("hk-confirm-title");
  if (!overlay) return;

  if (emojiEl) emojiEl.textContent = type === "room" ? "🧹" : "🚿";
  if (titleEl) titleEl.textContent = type === "room" ? "Room cleaned?" : "Bathroom cleaned?";

  overlay.style.display = "flex";

  // Tap the dark backdrop → dismiss
  overlay.onclick = (e) => { if (e.target === overlay) overlay.style.display = "none"; };

  // Clone buttons to drop any stale listeners
  ["hk-confirm-yes", "hk-confirm-no"].forEach(id => {
    const old = document.getElementById(id);
    if (!old) return;
    const fresh = old.cloneNode(true);
    old.parentNode.replaceChild(fresh, old);
  });

  document.getElementById("hk-confirm-no").addEventListener("click", () => {
    overlay.style.display = "none";
  });

  document.getElementById("hk-confirm-yes").addEventListener("click", async () => {
    overlay.style.display = "none";
    await _applyHousekeepingDone(roomNumber, type);
  });
}

/** Actually clears the flag and saves to server. */
async function _applyHousekeepingDone(roomNumber, type) {
  if (!rooms[roomNumber]) return;
  if (!rooms[roomNumber].service_cleaning) rooms[roomNumber].service_cleaning = {};
  rooms[roomNumber].service_cleaning[type] = false;
  renderRooms();

  const label = type === "room" ? "Room cleaning" : "Bathroom cleaning";
  showNotification(`${label} marked as done ✓`, "success");

  try {
    const body = { room: roomNumber };
    if (type === "room") body.room_clean = false;
    else body.bathroom_clean = false;

    await apiFetch("/toggle_housekeeping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error("_applyHousekeepingDone error:", e);
  }
}

/**
 * Updates the visual state of one housekeeping toggle in the checkout modal.
 * toggleId  — the .hk-toggle-item element ID
 * dotId     — the .hk-dot element ID inside it
 * active    — boolean
 */
function updateHousekeepingToggleUI(toggleId, _dotId, active) {
  // _dotId kept for call-site compatibility but unused — new design uses
  // a single .co-hk-pill button where active state is a CSS class.
  const toggle = document.getElementById(toggleId);
  if (!toggle) return;
  toggle.classList.toggle("active", !!active);
}

/**
 * Wires click handler on a housekeeping toggle inside the checkout modal.
 * Clones the element to remove old listeners before adding the new one.
 */
function setupHousekeepingToggle(roomNumber, toggleId, dotId, type) {
  const oldEl = document.getElementById(toggleId);
  if (!oldEl) return;

  // Clone to drop stale event listeners
  const el = oldEl.cloneNode(true);
  oldEl.parentNode.replaceChild(el, oldEl);

  el.addEventListener("click", async () => {
    if (!rooms[roomNumber]) return;
    if (!rooms[roomNumber].service_cleaning) rooms[roomNumber].service_cleaning = {};

    const isActive = !rooms[roomNumber].service_cleaning[type];
    rooms[roomNumber].service_cleaning[type] = isActive;

    updateHousekeepingToggleUI(toggleId, dotId, isActive);
    renderRooms(); // update card icons live

    try {
      const body = { room: roomNumber };
      if (type === "room") body.room_clean = isActive;
      else body.bathroom_clean = isActive;

      await apiFetch("/toggle_housekeeping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      console.error("setupHousekeepingToggle error:", e);
    }
  });
}

/**
 * Sets up the HK chip in the checkout modal.
 * Updates chip appearance (active = any HK requested) and wires click to open overlay.
 */
function setupHkChip(roomNumber, sc) {
  const chip = document.getElementById("hk-chip-btn");
  if (!chip) return;

  // Show active state if any HK is requested
  const anyActive = !!(sc.room || sc.bathroom);
  chip.classList.toggle("hk-active", anyActive);

  // Clone to remove stale listeners
  const newChip = chip.cloneNode(true);
  chip.parentNode.replaceChild(newChip, chip);

  newChip.addEventListener("click", (e) => {
    e.stopPropagation();
    openHkRequestModal(roomNumber);
  });
}

/**
 * Opens the HK request overlay for a room.
 * Shows current room/bathroom state and lets staff toggle + save.
 */
function openHkRequestModal(roomNumber) {
  const overlay = document.getElementById("hk-request-overlay");
  if (!overlay) return;

  const roomBtn     = document.getElementById("hk-req-room-btn");
  const bathroomBtn = document.getElementById("hk-req-bathroom-btn");
  const saveBtn     = document.getElementById("hk-req-save");
  const cancelBtn   = document.getElementById("hk-req-cancel");

  if (!roomBtn || !bathroomBtn || !saveBtn || !cancelBtn) return;

  // Read current state
  const sc = (rooms[roomNumber] && rooms[roomNumber].service_cleaning) || {};
  let roomActive     = !!sc.room;
  let bathroomActive = !!sc.bathroom;

  const refresh = () => {
    roomBtn.classList.toggle("active", roomActive);
    bathroomBtn.classList.toggle("active", bathroomActive);
  };
  refresh();

  // Clone buttons to drop stale listeners
  const newRoomBtn     = roomBtn.cloneNode(true);
  const newBathroomBtn = bathroomBtn.cloneNode(true);
  const newSaveBtn     = saveBtn.cloneNode(true);
  const newCancelBtn   = cancelBtn.cloneNode(true);

  roomBtn.replaceWith(newRoomBtn);
  bathroomBtn.replaceWith(newBathroomBtn);
  saveBtn.replaceWith(newSaveBtn);
  cancelBtn.replaceWith(newCancelBtn);

  // Re-apply active classes after clone
  newRoomBtn.classList.toggle("active", roomActive);
  newBathroomBtn.classList.toggle("active", bathroomActive);

  newRoomBtn.addEventListener("click", () => {
    roomActive = !roomActive;
    newRoomBtn.classList.toggle("active", roomActive);
  });
  newBathroomBtn.addEventListener("click", () => {
    bathroomActive = !bathroomActive;
    newBathroomBtn.classList.toggle("active", bathroomActive);
  });

  const close = () => { overlay.style.display = "none"; };

  newCancelBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); }, { once: true });

  newSaveBtn.addEventListener("click", async () => {
    close();

    // Update local state
    if (!rooms[roomNumber]) return;
    if (!rooms[roomNumber].service_cleaning) rooms[roomNumber].service_cleaning = {};
    rooms[roomNumber].service_cleaning.room     = roomActive;
    rooms[roomNumber].service_cleaning.bathroom = bathroomActive;

    // Update chip appearance
    const chip = document.getElementById("hk-chip-btn");
    if (chip) chip.classList.toggle("hk-active", roomActive || bathroomActive);

    renderRooms(); // update card icons live

    try {
      await apiFetch("/toggle_housekeeping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          room: roomNumber,
          room_clean:     roomActive,
          bathroom_clean: bathroomActive,
        }),
      });
    } catch (e) {
      console.error("openHkRequestModal save error:", e);
    }
  });

  overlay.style.display = "flex";
}

// Debounced background sync — prevents 3 rapid actions (e.g. add service ×3)
// from each firing a full Firestore reload. Only the LAST call within 2 s runs.
let _fetchDebounceTimer = null;
function debouncedFetchData(delay = 2000, roomNumber = null) {
  // Invalidate payment history cache for this room so the next modal
  // open fetches fresh data instead of showing stale history.
  if (roomNumber && typeof invalidatePayHistoryCache === "function") {
    invalidatePayHistoryCache(roomNumber);
  }
  clearTimeout(_fetchDebounceTimer);
  _fetchDebounceTimer = setTimeout(fetchData, delay);
}

// Fetch data from the server
async function fetchData() {
  try {
    debugLog("Fetching data from server...");

    // Fire all requests in parallel — cuts sequential wait
    const [response, metadataResponse, upcomingResponse] = await Promise.all([
      apiFetch("/get_data"),
      apiFetch("/get_transaction_metadata").catch(() => null),
      apiFetch("/get_upcoming_bookings").catch(() => null),
    ]);

    if (!response.ok) {
      throw new Error(`Server responded with status: ${response.status}`);
    }

    const data = await response.json();
    debugLog("Data fetched successfully");

    rooms = data.rooms;
    logs = data.logs;
    totals = data.totals;

    // Load today's daily counter (single-doc read — serial number for today)
    try {
      if (metadataResponse && metadataResponse.ok) {
        const metadataData = await metadataResponse.json();
        if (metadataData.success) {
          dailyCounters = metadataData.daily_counters || {};
        }
      }
    } catch (error) {
      console.warn("Could not fetch daily counters:", error);
    }

    // Process upcoming bookings from parallel response
    try {
      if (upcomingResponse && upcomingResponse.ok) {
        const upcomingData = await upcomingResponse.json();
        if (upcomingData.success) {
          upcomingBookings = upcomingData.upcoming || {};
        }
      }
    } catch (error) {
      console.warn("Could not fetch upcoming bookings:", error);
    }

    // Process rooms to ensure they have renewal data
    Object.entries(rooms).forEach(([roomNumber, roomInfo]) => {
      if (roomInfo.status === "occupied") {
        // Ensure renewal count exists
        if (roomInfo.renewal_count === undefined) {
          roomInfo.renewal_count = 0;
        }

        // Make sure last_renewal_time is defined if it should be
        if (roomInfo.renewal_count > 0 && !roomInfo.last_renewal_time) {
          // Estimate a last renewal time if missing
          const checkinDate = new Date(roomInfo.checkin_time);
          const estimatedLastRenewal = new Date(
            checkinDate.getTime() +
              roomInfo.renewal_count * 24 * 60 * 60 * 1000,
          );
          roomInfo.last_renewal_time = formatDateTime(estimatedLastRenewal);
        }
      }
    });

    // Make sure all log types exist
    const requiredLogTypes = [
      "cash",
      "online",
      "balance",
      "add_ons",
      "refunds",
      "renewals",
    ];
    requiredLogTypes.forEach((type) => {
      if (!logs[type]) logs[type] = [];
    });

    renderRooms();

    // If the checkout modal is open, re-sync it with the fresh server data.
    // This prevents a stale balance (e.g. a spurious "Refund" UI) from
    // persisting in the modal after the background fetchData corrects rooms[].
    try {
      const _checkoutModal = document.getElementById("checkout-modal");
      const _checkoutRoomEl = document.getElementById("checkout-room-number");
      if (
        _checkoutModal && _checkoutModal.classList.contains("show") &&
        _checkoutRoomEl
      ) {
        const _openRoom = _checkoutRoomEl.textContent.trim();
        if (_openRoom && rooms[_openRoom] && typeof updateCheckoutModal === "function") {
          updateCheckoutModal(_openRoom);
        }
      }
    } catch (_e) { /* non-fatal — never break the fetch cycle */ }

    // Use transaction log manager for rendering logs
    if (typeof renderEnhancedLogs === "function") {
      renderEnhancedLogs();
    }

    updateStats();
    updateStatsToggleBadge();

    return true;
  } catch (error) {
    console.error("Error fetching data:", error);
    showNotification(`Error fetching data: ${error.message}`, "error");
    return false;
  }
}

function updateFilterCounts() {
  let counts = { vacant: 0, occupied: 0, cleaning: 0, balances: 0 };
  let balanceTotal = 0;

  Object.values(rooms).forEach((room) => {
    if (room.status === "vacant") counts.vacant++;
    else if (room.status === "occupied") counts.occupied++;
    else if (room.status === "cleaning") counts.cleaning++;

    // Count occupied rooms with active HK requests in the cleaning badge
    if (room.status === "occupied") {
      const sc = room.service_cleaning || {};
      if (sc.room || sc.bathroom) counts.cleaning++;
    }

    if (room.status === "occupied" && room.balance > 0) {
      counts.balances++;
      balanceTotal += room.balance;
    }
  });

  const elVacant   = document.getElementById("count-filter-vacant");
  const elOccupied = document.getElementById("count-filter-occupied");
  const elCleaning = document.getElementById("count-filter-cleaning");
  const elBalances = document.getElementById("count-filter-balances");
  const elAmount   = document.getElementById("amount-filter-balances");

  if (elVacant)   elVacant.textContent   = counts.vacant;
  if (elOccupied) elOccupied.textContent = counts.occupied;
  if (elCleaning) elCleaning.textContent = counts.cleaning;
  if (elBalances) elBalances.textContent = counts.balances;
  if (elAmount)   elAmount.textContent   = balanceTotal > 0 ? `₹${balanceTotal.toLocaleString("en-IN")}` : "";
}

function updateStats() {
  let counts = { vacant: 0, occupied: 0, cleaning: 0, balances: 0 };
  let balanceTotal = 0;

  Object.values(rooms).forEach((room) => {
    if (room.status === "vacant") counts.vacant++;
    else if (room.status === "occupied") {
      counts.occupied++;
      if (room.balance > 0) { counts.balances++; balanceTotal += room.balance; }
      // Count occupied rooms with active HK requests in cleaning badge
      const sc = room.service_cleaning || {};
      if (sc.room || sc.bathroom) counts.cleaning++;
    } else if (room.status === "cleaning") counts.cleaning++;
  });

  const elVacant   = document.getElementById("count-filter-vacant");
  const elOccupied = document.getElementById("count-filter-occupied");
  const elCleaning = document.getElementById("count-filter-cleaning");
  const elBalances = document.getElementById("count-filter-balances");
  const elAmount   = document.getElementById("amount-filter-balances");

  if (elVacant)   elVacant.textContent   = counts.vacant;
  if (elOccupied) elOccupied.textContent = counts.occupied;
  if (elCleaning) elCleaning.textContent = counts.cleaning;
  if (elBalances) elBalances.textContent = counts.balances;
  if (elAmount)   elAmount.textContent   = balanceTotal > 0 ? `₹${balanceTotal.toLocaleString("en-IN")}` : "";

  // Keep the quick action badge logic if you still use the floating bolt menu
  const renewalsDue = Object.values(rooms).filter(
    (r) => r.status === "occupied" && getRoomRenewalStatus(r).canRenew,
  ).length;

  const quickRenewBtn = document.getElementById("quick-renew-btn");
  if (quickRenewBtn) {
    quickRenewBtn.innerHTML =
      renewalsDue > 0
        ? `<i class="fas fa-sync-alt"></i> <span>Renewals Due <span class="badge-mini">${renewalsDue}</span></span>`
        : `<i class="fas fa-sync-alt"></i> <span>Renewals Due</span>`;
  }
}

// Calculate room renewal status
function getRoomRenewalStatus(roomInfo) {
  if (!roomInfo || !roomInfo.checkin_time) {
    return {
      hoursLeft: 0,
      minutesLeft: 0,
      expired: true,
      canRenew: false,
      renewalCount: 0,
      dayNumber: 1,
      nextRenewalTime: null,
      status: "unknown",
    };
  }

  // Get basic room info
  const renewalCount = roomInfo.renewal_count || 0;
  const dayNumber = renewalCount + 1; // Day 1, 2, 3, etc.

  // Parse the original check-in time
  const checkinDate = new Date(roomInfo.checkin_time);

  // Calculate when the next renewal is due
  const nextRenewalTime = new Date(checkinDate);

  // For day 1 (just checked in): next renewal is check-in time + 1 day
  // For day 2 (after first renewal): next renewal is check-in time + 2 days
  // For day 3: next renewal is check-in time + 3 days, etc.
  nextRenewalTime.setDate(checkinDate.getDate() + dayNumber);

  // Calculate time left until next renewal
  const now = new Date();
  const timeLeft = nextRenewalTime - now;

  // Convert milliseconds to hours and minutes
  const hoursLeft = Math.floor(timeLeft / (1000 * 60 * 60));
  const minutesLeft = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));

  // Determine if time has expired (time to renew)
  const expired = timeLeft <= 0;

  // Can only renew if time has expired
  const canRenew = expired;

  // How long ago the renewal became available (for sorting overdue rooms)
  const timeSinceExpiry = expired ? Math.abs(timeLeft) : 0;

  // Format next renewal time for display
  const formattedNextRenewal = formatDateTime(nextRenewalTime);

  // Determine status for UI display
  let status;
  if (expired) {
    status = "renewable"; // Can be renewed now
  } else if (hoursLeft < 1) {
    status = "expiring-soon"; // Less than 1 hour left
  } else {
    status = "waiting"; // More than 1 hour left
  }

  return {
    hoursLeft,
    minutesLeft,
    expired,
    canRenew,
    renewalCount,
    dayNumber,
    nextRenewalTime: formattedNextRenewal,
    timeSinceExpiry,
    status,
  };
}

// Format date-time for display — uses LOCAL time (not UTC) so IST staff see correct times
function formatDateTime(date) {
  if (!(date instanceof Date)) date = new Date(date);
  const pad = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
         `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// Process rent renewal for a room
async function triggerRentRenewal(roomNumber) {
  try {
    const roomInfo = rooms[roomNumber];
    if (!roomInfo) return false;

    // Get renewal status
    const renewalStatus = getRoomRenewalStatus(roomInfo);

    // Check if renewal is allowed (must be expired)
    if (!renewalStatus.canRenew) {
      const hoursMinutesStr = `${renewalStatus.hoursLeft}h ${renewalStatus.minutesLeft}m`;
      showNotification(
        `Cannot renew yet. Please wait ${hoursMinutesStr} more.`,
        "error",
      );
      return false;
    }

    // New renewal count - this is the key value for calculating future renewals
    const newRenewalCount = (roomInfo.renewal_count || 0) + 1;

    debugLog(
      "Processing renewal for room " +
        roomNumber +
        ", new day: " +
        (newRenewalCount + 1),
    );

    const response = await apiFetch("/renew_rent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        room: roomNumber,
        renewal_count: newRenewalCount,
      }),
    });

    if (!response.ok) {
      throw new Error(`Server responded with status: ${response.status}`);
    }

    const result = await response.json();
    if (result.success) {
      // Update the room object locally
      roomInfo.renewal_count = newRenewalCount;

      // Remove last_renewal_time if it exists (we don't use it anymore)
      if (roomInfo.last_renewal_time) {
        delete roomInfo.last_renewal_time;
      }

      // Add to renewal logs
      if (!logs.renewals) logs.renewals = [];

      // Get current date and time
      const now = new Date();
      const currentDate = now.toISOString().split("T")[0];
      const currentTime = now.toTimeString().split(" ")[0].slice(0, 5);

      logs.renewals.push({
        room: roomNumber,
        name: roomInfo.guest?.name || "Unknown",
        date: currentDate,
        time: currentTime,
        day: newRenewalCount + 1,
      });

      // Update room grid immediately with local data, then sync totals in background
      renderRooms();
      debouncedFetchData(); // background refresh for totals

      showNotification(
        `Room ${roomNumber} rent renewed for Day ${newRenewalCount + 1}!`,
        "success",
      );

      return true;
    } else {
      showNotification(result.message || "Failed to renew rent", "error");
      return false;
    }
  } catch (error) {
    console.error("Error renewing rent:", error);
    showNotification(`Error renewing rent: ${error.message}`, "error");
    return false;
  }
}

// Show the renewal modal with rooms due for renewal
function showRenewalModal() {
  const renewalList = document.getElementById("renewal-list");
  if (!renewalList) {
    debugLog("Renewal list element not found");
    return;
  }

  if (!rentRenewalModal) {
    debugLog("Rent renewal modal not found");
    return;
  }

  // Clear previous content
  renewalList.innerHTML = `
    <div class="loading-indicator">
      <span class="loader"></span>
      <p>Checking for renewals...</p>
    </div>
  `;

  // Find rooms due for renewal
  const dueRooms = [];

  Object.entries(rooms).forEach(([roomNumber, info]) => {
    if (info.status === "occupied") {
      const renewalStatus = getRoomRenewalStatus(info);
      if (renewalStatus.canRenew) {
        dueRooms.push({
          room: roomNumber,
          info: info,
          status: renewalStatus,
          timeSinceExpiry: renewalStatus.timeSinceExpiry,
        });
      }
    }
  });

  setTimeout(() => {
    if (dueRooms.length === 0) {
      renewalList.innerHTML = `
        <div style="text-align: center; padding: 20px;">
          <i class="fas fa-check-circle" style="color: var(--success); font-size: 2rem;"></i>
          <p style="margin-top: 10px;">All rooms are up to date!</p>
        </div>
      `;

      // Hide the renew all button
      const renewAllBtn = document.getElementById("renew-all-btn");
      if (renewAllBtn) {
        renewAllBtn.style.display = "none";
      }
    } else {
      // Sort rooms by how long they've been overdue
      dueRooms.sort((a, b) => b.timeSinceExpiry - a.timeSinceExpiry);

      // Show the renew all button
      const renewAllBtn = document.getElementById("renew-all-btn");
      if (renewAllBtn) {
        renewAllBtn.style.display = "block";
      }

      // Create list of rooms due for renewal
      renewalList.innerHTML = "";
      dueRooms.forEach(({ room, info, status }) => {
        // Calculate how long ago renewal became due
        const hoursOverdue = Math.floor(
          status.timeSinceExpiry / (1000 * 60 * 60),
        );
        const minutesOverdue = Math.floor(
          (status.timeSinceExpiry % (1000 * 60 * 60)) / (1000 * 60),
        );

        let overdueText;
        if (hoursOverdue > 0) {
          overdueText = `Overdue by ${hoursOverdue}h ${minutesOverdue}m`;
        } else {
          overdueText = `Overdue by ${minutesOverdue}m`;
        }

        const renewalItem = document.createElement("div");
        renewalItem.className = "renewal-item";
        renewalItem.dataset.room = room;

        renewalItem.innerHTML = `
          <div class="renewal-info">
            <div class="renewal-room">Room ${room} <span class="status-tag renewable">Day ${
              status.dayNumber
            }</span></div>
            <div class="renewal-guest">${info.guest?.name || "Unknown"}</div>
            <div class="renewal-overdue">${overdueText}</div>
          </div>
          <div class="renewal-price">₹${info.guest?.price || 0}</div>
          <div class="renewal-action">
            <button class="action-btn btn-sm btn-warning renew-single-btn">Renew</button>
          </div>
        `;

        renewalList.appendChild(renewalItem);

        // Add event listener to renew button
        const renewButton = renewalItem.querySelector(".renew-single-btn");
        if (renewButton) {
          renewButton.addEventListener("click", function () {
            this.disabled = true;
            this.innerHTML =
              '<span class="loader" style="width: 10px; height: 10px;"></span>';

            triggerRentRenewal(room)
              .then((success) => {
                if (success) {
                  // Update UI to show this room is processed
                  renewalItem.style.backgroundColor = "#e8f4e5";
                  this.innerHTML = "Renewed";
                } else {
                  // Reset button on failure
                  this.disabled = false;
                  this.innerHTML = "Retry";
                }
              })
              .catch(() => {
                this.disabled = false;
                this.innerHTML = "Retry";
              });
          });
        }
      });
    }
  }, 500);

  // Show the modal
  rentRenewalModal.classList.add("show");
}

// Filter rooms by balance - now used by filter button
function filterRoomsByBalance() {
  currentFilter = "balances";

  // Update active button visual
  document.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.classList.remove("active");
  });

  const balancesFilterBtn = document.querySelector(
    '.filter-btn[data-filter="balances"]',
  );
  if (balancesFilterBtn) {
    balancesFilterBtn.classList.add("active");
  }

  renderRooms();
}

// Show check-in modal
function showCheckinModal(roomNumber) {
  if (!checkinModal) {
    debugLog("Check-in modal not found");
    return;
  }

  const roomNumberElement = document.getElementById("checkin-room-number");
  if (roomNumberElement) {
    roomNumberElement.textContent = roomNumber;
  }

  // Reset form fields
  const checkinForm = document.getElementById("checkin-form");
  if (checkinForm) {
    checkinForm.reset();
  }

  const paymentMethodInput = document.getElementById("payment-method");
  if (paymentMethodInput) {
    paymentMethodInput.value = "cash";
  }

  const photoPreviewContainer = document.getElementById(
    "photo-preview-container",
  );
  if (photoPreviewContainer) {
    photoPreviewContainer.style.display = "none";
  }

  const cameraContainer = document.getElementById("camera-container");
  if (cameraContainer) {
    cameraContainer.style.display = "none";
  }

  // Make sure cash is the default active payment method
  document.querySelectorAll(".payment-btn").forEach((btn) => {
    btn.classList.remove("active");
  });

  const cashBtn = document.querySelector('.payment-btn[data-payment="cash"]');
  if (cashBtn) {
    cashBtn.classList.add("active");
  }

  // Reset captured photo data
  capturedPhotoData = null;
  uploadedPhotoUrl = null;

  checkinModal.classList.add("show");
}

// Update checkout modal to refresh all information
function updateCheckoutModal(roomNumber) {
  if (!checkoutModal) {
    debugLog("Checkout modal not found");
    return;
  }

  const roomInfo = rooms[roomNumber];
  if (!roomInfo || !roomInfo.guest) {
    showNotification("Error loading room data", "error");
    return;
  }

  const checkoutRoomNumber = document.getElementById("checkout-room-number");
  if (checkoutRoomNumber) {
    checkoutRoomNumber.textContent = roomNumber;
  }

  const checkoutGuestName = document.getElementById("checkout-guest-name");
  if (checkoutGuestName) {
    const isMmtCheckout = roomInfo.guest && roomInfo.guest.payment === "ota";
    if (isMmtCheckout) {
      checkoutGuestName.innerHTML =
        '<span style="background:#0c6fcd;color:#fff;font-size:0.65rem;font-weight:700;padding:1px 6px;border-radius:4px;margin-right:5px;vertical-align:middle;letter-spacing:0.03em;">MMT</span>' +
        roomInfo.guest.name;
    } else {
      checkoutGuestName.textContent = roomInfo.guest.name;
    }
  }

  const checkoutMobileNumber = document.getElementById(
    "checkout-mobile-number",
  );
  if (checkoutMobileNumber) {
    checkoutMobileNumber.textContent = roomInfo.guest.mobile || "N/A";
  }

  const checkoutGuestMobile = document.getElementById("checkout-guest-mobile");
  if (checkoutGuestMobile) {
    checkoutGuestMobile.href = `tel:${roomInfo.guest.mobile || ""}`;
  }

  const checkoutCheckinTime = document.getElementById("checkout-checkin-time");
  if (checkoutCheckinTime) {
    checkoutCheckinTime.textContent = roomInfo.checkin_time || "N/A";
  }

  const checkoutRoomPrice = document.getElementById("checkout-room-price");
  if (checkoutRoomPrice) {
    checkoutRoomPrice.textContent = "₹" + roomInfo.guest.price;
  }

  // ── Guest photo ─────────────────────────────────────────────────────────
  const guestPhotoContainer = document.getElementById("checkout-photo-container");
  const guestPhotoEl        = document.getElementById("checkout-guest-photo");
  if (guestPhotoContainer && guestPhotoEl) {
    if (roomInfo.guest.photo) {
      guestPhotoEl.src = roomInfo.guest.photo;
      guestPhotoContainer.style.display = "block";
    } else {
      guestPhotoContainer.style.display = "none";
    }
  }

  // ── Balance row ──────────────────────────────────────────────────────────
  const balanceEl  = document.getElementById("checkout-balance");
  const isOtaRoom  = roomInfo.guest && roomInfo.guest.payment === "ota";
  const balanceRow = balanceEl ? balanceEl.closest(".detail-row") : null;
  if (balanceEl) {
    if (isOtaRoom) {
      // MMT prepaid — hide balance row (not applicable)
      if (balanceRow) balanceRow.style.display = "none";
    } else {
      if (balanceRow) balanceRow.style.display = "";
      if (roomInfo.balance < 0) {
        balanceEl.textContent = "−₹" + Math.abs(roomInfo.balance);
        balanceEl.style.color = "var(--success)";
      } else if (roomInfo.balance > 0) {
        balanceEl.textContent = "₹" + roomInfo.balance;
        balanceEl.style.color = "var(--danger)";
      } else {
        balanceEl.textContent = "₹0";
        balanceEl.style.color = "";
      }
    }
  }

  // ── Renewal / stay status ────────────────────────────────────────────────
  const renewalStatus   = getRoomRenewalStatus(roomInfo);
  const dayCountEl      = document.getElementById("checkout-day-count");
  const renewalStatusEl = document.getElementById("checkout-renewal-status");

  if (dayCountEl) {
    dayCountEl.textContent = `Day ${renewalStatus.dayNumber}`;
  }

  if (renewalStatusEl) {
    renewalStatusEl.className = "status-tag";
    renewalStatusEl.style.color = "";
    if (renewalStatus.expired) {
      renewalStatusEl.classList.add("warning");
      renewalStatusEl.textContent = "Overdue";
    } else if (renewalStatus.hoursLeft <= 2) {
      renewalStatusEl.classList.add("warning");
      renewalStatusEl.textContent = renewalStatus.hoursLeft < 1
        ? `${renewalStatus.minutesLeft}m left`
        : `${renewalStatus.hoursLeft}h ${renewalStatus.minutesLeft}m left`;
    } else {
      renewalStatusEl.classList.add("renewable");
      renewalStatusEl.textContent = `${renewalStatus.hoursLeft}h ${renewalStatus.minutesLeft}m left`;
    }
  }

  // Populate checkout ID doc viewer button
  if (typeof window.populateCheckoutDocView === "function") {
    window.populateCheckoutDocView(roomInfo.guest.mobile || "");
  }

  // Init checkout doc attach section
  if (typeof window.initCheckoutDocAttach === "function") {
    window.initCheckoutDocAttach(roomInfo.guest.mobile || "");
  }

  // Reset the service form
  resetServiceForm();

  // Show / hide the AC service button based on room type and current AC status.
  // The button appears only for rooms 200–206 where the guest has NOT yet
  // activated AC (isAC === false).  Once AC is added the flag flips server-side
  // and the button disappears after the next fetchData() → updateCheckoutModal().
  const acServiceBtn = document.getElementById("ac-service-btn");
  if (acServiceBtn) {
    const roomNum = parseInt(roomNumber, 10);
    const isAcCapableRoom = roomNum >= 200 && roomNum <= 206;
    const guestHasAc = roomInfo.guest && roomInfo.guest.isAC === true;
    acServiceBtn.style.display = (isAcCapableRoom && !guestHasAc) ? "" : "none";
  }

  // ── Housekeeping chip ────────────────────────────────────────────────────
  const sc = roomInfo.service_cleaning || {};
  setupHkChip(roomNumber, sc);

  // Update renewal history
  updateRenewalHistory(roomNumber);

  // Update payment or refund UI
  updatePaymentOrRefundUI(roomNumber);

  // Update payment logs using transaction log manager
  if (typeof updatePaymentLogs === "function") {
    updatePaymentLogs(roomNumber);
  }
}

// Show checkout modal with detailed info
function showCheckoutModal(roomNumber) {
  if (!checkoutModal) {
    debugLog("Checkout modal not found");
    return;
  }

  updateCheckoutModal(roomNumber);
  checkoutModal.classList.add("show");

  // Update the proceed checkout button to mark room for cleaning
  const proceedCheckoutBtn = document.getElementById("proceed-checkout-btn");
  if (proceedCheckoutBtn) {
    // Store the original handler and create a new one
    proceedCheckoutBtn.onclick = async function () {
      if (checkoutInProgress) {
        return;
      }

      checkoutInProgress = true;
      this.disabled = true;
      this.innerHTML =
        '<span class="loader" style="width: 20px; height: 20px;"></span> Processing...';

      const roomNumberElement = document.getElementById("checkout-room-number");
      if (!roomNumberElement) {
        showNotification("Room number element not found", "error");
        checkoutInProgress = false;
        this.disabled = false;
        this.innerHTML = "Yes, Checkout";
        return;
      }

      const currentRoomNumber = roomNumberElement.textContent.trim();
      const balance = rooms[currentRoomNumber].balance;
      const isOta1 = rooms[currentRoomNumber]?.guest?.payment === "ota";

      if (balance > 0 && !isOta1) {
        showNotification("Please clear the balance before checkout", "error");
        checkoutInProgress = false;
        this.disabled = false;
        this.innerHTML = "Yes, Checkout";

        const checkoutConfirmModal = document.getElementById(
          "checkout-confirm-modal",
        );
        if (checkoutConfirmModal) {
          checkoutConfirmModal.classList.remove("show");
        }
        return;
      }

      if (balance < 0) {
        checkoutInProgress = false;
        this.disabled = false;
        this.innerHTML = "Yes, Checkout";

        const checkoutConfirmModal = document.getElementById(
          "checkout-confirm-modal",
        );
        if (checkoutConfirmModal) {
          checkoutConfirmModal.classList.remove("show");
        }
        return;
      }

      // ── Close modals & update UI immediately — don't wait for the server ──────
      const checkoutConfirmModal = document.getElementById("checkout-confirm-modal");
      if (checkoutConfirmModal) checkoutConfirmModal.classList.remove("show");
      if (checkoutModal) checkoutModal.classList.remove("show");

      // Snapshot for rollback if the server later reports failure
      const prevRoomState = rooms[currentRoomNumber] ? { ...rooms[currentRoomNumber] } : null;

      // Flip room to cleaning in local state immediately
      if (rooms[currentRoomNumber]) {
        rooms[currentRoomNumber].status = "cleaning";
        rooms[currentRoomNumber].guest  = null;
      }
      renderRooms();
      // Reset button right away
      checkoutInProgress = false;
      this.disabled = false;
      this.innerHTML = "Yes, Checkout";

      // ── Fire checkout + marking + PDF in background — no await ───────────────
      apiFetch("/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: currentRoomNumber, final_checkout: true }),
      })
        .then(r => r.json())
        .then(result => {
          if (result.success) {
            markRoomForCleaning(currentRoomNumber); // fire and forget
            debouncedFetchData(3000, currentRoomNumber);
            showNotification(
              result.message || "Checkout successful! Room marked for cleaning.",
              "success",
            );
            // Auto-generate & store PDF in background (non-blocking)
            if (result.bill_id && typeof window._cibaraBillsAutoGenerate === "function") {
              window._cibaraBillsAutoGenerate(result.bill_id);
            }
          } else {
            // Rollback local state on failure
            if (prevRoomState) rooms[currentRoomNumber] = prevRoomState;
            renderRooms();
            showNotification(result.message || "Checkout failed — please try again.", "error");
          }
        })
        .catch(err => {
          console.error("Checkout error:", err);
          if (prevRoomState) rooms[currentRoomNumber] = prevRoomState;
          renderRooms();
          showNotification("Network error during checkout — please try again.", "error");
        });
    };
  }
}

// Update renewal history
function updateRenewalHistory(roomNumber) {
  const roomInfo = rooms[roomNumber];
  const renewalHistoryContainer = document.getElementById(
    "renewal-history-container",
  );
  const renewalHistoryContent = document.getElementById(
    "renewal-history-content",
  );
  const nextRenewalTime = document.getElementById("next-renewal-time");

  if (!renewalHistoryContainer || !renewalHistoryContent || !nextRenewalTime) {
    debugLog("Renewal history elements not found");
    return;
  }

  // If no renewal history, hide the container
  const renewalCount = roomInfo.renewal_count || 0;
  if (renewalCount === 0) {
    renewalHistoryContainer.style.display = "none";
    return;
  }

  // Show the container
  renewalHistoryContainer.style.display = "block";

  // Get renewal status
  const renewalStatus = getRoomRenewalStatus(roomInfo);

  // Clear previous content
  renewalHistoryContent.innerHTML = "";

  // Add initial check-in
  renewalHistoryContent.innerHTML += `
    <div class="renewal-history-item">
      <div>Initial Check-in</div>
      <div>${roomInfo.checkin_time}</div>
    </div>
  `;

  // Add renewal history from logs
  const roomRenewals = logs.renewals
    ? logs.renewals
        .filter((log) => log.room === roomNumber)
        .sort((a, b) => {
          // Sort by date and time
          const dateA = new Date(`${a.date} ${a.time}`);
          const dateB = new Date(`${b.date} ${b.time}`);
          return dateA - dateB;
        })
    : [];

  roomRenewals.forEach((log, index) => {
    renewalHistoryContent.innerHTML += `
      <div class="renewal-history-item">
        <div>Renewal for Day ${index + 2}</div>
        <div>${log.date} ${log.time}</div>
      </div>
    `;
  });

  // Show next renewal time
  const nextRenewalStr = renewalStatus.expired
    ? "Renewal is due now"
    : `Next renewal in ${renewalStatus.hoursLeft}h ${renewalStatus.minutesLeft}m`;

  nextRenewalTime.innerHTML = `<i class="fas fa-clock"></i> ${nextRenewalStr}`;
}

// Reset service form
function resetServiceForm() {
  if (!serviceForm) {
    debugLog("Service form not found");
    return;
  }

  serviceForm.classList.add("hidden");
  selectedService = null;
  isAccommodationCharge = false;

  // Deselect all service chips
  document.querySelectorAll(".svc-chip").forEach((btn) => {
    btn.classList.remove("selected");
  });

  // Hide custom name row and clear it
  const svcNameRow = document.getElementById("svc-name-row");
  if (svcNameRow) svcNameRow.style.display = "none";
  const svcNameInput = document.getElementById("service-name");
  if (svcNameInput) { svcNameInput.value = ""; svcNameInput.readOnly = false; }

  // Reset payment method
  document.querySelectorAll(".payment-options .payment-btn").forEach((btn) => {
    btn.classList.remove("active");
  });

  const cashBtn = document.querySelector("#service-form .payment-btn.cash");
  if (cashBtn) {
    cashBtn.classList.add("active");
  }

  // Reset quantity to 1
  const quantityInput = document.getElementById("service-quantity");
  if (quantityInput) {
    quantityInput.value = 1;
  }

  // Reset total price
  const totalPriceElement = document.getElementById("service-total-price");
  if (totalPriceElement) {
    totalPriceElement.textContent = "₹0";
  }

  servicePaymentMethod = "cash";
  if (servicePaymentMethodInput) servicePaymentMethodInput.value = "cash";
}

// Initialize service buttons
function initServiceButtons() {
  debugLog("Initializing service buttons");
  // Service chips
  const serviceButtons = document.querySelectorAll(".svc-chip");
  if (serviceButtons.length === 0) {
    debugLog("No service chips found");
  }

  serviceButtons.forEach((btn) => {
    btn.addEventListener("click", function () {
      const isCustom = this.dataset.custom === "true";
      const service = isCustom ? "" : this.dataset.service;
      const price = this.dataset.price;

      debugLog(`Service chip clicked: ${service || "(custom)"}, price: ${price}`);

      // Clear previous selection
      document.querySelectorAll(".svc-chip").forEach((b) => {
        b.classList.remove("selected");
      });

      // Select this chip
      this.classList.add("selected");
      selectedService = service;

      // Track accommodation charge flag
      isAccommodationCharge = this.dataset.accommodation === "true";

      // Name row: show for custom chip, hide for presets
      const svcNameRow = document.getElementById("svc-name-row");
      const svcNameInput = document.getElementById("service-name");

      if (svcNameRow) {
        if (isCustom) {
          svcNameRow.style.display = "flex";
          if (svcNameInput) {
            svcNameInput.value = "";
            svcNameInput.readOnly = false;
            setTimeout(() => svcNameInput.focus(), 50);
          }
        } else {
          svcNameRow.style.display = "none";
          if (svcNameInput) {
            svcNameInput.value = service;
            svcNameInput.readOnly = true;
          }
        }
      }

      // Populate service form
      if (serviceForm && servicePrice) {
        servicePrice.value = price;

        // Reset quantity to 1
        const quantityInput = document.getElementById("service-quantity");
        if (quantityInput) {
          quantityInput.value = 1;
        }

        if (price) {
          servicePrice.readOnly = true;
        } else {
          servicePrice.readOnly = false;
          if (!isCustom) servicePrice.focus();
        }

        // Update total price
        updateServiceTotalPrice();

        // Show service form
        serviceForm.classList.remove("hidden");
      } else {
        debugLog("Service form elements not found");
        if (!serviceForm) debugLog("- serviceForm not found");
        if (!servicePrice) debugLog("- servicePrice not found");
      }
    });
  });

  // Add event listeners for price and quantity changes
  const servicePriceInput = document.getElementById("service-price");
  const serviceQuantityInput = document.getElementById("service-quantity");

  if (servicePriceInput) {
    servicePriceInput.addEventListener("input", updateServiceTotalPrice);
  }

  if (serviceQuantityInput) {
    serviceQuantityInput.addEventListener("input", updateServiceTotalPrice);
  }

  // Service payment method selection
  const servicePaymentBtns = document.querySelectorAll(
    "#service-form .payment-btn",
  );
  if (servicePaymentBtns.length === 0) {
    debugLog("No payment buttons found in service form");
  }

  servicePaymentBtns.forEach((btn) => {
    btn.addEventListener("click", function () {
      debugLog(`Service payment method clicked: ${this.dataset.payment}`);

      // Clear previous selections
      document.querySelectorAll("#service-form .payment-btn").forEach((b) => {
        b.classList.remove("active");
      });

      // Set this as active
      this.classList.add("active");
      servicePaymentMethod = this.dataset.payment;
      if (servicePaymentMethodInput) {
        servicePaymentMethodInput.value = servicePaymentMethod;
      }
    });
  });

  // Cancel service button
  const cancelServiceBtn = document.getElementById("cancel-service-btn");
  if (cancelServiceBtn) {
    cancelServiceBtn.addEventListener("click", resetServiceForm);
  } else {
    debugLog("Cancel service button not found");
  }

  // Add service button
  const addServiceBtn = document.getElementById("add-service-btn");
  if (addServiceBtn) {
    addServiceBtn.addEventListener("click", addService);
  } else {
    debugLog("Add service button not found");
  }
}

// Add service/add-on to room
async function addService() {
  try {
    const roomNumberElement = document.getElementById("checkout-room-number");

    const roomNumber = roomNumberElement.textContent;

    if (!serviceName || !servicePrice) {
      showNotification("Error: Service form fields not found", "error");
      return;
    }

    const service = serviceName.value;
    const price = parseInt(servicePrice.value);

    // Get quantity from the input
    const quantityInput = document.getElementById("service-quantity");
    const quantity = quantityInput ? parseInt(quantityInput.value) || 1 : 1;

    if (!service) {
      showNotification("Please select a service", "error");
      return;
    }

    if (!price || price <= 0) {
      showNotification("Please enter a valid price", "error");
      return;
    }

    if (quantity <= 0) {
      showNotification("Please enter a valid quantity", "error");
      return;
    }

    // Disable button during processing
    const addServiceBtn = document.getElementById("add-service-btn");
    if (!addServiceBtn) {
      showNotification("Error: Add service button not found", "error");
      return;
    }

    addServiceBtn.disabled = true;
    addServiceBtn.innerHTML =
      '<span class="loader" style="width: 14px; height: 14px;"></span> Adding...';

    // Calculate total price
    const totalPrice = price * quantity;

    // Service name with quantity if more than 1
    const serviceWithQuantity =
      quantity > 1 ? `${service} × ${quantity}` : service;

    const response = await apiFetch("/add_on", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        room: roomNumber,
        item: serviceWithQuantity,
        price: totalPrice,
        unit_price: price,
        quantity: quantity,
        payment_method: servicePaymentMethod,
        accommodation_charge: isAccommodationCharge,
      }),
    });

    if (!response.ok) {
      throw new Error(`Server responded with status: ${response.status}`);
    }

    const result = await response.json();
    if (result.success) {
      // Patch local room state immediately — no need to wait for a full server round-trip
      if (rooms[roomNumber]) {
        if (!rooms[roomNumber].add_ons) rooms[roomNumber].add_ons = [];
        const nowDt = new Date();
        rooms[roomNumber].add_ons.push({
          room: roomNumber,
          item: serviceWithQuantity,
          price: totalPrice,
          unit_price: price,
          quantity: quantity,
          time: nowDt.toTimeString().slice(0, 5),
          date: nowDt.toISOString().split("T")[0],
          payment_method: servicePaymentMethod,
          transaction_type: "service",
          accommodation_charge: isAccommodationCharge,
        });
        // Balance increases only when service is billed to room (not paid now)
        if (servicePaymentMethod === "balance") {
          rooms[roomNumber].balance = (rooms[roomNumber].balance || 0) + totalPrice;
        }
      }
      updateCheckoutModal(roomNumber);
      renderRooms();
      debouncedFetchData(2000, roomNumber); // background sync + bust pay history cache

      // Show an appropriate message based on the payment method
      if (servicePaymentMethod === "balance") {
        showNotification(
          `Added ${serviceWithQuantity} (₹${totalPrice}) to balance`,
          "success",
        );
      } else {
        showNotification(
          `Added ${serviceWithQuantity} (₹${totalPrice}) - paid by ${servicePaymentMethod}`,
          "success",
        );
      }

      resetServiceForm();
    } else {
      showNotification(result.message || "Error adding service", "error");
    }
  } catch (error) {
    console.error("Error adding service:", error);
    showNotification(`Error adding service: ${error.message}`, "error");
  } finally {
    // Re-enable button
    const addServiceBtn = document.getElementById("add-service-btn");
    if (addServiceBtn) {
      addServiceBtn.disabled = false;
      addServiceBtn.innerHTML = "Add Service";
    }
  }
}

// Show edit time modal
// `options` (optional):
//   - onConfirm(newCheckInTime): if provided, the form-submit handler calls
//     this callback with the new "YYYY-MM-DD HH:MM" string and closes the
//     modal, INSTEAD OF hitting /update_checkin_time. Used by the check-in
//     modal to set the initial check-in time on a not-yet-checked-in room.
//   - title: optional header label (defaults to "Edit Check-in Time").
//   - submitLabel: optional submit-button label.
//
// When `options.onConfirm` is omitted, the legacy behaviour runs: server
// API call to update an already checked-in room, plus local state patch.
function showEditTimeModal(roomNumber, currentCheckInTime, options) {
  if (!editTimeModal) {
    debugLog("Edit time modal not found");
    return;
  }
  options = options || {};
  const _isCallbackMode = typeof options.onConfirm === "function";

  // Update header / submit label if the caller provided one.
  const _hdr = editTimeModal.querySelector(".modal-header h2");
  if (_hdr) _hdr.textContent = options.title || "Edit Check-in Time";

  // Parse the current check-in time
  let date = new Date();
  let time = "00:00";

  if (currentCheckInTime) {
    const parts = currentCheckInTime.split(" ");
    if (parts.length === 2) {
      date = new Date(parts[0]);
      time = parts[1];
    }
  }

  // Format date for the input field (YYYY-MM-DD)
  const formattedDate = date.toISOString().split("T")[0];

  // Set the values in the form
  const newCheckinDate = document.getElementById("new-checkin-date");
  const newCheckinTime = document.getElementById("new-checkin-time");

  // Compute today's date and current time for max constraints
  const nowForMax = new Date();
  const todayForMax = nowForMax.toISOString().split("T")[0];
  const currentHHMM = String(nowForMax.getHours()).padStart(2, "0") + ":" +
                      String(nowForMax.getMinutes()).padStart(2, "0");

  if (newCheckinDate) {
    newCheckinDate.value = formattedDate;
    newCheckinDate.max = todayForMax; // cannot pick a future date
  }
  if (newCheckinTime) {
    newCheckinTime.value = time;
    // If the current check-in date is today, cap time to now
    newCheckinTime.max = (formattedDate === todayForMax) ? currentHHMM : "23:59";
  }

  // When the date changes, update the time's max accordingly
  if (newCheckinDate) {
    newCheckinDate.onchange = function () {
      if (!newCheckinTime) return;
      const now2 = new Date();
      const today2 = now2.toISOString().split("T")[0];
      const nowHHMM2 = String(now2.getHours()).padStart(2, "0") + ":" +
                       String(now2.getMinutes()).padStart(2, "0");
      if (newCheckinDate.value === today2) {
        newCheckinTime.max = nowHHMM2;
        if (newCheckinTime.value > nowHHMM2) newCheckinTime.value = nowHHMM2;
      } else {
        newCheckinTime.max = "23:59";
      }
    };
  }

  // Setup the form submission
  const form = document.getElementById("edit-time-form");
  if (!form) {
    debugLog("Edit time form not found");
    return;
  }

  // Update the submit-button label if provided.
  const _submitBtnEarly = form.querySelector("button[type=submit]");
  if (_submitBtnEarly && options.submitLabel) {
    _submitBtnEarly.innerHTML = options.submitLabel;
  } else if (_submitBtnEarly && !options.submitLabel) {
    // Restore default label in case a previous open changed it.
    _submitBtnEarly.innerHTML = "Update Check-in Time";
  }

  form.onsubmit = async (e) => {
    e.preventDefault();

    try {
      const newDate = document.getElementById("new-checkin-date").value;
      const newTime = document.getElementById("new-checkin-time").value;
      const newCheckInTime = `${newDate} ${newTime}`;

      // Validate: check-in time must not be in the future
      const selectedDt = new Date(`${newDate}T${newTime}`);
      if (selectedDt > new Date()) {
        showNotification("Check-in time cannot be set to a future time.", "error");
        return;
      }

      // Callback mode — used by the check-in modal. The room isn't
      // checked in yet, so there's no /update_checkin_time call to make.
      // The callback returns true on accept, false on reject. We only
      // close the modal on accept so the user can correct rejected input
      // (e.g. picked a previous day) without reopening the picker.
      if (_isCallbackMode) {
        let accepted = false;
        try {
          const ret = options.onConfirm(newCheckInTime);
          accepted = ret !== false; // undefined / true → accept; false → reject
        } catch (cbErr) {
          console.error("onConfirm callback threw:", cbErr);
          accepted = false;
        }
        if (accepted) {
          editTimeModal.classList.remove("show");
        }
        return;
      }

      // Disable submit button and show loading state
      const submitBtn = form.querySelector("button[type=submit]");
      if (!submitBtn) {
        debugLog("Submit button not found in edit time form");
        return;
      }

      const originalContent = submitBtn.innerHTML;
      submitBtn.disabled = true;
      submitBtn.innerHTML =
        '<span class="loader" style="width: 20px; height: 20px;"></span> Updating...';

      const response = await apiFetch("/update_checkin_time", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          room: roomNumber,
          checkin_time: newCheckInTime,
        }),
      });

      if (!response.ok) {
        throw new Error(`Server responded with status: ${response.status}`);
      }

      const result = await response.json();
      if (result.success) {
        editTimeModal.classList.remove("show");

        // If the date portion changed, fix the serial number counter so the
        // old date slot is released and the new date gets a fresh serial.
        const oldCheckinTime = rooms[roomNumber] && rooms[roomNumber].checkin_time;
        if (oldCheckinTime && window.transactionTracker) {
          const oldDate = oldCheckinTime.split(" ")[0];
          const newDate = newCheckInTime.split(" ")[0];
          if (oldDate !== newDate) {
            window.transactionTracker.reassignCheckinDate(roomNumber, oldDate, newDate);
          }
        }

        // Patch local state — preserve renewal_count unless the DATE changed
        if (rooms[roomNumber]) {
          const oldDatePart = (rooms[roomNumber].checkin_time || "").split(" ")[0];
          const newDatePart = newCheckInTime.split(" ")[0];
          rooms[roomNumber].checkin_time = newCheckInTime;
          if (oldDatePart !== newDatePart) {
            // Date changed — reset renewal cycle (backend does the same)
            rooms[roomNumber].renewal_count     = 0;
            rooms[roomNumber].last_renewal_date = null;
          }
          // Track edit count locally
          rooms[roomNumber].checkin_time_edit_count =
            (rooms[roomNumber].checkin_time_edit_count || 0) + 1;
        }
        renderRooms();

        // Update the checkout modal with new data
        const checkoutCheckinTime = document.getElementById(
          "checkout-checkin-time",
        );
        if (checkoutCheckinTime) {
          checkoutCheckinTime.textContent = newCheckInTime;
        }

        showNotification("Check-in time updated successfully!", "success");

        // Notify register & bills modules to refresh their data
        window.dispatchEvent(new CustomEvent("cibaraRoomUpdate", { detail: { type: "checkin_time_edit" } }));
      } else {
        showNotification(
          result.message || "Error updating check-in time",
          "error",
        );
      }
    } catch (error) {
      console.error("Error updating check-in time:", error);
      showNotification(
        `Error updating check-in time: ${error.message}`,
        "error",
      );
    } finally {
      // Re-enable submit button
      const submitBtn = form.querySelector("button[type=submit]");
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = "Update Check-in Time";
      }
    }
  };

  // Show the modal
  editTimeModal.classList.add("show");
}

// Show detailed room info modal
function showRoomDetailsModal(roomNumber) {
  if (!roomDetailsModal) {
    debugLog("Room details modal not found");
    return;
  }

  const contentDiv = document.getElementById("room-details-content");
  const roomNumberSpan = document.getElementById("detail-room-number");

  if (!contentDiv || !roomNumberSpan) {
    debugLog("Room details elements not found");
    return;
  }

  roomNumberSpan.textContent = roomNumber;

  // Show loading indicator
  contentDiv.innerHTML = `<div class="loading-indicator"><span class="loader"></span></div>`;

  setTimeout(() => {
    const info = rooms[roomNumber];

    if (!info) {
      contentDiv.innerHTML = `
        <div class="empty-state">
          <p>Room information not available</p>
        </div>
      `;
      return;
    }

    let html = "";

    if (info.status === "vacant") {
      html = `
        <div class="summary-card" style="margin-bottom: 0;">
          <div class="summary-title">Room Details</div>
          <div class="summary-row">
            <div class="summary-label">Status</div>
            <div class="summary-value">
              <span style="color: var(--vacant); font-weight: bold;">Vacant</span>
            </div>
          </div>
          <div class="summary-row">
            <div class="summary-label">Floor</div>
            <div class="summary-value">${
              roomNumber.startsWith("2") ? "Second Floor" : "First Floor"
            }</div>
          </div>
        </div>
      `;
    } else if (info.status === "occupied" && info.guest) {
      // Get renewal status
      const renewalStatus = getRoomRenewalStatus(info);

      // Format check-in time
      const checkinDate = new Date(info.checkin_time);
      const formattedCheckin = info.checkin_time;

      // Calculate stay duration
      const now = new Date();
      const duration = Math.floor((now - checkinDate) / (1000 * 60 * 60 * 24));
      const hours = Math.floor(
        ((now - checkinDate) % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60),
      );

      html = `
        <div class="summary-card" style="margin-bottom: 1rem;">
          <div class="summary-title">Room Details</div>
          <div class="summary-row">
            <div class="summary-label">Status</div>
            <div class="summary-value">
              <span style="color: var(--occupied); font-weight: bold;">Occupied</span>
            </div>
          </div>
          <div class="summary-row">
            <div class="summary-label">Guest</div>
            <div class="summary-value">${info.guest.name}</div>
          </div>
          <div class="summary-row">
            <div class="summary-label">Mobile</div>
            <div class="summary-value">
              <a href="tel:${info.guest.mobile}" class="call-link">
                <i class="fas fa-phone"></i> ${info.guest.mobile}
              </a>
            </div>
          </div>
          <div class="summary-row">
            <div class="summary-label">Check-in</div>
            <div class="summary-value">${formattedCheckin}</div>
          </div>
          <div class="summary-row">
            <div class="summary-label">Stay Duration</div>
            <div class="summary-value">${duration} days, ${hours} hours</div>
          </div>
          <div class="summary-row">
            <div class="summary-label">Stay Status</div>
            <div class="summary-value">Day ${renewalStatus.dayNumber}</div>
          </div>
          <div class="summary-row">
            <div class="summary-label">Room Price</div>
            <div class="summary-value">₹${info.guest.price}</div>
          </div>
          <div class="summary-row">
            <div class="summary-label">Balance</div>
            <div class="summary-value" style="${
              info.balance < 0
                ? "color: var(--success)"
                : info.balance > 0
                  ? "color: var(--danger)"
                  : ""
            }">
              ₹${Math.abs(info.balance)}${
                info.balance < 0
                  ? " (refund)"
                  : info.balance > 0
                    ? " (due)"
                    : ""
              }
            </div>
          </div>
        </div>
      `;

      // If there are add-ons, show them
      if (info.add_ons && info.add_ons.length > 0) {
        html += `
          <div class="summary-card" style="margin-bottom: 0;">
            <div class="summary-title">Add-on Services</div>
        `;

        info.add_ons.forEach((addon) => {
          html += `
            <div class="summary-row">
              <div class="summary-label">${addon.item}</div>
              <div class="summary-value">₹${addon.price}</div>
            </div>
          `;
        });

        html += `</div>`;
      }
    }

    contentDiv.innerHTML = html;

    // Configure action buttons
    const checkinBtn = document.getElementById("room-details-checkin-btn");
    const checkoutBtn = document.getElementById("room-details-checkout-btn");

    if (!checkinBtn || !checkoutBtn) {
      debugLog("Room details action buttons not found");
      return;
    }

    if (info.status === "vacant") {
      checkinBtn.style.display = "block";
      checkoutBtn.style.display = "none";

      checkinBtn.onclick = () => {
        roomDetailsModal.classList.remove("show");
        showCheckinModal(roomNumber);
      };
    } else {
      checkinBtn.style.display = "none";
      checkoutBtn.style.display = "block";

      checkoutBtn.onclick = () => {
        roomDetailsModal.classList.remove("show");
        showCheckoutModal(roomNumber);
      };
    }
  }, 300);

  roomDetailsModal.classList.add("show");
}

async function generateReport() {
  // Just call the enhanced report function in analytics.js
  if (typeof generateEnhancedReport === "function") {
    generateEnhancedReport();
  } else {
    console.error("Enhanced report generation function not found");
    showNotification("Error: Analytics module not loaded properly", "error");
  }
}

// Function to populate room dropdown
async function populateRoomDropdown() {
  const dropdown = document.getElementById("checkin-room-dropdown");
  if (!dropdown) {
    debugLog("Room dropdown not found");
    return;
  }

  // Clear existing options
  dropdown.innerHTML = "";

  try {
    // Get all room numbers
    const response = await apiFetch("/get_room_numbers");
    if (!response.ok) {
      throw new Error(`Server responded with status: ${response.status}`);
    }

    const data = await response.json();
    if (data.success) {
      // Add room numbers to dropdown
      data.rooms.forEach((roomNumber) => {
        // Skip occupied rooms
        if (rooms[roomNumber] && rooms[roomNumber].status === "occupied") {
          return;
        }

        const option = document.createElement("option");
        option.value = roomNumber;
        option.textContent = roomNumber;
        dropdown.appendChild(option);
      });
    } else {
      debugLog("Failed to get room numbers: " + data.message);
    }
  } catch (error) {
    console.error("Error fetching room numbers:", error);
  }
}

// Update the showCheckinModal function to use the dropdown
function showCheckinModal(selectedRoomNumber) {
  if (!checkinModal) {
    debugLog("Check-in modal not found");
    return;
  }

  // Populate room dropdown first
  populateRoomDropdown().then(() => {
    // Set the selected room number
    const dropdown = document.getElementById("checkin-room-dropdown");
    if (dropdown) {
      // Find the option with the matching room number
      const option = Array.from(dropdown.options).find(
        (opt) => opt.value === selectedRoomNumber,
      );

      if (option) {
        dropdown.value = selectedRoomNumber;
      } else if (dropdown.options.length > 0) {
        // If the room isn't in the list (might be occupied), select the first available
        dropdown.selectedIndex = 0;
      }
    }

    // Reset form fields
    const checkinForm = document.getElementById("checkin-form");
    if (checkinForm) {
      checkinForm.reset();
    }

    // Reset the check-in time row to "Now" each time the modal opens.
    // The hidden input stays empty until staff clicks the edit icon and
    // picks a different time — at which point we store "YYYY-MM-DD HH:MM".
    // An empty hidden input means "use server-side now()".
    const _ctHidden  = document.getElementById("checkin-time-input");
    const _ctDisplay = document.getElementById("checkin-time-display");
    if (_ctHidden)  _ctHidden.value = "";
    if (_ctDisplay) {
      const _n = new Date();
      const _pad = (x) => String(x).padStart(2, "0");
      _ctDisplay.textContent =
        `Now (${_pad(_n.getHours())}:${_pad(_n.getMinutes())})`;
      _ctDisplay.style.color = "#1a202c";
    }

    const paymentMethodInput = document.getElementById("payment-method");
    if (paymentMethodInput) {
      paymentMethodInput.value = "cash";
    }

    const photoPreviewContainer = document.getElementById(
      "photo-preview-container",
    );
    if (photoPreviewContainer) {
      photoPreviewContainer.style.display = "none";
    }

    const cameraContainer = document.getElementById("camera-container");
    if (cameraContainer) {
      cameraContainer.style.display = "none";
    }

    // Make sure cash is the default active payment method
    document.querySelectorAll(".payment-btn").forEach((btn) => {
      btn.classList.remove("active");
    });

    const cashBtn = document.querySelector('.payment-btn[data-payment="cash"]');
    if (cashBtn) {
      cashBtn.classList.add("active");
    }

    // Reset captured photo data
    capturedPhotoData = null;
    uploadedPhotoUrl = null;

    checkinModal.classList.add("show");
  });
}

function updatePaymentOrRefundUI(roomNumber) {
  if (!paymentOrRefundSection) {
    debugLog("Payment or refund section not found");
    return;
  }

  const roomInfo = rooms[roomNumber];
  const balance = roomInfo.balance;

  // MMT/OTA bookings: no payment to collect at hotel — settlement comes from OTA
  const isOtaGuest = roomInfo.guest && roomInfo.guest.payment === "ota";
  if (isOtaGuest) {
    paymentOrRefundSection.innerHTML = `
      <div style="background:rgba(99,179,237,0.12);border:1px solid rgba(99,179,237,0.3);
                  border-radius:8px;padding:0.75rem 1rem;margin-top:1rem;
                  color:#63b3ed;font-size:0.85rem;text-align:center;">
        <i class="fas fa-info-circle"></i>&nbsp;MMT Prepaid — Settlement will be received from MMT directly.
      </div>`;
    return;
  }

  // Clear previous content
  paymentOrRefundSection.innerHTML = "";

  if (balance >= 0) {
    // Show payment UI for both positive balance and zero balance
    paymentOrRefundSection.innerHTML = `
      <div class="form-group" style="margin-top: 1.5rem">
        <label class="form-label">Add Payment</label>
        <div class="payment-button-wrapper">
          <input
            type="number"
            class="form-control payment-amount-input"
            id="checkout-payment-amount"
            placeholder="Amount"
            value="${balance || ""}"
            min="1"
          />
          <div class="payment-options" style="margin-top: 0.5rem;">
            <button
              type="button"
              class="payment-btn cash active"
              id="checkout-cash-btn"
            >
              <i class="fas fa-money-bill"></i> Cash
            </button>
            <button
              type="button"
              class="payment-btn online"
              id="checkout-online-btn"
            >
              <i class="fas fa-mobile-alt"></i> Online
            </button>
            <div class="payment-button-row">
            <button
              type="button"
              class="payment-add-btn"
              id="add-payment-btn"
            >
              <i class="fas fa-plus-circle"></i> Add Payment
            </button>
          </div>
          </div>
        </div>
      </div>
    `;

    // Add click handlers for the payment buttons
    const addPaymentBtn = document.getElementById("add-payment-btn");
    if (addPaymentBtn) {
      addPaymentBtn.addEventListener("click", function () {
        // Find which payment method is active
        const activeMethod = document
          .querySelector("#checkout-cash-btn")
          .classList.contains("active")
          ? "cash"
          : "online";

        addPayment(activeMethod);
      });
    }

    // Re-attach event listeners for payment method selection
    const cashBtn = document.getElementById("checkout-cash-btn");
    if (cashBtn) {
      cashBtn.addEventListener("click", function () {
        document
          .getElementById("checkout-online-btn")
          .classList.remove("active");
        cashBtn.classList.add("active");
      });
    }

    const onlineBtn = document.getElementById("checkout-online-btn");
    if (onlineBtn) {
      onlineBtn.addEventListener("click", function () {
        document.getElementById("checkout-cash-btn").classList.remove("active");
        onlineBtn.classList.add("active");
      });
    }
  } else if (balance < 0) {
    // Show refund UI for negative balance with custom input
    const refundAmount = Math.abs(balance);
    paymentOrRefundSection.innerHTML = `
      <div class="refund-container">
        <div class="refund-title">
          <i class="fas fa-hand-holding-usd"></i> Refund Required
        </div>
        <div class="detail-row">
          <div class="detail-label">Available Refund</div>
          <div class="detail-value negative-balance">₹${refundAmount}</div>
        </div>
        <div class="form-group" style="margin-top: 1rem">
          <label class="form-label" for="refund-amount-input">Refund Amount (₹)</label>
          <input
            type="number"
            class="form-control"
            id="refund-amount-input"
            placeholder="Enter refund amount"
            value="${refundAmount}"
            min="1"
            max="${refundAmount}"
            required
          />
          <div class="form-helper" style="margin-top: 0.25rem; font-size: 0.8rem; color: var(--gray);">
            Maximum available refund: ₹${refundAmount}
          </div>
        </div>
        <div class="form-group" style="margin-top: 1rem">
          <label class="form-label">Refund Method</label>
          <div class="payment-options">
            <button
              type="button"
              class="payment-btn cash active"
              id="refund-cash-btn"
            >
              <i class="fas fa-money-bill"></i> Cash
            </button>
            <button
              type="button"
              class="payment-btn online"
              id="refund-online-btn"
            >
              <i class="fas fa-mobile-alt"></i> Online
            </button>
          </div>
        </div>
        <div id="refund-error-message" class="error-message" style="color: var(--danger); margin-top: 0.5rem; display: none;"></div>
        <button id="process-refund-btn" class="action-btn btn-warning">
          Process Refund
        </button>
      </div>

      <div class="refund-add-payment-divider">
        <span>or add a payment</span>
      </div>

      <div class="form-group refund-add-payment-section">
        <label class="form-label">Add Payment</label>
        <div class="payment-button-wrapper">
          <input
            type="number"
            class="form-control payment-amount-input"
            id="checkout-payment-amount"
            placeholder="Amount"
            min="1"
          />
          <div class="payment-options" style="margin-top: 0.5rem;">
            <button type="button" class="payment-btn cash active" id="checkout-cash-btn">
              <i class="fas fa-money-bill"></i> Cash
            </button>
            <button type="button" class="payment-btn online" id="checkout-online-btn">
              <i class="fas fa-mobile-alt"></i> Online
            </button>
            <div class="payment-button-row">
              <button type="button" class="payment-add-btn" id="add-payment-btn">
                <i class="fas fa-plus-circle"></i> Add Payment
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    // Refund method selection
    document
      .querySelectorAll(".refund-container .payment-btn")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          document
            .querySelectorAll(".refund-container .payment-btn")
            .forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
        });
      });

    // Process refund button
    const processRefundBtn = document.getElementById("process-refund-btn");
    if (processRefundBtn) {
      processRefundBtn.addEventListener("click", processRefund);
    }

    // Add listener to validate refund amount on input change
    const refundInput = document.getElementById("refund-amount-input");
    if (refundInput) {
      refundInput.addEventListener("input", function () {
        const value = parseInt(this.value) || 0;
        const errorElement = document.getElementById("refund-error-message");
        if (errorElement) {
          if (value <= 0) {
            errorElement.textContent =
              "Please enter a valid amount greater than 0";
            errorElement.style.display = "block";
          } else if (value > refundAmount) {
            errorElement.textContent = `Maximum refund amount is ₹${refundAmount}`;
            errorElement.style.display = "block";
          } else {
            errorElement.style.display = "none";
          }
        }
      });
    }

    // Add payment section handlers (below refund)
    const cashBtn = document.getElementById("checkout-cash-btn");
    const onlineBtn = document.getElementById("checkout-online-btn");
    const addPaymentBtn = document.getElementById("add-payment-btn");

    if (cashBtn) {
      cashBtn.addEventListener("click", function () {
        onlineBtn && onlineBtn.classList.remove("active");
        cashBtn.classList.add("active");
      });
    }
    if (onlineBtn) {
      onlineBtn.addEventListener("click", function () {
        cashBtn && cashBtn.classList.remove("active");
        onlineBtn.classList.add("active");
      });
    }
    if (addPaymentBtn) {
      addPaymentBtn.addEventListener("click", function () {
        const activeMethod =
          cashBtn && cashBtn.classList.contains("active") ? "cash" : "online";
        addPayment(activeMethod);
      });
    }
  }
}

async function processRefund() {
  try {
    // Get room number
    const roomNumberElement = document.getElementById("checkout-room-number");

    const roomNumber = roomNumberElement.textContent;

    // Get guest information for logging
    const guestName =
      document.getElementById("checkout-guest-name")?.textContent || "Unknown";

    // Get refund amount from input
    const refundAmountInput = document.getElementById("refund-amount-input");
    if (!refundAmountInput) {
      showNotification("Error: Refund amount input not found", "error");
      return;
    }

    // Parse and validate refund amount
    const refundAmount = parseInt(refundAmountInput.value) || 0;
    const maxRefundAmount = Math.abs(rooms[roomNumber].balance);

    // Validate the refund amount
    if (refundAmount <= 0) {
      showNotification(
        "Please enter a valid refund amount greater than 0",
        "error",
      );
      return;
    }

    if (refundAmount > maxRefundAmount) {
      showNotification(
        `Refund amount cannot exceed ₹${maxRefundAmount}`,
        "error",
      );
      return;
    }

    // Get refund method
    const refundMethod =
      document.querySelector(".refund-container .payment-btn.active")?.id ===
      "refund-cash-btn"
        ? "cash"
        : "online";

    // Show loading state on button
    const btn = document.getElementById("process-refund-btn");
    if (!btn) {
      showNotification("Error: Process refund button not found", "error");
      return;
    }

    btn.disabled = true;
    btn.innerHTML =
      '<span class="loader" style="width: 20px; height: 20px;"></span> Processing...';

    // Clear any previous error messages
    const errorElement = document.getElementById("refund-error-message");
    if (errorElement) {
      errorElement.style.display = "none";
    }

    debugLog(
      `Processing refund of ₹${refundAmount} via ${refundMethod} for room ${roomNumber}`,
    );

    // Make API request with all necessary information
    const response = await apiFetch("/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        room: roomNumber,
        name: guestName, // Include guest name for proper logging
        payment_mode: refundMethod,
        amount: refundAmount,
        is_refund: true,
        process_refund: true,
        time: new Date().toTimeString().split(" ")[0].slice(0, 5), // Current time in HH:MM format
        date: new Date().toISOString().split("T")[0], // Current date in YYYY-MM-DD format
      }),
    });

    if (!response.ok) {
      throw new Error(`Server responded with status: ${response.status}`);
    }

    const result = await response.json();

    if (result.success) {
      // Refund was successful
      debugLog(`Refund processed successfully: ${JSON.stringify(result)}`);

      // Patch local balance immediately (refund increases balance back toward 0)
      if (rooms[roomNumber]) {
        rooms[roomNumber].balance = (rooms[roomNumber].balance || 0) + refundAmount;
      }
      debouncedFetchData(2000, roomNumber); // background sync + bust pay history cache

      // Update the checkout modal with new data
      updateCheckoutModal(roomNumber);

      // Show success notification
      showNotification(
        `Refund of ₹${refundAmount} processed successfully via ${refundMethod}!`,
        "success",
      );
    } else {
      // Show error from server
      if (errorElement) {
        errorElement.textContent =
          result.message || "Error processing refund. Please try again.";
        errorElement.style.display = "block";
      }

      showNotification(result.message || "Error processing refund", "error");
    }
  } catch (error) {
    console.error("Error processing refund:", error);

    // Show error in the form
    const errorElement = document.getElementById("refund-error-message");
    if (errorElement) {
      errorElement.textContent = `Error: ${error.message}`;
      errorElement.style.display = "block";
    }

    showNotification(`Error processing refund: ${error.message}`, "error");
  } finally {
    // Always re-enable the button
    const btn = document.getElementById("process-refund-btn");
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = "Process Refund";
    }
  }
}

async function addPayment(mode) {
  try {
    const roomNumberElement = document.getElementById("checkout-room-number");
    const roomNumber = roomNumberElement.textContent;
    const amountInput = document.getElementById("checkout-payment-amount");

    if (!amountInput) {
      showNotification("Error: Payment amount field not found", "error");
      return;
    }

    const amount = parseInt(amountInput.value);

    if (!amount || amount <= 0) {
      showNotification("Please enter a valid amount", "error");
      return;
    }

    // Find which button to use based on mode
    let btn = null;

    // First try to get the add payment button
    const addPaymentBtn = document.getElementById("add-payment-btn");
    if (addPaymentBtn) {
      btn = addPaymentBtn;
    } else {
      // Fall back to individual payment buttons
      btn = document.getElementById(`checkout-${mode}-btn`);
    }

    // Show loading state if the button exists
    let originalContent = "";
    if (btn) {
      originalContent = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML =
        '<span class="loader" style="width: 14px; height: 14px;"></span> Processing...';
    } else {
      console.warn(
        `Button for payment mode ${mode} not found, proceeding anyway`,
      );
    }

    // ── Capture balance NOW, before the async API call ─────────────────────
    // Firestore onSnapshot (WebSocket) can fire and update rooms[room].balance
    // to the server's new value *before* the HTTP response arrives.  If we
    // read rooms[room].balance after the response we'd be subtracting `amount`
    // from an already-updated balance, producing a spurious negative (refund).
    const balanceBeforePayment = (rooms[roomNumber] && rooms[roomNumber].balance != null)
      ? rooms[roomNumber].balance
      : 0;
    // ────────────────────────────────────────────────────────────────────────

    // Proceed with payment API call - using the fixed backend endpoint
    const response = await apiFetch("/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        room: roomNumber,
        payment_mode: mode,
        amount: amount,
        is_refund: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Server responded with status: ${response.status}`);
    }

    const result = await response.json();
    if (result.success) {
      // Patch local balance using the pre-request snapshot (race-condition safe).
      // Simple subtraction mirrors the server: new_balance = old_balance - amount.
      if (rooms[roomNumber]) {
        rooms[roomNumber].balance = balanceBeforePayment - amount;
      }
      debouncedFetchData(2000, roomNumber); // background sync + bust pay history cache

      // Update the checkout modal
      updateCheckoutModal(roomNumber);

      showNotification(
        result.message || `Payment of ₹${amount} added successfully`,
        "success",
      );
    } else {
      showNotification(result.message || "Error adding payment", "error");
    }
  } catch (error) {
    console.error("Error adding payment:", error);
    showNotification(`Error adding payment: ${error.message}`, "error");
  } finally {
    // Re-enable buttons if they exist
    const addPaymentBtn = document.getElementById("add-payment-btn");
    const cashBtn = document.getElementById("checkout-cash-btn");
    const onlineBtn = document.getElementById("checkout-online-btn");

    if (addPaymentBtn) {
      addPaymentBtn.disabled = false;
      addPaymentBtn.innerHTML =
        '<i class="fas fa-plus-circle"></i> Add Payment';
    }

    if (cashBtn) {
      cashBtn.disabled = false;
      cashBtn.innerHTML = '<i class="fas fa-money-bill"></i> Cash';
    }

    if (onlineBtn) {
      onlineBtn.disabled = false;
      onlineBtn.innerHTML = '<i class="fas fa-mobile-alt"></i> Online';
    }
  }
}

// Upload photo to server
async function uploadPhoto(file) {
  try {
    const formData = new FormData();
    formData.append("photo", file);

    const response = await apiFetch("/upload_photo", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Server responded with status: ${response.status}`);
    }

    const result = await response.json();
    if (result.success) {
      uploadedPhotoUrl = result.path;
    } else {
      showNotification(result.message || "Error uploading photo", "error");
    }
  } catch (error) {
    console.error("Error uploading photo:", error);
    showNotification(`Error uploading photo: ${error.message}`, "error");
  }
}

function updateServiceTotalPrice() {
  const priceInput = document.getElementById("service-price");
  const quantityInput = document.getElementById("service-quantity");
  const totalPriceElement = document.getElementById("service-total-price");

  if (priceInput && quantityInput && totalPriceElement) {
    const price = parseInt(priceInput.value) || 0;
    const quantity = parseInt(quantityInput.value) || 1;
    const totalPrice = price * quantity;

    totalPriceElement.textContent = `₹${totalPrice}`;
  }
}

// ── Room → category source of truth ──────────────────────────────────────────
// Canonical mapping used by BOTH calculatePrice() and getRoomCategory().
// Adding or moving a room only requires editing this one map.
//
// Notes on AC handling:
//   • 200–206 are returned here as base category "premium". The AC-aware
//     variant ("premium-ac") is computed at call-time by
//     getRoomCategoryWithAC(roomNumber, isAC). This keeps the source of
//     truth simple and prevents "Premium AC Room" labels from being
//     applied to non-AC stays.
//   • Rooms not in this map (e.g., 6–12, 21, 22 — not part of the
//     property's published room list) fall back to category "other" /
//     label "Other" / fallback price.
const _ROOM_CATEGORY_MAP = (function () {
  const m = new Map();
  // First-floor: Single Non-Attach (1, 2, 3, 4, 5, 13–20)
  [1, 2, 3, 4, 5].forEach((n) => m.set(String(n), "single-non-attach"));
  for (let n = 13; n <= 20; n++) m.set(String(n), "single-non-attach");
  // First-floor: Double Non-Attach (23–27)
  for (let n = 23; n <= 27; n++) m.set(String(n), "double-non-attach");
  // Second-floor: Premium (200–206 — AC toggle elsewhere)
  for (let n = 200; n <= 206; n++) m.set(String(n), "premium");
  // Second-floor: Regular (207, 208–211, 215, 220–222)
  m.set("207", "regular");
  for (let n = 208; n <= 211; n++) m.set(String(n), "regular");
  m.set("215", "regular");
  for (let n = 220; n <= 222; n++) m.set(String(n), "regular");
  // Second-floor: Deluxe (223–227)
  for (let n = 223; n <= 227; n++) m.set(String(n), "deluxe");
  // Second-floor: Single Attach (212–214, 216–219)
  for (let n = 212; n <= 214; n++) m.set(String(n), "single-attach");
  for (let n = 216; n <= 219; n++) m.set(String(n), "single-attach");
  // Party Hall (228)
  m.set("228", "party-hall");
  return m;
})();

const _CATEGORY_LABELS = {
  "single-non-attach": "Single Non-Attach",
  "double-non-attach": "Double Non-Attach",
  "premium":           "Premium Room",
  "premium-ac":        "Premium AC Room",
  "regular":           "Regular Room",
  "deluxe":            "Deluxe Room",
  "single-attach":     "Single Attach",
  "party-hall":        "Party Hall",
  "other":             "Other",
};

// Display order used by analytics (left-to-right when not sorted by value).
const _CATEGORY_DISPLAY_ORDER = [
  "premium",
  "premium-ac",
  "regular",
  "deluxe",
  "single-attach",
  "single-non-attach",
  "double-non-attach",
  "party-hall",
];

// Room pricing configuration
const roomPricing = {
  // Compute the per-night base price for a room + guest count.
  // The AC surcharge (+₹600 for premium with AC toggle on) is layered on
  // separately by updateRoomPrice() — this function returns the non-AC base.
  calculatePrice: function (roomNumber, guestCount) {
    const key    = String(roomNumber);
    const guests = parseInt(guestCount) || 1;
    const cat    = _ROOM_CATEGORY_MAP.get(key) || "other";

    switch (cat) {
      case "single-non-attach":
        // 1, 2, 3, 4, 5, 13–20: ₹250 (single-occupancy rooms)
        return 250;
      case "double-non-attach":
        // 23–27: ₹300 for 1 guest, ₹500 for 2+
        return guests === 1 ? 300 : 500;
      case "premium":
        // 200–206: ₹1200 base for 2 guests, +₹300 per extra guest.
        // AC surcharge applied later by updateRoomPrice when toggle is on.
        return 1200 + Math.max(0, guests - 2) * 300;
      case "regular":
        // 207, 208–211, 215: ₹450 for 1 guest, ₹700 for 2 guests,
        // +₹300 per extra guest beyond 2. (207 was previously priced as
        // Premium — moved here to match its new Regular categorization.)
        //
        // 220, 221, 222: priced differently from the rest of Regular —
        // ₹700 base + ₹300 per extra guest beyond 1 (so ₹700 / ₹1000 /
        // ₹1300 / ₹1600 for 1/2/3/4 guests). Same "Regular Room" label
        // in the UI; the price divergence is intentional. Keep the
        // special case localised here so the category stays simple.
        if (key === "220" || key === "221" || key === "222") {
          return 700 + Math.max(0, guests - 1) * 300;
        }
        return guests === 1 ? 450 : 700 + Math.max(0, guests - 2) * 300;
      case "deluxe":
        // 223–227: ₹900 base for 2 guests, +₹300 per extra guest.
        return 900 + Math.max(0, guests - 2) * 300;
      case "single-attach":
        // 212–214, 216–219: ₹450 for 1, ₹700 for 2+ (no per-guest extra).
        return guests === 1 ? 450 : 700;
      case "party-hall":
      case "other":
      default:
        // Party hall (228) and any out-of-list room — keep prior default.
        return 500;
    }
  },

  // Return the BASE category (no AC awareness). Used by the check-in
  // form badge and other UI surfaces. For an AC-aware variant (used by
  // the analytics revenue-by-room-type chart), call
  // getRoomCategoryWithAC(roomNumber, isAC) instead.
  getRoomCategory: function (roomNumber) {
    const key = String(roomNumber);
    const cat = _ROOM_CATEGORY_MAP.get(key) || "other";
    return {
      category: cat,
      label:    _CATEGORY_LABELS[cat] || _CATEGORY_LABELS["other"],
      analytics: { type: cat },
    };
  },

  // AC-aware variant. Returns "premium-ac" only when the room is in the
  // premium range AND the guest's isAC flag is true. Anywhere else it
  // delegates to getRoomCategory().
  getRoomCategoryWithAC: function (roomNumber, isAC) {
    const base = this.getRoomCategory(roomNumber);
    if (base.category === "premium" && isAC) {
      return {
        category: "premium-ac",
        label:    _CATEGORY_LABELS["premium-ac"],
        analytics: { type: "premium-ac", isAC: true },
      };
    }
    return base;
  },

  // Expose the canonical display order so analytics can render bars in a
  // consistent left-to-right sequence when not sorted by value.
  CATEGORY_DISPLAY_ORDER: _CATEGORY_DISPLAY_ORDER,
  CATEGORY_LABELS:        _CATEGORY_LABELS,
};

// Initialize enhanced check-in form functionality
function initEnhancedCheckinForm() {
  const roomDropdown = document.getElementById("checkin-room-dropdown");
  const guestCountInput = document.getElementById("guest-count");
  const roomPriceInput = document.getElementById("room-price");
  const amountPaidInput = document.getElementById("amount-paid");
  const roomCategoryIndicator = document.getElementById("room-category");
  const acToggleContainer = document.getElementById("ac-toggle-container");
  const acToggle = document.getElementById("ac-toggle");

  // Handle room selection change
  if (roomDropdown) {
    roomDropdown.addEventListener("change", updateRoomInfo);
  }

  // Handle guest count change
  if (guestCountInput) {
    guestCountInput.addEventListener("change", updateRoomPrice);
    guestCountInput.addEventListener("input", updateRoomPrice);
  }

  // Handle AC toggle change
  if (acToggle) {
    acToggle.addEventListener("change", updateRoomPrice);
  }

  // Track when the user manually edits amount-paid or room-price
  // so auto-fill does not silently overwrite their values.
  if (amountPaidInput) {
    amountPaidInput.addEventListener("input", () => {
      amountPaidInput.dataset.userEdited = "true";
    });
  }
  if (roomPriceInput) {
    roomPriceInput.addEventListener("input", () => {
      // When price changes manually, also reset the amount to match
      // unless the user has already set a custom amount.
      if (amountPaidInput && amountPaidInput.dataset.userEdited !== "true") {
        amountPaidInput.value = roomPriceInput.value || 0;
      }
    });
  }

  // Update price when the form is first loaded
  function updateRoomInfo() {
    const selectedRoom = roomDropdown.value;

    // Update room category indicator
    if (roomCategoryIndicator && selectedRoom) {
      const category = roomPricing.getRoomCategory(selectedRoom);
      roomCategoryIndicator.textContent = category.label;
      roomCategoryIndicator.className =
        "room-category-indicator room-category-" + category.category;

      // Show AC toggle for premium rooms (200-206). 207 is now categorized
      // as Regular and uses the regular pricing bracket — no AC option.
      // This matches the room card AC indicator, the mid-stay "Add AC"
      // button, and the transfer-modal AC toggle (all already 200-206).
      if (acToggleContainer) {
        if (
          ["200", "201", "202", "203", "204", "205", "206"].includes(
            selectedRoom,
          )
        ) {
          acToggleContainer.style.display = "block";
          if (acToggle) {
            acToggle.checked = false; // AC toggle OFF by default

            // Update the room category label to "Premium Room" when AC is off by default
            if (roomCategoryIndicator) {
              roomCategoryIndicator.textContent = "Premium Room";
              roomCategoryIndicator.className =
                "room-category-indicator room-category-premium";
            }
          }
        } else {
          acToggleContainer.style.display = "none";
        }
      }

      // Store category data for analytics
      if (roomDropdown.dataset) {
        roomDropdown.dataset.roomCategory = category.analytics.type;
        roomDropdown.dataset.isAc = category.analytics.isAC || false;
      }

      // Set default guest count based on room number
      if (guestCountInput) {
        // Set default to 2 guests for specified rooms (double occupancy)
        if (
          (selectedRoom >= 200 && selectedRoom <= 211) ||
          selectedRoom == 215 ||
          (selectedRoom >= 223 && selectedRoom <= 227) ||
          (selectedRoom >= 23 && selectedRoom <= 27)
        ) {
          guestCountInput.value = 2;
        } else {
          // Default to 1 guest for other rooms
          guestCountInput.value = 1;
        }
      }
    }

    updateRoomPrice();
  }

  // Calculate and update room price based on room number and guest count
  function updateRoomPrice() {
    if (!roomDropdown || !guestCountInput || !roomPriceInput) return;

    const selectedRoom = roomDropdown.value;
    const guestCount = parseInt(guestCountInput.value) || 1;

    if (selectedRoom) {
      let price = roomPricing.calculatePrice(selectedRoom, guestCount);

      // For premium rooms (200-207)
      if (
        ["200", "201", "202", "203", "204", "205", "206", "207"].includes(
          selectedRoom,
        )
      ) {
        // Apply price adjustment based on AC toggle
        if (acToggle && acToggle.checked) {
          // Add 600 if AC is turned ON (1200 + 600 = 1800)
          price += 600;

          // Update the room category label to "Premium AC Room" when AC is on
          if (roomCategoryIndicator) {
            roomCategoryIndicator.textContent = "Premium AC Room";
            roomCategoryIndicator.className =
              "room-category-indicator room-category-premium-ac";
          }
        } else if (acToggle && !acToggle.checked) {
          // Keep base price (1200) when AC is off

          // Update the room category label to "Premium Room" when AC is off
          if (roomCategoryIndicator) {
            roomCategoryIndicator.textContent = "Premium Room";
            roomCategoryIndicator.className =
              "room-category-indicator room-category-premium";
          }
        }
      }

      roomPriceInput.value = price;

      // Update amount paid based on current payment method,
      // but only if the user has not manually changed the amount field.
      if (amountPaidInput) {
        const paymentMethodInput = document.getElementById("payment-method");
        const currentPaymentMethod = paymentMethodInput
          ? paymentMethodInput.value
          : "cash";
        const userEdited = amountPaidInput.dataset.userEdited === "true";

        if (currentPaymentMethod === "balance") {
          // Always keep amount as 0 for Pay Later
          amountPaidInput.value = 0;
        } else if (!userEdited) {
          // Only auto-fill if user hasn't typed a custom amount
          amountPaidInput.value = price;
        }
      }
    }
  }

  // Call this when the form is first opened
  document.addEventListener("checkinModalOpened", updateRoomInfo);
}

// Function to trigger when check-in modal is shown
function showEnhancedCheckinModal(roomNumber) {
  if (!checkinModal) {
    console.log("Check-in modal not found");
    return;
  }

  // Populate room dropdown first
  populateRoomDropdown().then(() => {
    // Set the selected room number
    const dropdown = document.getElementById("checkin-room-dropdown");
    if (dropdown) {
      // Find the option with the matching room number
      const option = Array.from(dropdown.options).find(
        (opt) => opt.value === roomNumber,
      );

      if (option) {
        dropdown.value = roomNumber;
      } else if (dropdown.options.length > 0) {
        // If the room isn't in the list (might be occupied), select the first available
        dropdown.selectedIndex = 0;
      }
    }

    // Reset form fields
    const checkinForm = document.getElementById("checkin-form");
    if (checkinForm) {
      checkinForm.reset();
    }

    // Reset photo elements
    const photoPreviewContainer = document.getElementById(
      "photo-preview-container",
    );
    if (photoPreviewContainer) {
      photoPreviewContainer.style.display = "none";
    }

    const cameraContainer = document.getElementById("camera-container");
    if (cameraContainer) {
      cameraContainer.style.display = "none";
    }

    // Reset captured photo data
    capturedPhotoData = null;
    uploadedPhotoUrl = null;

    // Make sure cash is the default active payment method
    document.querySelectorAll(".payment-btn").forEach((btn) => {
      btn.classList.remove("active");
    });

    const cashBtn = document.querySelector('.payment-btn[data-payment="cash"]');
    if (cashBtn) {
      cashBtn.classList.add("active");
    }

    const paymentMethodInput = document.getElementById("payment-method");
    if (paymentMethodInput) {
      paymentMethodInput.value = "cash";
    }

    // Reset user-edited flags so auto-fill works fresh on each modal open
    const amountPaidInputReset = document.getElementById("amount-paid");
    if (amountPaidInputReset) {
      amountPaidInputReset.dataset.userEdited = "false";
    }
    const roomPriceInputReset = document.getElementById("room-price");
    if (roomPriceInputReset) {
      roomPriceInputReset.dataset.userEdited = "false";
    }

    // Update room info based on selected room
    const event = new Event("checkinModalOpened");
    document.dispatchEvent(event);

    // Show the modal
    checkinModal.classList.add("show");
  });
}

// Initialize collapsible stats functionality
function initCollapsibleStats() {
  const statsToggle = document.getElementById("stats-toggle");
  const statsContainer = document.getElementById("stats-container");

  if (!statsToggle || !statsContainer) {
    console.log("Stats toggle elements not found");
    return;
  }

  // Add click event to toggle stats visibility
  statsToggle.addEventListener("click", function () {
    // Toggle active class on the button
    this.classList.toggle("active");

    // Toggle hidden class on the stats container
    statsContainer.classList.toggle("hidden");

    // Save state to localStorage
    const isVisible = !statsContainer.classList.contains("hidden");
    localStorage.setItem("statsVisible", isVisible ? "true" : "false");
  });
}

// Function to restore stats visibility from localStorage
function restoreStatsVisibility() {
  const statsToggle = document.getElementById("stats-toggle");
  const statsContainer = document.getElementById("stats-container");

  if (!statsToggle || !statsContainer) return;

  // Get saved preference (default to hidden if not set)
  const isVisible = localStorage.getItem("statsVisible") === "true";

  if (isVisible) {
    statsToggle.classList.add("active");
    statsContainer.classList.remove("hidden");
  } else {
    statsToggle.classList.remove("active");
    statsContainer.classList.add("hidden");
  }
}

// Update stats toggle badge to show important information
function updateStatsToggleBadge() {
  const statsToggle = document.getElementById("stats-toggle");
  const statsContainer = document.getElementById("stats-container");

  if (
    !statsToggle ||
    !statsContainer ||
    !statsContainer.classList.contains("hidden")
  ) {
    return; // Only add badge when stats are hidden
  }

  let renewalsDue = 0;

  // Count rooms due for renewal
  Object.values(rooms).forEach((room) => {
    if (room.status === "occupied") {
      const renewalStatus = getRoomRenewalStatus(room);
      if (renewalStatus.canRenew) {
        renewalsDue++;
      }
    }
  });
}

function displayDailyStatistics() {
  const today = new Date().toISOString().split("T")[0];
  const todayCount = dailyCounters[today] || 0;

  console.log(`Today's fresh check-ins: ${todayCount}`);

  // You can add this to your dashboard if needed
  const statsElement = document.getElementById("daily-checkin-count");
  if (statsElement) {
    statsElement.textContent = todayCount;
  }
}

// ── Manager Access Modal — shared gate for Reports & Discount ─────────────────
let reportPasswordVerified = false;   // stays true once unlocked per session
let _mgrAccessCallback = null;        // called on successful password entry

/**
 * Open the manager access modal.
 * @param {string} title   - Modal heading
 * @param {string} sub     - Sub-text below heading
 * @param {string} icon    - FontAwesome class for the icon (e.g. "fa-chart-bar")
 * @param {Function} onSuccess - Called with no arguments when password is correct
 */
function openMgrAccessModal(title, sub, icon, onSuccess) {
  const modal   = document.getElementById("mgr-access-modal");
  const titleEl = document.getElementById("mgr-access-title");
  const subEl   = document.getElementById("mgr-access-sub");
  const iconEl  = document.getElementById("mgr-access-icon");
  const pwdEl   = document.getElementById("mgr-access-pwd");
  const errEl   = document.getElementById("mgr-access-error");
  if (!modal) return;

  if (titleEl) titleEl.textContent = title;
  if (subEl)   subEl.textContent   = sub;
  if (iconEl)  iconEl.innerHTML    = `<i class="fas ${icon}"></i>`;
  if (pwdEl)   { pwdEl.value = ""; }
  if (errEl)   { errEl.textContent = ""; errEl.style.display = "none"; }

  _mgrAccessCallback = onSuccess;
  modal.classList.add("show");
  setTimeout(() => pwdEl && pwdEl.focus(), 120);
}

function closeMgrAccessModal() {
  const modal = document.getElementById("mgr-access-modal");
  if (modal) modal.classList.remove("show");
  _mgrAccessCallback = null;
}

async function submitMgrAccessPassword() {
  const pwdEl    = document.getElementById("mgr-access-pwd");
  const errEl    = document.getElementById("mgr-access-error");
  const submitBtn = document.getElementById("mgr-access-submit");
  const pass = pwdEl ? pwdEl.value.trim() : "";

  if (!pass) {
    if (errEl) { errEl.textContent = "Please enter the password."; errEl.style.display = "block"; }
    return;
  }

  if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin" style="margin-right:5px"></i>Verifying…'; }
  if (errEl) errEl.style.display = "none";

  try {
    const res = await apiFetch("/verify_manager_password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pass }),
    });
    const data = await res.json();

    if (data.success) {
      const cb = _mgrAccessCallback;   // save BEFORE closeMgrAccessModal nulls it
      closeMgrAccessModal();
      if (typeof cb === "function") cb();
    } else {
      if (errEl) { errEl.textContent = "Incorrect password. Try again."; errEl.style.display = "block"; }
      if (pwdEl) { pwdEl.value = ""; pwdEl.focus(); }
    }
  } catch (e) {
    if (errEl) { errEl.textContent = "Error verifying password. Try again."; errEl.style.display = "block"; }
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fas fa-unlock" style="margin-right:5px"></i>Unlock'; }
  }
}

// ── Settings Modal ─────────────────────────────────────────────────────────────
// All button wiring is done via inline onclick in HTML — these are pure logic functions.

function openSettingsModal() {
  // Ask for manager password before opening settings
  openMgrAccessModal(
    "Settings Access",
    "Enter the manager password to open Settings.",
    "fa-cog",
    function () {
      const modal = document.getElementById("settings-modal");
      if (modal) modal.classList.add("show");
      // Refresh toggle state every time the modal opens — covers the case
      // where the flag was changed on another device.
      loadBillingConfig();
      loadUIConfig();
    }
  );
}

// ── Bill-generation toggle ────────────────────────────────────────────────────
// The Settings modal exposes a single boolean: always_generate_bill.
//   ON  → every stay generates a bill regardless of payment mode.
//   OFF → entirely-cash stays (room + every service paid in cash) skip the bill.
// State lives on the server (settings/billing_config). We always read from the
// server when the modal opens so multiple devices stay consistent.

function _setBillGenToggleUI(enabled) {
  const toggle = document.getElementById("settings-billgen-toggle");
  const slider = document.getElementById("settings-billgen-slider");
  const knob   = document.getElementById("settings-billgen-knob");
  const sub    = document.getElementById("settings-billgen-sub");
  if (toggle) toggle.checked = !!enabled;
  if (slider) slider.style.background = enabled ? "#3f51b5" : "#ccc";
  if (knob)   knob.style.transform   = enabled ? "translateX(20px)" : "translateX(0)";
  if (sub) {
    sub.textContent = enabled
      ? "All stays generate bills"
      : "Skip bill for entirely-cash stays";
  }
}

async function loadBillingConfig() {
  // Show a neutral "loading" state while we fetch, but don't disable the
  // toggle — if the user clicks during the fetch we just overwrite below.
  const sub = document.getElementById("settings-billgen-sub");
  if (sub) sub.textContent = "Loading…";
  try {
    const res = await apiFetch("/settings/billing_config");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.message || "Failed to load");
    _setBillGenToggleUI(!!(data.config && data.config.always_generate_bill));
  } catch (err) {
    console.warn("[billing_config] load failed:", err);
    if (sub) sub.textContent = "Could not load — tap to retry";
    // Leave the toggle unchecked as a safe default; user can flip to retry.
    const toggle = document.getElementById("settings-billgen-toggle");
    if (toggle) toggle.checked = false;
  }
}

async function toggleAlwaysGenerateBill(inputEl) {
  // Optimistic UI: paint the new state immediately, then POST. If the POST
  // fails, revert and show a notification.
  const desired = !!(inputEl && inputEl.checked);
  _setBillGenToggleUI(desired);

  // Guard against rapid toggling — disable until the round-trip resolves.
  if (inputEl) inputEl.disabled = true;
  try {
    const res = await apiFetch("/settings/billing_config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ always_generate_bill: desired }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.message || "Save failed");
    // Re-paint from the server's authoritative response in case the server
    // coerced or sanitised anything.
    _setBillGenToggleUI(!!(data.config && data.config.always_generate_bill));
    if (typeof showNotification === "function") {
      showNotification(
        desired ? "Bills will be generated for all stays."
                : "Bills will be skipped for entirely-cash stays.",
        "success",
      );
    }
  } catch (err) {
    console.error("[billing_config] save failed:", err);
    // Revert UI to the previous (server-side) state.
    _setBillGenToggleUI(!desired);
    if (typeof showNotification === "function") {
      showNotification(
        "Could not save setting: " + (err.message || "network error"),
        "error",
      );
    } else {
      alert("Could not save setting: " + (err.message || "network error"));
    }
  } finally {
    if (inputEl) inputEl.disabled = false;
  }
}

// ── UI config (tab visibility) ────────────────────────────────────────────────
// Currently one flag: hide_register_tab. State lives in settings/ui_config and
// propagates via a Firestore onSnapshot listener in google_sync.js, which
// dispatches a `cibaraUIConfigChanged` event picked up here.
//
// The first paint already has the correct visibility (Jinja-rendered from
// app.py). applyUIConfig() is called once on init for symmetry — it's a no-op
// when the DOM is already in the right state.

function _setHideRegisterToggleUI(enabled) {
  const toggle = document.getElementById("settings-hidereg-toggle");
  const slider = document.getElementById("settings-hidereg-slider");
  const knob   = document.getElementById("settings-hidereg-knob");
  const sub    = document.getElementById("settings-hidereg-sub");
  if (toggle) toggle.checked = !!enabled;
  if (slider) slider.style.background = enabled ? "#3f51b5" : "#ccc";
  if (knob)   knob.style.transform   = enabled ? "translateX(20px)" : "translateX(0)";
  if (sub) {
    sub.textContent = enabled
      ? "Register tab is hidden on all devices"
      : "Register tab is visible";
  }
}

// Apply the UI config to the DOM. Idempotent. Also handles the case where the
// user is currently viewing the Register tab and another device flips the
// toggle — we switch them to Rooms so they don't get stuck on a hidden tab.
function applyUIConfig(cfg) {
  cfg = cfg || {};
  const hideReg = !!cfg.hide_register_tab;

  const navItem = document.getElementById("nav-item-register");
  if (navItem) {
    navItem.style.display = hideReg ? "none" : "";
  }

  // If Register is currently the visible tab and we're hiding it, switch to
  // Rooms. Two signals to detect "currently on register":
  //   • #register-tab is visible (does not have `.hidden`)
  //   • OR the register nav-item has `.active`
  if (hideReg) {
    const regTabContent = document.getElementById("register-tab");
    const regNavActive  = navItem && navItem.classList.contains("active");
    const regVisible    = regTabContent && !regTabContent.classList.contains("hidden");
    if (regNavActive || regVisible) {
      // Trigger the Rooms tab the same way a click would — this reuses all the
      // existing tab-switch wiring (active class, hidden class, etc.).
      const roomsNav = document.querySelector('.nav-item[data-tab="rooms"]');
      if (roomsNav) {
        roomsNav.click();
      } else {
        // Fallback if the rooms nav isn't found for some reason.
        document.querySelectorAll(".tab-content").forEach((c) =>
          c.classList.add("hidden"),
        );
        const roomsTab = document.getElementById("rooms-tab");
        if (roomsTab) roomsTab.classList.remove("hidden");
      }
    }
  }

  // Keep the Settings toggle UI in sync if the modal is open or will open.
  _setHideRegisterToggleUI(hideReg);
}

async function loadUIConfig() {
  const sub = document.getElementById("settings-hidereg-sub");
  if (sub) sub.textContent = "Loading…";
  try {
    const res = await apiFetch("/settings/ui_config");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.message || "Failed to load");
    applyUIConfig(data.config || {});
  } catch (err) {
    console.warn("[ui_config] load failed:", err);
    if (sub) sub.textContent = "Could not load — tap to retry";
    const toggle = document.getElementById("settings-hidereg-toggle");
    if (toggle) toggle.checked = false;
  }
}

async function toggleHideRegisterTab(inputEl) {
  const desired = !!(inputEl && inputEl.checked);
  // Optimistic UI: apply locally first, then persist.
  applyUIConfig({ hide_register_tab: desired });
  if (inputEl) inputEl.disabled = true;
  try {
    const res = await apiFetch("/settings/ui_config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hide_register_tab: desired }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.message || "Save failed");
    // Re-paint from server's authoritative response.
    applyUIConfig(data.config || {});
    if (typeof showNotification === "function") {
      showNotification(
        desired ? "Register tab hidden on all devices."
                : "Register tab is now visible.",
        "success",
      );
    }
  } catch (err) {
    console.error("[ui_config] save failed:", err);
    // Revert.
    applyUIConfig({ hide_register_tab: !desired });
    if (typeof showNotification === "function") {
      showNotification(
        "Could not save setting: " + (err.message || "network error"),
        "error",
      );
    } else {
      alert("Could not save setting: " + (err.message || "network error"));
    }
  } finally {
    if (inputEl) inputEl.disabled = false;
  }
}

// Initial apply: window.__initialUIConfig is server-rendered. Re-applying it
// in JS is idempotent and ensures the toggle UI inside Settings reflects the
// current state when the modal first opens.
(function _initUIConfigOnce() {
  try {
    applyUIConfig(window.__initialUIConfig || {});
  } catch (e) {
    console.warn("[ui_config] initial apply failed:", e);
  }
})();

// React to remote flips (another device toggled the flag). The event is
// dispatched by the onSnapshot listener in google_sync.js.
window.addEventListener("cibaraUIConfigChanged", (e) => {
  applyUIConfig((e && e.detail) || {});
});

function closeSettingsModal() {
  const modal = document.getElementById("settings-modal");
  if (modal) modal.classList.remove("show");
}

function handleSettingsReportsClick() {
  // Settings is already password-gated — go straight to analytics
  closeSettingsModal();
  reportPasswordVerified = true;
  showReportsTab();
}

// No initMgrAccessModal / initSettingsModal needed — all wired via inline onclick in HTML.

// Function to handle reports tab access (kept for legacy compatibility)
function handleReportsTabAccess() {
  if (reportPasswordVerified) {
    showReportsTab();
    return;
  }
  openMgrAccessModal(
    "Reports Access",
    "Enter the manager password to view Analytics & Reports.",
    "fa-chart-bar",
    () => {
      reportPasswordVerified = true;
      showReportsTab();
      showNotification("Access granted to Analytics & Reports", "success");
    }
  );
}

// Create password modal if it doesn't exist
function createPasswordModal() {
  const modalHtml = `
    <div class="modal-backdrop" id="password-modal">
      <div class="modal-content" style="max-width: 400px;">
        <div class="modal-header">
          <h2>Reports Access</h2>
          <button class="close-btn" id="password-close-btn" aria-label="Close">&times;</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label" for="report-password">Enter Password:</label>
            <input 
              type="password" 
              class="form-control" 
              id="report-password" 
              placeholder="Password"
              autocomplete="off"
            />
            <div id="password-error" style="color: var(--danger); margin-top: 0.5rem; display: none;">
              Incorrect password. Please try again.
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="action-btn btn-secondary" id="password-cancel-btn">
            Cancel
          </button>
          <button type="button" class="action-btn btn-primary" id="password-submit-btn">
            Submit
          </button>
        </div>
      </div>
    </div>
  `;

  // Add modal to document body
  document.body.insertAdjacentHTML("beforeend", modalHtml);

  // Show the modal immediately
  const passwordModal = document.getElementById("password-modal");
  if (passwordModal) {
    passwordModal.classList.add("show");
    const passwordInput = document.getElementById("report-password");
    if (passwordInput) {
      setTimeout(() => passwordInput.focus(), 100);
    }
  }
}

// Use event delegation for password modal (more reliable for dynamic content)
document.addEventListener("click", function (e) {
  // Handle password submit button
  if (e.target && e.target.id === "password-submit-btn") {
    console.log("Password submit clicked via delegation");
    e.preventDefault();
    e.stopPropagation();
    verifyReportPassword();
    return;
  }

  // Handle password cancel button
  if (e.target && e.target.id === "password-cancel-btn") {
    console.log("Password cancel clicked via delegation");
    e.preventDefault();
    e.stopPropagation();
    const passwordModal = document.getElementById("password-modal");
    if (passwordModal) {
      passwordModal.classList.remove("show");
    }
    return;
  }

  // Handle password close button
  if (e.target && e.target.id === "password-close-btn") {
    console.log("Password close clicked via delegation");
    e.preventDefault();
    e.stopPropagation();
    const passwordModal = document.getElementById("password-modal");
    if (passwordModal) {
      passwordModal.classList.remove("show");
    }
    return;
  }

  // Handle click outside modal
  if (e.target && e.target.id === "password-modal") {
    console.log("Clicked outside password modal");
    const passwordModal = document.getElementById("password-modal");
    if (passwordModal) {
      passwordModal.classList.remove("show");
    }
    return;
  }
});

// Handle Enter key in password field using event delegation
document.addEventListener("keyup", function (e) {
  if (e.target && e.target.id === "report-password" && e.key === "Enter") {
    console.log("Enter key pressed in password field");
    verifyReportPassword();
  }
});

// Simplified setup function (no longer needed but keeping for compatibility)
function setupPasswordModalListeners() {
  console.log("Event delegation already set up globally");
}

// Legacy verifyReportPassword — now delegates to the manager access modal flow
function verifyReportPassword() {
  handleReportsTabAccess();
}

// Function to show reports tab (no nav item to highlight — Reports moved to Settings)
function showReportsTab() {
  document.querySelectorAll(".tab-content").forEach((content) => {
    content.classList.add("hidden");
  });
  const reportsTab = document.getElementById("reports-tab");
  if (reportsTab) reportsTab.classList.remove("hidden");

  // Clear any active nav highlight (reports has no footer tab)
  document.querySelectorAll(".nav-item").forEach((navItem) => {
    navItem.classList.remove("active");
  });

  // Auto-load analytics data so charts appear without needing to click Apply Filter
  setTimeout(function () {
    if (typeof generateEnhancedReport === "function") {
      generateEnhancedReport();
    }
  }, 50);
}

// Add discount field to checkout modal for existing stays
function addDiscountToCheckoutModal() {
  const balanceRow = document.querySelector(
    "#checkout-modal .detail-row:nth-child(5)",
  );
  if (!balanceRow) return;

  const discountRow = document.createElement("div");
  discountRow.className = "detail-row";
  discountRow.innerHTML = `
    <div class="detail-label">
      Discount
      <button id="add-discount-btn" style="background: none; border: none; color: var(--primary); cursor: pointer; margin-left: 5px;">
        <i class="fas fa-plus-circle"></i>
      </button>
    </div>
    <div class="detail-value" id="checkout-discount">₹0</div>
  `;

  balanceRow.parentNode.insertBefore(discountRow, balanceRow);
}

// Discount dialog for existing stays
function createDiscountDialog() {
  const dialog = document.createElement("div");
  dialog.className = "modal-backdrop";
  dialog.id = "discount-modal";
  dialog.style.zIndex = "1100";   // above checkout modal (1000)
  dialog.innerHTML = `
    <div class="modal-content" style="max-width: 400px">
      <div class="modal-header">
        <h2>Apply Discount</h2>
        <button class="close-btn" aria-label="Close">&times;</button>
      </div>
      <div class="form-group">
        <label class="form-label" for="discount-amount">Discount Amount (₹)</label>
        <input type="number" class="form-control" id="discount-amount" min="0" value="0" />
      </div>
      <div class="form-group">
        <label class="form-label">Discount Reason</label>
        <select class="form-control" id="discount-reason">
          <option value="Regular Customer">Regular Customer</option>
          <option value="Special Offer">Special Offer</option>
          <option value="Long Stay">Long Stay</option>
          <option value="Complaint Resolution">Complaint Resolution</option>
          <option value="Other">Other</option>
        </select>
      </div>
      <div class="form-group" id="other-reason-container" style="display: none;">
        <label class="form-label" for="other-discount-reason">Specify Reason</label>
        <input type="text" class="form-control" id="other-discount-reason" />
      </div>
      <button id="apply-discount-btn" class="action-btn btn-primary">Apply Discount</button>
    </div>
  `;

  document.body.appendChild(dialog);

  // Event handlers for discount dialog
  document
    .querySelector("#discount-modal .close-btn")
    .addEventListener("click", () => {
      document.getElementById("discount-modal").classList.remove("show");
    });

  document
    .getElementById("discount-reason")
    .addEventListener("change", function () {
      if (this.value === "Other") {
        document.getElementById("other-reason-container").style.display =
          "block";
      } else {
        document.getElementById("other-reason-container").style.display =
          "none";
      }
    });

  document
    .getElementById("apply-discount-btn")
    .addEventListener("click", applyDiscount);
}

// Apply discount function
async function applyDiscount() {
  const roomNumber = document.getElementById(
    "checkout-room-number",
  ).textContent;
  const discountAmount =
    parseInt(document.getElementById("discount-amount").value) || 0;
  const discountReason = document.getElementById("discount-reason").value;

  // Get actual reason text (handle the "Other" case)
  let reason = discountReason;
  if (discountReason === "Other") {
    reason = document.getElementById("other-discount-reason").value || "Other";
  }

  // Validation
  if (discountAmount <= 0) {
    showNotification("Please enter a valid discount amount", "error");
    return;
  }

  try {
    const submitBtn = document.getElementById("apply-discount-btn");
    submitBtn.disabled = true;
    submitBtn.innerHTML =
      '<span class="loader" style="width: 20px; height: 20px;"></span> Processing...';

    const response = await apiFetch("/apply_discount", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        room: roomNumber,
        amount: discountAmount,
        reason: reason,
      }),
    });

    if (!response.ok) {
      throw new Error(`Server responded with status: ${response.status}`);
    }

    const result = await response.json();
    if (result.success) {
      // Close discount modal
      document.getElementById("discount-modal").classList.remove("show");

      // Patch local room state immediately
      if (rooms[roomNumber]) {
        if (!rooms[roomNumber].discounts) rooms[roomNumber].discounts = [];
        const nowDt = new Date();
        rooms[roomNumber].discounts.push({
          amount: discountAmount,
          reason: reason,
          date: nowDt.toISOString().split("T")[0],
          time: nowDt.toTimeString().slice(0, 5),
        });
        // Reduce balance (discount applies against outstanding balance first)
        const currentBalance = rooms[roomNumber].balance || 0;
        if (currentBalance > 0) {
          rooms[roomNumber].balance = Math.max(0, currentBalance - discountAmount);
        } else {
          rooms[roomNumber].balance = currentBalance - discountAmount;
        }
      }
      debouncedFetchData(2000, roomNumber); // background sync + bust pay history cache

      // Update checkout modal UI
      updateCheckoutModal(roomNumber);

      showNotification(
        `Discount of ₹${discountAmount} applied successfully`,
        "success",
      );
    } else {
      showNotification(result.message || "Failed to apply discount", "error");
    }
  } catch (error) {
    console.error("Error applying discount:", error);
    showNotification(`Error applying discount: ${error.message}`, "error");
  } finally {
    const submitBtn = document.getElementById("apply-discount-btn");
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = "Apply Discount";
    }
  }
}

// Update checkout modal to include discount
function updateCheckoutModalWithDiscount(roomNumber) {
  const roomInfo = rooms[roomNumber];
  if (!roomInfo || !roomInfo.guest) return;

  // Update discount display
  const discountEl = document.getElementById("checkout-discount");
  if (discountEl) {
    let totalDiscount = 0;

    // Sum up all discounts from logs
    if (roomInfo.discounts && Array.isArray(roomInfo.discounts)) {
      totalDiscount = roomInfo.discounts.reduce(
        (sum, discount) => sum + discount.amount,
        0,
      );
    }

    discountEl.textContent = "₹" + totalDiscount;

    // Change color if discount exists
    if (totalDiscount > 0) {
      discountEl.style.color = "var(--success)";
    } else {
      discountEl.style.color = "";
    }
  }

  // Add discount event listener — password-protected
  const addDiscountBtn = document.getElementById("add-discount-btn");
  if (addDiscountBtn) {
    addDiscountBtn.onclick = function () {
      openMgrAccessModal(
        "Apply Discount",
        "Enter the manager password to apply a discount.",
        "fa-tag",
        () => {
          document.getElementById("discount-modal").classList.add("show");
          document.getElementById("discount-amount").value = "";
          document.getElementById("discount-amount").focus();
        }
      );
    };
  }
}

// Initialize discount functionality
function initializeDiscountFeature() {
  addDiscountToCheckoutModal();
  createDiscountDialog();

  // Update the original updateCheckoutModal function to include discount info
  const originalUpdateCheckoutModal = updateCheckoutModal;
  window.updateCheckoutModal = function (roomNumber) {
    // Call the original function first
    originalUpdateCheckoutModal(roomNumber);

    // Then add our discount updates
    updateCheckoutModalWithDiscount(roomNumber);
  };
}

// Global checkout handling variables
let checkoutHandlersInitialized = false;
let checkoutInProgress = false;

// This function will be called when the DOM is fully loaded
function setupCheckoutConfirmation() {
  if (checkoutHandlersInitialized) {
    console.log("Checkout handlers already initialized, skipping setup");
    return;
  }

  const confirmCheckoutBtn = document.getElementById("confirm-checkout-btn");
  if (!confirmCheckoutBtn) {
    console.error("Checkout button not found!");
    return;
  }

  // Add the event listener to the checkout button
  confirmCheckoutBtn.addEventListener("click", function (event) {
    event.preventDefault();

    // Prevent multiple calls
    if (checkoutInProgress) {
      console.log("Checkout already in progress, ignoring click");
      return;
    }

    const roomNumberElement = document.getElementById("checkout-room-number");
    const guestNameElement = document.getElementById("checkout-guest-name");

    if (!roomNumberElement) {
      showNotification("Room number element not found", "error");
      console.error("Room number element not found");
      return;
    }

    const roomNumber = roomNumberElement.textContent;
    const guestName = guestNameElement
      ? guestNameElement.textContent
      : "Unknown";
    const balance = rooms[roomNumber].balance;

    // If balance is positive, show warning and don't proceed.
    // MMT/OTA rooms are exempt — their balance is settled via the settlement modal, not at checkout.
    const isOtaCheckout = rooms[roomNumber]?.guest?.payment === "ota";
    if (balance > 0 && !isOtaCheckout) {
      console.log("Checkout blocked - positive balance");
      showNotification("Please clear the balance before checkout", "error");
      return;
    }

    // If balance is negative, show warning about pending refund and don't proceed
    if (balance < 0) {
      return;
    }

    // Set the room and guest name in the confirmation modal
    const confirmRoomElement = document.getElementById("confirm-checkout-room");
    const confirmGuestElement = document.getElementById(
      "confirm-checkout-guest",
    );

    if (confirmRoomElement) confirmRoomElement.textContent = roomNumber;
    if (confirmGuestElement) confirmGuestElement.textContent = guestName;

    // Show the confirmation modal
    const checkoutConfirmModal = document.getElementById(
      "checkout-confirm-modal",
    );
    if (checkoutConfirmModal) {
      // Reset flag section each time the confirmation modal opens
      const flagCb = document.getElementById("checkout-flag-customer");
      const flagNotesCtr = document.getElementById("checkout-flag-notes-container");
      const flagNotes = document.getElementById("checkout-flag-notes");
      if (flagCb) flagCb.checked = false;
      if (flagNotesCtr) flagNotesCtr.style.display = "none";
      if (flagNotes) flagNotes.value = "";

      checkoutConfirmModal.classList.add("show");
      console.log("Confirmation modal displayed");
    } else {
      console.error("Confirmation modal element not found");
      showNotification("Error: Confirmation modal not found", "error");
    }
  });

  // ── Flag checkbox: show/hide notes textarea ────────────────────────────────
  const flagCheckbox = document.getElementById("checkout-flag-customer");
  const flagNotesContainer = document.getElementById("checkout-flag-notes-container");
  if (flagCheckbox && flagNotesContainer) {
    flagCheckbox.addEventListener("change", function () {
      flagNotesContainer.style.display = this.checked ? "block" : "none";
      if (!this.checked) {
        const notesInput = document.getElementById("checkout-flag-notes");
        if (notesInput) notesInput.value = "";
      }
    });
  }

  // Handle the proceed button in the confirmation modal
  const proceedCheckoutBtn = document.getElementById("proceed-checkout-btn");
  if (proceedCheckoutBtn) {
    proceedCheckoutBtn.addEventListener("click", async function () {
      console.log("Proceed checkout clicked");

      // Prevent multiple calls
      if (checkoutInProgress) {
        console.log("Checkout already in progress, ignoring proceed click");
        return;
      }

      checkoutInProgress = true;

      // Disable only to prevent double-clicks — no "Processing..." text;
      // the room grid flips to cleaning immediately below for instant feedback.
      this.disabled = true;

      const roomNumberElement = document.getElementById("checkout-room-number");
      if (!roomNumberElement) {
        showNotification("Room number element not found", "error");
        console.error("Room number element not found during checkout");
        checkoutInProgress = false;
        this.disabled = false;
        this.innerHTML = "Yes, Checkout";
        return;
      }

      const roomNumber = roomNumberElement.textContent;
      const balance = rooms[roomNumber].balance;
      const isOta2 = rooms[roomNumber]?.guest?.payment === "ota";

      // Block checkout if there's still a positive balance (OTA/MMT rooms exempt)
      if (balance > 0 && !isOta2) {
        console.log("Checkout blocked in proceed step - positive balance");
        showNotification("Please clear the balance before checkout", "error");
        checkoutInProgress = false;
        this.disabled = false;
        this.innerHTML = "Yes, Checkout";

        // Close the confirmation modal
        const checkoutConfirmModal = document.getElementById(
          "checkout-confirm-modal",
        );
        if (checkoutConfirmModal) {
          checkoutConfirmModal.classList.remove("show");
        }
        return;
      }

      // Block checkout if there's a pending refund
      if (balance < 0) {
        checkoutInProgress = false;
        this.disabled = false;
        this.innerHTML = "Yes, Checkout";

        // Close the confirmation modal
        const checkoutConfirmModal = document.getElementById(
          "checkout-confirm-modal",
        );
        if (checkoutConfirmModal) {
          checkoutConfirmModal.classList.remove("show");
        }
        return;
      }

      // ── Optimistic checkout — close modals and update room grid immediately ──
      // Bill generation takes 5-8s on the server. Don't block the UI for that.
      // Close everything now, flip the room to "cleaning", then let the server
      // finish in the background. If it fails, roll back and show an error.

      const checkoutConfirmModal = document.getElementById("checkout-confirm-modal");
      if (checkoutConfirmModal) checkoutConfirmModal.classList.remove("show");
      const checkoutModal = document.getElementById("checkout-modal");
      if (checkoutModal) checkoutModal.classList.remove("show");

      // Snapshot current room state for rollback if server returns an error
      const prevRoomState = rooms[roomNumber] ? { ...rooms[roomNumber] } : null;

      // Immediately flip room to cleaning in local state
      if (rooms[roomNumber]) {
        rooms[roomNumber].status = "cleaning";
        rooms[roomNumber].guest  = null;
      }
      renderRooms();

      // Reset button so it's ready for the next use
      checkoutInProgress = false;
      this.disabled = false;
      this.innerHTML = "Yes, Checkout";

      // ── Capture flag state before modals close ────────────────────────────
      const flagCbEl = document.getElementById("checkout-flag-customer");
      const flagNotesEl = document.getElementById("checkout-flag-notes");
      const shouldFlag = !!(flagCbEl && flagCbEl.checked);
      const flagNotesValue = flagNotesEl ? flagNotesEl.value.trim() : "";
      const checkoutMobile = prevRoomState?.guest?.mobile || "";

      // DEBUG — remove after confirming flag works
      console.log("[flag-debug] flagCbEl found:", !!flagCbEl);
      console.log("[flag-debug] shouldFlag:", shouldFlag);
      console.log("[flag-debug] checkoutMobile:", checkoutMobile);
      console.log("[flag-debug] prevRoomState guest:", prevRoomState?.guest);

      // Fire request in background — no await
      apiFetch("/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          room: roomNumber,
          final_checkout: true,
          room_data: prevRoomState, // pass to server so it can skip a Firestore read
        }),
      })
        .then((r) => r.json())
        .then((result) => {
          if (result.success) {
            showNotification(result.message || "Checkout successful!", "success");
            debouncedFetchData(3000, roomNumber);
            // Auto-generate & store PDF in background (non-blocking)
            if (result.bill_id && typeof window._cibaraBillsAutoGenerate === "function") {
              window._cibaraBillsAutoGenerate(result.bill_id);
            }
            // Save customer flag if the checkbox was ticked at checkout
            console.log("[flag-debug] checkout success. shouldFlag:", shouldFlag, "checkoutMobile:", checkoutMobile);
            if (shouldFlag && checkoutMobile) {
              console.log("[flag-debug] firing toggle_customer_flag for:", checkoutMobile);
              apiFetch("/toggle_customer_flag", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  mobile: checkoutMobile,
                  is_flagged: true,
                  flag_notes: flagNotesValue,
                }),
              })
                .then((r) => r.json())
                .then((flagResult) => {
                  if (flagResult.success) {
                    console.log("[flag] Customer flagged successfully:", checkoutMobile);
                  } else {
                    console.warn("[flag] Flag API returned error:", flagResult.message);
                    showNotification("⚠️ Checkout done, but customer flag could not be saved: " + (flagResult.message || "unknown error"), "error");
                  }
                })
                .catch((err) =>
                  console.warn("[flag] Could not save customer flag:", err)
                );
            } else if (shouldFlag && !checkoutMobile) {
              console.warn("[flag] Flag checkbox was ticked but no mobile number found for this guest — flag not saved.");
            }
          } else {
            // Rollback local state and show error
            console.error("Checkout failed:", result.message);
            if (prevRoomState) rooms[roomNumber] = prevRoomState;
            renderRooms();
            showNotification(result.message || "Checkout failed — please try again.", "error");
            checkoutInProgress = false;
          }
        })
        .catch((err) => {
          console.error("Checkout network error:", err);
          if (prevRoomState) rooms[roomNumber] = prevRoomState;
          renderRooms();
          showNotification("Network error during checkout — please try again.", "error");
          checkoutInProgress = false;
        });
    });
  } else {
    console.error("Proceed checkout button not found");
  }

  // Handle cancel and close buttons
  const cancelConfirmBtn = document.getElementById(
    "cancel-confirm-checkout-btn",
  );
  if (cancelConfirmBtn) {
    cancelConfirmBtn.addEventListener("click", function () {
      console.log("Cancel confirmation clicked");
      const checkoutConfirmModal = document.getElementById(
        "checkout-confirm-modal",
      );
      if (checkoutConfirmModal) {
        checkoutConfirmModal.classList.remove("show");
      }
      checkoutInProgress = false; // Reset flag
    });
  }

  const confirmModalCloseBtn = document.querySelector(
    "#checkout-confirm-modal .close-btn",
  );
  if (confirmModalCloseBtn) {
    confirmModalCloseBtn.addEventListener("click", function () {
      console.log("Close confirmation modal clicked");
      const checkoutConfirmModal = document.getElementById(
        "checkout-confirm-modal",
      );
      if (checkoutConfirmModal) {
        checkoutConfirmModal.classList.remove("show");
      }
      checkoutInProgress = false; // Reset flag
    });
  }

  checkoutHandlersInitialized = true;
}

// Event Listeners
document.addEventListener("DOMContentLoaded", function () {
  debugLog("DOM loaded, initializing...");

  // Check for key elements
  if (!roomsGrid) debugLog("WARNING: roomsGrid element missing");
  if (!checkinModal) debugLog("WARNING: checkinModal element missing");
  if (!checkoutModal) debugLog("WARNING: checkoutModal element missing");
  if (!serviceForm) debugLog("WARNING: serviceForm element missing");

  // Initialize camera functionality
  initCamera();

  // Initialize service buttons
  initServiceButtons();

  // Fetch initial data
  fetchData();

  // Room grid and totals are kept in sync by Firestore onSnapshot listeners
  // in google_sync.js — no polling interval needed here.

  // Initialize the stats toggle functionality
  initCollapsibleStats();

  // Call function to update stats visibility from localStorage
  restoreStatsVisibility();

  initializeCleaningFeature();

  // Initialize enhanced check-in form
  initEnhancedCheckinForm();

  // Override the original showCheckinModal function
  window.showCheckinModal = showEnhancedCheckinModal;

  // Setup checkout confirmation
  setTimeout(setupCheckoutConfirmation, 500);

  // Initialize discount functionality
  setTimeout(initializeDiscountFeature, 1000);

  // Initialize bookings if available
  if (typeof initBookings === "function") {
    initBookings();
  }

  // Bottom navigation
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.addEventListener("click", () => {
      const tabName = item.dataset.tab;
      debugLog(`Tab clicked: ${tabName}`);

      // Special handling for reports tab
      if (tabName === "reports") {
        handleReportsTabAccess();
        return;
      }

      // Update nav items
      document.querySelectorAll(".nav-item").forEach((navItem) => {
        navItem.classList.remove("active");
      });
      item.classList.add("active");

      // Update tabs content
      document.querySelectorAll(".tab-content").forEach((content) => {
        content.classList.add("hidden");
      });

      const tabContent = document.getElementById(`${tabName}-tab`);
      if (tabContent) {
        tabContent.classList.remove("hidden");
      } else {
        debugLog(`Tab content for ${tabName} not found`);
      }
    });
  });

  // Filters
  document.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll(".filter-btn")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentFilter = btn.dataset.filter;
      debugLog(`Filter changed to: ${currentFilter}`);
      renderRooms();
    });
  });


  // Search functionality
  if (roomSearch) {
    roomSearch.addEventListener("input", (e) => {
      searchTerm = e.target.value.toLowerCase();
      renderRooms();
    });
  }

  // Refresh button — refreshes the currently-active tab with fresh
  // (cache-bypassed) data. Always re-fetches the shared rooms/dashboard
  // payload (rooms, logs, totals, upcoming bookings) and additionally
  // delegates to the active tab's own refresh routine where one exists.
  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      // Guard against double-clicks while a refresh is in flight.
      if (refreshBtn.dataset.busy === "1") return;
      refreshBtn.dataset.busy = "1";
      const originalHTML = '<i class="fas fa-sync-alt"></i>';
      refreshBtn.innerHTML =
        '<span class="loader" style="width: 20px; height: 20px;"></span>';

      // Determine the active tab. Prefer the footer nav, fall back to
      // whichever .tab-content is visible (covers the Reports tab, which
      // has no nav-item).
      let activeTab =
        document.querySelector(".nav-item.active")?.dataset?.tab || null;
      if (!activeTab) {
        const visible = document.querySelector(
          ".tab-content:not(.hidden)",
        );
        if (visible && visible.id && visible.id.endsWith("-tab")) {
          activeTab = visible.id.replace(/-tab$/, "");
        }
      }

      // Turn on the cache-bypass flag for the duration of the refresh.
      // apiFetch reads this and adds `cache: 'no-store'` + a `_t=` query
      // param to GET/HEAD requests.
      window.__forceFresh = true;

      // Track tab-loader work that we cannot directly await (in-tab
      // refresh buttons run async handlers without exposing a promise).
      // We hold the spinner for at least minHoldMs so the click feels
      // responsive even when delegating to those handlers.
      let minHoldMs = 0;

      const tasks = [];
      // Always refresh the shared dashboard payload.
      tasks.push(fetchData());

      try {
        switch (activeTab) {
          case "bookings":
            if (typeof window.fetchBookings === "function") {
              tasks.push(Promise.resolve(window.fetchBookings()));
            }
            break;
          case "bills": {
            const bl = document.getElementById("bl-refresh-btn");
            if (bl) {
              bl.click();
              minHoldMs = 1200;
            }
            break;
          }
          case "register": {
            // register.js renders its own toolbar with #reg-refresh-btn.
            // The static #refresh-register-btn in index.html is legacy
            // markup and has no listener — skip it.
            const reg = document.getElementById("reg-refresh-btn");
            if (reg) {
              reg.click();
              minHoldMs = 1200;
            }
            break;
          }
          case "transactions":
          case "rooms":
          case "reports":
          default:
            // fetchData() already refreshes the data these views render.
            break;
        }

        const startedAt = Date.now();
        await Promise.allSettled(tasks);
        const elapsed = Date.now() - startedAt;
        if (elapsed < minHoldMs) {
          await new Promise((r) => setTimeout(r, minHoldMs - elapsed));
        }
      } catch (err) {
        // Should not reach here — allSettled never rejects — but be
        // defensive so the spinner is always cleared.
        console.warn("[refresh-btn] unexpected error:", err);
      } finally {
        window.__forceFresh = false;
        // Brief tail so the spinner doesn't flash off instantly on a
        // very fast refresh.
        setTimeout(() => {
          refreshBtn.innerHTML = originalHTML;
          refreshBtn.dataset.busy = "0";
        }, 250);
      }
    });
  }

  // Fullscreen toggle button
  if (fullscreenBtn) {
    function updateFullscreenIcon() {
      const isFs = !!(
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.mozFullScreenElement
      );
      fullscreenBtn.innerHTML = isFs
        ? '<i class="fas fa-compress"></i>'
        : '<i class="fas fa-expand"></i>';
      fullscreenBtn.title = isFs ? "Exit fullscreen" : "Enter fullscreen";
    }

    fullscreenBtn.addEventListener("click", () => {
      const isFs = !!(
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.mozFullScreenElement
      );
      if (!isFs) {
        const el = document.documentElement;
        (el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen).call(el);
      } else {
        (document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen).call(document);
      }
    });

    document.addEventListener("fullscreenchange", updateFullscreenIcon);
    document.addEventListener("webkitfullscreenchange", updateFullscreenIcon);
    document.addEventListener("mozfullscreenchange", updateFullscreenIcon);
  }

  // Handle payment method selection for check-in
  document.querySelectorAll(".payment-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (
        btn.parentElement &&
        btn.parentElement.classList.contains("payment-options")
      ) {
        const paymentOptions = btn.parentElement;
        paymentOptions
          .querySelectorAll(".payment-btn")
          .forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");

        if (btn.dataset.payment) {
          activePaymentMethod = btn.dataset.payment;
          const paymentMethodInput = document.getElementById("payment-method");
          if (paymentMethodInput) {
            paymentMethodInput.value = activePaymentMethod;
          }

          // Auto-adjust amount paid based on payment method
          // Only override if the user has NOT manually entered a custom amount.
          // We track whether the amount field was user-edited via the data-user-edited attribute.
          const amountPaidInput = document.getElementById("amount-paid");
          const roomPriceInput = document.getElementById("room-price");

          if (amountPaidInput && roomPriceInput) {
            const userEdited = amountPaidInput.dataset.userEdited === "true";
            if (activePaymentMethod === "balance") {
              // Always set to 0 for Pay Later (user can't pay anything in advance)
              amountPaidInput.value = 0;
              amountPaidInput.dataset.userEdited = "false";
            } else if (!userEdited) {
              // Only auto-fill if user has not manually changed the amount
              amountPaidInput.value = roomPriceInput.value || 0;
            }
          }
        }
      }
    });
  });

  // Check-in form validation and submission
  const checkinForm = document.getElementById("checkin-form");
  if (checkinForm) {
    checkinForm.addEventListener("submit", async (e) => {
      e.preventDefault();

      // Get room number from dropdown or fallback to span
      let roomNumber = "";
      const roomDropdown = document.getElementById("checkin-room-dropdown");
      if (roomDropdown && roomDropdown.value) {
        roomNumber = roomDropdown.value;
      } else {
        const roomNumberElement = document.getElementById(
          "checkin-room-number",
        );
        if (roomNumberElement) {
          roomNumber = roomNumberElement.textContent;
        }
      }

      if (!roomNumber) {
        showNotification("Please select a room number", "error");
        return;
      }

      // Get form values with null checks
      const guestNameInput = document.getElementById("guest-name");
      const guestMobileInput = document.getElementById("guest-mobile");
      const roomPriceInput = document.getElementById("room-price");
      const guestCountInput = document.getElementById("guest-count");
      const amountPaidInput = document.getElementById("amount-paid");
      const paymentMethodInput = document.getElementById("payment-method");

      // Get AC toggle state for AC rooms
      const acToggle = document.getElementById("ac-toggle");
      const isAC = acToggle && acToggle.checked;

      if (
        !guestNameInput ||
        !guestMobileInput ||
        !roomPriceInput ||
        !guestCountInput ||
        !amountPaidInput ||
        !paymentMethodInput
      ) {
        showNotification("Required form fields are missing", "error");
        return;
      }

      const guestName = guestNameInput.value;
      const guestMobile = guestMobileInput.value;
      const roomPrice = roomPriceInput.value;
      const guestCount = guestCountInput.value;
      const amountPaid = parseInt(amountPaidInput.value || "0");
      const paymentMethod = paymentMethodInput.value;

      if (!guestName || !guestMobile || !roomPrice || !guestCount) {
        showNotification("Please fill all required fields", "error");
        return;
      }

      // ── Check-in time override ───────────────────────────────────────────
      // The hidden input holds either an empty string (= "use server now()")
      // or "YYYY-MM-DD HH:MM" (set by the edit-time icon → showEditTimeModal
      // callback). The server re-validates; these checks just give a clearer
      // error message before the network call.
      let checkinTimeOverride = null;
      const _ctInput = document.getElementById("checkin-time-input");
      const _raw = _ctInput && _ctInput.value ? _ctInput.value.trim() : "";
      if (_raw) {
        const [_d, _t] = _raw.split(" ");
        const picked = _d && _t ? new Date(`${_d}T${_t}`) : new Date(NaN);
        const now = new Date();
        if (Number.isNaN(picked.getTime())) {
          showNotification("Invalid check-in time", "error");
          return;
        }
        if (picked.getTime() > now.getTime() + 60 * 1000) {
          showNotification("Check-in time cannot be in the future", "error");
          return;
        }
        const sameDay =
          picked.getFullYear() === now.getFullYear() &&
          picked.getMonth() === now.getMonth() &&
          picked.getDate() === now.getDate();
        if (!sameDay) {
          showNotification(
            "Check-in time must be today. Backdating to a previous day is not supported here.",
            "error"
          );
          return;
        }
        checkinTimeOverride = _raw;
      }

      // Don't allow amount paid > 0 when payment method is "balance"
      if (amountPaid > 0 && paymentMethod === "balance") {
        showNotification(
          'Cannot select "Pay Later" when amount is provided. Please select Cash or Online payment method.',
          "error",
        );
        return;
      }

      // Disable submit button and show loading state
      const submitBtn = e.target.querySelector("button[type=submit]");
      if (!submitBtn) {
        showNotification("Submit button not found", "error");
        return;
      }

      const originalContent = submitBtn.innerHTML;
      submitBtn.disabled = true;
      submitBtn.innerHTML =
        '<span class="loader" style="width: 20px; height: 20px;"></span> Processing...';

      try {
        const guestAddressInput = document.getElementById("guest-address");
        const guestAddress = guestAddressInput ? guestAddressInput.value.trim() : "";

        // Upload any pending ID document photo before recording the check-in
        if (typeof window.uploadPendingDocIfAny === 'function') {
          const docUploaded = await window.uploadPendingDocIfAny(guestMobile);
          if (!docUploaded) {
            // Upload error already notified — re-enable button and abort
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalContent;
            return;
          }
        }

        const response = await apiFetch("/checkin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            room: roomNumber,
            name: guestName,
            mobile: guestMobile,
            address: guestAddress,
            price: roomPrice,
            guests: guestCount,
            payment: paymentMethod,
            amountPaid: amountPaid,
            photoPath: uploadedPhotoUrl,
            isAC: isAC,
            // Optional override; server falls back to now() if absent or
            // if it fails server-side validation.
            checkin_time: checkinTimeOverride,
          }),
        });

        if (!response.ok) {
          throw new Error(`Server responded with status: ${response.status}`);
        }

        const result = await response.json();
        if (result.success) {
          // Close modal and show success immediately — don't block on data reload
          checkinModal.classList.remove("show");
          submitBtn.disabled = false;
          submitBtn.innerHTML = originalContent;

          let message = result.message || "Check-in successful!";
          if (result.serial_number) {
            message += ` (Serial #${result.serial_number})`;
          }
          showNotification(message, "success");

          // Check-in adds new guest data — let background fetch hydrate the room
          debouncedFetchData();

          // Notify register & bills modules to refresh live
          window.dispatchEvent(new CustomEvent("cibaraRoomUpdate", { detail: { type: "checkin" } }));
        } else {
          showNotification(result.message || "Error during check-in", "error");
          submitBtn.disabled = false;
          submitBtn.innerHTML = originalContent;
        }
      } catch (error) {
        console.error("Error during check-in:", error);
        showNotification(`Error during check-in: ${error.message}`, "error");
        submitBtn.disabled = false;
        submitBtn.innerHTML = originalContent;
      }
    });
  } else {
    debugLog("Check-in form not found");
  }

  // Cancel checkout
  const cancelCheckoutBtn = document.getElementById("cancel-checkout-btn");
  if (cancelCheckoutBtn) {
    cancelCheckoutBtn.addEventListener("click", () => {
      checkoutModal.classList.remove("show");
    });
  }

  // ── Edit check-in time (inside the checkout modal) ───────────────────────
  // First edit per stay is free; subsequent edits require the manager
  // password. The counter lives on the room doc as `checkin_time_edit_count`
  // and is incremented server-side by /update_checkin_time.
  const editCheckinTimeBtn = document.getElementById("edit-checkin-time");
  if (editCheckinTimeBtn) {
    editCheckinTimeBtn.addEventListener("click", () => {
      const roomEl     = document.getElementById("checkout-room-number");
      const roomNumber = roomEl ? roomEl.textContent.trim() : "";
      if (!roomNumber || !rooms[roomNumber]) {
        showNotification("Could not determine the room to edit.", "error");
        return;
      }
      const currentCheckInTime = rooms[roomNumber].checkin_time || "";
      const editCount = rooms[roomNumber].checkin_time_edit_count || 0;

      const open = () => showEditTimeModal(roomNumber, currentCheckInTime);

      if (editCount === 0) {
        open();
      } else if (typeof openMgrAccessModal === "function") {
        openMgrAccessModal(
          "Edit Check-in Time",
          "This stay's check-in time has already been edited. Manager password required.",
          "fa-clock",
          open
        );
      } else {
        open(); // dev fallback if mgr-access modal isn't available
      }
    });
  }

  // ── New-checkin time icon (inside the check-in modal) ────────────────────
  // Opens the shared #edit-time-modal in callback mode. The picked value is
  // stored in #checkin-time-input (hidden) and displayed in
  // #checkin-time-display. The check-in form submit handler reads the
  // hidden input and forwards it to /checkin.
  const editNewCheckinTimeBtn = document.getElementById("edit-new-checkin-time-btn");
  if (editNewCheckinTimeBtn) {
    editNewCheckinTimeBtn.addEventListener("click", () => {
      const hidden  = document.getElementById("checkin-time-input");
      const display = document.getElementById("checkin-time-display");

      // Seed the picker with the currently-stored override (if any),
      // otherwise with "now". Format expected by showEditTimeModal:
      // "YYYY-MM-DD HH:MM".
      let seed = hidden && hidden.value ? hidden.value : "";
      if (!seed) {
        const n = new Date();
        const pad = (x) => String(x).padStart(2, "0");
        seed =
          `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())} ` +
          `${pad(n.getHours())}:${pad(n.getMinutes())}`;
      }

      showEditTimeModal(null, seed, {
        title: "Set Check-in Time",
        submitLabel: "Set Check-in Time",
        // Return false to reject (modal stays open); true/undefined to accept.
        onConfirm: (newCheckInTime) => {
          // Re-validate same-day rule on the client. Server re-validates too.
          const [d, t] = newCheckInTime.split(" ");
          const picked = new Date(`${d}T${t}`);
          const now = new Date();
          const sameDay =
            picked.getFullYear() === now.getFullYear() &&
            picked.getMonth() === now.getMonth() &&
            picked.getDate() === now.getDate();
          if (!sameDay) {
            showNotification(
              "Check-in time must be today. Backdating to a previous day is not supported here.",
              "error"
            );
            return false;
          }
          if (picked.getTime() > now.getTime() + 60 * 1000) {
            showNotification("Check-in time cannot be in the future", "error");
            return false;
          }

          if (hidden) hidden.value = newCheckInTime;
          if (display) {
            // Show "HH:MM" with a hint if it differs from current time.
            const pad = (x) => String(x).padStart(2, "0");
            const hhmm = `${pad(picked.getHours())}:${pad(picked.getMinutes())}`;
            const nowHHMM = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
            display.textContent = hhmm === nowHHMM ? `Now (${hhmm})` : hhmm;
            display.style.color = hhmm === nowHHMM ? "#1a202c" : "#b7791f";
          }
          return true;
        },
      });
    });
  }

  // Apply report filter
  const applyReportFilterBtn = document.getElementById("apply-report-filter");
  if (applyReportFilterBtn) {
    applyReportFilterBtn.addEventListener("click", generateReport);
  }

  // Renew all button
  const renewAllBtn = document.getElementById("renew-all-btn");
  if (renewAllBtn) {
    renewAllBtn.addEventListener("click", async function () {
      const dueRoomElements = document.querySelectorAll(".renewal-item");
      if (dueRoomElements.length === 0) return;

      this.disabled = true;
      this.innerHTML =
        '<span class="loader" style="width: 20px; height: 20px;"></span> Processing...';

      const dueRooms = Array.from(dueRoomElements).map((el) => el.dataset.room);

      let successCount = 0;
      let failCount = 0;

      for (const room of dueRooms) {
        try {
          const roomElement = document.querySelector(
            `.renewal-item[data-room="${room}"]`,
          );
          if (!roomElement) continue;

          const buttonElement = roomElement.querySelector(".renew-single-btn");
          if (!buttonElement) continue;

          // Skip already processed rooms
          if (buttonElement.innerHTML === "Renewed" || buttonElement.disabled) {
            continue;
          }

          // Update button UI
          buttonElement.disabled = true;
          buttonElement.innerHTML =
            '<span class="loader" style="width: 10px; height: 10px;"></span>';

          // Try to renew the room
          const success = await triggerRentRenewal(room);

          if (success) {
            successCount++;
            // Update UI to show this room is processed
            roomElement.style.backgroundColor = "#e8f4e5";
            buttonElement.innerHTML = "Renewed";
          } else {
            failCount++;
            buttonElement.disabled = false;
            buttonElement.innerHTML = "Retry";
          }
        } catch (error) {
          console.error(`Error renewing room ${room}:`, error);
          failCount++;
        }
      }

      this.disabled = false;
      this.innerHTML = "Renew All Due Rooms";

      if (successCount > 0) {
        showNotification(
          `Successfully renewed ${successCount} room${
            successCount !== 1 ? "s" : ""
          }`,
          "success",
        );
      }

      if (failCount > 0) {
        showNotification(
          `Failed to renew ${failCount} room${failCount !== 1 ? "s" : ""}`,
          "warning",
        );
      }

      // Close modal if all rooms are successfully processed
      if (failCount === 0) {
        setTimeout(() => {
          if (rentRenewalModal) {
            rentRenewalModal.classList.remove("show");
          }
        }, 1500);
      }
    });
  }

  // Close modals — scope to the nearest backdrop so a nested modal (e.g.
  // the edit-time modal opened from inside the check-in modal) doesn't
  // close every other modal beneath it. Falls back to closing all
  // backdrops if the close button isn't inside one (shouldn't happen,
  // but keeps the old behaviour as a safety net).
  document.querySelectorAll(".close-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const ownBackdrop = e.currentTarget.closest(".modal-backdrop");
      if (ownBackdrop) {
        ownBackdrop.classList.remove("show");
      } else {
        document.querySelectorAll(".modal-backdrop").forEach((modal) => {
          modal.classList.remove("show");
        });
      }

      // Stop camera stream if active
      if (mediaStream) {
        mediaStream.getTracks().forEach((track) => track.stop());
        mediaStream = null;
      }
    });
  });

  // Quick action button toggle
  const quickActionBtn = document.getElementById("quick-action-toggle");
  const quickActionMenu = document.querySelector(".quick-action-menu");

  if (quickActionBtn && quickActionMenu) {
    quickActionBtn.addEventListener("click", function () {
      quickActionMenu.classList.toggle("show");
    });

    // Close menu when clicking outside
    document.addEventListener("click", function (event) {
      if (!event.target.closest(".quick-actions-container")) {
        quickActionMenu.classList.remove("show");
      }
    });
  }

  // Quick renewals button
  const quickRenewBtn = document.getElementById("quick-renew-btn");
  if (quickRenewBtn) {
    quickRenewBtn.addEventListener("click", function () {
      showRenewalModal();
      if (quickActionMenu) {
        quickActionMenu.classList.remove("show");
      }
    });
  }

  // Add Room form submission
  const addRoomForm = document.getElementById("add-room-form");
  if (addRoomForm) {
    addRoomForm.addEventListener("submit", addRoom);
  }

  // Set default dates for report
  const today = new Date().toISOString().split("T")[0];
  if (document.getElementById("start-date")) {
    document.getElementById("start-date").value = today;
  }
  if (document.getElementById("end-date")) {
    document.getElementById("end-date").value = today;
  }

  // Initialise settings modal + manager access modal
  initSettingsModal();
  initMgrAccessModal();

  // Settings button in header — query fresh (top-level const may be null at load time)
  const settingsBtnEl = document.getElementById("settings-btn");
  if (settingsBtnEl) {
    settingsBtnEl.addEventListener("click", openSettingsModal);
  }

  // ── Booking added/modified on another device (from google_sync.js) ─────
  // Show a notification AND refresh the upcoming-bookings map so the
  // indicator dot updates without a manual page refresh.
  async function _refreshUpcomingAndRender() {
    try {
      const res = await apiFetch("/get_upcoming_bookings");
      if (res && res.ok) {
        const data = await res.json();
        if (data && data.success) {
          upcomingBookings = data.upcoming || {};
        }
      }
    } catch (err) {
      console.warn("Failed to refresh upcoming bookings:", err);
      // Fall through and still re-render with whatever we have.
    }
    if (typeof renderRooms === "function") renderRooms();
  }

  // Coalesce rapid bursts (e.g. multi-doc batch writes) into one refresh.
  let _upcomingRefreshTimer = null;
  function _scheduleUpcomingRefresh() {
    if (_upcomingRefreshTimer) return;
    _upcomingRefreshTimer = setTimeout(() => {
      _upcomingRefreshTimer = null;
      _refreshUpcomingAndRender();
    }, 400);
  }

  window.addEventListener("cibaraBookingAdded", function (e) {
    const b = e.detail || {};
    const guestName  = b.name || b.guest_name || "Guest";
    const roomNum    = b.room || b.room_number || "";
    const checkIn    = b.check_in_date || "";
    const todayStr   = new Date().toISOString().split("T")[0];
    const isToday    = checkIn === todayStr;

    const roomInfo   = roomNum ? ` — Room ${roomNum}` : "";
    const whenLabel  = isToday ? "Today" : `Check-in ${checkIn}`;
    const msg        = `📋 New Booking: ${guestName}${roomInfo} (${whenLabel})`;

    if (typeof showNotification === "function") {
      showNotification(msg, "info", 5000);
    }
    _scheduleUpcomingRefresh();
  });

  // Modifications/cancellations may remove or change a dot; refresh too.
  window.addEventListener("cibaraBookingModified", function () {
    _scheduleUpcomingRefresh();
  });

  debugLog("Initialization complete");
});
