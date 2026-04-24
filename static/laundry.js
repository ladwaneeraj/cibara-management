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
      const res = await _fetch(`/laundry/logs?month=${month}`);
      (res.logs || []).forEach(log => { _gridLogs[log.date] = log; });
      _renderGrid(month);
    } catch (e) {
      if (body) body.innerHTML = `<tr><td colspan="12" class="laundry-empty-state">Error loading</td></tr>`;
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
      const editing  = log && _editingIds.has(log.doc_id);

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

      // Item cells
      const itemCells = ITEMS.map(item => {
        if (!hasData || editing) {
          // Editable input
          const val = editing ? (log[item.key] || 0) : 0;
          return `<td><input type="number" class="laundry-cell-input" data-date="${date}" data-key="${item.key}" data-docid="${log?.doc_id || ""}" value="${val}" min="0" /></td>`;
        } else {
          const v = log[item.key] || 0;
          return `<td><span class="laundry-cell-val ${v === 0 ? "zero" : ""}">${v === 0 ? "−" : v}</span></td>`;
        }
      }).join("");

      // Total cell
      let totalCell;
      if (!hasData || editing) {
        totalCell = `<td class="cell-total" id="row-total-${date}">0</td>`;
      } else {
        totalCell = `<td class="cell-total">${log.total || 0}</td>`;
      }

      // Status cell
      let statusCell;
      if (!hasData) {
        statusCell = isFuture
          ? `<td><span class="laundry-status-badge empty">—</span></td>`
          : `<td><span class="laundry-status-badge empty">Not sent</span></td>`;
      } else if (received) {
        statusCell = `<td><span class="laundry-status-badge received">✓ Received</span></td>`;
      } else {
        statusCell = `<td><span class="laundry-status-badge sent">Sent</span></td>`;
      }

      // Action cell
      let actionCell;
      if (!hasData && !isFuture) {
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

    // Wire input listeners for live row-total calc
    body.querySelectorAll(".laundry-cell-input").forEach(inp => {
      inp.addEventListener("input", () => _recalcRowTotal(inp.dataset.date));
    });

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

    wrap.innerHTML = _allBills.map(b => {
      const isSel = b.month === _selectedBillMonth;
      const bal   = b.balance || 0;
      return `<tr class="${isSel ? "selected-hist" : ""}" style="cursor:pointer" onclick="laundrySelectBillMonth('${b.month}')">
        <td class="col-month">${_fmtMonthShort(b.month)}</td>
        <td>${_inr(b.bill_amount)}</td>
        <td>${_inr(b.paid_amount)}</td>
        <td class="col-bal ${bal === 0 ? "zero" : ""}">${_inr(bal)}</td>
        <td style="font-size:0.68rem;color:var(--text-muted)">${b.bill_date || "—"}</td>
      </tr>`;
    }).join("");
  }

  window.laundrySelectBillMonth = function (month) {
    _selectedBillMonth = month;
    const mp = document.getElementById("laundry-bill-month");
    if (mp) mp.value = month;
    _renderBillHistory();
    _loadMonthlyData(month);
  };

  async function _loadMonthlyData(month) {
    try {
      const res = await _fetch(`/laundry/monthly/${month}`);
      _monthlyData = res;
      _renderMonthlySummary(res.totals || {});
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
    if (!bill) {
      // Auto-fill old balance from previous bill
      const prevBal = _getPrevBalance(_selectedBillMonth);
      const obEl = document.getElementById("laundry-old-balance");
      if (obEl) obEl.value = prevBal;
      return;
    }
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set("laundry-bill-amount",  bill.bill_amount  || "");
    set("laundry-bill-date",    bill.bill_date    || "");
    set("laundry-old-balance",  bill.old_balance  || 0);
    set("laundry-paid-amount",  bill.paid_amount  || "");
    // Restore expense/payment toggles
    if (bill.expense_type)   _setExpType(bill.expense_type);
    if (bill.payment_method) _setPayMethod(bill.payment_method);
    _updateMonthlyCalc();
  }

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
    const billAmt  = parseInt(document.getElementById("laundry-bill-amount")?.value  || 0) || 0;
    const oldBal   = parseInt(document.getElementById("laundry-old-balance")?.value  || 0) || 0;
    const paidAmt  = parseInt(document.getElementById("laundry-paid-amount")?.value  || 0) || 0;
    const grand    = billAmt + oldBal;
    const balance  = grand - paidAmt;

    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set("laundry-bill-total-display",  _inr(billAmt));
    set("laundry-old-bal-display",     _inr(oldBal));
    set("laundry-grand-total-display", _inr(grand));
    set("laundry-balance-display",     _inr(Math.abs(balance)) + (balance < 0 ? " (Overpaid)" : ""));

    const balBox = document.getElementById("laundry-balance-box");
    if (balBox) balBox.classList.toggle("zero", balance <= 0);
  }

  async function _submitMonthlyBill() {
    const month   = document.getElementById("laundry-bill-month")?.value;
    const billAmt = parseInt(document.getElementById("laundry-bill-amount")?.value || 0) || 0;
    const oldBal  = parseInt(document.getElementById("laundry-old-balance")?.value || 0) || 0;
    const paidAmt = parseInt(document.getElementById("laundry-paid-amount")?.value || 0) || 0;

    if (!month)     { _notify("Select a month", "error");        return; }
    if (billAmt <= 0) { _notify("Enter bill amount", "error"); return; }

    const totals  = _monthlyData?.totals || {};
    const payload = {
      month,
      bill_date:      document.getElementById("laundry-bill-date")?.value || "",
      bill_amount:    billAmt,
      old_balance:    oldBal,
      paid_amount:    paidAmt,
      payment_method: _paymentMethod,
      expense_type:   _expenseType,
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
        _notify(`✓ Bill saved. Balance: ${_inr(res.balance ?? (billAmt + oldBal - paidAmt))}`);
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

    // Bill month picker
    document.getElementById("laundry-bill-month")?.addEventListener("change", e => {
      _selectedBillMonth = e.target.value;
      _renderBillHistory();
      _loadMonthlyData(e.target.value);
    });

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
