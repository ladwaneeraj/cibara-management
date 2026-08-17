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
  display: flex; flex-direction: column; gap: 0.4rem;
  margin-bottom: 0.7rem;
  background: #f4f6fb; border-radius: 10px;
  padding: 0.5rem 0.7rem;
  border: 1px solid #e8eaf0;
}
.reg-filter-row {
  display: flex; flex-wrap: wrap;
  align-items: center; gap: 0.4rem;
}
/* Manager / housekeeping single-row layout: everything fits on one line.
   Search input flexes to fill the remaining space. */
.reg-filter-row-single {
  display: flex; flex-wrap: wrap;
  align-items: center; gap: 0.4rem;
}
.reg-filter-row-single .reg-search-input { flex: 1; min-width: 140px; }
@media (min-width: 720px) {
  .reg-filter-row-single { flex-wrap: nowrap; }
}
/* Admin single-row layout (same one-row pattern as the Bills filter bar) —
   search flexes to fill; the row wraps on narrow screens instead of
   clipping, since it carries the date-range picker too. */
.reg-filter-row-one {
  display: flex; flex-wrap: wrap;
  align-items: center; gap: 0.4rem;
}
.reg-filter-row-one .reg-search-input { flex: 1; min-width: 140px; }
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
  flex: 1; min-width: 100px;
  padding: 0.25rem 0.5rem 0.25rem 1.8rem;
  border: 1px solid #d8d8d8; border-radius: 6px;
  font-size: 0.8rem; height: 30px;
  background: #fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='13' height='13' viewBox='0 0 24 24' fill='none' stroke='%23aaa' stroke-width='2.5'%3E%3Ccircle cx='11' cy='11' r='8'%3E%3C/circle%3E%3Cline x1='21' y1='21' x2='16.65' y2='16.65'%3E%3C/line%3E%3C/svg%3E") no-repeat 0.45rem center;
  transition: border-color 0.15s;
}
.reg-search-input:focus { outline: none; border-color: var(--primary, #3f51b5); }
.reg-customers-btn {
  display: flex; align-items: center; gap: 0.3rem;
  padding: 0.25rem 0.75rem; height: 30px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: #fff; border: none; border-radius: 6px;
  font-size: 0.78rem; font-weight: 600; cursor: pointer;
  white-space: nowrap; flex-shrink: 0;
  transition: opacity 0.2s, transform 0.1s;
}
.reg-customers-btn:hover { opacity: 0.88; transform: translateY(-1px); }
.reg-customers-btn:active { transform: translateY(0); }
/* In the header toolbar the button sits next to the refresh icon */
.reg-customers-header-btn {
  height: 32px; border-radius: 6px;
}
.reg-count-badge {
  font-size: 0.72rem; color: #888; white-space: nowrap;
  margin-left: auto; padding: 0 0.3rem;
}

/* ── Located-stay highlight (Transactions → Register deep-link) ─────────
   Applied to the target row by _revealStayEntry(): pulses twice to catch
   the eye mid-scroll, then holds a steady tint. td backgrounds are set
   explicitly because zebra-striping on the cells would otherwise win. */
@keyframes reg-row-located-pulse {
  0%   { background-color: #ffe066; }
  50%  { background-color: #fff8dc; }
  100% { background-color: #fff3bf; }
}
tr.reg-row-located,
tr.reg-row-located > td {
  background-color: #fff3bf !important;
}
tr.reg-row-located {
  animation: reg-row-located-pulse 0.7s ease-in-out 2;
  box-shadow: inset 0 0 0 2px #f59f00;
}
tr.reg-row-located.reg-row-located-fade,
tr.reg-row-located.reg-row-located-fade > td {
  transition: background-color 1.3s ease, box-shadow 1.3s ease;
  background-color: transparent !important;
  box-shadow: none;
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

/* Pin the Action column (₹ / history / Doc icons) to the right edge so it stays
   visible even when this wide table overflows horizontally. Without this the
   icons scroll off-screen on narrower desktops and the horizontal scrollbar —
   sitting at the bottom of a tall table — is hard to reach. Scoped to data rows
   (.date-group-row) and the header; the collapsible date-group header spans all
   columns via colspan and must NOT be pinned. */
.register-table thead th:last-child,
.register-table tr.date-group-row td:last-child {
  position: sticky;
  right: 0;
}
.register-table tr.date-group-row td:last-child {
  background: #fff;
  z-index: 5;
  box-shadow: -6px 0 6px -5px rgba(0,0,0,0.18);
}
.register-table tbody tr.date-group-row:hover td:last-child {
  background: #f7f9fc; /* match the row hover so the pinned cell blends in */
}
.register-table thead th:last-child {
  /* Above both the sticky thead (z-index:10) and the pinned body cells. */
  background: var(--primary, #3f51b5);
  z-index: 12;
  box-shadow: -6px 0 6px -5px rgba(0,0,0,0.18);
}

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

/* ── Bill view toggle (Detailed / Consolidated) — control only, not printed ── */
.bl-view-toggle {
  display: flex; align-items: center; gap: .45rem;
  margin: .6rem 1rem 0; padding: .5rem .7rem;
  background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px;
}
.bl-view-toggle-label {
  font-size: .68rem; font-weight: 700; color: #64748b;
  text-transform: uppercase; letter-spacing: .06em;
}
.bl-vt-btn {
  padding: .32rem .72rem; border: 1px solid #cbd5e1; border-radius: 6px;
  background: #fff; color: #475569; font-size: .78rem; font-weight: 600;
  cursor: pointer; transition: background .15s, color .15s, border-color .15s;
}
.bl-vt-btn:hover { background: #f1f5f9; }
.bl-vt-btn.bl-vt-active {
  background: #1e40af; color: #fff; border-color: #1e40af;
}
.bl-vt-hint {
  margin-left: auto; font-size: .68rem; color: #94a3b8;
  font-style: italic; text-align: right;
}
@media print { .bl-view-toggle { display: none !important; } }

/* ── Bill print area (screen) ── */
#reg-bill-print-area,
#bl-bill-print-area {
  padding: 1.2rem 1.5rem;
  font-family: Arial, Helvetica, sans-serif;
  font-size: 0.80rem; line-height: 1.45;
  color: #1a1a1a;
}

/* ── Bill structure — full width so it fills the A4 sheet ── */
.b-bill-wrap { width: 100%; margin: 0 auto; }

/* Header — clean centered text, no background */
.b-header-block {
  text-align: center;
  padding-bottom: .6rem;
  border-bottom: 2px solid #333;
  margin-bottom: 0;
}
.b-lodge-name {
  font-size: 1.45rem; font-weight: 800;
  letter-spacing: .05em;
}
.b-lodge-entity {
  font-size: .82rem; color: #444; font-style: italic; margin-top: .15rem;
}
.b-lodge-sub {
  font-size: .78rem; color: #555; margin-top: .15rem;
}
.b-gstin-bar {
  font-size: .72rem; color: #777; margin-top: .18rem;
}
.b-title {
  font-size: .82rem; font-weight: 700;
  letter-spacing: .1em; margin-top: .4rem;
}

/* Info table */
.b-info-outer {
  border: 1px solid #ccc; border-top: none;
  width: 100%; border-collapse: collapse;
  margin-bottom: .6rem;
}
.b-info-col {
  padding: .55rem .8rem;
  font-size: .82rem;
  width: 50%;
  vertical-align: top;
}
.b-info-col-r { border-left: 1px solid #ccc; }
.b-row { margin-bottom: .22rem; }
.b-lbl {
  font-weight: 700; color: #444; white-space: nowrap;
  display: inline-block; min-width: 100px; margin-right: .3rem;
}
.b-val { color: #1a1a1a; }

/* Main items table */
.b-tbl {
  width: 100%; border-collapse: collapse;
  font-size: .82rem; margin-bottom: .5rem;
}
.b-tbl th {
  background: #efefef; font-weight: 700;
  padding: .38rem .5rem; border: 1px solid #bbb;
}
.b-tbl td { padding: .32rem .5rem; border: 1px solid #ddd; }
.b-tr { text-align: right; }

/* Section header rows */
.b-sec td {
  background: #f5f5f5; font-weight: 700;
  font-size: .77rem; color: #333;
  padding: .28rem .5rem; border-color: #bbb;
  text-transform: uppercase;
}

/* GST sub-rows */
.b-gst-row td { color: #666; font-size: .79rem; }

/* Grand total row */
.b-grand { border-top: 2px solid #333 !important; }
.b-grand td { font-weight: 800; background: #eee; padding: .4rem .5rem; }

/* Subtotal rows */
.b-subtotal td { font-weight: 700; background: #fafafa; }

/* Payment section */
.b-pay-section {
  margin-top: .7rem;
  border: 1px solid #ccc;
}
.b-pay-title {
  background: #efefef; font-weight: 700; font-size: .77rem;
  padding: .28rem .5rem;
  letter-spacing: .04em; text-transform: uppercase;
}
.b-pay-section .b-tbl { margin-bottom: 0; }
.b-pay-section .b-tbl td { border-color: #eee; padding: .3rem .5rem; }

/* Signature */
.b-sig {
  margin-top: 2rem; width: 100%;
  border-collapse: collapse;
}
.b-sig td { padding-top: .9rem; }
.b-sig td:last-child { text-align: right; }
.b-sig-line {
  display: inline-block;
  border-top: 1px solid #555;
  padding-top: .22rem; width: 140px;
  text-align: center; font-size: .75rem; color: #555;
}

/* Footer */
.b-footer {
  margin-top: .8rem; border-top: 1px solid #ddd;
  padding-top: .4rem; font-size: .7rem;
  color: #999; text-align: center;
}


/* Inline HSN/SAC sub-line under each line-item description (Rule 46(g)) */
.b-sac {
  font-size: .7rem; color: #888; font-style: italic;
  display: inline-block; margin-top: 1px;
}


/* Per-day section header */
.b-day-header td {
  background: #e8eef5; font-weight: 700;
  font-size: .85rem; color: #1a1a1a;
  padding: .32rem .5rem; border-color: #b8c6d8;
  letter-spacing: .02em;
}

/* Per-day total row */
.b-day-total td {
  background: #fafafa; font-weight: 700;
  font-size: .82rem; color: #1a1a1a;
  border-top: 1px dashed #b0b0b0;
  padding: .28rem .5rem;
}

/* Tax Summary by HSN/SAC — appears between line items and Payment Details */
.b-tax-summary {
  width: 100%; border-collapse: collapse;
  font-size: .78rem; margin: .35rem 0 .55rem 0;
}
.b-tax-summary th {
  background: #efefef; font-weight: 700;
  padding: .32rem .5rem; border: 1px solid #bbb;
}
.b-tax-summary td { padding: .28rem .5rem; border: 1px solid #ddd; }
.b-tax-summary .b-tax-sum-total td {
  font-weight: 800; background: #fafafa;
  border-top: 1.5px solid #555;
}

/* ── PRINT: force single A4 page ── */
@media print {
  /* margin:0 suppresses the browser's auto-printed URL / title / date
     header & footer. The page margin is reinstated as padding on the
     printed bill clone (#bl-print-clone) below, so content is never
     edge-to-edge. */
  @page { size: A4 portrait; margin: 0; }

  html, body {
    height: auto !important;
    min-height: 0 !important;
    max-height: none !important;
    overflow: visible !important;
    margin: 0 !important;
    padding: 0 !important;
    display: block !important;
  }

  /* The app-container has min-height:100vh + flex layout for the live UI.
     In print mode it contributes phantom height (a full page) which makes
     the browser emit a blank page 2. Force its height to 0 so it can't
     affect layout, in addition to hiding it. */
  body.bl-printing .app-container,
  body.bl-printing > *:not(#bl-print-clone) {
    display: none !important;
    height: 0 !important;
    min-height: 0 !important;
    max-height: 0 !important;
    overflow: hidden !important;
    visibility: hidden !important;
  }

  #bl-print-clone {
    display: block !important;
    margin: 0 !important;
    padding: 10mm 12mm !important;
    width: 100%;
    min-height: 0 !important;
    height: auto !important;
    font-family: Arial, Helvetica, sans-serif !important;
    font-size: 9pt !important;
    line-height: 1.3 !important;
    color: #000 !important;
  }
  body.bl-printing,
  body.bl-printing html { margin: 0 !important; padding: 0 !important; }

  /* Fallback: rooms-module bill modal */
  body:not(.bl-printing) * { visibility: hidden !important; }
  body:not(.bl-printing) .bill-modal.show,
  body:not(.bl-printing) .bill-modal.show .bill-content,
  body:not(.bl-printing) .bill-modal.show #bill-print-area,
  body:not(.bl-printing) .bill-modal.show #bill-print-area *,
  body:not(.bl-printing) .bill-modal.show #reg-bill-print-area,
  body:not(.bl-printing) .bill-modal.show #reg-bill-print-area * {
    visibility: visible !important;
  }
  body:not(.bl-printing) .bill-modal.show {
    position: absolute !important; top: 0 !important; left: 0 !important;
    width: 100% !important; height: auto !important;
    background: white !important; padding: 0 !important;
    overflow: visible !important; z-index: 9999 !important;
    display: block !important;
  }
  .bill-content {
    box-shadow: none !important; border-radius: 0 !important;
    max-height: none !important; overflow: visible !important;
    width: 100% !important; max-width: 100% !important;
    margin: 0 !important; padding: 0 !important;
  }
  .bill-header  { display: none !important; }
  .bill-actions { display: none !important; }

  /* Bill area sizing */
  #bl-print-clone,
  #reg-bill-print-area,
  #bill-print-area {
    padding: 10mm 12mm !important;
    font-size: 9pt !important;
    line-height: 1.3 !important;
    width: 100% !important;
  }
  /* (removed page-break-inside on .b-bill-wrap — was causing phantom blank page) */
  .b-bill-wrap { margin: 0 !important; padding: 0 !important; }

  /* Header block */
  .b-header-block {
    padding: 3mm 4mm 2.5mm !important;
  }
  .b-lodge-name { font-size: 13pt !important; }
  .b-lodge-sub  { font-size: 7pt !important; }
  .b-gstin-bar  { font-size: 6.5pt !important; }
  .b-title      { font-size: 8.5pt !important; padding: 1.2mm 0 !important;
                  -webkit-print-color-adjust: exact !important;
                  print-color-adjust: exact !important; }
  .b-info-outer { font-size: 7.5pt !important; }
  .b-info-col   { padding: 1.5mm 2.5mm !important; }
  .b-lbl        { min-width: 60px !important; }

  .b-tbl        { font-size: 7.5pt !important; margin-bottom: 1mm !important; }
  .b-tbl th     {
    font-size: 6.5pt !important; padding: .8mm !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }
  .b-tbl td     { padding: .7mm .8mm !important; }
  .b-sec td     {
    font-size: 6.5pt !important; padding: .6mm .8mm !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }
  .b-grand td   {
    padding: .9mm .8mm !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }
  .b-pay-title  {
    font-size: 6.5pt !important; padding: .6mm .8mm !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }
  .b-pay-section { margin-top: 1.2mm !important; }
  .b-pay-section .b-tbl td { padding: .55mm .8mm !important; }
  .b-sig        { margin-top: 2mm !important; padding: 0 !important; }
  .b-sig td     { padding-top: 1mm !important; }
  /* margin-top here is the blank signing gap printed ABOVE the rule line.
     Bumped from 2mm so there is real room to sign by hand. */
  .b-sig-line   { margin-top: 12mm !important; width: 30mm !important;
                  font-size: 6pt !important; padding-top: 1mm !important; }
  .b-footer     { margin: 1mm 0 0 0 !important; padding: 1mm 0 0 0 !important;
                  font-size: 5.5pt !important;
                  page-break-after: avoid !important;
                  break-after: avoid !important; }



  /* Trim any trailing margin on the last element of the bill so it can't
     push by 1-2px and force a new page. */
  #bl-print-clone .b-bill-wrap > *:last-child,
  #bl-print-clone .b-footer { margin-bottom: 0 !important; padding-bottom: 0 !important; }

  /* Per-day section header / per-day total — compress for print */
  .b-day-header td {
    font-size: 6.8pt !important; padding: .8mm .8mm !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }
  .b-day-total td {
    font-size: 6.8pt !important; padding: .6mm .8mm !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }
  /* Inline HSN/SAC sub-line under each line item */
  .b-sac { font-size: 5.5pt !important; line-height: 1 !important;
           margin-top: 0 !important; }
  /* Tax Summary table — same density as the main line-items table */
  .b-tax-summary { font-size: 6.8pt !important; margin: 1mm 0 !important; }
  .b-tax-summary th { font-size: 6pt !important; padding: .6mm .8mm !important;
                      -webkit-print-color-adjust: exact !important;
                      print-color-adjust: exact !important; }
  .b-tax-summary td { padding: .55mm .8mm !important; }
  .b-tax-summary .b-tax-sum-total td {
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }

  /* Prevent page breaks inside bill sections */
  .b-tbl, .b-info-outer, .b-pay-section, .b-sig, .b-footer,
  .b-tax-summary {
    page-break-inside: avoid !important;
    break-inside: avoid !important;
  }
  #bl-print-clone, #reg-bill-print-area, #bill-print-area {
    page-break-after: avoid !important;
    break-after: avoid !important;
  }
}

@media (max-width: 600px) {
  .reg-filter-bar label { display: none; }
  .register-table { font-size: 0.73rem; }
  .register-table th, .register-table td { padding: 0.35rem 0.25rem; }
  /* Row 1: date fills available width, quick btns stay compact */
  .reg-filter-row-1 { flex-wrap: nowrap; }
  .reg-date-range-input { width: 110px; }
  /* Row 2: selects equal width, search fills rest */
  .reg-filter-row-2 select { flex: 1; min-width: 0; }
  .reg-search-input { min-width: 0; }
  /* Header button: icon only on mobile */
  .reg-customers-label { display: none; }
  .reg-customers-header-btn { padding: 0; width: 32px; justify-content: center; }

  /* ── Mobile: unpin the action column so it SLIDES with the table ──
     On desktop the last column is sticky/right-pinned so the icons stay
     visible while the wide table scrolls. On a phone that pin overlaps the
     adjacent cells and feels stuck; unpinning lets the row scroll naturally
     so you swipe the table sideways to reveal the action buttons. */
  .register-table thead th:last-child,
  .register-table tr.date-group-row td:last-child {
    position: static;
    box-shadow: none;
  }

  /* ── Mobile: bill modal fits the screen ── */
  .bill-modal.show { padding: 0.4rem; align-items: flex-start; }
  .bill-content { margin-top: 0.4rem; border-radius: 8px; }
  #reg-bill-print-area,
  #bl-bill-print-area { padding: 0.75rem 0.7rem; font-size: 0.74rem; }

  /* The GST tax summary has 8 columns — on a narrow screen it spilled out of
     the modal's right edge. Let the table scroll horizontally INSIDE its box
     instead of overflowing the page. */
  .b-tax-summary {
    display: block; width: 100%;
    overflow-x: auto; -webkit-overflow-scrolling: touch;
    white-space: nowrap; font-size: 0.68rem;
  }

  /* Compact the footer action buttons — they were full-size and dominated the
     screen. Two per row, smaller padding/text. */
  .bill-actions { padding: 0.5rem; gap: 0.4rem; flex-wrap: wrap; }
  .bill-actions button,
  .bill-actions .action-btn,
  .bill-actions .bl-bill-save-btn {
    flex: 1 1 40%; min-width: 0;
    padding: 0.5rem 0.55rem; font-size: 0.8rem;
  }
}

/* ── Action column wrapper — keeps icons flush right and evenly spaced ── */
.reg-row-actions {
  display: flex; align-items: center;
  gap: 4px; justify-content: flex-end;
  flex-wrap: nowrap;
}
/* When the attribution badge is present it sits on the left while the
   action buttons remain right-aligned regardless of badge width. */
.reg-row-actions .reg-attr-badge { margin-right: auto; }

/* ── Payments button (per register row) ── */
.reg-pay-btn {
  display: inline-grid; place-items: center;
  width: 26px; height: 26px;
  padding: 0; border: 1px solid #e2e8f0;
  background: #fff; color: #64748b; border-radius: 6px;
  cursor: pointer; font-size: .78rem; font-weight: 600;
  transition: background .12s, border-color .12s, color .12s;
  white-space: nowrap; vertical-align: middle;
}
.reg-pay-btn:hover { background: #f1f5f9; color: #334155; border-color: #cbd5e1; }

/* ── Bill number link (clickable in register table) ── */
.reg-bill-link {
  background: none; border: none; padding: 0; cursor: pointer;
  color: var(--primary, #3f51b5); text-decoration: underline;
  font-size: .73rem; white-space: nowrap; font-weight: 600;
}
.reg-bill-link:hover { opacity: 0.7; }

/* ── Services section in payments modal ── */
.rp-svc-section { margin-top: 1rem; padding-top: 1rem; border-top: 2px solid #e8eaf0; }
.rp-svc-section h4 { font-size: .82rem; font-weight: 700; color: #333; margin: 0 0 .5rem; }
.rp-svc-table { width: 100%; border-collapse: collapse; font-size: .82rem; }
.rp-svc-table thead { background: var(--primary,#3f51b5); color: #fff; }
.rp-svc-table th { padding: .4rem .5rem; text-align: left; font-weight: 600; white-space: nowrap; }
.rp-svc-table tbody tr:hover { background: #f7f9fc; }
.rp-svc-table td { padding: .35rem .5rem; border-bottom: 1px solid #f0f0f0; }
.rp-svc-edit-btn {
  padding: .2rem .5rem; font-size: .72rem; cursor: pointer;
  border: 1px solid var(--primary,#3f51b5); border-radius: 4px;
  background: #fff; color: var(--primary,#3f51b5);
}
.rp-svc-edit-btn:hover { background: var(--primary,#3f51b5); color: #fff; }
.rp-svc-edit-row { background: #eef2ff !important; }
.rp-svc-edit-row td { padding: .45rem .5rem !important; }
.rp-svc-edit-form { display: flex; gap: .4rem; align-items: center; flex-wrap: wrap; }
.rp-svc-save-btn {
  padding: .25rem .6rem; background: #28a745; color: #fff;
  border: none; border-radius: 4px; cursor: pointer; font-size: .75rem;
}
.rp-svc-save-btn:hover { opacity: .85; }
.rp-svc-cancel-btn {
  padding: .25rem .6rem; background: #6c757d; color: #fff;
  border: none; border-radius: 4px; cursor: pointer; font-size: .75rem;
}
.rp-svc-cancel-btn:hover { opacity: .85; }

/* ── Password prompt modal ── */
.rpm-overlay {
  display: none; position: fixed; inset: 0;
  background: rgba(0,0,0,.5); z-index: 1300;
  align-items: center; justify-content: center;
}
.rpm-overlay.show { display: flex; }
.rpm-box {
  background: #fff; border-radius: 10px; padding: 1.5rem;
  width: 300px; box-shadow: 0 8px 32px rgba(0,0,0,.2);
}
.rpm-box h3 { margin: 0 0 .9rem; font-size: .92rem; color: #333; }
.rpm-box label { font-size: .75rem; color: #666; display: block; margin-bottom: .25rem; }
.rpm-box input[type="password"] {
  width: 100%; box-sizing: border-box;
  padding: .42rem .55rem; border: 1px solid #d0d0d0;
  border-radius: 6px; font-size: .88rem; margin-bottom: .6rem;
}
.rpm-box input[type="password"]:focus { outline: none; border-color: var(--primary,#3f51b5); }
.rpm-err { color: #dc3545; font-size: .75rem; margin-bottom: .5rem; display: none; }
.rpm-actions { display: flex; gap: .5rem; justify-content: flex-end; }
.rpm-cancel-btn {
  padding: .3rem .7rem; border: 1px solid #d0d0d0; background: #fff;
  border-radius: 6px; cursor: pointer; font-size: .82rem; color: #555;
}
.rpm-submit-btn {
  padding: .3rem .75rem; background: var(--primary,#3f51b5);
  color: #fff; border: none; border-radius: 6px;
  cursor: pointer; font-size: .82rem;
}
.rpm-submit-btn:hover { opacity: .85; }

/* ── Payments detail modal ── */
.rp-overlay {
  display: none; position: fixed; inset: 0;
  background: rgba(0,0,0,.5); z-index: 1200;
  align-items: flex-start; justify-content: center;
  padding: 1rem; overflow-y: auto;
}
.rp-overlay.show { display: flex; }
.rp-modal {
  background: #fff; border-radius: 10px; width: 100%;
  max-width: 660px; margin-top: 1rem;
  box-shadow: 0 8px 32px rgba(0,0,0,.2);
}
.rp-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: .7rem 1rem; border-bottom: 1px solid #eee;
  position: sticky; top: 0; background: #fff; z-index: 1;
  border-radius: 10px 10px 0 0;
}
.rp-header h3 { margin: 0; font-size: .92rem; }
.rp-close { background: none; border: none; font-size: 1.3rem; cursor: pointer; color: #888; }
.rp-body { padding: 1rem; }
.rp-meta { font-size: .77rem; color: #666; margin-bottom: .75rem; line-height: 1.55; }
.rp-meta strong { color: #333; }
.rp-table { width: 100%; border-collapse: collapse; font-size: .8rem; }
.rp-table th {
  background: var(--primary,#3f51b5); color: #fff;
  padding: .42rem .5rem; text-align: left; font-weight: 600;
}
.rp-table td { padding: .45rem .5rem; border-bottom: 1px solid #f0f0f0; vertical-align: middle; }
.rp-table tbody tr:hover { background: #f7f9fc; }
.rp-by {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: .73rem; color: #475569;
  white-space: nowrap;
}
.rp-by i { font-size: .65rem; opacity: .6; }
.rp-by-unknown { color: #94a3b8; font-size: .8rem; }
.rp-edit-btn {
  padding: .16rem .42rem; border: 1px solid var(--primary,#3f51b5);
  background: #fff; color: var(--primary,#3f51b5);
  border-radius: 4px; cursor: pointer; font-size: .7rem;
  transition: all .15s;
}
.rp-edit-btn:hover { background: var(--primary,#3f51b5); color: #fff; }
.rp-edit-row { background: #eef2ff !important; }
.rp-edit-row td { padding: .55rem .5rem !important; }
.rp-edit-form {
  display: flex; gap: .6rem; align-items: flex-end; flex-wrap: wrap;
  padding: .15rem 0;
}
/* Each control sits in a labelled field group so Date / Time / Mode /
   Amount read clearly instead of as a cramped inline row. */
.rp-edit-field { display: flex; flex-direction: column; gap: .22rem; }
.rp-edit-field label {
  font-size: .66rem; font-weight: 700; color: #5b6275;
  text-transform: uppercase; letter-spacing: .03em;
}
.rp-edit-form input[type="date"],
.rp-edit-form input[type="time"],
.rp-edit-form input[type="text"],
.rp-edit-form input[type="number"],
.rp-edit-form select {
  padding: .4rem .55rem; border: 1px solid #cbd2e0;
  border-radius: 6px; font-size: .83rem; min-height: 36px;
  background: #fff; color: #1f2330; box-sizing: border-box;
}
/* Combined Date & time field — wide enough for the prettified value
   flatpickr shows, e.g. "18 May 2026 · 12:08 PM". */
.rp-edit-form .rp-edit-dt-input { min-width: 190px; }
.rp-edit-form input:focus,
.rp-edit-form select:focus {
  outline: none; border-color: var(--primary,#3f51b5);
  box-shadow: 0 0 0 2px rgba(63,81,181,.15);
}
.rp-edit-actions { display: flex; gap: .4rem; align-items: center; }
.rp-edit-refund-note {
  font-size: .72rem; color: #888;
  align-self: flex-end; padding-bottom: .55rem;
}
.rp-save-btn {
  padding: .28rem .65rem; background: #28a745; color: #fff;
  border: none; border-radius: 4px; cursor: pointer; font-size: .76rem;
}
.rp-save-btn:hover { opacity: .85; }
.rp-cancel-edit-btn {
  padding: .28rem .65rem; background: #6c757d; color: #fff;
  border: none; border-radius: 4px; cursor: pointer; font-size: .76rem;
}
.rp-cancel-edit-btn:hover { opacity: .85; }
.rp-delete-btn {
  padding: .28rem .55rem; background: #dc3545; color: #fff;
  border: none; border-radius: 4px; cursor: pointer; font-size: .73rem;
  font-weight: 600; margin-left: .25rem; transition: opacity .15s;
}
.rp-delete-btn:hover { opacity: .8; }

/* ── Delete confirmation modal ── */
.rpd-overlay {
  display: none; position: fixed; inset: 0;
  background: rgba(0,0,0,.55); z-index: 1400;
  align-items: center; justify-content: center;
}
.rpd-overlay.show { display: flex; }
.rpd-box {
  background: #fff; border-radius: 12px; width: 340px;
  box-shadow: 0 12px 40px rgba(0,0,0,.25);
  overflow: hidden;
}
.rpd-header {
  background: #dc3545; color: #fff;
  padding: .85rem 1.1rem;
  display: flex; align-items: center; gap: .55rem;
}
.rpd-header i { font-size: 1.15rem; }
.rpd-header h3 { margin: 0; font-size: .95rem; font-weight: 700; }
.rpd-body { padding: 1.1rem 1.2rem .9rem; }
.rpd-warn {
  font-size: .82rem; color: #555; margin-bottom: .85rem; line-height: 1.55;
}
.rpd-detail {
  background: #fff5f5; border: 1px solid #fecaca;
  border-radius: 8px; padding: .6rem .9rem;
  font-size: .8rem; color: #333; line-height: 1.6;
  margin-bottom: 1rem;
}
.rpd-detail .rpd-row { display: flex; justify-content: space-between; gap: .5rem; }
.rpd-detail .rpd-row .lbl { color: #888; font-size: .74rem; }
.rpd-detail .rpd-row .val { font-weight: 700; }
.rpd-detail .rpd-row .val.amt { color: #dc3545; font-size: .95rem; }
.rpd-notice {
  background: #fef9c3; border: 1px solid #fde68a;
  border-radius: 6px; padding: .45rem .75rem;
  font-size: .73rem; color: #92400e;
  display: flex; align-items: flex-start; gap: .4rem;
  margin-bottom: 1rem; line-height: 1.45;
}
.rpd-notice i { margin-top: .05rem; flex-shrink: 0; }
.rpd-actions { display: flex; gap: .55rem; justify-content: flex-end; }
.rpd-cancel-btn {
  padding: .38rem .85rem; background: #fff;
  border: 1px solid #d0d0d0; border-radius: 7px;
  cursor: pointer; font-size: .82rem; color: #555; font-weight: 600;
  transition: background .15s;
}
.rpd-cancel-btn:hover { background: #f5f5f5; }
.rpd-confirm-btn {
  padding: .38rem .95rem; background: #dc3545; color: #fff;
  border: none; border-radius: 7px; cursor: pointer;
  font-size: .82rem; font-weight: 700;
  display: flex; align-items: center; gap: .4rem;
  transition: background .15s;
}
.rpd-confirm-btn:hover:not(:disabled) { background: #b91c1c; }
.rpd-confirm-btn:disabled { opacity: .6; cursor: not-allowed; }
.rp-method-cash   { color: #28a745; font-weight: 700; font-size: .72rem; }
.rp-method-online { color: #1565c0; font-weight: 700; font-size: .72rem; }
.rp-method-upi    { color: #6f42c1; font-weight: 700; font-size: .72rem; }
.rp-method-ota    { color: #e67e22; font-weight: 700; font-size: .72rem; }
.rp-method-other  { color: #555;    font-weight: 700; font-size: .72rem; }
.rp-empty { text-align: center; color: #999; padding: 1.5rem; font-size: .82rem; }
.rp-spinner { text-align: center; padding: 1.5rem; color: #888; font-size: .82rem; }

/* ── Document view button ── */
/* Persons column — dedicated narrow column for the guest count.
   Keeping it separate means the Guest Name column doesn't reflow
   as the pill is appended/removed. */
.reg-th-persons,
.reg-td-persons {
  text-align: center;
  white-space: nowrap;
  width: 1%;          /* shrink to content; stays narrow */
}
.reg-guests-pill {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 8px; border-radius: 999px;
  background: #f1f5f9; color: #64748b;
  font: 600 .7rem 'Inter', sans-serif;
  vertical-align: middle;
  white-space: nowrap;
  line-height: 1;
}
.reg-guests-pill i { font-size: .62rem; opacity: .7; }

/* History icon next to the ₹ button in each register row */
.reg-history-btn {
  display: inline-grid; place-items: center;
  width: 26px; height: 26px;
  border: 1px solid #e2e8f0; border-radius: 6px;
  background: #fff; color: #94a3b8;
  cursor: pointer;
  transition: background .12s, border-color .12s, color .12s;
  vertical-align: middle;
}
.reg-history-btn:hover {
  background: #f1f5f9; border-color: #cbd5e1; color: #475569;
}
.reg-history-btn i { font-size: .72rem; }

/* "Checked in by" attribution chip on each register row */
.reg-attr-badge {
  display: inline-flex; align-items: center; gap: 3px;
  padding: 2px 7px; border-radius: 999px;
  background: #eef2ff; color: #4338ca;
  font: 600 .68rem 'Inter', sans-serif;
  vertical-align: middle;
  white-space: nowrap;
  margin-right: 4px;
}
.reg-attr-badge i { font-size: .65rem; opacity: .8; }

.reg-doc-btn {
  display: inline-grid; place-items: center;
  width: 26px; height: 26px;
  padding: 0; border: 1px solid #e2e8f0;
  background: #fff; color: #94a3b8; border-radius: 6px;
  cursor: pointer; font-size: .78rem; font-weight: 600;
  transition: background .12s, border-color .12s, color .12s;
  white-space: nowrap; vertical-align: middle;
}
.reg-doc-btn:hover { background: #f1f5f9; color: #475569; border-color: #cbd5e1; }

/* Guest has NO ID on file — amber dashed button that uploads from the row.
   Visually distinct from the plain grey "view docs" state. */
.reg-doc-btn { position: relative; }
.reg-doc-btn.missing {
  color: #b45309;
  border: 1px dashed #f59e0b;
  background: #fffbeb;
}
.reg-doc-btn.missing:hover { background: #fef3c7; color: #92400e; border-color: #d97706; }
.reg-doc-plus {
  position: absolute;
  top: -5px; right: -5px;
  background: #f59e0b;
  color: #fff;
  border-radius: 50%;
  width: 13px; height: 13px;
  font-size: 10px; line-height: 13px;
  font-weight: 700;
  text-align: center;
  pointer-events: none;
}

/* Invisible placeholder rendered when a row has no document. Reserves
   the same footprint as .reg-doc-btn so the ₹ and history icons stay
   in the same horizontal position across rows. */
.reg-doc-slot {
  display: inline-block;
  width: 26px; height: 26px;
  vertical-align: middle;
  flex-shrink: 0;
}

/* ── ID Documents modal ── */
.rdoc-overlay {
  display: none; position: fixed; inset: 0;
  background: rgba(0,0,0,.55); z-index: 1200;
  align-items: flex-start; justify-content: center;
  padding: 1rem; overflow-y: auto;
}
.rdoc-overlay.show { display: flex; }
.rdoc-modal {
  background: #fff; border-radius: 10px; width: 100%;
  max-width: 620px; margin-top: 1rem;
  box-shadow: 0 8px 32px rgba(0,0,0,.22);
}
.rdoc-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: .7rem 1rem; border-bottom: 1px solid #eee;
  position: sticky; top: 0; background: #fff; z-index: 1;
  border-radius: 10px 10px 0 0;
}
.rdoc-header h3 { margin: 0; font-size: .92rem; }
.rdoc-close { background: none; border: none; font-size: 1.3rem; cursor: pointer; color: #888; }
.rdoc-body { padding: 1rem; }
.rdoc-meta { font-size: .77rem; color: #666; margin-bottom: .75rem; }
.rdoc-meta strong { color: #333; }
.rdoc-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: .75rem;
}
.rdoc-img-wrap {
  border: 1px solid #e0e0e0; border-radius: 6px; overflow: hidden;
  background: #f8f8f8; aspect-ratio: 4/3; display: flex;
  align-items: center; justify-content: center;
}
.rdoc-img-wrap img {
  width: 100%; height: 100%; object-fit: cover; cursor: pointer;
  transition: opacity .15s;
}
.rdoc-img-wrap img:hover { opacity: .88; }
.rdoc-empty { text-align: center; color: #999; padding: 1.5rem; font-size: .82rem; }
.rdoc-spinner { text-align: center; padding: 1.5rem; color: #888; font-size: .82rem; }
`;


  function injectStyles() {
    if (document.getElementById("reg-mod-styles")) return;
    const s = document.createElement("style");
    s.id = "reg-mod-styles";
    s.textContent = REGISTER_CSS;
    document.head.appendChild(s);
  }

  // ── State ────────────────────────────────────────────────────────────────────
  // Paged rendering: rows rendered per page. applyFilters() resets the cap,
  // the "Show more" row extends it. Keeps first paint fast on 1000+ rows.
  const PAGE_SIZE = 100;

  const state = {
    allEntries: [],
    filteredEntries: [],
    visibleCount: PAGE_SIZE,
    loading: false,
    dateRange: { start: null, end: null },
    filters: { search: "", payment: "all", status: "all" },
    lastLoadedRange: null, // tracks what range was last fetched
    _reqId: 0,            // incremented on every fetch; detects stale responses
  };

  // ── Utilities ────────────────────────────────────────────────────────────────
  function pad(n) {
    return String(n).padStart(2, "0");
  }
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function escapeAttr(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
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

  // ── Bill helper functions ─────────────────────────────────────────────────────
  function fix2(n) { return (+(n || 0)).toFixed(2); }
  function fmtBillDT(dtStr) {
    if (!dtStr) return "-";
    const [dp, tp = ""] = dtStr.split(" ");
    const [y, m, d] = dp.split("-");
    const mn = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    let timePart = "";
    if (tp) {
      const [hh, mm] = tp.split(":");
      const h = parseInt(hh);
      const ampm = h >= 12 ? "PM" : "AM";
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      timePart = `, ${String(h12).padStart(2,"0")}:${mm} ${ampm}`;
    }
    return `${mn[parseInt(m)-1]} ${parseInt(d)}, ${y}${timePart}`;
  }
  // ══════════════════════════════════════════════════════════════════════════
  // BILL RENDERING — server-side, deliberately not here
  // ──────────────────────────────────────────────────────────────────────────
  // This module used to carry its own buildBillHTML() together with
  // inferServiceTax / serviceTaxLabel / consolidateServices and the folio
  // grouping helpers (folioNightKey / groupFolio / renderRegFolioDay /
  // renderRegFolioRun). All of it is gone.
  //
  // It was the best of four competing copies of the invoice layout — which is
  // why the modal here looked right while the PDF saved to Storage did not —
  // but being the best copy is still being a copy. Keeping tax inference and
  // GST slab rules in JavaScript as well as Python meant two places to get
  // Rule 46 right, and they had already diverged on IGST routing.
  //
  // The bill HTML now comes from GET /bill_html, rendered by
  // _build_bill_html in routes/billing.py — the same function that produces
  // the stored PDF and the guest's WhatsApp copy. Change the layout there and
  // every surface moves together.
  // ══════════════════════════════════════════════════════════════════════════

  // ── Bill viewer functions ─────────────────────────────────────────────────────
  // Track the currently-open bill so the action buttons (Save & Share,
  // Recalculate, Print) inside reg-bill-overlay have something to act on.
  let _regOpenBillId   = null;
  let _regOpenBillData = null;

  // Last view mode / collapsibility the server reported for the open bill.
  // The browser no longer derives either — /bill_html decides and returns both.
  let _regOpenBillView = null;
  let _regOpenBillCollapsible = false;

  // Operator's Detailed/Consolidated preference; null → let the server
  // auto-select. The key is shared with the Bills-tab modal so the choice
  // follows the operator between tabs.
  let _regBillViewMode = null;
  try {
    const _rvm = localStorage.getItem("cibara_bill_view");
    if (_rvm === "detailed" || _rvm === "consolidated") _regBillViewMode = _rvm;
  } catch (_e) { /* localStorage blocked — use auto */ }

  // (Re)render the open bill into the print area — called on open and
  // whenever the Detailed/Consolidated toggle changes.
  //
  // The bill HTML is FETCHED, not built here. `_build_bill_html` on the server
  // is the only renderer, so this modal, its Print output, the PDF stored in
  // Firebase Storage and the guest's WhatsApp copy are all the same document.
  async function _renderRegOpenBill(view) {
    const area = dom("reg-bill-print-area");
    if (!area || !_regOpenBillId) return;

    const qs = (view === "detailed" || view === "consolidated")
      ? `?view=${view}` : "";
    const res = await apiFetch(`/bill_html/${_regOpenBillId}${qs}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.message || "Could not render bill.");

    area.innerHTML = data.html;
    _regOpenBillView = data.view;
    _regOpenBillCollapsible = !!data.collapsible;
    _syncGenInvoiceBtn();
  }

  // Show the admin "Generate Invoice" button only when this stay needs it:
  // checked out, finalized (has a CC/ number), missing its PDF, and within
  // 5 days of checkout. The server enforces the same rules; this is just UI.
  function _syncGenInvoiceBtn() {
    const btn = dom("reg-bill-geninvoice");
    if (!btn) return;
    const b = _regOpenBillData || {};
    const _auth = window.CibaraAuth;
    const isAdmin = !!(_auth && _auth.isAdmin && _auth.isAdmin());
    const billNo = (b.bill_number || "").trim();
    const hasNumber = billNo && billNo !== "-";
    // A pdf_url into the shared bills/-/ folder is dead (overwritten +
    // token rotated → 403) — treat it as missing so the button shows and
    // the server regenerates under the real number.
    const hasPdf = !!b.pdf_url && b.pdf_url.indexOf("bills%2F-%2F") === -1;
    const completed = b.status === "completed" || b.status === "pending_settlement";
    let recent = false, sameMonth = false;
    const coDate = (b.checkout_time || "").slice(0, 10);
    if (coDate) {
      const d = new Date(coDate + "T00:00:00");
      if (!isNaN(d.getTime())) {
        const ageDays = Math.floor((Date.now() - d.getTime()) / 86400000);
        recent = ageDays <= 7;
      }
      const _nm = new Date();
      const _nymStr = _nm.getFullYear() + "-" + String(_nm.getMonth() + 1).padStart(2, "0");
      sameMonth = (b.checkout_time || "").slice(0, 7) === _nymStr;
    }
    btn.style.display =
      (isAdmin && completed && (!hasNumber || !hasPdf) && recent && sameMonth) ? "" : "none";
  }

  // Show the toggle only when the server reports a folio that can actually be
  // consolidated, and highlight the button matching the mode it applied.
  function _syncRegViewToggle() {
    const bar = dom("reg-view-toggle");
    if (!bar) return;
    if (!_regOpenBillCollapsible) { bar.style.display = "none"; return; }
    bar.style.display = "flex";
    const mode = _regOpenBillView;
    const dBtn = dom("reg-vt-detailed");
    const cBtn = dom("reg-vt-consolidated");
    if (dBtn) dBtn.classList.toggle("bl-vt-active", mode === "detailed");
    if (cBtn) cBtn.classList.toggle("bl-vt-active", mode === "consolidated");
    const hint = dom("reg-vt-hint");
    if (hint) hint.textContent = mode === "consolidated"
      ? "Room nights grouped — days with extras shown separately"
      : "Every night itemised";
  }

  async function openRegBill(id) {
    const overlay = dom("reg-bill-overlay");
    const area    = dom("reg-bill-print-area");
    if (!overlay || !area) return;
    _regOpenBillId   = null;
    _regOpenBillData = null;
    _regOpenBillView = null;
    _regOpenBillCollapsible = false;
    area.innerHTML = `<div class="reg-state"><div class="reg-loader"></div><p>Loading…</p></div>`;
    overlay.classList.add("show");
    try {
      // The bill record is still fetched — the modal's action buttons act on
      // its fields. The rendered invoice comes separately from /bill_html.
      const res  = await apiFetch(`/generate_bill/${id}`);
      const data = await res.json();
      if (data.success) {
        _regOpenBillId   = id;
        _regOpenBillData = data.bill;
        // null preference means let the server auto-pick the view.
        await _renderRegOpenBill(_regBillViewMode);
        _syncRegViewToggle();
      } else {
        area.innerHTML = `<div class="reg-state" style="color:#c00;"><i class="fas fa-times-circle"></i><p>${data.message || "Failed to load bill"}</p></div>`;
      }
    } catch (err) {
      // Surface the real error rather than always blaming the network — a
      // render failure here is otherwise indistinguishable from being offline.
      console.error("[Register] openRegBill failed:", err);
      const _msg = (err && (err.message || err.toString())) || "Network error";
      area.innerHTML = `<div class="reg-state" style="color:#c00;"><i class="fas fa-times-circle"></i><p>${_msg}</p></div>`;
    }
  }
  function _closeRegBill() {
    const overlay = dom("reg-bill-overlay");
    if (overlay) overlay.classList.remove("show");
    _regOpenBillId   = null;
    _regOpenBillData = null;
  }

  // Exposed for the Bills tab — clicking View Bill there delegates to this
  // same modal. The single source of truth for bill rendering is no longer
  // "this modal" but /bill_html on the server, which both modals now fetch.
  window.openRegBill = openRegBill;
  // Force a full reload of the current register range. Exposed so other
  // modules (e.g. the manual-bill creator) can refresh the register after
  // writing a new bill, without reaching into this IIFE's internals.
  window.reloadRegister = function () {
    try { loadData(true); } catch (e) { /* register not ready yet */ }
  };

  // ── Generate-Invoice confirmation popup ───────────────────────────────────
  function _genInvEsc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  function _genInvOverlay() {
    let ov = document.getElementById("reg-geninv-overlay");
    if (ov) return ov;
    ov = document.createElement("div");
    ov.id = "reg-geninv-overlay";
    ov.style.cssText =
      "position:fixed;inset:0;background:rgba(15,23,42,.55);display:none;" +
      "align-items:center;justify-content:center;z-index:10050;";
    ov.innerHTML =
      '<div style="background:#fff;border-radius:14px;max-width:430px;width:92%;' +
      'box-shadow:0 20px 60px rgba(0,0,0,.28);overflow:hidden;">' +
        '<div style="padding:1.05rem 1.25rem;border-bottom:1px solid #eef0f4;' +
        'display:flex;align-items:center;gap:.55rem;">' +
          '<i class="fas fa-file-invoice" style="color:#4f46e5;"></i>' +
          '<h3 style="margin:0;font-size:1rem;font-weight:700;color:#1e293b;">Generate GST Invoice</h3>' +
        '</div>' +
        '<div id="reg-geninv-body" style="padding:1.1rem 1.25rem;font-size:.85rem;color:#334155;"></div>' +
        '<div id="reg-geninv-foot" style="padding:.85rem 1.25rem;border-top:1px solid #eef0f4;' +
        'display:flex;justify-content:flex-end;gap:.5rem;"></div>' +
      '</div>';
    document.body.appendChild(ov);
    ov.addEventListener("click", (ev) => { if (ev.target === ov) ov.style.display = "none"; });
    return ov;
  }
  function _openGenInvoiceModal(entry) {
    const ov = _genInvOverlay();
    const body = ov.querySelector("#reg-geninv-body");
    const foot = ov.querySelector("#reg-geninv-foot");
    body.innerHTML =
      '<p style="margin:0 0 .8rem;">A new sequential GST invoice number will be ' +
      'created for this checkout and a PDF generated. This is recorded in the audit log.</p>' +
      '<div style="background:#f8fafc;border:1px solid #eef0f4;border-radius:10px;' +
      'padding:.7rem .85rem;line-height:1.75;">' +
        '<div><strong>Guest:</strong> ' + _genInvEsc(entry.guest_name || "-") + '</div>' +
        '<div><strong>Room:</strong> ' + _genInvEsc(entry.room || "-") + '</div>' +
        '<div><strong>Check-out:</strong> ' + _genInvEsc(entry.checkout_time ? fmtDT(entry.checkout_time) : "-") + '</div>' +
        '<div><strong>Total:</strong> \u20B9' + inr(entry.total_amount) + '</div>' +
      '</div>';
    foot.innerHTML =
      '<button id="reg-geninv-cancel" class="action-btn btn-secondary">Cancel</button>' +
      '<button id="reg-geninv-confirm" class="action-btn btn-primary">' +
      '<i class="fas fa-file-invoice"></i> Generate Invoice</button>';
    ov.style.display = "flex";
    ov.querySelector("#reg-geninv-cancel").onclick = () => { ov.style.display = "none"; };
    ov.querySelector("#reg-geninv-confirm").onclick = async () => {
      const _auth = window.CibaraAuth;
      if (!(_auth && _auth.isAdmin && _auth.isAdmin())) {
        _genInvResult(false, "Only admin users can generate invoices."); return;
      }
      const cBtn = ov.querySelector("#reg-geninv-confirm");
      cBtn.disabled = true;
      cBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating\u2026';
      try {
        const res = await apiFetch("/generate_invoice/" + entry.id, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data && data.success) {
          _genInvResult(true, data.message || "Invoice generated.", data.bill_number);
        } else {
          _genInvResult(false, (data && data.message) || ("Failed (HTTP " + res.status + ")."));
        }
      } catch (err) {
        console.error("[Register] generate invoice failed:", err);
        _genInvResult(false, "Network error during invoice generation.");
      }
    };
  }
  function _genInvResult(ok, msg, billNo) {
    const ov = document.getElementById("reg-geninv-overlay");
    if (!ov) return;
    const body = ov.querySelector("#reg-geninv-body");
    const foot = ov.querySelector("#reg-geninv-foot");
    body.innerHTML = ok
      ? '<div style="text-align:center;padding:.4rem 0;">' +
          '<i class="fas fa-check-circle" style="color:#16a34a;font-size:2.1rem;"></i>' +
          '<p style="margin:.6rem 0 0;font-weight:600;">' + _genInvEsc(msg) + '</p>' +
          (billNo ? '<p style="margin:.3rem 0 0;color:#475569;">Bill No: <strong>' +
                    _genInvEsc(billNo) + '</strong></p>' : '') +
        '</div>'
      : '<div style="text-align:center;padding:.4rem 0;">' +
          '<i class="fas fa-times-circle" style="color:#dc2626;font-size:2.1rem;"></i>' +
          '<p style="margin:.6rem 0 0;font-weight:600;">' + _genInvEsc(msg) + '</p>' +
        '</div>';
    foot.innerHTML = '<button id="reg-geninv-done" class="action-btn btn-primary">Done</button>';
    ov.querySelector("#reg-geninv-done").onclick = () => {
      ov.style.display = "none";
      if (ok) loadData(true);
    };
  }

  // ── Build tab HTML ────────────────────────────────────────────────────────────
  function buildHTML() {
    const tab = dom("register-tab");
    if (!tab) return;

    // ── RBAC-aware layout ───────────────────────────────────────────────────
    // Admin: full date range (Today / Week / Month) and the original two-row
    //        filter layout.
    // Manager (and anyone non-admin): only Today + Last 3 Days quick buttons,
    //        and all filters collapsed into a single row.
    const _auth = window.CibaraAuth;
    const _isAdmin = _auth && _auth.isAdmin && _auth.isAdmin();

    // Manual / backdated bill — admin-only (payment.edit). Built into the
    // toolbar here (buildHTML fully replaces the tab, so a static button in
    // index.html would be wiped); opens the modal from static/manual-bill.js.
    const _canManualBill = !!(_auth && _auth.userCan && _auth.userCan("payment.edit"));
    const manualBillBtn = _canManualBill
      ? `<button class="reg-icon-btn reg-manual-bill" id="manual-bill-btn"
             onclick="window.openManualBill && window.openManualBill()"
             title="Add a manual / backdated bill"
             style="background:#7c3aed;color:#fff;">
           <i class="fas fa-file-invoice-dollar"></i>
         </button>`
      : "";

    // Quick range buttons. Same set for admin (Today / Last 3 Days / Month)
    // as the Bills tab — kept identical so the two tabs feel uniform.
    // Manager / housekeeping see only Today + Last 3 Days (server clamps
    // anything wider to 3 days anyway).
    const dateButtons = _isAdmin
      ? `<button class="reg-quick-btn" data-rq="today">Today</button>
         <button class="reg-quick-btn rq-active" data-rq="last3">Last 3 Days</button>
         <button class="reg-quick-btn" data-rq="month">Month</button>`
      : `<button class="reg-quick-btn" data-rq="today">Today</button>
         <button class="reg-quick-btn rq-active" data-rq="last3">Last 3 Days</button>`;

    // Custom date-range picker is admin-only. Manager/housekeeping rely on
    // the quick-range buttons (today / last 3 days). This keeps the toolbar
    // clean and aligns with the 3-day server-side cap.
    const datePickerMarkup = _isAdmin
      ? `<div class="reg-date-range-wrap" id="reg-date-range-wrap">
           <i class="fas fa-calendar-alt"></i>
           <input type="text" id="reg-date-range" class="reg-date-range-input" placeholder="Select date range" readonly />
         </div>`
      : "";

    const filterMarkup = _isAdmin
      ? `
    <div class="reg-filter-row reg-filter-row-one">
      ${datePickerMarkup}
      ${dateButtons}
      <span class="reg-filter-divider"></span>
      <select id="reg-payment-filter">
        <option value="all">All Payments</option>
        <option value="cash">Cash Only</option>
        <option value="online">Online Only</option>
        <option value="split">Split</option>
        <option value="pending">Pending Balance</option>
      </select>
      <select id="reg-status-filter">
        <option value="all">All Status</option>
        <option value="active">Active</option>
        <option value="completed">Checked Out</option>
      </select>
      <input type="text" class="reg-search-input" id="reg-search" placeholder="Name / Room / Mobile…" />
    </div>`
      : `
    <div class="reg-filter-row reg-filter-row-single">
      ${dateButtons}
      <select id="reg-status-filter">
        <option value="all">All Status</option>
        <option value="active">Active</option>
        <option value="completed">Checked Out</option>
      </select>
      <select id="reg-payment-filter">
        <option value="all">All Payments</option>
        <option value="cash">Cash</option>
        <option value="online">Online</option>
        <option value="split">Split</option>
        <option value="pending">Pending</option>
      </select>
      <input type="text" class="reg-search-input" id="reg-search" placeholder="Name / Room / Mobile…" />
    </div>`;

    tab.innerHTML = `
<div class="register-container">
  <div class="register-header">
    <h1><i class="fas fa-book"></i> Daily Register</h1>
    <div class="register-toolbar">
      ${manualBillBtn}
      <button class="reg-customers-btn reg-customers-header-btn" data-perm="customer.manage" onclick="openCustomerManager()" title="Customers">
        <i class="fas fa-users"></i><span class="reg-customers-label"> Customers</span>
      </button>
      <button class="reg-icon-btn refresh" id="reg-refresh-btn" title="Refresh">
        <i class="fas fa-sync-alt"></i>
      </button>
    </div>
  </div>

  <div class="reg-filter-bar">
    ${filterMarkup}
  </div>

  <div class="register-table-container">
    <table class="register-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Bill No</th>
          <th>Guest</th>
          <th class="reg-th-persons">Persons</th>
          <th>Contact</th>
          <th>Room</th>
          <th>Check-in</th>
          <th>Check-out</th>
          <th>Days</th>
          <th>Rate</th>
          <th>Services</th>
          <th>Total</th>
          <th>Payment</th>
          <th>Status</th>
          <th></th>
        </tr>
      </thead>
      <tbody id="reg-table-body">
        <tr><td colspan="15">
          <div class="reg-state">
            <i class="fas fa-book-open"></i>
            <p>Open this tab to load register entries</p>
          </div>
        </td></tr>
      </tbody>
    </table>
  </div>
</div>

<!-- ── Password prompt modal ──────────────────────────────────────────── -->
<div id="rpm-overlay" class="rpm-overlay" role="dialog" aria-modal="true">
  <div class="rpm-box">
    <h3><i class="fas fa-lock" style="margin-right:.35rem;"></i>Manager Access</h3>
    <label for="rpm-password">Enter manager password</label>
    <input type="password" id="rpm-password" placeholder="Password" autocomplete="off" />
    <div id="rpm-err" class="rpm-err"></div>
    <div class="rpm-actions">
      <button class="rpm-cancel-btn" id="rpm-cancel">Cancel</button>
      <button class="rpm-submit-btn" id="rpm-submit">Open Payments</button>
    </div>
  </div>
</div>

<!-- ── ID Documents modal ─────────────────────────────────────────────── -->
<div id="rdoc-overlay" class="rdoc-overlay" role="dialog" aria-modal="true">
  <div class="rdoc-modal">
    <div class="rdoc-header">
      <h3><i class="fas fa-id-card" style="margin-right:.4rem;"></i>ID Documents</h3>
      <button class="rdoc-close" id="rdoc-close" title="Close">&times;</button>
    </div>
    <div class="rdoc-body">
      <div class="rdoc-meta" id="rdoc-meta"></div>
      <div id="rdoc-content"><div class="rdoc-spinner">Loading…</div></div>
    </div>
  </div>
</div>

<!-- ── Payments detail modal ──────────────────────────────────────────── -->
<div id="rp-overlay" class="rp-overlay" role="dialog" aria-modal="true">
  <div class="rp-modal">
    <div class="rp-header">
      <h3><i class="fas fa-money-bill-wave" style="margin-right:.4rem;"></i>Payment Records</h3>
      <button class="rp-close" id="rp-close" title="Close">&times;</button>
    </div>
    <div class="rp-body">
      <div class="rp-meta" id="rp-meta"></div>
      <div id="rp-content">
        <div class="rp-spinner">Loading…</div>
      </div>
      <div id="rp-services-section" style="padding: 0 0 .5rem;"></div>
    </div>
  </div>
</div>

<!-- ── Delete confirmation modal ──────────────────────────────────────── -->
<div id="rpd-overlay" class="rpd-overlay" role="dialog" aria-modal="true">
  <div class="rpd-box">
    <div class="rpd-header">
      <i class="fas fa-exclamation-triangle"></i>
      <h3>Delete Transaction?</h3>
    </div>
    <div class="rpd-body">
      <p class="rpd-warn">You are about to permanently delete this payment record. Please review the details below:</p>
      <div class="rpd-detail">
        <div class="rpd-row"><span class="lbl">Amount</span><span class="val amt" id="rpd-amount">—</span></div>
        <div class="rpd-row"><span class="lbl">Method</span><span class="val" id="rpd-method">—</span></div>
        <div class="rpd-row"><span class="lbl">Type</span><span class="val" id="rpd-type">—</span></div>
        <div class="rpd-row"><span class="lbl">Date</span><span class="val" id="rpd-date">—</span></div>
      </div>
      <div class="rpd-notice">
        <i class="fas fa-info-circle"></i>
        <span>This <strong>cannot be undone</strong>. If the room is still occupied, the balance will be adjusted accordingly.</span>
      </div>
      <div class="rpd-actions">
        <button class="rpd-cancel-btn" id="rpd-cancel">Cancel</button>
        <button class="rpd-confirm-btn" id="rpd-confirm">
          <i class="fas fa-trash"></i> Yes, Delete
        </button>
      </div>
    </div>
  </div>
</div>

<!-- ── Bill viewer modal ──────────────────────────────────────────────── -->
<div id="reg-bill-overlay" class="bill-modal" role="dialog" aria-modal="true">
  <div class="bill-content">
    <div class="bill-header">
      <h2><i class="fas fa-receipt" style="margin-right:.4rem;"></i>Bill</h2>
      <button class="bill-close" id="reg-bill-close" title="Close">&times;</button>
    </div>
    <!-- View toggle — a control only. Sits outside #reg-bill-print-area so it
         never appears in the printout (Print clones only the print area).
         Hidden until openRegBill finds a consolidatable folio. -->
    <div class="bl-view-toggle" id="reg-view-toggle" style="display:none;">
      <span class="bl-view-toggle-label">View</span>
      <button type="button" class="bl-vt-btn" id="reg-vt-detailed" data-view="detailed">Detailed</button>
      <button type="button" class="bl-vt-btn" id="reg-vt-consolidated" data-view="consolidated">Consolidated</button>
      <span class="bl-vt-hint" id="reg-vt-hint"></span>
    </div>
    <div id="reg-bill-print-area">
      <div class="reg-state"><div class="reg-loader"></div><p>Loading…</p></div>
    </div>
    <div class="bill-actions">
      <button class="action-btn btn-secondary" id="reg-bill-close-btn">Close</button>
      <!-- Save & Share: generates PDF (or reuses stored pdf_url) and
           opens the existing WhatsApp send modal. Reuses bills.js's
           flow via window.cibaraSaveAndShareBill so there is one
           code path. -->
      <button class="bl-bill-save-btn" id="reg-bill-save"
              title="Save PDF and share on WhatsApp">
        <i class="fab fa-whatsapp"></i> Save &amp; Share
      </button>
      <button class="action-btn btn-secondary" id="reg-bill-editprice"
              data-roles="admin"
              title="Correct the room tariff and recompute charges, GST and balance">
        <i class="fas fa-pen"></i> Edit Price
      </button>
      <!-- Generate Invoice: admin-only. Shown (via _syncGenInvoiceBtn) only
           for a checked-out stay whose bill is finalized but has no PDF yet,
           and only within 5 days of checkout. POSTs /generate_invoice. -->
      <button class="action-btn btn-secondary" id="reg-bill-geninvoice"
              data-roles="admin" style="display:none;"
              title="Generate the GST invoice PDF for this checked-out stay">
        <i class="fas fa-file-invoice"></i> Generate Invoice
      </button>
      <button class="action-btn btn-primary" id="reg-bill-print-btn">
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
  // Default for everyone is now "Last 3 Days" (today + 2 prior).
  // The custom date-range picker is admin-only — manager/housekeeping see
  // only the quick-range buttons. The picker container is removed from the
  // DOM by buildHTML() for non-admin, so flatpickr init is skipped.
  function setDefaults() {
    const today = todayStr();
    const last3Start = nDaysAgoStr(2);
    state.dateRange.start = last3Start;
    state.dateRange.end   = today;

    const el = dom("reg-date-range");
    if (!el || !window.flatpickr) return;   // non-admin: picker not in DOM

    state._datePicker = flatpickr(el, {
      mode: "range",
      dateFormat: "Y-m-d",   // internal ISO format — avoids maxDate mis-parsing
      altInput: true,         // show human-friendly text to user
      altFormat: "d M Y",     // display: "17 Mar 2026"
      defaultDate: [last3Start, today],
      maxDate: today,
      disableMobile: true,
      onChange: function (selectedDates) {
        if (selectedDates.length === 2) {
          state.dateRange.start = dateToYMD(selectedDates[0]);
          state.dateRange.end   = dateToYMD(selectedDates[1]);
          // clear quick-btn active (manual calendar pick)
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
        else if (range === "last3") start = nDaysAgoStr(2);  // today + 2 prior = 3 days
        else if (range === "month") start = nDaysAgoStr(29);
        // (week intentionally removed — not in the chip set anymore)
        else start = today;
        state.dateRange.start = start;
        state.dateRange.end   = today;
        // Pass false as 2nd arg so setDate does NOT fire onChange → avoids a
        // duplicate loadData call that gets blocked when a prior load is in flight
        if (state._datePicker) state._datePicker.setDate([start, today], false);
        document.querySelectorAll(".reg-quick-btn").forEach(b => b.classList.remove("rq-active"));
        btn.classList.add("rq-active");
        // Always force-reload, even if a previous load is still running
        state.loading = false;
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

    // Delegated: group toggle + pay button + bill link
    const tbody = dom("reg-table-body");
    if (tbody) {
      tbody.addEventListener("click", (e) => {
        const hdr = e.target.closest(".date-group-header");
        if (hdr) { toggleGroup(hdr); return; }

        // Paged rendering — "Show more" extends the cap and re-renders
        const lmBtn = e.target.closest(".reg-load-more-btn");
        if (lmBtn) {
          state.visibleCount += PAGE_SIZE;
          renderTable();
          return;
        }

        // Bill number click → open bill viewer
        const billLink = e.target.closest(".reg-bill-link");
        if (billLink) {
          e.stopPropagation();
          openRegBill(billLink.dataset.id);
          return;
        }

        // Generate Invoice (admin) — open a confirmation popup, then mint.
        const genInvRowBtn = e.target.closest(".reg-geninv-btn");
        if (genInvRowBtn) {
          e.stopPropagation();
          const gid = genInvRowBtn.dataset.id;
          if (!gid) return;
          const fullEntry = state.filteredEntries.find((en) => en.id === gid) || { id: gid };
          _openGenInvoiceModal(fullEntry);
          return;
        }

        const payBtn = e.target.closest(".reg-pay-btn");
        if (payBtn) {
          e.stopPropagation();
          const room      = payBtn.dataset.room;
          const guestName = decodeURIComponent(payBtn.dataset.guest || "");
          const checkin   = payBtn.dataset.checkin;
          // Look up full entry so services + bill id are available in modal
          const fullEntry = state.filteredEntries.find(
            en => en.room === room && en.guest_name === guestName && en.checkin_time === checkin
          ) || { room, guest_name: guestName, checkin_time: checkin };
          _openPasswordPrompt(fullEntry);
          return;
        }

        // History button — opens the room-history popover. Payment
        // attribution lives in the dedicated payment list (₹ button),
        // so this popover deliberately shows ONLY room-action history
        // (cleaned / inspected / booked / checked-in / time edits).
        const histBtn = e.target.closest(".reg-history-btn");
        if (histBtn) {
          e.stopPropagation();
          const room = histBtn.dataset.room;
          const entryId = histBtn.dataset.entryId;
          const fullEntry = state.filteredEntries.find(
            en => (en.id && en.id === entryId) || en.room === room
          ) || { room };
          if (window.CibaraRoomAttribution) {
            window.CibaraRoomAttribution.openForButton(histBtn, fullEntry);
          }
          return;
        }

        // Check-in cell click (admin) → edit this stay's check-in date/time.
        const ciCell = e.target.closest(".reg-ci-cell");
        if (ciCell) {
          const can = window.CibaraAuth &&
            typeof window.CibaraAuth.userCan === "function" &&
            window.CibaraAuth.userCan("stay.times.edit");
          if (!can) return;   // non-admins: cell is inert
          e.stopPropagation();
          const tid = ciCell.dataset.entryId;
          const fullEntry =
            state.filteredEntries.find((en) => en.id && en.id === tid) ||
            state.allEntries.find((en) => en.id && en.id === tid);
          if (fullEntry) _openStayTimesModal(fullEntry);
          return;
        }

        const docBtn = e.target.closest(".reg-doc-btn");
        if (docBtn) {
          e.stopPropagation();
          if (docBtn.dataset.mode === "upload") {
            _openDocUploadPicker(docBtn);
          } else {
            _openDocsModal(
              docBtn.dataset.mobile,
              decodeURIComponent(docBtn.dataset.guest || "")
            );
          }
        }
      });
    }

    // Doc modal close
    const rdocClose = dom("rdoc-close");
    if (rdocClose) rdocClose.addEventListener("click", _closeDocsModal);
    const rdocOverlay = dom("rdoc-overlay");
    if (rdocOverlay) rdocOverlay.addEventListener("click", (e) => {
      if (e.target === rdocOverlay) _closeDocsModal();
    });

    // Password modal buttons
    const rpmCancel = dom("rpm-cancel");
    const rpmSubmit = dom("rpm-submit");
    const rpmPwd    = dom("rpm-password");
    if (rpmCancel) rpmCancel.addEventListener("click", _closePasswordPrompt);
    if (rpmSubmit) rpmSubmit.addEventListener("click", _submitPassword);
    if (rpmPwd)    rpmPwd.addEventListener("keydown", (e) => {
      if (e.key === "Enter") _submitPassword();
    });

    // Payments modal close
    const rpClose = dom("rp-close");
    if (rpClose) rpClose.addEventListener("click", _closePaymentsModal);

    // Bill viewer modal close
    const regBillClose = dom("reg-bill-close");
    if (regBillClose) regBillClose.addEventListener("click", _closeRegBill);

    const regBillCloseBtn = dom("reg-bill-close-btn");
    if (regBillCloseBtn) regBillCloseBtn.addEventListener("click", _closeRegBill);

    // ── Save & Share ──────────────────────────────────────────────────
    // Delegates to bills.js's combined helper. Disables the button while
    // the PDF round-trip is in flight so users don't double-fire.
    const regBillSave = dom("reg-bill-save");
    if (regBillSave) {
      regBillSave.addEventListener("click", async function () {
        if (!_regOpenBillId || !_regOpenBillData) return;
        if (typeof window.cibaraSaveAndShareBill !== "function") {
          alert("Save & Share unavailable — open the Bills tab once to initialise this feature.");
          return;
        }
        const _orig = regBillSave.innerHTML;
        regBillSave.disabled = true;
        regBillSave.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving PDF…';
        try {
          const ok = await window.cibaraSaveAndShareBill(_regOpenBillId, _regOpenBillData);
          if (ok) {
            // WhatsApp modal is now open; close the bill modal so the
            // user sees the send dialog without overlap.
            _closeRegBill();
          }
        } finally {
          regBillSave.disabled = false;
          regBillSave.innerHTML = _orig;
        }
      });
    }

    // ── Recalculate (admin-only) ──────────────────────────────────────
    // POSTs /recalculate_bill, then re-opens the bill modal so the
    // refreshed totals render. Admin gating is enforced server-side by
    // @requires_permission("payment.edit") and client-side by
    // data-roles="admin" on the button + this click-time check.
    const regBillRecalc = dom("reg-bill-recalc");
    if (regBillRecalc) {
      regBillRecalc.addEventListener("click", async function () {
        if (!_regOpenBillId) return;
        const _auth = window.CibaraAuth;
        if (!(_auth && _auth.isAdmin && _auth.isAdmin())) {
          alert("Only admin users can recalculate bills.");
          return;
        }
        const _orig = regBillRecalc.innerHTML;
        regBillRecalc.disabled = true;
        regBillRecalc.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Recalculating…';
        try {
          const res = await apiFetch("/recalculate_bill", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ bill_id: _regOpenBillId }),
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data && data.success) {
            alert(
              "Bill recalculated.\n" +
              "Cash: \u20B9" + (data.payment_cash ?? 0) + "\n" +
              "Online: \u20B9" + (data.payment_online ?? 0) + "\n" +
              "Balance: \u20B9" + (data.balance ?? 0)
            );
            await openRegBill(_regOpenBillId);
          } else {
            const msg = (data && data.message) || ("Recalculate failed (HTTP " + res.status + ").");
            alert("Error: " + msg);
          }
        } catch (err) {
          console.error("[Register] recalculate failed:", err);
          alert("Network error during recalculate.");
        } finally {
          regBillRecalc.disabled = false;
          regBillRecalc.innerHTML = _orig;
        }
      });
    }

    // Edit Price (admin-only): correct per-night tariff -> recompute charges/GST/balance.
    const regBillEditPrice = dom("reg-bill-editprice");
    if (regBillEditPrice) {
      regBillEditPrice.addEventListener("click", function () {
        if (!_regOpenBillId) return;
        const _a = window.CibaraAuth;
        if (!(_a && _a.isAdmin && _a.isAdmin())) { alert("Only admin users can edit the room price."); return; }
        _openRegRpriceModal();
      });
    }
    function _openRegRpriceModal() {
      const ex = document.getElementById("reg-rprice-backdrop"); if (ex) ex.remove();
      const d = _regOpenBillData || {};
      const rct = Number(d.room_charges_total || 0), days = Number(d.days_stayed || 0);
      const perNight = Number(d.room_price_per_night || 0) || (days > 0 && rct > 0 ? Math.round(rct / days) : "");
      const back = document.createElement("div");
      back.id = "reg-rprice-backdrop";
      back.setAttribute("style", "position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:100000;display:flex;align-items:center;justify-content:center;");
      back.innerHTML =
        '<div style="background:#fff;width:min(440px,92vw);border-radius:12px;padding:20px 22px;box-shadow:0 10px 40px rgba(0,0,0,.25);">' +
          '<h3 style="margin:0 0 4px;font-size:18px;">Edit room price</h3>' +
          '<p style="margin:0 0 12px;font-size:13px;color:#555;line-height:1.45;">Sets the actual per-night tariff. Room charges, GST and the balance are recomputed from it. To change cash vs online, use the Payment cell in the Bills table.</p>' +
          '<div style="font-size:13px;color:#374151;background:#f3f4f6;border-radius:8px;padding:8px 10px;margin-bottom:12px;">Current room charges: <b>₹' + (rct || 0) + '</b>' + (days > 0 ? ' (' + days + ' night' + (days === 1 ? '' : 's') + ')' : '') + '.</div>' +
          '<label style="display:block;font-size:13px;font-weight:600;margin-bottom:4px;">New price per night (₹)</label>' +
          '<input id="reg-rprice-input" type="number" min="0" step="1" inputmode="numeric" style="width:100%;box-sizing:border-box;padding:9px 10px;font-size:15px;border:1px solid #cbd5e1;border-radius:8px;margin-bottom:12px;" />' +
          '<label style="display:block;font-size:13px;font-weight:600;margin-bottom:4px;">Reason (recorded in the audit log)</label>' +
          '<input id="reg-rprice-reason" type="text" maxlength="500" placeholder="e.g. wrong tariff entered at checkout" style="width:100%;box-sizing:border-box;padding:9px 10px;font-size:14px;border:1px solid #cbd5e1;border-radius:8px;margin-bottom:8px;" />' +
          '<div id="reg-rprice-msg" style="font-size:13px;min-height:18px;margin-bottom:8px;color:#b91c1c;"></div>' +
          '<div style="display:flex;gap:10px;justify-content:flex-end;"><button id="reg-rprice-cancel" class="action-btn btn-secondary" type="button">Cancel</button><button id="reg-rprice-save" class="action-btn btn-primary" type="button">Recompute &amp; Save</button></div>' +
        '</div>';
      document.body.appendChild(back);
      const inp = document.getElementById("reg-rprice-input"), rsn = document.getElementById("reg-rprice-reason");
      const msg = document.getElementById("reg-rprice-msg"), saveB = document.getElementById("reg-rprice-save"), cancelB = document.getElementById("reg-rprice-cancel");
      if (inp) { inp.value = perNight === "" ? "" : String(perNight); inp.focus(); inp.select(); }
      function _close() { back.remove(); }
      if (cancelB) cancelB.addEventListener("click", _close);
      back.addEventListener("click", function (e) { if (e.target === back) _close(); });
      if (saveB) saveB.addEventListener("click", async function () {
        const raw = ((inp && inp.value) || "").trim(), num = Number(raw);
        if (raw === "" || isNaN(num) || num < 0 || !Number.isInteger(num)) { if (msg) { msg.style.color = "#b91c1c"; msg.textContent = "Enter a whole, non-negative rupee amount."; } return; }
        const _o = saveB.innerHTML; saveB.disabled = true; saveB.innerHTML = "Saving…";
        if (msg) { msg.style.color = "#374151"; msg.textContent = "Recomputing…"; }
        try {
          const res = await apiFetch("/edit_bill_room_price", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bill_id: _regOpenBillId, room_price_per_night: parseInt(raw, 10), reason: ((rsn && rsn.value) || "").trim() }) });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data && data.success) {
            _close();
            alert("Room price updated.\n" + "Price/night: ₹" + (data.room_price_per_night ?? raw) + "\n" + "Room charges: ₹" + (data.room_charges_total ?? 0) + "\n" + "GST: ₹" + (data.gst_amount ?? 0) + " (" + (data.gst_rate ?? 0) + "%)\n" + "Total: ₹" + (data.total_amount ?? 0) + "\n" + "Balance: ₹" + (data.balance ?? 0) + "  [" + (data.status || "") + "]");
            await openRegBill(_regOpenBillId);
          } else { if (msg) { msg.style.color = "#b91c1c"; msg.textContent = (data && data.message) || ("Edit failed (HTTP " + res.status + ")."); } }
        } catch (err) { console.error("[Register] edit price failed:", err); if (msg) { msg.style.color = "#b91c1c"; msg.textContent = "Network error."; } }
        finally { saveB.disabled = false; saveB.innerHTML = _o; }
      });
    }

    // ── Generate Invoice (admin-only) ─────────────────────────────────
    const regBillGenInv = dom("reg-bill-geninvoice");
    if (regBillGenInv) {
      regBillGenInv.addEventListener("click", async function () {
        if (!_regOpenBillId) return;
        const _auth = window.CibaraAuth;
        if (!(_auth && _auth.isAdmin && _auth.isAdmin())) {
          alert("Only admin users can generate invoices.");
          return;
        }
        const _orig = regBillGenInv.innerHTML;
        regBillGenInv.disabled = true;
        regBillGenInv.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating\u2026';
        try {
          const res = await apiFetch("/generate_invoice/" + _regOpenBillId, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    "{}",
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data && data.success) {
            alert(data.message || "Invoice generated.");
            await openRegBill(_regOpenBillId);
          } else {
            alert("Error: " + ((data && data.message) ||
                  ("Generate failed (HTTP " + res.status + ").")));
          }
        } catch (err) {
          console.error("[Register] generate invoice failed:", err);
          alert("Network error during invoice generation.");
        } finally {
          regBillGenInv.disabled = false;
          regBillGenInv.innerHTML = _orig;
        }
      });
    }

    // ── Print (one-page clone approach) ───────────────────────────────
    // Plain window.print() on this modal previously produced two pages
    // because the live app layout contributes phantom page height. The
    // bills.js print path solved this by cloning the bill HTML to body,
    // setting body.bl-printing so the CSS hides everything else, then
    // restoring on completion. Reuse the same approach here so Bills
    // tab and Register tab print identically.
    const regBillPrintBtn = dom("reg-bill-print-btn");
    if (regBillPrintBtn) {
      regBillPrintBtn.addEventListener("click", function () {
        const area = dom("reg-bill-print-area");
        if (!area || !area.innerHTML.trim()) return;
        var old = document.getElementById("bl-print-clone");
        if (old) old.remove();
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
        // Record the print on the bill's activity trail (fire-and-forget).
        // The bill doc's denormalised counter is bumped server-side and the
        // Bills tab picks it up via its Firestore snapshot listener.
        try {
          if (_regOpenBillId && typeof window.apiFetch === "function") {
            window.apiFetch("/log_bill_activity", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ bill_id: _regOpenBillId, kind: "print" }),
            }).catch(function () {});
          }
        } catch (_e) { /* never break printing */ }
      });
    }

    // ── View toggle (Detailed / Consolidated) ──────────────────────────────
    // Re-renders the open bill in the chosen view. The Print button is
    // unchanged — it clones the print area, so it always prints the view
    // currently on screen.
    const regViewToggle = dom("reg-view-toggle");
    if (regViewToggle) {
      regViewToggle.addEventListener("click", async (e) => {
        const btn = e.target.closest(".bl-vt-btn");
        if (!btn || !_regOpenBillId) return;
        const mode = btn.dataset.view;
        if (mode !== "detailed" && mode !== "consolidated") return;
        const prevMode = _regOpenBillView;
        _regBillViewMode = mode;
        try { localStorage.setItem("cibara_bill_view", mode); } catch (_e) {}
        if (mode !== prevMode) {
          try {
            await _renderRegOpenBill(mode);
          } catch (err) {
            console.error("[Register] view toggle re-render failed:", err);
            return;   // leave the current view on screen rather than blanking it
          }
        }
        _syncRegViewToggle();
      });
    }

    // Close modals on overlay click
    const rpmOverlay = dom("rpm-overlay");
    if (rpmOverlay) rpmOverlay.addEventListener("click", (e) => {
      if (e.target === rpmOverlay) _closePasswordPrompt();
    });
    const rpOverlay = dom("rp-overlay");
    if (rpOverlay) rpOverlay.addEventListener("click", (e) => {
      if (e.target === rpOverlay) _closePaymentsModal();
    });
    const regBillOverlay = dom("reg-bill-overlay");
    if (regBillOverlay) regBillOverlay.addEventListener("click", (e) => {
      if (e.target === regBillOverlay) _closeRegBill();
    });

    // Delete confirm modal
    const rpdCancel = dom("rpd-cancel");
    if (rpdCancel) rpdCancel.addEventListener("click", _closeDeleteModal);
    const rpdOverlay = dom("rpd-overlay");
    if (rpdOverlay) rpdOverlay.addEventListener("click", (e) => {
      if (e.target === rpdOverlay) _closeDeleteModal();
    });
    // Escape key closes the delete modal
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && dom("rpd-overlay")?.classList.contains("show")) {
        _closeDeleteModal();
      }
    });
  }

  // ── Load data from server ────────────────────────────────────────────────────
  async function loadData(force) {
    const { start, end } = state.dateRange;
    if (!start || !end) return;

    // Non-forced calls: skip if same range already loaded or a load is in flight
    const rangeKey = `${start}_${end}`;
    if (!force) {
      if (state.loading) return;
      if (state.lastLoadedRange === rangeKey) {
        applyFilters();
        return;
      }
    }

    // Stamp this request; any earlier in-flight fetch will discard its result
    const myReqId = ++state._reqId;
    state.loading = true;
    showLoading();

    try {
      const res = await apiFetch("/get_register_data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_date: start, end_date: end }),
      });
      if (myReqId !== state._reqId) return; // a newer request superseded this one
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (myReqId !== state._reqId) return;
      if (data.success) {
        state.allEntries = data.entries || [];
        state.lastLoadedRange = rangeKey;
        applyFilters();
      } else {
        showError(data.message || "Failed to load");
      }
    } catch (err) {
      if (myReqId !== state._reqId) return;
      console.error("[Register]", err);
      showError("Network error — " + err.message);
    } finally {
      if (myReqId === state._reqId) state.loading = false;
    }
  }

  // ── Silent refresh (no spinner) — used by remote-sync event handlers ─────────
  // Fetches the current date range silently, then diffs and patches the DOM.
  async function loadDataSilent() {
    const { start, end } = state.dateRange;
    if (!start || !end || state.loading) return;

    try {
      const res = await apiFetch("/get_register_data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_date: start, end_date: end }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (!data.success) return;

      const newEntries = data.entries || [];
      _diffAndPatch(newEntries);
      state.allEntries = newEntries;
      state.lastLoadedRange = `${start}_${end}`;
    } catch (err) {
      console.warn("[Register] silent refresh failed:", err.message);
    }
  }

  // Compare new data with current DOM; only re-render rows that actually changed.
  // Falls back to a quiet applyFilters() (no spinner) if rows are added/removed.
  function _diffAndPatch(newEntries) {
    const tbody = dom("reg-table-body");
    if (!tbody) { state.allEntries = newEntries; applyFilters(); return; }

    // Build id sets to detect structural changes
    const oldIds = new Set(state.allEntries.map(e => e.id).filter(Boolean));
    const newIds = new Set(newEntries.map(e => e.id).filter(Boolean));
    const hasStructural =
      newEntries.some(e => e.id && !oldIds.has(e.id)) ||
      state.allEntries.some(e => e.id && !newIds.has(e.id));

    if (hasStructural) {
      // New or removed rows — silent full re-render (no spinner)
      state.allEntries = newEntries;
      applyFilters();
      return;
    }

    // Only value changes — patch each modified row in-place
    const oldById = Object.fromEntries(
      state.allEntries.filter(e => e.id).map(e => [e.id, e])
    );
    let needsDocRefresh = false;

    for (const newEntry of newEntries) {
      if (!newEntry.id) continue;
      const old = oldById[newEntry.id];
      if (!old) continue;
      if (JSON.stringify(old) === JSON.stringify(newEntry)) continue; // unchanged

      const tr = tbody.querySelector(`tr[data-entry-id="${newEntry.id}"]`);
      if (!tr) continue;

      const dk = (newEntry.checkin_time || "").split(" ")[0] || "unknown";
      const tmp = document.createElement("tbody");
      tmp.innerHTML = rowHTML(newEntry, dk);
      const newRow = tmp.querySelector("tr");
      if (!newRow) continue;

      tr.replaceWith(newRow);
      // Brief yellow flash to show the change
      newRow.style.transition = "none";
      newRow.style.backgroundColor = "#fffbcc";
      requestAnimationFrame(() => {
        newRow.style.transition = "background-color 0.8s ease";
        newRow.style.backgroundColor = "";
      });
      needsDocRefresh = true;
    }

    if (needsDocRefresh) _checkAndShowDocButtons();
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
    state.visibleCount = PAGE_SIZE; // new filter/search -> back to first page
    renderTable();
    _checkAndShowDocButtons();
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  // ── Check-in time editor (admin) ──────────────────────────────────────
  // Opens from a click on the register row's check-in cell. Two compact
  // steps — DATE (calendar) then TIME (clock dial) — with value chips to
  // jump between them, so the whole modal fits one phone screen. Picking
  // a day auto-advances to the clock. Completed stays → /update_stay_times
  // (checkout sent back unchanged); active stays → /update_checkin_time.
  let _stayTimesEntry = null;
  let _rstView = "";           // "YYYY-MM" month shown in the calendar
  let _rstDate = "";           // selected "YYYY-MM-DD"
  let _rstH = 12, _rstM = 0;   // selected time
  let _rstStep = "date";       // "date" | "time"
  let _rstClockMode = "hour";  // "hour" | "min"

  const _RST_R_OUTER = 78, _RST_R_INNER = 50, _RST_C = 98;

  function _rstToday() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
      "-" + String(d.getDate()).padStart(2, "0");
  }

  function _ensureStayTimesDom() {
    if (dom("rst-overlay")) return;
    const style = document.createElement("style");
    style.id = "rst-styles";
    style.textContent = `
      #rst-overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);display:none;
        align-items:center;justify-content:center;z-index:10080;padding:10px;}
      #rst-overlay.show{display:flex;}
      .rst-box{background:#fff;border-radius:16px;max-width:340px;width:100%;
        padding:.85rem .95rem;box-shadow:0 12px 44px rgba(0,0,0,.28);
        max-height:94vh;overflow-y:auto;}
      .rst-head{display:flex;justify-content:space-between;align-items:center;gap:.5rem;}
      .rst-title{font-weight:700;font-size:.95rem;color:#0f172a;}
      .rst-sub{font-size:.7rem;color:#64748b;margin-top:1px;overflow:hidden;
        text-overflow:ellipsis;white-space:nowrap;}
      .rst-x{background:none;border:0;font-size:1.35rem;line-height:1;color:#94a3b8;
        cursor:pointer;padding:0 .1rem;flex-shrink:0;}
      .rst-x:hover{color:#475569;}
      .rst-chips{display:flex;gap:.4rem;margin-top:.6rem;}
      .rst-chip{flex:1;display:flex;align-items:center;justify-content:center;
        gap:.35rem;border:1.5px solid #e2e8f0;background:#fff;border-radius:10px;
        min-height:38px;font-size:.85rem;font-weight:700;color:#334155;
        cursor:pointer;font-variant-numeric:tabular-nums;}
      .rst-chip i{font-size:.72rem;color:#94a3b8;}
      .rst-chip.on{border-color:#1d4ed8;background:#eff6ff;color:#1d4ed8;}
      .rst-chip.on i{color:#1d4ed8;}
      .rst-step{margin-top:.55rem;}
      /* — calendar (compact) — */
      .rst-cal-head{display:flex;align-items:center;justify-content:space-between;
        margin-bottom:.35rem;}
      .rst-cal-title{font-weight:700;color:#0f172a;font-size:.85rem;}
      .rst-nav{border:1px solid #e2e8f0;background:#fff;border-radius:8px;
        width:30px;height:30px;cursor:pointer;font-size:.95rem;color:#334155;}
      .rst-nav:hover{background:#f8fafc;}
      .rst-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px;}
      .rst-dow{font-size:.6rem;color:#94a3b8;text-align:center;font-weight:700;
        padding:1px 0;text-transform:uppercase;}
      .rst-day{border-radius:8px;min-height:30px;display:flex;align-items:center;
        justify-content:center;font-size:.8rem;cursor:pointer;user-select:none;
        background:#fff;color:#0f172a;border:1px solid transparent;}
      .rst-day:hover{background:#f1f5f9;}
      .rst-day.today{border-color:#94a3b8;font-weight:700;}
      .rst-day.sel{background:#1d4ed8;color:#fff;font-weight:700;}
      .rst-day.disabled{opacity:.28;cursor:not-allowed;}
      /* — clock (compact) — */
      .rst-time-display{display:flex;align-items:center;justify-content:center;
        gap:.25rem;margin-bottom:.4rem;}
      .rst-td-seg{border:0;border-radius:9px;padding:.15rem .6rem;font-size:1.35rem;
        font-weight:800;cursor:pointer;background:#f1f5f9;color:#334155;
        line-height:1.3;font-variant-numeric:tabular-nums;}
      .rst-td-seg.on{background:#dbeafe;color:#1d4ed8;}
      .rst-td-colon{font-size:1.35rem;font-weight:800;color:#94a3b8;line-height:1;}
      .rst-clock-wrap{display:flex;justify-content:center;}
      .rst-clock{width:196px;height:196px;border-radius:50%;background:#f1f5f9;
        position:relative;touch-action:none;user-select:none;cursor:pointer;}
      .rst-hand{position:absolute;left:50%;top:50%;width:2px;background:#1d4ed8;
        transform-origin:0 0;pointer-events:none;}
      .rst-center-dot{position:absolute;left:50%;top:50%;width:6px;height:6px;
        margin:-3px 0 0 -3px;border-radius:50%;background:#1d4ed8;pointer-events:none;}
      .rst-knob{position:absolute;width:30px;height:30px;margin:-15px 0 0 -15px;
        border-radius:50%;background:#1d4ed8;pointer-events:none;opacity:.95;}
      .rst-lbl{position:absolute;width:26px;height:26px;margin:-13px 0 0 -13px;
        border-radius:50%;display:flex;align-items:center;justify-content:center;
        font-size:.74rem;font-weight:600;color:#334155;pointer-events:none;}
      .rst-lbl.inner{font-size:.62rem;color:#94a3b8;}
      .rst-lbl.sel{color:#fff;font-weight:700;}
      /* — preview + footer — */
      .rst-preview{margin-top:.55rem;font-size:.72rem;font-weight:600;color:#475569;
        background:#f8fafc;border-radius:9px;padding:.4rem .6rem;line-height:1.45;}
      .rst-preview .warn{color:#b45309;}
      .rst-foot{display:flex;gap:.5rem;margin-top:.65rem;}
      .rst-save{flex:1;min-height:42px;border-radius:10px;border:0;background:#1d4ed8;
        color:#fff;font-weight:700;font-size:.88rem;cursor:pointer;}
      .rst-save:hover{background:#1e40af;}
      .rst-save:disabled{opacity:.6;cursor:default;}
      .rst-cancel{flex:0 0 auto;background:transparent;border:0;color:#64748b;
        cursor:pointer;padding:0 .7rem;font-weight:600;font-size:.85rem;}
    `;
    document.head.appendChild(style);

    const ov = document.createElement("div");
    ov.id = "rst-overlay";
    ov.innerHTML = `
      <div class="rst-box">
        <div class="rst-head">
          <div style="min-width:0;">
            <div class="rst-title">Edit check-in</div>
            <div class="rst-sub" id="rst-sub"></div>
          </div>
          <button class="rst-x" id="rst-close" aria-label="Close">&times;</button>
        </div>
        <div class="rst-chips">
          <button class="rst-chip on" id="rst-chip-date">
            <i class="fas fa-calendar-alt"></i><span id="rst-chip-date-val">—</span>
          </button>
          <button class="rst-chip" id="rst-chip-time">
            <i class="fas fa-clock"></i><span id="rst-chip-time-val">—</span>
          </button>
        </div>
        <div class="rst-step" id="rst-step-date">
          <div class="rst-cal-head">
            <button class="rst-nav" id="rst-prev">&#8249;</button>
            <div class="rst-cal-title" id="rst-cal-title"></div>
            <button class="rst-nav" id="rst-next">&#8250;</button>
          </div>
          <div class="rst-grid" id="rst-grid"></div>
        </div>
        <div class="rst-step" id="rst-step-time" hidden>
          <div class="rst-time-display">
            <button class="rst-td-seg on" id="rst-td-hour">00</button>
            <span class="rst-td-colon">:</span>
            <button class="rst-td-seg" id="rst-td-min">00</button>
          </div>
          <div class="rst-clock-wrap">
            <div class="rst-clock" id="rst-clock"></div>
          </div>
        </div>
        <div class="rst-preview" id="rst-preview">&nbsp;</div>
        <div class="rst-foot">
          <button class="rst-save" id="rst-save">Save</button>
          <button class="rst-cancel" id="rst-cancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    ov.addEventListener("click", (ev) => { if (ev.target === ov) ov.classList.remove("show"); });
    dom("rst-close").addEventListener("click", () => ov.classList.remove("show"));
    dom("rst-cancel").addEventListener("click", () => ov.classList.remove("show"));
    dom("rst-prev").addEventListener("click", () => _rstShiftMonth(-1));
    dom("rst-next").addEventListener("click", () => _rstShiftMonth(1));
    dom("rst-chip-date").addEventListener("click", () => _rstShowStep("date"));
    dom("rst-chip-time").addEventListener("click", () => _rstShowStep("time"));
    dom("rst-td-hour").addEventListener("click", () => _rstSetClockMode("hour"));
    dom("rst-td-min").addEventListener("click", () => _rstSetClockMode("min"));
    _rstBindClock();
    dom("rst-save").addEventListener("click", _submitStayTimes);
  }

  // ── Steps + value chips ──
  function _rstShowStep(step) {
    _rstStep = step;
    const sd = dom("rst-step-date"), st = dom("rst-step-time");
    if (sd) sd.hidden = step !== "date";
    if (st) st.hidden = step !== "time";
    dom("rst-chip-date").classList.toggle("on", step === "date");
    dom("rst-chip-time").classList.toggle("on", step === "time");
    if (step === "time") _rstRenderClock();
    _rstSyncChips();
  }

  function _rstSyncChips() {
    const dv = dom("rst-chip-date-val"), tv = dom("rst-chip-time-val");
    if (dv) {
      const d = _rstDate ? new Date(_rstDate + "T00:00:00") : null;
      dv.textContent = d && !isNaN(d)
        ? d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
        : "—";
    }
    if (tv) tv.textContent =
      String(_rstH).padStart(2, "0") + ":" + String(_rstM).padStart(2, "0");
  }

  // ── Calendar ──
  function _rstMaxDate() {
    // Latest selectable check-in DAY: today, and for completed stays never
    // after the checkout day (check-in must stay before checkout).
    const today = _rstToday();
    const e = _stayTimesEntry;
    const co = e && e.status !== "active" ? (e.checkout_time || "").slice(0, 10) : "";
    return co && co < today ? co : today;
  }

  function _rstShiftMonth(delta) {
    const [y, m] = _rstView.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    _rstView = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
    _rstRenderCal();
  }

  function _rstRenderCal() {
    const title = dom("rst-cal-title");
    const grid = dom("rst-grid");
    if (!grid) return;
    const [y, m] = _rstView.split("-").map(Number);
    title.textContent = new Date(y, m - 1, 1)
      .toLocaleString("en-IN", { month: "long", year: "numeric" });

    const dows = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
    let html = dows.map((d) => `<div class="rst-dow">${d}</div>`).join("");
    const firstDow = new Date(y, m - 1, 1).getDay();
    for (let i = 0; i < firstDow; i++) html += "<div></div>";

    const nDays = new Date(y, m, 0).getDate();
    const today = _rstToday();
    const maxDate = _rstMaxDate();
    for (let d = 1; d <= nDays; d++) {
      const date = _rstView + "-" + String(d).padStart(2, "0");
      const disabled = date > maxDate;
      const cls = ["rst-day",
                   disabled ? "disabled" : "",
                   date === today ? "today" : "",
                   date === _rstDate ? "sel" : ""].filter(Boolean).join(" ");
      html += `<div class="${cls}" data-date="${date}">${d}</div>`;
    }
    grid.innerHTML = html;
    grid.querySelectorAll(".rst-day:not(.disabled)").forEach((cell) => {
      cell.onclick = function () {
        _rstDate = cell.dataset.date;
        _rstRenderCal();
        _rstPreview();
        // Date picked → straight on to the clock.
        _rstClockMode = "hour";
        _rstShowStep("time");
      };
    });
  }

  // ── Clock dial (Material-style, 24h) ──
  // Hour mode: outer ring 1–12, inner ring 13–23 + 00. Minute mode: labels
  // every 5, tap or drag anywhere snaps to the nearest minute.
  function _rstSetClockMode(mode) {
    _rstClockMode = mode;
    _rstRenderClock();
  }

  function _rstRenderClock() {
    const clock = dom("rst-clock");
    if (!clock) return;
    const hd = dom("rst-td-hour"), md = dom("rst-td-min");
    if (hd) { hd.textContent = String(_rstH).padStart(2, "0");
              hd.classList.toggle("on", _rstClockMode === "hour"); }
    if (md) { md.textContent = String(_rstM).padStart(2, "0");
              md.classList.toggle("on", _rstClockMode === "min"); }

    let html = "";
    let angle, radius;
    if (_rstClockMode === "hour") {
      angle = ((_rstH % 12) / 12) * 360 - 90;
      radius = (_rstH === 0 || _rstH > 12) ? _RST_R_INNER : _RST_R_OUTER;
    } else {
      angle = (_rstM / 60) * 360 - 90;
      radius = _RST_R_OUTER;
    }
    const rad = (angle * Math.PI) / 180;
    const kx = _RST_C + radius * Math.cos(rad);
    const ky = _RST_C + radius * Math.sin(rad);
    html += `<div class="rst-hand" style="height:${radius - 14}px;` +
            `transform:rotate(${angle - 90}deg);"></div>`;
    html += `<div class="rst-knob" style="left:${kx}px;top:${ky}px;"></div>`;
    html += `<div class="rst-center-dot"></div>`;

    if (_rstClockMode === "hour") {
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * 360 - 90, r = (a * Math.PI) / 180;
        const vOut = i === 0 ? 12 : i;
        const xo = _RST_C + _RST_R_OUTER * Math.cos(r);
        const yo = _RST_C + _RST_R_OUTER * Math.sin(r);
        html += `<div class="rst-lbl ${vOut === _rstH ? "sel" : ""}"` +
                ` style="left:${xo}px;top:${yo}px;">${vOut}</div>`;
        const vIn = i === 0 ? 0 : i + 12;
        const xi = _RST_C + _RST_R_INNER * Math.cos(r);
        const yi = _RST_C + _RST_R_INNER * Math.sin(r);
        html += `<div class="rst-lbl inner ${vIn === _rstH ? "sel" : ""}"` +
                ` style="left:${xi}px;top:${yi}px;">${String(vIn).padStart(2, "0")}</div>`;
      }
    } else {
      for (let i = 0; i < 12; i++) {
        const v = i * 5;
        const a = (v / 60) * 360 - 90, r = (a * Math.PI) / 180;
        const x = _RST_C + _RST_R_OUTER * Math.cos(r);
        const y = _RST_C + _RST_R_OUTER * Math.sin(r);
        html += `<div class="rst-lbl ${v === _rstM ? "sel" : ""}"` +
                ` style="left:${x}px;top:${y}px;">${String(v).padStart(2, "0")}</div>`;
      }
    }
    clock.innerHTML = html;
    _rstSyncChips();
  }

  function _rstClockPick(ev, finalize) {
    const clock = dom("rst-clock");
    if (!clock) return;
    const rect = clock.getBoundingClientRect();
    const x = ev.clientX - rect.left - _RST_C;
    const y = ev.clientY - rect.top - _RST_C;
    const dist = Math.sqrt(x * x + y * y);
    if (dist < 16) return;                       // dead zone at the center
    let deg = (Math.atan2(y, x) * 180) / Math.PI + 90;  // 0° at 12 o'clock
    if (deg < 0) deg += 360;
    if (_rstClockMode === "hour") {
      const idx = Math.round(deg / 30) % 12;     // 0..11, 0 = top
      const inner = dist < (_RST_R_OUTER + _RST_R_INNER) / 2;
      _rstH = inner ? (idx === 0 ? 0 : idx + 12) : (idx === 0 ? 12 : idx);
      _rstRenderClock();
      if (finalize) _rstSetClockMode("min");     // hour picked → minutes
    } else {
      _rstM = Math.round(deg / 6) % 60;          // 1-minute snap
      _rstRenderClock();
    }
    _rstPreview();
  }

  function _rstBindClock() {
    const clock = dom("rst-clock");
    if (!clock) return;
    let dragging = false;
    clock.addEventListener("pointerdown", (ev) => {
      dragging = true;
      clock.setPointerCapture(ev.pointerId);
      _rstClockPick(ev, false);
    });
    clock.addEventListener("pointermove", (ev) => {
      if (dragging) _rstClockPick(ev, false);
    });
    clock.addEventListener("pointerup", (ev) => {
      dragging = false;
      _rstClockPick(ev, true);
    });
  }

  // ── Preview / open / submit ──
  function _rstChosen() {
    if (!_rstDate) return "";
    return `${_rstDate} ${String(_rstH).padStart(2, "0")}:` +
           `${String(_rstM).padStart(2, "0")}`;
  }

  function _rstPreview() {
    const box = dom("rst-preview");
    if (!box || !_stayTimesEntry) return;
    const e = _stayTimesEntry;
    const chosen = _rstChosen();
    if (!chosen) { box.innerHTML = "Pick a date."; return; }
    let html = "";
    if (e.status !== "active" && e.checkout_time) {
      const co = e.checkout_time.slice(0, 16);
      if (chosen >= co) {
        html = `<span class="warn">Check-in must be before checkout ` +
               `(${fmtDT(e.checkout_time)}).</span>`;
      } else {
        const nights = Math.max(1, Math.round(
          (new Date(co.slice(0, 10)) - new Date(chosen.slice(0, 10))) / 86400000));
        const billed = Number(e.days_stayed || 0);
        if (billed && billed !== nights) {
          html = `<span class="warn">New dates span ${nights} night` +
                 `${nights === 1 ? "" : "s"}, billed for ${billed} — ` +
                 `amounts won't change.</span>`;
        }
      }
    }
    box.innerHTML = html ||
      "First payment & serial follow the new check-in automatically.";
  }

  function _openStayTimesModal(entry) {
    _ensureStayTimesDom();
    _stayTimesEntry = entry;
    const isActive = entry.status === "active";
    dom("rst-sub").textContent =
      `${entry.guest_name || "-"} · Room ${entry.room || "-"}` +
      (isActive ? " · active stay"
        : (entry.bill_number && entry.bill_number !== "-"
            ? ` · Bill ${entry.bill_number}` : ""));
    const cur = (entry.checkin_time || "").slice(0, 16);   // "YYYY-MM-DD HH:MM"
    _rstDate = cur.slice(0, 10) || _rstToday();
    _rstView = _rstDate.slice(0, 7);
    _rstH = parseInt(cur.slice(11, 13), 10);
    _rstM = parseInt(cur.slice(14, 16), 10);
    if (isNaN(_rstH)) _rstH = 12;
    if (isNaN(_rstM)) _rstM = 0;
    _rstClockMode = "hour";
    _rstRenderCal();
    _rstShowStep("date");
    _rstPreview();
    dom("rst-overlay").classList.add("show");
  }

  async function _submitStayTimes() {
    const e = _stayTimesEntry;
    if (!e) return;
    const isActive = e.status === "active";
    const ci = _rstChosen();
    if (!ci) { showNotification("Pick the check-in date", "error"); return; }
    const nowStr = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
      .toISOString().slice(0, 16).replace("T", " ");
    if (ci > nowStr) {
      showNotification("Check-in can't be in the future", "error"); return;
    }
    if (!isActive && e.checkout_time && ci >= e.checkout_time.slice(0, 16)) {
      showNotification("Check-in must be before checkout", "error"); return;
    }
    const btn = dom("rst-save");
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      let res;
      if (isActive) {
        res = await apiFetch("/update_checkin_time", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ room: e.room, checkin_time: ci }),
        });
      } else {
        // Checkout is sent back UNCHANGED — only check-in is edited here.
        res = await apiFetch("/update_stay_times", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bill_id: e.id,
            checkin_time: ci,
            checkout_time: (e.checkout_time || "").slice(0, 16),
          }),
        });
      }
      const data = await res.json();
      if (!data.success) {
        showNotification(data.message || "Could not update check-in time", "error");
        return;
      }
      showNotification(data.message || "Check-in time updated", "success");
      if (data.warning) {
        setTimeout(() => showNotification(data.warning, "warning"), 400);
      }
      dom("rst-overlay").classList.remove("show");
      loadData(true);   // serials / row order may have changed
    } catch (err) {
      showNotification("Network error updating check-in time", "error");
    } finally {
      btn.disabled = false; btn.textContent = "Save";
    }
  }

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

    // Paged rendering — at most state.visibleCount data rows per pass.
    // Date-group headers stay intact; a truncated group's header still
    // shows the group's full count. The "Show more" row extends the cap.
    const cap = state.visibleCount || PAGE_SIZE;
    let rendered = 0;
    let html = "";
    const dateKeys = Object.keys(byDate).sort((a, b) => b.localeCompare(a));
    for (const dk of dateKeys) {
      if (rendered >= cap) break;
      const entries = byDate[dk];
      const label = dk !== "unknown" ? fmtDate(dk) : "Unknown Date";
      // Dynamic per-day serial (#): always 1..N by check-in time (earliest
      // = 1), derived live on every render. It needs no stored value and
      // re-adjusts the instant a check-in time changes — fully dynamic.
      const _posMap = new Map();
      entries
        .slice()
        .sort((a, b) =>
          String(a.checkin_time || "9999-12-31 23:59").localeCompare(
            String(b.checkin_time || "9999-12-31 23:59")))
        .forEach((en, i) => _posMap.set(en, i + 1));
      html += `<tr class="date-group-header" data-group="${dk}">
        <td colspan="15"><i class="fas fa-chevron-down"></i>${label}&nbsp;<span style="font-weight:400;opacity:.65;">(${entries.length})</span></td>
      </tr>`;
      for (const e of entries.slice(0, cap - rendered)) {
        html += rowHTML(e, dk, _posMap.get(e) || 0);
      }
      rendered += Math.min(entries.length, cap - rendered);
    }
    html += loadMoreRowHTML(state.filteredEntries.length - rendered);
    tbody.innerHTML = html;
  }

  function loadMoreRowHTML(remaining) {
    if (remaining <= 0) return "";
    return `<tr class="reg-load-more-row"><td colspan="15" style="text-align:center;padding:10px;">
      <button type="button" class="reg-load-more-btn" style="cursor:pointer;padding:6px 18px;">
        Show ${Math.min(PAGE_SIZE, remaining)} more (${remaining} remaining)
      </button></td></tr>`;
  }

  function rowHTML(e, dk, posSerial) {
    const days = e.days_stayed || calcDays(e.checkin_time, e.checkout_time);
    // Dynamic per-day position (1..N by check-in time) wins; fall back to the
    // stored serial only for callers that don't pass one (optimistic insert).
    const serial =
      (posSerial && posSerial > 0)
        ? posSerial
        : (e.serial_number !== null &&
           e.serial_number !== undefined &&
           e.serial_number !== 0
            ? e.serial_number
            : "-");
    const billNo = e.status === "completed" ? e.bill_number || "-" : "-";
    const stCls = e.status === "active" ? "status-active" : "status-completed";
    // Make bill number clickable for completed bills with a real Firestore doc id
    const isRealBill = billNo !== "-" && e.id && !String(e.id).startsWith("active_");
    // Eligibility to MINT a GST invoice: completed stay with a real bill doc
    // but no number yet (Bill No "-"), checked out within the last 5 days.
    let _coRecent = false, _coSameMonth = false;
    const _coDate = (e.checkout_time || "").slice(0, 10);
    if (_coDate) {
      const _d = new Date(_coDate + "T00:00:00");
      if (!isNaN(_d.getTime())) _coRecent = Math.floor((Date.now() - _d.getTime()) / 86400000) <= 7;
      const _nm = new Date();
      const _nymStr = _nm.getFullYear() + "-" + String(_nm.getMonth() + 1).padStart(2, "0");
      _coSameMonth = (e.checkout_time || "").slice(0, 7) === _nymStr;
    }
    // Eligible only within 7 days AND in the current month (no inter-month).
    const _needsInvoice = e.status === "completed" && billNo === "-" &&
      e.id && !String(e.id).startsWith("active_") && _coRecent && _coSameMonth;
    let billNoCell;
    if (isRealBill) {
      billNoCell = `<button class="reg-bill-link" data-id="${e.id}" title="View Bill">${billNo}</button>`;
    } else if (_needsInvoice) {
      billNoCell = `<button class="reg-geninv-btn" data-roles="admin" data-id="${e.id}"
            title="Generate GST invoice for this checkout"
            style="cursor:pointer;border:1px solid #c7d2fe;background:#eef2ff;color:#4f46e5;
                   border-radius:6px;padding:3px 9px;font-size:.69rem;font-weight:600;
                   white-space:nowrap;display:inline-flex;align-items:center;gap:.3rem;">
            <i class="fas fa-file-invoice"></i> Generate</button>`;
    } else {
      billNoCell = `<span style="font-size:.73rem;white-space:nowrap;">${billNo}</span>`;
    }
    const guestCount = e.guest_count || (e.guest && e.guest.guests) || 1;
    // Persons count is a dedicated column (header: "Persons"). Keeping
    // it separate means the Guest Name column doesn't reflow as a pill
    // is appended/removed. Title attribute gives the long form on hover.
    const personsCell = guestCount > 0
      ? `<span class="reg-guests-pill" title="${guestCount} guest${guestCount === 1 ? "" : "s"}"><i class="fas fa-user"></i> ${guestCount}</span>`
      : `<span style="color:#cbd5e1;">—</span>`;
    return `<tr class="date-group-row" data-date-group="${dk}" data-entry-id="${e.id || ''}">
      <td>${serial}</td>
      <td>${billNoCell}</td>
      <td><strong>${e.guest_name || "-"}</strong></td>
      <td class="reg-td-persons">${personsCell}</td>
      <td style="font-size:.78rem;">${e.guest_mobile || "-"}</td>
      <td><strong>${e.room || "-"}</strong></td>
      <td class="reg-ci-cell" data-entry-id="${e.id || ''}"
          title="Edit check-in date &amp; time for this stay"
          style="font-size:.76rem;white-space:nowrap;">${fmtDT(e.checkin_time)}</td>
      <td style="font-size:.76rem;white-space:nowrap;">${e.checkout_time ? fmtDT(e.checkout_time) : '<span style="color:#aaa;">Active</span>'}</td>
      <td style="text-align:center;">${days}</td>
      <td>₹${inr(e.room_rent)}</td>
      <td>₹${inr(e.services_total)}</td>
      <td><strong>₹${inr(e.total_amount)}</strong></td>
      <td>${paymentHTML(e)}</td>
      <td><span class="status-badge ${stCls}">${e.status}</span></td>
      <td style="white-space:nowrap;">
        <div class="reg-row-actions">
          ${(e.lastCheckinBy && window.CibaraUsers)
            ? `<span class="reg-attr-badge" title="Checked in by ${
                escapeAttr(window.CibaraUsers.nameOf(e.lastCheckinBy))
              }"><i class="fas fa-user-shield"></i> ${
                escapeAttr(window.CibaraUsers.nameOf(e.lastCheckinBy))
              }</span>`
            : ''}
          <button class="reg-pay-btn"
              data-perm="payment.edit"
              data-room="${e.room}"
              data-guest="${encodeURIComponent(e.guest_name || '')}"
              data-checkin="${e.checkin_time || ''}"
              title="View / edit payments">₹</button>
          <button class="reg-history-btn"
              data-room="${e.room}"
              data-entry-id="${e.id || ''}"
              title="Room history">
            <i class="fas fa-history"></i>
          </button>${e.guest_mobile
            ? `<button class="reg-doc-btn"
                  data-mobile="${e.guest_mobile}"
                  data-guest="${encodeURIComponent(e.guest_name || '')}"
                  title="View ID documents"
                  style="visibility:hidden;"><i class="fas fa-id-card"></i></button>`
            : `<span class="reg-doc-slot" aria-hidden="true"></span>`}
        </div>
      </td>
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
      t.innerHTML = `<tr><td colspan="15"><div class="reg-state"><div class="reg-loader"></div><p>Loading…</p></div></td></tr>`;
  }
  function showEmpty() {
    const t = dom("reg-table-body");
    if (t)
      t.innerHTML = `<tr><td colspan="15"><div class="reg-state"><i class="fas fa-inbox"></i><p>No entries found for this period</p></div></td></tr>`;
  }
  function showError(msg) {
    const t = dom("reg-table-body");
    if (t)
      t.innerHTML = `<tr><td colspan="15"><div class="reg-state" style="color:#dc3545"><i class="fas fa-exclamation-circle"></i><p>${msg}</p></div></td></tr>`;
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

  // ── Live patch from remote events (no refetch) ────────────────────────────
  // The Register view is fed by the same `bills` collection as the Bills tab.
  // Every backend mutation that affects a row writes to `bills`, which fires
  // `cibaraBillChanged` with the full bill document attached. We patch
  // `state.allEntries` in place instead of refetching the whole range.
  //
  // `cibaraRoomUpdate` and `cibaraPaymentAdded` are intentionally NOT listened
  // to here: they are upstream of bill changes, and any effect on a Register
  // row is already reflected by a follow-up `bills_ref.update(...)` on the
  // backend. Listening to them caused a full reload on every room/payment
  // event, even when nothing visible to this tab had actually changed.

  function _rgDateInRange(dateStr) {
    if (!dateStr) return false;
    const { start, end } = state.dateRange;
    if (!start || !end) return false;
    return dateStr >= start && dateStr <= end;
  }

  function _patchBillFromEvent(bill) {
    if (!bill || !bill.id) return;

    // Register groups by check-in date, so use that for range matching.
    // Fall back to checkout_time for safety if check-in is missing.
    const checkinDate  = (bill.checkin_time  || "").split(" ")[0];
    const checkoutDate = (bill.checkout_time || "").split(" ")[0];
    if (!_rgDateInRange(checkinDate) && !_rgDateInRange(checkoutDate)) return;

    const idx = state.allEntries.findIndex(e => e.id === bill.id);
    const isModified = idx >= 0;

    if (isModified) {
      // Skip no-op events — Firestore can deliver duplicate snapshots.
      if (JSON.stringify(state.allEntries[idx]) === JSON.stringify(bill)) return;
      state.allEntries[idx] = bill;
    } else {
      state.allEntries.push(bill);
    }

    // Re-run the visibility filter so `state.filteredEntries` reflects the
    // change. This is in-memory only and re-renders the table — no network.
    applyFilters();
  }

  window.addEventListener("cibaraBillChanged", (e) => {
    // Patch state regardless of visibility so the tab is fresh on next open.
    // The MutationObserver-driven loadData(false) will short-circuit because
    // `lastLoadedRange` is still set, avoiding a redundant network call.
    _patchBillFromEvent(e.detail);
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // ID DOCUMENTS MODAL — view customer docs, no password required
  // ══════════════════════════════════════════════════════════════════════════════

  async function _checkAndShowDocButtons() {
    // Collect unique mobile numbers from current filtered entries
    const mobiles = [...new Set(
      state.filteredEntries
        .map(e => e.guest_mobile)
        .filter(m => m && m.trim())
    )];
    if (!mobiles.length) return;

    try {
      const res  = await apiFetch("/batch_check_customer_docs", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ mobiles }),
      });
      const data = await res.json();
      if (!data.success) return;

      const withDocs = new Set(data.mobiles_with_docs || []);
      // Every row with a mobile gets a visible button in one of two modes:
      //   view   (grey, solid)  — docs exist, click opens the viewer
      //   upload (amber, dashed, corner +) — NO ID on file, click uploads
      document.querySelectorAll(".reg-doc-btn").forEach(btn => {
        const has = withDocs.has(btn.dataset.mobile);
        btn.style.visibility = "visible";
        btn.dataset.mode = has ? "view" : "upload";
        btn.classList.toggle("missing", !has);
        btn.title = has
          ? "View ID documents"
          : "No ID on file — tap to upload";
        btn.innerHTML = has
          ? '<i class="fas fa-id-card"></i>'
          : '<i class="fas fa-id-card"></i><span class="reg-doc-plus">+</span>';
      });
    } catch (_) {
      // Silent fail — buttons stay hidden, not a blocking issue
    }
  }

  // ── Upload a missing ID straight from the register row ──────────────────
  // Reuses the check-in flow's endpoint (/upload_customer_document) and,
  // when available, its _compressImage helper from customer-docs.js so a
  // 5 MB phone photo shrinks to a few hundred KB before upload.
  let _regDocInput = null;
  let _regDocTargetBtn = null;

  function _openDocUploadPicker(btn) {
    _regDocTargetBtn = btn;
    if (!_regDocInput) {
      _regDocInput = document.createElement("input");
      _regDocInput.type = "file";
      _regDocInput.accept = "image/*";
      _regDocInput.style.display = "none";
      document.body.appendChild(_regDocInput);
      _regDocInput.addEventListener("change", () => {
        const file = _regDocInput.files && _regDocInput.files[0];
        _regDocInput.value = "";           // allow re-picking the same file
        if (file && _regDocTargetBtn) _uploadRegisterDoc(_regDocTargetBtn, file);
      });
    }
    _regDocInput.click();
  }

  async function _uploadRegisterDoc(btn, file) {
    const mobile = btn.dataset.mobile;
    const guest = decodeURIComponent(btn.dataset.guest || "");
    const toast = window.showNotification || _notify;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    try {
      let blob = file;
      if (typeof _compressImage === "function") {
        try { blob = await _compressImage(file); } catch (_) { blob = file; }
      }
      const form = new FormData();
      form.append("mobile", mobile);
      form.append("document", blob, `register_doc_${Date.now()}.jpg`);
      const res = await apiFetch("/upload_customer_document", {
        method: "POST", body: form,
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message || "Upload failed");
      // Flip every row for this guest to the "has docs" state.
      document.querySelectorAll(
        `.reg-doc-btn[data-mobile="${mobile}"]`
      ).forEach(b => {
        b.disabled = false;
        b.dataset.mode = "view";
        b.classList.remove("missing");
        b.title = "View ID documents";
        b.innerHTML = '<i class="fas fa-id-card"></i>';
      });
      toast(`ID uploaded for ${guest || mobile}`, "success");
    } catch (err) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-id-card"></i><span class="reg-doc-plus">+</span>';
      toast(err.message || "Upload failed", "error");
    }
  }

  async function _openDocsModal(mobile, guestName) {
    const overlay = dom("rdoc-overlay");
    const meta    = dom("rdoc-meta");
    const content = dom("rdoc-content");
    if (!overlay) return;

    // Show modal immediately with spinner
    if (meta)    meta.innerHTML = `<strong>Guest:</strong> ${guestName || "-"} &nbsp;|&nbsp; <strong>Mobile:</strong> ${mobile || "-"}`;
    if (content) content.innerHTML = `<div class="rdoc-spinner"><i class="fas fa-spinner fa-spin"></i> Loading…</div>`;
    overlay.classList.add("show");

    try {
      const res  = await apiFetch(`/get_customer/${encodeURIComponent(mobile)}`);
      const data = await res.json();

      if (!data.success || !data.customer) {
        if (content) content.innerHTML = `<div class="rdoc-empty">No customer record found for this mobile number.</div>`;
        return;
      }

      const urls = data.customer.id_doc_urls || [];
      if (!urls.length) {
        if (content) content.innerHTML = `<div class="rdoc-empty"><i class="fas fa-folder-open" style="font-size:1.5rem;opacity:.3;display:block;margin-bottom:.5rem;"></i>No ID documents on file for this guest.</div>`;
        return;
      }

      // Render image grid — each image opens full-size in a new tab on click
      const imgTiles = urls.map((url, i) =>
        `<div class="rdoc-img-wrap">
          <img src="${url}" alt="ID Document ${i + 1}" loading="lazy"
               onclick="window.open('${url}', '_blank')"
               onerror="this.parentElement.innerHTML='<span style=\\'color:#bbb;font-size:.75rem;\\'>Failed to load</span>'" />
        </div>`
      ).join("");

      if (content) content.innerHTML = `<div class="rdoc-grid">${imgTiles}</div>`;

    } catch (err) {
      if (content) content.innerHTML = `<div class="rdoc-empty" style="color:#dc3545;">Network error — could not load documents.</div>`;
    }
  }

  function _closeDocsModal() {
    const overlay = dom("rdoc-overlay");
    if (overlay) overlay.classList.remove("show");
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // STAY PAYMENTS MODAL — password-protected view + edit of payment records
  // ══════════════════════════════════════════════════════════════════════════════

  // Module-level state for the payments flow
  const pmState = {
    entry:       null,   // full entry object (room, guest_name, checkin_time, services, id, status)
    password:    null,   // stored in-memory after first successful verify
    payments:    [],     // loaded payment records
    editId:      null,   // payment doc id currently being edited
    editSvcIdx:  null,   // service index being edited
  };

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function _fmtPmDate(d) {
    // "2026-03-24" → "24 Mar 2026"
    if (!d) return "-";
    const [y, m, day] = d.split("-");
    const mn = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${parseInt(day)} ${mn[parseInt(m)-1]} ${y}`;
  }

  function _typeLabel(t) {
    const map = {
      checkin: "Check-in", checkout: "Checkout", payment: "Payment",
      renewal: "Renewal", addon: "Add-on",
      refund: "Refund", checkout_refund: "Refund",
      manual_refund: "Refund", pay_later: "Pay Later",
    };
    return map[t] || t || "-";
  }

  function _notify(msg, type) {
    // Simple toast — reuse if a global _notify exists, otherwise alert
    if (window._notify) { window._notify(msg, type); return; }
    if (type === "error") console.error(msg); else console.log(msg);
  }

  // ── Stay-payments cache ──────────────────────────────────────────────────
  // Key: stay_id when present, else "{room}|{checkin_time}".
  // Value: { payments, ts }. TTL ~3 min — short enough that an edit on
  // another device shows up quickly, long enough that re-opening the
  // same row stays instant.
  // Also tracks an in-flight Promise so a second open while the first
  // fetch is still pending reuses it instead of starting a parallel call.
  const _stayPmtCache = new Map();
  const _stayPmtInflight = new Map();
  const _STAY_PMT_TTL_MS = 3 * 60 * 1000;

  function _stayPmtCacheKey(entry) {
    return entry.stay_id || `${entry.room || ""}|${entry.checkin_time || ""}`;
  }

  function _invalidateStayPmtCache(entry) {
    if (!entry) return;
    _stayPmtCache.delete(_stayPmtCacheKey(entry));
  }

  // ── Edit-payment access (RBAC) ────────────────────────────────────────────
  // Was: ask for the manager password via a custom rpm-overlay modal.
  // Now: check the current user's role. Admin → load payments straight away.
  // Non-admin → toast and abort.
  function _openPasswordPrompt(entry) {
    pmState.entry = entry;
    const auth = window.CibaraAuth;
    if (!auth || !auth.userCan || !auth.userCan("payment.edit")) {
      _notify("Access denied — only admins can edit payments.", "error");
      return;
    }
    // Mark as authorised so downstream code that branches on pmState.password
    // (e.g. retries on 403) doesn't loop.
    pmState.password = "_rbac_";
    _loadAndShowPayments();
  }

  // Exposed for the Bills tab — clicking the Payment cell there opens the
  // same Payment Records modal we use in Register. The shared modal markup
  // (rp-overlay / rp-content / rp-meta) is already in the DOM (injected
  // when register.js bootstraps), so consumers only need to call this
  // entry point with a bill-shaped object: { id, stay_id, room,
  // guest_name, checkin_time }. RBAC (payment.edit, admin-only) is
  // enforced inside the function.
  window.openRegisterPaymentsModal = _openPasswordPrompt;

  // Fetch payment records for the active stay. Returns a Promise that
  // resolves to the payments array. De-dupes concurrent calls via
  // _stayPmtInflight so a prefetch + an immediate open share one network
  // round-trip.
  function _fetchStayPayments(entry) {
    const key = _stayPmtCacheKey(entry);

    const cached = _stayPmtCache.get(key);
    if (cached && Date.now() - cached.ts < _STAY_PMT_TTL_MS) {
      return Promise.resolve(cached.payments);
    }

    const inflight = _stayPmtInflight.get(key);
    if (inflight) return inflight;

    const promise = apiFetch("/get_stay_payments", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        password:     pmState.password,
        // Canonical foreign key (Phase-6). Backend falls back to the
        // legacy heuristic when stay_id is absent (legacy active stays).
        stay_id:      entry.stay_id || "",
        room:         entry.room,
        guest_name:   entry.guest_name,
        checkin_time: entry.checkin_time,
      }),
    })
      .then(async (res) => {
        if (res.status === 403) {
          const e = new Error("forbidden");
          e.code = 403;
          throw e;
        }
        const data = await res.json();
        if (!data.success) {
          throw new Error(data.message || "Failed to load payments.");
        }
        const payments = data.payments || [];
        _stayPmtCache.set(key, { payments, ts: Date.now() });
        return payments;
      })
      .finally(() => {
        _stayPmtInflight.delete(key);
      });

    _stayPmtInflight.set(key, promise);
    return promise;
  }

  // Open the modal IMMEDIATELY in a loading state, fetch in the background,
  // then populate. Previously this awaited the network round-trip before
  // showing anything, so the ₹ button felt unresponsive on first click.
  // If the cache has a fresh hit the modal renders the data on the very
  // same tick — no perceptible delay.
  async function _loadAndShowPayments() {
    const entry = pmState.entry;
    if (!entry) return;

    const key = _stayPmtCacheKey(entry);
    const cached = _stayPmtCache.get(key);
    const isFreshCache = cached && Date.now() - cached.ts < _STAY_PMT_TTL_MS;

    if (isFreshCache) {
      // Cache hit — show the modal already populated. No spinner.
      pmState.payments = cached.payments;
      _showPaymentsModal();
    } else {
      // Cache miss — show the modal with a Loading state right away,
      // then swap content in once the fetch resolves.
      pmState.payments = [];
      _showPaymentsModal({ loading: true });
    }

    try {
      const payments = await _fetchStayPayments(entry);
      // Bail if the user closed the modal or switched to another stay
      // while the fetch was in flight.
      if (pmState.entry !== entry) return;
      pmState.payments = payments;
      // Re-render only the inner content; the modal is already on screen.
      _renderPaymentsTable(dom("rp-content"));
      _renderServicesSection(dom("rp-services-section"));
    } catch (err) {
      if (err && err.code === 403) {
        // Stored password rejected (e.g. changed server-side) — clear and re-prompt
        pmState.password = null;
        _closePaymentsModal();
        _openPasswordPrompt(entry);
        return;
      }
      _notify(err && err.message ? err.message : "Network error loading payments.", "error");
    }
  }

  function _closePasswordPrompt() {
    const overlay = dom("rpm-overlay");
    if (overlay) overlay.classList.remove("show");
  }

  async function _submitPassword() {
    const pwd  = dom("rpm-password");
    const err  = dom("rpm-err");
    const btn  = dom("rpm-submit");
    const pass = pwd ? pwd.value.trim() : "";

    if (!pass) {
      if (err) { err.textContent = "Please enter the password."; err.style.display = "block"; }
      return;
    }

    if (btn) { btn.disabled = true; btn.textContent = "Verifying…"; }
    if (err) { err.style.display = "none"; }

    // Store password then use shared loader
    pmState.password = pass;

    try {
      const res = await apiFetch("/get_stay_payments", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          password:     pass,
          // Canonical foreign key (Phase-6). Backend falls back to the
          // legacy heuristic when stay_id is absent (legacy active stays).
          stay_id:      pmState.entry.stay_id || "",
          room:         pmState.entry.room,
          guest_name:   pmState.entry.guest_name,
          checkin_time: pmState.entry.checkin_time,
        }),
      });

      if (res.status === 403) {
        pmState.password = null;  // wrong password — don't cache it
        if (err) { err.textContent = "Incorrect password. Try again."; err.style.display = "block"; }
        if (pwd) { pwd.value = ""; pwd.focus(); }
        return;
      }

      const data = await res.json();
      if (!data.success) {
        pmState.password = null;
        if (err) { err.textContent = data.message || "Failed to load payments."; err.style.display = "block"; }
        return;
      }

      pmState.payments = data.payments || [];
      _closePasswordPrompt();
      _showPaymentsModal();

    } catch (e) {
      pmState.password = null;
      if (err) { err.textContent = "Network error. Please try again."; err.style.display = "block"; }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Open Payments"; }
    }
  }

  // ── Payments modal ────────────────────────────────────────────────────────────
  // opts.loading=true → shows a spinner instead of the (empty) table. Used
  // when the data fetch is still in flight so the modal can appear
  // immediately on click instead of after the network round-trip.
  function _showPaymentsModal(opts) {
    const overlay = dom("rp-overlay");
    const meta    = dom("rp-meta");
    const content = dom("rp-content");
    if (!overlay) return;
    const loading = !!(opts && opts.loading);

    const e = pmState.entry;
    if (meta) {
      meta.innerHTML =
        `<strong>Guest:</strong> ${e.guest_name || "-"} &nbsp;|&nbsp; ` +
        `<strong>Room:</strong> ${e.room || "-"} &nbsp;|&nbsp; ` +
        `<strong>Check-in:</strong> ${e.checkin_time || "-"}` +
        ' <span id="rp-attr" style="display:inline-block;margin-left:8px;"></span>';

      // Show "last action by ..." attribution. We key the lookup on the
      // bill / stay id when available; fall back to the room number.
      const attrEl = document.getElementById("rp-attr");
      if (attrEl && window.CibaraAttribution) {
        const billId = e.id || e.stay_id || e.bill_id;
        if (billId) {
          window.CibaraAttribution.decorate(attrEl, "bills", billId, { hideIfNone: true });
        } else if (e.room) {
          window.CibaraAttribution.decorate(attrEl, "rooms", String(e.room), { hideIfNone: true });
        }
      }
    }

    pmState.editId     = null;
    pmState.editSvcIdx = null;
    if (loading) {
      // Show the modal shell with a spinner. The data is still being
      // fetched; _loadAndShowPayments will call _renderPaymentsTable
      // when it resolves.
      if (content) {
        content.innerHTML = '<div class="rp-spinner">Loading payments…</div>';
      }
      const svcs = dom("rp-services-section");
      if (svcs) svcs.innerHTML = "";
    } else {
      _renderPaymentsTable(content);
      // Render services section (filters out water services)
      _renderServicesSection(dom("rp-services-section"));
    }
    overlay.classList.add("show");
  }

  function _closePaymentsModal() {
    const overlay = dom("rp-overlay");
    if (overlay) overlay.classList.remove("show");
    pmState.editId     = null;
    pmState.editSvcIdx = null;
    pmState.entry      = null;
    pmState.payments   = [];
    const svcsEl = dom("rp-services-section");
    if (svcsEl) svcsEl.innerHTML = "";
    // Do NOT clear pmState.password — user may open another entry without re-typing
  }

  function _methodCls(method) {
    if (method === "cash")   return "rp-method-cash";
    if (method === "online") return "rp-method-online";
    if (method === "upi")    return "rp-method-upi";
    if (method === "ota")    return "rp-method-ota";
    return "rp-method-other";
  }
  function _methodLbl(method) {
    const map = { cash: "Cash", online: "Online", upi: "UPI", ota: "OTA",
                  balance: "Balance", card: "Card",
                  already_paid: "Pre-paid", bank_settlement: "Bank" };
    return map[method] || (method ? method.charAt(0).toUpperCase() + method.slice(1) : "-");
  }

  // ── Edit-row Date & time picker (flatpickr) ───────────────────────────────
  // One flatpickr instance backs the edit row's combined "Date & time"
  // field. It is destroyed before each table re-render and recreated only
  // while an edit row is on screen, so at most one picker is ever live —
  // any stray instance left by a closed modal is cleaned up on the next
  // render.
  let _rpDateTimeFp = null;

  function _rpDestroyDateTimePicker() {
    if (_rpDateTimeFp) {
      try { _rpDateTimeFp.destroy(); } catch (e) { /* already detached */ }
      _rpDateTimeFp = null;
    }
  }

  function _rpInitDateTimePicker() {
    if (!pmState.editId || !window.flatpickr) return;
    const input = dom(`rp-edit-datetime-${pmState.editId}`);
    if (!input) return;
    _rpDateTimeFp = window.flatpickr(input, {
      enableTime:      true,
      dateFormat:      "Y-m-d H:i",
      altInput:        true,
      altFormat:       "d M Y  ·  h:i K",
      minuteIncrement: 1,
      defaultDate:     input.value || undefined,
      disableMobile:   true,
    });
  }

  function _renderPaymentsTable(container) {
    if (!container) return;
    // Tear down the previous render's picker before its input node is
    // replaced by the innerHTML assignment below.
    _rpDestroyDateTimePicker();
    // Show ALL records returned by backend (backend already excludes expense/discount).
    // Only hide records with 0 amount and a non-payment internal type.
    const REFUND_TYPES    = new Set(["refund", "checkout_refund", "manual_refund", "booking_cancel_refund"]);
    const INTERNAL_TYPES  = new Set(["checkin", "checkout"]);
    const payments = (pmState.payments || []).filter(p => {
      // Always show if there's an amount
      if ((p.amount || 0) > 0) return true;
      // Show refunds even if amount=0
      if (REFUND_TYPES.has(p.type)) return true;
      // Hide zero-amount internal log entries
      if (INTERNAL_TYPES.has(p.type)) return false;
      return true;
    });

    if (!payments.length) {
      container.innerHTML = `<div class="rp-empty">No payment records found for this stay.</div>`;
      return;
    }

    let rows = "";
    payments.forEach((p) => {
      const isEditing = (pmState.editId === p.id);
      const isRefund  = REFUND_TYPES.has(p.type);

      if (isEditing) {
        rows += `
        <tr class="rp-edit-row" data-pid="${p.id}">
          <td colspan="6">
            <div class="rp-edit-form">
              <div class="rp-edit-field">
                <label for="rp-edit-datetime-${p.id}">Date &amp; time</label>
                <input type="text" id="rp-edit-datetime-${p.id}" class="rp-edit-dt-input"
                       value="${p.date || ''}${p.time ? ' ' + (p.time || '').slice(0, 5) : ''}"
                       placeholder="Select date &amp; time" />
              </div>
              <div class="rp-edit-field">
                <label for="rp-edit-mode-${p.id}">Mode</label>
                <select id="rp-edit-mode-${p.id}">
                  <option value="cash"   ${p.method === "cash"   ? "selected" : ""}>Cash</option>
                  <option value="online" ${p.method === "online" ? "selected" : ""}>Online</option>
                  <option value="upi"    ${p.method === "upi"    ? "selected" : ""}>UPI</option>
                  <option value="ota"    ${p.method === "ota"    ? "selected" : ""}>OTA</option>
                </select>
              </div>
              ${!isRefund ? `
              <div class="rp-edit-field">
                <label for="rp-edit-amount-${p.id}">Amount (₹)</label>
                <input type="number" id="rp-edit-amount-${p.id}" value="${p.amount || 0}" min="1" style="width:110px;" />
              </div>
              ` : `<span class="rp-edit-refund-note">Refund — amount locked</span>`}
              <div class="rp-edit-actions">
                <button class="rp-save-btn"        onclick="_rpSave('${p.id}')">Save</button>
                <button class="rp-cancel-edit-btn" onclick="_rpCancelEdit()">Cancel</button>
              </div>
            </div>
          </td>
        </tr>`;
      } else {
        const _by = (p.createdBy && window.CibaraUsers)
          ? window.CibaraUsers.nameOf(p.createdBy)
          : null;
        const _byCell = _by
          ? '<span class="rp-by"><i class="fas fa-user"></i> ' + escapeAttr(_by) + '</span>'
          : '<span class="rp-by rp-by-unknown">—</span>';
        rows += `
        <tr data-pid="${p.id}">
          <td>${_fmtPmDate(p.date)}${p.time ? ' <span style="color:#999;font-size:.7rem;">' + p.time + '</span>' : ''}</td>
          <td><span class="${_methodCls(p.method)}">${_methodLbl(p.method)}</span></td>
          <td><strong>₹${(p.amount || 0).toLocaleString("en-IN")}</strong></td>
          <td style="color:#666;font-size:.73rem;">${_typeLabel(p.type)}</td>
          <td>${_byCell}</td>
          <td style="white-space:nowrap">
            <button class="rp-edit-btn"   onclick="_rpStartEdit('${p.id}')">Edit</button>
            <button class="rp-delete-btn" onclick="_rpDelete('${p.id}')">Delete</button>
          </td>
        </tr>`;
      }
    });

    container.innerHTML = `
      <table class="rp-table">
        <thead>
          <tr>
            <th>Date</th><th>Mode</th><th>Amount</th><th>Type</th><th>By</th><th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;

    // Upgrade the edit row's Date & time field to a flatpickr calendar +
    // time picker — styled, consistent with the app's other date pickers,
    // and clearer than the native browser controls.
    _rpInitDateTimePicker();
  }

  // Called by onclick attributes in the rendered table
  window._rpStartEdit = function(payId) {
    pmState.editId = payId;
    _renderPaymentsTable(dom("rp-content"));
  };

  window._rpCancelEdit = function() {
    pmState.editId = null;
    _renderPaymentsTable(dom("rp-content"));
  };

  window._rpSave = async function(payId) {
    const dtInput     = dom(`rp-edit-datetime-${payId}`);
    const modeInput   = dom(`rp-edit-mode-${payId}`);
    const amountInput = dom(`rp-edit-amount-${payId}`);
    const saveBtn     = document.querySelector(`.rp-edit-row[data-pid="${payId}"] .rp-save-btn`);

    // The Date & time field carries a single "YYYY-MM-DD HH:MM" machine
    // value (flatpickr keeps that on the input; the prettified text lives
    // on flatpickr's altInput). Split it for the API, which takes date
    // and time as separate fields.
    const dtParts   = (dtInput ? dtInput.value.trim() : "").split(/[ T]/);
    const newDate   = (dtParts[0] || "").trim();
    const newTime   = (dtParts[1] || "").slice(0, 5).trim();
    const newMethod = modeInput ? modeInput.value.trim() : "";
    const newAmountStr = amountInput ? amountInput.value.trim() : "";

    if (!newDate || !newMethod) {
      _notify("Date and mode are required.", "error");
      return;
    }

    // Validate amount if the field is present
    let newAmount = null;
    if (amountInput && newAmountStr !== "") {
      newAmount = parseInt(newAmountStr, 10);
      if (isNaN(newAmount) || newAmount <= 0) {
        _notify("Amount must be a positive number.", "error");
        return;
      }
    }

    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving…"; }

    try {
      const payload = {
        password:   pmState.password,
        payment_id: payId,
        method:     newMethod,
        date:       newDate,
      };
      // Time is optional — the backend preserves the original when it is
      // omitted, so only send it when the operator actually set one.
      if (newTime) payload.time = newTime;
      if (newAmount !== null) payload.amount = newAmount;

      const res = await apiFetch("/update_stay_payment", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      });

      if (res.status === 403) {
        _notify("Session expired. Please close and re-open payments.", "error");
        pmState.password = null;
        return;
      }

      const data = await res.json();
      if (!data.success) {
        _notify(data.message || "Update failed.", "error");
        return;
      }

      // Update local state so re-render is instant (no refetch needed)
      const p = pmState.payments.find(x => x.id === payId);
      if (p) {
        p.method = newMethod;
        p.date   = newDate;
        if (newTime) p.time = newTime;
        if (newAmount !== null) p.amount = newAmount;
      }

      pmState.editId = null;
      _invalidateStayPmtCache(pmState.entry);
      _renderPaymentsTable(dom("rp-content"));
      _notify("Payment updated.", "success");

      // If this is a completed bill and amount changed, recalculate bill totals + new PDF
      const billEntry = pmState.entry;
      if (newAmount !== null && billEntry && billEntry.id && !String(billEntry.id).startsWith("active_")) {
        apiFetch("/recalculate_bill", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ password: pmState.password, bill_id: billEntry.id }),
        }).then(() => {
          _notify("Bill PDF version updated.", "success");
          state.lastLoadedRange = null;  // bust register cache
        }).catch(() => {});
      }

      // If amount changed, refresh room data so balance in checkout modal updates
      if (newAmount !== null && typeof window.fetchData === "function") {
        window.fetchData().then(() => {
          if (typeof window.renderRooms === "function") window.renderRooms();
        }).catch(() => {});
      }

    } catch (err) {
      _notify("Network error. Please try again.", "error");
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save"; }
    }
  };

  function _closeDeleteModal() {
    const ov = dom("rpd-overlay");
    if (ov) ov.classList.remove("show");
  }

  window._rpDelete = function(payId) {
    const p = (pmState.payments || []).find(x => x.id === payId);
    if (!p) return;

    // Populate the modal with this payment's details
    const amtEl    = dom("rpd-amount");
    const methEl   = dom("rpd-method");
    const typeEl   = dom("rpd-type");
    const dateEl   = dom("rpd-date");
    const confirmBtn = dom("rpd-confirm");

    if (amtEl)  amtEl.textContent  = `₹${(p.amount || 0).toLocaleString("en-IN")}`;
    if (methEl) methEl.textContent = _methodLbl(p.method);
    if (typeEl) typeEl.textContent = _typeLabel(p.type);
    if (dateEl) dateEl.textContent = p.date || "—";

    // Show the modal
    const ov = dom("rpd-overlay");
    if (ov) ov.classList.add("show");

    // Wire the confirm button (replace any previous handler)
    if (confirmBtn) {
      const newBtn = confirmBtn.cloneNode(true);
      confirmBtn.parentNode.replaceChild(newBtn, confirmBtn);
      newBtn.addEventListener("click", async () => {
        newBtn.disabled = true;
        newBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Deleting…';
        try {
          const res = await apiFetch("/delete_stay_payment", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ password: pmState.password, payment_id: payId }),
          });
          const data = await res.json();
          if (!data.success) {
            _notify(data.message || "Delete failed.", "error");
            newBtn.disabled = false;
            newBtn.innerHTML = '<i class="fas fa-trash"></i> Yes, Delete';
            return;
          }
          _closeDeleteModal();
          // Remove from local state and re-render instantly
          pmState.payments = (pmState.payments || []).filter(x => x.id !== payId);
          _invalidateStayPmtCache(pmState.entry);
          _renderPaymentsTable(dom("rp-content"));
          _notify("Transaction deleted.", "success");
          // Bust register cache
          state.lastLoadedRange = null;
          // Refresh room balances
          if (typeof window.fetchData === "function") {
            window.fetchData().then(() => {
              if (typeof window.renderRooms === "function") window.renderRooms();
            }).catch(() => {});
          }
        } catch (err) {
          _notify("Network error. Please try again.", "error");
          newBtn.disabled = false;
          newBtn.innerHTML = '<i class="fas fa-trash"></i> Yes, Delete';
        }
      });
    }
  };

  // ══════════════════════════════════════════════════════════════════════════════
  // SERVICES SECTION — in payments modal, shows non-water services with edit
  // ══════════════════════════════════════════════════════════════════════════════

  function _renderServicesSection(container) {
    if (!container) return;
    const entry = pmState.entry || {};
    // Filter out water services
    const services = (entry.services || []).filter(svc => {
      const nm = (svc.item || "").toLowerCase();
      return !nm.includes("water");
    });

    if (!services.length) {
      container.innerHTML = "";
      return;
    }

    // Only allow editing for completed bills (id doesn't start with "active_")
    const isBill = entry.id && !String(entry.id).startsWith("active_");

    let rows = "";
    services.forEach((svc, idx) => {
      const isEditing = (pmState.editSvcIdx === idx);
      if (isEditing && isBill) {
        rows += `
        <tr class="rp-svc-edit-row" data-svcidx="${idx}">
          <td colspan="4">
            <div class="rp-svc-edit-form">
              <label style="font-size:.75rem;font-weight:600;color:#555;">${svc.item || "Service"}</label>
              <label style="font-size:.75rem;font-weight:600;color:#555;white-space:nowrap;">Amount (₹):</label>
              <input type="number" id="rp-svc-amount-${idx}" value="${svc.price || 0}" min="0" style="width:80px;" />
              <button class="rp-svc-save-btn" onclick="_svcSave(${idx})">Save</button>
              <button class="rp-svc-cancel-btn" onclick="_svcCancelEdit()">Cancel</button>
            </div>
          </td>
        </tr>`;
      } else {
        const editBtn = isBill
          ? `<button class="rp-svc-edit-btn" onclick="_svcStartEdit(${idx})">Edit</button>`
          : "";
        rows += `
        <tr data-svcidx="${idx}">
          <td>${svc.item || "-"}</td>
          <td style="text-align:center;">${svc.quantity || 1}</td>
          <td>₹${(svc.price || 0).toLocaleString("en-IN")}</td>
          <td>${editBtn}</td>
        </tr>`;
      }
    });

    container.innerHTML = `
      <div class="rp-svc-section">
        <h4><i class="fas fa-concierge-bell" style="margin-right:.3rem;"></i>Services</h4>
        <table class="rp-svc-table">
          <thead>
            <tr><th>Service</th><th>Qty</th><th>Amount</th><th></th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  window._svcStartEdit = function (idx) {
    pmState.editSvcIdx = idx;
    _renderServicesSection(dom("rp-services-section"));
    const inp = dom(`rp-svc-amount-${idx}`);
    if (inp) inp.focus();
  };

  window._svcCancelEdit = function () {
    pmState.editSvcIdx = null;
    _renderServicesSection(dom("rp-services-section"));
  };

  window._svcSave = async function (idx) {
    const inp     = dom(`rp-svc-amount-${idx}`);
    const saveBtn = document.querySelector(`.rp-svc-edit-row[data-svcidx="${idx}"] .rp-svc-save-btn`);
    if (!inp) return;

    const newAmount = parseInt(inp.value, 10);
    if (isNaN(newAmount) || newAmount < 0) {
      _notify("Amount must be 0 or more.", "error");
      return;
    }

    const entry = pmState.entry || {};
    if (!entry.id || String(entry.id).startsWith("active_")) {
      _notify("Service editing only available for completed bills.", "error");
      return;
    }

    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving…"; }

    try {
      const res = await apiFetch("/update_bill_service", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          password:      pmState.password,
          bill_id:       entry.id,
          service_index: idx,
          new_price:     newAmount,
        }),
      });

      if (res.status === 403) {
        _notify("Session expired. Please close and re-open.", "error");
        pmState.password = null;
        return;
      }

      const data = await res.json();
      if (!data.success) {
        _notify(data.message || "Update failed.", "error");
        return;
      }

      // Update local entry services
      if (pmState.entry && Array.isArray(pmState.entry.services)) {
        pmState.entry.services[idx].price = newAmount;
      }

      pmState.editSvcIdx = null;
      _renderServicesSection(dom("rp-services-section"));
      _notify("Service updated. Bill PDF regenerated.", "success");

      // Bust register cache so updated totals reload on next view
      state.lastLoadedRange = null;

    } catch (err) {
      _notify("Network error. Please try again.", "error");
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save"; }
    }
  };

  // ── Init ──────────────────────────────────────────────────────────────────────
  // Two-phase boot:
  //   Phase 1 (immediate, on DOMContentLoaded):
  //     injectStyles() — must happen NOW so the .bill-modal `display:none`
  //     rule is in place. Without it, the bill modal element renders
  //     inline (visible) on the page during initial load.
  //   Phase 2 (after CibaraAuth.ready()):
  //     buildHTML / setDefaults / wireEvents / watchTab — these depend on
  //     the user's role to decide layout (date picker visibility etc.).
  function bootStyles() {
    injectStyles();
  }

  function bootRoleAware() {
    buildHTML();
    // ── Re-parent overlay modals to document.body ──────────────────────
    //
    // buildHTML() writes the register tab's HTML INTO #register-tab,
    // which carries .hidden (display:none !important) whenever another
    // tab is active. The payment / delete / ID-doc / bill modals were
    // declared inside that subtree, so adding .show to e.g. #rp-overlay
    // had no effect when the user was on the Bills tab — the ancestor
    // hide won the cascade.
    //
    // Moving them to be direct children of <body> decouples their
    // visibility from the register tab's display state. IDs are
    // preserved, so every dom("rp-overlay")-style lookup elsewhere in
    // register.js (and the cross-tab opener window.openRegisterPaymentsModal)
    // continues to find them. Event listeners attached AFTER this move
    // by wireEvents() bind to the now-relocated elements, so there's
    // no listener-loss to worry about.
    try {
      var _overlayIds = ["rp-overlay", "rpd-overlay", "rdoc-overlay", "reg-bill-overlay"];
      for (var _i = 0; _i < _overlayIds.length; _i++) {
        var _el = document.getElementById(_overlayIds[_i]);
        if (_el && _el.parentNode !== document.body) {
          document.body.appendChild(_el);
        }
      }
    } catch (_e) {
      // Non-fatal — modals will still work as long as the active tab
      // is the register tab. Logged so it's diagnosable.
      try { console.warn("Register: overlay re-parent skipped:", _e); } catch (_) {}
    }
    setDefaults();
    wireEvents();
    watchTab();
  }

  function bootWhenReady() {
    bootStyles();
    if (window.CibaraAuth && typeof window.CibaraAuth.ready === "function") {
      window.CibaraAuth.ready().then(bootRoleAware);
    } else {
      bootRoleAware();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootWhenReady);
  } else {
    bootWhenReady();
  }

  // ── Deep-link: reveal a specific stay (Transactions tab → Register) ───────
  // A payment row in the Transactions tab carries the stay's identifiers;
  // tapping it switches to this tab and calls showStay(ref) with
  //   ref = { stayId, room, guest, date }   (date = payment date, YYYY-MM-DD)
  // stayId is the canonical key (payment.stay_id == entry.stay_id == the bill
  // doc id). room+guest+date is the fallback for legacy payments written
  // before the stay_id migration.
  //
  // Lookup strategy, cheapest first:
  //   1. Already in the loaded entries → reveal, zero fetches.
  //   2. Resolve the stay's check-in date from its bill doc
  //      (/generate_bill/<stay_id> — a single document read) and load
  //      EXACTLY that day into the register. No wide range scans.
  //   3. Legacy payments without a stay_id: a stay's check-in is always on
  //      or before its payments, so scan a bounded window ending at the
  //      payment date.

  function _shiftYMD(ymd, days) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ""));
    if (!m) return ymd;
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    d.setDate(d.getDate() + days);
    return dateToYMD(d);
  }

  function _findStayEntry(ref) {
    const entries = state.allEntries || [];
    const sid = ref.stayId || "";
    if (sid) {
      const hit = entries.find(
        (e) => (e.stay_id && e.stay_id === sid) || e.id === sid,
      );
      if (hit) return hit;
    }
    // Fallback — room + guest name, preferring the stay whose window
    // (check-in .. check-out, or still active) contains the payment date.
    const room  = String(ref.room || "");
    const guest = String(ref.guest || "").trim().toLowerCase();
    if (!room || !guest) return null;
    const cands = entries
      .filter(
        (e) =>
          String(e.room || "") === room &&
          String(e.guest_name || "").trim().toLowerCase() === guest,
      )
      // Latest stay first, so repeat guests resolve to the most recent visit
      // when no date narrows it down.
      .sort((a, b) =>
        String(b.checkin_time || "").localeCompare(String(a.checkin_time || "")));
    if (!cands.length) return null;
    const d = String(ref.date || "").slice(0, 10);
    if (d) {
      const inWindow = cands.find((e) => {
        const ci = (e.checkin_time || "").slice(0, 10);
        const co = (e.checkout_time || "").slice(0, 10);
        return (!ci || ci <= d) && (!co || d <= co);
      });
      if (inWindow) return inWindow;
    }
    return cands[0];
  }

  function _revealStayEntry(entry) {
    // Clear client-side filters so the target row can't be filtered out,
    // and sync the filter UI so what's shown matches the controls.
    state.filters = { search: "", payment: "all", status: "all" };
    const sr = dom("reg-search");         if (sr) sr.value = "";
    const sf = dom("reg-status-filter");  if (sf) sf.value = "all";
    const pf = dom("reg-payment-filter"); if (pf) pf.value = "all";
    applyFilters(); // renders first page

    // Paged rendering may have cut the row off — extend the cap to cover
    // everything, then re-render. Row counts here are modest (a date range
    // of register entries), so a full render is fine as a one-off.
    if ((state.filteredEntries || []).length > state.visibleCount) {
      state.visibleCount = state.filteredEntries.length;
      renderTable();
    }

    const tbody = dom("reg-table-body");
    if (!tbody || !entry.id) return false;
    let tr = null;
    tbody.querySelectorAll("tr.date-group-row[data-entry-id]").forEach((r) => {
      if (!tr && r.getAttribute("data-entry-id") === String(entry.id)) tr = r;
    });
    if (!tr) return false;

    try { tr.scrollIntoView({ behavior: "smooth", block: "center" }); }
    catch (_) { tr.scrollIntoView(); }
    // Highlight the found row: a pulse to draw the eye while the page is
    // still scrolling, then a steady hold, then a slow fade. The class also
    // survives one in-place row replacement (loadDataSilent's _diffAndPatch
    // swaps <tr> nodes) because we re-query by entry id before each phase.
    const _rowNow = () => {
      let cur = null;
      const tb = dom("reg-table-body");
      if (!tb) return null;
      tb.querySelectorAll("tr.date-group-row[data-entry-id]").forEach((r) => {
        if (!cur && r.getAttribute("data-entry-id") === String(entry.id)) cur = r;
      });
      return cur;
    };
    tr.classList.add("reg-row-located");
    setTimeout(() => {
      const cur = _rowNow();
      if (!cur) return;
      cur.classList.add("reg-row-located"); // no-op if same node
      cur.classList.add("reg-row-located-fade");
      setTimeout(() => {
        const last = _rowNow();
        if (!last) return;
        last.classList.remove("reg-row-located", "reg-row-located-fade");
      }, 1400);
    }, 5000);
    return true;
  }

  // One document read: the stay's bill doc → its check-in DATE (YYYY-MM-DD).
  // Returns null on any failure so the caller can fall back.
  async function _stayCheckinDate(stayId) {
    try {
      const res = await apiFetch(`/generate_bill/${encodeURIComponent(stayId)}`);
      const data = await res.json();
      const ci = data && data.success && data.bill && data.bill.checkin_time;
      return ci ? String(ci).slice(0, 10) : null;
    } catch (_) {
      return null;
    }
  }

  // Point the register at [start, end] and force-load it, keeping the
  // date-picker / quick-chip UI in sync with the programmatic range.
  async function _loadStayRange(start, end) {
    state.dateRange.start = start;
    state.dateRange.end   = end;
    if (state._datePicker) {
      try { state._datePicker.setDate([start, end], false); } catch (_) {}
    }
    document.querySelectorAll(".reg-quick-btn")
      .forEach((b) => b.classList.remove("rq-active"));
    state.loading = false;   // our forced load supersedes any in-flight one
    await loadData(true);
  }

  async function showStayFromLink(ref) {
    ref = ref || {};
    // Let the tab-switch loader run first (watchTab's MutationObserver fires
    // loadData(false) right after the tab becomes visible), then invalidate
    // whatever it started. Without this, its re-render lands AFTER our
    // reveal, resets pagination back to page 1 and wipes the highlight —
    // the row then hides behind "Show more".
    await new Promise((r) => setTimeout(r, 0));
    state._reqId++;          // any in-flight fetch response is now discarded
    state.loading = false;

    // 1) Already in the loaded range → reveal, zero fetches.
    let entry = _findStayEntry(ref);
    if (entry) return _revealStayEntry(entry);

    // 2) Targeted load: one bill-doc read for the check-in date, then just
    //    that single day of register data.
    if (ref.stayId) {
      const ciDate = await _stayCheckinDate(ref.stayId);
      if (ciDate) {
        await _loadStayRange(ciDate, ciDate);
        entry = _findStayEntry(ref);
        return entry ? _revealStayEntry(entry) : false;
      }
    }

    // 3) Legacy fallback (no stay_id, or the bill doc is unreachable):
    //    bounded window ending at the payment date. Non-admin users are
    //    clamped to the last 3 days server-side; if the stay is older, this
    //    misses and the caller reports "not found" rather than showing
    //    wrong data.
    const today = todayStr();
    let base = String(ref.date || "").slice(0, 10) || today;
    if (base > today) base = today;
    await _loadStayRange(_shiftYMD(base, -30), base);
    entry = _findStayEntry(ref);
    return entry ? _revealStayEntry(entry) : false;
  }

  // ── Public refresh contract ───────────────────────────────────────────────
  // Consumed by the global header Refresh button (static/script.js).
  //   invalidate() clears the loaded-range marker so the NEXT time the tab is
  //     shown, watchTab()'s MutationObserver-driven loadData(false) misses the
  //     cache and re-fetches from the server. Used for the non-active tab.
  //   refresh() forces an immediate re-fetch of the current range (identical
  //     to clicking the in-tab refresh button). Used when this is the active
  //     tab.
  //   isLoaded() reports whether a range has ever been fetched this session.
  //   showStay(ref) reveals a stay row from a transaction deep-link — see
  //     showStayFromLink above. Resolves true when the row was found and
  //     highlighted, false when it isn't in the (possibly clamped) range.
  window.CibaraRegister = Object.freeze({
    invalidate: function () { state.lastLoadedRange = null; },
    refresh:    function () { return loadData(true); },
    isLoaded:   function () { return state.lastLoadedRange !== null; },
    showStay:   function (ref) {
      return showStayFromLink(ref).catch((err) => {
        console.warn("[Register] showStay failed:", err);
        return false;
      });
    },
  });
})();
