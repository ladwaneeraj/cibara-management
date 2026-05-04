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

/* ── PRINT: force single A4 page ── */
@media print {
  @page { size: A4 portrait; margin: 15mm 15mm; }

  html, body { height: auto !important; overflow: visible !important; }

  /* Clone-based print (bills module) — body gets .bl-printing class.
     Hide every direct child of body EXCEPT the injected #bl-print-clone. */
  body.bl-printing > *:not(#bl-print-clone) { display: none !important; }

  #bl-print-clone {
    display: block !important;
    padding: 0 !important;
    width: 100%;
    font-family: Arial, Helvetica, sans-serif !important;
    font-size: 10pt !important;
    line-height: 1.4 !important;
    color: #000 !important;
  }

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
    padding: 0 !important;
    font-size: 10pt !important;
    line-height: 1.4 !important;
    width: 100% !important;
  }

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
  .b-pay-section { margin-top: 2mm !important; }
  .b-pay-section .b-tbl td { padding: .6mm .8mm !important; }
  .b-sig        { margin-top: 4mm !important; padding: 0 !important; }
  .b-sig-line   { margin-top: 3.5mm !important; width: 32mm !important;
                  font-size: 6.5pt !important; }
  .b-footer     { margin-top: 2mm !important; padding-top: 1.5mm !important;
                  font-size: 6pt !important; }

  /* Prevent page breaks inside bill sections */
  .b-tbl, .b-info-outer, .b-pay-section, .b-sig, .b-footer {
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
}

/* ── Payments button (per register row) ── */
.reg-pay-btn {
  padding: .18rem .42rem; border: 1px solid #adb5bd;
  background: #fff; color: #555; border-radius: 4px;
  cursor: pointer; font-size: .7rem; font-weight: 600;
  transition: all .15s; white-space: nowrap;
}
.reg-pay-btn:hover { background: #6c757d; color: #fff; border-color: #6c757d; }

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
.rp-edit-btn {
  padding: .16rem .42rem; border: 1px solid var(--primary,#3f51b5);
  background: #fff; color: var(--primary,#3f51b5);
  border-radius: 4px; cursor: pointer; font-size: .7rem;
  transition: all .15s;
}
.rp-edit-btn:hover { background: var(--primary,#3f51b5); color: #fff; }
.rp-edit-row { background: #eef2ff !important; }
.rp-edit-row td { padding: .55rem .5rem !important; }
.rp-edit-form { display: flex; gap: .45rem; align-items: center; flex-wrap: wrap; }
.rp-edit-form input[type="date"], .rp-edit-form select {
  padding: .3rem .45rem; border: 1px solid #d0d0d0;
  border-radius: 5px; font-size: .8rem;
}
.rp-edit-form input[type="date"]:focus,
.rp-edit-form select:focus { outline: none; border-color: var(--primary,#3f51b5); }
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
.reg-doc-btn {
  padding: .18rem .42rem; border: 1px solid #adb5bd;
  background: #fff; color: #555; border-radius: 4px;
  cursor: pointer; font-size: .7rem; font-weight: 600;
  transition: all .15s; white-space: nowrap; margin-left: .25rem;
}
.reg-doc-btn:hover { background: #495057; color: #fff; border-color: #495057; }

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
  const state = {
    allEntries: [],
    filteredEntries: [],
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

  // ── Bill HTML builder (mirrors bills.js buildBillHTML) ────────────────────────
  function buildBillHTML(b) {
    const days = b.days_stayed || calcDays(b.checkin_time, b.checkout_time);
    const rate = b.room_price_per_night || b.room_rent || 0;
    const services = b.services || [];
    const accomAddons  = services.filter(s => s.accommodation_charge);
    const otherSvcs    = services.filter(s => !s.accommodation_charge);
    const accomAddonsTotal = accomAddons.reduce((s,x) => s+(x.price||0), 0);
    const otherSvcTotal    = otherSvcs.reduce((s,x) => s+(x.price||0), 0);
    const gstRatePct = typeof b.gst_rate === "number" ? b.gst_rate :
      rate > 7500 ? 18 : rate >= 1000 ? 5 : 0;
    const cgstRate = gstRatePct / 2;
    const sgstRate = gstRatePct / 2;
    const roomCharges = (typeof b.room_charges_total === "number" && b.room_charges_total > 0)
      ? b.room_charges_total : rate * days;
    const accomTotal = roomCharges + accomAddonsTotal;
    // Trust stored gst_amount (per-segment for room transfers).
    // Old bills used exclusive formula — detect and recalculate those.
    let cgst, sgst, accomBase;
    if (typeof b.gst_amount === "number" && gstRatePct > 0) {
      const exclusiveGst = accomTotal * gstRatePct / 100;
      const isOldExclusiveBill = Math.abs(b.gst_amount - exclusiveGst) < 0.10;
      const gstAmt = isOldExclusiveBill
        ? accomTotal * gstRatePct / (100 + gstRatePct)
        : b.gst_amount;
      cgst = gstAmt / 2; sgst = cgst; accomBase = accomTotal - gstAmt;
    } else if (gstRatePct > 0) {
      const gstAmt = accomTotal * gstRatePct / (100 + gstRatePct);
      cgst = gstAmt / 2; sgst = cgst; accomBase = accomTotal - gstAmt;
    } else {
      cgst = 0; sgst = 0; accomBase = accomTotal;
    }
    const discounts  = b.discounts || 0;
    const svcTotalAll = b.services_total || 0;
    const grandTotal = (typeof b.total_amount === "number" && b.total_amount > 0)
      ? b.total_amount : roomCharges + svcTotalAll - discounts;
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
    const accomAddonRows = accomAddons.map(s =>
      `<tr><td>${s.item}</td><td class="b-tr">${s.quantity||1}</td>
       <td class="b-tr">${fix2(s.unit_price||s.price||0)}</td>
       <td class="b-tr">${fix2(s.price||0)}</td></tr>`).join("");
    const otherSvcRows = otherSvcs.map(s =>
      `<tr><td>${s.item}</td><td class="b-tr">${s.quantity||1}</td>
       <td class="b-tr">${fix2(s.unit_price||s.price||0)}</td>
       <td class="b-tr">${fix2(s.price||0)}</td></tr>`).join("");
    const gstRows = `
      <tr class="b-gst-row"><td>CGST @ ${cgstRate}%</td>
        <td class="b-tr">—</td><td class="b-tr">—</td><td class="b-tr">${fix2(cgst)}</td></tr>
      <tr class="b-gst-row"><td>SGST @ ${sgstRate}%</td>
        <td class="b-tr">—</td><td class="b-tr">—</td><td class="b-tr">${fix2(sgst)}</td></tr>`;
    // Helper: GST slab and pre-GST taxable for a segment
    function segGstRate(p) { return p < 1000 ? 0 : p <= 7500 ? 5 : 18; }
    function segTaxable(totalIncl, price) {
      const r = segGstRate(price);
      return r > 0 ? totalIncl / (1 + r / 100) : totalIncl;
    }

    // ── Room Rent rows: pre-GST taxable values ───────────────────────────────
    const roomSegments   = b.room_segments || [];
    const currentRoomNo  = b.current_room || b.room || "";
    const currentRoomDays  = b.current_room_days;
    const currentRoomPrice = b.current_room_price;
    const currentRoomTotal = b.current_room_total;

    const accomSubtotalRow = accomAddons.length > 0 || days > 1 || roomSegments.length > 0
      ? `<tr class="b-subtotal"><td colspan="3" class="b-tr">Accommodation Total (incl. GST)</td>
         <td class="b-tr">${fix2(accomTotal)}</td></tr>` : "";
    const otherSvcSection = otherSvcRows
      ? `<tr class="b-sec"><td colspan="4">Additional Services (Non-Taxable)</td></tr>
         ${otherSvcRows}
         <tr class="b-subtotal"><td colspan="3" class="b-tr">Services Total</td>
           <td class="b-tr">${fix2(otherSvcTotal)}</td></tr>` : "";
    const discountRow = discounts > 0
      ? `<tr><td colspan="3" style="text-align:right;color:#2e7d32;font-weight:600;">Discount</td>
         <td class="b-tr" style="color:#2e7d32;font-weight:700;">− ${fix2(discounts)}</td></tr>` : "";
    let roomRentRows = "";
    if (roomSegments.length > 0 && currentRoomDays != null) {
      for (const seg of roomSegments) {
        if ((seg.days || 0) > 0) {
          const st = segTaxable(seg.total || 0, seg.price || 0);
          const sr = seg.days ? st / seg.days : 0;
          roomRentRows += `<tr><td>Room Rent – Rm ${seg.from_room || ""}</td>
            <td class="b-tr">${seg.days}</td>
            <td class="b-tr">${fix2(sr)}</td>
            <td class="b-tr">${fix2(st)}</td></tr>`;
        }
      }
      if ((currentRoomDays || 0) > 0) {
        const ct = segTaxable(currentRoomTotal || 0, currentRoomPrice || 0);
        const cr = currentRoomDays ? ct / currentRoomDays : 0;
        roomRentRows += `<tr><td>Room Rent – Rm ${currentRoomNo}</td>
          <td class="b-tr">${currentRoomDays}</td>
          <td class="b-tr">${fix2(cr)}</td>
          <td class="b-tr">${fix2(ct)}</td></tr>`;
      }
    } else {
      roomRentRows = `<tr><td>Room Rent</td>
        <td class="b-tr">${days}</td>
        <td class="b-tr">${fix2(accomBase / (days || 1))}</td>
        <td class="b-tr">${fix2(accomBase)}</td></tr>`;
    }
    const taxableBaseRow = accomAddons.length > 0
      ? `<tr class="b-gst-row"><td>Taxable Base (excl. GST)</td>
         <td class="b-tr">—</td><td class="b-tr">—</td>
         <td class="b-tr">${fix2(accomBase)}</td></tr>`
      : "";
    const refundRows = refunds > 0 ? (() => {
      const rc = refundCash > 0 ? `<tr><td>Refund Given (Cash)</td><td class="b-tr" style="color:#c00;">− ₹ ${fix2(refundCash)}</td></tr>` : "";
      const ro = refundOnline > 0 ? `<tr><td>Refund Given (UPI)</td><td class="b-tr" style="color:#c00;">− ₹ ${fix2(refundOnline)}</td></tr>` : "";
      const rf = !refundCash && !refundOnline ? `<tr><td>Refund Given</td><td class="b-tr" style="color:#c00;">− ₹ ${fix2(refunds)}</td></tr>` : "";
      return rc + ro + rf + `<tr class="b-subtotal"><td>Net Collected</td><td class="b-tr">₹ ${fix2(netCollected)}</td></tr>`;
    })() : "";
    return `<div class="b-bill-wrap">
  <div class="b-header-block">
    <div class="b-lodge-name">CIBARA COMFORTS</div>
    <div class="b-lodge-entity">A Unit of Cibara Enterprise</div>
    <div class="b-lodge-sub">Opposite Bus Stand Road, Harihar, Karnataka – 577601</div>
    <div class="b-lodge-sub">Ph: +91 9482831381</div>
    <div class="b-gstin-bar">GSTIN: 29AAWFC1962B1Z9 &nbsp;·&nbsp; SAC: 9963 &nbsp;·&nbsp; Karnataka (KA – 29)</div>
    <div class="b-title">TAX INVOICE</div>
  </div>
  <table class="b-info-outer"><tr>
    <td class="b-info-col">
      <div class="b-row"><span class="b-lbl">Bill No:</span> ${displayBillNo}</div>
      <div class="b-row"><span class="b-lbl">Guest Name:</span> ${b.guest_name || "-"}</div>
      <div class="b-row"><span class="b-lbl">Mobile:</span> ${b.guest_mobile || "N/A"}</div>
      <div class="b-row"><span class="b-lbl">Room No:</span> ${b.room || "-"}</div>
      <div class="b-row"><span class="b-lbl">Guests:</span> ${b.guest_count || 1}</div>
    </td>
    <td class="b-info-col b-info-col-r">
      <div class="b-row"><span class="b-lbl">Check-in:</span> ${fmtBillDT(b.checkin_time)}</div>
      <div class="b-row"><span class="b-lbl">Check-out:</span> ${fmtBillDT(b.checkout_time)}</div>
      <div class="b-row"><span class="b-lbl">Days Stayed:</span> ${days}</div>
      <div class="b-row"><span class="b-lbl">Bill Date:</span> ${billDate}</div>
      <div class="b-row"><span class="b-lbl">Place of Supply:</span> Karnataka (KA – 29)</div>
    </td>
  </tr></table>
  <table class="b-tbl">
    <thead><tr>
      <th>Description</th><th class="b-tr">Qty</th>
      <th class="b-tr">Rate (₹)</th><th class="b-tr">Amount (₹)</th>
    </tr></thead>
    <tbody>
      <tr class="b-sec"><td colspan="4">Accommodation Charges (SAC: 9963)</td></tr>
      ${roomRentRows}
      ${accomAddonRows}${taxableBaseRow}${gstRows}${accomSubtotalRow}${otherSvcSection}${discountRow}
      <tr class="b-grand">
        <td colspan="3" class="b-tr">GRAND TOTAL</td>
        <td class="b-tr">₹ ${fix2(grandTotal)}</td>
      </tr>
    </tbody>
  </table>
  <div class="b-pay-section">
    <div class="b-pay-title">Payment Details</div>
    <table class="b-tbl"><tbody>
      <tr><td>Cash Paid</td><td class="b-tr">₹ ${fix2(cashPaid)}</td></tr>
      <tr><td>Online / UPI Paid</td><td class="b-tr">₹ ${fix2(onlinePaid)}</td></tr>
      <tr class="b-subtotal"><td>Total Paid</td><td class="b-tr">₹ ${fix2(totalPaid)}</td></tr>
      ${refundRows}
      ${balance > 0 ? `<tr><td style="font-weight:800;color:#c62828;">Balance Due</td><td class="b-tr" style="font-weight:800;color:#c62828;">₹ ${fix2(balance)}</td></tr>` : ""}
      ${balance <= 0 && refunds <= 0 ? `<tr><td style="color:#2e7d32;font-weight:700;">Payment Status</td><td class="b-tr" style="color:#2e7d32;font-weight:700;">PAID IN FULL</td></tr>` : ""}
    </tbody></table>
  </div>
  <table class="b-sig"><tr>
    <td><div class="b-sig-line">Guest Signature</div></td>
    <td style="text-align:right"><div class="b-sig-line">Authorised Signatory</div></td>
  </tr></table>
  <div class="b-footer">
    <p>Thank you for staying at Cibara Comforts. We look forward to welcoming you again!</p>
    <p>This is a computer-generated invoice.</p>
  </div>
</div>`;
  }

  // ── Bill viewer functions ─────────────────────────────────────────────────────
  async function openRegBill(id) {
    const overlay = dom("reg-bill-overlay");
    const area    = dom("reg-bill-print-area");
    if (!overlay || !area) return;
    area.innerHTML = `<div class="reg-state"><div class="reg-loader"></div><p>Loading…</p></div>`;
    overlay.classList.add("show");
    try {
      const res  = await apiFetch(`/generate_bill/${id}`);
      const data = await res.json();
      if (data.success) {
        area.innerHTML = buildBillHTML(data.bill);
      } else {
        area.innerHTML = `<div class="reg-state" style="color:#c00;"><i class="fas fa-times-circle"></i><p>${data.message || "Failed to load bill"}</p></div>`;
      }
    } catch (err) {
      area.innerHTML = `<div class="reg-state" style="color:#c00;"><i class="fas fa-times-circle"></i><p>Network error</p></div>`;
    }
  }
  function _closeRegBill() {
    const overlay = dom("reg-bill-overlay");
    if (overlay) overlay.classList.remove("show");
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
    <div class="reg-filter-row reg-filter-row-1">
      ${datePickerMarkup}
      ${dateButtons}
    </div>
    <div class="reg-filter-row reg-filter-row-2">
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
          <th>#</th><th>Bill No</th><th>Guest</th><th>Contact</th>
          <th>Room</th><th>Check-in</th><th>Check-out</th><th>Days</th>
          <th>Rate</th><th>Services</th><th>Total</th>
          <th>Payment</th><th>Status</th><th></th>
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
    <div id="reg-bill-print-area">
      <div class="reg-state"><div class="reg-loader"></div><p>Loading…</p></div>
    </div>
    <div class="bill-actions">
      <button onclick="window.print()" style="background:#6c757d;color:#fff;border:none;padding:.35rem .8rem;border-radius:6px;cursor:pointer;font-size:.82rem;">
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

        // Bill number click → open bill viewer
        const billLink = e.target.closest(".reg-bill-link");
        if (billLink) {
          e.stopPropagation();
          openRegBill(billLink.dataset.id);
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

        const docBtn = e.target.closest(".reg-doc-btn");
        if (docBtn) {
          e.stopPropagation();
          _openDocsModal(
            docBtn.dataset.mobile,
            decodeURIComponent(docBtn.dataset.guest || "")
          );
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
    renderTable();
    _checkAndShowDocButtons();
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
    // Make bill number clickable for completed bills with a real Firestore doc id
    const isRealBill = billNo !== "-" && e.id && !String(e.id).startsWith("active_");
    const billNoCell = isRealBill
      ? `<button class="reg-bill-link" data-id="${e.id}" title="View Bill">${billNo}</button>`
      : `<span style="font-size:.73rem;white-space:nowrap;">${billNo}</span>`;
    return `<tr class="date-group-row" data-date-group="${dk}" data-entry-id="${e.id || ''}">
      <td>${serial}</td>
      <td>${billNoCell}</td>
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
      <td style="white-space:nowrap;">
        <button class="reg-pay-btn"
            data-perm="payment.edit"
            data-room="${e.room}"
            data-guest="${encodeURIComponent(e.guest_name || '')}"
            data-checkin="${e.checkin_time || ''}"
            title="View / edit payments">₹</button>${e.guest_mobile
          ? `<button class="reg-doc-btn"
                data-mobile="${e.guest_mobile}"
                data-guest="${encodeURIComponent(e.guest_name || '')}"
                title="View ID documents"
                style="display:none;"><i class="fas fa-id-card"></i></button>`
          : ''}</td>
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
      // Reveal the hidden doc buttons for mobiles that have documents
      document.querySelectorAll(".reg-doc-btn").forEach(btn => {
        if (withDocs.has(btn.dataset.mobile)) {
          btn.style.display = "inline-block";
        }
      });
    } catch (_) {
      // Silent fail — buttons stay hidden, not a blocking issue
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

  // Shared fetch logic — called after password is confirmed (via prompt or cache)
  async function _loadAndShowPayments() {
    const btn = dom("rpm-submit");
    const err = dom("rpm-err");

    try {
      const res = await apiFetch("/get_stay_payments", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          password:     pmState.password,
          // Canonical foreign key (Phase-6). Backend falls back to the
          // legacy heuristic when stay_id is absent (legacy active stays).
          stay_id:      pmState.entry.stay_id || "",
          room:         pmState.entry.room,
          guest_name:   pmState.entry.guest_name,
          checkin_time: pmState.entry.checkin_time,
        }),
      });

      if (res.status === 403) {
        // Stored password rejected (e.g. changed server-side) — clear and re-prompt
        pmState.password = null;
        _openPasswordPrompt(pmState.entry);
        return;
      }

      const data = await res.json();
      if (!data.success) {
        _notify(data.message || "Failed to load payments.", "error");
        return;
      }

      pmState.payments = data.payments || [];
      _showPaymentsModal();

    } catch (e) {
      _notify("Network error loading payments.", "error");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Open Payments"; }
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
  function _showPaymentsModal() {
    const overlay = dom("rp-overlay");
    const meta    = dom("rp-meta");
    const content = dom("rp-content");
    if (!overlay) return;

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
    _renderPaymentsTable(content);
    // Render services section (filters out water services)
    _renderServicesSection(dom("rp-services-section"));
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

  function _renderPaymentsTable(container) {
    if (!container) return;
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
          <td colspan="5">
            <div class="rp-edit-form">
              <label style="font-size:.75rem;font-weight:600;color:#555;white-space:nowrap;">Date:</label>
              <input type="date" id="rp-edit-date-${p.id}" value="${p.date || ''}" />
              <label style="font-size:.75rem;font-weight:600;color:#555;white-space:nowrap;">Mode:</label>
              <select id="rp-edit-mode-${p.id}">
                <option value="cash"   ${p.method === "cash"   ? "selected" : ""}>Cash</option>
                <option value="online" ${p.method === "online" ? "selected" : ""}>Online</option>
                <option value="upi"    ${p.method === "upi"    ? "selected" : ""}>UPI</option>
                <option value="ota"    ${p.method === "ota"    ? "selected" : ""}>OTA</option>
              </select>
              ${!isRefund ? `
              <label style="font-size:.75rem;font-weight:600;color:#555;white-space:nowrap;">Amount (₹):</label>
              <input type="number" id="rp-edit-amount-${p.id}" value="${p.amount || 0}" min="1" style="width:80px;" />
              ` : `<span style="font-size:.72rem;color:#888;align-self:center;">(refund — amount locked)</span>`}
              <button class="rp-save-btn"        onclick="_rpSave('${p.id}')">Save</button>
              <button class="rp-cancel-edit-btn" onclick="_rpCancelEdit()">Cancel</button>
            </div>
          </td>
        </tr>`;
      } else {
        rows += `
        <tr data-pid="${p.id}">
          <td>${_fmtPmDate(p.date)}${p.time ? ' <span style="color:#999;font-size:.7rem;">' + p.time + '</span>' : ''}</td>
          <td><span class="${_methodCls(p.method)}">${_methodLbl(p.method)}</span></td>
          <td><strong>₹${(p.amount || 0).toLocaleString("en-IN")}</strong></td>
          <td style="color:#666;font-size:.73rem;">${_typeLabel(p.type)}</td>
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
            <th>Date</th><th>Mode</th><th>Amount</th><th>Type</th><th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  // Called by onclick attributes in the rendered table
  window._rpStartEdit = function(payId) {
    pmState.editId = payId;
    const container = dom("rp-content");
    _renderPaymentsTable(container);
    // Focus the date input
    const dateInput = dom(`rp-edit-date-${payId}`);
    if (dateInput) dateInput.focus();
  };

  window._rpCancelEdit = function() {
    pmState.editId = null;
    _renderPaymentsTable(dom("rp-content"));
  };

  window._rpSave = async function(payId) {
    const dateInput   = dom(`rp-edit-date-${payId}`);
    const modeInput   = dom(`rp-edit-mode-${payId}`);
    const amountInput = dom(`rp-edit-amount-${payId}`);
    const saveBtn     = document.querySelector(`.rp-edit-row[data-pid="${payId}"] .rp-save-btn`);

    const newDate   = dateInput   ? dateInput.value.trim()  : "";
    const newMethod = modeInput   ? modeInput.value.trim()  : "";
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
        if (newAmount !== null) p.amount = newAmount;
      }

      pmState.editId = null;
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
})();
