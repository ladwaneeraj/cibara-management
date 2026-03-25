// Room Cleaning Status Management with Quality Check

// Initialize cleaning feature on page load
function initializeCleaningFeature() {
  console.log("Cleaning feature initialized");
  createQualityCheckModals();
}

// Create quality check modals (only created once)
function createQualityCheckModals() {
  // Premium room modal (3 items for 200-206)
  createPremiumCheckModal();
  // Standard room modal (3 items for 207-228)
  createStandardCheckModal();
  // Regular room modal (1 item for others)
  createRegularCheckModal();
}

// Create premium room quality check modal (3 items for rooms 200-206)
function createPremiumCheckModal() {
  if (document.getElementById("premium-check-modal")) {
    return;
  }

  const modalHTML = `
    <div class="modal-backdrop" id="premium-check-modal">
      <div class="modal-content" style="max-width: 400px;">
        <div class="modal-header" style="padding: 1rem 1.5rem;">
          <h2 style="font-size: 1.1rem;">Room <span id="premium-room-number"></span> - Quality Check</h2>
          <button class="close-btn" aria-label="Close">&times;</button>
        </div>
        <div class="modal-body" style="padding: 1rem 1.5rem;">
          <div class="quality-checklist">
            <label class="quality-check-item compact">
              <input type="checkbox" class="quality-checkbox premium-checkbox">
              <span class="checkmark"></span>
              <span class="check-label">🚿 Washroom is clean</span>
            </label>
            
            <label class="quality-check-item compact">
              <input type="checkbox" class="quality-checkbox premium-checkbox">
              <span class="checkmark"></span>
              <span class="check-label">☕ Coffee maker ready</span>
            </label>
            
            <label class="quality-check-item compact">
              <input type="checkbox" class="quality-checkbox premium-checkbox">
              <span class="checkmark"></span>
              <span class="check-label">🧺 Towels placed (3 sets)</span>
            </label>
          </div>
        </div>
        <div class="modal-footer" style="padding: 1rem 1.5rem; gap: 0.5rem;">
          <button class="premium-cancel-btn action-btn btn-secondary" style="flex: 1;">
            Cancel
          </button>
          <button id="premium-approve-btn" class="action-btn btn-success" style="flex: 1;" disabled>
            Mark as Clean ✓
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML("beforeend", modalHTML);
  setupPremiumModalListeners();
}

// Create standard room quality check modal (3 items for rooms 207-228)
function createStandardCheckModal() {
  if (document.getElementById("standard-check-modal")) {
    return;
  }

  const modalHTML = `
    <div class="modal-backdrop" id="standard-check-modal">
      <div class="modal-content" style="max-width: 400px;">
        <div class="modal-header" style="padding: 1rem 1.5rem;">
          <h2 style="font-size: 1.1rem;">Room <span id="standard-room-number"></span> - Quality Check</h2>
          <button class="close-btn" aria-label="Close">&times;</button>
        </div>
        <div class="modal-body" style="padding: 1rem 1.5rem;">
          <div class="quality-checklist">
            <label class="quality-check-item compact">
              <input type="checkbox" class="quality-checkbox standard-checkbox">
              <span class="checkmark"></span>
              <span class="check-label">🚿 Washroom is clean</span>
            </label>
            
            <label class="quality-check-item compact">
              <input type="checkbox" class="quality-checkbox standard-checkbox">
              <span class="checkmark"></span>
              <span class="check-label">🗑️ Dustbin cleaned</span>
            </label>
            
            <label class="quality-check-item compact">
              <input type="checkbox" class="quality-checkbox standard-checkbox">
              <span class="checkmark"></span>
              <span class="check-label">🧺 Towels placed</span>
            </label>
          </div>
        </div>
        <div class="modal-footer" style="padding: 1rem 1.5rem; gap: 0.5rem;">
          <button class="standard-cancel-btn action-btn btn-secondary" style="flex: 1;">
            Cancel
          </button>
          <button id="standard-approve-btn" class="action-btn btn-success" style="flex: 1;" disabled>
            Mark as Clean ✓
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML("beforeend", modalHTML);
  setupStandardModalListeners();
}

// Create regular room quick check modal (1 item for other rooms)
function createRegularCheckModal() {
  if (document.getElementById("regular-check-modal")) {
    return;
  }

  const modalHTML = `
    <div class="modal-backdrop" id="regular-check-modal">
      <div class="modal-content" style="max-width: 380px;">
        <div class="modal-header" style="padding: 1rem 1.5rem;">
          <h2 style="font-size: 1.1rem;">Room <span id="regular-room-number"></span> - Quick Check</h2>
          <button class="close-btn" aria-label="Close">&times;</button>
        </div>
        <div class="modal-body" style="padding: 1rem 1.5rem;">
          <div class="quality-checklist">
            <label class="quality-check-item compact">
              <input type="checkbox" id="regular-checkbox" class="quality-checkbox">
              <span class="checkmark"></span>
              <span class="check-label">✨ Room is cleaned and ready</span>
            </label>
          </div>
        </div>
        <div class="modal-footer" style="padding: 1rem 1.5rem; gap: 0.5rem;">
          <button class="regular-cancel-btn action-btn btn-secondary" style="flex: 1;">
            Cancel
          </button>
          <button id="regular-approve-btn" class="action-btn btn-success" style="flex: 1;" disabled>
            Mark as Clean ✓
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML("beforeend", modalHTML);
  setupRegularModalListeners();
}

// Add CSS for compact quality check modals
function addQualityCheckStyles() {
  if (document.getElementById("quality-check-styles")) {
    return;
  }

  const style = document.createElement("style");
  style.id = "quality-check-styles";
  style.textContent = `
    .quality-checklist {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    
    .quality-check-item {
      display: flex;
      align-items: center;
      padding: 0.75rem 1rem;
      border: 2px solid #e0e0e0;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s ease;
      position: relative;
    }
    
    .quality-check-item.compact {
      padding: 0.6rem 0.85rem;
    }
    
    .quality-check-item:hover {
      border-color: var(--primary);
      background-color: #f8f9fa;
    }
    
    .quality-check-item input[type="checkbox"] {
      position: absolute;
      opacity: 0;
      cursor: pointer;
    }
    
    .quality-check-item .checkmark {
      width: 22px;
      height: 22px;
      border: 2px solid #ccc;
      border-radius: 4px;
      margin-right: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: all 0.2s ease;
    }
    
    .quality-check-item input[type="checkbox"]:checked ~ .checkmark {
      background-color: var(--success);
      border-color: var(--success);
    }
    
    .quality-check-item input[type="checkbox"]:checked ~ .checkmark:after {
      content: "✓";
      color: white;
      font-size: 14px;
      font-weight: bold;
    }
    
    .quality-check-item input[type="checkbox"]:checked ~ .check-label {
      color: var(--success);
      font-weight: 500;
    }
    
    .check-label {
      font-size: 0.95rem;
      color: var(--text);
      transition: all 0.2s ease;
    }
    
    #premium-approve-btn:disabled,
    #regular-approve-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      background-color: #ccc;
    }
    
    #premium-approve-btn:not(:disabled),
    #regular-approve-btn:not(:disabled) {
      background-color: var(--success);
    }
    
    #premium-approve-btn:not(:disabled):hover,
    #regular-approve-btn:not(:disabled):hover {
      background-color: #27ae60;
    }
  `;
  document.head.appendChild(style);
}

// Setup premium modal listeners
function setupPremiumModalListeners() {
  const modal = document.getElementById("premium-check-modal");
  const closeBtn = modal.querySelector(".close-btn");
  const cancelBtn = modal.querySelector(".premium-cancel-btn");
  const approveBtn = document.getElementById("premium-approve-btn");
  const checkboxes = modal.querySelectorAll(".premium-checkbox");

  // Close modal handlers
  const closeModal = () => {
    modal.classList.remove("show");
    resetPremiumModal();
  };

  closeBtn.addEventListener("click", closeModal);
  cancelBtn.addEventListener("click", closeModal);

  // Update button state when checkboxes change
  checkboxes.forEach((checkbox) => {
    checkbox.addEventListener("change", updatePremiumButton);
  });

  // Approve button click
  approveBtn.addEventListener("click", async () => {
    const roomNumber = document.getElementById(
      "premium-room-number",
    ).textContent;
    await completeRoomCleaning(roomNumber);
  });
}

// Setup standard modal listeners
function setupStandardModalListeners() {
  const modal = document.getElementById("standard-check-modal");
  const closeBtn = modal.querySelector(".close-btn");
  const cancelBtn = modal.querySelector(".standard-cancel-btn");
  const approveBtn = document.getElementById("standard-approve-btn");
  const checkboxes = modal.querySelectorAll(".standard-checkbox");

  // Close modal handlers
  const closeModal = () => {
    modal.classList.remove("show");
    resetStandardModal();
  };

  closeBtn.addEventListener("click", closeModal);
  cancelBtn.addEventListener("click", closeModal);

  // Update button state when checkboxes change
  checkboxes.forEach((checkbox) => {
    checkbox.addEventListener("change", updateStandardButton);
  });

  // Approve button click
  approveBtn.addEventListener("click", async () => {
    const roomNumber = document.getElementById(
      "standard-room-number",
    ).textContent;
    await completeRoomCleaning(roomNumber);
  });
}

// Setup regular modal listeners
function setupRegularModalListeners() {
  const modal = document.getElementById("regular-check-modal");
  const closeBtn = modal.querySelector(".close-btn");
  const cancelBtn = modal.querySelector(".regular-cancel-btn");
  const approveBtn = document.getElementById("regular-approve-btn");
  const checkbox = document.getElementById("regular-checkbox");

  // Close modal handlers
  const closeModal = () => {
    modal.classList.remove("show");
    resetRegularModal();
  };

  closeBtn.addEventListener("click", closeModal);
  cancelBtn.addEventListener("click", closeModal);

  // Update button state when checkbox changes
  checkbox.addEventListener("change", updateRegularButton);

  // Approve button click
  approveBtn.addEventListener("click", async () => {
    const roomNumber = document.getElementById(
      "regular-room-number",
    ).textContent;
    await completeRoomCleaning(roomNumber);
  });
}

// Update premium modal button state
function updatePremiumButton() {
  const checkboxes = document.querySelectorAll(".premium-checkbox");
  const checkedCount = Array.from(checkboxes).filter((cb) => cb.checked).length;
  const approveBtn = document.getElementById("premium-approve-btn");

  if (approveBtn) {
    approveBtn.disabled = checkedCount !== checkboxes.length;
  }
}

// Update standard modal button state
function updateStandardButton() {
  const checkboxes = document.querySelectorAll(".standard-checkbox");
  const checkedCount = Array.from(checkboxes).filter((cb) => cb.checked).length;
  const approveBtn = document.getElementById("standard-approve-btn");

  if (approveBtn) {
    approveBtn.disabled = checkedCount !== checkboxes.length;
  }
}

// Update regular modal button state
function updateRegularButton() {
  const checkbox = document.getElementById("regular-checkbox");
  const approveBtn = document.getElementById("regular-approve-btn");

  if (approveBtn && checkbox) {
    approveBtn.disabled = !checkbox.checked;
  }
}

// Reset premium modal
function resetPremiumModal() {
  const checkboxes = document.querySelectorAll(".premium-checkbox");
  checkboxes.forEach((cb) => {
    cb.checked = false;
  });
  updatePremiumButton();
}

// Reset standard modal
function resetStandardModal() {
  const checkboxes = document.querySelectorAll(".standard-checkbox");
  checkboxes.forEach((cb) => {
    cb.checked = false;
  });
  updateStandardButton();
}

// Reset regular modal
function resetRegularModal() {
  const checkbox = document.getElementById("regular-checkbox");
  if (checkbox) {
    checkbox.checked = false;
  }
  updateRegularButton();
}

// Show premium quality check modal
function showPremiumCheckModal(roomNumber) {
  addQualityCheckStyles();
  const modal = document.getElementById("premium-check-modal");
  const roomNumberSpan = document.getElementById("premium-room-number");

  if (!modal || !roomNumberSpan) {
    console.error("Premium check modal elements not found");
    return;
  }

  roomNumberSpan.textContent = roomNumber;
  resetPremiumModal();
  modal.classList.add("show");
}

// Show standard quality check modal
function showStandardCheckModal(roomNumber) {
  addQualityCheckStyles();
  const modal = document.getElementById("standard-check-modal");
  const roomNumberSpan = document.getElementById("standard-room-number");

  if (!modal || !roomNumberSpan) {
    console.error("Standard check modal elements not found");
    return;
  }

  roomNumberSpan.textContent = roomNumber;
  resetStandardModal();
  modal.classList.add("show");
}

// Show regular quick check modal
function showRegularCheckModal(roomNumber) {
  addQualityCheckStyles();
  const modal = document.getElementById("regular-check-modal");
  const roomNumberSpan = document.getElementById("regular-room-number");

  if (!modal || !roomNumberSpan) {
    console.error("Regular check modal elements not found");
    return;
  }

  roomNumberSpan.textContent = roomNumber;
  resetRegularModal();
  modal.classList.add("show");
}

// Check if room is premium (requires quality check)
function isPremiumRoom(roomNumber) {
  const num = parseInt(roomNumber);
  return num >= 200 && num <= 206;
}

// Check if room is standard (requires 3-item check)
function isStandardRoom(roomNumber) {
  const num = parseInt(roomNumber);
  return num >= 207 && num <= 228;
}

// Mark room as cleaned - shows appropriate modal based on room type
async function markRoomAsCleaned(roomNumber) {
  try {
    const roomInfo = rooms[roomNumber];
    if (!roomInfo) {
      showNotification("Room not found", "error");
      return false;
    }

    // Verify room is in cleaning status before marking as cleaned
    if (roomInfo.status !== "cleaning") {
      showNotification("This room is not in cleaning status", "error");
      return false;
    }

    // For premium rooms (200-206), show 3-item quality check modal
    if (isPremiumRoom(roomNumber)) {
      showPremiumCheckModal(roomNumber);
      return false; // Don't mark as cleaned yet, wait for quality check
    }

    // For standard rooms (207-228), show 3-item standard check modal
    if (isStandardRoom(roomNumber)) {
      showStandardCheckModal(roomNumber);
      return false; // Don't mark as cleaned yet, wait for quality check
    }

    // For regular rooms, show 1-item quick check modal
    showRegularCheckModal(roomNumber);
    return false; // Don't mark as cleaned yet, wait for confirmation
  } catch (error) {
    console.error("Error marking room as cleaned:", error);
    showNotification("Error marking room as cleaned", "error");
    return false;
  }
}

// Complete room cleaning (called after quality check confirmation)
async function completeRoomCleaning(roomNumber) {
  try {
    // Send request to backend to mark as cleaned
    const response = await apiFetch("/mark_room_cleaned", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        room: roomNumber,
      }),
    });

    if (!response.ok) {
      throw new Error(`Server responded with status: ${response.status}`);
    }

    const result = await response.json();
    if (result.success) {
      // Update local room data
      const roomInfo = rooms[roomNumber];
      if (roomInfo) {
        roomInfo.status = "vacant";
        roomInfo.cleaning_status = null;
        roomInfo.cleaning_start_time = null;
      }

      // Close all modals if they're open
      const premiumModal = document.getElementById("premium-check-modal");
      const standardModal = document.getElementById("standard-check-modal");
      const regularModal = document.getElementById("regular-check-modal");

      if (premiumModal) {
        premiumModal.classList.remove("show");
      }
      if (standardModal) {
        standardModal.classList.remove("show");
      }
      if (regularModal) {
        regularModal.classList.remove("show");
      }

      showNotification(`Room ${roomNumber} is ready for check-in`, "success");

      // Refresh the rooms display
      renderRooms();

      console.log(`Room ${roomNumber} marked as cleaned successfully`);
      return true;
    } else {
      showNotification(
        result.message || "Error marking room as cleaned",
        "error",
      );
      return false;
    }
  } catch (error) {
    console.error("Error completing room cleaning:", error);
    showNotification("Error marking room as cleaned", "error");
    return false;
  }
}

// Check if room is in cleaning status
function isRoomCleaning(roomNumber) {
  const roomInfo = rooms[roomNumber];
  return roomInfo && roomInfo.status === "cleaning";
}

// Get cleaning time for display
function getCleaningTime(roomNumber) {
  const roomInfo = rooms[roomNumber];
  if (!roomInfo || !roomInfo.cleaning_start_time) {
    return "0m";
  }

  try {
    const startTime = new Date(roomInfo.cleaning_start_time);
    const now = new Date();
    const diffMs = now - startTime;
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 60) {
      return `${diffMins}m`;
    }
    const hours = Math.floor(diffMins / 60);
    const mins = diffMins % 60;
    return `${hours}h ${mins}m`;
  } catch (e) {
    return "0m";
  }
}
