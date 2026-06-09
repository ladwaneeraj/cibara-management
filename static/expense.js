// expense.js — Expense modal with tiered category-driven fields + invoice photo upload

// ─── Category tier config ────────────────────────────────────────────────────
// salary      → show Paid To field, no bill/GST
// tier1       → quick entry only (rent, petty_cash)
// tier2       → optional bill checkbox (utilities, maintenance, sanitary, others)
// tier3       → bill is expected, auto-expands bill+GST section (purchase)
// commission  → Booking.com commission fields
const CATEGORY_TIER = {
  salary:             "salary",
  rent:               "tier1",
  petty_cash:         "tier1",
  utilities:          "tier2",
  purchase:           "tier3",
  maintenance:        "tier2",
  sanitary:           "tier2",
  booking_commission: "commission",
  others:             "tier2",
};

// Format any common date input (YYYY-MM-DD, ISO, or Date-parseable string)
// to DD/MM/YYYY for display. Keeps storage / API formats untouched —
// callers should pass the raw value in and use the return value only
// for rendering. Returns empty string on invalid input so failure
// produces a blank, not "NaN/NaN/NaN".
function _fmtDateIN(raw) {
  if (!raw) return "";
  // Fast path: server emits "YYYY-MM-DD" — split, reorder, no Date object.
  if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const ymd = raw.slice(0, 10).split("-");
    return ymd[2] + "/" + ymd[1] + "/" + ymd[0];
  }
  // Fallback: try Date parsing for anything else (ISO, RFC 2822, etc.).
  const d = new Date(raw);
  if (isNaN(d.getTime())) return String(raw);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = d.getFullYear();
  return dd + "/" + mm + "/" + yy;
}

let expenseType = "transaction";
let _invoicePhotoUrl = "";
let _invoiceUploadInProgress = false;
let _pendingInvoiceFile = null;   // File object selected by user — uploaded on submit

// ─── Edit-mode state ─────────────────────────────────────────────────────────
// When admin clicks the pencil icon on an existing expense row, the modal
// opens in edit mode: pre-filled with the existing values, submit hits
// PATCH /expense/<doc_id> instead of POST /add_expense. State is reset
// on every modal open (showExpenseModal) and after a successful submit.
let _expenseEditMode = false;
let _expenseEditDocId = null;

// ─── OCR state ───────────────────────────────────────────────────────────────
// Cached availability check from /ocr/status. We probe once on page boot;
// the UI hides all auto-fill affordances when OCR is disabled server-side.
let _ocrEnabled = null;        // null = unknown, true/false once probed
let _ocrInflight = false;       // re-entry guard so a slow scan can't pile up

async function _checkOcrEnabled() {
  if (_ocrEnabled !== null) return _ocrEnabled;
  try {
    const res = await apiFetch("/ocr/status", { method: "GET" });
    if (!res.ok) { _ocrEnabled = false; return false; }
    const data = await res.json();
    _ocrEnabled = !!(data && data.enabled);
  } catch (_) {
    _ocrEnabled = false;
  }
  return _ocrEnabled;
}

// ─── Preset tiles cache ──────────────────────────────────────────────────────
// Shape: { <category>: [ { id, name, default_amount } ] }
// Populated lazily on first modal open and refreshed when admin edits
// the list. A "stale" flag triggers a re-fetch on next modal open.
let _expensePresetsCache = null;
let _expensePresetsCacheStale = true;

async function _loadExpensePresets(force) {
  if (!force && _expensePresetsCache && !_expensePresetsCacheStale) {
    return _expensePresetsCache;
  }
  try {
    const res = await apiFetch("/expense_presets", { method: "GET" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (data && data.success) {
      _expensePresetsCache = data.presets || {};
      _expensePresetsCacheStale = false;
    } else {
      _expensePresetsCache = _expensePresetsCache || {};
    }
  } catch (e) {
    console.warn("expense presets load failed (non-fatal):", e);
    // Don't block the modal — operators can still type free-text.
    _expensePresetsCache = _expensePresetsCache || {};
  }
  return _expensePresetsCache;
}

// Called by the admin preset manager after a write so the next modal
// open re-fetches. Exposed on window for cross-script access.
function invalidateExpensePresetsCache() {
  _expensePresetsCacheStale = true;
}
window.invalidateExpensePresetsCache = invalidateExpensePresetsCache;

// ─── Initialize ──────────────────────────────────────────────────────────────
function initializeExpense() {
  const addExpenseBtn = document.getElementById("add-expense-btn");
  if (addExpenseBtn) addExpenseBtn.addEventListener("click", () => {
    // Admin gets to choose between Daily / From-Account at form-open
    // time. Non-admin (manager) keeps the locked-to-transaction
    // behaviour they had before.
    const isAdmin = window.CibaraAuth
      && typeof window.CibaraAuth.userCan === "function"
      && window.CibaraAuth.userCan("banking.adjustment.create");
    showExpenseModal("transaction", { allowTypeToggle: isAdmin });
  });

  const addReportExpenseBtn = document.getElementById("add-report-expense-btn");
  if (addReportExpenseBtn) addReportExpenseBtn.addEventListener("click", () => showExpenseModal("report"));

  const expenseForm = document.getElementById("expense-form");
  if (expenseForm) expenseForm.addEventListener("submit", submitExpense);

  // Expense type toggle (Daily / From Account)
  document.querySelectorAll("#expense-form .exp-type-btn").forEach((btn) => {
    btn.addEventListener("click", function () {
      document.querySelectorAll("#expense-form .exp-type-btn").forEach((b) => {
        b.classList.remove("active");
        b.style.background = "transparent";
        b.style.color = "";
      });
      this.classList.add("active");
      this.style.background = "#e53e3e";
      this.style.color = "#fff";
      const type = this.getAttribute("data-type");
      expenseType = type;
      const typeInput = document.getElementById("expense-type");
      if (typeInput) typeInput.value = type;
      _updateSplitVisibility();
      _applyPaymentMethodUI();
    });
  });

  // Payment method buttons
  document.querySelectorAll("#expense-form .payment-btn").forEach((btn) => {
    btn.addEventListener("click", function () {
      document.querySelectorAll("#expense-form .payment-btn").forEach((b) => b.classList.remove("active"));
      this.classList.add("active");
      document.getElementById("expense-payment-method").value = this.getAttribute("data-payment");
    });
  });

  // Split-payment toggle + amount linkage (admin only; visibility is
  // managed by _updateSplitVisibility()).
  const splitToggle = document.getElementById("expense-split-toggle");
  if (splitToggle) splitToggle.addEventListener("change", _onSplitToggle);
  ["expense-split-counter", "expense-split-home", "expense-split-account"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", _recalcSplit);
  });
  // Changing the total re-checks the running allocation.
  const amountEl = document.getElementById("expense-amount");
  if (amountEl) amountEl.addEventListener("input", () => {
    if (_isSplitEnabled()) _recalcSplit();
  });

  // Category change → morph form
  const categorySelect = document.getElementById("expense-category");
  if (categorySelect) categorySelect.addEventListener("change", _onCategoryChange);

  // Has-bill checkbox
  const hasBillChk = document.getElementById("expense-has-bill");
  if (hasBillChk) hasBillChk.addEventListener("change", _onHasBillChange);

  // Has-GST checkbox
  const hasGstChk = document.getElementById("expense-has-gst");
  if (hasGstChk) hasGstChk.addEventListener("change", _onHasGstChange);

  // GST auto-calc
  ["expense-taxable-amount", "expense-gst-rate"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", _recalcGst);
  });

  // Commission total auto-calc
  ["commission-amount", "commission-gst"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", _recalcCommissionTotal);
  });

  // Commission payment status → show/hide date
  const commPayStatus = document.getElementById("commission-payment-status");
  if (commPayStatus) {
    commPayStatus.addEventListener("change", function () {
      const dg = document.getElementById("commission-payment-date-group");
      if (dg) dg.style.display = this.value === "paid" ? "block" : "none";
    });
  }

  _initInvoiceUpload();

  // "Manage list" inside the expense modal — opens the admin-only
  // preset manager. The button itself is hidden for non-admins in
  // showExpenseModal, so this click handler is defensive only.
  const manageBtn = document.getElementById("expense-preset-manage-btn");
  if (manageBtn) {
    manageBtn.addEventListener("click", () => {
      if (typeof window.openExpensePresetManager === "function") {
        const currentCat = document.getElementById("expense-category")?.value || "";
        window.openExpensePresetManager(currentCat);
      }
    });
  }

  const closeBtn = document.querySelector("#expense-modal .close-btn");
  if (closeBtn) closeBtn.addEventListener("click", () => document.getElementById("expense-modal")?.classList.remove("show"));
}

// Categories that don't get an invoice-photo attach option. These are
// either pure cash transactions (no vendor invoice) or recurring fixed
// payments where a photo adds no value:
//   - salary     → paid to staff, recorded by name
//   - rent       → fixed monthly account-level cost
//   - petty_cash → small everyday items, no bill expected
const NO_PHOTO_CATEGORIES = ["salary", "rent", "petty_cash"];

// ─── Preset tile rendering ────────────────────────────────────────────────────
// Render the admin-configured quick-pick tiles for the current category.
// Clicking a tile fills the target field (description, or paid-to for
// salary) and the amount input if the preset has a default_amount.
function _renderPresetTiles(category) {
  const wrapper = document.getElementById("expense-preset-tiles-wrapper");
  const tilesEl = document.getElementById("expense-preset-tiles");
  const countEl = document.getElementById("expense-preset-tiles-count");
  if (!wrapper || !tilesEl) return;

  // Always reset selection state on category change
  tilesEl.innerHTML = "";
  if (!category) {
    wrapper.style.display = "none";
    return;
  }

  const items = (_expensePresetsCache && _expensePresetsCache[category]) || [];
  if (items.length === 0) {
    // Hide the wrapper unless the user is an admin — admin should
    // still see the "Manage list" affordance to seed the list.
    const isAdmin = window.CibaraAuth
      && typeof window.CibaraAuth.userCan === "function"
      && window.CibaraAuth.userCan("expense.presets.manage");
    if (!isAdmin) {
      wrapper.style.display = "none";
      return;
    }
    wrapper.style.display = "block";
    if (countEl) countEl.textContent = "(none yet)";
    const empty = document.createElement("div");
    empty.className = "exp-preset-empty";
    empty.textContent = "No presets configured for this category. Click \"Manage list\" to add some.";
    tilesEl.appendChild(empty);
    return;
  }

  wrapper.style.display = "block";
  if (countEl) countEl.textContent = `(${items.length})`;

  // Target field depends on category — salary fills the staff-name
  // "Paid To" field, every other category fills the description.
  const targetId = category === "salary"
    ? "expense-paid-to"
    : "expense-description";

  items.forEach((it) => {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "exp-preset-tile";
    tile.dataset.presetId = it.id || "";
    const amt = (it.default_amount != null && it.default_amount > 0)
      ? `<span class="exp-preset-amt">₹${it.default_amount}</span>`
      : "";
    tile.innerHTML = `<span>${_escHtml(it.name || "")}</span>${amt}`;

    tile.addEventListener("click", () => {
      // Toggle the visual selection within the row
      tilesEl.querySelectorAll(".exp-preset-tile.is-selected")
        .forEach((t) => t.classList.remove("is-selected"));
      tile.classList.add("is-selected");

      // Fill the target field. For salary, this also triggers the
      // existing paid-to → description sync listener attached in
      // _onCategoryChange below, so we just need to dispatch input.
      const targetEl = document.getElementById(targetId);
      if (targetEl) {
        targetEl.value = it.name || "";
        targetEl.dispatchEvent(new Event("input", { bubbles: true }));
      }

      // Fill amount if a default is provided and the field is editable.
      if (it.default_amount != null && it.default_amount > 0) {
        const amountInput = document.getElementById("expense-amount");
        if (amountInput && !amountInput.readOnly) {
          amountInput.value = it.default_amount;
        }
      }
    });

    tilesEl.appendChild(tile);
  });
}

// Small HTML escape — preset names are admin-entered, but we still
// escape to keep XSS surface area at zero.
function _escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── Category change ──────────────────────────────────────────────────────────
function _onCategoryChange() {
  const category = document.getElementById("expense-category")?.value || "";
  const tier = CATEGORY_TIER[category] || "tier2";

  // Render quick-pick tiles for the new category. Uses the cached
  // preset map populated when the modal opens.
  _renderPresetTiles(category);

  _setDisplay("salary-fields", false);
  _setDisplay("has-bill-group", false);
  _setDisplay("bill-fields", false);
  _setDisplay("gst-fields", false);
  _setDisplay("commission-fields", false);

  // Hide the invoice-photo attach section for categories that shouldn't
  // collect proof. Also drop any pending file the user attached before
  // switching categories so it doesn't silently get uploaded on submit.
  const hidePhoto = NO_PHOTO_CATEGORIES.includes(category);
  _setDisplay("invoice-photo-section", !hidePhoto);
  if (hidePhoto) _clearInvoiceUpload();

  const amountInput = document.getElementById("expense-amount");
  if (amountInput) amountInput.readOnly = false;

  const hasBillChk = document.getElementById("expense-has-bill");
  if (hasBillChk) hasBillChk.checked = false;
  const hasGstChk = document.getElementById("expense-has-gst");
  if (hasGstChk) hasGstChk.checked = false;

  if (tier === "salary") {
    _setDisplay("salary-fields", true);
    // For salary, Description is replaced by "Paid To" — hide the notes field
    // and auto-fill it so the backend required check passes
    const descContainer = document.getElementById("expense-description-container");
    const descInput     = document.getElementById("expense-description");
    if (descContainer) descContainer.style.display = "none";
    if (descInput) {
      descInput.removeAttribute("required");
      if (!descInput.value) descInput.value = "Salary";
    }
    // Sync description when paid-to changes
    const paidToInput = document.getElementById("expense-paid-to");
    if (paidToInput) {
      paidToInput._salaryListener = paidToInput._salaryListener || function () {
        const d = document.getElementById("expense-description");
        if (d) d.value = paidToInput.value ? `Salary - ${paidToInput.value}` : "Salary";
      };
      paidToInput.removeEventListener("input", paidToInput._salaryListener);
      paidToInput.addEventListener("input", paidToInput._salaryListener);
    }
  } else {
    // Restore description field for non-salary categories
    const descContainer = document.getElementById("expense-description-container");
    const descInput     = document.getElementById("expense-description");
    if (descContainer) descContainer.style.display = "block";
    if (descInput) descInput.setAttribute("required", "required");
  }

  if (tier === "tier1") {
    // no extra fields
  } else if (tier === "tier2") {
    _setDisplay("has-bill-group", true);
  } else if (tier === "tier3") {
    // purchase: bill is expected, auto-expand
    _setDisplay("has-bill-group", true);
    if (hasBillChk) {
      hasBillChk.checked = true;
      _setDisplay("bill-fields", true);
    }
  } else if (tier === "commission") {
    _setDisplay("commission-fields", true);
    if (amountInput) amountInput.readOnly = true;
    _recalcCommissionTotal();
  }

  // Category change can make the split toggle (in)eligible.
  _updateSplitVisibility();
}

function _onHasBillChange() {
  const checked = document.getElementById("expense-has-bill")?.checked;
  _setDisplay("bill-fields", !!checked);
  if (!checked) {
    _setDisplay("gst-fields", false);
    const hasGstChk = document.getElementById("expense-has-gst");
    if (hasGstChk) hasGstChk.checked = false;
  }
  // A bill makes the expense ineligible for splitting (v1).
  _updateSplitVisibility();
}

function _onHasGstChange() {
  const checked = document.getElementById("expense-has-gst")?.checked;
  _setDisplay("gst-fields", !!checked);
  if (!checked) {
    ["expense-vendor-name", "expense-vendor-gstin", "expense-taxable-amount", "expense-gst-amount"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
    const rateEl = document.getElementById("expense-gst-rate");
    if (rateEl) rateEl.value = "";
  }
  // GST makes the expense ineligible for splitting (v1).
  _updateSplitVisibility();
}

// ─── GST auto-calc ────────────────────────────────────────────────────────────
function _recalcGst() {
  const taxable = parseFloat(document.getElementById("expense-taxable-amount")?.value) || 0;
  const rate    = parseFloat(document.getElementById("expense-gst-rate")?.value) || 0;
  const gst     = Math.round((taxable * rate) / 100);
  const gstInput = document.getElementById("expense-gst-amount");
  if (gstInput) gstInput.value = gst;
  // Also fill total — round to whole rupees so the amount is always an
  // integer (fractional totals break split allocation and the int-rupee model).
  const totalInput = document.getElementById("expense-amount");
  if (totalInput && !totalInput.readOnly) totalInput.value = Math.round(taxable + gst);
}

function _recalcCommissionTotal() {
  const commission = parseFloat(document.getElementById("commission-amount")?.value) || 0;
  const gst        = parseFloat(document.getElementById("commission-gst")?.value)    || 0;
  const amountInput = document.getElementById("expense-amount");
  if (amountInput) amountInput.value = commission + gst;
}

// ─── Invoice photo upload (compact inline) ───────────────────────────────────
function _initInvoiceUpload() {
  const attachBtn = document.getElementById("invoice-attach-btn");
  const fileInput = document.getElementById("expense-invoice-file");
  const removeBtn = document.getElementById("invoice-upload-remove");

  if (attachBtn && fileInput) {
    attachBtn.addEventListener("click", () => { if (!_invoiceUploadInProgress) fileInput.click(); });
    fileInput.addEventListener("change", _onInvoiceFileSelected);
  }
  if (removeBtn) removeBtn.addEventListener("click", (e) => { e.stopPropagation(); _clearInvoiceUpload(); });
}

function _onInvoiceFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;

  if (file.size > 5 * 1024 * 1024) {
    showNotification("File too large. Max 5 MB.", "error");
    return;
  }

  // Just store the file — actual upload happens on form submit
  _pendingInvoiceFile = file;
  _invoicePhotoUrl    = "";   // will be set after upload on submit

  const shortName = file.name.length > 28 ? file.name.substring(0, 25) + "…" : file.name;
  const statusEl  = document.getElementById("invoice-attach-status");
  const removeBtn = document.getElementById("invoice-upload-remove");

  if (statusEl) statusEl.innerHTML =
    `<i class="fas fa-paperclip" style="color:#3182ce;"></i> ${shortName} <span style="font-size:0.7rem;color:#718096;">(will upload on save)</span>`;
  if (removeBtn) removeBtn.style.display = "inline-block";

  // Fire OCR in the background. Only images (not PDFs) trigger auto-fill
  // here — Gemini can also read PDFs but the UX is less obvious; admin
  // can still hit "Re-scan" manually if they want.
  if (file.type && file.type.startsWith("image/")) {
    _runInvoiceOcr(file);
  }
}

// ─── OCR — extract & pre-fill from invoice photo ─────────────────────────────
// Strategy:
//   • Only fills FIELDS THAT ARE CURRENTLY EMPTY. We never overwrite a
//     value the user has typed. If they want to overwrite, they clear
//     the field then click "Re-scan".
//   • If has_gst comes back true we tick the bill + GST checkboxes so
//     the GST sub-form unfolds and the additional fields can be filled.
//   • Failures are silent: no banner, no popup — just leaves the form
//     for manual entry. We log to console for debugging.
async function _runInvoiceOcr(file) {
  if (_ocrInflight) return;
  const enabled = await _checkOcrEnabled();
  if (!enabled) return;     // server has no GEMINI_API_KEY — no UI noise.

  _ocrInflight = true;
  const statusEl = document.getElementById("invoice-attach-status");

  // Build the base "📎 filename (will upload on save)" label from scratch
  // each time. This avoids duplicating the OCR summary or Re-scan button
  // on repeated scans.
  const shortName = file.name.length > 28
    ? file.name.substring(0, 25) + "…"
    : file.name;
  const baseLabel =
    `<i class="fas fa-paperclip" style="color:#3182ce;"></i> ${shortName} ` +
    `<span style="font-size:0.7rem;color:#718096;">(will upload on save)</span>`;

  if (statusEl) {
    statusEl.innerHTML = baseLabel +
      ' <span style="font-size:0.78rem;color:#3182ce;margin-left:6px;">' +
      '<i class="fas fa-spinner fa-spin"></i> Reading bill…</span>';
  }

  // Inline status pill right under the Attach Invoice button. The
  // operator's eye is already on this section because they just tapped
  // the button, so it's the most natural place to surface progress —
  // no toast, no banner that crowds the form.
  _setOcrInlineStatus("loading", "Reading bill — extracting fields…");

  try {
    const formData = new FormData();
    formData.append("file", file);
    const res = await apiFetch("/ocr/expense_invoice", {
      method: "POST",
      body: formData,
    });
    const data = await res.json();

    // Always log the response so you can see what Gemini extracted.
    // Helpful for debugging "why didn't field X fill in?" — most often
    // the model returned null for that field due to image quality.
    console.log("[OCR] response:", data);

    if (!data || !data.success) {
      // ocr_disabled / ocr_error / bad_request
      if (statusEl) statusEl.innerHTML = baseLabel;
      if (data && data.reason && data.reason !== "ocr_disabled") {
        console.warn("OCR failed:", data.reason, data.message);
        _setOcrInlineStatus("error", "Could not read bill — please type manually");
      } else {
        // ocr_disabled — no UI noise (admin hasn't configured OCR).
        _setOcrInlineStatus("hidden");
      }
      return;
    }

    const filled = _applyOcrFields(data.fields || {});
    if (statusEl) {
      const ocrSummary = filled.length
        ? ` <span style="font-size:0.7rem;color:#2f855a;">✓ ${filled.length} field${filled.length > 1 ? "s" : ""} auto-filled — please verify</span>`
        : ` <span style="font-size:0.7rem;color:#718096;">(no fields detected — type manually)</span>`;
      const rescanBtn = ` <button type="button" id="invoice-rescan-btn"
        style="background:none;border:1px solid #cbd5e0;border-radius:5px;
               padding:1px 7px;font-size:0.7rem;color:#3182ce;cursor:pointer;
               margin-left:6px;line-height:1.6;">
        <i class="fas fa-redo"></i> Re-scan
      </button>`;
      statusEl.innerHTML = baseLabel + ocrSummary + rescanBtn;

      const rb = document.getElementById("invoice-rescan-btn");
      if (rb) rb.addEventListener("click", (ev) => {
        ev.preventDefault();
        if (_pendingInvoiceFile) _runInvoiceOcr(_pendingInvoiceFile);
      });
    }

    // Inline pill — green on success (auto-fades), amber on empty result.
    if (filled.length > 0) {
      _setOcrInlineStatus(
        "success",
        `✓ ${filled.length} field${filled.length > 1 ? "s" : ""} filled — please verify`,
        4000  // fade out after 4s
      );
    } else {
      _setOcrInlineStatus(
        "warn",
        "No fields could be read — please type manually"
      );
    }
  } catch (err) {
    console.warn("OCR network error:", err);
    if (statusEl) statusEl.innerHTML = baseLabel;
    _setOcrInlineStatus("error", "Network error reading bill — type manually");
  } finally {
    _ocrInflight = false;
  }
}

// ─── OCR inline status pill ──────────────────────────────────────────────────
// Single source of truth for the OCR feedback shown inside the modal.
// Renders as a coloured pill directly below the Attach Invoice button
// so the indicator sits where the operator's eye already is.
//
// States:
//   "loading" — blue, animated spinner + gentle pulse
//   "success" — green, checkmark, auto-fades after autoHideMs
//   "warn"    — amber, sticks (operator needs to know to type manually)
//   "error"   — red,   sticks
//   "hidden"  — removes from view
//
// The pill is created lazily and reused across scans within the same
// modal session. showExpenseModal calls _setOcrInlineStatus("hidden")
// on every fresh open so state never bleeds between two entries.
function _setOcrInlineStatus(state, message, autoHideMs) {
  // Anchor: place the pill immediately after the attach-button row,
  // inside #invoice-photo-section. Mounting it there ensures the pill
  // hides automatically when the section is hidden for salary / rent /
  // petty_cash (categories that disable invoice attach).
  const section = document.getElementById("invoice-photo-section");
  if (!section) return;

  let pill = document.getElementById("invoice-ocr-status");
  if (!pill) {
    pill = document.createElement("div");
    pill.id = "invoice-ocr-status";
    pill.style.cssText = [
      "display:none",
      "align-items:center",
      "gap:0.45rem",
      "padding:0.5rem 0.75rem",
      "margin-top:0.55rem",
      "border-radius:8px",
      "border:1px solid transparent",
      "font-size:0.82rem",
      "font-weight:500",
      "line-height:1.25",
      "transition:opacity 0.25s",
    ].join(";");
    section.appendChild(pill);
  }

  // Clear any pending auto-hide from a prior state transition.
  if (pill._hideTimer) {
    clearTimeout(pill._hideTimer);
    pill._hideTimer = null;
  }

  if (state === "hidden") {
    pill.style.display = "none";
    pill.style.opacity = "1";
    pill.style.animation = "";
    pill.innerHTML = "";
    return;
  }

  const palette = {
    loading: {
      bg: "#ebf5ff", border: "#90cdf4", color: "#2c5282",
      icon: '<i class="fas fa-spinner fa-spin"></i>',
      pulse: true,
    },
    success: {
      bg: "#f0fdf4", border: "#86efac", color: "#15803d",
      icon: '<i class="fas fa-check-circle"></i>',
    },
    warn: {
      bg: "#fffbeb", border: "#fcd34d", color: "#92400e",
      icon: '<i class="fas fa-exclamation-circle"></i>',
    },
    error: {
      bg: "#fef2f2", border: "#fca5a5", color: "#991b1b",
      icon: '<i class="fas fa-times-circle"></i>',
    },
  };
  const p = palette[state] || palette.loading;

  pill.style.background  = p.bg;
  pill.style.borderColor = p.border;
  pill.style.color       = p.color;
  pill.style.display     = "flex";
  pill.style.opacity     = "1";
  pill.style.animation   = p.pulse ? "expense-ocr-pulse 1.6s ease-in-out infinite" : "";
  pill.innerHTML         = `${p.icon}<span>${message}</span>`;

  if (autoHideMs && autoHideMs > 0) {
    pill._hideTimer = setTimeout(() => {
      pill.style.opacity = "0";
      setTimeout(() => {
        // Re-check display in case another state took over mid-fade.
        if (pill.style.opacity === "0") pill.style.display = "none";
      }, 260);
    }, autoHideMs);
  }
}

// Apply extracted fields to the form. Only writes to inputs that are
// currently empty so we don't trample on what the operator already
// typed. Returns the list of field labels that were actually filled —
// used to build the user-facing summary message.
function _applyOcrFields(fields) {
  const filled = [];

  const fillIfEmpty = (id, value, label) => {
    if (value == null || value === "") return;
    const el = document.getElementById(id);
    if (!el) return;
    if (el.value && el.value.trim() !== "") return;  // user typed already
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    _flashField(el);
    filled.push(label);
  };

  // Description doesn't require bill/GST sub-forms to be open.
  fillIfEmpty("expense-description", fields.description, "description");

  // Total amount is high-value: fill the primary amount field.
  fillIfEmpty("expense-amount", fields.amount, "amount");

  // ── Bill block ─────────────────────────────────────────────────────────
  // If the OCR found an invoice number we need the bill sub-form open.
  // Same for GST. We tick the checkboxes (and fire their change handlers)
  // only when the OCR signals the data exists AND the checkboxes are
  // currently off — never tear down sub-forms the user has already set up.
  const hasBillChk = document.getElementById("expense-has-bill");
  const wantsBill  = !!(fields.invoice_number || fields.invoice_date || fields.has_gst);
  if (wantsBill && hasBillChk && !hasBillChk.checked) {
    hasBillChk.checked = true;
    if (typeof _onHasBillChange === "function") _onHasBillChange();
  }
  fillIfEmpty("expense-invoice-number", fields.invoice_number, "invoice no.");
  fillIfEmpty("expense-invoice-date",   fields.invoice_date,   "invoice date");

  // ── GST block ──────────────────────────────────────────────────────────
  if (fields.has_gst) {
    const hasGstChk = document.getElementById("expense-has-gst");
    if (hasGstChk && !hasGstChk.checked) {
      hasGstChk.checked = true;
      if (typeof _onHasGstChange === "function") _onHasGstChange();
    }
    fillIfEmpty("expense-vendor-name",    fields.vendor_name,    "vendor");
    fillIfEmpty("expense-vendor-gstin",   fields.vendor_gstin,   "GSTIN");
    fillIfEmpty("expense-taxable-amount", fields.taxable_amount, "taxable amount");
    fillIfEmpty("expense-gst-rate",       fields.gst_rate,       "GST rate");
    fillIfEmpty("expense-gst-amount",     fields.gst_amount,     "GST amount");
  } else {
    // Even when there's no GST block on the bill, the vendor name is
    // still useful context for the description field. Skip if the form
    // doesn't have a separate vendor input shown.
    fillIfEmpty("expense-vendor-name", fields.vendor_name, "vendor");
  }

  return filled;
}

// Brief visual cue (1.5s amber outline) when a field is auto-populated
// so the operator's eye is drawn to the spots they need to verify.
function _flashField(el) {
  if (!el || !el.style) return;
  const original = el.style.boxShadow;
  el.style.boxShadow = "0 0 0 3px rgba(251, 191, 36, 0.55)";
  setTimeout(() => {
    if (el.style.boxShadow.includes("rgba(251, 191, 36")) {
      el.style.boxShadow = original;
    }
  }, 1500);
}

function _clearInvoiceUpload() {
  _invoicePhotoUrl    = "";
  _pendingInvoiceFile = null;
  const urlInput  = document.getElementById("expense-invoice-photo-url");
  if (urlInput) urlInput.value = "";
  const fileInput = document.getElementById("expense-invoice-file");
  if (fileInput) fileInput.value = "";
  _resetUploadStatus();
}

function _resetUploadStatus() {
  const statusEl  = document.getElementById("invoice-attach-status");
  const removeBtn = document.getElementById("invoice-upload-remove");
  if (statusEl) statusEl.textContent = "No file attached";
  if (removeBtn) removeBtn.style.display = "none";
}

// ─── Edit-mode entry point ───────────────────────────────────────────────────
// Called from the transaction-tab pencil icon. Opens the existing expense
// modal pre-populated with the log's values and flips internal state so
// submit dispatches a PATCH instead of a POST.
function openExpenseEditModal(log) {
  if (!log || !log._doc_id) {
    if (typeof showNotification === "function") {
      showNotification("Cannot edit — missing document id", "error");
    }
    return;
  }

  // Hard gate — UI is admin-only but defend the function entry too.
  const isAdmin = window.CibaraAuth
    && typeof window.CibaraAuth.userCan === "function"
    && window.CibaraAuth.userCan("expense.manage");
  if (!isAdmin) {
    if (typeof showNotification === "function") {
      showNotification("Only admins can edit expenses", "error");
    }
    return;
  }

  // Split-payment expenses are immutable inline (the server returns 409).
  // Guide the admin to delete + re-create instead of opening a form that
  // can't save.
  if (log.split_group_id) {
    if (typeof showNotification === "function") {
      showNotification(
        "Split-payment expense — delete it and re-create to change the amounts.",
        "info"
      );
    }
    return;
  }

  // Open the modal in the normal way so the standard reset path runs,
  // then flip into edit mode + populate. allowTypeToggle=true so admin
  // can move an expense between Daily and From-Account.
  const baseType = log.expense_type || "transaction";
  showExpenseModal(baseType, { allowTypeToggle: true });

  _expenseEditMode = true;
  _expenseEditDocId = log._doc_id;

  // Title + submit button reflect edit mode
  const title = document.getElementById("expense-modal-title");
  if (title) title.innerHTML = '<i class="fas fa-pen"></i> Edit Expense';
  const submitBtn = document.querySelector("#expense-form button[type=submit]");
  if (submitBtn) submitBtn.innerHTML = '<i class="fas fa-check"></i> Update Expense';

  // ── Populate fields ─────────────────────────────────────────────────────
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el != null && val != null) el.value = val;
  };
  const check = (id, on) => {
    const el = document.getElementById(id);
    if (el) el.checked = !!on;
  };

  set("expense-date", log.date || "");

  // Setting category programmatically and dispatching change triggers
  // _onCategoryChange which morphs the form (salary/tier1/tier2/tier3/
  // commission) so we don't have to duplicate that logic here.
  const catEl = document.getElementById("expense-category");
  if (catEl) {
    catEl.value = log.category || "";
    catEl.dispatchEvent(new Event("change", { bubbles: true }));
  }

  set("expense-description", log.description || "");
  set("expense-amount", log.amount || "");

  // Payment method buttons
  const pm = (log.payment_method || "cash").toLowerCase();
  document.querySelectorAll("#expense-form .payment-btn").forEach((b) => {
    const matches = b.getAttribute("data-payment") === pm;
    b.classList.toggle("active", matches);
  });
  const pmInput = document.getElementById("expense-payment-method");
  if (pmInput) pmInput.value = pm;

  // Expense type buttons (Daily / From Account)
  document.querySelectorAll("#expense-form .exp-type-btn").forEach((b) => {
    const matches = b.getAttribute("data-type") === baseType;
    b.classList.toggle("active", matches);
    b.style.background = matches ? "#e53e3e" : "transparent";
    b.style.color      = matches ? "#fff"    : "";
  });
  const typeInput = document.getElementById("expense-type");
  if (typeInput) typeInput.value = baseType;
  expenseType = baseType;

  // Salary
  if (log.category === "salary") {
    set("expense-paid-to", log.paid_to || "");
  }

  // Bill / GST
  if (log.has_bill) {
    check("expense-has-bill", true);
    _onHasBillChange();
    set("expense-invoice-number", log.invoice_number || "");
    set("expense-invoice-date", log.invoice_date || "");
  }
  if (log.has_gst) {
    check("expense-has-gst", true);
    _onHasGstChange();
    set("expense-vendor-name", log.vendor_name || "");
    set("expense-vendor-gstin", log.vendor_gstin || "");
    set("expense-taxable-amount", log.taxable_amount || "");
    set("expense-gst-rate", log.gst_rate || "");
    set("expense-gst-amount", log.gst_amount || "");
  }

  // Commission
  if (log.category === "booking_commission") {
    set("commission-platform", log.commission_platform || "booking.com");
    set("commission-amount", log.commission_amount || "");
    set("commission-gst", log.commission_gst || "");
    set("commission-invoice-number", log.commission_invoice_number || "");
    set("commission-invoice-date", log.commission_invoice_date || "");
    set("commission-payment-status", log.commission_payment_status || "pending");
    set("commission-payment-date", log.commission_payment_date || "");
    if (log.commission_payment_status === "paid") {
      _setDisplay("commission-payment-date-group", true);
    }
  }

  // Existing invoice photo URL — kept hidden but stored so PATCH doesn't drop it
  set("expense-invoice-photo-url", log.invoice_photo_url || "");
  if (log.invoice_photo_url) {
    const statusEl = document.getElementById("invoice-attach-status");
    if (statusEl) {
      statusEl.innerHTML =
        '<i class="fas fa-check-circle" style="color:#38a169;"></i> Invoice attached ' +
        `<a href="${log.invoice_photo_url}" target="_blank" rel="noopener" style="margin-left:4px;color:#3182ce;">view</a>`;
    }
  }

  // Daily expenses are cash-from-counter only; report expenses keep the
  // Home Cash / From Account choice. Apply that after the type is set.
  _applyPaymentMethodUI();
}
window.openExpenseEditModal = openExpenseEditModal;


// ─── Show modal ───────────────────────────────────────────────────────────────
function showExpenseModal(type, options) {
  const modal = document.getElementById("expense-modal");
  if (!modal) return;

  // Reset edit-mode flags on every fresh open. openExpenseEditModal
  // re-sets them AFTER calling this function so the pre-fill path works.
  _expenseEditMode = false;
  _expenseEditDocId = null;

  // Clear any stale OCR status from a previous expense entry.
  _setOcrInlineStatus("hidden");

  document.getElementById("expense-form")?.reset();

  // Load presets in the background — never block opening the modal.
  // If the cache is fresh and a category is selected, _onCategoryChange
  // already rendered tiles synchronously; this just keeps the cache warm.
  _loadExpensePresets(false).then(() => {
    const cat = document.getElementById("expense-category")?.value || "";
    if (cat) _renderPresetTiles(cat);
  });

  // Reset tiles UI to its empty state — they'll repopulate when a
  // category is chosen.
  const tilesWrap = document.getElementById("expense-preset-tiles-wrapper");
  if (tilesWrap) tilesWrap.style.display = "none";
  const tilesEl = document.getElementById("expense-preset-tiles");
  if (tilesEl) tilesEl.innerHTML = "";

  // Show the "Manage list" admin button only to users with the perm.
  const manageBtn = document.getElementById("expense-preset-manage-btn");
  if (manageBtn) {
    const isAdmin = window.CibaraAuth
      && typeof window.CibaraAuth.userCan === "function"
      && window.CibaraAuth.userCan("expense.presets.manage");
    manageBtn.style.display = isAdmin ? "inline-flex" : "none";
  }

  _setDisplay("salary-fields", false);
  _setDisplay("has-bill-group", false);
  _setDisplay("bill-fields", false);
  _setDisplay("gst-fields", false);
  _setDisplay("commission-fields", false);
  _setDisplay("commission-payment-date-group", false);

  // Always restore description field on modal open
  const descContainer = document.getElementById("expense-description-container");
  const descInput     = document.getElementById("expense-description");
  if (descContainer) descContainer.style.display = "block";
  if (descInput) descInput.setAttribute("required", "required");

  const hasBillChk = document.getElementById("expense-has-bill");
  if (hasBillChk) hasBillChk.checked = false;
  const hasGstChk = document.getElementById("expense-has-gst");
  if (hasGstChk) hasGstChk.checked = false;

  const amountInput = document.getElementById("expense-amount");
  if (amountInput) amountInput.readOnly = false;

  _invoicePhotoUrl    = "";
  _pendingInvoiceFile = null;
  _resetUploadStatus();
  const fileInput = document.getElementById("expense-invoice-file");
  if (fileInput) fileInput.value = "";

  // Default date = today
  const dateInput = document.getElementById("expense-date");
  if (dateInput) {
    const now = new Date();
    dateInput.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  // Default payment = cash
  document.querySelectorAll("#expense-form .payment-btn").forEach((b) => b.classList.remove("active"));
  document.querySelector("#expense-form .payment-btn.cash")?.classList.add("active");
  const pmInput = document.getElementById("expense-payment-method");
  if (pmInput) pmInput.value = "cash";

  expenseType = type;
  const typeInput = document.getElementById("expense-type");
  if (typeInput) typeInput.value = type;

  // ── Type toggle: shown OR locked depending on caller ──────────────────────
  // When opened from transaction tab by an admin (allowTypeToggle=true)
  //   → show the Daily / From-Account toggle so admin can pick.
  // When opened from report section, or from transaction tab as non-admin
  //   → lock to the type the button represents and show a static label.
  const typeToggleWrap = document.getElementById("expense-type-toggle");
  const typeLockLabel  = document.getElementById("expense-type-lock-label");
  const allowToggle = options && options.allowTypeToggle;
  if (typeToggleWrap) {
    typeToggleWrap.style.display = allowToggle ? "" : "none";
    if (allowToggle) {
      // Reflect the initial type in the toggle button's active state
      document.querySelectorAll("#expense-form .exp-type-btn").forEach((b) => {
        const matches = b.getAttribute("data-type") === type;
        b.classList.toggle("active", matches);
        b.style.background = matches ? "#e53e3e" : "transparent";
        b.style.color      = matches ? "#fff" : "";
      });
    }
  }
  if (typeLockLabel) {
    typeLockLabel.style.display = allowToggle ? "none" : "flex";
    if (type === "report") {
      typeLockLabel.innerHTML =
        '<i class="fas fa-university" style="color:#3182ce;"></i>' +
        '<span>From Account / Home</span>' +
        '<span style="font-size:0.7rem;color:#718096;margin-left:4px;">(paid from bank or personal cash)</span>';
    } else {
      typeLockLabel.innerHTML =
        '<i class="fas fa-store" style="color:#e53e3e;"></i>' +
        '<span>Daily Expense</span>' +
        '<span style="font-size:0.7rem;color:#718096;margin-left:4px;">(deducted from cash counter)</span>';
    }
  }

  // ── Category list: hide "Rent" and "Booking.com Commission" for daily ───────
  // Rent and DBC commission are account-level costs, not daily cash operations
  const _txnHidden = ["rent", "booking_commission"];
  const catSelect = document.getElementById("expense-category");
  if (catSelect) {
    Array.from(catSelect.options).forEach((opt) => {
      if (_txnHidden.includes(opt.value)) {
        opt.hidden   = (type === "transaction");
        opt.disabled = (type === "transaction");
      }
    });
    // If a hidden category was previously selected, reset
    if (type === "transaction" && _txnHidden.includes(catSelect.value)) {
      catSelect.value = "";
      _onCategoryChange();
    }
  }

  const title = document.getElementById("expense-modal-title");
  if (title) title.innerHTML = type === "report"
    ? '<i class="fas fa-university"></i> From Account / Home'
    : '<i class="fas fa-receipt"></i> Add Daily Expense';

  // Reset + re-evaluate the split toggle for this fresh open. form.reset()
  // above already cleared the checkbox; this restores the payment-method
  // block and decides whether the toggle should be offered at all.
  const splitToggle = document.getElementById("expense-split-toggle");
  if (splitToggle) splitToggle.checked = false;
  _onSplitToggle();
  _updateSplitVisibility();
  _applyPaymentMethodUI();

  modal.classList.add("show");
}

// ─── Submit ───────────────────────────────────────────────────────────────────
async function submitExpense(e) {
  e.preventDefault();

  const date          = document.getElementById("expense-date")?.value;
  const category      = document.getElementById("expense-category")?.value;
  const description   = document.getElementById("expense-description")?.value;
  const amountRaw     = document.getElementById("expense-amount")?.value;
  const paymentMethod = document.getElementById("expense-payment-method")?.value;
  const type          = document.getElementById("expense-type")?.value;

  if (!date || !category || !description || !amountRaw || !paymentMethod) {
    showNotification("Please fill all required fields", "error");
    return;
  }
  const amount = parseInt(amountRaw);
  if (isNaN(amount) || amount <= 0) {
    showNotification("Enter a valid amount", "error");
    return;
  }

  // Split-payment validation (mirrors validate_split in routes/reports.py —
  // the server re-validates; this is UX). At least two of the three sources
  // must be > 0 and all parts must sum to the total.
  const splitOn = _isSplitEnabled();
  let splitCounter = 0, splitHome = 0, splitAccount = 0;
  if (splitOn) {
    splitCounter = parseInt(document.getElementById("expense-split-counter")?.value) || 0;
    splitHome    = parseInt(document.getElementById("expense-split-home")?.value) || 0;
    splitAccount = parseInt(document.getElementById("expense-split-account")?.value) || 0;
    const positive = [splitCounter, splitHome, splitAccount].filter((x) => x > 0).length;
    if (positive < 2) {
      showNotification("A split needs at least two of: counter cash, home cash, account", "error");
      return;
    }
    if (splitCounter + splitHome + splitAccount !== amount) {
      showNotification(`Split parts must sum to the total ₹${amount}`, "error");
      return;
    }
  }

  // Validate: if has-bill checked, invoice number should be filled
  const hasBillChecked = document.getElementById("expense-has-bill")?.checked;
  if (hasBillChecked) {
    const invNo = document.getElementById("expense-invoice-number")?.value?.trim();
    if (!invNo) {
      showNotification("Please enter the Invoice / Bill number", "error");
      document.getElementById("expense-invoice-number")?.focus();
      return;
    }
  }

  // Validate: if has-gst checked, vendor name is required
  const hasGstChecked = document.getElementById("expense-has-gst")?.checked;
  if (hasGstChecked) {
    const vendorName = document.getElementById("expense-vendor-name")?.value?.trim();
    if (!vendorName) {
      showNotification("Vendor name is required for GST claims", "error");
      document.getElementById("expense-vendor-name")?.focus();
      return;
    }
    const taxable = parseFloat(document.getElementById("expense-taxable-amount")?.value) || 0;
    if (taxable <= 0) {
      showNotification("Enter taxable amount for GST bill", "error");
      document.getElementById("expense-taxable-amount")?.focus();
      return;
    }
  }

  const submitBtn = e.target.querySelector("button[type=submit]");
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="loader" style="width:20px;height:20px;"></span> Saving...';
  }

  try {
    // ── Upload photo if one was selected ──────────────────────────────────────
    if (_pendingInvoiceFile) {
      if (submitBtn) submitBtn.innerHTML =
        '<span class="loader" style="width:20px;height:20px;"></span> Uploading photo…';

      const statusEl = document.getElementById("invoice-attach-status");
      if (statusEl) statusEl.innerHTML =
        '<i class="fas fa-spinner fa-spin"></i> Uploading…';

      const formData = new FormData();
      formData.append("file", _pendingInvoiceFile);
      const upRes  = await fetch("/upload_expense_invoice", { method: "POST", body: formData });
      const upData = await upRes.json();

      if (upData.success) {
        _invoicePhotoUrl = upData.url;
        const urlInput = document.getElementById("expense-invoice-photo-url");
        if (urlInput) urlInput.value = upData.url;
        const shortName = _pendingInvoiceFile.name.length > 28
          ? _pendingInvoiceFile.name.substring(0, 25) + "…"
          : _pendingInvoiceFile.name;
        if (statusEl) statusEl.innerHTML =
          `<i class="fas fa-check-circle" style="color:#38a169;"></i> ${shortName}`;
        _pendingInvoiceFile = null;
      } else {
        // Photo upload failed — ask user whether to continue without photo
        if (!confirm("Photo upload failed: " + (upData.message || "Unknown error") + "\n\nSave expense without photo?")) {
          if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fas fa-check"></i> Save Expense'; }
          return;
        }
        _pendingInvoiceFile = null;
      }

      if (submitBtn) submitBtn.innerHTML =
        '<span class="loader" style="width:20px;height:20px;"></span> Saving...';
    }

    const tier = CATEGORY_TIER[category] || "tier2";
    const payload = { date, category, description, amount, payment_method: paymentMethod, type };

    // Split payment → backend writes two linked legs. `type`/payment_method
    // above are ignored by the split path on the server; the legs are fixed
    // (cash→transaction, UPI→report). Only sent on create (never edit).
    if (splitOn && !_expenseEditMode) {
      payload.split = {
        counter_cash: splitCounter,
        home_cash: splitHome,
        account: splitAccount,
      };
    }

    if (tier === "salary") {
      payload.paid_to = document.getElementById("expense-paid-to")?.value || "";
    }

    const hasBill = document.getElementById("expense-has-bill")?.checked;
    if (hasBill) {
      payload.has_bill       = true;
      payload.invoice_number = document.getElementById("expense-invoice-number")?.value || "";
      payload.invoice_date   = document.getElementById("expense-invoice-date")?.value   || "";
    }

    const hasGst = document.getElementById("expense-has-gst")?.checked;
    if (hasGst) {
      payload.has_gst        = true;
      payload.vendor_name    = document.getElementById("expense-vendor-name")?.value    || "";
      payload.vendor_gstin   = document.getElementById("expense-vendor-gstin")?.value   || "";
      payload.taxable_amount = parseFloat(document.getElementById("expense-taxable-amount")?.value) || 0;
      payload.gst_rate       = parseFloat(document.getElementById("expense-gst-rate")?.value)       || 0;
      payload.gst_amount     = parseFloat(document.getElementById("expense-gst-amount")?.value)     || 0;
    }

    const photoUrl = document.getElementById("expense-invoice-photo-url")?.value;
    if (photoUrl) payload.invoice_photo_url = photoUrl;

    if (tier === "commission") {
      payload.commission_platform       = document.getElementById("commission-platform")?.value              || "booking.com";
      payload.commission_amount         = parseFloat(document.getElementById("commission-amount")?.value)    || 0;
      payload.commission_gst            = parseFloat(document.getElementById("commission-gst")?.value)       || 0;
      payload.commission_invoice_number = document.getElementById("commission-invoice-number")?.value        || "";
      payload.commission_invoice_date   = document.getElementById("commission-invoice-date")?.value          || "";
      payload.commission_payment_status = document.getElementById("commission-payment-status")?.value        || "pending";
      payload.commission_payment_date   = document.getElementById("commission-payment-date")?.value          || "";
    }

    console.log("Submitting expense:", payload, "editMode:", _expenseEditMode);

    // ── Edit mode → PATCH /expense/<doc_id> ─────────────────────────────────
    // When editing, we send the same payload shape but to the PATCH
    // endpoint. The server's _EDITABLE_FIELDS whitelist filters anything
    // unexpected. has_bill / has_gst are sent as booleans so the server
    // can clear them when admin un-checks the box during edit; the
    // associated fields default to "" so they get blanked too.
    let response;
    if (_expenseEditMode && _expenseEditDocId) {
      // Force-include the toggles so unchecking actually clears them
      payload.has_bill = !!document.getElementById("expense-has-bill")?.checked;
      payload.has_gst  = !!document.getElementById("expense-has-gst")?.checked;
      response = await apiFetch("/expense/" + encodeURIComponent(_expenseEditDocId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } else {
      response = await apiFetch("/add_expense", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }

    // Read the body even on a non-2xx response so the server's specific
    // message (e.g. a split-validation reason) is shown instead of an opaque
    // "Server error: 400".
    const result = await response.json().catch(() => null);
    if (!result) throw new Error(`Server error: ${response.status}`);

    if (result.success) {
      document.getElementById("expense-modal")?.classList.remove("show");
      // Clear edit-mode now that submit succeeded
      const wasEdit = _expenseEditMode;
      _expenseEditMode = false;
      _expenseEditDocId = null;

      // Extended-range aware refresh so an edit/add to a PAST day (Last 3 days /
      // custom range) re-pulls from the server instead of leaving the stale row
      // on screen. Falls back to debouncedFetchData (Today view / older bundle).
      if (typeof window.refreshTransactionsView === "function") {
        window.refreshTransactionsView();
      } else {
        debouncedFetchData();
      }

      if (type === "report" &&
          document.getElementById("reports-tab") &&
          !document.getElementById("reports-tab").classList.contains("hidden")) {
        generateReport();
      }

      showNotification(
        result.message || (wasEdit ? "Expense updated" : "Expense added"),
        "success"
      );
    } else {
      showNotification(result.message || "Error saving expense", "error");
    }
  } catch (error) {
    console.error("Expense submit error:", error);
    showNotification(`Error: ${error.message}`, "error");
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i class="fas fa-check"></i> Save Expense';
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _setDisplay(id, show) {
  const el = document.getElementById(id);
  if (el) el.style.display = show ? "block" : "none";
}

// ─── Split payment (admin only) ─────────────────────────────────────────────
// A split records part of the expense as cash from the counter (a
// transaction expense) and the rest as UPI from the account (a report
// expense). The backend stores this as two linked documents; the frontend
// only collects the two amounts and a flag.

function _isAdminForSplit() {
  return !!(window.CibaraAuth
    && typeof window.CibaraAuth.userCan === "function"
    && window.CibaraAuth.userCan("expense.manage"));
}

function _isSplitEnabled() {
  const t = document.getElementById("expense-split-toggle");
  const wrap = document.getElementById("expense-split-toggle-wrap");
  // Only "enabled" if the control is both visible and checked.
  return !!(t && t.checked && wrap && wrap.style.display !== "none");
}

// Categories that are account-level (not daily counter cash) — must mirror
// _SPLIT_INELIGIBLE_CATEGORIES in routes/reports.py.
const SPLIT_INELIGIBLE_CATEGORIES = ["rent", "booking_commission"];

// Decide whether the split toggle should be offered, given the current
// form state. Eligible only for: admin, a Daily Expense (transaction),
// an eligible category, and no GST/bill attached. When not eligible the
// toggle is hidden AND any active split is torn down.
function _updateSplitVisibility() {
  const wrap = document.getElementById("expense-split-toggle-wrap");
  if (!wrap) return;

  const type = document.getElementById("expense-type")?.value || "transaction";
  const category = document.getElementById("expense-category")?.value || "";

  // A billed / GST purchase CAN be split — the invoice metadata is recorded
  // once on the primary leg server-side, so bills no longer block the toggle.
  const eligible = _isAdminForSplit()
    && !_expenseEditMode          // split is a create-time feature only
    && type === "transaction"
    && !!category
    && !SPLIT_INELIGIBLE_CATEGORIES.includes(category);

  wrap.style.display = eligible ? "block" : "none";
  if (!eligible) {
    const t = document.getElementById("expense-split-toggle");
    if (t) t.checked = false;
    _onSplitToggle();  // collapse the fields + restore the payment block
  }
}

// Daily Expense (transaction) always leaves the cash counter, so it has NO
// payment-method choice — it is cash, period. The "Paid From" selector is
// shown only for a "From Account / Home" (report) expense, where
// cash = home cash and online = from the bank account. A split also hides it
// (the split has its own Cash / UPI inputs).
function _applyPaymentMethodUI() {
  const type = document.getElementById("expense-type")?.value || "transaction";
  const splitOn = _isSplitEnabled();
  const show = (type === "report") && !splitOn;
  const grp = document.getElementById("expense-payment-method-group");
  if (grp) grp.style.display = show ? "block" : "none";
  if (!show && type === "transaction") {
    // Force cash for any counter (daily / split-cash) expense.
    const pmInput = document.getElementById("expense-payment-method");
    if (pmInput) pmInput.value = "cash";
    document.querySelectorAll("#expense-form .payment-btn").forEach((b) => {
      b.classList.toggle("active", b.getAttribute("data-payment") === "cash");
    });
  }
}

// Show/hide the split amount fields and the (now redundant) payment-method
// block based on the toggle state.
function _onSplitToggle() {
  const on = _isSplitEnabled();
  _setDisplay("expense-split-fields", on);
  _applyPaymentMethodUI();
  // Always start from a clean slate; the operator allocates the total across
  // the three source boxes. We do not auto-seed because the split can be any
  // 2-or-3-way combination.
  ["expense-split-counter", "expense-split-home", "expense-split-account"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  if (on) _recalcSplit();
}

// Keep the two legs summing to the total. `source` is whichever field the
// operator just edited; the OTHER leg is derived so the pair always equals
// the total. Negative results are clamped to 0.
// Read the three source boxes and report the running allocation against the
// total. Does NOT auto-balance (a 3-way split has no single "other" field);
// it just guides the operator. Returns {counter, home, account, sum}.
function _splitValues() {
  const counter = parseInt(document.getElementById("expense-split-counter")?.value) || 0;
  const home = parseInt(document.getElementById("expense-split-home")?.value) || 0;
  const account = parseInt(document.getElementById("expense-split-account")?.value) || 0;
  return { counter, home, account, sum: counter + home + account };
}

function _recalcSplit() {
  const total = parseInt(document.getElementById("expense-amount")?.value) || 0;
  const hint = document.getElementById("expense-split-hint");
  if (!hint) return;

  const { counter, home, account, sum } = _splitValues();
  const positive = [counter, home, account].filter((x) => x > 0).length;
  const remaining = total - sum;

  if (total <= 0) {
    hint.textContent = "Enter the total amount first.";
    hint.style.color = "#e53e3e";
  } else if (positive < 2) {
    hint.textContent = "Use at least two sources for a split.";
    hint.style.color = "#e53e3e";
  } else if (remaining !== 0) {
    hint.textContent = `Allocated ₹${sum} of ₹${total} · ${remaining > 0 ? "₹" + remaining + " left" : "₹" + (-remaining) + " over"}`;
    hint.style.color = "#e53e3e";
  } else {
    const parts = [];
    if (counter) parts.push(`₹${counter} counter`);
    if (home) parts.push(`₹${home} home`);
    if (account) parts.push(`₹${account} account`);
    hint.textContent = parts.join(" + ") + ` = ₹${total}`;
    hint.style.color = "#38a169";
  }
}

// ─── Render logs ──────────────────────────────────────────────────────────────
function updateRenderLogs(originalRenderLogs) {
  return function () {
    if (!transactionLog) { debugLog("Transaction log element not found"); return; }

    const today    = new Date();
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    const dayBefore = new Date(today); dayBefore.setDate(dayBefore.getDate() - 2);

    const todayStr     = today.toISOString().split("T")[0];
    const yesterdayStr = yesterday.toISOString().split("T")[0];
    const dayBeforeStr = dayBefore.toISOString().split("T")[0];
    const recentDates  = [todayStr, yesterdayStr, dayBeforeStr];

    const recentCashLogs    = logs.cash.filter((l) => recentDates.includes(l.date));
    const recentOnlineLogs  = logs.online.filter((l) => recentDates.includes(l.date));
    const recentRefundLogs  = (logs.refunds || []).filter((l) => recentDates.includes(l.date));
    const recentExpenseLogs = (logs.expenses || []).filter(
      (l) => recentDates.includes(l.date) && l.expense_type === "transaction"
    );

    const allRecentLogs = [
      ...recentCashLogs, ...recentOnlineLogs, ...recentRefundLogs, ...recentExpenseLogs,
    ].sort((a, b) => new Date(`${b.date} ${b.time || "00:00"}`) - new Date(`${a.date} ${a.time || "00:00"}`));

    if (cashTotal)   cashTotal.textContent   = "₹" + totals.cash;
    if (onlineTotal) onlineTotal.textContent = "₹" + totals.online;
    if (refundTotal) refundTotal.textContent = "₹" + (totals.refunds || 0);

    const expenseElement = document.getElementById("today-expense");
    if (expenseElement) expenseElement.textContent = "₹" + (totals.expenses || 0);

    if (totalRevenue) totalRevenue.textContent = "₹" + (totals.cash + totals.online - (totals.refunds || 0));

    if (allRecentLogs.length === 0) {
      transactionLog.innerHTML =
        '<div class="empty-state" style="padding:2rem;"><i class="fas fa-receipt fa-3x"></i><p>No transactions in the past 3 days</p></div>';
      return;
    }

    const logsByDate = {};
    allRecentLogs.forEach((l) => { (logsByDate[l.date] = logsByDate[l.date] || []).push(l); });

    function formatDate(ds) {
      // DD/MM/YYYY consistently. The recent-expenses panel previously
      // emitted en-US weekday/month-name format ("Wednesday, May 13"),
      // which is ambiguous to Indian operators and inconsistent with
      // the rest of the panel.
      return _fmtDateIN(ds);
    }

    let logsHTML = "";
    Object.keys(logsByDate).sort((a, b) => new Date(b) - new Date(a)).forEach((date) => {
      let label = formatDate(date);
      if (date === todayStr)     label = "Today (" + label + ")";
      else if (date === yesterdayStr) label = "Yesterday (" + label + ")";
      logsHTML += `<div class="log-date-header">${label}</div>`;

      logsByDate[date].forEach((log) => {
        if (recentExpenseLogs.includes(log)) {
          const catDisplay = (log.category || "others").charAt(0).toUpperCase() +
            (log.category || "others").slice(1).replace(/_/g, " ");
          const photoIcon = log.invoice_photo_url
            ? `<a href="${log.invoice_photo_url}" target="_blank" title="View Invoice" style="margin-left:6px;color:var(--primary);"><i class="fas fa-file-image"></i></a>`
            : "";
          const gstBadge = log.has_gst
            ? `<span style="font-size:0.72rem;background:#e8f5e9;color:#2e7d32;border-radius:4px;padding:1px 5px;margin-left:4px;">GST ₹${log.gst_amount || 0}</span>`
            : "";
          // Split badge: this row is the cash (counter) leg of a split.
          // The matching UPI part is recorded as a report expense (it
          // doesn't appear in this daily panel by design).
          const splitBadge = log.split_group_id
            ? `<span style="font-size:0.72rem;background:#fff3e0;color:#b45309;border-radius:4px;padding:1px 5px;margin-left:4px;" title="Part of a split payment — UPI portion is a report expense">SPLIT · ₹${log.split_total || log.amount} total</span>`
            : "";
          logsHTML += `
            <div class="log-item transaction-expense">
              <div class="log-details">
                <div class="log-title">${log.description}<span class="expense-category-badge">${catDisplay}</span>${gstBadge}${splitBadge}${photoIcon}</div>
                <div class="log-subtitle">Expense (${log.payment_method}) at ${log.time || "N/A"}</div>
              </div>
              <div class="log-amount" style="color:var(--danger);">₹${log.amount}</div>
            </div>`;
        } else {
          const isRefund = recentRefundLogs.includes(log);
          const type = recentCashLogs.includes(log) ? "Cash Payment" :
                       recentOnlineLogs.includes(log) ? "Online Payment" : "Refund";
          const color = isRefund ? 'style="color:var(--danger)"' : "";
          const shiftInfo = log.room_shifted
            ? `<span class="room-shifted-badge">Shifted: ${log.old_room}→${log.room}</span>` : "";
          logsHTML += `
            <div class="log-item">
              <div class="log-details">
                <div class="log-title">Room ${log.room} - ${log.name}${shiftInfo}</div>
                <div class="log-subtitle">${type} at ${log.time || "N/A"}</div>
              </div>
              <div class="log-amount" ${color}>₹${log.amount}</div>
            </div>`;
        }
      });
    });

    transactionLog.innerHTML = logsHTML;
  };
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function updateStatsWithExpenses(originalUpdateStats) {
  return function () {
    originalUpdateStats();
    const today = new Date().toISOString().split("T")[0];
    const todayExpLogs = (logs.expenses || []).filter((l) => l.date === today && l.expense_type === "transaction");
    const cashExp   = todayExpLogs.filter((l) => l.payment_method === "cash").reduce((s, l) => s + l.amount, 0);
    const onlineExp = todayExpLogs.filter((l) => l.payment_method !== "cash").reduce((s, l) => s + l.amount, 0);
    const total     = cashExp + onlineExp;

    const expEl = document.getElementById("today-expense");
    if (expEl) expEl.textContent = "₹" + total;

    const cashEl = document.getElementById("today-cash");
    if (cashEl) cashEl.textContent = "₹" + ((parseInt(cashEl.textContent.replace("₹", "")) || 0) - cashExp);

    const onlineEl = document.getElementById("today-online");
    if (onlineEl) onlineEl.textContent = "₹" + ((parseInt(onlineEl.textContent.replace("₹", "")) || 0) - onlineExp);

    const revEl = document.getElementById("today-revenue");
    if (revEl) revEl.textContent = "₹" + ((parseInt(revEl.textContent.replace("₹", "")) || 0) - total);
  };
}

// ─── Report generation ────────────────────────────────────────────────────────
function updateReportGeneration(originalGenerateReport) {
  return async function () {
    const startDate = document.getElementById("start-date")?.value;
    const endDate   = document.getElementById("end-date")?.value;
    const reportContent = document.getElementById("report-content");

    if (!startDate || !endDate) { showNotification("Please select both start and end dates", "error"); return; }
    if (!reportContent) return;
    if (new Date(startDate) > new Date(endDate)) { showNotification("Start date must be before end date", "error"); return; }

    const loadingIndicator = reportContent.querySelector(".loading-indicator");
    const emptyState = reportContent.querySelector(".empty-state");
    if (emptyState) emptyState.classList.add("hidden");
    if (loadingIndicator) loadingIndicator.classList.remove("hidden");

    try {
      const response = await apiFetch("/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_date: startDate, end_date: endDate }),
      });
      if (!response.ok) throw new Error(`Server error: ${response.status}`);
      const data = await response.json();
      if (data.success) {
        _lastReportData = data;                 // store for CSV download
        renderReportDataWithExpenses(data);
        // Show download button once data is loaded
        const dlBtn = document.getElementById("download-report-csv-btn");
        if (dlBtn) dlBtn.style.display = "inline-flex";
      } else {
        showNotification(data.message || "Error generating report", "error");
      }
    } catch (error) {
      console.error("Report error:", error);
      showNotification(`Error: ${error.message}`, "error");
    } finally {
      if (loadingIndicator) loadingIndicator.classList.add("hidden");
    }
  };
}

// ─── Report render ────────────────────────────────────────────────────────────
function renderReportDataWithExpenses(data) {
  const reportContent = document.getElementById("report-content");
  if (!reportContent) return;

  const startDate = new Date(document.getElementById("start-date").value);
  const endDate   = new Date(document.getElementById("end-date").value);
  const fmt = (d) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  const range = fmt(startDate) === fmt(endDate) ? fmt(startDate) : `${fmt(startDate)} to ${fmt(endDate)}`;

  let html = `
    <div class="summary-card">
      <div class="summary-title">Revenue Report (${range})</div>
      <div class="summary-row"><div class="summary-label">Cash Payments</div><div class="summary-value">₹${data.cash_total}</div></div>
      <div class="summary-row"><div class="summary-label">Online Payments</div><div class="summary-value">₹${data.online_total}</div></div>
      <div class="summary-row"><div class="summary-label">Add-ons &amp; Services</div><div class="summary-value">₹${data.addon_total}</div></div>
      <div class="summary-row"><div class="summary-label">Refunds</div><div class="summary-value">₹${data.refund_total}</div></div>
      <div class="summary-row"><div class="summary-label">Daily Expenses</div><div class="summary-value" style="color:var(--danger);">₹${data.transaction_expense_total || 0}</div></div>
      <div class="summary-row"><div class="summary-label">Report Expenses</div><div class="summary-value" style="color:var(--danger);">₹${data.report_expense_total || 0}</div></div>
      <div class="summary-row total-row"><div class="summary-label">Total Net Revenue</div><div class="summary-value">₹${data.total_revenue}</div></div>
    </div>
    <div class="summary-card">
      <div class="summary-title">Expense Summary</div>
      <div class="summary-row"><div class="summary-label">Total Expenses</div><div class="summary-value" style="color:var(--danger);">₹${data.expense_total || 0}</div></div>
      <div class="summary-row"><div class="summary-label">Daily Operations</div><div class="summary-value">₹${data.transaction_expense_total || 0}</div></div>
      <div class="summary-row"><div class="summary-label">Report-Only</div><div class="summary-value">₹${data.report_expense_total || 0}</div></div>
    </div>
    <div class="summary-card">
      <div class="summary-title">Occupancy Statistics</div>
      <div class="summary-row"><div class="summary-label">Total Check-ins</div><div class="summary-value">${data.checkins}</div></div>
      <div class="summary-row"><div class="summary-label">Total Renewals</div><div class="summary-value">${data.renewals || 0}</div></div>
    </div>`;

  // Expenses section
  if (data.expense_logs && data.expense_logs.length > 0) {
    html += `<div class="logs-container" style="margin-top:1.5rem;"><h3 style="margin-bottom:1rem">Expenses</h3><div>`;

    const byCategory = {};
    data.expense_logs.forEach((e) => {
      const cat = e.category || "others";
      byCategory[cat] = byCategory[cat] || { count: 0, total: 0 };
      byCategory[cat].count++;
      byCategory[cat].total += e.amount;
    });
    html += `<div class="expense-categories-summary">`;
    Object.entries(byCategory).forEach(([cat, d]) => {
            html += `<div class="expense-category-item"><div class="expense-category-name">${cat} (${d.count})</div><div class="expense-category-amount">₹${d.total}</div></div>`;
    });
    html += `</div>`;

    data.expense_logs.forEach((log) => {
      const catDisplay = (log.category || "others").charAt(0).toUpperCase() +
        (log.category || "others").slice(1).replace(/_/g, " ");
      const typeClass = log.expense_type === "transaction" ? "transaction-expense" : "report-expense";
      const typeLabel = log.expense_type === "transaction" ? "Daily" : "Report";

      const gstDetail = log.has_gst
        ? `<div style="font-size:0.78rem;color:var(--text-muted);">Vendor: ${log.vendor_name || "-"} | Taxable: ₹${log.taxable_amount || 0} | GST ${log.gst_rate || 0}%: ₹${log.gst_amount || 0}${log.vendor_gstin ? " | GSTIN: " + log.vendor_gstin : ""}</div>`
        : "";
      const invoiceDetail = log.has_bill && log.invoice_number
        ? `<div style="font-size:0.78rem;color:var(--text-muted);">Invoice: ${log.invoice_number}${log.invoice_date ? " | Date: " + _fmtDateIN(log.invoice_date) : ""}</div>`
        : "";
      const photoLink = log.invoice_photo_url
        ? `<a href="${log.invoice_photo_url}" target="_blank" style="font-size:0.78rem;color:var(--primary);margin-left:6px;"><i class="fas fa-file-image"></i> View Invoice</a>`
        : "";
      const paidToLine = log.paid_to
        ? `<div style="font-size:0.78rem;color:var(--text-muted);">Paid to: ${log.paid_to}</div>`
        : "";

      let commDetail = "";
      if (log.category === "booking_commission") {
        const payStatus  = log.commission_payment_status || "pending";
        const statusColor = payStatus === "paid" ? "var(--success,#28a745)" : "var(--warning,#ffc107)";
        commDetail = `<div style="font-size:0.78rem;color:var(--text-muted);margin-top:4px;">
          Platform: ${log.commission_platform || "-"} | Commission: ₹${log.commission_amount || 0} | GST: ₹${log.commission_gst || 0} |
          Invoice: ${log.commission_invoice_number || "-"} |
          <strong style="color:${statusColor}">${payStatus.charAt(0).toUpperCase() + payStatus.slice(1)}</strong>
        </div>`;
      }

      html += `
        <div class="log-item ${typeClass}">
          <div class="log-details">
            <div class="log-title">
              ${log.description}
              <span class="expense-category-badge">${catDisplay}</span>
              <span class="expense-type-badge ${log.payment_method}">${log.payment_method}</span>
              <span class="expense-indicator ${log.expense_type}">${typeLabel}</span>
              ${photoLink}
            </div>
            <div class="log-subtitle">Expense on ${_fmtDateIN(log.date)} at ${log.time || "N/A"}</div>
            ${paidToLine}${invoiceDetail}${gstDetail}${commDetail}
          </div>
          <div class="log-amount" style="color:var(--danger);">₹${log.amount}</div>
        </div>`;
    });

    html += `</div></div>`;
  } else {
    html += `<div class="logs-container" style="margin-top:1.5rem;">
      <h3 style="margin-bottom:1rem">Expenses</h3>
      <div class="empty-state expenses" style="padding:1.5rem;">
        <i class="fas fa-file-invoice-dollar fa-3x"></i><p>No expenses in this period</p>
      </div></div>`;
  }

  // Cash payments
  html += `<div class="logs-container" style="margin-top:1.5rem;"><h3 style="margin-bottom:1rem">Cash Payments</h3><div>`;
  if (!data.cash_logs || data.cash_logs.length === 0) {
    html += '<div class="log-item">No cash payments in this period</div>';
  } else {
    data.cash_logs.forEach((log) => {
      html += `<div class="log-item"><div class="log-details">
        <div class="log-title">Room ${log.room} - ${log.name} ${log.item ? `(${log.item})` : ""}</div>
        <div class="log-subtitle">Cash on ${_fmtDateIN(log.date)} at ${log.time || "N/A"}</div>
      </div><div class="log-amount">₹${log.amount}</div></div>`;
    });
  }
  html += `</div></div>`;

  // Online payments
  html += `<div class="logs-container" style="margin-top:1.5rem;"><h3 style="margin-bottom:1rem">Online Payments</h3><div>`;
  if (!data.online_logs || data.online_logs.length === 0) {
    html += '<div class="log-item">No online payments in this period</div>';
  } else {
    data.online_logs.forEach((log) => {
      html += `<div class="log-item"><div class="log-details">
        <div class="log-title">Room ${log.room} - ${log.name} ${log.item ? `(${log.item})` : ""}</div>
        <div class="log-subtitle">Online on ${_fmtDateIN(log.date)} at ${log.time || "N/A"}</div>
      </div><div class="log-amount">₹${log.amount}</div></div>`;
    });
  }
  html += `</div></div>`;

  reportContent.innerHTML = html;
}

// ─── Report CSV download ──────────────────────────────────────────────────────
let _lastReportData = null;   // store last fetched report for download

function _escCsv(val) {
  if (val === null || val === undefined) return "";
  const s = String(val);
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadReportCsv() {
  if (!_lastReportData) { showNotification("Generate a report first", "error"); return; }
  const d = _lastReportData;

  const rows = [];

  // ── Expenses ──────────────────────────────────────────────────────────────
  rows.push(["--- EXPENSES ---"]);
  rows.push([
    "Date","Time","Type","Category","Description","Paid To",
    "Amount","Payment Method","Split Source","Split Total",
    "Invoice No","Invoice Date","Has GST","Vendor","GSTIN",
    "Taxable Amount","GST Rate %","GST Amount",
    "Invoice Photo URL",
    "Commission Platform","Commission Amount","Commission GST",
    "Comm Invoice No","Comm Invoice Date","Comm Payment Status",
  ]);
  (d.expense_logs || []).forEach((e) => {
    rows.push([
      e.date, e.time || "",
      e.expense_type === "transaction" ? "Daily" : "From Account",
      e.category || "",
      e.description || "",
      e.paid_to || "",
      e.amount || 0,
      e.payment_method || "",
      ({counter_cash:"Counter cash",home_cash:"Home cash",account:"Account"})[e.split_role] || (e.split_role || ""),
      e.split_total || "",
      e.invoice_number || "",
      e.invoice_date || "",
      e.has_gst ? "Yes" : "No",
      e.vendor_name || "",
      e.vendor_gstin || "",
      e.taxable_amount || "",
      e.gst_rate || "",
      e.gst_amount || "",
      e.invoice_photo_url || "",
      e.commission_platform || "",
      e.commission_amount || "",
      e.commission_gst || "",
      e.commission_invoice_number || "",
      e.commission_invoice_date || "",
      e.commission_payment_status || "",
    ]);
  });

  rows.push([]);

  // ── Cash payments ─────────────────────────────────────────────────────────
  rows.push(["--- CASH PAYMENTS ---"]);
  rows.push(["Date","Time","Room","Guest","Amount"]);
  (d.cash_logs || []).forEach((p) => {
    rows.push([p.date, p.time||"", p.room||"", p.name||"", p.amount||0]);
  });

  rows.push([]);

  // ── Online payments ───────────────────────────────────────────────────────
  rows.push(["--- ONLINE PAYMENTS ---"]);
  rows.push(["Date","Time","Room","Guest","Amount"]);
  (d.online_logs || []).forEach((p) => {
    rows.push([p.date, p.time||"", p.room||"", p.name||"", p.amount||0]);
  });

  rows.push([]);

  // ── Summary ───────────────────────────────────────────────────────────────
  rows.push(["--- SUMMARY ---"]);
  rows.push(["Item","Amount"]);
  rows.push(["Cash Total",       d.cash_total    || 0]);
  rows.push(["Online Total",     d.online_total  || 0]);
  rows.push(["Add-on Total",     d.addon_total   || 0]);
  rows.push(["Refund Total",     d.refund_total  || 0]);
  rows.push(["Daily Expenses",   d.transaction_expense_total || 0]);
  rows.push(["Account Expenses", d.report_expense_total      || 0]);
  rows.push(["Net Revenue",      d.total_revenue || 0]);

  const csv = rows.map((r) => r.map(_escCsv).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });

  const startEl = document.getElementById("start-date");
  const endEl   = document.getElementById("end-date");
  const fname   = `expense_report_${startEl?.value || ""}__${endEl?.value || ""}.csv`;

  const url = URL.createObjectURL(blob);
  const a   = document.createElement("a");
  a.href = url; a.download = fname; a.click();
  URL.revokeObjectURL(url);
}

// ─── Boot ────────────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", function () {
  if (typeof renderLogs     === "function") window.renderLogs     = updateRenderLogs(renderLogs);
  if (typeof updateStats    === "function") window.updateStats    = updateStatsWithExpenses(updateStats);
  if (typeof generateReport === "function") window.generateReport = updateReportGeneration(generateReport);
  initializeExpense();

  // Wire CSV download button
  const dlBtn = document.getElementById("download-report-csv-btn");
  if (dlBtn) dlBtn.addEventListener("click", downloadReportCsv);
});
