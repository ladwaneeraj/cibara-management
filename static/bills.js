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
  width: 28px; height: 28px; padding: 0;
  background: var(--primary, #3f51b5);
  color: #fff; border: none; border-radius: 6px;
  cursor: pointer; font-size: 0.8rem;
  display: inline-flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.bl-bill-btn:hover { opacity: 0.82; }

/* Pending settlement row */
.bl-row-pending { background: #fffbf0; }
.bl-row-pending:hover { background: #fff8e1; }
.bl-pending-badge {
  display: inline-block; margin-left: 0.35rem;
  padding: 0.1rem 0.35rem; border-radius: 8px;
  font-size: 0.63rem; font-weight: 700;
  background: #fff3cd; color: #856404;
  vertical-align: middle; text-transform: uppercase;
}
.bl-collect-btn {
  width: 28px; height: 28px; padding: 0;
  background: #fd7e14;
  color: #fff; border: none; border-radius: 6px;
  cursor: pointer; font-size: 0.8rem;
  display: inline-flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.bl-collect-btn:hover { opacity: 0.82; }

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

/* ── Pay modal ── */
.bl-pay-modal-backdrop {
  display: none; position: fixed; inset: 0;
  background: rgba(0,0,0,.45); z-index: 9999;
  align-items: center; justify-content: center;
}
.bl-pay-modal-backdrop.bl-pay-open { display: flex; }
.bl-pay-modal {
  background: #fff; border-radius: 14px;
  padding: 1.6rem 1.5rem; width: 340px; max-width: 94vw;
  box-shadow: 0 8px 32px rgba(0,0,0,.18);
  animation: bl-modal-in .18s ease;
}
@keyframes bl-modal-in { from { transform: scale(.92); opacity: 0; } to { transform: scale(1); opacity: 1; } }
.bl-pay-modal-title {
  font-size: 1rem; font-weight: 700; color: var(--primary,#3f51b5);
  margin-bottom: 1rem; display: flex; align-items: center; gap: .45rem;
}
.bl-pay-modal-info {
  background: #f4f6fb; border-radius: 8px;
  padding: .65rem .85rem; margin-bottom: 1rem; font-size: .82rem;
}
.bl-pay-modal-info .bl-pi-row {
  display: flex; justify-content: space-between; gap: .5rem;
  padding: .18rem 0;
}
.bl-pi-label { color: #888; }
.bl-pi-val   { font-weight: 700; color: #333; }
.bl-pi-val.due { color: #fd7e14; font-size: .95rem; }
.bl-pay-modal label {
  font-size: .78rem; font-weight: 600; color: #555;
  display: block; margin-bottom: .3rem; margin-top: .8rem;
}
.bl-pay-modal input[type=number] {
  width: 100%; padding: .5rem .65rem; border: 1px solid #d0d0d0;
  border-radius: 7px; font-size: .9rem; outline: none;
  transition: border-color .15s; box-sizing: border-box;
}
.bl-pay-modal input[type=number]:focus { border-color: var(--primary,#3f51b5); }
.bl-pm-toggle { display: flex; gap: .5rem; margin-top: .75rem; }
.bl-pm-btn {
  flex: 1; padding: .45rem; border-radius: 8px; border: 2px solid #e0e0e0;
  background: #fff; cursor: pointer; font-size: .8rem; font-weight: 700;
  color: #777; transition: all .15s; display: flex; align-items: center;
  justify-content: center; gap: .3rem;
}
.bl-pm-btn.bl-pm-active-cash  { border-color: #28a745; background: #e8f5e9; color: #28a745; }
.bl-pm-btn.bl-pm-active-online{ border-color: #1565c0; background: #e3f2fd; color: #1565c0; }
.bl-pm-net-row {
  display: flex; justify-content: space-between; align-items: center;
  background: #e8f5e9; border-radius: 7px; padding: .35rem .65rem;
  margin-top: .35rem; margin-bottom: .5rem;
}
.bl-pm-net-label { color: #2e7d32; font-size: .78rem; font-weight: 600; }
.bl-pm-net-val   { color: #2e7d32; font-size: .95rem; font-weight: 700; }
.bl-pay-modal-actions {
  display: flex; gap: .6rem; margin-top: 1.1rem;
}
.bl-pay-cancel-btn {
  flex: 1; padding: .55rem; border: 1px solid #d0d0d0;
  border-radius: 8px; background: #fff; cursor: pointer;
  font-size: .85rem; font-weight: 600; color: #666;
}
.bl-pay-confirm-btn {
  flex: 2; padding: .55rem; border: none;
  border-radius: 8px; background: #fd7e14; color: #fff;
  cursor: pointer; font-size: .85rem; font-weight: 700;
  transition: opacity .15s;
}
.bl-pay-confirm-btn:hover { opacity: .88; }
.bl-pay-confirm-btn:disabled { opacity: .5; cursor: not-allowed; }
.bl-pay-error { color: #dc3545; font-size: .75rem; margin-top: .4rem; min-height: 1rem; }

/* ── PDF generation overlay ── */
#bl-pdf-gen-overlay {
  display: none; position: fixed; inset: 0;
  background: #000; z-index: 100001;
  align-items: center; justify-content: center;
  flex-direction: column; gap: 1.2rem;
}
#bl-pdf-gen-overlay.active { display: flex; }
.bl-pdf-spinner {
  width: 56px; height: 56px;
  border: 5px solid rgba(255,255,255,.25);
  border-top-color: #fff;
  border-radius: 50%;
  animation: bl-spin 0.85s linear infinite;
}
@keyframes bl-spin { to { transform: rotate(360deg); } }
.bl-pdf-overlay-text {
  color: #fff; font-size: 1rem; font-weight: 600;
  letter-spacing: .03em; text-align: center; line-height: 1.5;
}
.bl-pdf-overlay-sub {
  color: rgba(255,255,255,.65); font-size: .78rem; margin-top: -.6rem;
}

/* ── WhatsApp action button (in table rows) ── */
.bl-wa-btn {
  width: 28px; height: 28px; border: none;
  border-radius: 6px; cursor: pointer;
  display: inline-flex; align-items: center;
  justify-content: center; font-size: 0.82rem;
  transition: opacity 0.15s;
  background: #25D366; color: #fff; flex-shrink: 0;
}
.bl-wa-btn:hover { opacity: 0.78; }
.bl-wa-btn.bl-wa-pending { background: #c8e6c9; color: #388e3c; cursor: pointer; }
.bl-wa-btn.bl-wa-loading { background: #e0e0e0; color: #9e9e9e; cursor: wait; }

/* ── WhatsApp send modal ── */
.bl-wa-backdrop {
  display: none; position: fixed; inset: 0;
  background: rgba(0,0,0,.45); z-index: 10000;
  align-items: center; justify-content: center;
}
.bl-wa-backdrop.bl-wa-open { display: flex; }
.bl-wa-modal {
  background: #fff; border-radius: 14px;
  padding: 1.5rem 1.4rem; width: 390px; max-width: 94vw;
  box-shadow: 0 8px 32px rgba(0,0,0,.2);
  animation: bl-modal-in .18s ease;
}
.bl-wa-modal-title {
  font-size: 1rem; font-weight: 700; color: #128C7E;
  margin-bottom: 1rem; display: flex; align-items: center; gap: .45rem;
}
.bl-wa-msg-preview {
  background: #e8f5e9; border-radius: 10px;
  padding: .7rem .9rem; font-size: .78rem; line-height: 1.55;
  color: #333; margin-bottom: 1rem; border: 1px solid #c8e6c9;
  white-space: pre-wrap; word-break: break-word;
}
.bl-wa-section-label {
  font-size: .73rem; font-weight: 700; color: #555;
  text-transform: uppercase; letter-spacing: .04em; margin-bottom: .4rem;
}
.bl-wa-options { display: flex; flex-direction: column; gap: .4rem; margin-bottom: .8rem; }
.bl-wa-option {
  display: flex; align-items: center; gap: .6rem;
  padding: .45rem .7rem; border-radius: 8px; cursor: pointer;
  border: 1.5px solid #e0e0e0; font-size: .82rem;
  transition: border-color .15s, background .15s;
}
.bl-wa-option.selected { border-color: #25D366; background: #f1fff4; }
.bl-wa-option input[type=radio] { accent-color: #25D366; margin: 0; flex-shrink: 0; }
.bl-wa-custom-wrap { margin-bottom: .5rem; }
.bl-wa-custom-input {
  width: 100%; padding: .45rem .65rem;
  border: 1.5px solid #d0d0d0; border-radius: 7px;
  font-size: .9rem; outline: none; box-sizing: border-box;
  transition: border-color .15s;
}
.bl-wa-custom-input:focus { border-color: #25D366; }
.bl-wa-custom-input.input-error { border-color: #dc3545; }
.bl-wa-error { color: #dc3545; font-size: .73rem; min-height: 1rem; margin-bottom: .3rem; }
.bl-wa-actions { display: flex; gap: .6rem; margin-top: .6rem; }
.bl-wa-cancel-btn {
  flex: 1; padding: .5rem; border: 1px solid #d0d0d0;
  border-radius: 8px; background: #fff; cursor: pointer;
  font-size: .85rem; font-weight: 600; color: #666;
}
.bl-wa-send-btn {
  flex: 2; padding: .5rem; border: none;
  border-radius: 8px; background: #25D366; color: #fff;
  cursor: pointer; font-size: .85rem; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
  gap: .4rem; transition: opacity .15s;
}
.bl-wa-send-btn:hover { opacity: .88; }

/* ── Bill modal "Save & Share" button — matches action-btn sizing in flex context ── */
.bl-bill-save-btn {
  /* Same visual weight as action-btn in .bill-actions flex container */
  width: 100%; padding: 1rem; margin-top: 1rem;
  border: none; border-radius: var(--border-radius, 8px);
  background: #128C7E; color: #fff; font-size: .9rem;
  font-weight: 600; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  gap: .45rem; transition: opacity .15s; white-space: nowrap;
}
.bl-bill-save-btn:hover { opacity: .85; }
.bl-bill-save-btn:disabled { opacity: .5; cursor: wait; }
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
    filters: { search: "", source: "all", payment: "all" },
    lastLoadedRange: null,
    sort: { key: null, dir: "asc" },
    // Pay modal state
    payModal: {
      billId: null,
      billNumber: null,
      guestName: null,
      balance: 0,
      mode: "cash",
    },
    // WhatsApp modal state
    waModal: {
      billId: null,
      pdfUrl: null,
      guestName: null,
      guestMobile: null,
      invoiceNo: null,
      amount: 0,
      numberMode: "registered", // "registered" | "custom"
    },
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

  // Parse the sequential number out of bill numbers like "CC/2026/03/00091" → 91
  // Always take the last segment since the format can vary in number of parts.
  function parseBillNo(bn) {
    if (!bn) return 0;
    const parts = bn.split("/");
    return parseInt(parts[parts.length - 1], 10) || 0;
  }
  function fmtDate(s) {
    const [y, m, d] = s.split("-");
    return `${parseInt(d)} ${MONTHS[parseInt(m) - 1]} ${y}`;
  }
  function fmtDT(dtStr) {
    if (!dtStr) return "-";
    const [dp, tp = ""] = dtStr.split(" ");
    return `${fmtDate(dp)}${tp ? " " + tp : ""}`;
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

  // ── GST rates per 55th GST Council (effective 22 Sep 2025), SAC 9963 ─────────
  // < ₹1,000/night  → Exempt (0%)
  // ₹1,000–₹7,500   → 5%  (CGST 2.5% + SGST 2.5%) — no ITC
  // > ₹7,500/night  → 18% (CGST 9%   + SGST 9%)   — ITC available
  function gstAmounts(ratePerNight, days) {
    const total = (ratePerNight || 0) * (days || 1);
    if (ratePerNight > 7500) {
      const base = total / 1.18;
      const gst = total - base;
      return {
        base,
        cgst: gst / 2,
        sgst: gst / 2,
        total,
        cgstRate: 9,
        sgstRate: 9,
      };
    } else if (ratePerNight >= 1000) {
      const base = total / 1.05;
      const gst = total - base;
      return {
        base,
        cgst: gst / 2,
        sgst: gst / 2,
        total,
        cgstRate: 2.5,
        sgstRate: 2.5,
      };
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
    <div class="bl-card" style="border-left:3px solid #fd7e14;">
      <div class="bl-label">Pending Due</div>
      <div class="bl-value" id="bl-tc-pending" style="color:#fd7e14;">0</div>
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
    <select id="bl-payment-filter">
      <option value="all">All Payments</option>
      <option value="cash">Cash Only</option>
      <option value="online">Online Only</option>
      <option value="split">Split</option>
      <option value="pending">Pending Balance</option>
    </select>
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

<!-- Pay Modal — collect outstanding balance directly from Bills tab -->
<div class="bl-pay-modal-backdrop" id="bl-pay-modal-backdrop">
  <div class="bl-pay-modal">
    <div class="bl-pay-modal-title">
      <i class="fas fa-hand-holding-usd"></i> Collect Payment
    </div>
    <div class="bl-pay-modal-info">
      <div class="bl-pi-row">
        <span class="bl-pi-label">Guest</span>
        <span class="bl-pi-val" id="bl-pm-guest">—</span>
      </div>
      <div class="bl-pi-row">
        <span class="bl-pi-label">Bill No</span>
        <span class="bl-pi-val" id="bl-pm-billno">—</span>
      </div>
      <div class="bl-pi-row">
        <span class="bl-pi-label">Amount Due</span>
        <span class="bl-pi-val due" id="bl-pm-due">₹0</span>
      </div>
    </div>

    <label for="bl-pm-discount">Discount (₹) <span style="color:#aaa;font-weight:400;font-size:.72rem;">— optional</span></label>
    <input type="number" id="bl-pm-discount" placeholder="0" min="0" value="0" />

    <div class="bl-pm-net-row" id="bl-pm-net-row">
      <span class="bl-pm-net-label">Net Payable</span>
      <span class="bl-pm-net-val" id="bl-pm-net">₹0</span>
    </div>

    <label for="bl-pm-amount">Payment Amount (₹)</label>
    <input type="number" id="bl-pm-amount" placeholder="Enter amount" min="0" />

    <label>Payment Method</label>
    <div class="bl-pm-toggle">
      <button class="bl-pm-btn bl-pm-active-cash" id="bl-pm-cash-btn">
        <i class="fas fa-money-bill"></i> Cash
      </button>
      <button class="bl-pm-btn" id="bl-pm-online-btn">
        <i class="fas fa-mobile-alt"></i> Online
      </button>
    </div>

    <div class="bl-pay-error" id="bl-pm-error"></div>

    <div class="bl-pay-modal-actions">
      <button class="bl-pay-cancel-btn" id="bl-pm-cancel">Cancel</button>
      <button class="bl-pay-confirm-btn" id="bl-pm-confirm">
        <i class="fas fa-check"></i> Confirm Payment
      </button>
    </div>
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
      <button class="bl-bill-save-btn" id="bl-bill-save-pdf" title="Save PDF to cloud &amp; share on WhatsApp">
        <i class="fab fa-whatsapp"></i> Save &amp; Share
      </button>
      <button class="action-btn btn-primary" id="bl-bill-print">
        <i class="fas fa-print"></i> Print
      </button>
    </div>
  </div>
</div>

<!-- PDF Generation Overlay -->
<div id="bl-pdf-gen-overlay">
  <div class="bl-pdf-spinner"></div>
  <div class="bl-pdf-overlay-text" id="bl-pdf-overlay-text">Generating PDF…</div>
  <div class="bl-pdf-overlay-sub">Please wait, this takes a few seconds</div>
</div>

<!-- WhatsApp Send Modal -->
<div class="bl-wa-backdrop" id="bl-wa-backdrop">
  <div class="bl-wa-modal">
    <div class="bl-wa-modal-title">
      <i class="fab fa-whatsapp" style="font-size:1.2rem;"></i> Send Invoice via WhatsApp
    </div>

    <div class="bl-wa-section-label">Message Preview</div>
    <div class="bl-wa-msg-preview" id="bl-wa-preview"></div>

    <div class="bl-wa-section-label">Send To</div>
    <div class="bl-wa-options">
      <label class="bl-wa-option selected" id="bl-wa-opt-registered">
        <input type="radio" name="bl-wa-num" value="registered" checked />
        <span id="bl-wa-registered-label">Guest number</span>
      </label>
      <label class="bl-wa-option" id="bl-wa-opt-custom">
        <input type="radio" name="bl-wa-num" value="custom" />
        <span>Enter different number</span>
      </label>
    </div>

    <div class="bl-wa-custom-wrap" id="bl-wa-custom-wrap" style="display:none;">
      <input type="tel" class="bl-wa-custom-input" id="bl-wa-custom-number"
             placeholder="10-digit mobile number" maxlength="10" inputmode="numeric" />
    </div>

    <div class="bl-wa-error" id="bl-wa-error"></div>

    <div class="bl-wa-actions">
      <button class="bl-wa-cancel-btn" id="bl-wa-cancel">Cancel</button>
      <button class="bl-wa-send-btn" id="bl-wa-send">
        <i class="fab fa-whatsapp"></i> Send via WhatsApp
      </button>
    </div>
  </div>
</div>`;
  }

  // ── Date helpers ──────────────────────────────────────────────────────────────
  function dateToYMD(d) {
    return (
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0")
    );
  }

  // ── Date defaults + flatpickr init ────────────────────────────────────────────
  function setDefaults() {
    const today = todayStr(),
      week = nDaysAgoStr(6);
    state.dateRange.start = week;
    state.dateRange.end = today;

    const el = dom("bl-date-range");
    if (!el || !window.flatpickr) return;

    state._datePicker = flatpickr(el, {
      mode: "range",
      dateFormat: "Y-m-d", // internal ISO format — avoids maxDate mis-parsing
      altInput: true, // show human-friendly text to user
      altFormat: "d M Y", // display: "17 Mar 2026"
      defaultDate: [week, today],
      maxDate: today,
      disableMobile: true,
      onChange: function (selectedDates) {
        if (selectedDates.length === 2) {
          state.dateRange.start = dateToYMD(selectedDates[0]);
          state.dateRange.end = dateToYMD(selectedDates[1]);
          document
            .querySelectorAll(".bl-quick-btn")
            .forEach((b) => b.classList.remove("bq-active"));
          loadData(true);
        }
      },
    });
  }

  // ── Events ────────────────────────────────────────────────────────────────────
  function wireEvents() {
    // Quick-range buttons
    document.querySelectorAll(".bl-quick-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const range = btn.dataset.bq;
        const today = todayStr();
        let start;
        if (range === "today") start = today;
        else if (range === "week") start = nDaysAgoStr(6);
        else if (range === "month") start = nDaysAgoStr(29);
        else start = today;
        state.dateRange.start = start;
        state.dateRange.end = today;
        if (state._datePicker) state._datePicker.setDate([start, today]);
        document
          .querySelectorAll(".bl-quick-btn")
          .forEach((b) => b.classList.remove("bq-active"));
        btn.classList.add("bq-active");
        loadData(true);
      });
    });

    const srcf = dom("bl-source-filter");
    const payf = dom("bl-payment-filter");
    const sr = dom("bl-search");

    if (srcf)
      srcf.addEventListener("change", () => {
        state.filters.source = srcf.value;
        applyFilters();
      });
    if (payf)
      payf.addEventListener("change", () => {
        state.filters.payment = payf.value;
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

    // ── Pay modal wiring ──────────────────────────────────────────────────────
    const pmCancel = dom("bl-pm-cancel");
    const pmConfirm = dom("bl-pm-confirm");
    const pmCash = dom("bl-pm-cash-btn");
    const pmOnline = dom("bl-pm-online-btn");
    const pmBackdrop = dom("bl-pay-modal-backdrop");

    if (pmCancel) pmCancel.addEventListener("click", closePayModal);
    if (pmBackdrop)
      pmBackdrop.addEventListener("click", (e) => {
        if (e.target === pmBackdrop) closePayModal();
      });
    if (pmCash)
      pmCash.addEventListener("click", () => {
        state.payModal.mode = "cash";
        pmCash.className = "bl-pm-btn bl-pm-active-cash";
        pmOnline.className = "bl-pm-btn";
      });
    if (pmOnline)
      pmOnline.addEventListener("click", () => {
        state.payModal.mode = "online";
        pmOnline.className = "bl-pm-btn bl-pm-active-online";
        pmCash.className = "bl-pm-btn";
      });
    if (pmConfirm) pmConfirm.addEventListener("click", collectBillPayment);

    const rb = dom("bl-refresh-btn"),
      xb = dom("bl-export-btn");
    if (rb) rb.addEventListener("click", () => loadData(true));
    if (xb) xb.addEventListener("click", exportToExcel);

    // Bill modal controls
    const bc = dom("bl-bill-close");
    const bc2 = dom("bl-bill-close2");
    const bp = dom("bl-bill-print");
    const bm = dom("bl-bill-modal");
    if (bc) bc.addEventListener("click", closeBill);
    if (bc2) bc2.addEventListener("click", closeBill);
    if (bp)
      bp.addEventListener("click", function () {
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
        try {
          window.print();
        } finally {
          document.body.classList.remove("bl-printing");
          clone.remove();
        }
      });
    if (bm)
      bm.addEventListener("click", (e) => {
        if (e.target === bm) closeBill();
      });

    // ── "Save & Share" button in bill modal ───────────────────────────────────
    const bSave = dom("bl-bill-save-pdf");
    if (bSave) {
      bSave.addEventListener("click", async function () {
        if (!_openBillId || !_openBillData) return;
        bSave.disabled = true;
        bSave.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving PDF…';
        try {
          // Check if a PDF already exists (don't re-upload unnecessarily)
          const existingEntry = state.allEntries.find(
            (x) => x.id === _openBillId,
          );
          let pdfUrl = existingEntry?.pdf_url || null;

          if (!pdfUrl) {
            pdfUrl = await generateAndUploadPDF(_openBillId, _openBillData);
          }

          if (pdfUrl) {
            // Build synthetic entry for the WhatsApp modal
            const entry = {
              ...(existingEntry || {}),
              id: _openBillId,
              pdf_url: pdfUrl,
              guest_name: _openBillData.guest_name,
              guest_mobile: _openBillData.guest_mobile,
              invoice_number: _openBillData.invoice_number,
              bill_number: _openBillData.bill_number,
              total_amount: _openBillData.total_amount,
            };
            closeBill();
            openWhatsAppModal(entry);
          }
        } finally {
          bSave.disabled = false;
          bSave.innerHTML = '<i class="fab fa-whatsapp"></i> Save &amp; Share';
        }
      });
    }

    // Delegated clicks: bill view + collect settlement + group toggle + WhatsApp
    const tbody = dom("bl-table-body");
    if (tbody) {
      tbody.addEventListener("click", async (e) => {
        const billBtn = e.target.closest(".bl-bill-btn");
        if (billBtn) {
          e.stopPropagation();
          openBill(billBtn.dataset.id);
          return;
        }

        // Pending balance — open Bills tab pay modal directly
        const collectBtn = e.target.closest(".bl-collect-btn");
        if (collectBtn) {
          e.stopPropagation();
          openPayModal(
            collectBtn.dataset.id,
            collectBtn.dataset.billno,
            collectBtn.dataset.guest,
            parseInt(collectBtn.dataset.balance, 10) || 0,
          );
          return;
        }

        // WhatsApp share button
        const waBtn = e.target.closest(".bl-wa-btn");
        if (waBtn) {
          e.stopPropagation();
          const billId = waBtn.dataset.id;
          const pdfUrl = waBtn.dataset.pdfurl;
          const entry = state.allEntries.find((x) => x.id === billId);
          if (!entry) return;

          if (pdfUrl) {
            // PDF already saved — open modal directly
            openWhatsAppModal(entry);
          } else {
            // No PDF yet — generate + upload first, then open modal
            if (
              !confirm(
                "No PDF saved yet.\n\nGenerate and save a PDF now, then open WhatsApp?\n(This may take a few seconds)",
              )
            )
              return;

            waBtn.classList.add("bl-wa-loading");
            waBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

            // Fetch bill data from backend to generate PDF
            try {
              const res = await apiFetch(`/generate_bill/${billId}`);
              const data = await res.json();
              if (!data.success) {
                alert("Could not load bill data.");
                return;
              }

              const url = await generateAndUploadPDF(billId, data.bill);
              if (url) {
                entry.pdf_url = url;
                renderTable(); // re-render so btn turns green
                openWhatsAppModal(entry);
              }
            } catch (err) {
              console.error("[Bills] WA btn generate error:", err);
              alert("Error generating PDF: " + err.message);
            } finally {
              waBtn.classList.remove("bl-wa-loading");
              waBtn.innerHTML = '<i class="fab fa-whatsapp"></i>';
            }
          }
          return;
        }

        const hdr = e.target.closest(".bl-date-header");
        if (hdr) toggleGroup(hdr);
      });
    }

    // ── WhatsApp modal wiring ─────────────────────────────────────────────────
    const waCancel = dom("bl-wa-cancel");
    const waSend = dom("bl-wa-send");
    const waBackdrop = dom("bl-wa-backdrop");
    const waOptReg = dom("bl-wa-opt-registered");
    const waOptCus = dom("bl-wa-opt-custom");
    const waCustomWrap = dom("bl-wa-custom-wrap");

    if (waCancel) waCancel.addEventListener("click", closeWhatsAppModal);
    if (waSend) waSend.addEventListener("click", sendWhatsApp);
    if (waBackdrop)
      waBackdrop.addEventListener("click", (e) => {
        if (e.target === waBackdrop) closeWhatsAppModal();
      });

    if (waOptReg)
      waOptReg.addEventListener("click", () => {
        state.waModal.numberMode = "registered";
        waOptReg.classList.add("selected");
        if (waOptCus) waOptCus.classList.remove("selected");
        if (waCustomWrap) waCustomWrap.style.display = "none";
        const errEl = dom("bl-wa-error");
        if (errEl) errEl.textContent = "";
      });
    if (waOptCus)
      waOptCus.addEventListener("click", () => {
        state.waModal.numberMode = "custom";
        waOptCus.classList.add("selected");
        if (waOptReg) waOptReg.classList.remove("selected");
        if (waCustomWrap) waCustomWrap.style.display = "block";
        const inp = dom("bl-wa-custom-number");
        if (inp) inp.focus();
        const errEl = dom("bl-wa-error");
        if (errEl) errEl.textContent = "";
      });

    _wireSortHeaders();
  }

  function _wireSortHeaders() {
    const btnDate = dom("bl-view-date");
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
    const btnDate = dom("bl-view-date");
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
    if (
      !force &&
      state.lastLoadedRange === rangeKey &&
      state.allEntries.length >= 0
    ) {
      applyFilters();
      return;
    }

    state.loading = true;
    showLoading();

    try {
      const res = await apiFetch("/get_register_data", {
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

  // ── Filters — completed + pending_settlement entries with a bill_number ──────
  function applyFilters() {
    // Include completed bills AND pending_settlement bills (settle-later checkouts).
    // bill_number presence is the canonical indicator that a bill was generated.
    let f = state.allEntries.filter(
      (e) =>
        (e.status === "completed" || e.status === "pending_settlement") &&
        e.bill_number &&
        e.bill_number !== "-" &&
        e.bill_number.trim() !== "",
    );

    const { search, source, payment } = state.filters;

    if (search)
      f = f.filter(
        (e) =>
          (e.guest_name || "").toLowerCase().includes(search) ||
          (e.guest_mobile || "").includes(search) ||
          String(e.room || "").includes(search) ||
          (e.bill_number || "").toLowerCase().includes(search),
      );

    // MMT OTA has no invoice so won't appear here; only normal + booking.com
    if (source !== "all")
      f = f.filter((e) => (e.booking_source || "normal") === source);

    // Payment method filter
    if (payment !== "all") {
      f = f.filter((e) => {
        const c = e.payment_cash || 0;
        const o = e.payment_online || 0;
        const b = e.balance || 0;
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
    }

    state.filteredEntries = f;
    renderTally(f);
    renderTable();
  }

  // ── Tally — computed from completed (paid) entries only ─────────────────────
  function renderTally(entries) {
    let cash = 0,
      upi = 0,
      pending = 0;
    for (const e of entries) {
      if ((e.balance || 0) > 0) {
        pending++;
        continue;
      }
      cash += e.payment_cash || 0;
      upi += e.payment_online || 0;
    }
    const revenue = cash + upi;
    const set = (id, val) => {
      const el = dom(id);
      if (el) el.textContent = "₹" + inr(val || 0);
    };
    set("bl-tc-cash", cash);
    set("bl-tc-upi", upi);
    set("bl-tc-rev", revenue);
    const countEl = dom("bl-tc-count");
    const pendingEl = dom("bl-tc-pending");
    if (countEl) countEl.textContent = entries.length;
    if (pendingEl) pendingEl.textContent = pending || "0";
  }

  // ── Pay Modal ─────────────────────────────────────────────────────────────────
  // Recomputes Net Payable and clamps payment amount whenever discount changes.
  function _updatePayModalNet() {
    const { balance } = state.payModal;
    const discountEl = dom("bl-pm-discount");
    const amtEl = dom("bl-pm-amount");
    const netValEl = dom("bl-pm-net");
    const discount = Math.max(0, parseInt(discountEl?.value || "0", 10) || 0);
    const clamped = Math.min(discount, balance); // can't exceed balance
    if (discountEl && clamped !== discount) discountEl.value = clamped;
    const net = balance - clamped;
    if (netValEl) netValEl.textContent = "₹" + inr(net);
    if (amtEl) {
      amtEl.value = net;
      amtEl.max = net;
    }
  }

  function openPayModal(billId, billNumber, guestName, balance) {
    state.payModal = { billId, billNumber, guestName, balance, mode: "cash" };

    const set = (id, val) => {
      const el = dom(id);
      if (el) el.textContent = val;
    };
    set("bl-pm-guest", guestName || "—");
    set("bl-pm-billno", billNumber || "—");
    set("bl-pm-due", "₹" + inr(balance));

    // Reset discount to 0 and recompute net / payment
    const discountEl = dom("bl-pm-discount");
    if (discountEl) {
      discountEl.value = 0;
      // Wire live update (attach once via replacing with clone to avoid duplicates)
      const fresh = discountEl.cloneNode(true);
      discountEl.parentNode.replaceChild(fresh, discountEl);
      fresh.addEventListener("input", _updatePayModalNet);
    }
    _updatePayModalNet();

    // Reset method buttons to Cash
    const cashBtn = dom("bl-pm-cash-btn");
    const onlineBtn = dom("bl-pm-online-btn");
    if (cashBtn) cashBtn.className = "bl-pm-btn bl-pm-active-cash";
    if (onlineBtn) onlineBtn.className = "bl-pm-btn";

    const errEl = dom("bl-pm-error");
    if (errEl) errEl.textContent = "";

    const confirmBtn = dom("bl-pm-confirm");
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = '<i class="fas fa-check"></i> Confirm Payment';
    }

    const backdrop = dom("bl-pay-modal-backdrop");
    if (backdrop) backdrop.classList.add("bl-pay-open");
  }

  function closePayModal() {
    const backdrop = dom("bl-pay-modal-backdrop");
    if (backdrop) backdrop.classList.remove("bl-pay-open");
  }

  async function collectBillPayment() {
    const { billId, balance, mode } = state.payModal;
    const amtEl = dom("bl-pm-amount");
    const discountEl = dom("bl-pm-discount");
    const errEl = dom("bl-pm-error");
    const confirmBtn = dom("bl-pm-confirm");
    const amount = parseInt(amtEl?.value || "0", 10) || 0;
    const discount = parseInt(discountEl?.value || "0", 10) || 0;

    if (errEl) errEl.textContent = "";

    if (discount < 0) {
      if (errEl) errEl.textContent = "Discount cannot be negative.";
      return;
    }
    if (discount > balance) {
      if (errEl)
        errEl.textContent = `Discount ₹${inr(discount)} exceeds balance ₹${inr(balance)}.`;
      return;
    }
    const net = balance - discount;
    if (amount < 0) {
      if (errEl) errEl.textContent = "Amount cannot be negative.";
      return;
    }
    if (amount > net) {
      if (errEl)
        errEl.textContent = `Payment ₹${inr(amount)} exceeds net payable ₹${inr(net)}.`;
      return;
    }
    if (discount === 0 && amount === 0) {
      if (errEl) errEl.textContent = "Enter a payment amount or discount.";
      return;
    }

    confirmBtn.disabled = true;
    confirmBtn.innerHTML = '<span style="opacity:.6">Processing…</span>';

    try {
      const res = await apiFetch("/add_bill_payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bill_id: billId,
          payment_mode: mode,
          amount,
          discount,
        }),
      });
      const data = await res.json();

      if (data.success) {
        closePayModal();
        if (window.showNotification) showNotification(data.message, "success");
        // Reload so row updates immediately
        loadData(true);
      } else {
        if (errEl) errEl.textContent = data.message || "Payment failed.";
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = '<i class="fas fa-check"></i> Confirm Payment';
      }
    } catch (err) {
      if (errEl) errEl.textContent = "Network error. Please try again.";
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = '<i class="fas fa-check"></i> Confirm Payment';
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // PDF GENERATION + UPLOAD
  // ══════════════════════════════════════════════════════════════════════════════

  // ── PDF overlay helpers ───────────────────────────────────────────────────────
  function showPdfOverlay(text) {
    const ov = dom("bl-pdf-gen-overlay");
    const tx = dom("bl-pdf-overlay-text");
    if (tx) tx.textContent = text || "Generating PDF…";
    if (ov) ov.classList.add("active");
  }
  function hidePdfOverlay() {
    const ov = dom("bl-pdf-gen-overlay");
    if (ov) ov.classList.remove("active");
  }
  function updatePdfOverlayText(text) {
    const tx = dom("bl-pdf-overlay-text");
    if (tx) tx.textContent = text;
  }

  /**
   * Generate bill PDF server-side (xhtml2pdf via Flask /render_bill_pdf).
   * Sends the bill HTML fragment to the server; server adds CSS, converts to
   * PDF bytes, uploads to Firebase Storage, and returns the download URL.
   * No html2canvas, no DOM tricks, no blank-page issues.
   */
  // silent=true → no overlay, no alert; used when auto-triggered after checkout.
  async function generateAndUploadPDF(billId, billData, silent = false) {
    const folderNo = billData.bill_number || billData.invoice_number || billId;

    if (!silent) showPdfOverlay("Generating invoice PDF…");

    try {
      if (!silent) updatePdfOverlayText("Converting to PDF…");

      const res = await apiFetch("/render_bill_pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bill_id: billId,
          invoice_no: folderNo,
          html_content: buildBillHTML(billData),
        }),
      });

      const data = await res.json();

      if (!data.success) {
        console.error("[Bills] render_bill_pdf failed:", data.message);
        if (!silent)
          alert("PDF generation failed: " + (data.message || "unknown error"));
        return "";
      }

      // Server may return skipped:true if PDF already existed — use that URL
      const pdfUrl = data.pdf_url;

      // Sync in-memory state so WhatsApp button turns dark green immediately
      const entry = state.allEntries.find((e) => e.id === billId);
      const fEntry = state.filteredEntries.find((e) => e.id === billId);
      if (entry) entry.pdf_url = pdfUrl;
      if (fEntry) fEntry.pdf_url = pdfUrl;
      renderTable();

      return pdfUrl;
    } catch (err) {
      console.error("[Bills] generateAndUploadPDF error:", err);
      if (!silent) alert("PDF generation failed: " + err.message);
      return "";
    } finally {
      if (!silent) hidePdfOverlay();
    }
  }

  // Expose globally so other modules (e.g. script.js after checkout) can trigger
  // PDF generation without coupling to the bills.js IIFE internals.
  window._cibaraBillsGeneratePDF = generateAndUploadPDF;

  /**
   * Auto-generate PDF after checkout — called from script.js with just the bill_id.
   * Fetches bill data from the backend, then generates + uploads the PDF silently.
   * Uses the same loading overlay so user sees a smooth animation.
   */
  window._cibaraBillsAutoGenerate = async function (billId) {
    if (!billId) return;
    try {
      const res = await apiFetch(`/generate_bill/${billId}`);
      const data = await res.json();
      if (!data.success || !data.bill) {
        console.warn("[Bills] auto-generate: could not fetch bill", billId);
        return;
      }
      // Skip generation if a PDF already exists — never create duplicate versions
      if (data.bill.pdf_url) {
        console.log(
          "[Bills] auto-generate: PDF already exists, skipping generation for",
          billId,
        );
        return;
      }
      // silent=true → no overlay, no alert; runs fully in background
      await generateAndUploadPDF(billId, data.bill, true);
    } catch (err) {
      console.error("[Bills] _cibaraBillsAutoGenerate error:", err);
      // Silent fail — don't alert, don't block checkout flow
    }
  };

  // ══════════════════════════════════════════════════════════════════════════════
  // WHATSAPP MODAL
  // ══════════════════════════════════════════════════════════════════════════════

  function _buildWaMessage(guestName, invoiceNo, amount, pdfUrl) {
    return `Hi ${guestName || "Guest"}, your invoice #${invoiceNo} for ₹${inr(amount)} from Cibara Comforts is ready.\n\nView / Download: ${pdfUrl}\n\nThank you for staying with us!`;
  }

  function _updateWaPreview() {
    const s = state.waModal;
    const preview = dom("bl-wa-preview");
    if (!preview) return;
    preview.textContent = _buildWaMessage(
      s.guestName,
      s.invoiceNo,
      s.amount,
      s.pdfUrl || "(PDF URL)",
    );
  }

  function openWhatsAppModal(entry) {
    const s = state.waModal;
    s.billId = entry.id;
    s.pdfUrl = entry.pdf_url || null;
    s.guestName = entry.guest_name || "Guest";
    s.guestMobile = entry.guest_mobile || "";
    s.invoiceNo = entry.bill_number || "";
    s.amount = entry.total_amount || 0;
    s.numberMode = "registered";

    // Update registered number label
    const regLabel = dom("bl-wa-registered-label");
    if (regLabel) {
      regLabel.textContent = s.guestMobile
        ? `Guest number: +91 ${s.guestMobile}`
        : "Guest number (not available)";
    }

    // Reset to registered option
    const optReg = dom("bl-wa-opt-registered");
    const optCus = dom("bl-wa-opt-custom");
    const customWrap = dom("bl-wa-custom-wrap");
    const customInp = dom("bl-wa-custom-number");
    const errEl = dom("bl-wa-error");
    if (optReg) {
      optReg.classList.add("selected");
      optReg.querySelector("input").checked = true;
    }
    if (optCus) {
      optCus.classList.remove("selected");
      optCus.querySelector("input").checked = false;
    }
    if (customWrap) customWrap.style.display = "none";
    if (customInp) {
      customInp.value = "";
      customInp.classList.remove("input-error");
    }
    if (errEl) errEl.textContent = "";

    _updateWaPreview();

    const backdrop = dom("bl-wa-backdrop");
    if (backdrop) backdrop.classList.add("bl-wa-open");
  }

  function closeWhatsAppModal() {
    const backdrop = dom("bl-wa-backdrop");
    if (backdrop) backdrop.classList.remove("bl-wa-open");
  }

  function sendWhatsApp() {
    const s = state.waModal;
    const errEl = dom("bl-wa-error");
    const customInp = dom("bl-wa-custom-number");
    if (errEl) errEl.textContent = "";
    if (customInp) customInp.classList.remove("input-error");

    if (!s.pdfUrl) {
      if (errEl)
        errEl.textContent =
          "No PDF URL found. Please save the PDF first using the bill modal.";
      return;
    }

    let targetMobile = "";

    if (s.numberMode === "registered") {
      if (!s.guestMobile) {
        if (errEl)
          errEl.textContent =
            "No registered mobile number found for this guest.";
        return;
      }
      // Normalise: strip leading country code, keep last 10 digits
      const digits = s.guestMobile.replace(/\D/g, "");
      targetMobile = digits.length >= 10 ? digits.slice(-10) : digits;
    } else {
      const raw = (customInp?.value || "").trim().replace(/\D/g, "");
      if (!/^\d{10}$/.test(raw)) {
        if (errEl)
          errEl.textContent =
            "Please enter a valid 10-digit Indian mobile number.";
        if (customInp) customInp.classList.add("input-error");
        return;
      }
      targetMobile = raw;
    }

    const message = _buildWaMessage(
      s.guestName,
      s.invoiceNo,
      s.amount,
      s.pdfUrl,
    );
    const encoded = encodeURIComponent(message);
    const waUrl = `https://wa.me/91${targetMobile}?text=${encoded}`;

    window.open(waUrl, "_blank", "noopener,noreferrer");
    closeWhatsAppModal();
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  function renderTable() {
    const tbody = dom("bl-table-body");
    if (!tbody) return;
    if (!state.filteredEntries.length) {
      showEmpty();
      return;
    }

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
        if (va > vb) return state.sort.dir === "asc" ? 1 : -1;
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
    let rowNum = 0; // sequential counter across all date groups
    Object.keys(byDate)
      .sort((a, b) => b.localeCompare(a))
      .forEach((dk) => {
        const entries = byDate[dk];
        const label = dk !== "unknown" ? fmtDate(dk) : "Unknown Date";
        html += `<tr class="bl-date-header" data-group="${dk}">
        <td colspan="13"><i class="fas fa-chevron-down"></i>${label}&nbsp;<span style="font-weight:400;opacity:.65;">(${entries.length})</span></td>
      </tr>`;
        entries.forEach((e) => {
          rowNum++;
          html += rowHTML(e, dk, rowNum);
        });
      });
    tbody.innerHTML = html;
  }

  function rowHTML(e, dk, rowIndex) {
    const days = e.days_stayed || calcDays(e.checkin_time, e.checkout_time);
    const isPending = e.status === "pending_settlement";

    const billNo = e.bill_number || "-";

    // GST summary cell
    const rate = e.room_rent || e.room_price_per_night || 0;
    const { cgst, sgst, cgstRate } = gstAmounts(rate, days);
    const gstTotal = cgst + sgst;
    const gstCell =
      gstTotal > 0
        ? `<span style="font-size:.73rem;">₹${inr(Math.round(gstTotal))}<br><span style="font-size:.65rem;color:#888;">${cgstRate * 2}% GST</span></span>`
        : `<span style="color:#aaa;font-size:.73rem;">Exempt</span>`;

    // Source badge
    const src = e.booking_source || "normal";
    const srcLabel = src === "booking.com" ? "Booking.com" : "Normal";
    const srcCls =
      src === "booking.com" ? "bl-src-bookingcom" : "bl-src-normal";
    const srcBadge = `<span class="bl-src-badge ${srcCls}">${srcLabel}</span>`;

    // Any bill with outstanding balance — new (pending_settlement) or old (completed but balance > 0)
    const hasBalance = (e.balance || 0) > 0;
    const rowCls =
      isPending || hasBalance ? "bl-date-row bl-row-pending" : "bl-date-row";
    const pendingBadge =
      isPending || hasBalance
        ? `<span class="bl-pending-badge">Pending</span>`
        : "";
    // Action cell: collect button if outstanding balance, else receipt
    const mainBtn =
      isPending || hasBalance
        ? `<button class="bl-collect-btn"
           data-id="${e.id}"
           data-billno="${e.bill_number || ""}"
           data-guest="${(e.guest_name || "").replace(/"/g, "&quot;")}"
           data-balance="${e.balance || 0}"
           title="Collect Payment">
           <i class="fas fa-hand-holding-usd"></i>
         </button>`
        : `<button class="bl-bill-btn" data-id="${e.id}" title="View/Print Bill"><i class="fas fa-receipt"></i></button>`;

    // WhatsApp share button — green if PDF already saved, light-green "generate first" if not
    const hasPdf = !!e.pdf_url;
    const waBtnCls = hasPdf ? "bl-wa-btn" : "bl-wa-btn bl-wa-pending";
    const waTitle = hasPdf
      ? "Send invoice via WhatsApp"
      : "Save PDF first, then share on WhatsApp";
    const waBtn = `<button class="${waBtnCls}"
      data-id="${e.id}"
      data-pdfurl="${(e.pdf_url || "").replace(/"/g, "&quot;")}"
      data-guest="${(e.guest_name || "").replace(/"/g, "&quot;")}"
      data-mobile="${(e.guest_mobile || "").replace(/"/g, "&quot;")}"
      data-invoiceno="${(e.bill_number || "").replace(/"/g, "&quot;")}"
      data-amount="${e.total_amount || 0}"
      title="${waTitle}">
      <i class="fab fa-whatsapp"></i>
    </button>`;

    const actionCell = `<div style="display:flex;gap:5px;align-items:center;flex-wrap:nowrap;justify-content:center;">${mainBtn}${waBtn}</div>`;

    return `<tr class="${rowCls}" data-date-group="${dk}">
      <td style="color:#888;font-size:.75rem;">${rowIndex}</td>
      <td style="font-size:.73rem;white-space:nowrap;font-family:monospace;">${billNo}${pendingBadge}</td>
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
      <td>${actionCell}</td>
    </tr>`;
  }

  function paymentHTML(e) {
    const c = e.payment_cash || 0,
      o = e.payment_online || 0,
      r = e.refunds || 0,
      b = e.balance || 0;
    if (!c && !o && !r && !b) return '<span style="color:#ccc;">—</span>';
    let h = '<div class="bl-pay-split">';
    if (c)
      h += `<div class="bl-pay-item"><span class="bl-pm-cash">Cash</span><span>₹${inr(c)}</span></div>`;
    if (o)
      h += `<div class="bl-pay-item"><span class="bl-pm-upi">Online</span><span>₹${inr(o)}</span></div>`;
    if (r > 0) {
      const rc = e.refund_cash || 0,
        ro = e.refund_online || 0;
      const rLabel =
        rc > 0 && ro > 0
          ? "Refund"
          : rc > 0
            ? "Refund (Cash)"
            : ro > 0
              ? "Refund (UPI)"
              : "Refund";
      h += `<div class="bl-pay-item"><span class="bl-pm-bal">${rLabel}</span><span>-₹${inr(r)}</span></div>`;
    }
    if (b > 0)
      h += `<div class="bl-pay-item"><span class="bl-pm-bal">Due</span><span>₹${inr(b)}</span></div>`;
    return h + "</div>";
  }

  function toggleGroup(hdr) {
    const key = hdr.dataset.group;
    const col = hdr.classList.toggle("collapsed");
    document
      .querySelectorAll(`.bl-date-row[data-date-group="${key}"]`)
      .forEach((r) => r.classList.toggle("bl-hidden", col));
  }

  function showLoading() {
    const t = dom("bl-table-body");
    if (t)
      t.innerHTML = `<tr><td colspan="13"><div class="bl-state"><div class="bl-loader"></div><p>Loading…</p></div></td></tr>`;
  }
  function showEmpty() {
    const t = dom("bl-table-body");
    if (t)
      t.innerHTML = `<tr><td colspan="13"><div class="bl-state"><i class="fas fa-inbox"></i><p>No invoiced bills found for this period</p></div></td></tr>`;
  }
  function showError(msg) {
    const t = dom("bl-table-body");
    if (t)
      t.innerHTML = `<tr><td colspan="13"><div class="bl-state" style="color:#dc3545"><i class="fas fa-exclamation-circle"></i><p>${msg}</p></div></td></tr>`;
  }

  // ── Bill modal — self-contained, no register.js dependency ───────────────────
  function closeBill() {
    const m = dom("bl-bill-modal");
    if (m) m.classList.remove("show");
  }

  // Track currently-open bill for the "Save & Share" button
  let _openBillId = null;
  let _openBillData = null;

  async function openBill(id) {
    const m = dom("bl-bill-modal"),
      area = dom("bl-bill-print-area");
    if (!m || !area) return;
    area.innerHTML = `<div class="bl-state"><div class="bl-loader"></div><p>Generating…</p></div>`;
    m.classList.add("show");

    // Reset save btn while loading
    const saveBtn = dom("bl-bill-save-pdf");
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading…';
    }

    _openBillId = null;
    _openBillData = null;

    try {
      const res = await apiFetch(`/generate_bill/${id}`);
      const data = await res.json();
      if (data.success) {
        area.innerHTML = buildBillHTML(data.bill);
        _openBillId = id;
        _openBillData = data.bill;
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.innerHTML =
            '<i class="fab fa-whatsapp"></i> Save &amp; Share';
        }
      } else {
        area.innerHTML = `<div class="bl-state" style="color:#c00"><i class="fas fa-times-circle"></i><p>${data.message}</p></div>`;
        if (saveBtn) {
          saveBtn.disabled = true;
          saveBtn.innerHTML =
            '<i class="fab fa-whatsapp"></i> Save &amp; Share';
        }
      }
    } catch {
      area.innerHTML = `<div class="bl-state" style="color:#c00"><i class="fas fa-times-circle"></i><p>Network error</p></div>`;
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fab fa-whatsapp"></i> Save &amp; Share';
      }
    }
  }

  // ── Bill HTML builder ─────────────────────────────────────────────────────────
  // GST rates per 55th GST Council (eff. 22 Sep 2025) + Karnataka place of supply
  // Always shows CGST and SGST rows — 0.00 when rate is exempt (tariff < ₹1,000).
  function buildBillHTML(b) {
    const days = b.days_stayed || calcDays(b.checkin_time, b.checkout_time);
    const rate = b.room_price_per_night || b.room_rent || 0;

    // ── Separate accommodation add-ons from other services ──────────────────────
    const services = b.services || [];
    const accomAddons = services.filter((s) => s.accommodation_charge);
    const otherServices = services.filter((s) => !s.accommodation_charge);
    const accomAddonsTotal = accomAddons.reduce(
      (s, x) => s + (x.price || 0),
      0,
    );
    const otherSvcTotal = otherServices.reduce((s, x) => s + (x.price || 0), 0);

    // ── GST calculation ──────────────────────────────────────────────────────────
    // Use stored gst_rate from backend when available (includes accommodation add-ons
    // in the taxable base). Fall back to on-the-fly calculation for older bills.
    const gstRatePct =
      typeof b.gst_rate === "number"
        ? b.gst_rate
        : rate > 7500
          ? 18
          : rate >= 1000
            ? 5
            : 0;
    const cgstRate = gstRatePct / 2;
    const sgstRate = gstRatePct / 2;

    // Use stored room_charges_total when available — this is always correct,
    // including when the room price changed mid-stay (room transfer or AC add-on).
    // Fall back to rate × days only for old bills that pre-date this field.
    const roomCharges = (typeof b.room_charges_total === "number" && b.room_charges_total > 0)
      ? b.room_charges_total
      : rate * days;
    const accomTotal = roomCharges + accomAddonsTotal;

    // Use stored gst_amount when available (correctly computed per-segment).
    // Derive CGST/SGST from it; fall back to back-calculation for old bills.
    let cgst, sgst, accomBase;
    if (typeof b.gst_amount === "number") {
      cgst      = b.gst_amount / 2;
      sgst      = cgst;
      accomBase = accomTotal - b.gst_amount;
    } else {
      const divisor = 1 + gstRatePct / 100;
      accomBase = accomTotal / divisor;
      cgst      = (accomTotal - accomBase) / 2;
      sgst      = cgst;
    }

    // Grand total — use stored total_amount (authoritative figure from billing).
    const discounts = b.discounts || 0;
    const svcTotalAll = b.services_total || 0; // includes both types
    const grandTotal = (typeof b.total_amount === "number" && b.total_amount > 0)
      ? b.total_amount
      : roomCharges + svcTotalAll - discounts;

    // Payment
    const cashPaid = b.payment_cash || 0;
    const onlinePaid = b.payment_online || 0;
    const refunds = b.refunds || 0;
    const refundCash = b.refund_cash || 0;
    const refundOnline = b.refund_online || 0;
    const totalPaid = cashPaid + onlinePaid;
    const netCollected = totalPaid - refunds;
    const balance = b.balance || 0;

    const displayBillNo = b.bill_number || "N/A";
    const billDate = fmtBillDT(b.checkout_time);

    // ── Accommodation add-on rows ────────────────────────────────────────────────
    const accomAddonRows = accomAddons
      .map(
        (s) => `
      <tr>
        <td>${s.item}</td>
        <td class="b-tr">${s.quantity || 1}</td>
        <td class="b-tr">${fix2(s.unit_price || s.price || 0)}</td>
        <td class="b-tr">${fix2(s.price || 0)}</td>
      </tr>`,
      )
      .join("");

    // ── Other services rows ──────────────────────────────────────────────────────
    const otherSvcRows = otherServices
      .map(
        (s) => `
      <tr>
        <td>${s.item}</td>
        <td class="b-tr">${s.quantity || 1}</td>
        <td class="b-tr">${fix2(s.unit_price || s.price || 0)}</td>
        <td class="b-tr">${fix2(s.price || 0)}</td>
      </tr>`,
      )
      .join("");

    // ── GST rows — always show, 0.00 when exempt ─────────────────────────────────
    const gstRows = `
      <tr class="b-gst-row">
        <td>CGST @ ${cgstRate}%</td>
        <td class="b-tr">—</td><td class="b-tr">—</td>
        <td class="b-tr">${fix2(cgst)}</td>
      </tr>
      <tr class="b-gst-row">
        <td>SGST @ ${sgstRate}%</td>
        <td class="b-tr">—</td><td class="b-tr">—</td>
        <td class="b-tr">${fix2(sgst)}</td>
      </tr>`;

    // Accommodation subtotal row (only when add-ons exist or multi-day)
    const accomSubtotalRow =
      accomAddons.length > 0 || days > 1
        ? `<tr class="b-subtotal">
           <td colspan="3" class="b-tr">Accommodation Total (incl. GST)</td>
           <td class="b-tr">${fix2(accomTotal)}</td>
         </tr>`
        : "";

    // Other services section (non-accommodation)
    const otherSvcSection = otherSvcRows
      ? `<tr class="b-sec"><td colspan="4">Additional Services (Non-Taxable)</td></tr>
         ${otherSvcRows}
         <tr class="b-subtotal">
           <td colspan="3" class="b-tr">Services Total</td>
           <td class="b-tr">${fix2(otherSvcTotal)}</td>
         </tr>`
      : "";

    // Discount row
    const discountRow =
      discounts > 0
        ? `<tr>
           <td colspan="3" style="text-align:right;color:#2e7d32;font-weight:600;">
             Discount
           </td>
           <td class="b-tr" style="color:#2e7d32;font-weight:700;">− ${fix2(discounts)}</td>
         </tr>`
        : "";

    return `
<div class="b-bill-wrap">

  <!-- ── Header ── -->
  <div class="b-header-block">
    <div class="b-lodge-name">CIBARA COMFORTS</div>
    <div class="b-lodge-entity">A Unit of Cibara Enterprise</div>
    <div class="b-lodge-sub">Opposite Bus Stand Road, Harihar, Karnataka – 577601</div>
    <div class="b-lodge-sub">Ph: +91 9482831381</div>
    <div class="b-gstin-bar">GSTIN: 29AAWFC1962B1Z9 &nbsp;·&nbsp; SAC: 9963 &nbsp;·&nbsp; Karnataka (KA – 29)</div>
    <div class="b-title">TAX INVOICE</div>
  </div>

  <!-- ── Bill & Guest Info — HTML table so xhtml2pdf + browser both render identically ── -->
  <table class="b-info-outer">
    <tr>
      <td class="b-info-col">
        <div class="b-row"><span class="b-lbl">Bill No:</span> ${displayBillNo}</div>
        <div class="b-row"><span class="b-lbl">Guest Name:</span> ${b.guest_name}</div>
        <div class="b-row"><span class="b-lbl">Mobile:</span> ${b.guest_mobile || "N/A"}</div>
        <div class="b-row"><span class="b-lbl">Room No:</span> ${b.room}</div>
        <div class="b-row"><span class="b-lbl">Guests:</span> ${b.guest_count || 1}</div>
      </td>
      <td class="b-info-col b-info-col-r">
        <div class="b-row"><span class="b-lbl">Check-in:</span> ${fmtBillDT(b.checkin_time)}</div>
        <div class="b-row"><span class="b-lbl">Check-out:</span> ${fmtBillDT(b.checkout_time)}</div>
        <div class="b-row"><span class="b-lbl">Days Stayed:</span> ${days}</div>
        <div class="b-row"><span class="b-lbl">Bill Date:</span> ${billDate}</div>
        <div class="b-row"><span class="b-lbl">Place of Supply:</span> Karnataka (KA – 29)</div>
      </td>
    </tr>
  </table>

  <!-- ── Items Table ── -->
  <table class="b-tbl">
    <thead>
      <tr>
        <th>Description</th>
        <th class="b-tr">Qty</th>
        <th class="b-tr">Rate (₹)</th>
        <th class="b-tr">Amount (₹)</th>
      </tr>
    </thead>
    <tbody>
      <tr class="b-sec"><td colspan="4">Accommodation Charges (SAC: 9963)</td></tr>
      <tr>
        <td>Room Rent — Base Amount (excl. GST)</td>
        <td class="b-tr">${days}</td>
        <td class="b-tr">${fix2(accomBase / (days || 1))}</td>
        <td class="b-tr">${fix2(accomBase)}</td>
      </tr>
      ${gstRows}
      ${accomAddonRows}
      ${accomSubtotalRow}
      ${otherSvcSection}
      ${discountRow}
      <tr class="b-grand">
        <td colspan="3" class="b-tr">GRAND TOTAL</td>
        <td class="b-tr">₹ ${fix2(grandTotal)}</td>
      </tr>
    </tbody>
  </table>

  <!-- ── Payment Summary ── -->
  <div class="b-pay-section">
    <div class="b-pay-title">Payment Details</div>
    <table class="b-tbl">
      <tbody>
        <tr><td>Cash Paid</td><td class="b-tr">₹ ${fix2(cashPaid)}</td></tr>
        <tr><td>Online / UPI Paid</td><td class="b-tr">₹ ${fix2(onlinePaid)}</td></tr>
        <tr class="b-subtotal"><td>Total Paid</td><td class="b-tr">₹ ${fix2(totalPaid)}</td></tr>
        ${
          refunds > 0
            ? (() => {
                const rc =
                  refundCash > 0
                    ? `<tr><td>Refund Given (Cash)</td><td class="b-tr" style="color:#c00;">− ₹ ${fix2(refundCash)}</td></tr>`
                    : "";
                const ro =
                  refundOnline > 0
                    ? `<tr><td>Refund Given (UPI)</td><td class="b-tr" style="color:#c00;">− ₹ ${fix2(refundOnline)}</td></tr>`
                    : "";
                const rf =
                  !refundCash && !refundOnline
                    ? `<tr><td>Refund Given</td><td class="b-tr" style="color:#c00;">− ₹ ${fix2(refunds)}</td></tr>`
                    : "";
                return (
                  rc +
                  ro +
                  rf +
                  `<tr class="b-subtotal"><td>Net Collected</td><td class="b-tr">₹ ${fix2(netCollected)}</td></tr>`
                );
              })()
            : ""
        }
        ${balance > 0 ? `<tr><td style="font-weight:800;color:#c62828;">Balance Due</td><td class="b-tr" style="font-weight:800;color:#c62828;">₹ ${fix2(balance)}</td></tr>` : ""}
        ${balance <= 0 && refunds <= 0 ? `<tr><td style="color:#2e7d32;font-weight:700;">Payment Status</td><td class="b-tr" style="color:#2e7d32;font-weight:700;">PAID IN FULL</td></tr>` : ""}
      </tbody>
    </table>
  </div>

  <!-- ── Signature ── -->
  <table class="b-sig">
    <tr>
      <td><div class="b-sig-line">Guest Signature</div></td>
      <td style="text-align:right"><div class="b-sig-line">Authorised Signatory</div></td>
    </tr>
  </table>

  <!-- ── Footer ── -->
  <div class="b-footer">
    <p>Thank you for staying at Cibara Comforts. We look forward to welcoming you again!</p>
    <p>This is a computer-generated invoice.</p>
  </div>

</div>`;
  }

  // ── Export — CA-ready GST report ─────────────────────────────────────────────
  function exportToExcel() {
    if (!state.filteredEntries.length) {
      alert("No invoiced bills to export.");
      return;
    }
    if (typeof XLSX === "undefined") {
      alert("Excel library not loaded. Refresh and retry.");
      return;
    }

    const rows = state.filteredEntries.map((e, i) => {
      const days =
        typeof e.days_stayed === "number"
          ? e.days_stayed
          : calcDays(e.checkin_time, e.checkout_time);
      const rate = e.room_rent || 0;
      const { base, cgst, sgst, cgstRate } = gstAmounts(rate, days);
      const gstRatePct = cgstRate * 2; // total GST %
      return {
        "Sr No": e.serial_number || i + 1,
        "Bill No": e.bill_number || "-",
        "Guest Name": e.guest_name || "-",
        Contact: e.guest_mobile || "-",
        Room: e.room || "-",
        "Check-in": fmtDT(e.checkin_time),
        "Check-out": e.checkout_time ? fmtDT(e.checkout_time) : "-",
        Days: days,
        "Room Rate/Night": rate,
        "Base Amt (excl GST)": +base.toFixed(2),
        "GST Rate %": gstRatePct,
        "CGST Amount": +cgst.toFixed(2),
        "SGST Amount": +sgst.toFixed(2),
        "Total GST": +(cgst + sgst).toFixed(2),
        "Room Charges (incl GST)": rate * days,
        Services: e.services_total || 0,
        "Grand Total": e.total_amount || 0,
        "Cash Paid": e.payment_cash || 0,
        "Online/UPI Paid": e.payment_online || 0,
        Refund: e.refunds || 0,
        "Balance Due": e.balance || 0,
        "Booking Source": e.booking_source || "normal",
        "Place of Supply": "Karnataka (KA-29)",
        "SAC Code": "9963",
      };
    });

    try {
      const ws = XLSX.utils.json_to_sheet(rows);
      ws["!cols"] = [
        { wch: 6 },
        { wch: 20 },
        { wch: 22 },
        { wch: 14 },
        { wch: 6 },
        { wch: 20 },
        { wch: 20 },
        { wch: 5 },
        { wch: 14 },
        { wch: 20 },
        { wch: 10 },
        { wch: 13 },
        { wch: 13 },
        { wch: 12 },
        { wch: 20 },
        { wch: 10 },
        { wch: 13 },
        { wch: 10 },
        { wch: 14 },
        { wch: 12 },
        { wch: 16 },
        { wch: 18 },
        { wch: 10 },
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "CA_Invoice_Report");
      XLSX.writeFile(
        wb,
        `CA_Bills_${state.dateRange.start}_to_${state.dateRange.end}.xlsx`,
      );
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

  // ── Init ─────────────────────────────────────────────────────────────────
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