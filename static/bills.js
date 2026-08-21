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

/* ── Compact filter bar ──────────────────────────────────────────────────
   Applies from 1149px down, not 600px. Measured, not guessed: the full
   desktop bar (date + 3 ranges + 3 selects + search) only fits on one line
   at 1150px and up. Between 601px and 1149px it wrapped, the search took a
   line of its own at flex:1, and the three selects sat at their natural
   width with empty bar to their right. Every phone, every tablet and any
   half-width desktop window landed in that band.

   Row 1  date field + Today / Last 3 Days / Month
   Row 2  All Payments · All Sources · All Bills · search   (one row, flush
          to both edges)

   Row 2 uses flex-basis 0 so the row is divided by GROW WEIGHT alone rather
   than by each control's natural width. That is what removes the dead space:
   percentage or content-based bases leave whatever does not divide evenly,
   a 0 basis cannot. Weights are 1 / 1 / 1 / 1.6, so the search gets ~26% and
   each select ~21%.

   Below ~430px those selects fall under about 75px and clip to "All Pay…".
   That is the accepted cost of keeping all four on one row; the arrow still
   shows and the options read in full once opened. */
@media (max-width: 1149px) {
  .bl-filter-bar label { display: none; }
  .bl-filter-bar { flex-wrap: wrap; row-gap: 0.45rem; padding: 0.5rem; }

  /* The divider does the line break. the CSS order property only reorders items, it never
     starts a new flex line, so with a 0 flex-basis on row 2 the browser
     happily packed all seven controls onto row 1 and gave the selects 10px
     each. A full-width, zero-height item forces the wrap, and the divider
     already sits in exactly the right place in the markup (after the quick
     ranges, before the first select), so no template change is needed.
     Negative top margin cancels the second row-gap this empty line would
     otherwise introduce. */
  .bl-filter-divider {
    order: 0; flex: 0 0 100%; width: 100%; height: 0;
    background: none; margin: -0.45rem 0 0;
  }

  /* Row 1. Fixed narrow date field so it plus all three quick ranges stay on
     ONE row; letting it size to "18 Aug 2026 to 20 Aug 2026" pushed the
     buttons onto lines of their own. The range clips inside the field, which
     is fine: it is a picker, not a label. */
  .bl-filter-bar .bl-date-range-wrap { order: 0; flex: 0 0 auto; min-width: 0; }
  .bl-filter-bar .bl-quick-btn {
    order: 0; flex: 0 0 auto;
    padding: 0.22rem 0.5rem; font-size: 0.68rem; letter-spacing: -0.01em;
  }
  .bl-date-range-input { width: 92px; min-width: 0; text-overflow: ellipsis; }

  /* Row 2. Same order value on all four, so they share one line.
     min-width:0 is required — form controls default to min-width:auto, which
     refuses to shrink below their intrinsic width and would push the search
     back onto its own row. */
  .bl-filter-bar select {
    order: 1; flex: 1 1 0; min-width: 0;
    font-size: 0.72rem; padding: 0.25rem 0.2rem;
  }
  .bl-filter-bar .bl-search-input {
    order: 1; flex: 1.6 1 0; min-width: 0;
    font-size: 0.75rem; padding-left: 1.6rem;
  }

  /* Edge to edge. 1rem each side costs 32px of usable width on a phone,
     which is most of a dropdown. 0.5rem keeps the cards off the bezel
     without spending the row. */
  .bills-container { padding: 0.5rem; }
}


@media (max-width: 600px) {
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

@media (max-width: 430px) {
  /* Last squeeze before the selects would clip mid-word on small phones. */
  .bl-filter-bar { gap: 0.3rem; padding: 0.45rem 0.4rem; }
  .bl-filter-bar select { font-size: 0.64rem; padding: 0.25rem 0.1rem; }
  .bl-filter-bar .bl-search-input { font-size: 0.7rem; padding-left: 1.45rem; }
  .bills-container { padding: 0.4rem; }
  .bills-table-container { border-radius: 6px; }
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
.bl-gst-typeahead { position:relative; }
.bl-gst-suggestions {
  position:absolute; top:100%; left:0; right:0; z-index:60;
  background:#fff; border:1px solid #cbd5e1; border-top:none;
  border-radius:0 0 8px 8px; max-height:240px; overflow-y:auto;
  box-shadow:0 10px 24px rgba(15,23,42,.14);
}
/* The suggestion rows reuse the .ms-* classes from the guest lookup so the
   two type-aheads look identical. These rules are a scoped fallback: if the
   global sheet ever stops loading on this page, the list still reads as a
   list instead of a stack of naked divs. */
.bl-gst-suggestions .ms-row { display:flex; align-items:center; gap:.5rem;
  padding:.45rem .6rem; cursor:pointer; border-bottom:1px solid #f1f5f9; }
.bl-gst-suggestions .ms-row:last-child { border-bottom:none; }
.bl-gst-suggestions .ms-row:hover { background:#f8fafc; }
.bl-gst-suggestions .ms-main { flex:1; min-width:0; }
.bl-gst-suggestions .ms-name { font-weight:700; font-size:.85rem; color:#0f172a; }
.bl-gst-suggestions .ms-sub { color:#94a3b8; font-size:.74rem; margin-top:.1rem;
  font-family: ui-monospace, "SF Mono", Menlo, monospace; }
.bl-gst-note { padding:.5rem .6rem; font-size:.76rem; line-height:1.4;
  color:#64748b; cursor:default; }
.bl-gst-note.warn { color:#92400e; background:#fffbeb; }
.bl-gst-fill-status { font-size:.7rem; line-height:1.45; padding:.3rem .5rem;
  border-radius:6px; margin-top:.3rem; }
.bl-gst-fill-status.ok   { color:#065f46; background:#ecfdf5; border:1px solid #a7f3d0; }
.bl-gst-fill-status.warn { color:#92400e; background:#fffbeb; border:1px solid #fde68a; }
.bl-gst-known-empty { color:#64748b; background:#f8fafc; border-color:#e2e8f0; }
.bl-gst-known-hint { font-size:.68rem; color:#0f766e; background:#f0fdfa;
  border:1px solid #99f6e4; border-radius:6px; padding:.3rem .5rem;
  margin-top:.3rem; line-height:1.45; }
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

  // ══════════════════════════════════════════════════════════════════════════
  // TAX FIGURES — read from the server, never recomputed here
  // ──────────────────────────────────────────────────────────────────────────
  // This module used to carry gstAmounts / waterGst / accomGst /
  // accomTaxFromEntry and derive GST in the browser from room_rent x days.
  // Everything downstream — the tally, the bills table, and the GSTR-1 export
  // workbook the CA files — was built from that derivation, independently of
  // the invoice the guest was actually given. It was wrong in ways that
  // mattered:
  //
  //   • A stay crossing a slab boundary (a 1,150 night at 5% plus a 950 night
  //     that is exempt) was collapsed onto ONE representative rate, producing
  //     a GSTR-1 row where Taxable x Rate did not equal the tax.
  //   • A room transfer multiplied the CURRENT room's rate by the whole stay
  //     length, inventing a value of supply that never existed.
  //   • An accommodation add-on was taxed at the slab picked from the bare
  //     room rate, so 900 room + 300 extra bed came out exempt when the real
  //     value of supply was 1,200 and attracted 5%.
  //   • Only the literal word "water" was ever taxed; laundry at 18% and cold
  //     drinks at 12% printed a rate on the invoice and contributed nothing.
  //
  // The server now ships `tax_breakup` on every register entry, computed by
  // config.bill_tax_breakup from the stored per-night folio — the same call
  // that builds the invoice's HSN/SAC summary. Read it; do not second-guess it.

  // Empty breakup — used for cancelled bills and for any entry an older
  // server build did not stamp.
  const EMPTY_TAX = { rows: [], taxable: 0, cgst: 0, sgst: 0, igst: 0,
                      tax: 0, exempt_value: 0, source: "none" };

  /**
   * Authoritative tax figures for one register entry.
   *
   * Returns the server's breakup plus a few convenience totals:
   *   rows        rate-wise rows: {hsn, description, rate, taxable, cgst,
   *               sgst, igst, tax, category}
   *   accomTax / serviceTax   tax split by category
   *   accomTaxable / serviceTaxable
   *
   * A cancelled bill contributes nothing: the stored aggregates are NOT
   * cleared on revert, so reading them without this guard kept printing tax
   * against a CANCELLED row.
   */
  function billTax(e) {
    const empty = { ...EMPTY_TAX, rows: [], accomTax: 0, serviceTax: 0,
                    accomTaxable: 0, serviceTaxable: 0 };
    if (!e || e.status === "cancelled") return empty;

    const bt = e.tax_breakup;
    if (!bt || !Array.isArray(bt.rows)) {
      // Older server build, or a payload that predates tax_breakup. Report
      // zero rather than guessing — a silent wrong number in a GST return is
      // worse than a visible zero, and the console line says why.
      if (!billTax._warned) {
        billTax._warned = true;
        console.warn("[Bills] entry has no tax_breakup from the server; " +
                     "tax figures will read 0. Server needs redeploying.");
      }
      return empty;
    }

    const rows = bt.rows;
    const sum = (pred, key) => rows.reduce(
      (acc, r) => acc + (pred(r) ? Number(r[key] || 0) : 0), 0);
    const isAccom = (r) => r.category === "accommodation";
    const isSvc   = (r) => r.category !== "accommodation";

    return {
      ...bt,
      rows,
      accomTax:       sum(isAccom, "tax"),
      serviceTax:     sum(isSvc,   "tax"),
      accomTaxable:   sum(isAccom, "taxable"),
      serviceTaxable: sum(isSvc,   "taxable"),
    };
  }

  // Value of supply carried at 0% on the ACCOMMODATION lines. `exempt_value`
  // on the breakup pools exempt accommodation with exempt services; the
  // export needs them apart so an exempt night is not reported as a service.
  function _accomExemptValue(bt) {
    return (bt.rows || [])
      .filter((r) => r.category === "accommodation" && Number(r.rate || 0) <= 0)
      .reduce((s, r) => s + Number(r.taxable || 0), 0);
  }

  // Rate actually charged on the accommodation lines, for display only.
  // Returns "" when the stay spans more than one slab — printing a single
  // number there would misrepresent the bill.
  function accomRateLabel(e) {
    const rates = [...new Set(billTax(e).rows
      .filter((r) => r.category === "accommodation")
      .map((r) => Number(r.rate || 0)))];
    if (rates.length === 0) return "";
    if (rates.length > 1) return "Mixed";
    return rates[0] > 0 ? `${rates[0]}%` : "Exempt";
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
        <div class="bl-gst-typeahead">
          <input id="bl-gst-gstin" maxlength="15" placeholder="e.g. 29AAACB1234F1Z5"
                 autocomplete="off" spellcheck="false" data-lpignore="true" />
          <!-- Same dropdown the guest-mobile lookup uses, down to the .ms-*
               classes, so it reads as one pattern rather than two. -->
          <div id="bl-gst-suggestions" class="bl-gst-suggestions" style="display:none;"></div>
        </div>
        <div class="bl-gst-known-hint" id="bl-gst-known-hint" style="display:none;"></div>
        <div class="bl-gst-fill-status" id="bl-gst-fill-status" style="display:none;"></div>
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
    <!-- Per-segment rates. Hidden for an ordinary stay and for a transfer
         where every night was billed at the same rate (same price category) —
         those take the single input above. Revealed only when the server
         reports more than one nightly rate, which is genuinely ambiguous for
         a single number. -->
    <div id="bl-rprice-segments" style="display:none; margin-bottom:12px;"></div>
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
<div id="bl-pdf-gen-overlay" data-no-back>
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

    <!-- Only the Consolidated invoice is ever generated or stored. The old
         Detailed/Consolidated toggle lived here; each flip uploaded another
         v{n}.pdf to Storage, so a bill accumulated both variants. -->
    <div class="bl-view-toggle" id="bl-wa-pdf-row" style="margin-bottom:.9rem;">
      <span class="bl-view-toggle-label">Invoice PDF</span>
      <span class="bl-vt-hint" id="bl-wa-pdf-status"></span>
      <button type="button" class="bl-vt-btn" id="bl-wa-regen"
              title="Only needed if the bill changed after the PDF was saved">Regenerate</button>
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
        // Log the print. The Register tab's print button already did this;
        // this one never did, so a bill printed from the Bills tab showed no
        // print badge AND — now that /log_bill_activity also stamps the
        // guest's always-bill preference — would have silently failed to
        // record that the guest asked for a bill. Same signal, same log.
        // _openBillId is declared with `let` further down this same IIFE, but
        // this is a click handler: by the time it runs the whole module body
        // has executed, so there is no temporal-dead-zone hazard.
        try {
          if (_openBillId) _logBillActivity(_openBillId, "print");
        } catch (_e) { /* never let logging break printing */ }
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
      vtBar.addEventListener("click", async (e) => {
        const btn = e.target.closest(".bl-vt-btn");
        if (!btn || !_openBillId) return;
        const mode = btn.dataset.view;
        if (mode !== "detailed" && mode !== "consolidated") return;
        const prevMode = _openBillView;
        _billViewMode = mode;
        try { localStorage.setItem("cibara_bill_view", mode); } catch (_e) {}
        if (mode !== prevMode) {
          try {
            await _renderOpenBill(mode);
          } catch (err) {
            console.error("[Bills] view toggle re-render failed:", err);
            return;   // leave the current view on screen rather than blanking it
          }
        }
        _syncViewToggle();
      });

    // ── "Save & Share" button in bill modal ───────────────────────────────────
    // Opens the WhatsApp send modal, which reuses the bill's saved Consolidated
    // PDF and only generates one when none exists. Passing along the bill data
    // we already have avoids a redundant /generate_bill fetch.
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
          pdf_url: _openBillData.pdf_url || "",
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

    const rpSegments = dom("bl-rprice-segments");
    // Set when the server tells us the stay has more than one nightly rate.
    // While it is non-null the modal collects one price per segment and the
    // single price input is hidden.
    let _rpSegmentMode = null;

    function _rpSingleFields(show) {
      // The single-price input and its label live as siblings; toggle the
      // input and walk back to its label so the form does not show a heading
      // for a field that is not there.
      if (!rpInput) return;
      rpInput.style.display = show ? "" : "none";
      const lbl = rpInput.previousElementSibling;
      if (lbl && lbl.tagName === "LABEL") lbl.style.display = show ? "" : "none";
    }

    function _closeRprice() {
      if (rpBackdrop) rpBackdrop.style.display = "none";
      _rpSegmentMode = null;
      if (rpSegments) { rpSegments.style.display = "none"; rpSegments.innerHTML = ""; }
      _rpSingleFields(true);
    }

    // Render one rate input per segment, pre-filled with the current rate.
    // Reached only from the server's 409, so the shape is exactly what the
    // backend derived — no guessing at segments client-side.
    function _rpShowSegments(segments) {
      if (!rpSegments) return;
      _rpSegmentMode = segments;
      _rpSingleFields(false);
      const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
      let html =
        '<div style="font-size:13px; font-weight:600; margin-bottom:6px;">' +
        "Rate per night for each part of the stay</div>";
      segments.forEach(function (s, i) {
        html +=
          '<div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">' +
          '<div style="flex:1; font-size:13px; color:#374151;">' +
          "Room <b>" + esc(s.room) + "</b>" +
          '<span style="color:#6b7280;"> · ' + s.nights + " night" +
          (s.nights === 1 ? "" : "s") + "</span>" +
          (s.is_current_room
            ? '<span style="color:#9ca3af; font-size:11px;"> (final room)</span>'
            : "") +
          "</div>" +
          '<input class="bl-rprice-seg" data-idx="' + i + '" type="number" min="0" ' +
          'step="1" inputmode="numeric" value="' + Number(s.rate || 0) + '" ' +
          'style="width:110px; box-sizing:border-box; padding:8px 9px; font-size:14px; ' +
          'border:1px solid #cbd5e1; border-radius:8px;" />' +
          "</div>";
      });
      rpSegments.innerHTML = html;
      rpSegments.style.display = "block";
      const first = rpSegments.querySelector(".bl-rprice-seg");
      if (first) { first.focus(); first.select(); }
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
        // Always reopen in single-price mode. Segment inputs are only ever
        // reached via the server's 409, and a breakdown left over from a
        // previous bill must never be submitted against this one.
        _rpSegmentMode = null;
        if (rpSegments) { rpSegments.style.display = "none"; rpSegments.innerHTML = ""; }
        _rpSingleFields(true);
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
        // Two shapes: one price for the whole stay, or one per segment when
        // the stay was billed at more than one nightly rate.
        let newPrice = 0;
        let segmentPrices = null;
        if (_rpSegmentMode) {
          segmentPrices = [];
          const inputs = rpSegments.querySelectorAll(".bl-rprice-seg");
          for (let i = 0; i < inputs.length; i++) {
            const v = (inputs[i].value || "").trim();
            const nv = Number(v);
            if (v === "" || isNaN(nv) || nv < 0 || !Number.isInteger(nv)) {
              if (rpMsg) {
                rpMsg.style.color = "#b91c1c";
                rpMsg.textContent =
                  "Every segment needs a whole, non-negative rupee amount.";
              }
              inputs[i].focus();
              return;
            }
            segmentPrices.push(parseInt(v, 10));
          }
          // Sent for audit continuity; the server prices off segment_prices.
          newPrice = segmentPrices[segmentPrices.length - 1];
        } else {
          const raw = ((rpInput && rpInput.value) || "").trim();
          const n = Number(raw);
          if (raw === "" || isNaN(n) || n < 0 || !Number.isInteger(n)) {
            if (rpMsg) { rpMsg.style.color = "#b91c1c"; rpMsg.textContent = "Enter a whole, non-negative rupee amount."; }
            return;
          }
          newPrice = parseInt(raw, 10);
        }
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
              // Omitted for a single-rate stay. The server answers 409 with
              // the segment breakdown when it needs these.
              ...(segmentPrices ? { segment_prices: segmentPrices } : {}),
            }),
          });
          const data = await res.json().catch(() => ({}));

          // The stay was billed at more than one nightly rate, so one number
          // is ambiguous. The server hands back the breakdown; expand the
          // modal into per-segment inputs rather than dead-ending. This is
          // NOT a refusal any more: a transfer between rooms of the same
          // price category has a single rate and never reaches here.
          if (!res.ok && data && data.needs_segment_prices && data.segments) {
            _rpShowSegments(data.segments);
            if (rpMsg) {
              rpMsg.style.color = "#374151";
              rpMsg.textContent = data.message || "Set the rate for each part of the stay.";
            }
            return;
          }

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

        // WhatsApp share button — opens the send modal, which reuses the
        // bill's saved Consolidated PDF (entry.pdf_url) and generates one
        // only when it is missing or points at the dead bills/-/ folder.
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

    // Explicit regenerate inside the WhatsApp modal. Only needed when the bill
    // changed after its PDF was saved; the modal otherwise reuses the stored
    // one so a share does not mint another Storage version.
    const waRegenBtn = dom("bl-wa-regen");
    if (waRegenBtn)
      waRegenBtn.addEventListener("click", () => _waRegenerate(true));

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
  //
  // The canonical "this document belongs in a GST return" predicate: every
  // numbered document of the loaded period, regardless of what the operator
  // happens to be looking at. Completed bills, pending_settlement bills
  // (settle-later checkouts) and cancelled bills all qualify — a cancelled
  // number still has to appear in Table 13. bill_number presence is the
  // canonical indicator that a bill was generated.
  //
  // applyFilters() narrows this further with the on-screen search / source /
  // payment / type filters. exportToExcel() must NOT: the CA workbook is
  // always the whole period. See the note at the top of exportToExcel.
  function gstReportableEntries() {
    return state.allEntries.filter(
      (e) =>
        (e.status === "completed" || e.status === "pending_settlement" ||
         e.status === "cancelled") &&
        e.bill_number &&
        e.bill_number !== "-" &&
        e.bill_number.trim() !== "",
    );
  }

  // Human-readable list of the on-screen filters currently narrowing the Bills
  // table. Empty array means the table is showing the whole loaded period.
  // Used by the export to tell the operator what it deliberately ignored.
  function activeFilterLabels() {
    const { search, source, payment, type } = state.filters;
    const out = [];
    if (search) out.push(`search "${search}"`);
    if (source && source !== "all") out.push(`source = ${source}`);
    if (payment && payment !== "all") out.push(`payment = ${payment}`);
    if (type && type !== "all") out.push(`type = ${type}`);
    return out;
  }

  function applyFilters() {
    let f = gstReportableEntries();

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
      // GST accrues on the INVOICE, not on collection. A bill with money
      // still outstanding has already created the liability, so its tax is
      // counted here. This used to `continue` before the tally, which meant
      // the headline GST figure and the GSTR-1 export — which never skipped
      // unpaid bills — disagreed by construction.
      const bt = billTax(e);
      totalAccomGst += bt.accomTax;
      totalWaterGst += bt.serviceTax;

      if ((e.balance || 0) > 0) {
        pending++;
        continue;               // still excluded from CASH/UPI collections
      }
      cash += e.payment_cash || 0;
      upi  += e.payment_online || 0;
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
   * Generate the bill PDF and save it to Firebase Storage.
   *
   * The server renders it from `_build_bill_html` — the same function behind
   * the modal — and uploads it. The browser deliberately sends NO html_content:
   * this used to POST a locally-built `buildBillHTML(...)`, which is exactly
   * why the stored PDF looked nothing like the modal the operator printed.
   *
   * Returns the Storage URL. That one stored artifact is what gets shared on
   * WhatsApp; nothing re-renders the invoice a second time for the guest.
   *
   * `force` regenerates even when a PDF already exists — used by the Regenerate
   * button after a bill has changed.
   */
  // silent=true → no overlay, no alert; used when auto-triggered after checkout.
  async function generateAndUploadPDF(billId, billData, silent = false, force = false) {
    const folderNo = (billData && billData.bill_number) || billId;

    if (!silent) showPdfOverlay("Generating invoice PDF…");

    try {
      if (!silent) updatePdfOverlayText("Converting to PDF…");

      const res = await apiFetch("/render_bill_pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bill_id: billId,
          bill_number: folderNo,
          force: !!force,
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
  // the exact same code path: open the WhatsApp send modal, which reuses the
  // bill's saved Consolidated PDF and only generates one when none exists.
  // Returns true once the modal is open, false only if billId/billData is
  // missing.
  window.cibaraSaveAndShareBill = async function(billId, billData) {
    if (!billId || !billData) return false;
    try {
      const entry = {
        id:           billId,
        guest_name:   billData.guest_name,
        guest_mobile: billData.guest_mobile,
        bill_number:  billData.bill_number,
        total_amount: billData.total_amount,
        // Carried through so the modal can reuse an already-saved PDF instead
        // of uploading another Storage version on every share.
        pdf_url:      billData.pdf_url || "",
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

  // PDF status line inside the WhatsApp send modal. Replaces the old
  // Detailed/Consolidated toggle: the shared invoice is always Consolidated,
  // and an existing saved PDF is reused rather than regenerated. Hidden for
  // credit-note sends, which carry their own already-generated document.
  // status: "reused" | "generating" | "fresh" | "failed"
  function _syncWaPdfStatus(status) {
    const s = state.waModal;
    const bar = dom("bl-wa-pdf-row");
    if (!bar) return;
    bar.style.display = s._isCN ? "none" : "flex";
    const hint = dom("bl-wa-pdf-status");
    if (hint) {
      hint.textContent = {
        reused:     "Using the saved invoice PDF",
        generating: "Preparing invoice PDF…",
        fresh:      "Invoice PDF generated",
        failed:     "",
      }[status] || "";
    }
    const regen = dom("bl-wa-regen");
    if (regen) regen.disabled = status === "generating";
  }

  // Ensure the modal has a shareable PDF URL, then refresh the message preview.
  //
  // force=false (modal open): reuse the bill's saved pdf_url when there is one.
  // Every generation uploads a new, permanent v{n}.pdf (upload_bill_pdf never
  // overwrites), so unconditional regeneration meant one stored PDF per share.
  // force=true (Regenerate button): always produce a fresh version. Use after
  // the bill itself changed — the previously shared link keeps working, since
  // old versions are left in place.
  //
  // A request sequence number guards against overlapping calls: if the user
  // hits Regenerate twice, the stale response is discarded.
  async function _waRegenerate(force = false) {
    const s = state.waModal;
    const myReq = (s._waReqSeq = (s._waReqSeq || 0) + 1);
    const sendBtn = dom("bl-wa-send");
    const errEl = dom("bl-wa-error");
    if (errEl) errEl.textContent = "";

    // Nothing to do — a saved PDF already exists and the caller didn't ask for
    // a fresh one. Note openWhatsAppModal has already filtered out URLs into
    // the dead shared bills/-/ folder.
    if (!force && s.pdfUrl) {
      _syncWaPdfStatus("reused");
      _updateWaPreview();
      return;
    }

    _syncWaPdfStatus("generating");
    if (sendBtn) {
      sendBtn.disabled = true;
      sendBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Preparing…';
    }
    try {
      if (!s.billData) {
        const res = await apiFetch(`/generate_bill/${s.billId}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.message || "Could not load bill data.");
        if (myReq !== s._waReqSeq) return;   // a newer request already fired
        s.billData = data.bill;
      }
      // The server pins Consolidated for every PDF, so the Detailed variant
      // can never reach Storage or a guest regardless of the operator's toggle.
      // `force` is passed through so Regenerate produces a fresh version rather
      // than getting the cached URL back.
      const url = await generateAndUploadPDF(s.billId, s.billData, true, force);
      if (myReq !== s._waReqSeq) return;     // a newer request already fired
      if (!url) throw new Error("PDF generation failed.");
      s.pdfUrl = url;
      _syncWaPdfStatus("fresh");
      _updateWaPreview();
    } catch (err) {
      if (myReq !== s._waReqSeq) return;     // a newer request superseded this failure
      console.error("[Bills] WA PDF prepare failed:", err);
      _syncWaPdfStatus("failed");
      if (errEl) errEl.textContent = err.message || "Could not prepare the PDF — try again.";
    } finally {
      if (myReq === s._waReqSeq && sendBtn) {
        sendBtn.disabled = false;
        sendBtn.innerHTML = '<i class="fab fa-whatsapp"></i> Send via WhatsApp';
      }
    }
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
    s.viewMode = "consolidated";   // the only variant ever generated or stored
    // Reuse the bill's saved PDF when one exists, so opening the modal does not
    // mint another Storage version. Two URLs are treated as absent:
    //   - anything under the shared bills/-/ folder, which was overwritten by
    //     every placeholder-numbered bill (token rotated → 403 on fetch)
    //   - a missing URL, obviously
    // Regenerate is available in the modal when the bill has since changed.
    const _savedUrl = entry.pdf_url || (billData && billData.pdf_url) || "";
    s.pdfUrl = _savedUrl.includes("bills%2F-%2F") ? null : (_savedUrl || null);

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

    _syncWaPdfStatus(s.pdfUrl ? "reused" : "generating");
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

    // GST cell — the bill's TOTAL output tax, straight from the server's
    // breakup. It now includes service tax (laundry, water, cold drinks), so
    // this column sums to the tally above it; it used to show accommodation
    // only while the tally counted both. The rate label reads "Mixed" for a
    // stay that spans slabs rather than picking one and misstating the rest.
    const _bt = billTax(e);
    const gstTotal = _bt.tax;
    const _rateLabel = accomRateLabel(e);
    const gstCell =
      gstTotal > 0
        ? `<span style="font-size:.73rem;">₹${inr(Math.round(gstTotal))}<br><span style="font-size:.65rem;color:#888;">${_rateLabel} GST</span></span>`
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

  // Last view mode / collapsibility the server reported for the open bill.
  // The browser no longer derives either: /bill_html decides, and returns both
  // alongside the HTML it rendered.
  let _openBillView = null;
  let _openBillCollapsible = false;

  // (Re)render the open bill into the print area, keeping the inline
  // attribution banner. Called on open and whenever the view toggle changes.
  //
  // The bill HTML is FETCHED, not built here. `_build_bill_html` on the server
  // is the only renderer, so the modal, Print, the stored PDF and the guest's
  // WhatsApp copy are the same document. This function used to call a local
  // buildBillHTML(), which is how the Bills tab came to print a different
  // invoice than the one it uploaded to Storage.
  async function _renderOpenBill(view) {
    const area = dom("bl-bill-print-area");
    if (!area || !_openBillId) return;

    const qs = (view === "detailed" || view === "consolidated")
      ? `?view=${view}` : "";
    const res = await apiFetch(`/bill_html/${_openBillId}${qs}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.message || "Could not render bill.");

    area.innerHTML = data.html;
    _openBillView = data.view;
    _openBillCollapsible = !!data.collapsible;

    if (window.CibaraAttribution) {
      const attrEl = document.createElement("div");
      attrEl.style.cssText = "margin: 0 0 10px 0;";
      area.insertBefore(attrEl, area.firstChild);
      window.CibaraAttribution.decorate(attrEl, "bills", _openBillId, { hideIfNone: true });
    }
  }

  // Show the Detailed/Consolidated toggle only when the open bill has a
  // multi-night folio that can actually be consolidated, and highlight the
  // button matching the mode the server applied.
  function _syncViewToggle() {
    const bar = dom("bl-view-toggle");
    if (!bar) return;
    if (!_openBillCollapsible) {
      bar.style.display = "none";
      return;
    }
    bar.style.display = "flex";
    const mode = _openBillView;
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
    _openBillView = null;
    _openBillCollapsible = false;

    try {
      // The bill record is still fetched: the action buttons (Save & Share,
      // Recalculate, Edit Price) act on its fields. The rendered invoice comes
      // separately from /bill_html so the browser never re-derives layout.
      const res = await apiFetch(`/generate_bill/${id}`);
      const data = await res.json();
      if (data.success) {
        _openBillId = id;
        _openBillData = data.bill;
        // Render the bill body with its inline attribution banner, then show
        // the view toggle when the server reports a collapsible folio. Honour
        // the operator's saved preference; null means let the server auto-pick.
        await _renderOpenBill(_billViewMode);
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
      // Surface the real error — a bare catch was hiding render failures
      // behind a generic "Network error" string.
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
  // BILL RENDERING — server-side, deliberately not here
  // ──────────────────────────────────────────────────────────────────────────
  // This module used to carry its own buildBillHTML() plus the folio grouping
  // helpers (folioNightKey / groupFolio / renderFolioNight / renderFolioRun)
  // and a local consolidateServices(). All of it is gone.
  //
  // Those ~850 lines were one of FOUR copies of the same invoice layout, and
  // they had drifted the furthest: block headers read "Night 1" against a raw
  // 2026-08-06 date instead of "Day 1 — 6 Aug 2026 (Thu)", the SAC sub-line and
  // the HSN/SAC Tax Summary table were missing entirely, and the headers were
  // wrapped in U+2500 box-drawing characters that xhtml2pdf cannot render in
  // WinAnsi — so every folio PDF sent to a guest showed filled black boxes.
  // Because generateAndUploadPDF POSTed this renderer's output as
  // html_content, that drifted layout was what got stored and shared, while
  // the operator printed the Register tab's very different rendering.
  //
  // The bill HTML now comes from GET /bill_html, rendered by
  // _build_bill_html in routes/billing.py. Change the invoice layout there and
  // every surface — modal, Print, stored PDF, WhatsApp — moves together.
  // ══════════════════════════════════════════════════════════════════════════

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
  // ── Workbook file name ─────────────────────────────────────────────────────
  // The CA receives one of these per period, often several revisions of the
  // same period, and they all land in one Downloads folder. The name has to
  // answer, without opening the file: whose lodge, which return, which period,
  // and which revision. The old name gave the raw dateRange with no business
  // name and no revision stamp, so two exports of the same month collided as
  // "…(1).xlsx" and the CA had no way to tell which was current.
  //
  // A whole calendar month gets the short readable form (Jul-2026); anything
  // else spells both ends out.
  function _workbookFileName(startYmd, endYmd) {
    const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                 "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const p2 = v => String(v).padStart(2, "0");
    const parse = ymd => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ""));
      return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
    };
    const now = new Date();
    const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}`
                + `-${p2(now.getHours())}${p2(now.getMinutes())}`;

    const s = parse(startYmd), e = parse(endYmd);
    if (!s || !e) return `Cibara_Comforts_GSTR1_gen${stamp}.xlsx`;

    // Day 0 of the NEXT month is the last day of this one.
    const lastOfStartMonth = new Date(s.y, s.m, 0).getDate();
    const wholeMonth = s.y === e.y && s.m === e.m
                    && s.d === 1 && e.d === lastOfStartMonth;

    const span = wholeMonth
      ? `${MON[s.m - 1]}-${s.y}`
      : `${p2(s.d)}${MON[s.m - 1]}${s.y}_to_${p2(e.d)}${MON[e.m - 1]}${e.y}`;

    return `Cibara_Comforts_GSTR1_${span}_gen${stamp}.xlsx`;
  }

  async function exportToExcel() {
    if (typeof XLSX === "undefined") {
      alert("Excel library not loaded. Refresh and retry.");
      return;
    }
    if (!state.dateRange.start || !state.dateRange.end) {
      alert("Pick a date range before exporting.");
      return;
    }

    // ── The export IGNORES the on-screen filters, deliberately ──────────────
    // This used to read state.filteredEntries, which is set AFTER the search
    // box and the source / payment / type dropdowns have narrowed the table.
    // Leaving "Show: B2B" selected and clicking Export produced a workbook
    // labelled with the full month whose B2C Summary read zero and whose
    // Table 13 serial range was short, with nothing anywhere recording that a
    // filter had been active. A GST return is not a view of the Bills tab.
    const _reportable = gstReportableEntries();
    if (!_reportable.length) {
      alert("No invoiced bills in this date range to export.");
      return;
    }
    const _ignoredFilters = activeFilterLabels();
    if (_ignoredFilters.length) {
      const ok = confirm(
        `The Bills table is filtered by ${_ignoredFilters.join(", ")}, ` +
        `showing ${state.filteredEntries.length} of ${_reportable.length} documents.\n\n` +
        `The workbook will ignore that filter and export all ` +
        `${_reportable.length} documents for the period, because a GST return ` +
        `must cover the whole period.\n\nContinue?`
      );
      if (!ok) return;
    }

    const period = `${state.dateRange.start} to ${state.dateRange.end}`;
    const r2 = v => +parseFloat(v || 0).toFixed(2);

    // Fetch credit notes for the same period (parallel with bill aggregation
    // — Firestore call, ~200ms typical). If it fails we still produce a
    // best-effort export with empty CN sheets.
    //
    // A failed fetch here is NOT best-effort. An empty creditNotes array is
    // indistinguishable from "this period had no credit notes": the CDNR and
    // B2C Credit Note sheets print "(none in this period)" and the GSTR-3B
    // reversal line reads zero. That understates the output tax reversal on a
    // return the CA signs. So this one aborts the export instead.
    let creditNotes = [];
    let cnLoaded = false;
    let cnFailReason = "";
    try {
      const cnRes = await apiFetch("/list_credit_notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start_date: state.dateRange.start,
          end_date:   state.dateRange.end,
        }),
      });
      if (!cnRes.ok) {
        cnFailReason = `server returned ${cnRes.status}`;
      } else {
        const cnData = await cnRes.json();
        if (cnData && cnData.success) {
          creditNotes = cnData.credit_notes || [];
          cnLoaded = true;
        } else {
          cnFailReason = (cnData && cnData.message) || "unexpected response";
        }
      }
    } catch (err) {
      console.warn("[Bills] export: list_credit_notes failed", err);
      cnFailReason = err && err.message ? err.message : "network error";
    }
    if (!cnLoaded) {
      alert(
        "Export cancelled: the credit notes for this period could not be " +
        `loaded (${cnFailReason}).\n\n` +
        "Exporting now would produce a workbook stating there were NO credit " +
        "notes. If any were issued, the output tax reversal would be missing " +
        "from GSTR-3B and the return would be short.\n\n" +
        "Check your connection and try again."
      );
      return;
    }

    // Pull advances (Table 11A/B) for the same period.
    let advances = [];
    let advLoaded = false;
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
      if (advData && advData.success) {
        advances = advData.advances || [];
        advLoaded = true;
      }
    } catch (err) {
      console.warn("[Bills] export: list_advances failed", err);
    }
    if (!advLoaded) {
      // Not fatal like the credit notes above (Table 11A is a liability the CA
      // can also reconstruct from the bank), but the placeholder row must say
      // "not loaded", never "(none in this period)".
      alert(
        "Note: the advances (Table 11) sheet could not be loaded. The rest of " +
        "the workbook will still export, and that sheet will be stamped " +
        "NOT LOADED so it is not mistaken for a nil return."
      );
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
      // Table 12 accumulators — these span EVERY invoice type (B2C, B2B,
      // B2CL), unlike the accom5/accom18/accomExmpt buckets above which are
      // the B2C-only Table 7 summary.
      hsnAccom:   { taxable: 0, cgst: 0, sgst: 0, value: 0 },
      hsnServices: {},          // "hsn|rate" -> {hsn, rate, description, ...}
      hsnServiceQty: 0,
      accomNights: 0,
      // Real output tax on B2B / B2CL invoices, accumulated from the server's
      // rate-wise rows. The GSTR-3B sheet reads these instead of re-deriving
      // tax from the Table 4 sheet's Rate column.
      b2bTax:     { taxable: 0, cgst: 0, sgst: 0 },
      b2clTax:    { taxable: 0, cgst: 0, sgst: 0 },
      water5:     { taxable: 0, cgst: 0, sgst: 0, igst: 0, mrp: 0 },
      // ── Exempt outward supply — GSTR-1 Table 8 / GSTR-3B 3.1(c) ──────────
      // Table 8 splits on the RECIPIENT'S REGISTRATION, not on the B2B/B2CL/
      // B2C bucket, so this is accumulated separately from accomExmpt (which
      // is B2C-only, for the Table 7 sheet). Every row here is intra-state:
      // place of supply is Karnataka for accommodation (Sec 12(3)(b) IGST
      // Act) and for counter-sold goods (Sec 10(1)(c)). The inter-state rows
      // are still emitted, at zero, because Table 8 has a fixed four-row shape.
      exempt: {
        accomReg: 0, accomUnreg: 0,   // exempt accommodation value
        svcReg:   0, svcUnreg:   0,   // exempt / non-taxable services
      },
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
    const _exportEntries = [..._reportable].sort(
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
        // Authoritative, rate-wise, from the server. `ag` keeps its old shape
        // for the register sheet; the rate-wise rows drive every summary
        // sheet below so a mixed-slab stay lands in the correct buckets
        // instead of being flattened onto one representative rate.
        const bt = billTax(e);
        ag = {
          taxable: bt.accomTaxable,
          cgst: bt.rows.filter(r => r.category === "accommodation")
                       .reduce((s, r) => s + r.cgst, 0),
          sgst: bt.rows.filter(r => r.category === "accommodation")
                       .reduce((s, r) => s + r.sgst, 0),
          rows: bt.rows,
        };
        // Non-accommodation lines, split into taxed rows (any HSN/SAC the
        // server recognised) and genuinely exempt value. `wg` is no longer
        // "water" specifically — it is every taxed service, because laundry
        // at 18% and cold drinks at 12% belong in the return exactly as much
        // as water does.
        const svcRows = bt.rows.filter(r => r.category !== "accommodation");
        wg = {
          taxable: svcRows.reduce((s, r) => s + r.taxable, 0),
          cgst:    svcRows.reduce((s, r) => s + r.cgst, 0),
          sgst:    svcRows.reduce((s, r) => s + r.sgst, 0),
          rows:    svcRows,
          qty:     (e.services || [])
                     .filter(s => !s.accommodation_charge)
                     .reduce((n, s) => n + (Number(s.quantity) || 1), 0),
        };
        wg.mrp = wg.taxable + wg.cgst + wg.sgst;
        nonWaterSvcTotal = Math.max(bt.exempt_value - _accomExemptValue(bt), 0);
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
        // Rate label for the register. `cgstRate` is set only on the
        // cancellation-charge branch, so this used to be `undefined * 2` =
        // NaN on every ordinary bill, and SheetJS writes <v>NaN</v> which
        // Excel refuses to parse. Derive it from the rows actually charged:
        // one number when the stay sat in a single slab, a "0/5" style label
        // when it crossed one, and 0 when there is no accommodation at all.
        "Accom GST Rate %":        (() => {
          if (typeof ag.cgstRate === "number") return ag.cgstRate * 2;
          const rates = [...new Set((ag.rows || [])
            .filter(r => r.category === "accommodation")
            .map(r => Number(r.rate) || 0))].sort((a, b) => a - b);
          if (!rates.length) return 0;
          return rates.length === 1 ? rates[0] : rates.join("/");
        })(),
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

      // ── B2B (Table 4) / B2CL (Table 5) ───────────────────────────────────
      // ONE ROW PER RATE, which is what the GSTN offline utility expects and
      // what a mixed-slab stay actually is. A single row carrying the whole
      // bill's taxable value against one "representative" rate is a row the
      // utility recomputes and rejects.
      //
      // Taxed services on a B2B invoice are emitted as their own rows at their
      // own HSN/rate rather than being folded into the accommodation line.
      if (invoiceType === "B2B" || invoiceType === "B2CL") {
        const invoiceDate  = (e.checkout_time || "").split(" ")[0];
        const invoiceValue = r2(e.total_amount || 0);
        const allRows = [...(ag.rows || []), ...(wg.rows || [])];

        for (const r of allRows) {
          if (r.taxable <= 0 && r.tax <= 0) continue;
          // Accumulate the REAL tax for the 3B sheet. It used to be
          // re-derived there as Taxable x Rate / 200, which restated a
          // mixed-slab bill by up to 87%.
          if (invoiceType === "B2B") {
            b.b2bTax.taxable += r.taxable;
            b.b2bTax.cgst    += r.cgst;
            b.b2bTax.sgst    += r.sgst;
            b2bRows.push({
              "GSTIN/UIN of Recipient": recipientGstin,
              "Receiver Name":          recipientName,
              "Invoice Number":         e.bill_number || "",
              "Invoice Date":           invoiceDate,
              "Invoice Value":          invoiceValue,
              "Place Of Supply":        "29-Karnataka",
              "Reverse Charge":         "N",
              "Applicable % of Tax Rate": "",
              "Invoice Type":           "Regular B2B",
              "E-Commerce GSTIN":       "",
              "Rate":                   r.rate,
              "Taxable Value":          r2(r.taxable),
              "Cess Amount":            0,
            });
          } else {
            b.b2clTax.taxable += r.taxable;
            b.b2clTax.cgst    += r.cgst;
            b.b2clTax.sgst    += r.sgst;
            b2clRows.push({
              "Invoice Number":         e.bill_number || "",
              "Invoice Date":           invoiceDate,
              "Invoice Value":          invoiceValue,
              // B2CL is by definition an inter-state supply to an
              // unregistered person — but place of supply for accommodation
              // is still the property (Section 12(3)(b)), so a lodge should
              // not normally produce B2CL rows at all. Reported honestly
              // rather than silently dropped, so a stray one is visible.
              "Place Of Supply":        "29-Karnataka",
              "Applicable % of Tax Rate": "",
              "Rate":                   r.rate,
              "Taxable Value":          r2(r.taxable),
              "Cess Amount":            0,
              "E-Commerce GSTIN":       "",
            });
          }
        }
      }

      // ── B2C summary (Table 7) — bucketed PER RATE ────────────────────────
      // Excludes B2B (Table 4), B2CL (Table 5) and cancellation charges
      // (separate SAC 999794 bucket below).
      //
      // Each accommodation row is filed against ITS OWN rate. This used to
      // switch on a single representative rate for the whole bill, so a stay
      // with a 5% night and an exempt night put the exempt night's value into
      // the 5% bucket — a row where Taxable x Rate did not equal the tax, which
      // the GSTN utility recomputes and rejects.
      if (invoiceType === "B2C" && !isCancelCharge) {
        for (const r of (ag.rows || [])) {
          if (r.category !== "accommodation") continue;
          const bucket = r.rate === 18 ? b.accom18
                       : r.rate === 5  ? b.accom5
                       : r.rate === 0  ? b.accomExmpt
                       : null;
          if (!bucket) {
            console.warn("[Bills] unmapped accommodation rate in export:", r.rate);
            continue;
          }
          bucket.taxable += r.taxable;
          if (r.rate > 0) { bucket.cgst += r.cgst; bucket.sgst += r.sgst; }
        }
      }
      if (isCancelCharge) {
        b.cancel18.taxable += ag.taxable;
        b.cancel18.cgst    += ag.cgst;
        b.cancel18.sgst    += ag.sgst;
        b.cancel18.count   += 1;
      }

      // ── Exempt outward supply (GSTR-1 Table 8 / GSTR-3B 3.1(c)) ──────────
      // Runs for EVERY invoice type, not just B2C: a corporate folio can
      // carry exempt nights too, and Table 8 has a row for exempt supplies to
      // registered persons. Split on the recipient's GSTIN, which is what
      // Table 8 keys on.
      //
      // This value must NOT also be summed into 3.1(a). It used to be — the
      // exempt row was included in the B2C total that fed "Outward taxable
      // supplies" — which reported exempt turnover as taxable and left 3.1(c)
      // blank. Rule 88C compares GSTR-1 against GSTR-3B and raises a DRC-01B
      // intimation on exactly that mismatch, and an unanswered DRC-01B blocks
      // the next GSTR-1 filing.
      if (!isCancelCharge) {
        const _regRecipient = !!(recipientGstin || "").trim();
        let _exemptAccom = 0;
        for (const r of (ag.rows || [])) {
          if (r.category !== "accommodation") continue;
          if (r.rate !== 0) continue;
          _exemptAccom += r.taxable;
        }
        const _exemptSvc = nonWaterSvcTotal || 0;
        if (_regRecipient) {
          b.exempt.accomReg += _exemptAccom;
          b.exempt.svcReg   += _exemptSvc;
        } else {
          b.exempt.accomUnreg += _exemptAccom;
          b.exempt.svcUnreg   += _exemptSvc;
        }
      }

      // ── HSN/SAC (Table 12) — EVERY invoice type ──────────────────────────
      // Table 12 is a rate-wise summary of ALL outward supply; it is not
      // scoped to B2C. Accommodation on B2B and B2CL invoices was previously
      // never added here, so a period whose sales were B2B reported its
      // accommodation in Table 4 and showed zero against SAC 996311 in
      // Table 12.
      if (!isCancelCharge) {
        for (const r of (ag.rows || [])) {
          if (r.category !== "accommodation") continue;
          b.hsnAccom.taxable += r.taxable;
          b.hsnAccom.cgst    += r.cgst;
          b.hsnAccom.sgst    += r.sgst;
          b.hsnAccom.value   += r.taxable + r.cgst + r.sgst;
        }
      }
      // Taxed non-accommodation lines, keyed by (HSN/SAC, rate) so laundry at
      // 18% and cold drinks at 12% get their own Table 12 rows instead of
      // being silently dropped or lumped in with water.
      for (const r of (wg.rows || [])) {
        const key = `${r.hsn}|${r.rate}`;
        const grp = b.hsnServices[key] || (b.hsnServices[key] = {
          hsn: r.hsn, rate: r.rate, description: r.description,
          taxable: 0, cgst: 0, sgst: 0, value: 0, qty: 0,
        });
        grp.taxable += r.taxable;
        grp.cgst    += r.cgst;
        grp.sgst    += r.sgst;
        grp.value   += r.taxable + r.cgst + r.sgst;
      }
      b.hsnServiceQty += wg.qty || 0;
      b.accomNights   += Number(e.days_stayed || 0) || 0;

      // Retained for the legacy water columns elsewhere in the workbook.
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
    // A B2C credit note at any rate other than 5 or 18 matches no row above,
    // so Table 7 cannot net it. Rather than dropping it silently, park it here
    // and deduct it explicitly on the GSTR-3B net-output line, flagged for the
    // CA. Zero-rate credit notes land here too, which is correct: they carry
    // no tax and nothing should be deducted for them.
    let b2cCnUnmappedTaxable = 0, b2cCnUnmappedCgst = 0, b2cCnUnmappedSgst = 0;
    let b2cCnUnmappedCount = 0;
    creditNotes.forEach(cn => {
      const isB2B = !!(cn.recipient_gstin || "").trim();
      if (isB2B) return;
      const rate = parseInt(cn.gst_rate, 10) || 0;
      const tax  = parseFloat(cn.credit_amount_taxable || 0);
      const cgst = parseFloat(cn.credit_amount_cgst || 0);
      const sgst = parseFloat(cn.credit_amount_sgst || 0);
      if (rate === 18) { b2cCnTaxable18 += tax; b2cCnCgst18 += cgst; b2cCnSgst18 += sgst; }
      else if (rate === 5) { b2cCnTaxable5  += tax; b2cCnCgst5  += cgst; b2cCnSgst5  += sgst; }
      else {
        b2cCnUnmappedTaxable += tax;
        b2cCnUnmappedCgst    += cgst;
        b2cCnUnmappedSgst    += sgst;
        b2cCnUnmappedCount   += 1;
        console.warn("[Bills] export: B2C credit note at unmapped rate", rate, cn.cn_number);
      }
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
        "Remarks":               "Room charges below ₹1,000/night. EXEMPT — goes to GSTR-3B 3.1(c) and GSTR-1 Table 8, NOT 3.1(a). See the 'Exempt (Table 8)' sheet.",
      },
      {
        "Description":           "Other services — exempt / non-taxable (B2C only)",
        "Place of Supply":       "Karnataka (KA-29)",
        "Applicable % of Tax":   "0%",
        "Integrated Tax Amount": 0, "Central Tax Amount": 0,
        "State/UT Tax Amount":   0, "Cess Amount": 0,
        "Total Taxable Value":   r2(b.exempt.svcUnreg),
        "Remarks":               "Service lines the server matched to no HSN/SAC. EXEMPT — 3.1(c) / Table 8, NOT 3.1(a).",
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
    // GSTR-3B 3.1(a) is the TAXABLE row. Exempt value belongs in 3.1(c) and
    // GSTR-1 Table 8, so it is split out of `allTaxbl` here rather than summed
    // in. Keying off the row's own stated rate keeps this correct if another
    // exempt row is ever added above.
    const _isExemptRow = r =>
      String(r["Applicable % of Tax"] || "").trim() === "0%";
    const allCgst = r2(b2cRows.reduce((s, r) => s + parseFloat(r["Central Tax Amount"] || 0), 0));
    const allSgst = r2(b2cRows.reduce((s, r) => s + parseFloat(r["State/UT Tax Amount"] || 0), 0));
    const allTaxbl = r2(b2cRows
      .filter(r => !_isExemptRow(r))
      .reduce((s, r) => s + parseFloat(r["Total Taxable Value"] || 0), 0));
    const exemptTaxblB2C = r2(b2cRows
      .filter(_isExemptRow)
      .reduce((s, r) => s + parseFloat(r["Total Taxable Value"] || 0), 0));
    b2cRows.push({
      "Description":           "TOTAL — TAXABLE only (B2C, net of CNs)  →  GSTR-3B 3.1(a)",
      "Place of Supply":       "",
      "Applicable % of Tax":   "",
      "Integrated Tax Amount": 0,
      "Central Tax Amount":    allCgst,
      "State/UT Tax Amount":   allSgst,
      "Cess Amount":           0,
      "Total Taxable Value":   allTaxbl,
      "Remarks":               `Period: ${period}. Excludes the exempt rows above.`,
    });
    b2cRows.push({
      "Description":           "TOTAL — EXEMPT (B2C)  →  GSTR-3B 3.1(c) / GSTR-1 Table 8",
      "Place of Supply":       "",
      "Applicable % of Tax":   "",
      "Integrated Tax Amount": 0,
      "Central Tax Amount":    0,
      "State/UT Tax Amount":   0,
      "Cess Amount":           0,
      "Total Taxable Value":   exemptTaxblB2C,
      "Remarks":               "Value only, no tax. Do NOT add this to 3.1(a).",
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
    //
    // Table 12 is a rate-wise summary of ALL outward supply, so it is built
    // from b.hsnAccom / b.hsnServices — accumulators that span B2C, B2B and
    // B2CL. It used to be built from the B2C-only Table 7 buckets, so a period
    // whose sales were B2B reported its accommodation in Table 4 and then
    // showed zero against SAC 996311 here.
    //
    // Quantities and values are now accumulated over the SAME population.
    // Previously the value columns skipped cancelled bills while the quantity
    // columns counted `state.filteredEntries` including them.
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
        "HSN/SAC Code":          "996311",
        "Description":           "Accommodation and Hospitality Services",
        "UQC":                   "NOS",
        "Total Quantity":        b.accomNights,
        "Total Value (MRP)":     r2(b.hsnAccom.value),
        "Taxable Value":         r2(b.hsnAccom.taxable),
        "IGST Amount":           0,
        "CGST Amount":           r2(b.hsnAccom.cgst),
        "SGST Amount":           r2(b.hsnAccom.sgst),
        "Total GST":             r2(b.hsnAccom.cgst + b.hsnAccom.sgst),
        "Applicable GST Rate":   "0% / 5% / 18% (slab based)",
      },
      // One row per (HSN/SAC, rate) actually sold. Water, cold drinks,
      // laundry, tea/coffee and transport each get their own row at their own
      // rate; this sheet used to carry a single hardcoded water row and drop
      // everything else.
      ...Object.values(b.hsnServices)
        .sort((x, y) => (x.hsn + x.rate).localeCompare(y.hsn + y.rate))
        .map((g) => ({
          "HSN/SAC Code":        g.hsn,
          "Description":         g.description,
          "UQC":                 "NOS",
          "Total Quantity":      b.hsnServiceQty,
          "Total Value (MRP)":   r2(g.value),
          "Taxable Value":       r2(g.taxable),
          "IGST Amount":         0,
          "CGST Amount":         r2(g.cgst),
          "SGST Amount":         r2(g.sgst),
          "Total GST":           r2(g.cgst + g.sgst),
          "Applicable GST Rate": `${g.rate}% (MRP inclusive)`,
        })),
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
        // An inter-state credit note routes its whole tax into IGST. This
        // column used to be absent, so that tax was invisible on every sheet.
        "IGST":                       r2(cn.credit_amount_igst || 0),
        "Guest Name":                 cn.guest_name || "",
        "Room":                       cn.room || "",
      }));
    const wsB2CCN = XLSX.utils.json_to_sheet(b2cCnRows.length ? b2cCnRows : [{
      "CN Number": "(none in this period)",
      "CN Date":"","Original Invoice Number":"","Original Invoice Date":"",
      "Reason":"","Reason Narrative":"","Place of Supply":"","CN Value":0,
      "Rate":0,"Taxable Value":0,"CGST":0,"SGST":0,"IGST":0,
      "Guest Name":"","Room":"",
    }]);

    // ── Sheet: Exempt / Nil-rated / Non-GST outward supplies (Table 8) ──────
    // Fixed four-row shape, split on the recipient's registration and on
    // inter- vs intra-state. The lodge's place of supply is always Karnataka
    // (Sec 12(3)(b) IGST Act for accommodation, Sec 10(1)(c) for goods handed
    // over at the counter), so the inter-state rows are structurally zero —
    // emitted anyway so the sheet matches the portal's layout row for row.
    //
    // Everything here is "Exempted", not "Nil Rated": nil-rated means a
    // taxable supply at a 0% rate, whereas this value is exempt by
    // notification. If the exempt band in _slab_for_value is ever withdrawn,
    // these rows go to zero on their own and 3.1(a) picks the value up.
    const t8Rows = [
      { "Description": "Inter-State supplies to registered persons",
        "Nil Rated Supplies": 0, "Exempted (other than nil rated/non-GST)": 0,
        "Non-GST Supplies": 0,
        "Note": "Structurally nil — place of supply is always Karnataka" },
      { "Description": "Intra-State supplies to registered persons",
        "Nil Rated Supplies": 0,
        "Exempted (other than nil rated/non-GST)": r2(b.exempt.accomReg + b.exempt.svcReg),
        "Non-GST Supplies": 0,
        "Note": `Accommodation ${r2(b.exempt.accomReg)} + other services ${r2(b.exempt.svcReg)}` },
      { "Description": "Inter-State supplies to unregistered persons",
        "Nil Rated Supplies": 0, "Exempted (other than nil rated/non-GST)": 0,
        "Non-GST Supplies": 0,
        "Note": "Structurally nil — place of supply is always Karnataka" },
      { "Description": "Intra-State supplies to unregistered persons",
        "Nil Rated Supplies": 0,
        "Exempted (other than nil rated/non-GST)": r2(b.exempt.accomUnreg + b.exempt.svcUnreg),
        "Non-GST Supplies": 0,
        "Note": `Accommodation ${r2(b.exempt.accomUnreg)} + other services ${r2(b.exempt.svcUnreg)}` },
      { "Description": "TOTAL  →  GSTR-3B 3.1(c)",
        "Nil Rated Supplies": 0,
        "Exempted (other than nil rated/non-GST)":
          r2(b.exempt.accomReg + b.exempt.svcReg +
             b.exempt.accomUnreg + b.exempt.svcUnreg),
        "Non-GST Supplies": 0,
        "Note": "Must NOT also appear in 3.1(a). Cross-check against the B2C Summary sheet's exempt total." },
    ];
    const wsExempt = XLSX.utils.json_to_sheet(t8Rows);

    // Sheet 8: GSTR-3B Summary (output tax / ITC / RCM / net cash)
    // ITC and RCM are NOT computed here — the operator's CA will fill them
    // from expenses with vendor_gstin. We surface output tax + a placeholder
    // for ITC/RCM with a clear UNCERTAINTY note.
    const totalOutputCgst = r2(allCgst);
    const totalOutputSgst = r2(allSgst);
    // B2B and B2CL output tax, taken from the accumulated per-rate figures.
    // This used to be re-derived as Taxable x Rate / 200 off the Table 4
    // sheet, which restated any mixed-slab bill and contradicted its own
    // source rows. B2CL was omitted entirely, so its output tax appeared in
    // no summary sheet at all.
    const b2bOutputCgst = r2(b.b2bTax.cgst + b.b2clTax.cgst);
    const b2bOutputSgst = r2(b.b2bTax.sgst + b.b2clTax.sgst);

    // ── Credit notes, split the way the sheets above are split ─────────────
    // The B2C rows of the Table 7 sheet are ALREADY net of B2C credit notes
    // (see the netting block above), and `allCgst` / `totalOutputCgst` is the
    // sum of those rows. So the net-output line must deduct the B2B credit
    // notes ONLY. It used to deduct the full CN total on top of the already
    // netted B2C figure, so every B2C credit note was subtracted twice and the
    // tax payable came out short by exactly one CN's worth of tax.
    const _cnIsB2B = cn => !!(cn.recipient_gstin || "").trim();
    const _cnSum = (arr, k) =>
      r2(arr.reduce((s, cn) => s + parseFloat(cn[k] || 0), 0));
    const cnB2B = creditNotes.filter(_cnIsB2B);
    const cnB2C = creditNotes.filter(cn => !_cnIsB2B(cn));
    const b2bCnTaxable = _cnSum(cnB2B, "credit_amount_taxable");
    const b2bCnCgst    = _cnSum(cnB2B, "credit_amount_cgst");
    const b2bCnSgst    = _cnSum(cnB2B, "credit_amount_sgst");
    const b2bCnIgst    = _cnSum(cnB2B, "credit_amount_igst");
    const b2cCnTaxableAll = _cnSum(cnB2C, "credit_amount_taxable");
    const b2cCnCgstAll    = _cnSum(cnB2C, "credit_amount_cgst");
    const b2cCnSgstAll    = _cnSum(cnB2C, "credit_amount_sgst");
    const b2cCnIgstAll    = _cnSum(cnB2C, "credit_amount_igst");

    const _exemptTotal = r2(exemptTaxblB2C + b.exempt.accomReg + b.exempt.svcReg);
    const _unmappedNote = b2cCnUnmappedCount
      ? `Includes ${b2cCnUnmappedCount} B2C credit note(s) at a rate other than 5%/18% that Table 7 could not net — CA to verify`
      : "";
    const _igstNote = (b2bCnIgst || b2cCnIgstAll)
      ? "IGST appears only on credit notes here — accommodation is always intra-state, so check the original invoice"
      : "";

    const gstr3b = [
      { "Item": "3.1(a) Outward taxable supplies — B2C (accommodation + goods/services)",
        "Taxable Value": allTaxbl, "CGST": totalOutputCgst, "SGST": totalOutputSgst,
        "IGST": 0, "Cess": 0,
        "Note": "Already NET of B2C credit notes" },
      { "Item": "3.1(a) Outward taxable supplies — B2B + B2CL",
        "Taxable Value": r2(b.b2bTax.taxable + b.b2clTax.taxable),
        "CGST": b2bOutputCgst, "SGST": b2bOutputSgst, "IGST": 0, "Cess": 0,
        "Note": "GROSS — B2B credit notes deducted two rows below" },
      { "Item": "3.1(c) Other outward supplies (Nil rated, exempted)",
        "Taxable Value": _exemptTotal,
        "CGST": 0, "SGST": 0, "IGST": 0, "Cess": 0,
        "Note": "Value only, no tax. Detail in the 'Exempt (Table 8)' sheet." },
      { "Item": "(less) Credit notes — B2B / CDNR",
        "Taxable Value": b2bCnTaxable, "CGST": b2bCnCgst, "SGST": b2bCnSgst,
        "IGST": b2bCnIgst, "Cess": 0,
        "Note": "Deducted from the net output line below" },
      { "Item": "(memo) Credit notes — B2C, ALREADY netted into the B2C row above",
        "Taxable Value": b2cCnTaxableAll, "CGST": b2cCnCgstAll, "SGST": b2cCnSgstAll,
        "IGST": b2cCnIgstAll, "Cess": 0,
        "Note": "MEMO ONLY — do NOT subtract again" },
      { "Item": "Net output tax (after credit note reversal)",
        "Taxable Value": "(see CA reconciliation)",
        "CGST": r2(totalOutputCgst + b2bOutputCgst - b2bCnCgst - b2cCnUnmappedCgst),
        "SGST": r2(totalOutputSgst + b2bOutputSgst - b2bCnSgst - b2cCnUnmappedSgst),
        "IGST": r2(0 - b2bCnIgst - b2cCnIgstAll), "Cess": 0,
        "Note": [_unmappedNote, _igstNote].filter(Boolean).join(" | ") },
      { "Item": "Eligible ITC from expenses (NOT auto-computed — CA to fill)",
        "Taxable Value": "—", "CGST": "—", "SGST": "—", "IGST": "—", "Cess": "—",
        "Note": "" },
      { "Item": "RCM liability on OTA commission (NOT auto-computed — see migration doc)",
        "Taxable Value": "—", "CGST": "—", "SGST": "—", "IGST": "—", "Cess": "—",
        "Note": "" },
      { "Item": "Net cash payable",
        "Taxable Value": "(net output - ITC + RCM)",
        "CGST": "—", "SGST": "—", "IGST": "—", "Cess": "—",
        "Note": "" },
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
    // An empty sheet must distinguish "there were none" from "we could not
    // check" — the two read identically to a CA and only one is safe to file.
    const wsAdvances = XLSX.utils.json_to_sheet(advRows.length ? advRows : [{
      "Status": advLoaded
        ? "(none in this period)"
        : "*** NOT LOADED — the advances endpoint failed. DO NOT treat this sheet as nil. ***",
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
      // Provenance: what this file actually covers. The export deliberately
      // ignores the Bills tab's on-screen filters; recording that here means a
      // CA never has to take it on trust.
      { "Field": "Documents Exported",        "Value": `${_reportable.length} numbered documents (all statuses: completed, pending_settlement, cancelled)` },
      { "Field": "On-screen Filters",         "Value": _ignoredFilters.length
                                                  ? `IGNORED by design: ${_ignoredFilters.join(", ")} (table was showing ${state.filteredEntries.length})`
                                                  : "none active" },
      { "Field": "Exempt Supplies",           "Value": "Exempt accommodation and services are reported in the 'Exempt (Table 8)' sheet and GSTR-3B 3.1(c). They are EXCLUDED from 3.1(a). Note: the sub-₹1,000 exemption (Entry 14, Notn. 12/2017-CTR) was omitted by Notn. 04/2022-CTR w.e.f. 18-Jul-2022 — if the CA's position is that it does not apply, these sheets go to zero and the value moves to the 5% rows." },
      { "Field": "Credit Notes",              "Value": "B2C credit notes are netted INSIDE the B2C Summary rows. The GSTR-3B net-output line therefore deducts B2B/CDNR credit notes only — deducting the full CN total again would double-count." },
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
      XLSX.utils.book_append_sheet(wb, wsExempt, "Exempt (Table 8)");
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
      XLSX.writeFile(wb, _workbookFileName(state.dateRange.start,
                                           state.dateRange.end));
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

  // ── Known GST recipients — type-ahead + autofill ─────────────────────────
  // Companies this lodge has invoiced before, offered as you type. Re-keying
  // a 15-character GSTIN by hand is where B2B invoices go wrong: one wrong
  // character and the customer cannot claim the credit, and nobody finds out
  // until they reconcile GSTR-2B weeks later.
  //
  // Deliberately an OFFER, never an automatic application. Picking a company
  // fills the other three fields; typing a GSTIN that happens to match one
  // fills them too, but only while they are still empty — see _gstAutofill.
  // The same guest can stay on company business one week and privately the
  // next, so nothing is ever stamped on without the operator choosing it.
  let _gstKnown = null;          // null = never loaded, [] = loaded, none found
  let _gstKnownFailed = false;   // distinguishes "none exist" from "load failed"
  let _gstKnownWhy = "";         // the reason, in words the operator can act on
  let _gstInFlight = null;       // the running fetch, so two opens share one call
  let _gstSuppressOpen = false;  // true while replaying a synthetic input event

  // Was the last attempt a success? A failed attempt must NOT be remembered
  // as "loaded", or the modal is dead for the rest of the page's life.
  //
  // This is the bug that made a real, existing company invisible. The old
  // version set `_gstKnown = []` up front as a re-entrancy guard and then
  // returned that same [] on every error path, while the only cache check
  // was `if (_gstKnown !== null) return`. So one bad first load — the server
  // not yet restarted, a dropped connection, a session that had just
  // expired — pinned an empty directory in memory until the operator
  // reloaded the whole page, and every later open silently short-circuited
  // to nothing. Nothing on screen said so. It just looked broken.
  function _gstNeedsLoad() {
    return _gstKnown === null || _gstKnownFailed;
  }

  async function _loadGstKnown(force) {
    if (!force && !_gstNeedsLoad()) return _gstKnown;
    if (_gstInFlight) return _gstInFlight;   // share one in-flight request
    _gstInFlight = _fetchGstKnown().finally(() => { _gstInFlight = null; });
    return _gstInFlight;
  }

  async function _fetchGstKnown() {
    _gstKnownFailed = false;
    _gstKnownWhy = "";
    try {
      const res = await apiFetch("/gst_recipients", { method: "GET" });
      if (!res.ok) {
        // Name the actual cause. "Could not load" on its own sent us hunting
        // through query syntax and permissions when the answer was that the
        // server had not been restarted — a new Python route does not exist
        // until the Flask process reloads, so it 404s while the browser
        // happily picks up the new JS.
        _gstKnownFailed = true;
        _gstKnownWhy =
          res.status === 404
            ? "the server needs a restart to pick up this feature"
            : res.status === 403
              ? "your account lacks the bill.gst.edit permission"
              : res.status === 401
                ? "your session expired — sign in again"
                : `server error ${res.status}`;
        return _gstKnown || [];
      }
      const data = await res.json().catch(() => ({}));
      if (data && data.success && Array.isArray(data.recipients)) {
        _gstKnown = data.recipients;
        _gstKnownFailed = !!data.degraded;
        if (data.degraded) _gstKnownWhy = "the lookup failed on the server";
      } else {
        _gstKnownFailed = true;
        _gstKnownWhy = (data && data.message) || "unexpected response";
      }
    } catch (e) {
      // A convenience feature must never block the modal. Typing by hand
      // still works exactly as before.
      _gstKnownFailed = true;
      _gstKnownWhy = "could not reach the server";
      console.warn("[Bills] gst_recipients unavailable", e);
    }
    if (_gstKnown === null) _gstKnown = [];
    return _gstKnown;
  }

  function _gstRenderKnown() {
    const hint = dom("bl-gst-known-hint");
    if (!hint) return;
    // Still loading: say nothing rather than "none yet", which is a claim we
    // cannot make until the fetch lands.
    if (_gstKnown === null) { hint.style.display = "none"; hint.innerHTML = ""; return; }
    const rows = _gstKnown || [];

    // This line now carries ONLY the states the dropdown cannot express.
    //
    // It used to also render a row of "recently invoiced" chips. That was a
    // workaround for the <datalist> being invisible, and once the real
    // dropdown replaced the datalist the chips became a second, redundant
    // picker — and worse, an empty teal bar under the field whenever the
    // strip rendered with nothing to show. The dropdown opens on focus and
    // filters as you type, so there is nothing left for chips to add.
    //
    // The empty and failed states still belong here: a dropdown that never
    // opens looks exactly like a dropdown that is broken, so those two cases
    // have to say which they are.
    if (rows.length) {
      hint.style.display = "none";
      hint.innerHTML = "";
      return;
    }

    hint.style.display = "";
    hint.className = "bl-gst-known-hint bl-gst-known-empty";
    hint.textContent = _gstKnownFailed
      ? `Suggestions unavailable — ${_gstKnownWhy || "unknown reason"}. ` +
        `Type the details in by hand.`
      : "No previously invoiced companies yet. The first B2B bill you save will appear here.";
  }


  // Fill the remaining fields from a matched company.
  //
  // `force` is true when the operator explicitly picked from the list, and
  // false when we merely noticed the typed GSTIN matches one. In the second
  // case only BLANK fields are filled, so a half-typed correction is never
  // overwritten under the operator's hands.
  function _gstAutofill(gstin, force) {
    const rec = (_gstKnown || []).find(
      r => r.gstin === String(gstin || "").trim().toUpperCase());
    if (!rec) return false;

    // Track what was actually written. The first version announced
    // "Filled from NEERAJ" whenever a GSTIN matched, even when the stored
    // record carried nothing but the GSTIN itself — so the operator was told
    // the form had been filled while Legal Name sat empty in front of them.
    const filled = [];
    [["bl-gst-legal", rec.legal_name, "legal name"],
     ["bl-gst-trade", rec.trade_name, "trade name"],
     ["bl-gst-addr",  rec.address,    "address"]].forEach(([id, val, label]) => {
      const el = dom(id);
      if (!el || !val) return;
      if (force || !el.value.trim()) { el.value = val; filled.push(label); }
    });

    // Write to its OWN node. This used to set hint.textContent, and the hint
    // is where the company chips live — so the moment autofill ran, the list
    // the operator was picking from vanished and could not be reopened
    // without closing and reopening the modal.
    const st = dom("bl-gst-fill-status");
    if (st) {
      const who = rec.trade_name || rec.legal_name || rec.gstin;
      st.style.display = "";
      if (filled.length) {
        st.className = "bl-gst-fill-status ok";
        st.textContent = `Filled ${filled.join(", ")} from ${who}` +
          (rec.last_used ? ` · last invoiced ${rec.last_used}` : "") +
          (rec.count > 1 ? ` · ${rec.count} invoices` : "");
      } else if (!rec.legal_name && !rec.trade_name && !rec.address) {
        // Matched, but the stored record really is bare.
        st.className = "bl-gst-fill-status warn";
        st.textContent = `${who} is on file, but no legal name or address was ` +
          `saved with it — please fill those in.`;
      } else {
        // Matched, the record has data, and nothing was written because the
        // form already holds it. Say nothing rather than contradict the
        // message we just showed: picking a row fires a synthetic "input"
        // event to re-run the GSTIN validator, and that second pass filled
        // nothing (the fields were no longer blank) - so the old code
        // immediately replaced "Filled legal name, address from NEERAJ" with
        // "no legal name or address was saved with it", which is false and
        // reads as a broken record.
        st.style.display = "none";
        st.textContent = "";
      }
    }
    return true;
  }

  function _gstClearFillStatus() {
    const st = dom("bl-gst-fill-status");
    if (st) { st.style.display = "none"; st.textContent = ""; }
  }

  // ── GSTIN suggestion dropdown ────────────────────────────────────────────
  // Deliberately the same interaction as the guest lookup on check-in: type a
  // few characters, a list drops under the field, click a row and the form
  // fills. Same .ms-* classes, so it is the same component visually and there
  // is one pattern to learn rather than two.
  //
  // Filtering runs on the client against the list fetched when the modal
  // opened. The directory is one row per company ever invoiced, so a round
  // trip per keystroke would be latency for nothing.

  function _gstHideSuggestions() {
    const el = dom("bl-gst-suggestions");
    if (el) el.style.display = "none";
  }

  // Match on GSTIN or on company name, because the operator remembers the
  // company, not the 15 characters. An empty query lists the most recent,
  // which is what makes the feature visible at all on focus.
  function _gstMatches(q) {
    const rows = _gstKnown || [];
    const t = String(q || "").trim().toUpperCase();
    if (!t) return rows.slice(0, 8);
    return rows.filter(r =>
      String(r.gstin || "").toUpperCase().includes(t) ||
      String(r.trade_name || "").toUpperCase().includes(t) ||
      String(r.legal_name || "").toUpperCase().includes(t)
    ).slice(0, 8);
  }

  function _fmtGstDate(d) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ""));
    if (!m) return String(d || "");
    const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return m[3] + " " + MON[Number(m[2]) - 1] + " " + m[1];
  }

  // Show one non-clickable line instead of an empty box. Every state the
  // dropdown can be in has to be visible, because "nothing dropped down" is
  // indistinguishable from "the feature is broken" from the operator's side
  // of the screen, and that ambiguity is exactly what cost us this bug.
  function _gstNote(el, text, cls) {
    el.innerHTML = "";
    const row = document.createElement("div");
    row.className = "bl-gst-note" + (cls ? " " + cls : "");
    row.textContent = text;
    el.appendChild(row);
    el.style.display = "block";
  }

  // A thrown error inside the renderer used to mean the list simply never
  // opened - the exact failure this whole fix is about. Catch it here so the
  // next one announces itself on screen instead of hiding for weeks.
  function _gstRenderSuggestions(q) {
    try {
      _gstRenderSuggestionsInner(q);
    } catch (e) {
      console.error("[Bills] GST suggestion render failed", e);
      const el = dom("bl-gst-suggestions");
      if (el) _gstNote(el, "Suggestions could not be drawn. Type the details " +
                           "in by hand.", "warn");
    }
  }

  function _gstRenderSuggestionsInner(q) {
    const el = dom("bl-gst-suggestions");
    if (!el) return;

    // Order matters: a FAILED load also leaves _gstKnown at null, so the
    // failure has to be reported first or a dead feature reads as "Loading"
    // forever.
    if (_gstKnownFailed) {
      _gstNote(el,
        "Suggestions unavailable \u2014 " + (_gstKnownWhy || "unknown reason") +
        ". Type the details in by hand.", "warn");
      return;
    }

    // Still fetching. The old code rendered zero hits and hid the list, so
    // an operator who clicked the field and started typing straight away -
    // which is what everybody does - raced the request and saw nothing, and
    // nothing re-rendered when the data finally arrived.
    if (_gstKnown === null) {
      _gstNote(el, "Loading previously invoiced companies\u2026", "muted");
      return;
    }

    const hits = _gstMatches(q);
    if (!hits.length) {
      const rows = _gstKnown || [];
      _gstNote(el, rows.length
        ? "No match in " + rows.length + " previously invoiced " +
          (rows.length === 1 ? "company" : "companies")
        : "No previously invoiced companies yet", "muted");
      return;
    }

    el.innerHTML = "";
    hits.forEach((r) => {
      const row = document.createElement("div");
      row.className = "ms-row";
      const name = r.trade_name || r.legal_name || "(no name on file)";
      const sub = [r.gstin];
      if (r.last_used) sub.push(_fmtGstDate(r.last_used));
      const n = Number(r.count || 0);
      if (n > 0) sub.push(n + " invoice" + (n > 1 ? "s" : ""));
      // Built with textContent, not an HTML string.
      //
      // This line is why the dropdown appeared dead. It called escapeAttr(),
      // which is a PRIVATE function inside register.js's IIFE - it was never
      // a global, so in this module it is simply undefined. The moment a
      // company matched, the loop threw ReferenceError on the first row, the
      // `el.style.display = "block"` at the end of the function never ran,
      // and the list stayed hidden. No match, no error on screen, nothing:
      // the failure looked exactly like "there are no companies on file",
      // which is why "29AAWFC1962B1Z9 exists but 29AA shows nothing".
      //
      // textContent removes the whole class of problem. Company names and
      // addresses are operator-typed free text, so they must never be
      // concatenated into markup anyway - an apostrophe in "O'Brien & Co"
      // is a bug waiting in an escaping helper, and no bug at all here.
      const main = document.createElement("div");
      main.className = "ms-main";
      const nameEl = document.createElement("div");
      nameEl.className = "ms-name";
      nameEl.textContent = name;
      const subEl = document.createElement("div");
      subEl.className = "ms-sub";
      subEl.textContent = sub.join(" \u00b7 ");
      main.appendChild(nameEl);
      main.appendChild(subEl);
      row.appendChild(main);
      row.addEventListener("mousedown", (ev) => {
        // mousedown, not click: the input's blur fires first and would hide
        // the list before a click ever landed on it.
        ev.preventDefault();
        const gi = dom("bl-gst-gstin");
        if (gi) gi.value = r.gstin;
        _gstHideSuggestions();
        _gstAutofill(r.gstin, true);
        // Let the existing validator light up the state chip and checksum
        // hint exactly as if the GSTIN had been typed - but suppress the
        // suggestion redraw, or the list the operator just picked from
        // springs straight back open under their cursor.
        _gstSuppressOpen = true;
        try {
          if (gi) gi.dispatchEvent(new Event("input", { bubbles: true }));
        } finally {
          _gstSuppressOpen = false;
        }
      });
      el.appendChild(row);
    });
    el.style.display = "block";
  }

  // Redraw whatever is on screen once the directory arrives. Without this the
  // dropdown is a snapshot of the moment it was opened and never updates.
  function _gstRepaint(inp) {
    _gstRenderKnown();
    const el = dom("bl-gst-suggestions");
    const focused = document.activeElement === inp;
    const open = el && el.style.display !== "none";
    if (focused || open) _gstRenderSuggestions(inp ? inp.value : "");
  }

  function _wireGstAutofill() {
    const inp = dom("bl-gst-gstin");
    if (!inp || inp.dataset.gstAutofillBound) return;
    inp.dataset.gstAutofillBound = "1";
    // Focus lists the most recent companies immediately. This is the
    // discoverability fix: the previous version used a <datalist>, which
    // renders nothing until the typed text matches, so an empty field looked
    // like an ordinary box and the feature appeared not to exist.
    inp.addEventListener("focus", () => {
      _gstRenderSuggestions(inp.value);
      // Retry a failed load on the next focus rather than making the
      // operator reload the page. _loadGstKnown is a no-op when the
      // directory is already in hand.
      if (_gstNeedsLoad()) _loadGstKnown().then(() => _gstRepaint(inp));
    });
    inp.addEventListener("input", () => {
      const v = inp.value.trim().toUpperCase();
      if (!_gstSuppressOpen) _gstRenderSuggestions(v);
      if (v.length === 15) {
        if (!_gstSuppressOpen) _gstAutofill(v, false);
      } else {
        // Half a GSTIN matches nothing, so a status line from an earlier
        // match is stale and misleading.
        _gstClearFillStatus();
      }
    });
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Escape") _gstHideSuggestions();
    });
    // Close on a click outside the field or the list — the same
    // document-level handler the guest lookup uses.
    document.addEventListener("click", (e) => {
      const el = dom("bl-gst-suggestions");
      if (!el || el.style.display === "none") return;
      if (!inp.contains(e.target) && !el.contains(e.target)) _gstHideSuggestions();
    });
  }

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

    // Load the directory of previously-invoiced companies and wire the
    // type-ahead. Fired without awaiting so the modal opens instantly; the
    // suggestions appear a moment later, and until then the fields behave
    // exactly as they always did.
    _wireGstAutofill();
    _gstClearFillStatus();
    _gstHideSuggestions();
    _loadGstKnown().then(() => _gstRepaint(dom("bl-gst-gstin")));
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
