// ==========================================
// BILLS MODULE — CA Filing View
// Shows completed entries with a bill_number (CC/... format) — CA filing view
// Self-contained: own bill modal + renderer, no register.js dependency
// GST rates per 55th GST Council (eff. 22 Sep 2025): 5% (₹1k–₹7.5k) / 18% (>₹7.5k) per SAC 9963
// ==========================================

(function () {
  // ── CSS ─────────────────────────────────────────────────────────────────────
  const BILLS_CSS = `
.bills-container { padding: 1rem; max-width: 100%; }

.bills-header {
  display: flex; justify-content: space-between;
  align-items: center; margin-bottom: 0.6rem;
}
.bills-header h1 {
  font-size: 1.05rem; font-weight: 700;
  color: var(--primary); display: flex;
  align-items: center; gap: 0.4rem; margin: 0;
}
.bills-toolbar { display: flex; align-items: center; gap: 0.4rem; }

.bl-icon-btn {
  width: 32px; height: 32px; border: none;
  border-radius: 6px; cursor: pointer;
  display: flex; align-items: center;
  justify-content: center; font-size: 0.85rem;
  transition: opacity 0.15s;
}
.bl-icon-btn:hover { opacity: 0.78; }
.bl-icon-btn.refresh { background: #6c757d; color: #fff; }
.bl-icon-btn.export  { background: #1d6f42; color: #fff; }

/* ── Tally Dashboard ── */
.bills-tally {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 0.5rem; margin-bottom: 0.7rem;
}
.bl-card {
  background: #fff; border-radius: 8px;
  border: 1px solid #e8eaf0;
  padding: 0.55rem 0.7rem;
  box-shadow: 0 1px 3px rgba(0,0,0,.06);
}
.bl-card .bl-label {
  font-size: 0.67rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: .04em; color: #888; margin-bottom: 0.2rem;
}
.bl-card .bl-value {
  font-size: 1rem; font-weight: 800; color: var(--primary, #3f51b5);
}
.bl-card.bl-cash .bl-value   { color: #28a745; }
.bl-card.bl-upi .bl-value    { color: #1565c0; }
.bl-card.bl-rev .bl-value    { color: #3f51b5; }
.bl-card.bl-cnt .bl-value    { color: #6f42c1; }

/* ── Filter bar ── */
.bl-filter-bar {
  display: flex; flex-wrap: wrap;
  align-items: center; gap: 0.4rem;
  margin-bottom: 0.7rem;
  background: #f4f6fb; border-radius: 10px;
  padding: 0.5rem 0.7rem;
  border: 1px solid #e8eaf0;
}
.bl-date-range-wrap {
  display: flex; align-items: center; gap: 0.3rem;
  background: #fff; border: 1px solid #d8d8d8; border-radius: 6px;
  padding: 0.2rem 0.5rem; height: 30px; cursor: pointer;
  transition: border-color 0.15s;
}
.bl-date-range-wrap:focus-within { border-color: var(--primary, #3f51b5); }
.bl-date-range-wrap i { color: #6c757d; font-size: 0.75rem; flex-shrink: 0; }
.bl-date-range-input {
  border: none; outline: none; font-size: 0.8rem;
  background: transparent; width: 155px; cursor: pointer; color: #333;
}
.bl-quick-btn {
  padding: 0.18rem 0.5rem; border-radius: 12px;
  border: 1px solid #d0d0d0; font-size: 0.71rem;
  background: #fff; cursor: pointer; color: #555;
  font-weight: 600; transition: all 0.15s; height: 24px; line-height: 1;
}
.bl-quick-btn:hover { background: #e8eaf6; border-color: var(--primary, #3f51b5); color: var(--primary, #3f51b5); }
.bl-quick-btn.bq-active { background: var(--primary, #3f51b5); color: #fff; border-color: var(--primary, #3f51b5); }
.bl-filter-divider { width: 1px; background: #dde1ea; height: 20px; margin: 0 0.15rem; flex-shrink: 0; }
.bl-filter-bar select {
  padding: 0.25rem 0.4rem;
  border: 1px solid #d8d8d8; border-radius: 6px;
  font-size: 0.8rem; background: #fff; height: 30px; color: #444; cursor: pointer;
}
.bl-search-input {
  flex: 1; min-width: 120px;
  padding: 0.25rem 0.5rem 0.25rem 1.8rem;
  border: 1px solid #d8d8d8; border-radius: 6px;
  font-size: 0.8rem; height: 30px;
  background: #fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='13' height='13' viewBox='0 0 24 24' fill='none' stroke='%23aaa' stroke-width='2.5'%3E%3Ccircle cx='11' cy='11' r='8'%3E%3C/circle%3E%3Cline x1='21' y1='21' x2='16.65' y2='16.65'%3E%3C/line%3E%3C/svg%3E") no-repeat 0.45rem center;
  transition: border-color 0.15s;
}
.bl-search-input:focus { outline: none; border-color: var(--primary, #3f51b5); }

/* ── Table ── */
.bills-table-container {
  background: #fff; border-radius: 8px;
  box-shadow: 0 1px 4px rgba(0,0,0,.07);
  overflow-x: auto; margin-bottom: 5rem;
}
.bills-table {
  width: 100%; border-collapse: collapse; font-size: 0.81rem;
}
.bills-table thead {
  background: var(--primary, #3f51b5); color: #fff;
  position: sticky; top: 0; z-index: 10;
}
.bills-table th {
  padding: 0.55rem 0.45rem; text-align: left;
  font-weight: 600; white-space: nowrap;
}
.bills-table td {
  padding: 0.55rem 0.45rem; border-bottom: 1px solid #f0f0f0;
  vertical-align: middle;
}
.bills-table tbody tr:hover { background: #f7f9fc; }

.bl-date-header { background: #eef2f7; cursor: pointer; user-select: none; }
.bl-date-header td {
  padding: 0.42rem 0.7rem; font-weight: 700;
  font-size: 0.76rem; color: var(--primary, #3f51b5);
  letter-spacing: .03em;
  border-bottom: 2px solid var(--primary, #3f51b5);
}
.bl-date-header i { margin-right: 0.35rem; transition: transform 0.2s; }
.bl-date-header.collapsed i { transform: rotate(-90deg); }
.bl-date-row.bl-hidden { display: none; }

/* Badges */
.bl-src-badge {
  display: inline-block; padding: 0.13rem 0.38rem;
  border-radius: 10px; font-size: 0.68rem; font-weight: 700;
}
.bl-src-normal    { background: #e8f5e9; color: #2e7d32; }
.bl-src-bookingcom { background: #e3f2fd; color: #1565c0; }

.bl-bill-btn {
  padding: 0.22rem 0.5rem; background: var(--primary, #3f51b5);
  color: #fff; border: none; border-radius: 4px;
  cursor: pointer; font-size: 0.77rem;
}
.bl-bill-btn:hover { opacity: 0.82; }

.bl-pay-split { display: flex; flex-direction: column; gap: 0.12rem; font-size: 0.77rem; }
.bl-pay-item  { display: flex; justify-content: space-between; gap: 0.4rem; align-items: center; }
.bl-pm-cash   { color: #28a745; font-weight: 700; font-size:.7rem; }
.bl-pm-upi    { color: #1565c0; font-weight: 700; font-size:.7rem; }
.bl-pm-bal    { color: #dc3545; font-weight: 700; font-size:.7rem; }

.bl-state { text-align: center; padding: 2.5rem 1rem; color: #999; }
.bl-state i { font-size: 1.8rem; margin-bottom: 0.5rem; opacity:.3; display:block; }
.bl-loader {
  width: 26px; height: 26px; border: 3px solid #eee;
  border-top-color: var(--primary,#3f51b5); border-radius: 50%;
  animation: bl-spin .8s linear infinite; margin: 0 auto .5rem;
}
@keyframes bl-spin { to { transform: rotate(360deg); } }

/* ── View toggle (date-grouped vs sorted) ── */
.bl-view-toggle {
  display: flex; align-items: center;
  margin-bottom: 0.4rem; padding: 0 0.1rem;
}
.bl-view-btn {
  padding: 0.18rem 0.55rem; border-radius: 12px;
  border: 1px solid #d0d0d0; font-size: 0.72rem;
  background: #fff; cursor: pointer; color: #555;
  font-weight: 600; transition: all 0.15s; margin-right: 0.25rem;
  line-height: 1.4;
}
.bl-view-btn:hover { border-color: var(--primary, #3f51b5); color: var(--primary, #3f51b5); }
.bl-view-btn.bl-view-active { background: var(--primary, #3f51b5); color: #fff; border-color: var(--primary, #3f51b5); }

@media (max-width: 600px) {
  .bl-filter-bar label { display: none; }
  .bills-table { font-size: 0.73rem; }
  .bills-table th, .bills-table td { padding: 0.35rem 0.25rem; }
}
`;

  function injectStyles() {
    if (document.getElementById("bills-mod-styles")) return;
    const s = document.createElement("style");
    s.id = "bills-mod-styles";
    s.textContent = BILLS_CSS;
    document.head.appendChild(s);
  }

  // ── State ────────────────────────────────────────────────────────────────────
  const state = {
    allEntries: [],
    filteredEntries: [],
    loading: false,
    dateRange: { start: null, end: null },
    filters: { search: "", source: "all" },
    lastLoadedRange: null,
    sort: { key: null, dir: "asc" },
  };

  // ── Utilities ────────────────────────────────────────────────────────────────
  function pad(n) { return String(n).padStart(2, "0"); }
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  }
  function nDaysAgoStr(n) {
    const d = new Date(); d.setDate(d.getDate() - n);
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  }
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  // Parse the sequential number out of bill numbers like "CC/2026/03/00091" → 91
  // Always take the last segment since the format can vary in number of parts.
  function parseBillNo(bn) {
    if (!bn) return 0;
    const parts = bn.split("/");
    return parseInt(parts[parts.length - 1], 10) || 0;
  }
  function fmtDate(s) {
    const [y, m, d] = s.split("-");
    return `${parseInt(d)} ${MONTHS[parseInt(m)-1]} ${y}`;
  }
  function fmtDT(dtStr) {
    if (!dtStr) return "-";
    const [dp, tp=""] = dtStr.split(" ");
    return `${fmtDate(dp)}${tp ? " "+tp : ""}`;
  }
  function fmtBillDT(dtStr) {
    if (!dtStr) return "-";
    const [dp, tp = ""] = dtStr.split(" ");
    const [y, m, d] = dp.split("-");
    const monthName = MONTHS[parseInt(m) - 1];
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
  function calcDays(ci, co) {
    if (!co) return 1;
    const diff = Math.ceil((new Date(co.replace(" ","T")) - new Date(ci.replace(" ","T"))) / 86400000);
    return diff > 0 ? diff : 1;
  }
  function inr(n) { return (+(n||0)).toLocaleString("en-IN"); }
  function fix2(n) { return (+(n || 0)).toFixed(2); }
  function debounce(fn, ms) {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }
  function dom(id) { return document.getElementById(id); }

  // ── GST rates per 55th GST Council (effective 22 Sep 2025), SAC 9963 ─────────
  // < ₹1,000/night  → Exempt (0%)
  // ₹1,000–₹7,500   → 5%  (CGST 2.5% + SGST 2.5%) — no ITC
  // > ₹7,500/night  → 18% (CGST 9%   + SGST 9%)   — ITC available
  function gstAmounts(ratePerNight, days) {
    const total = (ratePerNight || 0) * (days || 1);
    if (ratePerNight > 7500) {
      const base = total / 1.18;
      const gst  = total - base;
      return { base, cgst: gst/2, sgst: gst/2, total, cgstRate: 9, sgstRate: 9 };
    } else if (ratePerNight >= 1000) {
      const base = total / 1.05;
      const gst  = total - base;
      return { base, cgst: gst/2, sgst: gst/2, total, cgstRate: 2.5, sgstRate: 2.5 };
    }
    return { base: total, cgst: 0, sgst: 0, total, cgstRate: 0, sgstRate: 0 };
  }

  // ── Build tab HTML ────────────────────────────────────────────────────────────
  function buildHTML() {
    const tab = dom("bills-tab");
    if (!tab) return;
    tab.innerHTML = `
<div class="bills-container">
  <div class="bills-header">
    <h1><i class="fas fa-file-invoice-dollar"></i> Bills</h1>
    <div class="bills-toolbar">
      <button class="bl-icon-btn refresh" id="bl-refresh-btn" title="Refresh">
        <i class="fas fa-sync-alt"></i>
      </button>
      <button class="bl-icon-btn export" id="bl-export-btn" title="Export CA Report (Excel)">
        <i class="fas fa-file-excel"></i>
      </button>
    </div>
  </div>

  <!-- Tally — computed from invoiced entries in selected date range -->
  <div class="bills-tally" id="bl-tally">
    <div class="bl-card bl-cash">
      <div class="bl-label">Cash (Period)</div>
      <div class="bl-value" id="bl-tc-cash">₹0</div>
    </div>
    <div class="bl-card bl-upi">
      <div class="bl-label">UPI (Period)</div>
      <div class="bl-value" id="bl-tc-upi">₹0</div>
    </div>
    <div class="bl-card bl-rev">
      <div class="bl-label">Revenue (Period)</div>
      <div class="bl-value" id="bl-tc-rev">₹0</div>
    </div>
    <div class="bl-card bl-cnt">
      <div class="bl-label">Invoice Count</div>
      <div class="bl-value" id="bl-tc-count">0</div>
    </div>
  </div>

  <!-- Filter bar -->
  <div class="bl-filter-bar">
    <div class="bl-date-range-wrap">
      <i class="fas fa-calendar-alt"></i>
      <input type="text" id="bl-date-range" class="bl-date-range-input" placeholder="Select date range" readonly />
    </div>
    <button class="bl-quick-btn bq-active" data-bq="week">Week</button>
    <button class="bl-quick-btn" data-bq="today">Today</button>
    <button class="bl-quick-btn" data-bq="month">Month</button>
    <span class="bl-filter-divider"></span>
    <select id="bl-source-filter">
      <option value="all">All Sources</option>
      <option value="normal">Normal</option>
      <option value="booking.com">Booking.com</option>
    </select>
    <input type="text" class="bl-search-input" id="bl-search"
           placeholder="Name / Room / Invoice No…" />
  </div>

  <!-- View toggle -->
  <div class="bl-view-toggle">
    <span style="font-size:.72rem;color:#888;margin-right:.35rem;font-weight:600;">View:</span>
    <button id="bl-view-date" class="bl-view-btn bl-view-active">&#128197; Check-in Date</button>
    <button id="bl-view-billno" class="bl-view-btn">&#8645; Bill No</button>
  </div>

  <!-- Table -->
  <div class="bills-table-container">
    <table class="bills-table">
      <thead>
        <tr>
          <th>#</th><th>Bill No</th><th>Guest</th><th>Contact</th>
          <th>Room</th><th>Check-in</th><th>Check-out</th><th>Days</th>
          <th>Total</th><th>GST</th><th>Payment</th><th>Source</th><th>Action</th>
        </tr>
      </thead>
      <tbody id="bl-table-body">
        <tr><td colspan="13">
          <div class="bl-state">
            <i class="fas fa-file-invoice-dollar"></i>
            <p>Open this tab to load invoiced bills</p>
          </div>
        </td></tr>
      </tbody>
    </table>
  </div>
</div>

<!-- Bill Modal — self-contained, bl- prefixed IDs -->
<div class="bill-modal" id="bl-bill-modal">
  <div class="bill-content">
    <div class="bill-header">
      <h2>Tax Invoice</h2>
      <button class="bill-close" id="bl-bill-close">&times;</button>
    </div>
    <div id="bl-bill-print-area"></div>
    <div class="bill-actions">
      <button class="action-btn btn-secondary" id="bl-bill-close2">Close</button>
      <button class="action-btn btn-primary" id="bl-bill-print">
        <i class="fas fa-print"></i> Print
      </button>
    </div>
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

    const el = dom("bl-date-range");
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
          document.querySelectorAll(".bl-quick-btn").forEach(b => b.classList.remove("bq-active"));
          loadData(true);
        }
      }
    });
  }

  // ── Events ────────────────────────────────────────────────────────────────────
  function wireEvents() {
    // Quick-range buttons
    document.querySelectorAll(".bl-quick-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const range = btn.dataset.bq;
        const today = todayStr();
        let start;
        if (range === "today")  start = today;
        else if (range === "week")  start = nDaysAgoStr(6);
        else if (range === "month") start = nDaysAgoStr(29);
        else start = today;
        state.dateRange.start = start;
        state.dateRange.end   = today;
        if (state._datePicker) state._datePicker.setDate([start, today]);
        document.querySelectorAll(".bl-quick-btn").forEach(b => b.classList.remove("bq-active"));
        btn.classList.add("bq-active");
        loadData(true);
      });
    });

    const srcf = dom("bl-source-filter");
    const sr   = dom("bl-search");

    if (srcf) srcf.addEventListener("change", () => { state.filters.source = srcf.value; applyFilters(); });
    if (sr)   sr.addEventListener("input", debounce(() => { state.filters.search = sr.value.toLowerCase(); applyFilters(); }, 220));

    const rb = dom("bl-refresh-btn"), xb = dom("bl-export-btn");
    if (rb) rb.addEventListener("click", () => loadData(true));
    if (xb) xb.addEventListener("click", exportToExcel);

    // Bill modal controls
    const bc  = dom("bl-bill-close");
    const bc2 = dom("bl-bill-close2");
    const bp  = dom("bl-bill-print");
    const bm  = dom("bl-bill-modal");
    if (bc)  bc.addEventListener("click", closeBill);
    if (bc2) bc2.addEventListener("click", closeBill);
    if (bp)  bp.addEventListener("click", function() {
      const area = dom("bl-bill-print-area");
      if (!area || !area.innerHTML.trim()) return;
      // Remove any stale clone from a previous print
      var old = document.getElementById("bl-print-clone");
      if (old) old.remove();
      // Append bill HTML as a direct <body> child — only content in the page during print
      var clone = document.createElement("div");
      clone.id = "bl-print-clone";
      clone.innerHTML = area.innerHTML;
      document.body.appendChild(clone);
      document.body.classList.add("bl-printing");
      try { window.print(); } finally {
        document.body.classList.remove("bl-printing");
        clone.remove();
      }
    });
    if (bm)  bm.addEventListener("click", (e) => { if (e.target === bm) closeBill(); });

    // Delegated clicks: bill view + group toggle
    const tbody = dom("bl-table-body");
    if (tbody) {
      tbody.addEventListener("click", (e) => {
        const billBtn = e.target.closest(".bl-bill-btn");
        if (billBtn) { e.stopPropagation(); openBill(billBtn.dataset.id); return; }
        const hdr = e.target.closest(".bl-date-header");
        if (hdr) toggleGroup(hdr);
      });
    }

    _wireSortHeaders();
  }

  function _wireSortHeaders() {
    const btnDate   = dom("bl-view-date");
    const btnBillNo = dom("bl-view-billno");
    if (!btnDate || !btnBillNo) return;

    // "Check-in Date" → reset to grouped view
    btnDate.addEventListener("click", () => {
      state.sort.key = null;
      state.sort.dir = "asc";
      _updateSortArrows();
      renderTable();
    });

    // "Bill No" → cycle asc → desc → asc on repeated clicks
    btnBillNo.addEventListener("click", () => {
      if (state.sort.key === "bill_no") {
        state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
      } else {
        state.sort.key = "bill_no";
        state.sort.dir = "asc";
      }
      _updateSortArrows();
      renderTable();
    });
  }

  function _updateSortArrows() {
    const btnDate   = dom("bl-view-date");
    const btnBillNo = dom("bl-view-billno");
    if (!btnDate || !btnBillNo) return;

    if (state.sort.key === "bill_no") {
      btnDate.classList.remove("bl-view-active");
      const arrow = state.sort.dir === "asc" ? " ▲" : " ▼";
      btnBillNo.innerHTML = `&#8645; Bill No${arrow}`;
      btnBillNo.classList.add("bl-view-active");
    } else {
      btnDate.classList.add("bl-view-active");
      btnBillNo.innerHTML = "&#8645; Bill No";
      btnBillNo.classList.remove("bl-view-active");
    }
  }

  // ── Load data ────────────────────────────────────────────────────────────────
  async function loadData(force) {
    if (state.loading) return;
    const { start, end } = state.dateRange;
    if (!start || !end) return;

    const rangeKey = `${start}_${end}`;
    if (!force && state.lastLoadedRange === rangeKey && state.allEntries.length >= 0) {
      applyFilters(); return;
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
      console.error("[Bills]", err);
      showError("Network error — " + err.message);
    } finally {
      state.loading = false;
    }
  }

  // ── Filters — completed entries with a bill_number (CA filing) ─────────────
  function applyFilters() {
    // All completed stays that have a bill number assigned — these are what CA files.
    // NOTE: We do NOT rely on invoice_generated flag because older Firestore documents
    // were created before that field was added. bill_number (CC/...) presence is the
    // canonical indicator that a bill was generated.
    let f = state.allEntries.filter(e =>
      e.status === "completed" &&
      e.bill_number &&
      e.bill_number !== "-" &&
      e.bill_number.trim() !== ""
    );

    const { search, source } = state.filters;

    if (search)
      f = f.filter((e) =>
        (e.guest_name || "").toLowerCase().includes(search) ||
        (e.guest_mobile || "").includes(search) ||
        String(e.room || "").includes(search) ||
        (e.bill_number || "").toLowerCase().includes(search) ||
        (e.invoice_number || "").toLowerCase().includes(search),
      );

    // MMT OTA has no invoice so won't appear here; only normal + booking.com
    if (source !== "all") f = f.filter((e) => (e.booking_source || "normal") === source);

    state.filteredEntries = f;
    renderTally(f);
    renderTable();
  }

  // ── Tally — computed from filtered invoiced entries for the selected range ────
  function renderTally(entries) {
    let cash = 0, upi = 0;
    for (const e of entries) {
      cash += e.payment_cash   || 0;
      upi  += e.payment_online || 0;
    }
    const revenue = cash + upi;
    const set = (id, val) => { const el = dom(id); if (el) el.textContent = "₹" + inr(val || 0); };
    set("bl-tc-cash", cash);
    set("bl-tc-upi",  upi);
    set("bl-tc-rev",  revenue);
    const countEl = dom("bl-tc-count");
    if (countEl) countEl.textContent = entries.length;
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  function renderTable() {
    const tbody = dom("bl-table-body");
    if (!tbody) return;
    if (!state.filteredEntries.length) { showEmpty(); return; }

    // Sorted flat view — no date group headers
    if (state.sort.key) {
      const sorted = [...state.filteredEntries].sort((a, b) => {
        let va, vb;
        if (state.sort.key === "bill_no") {
          va = parseBillNo(a.bill_number);
          vb = parseBillNo(b.bill_number);
        } else {
          va = a.checkout_time || "";
          vb = b.checkout_time || "";
        }
        if (va < vb) return state.sort.dir === "asc" ? -1 : 1;
        if (va > vb) return state.sort.dir === "asc" ?  1 : -1;
        return 0;
      });
      let html = "";
      sorted.forEach((e, i) => {
        const dk = (e.checkin_time || "").split(" ")[0] || "unknown";
        html += rowHTML(e, dk, i + 1);
      });
      tbody.innerHTML = html;
      return;
    }

    // Default: date-grouped view (dates descending)
    const byDate = {};
    state.filteredEntries.forEach((e) => {
      const dk = (e.checkin_time || "").split(" ")[0] || "unknown";
      if (!byDate[dk]) byDate[dk] = [];
      byDate[dk].push(e);
    });

    let html = "";
    let rowNum = 0;  // sequential counter across all date groups
    Object.keys(byDate).sort((a, b) => b.localeCompare(a)).forEach((dk) => {
      const entries = byDate[dk];
      const label = dk !== "unknown" ? fmtDate(dk) : "Unknown Date";
      html += `<tr class="bl-date-header" data-group="${dk}">
        <td colspan="13"><i class="fas fa-chevron-down"></i>${label}&nbsp;<span style="font-weight:400;opacity:.65;">(${entries.length})</span></td>
      </tr>`;
      entries.forEach((e) => { rowNum++; html += rowHTML(e, dk, rowNum); });
    });
    tbody.innerHTML = html;
  }

  function rowHTML(e, dk, rowIndex) {
    const days   = e.days_stayed || calcDays(e.checkin_time, e.checkout_time);

    const billNo = e.bill_number || "-";

    // GST summary cell
    const rate = e.room_rent || e.room_price_per_night || 0;
    const { cgst, sgst, cgstRate } = gstAmounts(rate, days);
    const gstTotal = cgst + sgst;
    const gstCell = gstTotal > 0
      ? `<span style="font-size:.73rem;">₹${inr(Math.round(gstTotal))}<br><span style="font-size:.65rem;color:#888;">${cgstRate*2}% GST</span></span>`
      : `<span style="color:#aaa;font-size:.73rem;">Exempt</span>`;

    // Source badge
    const src      = e.booking_source || "normal";
    const srcLabel = src === "booking.com" ? "Booking.com" : "Normal";
    const srcCls   = src === "booking.com" ? "bl-src-bookingcom" : "bl-src-normal";
    const srcBadge = `<span class="bl-src-badge ${srcCls}">${srcLabel}</span>`;

    return `<tr class="bl-date-row" data-date-group="${dk}">
      <td style="color:#888;font-size:.75rem;">${rowIndex}</td>
      <td style="font-size:.73rem;white-space:nowrap;font-family:monospace;">${billNo}</td>
      <td><strong>${e.guest_name || "-"}</strong></td>
      <td style="font-size:.78rem;">${e.guest_mobile || "-"}</td>
      <td><strong>${e.room || "-"}</strong></td>
      <td style="font-size:.76rem;white-space:nowrap;">${fmtDT(e.checkin_time)}</td>
      <td style="font-size:.76rem;white-space:nowrap;">${fmtDT(e.checkout_time)}</td>
      <td style="text-align:center;">${days}</td>
      <td><strong>₹${inr(e.total_amount)}</strong></td>
      <td>${gstCell}</td>
      <td>${paymentHTML(e)}</td>
      <td>${srcBadge}</td>
      <td><button class="bl-bill-btn" data-id="${e.id}" title="View/Print Bill"><i class="fas fa-receipt"></i></button></td>
    </tr>`;
  }

  function paymentHTML(e) {
    const c = e.payment_cash || 0, o = e.payment_online || 0,
          r = e.refunds || 0,    b = e.balance || 0;
    if (!c && !o && !r && !b) return '<span style="color:#ccc;">—</span>';
    let h = '<div class="bl-pay-split">';
    if (c) h += `<div class="bl-pay-item"><span class="bl-pm-cash">Cash</span><span>₹${inr(c)}</span></div>`;
    if (o) h += `<div class="bl-pay-item"><span class="bl-pm-upi">Online</span><span>₹${inr(o)}</span></div>`;
    if (r > 0) {
      const rc = e.refund_cash || 0, ro = e.refund_online || 0;
      const rLabel = rc > 0 && ro > 0 ? "Refund" : rc > 0 ? "Refund (Cash)" : ro > 0 ? "Refund (UPI)" : "Refund";
      h += `<div class="bl-pay-item"><span class="bl-pm-bal">${rLabel}</span><span>-₹${inr(r)}</span></div>`;
    }
    if (b > 0) h += `<div class="bl-pay-item"><span class="bl-pm-bal">Due</span><span>₹${inr(b)}</span></div>`;
    return h + "</div>";
  }

  function toggleGroup(hdr) {
    const key = hdr.dataset.group;
    const col = hdr.classList.toggle("collapsed");
    document.querySelectorAll(`.bl-date-row[data-date-group="${key}"]`).forEach((r) => r.classList.toggle("bl-hidden", col));
  }

  function showLoading() {
    const t = dom("bl-table-body");
    if (t) t.innerHTML = `<tr><td colspan="13"><div class="bl-state"><div class="bl-loader"></div><p>Loading…</p></div></td></tr>`;
  }
  function showEmpty() {
    const t = dom("bl-table-body");
    if (t) t.innerHTML = `<tr><td colspan="13"><div class="bl-state"><i class="fas fa-inbox"></i><p>No invoiced bills found for this period</p></div></td></tr>`;
  }
  function showError(msg) {
    const t = dom("bl-table-body");
    if (t) t.innerHTML = `<tr><td colspan="13"><div class="bl-state" style="color:#dc3545"><i class="fas fa-exclamation-circle"></i><p>${msg}</p></div></td></tr>`;
  }

  // ── Bill modal — self-contained, no register.js dependency ───────────────────
  function closeBill() {
    const m = dom("bl-bill-modal");
    if (m) m.classList.remove("show");
  }

  async function openBill(id) {
    const m = dom("bl-bill-modal"), area = dom("bl-bill-print-area");
    if (!m || !area) return;
    area.innerHTML = `<div class="bl-state"><div class="bl-loader"></div><p>Generating…</p></div>`;
    m.classList.add("show");
    try {
      const res  = await fetch(`/generate_bill/${id}`);
      const data = await res.json();
      area.innerHTML = data.success
        ? buildBillHTML(data.bill)
        : `<div class="bl-state" style="color:#c00"><i class="fas fa-times-circle"></i><p>${data.message}</p></div>`;
    } catch {
      area.innerHTML = `<div class="bl-state" style="color:#c00"><i class="fas fa-times-circle"></i><p>Network error</p></div>`;
    }
  }

  // ── Bill HTML builder ─────────────────────────────────────────────────────────
  // Corrected GST rates + Karnataka place of supply + SAC 9963
  function buildBillHTML(b) {
    const days     = b.days_stayed || calcDays(b.checkin_time, b.checkout_time);
    const rate     = b.room_price_per_night || b.room_rent || 0;
    const { base, cgst, sgst, total: roomTotal, cgstRate, sgstRate } = gstAmounts(rate, days);
    const svcTotal  = b.services_total || 0;
    const discounts = b.discounts || 0;
    const grandTotal = roomTotal + svcTotal - discounts;
    const cashPaid    = b.payment_cash   || 0;
    const onlinePaid  = b.payment_online || 0;
    const refunds     = b.refunds        || 0;
    const refundCash  = b.refund_cash    || 0;
    const refundOnline= b.refund_online  || 0;
    const totalPaid   = cashPaid + onlinePaid;
    const netCollected= totalPaid - refunds;
    const balance     = b.balance || 0;

    let svcRows = "";
    if (b.services && b.services.length) {
      svcRows = b.services.map(s => `
        <tr>
          <td>${s.item}</td><td class="b-tr">${s.quantity || 1}</td>
          <td class="b-tr">${fix2(s.unit_price || s.price || 0)}</td>
          <td class="b-tr">${fix2(s.price || 0)}</td>
        </tr>`).join("");
    } else if (svcTotal > 0) {
      svcRows = `<tr><td>Services</td><td class="b-tr">—</td><td class="b-tr">—</td><td class="b-tr">${fix2(svcTotal)}</td></tr>`;
    }

    const billDate = fmtBillDT(b.checkout_time);

    const displayBillNo = b.bill_number || "N/A";

    // GST rows: show rate or "Exempt" label
    const gstRows = cgstRate > 0
      ? `<tr><td style="padding-left:.7rem">CGST @ ${cgstRate}%</td><td class="b-tr">-</td><td class="b-tr">-</td><td class="b-tr">${fix2(cgst)}</td></tr>
         <tr><td style="padding-left:.7rem">SGST @ ${sgstRate}%</td><td class="b-tr">-</td><td class="b-tr">-</td><td class="b-tr">${fix2(sgst)}</td></tr>`
      : `<tr><td style="padding-left:.7rem;color:#888;">GST — Exempt (tariff &lt; ₹1,000/night)</td><td class="b-tr">-</td><td class="b-tr">-</td><td class="b-tr">0.00</td></tr>`;

    return `
<div class="b-lodge-name">CIBARA COMFORTS</div>
<div class="b-lodge-sub">Opposite Bus Stand Road, Harihar, Karnataka – 577601</div>
<div class="b-lodge-sub">Phone: +91 9482831381 &nbsp;|&nbsp; GSTIN: 29AAWFC1962B1Z9 &nbsp;|&nbsp; SAC: 9963</div>
<div class="b-title">TAX INVOICE</div>

<div class="b-info-grid">
  <div>
    <div class="b-row"><span class="b-lbl">Bill No:</span><span style="font-family:monospace;">${displayBillNo}</span></div>
    <div class="b-row"><span class="b-lbl">Guest Name:</span><span>${b.guest_name}</span></div>
    <div class="b-row"><span class="b-lbl">Mobile:</span><span>${b.guest_mobile || "N/A"}</span></div>
    <div class="b-row"><span class="b-lbl">Room No:</span><span>${b.room}</span></div>
  </div>
  <div>
    <div class="b-row"><span class="b-lbl">Check-in:</span><span>${fmtBillDT(b.checkin_time)}</span></div>
    <div class="b-row"><span class="b-lbl">Check-out:</span><span>${fmtBillDT(b.checkout_time)}</span></div>
    <div class="b-row"><span class="b-lbl">Days Stayed:</span><span>${days}</span></div>
    <div class="b-row"><span class="b-lbl">Bill Date:</span><span>${billDate}</span></div>
    <div class="b-row"><span class="b-lbl">Place of Supply:</span><span>Karnataka (KA – 29)</span></div>
  </div>
</div>

<table class="b-tbl">
  <thead>
    <tr><th>Description</th><th class="b-tr">Qty</th><th class="b-tr">Rate (₹)</th><th class="b-tr">Amount (₹)</th></tr>
  </thead>
  <tbody>
    <tr class="b-sec"><td colspan="4">Room Charges &nbsp;<span style="font-weight:400;font-size:.7rem;">(SAC: 9963)</span></td></tr>
    <tr>
      <td>Room Rent — Base Amount (excl. GST)</td>
      <td class="b-tr">${days}</td>
      <td class="b-tr">${fix2(rate)}</td>
      <td class="b-tr">${fix2(base)}</td>
    </tr>
    ${gstRows}
    <tr style="font-weight:700;">
      <td colspan="3" class="b-tr">Total Room Charges (incl. GST):</td>
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
      <tr><td>Online / UPI Paid</td><td class="b-tr">${fix2(onlinePaid)}</td></tr>
      <tr style="font-weight:700;"><td>Total Paid</td><td class="b-tr">${fix2(totalPaid)}</td></tr>
      ${refunds > 0 ? (() => {
        const rCashLbl   = refundCash   > 0 ? `<tr><td>Refund Given (Cash)</td><td class="b-tr">- ${fix2(refundCash)}</td></tr>` : "";
        const rOnlineLbl = refundOnline > 0 ? `<tr><td>Refund Given (UPI)</td><td class="b-tr">- ${fix2(refundOnline)}</td></tr>` : "";
        const fallback   = (!refundCash && !refundOnline) ? `<tr><td>Refund Given</td><td class="b-tr">- ${fix2(refunds)}</td></tr>` : "";
        return rCashLbl + rOnlineLbl + fallback + `<tr style="font-weight:700;"><td>Net Collected</td><td class="b-tr">${fix2(netCollected)}</td></tr>`;
      })() : ""}
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

  // ── Export — CA-ready GST report ─────────────────────────────────────────────
  function exportToExcel() {
    if (!state.filteredEntries.length) { alert("No invoiced bills to export."); return; }
    if (typeof XLSX === "undefined") { alert("Excel library not loaded. Refresh and retry."); return; }

    const rows = state.filteredEntries.map((e, i) => {
      const days = typeof e.days_stayed === "number" ? e.days_stayed : calcDays(e.checkin_time, e.checkout_time);
      const rate = e.room_rent || 0;
      const { base, cgst, sgst, cgstRate } = gstAmounts(rate, days);
      const gstRatePct = cgstRate * 2;  // total GST %
      return {
        "Sr No"              : e.serial_number || i + 1,
        "Bill No"            : e.bill_number || "-",
        "Guest Name"         : e.guest_name || "-",
        "Contact"            : e.guest_mobile || "-",
        "Room"               : e.room || "-",
        "Check-in"           : fmtDT(e.checkin_time),
        "Check-out"          : e.checkout_time ? fmtDT(e.checkout_time) : "-",
        "Days"               : days,
        "Room Rate/Night"    : rate,
        "Base Amt (excl GST)": +base.toFixed(2),
        "GST Rate %"         : gstRatePct,
        "CGST Amount"        : +cgst.toFixed(2),
        "SGST Amount"        : +sgst.toFixed(2),
        "Total GST"          : +(cgst + sgst).toFixed(2),
        "Room Charges (incl GST)": rate * days,
        "Services"           : e.services_total || 0,
        "Grand Total"        : e.total_amount || 0,
        "Cash Paid"          : e.payment_cash || 0,
        "Online/UPI Paid"    : e.payment_online || 0,
        "Refund"             : e.refunds || 0,
        "Balance Due"        : e.balance || 0,
        "Booking Source"     : e.booking_source || "normal",
        "Place of Supply"    : "Karnataka (KA-29)",
        "SAC Code"           : "9963",
      };
    });

    try {
      const ws = XLSX.utils.json_to_sheet(rows);
      ws["!cols"] = [
        {wch:6},{wch:20},{wch:22},{wch:14},
        {wch:6},{wch:20},{wch:20},{wch:5},{wch:14},
        {wch:20},{wch:10},{wch:13},{wch:13},{wch:12},
        {wch:20},{wch:10},{wch:13},{wch:10},{wch:14},
        {wch:12},{wch:16},{wch:18},{wch:10},
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "CA_Invoice_Report");
      XLSX.writeFile(wb, `CA_Bills_${state.dateRange.start}_to_${state.dateRange.end}.xlsx`);
    } catch (err) {
      console.error("[Bills] export error:", err);
      alert("Export failed: " + err.message);
    }
  }

  // ── Tab watch ─────────────────────────────────────────────────────────────────
  function watchTab() {
    const tab = dom("bills-tab");
    if (!tab) return;
    new MutationObserver(() => {
      if (!tab.classList.contains("hidden") && !state.loading) {
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
