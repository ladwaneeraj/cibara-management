/* ──────────────────────────────────────────────────────────────────────────
 * Staff attendance & payroll UI.
 *
 * Backed by routes/staff.py. Managers mark daily attendance (full / half /
 * absent); admins additionally manage the staff directory, per-day wages,
 * advances and salary payouts. All checks here are UX only — the backend
 * @requires_permission decorators are the security boundary.
 *
 * Money flow: giving an advance or paying a salary writes a linked row
 * into the expenses collection server-side (atomic batch), so day-cash
 * totals stay correct without this file doing anything extra.
 *
 * The whole modal is built dynamically (same approach as maintenance.js)
 * so index.html only carries the quick-action entry + this script tag.
 * Loaded with `defer` after auth.js, permissions.js and script.js.
 * ──────────────────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  var state = {
    staff: [],              // /staff/list rows (payroll fields only for admin)
    payrollVisible: false,
    staffLoaded: false,
    includeInactive: false,

    gridMonth: null,        // "YYYY-MM" shown in the attendance grid
    // staff_id -> { date -> status }                    (single-shift staff)
    // staff_id -> { date -> { D: status, N: status } }  (dual-shift staff —
    //   staff.is_dual_shift; whichever shifts exist just aren't set)
    gridData: {},
    // staff_id -> { date -> {by, at, prev} }             (single-shift staff)
    // staff_id -> { date -> { D: {by,at,prev}, N: {...} } } (dual-shift staff)
    gridMeta: {},
    gridPaid: {},           // staff_id -> [{start, end}] settled periods
    gridScroll: null,       // {left, top} preserved across cell-tap re-renders

    payView: { name: "cards" },  // cards | add | edit | advance | pay | ledger
    payPreview: null,       // /salary_preview payload for the pay form

    insights: null,         // last /staff/analytics payload (SWR cache)
    _gridLoadedMonth: null, // month whose attendance is already in gridData

    // Quick pay/advance panel opened from a grid row (admin only):
    // { staffId, mode: "pay"|"advance", start, end, anchor, preview }
    quickPay: null,
  };

  // ── helpers ─────────────────────────────────────────────────────────────

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

  function del(url) {
    return api(url, { method: "DELETE" });
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

  function can(perm) {
    var a = window.CibaraAuth;
    if (a && typeof a.userCan === "function") return a.userCan(perm);
    return false;
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

  function fmtDShort(dateStr) {
    if (!dateStr) return "—";
    try {
      return new Date(dateStr + "T12:00:00").toLocaleDateString("en-IN", {
        day: "numeric", month: "short",
      });
    } catch (_) { return dateStr; }
  }

  function rup(n) {
    var v = Math.round(Number(n) || 0);
    return "₹" + v.toLocaleString("en-IN");
  }

  function fmtDays(n) {
    var v = Number(n) || 0;
    return (v % 1 === 0) ? String(v) : v.toFixed(1);
  }

  function initial(name) {
    return esc(String(name || "?").trim().charAt(0).toUpperCase() || "?");
  }

  // ── data loads ──────────────────────────────────────────────────────────

  function loadStaff(force) {
    if (state.staffLoaded && !force) return Promise.resolve(state.staff);
    var url = "/staff/list" + (state.includeInactive ? "?all=1" : "");
    return api(url).then(function (json) {
      state.staff = json.staff || [];
      state.payrollVisible = !!json.payroll_visible;
      state.staffLoaded = true;
      return state.staff;
    });
  }

  function activeStaff() {
    return state.staff.filter(function (s) { return s.active !== false; });
  }

  // Refresh hook for other modules (expense modal advances) and after
  // any payroll mutation here.
  window.refreshStaffModule = function () {
    state.staffLoaded = false;
    var modal = document.getElementById("staff-modal");
    if (modal && modal.classList.contains("show")) {
      var activeTab = modal.querySelector(".stf-tab-btn.active");
      switchTab(activeTab ? activeTab.dataset.stab : "attendance");
    }
    if (typeof window.invalidateExpenseStaffCache === "function") {
      window.invalidateExpenseStaffCache();
    }
  };

  // ── skeleton loaders (first paint before data arrives) ──────────────────

  function _skel(cls, style) {
    return '<div class="stf-skel ' + (cls || "") + '"' +
      (style ? ' style="' + style + '"' : "") + "></div>";
  }

  function skeletonGrid() {
    var rows = "";
    for (var i = 0; i < 4; i++) rows += _skel("", "height:37px;margin-bottom:6px;");
    return '<div class="stf-datebar">' + _skel("", "height:32px;width:220px;") +
      '<span style="flex:1;"></span>' + _skel("", "height:32px;width:150px;") +
      "</div>" + _skel("", "height:34px;margin-bottom:6px;") + rows;
  }

  function skeletonInsights() {
    var t = "";
    for (var i = 0; i < 4; i++) t += _skel("", "height:88px;border-radius:12px;");
    var rows = "";
    for (var j = 0; j < 4; j++) rows += _skel("", "height:40px;margin-bottom:6px;");
    return '<div class="stf-kpis">' + t + "</div>" +
      _skel("", "height:150px;border-radius:12px;margin-bottom:1.4rem;") + rows;
  }

  function skeletonCards() {
    var c = "";
    for (var i = 0; i < 4; i++) c += _skel("", "height:150px;border-radius:12px;");
    return '<div class="stf-toolbar">' + _skel("", "height:34px;width:120px;") + "</div>" +
      '<div class="stf-cards">' + c + "</div>";
  }

  function _paneActive(id) {
    var p = document.getElementById(id);
    return !!(p && p.classList.contains("active"));
  }

  // ── modal shell ─────────────────────────────────────────────────────────

  function ensureModal() {
    if (document.getElementById("staff-modal")) return;
    var tabs =
      '<button class="stf-tab-btn active" data-stab="attendance"><i class="fas fa-calendar-check"></i> Attendance</button>' +
      // Insights is analytics — admin-only, same as the rest of the app's
      // analytics surfaces. Managers get Attendance + Staff & Salary only.
      (can("analytics.view")
        ? '<button class="stf-tab-btn" data-stab="insights"><i class="fas fa-chart-line"></i> Insights</button>'
        : "") +
      (can("staff.payroll.view")
        ? '<button class="stf-tab-btn" data-stab="payroll"><i class="fas fa-users"></i> Staff &amp; Salary</button>'
        : "");
    var html =
      '<div class="modal-backdrop" id="staff-modal">' +
      '  <div class="modal-content stf-shell">' +
      '    <div class="stf-head">' +
      '      <div class="stf-head-ic"><i class="fas fa-users"></i></div>' +
      '      <div class="stf-head-tx">' +
      '        <div class="t">Staff &amp; Payroll</div>' +
      '        <div class="s" id="stf-head-sub"></div>' +
      "      </div>" +
      '      <button class="stf-close" aria-label="Close">&times;</button>' +
      "    </div>" +
      '    <div class="stf-tabs">' + tabs + "</div>" +
      '    <div class="modal-body">' +
      '      <div class="stf-tab-pane active" id="stf-pane-attendance"></div>' +
      '      <div class="stf-tab-pane" id="stf-pane-insights"></div>' +
      '      <div class="stf-tab-pane" id="stf-pane-payroll"></div>' +
      "    </div>" +
      "  </div>" +
      "</div>";
    document.body.insertAdjacentHTML("beforeend", html);

    var modal = document.getElementById("staff-modal");
    modal.querySelector(".stf-close").addEventListener("click", closeModal);
    modal.addEventListener("click", function (e) {
      if (e.target === modal) closeModal();
    });
    modal.querySelectorAll(".stf-tab-btn").forEach(function (btn) {
      btn.addEventListener("click", function () { switchTab(btn.dataset.stab); });
    });
  }

  function switchTab(tab) {
    var modal = document.getElementById("staff-modal");
    if (!modal) return;
    modal.querySelectorAll(".stf-tab-btn").forEach(function (b) {
      b.classList.toggle("active", b.dataset.stab === tab);
    });
    modal.querySelectorAll(".stf-tab-pane").forEach(function (p) {
      p.classList.toggle("active", p.id === "stf-pane-" + tab);
    });
    if (tab === "attendance") {
      if (!state.gridMonth) state.gridMonth = _todayStr().slice(0, 7);
      loadGrid();
    }
    if (tab === "insights") loadInsights();
    if (tab === "payroll") {
      state.payView = { name: "cards" };
      loadPayroll();
    }
  }

  function openModal() {
    ensureModal();
    var sub = document.getElementById("stf-head-sub");
    if (sub) {
      sub.textContent = new Date().toLocaleDateString("en-IN", {
        weekday: "long", day: "numeric", month: "long", year: "numeric",
      });
    }
    document.getElementById("staff-modal").classList.add("show");
    switchTab("attendance");
  }
  function closeModal() {
    _closeCellPop();
    var m = document.getElementById("staff-modal");
    if (m) m.classList.remove("show");
  }

  // ═════════════════════════════════════════════════════════════════════════
  // ATTENDANCE — Excel-style month grid (all staff × all days, one line
  // per person; tap a cell to cycle blank → P → ½ → A → blank).
  // Same interaction model as the laundry month grid.
  // ═════════════════════════════════════════════════════════════════════════

  var CELL_LABEL = { full: "P", half: "½", absent: "A" };
  var CELL_CYCLE = { "": "full", full: "half", half: "absent", absent: "" };

  function _monthRange(ym) {
    var y = parseInt(ym.slice(0, 4), 10);
    var m = parseInt(ym.slice(5, 7), 10);
    var last = new Date(y, m, 0).getDate();
    return { start: ym + "-01", end: ym + "-" + String(last).padStart(2, "0"), lastDay: last };
  }

  function _dstr(ym, day) {
    return ym + "-" + String(day).padStart(2, "0");
  }

  function _dowLetter(ym, day) {
    return "SMTWTFS".charAt(new Date(_dstr(ym, day) + "T12:00:00").getDay());
  }

  function _isSunday(ym, day) {
    return new Date(_dstr(ym, day) + "T12:00:00").getDay() === 0;
  }

  // ── Audit-trail helpers ─────────────────────────────────────────────────

  // Compress a server attendance record into what the chooser popover
  // shows: who set the current mark, when, and (if it was changed) what
  // it was before and who set that.
  function _attMeta(a) {
    var m = {
      by: (a.marked_by && a.marked_by.name) || "",
      at: a.marked_at || "",
    };
    var h = a.history;
    if (h && h.length) {
      var last = h[h.length - 1];
      m.prev = {
        status: last.status || "",
        by: (last.marked_by && last.marked_by.name) || "",
        at: last.marked_at || "",
      };
    }
    return m;
  }

  // "12 Jul, 9:41 am" in lodge time — for audit stamps.
  function _fmtStamp(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    try {
      return d.toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata", day: "numeric", month: "short",
        hour: "numeric", minute: "2-digit",
      });
    } catch (_) { return d.toLocaleString(); }
  }

  // "by NAME" chip for ledger rows / slips. Empty string when unknown
  // (records created before the audit trail existed).
  function _byLine(stamp) {
    var n = stamp && stamp.name;
    return n && n !== "system" ? "by " + n : "";
  }

  function _isPaid(sid, d) {
    return (state.gridPaid[sid] || []).some(function (p) {
      return p.start && p.end && p.start <= d && d <= p.end &&
        (p.excluded || []).indexOf(d) === -1;
    });
  }

  // ── gridData/gridMeta accessors — the cell value is a plain status
  // string for single-shift staff, or a { D: status, N: status } object
  // for dual-shift staff (shift is always passed as null for the former,
  // "D"/"N" for the latter, so callers never need to branch on staff type
  // themselves — these helpers do it once, based on the shift argument). ──

  function _gridGetStatus(sid, date, shift) {
    var cell = (state.gridData[sid] || {})[date];
    if (shift) return (cell && typeof cell === "object") ? (cell[shift] || "") : "";
    return typeof cell === "string" ? cell : "";
  }

  function _gridSetStatus(sid, date, shift, status) {
    var row = (state.gridData[sid] = state.gridData[sid] || {});
    if (shift) {
      var cell = (row[date] = (row[date] && typeof row[date] === "object") ? row[date] : {});
      if (status) cell[shift] = status; else delete cell[shift];
    } else if (status) {
      row[date] = status;
    } else {
      delete row[date];
    }
  }

  function _gridGetMeta(sid, date, shift) {
    var cell = (state.gridMeta[sid] || {})[date];
    if (shift) return (cell && typeof cell === "object") ? cell[shift] : null;
    return cell || null;
  }

  function _gridSetMeta(sid, date, shift, rec) {
    var metaRow = (state.gridMeta[sid] = state.gridMeta[sid] || {});
    var val = (rec && rec.status) ? _attMeta(rec) : null;
    if (shift) {
      var metaCell = (metaRow[date] = (metaRow[date] && typeof metaRow[date] === "object") ? metaRow[date] : {});
      if (val) metaCell[shift] = val; else delete metaCell[shift];
    } else if (val) {
      metaRow[date] = val;
    } else {
      delete metaRow[date];
    }
  }

  // Authoritative write from a server record (initial load, mark_all).
  function _setGridRecord(sid, date, shift, status, rec) {
    _gridSetStatus(sid, date, shift, status);
    _gridSetMeta(sid, date, shift, rec);
  }

  function loadGrid() {
    var pane = document.getElementById("stf-pane-attendance");
    state.gridScroll = null;   // fresh load → auto-scroll to today
    // Stale-while-revalidate: if this month is already in memory, paint it
    // instantly and refresh silently; otherwise show a skeleton.
    var hasCache = state._gridLoadedMonth === state.gridMonth && state.staffLoaded;
    if (hasCache) renderGrid();
    else pane.innerHTML = skeletonGrid();
    var month = state.gridMonth;
    var r = _monthRange(month);
    Promise.all([
      loadStaff(),
      api("/staff/attendance?start=" + r.start + "&end=" + r.end),
    ])
      .then(function (results) {
        if (state.gridMonth !== month) return;   // user moved on
        state.gridData = {};
        state.gridMeta = {};
        (results[1].attendance || []).forEach(function (a) {
          _setGridRecord(a.staff_id, a.date, a.shift, a.status, a);
        });
        state.gridPaid = results[1].paid_periods || {};
        state._gridLoadedMonth = month;
        if (_paneActive("stf-pane-attendance")) renderGrid();
      })
      .catch(function (e) {
        if (hasCache) notify(e.message, "error");
        else pane.innerHTML = '<div class="stf-empty">' + esc(e.message) + "</div>";
      });
  }

  function renderGrid() {
    _closeCellPop();
    var pane = document.getElementById("stf-pane-attendance");
    var staff = activeStaff();
    var r = _monthRange(state.gridMonth);
    var today = _todayStr();
    var thisMonth = today.slice(0, 7);
    var canMark = can("staff.attendance.mark");

    var monthLabel = new Date(r.start + "T12:00:00").toLocaleDateString("en-IN", {
      month: "long", year: "numeric",
    });

    var html =
      '<div class="stf-datebar">' +
      '  <button class="stf-nav-btn" id="stf-grid-prev" title="Previous month">&#8249;</button>' +
      '  <label class="stf-monthpick" title="Jump to a month">' +
      '    <span id="stf-grid-month-label">' + esc(monthLabel) + "</span>" +
      '    <input type="month" id="stf-grid-month-inp" value="' + esc(state.gridMonth) + '" max="' + thisMonth + '" />' +
      "  </label>" +
      '  <button class="stf-nav-btn" id="stf-grid-next" title="Next month"' +
      (state.gridMonth >= thisMonth ? " disabled" : "") + ">&#8250;</button>" +
      (state.gridMonth === thisMonth ? "" : '  <button class="stf-today-btn" id="stf-grid-today">This month</button>') +
      (canMark && state.gridMonth === thisMonth
        ? '  <span style="flex:1;"></span>' +
          '  <button class="stf-allpresent-btn" id="stf-grid-allpresent" title="Mark every unmarked staff as Full for today">' +
          '    <i class="fas fa-check-double"></i> All present today</button>'
        : "") +
      "</div>";

    if (!staff.length) {
      html += '<div class="stf-empty">No staff added yet.' +
        (can("staff.manage")
          ? "<br>Add your team from the <b>Staff &amp; Salary</b> tab."
          : "") + "</div>";
      pane.innerHTML = html;
      bindGridBar();
      return;
    }

    // ── header ──
    html += '<div class="stf-grid-wrap"><table class="stf-grid-table"><thead><tr>';
    html += '<th class="stf-grid-name-h">Staff</th>';
    for (var d = 1; d <= r.lastDay; d++) {
      var dstr = _dstr(state.gridMonth, d);
      var thCls = [];
      if (dstr === today) thCls.push("is-today");
      if (dstr > today) thCls.push("is-future");
      var dow = _dowLetter(state.gridMonth, d);
      html += '<th class="' + thCls.join(" ") + '"' +
        (_isSunday(state.gridMonth, d) ? ' data-sun="1"' : "") + ">" +
        "<span>" + d + "</span><small>" + dow + "</small></th>";
    }
    var canPay = state.payrollVisible &&
      (can("staff.salary.pay") || can("staff.advance.give"));
    html += '<th class="stf-grid-total-h">Days</th>' +
      (canPay ? '<th class="stf-grid-pay-h" title="Pay salary / advance">₹</th>' : "") +
      "</tr></thead><tbody>";

    // ── one (or two) line(s) per staff ──
    // Dual-shift staff (is_dual_shift) get TWO real grid rows — a Day row
    // and a Night row — each behaving exactly like a normal staff row
    // (full-size cells, same tap-to-mark interaction). A small D/N tag
    // next to the name is the only visual difference; everything else
    // (click handling, popover, optimistic update) is shift-agnostic and
    // shared with single-shift staff via the `shift` value on each row.
    var dayTotals = new Array(r.lastDay + 1).fill(0);
    var gridRows = [];
    staff.forEach(function (s) {
      if (s.is_dual_shift) {
        gridRows.push({ s: s, shift: "D", pairFirst: true });
        gridRows.push({ s: s, shift: "N", pairSecond: true });
      } else {
        gridRows.push({ s: s, shift: null });
      }
    });

    gridRows.forEach(function (gr) {
      var s = gr.s, shift = gr.shift;
      var worked = 0;
      // Ledger-open / pay actions live only on a staff member's FIRST row
      // (their only row, or the Day row of a dual-shift pair) — showing
      // the same ₹ button twice per person would be confusing.
      var showActions = !gr.pairSecond;
      var advDue = showActions && state.payrollVisible &&
          Number(s.outstanding_advance || 0) > 0
        ? '<b class="advdue" title="Advance to recover from salary">' +
          rup(s.outstanding_advance) + " adv</b>"
        : "";
      var nameAttrs = showActions && can("staff.payroll.view")
        ? ' data-open="' + esc(s.id) + '" title="Open ' + esc(s.name) + "'s ledger\""
        : "";
      var shiftTag = shift
        ? '<span class="stf-shift-tag ' + (shift === "D" ? "day" : "night") +
          '" title="' + (shift === "D" ? "Day shift" : "Night shift") + '">' +
          shift + "</span>"
        : "";
      html += '<tr data-sid="' + esc(s.id) + '"' +
        (shift ? ' data-shift="' + shift + '"' : "") +
        (gr.pairFirst ? ' class="stf-pair-first"' : "") +
        (gr.pairSecond ? ' class="stf-pair-second"' : "") + ">" +
        '<td class="stf-grid-name' + (nameAttrs ? " clickable" : "") + '"' +
        nameAttrs + ">" +
        '<span class="nm">' +
        (gr.pairSecond ? shiftTag : esc(s.name) + shiftTag) + "</span>" +
        (showActions && (s.designation || advDue)
          ? '<span class="ds">' + esc(s.designation || "") +
            (s.designation && advDue ? " · " : "") + advDue + "</span>"
          : "") +
        "</td>";
      for (var d2 = 1; d2 <= r.lastDay; d2++) {
        var ds = _dstr(state.gridMonth, d2);
        var st = _gridGetStatus(s.id, ds, shift);
        if (st === "full") { worked += 1; dayTotals[d2] += 1; }
        if (st === "half") { worked += 0.5; dayTotals[d2] += 0.5; }
        var cls = ["stf-grid-cell"];
        if (st) cls.push(st);
        if (ds === today) cls.push("is-today");
        if (_isSunday(state.gridMonth, d2)) cls.push("is-sun");
        var qp = state.quickPay;
        if (qp && qp.mode === "pay" && qp.staffId === s.id &&
            qp.start && qp.end && qp.start <= ds && ds <= qp.end) {
          cls.push("in-range");
        }
        var future = ds > today;
        var locked = _isPaid(s.id, ds);
        if (future) cls.push("is-future");
        if (locked) cls.push("is-locked");
        html += '<td class="' + cls.join(" ") + '" data-date="' + ds + '"' +
          (shift ? ' data-shift="' + shift + '"' : "") +
          (locked ? ' title="Salary paid for this day — locked"' : "") + ">" +
          (st ? '<span class="m">' + CELL_LABEL[st] + "</span>" : "") + "</td>";
      }
      html += '<td class="stf-grid-total">' + fmtDays(worked) + "</td>" +
        (canPay
          ? (showActions
              ? '<td class="stf-grid-pay' +
                (state.quickPay && state.quickPay.staffId === s.id ? " on" : "") +
                '" data-pay="' + esc(s.id) + '" title="Pay salary / give advance">' +
                '<i class="fas fa-money-bill-wave"></i></td>'
              : '<td class="stf-grid-pay stf-grid-pay-empty"></td>')
          : "") +
        "</tr>";
    });
    html += "</tbody><tfoot><tr>";

    // ── per-day on-duty footer ──
    html += '<td class="stf-grid-name stf-grid-foot">On duty</td>';
    for (var d3 = 1; d3 <= r.lastDay; d3++) {
      var fds = _dstr(state.gridMonth, d3);
      html += '<td class="stf-grid-foot' + (fds === today ? " is-today" : "") + '">' +
        (dayTotals[d3] ? fmtDays(dayTotals[d3]) : "") + "</td>";
    }
    html += '<td class="stf-grid-foot"></td>' +
      (canPay ? '<td class="stf-grid-foot"></td>' : "") +
      "</tr></tfoot></table></div>";

    html += '<div id="stf-quickpay-slot"></div>';
    html +=
      '<div class="stf-cal-legend">' +
      '  <span><span class="dot" style="background:#c6f6d5;border:1px solid #9ae6b4;"></span>P — full day</span>' +
      '  <span><span class="dot" style="background:#fefcbf;border:1px solid #f6e05e;"></span>½ — half day</span>' +
      '  <span><span class="dot" style="background:#fed7d7;border:1px solid #feb2b2;"></span>A — absent</span>' +
      '  <span><span class="dot" style="background:#fff;border:1px solid #e2e8f0;"></span>blank — not marked</span>' +
      "  <span>🔒 salary paid (locked)</span>" +
      (staff.some(function (s) { return s.is_dual_shift; })
        ? "  <span>D / N — Day &amp; Night shift row, marked independently</span>"
        : "") +
      "</div>" +
      (canMark
        ? '<div class="stf-cal-legend"><span>Tap a blank day to mark Present. Tapping an already-marked day asks before changing it.' +
          (staff.some(function (s) { return s.is_dual_shift; })
            ? " Two-shift staff get a separate D row and N row to mark."
            : "") +
          "</span></div>"
        : "");

    pane.innerHTML = html;
    bindGridBar();
    renderQuickPay();

    if (canMark) {
      pane.querySelectorAll(".stf-grid-cell").forEach(function (cell) {
        cell.addEventListener("click", function () { onCellTap(cell); });
      });
    }
    pane.querySelectorAll("[data-pay]").forEach(function (cell) {
      cell.addEventListener("click", function () {
        openQuickPay(cell.dataset.pay);
      });
    });
    // Tapping a staff NAME opens their ledger (advances, salaries,
    // outstanding) without hunting through the Staff & Salary tab.
    pane.querySelectorAll(".stf-grid-name[data-open]").forEach(function (cell) {
      cell.addEventListener("click", function () {
        openLedgerFor(cell.dataset.open);
      });
    });

    // After a cell-tap re-render, restore where the user was scrolled to;
    // on a fresh load, auto-scroll so today's column is in view.
    var wrap = pane.querySelector(".stf-grid-wrap");
    if (wrap) {
      if (state.gridScroll) {
        wrap.scrollLeft = state.gridScroll.left;
        wrap.scrollTop = state.gridScroll.top;
        state.gridScroll = null;
      } else if (state.gridMonth === thisMonth) {
        var todayTh = pane.querySelector("thead th.is-today");
        if (todayTh) {
          wrap.scrollLeft = Math.max(0, todayTh.offsetLeft - wrap.clientWidth / 2);
        }
      }
    }
  }

  function bindGridBar() {
    var prev = document.getElementById("stf-grid-prev");
    var next = document.getElementById("stf-grid-next");
    var inp = document.getElementById("stf-grid-month-inp");
    var today = document.getElementById("stf-grid-today");
    function shift(n) {
      state.gridMonth = _addDays(state.gridMonth + "-15", n * 31).slice(0, 7);
      loadGrid();
    }
    if (prev) prev.addEventListener("click", function () { shift(-1); });
    if (next) next.addEventListener("click", function () { shift(1); });
    if (inp) inp.addEventListener("change", function () {
      if (inp.value && inp.value <= _todayStr().slice(0, 7)) {
        state.gridMonth = inp.value;
        loadGrid();
      }
    });
    if (today) today.addEventListener("click", function () {
      state.gridMonth = _todayStr().slice(0, 7);
      loadGrid();
    });
    var allBtn = document.getElementById("stf-grid-allpresent");
    if (allBtn) allBtn.addEventListener("click", function () {
      if (!confirm("Mark every unmarked staff as FULL day for today?")) return;
      allBtn.disabled = true;
      post("/staff/attendance/mark_all", { date: _todayStr() })
        .then(function (json) {
          (json.marked || []).forEach(function (rec) {
            _setGridRecord(rec.staff_id, rec.date, rec.shift || null,
                           rec.status, rec);
          });
          var parts = [(json.marked || []).length + " marked"];
          if (json.already_marked) parts.push(json.already_marked + " already marked");
          if (json.skipped_locked) parts.push(json.skipped_locked + " locked (salary paid)");
          notify(parts.join(" · "), "success");
          var wrap = document.querySelector("#stf-pane-attendance .stf-grid-wrap");
          if (wrap) state.gridScroll = { left: wrap.scrollLeft, top: wrap.scrollTop };
          renderGrid();
        })
        .catch(function (e) { allBtn.disabled = false; notify(e.message, "error"); });
    });
  }

  function onCellTap(cell) {
    var tr = cell.closest("tr");
    var sid = tr && tr.dataset.sid;
    var d = cell.dataset.date;
    var shift = cell.dataset.shift || null;   // set on dual-shift staff's D/N row cells only
    if (!sid || !d) return;
    if (d > _todayStr()) return;                       // future — not markable

    // While the quick-pay panel targets this staff, taps on THEIR row pick
    // the salary period (calendar-style: first tap = start, second = end)
    // instead of marking attendance. Other rows keep marking normally.
    // (Date-range selection ignores which shift cell was tapped.)
    var qp = state.quickPay;
    if (qp && qp.mode === "pay" && qp.staffId === sid) {
      if (!qp.anchor) {
        qp.start = d; qp.end = d; qp.anchor = true;
      } else {
        if (d < qp.start) { qp.end = qp.start; qp.start = d; }
        else qp.end = d;
        qp.anchor = false;
      }
      // Release focus from a date input if it has it, so _qpSync may write
      // the tapped range into the inputs (it never overwrites a focused
      // field — the user could be mid-typing).
      var act = document.activeElement;
      if (act && (act.id === "stf-qp-start" || act.id === "stf-qp-end")) {
        act.blur();
      }
      _qpHighlightRange();       // toggle classes on the live grid — no
      fetchQuickPreview();       // re-render, no scroll jump, panel fixed
      return;
    }

    if (_isPaid(sid, d)) {
      notify("Salary is already paid for this day — attendance is locked.", "error");
      return;
    }

    var prev = _gridGetStatus(sid, d, shift);

    if (!prev) {
      // Blank day/shift → one tap marks Present (the fast path for the
      // daily register stays one tap per person, or per shift).
      _commitMark(sid, d, "full", shift);
      return;
    }

    // Already-marked day: a stray tap must NOT silently change it. Open a
    // small chooser instead — nothing changes until an option is picked;
    // tapping anywhere else just closes it.
    _openCellPop(cell, sid, d, prev, shift);
  }

  function _commitMark(sid, d, next, shift) {
    var prev = _gridGetStatus(sid, d, shift);
    if ((next || "") === prev) return;

    function keepScroll() {
      var wrap = document.querySelector("#stf-pane-attendance .stf-grid-wrap");
      if (wrap) state.gridScroll = { left: wrap.scrollLeft, top: wrap.scrollTop };
    }

    // Optimistic update, revert on server rejection.
    _gridSetStatus(sid, d, shift, next);
    keepScroll();
    renderGrid();
    post("/staff/attendance/mark", {
      staff_id: sid, date: d, status: next || "clear",
      shift: shift || undefined,
    }).then(function (json) {
      // Keep the audit info fresh so the popover shows the real marker
      // without a full reload.
      _gridSetMeta(sid, d, shift, json && json.record);
    }).catch(function (e) {
      _gridSetStatus(sid, d, shift, prev);
      keepScroll();
      renderGrid();
      notify(e.message, "error");
    });
  }

  // ── Chooser popover for already-marked days (mis-press protection) ──────

  function _closeCellPop() {
    var pop = document.getElementById("stf-cell-pop");
    if (pop) pop.remove();
    document.removeEventListener("pointerdown", _cellPopOutside, true);
  }

  function _cellPopOutside(e) {
    var pop = document.getElementById("stf-cell-pop");
    if (pop && !pop.contains(e.target)) _closeCellPop();
  }

  function _openCellPop(cell, sid, d, current, shift) {
    _closeCellPop();
    var s = state.staff.find(function (x) { return x.id === sid; });
    var CUR_LABEL = { full: "Full day", half: "Half day", absent: "Absent" };
    var SHIFT_LABEL = { D: "Day shift", N: "Night shift" };

    function opt(val, cls, label) {
      var isCur = val === current;
      return '<button data-set="' + val + '" class="' + cls +
        (isCur ? " cur" : "") + '"' + (isCur ? " disabled" : "") + ">" +
        label + (isCur ? " ✓" : "") + "</button>";
    }
    // Audit line: who set this mark (and, if it was changed, what it was
    // before and who set that). Old records without a stamp show nothing.
    var meta = _gridGetMeta(sid, d, shift);
    var audit = "";
    if (meta && meta.by && meta.by !== "system") {
      audit = "Marked by <b>" + esc(meta.by) + "</b>" +
        (meta.at ? " · " + esc(_fmtStamp(meta.at)) : "");
      if (meta.prev && meta.prev.status) {
        audit += "<br>was " + esc(CUR_LABEL[meta.prev.status] || meta.prev.status) +
          (meta.prev.by && meta.prev.by !== "system"
            ? " (by " + esc(meta.prev.by) + ")" : "");
      }
    }

    var html =
      '<div class="stf-cell-pop" id="stf-cell-pop">' +
      '  <div class="t">' + esc((s && s.name) || "") +
      (shift ? " · " + esc(SHIFT_LABEL[shift] || shift) : "") +
      " · " + esc(fmtDShort(d)) +
      '     <span>' + esc(CUR_LABEL[current] || "") + "</span></div>" +
      (audit ? '<div class="audit">' + audit + "</div>" : "") +
      '  <div class="opts">' +
      opt("full", "full", "P Full") +
      opt("half", "half", "½ Half") +
      opt("absent", "absent", "A Absent") +
      '    <button data-set="clear" class="clear">Blank</button>' +
      "  </div>" +
      "</div>";
    document.body.insertAdjacentHTML("beforeend", html);

    // Position near the cell, clamped to the viewport.
    var pop = document.getElementById("stf-cell-pop");
    var r = cell.getBoundingClientRect();
    var pw = pop.offsetWidth, ph = pop.offsetHeight;
    var left = Math.max(8, Math.min(r.left + r.width / 2 - pw / 2,
      window.innerWidth - pw - 8));
    var top = r.bottom + 6;
    if (top + ph > window.innerHeight - 8) top = r.top - ph - 6;
    pop.style.left = left + "px";
    pop.style.top = Math.max(8, top) + "px";

    pop.querySelectorAll("[data-set]").forEach(function (b) {
      b.addEventListener("click", function () {
        var v = b.dataset.set;
        _closeCellPop();
        _commitMark(sid, d, v === "clear" ? "" : v, shift);
      });
    });
    // Defer the outside-close listener so the opening tap doesn't close it.
    setTimeout(function () {
      document.addEventListener("pointerdown", _cellPopOutside, true);
    }, 0);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // QUICK PAY / ADVANCE — inline panel under the attendance grid, so salary
  // and advances happen right where attendance lives (no tab switching).
  // The selected period is highlighted on the staff member's row; taps on
  // their cells or the date inputs adjust it. Server-side validation
  // (overlaps, deduction bounds) is unchanged — this is only a faster door
  // to the same endpoints.
  // ═════════════════════════════════════════════════════════════════════════

  var _qpPreviewTimer = null;

  // ── Modern calendar (flatpickr) — the SAME picker the Transactions tab
  // uses (loaded app-wide from index.html). staff.js only ever *enhances*
  // native date inputs with it: if the library is missing (CDN down), every
  // flow still works on the plain <input type="date"> underneath.
  var _fpInstances = [];

  function _fpLib() {
    return typeof window.flatpickr === "function" ? window.flatpickr : null;
  }

  function _toYMD(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
      "-" + String(d.getDate()).padStart(2, "0");
  }

  function _ymdDate(s) { return new Date(s + "T12:00:00"); }

  // Destroy instances whose input has been re-rendered away, so repeated
  // pane rebuilds don't leak hidden calendar nodes in <body>.
  function _fpSweep() {
    _fpInstances = _fpInstances.filter(function (p) {
      if (p.input && document.body.contains(p.input)) return true;
      try { p.destroy(); } catch (_) { /* already torn down */ }
      return false;
    });
  }

  // Upgrade a single-date input to the flatpickr calendar. The submitted
  // value stays "Y-m-d" on the original input (altInput shows the friendly
  // "28 Jul 2026"), so every existing read/submit/change path is untouched.
  function _modernDate(id, opts) {
    var el = document.getElementById(id);
    var fp = _fpLib();
    if (!el || !fp || el._flatpickr) return null;
    _fpSweep();
    var conf = {
      dateFormat: "Y-m-d",
      altInput: true,
      altFormat: "d M Y",
      disableMobile: true,
    };
    for (var k in (opts || {})) conf[k] = opts[k];
    var inst = fp(el, conf);
    _fpInstances.push(inst);
    return inst;
  }

  function _qpStaff() {
    return state.staff.find(function (s) {
      return state.quickPay && s.id === state.quickPay.staffId;
    });
  }

  function openQuickPay(staffId, keepOpen) {
    var s = state.staff.find(function (x) { return x.id === staffId; });
    if (!s) return;
    if (state.quickPay && state.quickPay.staffId === staffId) {
      // Tap again on ₹ = toggle off. A programmatic open (keepOpen, e.g.
      // the salary redirect from the expense modal) must NOT toggle-close.
      if (!keepOpen) closeQuickPay();
      return;
    }
    var today = _todayStr();
    var start = s.suggested_period_start || s.joined_date ||
      today.slice(0, 8) + "01";
    if (start > today) start = today;
    state.quickPay = {
      staffId: staffId,
      mode: can("staff.salary.pay") ? "pay" : "advance",
      start: start,
      end: today,
      anchor: false,
      preview: null,
      loading: true,
    };
    var wrapEl = document.querySelector("#stf-pane-attendance .stf-grid-wrap");
    if (wrapEl) state.gridScroll = { left: wrapEl.scrollLeft, top: wrapEl.scrollTop };
    renderGrid();
    fetchQuickPreview();
    var slot = document.getElementById("stf-quickpay-slot");
    // On phones the grid is tall — "nearest" would leave only the panel's
    // top edge peeking in at the bottom, so bring it to the middle.
    var block = window.innerWidth <= 600 ? "center" : "nearest";
    if (slot) slot.scrollIntoView({ behavior: "smooth", block: block });
  }

  function closeQuickPay() {
    state.quickPay = null;
    var wrapEl = document.querySelector("#stf-pane-attendance .stf-grid-wrap");
    if (wrapEl) state.gridScroll = { left: wrapEl.scrollLeft, top: wrapEl.scrollTop };
    renderGrid();
    _fpSweep();                      // the panel's pickers are orphans now
  }

  function fetchQuickPreview() {
    var qp = state.quickPay;
    if (!qp || qp.mode !== "pay") return;
    if (_qpPreviewTimer) clearTimeout(_qpPreviewTimer);
    qp.loading = true;
    _qpSync();                       // in place — the panel NEVER rebuilds here
    _qpPreviewTimer = setTimeout(function () {
      var mine = state.quickPay;
      if (!mine || mine !== qp) return;
      api("/staff/" + encodeURIComponent(qp.staffId) +
          "/salary_preview?start=" + qp.start + "&end=" + qp.end)
        .then(function (json) {
          if (state.quickPay !== qp) return;
          qp.preview = json;
          qp.error = null;
          qp.loading = false;
          _qpSync();
        })
        .catch(function (e) {
          if (state.quickPay !== qp) return;
          qp.preview = null;
          qp.loading = false;
          qp.error = e.message;
          _qpSync();
        });
    }, 250);
  }

  // Toggle the calendar-range highlight on the grid IN PLACE — no grid
  // re-render, so the panel, scroll position and focus are untouched.
  function _qpHighlightRange() {
    var qp = state.quickPay;
    var pane = document.getElementById("stf-pane-attendance");
    if (!pane) return;
    pane.querySelectorAll(".stf-grid-cell[data-date]").forEach(function (cell) {
      var tr = cell.closest("tr");
      var inRange = !!(qp && qp.mode === "pay" && tr &&
        tr.dataset.sid === qp.staffId &&
        qp.start && qp.end && qp.start <= cell.dataset.date &&
        cell.dataset.date <= qp.end);
      cell.classList.toggle("in-range", inRange);
    });
    pane.querySelectorAll("[data-pay]").forEach(function (cell) {
      cell.classList.toggle("on", !!(qp && cell.dataset.pay === qp.staffId));
    });
  }

  // ── In-place refresh of the panel's dynamic parts. The structure (inputs,
  // source toggle, buttons) is built ONCE by renderQuickPay and stays put —
  // changing dates must never collapse the panel into a "Calculating…"
  // placeholder or steal focus from an input.
  function _qpSync() {
    var qp = state.quickPay;
    if (!qp || qp.mode !== "pay") return;
    var pv = qp.preview;

    // Date controls follow state (grid taps). With the flatpickr range
    // picker, setDate(..., false) updates in place WITHOUT firing onChange
    // — no loop, no panel rebuild. Native fallback keeps the old rule of
    // never overwriting a focused input.
    var picker = qp._rangePicker;
    if (picker && picker.input && document.body.contains(picker.input)) {
      var selNow = picker.selectedDates.map(_toYMD);
      if (selNow.length !== 2 || selNow[0] !== qp.start || selNow[1] !== qp.end) {
        picker.setDate([_ymdDate(qp.start), _ymdDate(qp.end)], false);
      }
    } else {
      var startInp = document.getElementById("stf-qp-start");
      var endInp = document.getElementById("stf-qp-end");
      if (startInp && document.activeElement !== startInp && startInp.value !== qp.start) {
        startInp.value = qp.start;
      }
      if (endInp && document.activeElement !== endInp && endInp.value !== qp.end) {
        endInp.value = qp.end;
      }
    }

    // Note area (skipped days / fully-paid warning / error).
    var noteEl = document.getElementById("stf-qp-notearea");
    if (noteEl) {
      var note = "";
      if (qp.error) {
        note = '<div class="stf-carry-note" style="background:#fff5f5;border-color:#fecaca;color:#991b1b;">' +
          esc(qp.error) + "</div>";
      } else if (pv && pv.all_days_paid) {
        note = '<div class="stf-carry-note" style="background:#fff5f5;border-color:#fecaca;color:#991b1b;">' +
          "⚠ Every day in this range is already paid — nothing left to settle. Adjust the dates.</div>";
      } else if (pv && pv.excluded_days && pv.excluded_days.length) {
        note = '<div class="stf-carry-note">' +
          "ℹ " + pv.excluded_days.length + " already-paid day" +
          (pv.excluded_days.length > 1 ? "s" : "") + " (" +
          esc(pv.excluded_days.map(fmtDShort).join(", ")) +
          ") will be skipped — the salary below covers only the unpaid days.</div>";
      }
      if (noteEl.innerHTML !== note) noteEl.innerHTML = note;
    }

    // Calculation line: keep the old numbers dimmed while the fresh ones load.
    var calcEl = document.getElementById("stf-qp-calc");
    if (calcEl) {
      if (pv) {
        var c = pv.computed;
        calcEl.innerHTML = "<b>" + fmtDays(c.days_worked) + "</b> days (" +
          c.full_days + " full, " + c.half_days + " half) × " +
          rup(c.daily_wage) + " = <b>" + rup(c.gross) + "</b>";
      } else if (!qp.loading) {
        calcEl.textContent = "—";
      }
      calcEl.classList.toggle("updating", !!qp.loading);
    }

    // Advance deduction: show only when there is something to recover; keep
    // the operator's typed value, only auto-fill while untouched.
    var outstanding = pv ? Number(pv.outstanding_advance || 0) : 0;
    var dedWrap = document.getElementById("stf-qp-ded-wrap");
    var dedInp = document.getElementById("stf-qp-ded");
    if (dedWrap) dedWrap.style.display = outstanding > 0 ? "" : "none";
    if (dedInp && pv) {
      dedInp.max = outstanding;
      if (!qp.dedTouched) {
        var adjNow = parseInt(document.getElementById("stf-qp-adj")?.value, 10) || 0;
        dedInp.value = Math.min(outstanding, Math.max(0, pv.computed.gross + adjNow));
      }
    }
    _qpRecalcNet();

    var confirmBtn = document.getElementById("stf-qp-confirm");
    if (confirmBtn && qp.mode === "pay") {
      confirmBtn.disabled = !!(qp.loading || !pv || pv.all_days_paid);
    }
  }

  function _qpRecalcNet() {
    var qp = state.quickPay;
    var pv = qp && qp.preview;
    var netEl = document.getElementById("stf-qp-net");
    if (!netEl) return;
    if (!pv) { netEl.textContent = "—"; return; }
    var outstanding = Number(pv.outstanding_advance || 0);
    var adj = parseInt(document.getElementById("stf-qp-adj")?.value, 10) || 0;
    var payable = pv.computed.gross + adj;
    var ded = Math.min(parseInt(document.getElementById("stf-qp-ded")?.value, 10) || 0,
      Math.min(outstanding, Math.max(0, payable)));
    netEl.textContent = rup(payable - ded);
  }

  function renderQuickPay() {
    var slot = document.getElementById("stf-quickpay-slot");
    if (!slot) return;
    var qp = state.quickPay;
    if (!qp) { slot.innerHTML = ""; return; }
    var s = _qpStaff();
    if (!s) { slot.innerHTML = ""; return; }
    var today = _todayStr();

    var head =
      '<div class="stf-qp-head">' +
      '  <div class="stf-avatar" style="width:30px;height:30px;font-size:0.8rem;">' + initial(s.name) + "</div>" +
      '  <div class="who"><b>' + esc(s.name) + "</b>" +
      '    <span>' + rup(s.daily_wage) + "/day" +
      (s.outstanding_advance > 0
        ? ' · <span class="due">advance ' + rup(s.outstanding_advance) + " due</span>"
        : "") + "</span></div>" +
      '  <div class="stf-qp-switch">' +
      (can("staff.salary.pay")
        ? '<button data-qpmode="pay" class="' + (qp.mode === "pay" ? "on" : "") + '">Salary</button>'
        : "") +
      (can("staff.advance.give")
        ? '<button data-qpmode="advance" class="' + (qp.mode === "advance" ? "on" : "") + '">Advance</button>'
        : "") +
      "  </div>" +
      '  <button class="stf-qp-close" id="stf-qp-close" title="Close">&times;</button>' +
      "</div>";

    var body = "";
    if (qp.mode === "pay") {
      // The FULL structure is always present; _qpSync() fills the dynamic
      // parts. Nothing here is ever swapped for a loading placeholder.
      // One "Pick date range" input opening the flatpickr calendar — the
      // same modern selector as the Transactions tab. Native two-input
      // fallback if the library didn't load.
      var dateRow = _fpLib()
        ? '<div class="stf-qp-row">' +
          '  <label class="grow stf-range-lbl"><i class="fas fa-calendar-alt"></i>' +
          '    <input type="text" id="stf-qp-range" class="stf-range-inp" placeholder="Pick date range" readonly></label>' +
          '  <span class="hint">or tap days on ' + esc(s.name) + "&rsquo;s row</span>" +
          "</div>"
        : '<div class="stf-qp-row">' +
          '  <label>From <input type="date" id="stf-qp-start" value="' + esc(qp.start) + '" max="' + today + '"></label>' +
          '  <label>To <input type="date" id="stf-qp-end" value="' + esc(qp.end) + '" max="' + today + '"></label>' +
          '  <span class="hint">or tap days on ' + esc(s.name) + "&rsquo;s row</span>" +
          "</div>";
      body += dateRow +
        '<div id="stf-qp-notearea"></div>' +
        '<div class="stf-qp-row calcline"><span id="stf-qp-calc">Calculating…</span></div>' +
        '<div class="stf-qp-row">' +
        '  <label>Bonus/fine ± <input type="number" id="stf-qp-adj" value="' + (qp.adj || 0) + '" style="width:76px;"></label>' +
        '  <label id="stf-qp-ded-wrap" style="display:none;">Deduct advance ' +
        '    <input type="number" id="stf-qp-ded" min="0" value="' + (qp.ded != null ? qp.ded : 0) + '" style="width:88px;color:var(--stf-danger);font-weight:700;"></label>' +
        '  <span class="net">Net <b id="stf-qp-net">—</b></span>' +
        "</div>" +
        '<div class="stf-qp-row">' +
        sourceHtml("stf-qp-source").replace('<div class="form-group"><label class="form-label">Paid from</label>', "").replace(/<\/div>$/, "") +
        '  <button class="stf-btn primary" id="stf-qp-confirm" disabled>' +
        '<i class="fas fa-check"></i> Pay salary</button>' +
        "</div>";
    } else {
      body +=
        '<div class="stf-qp-row">' +
        '  <label>Amount ₹ <input type="number" id="stf-qp-amount" min="1" placeholder="0" style="width:96px;font-weight:700;"></label>' +
        '  <label>Date <input type="date" id="stf-qp-adv-date" value="' + today + '" max="' + today + '"></label>' +
        '  <label class="grow">Note <input type="text" id="stf-qp-note" maxlength="120" placeholder="optional"></label>' +
        "</div>" +
        '<div class="stf-qp-row">' +
        sourceHtml("stf-qp-source").replace('<div class="form-group"><label class="form-label">Paid from</label>', "").replace(/<\/div>$/, "") +
        '  <button class="stf-btn primary" id="stf-qp-confirm"><i class="fas fa-hand-holding-dollar"></i> Give advance</button>' +
        "</div>" +
        '<div class="stf-qp-row"><span class="hint">Deducted automatically from the next salary; the rest carries forward.</span></div>';
    }

    slot.innerHTML = '<div class="stf-qp">' + head + body + "</div>";

    // ── bindings ──
    document.getElementById("stf-qp-close").addEventListener("click", closeQuickPay);
    slot.querySelectorAll("[data-qpmode]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (!state.quickPay || state.quickPay.mode === b.dataset.qpmode) return;
        state.quickPay.mode = b.dataset.qpmode;
        renderQuickPay();          // structure change — a rebuild is correct
        _qpHighlightRange();       // grid highlight follows the mode, in place
        if (b.dataset.qpmode === "pay") fetchQuickPreview();
      });
    });

    _fpSweep();                      // drop pickers orphaned by this rebuild
    var rangeInp = document.getElementById("stf-qp-range");
    if (rangeInp && _fpLib()) {
      var rp = _fpLib()(rangeInp, {
        mode: "range",
        dateFormat: "d M",
        // Date OBJECT, not "Y-m-d" string — strings are parsed with
        // dateFormat ("d M"), which would silently fail here.
        maxDate: _ymdDate(today),
        defaultDate: [_ymdDate(qp.start), _ymdDate(qp.end)],
        disableMobile: true,
        locale: { rangeSeparator: " – " },
        onChange: function (sel) {
          var qp2 = state.quickPay;
          if (!qp2 || sel.length < 2) return;
          var a = _toYMD(sel[0]), b = _toYMD(sel[1]);
          if (a > b) { var t = a; a = b; b = t; }
          if (a === qp2.start && b === qp2.end) return;
          qp2.start = a; qp2.end = b;
          _qpHighlightRange();
          fetchQuickPreview();
        },
        onClose: function (sel, str, inst) {
          // One tap then dismiss = a single-day range.
          var qp2 = state.quickPay;
          if (!qp2 || sel.length !== 1) return;
          var a = _toYMD(sel[0]);
          qp2.start = a; qp2.end = a;
          inst.setDate([sel[0], sel[0]], false);
          _qpHighlightRange();
          fetchQuickPreview();
        },
      });
      _fpInstances.push(rp);
      qp._rangePicker = rp;
    }
    _modernDate("stf-qp-adv-date", { maxDate: today });

    var startInp = document.getElementById("stf-qp-start");
    var endInp = document.getElementById("stf-qp-end");
    function onDates() {
      var qp2 = state.quickPay;
      if (!qp2) return;
      if (startInp && startInp.value) qp2.start = startInp.value;
      if (endInp && endInp.value) qp2.end = endInp.value;
      if (qp2.start > qp2.end) {
        var t = qp2.start; qp2.start = qp2.end; qp2.end = t;
      }
      // In-place only: highlight follows on the existing grid DOM, numbers
      // refresh via _qpSync — the panel itself never rebuilds or collapses.
      _qpHighlightRange();
      fetchQuickPreview();
    }
    if (startInp) startInp.addEventListener("change", onDates);
    if (endInp) endInp.addEventListener("change", onDates);

    if (document.getElementById("stf-qp-source")) bindSource("stf-qp-source");

    var adjInp = document.getElementById("stf-qp-adj");
    var dedInp = document.getElementById("stf-qp-ded");
    if (adjInp) adjInp.addEventListener("input", function () {
      if (state.quickPay) state.quickPay.adj = parseInt(adjInp.value, 10) || 0;
      _qpRecalcNet();
    });
    if (dedInp) dedInp.addEventListener("input", function () {
      if (state.quickPay) {
        state.quickPay.dedTouched = true;
        state.quickPay.ded = parseInt(dedInp.value, 10) || 0;
      }
      _qpRecalcNet();
    });

    var confirmBtn = document.getElementById("stf-qp-confirm");
    if (confirmBtn) confirmBtn.addEventListener("click", function () {
      if (state.quickPay && state.quickPay.mode === "advance") return submitQuickAdvance(confirmBtn);
      submitQuickPay(confirmBtn);
    });

    _qpSync();
  }

  function submitQuickPay(btn) {
    var qp = state.quickPay;
    var s = _qpStaff();
    if (!qp || !s || !qp.preview) return;
    var pv = qp.preview;
    var outstanding = Number(pv.outstanding_advance || 0);
    var adj = parseInt(document.getElementById("stf-qp-adj")?.value, 10) || 0;
    var payable = pv.computed.gross + adj;
    var ded = Math.min(parseInt(document.getElementById("stf-qp-ded")?.value, 10) || 0,
      Math.min(outstanding, Math.max(0, payable)));
    var src = readSource("stf-qp-source");
    var msg = "Pay " + rup(payable - ded) + " to " + s.name + " for " +
      fmtDShort(qp.start) + " – " + fmtDShort(qp.end) +
      (ded ? " (after deducting " + rup(ded) + " advance)" : "") + "?";
    if (!confirm(msg)) return;
    btn.disabled = true;
    post("/staff/" + encodeURIComponent(qp.staffId) + "/pay_salary", {
      period_start: qp.start,
      period_end: qp.end,
      adjustment: adj,
      adjustment_note: "",
      advance_deduction: ded,
      payment_method: src.payment_method,
      expense_type: src.expense_type,
    })
      .then(function (json) {
        notify(json.message || "Salary paid", "success");
        state.quickPay = null;
        state.staffLoaded = false;       // outstanding / paid-until changed
        state.insights = null;
        state._gridLoadedMonth = null;   // paid-period locks changed
        _refreshMoneyViews();
        loadGrid();
      })
      .catch(function (e) { btn.disabled = false; notify(e.message, "error"); });
  }

  function submitQuickAdvance(btn) {
    var qp = state.quickPay;
    var s = _qpStaff();
    if (!qp || !s) return;
    var amount = parseInt(document.getElementById("stf-qp-amount")?.value, 10);
    if (!(amount > 0)) return notify("Enter the advance amount", "error");
    var src = readSource("stf-qp-source");
    btn.disabled = true;
    post("/staff/advance", {
      staff_id: qp.staffId,
      amount: amount,
      date: document.getElementById("stf-qp-adv-date")?.value || "",
      note: (document.getElementById("stf-qp-note")?.value || "").trim(),
      payment_method: src.payment_method,
      expense_type: src.expense_type,
    })
      .then(function (json) {
        notify(json.message || "Advance recorded", "success");
        state.quickPay = null;
        state.staffLoaded = false;
        state.insights = null;
        _refreshMoneyViews();
        loadGrid();
      })
      .catch(function (e) { btn.disabled = false; notify(e.message, "error"); });
  }

  // ═════════════════════════════════════════════════════════════════════════
  // INSIGHTS — payroll analytics dashboard (admin)
  // ═════════════════════════════════════════════════════════════════════════

  function monthShort(ym) {
    try {
      return new Date(ym + "-15T12:00:00").toLocaleDateString("en-IN", {
        month: "short",
      });
    } catch (_) { return ym; }
  }

  function monthLong(ym) {
    try {
      return new Date(ym + "-15T12:00:00").toLocaleDateString("en-IN", {
        month: "short", year: "numeric",
      });
    } catch (_) { return ym; }
  }

  function loadInsights() {
    var pane = document.getElementById("stf-pane-insights");
    var hasCache = !!state.insights;
    // Paint the last payload instantly (numbers refresh silently below) —
    // the tab must never sit on a spinner when we already know yesterday's
    // answer. First-ever open shows a shimmer skeleton instead.
    if (hasCache) renderInsights(state.insights);
    else pane.innerHTML = skeletonInsights();
    api("/staff/analytics")
      .then(function (json) {
        state.insights = json;
        if (_paneActive("stf-pane-insights")) renderInsights(json);
      })
      .catch(function (e) {
        if (hasCache) notify(e.message, "error");
        else pane.innerHTML = '<div class="stf-empty">' + esc(e.message) + "</div>";
      });
  }

  function renderInsights(a) {
    var pane = document.getElementById("stf-pane-insights");
    var t = a.totals || {};
    var thisMonth = _todayStr().slice(0, 7);

    // ── KPI tiles ──
    function kpi(icon, cls, value, label, sub) {
      return (
        '<div class="stf-kpi ' + cls + '">' +
        '  <div class="ic"><i class="fas ' + icon + '"></i></div>' +
        '  <div class="v">' + value + "</div>" +
        '  <div class="l">' + label + "</div>" +
        '  <div class="s">' + sub + "</div>" +
        "</div>");
    }
    var html =
      '<div class="stf-kpis">' +
      kpi("fa-wallet", "", rup(t.month_cash_out),
          "Paid out this month", "advances + salaries") +
      kpi("fa-coins", "", rup(t.month_wages_earned),
          "Wages earned so far", "days worked × wage") +
      kpi("fa-hand-holding-dollar", t.outstanding_advance > 0 ? "warn" : "",
          rup(t.outstanding_advance),
          "Advances outstanding", "to recover from salaries") +
      kpi("fa-user-check", "",
          (t.today_present || 0) + "<span>/" + (t.today_total || 0) + "</span>",
          "Present today", "full or half day") +
      "</div>";

    // ── monthly cash-out bar chart (single series — app primary hue) ──
    var months = a.months || [];
    var maxV = 1;
    months.forEach(function (m) { if (m.total > maxV) maxV = m.total; });
    html += '<div class="stf-section-title">Staff cash-out — last ' + months.length + " months</div>";
    html += '<div class="stf-chart" role="img" aria-label="Monthly staff cash-out">';
    months.forEach(function (m) {
      var pct = Math.round((100 * m.total) / maxV);
      var isNow = m.month === thisMonth;
      // Direct labels only where they earn their place: the current month
      // and the tallest bar; every bar carries a hover tooltip.
      var showLabel = isNow || (m.total === maxV && m.total > 0);
      html +=
        '<div class="stf-chart-col' + (isNow ? " now" : "") + '"' +
        ' title="' + esc(monthShort(m.month) + ": " + rup(m.total) +
          " (advances " + rup(m.advances) + " + salaries " + rup(m.salaries_net) + ")") + '">' +
        (showLabel ? '<div class="val">' + rup(m.total) + "</div>" : '<div class="val">&nbsp;</div>') +
        '  <div class="barwrap"><div class="bar" style="height:' + Math.max(m.total > 0 ? 4 : 0, pct) + '%"></div></div>' +
        "</div>";
    });
    html += "</div>";
    html += '<div class="stf-chart-labels">';
    months.forEach(function (m) {
      html += '<div class="lbl' + (m.month === thisMonth ? " now" : "") + '">' +
        esc(monthShort(m.month)) + "</div>";
    });
    html += "</div>";

    // ── per-staff table (this month) ──
    var rows = a.staff || [];
    html += '<div class="stf-section-title" style="display:flex;align-items:center;gap:0.5rem;">' +
      "This month by staff" +
      '<span style="flex:1;"></span>' +
      '<label class="stf-monthpick sm">' +
      '  <i class="far fa-calendar"></i>' +
      '  <span id="stf-reg-month-label">' + esc(monthLong(thisMonth)) + "</span>" +
      '  <input type="month" id="stf-reg-month" value="' + thisMonth + '" max="' + thisMonth + '" />' +
      "</label>" +
      '<button class="stf-btn success" id="stf-reg-dl">' +
      '  <i class="fas fa-file-arrow-down"></i> Download register</button>' +
      "</div>";

    if (!rows.length) {
      html += '<div class="stf-empty">No active staff.</div>';
    } else {
      html +=
        '<div class="stf-table-wrap"><table class="stf-table">' +
        "<thead><tr><th>Staff</th><th>Days</th><th>Att&nbsp;%</th>" +
        "<th>Wages</th><th>Advance</th><th>Paid till</th></tr></thead><tbody>";
      rows.forEach(function (r) {
        var rate = r.attendance_rate || 0;
        var band = rate >= 90 ? "good" : rate >= 60 ? "mid" : "low";
        html +=
          "<tr>" +
          '<td class="nm">' + esc(r.name) +
          (r.designation ? '<span class="ds">' + esc(r.designation) + "</span>" : "") + "</td>" +
          "<td>" + fmtDays(r.days_worked) +
          (r.absent_days ? '<span class="ds">' + r.absent_days + " absent</span>" : "") + "</td>" +
          '<td><span class="stf-rate ' + band + '"><span class="dot"></span>' + rate + "%</span></td>" +
          "<td>" + rup(r.wages_earned) + "</td>" +
          '<td class="' + (r.outstanding_advance > 0 ? "due" : "") + '">' +
          rup(r.outstanding_advance) + "</td>" +
          "<td>" + (r.paid_until ? fmtDShort(r.paid_until) : "—") + "</td>" +
          "</tr>";
      });
      html += "</tbody></table></div>";
      html += '<div class="stf-cal-legend"><span>Att % = days worked ÷ days ' +
        "elapsed this month. Wages = earned so far at the current per-day rate.</span></div>";
    }

    pane.innerHTML = html;

    var regInp = document.getElementById("stf-reg-month");
    var regLbl = document.getElementById("stf-reg-month-label");
    if (regInp) regInp.addEventListener("change", function () {
      if (regLbl && regInp.value) regLbl.textContent = monthLong(regInp.value);
    });
    var dlBtn = document.getElementById("stf-reg-dl");
    if (dlBtn) dlBtn.addEventListener("click", function () {
      downloadRegister((regInp && regInp.value) || thisMonth, dlBtn);
    });
  }

  // ── payroll register download (CSV — opens in Excel) ────────────────────

  function csvCell(v) {
    var s = String(v == null ? "" : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function downloadRegister(month, btn) {
    if (btn) btn.disabled = true;
    api("/staff/register?month=" + encodeURIComponent(month))
      .then(function (json) {
        var head = ["Name", "Designation", "Wage/day (Rs)", "Full days",
          "Half days", "Absent", "Days worked", "Wages earned (Rs)",
          "Advances taken (Rs)", "Salary paid net (Rs)",
          "Advance recovered (Rs)", "Advance outstanding (Rs)"];
        var lines = [csvCell("Staff payroll register — " + json.month +
          " (generated " + json.generated_on + ")"), head.map(csvCell).join(",")];
        (json.rows || []).forEach(function (r) {
          lines.push([
            r.name + (r.active === false ? " (inactive)" : ""),
            r.designation, r.daily_wage, r.full_days, r.half_days,
            r.absent_days, r.days_worked, r.wages_earned, r.advances_taken,
            r.salary_paid_net, r.advance_recovered, r.outstanding_advance,
          ].map(csvCell).join(","));
        });
        // ﻿ BOM so Excel opens it as UTF-8 (₹-free headers regardless).
        var blob = new Blob(["﻿" + lines.join("\r\n")],
          { type: "text/csv;charset=utf-8" });
        var aEl = document.createElement("a");
        aEl.href = URL.createObjectURL(blob);
        aEl.download = "staff_register_" + month + ".csv";
        document.body.appendChild(aEl);
        aEl.click();
        setTimeout(function () {
          URL.revokeObjectURL(aEl.href);
          aEl.remove();
        }, 500);
        notify("Register for " + month + " downloaded", "success");
      })
      .catch(function (e) { notify(e.message, "error"); })
      .then(function () { if (btn) btn.disabled = false; });
  }

  // ── printable salary slip ───────────────────────────────────────────────

  function printSalarySlip(p, staffName) {
    var w = window.open("", "_blank", "width=420,height=640");
    if (!w) { notify("Allow pop-ups to print the salary slip", "error"); return; }
    var e = esc;
    var rows =
      "<tr><td>Period</td><td>" + e(fmtD(p.period_start)) + " – " + e(fmtD(p.period_end)) + "</td></tr>" +
      "<tr><td>Days worked</td><td>" + e(fmtDays(p.days_worked)) +
      " (" + p.full_days + " full, " + p.half_days + " half)</td></tr>" +
      "<tr><td>Wage per day</td><td>" + e(rup(p.daily_wage)) + "</td></tr>" +
      "<tr><td>Wages earned</td><td>" + e(rup(p.gross)) + "</td></tr>" +
      (p.adjustment
        ? "<tr><td>Adjustment" + (p.adjustment_note ? " (" + e(p.adjustment_note) + ")" : "") +
          "</td><td>" + (p.adjustment > 0 ? "+" : "−") + e(rup(Math.abs(p.adjustment))) + "</td></tr>"
        : "") +
      (p.advance_deducted
        ? '<tr class="minus"><td>Advance deducted</td><td>− ' + e(rup(p.advance_deducted)) + "</td></tr>"
        : "") +
      '<tr class="net"><td>Net paid</td><td>' + e(rup(p.net_paid)) + "</td></tr>" +
      "<tr><td>Paid on</td><td>" + e(fmtD(p.paid_on)) +
      (p.expense_type === "report" ? " · from account" : " · cash") + "</td></tr>" +
      (_byLine(p.paid_by)
        ? "<tr><td>Recorded</td><td>" + e(_byLine(p.paid_by)) + "</td></tr>"
        : "");
    w.document.write(
      "<!DOCTYPE html><html><head><title>Salary Slip — " + e(staffName) + "</title>" +
      "<style>" +
      "body{font-family:Arial,Helvetica,sans-serif;margin:24px;color:#1a202c;}" +
      "h1{font-size:18px;margin:0 0 2px;}" +
      ".sub{color:#718096;font-size:12px;margin-bottom:14px;}" +
      "table{width:100%;border-collapse:collapse;font-size:13px;}" +
      "td{padding:7px 4px;border-bottom:1px solid #e2e8f0;}" +
      "td:last-child{text-align:right;font-weight:600;}" +
      "tr.minus td{color:#c53030;}" +
      "tr.net td{font-size:15px;font-weight:800;border-top:2px solid #1a202c;border-bottom:none;}" +
      ".sign{display:flex;justify-content:space-between;margin-top:56px;font-size:12px;color:#4a5568;}" +
      ".sign div{border-top:1px solid #718096;padding-top:5px;width:40%;text-align:center;}" +
      "@media print{body{margin:12px;}}" +
      "</style></head><body>" +
      "<h1>Salary Slip</h1>" +
      '<div class="sub">' + e(staffName) + " · generated " + e(fmtD(_todayStr())) + "</div>" +
      "<table>" + rows + "</table>" +
      '<div class="sign"><div>Received by</div><div>Authorised by</div></div>' +
      "<script>window.onload=function(){window.print();};<\/script>" +
      "</body></html>");
    w.document.close();
  }

  // ═════════════════════════════════════════════════════════════════════════
  // PAYROLL — staff cards
  // ═════════════════════════════════════════════════════════════════════════

  function loadPayroll() {
    var pane = document.getElementById("stf-pane-payroll");
    var hasCache = state.staffLoaded && state.staff.length > 0;
    if (hasCache) renderPayroll();
    else pane.innerHTML = skeletonCards();
    loadStaff(true)
      .then(function () {
        // Only repaint the cards list — never clobber an open form/ledger.
        if (_paneActive("stf-pane-payroll") && state.payView.name === "cards") {
          renderPayroll();
        }
      })
      .catch(function (e) {
        if (hasCache) notify(e.message, "error");
        else pane.innerHTML = '<div class="stf-empty">' + esc(e.message) + "</div>";
      });
  }

  function renderPayroll() {
    var v = state.payView;
    if (v.name === "add" || v.name === "edit") return renderStaffForm(v.staff);
    if (v.name === "advance") return renderAdvanceForm(v.staff);
    if (v.name === "pay") return renderPayForm(v.staff);
    if (v.name === "ledger") return renderLedger(v.staff);
    renderCards();
  }

  function renderCards() {
    var pane = document.getElementById("stf-pane-payroll");
    var rows = state.staff;

    var html =
      '<div class="stf-toolbar">' +
      (can("staff.manage")
        ? '<button class="stf-btn primary" id="stf-add-btn"><i class="fas fa-user-plus"></i> Add Staff</button>'
        : "") +
      '  <span class="spacer"></span>' +
      '  <label class="stf-inactive-toggle"><input type="checkbox" id="stf-inactive-chk"' +
      (state.includeInactive ? " checked" : "") + "> Show inactive</label>" +
      "</div>";

    if (!rows.length) {
      html += '<div class="stf-empty">No staff yet. Add your team to start ' +
        "tracking attendance, advances and salaries.</div>";
    } else {
      html += '<div class="stf-cards">';
      rows.forEach(function (s) {
        var adv = Number(s.outstanding_advance || 0);
        html +=
          '<div class="stf-card' + (s.active === false ? " inactive" : "") + '">' +
          '  <div class="stf-card-top">' +
          '    <div class="stf-avatar">' + initial(s.name) + "</div>" +
          '    <div class="who">' +
          '      <div class="nm">' + esc(s.name) +
          (s.active === false ? ' <span style="font-size:0.65rem;color:#e53e3e;font-weight:600;">(inactive)</span>' : "") +
          "      </div>" +
          '      <div class="ds">' + esc(s.designation || "") +
          (s.phone ? (s.designation ? " · " : "") + esc(s.phone) : "") + "</div>" +
          "    </div>" +
          '    <span class="stf-wage">' + rup(s.daily_wage) + "/day</span>" +
          "  </div>" +
          '  <div class="stf-card-stats">' +
          '    <span class="stf-stat">This month <b>' + fmtDays(s.month_days_worked) + "</b> days</span>" +
          '    <span class="stf-stat' + (adv > 0 ? " advance-due" : "") + '">Advance <b>' + rup(adv) + "</b></span>" +
          '    <span class="stf-stat">Paid till <b>' + (s.paid_until ? fmtDShort(s.paid_until) : "—") + "</b></span>" +
          "  </div>" +
          '  <div class="stf-card-actions">' +
          (can("staff.advance.give") && s.active !== false
            ? '<button class="stf-btn ghost" data-act="advance" data-sid="' + esc(s.id) + '"><i class="fas fa-hand-holding-dollar"></i> Advance</button>'
            : "") +
          (can("staff.salary.pay") && s.active !== false
            ? '<button class="stf-btn primary" data-act="pay" data-sid="' + esc(s.id) + '"><i class="fas fa-money-bill-wave"></i> Pay Salary</button>'
            : "") +
          '    <button class="stf-btn ghost" data-act="ledger" data-sid="' + esc(s.id) + '"><i class="fas fa-book-open"></i> Ledger</button>' +
          (can("staff.manage")
            ? '<button class="stf-btn ghost iconbtn" data-act="edit" data-sid="' + esc(s.id) + '" title="Edit"><i class="fas fa-pen"></i></button>'
            : "") +
          "  </div>" +
          "</div>";
      });
      html += "</div>";
    }

    pane.innerHTML = html;

    var addBtn = document.getElementById("stf-add-btn");
    if (addBtn) addBtn.addEventListener("click", function () {
      state.payView = { name: "add" };
      renderPayroll();
    });
    var chk = document.getElementById("stf-inactive-chk");
    if (chk) chk.addEventListener("change", function () {
      state.includeInactive = chk.checked;
      state.staffLoaded = false;
      loadPayroll();
    });
    pane.querySelectorAll("[data-act]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var s = state.staff.find(function (x) { return x.id === btn.dataset.sid; });
        if (!s) return;
        state.payView = { name: btn.dataset.act, staff: s };
        renderPayroll();
      });
    });
  }

  // Jump straight to one staff member's ledger (called from the
  // attendance grid's name column). Activates the payroll pane without
  // going through switchTab — that would reset the view to the cards.
  function openLedgerFor(staffId) {
    var s = state.staff.find(function (x) { return x.id === staffId; });
    if (!s || !can("staff.payroll.view")) return;
    var modal = document.getElementById("staff-modal");
    if (!modal) return;
    _closeCellPop();
    modal.querySelectorAll(".stf-tab-btn").forEach(function (b) {
      b.classList.toggle("active", b.dataset.stab === "payroll");
    });
    modal.querySelectorAll(".stf-tab-pane").forEach(function (p) {
      p.classList.toggle("active", p.id === "stf-pane-payroll");
    });
    state.payView = { name: "ledger", staff: s };
    renderPayroll();
  }

  function backToCards(reload) {
    state.payView = { name: "cards" };
    if (reload) { state.staffLoaded = false; loadPayroll(); }
    else renderPayroll();
    if (typeof window.invalidateExpenseStaffCache === "function") {
      window.invalidateExpenseStaffCache();
    }
  }

  // ── Add / edit staff ────────────────────────────────────────────────────

  function renderStaffForm(staff) {
    var pane = document.getElementById("stf-pane-payroll");
    var isEdit = !!staff;
    var s = staff || {};
    pane.innerHTML =
      '<div class="stf-form">' +
      '  <button class="stf-back-btn" id="stf-form-back">&#8249; Back</button>' +
      '  <div class="stf-form-title">' + (isEdit ? "Edit " + esc(s.name) : "Add Staff Member") + "</div>" +
      '  <div class="form-group"><label class="form-label">Name *</label>' +
      '    <input class="form-control" id="stf-f-name" maxlength="60" value="' + esc(s.name || "") + '" placeholder="e.g. Ramu"></div>' +
      '  <div class="stf-two-col">' +
      '    <div class="form-group"><label class="form-label">Role / Designation</label>' +
      '      <input class="form-control" id="stf-f-designation" maxlength="40" value="' + esc(s.designation || "") + '" placeholder="e.g. Housekeeping"></div>' +
      '    <div class="form-group"><label class="form-label">Phone</label>' +
      '      <input class="form-control" id="stf-f-phone" maxlength="20" value="' + esc(s.phone || "") + '" placeholder="Optional"></div>' +
      "  </div>" +
      '  <div class="stf-two-col">' +
      '    <div class="form-group"><label class="form-label">Wage per full day (₹) *</label>' +
      '      <input class="form-control" type="number" min="1" id="stf-f-wage" value="' + (s.daily_wage || "") + '" placeholder="e.g. 500"></div>' +
      '    <div class="form-group"><label class="form-label">Joined on</label>' +
      '      <input class="form-control" type="date" id="stf-f-joined" value="' + esc(s.joined_date || _todayStr()) + '"></div>' +
      "  </div>" +
      '  <div class="form-group"><label class="form-label">Notes</label>' +
      '    <input class="form-control" id="stf-f-notes" maxlength="300" value="' + esc(s.notes || "") + '" placeholder="Optional"></div>' +
      '  <div class="form-group"><label class="stf-inactive-toggle" style="font-size:0.85rem;">' +
      '<input type="checkbox" id="stf-f-dual"' + (s.is_dual_shift ? " checked" : "") + "> Works two shifts (Day &amp; Night) " +
      '<span style="opacity:0.7;">(attendance grid gets a separate D row and N row for this person)</span></label></div>' +
      (isEdit
        ? '<div class="form-group"><label class="stf-inactive-toggle" style="font-size:0.85rem;">' +
          '<input type="checkbox" id="stf-f-active"' + (s.active !== false ? " checked" : "") + "> Active " +
          '<span style="opacity:0.7;">(untick when someone leaves — history is kept)</span></label></div>'
        : "") +
      '  <div style="font-size:0.72rem;color:#718096;margin-bottom:0.7rem;">' +
      "    A half day pays half the daily wage. Wage changes apply from the next salary payment. " +
      "Two-shift staff earn up to two days' wage per day worked (one per shift)." +
      "  </div>" +
      '  <button class="stf-btn primary block" id="stf-f-save">' +
      (isEdit ? "Save Changes" : "Add Staff") + "</button>" +
      "</div>";

    _modernDate("stf-f-joined", {});
    document.getElementById("stf-form-back").addEventListener("click", function () {
      backToCards(false);
    });
    document.getElementById("stf-f-save").addEventListener("click", function () {
      var body = {
        name: document.getElementById("stf-f-name").value.trim(),
        designation: document.getElementById("stf-f-designation").value.trim(),
        phone: document.getElementById("stf-f-phone").value.trim(),
        daily_wage: document.getElementById("stf-f-wage").value,
        joined_date: document.getElementById("stf-f-joined").value,
        notes: document.getElementById("stf-f-notes").value.trim(),
        is_dual_shift: document.getElementById("stf-f-dual").checked,
      };
      if (!body.name) return notify("Name is required", "error");
      if (!(Number(body.daily_wage) > 0)) return notify("Enter the per-day wage", "error");
      var req;
      if (isEdit) {
        var activeChk = document.getElementById("stf-f-active");
        if (activeChk) body.active = activeChk.checked;
        req = api("/staff/" + encodeURIComponent(s.id), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        req = post("/staff/create", body);
      }
      req.then(function () {
        notify(isEdit ? "Staff updated" : "Staff added", "success");
        backToCards(true);
      }).catch(function (e) { notify(e.message, "error"); });
    });
  }

  // ── Source (money origin) segmented control ─────────────────────────────
  // Mirrors the expense modal's semantics:
  //   counter → payment_method "cash",  expense_type "transaction"
  //             (deducted from today's cash counter)
  //   account → payment_method "online", expense_type "report"
  //             (paid from bank / UPI — a "report" expense)

  function sourceHtml(id) {
    // Managers pay from counter cash only (custody rule — enforced
    // server-side too); the Account/UPI option renders only for roles
    // with staff.pay.account (admin).
    var accountBtn = can("staff.pay.account")
      ? '  <button type="button" data-src="account">' +
        '    <span><i class="fas fa-university"></i> Account / UPI</span><small>bank or online</small>' +
        "  </button>"
      : "";
    return (
      '<div class="form-group"><label class="form-label">Paid from</label>' +
      '<div class="stf-source" id="' + id + '">' +
      '  <button type="button" data-src="counter" class="sel">' +
      '    <span><i class="fas fa-store"></i> Cash counter</span><small>today\'s drawer cash</small>' +
      "  </button>" +
      accountBtn +
      "</div></div>"
    );
  }

  function bindSource(id) {
    var wrap = document.getElementById(id);
    wrap.querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () {
        wrap.querySelectorAll("button").forEach(function (x) {
          x.classList.toggle("sel", x === b);
        });
      });
    });
  }

  function readSource(id) {
    var sel = document.querySelector("#" + id + " button.sel");
    var src = sel ? sel.dataset.src : "counter";
    return src === "account"
      ? { payment_method: "online", expense_type: "report" }
      : { payment_method: "cash", expense_type: "transaction" };
  }

  // ── Give advance ────────────────────────────────────────────────────────

  function renderAdvanceForm(staff) {
    var pane = document.getElementById("stf-pane-payroll");
    var outstanding = Number(staff.outstanding_advance || 0);
    pane.innerHTML =
      '<div class="stf-form">' +
      '  <button class="stf-back-btn" id="stf-adv-back">&#8249; Back</button>' +
      '  <div class="stf-form-title"><i class="fas fa-hand-holding-usd" style="color:#c53030;"></i> Advance — ' + esc(staff.name) + "</div>" +
      '  <div class="stf-outstanding-banner' + (outstanding > 0 ? "" : " clear") + '">' +
      "    <span>Current outstanding advance</span><b>" + rup(outstanding) + "</b>" +
      "  </div>" +
      '  <div class="stf-two-col">' +
      '    <div class="form-group"><label class="form-label">Amount (₹) *</label>' +
      '      <input class="form-control" type="number" min="1" id="stf-adv-amount" placeholder="0" style="font-weight:700;"></div>' +
      '    <div class="form-group"><label class="form-label">Date</label>' +
      '      <input class="form-control" type="date" id="stf-adv-date" value="' + _todayStr() + '" max="' + _todayStr() + '"></div>' +
      "  </div>" +
      sourceHtml("stf-adv-source") +
      '  <div class="form-group"><label class="form-label">Note</label>' +
      '    <input class="form-control" id="stf-adv-note" maxlength="120" placeholder="Optional — e.g. festival, medical"></div>' +
      '  <div style="font-size:0.72rem;color:#718096;margin-bottom:0.7rem;">' +
      "    The advance is recorded in expenses too, and gets deducted from " +
      "    the next salary. Anything not recovered carries forward automatically." +
      "  </div>" +
      '  <button class="stf-btn primary block" id="stf-adv-save"><i class="fas fa-hand-holding-dollar"></i> Give Advance</button>' +
      "</div>";

    _modernDate("stf-adv-date", { maxDate: _todayStr() });
    document.getElementById("stf-adv-back").addEventListener("click", function () {
      backToCards(false);
    });
    bindSource("stf-adv-source");
    document.getElementById("stf-adv-save").addEventListener("click", function () {
      var amount = parseInt(document.getElementById("stf-adv-amount").value, 10);
      if (!(amount > 0)) return notify("Enter the advance amount", "error");
      var src = readSource("stf-adv-source");
      var btn = document.getElementById("stf-adv-save");
      btn.disabled = true;
      post("/staff/advance", {
        staff_id: staff.id,
        amount: amount,
        date: document.getElementById("stf-adv-date").value,
        note: document.getElementById("stf-adv-note").value.trim(),
        payment_method: src.payment_method,
        expense_type: src.expense_type,
      })
        .then(function (json) {
          notify(json.message || "Advance recorded", "success");
          _refreshMoneyViews();
          backToCards(true);
        })
        .catch(function (e) { btn.disabled = false; notify(e.message, "error"); });
    });
  }

  // ── Pay salary ──────────────────────────────────────────────────────────

  function renderPayForm(staff) {
    var pane = document.getElementById("stf-pane-payroll");
    var defStart = staff.suggested_period_start || staff.joined_date ||
      _todayStr().slice(0, 8) + "01";
    if (defStart > _todayStr()) defStart = _todayStr();
    pane.innerHTML =
      '<div class="stf-form">' +
      '  <button class="stf-back-btn" id="stf-pay-back">&#8249; Back</button>' +
      '  <div class="stf-form-title"><i class="fas fa-money-bill-wave" style="color:#276749;"></i> Pay Salary — ' + esc(staff.name) +
      '    <span style="font-weight:500;font-size:0.78rem;color:#a0aec0;">· ' + rup(staff.daily_wage) + "/day</span></div>" +
      '  <div class="stf-two-col">' +
      '    <div class="form-group"><label class="form-label">From *</label>' +
      '      <input class="form-control" type="date" id="stf-pay-start" value="' + esc(defStart) + '" max="' + _todayStr() + '"></div>' +
      '    <div class="form-group"><label class="form-label">To *</label>' +
      '      <input class="form-control" type="date" id="stf-pay-end" value="' + _todayStr() + '" max="' + _todayStr() + '"></div>' +
      "  </div>" +
      (staff.paid_until
        ? '<div style="font-size:0.72rem;color:#718096;margin:-0.3rem 0 0.6rem;">Already paid till ' + fmtD(staff.paid_until) + " — periods cannot overlap.</div>"
        : "") +
      '  <div id="stf-pay-preview"><div class="stf-empty" style="padding:1rem;">Pick the period to see the breakdown…</div></div>' +
      "</div>";

    document.getElementById("stf-pay-back").addEventListener("click", function () {
      backToCards(false);
    });

    var startInp = document.getElementById("stf-pay-start");
    var endInp = document.getElementById("stf-pay-end");
    startInp.addEventListener("change", fetchPreview);
    endInp.addEventListener("change", fetchPreview);
    // Same modern calendar as the Transactions tab — flatpickr fires
    // "change" on the original inputs, so fetchPreview wiring is untouched.
    _modernDate("stf-pay-start", { maxDate: _todayStr() });
    _modernDate("stf-pay-end", { maxDate: _todayStr() });
    fetchPreview();

    function fetchPreview() {
      var start = startInp.value, end = endInp.value;
      var box = document.getElementById("stf-pay-preview");
      if (!start || !end) return;
      box.innerHTML = '<div class="stf-empty" style="padding:1rem;">Calculating…</div>';
      api("/staff/" + encodeURIComponent(staff.id) +
          "/salary_preview?start=" + start + "&end=" + end)
        .then(function (json) {
          state.payPreview = json;
          renderPayBreakdown(staff, json);
        })
        .catch(function (e) {
          box.innerHTML = '<div class="stf-empty" style="padding:1rem;color:#c53030;">' + esc(e.message) + "</div>";
        });
    }
  }

  function renderPayBreakdown(staff, pv) {
    var box = document.getElementById("stf-pay-preview");
    var c = pv.computed;
    var outstanding = Number(pv.outstanding_advance || 0);

    var html = "";
    if (pv.all_days_paid) {
      html +=
        '<div class="stf-carry-note" style="background:#fff5f5;border-color:#fed7d7;color:#742a2a;">' +
        "⚠ Every day in this range is already paid — nothing left to settle. Adjust the dates.</div>";
    } else if (pv.excluded_days && pv.excluded_days.length) {
      html +=
        '<div class="stf-carry-note">' +
        "ℹ " + pv.excluded_days.length + " already-paid day" +
        (pv.excluded_days.length > 1 ? "s" : "") + " (" +
        esc(pv.excluded_days.map(fmtDShort).join(", ")) +
        ") will be skipped — this payout covers only the unpaid days.</div>";
    }
    html +=
      '<div class="stf-sheet">' +
      '  <div class="stf-sheet-row"><span>Full days</span><b>' + c.full_days + "</b></div>" +
      '  <div class="stf-sheet-row"><span>Half days</span><b>' + c.half_days + "</b></div>" +
      '  <div class="stf-sheet-row"><span>Days worked</span><b>' + fmtDays(c.days_worked) + "</b></div>" +
      '  <div class="stf-sheet-row"><span>Wages (' + fmtDays(c.days_worked) + " × " + rup(c.daily_wage) + ")</span><b>" + rup(c.gross) + "</b></div>" +
      "</div>" +
      '  <div class="stf-two-col">' +
      '    <div class="form-group"><label class="form-label">Bonus / fine (±₹)</label>' +
      '      <input class="form-control" type="number" id="stf-pay-adj" value="0"></div>' +
      '    <div class="form-group"><label class="form-label">Adjustment note</label>' +
      '      <input class="form-control" id="stf-pay-adj-note" maxlength="120" placeholder="Why?"></div>' +
      "  </div>" +
      '  <div class="stf-outstanding-banner' + (outstanding > 0 ? "" : " clear") + '" style="margin-bottom:0.6rem;">' +
      "    <span>Outstanding advance</span><b>" + rup(outstanding) + "</b>" +
      "  </div>" +
      (outstanding > 0
        ? '<div class="form-group"><label class="form-label">Deduct from this salary (₹)</label>' +
          '  <input class="form-control" type="number" min="0" max="' + outstanding + '" id="stf-pay-deduct" value="' + pv.suggested_deduction + '" style="font-weight:700;color:#c53030;"></div>'
        : '<input type="hidden" id="stf-pay-deduct" value="0">') +
      '  <div class="stf-sheet" id="stf-pay-net-sheet"></div>' +
      '  <div id="stf-pay-carry"></div>' +
      sourceHtml("stf-pay-source") +
      '  <button class="stf-btn primary block" id="stf-pay-confirm"><i class="fas fa-check"></i> Confirm &amp; Pay</button>';

    box.innerHTML = html;
    bindSource("stf-pay-source");

    var adjInp = document.getElementById("stf-pay-adj");
    var dedInp = document.getElementById("stf-pay-deduct");
    adjInp.addEventListener("input", recalc);
    if (dedInp.tagName === "INPUT" && dedInp.type === "number") {
      dedInp.addEventListener("input", recalc);
    }
    recalc();

    function recalc() {
      var adj = parseInt(adjInp.value, 10) || 0;
      var ded = parseInt(dedInp.value, 10) || 0;
      var payable = c.gross + adj;
      var maxDed = Math.min(outstanding, Math.max(0, payable));
      var warn = "";
      if (ded > maxDed) {
        warn = "Deduction is capped at " + rup(maxDed) +
          (outstanding > payable ? " (this salary). The rest carries forward." : ".");
        ded = maxDed;
      }
      var net = payable - ded;
      var remaining = outstanding - ded;

      document.getElementById("stf-pay-net-sheet").innerHTML =
        '<div class="stf-sheet-row"><span>Wages + adjustment</span><b>' + rup(payable) + "</b></div>" +
        '<div class="stf-sheet-row minus"><span>Advance deducted</span><b>− ' + rup(ded) + "</b></div>" +
        '<div class="stf-sheet-row total"><span>Net to pay now</span><span>' + rup(net) + "</span></div>";

      var carry = document.getElementById("stf-pay-carry");
      var notes = [];
      if (warn) notes.push(warn);
      if (remaining > 0) {
        notes.push(rup(remaining) + " advance remains and will be deducted from the next salary.");
      }
      if (net === 0 && payable > 0) {
        notes.push("Nothing is handed over — the whole salary goes against the advance.");
      }
      carry.innerHTML = notes.length
        ? '<div class="stf-carry-note">' + esc(notes.join(" ")) + "</div>" : "";
    }

    document.getElementById("stf-pay-confirm").addEventListener("click", function () {
      var adj = parseInt(adjInp.value, 10) || 0;
      var ded = parseInt(dedInp.value, 10) || 0;
      var payable = c.gross + adj;
      ded = Math.min(ded, Math.min(outstanding, Math.max(0, payable)));
      var net = payable - ded;
      var src = readSource("stf-pay-source");
      var msg = "Pay " + rup(net) + " to " + staff.name + " for " +
        fmtDShort(pv.period_start) + " – " + fmtDShort(pv.period_end) +
        (ded ? " (after deducting " + rup(ded) + " advance)" : "") + "?";
      if (!confirm(msg)) return;
      var btn = document.getElementById("stf-pay-confirm");
      btn.disabled = true;
      btn.textContent = "Paying…";
      post("/staff/" + encodeURIComponent(staff.id) + "/pay_salary", {
        period_start: pv.period_start,
        period_end: pv.period_end,
        adjustment: adj,
        adjustment_note: document.getElementById("stf-pay-adj-note").value.trim(),
        advance_deduction: ded,
        payment_method: src.payment_method,
        expense_type: src.expense_type,
      })
        .then(function (json) {
          notify(json.message || "Salary paid", "success");
          _refreshMoneyViews();
          backToCards(true);
        })
        .catch(function (e) {
          btn.disabled = false;
          btn.textContent = "Confirm & Pay";
          notify(e.message, "error");
        });
    });
  }

  // ── Ledger (advances + salary history for one staff member) ─────────────

  function renderLedger(staff) {
    var pane = document.getElementById("stf-pane-payroll");
    pane.innerHTML = '<div class="stf-empty">Loading…</div>';
    api("/staff/" + encodeURIComponent(staff.id) + "/detail")
      .then(function (json) {
        var items = [];
        (json.advances || []).forEach(function (a) {
          items.push({
            kind: "advance", id: a.id, date: a.date, advance: a,
            sort: (a.date || "") + "A" + (a.created_at || ""),
          });
        });
        (json.salary_payments || []).forEach(function (p) {
          items.push({
            kind: "salary", id: p.id, date: p.paid_on, payment: p,
            sort: (p.paid_on || p.period_end || "") + "S",
          });
        });
        items.sort(function (a, b) { return a.sort < b.sort ? 1 : -1; });

        // ── advance totals for the summary strip ──
        var advGiven = (json.advances || []).reduce(function (t, a) {
          return t + (Number(a.amount) || 0);
        }, 0);
        var advRecovered = (json.salary_payments || []).reduce(function (t, p) {
          return t + (Number(p.advance_deducted) || 0);
        }, 0);

        var outstanding = Number(json.outstanding_advance || 0);
        var html =
          '<button class="stf-back-btn" id="stf-led-back">&#8249; Back</button>' +
          '<div class="stf-form-title">' + esc(staff.name) + " — Ledger</div>" +
          // The advance story in one line: given → recovered → still due.
          '<div class="stf-led-sum">' +
          '  <div><span>Advance given</span><b>' + rup(advGiven) + "</b></div>" +
          '  <div class="arrow">−</div>' +
          '  <div><span>Cut from salaries</span><b>' + rup(advRecovered) + "</b></div>" +
          '  <div class="arrow">=</div>' +
          '  <div class="' + (outstanding > 0 ? "due" : "clear") + '">' +
          '    <span>Still to recover</span><b>' + rup(outstanding) + "</b></div>" +
          "</div>";

        if (!items.length) {
          html += '<div class="stf-empty">No advances or salary payments yet.</div>';
        } else {
          html += '<div class="stf-ledger-list">';
          items.forEach(function (it) {
            var canDel = can("staff.manage");   // reversals are admin-only
            var title, detail, amtHtml;

            if (it.kind === "advance") {
              var a = it.advance;
              var aBy = _byLine(a.created_by);
              title = "Advance given" + (a.note ? " — " + esc(a.note) : "");
              detail = '<span class="muted">' + esc(fmtD(a.date)) +
                (a.expense_type === "report" ? " · account" : " · counter cash") +
                (aBy ? " · " + esc(aBy) : "") +
                "</span>";
              amtHtml = '<div class="amt adv-amt">' + rup(a.amount) + "</div>" +
                '<div class="amt-lbl">to recover</div>';
            } else {
              var p = it.payment;
              var dayWord = Number(p.days_worked) === 1 ? "day" : "days";
              title = "Salary · " + esc(fmtDShort(p.period_start)) + " – " +
                esc(fmtDShort(p.period_end));
              detail =
                '<span class="calc">Earned <b>' + rup(p.gross) + "</b> (" +
                fmtDays(p.days_worked) + " " + dayWord + " × " +
                rup(p.daily_wage) + ")</span>" +
                (p.adjustment
                  ? '<span class="chip bonus">' +
                    (p.adjustment > 0 ? "+ " : "− ") +
                    rup(Math.abs(p.adjustment)) +
                    (p.adjustment > 0 ? " bonus" : " fine") + "</span>"
                  : "") +
                (p.advance_deducted
                  ? '<span class="chip cut">− ' + rup(p.advance_deducted) +
                    " advance cut</span>"
                  : "") +
                (p.excluded_dates && p.excluded_dates.length
                  ? '<span class="muted">' + p.excluded_dates.length +
                    " already-paid day" +
                    (p.excluded_dates.length > 1 ? "s" : "") + " skipped</span>"
                  : "") +
                (_byLine(p.paid_by)
                  ? '<span class="muted">paid ' + esc(_byLine(p.paid_by)) + "</span>"
                  : "");
              amtHtml = '<div class="amt sal-amt">' + rup(p.net_paid) + "</div>" +
                '<div class="amt-lbl">' +
                (p.net_paid === 0 && p.advance_deducted
                  ? "fully adjusted<br>against advance"
                  : "paid in hand") + "</div>";
            }

            html +=
              '<div class="stf-ledger-item">' +
              '  <div class="ic ' + (it.kind === "advance" ? "adv" : "sal") + '">' +
              '    <i class="fas ' + (it.kind === "advance" ? "fa-hand-holding-usd" : "fa-money-bill-wave") + '"></i></div>' +
              '  <div class="what"><div class="l1">' + title + "</div>" +
              '    <div class="l2">' + detail + "</div></div>" +
              '  <div class="amt-col">' + amtHtml + "</div>" +
              (it.kind === "salary"
                ? '<button class="del-btn slip-btn" data-slip="' + esc(it.id) + '" title="Print salary slip"><i class="fas fa-print"></i></button>'
                : "") +
              (canDel
                ? '<button class="del-btn" data-kind="' + it.kind + '" data-id="' + esc(it.id) + '" title="Delete / reverse"><i class="fas fa-trash-alt"></i></button>'
                : "") +
              "</div>";
          });
          html += "</div>";
        }

        pane.innerHTML = html;
        document.getElementById("stf-led-back").addEventListener("click", function () {
          backToCards(false);
        });
        pane.querySelectorAll(".slip-btn").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var it = items.find(function (x) { return x.id === btn.dataset.slip; });
            if (it && it.payment) printSalarySlip(it.payment, staff.name);
          });
        });
        pane.querySelectorAll(".del-btn:not(.slip-btn)").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var kind = btn.dataset.kind, id = btn.dataset.id;
            var q = kind === "advance"
              ? "Delete this advance? Its expense entry is removed too."
              : "Reverse this salary payment? The period opens again and " +
                "any deducted advance becomes outstanding once more.";
            if (!confirm(q)) return;
            var url = kind === "advance"
              ? "/staff/advance/" + encodeURIComponent(id)
              : "/staff/salary/" + encodeURIComponent(id);
            del(url)
              .then(function (json) {
                notify(json.message || "Deleted", "success");
                _refreshMoneyViews();
                state.staffLoaded = false;
                loadStaff(true).then(function () {
                  var fresh = state.staff.find(function (x) { return x.id === staff.id; });
                  state.payView = { name: "ledger", staff: fresh || staff };
                  renderPayroll();
                });
              })
              .catch(function (e) { notify(e.message, "error"); });
          });
        });
      })
      .catch(function (e) {
        pane.innerHTML = '<div class="stf-empty">' + esc(e.message) + "</div>";
      });
  }

  // Advances / salaries create or delete expense rows — nudge the
  // transaction views the same way expense.js does after a save.
  function _refreshMoneyViews() {
    try {
      if (typeof window.refreshTransactionsView === "function") {
        window.refreshTransactionsView();
      } else if (typeof debouncedFetchData === "function") {
        debouncedFetchData();
      }
    } catch (_) { /* transactions tab not loaded — nothing to refresh */ }
  }

  // ── bootstrap ───────────────────────────────────────────────────────────

  function bind() {
    var btn = document.getElementById("quick-staff-btn");
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

  window.openStaffModal = openModal;

  // Deep-link from the expense modal's Salary category: open the Staff
  // modal on the attendance grid and pop the quick-pay panel for one
  // staff member. The grid loads async, so poll until this month's data
  // (staff list + paid periods) is in memory before opening the panel.
  window.openStaffQuickPay = function (staffId) {
    openModal();
    var tries = 0;
    (function waitReady() {
      var ready =
        state.staffLoaded &&
        state._gridLoadedMonth === state.gridMonth &&
        state.staff.some(function (s) { return s.id === staffId; });
      if (ready) { openQuickPay(staffId, true); return; }
      if (tries++ < 60) setTimeout(waitReady, 100);   // give up after ~6s
    })();
  };
})();
