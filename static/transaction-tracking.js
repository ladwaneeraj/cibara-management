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
        JSON.stringify(this.dailyCounters),
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

  /**
   * Called when a check-in date changes (e.g. staff edits the check-in time to a different day).
   * Releases the serial slot on the old date and assigns a new serial on the new date.
   * Returns the new serial number (or null if new date is not today).
   */
  reassignCheckinDate(roomNumber, oldDate, newDate) {
    if (oldDate === newDate) return null; // same day — nothing to do

    // 1. Remove old serial entry
    const oldKey = `${oldDate}_${roomNumber}`;
    localStorage.removeItem(`serial_${oldKey}`);

    // 2. Decrement old date counter (floor at 0 to avoid negatives)
    if (this.dailyCounters[oldDate] && this.dailyCounters[oldDate] > 0) {
      this.dailyCounters[oldDate] = Math.max(0, this.dailyCounters[oldDate] - 1);
      this.saveDailyCounters();
    }

    // 3. Assign a new serial for the new date (only if it is today)
    const todayStr = new Date().toISOString().split("T")[0];
    if (newDate === todayStr) {
      if (!this.dailyCounters[newDate]) {
        this.dailyCounters[newDate] = 0;
      }
      this.dailyCounters[newDate] += 1;
      this.saveDailyCounters();
      const newSerial = this.dailyCounters[newDate];
      this.storeSerialNumber(newDate, roomNumber, newSerial);
      console.log(`Reassigned room ${roomNumber}: serial released from ${oldDate}, new serial #${newSerial} on ${newDate}`);
      return newSerial;
    }

    return null;
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
        `Assigned serial number ${serialNumber} to room ${roomNumber} for ${date} (${checkinType})`,
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

    const recentCashLogs = (src.cash || []).filter((log) => inRange(log.date));
    const recentOnlineLogs = (src.online || []).filter((log) =>
      inRange(log.date),
    );
    const recentRefundLogs = (src.refunds || []).filter((log) =>
      inRange(log.date),
    );
    // For cached global logs, filter to transaction-type expenses only.
    // For server-fetched logsOverride, expenses are already pre-filtered by the backend.
    // Expense scope (admin Daily/Report toggle). Daily = drawer expenses
    // (expense_type "transaction" or legacy rows with none); Report =
    // expense_type "report"; All = both. The backend now sends every
    // expense, so this client-side filter is the single source of truth
    // for which ones the Transactions tab shows.
    const _expScope =
      typeof txnExpenseScope === "string" ? txnExpenseScope : "daily";
    const recentExpenseLogs = (src.expenses || []).filter((log) => {
      if (!inRange(log.date)) return false;
      const isReport = log.expense_type === "report";
      if (_expScope === "report") return isReport;
      if (_expScope === "all") return true;
      return !isReport; // "daily"
    });
    // Settle-later checkouts (guest left with the balance deferred).
    const recentSettlementLogs = (src.settlements || []).filter((log) =>
      inRange(log.date),
    );

    // Always compute analytics from the full unfiltered set for the date range
    this._updateAnalyticsCards(
      recentCashLogs,
      recentOnlineLogs,
      recentRefundLogs,
      recentExpenseLogs,
    );

    // Apply type filter for the list only
    let cashForList =
      typeFilter === "all" || typeFilter === "cash" ? recentCashLogs : [];
    let onlineForList =
      typeFilter === "all" || typeFilter === "online" ? recentOnlineLogs : [];
    let refundForList =
      typeFilter === "all" || typeFilter === "refunds" ? recentRefundLogs : [];
    let expenseForList =
      typeFilter === "all" || typeFilter === "expenses"
        ? recentExpenseLogs
        : [];
    let settlementForList =
      typeFilter === "all" || typeFilter === "settlements"
        ? recentSettlementLogs
        : [];

    const allRecentLogs = [
      ...cashForList.map((log) => ({ ...log, logType: "cash" })),
      ...onlineForList.map((log) => ({ ...log, logType: "online" })),
      ...refundForList.map((log) => ({ ...log, logType: "refunds" })),
      ...expenseForList.map((log) => ({ ...log, logType: "expenses" })),
      ...settlementForList.map((log) => ({ ...log, logType: "settlement" })),
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
    const _yesterday = (() => {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      return d.toISOString().split("T")[0];
    })();

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
        else if (date === _yesterday)
          dateDisplay = "Yesterday — " + dateDisplay;

        const dayTotal = logsByDate[date].reduce((sum, l) => {
          if (
            l.logType === "refunds" ||
            l.logType === "expenses" ||
            l.logType === "settlement"
          ) {
            return sum;
          }
          return sum + (l.amount || 0);
        }, 0);

        logsHTML += `<div class="log-date-header">${dateDisplay}<span class="log-date-total">₹${dayTotal.toLocaleString("en-IN")}</span></div>`;

        // Per-day serial numbers, derived fresh from the data on every
        // render: serial-eligible rows are numbered 1..N by ascending
        // time, so #1 is the day's first check-in. Numbering is scoped
        // to each date group, so switching the date filter — or editing
        // another day — never shifts a given day's run.
        const _serialOf = new Map();
        logsByDate[date]
          .filter((l) => this._isSerialEligible(l))
          .slice()
          .sort((a, b) =>
            String(a.time || "").localeCompare(String(b.time || "")),
          )
          .forEach((l, i) => _serialOf.set(l, i + 1));

        logsByDate[date].forEach((log) => {
          logsHTML += this.renderEnhancedLogItem(
            log,
            log.logType,
            _serialOf.get(log) || 0,
          );
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
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    set("txn-card-cash", fmt(cashSum));
    set("txn-card-upi", fmt(upiSum));
    set("txn-card-total", fmt(totalIn));
    set("txn-card-expense", fmt(expenseSum));
  }

  renderEnhancedLogItem(log, logType, serialOverride) {
    const tags = this.getTransactionTags(log, logType);
    // The main dated list passes an explicit serial — a number, or 0 for
    // rows that get none — so its numbering is fully derived per day.
    // Other callers omit it and fall back to the stored value.
    const serialNumber =
      serialOverride !== undefined
        ? serialOverride || null
        : this.getLogSerialNumber(log);

    let type = "Unknown";
    let color = "";
    let additionalInfo = "";

    if (logType === "refunds") {
      type = "";  // REFUND badge already shows it — no duplicate text
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
        type = "";  // PAY LATER badge already shows it — no duplicate text
        color = 'style="color: var(--warning)"';
      } else {
        type = "";
      }
    } else if (logType === "online") {
      type = "";
    } else if (logType === "settlement") {
      // OTA bank settlements (MMT payout) vs hotel-side settle-later.
      if (log.type === "bank_settlement" || log.platform === "mmt") {
        type = log.label || "MMT Settlement";
        color = 'style="color: var(--success)"';
        additionalInfo = log.utr ? ` (UTR ${log.utr})` : "";
      } else {
        type = "";  // SETTLE LATER badge already conveys it
      }
    }

    let tagsHtml = "";
    if (tags.length > 0) {
      tagsHtml = tags
        .map(
          (tag) =>
            `<span class="${tag.class}" style="background-color: ${tag.color}">${tag.text}</span>`,
        )
        .join(" ");
    }

    // Cash / Online payment-mode pill. Shown on every row where real
    // money moved so the mode is visible at a glance. For cash/online
    // payments the logType is authoritative; refund and expense rows
    // fall back to the row's own method field. Pay-later rows move no
    // money, so they get no pill (the PAY LATER tag already says so).
    let modeHtml = "";
    const _isPayLaterRow =
      log.payment_method === "pay_later" ||
      (log.amount === 0 && log.is_fresh_checkin);
    if (!_isPayLaterRow) {
      let _mode = "";
      if (logType === "cash") {
        _mode = "cash";
      } else if (logType === "online") {
        _mode = "online";
      } else {
        const _m = String(log.method || log.payment_method || "").toLowerCase();
        if (_m === "cash") _mode = "cash";
        else if (_m === "online" || _m === "upi" || _m === "card") _mode = "online";
      }
      if (_mode === "cash") {
        modeHtml = `<span class="transaction-tag cash-tag">Cash</span>`;
      } else if (_mode === "online") {
        modeHtml = `<span class="transaction-tag online-tag">Online</span>`;
      }
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
    } else if (logType === "settlement") {
      // Stored as a negative offsetting entry; show the plain amount
      // the guest still owes — the SETTLE LATER tag conveys the rest.
      amountDisplay = `₹${Math.abs(log.amount || 0)}`;
      color = "style=\"color: #0369a1\"";
    }

    let titleContent = "";
    if (logType === "expenses") {
      // description is the user-entered text; for payments-collection entries it
      // gets stored in the `name` field, so fall back to that.
      const expenseLabel = log.description || log.name || "Expense";
      const catDisplay = (log.category || "others")
        .charAt(0).toUpperCase() +
        (log.category || "others").slice(1).replace(/_/g, " ");

      // Photo icon or attach button. Categories that never carry an
      // invoice photo (mirrors NO_PHOTO_CATEGORIES in expense.js — keep
      // the two lists in sync) get NO "Photo" attach button here. An
      // already-attached photo is still shown, in case category data
      // changed after the fact.
      const NO_PHOTO_CATS = ["salary", "rent", "petty_cash"];
      const _expCat = (log.category || "").toLowerCase();
      let photoHtml = "";
      if (log.invoice_photo_url) {
        photoHtml = `<a href="${log.invoice_photo_url}" target="_blank" rel="noopener"
          title="View Invoice"
          style="margin-left:5px;color:#3182ce;font-size:0.78rem;text-decoration:none;">
          <i class="fas fa-file-image"></i>
        </a>`;
      } else if (log._doc_id && !NO_PHOTO_CATS.includes(_expCat)) {
        photoHtml = `<button type="button"
          class="txn-attach-photo-btn"
          data-doc-id="${log._doc_id}"
          title="Attach invoice photo"
          style="margin-left:5px;background:none;border:1px solid #cbd5e0;border-radius:5px;padding:1px 6px;font-size:0.7rem;color:#718096;cursor:pointer;line-height:1.6;">
          <i class="fas fa-paperclip"></i> Photo
        </button>`;
      }

      const gstBadge = log.has_gst
        ? `<span style="font-size:0.68rem;background:#e8f5e9;color:#2e7d32;border-radius:4px;padding:1px 5px;margin-left:4px;">GST ₹${log.gst_amount || 0}</span>`
        : "";

      // Admin-only inline edit / delete buttons. Visible only when the
      // log has a _doc_id (so we can target the right Firestore doc)
      // and the current user has the expense.manage permission. Wired
      // via event delegation in the DOMContentLoaded block below.
      let adminActionsHtml = "";
      const _canManage = window.CibaraAuth
        && typeof window.CibaraAuth.userCan === "function"
        && window.CibaraAuth.userCan("expense.manage");
      if (_canManage && log._doc_id) {
        // Escape ALL HTML-significant characters in attribute values —
        // descriptions are operator-entered free text and may contain
        // any of <, >, &, ", '.
        const _attrEsc = (v) => String(v == null ? "" : v)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
        adminActionsHtml = `
          <button type="button" class="txn-exp-edit-btn"
            data-doc-id="${_attrEsc(log._doc_id)}"
            title="Edit expense"
            style="margin-left:5px;background:none;border:1px solid #cbd5e0;border-radius:5px;padding:1px 7px;font-size:0.7rem;color:#3182ce;cursor:pointer;line-height:1.6;">
            <i class="fas fa-pen"></i>
          </button>
          <button type="button" class="txn-exp-delete-btn"
            data-doc-id="${_attrEsc(log._doc_id)}"
            data-amount="${_attrEsc(log.amount || 0)}"
            data-description="${_attrEsc(log.description || '')}"
            title="Delete expense"
            style="margin-left:3px;background:none;border:1px solid #fecaca;border-radius:5px;padding:1px 7px;font-size:0.7rem;color:#c53030;cursor:pointer;line-height:1.6;">
            <i class="fas fa-trash"></i>
          </button>`;
      }

      titleContent = `<strong>${expenseLabel}</strong>
        <span style="font-size:0.7rem;background:#fed7d7;color:#c53030;border-radius:4px;padding:1px 6px;margin-left:4px;font-weight:500;">${catDisplay}</span>
        ${gstBadge}${photoHtml}${adminActionsHtml}`;
    } else {
      titleContent = `Room ${log.room} - ${log.name}`;
    }

    // "Collected by" chip — staff member who recorded this payment.
    // Resolved from log.createdBy via the user directory; hidden for
    // legacy entries that don't have the field populated yet.
    let byChip = "";
    if (log.createdBy && window.CibaraUsers) {
      const _by = window.CibaraUsers.nameOf(log.createdBy);
      const _safe = String(_by).replace(/[<&>"']/g, function (c) {
        return { "<": "&lt;", "&": "&amp;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
      byChip =
        ' <span class="txn-added-by" title="Collected by ' + _safe +
        '"><i class="fas fa-user"></i> ' + _safe + '</span>';
    }
    titleContent += byChip;

    // Background colour per payment type (keep colours light/subtle)
    let rowBg = "";
    const isPayLater = log.payment_method === "pay_later" || (log.amount === 0 && log.is_fresh_checkin);
    if (isPayLater) {
      rowBg = 'style="background-color: #fffbe6;"';                         // light yellow
    } else if (logType === "online") {
      rowBg = 'style="background-color: #e8f4fd;"';                         // light blue
    } else if (logType === "cash") {
      rowBg = 'style="background-color: #e9f7ec;"';                         // light green
    } else if (logType === "refunds" || log.transaction_type === "refund" || log.transaction_type === "checkout_refund" || logType === "expenses") {
      rowBg = 'style="background-color: #fdecea;"';                         // light red
    }

    // Build subtitle: tags first, then time
    const subtitleTime = type ? `${type}${additionalInfo} at ${log.time || "N/A"}` : `at ${log.time || "N/A"}`;

    // Mark expense rows with a stable data attribute so the admin
    // search filter in transaction-tracking can target them
    // regardless of whether the edit/delete buttons are present
    // (older docs without _doc_id, or non-admin view).
    const rowDataAttrs = (logType === "expenses") ? ' data-expense-row="1"' : "";

    return `
      <div class="log-item"${rowDataAttrs} ${rowBg}>
        <div class="log-details">
          <div class="log-title">
            ${serialHtml}
            ${titleContent}
            ${shiftInfo}
          </div>
          <div class="log-subtitle">
            ${modeHtml}${tagsHtml}${subtitleTime}
          </div>
        </div>
        <div class="log-amount" ${color}>${amountDisplay}</div>
      </div>
    `;
  }

  getTransactionTags(log, logType) {
    const tags = [];

    // Settle-later — either the checkout where the guest left with the
    // balance deferred (type "settlement"), or the later payment that
    // clears that deferred balance (type "settlement_payment"). Both
    // carry the SETTLE LATER tag; neither gets a serial number.
    if (
      log.transaction_type === "settlement" ||
      log.type === "settlement" ||
      log.transaction_type === "settlement_payment" ||
      log.type === "settlement_payment"
    ) {
      tags.push({
        text: "SETTLE LATER",
        class: "transaction-tag settle-later-tag",
        color: "#0ea5e9",
      });
      return tags;
    }

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

    // Fresh check-ins must never show CONTINUE — only continuation payments do
    const isFresh =
      log.is_fresh_checkin === true ||
      log.transaction_type === "fresh_checkin" ||
      log.transaction_type === "booking_conversion" ||
      log.is_booking_conversion === true;

    if (!isFresh) {
      let isRenewal = false;

      if (
        log.is_renewal === true ||
        log.transaction_type === "renewal_payment"
      ) {
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
    }

    return tags;
  }

  // Predicate: is this row the kind that carries a serial number?
  // Serial numbers are for fresh check-in events only — a room being
  // freshly occupied, whether a walk-in fresh check-in or a booking
  // converted to a check-in. Settle-later checkouts and settle-later
  // payments, add-ons, refunds, renewals and plain payments never get
  // a serial. Pay-later check-ins DO — they are still a check-in event.
  _isSerialEligible(log) {
    const isFreshCheckin =
      log.is_fresh_checkin ||
      log.transaction_type === "fresh_checkin" ||
      log.transaction_type === "booking_conversion" ||
      log.is_booking_conversion;

    if (!isFreshCheckin) {
      return false;
    }

    if (
      log.item ||
      log.transaction_type === "service" ||
      log.transaction_type === "refund" ||
      log.is_renewal ||
      log.transaction_type === "renewal_payment"
    ) {
      return false;
    }

    return true;
  }

  // Fallback serial lookup, for callers that do not supply a derived
  // per-day number (the preview and category-filtered views). The main
  // dated list numbers rows dynamically instead — see the render loop.
  getLogSerialNumber(log) {
    if (!this._isSerialEligible(log)) {
      return null;
    }
    if (log.serial_number) {
      return log.serial_number;
    }
    if (log.date && log.room && window.transactionTracker) {
      const stored = window.transactionTracker.getSerialNumberForDate(
        log.date,
        log.room,
      );
      if (stored) return stored;
    }
    return null;
  }

  updatePaymentLogs(roomNumber) {
    const paymentLogsContainer = document.getElementById(
      "checkout-payment-logs",
    );
    if (!paymentLogsContainer) {
      console.log("Payment logs container not found");
      return;
    }

    const roomInfo = rooms[roomNumber];
    if (!roomInfo || !roomInfo.guest) {
      paymentLogsContainer.innerHTML =
        '<div class="log-item">No payments recorded</div>';
      return;
    }

    // ── Cache hit: render instantly, no network call ──────────────────────
    const cacheKey = `${roomNumber}:${roomInfo.checkin_time || ""}`;
    const cached = _payCache[cacheKey];
    if (cached && Date.now() - cached.ts < _PAY_CACHE_TTL) {
      this._renderPaymentData(paymentLogsContainer, cached.data, roomNumber);
      return;
    }

    // Cache miss: show spinner. The fetch may already be in flight from
    // a prefetch fired right before showCheckoutModal; _startPayFetch
    // de-dupes so we share the same network round-trip instead of
    // racing it.
    paymentLogsContainer.innerHTML = `<div class="loading-indicator"><span class="loader"></span></div>`;

    _startPayFetch(roomNumber)
      .then((data) => {
        if (!data) {
          paymentLogsContainer.innerHTML =
            '<div class="log-item">No payments recorded</div>';
          return;
        }
        this._renderPaymentData(paymentLogsContainer, data, roomNumber);
      })
      .catch((err) => {
        console.error("Error loading payment history:", err);
        paymentLogsContainer.innerHTML =
          '<div class="log-item">Error loading payment history</div>';
      });
  }

  _renderPaymentData(container, data, roomNumber) {
    // The Edit-payments button lives in the Payment History header
    // (#checkout-payment-edit-slot); render it first so it shows
    // regardless of whether the log body below has any rows.
    this._renderPaymentEditButton(roomNumber);

    if (!data.success) {
      container.innerHTML =
        '<div class="log-item">Could not load payment history</div>';
      return;
    }

    const _refundTypes = new Set([
      "refund",
      "checkout_refund",
      "manual_refund",
      "booking_cancel_refund",
    ]);

    const allPayments = [
      ...(data.cash || []).map((p) => ({ ...p, _source: "cash" })),
      ...(data.online || []).map((p) => ({ ...p, _source: "online" })),
      ...(data.refunds || []).map((p) => ({ ...p, _source: "refund" })),
      ...(data.addons || []).map((p) => ({ ...p, _source: "addon" })),
      ...(data.shifts || []).map((p) => ({ ...p, _source: "shift" })),
    ].sort((a, b) => {
      const da = a.date
        ? new Date(`${a.date} ${a.time || "00:00"}`)
        : new Date(0);
      const db = b.date
        ? new Date(`${b.date} ${b.time || "00:00"}`)
        : new Date(0);
      return db - da;
    });

    if (allPayments.length === 0) {
      container.innerHTML = '<div class="log-item">No payments recorded</div>';
      return;
    }

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
        amountText = "";
      } else if (ptype === "booking_advance" || ptype === "booking_payment") {
        paymentType = `Booking Advance (${payment.method || "cash"})`;
        colorStyle = "style='color: var(--info, #17a2b8)'";
      } else if (ptype === "booking_conversion") {
        if (payment.amount === 0) {
          paymentType = "Booking — Fully Paid";
          colorStyle = "style='color: var(--warning)'";
        } else {
          paymentType = `Booking Final Payment (${payment.method || "cash"})`;
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

      // "Added by" — small chip showing who recorded the payment.
      // Resolved via the user directory; falls back to the userId, and
      // hides entirely when createdBy is missing (legacy entries).
      let byHtml = "";
      if (payment.createdBy && window.CibaraUsers) {
        const _byName = window.CibaraUsers.nameOf(payment.createdBy);
        byHtml =
          ' <span class="txn-added-by" title="Recorded by ' +
          String(_byName).replace(/"/g, "&quot;") +
          '"><i class="fas fa-user"></i> ' +
          String(_byName).replace(/[<&>]/g, function (c) {
            return { "<": "&lt;", "&": "&amp;", ">": "&gt;" }[c];
          }) +
          "</span>";
      }

      logsHtml += `
        <div class="log-item">
          <div class="log-details">
            <div class="log-title">${paymentType}${badgeHtml}${byHtml}</div>
            <div class="log-subtitle">${payment.time || "N/A"} on ${payment.date || "N/A"}</div>
          </div>
          <div class="log-amount" ${colorStyle}>${amountText}</div>
        </div>
      `;
    });

    container.innerHTML = logsHtml;
  }

  // Renders the admin-only "Edit payments" button into the Payment
  // History header slot (#checkout-payment-edit-slot in the checkout
  // modal). Reuses the Register tab's payments modal
  // (window.openRegisterPaymentsModal) so editing behaves identically
  // wherever it is launched from — same modal, same RBAC, same backend.
  // Gated on the payment.edit permission the modal itself enforces;
  // the slot is cleared for anyone without it or when there is no
  // active stay to edit.
  _renderPaymentEditButton(roomNumber) {
    // Resolve the header slot. index.html ships a
    // #checkout-payment-edit-slot span in the Payment History header;
    // if the loaded page HTML predates that span (stale cache / not yet
    // redeployed), build the slot from the heading so the button still
    // appears. Idempotent — reuses the slot/row on later renders.
    let slot = document.getElementById("checkout-payment-edit-slot");
    if (!slot) {
      const logs = document.getElementById("checkout-payment-logs");
      const wrap = logs ? logs.parentElement : null;
      const heading = wrap ? wrap.querySelector("h3") : null;
      if (wrap && heading) {
        let headerRow = wrap.querySelector(".checkout-pay-header-row");
        if (!headerRow) {
          headerRow = document.createElement("div");
          headerRow.className = "checkout-pay-header-row";
          headerRow.style.cssText =
            "display:flex;justify-content:space-between;align-items:center;gap:0.5rem;";
          heading.parentNode.insertBefore(headerRow, heading);
          headerRow.appendChild(heading);
          heading.style.margin = "0";
        }
        slot = document.createElement("span");
        slot.id = "checkout-payment-edit-slot";
        headerRow.appendChild(slot);
      }
    }
    if (!slot) return;
    const roomInfo =
      typeof rooms !== "undefined" && roomNumber != null
        ? rooms[roomNumber]
        : null;
    const stayId = roomInfo && roomInfo.active_bill_id;
    const canEdit = !!(
      window.CibaraAuth &&
      window.CibaraAuth.userCan &&
      window.CibaraAuth.userCan("payment.edit")
    );
    if (!canEdit || !stayId) {
      slot.innerHTML = "";
      return;
    }
    slot.innerHTML = `
      <button type="button" class="txn-edit-payments-btn"
        style="display:inline-flex;align-items:center;gap:5px;padding:5px 11px;
               font-size:0.75rem;font-weight:600;color:#3f51b5;background:#eef2ff;
               border:1px solid #c7d2fe;border-radius:6px;cursor:pointer;">
        <i class="fas fa-pen"></i> Edit payments
      </button>`;
    const btn = slot.querySelector(".txn-edit-payments-btn");
    if (btn) {
      btn.addEventListener("click", () => {
        if (typeof window.openRegisterPaymentsModal !== "function") {
          alert(
            "Payment editor isn't ready yet — open the Register tab once, then try again.",
          );
          return;
        }
        window.openRegisterPaymentsModal({
          id: stayId,
          stay_id: stayId,
          room: roomNumber,
          guest_name: (roomInfo.guest && roomInfo.guest.name) || "",
          checkin_time: roomInfo.checkin_time || "",
        });
      });
    }
  }
}

const transactionTrackingStyles = `
    /* "Added by" chip on each transaction row */
    .txn-added-by {
        display: inline-flex; align-items: center; gap: 3px;
        padding: 1px 7px; border-radius: 999px;
        background: #eef2ff; color: #4338ca;
        font: 600 .68rem 'Inter', system-ui, sans-serif;
        margin-left: 6px; vertical-align: middle;
    }
    .txn-added-by i { font-size: .62rem; opacity: .75; }

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

    .settle-later-tag {
        background-color: #0ea5e9;
    }

    /* Cash / Online payment-mode pills. Green = cash, blue = online —
       matches the row tint and the service-payment-badge colours. These
       reuse .transaction-tag, so they inherit the same size, shape and
       the mobile shrink rule below — a normal inline pill, never sticky. */
    .cash-tag {
        background-color: #27ae60;
    }

    .online-tag {
        background-color: #007bff;
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

  // ── Expense photo-attach from transaction tab ──────────────────────────────
  // Event delegation: catch clicks on .txn-attach-photo-btn anywhere in the log
  let _pendingAttachDocId = null;
  const txnPhotoFile = document.getElementById("txn-expense-photo-file");

  document.addEventListener("click", function (e) {
    const btn = e.target.closest(".txn-attach-photo-btn");
    if (!btn) return;
    _pendingAttachDocId = btn.getAttribute("data-doc-id");
    if (_pendingAttachDocId && txnPhotoFile) txnPhotoFile.click();
  });

  // ── Admin-only: edit / delete an existing expense ──────────────────────────
  // Both buttons live inside expense rows in the transaction log and are
  // only rendered for users with expense.manage. We rely on the permission
  // check inside renderEnhancedLogItem for visibility; the handlers below
  // are a thin safety net.
  function _findLogByDocId(docId) {
    if (!docId || typeof logs === "undefined" || !logs.expenses) return null;
    return logs.expenses.find((l) => l._doc_id === docId) || null;
  }

  document.addEventListener("click", function (e) {
    // Edit
    const editBtn = e.target.closest(".txn-exp-edit-btn");
    if (editBtn) {
      e.preventDefault();
      e.stopPropagation();
      const docId = editBtn.getAttribute("data-doc-id");
      const log = _findLogByDocId(docId);
      if (!log) {
        if (typeof showNotification === "function") {
          showNotification("Could not find expense to edit. Refresh and retry.", "error");
        }
        return;
      }
      if (typeof window.openExpenseEditModal === "function") {
        window.openExpenseEditModal(log);
      } else {
        console.warn("openExpenseEditModal not loaded yet");
      }
      return;
    }

    // Delete
    const delBtn = e.target.closest(".txn-exp-delete-btn");
    if (delBtn) {
      e.preventDefault();
      e.stopPropagation();
      const docId = delBtn.getAttribute("data-doc-id");
      const amt   = delBtn.getAttribute("data-amount") || "?";
      const desc  = delBtn.getAttribute("data-description") || "this expense";
      if (!docId) return;
      if (!confirm(`Delete "${desc}" (₹${amt})?\n\nThis cannot be undone.`)) return;

      // Defensive admin check before firing the request.
      const canManage = window.CibaraAuth
        && typeof window.CibaraAuth.userCan === "function"
        && window.CibaraAuth.userCan("expense.manage");
      if (!canManage) {
        if (typeof showNotification === "function") {
          showNotification("Only admins can delete expenses", "error");
        }
        return;
      }

      delBtn.disabled = true;
      apiFetch("/expense/" + encodeURIComponent(docId), { method: "DELETE" })
        .then((r) => r.json())
        .then((data) => {
          if (data && data.success) {
            if (typeof showNotification === "function") {
              showNotification("Expense deleted", "success");
            }
            if (typeof debouncedFetchData === "function") debouncedFetchData();
          } else {
            if (typeof showNotification === "function") {
              showNotification((data && data.message) || "Delete failed", "error");
            }
            delBtn.disabled = false;
          }
        })
        .catch((err) => {
          console.error("delete expense error:", err);
          if (typeof showNotification === "function") {
            showNotification("Error: " + err.message, "error");
          }
          delBtn.disabled = false;
        });
    }
  });

  // ── Admin-only: live search across rendered expense rows ───────────────────
  // The search input is created lazily so that this file doesn't need to
  // know the exact DOM order in templates/index.html. It sits just above
  // the transaction log and filters expense rows by description, category,
  // paid_to, vendor_name and invoice_number — case-insensitive substring.
  // Non-expense rows are untouched.
  // True iff the user is currently looking at the Expense filter on the
  // Transaction tab. The search bar only makes sense in this view —
  // outside it the bar is hidden, the query is cleared and any hidden
  // rows are reset to visible.
  function _isExpenseFilterActive() {
    // txnActiveType is declared at module top level (let). When this
    // file hasn't initialised yet (race during boot) we default to false
    // so the bar stays hidden rather than appearing in the wrong view.
    try {
      return typeof txnActiveType !== "undefined" && txnActiveType === "expenses";
    } catch (_) {
      return false;
    }
  }

  function _ensureExpenseSearchEl() {
    const isAdmin = window.CibaraAuth
      && typeof window.CibaraAuth.userCan === "function"
      && window.CibaraAuth.userCan("expense.manage");
    const wantVisible = isAdmin && _isExpenseFilterActive();

    let el = document.getElementById("txn-expense-search-wrap");

    // Hide / reset path — element exists but we don't want it shown
    // (filter switched away, or user is non-admin).
    if (el && !wantVisible) {
      el.style.display = "none";
      // Clear any active query so rows aren't left hidden when admin
      // switches back to "All" / "Cash" / etc.
      const input = el.querySelector("#txn-expense-search");
      if (input && input.value) {
        input.value = "";
        // Force a reset of any row visibility we previously toggled.
        document.querySelectorAll('#transaction-log .log-item').forEach((r) => {
          r.style.display = "";
        });
      }
      return null;
    }

    if (!wantVisible) return null;
    if (el) { el.style.display = "flex"; return el; }

    const log = document.getElementById("transaction-log");
    if (!log || !log.parentNode) return null;

    el = document.createElement("div");
    el.id = "txn-expense-search-wrap";
    el.style.cssText =
      "display:flex;align-items:center;gap:0.4rem;margin:0 0 0.55rem;";
    el.innerHTML = `
      <div style="position:relative;flex:1;">
        <i class="fas fa-search"
           style="position:absolute;left:0.55rem;top:50%;transform:translateY(-50%);color:#94a3b8;font-size:0.78rem;"></i>
        <input type="text" id="txn-expense-search"
          placeholder="Search expenses (description, vendor, paid to, invoice no.)…"
          style="width:100%;padding:0.42rem 0.6rem 0.42rem 1.8rem;font-size:0.85rem;
                 border:1.5px solid #e2e8f0;border-radius:8px;outline:none;
                 transition:border-color .15s;" />
      </div>
      <button type="button" id="txn-expense-search-clear"
        style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;
               padding:0.4rem 0.65rem;cursor:pointer;font-size:0.75rem;color:#475569;
               display:none;">
        Clear
      </button>
      <span id="txn-expense-search-count"
        style="font-size:0.72rem;color:#718096;min-width:60px;text-align:right;"></span>
    `;
    log.parentNode.insertBefore(el, log);
    return el;
  }

  function _applyExpenseSearch() {
    const input = document.getElementById("txn-expense-search");
    const clearBtn = document.getElementById("txn-expense-search-clear");
    const countEl  = document.getElementById("txn-expense-search-count");
    if (!input) return;

    const q = (input.value || "").trim().toLowerCase();
    if (clearBtn) clearBtn.style.display = q ? "inline-block" : "none";

    // Only act on rows that look like expense rows. We identify them by
    // the presence of an edit OR delete button OR by the category badge
    // — the rendering inserts the .txn-exp-edit-btn or .txn-exp-delete-btn
    // only for admins. To stay robust for the non-admin case too, we
    // fall back to looking for an expense-only background ("#fdecea" is
    // shared with refunds — so we additionally check for the strong tag
    // pattern which expenses always have).
    const rows = document.querySelectorAll("#transaction-log .log-item");
    let visible = 0;
    let totalExpenseRows = 0;

    rows.forEach((row) => {
      const hasExpBtn = row.querySelector(".txn-exp-edit-btn, .txn-exp-delete-btn, .txn-attach-photo-btn");
      // Identify expense rows: either admin edit/delete buttons present,
      // OR a "Photo" attach button (only rendered on expenses), OR the
      // category badge red pill style used solely for expenses.
      const isExpense = !!hasExpBtn || row.dataset.expenseRow === "1";
      if (!isExpense) return; // non-expense rows untouched

      totalExpenseRows++;

      if (!q) {
        row.style.display = "";
        visible++;
        return;
      }

      const haystack = (row.textContent || "").toLowerCase();
      const match = haystack.indexOf(q) !== -1;
      row.style.display = match ? "" : "none";
      if (match) visible++;
    });

    if (countEl) {
      countEl.textContent = q
        ? `${visible}/${totalExpenseRows} match`
        : "";
    }
  }

  // The transaction log is repopulated by several different code paths
  // (renderEnhancedLogs, filterAndDisplayLogs, _renderWithLogs, etc.).
  // Rather than try to patch each entry point, watch the container for
  // childList mutations and re-create the search bar + re-apply the
  // active filter whenever the log redraws. This is O(redraws) and the
  // observer never runs during the same redraw twice (guarded by a
  // re-entrancy flag).
  let _reapplyInFlight = false;
  function _ensureSearchBarAndReapply() {
    if (_reapplyInFlight) return;
    _reapplyInFlight = true;
    try {
      _ensureExpenseSearchEl();
      _applyExpenseSearch();
    } finally {
      _reapplyInFlight = false;
    }
  }

  const _logContainer = document.getElementById("transaction-log");
  if (_logContainer && typeof MutationObserver !== "undefined") {
    const _obs = new MutationObserver(function () {
      // Defer so DOM-batched mutations settle before we measure / hide.
      setTimeout(_ensureSearchBarAndReapply, 0);
    });
    _obs.observe(_logContainer, { childList: true, subtree: false });
  }
  // Initial setup (in case log was already populated before observer attached).
  setTimeout(_ensureSearchBarAndReapply, 0);

  // Wire the search input (created lazily — use delegation on the body)
  document.addEventListener("input", function (e) {
    if (e.target && e.target.id === "txn-expense-search") {
      _applyExpenseSearch();
    }
  });
  document.addEventListener("click", function (e) {
    if (e.target && e.target.closest && e.target.closest("#txn-expense-search-clear")) {
      const input = document.getElementById("txn-expense-search");
      if (input) {
        input.value = "";
        _applyExpenseSearch();
        input.focus();
      }
    }
  });

  if (txnPhotoFile) {
    txnPhotoFile.addEventListener("change", async function () {
      const file = this.files[0];
      if (!file || !_pendingAttachDocId) return;
      txnPhotoFile.value = "";  // reset for re-use

      if (file.size > 5 * 1024 * 1024) {
        if (typeof showNotification === "function") showNotification("File too large. Max 5 MB.", "error");
        return;
      }

      // 1. Upload file
      try {
        if (typeof showNotification === "function") showNotification("Uploading photo…", "info");

        const formData = new FormData();
        formData.append("file", file);
        const upRes  = await fetch("/upload_expense_invoice", { method: "POST", body: formData });
        const upData = await upRes.json();
        if (!upData.success) throw new Error(upData.message || "Upload failed");

        // 2. Attach to expense doc
        const patchRes  = await fetch("/update_expense_photo", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ doc_id: _pendingAttachDocId, invoice_photo_url: upData.url }),
        });
        const patchData = await patchRes.json();
        if (!patchData.success) throw new Error(patchData.message || "Attach failed");

        if (typeof showNotification === "function") showNotification("Invoice photo attached!", "success");
        // Refresh the transaction log so the photo icon appears
        if (typeof debouncedFetchData === "function") debouncedFetchData();
      } catch (err) {
        console.error("Attach photo error:", err);
        if (typeof showNotification === "function") showNotification(`Error: ${err.message}`, "error");
      } finally {
        _pendingAttachDocId = null;
      }
    });
  }

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

// ── Payment history cache ─────────────────────────────────────────────────────
// Key: "${room}:${checkin_time}"   Value: { data, ts }
// TTL: 5 minutes. Invalidated on any write via invalidatePayHistoryCache().
//
// Also tracks an in-flight Promise per key so that
//   prefetchPaymentLogs(123) + updatePaymentLogs(123)
// fired back-to-back share a single network round-trip instead of
// each starting their own. Previously they raced and we paid twice.
const _payCache = {};
const _payInflight = new Map();
const _PAY_CACHE_TTL = 5 * 60 * 1000;

function _payCacheKey(roomNumber) {
  const r =
    typeof rooms !== "undefined" && rooms[roomNumber] ? rooms[roomNumber] : {};
  return `${roomNumber}:${r.checkin_time || ""}`;
}

window.invalidatePayHistoryCache = function (roomNumber) {
  delete _payCache[_payCacheKey(roomNumber)];
  _payInflight.delete(_payCacheKey(roomNumber));
};

// Internal — start (or reuse) a fetch. Returns the Promise so callers
// can await the result without forcing a second request.
function _startPayFetch(roomNumber) {
  const key = _payCacheKey(roomNumber);

  const cached = _payCache[key];
  if (cached && Date.now() - cached.ts < _PAY_CACHE_TTL) {
    return Promise.resolve(cached.data);
  }
  const inflight = _payInflight.get(key);
  if (inflight) return inflight;

  const roomInfo = typeof rooms !== "undefined" ? rooms[roomNumber] : null;
  if (!roomInfo || !roomInfo.guest) {
    return Promise.resolve(null);
  }

  const p = apiFetch("/get_history", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      room: roomNumber,
      name: roomInfo.guest.name,
      checkin_time: roomInfo.checkin_time || null,
      // Canonical foreign key — sends the stay's bill_id directly so
      // the backend can hit the Q0 single-field query without first
      // fetching the room doc to read active_bill_id.
      stay_id: roomInfo.active_bill_id || null,
    }),
  })
    .then((r) => r.json())
    .then((data) => {
      if (data && data.success) _payCache[key] = { data, ts: Date.now() };
      return data;
    })
    .finally(() => {
      _payInflight.delete(key);
    });

  _payInflight.set(key, p);
  return p;
}

// Prefetch in background so data is ready when modal opens.
window.prefetchPaymentLogs = function (roomNumber) {
  // Fire and forget; the cache + in-flight map do the rest.
  _startPayFetch(roomNumber).catch(() => {});
};

// Exposed so updatePaymentLogs can share the same promise pool.
window._getPaymentLogsPromise = _startPayFetch;

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
      `[data-filter="${filterType}"].transaction-filter-btn`,
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
          transactionLogManager.renderEnhancedLogItem(log, log.logType),
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
let txnActiveType = "all"; // "all" | "cash" | "online" | "refunds" | "expenses"
// Expense sub-scope for the admin Daily/Report toggle on the Expense
// view. "daily" = drawer expenses (default — matches the non-admin
// view); "report" = report expenses; "all" = both.
let txnExpenseScope = "daily";
let txnDateUnlocked = false; // true after manager password verified
let txnExtendedLogs = null; // cached logs from /get_transactions_range for current range

function _getDateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split("T")[0];
}

// Is fromDate covered by the /get_data cache?
// /get_data now fetches TODAY only — so only "today" is in the cache.
// Any range that starts before today must be fetched from /get_transactions_range.
function _isWithinCache(fromDate) {
  const today = new Date().toISOString().split("T")[0];
  return fromDate === today;
}

// Render using either cached logs or extended logs fetched from server.
// logsObj is passed as the 4th arg so renderEnhancedLogs uses it directly
// instead of reading the `let logs` global (window.logs swap doesn't work with let).
function _renderWithLogs(fromDate, toDate, logsObj) {
  if (transactionLogManager) {
    transactionLogManager.renderEnhancedLogs(
      fromDate,
      toDate,
      txnActiveType,
      logsObj || null,
    );
  }
}

// ── Expense Daily/Report/All sub-filter (admin only) ──────────────────────
// The toggle is shown only to admins, and only while the Expense type
// filter is active. txnExpenseScope drives which expenses
// renderEnhancedLogs keeps (see recentExpenseLogs above).
function _txnIsAdmin() {
  return !!(
    window.CibaraAuth &&
    window.CibaraAuth.isAdmin &&
    window.CibaraAuth.isAdmin()
  );
}

function _setExpenseScopeActive(scope) {
  document
    .querySelectorAll("#txn-expense-scope .txn-scope-btn")
    .forEach((b) => {
      const on = b.dataset.scope === scope;
      b.style.background = on ? "#3f51b5" : "#fff";
      b.style.color = on ? "#fff" : "#475569";
      b.style.borderColor = on ? "#3f51b5" : "#c7d2fe";
    });
}

// Returns the #txn-expense-scope toggle, building it if the loaded page
// HTML predates it (stale cache / not yet redeployed). Buttons are
// wired exactly once — tracked via the data-wired attribute — so this
// is safe to call on every render.
function _ensureExpenseScopeEl() {
  let el = document.getElementById("txn-expense-scope");
  if (!el) {
    const anchor = document.querySelector(".txn-type-filter");
    if (!anchor || !anchor.parentNode) return null;
    el = document.createElement("div");
    el.id = "txn-expense-scope";
    el.className = "txn-expense-scope";
    el.style.cssText =
      "display:none; gap:0.4rem; margin:0 0 0.6rem; flex-wrap:wrap;";
    el.innerHTML = [
      ["daily", "Daily"],
      ["report", "Report"],
      ["all", "All"],
    ]
      .map(
        (o) =>
          `<button type="button" class="txn-scope-btn" data-scope="${o[0]}" ` +
          `style="padding:4px 13px;border:1px solid #c7d2fe;border-radius:6px;` +
          `font-size:0.78rem;font-weight:600;cursor:pointer;` +
          `background:#fff;color:#475569;">${o[1]}</button>`,
      )
      .join("");
    anchor.parentNode.insertBefore(el, anchor.nextSibling);
  }
  if (!el.dataset.wired) {
    el.dataset.wired = "1";
    el.querySelectorAll(".txn-scope-btn").forEach((btn) => {
      btn.addEventListener("click", function () {
        txnExpenseScope = this.dataset.scope || "daily";
        _setExpenseScopeActive(txnExpenseScope);
        const { fromDate, toDate } = txnActiveDateRange;
        _triggerRender(fromDate, toDate);
      });
    });
    _setExpenseScopeActive(txnExpenseScope);
  }
  return el;
}

function _syncExpenseScopeVisibility() {
  const el = _ensureExpenseScopeEl();
  if (!el) return;
  el.style.display =
    _txnIsAdmin() && txnActiveType === "expenses" ? "flex" : "none";
}

async function _triggerRender(fromDate, toDate) {
  txnActiveDateRange = { fromDate, toDate };
  txnExtendedLogs = null;

  // If range is within the 3-day cache, use it directly — no extra network call
  if (_isWithinCache(fromDate)) {
    _renderWithLogs(fromDate, toDate, null);
    return;
  }

  // Extended range — fetch from server
  const logEl = document.getElementById("transaction-log");
  if (logEl)
    logEl.innerHTML = `<div class="loading-indicator"><span class="loader"></span><p>Loading transactions…</p></div>`;

  try {
    const res = await apiFetch("/get_transactions_range", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from_date: fromDate, to_date: toDate }),
    });
    const data = await res.json();
    if (data.success && data.logs) {
      txnExtendedLogs = data.logs;
      _renderWithLogs(fromDate, toDate, txnExtendedLogs);
    } else {
      if (logEl)
        logEl.innerHTML = `<div class="empty-state" style="padding:2rem;text-align:center;"><i class="fas fa-exclamation-triangle fa-2x" style="color:var(--warning);margin-bottom:0.75rem;display:block;"></i><p>${data.message || "Failed to load data."}</p></div>`;
    }
  } catch (e) {
    if (logEl)
      logEl.innerHTML = `<div class="empty-state" style="padding:2rem;text-align:center;"><p style="color:var(--danger);">Network error: ${e.message}</p></div>`;
  }
}

// ── Date picker lock / unlock ─────────────────────────────────────────────────
function _setDatePickerUnlocked() {
  txnDateUnlocked = true;
  const rangeEl = document.getElementById("txn-date-range");
  const icon = document.getElementById("txn-date-lock-icon");
  const lockBtn = document.getElementById("txn-relock-btn");

  if (rangeEl) {
    rangeEl.classList.remove("txn-date-locked");
    rangeEl.placeholder = "Pick date range";
  }
  const altInput = window._txnPicker && window._txnPicker.altInput;
  if (altInput) {
    altInput.classList.remove("txn-date-locked");
    altInput.placeholder = "Pick date range";
    altInput.style.cursor = "pointer";
  }
  if (icon)
    icon.innerHTML =
      '<i class="fas fa-lock-open" style="color:var(--success);font-size:0.75rem;"></i>';
  if (lockBtn) lockBtn.style.display = "flex"; // show re-lock button
}

function _relockDatePicker() {
  txnDateUnlocked = false;
  txnExtendedLogs = null;
  const rangeEl = document.getElementById("txn-date-range");
  const icon = document.getElementById("txn-date-lock-icon");
  const lockBtn = document.getElementById("txn-relock-btn");

  if (rangeEl) {
    rangeEl.classList.add("txn-date-locked");
    rangeEl.placeholder = "🔒 Custom range";
  }
  const altInput = window._txnPicker && window._txnPicker.altInput;
  if (altInput) {
    altInput.classList.add("txn-date-locked");
    altInput.placeholder = "🔒 Custom range";
  }
  if (icon)
    icon.innerHTML = '<i class="fas fa-lock" style="font-size:0.75rem;"></i>';
  if (lockBtn) lockBtn.style.display = "none";

  // Snap back to Today
  const today = new Date().toISOString().split("T")[0];
  if (window._txnPicker) window._txnPicker.setDate([today, today]);
  document
    .querySelectorAll(".txn-quick-btn")
    .forEach((b) => b.classList.remove("active"));
  const todayBtn = document.querySelector('.txn-quick-btn[data-range="today"]');
  if (todayBtn) todayBtn.classList.add("active");
  _triggerRender(today, today);
}

function _openTxnPasswordModal() {
  // Migrated to RBAC: instead of showing the password modal, check the
  // user's permission directly. Admin → unlock the picker. Anyone else →
  // toast and bail out. The modal HTML stays in the DOM but is never shown.
  const auth = window.CibaraAuth;
  if (auth && auth.userCan && auth.userCan("transaction.history.full")) {
    _setDatePickerUnlocked();
    if (window._txnPicker) window._txnPicker.open();
    return;
  }
  try {
    if (window.showToast) {
      window.showToast(
        "Access denied — only admins can view custom date ranges.",
        "error",
      );
    } else {
      alert("Access denied — only admins can view custom date ranges.");
    }
  } catch (_) { /* ignore */ }
}

function _closeTxnPasswordModal() {
  const modal = document.getElementById("txn-date-pwd-modal");
  if (modal) modal.classList.remove("show");
}

async function _submitTxnPassword() {
  // Legacy function — RBAC made this obsolete. Calls _openTxnPasswordModal
  // (now a userCan check) so any cached inline onclick still works.
  _openTxnPasswordModal();
}

function initTxnDateFilter() {
  const todayStr = new Date().toISOString().split("T")[0];
  const defaultFrom = todayStr; // today only

  // ── RBAC: only admin gets the date-range picker ──────────────────────────
  // For everyone else the .txn-custom-range container is hidden via
  // data-roles="admin" (auth.js does the hide). We skip flatpickr init
  // entirely for non-admin so we don't waste cycles on an invisible widget.
  const _auth = window.CibaraAuth;
  const _isAdmin = _auth && _auth.isAdmin && _auth.isAdmin();

  const rangeEl = document.getElementById("txn-date-range");
  if (_isAdmin && rangeEl && window.flatpickr) {
    window._txnPicker = flatpickr(rangeEl, {
      mode: "range",
      dateFormat: "Y-m-d",
      altInput: true,
      altFormat: "d M Y",
      defaultDate: [todayStr, todayStr],
      maxDate: todayStr,
      disableMobile: true,
      onChange: function (selectedDates) {
        if (selectedDates.length === 2) {
          const from = selectedDates[0].toISOString().split("T")[0];
          const to = selectedDates[1].toISOString().split("T")[0];
          document
            .querySelectorAll(".txn-quick-btn")
            .forEach((b) => b.classList.remove("active"));
          _triggerRender(from, to);
        }
      },
    });
    // Auto-unlock for admin — the lock metaphor is gone; they can use the
    // picker freely, no password gate, no re-lock button.
    txnDateUnlocked = true;
  }

  // ── Quick buttons ─────────────────────────────────────────────────────────
  document.querySelectorAll(".txn-quick-btn").forEach((btn) => {
    btn.addEventListener("click", function () {
      document
        .querySelectorAll(".txn-quick-btn")
        .forEach((b) => b.classList.remove("active"));
      this.classList.add("active");

      const range = this.dataset.range;
      const today = new Date().toISOString().split("T")[0];
      // "today" → same day; "3" → last 3 days (today + 2 days back)
      const from =
        range === "today" ? today : _getDateOffset(parseInt(range, 10) - 1);
      if (window._txnPicker) window._txnPicker.setDate([from, today]);
      _triggerRender(from, today);
    });
  });

  // ── Type filter buttons ───────────────────────────────────────────────────
  document.querySelectorAll(".txn-type-btn").forEach((btn) => {
    btn.addEventListener("click", function () {
      document
        .querySelectorAll(".txn-type-btn")
        .forEach((b) => b.classList.remove("active"));
      this.classList.add("active");
      txnActiveType = this.dataset.type;
      _syncExpenseScopeVisibility();
      const { fromDate, toDate } = txnActiveDateRange;
      _triggerRender(fromDate, toDate);
    });
  });

  // ── Expense Daily/Report/All sub-filter (admin only) ──────────────────────
  // _syncExpenseScopeVisibility builds + wires the toggle on first call,
  // so it works even if the loaded index.html predates the control.
  _syncExpenseScopeVisibility();

  // ── Re-lock button ────────────────────────────────────────────────────────
  const relockBtn = document.getElementById("txn-relock-btn");
  if (relockBtn) relockBtn.addEventListener("click", _relockDatePicker);

  // ── Password modal events ─────────────────────────────────────────────────
  const closeBtn = document.getElementById("txn-pwd-close-btn");
  const submitBtn = document.getElementById("txn-pwd-submit-btn");
  const pwdInput = document.getElementById("txn-pwd-input");

  if (closeBtn) closeBtn.addEventListener("click", _closeTxnPasswordModal);
  if (submitBtn) submitBtn.addEventListener("click", _submitTxnPassword);
  if (pwdInput)
    pwdInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") _submitTxnPassword();
    });

  // Close modal on backdrop click
  const pwdModal = document.getElementById("txn-date-pwd-modal");
  if (pwdModal) {
    pwdModal.addEventListener("click", function (e) {
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

// ─── Real-time payment / expense sync ─────────────────────────────────────
// When Firestore pushes a new payment or expense to this browser,
// refresh the transactions view so it stays current without a manual reload.
(function _wireTransactionSync() {
  function _isDateInRange(dateStr) {
    const { fromDate, toDate } = txnActiveDateRange;
    if (!fromDate) return false;
    return dateStr >= fromDate && dateStr <= (toDate || fromDate);
  }

  function _refreshTxnView(dateStr) {
    const txnTab = document.getElementById("transaction-tab");
    const tabVisible = txnTab && !txnTab.classList.contains("hidden");

    if (!_isDateInRange(dateStr)) {
      // Payment outside current range — nothing to do
      return;
    }

    if (_isWithinCache(txnActiveDateRange.fromDate)) {
      // Today's data — logs were already patched by _patchLocalLogs in google_sync.js
      // Just re-render from the patched in-memory logs
      if (tabVisible) {
        _renderWithLogs(txnActiveDateRange.fromDate, txnActiveDateRange.toDate, null);
      }
    } else {
      // Extended range — invalidate the cached server result so next render re-fetches
      txnExtendedLogs = null;
      if (tabVisible) {
        _triggerRender(txnActiveDateRange.fromDate, txnActiveDateRange.toDate);
      }
    }
  }

  window.addEventListener("cibaraPaymentAdded", (e) => {
    const p = e.detail || {};
    if (p.date) _refreshTxnView(p.date);
  });

  window.addEventListener("cibaraExpenseAdded", (e) => {
    const exp = e.detail || {};
    if (exp.date) _refreshTxnView(exp.date);
  });
})();

document.addEventListener("DOMContentLoaded", function () {
  // Wait for the auth state to resolve before init — initTxnDateFilter
  // checks CibaraAuth.isAdmin() to decide whether to wire the date-range
  // picker. If init runs before auth resolves, _isAdmin is false and the
  // picker stays inert for admin too.
  function _go() {
    initTxnDateFilter();
    console.log("Transaction date filter ready");
  }
  if (window.CibaraAuth && typeof window.CibaraAuth.ready === "function") {
    window.CibaraAuth.ready().then(function () {
      // Small delay to let other DOM-ready handlers finish first.
      setTimeout(_go, 50);
    });
  } else {
    setTimeout(_go, 1000);
  }
});
