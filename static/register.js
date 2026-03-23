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
  background: #f4f6fb; border-radius: 10px;
  padding: 0.5rem 0.7rem;
  border: 1px solid #e8eaf0;
}
.reg-date-range-wrap {
  display: flex; align-items: center; gap: 0.3rem;
  background: #fff; border: 1px solid #d8d8d8; border-radius: 6px;
  padding: 0.2rem 0.5rem; height: 30px; cursor: pointer;
  transition: border-color 0.15s;
}
.reg-date-range-wrap:focus-within { border-color: var(--primary, #3f51b5); }
.reg-date-range-wrap i { color: #6c757d; font-size: 0.75rem; flex-shrink: 0; }
.reg-date-range-input {
  border: none; outline: none; font-size: 0.8rem;
  background: transparent; width: 155px; cursor: pointer;
  color: #333;
}
.reg-quick-btn {
  padding: 0.18rem 0.5rem; border-radius: 12px;
  border: 1px solid #d0d0d0; font-size: 0.71rem;
  background: #fff; cursor: pointer; color: #555;
  font-weight: 600; transition: all 0.15s; height: 24px;
  line-height: 1;
}
.reg-quick-btn:hover { background: #e8eaf6; border-color: var(--primary, #3f51b5); color: var(--primary, #3f51b5); }
.reg-quick-btn.rq-active { background: var(--primary, #3f51b5); color: #fff; border-color: var(--primary, #3f51b5); }
.reg-filter-divider { width: 1px; background: #dde1ea; height: 20px; margin: 0 0.15rem; flex-shrink: 0; }
.reg-filter-bar select {
  padding: 0.25rem 0.4rem;
  border: 1px solid #d8d8d8; border-radius: 6px;
  font-size: 0.8rem; background: #fff; height: 30px;
  color: #444; cursor: pointer;
}
.reg-search-input {
  flex: 1; min-width: 120px;
  padding: 0.25rem 0.5rem 0.25rem 1.8rem;
  border: 1px solid #d8d8d8; border-radius: 6px;
  font-size: 0.8rem; height: 30px;
  background: #fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='13' height='13' viewBox='0 0 24 24' fill='none' stroke='%23aaa' stroke-width='2.5'%3E%3Ccircle cx='11' cy='11' r='8'%3E%3C/circle%3E%3Cline x1='21' y1='21' x2='16.65' y2='16.65'%3E%3C/line%3E%3C/svg%3E") no-repeat 0.45rem center;
  transition: border-color 0.15s;
}
.reg-search-input:focus { outline: none; border-color: var(--primary, #3f51b5); }
.reg-count-badge {
  font-size: 0.72rem; color: #888; white-space: nowrap;
  margin-left: auto; padding: 0 0.3rem;
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

#reg-bill-print-area,
#bl-bill-print-area {
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

  /* Show the bill modal and its content (reg- = Register, bl- = Bills) */
  .bill-modal.show,
  .bill-modal.show .bill-content,
  .bill-modal.show #reg-bill-print-area,
  .bill-modal.show #reg-bill-print-area *,
  .bill-modal.show #bl-bill-print-area,
  .bill-modal.show #bl-bill-print-area * {
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

  #reg-bill-print-area,
  #bl-bill-print-area {
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
  #reg-bill-print-area,
  #bl-bill-print-area {
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
    </div>
  </div>

  <div class="reg-filter-bar">
    <div class="reg-date-range-wrap" id="reg-date-range-wrap">
      <i class="fas fa-calendar-alt"></i>
      <input type="text" id="reg-date-range" class="reg-date-range-input" placeholder="Select date range" readonly />
    </div>
    <button class="reg-quick-btn rq-active" data-rq="week">Week</button>
    <button class="reg-quick-btn" data-rq="today">Today</button>
    <button class="reg-quick-btn" data-rq="month">Month</button>
    <span class="reg-filter-divider"></span>
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
    <input type="text" class="reg-search-input" id="reg-search" placeholder="Name / Room / Mobile…" />
  </div>

  <div class="register-table-container">
    <table class="register-table">
      <thead>
        <tr>
          <th>#</th><th>Bill No</th><th>Guest</th><th>Contact</th>
          <th>Room</th><th>Check-in</th><th>Check-out</th><th>Days</th>
          <th>Rate</th><th>Services</th><th>Total</th>
          <th>Payment</th><th>Status</th>
        </tr>
      </thead>
      <tbody id="reg-table-body">
        <tr><td colspan="13">
          <div class="reg-state">
            <i class="fas fa-book-open"></i>
            <p>Open this tab to load register entries</p>
          </div>
        </td></tr>
      </tbody>
    </table>
  </div>
</div>`;
  }

  // ── Date helpers ──────────────────────────────────────────────────────────────
  function dateToYMD(d) {
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  // ── Date defaults + flatpickr init ────────────────────────────────────────────
  function setDefaults() {
    const today = todayStr(), week = nDaysAgoStr(6);
    state.dateRange.start = week;
    state.dateRange.end = today;

    const el = dom("reg-date-range");
    if (!el || !window.flatpickr) return;

    state._datePicker = flatpickr(el, {
      mode: "range",
      dateFormat: "Y-m-d",   // internal ISO format — avoids maxDate mis-parsing
      altInput: true,         // show human-friendly text to user
      altFormat: "d M Y",     // display: "17 Mar 2026"
      defaultDate: [week, today],
      maxDate: today,
      disableMobile: true,
      onChange: function (selectedDates) {
        if (selectedDates.length === 2) {
          state.dateRange.start = dateToYMD(selectedDates[0]);
          state.dateRange.end   = dateToYMD(selectedDates[1]);
          // clear quick-btn active
          document.querySelectorAll(".reg-quick-btn").forEach(b => b.classList.remove("rq-active"));
          loadData(true);
        }
      }
    });
  }

  // ── Events ────────────────────────────────────────────────────────────────────
  function wireEvents() {
    // Quick-range buttons (Today / Week / Month)
    document.querySelectorAll(".reg-quick-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const range = btn.dataset.rq;
        const today = todayStr();
        let start;
        if (range === "today")  start = today;
        else if (range === "week")  start = nDaysAgoStr(6);
        else if (range === "month") start = nDaysAgoStr(29);
        else start = today;
        state.dateRange.start = start;
        state.dateRange.end   = today;
        if (state._datePicker) state._datePicker.setDate([start, today]);
        document.querySelectorAll(".reg-quick-btn").forEach(b => b.classList.remove("rq-active"));
        btn.classList.add("rq-active");
        loadData(true);
      });
    });

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

    const rb = dom("reg-refresh-btn");
    if (rb) rb.addEventListener("click", () => loadData(true));

    // Delegated: group toggle
    const tbody = dom("reg-table-body");
    if (tbody) {
      tbody.addEventListener("click", (e) => {
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
        <td colspan="13"><i class="fas fa-chevron-down"></i>${label}&nbsp;<span style="font-weight:400;opacity:.65;">(${entries.length})</span></td>
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
      t.innerHTML = `<tr><td colspan="13"><div class="reg-state"><div class="reg-loader"></div><p>Loading…</p></div></td></tr>`;
  }
  function showEmpty() {
    const t = dom("reg-table-body");
    if (t)
      t.innerHTML = `<tr><td colspan="13"><div class="reg-state"><i class="fas fa-inbox"></i><p>No entries found for this period</p></div></td></tr>`;
  }
  function showError(msg) {
    const t = dom("reg-table-body");
    if (t)
      t.innerHTML = `<tr><td colspan="13"><div class="reg-state" style="color:#dc3545"><i class="fas fa-exclamation-circle"></i><p>${msg}</p></div></td></tr>`;
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
