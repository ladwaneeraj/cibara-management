// Enhanced Quick Room Transfer Functionality
function initQuickTransferButton() {
  const quickTransferBtn = document.getElementById("quick-transfer-btn");
  if (!quickTransferBtn) {
    console.error("Quick transfer button not found");
    return;
  }

  quickTransferBtn.addEventListener("click", function () {
    showQuickTransferModal();

    // Hide the quick action menu
    const quickActionMenu = document.querySelector(".quick-action-menu");
    if (quickActionMenu) {
      quickActionMenu.classList.remove("show");
    }
  });

  // Set up close functionality for the quick transfer modal
  const quickTransferModal = document.getElementById("quick-transfer-modal");
  if (quickTransferModal) {
    const closeBtn = quickTransferModal.querySelector(".close-btn");
    if (closeBtn) {
      closeBtn.addEventListener("click", function () {
        quickTransferModal.classList.remove("show");
      });
    }

    const cancelBtn = document.getElementById("cancel-quick-transfer-btn");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", function () {
        quickTransferModal.classList.remove("show");
      });
    }
  }
}

// Show enhanced quick transfer modal
function showQuickTransferModal() {
  const quickTransferModal = document.getElementById("quick-transfer-modal");
  if (!quickTransferModal) {
    console.error("Quick transfer modal not found");
    return;
  }

  const sourceRoomSelect = document.getElementById("quick-source-room");
  const destRoomSelect = document.getElementById("quick-dest-room");
  const quickGuestInfo = document.getElementById("quick-guest-info");
  const quickBalanceInfo = document.getElementById("quick-balance-info");
  const quickGuestName = document.getElementById("quick-guest-name");
  const quickBalance = document.getElementById("quick-balance");

  // Enhanced fields
  const roomPriceSection = document.getElementById("room-price-section");
  const newRoomPriceInput = document.getElementById("new-room-price");
  const acToggleSection = document.getElementById("ac-toggle-section");
  const newRoomAcToggle = document.getElementById("new-room-ac-toggle");

  if (!sourceRoomSelect || !destRoomSelect) {
    console.error("Quick transfer form elements not found");
    return;
  }

  // Reset the form
  quickGuestInfo.style.display = "none";
  quickBalanceInfo.style.display = "none";
  if (roomPriceSection) roomPriceSection.style.display = "none";
  if (acToggleSection) acToggleSection.style.display = "none";

  // Populate source room dropdown (only occupied rooms)
  sourceRoomSelect.innerHTML = '<option value="">Select source room</option>';
  let occupiedRoomCount = 0;

  Object.entries(rooms).forEach(([roomNum, info]) => {
    if (info.status === "occupied") {
      const option = document.createElement("option");
      option.value = roomNum;
      option.textContent = `Room ${roomNum} - ${info.guest.name}`;
      sourceRoomSelect.appendChild(option);
      occupiedRoomCount++;
    }
  });

  if (occupiedRoomCount === 0) {
    const option = document.createElement("option");
    option.disabled = true;
    option.textContent = "No occupied rooms available";
    sourceRoomSelect.appendChild(option);
  }

  // Reset destination room dropdown
  destRoomSelect.innerHTML =
    '<option value="">Select destination room</option>';
  destRoomSelect.disabled = true;

  // Set up source room change handler
  // NOTE: use .onchange (single-slot) instead of addEventListener — this
  // function runs every time the modal opens and addEventListener would
  // stack duplicate handlers, which previously caused the AC toggle to
  // flicker or disappear after multiple transfers.
  sourceRoomSelect.onchange = function () {
    const selectedRoom = sourceRoomSelect.value;

    if (!selectedRoom) {
      // Reset UI if no room selected
      quickGuestInfo.style.display = "none";
      quickBalanceInfo.style.display = "none";
      if (roomPriceSection) roomPriceSection.style.display = "none";
      if (acToggleSection) acToggleSection.style.display = "none";
      destRoomSelect.innerHTML =
        '<option value="">Select destination room</option>';
      destRoomSelect.disabled = true;
      return;
    }

    // Show guest information
    if (rooms[selectedRoom] && rooms[selectedRoom].guest) {
      const guest = rooms[selectedRoom].guest;

      quickGuestName.textContent = guest.name;
      quickGuestInfo.style.display = "block";

      // Show balance information
      const balance = rooms[selectedRoom].balance;
      if (balance < 0) {
        quickBalance.textContent = `₹${Math.abs(balance)} (refund)`;
        quickBalance.style.color = "var(--success)";
      } else {
        quickBalance.textContent = `₹${balance}`;
        quickBalance.style.color = balance > 0 ? "var(--danger)" : "";
      }
      quickBalanceInfo.style.display = "block";
    }

    // Populate destination room dropdown (only vacant rooms)
    destRoomSelect.innerHTML =
      '<option value="">Select destination room</option>';
    destRoomSelect.disabled = false;

    let vacantRoomCount = 0;

    Object.entries(rooms).forEach(([roomNum, info]) => {
      if (roomNum !== selectedRoom && info.status === "vacant") {
        const option = document.createElement("option");
        option.value = roomNum;
        option.textContent = `Room ${roomNum}`;
        destRoomSelect.appendChild(option);
        vacantRoomCount++;
      }
    });

    if (vacantRoomCount === 0) {
      const option = document.createElement("option");
      option.disabled = true;
      option.textContent = "No vacant rooms available";
      destRoomSelect.appendChild(option);
      destRoomSelect.disabled = true;

      showNotification("No vacant rooms available for transfer", "warning");
    }
  };

  // Helper — show upgrade/downgrade balance hint for same-24hr-cycle transfers
  function updateTransferBalanceHint(sourceRoom, newPrice) {
    const hintEl = document.getElementById("transfer-balance-hint");
    if (!hintEl) return;

    const roomData = rooms[sourceRoom];
    if (!roomData) { hintEl.style.display = "none"; return; }

    // Only relevant when guest hasn't completed a full 24-hr cycle yet
    // (renewal_count == 0 means no full cycle has been manually renewed)
    const renewalCount = (roomData.renewal_count !== undefined)
      ? roomData.renewal_count
      : (roomData.guest && roomData.guest.renewal_count !== undefined ? roomData.guest.renewal_count : 0);

    if (renewalCount !== 0) { hintEl.style.display = "none"; return; }

    const oldPrice = (roomData.guest && roomData.guest.price) ? roomData.guest.price : 0;
    const diff = newPrice - oldPrice;

    if (diff === 0) { hintEl.style.display = "none"; return; }

    if (diff > 0) {
      // Upgrade — guest owes more
      hintEl.style.background = "#fff3cd";
      hintEl.style.color = "#856404";
      hintEl.style.border = "1px solid #ffc107";
      hintEl.textContent = `Same-day upgrade: ₹${diff} balance will be added (₹${oldPrice} → ₹${newPrice})`;
    } else {
      // Downgrade — refund due
      hintEl.style.background = "#d1e7dd";
      hintEl.style.color = "#0f5132";
      hintEl.style.border = "1px solid #198754";
      hintEl.textContent = `Same-day downgrade: ₹${Math.abs(diff)} refund due (₹${oldPrice} → ₹${newPrice})`;
    }
    hintEl.style.display = "block";
  }

  // Set up destination room change handler
  // Use .onchange (single-slot) to prevent duplicate handlers from stacking
  // across repeated modal opens — this was the cause of the intermittent
  // AC-toggle-missing bug.
  destRoomSelect.onchange = function () {
    const destRoom = destRoomSelect.value;
    const sourceRoom = sourceRoomSelect.value;

    // Hide hint when selection is cleared
    const hintEl = document.getElementById("transfer-balance-hint");
    if (!destRoom || !sourceRoom) {
      if (roomPriceSection) roomPriceSection.style.display = "none";
      if (acToggleSection) acToggleSection.style.display = "none";
      if (hintEl) hintEl.style.display = "none";
      return;
    }

    // Calculate suggested room price based on destination room
    const guestCount = rooms[sourceRoom].guest.guests || 1;
    // calculatePrice() returns the NON-AC base (matches check-in modal logic):
    //   rooms 200-207: 1200 base, +600 if AC enabled = 1800
    const basePrice = roomPricing.calculatePrice(destRoom, guestCount);
    const acPrice   = basePrice + 600;

    // Show AC toggle for premium AC rooms (202-205) BEFORE setting price.
    // Coerce to number — destRoom is a <select> value (string) and
    // lexical comparison is brittle for anything outside 3-digit rooms.
    if (acToggleSection && newRoomAcToggle) {
      const destNum = parseInt(destRoom, 10);
      if (destNum >= 202 && destNum <= 205) {
        // Default: non-AC (toggle unchecked), price = basePrice
        newRoomAcToggle.checked = false;
        acToggleSection.style.display = "block";

        // AC ON → base + 600; AC OFF → base (same logic as check-in modal).
        // .onchange replaces any prior closure so stale basePrice/acPrice
        // values from a previous destination selection can't leak through.
        newRoomAcToggle.onchange = function () {
          const price = newRoomAcToggle.checked ? acPrice : basePrice;
          if (newRoomPriceInput) {
            newRoomPriceInput.value = price;
          }
          updateTransferBalanceHint(sourceRoom, price);
        };
      } else {
        acToggleSection.style.display = "none";
        // Clear any handler from a prior AC-room selection so it can't
        // fire against the wrong destination later.
        newRoomAcToggle.onchange = null;
      }
    }

    // Initial price shown: basePrice (non-AC) for AC rooms since toggle starts off
    const suggestedPrice = basePrice;

    // Show room price section
    if (roomPriceSection && newRoomPriceInput) {
      newRoomPriceInput.value = suggestedPrice;
      roomPriceSection.style.display = "block";
    }

    // Show balance/refund hint for same-cycle transfers
    updateTransferBalanceHint(sourceRoom, suggestedPrice);
  };

  // Set up form submission
  const quickTransferForm = document.getElementById("quick-transfer-form");
  if (quickTransferForm) {
    quickTransferForm.onsubmit = function (e) {
      e.preventDefault();

      const oldRoom = sourceRoomSelect.value;
      const newRoom = destRoomSelect.value;
      const newPrice = newRoomPriceInput
        ? parseInt(newRoomPriceInput.value)
        : null;
      const isAC = newRoomAcToggle ? newRoomAcToggle.checked : false;

      if (!oldRoom || !newRoom) {
        showNotification(
          "Please select both source and destination rooms",
          "error"
        );
        return;
      }

      if (newPrice && newPrice <= 0) {
        showNotification("Please enter a valid room price", "error");
        return;
      }

      processEnhancedRoomTransfer(
        oldRoom,
        newRoom,
        newPrice,
        isAC,
        quickTransferModal
      );
    };
  }

  // Show the modal
  quickTransferModal.classList.add("show");
}

// Enhanced room transfer process
async function processEnhancedRoomTransfer(
  oldRoom,
  newRoom,
  newPrice = null,
  isAC = false,
  modalElement = null
) {
  console.log(
    `Processing enhanced room transfer from ${oldRoom} to ${newRoom}`
  );

  if (!oldRoom) {
    console.error("Source room not specified");
    showNotification("Error: Source room not specified", "error");
    return;
  }

  if (!newRoom) {
    showNotification("Please select a destination room", "error");
    return;
  }

  try {
    // Disable the submit button
    const submitBtn = modalElement
      ? modalElement.querySelector("button[type=submit]")
      : document.querySelector("#transfer-room-form button[type=submit]");

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML =
        '<span class="loader" style="width: 20px; height: 20px;"></span> Processing...';
    }

    // Prepare transfer data
    const transferData = {
      old_room: String(oldRoom),
      new_room: String(newRoom),
    };

    // Add new price if provided
    if (newPrice) {
      transferData.new_price = newPrice;
    }

    // Add AC status for premium rooms
    if (newRoom >= 202 && newRoom <= 205) {
      transferData.is_ac = isAC;
    }

    console.log("Sending enhanced transfer request:", transferData);

    const response = await apiFetch("/transfer_room", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(transferData),
    });

    console.log("Server response status:", response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Response error:", errorText);
      throw new Error(`Server error: ${response.status}`);
    }

    const result = await response.json();
    console.log("Response data:", result);

    if (result.success) {
      // Close the modal
      if (modalElement) {
        modalElement.classList.remove("show");
      } else {
        const transferRoomModal = document.getElementById(
          "transfer-room-modal"
        );
        if (transferRoomModal) {
          transferRoomModal.classList.remove("show");
        }

        const checkoutModal = document.getElementById("checkout-modal");
        if (checkoutModal) {
          checkoutModal.classList.remove("show");
        }
      }

      // Refresh data in background (modals already closed above)
      debouncedFetchData();

      let successMessage = `Guest transferred from Room ${oldRoom} to Room ${newRoom}`;
      if (newPrice) {
        successMessage += ` (Price updated to ₹${newPrice})`;
      }
      if (newRoom >= 202 && newRoom <= 205) {
        successMessage += isAC ? " (AC)" : " (Non-AC)";
      }
      // Show balance/refund notice after same-cycle transfer
      const adj = result.balance_adjustment || 0;
      if (adj > 0) {
        successMessage += `. Balance due: ₹${adj}`;
      } else if (adj < 0) {
        successMessage += `. Refund due: ₹${Math.abs(adj)}`;
      }

      showNotification(successMessage, "success");
    } else {
      showNotification(result.message || "Error transferring room", "error");
    }
  } catch (error) {
    console.error("Error transferring room:", error);
    showNotification(`Error: ${error.message}`, "error");
  } finally {
    // Re-enable the submit button
    const submitBtn = modalElement
      ? modalElement.querySelector("button[type=submit]")
      : document.querySelector("#transfer-room-form button[type=submit]");

    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = "Transfer Room";
    }
  }
}

// Backward compatibility - update the original function
async function processRoomTransfer(oldRoom, newRoom, modalElement = null) {
  return processEnhancedRoomTransfer(
    oldRoom,
    newRoom,
    null,
    false,
    modalElement
  );
}

// Initialize the quick transfer button
document.addEventListener("DOMContentLoaded", function () {
  setTimeout(initQuickTransferButton, 1000);
});

// Also initialize after fetchData
const originalFetchData = window.fetchData;
if (typeof originalFetchData === "function") {
  window.fetchData = async function () {
    const result = await originalFetchData.apply(this, arguments);
    setTimeout(initQuickTransferButton, 300);
    return result;
  };
}
