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
    if (typeof showNotification === "function") { showNotification(msg, type || "info"); return; }
    // Fallback in-app toast — never a browser alert() popup.
    var t = document.createElement("div");
    t.className = "stf-toast stf-toast-" + (type || "info");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add("show"); }, 10);
    setTimeout(function () { t.classList.remove("show"); setTimeout(function () { t.remove(); }, 250); }, 3200);
  }

  // Styled confirm dialog — replaces the browser confirm() popup. Returns a
  // Promise<boolean>. `opts`: { okText, cancelText, danger }.
  function stfConfirm(message, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var ov = document.createElement("div");
      ov.className = "stf-confirm-ov";
      ov.innerHTML =
        '<div class="stf-confirm" role="dialog" aria-modal="true">' +
        '  <div class="stf-confirm-msg">' + esc(message) + "</div>" +
        '  <div class="stf-confirm-actions">' +
        '    <button type="button" class="stf-confirm-cancel">' + esc(opts.cancelText || "Cancel") + "</button>" +
        '    <button type="button" class="stf-confirm-ok' + (opts.danger ? " danger" : "") + '">' + esc(opts.okText || "Confirm") + "</button>" +
        "  </div></div>";
      document.body.appendChild(ov);
      requestAnimationFrame(function () { ov.classList.add("show"); });
      function done(val) {
        ov.classList.remove("show");
        setTimeout(function () { ov.remove(); }, 200);
        resolve(val);
      }
      ov.querySelector(".stf-confirm-ok").addEventListener("click", function () { done(true); });
      ov.querySelector(".stf-confirm-cancel").addEventListener("click", function () { done(false); });
      ov.addEventListener("click", function (e) { if (e.target === ov) done(false); });
    });
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

  // Dates are shown numerically as DD-MM-YYYY across the app. Both of these
  // work on the stored "YYYY-MM-DD" string directly rather than going through
  // a Date, so no timezone conversion can shift the day.
  function fmtD(dateStr) {
    if (!dateStr) return "\u2014";
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr));
    return m ? m[3] + "-" + m[2] + "-" + m[1] : String(dateStr);
  }

  // Compact variant for dense lists (skipped-day chips, ledger rows, the
  // "paid till" line). Keeps a 2-digit year: "07-08" on its own reads
  // equally as 7 Aug and 8 Jul, and paid_until is often months old.
  function fmtDShort(dateStr) {
    if (!dateStr) return "\u2014";
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr));
    return m ? m[3] + "-" + m[2] + "-" + m[1].slice(2) : String(dateStr);
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

  // In-flight de-duplication. `state.staffLoaded` only guards a COMPLETED
  // load, so two callers a few ms apart (the Staff nav handler and
  // openStaffQuickPay both run openModal) each fired their own request.
  var _staffInflight = null;

  function loadStaff(force) {
    if (state.staffLoaded && !force) return Promise.resolve(state.staff);
    if (_staffInflight && !force) return _staffInflight;
    var url = "/staff/list" + (state.includeInactive ? "?all=1" : "");
    var p = api(url).then(function (json) {
      state.staff = json.staff || [];
      state.payrollVisible = !!json.payroll_visible;
      state.staffLoaded = true;
      return state.staff;
    });
    _staffInflight = p;
    p.catch(function () {}).then(function () {
      if (_staffInflight === p) _staffInflight = null;
    });
    return p;
  }

  function activeStaff() {
    return state.staff.filter(function (s) { return s.active !== false; });
  }

  // Refresh hook for other modules (expense modal advances) and after
  // any payroll mutation here.
  window.refreshStaffModule = function () {
    state.staffLoaded = false;
    var modal = document.getElementById("staff-modal");
    // Staff is a tab now (#staff-tab, toggled via .hidden) rather than a
    // modal toggled via .show — check the tab wrapper's visibility instead.
    var tabWrap = document.getElementById("staff-tab");
    if (modal && tabWrap && !tabWrap.classList.contains("hidden")) {
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

  // Staff is a full tab now (bottom nav), not a modal — #staff-tab is the
  // empty <div class="tab-content hidden" id="staff-tab"></div> placeholder
  // in index.html (same pattern as bills-tab/banking-tab, populated by
  // their own JS). We inject the module's markup into it instead of
  // appending to document.body, and drop .modal-backdrop from the wrapper
  // (no backdrop / centering / click-outside-to-close for a tab) while
  // keeping .modal-content for its base card styling, same as #laundry-modal.
  function ensureModal() {
    if (document.getElementById("staff-modal")) return;
    var container = document.getElementById("staff-tab");
    if (!container) {
      console.error("staff.js: #staff-tab placeholder not found in DOM");
      return;
    }
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
      '<div class="modal-content stf-shell" id="staff-modal">' +
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
      "</div>";
    container.insertAdjacentHTML("beforeend", html);

    var modal = document.getElementById("staff-modal");
    // × now backs out to Rooms — there's no "closed" state for a tab.
    modal.querySelector(".stf-close").addEventListener("click", closeModal);
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
    // The quick pay/advance panel is rendered inside one pane. Leaving it open
    // across a tab switch would strand it in the pane the user just left, so
    // drop it — the panes re-render below and repaint from this state.
    state.quickPay = null;
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

  // Staff is a full tab now — the generic nav-item handler in script.js
  // already hides every other .tab-content and un-hides #staff-tab before
  // calling this, so openModal() only needs to build the content (first
  // time) and refresh it, not toggle any visibility class itself.
  function openModal() {
    ensureModal();
    var sub = document.getElementById("stf-head-sub");
    if (sub) {
      sub.textContent = new Date().toLocaleDateString("en-IN", {
        weekday: "long", day: "numeric", month: "long", year: "numeric",
      });
    }
    switchTab("attendance");
  }
  // The header's × button now just backs out to Rooms — there's no
  // "closed" state for a tab, only "some other tab is showing instead".
  function closeModal() {
    _closeCellPop();
    document.querySelector('.nav-item[data-tab="rooms"]')?.click();
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

  // Last day of a pay week. Salary here runs Tuesday → Monday, so Monday is
  // where one week's wages end and the next week's begin; the grid draws a
  // heavier rule down the right of every Monday to mark the boundary.
  function _isPayWeekEnd(ym, day) {
    return new Date(_dstr(ym, day) + "T12:00:00").getDay() === 1;   // Monday
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
      // DD-MM-YYYY h:mm am/pm, in IST. Numeric date to match the rest of the
      // app; the time part still goes through Intl for the am/pm.
      var parts = d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
      var time = d.toLocaleTimeString("en-IN", {
        timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit",
      });
      return fmtD(parts) + ", " + time;
    } catch (_) { return d.toLocaleString(); }
  }

  // "by NAME" chip for ledger rows / slips. Empty string when unknown
  // (records created before the audit trail existed).
  function _byLine(stamp) {
    var n = stamp && stamp.name;
    return n && n !== "system" ? "by " + n : "";
  }

  // Ledger caption for the days a salary payment did NOT pay for. Two
  // reasons, and they read very differently to whoever is auditing the row:
  // an already-paid day is fine, an unmarked day is money still owed once
  // somebody fixes the register. `excluded_dates` is the union; subtracting
  // `unmarked_dates` gives the already-paid count. Older payment docs have no
  // unmarked_dates, so they degrade to the original single caption.
  function _skippedChips(p) {
    var excluded = (p && p.excluded_dates) || [];
    var unmarked = (p && p.unmarked_dates) || [];
    if (!excluded.length) return "";
    var alreadyPaid = Math.max(0, excluded.length - unmarked.length);
    var out = "";
    if (alreadyPaid) {
      out += '<span class="muted">' + alreadyPaid + " already-paid day" +
        (alreadyPaid > 1 ? "s" : "") + " skipped</span>";
    }
    if (unmarked.length) {
      out += '<span class="muted">' + unmarked.length + " unmarked day" +
        (unmarked.length > 1 ? "s" : "") + " skipped</span>";
    }
    return out;
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

  // In-flight load, keyed by month. See the dedupe note below.
  var _gridInflight = null;   // { month, promise } | null

  /**
   * Load (or refresh) the attendance grid for state.gridMonth.
   *
   * @param {boolean} [force] bypass de-duplication. Pass this after a write
   *   (attendance mark, salary payment, advance) — an already-in-flight request
   *   was issued before the write committed and would return stale data.
   *
   * De-duplication matters beyond saving a request. Two concurrent loads for
   * the same month both resolve, and the SECOND one calls renderGrid(), which
   * rewrites the pane's innerHTML. That used to destroy the quick-pay panel and
   * its flatpickr instance several hundred ms after the panel opened — i.e.
   * exactly while the operator was picking dates. openStaffQuickPay (the Salary
   * handover from the expense modal) hit this every time, because both the
   * bottom-nav handler and openStaffQuickPay call openModal().
   */
  function loadGrid(force) {
    var month = state.gridMonth;
    if (!force && _gridInflight && _gridInflight.month === month) {
      return _gridInflight.promise;
    }
    var pane = document.getElementById("stf-pane-attendance");
    state.gridScroll = null;   // fresh load → auto-scroll to today
    // Stale-while-revalidate: if this month is already in memory, paint it
    // instantly and refresh silently; otherwise show a skeleton.
    var hasCache = state._gridLoadedMonth === state.gridMonth && state.staffLoaded;
    if (hasCache) renderGrid();
    else pane.innerHTML = skeletonGrid();
    var r = _monthRange(month);
    var p = Promise.all([
      loadStaff(force),
      api("/staff/attendance?start=" + r.start + "&end=" + r.end),
    ])
      .then(function (results) {
        if (state.gridMonth !== month) return;   // user moved on
        state.gridData = {};
        state.gridMeta = {};
        // Authoritative data just replaced everything in the grid, so which
        // absences this session inferred is no longer knowable — an A that
        // was inferred here may since have been made deliberate elsewhere.
        // Dropping the registry costs one confirm tap; keeping it stale would
        // let a single tap silently overwrite someone's real entry.
        _autoMarked = {};
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
    _gridInflight = { month: month, promise: p };
    p.catch(function () {}).then(function () {
      if (_gridInflight && _gridInflight.promise === p) _gridInflight = null;
    });
    return p;
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
      // data-day marks a DAY column (as opposed to the sticky name column or
      // the trailing totals column) — the CSS hangs the vertical separators
      // off it. See .stf-grid-table thead th[data-day] in staff.css.
      if (_isPayWeekEnd(state.gridMonth, d)) thCls.push("is-week-end");
      html += '<th data-day="1" class="' + thCls.join(" ") + '"' +
        (_isSunday(state.gridMonth, d) ? ' data-sun="1"' : "") + ">" +
        "<span>" + d + "</span><small>" + dow + "</small></th>";
    }
    var canPay = state.payrollVisible &&
      (can("staff.salary.pay") || can("staff.advance.give"));
    html += '<th class="stf-grid-total-h">Days</th>' +
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
      // Tapping the name opens the pay panel when the user can pay/advance;
      // otherwise (view-only) it opens the ledger. Removes the need for a
      // separate ₹ pay icon at the end of the row.
      var nameAttrs = showActions && (canPay || can("staff.payroll.view"))
        ? ' data-open="' + esc(s.id) + '" title="' +
          (canPay ? "Pay " + esc(s.name) : "Open " + esc(s.name) + "&rsquo;s ledger") + '"'
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
        (gr.pairSecond ? shiftTag : '<span class="stf-name-text">' + esc(s.name) + '</span>' + shiftTag) + "</span>" +
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
        if (_isPayWeekEnd(state.gridMonth, d2)) cls.push("is-week-end");
        var qp = state.quickPay;
        // _qpRangeMode, not mode === "pay" — Meals picks a range too, and
        // dropping its highlight on every grid re-render made the selection
        // look like it had been lost.
        if (_qpRangeMode(qp) && qp.staffId === s.id &&
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
        "</tr>";
    });
    html += "</tbody><tfoot><tr>";

    // ── per-day on-duty footer ──
    html += '<td class="stf-grid-name stf-grid-foot">On duty</td>';
    for (var d3 = 1; d3 <= r.lastDay; d3++) {
      var fds = _dstr(state.gridMonth, d3);
      html += '<td class="stf-grid-foot' + (fds === today ? " is-today" : "") +
        (_isPayWeekEnd(state.gridMonth, d3) ? " is-week-end" : "") + '">' +
        (dayTotals[d3] ? fmtDays(dayTotals[d3]) : "") + "</td>";
    }
    html += '<td class="stf-grid-foot"></td>' +
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

    // The quick-pay panel is a live sub-tree: it owns a flatpickr instance and
    // whatever the operator has half-typed or half-picked. `pane.innerHTML =`
    // below destroys it. Detach it first and put it back into the new slot,
    // so a background grid refresh (attendance mark, a late-landing load)
    // leaves the panel and its open calendar completely untouched.
    //
    // renderQuickPay() is only called when there is nothing to preserve —
    // rebuilding is what used to reset the date picker mid-selection.
    var _liveQp = null;
    var _wantKey = _qpKey(state.quickPay);
    if (_wantKey) {
      var _oldSlot = pane.querySelector("#stf-quickpay-slot");
      var _cand = _oldSlot && _oldSlot.firstElementChild;
      // Only preserve a panel built for THIS staff member, mode and host.
      // openQuickPay swaps state.quickPay first and re-renders second, so
      // without this check tapping a second person would keep the first
      // person's DOM (their name in the header, their picker, their
      // already-paid shading) while every submit used the new id.
      if (_cand && _cand.getAttribute("data-qp-key") === _wantKey) {
        _liveQp = _cand;
        _oldSlot.removeChild(_cand);
      }
    }

    pane.innerHTML = html;
    bindGridBar();
    if (_liveQp) {
      var _newSlot = pane.querySelector("#stf-quickpay-slot");
      if (_newSlot) {
        _newSlot.appendChild(_liveQp);
        _wireQpBackdrop(_newSlot);
        _qpSync();               // refresh the numbers, keep the structure
      } else {
        renderQuickPay();        // no slot in this layout — rebuild
      }
    } else {
      renderQuickPay();
    }

    if (canMark) {
      pane.querySelectorAll(".stf-grid-cell").forEach(function (cell) {
        cell.addEventListener("click", function () { onCellTap(cell); });
      });
    }
    // Tapping a staff NAME opens the pay panel (when the user can pay/give
    // advances); view-only users get the ledger instead. The old ₹ pay icon
    // at the end of each row has been removed in favour of this.
    pane.querySelectorAll(".stf-grid-name[data-open]").forEach(function (cell) {
      cell.addEventListener("click", function () {
        if (canPay) openQuickPay(cell.dataset.open);
        else openLedgerFor(cell.dataset.open);
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
      stfConfirm("Mark every unmarked staff as FULL day for today?", { okText: "Mark all" }).then(function (ok) {
        if (!ok) return;
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
    if (_qpRangeMode(qp) && qp.staffId === sid) {
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

    if (!prev || (prev === "absent" && _isAutoMarked(sid, d, shift))) {
      // Blank day/shift → one tap marks Present (the fast path for the
      // daily register stays one tap per person, or per shift).
      //
      // An Absent this session INFERRED from the other shift counts as blank
      // here. Marking D present auto-marks N absent; if it then turns out the
      // person worked both shifts, marking N should still be one tap, not a
      // tap plus a confirm.
      _commitMark(sid, d, "full", shift);
      return;
    }

    // Already-marked day: a stray tap must NOT silently change it. Open a
    // small chooser instead — nothing changes until an option is picked;
    // tapping anywhere else just closes it.
    _openCellPop(cell, sid, d, prev, shift);
  }

  // Shifts this session marked Absent by inference rather than by a tap.
  // Tracked so the twin keeps the one-tap "mark Present" path: an inferred A
  // is not a deliberate entry and must not trigger the "are you sure you want
  // to change this?" chooser. In-memory and dropped on every grid reload —
  // erring towards one extra confirm tap is the safe direction to fail.
  var _autoMarked = {};
  function _autoKey(sid, d, shift) {
    return sid + "|" + d + "|" + (shift || "");
  }
  function _isAutoMarked(sid, d, shift) {
    return !!_autoMarked[_autoKey(sid, d, shift)];
  }

  // The other shift of a dual-shift staff member on the same day.
  function _twinShift(shift) {
    return shift === "D" ? "N" : (shift === "N" ? "D" : null);
  }

  /**
   * A dual-shift staff member has two cells a day and, in practice, works
   * one of them. Marking the shift they worked used to leave the other cell
   * blank, which reads identically to "nobody has looked at this day yet" —
   * so the register was never actually complete and the salary period had to
   * be eyeballed.
   *
   * Marking one shift present therefore marks the OTHER shift absent, but
   * only when it is genuinely untouched: an existing mark on the twin is
   * someone's deliberate entry (they really did work both shifts) and is
   * never overwritten, and a twin inside a paid period is locked.
   *
   * Not applied when clearing or when marking absent — neither implies
   * anything about the other shift.
   */
  function _autoAbsentTwin(sid, d, next, shift) {
    if (!shift) return;                          // single-shift staff
    if (next !== "full" && next !== "half") return;
    // This runs on a network round-trip's delay, so the mark it is inferring
    // from may already have been changed or cleared by a later tap. Inferring
    // an absence from a mark that no longer exists is worse than not
    // inferring one at all.
    if (_gridGetStatus(sid, d, shift) !== next) return;
    var twin = _twinShift(shift);
    if (!twin) return;
    if (_gridGetStatus(sid, d, twin)) return;    // already marked — leave it
    if (_isPaid(sid, d)) return;                 // locked by a salary payout

    _gridSetStatus(sid, d, twin, "absent");
    _autoMarked[_autoKey(sid, d, twin)] = true;
    _renderGridUnlessPopping();
    post("/staff/attendance/mark", {
      staff_id: sid, date: d, status: "absent", shift: twin,
    }).then(function (json) {
      _gridSetMeta(sid, d, twin, json && json.record);
    }).catch(function () {
      // Roll the twin back quietly. The shift the operator actually tapped
      // is already committed by the time this runs, and failing to record an
      // INFERRED absence is not worth an error toast.
      _gridSetStatus(sid, d, twin, "");
      delete _autoMarked[_autoKey(sid, d, twin)];
      _renderGridUnlessPopping();
    });
  }

  // Retract an absence that was inferred from `shift`'s mark (never one the
  // operator entered themselves — _autoMarked is what tells them apart).
  function _retractInferredTwin(sid, d, shift) {
    var twin = _twinShift(shift);
    if (!twin || !_isAutoMarked(sid, d, twin)) return;
    _gridSetStatus(sid, d, twin, "");
    delete _autoMarked[_autoKey(sid, d, twin)];
    post("/staff/attendance/mark", {
      staff_id: sid, date: d, status: "clear", shift: twin,
    }).catch(function () { /* best effort — see _autoAbsentTwin */ });
  }

  // renderGrid() rewrites the whole pane and closes the cell chooser on the
  // way. These twin updates land on a network delay, by which time the
  // operator may have opened the chooser on an unrelated cell — repainting
  // would make it vanish under their finger. The twin cell is repainted by
  // the next render either way.
  function _renderGridUnlessPopping() {
    if (document.getElementById("stf-cell-pop")) return;
    // Hold the horizontal scroll. renderGrid() falls back to auto-scrolling
    // to today's column when state.gridScroll is empty, so repainting
    // without this snapped the grid to today mid-way through marking a
    // back-dated day — the operator lost their place on every tap.
    var wrap = document.querySelector("#stf-pane-attendance .stf-grid-wrap");
    if (wrap) state.gridScroll = { left: wrap.scrollLeft, top: wrap.scrollTop };
    renderGrid();
  }

  function _commitMark(sid, d, next, shift) {
    var prev = _gridGetStatus(sid, d, shift);
    if ((next || "") === prev) return;
    delete _autoMarked[_autoKey(sid, d, shift)];   // now a deliberate entry
    // Clearing a mark retracts the absence that mark inferred on the other
    // shift — otherwise the day keeps a recorded A whose only justification
    // has just been deleted.
    if (!next) _retractInferredTwin(sid, d, shift);

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
      // Infer the other shift ONLY once this one is committed. Doing it
      // alongside the optimistic update wrote an absence to the server that
      // survived when this request then failed (lost connection, or a salary
      // payment locking the day from another device) — leaving an A on a
      // shift nobody touched, with nothing to reconcile it.
      _autoAbsentTwin(sid, d, next, shift);
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
      altFormat: "d-m-Y",
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

  // Re-render whichever pane currently hosts the panel. The panel lives in
  // BOTH the attendance grid and the Staff & Salary cards, so opening/closing
  // it has to refresh the right one — refreshing the grid while the user is on
  // the cards would leave a stale panel on screen.
  function _qpRerenderHost() {
    if (state.quickPay && state.quickPay.host === "payroll") { renderCards(); return; }
    renderGrid();
  }

  // opts: { mode: "pay"|"advance", host: "attendance"|"payroll", keepOpen: bool }
  // `keepOpen` suppresses the tap-again-to-close toggle (used by the
  // programmatic salary redirect from the expense modal).
  function openQuickPay(staffId, opts) {
    // Back-compat: older call sites passed `keepOpen` as a bare boolean.
    if (typeof opts === "boolean") opts = { keepOpen: opts };
    opts = opts || {};
    var s = state.staff.find(function (x) { return x.id === staffId; });
    if (!s) return;
    if (state.quickPay && state.quickPay.staffId === staffId &&
        (!opts.mode || state.quickPay.mode === opts.mode)) {
      // Tap again on the same person = toggle off. A programmatic open, or a
      // tap on the OTHER action for the same person, must not toggle-close.
      if (!opts.keepOpen) closeQuickPay();
      return;
    }
    var mode = opts.mode ||
      (can("staff.salary.pay") ? "pay" : "advance");
    // Never open a mode the user can't perform.
    if (mode === "meals" &&
        (!can("staff.salary.pay") || !(Number(s.meal_rate || 0) > 0))) mode = "pay";
    if (mode === "pay" && !can("staff.salary.pay")) mode = "advance";
    if (mode === "advance" && !can("staff.advance.give")) mode = "pay";
    // Open with NO dates pre-selected — the operator picks the range
    // (calendar or by tapping days on the grid) before anything calculates.
    state.quickPay = {
      staffId: staffId,
      mode: mode,
      // Which pane the panel is rendered into. On "payroll" there is no
      // attendance grid on screen, so the tap-the-days affordance is hidden
      // and the date-range picker is the only way to choose the period.
      host: opts.host === "payroll" ? "payroll" : "attendance",
      start: "",
      end: "",
      anchor: false,
      preview: null,
      loading: false,
    };
    var wrapEl = document.querySelector("#stf-pane-attendance .stf-grid-wrap");
    if (wrapEl) state.gridScroll = { left: wrapEl.scrollLeft, top: wrapEl.scrollTop };
    _qpRerenderHost();
    fetchQuickPreview();
    // Phones show the panel as a centered modal overlay (CSS), so no page
    // scroll is needed. On larger screens it's an inline strip — bring it
    // into view.
    if (window.innerWidth > 600) {
      var slot = _qpSlot();
      if (slot) slot.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  function closeQuickPay() {
    var wasHost = state.quickPay && state.quickPay.host;
    state.quickPay = null;
    var wrapEl = document.querySelector("#stf-pane-attendance .stf-grid-wrap");
    if (wrapEl) state.gridScroll = { left: wrapEl.scrollLeft, top: wrapEl.scrollTop };
    if (wasHost === "payroll") renderCards();
    else renderGrid();
    _fpSweep();                      // the panel's pickers are orphans now
  }

  // The panel's host element. Both panes carry a #stf-quickpay-slot, so
  // resolve against the pane the panel belongs to rather than by id alone —
  // getElementById would always return the attendance one.
  function _qpSlot() {
    var paneId = (state.quickPay && state.quickPay.host === "payroll")
      ? "stf-pane-payroll" : "stf-pane-attendance";
    return document.querySelector("#" + paneId + " #stf-quickpay-slot") ||
      document.getElementById("stf-quickpay-slot");
  }

  function fetchQuickPreview() {
    var qp = state.quickPay;
    if (!_qpRangeMode(qp)) return;
    if (_qpPreviewTimer) clearTimeout(_qpPreviewTimer);
    // No range chosen yet → nothing to calculate. Clear any old preview and
    // let _qpSync show the "pick a date range" prompt.
    if (!qp.start || !qp.end) {
      qp.preview = null;
      qp.loading = false;
      qp.error = null;
      _qpSync();
      return;
    }
    qp.loading = true;
    _qpSync();                       // in place — the panel NEVER rebuilds here
    _qpPreviewTimer = setTimeout(function () {
      var mine = state.quickPay;
      if (!mine || mine !== qp) return;
      api("/staff/" + encodeURIComponent(qp.staffId) +
          (qp.mode === "meals" ? "/meal_preview?start=" : "/salary_preview?start=") +
          qp.start + "&end=" + qp.end)
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

  // Identity of the panel currently in state: staff + mode + host. Stamped
  // onto the rendered panel so renderGrid can tell "the same panel, keep it"
  // from "a different panel, rebuild it".
  function _qpKey(qp) {
    return qp ? (qp.staffId + "|" + qp.mode + "|" + qp.host) : null;
  }

  // Modes that pick a date range off the attendance grid / calendar.
  // "advance" is a single amount on a single date, so it is not one of them.
  function _qpRangeMode(qp) {
    return !!(qp && (qp.mode === "pay" || qp.mode === "meals"));
  }

  // Toggle the calendar-range highlight on the grid IN PLACE — no grid
  // re-render, so the panel, scroll position and focus are untouched.
  function _qpHighlightRange() {
    var qp = state.quickPay;
    var pane = document.getElementById("stf-pane-attendance");
    if (!pane) return;
    pane.querySelectorAll(".stf-grid-cell[data-date]").forEach(function (cell) {
      var tr = cell.closest("tr");
      var inRange = !!(_qpRangeMode(qp) && tr &&
        tr.dataset.sid === qp.staffId &&
        qp.start && qp.end && qp.start <= cell.dataset.date &&
        cell.dataset.date <= qp.end);
      cell.classList.toggle("in-range", inRange);
    });
    pane.querySelectorAll("[data-pay]").forEach(function (cell) {
      cell.classList.toggle("on", !!(qp && cell.dataset.pay === qp.staffId));
    });
  }

  // Push the chosen range into whichever date control is on screen.
  // Shared by the Salary and Meals modes — both pick a period the same way.
  function _qpSyncDates(qp) {
    // Date controls follow state (grid taps). With the flatpickr range
    // picker, setDate(..., false) updates in place WITHOUT firing onChange
    // — no loop, no panel rebuild. Native fallback keeps the old rule of
    // never overwriting a focused input.
    var picker = qp._rangePicker;
    if (picker && picker.input && document.body.contains(picker.input)) {
      if (!qp.start || !qp.end) {
        // Range cleared / not yet chosen — empty the calendar.
        if (picker.selectedDates.length) picker.clear();
      } else if (!picker.isOpen) {
        // Only while the calendar is CLOSED. setDate() in range mode redraws
        // the calendar and resets flatpickr's internal selection state, so a
        // preview response landing between the operator's first and second tap
        // used to wipe the half-picked range out from under them.
        var selNow = picker.selectedDates.map(_toYMD);
        if (selNow.length !== 2 || selNow[0] !== qp.start || selNow[1] !== qp.end) {
          picker.setDate([_ymdDate(qp.start), _ymdDate(qp.end)], false);
        }
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
  }

  // ── In-place refresh of the panel's dynamic parts. The structure (inputs,
  // source toggle, buttons) is built ONCE by renderQuickPay and stays put —
  // changing dates must never collapse the panel into a "Calculating…"
  // placeholder or steal focus from an input.
  function _qpSync() {
    var qp = state.quickPay;
    if (!_qpRangeMode(qp)) return;
    var pv = qp.preview;
    if (qp.mode === "meals") { _qpSyncDates(qp); _mealSync(qp); return; }

    _qpSyncDates(qp);
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
      } else {
        // Not mutually exclusive: a range can contain both days an earlier
        // payout already settled AND days nobody has marked yet. Show each.
        if (pv && pv.excluded_days && pv.excluded_days.length) {
          note += '<div class="stf-carry-note">' +
            "ℹ " + pv.excluded_days.length + " already-paid day" +
            (pv.excluded_days.length > 1 ? "s" : "") + " (" +
            esc(pv.excluded_days.map(fmtDShort).join(", ")) +
            ") will be skipped — the salary below covers only the unpaid days.</div>";
        }
        // Unmarked days are the ones worth interrupting for. They are NOT an
        // error: the payout still goes through for the days that are marked,
        // and these stay open. But the operator should know they are about to
        // hand over less than a full period, and why.
        if (pv && pv.unmarked_days && pv.unmarked_days.length) {
          var n = pv.unmarked_days.length;
          var plural = n > 1;
          // Red when the WHOLE range is unmarked (there is no wage to pay at
          // all), amber when only some days are missing. The button stays
          // enabled either way: a bonus-only or advance-recovery payout over
          // an unmarked range is legitimate, and the server gives the precise
          // refusal if there is genuinely nothing to settle.
          var severe = !!pv.all_days_unmarked;
          note += '<div class="stf-carry-note" style="' +
            (severe
              ? "background:#fff5f5;border-color:#fecaca;color:#991b1b;"
              : "background:#fffbeb;border-color:#fcd34d;color:#92400e;") +
            '">⚠ ' +
            (severe
              ? "No attendance is marked anywhere in this range"
              : n + " day" + (plural ? "s" : "") + " in this range " +
                (plural ? "have" : "has") + " no attendance marked") +
            " (" + esc(pv.unmarked_days.map(fmtDShort).join(", ")) + "). " +
            (plural ? "They" : "It") + " will be skipped and stay unpaid. " +
            "Mark attendance and " + (plural ? "they" : "it") +
            " can be paid in a later period.</div>";
        }
      }
      if (noteEl.innerHTML !== note) noteEl.innerHTML = note;
    }

    // Calculation line: keep the old numbers dimmed while the fresh ones load.
    var calcEl = document.getElementById("stf-qp-calc");
    if (calcEl) {
      if (!qp.start || !qp.end) {
        calcEl.textContent = "Select the pay period to see the salary total.";
      } else if (pv) {
        var c = pv.computed;
        calcEl.innerHTML = "<b>" + fmtDays(c.days_worked) + "</b> days (" +
          c.full_days + " full, " + c.half_days + " half) × " +
          rup(c.daily_wage) + " = <b>" + rup(c.gross) + "</b>";
      } else if (qp.loading) {
        calcEl.textContent = "Calculating…";
      } else {
        calcEl.textContent = "—";
      }
      calcEl.classList.toggle("updating", !!qp.loading);
    }

    // Advance deduction: show only when there is something to recover; keep
    // the operator's typed value, only auto-fill while untouched.
    var outstanding = pv ? Number(pv.outstanding_advance || 0) : 0;
    var dedWrap = document.getElementById("stf-qp-ded-wrap");
    // (the deduct field's max is set below, after meals are known)
    var dedInp = document.getElementById("stf-qp-ded");
    if (dedWrap) dedWrap.style.display = outstanding > 0 ? "" : "none";
    var dedHelp = document.getElementById("stf-qp-ded-help");
    if (dedHelp) dedHelp.textContent = outstanding > 0 ? rup(outstanding) + " due" : "";
    if (dedInp && pv) {
      // Cap at whatever survives the meal withholding — the ledger rejects a
      // payout where advance + meals exceed the payable amount, and a field
      // that lets you type a rejected number is worse than one that doesn't.
      var _meals = Number((pv.meals && pv.meals.meal_total) || pv.meal_deduction || 0);
      dedInp.max = Math.max(0, Math.min(
        outstanding, (pv.computed.gross + (Number(qp.adj) || 0)) - _meals));
      // Default the advance deduction to 0 — the operator opts in to
      // recovering an advance rather than it being pre-filled to the max.
      if (!qp.dedTouched) {
        dedInp.value = 0;
      }
    }
    _qpRecalcNet();

    var confirmBtn = document.getElementById("stf-qp-confirm");
    if (confirmBtn && qp.mode === "pay") {
      confirmBtn.disabled = !!(qp.loading || !pv || pv.all_days_paid ||
        (qp._net != null && qp._net < 0));
    }
  }

  // Meals mode: same shape as the salary sync, far less arithmetic. The
  // amount is entirely server-derived (rate x days present, minus days an
  // earlier log already covered), so there is nothing to recompute here —
  // only to display.
  function _mealSync(qp) {
    var pv = qp.preview;

    var noteEl = document.getElementById("stf-qp-notearea");
    if (noteEl) {
      var note = "";
      if (qp.error) {
        note = '<div class="stf-carry-note" style="background:#fff5f5;border-color:#fecaca;color:#991b1b;">' +
          esc(qp.error) + "</div>";
      } else if (pv && !pv.has_meal_rate) {
        note = '<div class="stf-carry-note" style="background:#fff5f5;border-color:#fecaca;color:#991b1b;">' +
          "\u26a0 No meal rate set for this person. Edit their staff record and " +
          "set \u201cMeals per day\u201d first.</div>";
      } else if (pv && pv.already_logged_days && pv.already_logged_days.length) {
        note = '<div class="stf-carry-note">' +
          "\u2139 " + pv.already_logged_days.length + " day" +
          (pv.already_logged_days.length > 1 ? "s" : "") +
          " in this range " + (pv.already_logged_days.length > 1 ? "are" : "is") +
          " already logged and will be skipped.</div>";
      }
      if (noteEl.innerHTML !== note) noteEl.innerHTML = note;
    }

    var days = pv && pv.meals ? pv.meals.meal_days : 0;
    var total = pv && pv.meals ? pv.meals.meal_total : 0;

    var calcEl = document.getElementById("stf-qp-calc");
    if (calcEl) {
      if (!qp.start || !qp.end) {
        calcEl.textContent = "Select the days to see the meal total.";
      } else if (pv) {
        calcEl.innerHTML = "<b>" + days + "</b> day" + (days === 1 ? "" : "s") +
          " present \u00d7 " + rup(pv.meal_rate) + " = <b>" + rup(total) + "</b>";
      } else if (qp.loading) {
        calcEl.textContent = "Calculating\u2026";
      } else {
        calcEl.textContent = "\u2014";
      }
      calcEl.classList.toggle("updating", !!qp.loading);
    }

    var netEl = document.getElementById("stf-qp-net");
    if (netEl) netEl.textContent = rup(total);
    var lbl = document.getElementById("stf-qp-paylbl");
    if (lbl) lbl.textContent = total > 0 ? "Log " + rup(total) + " meals" : "Log meals";

    var btn = document.getElementById("stf-qp-confirm");
    if (btn) btn.disabled = !!(qp.loading || !pv || !pv.has_meal_rate || total <= 0);
  }

  function _qpRecalcNet() {
    var qp = state.quickPay;
    var pv = qp && qp.preview;
    var netEl = document.getElementById("stf-qp-net");
    var payLbl = document.getElementById("stf-qp-paylbl");
    if (!netEl) return;
    if (!pv) {
      netEl.textContent = "₹0";
      if (payLbl) payLbl.textContent = "Pay salary";
      return;
    }
    var outstanding = Number(pv.outstanding_advance || 0);
    var adj = parseInt(document.getElementById("stf-qp-adj")?.value, 10) || 0;
    var payable = pv.computed.gross + adj;
    // Meals come off the payout before the advance can be recovered — the
    // food is already eaten, the advance can always wait for next week.
    // The figure is computed server-side (staff.meal_rate x days present in
    // this period); the client only displays it.
    var meals = Number((pv.meals && pv.meals.meal_total) || pv.meal_deduction || 0);
    var mealRow = document.getElementById("stf-qp-mealrow");
    if (mealRow) {
      mealRow.style.display = meals > 0 ? "" : "none";
      var mealVal = document.getElementById("stf-qp-mealval");
      if (mealVal) {
        mealVal.textContent = "\u2212" + rup(meals) +
          (pv.meals ? "  (" + pv.meals.meal_days + " \u00d7 " +
            rup(pv.meals.meal_rate) + ")" : "");
      }
    }
    var ded = Math.min(parseInt(document.getElementById("stf-qp-ded")?.value, 10) || 0,
      Math.min(outstanding, Math.max(0, payable - meals)));
    var net = payable - meals - ded;
    netEl.textContent = rup(net);
    // The button restates the amount so staff see exactly what they'll hand over.
    if (payLbl) payLbl.textContent = "Pay " + rup(net);
    // A negative payout means the meal charge for this period exceeds what
    // was earned (a short run of half days against a high meal rate, or a
    // large fine). The server refuses it, and no input on this form could be
    // adjusted to make it go through, so say that explicitly rather than
    // letting the operator press Pay into a dead-end 400.
    //
    // Recorded on the state object because _qpSync sets the button's disabled
    // flag AFTER calling this, and the adjustment/deduction handlers call this
    // on its own — both paths have to agree.
    qp._net = net;
    var negEl = document.getElementById("stf-qp-negnote");
    if (negEl) {
      negEl.style.display = net < 0 ? "" : "none";
      if (net < 0) {
        negEl.textContent = "\u26a0 Meals " + rup(meals) + " exceed the " +
          rup(payable) + " earned in this period. Widen the period, or fix " +
          "the meal rate on the staff record.";
      }
    }
    var negBtn = document.getElementById("stf-qp-confirm");
    if (negBtn && net < 0) negBtn.disabled = true;
  }

  // Mobile: the panel is styled as a modal overlay on top of the grid
  // (see .stf-quickpay-slot CSS). Tapping the dimmed backdrop closes it.
  // Guarded so a mode-switch re-render doesn't stack duplicate listeners.
  // Called for the slot the panel actually lives in — renderGrid() replaces the
  // pane's DOM, so a preserved panel lands in a brand-new (unwired) slot.
  function _wireQpBackdrop(slot) {
    if (!slot || slot._bdWired) return;
    slot._bdWired = true;
    slot.addEventListener("click", function (e) {
      if (e.target === slot) closeQuickPay();   // backdrop only, not the card
    });
  }

  function renderQuickPay() {
    var slot = _qpSlot();
    if (!slot) return;
    var qp = state.quickPay;
    if (!qp) { slot.innerHTML = ""; return; }
    var s = _qpStaff();
    if (!s) { slot.innerHTML = ""; return; }
    var today = _todayStr();

    // The Meals tab only appears for staff who actually have a meal rate —
    // most don't, and an always-visible third tab would be noise.
    var hasMealRate = Number(s.meal_rate || 0) > 0;
    var switchBtns =
      (can("staff.salary.pay")
        ? '<button data-qpmode="pay" class="' + (qp.mode === "pay" ? "on" : "") + '">Salary</button>'
        : "") +
      (can("staff.advance.give")
        ? '<button data-qpmode="advance" class="' + (qp.mode === "advance" ? "on" : "") + '">Advance</button>'
        : "") +
      (can("staff.salary.pay") && hasMealRate
        ? '<button data-qpmode="meals" class="' + (qp.mode === "meals" ? "on" : "") + '">Meals</button>'
        : "");

    var head =
      '<div class="stf-qp-head">' +
      '  <div class="stf-qp-head-top">' +
      '    <div class="stf-avatar">' + initial(s.name) + "</div>" +
      '    <div class="who"><b>' + esc(s.name) + "</b>" +
      '      <span>' + rup(s.daily_wage) + " per day" +
      (s.outstanding_advance > 0
        ? ' &nbsp;·&nbsp; <span class="due">' + rup(s.outstanding_advance) + " advance due</span>"
        : "") + "</span></div>" +
      (can("staff.payroll.view")
        ? '    <button class="stf-qp-ledger" id="stf-qp-ledger" title="Open register / ledger" aria-label="Open ledger"><i class="fas fa-book-open"></i></button>'
        : "") +
      '    <button class="stf-qp-close" id="stf-qp-close" title="Close" aria-label="Close"><i class="fas fa-times"></i></button>' +
      "  </div>" +
      (switchBtns ? '  <div class="stf-qp-switch">' + switchBtns + "</div>" : "") +
      "</div>";

    var body = "";
    // Both range modes use the same period picker. Built once here so Salary
    // and Meals cannot drift apart.
    var srcInnerShared = sourceHtml("stf-qp-source")
      .replace('<div class="form-group"><label class="form-label">Paid from</label>', "")
      .replace(/<\/div>$/, "");
    var rangeField = _fpLib()
      ? '<div class="stf-range-lbl"><i class="fas fa-calendar-alt"></i>' +
        '  <input type="text" id="stf-qp-range" class="stf-range-inp" placeholder="Select the pay period" readonly></div>' +
        (qp.host === "payroll" ? "" :
         '  <span class="stf-qp-help stf-qp-taphint">or tap the days on ' + esc(s.name) + "&rsquo;s row</span>")
      : '<div class="stf-qp-tworow">' +
        '  <input type="date" id="stf-qp-start" class="stf-qp-input" value="' + esc(qp.start) + '" max="' + today + '">' +
        '  <span class="stf-qp-dash">to</span>' +
        '  <input type="date" id="stf-qp-end" class="stf-qp-input" value="' + esc(qp.end) + '" max="' + today + '"></div>' +
        (qp.host === "payroll" ? "" :
         '  <span class="stf-qp-help stf-qp-taphint">or tap the days on ' + esc(s.name) + "&rsquo;s row</span>");

    if (qp.mode === "meals") {
      // One expense covering a week of food, after the fact. The amount is
      // never entered by hand — it is rate x days present, computed by the
      // server, so it always matches what the salary payout withheld.
      body +=
        '<div class="stf-qp-field">' +
        '  <label class="stf-qp-lbl">1 \u00b7 Days to charge</label>' + rangeField +
        "</div>" +
        '<div id="stf-qp-notearea"></div>' +
        '<div class="stf-qp-calcbox" id="stf-qp-calc">Select the days to see the meal total.</div>' +
        '<div class="stf-qp-field">' +
        '  <label class="stf-qp-lbl">Note (optional)</label>' +
        '  <input type="text" id="stf-qp-note" class="stf-qp-input" maxlength="120" placeholder="e.g. week 2 mess bill">' +
        "</div>" +
        '<div class="stf-qp-netcard">' +
        '  <span class="stf-qp-netlbl">Meal cost</span>' +
        '  <span class="stf-qp-netval" id="stf-qp-net">\u20b90</span>' +
        "</div>" +
        '<div class="stf-qp-field">' +
        '  <label class="stf-qp-lbl">2 \u00b7 Paid from</label>' + srcInnerShared +
        "</div>" +
        '<button class="stf-btn primary stf-qp-paybtn" id="stf-qp-confirm" disabled>' +
        '<i class="fas fa-utensils"></i> <span id="stf-qp-paylbl">Log meals</span></button>' +
        '<div class="stf-qp-help" style="margin-top:0.5rem;">Counts one meal per day present ' +
        '(a half day still eats). Days already logged are skipped automatically.</div>';
    } else if (qp.mode === "pay") {
      // The FULL structure is always present; _qpSync() fills the dynamic
      // parts. Nothing here is ever swapped for a loading placeholder.
      // One "Pick date range" input opening the flatpickr calendar — the
      // same modern selector as the Transactions tab. Native two-input
      // fallback if the library didn't load.
      // Strip sourceHtml's own "Paid from" wrapper — we render our own label.
      var srcInner = srcInnerShared;
      body +=
        '<div class="stf-qp-field">' +
        '  <label class="stf-qp-lbl">1 · Salary period</label>' + rangeField +
        "</div>" +
        '<div id="stf-qp-notearea"></div>' +
        '<div class="stf-qp-calcbox" id="stf-qp-calc">Select the pay period to see the salary total.</div>' +
        '<div class="stf-qp-fieldrow">' +
        '  <div class="stf-qp-field">' +
        '    <label class="stf-qp-lbl">Bonus / fine (₹)</label>' +
        '    <input type="number" id="stf-qp-adj" class="stf-qp-input" value="' + (qp.adj || 0) + '" placeholder="0">' +
        '    <span class="stf-qp-help">+ to add, − to cut</span>' +
        "  </div>" +
        '  <div class="stf-qp-field" id="stf-qp-ded-wrap" style="display:none;">' +
        '    <label class="stf-qp-lbl">Deduct advance (₹)</label>' +
        '    <input type="number" id="stf-qp-ded" class="stf-qp-input danger" min="0" value="' + (qp.ded != null ? qp.ded : 0) + '" placeholder="0">' +
        '    <span class="stf-qp-help" id="stf-qp-ded-help"></span>' +
        "  </div>" +
        "</div>" +
        '<div class="stf-qp-mealrow" id="stf-qp-mealrow" style="display:none;">' +
        '  <span class="stf-qp-meallbl"><i class="fas fa-utensils"></i> Meals withheld</span>' +
        '  <span class="stf-qp-mealval" id="stf-qp-mealval">\u20b90</span>' +
        "</div>" +
        '<div class="stf-carry-note stf-qp-negnote" id="stf-qp-negnote" ' +
        'style="display:none;background:#fff5f5;border-color:#fecaca;color:#991b1b;"></div>' +
        '<div class="stf-qp-netcard">' +
        '  <span class="stf-qp-netlbl">Paying now</span>' +
        '  <span class="stf-qp-netval" id="stf-qp-net">₹0</span>' +
        "</div>" +
        '<div class="stf-qp-fieldrow">' +
        '  <div class="stf-qp-field">' +
        '    <label class="stf-qp-lbl">2 · Paid from</label>' + srcInner +
        "  </div>" +
        // The day the cash leaves the counter — separate from the period
        // being settled, because a week's wages are often handed over a day
        // or two later. This is what dates the linked expense row.
        '  <div class="stf-qp-field">' +
        '    <label class="stf-qp-lbl">Paid on</label>' +
        '    <input type="date" id="stf-qp-paidon" class="stf-qp-input" value="' +
        esc(qp.paidOn || today) + '" max="' + today + '">' +
        "  </div>" +
        "</div>" +
        '<button class="stf-btn primary stf-qp-paybtn" id="stf-qp-confirm" disabled>' +
        '<i class="fas fa-check"></i> <span id="stf-qp-paylbl">Pay salary</span></button>';
    } else {
      var srcInnerA = srcInnerShared;
      body +=
        '<div class="stf-qp-fieldrow">' +
        '  <div class="stf-qp-field">' +
        '    <label class="stf-qp-lbl">Advance amount (₹)</label>' +
        '    <input type="number" id="stf-qp-amount" class="stf-qp-input big" min="1" placeholder="0">' +
        "  </div>" +
        '  <div class="stf-qp-field">' +
        '    <label class="stf-qp-lbl">Date</label>' +
        '    <input type="date" id="stf-qp-adv-date" class="stf-qp-input" value="' + today + '" max="' + today + '">' +
        "  </div>" +
        "</div>" +
        '<div class="stf-qp-field">' +
        '  <label class="stf-qp-lbl">Note (optional)</label>' +
        '  <input type="text" id="stf-qp-note" class="stf-qp-input" maxlength="120" placeholder="e.g. festival, medical">' +
        "</div>" +
        '<div class="stf-qp-field">' +
        '  <label class="stf-qp-lbl">Paid from</label>' + srcInnerA +
        "</div>" +
        '<button class="stf-btn primary stf-qp-paybtn" id="stf-qp-confirm">' +
        '<i class="fas fa-hand-holding-dollar"></i> Give advance</button>' +
        '<div class="stf-qp-help" style="margin-top:0.5rem;">Deducted automatically from the next salary; the rest carries forward.</div>';
    }

    slot.innerHTML = '<div class="stf-qp" data-qp-key="' +
      esc(_qpKey(qp)) + '">' + head + body + "</div>";

    _wireQpBackdrop(slot);

    // ── bindings ──
    document.getElementById("stf-qp-close").addEventListener("click", closeQuickPay);
    var qpLedgerBtn = document.getElementById("stf-qp-ledger");
    if (qpLedgerBtn) qpLedgerBtn.addEventListener("click", function () {
      var sid = state.quickPay && state.quickPay.staffId;
      if (sid) openLedgerFor(sid);
    });
    slot.querySelectorAll("[data-qpmode]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (!state.quickPay || state.quickPay.mode === b.dataset.qpmode) return;
        state.quickPay.mode = b.dataset.qpmode;
        renderQuickPay();          // structure change — a rebuild is correct
        _qpHighlightRange();       // grid highlight follows the mode, in place
        if (_qpRangeMode(state.quickPay)) fetchQuickPreview();
      });
    });

    _fpSweep();                      // drop pickers orphaned by this rebuild
    var rangeInp = document.getElementById("stf-qp-range");
    if (rangeInp && _fpLib()) {
      var rp = _fpLib()(rangeInp, {
        mode: "range",
        dateFormat: "d-m-Y",
        // Date OBJECT, not a "Y-m-d" string — a string would be parsed with
        // this picker's dateFormat ("d-m-Y") and silently fail.
        maxDate: _ymdDate(today),
        // No pre-selected range — the calendar opens empty.
        defaultDate: (qp.start && qp.end) ? [_ymdDate(qp.start), _ymdDate(qp.end)] : null,
        disableMobile: true,
        // Render the calendar INSIDE .stf-range-lbl (which is position:
        // relative) instead of letting flatpickr append it to <body>. On
        // phones this panel is a position:fixed, internally-scrolling overlay;
        // a body-appended calendar is positioned once at a document
        // coordinate and then slides away from its input as soon as anything
        // scrolls. Static keeps the two glued together.
        static: true,
        locale: { rangeSeparator: " – " },
        // Color-code each day the same way the attendance grid does for
        // already-paid ("locked") days — a light green fill + small lock
        // mark — so it's obvious at a glance which days in this range
        // have already been paid out, before you even confirm.
        onDayCreate: function (dObj, dStr, fp, dayElem) {
          if (!dayElem.dateObj) return;
          var ymd = _toYMD(dayElem.dateObj);
          if (_isPaid(qp.staffId, ymd)) {
            dayElem.classList.add("stf-fp-paid");
            dayElem.title = "Salary already paid for this day";
          }
        },
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
    _modernDate("stf-qp-paidon", { maxDate: today });

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

    var paidOnInp = document.getElementById("stf-qp-paidon");
    if (paidOnInp) paidOnInp.addEventListener("change", function () {
      if (state.quickPay) state.quickPay.paidOn = paidOnInp.value || "";
    });

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
      var m = state.quickPay && state.quickPay.mode;
      if (m === "advance") return submitQuickAdvance(confirmBtn);
      if (m === "meals") return submitMealLog(confirmBtn);
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
    if (!qp.start || !qp.end) { notify("Pick a date range first", "error"); return; }
    var msg = "Pay " + rup(payable - ded) + " to " + s.name + " for " +
      fmtDShort(qp.start) + " – " + fmtDShort(qp.end) +
      (ded ? " (after deducting " + rup(ded) + " advance)" : "") + "?";
    stfConfirm(msg, { okText: "Pay salary" }).then(function (ok) {
      if (!ok) return;
      btn.disabled = true;
      post("/staff/" + encodeURIComponent(qp.staffId) + "/pay_salary", {
        paid_on: (document.getElementById("stf-qp-paidon")?.value || ""),
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
          // Read paid_on BEFORE the panel state resets and re-renders.
          var _paidOn = document.getElementById("stf-qp-paidon")?.value || "";
          state.quickPay = null;
          state.staffLoaded = false;       // outstanding / paid-until changed
          state.insights = null;
          state._gridLoadedMonth = null;   // paid-period locks changed
          // Back-dated payment → the expense row landed on paid_on, not
          // today. Jump the Transactions view there so the payment is
          // visible instead of silently living on a day nobody is looking
          // at. Same-day payments keep the plain refresh (no view change).
          var _p2 = function (n) { return (n < 10 ? "0" : "") + n; };
          var _n = new Date();
          var _todayStr = _n.getFullYear() + "-" + _p2(_n.getMonth() + 1) +
            "-" + _p2(_n.getDate());
          if (_paidOn && _paidOn !== _todayStr &&
              typeof window.goToTransactionDate === "function") {
            window.goToTransactionDate(_paidOn);
          } else {
            _refreshMoneyViews();
          }
          loadGrid(true);       // force — the paid-period locks just changed
        })
        .catch(function (e) { btn.disabled = false; notify(e.message, "error"); });
    });
  }

  function submitMealLog(btn) {
    var qp = state.quickPay;
    var s = _qpStaff();
    if (!qp || !s || !qp.preview) return;
    var pv = qp.preview;
    var total = pv.meals ? pv.meals.meal_total : 0;
    var days = pv.meals ? pv.meals.meal_days : 0;
    if (!(total > 0)) return notify("Nothing to log for these days", "error");
    var src = readSource("stf-qp-source");
    stfConfirm(
      "Log " + rup(total) + " of meals for " + s.name + "? (" + days +
      " day" + (days === 1 ? "" : "s") + " × " + rup(pv.meal_rate) + ")",
      { okText: "Log meals" }
    ).then(function (ok) {
      if (!ok) return;
      btn.disabled = true;
      // The amount is NOT sent — the server recomputes it from the staff
      // member's meal rate and the attendance in this range.
      post("/staff/" + encodeURIComponent(qp.staffId) + "/log_meals", {
        period_start: qp.start,
        period_end: qp.end,
        note: (document.getElementById("stf-qp-note")?.value || "").trim(),
        payment_method: src.payment_method,
        expense_type: src.expense_type,
      })
        .then(function (json) {
          notify(json.message || "Meals logged", "success");
          state.quickPay = null;
          state.staffLoaded = false;
          state.insights = null;
          _refreshMoneyViews();
          loadGrid(true);       // force — a new expense row just landed
        })
        .catch(function (e) { btn.disabled = false; notify(e.message, "error"); });
    });
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
        loadGrid(true);         // force — the advance ledger just changed
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
      "</div>" +
      // Same quick pay/advance panel the attendance grid uses. Pay Salary and
      // Advance on the cards below open it here instead of a separate
      // full-screen form, so both tabs settle money through one UI.
      '<div id="stf-quickpay-slot"></div>';

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
          // Only for staff who actually eat here — see meal_rate.
          (can("staff.salary.pay") && s.active !== false && Number(s.meal_rate || 0) > 0
            ? '<button class="stf-btn ghost" data-act="meals" data-sid="' + esc(s.id) + '"><i class="fas fa-utensils"></i> Meals</button>'
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
        var act = btn.dataset.act;
        // Pay Salary / Advance open the shared quick panel in this pane.
        // Edit and Ledger are still their own full-screen views.
        if (act === "pay" || act === "advance" || act === "meals") {
          openQuickPay(s.id, { mode: act, host: "payroll" });
          return;
        }
        state.payView = { name: act, staff: s };
        renderPayroll();
      });
    });

    // The panel survives a cards re-render (open → renderCards → repaint).
    renderQuickPay();
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
      '  <div class="stf-two-col">' +
      '    <div class="form-group"><label class="form-label">Meals per day (\u20b9)</label>' +
      '      <input class="form-control" type="number" min="0" id="stf-f-meal" value="' + (s.meal_rate || 0) + '" placeholder="0"></div>' +
      '    <div class="form-group" style="display:flex;align-items:flex-end;">' +
      '      <span style="font-size:0.72rem;color:#718096;line-height:1.35;">Leave 0 if they don&rsquo;t eat here.</span></div>' +
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
      "Two-shift staff earn up to two days' wage per day worked (one per shift). " +
      "A meal rate is withheld from the salary payout and billed separately with " +
      "\u201cLog meals\u201d \u2014 e.g. wage \u20b9350 with meals \u20b950 hands over " +
      "\u20b9300/day in cash. Meals count one per day present (a half day still eats)." +
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
        meal_rate: document.getElementById("stf-f-meal").value || 0,
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

  function sourceHtml(id, opts) {
    // Managers pay from counter cash only (custody rule — enforced
    // server-side too); the Account/UPI option renders only for roles
    // with staff.pay.account (admin).
    var accountBtn = can("staff.pay.account")
      ? '  <button type="button" data-src="account">' +
        '    <span><i class="fas fa-university"></i> Account / UPI</span><small>bank or online</small>' +
        "  </button>"
      : "";
    // Opening balance from the paper books — Advance form only
    // (opts.books), admin-only. Writes NO expense row and never touches
    // the counter; used to seed an old advance into the software.
    var booksBtn = (opts && opts.books && can("staff.pay.account"))
      ? '  <button type="button" data-src="books">' +
        '    <span><i class="fas fa-book"></i> Books (opening)</span><small>old advance — no expense entry</small>' +
        "  </button>"
      : "";
    return (
      '<div class="form-group"><label class="form-label">Paid from</label>' +
      '<div class="stf-source" id="' + id + '">' +
      '  <button type="button" data-src="counter" class="sel">' +
      '    <span><i class="fas fa-store"></i> Cash counter</span><small>today\'s drawer cash</small>' +
      "  </button>" +
      accountBtn +
      booksBtn +
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
    if (src === "books")
      return { payment_method: "books", expense_type: "opening", opening: true };
    return src === "account"
      ? { payment_method: "online", expense_type: "report" }
      : { payment_method: "cash", expense_type: "transaction" };
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
              title = (a.opening ? "Opening advance (from books)" : "Advance given") +
                (a.note ? " — " + esc(a.note) : "");
              detail = '<span class="muted">' + esc(fmtD(a.date)) +
                (a.opening ? " · books only"
                  : a.expense_type === "report" ? " · account" : " · counter cash") +
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
                // excluded_dates holds BOTH already-paid days and days with no
                // attendance. unmarked_dates is the second group; payments
                // written before that field existed simply report zero of them
                // and render exactly as they always did.
                _skippedChips(p) +
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
            stfConfirm(q, { okText: kind === "advance" ? "Delete" : "Reverse", danger: true }).then(function (ok) {
              if (!ok) return;
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
  // Staff now opens via the bottom nav (nav-item[data-tab="staff"] in
  // script.js), not a Quick Actions button — the old quick-staff-btn no
  // longer exists in the DOM, so there's nothing left to bind here.
  function bind() {}

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
  /**
   * @param {string} staffId
   * @param {string} [paidOn] "YYYY-MM-DD" chosen in the expense modal before
   *   the operator tapped this staff name. Carried through so the payout
   *   lands on the day they were entering for instead of resetting to today.
   */
  window.openStaffQuickPay = function (staffId, paidOn) {
    // 1) Actually NAVIGATE to the Staff tab. Triggered from the Transactions
    //    tab's Salary tile, the app is showing a different tab; openModal()
    //    alone only builds content inside the still-hidden #staff-tab, so it
    //    looked like nothing happened. Clicking the bottom-nav item runs the
    //    generic handler that un-hides #staff-tab (and calls openStaffModal).
    var navItem = document.querySelector('.nav-item[data-tab="staff"]');
    if (navItem) navItem.click();
    // 2) Build/refresh content and land on the attendance grid. Idempotent —
    //    safe even if the nav handler already opened the module. The two paths
    //    used to issue two concurrent /staff/attendance loads for the same
    //    month; loadGrid() now de-duplicates them, so only one response lands
    //    and only one renderGrid() runs. That double render was what tore the
    //    date picker down mid-selection on this route.
    openModal();
    // 3) The grid loads async; poll until this month's data (staff list +
    //    paid periods) is in memory, then pop the quick-pay panel.
    var tries = 0;
    (function waitReady() {
      var ready =
        state.staffLoaded &&
        state._gridLoadedMonth === state.gridMonth &&
        state.staff.some(function (s) { return s.id === staffId; });
      if (ready) {
        openQuickPay(staffId, true);
        if (paidOn && state.quickPay) {
          state.quickPay.paidOn = paidOn;
          var el = document.getElementById("stf-qp-paidon");
          if (el) {
            if (el._flatpickr) el._flatpickr.setDate(paidOn, false);
            else el.value = paidOn;
          }
        }
        return;
      }
      if (tries++ < 60) setTimeout(waitReady, 100);   // give up after ~6s
    })();
  };
})();
