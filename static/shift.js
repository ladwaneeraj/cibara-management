// Enhanced Quick Room Transfer Functionality

// Resolve a room's rate-slab category via the canonical roomPricing map
// (defined in script.js). Returns the category string, or null if the helper
// isn't loaded yet — callers treat null as "can't determine, don't block".
function _roomCategoryOf(roomNumber) {
  if (
    typeof roomPricing === "undefined" ||
    typeof roomPricing.getRoomCategory !== "function"
  ) {
    return null;
  }
  try {
    return roomPricing.getRoomCategory(roomNumber).category;
  } catch (e) {
    return null;
  }
}

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

  // Populate source room dropdown.
  // Eligibility rule for quick transfer:
  //   1. Room must be occupied.
  //
  // NOTE: the previous 24-hour "early-stay only" window has been removed at
  // the operator's request, so long-staying guests (staying many days) can be
  // transferred from here too. This is safe: the backend /transfer_room
  // snapshots pre-transfer charges and carries a transfer_day_offset, so a
  // multi-day stay is billed correctly across the move and the tariff is
  // never re-rated on transfer.
  sourceRoomSelect.innerHTML = '<option value="">Select source room</option>';
  let occupiedRoomCount = 0;

  Object.entries(rooms).forEach(([roomNum, info]) => {
    if (info.status !== "occupied") return;

    const option = document.createElement("option");
    option.value = roomNum;
    option.textContent = `Room ${roomNum} - ${info.guest.name}`;
    sourceRoomSelect.appendChild(option);
    occupiedRoomCount++;
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

    // Populate destination room dropdown — only VACANT rooms in the SAME
    // category as the source room. A transfer must not change the room's rate
    // slab; otherwise the stay's billing shifts mid-stay (refund/excess). Genuine
    // upgrades/downgrades are a different operation (check out + fresh check-in).
    destRoomSelect.innerHTML =
      '<option value="">Select destination room</option>';
    destRoomSelect.disabled = false;

    const _srcCat = _roomCategoryOf(selectedRoom);

    let vacantRoomCount = 0;

    Object.entries(rooms).forEach(([roomNum, info]) => {
      if (roomNum === selectedRoom || info.status !== "vacant") return;
      // Same-category gate. If the category helper isn't available (load order),
      // fall back to allowing all vacant rooms rather than blocking transfers.
      if (_srcCat !== null && _roomCategoryOf(roomNum) !== _srcCat) return;

      const option = document.createElement("option");
      option.value = roomNum;
      option.textContent = `Room ${roomNum}`;
      destRoomSelect.appendChild(option);
      vacantRoomCount++;
    });

    if (vacantRoomCount === 0) {
      const option = document.createElement("option");
      option.disabled = true;
      option.textContent = "No vacant rooms in the same category";
      destRoomSelect.appendChild(option);
      destRoomSelect.disabled = true;

      showNotification(
        "No vacant rooms available in the same category for transfer",
        "warning",
      );
    }
  };

  // Helper — show upgrade/downgrade balance hint for same-24hr-cycle transfers
  function updateTransferBalanceHint(sourceRoom, newPrice) {
    const hintEl = document.getElementById("transfer-balance-hint");
    if (!hintEl) return;

    const roomData = rooms[sourceRoom];
    if (!roomData) { hintEl.style.display = "none"; return; }

    // MMT / OTA stays are prepaid and settled with the OTA later — the guest is
    // never charged or refunded at the desk for a room change, so don't show an
    // upgrade-balance / downgrade-refund hint for them.
    if (roomData.guest && roomData.guest.payment === "ota") {
      hintEl.style.display = "none";
      return;
    }

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
    // A transfer never changes the tariff — the guest's existing price carries
    // over to the new room. There is therefore no editable price field, AC
    // toggle, or upgrade/refund hint to show; keep them all hidden.
    if (roomPriceSection) roomPriceSection.style.display = "none";
    if (acToggleSection) acToggleSection.style.display = "none";
    const hintEl = document.getElementById("transfer-balance-hint");
    if (hintEl) hintEl.style.display = "none";
    if (newRoomAcToggle) newRoomAcToggle.onchange = null;
  };

  // Set up form submission
  const quickTransferForm = document.getElementById("quick-transfer-form");
  if (quickTransferForm) {
    quickTransferForm.onsubmit = function (e) {
      e.preventDefault();

      const oldRoom = sourceRoomSelect.value;
      const newRoom = destRoomSelect.value;

      if (!oldRoom || !newRoom) {
        showNotification(
          "Please select both source and destination rooms",
          "error"
        );
        return;
      }

      // Same-category guard at submit time (defends against a stale dropdown
      // left open before this rule shipped, or manual DOM tampering).
      const _oldCat = _roomCategoryOf(oldRoom);
      const _newCat = _roomCategoryOf(newRoom);
      if (_oldCat !== null && _newCat !== null && _oldCat !== _newCat) {
        showNotification(
          "Room transfer is allowed only within the same room category.",
          "error",
        );
        return;
      }

      // (24-hour quick-transfer window removed — long-staying guests can be
      // transferred via the quick path too. The backend bills multi-day stays
      // correctly across the move.)

      // Price/AC are never changed by a transfer — the server carries the
      // guest's existing tariff over, so we send no new price or AC flag.
      processEnhancedRoomTransfer(
        oldRoom,
        newRoom,
        null,
        false,
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

    // Add AC status for premium rooms (200-206 — matches the modal toggle
    // visibility above and the room-card AC indicator).
    const _newRoomNum = parseInt(newRoom, 10);
    if (_newRoomNum >= 200 && _newRoomNum <= 206) {
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
      const _successRoomNum = parseInt(newRoom, 10);
      if (_successRoomNum >= 200 && _successRoomNum <= 206) {
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
// end of shift.js
