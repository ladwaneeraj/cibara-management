// laundry.js — Laundry Management Module (CIBARA COMFORTS)
// Excel-style daily grid + monthly bill with history

(function () {
  "use strict";

  // ── Item definitions ───────────────────────────────────────────────────────
  const ITEMS = [
    { key: "single",     label: "Single",     short: "Single" },
    { key: "double",     label: "Double",     short: "Double" },
    { key: "pillow",     label: "Pillow",     short: "Pillow" },
    { key: "towel",      label: "Towel",      short: "Towel" },
    { key: "single_rug", label: "Single Rug", short: "S.Rug" },
    { key: "double_rug", label: "Double Rug", short: "D.Rug" },
    { key: "mat",        label: "Mat",        short: "Mat" },
    { key: "curtain",    label: "Curtain",    short: "Curtain" },
  ];

  // ── State ──────────────────────────────────────────────────────────────────
  let _prices     = {};
  let _gridMonth  = _todayMonth();      // "YYYY-MM"
  let _gridLogs   = {};                 // date → log doc
  let _editingIds = new Set();          // doc_ids currently unlocked for edit
  // Admin data locks — a locked month/date renders read-only and the server
  // rejects writes for it (423). See routes/laundry.py laundry_locks.
  let _gridLocks  = { monthLocked: false, dates: new Set() };
  let _monthlyData = null;
  let _allBills    = [];
  let _expenseType   = "transaction";
  let _paymentMethod = "cash";
  let _selectedBillMonth = _todayMonth();

  // ── Helpers ────────────────────────────────────────────────────────────────
  function _todayMonth() { return new Date().toISOString().slice(0, 7); }
  function _todayDate()  { return new Date().toISOString().slice(0, 10); }

  function _monthDays(ym) {
    const [y, m] = ym.split("-").map(Number);
    return new Date(y, m, 0).getDate();
  }
  function _daysInMonth(ym) {
    const days = [];
    const n = _monthDays(ym);
    for (let d = 1; d <= n; d++) {
      days.push(`${ym}-${String(d).padStart(2, "0")}`);
    }
    return days;
  }
  function _monthLabel(ym) {
    if (!ym) return "";
    const [y, m] = ym.split("-");
    return new Date(+y, +m - 1, 1).toLocaleString("en-IN", { month: "long", year: "numeric" });
  }
  function _fmtDate(dateStr) {
    if (!dateStr) return "-";
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
  }
  function _fmtMonthShort(ym) {
    if (!ym) return "-";
    const [y, m] = ym.split("-");
    return new Date(+y, +m - 1, 1).toLocaleString("en-IN", { month: "short", year: "2-digit" });
  }
  function _notify(msg, type = "success") {
    if (typeof showNotification === "function") showNotification(msg, type);
    else alert(msg);
  }
  function _inr(n) { return `₹${Number(n || 0).toLocaleString("en-IN")}`; }

  async function _fetch(url, opts = {}) {
    const res = typeof apiFetch === "function"
      ? await apiFetch(url, opts)
      : await fetch(url, opts);
    return res.json();
  }

  // ── Open / close ───────────────────────────────────────────────────────────
  function openLaundryModal() {
    const modal = document.getElementById("laundry-modal");
    if (!modal) return;
    modal.classList.add("show");
    _switchTab("send");
    _loadPrices();
    _gridMonth = _todayMonth();
    _loadGrid(_gridMonth);
  }
  function closeLaundryModal() {
    document.getElementById("laundry-modal")?.classList.remove("show");
  }

  // ── Tab switching ──────────────────────────────────────────────────────────
  function _switchTab(tab) {
    document.querySelectorAll(".laundry-tab-pane").forEach(p => p.classList.remove("active"));
    document.querySelectorAll(".laundry-tab-btn").forEach(b => b.classList.remove("active"));
    document.getElementById(`laundry-tab-${tab}`)?.classList.add("active");
    document.querySelector(`.laundry-tab-btn[data-tab="${tab}"]`)?.classList.add("active");
    if (tab === "bill") {
      _loadAllBills();
      _selectedBillMonth = _todayMonth();
      const mp = document.getElementById("laundry-bill-month");
      if (mp) mp.value = _selectedBillMonth;
      const d = _billRangeDefaults(_selectedBillMonth);
      _setBillRangeInputs(d.from, d.to);
      _loadMonthlyData(_selectedBillMonth);
    }
  }

  // ── Prices ─────────────────────────────────────────────────────────────────
  async function _loadPrices() {
    try {
      const res = await _fetch("/laundry/settings");
      if (res.success) {
        _prices = res.prices || {};
        _renderPriceEditor();
        _recalcAutoAmount();
      }
    } catch (e) { console.error("loadPrices", e); }
  }
  function _renderPriceEditor() {
    ITEMS.forEach(item => {
      const inp = document.getElementById(`lprice-${item.key}`);
      if (inp) inp.value = _prices[item.key] ?? 100;
    });
  }
  async function _savePrices() {
    const payload = {};
    ITEMS.forEach(item => {
      const inp = document.getElementById(`lprice-${item.key}`);
      payload[item.key] = parseInt(inp?.value) || 100;
    });
    try {
      const res = await _fetch("/laundry/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.success) {
        _prices = payload;
        _notify("Prices saved ✓");
        _recalcAutoAmount();
      } else {
        _notify(res.message || "Failed to save prices", "error");
      }
    } catch (e) { _notify("Error saving prices", "error"); }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TAB 1 — EXCEL GRID
  // ══════════════════════════════════════════════════════════════════════════

  async function _loadGrid(month) {
    _gridLogs = {};
    _editingIds.clear();
    _updateGridLabel(month);
    const body = document.getElementById("laundry-excel-body");
    const foot = document.getElementById("laundry-excel-foot");
    if (body) body.innerHTML = `<tr><td colspan="12" class="laundry-empty-state">Loading…</td></tr>`;
    if (foot) foot.innerHTML = "";

    try {
      const [res, lockRes] = await Promise.all([
        _fetch(`/laundry/logs?month=${month}`),
        _fetch(`/laundry/locks?month=${month}`).catch(() => null),
      ]);
      (res.logs || []).forEach(log => { _gridLogs[log.date] = log; });
      _gridLocks = {
        monthLocked: !!(lockRes && lockRes.month_locked),
        dates: new Set((lockRes && lockRes.locked_dates) || []),
      };
      _renderGrid(month);
    } catch (e) {
      if (body) body.innerHTML = `<tr><td colspan="12" class="laundry-empty-state">Error loading</td></tr>`;
    }
  }

  // ── Data-lock helpers (admin only) ────────────────────────────────────────
  function _canManageLaundryLocks() {
    return !!(window.CibaraAuth &&
      typeof window.CibaraAuth.userCan === "function" &&
      window.CibaraAuth.userCan("laundry.lock.manage"));
  }
  function _dateIsLocked(date) {
    return _gridLocks.monthLocked || _gridLocks.dates.has(date);
  }
  async function _setLaundryLock(action, date) {
    const locking = action.indexOf("lock_") === 0 && action.indexOf("un") !== 0;
    const target  = date || _monthLabel(_gridMonth);
    const msg = locking
      ? `Lock ${target}? No one will be able to change this data until an admin unlocks it.`
      : `Unlock ${target}? Edits will be allowed again.`;
    if (!confirm(msg)) return;
    try {
      const res = await _fetch("/laundry/lock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month: _gridMonth, action, date: date || "" }),
      });
      if (res.success) {
        _notify("✓ " + (res.message || "Done"));
        _loadGrid(_gridMonth);
      } else {
        _notify(res.message || "Failed", "error");
      }
    } catch (e) {
      _notify("Error updating lock", "error");
    }
  }
  window.laundryToggleDateLock = function (date, isLocked) {
    _setLaundryLock(isLocked ? "unlock_date" : "lock_date", date);
  };

  // Month lock/unlock button next to the grid's month label (admin only).
  function _ensureMonthLockBtn() {
    const lbl = document.getElementById("laundry-grid-month-label");
    if (!lbl || !lbl.parentNode) return;
    let btn = document.getElementById("laundry-month-lock-btn");
    if (!_canManageLaundryLocks()) { if (btn) btn.remove(); return; }
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "laundry-month-lock-btn";
      btn.className = "laundry-tbl-btn";
      btn.style.cssText = "margin-left:0.6rem;padding:0.25rem 0.6rem;";
      lbl.parentNode.insertBefore(btn, lbl.nextSibling);
    }
    btn.textContent = _gridLocks.monthLocked ? "🔓 Unlock Month" : "🔒 Lock Month";
    btn.title = _gridLocks.monthLocked
      ? "Allow edits to this month again"
      : "Freeze every date in this month against edits";
    btn.onclick = function () {
      _setLaundryLock(_gridLocks.monthLocked ? "unlock_month" : "lock_month", null);
    };

    // Calendar picker button — select multiple dates and lock/unlock in one go.
    let calBtn = document.getElementById("laundry-date-lock-btn");
    if (!calBtn) {
      calBtn = document.createElement("button");
      calBtn.id = "laundry-date-lock-btn";
      calBtn.className = "laundry-tbl-btn";
      calBtn.style.cssText = "margin-left:0.4rem;padding:0.25rem 0.6rem;";
      btn.parentNode.insertBefore(calBtn, btn.nextSibling);
    }
    calBtn.textContent = "📅 Lock Dates";
    calBtn.title = "Pick dates on a calendar to lock or unlock them";
    calBtn.onclick = _openLockCalendar;
  }

  // ── Calendar lock picker (admin) ──────────────────────────────────────────
  // Tap dates to select (dark = already locked), then Lock/Unlock Selected.
  let _lockCalSelected = new Set();

  function _ensureLockCalDom() {
    if (document.getElementById("llk-overlay")) return;
    const style = document.createElement("style");
    style.id = "llk-styles";
    style.textContent = `
      #llk-overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);display:none;align-items:center;justify-content:center;z-index:10070;}
      #llk-overlay.show{display:flex;}
      .llk-box{background:#fff;border-radius:12px;max-width:380px;width:94%;padding:1rem 1.1rem;box-shadow:0 10px 40px rgba(0,0,0,.25);}
      .llk-title{font-weight:700;font-size:1rem;margin-bottom:.3rem;color:#0f172a;}
      .llk-sub{font-size:.76rem;color:#64748b;margin-bottom:.65rem;line-height:1.35;}
      .llk-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;}
      .llk-dow{font-size:.68rem;color:#64748b;text-align:center;font-weight:700;padding:2px 0;}
      .llk-day{border:1px solid #e2e8f0;border-radius:8px;padding:.5rem 0;text-align:center;font-size:.85rem;cursor:pointer;user-select:none;background:#fff;color:#0f172a;}
      .llk-day.disabled{opacity:.35;cursor:not-allowed;}
      .llk-day.locked{background:#475569;color:#fff;border-color:#475569;}
      .llk-day.selected{outline:3px solid #0ea5e9;outline-offset:-2px;font-weight:700;}
      .llk-legend{display:flex;gap:.8rem;font-size:.7rem;color:#64748b;margin-top:.55rem;align-items:center;flex-wrap:wrap;}
      .llk-chip{display:inline-block;width:12px;height:12px;border-radius:4px;vertical-align:-2px;margin-right:4px;}
      .llk-foot{display:flex;gap:.5rem;margin-top:.8rem;}
      .llk-btn{flex:1;border:0;border-radius:8px;padding:.55rem .5rem;font-weight:600;cursor:pointer;font-size:.82rem;}
      .llk-lockb{background:#0f172a;color:#fff;}
      .llk-unlockb{background:#e2e8f0;color:#0f172a;}
      .llk-closeb{background:transparent;color:#64748b;flex:0 0 auto;padding:.55rem .8rem;}
    `;
    document.head.appendChild(style);

    const ov = document.createElement("div");
    ov.id = "llk-overlay";
    ov.innerHTML = `<div class="llk-box">
      <div class="llk-title" id="llk-title">Lock dates</div>
      <div class="llk-sub">Tap dates to select, then lock or unlock them.
        Locked dates can't be edited by anyone until an admin unlocks them.</div>
      <div class="llk-grid" id="llk-grid"></div>
      <div class="llk-legend">
        <span><span class="llk-chip" style="background:#475569;"></span>Locked</span>
        <span><span class="llk-chip" style="background:#fff;border:2px solid #0ea5e9;"></span>Selected</span>
        <span><span class="llk-chip" style="background:#e2e8f0;"></span>Future (n/a)</span>
      </div>
      <div class="llk-foot">
        <button class="llk-btn llk-lockb"   id="llk-lock-btn">🔒 Lock selected</button>
        <button class="llk-btn llk-unlockb" id="llk-unlock-btn">🔓 Unlock selected</button>
        <button class="llk-btn llk-closeb"  id="llk-close-btn">✕</button>
      </div></div>`;
    document.body.appendChild(ov);

    ov.addEventListener("click", (e) => {
      if (e.target === ov) ov.classList.remove("show");
    });
    document.getElementById("llk-close-btn").onclick =
      () => ov.classList.remove("show");
    document.getElementById("llk-lock-btn").onclick   = () => _applyCalLock(true);
    document.getElementById("llk-unlock-btn").onclick = () => _applyCalLock(false);
  }

  function _openLockCalendar() {
    if (!_canManageLaundryLocks()) return;
    if (_gridLocks.monthLocked) {
      _notify("The whole month is locked — unlock the month first to manage single dates.", "error");
      return;
    }
    _ensureLockCalDom();
    _lockCalSelected = new Set();

    const title = document.getElementById("llk-title");
    if (title) title.textContent = `Lock dates — ${_monthLabel(_gridMonth)}`;

    const grid  = document.getElementById("llk-grid");
    const today = _todayDate();
    const dows  = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
    let html = dows.map(d => `<div class="llk-dow">${d}</div>`).join("");

    // Leading blanks so day 1 lands on its weekday column.
    const [y, m] = _gridMonth.split("-").map(Number);
    const firstDow = new Date(y, m - 1, 1).getDay();
    for (let i = 0; i < firstDow; i++) html += `<div></div>`;

    _daysInMonth(_gridMonth).forEach(date => {
      const dayNum   = parseInt(date.slice(8), 10);
      const isFuture = date > today;
      const locked   = _gridLocks.dates.has(date);
      const cls = ["llk-day",
                   isFuture ? "disabled" : "",
                   locked ? "locked" : ""].filter(Boolean).join(" ");
      html += `<div class="${cls}" data-date="${date}">${dayNum}</div>`;
    });
    grid.innerHTML = html;

    grid.querySelectorAll(".llk-day:not(.disabled)").forEach(cell => {
      cell.onclick = function () {
        const d = cell.dataset.date;
        if (_lockCalSelected.has(d)) {
          _lockCalSelected.delete(d);
          cell.classList.remove("selected");
        } else {
          _lockCalSelected.add(d);
          cell.classList.add("selected");
        }
      };
    });

    document.getElementById("llk-overlay").classList.add("show");
  }

  async function _applyCalLock(lock) {
    const dates = Array.from(_lockCalSelected).sort();
    if (!dates.length) {
      _notify("Tap at least one date first", "error");
      return;
    }
    try {
      const res = await _fetch("/laundry/lock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          month:  _gridMonth,
          action: lock ? "lock_dates" : "unlock_dates",
          dates:  dates,
        }),
      });
      if (res.success) {
        _notify(`✓ ${dates.length} date(s) ${lock ? "locked" : "unlocked"}`);
        document.getElementById("llk-overlay")?.classList.remove("show");
        _loadGrid(_gridMonth);
      } else {
        _notify(res.message || "Failed", "error");
      }
    } catch (e) {
      _notify("Error updating locks", "error");
    }
  }

  function _updateGridLabel(month) {
    const lbl = document.getElementById("laundry-grid-month-label");
    if (lbl) lbl.textContent = _monthLabel(month);
    const inp = document.getElementById("laundry-grid-month-inp");
    if (inp) inp.value = month;
  }

  function _renderGrid(month) {
    const body  = document.getElementById("laundry-excel-body");
    const foot  = document.getElementById("laundry-excel-foot");
    if (!body) return;

    const today = _todayDate();
    const days  = _daysInMonth(month);
    const monthTotals = { ...Object.fromEntries(ITEMS.map(i => [i.key, 0])), grand: 0 };

    body.innerHTML = days.map(date => {
      const log      = _gridLogs[date];
      const isToday  = date === today;
      const isFuture = date > today;
      const hasData  = !!log;
      const received = log?.status === "received";
      const isLocked = _dateIsLocked(date);
      // A locked row is always read-only, even if it was mid-edit.
      const editing  = !isLocked && log && _editingIds.has(log.doc_id);

      // accumulate totals
      if (hasData) {
        ITEMS.forEach(i => { monthTotals[i.key] += log[i.key] || 0; });
        monthTotals.grand += log.total || 0;
      }

      const rowClass = [
        isToday  ? "row-today"   : "",
        isFuture ? "row-future"  : "",
        received ? "row-received": "",
      ].filter(Boolean).join(" ");

      const dateLbl = _fmtDate(date);

      // Item cells — locked rows render read-only values, never inputs.
      const itemCells = ITEMS.map(item => {
        if (!isLocked && (!hasData || editing)) {
          // Editable input — empty by default so typing replaces nothing
          const val = editing ? (log[item.key] || "") : "";
          return `<td><input type="number" class="laundry-cell-input" data-date="${date}" data-key="${item.key}" data-docid="${log?.doc_id || ""}" value="${val}" min="0" placeholder="0" /></td>`;
        } else {
          const v = (log && log[item.key]) || 0;
          return `<td><span class="laundry-cell-val ${v === 0 ? "zero" : ""}">${v === 0 ? "−" : v}</span></td>`;
        }
      }).join("");

      // Total cell
      let totalCell;
      if (!isLocked && (!hasData || editing)) {
        totalCell = `<td class="cell-total" id="row-total-${date}">0</td>`;
      } else {
        totalCell = `<td class="cell-total">${(log && log.total) || 0}</td>`;
      }

      // Status cell — the lock takes display priority.
      let statusCell;
      if (isLocked) {
        statusCell = `<td><span class="laundry-status-badge" style="background:#475569;color:#fff;">🔒 Locked</span></td>`;
      } else if (!hasData) {
        statusCell = isFuture
          ? `<td><span class="laundry-status-badge empty">—</span></td>`
          : `<td><span class="laundry-status-badge empty">Not sent</span></td>`;
      } else if (received) {
        statusCell = `<td><span class="laundry-status-badge received">✓ Received</span></td>`;
      } else {
        statusCell = `<td><span class="laundry-status-badge sent">Sent</span></td>`;
      }

      // Action cell
      const _adminLocks = _canManageLaundryLocks();
      let actionCell;
      if (isLocked) {
        // Only an admin can unlock; a month lock is undone via the month
        // button, a date lock via the row button.
        if (_adminLocks && !_gridLocks.monthLocked) {
          actionCell = `<td>
            <button class="laundry-tbl-btn" style="background:#475569;color:#fff;" onclick="laundryToggleDateLock('${date}', true)">🔓 Unlock</button>
          </td>`;
        } else {
          actionCell = `<td></td>`;
        }
      } else if (!hasData && !isFuture) {
        // New row — Save button
        actionCell = `<td>
          <button class="laundry-tbl-btn save" onclick="laundrySaveRow('${date}', this)">Save</button>
        </td>`;
      } else if (editing) {
        // In edit mode — Save + Cancel
        actionCell = `<td>
          <button class="laundry-tbl-btn save" onclick="laundryUpdateRow('${log.doc_id}', '${date}', this)">Save</button>
          <button class="laundry-tbl-btn cancel" onclick="laundryCancelEdit('${log.doc_id}', '${date}')">✕</button>
        </td>`;
      } else if (hasData) {
        // Saved row — Received + Edit
        const recvCls = received ? "recv done" : "recv";
        const recvTxt = received ? "✓ Recv'd" : "Received";
        const recvDis = received ? "disabled" : `onclick="laundryReceiveRow('${log.doc_id}', this)"`;
        actionCell = `<td>
          <button class="laundry-tbl-btn ${recvCls}" ${recvDis}>${recvTxt}</button>
          <button class="laundry-tbl-btn edit" onclick="laundryEditRow('${log.doc_id}', '${date}')">✏ Edit</button>
        </td>`;
      } else {
        actionCell = `<td></td>`;
      }
      // Admin: per-date lock button on unlocked, non-future rows.
      if (!isLocked && !isFuture && _adminLocks) {
        actionCell = actionCell.replace(
          "</td>",
          ` <button class="laundry-tbl-btn" title="Lock this date against edits" style="opacity:.75;" onclick="laundryToggleDateLock('${date}', false)">🔒</button></td>`
        );
      }

      return `<tr class="${rowClass}" id="grid-row-${date}" data-date="${date}">
        <td>${dateLbl}${isToday ? ' <span style="color:#e53e3e;font-size:0.65rem">TODAY</span>' : ""}</td>
        ${itemCells}
        ${totalCell}
        ${statusCell}
        ${actionCell}
      </tr>`;
    }).join("");

    // Footer totals row
    const footCells = ITEMS.map(i => `<td>${monthTotals[i.key] || "—"}</td>`).join("");
    foot.innerHTML = `<tr>
      <td>Monthly Total</td>
      ${footCells}
      <td>${monthTotals.grand || "—"}</td>
      <td colspan="2"></td>
    </tr>`;

    // Wire input listeners for live row-total calc + focus-select behaviour
    body.querySelectorAll(".laundry-cell-input").forEach(inp => {
      inp.addEventListener("input", () => _recalcRowTotal(inp.dataset.date));
      // Select all on focus so typing always replaces the existing value cleanly
      inp.addEventListener("focus", () => inp.select());
      // Enter → move to next cell (next column, or first cell of next row)
      inp.addEventListener("keydown", e => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        const all = Array.from(body.querySelectorAll(".laundry-cell-input"));
        const idx = all.indexOf(inp);
        const next = all[idx + 1];
        if (next) { next.focus(); next.select(); }
      });
    });

    // Month lock/unlock control (admin only)
    _ensureMonthLockBtn();

    // Scroll today into view
    const todayRow = document.getElementById(`grid-row-${today}`);
    if (todayRow) setTimeout(() => todayRow.scrollIntoView({ block: "center", behavior: "smooth" }), 150);
  }

  function _recalcRowTotal(date) {
    const inputs = document.querySelectorAll(`.laundry-cell-input[data-date="${date}"]`);
    const total  = Array.from(inputs).reduce((s, i) => s + (parseInt(i.value) || 0), 0);
    const cell   = document.getElementById(`row-total-${date}`);
    if (cell) cell.textContent = total;
  }

  function _getRowData(date) {
    const inputs = document.querySelectorAll(`.laundry-cell-input[data-date="${date}"]`);
    const data = { date };
    let total = 0;
    inputs.forEach(inp => {
      const qty = parseInt(inp.value) || 0;
      data[inp.dataset.key] = qty;
      total += qty;
    });
    data.total = total;
    return { data, total };
  }

  // ── Save new row ──────────────────────────────────────────────────────────
  window.laundrySaveRow = async function (date, btn) {
    if (_dateIsLocked(date)) {
      _notify("This date is locked by admin — data can't be changed.", "error");
      return;
    }
    const { data, total } = _getRowData(date);
    if (total === 0) { _notify("Enter at least one item", "error"); return; }
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      const res = await _fetch("/laundry/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (res.success) {
        _notify("✓ Saved");
        _loadGrid(_gridMonth);
      } else {
        _notify(res.message || "Failed", "error");
        btn.disabled = false; btn.textContent = "Save";
      }
    } catch (e) {
      _notify("Error saving", "error");
      btn.disabled = false; btn.textContent = "Save";
    }
  };

  // ── Edit row — no password, freely editable once modal is open ───────────
  window.laundryEditRow = function (docId, date) {
    if (_dateIsLocked(date)) {
      _notify("This date is locked by admin — data can't be changed.", "error");
      return;
    }
    _unlockRow(docId, date);
  };

  function _unlockRow(docId, date) {
    _editingIds.add(docId);
    _renderGrid(_gridMonth);  // re-render with this row in edit mode
    // Scroll to row
    setTimeout(() => {
      document.getElementById(`grid-row-${date}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 100);
  }

  // ── Update existing row ───────────────────────────────────────────────────
  window.laundryUpdateRow = async function (docId, date, btn) {
    if (_dateIsLocked(date)) {
      _notify("This date is locked by admin — data can't be changed.", "error");
      return;
    }
    const { data, total } = _getRowData(date);
    if (total === 0) { _notify("Enter at least one item", "error"); return; }
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      const res = await _fetch(`/laundry/update/${docId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (res.success) {
        _notify("✓ Updated");
        _editingIds.delete(docId);
        _loadGrid(_gridMonth);
      } else {
        _notify(res.message || "Failed", "error");
        btn.disabled = false; btn.textContent = "Save";
      }
    } catch (e) {
      _notify("Error updating", "error");
      btn.disabled = false; btn.textContent = "Save";
    }
  };

  // ── Cancel edit ───────────────────────────────────────────────────────────
  window.laundryCancelEdit = function (docId) {
    _editingIds.delete(docId);
    _renderGrid(_gridMonth);
  };

  // ── Mark received ─────────────────────────────────────────────────────────
  window.laundryReceiveRow = async function (docId, btn) {
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      const res = await _fetch(`/laundry/receive/${docId}`, { method: "POST" });
      if (res.success) {
        _notify("✓ Marked as received");
        // Update local state and re-render
        for (const [date, log] of Object.entries(_gridLogs)) {
          if (log.doc_id === docId) {
            _gridLogs[date] = { ...log, status: "received" };
            break;
          }
        }
        _renderGrid(_gridMonth);
      } else {
        _notify(res.message || "Failed", "error");
        btn.disabled = false; btn.textContent = "Received";
      }
    } catch (e) {
      _notify("Error", "error");
      btn.disabled = false; btn.textContent = "Received";
    }
  };

  // ── Month navigation ──────────────────────────────────────────────────────
  function _shiftMonth(delta) {
    const [y, m] = _gridMonth.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    _gridMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    _loadGrid(_gridMonth);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TAB 2 — MONTHLY BILL
  // ══════════════════════════════════════════════════════════════════════════

  async function _loadAllBills() {
    try {
      const res = await _fetch("/laundry/all_bills");
      _allBills = res.bills || [];
      _renderBillHistory();
    } catch (e) { console.error("loadAllBills", e); }
  }

  function _renderBillHistory() {
    const wrap = document.getElementById("laundry-bill-hist-body");
    if (!wrap) return;

    if (!_allBills.length) {
      wrap.innerHTML = `<tr><td colspan="5" class="laundry-empty-state" style="padding:1rem">No bills yet</td></tr>`;
      return;
    }

    const cur = _getBillRange();
    wrap.innerHTML = _allBills.map(b => {
      // Period bill = carries a period narrower than its full month.
      const d = b.month ? _billRangeDefaults(b.month) : null;
      const hasPeriod = !!(b.period_start && b.period_end && d &&
        !(b.period_start === d.from && b.period_end === d.to));
      const isSel = b.month === _selectedBillMonth &&
        (hasPeriod
          ? (b.period_start === cur.from && b.period_end === cur.to)
          : (cur.from === (d && d.from) && cur.to === (d && d.to)));
      const label = hasPeriod
        ? `${_fmtDate(b.period_start)}–${_fmtDate(b.period_end)}`
        : _fmtMonthShort(b.month);
      const click = hasPeriod
        ? `laundrySelectBillPeriod('${b.month}','${b.period_start}','${b.period_end}')`
        : `laundrySelectBillMonth('${b.month}')`;
      const bal   = b.balance || 0;
      const paid  = b.paid_total != null ? b.paid_total : (b.paid_amount || 0);
      const count = (b.payments || []).length;
      const countBadge = count > 1
        ? ` <span style="font-size:0.62rem;color:#64748b;font-weight:500">(${count} payments)</span>`
        : "";
      return `<tr class="${isSel ? "selected-hist" : ""}" style="cursor:pointer" onclick="${click}">
        <td class="col-month" style="white-space:nowrap">${label}</td>
        <td>${_inr(b.bill_amount)}</td>
        <td>${_inr(paid)}${countBadge}</td>
        <td class="col-bal ${bal === 0 ? "zero" : ""}">${_inr(bal)}</td>
        <td style="font-size:0.68rem;color:var(--text-muted)">${b.bill_date || "—"}</td>
      </tr>`;
    }).join("");
  }

  // Open a specific PERIOD bill from the history list.
  window.laundrySelectBillPeriod = function (month, from, to) {
    _selectedBillMonth = month;
    const mp = document.getElementById("laundry-bill-month");
    if (mp) mp.value = month;
    _setBillRangeInputs(from, to);
    _renderBillHistory();
    _loadMonthlyData(month, true);
  };

  window.laundrySelectBillMonth = function (month) {
    _selectedBillMonth = month;
    const mp = document.getElementById("laundry-bill-month");
    if (mp) mp.value = month;
    const d = _billRangeDefaults(month);
    _setBillRangeInputs(d.from, d.to);
    _renderBillHistory();
    _loadMonthlyData(month);
  };

  // ── Billing period (from → to) ────────────────────────────────────────────
  // The bill amount is calculated only for this range (defaults to the full
  // month). The response echoes the range so the UI can show exactly which
  // dates the totals cover; the range is saved on the bill doc.
  function _billRangeDefaults(month) {
    return {
      from: `${month}-01`,
      to:   `${month}-${String(_monthDays(month)).padStart(2, "0")}`,
    };
  }
  function _getBillRange() {
    const d = _billRangeDefaults(_selectedBillMonth);
    return {
      from: document.getElementById("laundry-bill-from")?.value || d.from,
      to:   document.getElementById("laundry-bill-to")?.value   || d.to,
    };
  }
  function _setBillRangeInputs(from, to) {
    const f = document.getElementById("laundry-bill-from");
    const t = document.getElementById("laundry-bill-to");
    if (f) f.value = from;
    if (t) t.value = to;
    // Single-selector button label
    const btn = document.getElementById("laundry-bill-range-btn");
    if (btn) {
      const d = _billRangeDefaults(_selectedBillMonth);
      btn.textContent = (from === d.from && to === d.to)
        ? "📅 Full month"
        : `📅 ${_fmtDate(from)} → ${_fmtDate(to)}`;
    }
  }

  // ── Single range-picker calendar (tap start, tap end) ────────────────────
  let _lbrView  = _todayMonth();   // month shown in the picker
  let _lbrStart = null;
  let _lbrEnd   = null;

  function _ensureBillRangeCalDom() {
    if (document.getElementById("lbr-overlay")) return;
    const style = document.createElement("style");
    style.textContent = `
      #lbr-overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);display:none;align-items:center;justify-content:center;z-index:10070;}
      #lbr-overlay.show{display:flex;}
      .lbr-box{background:#fff;border-radius:12px;max-width:380px;width:94%;padding:1rem 1.1rem;box-shadow:0 10px 40px rgba(0,0,0,.25);}
      .lbr-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:.4rem;}
      .lbr-title{font-weight:700;color:#0f172a;}
      .lbr-nav{border:1px solid #e2e8f0;background:#fff;border-radius:8px;padding:.2rem .6rem;cursor:pointer;font-size:1rem;}
      .lbr-hint{font-size:.76rem;color:#1d4ed8;background:#eff6ff;border-radius:6px;padding:.3rem .55rem;margin-bottom:.55rem;font-weight:600;}
      .lbr-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px;}
      .lbr-dow{font-size:.68rem;color:#64748b;text-align:center;font-weight:700;padding:2px 0;}
      .lbr-day{border:1px solid #e2e8f0;border-radius:8px;padding:.5rem 0;text-align:center;font-size:.85rem;cursor:pointer;user-select:none;background:#fff;color:#0f172a;}
      /* Payment status of the bill covering the day (before range/endpoint
         so an active selection still shows blue on top). */
      .lbr-day.paid{background:#dcfce7;border-color:#86efac;color:#166534;}
      .lbr-day.due{background:#fee2e2;border-color:#fca5a5;color:#991b1b;}
      .lbr-day.range{background:#dbeafe;border-color:#bfdbfe;color:#0f172a;}
      .lbr-day.endpoint{background:#1d4ed8;color:#fff;border-color:#1d4ed8;font-weight:700;}
      .lbr-legend{display:flex;gap:.8rem;font-size:.7rem;color:#64748b;margin-top:.55rem;align-items:center;flex-wrap:wrap;}
      .lbr-chip{display:inline-block;width:12px;height:12px;border-radius:4px;vertical-align:-2px;margin-right:4px;}
      .lbr-foot{display:flex;gap:.5rem;margin-top:.8rem;}
      .lbr-btn{flex:1;border:0;border-radius:8px;padding:.55rem .5rem;font-weight:600;cursor:pointer;font-size:.82rem;}
      .lbr-full{background:#e2e8f0;color:#0f172a;}
      .lbr-cancel{background:transparent;color:#64748b;flex:0 0 auto;padding:.55rem .8rem;}
    `;
    document.head.appendChild(style);

    const ov = document.createElement("div");
    ov.id = "lbr-overlay";
    ov.innerHTML = `<div class="lbr-box">
      <div class="lbr-head">
        <button class="lbr-nav" id="lbr-prev">‹</button>
        <div class="lbr-title" id="lbr-title"></div>
        <button class="lbr-nav" id="lbr-next">›</button>
      </div>
      <div class="lbr-hint" id="lbr-hint"></div>
      <div class="lbr-grid" id="lbr-grid"></div>
      <div class="lbr-legend">
        <span><span class="lbr-chip" style="background:#dcfce7;border:1px solid #86efac;"></span>Paid</span>
        <span><span class="lbr-chip" style="background:#fee2e2;border:1px solid #fca5a5;"></span>Balance due</span>
        <span><span class="lbr-chip" style="background:#fff;border:1px solid #e2e8f0;"></span>Not billed</span>
      </div>
      <div class="lbr-foot">
        <button class="lbr-btn lbr-full" id="lbr-full-btn">Full month</button>
        <button class="lbr-btn lbr-cancel" id="lbr-cancel-btn">Cancel</button>
      </div></div>`;
    document.body.appendChild(ov);

    ov.addEventListener("click", (e) => {
      if (e.target === ov) ov.classList.remove("show");
    });
    document.getElementById("lbr-cancel-btn").onclick =
      () => ov.classList.remove("show");
    document.getElementById("lbr-prev").onclick = () => _lbrShiftMonth(-1);
    document.getElementById("lbr-next").onclick = () => _lbrShiftMonth(1);
    document.getElementById("lbr-full-btn").onclick = function () {
      const d = _billRangeDefaults(_selectedBillMonth);
      _applyBillRange(d.from, d.to);
    };
  }

  // Payment status of the bill covering a date: "paid" (balance settled),
  // "due" (billed, balance outstanding), or null (no bill covers the day).
  // Legacy month bills without a period count as full-month coverage.
  function _dayBillStatus(date) {
    for (const b of _allBills) {
      let s = b.period_start, e = b.period_end;
      if (!s || !e) {
        if (!b.month) continue;
        const d = _billRangeDefaults(b.month);
        s = d.from; e = d.to;
      }
      if (date >= s && date <= e) {
        // Compare payments against the bill's OWN amount — NOT the running
        // balance, which includes old balance carried from earlier bills.
        // Otherwise one unpaid old bill would paint every later day red
        // even when that day's own amount is fully paid. The shortfall
        // stays red on the days of the bill that actually owes it.
        const own  = (b.bill_amount != null) ? b.bill_amount : 0;
        const paid = (b.paid_total != null) ? b.paid_total : (b.paid_amount || 0);
        return paid >= own ? "paid" : "due";
      }
    }
    return null;
  }

  function _lbrShiftMonth(delta) {
    const [y, m] = _lbrView.split("-").map(Number);
    const dt = new Date(y, m - 1 + delta, 1);
    _lbrView = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
    _renderBillRangeCal();
  }

  function _renderBillRangeCal() {
    const title = document.getElementById("lbr-title");
    const hint  = document.getElementById("lbr-hint");
    const grid  = document.getElementById("lbr-grid");
    if (!grid) return;
    if (title) title.textContent = _monthLabel(_lbrView);
    if (hint) {
      hint.textContent = !_lbrStart
        ? "Tap the START date"
        : `Start: ${_fmtDate(_lbrStart)} — now tap the END date`;
    }

    const dows = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
    let html = dows.map(d => `<div class="lbr-dow">${d}</div>`).join("");
    const [y, m] = _lbrView.split("-").map(Number);
    const firstDow = new Date(y, m - 1, 1).getDay();
    for (let i = 0; i < firstDow; i++) html += `<div></div>`;

    _daysInMonth(_lbrView).forEach(date => {
      const dayNum = parseInt(date.slice(8), 10);
      const isEndpoint = date === _lbrStart || date === _lbrEnd;
      const inRange = _lbrStart && _lbrEnd &&
        date > _lbrStart && date < _lbrEnd;
      const payStatus = _dayBillStatus(date);   // paid | due | null
      const cls = ["lbr-day",
                   payStatus || "",
                   inRange ? "range" : "",
                   isEndpoint ? "endpoint" : ""].filter(Boolean).join(" ");
      html += `<div class="${cls}" data-date="${date}">${dayNum}</div>`;
    });
    grid.innerHTML = html;

    grid.querySelectorAll(".lbr-day").forEach(cell => {
      cell.onclick = function () {
        const d = cell.dataset.date;
        if (!_lbrStart || (_lbrStart && _lbrEnd)) {
          // Fresh selection (or restart after a completed one)
          _lbrStart = d;
          _lbrEnd = null;
          _renderBillRangeCal();
        } else {
          // Second tap — end date. Earlier than start? Swap.
          _lbrEnd = d;
          if (_lbrEnd < _lbrStart) {
            const t = _lbrStart; _lbrStart = _lbrEnd; _lbrEnd = t;
          }
          _applyBillRange(_lbrStart, _lbrEnd);
        }
      };
    });
  }

  function _applyBillRange(from, to) {
    document.getElementById("lbr-overlay")?.classList.remove("show");
    _setBillRangeInputs(from, to);
    _loadMonthlyData(_selectedBillMonth, true);
  }

  function _openBillRangeCal() {
    _ensureBillRangeCalDom();
    const { from, to } = _getBillRange();
    _lbrStart = from;
    _lbrEnd   = to;
    _lbrView  = from.slice(0, 7);
    _renderBillRangeCal();
    document.getElementById("lbr-overlay").classList.add("show");
  }
  function _updateBillPeriodLabel(res) {
    const el = document.getElementById("laundry-bill-period-label");
    if (!el) return;
    if (!res || !res.period_start) { el.style.display = "none"; return; }
    const pieces = (res.totals && res.totals.grand) || 0;
    const days = res.period_days || 0;
    el.textContent =
      `Calculated from ${_fmtDate(res.period_start)} to ${_fmtDate(res.period_end)} ` +
      `(${days} day${days === 1 ? "" : "s"} · ${pieces} pieces)`;
    el.style.display = "block";
  }

  async function _loadMonthlyData(month, skipRestore) {
    try {
      const { from, to } = _getBillRange();
      const res = await _fetch(
        `/laundry/monthly/${month}?start=${from}&end=${to}`);
      if (res.success === false) {
        _notify(res.message || "Failed to load month", "error");
        return;
      }
      _monthlyData = res;

      // Reopening a saved bill: if it carries its own billing period and the
      // user hasn't picked one (inputs still at the full-month default),
      // restore the saved range once so the form shows what was billed.
      const d = _billRangeDefaults(month);
      if (!skipRestore && res.bill &&
          res.bill.period_start && res.bill.period_end &&
          from === d.from && to === d.to &&
          (res.bill.period_start !== from || res.bill.period_end !== to)) {
        _setBillRangeInputs(res.bill.period_start, res.bill.period_end);
        return _loadMonthlyData(month, true);
      }

      _renderMonthlySummary(res.totals || {});
      _updateBillPeriodLabel(res);
      _populateBillForm(res.bill);
      _recalcAutoAmount();
      _updateMonthlyCalc();
    } catch (e) { console.error("loadMonthlyData", e); }
  }

  function _renderMonthlySummary(totals) {
    const grid = document.getElementById("laundry-bill-summary-grid");
    if (!grid) return;
    grid.innerHTML = ITEMS.map(item => `
      <div class="laundry-bill-summary-cell">
        <span class="lbl">${item.short}</span>
        <span class="val">${totals[item.key] || 0}</span>
      </div>`).join("") +
      `<div class="laundry-bill-summary-cell" style="grid-column:span 4;border-top:1px solid var(--border,#e2e8f0);margin-top:0.25rem;padding-top:0.25rem">
        <span class="lbl">Total Pieces</span>
        <span class="val" style="color:var(--primary,#e53e3e)">${totals.grand || 0}</span>
      </div>`;
  }

  function _populateBillForm(bill) {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    if (!bill) {
      // Fresh month — clear bill fields so stale values from a previously
      // viewed month don't bleed in. Only old_balance carries forward.
      set("laundry-bill-amount", "");
      set("laundry-bill-date",   "");
      set("laundry-paid-amount", "");
      // Opening balance chains from the PREVIOUS period bill (server walks
      // all bills by period_end). Falls back to the legacy month walk.
      const _sug = _monthlyData ? _monthlyData.suggested_old_balance : null;
      set("laundry-old-balance",
          (_sug != null) ? _sug : _getPrevBalance(_selectedBillMonth));
      _renderPaymentHistory(null);
      _updateMonthlyCalc();
      return;
    }
    set("laundry-bill-amount",  bill.bill_amount  || "");
    set("laundry-bill-date",    bill.bill_date    || "");
    set("laundry-old-balance",  bill.old_balance  || 0);
    // "Paying Now" is always blank when reopening an existing bill —
    // it represents the amount paid in THIS transaction, not a running
    // total. The running total + balance live in the payment history
    // block below the form.
    set("laundry-paid-amount", "");
    if (bill.expense_type)   _setExpType(bill.expense_type);
    if (bill.payment_method) _setPayMethod(bill.payment_method);
    _renderPaymentHistory(bill);
    _updateMonthlyCalc();
  }

  // ── Payment history block (per-bill list of partial payments) ─────────────
  function _ensurePaymentHistoryContainer() {
    let host = document.getElementById("laundry-payment-history");
    if (host) return host;

    if (!document.getElementById("laundry-payment-history-style")) {
      const s = document.createElement("style");
      s.id = "laundry-payment-history-style";
      s.textContent = `
        #laundry-payment-history {
          margin: 0.6rem 0 0;
          background: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          overflow: hidden;
          font-family: inherit;
        }
        .lph-header {
          padding: 8px 12px;
          background: #f8fafc;
          border-bottom: 1px solid #e2e8f0;
          font-size: 0.78rem;
          font-weight: 600;
          color: #334155;
          display: flex; justify-content: space-between; align-items: center;
        }
        .lph-header .lph-totals { font-weight: 500; color: #64748b; font-size: 0.72rem; }
        .lph-header .lph-totals strong { color: #0f172a; font-weight: 600; }
        .lph-list { list-style: none; margin: 0; padding: 0; }
        .lph-row {
          display: grid;
          grid-template-columns: 1fr auto auto auto;
          gap: 10px; align-items: center;
          padding: 7px 12px;
          font-size: 0.78rem; color: #0f172a;
          border-bottom: 1px solid #f1f5f9;
        }
        .lph-row:last-child { border-bottom: none; }
        .lph-row .lph-when    { color: #475569; font-weight: 500; }
        .lph-row .lph-method  {
          font-size: 0.66rem; font-weight: 600; letter-spacing: 0.04em;
          text-transform: uppercase;
          padding: 2px 6px; border-radius: 4px;
          color: #475569; background: #f1f5f9;
        }
        .lph-row .lph-method.cash { color: #047857; background: #ecfdf5; }
        .lph-row .lph-method.online,
        .lph-row .lph-method.upi  { color: #1d4ed8; background: #eff6ff; }
        .lph-row .lph-amount { font-weight: 600; color: #0f172a; }
        .lph-row .lph-del {
          background: transparent; border: none; cursor: pointer;
          color: #94a3b8; padding: 2px 6px; border-radius: 4px;
          font-size: 0.85rem;
        }
        .lph-row .lph-del:hover { color: #b91c1c; background: #fef2f2; }
        .lph-row.legacy .lph-del { display: none; }
        .lph-empty { padding: 10px 12px; font-size: 0.76rem; color: #94a3b8; text-align: center; }
`;
      document.head.appendChild(s);
    }

    const totals = document.querySelector(".laundry-bill-totals");
    host = document.createElement("div");
    host.id = "laundry-payment-history";
    if (totals && totals.parentNode) {
      totals.parentNode.insertBefore(host, totals.nextSibling);
    } else {
      const scroll = document.querySelector(".laundry-bill-scroll, .modal-body, body");
      (scroll || document.body).appendChild(host);
    }
    return host;
  }

  function _renderPaymentHistory(bill) {
    const host = _ensurePaymentHistoryContainer();
    const payments = (bill && bill.payments) || [];
    const paidTotal = payments.reduce((s, p) => s + (p.amount || 0), 0);
    const month     = bill && bill.month;
    // Which dates these payments settle — shown in the header so every
    // payment is unambiguously tied to its billed period.
    const periodTxt = (bill && bill.period_start && bill.period_end)
      ? ` <span style="font-weight:500;color:#64748b">· for ${_fmtDate(bill.period_start)} → ${_fmtDate(bill.period_end)}</span>`
      : "";

    if (!bill) {
      host.innerHTML = "";
      host.style.display = "none";
      return;
    }
    host.style.display = "";

    if (!payments.length) {
      host.innerHTML = `
        <div class="lph-header">
          <span><i class="fas fa-history"></i> Payment History${periodTxt}</span>
          <span class="lph-totals">No payments yet</span>
        </div>
        <div class="lph-empty">Use "Paying Now" above to record the first payment.</div>
      `;
      return;
    }

    const sorted = [...payments].sort((a, b) =>
      (a.created_at || "").localeCompare(b.created_at || "")
    );

    const rows = sorted.map(p => {
      const m = (p.method || "cash").toLowerCase();
      const when = p.date
        ? `${_fmtDate(p.date)}${p.time ? " " + p.time : ""}`
        : "—";
      const isLegacy = !!p.legacy;
      const delBtn = isLegacy
        ? "" // Legacy seeded entries have no real expense_id — hide delete
        : `<button class="lph-del"
                   title="Remove this payment (manager password required)"
                   onclick="laundryDeletePayment('${month}','${p.id}','${(bill && bill.period_key) || ""}')">
             <i class="fas fa-times"></i>
           </button>`;
      return `<li class="lph-row ${isLegacy ? "legacy" : ""}">
        <span class="lph-when">${when}</span>
        <span class="lph-method ${m}">${m}</span>
        <span class="lph-amount">${_inr(p.amount || 0)}</span>
        ${delBtn || '<span></span>'}
      </li>`;
    }).join("");

    host.innerHTML = `
      <div class="lph-header">
        <span><i class="fas fa-history"></i> Payment History
          <span style="font-weight:500;color:#64748b">(${payments.length})</span>${periodTxt}
        </span>
        <span class="lph-totals">Paid: <strong>${_inr(paidTotal)}</strong></span>
      </div>
      <ul class="lph-list">${rows}</ul>
    `;
  }

  // Triggered by the trash icon on a payment-history row.
  window.laundryDeletePayment = async function (month, paymentId, periodKey) {
    if (!month || !paymentId) return;
    const password = window.prompt(
      "Manager password to remove this payment:",
      ""
    );
    if (password === null) return;
    if (!password) {
      _notify("Password is required", "error");
      return;
    }
    try {
      const res = await _fetch("/laundry/payment/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, payment_id: paymentId, password,
                               period_key: periodKey || "" }),
      });
      if (res.success) {
        _notify(res.message || "Payment removed");
        _loadAllBills();
        _loadMonthlyData(month);
      } else {
        _notify(res.message || "Failed to remove payment", "error");
      }
    } catch (e) {
      _notify("Network error removing payment", "error");
    }
  };

  function _getPrevBalance(currentMonth) {
    // Find the bill just before currentMonth
    const prev = _allBills
      .filter(b => b.month < currentMonth)
      .sort((a, b) => b.month.localeCompare(a.month))[0];
    return prev?.balance || 0;
  }

  function _recalcAutoAmount() {
    const totals = _monthlyData?.totals || {};
    let auto = 0;
    ITEMS.forEach(item => { auto += (totals[item.key] || 0) * (_prices[item.key] || 100); });
    const hintEl = document.getElementById("laundry-auto-amount");
    if (hintEl) hintEl.textContent = auto > 0 ? `Auto: ${_inr(auto)}` : "";
    return auto;
  }

  function _updateMonthlyCalc() {
    const billAmt = parseInt(document.getElementById("laundry-bill-amount")?.value || 0) || 0;
    const oldBal  = parseInt(document.getElementById("laundry-old-balance")?.value || 0) || 0;
    const payNow  = parseInt(document.getElementById("laundry-paid-amount")?.value || 0) || 0;
    const grand   = billAmt + oldBal;

    // Already-paid comes from the saved bill's payments[]. The live form
    // math shows the balance AFTER this transaction would be saved.
    const alreadyPaid = (_monthlyData?.bill?.payments || [])
      .reduce((s, p) => s + (p.amount || 0), 0);
    const balanceAfter = grand - alreadyPaid - payNow;

    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set("laundry-bill-total-display",  _inr(billAmt));
    set("laundry-old-bal-display",     _inr(oldBal));
    set("laundry-grand-total-display", _inr(grand));
    set(
      "laundry-balance-display",
      _inr(Math.abs(balanceAfter)) + (balanceAfter < 0 ? " (Overpaid)" : "")
    );

    const balValEl = document.getElementById("laundry-balance-display");
    if (balValEl) balValEl.style.color = balanceAfter > 0 ? "#dc2626" : "#16a34a";

    const balBox = document.getElementById("laundry-balance-box");
    if (balBox) balBox.classList.toggle("zero", balanceAfter <= 0);
  }

  async function _submitMonthlyBill() {
    const month   = document.getElementById("laundry-bill-month")?.value;
    const billAmt = parseInt(document.getElementById("laundry-bill-amount")?.value || 0) || 0;
    const oldBal  = parseInt(document.getElementById("laundry-old-balance")?.value || 0) || 0;
    const paidAmt = parseInt(document.getElementById("laundry-paid-amount")?.value || 0) || 0;

    if (!month) { _notify("Select a month", "error"); return; }
    // Allow saving "totals only" with no payment, or a payment against an
    // already-saved bill (billAmt may carry over from saved data).
    const hasSavedBill = !!(_monthlyData && _monthlyData.bill);
    if (billAmt <= 0 && !hasSavedBill) {
      _notify("Enter bill amount", "error"); return;
    }

    const totals  = _monthlyData?.totals || {};
    const _range  = _getBillRange();
    const payload = {
      month,
      bill_date:      document.getElementById("laundry-bill-date")?.value || "",
      bill_amount:    billAmt,
      old_balance:    oldBal,
      paid_amount:    paidAmt,
      payment_method: _paymentMethod,
      expense_type:   _expenseType,
      // The date range the amount was calculated for — shown on the bill.
      period_start:   _range.from,
      period_end:     _range.to,
    };
    ITEMS.forEach(item => {
      payload[`total_${item.key}`] = totals[item.key] || 0;
      payload[`price_${item.key}`] = _prices[item.key] || 100;
    });

    const btn = document.getElementById("laundry-bill-submit-btn");
    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }

    try {
      const res = await _fetch("/laundry/monthly", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.success) {
        const balText = (res.balance != null) ? _inr(res.balance) : "—";
        const msg = paidAmt > 0
          ? `✓ Payment of ${_inr(paidAmt)} recorded. Balance: ${balText}`
          : `✓ Bill saved. Balance: ${balText}`;
        _notify(msg);
        // Clear the "Paying Now" input so a stray re-submit doesn't double-post.
        const pn = document.getElementById("laundry-paid-amount");
        if (pn) pn.value = "";
        _loadAllBills();
        _loadMonthlyData(month);
      } else {
        _notify(res.message || "Failed to save bill", "error");
      }
    } catch (e) { _notify("Error saving bill", "error"); }
    finally {
      if (btn) { btn.disabled = false; btn.textContent = "Save Bill & Record Expense"; }
    }
  }

  function _setExpType(type) {
    _expenseType = type;
    document.querySelectorAll(".laundry-toggle-btn[data-exptype]").forEach(b => {
      b.classList.toggle("active-exp", b.dataset.exptype === type);
    });
  }
  function _setPayMethod(method) {
    _paymentMethod = method;
    document.querySelectorAll(".laundry-toggle-btn[data-paymethod]").forEach(b => {
      b.classList.toggle("active-pay", b.dataset.paymethod === method);
    });
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  function init() {
    // Quick action button
    document.getElementById("quick-laundry-btn")?.addEventListener("click", () => {
      document.querySelector(".quick-action-menu")?.classList.remove("open");
      openLaundryModal();
    });

    const modal = document.getElementById("laundry-modal");
    if (!modal) return;

    // Close
    modal.querySelector(".close-btn")?.addEventListener("click", closeLaundryModal);
    modal.addEventListener("click", e => { if (e.target === modal) closeLaundryModal(); });

    // Tabs
    modal.querySelectorAll(".laundry-tab-btn").forEach(btn =>
      btn.addEventListener("click", () => _switchTab(btn.dataset.tab))
    );

    // Grid month nav
    document.getElementById("laundry-grid-prev")?.addEventListener("click", () => _shiftMonth(-1));
    document.getElementById("laundry-grid-next")?.addEventListener("click", () => _shiftMonth(1));
    document.getElementById("laundry-grid-month-inp")?.addEventListener("change", e => {
      _gridMonth = e.target.value;
      _loadGrid(_gridMonth);
    });

    // Bill month picker — switching months resets the range to the full month
    document.getElementById("laundry-bill-month")?.addEventListener("change", e => {
      _selectedBillMonth = e.target.value;
      const d = _billRangeDefaults(e.target.value);
      _setBillRangeInputs(d.from, d.to);
      _renderBillHistory();
      _loadMonthlyData(e.target.value);
    });

    // Billing period — single range selector (tap start, tap end)
    document.getElementById("laundry-bill-range-btn")
      ?.addEventListener("click", _openBillRangeCal);

    // Bill amount / old bal / paid — live calc
    ["laundry-bill-amount", "laundry-old-balance", "laundry-paid-amount"].forEach(id =>
      document.getElementById(id)?.addEventListener("input", _updateMonthlyCalc)
    );

    // Use auto amount
    document.getElementById("laundry-use-auto-btn")?.addEventListener("click", () => {
      const auto = _recalcAutoAmount();
      const el = document.getElementById("laundry-bill-amount");
      if (el) { el.value = auto; _updateMonthlyCalc(); }
    });

    // Expense type buttons
    document.querySelectorAll(".laundry-toggle-btn[data-exptype]").forEach(btn =>
      btn.addEventListener("click", () => _setExpType(btn.dataset.exptype))
    );
    // Payment method buttons
    document.querySelectorAll(".laundry-toggle-btn[data-paymethod]").forEach(btn =>
      btn.addEventListener("click", () => _setPayMethod(btn.dataset.paymethod))
    );

    // Price editor — password-gated before opening
    document.getElementById("laundry-prices-toggle")?.addEventListener("click", () => {
      const ed  = document.getElementById("laundry-price-editor");
      if (!ed) return;
      if (ed.classList.contains("open")) {
        // Allow closing without password
        ed.classList.remove("open");
        return;
      }
      // Require password to open
      if (typeof openMgrAccessModal === "function") {
        openMgrAccessModal("Edit Prices", "Enter manager password to edit laundry prices", "fa-tags", () => {
          ed.classList.add("open");
        });
      } else {
        ed.classList.add("open"); // dev fallback
      }
    });
    document.getElementById("laundry-save-prices-btn")?.addEventListener("click", _savePrices);

    // Submit bill
    document.getElementById("laundry-bill-submit-btn")?.addEventListener("click", _submitMonthlyBill);

    // Set defaults
    _setExpType("transaction");
    _setPayMethod("cash");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.openLaundryModal = openLaundryModal;
})();
