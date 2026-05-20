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

// ─── Category change ──────────────────────────────────────────────────────────
function _onCategoryChange() {
  const category = document.getElementById("expense-category")?.value || "";
  const tier = CATEGORY_TIER[category] || "tier2";

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
}

function _onHasBillChange() {
  const checked = document.getElementById("expense-has-bill")?.checked;
  _setDisplay("bill-fields", !!checked);
  if (!checked) {
    _setDisplay("gst-fields", false);
    const hasGstChk = document.getElementById("expense-has-gst");
    if (hasGstChk) hasGstChk.checked = false;
  }
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
}

// ─── GST auto-calc ────────────────────────────────────────────────────────────
function _recalcGst() {
  const taxable = parseFloat(document.getElementById("expense-taxable-amount")?.value) || 0;
  const rate    = parseFloat(document.getElementById("expense-gst-rate")?.value) || 0;
  const gst     = Math.round((taxable * rate) / 100);
  const gstInput = document.getElementById("expense-gst-amount");
  if (gstInput) gstInput.value = gst;
  // Also fill total
  const totalInput = document.getElementById("expense-amount");
  if (totalInput && !totalInput.readOnly) totalInput.value = taxable + gst;
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

// ─── Show modal ───────────────────────────────────────────────────────────────
function showExpenseModal(type, options) {
  const modal = document.getElementById("expense-modal");
  if (!modal) return;

  document.getElementById("expense-form")?.reset();

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

    console.log("Submitting expense:", payload);

    const response = await apiFetch("/add_expense", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) throw new Error(`Server error: ${response.status}`);
    const result = await response.json();

    if (result.success) {
      document.getElementById("expense-modal")?.classList.remove("show");
      debouncedFetchData();

      if (type === "report" &&
          document.getElementById("reports-tab") &&
          !document.getElementById("reports-tab").classList.contains("hidden")) {
        generateReport();
      }

      showNotification(result.message || "Expense added", "success");
    } else {
      showNotification(result.message || "Error adding expense", "error");
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
          logsHTML += `
            <div class="log-item transaction-expense">
              <div class="log-details">
                <div class="log-title">${log.description}<span class="expense-category-badge">${catDisplay}</span>${gstBadge}${photoIcon}</div>
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
    "Amount","Payment Method",
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
