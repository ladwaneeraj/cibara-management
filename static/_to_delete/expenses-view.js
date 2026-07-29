/* ──────────────────────────────────────────────────────────────────────────
 * Manager Expense History view.
 *
 * Managers are normally clamped to the last MANAGER_VISIBLE_DAYS (3) days
 * on Transactions/Register/Bills (see services/role_filters.py). This is a
 * narrow, deliberate exception: a dedicated view that lets a manager browse
 * EXPENSES ONLY across any date range, backed by routes/reports.py's
 * /expenses/browse (@requires_permission("expense.view")). It never shows
 * cash/online/revenue/checkin figures — those stay inside the normal
 * 3-day window everywhere else.
 *
 * The date range is never pre-filled or auto-loaded: every time this modal
 * opens, the user is asked to pick a range first, then explicitly requests
 * the data. Nothing fetches on open.
 *
 * Built dynamically (same approach as staff.js / maintenance.js) so
 * index.html only carries the quick-action entry + this script tag.
 * Loaded with `defer` after auth.js, permissions.js and script.js.
 * ──────────────────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  var state = {
    step: "prompt",   // "prompt" | "results"
    startDate: "",
    endDate: "",
    loading: false,
    result: null,     // last /expenses/browse payload
  };

  // ── fetch helpers (same pattern as staff.js) ────────────────────────────

  function _fetch(url, opts) {
    return typeof apiFetch === "function" ? apiFetch(url, opts) : fetch(url, opts);
  }

  function api(url, opts) {
    return _fetch(url, opts)
      .then(function (res) { return res.json(); })
      .then(function (json) {
        if (!json.success) throw new Error(json.message || "Request failed");
        return json;
      });
  }

  function post(url, body) {
    return api(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  }

  function notify(msg, type) {
    if (typeof showNotification === "function") showNotification(msg, type || "info");
    else alert(msg);
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function rup(n) {
    var v = Math.round(Number(n) || 0);
    return "₹" + v.toLocaleString("en-IN");
  }

  function _todayStr() {
    var d = new Date();
    return d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }

  function _addDays(dateStr, n) {
    var d = new Date(dateStr + "T12:00:00");
    d.setDate(d.getDate() + n);
    return d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }

  function fmtD(dateStr) {
    if (!dateStr) return "—";
    try {
      return new Date(dateStr + "T12:00:00").toLocaleDateString("en-IN", {
        day: "numeric", month: "short", year: "numeric",
      });
    } catch (_) { return dateStr; }
  }

  function fmtCategory(cat) {
    var s = String(cat || "").trim();
    if (!s) return "Other";
    return s.split("_").map(function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(" ");
  }

  // ── modal shell ─────────────────────────────────────────────────────────

  function ensureModal() {
    if (document.getElementById("exv-modal")) return;
    var html =
      '<div class="modal-backdrop" id="exv-modal">' +
      '  <div class="modal-content" style="max-width:560px">' +
      '    <div class="modal-header">' +
      '      <h2><i class="fas fa-receipt" style="margin-right:8px;color:var(--primary)"></i>Expense History</h2>' +
      '      <button class="close-btn" id="exv-close-btn" aria-label="Close">&times;</button>' +
      "    </div>" +
      '    <div class="modal-body">' +
      '      <div id="exv-pane-prompt"></div>' +
      '      <div id="exv-pane-results" style="display:none"></div>' +
      "    </div>" +
      "  </div>" +
      "</div>";
    document.body.insertAdjacentHTML("beforeend", html);

    var modal = document.getElementById("exv-modal");
    modal.querySelector("#exv-close-btn").addEventListener("click", closeModal);
    modal.addEventListener("click", function (e) {
      if (e.target === modal) closeModal();
    });
  }

  function openModal() {
    ensureModal();
    // Always reset to the date-prompt step. Nothing is fetched or shown
    // until the user explicitly picks a range and asks for it — no
    // reuse of whatever range was last viewed.
    state.step = "prompt";
    state.startDate = "";
    state.endDate = "";
    state.result = null;
    renderPrompt();
    document.getElementById("exv-modal").classList.add("show");
  }

  function closeModal() {
    var m = document.getElementById("exv-modal");
    if (m) m.classList.remove("show");
  }

  // ── prompt step ─────────────────────────────────────────────────────────

  function renderPrompt() {
    var pane = document.getElementById("exv-pane-prompt");
    var results = document.getElementById("exv-pane-results");
    if (!pane) return;
    results.style.display = "none";
    pane.style.display = "";

    pane.innerHTML =
      '<div style="color:var(--text-secondary);font-size:0.85rem;margin-bottom:0.9rem;">' +
      "Pick a date range to view expenses. Only expense line items and totals show here — " +
      "no revenue, cash or UPI figures." +
      "</div>" +
      '<div class="date-presets" id="exv-presets">' +
      '  <button type="button" class="preset-btn" data-preset="today">Today</button>' +
      '  <button type="button" class="preset-btn" data-preset="week">Last 7 Days</button>' +
      '  <button type="button" class="preset-btn" data-preset="month">This Month</button>' +
      '  <button type="button" class="preset-btn" data-preset="last-month">Last Month</button>' +
      "</div>" +
      '<div class="analytics-date-row" style="margin-top:0.75rem;">' +
      '  <label class="analytics-date-lbl" for="exv-start-date">From</label>' +
      '  <input type="date" id="exv-start-date" class="analytics-date-inp" />' +
      '  <span class="analytics-date-sep">→</span>' +
      '  <label class="analytics-date-lbl" for="exv-end-date">To</label>' +
      '  <input type="date" id="exv-end-date" class="analytics-date-inp" />' +
      "</div>" +
      '<div style="margin-top:1rem;text-align:right;">' +
      '  <button type="button" id="exv-view-btn" class="btn-apply">' +
      '    <i class="fas fa-search"></i> View Expenses' +
      "  </button>" +
      "</div>";

    var startInp = document.getElementById("exv-start-date");
    var endInp = document.getElementById("exv-end-date");

    pane.querySelectorAll(".preset-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        pane.querySelectorAll(".preset-btn").forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        var today = _todayStr();
        var preset = btn.dataset.preset;
        if (preset === "today") {
          startInp.value = today; endInp.value = today;
        } else if (preset === "week") {
          startInp.value = _addDays(today, -6); endInp.value = today;
        } else if (preset === "month") {
          startInp.value = today.slice(0, 8) + "01"; endInp.value = today;
        } else if (preset === "last-month") {
          var d = new Date(today + "T12:00:00");
          d.setDate(1);
          d.setDate(0); // last day of previous month
          var lastMonthEnd = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
          var lastMonthStart = lastMonthEnd.slice(0, 8) + "01";
          startInp.value = lastMonthStart; endInp.value = lastMonthEnd;
        }
      });
    });

    // Picking a custom date manually deselects the presets.
    [startInp, endInp].forEach(function (inp) {
      inp.addEventListener("change", function () {
        pane.querySelectorAll(".preset-btn").forEach(function (b) { b.classList.remove("active"); });
      });
    });

    document.getElementById("exv-view-btn").addEventListener("click", function () {
      var s = startInp.value, e = endInp.value;
      if (!s || !e) { notify("Pick both a start and end date.", "error"); return; }
      if (s > e) { notify("Start date must be on or before end date.", "error"); return; }
      state.startDate = s;
      state.endDate = e;
      loadResults();
    });
  }

  // ── results step ────────────────────────────────────────────────────────

  function loadResults() {
    var btn = document.getElementById("exv-view-btn");
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading…'; }

    post("/expenses/browse", { start_date: state.startDate, end_date: state.endDate })
      .then(function (json) {
        state.result = json;
        state.step = "results";
        renderResults();
      })
      .catch(function (e) {
        notify(e.message, "error");
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-search"></i> View Expenses'; }
      });
  }

  function renderResults() {
    var pane = document.getElementById("exv-pane-results");
    var prompt = document.getElementById("exv-pane-prompt");
    if (!pane) return;
    prompt.style.display = "none";
    pane.style.display = "";

    var r = state.result || {};
    var logs = (r.expense_logs || []).slice().sort(function (a, b) {
      return (b.date || "").localeCompare(a.date || "");
    });

    var rowsHtml = logs.length
      ? logs.map(function (l) {
          return (
            '<div class="summary-row" style="align-items:flex-start;">' +
            '  <div class="summary-label">' +
            '    <div style="font-weight:600;">' + esc(l.description || fmtCategory(l.category)) + "</div>" +
            '    <div style="font-size:0.75rem;color:var(--text-secondary);">' +
            fmtD(l.date) + " · " + esc(fmtCategory(l.category)) +
            (l.payment_method ? " · " + esc(l.payment_method) : "") +
            "</div>" +
            "  </div>" +
            '  <div class="summary-value">' + rup(l.amount) + "</div>" +
            "</div>"
          );
        }).join("")
      : '<div style="padding:1rem 0;color:var(--text-secondary);text-align:center;">No expenses in this range.</div>';

    pane.innerHTML =
      '<div style="margin-bottom:0.75rem;">' +
      '  <button type="button" id="exv-back-btn" class="action-btn btn-sm">' +
      '    <i class="fas fa-arrow-left"></i> Change dates' +
      "  </button>" +
      "</div>" +
      '<div class="summary-card">' +
      '  <div class="summary-title">' +
      "    Expenses " + fmtD(state.startDate) + " → " + fmtD(state.endDate) +
      "  </div>" +
      '  <div class="summary-row">' +
      '    <div class="summary-label">Total Expenses</div>' +
      '    <div class="summary-value">' + rup(r.expense_total) + "</div>" +
      "  </div>" +
      '  <div class="summary-row">' +
      '    <div class="summary-label">Daily (counter)</div>' +
      '    <div class="summary-value">' + rup(r.transaction_expense_total) + "</div>" +
      "  </div>" +
      '  <div class="summary-row">' +
      '    <div class="summary-label">Report (from account)</div>' +
      '    <div class="summary-value">' + rup(r.report_expense_total) + "</div>" +
      "  </div>" +
      "</div>" +
      '<div style="margin-top:0.9rem;">' + rowsHtml + "</div>";

    document.getElementById("exv-back-btn").addEventListener("click", function () {
      state.step = "prompt";
      renderPrompt();
    });
  }

  // ── bootstrap ───────────────────────────────────────────────────────────

  function bind() {
    var btn = document.getElementById("quick-expenses-btn");
    if (btn) {
      btn.addEventListener("click", function () {
        var menu = document.querySelector(".quick-action-menu");
        if (menu) menu.classList.remove("show");
        openModal();
      });
    }
  }

  function start() {
    if (!window.CibaraAuth) { setTimeout(start, 100); return; }
    window.CibaraAuth.ready().then(function () {
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", bind);
      } else {
        bind();
      }
    });
  }
  start();

  window.openExpenseHistoryModal = openModal;
})();
