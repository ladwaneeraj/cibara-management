// // ============================================
// // REAL-TIME SYNC ENGINE
// // ============================================
// // Simple, cheap solution for multi-device synchronization
// // Uses HTTP polling with smart caching and change detection

// const RealtimeSync = (function () {
//   // Configuration
//   const CONFIG = {
//     POLL_INTERVAL: 3000, // Poll every 3 seconds (cheap on server)
//     SMART_POLL_MULTIPLIER: 1.5, // Increase interval when no changes detected
//     MAX_POLL_INTERVAL: 15000, // Maximum poll interval (15 seconds)
//     MIN_POLL_INTERVAL: 3000, // Minimum poll interval (3 seconds)
//     RETRY_DELAY: 5000, // Retry delay on error
//     VISIBILITY_POLL_INTERVAL: 30000, // Slower polling when tab is hidden
//     MAX_CONSECUTIVE_NO_CHANGE: 5, // Speed up after this many no-change polls
//   };

//   // State
//   let pollInterval = null;
//   let currentInterval = CONFIG.POLL_INTERVAL;
//   let lastDataHash = null;
//   let consecutiveNoChanges = 0;
//   let isActive = true;
//   let isVisible = true;
//   let lastUpdateTime = Date.now();
//   let tabId = generateTabId();

//   // Stats for debugging
//   const stats = {
//     totalPolls: 0,
//     changesDetected: 0,
//     lastPollTime: null,
//     lastChangeTime: null,
//     currentInterval: CONFIG.POLL_INTERVAL,
//     errors: 0,
//   };

//   /**
//    * Generate unique tab ID
//    */
//   function generateTabId() {
//     return "tab_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9);
//   }

//   /**
//    * Generate a simple hash from data to detect changes
//    */
//   function generateHash(data) {
//     try {
//       const str = JSON.stringify(data);
//       let hash = 0;
//       for (let i = 0; i < str.length; i++) {
//         const char = str.charCodeAt(i);
//         hash = (hash << 5) - hash + char;
//         hash = hash & hash; // Convert to 32bit integer
//       }
//       return hash.toString();
//     } catch (error) {
//       console.error("[RealtimeSync] Error generating hash:", error);
//       return null;
//     }
//   }

//   /**
//    * Check if data has changed
//    */
//   async function checkForUpdates() {
//     if (!isActive) return false;

//     stats.totalPolls++;
//     stats.lastPollTime = new Date().toLocaleTimeString();

//     try {
//       // Use the existing /get_data endpoint
//       // In production, you'd use a lightweight /check_updates endpoint
//       const response = await fetch("/get_data", {
//         method: "GET",
//         headers: {
//           "Cache-Control": "no-cache",
//           "X-Tab-Id": tabId,
//         },
//       });

//       if (!response.ok) {
//         throw new Error(`HTTP ${response.status}`);
//       }

//       const data = await response.json();

//       // Generate hash of current data
//       const currentHash = generateHash(data);

//       if (currentHash === null) {
//         console.warn("[RealtimeSync] Failed to generate hash");
//         return false;
//       }

//       // Check if data changed
//       if (lastDataHash === null) {
//         // First load
//         lastDataHash = currentHash;
//         console.log("[RealtimeSync] Initial data loaded");
//         return false; // Don't trigger update on first load
//       }

//       if (currentHash !== lastDataHash) {
//         // Data changed!
//         console.log("[RealtimeSync] 🔄 Data changed, updating...");
//         lastDataHash = currentHash;
//         consecutiveNoChanges = 0;
//         stats.changesDetected++;
//         stats.lastChangeTime = new Date().toLocaleTimeString();

//         // Reset to fast polling
//         currentInterval = CONFIG.POLL_INTERVAL;

//         return true; // Data changed
//       } else {
//         // No changes
//         consecutiveNoChanges++;
//         adjustPollingInterval();
//         return false;
//       }
//     } catch (error) {
//       console.error("[RealtimeSync] Error checking updates:", error);
//       stats.errors++;
//       handleError();
//       return false;
//     }
//   }

//   /**
//    * Adjust polling interval based on activity
//    */
//   function adjustPollingInterval() {
//     if (consecutiveNoChanges >= CONFIG.MAX_CONSECUTIVE_NO_CHANGE) {
//       // Slow down polling if no changes
//       currentInterval = Math.min(
//         currentInterval * CONFIG.SMART_POLL_MULTIPLIER,
//         CONFIG.MAX_POLL_INTERVAL,
//       );
//       stats.currentInterval = Math.round(currentInterval);
//       console.log(
//         `[RealtimeSync] 📉 Slowing down polling to ${Math.round(currentInterval / 1000)}s`,
//       );
//     }
//   }

//   /**
//    * Handle errors and retry
//    */
//   function handleError() {
//     console.warn("[RealtimeSync] Error occurred, will retry...");
//     // Increase interval temporarily
//     currentInterval = Math.min(currentInterval * 2, CONFIG.RETRY_DELAY);
//   }

//   /**
//    * Main polling loop
//    */
//   async function poll() {
//     const hasChanges = await checkForUpdates();

//     if (hasChanges) {
//       // Trigger data refresh
//       await refreshData();
//     }

//     // Schedule next poll
//     schedulePoll();
//   }

//   /**
//    * Schedule next poll
//    */
//   function schedulePoll() {
//     if (pollInterval) {
//       clearTimeout(pollInterval);
//     }

//     // Use slower polling if tab is hidden
//     const interval = isVisible
//       ? currentInterval
//       : CONFIG.VISIBILITY_POLL_INTERVAL;

//     pollInterval = setTimeout(poll, interval);
//   }

//   /**
//    * Refresh data in the UI
//    */
//   async function refreshData() {
//     try {
//       console.log("[RealtimeSync] ⚡ Refreshing UI data...");

//       // Call the existing fetchData function if it exists
//       if (typeof fetchData === "function") {
//         await fetchData();
//         showSyncNotification();
//       } else {
//         console.warn("[RealtimeSync] fetchData function not found");
//       }

//       lastUpdateTime = Date.now();
//     } catch (error) {
//       console.error("[RealtimeSync] Error refreshing data:", error);
//     }
//   }

//   /**
//    * Show subtle notification that data was synced
//    */
//   function showSyncNotification() {
//     // Only show if showNotification exists
//     if (typeof showNotification === "function") {
//       // Create a very subtle notification
//       const notification = document.createElement("div");
//       notification.className = "sync-notification";
//       notification.innerHTML = '<i class="fas fa-sync-alt"></i> Synced';
//       notification.style.cssText = `
//         position: fixed;
//         top: 70px;
//         right: 20px;
//         background: rgba(76, 175, 80, 0.9);
//         color: white;
//         padding: 8px 16px;
//         border-radius: 20px;
//         font-size: 12px;
//         z-index: 9999;
//         display: flex;
//         align-items: center;
//         gap: 6px;
//         box-shadow: 0 2px 8px rgba(0,0,0,0.2);
//         animation: slideInRight 0.3s ease-out;
//       `;

//       document.body.appendChild(notification);

//       // Auto-remove after 2 seconds
//       setTimeout(() => {
//         notification.style.animation = "slideOutRight 0.3s ease-out";
//         setTimeout(() => {
//           if (notification.parentNode) {
//             notification.parentNode.removeChild(notification);
//           }
//         }, 300);
//       }, 2000);
//     }
//   }

//   /**
//    * Handle visibility change
//    */
//   function handleVisibilityChange() {
//     isVisible = !document.hidden;

//     if (isVisible) {
//       console.log("[RealtimeSync] 👁️ Tab visible, resuming fast polling");
//       currentInterval = CONFIG.POLL_INTERVAL;
//       consecutiveNoChanges = 0;

//       // Check immediately when tab becomes visible
//       poll();
//     } else {
//       console.log("[RealtimeSync] 😴 Tab hidden, switching to slow polling");
//     }
//   }

//   /**
//    * Handle page unload
//    */
//   function handleUnload() {
//     stop();
//   }

//   /**
//    * Start syncing
//    */
//   function start() {
//     if (pollInterval) {
//       console.warn("[RealtimeSync] Already running");
//       return;
//     }

//     console.log("[RealtimeSync] 🚀 Starting real-time sync...");
//     isActive = true;

//     // Set up visibility change listener
//     document.addEventListener("visibilitychange", handleVisibilityChange);
//     window.addEventListener("beforeunload", handleUnload);

//     // Start polling
//     poll();

//     console.log("[RealtimeSync] ✅ Real-time sync active");
//   }

//   /**
//    * Stop syncing
//    */
//   function stop() {
//     console.log("[RealtimeSync] 🛑 Stopping real-time sync...");
//     isActive = false;

//     if (pollInterval) {
//       clearTimeout(pollInterval);
//       pollInterval = null;
//     }

//     document.removeEventListener("visibilitychange", handleVisibilityChange);
//     window.removeEventListener("beforeunload", handleUnload);
//   }

//   /**
//    * Get current stats
//    */
//   function getStats() {
//     return {
//       ...stats,
//       isActive,
//       isVisible,
//       currentInterval: Math.round(currentInterval / 1000) + "s",
//       lastUpdate: new Date(lastUpdateTime).toLocaleTimeString(),
//       consecutiveNoChanges,
//     };
//   }

//   /**
//    * Force a sync check now
//    */
//   async function syncNow() {
//     console.log("[RealtimeSync] 🔄 Manual sync triggered");
//     consecutiveNoChanges = 0;
//     currentInterval = CONFIG.POLL_INTERVAL;
//     await poll();
//   }

//   // Public API
//   return {
//     start,
//     stop,
//     getStats,
//     syncNow,
//   };
// })();

// // Add CSS for sync notification animation
// const style = document.createElement("style");
// style.textContent = `
//   @keyframes slideInRight {
//     from {
//       transform: translateX(100%);
//       opacity: 0;
//     }
//     to {
//       transform: translateX(0);
//       opacity: 1;
//     }
//   }

//   @keyframes slideOutRight {
//     from {
//       transform: translateX(0);
//       opacity: 1;
//     }
//     to {
//       transform: translateX(100%);
//       opacity: 0;
//     }
//   }
// `;
// document.head.appendChild(style);

// // Auto-start when DOM is ready
// if (document.readyState === "loading") {
//   document.addEventListener("DOMContentLoaded", () => {
//     // Wait a bit for other scripts to initialize
//     setTimeout(() => RealtimeSync.start(), 1000);
//   });
// } else {
//   // DOM already loaded
//   setTimeout(() => RealtimeSync.start(), 1000);
// }

// // Global access for debugging
// window.RealtimeSync = RealtimeSync;

// // Log stats every minute (for debugging)
// if (
//   window.location.hostname === "localhost" ||
//   window.location.hostname === "127.0.0.1"
// ) {
//   setInterval(() => {
//     console.log("[RealtimeSync] Stats:", RealtimeSync.getStats());
//   }, 60000);
// }

// console.log("[RealtimeSync] Module loaded");
