// transaction-tracking.js - Enhanced Transaction Tracking System with Unified Styling

class TransactionTracker {
  constructor() {
    this.dailyCounters = this.loadDailyCounters();
    this.todayDate = new Date().toISOString().split("T")[0];
    this.initializeTodayCounter();
  }

  loadDailyCounters() {
    try {
      const stored = localStorage.getItem("lodge_daily_counters");
      return stored ? JSON.parse(stored) : {};
    } catch (error) {
      console.error("Error loading daily counters:", error);
      return {};
    }
  }

  saveDailyCounters() {
    try {
      localStorage.setItem(
        "lodge_daily_counters",
        JSON.stringify(this.dailyCounters)
      );
    } catch (error) {
      console.error("Error saving daily counters:", error);
    }
  }

  initializeTodayCounter() {
    if (!this.dailyCounters[this.todayDate]) {
      this.dailyCounters[this.todayDate] = 0;
      this.saveDailyCounters();
    }
  }

  getNextSerialNumber() {
    this.dailyCounters[this.todayDate] =
      (this.dailyCounters[this.todayDate] || 0) + 1;
    this.saveDailyCounters();
    return this.dailyCounters[this.todayDate];
  }

  getSerialNumberForDate(date, roomNumber) {
    const key = `${date}_${roomNumber}`;
    const stored = localStorage.getItem(`serial_${key}`);
    if (stored) {
      return parseInt(stored);
    }
    return null;
  }

  storeSerialNumber(date, roomNumber, serialNumber) {
    const key = `${date}_${roomNumber}`;
    localStorage.setItem(`serial_${key}`, serialNumber.toString());
  }

  cleanupOldCounters() {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const cutoffDate = thirtyDaysAgo.toISOString().split("T")[0];

    for (const date in this.dailyCounters) {
      if (date < cutoffDate) {
        delete this.dailyCounters[date];
      }
    }
    this.saveDailyCounters();
  }

  getTransactionTag(log, logType) {
    const tags = [];

    if (
      log.booking_id ||
      log.type === "booking_advance" ||
      log.type === "booking_payment" ||
      log.type === "booking_final_payment"
    ) {
      tags.push({
        text: "BOOKING",
        class: "transaction-tag booking-tag",
        color: "#6f42c1",
      });
    }

    if (log.room && this.isRenewalTransaction(log)) {
      tags.push({
        text: "CONTINUE",
        class: "transaction-tag continue-tag",
        color: "#28a745",
      });
    }

    if (log.item) {
      tags.push({
        text: "SERVICE",
        class: "transaction-tag service-tag",
        color: "#ffc107",
      });
    }

    if (logType === "refunds") {
      tags.push({
        text: "REFUND",
        class: "transaction-tag refund-tag",
        color: "#dc3545",
      });
    }

    return tags;
  }

  isRenewalTransaction(log) {
    if (!log.room || !rooms[log.room]) return false;

    const room = rooms[log.room];
    if (!room.checkin_time || !room.guest) return false;

    try {
      const checkinDate = new Date(room.checkin_time);
      const logDateTime = new Date(`${log.date} ${log.time || "00:00"}`);

      const timeDiff = logDateTime - checkinDate;
      const hoursDiff = timeDiff / (1000 * 60 * 60);

      return hoursDiff > 23;
    } catch (error) {
      console.error("Error checking renewal status:", error);
      return false;
    }
  }

  getDisplaySerialNumber(log) {
    if (!log.room || !log.date) return null;

    const storedSerial = this.getSerialNumberForDate(log.date, log.room);
    if (storedSerial) return storedSerial;

    if (log.date === this.todayDate && this.isFreshCheckin(log)) {
      return null;
    }

    return null;
  }

  isFreshCheckin(log) {
    if (!log.room || !rooms[log.room]) return false;

    const room = rooms[log.room];
    if (!room.checkin_time) return false;

    try {
      const checkinDate = new Date(room.checkin_time)
        .toISOString()
        .split("T")[0];
      const logDate = log.date;

      return checkinDate === logDate;
    } catch (error) {
      return false;
    }
  }

  processCheckin(roomNumber, checkinDate = null, isBookingConversion = false) {
    const date = checkinDate || this.todayDate;

    if (date === this.todayDate) {
      const serialNumber = this.getNextSerialNumber();
      this.storeSerialNumber(date, roomNumber, serialNumber);

      const checkinType = isBookingConversion
        ? "booking conversion"
        : "fresh check-in";
      console.log(
        `Assigned serial number ${serialNumber} to room ${roomNumber} for ${date} (${checkinType})`
      );
      return serialNumber;
    }

    return null;
  }

  initialize() {
    this.cleanupOldCounters();
    console.log("Transaction Tracker initialized");
    console.log(`Today's counter: ${this.dailyCounters[this.todayDate] || 0}`);
  }
}

// Transaction Log Management Functions
class TransactionLogManager {
  constructor(transactionTracker) {
    this.transactionTracker = transactionTracker;
  }

  renderEnhancedLogs() {
    const transactionLog = document.getElementById("transaction-log");
    if (!transactionLog) {
      console.log("Transaction log element not found");
      return;
    }

    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const dayBeforeYesterday = new Date(today);
    dayBeforeYesterday.setDate(dayBeforeYesterday.getDate() - 2);

    const todayStr = today.toISOString().split("T")[0];
    const yesterdayStr = yesterday.toISOString().split("T")[0];
    const dayBeforeYesterdayStr = dayBeforeYesterday
      .toISOString()
      .split("T")[0];

    const recentDates = [todayStr, yesterdayStr, dayBeforeYesterdayStr];

    const recentCashLogs = (logs.cash || []).filter((log) =>
      recentDates.includes(log.date)
    );
    const recentOnlineLogs = (logs.online || []).filter((log) =>
      recentDates.includes(log.date)
    );
    const recentRefundLogs = (logs.refunds || []).filter((log) =>
      recentDates.includes(log.date)
    );

    const expensesLogs = logs.expenses || [];
    const recentExpenseLogs = expensesLogs.filter(
      (log) =>
        recentDates.includes(log.date) && log.expense_type === "transaction"
    );

    const allRecentLogs = [
      ...recentCashLogs.map((log) => ({ ...log, logType: "cash" })),
      ...recentOnlineLogs.map((log) => ({ ...log, logType: "online" })),
      ...recentRefundLogs.map((log) => ({ ...log, logType: "refunds" })),
      ...recentExpenseLogs.map((log) => ({ ...log, logType: "expenses" })),
    ].sort((a, b) => {
      if (a.date !== b.date) {
        return new Date(b.date) - new Date(a.date);
      }

      const timeA = a.time || "00:00:00";
      const timeB = b.time || "00:00:00";

      const getSeconds = (timeStr) => {
        const [hours, minutes, seconds = 0] = timeStr.split(":").map(Number);
        return hours * 3600 + minutes * 60 + seconds;
      };

      const timeSecondsA = getSeconds(timeA);
      const timeSecondsB = getSeconds(timeB);

      if (timeSecondsA !== timeSecondsB) {
        return timeSecondsB - timeSecondsA;
      }

      const serialA = a.serial_number || 0;
      const serialB = b.serial_number || 0;

      return serialB - serialA;
    });

    const cashTotal = document.getElementById("cash-total");
    const onlineTotal = document.getElementById("online-total");
    const refundTotal = document.getElementById("refund-total");
    const totalRevenue = document.getElementById("total-revenue");

    if (cashTotal) cashTotal.textContent = "₹" + totals.cash;
    if (onlineTotal) onlineTotal.textContent = "₹" + totals.online;
    if (refundTotal) refundTotal.textContent = "₹" + (totals.refunds || 0);
    if (totalRevenue)
      totalRevenue.textContent =
        "₹" + (totals.cash + totals.online - (totals.refunds || 0));

    if (allRecentLogs.length === 0) {
      transactionLog.innerHTML = `<div class="empty-state" style="padding: 2rem;">
        <i class="fas fa-receipt fa-3x"></i>
        <p>No transactions in the past 3 days</p>
      </div>`;
      return;
    }

    const logsByDate = {};
    allRecentLogs.forEach((log) => {
      if (!logsByDate[log.date]) {
        logsByDate[log.date] = [];
      }
      logsByDate[log.date].push(log);
    });

    let logsHTML = "";

    function formatDate(dateStr) {
      const date = new Date(dateStr);
      const options = { weekday: "long", month: "short", day: "numeric" };
      return date.toLocaleDateString("en-US", options);
    }

    Object.keys(logsByDate)
      .sort((a, b) => new Date(b) - new Date(a))
      .forEach((date) => {
        let dateDisplay = formatDate(date);

        if (date === todayStr) {
          dateDisplay = "Today (" + dateDisplay + ")";
        } else if (date === yesterdayStr) {
          dateDisplay = "Yesterday (" + dateDisplay + ")";
        }

        logsHTML += `<div class="log-date-header">${dateDisplay}</div>`;

        logsByDate[date].forEach((log) => {
          logsHTML += this.renderEnhancedLogItem(log, log.logType);
        });
      });

    transactionLog.innerHTML = logsHTML;
  }

  renderEnhancedLogItem(log, logType) {
    const tags = this.getTransactionTags(log, logType);
    const serialNumber = this.getLogSerialNumber(log);

    let type = "Unknown";
    let color = "";
    let additionalInfo = "";

    if (logType === "refunds") {
      type = "Refund";
      color = 'style="color: var(--danger)"';
    } else if (logType === "expenses") {
      type = log.category || "Expense";
      color = 'style="color: var(--danger)"';
      additionalInfo = "";
    } else if (log.item || log.transaction_type === "service") {
      type = `Add-on: ${log.item}`;
    } else if (logType === "discounts") {
      type = "Discount";
      color = 'style="color: var(--success)"';
      additionalInfo = log.reason ? ` (${log.reason})` : "";
    } else if (logType === "cash") {
      if (log.payment_method === "pay_later" || log.amount === 0) {
        type = "Pay Later";
        color = 'style="color: var(--warning)"';
      } else {
        type = "Cash Payment";
      }
    } else if (logType === "online") {
      type = "Online Payment";
    }

    let tagsHtml = "";
    if (tags.length > 0) {
      tagsHtml = tags
        .map(
          (tag) =>
            `<span class="${tag.class}" style="background-color: ${tag.color}">${tag.text}</span>`
        )
        .join(" ");
    }

    let serialHtml = "";
    if (serialNumber) {
      serialHtml = `<span class="serial-number">#${serialNumber}</span>`;
    }

    const shiftInfo = log.room_shifted
      ? `<span class="room-shifted-badge">Shifted: ${log.old_room} → ${log.room}</span>`
      : "";

    let amountDisplay = `₹${log.amount}`;
    if (
      log.amount === 0 &&
      (log.payment_method === "pay_later" || log.is_fresh_checkin)
    ) {
      amountDisplay = "₹0";
      color = 'style="color: var(--warning)"';
    } else if (logType === "expenses") {
      amountDisplay = `<strong>₹${log.amount}</strong>`;
    }

    let titleContent = "";
    if (logType === "expenses") {
      // description is the user-entered text; for payments-collection entries it
      // gets stored in the `name` field, so fall back to that.
      const expenseLabel = log.description || log.name || "Expense";
      titleContent = `<strong>${expenseLabel}</strong>`;
    } else {
      titleContent = `Room ${log.room} - ${log.name}`;
    }

    return `
      <div class="log-item">
        <div class="log-details">
          <div class="log-title">
            ${serialHtml}
            ${titleContent}
            ${shiftInfo}
          </div>
          <div class="log-subtitle">
            ${type}${additionalInfo} at ${log.time || "N/A"}
            ${tagsHtml}
          </div>
        </div>
        <div class="log-amount" ${color}>${amountDisplay}</div>
      </div>
    `;
  }

  getTransactionTags(log, logType) {
    const tags = [];

    if (
      logType === "refunds" ||
      log.transaction_type === "refund" ||
      log.transaction_type === "checkout_refund"
    ) {
      tags.push({
        text: "REFUND",
        class: "transaction-tag refund-tag",
        color: "#dc3545",
      });
      return tags;
    }

    if (logType === "expenses") {
      return tags;
    }

    if (log.item || log.transaction_type === "service") {
      tags.push({
        text: "SERVICE",
        class: "transaction-tag service-tag",
        color: "#ffc107",
      });
      return tags;
    }

    if (
      log.booking_id ||
      log.type === "booking_advance" ||
      log.type === "booking_payment" ||
      log.type === "booking_final_payment" ||
      log.transaction_type === "booking_conversion" ||
      log.is_booking_conversion
    ) {
      tags.push({
        text: "BOOKING",
        class: "transaction-tag booking-tag",
        color: "#6f42c1",
      });
      return tags;
    }

    if (
      log.payment_method === "pay_later" ||
      (log.amount === 0 && log.is_fresh_checkin)
    ) {
      tags.push({
        text: "PAY LATER",
        class: "transaction-tag pay-later-tag",
        color: "#fd7e14",
      });
      return tags;
    }

    let isRenewal = false;

    if (log.is_renewal === true || log.transaction_type === "renewal_payment") {
      isRenewal = true;
    }

    if (
      !isRenewal &&
      log.room &&
      log.date &&
      rooms[log.room] &&
      rooms[log.room].checkin_time
    ) {
      try {
        const checkinDate = rooms[log.room].checkin_time.split(" ")[0];
        const logDate = log.date;

        if (checkinDate !== logDate) {
          isRenewal = true;
        }
      } catch (error) {
        // Ignore error
      }
    }

    if (isRenewal) {
      tags.push({
        text: "CONTINUE",
        class: "transaction-tag continue-tag",
        color: "#28a745",
      });
    }

    return tags;
  }

  getLogSerialNumber(log) {
    const isEligibleCheckin =
      log.is_fresh_checkin ||
      log.transaction_type === "fresh_checkin" ||
      log.transaction_type === "booking_conversion" ||
      log.is_booking_conversion;

    // Settlement payments carry the original check-in serial number forward
    const isSettlement =
      log.transaction_type === "settlement_payment" ||
      log.type === "settlement_payment";

    if (!isEligibleCheckin && !isSettlement) {
      return null;
    }

    if (
      log.item ||
      log.transaction_type === "service" ||
      log.transaction_type === "refund" ||
      log.is_renewal ||
      log.transaction_type === "renewal_payment"
    ) {
      return null;
    }

    if (log.serial_number) {
      return log.serial_number;
    }

    return null;
  }

  updatePaymentLogs(roomNumber) {
    const paymentLogsContainer = document.getElementById(
      "checkout-payment-logs"
    );
    if (!paymentLogsContainer) {
      console.log("Payment logs container not found");
      return;
    }

    paymentLogsContainer.innerHTML = `<div class="loading-indicator"><span class="loader"></span></div>`;

    const roomInfo = rooms[roomNumber];
    if (!roomInfo || !roomInfo.guest) {
      paymentLogsContainer.innerHTML =
        '<div class="log-item">No payments recorded</div>';
      return;
    }

    // Fetch full payment history from the server — /get_history queries
    // Firestore directly and is NOT limited to the 3-day window that
    // /get_data uses for the main logs cache.
    apiFetch("/get_history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room: roomNumber, name: roomInfo.guest.name }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (!data.success) {
          paymentLogsContainer.innerHTML =
            '<div class="log-item">Could not load payment history</div>';
          return;
        }

        const _refundTypes = new Set([
          "refund", "checkout_refund", "manual_refund", "booking_cancel_refund"
        ]);

        // Combine all payment types from the response.
        // Renewals are excluded — this tab shows cash, online, service and shift payments only.
        const allPayments = [
          ...(data.cash || []).map((p) => ({ ...p, _source: "cash" })),
          ...(data.online || []).map((p) => ({ ...p, _source: "online" })),
          ...(data.refunds || []).map((p) => ({ ...p, _source: "refund" })),
          ...(data.addons || []).map((p) => ({ ...p, _source: "addon" })),
          ...(data.shifts || []).map((p) => ({ ...p, _source: "shift" })),
        ].sort((a, b) => {
          const da = a.date ? new Date(`${a.date} ${a.time || "00:00"}`) : new Date(0);
          const db = b.date ? new Date(`${b.date} ${b.time || "00:00"}`) : new Date(0);
          return db - da;
        });

        if (allPayments.length === 0) {
          paymentLogsContainer.innerHTML =
            '<div class="log-item">No payments recorded</div>';
          return;
        }

        // Deduplicate by a stable key
        const seen = new Set();
        let logsHtml = "";

        allPayments.forEach((payment) => {
          const key = `${payment.date}-${payment.time}-${payment.amount || 0}-${payment.type || ""}-${payment.item || ""}`;
          if (seen.has(key)) return;
          seen.add(key);

          let paymentType = "Payment";
          let colorStyle = "";
          let amountText = `₹${payment.amount || 0}`;
          let badgeHtml = "";

          const src = payment._source;
          const ptype = payment.type || "";

          if (src === "refund" || _refundTypes.has(ptype)) {
            paymentType = "Refund";
            colorStyle = "style='color: var(--danger)'";

          } else if (src === "addon" || ptype === "addon") {
            const itemName = payment.item || payment.note || "Add-on";
            paymentType = `Add-on: ${itemName}`;
            colorStyle = "style='color: var(--warning)'";
            const method = payment.method || payment.payment_method || "balance";
            badgeHtml = `<span class="service-payment-badge ${method}">${method}</span>`;
            amountText = `₹${payment.amount || payment.price || 0}`;

          } else if (src === "shift" || ptype === "room_shift") {
            const oldRoom = payment.old_room || "?";
            paymentType = `Room Shifted from Room ${oldRoom}`;
            colorStyle = "style='color: var(--info, #17a2b8)'";
            amountText = "";   // no monetary amount for a shift

          } else if (ptype === "booking_advance" || ptype === "booking_payment") {
            const method = (payment.method || "cash");
            paymentType = `Booking Advance (${method})`;
            colorStyle = "style='color: var(--info, #17a2b8)'";

          } else if (ptype === "booking_conversion") {
            if (payment.amount === 0) {
              paymentType = "Booking — Fully Paid";
              colorStyle = "style='color: var(--warning)'";
            } else {
              const method = (payment.method || "cash");
              paymentType = `Booking Final Payment (${method})`;
            }

          } else if (src === "cash" || payment.method === "cash") {
            if (payment.payment_method === "pay_later" || payment.amount === 0) {
              paymentType = "Pay Later";
              colorStyle = "style='color: var(--warning)'";
            } else {
              paymentType = "Cash Payment";
            }

          } else if (src === "online" || payment.method === "online") {
            paymentType = "Online Payment";
          }

          logsHtml += `
            <div class="log-item">
              <div class="log-details">
                <div class="log-title">${paymentType}${badgeHtml}</div>
                <div class="log-subtitle">${payment.time || "N/A"} on ${payment.date || "N/A"}</div>
              </div>
              <div class="log-amount" ${colorStyle}>${amountText}</div>
            </div>
          `;
        });

        paymentLogsContainer.innerHTML = logsHtml;
      })
      .catch((err) => {
        console.error("Error loading payment history:", err);
        paymentLogsContainer.innerHTML =
          '<div class="log-item">Error loading payment history</div>';
      });
  }
}

const transactionTrackingStyles = `
    .transaction-tag {
        display: inline-block;
        padding: 2px 6px;
        border-radius: 3px;
        font-size: 0.7rem;
        font-weight: bold;
        color: white;
        margin-left: 5px;
        text-transform: uppercase;
    }

    .booking-tag {
        background-color: #6f42c1;
    }

    .continue-tag {
        background-color: #28a745;
    }

    .service-tag {
        background-color: #ffc107;
        color: #333;
    }

    .refund-tag {
        background-color: #dc3545;
    }

    .expense-tag {
        background-color: #e74c3c;
    }

    .pay-later-tag {
        background-color: #fd7e14;
    }

    .serial-number {
        display: inline-block;
        background-color: #007bff;
        color: white;
        padding: 2px 6px;
        border-radius: 3px;
        font-size: 0.7rem;
        font-weight: bold;
        margin-right: 8px;
    }

    .room-shifted-badge {
        background-color: #17a2b8;
        color: white;
        padding: 2px 6px;
        border-radius: 3px;
        font-size: 0.7rem;
        margin-left: 5px;
    }

    .log-title {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 5px;
    }

    .log-subtitle {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 5px;
        margin-top: 3px;
    }

    .service-payment-badge {
        display: inline-block;
        padding: 1px 4px;
        border-radius: 3px;
        font-size: 0.6rem;
        font-weight: bold;
        text-transform: uppercase;
        margin-left: 5px;
    }

    .service-payment-badge.cash {
        background-color: #27ae60;
        color: white;
    }

    .service-payment-badge.online {
        background-color: #007bff;
        color: white;
    }

    .service-payment-badge.balance {
        background-color: #6c757d;
        color: white;
    }

    .log-date-header {
        font-weight: bold;
        color: var(--primary);
        padding: 0.5rem 0;
        border-bottom: 1px solid var(--border);
        margin-bottom: 0.5rem;
        text-align: left;
    }

    .log-item {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        padding: 0.75rem;
        border-bottom: 1px solid var(--border);
        background: var(--card-bg);
        margin-bottom: 0.25rem;
        border-radius: 8px;
    }

    .log-details {
        flex: 1;
        min-width: 0;
    }

    .log-amount {
        font-weight: bold;
        white-space: nowrap;
        margin-left: 1rem;
    }

    @media (max-width: 576px) {
        .transaction-tag,
        .serial-number,
        .service-payment-badge {
            font-size: 0.65rem;
            padding: 1px 4px;
        }
        
        .log-title,
        .log-subtitle {
            gap: 3px;
        }

        .log-item {
            padding: 0.5rem;
        }
    }
`;

function addTransactionTrackingStyles() {
  const styleSheet = document.createElement("style");
  styleSheet.textContent = transactionTrackingStyles;
  document.head.appendChild(styleSheet);
}

let transactionTracker;
let transactionLogManager;

document.addEventListener("DOMContentLoaded", function () {
  transactionTracker = new TransactionTracker();
  transactionLogManager = new TransactionLogManager(transactionTracker);

  transactionTracker.initialize();
  addTransactionTrackingStyles();

  console.log("Transaction tracking and log management system initialized");
});

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    TransactionTracker,
    TransactionLogManager,
    transactionTracker,
    transactionLogManager,
  };
}

window.renderEnhancedLogs = function () {
  if (transactionLogManager) {
    transactionLogManager.renderEnhancedLogs();
  }
};

window.updatePaymentLogs = function (roomNumber) {
  if (transactionLogManager) {
    transactionLogManager.updatePaymentLogs(roomNumber);
  }
};

// ========== UNIFIED TRANSACTION FILTER MANAGER ==========
class TransactionFilterManager {
  constructor() {
    this.currentFilter = "all";
    this.initializeFilters();
  }

  initializeFilters() {
    const filterButtons = document.querySelectorAll(".transaction-filter-btn");
    filterButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        this.setFilter(btn.dataset.filter);
      });
    });
    console.log("Transaction filter manager initialized");
  }

  setFilter(filterType) {
    this.currentFilter = filterType;
    document
      .querySelectorAll(".transaction-filter-btn")
      .forEach((btn) => btn.classList.remove("active"));
    const activeBtn = document.querySelector(
      `[data-filter="${filterType}"].transaction-filter-btn`
    );
    if (activeBtn) activeBtn.classList.add("active");
    this.filterAndDisplayLogs();
  }

  isSameDayAsCheckin(logDate, checkinTime) {
    try {
      if (!checkinTime) return false;
      const checkinDate = new Date(checkinTime).toISOString().split("T")[0];
      return checkinDate === logDate;
    } catch (error) {
      return false;
    }
  }

  categorizeTransaction(log, logType) {
    // Fresh: Fresh check-ins (serial number or is_fresh_checkin flag)
    if (log.is_fresh_checkin || log.serial_number) {
      return "fresh";
    }

    // Service: Has item (water, bed, etc)
    if (log.item || log.transaction_type === "service") {
      return "service";
    }

    // Expense: Refunds and expenses
    if (logType === "refunds" || logType === "expenses") {
      return "expense";
    }

    // Continue: All other payments (cash, online, add_ons after initial check-in)
    if (logType === "cash" || logType === "online" || logType === "add_ons") {
      return "continue";
    }

    return "all";
  }

  getAllCategorizedTransactions() {
    const today = new Date().toISOString().split("T")[0];
    const todayLogs = { fresh: [], continue: [], service: [], expense: [] };

    (logs.cash || [])
      .filter((log) => log.date === today)
      .forEach((log) => {
        const category = this.categorizeTransaction(log, "cash");
        log.logType = "cash";
        if (todayLogs[category]) todayLogs[category].push(log);
      });

    (logs.online || [])
      .filter((log) => log.date === today)
      .forEach((log) => {
        const category = this.categorizeTransaction(log, "online");
        log.logType = "online";
        if (todayLogs[category]) todayLogs[category].push(log);
      });

    (logs.refunds || [])
      .filter((log) => log.date === today)
      .forEach((log) => {
        const category = this.categorizeTransaction(log, "refunds");
        log.logType = "refunds";
        if (todayLogs[category]) todayLogs[category].push(log);
      });

    (logs.add_ons || [])
      .filter((log) => log.date === today)
      .forEach((log) => {
        const category = this.categorizeTransaction(log, "add_ons");
        log.logType = "add_ons";
        if (todayLogs[category]) todayLogs[category].push(log);
      });

    (logs.expenses || [])
      .filter((log) => log.date === today && log.expense_type === "transaction")
      .forEach((log) => {
        const category = this.categorizeTransaction(log, "expenses");
        log.logType = "expenses";
        if (todayLogs[category]) todayLogs[category].push(log);
      });

    return todayLogs;
  }

  filterAndDisplayLogs() {
    const transactionLog = document.getElementById("transaction-log");
    if (!transactionLog) return;

    const categorizedLogs = this.getAllCategorizedTransactions();
    this.updateFilterCounts(categorizedLogs);

    // If "all" filter is selected, use the enhanced rendering
    if (this.currentFilter === "all") {
      if (transactionLogManager) {
        transactionLogManager.renderEnhancedLogs();
      }
      return;
    }

    // For filtered views, get the specific category
    let filteredLogs = categorizedLogs[this.currentFilter] || [];

    // Sort by time (most recent first)
    filteredLogs.sort((a, b) => {
      const timeA = a.time || "00:00:00";
      const timeB = b.time || "00:00:00";
      const getSeconds = (timeStr) => {
        const [hours, minutes, seconds = 0] = timeStr.split(":").map(Number);
        return hours * 3600 + minutes * 60 + seconds;
      };
      return getSeconds(timeB) - getSeconds(timeA);
    });

    // Render filtered logs using the same enhanced rendering
    let logsHtml = "";

    if (filteredLogs.length === 0) {
      logsHtml = `<div class="empty-state" style="padding: 2rem; text-align: center;"><i class="fas fa-inbox fa-3x" style="opacity: 0.5; margin-bottom: 1rem;"></i><p>No transactions in this category today</p></div>`;
    } else {
      logsHtml = filteredLogs
        .map((log) =>
          transactionLogManager.renderEnhancedLogItem(log, log.logType)
        )
        .join("");
    }

    transactionLog.innerHTML = logsHtml;
  }

  updateFilterCounts(categorizedLogs) {
    const totalAll =
      (categorizedLogs.fresh || []).length +
      (categorizedLogs.continue || []).length +
      (categorizedLogs.service || []).length +
      (categorizedLogs.expense || []).length;

    const counts = {
      all: totalAll,
      fresh: (categorizedLogs.fresh || []).length,
      continue: (categorizedLogs.continue || []).length,
      service: (categorizedLogs.service || []).length,
      expense: (categorizedLogs.expense || []).length,
    };

    Object.keys(counts).forEach((filter) => {
      const countElement = document.getElementById(`count-${filter}`);
      if (countElement) countElement.textContent = counts[filter];
    });
  }
}

let transactionFilterManagerInstance;

document.addEventListener("DOMContentLoaded", function () {
  setTimeout(() => {
    transactionFilterManagerInstance = new TransactionFilterManager();
    console.log("Transaction filters ready");
  }, 1000);
});

const originalRenderEnhancedLogs = window.renderEnhancedLogs;

window.renderEnhancedLogs = function () {
  if (typeof originalRenderEnhancedLogs === "function") {
    originalRenderEnhancedLogs.apply(this, arguments);
  }

  if (
    transactionFilterManagerInstance &&
    transactionFilterManagerInstance.currentFilter === "all"
  ) {
    const categorizedLogs =
      transactionFilterManagerInstance.getAllCategorizedTransactions();
    transactionFilterManagerInstance.updateFilterCounts(categorizedLogs);
  }
};
