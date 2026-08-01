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
  align-items: center; margin-bottom: 0.7rem; gap: .6rem;
  flex-wrap: wrap;
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
.bl-src-mmt       { background: #fff3e0; color: #e65100; }

.bl-bill-btn {
  width: 28px; height: 28px; padding: 0;
  background: var(--primary, #3f51b5);
  color: #fff; border: none; border-radius: 6px;
  cursor: pointer; font-size: 0.8rem;
  display: inline-flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.bl-bill-btn:hover { opacity: 0.82; }

/* Payment cell click affordance — only visible to admin users.
   body[data-role] is stamped by auth.js once the role is known, so the
   cursor/hover only appear after CibaraAuth has resolved. Non-admin
   users see the cell unchanged. */
.bl-pay-clickable { border-radius: 4px; padding: 2px 4px; margin: -2px -4px; transition: background .12s; }
body[data-role="admin"] .bl-pay-clickable { cursor: pointer; }
body[data-role="admin"] .bl-pay-clickable:hover { background: #eef2ff; }

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
/* Checkout note typed in the "Settle Later" box — shown under the guest
   name on pending rows only. */
.bl-guest-note {
  margin-top: 2px;
  font-size: 0.68rem; font-weight: 400;
  color: #b45309; line-height: 1.3;
  white-space: normal; max-width: 190px;
}
.bl-guest-note i { margin-right: 3px; opacity: 0.75; }
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

  /* Exactly 3 stat cards per row on phones — the auto-fit minmax(130px,1fr)
     default only fits 2 across on most phone widths. */
  .bills-tally {
    grid-template-columns: repeat(3, 1fr);
    gap: 0.4rem;
  }
  .bl-card { padding: 0.45rem 0.5rem; }
  .bl-card .bl-label { font-size: 0.58rem; }
  .bl-card .bl-value { font-size: 0.82rem; }
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
.bl-pay-modal input[type=number],
.bl-pay-modal input[type=date] {
  width: 100%; padding: .5rem .65rem; border: 1px solid #d0d0d0;
  border-radius: 7px; font-size: .9rem; outline: none; font-family: inherit;
  background: #fff; color: #333; height: 38px; line-height: 1.2;
  transition: border-color .15s; box-sizing: border-box;
}
.bl-pay-modal input[type=number]:focus,
.bl-pay-modal input[type=date]:focus { border-color: var(--primary,#3f51b5); }
.bl-pay-modal input[type=date]::-webkit-calendar-picker-indicator { cursor: pointer; opacity: .6; }
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

/* ── Edit-guest action button (in table rows) ── */

/* ── Activity trail: just small colored icons under the guest name ── */
/* Bare glyphs — WhatsApp (green), printed (blue), edited (amber). No text, no
   chips. Sits on its own line under the name (display:flex + fit-content) and
   is clickable to open the full timeline; who/when is in the hover tooltip. */
.bl-act-strip { display: flex; width: fit-content; align-items: center; gap: 8px; margin-top: 4px; cursor: pointer; }
.bl-act-i { font-size: .8rem; opacity: .85; transition: opacity .15s; }
.bl-act-strip:hover .bl-act-i { opacity: 1; }
.bl-act-wa    { color: #25D366; }
.bl-act-print { color: #1e88e5; }
.bl-act-edit  { color: #f59e0b; }

.bl-edit-backdrop, .bl-hist-backdrop {
  position: fixed; inset: 0; background: rgba(15,23,42,.45);
  display: none; align-items: center; justify-content: center; z-index: 1200; padding: 16px;
}
.bl-edit-backdrop.show, .bl-hist-backdrop.show { display: flex; }
.bl-edit-modal, .bl-hist-modal {
  background: #fff; border-radius: 14px; width: 100%; max-width: 380px;
  box-shadow: 0 20px 50px rgba(0,0,0,.25); padding: 18px 18px 16px; box-sizing: border-box;
}
.bl-edit-head, .bl-hist-head { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 4px; }
.bl-edit-head h3, .bl-hist-head h3 { margin: 0; font-size: 1.02rem; color: #1e293b; }
.bl-edit-x, .bl-hist-x { background: none; border: none; font-size: 1.4rem; line-height: 1; color: #94a3b8; cursor: pointer; }
.bl-edit-sub, .bl-hist-sub { font-size: .76rem; color: #64748b; margin-bottom: 12px; }
.bl-edit-label { display: block; font-size: .76rem; font-weight: 600; color: #475569; margin-bottom: 12px; }
.bl-edit-label input {
  display: block; width: 100%; margin-top: 5px; padding: 9px 11px;
  border: 1px solid #cbd5e1; border-radius: 8px; font-size: .9rem; box-sizing: border-box;
}
.bl-edit-label input:focus { outline: none; border-color: #3f51b5; box-shadow: 0 0 0 3px rgba(63,81,181,.12); }
.bl-edit-err { min-height: 16px; color: #dc2626; font-size: .74rem; margin-bottom: 8px; }
.bl-edit-actions { display: flex; gap: 10px; justify-content: flex-end; }
.bl-edit-cancel, .bl-edit-save { padding: 8px 16px; border-radius: 8px; font-size: .84rem; font-weight: 600; cursor: pointer; border: 1px solid transparent; }
.bl-edit-cancel { background: #f1f5f9; color: #475569; border-color: #e2e8f0; }
.bl-edit-save { background: #3f51b5; color: #fff; }
.bl-edit-save:disabled { opacity: .6; cursor: wait; }

.bl-hist-body { max-height: 60vh; overflow-y: auto; margin-top: 6px; }
.bl-hist-state { color: #94a3b8; font-size: .82rem; text-align: center; padding: 22px 0; }
.bl-hist-item { display: flex; gap: 10px; padding: 9px 2px; border-bottom: 1px solid #f1f5f9; }
.bl-hist-item:last-child { border-bottom: none; }
.bl-hist-dot { flex: 0 0 26px; width: 26px; height: 26px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: .72rem; background: #f1f5f9; color: #64748b; }
.bl-hist-wa    { background: #e8f5e9; color: #2e7d32; }
.bl-hist-print { background: #e3f2fd; color: #1565c0; }
.bl-hist-edit  { background: #fff3e0; color: #e65100; }
.bl-hist-pay   { background: #ede7f6; color: #5e35b1; }
.bl-hist-gst   { background: #e0f2f1; color: #00695c; }
.bl-hist-line { font-size: .84rem; color: #1e293b; }
.bl-hist-to { color: #2e7d32; font-weight: 600; font-size: .78rem; }
.bl-hist-meta { font-size: .72rem; color: #94a3b8; margin-top: 1px; }

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

/* ── Bill view toggle (Detailed / Consolidated) ───────────────────────────
   A control bar above the bill body — never part of the printed output. */
.bl-view-toggle {
  display: flex; align-items: center; gap: .45rem;
  padding: .5rem .7rem; margin: 0 0 .55rem;
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

/* ────────────────────────────────────────────────────────────────────
   GST / Section-34 UI — minimalist, audit-readable
   ──────────────────────────────────────────────────────────────────── */

/* B2B / Reverted pills (row indicators) */
.bl-b2b-pill { display:inline-flex; align-items:center; margin-left:.35rem;
  padding:.1rem .42rem .1rem .32rem; border-radius:4px;
  font-size:.62rem; font-weight:700; letter-spacing:.05em;
  background:linear-gradient(180deg, #1e40af 0%, #1e3a8a 100%); color:#fff;
  vertical-align:middle; box-shadow:0 1px 2px rgba(30,58,138,.25);
  cursor:default; }
.bl-b2b-pill::before { content:"\\2666"; margin-right:.2rem; opacity:.85; font-size:.6rem; }
.bl-reverted-pill { display:inline-flex; align-items:center; margin-left:.35rem;
  padding:.1rem .42rem; border-radius:4px;
  font-size:.62rem; font-weight:700; letter-spacing:.05em;
  background:#fef2f2; color:#991b1b; border:1px solid #fecaca;
  vertical-align:middle; cursor:default; }
.bl-reverted-pill::before { content:"\\21BA"; margin-right:.2rem; font-weight:800; }
.bl-cancel-pill { display:inline-flex; align-items:center; margin-left:.35rem;
  padding:.1rem .42rem; border-radius:4px;
  font-size:.62rem; font-weight:700; letter-spacing:.05em;
  background:#fffbeb; color:#92400e; border:1px solid #fde68a;
  vertical-align:middle; cursor:default; }
.bl-cancel-pill::before { content:"\\2716"; margin-right:.2rem; font-weight:800; }

/* Per-row GST icon: subdued when no GSTIN, primary when B2B set */
.bl-gst-btn { width:28px; height:28px; padding:0; border:none; border-radius:6px;
  cursor:pointer; font-size:.78rem; display:inline-flex; align-items:center;
  justify-content:center; background:#e2e8f0; color:#475569; flex-shrink:0;
  transition:background .15s, color .15s, transform .1s; }
.bl-gst-btn:hover { background:#cbd5e1; color:#1e293b; }
.bl-gst-btn.bl-gst-set { background:#1e40af; color:#fff; }
.bl-gst-btn.bl-gst-set:hover { background:#1e3a8a; }
.bl-gst-btn.bl-gst-locked { background:#fef2f2; color:#991b1b; cursor:not-allowed; border:1px solid #fecaca; }
.bl-gst-btn:active { transform:scale(.95); }

/* GST modal — cleaner card, two-column for code+state */
.bl-gst-backdrop { display:none; position:fixed; inset:0;
  background:rgba(15,23,42,.5); z-index:10001;
  align-items:center; justify-content:center;
  backdrop-filter:blur(2px); -webkit-backdrop-filter:blur(2px); }
.bl-gst-backdrop.open { display:flex; }
.bl-gst-modal { background:#fff; border-radius:14px; padding:0;
  width:520px; max-width:94vw; max-height:92vh; overflow:auto;
  box-shadow:0 20px 60px rgba(15,23,42,.18), 0 4px 12px rgba(15,23,42,.06); }
.bl-gst-head { padding:1.1rem 1.3rem .85rem;
  border-bottom:1px solid #f1f5f9;
  display:flex; align-items:flex-start; gap:.8rem; }
.bl-gst-head-icon { width:36px; height:36px; border-radius:8px;
  background:#dbeafe; color:#1e40af; display:flex; align-items:center;
  justify-content:center; font-size:1rem; flex-shrink:0; }
.bl-gst-head-text { flex:1; min-width:0; }
.bl-gst-head h2 { margin:0; font-size:1rem; color:#0f172a; font-weight:700;
  letter-spacing:-.01em; }
.bl-gst-head .bl-gst-sub { margin-top:.15rem; font-size:.74rem; color:#64748b;
  display:flex; gap:.45rem; align-items:center; flex-wrap:wrap; }
.bl-gst-head .bl-gst-billno { font-family: ui-monospace, "SF Mono", Menlo, monospace;
  background:#f1f5f9; color:#0f172a; padding:.05rem .35rem; border-radius:4px; }
.bl-gst-state-chip { padding:.13rem .42rem; border-radius:4px;
  font-size:.62rem; font-weight:700; letter-spacing:.05em; text-transform:uppercase; }
.bl-gst-state-b2c { background:#f1f5f9; color:#475569; }
.bl-gst-state-b2b { background:#1e40af; color:#fff; }
.bl-gst-state-locked { background:#fee2e2; color:#991b1b; }

.bl-gst-body { padding:.9rem 1.3rem 1rem; }
.bl-gst-row { display:flex; flex-direction:column; margin-bottom:.7rem; }
.bl-gst-row.row-2col { display:grid; grid-template-columns:1fr 1fr; gap:.7rem; }
.bl-gst-modal label { display:block; font-size:.7rem; font-weight:700;
  color:#475569; margin-bottom:.2rem; text-transform:uppercase; letter-spacing:.06em; }
.bl-gst-modal label .bl-req { color:#dc2626; margin-left:.15rem; }
.bl-gst-modal label .bl-hint-text { color:#94a3b8; font-weight:500; text-transform:none;
  letter-spacing:0; margin-left:.3rem; }
.bl-gst-modal input { width:100%; padding:.5rem .65rem; border:1px solid #cbd5e1;
  border-radius:7px; font-size:.88rem; outline:none; box-sizing:border-box;
  transition:border-color .15s, box-shadow .15s; color:#0f172a; }
.bl-gst-modal input:focus { border-color:#1e40af;
  box-shadow:0 0 0 3px rgba(30,64,175,.12); }
.bl-gst-modal input::placeholder { color:#94a3b8; font-size:.85rem; }
.bl-gst-modal input.bl-gst-invalid { border-color:#dc2626; background:#fef2f2; }
.bl-gst-modal input.bl-gst-valid { border-color:#16a34a; padding-right:2rem;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%2316a34a' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='20 6 9 17 4 12'/%3E%3C/svg%3E");
  background-repeat:no-repeat; background-position:right .55rem center; }
.bl-gst-derived { font-size:.7rem; color:#64748b; margin-top:.25rem; display:flex;
  align-items:center; gap:.3rem; min-height:1rem; }
.bl-gst-derived.ok { color:#15803d; }
.bl-gst-derived.bad { color:#b91c1c; }
.bl-gst-warn { font-size:.72rem; color:#92400e;
  background:#fffbeb; border:1px solid #fde68a; padding:.4rem .55rem;
  border-radius:6px; margin-top:.45rem; display:flex; gap:.4rem; }
.bl-gst-warn::before { content:"\\26A0"; flex-shrink:0; }
.bl-gst-error { color:#b91c1c; font-size:.78rem; min-height:1.1rem;
  margin:.3rem 0 .15rem; }
.bl-gst-foot-note { font-size:.68rem; color:#64748b; line-height:1.5;
  padding:.55rem .75rem; background:#f8fafc;
  border:1px solid #e2e8f0; border-radius:6px;
  margin-top:.55rem; }
.bl-gst-foot-note strong { color:#0f172a; }

.bl-gst-actions { padding:.85rem 1.3rem 1.1rem;
  border-top:1px solid #f1f5f9;
  display:flex; gap:.55rem; justify-content:flex-end; }
.bl-gst-actions button { padding:.55rem 1.1rem; border:none; border-radius:7px;
  font-size:.84rem; font-weight:600; cursor:pointer;
  transition:opacity .15s, background .15s; }
.bl-gst-actions .bl-gst-cancel { background:#f1f5f9; color:#475569; }
.bl-gst-actions .bl-gst-cancel:hover { background:#e2e8f0; }
.bl-gst-actions .bl-gst-clear { background:#fff; color:#dc2626; border:1px solid #fecaca; }
.bl-gst-actions .bl-gst-clear:hover { background:#fef2f2; }
.bl-gst-actions .bl-gst-save { background:#1e40af; color:#fff; min-width:120px; }
.bl-gst-actions .bl-gst-save:hover { background:#1e3a8a; }
.bl-gst-actions button:disabled { opacity:.5; cursor:not-allowed; }

/* ────────────────────────────────────────────────────────────────────
   Bills / Credit Notes sub-tabs
   ──────────────────────────────────────────────────────────────────── */
.bl-subtab-bar { display:flex; gap:0; margin-bottom:.7rem;
  border-bottom:1.5px solid #e2e8f0; padding:0 .1rem; }
.bl-subtab-btn { padding:.45rem .9rem; border:none; background:transparent;
  font-size:.79rem; font-weight:600; color:#64748b; cursor:pointer;
  border-bottom:2px solid transparent; margin-bottom:-1.5px;
  transition:color .15s, border-color .15s;
  display:flex; align-items:center; gap:.4rem; }
.bl-subtab-btn:hover { color:#0f172a; }
.bl-subtab-btn.active { color:#1e40af; border-bottom-color:#1e40af; }
.bl-subtab-btn .bl-subtab-count { background:#f1f5f9; color:#475569;
  font-size:.66rem; font-weight:700; padding:.05rem .35rem; border-radius:8px; }
.bl-subtab-btn.active .bl-subtab-count { background:#dbeafe; color:#1e40af; }

/* ────────────────────────────────────────────────────────────────────
   Credit Notes pane — summary stat strip + table
   ──────────────────────────────────────────────────────────────────── */
.bl-cn-stats { display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr));
  gap:.5rem; margin-bottom:.7rem; }
.bl-cn-stat { background:#fff; border:1px solid #e2e8f0; border-radius:8px;
  padding:.55rem .75rem; }
.bl-cn-stat-label { font-size:.66rem; font-weight:700; color:#64748b;
  text-transform:uppercase; letter-spacing:.05em; }
.bl-cn-stat-value { font-size:1.05rem; font-weight:700; color:#0f172a;
  margin-top:.15rem; font-variant-numeric: tabular-nums; }
.bl-cn-stat.b2b { border-left:3px solid #1e40af; }
.bl-cn-stat.b2c { border-left:3px solid #475569; }
.bl-cn-stat.value { border-left:3px solid #b91c1c; }
.bl-cn-stat.value .bl-cn-stat-value { color:#b91c1c; }

.bl-cn-filters { display:flex; gap:.35rem; margin-bottom:.55rem; flex-wrap:wrap; }
.bl-cn-filter { padding:.25rem .65rem; border-radius:14px;
  border:1px solid #cbd5e1; background:#fff; font-size:.72rem; font-weight:600;
  color:#475569; cursor:pointer; transition:all .15s; }
.bl-cn-filter:hover { background:#f1f5f9; }
.bl-cn-filter.active { background:#1e40af; color:#fff; border-color:#1e40af; }

.bl-cn-container { background:#fff; border-radius:8px;
  border:1px solid #e2e8f0; box-shadow:0 1px 3px rgba(15,23,42,.04);
  overflow:hidden; }
.bl-cn-table { width:100%; border-collapse:collapse; font-size:.81rem;
  font-variant-numeric: tabular-nums; }
.bl-cn-table thead { background:#f8fafc; border-bottom:1px solid #e2e8f0; }
.bl-cn-table th { padding:.55rem .7rem; text-align:left; font-weight:700;
  font-size:.69rem; color:#475569; text-transform:uppercase;
  letter-spacing:.04em; white-space:nowrap; }
.bl-cn-table td { padding:.6rem .7rem; border-bottom:1px solid #f1f5f9;
  vertical-align:middle; }
.bl-cn-table tbody tr:hover { background:#fafbfc; }
.bl-cn-table tbody tr:last-child td { border-bottom:0; }

.bl-cn-num { font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size:.78rem; color:#0f172a; font-weight:600; }
.bl-cn-against { font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size:.74rem; color:#64748b; }
.bl-cn-amt { color:#b91c1c; font-weight:700; text-align:right;
  font-variant-numeric: tabular-nums; }
.bl-cn-recipient-b2b { display:inline-flex; align-items:center; gap:.3rem; }
.bl-cn-recipient-b2b .bl-cn-tag-b2b { background:#dbeafe; color:#1e3a8a;
  font-size:.6rem; font-weight:700; padding:.05rem .3rem; border-radius:3px;
  letter-spacing:.04em; }
.bl-cn-reason-badge { display:inline-block; padding:.13rem .45rem;
  border-radius:4px; font-size:.66rem; font-weight:600;
  letter-spacing:.02em; }
.bl-cn-reason-revert { background:#fef2f2; color:#991b1b; }
.bl-cn-reason-discount { background:#fefce8; color:#854d0e; }
.bl-cn-reason-cancel { background:#f3f4f6; color:#374151; }
.bl-cn-reason-deficiency { background:#eff6ff; color:#1e40af; }
.bl-cn-reason-other { background:#f5f3ff; color:#5b21b6; }

.bl-cn-pdf-link { color:#1e40af; text-decoration:none; padding:.25rem .55rem;
  border-radius:5px; background:#dbeafe; font-size:.72rem; font-weight:600;
  display:inline-flex; align-items:center; gap:.3rem; }
.bl-cn-pdf-link:hover { background:#bfdbfe; }
.bl-cn-pdf-btn { padding:.28rem .55rem; border:1px solid #cbd5e1;
  border-radius:5px; background:#fff; color:#475569; font-size:.72rem;
  font-weight:600; cursor:pointer; display:inline-flex; align-items:center;
  gap:.3rem; transition:all .15s; }
.bl-cn-pdf-btn:hover { border-color:#1e40af; color:#1e40af; }
.bl-cn-pdf-btn:disabled { opacity:.6; cursor:wait; }
.bl-cn-wa-btn { padding:.28rem .5rem; border:none; border-radius:5px;
  background:#25D366; color:#fff; font-size:.78rem; cursor:pointer;
  display:inline-flex; align-items:center; justify-content:center;
  flex-shrink:0; transition:opacity .15s, background .15s; }
.bl-cn-wa-btn:hover { opacity:.85; }
.bl-cn-wa-btn:disabled { opacity:.5; cursor:wait; }
/* "Pending" state — shown when PDF hasn't been generated yet. Lighter
   green so it reads as "available but requires one extra step". */
.bl-cn-wa-btn.bl-cn-wa-pending { background:#c8e6c9; color:#388e3c; }
.bl-cn-wa-btn.bl-cn-wa-pending:hover { background:#a5d6a7; }

.bl-cn-empty { padding:2.5rem 1.5rem; text-align:center; color:#94a3b8; }
.bl-cn-empty-icon { font-size:2rem; opacity:.4; margin-bottom:.5rem; display:block; }
.bl-cn-empty-text { font-size:.85rem; }

.bl-cn-foot-note { font-size:.68rem; color:#64748b;
  padding:.6rem .75rem; background:#f8fafc;
  border-top:1px solid #f1f5f9; line-height:1.5; }
.bl-cn-foot-note strong { color:#0f172a; }

/* ────────────────────────────────────────────────────────────────────
   Segmented control in the header (Bills / Credit Notes)
   ──────────────────────────────────────────────────────────────────── */
.bl-seg { display:inline-flex; gap:.25rem; padding:.18rem;
  background:#f1f5f9; border-radius:8px;
  border:1px solid #e2e8f0; }
.bl-seg-btn { padding:.32rem .8rem; border:none;
  background:transparent; border-radius:6px;
  font-size:.78rem; font-weight:600; color:#64748b;
  cursor:pointer; display:inline-flex; align-items:center;
  gap:.4rem; transition:background .15s, color .15s;
  white-space:nowrap; }
.bl-seg-btn:hover { color:#0f172a; }
.bl-seg-btn.active { background:#fff; color:#1e40af;
  box-shadow:0 1px 2px rgba(15,23,42,.05),
             0 0 0 1px rgba(15,23,42,.04); }
.bl-seg-btn .bl-seg-count { background:rgba(100,116,139,.12);
  color:#475569; font-size:.66rem; font-weight:700;
  padding:.05rem .35rem; border-radius:8px;
  font-variant-numeric: tabular-nums; min-width:1rem; text-align:center; }
.bl-seg-btn.active .bl-seg-count { background:#dbeafe; color:#1e40af; }
.bl-seg-btn i { font-size:.78rem; }

/* Bills-only chrome — hidden when the Credit Notes view is active */
.bills-container.cn-active .bills-tally,
.bills-container.cn-active .bl-filter-bar,
.bills-container.cn-active .bl-view-toggle { display:none !important; }
`;

  function injectStyles() {
    if (document.getElementById("bills-mod-styles")) return;
    const s = document.createElement("style");
    s.id = "bills-mod-styles";
    s.textContent = BILLS_CSS;
    document.head.appendChild(s);
  }

  // ── State ────────────────────────────────────────────────────────────────────
  // Paged rendering: rows rendered per page. applyFilters() resets the cap,
  // the "Show more" row extends it. Export/tally still use the FULL
  // filteredEntries list, so aggregates are unaffected by paging.
  const PAGE_SIZE = 100;

  const state = {
    allEntries: [],
    filteredEntries: [],
    visibleCount: PAGE_SIZE,
    loading: false,
    dateRange: { start: null, end: null },
    filters: { search: "", source: "all", payment: "all", type: "all" },
    lastLoadedRange: null,
    _reqId: 0,            // incremented on every fetch; detects stale responses
    // Default: sorted flat list by bill number, latest first. Bill numbers
    // are minted sequentially at checkout (CC/YYYY/MM/XXXXX), so descending
    // bill_no is also chronologically newest-first across months.
    sort: { key: "bill_no", dir: "desc" },
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
      // Consolidated is always the default when the Share modal opens;
      // Detailed is available as a toggle right there, before Send.
      viewMode: "consolidated", // "consolidated" | "detailed"
      billData: null,           // full bill record — fetched lazily if not
                                 // handed in, needed to regenerate on toggle
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

  /**
   * Calculates GST for packaged drinking water (HSN 2201, 5% inclusive/MRP).
   * Only services where item contains "water" AND accommodation_charge != true.
   * Returns { mrp, taxable, cgst, sgst, qty }
   */
  function waterGst(services) {
    let mrp = 0, taxable = 0, cgst = 0, sgst = 0, qty = 0;
    (services || [])
      .filter(s => (s.item || '').toLowerCase().includes('water') && !s.accommodation_charge)
      .forEach(w => {
        const p = parseFloat(w.price || 0);
        const t = p / 1.05;
        const g = p - t;
        mrp      += p;
        taxable  += t;
        cgst     += g / 2;
        sgst     += g / 2;
        qty      += parseFloat(w.quantity || 1);
      });
    return { mrp, taxable, cgst, sgst, qty };
  }

  /**
   * Calculates total accommodation GST (room + accommodation_charge add-ons).
   * Extra bed, AC etc. (accommodation_charge=true) are taxed at same slab as room.
   * Returns { taxable, cgst, sgst, cgstRate }
   */
  function accomGst(e, days) {
    const rate = e.room_rent || e.room_price_per_night || 0;
    const { base, cgst, sgst, cgstRate } = gstAmounts(rate, days);
    // Add accommodation add-ons (extra bed, AC) — same slab
    let accomAddonBase = 0, accomCgst = 0, accomSgst = 0;
    (e.services || [])
      .filter(s => s.accommodation_charge && !(s.item || '').toLowerCase().includes('water'))
      .forEach(s => {
        const p = parseFloat(s.price || 0);
        if (cgstRate > 0) {
          const rate2 = cgstRate * 2; // total %
          const divisor = 1 + rate2 / 100;
          const b = p / divisor;
          accomAddonBase += b;
          accomCgst += (p - b) / 2;
          accomSgst += (p - b) / 2;
        } else {
          accomAddonBase += p;
        }
      });
    return {
      taxable: base + accomAddonBase,
      cgst: cgst + accomCgst,
      sgst: sgst + accomSgst,
      cgstRate,
    };
  }

  /**
   * Authoritative accommodation tax figures for a register entry —
   * Section 15(3)(a): the taxable value is NET of the on-invoice discount.
   * Priority:
   *   1. stored bill aggregates from create_bill_record (already net of
   *      the discount share allocated to accommodation),
   *   2. legacy recompute via accomGst(), then net out the proportional
   *      accommodation discount share (mirrors the backend allocation).
   * Same return shape as accomGst(): { taxable, cgst, sgst, cgstRate }.
   */
  function accomTaxFromEntry(e, days) {
    const rate = e.room_rent || e.room_price_per_night || 0;
    // Slab follows the pre-discount tariff (display fallback only).
    const slabRate = typeof e.gst_rate === "number" ? e.gst_rate
      : rate > 7500 ? 18 : rate >= 1000 ? 5 : 0;
    if (typeof e.accommodation_taxable === "number" && e.accommodation_taxable > 0) {
      const g = typeof e.gst_amount === "number" ? e.gst_amount : 0;
      return {
        taxable: e.accommodation_taxable,
        cgst: g / 2,
        sgst: g - g / 2,
        cgstRate: slabRate / 2,
      };
    }
    const gross = accomGst(e, days);
    const discAll = Number(e.discounts || 0);
    if (discAll <= 0) return gross;
    const accomIncl = rate * (days || 1) + (e.services || [])
      .filter(s => s.accommodation_charge && !(s.item || "").toLowerCase().includes("water"))
      .reduce((s, x) => s + parseFloat(x.price || 0), 0);
    const otherIncl = (e.services || [])
      .filter(s => !s.accommodation_charge)
      .reduce((s, x) => s + parseFloat(x.price || 0), 0);
    const grossAll = accomIncl + otherIncl;
    const accomDisc = grossAll > 0
      ? Math.min(discAll * (accomIncl / grossAll), accomIncl) : 0;
    const net = Math.max(accomIncl - accomDisc, 0);
    // Slab follows the POST-discount value of supply per night
    // (Section 15(3)(a); transaction-value basis) — mirrors
    // config.compute_daily_folio.
    const netPerNight = net / (days || 1);
    const pct = netPerNight < 1000 ? 0 : netPerNight <= 7500 ? 5 : 18;
    if (pct > 0) {
      const base = net / (1 + pct / 100);
      const g = net - base;
      return { taxable: base, cgst: g / 2, sgst: g - g / 2, cgstRate: pct / 2 };
    }
    return { taxable: net, cgst: 0, sgst: 0, cgstRate: 0 };
  }

  // ── GST month lock modal (admin) ──────────────────────────────────────────
  // Months grouped by Indian financial year (Apr–Mar). Locking a month
  // freezes its bills server-side (edits, financial discounts, reverts and
  // late finalizes are refused). The backend is the security boundary —
  // this UI is convenience.
  const _GLOCK_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun",
                         "Jul","Aug","Sep","Oct","Nov","Dec"];
  function _glockFy(period) {
    const y = parseInt(period.slice(0, 4), 10);
    const m = parseInt(period.slice(5, 7), 10);
    const fy = m >= 4 ? y : y - 1;
    return `FY ${fy}\u2013${String((fy + 1) % 100).padStart(2, "0")}`;
  }
  function _glockEsc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function openGstLockModal() {
    let overlay = document.getElementById("bl-gstlock-overlay");
    if (overlay) overlay.remove();
    overlay = document.createElement("div");
    overlay.id = "bl-gstlock-overlay";
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(15,17,26,.45);z-index:9999;" +
      "display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px);";
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:14px;width:min(420px,92vw);
                  max-height:78vh;display:flex;flex-direction:column;overflow:hidden;
                  box-shadow:0 18px 50px rgba(20,20,43,.25);">
        <div style="display:flex;justify-content:space-between;align-items:center;
                    padding:1rem 1.15rem .55rem;">
          <div style="font-weight:700;font-size:.95rem;color:#1f2430;">
            <i class="fas fa-lock" style="color:#6f42c1;margin-right:.5rem;"></i>GST Month Lock
          </div>
          <button id="bl-gstlock-close" aria-label="Close"
                  style="border:none;background:none;font-size:1.25rem;line-height:1;
                         color:#9aa0ad;cursor:pointer;padding:.2rem .4rem;">&times;</button>
        </div>
        <div style="padding:0 1.15rem .55rem;font-size:.72rem;color:#8a8f9c;line-height:1.5;">
          Lock a month after its GSTR-1 is filed. Locked months refuse bill
          edits — corrections go through credit notes.
        </div>
        <div id="bl-gstlock-body" style="overflow:auto;padding:.1rem .55rem 1rem;">
          <div style="padding:1.2rem;text-align:center;color:#b6bac4;font-size:.78rem;">Loading…</div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });
    overlay.querySelector("#bl-gstlock-close")
      .addEventListener("click", () => overlay.remove());
    refreshGstLockRows(overlay);
  }

  async function refreshGstLockRows(overlay) {
    const body = overlay.querySelector("#bl-gstlock-body");
    if (!body) return;
    try {
      const res = await apiFetch("/gst_locks");
      const data = await res.json();
      if (!data.success) throw new Error(data.message || "load failed");

      // Group by financial year, newest month first.
      const groups = new Map();
      (data.locks || []).forEach((l) => {
        const fy = _glockFy(l.period);
        if (!groups.has(fy)) groups.set(fy, []);
        groups.get(fy).push(l);
      });

      const pill = (locked) => locked
        ? "background:#6f42c1;border:1px solid #6f42c1;color:#fff;"
        : "background:none;border:1px solid #dcdfe6;color:#5b6170;";

      let html = "";
      for (const [fy, rows] of groups) {
        html += `<div style="font-size:.64rem;font-weight:700;letter-spacing:.09em;
                     color:#b3b7c2;text-transform:uppercase;
                     padding:.8rem .55rem .3rem;">${fy}</div>`;
        for (const l of rows) {
          const name = `${_GLOCK_MONTHS[parseInt(l.period.slice(5, 7), 10) - 1]} ${l.period.slice(0, 4)}`;
          const meta = l.locked
            ? `<div style="font-size:.66rem;color:#a9aebb;margin-top:2px;">
                 ${_glockEsc(l.locked_by)} · ${_glockEsc((l.locked_at || "").slice(0, 10))}` +
              (l.note ? ` · ${_glockEsc(l.note)}` : "") + `</div>`
            : "";
          let action;
          if (l.is_current) {
            action = `<span style="font-size:.67rem;color:#c3c7d1;">current</span>`;
          } else {
            action = `<button data-glock-period="${l.period}"
                        data-glock-locked="${l.locked ? 0 : 1}"
                        style="${pill(l.locked)}border-radius:999px;cursor:pointer;
                               padding:.28rem .85rem;font-size:.69rem;font-weight:600;
                               display:inline-flex;align-items:center;gap:.35rem;">` +
              (l.locked
                ? `<i class="fas fa-lock" style="font-size:.6rem;"></i>Locked`
                : `Lock`) +
              `</button>`;
          }
          const atts = l.attachments || [];
          const attList = atts.map((a) => `
                <div style="display:flex;align-items:center;gap:.4rem;font-size:.67rem;
                     color:#5b6170;padding:1px 0;">
                  <i class="fas fa-paperclip" style="font-size:.58rem;color:#9aa0ad;"></i>
                  <a href="${a.url}" target="_blank" rel="noopener"
                     style="color:#3b5bdb;text-decoration:none;">${_glockEsc(a.filename)}</a>
                  <button data-glock-att-del="${a.id}" data-glock-att-period="${l.period}"
                     title="Remove" style="border:none;background:none;color:#c0392b;
                     cursor:pointer;font-size:.78rem;line-height:1;">&times;</button>
                </div>`).join("");
          const attBlock = `
              <div class="bl-glock-atts" style="margin-top:.35rem;padding-left:.1rem;">
                ${attList}
                <label style="display:inline-flex;align-items:center;gap:.3rem;
                       font-size:.66rem;color:#3b5bdb;cursor:pointer;margin-top:2px;">
                  <i class="fas fa-plus" style="font-size:.58rem;"></i>Attach filing report
                  <input type="file" data-glock-att-upload="${l.period}"
                     accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/*"
                     style="display:none;">
                </label>
              </div>`;
          html += `<div class="bl-glock-row" style="display:flex;flex-direction:column;
                       align-items:stretch;padding:.5rem .55rem;border-radius:9px;">
              <div style="display:flex;align-items:center;justify-content:space-between;">
                <div>
                  <div style="font-size:.8rem;font-weight:600;color:#2a2f3a;">${name}</div>${meta}
                </div>
                ${action}
              </div>
              ${attBlock}
            </div>`;
        }
      }
      body.innerHTML = html ||
        `<div style="padding:1rem;color:#b6bac4;font-size:.78rem;">No months found</div>`;

      body.querySelectorAll(".bl-glock-row").forEach((r) => {
        r.addEventListener("mouseenter", () => { r.style.background = "#f6f7fa"; });
        r.addEventListener("mouseleave", () => { r.style.background = ""; });
      });

      body.querySelectorAll("[data-glock-period]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const period = btn.getAttribute("data-glock-period");
          const locking = btn.getAttribute("data-glock-locked") === "1";
          let note = "";
          if (locking) {
            note = prompt(
              `Lock ${period}?\nRecord the GSTR-1 filing reference ` +
              `(ARN / filing date) — stored in the audit trail:`, "");
            if (note === null) return;
          } else {
            const sure = confirm(
              `Unlock ${period}? The filed GSTR-1 will no longer be ` +
              `protected against edits. Only do this to apply a correction ` +
              `you will re-declare to your CA.`);
            if (!sure) return;
            note = prompt("Reason for unlocking (stored in audit trail):", "");
            if (note === null) return;
          }
          btn.disabled = true;
          btn.style.opacity = ".5";
          try {
            const r = await apiFetch("/gst_locks/set", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ period, locked: locking, note }),
            });
            const out = await r.json();
            if (!out.success) alert(out.message || "Failed");
          } catch (err) {
            alert("Network error: " + err);
          }
          refreshGstLockRows(overlay);
        });
      });

      body.querySelectorAll("[data-glock-att-upload]").forEach((inp) => {
        inp.addEventListener("change", async () => {
          const period = inp.getAttribute("data-glock-att-upload");
          const file = inp.files && inp.files[0];
          if (!file) return;
          const fd = new FormData();
          fd.append("period", period);
          fd.append("file", file);
          inp.disabled = true;
          try {
            const r = await apiFetch("/gst_locks/attachments/upload",
                                     { method: "POST", body: fd });
            const out = await r.json().catch(() => ({}));
            if (!out.success) alert(out.message || "Upload failed");
          } catch (err) {
            alert("Network error: " + err);
          }
          refreshGstLockRows(overlay);
        });
      });

      body.querySelectorAll("[data-glock-att-del]").forEach((delBtn) => {
        delBtn.addEventListener("click", async () => {
          const id = delBtn.getAttribute("data-glock-att-del");
          const period = delBtn.getAttribute("data-glock-att-period");
          if (!confirm("Remove this filing report?")) return;
          try {
            const r = await apiFetch("/gst_locks/attachments/delete", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ period, attachment_id: id }),
            });
            const out = await r.json().catch(() => ({}));
            if (!out.success) alert(out.message || "Delete failed");
          } catch (err) {
            alert("Network error: " + err);
          }
          refreshGstLockRows(overlay);
        });
      });
    } catch (err) {
      body.innerHTML =
        `<div style="padding:1rem;color:#dc3545;font-size:.76rem;">Could not load locks: ${_glockEsc(err)}</div>`;
    }
  }

  // ── Build tab HTML ────────────────────────────────────────────────────────────
  function buildHTML() {
    const tab = dom("bills-tab");
    if (!tab) return;
    tab.innerHTML = `
<div class="bills-container">
  <div class="bills-header">
    <div class="bl-seg" role="tablist" aria-label="Bills views">
      <button class="bl-seg-btn active" id="bl-subtab-bills" role="tab" aria-selected="true">
        <i class="fas fa-file-invoice-dollar"></i>
        <span>Bills</span>
        <span class="bl-seg-count" id="bl-subtab-count-bills">0</span>
      </button>
      <button class="bl-seg-btn" id="bl-subtab-cn" role="tab" aria-selected="false">
        <i class="fas fa-undo"></i>
        <span>Credit Notes</span>
        <span class="bl-seg-count" id="bl-subtab-count-cn">0</span>
      </button>
    </div>
    <div class="bills-toolbar">
      <button class="bl-icon-btn refresh" id="bl-refresh-btn" title="Refresh">
        <i class="fas fa-sync-alt"></i>
      </button>
      <button class="bl-icon-btn export" id="bl-export-btn" data-perm="data.export" title="Export CA Report (Excel)">
        <i class="fas fa-file-excel"></i>
      </button>
      <button class="bl-icon-btn" id="bl-gst-lock-btn" data-perm="gst.lock.manage"
              title="GST month lock (freeze filed months)"
              style="background:#6f42c1;color:#fff;">
        <i class="fas fa-lock"></i>
      </button>
    </div>
  </div>

  <!-- Tally — computed from invoiced entries in selected date range -->
  <div class="bills-tally" id="bl-tally">
    <div class="bl-card bl-cash">
      <div class="bl-label">Cash (Period)</div>
      <div class="bl-value" id="bl-tc-cash">₹0</div>
      <div style="font-size:.66rem;color:#aaa;margin-top:2px;" title="Includes advance payments received before checkout date">
        incl. advances *
      </div>
    </div>
    <div class="bl-card bl-upi">
      <div class="bl-label">UPI (Period)</div>
      <div class="bl-value" id="bl-tc-upi">₹0</div>
      <div style="font-size:.66rem;color:#aaa;margin-top:2px;" title="Includes advance payments received before checkout date">
        incl. advances *
      </div>
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
    <div class="bl-card" style="border-left:3px solid #6f42c1;">
      <div class="bl-label">GST Collected</div>
      <div class="bl-value" id="bl-tc-gst" style="color:#6f42c1;">₹0</div>
      <div style="font-size:.68rem;color:#888;margin-top:2px;">
        <span id="bl-tc-gst-accom">Accom: ₹0</span> &nbsp;|&nbsp;
        <span id="bl-tc-gst-water">Water: ₹0</span>
      </div>
    </div>
  </div>

  <!-- Filter bar -->
  <div class="bl-filter-bar">
    <!-- Custom date-range picker is admin-only. Manager / housekeeping rely
         on the quick-range buttons (Today / Last 3 Days). The default for
         everyone is "Last 3 Days". -->
    <div class="bl-date-range-wrap" data-roles="admin">
      <i class="fas fa-calendar-alt"></i>
      <input type="text" id="bl-date-range" class="bl-date-range-input" placeholder="Select date range" readonly />
    </div>
    <button class="bl-quick-btn" data-bq="today" data-roles="admin">Today</button>
    <button class="bl-quick-btn bq-active" data-bq="last3" data-roles="admin">Last 3 Days</button>
    <button class="bl-quick-btn" data-bq="month" data-roles="admin">Month</button>
    <!-- Manager / housekeeping: only Today + Last 3 Days -->
    <button class="bl-quick-btn" data-bq="today" data-roles="manager,housekeeping">Today</button>
    <button class="bl-quick-btn bq-active" data-bq="last3" data-roles="manager,housekeeping">Last 3 Days</button>
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
    <select id="bl-type-filter" title="Filter by bill type / status">
      <option value="all">All Bills</option>
      <option value="b2b">B2B (GSTIN)</option>
      <option value="b2c">B2C</option>
      <option value="cancelled">Cancelled</option>
      <option value="settle_later">Settle-later</option>
      <option value="cancel_charge">Cancellation charge</option>
      <option value="reverted">Reverted</option>
    </select>
    <input type="text" class="bl-search-input" id="bl-search"
           placeholder="Name / Room / Invoice No…" />
  </div>

  <!-- View toggle -->
  <div class="bl-view-toggle">
    <span style="font-size:.72rem;color:#888;margin-right:.35rem;font-weight:600;">View:</span>
    <!-- Default active view is Bill No (desc) so the latest invoice sits at
         the top. The "Date" group header reflects checkout date because the
         tab cohorts by checkout (GST-month semantics). -->
    <button id="bl-view-date" class="bl-view-btn">&#128197; Checkout Date</button>
    <button id="bl-view-billno" class="bl-view-btn bl-view-active">&#8645; Bill No &#9660;</button>
  </div>

  <!-- Credit Notes pane (Section 34) — stat strip + filters + table -->
  <div id="bl-cn-pane" style="display:none;">
    <div class="bl-cn-stats" id="bl-cn-stats">
      <div class="bl-cn-stat">
        <div class="bl-cn-stat-label">Total Credit Notes</div>
        <div class="bl-cn-stat-value" id="bl-cn-stat-total">—</div>
      </div>
      <div class="bl-cn-stat value">
        <div class="bl-cn-stat-label">Total Credited</div>
        <div class="bl-cn-stat-value" id="bl-cn-stat-amt">—</div>
      </div>
      <div class="bl-cn-stat b2b">
        <div class="bl-cn-stat-label">B2B (CDNR)</div>
        <div class="bl-cn-stat-value" id="bl-cn-stat-b2b">—</div>
      </div>
      <div class="bl-cn-stat b2c">
        <div class="bl-cn-stat-label">B2C</div>
        <div class="bl-cn-stat-value" id="bl-cn-stat-b2c">—</div>
      </div>
    </div>

    <div class="bl-cn-filters">
      <button class="bl-cn-filter active" data-cnf="all">All</button>
      <button class="bl-cn-filter" data-cnf="b2b">B2B (CDNR)</button>
      <button class="bl-cn-filter" data-cnf="b2c">B2C</button>
      <button class="bl-cn-filter" data-cnf="checkout_mistake">Checkout reverted</button>
      <button class="bl-cn-filter" data-cnf="post_supply_discount">Post-supply discount</button>
      <button class="bl-cn-filter" data-cnf="cancellation">Cancellation</button>
    </div>

    <div class="bl-cn-container">
      <table class="bl-cn-table">
        <thead><tr>
          <th>CN Number</th>
          <th>Date</th>
          <th>Against Invoice</th>
          <th>Recipient</th>
          <th>Reason · Section 34</th>
          <th style="text-align:right;">Amount</th>
          <th>PDF</th>
        </tr></thead>
        <tbody id="bl-cn-tbody"><tr><td colspan="7" class="bl-cn-empty"><span class="bl-cn-empty-icon"><i class="far fa-file-alt"></i></span><div class="bl-cn-empty-text">Loading…</div></td></tr></tbody>
      </table>
      <div class="bl-cn-foot-note">
        <strong>Section 34 of the CGST Act:</strong> a credit note reverses the GST
        already charged on the original tax invoice. B2B credit notes flow into
        GSTR-1 Table 9B (CDNR); B2C credit notes net out the B2C summary.
      </div>
    </div>
  </div>

  <!-- Table -->
  <div id="bl-bills-pane">
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

    <div id="bl-pm-disc-type-row" style="display:none; margin:.4rem 0; font-size:.78rem;">
      <label style="display:flex; align-items:center; gap:.4rem; margin-bottom:.2rem; cursor:pointer;">
        <input type="radio" name="bl-pm-disc-type" value="financial" checked />
        Financial discount (no GST credit) — default
      </label>
      <label style="display:flex; align-items:center; gap:.4rem; cursor:pointer;">
        <input type="radio" name="bl-pm-disc-type" value="credit_note" />
        GST credit note (reduces output tax)
      </label>
      <!-- Bad-debt sub-checkbox — only meaningful on the financial path -->
      <label id="bl-pm-baddebt-wrap" style="display:flex; align-items:center; gap:.4rem; margin:.2rem 0 .15rem 1.4rem; cursor:pointer; font-size:.74rem; color:#475569;">
        <input type="checkbox" id="bl-pm-baddebt" />
        Mark as bad-debt write-off
        <span style="font-size:.66rem; color:#94a3b8;">(can&rsquo;t collect — book as loss)</span>
      </label>
      <input type="text" id="bl-pm-disc-reason" placeholder="Reason (mandatory for non-B2B credit note)" style="width:100%; margin-top:.3rem; padding:.25rem .4rem; border:1px solid #d0d0d0; border-radius:6px; font-size:.78rem;" />
      <div style="font-size:.7rem; color:#666; margin-top:.15rem;">CN-discount allowed only for B2B bills or where the discount was agreed at/before time of supply (Section 15(3)(b)).</div>
    </div>

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

    <label for="bl-pm-date">Receipt Date</label>
    <input type="date" id="bl-pm-date" />

    <div class="bl-pay-error" id="bl-pm-error"></div>

    <div class="bl-pay-modal-actions">
      <button class="bl-pay-cancel-btn" id="bl-pm-cancel">Cancel</button>
      <button class="bl-pay-confirm-btn" id="bl-pm-confirm">
        <i class="fas fa-check"></i> Confirm Payment
      </button>
    </div>
  </div>
</div>

<!-- GST Recipient Edit Modal (Goal 1) -->
<div class="bl-gst-backdrop" id="bl-gst-backdrop">
  <div class="bl-gst-modal">
    <div class="bl-gst-head">
      <div class="bl-gst-head-icon"><i class="fas fa-id-card-alt"></i></div>
      <div class="bl-gst-head-text">
        <h2>GST Recipient Details</h2>
        <div class="bl-gst-sub">
          <span class="bl-gst-billno" id="bl-gst-billno">—</span>
          <span class="bl-gst-state-chip bl-gst-state-b2c" id="bl-gst-state-chip">B2C</span>
        </div>
      </div>
    </div>

    <div class="bl-gst-body">
      <div class="bl-gst-row">
        <label for="bl-gst-gstin">GSTIN<span class="bl-req">*</span></label>
        <input id="bl-gst-gstin" maxlength="15" placeholder="e.g. 29AAACB1234F1Z5" autocomplete="off" />
        <div class="bl-gst-derived" id="bl-gst-state-hint">15 characters · 2-digit state code · 10-char PAN · entity number · checksum</div>
      </div>

      <div class="bl-gst-row">
        <label for="bl-gst-legal">Legal Name<span class="bl-req">*</span></label>
        <input id="bl-gst-legal" placeholder="As registered on GST portal" autocomplete="off" />
      </div>

      <div class="bl-gst-row">
        <label for="bl-gst-trade">Trade Name <span class="bl-hint-text">optional</span></label>
        <input id="bl-gst-trade" placeholder="Brand / DBA name" autocomplete="off" />
      </div>

      <div class="bl-gst-row">
        <label for="bl-gst-addr">Address <span class="bl-hint-text">optional · Rule 46 recommends</span></label>
        <input id="bl-gst-addr" placeholder="Street, City, State - PIN" autocomplete="off" />
      </div>

      <div class="bl-gst-warn" id="bl-gst-rule46" style="display:none;">
        Rule 46(e) of the CGST Rules requires the recipient&rsquo;s full address on a B2B tax invoice. You can save without it, but a strict auditor may ask the recipient to request a re-issue.
      </div>

      <div class="bl-gst-error" id="bl-gst-error"></div>

      <div class="bl-gst-foot-note">
        <strong>Note:</strong> Place of supply for accommodation (SAC 9963) is always Karnataka (KA-29) regardless of the recipient&rsquo;s state. Tax breakup is therefore CGST + SGST. Saving here re-generates the bill PDF with the recipient block.
      </div>
    </div>

    <div class="bl-gst-actions">
      <button class="bl-gst-cancel" id="bl-gst-cancel">Cancel</button>
      <button class="bl-gst-clear" id="bl-gst-clear">Clear &amp; revert to B2C</button>
      <button class="bl-gst-save" id="bl-gst-save">Save as B2B</button>
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
    <!-- View toggle — a control only. It lives OUTSIDE bl-bill-print-area so
         it never appears in the printed bill or the PDF (Print clones only
         the print area). Hidden until openBill finds a consolidatable folio. -->
    <div class="bl-view-toggle" id="bl-view-toggle" style="display:none;">
      <span class="bl-view-toggle-label">View</span>
      <button type="button" class="bl-vt-btn" id="bl-vt-detailed" data-view="detailed">Detailed</button>
      <button type="button" class="bl-vt-btn" id="bl-vt-consolidated" data-view="consolidated">Consolidated</button>
      <span class="bl-vt-hint" id="bl-vt-hint"></span>
    </div>
    <div id="bl-bill-print-area"></div>
    <div class="bill-actions">
      <button class="action-btn btn-secondary" id="bl-bill-close2">Close</button>
      <!--
        Edit Price — admin-only.
        Corrects the per-night room tariff on a finalized bill and recomputes
        room charges, GST (per-night) and the DERIVED balance via
        /edit_bill_room_price. Payment split is NOT edited here — that lives in
        the Register Payment Records modal (single source of truth), reached by
        clicking the Payment cell in the Bills table. Hidden for non-admins by
        the data-roles handler in auth.js; the backend also enforces
        @requires_permission("payment.edit").
      -->
      <button class="action-btn btn-secondary" id="bl-bill-editprice"
              data-roles="admin"
              title="Correct the room tariff and recompute charges, GST and balance">
        <i class="fas fa-pen"></i> Edit Price
      </button>
      <button class="bl-bill-save-btn" id="bl-bill-save-pdf" title="Save PDF to cloud &amp; share on WhatsApp">
        <i class="fab fa-whatsapp"></i> Save &amp; Share
      </button>
      <button class="action-btn btn-primary" id="bl-bill-print">
        <i class="fas fa-print"></i> Print
      </button>
    </div>
  </div>
</div>

<!-- Edit Room Price modal (admin-only). Corrects the per-night tariff and
     recomputes charges/GST/balance server-side. Inline styles keep it
     self-contained (no dependency on app-wide modal CSS). -->
<div id="bl-rprice-backdrop"
     style="display:none; position:fixed; inset:0; background:rgba(0,0,0,.45);
            z-index:10000; align-items:center; justify-content:center;">
  <div style="background:#fff; width:min(440px,92vw); border-radius:12px;
              padding:20px 22px; box-shadow:0 10px 40px rgba(0,0,0,.25);">
    <h3 style="margin:0 0 4px; font-size:18px;">Edit room price</h3>
    <p style="margin:0 0 14px; font-size:13px; color:#555; line-height:1.45;">
      Sets the actual per-night tariff for this stay. Room charges, GST and the
      balance are recomputed from it. To change how much was paid in cash vs
      online, use the Payment cell in the Bills table instead.
    </p>
    <div id="bl-rprice-context"
         style="font-size:13px; color:#374151; background:#f3f4f6;
                border-radius:8px; padding:8px 10px; margin-bottom:12px;"></div>
    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">
      New price per night (₹)
    </label>
    <input id="bl-rprice-input" type="number" min="0" step="1" inputmode="numeric"
           style="width:100%; box-sizing:border-box; padding:9px 10px; font-size:15px;
                  border:1px solid #cbd5e1; border-radius:8px; margin-bottom:12px;" />
    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">
      Reason (recorded in the audit log)
    </label>
    <input id="bl-rprice-reason" type="text" maxlength="500"
           placeholder="e.g. wrong tariff entered at checkout"
           style="width:100%; box-sizing:border-box; padding:9px 10px; font-size:14px;
                  border:1px solid #cbd5e1; border-radius:8px; margin-bottom:8px;" />
    <div id="bl-rprice-msg" style="font-size:13px; min-height:18px; margin-bottom:8px;"></div>
    <div style="display:flex; gap:10px; justify-content:flex-end;">
      <button id="bl-rprice-cancel" class="action-btn btn-secondary" type="button">Cancel</button>
      <button id="bl-rprice-save" class="action-btn btn-primary" type="button">
        Recompute &amp; Save
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

    <div class="bl-view-toggle" id="bl-wa-view-toggle" style="margin-bottom:.9rem;">
      <span class="bl-view-toggle-label">View</span>
      <button type="button" class="bl-vt-btn" id="bl-wa-vt-consolidated" data-view="consolidated">Consolidated</button>
      <button type="button" class="bl-vt-btn" id="bl-wa-vt-detailed" data-view="detailed">Detailed</button>
      <span class="bl-vt-hint" id="bl-wa-vt-hint"></span>
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
  // Default range for everyone is "Last 3 Days" (today + 2 prior).
  // Admin still has the custom date-range picker for deeper history.
  // Manager / housekeeping use only the quick buttons (the picker container
  // is hidden via data-roles="admin").
  function setDefaults() {
    const today = todayStr();
    const last3Start = nDaysAgoStr(2);
    state.dateRange.start = last3Start;
    state.dateRange.end   = today;

    const _auth = window.CibaraAuth;
    const _isAdmin = _auth && _auth.isAdmin && _auth.isAdmin();

    // Skip flatpickr init for non-admin: the input element is hidden via
    // data-roles, but it's still in the DOM. Initialising it would attach
    // listeners that aren't reachable from the UI — wasted work.
    if (!_isAdmin) return;

    const el = dom("bl-date-range");
    if (!el || !window.flatpickr) return;

    state._datePicker = flatpickr(el, {
      mode: "range",
      dateFormat: "Y-m-d", // internal ISO format — avoids maxDate mis-parsing
      altInput: true, // show human-friendly text to user
      altFormat: "d M Y", // display: "17 Mar 2026"
      defaultDate: [last3Start, today],
      maxDate: today,
      disableMobile: true,
      onChange: function (selectedDates) {
        if (selectedDates.length === 2) {
          state.dateRange.start = dateToYMD(selectedDates[0]);
          state.dateRange.end = dateToYMD(selectedDates[1]);
          // clear quick-btn active (manual calendar pick)
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
        else if (range === "last3") start = nDaysAgoStr(2);   // today + 2 prior = 3 days
        else if (range === "month") start = nDaysAgoStr(29);
        // (week intentionally removed — not in the chip set anymore)
        else start = today;
        state.dateRange.start = start;
        state.dateRange.end = today;
        // Pass false so setDate does NOT fire onChange → avoids a duplicate
        // loadData call that would be blocked when a prior load is in flight
        if (state._datePicker) state._datePicker.setDate([start, today], false);
        document
          .querySelectorAll(".bl-quick-btn")
          .forEach((b) => b.classList.remove("bq-active"));
        btn.classList.add("bq-active");
        // Always force-reload, even if a previous load is still running
        state.loading = false;
        loadData(true);
      });
    });

    const srcf = dom("bl-source-filter");
    const payf = dom("bl-payment-filter");
    const typf = dom("bl-type-filter");
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
    if (typf)
      typf.addEventListener("change", () => {
        state.filters.type = typf.value;
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
    const lk = dom("bl-gst-lock-btn");
    if (lk) lk.addEventListener("click", openGstLockModal);

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

    // ── View toggle (Detailed / Consolidated) ─────────────────────────────────
    // Event-delegated. Records the operator's preference (persisted), then
    // re-renders the open bill in the chosen view. The Print button needs no
    // change — it clones the print area as-is, so it always prints whichever
    // view is currently on screen.
    const vtBar = dom("bl-view-toggle");
    if (vtBar)
      vtBar.addEventListener("click", (e) => {
        const btn = e.target.closest(".bl-vt-btn");
        if (!btn || !_openBillData) return;
        const mode = btn.dataset.view;
        if (mode !== "detailed" && mode !== "consolidated") return;
        const prevMode = resolveViewMode(_openBillData);
        _billViewMode = mode;
        try { localStorage.setItem("cibara_bill_view", mode); } catch (_e) {}
        if (mode !== prevMode) _renderOpenBill();
        _syncViewToggle();
      });

    // ── "Save & Share" button in bill modal ───────────────────────────────────
    // Opens the WhatsApp send modal, which (re)generates a fresh Consolidated
    // PDF by default (Detailed available there as a toggle) — passing along
    // the bill data we already have avoids a redundant /generate_bill fetch.
    const bSave = dom("bl-bill-save-pdf");
    if (bSave) {
      bSave.addEventListener("click", async function () {
        if (!_openBillId || !_openBillData) return;
        const entry = {
          id: _openBillId,
          guest_name: _openBillData.guest_name,
          guest_mobile: _openBillData.guest_mobile,
          bill_number: _openBillData.bill_number,
          total_amount: _openBillData.total_amount,
        };
        closeBill();
        await openWhatsAppModal(entry, _openBillData);
      });
    }

    // ── "Recalculate" button in bill modal (admin-only) ──────────────────
    //
    // Triggers /recalculate_bill on the backend, which re-reads every
    // payment doc tagged with this bill's stay_id and rewrites
    // payment_cash / payment_online / balance onto the bill document.
    // Use this whenever a bill displays stale totals — for example after
    // a duplicate-payment fix, a payment edit that didn't auto-recalc,
    // or a manual Firestore correction.
    //
    // Visibility is gated client-side by data-roles="admin" on the button
    // markup (auth.js hides it for non-admin). The backend endpoint is
    // additionally gated by @requires_permission("payment.edit"), which
    // is effectively admin-only because no other role grants payment.edit
    // (see services/permissions.py).
    const bRecalc = dom("bl-bill-recalc");
    if (bRecalc) {
      bRecalc.addEventListener("click", async function () {
        if (!_openBillId) return;
        // Belt-and-braces: even if the button somehow becomes visible
        // outside admin (CSS bug, debug tools, etc.), refuse to fire.
        const _auth = window.CibaraAuth;
        if (!(_auth && _auth.isAdmin && _auth.isAdmin())) {
          alert("Only admin users can recalculate bills.");
          return;
        }
        const _origHtml = bRecalc.innerHTML;
        bRecalc.disabled = true;
        bRecalc.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Recalculating…';
        try {
          const res = await apiFetch("/recalculate_bill", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ bill_id: _openBillId }),
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data && data.success) {
            alert(
              `Bill recalculated.\n` +
              `Cash: ₹${data.payment_cash ?? 0}\n` +
              `Online: ₹${data.payment_online ?? 0}\n` +
              `Balance: ₹${data.balance ?? 0}`
            );
            // Bust any cached entry for this bill so the list view also
            // reflects the new totals on next load, then re-open the
            // modal so the printed total updates immediately.
            try {
              if (Array.isArray(state.allEntries)) {
                const ix = state.allEntries.findIndex((x) => x.id === _openBillId);
                if (ix !== -1) {
                  state.allEntries[ix] = {
                    ...state.allEntries[ix],
                    payment_cash:   data.payment_cash,
                    payment_online: data.payment_online,
                    balance:        data.balance,
                  };
                }
              }
            } catch (_) { /* non-fatal cache update */ }
            await openBill(_openBillId);
          } else {
            const _msg = (data && data.message) || `Recalculate failed (HTTP ${res.status}).`;
            alert("Error: " + _msg);
          }
        } catch (err) {
          console.error("[Bills] recalculate failed:", err);
          alert("Network error during recalculate.");
        } finally {
          bRecalc.disabled = false;
          bRecalc.innerHTML = _origHtml;
        }
      });
    }

    // ── "Edit Price" button in bill modal (admin-only) ───────────────────
    //
    // Opens a small modal to correct the per-night room tariff. Posts to
    // /edit_bill_room_price, which recomputes room charges, per-night GST and
    // the DERIVED balance server-side. The payment split is intentionally NOT
    // editable here — cash vs online is owned by the payments ledger (click
    // the Payment cell to open the Register Payment Records modal). Visibility
    // is gated client-side by data-roles="admin"; the click handler re-checks
    // isAdmin() defensively and the backend enforces payment.edit.
    const bEditPrice = dom("bl-bill-editprice");
    const rpBackdrop = dom("bl-rprice-backdrop");
    const rpInput    = dom("bl-rprice-input");
    const rpReason   = dom("bl-rprice-reason");
    const rpMsg      = dom("bl-rprice-msg");
    const rpSave     = dom("bl-rprice-save");
    const rpCancel   = dom("bl-rprice-cancel");
    const rpContext  = dom("bl-rprice-context");

    function _closeRprice() {
      if (rpBackdrop) rpBackdrop.style.display = "none";
    }
    function _isAdminNow() {
      const a = window.CibaraAuth;
      return !!(a && a.isAdmin && a.isAdmin());
    }

    if (bEditPrice && rpBackdrop) {
      bEditPrice.addEventListener("click", function () {
        if (!_openBillId) return;
        if (!_isAdminNow()) { alert("Only admin users can edit the room price."); return; }
        const entry = (state.allEntries || []).find((x) => x.id === _openBillId) || {};
        // Best-effort prefill. room_charges_total is in the list payload;
        // days_stayed / per-night may not be, so derive what we can and fall
        // back to a blank input the admin fills in.
        const rct  = Number(entry.room_charges_total || 0);
        const days = Number(entry.days_stayed || 0);
        const perNight = (days > 0 && rct > 0)
          ? Math.round(rct / days)
          : (entry.room_price_per_night || "");
        if (rpContext) {
          rpContext.innerHTML =
            "Current room charges: <b>₹" + (rct || 0) + "</b>" +
            (days > 0 ? " (" + days + " night" + (days === 1 ? "" : "s") + ")" : "") +
            ". Changing the nightly rate re-derives GST and the balance.";
        }
        if (rpInput)  rpInput.value = perNight === "" ? "" : String(perNight);
        if (rpReason) rpReason.value = "";
        if (rpMsg)    { rpMsg.style.color = "#b91c1c"; rpMsg.textContent = ""; }
        rpBackdrop.style.display = "flex";
        if (rpInput) { rpInput.focus(); rpInput.select(); }
      });

      if (rpCancel) rpCancel.addEventListener("click", _closeRprice);
      rpBackdrop.addEventListener("click", (e) => {
        if (e.target === rpBackdrop) _closeRprice();
      });

      if (rpSave) rpSave.addEventListener("click", async function () {
        if (!_openBillId) return;
        if (!_isAdminNow()) { alert("Only admin users can edit the room price."); return; }
        const raw = ((rpInput && rpInput.value) || "").trim();
        const n = Number(raw);
        if (raw === "" || isNaN(n) || n < 0 || !Number.isInteger(n)) {
          if (rpMsg) { rpMsg.style.color = "#b91c1c"; rpMsg.textContent = "Enter a whole, non-negative rupee amount."; }
          return;
        }
        const newPrice = parseInt(raw, 10);
        const _orig = rpSave.innerHTML;
        rpSave.disabled = true; rpSave.innerHTML = "Saving…";
        if (rpMsg) { rpMsg.style.color = "#374151"; rpMsg.textContent = "Recomputing…"; }
        try {
          const res = await apiFetch("/edit_bill_room_price", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({
              bill_id:              _openBillId,
              room_price_per_night: newPrice,
              reason:               ((rpReason && rpReason.value) || "").trim(),
            }),
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data && data.success) {
            _closeRprice();
            alert(
              "Room price updated.\n" +
              "Price/night: ₹" + (data.room_price_per_night ?? newPrice) + "\n" +
              "Room charges: ₹" + (data.room_charges_total ?? 0) + "\n" +
              "GST: ₹" + (data.gst_amount ?? 0) + " (" + (data.gst_rate ?? 0) + "%)\n" +
              "Total: ₹" + (data.total_amount ?? 0) + "\n" +
              "Balance: ₹" + (data.balance ?? 0) + "  [" + (data.status || "") + "]"
            );
            try {
              if (Array.isArray(state.allEntries)) {
                const ix = state.allEntries.findIndex((x) => x.id === _openBillId);
                if (ix !== -1) {
                  state.allEntries[ix] = {
                    ...state.allEntries[ix],
                    room_charges_total: data.room_charges_total,
                    total_amount:       data.total_amount,
                    gst_amount:         data.gst_amount,
                    balance:            data.balance,
                  };
                }
              }
            } catch (_) { /* non-fatal cache update */ }
            await openBill(_openBillId);
          } else {
            const m = (data && data.message) || ("Edit failed (HTTP " + res.status + ").");
            if (rpMsg) { rpMsg.style.color = "#b91c1c"; rpMsg.textContent = m; }
          }
        } catch (err) {
          console.error("[Bills] edit price failed:", err);
          if (rpMsg) { rpMsg.style.color = "#b91c1c"; rpMsg.textContent = "Network error."; }
        } finally {
          rpSave.disabled = false; rpSave.innerHTML = _orig;
        }
      });
    }

    // ── Sub-tabs: Bills / Credit Notes ────────────────────────────────────
    // _setSubTab swaps the visible pane and fires loadCreditNotes() when
    // switching to CN. Wire both segmented-control buttons to it.
    const subBills = dom("bl-subtab-bills");
    const subCn    = dom("bl-subtab-cn");
    if (subBills) subBills.addEventListener("click", () => _setSubTab("bills"));
    if (subCn)    subCn.addEventListener("click",    () => _setSubTab("cn"));

    // ── GST recipient modal wiring (save / clear / cancel) ────────────────
    // These buttons live inside the static modal HTML. openGstModal only
    // sets the input values; the click handlers need to be bound once.
    const gstSave   = dom("bl-gst-save");
    const gstClear  = dom("bl-gst-clear");
    const gstCancel = dom("bl-gst-cancel");
    const gstBackdrop = dom("bl-gst-backdrop");
    if (gstSave)   gstSave.addEventListener("click", saveBillGst);
    if (gstClear)  gstClear.addEventListener("click", clearBillGst);
    if (gstCancel) gstCancel.addEventListener("click", closeGstModal);
    if (gstBackdrop) gstBackdrop.addEventListener("click", (e) => {
      if (e.target === gstBackdrop) closeGstModal();
    });

    // Delegated clicks: bill view + collect settlement + group toggle + WhatsApp
    const tbody = dom("bl-table-body");
    if (tbody) {
      tbody.addEventListener("click", async (e) => {
        // Paged rendering — "Show more" extends the cap and re-renders
        const lmBtn = e.target.closest(".bl-load-more-btn");
        if (lmBtn) {
          state.visibleCount += PAGE_SIZE;
          renderTable();
          return;
        }

        // Admin-only: clicking the Payment cell opens the Register
        // Payment Records modal for this stay. Reuses the existing
        // modal (window.openRegisterPaymentsModal); no markup duplicated.
        const payCell = e.target.closest(".bl-pay-clickable");
        if (payCell) {
          // Click-time admin gate. Non-admin clicks are a no-op (the cell
          // is wrapped unconditionally but only styled clickable for
          // admin; this is the belt-and-braces enforcement).
          const _auth = window.CibaraAuth;
          if (!(_auth && _auth.isAdmin && _auth.isAdmin())) {
            return;
          }
          e.stopPropagation();
          const billId = payCell.dataset.billId || "";
          if (!billId) return;
          const entry = (state.allEntries || []).find((x) => x.id === billId);
          if (!entry) {
            alert("Could not load this bill's data. Refresh and retry.");
            return;
          }
          if (typeof window.openRegisterPaymentsModal !== "function") {
            alert("Payment Records modal not available — open the Register tab once and try again.");
            return;
          }
          // The register modal expects an entry with these keys; bill
          // docs already carry all of them (id == stay_id by convention).
          window.openRegisterPaymentsModal({
            id:           entry.id,
            stay_id:      entry.stay_id || entry.id,
            room:         entry.room,
            guest_name:   entry.guest_name,
            guest_mobile: entry.guest_mobile,
            checkin_time: entry.checkin_time,
            bill_number:  entry.bill_number,
          });
          return;
        }

        const billBtn = e.target.closest(".bl-bill-btn");
        if (billBtn) {
          e.stopPropagation();
          // Delegate to the Register tab's bill modal so the rendered
          // bill is identical across the app (user requirement: one
          // bill modal everywhere — Register's is the canonical one).
          // Fallback to the local openBill only if window.openRegBill
          // isn't available for some reason (e.g. register.js failed
          // to boot); this preserves at least some functionality.
          const _billId = billBtn.dataset.id;
          if (typeof window.openRegBill === "function") {
            window.openRegBill(_billId);
          } else {
            openBill(_billId);
          }
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

        // GST recipient edit button
        const gstBtn = e.target.closest(".bl-gst-btn");
        if (gstBtn) {
          e.stopPropagation();
          if (gstBtn.disabled) return;
          const billId   = gstBtn.dataset.id;
          const billNo   = gstBtn.dataset.billno || "";
          const locked   = gstBtn.dataset.locked === "1";
          if (typeof openGstModal === "function") {
            openGstModal(billId, billNo, locked);
          }
          return;
        }

        // WhatsApp share button — always opens the send modal, which
        // itself (re)generates a fresh Consolidated PDF (Detailed available
        // as a toggle there) rather than trusting any cached pdf_url, so
        // the view actually sent always matches what's shown/selected.
        const waBtn = e.target.closest(".bl-wa-btn");
        if (waBtn) {
          e.stopPropagation();
          const billId = waBtn.dataset.id;
          const entry = state.allEntries.find((x) => x.id === billId);
          if (!entry) return;
          openWhatsAppModal(entry);
          return;
        }

        // Edit guest name / phone
        // Activity history timeline — the clickable strip under the guest name
        const histStrip = e.target.closest(".bl-act-strip");
        if (histStrip) {
          e.stopPropagation();
          openHistoryModal(histStrip.dataset.id, histStrip.dataset.billno);
          return;
        }

        // Guest name / mobile cell → edit modal (no icon; permission
        // checked at click time so the cell stays inert for other roles).
        const guestCell = e.target.closest(".bl-guest-cell");
        if (guestCell) {
          const can = window.CibaraAuth &&
            typeof window.CibaraAuth.userCan === "function" &&
            window.CibaraAuth.userCan("bill.guest.edit");
          if (!can) return;
          e.stopPropagation();
          const entry = state.allEntries.find((x) => x.id === guestCell.dataset.id);
          if (entry) openEditGuestModal(entry);
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

    // Detailed/Consolidated toggle inside the WhatsApp modal — switching
    // regenerates the PDF for that view before Send is re-enabled.
    const waViewToggle = dom("bl-wa-view-toggle");
    if (waViewToggle)
      waViewToggle.addEventListener("click", (e) => {
        const btn = e.target.closest(".bl-vt-btn");
        if (!btn) return;
        _waSetViewMode(btn.dataset.view);
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

    // "Bill No" → first activation lands on desc (latest first, matches the
    // page default). Subsequent clicks toggle desc ↔ asc.
    btnBillNo.addEventListener("click", () => {
      if (state.sort.key === "bill_no") {
        state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
      } else {
        state.sort.key = "bill_no";
        state.sort.dir = "desc";
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
        // mode:"checkout" — Bills tab cohorts by checkout date (GST-month
        // semantics), not by check-in date. Backend defaults to "checkin"
        // for the Register tab which uses the same endpoint.
        body: JSON.stringify({ start_date: start, end_date: end, mode: "checkout" }),
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
      console.error("[Bills]", err);
      showError("Network error — " + err.message);
    } finally {
      if (myReqId === state._reqId) state.loading = false;
    }
  }

  // ── Silent refresh (no spinner) — used by remote-sync event handlers ─────────
  async function loadDataSilent() {
    const { start, end } = state.dateRange;
    if (!start || !end || state.loading) return;

    try {
      const res = await apiFetch("/get_register_data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Same mode:"checkout" semantics as loadData — see comment there.
        body: JSON.stringify({ start_date: start, end_date: end, mode: "checkout" }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (!data.success) return;

      const newEntries = data.entries || [];
      _diffAndPatch(newEntries);
      state.allEntries = newEntries;
      state.lastLoadedRange = `${start}_${end}`;
    } catch (err) {
      console.warn("[Bills] silent refresh failed:", err.message);
    }
  }

  // Diff new entries against current state; patch only changed rows in-place.
  // Falls back to a quiet applyFilters() if rows are added or removed.
  function _diffAndPatch(newEntries) {
    const tbody = dom("bl-table-body");
    if (!tbody) { state.allEntries = newEntries; applyFilters(); return; }

    const oldIds = new Set(state.allEntries.map(e => e.id).filter(Boolean));
    const newIds = new Set(newEntries.map(e => e.id).filter(Boolean));
    const hasStructural =
      newEntries.some(e => e.id && !oldIds.has(e.id)) ||
      state.allEntries.some(e => e.id && !newIds.has(e.id));

    if (hasStructural) {
      state.allEntries = newEntries;
      applyFilters();
      return;
    }

    const oldById = Object.fromEntries(
      state.allEntries.filter(e => e.id).map(e => [e.id, e])
    );

    // Re-apply the bills filter to the new entries to get visible rows with correct rowIndex
    const visibleNew = newEntries.filter(
      e => (e.status === "completed" || e.status === "pending_settlement" ||
            e.status === "cancelled") &&
           e.bill_number && e.bill_number.trim() !== "" && e.bill_number !== "-"
    );

    visibleNew.forEach((newEntry, i) => {
      if (!newEntry.id) return;
      const old = oldById[newEntry.id];
      if (!old) return;
      if (JSON.stringify(old) === JSON.stringify(newEntry)) return;

      const tr = tbody.querySelector(`tr[data-entry-id="${newEntry.id}"]`);
      if (!tr) return;

      // Bills tab cohorts by checkout date — group key derives from
      // checkout_time, with checkin_time as a safety fallback for legacy
      // rows missing the checkout stamp.
      const _dkSrc = newEntry.checkout_time || newEntry.checkin_time || "";
      const dk = _dkSrc.split(" ")[0] || "unknown";
      const tmp = document.createElement("tbody");
      tmp.innerHTML = rowHTML(newEntry, dk, i + 1);
      const newRow = tmp.querySelector("tr");
      if (!newRow) return;

      tr.replaceWith(newRow);
      newRow.style.transition = "none";
      newRow.style.backgroundColor = "#fffbcc";
      requestAnimationFrame(() => {
        newRow.style.transition = "background-color 0.8s ease";
        newRow.style.backgroundColor = "";
      });
    });
  }

  // ── Filters — completed + pending_settlement entries with a bill_number ──────
  function applyFilters() {
    // Include completed bills AND pending_settlement bills (settle-later checkouts).
    // bill_number presence is the canonical indicator that a bill was generated.
    let f = state.allEntries.filter(
      (e) =>
        (e.status === "completed" || e.status === "pending_settlement" ||
         e.status === "cancelled") &&
        e.bill_number &&
        e.bill_number !== "-" &&
        e.bill_number.trim() !== "",
    );

    const { search, source, payment, type } = state.filters;

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

    // Bill type / status filter — the "Show" dropdown. Each value maps to the
    // same field the row pills use (invoice_type / status / is_cancellation_charge
    // / superseded_by_revert), so the filter and the badges always agree.
    if (type !== "all") {
      f = f.filter((e) => {
        switch (type) {
          case "b2b":           return e.invoice_type === "B2B";
          case "b2c":           return e.invoice_type !== "B2B";
          case "cancelled":     return e.status === "cancelled";
          case "settle_later":  return e.status === "pending_settlement";
          case "cancel_charge": return !!e.is_cancellation_charge;
          case "reverted":      return !!e.superseded_by_revert;
          default:              return true;
        }
      });
    }

    state.filteredEntries = f;
    state.visibleCount = PAGE_SIZE; // new filter/search -> back to first page
    renderTally(f);
    renderTable();
  }

  // ── Tally — computed from completed (paid) entries only ─────────────────────
  function renderTally(entries) {
    let cash = 0,
      upi = 0,
      pending = 0,
      live = 0,
      totalAccomGst = 0,
      totalWaterGst = 0;
    for (const e of entries) {
      // Cancelled (reverted) bills are listed for serial continuity but
      // carry ZERO output tax and no collections — never count them.
      if (e.status === "cancelled") continue;
      live++;
      if ((e.balance || 0) > 0) {
        pending++;
        continue;
      }
      cash += e.payment_cash || 0;
      upi  += e.payment_online || 0;

      // GST tally — only for fully paid entries
      const days = e.days_stayed || calcDays(e.checkin_time, e.checkout_time);
      const ag   = accomTaxFromEntry(e, days);
      totalAccomGst += ag.cgst + ag.sgst;

      const wg  = waterGst(e.services || []);
      totalWaterGst += wg.cgst + wg.sgst;
    }
    const revenue = cash + upi;
    const totalGst = totalAccomGst + totalWaterGst;

    const set = (id, val) => {
      const el = dom(id);
      if (el) el.textContent = "₹" + inr(val || 0);
    };
    set("bl-tc-cash", cash);
    set("bl-tc-upi", upi);
    set("bl-tc-rev", revenue);
    set("bl-tc-gst", totalGst);

    const gstAccomEl = dom("bl-tc-gst-accom");
    const gstWaterEl = dom("bl-tc-gst-water");
    if (gstAccomEl) gstAccomEl.textContent = "Accom: ₹" + inr(Math.round(totalAccomGst));
    if (gstWaterEl) gstWaterEl.textContent  = "Water: ₹" + inr(Math.round(totalWaterGst));

    const countEl   = dom("bl-tc-count");
    const pendingEl = dom("bl-tc-pending");
    if (countEl)   countEl.textContent   = live;
    if (pendingEl) pendingEl.textContent = pending || "0";

    // Sub-tab "Bills" badge mirrors invoice count.
    const subTabBills = dom("bl-subtab-count-bills");
    if (subTabBills) subTabBills.textContent = entries.length;
  }

  // ── Pay Modal ─────────────────────────────────────────────────────────────────
  // Recomputes Net Payable and clamps payment amount whenever discount changes.
  function _updatePayModalNet() {
    const { balance } = state.payModal;
    const discountEl = dom("bl-pm-discount");
    const amtEl = dom("bl-pm-amount");
    const netValEl = dom("bl-pm-net");
    const discTypeRow = dom("bl-pm-disc-type-row");
    const discount = Math.max(0, parseInt(discountEl?.value || "0", 10) || 0);
    const clamped = Math.min(discount, balance); // can't exceed balance
    if (discountEl && clamped !== discount) discountEl.value = clamped;
    const net = balance - clamped;
    if (netValEl) netValEl.textContent = "₹" + inr(net);
    if (amtEl) {
      amtEl.value = net;
      amtEl.max = net;
    }
    if (discTypeRow) discTypeRow.style.display = clamped > 0 ? "" : "none";
    // Bad-debt checkbox is only relevant on the 'financial' path.
    const _typeEl    = document.querySelector('input[name="bl-pm-disc-type"]:checked');
    const _bdWrap    = dom("bl-pm-baddebt-wrap");
    if (_bdWrap) _bdWrap.style.display = (_typeEl && _typeEl.value === "financial") ? "flex" : "none";
  }
  // React to disc-type radio changes so bad-debt visibility tracks live.
  document.addEventListener("change", function(e) {
    if (e.target && e.target.name === "bl-pm-disc-type") {
      try { _updatePayModalNet(); } catch(err) {}
    }
  }, true);

  function openPayModal(billId, billNumber, guestName, balance) {
    state.payModal = { billId, billNumber, guestName, balance, mode: "cash" };

    const set = (id, val) => {
      const el = dom(id);
      if (el) el.textContent = val;
    };
    set("bl-pm-guest", guestName || "—");
    set("bl-pm-billno", billNumber || "—");
    set("bl-pm-due", "₹" + inr(balance));
    const _pmDate = dom("bl-pm-date");
    if (_pmDate) {
      const _t = new Date();
      const _iso = _t.getFullYear() + "-" + String(_t.getMonth() + 1).padStart(2, "0") + "-" + String(_t.getDate()).padStart(2, "0");
      _pmDate.value = _iso; _pmDate.max = _iso;
    }

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
      // Discount classification (Goal 2). Default 'financial' preserves
      // historic behaviour; 'credit_note' issues a Section 34 CN.
      const discTypeEl = document.querySelector('input[name="bl-pm-disc-type"]:checked');
      const discType   = (discTypeEl && discTypeEl.value) || "financial";
      const discReason = (dom("bl-pm-disc-reason")?.value || "").trim();
      const badDebt    = !!(dom("bl-pm-baddebt") && dom("bl-pm-baddebt").checked && discType === "financial");
      // S34 ack starts false; set to true if the user confirms the warning.
      let ackS34Late   = false;
      while (true) {
        const res = await apiFetch("/add_bill_payment", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bill_id: billId,
            payment_mode: mode,
            payment_date: (dom("bl-pm-date") && dom("bl-pm-date").value) || "",
            amount,
            discount,
            discount_type: discType,
            discount_reason: discReason,
            bad_debt: badDebt,
            acknowledge_section34_window: ackS34Late,
          }),
        });
        const data = await res.json();
        // Out-of-window CN — surface a confirm dialog and retry.
        if (data && data.section34_warning && !ackS34Late) {
          const days = data.section34_days_overdue || 0;
          const ok = confirm(
            "WARNING — Section 34(2) cutoff exceeded.\n\n" +
            "This bill is " + days + " day(s) past the deadline (" +
            (data.section34_deadline || "") + ").\n\n" +
            "Issuing a Credit Note here may be disallowed by the GSTN at " +
            "filing time. Most CAs would refuse.\n\n" +
            "Click OK to proceed against your CA's advice, Cancel to stop."
          );
          if (!ok) {
            confirmBtn.disabled = false;
            confirmBtn.innerHTML = '<i class="fas fa-check"></i> Confirm Payment';
            return;
          }
          ackS34Late = true;
          continue;
        }
        // Stash final response for the rest of the handler below.
        window._blAddBillRes = { res, data };
        break;
      }
      const res  = window._blAddBillRes.res;
      const data = window._blAddBillRes.data;
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
  async function generateAndUploadPDF(billId, billData, silent = false, viewMode) {
    const folderNo = billData.bill_number || billId;

    if (!silent) showPdfOverlay("Generating invoice PDF…");

    try {
      if (!silent) updatePdfOverlayText("Converting to PDF…");

      const res = await apiFetch("/render_bill_pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bill_id: billId,
          bill_number: folderNo,
          html_content: buildBillHTML(billData, viewMode),
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

  // Single combined helper for cross-module Save-and-Share flows. Called
  // by register.js's bill modal so the Bills and Register tabs both share
  // the exact same code path: open the WhatsApp send modal, which itself
  // (re)generates a fresh Consolidated PDF by default (Detailed available
  // there as a toggle) rather than trusting any cached pdf_url. Returns
  // true once the modal is open, false only if billId/billData is missing.
  window.cibaraSaveAndShareBill = async function(billId, billData) {
    if (!billId || !billData) return false;
    try {
      const entry = {
        id:           billId,
        guest_name:   billData.guest_name,
        guest_mobile: billData.guest_mobile,
        bill_number:  billData.bill_number,
        total_amount: billData.total_amount,
      };
      await openWhatsAppModal(entry, billData);
      return true;
    } catch (err) {
      console.error("[Bills] cibaraSaveAndShareBill failed:", err);
      return false;
    }
  };

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

  // Detailed/Consolidated toggle inside the WhatsApp send modal. Highlights
  // whichever mode is active and hides for credit-note sends (no view
  // concept there).
  function _syncWaViewToggle() {
    const s = state.waModal;
    const bar = dom("bl-wa-view-toggle");
    if (!bar) return;
    bar.style.display = s._isCN ? "none" : "flex";
    const cBtn = dom("bl-wa-vt-consolidated");
    const dBtn = dom("bl-wa-vt-detailed");
    if (cBtn) cBtn.classList.toggle("bl-vt-active", s.viewMode === "consolidated");
    if (dBtn) dBtn.classList.toggle("bl-vt-active", s.viewMode === "detailed");
    const hint = dom("bl-wa-vt-hint");
    if (hint) {
      hint.textContent = s.viewMode === "consolidated"
        ? "Room nights grouped — days with extras shown separately"
        : "Every night itemised";
    }
  }

  // (Re)generate the PDF for the modal's current viewMode and refresh the
  // message preview. Always regenerates fresh — never trusts a cached
  // pdf_url — so the Detailed/Consolidated toggle is guaranteed to send
  // whatever is actually selected, not a stale PDF from a different view.
  // A request sequence number guards against a rapid double-toggle: if the
  // user flips Detailed→Consolidated before the first request lands, the
  // stale (Detailed) response is discarded instead of overwriting the
  // newer (Consolidated) selection.
  async function _waRegenerate() {
    const s = state.waModal;
    const myReq = (s._waReqSeq = (s._waReqSeq || 0) + 1);
    const sendBtn = dom("bl-wa-send");
    const errEl = dom("bl-wa-error");
    if (errEl) errEl.textContent = "";
    if (sendBtn) {
      sendBtn.disabled = true;
      sendBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Preparing…';
    }
    try {
      if (!s.billData) {
        const res = await apiFetch(`/generate_bill/${s.billId}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.message || "Could not load bill data.");
        if (myReq !== s._waReqSeq) return;   // a newer toggle already fired
        s.billData = data.bill;
      }
      const url = await generateAndUploadPDF(s.billId, s.billData, true, s.viewMode);
      if (myReq !== s._waReqSeq) return;     // a newer toggle already fired
      if (!url) throw new Error("PDF generation failed.");
      s.pdfUrl = url;
      _updateWaPreview();
    } catch (err) {
      if (myReq !== s._waReqSeq) return;     // a newer toggle superseded this failure
      console.error("[Bills] WA PDF prepare failed:", err);
      if (errEl) errEl.textContent = err.message || "Could not prepare the PDF — try again.";
    } finally {
      if (myReq === s._waReqSeq && sendBtn) {
        sendBtn.disabled = false;
        sendBtn.innerHTML = '<i class="fab fa-whatsapp"></i> Send via WhatsApp';
      }
    }
  }

  // Switches the modal's view and regenerates the matching PDF. A no-op if
  // already on that view (avoids a redundant re-render/re-upload).
  async function _waSetViewMode(mode) {
    const s = state.waModal;
    if ((mode !== "detailed" && mode !== "consolidated") || mode === s.viewMode) return;
    s.viewMode = mode;
    _syncWaViewToggle();
    await _waRegenerate();
  }

  // entry: {id, guest_name, guest_mobile, bill_number, total_amount, ...} —
  // billData (optional): the full bill record (with daily_folio) if the
  // caller already has it loaded, so the Consolidated PDF can be prepared
  // without an extra /generate_bill round-trip.
  async function openWhatsAppModal(entry, billData) {
    const s = state.waModal;
    s.billId = entry.id;
    s.guestName = entry.guest_name || "Guest";
    s.guestMobile = entry.guest_mobile || "";
    s.invoiceNo = entry.bill_number || "";
    s.amount = entry.total_amount || 0;
    s.numberMode = "registered";
    s.billData = billData || null;
    s.viewMode = "consolidated";
    s.pdfUrl = null;   // force a fresh regeneration below — never trust a
                        // pdf_url cached from a possibly different view

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

    _syncWaViewToggle();
    _updateWaPreview();

    const backdrop = dom("bl-wa-backdrop");
    if (backdrop) backdrop.classList.add("bl-wa-open");

    await _waRegenerate();
  }

  function closeWhatsAppModal() {
    const backdrop = dom("bl-wa-backdrop");
    if (backdrop) backdrop.classList.remove("bl-wa-open");
    if (state.waModal) state.waModal._isCN = false;
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
          "PDF isn't ready yet — wait a moment and try again, or re-toggle the view above.";
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

    const message = s._isCN
      ? (
          `Hi ${s.guestName || "Guest"}, credit note ${s.invoiceNo || ""} for ` +
          `\u20b9${inr(s.amount)} from Cibara Comforts is ready.\n\n` +
          `View / Download: ${s.pdfUrl}\n\n` +
          `This reverses the GST charged on the original invoice. ` +
          `Keep both documents for your records.`
        )
      : _buildWaMessage(s.guestName, s.invoiceNo, s.amount, s.pdfUrl);
    const encoded = encodeURIComponent(message);
    const waUrl = `https://wa.me/91${targetMobile}?text=${encoded}`;

    window.open(waUrl, "_blank", "noopener,noreferrer");
    // Record the send on the bill's activity trail. Skip credit-note sends —
    // those target a CN document, not the bill row.
    if (!s._isCN) _logBillActivity(s.billId, "whatsapp", targetMobile);
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
      const cap = state.visibleCount || PAGE_SIZE;
      let html = "";
      sorted.slice(0, cap).forEach((e, i) => {
        // Same checkout-first key derivation as the date-grouped view, so
        // group attributes stay consistent across toggles.
        const _dkSrc = e.checkout_time || e.checkin_time || "";
        const dk = _dkSrc.split(" ")[0] || "unknown";
        html += rowHTML(e, dk, i + 1);
      });
      html += loadMoreRowHTML(sorted.length - Math.min(cap, sorted.length));
      tbody.innerHTML = html;
      return;
    }

    // Date-grouped view (dates descending). Bills tab cohorts by checkout
    // date, so group keys are derived from checkout_time. checkin_time is a
    // safety fallback for legacy rows missing checkout_time.
    const byDate = {};
    state.filteredEntries.forEach((e) => {
      const _dkSrc = e.checkout_time || e.checkin_time || "";
      const dk = _dkSrc.split(" ")[0] || "unknown";
      if (!byDate[dk]) byDate[dk] = [];
      byDate[dk].push(e);
    });

    // Paged rendering — at most state.visibleCount data rows per pass.
    const cap = state.visibleCount || PAGE_SIZE;
    let html = "";
    let rowNum = 0; // sequential counter across all date groups
    const dateKeys = Object.keys(byDate).sort((a, b) => b.localeCompare(a));
    for (const dk of dateKeys) {
      if (rowNum >= cap) break;
      const entries = byDate[dk];
      const label = dk !== "unknown" ? fmtDate(dk) : "Unknown Date";
      html += `<tr class="bl-date-header" data-group="${dk}">
        <td colspan="13"><i class="fas fa-chevron-down"></i>${label}&nbsp;<span style="font-weight:400;opacity:.65;">(${entries.length})</span></td>
      </tr>`;
      for (const e of entries) {
        if (rowNum >= cap) break;
        rowNum++;
        html += rowHTML(e, dk, rowNum);
      }
    }
    html += loadMoreRowHTML(state.filteredEntries.length - rowNum);
    tbody.innerHTML = html;
  }

  function loadMoreRowHTML(remaining) {
    if (remaining <= 0) return "";
    return `<tr class="bl-load-more-row"><td colspan="13" style="text-align:center;padding:10px;">
      <button type="button" class="bl-load-more-btn" style="cursor:pointer;padding:6px 18px;">
        Show ${Math.min(PAGE_SIZE, remaining)} more (${remaining} remaining)
      </button></td></tr>`;
  }

  function rowHTML(e, dk, rowIndex) {
    const days = e.days_stayed || calcDays(e.checkin_time, e.checkout_time);
    const isPending = e.status === "pending_settlement";

    const billNo = e.bill_number || "-";

    // GST summary cell — net of on-invoice discount (Section 15(3)(a))
    const { cgst, sgst, cgstRate } = accomTaxFromEntry(e, days);
    const gstTotal = cgst + sgst;
    const gstCell =
      gstTotal > 0
        ? `<span style="font-size:.73rem;">₹${inr(Math.round(gstTotal))}<br><span style="font-size:.65rem;color:#888;">${cgstRate * 2}% GST</span></span>`
        : `<span style="color:#aaa;font-size:.73rem;">Exempt</span>`;

    // Source badge
    const src = e.booking_source || "normal";
    const _srcLabels = { "booking.com": "Booking.com", "mmt": "MMT", "normal": "Normal" };
    const _srcClasses = { "booking.com": "bl-src-bookingcom", "mmt": "bl-src-mmt", "normal": "bl-src-normal" };
    const srcLabel = _srcLabels[src] || (src.charAt(0).toUpperCase() + src.slice(1));
    const srcCls = _srcClasses[src] || "bl-src-normal";
    const srcBadge = `<span class="bl-src-badge ${srcCls}">${srcLabel}</span>`;

    // Any bill with outstanding balance — new (pending_settlement) or old (completed but balance > 0)
    const hasBalance = (e.balance || 0) > 0;
    const rowCls =
      isPending || hasBalance ? "bl-date-row bl-row-pending" : "bl-date-row";
    const pendingBadge =
      isPending || hasBalance
        ? `<span class="bl-pending-badge">Pending</span>`
        : "";
    // Checkout note (typed in the "Settle Later" box at checkout, stored on the
    // settlement doc and surfaced by /get_register_data). Shown under the guest
    // name on pending rows only; escaped since it's free-text operator input.
    const _coNote = (e.settlement_notes || "").trim();
    const guestNoteHTML =
      (isPending || hasBalance) && _coNote
        ? `<div class="bl-guest-note" title="Checkout note"><i class="fas fa-sticky-note"></i>${_glockEsc(_coNote)}</div>`
        : "";
    // Action cell — fixed 4-slot grid so buttons never shift between rows.
    //
    // Each row reserves the same four columns (Collect / View / WhatsApp /
    // GST), each 28x28px. If a particular button is absent for this row
    // we still emit a placeholder div of the same size so subsequent
    // columns don't slide left. Visibility-based hiding (data-roles) on
    // a wrapped button also keeps its slot reserved.
    //
    // Slot 1  Collect:   rendered only for pending / balance > 0 rows.
    // Slot 2  View Bill: always rendered. On pending rows it carries
    //                    data-roles="admin" so non-admins don't see it
    //                    (slot stays — auth.js sets display:none on the
    //                    button, not the wrapper, so the column position
    //                    is preserved).
    // Slots 3-4 are composed below from waBtn + gstBtn.
    const _slot = (content) =>
      `<div style="width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;flex:0 0 28px;">${content || ""}</div>`;

    const _collectBtnHtml = (isPending || hasBalance)
      ? `<button class="bl-collect-btn"
           data-id="${e.id}"
           data-billno="${e.bill_number || ""}"
           data-guest="${(e.guest_name || "").replace(/"/g, "&quot;")}"
           data-balance="${e.balance || 0}"
           title="Collect Payment">
           <i class="fas fa-hand-holding-usd"></i>
         </button>`
      : "";

    const _viewBtnHtml = (isPending || hasBalance)
      // Pending row: admin-only View (Recalculate available inside modal).
      ? `<button class="bl-bill-btn"
           data-id="${e.id}"
           data-roles="admin"
           title="View / Recalculate Bill (admin)">
           <i class="fas fa-receipt"></i>
         </button>`
      // Completed row: View visible to everyone.
      : `<button class="bl-bill-btn" data-id="${e.id}" title="View/Print Bill"><i class="fas fa-receipt"></i></button>`;

    const collectSlot = _slot(_collectBtnHtml);
    const viewSlot    = _slot(_viewBtnHtml);

    // WhatsApp share button — green if PDF already saved, light-green "generate first" if not
    const hasPdf = !!e.pdf_url;
    const waBtnCls = hasPdf ? "bl-wa-btn" : "bl-wa-btn bl-wa-pending";
    const waTitle = "Send invoice via WhatsApp";
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

    // B2B / Reverted / Cancellation-charge pills (Goal 1 / Goal 2 / SAC 999794)
    const b2bPill = (e.invoice_type === "B2B")
      ? '<span class="bl-b2b-pill" title="B2B Tax Invoice">B2B</span>' : '';
    // Revert-cancelled bills (new flow) show CANCELLED; legacy reverted bills
    // that pre-date the cancel-on-revert change still show REVERTED.
    const revertedPill = (e.status === "cancelled")
      ? '<span class="bl-reverted-pill" title="Checkout reverted — this bill was cancelled">CANCELLED</span>'
      : (e.superseded_by_revert
          ? '<span class="bl-reverted-pill" title="Bill reverted - credit note issued">REVERTED</span>'
          : '');
    const cancelPill = e.is_cancellation_charge
      ? '<span class="bl-cancel-pill" title="Cancellation forfeiture invoice — SAC 999794 / 18%">CANCEL CHG</span>' : '';

    // GST-edit icon — admin-only via data-perm gating in the rendered DOM.
    const linkedCn = e.linked_credit_note_id ? true : false;
    const isB2B    = e.invoice_type === "B2B";
    const gstBtnCls = linkedCn ? "bl-gst-locked" : (isB2B ? "bl-gst-set" : "");
    const gstBtnTitle = linkedCn
      ? "GST details locked — credit note linked"
      : isB2B
        ? `B2B • ${e.recipient_legal_name || e.recipient_gstin || ""} — click to edit`
        : "Add B2B GSTIN for tax-invoice recipient";
    const gstBtn = `<button class="bl-gst-btn ${gstBtnCls}"
       data-perm="bill.gst.edit"
       data-id="${e.id}"
       data-billno="${e.bill_number || ''}"
       data-locked="${linkedCn ? '1' : '0'}"
       title="${gstBtnTitle}">
       <i class="fas fa-id-card-alt"></i>
     </button>`;

    // Guest name / phone editing has no button — clicking the name or
    // mobile CELL opens the modal (see the .bl-guest-cell delegation;
    // permission-checked at click time via bill.guest.edit).
    const actionCell = `<div style="display:inline-flex;gap:5px;align-items:center;flex-wrap:nowrap;justify-content:flex-end;">${collectSlot}${viewSlot}${_slot(waBtn)}${_slot(gstBtn)}</div>`;

    return `<tr class="${rowCls}" data-date-group="${dk}" data-entry-id="${e.id || ''}">
      <td style="color:#888;font-size:.75rem;">${rowIndex}</td>
      <td style="font-size:.73rem;white-space:nowrap;font-family:monospace;">${billNo}${pendingBadge}${b2bPill}${revertedPill}${cancelPill}</td>
      <td class="bl-guest-cell" data-id="${e.id || ''}"
          title="Edit guest name / phone"><strong>${e.guest_name || "-"}</strong>${guestNoteHTML}${_activityStrip(e)}</td>
      <td class="bl-guest-cell" data-id="${e.id || ''}"
          title="Edit guest name / phone"
          style="font-size:.78rem;">${e.guest_mobile || "-"}</td>
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
    h += "</div>";

    // Always wrap. The click handler does an explicit isAdmin() check at
    // click time. Cursor + hover styling are scoped to admin via CSS
    // (body[data-role=\"admin\"] .bl-pay-clickable …) so non-admin users
    // see no pointer cue and no hover effect, while the wrapper itself
    // is unconditionally present in the DOM. This avoids the failure
    // mode where the first table render happens before CibaraAuth has
    // resolved the user's role, leaving every cell permanently
    // un-clickable even after auth resolves later.
    return `<div class="bl-pay-clickable" data-bill-id="${e.id || ""}" title="View all payments (admin)">${h}</div>`;
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

  // Operator's bill view preference (Detailed / Consolidated). null → "auto"
  // (long stays default to Consolidated). Persisted so the choice sticks
  // across bills and sessions. localStorage access is guarded — a blocked
  // store simply falls back to auto.
  let _billViewMode = null;
  try {
    const _vm = localStorage.getItem("cibara_bill_view");
    if (_vm === "detailed" || _vm === "consolidated") _billViewMode = _vm;
  } catch (_e) { /* localStorage unavailable — use auto */ }

  // (Re)render the open bill into the print area, keeping the inline
  // attribution banner. Called on open and whenever the view toggle changes.
  function _renderOpenBill() {
    const area = dom("bl-bill-print-area");
    if (!area || !_openBillData) return;
    area.innerHTML = buildBillHTML(_openBillData);
    if (window.CibaraAttribution && _openBillId) {
      const attrEl = document.createElement("div");
      attrEl.style.cssText = "margin: 0 0 10px 0;";
      area.insertBefore(attrEl, area.firstChild);
      window.CibaraAttribution.decorate(attrEl, "bills", _openBillId, { hideIfNone: true });
    }
  }

  // Show the Detailed/Consolidated toggle only when the open bill has a
  // multi-night folio that can actually be consolidated, and highlight the
  // button matching the resolved view mode.
  function _syncViewToggle() {
    const bar = dom("bl-view-toggle");
    if (!bar) return;
    const folio = Array.isArray(_openBillData && _openBillData.daily_folio)
      ? _openBillData.daily_folio : [];
    if (!folioIsCollapsible(folio)) {
      bar.style.display = "none";
      return;
    }
    bar.style.display = "flex";
    const mode = resolveViewMode(_openBillData);
    const dBtn = dom("bl-vt-detailed");
    const cBtn = dom("bl-vt-consolidated");
    if (dBtn) dBtn.classList.toggle("bl-vt-active", mode === "detailed");
    if (cBtn) cBtn.classList.toggle("bl-vt-active", mode === "consolidated");
    const hint = dom("bl-vt-hint");
    if (hint) {
      hint.textContent = mode === "consolidated"
        ? "Room nights grouped — days with extras shown separately"
        : "Every night itemised";
    }
  }

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
        _openBillId = id;
        _openBillData = data.bill;
        // Render the bill body (Detailed/Consolidated per resolveViewMode)
        // with its inline attribution banner, then show the view toggle
        // when this stay has a folio that can be consolidated.
        _renderOpenBill();
        _syncViewToggle();
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
    } catch (err) {
      // Surface the real error — bare `catch` was hiding render exceptions
      // from buildBillHTML behind a generic "Network error" string.
      console.error("[Bills] openBill failed:", err);
      const _msg = (err && (err.message || err.toString())) || "Network error";
      area.innerHTML = `<div class="bl-state" style="color:#c00"><i class="fas fa-times-circle"></i><p>${_msg}</p></div>`;
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fab fa-whatsapp"></i> Save &amp; Share';
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FOLIO VIEW MODES — Detailed vs Consolidated
  // ──────────────────────────────────────────────────────────────────────────
  // The bill stores one folio entry per night (b.daily_folio). The Detailed
  // view itemises every night. The Consolidated view collapses consecutive
  // add-on-free nights that share the same room, GST rate and nightly rate
  // into a single room block, and shows ONLY the nights that carry extra
  // items in full detail. Both views are pure renderings of the same stored
  // data — nothing about storage or GST computation changes.
  // ══════════════════════════════════════════════════════════════════════════

  // Grouping key for a collapsible night. Two consecutive plain nights merge
  // only when room, GST slab and nightly rate all match — so a rate change,
  // slab change or room transfer mid-stay correctly starts a new block.
  function folioNightKey(e) {
    return [
      e.room || "",
      Number(e.day_gst_rate || 0),
      Number(e.base_rate || 0),
    ].join("|");
  }

  // A night is "plain" (collapsible) only when it has no add-on line items.
  // Any night with add-ons is always shown in full and breaks the run.
  function folioNightHasExtras(e) {
    return Array.isArray(e.addons) && e.addons.length > 0;
  }

  // Pure function: folio[] -> ordered blocks.
  //   { kind: "run", entries: [...] }  — 2+ collapsible nights, one block
  //   { kind: "day", entries: [one] }  — shown in full detail
  // A run of a single night is emitted as a "day" (collapsing one night is
  // pointless and would look inconsistent).
  function groupFolio(folio) {
    const blocks = [];
    let run = [];
    const flush = () => {
      if (run.length === 0) return;
      blocks.push({ kind: run.length >= 2 ? "run" : "day", entries: run });
      run = [];
    };
    for (const e of folio) {
      if (folioNightHasExtras(e)) {
        flush();
        blocks.push({ kind: "day", entries: [e] });
        continue;
      }
      if (run.length > 0 && folioNightKey(run[0]) !== folioNightKey(e)) {
        flush();
      }
      run.push(e);
    }
    flush();
    return blocks;
  }

  // True when the Consolidated view would actually merge something — i.e.
  // there is at least one run of 2+ collapsible nights. Drives whether the
  // toggle is shown and what "auto" mode resolves to.
  function folioIsCollapsible(folio) {
    if (!Array.isArray(folio) || folio.length < 2) return false;
    return groupFolio(folio).some((blk) => blk.kind === "run");
  }

  // Resolve the effective view mode for a bill. An explicit operator choice
  // (stored in _billViewMode) always wins; otherwise "auto" — Consolidated
  // when the stay has a collapsible run, Detailed when it does not.
  function resolveViewMode(b) {
    if (_billViewMode === "detailed" || _billViewMode === "consolidated") {
      return _billViewMode;
    }
    const folio = Array.isArray(b && b.daily_folio) ? b.daily_folio : [];
    return folioIsCollapsible(folio) ? "consolidated" : "detailed";
  }

  // Render ONE folio night in full detail (Night header, Room Rent, add-ons,
  // taxable base, tax-head split, night total). Used by the Detailed view and
  // for every add-on night inside the Consolidated view. Returns a <tr> string.
  function renderFolioNight(e, b) {
    const parts = [];
    const di          = e.day_index || 1;
    const diRoom      = e.room || (b && b.room) || "";
    const diRate      = Number(e.day_gst_rate || 0);
    const diDivisor   = diRate > 0 ? (1 + diRate / 100) : 1;
    const diBase      = Number(e.base_rate || 0);
    const diAddons    = Array.isArray(e.addons) ? e.addons : [];
    const diTotal     = Number(e.day_total || 0);
    const diTaxable   = Number(e.day_taxable || 0);
    const diCgst      = Number(e.day_cgst || 0);
    const diSgst      = Number(e.day_sgst || 0);
    const diIgst      = Number(e.day_igst || 0);
    const diDiscount  = Number(e.discount_allocated || 0);
    const diStart     = e.day_start || "";

    // Per-line discount allocation (proportional)
    const diGrossPre = diBase + diAddons.reduce(
      (s, a) => s + Number(a.price || 0), 0);
    const baseDisc = (diDiscount > 0 && diGrossPre > 0)
      ? diDiscount * (diBase / diGrossPre) : 0;
    const baseEffGross = diBase - baseDisc;
    const baseTaxable  = baseEffGross / diDivisor;

    // ─ Night N · DATE · Rm X ─
    parts.push(`<tr class="b-sec"><td colspan="4" style="text-align:center;">
      ─ Night ${di} &nbsp;·&nbsp; ${diStart.slice(0, 10)} &nbsp;·&nbsp; Rm ${diRoom} ─
    </td></tr>`);

    parts.push(`<tr>
      <td>Room Rent</td>
      <td class="b-tr">1</td>
      <td class="b-tr">${fix2(baseTaxable)}</td>
      <td class="b-tr">${fix2(baseTaxable)}</td>
    </tr>`);

    for (const a of diAddons) {
      const aGross = Number(a.price || 0);
      const aUnit  = Number(a.unit_price || a.price || 0);
      const aQty   = Number(a.quantity || 1);
      const aDisc = (diDiscount > 0 && diGrossPre > 0)
        ? diDiscount * (aGross / diGrossPre) : 0;
      const aEffGross = aGross - aDisc;
      const aTaxable  = aEffGross / diDivisor;
      const aUnitTaxable = aUnit / diDivisor;
      parts.push(`<tr>
        <td>${a.item || "Service"}</td>
        <td class="b-tr">${aQty}</td>
        <td class="b-tr">${fix2(aUnitTaxable)}</td>
        <td class="b-tr">${fix2(aTaxable)}</td>
      </tr>`);
    }

    if (diDiscount > 0) {
      parts.push(`<tr>
        <td colspan="3" style="text-align:right;color:#2e7d32;font-weight:600;">
          Less: Discount allocated to Night ${di}
        </td>
        <td class="b-tr" style="color:#2e7d32;font-weight:700;">− ${fix2(diDiscount)}</td>
      </tr>`);
    }

    parts.push(`<tr class="b-gst-row">
      <td>Taxable Base (excl. GST)</td>
      <td class="b-tr">—</td><td class="b-tr">—</td>
      <td class="b-tr">${fix2(diTaxable)}</td>
    </tr>`);

    if (diRate > 0 && diTaxable > 0) {
      if (diIgst > 0) {
        parts.push(`<tr class="b-gst-row">
          <td>IGST @ ${diRate}%</td>
          <td class="b-tr">—</td><td class="b-tr">—</td>
          <td class="b-tr">${fix2(diIgst)}</td>
        </tr>`);
      } else {
        const half = diRate / 2;
        parts.push(`<tr class="b-gst-row">
          <td>CGST @ ${half}%</td>
          <td class="b-tr">—</td><td class="b-tr">—</td>
          <td class="b-tr">${fix2(diCgst)}</td>
        </tr>`);
        parts.push(`<tr class="b-gst-row">
          <td>SGST @ ${half}%</td>
          <td class="b-tr">—</td><td class="b-tr">—</td>
          <td class="b-tr">${fix2(diSgst)}</td>
        </tr>`);
      }
    } else if (diRate === 0 && diTaxable > 0) {
      parts.push(`<tr class="b-gst-row">
        <td colspan="3" style="color:#888;">GST Exempt (per-night value &lt; ₹1,000)</td>
        <td class="b-tr">0.00</td>
      </tr>`);
    }

    parts.push(`<tr class="b-subtotal">
      <td colspan="3" class="b-tr">Night ${di} Total (incl. GST)</td>
      <td class="b-tr">${fix2(diTotal)}</td>
    </tr>`);
    return parts.join("");
  }

  // Render a run of consecutive add-on-free nights as ONE consolidated block.
  // groupFolio guarantees every night in the run shares room, GST rate and
  // nightly rate. All amounts are SUMMED from the stored per-night fields —
  // never recomputed from rate × nights — so the consolidated total
  // reconciles to the paisa with the Detailed view and the grand total.
  function renderFolioRun(entries, b) {
    const parts = [];
    const n     = entries.length;
    const first = entries[0];
    const last  = entries[n - 1];
    const room  = first.room || (b && b.room) || "";
    const rate  = Number(first.day_gst_rate || 0);
    const sum   = (k) => entries.reduce((s, e) => s + Number(e[k] || 0), 0);
    const total    = sum("day_total");
    const taxable  = sum("day_taxable");
    const cgst     = sum("day_cgst");
    const sgst     = sum("day_sgst");
    const igst     = sum("day_igst");
    const discount = sum("discount_allocated");
    const d1 = (first.day_start || "").slice(0, 10);
    const d2 = (last.day_start  || "").slice(0, 10);
    const perNightTaxable = n ? taxable / n : 0;

    // ─ Room Rent · DATE1 – DATE2 · N nights · Rm X ─
    parts.push(`<tr class="b-sec"><td colspan="4" style="text-align:center;">
      ─ Room Rent &nbsp;·&nbsp; ${d1} – ${d2} &nbsp;·&nbsp; ${n} nights &nbsp;·&nbsp; Rm ${room} ─
    </td></tr>`);

    parts.push(`<tr>
      <td>Room Rent</td>
      <td class="b-tr">${n}</td>
      <td class="b-tr">${fix2(perNightTaxable)}</td>
      <td class="b-tr">${fix2(taxable)}</td>
    </tr>`);

    if (discount > 0) {
      parts.push(`<tr>
        <td colspan="3" style="text-align:right;color:#2e7d32;font-weight:600;">
          Less: Discount allocated to these ${n} nights
        </td>
        <td class="b-tr" style="color:#2e7d32;font-weight:700;">− ${fix2(discount)}</td>
      </tr>`);
    }

    parts.push(`<tr class="b-gst-row">
      <td>Taxable Base (excl. GST)</td>
      <td class="b-tr">—</td><td class="b-tr">—</td>
      <td class="b-tr">${fix2(taxable)}</td>
    </tr>`);

    if (rate > 0 && taxable > 0) {
      if (igst > 0) {
        parts.push(`<tr class="b-gst-row">
          <td>IGST @ ${rate}%</td>
          <td class="b-tr">—</td><td class="b-tr">—</td>
          <td class="b-tr">${fix2(igst)}</td>
        </tr>`);
      } else {
        const half = rate / 2;
        parts.push(`<tr class="b-gst-row">
          <td>CGST @ ${half}%</td>
          <td class="b-tr">—</td><td class="b-tr">—</td>
          <td class="b-tr">${fix2(cgst)}</td>
        </tr>`);
        parts.push(`<tr class="b-gst-row">
          <td>SGST @ ${half}%</td>
          <td class="b-tr">—</td><td class="b-tr">—</td>
          <td class="b-tr">${fix2(sgst)}</td>
        </tr>`);
      }
    } else if (rate === 0 && taxable > 0) {
      parts.push(`<tr class="b-gst-row">
        <td colspan="3" style="color:#888;">GST Exempt (per-night value &lt; ₹1,000)</td>
        <td class="b-tr">0.00</td>
      </tr>`);
    }

    parts.push(`<tr class="b-subtotal">
      <td colspan="3" class="b-tr">Room Charges · ${d1} – ${d2} (${n} nights, incl. GST)</td>
      <td class="b-tr">${fix2(total)}</td>
    </tr>`);
    return parts.join("");
  }

  // ── Bill HTML builder ─────────────────────────────────────────────────────────
  // GST rates per 55th GST Council (eff. 22 Sep 2025) + Karnataka place of supply
  // Always shows CGST and SGST rows — 0.00 when rate is exempt (tariff < ₹1,000).
  function buildBillHTML(b, viewModeOverride) {
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

    // ── Water vs non-water split (water = GST 5% inclusive/MRP; others = non-taxable) ──
    const waterServices    = otherServices.filter((s) => (s.item || "").toLowerCase().includes("water"));
    const nonWaterServices = otherServices.filter((s) => !(s.item || "").toLowerCase().includes("water"));
    const waterSvcTotal    = waterServices.reduce((s, x) => s + (x.price || 0), 0);
    const nonWaterSvcTotal = nonWaterServices.reduce((s, x) => s + (x.price || 0), 0);

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

    // GST display strategy:
    // config.py now stores gst_amount using inclusive back-calculation AND
    // per-segment logic (so room transfers with different slabs are correct).
    // We TRUST the stored value — but old bills used the exclusive formula
    // (rate/100 instead of rate/(100+rate)) producing a slightly higher number.
    // Detect old bills: if stored value ≈ accomTotal × rate/100, it is the
    // wrong exclusive formula → recalculate with inclusive formula.
    // Otherwise (stored < exclusive result, e.g. room transfers with exempt
    // segments, or already-correct inclusive bills) → use stored value.
    let cgst, sgst, accomBase;
    if (typeof b.gst_amount === "number" && gstRatePct > 0) {
      const exclusiveGst = accomTotal * gstRatePct / 100;
      const isOldExclusiveBill = Math.abs(b.gst_amount - exclusiveGst) < 0.10;
      let gstAmt;
      if (isOldExclusiveBill) {
        // Old bill — recalculate correctly (inclusive back-calculation on full total)
        gstAmt = accomTotal * gstRatePct / (100 + gstRatePct);
      } else {
        // New bill or room-transfer bill — trust stored per-segment value
        gstAmt = b.gst_amount;
      }
      cgst      = gstAmt / 2;
      sgst      = cgst;
      accomBase = accomTotal - gstAmt;
    } else if (gstRatePct > 0) {
      // No stored value — back-calculate
      const gstAmt = accomTotal * gstRatePct / (100 + gstRatePct);
      cgst      = gstAmt / 2;
      sgst      = cgst;
      accomBase = accomTotal - gstAmt;
    } else {
      cgst = 0; sgst = 0; accomBase = accomTotal;
    }

    // ── Discount — recalculate GST on post-discount accommodation ────────────
    // Sec 15(3)(a) CGST Act: pre-supply discounts reduce the taxable value.
    // Prorate: discount applied to accommodation first, excess to services.
    const discounts = b.discounts || 0;
    const discountOnAccom   = Math.min(discounts, accomTotal);
    const effectiveAccom    = accomTotal - discountOnAccom;  // post-discount base

    // Recalculate GST on effective accommodation (overwrites earlier cgst/sgst)
    if (gstRatePct > 0 && effectiveAccom > 0) {
      const effGst = effectiveAccom * gstRatePct / (100 + gstRatePct);
      cgst      = effGst / 2;
      sgst      = cgst;
      accomBase = effectiveAccom - effGst;
    } else if (gstRatePct > 0 && effectiveAccom <= 0) {
      cgst = 0; sgst = 0; accomBase = 0;
    }
    // (if gstRatePct == 0, cgst/sgst are already 0 from above)

    const svcTotalAll = b.services_total || 0; // includes both types
    const grandTotal = (typeof b.total_amount === "number" && b.total_amount > 0)
      ? b.total_amount
      : roomCharges + svcTotalAll - discounts;

    // Payment
    const cashPaid = b.payment_cash || 0;
    const onlinePaid = b.payment_online || 0;
    // OTA-settled (MMT prepaid the room; settles to the bank later). Counted
    // as paid against the invoice so Total Paid reconciles with the grand
    // total and the balance reads zero — but it is NOT a front-desk receipt.
    const otaPaid = b.payment_ota || 0;
    const refunds = b.refunds || 0;
    const refundCash = b.refund_cash || 0;
    const refundOnline = b.refund_online || 0;
    const totalPaid = cashPaid + onlinePaid + otaPaid;
    const netCollected = totalPaid - refunds;
    const balance = b.balance || 0;

    const displayBillNo = b.bill_number || "N/A";
    const billDate = fmtBillDT(b.checkout_time);

    // ── Accommodation add-on rows ────────────────────────────────────────────────
    let accomAddonRows = accomAddons
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

    // ── Water service rows (GST 5% inclusive — show taxable value in Amount col) ──
    // taxable_value = price / 1.05  (back-calculate from MRP — price does NOT change)
    let waterCgst = 0, waterSgst = 0;
    waterServices.forEach((s) => {
      const wGst = (s.price || 0) - (s.price || 0) / 1.05;
      waterCgst += wGst / 2;
      waterSgst += wGst / 2;
    });
    const waterRows = waterServices
      .map((s) => `
      <tr>
        <td>${s.item || "Water"}</td>
        <td class="b-tr">${s.quantity || 1}</td>
        <td class="b-tr">${fix2((s.unit_price || s.price || 0) / 1.05)}</td>
        <td class="b-tr">${fix2((s.price || 0) / 1.05)}</td>
      </tr>`)
      .join("");
    const waterSvcSection = waterRows
      ? `<tr class="b-sec"><td colspan="4">Packaged Drinking Water (HSN: 2201)</td></tr>
         ${waterRows}
         <tr class="b-gst-row">
           <td>CGST @ 2.5%</td>
           <td class="b-tr">—</td><td class="b-tr">—</td>
           <td class="b-tr">${fix2(waterCgst)}</td>
         </tr>
         <tr class="b-gst-row">
           <td>SGST @ 2.5%</td>
           <td class="b-tr">—</td><td class="b-tr">—</td>
           <td class="b-tr">${fix2(waterSgst)}</td>
         </tr>
         <tr class="b-subtotal">
           <td colspan="3" class="b-tr">Water Total (MRP, incl. GST)</td>
           <td class="b-tr">${fix2(waterSvcTotal)}</td>
         </tr>`
      : "";

    // ── Other services rows (non-water, non-taxable) ─────────────────────────────
    const otherSvcRows = nonWaterServices
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

    // ── GST rows — recalculated post-discount (Sec 15(3)(a) CGST Act) ───────────
    let gstRows;
    if (gstRatePct > 0 && effectiveAccom > 0) {
      // Normal: GST on net accommodation after discount
      gstRows = `
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
    } else if (gstRatePct > 0 && effectiveAccom <= 0) {
      // Full discount — GST waived
      gstRows = `
        <tr class="b-gst-row">
          <td colspan="3" style="color:#2e7d32;">GST Nil (Discount applied — Sec 15(3)(a) CGST Act)</td>
          <td class="b-tr">0.00</td>
        </tr>`;
    } else {
      // Exempt slab (< ₹1,000/night)
      gstRows = `
        <tr class="b-gst-row">
          <td colspan="3" style="color:#888;">GST Exempt (Room rate below ₹1,000/night)</td>
          <td class="b-tr">0.00</td>
        </tr>`;
    }

    // Helper: GST slab for a given per-night price
    function segGstRate(p) {
      return p < 1000 ? 0 : p <= 7500 ? 5 : 18;
    }
    function segTaxable(totalIncl, price) {
      const r = segGstRate(price);
      return r > 0 ? totalIncl / (1 + r / 100) : totalIncl;
    }

    // ── Room Rent rows: pre-GST taxable values, one per segment for transfers ──
    const roomSegments = b.room_segments || [];

    // Detect format: new format has "room" key; old format has "from_room" key
    const isNewFormat = roomSegments.length > 0 && "room" in roomSegments[0];
    const isMultiRoom = (isNewFormat && roomSegments.length > 1)
                     || (!isNewFormat && roomSegments.length > 0);

    // Accommodation subtotal row (when add-ons, multi-day, or multi-room)
    const accomSubtotalRow =
      accomAddons.length > 0 || days > 1 || isMultiRoom
        ? `<tr class="b-subtotal">
           <td colspan="3" class="b-tr">Accommodation Total (incl. GST)</td>
           <td class="b-tr">${fix2(accomTotal)}</td>
         </tr>`
        : "";

    // Other services section (non-water, non-accommodation, non-taxable)
    const otherSvcSection = otherSvcRows
      ? `<tr class="b-sec"><td colspan="4">Additional Services (Non-Taxable)</td></tr>
         ${otherSvcRows}
         <tr class="b-subtotal">
           <td colspan="3" class="b-tr">Services Total</td>
           <td class="b-tr">${fix2(nonWaterSvcTotal)}</td>
         </tr>`
      : "";

    let roomRentRows = "";
    if (isNewFormat && roomSegments.length > 1) {
      // NEW FORMAT — multi-room: render all segments from clean array
      for (const seg of roomSegments) {
        const segNights = seg.nights || 0;
        if (segNights > 0) {
          const segTax  = segTaxable(seg.total || 0, seg.rate || 0);
          const segRate = segNights ? segTax / segNights : 0;
          roomRentRows += `<tr>
            <td>Room Rent – Rm ${seg.room || ""}</td>
            <td class="b-tr">${segNights}</td>
            <td class="b-tr">${fix2(segRate)}</td>
            <td class="b-tr">${fix2(segTax)}</td>
          </tr>`;
        }
      }
    } else if (!isNewFormat && roomSegments.length > 0) {
      // OLD FORMAT — backward compat for bills before this change
      const currentRoomNo    = b.current_room || b.room || "";
      const currentRoomDays  = b.current_room_days;
      const currentRoomPrice = b.current_room_price;
      const currentRoomTotal = b.current_room_total;
      for (const seg of roomSegments) {
        if ((seg.days || 0) > 0) {
          const segTax  = segTaxable(seg.total || 0, seg.price || 0);
          const segRate = seg.days ? segTax / seg.days : 0;
          roomRentRows += `<tr>
            <td>Room Rent – Rm ${seg.from_room || ""}</td>
            <td class="b-tr">${seg.days}</td>
            <td class="b-tr">${fix2(segRate)}</td>
            <td class="b-tr">${fix2(segTax)}</td>
          </tr>`;
        }
      }
      if ((currentRoomDays || 0) > 0) {
        const currTax  = segTaxable(currentRoomTotal || 0, currentRoomPrice || 0);
        const currRate = currentRoomDays ? currTax / currentRoomDays : 0;
        roomRentRows += `<tr>
          <td>Room Rent – Rm ${currentRoomNo}</td>
          <td class="b-tr">${currentRoomDays}</td>
          <td class="b-tr">${fix2(currRate)}</td>
          <td class="b-tr">${fix2(currTax)}</td>
        </tr>`;
      }
    } else {
      // Single-room stay — show pre-GST taxable base
      roomRentRows = `<tr>
        <td>Room Rent</td>
        <td class="b-tr">${days}</td>
        <td class="b-tr">${fix2(accomBase / (days || 1))}</td>
        <td class="b-tr">${fix2(accomBase)}</td>
      </tr>`;
    }

    // For add-on stays show a "Taxable Base" row so math is transparent
    let taxableBaseRow = accomAddons.length > 0
      ? `<tr class="b-gst-row">
           <td>Taxable Base (excl. GST)</td>
           <td class="b-tr">—</td><td class="b-tr">—</td>
           <td class="b-tr">${fix2(accomBase)}</td>
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

    // Round-off row — GST back-calculation can leave a ₹0.01 gap between
    // (taxable_base + CGST + SGST) and the inclusive MRP. Show when ≥ ₹0.01.
    const computedAccomSum = Math.round((accomBase + cgst + sgst) * 100) / 100;
    const roundDiff = Math.round((effectiveAccom - computedAccomSum) * 100) / 100;
    let roundOffRow = Math.abs(roundDiff) >= 0.01
      ? `<tr class="b-gst-row">
           <td colspan="3" style="text-align:right;color:#aaa;">Round-off</td>
           <td class="b-tr" style="color:#aaa;">${roundDiff > 0 ? "+" : ""}${fix2(roundDiff)}</td>
         </tr>`
      : "";

    // ── Inter-state detection (drives CGST+SGST vs IGST display) ────────────
    const rcptStateCode = (b.recipient_state_code || "29").trim() || "29";
    const isInterState  = rcptStateCode !== "29";
    const rcptStateName = b.recipient_state || "Karnataka";

    // ── Daily folio per-night rendering ─────────────────────────────────────
    // When `b.daily_folio` is present (bills created post-folio-migration),
    // render one section per night with its own room rent, addons, taxable
    // base, tax-head split, and night total. Matches the backend PDF
    // builder so the in-browser preview and the downloadable PDF are
    // visually identical. Legacy bills without folio fall through to the
    // single-block rendering above.
    let accomSubtotalRowFinal = accomSubtotalRow;
    const folio = Array.isArray(b.daily_folio) ? b.daily_folio : [];
    if (folio.length > 0) {
      // Detailed itemises every night; Consolidated collapses runs of
      // add-on-free nights into one room block (see groupFolio) and shows
      // only the days with extras in full. Both views sum to the identical
      // Accommodation Total — all amounts come straight from the stored
      // per-night folio fields, never recomputed.
      const viewMode = viewModeOverride || resolveViewMode(b);

      let allNightsTotal = 0;
      for (const e of folio) allNightsTotal += Number(e.day_total || 0);

      const folioParts = [];
      if (viewMode === "consolidated") {
        for (const blk of groupFolio(folio)) {
          folioParts.push(
            blk.kind === "run"
              ? renderFolioRun(blk.entries, b)
              : renderFolioNight(blk.entries[0], b),
          );
        }
      } else {
        for (const e of folio) folioParts.push(renderFolioNight(e, b));
      }

      // Override the legacy single-block accommodation rows
      roomRentRows = folioParts.join("");
      accomAddonRows = "";
      taxableBaseRow = "";
      gstRows = "";
      roundOffRow = "";
      accomSubtotalRowFinal = `<tr class="b-subtotal">
        <td colspan="3" class="b-tr">Accommodation Total (all nights, incl. GST)</td>
        <td class="b-tr">${fix2(allNightsTotal)}</td>
      </tr>`;
    }

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
        <div class="b-row"><span class="b-lbl">Place of Supply:</span> ${rcptStateName} (${rcptStateCode}) − ${isInterState ? "IGST" : "CGST+SGST"}</div>
      </td>
    </tr>
  </table>

  ${(function() {
    const it = b.invoice_type || "B2C";
    const gstin = (b.recipient_gstin || "").trim();
    const legal = (b.recipient_legal_name || "").trim();
    const trade = (b.recipient_trade_name || "").trim();
    const addr  = (b.recipient_address || "").trim();
    const stN   = b.recipient_state || "Karnataka";
    const stC   = b.recipient_state_code || "29";
    if (it === "B2B" && gstin) {
      return `
  <table class="b-info-outer" style="margin-top:6px;">
    <tr><td class="b-info-col" colspan="2" style="background:#f8f9fc;">
      <div class="b-row" style="font-weight:bold;color:#1a1a1a;">BILL TO (Recipient — Registered)</div>
      <div class="b-row"><span class="b-lbl">Legal Name:</span> ${legal}</div>
      ${trade ? `<div class="b-row"><span class="b-lbl">Trade Name:</span> ${trade}</div>` : ""}
      <div class="b-row"><span class="b-lbl">GSTIN:</span> ${gstin}</div>
      ${addr  ? `<div class="b-row"><span class="b-lbl">Address:</span> ${addr.replace(/\n/g, ", ")}</div>` : ""}
      <div class="b-row"><span class="b-lbl">State:</span> ${stN} (${stC})</div>
      <div class="b-row" style="font-size:8.5pt;color:#666;margin-top:4px;">GST payable on reverse charge: No</div>
    </td></tr>
  </table>`;
    }
    if (it === "B2CL" && (addr || stN)) {
      return `
  <table class="b-info-outer" style="margin-top:6px;">
    <tr><td class="b-info-col" colspan="2" style="background:#f8f9fc;">
      <div class="b-row" style="font-weight:bold;color:#1a1a1a;">BILL TO (Recipient — Unregistered, Inter-State)</div>
      ${addr ? `<div class="b-row"><span class="b-lbl">Address:</span> ${addr.replace(/\n/g, ", ")}</div>` : ""}
      <div class="b-row"><span class="b-lbl">State:</span> ${stN} (${stC})</div>
    </td></tr>
  </table>`;
    }
    return "";
  })()}

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
      ${roomRentRows}
      ${accomAddonRows}
      ${taxableBaseRow}
      ${gstRows}
      ${roundOffRow}
      ${accomSubtotalRowFinal}
      ${waterSvcSection}
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
        ${otaPaid > 0 ? `<tr><td>Paid via MMT (OTA)</td><td class="b-tr">₹ ${fix2(otaPaid)}</td></tr>` : ""}
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
        ${/* removed PAID IN FULL — balance row already shows ₹0 when settled */ ""}
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

  // ── Export — CA-ready 8-sheet GSTR-1 Workbook (Goal 3) ────────────────────
  // Sheet 1: Invoice Register   — line-item detail (incl. invoice_type, GSTIN cols)
  // Sheet 2: B2B Invoices       — GSTR-1 Table 4 (registered recipients)
  // Sheet 3: B2C Summary        — GSTR-1 Table 7 (excl. B2B; net of B2C CNs)
  // Sheet 4: B2CL Invoices      — GSTR-1 Table 5 (unregistered, > B2CL threshold)
  // Sheet 5: HSN/SAC Summary    — GSTR-1 Table 12
  // Sheet 6: CDNR (B2B CNs)     — GSTR-1 Table 9B (registered credit notes)
  // Sheet 7: B2C Credit Notes   — credit notes against unregistered customers
  // Sheet 8: GSTR-3B Summary    — output tax / ITC / RCM / net cash payable
  // Hidden:  _schema            — GSTN JSON-schema version reference
  //
  // Column orders mirror GSTN's published GSTR-1 JSON schema (2.1) field
  // order so a CA can paste rows directly into the offline GSTR-1 utility.
  // Schema version recorded in the hidden _schema sheet.
  async function exportToExcel() {
    if (!state.filteredEntries.length) {
      alert("No invoiced bills to export.");
      return;
    }
    if (typeof XLSX === "undefined") {
      alert("Excel library not loaded. Refresh and retry.");
      return;
    }

    const period = `${state.dateRange.start} to ${state.dateRange.end}`;
    const r2 = v => +parseFloat(v || 0).toFixed(2);

    // Fetch credit notes for the same period (parallel with bill aggregation
    // — Firestore call, ~200ms typical). If it fails we still produce a
    // best-effort export with empty CN sheets.
    let creditNotes = [];
    try {
      const cnRes = await apiFetch("/list_credit_notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start_date: state.dateRange.start,
          end_date:   state.dateRange.end,
        }),
      });
      const cnData = await cnRes.json();
      if (cnData && cnData.success) creditNotes = cnData.credit_notes || [];
    } catch (err) {
      console.warn("[Bills] export: list_credit_notes failed", err);
    }

    // Pull advances (Table 11A/B) for the same period.
    let advances = [];
    try {
      const advRes = await apiFetch("/list_advances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start_date: state.dateRange.start,
          end_date:   state.dateRange.end,
        }),
      });
      const advData = await advRes.json();
      if (advData && advData.success) advances = advData.advances || [];
    } catch (err) {
      console.warn("[Bills] export: list_advances failed", err);
    }

    // Pull GST-bearing expenses (input tax credit) for the same period. The
    // backend enforces the data.export permission, so this is admin/manager
    // only. Best-effort — a failure just yields an empty ITC sheet.
    let gstExpenses = [];
    try {
      const expRes = await apiFetch("/expenses_gst", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start_date: state.dateRange.start,
          end_date:   state.dateRange.end,
        }),
      });
      if (!expRes.ok) {
        // Surface the real reason instead of silently shipping an empty sheet —
        // 403 = no data.export permission, 404 = endpoint not deployed yet,
        // 5xx = server error. This turns "the expenses just don't show" into a
        // diagnosable message.
        const _why = expRes.status === 403
          ? "you don't have export permission (admin only)"
          : expRes.status === 404
            ? "the expenses endpoint isn't deployed yet — redeploy the server"
            : `server error ${expRes.status}`;
        console.warn("[Bills] expenses_gst HTTP", expRes.status);
        alert(`Note: the GST Expenses (ITC) sheet could not be loaded — ${_why}. The rest of the workbook will still export.`);
      } else {
        const expData = await expRes.json();
        if (expData && expData.success) {
          gstExpenses = expData.expenses || [];
        } else {
          console.warn("[Bills] expenses_gst returned", expData);
        }
      }
    } catch (err) {
      console.warn("[Bills] export: expenses_gst failed", err);
    }

    // Buckets for B2C summary / HSN sheets
    const b = {
      accom5:     { taxable: 0, cgst: 0, sgst: 0, igst: 0 },
      accom18:    { taxable: 0, cgst: 0, sgst: 0, igst: 0 },
      accomExmpt: { taxable: 0, cgst: 0, sgst: 0, igst: 0 },
      water5:     { taxable: 0, cgst: 0, sgst: 0, igst: 0, mrp: 0 },
      // SAC 999794 — cancellation forfeiture / agreement to refrain.
      // Separate bucket so it lands in its own HSN row, not bundled with 9963.
      cancel18:   { taxable: 0, cgst: 0, sgst: 0, igst: 0, count: 0 },
    };

    const regRows = [];
    const b2bRows = [];
    const b2clRows = [];
    let regSerial = 1;

    // CA workbook is always chronological — sort by bill_number ASC so the
    // Invoice Register reads top-to-bottom as 1, 2, 3 … N regardless of how
    // the on-screen Bills tab is sorted (latest-first by default for the
    // operator).
    const _exportEntries = [...state.filteredEntries].sort(
      (a, b) => parseBillNo(a.bill_number) - parseBillNo(b.bill_number),
    );
    _exportEntries.forEach((e) => {
      const days = e.days_stayed || calcDays(e.checkin_time, e.checkout_time);

      // ── Revert-cancelled bills ──────────────────────────────────────────
      // Listed in the Invoice Register so the CC serial sequence has no
      // unexplained gap, but at ZERO value and EXCLUDED from every tax
      // bucket / B2C summary. The invoice was cancelled before the period's
      // GSTR-1 was filed, so it carries no output tax to report.
      if (e.status === "cancelled") {
        regRows.push({
          "Sr No":                    regSerial++,
          "Bill No":                  e.bill_number || "-",
          "Invoice Type":             e.invoice_type || "B2C",
          "Recipient GSTIN":          e.recipient_gstin || "",
          "Recipient Legal Name":     e.recipient_legal_name || "",
          "Recipient State":          e.recipient_state || "",
          "Guest Name":               e.guest_name || "-",
          "Contact":                  e.guest_mobile || "-",
          "Room":                     e.room || "-",
          "Check-in":                 fmtDT(e.checkin_time),
          "Check-out":                e.checkout_time ? fmtDT(e.checkout_time) : "-",
          "Days":                     days,
          "Room Rate/Night":          0,
          "Accom Taxable (excl GST)": 0,
          "Accom GST Rate %":         0,
          "Accom CGST":               0,
          "Accom SGST":               0,
          "Accom Total (incl GST)":   0,
          "Water MRP (incl GST)":     0,
          "Water Taxable (excl GST)": 0,
          "Water CGST (2.5%)":        0,
          "Water SGST (2.5%)":        0,
          "Water GST Total":          0,
          "Other Services":           0,
          "Grand Total":              0,
          "Cash Paid":                0,
          "Online/UPI Paid":          0,
          "Refund":                   0,
          "Balance Due":              0,
          "Booking Source":           e.booking_source || "normal",
          "Place of Supply":          "Karnataka (KA-29)",
          "SAC/HSN":                  "9963 / 2201",
          "Linked CN ID":             "",
          "Reverted":                 "CANCELLED",
        });
        return;  // no tax-bucket aggregation — cancelled = zero output tax
      }

      // Cancellation-charge bills are SAC 999794 (agreement to refrain) at
      // 18% inclusive, NOT accommodation 9963. Bucket them separately so
      // the GSTR-1 / HSN sheets don't misclassify.
      const isCancelCharge = !!e.is_cancellation_charge;
      let ag, wg, nonWaterSvcTotal, accomInclGst;
      if (isCancelCharge) {
        const tot     = parseFloat(e.total_amount || 0);
        const gstAmt  = +(tot * 18 / 118).toFixed(2);
        const taxable = +(tot - gstAmt).toFixed(2);
        ag = {
          taxable, cgst: +(gstAmt / 2).toFixed(2), sgst: +(gstAmt / 2).toFixed(2),
          cgstRate: 9,
        };
        wg = { mrp: 0, taxable: 0, cgst: 0, sgst: 0, qty: 0 };
        nonWaterSvcTotal = 0;
        accomInclGst = tot;
      } else {
        ag  = accomTaxFromEntry(e, days);
        wg  = waterGst(e.services || []);
        nonWaterSvcTotal = (e.services || [])
          .filter(s => !s.accommodation_charge && !(s.item || '').toLowerCase().includes('water'))
          .reduce((sum, s) => sum + parseFloat(s.price || 0), 0);
        // Net of on-invoice discount — taxable + GST (Section 15(3)(a)),
        // consistent with the stored bill and the printed invoice.
        accomInclGst = ag.taxable + ag.cgst + ag.sgst;
      }

      const invoiceType = e.invoice_type || "B2C";
      const recipientGstin = e.recipient_gstin || "";
      const recipientName  = e.recipient_legal_name || "";

      regRows.push({
        // Sr No is a SEQUENTIAL row counter (1, 2, 3 … N) for the workbook —
        // exactly what a CA expects in an invoice register.
        "Sr No":                   regSerial++,
        "Bill No":                 e.bill_number || "-",
        "Invoice Type":            invoiceType,
        "Recipient GSTIN":         recipientGstin,
        "Recipient Legal Name":    recipientName,
        "Recipient State":         e.recipient_state || "",
        "Guest Name":              e.guest_name || "-",
        "Contact":                 e.guest_mobile || "-",
        "Room":                    e.room || "-",
        "Check-in":                fmtDT(e.checkin_time),
        "Check-out":               e.checkout_time ? fmtDT(e.checkout_time) : "-",
        "Days":                    days,
        "Room Rate/Night":         e.room_rent || 0,
        "Accom Taxable (excl GST)": r2(ag.taxable),
        "Accom GST Rate %":        ag.cgstRate * 2,
        "Accom CGST":              r2(ag.cgst),
        "Accom SGST":              r2(ag.sgst),
        "Accom Total (incl GST)":  r2(accomInclGst),
        "Water MRP (incl GST)":    r2(wg.mrp),
        "Water Taxable (excl GST)":r2(wg.taxable),
        "Water CGST (2.5%)":       r2(wg.cgst),
        "Water SGST (2.5%)":       r2(wg.sgst),
        "Water GST Total":         r2(wg.cgst + wg.sgst),
        "Other Services":          r2(nonWaterSvcTotal),
        "Grand Total":             e.total_amount || 0,
        "Cash Paid":               e.payment_cash || 0,
        "Online/UPI Paid":         e.payment_online || 0,
        "Refund":                  e.refunds || 0,
        "Balance Due":             e.balance || 0,
        "Booking Source":          e.booking_source || "normal",
        "Place of Supply":         "Karnataka (KA-29)",
        "SAC/HSN":                 "9963 / 2201",
        "Linked CN ID":            e.linked_credit_note_id || "",
        "Reverted":                e.superseded_by_revert ? "Yes" : "",
      });

      // B2B rows mirror GSTR-1 Table 4 column order exactly.
      if (invoiceType === "B2B") {
        const totalTaxable = r2(ag.taxable + wg.taxable);
        const cessAmount = 0;
        // One row per rate slab present on this bill — accommodation only,
        // since water is HSN 2201 and goes in HSN sheet too. For practical
        // purposes a hotel B2B bill has a single accommodation rate.
        const ratePct = ag.cgstRate * 2;
        b2bRows.push({
          "GSTIN/UIN of Recipient": recipientGstin,
          "Receiver Name":          recipientName,
          "Invoice Number":         e.bill_number || "",
          "Invoice Date":           (e.checkout_time || "").split(" ")[0],
          "Invoice Value":          r2(e.total_amount || 0),
          "Place Of Supply":        "29-Karnataka",
          "Reverse Charge":         "N",
          "Applicable % of Tax Rate": "",
          "Invoice Type":           "Regular B2B",
          "E-Commerce GSTIN":       "",
          "Rate":                   ratePct,
          "Taxable Value":          r2(ag.taxable),
          "Cess Amount":            cessAmount,
        });
      } else if (invoiceType === "B2CL") {
        b2clRows.push({
          "Invoice Number":         e.bill_number || "",
          "Invoice Date":           (e.checkout_time || "").split(" ")[0],
          "Invoice Value":          r2(e.total_amount || 0),
          "Place Of Supply":        "29-Karnataka",
          "Applicable % of Tax Rate": "",
          "Rate":                   ag.cgstRate * 2,
          "Taxable Value":          r2(ag.taxable),
          "Cess Amount":            0,
          "E-Commerce GSTIN":       "",
        });
      }

      // B2C summary aggregation EXCLUDES B2B (Table 4 covers them),
      // EXCLUDES B2CL (Table 5 covers them), and EXCLUDES cancellation
      // charges (separate SAC 999794 bucket below). Only true B2C
      // accommodation lands here.
      if (invoiceType === "B2C" && !isCancelCharge) {
        if (ag.cgstRate === 9) {
          b.accom18.taxable += ag.taxable;
          b.accom18.cgst    += ag.cgst;
          b.accom18.sgst    += ag.sgst;
        } else if (ag.cgstRate === 2.5) {
          b.accom5.taxable  += ag.taxable;
          b.accom5.cgst     += ag.cgst;
          b.accom5.sgst     += ag.sgst;
        } else {
          b.accomExmpt.taxable += ag.taxable;
        }
      }
      if (isCancelCharge) {
        b.cancel18.taxable += ag.taxable;
        b.cancel18.cgst    += ag.cgst;
        b.cancel18.sgst    += ag.sgst;
        b.cancel18.count   += 1;
      }
      // Water aggregates regardless of invoice_type — separate HSN sheet
      // covers it; B2B HSN values are duplicated in Table 12 by design.
      b.water5.mrp     += wg.mrp;
      b.water5.taxable += wg.taxable;
      b.water5.cgst    += wg.cgst;
      b.water5.sgst    += wg.sgst;
    });

    // ── Net B2C summary by B2C credit notes ──────────────────────────────────
    // CDNR (B2B) and B2C-CN are separately reported. Within the B2C summary
    // sheet we subtract B2C credit-note taxable values so the totals align
    // with the operator's actual GSTR-1 Table 7 row.
    let b2cCnTaxable5  = 0, b2cCnCgst5  = 0, b2cCnSgst5  = 0;
    let b2cCnTaxable18 = 0, b2cCnCgst18 = 0, b2cCnSgst18 = 0;
    creditNotes.forEach(cn => {
      const isB2B = !!(cn.recipient_gstin || "").trim();
      if (isB2B) return;
      const rate = parseInt(cn.gst_rate, 10) || 0;
      const tax  = parseFloat(cn.credit_amount_taxable || 0);
      const cgst = parseFloat(cn.credit_amount_cgst || 0);
      const sgst = parseFloat(cn.credit_amount_sgst || 0);
      if (rate === 18) { b2cCnTaxable18 += tax; b2cCnCgst18 += cgst; b2cCnSgst18 += sgst; }
      else if (rate === 5) { b2cCnTaxable5  += tax; b2cCnCgst5  += cgst; b2cCnSgst5  += sgst; }
    });

    // Sheet 1: Invoice Register
    const wsReg = XLSX.utils.json_to_sheet(regRows);

    // Sheet 2: B2B Invoices (GSTR-1 Table 4)
    const wsB2B = XLSX.utils.json_to_sheet(b2bRows.length ? b2bRows : [{
      "GSTIN/UIN of Recipient": "(none in this period)",
      "Receiver Name": "", "Invoice Number": "", "Invoice Date": "",
      "Invoice Value": 0, "Place Of Supply": "", "Reverse Charge": "",
      "Applicable % of Tax Rate": "", "Invoice Type": "",
      "E-Commerce GSTIN": "", "Rate": 0, "Taxable Value": 0, "Cess Amount": 0,
    }]);

    // Sheet 3: B2C Summary (with CN net-out)
    const b2cRows = [
      {
        "Description":           "Accommodation Services (SAC 9963) — 5% slab (B2C only)",
        "Place of Supply":       "Karnataka (KA-29)",
        "Applicable % of Tax":   "5%",
        "Integrated Tax Amount": 0,
        "Central Tax Amount":    r2(b.accom5.cgst - b2cCnCgst5),
        "State/UT Tax Amount":   r2(b.accom5.sgst - b2cCnSgst5),
        "Cess Amount":           0,
        "Total Taxable Value":   r2(b.accom5.taxable - b2cCnTaxable5),
        "Remarks":               "Net of B2C credit notes",
      },
      {
        "Description":           "Accommodation Services (SAC 9963) — 18% slab (B2C only)",
        "Place of Supply":       "Karnataka (KA-29)",
        "Applicable % of Tax":   "18%",
        "Integrated Tax Amount": 0,
        "Central Tax Amount":    r2(b.accom18.cgst - b2cCnCgst18),
        "State/UT Tax Amount":   r2(b.accom18.sgst - b2cCnSgst18),
        "Cess Amount":           0,
        "Total Taxable Value":   r2(b.accom18.taxable - b2cCnTaxable18),
        "Remarks":               "Net of B2C credit notes",
      },
      {
        "Description":           "Accommodation Services (SAC 9963) — Exempt (B2C only)",
        "Place of Supply":       "Karnataka (KA-29)",
        "Applicable % of Tax":   "0%",
        "Integrated Tax Amount": 0, "Central Tax Amount": 0,
        "State/UT Tax Amount":   0, "Cess Amount": 0,
        "Total Taxable Value":   r2(b.accomExmpt.taxable),
        "Remarks":               "Room charges below ₹1,000/night",
      },
      {
        "Description":           "Packaged Drinking Water (HSN 2201) — 5% slab",
        "Place of Supply":       "Karnataka (KA-29)",
        "Applicable % of Tax":   "5%",
        "Integrated Tax Amount": 0,
        "Central Tax Amount":    r2(b.water5.cgst),
        "State/UT Tax Amount":   r2(b.water5.sgst),
        "Cess Amount":           0,
        "Total Taxable Value":   r2(b.water5.taxable),
        "Remarks":               "MRP-inclusive; back-calculated taxable = MRP/1.05",
      },
      ...(b.cancel18.count > 0 ? [{
        "Description":           "Cancellation Forfeiture (SAC 999794) — 18%",
        "Place of Supply":       "Karnataka (KA-29)",
        "Applicable % of Tax":   "18%",
        "Integrated Tax Amount": 0,
        "Central Tax Amount":    r2(b.cancel18.cgst),
        "State/UT Tax Amount":   r2(b.cancel18.sgst),
        "Cess Amount":           0,
        "Total Taxable Value":   r2(b.cancel18.taxable),
        "Remarks":               "Agreement to refrain — Schedule II (count: " + b.cancel18.count + ")",
      }] : []),
    ];
    const allCgst = r2(b2cRows.reduce((s, r) => s + parseFloat(r["Central Tax Amount"] || 0), 0));
    const allSgst = r2(b2cRows.reduce((s, r) => s + parseFloat(r["State/UT Tax Amount"] || 0), 0));
    const allTaxbl = r2(b2cRows.reduce((s, r) => s + parseFloat(r["Total Taxable Value"] || 0), 0));
    b2cRows.push({
      "Description":           "TOTAL (B2C, net of CNs)",
      "Place of Supply":       "",
      "Applicable % of Tax":   "",
      "Integrated Tax Amount": 0,
      "Central Tax Amount":    allCgst,
      "State/UT Tax Amount":   allSgst,
      "Cess Amount":           0,
      "Total Taxable Value":   allTaxbl,
      "Remarks":               `Period: ${period}`,
    });
    const wsB2C = XLSX.utils.json_to_sheet(b2cRows);

    // Sheet 4: B2CL Invoices (GSTR-1 Table 5)
    const wsB2CL = XLSX.utils.json_to_sheet(b2clRows.length ? b2clRows : [{
      "Invoice Number": "(none in this period)",
      "Invoice Date":"", "Invoice Value":0, "Place Of Supply":"",
      "Applicable % of Tax Rate":"", "Rate":0, "Taxable Value":0,
      "Cess Amount":0, "E-Commerce GSTIN":"",
    }]);

    // Sheet 5: HSN/SAC Summary (Table 12)
    const water5TotalGst = r2(b.water5.cgst + b.water5.sgst);
    const accomTotalTax  = r2(b.accom5.taxable + b.accom18.taxable + b.accomExmpt.taxable);
    const accomTotalCgst = r2(b.accom5.cgst + b.accom18.cgst);
    const accomTotalSgst = r2(b.accom5.sgst + b.accom18.sgst);
    const hsnRows = [
      ...(b.cancel18.count > 0 ? [{
        "HSN/SAC Code":          "999794",
        "Description":           "Agreement to refrain (cancellation forfeiture)",
        "UQC":                   "NOS",
        "Total Quantity":        b.cancel18.count,
        "Total Value (MRP)":     r2(b.cancel18.taxable + b.cancel18.cgst + b.cancel18.sgst),
        "Taxable Value":         r2(b.cancel18.taxable),
        "IGST Amount":           0,
        "CGST Amount":           r2(b.cancel18.cgst),
        "SGST Amount":           r2(b.cancel18.sgst),
        "Total GST":             r2(b.cancel18.cgst + b.cancel18.sgst),
        "Applicable GST Rate":   "18% (inclusive)",
      }] : []),
      {
        "HSN/SAC Code":          "9963",
        "Description":           "Accommodation and Hospitality Services",
        "UQC":                   "NOS",
        "Total Quantity":        state.filteredEntries.length,
        "Total Value (MRP)":     r2(
          b.accom5.taxable  + b.accom5.cgst  + b.accom5.sgst  +
          b.accom18.taxable + b.accom18.cgst + b.accom18.sgst +
          b.accomExmpt.taxable
        ),
        "Taxable Value":         accomTotalTax,
        "IGST Amount":           0,
        "CGST Amount":           accomTotalCgst,
        "SGST Amount":           accomTotalSgst,
        "Total GST":             r2(parseFloat(accomTotalCgst) + parseFloat(accomTotalSgst)),
        "Applicable GST Rate":   "0% / 5% / 18% (slab based)",
      },
      {
        "HSN/SAC Code":          "2201",
        "Description":           "Packaged Drinking Water",
        "UQC":                   "NOS",
        "Total Quantity":        state.filteredEntries.reduce(
          (s, e) => s + waterGst(e.services || []).qty, 0,
        ),
        "Total Value (MRP)":     r2(b.water5.mrp || (b.water5.taxable + b.water5.cgst + b.water5.sgst)),
        "Taxable Value":         r2(b.water5.taxable),
        "IGST Amount":           0,
        "CGST Amount":           r2(b.water5.cgst),
        "SGST Amount":           r2(b.water5.sgst),
        "Total GST":             water5TotalGst,
        "Applicable GST Rate":   "5% (MRP inclusive)",
      },
    ];
    const wsHSN = XLSX.utils.json_to_sheet(hsnRows);

    // Sheet 6: CDNR (B2B Credit Notes — GSTR-1 Table 9B)
    const cdnrRows = creditNotes
      .filter(cn => (cn.recipient_gstin || "").trim() !== "")
      .map(cn => ({
        "GSTIN/UIN of Recipient":        cn.recipient_gstin || "",
        "Receiver Name":                 cn.recipient_legal_name || cn.guest_name || "",
        "CN/DN Number":                  cn.cn_number || "",
        "CN/DN Date":                    cn.cn_date || "",
        "Original Invoice Number":       cn.against_bill_number || "",
        "Original Invoice Date":         cn.against_invoice_date || "",
        "Document Type":                 "C",
        "Reason for Issuing Document":   _cnReasonGstr1(cn.reason),
        "Place of Supply":               "29-Karnataka",
        "CN/DN Value":                   r2(cn.credit_amount_total || 0),
        "Applicable % of Tax Rate":      "",
        "Rate":                          cn.gst_rate || 0,
        "Taxable Value":                 r2(cn.credit_amount_taxable || 0),
        "Cess Amount":                   0,
        "Pre-GST":                       "N",
      }));
    const wsCDNR = XLSX.utils.json_to_sheet(cdnrRows.length ? cdnrRows : [{
      "GSTIN/UIN of Recipient": "(none in this period)",
      "Receiver Name":"","CN/DN Number":"","CN/DN Date":"","Original Invoice Number":"",
      "Original Invoice Date":"","Document Type":"","Reason for Issuing Document":"",
      "Place of Supply":"","CN/DN Value":0,"Applicable % of Tax Rate":"",
      "Rate":0,"Taxable Value":0,"Cess Amount":0,"Pre-GST":"",
    }]);

    // Sheet 7: B2C Credit Notes (against unregistered customers)
    const b2cCnRows = creditNotes
      .filter(cn => !(cn.recipient_gstin || "").trim())
      .map(cn => ({
        "CN Number":                  cn.cn_number || "",
        "CN Date":                    cn.cn_date || "",
        "Original Invoice Number":    cn.against_bill_number || "",
        "Original Invoice Date":      cn.against_invoice_date || "",
        "Reason":                     _cnReasonGstr1(cn.reason),
        "Reason Narrative":           cn.reason_text || "",
        "Place of Supply":            "29-Karnataka",
        "CN Value":                   r2(cn.credit_amount_total || 0),
        "Rate":                       cn.gst_rate || 0,
        "Taxable Value":              r2(cn.credit_amount_taxable || 0),
        "CGST":                       r2(cn.credit_amount_cgst || 0),
        "SGST":                       r2(cn.credit_amount_sgst || 0),
        "Guest Name":                 cn.guest_name || "",
        "Room":                       cn.room || "",
      }));
    const wsB2CCN = XLSX.utils.json_to_sheet(b2cCnRows.length ? b2cCnRows : [{
      "CN Number": "(none in this period)",
      "CN Date":"","Original Invoice Number":"","Original Invoice Date":"",
      "Reason":"","Reason Narrative":"","Place of Supply":"","CN Value":0,
      "Rate":0,"Taxable Value":0,"CGST":0,"SGST":0,"Guest Name":"","Room":"",
    }]);

    // Sheet 8: GSTR-3B Summary (output tax / ITC / RCM / net cash)
    // ITC and RCM are NOT computed here — the operator's CA will fill them
    // from expenses with vendor_gstin. We surface output tax + a placeholder
    // for ITC/RCM with a clear UNCERTAINTY note.
    const totalOutputCgst = r2(allCgst);
    const totalOutputSgst = r2(allSgst);
    // B2B and B2CL output tax also flows into 3B — combine them.
    const b2bOutputCgst = r2(b2bRows.reduce((s, r) => s + parseFloat(r["Taxable Value"]||0) * (parseFloat(r["Rate"]||0)/200), 0));
    const b2bOutputSgst = b2bOutputCgst;
    const totalCnCgst = r2(creditNotes.reduce((s, cn) => s + parseFloat(cn.credit_amount_cgst || 0), 0));
    const totalCnSgst = r2(creditNotes.reduce((s, cn) => s + parseFloat(cn.credit_amount_sgst || 0), 0));
    const gstr3b = [
      { "Item": "Outward taxable supplies (B2C, accommodation+water)",
        "Taxable Value": allTaxbl, "CGST": totalOutputCgst, "SGST": totalOutputSgst, "IGST": 0, "Cess": 0 },
      { "Item": "Outward taxable supplies (B2B, accommodation)",
        "Taxable Value": r2(b2bRows.reduce((s, r) => s + parseFloat(r["Taxable Value"]||0), 0)),
        "CGST": b2bOutputCgst, "SGST": b2bOutputSgst, "IGST": 0, "Cess": 0 },
      { "Item": "(less) Credit Notes issued (CDNR + B2C-CN)",
        "Taxable Value": r2(creditNotes.reduce((s, cn) => s + parseFloat(cn.credit_amount_taxable || 0), 0)),
        "CGST": totalCnCgst, "SGST": totalCnSgst, "IGST": 0, "Cess": 0 },
      { "Item": "Net output tax (after CN reversal)",
        "Taxable Value": "(see CA reconciliation)",
        "CGST": r2(parseFloat(totalOutputCgst) + parseFloat(b2bOutputCgst) - parseFloat(totalCnCgst)),
        "SGST": r2(parseFloat(totalOutputSgst) + parseFloat(b2bOutputSgst) - parseFloat(totalCnSgst)),
        "IGST": 0, "Cess": 0 },
      { "Item": "Eligible ITC from expenses (NOT auto-computed — CA to fill)",
        "Taxable Value": "—", "CGST": "—", "SGST": "—", "IGST": "—", "Cess": "—" },
      { "Item": "RCM liability on OTA commission (NOT auto-computed — see migration doc)",
        "Taxable Value": "—", "CGST": "—", "SGST": "—", "IGST": "—", "Cess": "—" },
      { "Item": "Net cash payable",
        "Taxable Value": "(net output - ITC + RCM)",
        "CGST": "—", "SGST": "—", "IGST": "—", "Cess": "—" },
    ];
    const wsGSTR3B = XLSX.utils.json_to_sheet(gstr3b);

    // ── Advances (GSTR-1 Table 11A "received" / 11B "adjusted") ────────────
    const advRows = (advances || []).map(a => ({
      "Status":            a.status || "",          // Received / Adjusted
      "Date":              a.date || "",
      "Booking ID":        a.booking_id || "",
      "Guest Name":        a.guest_name || "",
      "Room":              a.room || "",
      "Check-in Date":     a.check_in_date || "",
      "Bill Number":       a.bill_number || "",
      "Place Of Supply":   "29-Karnataka",
      "Rate":              a.gst_rate || 0,
      "Gross Amount":      a.amount || 0,
      "Taxable Value":     r2(a.taxable || 0),
      "CGST":              r2(a.cgst || 0),
      "SGST":              r2(a.sgst || 0),
      "IGST":              0,
      "Method":            a.method || "",
    }));
    const wsAdvances = XLSX.utils.json_to_sheet(advRows.length ? advRows : [{
      "Status": "(none in this period)",
      "Date": "", "Booking ID": "", "Guest Name": "", "Room": "",
      "Check-in Date": "", "Bill Number": "", "Place Of Supply": "",
      "Rate": 0, "Gross Amount": 0, "Taxable Value": 0,
      "CGST": 0, "SGST": 0, "IGST": 0, "Method": "",
    }]);

    // ── Expenses (ITC) — purchases carrying GST in the period ─────────────────
    // Lists ONLY expenses flagged with GST, each with its full tax breakdown
    // and a clickable link to the uploaded bill, so a CA can claim input tax
    // credit in GSTR-3B. CGST/SGST vs IGST is inferred from the vendor GSTIN's
    // state code (29 = Karnataka, the hotel's home state → intra-state
    // CGST/SGST; any other state → IGST). No GSTIN on file → assume intra-state.
    const _isIntraState = (gstin) => {
      const code = String(gstin || "").trim().slice(0, 2);
      return code === "" || code === "29";
    };
    const itcRows = (gstExpenses || []).map((e, i) => {
      // booking.com commission stores its GST under separate fields; fall back.
      const taxable = r2(
        e.taxable_amount != null ? e.taxable_amount
          : (e.commission_amount != null ? e.commission_amount : 0),
      );
      const gstTotal = r2(
        (e.gst_amount != null && e.gst_amount > 0) ? e.gst_amount
          : (e.commission_gst || 0),
      );
      const intra = _isIntraState(e.vendor_gstin);
      const cgst = intra ? r2(gstTotal / 2) : 0;
      const sgst = intra ? r2(gstTotal / 2) : 0;
      const igst = intra ? 0 : gstTotal;
      return {
        "Sr No":           i + 1,
        "Date":            e.date || "",
        "Category":        e.category || "",
        "Description":     e.description || "",
        "Vendor Name":     e.vendor_name || e.commission_platform || "",
        "Vendor GSTIN":    e.vendor_gstin || "",
        "Invoice No":      e.invoice_number || e.commission_invoice_number || "",
        "Invoice Date":    e.invoice_date || e.commission_invoice_date || "",
        "Place Of Supply": intra ? "29-Karnataka" : "Other State",
        "Taxable Value":   taxable,
        "GST Rate %":      e.gst_rate || 0,
        "CGST":            cgst,
        "SGST":            sgst,
        "IGST":            igst,
        "GST Total":       r2(cgst + sgst + igst),
        // Gross is the FULL invoice value. For a split-paid invoice that is
        // split_total (each leg only holds a partial payment amount);
        // otherwise the expense amount, falling back to taxable + GST.
        "Gross Amount":    r2(
          (e.split_total != null && e.split_total > 0) ? e.split_total
            : (e.amount != null ? e.amount : taxable + gstTotal)
        ),
        "Payment Method":  e.split_group_id ? "Split" : (e.payment_method || ""),
        "Bill Link":       e.invoice_photo_url || "",
      };
    });
    const wsITC = XLSX.utils.json_to_sheet(itcRows.length ? itcRows : [{
      "Sr No": "(no GST expenses in this period)",
      "Date": "", "Category": "", "Description": "", "Vendor Name": "",
      "Vendor GSTIN": "", "Invoice No": "", "Invoice Date": "", "Place Of Supply": "",
      "Taxable Value": 0, "GST Rate %": 0, "CGST": 0, "SGST": 0, "IGST": 0,
      "GST Total": 0, "Gross Amount": 0, "Payment Method": "", "Bill Link": "",
    }]);
    // Turn the "Bill Link" column into real, clickable hyperlinks.
    if (itcRows.length) {
      const linkCol = Object.keys(itcRows[0]).indexOf("Bill Link");
      for (let row = 0; row < itcRows.length; row++) {
        const url = itcRows[row]["Bill Link"];
        if (!url) continue;
        const addr = XLSX.utils.encode_cell({ r: row + 1, c: linkCol }); // +1 = header row
        const cell = wsITC[addr];
        if (cell) {
          cell.l = { Target: url, Tooltip: "Open bill" };
          cell.v = "View Bill";
        }
      }
    }

    // Hidden _schema sheet — record the GSTN schema version used.
    const schemaSheet = XLSX.utils.json_to_sheet([
      { "Field": "GSTN_GSTR1_SCHEMA_VERSION", "Value": "2.1 (offline utility 4.x format)" },
      { "Field": "Generated By",              "Value": "Cibara Comforts Lodge Mgmt" },
      { "Field": "Generated At",              "Value": new Date().toISOString() },
      { "Field": "Period",                    "Value": period },
      { "Field": "B2CL Threshold",            "Value": "₹1,00,000 (Notification 12/2024-CT)" },
      { "Field": "Place of Supply",           "Value": "Always Karnataka (KA-29) for SAC 9963" },
      { "Field": "Advances Table",            "Value": "Table 11A/B — cross-month advances only; same-month advances net out and are excluded" },
      { "Field": "Cancellation Charges SAC",   "Value": "999794 (agreement to refrain) @ 18% — appears in HSN sheet alongside 9963 / 2201 once issued" },
      { "Field": "Notes",                     "Value": "Input tax credit is itemised in the 'Expenses (ITC)' sheet (GST-bearing expenses with vendor GSTIN, tax split and bill link). RCM rows in GSTR-3B remain CA-reviewed." },
      { "Field": "ITC Sheet",                 "Value": "Expenses (ITC) — CGST/SGST vs IGST inferred from vendor GSTIN state (29=KA intra-state; else IGST). 'Bill Link' opens the uploaded invoice." },
    ]);
    schemaSheet["!hidden"] = true;

    try {
      // ── Sheet: Documents Issued (GSTR-1 Table 13) ──────────────────────
      // Mandatory since the May-2025 return period: for every document
      // series used in the period — serial range, total issued, cancelled
      // count, net issued. Series are grouped by prefix (CC/YYYY/MM for tax
      // invoices incl. cancellation-charge bills, CN/YYYY/MM for credit
      // notes). Cancelled documents are the zero-value "CANCELLED" rows of
      // the Invoice Register (numbers consumed, no output tax).
      function buildDocSeriesRows() {
        const series = {};
        const fold = (numStr, cancelled, nature) => {
          const m = /^([A-Z]+\/\d{4}\/\d{2})\/(\d+)$/.exec((numStr || "").trim());
          if (!m) return;
          const key = m[1];
          const n = parseInt(m[2], 10);
          if (!series[key]) {
            series[key] = { nature, prefix: key, min: n, max: n, listed: 0, cancelled: 0 };
          }
          const s = series[key];
          s.min = Math.min(s.min, n);
          s.max = Math.max(s.max, n);
          s.listed++;
          if (cancelled) s.cancelled++;
        };
        regRows.forEach((r) => {
          const bn = r["Bill No"];
          if (bn && bn !== "-") {
            fold(bn, r["Reverted"] === "CANCELLED", "Invoices for outward supply");
          }
        });
        creditNotes.forEach((cn) => fold(cn.cn_number, false, "Credit Note"));
        const pad = (k, n) => `${k}/${String(n).padStart(5, "0")}`;
        const rows = Object.values(series)
          .sort((a, b) => a.prefix.localeCompare(b.prefix))
          .map((s) => {
            const rangeTotal = s.max - s.min + 1;
            return {
              "Nature of Document": s.nature,
              "Sr No From":         pad(s.prefix, s.min),
              "Sr No To":           pad(s.prefix, s.max),
              "Total Number":       rangeTotal,
              "Cancelled":          s.cancelled,
              "Net Issued":         rangeTotal - s.cancelled,
              "Listed in Workbook": s.listed,
              "Remarks":
                s.listed === rangeTotal
                  ? ""
                  : "GAP: workbook lists fewer documents than the serial " +
                    "range — investigate missing numbers before filing",
            };
          });
        return rows.length
          ? rows
          : [{
              "Nature of Document": "(none in this period)",
              "Sr No From": "", "Sr No To": "", "Total Number": 0,
              "Cancelled": 0, "Net Issued": 0, "Listed in Workbook": 0,
              "Remarks": "",
            }];
      }
      const wsDocs = XLSX.utils.json_to_sheet(buildDocSeriesRows());

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, wsReg,    "Invoice Register");
      XLSX.utils.book_append_sheet(wb, wsB2B,    "B2B Invoices");
      XLSX.utils.book_append_sheet(wb, wsB2C,    "B2C Summary");
      XLSX.utils.book_append_sheet(wb, wsB2CL,   "B2CL Invoices");
      XLSX.utils.book_append_sheet(wb, wsHSN,    "HSN SAC Summary");
      XLSX.utils.book_append_sheet(wb, wsDocs,   "Docs Issued (Table 13)");
      XLSX.utils.book_append_sheet(wb, wsCDNR,   "CDNR (B2B CNs)");
      XLSX.utils.book_append_sheet(wb, wsB2CCN,  "B2C Credit Notes");
      XLSX.utils.book_append_sheet(wb, wsAdvances, "Advances (Table 11)");
      XLSX.utils.book_append_sheet(wb, wsITC,     "Expenses (ITC)");
      XLSX.utils.book_append_sheet(wb, wsGSTR3B, "GSTR-3B Summary");
      XLSX.utils.book_append_sheet(wb, schemaSheet, "_schema");
      // Mark hidden sheet so Excel respects it.
      if (wb.Workbook && wb.Workbook.Sheets) {
        const idx = wb.SheetNames.indexOf("_schema");
        if (idx >= 0 && wb.Workbook.Sheets[idx]) {
          wb.Workbook.Sheets[idx].Hidden = 1;
        }
      }
      XLSX.writeFile(
        wb,
        `CIBARA_GSTR1_Workbook_${state.dateRange.start}_to_${state.dateRange.end}.xlsx`,
      );
    } catch (err) {
      console.error("[Bills] export error:", err);
      alert("Export failed: " + err.message);
    }
  }

  // GSTR-1 Table 9B "Reason for Issuing Document" enum mapping.
  function _cnReasonGstr1(reason) {
    const map = {
      "checkout_mistake":     "04-Correction in Invoice",
      "post_supply_discount": "02-Post Sale Discount",
      "service_deficiency":   "03-Deficiency in services",
      "cancellation":         "01-Sales Return",
      "other":                "07-Others",
    };
    return map[reason] || "07-Others";
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

  // ── Live patch from remote events (no refetch) ────────────────────────────
  // Every backend mutation that affects the Bills view writes to the `bills`
  // Firestore collection, which fires `cibaraBillChanged` with the full bill
  // document attached. We patch `state.allEntries` in place — no network call.
  //
  // `cibaraRoomUpdate` and `cibaraPaymentAdded` are intentionally NOT listened
  // to here: they are upstream of bill changes, and any effect on a bill is
  // already reflected by a follow-up `bills_ref.update(...)` on the backend.
  // Listening to them caused unnecessary full reloads on every room/payment
  // event, even when nothing visible to this tab had changed.

  function _bvDateInRange(dateStr) {
    if (!dateStr) return false;
    const { start, end } = state.dateRange;
    if (!start || !end) return false;
    return dateStr >= start && dateStr <= end;
  }

  // Surgically replace one row in the rendered table. Falls back to a quiet
  // applyFilters() re-render if the target row isn't found (e.g. filters
  // hid it, or the row hasn't been rendered yet).
  function _bvReplaceRowInDOM(updated) {
    const tbody = dom("bl-table-body");
    if (!tbody) return false;
    const tr = tbody.querySelector(`tr[data-entry-id="${updated.id}"]`);
    if (!tr) return false;

    // Re-derive the visible row index so rowIndex passed to rowHTML stays
    // in sync with the rendered numbering.
    const visibleIdx = state.filteredEntries.findIndex(e => e.id === updated.id);
    const rowIndex = visibleIdx >= 0 ? visibleIdx + 1 : 1;
    const dk = (updated.checkin_time || "").split(" ")[0] || "unknown";

    const tmp = document.createElement("tbody");
    tmp.innerHTML = rowHTML(updated, dk, rowIndex);
    const newRow = tmp.querySelector("tr");
    if (!newRow) return false;

    tr.replaceWith(newRow);

    // Brief highlight so the user can spot the changed row.
    newRow.style.transition = "none";
    newRow.style.backgroundColor = "#fffbcc";
    requestAnimationFrame(() => {
      newRow.style.transition = "background-color 0.8s ease";
      newRow.style.backgroundColor = "";
    });
    return true;
  }

  function _patchBillFromEvent(bill) {
    if (!bill || !bill.id) return;

    // Only patch if the bill's checkout (or check-in, for pending_settlement
    // entries that have no checkout yet) falls inside the visible date range.
    const checkoutDate = (bill.checkout_time || "").split(" ")[0];
    const checkinDate  = (bill.checkin_time  || "").split(" ")[0];
    if (!_bvDateInRange(checkoutDate) && !_bvDateInRange(checkinDate)) return;

    const idx = state.allEntries.findIndex(e => e.id === bill.id);
    const isModified = idx >= 0;

    if (isModified) {
      // Skip no-op events (Firestore can deliver duplicate snapshots).
      if (JSON.stringify(state.allEntries[idx]) === JSON.stringify(bill)) return;
      state.allEntries[idx] = bill;
    } else {
      state.allEntries.push(bill);
    }

    // Re-run the visibility filter so `state.filteredEntries` reflects the
    // change. This is in-memory only and cheap.
    applyFilters();

    // applyFilters() already re-renders the table. For a modified entry we
    // could have done a surgical row replace before applyFilters() ran, but
    // applyFilters() has rebuilt the DOM by now. The visual cost is one
    // table re-render per remote event — acceptable, no network call.
    void _bvReplaceRowInDOM; // kept for future surgical-update use
  }

  window.addEventListener("cibaraBillChanged", (e) => {
    // Only act when the tab is visible — patching a hidden tab is wasted work.
    // When the user re-opens the tab, the MutationObserver fires loadData(false)
    // which renders from `state.allEntries` (already up to date) and skips the
    // network call because `lastLoadedRange` is still the cached range.
    const tab = dom("bills-tab");
    if (!tab || tab.classList.contains("hidden")) {
      // Still patch state silently so the tab is fresh on next open.
      _patchBillFromEvent(e.detail);
      return;
    }
    _patchBillFromEvent(e.detail);
  });

  // ── Init ─────────────────────────────────────────────────────────────────
  // Two-phase boot. Phase 1 injects styles immediately so any modal markup
  // in this module is hidden by default (otherwise the bill modal flashes
  // visible on first load). Phase 2 waits for the auth layer to resolve
  // before building the role-aware layout.
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

  // ─── GST recipient modal wiring (Goal 1) ──────────────────────────────────
  function _gstClientChecksum(g) {
    // Format check only — full GSTN checksum is non-trivial. Backend re-validates.
    return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[0-9A-Z]{1}Z[0-9A-Z]{1}$/.test((g||"").toUpperCase());
  }
  const _STATE_FROM_CODE = {
    "01":"Jammu and Kashmir","02":"Himachal Pradesh","03":"Punjab","04":"Chandigarh",
    "05":"Uttarakhand","06":"Haryana","07":"Delhi","08":"Rajasthan","09":"Uttar Pradesh",
    "10":"Bihar","11":"Sikkim","12":"Arunachal Pradesh","13":"Nagaland","14":"Manipur",
    "15":"Mizoram","16":"Tripura","17":"Meghalaya","18":"Assam","19":"West Bengal",
    "20":"Jharkhand","21":"Odisha","22":"Chhattisgarh","23":"Madhya Pradesh","24":"Gujarat",
    "27":"Maharashtra","29":"Karnataka","30":"Goa","32":"Kerala","33":"Tamil Nadu",
    "36":"Telangana","37":"Andhra Pradesh","38":"Ladakh"
  };

  function openGstModal(billId, billNumber, locked) {
    const e = state.allEntries.find(x => x.id === billId);
    const bd = dom("bl-gst-backdrop");
    const billnoEl = dom("bl-gst-billno");
    const gstinEl  = dom("bl-gst-gstin");
    const legalEl  = dom("bl-gst-legal");
    const tradeEl  = dom("bl-gst-trade");
    const addrEl   = dom("bl-gst-addr");
    const errEl    = dom("bl-gst-error");
    const stateEl  = dom("bl-gst-state-hint");
    const ruleEl   = dom("bl-gst-rule46");
    const saveBtn  = dom("bl-gst-save");
    const clearBtn = dom("bl-gst-clear");
    const chipEl   = dom("bl-gst-state-chip");
    if (!bd) return;

    if (billnoEl) billnoEl.textContent = billNumber || "—";
    if (gstinEl)  gstinEl.value = (e && e.recipient_gstin) || "";
    if (legalEl)  legalEl.value = (e && e.recipient_legal_name) || "";
    if (tradeEl)  tradeEl.value = (e && e.recipient_trade_name) || "";
    if (addrEl)   addrEl.value  = (e && e.recipient_address) || "";
    if (errEl)    errEl.textContent = "";
    if (ruleEl)   ruleEl.style.display = "none";
    if (stateEl)  stateEl.textContent = "15 characters · 2-digit state code · 10-char PAN · entity number · checksum";
    if (stateEl)  stateEl.classList.remove("ok", "bad");

    // State chip — current invoice type
    if (chipEl) {
      chipEl.classList.remove("bl-gst-state-b2c", "bl-gst-state-b2b", "bl-gst-state-locked");
      if (locked) {
        chipEl.classList.add("bl-gst-state-locked");
        chipEl.textContent = "Locked";
      } else if (e && e.invoice_type === "B2B") {
        chipEl.classList.add("bl-gst-state-b2b");
        chipEl.textContent = "B2B";
      } else {
        chipEl.classList.add("bl-gst-state-b2c");
        chipEl.textContent = "B2C";
      }
    }

    if (locked) {
      [gstinEl, legalEl, tradeEl, addrEl].forEach(el => { if (el) el.disabled = true; });
      if (saveBtn)  saveBtn.disabled = true;
      if (clearBtn) clearBtn.disabled = true;
      if (errEl) errEl.textContent = "This bill has a credit note linked — GST details are locked. Issue a fresh invoice if recipient details need to change.";
    } else {
      [gstinEl, legalEl, tradeEl, addrEl].forEach(el => { if (el) el.disabled = false; });
      if (saveBtn)  saveBtn.disabled = false;
      if (clearBtn) clearBtn.disabled = false;
      if (saveBtn)  saveBtn.textContent = (e && e.invoice_type === "B2B") ? "Update B2B" : "Save as B2B";
    }

    state._gstModal = { billId, billNumber };
    bd.classList.add("open");
    if (gstinEl) gstinEl.focus();
    _gstUpdateDerived();
  }

  function closeGstModal() {
    const bd = dom("bl-gst-backdrop");
    if (bd) bd.classList.remove("open");
  }

  function _gstUpdateDerived() {
    const gstinEl = dom("bl-gst-gstin");
    const stateEl = dom("bl-gst-state-hint");
    const ruleEl  = dom("bl-gst-rule46");
    const addrEl  = dom("bl-gst-addr");
    if (!gstinEl) return;
    const v = (gstinEl.value || "").toUpperCase().trim();
    gstinEl.classList.remove("bl-gst-invalid", "bl-gst-valid");
    if (stateEl) stateEl.classList.remove("ok", "bad");
    if (!v) {
      if (stateEl) stateEl.textContent = "15 characters · 2-digit state code · 10-char PAN · entity number · checksum";
      if (ruleEl)  ruleEl.style.display = "none";
      return;
    }
    const valid = _gstClientChecksum(v);
    if (!valid) {
      gstinEl.classList.add("bl-gst-invalid");
      if (stateEl) {
        stateEl.classList.add("bad");
        stateEl.textContent = "Invalid format — expected 15 chars (Rule 46(b))";
      }
      if (ruleEl)  ruleEl.style.display = "none";
      return;
    }
    gstinEl.classList.add("bl-gst-valid");
    const code = v.slice(0, 2);
    const stName = _STATE_FROM_CODE[code] || "Unknown state";
    if (stateEl) {
      stateEl.classList.add("ok");
      stateEl.textContent = `Recipient state: ${stName} (${code})`;
    }
    if (ruleEl)  ruleEl.style.display = (addrEl && !addrEl.value.trim()) ? "flex" : "none";
  }

  async function saveBillGst() {
    const ctx = state._gstModal || {};
    const gstinEl = dom("bl-gst-gstin");
    const legalEl = dom("bl-gst-legal");
    const tradeEl = dom("bl-gst-trade");
    const addrEl  = dom("bl-gst-addr");
    const errEl   = dom("bl-gst-error");
    const saveBtn = dom("bl-gst-save");
    if (!ctx.billId) return;
    const gstin = (gstinEl?.value || "").toUpperCase().trim();
    const legal = (legalEl?.value || "").trim();
    if (errEl) errEl.textContent = "";
    if (!gstin) { if (errEl) errEl.textContent = "GSTIN is required"; return; }
    if (!_gstClientChecksum(gstin)) {
      if (errEl) errEl.textContent = "Invalid GSTIN format (15 chars, see Rule 46(b)).";
      return;
    }
    if (!legal) { if (errEl) errEl.textContent = "Legal Name is required"; return; }

    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving…"; }
    try {
      const res = await apiFetch("/update_bill_gst", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bill_id: ctx.billId,
          recipient_gstin: gstin,
          recipient_legal_name: legal,
          recipient_trade_name: (tradeEl?.value || "").trim(),
          recipient_address: (addrEl?.value || "").trim(),
        }),
      });
      const data = await res.json();
      if (data.success) {
        closeGstModal();
        if (window.showNotification) showNotification(data.message, "success");
        loadData(true);
      } else {
        if (errEl) errEl.textContent = data.message || "Save failed";
      }
    } catch (err) {
      if (errEl) errEl.textContent = "Network error: " + err.message;
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save"; }
    }
  }

  async function clearBillGst() {
    const ctx = state._gstModal || {};
    const errEl = dom("bl-gst-error");
    const clearBtn = dom("bl-gst-clear");
    if (!ctx.billId) return;
    if (!confirm("Clear all B2B GST details and revert this invoice to B2C?")) return;
    if (clearBtn) { clearBtn.disabled = true; clearBtn.textContent = "Clearing…"; }
    try {
      const res = await apiFetch("/update_bill_gst", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bill_id: ctx.billId, clear: true }),
      });
      const data = await res.json();
      if (data.success) {
        closeGstModal();
        if (window.showNotification) showNotification("GST details cleared", "success");
        loadData(true);
      } else {
        if (errEl) errEl.textContent = data.message || "Clear failed";
      }
    } catch (err) {
      if (errEl) errEl.textContent = "Network error: " + err.message;
    } finally {
      if (clearBtn) { clearBtn.disabled = false; clearBtn.textContent = "Clear (revert to B2C)"; }
    }
  }

  // ─── Sub-tab toggle (Bills / Credit Notes) ─────────────────────────────────
  function _setSubTab(which) {
    const bills  = dom("bl-bills-pane");
    const cn     = dom("bl-cn-pane");
    const btnB   = dom("bl-subtab-bills");
    const btnC   = dom("bl-subtab-cn");
    const wrap   = document.querySelector(".bills-container");
    if (!bills || !cn) return;
    if (which === "cn") {
      bills.style.display = "none";
      cn.style.display    = "";
      if (btnB) { btnB.classList.remove("active"); btnB.setAttribute("aria-selected","false"); }
      if (btnC) { btnC.classList.add("active");    btnC.setAttribute("aria-selected","true");  }
      if (wrap) wrap.classList.add("cn-active");
      loadCreditNotes();
    } else {
      bills.style.display = "";
      cn.style.display    = "none";
      if (btnC) { btnC.classList.remove("active"); btnC.setAttribute("aria-selected","false"); }
      if (btnB) { btnB.classList.add("active");    btnB.setAttribute("aria-selected","true");  }
      if (wrap) wrap.classList.remove("cn-active");
    }
  }

  // Credit-note state (cached so filters re-render without re-fetch).
  state._cnList = [];
  state._cnFilter = "all";

  async function loadCreditNotes() {
    const tbody = dom("bl-cn-tbody");
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="7" class="bl-cn-empty"><span class="bl-cn-empty-icon"><i class="fas fa-spinner fa-spin"></i></span><div class="bl-cn-empty-text">Loading credit notes…</div></td></tr>';
    try {
      const res = await apiFetch("/list_credit_notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start_date: state.dateRange.start,
          end_date:   state.dateRange.end,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        tbody.innerHTML = `<tr><td colspan="7" class="bl-cn-empty"><span class="bl-cn-empty-icon"><i class="fas fa-exclamation-circle"></i></span><div class="bl-cn-empty-text">Error: ${data.message || "load failed"}</div></td></tr>`;
        return;
      }
      state._cnList = data.credit_notes || [];
      _renderCreditNotes();
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="7" class="bl-cn-empty"><span class="bl-cn-empty-icon"><i class="fas fa-exclamation-circle"></i></span><div class="bl-cn-empty-text">Network error: ${err.message}</div></td></tr>`;
    }
  }

  function _renderCreditNotes() {
    const tbody = dom("bl-cn-tbody");
    if (!tbody) return;
    const list = state._cnList || [];

    // Stats — based on full unfiltered list.
    const totalAmt = list.reduce((s, c) => s + parseFloat(c.credit_amount_total || 0), 0);
    const b2bCount = list.filter(c => (c.recipient_gstin || "").trim() !== "").length;
    const b2cCount = list.length - b2bCount;
    const setText = (id, v) => { const el = dom(id); if (el) el.textContent = v; };
    setText("bl-cn-stat-total", list.length);
    setText("bl-cn-stat-amt",   "₹" + inr(Math.round(totalAmt)));
    setText("bl-cn-stat-b2b",   b2bCount);
    setText("bl-cn-stat-b2c",   b2cCount);
    const subTabCn = dom("bl-subtab-count-cn");
    if (subTabCn) subTabCn.textContent = list.length;

    // Filter
    const f = state._cnFilter || "all";
    const filtered = list.filter(c => {
      if (f === "all") return true;
      if (f === "b2b") return (c.recipient_gstin || "").trim() !== "";
      if (f === "b2c") return !(c.recipient_gstin || "").trim();
      return c.reason === f;
    });

    if (!filtered.length) {
      const msg = list.length
        ? "No credit notes match this filter in the selected period."
        : "No credit notes issued in this period.";
      tbody.innerHTML = `<tr><td colspan="7" class="bl-cn-empty">
        <span class="bl-cn-empty-icon"><i class="far fa-file-alt"></i></span>
        <div class="bl-cn-empty-text">${msg}</div>
      </td></tr>`;
      return;
    }

    const reasonMeta = {
      "checkout_mistake":     { label: "Checkout reverted",   cls: "bl-cn-reason-revert"     },
      "post_supply_discount": { label: "Post-supply discount", cls: "bl-cn-reason-discount"  },
      "cancellation":         { label: "Cancellation",        cls: "bl-cn-reason-cancel"     },
      "service_deficiency":   { label: "Service deficiency",  cls: "bl-cn-reason-deficiency" },
      "other":                { label: "Other",               cls: "bl-cn-reason-other"      },
    };

    tbody.innerHTML = filtered.map(cn => {
      const isB2B = !!(cn.recipient_gstin || "").trim();
      const recipientName = cn.recipient_legal_name || cn.guest_name || "—";
      const recipientCell = isB2B
        ? `<div class="bl-cn-recipient-b2b">
             <span>${recipientName}</span>
             <span class="bl-cn-tag-b2b">B2B</span>
           </div>
           <div style="font-family:ui-monospace,monospace;font-size:.7rem;color:#64748b;margin-top:.1rem;">${cn.recipient_gstin}</div>`
        : `<div>${recipientName}</div>
           <div style="font-size:.7rem;color:#94a3b8;margin-top:.1rem;">Unregistered (B2C)</div>`;

      const meta = reasonMeta[cn.reason] || { label: cn.reason || "—", cls: "bl-cn-reason-other" };
      const reasonCell = `<span class="bl-cn-reason-badge ${meta.cls}">${meta.label}</span>`;

      const pdfCell = cn.pdf_url
        ? `<a class="bl-cn-pdf-link" href="${cn.pdf_url}" target="_blank" rel="noopener">
             <i class="fas fa-file-pdf"></i> View
           </a>`
        : `<button class="bl-cn-pdf-btn" data-cnid="${cn.cn_id}" title="Generate PDF">
             <i class="fas fa-file-pdf"></i> Generate
           </button>`;
      // WhatsApp send — always visible when a mobile is on file. When the
      // PDF doesn't exist yet, the button shows a "pending" state and
      // clicking it generates the PDF first, then opens the send modal.
      const _cnMob = (cn.guest_mobile || "").replace(/\D/g, "").slice(-10);
      const _hasPdf = !!cn.pdf_url;
      const waCell = _cnMob
        ? `<button class="bl-cn-wa-btn ${_hasPdf ? '' : 'bl-cn-wa-pending'}"
                   data-cnid="${cn.cn_id}"
                   data-pdfurl="${cn.pdf_url || ''}"
                   data-guest="${(cn.guest_name || cn.recipient_legal_name || '').replace(/"/g, '&quot;')}"
                   data-mobile="${_cnMob}"
                   data-cnno="${cn.cn_number || ''}"
                   data-amount="${cn.credit_amount_total || 0}"
                   title="${_hasPdf ? 'Send credit note via WhatsApp' : 'Generate PDF + send via WhatsApp'}">
             <i class="fab fa-whatsapp"></i>
           </button>`
        : '';

      return `<tr>
        <td><div class="bl-cn-num">${cn.cn_number || "—"}</div>
            <div style="font-size:.66rem;color:#94a3b8;margin-top:.1rem;">@ ${cn.gst_rate || 0}% GST</div></td>
        <td>${cn.cn_date || "—"}</td>
        <td><div class="bl-cn-against">${cn.against_bill_number || "—"}</div>
            <div style="font-size:.66rem;color:#94a3b8;margin-top:.1rem;">${cn.against_invoice_date || ""}</div></td>
        <td>${recipientCell}</td>
        <td>${reasonCell}
            ${cn.reason_text ? `<div style="font-size:.66rem;color:#94a3b8;margin-top:.15rem;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${cn.reason_text.replace(/"/g,'&quot;')}">${cn.reason_text}</div>` : ""}</td>
        <td class="bl-cn-amt">- ₹${inr(cn.credit_amount_total || 0)}</td>
        <td>
          <div style="display:flex;gap:.3rem;align-items:center;flex-wrap:nowrap;">
            ${pdfCell}
            ${waCell}
          </div>
        </td>
      </tr>`;
    }).join("");
  }

  // Open the existing WhatsApp send modal with a CN-specific message body.
  // If the CN has no PDF yet, generate it first (background fetch), then
  // open the modal. This mirrors the bill-row "WhatsApp pending" flow.
  async function _openCnWhatsAppModal(btn) {
    const cnId  = btn.dataset.cnid  || "";
    const cnNo  = btn.dataset.cnno  || "";
    let   url   = btn.dataset.pdfurl || "";
    const guest = btn.dataset.guest || "Guest";
    const mob   = (btn.dataset.mobile || "").replace(/\D/g, "").slice(-10);
    const amt   = btn.dataset.amount || 0;

    if (!/^\d{10}$/.test(mob)) {
      alert("Recipient has no valid 10-digit mobile number on file.");
      return;
    }

    // PDF missing — generate first, then continue.
    if (!url) {
      if (!confirm("PDF not yet generated for this credit note. Generate and share now?")) {
        return;
      }
      btn.disabled = true;
      const _origHtml = btn.innerHTML;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
      try {
        const res = await apiFetch("/render_credit_note_pdf", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cn_id: cnId }),
        });
        const data = await res.json();
        if (!(data && data.success && data.pdf_url)) {
          alert("PDF generation failed: " + ((data && data.message) || "unknown error"));
          btn.disabled = false;
          btn.innerHTML = _origHtml;
          return;
        }
        url = data.pdf_url;
        // Patch the row in-memory so a re-render keeps the new PDF state.
        const _row = (state._cnList || []).find(x => x.cn_id === cnId);
        if (_row) _row.pdf_url = url;
        // Re-render the CN table so the row shows "View" + the WhatsApp
        // button flips to its full-colour state.
        _renderCreditNotes();
      } catch (err) {
        alert("Network error: " + err.message);
        btn.disabled = false;
        btn.innerHTML = _origHtml;
        return;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Guest-detail edit  +  activity trail (WhatsApp / print / edits)
  //  ---------------------------------------------------------------------
  //  Admins & managers can correct a bill's guest name / phone, and every
  //  row shows a compact "who did what" trail (sent on WhatsApp, printed,
  //  edited) backed by the append-only audit log. Denormalised counters on
  //  the bill drive the at-a-glance badges; the clock opens the full
  //  timeline from /api/audit-logs/doc/bills/<id>/all.
  // ═══════════════════════════════════════════════════════════════════════

  function _blNotify(msg, type) {
    if (typeof window.showNotification === "function") {
      window.showNotification(msg, type || "info");
    }
  }

  // Fire-and-forget: record a print / whatsapp action against a bill.
  function _logBillActivity(billId, kind, to) {
    if (!billId || (kind !== "print" && kind !== "whatsapp")) return;
    try {
      apiFetch("/log_bill_activity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bill_id: billId, kind: kind, to: to || "" }),
      })
        .then((r) => r.json())
        .then(() => {
          // Optimistic local bump so the badge appears immediately without
          // waiting for the Firestore snapshot round-trip.
          const entry = state.allEntries.find((x) => x.id === billId);
          if (!entry) return;
          entry.activity = entry.activity || {};
          const slot = entry.activity[kind] || { count: 0 };
          slot.count = (slot.count || 0) + 1;
          entry.activity[kind] = slot;
          applyFilters();
        })
        .catch(() => {});
    } catch (_e) { /* never break the calling action */ }
  }

  // ── Row activity icons ──────────────────────────────────────────────────
  // Just small colored icons under the guest name for what has happened on
  // the bill: WhatsApp (green), printed (blue), edited (amber). No text, no
  // chips. The who / when detail lives in the hover tooltip and the full
  // timeline (click). Rows with no activity render nothing.
  function _blRelTime(ts) {
    if (!ts) return "";
    const d = new Date(String(ts).replace(" ", "T"));
    if (isNaN(d.getTime())) return "";
    const s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    if (s < 604800) return Math.floor(s / 86400) + "d ago";
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }

  // Plain-text summary for the hover tooltip so no info is lost with icons only.
  function _blActTitle(e) {
    const a = e.activity || {};
    const lines = [];
    if (a.whatsapp && a.whatsapp.count) {
      lines.push("Sent on WhatsApp" + (a.whatsapp.count > 1 ? " ×" + a.whatsapp.count : "") +
        (a.whatsapp.last_by ? " · " + a.whatsapp.last_by : "") +
        (a.whatsapp.last_at ? " · " + _blRelTime(a.whatsapp.last_at) : ""));
    }
    if (a.print && a.print.count) {
      lines.push("Printed" + (a.print.count > 1 ? " ×" + a.print.count : "") +
        (a.print.last_by ? " · " + a.print.last_by : "") +
        (a.print.last_at ? " · " + _blRelTime(a.print.last_at) : ""));
    }
    if (e.last_guest_edit) {
      lines.push("Edited" +
        (e.last_guest_edit.by ? " · " + e.last_guest_edit.by : "") +
        (e.last_guest_edit.at ? " · " + _blRelTime(e.last_guest_edit.at) : ""));
    }
    lines.push("Click for full history");
    return lines.join("\n");
  }

  function _activityStrip(e) {
    const a = e.activity || {};
    const icons = [];
    if (a.whatsapp && a.whatsapp.count)
      icons.push('<i class="fab fa-whatsapp bl-act-i bl-act-wa" aria-hidden="true"></i>');
    if (a.print && a.print.count)
      icons.push('<i class="fas fa-print bl-act-i bl-act-print" aria-hidden="true"></i>');
    if (e.last_guest_edit)
      icons.push('<i class="fas fa-pen bl-act-i bl-act-edit" aria-hidden="true"></i>');
    if (!icons.length) return "";
    const _bn = (e.bill_number || "").replace(/"/g, "&quot;");
    return `<div class="bl-act-strip" data-id="${e.id}" data-billno="${_bn}" title="${_glockEsc(_blActTitle(e))}">${icons.join("")}</div>`;
  }

  // ── Edit guest details modal ────────────────────────────────────────────
  const _blEdit = { billId: null };
  function _ensureEditModal() {
    if (dom("bl-edit-backdrop")) return;
    const wrap = document.createElement("div");
    wrap.className = "bl-edit-backdrop";
    wrap.id = "bl-edit-backdrop";
    wrap.innerHTML = `
      <div class="bl-edit-modal" role="dialog" aria-modal="true">
        <div class="bl-edit-head">
          <h3>Edit guest details</h3>
          <button type="button" class="bl-edit-x" aria-label="Close">&times;</button>
        </div>
        <div class="bl-edit-sub" id="bl-edit-sub"></div>
        <label class="bl-edit-label">Guest name
          <input type="text" id="bl-edit-name" maxlength="120" autocomplete="off" />
        </label>
        <label class="bl-edit-label">Mobile number
          <input type="tel" id="bl-edit-mobile" inputmode="numeric" maxlength="10" autocomplete="off" placeholder="10-digit (or leave blank)" />
        </label>
        <div class="bl-edit-err" id="bl-edit-err"></div>
        <div class="bl-edit-actions">
          <button type="button" class="bl-edit-cancel">Cancel</button>
          <button type="button" class="bl-edit-save">Save changes</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const close = () => wrap.classList.remove("show");
    wrap.querySelector(".bl-edit-x").addEventListener("click", close);
    wrap.querySelector(".bl-edit-cancel").addEventListener("click", close);
    wrap.addEventListener("click", (ev) => { if (ev.target === wrap) close(); });
    wrap.querySelector(".bl-edit-save").addEventListener("click", _saveEditGuest);
    dom("bl-edit-mobile").addEventListener("input", (ev) => {
      ev.target.value = ev.target.value.replace(/\D/g, "").slice(0, 10);
    });
  }

  function openEditGuestModal(entry) {
    _ensureEditModal();
    _blEdit.billId = entry.id;
    dom("bl-edit-sub").textContent =
      "Bill " + (entry.bill_number || "—") + " · Room " + (entry.room || "—");
    dom("bl-edit-name").value   = entry.guest_name || "";
    dom("bl-edit-mobile").value = entry.guest_mobile || "";
    dom("bl-edit-err").textContent = "";
    dom("bl-edit-backdrop").classList.add("show");
    setTimeout(() => { const n = dom("bl-edit-name"); if (n) n.focus(); }, 30);
  }

  async function _saveEditGuest() {
    const billId = _blEdit.billId;
    if (!billId) return;
    const name    = (dom("bl-edit-name").value || "").trim();
    const mobile  = (dom("bl-edit-mobile").value || "").replace(/\D/g, "");
    const err     = dom("bl-edit-err");
    const saveBtn = document.querySelector("#bl-edit-backdrop .bl-edit-save");
    err.textContent = "";
    if (!name) { err.textContent = "Guest name cannot be empty."; return; }
    if (mobile && mobile.length !== 10) {
      err.textContent = "Mobile must be a 10-digit number (or blank).";
      return;
    }
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving…"; }
    try {
      const res = await apiFetch("/update_bill_guest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bill_id: billId, guest_name: name, guest_mobile: mobile }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || ("HTTP " + res.status));
      const entry = state.allEntries.find((x) => x.id === billId);
      if (entry) {
        entry.guest_name   = data.guest_name   != null ? data.guest_name   : name;
        entry.guest_mobile = data.guest_mobile != null ? data.guest_mobile : mobile;
        if (data.last_guest_edit) entry.last_guest_edit = data.last_guest_edit;
        applyFilters();
      }
      dom("bl-edit-backdrop").classList.remove("show");
      _blNotify("Guest details updated", "success");
    } catch (e2) {
      err.textContent = (e2 && e2.message) || "Could not save changes.";
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save changes"; }
    }
  }

  // ── Activity history timeline modal ─────────────────────────────────────
  function _ensureHistoryModal() {
    if (dom("bl-hist-backdrop")) return;
    const wrap = document.createElement("div");
    wrap.className = "bl-hist-backdrop";
    wrap.id = "bl-hist-backdrop";
    wrap.innerHTML = `
      <div class="bl-hist-modal" role="dialog" aria-modal="true">
        <div class="bl-hist-head">
          <div><h3>Activity history</h3><div class="bl-hist-sub" id="bl-hist-sub"></div></div>
          <button type="button" class="bl-hist-x" aria-label="Close">&times;</button>
        </div>
        <div class="bl-hist-body" id="bl-hist-body"></div>
      </div>`;
    document.body.appendChild(wrap);
    const close = () => wrap.classList.remove("show");
    wrap.querySelector(".bl-hist-x").addEventListener("click", close);
    wrap.addEventListener("click", (ev) => { if (ev.target === wrap) close(); });
  }

  const _BL_ACTION_META = {
    "bill.print":         { label: "Printed",              icon: "fas fa-print",            kind: "print" },
    "bill.whatsapp.sent": { label: "Sent on WhatsApp",     icon: "fab fa-whatsapp",         kind: "wa" },
    "bill.guest.edit":    { label: "Edited guest details", icon: "fas fa-pen",              kind: "edit" },
    "bill.gst.clear":     { label: "GST details cleared",  icon: "fas fa-id-card-alt",      kind: "gst" },
    "payment.add":        { label: "Payment collected",    icon: "fas fa-hand-holding-usd", kind: "pay" },
    "payment.edit":       { label: "Payment edited",       icon: "fas fa-hand-holding-usd", kind: "pay" },
  };
  function _blActionMeta(action) {
    if (_BL_ACTION_META[action]) return _BL_ACTION_META[action];
    if (action && action.indexOf("bill.gst") === 0)
      return { label: "GST details updated", icon: "fas fa-id-card-alt", kind: "gst" };
    return { label: action || "Activity", icon: "fas fa-info-circle", kind: "other" };
  }
  function _blHistTime(ts) {
    if (!ts) return "";
    const d = new Date(String(ts).replace(" ", "T"));
    if (isNaN(d.getTime())) return ts;
    return d.toLocaleString(undefined, {
      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
    });
  }
  function _blHistItem(en) {
    const m    = _blActionMeta(en.action);
    const who  = en.userName || en.userId || "system";
    const when = _blHistTime(en.timestamp);
    let detail = "";
    const meta = en.metadata || {};
    if (m.kind === "wa" && meta.to) {
      detail = ` <span class="bl-hist-to">→ +91 ${_glockEsc(String(meta.to))}</span>`;
    }
    return `<div class="bl-hist-item">
      <span class="bl-hist-dot bl-hist-${m.kind}"><i class="${m.icon}"></i></span>
      <div class="bl-hist-main">
        <div class="bl-hist-line"><strong>${_glockEsc(m.label)}</strong>${detail}</div>
        <div class="bl-hist-meta">${_glockEsc(who)} · ${_glockEsc(when)}</div>
      </div>
    </div>`;
  }

  // Fallback timeline built from the denormalised fields already on the row,
  // used when the audit-log read returns nothing (e.g. missing index or a
  // logging blip) so the modal still reflects the known last actions rather
  // than showing a misleading "nothing here".
  function _synthTimelineFromEntry(billId) {
    const e = state.allEntries.find((x) => x.id === billId);
    if (!e) return [];
    const a = e.activity || {};
    const out = [];
    if (a.whatsapp && a.whatsapp.count)
      out.push({ action: "bill.whatsapp.sent", userName: a.whatsapp.last_by, timestamp: a.whatsapp.last_at, metadata: {} });
    if (a.print && a.print.count)
      out.push({ action: "bill.print", userName: a.print.last_by, timestamp: a.print.last_at, metadata: {} });
    if (e.last_guest_edit)
      out.push({ action: "bill.guest.edit", userName: e.last_guest_edit.by, timestamp: e.last_guest_edit.at, metadata: {} });
    out.sort((x, y) => String(y.timestamp || "").localeCompare(String(x.timestamp || "")));
    return out;
  }

  async function openHistoryModal(billId, billNo) {
    if (!billId) return;
    _ensureHistoryModal();
    dom("bl-hist-sub").textContent = "Bill " + (billNo || "—");
    const body = dom("bl-hist-body");
    body.innerHTML = `<div class="bl-hist-state">Loading…</div>`;
    dom("bl-hist-backdrop").classList.add("show");
    const _renderFallback = () => {
      const synth = _synthTimelineFromEntry(billId);
      body.innerHTML = synth.length
        ? synth.map(_blHistItem).join("")
        : `<div class="bl-hist-state">No activity recorded yet.</div>`;
    };
    try {
      const res = await apiFetch(
        "/api/audit-logs/doc/bills/" + encodeURIComponent(billId) + "/all?limit=25"
      );
      const data = await res.json();
      const entries = (data && data.entries) || [];
      if (!entries.length) { _renderFallback(); return; }
      body.innerHTML = entries.map(_blHistItem).join("");
    } catch (_e) {
      _renderFallback();
    }
  }

  // ── Boot trigger (was missing — IIFE closer below) ────────────────────────
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootWhenReady);
  } else {
    bootWhenReady();
  }

  // ── Public refresh contract ───────────────────────────────────────────────
  // Consumed by the global header Refresh button (static/script.js). Mirrors
  // register.js.
  //   invalidate() clears the loaded-range marker so the NEXT time the tab is
  //     shown, watchTab()'s MutationObserver-driven loadData(false) misses the
  //     cache and re-fetches from the server. Used for the non-active tab.
  //   refresh() forces an immediate re-fetch of the current range (identical
  //     to clicking the in-tab refresh button). Used when this is the active
  //     tab.
  //   isLoaded() reports whether a range has ever been fetched this session.
  window.CibaraBills = Object.freeze({
    invalidate: function () { state.lastLoadedRange = null; },
    refresh:    function () { return loadData(true); },
    isLoaded:   function () { return state.lastLoadedRange !== null; },
  });
})();
