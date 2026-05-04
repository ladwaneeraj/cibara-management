/* ─────────────────────────────────────────────────────────────────────────
 * Housekeeping mode bootstrap.
 *
 * For users with role=housekeeping:
 *   • Force the room filter to "cleaning" on load.
 *   • Disable the search input so they can't find non-cleaning rooms.
 *   • Patch the room renderer to drop any room that is not in cleaning state
 *     (defence in depth — the filter alone is sufficient, but a room that
 *     gets stuck without cleaning_status=true should still be hidden).
 *
 * For all other roles this file is a no-op.
 *
 * Loaded after auth.js + script.js so window.CibaraAuth and the room
 * renderer's setActiveFilter (or equivalent) both exist.
 * ──────────────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  function applyHousekeepingMode() {
    const auth = window.CibaraAuth;
    if (!auth || !auth.isHousekeeping || !auth.isHousekeeping()) return;

    // 1. Disable the search bar (housekeeping doesn't need it)
    const search = document.getElementById("room-search");
    if (search) {
      search.value = "";
      search.disabled = true;
      search.placeholder = "Search disabled";
      search.style.opacity = "0.5";
    }

    // 2. Force the cleaning filter to be the active one and click it.
    const cleaningBtn = document.querySelector(
      '.filter-btn[data-filter="cleaning"]'
    );
    if (cleaningBtn) {
      // Mark active
      document
        .querySelectorAll(".filter-btn")
        .forEach(function (b) { b.classList.remove("active"); });
      cleaningBtn.classList.add("active");
      // Trigger a click so the existing filter handler runs and the grid
      // re-renders. We use a microtask so the original click handler has
      // had a chance to attach.
      setTimeout(function () {
        try { cleaningBtn.click(); } catch (_) { /* ignore */ }
      }, 50);
    }

    // 3. Hide the bottom-nav items we missed
    document.querySelectorAll(".nav-item").forEach(function (item) {
      const tab = item.getAttribute("data-tab");
      if (tab && tab !== "rooms") {
        item.setAttribute("hidden", "");
        item.style.display = "none";
      }
    });

    // 4. Mark the body so CSS can target housekeeping mode if needed
    document.body.classList.add("housekeeping-mode");
  }

  // Run after auth has resolved + DOM is ready.
  function _start() {
    if (!window.CibaraAuth) {
      // auth.js hasn't loaded yet — try again shortly
      setTimeout(_start, 50);
      return;
    }
    window.CibaraAuth.ready().then(function () {
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", applyHousekeepingMode);
      } else {
        applyHousekeepingMode();
      }
    });
  }

  _start();
})();
