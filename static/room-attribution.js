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

  // Action key → user-facing label. One vocabulary, shared by the
  // materialised timeline and the legacy flat-field fallback.
  const _ACTION_LABEL = {
    "room.cleaning.complete":    "Cleaned by",
    "room.inspection.approve":   "Inspected by",
    "room.checkin":              "Checked in by",
    "room.checkin_time_update":  "Check-in time edited by",
    "room.transfer":             "Shifted by",
    "room.checkout":             "Checked out by",
    "room.price_update":         "Price edited by",
  };

  // ── Primary source: the materialised per-stay timeline ─────────────────
  //
  // `stay_timeline` is written as the stay happens (services/stay_timeline.py):
  // one record per lifecycle action, moved across room transfers, and frozen
  // onto the bill at checkout. It is already on the register row, so this
  // renders with no fetch and no extra Firestore reads.
  //
  // Every row is labelled with the room it happened in. That matters after a
  // transfer, where the trail legitimately spans two rooms and an unlabelled
  // list reads like corrupted data.
  function _buildRowsFromTimeline(timeline, currentRoom) {
    const rows = [];
    const multiRoom = new Set(
      timeline.map(function (e) { return String(e.room || ""); })
    ).size > 1;

    timeline.forEach(function (e) {
      let label = _ACTION_LABEL[e.action] || e.action || "Action";
      if (e.action === "room.transfer" && e.from_room && e.to_room) {
        label = "Shifted " + e.from_room + " \u2192 " + e.to_room + " by";
      } else if (e.action === "room.price_update"
                 && e.old_price != null && e.new_price != null) {
        // Naming the amounts is the point of auditing a tariff change; a bare
        // "Price edited by" tells you who to ask but not what to ask about.
        label = "Price \u20b9" + e.old_price + " \u2192 \u20b9" + e.new_price + " by";
      } else if (multiRoom && e.room) {
        // Only annotate once the trail actually spans rooms — on the common
        // single-room stay the suffix would be noise on every line.
        label += " \u00b7 Rm " + e.room;
      }
      rows.push({
        label: label,
        name:  (e.byName && String(e.byName).trim()) || _resolveName(e.by),
        when:  _relativeTime(e.at),
      });
    });
    return rows;
  }

  // ── Fallback: the flat lastXBy / xAt fields ────────────────────────────
  //
  // Only reached for stays that began before stay_timeline shipped. These
  // fields hold just the most recent occurrence of each action and the room
  // document outlives the stay, so a transferred stay can show a mixture of
  // occupants here. That is the defect the timeline exists to fix; this path
  // is kept so old rows degrade to the previous behaviour instead of going
  // blank, and it retires on its own as those stays age out.
  function _buildRowsFromEntry(info) {
    const rows = [];
    info = info || {};
    function add(who, when, label) {
      if (!who) return;
      rows.push({
        label: label,
        name:  (typeof who === "string" && who.trim()) ? _resolveName(who) : "\u2014",
        when:  _relativeTime(when),
      });
    }
    add(info.cleanedBy,             info.cleanedAt,             "Cleaned by");
    add(info.inspectedBy,           info.inspectedAt,           "Inspected by");
    add(info.lastCheckinBy,         info.lastCheckinAt,         "Checked in by");
    add(info.lastCheckinTimeEditBy, info.lastCheckinTimeEditAt, "Check-in time edited by");
    if (info.lastShiftedBy) {
      const f = info.lastShiftedFrom, t = info.lastShiftedTo;
      add(info.lastShiftedBy, info.lastShiftedAt,
          (f && t) ? ("Shifted " + f + " \u2192 " + t + " by") : "Shifted by");
    }
    add(info.lastCheckoutBy,        info.lastCheckoutAt,        "Checked out by");
    return rows;
  }

  // Pick the source for one register row. The timeline wins whenever it has
  // anything in it; an empty array means either a legacy stay or a room that
  // has genuinely had nothing happen to it yet, and the flat fields are the
  // better answer in both cases.
  function _buildRows(info) {
    info = info || {};
    const tl = Array.isArray(info.stay_timeline) ? info.stay_timeline : [];
    if (tl.length) return _buildRowsFromTimeline(tl, info.room);
    return _buildRowsFromEntry(info);
  }

  // NOTE: this popover deliberately does NOT call
  // /api/audit-logs/stay-history. That endpoint scans 500 audit documents per
  // room per transfer hop, so one popover open cost 500-1500 Firestore reads.
  // It remains the right tool for an explicit audit investigation; it is the
  // wrong price for a hover. The timeline above carries the same facts at
  // zero read cost. The old _fetchStayHistory / _entryToRow helpers that
  // called it were already unreachable and have been removed.

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

    // Rendered synchronously from data the register row already carries.
    // No fetch, no loading state that outlives a frame (see _buildRows).
    _renderBody(popover, _buildRows(roomInfo));
    _positionPopover(popover, anchor.getBoundingClientRect());

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
  // Rows come from the register entry itself: stay_timeline when present,
  // the legacy flat fields otherwise. Both are already loaded, so the
  // popover paints in one frame and costs nothing to open.
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
