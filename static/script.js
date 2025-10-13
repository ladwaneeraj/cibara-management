// Global variables
let rooms = {};
let transactionMetadata = {};
let dailyCounters = {};

// Keep logs and totals variables as they're used throughout the app
let logs = {
  cash: [],
  online: [],
  balance: [],
  add_ons: [],
  refunds: [],
  renewals: [],
  expenses: [],
  discounts: [],
};
let totals = { cash: 0, online: 0, balance: 0, refunds: 0 };
let activePaymentMethod = "cash";
let currentFilter = "all";
let currentFloor = "all";
let searchTerm = "";
let capturedPhotoData = null;
let uploadedPhotoUrl = null;
let mediaStream = null;
let selectedService = null;
let servicePaymentMethod = "cash";

// Track what data has been loaded
let dataLoadedState = {
  rooms: false,
  logs: false,
  totals: false,
  settlements: false,
  bookings: false,
};

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
const paymentOrRefundSection = document.getElementById(
  "payment-or-refund-section"
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
  "service-payment-method"
);

// LAZY LOADING FUNCTIONS

// Load only rooms data
async function loadRoomsData() {
  if (dataLoadedState.rooms) {
    console.log("Rooms already loaded, using cache");
    return true;
  }

  try {
    console.log("Loading rooms data...");
    const response = await fetch("/get_rooms_only");

    if (!response.ok) {
      throw new Error(`Server responded with status: ${response.status}`);
    }

    const data = await response.json();
    if (data.success) {
      rooms = data.rooms;
      dataLoadedState.rooms = true;

      // Process rooms to ensure they have renewal data
      Object.entries(rooms).forEach(([roomNumber, roomInfo]) => {
        if (roomInfo.status === "occupied") {
          if (roomInfo.renewal_count === undefined) {
            roomInfo.renewal_count = 0;
          }
          if (roomInfo.renewal_count > 0 && !roomInfo.last_renewal_time) {
            const checkinDate = new Date(roomInfo.checkin_time);
            const estimatedLastRenewal = new Date(
              checkinDate.getTime() +
                roomInfo.renewal_count * 24 * 60 * 60 * 1000
            );
            roomInfo.last_renewal_time = formatDateTime(estimatedLastRenewal);
          }
        }
      });

      console.log(`Loaded ${Object.keys(rooms).length} rooms`);
      return true;
    }
    return false;
  } catch (error) {
    console.error("Error loading rooms:", error);
    showNotification(`Error loading rooms: ${error.message}`, "error");
    return false;
  }
}

// Load only totals data
async function loadTotalsData() {
  if (dataLoadedState.totals) {
    console.log("Totals already loaded, using cache");
    return true;
  }

  try {
    console.log("Loading totals data...");
    const response = await fetch("/get_totals_only");

    if (!response.ok) {
      throw new Error(`Server responded with status: ${response.status}`);
    }

    const data = await response.json();
    if (data.success) {
      totals = data.totals;
      dataLoadedState.totals = true;
      console.log("Totals loaded successfully");
      return true;
    }
    return false;
  } catch (error) {
    console.error("Error loading totals:", error);
    showNotification(`Error loading totals: ${error.message}`, "error");
    return false;
  }
}

// Load only logs data
async function loadLogsData() {
  if (dataLoadedState.logs) {
    console.log("Logs already loaded, using cache");
    return true;
  }

  try {
    console.log("Loading logs data...");
    const response = await fetch("/get_logs_only");

    if (!response.ok) {
      throw new Error(`Server responded with status: ${response.status}`);
    }

    const data = await response.json();
    if (data.success) {
      logs = data.logs;
      dataLoadedState.logs = true;

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

      console.log("Logs loaded successfully");
      return true;
    }
    return false;
  } catch (error) {
    console.error("Error loading logs:", error);
    showNotification(`Error loading logs: ${error.message}`, "error");
    return false;
  }
}

// Load settlements data
async function loadSettlementsData() {
  if (dataLoadedState.settlements) {
    console.log("Settlements already loaded");
    return true;
  }

  try {
    console.log("Loading settlements data...");
    const response = await fetch("/get_pending_settlements");

    if (!response.ok) {
      throw new Error(`Server responded with status: ${response.status}`);
    }

    const data = await response.json();
    if (data.success) {
      dataLoadedState.settlements = true;
      console.log("Settlements loaded successfully");

      // Trigger settlements UI update if the function exists
      if (typeof displayPendingSettlements === "function") {
        displayPendingSettlements(data.settlements);
      }
      return true;
    }
    return false;
  } catch (error) {
    console.error("Error loading settlements:", error);
    showNotification(`Error loading settlements: ${error.message}`, "error");
    return false;
  }
}

// Load bookings data
async function loadBookingsData() {
  if (dataLoadedState.bookings) {
    console.log("Bookings already loaded");
    return true;
  }

  try {
    console.log("Loading bookings data...");
    const response = await fetch("/get_bookings");

    if (!response.ok) {
      throw new Error(`Server responded with status: ${response.status}`);
    }

    const data = await response.json();
    if (data.success) {
      dataLoadedState.bookings = true;
      console.log("Bookings loaded successfully");

      // Trigger bookings UI update if the function exists
      if (typeof renderBookings === "function") {
        renderBookings(data.bookings);
      }
      return true;
    }
    return false;
  } catch (error) {
    console.error("Error loading bookings:", error);
    showNotification(`Error loading bookings: ${error.message}`, "error");
    return false;
  }
}

// Invalidate all cache
function invalidateAllCache() {
  dataLoadedState = {
    rooms: false,
    logs: false,
    totals: false,
    settlements: false,
    bookings: false,
  };
  console.log("All cache invalidated");
}

// Load data for specific tab
async function loadDataForTab(tabName) {
  console.log(`Loading data for tab: ${tabName}`);

  switch (tabName) {
    case "rooms":
      await loadRoomsData();
      await loadTotalsData();
      updateStats();
      renderRooms();
      break;

    case "transactions":
      await loadLogsData();
      await loadTotalsData();
      if (typeof renderEnhancedLogs === "function") {
        renderEnhancedLogs();
      }
      updateStats();
      break;

    case "bookings":
      await loadBookingsData();
      break;

    case "settlements":
      await loadSettlementsData();
      break;

    case "reports":
      // Reports tab has its own loading mechanism
      break;

    default:
      console.log(`Unknown tab: ${tabName}`);
  }
}

// Camera functionality
function initCamera() {
  const cameraBtn = document.getElementById("camera-btn");
  const cameraContainer = document.getElementById("camera-container");
  const cameraFeed = document.getElementById("camera-feed");
  const captureBtn = document.getElementById("capture-photo-btn");
  const cancelCameraBtn = document.getElementById("cancel-camera-btn");
  const photoPreviewContainer = document.getElementById(
    "photo-preview-container"
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
        uploadPhoto(file);
      };
      reader.readAsDataURL(file);
    }
  });

  // Camera button click event
  cameraBtn.addEventListener("click", async function () {
    try {
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
        "error"
      );
    }
  });

  // Capture photo button
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
      const file = new File([blob], "camera-capture.jpg", {
        type: "image/jpeg",
      });

      uploadPhoto(file);

      if (mediaStream) {
        mediaStream.getTracks().forEach((track) => track.stop());
        mediaStream = null;
      }
    });
  }

  // Cancel camera button
  if (cancelCameraBtn) {
    cancelCameraBtn.addEventListener("click", function () {
      if (cameraContainer) {
        cameraContainer.style.display = "none";
      }
      if (mediaStream) {
        mediaStream.getTracks().forEach((track) => track.stop());
        mediaStream = null;
      }
    });
  }

  // Retake photo button
  if (retakePhotoBtn) {
    retakePhotoBtn.addEventListener("click", function () {
      if (photoPreviewContainer) {
        photoPreviewContainer.style.display = "none";
      }
      capturedPhotoData = null;
      uploadedPhotoUrl = null;
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

  notificationContainer.appendChild(notification);

  const dismissBtn = notification.querySelector(".notification-dismiss");
  dismissBtn.addEventListener("click", () => {
    closeNotification(notification);
  });

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
    // Apply filters
    if (currentFilter === "vacant" && info.status !== "vacant") return;
    if (currentFilter === "occupied" && info.status !== "occupied") return;
    if (
      currentFilter === "balances" &&
      (info.status !== "occupied" || info.balance <= 0)
    )
      return;
    if (currentFloor === "first" && roomNumber.startsWith("2")) return;
    if (currentFloor === "second" && !roomNumber.startsWith("2")) return;
    if (
      searchTerm &&
      !roomNumber.toLowerCase().includes(searchTerm) &&
      !(info.guest && info.guest.name.toLowerCase().includes(searchTerm))
    )
      return;

    roomCount++;

    const roomCard = document.createElement("div");
    roomCard.className = "room-card";
    roomCard.id = `room-card-${roomNumber}`;
    roomCard.setAttribute("aria-label", `Room ${roomNumber} - ${info.status}`);

    let roomContent = `
      <div class="room-status ${info.status}"></div>
      <div class="room-content">
    `;

    if (info.status === "occupied" && info.guest) {
      const guestCount = info.guest.guests || 1;
      const roomNum = parseInt(roomNumber);
      const isPremiumACRoom = roomNum >= 202 && roomNum <= 205;
      const isAcRoom = isPremiumACRoom && info.guest.isAC === true;

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
        <div class="guest-name">${info.guest.name}</div>
      `;
    } else {
      roomContent += `
        <div class="room-number">${roomNumber}</div>
        <div class="guest-name">Vacant</div>
      `;
    }

    if (info.status === "occupied" && info.guest) {
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
        roomContent += `<div class="renewal-badge" id="renewal-badge-${roomNumber}">Renewal Due</div>`;
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

      if (info.balance > 0) {
        roomContent += `<div class="badge" style="background-color:#ff9191;">₹${info.balance}</div>`;
      } else if (info.balance < 0) {
        roomContent += `<div class="badge" style="background-color: var(--success);">₹${Math.abs(
          info.balance
        )}</div>`;
      }
    } else {
      roomContent += `
        <div class="room-footer">
          <div>Available</div>
        </div>
      `;
    }

    roomContent += `</div>`;
    roomCard.innerHTML = roomContent;

    roomCard.addEventListener("click", () => {
      if (info.status === "vacant") {
        showCheckinModal(roomNumber);
      } else if (info.status === "occupied") {
        showCheckoutModal(roomNumber);
      }
    });

    // Long-press for detailed view
    let longPressTimer;
    const longPressThreshold = 500;

    roomCard.addEventListener("mousedown", function (e) {
      longPressTimer = setTimeout(() => {
        showRoomDetailsModal(roomNumber);
      }, longPressThreshold);
    });

    roomCard.addEventListener("mouseup", function () {
      clearTimeout(longPressTimer);
    });

    roomCard.addEventListener("mouseleave", function () {
      clearTimeout(longPressTimer);
    });

    roomCard.addEventListener("touchstart", function (e) {
      longPressTimer = setTimeout(() => {
        showRoomDetailsModal(roomNumber);
      }, longPressThreshold);
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

function updateStats() {
  let vacant = 0;
  let occupied = 0;
  let balance = 0;
  let renewalsDue = 0;

  Object.values(rooms).forEach((room) => {
    if (room.status === "vacant") {
      vacant++;
    } else if (room.status === "occupied") {
      occupied++;
      if (room.balance > 0) {
        balance += room.balance;
      }

      const renewalStatus = getRoomRenewalStatus(room);
      if (renewalStatus.canRenew) {
        renewalsDue++;
      }
    }
  });

  if (vacantCount) vacantCount.textContent = vacant;
  if (occupiedCount) occupiedCount.textContent = occupied;
  if (pendingBalance) pendingBalance.textContent = "₹" + balance;

  const today = new Date().toISOString().split("T")[0];

  const todayCashLogs = logs.cash.filter((log) => log.date === today);
  const todayOnlineLogs = logs.online.filter((log) => log.date === today);
  const todayRefundLogs = (logs.refunds || []).filter(
    (log) => log.date === today
  );

  const todayCashTotal = todayCashLogs.reduce(
    (sum, log) => sum + log.amount,
    0
  );
  const todayOnlineTotal = todayOnlineLogs.reduce(
    (sum, log) => sum + log.amount,
    0
  );

  const todayCashRefunds = todayRefundLogs
    .filter((log) => log.payment_mode === "cash")
    .reduce((sum, log) => sum + log.amount, 0);

  const todayOnlineRefunds = todayRefundLogs
    .filter((log) => log.payment_mode === "online")
    .reduce((sum, log) => sum + log.amount, 0);

  const netCashTotal = todayCashTotal - todayCashRefunds;
  const netOnlineTotal = todayOnlineTotal - todayOnlineRefunds;
  const todayTotal = netCashTotal + netOnlineTotal;

  const todayCashElement = document.getElementById("today-cash");
  const todayOnlineElement = document.getElementById("today-online");

  if (todayCashElement) todayCashElement.textContent = "₹" + netCashTotal;
  if (todayOnlineElement) todayOnlineElement.textContent = "₹" + netOnlineTotal;
  if (todayRevenue) todayRevenue.textContent = "₹" + todayTotal;

  const quickRenewBtn = document.getElementById("quick-renew-btn");
  if (quickRenewBtn && renewalsDue > 0) {
    quickRenewBtn.innerHTML = `
      <i class="fas fa-sync-alt"></i>
      <span>Renewals Due <span style="background-color: var(--danger); padding: 2px 6px; border-radius: 50%; margin-left: 5px; font-size: 0.7rem;">${renewalsDue}</span></span>
    `;
  } else if (quickRenewBtn) {
    quickRenewBtn.innerHTML = `
      <i class="fas fa-sync-alt"></i>
      <span>Renewals Due</span>
    `;
  }
}

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

  const renewalCount = roomInfo.renewal_count || 0;
  const dayNumber = renewalCount + 1;

  const checkinDate = new Date(roomInfo.checkin_time);
  const nextRenewalTime = new Date(checkinDate);
  nextRenewalTime.setDate(checkinDate.getDate() + dayNumber);

  const now = new Date();
  const timeLeft = nextRenewalTime - now;

  const hoursLeft = Math.floor(timeLeft / (1000 * 60 * 60));
  const minutesLeft = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));

  const expired = timeLeft <= 0;
  const canRenew = expired;
  const timeSinceExpiry = expired ? Math.abs(timeLeft) : 0;
  const formattedNextRenewal = formatDateTime(nextRenewalTime);

  let status;
  if (expired) {
    status = "renewable";
  } else if (hoursLeft < 1) {
    status = "expiring-soon";
  } else {
    status = "waiting";
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

function formatDateTime(date) {
  if (!(date instanceof Date)) {
    date = new Date(date);
  }
  return date.toISOString().substring(0, 19).replace("T", " ");
}

// ... (Rest of your functions remain the same - showCheckinModal, showCheckoutModal, etc.)
// I'll continue with the critical parts for the tab system

// Event Listeners
document.addEventListener("DOMContentLoaded", function () {
  debugLog("DOM loaded, initializing with lazy loading...");

  // Initialize camera
  initCamera();

  // Initialize service buttons
  initServiceButtons();

  // Initialize collapsible stats
  initCollapsibleStats();
  restoreStatsVisibility();

  // Initialize enhanced check-in form
  initEnhancedCheckinForm();
  window.showCheckinModal = showEnhancedCheckinModal;

  // Setup checkout confirmation
  setTimeout(setupCheckoutConfirmation, 500);

  // Initialize discount functionality
  setTimeout(initializeDiscountFeature, 1000);

  // Initialize bookings if available
  if (typeof initBookings === "function") {
    initBookings();
  }

  // MODIFIED: Tab navigation with lazy loading
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.addEventListener("click", async () => {
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

        // Show loading indicator
        if (tabName === "rooms" && roomsGrid) {
          roomsGrid.innerHTML =
            '<div class="loading-indicator"><span class="loader"></span><p>Loading rooms...</p></div>';
        }

        // Load data for this tab
        await loadDataForTab(tabName);
      } else {
        debugLog(`Tab content for ${tabName} not found`);
      }
    });
  });

  // MODIFIED: Initial load - only load rooms tab data
  loadDataForTab("rooms");

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

  // Floor filters
  document.querySelectorAll(".floor-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll(".floor-btn")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentFloor = btn.dataset.floor;
      debugLog(`Floor filter changed to: ${currentFloor}`);
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

  // MODIFIED: Refresh button
  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      refreshBtn.innerHTML =
        '<span class="loader" style="width: 20px; height: 20px;"></span>';

      // Invalidate cache
      invalidateAllCache();

      // Get current tab
      const activeTab = document.querySelector(".nav-item.active");
      const currentTab = activeTab ? activeTab.dataset.tab : "rooms";

      // Reload current tab data
      await loadDataForTab(currentTab);

      setTimeout(() => {
        refreshBtn.innerHTML = '<i class="fas fa-sync-alt"></i>';
        showNotification("Data refreshed successfully!", "success");
      }, 500);
    });
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

          const amountPaidInput = document.getElementById("amount-paid");
          const roomPriceInput = document.getElementById("room-price");

          if (amountPaidInput && roomPriceInput) {
            if (activePaymentMethod === "balance") {
              amountPaidInput.value = 0;
            } else {
              amountPaidInput.value = roomPriceInput.value || 0;
            }
          }
        }
      }
    });
  });

  // Check-in form submission
  const checkinForm = document.getElementById("checkin-form");
  if (checkinForm) {
    checkinForm.addEventListener("submit", async (e) => {
      e.preventDefault();

      let roomNumber = "";
      const roomDropdown = document.getElementById("checkin-room-dropdown");
      if (roomDropdown && roomDropdown.value) {
        roomNumber = roomDropdown.value;
      } else {
        const roomNumberElement = document.getElementById(
          "checkin-room-number"
        );
        if (roomNumberElement) {
          roomNumber = roomNumberElement.textContent;
        }
      }

      if (!roomNumber) {
        showNotification("Please select a room number", "error");
        return;
      }

      const guestNameInput = document.getElementById("guest-name");
      const guestMobileInput = document.getElementById("guest-mobile");
      const roomPriceInput = document.getElementById("room-price");
      const guestCountInput = document.getElementById("guest-count");
      const amountPaidInput = document.getElementById("amount-paid");
      const paymentMethodInput = document.getElementById("payment-method");

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

      if (amountPaid > 0 && paymentMethod === "balance") {
        showNotification(
          'Cannot select "Pay Later" when amount is provided. Please select Cash or Online payment method.',
          "error"
        );
        return;
      }

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
        const response = await fetch("/checkin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            room: roomNumber,
            name: guestName,
            mobile: guestMobile,
            price: roomPrice,
            guests: guestCount,
            payment: paymentMethod,
            amountPaid: amountPaid,
            photoPath: uploadedPhotoUrl,
            isAC: isAC,
          }),
        });

        if (!response.ok) {
          throw new Error(`Server responded with status: ${response.status}`);
        }

        const result = await response.json();
        if (result.success) {
          checkinModal.classList.remove("show");

          // Invalidate cache and reload rooms data
          invalidateAllCache();
          await loadDataForTab("rooms");

          let message = result.message || "Check-in successful!";
          if (result.serial_number) {
            message += ` (Serial #${result.serial_number})`;
          }
          showNotification(message, "success");
        } else {
          showNotification(result.message || "Error during check-in", "error");
        }
      } catch (error) {
        console.error("Error during check-in:", error);
        showNotification(`Error during check-in: ${error.message}`, "error");
      } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = "Complete Check-in";
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

  // Edit check-in time button
  const editCheckinTimeBtn = document.getElementById("edit-checkin-time");
  if (editCheckinTimeBtn) {
    editCheckinTimeBtn.addEventListener("click", () => {
      const roomNumber = document.getElementById(
        "checkout-room-number"
      )?.textContent;
      const currentTime = document.getElementById(
        "checkout-checkin-time"
      )?.textContent;
      if (roomNumber) {
        showEditTimeModal(roomNumber, currentTime);
      }
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
            `.renewal-item[data-room="${room}"]`
          );
          if (!roomElement) continue;

          const buttonElement = roomElement.querySelector(".renew-single-btn");
          if (!buttonElement) continue;

          if (buttonElement.innerHTML === "Renewed" || buttonElement.disabled) {
            continue;
          }

          buttonElement.disabled = true;
          buttonElement.innerHTML =
            '<span class="loader" style="width: 10px; height: 10px;"></span>';

          const success = await triggerRentRenewal(room);

          if (success) {
            successCount++;
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
          "success"
        );
      }

      if (failCount > 0) {
        showNotification(
          `Failed to renew ${failCount} room${failCount !== 1 ? "s" : ""}`,
          "warning"
        );
      }

      if (failCount === 0) {
        setTimeout(() => {
          if (rentRenewalModal) {
            rentRenewalModal.classList.remove("show");
          }
        }, 1500);
      }
    });
  }

  // Close modals
  document.querySelectorAll(".close-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".modal-backdrop").forEach((modal) => {
        modal.classList.remove("show");
      });

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

  // Set default dates for report
  const today = new Date().toISOString().split("T")[0];
  if (document.getElementById("start-date")) {
    document.getElementById("start-date").value = today;
  }
  if (document.getElementById("end-date")) {
    document.getElementById("end-date").value = today;
  }

  // Override reports tab click handler
  const reportsNavItem = document.querySelector(
    '.nav-item[data-tab="reports"]'
  );
  if (reportsNavItem) {
    const newReportsNavItem = reportsNavItem.cloneNode(true);
    reportsNavItem.parentNode.replaceChild(newReportsNavItem, reportsNavItem);

    newReportsNavItem.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      handleReportsTabAccess();
    });
  }

  debugLog("Initialization complete with lazy loading");
});

// Additional helper functions that need to be included

async function triggerRentRenewal(roomNumber) {
  try {
    const roomInfo = rooms[roomNumber];
    if (!roomInfo) return false;

    const renewalStatus = getRoomRenewalStatus(roomInfo);

    if (!renewalStatus.canRenew) {
      const hoursMinutesStr = `${renewalStatus.hoursLeft}h ${renewalStatus.minutesLeft}m`;
      showNotification(
        `Cannot renew yet. Please wait ${hoursMinutesStr} more.`,
        "error"
      );
      return false;
    }

    const newRenewalCount = (roomInfo.renewal_count || 0) + 1;

    debugLog(
      "Processing renewal for room " +
        roomNumber +
        ", new day: " +
        (newRenewalCount + 1)
    );

    const response = await fetch("/renew_rent", {
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
      roomInfo.renewal_count = newRenewalCount;

      if (roomInfo.last_renewal_time) {
        delete roomInfo.last_renewal_time;
      }

      if (!logs.renewals) logs.renewals = [];

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

      // Invalidate cache and refresh
      invalidateAllCache();
      await loadDataForTab("rooms");

      showNotification(
        `Room ${roomNumber} rent renewed for Day ${newRenewalCount + 1}!`,
        "success"
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

  renewalList.innerHTML = `
    <div class="loading-indicator">
      <span class="loader"></span>
      <p>Checking for renewals...</p>
    </div>
  `;

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

      const renewAllBtn = document.getElementById("renew-all-btn");
      if (renewAllBtn) {
        renewAllBtn.style.display = "none";
      }
    } else {
      dueRooms.sort((a, b) => b.timeSinceExpiry - a.timeSinceExpiry);

      const renewAllBtn = document.getElementById("renew-all-btn");
      if (renewAllBtn) {
        renewAllBtn.style.display = "block";
      }

      renewalList.innerHTML = "";
      dueRooms.forEach(({ room, info, status }) => {
        const hoursOverdue = Math.floor(
          status.timeSinceExpiry / (1000 * 60 * 60)
        );
        const minutesOverdue = Math.floor(
          (status.timeSinceExpiry % (1000 * 60 * 60)) / (1000 * 60)
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

        const renewButton = renewalItem.querySelector(".renew-single-btn");
        if (renewButton) {
          renewButton.addEventListener("click", function () {
            this.disabled = true;
            this.innerHTML =
              '<span class="loader" style="width: 10px; height: 10px;"></span>';

            triggerRentRenewal(room)
              .then((success) => {
                if (success) {
                  renewalItem.style.backgroundColor = "#e8f4e5";
                  this.innerHTML = "Renewed";
                } else {
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

  rentRenewalModal.classList.add("show");
}

function filterRoomsByBalance() {
  currentFilter = "balances";

  document.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.classList.remove("active");
  });

  const balancesFilterBtn = document.querySelector(
    '.filter-btn[data-filter="balances"]'
  );
  if (balancesFilterBtn) {
    balancesFilterBtn.classList.add("active");
  }

  renderRooms();
}

function showCheckinModal(roomNumber) {
  if (!checkinModal) {
    debugLog("Check-in modal not found");
    return;
  }

  const roomNumberElement = document.getElementById("checkin-room-number");
  if (roomNumberElement) {
    roomNumberElement.textContent = roomNumber;
  }

  const checkinForm = document.getElementById("checkin-form");
  if (checkinForm) {
    checkinForm.reset();
  }

  const paymentMethodInput = document.getElementById("payment-method");
  if (paymentMethodInput) {
    paymentMethodInput.value = "cash";
  }

  const photoPreviewContainer = document.getElementById(
    "photo-preview-container"
  );
  if (photoPreviewContainer) {
    photoPreviewContainer.style.display = "none";
  }

  const cameraContainer = document.getElementById("camera-container");
  if (cameraContainer) {
    cameraContainer.style.display = "none";
  }

  document.querySelectorAll(".payment-btn").forEach((btn) => {
    btn.classList.remove("active");
  });

  const cashBtn = document.querySelector('.payment-btn[data-payment="cash"]');
  if (cashBtn) {
    cashBtn.classList.add("active");
  }

  capturedPhotoData = null;
  uploadedPhotoUrl = null;

  checkinModal.classList.add("show");
}

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
    checkoutGuestName.textContent = roomInfo.guest.name;
  }

  const checkoutMobileNumber = document.getElementById(
    "checkout-mobile-number"
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

  const balanceEl = document.getElementById("checkout-balance");
  if (balanceEl) {
    if (roomInfo.balance < 0) {
      balanceEl.textContent = "₹" + Math.abs(roomInfo.balance) + " (refund)";
      balanceEl.classList.add("negative-balance");
    } else {
      balanceEl.textContent = "₹" + roomInfo.balance;
      balanceEl.classList.remove("negative-balance");
    }
  }

  const renewalStatus = getRoomRenewalStatus(roomInfo);
  const dayCountEl = document.getElementById("checkout-day-count");
  const renewalStatusEl = document.getElementById("checkout-renewal-status");

  if (dayCountEl) {
    dayCountEl.textContent = `Day ${renewalStatus.dayNumber}`;
  }

  if (renewalStatusEl) {
    renewalStatusEl.className = "status-tag";
    if (renewalStatus.expired) {
      renewalStatusEl.textContent = "Renewal Due";
      renewalStatusEl.classList.add("renewable");
    } else if (renewalStatus.hoursLeft < 1) {
      renewalStatusEl.textContent = `${renewalStatus.minutesLeft}m left`;
      renewalStatusEl.classList.add("warning");
    } else {
      renewalStatusEl.textContent = `${renewalStatus.hoursLeft}h ${renewalStatus.minutesLeft}m left`;
      renewalStatusEl.classList.add("waiting");
    }
  }

  const photoContainer = document.getElementById("checkout-photo-container");
  if (photoContainer) {
    if (roomInfo.guest.photo) {
      const guestPhoto = document.getElementById("checkout-guest-photo");
      if (guestPhoto) {
        guestPhoto.src = roomInfo.guest.photo;
      }
      photoContainer.style.display = "block";
    } else {
      photoContainer.style.display = "none";
    }
  }

  resetServiceForm();
  updateRenewalHistory(roomNumber);
  updatePaymentOrRefundUI(roomNumber);

  if (typeof updatePaymentLogs === "function") {
    updatePaymentLogs(roomNumber);
  }
}

function showCheckoutModal(roomNumber) {
  if (!checkoutModal) {
    debugLog("Checkout modal not found");
    return;
  }

  updateCheckoutModal(roomNumber);
  checkoutModal.classList.add("show");
}

async function uploadPhoto(file) {
  try {
    const formData = new FormData();
    formData.append("photo", file);

    const response = await fetch("/upload_photo", {
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

async function generateReport() {
  if (typeof generateEnhancedReport === "function") {
    // Load logs if not already loaded
    await loadLogsData();
    await loadTotalsData();
    generateEnhancedReport();
  } else {
    console.error("Enhanced report generation function not found");
    showNotification("Error: Analytics module not loaded properly", "error");
  }
}
// Update renewal history
function updateRenewalHistory(roomNumber) {
  const roomInfo = rooms[roomNumber];
  const renewalHistoryContainer = document.getElementById(
    "renewal-history-container"
  );
  const renewalHistoryContent = document.getElementById(
    "renewal-history-content"
  );
  const nextRenewalTime = document.getElementById("next-renewal-time");

  if (!renewalHistoryContainer || !renewalHistoryContent || !nextRenewalTime) {
    debugLog("Renewal history elements not found");
    return;
  }

  const renewalCount = roomInfo.renewal_count || 0;
  if (renewalCount === 0) {
    renewalHistoryContainer.style.display = "none";
    return;
  }

  renewalHistoryContainer.style.display = "block";
  const renewalStatus = getRoomRenewalStatus(roomInfo);
  renewalHistoryContent.innerHTML = "";

  renewalHistoryContent.innerHTML += `
    <div class="renewal-history-item">
      <div>Initial Check-in</div>
      <div>${roomInfo.checkin_time}</div>
    </div>
  `;

  const roomRenewals = logs.renewals
    ? logs.renewals
        .filter((log) => log.room === roomNumber)
        .sort((a, b) => {
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

  document.querySelectorAll(".service-btn").forEach((btn) => {
    btn.classList.remove("selected");
  });

  document.querySelectorAll(".payment-options .payment-btn").forEach((btn) => {
    btn.classList.remove("active");
  });

  const cashBtn = document.querySelector("#service-form .payment-btn.cash");
  if (cashBtn) {
    cashBtn.classList.add("active");
  }

  const quantityInput = document.getElementById("service-quantity");
  if (quantityInput) {
    quantityInput.value = 1;
  }

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
  const serviceButtons = document.querySelectorAll(".service-btn");
  if (serviceButtons.length === 0) {
    debugLog("No service buttons found");
  }

  serviceButtons.forEach((btn) => {
    btn.addEventListener("click", function () {
      const service = this.dataset.service;
      const price = this.dataset.price;

      debugLog(`Service clicked: ${service}, price: ${price}`);

      document.querySelectorAll(".service-btn").forEach((b) => {
        b.classList.remove("selected");
      });

      this.classList.add("selected");
      selectedService = service;

      if (serviceForm && serviceName && servicePrice) {
        serviceName.value = service;
        servicePrice.value = price;

        const quantityInput = document.getElementById("service-quantity");
        if (quantityInput) {
          quantityInput.value = 1;
        }

        if (price) {
          servicePrice.readOnly = true;
        } else {
          servicePrice.readOnly = false;
          servicePrice.focus();
        }

        updateServiceTotalPrice();
        serviceForm.classList.remove("hidden");
      } else {
        debugLog("Service form elements not found");
        if (!serviceForm) debugLog("- serviceForm not found");
        if (!serviceName) debugLog("- serviceName not found");
        if (!servicePrice) debugLog("- servicePrice not found");
      }
    });
  });

  const servicePriceInput = document.getElementById("service-price");
  const serviceQuantityInput = document.getElementById("service-quantity");

  if (servicePriceInput) {
    servicePriceInput.addEventListener("input", updateServiceTotalPrice);
  }

  if (serviceQuantityInput) {
    serviceQuantityInput.addEventListener("input", updateServiceTotalPrice);
  }

  const servicePaymentBtns = document.querySelectorAll(
    "#service-form .payment-btn"
  );
  if (servicePaymentBtns.length === 0) {
    debugLog("No payment buttons found in service form");
  }

  servicePaymentBtns.forEach((btn) => {
    btn.addEventListener("click", function () {
      debugLog(`Service payment method clicked: ${this.dataset.payment}`);

      document.querySelectorAll("#service-form .payment-btn").forEach((b) => {
        b.classList.remove("active");
      });

      this.classList.add("active");
      servicePaymentMethod = this.dataset.payment;
      if (servicePaymentMethodInput) {
        servicePaymentMethodInput.value = servicePaymentMethod;
      }
    });
  });

  const cancelServiceBtn = document.getElementById("cancel-service-btn");
  if (cancelServiceBtn) {
    cancelServiceBtn.addEventListener("click", resetServiceForm);
  } else {
    debugLog("Cancel service button not found");
  }

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

    const addServiceBtn = document.getElementById("add-service-btn");
    if (!addServiceBtn) {
      showNotification("Error: Add service button not found", "error");
      return;
    }

    addServiceBtn.disabled = true;
    addServiceBtn.innerHTML =
      '<span class="loader" style="width: 14px; height: 14px;"></span> Adding...';

    const totalPrice = price * quantity;
    const serviceWithQuantity =
      quantity > 1 ? `${service} × ${quantity}` : service;

    const response = await fetch("/add_on", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        room: roomNumber,
        item: serviceWithQuantity,
        price: totalPrice,
        unit_price: price,
        quantity: quantity,
        payment_method: servicePaymentMethod,
      }),
    });

    if (!response.ok) {
      throw new Error(`Server responded with status: ${response.status}`);
    }

    const result = await response.json();
    if (result.success) {
      invalidateAllCache();
      await loadDataForTab("rooms");
      updateCheckoutModal(roomNumber);

      if (servicePaymentMethod === "balance") {
        showNotification(
          `Added ${serviceWithQuantity} (₹${totalPrice}) to balance`,
          "success"
        );
      } else {
        showNotification(
          `Added ${serviceWithQuantity} (₹${totalPrice}) - paid by ${servicePaymentMethod}`,
          "success"
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
    const addServiceBtn = document.getElementById("add-service-btn");
    if (addServiceBtn) {
      addServiceBtn.disabled = false;
      addServiceBtn.innerHTML = "Add Service";
    }
  }
}

// Show edit time modal
function showEditTimeModal(roomNumber, currentCheckInTime) {
  if (!editTimeModal) {
    debugLog("Edit time modal not found");
    return;
  }

  let date = new Date();
  let time = "00:00";

  if (currentCheckInTime) {
    const parts = currentCheckInTime.split(" ");
    if (parts.length === 2) {
      date = new Date(parts[0]);
      time = parts[1];
    }
  }

  const formattedDate = date.toISOString().split("T")[0];

  const newCheckinDate = document.getElementById("new-checkin-date");
  const newCheckinTime = document.getElementById("new-checkin-time");

  if (newCheckinDate) newCheckinDate.value = formattedDate;
  if (newCheckinTime) newCheckinTime.value = time;

  const form = document.getElementById("edit-time-form");
  if (!form) {
    debugLog("Edit time form not found");
    return;
  }

  form.onsubmit = async (e) => {
    e.preventDefault();

    try {
      const newDate = document.getElementById("new-checkin-date").value;
      const newTime = document.getElementById("new-checkin-time").value;
      const newCheckInTime = `${newDate} ${newTime}`;

      const submitBtn = form.querySelector("button[type=submit]");
      if (!submitBtn) {
        debugLog("Submit button not found in edit time form");
        return;
      }

      const originalContent = submitBtn.innerHTML;
      submitBtn.disabled = true;
      submitBtn.innerHTML =
        '<span class="loader" style="width: 20px; height: 20px;"></span> Updating...';

      const response = await fetch("/update_checkin_time", {
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

        invalidateAllCache();
        await loadDataForTab("rooms");

        const checkoutCheckinTime = document.getElementById(
          "checkout-checkin-time"
        );
        if (checkoutCheckinTime) {
          checkoutCheckinTime.textContent = newCheckInTime;
        }

        showNotification("Check-in time updated successfully!", "success");
      } else {
        showNotification(
          result.message || "Error updating check-in time",
          "error"
        );
      }
    } catch (error) {
      console.error("Error updating check-in time:", error);
      showNotification(
        `Error updating check-in time: ${error.message}`,
        "error"
      );
    } finally {
      const submitBtn = form.querySelector("button[type=submit]");
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = "Update Check-in Time";
      }
    }
  };

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
      const renewalStatus = getRoomRenewalStatus(info);
      const checkinDate = new Date(info.checkin_time);
      const formattedCheckin = info.checkin_time;

      const now = new Date();
      const duration = Math.floor((now - checkinDate) / (1000 * 60 * 60 * 24));
      const hours = Math.floor(
        ((now - checkinDate) % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)
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
        info.balance < 0 ? " (refund)" : info.balance > 0 ? " (due)" : ""
      }
            </div>
          </div>
        </div>
      `;

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

// Populate room dropdown
async function populateRoomDropdown() {
  const dropdown = document.getElementById("checkin-room-dropdown");
  if (!dropdown) {
    debugLog("Room dropdown not found");
    return;
  }

  dropdown.innerHTML = "";

  try {
    const response = await fetch("/get_room_numbers");
    if (!response.ok) {
      throw new Error(`Server responded with status: ${response.status}`);
    }

    const data = await response.json();
    if (data.success) {
      data.rooms.forEach((roomNumber) => {
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

function updatePaymentOrRefundUI(roomNumber) {
  if (!paymentOrRefundSection) {
    debugLog("Payment or refund section not found");
    return;
  }

  const balance = rooms[roomNumber].balance;
  paymentOrRefundSection.innerHTML = "";

  if (balance >= 0) {
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

    const addPaymentBtn = document.getElementById("add-payment-btn");
    if (addPaymentBtn) {
      addPaymentBtn.addEventListener("click", function () {
        const activeMethod = document
          .getElementById("checkout-cash-btn")
          .classList.contains("active")
          ? "cash"
          : "online";
        addPayment(activeMethod);
      });
    }

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
            <button type="button" class="payment-btn cash active" id="refund-cash-btn">
              <i class="fas fa-money-bill"></i> Cash
            </button>
            <button type="button" class="payment-btn online" id="refund-online-btn">
              <i class="fas fa-mobile-alt"></i> Online
            </button>
          </div>
        </div>
        <div id="refund-error-message" class="error-message" style="color: var(--danger); margin-top: 0.5rem; display: none;"></div>
        <button id="process-refund-btn" class="action-btn btn-warning">
          Process Refund
        </button>
      </div>
    `;

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

    const processRefundBtn = document.getElementById("process-refund-btn");
    if (processRefundBtn) {
      processRefundBtn.addEventListener("click", processRefund);
    }

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
  }
}

async function processRefund() {
  try {
    const roomNumberElement = document.getElementById("checkout-room-number");
    const roomNumber = roomNumberElement.textContent;

    const guestName =
      document.getElementById("checkout-guest-name")?.textContent || "Unknown";

    const refundAmountInput = document.getElementById("refund-amount-input");
    if (!refundAmountInput) {
      showNotification("Error: Refund amount input not found", "error");
      return;
    }

    const refundAmount = parseInt(refundAmountInput.value) || 0;
    const maxRefundAmount = Math.abs(rooms[roomNumber].balance);

    if (refundAmount <= 0) {
      showNotification(
        "Please enter a valid refund amount greater than 0",
        "error"
      );
      return;
    }

    if (refundAmount > maxRefundAmount) {
      showNotification(
        `Refund amount cannot exceed ₹${maxRefundAmount}`,
        "error"
      );
      return;
    }

    const refundMethod =
      document.querySelector(".refund-container .payment-btn.active")?.id ===
      "refund-cash-btn"
        ? "cash"
        : "online";

    const btn = document.getElementById("process-refund-btn");
    if (!btn) {
      showNotification("Error: Process refund button not found", "error");
      return;
    }

    btn.disabled = true;
    btn.innerHTML =
      '<span class="loader" style="width: 20px; height: 20px;"></span> Processing...';

    const errorElement = document.getElementById("refund-error-message");
    if (errorElement) {
      errorElement.style.display = "none";
    }

    debugLog(
      `Processing refund of ₹${refundAmount} via ${refundMethod} for room ${roomNumber}`
    );

    const response = await fetch("/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        room: roomNumber,
        name: guestName,
        payment_mode: refundMethod,
        amount: refundAmount,
        is_refund: true,
        process_refund: true,
        time: new Date().toTimeString().split(" ")[0].slice(0, 5),
        date: new Date().toISOString().split("T")[0],
      }),
    });

    if (!response.ok) {
      throw new Error(`Server responded with status: ${response.status}`);
    }

    const result = await response.json();

    if (result.success) {
      debugLog(`Refund processed successfully: ${JSON.stringify(result)}`);

      invalidateAllCache();
      await loadDataForTab("rooms");
      updateCheckoutModal(roomNumber);

      showNotification(
        `Refund of ₹${refundAmount} processed successfully via ${refundMethod}!`,
        "success"
      );
    } else {
      if (errorElement) {
        errorElement.textContent =
          result.message || "Error processing refund. Please try again.";
        errorElement.style.display = "block";
      }

      showNotification(result.message || "Error processing refund", "error");
    }
  } catch (error) {
    console.error("Error processing refund:", error);

    const errorElement = document.getElementById("refund-error-message");
    if (errorElement) {
      errorElement.textContent = `Error: ${error.message}`;
      errorElement.style.display = "block";
    }

    showNotification(`Error processing refund: ${error.message}`, "error");
  } finally {
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

    let btn = null;
    const addPaymentBtn = document.getElementById("add-payment-btn");
    if (addPaymentBtn) {
      btn = addPaymentBtn;
    } else {
      btn = document.getElementById(`checkout-${mode}-btn`);
    }

    let originalContent = "";
    if (btn) {
      originalContent = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML =
        '<span class="loader" style="width: 14px; height: 14px;"></span> Processing...';
    } else {
      console.warn(
        `Button for payment mode ${mode} not found, proceeding anyway`
      );
    }

    const response = await fetch("/checkout", {
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
      invalidateAllCache();
      await loadDataForTab("rooms");
      updateCheckoutModal(roomNumber);

      showNotification(
        result.message || `Payment of ₹${amount} added successfully`,
        "success"
      );
    } else {
      showNotification(result.message || "Error adding payment", "error");
    }
  } catch (error) {
    console.error("Error adding payment:", error);
    showNotification(`Error adding payment: ${error.message}`, "error");
  } finally {
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

// Room pricing configuration
const roomPricing = {
  calculatePrice: function (roomNumber, guestCount) {
    roomNumber = String(roomNumber);
    guestCount = parseInt(guestCount);

    if (
      (roomNumber >= 3 && roomNumber <= 5) ||
      (roomNumber >= 13 && roomNumber <= 20)
    ) {
      return 250;
    } else if (roomNumber >= 23 && roomNumber <= 27) {
      if (guestCount === 1) return 300;
      else return 500;
    } else if (["200", "201", "206", "207"].includes(roomNumber)) {
      if (guestCount === 1) return 800;
      else return 1000 + Math.max(0, guestCount - 2) * 300;
    } else if (roomNumber >= 202 && roomNumber <= 205) {
      return 1600 + Math.max(0, guestCount - 2) * 300;
    } else if (
      (roomNumber >= 208 && roomNumber <= 211) ||
      (roomNumber >= 220 && roomNumber <= 227) ||
      roomNumber === "215"
    ) {
      if (guestCount === 1) return 450;
      else return 700 + Math.max(0, guestCount - 2) * 300;
    } else if (
      (roomNumber >= 212 && roomNumber <= 214) ||
      (roomNumber >= 216 && roomNumber <= 219)
    ) {
      if (guestCount === 1) return 450;
      else return 700;
    }

    return 500;
  },

  getRoomCategory: function (roomNumber) {
    roomNumber = String(roomNumber);

    if (roomNumber >= 1 && roomNumber <= 27) {
      return {
        category: "non-attach",
        label: "Non-Attach Room",
        analytics: { type: "non-attach" },
      };
    } else if (roomNumber >= 202 && roomNumber <= 205) {
      return {
        category: "premium-ac",
        label: "Premium AC Room",
        analytics: { type: "premium", isAC: true },
      };
    } else if (["200", "201", "206", "207"].includes(roomNumber)) {
      return {
        category: "premium",
        label: "Premium Room",
        analytics: { type: "premium", isAC: false },
      };
    } else if (
      (roomNumber >= 212 && roomNumber <= 215) ||
      (roomNumber >= 216 && roomNumber <= 219)
    ) {
      return {
        category: "single",
        label: "Single Room",
        analytics: { type: "single" },
      };
    } else if (roomNumber >= 208 && roomNumber <= 227) {
      return {
        category: "regular",
        label: "Regular Room",
        analytics: { type: "regular" },
      };
    }

    return {
      category: "regular",
      label: "Regular Room",
      analytics: { type: "regular" },
    };
  },
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

  if (roomDropdown) {
    roomDropdown.addEventListener("change", updateRoomInfo);
  }

  if (guestCountInput) {
    guestCountInput.addEventListener("change", updateRoomPrice);
    guestCountInput.addEventListener("input", updateRoomPrice);
  }

  if (acToggle) {
    acToggle.addEventListener("change", updateRoomPrice);
  }

  function updateRoomInfo() {
    const selectedRoom = roomDropdown.value;

    if (roomCategoryIndicator && selectedRoom) {
      const category = roomPricing.getRoomCategory(selectedRoom);
      roomCategoryIndicator.textContent = category.label;
      roomCategoryIndicator.className =
        "room-category-indicator room-category-" + category.category;

      if (acToggleContainer) {
        if (selectedRoom >= 202 && selectedRoom <= 205) {
          acToggleContainer.style.display = "block";
          if (acToggle) {
            acToggle.checked = false;

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

      if (roomDropdown.dataset) {
        roomDropdown.dataset.roomCategory = category.analytics.type;
        roomDropdown.dataset.isAc = category.analytics.isAC || false;
      }

      if (guestCountInput) {
        if (
          (selectedRoom >= 200 && selectedRoom <= 211) ||
          selectedRoom == 215 ||
          (selectedRoom >= 220 && selectedRoom <= 227) ||
          (selectedRoom >= 23 && selectedRoom <= 27)
        ) {
          guestCountInput.value = 2;
        } else {
          guestCountInput.value = 1;
        }
      }
    }

    updateRoomPrice();
  }

  function updateRoomPrice() {
    if (!roomDropdown || !guestCountInput || !roomPriceInput) return;

    const selectedRoom = roomDropdown.value;
    const guestCount = parseInt(guestCountInput.value) || 1;

    if (selectedRoom) {
      let price = roomPricing.calculatePrice(selectedRoom, guestCount);

      if (selectedRoom >= 202 && selectedRoom <= 205) {
        if (acToggle && !acToggle.checked) {
          price -= 600;

          if (roomCategoryIndicator) {
            roomCategoryIndicator.textContent = "Premium Room";
            roomCategoryIndicator.className =
              "room-category-indicator room-category-premium";
          }
        } else if (acToggle && acToggle.checked) {
          if (roomCategoryIndicator) {
            roomCategoryIndicator.textContent = "Premium AC Room";
            roomCategoryIndicator.className =
              "room-category-indicator room-category-premium-ac";
          }
        }
      }

      roomPriceInput.value = price;

      if (amountPaidInput) {
        const paymentMethodInput = document.getElementById("payment-method");
        const currentPaymentMethod = paymentMethodInput
          ? paymentMethodInput.value
          : "cash";

        if (currentPaymentMethod === "balance") {
          amountPaidInput.value = 0;
        } else {
          amountPaidInput.value = price;
        }
      }
    }
  }

  document.addEventListener("checkinModalOpened", updateRoomInfo);
}

function showEnhancedCheckinModal(roomNumber) {
  if (!checkinModal) {
    console.log("Check-in modal not found");
    return;
  }

  populateRoomDropdown().then(() => {
    const dropdown = document.getElementById("checkin-room-dropdown");
    if (dropdown) {
      const option = Array.from(dropdown.options).find(
        (opt) => opt.value === roomNumber
      );

      if (option) {
        dropdown.value = roomNumber;
      } else if (dropdown.options.length > 0) {
        dropdown.selectedIndex = 0;
      }
    }

    const checkinForm = document.getElementById("checkin-form");
    if (checkinForm) {
      checkinForm.reset();
    }

    const photoPreviewContainer = document.getElementById(
      "photo-preview-container"
    );
    if (photoPreviewContainer) {
      photoPreviewContainer.style.display = "none";
    }

    const cameraContainer = document.getElementById("camera-container");
    if (cameraContainer) {
      cameraContainer.style.display = "none";
    }

    capturedPhotoData = null;
    uploadedPhotoUrl = null;

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

    const event = new Event("checkinModalOpened");
    document.dispatchEvent(event);

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

  statsToggle.addEventListener("click", function () {
    this.classList.toggle("active");
    statsContainer.classList.toggle("hidden");

    const isVisible = !statsContainer.classList.contains("hidden");
    localStorage.setItem("statsVisible", isVisible ? "true" : "false");
  });
}

function restoreStatsVisibility() {
  const statsToggle = document.getElementById("stats-toggle");
  const statsContainer = document.getElementById("stats-container");

  if (!statsToggle || !statsContainer) return;

  const isVisible = localStorage.getItem("statsVisible") === "true";

  if (isVisible) {
    statsToggle.classList.add("active");
    statsContainer.classList.remove("hidden");
  } else {
    statsToggle.classList.remove("active");
    statsContainer.classList.add("hidden");
  }
}

function updateStatsToggleBadge() {
  const statsToggle = document.getElementById("stats-toggle");
  const statsContainer = document.getElementById("stats-container");

  if (
    !statsToggle ||
    !statsContainer ||
    !statsContainer.classList.contains("hidden")
  ) {
    return;
  }

  let renewalsDue = 0;

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

  const statsElement = document.getElementById("daily-checkin-count");
  if (statsElement) {
    statsElement.textContent = todayCount;
  }
}

// Report password protection logic
const REPORT_PASSWORD = "admin123";
let reportPasswordVerified = false;

function handleReportsTabAccess() {
  if (reportPasswordVerified) {
    showReportsTab();
    return;
  }

  const passwordModal = document.getElementById("password-modal");
  if (!passwordModal) {
    debugLog("Password modal not found, creating one...");
    createPasswordModal();
    return;
  }

  passwordModal.classList.add("show");

  const passwordInput = document.getElementById("report-password");
  const passwordError = document.getElementById("password-error");

  if (passwordInput) {
    passwordInput.value = "";
    passwordInput.focus();
  }

  if (passwordError) {
    passwordError.style.display = "none";
  }
}

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

  document.body.insertAdjacentHTML("beforeend", modalHtml);

  const passwordModal = document.getElementById("password-modal");
  if (passwordModal) {
    passwordModal.classList.add("show");
    const passwordInput = document.getElementById("report-password");
    if (passwordInput) {
      setTimeout(() => passwordInput.focus(), 100);
    }
  }
}

document.addEventListener("click", function (e) {
  if (e.target && e.target.id === "password-submit-btn") {
    console.log("Password submit clicked via delegation");
    e.preventDefault();
    e.stopPropagation();
    verifyReportPassword();
    return;
  }

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

  if (e.target && e.target.id === "password-modal") {
    console.log("Clicked outside password modal");
    const passwordModal = document.getElementById("password-modal");
    if (passwordModal) {
      passwordModal.classList.remove("show");
    }
    return;
  }
});

document.addEventListener("keyup", function (e) {
  if (e.target && e.target.id === "report-password" && e.key === "Enter") {
    console.log("Enter key pressed in password field");
    verifyReportPassword();
  }
});

function setupPasswordModalListeners() {
  console.log("Event delegation already set up globally");
}

function verifyReportPassword() {
  console.log("verifyReportPassword called");

  const passwordInput = document.getElementById("report-password");
  const passwordError = document.getElementById("password-error");
  const passwordModal = document.getElementById("password-modal");

  console.log("Elements found:", {
    passwordInput: !!passwordInput,
    passwordError: !!passwordError,
    passwordModal: !!passwordModal,
  });

  if (!passwordInput || !passwordError || !passwordModal) {
    debugLog("Password elements not found");
    console.error("Missing password modal elements");
    return;
  }

  const password = passwordInput.value;
  console.log("Password entered:", password ? "***" : "empty");

  if (password === REPORT_PASSWORD) {
    console.log("Password correct");
    reportPasswordVerified = true;
    passwordModal.classList.remove("show");
    showReportsTab();
    showNotification("Access granted to reports section", "success");
  } else {
    console.log("Password incorrect");
    passwordError.style.display = "block";
    passwordInput.value = "";
    passwordInput.focus();

    passwordInput.style.animation = "shake 0.5s";
    setTimeout(() => {
      passwordInput.style.animation = "";
    }, 500);
  }
}

function showReportsTab() {
  document.querySelectorAll(".tab-content").forEach((content) => {
    content.classList.add("hidden");
  });

  const reportsTab = document.getElementById("reports-tab");
  if (reportsTab) {
    reportsTab.classList.remove("hidden");
  }

  document.querySelectorAll(".nav-item").forEach((navItem) => {
    navItem.classList.remove("active");
  });

  const reportsNavItem = document.querySelector(
    '.nav-item[data-tab="reports"]'
  );
  if (reportsNavItem) {
    reportsNavItem.classList.add("active");
  }
}

function addDiscountToCheckoutModal() {
  const balanceRow = document.querySelector(
    "#checkout-modal .detail-row:nth-child(5)"
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

function createDiscountDialog() {
  const dialog = document.createElement("div");
  dialog.className = "modal-backdrop";
  dialog.id = "discount-modal";
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

async function applyDiscount() {
  const roomNumber = document.getElementById(
    "checkout-room-number"
  ).textContent;
  const discountAmount =
    parseInt(document.getElementById("discount-amount").value) || 0;
  const discountReason = document.getElementById("discount-reason").value;

  let reason = discountReason;
  if (discountReason === "Other") {
    reason = document.getElementById("other-discount-reason").value || "Other";
  }

  if (discountAmount <= 0) {
    showNotification("Please enter a valid discount amount", "error");
    return;
  }

  try {
    const submitBtn = document.getElementById("apply-discount-btn");
    submitBtn.disabled = true;
    submitBtn.innerHTML =
      '<span class="loader" style="width: 20px; height: 20px;"></span> Processing...';

    const response = await fetch("/apply_discount", {
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
      document.getElementById("discount-modal").classList.remove("show");

      invalidateAllCache();
      await loadDataForTab("rooms");
      updateCheckoutModal(roomNumber);

      showNotification(
        `Discount of ₹${discountAmount} applied successfully`,
        "success"
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

function updateCheckoutModalWithDiscount(roomNumber) {
  const roomInfo = rooms[roomNumber];
  if (!roomInfo || !roomInfo.guest) return;

  const discountEl = document.getElementById("checkout-discount");
  if (discountEl) {
    let totalDiscount = 0;

    if (roomInfo.discounts && Array.isArray(roomInfo.discounts)) {
      totalDiscount = roomInfo.discounts.reduce(
        (sum, discount) => sum + discount.amount,
        0
      );
    }

    discountEl.textContent = "₹" + totalDiscount;

    if (totalDiscount > 0) {
      discountEl.style.color = "var(--success)";
    } else {
      discountEl.style.color = "";
    }
  }

  const addDiscountBtn = document.getElementById("add-discount-btn");
  if (addDiscountBtn) {
    addDiscountBtn.onclick = function () {
      document.getElementById("discount-modal").classList.add("show");
      document.getElementById("discount-amount").value = "";
      document.getElementById("discount-amount").focus();
    };
  }
}

function initializeDiscountFeature() {
  addDiscountToCheckoutModal();
  createDiscountDialog();

  const originalUpdateCheckoutModal = updateCheckoutModal;
  window.updateCheckoutModal = function (roomNumber) {
    originalUpdateCheckoutModal(roomNumber);
    updateCheckoutModalWithDiscount(roomNumber);
  };
}

// Global checkout handling variables
let checkoutHandlersInitialized = false;
let checkoutInProgress = false;

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

  confirmCheckoutBtn.addEventListener("click", function (event) {
    event.preventDefault();

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

    if (balance > 0) {
      console.log("Checkout blocked - positive balance");
      showNotification("Please clear the balance before checkout", "error");
      return;
    }

    if (balance < 0) {
      return;
    }

    const confirmRoomElement = document.getElementById("confirm-checkout-room");
    const confirmGuestElement = document.getElementById(
      "confirm-checkout-guest"
    );

    if (confirmRoomElement) confirmRoomElement.textContent = roomNumber;
    if (confirmGuestElement) confirmGuestElement.textContent = guestName;

    const checkoutConfirmModal = document.getElementById(
      "checkout-confirm-modal"
    );
    if (checkoutConfirmModal) {
      checkoutConfirmModal.classList.add("show");
      console.log("Confirmation modal displayed");
    } else {
      console.error("Confirmation modal element not found");
      showNotification("Error: Confirmation modal not found", "error");
    }
  });

  const proceedCheckoutBtn = document.getElementById("proceed-checkout-btn");
  if (proceedCheckoutBtn) {
    proceedCheckoutBtn.addEventListener("click", async function () {
      console.log("Proceed checkout clicked");

      if (checkoutInProgress) {
        console.log("Checkout already in progress, ignoring proceed click");
        return;
      }

      checkoutInProgress = true;

      this.disabled = true;
      this.innerHTML =
        '<span class="loader" style="width: 20px; height: 20px;"></span> Processing...';

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

      if (balance > 0) {
        console.log("Checkout blocked in proceed step - positive balance");
        showNotification("Please clear the balance before checkout", "error");
        checkoutInProgress = false;
        this.disabled = false;
        this.innerHTML = "Yes, Checkout";

        const checkoutConfirmModal = document.getElementById(
          "checkout-confirm-modal"
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
          "checkout-confirm-modal"
        );
        if (checkoutConfirmModal) {
          checkoutConfirmModal.classList.remove("show");
        }
        return;
      }

      try {
        console.log("Sending checkout request to server");

        const response = await fetch("/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            room: roomNumber,
            final_checkout: true,
          }),
        });

        if (!response.ok) {
          throw new Error(`Server responded with status: ${response.status}`);
        }

        const result = await response.json();
        if (result.success) {
          console.log("Checkout successful");

          const checkoutConfirmModal = document.getElementById(
            "checkout-confirm-modal"
          );
          if (checkoutConfirmModal) {
            checkoutConfirmModal.classList.remove("show");
          }

          const checkoutModal = document.getElementById("checkout-modal");
          if (checkoutModal) {
            checkoutModal.classList.remove("show");
          }

          invalidateAllCache();
          await loadDataForTab("rooms");

          showNotification(result.message || "Checkout successful!", "success");
        } else {
          console.error("Checkout failed:", result.message);
          showNotification(result.message || "Error during checkout", "error");
        }
      } catch (error) {
        console.error("Error during checkout:", error);
        showNotification(`Error during checkout: ${error.message}`, "error");
      } finally {
        checkoutInProgress = false;
        this.disabled = false;
        this.innerHTML = "Yes, Checkout";
      }
    });
  } else {
    console.error("Proceed checkout button not found");
  }

  const cancelConfirmBtn = document.getElementById(
    "cancel-confirm-checkout-btn"
  );
  if (cancelConfirmBtn) {
    cancelConfirmBtn.addEventListener("click", function () {
      console.log("Cancel confirmation clicked");
      const checkoutConfirmModal = document.getElementById(
        "checkout-confirm-modal"
      );
      if (checkoutConfirmModal) {
        checkoutConfirmModal.classList.remove("show");
      }
      checkoutInProgress = false;
    });
  }

  const confirmModalCloseBtn = document.querySelector(
    "#checkout-confirm-modal .close-btn"
  );
  if (confirmModalCloseBtn) {
    confirmModalCloseBtn.addEventListener("click", function () {
      console.log("Close confirmation modal clicked");
      const checkoutConfirmModal = document.getElementById(
        "checkout-confirm-modal"
      );
      if (checkoutConfirmModal) {
        checkoutConfirmModal.classList.remove("show");
      }
      checkoutInProgress = false;
    });
  }

  checkoutHandlersInitialized = true;
}
