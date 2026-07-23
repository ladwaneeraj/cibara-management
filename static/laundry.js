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
  // Billing tab — vendor account ledger (see TAB 2 section)
  let _ledger         = null;           // /laundry/ledger response
  let _billPanelData  = null;           // /laundry/monthly/<m> response
  let _billPanelMonth = _todayMonth();
  let _expenseType    = "transaction";
  let _paymentMethod  = "cash";
  let _adjustMode     = "add";          // "add" | "reduce" | "opening"

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
  function _num(n) { return Number(n || 0).toLocaleString("en-IN"); }

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
      _billPanelMonth = _todayMonth();
      const mp = document.getElementById("lgr-bill-month");
      if (mp) mp.value = _billPanelMonth;
      const d = _billRangeDefaults(_billPanelMonth);
      _setBillRangeInputs(d.from, d.to);
      _showPanel(null);
      _loadLedger();
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

  // Single Lock / Unlock control next to the grid's month label (admin only).
  // Opens the calendar picker, where the admin locks/unlocks individual dates
  // OR the whole month — a single entry point that replaces the former two
  // separate "Lock Month" and "Lock Dates" buttons.
  function _ensureMonthLockBtn() {
    const nav = document.querySelector(".laundry-grid-nav");
    if (!nav) return;
    // Drop legacy buttons from earlier builds so only the single control shows.
    ["laundry-month-lock-btn", "laundry-date-lock-btn"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });

    let btn = document.getElementById("laundry-lock-btn");
    if (!_canManageLaundryLocks()) { if (btn) btn.remove(); return; }
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "laundry-lock-btn";
      btn.className = "laundry-tbl-btn laundry-grid-lock-btn";
      btn.style.cssText = "padding:0.25rem 0.7rem;";
      // Right side of the toolbar, clear of the month arrows.
      nav.insertAdjacentElement("afterend", btn);
    }
    btn.textContent = "🔒 Locks";
    btn.title = "Lock or unlock dates — or the whole month — against edits";
    btn.onclick = _openLockCalendar;
  }

  // ── Calendar lock picker (admin) ──────────────────────────────────────────
  // Range selector: tap a start date, tap an end date (or act on a single day
  // with just the start). Then Lock / Unlock selected. Dark = already locked.
  let _lockStart = null;
  let _lockEnd   = null;

  function _ensureLockCalDom() {
    if (document.getElementById("llk-overlay")) return;
    const style = document.createElement("style");
    style.id = "llk-styles";
    style.textContent = `
      #llk-overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);display:none;align-items:center;justify-content:center;z-index:10070;}
      #llk-overlay.show{display:flex;}
      .llk-box{background:#fff;border-radius:12px;max-width:380px;width:94%;padding:1rem 1.1rem;box-shadow:0 10px 40px rgba(0,0,0,.25);}
      .llk-head{display:flex;align-items:flex-start;justify-content:space-between;gap:.5rem;margin-bottom:.3rem;}
      .llk-title{font-weight:700;font-size:1rem;color:#0f172a;}
      .llk-x{background:none;border:0;font-size:1.35rem;line-height:1;color:#94a3b8;cursor:pointer;padding:0 .15rem;}
      .llk-x:hover{color:#475569;}
      .llk-sub{font-size:.76rem;color:#64748b;margin-bottom:.65rem;line-height:1.35;}
      .llk-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;}
      .llk-dow{font-size:.68rem;color:#64748b;text-align:center;font-weight:700;padding:2px 0;}
      .llk-day{border:1px solid #e2e8f0;border-radius:8px;padding:.5rem 0;text-align:center;font-size:.85rem;cursor:pointer;user-select:none;background:#fff;color:#0f172a;}
      .llk-day.disabled{opacity:.35;cursor:not-allowed;}
      .llk-day.locked{background:#475569;color:#fff;border-color:#475569;}
      .llk-day.range{background:#dbeafe;border-color:#bfdbfe;color:#0f172a;}
      .llk-day.endpoint{background:#1d4ed8;color:#fff;border-color:#1d4ed8;font-weight:700;}
      .llk-hint{font-size:.76rem;color:#1d4ed8;background:#eff6ff;border-radius:6px;padding:.35rem .55rem;margin-bottom:.55rem;font-weight:600;}
      .llk-legend{display:flex;gap:.8rem;font-size:.7rem;color:#64748b;margin-top:.55rem;align-items:center;flex-wrap:wrap;}
      .llk-chip{display:inline-block;width:12px;height:12px;border-radius:4px;vertical-align:-2px;margin-right:4px;}
      .llk-monthbtn{width:100%;border:1px solid #cbd5e1;border-radius:8px;padding:.55rem;font-weight:600;font-size:.82rem;cursor:pointer;background:#f8fafc;color:#0f172a;margin-bottom:.7rem;display:flex;align-items:center;justify-content:center;gap:.4rem;}
      .llk-monthbtn:hover{background:#eef2f7;}
      .llk-note{font-size:.74rem;color:#b45309;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:.45rem .6rem;margin-bottom:.6rem;display:none;}
      .llk-note.show{display:block;}
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
      <div class="llk-head">
        <div class="llk-title" id="llk-title">Lock dates</div>
        <button class="llk-x" id="llk-close-btn" aria-label="Close">&times;</button>
      </div>
      <div class="llk-sub">Lock the whole month with the button below, or tap
        individual dates and lock/unlock just those. Locked data can't be
        edited by anyone until an admin unlocks it.</div>
      <button class="llk-monthbtn" id="llk-month-btn">🔒 Lock whole month</button>
      <div class="llk-note" id="llk-note"></div>
      <div class="llk-hint" id="llk-hint"></div>
      <div class="llk-grid" id="llk-grid"></div>
      <div class="llk-legend">
        <span><span class="llk-chip" style="background:#475569;"></span>Locked</span>
        <span><span class="llk-chip" style="background:#fff;border:2px solid #0ea5e9;"></span>Selected</span>
        <span><span class="llk-chip" style="background:#e2e8f0;"></span>Future (n/a)</span>
      </div>
      <div class="llk-foot" id="llk-foot">
        <button class="llk-btn llk-lockb"   id="llk-lock-btn">🔒 Lock selected</button>
        <button class="llk-btn llk-unlockb" id="llk-unlock-btn">🔓 Unlock selected</button>
      </div></div>`;
    document.body.appendChild(ov);

    ov.addEventListener("click", (e) => {
      if (e.target === ov) ov.classList.remove("show");
    });
    document.getElementById("llk-close-btn").onclick =
      () => ov.classList.remove("show");
    document.getElementById("llk-lock-btn").onclick   = () => _applyCalLock(true);
    document.getElementById("llk-unlock-btn").onclick = () => _applyCalLock(false);
    // Whole-month lock/unlock (folds in the former standalone Lock Month
    // button). Close the picker first; _setLaundryLock reloads the grid.
    document.getElementById("llk-month-btn").onclick = () => {
      const ov = document.getElementById("llk-overlay");
      if (ov) ov.classList.remove("show");
      _setLaundryLock(_gridLocks.monthLocked ? "unlock_month" : "lock_month", null);
    };
  }

  function _openLockCalendar() {
    if (!_canManageLaundryLocks()) return;
    _ensureLockCalDom();
    _lockStart = null;
    _lockEnd   = null;

    const monthLocked = !!_gridLocks.monthLocked;

    const title = document.getElementById("llk-title");
    if (title) title.textContent = `Locks — ${_monthLabel(_gridMonth)}`;

    // Whole-month toggle (replaces the former standalone Lock Month button).
    const mbtn = document.getElementById("llk-month-btn");
    if (mbtn) mbtn.textContent = monthLocked
      ? "🔓 Unlock whole month"
      : "🔒 Lock whole month";

    // While the whole month is locked, single dates can't be managed (the
    // server rejects it). Show a note and hide the per-date action buttons.
    const note         = document.getElementById("llk-note");
    const lockSelBtn   = document.getElementById("llk-lock-btn");
    const unlockSelBtn = document.getElementById("llk-unlock-btn");
    const foot         = document.getElementById("llk-foot");
    if (note) {
      note.textContent = monthLocked
        ? "The whole month is locked. Unlock it above to manage single dates."
        : "";
      note.classList.toggle("show", monthLocked);
    }
    if (lockSelBtn)   lockSelBtn.style.display   = monthLocked ? "none" : "";
    if (unlockSelBtn) unlockSelBtn.style.display = monthLocked ? "none" : "";
    if (foot)         foot.style.display         = monthLocked ? "none" : "";

    _renderLockCal();
    document.getElementById("llk-overlay").classList.add("show");
  }

  // Renders the lock calendar for the current _lockStart/_lockEnd range.
  // Re-called on every tap so the range highlight updates live.
  function _renderLockCal() {
    const monthLocked = !!_gridLocks.monthLocked;

    const hint = document.getElementById("llk-hint");
    if (hint) {
      if (monthLocked) {
        hint.style.display = "none";
      } else {
        hint.style.display = "";
        hint.textContent = !_lockStart
          ? "Tap a date. Tap a second date for a range."
          : (!_lockEnd
              ? `${_fmtDate(_lockStart)} selected — tap another for a range, or Lock / Unlock below.`
              : `Range: ${_fmtDate(_lockStart)} → ${_fmtDate(_lockEnd)}`);
      }
    }

    const grid = document.getElementById("llk-grid");
    if (!grid) return;
    const today = _todayDate();
    const dows  = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
    let html = dows.map(d => `<div class="llk-dow">${d}</div>`).join("");

    // Leading blanks so day 1 lands on its weekday column.
    const [y, m] = _gridMonth.split("-").map(Number);
    const firstDow = new Date(y, m - 1, 1).getDay();
    for (let i = 0; i < firstDow; i++) html += `<div></div>`;

    // Normalised range for highlighting the in-between days.
    let rs = _lockStart, re = _lockEnd;
    if (rs && re && re < rs) { const t = rs; rs = re; re = t; }

    _daysInMonth(_gridMonth).forEach(date => {
      const dayNum     = parseInt(date.slice(8), 10);
      const isFuture   = date > today;
      const locked     = monthLocked || _gridLocks.dates.has(date);
      // Selection is disabled for future dates and while the month is locked.
      const disabled   = isFuture || monthLocked;
      const isEndpoint = date === _lockStart || date === _lockEnd;
      const inRange    = rs && re && date > rs && date < re;
      const cls = ["llk-day",
                   disabled ? "disabled" : "",
                   locked ? "locked" : "",
                   inRange ? "range" : "",
                   isEndpoint ? "endpoint" : ""].filter(Boolean).join(" ");
      html += `<div class="${cls}" data-date="${date}">${dayNum}</div>`;
    });
    grid.innerHTML = html;

    grid.querySelectorAll(".llk-day:not(.disabled)").forEach(cell => {
      cell.onclick = function () {
        const d = cell.dataset.date;
        if (!_lockStart || (_lockStart && _lockEnd)) {
          // Fresh start (or restart after a completed range).
          _lockStart = d;
          _lockEnd   = null;
        } else {
          // Second tap = end date (swap if before the start).
          _lockEnd = d;
          if (_lockEnd < _lockStart) {
            const t = _lockStart; _lockStart = _lockEnd; _lockEnd = t;
          }
        }
        _renderLockCal();
      };
    });
  }

  async function _applyCalLock(lock) {
    if (!_lockStart) {
      _notify("Tap a date first", "error");
      return;
    }
    let s = _lockStart, e = _lockEnd || _lockStart;
    if (e < s) { const t = s; s = e; e = t; }
    // Expand the (single-month) range to the inclusive list of dates.
    const dates = _daysInMonth(_gridMonth).filter(d => d >= s && d <= e);
    if (!dates.length) {
      _notify("No dates selected", "error");
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
    } catch (e2) {
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
  // TAB 2 — BILLING (vendor account ledger)
  // ══════════════════════════════════════════════════════════════════════════
  //
  // One running account, like a bank passbook / hotel folio:
  //     balance = opening + bills + adjustments − payments
  // Bills ADD to the balance, payments SUBTRACT — partial or full makes
  // no difference, the remainder carries forward automatically. There is
  // no "Old Balance" field anywhere: that field was what caused the old
  // double-counting confusion.

  async function _loadLedger() {
    const tbody = document.getElementById("lgr-statement-body");
    if (tbody && !_ledger) {
      tbody.innerHTML = `<tr><td colspan="6" class="lgr-empty">Loading…</td></tr>`;
    }
    try {
      const res = await _fetch("/laundry/ledger");
      if (res.success === false) {
        _notify(res.message || "Failed to load ledger", "error");
        return;
      }
      _ledger = res;
      _renderLedger();
    } catch (e) {
      console.error("loadLedger", e);
      if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="lgr-empty">Error loading — try again</td></tr>`;
    }
  }

  function _renderLedger() {
    const s = (_ledger && _ledger.summary) || {};
    const bal = s.balance || 0;

    // ── Summary strip ──
    const balEl = document.getElementById("lgr-balance");
    if (balEl) {
      balEl.textContent = _inr(Math.abs(bal));
      balEl.classList.toggle("settled", bal <= 0);
    }
    const lblEl = document.getElementById("lgr-balance-lbl");
    if (lblEl) {
      lblEl.textContent = bal < 0 ? "Advance with laundry"
        : (bal === 0 ? "All settled" : "Balance due now");
    }
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set("lgr-total-billed", _inr((s.opening || 0) + (s.total_billed || 0) +
      Math.max(0, s.total_adjustments || 0)));
    set("lgr-total-paid",   _inr((s.total_paid || 0) +
      Math.max(0, -(s.total_adjustments || 0))));

    // ── Overlap warning (almost always a double-entered bill) ──
    const warn = document.getElementById("lgr-overlap-warn");
    if (warn) {
      const ov = (_ledger && _ledger.overlaps) || [];
      warn.hidden = !ov.length;
      if (ov.length) {
        const name = (id) => {
          const b = ((_ledger && _ledger.bills) || []).find(x => x.id === id);
          return b ? `“${_billPeriodName(b)}”` : "a bill";
        };
        const more = ov.length > 1 ? ` (+${ov.length - 1} more)` : "";
        warn.innerHTML = `<b>Possible double billing:</b>
          the bills ${name(ov[0].a)} and ${name(ov[0].b)} cover the same
          dates${more}. If one is a mistake, delete it with the × on its row.`;
      }
    }

    // ── Statement — classic ledger table (Date | Particulars | Bill | Paid | Balance)
    const tbody = document.getElementById("lgr-statement-body");
    if (!tbody) return;
    const entries = (_ledger && _ledger.entries) || [];
    const foot = document.getElementById("lgr-statement-foot");
    if (!entries.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="lgr-empty">
        Nothing here yet.<br>
        <span>Use <b>Add Bill</b> when the laundry bills you, and
        <b>Record Payment</b> when you pay.</span></td></tr>`;
      if (foot) foot.innerHTML = "";
      return;
    }
    tbody.innerHTML = entries.map(_ledgerRowHtml).join("");
    if (foot) {
      const billedTotal = (s.opening || 0) + (s.total_billed || 0) +
        Math.max(0, s.total_adjustments || 0);
      const paidTotal = (s.total_paid || 0) + Math.max(0, -(s.total_adjustments || 0));
      foot.innerHTML = `<tr>
        <td colspan="2">Total</td>
        <td class="lgr-num">${_num(billedTotal)}</td>
        <td class="lgr-num cr">${_num(paidTotal)}</td>
        <td class="lgr-num ${bal <= 0 ? "ok" : "due"}">${bal < 0 ? "adv " : ""}${_num(Math.abs(bal))}</td>
        <td></td>
      </tr>`;
    }
    // Latest entries sit at the bottom — bring them into view.
    const scroller = document.getElementById("lgr-statement-scroll");
    if (scroller) setTimeout(() => { scroller.scrollTop = scroller.scrollHeight; }, 60);

    _updatePayPreview();
  }

  // "July" for a full-month bill, "12 Jul – 21 Jul" for a part period.
  function _billPeriodName(b) {
    if (!b.period_start || !b.period_end) return b.month || "";
    const d = b.month ? _billRangeDefaults(b.month) : null;
    if (d && b.period_start === d.from && b.period_end === d.to) {
      return _monthLabelOf(b.period_start).replace(/ \d+$/, "");
    }
    if (b.period_start.slice(0, 7) === b.period_end.slice(0, 7)) {
      return `${parseInt(b.period_start.slice(8), 10)}–${_fmtDate(b.period_end)}`;
    }
    return `${_fmtDate(b.period_start)} – ${_fmtDate(b.period_end)}`;
  }

  function _monthLabelOf(dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    if (isNaN(d)) return "Earlier";
    return d.toLocaleString("en-IN", { month: "long", year: "numeric" });
  }

  function _esc(t) {
    return String(t == null ? "" : t)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function _ledgerRowHtml(e) {
    const when = e.date
      ? `<span title="${e.date}">${_fmtDate(e.date)}</span>` : "—";
    const rb = e.running_balance || 0;
    const balCell = `<td class="lgr-num lgr-bal ${rb <= 0 ? "ok" : "due"}">${rb < 0 ? "adv " : ""}${_num(Math.abs(rb))}</td>`;
    const dash = `<td class="lgr-num muted">—</td>`;

    if (e.type === "bill") {
      const period = _billPeriodName(e);
      let chip;
      if (e.status === "paid")         chip = `<span class="lgr-chip paid">Paid</span>`;
      else if (e.status === "partial") chip = `<span class="lgr-chip partial">${_inr(e.due || 0)} left</span>`;
      else                             chip = `<span class="lgr-chip due">Due</span>`;
      return `<tr class="lgr-r bill">
        <td class="lgr-when">${when}</td>
        <td class="lgr-part">
          <span class="lgr-part-main">Bill${period ? ` — ${period}` : ""}</span> ${chip}
          ${e.pieces ? `<span class="lgr-part-sub">${e.pieces} pcs</span>` : ""}
        </td>
        <td class="lgr-num dr">${_num(e.effect)}</td>
        ${dash}
        ${balCell}
        <td class="lgr-act">
          <button class="lgr-icon-btn" title="Edit this bill"
            onclick="laundryEditBill('${e.month}','${e.period_start}','${e.period_end}')"><i class="fas fa-pen"></i></button>
          <button class="lgr-icon-btn danger" title="Delete this bill (payments are kept)"
            onclick="laundryDeleteBill('${e.id}','${_esc(period)}')"><i class="fas fa-times"></i></button>
        </td>
      </tr>`;
    }

    if (e.type === "payment") {
      const m = (e.method || "cash").toLowerCase();
      const label = String(e.label || "");
      const note = label.includes(" — ") ? label.split(" — ").slice(1).join(" — ") : "";
      return `<tr class="lgr-r payment">
        <td class="lgr-when">${when}</td>
        <td class="lgr-part">
          <span class="lgr-part-main">Payment</span>
          <span class="lgr-part-sub">${_esc([m, note].filter(Boolean).join(" · "))}</span>
        </td>
        ${dash}
        <td class="lgr-num cr">${_num(-e.effect)}</td>
        ${balCell}
        <td class="lgr-act">
          <button class="lgr-icon-btn danger" title="Remove this payment"
            onclick="laundryDeletePayment('${e.id}')"><i class="fas fa-times"></i></button>
        </td>
      </tr>`;
    }

    if (e.type === "adjustment") {
      const drCell = e.effect > 0
        ? `<td class="lgr-num dr">${_num(e.effect)}</td>` : dash;
      const crCell = e.effect < 0
        ? `<td class="lgr-num cr">${_num(-e.effect)}</td>` : dash;
      return `<tr class="lgr-r adjustment">
        <td class="lgr-when">${when}</td>
        <td class="lgr-part">
          <span class="lgr-part-main">Adjustment</span>
          <span class="lgr-part-sub">${_esc(e.label || "")}</span>
        </td>
        ${drCell}
        ${crCell}
        ${balCell}
        <td class="lgr-act">
          <button class="lgr-icon-btn danger" title="Remove this adjustment"
            onclick="laundryDeleteAdjustment('${e.id}')"><i class="fas fa-times"></i></button>
        </td>
      </tr>`;
    }

    // opening
    return `<tr class="lgr-r opening">
      <td class="lgr-when">${when}</td>
      <td class="lgr-part">
        <span class="lgr-part-main">Opening balance</span>
      </td>
      <td class="lgr-num dr">${_num(e.effect)}</td>
      ${dash}
      ${balCell}
      <td class="lgr-act">
        <button class="lgr-icon-btn" title="Change the opening balance"
          onclick="laundryOpenCorrections('opening')"><i class="fas fa-pen"></i></button>
      </td>
    </tr>`;
  }

  // ── Panels (Add Bill / Record Payment / Corrections) ─────────────────────
  function _showPanel(which) {
    ["bill", "pay", "adjust"].forEach(k => {
      const el = document.getElementById(`lgr-${k}-panel`);
      if (el) el.hidden = (k !== which);
    });
    ["lgr-add-bill-btn", "lgr-add-pay-btn"].forEach(id => {
      const b = document.getElementById(id);
      if (b) b.classList.toggle("active",
        (id === "lgr-add-bill-btn" && which === "bill") ||
        (id === "lgr-add-pay-btn" && which === "pay"));
    });
    if (which) {
      const el = document.getElementById(`lgr-${which}-panel`);
      if (el) setTimeout(() => el.scrollIntoView({ block: "nearest", behavior: "smooth" }), 60);
    }
  }

  // ── Row actions ───────────────────────────────────────────────────────────
  window.laundryEditBill = function (month, from, to) {
    if (month) {
      _billPanelMonth = month;
      const mp = document.getElementById("lgr-bill-month");
      if (mp) mp.value = month;
    }
    if (from && to) _setBillRangeInputs(from, to);
    _showPanel("bill");
    _loadBillPanelData(true);
  };

  window.laundryDeleteBill = async function (billId, label) {
    if (!billId) return;
    if (!confirm(`Delete the bill for ${label}?\n\nPayments are NOT touched — the balance simply recalculates.`)) return;
    try {
      const res = await _fetch("/laundry/bill/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bill_id: billId }),
      });
      if (res.success) { _notify(res.message || "Bill deleted"); _loadLedger(); }
      else _notify(res.message || "Failed to delete bill", "error");
    } catch (e) { _notify("Network error deleting bill", "error"); }
  };

  window.laundryDeletePayment = async function (paymentId) {
    if (!paymentId) return;
    if (!confirm("Remove this payment from the books?\n\nThe expense entry is deleted and the balance recalculates.")) return;
    try {
      const res = await _fetch("/laundry/payment/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payment_id: paymentId }),
      });
      if (res.success) { _notify(res.message || "Payment removed"); _loadLedger(); }
      else _notify(res.message || "Failed to remove payment", "error");
    } catch (e) { _notify("Network error removing payment", "error"); }
  };

  window.laundryDeleteAdjustment = async function (adjId) {
    if (!adjId) return;
    if (!confirm("Remove this adjustment?")) return;
    try {
      const res = await _fetch("/laundry/adjust/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adjustment_id: adjId }),
      });
      if (res.success) { _notify(res.message || "Adjustment removed"); _loadLedger(); }
      else _notify(res.message || "Failed", "error");
    } catch (e) { _notify("Network error", "error"); }
  };

  window.laundryOpenCorrections = function (mode) {
    _showPanel("adjust");
    _setAdjustMode(mode || "add");
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
    const d = _billRangeDefaults(_billPanelMonth);
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
      const d = _billRangeDefaults(_billPanelMonth);
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
      const d = _billRangeDefaults(_billPanelMonth);
      _applyBillRange(d.from, d.to);
    };
  }

  // Payment status of the bill covering a date: "paid" (FIFO-settled),
  // "due" (billed, still owed), or null (no bill covers the day).
  // Statuses come straight from the ledger — no local math.
  function _dayBillStatus(date) {
    for (const b of ((_ledger && _ledger.bills) || [])) {
      const s = b.period_start, e = b.period_end;
      if (!s || !e) continue;
      if (date >= s && date <= e) return b.status === "paid" ? "paid" : "due";
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
    _loadBillPanelData(true);
  }

  function _openBillRangeCal() {
    _ensureBillRangeCalDom();
    // Open with NOTHING pre-selected — the user taps a fresh start, then end.
    // The current range still drives the bill until a new one is applied (or
    // "Full month" is tapped). Show the month currently selected for billing.
    _lbrStart = null;
    _lbrEnd   = null;
    _lbrView  = (_billPanelMonth || _todayMonth());
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

  async function _loadBillPanelData(skipRestore) {
    try {
      const month = _billPanelMonth;
      const { from, to } = _getBillRange();
      const res = await _fetch(
        `/laundry/monthly/${month}?start=${from}&end=${to}`);
      if (res.success === false) {
        _notify(res.message || "Failed to load month", "error");
        return;
      }
      _billPanelData = res;

      // Reopening a saved bill: if it carries its own billing period and the
      // user hasn't picked one (inputs still at the full-month default),
      // restore the saved range once so the panel shows what was billed.
      const d = _billRangeDefaults(month);
      if (!skipRestore && res.bill &&
          res.bill.period_start && res.bill.period_end &&
          from === d.from && to === d.to &&
          (res.bill.period_start !== from || res.bill.period_end !== to)) {
        _setBillRangeInputs(res.bill.period_start, res.bill.period_end);
        return _loadBillPanelData(true);
      }

      _renderBillPanelSummary(res.totals || {});
      _updateBillPeriodLabel(res);
      const auto = _recalcAutoAmount();

      // Prefill: an existing bill for this exact period is being EDITED;
      // otherwise it's a new bill, prefilled with the auto amount.
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
      const note = document.getElementById("lgr-bill-editing-note");
      if (res.bill) {
        set("laundry-bill-amount", res.bill.bill_amount || "");
        set("laundry-bill-date",   res.bill.bill_date || "");
        if (note) {
          note.hidden = false;
          note.textContent = "A bill for this period is already saved — saving will update it.";
        }
      } else {
        set("laundry-bill-amount", auto > 0 ? auto : "");
        set("laundry-bill-date",   _todayDate());
        if (note) note.hidden = true;
      }
    } catch (e) { console.error("loadBillPanelData", e); }
  }

  function _renderBillPanelSummary(totals) {
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

  async function _submitBill() {
    const month   = _billPanelMonth;
    const billAmt = parseInt(document.getElementById("laundry-bill-amount")?.value || 0) || 0;
    if (!month)       { _notify("Select a month", "error"); return; }
    if (billAmt <= 0) { _notify("Enter the bill amount", "error"); return; }

    const totals = _billPanelData?.totals || {};
    const range  = _getBillRange();
    const payload = {
      month,
      bill_date:    document.getElementById("laundry-bill-date")?.value || "",
      bill_amount:  billAmt,
      period_start: range.from,
      period_end:   range.to,
    };
    ITEMS.forEach(item => {
      payload[`total_${item.key}`] = totals[item.key] || 0;
      payload[`price_${item.key}`] = _prices[item.key] || 100;
    });

    const btn = document.getElementById("lgr-bill-save-btn");
    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
    try {
      const res = await _fetch("/laundry/bill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.success) {
        const bal = res.summary ? res.summary.balance : null;
        _notify(`✓ Bill saved${bal != null ? ` — balance now ${_inr(bal)}` : ""}`);
        _showPanel(null);
        _loadLedger();
      } else {
        _notify(res.message || "Failed to save bill", "error");
      }
    } catch (e) { _notify("Error saving bill", "error"); }
    finally {
      if (btn) { btn.disabled = false; btn.textContent = "Save Bill"; }
    }
  }

  // ── Record Payment panel ──────────────────────────────────────────────────
  function _openPayPanel() {
    _showPanel("pay");
    const amt = document.getElementById("lgr-pay-amount");
    if (amt) { amt.value = ""; setTimeout(() => amt.focus(), 80); }
    const dt = document.getElementById("lgr-pay-date");
    if (dt) dt.value = _todayDate();
    const note = document.getElementById("lgr-pay-note");
    if (note) note.value = "";
    const s = (_ledger && _ledger.summary) || {};
    const fullBtn = document.getElementById("lgr-pay-full-btn");
    if (fullBtn) {
      const due = Math.max(0, s.balance || 0);
      fullBtn.hidden = due <= 0;
      fullBtn.textContent = `Full balance · ${_inr(due)}`;
      fullBtn.dataset.amount = due;
    }
    _updatePayPreview();
  }

  // Live line under the amount: what the balance becomes after this payment.
  function _updatePayPreview() {
    const el = document.getElementById("lgr-pay-preview");
    if (!el) return;
    const s = (_ledger && _ledger.summary) || {};
    const bal = s.balance || 0;
    const amt = parseInt(document.getElementById("lgr-pay-amount")?.value || 0) || 0;
    if (amt <= 0) {
      el.textContent = bal > 0
        ? `Balance due: ${_inr(bal)}`
        : (bal < 0 ? `Advance with laundry: ${_inr(-bal)}` : "All settled ✓");
      el.className = "lgr-pay-preview";
      return;
    }
    const after = bal - amt;
    if (after > 0) {
      el.textContent = `After this payment, ${_inr(after)} stays as balance (carries forward automatically).`;
      el.className = "lgr-pay-preview due";
    } else if (after === 0) {
      el.textContent = "This settles the account fully. ✓";
      el.className = "lgr-pay-preview ok";
    } else {
      el.textContent = `This overpays by ${_inr(-after)} — it will show as an advance.`;
      el.className = "lgr-pay-preview adv";
    }
  }

  async function _submitPayment() {
    const amt = parseInt(document.getElementById("lgr-pay-amount")?.value || 0) || 0;
    if (amt <= 0) { _notify("Enter the amount you're paying", "error"); return; }
    const payload = {
      amount:         amt,
      payment_method: _paymentMethod,
      expense_type:   _expenseType,
      date:           document.getElementById("lgr-pay-date")?.value || "",
      note:           (document.getElementById("lgr-pay-note")?.value || "").trim(),
    };
    const btn = document.getElementById("lgr-pay-save-btn");
    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
    try {
      const res = await _fetch("/laundry/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.success) {
        const bal = res.summary ? res.summary.balance : null;
        _notify(`✓ Payment of ${_inr(amt)} recorded` +
          (bal != null
            ? (bal > 0 ? ` — ${_inr(bal)} balance remains`
               : (bal < 0 ? ` — ${_inr(-bal)} advance` : " — fully settled"))
            : ""));
        _showPanel(null);
        _loadLedger();
      } else {
        _notify(res.message || "Failed to record payment", "error");
      }
    } catch (e) { _notify("Error recording payment", "error"); }
    finally {
      if (btn) { btn.disabled = false; btn.textContent = "Record Payment"; }
    }
  }

  // ── Corrections panel (adjustments + opening balance) ────────────────────
  function _setAdjustMode(mode) {
    _adjustMode = mode;
    document.querySelectorAll(".lgr-adjust-mode-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.adjmode === mode);
    });
    const hint = document.getElementById("lgr-adjust-hint");
    if (hint) {
      hint.textContent =
        mode === "add"     ? "Adds to what you owe (e.g. a missed charge)." :
        mode === "reduce"  ? "Reduces what you owe (e.g. a discount or counting mistake)." :
        "The amount owed from before this ledger started. Set once; edit only to correct it.";
    }
    const amtEl = document.getElementById("lgr-adjust-amount");
    if (amtEl && mode === "opening") {
      const s = (_ledger && _ledger.summary) || {};
      amtEl.value = s.opening || 0;
    }
  }

  async function _submitAdjustment() {
    const amt  = parseInt(document.getElementById("lgr-adjust-amount")?.value || 0) || 0;
    const note = (document.getElementById("lgr-adjust-note")?.value || "").trim();
    const date = document.getElementById("lgr-adjust-date")?.value || "";

    const btn = document.getElementById("lgr-adjust-save-btn");
    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
    try {
      let res;
      if (_adjustMode === "opening") {
        if (amt < 0) { _notify("Opening balance can't be negative", "error"); return; }
        res = await _fetch("/laundry/opening", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ opening_balance: amt, opening_date: date, note }),
        });
      } else {
        if (amt <= 0) { _notify("Enter an amount above zero", "error"); return; }
        if (!note)    { _notify("A short note is required — say why", "error"); return; }
        res = await _fetch("/laundry/adjust", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            amount: _adjustMode === "reduce" ? -amt : amt,
            note, date,
          }),
        });
      }
      if (res.success) {
        _notify(res.message || "Saved");
        _showPanel(null);
        _loadLedger();
      } else {
        _notify(res.message || "Failed", "error");
      }
    } catch (e) { _notify("Error saving", "error"); }
    finally {
      if (btn) { btn.disabled = false; btn.textContent = "Save"; }
    }
  }

  function _recalcAutoAmount() {
    const totals = _billPanelData?.totals || {};
    let auto = 0;
    ITEMS.forEach(item => { auto += (totals[item.key] || 0) * (_prices[item.key] || 100); });
    const hintEl = document.getElementById("laundry-auto-amount");
    if (hintEl) hintEl.textContent = auto > 0 ? `Auto: ${_inr(auto)}` : "";
    return auto;
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

    // ── Billing tab (ledger) wiring ─────────────────────────────────────────
    // Panel open/close buttons
    document.getElementById("lgr-add-bill-btn")?.addEventListener("click", () => {
      const panel = document.getElementById("lgr-bill-panel");
      if (panel && !panel.hidden) { _showPanel(null); return; }
      _showPanel("bill");
      _loadBillPanelData();
    });
    document.getElementById("lgr-add-pay-btn")?.addEventListener("click", () => {
      const panel = document.getElementById("lgr-pay-panel");
      if (panel && !panel.hidden) { _showPanel(null); return; }
      _openPayPanel();
    });
    // "⋯" menu (Corrections / Edit Prices)
    const moreBtn = document.getElementById("lgr-more-btn");
    const moreMenu = document.getElementById("lgr-more-menu");
    if (moreBtn && moreMenu) {
      moreBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        moreMenu.hidden = !moreMenu.hidden;
      });
      moreMenu.addEventListener("click", () => { moreMenu.hidden = true; });
      document.addEventListener("click", (e) => {
        if (!moreMenu.hidden && !moreMenu.contains(e.target) && e.target !== moreBtn) {
          moreMenu.hidden = true;
        }
      });
    }
    document.getElementById("lgr-corrections-btn")?.addEventListener("click", () => {
      const panel = document.getElementById("lgr-adjust-panel");
      if (panel && !panel.hidden) { _showPanel(null); return; }
      window.laundryOpenCorrections("add");
    });
    document.querySelectorAll(".lgr-panel-close").forEach(btn =>
      btn.addEventListener("click", () => _showPanel(null))
    );

    // Add Bill panel — month picker resets the range to the full month
    document.getElementById("lgr-bill-month")?.addEventListener("change", e => {
      _billPanelMonth = e.target.value;
      const d = _billRangeDefaults(e.target.value);
      _setBillRangeInputs(d.from, d.to);
      _loadBillPanelData();
    });
    document.getElementById("laundry-bill-range-btn")
      ?.addEventListener("click", _openBillRangeCal);
    document.getElementById("laundry-use-auto-btn")?.addEventListener("click", () => {
      const auto = _recalcAutoAmount();
      const el = document.getElementById("laundry-bill-amount");
      if (el) el.value = auto;
    });
    document.getElementById("lgr-bill-save-btn")?.addEventListener("click", _submitBill);

    // Record Payment panel
    document.getElementById("lgr-pay-amount")?.addEventListener("input", _updatePayPreview);
    document.getElementById("lgr-pay-full-btn")?.addEventListener("click", function () {
      const el = document.getElementById("lgr-pay-amount");
      if (el) { el.value = this.dataset.amount || ""; _updatePayPreview(); }
    });
    document.getElementById("lgr-pay-save-btn")?.addEventListener("click", _submitPayment);

    // Corrections panel
    document.querySelectorAll(".lgr-adjust-mode-btn").forEach(btn =>
      btn.addEventListener("click", () => _setAdjustMode(btn.dataset.adjmode))
    );
    document.getElementById("lgr-adjust-save-btn")?.addEventListener("click", _submitAdjustment);

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

    // Set defaults
    _setExpType("transaction");
    _setPayMethod("cash");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.openLaundryModal = openLaundryModal;
})();
