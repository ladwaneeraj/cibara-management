/* ─────────────────────────────────────────────────────────────────────────
 * Guest requests (QR room-service portal): the staff side of the screen.
 *
 *   • Badge on the header bell = number of open + acknowledged requests.
 *   • Panel lists them newest first; Acknowledge / Done go through Flask
 *     (audited). Housekeeping only ever receives its own team's requests
 *     (google_sync.js filters the listener; firestore.rules enforce it).
 *   • A request that was not in the previous snapshot rings a chime and
 *     shows a toast on EVERY open staff screen at once, because every
 *     screen holds the same listener.
 *   • Admin: the portal settings modal (switch, Wi-Fi, reception phone,
 *     house rules, which request kinds are on) and the printable QR.
 *
 * Data arrives from google_sync.js as `cibaraGuestRequests` events; this
 * file never talks to Firestore itself. Field names mirror
 * services/guest_portal.py and firestore.rules.
 * ──────────────────────────────────────────────────────────────────── */

(function (global) {
  "use strict";

  const KIND_META = {
    room_service:   { label: "Room service",     icon: "fa-utensils" },
    housekeeping:   { label: "Housekeeping",     icon: "fa-broom" },
    extra_items:    { label: "Extra items",      icon: "fa-bed" },
    laundry:        { label: "Laundry pickup",   icon: "fa-tshirt" },
    maintenance:    { label: "Something broken", icon: "fa-wrench" },
    wake_up:        { label: "Wake-up call",     icon: "fa-clock" },
    late_checkout:  { label: "Late checkout",    icon: "fa-hourglass-half" },
    taxi:           { label: "Taxi / cab",       icon: "fa-taxi" },
    do_not_disturb: { label: "Do not disturb",   icon: "fa-moon" },
    complaint:      { label: "Talk to manager",  icon: "fa-comment-dots" },
  };
  const KIND_ORDER = Object.keys(KIND_META);

  let _items = [];            // current active requests (from the listener)
  let _knownIds = null;       // ids seen in the previous snapshot; null = none yet
  let _panelOpen = false;
  let _busy = new Set();      // request ids with an in-flight status change
  let _settings = null;       // admin settings cache (settings modal)
  let _view = "live";         // "live" | "history"
  let _historyDays = 7;
  let _history = null;        // { requests, feedback, summary } from Flask
  let _historyLoading = false;

  // ── Tiny helpers ────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function notify(msg, type, ms) {
    if (typeof global.showNotification === "function") return global.showNotification(msg, type || "info", ms || 5000);
    console.log("[guest-requests]", type || "info", msg);
  }
  function duration(sec) {
    if (sec == null || isNaN(sec)) return "";
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return sec + "s";
    const m = Math.floor(sec / 60);
    if (m < 60) return m + " min";
    const h = Math.floor(m / 60);
    return h + " h " + (m % 60) + " min";
  }
  function timeAgo(ms) {
    if (!ms) return "";
    const sec = (Date.now() - ms) / 1000;
    return sec < 45 ? "just now" : duration(sec) + " ago";
  }
  function clock(ms) {
    if (!ms) return "";
    return new Date(ms).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  }
  function kindLabel(kind) { return (KIND_META[kind] || { label: kind }).label; }
  function kindIcon(kind) { return (KIND_META[kind] || { icon: "fa-bell" }).icon; }
  function api(url, init) {
    const f = global.apiFetch || global.fetch;
    return f(url, init).then(function (r) {
      return r.json().catch(function () { return { success: false, message: "HTTP " + r.status }; })
        .then(function (body) {
          if (!r.ok || body.success === false) throw new Error(body.message || ("HTTP " + r.status));
          return body;
        });
    });
  }

  // ── Chime (no audio file; two short tones like a front-desk bell) ───────
  let _audioCtx = null;
  function chime() {
    try {
      const Ctx = global.AudioContext || global.webkitAudioContext;
      if (!Ctx) return;
      if (!_audioCtx) _audioCtx = new Ctx();
      if (_audioCtx.state === "suspended") _audioCtx.resume().catch(function () {});
      [[880, 0], [1175, 0.18]].forEach(function (t) {
        const osc = _audioCtx.createOscillator();
        const gain = _audioCtx.createGain();
        osc.type = "sine";
        osc.frequency.value = t[0];
        const at = _audioCtx.currentTime + t[1];
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.35, at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.45);
        osc.connect(gain).connect(_audioCtx.destination);
        osc.start(at);
        osc.stop(at + 0.5);
      });
    } catch (_) { /* audio is a nicety */ }
  }
  // Browsers only let audio start after a user gesture: warm the context on
  // the first tap anywhere so the chime for the NEXT request is audible.
  ["click", "touchstart", "keydown"].forEach(function (ev) {
    document.addEventListener(ev, function warm() {
      try {
        const Ctx = global.AudioContext || global.webkitAudioContext;
        if (Ctx && !_audioCtx) _audioCtx = new Ctx();
        if (_audioCtx && _audioCtx.state === "suspended") _audioCtx.resume().catch(function () {});
      } catch (_) {}
      document.removeEventListener(ev, warm);
    }, { passive: true });
  });

  function desktopNotify(req) {
    try {
      if (!("Notification" in global) || Notification.permission !== "granted") return;
      if (document.visibilityState === "visible" && _panelOpen) return;
      const n = new Notification("Room " + req.room + ": " + kindLabel(req.kind), {
        body: req.note || "New guest request",
        tag: "guest-request-" + req.id,
      });
      n.onclick = function () { global.focus(); openPanel(); n.close(); };
    } catch (_) { /* optional */ }
  }

  // ── Badge + panel rendering ─────────────────────────────────────────────
  function renderBadge() {
    const badge = document.getElementById("guest-requests-badge");
    const btn = document.getElementById("guest-requests-btn");
    if (!badge || !btn) return;
    const n = _items.length;
    badge.textContent = n > 99 ? "99+" : String(n);
    badge.hidden = n === 0;
    btn.classList.toggle("has-requests", n > 0);
    btn.classList.toggle("has-open", _items.some(function (r) { return r.status === "open"; }));
  }

  function ensurePanel() {
    let panel = document.getElementById("guest-requests-panel");
    if (panel) return panel;
    panel = document.createElement("div");
    panel.id = "guest-requests-panel";
    panel.className = "gr-panel";
    panel.hidden = true;
    panel.innerHTML =
      '<div class="gr-panel-backdrop"></div>' +
      '<aside class="gr-panel-body" role="dialog" aria-labelledby="gr-title" aria-modal="true">' +
        '<header class="gr-panel-head">' +
          '<h2 id="gr-title"><i class="fas fa-concierge-bell"></i> Guest requests</h2>' +
          '<button type="button" class="close-btn" id="gr-close" aria-label="Close">&times;</button>' +
        '</header>' +
        '<div class="gr-tabs" role="tablist">' +
          '<button type="button" class="gr-tab active" data-view="live" role="tab">Live</button>' +
          '<button type="button" class="gr-tab" data-view="history" role="tab">History</button>' +
          '<span class="gr-tabs-spacer"></span>' +
          '<select id="gr-days" class="gr-days" hidden aria-label="History range">' +
            '<option value="1">Today</option><option value="7" selected>7 days</option>' +
            '<option value="30">30 days</option><option value="90">90 days</option>' +
          '</select>' +
        '</div>' +
        '<div class="gr-list" id="gr-list"></div>' +
      '</aside>';
    document.body.appendChild(panel);
    panel.querySelector(".gr-panel-backdrop").addEventListener("click", closePanel);
    panel.querySelector("#gr-close").addEventListener("click", closePanel);
    panel.querySelector("#gr-list").addEventListener("click", onListClick);
    panel.querySelectorAll(".gr-tab").forEach(function (t) {
      t.addEventListener("click", function () { setView(t.getAttribute("data-view")); });
    });
    panel.querySelector("#gr-days").addEventListener("change", function (e) {
      _historyDays = parseInt(e.target.value, 10) || 7;
      loadHistory();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && _panelOpen) closePanel();
    });
    return panel;
  }

  function renderList() {
    const list = document.getElementById("gr-list");
    if (!list) return;
    if (_items.length === 0) {
      list.innerHTML = '<div class="gr-empty"><i class="fas fa-check-circle"></i>No open requests. Guests scan the room QR to ask for things; they land here.</div>';
      return;
    }
    const sorted = _items.slice().sort(function (a, b) {
      if (a.status !== b.status) return a.status === "open" ? -1 : 1;
      return (b.createdAtMs || 0) - (a.createdAtMs || 0);
    });
    list.innerHTML = sorted.map(function (r) {
      const busy = _busy.has(r.id);
      const acked = r.status === "acknowledged";
      return (
        '<article class="gr-item gr-' + esc(r.status) + '" data-id="' + esc(r.id) + '">' +
          '<div class="gr-item-room">' + esc(r.room) + '</div>' +
          '<div class="gr-item-main">' +
            '<div class="gr-item-kind"><i class="fas ' + kindIcon(r.kind) + '"></i> ' + esc(kindLabel(r.kind)) +
              (acked ? ' <span class="gr-pill">seen by ' + esc(r.acknowledgedBy || "staff") + "</span>" : ' <span class="gr-pill gr-pill-new">new</span>') +
            "</div>" +
            (r.guestName ? '<div class="gr-item-guest">' + esc(r.guestName) + "</div>" : "") +
            (r.note ? '<div class="gr-item-note">' + esc(r.note) + "</div>" : "") +
            '<div class="gr-item-meta" data-ms="' + (r.createdAtMs || 0) + '" data-ack="' + (r.acknowledgedAtMs || 0) + '">' + esc(liveMeta(r)) + "</div>" +
          "</div>" +
          '<div class="gr-item-actions">' +
            (acked ? "" : '<button type="button" class="gr-btn gr-btn-ack" data-action="acknowledge"' + (busy ? " disabled" : "") + ">Seen</button>") +
            '<button type="button" class="gr-btn gr-btn-done" data-action="done"' + (busy ? " disabled" : "") + ">Done</button>" +
          "</div>" +
        "</article>"
      );
    }).join("");
  }

  // "asked 4 min ago · waiting 4 min" or "asked 9 min ago · seen after 2 min · open 7 min"
  function liveMeta(r) {
    const created = r.createdAtMs || 0;
    const ack = r.acknowledgedAtMs || 0;
    let out = "asked " + timeAgo(created);
    if (ack) out += " · seen after " + duration((ack - created) / 1000) + " · open " + duration((Date.now() - ack) / 1000);
    else out += " · waiting " + duration((Date.now() - created) / 1000);
    return out;
  }
  function refreshTimes() {
    if (_view !== "live") return;
    document.querySelectorAll("#gr-list .gr-item-meta[data-ms]").forEach(function (el) {
      el.textContent = liveMeta({
        createdAtMs: parseInt(el.getAttribute("data-ms"), 10) || 0,
        acknowledgedAtMs: parseInt(el.getAttribute("data-ack"), 10) || 0,
      });
    });
  }
  setInterval(refreshTimes, 30000);

  function setView(view) {
    _view = view;
    const panel = document.getElementById("guest-requests-panel");
    if (!panel) return;
    panel.querySelectorAll(".gr-tab").forEach(function (t) {
      t.classList.toggle("active", t.getAttribute("data-view") === view);
    });
    panel.querySelector("#gr-days").hidden = view !== "history";
    if (view === "history") loadHistory(); else renderList();
  }

  function loadHistory() {
    _historyLoading = true;
    renderHistory();
    api("/api/guest-requests/history?days=" + _historyDays).then(function (body) {
      _history = body;
    }).catch(function (err) {
      notify("Could not load history: " + err.message, "error");
    }).then(function () {
      _historyLoading = false;
      renderHistory();
    });
  }

  function renderHistory() {
    const list = document.getElementById("gr-list");
    if (!list || _view !== "history") return;
    if (_historyLoading && !_history) { list.innerHTML = '<div class="gr-empty">Loading…</div>'; return; }
    const h = _history || { requests: [], feedback: [], summary: {} };
    const sm = h.summary || {};
    const stars = function (n) { return "★★★★★".slice(0, n) + "☆☆☆☆☆".slice(0, 5 - n); };
    const head =
      '<div class="gr-summary">' +
        stat(sm.total || 0, "requests") +
        stat(sm.done || 0, "done") +
        stat(sm.avgResponseSec != null ? duration(sm.avgResponseSec) : "–", "avg to seen") +
        stat(sm.avgCompletionSec != null ? duration(sm.avgCompletionSec) : "–", "avg to done") +
        stat(sm.avgRating != null ? sm.avgRating + " ★" : "–", "stay rating") +
      "</div>";
    const rows = (h.requests || []).map(function (r) {
      const st = r.status || "open";
      let trail = "asked " + clock(r.createdAtMs);
      if (r.acknowledgedAtMs) trail += " · seen by " + esc(r.acknowledgedBy || "staff") + " after " + duration(r.responseSec);
      if (r.doneAtMs) trail += " · done by " + esc(r.doneBy || "staff") + " after " + duration(r.completionSec);
      if (st === "cancelled") trail += " · cancelled by guest";
      return (
        '<article class="gr-item gr-hist gr-' + esc(st) + '">' +
          '<div class="gr-item-room">' + esc(r.room) + "</div>" +
          '<div class="gr-item-main">' +
            '<div class="gr-item-kind"><i class="fas ' + kindIcon(r.kind) + '"></i> ' + esc(kindLabel(r.kind)) +
              ' <span class="gr-pill gr-pill-' + esc(st) + '">' + esc(st) + "</span></div>" +
            (r.guestName ? '<div class="gr-item-guest">' + esc(r.guestName) + "</div>" : "") +
            (r.note ? '<div class="gr-item-note">' + esc(r.note) + "</div>" : "") +
            '<div class="gr-item-meta">' + trail + "</div>" +
          "</div>" +
        "</article>"
      );
    }).join("");
    const fb = (h.feedback || []).map(function (f) {
      return (
        '<article class="gr-item gr-hist gr-feedback">' +
          '<div class="gr-item-room">' + esc(f.room) + "</div>" +
          '<div class="gr-item-main">' +
            '<div class="gr-item-kind"><span class="gr-stars">' + stars(f.rating || 0) + "</span> " + esc(f.guestName || "") + "</div>" +
            (f.comment ? '<div class="gr-item-note">' + esc(f.comment) + "</div>" : "") +
            '<div class="gr-item-meta">' + clock(f.createdAtMs) + "</div>" +
          "</div>" +
        "</article>"
      );
    }).join("");
    list.innerHTML = head +
      (rows || '<div class="gr-empty">No requests in this range.</div>') +
      (fb ? '<h3 class="gr-h3">Stay ratings</h3>' + fb : "");

    function stat(v, l) { return '<div class="gr-stat"><b>' + esc(v) + "</b><span>" + esc(l) + "</span></div>"; }
  }

  function onListClick(e) {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const item = btn.closest(".gr-item");
    const id = item && item.getAttribute("data-id");
    if (!id || _busy.has(id)) return;
    _busy.add(id);
    renderList();
    api("/api/guest-requests/" + encodeURIComponent(id) + "/" + btn.getAttribute("data-action"), { method: "POST" })
      .then(function () {
        // The listener will repaint with the real state; nothing to patch.
      })
      .catch(function (err) {
        notify("Could not update the request: " + err.message, "error");
      })
      .then(function () {
        _busy.delete(id);
        renderList();
      });
  }

  function openPanel() {
    const panel = ensurePanel();
    panel.hidden = false;
    _panelOpen = true;
    document.body.classList.add("gr-panel-open");
    if (_view === "history") loadHistory(); else renderList();
    try {
      if ("Notification" in global && Notification.permission === "default") {
        Notification.requestPermission().catch(function () {});
      }
    } catch (_) {}
  }
  function closePanel() {
    const panel = document.getElementById("guest-requests-panel");
    if (panel) panel.hidden = true;
    _panelOpen = false;
    document.body.classList.remove("gr-panel-open");
  }

  // ── Listener feed ───────────────────────────────────────────────────────
  global.addEventListener("cibaraGuestRequests", function (e) {
    const d = e.detail || {};
    _items = Array.isArray(d.items) ? d.items : [];
    const ids = new Set(_items.map(function (r) { return r.id; }));
    // First snapshot (page load) and cache replays are not news.
    if (_knownIds !== null && !d.fromCache) {
      const fresh = _items.filter(function (r) { return !_knownIds.has(r.id) && r.status === "open"; });
      if (fresh.length) {
        chime();
        fresh.forEach(function (r) {
          notify("Room " + esc(r.room) + ": " + esc(kindLabel(r.kind)) + (r.note ? " — " + esc(r.note) : ""), "info", 8000);
          desktopNotify(r);
        });
      }
    }
    _knownIds = ids;
    renderBadge();
    if (_panelOpen) renderList();
  });

  // ── Admin: portal settings + QR ─────────────────────────────────────────
  function openSettings() {
    if (!(global.CibaraAuth && global.CibaraAuth.userCan("guest_portal.manage"))) return;
    api("/api/guest-portal/settings").then(function (body) {
      _settings = body.settings || {};
      renderSettingsModal();
    }).catch(function (err) {
      notify("Could not load guest portal settings: " + err.message, "error");
    });
  }

  function renderSettingsModal() {
    const s = _settings || {};
    let modal = document.getElementById("guest-portal-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "guest-portal-modal";
      modal.className = "modal-backdrop";
      modal.addEventListener("click", function (ev) { if (ev.target === modal) closeSettings(); });
      document.body.appendChild(modal);
    }
    const kinds = KIND_ORDER.map(function (k) {
      const on = !s.kinds || s.kinds[k] !== false;
      return '<label class="gp-kind"><input type="checkbox" name="kind" value="' + k + '"' + (on ? " checked" : "") + "> " + esc(kindLabel(k)) + "</label>";
    }).join("");
    modal.innerHTML =
      '<div class="modal-content" style="max-width: 520px">' +
        '<div class="modal-header">' +
          '<h2><i class="fas fa-qrcode" style="margin-right:8px;color:#16a34a"></i>Guest Portal</h2>' +
          '<button class="close-btn" type="button" id="gp-close" aria-label="Close">&times;</button>' +
        "</div>" +
        '<form id="gp-form" class="gp-form" autocomplete="off">' +
          '<label class="gp-switch"><input type="checkbox" name="enabled"' + (s.enabled ? " checked" : "") + "> " +
            "<span><strong>Portal switched on</strong><small>Off = every phone is refused at once, stickers stay valid.</small></span></label>" +
          '<div class="gp-grid">' +
            field("hotelName", "Hotel name", s.hotelName) +
            field("receptionPhone", "Reception phone (guests tap to call)", s.receptionPhone, "tel") +
            field("wifiName", "Wi-Fi network", s.wifiName) +
            field("wifiPassword", "Wi-Fi password", s.wifiPassword) +
            field("whatsapp", "WhatsApp number (optional)", s.whatsapp, "tel") +
            field("checkoutTime", "Checkout time shown to guests", s.checkoutTime) +
            field("sessionHours", "Phone stays logged in (hours)", s.sessionHours, "number") +
          "</div>" +
          '<label class="gp-label">House rules<textarea name="houseRules" rows="4" maxlength="2000">' + esc(s.houseRules) + "</textarea></label>" +
          '<label class="gp-label">Nearby &amp; useful (pharmacy, hospital, food, sights)<textarea name="nearbyInfo" rows="4" maxlength="2000">' + esc(s.nearbyInfo) + "</textarea></label>" +
          '<div class="gp-label">Requests guests can raise<div class="gp-kinds">' + kinds + "</div></div>" +
          field("publicBaseUrl", "Portal address (blank = " + esc(s.portalUrl || "Firebase Hosting") + ")", s.publicBaseUrl, "url") +
          '<div class="gp-actions">' +
            '<button type="button" class="gr-btn" id="gp-print">Print room QR</button>' +
            '<span style="flex:1"></span>' +
            '<button type="button" class="gr-btn" id="gp-cancel">Cancel</button>' +
            '<button type="submit" class="gr-btn gr-btn-done" id="gp-save">Save</button>' +
          "</div>" +
        "</form>" +
      "</div>";
    modal.classList.add("show");
    modal.querySelector("#gp-close").addEventListener("click", closeSettings);
    modal.querySelector("#gp-cancel").addEventListener("click", closeSettings);
    modal.querySelector("#gp-print").addEventListener("click", printQr);
    modal.querySelector("#gp-form").addEventListener("submit", saveSettings);

    function field(name, label, value, type) {
      return '<label class="gp-label">' + esc(label) +
        '<input name="' + name + '" type="' + (type || "text") + '" value="' + esc(value == null ? "" : value) + '"' +
        (type === "number" ? ' min="1" max="72"' : "") + "></label>";
    }
  }

  function closeSettings() {
    const modal = document.getElementById("guest-portal-modal");
    if (modal) modal.classList.remove("show");
  }

  function saveSettings(ev) {
    ev.preventDefault();
    const form = ev.target;
    const btn = form.querySelector("#gp-save");
    const data = new FormData(form);
    const kinds = {};
    KIND_ORDER.forEach(function (k) { kinds[k] = false; });
    data.getAll("kind").forEach(function (k) { kinds[k] = true; });
    const payload = {
      enabled: data.get("enabled") === "on",
      hotelName: data.get("hotelName"),
      receptionPhone: data.get("receptionPhone"),
      wifiName: data.get("wifiName"),
      wifiPassword: data.get("wifiPassword"),
      checkoutTime: data.get("checkoutTime"),
      sessionHours: data.get("sessionHours"),
      houseRules: data.get("houseRules"),
      nearbyInfo: data.get("nearbyInfo"),
      whatsapp: data.get("whatsapp"),
      publicBaseUrl: data.get("publicBaseUrl"),
      kinds: kinds,
    };
    btn.disabled = true;
    api("/api/guest-portal/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(function (body) {
      _settings = body.settings || _settings;
      notify("Guest portal settings saved", "success", 3000);
      closeSettings();
    }).catch(function (err) {
      notify("Could not save: " + err.message, "error");
    }).then(function () { btn.disabled = false; });
  }

  // One QR for every room: the print sheet repeats it so the owner can cut
  // and laminate as many copies as there are rooms.
  function printQr() {
    const f = global.apiFetch || global.fetch;
    f("/api/guest-portal/qr.png").then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.blob();
    }).then(function (blob) {
      const reader = new FileReader();
      reader.onload = function () {
        const s = _settings || {};
        const w = global.open("", "_blank");
        if (!w) { notify("Pop-up blocked: allow pop-ups to print the QR", "warning"); return; }
        const card =
          '<div class="card">' +
            '<h1>' + esc(s.hotelName || "Guest services") + "</h1>" +
            '<img src="' + reader.result + '" alt="QR">' +
            "<p><strong>Scan for room service</strong></p>" +
            "<p>Enter your room number and the mobile number you gave at check-in.</p>" +
            '<p class="url">' + esc(s.portalUrl || "") + "</p>" +
          "</div>";
        w.document.write(
          "<!doctype html><html><head><title>Room QR</title><style>" +
          "body{font-family:Inter,system-ui,sans-serif;margin:0;padding:12mm;color:#111}" +
          ".sheet{display:grid;grid-template-columns:repeat(2,1fr);gap:10mm}" +
          ".card{border:1px dashed #999;border-radius:8px;padding:8mm;text-align:center;break-inside:avoid}" +
          ".card h1{font-size:18pt;margin:0 0 4mm}.card img{width:60mm;height:60mm}" +
          ".card p{margin:2mm 0;font-size:11pt}.card .url{font-size:8pt;color:#555;word-break:break-all}" +
          "@media print{body{padding:8mm}}</style></head><body>" +
          '<div class="sheet">' + card + card + card + card + "</div>" +
          "<script>window.onload=function(){window.print()}<\/script></body></html>"
        );
        w.document.close();
      };
      reader.readAsDataURL(blob);
    }).catch(function (err) {
      notify("Could not build the QR: " + err.message, "error");
    });
  }

  // ── Wire up ─────────────────────────────────────────────────────────────
  function init() {
    const btn = document.getElementById("guest-requests-btn");
    if (btn) btn.addEventListener("click", function () { _panelOpen ? closePanel() : openPanel(); });
    renderBadge();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  global.CibaraGuestRequests = Object.freeze({
    open: openPanel,
    close: closePanel,
    openSettings: openSettings,
    items: function () { return _items.slice(); },
  });
})(window);
