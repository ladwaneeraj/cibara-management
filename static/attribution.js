/* ─────────────────────────────────────────────────────────────────────────
 * Inline attribution helper.
 *
 * Lets any module ask "who last touched <doc>?" and decorate a UI element
 * with a one-line summary like:
 *
 *     Last action: payment.add by Priya, 2 hours ago
 *
 * Backed by GET /api/audit-logs/doc/<collection>/<doc_id> (added in
 * routes/users.py). Results are cached for the session so re-opens don't
 * re-fetch.
 *
 * Public API:
 *
 *   await CibaraAttribution.fetch("bills", "abc123")
 *     → { action, userId, userName, userRole, timestamp } | null
 *
 *   CibaraAttribution.formatLine(entry)
 *     → "Last action: payment.add by Priya, 2 hours ago"
 *
 *   await CibaraAttribution.decorate(targetEl, "bills", "abc123", opts)
 *     → fetches and writes the line into targetEl. opts:
 *         { prefix?: string, hideIfNone?: boolean }
 *
 * Usage in a modal:
 *   const footer = document.getElementById("bill-attr-footer");
 *   CibaraAttribution.decorate(footer, "bills", billId);
 * ──────────────────────────────────────────────────────────────────── */

(function (global) {
  "use strict";

  const _cache = new Map();   // key: "<coll>::<id>"  → entry|null
  const CACHE_TTL_MS = 60 * 1000;   // 1 min — enough to avoid bursts on re-render

  function _cacheKey(coll, id) { return coll + "::" + id; }

  function _readCache(coll, id) {
    const hit = _cache.get(_cacheKey(coll, id));
    if (!hit) return undefined;
    if (Date.now() - hit.t > CACHE_TTL_MS) {
      _cache.delete(_cacheKey(coll, id));
      return undefined;
    }
    return hit.v;
  }

  function _writeCache(coll, id, value) {
    _cache.set(_cacheKey(coll, id), { v: value, t: Date.now() });
  }

  async function fetchAttribution(coll, id) {
    if (!coll || !id) return null;
    const cached = _readCache(coll, id);
    if (cached !== undefined) return cached;
    try {
      const res = await fetch(
        "/api/audit-logs/doc/" +
        encodeURIComponent(coll) + "/" + encodeURIComponent(id)
      );
      if (!res.ok) {
        _writeCache(coll, id, null);
        return null;
      }
      const body = await res.json();
      const entry = (body && body.success && body.entry) || null;
      _writeCache(coll, id, entry);
      return entry;
    } catch (_e) {
      _writeCache(coll, id, null);
      return null;
    }
  }

  function _relativeTime(timestampStr) {
    // timestamp is "YYYY-MM-DD HH:MM:SS" IST
    if (!timestampStr) return "";
    const d = new Date(String(timestampStr).replace(" ", "T"));
    if (isNaN(d.getTime())) return timestampStr;
    const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diffSec < 60) return "just now";
    if (diffSec < 3600) {
      const m = Math.floor(diffSec / 60);
      return m + (m === 1 ? " minute ago" : " minutes ago");
    }
    if (diffSec < 86400) {
      const h = Math.floor(diffSec / 3600);
      return h + (h === 1 ? " hour ago" : " hours ago");
    }
    if (diffSec < 86400 * 7) {
      const days = Math.floor(diffSec / 86400);
      return days + (days === 1 ? " day ago" : " days ago");
    }
    // Older than a week — show the absolute date
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }

  function formatLine(entry, opts) {
    if (!entry) return "";
    opts = opts || {};
    const prefix = opts.prefix || "Last action:";
    const who = entry.userName || entry.userId || "system";
    const when = _relativeTime(entry.timestamp);
    return prefix + " " + entry.action + " by " + who +
      (when ? ", " + when : "");
  }

  function _escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  async function decorate(targetEl, coll, id, opts) {
    if (!targetEl) return;
    opts = opts || {};
    targetEl.classList.add("cibara-attr");
    // Show a placeholder while we fetch
    targetEl.textContent = opts.loadingText || "";
    const entry = await fetchAttribution(coll, id);
    if (!entry) {
      if (opts.hideIfNone) {
        targetEl.style.display = "none";
        targetEl.textContent = "";
      } else {
        targetEl.textContent = opts.noneText || "";
        targetEl.style.display = "";
      }
      return;
    }
    targetEl.style.display = "";
    targetEl.innerHTML =
      '<span class="cibara-attr-icon" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>' +
      '</span>' +
      '<span class="cibara-attr-text">' +
        _escapeHtml(opts.prefix || "Last action:") + ' ' +
        '<strong>' + _escapeHtml(entry.action || "") + '</strong> by ' +
        '<strong>' + _escapeHtml(entry.userName || entry.userId || "system") + '</strong>' +
        (entry.timestamp
          ? ' <time title="' + _escapeHtml(entry.timestamp) + '">· ' +
              _escapeHtml(_relativeTime(entry.timestamp)) + '</time>'
          : '') +
      '</span>';
  }

  // Inject default styles once (idempotent)
  function _ensureStyles() {
    if (document.getElementById("cibara-attr-style")) return;
    const s = document.createElement("style");
    s.id = "cibara-attr-style";
    s.textContent = `
      .cibara-attr {
        display: inline-flex; align-items: center; gap: 6px;
        font: 500 .76rem 'Inter', system-ui, sans-serif;
        color: #64748b;
        padding: 4px 10px;
        background: #f1f5f9;
        border-radius: 999px;
        max-width: 100%;
        line-height: 1.4;
      }
      .cibara-attr strong { font-weight: 600; color: #334155; }
      .cibara-attr time { color: #94a3b8; font-style: normal; }
      .cibara-attr-icon { display: inline-flex; opacity: .7; }
    `;
    document.head.appendChild(s);
  }
  _ensureStyles();

  global.CibaraAttribution = Object.freeze({
    fetch: fetchAttribution,
    formatLine: formatLine,
    decorate: decorate,
  });
})(window);
