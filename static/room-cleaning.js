// Room Cleaning Status Management

// Initialize cleaning feature on page load
function initializeCleaningFeature() {
  console.log("Cleaning feature initialized");
}

// Mark room as cleaned and make it available for check-in
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

    // Send request to backend to mark as cleaned
    const response = await fetch("/mark_room_cleaned", {
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
      roomInfo.status = "vacant";
      roomInfo.cleaning_status = null;
      roomInfo.cleaning_start_time = null;

      showNotification(`Room ${roomNumber} is ready for check-in`, "success");

      // Refresh the rooms display
      renderRooms();

      console.log(`Room ${roomNumber} marked as cleaned successfully`);
      return true;
    } else {
      showNotification(
        result.message || "Error marking room as cleaned",
        "error"
      );
      return false;
    }
  } catch (error) {
    console.error("Error marking room as cleaned:", error);
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
