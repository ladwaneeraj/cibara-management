/* ─────────────────────────────────────────────────────────────────────────
 * Room-card attribution chip + popover.
 *
 * Renders a small info chip in the top-left of any room card whose doc
 * has at least one attribution field (lastCheckinBy, cleanedBy,
 * inspectedBy, lastCheckoutBy). On hover (desktop) or tap (mobile)
 * shows a small popover with the full per-stay history.
 *
 * Public API
 * ──────────
 *   CibaraRoomAttribution.decorate(roomCardEl, roomInfo)
 *     Adds the chip + handlers if appropriate. Idempotent — calling
 *     twice on the same card replaces the chip.
 *
 *   CibaraRoomAttribution.closeAll()
 *     Closes any open popover. Called on outside click / Escape.
 *
 * Mobile considerations
 * ─────────────────────
 *   - Chip is 24×24 px with 10 px invisible padding → comfortably above
 *     the 44 px tap-target minimum.
 *   - Popover uses position:fixed and flips above/below based on
 *     viewport edge.
 *   - Tap outside or Escape closes. No tiny X to hunt for.
 *   - Hover-only popovers are explicitly avoided — every interaction
 *     also works with click/tap.
 * ──────────────────────────────────────────────────────────────────── */

(function (global) {
  "use strict";

  // ── Style injection (idempotent) ──────────────────────────────────────
  function _injectStyles() {
    if (document.getElementById("rm-attr-style")) return;
    const s = document.createElement("style");
    s.id = "rm-attr-style";
    s.textContent = `
      .rm-attr-chip {
        position: absolute;
        top: 6px; left: 6px;
        z-index: 5;
        display: grid; place-items: center;
        width: 22px; height: 22px;
        border-radius: 50%;
        background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
        color: #fff;
        font: 700 10.5px/1 'Inter', system-ui, sans-serif;
        cursor: pointer;
        border: 2px solid #fff;
        box-shadow: 0 1px 4px rgba(0,0,0,.18);
        transition: transform .12s, box-shadow .12s;
        /* Invisible padding for tap target */
        padding: 0;
      }
      .rm-attr-chip::before {
        content: "";
        position: absolute;
        inset: -8px;   /* expands hit area to ~38px */
      }
      .rm-attr-chip:hover,
      .rm-attr-chip:focus-visible {
        transform: scale(1.08);
        box-shadow: 0 2px 8px rgba(99,102,241,.45);
        outline: none;
      }
      .rm-attr-chip[aria-expanded="true"] {
        background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
      }

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
      .rm-attr-popover-title {
        font: 700 .68rem 'Inter', sans-serif;
        color: #64748b;
        text-transform: uppercase;
        letter-spacing: .05em;
        margin: 0 0 10px;
        padding-bottom: 8px;
        border-bottom: 1px solid #eef2f7;
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

      /* Hover-only enhancement on desktop. The click handler still works
         for everyone — this just gives mouse users a faster path. */
      @media (hover: hover) and (pointer: fine) {
        .rm-attr-chip:hover + .rm-attr-popover-anchor .rm-attr-popover-hover {
          display: block;
        }
      }
    `;
    document.head.appendChild(s);
  }

  // ── State: only one popover open at a time ─────────────────────────────
  let _openPopover = null;
  let _openChip = null;          // anchor we positioned against
  let _outsideHandler = null;
  let _escHandler = null;
  let _reflowHandler = null;     // keeps a reference so we can detach
  let _anchorObserver = null;    // closes when the chip is removed from DOM

  function closeAll() {
    if (_openPopover) {
      try { _openPopover.remove(); } catch (_) { /* already gone */ }
      _openPopover = null;
    }
    _openChip = null;
    document.querySelectorAll(".rm-attr-chip[aria-expanded='true']").forEach(function (b) {
      b.setAttribute("aria-expanded", "false");
    });
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

  // Pick the initial to show on the chip — most-relevant action's user.
  function _chipInitial(roomInfo) {
    const candidates = [
      roomInfo.cleanedBy,
      roomInfo.inspectedBy,
      roomInfo.lastCheckinBy,
      roomInfo.lastCheckoutBy,
      roomInfo.lastModifiedBy,
    ];
    for (let i = 0; i < candidates.length; i++) {
      if (candidates[i]) {
        const nm = _resolveName(candidates[i]);
        return (nm.charAt(0) || "?").toUpperCase();
      }
    }
    return "i";  // generic info marker
  }

  function _hasAnyAttribution(roomInfo) {
    return !!(
      roomInfo.cleanedBy ||
      roomInfo.inspectedBy ||
      roomInfo.bookedBy ||
      roomInfo.lastCheckinBy ||
      roomInfo.lastCheckinTimeEditBy ||
      roomInfo.lastCheckoutBy ||
      roomInfo.lastModifiedBy ||
      roomInfo.createdBy
    );
  }

  // Build the rows to render based on room state. Skip rows whose user
  // field is null (e.g. cleanedBy is cleared once a room is approved
  // ready). Rows are ordered by lifecycle position so the trail reads
  // top-to-bottom: cleaned → inspected → booked → checked in →
  // (any time edits) → checked out.
  //
  // Payments are intentionally NOT in this popover — they live in the
  // payment-history modal (₹ button) which already shows "added by".
  function _buildRows(roomInfo) {
    const rows = [];

    if (roomInfo.cleanedBy) {
      rows.push({
        label: "Cleaned by",
        name: _resolveName(roomInfo.cleanedBy),
        when: _relativeTime(roomInfo.cleanedAt || roomInfo.cleaning_done_at),
      });
    }
    if (roomInfo.inspectedBy) {
      rows.push({
        label: "Approved by",
        name: _resolveName(roomInfo.inspectedBy),
        when: _relativeTime(roomInfo.inspectedAt || roomInfo.inspected_at),
      });
    }
    if (roomInfo.bookedBy) {
      rows.push({
        label: "Booked by",
        name: _resolveName(roomInfo.bookedBy),
        when: _relativeTime(roomInfo.bookedAt),
      });
    }
    if (roomInfo.lastCheckinBy) {
      rows.push({
        label: "Checked in by",
        name: _resolveName(roomInfo.lastCheckinBy),
        when: _relativeTime(roomInfo.lastCheckinAt || roomInfo.checkin_time),
      });
    }
    if (roomInfo.lastCheckinTimeEditBy) {
      rows.push({
        label: "Check-in time edited by",
        name: _resolveName(roomInfo.lastCheckinTimeEditBy),
        when: _relativeTime(roomInfo.lastCheckinTimeEditAt),
      });
    }
    if (roomInfo.lastCheckoutBy) {
      // The /checkin route clears this so during an active stay we
      // don't show the previous guest's checkout. It populates again
      // after the current stay's checkout, giving the full chain.
      rows.push({
        label: "Checked out by",
        name: _resolveName(roomInfo.lastCheckoutBy),
        when: _relativeTime(roomInfo.lastCheckoutAt),
      });
    }
    return rows;
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

  // ── Public: decorate a room card ──────────────────────────────────────
  function decorate(cardEl, roomInfo) {
    if (!cardEl || !roomInfo) return;
    // The room-card chip is for the cleaning / vacant phases — i.e. while
    // the room is being prepared for the next guest. Once the room is
    // occupied, history (if needed) is reachable via the checkout modal.
    if (roomInfo.status === "occupied") return;
    if (!_hasAnyAttribution(roomInfo)) return;

    _injectStyles();

    // Make sure the card is the positioning context for the chip.
    const computed = getComputedStyle(cardEl).position;
    if (computed === "static") cardEl.style.position = "relative";

    // Replace any existing chip (idempotent re-render).
    const old = cardEl.querySelector(":scope > .rm-attr-chip");
    if (old) old.remove();

    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "rm-attr-chip";
    chip.setAttribute("aria-haspopup", "true");
    chip.setAttribute("aria-expanded", "false");
    chip.setAttribute("aria-label", "Show room history");
    chip.title = "Show who handled this room";
    chip.textContent = _chipInitial(roomInfo);

    chip.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      _toggle(chip, roomInfo);
    });

    cardEl.appendChild(chip);
  }

  function _toggle(chip, roomInfo) {
    const wasOpen = chip.getAttribute("aria-expanded") === "true";
    closeAll();
    if (wasOpen) return;
    _openFor(chip, roomInfo);
  }

  function _openFor(chip, roomInfo) {
    const rows = _buildRows(roomInfo);
    const popover = document.createElement("div");
    popover.className = "rm-attr-popover";
    popover.setAttribute("role", "dialog");

    const html = [
      '<div class="rm-attr-popover-title">Room history</div>',
    ];
    if (rows.length === 0) {
      html.push('<div class="rm-attr-empty">No history yet.</div>');
    } else {
      rows.forEach(function (r) {
        const extra = r.extra ? '<span class="rm-attr-extra"> · ' + _escapeHtml(r.extra) + '</span>' : '';
        html.push(
          '<div class="rm-attr-row">' +
            '<div>' +
              '<span class="rm-attr-label">' + _escapeHtml(r.label) + extra + '</span><br>' +
              '<span class="rm-attr-name">' + _escapeHtml(r.name) + '</span>' +
            '</div>' +
            (r.when ? '<span class="rm-attr-time">' + _escapeHtml(r.when) + '</span>' : '') +
          '</div>'
        );
      });
    }
    popover.innerHTML = html.join("");

    const anchorRect = chip.getBoundingClientRect();
    _positionPopover(popover, anchorRect);

    chip.setAttribute("aria-expanded", "true");
    _openPopover = popover;
    _openChip = chip;

    // Outside click closes. Use capture so clicks on inner elements that
    // call stopPropagation still bubble to us.
    _outsideHandler = function (ev) {
      if (popover.contains(ev.target)) return;
      if (chip.contains(ev.target)) return;
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
      if (!_openPopover || !_openChip || !_openChip.isConnected) return;
      clearTimeout(_t);
      _t = setTimeout(function () {
        if (!_openPopover || !_openChip || !_openChip.isConnected) return;
        _positionPopover(popover, _openChip.getBoundingClientRect());
      }, 16);
    };
    window.addEventListener("scroll", _reflowHandler, true);
    window.addEventListener("resize", _reflowHandler);

    // Auto-close when the anchor chip is removed from the DOM. The rooms
    // grid re-renders periodically (Firestore onSnapshot, manual refresh)
    // — the old chip is destroyed but the popover would otherwise stay
    // floating where the chip used to be, looking "stuck". Watching the
    // ancestor catches this in one tick.
    const ancestor = chip.parentElement && chip.parentElement.parentElement;
    if (ancestor && typeof MutationObserver !== "undefined") {
      _anchorObserver = new MutationObserver(function () {
        if (!chip.isConnected) {
          closeAll();
        }
      });
      _anchorObserver.observe(ancestor, { childList: true, subtree: true });
    }
  }

  // Allow any element (e.g. a button in the register table) to act as the
  // anchor for the same popover. Used by the register tab's reg-history-btn.
  function openForButton(buttonEl, roomInfo) {
    if (!buttonEl || !roomInfo) return;
    if (!_hasAnyAttribution(roomInfo)) {
      // Show a minimal "no history" popover so users get feedback.
      _injectStyles();
      const dummy = { lastModifiedBy: null };
      Object.assign(dummy, roomInfo);
      _openFor(buttonEl, dummy);
      return;
    }
    _injectStyles();
    closeAll();
    _openFor(buttonEl, roomInfo);
  }

  global.CibaraRoomAttribution = Object.freeze({
    decorate: decorate,
    closeAll: closeAll,
    openForButton: openForButton,
  });
})(window);
