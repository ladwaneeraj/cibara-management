// ==========================================
// REGISTER MODULE — Single File (JS + CSS)
// v2 — fixes: date filter reload, print 1 page,
//      excel GST columns, serial dedup, missing bills
// ==========================================

(function () {
  // ── CSS ─────────────────────────────────────────────────────────────────────
  const REGISTER_CSS = `
.register-container { padding: 1rem; max-width: 100%; }

.register-header {
  display: flex; justify-content: space-between;
  align-items: center; margin-bottom: 0.6rem;
}
.register-header h1 {
  font-size: 1.05rem; font-weight: 700;
  color: var(--primary); display: flex;
  align-items: center; gap: 0.4rem; margin: 0;
}
.register-toolbar { display: flex; align-items: center; gap: 0.4rem; }

.reg-icon-btn {
  width: 32px; height: 32px; border: none;
  border-radius: 6px; cursor: pointer;
  display: flex; align-items: center;
  justify-content: center; font-size: 0.85rem;
  transition: opacity 0.15s;
}
.reg-icon-btn:hover { opacity: 0.78; }
.reg-icon-btn.refresh { background: #6c757d; color: #fff; }
.reg-icon-btn.export  { background: #1d6f42; color: #fff; }

.reg-filter-bar {
  display: flex; flex-wrap: wrap;
  align-items: center; gap: 0.4rem;
  margin-bottom: 0.7rem;
  background: #f4f6fb; border-radius: 8px;
  padding: 0.45rem 0.6rem;
}
.reg-filter-bar label {
  font-size: 0.72rem; font-weight: 700;
  color: #888; white-space: nowrap;
  text-transform: uppercase; letter-spacing: .03em;
}
.reg-filter-bar input[type="date"],
.reg-filter-bar select {
  padding: 0.28rem 0.4rem;
  border: 1px solid #d8d8d8; border-radius: 5px;
  font-size: 0.8rem; background: #fff; height: 29px;
}
.reg-filter-bar .reg-sep { color: #bbb; padding: 0 0.05rem; }
.reg-search-input {
  flex: 1; min-width: 110px;
  padding: 0.28rem 0.4rem;
  border: 1px solid #d8d8d8; border-radius: 5px;
  font-size: 0.8rem; height: 29px;
}

.register-table-container {
  background: #fff; border-radius: 8px;
  box-shadow: 0 1px 4px rgba(0,0,0,.07);
  overflow-x: auto; margin-bottom: 5rem;
}
.register-table {
  width: 100%; border-collapse: collapse; font-size: 0.81rem;
}
.register-table thead {
  background: var(--primary, #3f51b5); color: #fff;
  position: sticky; top: 0; z-index: 10;
}
.register-table th {
  padding: 0.55rem 0.45rem; text-align: left;
  font-weight: 600; white-space: nowrap;
}
.register-table td {
  padding: 0.55rem 0.45rem; border-bottom: 1px solid #f0f0f0;
  vertical-align: middle;
}
.register-table tbody tr:hover { background: #f7f9fc; }

.date-group-header { background: #eef2f7; cursor: pointer; user-select: none; }
.date-group-header td {
  padding: 0.42rem 0.7rem; font-weight: 700;
  font-size: 0.76rem; color: var(--primary, #3f51b5);
  letter-spacing: .03em;
  border-bottom: 2px solid var(--primary, #3f51b5);
}
.date-group-header i { margin-right: 0.35rem; transition: transform 0.2s; }
.date-group-header.collapsed i { transform: rotate(-90deg); }
.date-group-row.reg-hidden { display: none; }

.status-badge {
  padding: 0.18rem 0.45rem; border-radius: 10px;
  font-size: 0.7rem; font-weight: 700; display: inline-block;
}
.status-active    { background: #fff3cd; color: #856404; }
.status-completed { background: #d4edda; color: #155724; }

.payment-split { display: flex; flex-direction: column; gap: 0.12rem; font-size: 0.77rem; }
.payment-item  { display: flex; justify-content: space-between; gap: 0.4rem; align-items: center; }
.pm-cash   { color: #28a745; font-weight: 700; font-size:.7rem; }
.pm-online { color: #1565c0; font-weight: 700; font-size:.7rem; }
.pm-bal    { color: #dc3545; font-weight: 700; font-size:.7rem; }

.bill-btn {
  padding: 0.22rem 0.5rem; background: var(--primary, #3f51b5);
  color: #fff; border: none; border-radius: 4px;
  cursor: pointer; font-size: 0.77rem;
}
.bill-btn:hover { opacity: 0.82; }

.reg-state { text-align: center; padding: 2.5rem 1rem; color: #999; }
.reg-state i { font-size: 1.8rem; margin-bottom: 0.5rem; opacity:.3; display:block; }
.reg-loader {
  width: 26px; height: 26px; border: 3px solid #eee;
  border-top-color: var(--primary,#3f51b5); border-radius: 50%;
  animation: reg-spin .8s linear infinite; margin: 0 auto .5rem;
}
@keyframes reg-spin { to { transform: rotate(360deg); } }

/* Bill Modal */
.bill-modal {
  display: none; position: fixed; top:0; left:0;
  width:100%; height:100%; background:rgba(0,0,0,.52);
  z-index: 1100; overflow-y: auto;
}
.bill-modal.show {
  display: flex; align-items: flex-start;
  justify-content: center; padding: 1rem;
}
.bill-content {
  background: #fff; max-width: 680px; width: 100%;
  border-radius: 10px; margin-top: 1rem;
  box-shadow: 0 8px 32px rgba(0,0,0,.18);
}
.bill-header {
  display: flex; justify-content: space-between;
  align-items: center; padding: 0.8rem 1rem;
  border-bottom: 1px solid #eee;
  position: sticky; top:0; background:#fff; z-index:1;
  border-radius: 10px 10px 0 0;
}
.bill-header h2 { margin:0; font-size:.95rem; }
.bill-close { background:none; border:none; font-size:1.3rem; cursor:pointer; color:#888; }
.bill-actions {
  padding: 0.65rem 1rem; border-top:1px solid #eee;
  display:flex; gap:.5rem; justify-content:flex-end;
  position:sticky; bottom:0; background:#fff;
  border-radius: 0 0 10px 10px;
}

#reg-bill-print-area {
  padding: 1rem 1.4rem;
  font-family: 'Courier New', monospace;
  font-size: 0.78rem; line-height: 1.42;
}
.b-lodge-name  { font-size:1.1rem; font-weight:bold; text-align:center; }
.b-lodge-sub   { font-size:.72rem; color:#555; text-align:center; margin-bottom:.1rem; }
.b-title       { text-align:center; font-size:.88rem; font-weight:bold;
                 margin:.4rem 0; border-top:1px solid #aaa; border-bottom:1px solid #aaa;
                 padding:.2rem 0; }
.b-info-grid   { display:grid; grid-template-columns:1fr 1fr; gap:.25rem .8rem;
                 margin:.5rem 0; font-size:.75rem; }
.b-row         { display:flex; justify-content:space-between; gap:.3rem; margin-bottom:.15rem; }
.b-lbl         { font-weight:700; white-space:nowrap; }
.b-tbl         { width:100%; border-collapse:collapse; font-size:.75rem; margin-bottom:.4rem; }
.b-tbl th, .b-tbl td { padding:.25rem .28rem; border:1px solid #ddd; }
.b-tbl th      { background:#f5f5f5; font-weight:700; }
.b-tr          { text-align:right; }
.b-sec td      { background:#e8ecf0; font-weight:700; font-size:.72rem; padding:.22rem .28rem; }
.b-grand       { font-weight:bold; border-top:2px solid #333; }
.b-pay-section { margin-top:.6rem; padding-top:.4rem; border-top:2px dashed #999; font-size:.75rem; }
.b-sig         { display:flex; justify-content:space-between; margin-top:1rem; }
.b-sig-line    { border-top:1px solid #555; margin-top:.9rem; padding-top:.25rem;
                 width:120px; text-align:center; font-size:.7rem; }
.b-footer      { margin-top:.6rem; border-top:1px solid #eee; padding-top:.35rem;
                 font-size:.68rem; color:#999; text-align:center; }

/* ── PRINT: force single A4 page ── */
@media print {
  @page { size: A4 portrait; margin: 6mm; }

  html, body { height: auto !important; overflow: visible !important; }

  /* Hide everything except the bill modal */
  body * { visibility: hidden !important; }

  /* Show the bill modal and its content */
  .bill-modal.show,
  .bill-modal.show .bill-content,
  .bill-modal.show #reg-bill-print-area,
  .bill-modal.show #reg-bill-print-area * {
    visibility: visible !important;
  }

  .bill-modal.show {
    position: absolute !important; top:0 !important; left:0 !important;
    width:100% !important; height:auto !important;
    background: white !important; padding:0 !important;
    overflow: visible !important; z-index:9999 !important;
    display: block !important;
  }
  .bill-content {
    box-shadow: none !important; border-radius:0 !important;
    max-height: none !important; overflow: visible !important;
    width: 100% !important; max-width: 100% !important;
    margin:0 !important; padding:0 !important;
  }
  .bill-header { display: none !important; }
  .bill-actions { display: none !important; }

  #reg-bill-print-area {
    padding: 0 !important;
    font-size: 8.5pt !important;
    line-height: 1.28 !important;
    width: 100% !important;
  }
  .b-lodge-name  { font-size:12pt !important; }
  .b-lodge-sub   { font-size:7.5pt !important; }
  .b-title       { font-size:9pt !important; margin:1.5mm 0 !important; padding:1mm 0 !important; }
  .b-info-grid   { font-size:8pt !important; gap:1mm 3mm !important; margin:1.5mm 0 !important; }
  .b-tbl         { font-size:8pt !important; margin-bottom:1.5mm !important; }
  .b-tbl th,
  .b-tbl td      { padding:.8mm !important; }
  .b-pay-section { margin-top:2.5mm !important; padding-top:1.5mm !important; font-size:8pt !important; }
  .b-sig         { margin-top:5mm !important; }
  .b-sig-line    { margin-top:4mm !important; width:35mm !important; font-size:7.5pt !important; }
  .b-footer      { margin-top:3mm !important; padding-top:2mm !important; font-size:7pt !important; }

  .b-tbl, .b-info-grid, .b-pay-section, .b-sig, .b-footer {
    page-break-inside: avoid !important;
    break-inside: avoid !important;
  }
  #reg-bill-print-area {
    page-break-after: avoid !important;
    break-after: avoid !important;
  }
}

@media (max-width: 600px) {
  .reg-filter-bar label { display: none; }
  .register-table { font-size: 0.73rem; }
  .register-table th, .register-table td { padding: 0.35rem 0.25rem; }
}
`;

  function injectStyles() {
    if (document.getElementById("reg-mod-styles")) return;
    const s = document.createElement("style");
    s.id = "reg-mod-styles";
    s.textContent = REGISTER_CSS;
    document.head.appendChild(s);
  }

  // ── State ────────────────────────────────────────────────────────────────────
  const state = {
    allEntries: [],
    filteredEntries: [],
    loading: false,
    dateRange: { start: null, end: null },
    filters: { search: "", payment: "all", status: "all" },
    lastLoadedRange: null, // tracks what range was last fetched
  };

  // ── Utilities ────────────────────────────────────────────────────────────────
  function pad(n) {
    return String(n).padStart(2, "0");
  }
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function nDaysAgoStr(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  const MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  function fmtDate(s) {
    const [y, m, d] = s.split("-");
    return `${parseInt(d)} ${MONTHS[parseInt(m) - 1]} ${y}`;
  }
  function fmtDT(dtStr) {
    if (!dtStr) return "-";
    const [dp, tp = ""] = dtStr.split(" ");
    return `${fmtDate(dp)}${tp ? " " + tp : ""}`;
  }
  function calcDays(ci, co) {
    if (!co) return 1;
    const diff = Math.ceil(
      (new Date(co.replace(" ", "T")) - new Date(ci.replace(" ", "T"))) /
        86400000,
    );
    return diff > 0 ? diff : 1;
  }
  function inr(n) {
    return (+(n || 0)).toLocaleString("en-IN");
  }
  function fix2(n) {
    return (+(n || 0)).toFixed(2);
  }
  function debounce(fn, ms) {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  }
  function dom(id) {
    return document.getElementById(id);
  }

  // GST: 5% inclusive, only when daily rate > 999
  function gstAmounts(ratePerNight, days) {
    const total = (ratePerNight || 0) * (days || 1);
    if (ratePerNight > 999) {
      const base = total / 1.05;
      const gst = total - base;
      return { base, cgst: gst / 2, sgst: gst / 2, total };
    }
    return { base: total, cgst: 0, sgst: 0, total };
  }

  // ── Build tab HTML ────────────────────────────────────────────────────────────
  function buildHTML() {
    const tab = dom("register-tab");
    if (!tab) return;
    tab.innerHTML = `
<div class="register-container">
  <div class="register-header">
    <h1><i class="fas fa-book"></i> Daily Register</h1>
    <div class="register-toolbar">
      <button class="reg-icon-btn refresh" id="reg-refresh-btn" title="Refresh">
        <i class="fas fa-sync-alt"></i>
      </button>
      <button class="reg-icon-btn export" id="reg-export-btn" title="Export Excel">
        <i class="fas fa-file-excel"></i>
      </button>
    </div>
  </div>

  <div class="reg-filter-bar">
    <label>From</label>
    <input type="date" id="reg-start-date" />
    <span class="reg-sep">–</span>
    <label>To</label>
    <input type="date" id="reg-end-date" />
    <select id="reg-status-filter">
      <option value="all">All Status</option>
      <option value="active">Active</option>
      <option value="completed">Checked Out</option>
    </select>
    <select id="reg-payment-filter">
      <option value="all">All Payments</option>
      <option value="cash">Cash Only</option>
      <option value="online">Online Only</option>
      <option value="split">Split</option>
      <option value="pending">Pending Balance</option>
    </select>
    <input type="text" class="reg-search-input" id="reg-search"
           placeholder="Name / Room / Mobile…" />
  </div>

  <div class="register-table-container">
    <table class="register-table">
      <thead>
        <tr>
          <th>#</th><th>Bill No</th><th>Guest</th><th>Contact</th>
          <th>Room</th><th>Check-in</th><th>Check-out</th><th>Days</th>
          <th>Rate</th><th>Services</th><th>Total</th>
          <th>Payment</th><th>Status</th><th>Bill</th>
        </tr>
      </thead>
      <tbody id="reg-table-body">
        <tr><td colspan="14">
          <div class="reg-state">
            <i class="fas fa-book-open"></i>
            <p>Open this tab to load register entries</p>
          </div>
        </td></tr>
      </tbody>
    </table>
  </div>
</div>

<div class="bill-modal" id="reg-bill-modal">
  <div class="bill-content">
    <div class="bill-header">
      <h2>Tax Invoice</h2>
      <button class="bill-close" id="reg-bill-close">&times;</button>
    </div>
    <div id="reg-bill-print-area"></div>
    <div class="bill-actions">
      <button class="action-btn btn-secondary" id="reg-bill-close2">Close</button>
      <button class="action-btn btn-primary" id="reg-bill-print">
        <i class="fas fa-print"></i> Print
      </button>
    </div>
  </div>
</div>`;
  }

  // ── Date defaults ─────────────────────────────────────────────────────────────
  function setDefaults() {
    const s = dom("reg-start-date"),
      e = dom("reg-end-date");
    if (!s || !e) return;
    const today = todayStr(),
      week = nDaysAgoStr(6);
    s.value = week;
    e.value = today;
    s.min = nDaysAgoStr(365);
    e.max = today;
    state.dateRange.start = week;
    state.dateRange.end = today;
  }

  // ── Events ────────────────────────────────────────────────────────────────────
  function wireEvents() {
    function onDateChange() {
      let s = dom("reg-start-date").value;
      let e = dom("reg-end-date").value;
      if (!s || !e) return;
      if (s > e) {
        [s, e] = [e, s];
        dom("reg-start-date").value = s;
        dom("reg-end-date").value = e;
      }
      state.dateRange.start = s;
      state.dateRange.end = e;
      loadData(true); // force reload on date change
    }

    const sd = dom("reg-start-date"),
      ed = dom("reg-end-date");
    if (sd) sd.addEventListener("change", onDateChange);
    if (ed) ed.addEventListener("change", onDateChange);

    const sf = dom("reg-status-filter"),
      pf = dom("reg-payment-filter"),
      sr = dom("reg-search");
    if (sf)
      sf.addEventListener("change", () => {
        state.filters.status = sf.value;
        applyFilters();
      });
    if (pf)
      pf.addEventListener("change", () => {
        state.filters.payment = pf.value;
        applyFilters();
      });
    if (sr)
      sr.addEventListener(
        "input",
        debounce(() => {
          state.filters.search = sr.value.toLowerCase();
          applyFilters();
        }, 220),
      );

    const rb = dom("reg-refresh-btn"),
      xb = dom("reg-export-btn");
    if (rb) rb.addEventListener("click", () => loadData(true));
    if (xb) xb.addEventListener("click", exportToExcel);

    const bc = dom("reg-bill-close"),
      bc2 = dom("reg-bill-close2");
    const bp = dom("reg-bill-print"),
      bm = dom("reg-bill-modal");
    if (bc) bc.addEventListener("click", closeBill);
    if (bc2) bc2.addEventListener("click", closeBill);
    if (bp) bp.addEventListener("click", () => window.print());
    if (bm)
      bm.addEventListener("click", (e) => {
        if (e.target === bm) closeBill();
      });

    // Delegated: bill buttons + group toggle
    const tbody = dom("reg-table-body");
    if (tbody) {
      tbody.addEventListener("click", (e) => {
        const btn = e.target.closest(".bill-btn");
        if (btn) {
          e.stopPropagation();
          openBill(btn.dataset.id);
          return;
        }
        const hdr = e.target.closest(".date-group-header");
        if (hdr) toggleGroup(hdr);
      });
    }
  }

  // ── Load data from server ────────────────────────────────────────────────────
  async function loadData(force) {
    if (state.loading) return;
    const { start, end } = state.dateRange;
    if (!start || !end) return;

    // Skip fetch if same range already loaded (unless forced by refresh btn)
    const rangeKey = `${start}_${end}`;
    if (
      !force &&
      state.lastLoadedRange === rangeKey &&
      state.allEntries.length >= 0
    ) {
      // Data already loaded for this range — just re-render
      applyFilters();
      return;
    }

    state.loading = true;
    showLoading();

    try {
      const res = await fetch("/get_register_data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_date: start, end_date: end }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.success) {
        state.allEntries = data.entries || [];
        state.lastLoadedRange = rangeKey;
        applyFilters();
      } else {
        showError(data.message || "Failed to load");
      }
    } catch (err) {
      console.error("[Register]", err);
      showError("Network error — " + err.message);
    } finally {
      state.loading = false;
    }
  }

  // ── Filters ───────────────────────────────────────────────────────────────────
  function applyFilters() {
    let f = [...state.allEntries];
    const { search, payment, status } = state.filters;

    if (search)
      f = f.filter(
        (e) =>
          (e.guest_name || "").toLowerCase().includes(search) ||
          (e.guest_mobile || "").includes(search) ||
          String(e.room || "").includes(search) ||
          (e.bill_number || "").toLowerCase().includes(search),
      );
    if (status !== "all") f = f.filter((e) => e.status === status);
    if (payment !== "all")
      f = f.filter((e) => {
        const c = e.payment_cash || 0,
          o = e.payment_online || 0,
          b = e.balance || 0;
        switch (payment) {
          case "cash":
            return c > 0 && o === 0;
          case "online":
            return o > 0 && c === 0;
          case "split":
            return c > 0 && o > 0;
          case "pending":
            return b > 0;
          default:
            return true;
        }
      });

    state.filteredEntries = f;
    renderTable();
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  function renderTable() {
    const tbody = dom("reg-table-body");
    if (!tbody) return;
    if (!state.filteredEntries.length) {
      showEmpty();
      return;
    }

    const byDate = {};
    state.filteredEntries.forEach((e) => {
      const dk = (e.checkin_time || "").split(" ")[0] || "unknown";
      if (!byDate[dk]) byDate[dk] = [];
      byDate[dk].push(e);
    });

    let html = "";
    Object.keys(byDate)
      .sort((a, b) => b.localeCompare(a))
      .forEach((dk) => {
        const entries = byDate[dk];
        const label = dk !== "unknown" ? fmtDate(dk) : "Unknown Date";
        html += `<tr class="date-group-header" data-group="${dk}">
        <td colspan="14"><i class="fas fa-chevron-down"></i>${label}&nbsp;<span style="font-weight:400;opacity:.65;">(${entries.length})</span></td>
      </tr>`;
        entries.forEach((e) => {
          html += rowHTML(e, dk);
        });
      });
    tbody.innerHTML = html;
  }

  function rowHTML(e, dk) {
    const days = e.days_stayed || calcDays(e.checkin_time, e.checkout_time);
    const serial =
      e.serial_number !== null &&
      e.serial_number !== undefined &&
      e.serial_number !== 0
        ? e.serial_number
        : "-";
    const billNo = e.status === "completed" ? e.bill_number || "-" : "-";
    const stCls = e.status === "active" ? "status-active" : "status-completed";
    const billBtn =
      e.status === "completed"
        ? `<button class="bill-btn" data-id="${e.id}" title="View Bill"><i class="fas fa-receipt"></i></button>`
        : `<span style="color:#ccc;">—</span>`;

    return `<tr class="date-group-row" data-date-group="${dk}">
      <td>${serial}</td>
      <td style="font-size:.73rem;white-space:nowrap;">${billNo}</td>
      <td><strong>${e.guest_name || "-"}</strong></td>
      <td style="font-size:.78rem;">${e.guest_mobile || "-"}</td>
      <td><strong>${e.room || "-"}</strong></td>
      <td style="font-size:.76rem;white-space:nowrap;">${fmtDT(e.checkin_time)}</td>
      <td style="font-size:.76rem;white-space:nowrap;">${e.checkout_time ? fmtDT(e.checkout_time) : '<span style="color:#aaa;">Active</span>'}</td>
      <td style="text-align:center;">${days}</td>
      <td>₹${inr(e.room_rent)}</td>
      <td>₹${inr(e.services_total)}</td>
      <td><strong>₹${inr(e.total_amount)}</strong></td>
      <td>${paymentHTML(e)}</td>
      <td><span class="status-badge ${stCls}">${e.status}</span></td>
      <td>${billBtn}</td>
    </tr>`;
  }

  function paymentHTML(e) {
    const c = e.payment_cash || 0,
      o = e.payment_online || 0,
      b = e.balance || 0;
    if (!c && !o && !b) return '<span style="color:#ccc;">—</span>';
    let h = '<div class="payment-split">';
    if (c)
      h += `<div class="payment-item"><span class="pm-cash">Cash</span><span>₹${inr(c)}</span></div>`;
    if (o)
      h += `<div class="payment-item"><span class="pm-online">Online</span><span>₹${inr(o)}</span></div>`;
    if (b > 0)
      h += `<div class="payment-item"><span class="pm-bal">Due</span><span>₹${inr(b)}</span></div>`;
    return h + "</div>";
  }

  function toggleGroup(hdr) {
    const key = hdr.dataset.group;
    const col = hdr.classList.toggle("collapsed");
    document
      .querySelectorAll(`.date-group-row[data-date-group="${key}"]`)
      .forEach((r) => r.classList.toggle("reg-hidden", col));
  }

  function showLoading() {
    const t = dom("reg-table-body");
    if (t)
      t.innerHTML = `<tr><td colspan="14"><div class="reg-state"><div class="reg-loader"></div><p>Loading…</p></div></td></tr>`;
  }
  function showEmpty() {
    const t = dom("reg-table-body");
    if (t)
      t.innerHTML = `<tr><td colspan="14"><div class="reg-state"><i class="fas fa-inbox"></i><p>No entries found for this period</p></div></td></tr>`;
  }
  function showError(msg) {
    const t = dom("reg-table-body");
    if (t)
      t.innerHTML = `<tr><td colspan="14"><div class="reg-state" style="color:#dc3545"><i class="fas fa-exclamation-circle"></i><p>${msg}</p></div></td></tr>`;
  }

  // ── Bill modal ────────────────────────────────────────────────────────────────
  function closeBill() {
    const m = dom("reg-bill-modal");
    if (m) m.classList.remove("show");
  }

  async function openBill(id) {
    const m = dom("reg-bill-modal"),
      area = dom("reg-bill-print-area");
    if (!m || !area) return;
    area.innerHTML = `<div class="reg-state"><div class="reg-loader"></div><p>Generating…</p></div>`;
    m.classList.add("show");
    try {
      const res = await fetch(`/generate_bill/${id}`);
      const data = await res.json();
      area.innerHTML = data.success
        ? buildBillHTML(data.bill)
        : `<div class="reg-state" style="color:#c00"><i class="fas fa-times-circle"></i><p>${data.message}</p></div>`;
    } catch {
      area.innerHTML = `<div class="reg-state" style="color:#c00"><i class="fas fa-times-circle"></i><p>Network error</p></div>`;
    }
  }

  // ── Bill HTML builder ─────────────────────────────────────────────────────────
  function fmtBillDT(dtStr) {
    if (!dtStr) return "-";
    const [dp, tp = ""] = dtStr.split(" ");
    const [y, m, d] = dp.split("-");
    const monthName = MONTHS[parseInt(m) - 1];
    // Format: "Mar 17, 2026, 11:55 PM" style
    let timePart = "";
    if (tp) {
      const [hh, mm] = tp.split(":");
      const h = parseInt(hh);
      const ampm = h >= 12 ? "PM" : "AM";
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      timePart = `, ${pad(h12)}:${mm} ${ampm}`;
    }
    return `${monthName} ${parseInt(d)}, ${y}${timePart}`;
  }

  function buildBillHTML(b) {
    const days = b.days_stayed || calcDays(b.checkin_time, b.checkout_time);
    const rate = b.room_price_per_night || b.room_rent || 0;
    const { base, cgst, sgst, total: roomTotal } = gstAmounts(rate, days);
    const svcTotal = b.services_total || 0;
    const discounts = b.discounts || 0;
    const grandTotal = roomTotal + svcTotal - discounts;
    const cashPaid = b.payment_cash || 0;
    const onlinePaid = b.payment_online || 0;
    const totalPaid = cashPaid + onlinePaid;
    const balance = b.balance || 0;

    let svcRows = "";
    if (b.services && b.services.length) {
      svcRows = b.services
        .map(
          (s) => `
        <tr>
          <td>${s.item}</td><td class="b-tr">${s.quantity || 1}</td>
          <td class="b-tr">${fix2(s.unit_price || s.price || 0)}</td>
          <td class="b-tr">${fix2(s.price || 0)}</td>
        </tr>`,
        )
        .join("");
    } else if (svcTotal > 0) {
      svcRows = `<tr><td>Services</td><td class="b-tr">—</td><td class="b-tr">—</td><td class="b-tr">${fix2(svcTotal)}</td></tr>`;
    }

    // Bill date = checkout time
    const billDate = fmtBillDT(b.checkout_time);

    return `
<div class="b-lodge-name">CIBARA COMFORTS</div>
<div class="b-lodge-sub">Opposite Bus Stand Road, Harihar, Karnataka – 577601</div>
<div class="b-lodge-sub">Phone: +91 9482831381 &nbsp;|&nbsp; GSTIN: 29AAWFC1962B1Z9</div>
<div class="b-title">TAX INVOICE</div>

<div class="b-info-grid">
  <div>
    <div class="b-row"><span class="b-lbl">Bill No:</span><span>${b.bill_number || "N/A"}</span></div>
    <div class="b-row"><span class="b-lbl">Guest Name:</span><span>${b.guest_name}</span></div>
    <div class="b-row"><span class="b-lbl">Mobile:</span><span>${b.guest_mobile || "N/A"}</span></div>
    <div class="b-row"><span class="b-lbl">Room No:</span><span>${b.room}</span></div>
  </div>
  <div>
    <div class="b-row"><span class="b-lbl">Check-in:</span><span>${fmtBillDT(b.checkin_time)}</span></div>
    <div class="b-row"><span class="b-lbl">Check-out:</span><span>${fmtBillDT(b.checkout_time)}</span></div>
    <div class="b-row"><span class="b-lbl">Days Stayed:</span><span>${days}</span></div>
    <div class="b-row"><span class="b-lbl">Bill Date:</span><span>${billDate}</span></div>
  </div>
</div>

<table class="b-tbl">
  <thead>
    <tr><th>Description</th><th class="b-tr">Qty</th><th class="b-tr">Rate</th><th class="b-tr">Amount</th></tr>
  </thead>
  <tbody>
    <tr class="b-sec"><td colspan="4">Room Charges</td></tr>
    <tr>
      <td>Room Rent (Base Amount)</td>
      <td class="b-tr">${days}</td>
      <td class="b-tr">${fix2(rate)}</td>
      <td class="b-tr">${fix2(base)}</td>
    </tr>
    <tr><td style="padding-left:.7rem">CGST @ 2.5%</td><td class="b-tr">-</td><td class="b-tr">-</td><td class="b-tr">${fix2(cgst)}</td></tr>
    <tr><td style="padding-left:.7rem">SGST @ 2.5%</td><td class="b-tr">-</td><td class="b-tr">-</td><td class="b-tr">${fix2(sgst)}</td></tr>
    <tr style="font-weight:700;">
      <td colspan="3" class="b-tr">Total Room Charges:</td>
      <td class="b-tr">${fix2(roomTotal)}</td>
    </tr>
    ${svcRows ? `<tr class="b-sec"><td colspan="4">Additional Services</td></tr>${svcRows}<tr style="font-weight:700;"><td colspan="3" class="b-tr">Total Services:</td><td class="b-tr">${fix2(svcTotal)}</td></tr>` : ""}
    ${discounts > 0 ? `<tr class="b-sec"><td colspan="4">Discounts</td></tr><tr><td>Discount Applied</td><td class="b-tr">—</td><td class="b-tr">—</td><td class="b-tr" style="color:green;">-${fix2(discounts)}</td></tr>` : ""}
    <tr class="b-grand">
      <td colspan="3" class="b-tr"><strong>GRAND TOTAL</strong></td>
      <td class="b-tr"><strong>${fix2(grandTotal)}</strong></td>
    </tr>
  </tbody>
</table>

<div class="b-pay-section">
  <strong>Payment Details</strong>
  <table class="b-tbl" style="margin-top:.25rem;">
    <tbody>
      <tr><td>Cash Paid</td><td class="b-tr">${fix2(cashPaid)}</td></tr>
      <tr><td>Online Paid</td><td class="b-tr">${fix2(onlinePaid)}</td></tr>
      <tr style="font-weight:700;"><td>Total Paid</td><td class="b-tr">${fix2(totalPaid)}</td></tr>
      ${balance > 0 ? `<tr style="font-weight:bold;color:#dc3545"><td>Balance Due</td><td class="b-tr">${fix2(balance)}</td></tr>` : ""}
    </tbody>
  </table>
</div>

<div class="b-sig">
  <div class="b-sig-line">Guest Signature</div>
  <div class="b-sig-line">Authorised Signatory</div>
</div>
<div class="b-footer">
  <p>Thank you for choosing Cibara Comforts, Harihar!</p>
  <p>Computer-generated invoice · No physical signature required</p>
</div>`;
  }

  // ── Export ────────────────────────────────────────────────────────────────────
  function exportToExcel() {
    if (!state.filteredEntries.length) {
      alert("No data to export.");
      return;
    }
    if (typeof XLSX === "undefined") {
      alert("Excel library not loaded. Refresh the page and retry.");
      return;
    }

    const rows = state.filteredEntries.map((e, i) => {
      const rate = e.room_rent || 0;
      const days =
        typeof e.days_stayed === "number"
          ? e.days_stayed
          : calcDays(e.checkin_time, e.checkout_time);
      const { base, cgst, sgst } = gstAmounts(rate, days);

      return {
        "Sr No":
          e.serial_number !== null &&
          e.serial_number !== undefined &&
          e.serial_number !== 0
            ? e.serial_number
            : i + 1,
        "Bill No": e.bill_number || "-",
        "Guest Name": e.guest_name || "-",
        Contact: e.guest_mobile || "-",
        Room: e.room || "-",
        "Check-in": fmtDT(e.checkin_time),
        "Check-out": e.checkout_time ? fmtDT(e.checkout_time) : "-",
        Days: days,
        "Room Rate/Night": rate,
        "Base Amt (excl GST)": +base.toFixed(2),
        "CGST 2.5%": +cgst.toFixed(2),
        "SGST 2.5%": +sgst.toFixed(2),
        "Total GST": +(cgst + sgst).toFixed(2),
        "Room Total": rate * days,
        Services: e.services_total || 0,
        "Grand Total": e.total_amount || 0,
        "Cash Paid": e.payment_cash || 0,
        "Online Paid": e.payment_online || 0,
        "Balance Due": e.balance || 0,
        Status: e.status || "-",
      };
    });

    try {
      const ws = XLSX.utils.json_to_sheet(rows);
      ws["!cols"] = [
        { wch: 6 },
        { wch: 18 },
        { wch: 22 },
        { wch: 14 },
        { wch: 6 },
        { wch: 20 },
        { wch: 20 },
        { wch: 5 },
        { wch: 14 },
        { wch: 18 },
        { wch: 11 },
        { wch: 11 },
        { wch: 11 },
        { wch: 12 },
        { wch: 10 },
        { wch: 13 },
        { wch: 10 },
        { wch: 12 },
        { wch: 12 },
        { wch: 10 },
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Register");
      XLSX.writeFile(
        wb,
        `Register_${state.dateRange.start}_to_${state.dateRange.end}.xlsx`,
      );
    } catch (err) {
      console.error("[Register] export error:", err);
      alert("Export failed: " + err.message);
    }
  }

  // ── Tab activation watch ──────────────────────────────────────────────────────
  function watchTab() {
    const tab = dom("register-tab");
    if (!tab) return;
    new MutationObserver(() => {
      if (!tab.classList.contains("hidden") && !state.loading) {
        // Use cached data if available (no force), instant switch-back
        loadData(false);
      }
    }).observe(tab, { attributes: true, attributeFilter: ["class"] });

    if (!tab.classList.contains("hidden")) loadData(true);
  }

  // ── Init ──────────────────────────────────────────────────────────────────────
  function init() {
    injectStyles();
    buildHTML();
    setDefaults();
    wireEvents();
    watchTab();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
