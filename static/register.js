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
}

/* ── Payments button (per register row) ── */
.reg-pay-btn {
  padding: .18rem .42rem; border: 1px solid #adb5bd;
  background: #fff; color: #555; border-radius: 4px;
  cursor: pointer; font-size: .7rem; font-weight: 600;
  transition: all .15s; white-space: nowrap;
}
.reg-pay-btn:hover { background: #6c757d; color: #fff; border-color: #6c757d; }

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
.rp-method-cash   { color: #28a745; font-weight: 700; font-size: .72rem; }
.rp-method-online { color: #1565c0; font-weight: 700; font-size: .72rem; }
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

    // Delegated: group toggle + pay button
    const tbody = dom("reg-table-body");
    if (tbody) {
      tbody.addEventListener("click", (e) => {
        const hdr = e.target.closest(".date-group-header");
        if (hdr) { toggleGroup(hdr); return; }

        const payBtn = e.target.closest(".reg-pay-btn");
        if (payBtn) {
          e.stopPropagation();
          _openPasswordPrompt({
            room:         payBtn.dataset.room,
            guest_name:   decodeURIComponent(payBtn.dataset.guest || ""),
            checkin_time: payBtn.dataset.checkin,
          });
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

    // Close modals on overlay click
    const rpmOverlay = dom("rpm-overlay");
    if (rpmOverlay) rpmOverlay.addEventListener("click", (e) => {
      if (e.target === rpmOverlay) _closePasswordPrompt();
    });
    const rpOverlay = dom("rp-overlay");
    if (rpOverlay) rpOverlay.addEventListener("click", (e) => {
      if (e.target === rpOverlay) _closePaymentsModal();
    });
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
      <td style="white-space:nowrap;">
        <button class="reg-pay-btn"
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
    entry:    null,   // { room, guest_name, checkin_time }
    password: null,   // stored in-memory after first successful verify
    payments: [],     // loaded payment records
    editId:   null,   // payment doc id currently being edited
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

  // ── Password prompt ───────────────────────────────────────────────────────────
  function _openPasswordPrompt(entry) {
    pmState.entry = entry;

    // If password already verified this session, skip prompt and load directly
    if (pmState.password) {
      _loadAndShowPayments();
      return;
    }

    const overlay = dom("rpm-overlay");
    const pwd     = dom("rpm-password");
    const err     = dom("rpm-err");
    if (!overlay) return;
    if (err)  { err.style.display = "none"; err.textContent = ""; }
    if (pwd)  { pwd.value = ""; }
    overlay.classList.add("show");
    setTimeout(() => { if (pwd) pwd.focus(); }, 80);
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
        `<strong>Check-in:</strong> ${e.checkin_time || "-"}`;
    }

    pmState.editId = null;
    _renderPaymentsTable(content);
    overlay.classList.add("show");
  }

  function _closePaymentsModal() {
    const overlay = dom("rp-overlay");
    if (overlay) overlay.classList.remove("show");
    pmState.editId  = null;
    pmState.entry   = null;
    pmState.payments = [];
    // Do NOT clear pmState.password — user may open another entry without re-typing
  }

  function _renderPaymentsTable(container) {
    if (!container) return;
    // Only show cash / online payments and refund entries — exclude checkin, checkout,
    // addon, renewal, pay_later, expense, discount and any other internal log types.
    const ALLOWED_METHODS = new Set(["cash", "online"]);
    const REFUND_TYPES    = new Set(["refund", "checkout_refund", "manual_refund"]);
    const payments = (pmState.payments || []).filter(
      p => ALLOWED_METHODS.has(p.method) || REFUND_TYPES.has(p.type)
    );

    if (!payments.length) {
      container.innerHTML = `<div class="rp-empty">No payment records found for this stay.</div>`;
      return;
    }

    let rows = "";
    payments.forEach((p) => {
      const isEditing = (pmState.editId === p.id);
      const methodCls = p.method === "cash" ? "rp-method-cash" : "rp-method-online";
      const methodLbl = p.method === "cash" ? "Cash" : (p.method === "online" ? "Online" : p.method);
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
          <td><span class="${methodCls}">${methodLbl}</span></td>
          <td><strong>₹${(p.amount || 0).toLocaleString("en-IN")}</strong></td>
          <td style="color:#666;font-size:.73rem;">${_typeLabel(p.type)}</td>
          <td><button class="rp-edit-btn" onclick="_rpStartEdit('${p.id}')">Edit</button></td>
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
