/* ──────────────────────────────────────────────────────────────────────────
 * Rooms tab — Calendar view
 *
 * A day-by-day timeline of every room: who is in it now, when that stay is
 * due to end, and which confirmed bookings are arriving next. Built for the
 * lodge's 24-hour policy: a guest who checks in at 13:00 holds the room until
 * 13:00 the next day, so every bar starts and ends at a clock time, not at a
 * calendar date. That is what lets staff see at a glance whether a room will
 * actually be free when the next booking walks in.
 *
 * Data sources (nothing new on the server):
 *   • `rooms`    — the live room map script.js already keeps in memory.
 *                  An occupied room's stay runs from `checkin_time` for
 *                  (renewal_count + 1) × 24h. Past that point the guest is
 *                  overdue for renewal, drawn as a red tail up to "now".
 *   • `bookings` — booking.js's array from /get_bookings (refreshed through
 *                  its own fetchBookings so both tabs share one copy).
 *                  A booking runs from check_in_date + check_in_time to the
 *                  same clock time on check_out_date.
 *
 * Wiring:
 *   • The Grid / Calendar toggle lives in #rooms-tab's search row.
 *   • renderRooms() in script.js calls RoomCalendar.onRoomsChanged() so the
 *     timeline follows every live room update (check-in, checkout, listener
 *     pushes) without polling of its own.
 *   • Clicking a stay opens the checkout modal, a booking opens booking
 *     details, an empty day opens the new-booking form (or, for today, a
 *     check-in / book choice), and a cleaning room opens the same Quality
 *     Check popup as the card's Cleaned / Ready button. Housekeeping users
 *     can only do that last one.
 *
 * Past stays are not drawn: the room document only holds the current guest.
 * ────────────────────────────────────────────────────────────────────────── */
(function () {
  "use strict";

  const DAY_MS = 24 * 60 * 60 * 1000;
  const STORAGE_KEY = "cibara.roomsView";
  const RANGE_OPTIONS = [7, 14, 30];
  const DEFAULT_BOOKING_TIME = "12:00"; // mirrors /get_upcoming_bookings
  const STATUS_LABEL = { vacant: "Vacant", occupied: "Occupied", cleaning: "Cleaning", unknown: "No room" };
  const BOOKING_SKIP_STATUSES = new Set([
    "cancelled", "checked_in", "checked_out", "no_show",
  ]);

  // ── State ────────────────────────────────────────────────────────────────
  const state = {
    view: "grid",          // "grid" | "calendar"
    start: startOfDay(new Date()),
    days: 7,               // one week by default; 14 / 30 via the toolbar
    loadingBookings: false,
    lastMarkup: "",        // last rendered grid, so unchanged data is a no-op
  };

  // ── Small helpers ────────────────────────────────────────────────────────
  function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function addDays(d, n) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  }

  function toYMD(d) {
    return (
      d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0")
    );
  }

  // Accepts "YYYY-MM-DD HH:MM[:SS]" or "YYYY-MM-DD" (+ optional "HH:MM").
  // Parsed as LOCAL time, matching how script.js reads checkin_time.
  function parseLocal(dateStr, timeStr) {
    const d = String(dateStr || "").trim();
    if (!d) return null;
    let s = d.replace(" ", "T");
    if (timeStr && !s.includes("T")) s += "T" + String(timeStr).trim();
    if (!s.includes("T")) s += "T00:00";
    const out = new Date(s);
    return isNaN(out.getTime()) ? null : out;
  }

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function fmtTime(d) {
    return d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  }

  function fmtDateTime(d) {
    return d.toLocaleString("en-IN", {
      day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
    });
  }

  function roomSortKey(room) {
    const n = parseInt(room, 10);
    return isNaN(n) ? [1, room] : [0, n];
  }

  function sortRooms(a, b) {
    const ka = roomSortKey(a), kb = roomSortKey(b);
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    return ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0;
  }

  function isHousekeepingUser() {
    const a = window.CibaraAuth;
    return !!(a && a.isHousekeeping && a.isHousekeeping());
  }

  // ── Timeline model ───────────────────────────────────────────────────────
  // One "segment" per drawn bar. All times are Date objects (local).
  //   kind: "stay" | "overdue" | "booking"
  function staySegments(room, info, now) {
    const start = parseLocal(info.checkin_time);
    if (!start) return [];
    const nights = (Number(info.renewal_count) || 0) + 1;
    const due = new Date(start.getTime() + nights * DAY_MS);
    const guest = info.guest || {};
    const segs = [{
      kind: "stay",
      room,
      start,
      end: due,
      label: guest.name || "Guest",
      title:
        "Room " + room + " · " + (guest.name || "Guest") +
        "\nChecked in " + fmtDateTime(start) +
        "\nDue out " + fmtDateTime(due) +
        (nights > 1 ? "\nDay " + nights : "") +
        (Number(info.balance) > 0 ? "\nBalance ₹" + info.balance : ""),
    }];
    if (now > due) {
      // Whole minutes only: renders within the same minute then produce
      // identical markup, which is what lets render() skip the DOM swap.
      const nowMin = new Date(Math.floor(now.getTime() / 60000) * 60000);
      segs.push({
        kind: "overdue",
        room,
        start: due,
        end: nowMin > due ? nowMin : now,
        label: "Renewal due",
        title: "Room " + room + " · renewal due since " + fmtDateTime(due),
      });
    }
    return segs;
  }

  // Cleaning in progress: an orange bar from when housekeeping started to
  // now, so the row shows how long the room has been out of service.
  function cleaningSegment(room, info, now) {
    const start = parseLocal(info.cleaning_start_time);
    if (!start) return null;
    const nowMin = new Date(Math.floor(now.getTime() / 60000) * 60000);
    const end = nowMin > start ? nowMin : new Date(start.getTime() + 60000);
    const ready = info.cleaning_status === "ready_to_inspect";
    const mins = Math.max(0, Math.round((end - start) / 60000));
    const dur = mins < 60 ? mins + "m" : Math.floor(mins / 60) + "h " + (mins % 60) + "m";
    return {
      kind: "cleaning",
      room,
      start,
      end,
      label: (ready ? "Ready to inspect" : "Cleaning") + " · " + dur,
      title: "Room " + room + (ready ? " · cleaned, waiting for inspection" : " · being cleaned") +
             "\nSince " + fmtDateTime(start),
    };
  }

  function bookingSegment(b) {
    const status = String(b.status || "").toLowerCase();
    if (BOOKING_SKIP_STATUSES.has(status)) return null;
    const room = String(b.room || "");
    if (!room) return null;
    const time = (b.check_in_time || DEFAULT_BOOKING_TIME).slice(0, 5);
    const start = parseLocal(b.check_in_date, time);
    let end = parseLocal(b.check_out_date, time);
    if (!start) return null;
    if (!end || end <= start) end = new Date(start.getTime() + DAY_MS);
    const name = b.guest_name || b.name || "Booking";
    const src = b.booking_source && b.booking_source !== "normal"
      ? " (" + String(b.booking_source).toUpperCase() + ")" : "";
    return {
      kind: "booking",
      room,
      start,
      end,
      bookingId: b.booking_id,
      label: name,
      title:
        "Booking · Room " + room + " · " + name + src +
        "\nArrives " + fmtDateTime(start) +
        "\nLeaves " + fmtDateTime(end) +
        (Number(b.balance) > 0 ? "\nBalance ₹" + b.balance : ""),
    };
  }

  // Flags bookings that overlap the live stay (incl. its overdue tail) or
  // another booking in the same room. That is the case staff must act on:
  // either move the booking or make sure the current guest leaves in time.
  function markClashes(segments) {
    for (let i = 0; i < segments.length; i++) {
      for (let j = i + 1; j < segments.length; j++) {
        const a = segments[i], b = segments[j];
        if (a.room !== b.room) continue;
        if (a.kind !== "booking" && b.kind !== "booking") continue;
        if (a.start < b.end && b.start < a.end) {
          a.clash = b.clash = true;
        }
      }
    }
  }

  function buildTimeline(rooms, bookings, now) {
    const byRoom = {};
    const segments = [];

    Object.keys(rooms || {}).forEach(function (room) {
      const info = rooms[room] || {};
      byRoom[room] = { status: info.status || "vacant", segments: [] };
      if (info.status === "occupied") {
        staySegments(room, info, now).forEach(function (s) { segments.push(s); });
      } else if (info.status === "cleaning") {
        const c = cleaningSegment(room, info, now);
        if (c) segments.push(c);
      }
    });

    (bookings || []).forEach(function (b) {
      const seg = bookingSegment(b);
      if (!seg) return;
      // A booking for a room that no longer exists still deserves a row,
      // otherwise it would silently vanish from the plan.
      if (!byRoom[seg.room]) byRoom[seg.room] = { status: "unknown", segments: [] };
      segments.push(seg);
    });

    markClashes(segments);
    segments.forEach(function (s) { byRoom[s.room].segments.push(s); });
    Object.keys(byRoom).forEach(function (room) {
      byRoom[room].segments.sort(function (a, b) { return a.start - b.start; });
    });
    return byRoom;
  }

  // ── Rendering ────────────────────────────────────────────────────────────
  function el(id) { return document.getElementById(id); }

  function container() { return el("rooms-calendar"); }

  function pct(ms, totalMs) {
    return (ms / totalMs) * 100;
  }

  function renderHeader(viewStart, days, today) {
    let html = '<div class="rc-corner">Room</div>';
    for (let i = 0; i < days; i++) {
      const d = addDays(viewStart, i);
      const isToday = d.getTime() === today.getTime();
      const isWeekend = d.getDay() === 0 || d.getDay() === 6;
      html +=
        '<div class="rc-day' + (isToday ? " rc-day--today" : "") +
        (isWeekend ? " rc-day--weekend" : "") + '">' +
        '<span class="rc-day-dow">' +
        d.toLocaleDateString("en-IN", { weekday: "short" }) + "</span>" +
        '<span class="rc-day-num">' + d.getDate() + "</span>" +
        (i === 0 || d.getDate() === 1
          ? '<span class="rc-day-mon">' +
            d.toLocaleDateString("en-IN", { month: "short" }) + "</span>"
          : "") +
        "</div>";
    }
    return html;
  }

  function renderBar(seg, viewStart, totalMs) {
    const viewEnd = viewStart.getTime() + totalMs;
    const s = Math.max(seg.start.getTime(), viewStart.getTime());
    const e = Math.min(seg.end.getTime(), viewEnd);
    if (e <= s) return "";
    const left = pct(s - viewStart.getTime(), totalMs);
    const width = pct(e - s, totalMs);
    const cls =
      "rc-bar rc-bar--" + seg.kind +
      (seg.clash ? " rc-bar--clash" : "") +
      (seg.start.getTime() < viewStart.getTime() ? " rc-bar--cut-l" : "") +
      (seg.end.getTime() > viewEnd ? " rc-bar--cut-r" : "");
    const data =
      ' data-kind="' + seg.kind + '" data-room="' + esc(seg.room) + '"' +
      (seg.bookingId ? ' data-booking-id="' + esc(seg.bookingId) + '"' : "");
    return (
      '<div class="' + cls + '" style="left:' + left.toFixed(3) +
      "%;width:" + width.toFixed(3) + '%"' + data +
      ' title="' + esc(seg.title) + '" tabindex="0" role="button">' +
      (seg.clash ? '<i class="fas fa-exclamation-triangle rc-bar-warn"></i>' : "") +
      '<span class="rc-bar-label">' + esc(seg.label) + "</span>" +
      '<span class="rc-bar-time">' + fmtTime(seg.start) + "</span>" +
      "</div>"
    );
  }

  // Who cleaned / who inspected in the current prep cycle, as two initials,
  // the same marks the grid card shows in its corners. Reads the room's
  // stay_timeline through script.js's helpers so both views agree.
  function prepEvent(info, action) {
    return typeof _rmPrepEvent === "function" ? _rmPrepEvent(info, action) : null;
  }
  function prepName(ev) {
    return typeof _rmName === "function" ? _rmName(ev) : String((ev && (ev.byName || ev.by)) || "");
  }
  function prepMarks(info) {
    if (!info || (info.status !== "vacant" && info.status !== "cleaning")) return "";
    const cleanAction = typeof RM_CLEAN_ACTION !== "undefined" ? RM_CLEAN_ACTION : "room.cleaning.complete";
    const inspectAction = typeof RM_INSPECT_ACTION !== "undefined" ? RM_INSPECT_ACTION : "room.inspection.approve";
    function mark(side, verb, ev) {
      if (!ev) return "";
      const name = prepName(ev) || "\u2014";
      const when = ev.at ? String(ev.at).slice(0, 16).replace("T", " ") : "";
      return '<span class="rc-init rc-init--' + side + '" title="' +
             esc(verb + ": " + name + (when ? " \u00b7 " + when : "")) + '">' +
             esc(name.trim().charAt(0).toUpperCase() || "?") + "</span>";
    }
    const html =
      mark("l", "Cleaned by", prepEvent(info, cleanAction)) +
      mark("r", "Inspected by", prepEvent(info, inspectAction));
    return html ? '<span class="rc-inits">' + html + "</span>" : "";
  }

  function renderRow(room, entry, viewStart, days, totalMs, today) {
    let cells = "";
    for (let i = 0; i < days; i++) {
      const d = addDays(viewStart, i);
      cells +=
        '<div class="rc-cell' + (d.getTime() === today.getTime() ? " rc-cell--today" : "") +
        '" data-room="' + esc(room) + '" data-date="' + toYMD(d) + '"></div>';
    }
    const bars = entry.segments
      .map(function (s) { return renderBar(s, viewStart, totalMs); })
      .join("");
    const clashCount = entry.segments.filter(function (s) { return s.clash; }).length;
    return (
      '<div class="rc-row" data-room="' + esc(room) + '">' +
      '<div class="rc-room rc-room--' + esc(entry.status) + '" data-room="' + esc(room) + '" title="' +
      esc("Room " + room + " · " + entry.status) + '">' +
      '<span class="rc-room-num">' + esc(room) + "</span>" +
      '<span class="rc-room-state">' + esc(STATUS_LABEL[entry.status] || entry.status) + "</span>" +
      prepMarks((window.rooms || {})[room]) +
      (clashCount ? '<span class="rc-room-clash" title="Overlapping booking">!</span>' : "") +
      "</div>" +
      '<div class="rc-track" style="grid-column: 2 / span ' + days + '">' +
      '<div class="rc-cells">' + cells + "</div>" +
      bars +
      "</div>" +
      "</div>"
    );
  }

  function renderNowLine(viewStart, totalMs, now) {
    const off = now.getTime() - viewStart.getTime();
    if (off < 0 || off > totalMs) return "";
    return (
      '<div class="rc-now" style="left:' + pct(off, totalMs).toFixed(3) +
      '%" title="Now · ' + esc(fmtTime(now)) + '"></div>'
    );
  }

  function renderToolbar(viewStart, days) {
    const end = addDays(viewStart, days - 1);
    const rangeLabel =
      viewStart.toLocaleDateString("en-IN", { day: "numeric", month: "short" }) +
      " – " +
      end.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
    return (
      '<div class="rc-toolbar">' +
      '<div class="rc-nav">' +
      '<button type="button" class="rc-btn" data-rc="prev" aria-label="Earlier"><i class="fas fa-chevron-left"></i></button>' +
      '<button type="button" class="rc-btn rc-btn--today" data-rc="today">Today</button>' +
      '<button type="button" class="rc-btn" data-rc="next" aria-label="Later"><i class="fas fa-chevron-right"></i></button>' +
      '<span class="rc-range">' + esc(rangeLabel) + "</span>" +
      "</div>" +
      '<div class="rc-days">' +
      RANGE_OPTIONS.map(function (n) {
        return (
          '<button type="button" class="rc-btn rc-btn--days' +
          (n === days ? " active" : "") + '" data-rc="days" data-days="' + n + '">' +
          n + "d</button>"
        );
      }).join("") +
      '<button type="button" class="rc-btn" data-rc="refresh" aria-label="Refresh bookings" title="Refresh bookings"><i class="fas fa-sync-alt"></i></button>' +
      "</div>" +
      "</div>"
    );
  }

  function renderLegend() {
    const item = function (cls, text) {
      return "<span><i class=\"rc-swatch rc-swatch--" + cls + "\"></i>" + text + "</span>";
    };
    return (
      '<div class="rc-legend">' +
      item("vacant", "Vacant") +
      item("occupied", "Occupied (in house)") +
      item("cleaning", "Cleaning (tap to mark)") +
      item("booking", "Booking (arriving)") +
      item("overdue", "Renewal due") +
      item("clash", "Overlap (needs attention)") +
      item("now", "Now") +
      "</div>"
    );
  }

  // Called on every live room push (renderRooms), on the minute tick and on
  // navigation. Rebuilding the DOM each time reset the scroll position and
  // yanked the page to the top, so this diffs first: if nothing but the
  // "now" line moved, only that line is touched; if the grid did change, the
  // scroll offsets are carried across the swap.
  function render() {
    const host = container();
    if (!host || state.view !== "calendar") return;

    const now = new Date();
    const today = startOfDay(now);
    const viewStart = state.start;
    const days = state.days;
    const totalMs = days * DAY_MS;

    const rooms = window.rooms || {};
    const bookings = currentBookings();
    const timeline = buildTimeline(rooms, bookings, now);
    const roomNames = Object.keys(timeline).sort(sortRooms);

    let grid = "";
    roomNames.forEach(function (room) {
      grid += renderRow(room, timeline[room], viewStart, days, totalMs, today);
    });
    const nowLine = renderNowLine(viewStart, totalMs, now);

    const markup =
      renderToolbar(viewStart, days) +
      (roomNames.length
        ? '<div class="rc-scroll"><div class="rc-grid" style="--rc-days:' + days + '">' +
          '<div class="rc-header">' + renderHeader(viewStart, days, today) + "</div>" +
          grid +
          '<div class="rc-now-layer"></div>' +
          "</div></div>"
        : '<div class="empty-state"><i class="fas fa-bed fa-3x"></i><p>No rooms yet</p></div>') +
      renderLegend() +
      (state.loadingBookings ? '<div class="rc-status">Loading bookings…</div>' : "");

    const nowLayer = host.querySelector(".rc-now-layer");
    if (markup === state.lastMarkup && nowLayer) {
      nowLayer.innerHTML = nowLine;      // only the clock moved
      return;
    }

    const scroller = host.querySelector(".rc-scroll");
    const keep = scroller
      ? { left: scroller.scrollLeft, top: scroller.scrollTop }
      : null;
    // Hold the height while the subtree is swapped, so the document never
    // shrinks for a frame and the browser never clamps the page scroll.
    host.style.minHeight = host.offsetHeight + "px";

    closeDayMenu();
    host.innerHTML = markup;
    state.lastMarkup = markup;
    const freshNowLayer = host.querySelector(".rc-now-layer");
    if (freshNowLayer) freshNowLayer.innerHTML = nowLine;

    const freshScroller = host.querySelector(".rc-scroll");
    if (freshScroller && keep) {
      freshScroller.scrollLeft = keep.left;
      freshScroller.scrollTop = keep.top;
    }
    host.style.minHeight = "";
  }

  // ── Bookings source ──────────────────────────────────────────────────────
  // booking.js owns the `bookings` array (top-level let, shared across
  // classic scripts). Reusing it keeps one copy of the data on the page.
  function currentBookings() {
    try {
      // eslint-disable-next-line no-undef
      return typeof bookings !== "undefined" && Array.isArray(bookings) ? bookings : [];
    } catch (_e) {
      return [];
    }
  }

  async function refreshBookings() {
    if (state.loadingBookings) return;
    state.loadingBookings = true;
    render();
    try {
      if (typeof fetchBookings === "function") {
        await fetchBookings();
      }
    } catch (e) {
      console.warn("RoomCalendar: bookings refresh failed", e);
    } finally {
      state.loadingBookings = false;
      render();
    }
  }

  // ── Interaction ──────────────────────────────────────────────────────────
  function openNewBookingFor(room, dateStr) {
    if (typeof showNewBookingModalForDate !== "function") return;
    showNewBookingModalForDate(dateStr);
    // The form fills its room <select> asynchronously after an availability
    // check; pick this room as soon as it appears, then stop watching.
    const select = el("booking-room");
    if (!select || !window.MutationObserver) return;
    const stopAt = Date.now() + 8000;
    const obs = new MutationObserver(function () {
      const opt = select.querySelector('option[value="' + CSS.escape(room) + '"]');
      if (opt) {
        select.value = room;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        obs.disconnect();
      } else if (Date.now() > stopAt) {
        obs.disconnect();
      }
    });
    obs.observe(select, { childList: true, subtree: true });
  }

  function onCalendarClick(e) {
    const btn = e.target.closest("[data-rc]");
    if (btn) {
      closeDayMenu();
      switch (btn.dataset.rc) {
        case "prev":   state.start = addDays(state.start, -state.days); break;
        case "next":   state.start = addDays(state.start, state.days); break;
        case "today":  state.start = startOfDay(new Date()); break;
        case "days":   state.days = Number(btn.dataset.days) || state.days; break;
        case "refresh": refreshBookings(); return;
      }
      render();
      return;
    }

    // Cleaning rooms: the room label, the orange bar and today's cell all
    // open the Quality Check popup. Housekeeping may do this (it is their
    // job); everything below stays off-limits to them, as on the grid.
    const roomCell = e.target.closest(".rc-room");
    const bar = e.target.closest(".rc-bar");
    const cell = e.target.closest(".rc-cell");
    const tappedRoom = (roomCell || bar || cell || {}).dataset
      ? (roomCell || bar || cell).dataset.room : null;
    if (tappedRoom && ((window.rooms || {})[tappedRoom] || {}).status === "cleaning") {
      if (bar && bar.dataset.kind === "booking") {
        if (!isHousekeepingUser() && typeof showBookingDetails === "function") {
          showBookingDetails(bar.dataset.bookingId);
        }
        return;
      }
      if (!cell || cell.dataset.date === toYMD(new Date())) {
        openCleaningCheck(tappedRoom);
        return;
      }
    }

    if (isHousekeepingUser()) return;

    if (roomCell) {
      // Room label behaves like the card: occupied → checkout, vacant → today's menu.
      const info = (window.rooms || {})[roomCell.dataset.room] || {};
      if (info.status === "occupied" && typeof showCheckoutModal === "function") {
        if (typeof prefetchPaymentLogs === "function") prefetchPaymentLogs(roomCell.dataset.room);
        showCheckoutModal(roomCell.dataset.room);
      } else if (info.status === "vacant") {
        openDayMenu(roomCell, roomCell.dataset.room);
      }
      return;
    }

    if (bar) {
      const room = bar.dataset.room;
      if (bar.dataset.kind === "booking") {
        if (typeof showBookingDetails === "function") showBookingDetails(bar.dataset.bookingId);
      } else if (typeof showCheckoutModal === "function") {
        if (typeof prefetchPaymentLogs === "function") prefetchPaymentLogs(room);
        showCheckoutModal(room);
      }
      return;
    }

    if (cell) {
      const today = toYMD(new Date());
      const room = cell.dataset.room;
      const date = cell.dataset.date;
      if (date < today) {
        if (typeof showNotification === "function") {
          showNotification("Bookings cannot be made for past dates", "info");
        }
        return;
      }
      if (date === today) {
        openDayMenu(cell, room);          // check in now, or book for later
      } else {
        openNewBookingFor(room, date);
      }
    }
  }

  // ── Same-day action menu ─────────────────────────────────────────────────
  // Today's empty slot can mean two things: the guest is standing at the
  // desk (check in now, the same form the grid card opens) or someone is
  // reserving for later today (booking). Ask rather than guess. Check-in is
  // offered only when the room is actually vacant; the server enforces it too.
  function closeDayMenu() {
    const m = document.querySelector(".rc-menu");
    if (m) m.remove();
    document.removeEventListener("pointerdown", onOutsideMenu, true);
    document.removeEventListener("keydown", onMenuKey, true);
  }

  function onOutsideMenu(e) {
    if (!e.target.closest(".rc-menu")) closeDayMenu();
  }

  function onMenuKey(e) {
    if (e.key === "Escape") closeDayMenu();
  }

  // Cleaning room tapped: run the very same flow as the card's Cleaned /
  // Ready button (room-cleaning.js), which opens the Quality Check popup
  // for the room. Role gating mirrors the card: admin/manager always,
  // housekeeping only while the room is still in progress.
  function openCleaningCheck(room) {
    const info = (window.rooms || {})[room] || {};
    const auth = window.CibaraAuth;
    const can = function (p) { return !!(auth && auth.userCan && auth.userCan(p)); };
    const ready = info.cleaning_status === "ready_to_inspect";
    const allowed = can("room.inspection.approve") || (can("room.cleaning.complete") && !ready);
    if (!allowed) {
      if (typeof showNotification === "function") {
        showNotification(ready ? "Waiting for a manager to inspect" : "Room is being cleaned", "info");
      }
      return;
    }
    if (typeof markRoomAsCleaned === "function") markRoomAsCleaned(String(room));
  }

  function placeMenu(menu, anchor) {
    const host = container();
    const hostBox = host.getBoundingClientRect();
    const box = anchor.getBoundingClientRect();
    menu.style.top = (box.bottom - hostBox.top + 4) + "px";
    menu.style.left = Math.max(0, Math.min(box.left - hostBox.left, hostBox.width - 300)) + "px";
    host.appendChild(menu);
    const first = menu.querySelector("button:not([disabled])");
    if (first) first.focus();
    setTimeout(function () {
      document.addEventListener("pointerdown", onOutsideMenu, true);
      document.addEventListener("keydown", onMenuKey, true);
    }, 0);
  }

  function openDayMenu(cell, room) {
    closeDayMenu();
    const info = (window.rooms || {})[room] || {};
    const canCheckin = info.status === "vacant" && typeof showCheckinModal === "function";
    const why =
      info.status === "cleaning" ? "Room is being cleaned" :
      info.status === "occupied" ? "Room is occupied" : "";

    const menu = document.createElement("div");
    menu.className = "rc-menu";
    menu.setAttribute("role", "menu");
    menu.innerHTML =
      '<div class="rc-menu-title">Room ' + esc(room) + " · Today</div>" +
      '<button type="button" class="rc-menu-item" data-act="checkin"' +
      (canCheckin ? "" : ' disabled title="' + esc(why) + '"') + ">" +
      '<i class="fas fa-sign-in-alt"></i><span>Check in now</span>' +
      (canCheckin ? "" : '<small>' + esc(why) + "</small>") +
      "</button>" +
      '<button type="button" class="rc-menu-item" data-act="book">' +
      '<i class="fas fa-calendar-plus"></i><span>Book for later today</span></button>';

    menu.addEventListener("click", function (e) {
      const item = e.target.closest("[data-act]");
      if (!item || item.disabled) return;
      const act = item.dataset.act;
      closeDayMenu();
      if (act === "checkin") showCheckinModal(room);
      else openNewBookingFor(room, toYMD(new Date()));
    });

    // Anchored under the tapped cell on wide screens; on phones the CSS
    // turns it into a bottom sheet and ignores the coordinates.
    placeMenu(menu, cell);
  }

  function onCalendarKey(e) {
    if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("rc-bar")) {
      e.preventDefault();
      e.target.click();
    }
  }

  // ── View switching ───────────────────────────────────────────────────────
  function setView(view, opts) {
    if (view !== "grid" && view !== "calendar") view = "grid";
    state.view = view;

    const grid = el("rooms-grid");
    const cal = container();
    const tab = el("rooms-tab");
    if (grid) grid.classList.toggle("hidden", view === "calendar");
    if (cal) cal.classList.toggle("hidden", view !== "calendar");
    // The Vacant/Occupied/Balances chips only shape the grid. In calendar
    // mode room-calendar.css hides them and keeps the "more" (⋮) button
    // pinned to the right edge, so its dropdown still opens on-screen.
    if (tab) tab.classList.toggle("rooms-tab--calendar", view === "calendar");

    document.querySelectorAll(".rooms-view-btn").forEach(function (b) {
      const on = b.dataset.view === view;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });

    if (!(opts && opts.silent)) {
      try { localStorage.setItem(STORAGE_KEY, view); } catch (_e) { /* private mode */ }
    }

    if (view === "calendar") {
      state.lastMarkup = "";
      render();
      refreshBookings();
    }
  }

  function restoreView() {
    let saved = "grid";
    try { saved = localStorage.getItem(STORAGE_KEY) || "grid"; } catch (_e) { /* ignore */ }
    setView(saved, { silent: true });
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  function init() {
    const host = container();
    if (!host) return;

    document.querySelectorAll(".rooms-view-btn").forEach(function (b) {
      b.addEventListener("click", function () { setView(b.dataset.view); });
    });
    host.addEventListener("click", onCalendarClick);
    host.addEventListener("keydown", onCalendarKey);

    // Keep the "now" line and overdue tails honest without a server call.
    setInterval(function () {
      if (state.view === "calendar" && !document.hidden) render();
    }, 60 * 1000);

    restoreView();
  }

  window.RoomCalendar = {
    setView: setView,
    refresh: refreshBookings,
    // Called by renderRooms() whenever the live room map changes.
    onRoomsChanged: function () { if (state.view === "calendar") render(); },
    // Exposed for tests / debugging only.
    _buildTimeline: buildTimeline,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
