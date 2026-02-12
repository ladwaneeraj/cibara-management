/**
 * Firebase Real-time Sync Engine
 * This script listens for changes in Firestore and updates the UI immediately.
 */

// We assume firebase is initialized in your environment
// or we use the existing endpoints via a "Long Polling" emulation
// Since your current setup is Flask-heavy, we will use a 'Change Detection' stream.

const RealTimeEngine = {
  lastEtag: null,

  init() {
    console.log("🚀 Real-time Engine Started");
    this.establishListener();
  },

  async establishListener() {
    // We poll frequently (every 5 seconds) but ONLY update the UI
    // if the data hash has actually changed.
    setInterval(async () => {
      try {
        // Fetch only the totals first (lightweight check)
        const response = await fetch("/get_totals_only");
        const data = await response.json();

        // Stringify the data to create a simple 'fingerprint'
        const currentFingerprint = JSON.stringify(data.totals);

        if (this.lastEtag !== currentFingerprint) {
          console.log("🔄 Change detected in DB! Refreshing screens...");
          this.lastEtag = currentFingerprint;
          this.triggerUIUpdate();
        }
      } catch (e) {
        console.error("Connection lost to DB stream", e);
      }
    }, 5000); // 5-second check is very safe for Firebase quotas
  },

  triggerUIUpdate() {
    // This calls your existing refresh logic in script.js
    if (typeof window.fetchRooms === "function") {
      window.fetchRooms();
    }

    // Visual notification for the user
    this.showToast("Data Updated from Server");
  },

  showToast(msg) {
    const toast = document.createElement("div");
    toast.style = `
            position: fixed; bottom: 80px; left: 50%; 
            transform: translateX(-50%); background: #333; 
            color: #fff; padding: 8px 16px; border-radius: 20px;
            font-size: 12px; z-index: 9999; opacity: 0.8;
        `;
    toast.innerText = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  },
};

document.addEventListener("DOMContentLoaded", () => RealTimeEngine.init());
