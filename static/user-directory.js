/* ─────────────────────────────────────────────────────────────────────────
 * User directory — userId → display name resolver.
 *
 * Loaded once after the user signs in. Powers the "Cleaned by Priya",
 * "Booked by Anita", "Last edited by Manager Neeraj" lines that appear
 * on room cards, modals, register rows, etc.
 *
 * Source of truth: GET /api/user-directory (open to all authenticated
 * roles, returns just {userId: {name, role, isActive}}).
 *
 * Public API
 * ──────────
 *   await CibaraUsers.ready()             → resolves when cache is loaded
 *   CibaraUsers.nameOf("priya")           → "Priya"  (or "priya" if not found)
 *   CibaraUsers.userOf("priya")           → {name, role, isActive} | null
 *   CibaraUsers.formatBy("priya")         → "Priya"  (handles "system",
 *                                            null, missing, deleted users)
 *   await CibaraUsers.refresh()           → re-fetch the directory
 *
 * Falls back gracefully for unknown / legacy entries:
 *   nameOf(null)        → "—"
 *   nameOf("system")    → "System"
 *   nameOf("missing")   → "missing"   (just echoes the userId)
 * ──────────────────────────────────────────────────────────────────── */

(function (global) {
  "use strict";

  let _cache = {};               // { userId: {name, role, isActive} }
  let _loaded = false;
  let _loadingPromise = null;

  function _load() {
    if (_loadingPromise) return _loadingPromise;
    _loadingPromise = fetch("/api/user-directory")
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (body) {
        if (body && body.success && body.users) {
          _cache = body.users;
        }
        _loaded = true;
        return _cache;
      })
      .catch(function (err) {
        // Don't break the app — fall back to userId-as-name on lookups.
        console.warn("CibaraUsers: directory load failed:", err);
        _loaded = true;
        return _cache;
      });
    return _loadingPromise;
  }

  function ready() {
    if (_loaded) return Promise.resolve(_cache);
    return _load();
  }

  function refresh() {
    _loaded = false;
    _loadingPromise = null;
    return _load();
  }

  function userOf(userId) {
    if (!userId) return null;
    return _cache[userId] || null;
  }

  // Pretty display name. Order:
  //   - empty / null / undefined → "—"
  //   - "system" / "system_legacy" → "System"
  //   - found in directory → name (capitalised if name === userId all-lower)
  //   - not found → return the userId verbatim (so audit trails still readable)
  function nameOf(userId) {
    if (!userId) return "—";
    const id = String(userId);
    if (id === "system" || id === "system_legacy" || id === "seed_script") {
      return "System";
    }
    const u = _cache[id];
    if (u && u.name) {
      return u.name;
    }
    return id;
  }

  // Used by sentence-style attribution lines like "Booked by Anita".
  function formatBy(userId) {
    return nameOf(userId);
  }

  // Auto-load when auth is ready. Re-load on logout/login isn't needed
  // because the page hard-reloads on logout.
  function _bootstrap() {
    if (window.CibaraAuth && window.CibaraAuth.ready) {
      window.CibaraAuth.ready().then(function (user) {
        if (user) _load();
      });
    } else {
      // Fallback for pages that load this script without auth.js
      setTimeout(_load, 0);
    }
  }
  _bootstrap();

  global.CibaraUsers = Object.freeze({
    ready: ready,
    refresh: refresh,
    userOf: userOf,
    nameOf: nameOf,
    formatBy: formatBy,
  });
})(window);
