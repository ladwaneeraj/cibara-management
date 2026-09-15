// Global variables
let pendingSettlements = [];
let currentSettlementFilter = "pending";
let activeSettlementId = null;
let settlementPaymentMethod = "cash";

// Initialize the settle later functionality
function initSettleLater() {
  // 1. Initialize event listeners for settle later checkbox in checkout confirmation
  const settleLaterCheckbox = document.getElementById("settle-later-checkbox");
  const settlementNotesContainer = document.getElementById(
    "settlement-notes-container"
  );

  if (settleLaterCheckbox && settlementNotesContainer) {
    settleLaterCheckbox.addEventListener("change", function () {
      settlementNotesContainer.style.display = this.checked ? "block" : "none";
      // Clear password and error when settle-later is toggled off
      if (!this.checked) {
        const pwInput   = document.getElementById('checkout-manager-password');
        const pwErrorEl = document.getElementById('checkout-password-error');
        if (pwInput)   pwInput.value = '';
        if (pwErrorEl) pwErrorEl.style.display = 'none';
      } else {
        // Focus password field when settle-later is enabled
        setTimeout(() => {
          const pwInput = document.getElementById('checkout-manager-password');
          if (pwInput) pwInput.focus();
        }, 100);
      }
    });
  }

  // 2. proceed-checkout-btn click handler — INTENTIONALLY NOT BOUND HERE.
  //
  // The canonical checkout handler lives in settle-later-fix.js, which clones
  // #proceed-checkout-btn (stripping any prior listeners) and attaches a single
  // enhanced handler (RBAC, balance validation, settle-later, customer flag).
  //
  // This file used to ALSO assign `.onclick` on the same button ~1s after the
  // fix had already cloned it. The result was TWO live handlers on one button,
  // so a single click fired TWO `POST /checkout` requests. Each request mints
  // its own sequential bill number (config.generate_sequential_bill_number
  // increments the bill_YYYY_MM counter atomically), so the CC/ series advanced
  // by 2 per checkout — leaving permanent gaps (e.g. 162, 164, 166...) that were
  // never stored in Firestore. See routes/rooms.py checkout() for the matching
  // server-side idempotency guard. DO NOT re-add a checkout handler here.

  // 3. Initialize the quick actions button for pending settlements
  const quickSettlementsBtn = document.getElementById("quick-settlements-btn");
  if (quickSettlementsBtn) {
    quickSettlementsBtn.addEventListener("click", function () {
      showPendingSettlementsModal();

      // Close quick actions menu
      const quickActionMenu = document.querySelector(".quick-action-menu");
      if (quickActionMenu) {
        quickActionMenu.classList.remove("show");
      }
    });
  }

  // 4. Initialize filter buttons in pending settlements modal
  const settlementFilterBtns = document.querySelectorAll(
    "#pending-settlements-modal .filter-btn"
  );
  if (settlementFilterBtns.length > 0) {
    settlementFilterBtns.forEach((btn) => {
      btn.addEventListener("click", function () {
        // Update active filter
        settlementFilterBtns.forEach((b) => b.classList.remove("active"));
        this.classList.add("active");

        // Update filter and refresh display
        currentSettlementFilter = this.dataset.filter;
        renderPendingSettlements();
      });
    });
  }

  // 5. Initialize payment method buttons in collect settlement modal
  const settlementPaymentBtns = document.querySelectorAll(
    "#collect-settlement-modal .payment-btn"
  );
  if (settlementPaymentBtns.length > 0) {
    settlementPaymentBtns.forEach((btn) => {
      btn.addEventListener("click", function () {
        // Update active payment method
        settlementPaymentBtns.forEach((b) => b.classList.remove("active"));
        this.classList.add("active");

        // Update payment method
        settlementPaymentMethod = this.dataset.payment;
        document.getElementById("settlement-payment-method").value =
          settlementPaymentMethod;
      });
    });
  }

  // 6/7. The collect-settlement modal's own buttons.
  _wireCollectModalButtons();

  // 8. Initialize close buttons for all settlement modals
  document
    .querySelectorAll(
      "#pending-settlements-modal .close-btn, #collect-settlement-modal .close-btn"
    )
    .forEach((btn) => {
      btn.addEventListener("click", function () {
        const modal = this.closest(".modal-backdrop");
        if (modal) {
          modal.classList.remove("show");
        }
      });
    });

  // 9. Initialize discount features
  initDiscountFeatures();

  console.log("Settle Later feature initialized");
}

// Section 34(2) acknowledgement, carried across the one retry the backend
// asks for. Reset on success and whenever the modal is opened, so an
// acknowledgement given for one settlement can never apply to the next.
let _settleAckS34 = false;

// "credit_note" (a real price reduction, GST comes down) or "financial" (a
// write-off, invoice and GST unchanged). Defaults to credit_note because that
// is what a discount at settlement almost always is; the alternative is one
// click away and spelled out in the modal.
function _settleDiscountType() {
  const el = document.querySelector(
    'input[name="settlement-disc-type"]:checked'
  );
  return el && el.value === "financial" ? "financial" : "credit_note";
}

// Initialize discount features
let _discountFeaturesWired = false;

function initDiscountFeatures() {
  if (_discountFeaturesWired) return;
  const discountAmountInput = document.getElementById(
    "settlement-discount-amount"
  );
  const discountReasonContainer = document.getElementById(
    "settlement-discount-reason-container"
  );
  const discountReasonSelect = document.getElementById(
    "settlement-discount-reason"
  );
  const otherReasonContainer = document.getElementById(
    "settlement-other-reason-container"
  );

  // ── Live breakdown + discount-type reveal ────────────────────────────────
  // Every input that can move a number re-renders the breakdown, so what the
  // operator is about to record is on screen before they press Collect.
  const _typeContainer = document.getElementById(
    "settlement-discount-type-container"
  );
  const _paymentInput = document.getElementById("settlement-payment-amount");
  [discountAmountInput, _paymentInput].forEach(function (el) {
    if (el) el.addEventListener("input", _settleSyncBreakdown);
  });
  document
    .querySelectorAll('input[name="settlement-disc-type"]')
    .forEach(function (r) {
      r.addEventListener("change", _settleSyncBreakdown);
    });
  if (discountAmountInput && _typeContainer) {
    discountAmountInput.addEventListener("input", function () {
      // The GST treatment only matters once there IS a discount.
      _typeContainer.style.display =
        parseInt(this.value, 10) > 0 ? "block" : "none";
    });
  }

  if (discountAmountInput && discountReasonContainer) {
    discountAmountInput.addEventListener("input", function () {
      if (parseInt(this.value) > 0) {
        discountReasonContainer.style.display = "block";
      } else {
        discountReasonContainer.style.display = "none";
      }
    });
  }

  if (discountReasonSelect && otherReasonContainer) {
    discountReasonSelect.addEventListener("change", function () {
      if (this.value === "Other") {
        otherReasonContainer.style.display = "block";
      } else {
        otherReasonContainer.style.display = "none";
      }
    });
  }
  // Only latch once the fields were actually there to bind.
  if (discountAmountInput) _discountFeaturesWired = true;
}

// Modify setupCheckoutConfirmation function to handle balance display in the confirmation
function enhanceCheckoutConfirmation() {
  // Override the original function if it exists
  if (typeof setupCheckoutConfirmation === "function") {
    console.log("Enhancing checkout confirmation function");

    const originalSetupCheckoutConfirmation = setupCheckoutConfirmation;

    window.setupCheckoutConfirmation = function () {
      // Call the original function first
      originalSetupCheckoutConfirmation();

      // Add our enhancements to show balance in confirmation modal
      const confirmCheckoutBtn = document.getElementById(
        "confirm-checkout-btn"
      );

      if (confirmCheckoutBtn) {
        // Override the click event handler
        confirmCheckoutBtn.addEventListener(
          "click",
          function (event) {
            // Prevent default action if any
            event.preventDefault();

            // Stop other event handlers
            event.stopImmediatePropagation();

            const roomNumberElement = document.getElementById(
              "checkout-room-number"
            );
            const guestNameElement = document.getElementById(
              "checkout-guest-name"
            );

            if (!roomNumberElement) {
              showNotification("Room number element not found", "error");
              console.error("Room number element not found");
              return;
            }

            const roomNumber = roomNumberElement.textContent;
            const guestName = guestNameElement
              ? guestNameElement.textContent
              : "Unknown";
            const balance = rooms[roomNumber].balance;

            // Set the room and guest name in the confirmation modal
            const confirmRoomElement = document.getElementById(
              "confirm-checkout-room"
            );
            const confirmGuestElement = document.getElementById(
              "confirm-checkout-guest"
            );
            const confirmBalanceElement = document.getElementById(
              "confirm-checkout-balance"
            );
            const balanceContainer = document.getElementById(
              "checkout-balance-container"
            );

            if (confirmRoomElement) confirmRoomElement.textContent = roomNumber;
            if (confirmGuestElement)
              confirmGuestElement.textContent = guestName;

            // Show balance information if there's a positive balance
            if (balanceContainer && confirmBalanceElement) {
              if (balance > 0) {
                confirmBalanceElement.textContent = balance;
                balanceContainer.style.display = "block";

                // Reset the settle later checkbox
                const settleLaterCheckbox = document.getElementById(
                  "settle-later-checkbox"
                );
                if (settleLaterCheckbox) {
                  settleLaterCheckbox.checked = false;
                }

                // Hide the notes container
                const settlementNotesContainer = document.getElementById(
                  "settlement-notes-container"
                );
                if (settlementNotesContainer) {
                  settlementNotesContainer.style.display = "none";
                }

                // Clear the notes field
                const settlementNotes =
                  document.getElementById("settlement-notes");
                if (settlementNotes) {
                  settlementNotes.value = "";
                }
              } else {
                balanceContainer.style.display = "none";
              }
            }

            // Show the confirmation modal
            const checkoutConfirmModal = document.getElementById(
              "checkout-confirm-modal"
            );
            if (checkoutConfirmModal) {
              checkoutConfirmModal.classList.add("show");
              console.log("Confirmation modal displayed");
            } else {
              console.error("Confirmation modal element not found");
              showNotification("Error: Confirmation modal not found", "error");
            }
          },
          true
        ); // Use capture to override other handlers
      }
    };
  }
}

// Fetch pending settlements from the server
async function fetchPendingSettlements() {
  try {
    const response = await apiFetch("/get_pending_settlements");
    if (!response.ok) {
      throw new Error(`Server responded with status: ${response.status}`);
    }

    const result = await response.json();
    if (result.success) {
      pendingSettlements = result.settlements || [];
      // Loaded INTO `pendingSettlements`; the return value is only "did it
      // work". Callers must read the module list, never the resolved value.
      return true;
    } else {
      console.error("Failed to fetch pending settlements:", result.message);
      return false;
    }
  } catch (error) {
    console.error("Error fetching pending settlements:", error);
    showNotification(
      `Error fetching pending settlements: ${error.message}`,
      "error"
    );
    return false;
  }
}

// The collect-settlement modal's buttons, wired exactly once.
//
// initSettleLater() runs a second after DOMContentLoaded, but the modal can
// be opened before that (the check-in modal's pending-balance banner opens it
// as soon as a returning guest's mobile is typed). An unwired Collect Payment
// button is the worst kind of bug here: the operator takes the cash and the
// screen does nothing. showCollectSettlementModal() calls this too, so the
// modal is never shown with dead buttons.
let _collectModalWired = false;

function _wireCollectModalButtons() {
  if (_collectModalWired) return;
  const collectBtn = document.getElementById("collect-payment-btn");
  const cancelBtn = document.getElementById("cancel-settlement-btn");
  if (!collectBtn) return;              // markup not in the DOM yet
  collectBtn.addEventListener("click", collectSettlementPayment);
  if (cancelBtn) {
    cancelBtn.addEventListener("click", showCancelSettlementConfirmation);
  }
  // The amount and discount fields drive the breakdown and the button
  // label, and they are part of "this modal works", so they are readied
  // here too rather than only on the deferred init.
  initDiscountFeatures();
  // "Full amount" puts the whole balance back in the field after a part
  // amount was typed — the common correction, one tap instead of retyping.
  const fullBtn = document.getElementById("settlement-full-amount");
  if (fullBtn) {
    fullBtn.addEventListener("click", function () {
      const settlement = pendingSettlements.find((s) => s.id === activeSettlementId);
      const input = document.getElementById("settlement-payment-amount");
      if (!settlement || !input) return;
      const discount = parseInt(
        (document.getElementById("settlement-discount-amount") || {}).value || "0", 10) || 0;
      input.value = Math.max(0, (parseInt(settlement.amount, 10) || 0) - discount);
      _settleSyncBreakdown();
    });
  }
  _collectModalWired = true;
}

/**
 * Wire the search box and the sort control, and put them into the state the
 * list is about to render in.
 *
 * Its own function because the alternative — wiring inline where the modal
 * opens — makes the controls untestable without driving the whole open path,
 * and a control that is only bound on one code path is a control that stops
 * working the day somebody opens the screen another way.
 *
 * Listeners are attached once: the modal element outlives every open, so
 * binding on each open would stack them up and fire the render N times.
 */
function psxBindControls() {
  const searchEl = document.getElementById("psx-search-input");
  if (searchEl && !searchEl.dataset.psxBound) {
    searchEl.dataset.psxBound = "1";
    let timer = null;
    searchEl.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(renderPendingSettlements, 120);
    });
  }
  // The search term is per visit; the sort choice is not.
  if (searchEl) searchEl.value = "";

  const sortEl = document.getElementById("psx-sort-select");
  if (sortEl && !sortEl.dataset.psxBound) {
    sortEl.dataset.psxBound = "1";
    sortEl.addEventListener("change", function () {
      currentSettlementSort = this.value;
      renderPendingSettlements();
    });
  }
  // Reflect the remembered choice rather than resetting it: an operator who
  // switched to Oldest first to work through the backlog should not have to
  // choose again every time they reopen the screen.
  if (sortEl) sortEl.value = currentSettlementSort;
}

// Show the pending settlements modal
async function showPendingSettlementsModal() {
  const modal = document.getElementById("pending-settlements-modal");
  if (!modal) {
    console.error("Pending settlements modal not found");
    return;
  }

  // Show the modal
  modal.classList.add("show");

  // Set default filter to pending
  currentSettlementFilter = "pending";

  // Set active filter button
  document
    .querySelectorAll("#pending-settlements-modal .filter-btn")
    .forEach((btn) => {
      btn.classList.remove("active");
      if (btn.dataset.filter === currentSettlementFilter) {
        btn.classList.add("active");
      }
    });

  // Show loading indicator
  const settlementsList = document.getElementById("settlements-list");
  if (settlementsList) {
    settlementsList.innerHTML = `
      <div class="loading-indicator">
        <span class="loader"></span>
        <p>Loading pending settlements...</p>
      </div>
    `;
  }

  psxBindControls();

  // Fetch and render settlements
  await fetchPendingSettlements();
  renderPendingSettlements();
}

// Show the collect settlement modal
function showCollectSettlementModal(settlementId, _afterFetch) {
  // The list is already loaded when this is opened from the Pending Payments
  // screen. Opened from anywhere else (the Bills tab, the check-in modal's
  // pending-balance banner) it has to be fetched first.
  //
  // fetchPendingSettlements() resolves to a BOOLEAN and loads the rows into
  // `pendingSettlements`. This used to do `pendingSettlements = list || []`
  // with that boolean, so the freshly loaded list was replaced by `true` and
  // the next line threw "pendingSettlements.find is not a function" inside a
  // promise — the modal simply never opened and nothing said why. Read the
  // module list after awaiting, and retry exactly once.
  const list = Array.isArray(pendingSettlements) ? pendingSettlements : [];
  let settlement = list.find((s) => s.id === settlementId);
  if (!settlement) {
    if (_afterFetch) {
      showNotification(
        "That balance is no longer pending — it may have just been collected. " +
        "Reopen the guest to check.",
        "error"
      );
      return;
    }
    fetchPendingSettlements()
      .then(function () { showCollectSettlementModal(settlementId, true); })
      .catch(function (err) {
        console.error("[settle-later] could not load settlements:", err);
        showNotification("Could not load the pending balance. Try again.", "error");
      });
    return;
  }

  // Set the active settlement ID
  activeSettlementId = settlementId;

  // Never show this modal with dead buttons (see _wireCollectModalButtons).
  _wireCollectModalButtons();

  // Get modal elements
  const modal = document.getElementById("collect-settlement-modal");
  const guestNameEl = document.getElementById("settlement-guest-name");
  const mobileEl = document.getElementById("settlement-mobile-number");
  const mobileLinkEl = document.getElementById("settlement-guest-mobile");
  const checkoutDateEl = document.getElementById("settlement-checkout-date");
  const roomEl = document.getElementById("settlement-room");
  const amountEl = document.getElementById("settlement-amount");
  const notesEl = document.getElementById("settlement-notes");
  const photoContainerEl = document.getElementById(
    "settlement-photo-container"
  );
  const photoEl = document.getElementById("settlement-guest-photo");

  // Get payment and discount inputs
  const paymentAmountInput = document.getElementById(
    "settlement-payment-amount"
  );
  const discountAmountInput = document.getElementById(
    "settlement-discount-amount"
  );
  const discountReasonContainer = document.getElementById(
    "settlement-discount-reason-container"
  );

  // Update modal content
  if (guestNameEl) guestNameEl.textContent = settlement.guest_name;
  if (mobileEl) mobileEl.textContent = settlement.guest_mobile;
  if (mobileLinkEl) mobileLinkEl.href = `tel:${settlement.guest_mobile}`;
  // "25 Jul 2026" reads at a glance; "2026-07-25" has to be decoded.
  if (checkoutDateEl) {
    const _co = String(settlement.checkout_date || "");
    let _coTxt = _co;
    try {
      const _d = new Date(_co + "T12:00:00");
      if (!isNaN(_d.getTime())) {
        _coTxt = _d.toLocaleDateString("en-IN",
          { day: "2-digit", month: "short", year: "numeric" });
      }
    } catch (_e) { /* keep the raw string */ }
    checkoutDateEl.textContent = _coTxt;
  }
  if (roomEl) roomEl.textContent = settlement.room;
  if (amountEl) amountEl.textContent = `₹${settlement.amount}`;
  // An empty note is nothing to say, so the row goes rather than showing "-".
  const noteWrap = document.getElementById("settlement-note-wrap");
  const noteTxt = (settlement.notes || "").trim();
  if (notesEl) notesEl.textContent = noteTxt;
  if (noteWrap) noteWrap.style.display = noteTxt ? "" : "none";

  // Reset payment and discount inputs
  if (paymentAmountInput) {
    paymentAmountInput.value = settlement.amount;
    paymentAmountInput.max = settlement.amount;
  }

  const _slDate = document.getElementById("settlement-payment-date");
  if (_slDate) {
    const _t = new Date();
    const _iso = _t.getFullYear() + "-" + String(_t.getMonth() + 1).padStart(2, "0") + "-" + String(_t.getDate()).padStart(2, "0");
    _slDate.value = _iso; _slDate.max = _iso;
    const _co = (settlement.checkout_date || "").slice(0, 10);
    if (_co) _slDate.min = _co;
  }

  if (discountAmountInput) {
    discountAmountInput.value = "0";
    discountAmountInput.max = settlement.amount;
  }

  // Reset the per-settlement state every time the modal opens. Without this
  // a Section 34 acknowledgement, or a "write-off" choice, would carry over
  // to the next guest's settlement.
  _settleAckS34 = false;
  const _dtDefault = document.querySelector(
    'input[name="settlement-disc-type"][value="credit_note"]'
  );
  if (_dtDefault) _dtDefault.checked = true;
  const _dtBox = document.getElementById("settlement-discount-type-container");
  if (_dtBox) _dtBox.style.display = "none";
  setTimeout(_settleSyncBreakdown, 0);

  if (discountReasonContainer) {
    discountReasonContainer.style.display = "none";
  }

  // Display guest photo if available
  if (photoContainerEl && photoEl) {
    if (settlement.photo) {
      photoEl.src = settlement.photo;
      photoContainerEl.style.display = "block";
    } else {
      photoContainerEl.style.display = "none";
    }
  }

  // Reset payment method to cash
  settlementPaymentMethod = "cash";
  document
    .querySelectorAll("#collect-settlement-modal .payment-btn")
    .forEach((btn) => {
      btn.classList.remove("active");
      if (btn.dataset.payment === "cash") {
        btn.classList.add("active");
      }
    });

  if (document.getElementById("settlement-payment-method")) {
    document.getElementById("settlement-payment-method").value = "cash";
  }

  // Show the modal
  if (modal) {
    modal.classList.add("show");
  }
}

// Process settlement payment collection
async function collectSettlementPayment() {
  if (!activeSettlementId) {
    showNotification("No active settlement selected", "error");
    return;
  }

  // Find the settlement
  const settlement = pendingSettlements.find(
    (s) => s.id === activeSettlementId
  );
  if (!settlement) {
    showNotification("Settlement not found", "error");
    return;
  }

  // Get payment amount
  const paymentAmountInput = document.getElementById(
    "settlement-payment-amount"
  );
  let paymentAmount = 0;
  if (paymentAmountInput && paymentAmountInput.value) {
    paymentAmount = parseInt(paymentAmountInput.value);
  }

  // Get discount amount and reason
  const discountAmountInput = document.getElementById(
    "settlement-discount-amount"
  );
  const discountReasonSelect = document.getElementById(
    "settlement-discount-reason"
  );
  const otherReasonInput = document.getElementById(
    "settlement-other-discount-reason"
  );

  let discountAmount = 0;
  let discountReason = "";

  if (discountAmountInput && parseInt(discountAmountInput.value) > 0) {
    discountAmount = parseInt(discountAmountInput.value);

    if (discountReasonSelect) {
      if (
        discountReasonSelect.value === "Other" &&
        otherReasonInput &&
        otherReasonInput.value
      ) {
        discountReason = otherReasonInput.value;
      } else {
        discountReason = discountReasonSelect.value;
      }
    }
  }

  // Validation
  if (discountAmount > settlement.amount) {
    showNotification(
      `Discount amount (₹${discountAmount}) exceeds settlement amount (₹${settlement.amount})`,
      "error"
    );
    return;
  }

  const effectiveAmount = settlement.amount - discountAmount;

  if (paymentAmount > effectiveAmount) {
    showNotification(
      `Payment amount (₹${paymentAmount}) exceeds settlement amount after discount (₹${effectiveAmount})`,
      "error"
    );
    return;
  }

  // Get the button and disable it
  const collectBtn = document.getElementById("collect-payment-btn");
  if (!collectBtn) {
    showNotification("Collect payment button not found", "error");
    return;
  }

  // Show loading state
  collectBtn.disabled = true;
  collectBtn.innerHTML =
    '<span class="loader" style="width: 20px; height: 20px;"></span> Processing...';

  try {
    // Call API to collect payment
    const response = await apiFetch("/collect_settlement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        settlement_id: activeSettlementId,
        payment_mode: settlementPaymentMethod,
        payment_amount: paymentAmount,
        payment_date: (document.getElementById("settlement-payment-date") && document.getElementById("settlement-payment-date").value) || "",
        discount_amount: discountAmount,
        discount_reason: discountReason,
        // Previously never sent, so the backend fell through to "financial"
        // and every settlement discount became a goodwill write-off with no
        // GST relief and no credit note. The modal now asks.
        discount_type: _settleDiscountType(),
        // Set only after the operator confirms the Section 34(2) warning
        // below; the first attempt always goes without it.
        acknowledge_section34_window: !!_settleAckS34,
      }),
    });

    const result = await response.json().catch(() => ({}));

    // 409 + section34_warning: the invoice is past the 30 November cutoff for
    // credit notes. The server refuses once, tells us the deadline, and
    // accepts a retry that carries the acknowledgement. Anything else with a
    // non-OK status is a real failure.
    if (response.status === 409 && result && result.section34_warning) {
      const proceed = confirm(
        (result.message || "This bill is past the Section 34 credit-note deadline.") +
          "\n\nIssue the credit note anyway? Your CA may need to explain it."
      );
      if (proceed) {
        _settleAckS34 = true;
        collectBtn.disabled = false;
        _syncCollectButtonLabel();
        return collectSettlementPayment();
      }
      showNotification("Settlement not collected.", "error");
      return;
    }

    if (!response.ok) {
      throw new Error(
        (result && result.message) ||
          `Server responded with status: ${response.status}`
      );
    }

    if (result.success) {
      _settleAckS34 = false;
      // Refresh settlements data
      await fetchPendingSettlements();

      // Close the collect modal
      const modal = document.getElementById("collect-settlement-modal");
      if (modal) {
        modal.classList.remove("show");
      }

      // Refresh the settlements display
      renderPendingSettlements();

      // Confirm what was actually recorded, not just "success". If a credit
      // note was issued the operator needs its number: it is the document
      // that makes the invoice and the cash agree.
      const cn = result.credit_note || {};
      const cnNo = cn.cn_number || result.credit_note_number || "";
      showNotification(
        cnNo
          ? `Payment collected. Credit note ${cnNo} issued for the discount.`
          : result.message || "Payment collected successfully",
        "success"
      );

      // Tell the rest of the app. The check-in modal's pending-balance
      // banner listens for this and corrects itself in place; anything else
      // showing this balance can do the same without polling. The server
      // response is passed through as-is, so listeners read the settled
      // state rather than guessing it.
      try {
        window.dispatchEvent(new CustomEvent("cibaraSettlementCollected", {
          detail: {
            settlement_id: activeSettlementId,
            guest_mobile: settlement.guest_mobile || result.guest_mobile || "",
            fully_paid: !!result.fully_paid,
            remaining: Number(result.remaining || 0),
            payment_amount: Number(result.payment_amount || paymentAmount || 0),
            discount_amount: Number(result.discount_amount || discountAmount || 0),
            bill_id: result.bill_id || null,
            bill_status: result.bill_status || null,
          },
        }));
      } catch (_e) { /* a listener that throws must not undo the collection */ }
    } else {
      showNotification(result.message || "Failed to collect payment", "error");
    }
  } catch (error) {
    console.error("Error collecting payment:", error);
    showNotification(`Error collecting payment: ${error.message}`, "error");
  } finally {
    // Restore button state
    collectBtn.disabled = false;
    _syncCollectButtonLabel();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Live breakdown for the collect-settlement modal
// ─────────────────────────────────────────────────────────────────────────────
// Four numbers have to agree before money changes hands: what was owed, what
// is being knocked off, what is being taken now, and what is left. Previously
// none of them were shown together, so a partial collection or a discount only
// surfaced later on the printed bill — which is how a bill ends up reading
// "Grand Total 1800 / Total Paid 1600" with nothing explaining the gap.
// The collect button says what it will do: "Collect ₹720", not "Collect
// Payment". Kept in step with the amount field by _settleSyncBreakdown, and
// restored through here after a request instead of a hard-coded string.
function _syncCollectButtonLabel() {
  const btn = document.getElementById("collect-payment-btn");
  if (!btn) return;
  const el = document.getElementById("settlement-payment-amount");
  const amt = parseInt((el && el.value) || "0", 10);
  btn.textContent = amt > 0
    ? "Collect ₹" + Number(amt).toLocaleString("en-IN")
    : "Collect payment";
}

function _settleSyncBreakdown() {
  _syncCollectButtonLabel();
  const box = document.getElementById("settlement-breakdown");
  if (!box) return;

  const settlement = pendingSettlements.find((s) => s.id === activeSettlementId);
  if (!settlement) {
    box.style.display = "none";
    return;
  }

  const _int = function (id) {
    const el = document.getElementById(id);
    const v = parseInt((el && el.value) || "0", 10);
    return isNaN(v) || v < 0 ? 0 : v;
  };
  const original = parseInt(settlement.amount, 10) || 0;
  const discount = Math.min(_int("settlement-discount-amount"), original);
  const payable = original - discount;
  const paying = Math.min(_int("settlement-payment-amount"), payable);
  const remaining = payable - paying;

  const typeEl = document.querySelector(
    'input[name="settlement-disc-type"]:checked'
  );
  const isCn = !typeEl || typeEl.value === "credit_note";

  const rupee = function (n) {
    return "₹" + Number(n).toLocaleString("en-IN");
  };
  const row = function (label, value, opts) {
    opts = opts || {};
    return (
      '<div style="display:flex;justify-content:space-between;gap:1rem;' +
      (opts.strong ? "font-weight:700;" : "") +
      (opts.top ? "border-top:1px solid #ddd;margin-top:.3rem;padding-top:.3rem;" : "") +
      'color:' + (opts.color || "#333") + ';">' +
      "<span>" + label + "</span><span>" + value + "</span></div>"
    );
  };

  let html = row("Originally owed", rupee(original));
  if (discount > 0) {
    html += row(
      isCn ? "Price reduction (credit note)" : "Written off (no GST relief)",
      "− " + rupee(discount),
      { color: isCn ? "#2e7d32" : "#b45309" }
    );
    html += row("Now payable", rupee(payable), { top: true });
  }
  html += row("Collecting now", rupee(paying), { top: discount === 0 });
  html += row(
    remaining > 0 ? "Still owed after this" : "Fully settled",
    remaining > 0 ? rupee(remaining) : "✓",
    { strong: true, top: true, color: remaining > 0 ? "#b45309" : "#2e7d32" }
  );
  if (discount > 0 && isCn) {
    html +=
      '<div style="margin-top:.4rem;font-size:.76rem;color:#446;">' +
      "A credit note will be issued against the original bill, so the invoice " +
      "and the amount collected reconcile.</div>";
  }
  box.innerHTML = html;
  box.style.display = "block";
}

// Show confirmation before cancelling a settlement
function showCancelSettlementConfirmation() {
  if (!activeSettlementId) {
    showNotification("No active settlement selected", "error");
    return;
  }

  // Find the settlement
  const settlement = pendingSettlements.find(
    (s) => s.id === activeSettlementId
  );
  if (!settlement) {
    showNotification("Settlement not found", "error");
    return;
  }

  // Ask for confirmation
  if (
    confirm(
      `Are you sure you want to cancel the pending payment of ₹${settlement.amount} from ${settlement.guest_name}?`
    )
  ) {
    cancelSettlement();
  }
}

// Cancel a settlement
async function cancelSettlement() {
  if (!activeSettlementId) {
    showNotification("No active settlement selected", "error");
    return;
  }

  // Get the button and disable it
  const cancelBtn = document.getElementById("cancel-settlement-btn");
  if (!cancelBtn) {
    showNotification("Cancel settlement button not found", "error");
    return;
  }

  // Show loading state
  cancelBtn.disabled = true;
  cancelBtn.innerHTML =
    '<span class="loader" style="width: 20px; height: 20px;"></span> Processing...';

  try {
    // Ask for reason in a simple prompt
    const reason = prompt(
      "Please enter a reason for cancelling this settlement:"
    );

    if (reason === null) {
      // User clicked cancel on the prompt
      throw new Error("Cancellation aborted by user");
    }

    // Call API to cancel settlement
    const response = await apiFetch("/cancel_settlement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        settlement_id: activeSettlementId,
        reason: reason || "No reason provided",
      }),
    });

    if (!response.ok) {
      throw new Error(`Server responded with status: ${response.status}`);
    }

    const result = await response.json();

    if (result.success) {
      // Refresh settlements data
      await fetchPendingSettlements();

      // Close the collect modal
      const modal = document.getElementById("collect-settlement-modal");
      if (modal) {
        modal.classList.remove("show");
      }

      // Refresh the settlements display
      renderPendingSettlements();

      // Show success message
      showNotification(
        result.message || "Settlement cancelled successfully",
        "success"
      );
    } else {
      showNotification(
        result.message || "Failed to cancel settlement",
        "error"
      );
    }
  } catch (error) {
    console.error("Error cancelling settlement:", error);

    // Don't show notification if user cancelled the prompt
    if (error.message !== "Cancellation aborted by user") {
      showNotification(
        `Error cancelling settlement: ${error.message}`,
        "error"
      );
    }
  } finally {
    // Restore button state
    cancelBtn.disabled = false;
    cancelBtn.innerHTML = "Cancel Settlement";
  }
}

// Update dashboard to show pending settlements count
function updateDashboardWithSettlements() {
  const quickSettlementsBtn = document.getElementById("quick-settlements-btn");
  if (!quickSettlementsBtn) return;

  // Count pending settlements
  const pendingCount = pendingSettlements.filter(
    (s) => s.status === "pending" || s.status === "partial"
  ).length;

  if (pendingCount > 0) {
    quickSettlementsBtn.innerHTML = `
      <i class="fas fa-money-bill-wave"></i>
      <span>Pending Payments <span style="background-color: var(--warning); padding: 2px 6px; border-radius: 50%; margin-left: 5px; font-size: 0.7rem;">${pendingCount}</span></span>
    `;
  } else {
    quickSettlementsBtn.innerHTML = `
      <i class="fas fa-money-bill-wave"></i>
      <span>Pending Payments</span>
    `;
  }
}

// Add pending settlements amount to dashboard
function updateStatsWithSettlements() {
  // First, make sure we have a function to override
  if (typeof updateStats === "function") {
    const originalUpdateStats = updateStats;

    window.updateStats = function () {
      // Call the original function
      originalUpdateStats();

      // Add pending settlements total to the stats
      const pendingSettlementsTotal = pendingSettlements
        .filter((s) => s.status === "pending" || s.status === "partial")
        .reduce((total, s) => total + (s.amount || 0), 0);

      // Update the pending balance with pending settlements
      if (pendingBalance) {
        const currentBalance =
          parseInt(pendingBalance.textContent.replace("₹", "")) || 0;
        const totalWithSettlements = currentBalance + pendingSettlementsTotal;
        pendingBalance.textContent = "₹" + totalWithSettlements;
      }

      // Update the dashboard badge for pending settlements
      updateDashboardWithSettlements();
    };
  }
}

// Initialize during DOMContentLoaded
document.addEventListener("DOMContentLoaded", function () {
  setTimeout(() => {
    initSettleLater();
    enhanceCheckoutConfirmation();

    // Settlements are loaded on-demand only — when the user opens the
    // "Pending Payments" quick-action modal (showPendingSettlementsModal).
    // No auto-load on tab switch or page startup: avoids an unnecessary
    // Firestore read on every session where the modal is never opened.
  }, 1000);
});
// Render the pending settlements list
// ── Pending Payments list ───────────────────────────────────────────────────
//
// A collections screen, built like one. The old list gave each row a name, a
// room, a checkout date and an amount in the same weight of text, so the eye
// had nothing to land on and the two questions the desk actually asks — how
// much, and how long has it been owed — had to be worked out by reading.
//
// What each row answers now, in the order it is read:
//   the guest and their number (the call you are about to make)
//   the amount still due, as the largest thing on the row
//   how overdue it is, colour-coded, because a 60-day balance is a different
//     conversation from a 2-day one
//   the invoice number, so it can be quoted without opening the Bills tab
//   which stay it was: room, nights, the dates, how many guests
//   what was already paid against the bill, so a part payment is obvious
//   the note the operator left at checkout
//
// Sorting follows the same logic: oldest debt first while looking at Pending,
// most recent first everywhere else (Paid and Cancelled are history, and
// history reads newest-first).

// How the list is ordered. Latest first by default: the balance taken this
// morning is the one the desk is asked about, and a guest who checked out an
// hour ago is still reachable. The age chip on each row is what surfaces an
// old debt, so ordering by date no longer has to do that job — and the
// operator can switch to Oldest first when they sit down to chase them.
//
// Module-level so the choice survives closing and reopening the modal within
// a shift, without persisting past a reload.
let currentSettlementSort = "latest";

const PSX_SORTS = {
  latest: (a, b) => psxTime(b) - psxTime(a),
  oldest: (a, b) => psxTime(a) - psxTime(b),
  // Biggest debt first, and for two equal amounts the older one leads.
  amount: (a, b) =>
    (Number(b.amount) || 0) - (Number(a.amount) || 0) || psxTime(a) - psxTime(b),
  name: (a, b) =>
    String(a.guest_name || "").localeCompare(String(b.guest_name || ""),
                                             "en", { sensitivity: "base" }),
};

/** Checkout as a sortable number, time included so two same-day rows keep
 *  the order they happened in. Undated rows sort last under Latest. */
function psxTime(settlement) {
  const day = String(settlement.checkout_date || "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return 0;
  const time = String(settlement.checkout_time || "00:00").trim().slice(0, 5);
  const d = new Date(day + "T" + (/^\d{2}:\d{2}$/.test(time) ? time : "00:00"));
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

const PSX_ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function psxEsc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => PSX_ESC_MAP[c]);
}

function psxRupees(n) {
  const v = Math.round(Number(n) || 0);
  return "₹" + v.toLocaleString("en-IN");
}

/** "2026-09-07" or "2026-09-07 14:30" → a Date at local midnight, or null. */
function psxDate(value) {
  const text = String(value || "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const d = new Date(text + "T12:00:00");
  return isNaN(d.getTime()) ? null : d;
}

function psxDayLabel(value) {
  const d = psxDate(value);
  if (!d) return "—";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

function psxFullDate(value) {
  const d = psxDate(value);
  if (!d) return "—";
  return d.toLocaleDateString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
  });
}

/** Whole days between a date and today. Negative dates clamp to 0. */
function psxDaysSince(value) {
  const d = psxDate(value);
  if (!d) return null;
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  return Math.max(0, Math.round((today - d) / 86400000));
}

/**
 * Nights of the stay.
 *
 * The bill's days_stayed is the billed figure and is preferred — it is what
 * the invoice charged for, which is the number the guest will recognise. The
 * settlement's own check-in and checkout dates are the fallback for rows
 * whose bill could not be found.
 */
function psxNights(settlement) {
  const billed = settlement.bill && Number(settlement.bill.days_stayed);
  if (billed > 0) return billed;
  const inDate = psxDate((settlement.bill && settlement.bill.checkin_time)
                         || settlement.checkin_time);
  const outDate = psxDate(settlement.checkout_date);
  if (!inDate || !outDate) return null;
  return Math.max(1, Math.round((outDate - inDate) / 86400000));
}

/** Overdue banding. The thresholds are the desk's, not arithmetic's: a week
 *  is still "this week's guest", a month is a phone call, beyond that it is a
 *  debt somebody has to decide about. */
function psxAgeBand(days) {
  if (days == null) return { cls: "psx-age-new", label: "—" };
  if (days <= 7) return { cls: "psx-age-new", label: days + "d" };
  if (days <= 30) return { cls: "psx-age-warn", label: days + "d" };
  return { cls: "psx-age-old", label: days + "d" };
}

const PSX_STATUS = {
  pending: { cls: "psx-st-pending", label: "Pending" },
  partial: { cls: "psx-st-partial", label: "Part paid" },
  paid: { cls: "psx-st-paid", label: "Paid" },
  cancelled: { cls: "psx-st-cancelled", label: "Cancelled" },
};

function psxMatchesSearch(settlement, needle) {
  if (!needle) return true;
  const bill = settlement.bill || {};
  const hay = [
    settlement.guest_name, settlement.guest_mobile, settlement.room,
    bill.bill_number, settlement.notes, settlement.serial_number,
  ].join(" ").toLowerCase();
  return hay.indexOf(needle) > -1;
}

function psxRenderCard(settlement) {
  const bill = settlement.bill || null;
  const status = String(settlement.status || "").toLowerCase();
  const meta = PSX_STATUS[status]
    || { cls: "psx-st-other", label: settlement.status || "Unknown" };
  const open = status === "pending" || status === "partial";
  const due = Math.max(0, Number(settlement.amount) || 0);
  // A closed row's `amount` is what was LEFT after collecting, which is zero.
  // Printing ₹0 as the headline figure of a settled row tells the operator
  // nothing and reads like an error, so a paid row shows what was actually
  // taken and a fully-adjusted one says so in words.
  const collected = (Array.isArray(settlement.payments)
    ? settlement.payments : []).reduce(
      (sum, p) => sum + (Number(p.amount) || 0), 0);
  const headline = open
    ? psxRupees(due)
    : (collected > 0 ? psxRupees(collected)
       : due > 0 ? psxRupees(due)
       : '<span class="psx-amount-nil">Settled</span>');
  const days = psxDaysSince(settlement.checkout_date);
  const age = psxAgeBand(days);
  const nights = psxNights(settlement);
  const checkIn = (bill && bill.checkin_time) || settlement.checkin_time;

  // Facts about the stay, as chips. Anything unknown is left out rather than
  // printed as a dash — a row of dashes reads as broken data.
  const facts = [];
  if (settlement.room) {
    facts.push('<span class="psx-fact"><i class="fas fa-door-open"></i>Room '
      + psxEsc(settlement.room) + "</span>");
  }
  if (nights) {
    facts.push('<span class="psx-fact"><i class="fas fa-moon"></i>' + nights
      + " night" + (nights === 1 ? "" : "s") + "</span>");
  }
  if (bill && bill.guest_count > 1) {
    facts.push('<span class="psx-fact"><i class="fas fa-user-group"></i>'
      + bill.guest_count + " guests</span>");
  }
  if (bill && bill.booking_source && bill.booking_source !== "normal") {
    facts.push('<span class="psx-fact psx-fact-ota"><i class="fas fa-globe"></i>'
      + psxEsc(bill.booking_source.toUpperCase()) + "</span>");
  }

  const stayDates = checkIn
    ? psxDayLabel(checkIn) + " → " + psxFullDate(settlement.checkout_date)
    : "Checked out " + psxFullDate(settlement.checkout_date);

  // The money line. Shown only when the bill was found AND something was
  // already paid against it, because that is the case a bare "due" figure
  // misrepresents: the guest remembers paying, the row says they owe.
  let moneyLine = "";
  if (bill && bill.total_amount > 0 && bill.paid > 0) {
    moneyLine =
      '<div class="psx-money">' +
      '<span>Bill <b>' + psxRupees(bill.total_amount) + "</b></span>" +
      '<span class="psx-money-sep">·</span>' +
      '<span>Paid <b>' + psxRupees(bill.paid) + "</b></span>" +
      (bill.discounts > 0
        ? '<span class="psx-money-sep">·</span><span>Discount <b>'
          + psxRupees(bill.discounts) + "</b></span>"
        : "") +
      "</div>";
  }

  const payments = Array.isArray(settlement.payments) ? settlement.payments : [];
  const history = payments.length
    ? '<div class="psx-history"><div class="psx-history-hd">Collected so far</div>'
      + payments.map((p) =>
          '<div class="psx-history-row"><span>' + psxFullDate(p.date)
          + '</span><span class="psx-pay-mode ' + psxEsc(p.mode || "") + '">'
          + psxEsc(p.mode || "—") + "</span><b>" + psxRupees(p.amount)
          + "</b></div>").join("")
      + "</div>"
    : "";

  const discount = Number(settlement.discount_amount) > 0
    ? '<div class="psx-note psx-note-discount"><i class="fas fa-tag"></i>'
      + "Discount " + psxRupees(settlement.discount_amount)
      + (settlement.discount_reason
          ? " — " + psxEsc(settlement.discount_reason) : "")
      + "</div>"
    : "";

  const note = settlement.notes
    ? '<div class="psx-note"><i class="fas fa-sticky-note"></i>'
      + psxEsc(settlement.notes) + "</div>"
    : "";

  let footer;
  if (open) {
    footer = '<button type="button" class="psx-collect collect-btn" data-id="'
      + psxEsc(settlement.id) + '">'
      + '<i class="fas fa-indian-rupee-sign"></i> Collect ' + psxRupees(due)
      + "</button>";
  } else if (status === "paid") {
    footer = '<div class="psx-settled"><i class="fas fa-circle-check"></i>'
      + "Collected " + psxFullDate(settlement.payment_date)
      + (settlement.payment_mode
          ? ' <span class="psx-pay-mode ' + psxEsc(settlement.payment_mode)
            + '">' + psxEsc(settlement.payment_mode) + "</span>"
          : "") + "</div>";
  } else {
    footer = '<div class="psx-settled psx-settled-void">'
      + '<i class="fas fa-ban"></i>Written off '
      + psxFullDate(settlement.cancel_date) + "</div>";
  }

  return (
    '<article class="psx-card ' + (open ? "is-open" : "is-closed")
      + '" data-id="' + psxEsc(settlement.id) + '" data-status="'
      + psxEsc(status) + '">' +
    '  <header class="psx-card-top">' +
    '    <div class="psx-who">' +
    '      <h3 class="psx-name">' + psxEsc(settlement.guest_name || "Guest") + "</h3>" +
    (settlement.guest_mobile
      ? '      <a class="psx-phone" href="tel:' + psxEsc(settlement.guest_mobile)
        + '"><i class="fas fa-phone"></i>' + psxEsc(settlement.guest_mobile) + "</a>"
      : "") +
    "    </div>" +
    '    <div class="psx-amount-col">' +
    '      <div class="psx-amount">' + headline + "</div>" +
    '      <div class="psx-badges">' +
    '        <span class="psx-status ' + meta.cls + '">' + psxEsc(meta.label) + "</span>" +
    (open && days != null
      ? '        <span class="psx-age ' + age.cls + '" title="Days since checkout">'
        + age.label + "</span>"
      : "") +
    "      </div>" +
    "    </div>" +
    "  </header>" +
    '  <div class="psx-stay">' +
    (bill && bill.bill_number
      ? '    <div class="psx-billno"><i class="fas fa-file-invoice"></i>'
        + psxEsc(bill.bill_number) + "</div>"
      : '    <div class="psx-billno psx-billno-missing">'
        + '<i class="fas fa-file-invoice"></i>No invoice linked</div>') +
    '    <div class="psx-dates">' + psxEsc(stayDates) + "</div>" +
    (facts.length ? '    <div class="psx-facts">' + facts.join("") + "</div>" : "") +
    moneyLine +
    "  </div>" +
    history + discount + note +
    '  <footer class="psx-card-foot">' + footer + "</footer>" +
    "</article>"
  );
}

function renderPendingSettlements() {
  const settlementsList = document.getElementById("settlements-list");
  if (!settlementsList) {
    console.error("Settlements list element not found");
    return;
  }

  const searchEl = document.getElementById("psx-search-input");
  const needle = (searchEl && searchEl.value || "").trim().toLowerCase();

  const all = Array.isArray(pendingSettlements) ? pendingSettlements : [];
  // "Pending" means money still owed, which includes a part-paid balance.
  // Matching the status string exactly hid those rows while the summary above
  // still counted them, so the header said three guests owed money and the
  // list showed two.
  const isOpen = (s) => s.status === "pending" || s.status === "partial";
  let rows = currentSettlementFilter === "all"
    ? all.slice()
    : currentSettlementFilter === "pending"
      ? all.filter(isOpen)
      : all.filter((s) => s.status === currentSettlementFilter);
  rows = rows.filter((s) => psxMatchesSearch(s, needle));

  // The summary counts what is genuinely outstanding, whatever tab is open:
  // switching to Paid to check a receipt should not make the amount owed
  // appear to drop to zero.
  const outstanding = all.filter(isOpen);
  const totalDue = outstanding.reduce(
    (sum, s) => sum + (Number(s.amount) || 0), 0);
  const oldest = outstanding.reduce((worst, s) => {
    const d = psxDaysSince(s.checkout_date);
    return d != null && d > worst ? d : worst;
  }, 0);

  const summary = document.getElementById("psx-summary");
  if (summary) {
    summary.hidden = outstanding.length === 0;
    const amtEl = document.getElementById("psx-sum-amount");
    const cntEl = document.getElementById("psx-sum-count");
    const oldEl = document.getElementById("psx-sum-oldest");
    if (amtEl) amtEl.textContent = psxRupees(totalDue);
    if (cntEl) {
      cntEl.textContent = outstanding.length
        + (outstanding.length === 1 ? " guest" : " guests");
    }
    if (oldEl) {
      oldEl.textContent = oldest > 0 ? "oldest " + oldest + " days" : "all recent";
    }
  }

  if (!rows.length) {
    const why = needle
      ? "Nothing matches “" + psxEsc(needle) + "”."
      : currentSettlementFilter === "pending"
        ? "No money is waiting to be collected."
        : "Nothing here yet.";
    settlementsList.innerHTML =
      '<div class="psx-empty"><i class="fas fa-circle-check"></i><p>'
      + why + "</p></div>";
    return;
  }

  rows.sort(PSX_SORTS[currentSettlementSort] || PSX_SORTS.latest);

  settlementsList.innerHTML = rows.map(psxRenderCard).join("");

  settlementsList.querySelectorAll(".collect-btn").forEach((btn) => {
    btn.addEventListener("click", function () {
      showCollectSettlementModal(this.dataset.id);
    });
  });
}
