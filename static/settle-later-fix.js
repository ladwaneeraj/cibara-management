// This file fixes the settle later functionality by overriding the original checkout process
(function () {
  // Wait for all scripts to load
  window.addEventListener("load", function () {
    // Complete override of the checkout confirmation process
    const originalConfirmCheckoutBtn = document.getElementById(
      "confirm-checkout-btn"
    );

    if (originalConfirmCheckoutBtn) {
      // Remove all existing event listeners by cloning and replacing the button
      const newBtn = originalConfirmCheckoutBtn.cloneNode(true);
      originalConfirmCheckoutBtn.parentNode.replaceChild(
        newBtn,
        originalConfirmCheckoutBtn
      );

      // Add our new event listener
      newBtn.addEventListener("click", function (event) {
        event.preventDefault();

        const roomNumberElement = document.getElementById(
          "checkout-room-number"
        );
        const guestNameElement = document.getElementById("checkout-guest-name");

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

        // Show the confirmation modal
        const checkoutConfirmModal = document.getElementById(
          "checkout-confirm-modal"
        );
        if (checkoutConfirmModal) {
          checkoutConfirmModal.classList.add("show");
          console.log("Confirmation modal displayed with updated code");
        } else {
          console.error("Confirmation modal element not found");
          showNotification("Error: Confirmation modal not found", "error");
        }
      });
    }

    // Also fix the proceed checkout button
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

      // Add new event listener
      newProceedBtn.addEventListener("click", async function () {
        console.log("Fixed proceed checkout clicked");

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
          return;
        }

        const roomNumber = roomNumberElement.textContent;
        const balance = rooms[roomNumber].balance;

        // Check if settle later is enabled
        const settleLaterEnabled =
          document.getElementById("settle-later-checkbox")?.checked || false;
        const settlementNotes =
          document.getElementById("settlement-notes")?.value || "";

        // Only block checkout if balance is positive AND settle later is not checked
        if (balance > 0 && !settleLaterEnabled) {
          showNotification(
            "Please clear the balance before checkout or use 'Settle Later' option",
            "error"
          );
          this.disabled = false;
          this.innerHTML = "Yes, Checkout";
          return;
        }

        // Get refund method if there's a negative balance
        const refundMethod =
          balance < 0
            ? document.querySelector(".refund-container .payment-btn.active")
                ?.id === "refund-cash-btn"
              ? "cash"
              : "online"
            : null;

        try {
          console.log("Sending checkout request to server");
          const response = await fetch("/checkout", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              room: roomNumber,
              final_checkout: true,
              refund_method: refundMethod,
              settle_later: settleLaterEnabled,
              settlement_notes: settlementNotes,
            }),
          });

          if (!response.ok) {
            throw new Error(`Server responded with status: ${response.status}`);
          }

          const result = await response.json();
          if (result.success) {
            console.log("Checkout successful");
            // Close both modals
            const checkoutConfirmModal = document.getElementById(
              "checkout-confirm-modal"
            );
            if (checkoutConfirmModal) {
              checkoutConfirmModal.classList.remove("show");
            }

            const checkoutModal = document.getElementById("checkout-modal");
            if (checkoutModal) {
              checkoutModal.classList.remove("show");
            }

            await fetchData();

            // If settled later, let the user know
            if (settleLaterEnabled && balance > 0) {
              showNotification(
                `Checkout with 'Settle Later' option completed. Payment of ₹${balance} is now in pending settlements.`,
                "success"
              );
            } else {
              showNotification("Checkout successful!", "success");
            }
          } else {
            console.error("Checkout failed:", result.message);
            showNotification(
              result.message || "Error during checkout",
              "error"
            );
          }
        } catch (error) {
          console.error("Error during checkout:", error);
          showNotification(`Error during checkout: ${error.message}`, "error");
        } finally {
          // Re-enable button
          this.disabled = false;
          this.innerHTML = "Yes, Checkout";
        }
      });
    }

    console.log("Settle Later Fix applied successfully!");
  });
})();
