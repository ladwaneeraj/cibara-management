/* =========================================================================
 * Banking module — cash receipts, deposits, adjustments, bank accounts.
 *
 * Architecture
 * ------------
 * Self-contained IIFE. Builds its UI inside #banking-tab on boot. Talks to
 * the /banking/* Flask routes via window.fetch (auth.js attaches the
 * Firebase ID token automatically). Exposes nothing on window beyond the
 * legacy refresh hook the existing nav refresh button calls.
 *
 * Six sub-tabs, each a function in this module:
 *   renderCashOnHand, renderNewDeposit, renderHistory,
 *   renderUnofficial,  renderAdjustments, renderBankAccounts
 *
 * Boot order
 *   1. injectStyles() runs immediately (no-op here; banking.css is linked
 *      from index.html).
 *   2. After CibaraAuth.ready() resolves, buildHTML() injects the shell
 *      into #banking-tab and wires the subtab switcher.
 *   3. Each subtab lazy-loads its data on first activation; refresh button
 *      forces a re-fetch.
 *
 * RBAC notes
 *   The visible subtabs depend on the user's role. We check via
 *   window.CibaraAuth.userCan(perm) and hide buttons the user can't use.
 *   The backend re-validates with @requires_permission — frontend checks
 *   are UX only.
 * ========================================================================= */

(function () {
  "use strict";

  // ----- DOM helpers ---------------------------------------------------
  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const dom = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  // ----- State ---------------------------------------------------------
  const state = {
    activeSubtab: "newdep",
    cashOnHand: null,
    eligible: { payments: [], expenses: [], adjustments: [] },
    selectedPayments: new Set(),
    selectedExpenses: new Set(),
    selectedAdjustments: new Set(),
    bankAccounts: [],
    deposits: [],
    adjustments: [],
    unofficial: [],
    loading: {},
    renderSeq: 0,        // bumped on every render; stale async work checks it
    draft: null,         // current draft deposit being assembled
    // Single source of truth for the period filter across all subtabs.
    // Defaults to "this month". Tabs read from these on render and
    // store them back so the next tab picks up the same range.
    periodStart: null,
    periodEnd: null,
  };

  // Compute the default period (1st-of-month → today) once, lazily.
  function _defaultPeriod() {
    if (!state.periodStart || !state.periodEnd) {
      // Delegate to the "This month" preset so the default range is
      // identical to the quick-button. The previous implementation built
      // the 1st-of-month via `new Date(...).toISOString()`, which converts
      // local midnight to UTC — in any UTC+ timezone (e.g. IST) that
      // shifts the date back a day, so "this month" started on the last
      // day of the *previous* month and pulled its rows (expenses,
      // refunds) into the deposit draft, skewing "Net to deposit".
      const [start, end] = _presetRange("month");
      state.periodStart = start;
      state.periodEnd = end;
    }
    return { start: state.periodStart, end: state.periodEnd };
  }

  // ----- API helper ----------------------------------------------------
  // All routes return JSON {success: bool, ...}. We unwrap into either
  // the data or an Error. Auth token is attached upstream by auth.js.
  async function api(path, init) {
    const resp = await fetch(path, Object.assign({}, init || {}, {
      headers: Object.assign(
        { "Content-Type": "application/json" },
        (init && init.headers) || {},
      ),
    }));
    let body = {};
    try { body = await resp.json(); } catch (_) { /* tolerate empty */ }
    if (!resp.ok || body.success === false) {
      const err = new Error(body.message || ("HTTP " + resp.status));
      err.code = body.code;
      err.status = resp.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  // ----- Toasts --------------------------------------------------------
  function _toastHost() {
    let h = dom("bk-toast-host");
    if (!h) {
      h = document.createElement("div");
      h.id = "bk-toast-host";
      h.className = "bk-toast-host";
      document.body.appendChild(h);
    }
    return h;
  }
  function toast(message, type = "info", ms = 3000) {
    const t = document.createElement("div");
    t.className = "bk-toast bk-toast-" + type;
    t.textContent = message;
    _toastHost().appendChild(t);
    setTimeout(() => { t.style.opacity = "0"; }, ms - 250);
    setTimeout(() => { t.remove(); }, ms);
  }

  // ----- Money formatting (paise is the source of truth) ---------------
  function fmtRupees(paise) {
    const n = Number(paise || 0);
    const sign = n < 0 ? "-" : "";
    const abs = Math.abs(n);
    const rupees = Math.floor(abs / 100);
    const sub = abs % 100;
    return sign + "₹" + rupees.toLocaleString("en-IN")
      + "." + String(sub).padStart(2, "0");
  }

  function fmtDate(s) {
    if (!s) return "";
    // accept "YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS"
    return s.slice(0, 10);
  }

  function todayISO() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day;
  }

  // Resolve a userId to a display name via the shared CibaraUsers
  // directory (loaded by user-directory.js, already a global on the
  // page). Falls back to the raw userId if the directory isn't ready or
  // doesn't have that user. Empty / missing values render as an em-dash
  // so the column doesn't look broken.
  function _userName(uid) {
    if (!uid || uid === "system") return uid === "system" ? "system" : "—";
    try {
      if (window.CibaraUsers && typeof window.CibaraUsers.formatBy === "function") {
        return window.CibaraUsers.formatBy(uid);
      }
    } catch (_) { /* fall through */ }
    return uid;
  }

  // ----- Permissions ---------------------------------------------------
  function userCan(perm) {
    return !!(window.CibaraAuth && window.CibaraAuth.userCan
              && window.CibaraAuth.userCan(perm));
  }

  // ----- Subtab definitions --------------------------------------------
  // perm is the backend perm key required to even see the tab.
  const SUBTABS = [
    // Cash-on-Hand summary now appears inline at the top of the New
    // Deposit screen — no separate subtab needed.
    //
    // Per-tab perms gate visibility. Manager has `banking.view` and
    // `banking.deposit.create` — so they see exactly New Deposit and
    // History. The other three tabs require an admin-flavoured perm
    // and thus stay hidden for managers. Admin has wildcard, sees
    // everything.
    { id: "newdep",      label: "New Deposit",    icon: "fa-plus-circle",
      perm: "banking.deposit.create", render: () => renderNewDeposit() },
    { id: "history",     label: "History",        icon: "fa-history",
      perm: "banking.view", render: () => renderHistory() },
    { id: "unofficial",  label: "Unofficial",     icon: "fa-eye-slash",
      perm: "banking.deposit.confirm", render: () => renderUnofficial() },
    { id: "adjustments", label: "Adjustments",    icon: "fa-balance-scale",
      perm: "banking.adjustment.create", render: () => renderAdjustments() },
    { id: "accounts",    label: "Accounts",       icon: "fa-landmark",
      perm: "banking.account.manage", render: () => renderBankAccounts() },
  ];

  function visibleSubtabs() {
    return SUBTABS.filter((s) => !s.perm || userCan(s.perm));
  }

  // ----- Build shell ---------------------------------------------------
  function buildHTML() {
    const tab = dom("banking-tab");
    if (!tab) return;
    const subs = visibleSubtabs();
    const p = _defaultPeriod();
    tab.innerHTML = `
<div class="banking-container">
  <div class="bk-header">
    <h1><i class="fas fa-university"></i> Banking</h1>
    <div class="bk-toolbar">
      <button class="bk-icon-btn bk-refresh" id="bk-refresh" title="Refresh">
        <i class="fas fa-sync-alt"></i>
      </button>
    </div>
  </div>

  <!-- Global period selector — applies to New Deposit, History, and
       Unofficial tabs. Uses the same flatpickr range picker pattern as
       the Bills / Register tabs so the UI feels consistent across the
       app. Changing the range re-renders the active subtab. -->
  <div class="bl-filter-bar">
    <div class="bl-date-range-wrap">
      <i class="fas fa-calendar-alt"></i>
      <input type="text" id="bk-date-range" class="bl-date-range-input"
             placeholder="Select date range" readonly />
    </div>
    <button class="bl-quick-btn" data-preset="today">Today</button>
    <button class="bl-quick-btn" data-preset="week">Last 7d</button>
    <button class="bl-quick-btn bq-active" data-preset="month">This month</button>
    <button class="bl-quick-btn" data-preset="lastmonth">Last month</button>
    <button class="bl-quick-btn" data-preset="fy">This FY</button>
  </div>

  <div class="bk-seg" role="tablist">
    ${subs.map((s) => `
      <button class="bk-seg-btn ${s.id === state.activeSubtab ? "active" : ""}"
              data-subtab="${s.id}" role="tab">
        <i class="fas ${s.icon}"></i>
        <span>${esc(s.label)}</span>
      </button>
    `).join("")}
  </div>

  <div class="bk-pane" id="bk-pane">
    <div class="bk-empty"><span class="bk-spinner"></span> Loading...</div>
  </div>
</div>
`;
    // Subtab switching
    $$("#banking-tab .bk-seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.subtab;
        if (!id || id === state.activeSubtab) return;
        state.activeSubtab = id;
        $$("#banking-tab .bk-seg-btn").forEach((b) =>
          b.classList.toggle("active", b.dataset.subtab === id));
        renderActive();
      });
    });
    // Refresh
    const refresh = dom("bk-refresh");
    if (refresh) refresh.addEventListener("click", () => renderActive(true));

    // Global period — flatpickr range picker (same UX as Bills /
    // Register). Manual calendar selection updates state.periodStart/
    // periodEnd and re-renders the active subtab. Quick-preset buttons
    // are wired below.
    const _bk_today = todayISO();
    const dateEl = dom("bk-date-range");
    if (dateEl && window.flatpickr) {
      const _fp = flatpickr(dateEl, {
        mode: "range",
        dateFormat: "Y-m-d",
        altInput: true,
        altFormat: "d M Y",
        defaultDate: [state.periodStart || _bk_today, state.periodEnd || _bk_today],
        maxDate: _bk_today,
        disableMobile: true,
        onChange: function (selectedDates) {
          if (selectedDates.length === 2) {
            const d2ymd = (d) => {
              const m = String(d.getMonth() + 1).padStart(2, "0");
              const day = String(d.getDate()).padStart(2, "0");
              return d.getFullYear() + "-" + m + "-" + day;
            };
            state.periodStart = d2ymd(selectedDates[0]);
            state.periodEnd   = d2ymd(selectedDates[1]);
            // Manual pick — clear preset active state
            $$("#banking-tab .bl-quick-btn").forEach((b) =>
              b.classList.remove("bq-active"));
            renderActive(true);
          }
        },
      });
      state._datePicker = _fp;
    }
    $$("#banking-tab .bl-quick-btn[data-preset]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const [s, e] = _presetRange(btn.dataset.preset);
        if (!s || !e) return;
        state.periodStart = s;
        state.periodEnd = e;
        if (state._datePicker) {
          state._datePicker.setDate([s, e], false);
        }
        // Mark this preset as active
        $$("#banking-tab .bl-quick-btn").forEach((b) =>
          b.classList.remove("bq-active"));
        btn.classList.add("bq-active");
        renderActive(true);
      });
    });

    renderActive();
  }

  // Compute a date pair for the named preset. Returns [startISO, endISO].
  function _presetRange(preset) {
    const today = new Date();
    const iso = (d) => {
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return d.getFullYear() + "-" + m + "-" + day;
    };
    if (preset === "today") {
      return [iso(today), iso(today)];
    }
    if (preset === "week") {
      const start = new Date(today);
      start.setDate(today.getDate() - 6);
      return [iso(start), iso(today)];
    }
    if (preset === "month") {
      const start = new Date(today.getFullYear(), today.getMonth(), 1);
      return [iso(start), iso(today)];
    }
    if (preset === "lastmonth") {
      const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const end = new Date(today.getFullYear(), today.getMonth(), 0);
      return [iso(start), iso(end)];
    }
    if (preset === "fy") {
      // Indian financial year: 1 Apr to 31 Mar
      let fyStartYear = today.getFullYear();
      if (today.getMonth() < 3) fyStartYear -= 1;
      const start = new Date(fyStartYear, 3, 1);   // April
      return [iso(start), iso(today)];
    }
    return [null, null];
  }

  function renderActive(force = false) {
    const sub = SUBTABS.find((s) => s.id === state.activeSubtab)
      || visibleSubtabs()[0];
    if (!sub) {
      setPane(`<div class="bk-empty">You don't have access to Banking.</div>`);
      return;
    }
    if (force) state.loading[sub.id] = false;
    sub.render();
  }

  function setPane(html) {
    const pane = dom("bk-pane");
    if (pane) pane.innerHTML = html;
  }

  // ----- Stale-render guard --------------------------------------------
  // Every subtab renderer is async: it paints a spinner, awaits one or
  // more network calls, then paints the result. If the operator switches
  // tabs (or hits refresh / changes the period) while a fetch is still
  // in flight, the older renderer would resolve later and overwrite the
  // now-active tab with the WRONG tab's data.
  //
  // Each renderer calls _claimRender() synchronously at its top. That
  // bumps a counter and returns a predicate; after every await the
  // renderer checks the predicate and bails -- touching neither state
  // nor the DOM -- if a newer render has since started. Tab switching is
  // then deterministic regardless of which fetch finishes first.
  function _claimRender() {
    const mine = ++state.renderSeq;
    return () => mine === state.renderSeq;
  }

  // ====================================================================
  // Subtab: Cash on Hand
  // ====================================================================
  async function renderCashOnHand() {
    const live = _claimRender();
    setPane(`<div class="bk-empty"><span class="bk-spinner"></span> Loading cash on hand...</div>`);
    try {
      const r = await api("/banking/cash_on_hand");
      if (!live()) return;
      state.cashOnHand = r;
      // Also pull last deposit
      let last = null;
      try {
        const h = await api("/banking/deposit/history?limit=1");
        last = (h.deposits && h.deposits[0]) || null;
      } catch (_) {}
      const breached = r.threshold_breached;
      const amountClass = (r.amount_paise || 0) < 0 ? "bk-neg" : "";
      if (!live()) return;
      setPane(`
<div class="bk-coh-card">
  <div class="bk-coh-label">Cash on hand (official, undeposited)</div>
  <div class="bk-coh-amount ${amountClass}">${esc(fmtRupees(r.amount_paise))}</div>
  <div class="bk-coh-foot">
    <div>Threshold: <strong>${esc(fmtRupees(r.threshold_paise))}</strong></div>
    <div>${last ? "Last deposit: <strong>" + esc(fmtDate(last.deposit_date)) + "</strong> &middot; "
                  + esc(fmtRupees(last.net_paise || 0)) : "No deposits yet."}</div>
  </div>
</div>
${breached ? `
<div class="bk-threshold-banner">
  <i class="fas fa-exclamation-triangle"></i>
  Cash on hand exceeds the ${esc(fmtRupees(r.threshold_paise))} threshold.
  Consider depositing soon.
</div>` : ""}

<div style="margin-top:1rem; display:flex; gap:0.5rem; flex-wrap:wrap;">
  ${userCan("banking.deposit.create") ? `
    <button class="bk-cta-btn" style="max-width:220px" id="bk-goto-newdep">
      <i class="fas fa-plus-circle"></i> New Deposit
    </button>` : ""}
  <button class="bk-cta-btn bk-secondary" style="max-width:220px" id="bk-goto-history">
    <i class="fas fa-history"></i> Deposit History
  </button>
</div>
`);
      const gd = dom("bk-goto-newdep");
      if (gd) gd.addEventListener("click", () => switchTo("newdep"));
      const gh = dom("bk-goto-history");
      if (gh) gh.addEventListener("click", () => switchTo("history"));
      // Backfill panel for admins (classifies legacy data once)
      if (userCan("banking.deposit.confirm")) {
        _appendBackfillPanel();
      }
    } catch (e) {
      if (!live()) return;
      setPane(`<div class="bk-empty">Failed to load: ${esc(e.message)}</div>`);
    }
  }

  // One-shot legacy backfill button. Renders below the Cash on Hand
  // card. Idempotent on the server — re-running is a no-op for already-
  // classified rows. Only shown to users with banking.deposit.confirm
  // (admin) since this is a one-time data-cleanup operation.
  function _appendBackfillPanel() {
    const host = dom("bk-pane");
    if (!host) return;
    const panel = document.createElement("div");
    panel.style.marginTop = "1rem";
    panel.style.padding = "0.9rem 1rem";
    panel.style.border = "1px dashed #b8bdc6";
    panel.style.borderRadius = "10px";
    panel.style.background = "#fafbff";
    panel.innerHTML = `
      <div style="font-weight:600; margin-bottom:0.3rem;">Legacy data classification</div>
      <div class="bk-muted" style="margin-bottom:0.5rem;">
        Run once after enabling Banking. Stamps existing payments with
        their deposit eligibility based on the parent bill's invoice
        state, so the Deposit screen and the Unofficial tab populate
        correctly. Safe to re-run.
      </div>
      <button class="bk-cta-btn" style="max-width:220px; margin-top:0;" id="bk-backfill-btn">
        <i class="fas fa-database"></i> Run Backfill
      </button>
      <div id="bk-backfill-out" class="bk-muted" style="margin-top:0.5rem;"></div>
    `;
    host.appendChild(panel);
    const btn = dom("bk-backfill-btn");
    const out = dom("bk-backfill-out");
    if (btn) btn.addEventListener("click", async () => {
      btn.disabled = true;
      out.innerHTML = '<span class="bk-spinner"></span> Running...';
      try {
        const result = await api("/banking/backfill", { method: "POST" });
        const b = result.bills || {};
        const p = result.payments || {};
        const x = result.expenses || {};
        out.innerHTML =
          "Done. bills seen=" + (b.seen||0) + " updated=" + (b.written||0) +
          "  &middot;  payments seen=" + (p.seen||0) + " updated=" + (p.written||0) +
          "  &middot;  expenses seen=" + (x.seen||0) + " updated=" + (x.written||0);
        toast("Backfill complete", "success");
        // Refresh the COH numbers in a moment
        setTimeout(() => renderCashOnHand(), 800);
      } catch (e) {
        out.innerHTML = '<span style="color:#a33">Failed: ' + esc(e.message) + '</span>';
        toast("Backfill failed: " + e.message, "error", 5000);
        btn.disabled = false;
      }
    });
  }

  function switchTo(id) {
    state.activeSubtab = id;
    $$("#banking-tab .bk-seg-btn").forEach((b) =>
      b.classList.toggle("active", b.dataset.subtab === id));
    renderActive();
  }

  // ====================================================================
  // Subtab: New Deposit
  // ====================================================================
  async function renderNewDeposit() {
    const live = _claimRender();
    if (!userCan("banking.deposit.create")) {
      setPane(`<div class="bk-empty">You don't have permission to create deposits.</div>`);
      return;
    }
    setPane(`<div class="bk-empty"><span class="bk-spinner"></span> Loading eligible rows...</div>`);

    // Reset selection state when entering the screen
    state.selectedPayments.clear();
    state.selectedExpenses.clear();
    state.selectedAdjustments.clear();
    state.draft = null;

    try {
      // Parallel fetch: eligible rows + bank accounts + cash-on-hand
      // summary all kick off at once. cash_on_hand and last-deposit are
      // best-effort; if either fails the screen still renders.
      //
      // A deposit empties the cash drawer, so eligible rows are fetched
      // WITHOUT a period filter: every undeposited eligible payment,
      // expense and refund -- the exact set Cash on Hand sums. That keeps
      // "Net to deposit" (all rows selected) equal to "Cash on hand", so
      // the reconciliation warning only fires on a real un-tick.
      const [eligible, accts, coh, lastDep] = await Promise.all([
        api("/banking/eligible_rows"),
        api("/banking/bank_accounts"),
        api("/banking/cash_on_hand").catch(() => null),
        api("/banking/deposit/history?limit=1").catch(() => null),
      ]);
      if (!live()) return;
      state.eligible = {
        payments: eligible.payments || [],
        expenses: eligible.expenses || [],
        adjustments: eligible.adjustments || [],
        refunds: eligible.refunds || [],
      };
      state.bankAccounts = accts.accounts || [];
      state.cashOnHand = coh;
      const lastDeposit = (lastDep && lastDep.deposits && lastDep.deposits[0]) || null;
      // Pre-select all eligible rows by default — operator can uncheck
      // individual rows or use the header "select all" checkbox to
      // toggle the whole list off.
      //
      // Adjustments are pre-selected too because they represent cash
      // that already moved (owner withdrew ₹200, drawer was short ₹50,
      // etc.). Leaving them unchecked silently lets the operator
      // commit to a deposit larger than the drawer actually holds —
      // i.e. "Net to deposit" can exceed "Cash on hand" if the
      // operator forgets to tick the adjustments. Pre-checking matches
      // reality; the operator can still defer an adjustment to a
      // different deposit by un-ticking it.
      state.eligible.payments.forEach((p) => state.selectedPayments.add(p.id));
      state.eligible.expenses.forEach((x) => state.selectedExpenses.add(x.id));
      state.eligible.adjustments.forEach((x) => state.selectedAdjustments.add(x.id));

      setPane(_cohBannerHTML(coh, lastDeposit) + _newDepHTML());
      _wireNewDep();
      _renderSummary();
    } catch (e) {
      if (!live()) return;
      setPane(`<div class="bk-empty">Failed to load: ${esc(e.message)}</div>`);
    }
  }

  // Small COH summary card embedded above the deposit picker. Renders
  // even when the COH endpoint fails (returns empty string) so a
  // banking-side hiccup doesn't take down the deposit flow.
  function _cohBannerHTML(coh, lastDeposit) {
    if (!coh) return "";
    const breach = coh.threshold_breached;
    const lastStr = lastDeposit
      ? "Last deposit: <strong>" + esc(fmtDate(lastDeposit.deposit_date))
        + "</strong> &middot; " + esc(fmtRupees(lastDeposit.net_paise || 0))
      : "No deposits yet.";
    // Threshold breach: switch the gradient to a danger palette, add a
    // banner row at the top of the card and a pulsing badge on the
    // amount so it stays visible while scrolling the deposit picker.
    // Non-breach: keep the brand-coloured calm version.
    const cardStyle = breach
      ? "margin-bottom:0.7rem; background: linear-gradient(135deg,#e63946,#a8131f); box-shadow: 0 4px 14px rgba(230,57,70,0.35);"
      : "margin-bottom:0.7rem;";
    const breachBar = breach ? `
  <div style="background:rgba(0,0,0,0.18); color:#fff; padding:0.4rem 0.7rem; border-radius:8px; margin-bottom:0.5rem; display:flex; align-items:center; gap:0.45rem; font-size:0.82rem; font-weight:600;">
    <i class="fas fa-exclamation-triangle" style="font-size:0.95rem;"></i>
    <span>Threshold breached &mdash; deposit recommended.</span>
  </div>` : "";
    const amountBadge = breach
      ? ' <span style="display:inline-block; vertical-align:middle; margin-left:0.4rem; padding:0.1rem 0.5rem; border-radius:10px; background:rgba(255,255,255,0.22); font-size:0.7rem; font-weight:700; letter-spacing:0.03em;">OVER THRESHOLD</span>'
      : "";
    return `
<div class="bk-coh-card" style="${cardStyle}">
  ${breachBar}
  <div style="display:flex; justify-content:space-between; align-items:center; gap:0.6rem; flex-wrap:wrap;">
    <div>
      <div class="bk-coh-label">Cash on hand (official, undeposited)</div>
      <div class="bk-coh-amount" style="font-size:1.4rem;">${esc(fmtRupees(coh.amount_paise))}${amountBadge}</div>
    </div>
    <div class="bk-coh-foot" style="margin-top:0; text-align:right;">
      <div>${lastStr}</div>
      <div style="opacity:0.85;">Threshold: ${esc(fmtRupees(coh.threshold_paise))}</div>
    </div>
  </div>
</div>
`;
  }

  function _newDepHTML() {
    const accts = state.bankAccounts;
    return `
<div class="bk-filter-bar">
  <label>Deposit date</label>
  <input type="date" id="bk-deposit-date" value="${todayISO()}">
  <label>Bank account</label>
  <select id="bk-bank-account">
    ${accts.length === 0
      ? `<option value="">(none — add one in the Accounts tab)</option>`
      : accts.map((a) =>
          `<option value="${esc(a.id)}" ${a.is_default ? "selected" : ""}>${esc(a.name)} &middot; ${esc(a.bank)} &middot; XX${esc(a.account_no_last4 || "")}</option>`,
        ).join("")}
  </select>
  <span class="bk-muted" style="font-size:0.78rem; align-self:center;">Whole drawer &middot; all undeposited cash</span>
  <button class="bk-cta-btn bk-secondary" id="bk-reload-eligible"
          style="height:30px; padding:0 0.7rem; max-width:90px; margin-top:0; font-size:0.78rem;">
    <i class="fas fa-sync-alt"></i> Reload
  </button>
</div>

<div class="bk-newdep-grid">
  <div class="bk-newdep-left">

    <section>
      <div class="bk-section-title bk-sec-toggle" data-target="bk-sec-pay" style="cursor:pointer;">
        <i class="fas fa-chevron-down bk-sec-caret" style="margin-right:0.4rem; font-size:0.8rem;"></i>
        Eligible cash collections
        <span class="bk-sub" id="bk-pay-sub">0 selected of ${state.eligible.payments.length}</span>
      </div>
      <div class="bk-sec-body" id="bk-sec-pay">${_paymentsTable()}</div>
    </section>

    <section>
      <div class="bk-section-title bk-sec-toggle" data-target="bk-sec-exp" style="cursor:pointer;">
        <i class="fas fa-chevron-down bk-sec-caret" style="margin-right:0.4rem; font-size:0.8rem;"></i>
        Cash expenses
        <span class="bk-sub" id="bk-exp-sub">0 selected of ${state.eligible.expenses.length}</span>
      </div>
      <div class="bk-sec-body" id="bk-sec-exp">${_expensesTable()}</div>
    </section>

    <section>
      <div class="bk-section-title bk-sec-toggle" data-target="bk-sec-adj" style="cursor:pointer;">
        <i class="fas fa-chevron-down bk-sec-caret" style="margin-right:0.4rem; font-size:0.8rem;"></i>
        Cash adjustments
        <span class="bk-sub" id="bk-adj-sub">0 selected of ${state.eligible.adjustments.length}</span>
      </div>
      <div class="bk-sec-body" id="bk-sec-adj">${_adjsTable()}</div>
    </section>

    <section>
      <div class="bk-section-title bk-sec-toggle" data-target="bk-sec-ref" style="cursor:pointer;">
        <i class="fas fa-chevron-down bk-sec-caret" style="margin-right:0.4rem; font-size:0.8rem;"></i>
        Cash refunds
        <span class="bk-sub">${state.eligible.refunds.length} entr${state.eligible.refunds.length === 1 ? "y" : "ies"} &middot; auto-deducted</span>
      </div>
      <div class="bk-sec-body" id="bk-sec-ref">${_refundsTable()}</div>
    </section>
  </div>

  <aside class="bk-summary">
    <h3>Summary</h3>
    <div class="bk-summary-row">
      <span class="bk-summary-label">Gross collected</span>
      <span class="bk-summary-value" id="bk-sum-gross">&#8377;0.00</span>
    </div>
    <div class="bk-summary-row bk-neg">
      <span class="bk-summary-label">Less: cash expenses</span>
      <span class="bk-summary-value" id="bk-sum-exp">&#8377;0.00</span>
    </div>
    <div class="bk-summary-row bk-neg">
      <span class="bk-summary-label">Less: cash refunds</span>
      <span class="bk-summary-value" id="bk-sum-ref">&#8377;0.00</span>
    </div>
    <div class="bk-summary-row">
      <span class="bk-summary-label">Adjustments (signed)</span>
      <span class="bk-summary-value" id="bk-sum-adj">&#8377;0.00</span>
    </div>
    <div class="bk-summary-row bk-net">
      <span class="bk-summary-label">Net to deposit</span>
      <span class="bk-summary-value" id="bk-sum-net">&#8377;0.00</span>
    </div>

    <!-- Mismatch warning — populated by _renderSummary when the
         operator's selection produces a Net that doesn't match the
         live Cash-on-Hand number at the top of the screen. Empty (and
         invisible) when the two agree. -->
    <div id="bk-sum-mismatch" style="display:none; margin-top:0.4rem;
         padding:0.45rem 0.6rem; border-radius:6px;
         background:#fff3cd; border:1px solid #ffe399;
         color:#7a5800; font-size:0.78rem;"></div>

    <label for="bk-slip-number" style="display:block; margin-top:0.7rem; font-size:0.78rem; font-weight:600; color:#444;">
      Bank slip / reference
    </label>
    <input type="text" class="bk-input" id="bk-slip-number"
           placeholder="e.g. HDFC-DEP-2026-04-12345">

    <label for="bk-notes" style="display:block; margin-top:0.5rem; font-size:0.78rem; font-weight:600; color:#444;">
      Notes (optional)
    </label>
    <input type="text" class="bk-input" id="bk-notes"
           placeholder="Anything to remember about this deposit">

    <button class="bk-cta-btn" id="bk-save-draft">
      <i class="fas fa-save"></i> Save as Draft
    </button>
    ${userCan("banking.deposit.confirm") ? `
      <button class="bk-cta-btn bk-success" id="bk-save-confirm">
        <i class="fas fa-check-circle"></i> Save &amp; Confirm
      </button>` : `
      <div class="bk-muted" style="margin-top:0.4rem;">
        Confirmation requires admin. A manager can save a draft for admin to confirm.
      </div>`}
  </aside>
</div>
`;
  }

  function _paymentsTable() {
    const rows = state.eligible.payments;
    if (rows.length === 0) {
      return `<div class="bk-empty">No eligible cash payments.</div>`;
    }
    let payTotal = 0;
    rows.forEach((p) => {
      payTotal += Number(p.amount_paise || (p.amount || 0) * 100);
    });
    return `
<div class="bk-table-wrap">
  <table class="bk-table">
    <thead><tr>
      <th style="width:30px"><input type="checkbox" class="bk-checkbox" id="bk-pay-all" checked></th>
      <th>Officialized</th>
      <th>Guest / Room</th>
      <th>Receipt #</th>
      <th class="bk-num">Amount</th>
    </tr></thead>
    <tbody>
      ${rows.map((p) => {
        const checked = state.selectedPayments.has(p.id) ? "checked" : "";
        return `<tr>
          <td><input type="checkbox" class="bk-checkbox bk-pay-row"
                     data-id="${esc(p.id)}" ${checked}></td>
          <td>${esc(fmtDate(p.officialized_at))}</td>
          <td>${esc(p.name || "")}${p.room ? " &middot; Room " + esc(p.room) : ""}</td>
          <td><span class="bk-mono">${esc(p.receipt_no || "")}</span></td>
          <td class="bk-num bk-mono">${esc(fmtRupees(p.amount_paise || (p.amount||0)*100))}</td>
        </tr>`;
      }).join("")}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="4" style="text-align:right;">Total cash collected (all rows)</td>
        <td class="bk-num bk-mono"><strong>${esc(fmtRupees(payTotal))}</strong></td>
      </tr>
    </tfoot>
  </table>
</div>`;
  }

  function _expensesTable() {
    const rows = state.eligible.expenses;
    if (rows.length === 0) {
      return `<div class="bk-empty">No undeposited cash expenses.</div>`;
    }
    let expTotal = 0;
    rows.forEach((e) => {
      expTotal += Number(e.amount_paise || (e.amount || 0) * 100);
    });
    return `
<div class="bk-table-wrap">
  <table class="bk-table">
    <thead><tr>
      <th style="width:30px"><input type="checkbox" class="bk-checkbox" id="bk-exp-all" ${state.selectedExpenses.size > 0 && state.selectedExpenses.size === state.eligible.expenses.length ? "checked" : ""}></th>
      <th>Date</th>
      <th>Category</th>
      <th>Description</th>
      <th class="bk-num">Amount</th>
    </tr></thead>
    <tbody>
      ${rows.map((e) => {
        const checked = state.selectedExpenses.has(e.id) ? "checked" : "";
        // Field names match routes/reports.py:add_expense — `category`
        // and `description`. `vendor_name` is only set on GST-bill
        // expenses; we surface it inside the description column when
        // present.
        const cat = e.category || e.category_id || "";
        const descParts = [];
        if (e.vendor_name) descParts.push(esc(e.vendor_name));
        if (e.description) descParts.push(esc(e.description));
        if (e.paid_to) descParts.push("paid to " + esc(e.paid_to));
        const descHTML = descParts.join(" &middot; ") || "<span class='bk-muted'>—</span>";
        return `<tr>
          <td><input type="checkbox" class="bk-checkbox bk-exp-row"
                     data-id="${esc(e.id)}" ${checked}></td>
          <td>${esc(fmtDate(e.expense_date || e.date))}</td>
          <td>${esc(cat)}</td>
          <td>${descHTML}</td>
          <td class="bk-num bk-mono">${esc(fmtRupees(e.amount_paise || (e.amount||0)*100))}</td>
        </tr>`;
      }).join("")}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="4" style="text-align:right;">Total cash expenses (all rows)</td>
        <td class="bk-num bk-mono bk-neg"><strong>-${esc(fmtRupees(expTotal))}</strong></td>
      </tr>
    </tfoot>
  </table>
</div>`;
  }

  // Read-only table of cash refunds in the selected period. The operator
  // doesn't pick these — they're auto-deducted from gross by the cash-on-
  // hand math because the cash has already left the drawer. Showing them
  // here gives the operator visibility into WHY the deposit total is
  // smaller than the gross collections column suggests.
  function _refundsTable() {
    const rows = state.eligible.refunds;
    if (rows.length === 0) {
      return `<div class="bk-empty">No undeposited cash refunds.</div>`;
    }
    let total = 0;
    rows.forEach((r) => {
      total += Number(r.amount_paise || (r.amount || 0) * 100);
    });
    return `
<div class="bk-table-wrap">
  <table class="bk-table">
    <thead><tr>
      <th>Date</th>
      <th>Guest / Room</th>
      <th>Reason</th>
      <th class="bk-num">Amount</th>
    </tr></thead>
    <tbody>
      ${rows.map((r) => `
        <tr>
          <td>${esc(fmtDate(r.date || r.created_at))}</td>
          <td>${esc(r.name || "")}${r.room ? " &middot; Room " + esc(r.room) : ""}</td>
          <td>${esc(r.type || "refund")}${r.note ? " <span class='bk-muted'>&mdash; " + esc(r.note) + "</span>" : ""}</td>
          <td class="bk-num bk-mono bk-neg">-${esc(fmtRupees(r.amount_paise || (r.amount||0)*100))}</td>
        </tr>`).join("")}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="3" style="text-align:right;">Total cash out (refunds)</td>
        <td class="bk-num bk-mono"><strong>-${esc(fmtRupees(total))}</strong></td>
      </tr>
    </tfoot>
  </table>
</div>`;
  }

  function _adjsTable() {
    const rows = state.eligible.adjustments;
    if (rows.length === 0) {
      return `<div class="bk-empty">No undeposited adjustments.</div>`;
    }
    let adjTotal = 0;
    rows.forEach((a) => {
      adjTotal += Number(a.amount_paise || 0);
    });
    const adjSign = adjTotal >= 0 ? "+" : "";
    const allChecked = state.selectedAdjustments.size > 0
      && state.selectedAdjustments.size === state.eligible.adjustments.length;
    return `
<div class="bk-table-wrap">
  <table class="bk-table">
    <thead><tr>
      <th style="width:30px"><input type="checkbox" class="bk-checkbox" id="bk-adj-all" ${allChecked ? "checked" : ""}></th>
      <th>Date</th>
      <th>Reason</th>
      <th class="bk-num">Amount</th>
    </tr></thead>
    <tbody>
      ${rows.map((a) => {
        const checked = state.selectedAdjustments.has(a.id) ? "checked" : "";
        return `<tr>
          <td><input type="checkbox" class="bk-checkbox bk-adj-row"
                     data-id="${esc(a.id)}" ${checked}></td>
          <td>${esc(fmtDate(a.adjustment_date))}</td>
          <td>${esc(a.reason)} ${a.notes ? "<span class='bk-muted'>&mdash; " + esc(a.notes) + "</span>" : ""}</td>
          <td class="bk-num bk-mono">${esc(fmtRupees(a.amount_paise || 0))}</td>
        </tr>`;
      }).join("")}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="3" style="text-align:right;">Total adjustments (signed)</td>
        <td class="bk-num bk-mono"><strong>${adjSign}${esc(fmtRupees(adjTotal))}</strong></td>
      </tr>
    </tfoot>
  </table>
</div>`;
  }

  function _wireNewDep() {
    // Row checkboxes
    $$("#banking-tab .bk-pay-row").forEach((cb) =>
      cb.addEventListener("change", () => {
        const id = cb.dataset.id;
        cb.checked ? state.selectedPayments.add(id)
                   : state.selectedPayments.delete(id);
        _renderSummary();
      }),
    );
    $$("#banking-tab .bk-exp-row").forEach((cb) =>
      cb.addEventListener("change", () => {
        const id = cb.dataset.id;
        cb.checked ? state.selectedExpenses.add(id)
                   : state.selectedExpenses.delete(id);
        _renderSummary();
      }),
    );
    $$("#banking-tab .bk-adj-row").forEach((cb) =>
      cb.addEventListener("change", () => {
        const id = cb.dataset.id;
        cb.checked ? state.selectedAdjustments.add(id)
                   : state.selectedAdjustments.delete(id);
        _renderSummary();
      }),
    );
    // Select-all toggles
    const payAll = dom("bk-pay-all");
    if (payAll) payAll.addEventListener("change", () => {
      $$("#banking-tab .bk-pay-row").forEach((cb) => {
        cb.checked = payAll.checked;
        const id = cb.dataset.id;
        payAll.checked ? state.selectedPayments.add(id)
                       : state.selectedPayments.delete(id);
      });
      _renderSummary();
    });
    const expAll = dom("bk-exp-all");
    if (expAll) expAll.addEventListener("change", () => {
      $$("#banking-tab .bk-exp-row").forEach((cb) => {
        cb.checked = expAll.checked;
        const id = cb.dataset.id;
        expAll.checked ? state.selectedExpenses.add(id)
                       : state.selectedExpenses.delete(id);
      });
      _renderSummary();
    });
    const adjAll = dom("bk-adj-all");
    if (adjAll) adjAll.addEventListener("change", () => {
      $$("#banking-tab .bk-adj-row").forEach((cb) => {
        cb.checked = adjAll.checked;
        const id = cb.dataset.id;
        adjAll.checked ? state.selectedAdjustments.add(id)
                       : state.selectedAdjustments.delete(id);
      });
      _renderSummary();
    });
    // Reload eligible rows when period changes
    const reload = dom("bk-reload-eligible");
    if (reload) reload.addEventListener("click", () => {
      renderNewDeposit();
    });
    // Save draft / Save & confirm
    const saveDraft = dom("bk-save-draft");
    if (saveDraft) saveDraft.addEventListener("click", () => _submitDeposit(false));
    const saveCommit = dom("bk-save-confirm");
    if (saveCommit) saveCommit.addEventListener("click", () => _submitDeposit(true));

    // Collapsible sections: clicking a section header hides/shows its
    // table. Pure DOM toggle, no CSS dependency; the caret flips to show
    // state. Sections start expanded.
    $$("#banking-tab .bk-sec-toggle").forEach((header) => {
      header.addEventListener("click", () => {
        const body = dom(header.dataset.target);
        if (!body) return;
        const isHidden = body.style.display === "none";
        body.style.display = isHidden ? "" : "none";
        const caret = header.querySelector(".bk-sec-caret");
        if (caret) {
          caret.classList.toggle("fa-chevron-down", isHidden);
          caret.classList.toggle("fa-chevron-right", !isHidden);
        }
      });
    });
  }

  function _selectedTotals() {
    let g = 0, e = 0, a = 0, r = 0;
    state.eligible.payments.forEach((p) => {
      if (state.selectedPayments.has(p.id)) {
        g += Number(p.amount_paise || (p.amount || 0) * 100);
      }
    });
    state.eligible.expenses.forEach((x) => {
      if (state.selectedExpenses.has(x.id)) {
        e += Number(x.amount_paise || (x.amount || 0) * 100);
      }
    });
    state.eligible.adjustments.forEach((x) => {
      if (state.selectedAdjustments.has(x.id)) {
        a += Number(x.amount_paise || 0);
      }
    });
    // Refunds are NOT selectable — they're auto-deducted because the
    // cash has already left the drawer. Sum every refund in the period.
    (state.eligible.refunds || []).forEach((x) => {
      r += Number(x.amount_paise || (x.amount || 0) * 100);
    });
    return { gross: g, expenses: e, adj: a, refunds: r,
             net: g - e - r + a };
  }

  function _renderSummary() {
    const totals = _selectedTotals();
    const g = dom("bk-sum-gross"), e = dom("bk-sum-exp"),
          a = dom("bk-sum-adj"),   n = dom("bk-sum-net"),
          rf = dom("bk-sum-ref");
    if (g) g.textContent = fmtRupees(totals.gross);
    if (e) e.textContent = "-" + fmtRupees(totals.expenses);
    if (rf) rf.textContent = "-" + fmtRupees(totals.refunds);
    if (a) a.textContent = (totals.adj >= 0 ? "+" : "") + fmtRupees(totals.adj);
    if (n) n.textContent = fmtRupees(totals.net);

    // Mismatch warning — Cash on Hand is the authoritative drawer state;
    // Net to deposit is what the operator's current selection adds up to.
    // If they diverge, the operator has un-selected an adjustment or
    // similar that DOES affect the real drawer — meaning their planned
    // deposit doesn't match physical reality. Show a yellow note that
    // explains the gap so they can re-tick the right rows.
    const warn = dom("bk-sum-mismatch");
    const coh = state.cashOnHand && Number(state.cashOnHand.amount_paise || 0);
    if (warn && state.cashOnHand) {
      const diff = totals.net - coh;
      if (Math.abs(diff) < 1) {
        warn.style.display = "none";
        warn.innerHTML = "";
      } else {
        const sign = diff > 0 ? "more than" : "less than";
        warn.style.display = "block";
        warn.innerHTML =
          '<i class="fas fa-exclamation-triangle" style="margin-right:0.3rem;"></i>'
          + '<strong>Net is ' + esc(fmtRupees(Math.abs(diff))) + ' ' + sign + ' Cash on Hand.</strong> '
          + 'You probably un-ticked an adjustment or expense that DID '
          + 'affect the real drawer. Re-tick it, or accept the gap if '
          + 'you know what you\'re doing.';
      }
    }

    const paySub = dom("bk-pay-sub");
    if (paySub) paySub.textContent =
      state.selectedPayments.size + " selected of " + state.eligible.payments.length;
    const expSub = dom("bk-exp-sub");
    if (expSub) expSub.textContent =
      state.selectedExpenses.size + " selected of " + state.eligible.expenses.length;
    const adjSub = dom("bk-adj-sub");
    if (adjSub) adjSub.textContent =
      state.selectedAdjustments.size + " selected of " + state.eligible.adjustments.length;

    // Disable save buttons if net is negative or nothing selected
    const valid = (state.selectedPayments.size + state.selectedExpenses.size
                   + state.selectedAdjustments.size) > 0 && totals.net >= 0;
    ["bk-save-draft", "bk-save-confirm"].forEach((id) => {
      const b = dom(id);
      if (b) b.disabled = !valid;
    });
  }

  async function _submitDeposit(confirm) {
    const dateEl = dom("bk-deposit-date");
    const acctEl = dom("bk-bank-account");
    const slipEl = dom("bk-slip-number");
    const notesEl = dom("bk-notes");
    if (!acctEl || !acctEl.value) {
      toast("Pick a bank account first", "error");
      return;
    }
    const payload = {
      deposit_date:    (dateEl && dateEl.value) || todayISO(),
      bank_account_id: acctEl.value,
      payment_ids:     Array.from(state.selectedPayments),
      expense_ids:     Array.from(state.selectedExpenses),
      adjustment_ids:  Array.from(state.selectedAdjustments),
      slip_number:     (slipEl && slipEl.value) || "",
      notes:           (notesEl && notesEl.value) || "",
      period_start:    null,
      period_end:      null,
    };
    try {
      const drafted = await api("/banking/deposit/draft", {
        method: "POST", body: JSON.stringify(payload),
      });
      state.draft = drafted.deposit;
      if (!confirm) {
        toast("Draft saved: " + (drafted.deposit.deposit_ref || drafted.deposit.id),
              "success");
        switchTo("history");
        return;
      }
      // Confirm step
      const conf = await api(`/banking/deposit/${drafted.deposit.id}/confirm`, {
        method: "POST",
        body: JSON.stringify({ slip_number: payload.slip_number }),
      });
      toast("Deposit confirmed: " + (conf.deposit.deposit_ref || conf.deposit.id)
            + "  " + fmtRupees(conf.deposit.net_paise), "success", 4000);
      switchTo("history");
    } catch (e) {
      toast("Failed: " + e.message, "error", 5000);
    }
  }

  // ====================================================================
  // Subtab: Deposit History
  // ====================================================================
  async function renderHistory(periodStart, periodEnd) {
    const live = _claimRender();
    setPane(`<div class="bk-empty"><span class="bk-spinner"></span> Loading history...</div>`);
    // Use the global period selector at the top of Banking. Per-tab
    // overrides (passed as args) win if supplied.
    const _gp = _defaultPeriod();
    if (!periodStart) periodStart = _gp.start;
    if (!periodEnd)   periodEnd   = _gp.end;
    // Kick the deposit fetch off NOW, before the user-directory wait
    // below, so the network round-trip overlaps that wait instead of
    // running strictly after it -- saves up to ~800 ms of perceived load.
    const _histFetch = api(
      "/banking/deposit/history?limit=500"
      + "&period_start=" + encodeURIComponent(periodStart)
      + "&period_end="   + encodeURIComponent(periodEnd),
    );
    // Wait for the shared user directory once so the "Drafted by" /
    // "Confirmed by" columns can resolve userIds to names instead of
    // showing raw IDs. Best-effort — if it's already loaded, ready()
    // resolves instantly; if it's slow, we wait briefly but don't
    // block forever (the column will fall back to userId if needed).
    try {
      if (window.CibaraUsers && typeof window.CibaraUsers.ready === "function") {
        await Promise.race([
          window.CibaraUsers.ready(),
          new Promise((r) => setTimeout(r, 800)),
        ]);
      }
    } catch (_) { /* ignore */ }

    try {
      const r = await _histFetch;
      if (!live()) return;
      state.deposits = r.deposits || [];
      const rows = state.deposits;
      const totals = r.totals || { count: 0, gross_paise: 0, expenses_paise: 0, net_paise: 0 };
      // Tiny summary line — the date range now lives in the global
      // selector at the top of Banking, not per-tab.
      const summary = `
<div style="display:flex; justify-content:flex-end; padding:0.4rem 0.2rem;
            font-size:0.82rem; color:#444;">
  ${totals.count} deposit${totals.count === 1 ? "" : "s"} &middot;
  Net <strong class="bk-mono">${esc(fmtRupees(totals.net_paise))}</strong>
</div>
`;
      if (rows.length === 0) {
        setPane(summary
          + `<div class="bk-empty">No deposits in the selected period.</div>`);
        return;
      }
      setPane(summary + `
<div class="bk-table-wrap">
  <table class="bk-table">
    <thead><tr>
      <th>Date</th>
      <th>Ref</th>
      <th>Bank</th>
      <th>Slip</th>
      <th class="bk-num">Gross</th>
      <th class="bk-num">Expenses</th>
      <th class="bk-num">Net</th>
      <th>Status</th>
      <th>Drafted by</th>
      <th>Confirmed by</th>
      <th></th>
    </tr></thead>
    <tbody>
      ${rows.map((d) => `
        <tr>
          <td>${esc(fmtDate(d.deposit_date))}</td>
          <td class="bk-mono">${esc(d.deposit_ref || "")}</td>
          <td>${esc(d.bank_account_id || "")}</td>
          <td class="bk-mono">${esc(d.slip_number || "")}</td>
          <td class="bk-num bk-mono">${esc(fmtRupees(d.gross_paise || 0))}</td>
          <td class="bk-num bk-mono">${esc(fmtRupees(d.expenses_paise || 0))}</td>
          <td class="bk-num bk-mono"><strong>${esc(fmtRupees(d.net_paise || 0))}</strong></td>
          <td><span class="bk-pill bk-pill-${esc(d.status)}">${esc(d.status)}</span></td>
          <td>${esc(_userName(d.createdBy))}</td>
          <td>${esc(_userName(d.confirmed_by))}</td>
          <td>
            ${d.status === "draft" && userCan("banking.deposit.confirm") ? `
              <button class="bk-cta-btn bk-success" style="margin-top:0; padding:0.3rem 0.6rem; font-size:0.7rem;"
                      data-confirm="${esc(d.id)}"><i class="fas fa-check"></i> Confirm</button>` : ""}
            ${d.status === "draft" && userCan("banking.deposit.reverse") ? `
              <button class="bk-cta-btn bk-secondary" style="margin-top:0; padding:0.3rem 0.6rem; font-size:0.7rem;"
                      data-discard="${esc(d.id)}">Discard</button>` : ""}
            ${d.status === "confirmed" && userCan("banking.deposit.reconcile") ? `
              <button class="bk-cta-btn bk-secondary" style="margin-top:0; padding:0.3rem 0.6rem; font-size:0.7rem;"
                      data-recon="${esc(d.id)}">Reconcile</button>` : ""}
            ${(d.status === "confirmed" || d.status === "reconciled") && userCan("banking.deposit.reverse") ? `
              <button class="bk-cta-btn bk-danger" style="margin-top:0; padding:0.3rem 0.6rem; font-size:0.7rem;"
                      data-reverse="${esc(d.id)}">Reverse</button>` : ""}
          </td>
        </tr>`).join("")}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="4" style="text-align:right;">Totals (excluding reversed)</td>
        <td class="bk-num bk-mono">${esc(fmtRupees(totals.gross_paise))}</td>
        <td class="bk-num bk-mono">${esc(fmtRupees(totals.expenses_paise))}</td>
        <td class="bk-num bk-mono"><strong>${esc(fmtRupees(totals.net_paise))}</strong></td>
        <td colspan="4"></td>
      </tr>
    </tfoot>
  </table>
</div>
`);
      $$("#banking-tab [data-confirm]").forEach((b) =>
        b.addEventListener("click", () => _confirmDraft(b.dataset.confirm)));
      $$("#banking-tab [data-discard]").forEach((b) =>
        b.addEventListener("click", () => _discardDraft(b.dataset.discard)));
      $$("#banking-tab [data-recon]").forEach((b) =>
        b.addEventListener("click", () => _reconcile(b.dataset.recon)));
      $$("#banking-tab [data-reverse]").forEach((b) =>
        b.addEventListener("click", () => _reverse(b.dataset.reverse)));
    } catch (e) {
      if (!live()) return;
      setPane(`<div class="bk-empty">Failed to load: ${esc(e.message)}</div>`);
    }
  }

  // Hooks the date-range filter Apply button on the History tab.
  function _wireHistoryFilter() {
    const apply = dom("bk-hist-apply");
    if (apply) apply.addEventListener("click", () => {
      const s = (dom("bk-hist-start") || {}).value;
      const e = (dom("bk-hist-end")   || {}).value;
      if (!s || !e) {
        toast("Pick both start and end dates", "error");
        return;
      }
      if (s > e) {
        toast("Start date must be before end date", "error");
        return;
      }
      renderHistory(s, e);
    });
  }

  // Promote a draft deposit to confirmed. Prompts for a slip number
  // (optional — the operator may have already typed it when saving the
  // draft, in which case the API call accepts an empty value and keeps
  // whatever was on the doc).
  async function _confirmDraft(id) {
    const slip = prompt(
      "Bank slip / reference number (leave blank to keep the existing one):",
      "",
    );
    if (slip === null) return;  // user hit Cancel
    try {
      const payload = {};
      if (slip.trim()) payload.slip_number = slip.trim();
      const result = await api(`/banking/deposit/${id}/confirm`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const ref = (result.deposit && result.deposit.deposit_ref) || id;
      toast("Confirmed: " + ref, "success");
      renderHistory();
    } catch (e) {
      toast("Confirm failed: " + e.message, "error", 5000);
    }
  }

  // Discard a draft. Uses the same /reverse endpoint with reason
  // "discarded_draft" — semantically the draft never went to the bank,
  // but unlinking any rows it claimed is the same operation.
  async function _discardDraft(id) {
    if (!confirm("Discard this draft? Its rows return to the eligible pool.")) return;
    try {
      await api(`/banking/deposit/${id}/reverse`, {
        method: "POST",
        body: JSON.stringify({ reason: "discarded_draft" }),
      });
      toast("Draft discarded", "success");
      renderHistory();
    } catch (e) {
      toast("Discard failed: " + e.message, "error");
    }
  }

  async function _reconcile(id) {
    const ref = prompt("Enter bank statement reference (e.g. statement page or txn ID):");
    if (!ref) return;
    try {
      await api(`/banking/deposit/${id}/reconcile`, {
        method: "POST",
        body: JSON.stringify({ bank_statement_ref: ref }),
      });
      toast("Reconciled", "success");
      renderHistory();
    } catch (e) {
      toast("Reconcile failed: " + e.message, "error");
    }
  }

  async function _reverse(id) {
    const reason = prompt("Reason for reversing this deposit (required):");
    if (!reason) return;
    if (!confirm("This will UNLINK every payment / expense / adjustment in this deposit and flip cash back to eligible. Proceed?")) return;
    try {
      await api(`/banking/deposit/${id}/reverse`, {
        method: "POST", body: JSON.stringify({ reason }),
      });
      toast("Deposit reversed", "success");
      renderHistory();
    } catch (e) {
      toast("Reverse failed: " + e.message, "error");
    }
  }

  // ====================================================================
  // Subtab: Unofficial Cash
  // ====================================================================
  // Cash payments from stays that closed without a bill number. Backend
  // endpoint /banking/unofficial returns them; this view is read-only.
  async function renderUnofficial(periodStart, periodEnd) {
    const live = _claimRender();
    setPane(`<div class="bk-empty"><span class="bk-spinner"></span> Loading unofficial cash...</div>`);
    // Use the global period selector at the top of Banking.
    const _gp = _defaultPeriod();
    if (!periodStart) periodStart = _gp.start;
    if (!periodEnd)   periodEnd   = _gp.end;
    try {
      const r = await api(
        "/banking/unofficial?limit=500"
        + "&period_start=" + encodeURIComponent(periodStart)
        + "&period_end="   + encodeURIComponent(periodEnd),
      );
      if (!live()) return;
      state.unofficial = r.payments || [];
      state.unofficialExpenses = r.expenses || [];
      const rows = state.unofficial;
      const exps = state.unofficialExpenses;
      // Use nullish coalescing, NOT `||`: inflows_paise is legitimately 0
      // when there are no unofficial payments. With `||`, a 0 inflow fell
      // through to total_paise (the net in − out), which double-counted
      // every expense — e.g. one ₹20,000 expense showed Net -₹40,000.
      // `?? r.total_paise` is kept only as a fallback for an older API
      // response shape that returned just total_paise.
      const inflows  = Number(r.inflows_paise  ?? r.total_paise ?? 0);
      const outflows = Number(r.outflows_paise ?? 0);
      const total    = inflows - outflows;
      const uniqueStays = new Set(rows.map((p) => p.stay_id)).size;

      // Period filter lives in the global header now — no per-tab bar.
      const filterBar = "";
      const headerCard = `
<div class="bk-coh-card" style="background: linear-gradient(135deg, #6c757d, #495057); margin-bottom:0.7rem;">
  <div class="bk-coh-label">Net unofficial cash in period</div>
  <div class="bk-coh-amount">${esc(fmtRupees(total))}</div>
  <div class="bk-coh-foot">
    <div>+${esc(fmtRupees(inflows))} in (${rows.length} pay${rows.length === 1 ? "ment" : "ments"})
      &middot; -${esc(fmtRupees(outflows))} out (${exps.length} expense${exps.length === 1 ? "" : "s"})</div>
    <div class="bk-muted" style="opacity:0.9;">Audit-only &middot; never deposited</div>
  </div>
</div>
`;
      if (rows.length === 0 && exps.length === 0) {
        setPane(filterBar + headerCard
          + `<div class="bk-empty">No unofficial cash activity in this period.</div>`);
        return;
      }
      const paymentsTable = rows.length === 0 ? "" : `
<div class="bk-section-title" style="margin-top:0.8rem;">
  Unofficial cash collected (from non-invoiced stays)
  <span class="bk-sub">${rows.length} entr${rows.length === 1 ? "y" : "ies"} &middot; ${uniqueStays} stay${uniqueStays === 1 ? "" : "s"}</span>
</div>
<div class="bk-table-wrap">
  <table class="bk-table">
    <thead><tr>
      <th>Date</th>
      <th>Guest / Room</th>
      <th>Stay ID</th>
      <th>Type</th>
      <th class="bk-num">Amount</th>
    </tr></thead>
    <tbody>
      ${rows.map((p) => `
        <tr>
          <td>${esc(fmtDate(p.date || p.created_at))}</td>
          <td>${esc(p.name || "")}${p.room ? " &middot; Room " + esc(p.room) : ""}</td>
          <td class="bk-mono bk-muted">${esc((p.stay_id || "").slice(0, 8))}</td>
          <td>${esc(p.type || "")}</td>
          <td class="bk-num bk-mono">${esc(fmtRupees(p.amount_paise || (p.amount||0)*100))}</td>
        </tr>`).join("")}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="4" style="text-align:right;">Total in</td>
        <td class="bk-num bk-mono"><strong>+${esc(fmtRupees(inflows))}</strong></td>
      </tr>
    </tfoot>
  </table>
</div>
`;
      const expensesTable = exps.length === 0 ? "" : `
<div class="bk-section-title" style="margin-top:0.8rem;">
  Unofficial cash expenses (report-type, paid from off-deposit cash)
  <span class="bk-sub">${exps.length} entr${exps.length === 1 ? "y" : "ies"}</span>
</div>
<div class="bk-table-wrap">
  <table class="bk-table">
    <thead><tr>
      <th>Date</th>
      <th>Category</th>
      <th>Description</th>
      <th class="bk-num">Amount</th>
    </tr></thead>
    <tbody>
      ${exps.map((x) => {
        const cat = x.category || x.category_id || "";
        const descParts = [];
        if (x.vendor_name) descParts.push(esc(x.vendor_name));
        if (x.description) descParts.push(esc(x.description));
        if (x.paid_to) descParts.push("paid to " + esc(x.paid_to));
        const descHTML = descParts.join(" &middot; ") || "<span class='bk-muted'>—</span>";
        return `<tr>
          <td>${esc(fmtDate(x.expense_date || x.date))}</td>
          <td>${esc(cat)}</td>
          <td>${descHTML}</td>
          <td class="bk-num bk-mono bk-neg">-${esc(fmtRupees(x.amount_paise || (x.amount||0)*100))}</td>
        </tr>`;
      }).join("")}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="3" style="text-align:right;">Total out</td>
        <td class="bk-num bk-mono"><strong>-${esc(fmtRupees(outflows))}</strong></td>
      </tr>
    </tfoot>
  </table>
</div>
`;
      setPane(filterBar + headerCard + paymentsTable + expensesTable);
    } catch (e) {
      if (!live()) return;
      setPane(`<div class="bk-empty">Failed to load: ${esc(e.message)}</div>`);
    }
  }

  function _wireUnofficialFilter() {
    const apply = dom("bk-unof-apply");
    if (apply) apply.addEventListener("click", () => {
      const s = (dom("bk-unof-start") || {}).value;
      const e = (dom("bk-unof-end")   || {}).value;
      if (!s || !e) { toast("Pick both start and end dates", "error"); return; }
      if (s > e)     { toast("Start date must be before end date", "error"); return; }
      renderUnofficial(s, e);
    });
  }

  // ====================================================================
  // Subtab: Adjustments
  // ====================================================================
  async function renderAdjustments() {
    const live = _claimRender();
    setPane(`<div class="bk-empty"><span class="bk-spinner"></span> Loading adjustments...</div>`);
    try {
      const r = await api("/banking/adjustment/list?limit=200");
      if (!live()) return;
      state.adjustments = r.adjustments || [];
      const rows = state.adjustments;
      const canCreate = userCan("banking.adjustment.create");
      setPane(`
${canCreate ? `
  <div style="margin-bottom:0.6rem;">
    <button class="bk-cta-btn" style="max-width:220px;" id="bk-new-adj">
      <i class="fas fa-plus"></i> New Adjustment
    </button>
  </div>` : `
  <p class="bk-muted" style="margin-bottom:0.6rem;">
    Creating adjustments requires admin.
  </p>`}
${rows.length === 0 ? `<div class="bk-empty">No adjustments recorded.</div>` : `
<div class="bk-table-wrap">
  <table class="bk-table">
    <thead><tr>
      <th>Date</th>
      <th>Reason</th>
      <th>Notes</th>
      <th class="bk-num">Amount</th>
      <th>Linked deposit</th>
      <th>Status</th>
    </tr></thead>
    <tbody>
      ${rows.map((a) => `
        <tr>
          <td>${esc(fmtDate(a.adjustment_date))}</td>
          <td>${esc(a.reason)}</td>
          <td>${esc(a.notes || "")}</td>
          <td class="bk-num bk-mono">${esc(fmtRupees(a.amount_paise || 0))}</td>
          <td class="bk-mono">${esc(a.cash_deposit_id || "—")}</td>
          <td>${a.voided_at ? `<span class="bk-pill bk-pill-reversed">voided</span>`
                : (a.cash_deposit_id ? `<span class="bk-pill bk-pill-confirmed">linked</span>`
                : `<span class="bk-pill bk-pill-eligible">open</span>`)}</td>
        </tr>`).join("")}
    </tbody>
  </table>
</div>
`}`);
      const n = dom("bk-new-adj");
      if (n) n.addEventListener("click", _openAdjModal);
    } catch (e) {
      if (!live()) return;
      setPane(`<div class="bk-empty">Failed to load: ${esc(e.message)}</div>`);
    }
  }

  function _openAdjModal() {
    _modal({
      title: '<i class="fas fa-balance-scale"></i> New Cash Adjustment',
      body: `
<label>Date</label>
<input type="date" id="bk-adj-date" value="${todayISO()}">
<label>Reason</label>
<select id="bk-adj-reason">
  <option value="opening_balance">Opening balance</option>
  <option value="cash_over">Cash over (drawer count high)</option>
  <option value="cash_short">Cash short (drawer count low)</option>
  <option value="owner_withdrawal">Owner withdrawal</option>
  <option value="owner_deposit">Owner deposit</option>
  <option value="petty_expense">Petty expense</option>
  <option value="bank_reversal">Bank reversal</option>
  <option value="other">Other</option>
</select>
<label>Amount in &#8377; (signed: negative = cash out)</label>
<input type="text" id="bk-adj-amount" placeholder="e.g. -250 or 1000">
<label>Notes</label>
<textarea id="bk-adj-notes" placeholder="What happened? Why?"></textarea>
`,
      okText: "Save",
      onOk: async () => {
        const date = (dom("bk-adj-date") || {}).value || todayISO();
        const reason = (dom("bk-adj-reason") || {}).value;
        const amount = (dom("bk-adj-amount") || {}).value;
        const notes = (dom("bk-adj-notes") || {}).value || "";
        if (!amount || isNaN(Number(amount.replace(/^-/, ""))) || Number(amount) === 0) {
          toast("Enter a non-zero amount", "error");
          return false;
        }
        try {
          await api("/banking/adjustment", {
            method: "POST",
            body: JSON.stringify({
              adjustment_date: date, amount, reason, notes,
            }),
          });
          toast("Adjustment saved", "success");
          renderAdjustments();
          return true;
        } catch (e) {
          toast("Failed: " + e.message, "error");
          return false;
        }
      },
    });
  }

  // ====================================================================
  // Subtab: Bank Accounts
  // ====================================================================
  async function renderBankAccounts() {
    const live = _claimRender();
    setPane(`<div class="bk-empty"><span class="bk-spinner"></span> Loading accounts...</div>`);
    try {
      const r = await api("/banking/bank_accounts");
      if (!live()) return;
      state.bankAccounts = r.accounts || [];
      const rows = state.bankAccounts;
      const canManage = userCan("banking.account.manage");
      setPane(`
${canManage ? `
  <div style="margin-bottom:0.6rem;">
    <button class="bk-cta-btn" style="max-width:240px;" id="bk-new-acct">
      <i class="fas fa-plus"></i> Add Bank Account
    </button>
  </div>` : `
  <p class="bk-muted" style="margin-bottom:0.6rem;">
    Managing accounts requires admin.
  </p>`}
${rows.length === 0 ? `<div class="bk-empty">No bank accounts configured.</div>` : `
<div class="bk-table-wrap">
  <table class="bk-table">
    <thead><tr>
      <th>Name</th>
      <th>Bank</th>
      <th>Last 4</th>
      <th>IFSC</th>
      <th>Default</th>
      <th></th>
    </tr></thead>
    <tbody>
      ${rows.map((a) => `
        <tr>
          <td><strong>${esc(a.name)}</strong></td>
          <td>${esc(a.bank)}</td>
          <td class="bk-mono">XX${esc(a.account_no_last4 || "")}</td>
          <td class="bk-mono">${esc(a.ifsc || "")}</td>
          <td>${a.is_default ? '<span class="bk-pill bk-pill-confirmed">default</span>' : ""}</td>
          <td>
            ${canManage ? `
              <button class="bk-cta-btn bk-danger" style="margin-top:0; padding:0.25rem 0.55rem; font-size:0.7rem;"
                      data-arch="${esc(a.id)}">Archive</button>` : ""}
          </td>
        </tr>`).join("")}
    </tbody>
  </table>
</div>
`}`);
      const n = dom("bk-new-acct");
      if (n) n.addEventListener("click", _openAcctModal);
      $$("#banking-tab [data-arch]").forEach((b) =>
        b.addEventListener("click", () => _archiveAcct(b.dataset.arch)));
    } catch (e) {
      if (!live()) return;
      setPane(`<div class="bk-empty">Failed to load: ${esc(e.message)}</div>`);
    }
  }

  function _openAcctModal() {
    _modal({
      title: '<i class="fas fa-landmark"></i> Add Bank Account',
      body: `
<label>Display name</label>
<input type="text" id="bk-acct-name" placeholder="e.g. HDFC Current">
<label>Bank</label>
<input type="text" id="bk-acct-bank" placeholder="e.g. HDFC Bank">
<label>Account number</label>
<input type="text" id="bk-acct-acno" placeholder="full account number">
<label>IFSC</label>
<input type="text" id="bk-acct-ifsc" placeholder="e.g. HDFC0000123">
<label>Branch</label>
<input type="text" id="bk-acct-branch" placeholder="optional">
<label style="display:flex; align-items:center; gap:0.4rem; font-weight:600;">
  <input type="checkbox" id="bk-acct-default"> Make default
</label>
`,
      okText: "Save",
      onOk: async () => {
        const name = (dom("bk-acct-name") || {}).value || "";
        const bank = (dom("bk-acct-bank") || {}).value || "";
        const acno = (dom("bk-acct-acno") || {}).value || "";
        const ifsc = (dom("bk-acct-ifsc") || {}).value || "";
        const branch = (dom("bk-acct-branch") || {}).value || "";
        const isDefault = !!(dom("bk-acct-default") || {}).checked;
        if (!name || !bank || !acno) {
          toast("Name, bank, and account number are required", "error");
          return false;
        }
        try {
          await api("/banking/bank_accounts", {
            method: "POST",
            body: JSON.stringify({
              name, bank, account_number: acno, ifsc, branch,
              is_default: isDefault,
            }),
          });
          toast("Account added", "success");
          renderBankAccounts();
          return true;
        } catch (e) {
          toast("Failed: " + e.message, "error");
          return false;
        }
      },
    });
  }

  async function _archiveAcct(id) {
    if (!confirm("Archive this account? It will be hidden from the deposit picker.")) return;
    try {
      await api(`/banking/bank_accounts/${id}/archive`, { method: "POST" });
      toast("Archived", "success");
      renderBankAccounts();
    } catch (e) {
      toast("Failed: " + e.message, "error");
    }
  }

  // ====================================================================
  // Modal helper
  // ====================================================================
  function _modal({ title, body, okText, onOk }) {
    // Remove any pre-existing modal
    const existing = dom("bk-modal");
    if (existing) existing.remove();

    const backdrop = document.createElement("div");
    backdrop.id = "bk-modal";
    backdrop.className = "bk-modal-backdrop";
    backdrop.innerHTML = `
<div class="bk-modal">
  <div class="bk-modal-header">
    <h2>${title}</h2>
    <button class="bk-modal-close" aria-label="Close">&times;</button>
  </div>
  <div class="bk-modal-body">${body}</div>
  <div class="bk-modal-footer">
    <button class="bk-cta-btn bk-secondary" id="bk-modal-cancel" style="max-width:120px; margin-top:0;">Cancel</button>
    <button class="bk-cta-btn" id="bk-modal-ok" style="max-width:160px; margin-top:0;">${esc(okText || "Save")}</button>
  </div>
</div>`;
    document.body.appendChild(backdrop);

    function close() { backdrop.remove(); }
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });
    $(".bk-modal-close", backdrop).addEventListener("click", close);
    dom("bk-modal-cancel").addEventListener("click", close);
    dom("bk-modal-ok").addEventListener("click", async () => {
      const result = await onOk();
      if (result !== false) close();
    });
  }

  // ====================================================================
  // Boot
  // ====================================================================
  function bootRoleAware() {
    buildHTML();

    // Quick-action floating button shortcut — clicking the "Banking"
    // entry in the lightning-bolt menu jumps the user straight to the
    // Banking tab. Banking has no bottom-nav slot, so the handler does
    // the tab switch directly: hide every .tab-content, un-mark every
    // .nav-item as active, then reveal #banking-tab. Mirrors what
    // script.js's nav-item click handler does for other tabs.
    const quickBtn = document.getElementById("quick-banking-btn");
    if (quickBtn) {
      quickBtn.addEventListener("click", () => {
        // Close the quick-action drawer
        const menu = document.querySelector(".quick-action-menu");
        if (menu) menu.classList.remove("show", "open");
        // Hide every tab and clear any nav-item active state
        document.querySelectorAll(".tab-content").forEach((c) => {
          c.classList.add("hidden");
        });
        document.querySelectorAll(".nav-item").forEach((n) => {
          n.classList.remove("active");
        });
        // Reveal the Banking tab and trigger a fresh render
        const tab = dom("banking-tab");
        if (tab) tab.classList.remove("hidden");
        setTimeout(() => renderActive(true), 30);
      });
    }

    // Auto-refresh on tab activation: watch nav clicks
    const navItem = document.querySelector('.nav-item[data-tab="banking"]');
    if (navItem) {
      navItem.addEventListener("click", () => {
        // Defer so the tab-content becomes visible first
        setTimeout(() => renderActive(true), 30);
      });
    }
  }

  function bootWhenReady() {
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
// END OF FILE — anything below this comment is stray and ignored.
/*
    if (navItem) {
      navItem.addEventListener("click", () => {
        // Defer so the tab-content becomes visible first
        setTimeout(() => renderActive(true), 30);
      });
    }
  }

  function bootWhenReady() {
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
-modal-body">${body}</div>
  <div class="bk-modal-footer">
    <button class="bk-cta-btn bk-secondary" id="bk-modal-cancel" style="max-width:120px; margin-top:0;">Cancel</button>
    <button class="bk-cta-btn" id="bk-modal-ok" style="max-width:160px; margin-top:0;">${esc(okText || "Save")}</button>
  </div>
</div>`;
    document.body.appendChild(backdrop);
    function close() { backdrop.remove(); }
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });
    $(".bk-modal-close", backdrop).addEventListener("click", close);
    dom("bk-modal-cancel").addEventListener("click", close);
    dom("bk-modal-ok").addEventListener("click", async () => {
      const result = await onOk();
      if (result !== false) close();
    });
  }

  // ====================================================================
  // Boot
  // ====================================================================
  function bootRoleAware() {
    buildHTML();
    const navItem = document.querySelector('.nav-item[data-tab="banking"]');
    if (navItem) {
      navItem.addEventListener("click", () => {
        setTimeout(() => renderActive(true), 30);
      });
    }
  }

  function bootWhenReady() {
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
*/
