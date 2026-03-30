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

  renderEnhancedLogs(fromDate, toDate, typeFilter, logsOverride) {
    const transactionLog = document.getElementById("transaction-log");
    if (!transactionLog) {
      console.log("Transaction log element not found");
      return;
    }

    // Default: last 3 days if no range supplied
    const todayStr = new Date().toISOString().split("T")[0];
    if (!fromDate || !toDate) {
      toDate = todayStr;
      const d = new Date();
      d.setDate(d.getDate() - 2);
      fromDate = d.toISOString().split("T")[0];
    }
    typeFilter = typeFilter || "all";

    // Use override logs (from server fetch) or fall back to the cached global
    const src = logsOverride || logs;
    const inRange = (date) => date >= fromDate && date <= toDate;

    const recentCashLogs    = (src.cash    || []).filter((log) => inRange(log.date));
    const recentOnlineLogs  = (src.online  || []).filter((log) => inRange(log.date));
    const recentRefundLogs  = (src.refunds || []).filter((log) => inRange(log.date));
    // For cached global logs, filter to transaction-type expenses only.
    // For server-fetched logsOverride, expenses are already pre-filtered by the backend.
    const recentExpenseLogs = (src.expenses || []).filter(
      (log) => inRange(log.date) && (logsOverride || log.expense_type === "transaction")
    );

    // Always compute analytics from the full unfiltered set for the date range
    this._updateAnalyticsCards(recentCashLogs, recentOnlineLogs, recentRefundLogs, recentExpenseLogs);

    // Apply type filter for the list only
    let cashForList    = typeFilter === "all" || typeFilter === "cash"     ? recentCashLogs    : [];
    let onlineForList  = typeFilter === "all" || typeFilter === "online"   ? recentOnlineLogs  : [];
    let refundForList  = typeFilter === "all" || typeFilter === "refunds"  ? recentRefundLogs  : [];
    let expenseForList = typeFilter === "all" || typeFilter === "expenses" ? recentExpenseLogs : [];

    const allRecentLogs = [
      ...cashForList.map((log) => ({ ...log, logType: "cash" })),
      ...onlineForList.map((log) => ({ ...log, logType: "online" })),
      ...refundForList.map((log) => ({ ...log, logType: "refunds" })),
      ...expenseForList.map((log) => ({ ...log, logType: "expenses" })),
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

    // Legacy totals DOM elements (kept for backward compat with other code that may read them)
    const cashTotalEl = document.getElementById("cash-total");
    const onlineTotalEl = document.getElementById("online-total");
    if (cashTotalEl) cashTotalEl.textContent = "₹" + totals.cash;
    if (onlineTotalEl) onlineTotalEl.textContent = "₹" + totals.online;

    if (allRecentLogs.length === 0) {
      transactionLog.innerHTML = `<div class="empty-state" style="padding: 2rem; text-align:center;">
        <i class="fas fa-receipt fa-3x" style="opacity:0.4;margin-bottom:1rem;display:block;"></i>
        <p>No transactions in this period</p>
      </div>`;
      return;
    }

    const logsByDate = {};
    allRecentLogs.forEach((log) => {
      if (!logsByDate[log.date]) logsByDate[log.date] = [];
      logsByDate[log.date].push(log);
    });

    let logsHTML = "";

    const _today = new Date().toISOString().split("T")[0];
    const _yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().split("T")[0]; })();

    function formatDate(dateStr) {
      const date = new Date(dateStr + "T00:00:00");
      const options = { weekday: "long", month: "short", day: "numeric" };
      return date.toLocaleDateString("en-IN", options);
    }

    Object.keys(logsByDate)
      .sort((a, b) => new Date(b) - new Date(a))
      .forEach((date) => {
        let dateDisplay = formatDate(date);
        if (date === _today) dateDisplay = "Today — " + dateDisplay;
        else if (date === _yesterday) dateDisplay = "Yesterday — " + dateDisplay;

        const dayTotal = logsByDate[date].reduce((sum, l) => {
          if (l.logType === "refunds" || l.logType === "expenses") return sum;
          return sum + (l.amount || 0);
        }, 0);

        logsHTML += `<div class="log-date-header">${dateDisplay}<span class="log-date-total">₹${dayTotal.toLocaleString("en-IN")}</span></div>`;

        logsByDate[date].forEach((log) => {
          logsHTML += this.renderEnhancedLogItem(log, log.logType);
        });
      });

    transactionLog.innerHTML = logsHTML;
  }

  _updateAnalyticsCards(cashLogs, onlineLogs, refundLogs, expenseLogs) {
    const cashSum = cashLogs.reduce((s, l) => s + (l.amount || 0), 0);
    const upiSum = onlineLogs.reduce((s, l) => s + (l.amount || 0), 0);
    const refundSum = refundLogs.reduce((s, l) => s + (l.amount || 0), 0);
    const expenseSum = expenseLogs.reduce((s, l) => s + (l.amount || 0), 0);
    const totalIn = cashSum + upiSum - refundSum;

    const fmt = (n) => "₹" + n.toLocaleString("en-IN");
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

    set("txn-card-cash", fmt(cashSum));
    set("txn-card-upi", fmt(upiSum));
    set("txn-card-total", fmt(totalIn));
    set("txn-card-expense", fmt(expenseSum));
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

// ─── Filter state ────────────────────────────────────────────────────────────
let txnActiveDateRange = { fromDate: null, toDate: null };
let txnActiveType    = "all";   // "all" | "cash" | "online" | "refunds" | "expenses"
let txnDateUnlocked  = false;   // true after manager password verified
let txnExtendedLogs  = null;    // cached logs from /get_transactions_range for current range

function _getDateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split("T")[0];
}

// Is fromDate within the last 3 days already cached by /get_data?
function _isWithinCache(fromDate) {
  const cutoff = _getDateOffset(3); // 3 days ago
  return fromDate >= cutoff;
}

// Render using either cached logs or extended logs fetched from server.
// logsObj is passed as the 4th arg so renderEnhancedLogs uses it directly
// instead of reading the `let logs` global (window.logs swap doesn't work with let).
function _renderWithLogs(fromDate, toDate, logsObj) {
  if (transactionLogManager) {
    transactionLogManager.renderEnhancedLogs(fromDate, toDate, txnActiveType, logsObj || null);
  }
}

async function _triggerRender(fromDate, toDate) {
  txnActiveDateRange = { fromDate, toDate };
  txnExtendedLogs    = null;

  // If range is within the 3-day cache, use it directly — no extra network call
  if (_isWithinCache(fromDate)) {
    _renderWithLogs(fromDate, toDate, null);
    return;
  }

  // Extended range — fetch from server
  const logEl = document.getElementById("transaction-log");
  if (logEl) logEl.innerHTML = `<div class="loading-indicator"><span class="loader"></span><p>Loading transactions…</p></div>`;

  try {
    const res  = await apiFetch("/get_transactions_range", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ from_date: fromDate, to_date: toDate }),
    });
    const data = await res.json();
    if (data.success && data.logs) {
      txnExtendedLogs = data.logs;
      _renderWithLogs(fromDate, toDate, txnExtendedLogs);
    } else {
      if (logEl) logEl.innerHTML = `<div class="empty-state" style="padding:2rem;text-align:center;"><i class="fas fa-exclamation-triangle fa-2x" style="color:var(--warning);margin-bottom:0.75rem;display:block;"></i><p>${data.message || "Failed to load data."}</p></div>`;
    }
  } catch (e) {
    if (logEl) logEl.innerHTML = `<div class="empty-state" style="padding:2rem;text-align:center;"><p style="color:var(--danger);">Network error: ${e.message}</p></div>`;
  }
}

// ── Date picker lock / unlock ─────────────────────────────────────────────────
function _setDatePickerUnlocked() {
  txnDateUnlocked = true;
  const rangeEl  = document.getElementById("txn-date-range");
  const icon     = document.getElementById("txn-date-lock-icon");
  const lockBtn  = document.getElementById("txn-relock-btn");

  if (rangeEl) { rangeEl.classList.remove("txn-date-locked"); rangeEl.placeholder = "Pick date range"; }
  const altInput = window._txnPicker && window._txnPicker.altInput;
  if (altInput)  { altInput.classList.remove("txn-date-locked"); altInput.placeholder = "Pick date range"; altInput.style.cursor = "pointer"; }
  if (icon)      icon.innerHTML = '<i class="fas fa-lock-open" style="color:var(--success);font-size:0.75rem;"></i>';
  if (lockBtn)   lockBtn.style.display = "flex"; // show re-lock button
}

function _relockDatePicker() {
  txnDateUnlocked = false;
  txnExtendedLogs = null;
  const rangeEl  = document.getElementById("txn-date-range");
  const icon     = document.getElementById("txn-date-lock-icon");
  const lockBtn  = document.getElementById("txn-relock-btn");

  if (rangeEl) { rangeEl.classList.add("txn-date-locked"); rangeEl.placeholder = "🔒 Custom range"; }
  const altInput = window._txnPicker && window._txnPicker.altInput;
  if (altInput)  { altInput.classList.add("txn-date-locked"); altInput.placeholder = "🔒 Custom range"; }
  if (icon)      icon.innerHTML = '<i class="fas fa-lock" style="font-size:0.75rem;"></i>';
  if (lockBtn)   lockBtn.style.display = "none";

  // Snap back to last 3 days
  const today = new Date().toISOString().split("T")[0];
  const from  = _getDateOffset(2);
  if (window._txnPicker) window._txnPicker.setDate([from, today]);
  document.querySelectorAll(".txn-quick-btn").forEach((b) => b.classList.remove("active"));
  const last3Btn = document.querySelector('.txn-quick-btn[data-range="3"]');
  if (last3Btn) last3Btn.classList.add("active");
  _triggerRender(from, today);
}

function _openTxnPasswordModal() {
  const modal = document.getElementById("txn-date-pwd-modal");
  const input = document.getElementById("txn-pwd-input");
  const err   = document.getElementById("txn-pwd-error");
  if (modal) modal.classList.add("show");
  if (err)   { err.style.display = "none"; err.textContent = ""; }
  if (input) { input.value = ""; setTimeout(() => input.focus(), 120); }
}

function _closeTxnPasswordModal() {
  const modal = document.getElementById("txn-date-pwd-modal");
  if (modal) modal.classList.remove("show");
}

async function _submitTxnPassword() {
  const input  = document.getElementById("txn-pwd-input");
  const err    = document.getElementById("txn-pwd-error");
  const btn    = document.getElementById("txn-pwd-submit-btn");
  const pass   = input ? input.value.trim() : "";

  if (!pass) {
    if (err) { err.textContent = "Please enter the password."; err.style.display = "block"; }
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = "Verifying…"; }
  if (err) err.style.display = "none";

  try {
    const res = await apiFetch("/verify_manager_password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pass }),
    });

    if (res.status === 403) {
      if (err) { err.textContent = "Incorrect password. Try again."; err.style.display = "block"; }
      if (input) { input.value = ""; input.focus(); }
      return;
    }

    const data = await res.json();
    if (!data.success) {
      if (err) { err.textContent = data.message || "Incorrect password."; err.style.display = "block"; }
      return;
    }

    // Password correct — unlock the date picker
    _closeTxnPasswordModal();
    _setDatePickerUnlocked();
    // Open flatpickr immediately after unlock
    if (window._txnPicker) window._txnPicker.open();

  } catch (e) {
    if (err) { err.textContent = "Network error. Please try again."; err.style.display = "block"; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Unlock"; }
  }
}

function initTxnDateFilter() {
  const todayStr    = new Date().toISOString().split("T")[0];
  const defaultFrom = todayStr; // today only

  // ── flatpickr — initialised but won't open until unlocked ─────────────────
  const rangeEl = document.getElementById("txn-date-range");
  if (rangeEl && window.flatpickr) {
    window._txnPicker = flatpickr(rangeEl, {
      mode: "range",
      dateFormat: "Y-m-d",
      altInput: true,
      altFormat: "d M Y",
      defaultDate: [todayStr, todayStr],
      maxDate: todayStr,
      disableMobile: true,
      onReady: function (_d, _s, fp) {
        // Keep the flatpickr-generated altInput also locked initially
        if (fp.altInput) {
          fp.altInput.readOnly = true;
          fp.altInput.style.cursor = "pointer";
        }
      },
      onChange: function (selectedDates) {
        // Guard: only act on manual selections after unlock
        if (!txnDateUnlocked) return;
        if (selectedDates.length === 2) {
          const from = selectedDates[0].toISOString().split("T")[0];
          const to   = selectedDates[1].toISOString().split("T")[0];
          document.querySelectorAll(".txn-quick-btn").forEach((b) => b.classList.remove("active"));
          _triggerRender(from, to);
        }
      }
    });

    // Intercept clicks on the altInput — show password modal if locked
    setTimeout(() => {
      const altInput = rangeEl._flatpickr && rangeEl._flatpickr.altInput;
      const clickTarget = altInput || rangeEl;
      const lockWrap = document.getElementById("txn-date-lock-wrap");

      function handlePickerClick(e) {
        if (!txnDateUnlocked) {
          e.preventDefault();
          e.stopPropagation();
          if (window._txnPicker) window._txnPicker.close();
          _openTxnPasswordModal();
        }
      }

      clickTarget.addEventListener("click", handlePickerClick, true);
      if (lockWrap) {
        lockWrap.addEventListener("click", function(e) {
          if (!txnDateUnlocked) handlePickerClick(e);
        });
      }
    }, 300);
  }

  // ── Quick buttons ─────────────────────────────────────────────────────────
  document.querySelectorAll(".txn-quick-btn").forEach((btn) => {
    btn.addEventListener("click", function () {
      document.querySelectorAll(".txn-quick-btn").forEach((b) => b.classList.remove("active"));
      this.classList.add("active");

      const range = this.dataset.range;
      const today = new Date().toISOString().split("T")[0];
      const from  = range === "today" ? today : _getDateOffset(parseInt(range, 10) - 1);
      if (window._txnPicker) window._txnPicker.setDate([from, today]);
      _triggerRender(from, today);
    });
  });

  // ── Type filter buttons ───────────────────────────────────────────────────
  document.querySelectorAll(".txn-type-btn").forEach((btn) => {
    btn.addEventListener("click", function () {
      document.querySelectorAll(".txn-type-btn").forEach((b) => b.classList.remove("active"));
      this.classList.add("active");
      txnActiveType = this.dataset.type;
      const { fromDate, toDate } = txnActiveDateRange;
      _triggerRender(fromDate, toDate);
    });
  });

  // ── Re-lock button ────────────────────────────────────────────────────────
  const relockBtn = document.getElementById("txn-relock-btn");
  if (relockBtn) relockBtn.addEventListener("click", _relockDatePicker);

  // ── Password modal events ─────────────────────────────────────────────────
  const closeBtn  = document.getElementById("txn-pwd-close-btn");
  const submitBtn = document.getElementById("txn-pwd-submit-btn");
  const pwdInput  = document.getElementById("txn-pwd-input");

  if (closeBtn)  closeBtn.addEventListener("click", _closeTxnPasswordModal);
  if (submitBtn) submitBtn.addEventListener("click", _submitTxnPassword);
  if (pwdInput)  pwdInput.addEventListener("keydown", (e) => { if (e.key === "Enter") _submitTxnPassword(); });

  // Close modal on backdrop click
  const pwdModal = document.getElementById("txn-date-pwd-modal");
  if (pwdModal) {
    pwdModal.addEventListener("click", function(e) {
      if (e.target === pwdModal) _closeTxnPasswordModal();
    });
  }

  // ── Initial render ────────────────────────────────────────────────────────
  _triggerRender(defaultFrom, todayStr);
}

// window.renderEnhancedLogs is called externally after a data refresh.
// If an extended range is active, re-use the cached server result (txnExtendedLogs).
// Otherwise fall through to the cached 3-day global logs.
window.renderEnhancedLogs = function () {
  const { fromDate, toDate } = txnActiveDateRange;
  _renderWithLogs(fromDate || null, toDate || null, txnExtendedLogs || null);
};

document.addEventListener("DOMContentLoaded", function () {
  setTimeout(() => {
    initTxnDateFilter();
    console.log("Transaction date filter ready");
  }, 1000);
});
