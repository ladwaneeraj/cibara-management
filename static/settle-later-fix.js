(function () {
  // Wait for all scripts to load
  window.addEventListener("load", function () {
    // Enhanced proceed checkout handler with proper refund validation
    const originalProceedCheckoutBtn = document.getElementById(
      "proceed-checkout-btn"
    );

    if (originalProceedCheckoutBtn) {
      // Remove all existing event listeners
      const newProceedBtn = originalProceedCheckoutBtn.cloneNode(true);
      originalProceedCheckoutBtn.parentNode.replaceChild(
        newProceedBtn,
        originalProceedCheckoutBtn
      );

      // Add enhanced event listener with refund validation
      newProceedBtn.addEventListener("click", async function () {
        console.log("Enhanced proceed checkout clicked");

        // Prevent multiple calls
        if (typeof checkoutInProgress !== "undefined" && checkoutInProgress) {
          console.log("Checkout already in progress, ignoring proceed click");
          return;
        }

        if (typeof checkoutInProgress !== "undefined") {
          checkoutInProgress = true;
        }

        // Disable button and show loading state
        this.disabled = true;
        this.innerHTML =
          '<span class="loader" style="width: 20px; height: 20px;"></span> Processing...';

        const roomNumberElement = document.getElementById(
          "checkout-room-number"
        );
        if (!roomNumberElement) {
          showNotification("Room number element not found", "error");
          console.error("Room number element not found during checkout");
          this.resetButton();
          return;
        }

        const roomNumber = roomNumberElement.textContent;
        const balance = rooms[roomNumber].balance;

        // ── Capture flag state NOW — before the guest object is nulled out ──
        const flagCbEl = document.getElementById("checkout-flag-customer");
        const flagNotesEl = document.getElementById("checkout-flag-notes");
        const shouldFlag = !!(flagCbEl && flagCbEl.checked);
        const flagNotesValue = flagNotesEl ? flagNotesEl.value.trim() : "";
        const checkoutMobile = rooms[roomNumber]?.guest?.mobile || "";
        console.log("[flag] shouldFlag:", shouldFlag, "mobile:", checkoutMobile);

        // Check if settle later is enabled
        const settleLaterEnabled =
          document.getElementById("settle-later-checkbox")?.checked || false;
        const settlementNotes =
          document.getElementById("settlement-notes")?.value || "";

        console.log(`Balance: ${balance}, Settle Later: ${settleLaterEnabled}`);

        // ── Settle Later authorisation (RBAC) ──────────────────────────────────
        // The legacy password prompt has been replaced by a role check.
        // Only users with "settle_later.use" (admin) can checkout with a
        // pending balance via Settle Later. Non-admins should never see
        // the toggle (it's hidden via data-perm); this is the safety net.
        if (settleLaterEnabled && balance > 0) {
          const auth = window.CibaraAuth;
          if (!auth || !auth.userCan || !auth.userCan('settle_later.use')) {
            showNotification(
              'Settle Later is restricted to admin users.',
              'error'
            );
            this.resetButton();
            return;
          }
          const pwErrorEl = document.getElementById('checkout-password-error');
          if (pwErrorEl) pwErrorEl.style.display = 'none';
        }
        // ── End authorisation ──────────────────────────────────────────────────

        // *** ENHANCED BALANCE VALIDATION ***

        // MMT/OTA rooms: balance is settled via the OTA settlement modal after
        // checkout, not at the time of checkout — so skip the balance block entirely.
        const isOtaCheckout = rooms[roomNumber]?.guest?.payment === "ota";

        // 1. STRICT BLOCKING for positive balance without settle later
        // OTA rooms are exempt — their dues are tracked in settlements, not here.
        if (balance > 0 && !settleLaterEnabled && !isOtaCheckout) {
          console.log(
            "Checkout blocked - positive balance without settle later"
          );
          showNotification(
            `Cannot checkout with pending balance of ₹${balance}. Please clear all dues first or use 'Settle Later' option.`,
            "error"
          );
          this.resetButton();
          this.closeConfirmationModal();
          return;
        }

        // 2. STRICT BLOCKING for negative balance (refunds) - NO EXCEPTIONS
        if (balance < 0) {
          console.log("Checkout blocked - refund pending");
          showNotification(
            `Cannot checkout with pending refund of ₹${Math.abs(
              balance
            )}. Please process the refund first.`,
            "error"
          );
          this.resetButton();
          this.closeConfirmationModal();
          return;
        }

        // *** END OF ENHANCED VALIDATION ***

        // Get refund method if there's a negative balance (shouldn't reach here due to validation above)
        const refundMethod =
          balance < 0
            ? document.querySelector(".refund-container .payment-btn.active")
                ?.id === "refund-cash-btn"
              ? "cash"
              : "online"
            : null;

        // ── Optimistic checkout ────────────────────────────────────────────
        // All validation above is synchronous and has passed. Close the
        // modals and flip the room NOW — the operator moves straight to the
        // next room — then persist in the background (bill generation takes
        // seconds server-side). One request per click is preserved (this
        // remains the ONLY /checkout handler; see the bill-number-gap note
        // in settle-later.js), and a failure rolls the room back loudly.

        // Snapshot for rollback, then flip the room locally.
        const prevRoomState = rooms[roomNumber] ? { ...rooms[roomNumber] } : null;
        if (rooms[roomNumber]) {
          rooms[roomNumber].status = "cleaning";
          rooms[roomNumber].guest = null;
        }
        if (typeof renderRooms === "function") renderRooms();

        // Close both modals immediately.
        this.closeConfirmationModal();
        const checkoutModalEl = document.getElementById("checkout-modal");
        if (checkoutModalEl) {
          checkoutModalEl.classList.remove("show");
        }

        // Button + shared flag are free again for the next room right away.
        this.resetButton();

        console.log("Sending checkout request to server (background)");
        const _doCheckout = () => apiFetch("/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            room: roomNumber,
            final_checkout: true,
            refund_method: refundMethod,
            settle_later: settleLaterEnabled,
            settlement_notes: settlementNotes,
            room_data: prevRoomState, // lets the server skip a Firestore read
          }),
        });

        // Route through the per-room write queue so a payment still settling
        // for THIS room lands before the bill is computed. Other rooms'
        // queues are independent — nothing cross-blocks.
        (window.cibaraWrites && typeof window.cibaraWrites.enqueue === "function"
          ? window.cibaraWrites.enqueue(roomNumber, _doCheckout)
          : _doCheckout())
          .then(async (response) => {
            if (!response.ok) {
              throw new Error(`Server responded with status: ${response.status}`);
            }
            const result = await response.json();
            if (!result.success) {
              throw new Error(result.message || "Error during checkout");
            }
            console.log("Checkout successful");

            // Success message (settle-later variant keeps its specific text)
            if (settleLaterEnabled && balance > 0) {
              showNotification(
                `Checkout completed with 'Settle Later' option. Payment of ₹${balance} added to pending settlements.`,
                "success"
              );
            } else {
              showNotification(result.message || "Checkout successful!", "success");
            }

            debouncedFetchData(); // authoritative background sync

            // Auto-generate & store the bill PDF in the background
            if (result.bill_id && typeof window._cibaraBillsAutoGenerate === "function") {
              window._cibaraBillsAutoGenerate(result.bill_id);
            }

            // Notify register & bills modules to refresh live
            window.dispatchEvent(new CustomEvent("cibaraRoomUpdate", { detail: { type: "checkout", room: roomNumber } }));

            // ── Save customer flag if checkbox was ticked ─────────────────
            if (shouldFlag && checkoutMobile) {
              console.log("[flag] Saving flag for:", checkoutMobile);
              apiFetch("/toggle_customer_flag", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  mobile: checkoutMobile,
                  is_flagged: true,
                  flag_notes: flagNotesValue,
                }),
              })
                .then((r) => r.json())
                .then((flagResult) => {
                  if (flagResult.success) {
                    console.log("[flag] Customer flagged successfully:", checkoutMobile);
                    showNotification("🚩 Customer flagged successfully", "success");
                  } else {
                    console.warn("[flag] Flag API error:", flagResult.message);
                    showNotification("⚠️ Checkout done but flag not saved: " + (flagResult.message || "unknown error"), "error");
                  }
                })
                .catch((err) => console.warn("[flag] Network error saving flag:", err));
            }
          })
          .catch((error) => {
            // Roll back the optimistic flip and tell the operator loudly —
            // the room is restored exactly as it was, ready to retry.
            console.error("Error during checkout:", error);
            if (prevRoomState) rooms[roomNumber] = prevRoomState;
            if (typeof renderRooms === "function") renderRooms();
            showNotification(
              `Checkout of room ${roomNumber} FAILED: ${error.message} — the room has been restored, please retry.`,
              "error",
              8000
            );
          });
      });

      // Add helper methods to the button element
      newProceedBtn.resetButton = function () {
        if (typeof checkoutInProgress !== "undefined") {
          checkoutInProgress = false;
        }
        this.disabled = false;
        this.innerHTML = "Yes, Checkout";
      };

      newProceedBtn.closeConfirmationModal = function () {
        const checkoutConfirmModal = document.getElementById(
          "checkout-confirm-modal"
        );
        if (checkoutConfirmModal) {
          checkoutConfirmModal.classList.remove("show");
        }
      };
    }

    console.log("Enhanced checkout validation applied successfully!");
  });
})();

// Additional validation for the main checkout button (confirm-checkout-btn)
(function () {
  window.addEventListener("load", function () {
    const confirmCheckoutBtn = document.getElementById("confirm-checkout-btn");

    if (confirmCheckoutBtn) {
      // Remove existing listeners and add enhanced one
      const newBtn = confirmCheckoutBtn.cloneNode(true);
      confirmCheckoutBtn.parentNode.replaceChild(newBtn, confirmCheckoutBtn);

      newBtn.addEventListener("click", function (event) {
        event.preventDefault();

        const roomNumberElement = document.getElementById(
          "checkout-room-number"
        );
        if (!roomNumberElement) {
          showNotification("Room number element not found", "error");
          return;
        }

        const roomNumber = roomNumberElement.textContent;
        const balance = rooms[roomNumber].balance;

        // Pre-validation before showing confirmation modal
        if (balance < 0) {
          showNotification(
            `Cannot proceed to checkout with pending refund of ₹${Math.abs(
              balance
            )}. Please process the refund first.`,
            "error"
          );
          return;
        }

        // Continue with normal confirmation modal display
        const guestNameElement = document.getElementById("checkout-guest-name");
        const guestName = guestNameElement
          ? guestNameElement.textContent
          : "Unknown";

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
        if (confirmGuestElement) confirmGuestElement.textContent = guestName;

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
            const settlementNotes = document.getElementById("settlement-notes");
            if (settlementNotes) {
              settlementNotes.value = "";
            }
          } else {
            balanceContainer.style.display = "none";
          }
        }

        // Reset manager password field each time the confirmation modal opens
        const pwField = document.getElementById('checkout-manager-password');
        if (pwField) pwField.value = '';
        const pwErrEl = document.getElementById('checkout-password-error');
        if (pwErrEl) pwErrEl.style.display = 'none';

        // Reset flag section each time the confirmation modal opens
        const flagCb = document.getElementById("checkout-flag-customer");
        const flagNotesCtr = document.getElementById("checkout-flag-notes-container");
        const flagNotesField = document.getElementById("checkout-flag-notes");
        if (flagCb) flagCb.checked = false;
        if (flagNotesCtr) flagNotesCtr.style.display = "none";
        if (flagNotesField) flagNotesField.value = "";

        // Show the confirmation modal
        const checkoutConfirmModal = document.getElementById(
          "checkout-confirm-modal"
        );
        if (checkoutConfirmModal) {
          checkoutConfirmModal.classList.add("show");
          console.log("Confirmation modal displayed with enhanced validation");
        }
      });
    }
  });
})();
