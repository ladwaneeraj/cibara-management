// transaction-tracking.js - Enhanced Transaction Tracking System with Unified Styling

// Format a Date using LOCAL calendar components. This deployment runs in IST
// and the backend stores each transaction's `date` as the IST calendar day
// (datetime.now(IST)). Using `.toISOString().split("T")[0]` here would convert
// to UTC first, shifting the date back by one day for any IST time between
// 00:00 and 05:30 — and for flatpickr's local-midnight range values it shifts
// back a full day on every pick. That mismatch is what made the date-range
// filter (e.g. Jun 1–Jun 2) return the previous day's data (May 31).
function _localYMD(d) {
  d = d || new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ── Payment-history formatters ────────────────────────────────────────────
// Absolute date/time only — no relative "Today/Yesterday" labels. Dates
// render as DD-MM-YYYY, times as 12-hour with AM/PM. Both return the raw
// stored value on any parse failure so a row never renders worse than the
// data behind it.
function _fmtDMY(ymd) {
  if (!ymd) return "";
  const datePart = String(ymd).trim().split(/[ T]/)[0];
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : String(ymd);
}

function _fmt12h(hhmm) {
  if (!hhmm) return "";
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm).trim());
  if (!m) return String(hhmm);
  let h = +m[1];
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 === 0 ? 12 : h % 12;
  return `${h}:${m[2]} ${ampm}`;
}

// "11-07-2026, 10:55 AM" — omits whichever part is missing.
function _payWhen(dateStr, timeStr) {
  return [_fmtDMY(dateStr), _fmt12h(timeStr)].filter(Boolean).join(", ");
}

// Payment-method → clean pill label + CSS modifier. Anything that isn't
// cash/online is treated as an on-account "Balance".
function _methodLabel(m) {
  m = String(m || "").toLowerCase();
  if (m === "cash") return "Cash";
  if (m === "online") return "Online";
  return "Balance";
}
function _methodClass(m) {
  m = String(m || "").toLowerCase();
  if (m === "cash" || m === "online") return m;
  return "balance";
}

// Is this add-on an accommodation charge (Extra Bed / AC)? Those are the
// entries billed to a specific night, so they get a "For <date>" tag.
// Prefer the explicit flag; fall back to the item name for legacy rows.
function _isAccomAddon(payment) {
  if (payment && payment.accommodation_charge === true) return true;
  return /\b(bed|ac)\b/.test(String((payment && payment.item) || "").toLowerCase());
}

// Icon for a row, chosen from FontAwesome names already shipped in the app.
function _payIcon(kind, item) {
  if (kind === "refund") return "fa-undo";
  if (kind === "shift") return "fa-exchange-alt";
  if (kind === "booking") return "fa-calendar-check";
  if (kind === "later") return "fa-clock";
  if (kind === "online") return "fa-mobile-alt";
  if (kind === "cash") return "fa-money-bill-wave";
  if (kind === "addon") {
    const it = String(item || "").toLowerCase();
    if (/\bbed\b/.test(it)) return "fa-bed";
    if (/\bac\b/.test(it)) return "fa-snowflake";
    if (it.includes("water")) return "fa-tint";
    return "fa-concierge-bell";
  }
  return "fa-receipt";
}

// Escape every HTML-significant character for use inside a double-quoted
// attribute. Expense descriptions are operator-entered free text and routinely
// contain &, ", ' and angle brackets.
// True while renderEnhancedLogs is being run only to compute what the list
// WOULD look like. It still refreshes the summary tiles (they are absolute
// values recomputed from the same data, so that is a correction, not a
// side effect) — what it suppresses is the innerHTML rewrite. Set by
// txnMarkListSynced().
let _txnDryRun = false;

/**
 * "2026-08-11" -> "11-08-2026".
 *
 * The app shows dates numerically as DD-MM-YYYY throughout. Pure string
 * surgery on the YYYY-MM-DD the server stores — no Date object, so no
 * timezone can shift the day (this deployment runs in IST, where a UTC
 * round-trip moves any date between 00:00 and 05:30 back by one).
 */
function _ddmmyyyy(ymd) {
  const s = String(ymd || "");
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? m[3] + "-" + m[2] + "-" + m[1] : s;
}

function _txnAttrEsc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

class TransactionTracker {
  constructor() {
    this.dailyCounters = this.loadDailyCounters();
    this.todayDate = _localYMD();
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
    const todayStr = _localYMD();
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
    const cutoffDate = _localYMD(thirtyDaysAgo);

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
    const todayStr = _localYMD();
    if (!fromDate || !toDate) {
      toDate = todayStr;
      const d = new Date();
      d.setDate(d.getDate() - 2);
      fromDate = _localYMD(d);
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
    // Composable "GST only" sub-filter — list only, so the analytics cards above
    // still reflect every expense in the range.
    if (txnExpenseGstOnly) {
      expenseForList = expenseForList.filter(_expenseCarriesGst);
    }
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
      if (_txnDryRun) { transactionLog._lastHTML = null; return; }
      transactionLog._lastHTML = null;
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

    const _today = _localYMD();
    const _yesterday = (() => {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      return _localYMD(d);
    })();

    // Day-group heading. Numeric DD-MM-YYYY, matching every other date in
    // the app — "11 Aug" left the year to be inferred, which is wrong as
    // soon as you browse a past range.
    function formatDate(dateStr) {
      const date = new Date(dateStr + "T00:00:00");
      const weekday = date.toLocaleDateString("en-IN", { weekday: "long" });
      return weekday + ", " + _ddmmyyyy(dateStr);
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

        // Per-day cash/UPI split + payment counts for the collapsible header.
        // Continue (room renewal) and fresh check-in counts EXCLUDE add-ons
        // (water/service), refunds and expenses, per ops request.
        let dayCash = 0, dayOnline = 0, freshCount = 0, contCount = 0;
        logsByDate[date].forEach((l) => {
          if (l.logType === "cash") dayCash += (l.amount || 0);
          else if (l.logType === "online") dayOnline += (l.amount || 0);
          const isService = !!(l.item || l.transaction_type === "service");
          const isFresh = !!(l.is_fresh_checkin ||
            l.transaction_type === "fresh_checkin" ||
            l.transaction_type === "booking_conversion" ||
            l.is_booking_conversion);
          const isContinue = !!(l.is_renewal ||
            l.transaction_type === "renewal_payment");
          if (l.logType === "refunds" || l.logType === "expenses" ||
              l.logType === "settlement" || isService) return;
          if (isFresh) freshCount += 1;
          else if (isContinue) contCount += 1;
        });
        const _inr = (n) => n.toLocaleString("en-IN");
        const _meta =
          '<span class="log-date-meta" style="display:inline-flex;gap:.5rem;' +
          'flex-wrap:wrap;margin-left:.5rem;font-size:.64rem;font-weight:600;">' +
            '<span style="color:#16a34a;">Cash ₹' + _inr(dayCash) + '</span>' +
            '<span style="color:#2563eb;">UPI ₹' + _inr(dayOnline) + '</span>' +
            '<span style="color:#7c3aed;">Fresh ' + freshCount + '</span>' +
            '<span style="color:#b45309;">Continue ' + contCount + '</span>' +
          '</span>';

        logsHTML +=
          '<div class="log-date-header" data-log-date="' + date + '" style="cursor:pointer;">' +
            '<span style="display:inline-flex;align-items:center;flex-wrap:wrap;">' +
              '<span class="log-date-caret" style="display:inline-block;width:1em;' +
              'margin-right:.35rem;">▾</span>' +
              '<span>' + dateDisplay + '</span>' + _meta +
            '</span>' +
            '<span class="log-date-total">₹' + _inr(dayTotal) + '</span>' +
          '</div>';

        logsHTML += '<div class="log-date-group" data-log-group="' + date + '">';

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

        logsHTML += '</div>';
      });

    // ── Skip a render that would change nothing ──────────────────────────
    // fetchData() runs on a 2-second debounce after most actions and always
    // ended with a full innerHTML rebuild of this list, whether or not any
    // transaction had changed. That rebuild is what reads as "the whole list
    // reloaded" a moment after adding an expense.
    //
    // The generated HTML is a pure function of the log data, so comparing it
    // to the last generated string is an exact test: identical string means
    // the DOM already shows exactly this. _txnDryRun lets the incremental
    // splice helpers record the string their spliced DOM corresponds to, so
    // the reconcile that follows them also skips.
    if (transactionLog._lastHTML === logsHTML && !_txnDryRun) {
      // The list is already right, but the state layered ON TOP of it is not
      // necessarily: the expense search bar is created lazily by a
      // MutationObserver that only fires on a real innerHTML write, and its
      // active query hides rows with inline display:none. Skipping the write
      // without this left the bar missing (or its filter stuck on) whenever a
      // filter change happened to produce identical HTML.
      _txnAfterSplice();
      return;
    }
    if (_txnDryRun) {
      transactionLog._lastHTML = logsHTML;
      return;
    }
    transactionLog._lastHTML = logsHTML;

    // Which day groups the operator had collapsed. innerHTML throws the
    // collapsed class away with the old nodes, so capture it first and put it
    // back — otherwise every background refresh silently re-expands the list.
    const _collapsedDates = new Set(
      Array.from(
        transactionLog.querySelectorAll(".log-date-header.collapsed"),
      ).map((h) => h.getAttribute("data-log-date")),
    );

    transactionLog.innerHTML = logsHTML;

    if (_collapsedDates.size) {
      _collapsedDates.forEach((d) => {
        if (!d) return;
        const hdr = transactionLog.querySelector(
          '.log-date-header[data-log-date="' + d + '"]');
        const grp = transactionLog.querySelector(
          '.log-date-group[data-log-group="' + d + '"]');
        if (!hdr) return;
        hdr.classList.add("collapsed");
        const caret = hdr.querySelector(".log-date-caret");
        if (caret) caret.textContent = "▸";
        if (grp) grp.style.display = "none";
      });
    }

    // Collapsible date groups — bind once on the persistent container so the
    // handler survives re-renders (innerHTML swaps children, not the node).
    if (transactionLog && !transactionLog._collapseBound) {
      transactionLog._collapseBound = true;
      transactionLog.addEventListener("click", (ev) => {
        const hdr = ev.target.closest(".log-date-header");
        if (!hdr || !transactionLog.contains(hdr)) return;
        const d = hdr.getAttribute("data-log-date");
        if (!d) return;
        const grp = transactionLog.querySelector(
          '.log-date-group[data-log-group="' + d + '"]');
        const collapsed = hdr.classList.toggle("collapsed");
        const caret = hdr.querySelector(".log-date-caret");
        if (caret) caret.textContent = collapsed ? "▸" : "▾";
        if (grp) grp.style.display = collapsed ? "none" : "";
      });
    }
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
      // The category already shows as a colour chip in the title, so don't
      // repeat it (as a raw slug like "staff_advance") in the subtitle —
      // leave just the time there.
      type = "";
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

    // Cash / Online payment-mode pill. Shown ONLY on rows where real money
    // actually moved at the front desk. The row's `method` field is the
    // authoritative signal — NOT logType, because the backend buckets
    // several non-drawer methods under `cash` for display purposes:
    //   - pay_later     : balance deferred at check-in (₹0)
    //   - already_paid  : booking conversion where the advance covered all
    //   - ota           : MMT/OTA prepaid (settled to bank, not the drawer)
    //   - settlement    : settle-later marker (no money collected)
    //   - balance       : rent accrual, not a receipt
    // An MMT check-in lands as method="already_paid" in the `cash` bucket,
    // so the old logType-first logic mislabelled it "Cash". Gate on method
    // (and amount) instead so only genuine cash/online receipts get a pill.
    let modeHtml = "";
    const _rowMethod = String(log.method || log.payment_method || "").toLowerCase();
    const _noMoneyMethods = [
      "pay_later", "already_paid", "ota", "settlement", "bank_settlement", "balance",
    ];
    const _noMoneyRow =
      _noMoneyMethods.includes(_rowMethod) ||
      log.amount === 0 ||
      (log.payment_method === "pay_later") ||
      (log.amount === 0 && log.is_fresh_checkin);
    if (!_noMoneyRow) {
      let _mode = "";
      if (_rowMethod === "cash") {
        _mode = "cash";
      } else if (_rowMethod === "online" || _rowMethod === "upi" || _rowMethod === "card") {
        _mode = "online";
      } else if (logType === "cash") {
        _mode = "cash";          // fallback: money moved but method absent
      } else if (logType === "online") {
        _mode = "online";
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
    // Extra data-* attributes for the row wrapper. Only expense rows the
    // current user may manage get them; that absence is what makes a row
    // non-actionable, so there is no second permission check on tap.
    let expenseRowAttrs = "";
    if (logType === "expenses") {
      // description is the user-entered text; for payments-collection entries it
      // gets stored in the `name` field, so fall back to that.
      // Keep the raw text for data-* attributes (the browser decodes those
      // back to the original string) and an escaped copy for the innerHTML
      // interpolation below.
      //
      // The escaping is a fix, not decoration: this label was previously
      // interpolated raw into the row's HTML, so an expense description
      // containing markup — <img src=y onerror=...> typed into the
      // description field — executed for every user who opened the
      // Transactions tab. Pre-existing bug; this line is the injection point.
      const expenseLabelRaw = log.description || log.name || "Expense";
      const expenseLabel = _txnAttrEsc(expenseLabelRaw);
      const catDisplay = (log.category || "others")
        .charAt(0).toUpperCase() +
        (log.category || "others").slice(1).replace(/_/g, " ");

      // Photo icon or attach button. Categories that never carry an
      // invoice photo get NO "Photo" attach button here. An already-attached
      // photo is STILL shown as a view link, whatever the category — hiding it
      // would strand a file the operator can no longer reach.
      //
      // Payroll rows carry no external invoice, so the attach button was only
      // adding noise: a salary payout, a staff advance and a meal log are all
      // generated by the Staff module against records it already holds.
      // (staff_advance used to keep the button for signed-slip photos; it was
      // not being used and cluttered the row.)
      const NO_PHOTO_CATS = [
        "rent", "petty_cash", "salary", "staff_advance", "staff_meals",
      ];
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

      // Edit / delete are NOT inline buttons any more. They lived here as two
      // 20px targets per row, which made every row busy and were awkward to
      // hit on a phone. Tapping the row now opens an action sheet instead —
      // see _openExpenseActionSheet below. The row carries the data those
      // actions need via data-* attributes (stamped onto .log-item further
      // down), and `_canManage` decides whether the row is actionable at all.
      const _canManage = window.CibaraAuth
        && typeof window.CibaraAuth.userCan === "function"
        && window.CibaraAuth.userCan("expense.manage");
      const _rowActionable = !!(_canManage && log._doc_id);

      // Print voucher — only for a GST expense that has a receipt photo.
      let printHtml = "";
      if (log.has_gst && log.invoice_photo_url && log._doc_id) {
        printHtml = `<button type="button"
          class="txn-exp-print-btn"
          data-doc-id="${String(log._doc_id).replace(/"/g, "&quot;")}"
          title="Print invoice photo"
          style="margin-left:5px;background:none;border:1px solid #cbd5e0;border-radius:5px;padding:1px 7px;font-size:0.7rem;color:#475569;cursor:pointer;line-height:1.6;">
          <i class="fas fa-print"></i>
        </button>`;
      }

      titleContent = `<strong>${expenseLabel}</strong>
        <span style="font-size:0.7rem;background:#fed7d7;color:#c53030;border-radius:4px;padding:1px 6px;margin-left:4px;font-weight:500;">${catDisplay}</span>
        ${gstBadge}${photoHtml}${printHtml}`;
      // Stash what the action sheet needs. Read back off the row on tap.
      if (_rowActionable) {
        expenseRowAttrs =
          ` data-exp-doc-id="${_txnAttrEsc(log._doc_id)}"` +
          ` data-exp-amount="${_txnAttrEsc(log.amount || 0)}"` +
          ` data-exp-description="${_txnAttrEsc(expenseLabelRaw)}"`;
      }
    } else {
      titleContent = `Room ${log.room} - ${log.name}`;
    }

    // "Collected by / Added by" chip — who recorded this row.
    // Payments carry log.createdBy (a userId, resolved via the user
    // directory). Expenses carry log.created_by = {userId, name} with the
    // name embedded (audit stamp written by routes/reports.py and the
    // Staff module), so no directory lookup is needed for them. Hidden
    // for legacy entries that predate either field.
    let byChip = "";
    let _byName = "";
    let _byVerb = "Collected by";
    if (log.createdBy && window.CibaraUsers) {
      _byName = window.CibaraUsers.nameOf(log.createdBy);
    } else if (log.created_by && log.created_by.name &&
               log.created_by.name !== "system") {
      _byName = log.created_by.name;
      _byVerb = "Added by";
    }
    if (_byName) {
      const _safe = String(_byName).replace(/[<&>"']/g, function (c) {
        return { "<": "&lt;", "&": "&amp;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
      byChip =
        ' <span class="txn-added-by" title="' + _byVerb + " " + _safe +
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

    // Mark expense rows with a stable data attribute so the admin search
    // filter can target them whether or not they are actionable (older docs
    // without _doc_id, or a non-admin view).
    const rowDataAttrs = (logType === "expenses")
      ? ' data-expense-row="1"' + expenseRowAttrs
      : "";
    // ── Stay link (payment rows → Register) ────────────────────────────
    // Every non-expense row belongs to a stay ("Room X - Name"). Stamp the
    // identifiers the Register tab needs to locate that stay so a tap on
    // the row can jump straight to it. stay_id is the canonical foreign
    // key every payment carries (Phase 2+); room/guest/date are the
    // fallback for legacy rows written before the stay_id migration.
    let stayNavAttrs = "";
    if (logType !== "expenses" && log.room != null && log.room !== "" && log.name) {
      stayNavAttrs =
        ` data-stay-id="${_txnAttrEsc(log.stay_id || "")}"` +
        ` data-stay-room="${_txnAttrEsc(log.room)}"` +
        ` data-stay-guest="${_txnAttrEsc(log.name)}"` +
        ` data-stay-date="${_txnAttrEsc((log.date || "").slice(0, 10))}"`;
    }
    // Actionable rows advertise themselves: pointer cursor and hover tint via
    // the class, plus role/tabindex so the sheet is reachable from a keyboard.
    const rowClass = "log-item"
      + (expenseRowAttrs ? " txn-row-actionable" : "")
      + (stayNavAttrs ? " txn-row-staylink" : "");
    const rowA11y  = expenseRowAttrs
      ? ' role="button" tabindex="0" aria-haspopup="menu"'
      : (stayNavAttrs
          ? ' role="button" tabindex="0" title="Open this stay in the Register"'
          : "");
    // Sort key, carried on the row so a single row can be spliced into an
    // already-rendered day group at the right position without re-deriving the
    // whole list. See the incremental-mutation helpers near the bottom of this
    // file. Rows within a group are ordered by descending time.
    // data-log-id is stamped on EVERY expense row, actionable or not.
    // data-exp-doc-id only appears when the viewer has expense.manage, so a
    // manager's list had no way to tell "this row is already on screen" from
    // "not yet" — and a Firestore push racing a local splice showed the row
    // twice until the next reconcile.
    const rowSort =
      ` data-log-time="${_txnAttrEsc(log.time || "00:00:00")}"` +
      ` data-log-type="${_txnAttrEsc(logType || "")}"` +
      ` data-log-serial="${_txnAttrEsc(log.serial_number || 0)}"` +
      (log._doc_id ? ` data-log-id="${_txnAttrEsc(log._doc_id)}"` : "");

    return `
      <div class="${rowClass}"${rowDataAttrs}${stayNavAttrs}${rowSort}${rowA11y} ${rowBg}>
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

      let title = "Payment";
      let kind = "cash"; // cash | online | addon | refund | shift | booking | later
      let amountText = `₹${payment.amount || 0}`;
      let amtKind = "in"; // in | addon | refund  (colour of the amount)
      let showAmount = true;
      let methodBadgeHtml = "";

      const src = payment._source;
      const ptype = payment.type || "";

      if (src === "refund" || _refundTypes.has(ptype)) {
        title = "Refund";
        kind = "refund";
        amtKind = "refund";
        amountText = `₹${Math.abs(payment.amount || 0)}`;
      } else if (src === "addon" || ptype === "addon") {
        title = payment.item || payment.note || "Add-on";
        kind = "addon";
        amtKind = "addon";
        const method = payment.method || payment.payment_method || "balance";
        methodBadgeHtml = `<span class="pay-badge pay-badge--${_methodClass(method)}">${_methodLabel(method)}</span>`;
        amountText = `₹${payment.amount || payment.price || 0}`;
      } else if (src === "shift" || ptype === "room_shift") {
        title = `Room shifted from Room ${payment.old_room || "?"}`;
        kind = "shift";
        showAmount = false;
      } else if (ptype === "booking_advance" || ptype === "booking_payment") {
        title = "Booking Advance";
        kind = "booking";
        methodBadgeHtml = `<span class="pay-badge pay-badge--${_methodClass(payment.method || "cash")}">${_methodLabel(payment.method || "cash")}</span>`;
      } else if (ptype === "booking_conversion") {
        if (payment.amount === 0) {
          title = "Booking — Fully Paid";
          kind = "booking";
          showAmount = false;
        } else {
          title = "Booking Final Payment";
          kind = "booking";
          methodBadgeHtml = `<span class="pay-badge pay-badge--${_methodClass(payment.method || "cash")}">${_methodLabel(payment.method || "cash")}</span>`;
        }
      } else if (src === "cash" || payment.method === "cash") {
        if (payment.payment_method === "pay_later" || payment.amount === 0) {
          title = "Pay Later";
          kind = "later";
          amtKind = "addon";
          showAmount = !!payment.amount;
        } else {
          title = "Cash Payment";
          kind = "cash";
          methodBadgeHtml = `<span class="pay-badge pay-badge--cash">Cash</span>`;
        }
      } else if (src === "online" || payment.method === "online") {
        title = "Online Payment";
        kind = "online";
        methodBadgeHtml = `<span class="pay-badge pay-badge--online">Online</span>`;
      }

      // "For <date>" tag — the night an Extra Bed / AC charge was billed to.
      // Prefers the absolute applied_on_date; falls back to the relative
      // "Day N" index for legacy rows that predate the date stamp.
      let forTagHtml = "";
      if (kind === "addon" && _isAccomAddon(payment)) {
        let forWhen = "";
        if (payment.applied_on_date) forWhen = _fmtDMY(payment.applied_on_date);
        else if (payment.applied_on_day) forWhen = `Day ${payment.applied_on_day}`;
        if (forWhen) {
          forTagHtml = `<span class="pay-for"><i class="fas fa-calendar-day"></i> For ${forWhen}</span>`;
        }
      }

      // "Added by" — small chip showing who recorded the payment.
      // Resolved via the user directory; hidden when createdBy is missing.
      let byHtml = "";
      if (payment.createdBy && window.CibaraUsers) {
        const _byName = window.CibaraUsers.nameOf(payment.createdBy);
        byHtml =
          '<span class="txn-added-by" title="Recorded by ' +
          String(_byName).replace(/"/g, "&quot;") +
          '"><i class="fas fa-user"></i> ' +
          String(_byName).replace(/[<&>]/g, function (c) {
            return { "<": "&lt;", "&": "&amp;", ">": "&gt;" }[c];
          }) +
          "</span>";
      }

      const iconClass = _payIcon(kind, payment.item);
      const iconTone =
        kind === "refund"
          ? "refund"
          : kind === "shift"
            ? "shift"
            : kind === "booking"
              ? "booking"
              : kind === "online"
                ? "online"
                : kind === "cash"
                  ? "cash"
                  : "addon"; // addon + later share the amber tone
      const whenStr = _payWhen(payment.date, payment.time);

      // A plain cash/online payment is already identified by its coloured
      // pill, so the "Cash Payment"/"Online Payment" title just repeats it.
      // Drop the title and let the pill be the row label; remove it from
      // line 2 so the method isn't shown twice.
      let line1Label = `<span class="pay-title">${title}</span>`;
      if ((kind === "cash" || kind === "online") && methodBadgeHtml) {
        line1Label = `<span class="pay-lead">${methodBadgeHtml}</span>`;
        methodBadgeHtml = "";
      }

      // Everything below the title/amount row — badges, "for" tag, date/time,
      // "added by" — is merged into ONE flex-wrap line instead of two stacked
      // divs, so a payment row is always exactly 2 lines tall (title+amount,
      // then this line), never 3, regardless of how many badges it carries.
      const line2 = `${forTagHtml}${methodBadgeHtml}${whenStr ? `<span class="pay-when">${whenStr}</span>` : ""}${byHtml}`;

      // ── Tap-to-correct ────────────────────────────────────────────────
      // Only service rows (add-ons) on an ACTIVE stay are correctable, and
      // only for users with payment.edit. Everything else renders exactly as
      // before with no tap affordance, so a cash receipt or a room-shift
      // note can never be opened for editing.
      //
      // A row that permanently raised the nightly rate is excluded here as
      // well as refused by the server: showing a tappable row that always
      // errors is worse than not offering it.
      // Any row opens the editor. Which rows can actually be changed, and
      // how, is the modal's business — making only some rows tappable here
      // would mean encoding those rules a second time, in a place that
      // cannot see the payment records the modal loads.
      const _voided = !!payment.voided;
      const _tappable = _payRowsOpenable(roomNumber);

      const _rowAttrs =
        ` class="pay-row${_tappable ? " txn-payrow-tappable" : ""}` +
        `${_voided ? " txn-row-voided" : ""}"` +
        (_tappable ? ` role="button" tabindex="0"` : "");

      const _voidNote = _voided
        ? `<span class="pay-badge pay-badge--voided">Removed${
             payment.voidedBy ? ` by ${_esc(payment.voidedBy)}` : ""}</span>`
        : "";

      logsHtml += `
        <div${_rowAttrs}>
          <div class="pay-icon pay-icon--${iconTone}"><i class="fas ${iconClass}"></i></div>
          <div class="pay-body">
            <div class="pay-line1">
              ${line1Label}
              ${showAmount ? `<span class="pay-amt pay-amt--${amtKind}">${amountText}</span>` : ""}
            </div>
            ${line2 || _voidNote ? `<div class="pay-line2">${_voidNote}${line2}</div>` : ""}
          </div>
        </div>
      `;
    });

    container.innerHTML = logsHtml;
    // Refresh callback re-fetches rather than patching the DOM: the server
    // is the only place that knows the snapped price, the new balance and
    // whether a concurrent edit won, so re-reading is the only way the row
    // on screen is guaranteed to match what was actually stored.
    _wireAddonRows(container, roomNumber, () => {
      if (typeof window.invalidatePayHistoryCache === "function") {
        window.invalidatePayHistoryCache(roomNumber);
      }
      this.updatePaymentLogs(roomNumber);
      if (typeof window.refreshRoomsData === "function") {
        window.refreshRoomsData();          // balance changed on the room card
      }
    });
  }

  // The header button that used to live here is gone. Correcting a payment or
  // a service is now a tap on the row itself (see _wireAddonRows), so the
  // operator points at the line they want instead of opening an editor and
  // hunting for it. The slot is cleared on every render so a stale button
  // from a cached page cannot survive a redeploy.
  _renderPaymentEditButton(roomNumber) {
    const slot = document.getElementById("checkout-payment-edit-slot");
    if (slot) slot.innerHTML = "";
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// TAP A PAYMENT ROW TO CORRECT IT
// ═══════════════════════════════════════════════════════════════════════════
//
// Every row in Payment History is a tap target, and all of them open the
// SAME Payment Records modal the Register and Bills tabs use
// (window.openRegisterPaymentsModal). One editor, one set of rules, one place
// to fix a bug — rather than a second editor here that would drift away from
// it. The old "Edit payments" header button is gone: the operator now points
// at the line they want instead of opening an editor and hunting for it.
//
// That modal handles both kinds of row. Receipts (cash / online) keep their
// existing date / mode / amount form. Service rows get an item / unit price /
// quantity form plus an "Add service" panel, because a service is a charge
// and its amount is a consequence of the item and the quantity — editing the
// amount alone would produce a line that contradicts itself ("Water 2L ₹30").
//
// RBAC (payment.edit, admin-only) is enforced inside the modal and again on
// the server. The check here only decides whether to show a tap affordance.

function _esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function _canEditAddons() {
  return !!(
    window.CibaraAuth &&
    typeof window.CibaraAuth.userCan === "function" &&
    window.CibaraAuth.userCan("payment.edit")
  );
}

// Corrections are for stays in progress. Once a guest is checked out an
// invoice number exists and changing a charge is a credit-note amendment,
// which this flow does not do. The server enforces the same rule.
function _stayIsActive(roomNumber) {
  if (typeof rooms === "undefined" || roomNumber == null) return false;
  const r = rooms[roomNumber];
  return !!(r && r.status === "occupied" && r.guest);
}

// The single source of truth for "can this row be opened". The row renderer
// asks the SAME question before adding the tap affordance — they used to
// differ (the renderer checked occupied+guest, the wiring additionally needed
// active_bill_id), so a legacy stay without active_bill_id got a pointer
// cursor, a hover state, role="button" and a focus ring on every row, and
// then did nothing at all when tapped.
function _payRowsOpenable(roomNumber) {
  if (!_canEditAddons() || !_stayIsActive(roomNumber)) return false;
  const roomInfo =
    typeof rooms !== "undefined" && roomNumber != null ? rooms[roomNumber] : null;
  return !!(roomInfo && roomInfo.active_bill_id);
}

// Replaced on every render so the close-observer always refreshes the room
// the operator is actually looking at.
let _payRefreshCb = null;

function _wireAddonRows(container, roomNumber, onChanged) {
  const roomInfo =
    typeof rooms !== "undefined" && roomNumber != null ? rooms[roomNumber] : null;
  const stayId = roomInfo && roomInfo.active_bill_id;
  if (!stayId) return;

  const open = () => {
    if (typeof window.openRegisterPaymentsModal !== "function") {
      alert("Payment editor isn't ready yet — open the Register tab once, then try again.");
      return;
    }
    // Refresh this list when the modal closes, so a correction made in there
    // is reflected behind it instead of leaving a stale row on screen.
    //
    // Two things this has to get right, both of which the first version got
    // wrong:
    //
    //   * WHICH ROOM. #rp-overlay is a singleton created once, so a
    //     bind-once-per-element guard bound the FIRST room's callback and
    //     kept it forever. Opening room 202 afterwards refreshed room 101 —
    //     writing 101's history into the panel showing 202, and never
    //     clearing 202's cache. The current callback is now stored on the
    //     module and replaced on every open, so the observer always runs the
    //     latest one.
    //
    //   * WHEN. Firing on "does not have .show" ran on ANY class write to the
    //     overlay, each one costing a cache flush and a /get_history round
    //     trip. It now fires only on a real shown -> hidden edge.
    const ov = document.getElementById("rp-overlay");
    if (ov && typeof onChanged === "function") {
      _payRefreshCb = onChanged;
      if (!ov.dataset.txnRefreshBound) {
        ov.dataset.txnRefreshBound = "1";
        let _wasShown = ov.classList.contains("show");
        new MutationObserver(() => {
          const nowShown = ov.classList.contains("show");
          if (_wasShown && !nowShown && typeof _payRefreshCb === "function") {
            _payRefreshCb();
          }
          _wasShown = nowShown;
        }).observe(ov, { attributes: true, attributeFilter: ["class"] });
      }
    }
    window.openRegisterPaymentsModal({
      id: stayId,
      stay_id: stayId,
      room: roomNumber,
      guest_name: (roomInfo.guest && roomInfo.guest.name) || "",
      checkin_time: roomInfo.checkin_time || "",
      // The modal's Services section reads entry.services. The Register tab
      // fills this from the room doc server-side; opening from here it has to
      // be passed explicitly, or the section renders "No services on this
      // stay" for a room that plainly has some.
      services: roomInfo.add_ons || [],
    });
  };

  container.querySelectorAll(".txn-payrow-tappable").forEach((row) => {
    row.addEventListener("click", open);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
  });
}

const transactionTrackingStyles = `
    /* ── Tappable service row (add-on correction) ───────────────────────── */
    .pay-row.txn-payrow-tappable {
        cursor: pointer; position: relative;
        border-radius: 10px; transition: background .12s ease;
    }
    .pay-row.txn-payrow-tappable:hover   { background: #f8fafc; }
    .pay-row.txn-payrow-tappable:active  { background: #f1f5f9; }
    .pay-row.txn-payrow-tappable:focus-visible {
        outline: 2px solid #3182ce; outline-offset: 2px;
    }
    /* Voided rows stay visible — struck through, not hidden, so the stay's
       history is complete and a removal is never invisible. */
    .pay-row.txn-row-voided .pay-title,
    .pay-row.txn-row-voided .pay-amt { text-decoration: line-through; opacity: .55; }
    .pay-row.txn-row-voided .pay-icon { opacity: .45; }
    .pay-badge--voided { background: #fee2e2; color: #b91c1c; }

    }

    /* ── Actionable expense row ──────────────────────────────────────────
       Rows the current user may edit or delete. The whole row is the tap
       target now that the inline pen/bin buttons are gone. */
    .log-item.txn-row-actionable { cursor: pointer; }
    .log-item.txn-row-actionable:hover { filter: brightness(0.97); }
    .log-item.txn-row-actionable:focus-visible {
        outline: 2px solid #3182ce; outline-offset: -2px;
    }
    /* Controls that still live inside a row (attach photo, view photo,
       print) must not inherit the row's pointer affordance. */
    .log-item.txn-row-actionable a,
    .log-item.txn-row-actionable button { cursor: pointer; }

    /* ── Stay-link payment row ───────────────────────────────────────────
       Non-expense rows link to their stay in the Register. Same affordance
       language as the actionable expense rows. */
    .log-item.txn-row-staylink { cursor: pointer; }
    .log-item.txn-row-staylink:hover { filter: brightness(0.97); }
    .log-item.txn-row-staylink:focus-visible {
        outline: 2px solid #3182ce; outline-offset: -2px;
    }
    .log-item.txn-row-staylink a,
    .log-item.txn-row-staylink button { cursor: pointer; }

    /* ── Expense action sheet ────────────────────────────────────────────
       Bottom sheet on phones, centred card on wide screens. Replaces the
       per-row buttons; delete confirms inline rather than via a native
       confirm() dialog, which is easier to hit on mobile and keeps the
       whole interaction in one surface. */
    .txn-sheet-backdrop {
        position: fixed; inset: 0; z-index: 4000;
        background: rgba(15, 23, 42, 0.45);
        display: none; align-items: flex-end; justify-content: center;
    }
    .txn-sheet-backdrop.open { display: flex; }
    .txn-sheet {
        width: 100%; max-width: 460px;
        background: #fff;
        border-radius: 16px 16px 0 0;
        padding: 0 0 max(10px, env(safe-area-inset-bottom));
        box-shadow: 0 -8px 30px rgba(0,0,0,.22);
        animation: txn-sheet-up .18s ease-out;
    }
    @keyframes txn-sheet-up {
        from { transform: translateY(14px); opacity: .6; }
        to   { transform: translateY(0);    opacity: 1; }
    }
    .txn-sheet-grip {
        width: 38px; height: 4px; border-radius: 999px;
        background: #cbd5e1; margin: 9px auto 4px;
    }
    .txn-sheet-head {
        padding: 6px 18px 12px; border-bottom: 1px solid #f1f5f9;
    }
    .txn-sheet-title {
        font: 700 .95rem 'Inter', system-ui, sans-serif; color: #0f172a;
        word-break: break-word;
    }
    .txn-sheet-sub {
        font: 500 .78rem 'Inter', system-ui, sans-serif; color: #64748b;
        margin-top: 2px;
    }
    .txn-sheet-actions { padding: 6px 10px 4px; }
    .txn-sheet-btn {
        display: flex; align-items: center; gap: 11px;
        width: 100%; border: none; background: none;
        padding: 13px 12px; border-radius: 10px;
        font: 600 .9rem 'Inter', system-ui, sans-serif;
        color: #1e293b; cursor: pointer; text-align: left;
    }
    .txn-sheet-btn:hover  { background: #f1f5f9; }
    .txn-sheet-btn:active { background: #e2e8f0; }
    .txn-sheet-btn i { width: 18px; text-align: center; font-size: .95rem; }
    .txn-sheet-btn.danger  { color: #b91c1c; }
    .txn-sheet-btn.danger:hover { background: #fef2f2; }
    .txn-sheet-btn.cancel  { color: #64748b; justify-content: center; }
    .txn-sheet-btn[disabled] { opacity: .55; cursor: wait; }
    .txn-sheet-sep { height: 1px; background: #f1f5f9; margin: 4px 12px; }
    .txn-sheet-confirm {
        padding: 12px 18px 6px;
        font: 500 .82rem 'Inter', system-ui, sans-serif; color: #7f1d1d;
        background: #fef2f2; border-top: 1px solid #fee2e2;
    }
    @media (min-width: 640px) {
        .txn-sheet-backdrop { align-items: center; }
        .txn-sheet { border-radius: 16px; }
    }

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

    /* ── Payment-history cards (redesigned list) ───────────────────────── */
    #checkout-payment-logs { display: flex; flex-direction: column; gap: 8px; }

    .pay-row {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        padding: 11px 13px;
        background: #fff;
        border: 1px solid #edeff3;
        border-radius: 12px;
        box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
    }

    .pay-icon {
        flex: 0 0 auto;
        width: 38px;
        height: 38px;
        border-radius: 10px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 0.95rem;
    }
    .pay-icon--in      { background: #ecfdf3; color: #067647; }
    .pay-icon--cash    { background: #ecfdf3; color: #067647; }
    .pay-icon--online  { background: #eff8ff; color: #175cd3; }
    .pay-icon--addon   { background: #fffaeb; color: #b54708; }
    .pay-icon--refund  { background: #fef3f2; color: #b42318; }
    .pay-icon--shift   { background: #f0fdfa; color: #0f766e; }
    .pay-icon--booking { background: #eef4ff; color: #3538cd; }

    .pay-body { flex: 1 1 auto; min-width: 0; }

    .pay-line1 {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
    }
    .pay-title {
        font: 600 0.92rem 'Inter', system-ui, sans-serif;
        color: #1a1a2e;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .pay-amt {
        font: 700 0.95rem 'Inter', system-ui, sans-serif;
        white-space: nowrap;
    }
    .pay-amt--in     { color: #067647; }
    .pay-amt--addon  { color: #b54708; }
    .pay-amt--refund { color: #b42318; }

    .pay-line2,
    .pay-line3 {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        margin-top: 5px;
    }

    /* The night an Extra Bed / AC charge was billed to — the "for which
       date" the operator asked to see, made prominent. */
    .pay-for {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 9px;
        border-radius: 999px;
        background: #fff4e5;
        color: #b54708;
        border: 1px solid #fde3c0;
        font: 700 0.72rem 'Inter', system-ui, sans-serif;
    }
    .pay-for i { font-size: 0.68rem; }

    .pay-badge {
        display: inline-flex;
        align-items: center;
        padding: 2px 9px;
        border-radius: 999px;
        font: 700 0.68rem 'Inter', system-ui, sans-serif;
    }
    .pay-badge--cash    { background: #ecfdf3; color: #067647; }
    .pay-badge--online  { background: #eff8ff; color: #175cd3; }
    .pay-badge--balance { background: #fef9c3; color: #854d0e; }

    /* Promoted pill used as the row label for plain cash/online rows. */
    .pay-lead .pay-badge {
        font-size: 0.78rem;
        padding: 3px 11px;
    }

    .pay-when {
        font: 500 0.74rem 'Inter', system-ui, sans-serif;
        color: #667085;
    }

    /* Shrink the whole payment-history card on phones — always 2 lines
       (title+amount, then badges/date), just with less padding and
       smaller type so each entry takes less vertical space. */
    @media (max-width: 480px) {
        #checkout-payment-logs { gap: 6px; }
        .pay-row { gap: 9px; padding: 8px 10px; }
        .pay-icon { width: 30px; height: 30px; font-size: 0.8rem; border-radius: 8px; }
        .pay-title { font-size: 0.82rem; }
        .pay-amt { font-size: 0.85rem; }
        .pay-line2 { gap: 5px; margin-top: 3px; }
        .pay-for, .pay-badge { font-size: 0.62rem; padding: 1px 7px; }
        .pay-lead .pay-badge { font-size: 0.72rem; padding: 2px 9px; }
        .pay-when { font-size: 0.68rem; }
        .txn-added-by { font-size: 0.62rem; padding: 1px 6px; }
    }
`;

function addTransactionTrackingStyles() {
  const styleSheet = document.createElement("style");
  styleSheet.textContent = transactionTrackingStyles;
  document.head.appendChild(styleSheet);
}

// ── Print the attached invoice / receipt photo ──────────────────────────────
function _escExpHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function _buildPhotoPrintHtml(url) {
  // Print JUST the photo the user attached — scaled to fill the page while
  // fitting on it. No header, tables, or voucher chrome.
  return `<!DOCTYPE html><html><head><meta charset="utf-8" />
    <title>Invoice photo</title>
    <style>
      @page { margin: 8mm; }
      html, body { margin: 0; padding: 0; height: 100%; }
      .wrap { width: 100%; height: 100%; display: flex; align-items: flex-start; justify-content: center; }
      img { max-width: 100%; max-height: 98vh; object-fit: contain; }
    </style></head>
    <body><div class="wrap"><img src="${_escExpHtml(url)}" alt="Invoice photo" /></div></body></html>`;
}
// Print via a hidden iframe (no pop-up window, so it isn't blocked). Waits for
// the photo to load before printing, with a safety timeout.
function _printExpensePhoto(log) {
  const url = log && log.invoice_photo_url;
  if (!url) return;
  const html = _buildPhotoPrintHtml(url);
  const existing = document.getElementById("txn-exp-print-frame");
  if (existing) existing.remove();
  const ifr = document.createElement("iframe");
  ifr.id = "txn-exp-print-frame";
  ifr.setAttribute("aria-hidden", "true");
  ifr.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
  document.body.appendChild(ifr);
  const doc = ifr.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();
  const win = ifr.contentWindow;
  let printed = false;
  const doPrint = () => {
    if (printed) return;
    printed = true;
    try { win.focus(); win.print(); } catch (_e) { /* ignore */ }
  };
  const img = doc.querySelector("img");
  if (img && !img.complete) {
    img.addEventListener("load", doPrint);
    img.addEventListener("error", doPrint);
    setTimeout(doPrint, 2000); // safety net if the image is slow or blocked
  } else {
    setTimeout(doPrint, 250);
  }
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
    if (!docId) return null;
    // The "Last 3 days" / custom-range views render expenses from the
    // server-fetched txnExtendedLogs, NOT the today-only global `logs` cache.
    // Search the extended result first so editing a past-day expense works;
    // fall back to the global cache for the Today view.
    const sources = [];
    if (txnExtendedLogs && txnExtendedLogs.expenses) sources.push(txnExtendedLogs.expenses);
    if (typeof logs !== "undefined" && logs && logs.expenses) sources.push(logs.expenses);
    for (const arr of sources) {
      const hit = arr.find((l) => l._doc_id === docId);
      if (hit) return hit;
    }
    return null;
  }

  // ── Expense action sheet ───────────────────────────────────────────────────
  // Edit and Delete used to be two small buttons on every expense row. They
  // made each row busy and were a poor tap target on a phone. The row itself
  // is now the target and opens this sheet.
  //
  // Only rows the user may manage carry the data-exp-* attributes, so the
  // absence of a doc id is what makes a row inert — there is no separate
  // permission branch on tap. The server still authorises the DELETE, and the
  // check below the fold is a belt-and-braces guard, not the control.

  let _sheetEl = null;          // the backdrop; built once, reused
  let _sheetCtx = null;         // { docId, amount, description }

  function _buildSheet() {
    if (_sheetEl) return _sheetEl;
    const el = document.createElement("div");
    el.className = "txn-sheet-backdrop";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.innerHTML = `
      <div class="txn-sheet" role="menu">
        <div class="txn-sheet-grip"></div>
        <div class="txn-sheet-head">
          <div class="txn-sheet-title" data-sheet-title></div>
          <div class="txn-sheet-sub" data-sheet-sub></div>
        </div>
        <div class="txn-sheet-confirm" data-sheet-confirm style="display:none;">
          Delete this expense? This cannot be undone.
        </div>
        <div class="txn-sheet-actions">
          <button type="button" class="txn-sheet-btn" data-sheet-edit role="menuitem">
            <i class="fas fa-pen"></i> Edit expense
          </button>
          <button type="button" class="txn-sheet-btn danger" data-sheet-delete role="menuitem">
            <i class="fas fa-trash"></i> Delete expense
          </button>
          <div class="txn-sheet-sep"></div>
          <button type="button" class="txn-sheet-btn cancel" data-sheet-cancel>Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(el);

    // Backdrop click closes; clicks inside the card must not bubble out to it.
    el.addEventListener("click", function (ev) {
      if (ev.target === el) _closeSheet();
    });
    el.querySelector("[data-sheet-cancel]").addEventListener("click", _closeSheet);
    el.querySelector("[data-sheet-edit]").addEventListener("click", _sheetEdit);
    el.querySelector("[data-sheet-delete]").addEventListener("click", _sheetDelete);

    _sheetEl = el;
    return el;
  }

  // Reset the sheet to its default (unconfirmed) state.
  function _resetSheet(el) {
    const del = el.querySelector("[data-sheet-delete]");
    el.querySelector("[data-sheet-confirm]").style.display = "none";
    del.innerHTML = '<i class="fas fa-trash"></i> Delete expense';
    del.disabled = false;
    del.dataset.armed = "";
    el.querySelector("[data-sheet-edit]").disabled = false;
  }

  function _openExpenseActionSheet(row) {
    const docId = row.getAttribute("data-exp-doc-id");
    if (!docId) return;
    _sheetCtx = {
      docId,
      amount: row.getAttribute("data-exp-amount") || "0",
      description: row.getAttribute("data-exp-description") || "this expense",
    };
    const el = _buildSheet();
    _resetSheet(el);
    el.querySelector("[data-sheet-title]").textContent = _sheetCtx.description;
    el.querySelector("[data-sheet-sub]").textContent = "₹" + _sheetCtx.amount;
    el.classList.add("open");
    // Focus the first action so the sheet is operable from a keyboard.
    setTimeout(() => el.querySelector("[data-sheet-edit]").focus(), 0);
  }

  function _closeSheet() {
    if (_sheetEl) {
      _sheetEl.classList.remove("open");
      _resetSheet(_sheetEl);
    }
    _sheetCtx = null;
  }

  function _sheetEdit() {
    if (!_sheetCtx) return;
    const log = _findLogByDocId(_sheetCtx.docId);
    _closeSheet();
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
  }

  // Two-tap delete. The first tap arms and shows the warning strip; the second
  // commits. Kept inside the sheet rather than raising a native confirm() —
  // a blocking dialog on top of a bottom sheet reads badly on mobile.
  function _sheetDelete(ev) {
    if (!_sheetCtx || !_sheetEl) return;
    const btn = ev.currentTarget;

    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1";
      btn.innerHTML = '<i class="fas fa-trash"></i> Tap again to confirm';
      _sheetEl.querySelector("[data-sheet-confirm]").style.display = "block";
      return;
    }

    const canManage = window.CibaraAuth
      && typeof window.CibaraAuth.userCan === "function"
      && window.CibaraAuth.userCan("expense.manage");
    if (!canManage) {
      if (typeof showNotification === "function") {
        showNotification("Only admins can delete expenses", "error");
      }
      _closeSheet();
      return;
    }

    const docId = _sheetCtx.docId;
    btn.disabled = true;
    _sheetEl.querySelector("[data-sheet-edit]").disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Deleting…';

    apiFetch("/expense/" + encodeURIComponent(docId), { method: "DELETE" })
      .then((r) => r.json())
      .then((data) => {
        if (data && data.success) {
          _closeSheet();
          if (typeof showNotification === "function") {
            showNotification("Expense deleted", "success");
          }
          // Drop the row from the in-memory cache too, so the reconcile
          // below (and any render triggered by something else in the
          // meantime) does not put it back.
          try {
            if (typeof logs !== "undefined" && logs && Array.isArray(logs.expenses)) {
              logs.expenses = logs.expenses.filter((l) => l && l._doc_id !== docId);
            }
            if (txnExtendedLogs && Array.isArray(txnExtendedLogs.expenses)) {
              txnExtendedLogs.expenses =
                txnExtendedLogs.expenses.filter((l) => l && l._doc_id !== docId);
            }
          } catch (e) { /* cache shape differs — the reconcile still fixes it */ }

          // Animate the single row out instead of rebuilding the list. Falls
          // back to the old full refresh when the row is not on screen
          // (different filter, collapsed range, stale sheet).
          Promise.resolve(
            typeof window.txnRemoveExpenseRow === "function"
              ? window.txnRemoveExpenseRow(docId)
              : false,
          ).then((handled) => {
            if (handled && typeof window.reconcileTransactionsView === "function") {
              window.reconcileTransactionsView();
            } else if (typeof window.refreshTransactionsView === "function") {
              window.refreshTransactionsView();
            } else if (typeof debouncedFetchData === "function") {
              debouncedFetchData();
            }
          });
        } else {
          if (typeof showNotification === "function") {
            showNotification((data && data.message) || "Delete failed", "error");
          }
          _resetSheet(_sheetEl);
        }
      })
      .catch((err) => {
        console.error("delete expense error:", err);
        if (typeof showNotification === "function") {
          showNotification("Error: " + err.message, "error");
        }
        if (_sheetEl) _resetSheet(_sheetEl);
      });
  }

  // Row tap → sheet. Ignore taps that landed on a control the row still
  // hosts (attach photo, view photo, print) so those keep working.
  document.addEventListener("click", function (e) {
    if (!e.target || !e.target.closest) return;
    if (e.target.closest(".txn-sheet-backdrop")) return;   // clicks inside the sheet
    const row = e.target.closest(".log-item.txn-row-actionable");
    if (!row) return;
    if (e.target.closest("a, button, input, label, select")) return;
    e.preventDefault();
    _openExpenseActionSheet(row);
  });

  // Keyboard: Enter/Space opens the sheet on a focused row, Escape closes it.
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && _sheetEl && _sheetEl.classList.contains("open")) {
      _closeSheet();
      return;
    }
    if (e.key !== "Enter" && e.key !== " ") return;
    const row = e.target && e.target.closest
      ? e.target.closest(".log-item.txn-row-actionable")
      : null;
    if (!row) return;
    e.preventDefault();
    _openExpenseActionSheet(row);
  });

  // ── Payment row tap → jump to the stay in the Register ─────────────────────
  // Non-expense rows carry data-stay-* attributes (stamped by
  // renderEnhancedLogItem). Tapping one switches to the Register tab and asks
  // register.js to locate, scroll to and highlight that stay. Controls inside
  // the row (links, buttons) keep their own behaviour, exactly like the
  // expense action-sheet handler above.
  function _txnGoToRegisterStay(row) {
    const ref = {
      stayId: row.getAttribute("data-stay-id") || "",
      room:   row.getAttribute("data-stay-room") || "",
      guest:  row.getAttribute("data-stay-guest") || "",
      date:   row.getAttribute("data-stay-date") || "",
    };
    if (!ref.stayId && !(ref.room && ref.guest)) return;

    const _notify = (msg, kind) => {
      if (typeof showNotification === "function") showNotification(msg, kind || "warning");
    };

    // The Register tab can be hidden (hide_register_tab / Incognito) or
    // role-gated. If its nav entry isn't visible, don't navigate into a
    // hidden view — say so instead.
    const regNav = document.querySelector('.nav-item[data-tab="register"]');
    const navVisible =
      regNav && window.getComputedStyle(regNav).display !== "none";
    if (!navVisible) {
      _notify("The Register tab isn't available right now.");
      return;
    }
    if (!window.CibaraRegister ||
        typeof window.CibaraRegister.showStay !== "function") {
      _notify("Register isn't ready yet — please try again in a moment.");
      return;
    }

    regNav.click(); // normal tab switch (active classes, watchTab loader)
    window.CibaraRegister.showStay(ref).then((found) => {
      if (!found) {
        _notify(
          "Couldn't find that stay in the Register" +
          (ref.guest ? ` (${ref.guest}, Room ${ref.room})` : "") + ".",
        );
      }
    }).catch((err) => {
      console.warn("[txn→register] showStay failed:", err);
    });
  }

  document.addEventListener("click", function (e) {
    if (!e.target || !e.target.closest) return;
    const row = e.target.closest(".log-item.txn-row-staylink");
    if (!row) return;
    // Expense rows never carry .txn-row-staylink, but keep the same
    // control guard so photo links / print buttons inside a row still work.
    if (e.target.closest("a, button, input, label, select")) return;
    e.preventDefault();
    _txnGoToRegisterStay(row);
  });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    const row = e.target && e.target.closest
      ? e.target.closest(".log-item.txn-row-staylink")
      : null;
    if (!row) return;
    e.preventDefault();
    _txnGoToRegisterStay(row);
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

    // Only act on rows that look like expense rows. Every expense row carries
    // data-expense-row="1", which is set regardless of admin rights, so that
    // single attribute is the whole test. (It used to also sniff for the
    // inline edit/delete buttons; those no longer exist — the row itself is
    // the action target now.)
    const rows = document.querySelectorAll("#transaction-log .log-item");
    let visible = 0;
    let totalExpenseRows = 0;

    rows.forEach((row) => {
      const isExpense = row.dataset.expenseRow === "1";
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

  // The MutationObserver below watches DIRECT children of #transaction-log
  // only. The incremental splice helpers (txnInsertExpenseRow /
  // txnRemoveExpenseRow) mutate inside a .log-date-group, which is a subtree
  // change the observer never sees — so they call this explicitly. Widening
  // the observer to subtree:true instead would fire it on every row-level
  // attribute change the app makes.
  window._txnReapplySearch = _ensureSearchBarAndReapply;

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
      const picked = this.files[0];
      txnPhotoFile.value = "";  // reset for re-use
      if (!picked || !_pendingAttachDocId) return;

      if (picked.size > 5 * 1024 * 1024) {
        if (typeof showNotification === "function") showNotification("File too large. Max 5 MB.", "error");
        return;
      }

      // Same crop step as the expense form, so a receipt attached later from
      // the transaction row is stored the same way as one attached at entry.
      let file = picked;
      if (window.CibaraDocScan && typeof window.CibaraDocScan.scan === "function") {
        try {
          file = await window.CibaraDocScan.scan(picked);
        } catch (err) {
          console.error("[Txn] scan failed, using original:", err);
          file = picked;
        }
        if (!file) { _pendingAttachDocId = null; return; }   // cancelled
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

// Drop the cached history AND immediately start refilling it, without waiting
// for anyone to look at it.
//
// The problem this solves: correcting a service invalidates this cache, and
// the checkout modal's Payment History only re-reads it when the editor
// closes. So the operator saved a change, closed the editor, and then sat
// watching a spinner for a round trip that could have run while they were
// still reading the confirmation. Kicking the fetch off here means the data
// is normally already in the cache by the time the list re-renders.
//
// Fire-and-forget on purpose: the caller must not block on it, and a failure
// is harmless — the cache stays empty and the next read fetches normally.
window.prefetchPayHistory = function (roomNumber) {
  window.invalidatePayHistoryCache(roomNumber);
  try {
    const p = _startPayFetch(roomNumber);
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (e) {
    /* nothing to do — the next read will fetch */
  }
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
      const checkinDate = _localYMD(new Date(checkinTime));
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
    const today = _localYMD();
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

    transactionLog._lastHTML = null;   // this path bypasses the render cache
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

// Every write to txnActiveDateRange goes through here.
//
// Moving the list to a different day is the one thing that releases the
// expense-date lock (expense.js keeps new expenses pinned to the day the last
// one was saved on, so entering a back-dated batch doesn't silently jump back
// to today halfway through). Routing the writes through a setter means no call
// site can change the shown date and forget to release the lock.
function _setActiveDateRange(fromDate, toDate) {
  const prev = txnActiveDateRange || {};
  const next = { fromDate: fromDate || null, toDate: toDate || null };
  const changed =
    prev.fromDate !== next.fromDate || prev.toDate !== next.toDate;
  txnActiveDateRange = next;
  if (changed && typeof window.releaseExpenseDateLock === "function") {
    window.releaseExpenseDateLock();
  }
}

/**
 * The single day the Transactions list is currently showing, as "YYYY-MM-DD".
 *
 * Null when the view spans more than one day (Last 3 days, a custom range) or
 * is on the rolling default — in those cases there is no one viewed date and
 * the caller should fall back to today. Read by expense.js to decide what date
 * a new expense should open on.
 */
window.getTransactionsViewDate = function () {
  const r = txnActiveDateRange || {};
  return r.fromDate && r.fromDate === r.toDate ? r.fromDate : null;
};
let txnActiveType = "all"; // "all" | "cash" | "online" | "refunds" | "expenses"
// Expense sub-scope for the admin Daily/Report toggle on the Expense
// view. "daily" = drawer expenses (default — matches the non-admin
// view); "report" = report expenses; "all" = both.
let txnExpenseScope = "daily";
// Composable "GST only" sub-filter for the Expense view (admin). Independent of
// txnExpenseScope, so you can view e.g. "Report + GST". Filters the LIST only —
// the analytics cards keep reflecting every expense in the range.
let txnExpenseGstOnly = false;
let txnDateUnlocked = false; // true after manager password verified

// True if an expense log carries GST. Mirrors _carries_gst in routes/reports.py
// (the same rule the GST/ITC export uses): the has_gst flag, a positive
// gst_amount, or booking.com commission GST. Split legs each carry the
// denormalised has_gst, so every leg of a GST split matches.
function _expenseCarriesGst(log) {
  if (!log) return false;
  if (log.has_gst === true) return true;
  const g = parseFloat(log.gst_amount || 0) || 0;
  const c = parseFloat(log.commission_gst || 0) || 0;
  return g > 0 || c > 0;
}
let txnExtendedLogs = null; // cached logs from /get_transactions_range for current range

// Manager-only "any date" expense browsing (see /expenses/browse in
// routes/reports.py, gated by the expense.view permission). Non-null while
// a manager is looking at a custom expense date range outside the normal
// 3-day window. Deliberately scoped to expenses only — cash/online/refund/
// settlement buckets are always empty in this payload, so the Cash/UPI/
// Total-in analytics cards read ₹0 instead of leaking figures for dates a
// manager isn't otherwise allowed to browse.
let txnMgrExpenseLogs = null;

function _getDateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return _localYMD(d);
}

// Is fromDate covered by the /get_data cache?
// /get_data now fetches TODAY only — so only "today" is in the cache.
// Any range that starts before today must be fetched from /get_transactions_range.
function _isWithinCache(fromDate) {
  const today = _localYMD();
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

// Reflect the composable GST-only toggle state (green = active). The button
// lives inside #txn-expense-scope alongside Daily/Report/All but uses a distinct
// class, so _setExpenseScopeActive never touches it and vice-versa.
function _setGstToggleActive(on) {
  const btn = document.querySelector("#txn-expense-scope .txn-gst-btn");
  if (!btn) return;
  btn.style.background = on ? "#2e7d32" : "#fff";
  btn.style.color = on ? "#fff" : "#475569";
  btn.style.borderColor = on ? "#2e7d32" : "#c7d2fe";
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

  // Ensure the composable "GST only" toggle exists — whether #txn-expense-scope
  // came from the server-rendered HTML (which may predate this feature) or was
  // built just above. Idempotent: appended only when missing, so it shows up on
  // a hard-reload without needing an HTML redeploy.
  if (!el.querySelector(".txn-gst-btn")) {
    const sep = document.createElement("span");
    sep.setAttribute("aria-hidden", "true");
    sep.style.cssText =
      "width:1px;align-self:stretch;background:#e2e8f0;margin:2px 2px;";
    const gst = document.createElement("button");
    gst.type = "button";
    gst.className = "txn-gst-btn";
    gst.title = "Show only GST-bearing expenses";
    gst.textContent = "GST";
    gst.style.cssText =
      "padding:4px 13px;border:1px solid #c7d2fe;border-radius:6px;" +
      "font-size:0.78rem;font-weight:600;cursor:pointer;background:#fff;color:#475569;";
    el.appendChild(sep);
    el.appendChild(gst);
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

  // Wire the GST toggle once — tracked on the button itself (not the container's
  // data-wired), because the button may be appended AFTER the scope buttons were
  // already wired on an earlier render.
  const gstBtn = el.querySelector(".txn-gst-btn");
  if (gstBtn && !gstBtn.dataset.wired) {
    gstBtn.dataset.wired = "1";
    gstBtn.addEventListener("click", function () {
      txnExpenseGstOnly = !txnExpenseGstOnly;
      _setGstToggleActive(txnExpenseGstOnly);
      const { fromDate, toDate } = txnActiveDateRange;
      _triggerRender(fromDate, toDate);
    });
    _setGstToggleActive(txnExpenseGstOnly);
  }
  return el;
}

function _syncExpenseScopeVisibility() {
  const el = _ensureExpenseScopeEl();
  if (!el) return;
  el.style.display =
    _txnIsAdmin() && txnActiveType === "expenses" ? "flex" : "none";
}

// ── Manager-only expense date range (any date, expenses only) ────────────
// Admin already has the unclamped custom-range picker above, so this control
// is for managers specifically: it's hidden for admin/housekeeping via
// data-perm/data-hide-roles in index.html, and only shown by this function
// while the Expense type filter is active.
function _isMgrExpenseViewer() {
  const auth = window.CibaraAuth;
  return !!(
    auth && auth.userCan && auth.userCan("expense.view") && !_txnIsAdmin()
  );
}

function _resetMgrExpenseRange(renderToday) {
  txnMgrExpenseLogs = null;
  if (window._txnMgrExpPicker) window._txnMgrExpPicker.clear();
  if (renderToday) {
    const today = _localYMD();
    document
      .querySelectorAll(".txn-quick-btn")
      .forEach((b) => b.classList.remove("active"));
    const todayBtn = document.querySelector('.txn-quick-btn[data-range="today"]');
    if (todayBtn) todayBtn.classList.add("active");
    _triggerRender(today, today);
  }
}

// Returns true if it already triggered a render itself (caller should skip
// its own _triggerRender in that case, to avoid a redundant double-fetch).
function _syncMgrExpenseRangeVisibility() {
  const el = document.getElementById("txn-mgr-expense-range");
  if (!el || !_isMgrExpenseViewer()) return false;
  const shouldShow = txnActiveType === "expenses";
  el.style.display = shouldShow ? "flex" : "none";
  // Leaving the Expense filter while a custom manager range was active —
  // snap back to Today rather than silently re-fetching a wide range
  // through the clamped /get_transactions_range endpoint.
  if (!shouldShow && txnMgrExpenseLogs) {
    _resetMgrExpenseRange(true);
    return true;
  }
  return false;
}

/**
 * A range load failed.
 *
 * On a normal load there is nothing on screen worth keeping, so the error
 * replaces the list. On a QUIET load (a background reconcile behind a list
 * that is already correct — e.g. right after an expense was spliced in) the
 * rows on screen are still the best thing available, so the error goes to a
 * toast instead. Replacing them would throw away good data because a refresh
 * nobody asked for happened to fail.
 */
function _txnLoadFailed(logEl, quiet, serverMsg, fallbackMsg) {
  const msg = serverMsg || fallbackMsg;
  if (quiet) {
    if (typeof showNotification === "function") {
      showNotification("Could not refresh: " + msg, "error");
    }
    return;
  }
  if (!logEl) return;
  logEl._lastHTML = null;   // direct write — invalidate the render cache
  logEl.innerHTML =
    '<div class="empty-state" style="padding:2rem;text-align:center;">' +
    '<i class="fas fa-exclamation-triangle fa-2x" style="color:var(--warning);' +
    'margin-bottom:0.75rem;display:block;"></i><p>' +
    String(msg).replace(/[<&>]/g, (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;" }[c])) +
    "</p></div>";
}

// `quiet` — see _triggerRender.
async function _loadMgrExpenseRange(from, to, quiet) {
  const logEl = document.getElementById("transaction-log");
  if (logEl && !quiet) {
    logEl._lastHTML = null;   // direct write — invalidate the render cache
    logEl.innerHTML = `<div class="loading-indicator"><span class="loader"></span><p>Loading expenses…</p></div>`;
  }
  try {
    const res = await apiFetch("/expenses/browse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start_date: from, end_date: to }),
    });
    const data = await res.json();
    if (data.success) {
      txnMgrExpenseLogs = {
        cash: [], online: [], refunds: [], settlements: [],
        expenses: data.expense_logs || [],
      };
      _setActiveDateRange(from, to);
      txnExtendedLogs = txnMgrExpenseLogs;
      _renderWithLogs(from, to, txnMgrExpenseLogs);
    } else {
      _txnLoadFailed(logEl, quiet, data && data.message, "Failed to load expenses.");
    }
  } catch (e) {
    _txnLoadFailed(logEl, quiet, null, "Network error: " + e.message);
  }
}

// Same picker style as the admin custom-range (flatpickr range mode over a
// txn-date-range-input), just wired to /expenses/browse instead of
// /get_transactions_range. Skips init entirely for non-managers so we don't
// waste cycles on an invisible widget (mirrors the admin _isAdmin guard).
function _wireMgrExpenseRange() {
  const el = document.getElementById("txn-mgr-expense-range");
  if (!el || el.dataset.wired) return;
  if (!_isMgrExpenseViewer()) return;
  el.dataset.wired = "1";
  const input = document.getElementById("txn-mgr-exp-range-input");
  if (!input || !window.flatpickr) return;
  window._txnMgrExpPicker = flatpickr(input, {
    mode: "range",
    dateFormat: "Y-m-d",
    altInput: true,
    altFormat: "d-m-Y",
    maxDate: _localYMD(),
    disableMobile: true,
    onChange: function (selectedDates) {
      if (selectedDates.length === 2) {
        const from = _localYMD(selectedDates[0]);
        const to = _localYMD(selectedDates[1]);
        document
          .querySelectorAll(".txn-quick-btn")
          .forEach((b) => b.classList.remove("active"));
        _loadMgrExpenseRange(from, to);
      }
    },
  });
}

// `quiet` = this is a reconcile behind an already-correct list (an expense was
// just spliced in or out locally). Leave the current rows on screen while the
// fetch runs instead of flashing a spinner over content that is already right.
async function _triggerRender(fromDate, toDate, quiet) {
  _setActiveDateRange(fromDate, toDate);
  txnExtendedLogs = null;

  // If range is within the 3-day cache, use it directly — no extra network call
  if (_isWithinCache(fromDate)) {
    _renderWithLogs(fromDate, toDate, null);
    return;
  }

  // Extended range — fetch from server
  const logEl = document.getElementById("transaction-log");
  if (logEl && !quiet) {
    logEl._lastHTML = null;   // direct write — invalidate the render cache
    logEl.innerHTML = `<div class="loading-indicator"><span class="loader"></span><p>Loading transactions…</p></div>`;
  }

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
      _txnLoadFailed(logEl, quiet, data && data.message, "Failed to load data.");
    }
  } catch (e) {
    _txnLoadFailed(logEl, quiet, null, "Network error: " + e.message);
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
  const today = _localYMD();
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
  const todayStr = _localYMD();
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
      altFormat: "d-m-Y",
      defaultDate: [todayStr, todayStr],
      maxDate: todayStr,
      disableMobile: true,
      onChange: function (selectedDates) {
        if (selectedDates.length === 2) {
          const from = _localYMD(selectedDates[0]);
          const to = _localYMD(selectedDates[1]);
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

      // Today / Last 3 days always means the normal clamped view — drop
      // any manager custom expense range that was active.
      if (txnMgrExpenseLogs) _resetMgrExpenseRange(false);

      const range = this.dataset.range;
      const today = _localYMD();
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
      const alreadyRendered = _syncMgrExpenseRangeVisibility();
      if (alreadyRendered) return;
      const { fromDate, toDate } = txnActiveDateRange;
      _triggerRender(fromDate, toDate);
    });
  });

  // ── Expense Daily/Report/All sub-filter (admin only) ──────────────────────
  // _syncExpenseScopeVisibility builds + wires the toggle on first call,
  // so it works even if the loaded index.html predates the control.
  _syncExpenseScopeVisibility();

  // ── Manager-only "any date" expense range ─────────────────────────────────
  _wireMgrExpenseRange();
  _syncMgrExpenseRangeVisibility();

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

// Refresh the Transactions view after a LOCAL add / edit / delete. For an
// extended (past) date range the server result must be re-fetched —
// debouncedFetchData only refreshes today's cache, so the displayed list (read
// from txnExtendedLogs) would otherwise keep showing the pre-edit data.
// Exposed globally so expense.js (add/edit) and the delete handler both use it.
// `quiet` = keep the current rows on screen during the fetch (used by
// reconcileTransactionsView after a local splice, where the list is already
// showing the right thing and a spinner would be a step backwards).
window.refreshTransactionsView = function (quiet) {
  const r = txnActiveDateRange || {};
  // A manager's custom expense range must re-pull via /expenses/browse —
  // not /get_transactions_range, which would silently clamp it back to
  // the last 3 days on refresh.
  if (r.fromDate && txnMgrExpenseLogs) {
    _loadMgrExpenseRange(r.fromDate, r.toDate, quiet);
  } else if (r.fromDate && !_isWithinCache(r.fromDate)) {
    txnExtendedLogs = null;            // force a fresh server pull
    _triggerRender(r.fromDate, r.toDate, quiet);
  } else if (typeof debouncedFetchData === "function") {
    debouncedFetchData();              // Today view — refresh the cache
  }
};

// Jump the Transactions view so a specific date's rows are on screen. Used by
// the Staff payroll flow after a salary is recorded with a back-dated
// "paid on": the expense row lands on THAT day (staff_service dates it to
// paid_on), and staying on today's list made the payment look like it
// vanished. The range is [date, today] rather than the single day, so
// today's drawer context never disappears — the new row is visible AND the
// operator is still looking at now.
window.goToTransactionDate = function (dateStr) {
  try {
    const today = _localYMD();
    let d = String(dateStr || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d > today) d = today;

    // Non-admins have no date picker and the server clamps extended ranges
    // for them — a jump they can't express falls back to a plain refresh.
    const _auth = window.CibaraAuth;
    const _isAdmin = !!(_auth && _auth.isAdmin && _auth.isAdmin());
    if (!_isAdmin && !_isWithinCache(d)) {
      if (typeof window.refreshTransactionsView === "function") {
        window.refreshTransactionsView();
      }
      return;
    }

    // Same steps a manual picker change performs (see the onChange handler):
    // drop any manager custom range, clear quick-button state, sync the
    // picker, and force a fresh pull so the just-written row is included.
    if (txnMgrExpenseLogs) _resetMgrExpenseRange(false);
    document.querySelectorAll(".txn-quick-btn")
      .forEach((b) => b.classList.remove("active"));
    if (window._txnPicker) window._txnPicker.setDate([d, today]);
    txnExtendedLogs = null;
    _triggerRender(d, today);
  } catch (e) {
    console.warn("[txn] goToTransactionDate failed:", e);
    if (typeof window.refreshTransactionsView === "function") {
      window.refreshTransactionsView();
    }
  }
};

// ─── Incremental list mutation ───────────────────────────────────────────────
// renderEnhancedLogs() rebuilds the whole list into innerHTML. That is fine for
// a filter change, but an operator adds and deletes expenses constantly, and
// for one row it means every other row is destroyed and recreated: a visible
// flicker, and the eye loses the row it was looking at.
//
// These two helpers splice a single row in or out of the already-rendered DOM
// and patch only the numbers that actually moved. Both are deliberately narrow:
// they handle expense rows on a day group that is already on screen and bail out
// (returning false) for anything else, so the caller falls back to the full
// render it used to do. A narrow fast path that is always correct beats a broad
// one that is sometimes wrong about totals.
//
// What an expense row does and does not affect:
//   .log-date-total and the per-day Cash/UPI/Fresh/Continue meta EXCLUDE
//   expenses (see the dayTotal reduce in renderEnhancedLogs), so the day header
//   never changes. Of the four summary tiles only EXPENSES moves — TOTAL IN is
//   cash + UPI − refunds and does not net off expenses.
const TXN_ROW_ANIM_MS = 220;

function _txnStyleOnce() {
  if (document.getElementById("txn-row-anim-styles")) return;
  const st = document.createElement("style");
  st.id = "txn-row-anim-styles";
  st.textContent = [
    ".log-item.txn-row-animating{overflow:hidden;}",
    "@keyframes txnRowFlash{0%{box-shadow:inset 3px 0 0 #f6ad55;}",
    "100%{box-shadow:inset 3px 0 0 rgba(246,173,85,0);}}",
    ".log-item.txn-row-flash{animation:txnRowFlash 1.1s ease-out 1;}",
    "@media (prefers-reduced-motion: reduce){",
    ".log-item.txn-row-flash{animation:none;}}",
  ].join("");
  document.head.appendChild(st);
}

// Grow a freshly inserted row from zero height to its natural height.
function _txnAnimateIn(row) {
  _txnStyleOnce();
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }
  const target = row.scrollHeight;
  row.classList.add("txn-row-animating");
  row.style.height = "0px";
  row.style.opacity = "0";
  requestAnimationFrame(() => {
    row.style.transition =
      "height " + TXN_ROW_ANIM_MS + "ms ease-out, opacity " + TXN_ROW_ANIM_MS + "ms ease-out";
    row.style.height = target + "px";
    row.style.opacity = "1";
  });
  setTimeout(() => {
    row.classList.remove("txn-row-animating");
    row.style.height = "";
    row.style.opacity = "";
    row.style.transition = "";
  }, TXN_ROW_ANIM_MS + 40);
}

// Collapse a row to zero height, then detach it. Resolves once it is gone.
function _txnAnimateOut(row) {
  return new Promise((resolve) => {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      row.remove();
      resolve();
      return;
    }
    const h = row.offsetHeight;
    row.classList.add("txn-row-animating");
    row.style.height = h + "px";
    void row.offsetHeight;                     // force layout before transition
    row.style.transition =
      "height " + TXN_ROW_ANIM_MS + "ms ease-in, opacity " + TXN_ROW_ANIM_MS + "ms ease-in, " +
      "margin " + TXN_ROW_ANIM_MS + "ms ease-in, padding " + TXN_ROW_ANIM_MS + "ms ease-in";
    row.style.height = "0px";
    row.style.opacity = "0";
    row.style.marginTop = "0px";
    row.style.marginBottom = "0px";
    row.style.paddingTop = "0px";
    row.style.paddingBottom = "0px";
    setTimeout(() => { row.remove(); resolve(); }, TXN_ROW_ANIM_MS + 20);
  });
}

// Re-run the admin expense-search filter (and its "10/40" counter) after a
// splice. See window._txnReapplySearch for why this is not automatic.
function _txnAfterSplice() {
  if (typeof window._txnReapplySearch === "function") {
    try { window._txnReapplySearch(); } catch (e) { /* filter not active */ }
  }
}

// The list is empty now — restore the placeholder renderEnhancedLogs would
// have drawn, instead of leaving blank space until the reconcile lands.
function _txnShowEmptyState(listEl) {
  if (listEl.querySelector(".log-item")) return;
  if (listEl.querySelector(".empty-state")) return;
  const el = document.createElement("div");
  el.className = "empty-state";
  el.style.cssText = "padding: 2rem; text-align:center;";
  el.innerHTML =
    '<i class="fas fa-receipt fa-3x" style="opacity:0.4;margin-bottom:1rem;display:block;"></i>' +
    "<p>No transactions in this period</p>";
  listEl.appendChild(el);
}

// Find a rendered expense row by document id. Compared as a plain string
// rather than built into a selector: a doc id is opaque and a quote or
// backslash in one would turn a selector into a syntax error.
function _txnRowByDocId(listEl, docId) {
  const want = String(docId);
  const rows = listEl.querySelectorAll("[data-log-id], [data-exp-doc-id]");
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].getAttribute("data-log-id") === want ||
        rows[i].getAttribute("data-exp-doc-id") === want) {
      return rows[i];
    }
  }
  return null;
}

// Add `delta` to the EXPENSES summary tile without recomputing the range.
function _txnPatchExpenseTile(delta) {
  const el = document.getElementById("txn-card-expense");
  if (!el || !delta) return;
  const current = Number(String(el.textContent || "").replace(/[^0-9.-]/g, "")) || 0;
  const next = Math.max(0, current + delta);
  el.textContent = "₹" + next.toLocaleString("en-IN");
}

// Would the current filter state show this expense at all? Mirrors the
// filtering inside renderEnhancedLogs. Returns false for anything the fast
// path should not try to handle.
function _txnExpenseVisibleNow(log) {
  if (!log || !log.date) return false;
  const type = typeof txnActiveType === "string" ? txnActiveType : "all";
  if (type !== "all" && type !== "expenses") return false;
  const scope = typeof txnExpenseScope === "string" ? txnExpenseScope : "daily";
  const isReport = log.expense_type === "report";
  if (scope === "report" && !isReport) return false;
  if (scope === "daily" && isReport) return false;
  if (txnExpenseGstOnly && !_expenseCarriesGst(log)) return false;
  return true;
}

/**
 * Splice a newly-saved expense into the rendered list.
 *
 * @returns {boolean} true if the row was inserted incrementally; false if the
 *   caller should fall back to a full renderEnhancedLogs().
 */
window.txnInsertExpenseRow = function (log) {
  try {
    const listEl = document.getElementById("transaction-log");
    if (!listEl || !log || !log.date) return false;
    // Empty state on screen, or a day group that does not exist yet (the
    // day's first row): there is no group to splice into.
    const group = listEl.querySelector(
      '.log-date-group[data-log-group="' + log.date + '"]');
    if (!group) return false;
    if (!_txnExpenseVisibleNow(log)) return false;
    if (log._doc_id && _txnRowByDocId(listEl, log._doc_id)) {
      return true;   // already on screen (a sync push beat us to it)
    }

    // Keep the extended-range cache in step with `logs`. expense.js pushes
    // into `logs.expenses`, but a past-date range renders from
    // txnExtendedLogs — without this the very next render (including the
    // signature pass below) would compute the list WITHOUT the new row and
    // undo both the splice and the tile patch.
    if (txnExtendedLogs && Array.isArray(txnExtendedLogs.expenses) &&
        !txnExtendedLogs.expenses.some((l) => l && l._doc_id === log._doc_id)) {
      txnExtendedLogs.expenses.push(log);
    }

    const html = transactionLogManager.renderEnhancedLogItem(log, "expenses", 0);
    const tmp = document.createElement("div");
    tmp.innerHTML = html.trim();
    const row = tmp.firstElementChild;
    if (!row) return false;

    // Rows inside a group run newest-first by time. Find the first existing
    // row whose time is earlier and insert above it.
    // Rows inside a group run newest-first by time, and the full render's
    // sort is stable, so equal times keep the order the buckets were
    // concatenated in: cash, online, refunds, expenses, settlements. Expense
    // times are minute-resolution, so ties are common — insert AFTER any
    // same-time row from an earlier bucket, or the spliced order would differ
    // from the rendered order and never get corrected.
    // Mirror renderEnhancedLogs' comparator exactly: date, then time
    // descending, then serial_number descending — and, for a full tie, the
    // stable sort leaves the buckets in concat order (cash, online, refunds,
    // expenses, settlements).
    //
    // This has to match, because txnMarkListSynced records the string the
    // full render WOULD produce as "what the DOM shows". A splice that puts
    // the row somewhere the renderer wouldn't is then locked in: the
    // reconcile regenerates that same string, sees no change, and skips.
    // Expense times are minute-resolution, so ties are routine.
    const t = String(log.time || "00:00:00");
    const mySerial = Number(log.serial_number) || 0;
    const BUCKET_ORDER = ["cash", "online", "refunds", "expenses", "settlement"];
    const myRank = BUCKET_ORDER.indexOf("expenses");
    const siblings = Array.from(group.children).filter(
      (el) => el.classList && el.classList.contains("log-item"));
    const before = siblings.find((el) => {
      const st = String(el.getAttribute("data-log-time") || "00:00:00");
      if (st !== t) return st < t;
      const ss = Number(el.getAttribute("data-log-serial")) || 0;
      if (ss !== mySerial) return ss < mySerial;
      const rank = BUCKET_ORDER.indexOf(el.getAttribute("data-log-type") || "");
      return rank > myRank;      // later bucket — the new row goes above it
    });
    if (before) group.insertBefore(row, before);
    else group.appendChild(row);

    _txnAnimateIn(row);
    _txnStyleOnce();
    row.classList.add("txn-row-flash");
    setTimeout(() => row.classList.remove("txn-row-flash"), 1300);

    _txnPatchExpenseTile(Number(log.amount) || 0);

    // If the group was collapsed, open it — otherwise the row the operator
    // just created animates into something they cannot see.
    const hdr = listEl.querySelector(
      '.log-date-header[data-log-date="' + log.date + '"]');
    if (hdr && hdr.classList.contains("collapsed")) {
      hdr.classList.remove("collapsed");
      const caret = hdr.querySelector(".log-date-caret");
      if (caret) caret.textContent = "▾";
      group.style.display = "";
    }
    _txnAfterSplice();
    window.txnMarkListSynced();
    return true;
  } catch (e) {
    console.warn("txnInsertExpenseRow fell back to full render:", e);
    return false;
  }
};

/**
 * Animate an expense row out of the rendered list.
 *
 * @returns {Promise<boolean>} resolves true if handled incrementally.
 */
window.txnRemoveExpenseRow = function (docId) {
  try {
    const listEl = document.getElementById("transaction-log");
    if (!listEl || !docId) return Promise.resolve(false);
    const row = _txnRowByDocId(listEl, docId);
    if (!row) return Promise.resolve(false);

    const amount = Number(row.getAttribute("data-exp-amount")) || 0;
    const group = row.closest(".log-date-group");

    return _txnAnimateOut(row).then(() => {
      _txnPatchExpenseTile(-amount);
      // Last row in the day? Drop the empty group and its header rather than
      // leaving a heading over nothing.
      if (group && !group.querySelector(".log-item")) {
        const date = group.getAttribute("data-log-group");
        const hdr = date && listEl.querySelector(
          '.log-date-header[data-log-date="' + date + '"]');
        if (hdr) hdr.remove();
        group.remove();
      }
      _txnShowEmptyState(listEl);
      _txnAfterSplice();
      window.txnMarkListSynced();
      return true;
    });
  } catch (e) {
    console.warn("txnRemoveExpenseRow fell back to full render:", e);
    return Promise.resolve(false);
  }
};

/**
 * Tell the renderer that the DOM currently on screen already matches the log
 * data — used right after an incremental splice.
 *
 * Without this, the reconcile that follows a splice regenerates HTML that now
 * includes the spliced row, sees it differs from the last string it wrote, and
 * rebuilds the whole list: the flicker the splice existed to avoid.
 */
window.txnMarkListSynced = function () {
  _txnDryRun = true;
  try {
    if (typeof window.renderEnhancedLogs === "function") window.renderEnhancedLogs();
  } catch (e) {
    // Could not compute a signature — fall back to letting the next render
    // rebuild. Correct, just not smooth.
    const el = document.getElementById("transaction-log");
    if (el) el._lastHTML = null;
  } finally {
    _txnDryRun = false;
  }
};

/**
 * Pull authoritative data from the server without stomping an animation that
 * is still running. The incremental helpers have already put the DOM in the
 * shape the server is about to confirm, so the refresh is only there to catch
 * anything the client could not know (server-side rounding, a concurrent edit
 * from another device). Delaying it past the animation makes the re-render
 * invisible instead of a flicker.
 */
window.reconcileTransactionsView = function (delayMs) {
  const wait = typeof delayMs === "number" ? delayMs : TXN_ROW_ANIM_MS + 200;
  clearTimeout(window.reconcileTransactionsView._t);
  window.reconcileTransactionsView._t = setTimeout(() => {
    if (typeof window.refreshTransactionsView === "function") {
      window.refreshTransactionsView(true);   // quiet — no loading spinner
    } else if (typeof debouncedFetchData === "function") {
      debouncedFetchData();
    }
  }, wait);
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

  // Lightweight refresh — used for remote payment *adds*, where google_sync.js
  // has already patched the in-memory `logs` cache (_patchLocalLogs) and
  // smooth-inserted the row. We only need to re-render from that patched cache.
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

  // Full refresh — used for remote *edits/deletes* (cibaraTransactionRevised)
  // and remote *expense adds*. The in-memory `logs` cache can't be patched
  // reliably for these (expenses aren't tracked by _patchLocalLogs, and we
  // don't have the pre-edit row to remove), so re-pull authoritative data from
  // the server for the active range.
  function _refreshTxnViewFull(dateStr) {
    if (dateStr && !_isDateInRange(dateStr)) return;
    const { fromDate, toDate } = txnActiveDateRange;
    if (!fromDate) return;

    // Always invalidate the extended-range cache so the next view re-fetches,
    // even if the tab is currently hidden.
    txnExtendedLogs = null;

    if (_isWithinCache(fromDate)) {
      // "Today" view renders from the global `logs` cache — refresh it from the
      // server. fetchData() re-renders the transactions list when it finishes.
      if (typeof debouncedFetchData === "function") debouncedFetchData(300);
      else if (typeof fetchData === "function") fetchData();
    } else {
      const txnTab = document.getElementById("transaction-tab");
      const tabVisible = txnTab && !txnTab.classList.contains("hidden");
      if (tabVisible) _triggerRender(fromDate, toDate);
    }
  }

  window.addEventListener("cibaraPaymentAdded", (e) => {
    const p = e.detail || {};
    if (p.date) _refreshTxnView(p.date);
  });

  // Expense adds need the full path — the lightweight cache patch doesn't
  // cover the `expenses` bucket, so a cache-only re-render would miss them.
  window.addEventListener("cibaraExpenseAdded", (e) => {
    const exp = e.detail || {};
    if (exp.date) _refreshTxnViewFull(exp.date);
  });

  // Remote edits and deletes to payments/expenses (from another device).
  window.addEventListener("cibaraTransactionRevised", (e) => {
    const d = e.detail || {};
    _refreshTxnViewFull(d.date || null);
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
