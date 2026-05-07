/* ─────────────────────────────────────────────────────────────────────────
 * Room-attribution popover.
 *
 * Originally rendered an info chip on every room card. The chip was
 * removed; this module now exposes only the popover, anchored against
 * an arbitrary button via openForButton(buttonEl, roomInfo). The
 * Register tab's history icon is the sole consumer.
 *
 * Public API
 * ──────────
 *   CibaraRoomAttribution.openForButton(buttonEl, roomInfo)
 *     Opens the popover anchored to buttonEl with rows derived from
 *     roomInfo's attribution fields.
 *
 *   CibaraRoomAttribution.closeAll()
 *     Closes any open popover. Called on outside click / Escape /
 *     explicit close button.
 * ──────────────────────────────────────────────────────────────────── */

(function (global) {
  "use strict";

  // ── Style injection (idempotent) ──────────────────────────────────────
  function _injectStyles() {
    if (document.getElementById("rm-attr-style")) return;
    const s = document.createElement("style");
    s.id = "rm-attr-style";
    s.textContent = `
      /* Popover */
      .rm-attr-popover {
        position: fixed;
        z-index: 99998;
        min-width: 220px; max-width: 280px;
        background: #fff;
        color: #1e293b;
        border-radius: 12px;
        box-shadow: 0 12px 32px -8px rgba(0,0,0,.25),
                    0 4px 10px -2px rgba(0,0,0,.08);
        padding: 12px 14px;
        font: 400 .82rem 'Inter', system-ui, sans-serif;
        line-height: 1.4;
        animation: rm-attr-in .12s ease-out;
        border: 1px solid #eef2f7;
      }
      @keyframes rm-attr-in {
        from { opacity: 0; transform: translateY(-4px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .rm-attr-popover-header {
        display: flex; align-items: center; justify-content: space-between;
        gap: 8px;
        margin: 0 0 10px;
        padding-bottom: 8px;
        border-bottom: 1px solid #eef2f7;
      }
      .rm-attr-popover-title {
        font: 700 .68rem 'Inter', sans-serif;
        color: #64748b;
        text-transform: uppercase;
        letter-spacing: .05em;
        margin: 0;
      }
      .rm-attr-popover-close {
        flex-shrink: 0;
        width: 22px; height: 22px;
        display: inline-grid; place-items: center;
        background: transparent;
        border: 1px solid transparent;
        border-radius: 6px;
        color: #94a3b8;
        cursor: pointer;
        font-size: .9rem; line-height: 1;
        padding: 0;
        transition: background .12s, color .12s, border-color .12s;
      }
      .rm-attr-popover-close:hover,
      .rm-attr-popover-close:focus-visible {
        background: #f1f5f9;
        border-color: #e2e8f0;
        color: #475569;
        outline: none;
      }
      .rm-attr-row {
        display: flex; justify-content: space-between; align-items: baseline;
        gap: 8px; padding: 5px 0;
      }
      .rm-attr-row + .rm-attr-row {
        border-top: 1px dashed #f1f5f9;
      }
      .rm-attr-label {
        color: #64748b;
        font-size: .76rem;
      }
      .rm-attr-extra {
        color: #475569;
        font-weight: 600;
      }
      .rm-attr-name {
        color: #1e293b;
        font-weight: 600;
      }
      .rm-attr-time {
        display: block;
        color: #94a3b8;
        font-size: .7rem;
        font-weight: 400;
      }
      .rm-attr-empty {
        color: #94a3b8; font-style: italic; font-size: .8rem;
      }
    `;
    document.head.appendChild(s);
  }

  // ── State: only one popover open at a time ─────────────────────────────
  let _openPopover = null;
  let _openAnchor = null;        // button we positioned against
  let _outsideHandler = null;
  let _escHandler = null;
  let _reflowHandler = null;     // keeps a reference so we can detach
  let _anchorObserver = null;    // closes when the anchor is removed from DOM

  function closeAll() {
    if (_openPopover) {
      try { _openPopover.remove(); } catch (_) { /* already gone */ }
      _openPopover = null;
    }
    if (_openAnchor) {
      try { _openAnchor.setAttribute("aria-expanded", "false"); } catch (_) { /* ignore */ }
    }
    _openAnchor = null;
    if (_outsideHandler) {
      document.removeEventListener("click", _outsideHandler, true);
      _outsideHandler = null;
    }
    if (_escHandler) {
      document.removeEventListener("keydown", _escHandler);
      _escHandler = null;
    }
    if (_reflowHandler) {
      window.removeEventListener("scroll", _reflowHandler, true);
      window.removeEventListener("resize", _reflowHandler);
      _reflowHandler = null;
    }
    if (_anchorObserver) {
      try { _anchorObserver.disconnect(); } catch (_) { /* ignore */ }
      _anchorObserver = null;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────
  function _escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function _relativeTime(ts) {
    if (!ts) return "";
    // Accept "YYYY-MM-DD HH:MM:SS" (IST) or ISO
    const d = new Date(String(ts).replace(" ", "T"));
    if (isNaN(d.getTime())) return ts;
    const diff = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diff < 0) return "just now";
    if (diff < 60) return "just now";
    if (diff < 3600) {
      const m = Math.floor(diff / 60);
      return m + (m === 1 ? " min ago" : " min ago");
    }
    if (diff < 86400) {
      const h = Math.floor(diff / 3600);
      return h + (h === 1 ? " hour ago" : " hours ago");
    }
    const days = Math.floor(diff / 86400);
    if (days < 7) return days + (days === 1 ? " day ago" : " days ago");
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }

  function _resolveName(userId) {
    if (!userId) return "—";
    if (window.CibaraUsers && window.CibaraUsers.nameOf) {
      return window.CibaraUsers.nameOf(userId);
    }
    return userId;
  }

  // Action key → user-facing label. Backend returns events sorted
  // ascending (oldest first); we render in that order.
  const _ACTION_LABEL = {
    "room.checkout":             "Checked out by",
    "room.cleaning.complete":    "Cleaned by",
    "room.inspection.approve":   "Approved by",
    "room.checkin":              "Checked in by",
    "room.checkin_time_update":  "Check-in time edited by",
    "room.transfer":             "Transferred by",
  };

  // Convert an audit-log entry into the row shape the popover renderer
  // consumes. `room.transfer` rows get an extra "from X → to Y" label
  // pulled from the audit metadata so the chain is legible.
  function _entryToRow(e) {
    const userLabel =
      (e.userName && String(e.userName).trim()) ||
      _resolveName(e.userId) ||
      "—";
    let label = _ACTION_LABEL[e.action] || e.action || "Action";
    if (e.action === "room.transfer" && e.metadata) {
      const from = e.metadata.from_room;
      const to   = e.metadata.to_room;
      if (from && to) label = `Transferred ${from} → ${to} by`;
    }
    return {
      label: label,
      name:  userLabel,
      when:  _relativeTime(e.timestamp),
    };
  }

  // Async fetch — pulls the canonical history from the audit log scoped
  // to a (room, time-window) tuple. Works for both active and completed
  // stays because it doesn't rely on a bills-doc lookup; the bill row
  // already carries everything we need.
  //
  // Returns [] on any error so the popover renders an "empty state"
  // rather than getting stuck on Loading.
  async function _fetchStayHistory(stayInfo) {
    const room = stayInfo && stayInfo.room;
    const checkin = stayInfo && (stayInfo.checkin_time || stayInfo.checkin);
    if (!room || !checkin) return [];

    const params = new URLSearchParams();
    params.set("room", String(room));
    params.set("checkin", String(checkin));
    if (stayInfo.checkout_time) params.set("checkout", String(stayInfo.checkout_time));
    if (stayInfo.status)        params.set("status",   String(stayInfo.status));

    try {
      const res = await fetch(
        "/api/audit-logs/stay-history?" + params.toString(),
        { credentials: "same-origin" }
      );
      if (!res.ok) return [];
      const body = await res.json();
      if (!body || !body.success || !Array.isArray(body.entries)) return [];
      return body.entries;
    } catch (_e) {
      return [];
    }
  }

  // ── Popover positioning — flips above/below based on viewport edge ────
  function _positionPopover(popover, anchorRect) {
    // First, place it to determine its size
    popover.style.visibility = "hidden";
    popover.style.left = "0px";
    popover.style.top = "0px";
    document.body.appendChild(popover);
    const popRect = popover.getBoundingClientRect();
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Horizontal: align with anchor's left, but keep within viewport.
    let left = anchorRect.left;
    if (left + popRect.width > vw - margin) {
      left = vw - popRect.width - margin;
    }
    if (left < margin) left = margin;

    // Vertical: prefer below; flip above if it would clip.
    let top = anchorRect.bottom + 6;
    if (top + popRect.height > vh - margin) {
      const aboveTop = anchorRect.top - popRect.height - 6;
      if (aboveTop >= margin) {
        top = aboveTop;
      } else {
        // Neither fits cleanly — clamp to top.
        top = margin;
      }
    }

    popover.style.left = Math.round(left) + "px";
    popover.style.top = Math.round(top) + "px";
    popover.style.visibility = "";
  }

  // Render the body of the popover from a row list. Header (title + close
  // button) is left intact — only the rows below it are replaced. Used
  // both for the initial Loading state and once the fetch resolves.
  function _renderBody(popover, rows) {
    const body = popover.querySelector(".rm-attr-popover-body");
    if (!body) return;
    if (!rows || rows.length === 0) {
      body.innerHTML = '<div class="rm-attr-empty">No history yet.</div>';
      return;
    }
    const out = rows.map(function (r) {
      const when = r.when
        ? '<span class="rm-attr-time">' + _escapeHtml(r.when) + '</span>'
        : "";
      return (
        '<div class="rm-attr-row">' +
          '<div>' +
            '<span class="rm-attr-label">' + _escapeHtml(r.label) + '</span><br>' +
            '<span class="rm-attr-name">' + _escapeHtml(r.name) + '</span>' +
          '</div>' +
          when +
        '</div>'
      );
    }).join("");
    body.innerHTML = out;
  }

  function _openFor(anchor, roomInfo) {
    const popover = document.createElement("div");
    popover.className = "rm-attr-popover";
    popover.setAttribute("role", "dialog");

    // Static shell — header + body container. The body content is filled
    // in below: first with a Loading state, then replaced when the audit
    // log fetch resolves.
    popover.innerHTML =
      '<div class="rm-attr-popover-header">' +
        '<div class="rm-attr-popover-title">Room history</div>' +
        '<button type="button" class="rm-attr-popover-close" ' +
                'aria-label="Close" title="Close">&times;</button>' +
      '</div>' +
      '<div class="rm-attr-popover-body">' +
        '<div class="rm-attr-empty">Loading…</div>' +
      '</div>';

    // Wire the explicit close button so users have a clear dismiss path
    // in addition to outside-click / Escape.
    const closeBtn = popover.querySelector(".rm-attr-popover-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        closeAll();
      });
    }

    // Place the popover up front so positioning is computed from a real
    // (loading-state) rect — the body's final height is similar enough.
    const anchorRect = anchor.getBoundingClientRect();
    _positionPopover(popover, anchorRect);

    anchor.setAttribute("aria-expanded", "true");
    _openPopover = popover;
    _openAnchor = anchor;

    // Scope the audit-log query to this stay using room + checkin time
    // (the only fields we strictly need). Works uniformly for active
    // and completed stays — no dependence on a bill_id that may be
    // synthetic ("active_<room>_<ts>") for active rows.
    if (roomInfo && roomInfo.room && (roomInfo.checkin_time || roomInfo.checkin)) {
      _fetchStayHistory(roomInfo).then(function (entries) {
        // Bail if the user closed the popover while the fetch was in flight.
        if (_openPopover !== popover) return;
        const rows = (entries || []).map(_entryToRow);
        _renderBody(popover, rows);
        // Reposition — content height changed, may have flipped the
        // optimal placement above/below.
        _positionPopover(popover, anchor.getBoundingClientRect());
      });
    } else {
      // Missing the minimum inputs (room + checkin time). Render empty
      // state immediately rather than spinning forever.
      _renderBody(popover, []);
    }

    // Outside click closes. Use capture so clicks on inner elements that
    // call stopPropagation still bubble to us.
    _outsideHandler = function (ev) {
      if (popover.contains(ev.target)) return;
      if (anchor.contains(ev.target)) return;
      closeAll();
    };
    setTimeout(function () {
      // Guard: closeAll() may have run during the tick (e.g. data refresh)
      if (_openPopover === popover) {
        document.addEventListener("click", _outsideHandler, true);
      }
    }, 0);

    _escHandler = function (ev) {
      if (ev.key === "Escape") closeAll();
    };
    document.addEventListener("keydown", _escHandler);

    // Reposition on scroll / resize (throttled).
    let _t = null;
    _reflowHandler = function () {
      if (!_openPopover || !_openAnchor || !_openAnchor.isConnected) return;
      clearTimeout(_t);
      _t = setTimeout(function () {
        if (!_openPopover || !_openAnchor || !_openAnchor.isConnected) return;
        _positionPopover(popover, _openAnchor.getBoundingClientRect());
      }, 16);
    };
    window.addEventListener("scroll", _reflowHandler, true);
    window.addEventListener("resize", _reflowHandler);

    // Auto-close when the anchor is removed from the DOM. The register
    // table re-renders periodically (Firestore onSnapshot, manual
    // refresh) — the old anchor button is destroyed but the popover
    // would otherwise stay floating where it used to be, looking
    // "stuck". Watching the ancestor catches this in one tick.
    const ancestor = anchor.parentElement && anchor.parentElement.parentElement;
    if (ancestor && typeof MutationObserver !== "undefined") {
      _anchorObserver = new MutationObserver(function () {
        if (!anchor.isConnected) {
          closeAll();
        }
      });
      _anchorObserver.observe(ancestor, { childList: true, subtree: true });
    }
  }

  // Open the popover anchored to an arbitrary button (e.g. the register
  // tab's reg-history-btn). This is now the only way the popover is
  // shown — the room-card chip was retired.
  //
  // We always open immediately into a Loading state and let the async
  // audit-log fetch fill in the rows. Pre-checking snapshot fields on
  // the bill row was unreliable: rows for completed stays often miss
  // post-checkout cleaning/inspection events because the bill doc is
  // not updated again after finalization. The audit log is the source
  // of truth — query it directly via the bill_id foreign key.
  function openForButton(buttonEl, roomInfo) {
    if (!buttonEl || !roomInfo) return;
    _injectStyles();
    closeAll();
    _openFor(buttonEl, roomInfo);
  }

  global.CibaraRoomAttribution = Object.freeze({
    closeAll: closeAll,
    openForButton: openForButton,
  });
})(window);
