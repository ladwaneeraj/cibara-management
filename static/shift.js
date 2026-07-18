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

// True when the signed-in user may re-rate a stay (cross-category shift).
// Managers hold only "room.transfer" (same-category moves); the
// cross-category permission comes via the admin wildcard. Fails CLOSED if
// the auth helper isn't loaded yet — the server enforces the same rule.
function _canCrossCategoryShift() {
  return !!(
    window.CibaraAuth &&
    typeof window.CibaraAuth.userCan === "function" &&
    window.CibaraAuth.userCan("room.transfer.cross_category")
  );
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
  const diffSection = document.getElementById("transfer-diff-section");
  const applyDiffToggle = document.getElementById("transfer-apply-diff");

  if (!sourceRoomSelect || !destRoomSelect) {
    console.error("Quick transfer form elements not found");
    return;
  }

  // Reset the form
  quickGuestInfo.style.display = "none";
  quickBalanceInfo.style.display = "none";
  if (roomPriceSection) roomPriceSection.style.display = "none";
  if (acToggleSection) acToggleSection.style.display = "none";
  if (diffSection) diffSection.style.display = "none";
  if (applyDiffToggle) applyDiffToggle.checked = true;

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
      if (diffSection) diffSection.style.display = "none";
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

    // Populate destination room dropdown — ALL vacant rooms.
    //   Same category  → physical move, tariff carries over (legacy).
    //   Cross category → the stay is re-rated from the shift day; the server
    //                    bills prior nights at the old rate via the folio
    //                    segments, so billing stays exact.
    // Party hall / unmapped rooms have no standard tariff and are excluded
    // as cross-category destinations.
    destRoomSelect.innerHTML =
      '<option value="">Select destination room</option>';
    destRoomSelect.disabled = false;

    const _srcCat = _roomCategoryOf(selectedRoom);
    const _allowCross = _canCrossCategoryShift();

    let vacantRoomCount = 0;

    Object.entries(rooms).forEach(([roomNum, info]) => {
      if (roomNum === selectedRoom || info.status !== "vacant") return;
      const _cat = _roomCategoryOf(roomNum);
      const _isCross = _srcCat !== null && _cat !== null && _cat !== _srcCat;
      // Cross-category (upgrade/downgrade) is admin-only.
      if (_isCross && !_allowCross) return;
      if (_isCross && (_cat === "party-hall" || _cat === "other")) return;

      const option = document.createElement("option");
      option.value = roomNum;
      let _label = `Room ${roomNum}`;
      if (_cat !== null && typeof roomPricing !== "undefined") {
        const _catLabel =
          (roomPricing.CATEGORY_LABELS && roomPricing.CATEGORY_LABELS[_cat]) ||
          _cat;
        _label += ` — ${_catLabel}`;
        if (_isCross) _label += " ▲ category change";
      }
      option.textContent = _label;
      destRoomSelect.appendChild(option);
      vacantRoomCount++;
    });

    if (vacantRoomCount === 0) {
      const option = document.createElement("option");
      option.disabled = true;
      option.textContent = _allowCross
        ? "No vacant rooms available"
        : "No vacant rooms in the same category";
      destRoomSelect.appendChild(option);
      destRoomSelect.disabled = true;

      showNotification(
        _allowCross
          ? "No vacant rooms available for transfer"
          : "No vacant same-category rooms (category changes need admin)",
        "warning",
      );
    }
  };

  // Standard per-night tariff for a destination room, honoring the AC
  // toggle. Mirrors config.room_base_price + AC_SURCHARGE on the server
  // (the server remains authoritative and re-validates on submit).
  function _standardShiftPrice(destRoom, guestCount, acOn) {
    if (
      typeof roomPricing === "undefined" ||
      typeof roomPricing.calculatePrice !== "function"
    ) {
      return null;
    }
    let p = roomPricing.calculatePrice(destRoom, guestCount || 1);
    const n = parseInt(destRoom, 10);
    if (acOn && n >= 200 && n <= 206) p += 600; // AC_SURCHARGE
    return p;
  }

  // Cross-category rate hint — explains the nightly rate change and the
  // shift-day balance effect. The server applies the actual adjustment.
  function _updateCrossShiftHint(sourceRoom) {
    const hintEl = document.getElementById("transfer-balance-hint");
    if (!hintEl) return;
    const roomData = rooms[sourceRoom];
    const guest = (roomData && roomData.guest) || {};
    const oldPrice = guest.price || 0;
    const newPrice = parseInt(newRoomPriceInput && newRoomPriceInput.value, 10) || 0;
    if (!newPrice) { hintEl.style.display = "none"; return; }
    const diff = newPrice - oldPrice;

    const applyDiff = !applyDiffToggle || applyDiffToggle.checked;

    // Has today's rent already been charged? (day 1 is charged at check-in;
    // later days via the daily renew click). Mirrors the server's
    // over-accrued check — server stays authoritative.
    let todayCharged = true;
    try {
      const _ci = new Date(String(roomData.checkin_time || "").replace(" ", "T"));
      const _completed = Math.floor((Date.now() - _ci.getTime()) / 86400000);
      const _rc = Number(roomData.renewal_count || 0);
      todayCharged = _rc + 1 > _completed;
    } catch (e) { /* keep default */ }

    if (diff === 0) {
      hintEl.style.background = "#e9ecef";
      hintEl.style.color = "#41464b";
      hintEl.style.border = "1px solid #ced4da";
      hintEl.textContent = `Same rate (₹${oldPrice}/night) — nothing changes.`;
    } else if (!applyDiff) {
      hintEl.style.background = "#e9ecef";
      hintEl.style.color = "#41464b";
      hintEl.style.border = "1px solid #ced4da";
      hintEl.textContent =
        `Today keeps the old rate (₹${oldPrice}). ` +
        `₹${newPrice}/night starts from the next rent.`;
    } else if (diff > 0) {
      hintEl.style.background = "#fff3cd";
      hintEl.style.color = "#856404";
      hintEl.style.border = "1px solid #ffc107";
      hintEl.textContent = todayCharged
        ? `₹${diff} will be added to the balance. New rate ₹${newPrice}/night from today.`
        : `New rate ₹${newPrice}/night from today (today's rent not charged yet).`;
    } else {
      hintEl.style.background = "#d1e7dd";
      hintEl.style.color = "#0f5132";
      hintEl.style.border = "1px solid #198754";
      hintEl.textContent = todayCharged
        ? `₹${Math.abs(diff)} refund will be shown. New rate ₹${newPrice}/night from today.`
        : `New rate ₹${newPrice}/night from today (today's rent not charged yet).`;
    }
    hintEl.style.display = "block";
  }

  // Set up destination room change handler
  // Use .onchange (single-slot) to prevent duplicate handlers from stacking
  // across repeated modal opens — this was the cause of the intermittent
  // AC-toggle-missing bug.
  destRoomSelect.onchange = function () {
    const srcRoom = sourceRoomSelect.value;
    const destRoom = destRoomSelect.value;
    const hintEl = document.getElementById("transfer-balance-hint");

    // Reset the enhanced controls on every change.
    if (roomPriceSection) roomPriceSection.style.display = "none";
    if (acToggleSection) acToggleSection.style.display = "none";
    if (diffSection) diffSection.style.display = "none";
    if (hintEl) hintEl.style.display = "none";
    if (newRoomAcToggle) {
      newRoomAcToggle.checked = false;
      newRoomAcToggle.onchange = null;
    }
    if (applyDiffToggle) {
      applyDiffToggle.checked = true;
      applyDiffToggle.onchange = null;
    }

    if (!srcRoom || !destRoom) return;

    const _srcCat = _roomCategoryOf(srcRoom);
    const _dstCat = _roomCategoryOf(destRoom);
    const isCross = _srcCat !== null && _dstCat !== null && _srcCat !== _dstCat;
    // Same category: tariff carries over unchanged — nothing to configure.
    if (!isCross) return;

    const guest = (rooms[srcRoom] && rooms[srcRoom].guest) || {};

    // OTA/MMT stays are prepaid — a room change never re-rates the tariff.
    if (guest.payment === "ota") {
      if (hintEl) {
        hintEl.style.background = "#cfe2ff";
        hintEl.style.color = "#084298";
        hintEl.style.border = "1px solid #9ec5fe";
        hintEl.textContent =
          "OTA/MMT stay — the room changes but the tariff stays as settled " +
          "with the OTA. No charge or refund at the desk.";
        hintEl.style.display = "block";
      }
      return;
    }

    const guestCount = parseInt(guest.guests, 10) || 1;
    const destNum = parseInt(destRoom, 10);
    const destIsPremium = destNum >= 200 && destNum <= 206;

    const refreshPrice = function () {
      const acOn = !!(
        destIsPremium && newRoomAcToggle && newRoomAcToggle.checked
      );
      const std = _standardShiftPrice(destRoom, guestCount, acOn);
      if (newRoomPriceInput && std !== null) newRoomPriceInput.value = std;
      _updateCrossShiftHint(srcRoom);
    };

    if (destIsPremium && acToggleSection) {
      acToggleSection.style.display = "block";
      if (newRoomAcToggle) newRoomAcToggle.onchange = refreshPrice;
    }
    if (roomPriceSection) {
      roomPriceSection.style.display = "block";
      if (newRoomPriceInput) {
        newRoomPriceInput.oninput = function () { _updateCrossShiftHint(srcRoom); };
      }
    }
    if (diffSection) {
      diffSection.style.display = "block";
      if (applyDiffToggle) {
        applyDiffToggle.checked = true;
        applyDiffToggle.onchange = function () { _updateCrossShiftHint(srcRoom); };
      }
    }
    refreshPrice();
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

      // (24-hour quick-transfer window removed — long-staying guests can be
      // transferred via the quick path too. The backend bills multi-day stays
      // correctly across the move.)

      // Same-category: tariff carries over — send no price/AC (server ignores
      // them anyway). Cross-category: send the (possibly edited) nightly
      // price and AC choice; the server validates and re-rates from today.
      const _oldCat = _roomCategoryOf(oldRoom);
      const _newCat = _roomCategoryOf(newRoom);
      const _isCross =
        _oldCat !== null && _newCat !== null && _oldCat !== _newCat;

      // Defense-in-depth: the dropdown never offers cross-category rooms
      // to non-admins, but guard against a stale dropdown / DOM tampering.
      // The server enforces the same rule with a 403.
      if (_isCross && !_canCrossCategoryShift()) {
        showNotification(
          "Category changes (upgrade/downgrade) need admin access. " +
            "You can shift only within the same room category.",
          "error",
        );
        return;
      }

      let _sendPrice = null;
      let _sendAc = false;
      let _sendApplyDiff = true;
      if (_isCross) {
        const _guest = (rooms[oldRoom] && rooms[oldRoom].guest) || {};
        if (_guest.payment !== "ota") {
          const _n = parseInt(newRoom, 10);
          _sendAc = !!(
            _n >= 200 && _n <= 206 &&
            newRoomAcToggle && newRoomAcToggle.checked
          );
          _sendApplyDiff = !applyDiffToggle || applyDiffToggle.checked;
          _sendPrice = parseInt(
            newRoomPriceInput && newRoomPriceInput.value, 10);
          if (!_sendPrice || _sendPrice < 1) {
            showNotification(
              "Enter a valid nightly price for the new room", "error");
            return;
          }
        }
      }

      processEnhancedRoomTransfer(
        oldRoom,
        newRoom,
        _sendPrice,
        _sendAc,
        quickTransferModal,
        _sendApplyDiff
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
  modalElement = null,
  applyTodayDiff = true
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

    // Whether today's rate difference is applied to the balance (cross-
    // category only; the server ignores it for same-category / OTA moves).
    transferData.apply_today_diff = !!applyTodayDiff;

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

      // The server message already describes any rate change; append the
      // balance effect so the desk knows what to collect / credit.
      let successMessage =
        result.message ||
        `Guest transferred from Room ${oldRoom} to Room ${newRoom}`;
      const adj = result.balance_adjustment || 0;
      if (adj > 0) {
        successMessage += ` Balance increased by ₹${adj} (collect at desk or checkout).`;
      } else if (adj < 0) {
        successMessage += ` Balance reduced by ₹${Math.abs(adj)}.`;
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
