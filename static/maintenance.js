/* ──────────────────────────────────────────────────────────────────────────
 * Deep Check — inspection rounds, issues, history, analytics, checklist.
 *
 * Backed by routes/maintenance.py. Managers run inspection rounds and mark
 * issues fixed; admins additionally verify fixes, edit the checklist
 * template and delete records (all enforced server-side — the checks here
 * are UX only).
 *
 * UI shape (2026 redesign)
 * ------------------------
 * This is no longer a dialog. It is a full-screen workspace that becomes a
 * centred app panel from 900px up:
 *   • phone  → full screen, thumb-reachable bottom nav, sticky sub-headers,
 *              sticky submit bar, 44px+ tap targets everywhere
 *   • laptop → 1080px panel, pill tabs at the top
 *
 * The whole surface is built dynamically (same approach as room-cleaning.js)
 * so index.html only carries the quick-action entry + this script tag.
 * Loaded with `defer` after auth.js, permissions.js and script.js.
 *
 * Style is deliberately ES5 (var / function, no template literals) to match
 * the rest of the bundle and the old WebViews this PWA is installed into.
 * ──────────────────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  var SEVERITIES = ["low", "medium", "high"];
  var SEV_LABEL = { low: "Low", medium: "Medium", high: "High" };
  var CATEGORIES = ["electrical", "appliances", "washroom", "furniture", "general"];
  var CAT_LABELS = {
    electrical: "⚡ Electrical", appliances: "📺 Appliances",
    washroom: "🚿 Washroom", furniture: "🛏️ Furniture", general: "🧱 General",
  };

  var TABS = [
    { id: "dashboard", label: "Rooms", icon: "fa-th-large" },
    { id: "issues", label: "Issues", icon: "fa-exclamation-triangle" },
    { id: "history", label: "History", icon: "fa-history" },
    { id: "analytics", label: "Analytics", icon: "fa-chart-bar" },
    { id: "checklist", label: "Checklist", icon: "fa-tasks", adminOnly: true },
  ];

  var state = {
    checklist: [],
    categories: [],      // room-rate categories in use (from backend)
    roomCats: {},        // room number -> rate category
    inspectItems: [],    // checklist items applicable to inspectRoom
    openRound: null,
    status: null,        // { round, rooms[], coverage }
    issues: [],
    issueFilter: "open",
    issueTrade: "all",   // trade/category filter in the Issues tab
    roomFilter: "all",   // all | pending | issues | done  (dashboard grid)
    roomQuery: "",       // room-number search (dashboard grid)
    analytics: null,
    inspectRoom: null,   // room currently being inspected
    inspectDraft: {},    // item_id -> {status, severity, note}
    tab: "dashboard",
  };

  // ── helpers ─────────────────────────────────────────────────────────────

  function _fetch(url, opts) {
    return typeof apiFetch === "function" ? apiFetch(url, opts) : fetch(url, opts);
  }

  function api(url, opts) {
    return _fetch(url, opts)
      .then(function (res) { return res.json(); })
      .then(function (json) {
        if (!json.success) throw new Error(json.message || "Request failed");
        return json;
      });
  }

  function post(url, body) {
    return api(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  }

  function notify(msg, type) {
    if (typeof showNotification === "function") showNotification(msg, type || "info");
    else alert(msg);
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function fmtWhen(iso) {
    if (!iso) return "—";
    try {
      var d = new Date(iso);
      return d.toLocaleString("en-IN", {
        day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
      });
    } catch (_) { return iso; }
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleDateString("en-IN", {
        day: "numeric", month: "short", year: "numeric",
      });
    } catch (_) { return iso; }
  }

  function can(perm) {
    var a = window.CibaraAuth;
    if (a && typeof a.userCan === "function") return a.userCan(perm);
    return false;
  }
  function isAdmin() {
    var a = window.CibaraAuth;
    return !!(a && typeof a.isAdmin === "function" && a.isAdmin());
  }

  function itemsForRoom(room) {
    var cat = state.roomCats[room] || "other";
    return state.checklist.filter(function (it) {
      var rc = it.room_categories || ["all"];
      return rc.indexOf("all") !== -1 || rc.indexOf(cat) !== -1;
    });
  }

  function el(id) { return document.getElementById(id); }
  function pane(name) { return el("dc-pane-" + name); }

  function skeleton(n, tall) {
    var out = '<div class="dc-loading">';
    for (var i = 0; i < (n || 3); i++) {
      out += '<div class="dc-skel' + (tall ? " tall" : "") + '"></div>';
    }
    return out + "</div>";
  }

  function emptyState(icon, title, body, actionHtml) {
    return '<div class="dc-empty">' +
      '<span class="dc-empty-ico">' + icon + "</span>" +
      '<span class="dc-empty-title">' + esc(title) + "</span>" +
      (body ? "<span>" + esc(body) + "</span>" : "") +
      (actionHtml || "") +
      "</div>";
  }

  // ── unsaved-inspection drafts (localStorage, survives reload/close) ────
  var DRAFT_MAX_AGE_MS = 48 * 3600 * 1000;

  function draftKey() {
    var rid = state.openRound ? state.openRound.id : "";
    return "mnt-draft:" + rid + ":" + state.inspectRoom;
  }
  function saveDraft() {
    try {
      localStorage.setItem(draftKey(),
        JSON.stringify({ ts: Date.now(), draft: state.inspectDraft }));
    } catch (_) { /* storage full / private mode — drafts just don't persist */ }
  }
  function loadDraft() {
    try {
      var raw = localStorage.getItem(draftKey());
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (!obj || !obj.draft) return null;
      if (Date.now() - (obj.ts || 0) > DRAFT_MAX_AGE_MS) {
        localStorage.removeItem(draftKey());
        return null;
      }
      return obj.draft;
    } catch (_) { return null; }
  }
  function clearDraft() {
    try { localStorage.removeItem(draftKey()); } catch (_) {}
  }
  function applyDraftOverlay() {
    var saved = loadDraft();
    if (!saved) return;
    var keys = Object.keys(saved);
    if (!keys.length) return;
    keys.forEach(function (k) { state.inspectDraft[k] = saved[k]; });
    notify("Restored your unsaved inspection for room " + state.inspectRoom, "info");
  }

  function roomNumbers() {
    if (state.status && state.status.rooms.length) {
      return state.status.rooms.map(function (r) { return r.room; });
    }
    return Object.keys(window.rooms || {}).sort(function (a, b) {
      return a.length - b.length || (a < b ? -1 : 1);
    });
  }

  // ── shell ───────────────────────────────────────────────────────────────

  function visibleTabs() {
    return TABS.filter(function (t) { return !t.adminOnly || isAdmin(); });
  }

  function ensureShell() {
    if (el("maintenance-modal")) return;

    var tabs = visibleTabs();
    var tabHtml = tabs.map(function (t) {
      return '<button class="dc-tab' + (t.id === "dashboard" ? " active" : "") +
        '" data-mtab="' + t.id + '" type="button">' + esc(t.label) + "</button>";
    }).join("");
    var navHtml = tabs.map(function (t) {
      return '<button class="dc-nav-btn' + (t.id === "dashboard" ? " active" : "") +
        '" data-mtab="' + t.id + '" type="button">' +
        '<i class="fas ' + t.icon + '"></i><span>' + esc(t.label) + "</span></button>";
    }).join("");
    var paneHtml = ["dashboard", "inspect", "issues", "history", "analytics", "checklist"]
      .map(function (p) {
        return '<section class="dc-pane' + (p === "dashboard" ? " active" : "") +
          '" id="dc-pane-' + p + '"></section>';
      }).join("");

    var html =
      '<div id="maintenance-modal" data-modal-surface role="dialog" aria-modal="true" aria-label="Deep Check">' +
      '  <div class="dc-panel" id="dc-panel">' +
      '    <header class="dc-head">' +
      '      <div class="dc-head-mark"><i class="fas fa-tools"></i></div>' +
      '      <div class="dc-head-txt">' +
      '        <h2 class="dc-title">Deep Check</h2>' +
      '        <span class="dc-sub" id="dc-subtitle">Room inspection rounds</span>' +
      "      </div>" +
      '      <button class="dc-iconbtn" id="dc-refresh" type="button" title="Refresh" aria-label="Refresh"><i class="fas fa-sync-alt"></i></button>' +
      '      <button class="dc-iconbtn dc-close close-btn" type="button" aria-label="Close">&times;</button>' +
      "    </header>" +
      '    <nav class="dc-tabs" id="dc-tabs">' + tabHtml + "</nav>" +
      '    <div class="dc-body" id="dc-body">' + paneHtml + "</div>" +
      '    <nav class="dc-nav" id="dc-nav">' + navHtml + "</nav>" +
      "  </div>" +
      "</div>";

    document.body.insertAdjacentHTML("beforeend", html);

    var modal = el("maintenance-modal");
    modal.querySelector(".dc-close").addEventListener("click", closeModal);
    el("dc-refresh").addEventListener("click", function () {
      var btn = el("dc-refresh");
      btn.classList.add("spin");
      setTimeout(function () { btn.classList.remove("spin"); }, 900);
      hardRefresh();
    });
    modal.querySelectorAll("[data-mtab]").forEach(function (btn) {
      btn.addEventListener("click", function () { switchTab(btn.dataset.mtab); });
    });

    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      var m = el("maintenance-modal");
      if (m && m.classList.contains("show")) closeModal();
    });
  }

  function setSubtitle(text) {
    var s = el("dc-subtitle");
    if (s) s.textContent = text;
  }

  function setFocusMode(on) {
    var p = el("dc-panel");
    if (p) p.classList.toggle("dc-focus", !!on);
  }

  function switchTab(tab) {
    state.tab = tab;
    setFocusMode(false);
    var modal = el("maintenance-modal");
    if (!modal) return;
    modal.querySelectorAll("[data-mtab]").forEach(function (b) {
      b.classList.toggle("active", b.dataset.mtab === tab);
    });
    modal.querySelectorAll(".dc-pane").forEach(function (p) {
      p.classList.toggle("active", p.id === "dc-pane-" + tab);
    });
    var body = el("dc-body");
    if (body) body.scrollTop = 0;

    if (tab === "issues") loadIssues();
    if (tab === "history") loadHistory();
    if (tab === "analytics") loadAnalytics();
    if (tab === "checklist") renderChecklistEditor();
    if (tab === "dashboard") loadOverview();
  }

  // Header refresh — drop the caches for the tab in view and re-fetch.
  function hardRefresh() {
    if (state.tab === "dashboard") { state._overviewLoaded = false; loadOverview(); }
    else if (state.tab === "issues") { state._issuesLoaded = false; loadIssues(); }
    else if (state.tab === "history") { state._rounds = null; loadHistory(); }
    else if (state.tab === "analytics") { state.analytics = null; loadAnalytics(); }
    else if (state.tab === "checklist") renderChecklistEditor();
  }

  var _prevBodyOverflow = "";

  function openModal() {
    ensureShell();
    el("maintenance-modal").classList.add("show");
    _prevBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    switchTab("dashboard");
  }

  function closeModal() {
    var m = el("maintenance-modal");
    if (m) m.classList.remove("show");
    document.body.style.overflow = _prevBodyOverflow || "";
  }

  // ── dashboard ───────────────────────────────────────────────────────────

  function loadOverview() {
    var p = pane("dashboard");
    // Stale-while-revalidate: paint instantly from the last payload,
    // refresh silently in the background.
    var hasCache = !!state._overviewLoaded;
    if (hasCache) renderDashboard();
    else p.innerHTML = skeleton(1, true) + skeleton(3);
    api("/maintenance/overview")
      .then(function (json) {
        state.checklist = json.checklist || [];
        state.categories = json.categories || [];
        state.openRound = json.open_round;
        state.status = json.status;
        state.roomCats = {};
        ((json.status || {}).rooms || []).forEach(function (r) {
          state.roomCats[r.room] = r.category || "other";
        });
        state._overviewLoaded = true;
        renderDashboard();
      })
      .catch(function (e) {
        if (hasCache) notify(e.message, "error");
        else p.innerHTML = emptyState("⚠️", "Couldn't load Deep Check", e.message);
      });
  }

  function roomState(r) {
    if (!r.inspected) return "pending";
    if (r.high_open > 0) return "critical";
    if (r.open_issues > 0) return "issues";
    return "ok";
  }

  function renderDashboard() {
    var p = pane("dashboard");

    if (!state.openRound) {
      setSubtitle("No round open");
      p.innerHTML =
        '<div id="dc-start-box">' +
        emptyState("🗓️", "No deep-check round is open",
          "Start a round to inspect rooms and track what needs fixing.",
          can("maintenance.inspect")
            ? '<button class="dc-btn dc-btn-primary" id="mnt-start-round" type="button">Start new round</button>'
            : "") +
        "</div>";
      var startBtn = el("mnt-start-round");
      if (startBtn) startBtn.addEventListener("click", renderStartForm);
      return;
    }

    var st = state.status || { rooms: [], coverage: { inspected: 0, total: 0 } };
    var cov = st.coverage;
    var pct = cov.total ? Math.round((100 * cov.inspected) / cov.total) : 0;

    var openCount = 0, fixedCount = 0, highCount = 0;
    st.rooms.forEach(function (r) {
      openCount += r.open_issues;
      fixedCount += r.awaiting_verify;
      highCount += r.high_open;
    });

    setSubtitle(esc(state.openRound.name) + " · " + cov.inspected + "/" + cov.total + " rooms");

    // Progress ring — r=27 → circumference ≈ 169.6
    var C = 169.6;
    var dash = (C * pct / 100).toFixed(1) + " " + C;

    var html =
      '<div class="dc-hero">' +
      '  <div class="dc-ring">' +
      '    <svg viewBox="0 0 62 62" aria-hidden="true">' +
      '      <circle class="dc-ring-bg" cx="31" cy="31" r="27"></circle>' +
      '      <circle class="dc-ring-fg" cx="31" cy="31" r="27" stroke-dasharray="' + dash + '"></circle>' +
      "    </svg>" +
      '    <span class="dc-ring-val">' + pct + "%</span>" +
      "  </div>" +
      '  <div class="dc-hero-main">' +
      '    <div class="dc-hero-eyebrow">Active round</div>' +
      '    <div class="dc-hero-title">' + esc(state.openRound.name) + "</div>" +
      '    <div class="dc-hero-meta">' + cov.inspected + " of " + cov.total +
      " rooms inspected · started " + fmtDate(state.openRound.created_at) + "</div>" +
      "  </div>" +
      (can("maintenance.inspect")
        ? '<div class="dc-hero-actions"><button class="dc-btn dc-btn-sm" id="mnt-close-round" type="button">Close round</button></div>'
        : "") +
      "</div>";

    html +=
      '<div class="dc-kpis">' +
      '  <div class="dc-kpi ' + (openCount ? "warn" : "good") + '"><div class="dc-kpi-num">' + openCount + '</div><div class="dc-kpi-lbl">Open issues</div></div>' +
      '  <div class="dc-kpi ' + (highCount ? "bad" : "good") + '"><div class="dc-kpi-num">' + highCount + '</div><div class="dc-kpi-lbl">High severity</div></div>' +
      '  <div class="dc-kpi"><div class="dc-kpi-num">' + fixedCount + '</div><div class="dc-kpi-lbl">To verify</div></div>' +
      '  <div class="dc-kpi"><div class="dc-kpi-num">' + (cov.total - cov.inspected) + '</div><div class="dc-kpi-lbl">Rooms left</div></div>' +
      "</div>";

    var counts = { all: st.rooms.length, pending: 0, issues: 0, done: 0 };
    st.rooms.forEach(function (r) {
      var s = roomState(r);
      if (s === "pending") counts.pending++;
      else if (s === "ok") counts.done++;
      else counts.issues++;
    });

    var FILTERS = [["all", "All"], ["pending", "Pending"], ["issues", "Needs work"], ["done", "Clear"]];
    html +=
      '<div class="dc-section"><h3>Rooms</h3><span>tap a room to inspect or review</span></div>' +
      '<div class="dc-toolbar">' +
      '  <div class="dc-search">' +
      '    <i class="fas fa-search"></i>' +
      '    <input type="search" class="form-control" id="dc-room-search" inputmode="numeric"' +
      '      placeholder="Find room…" value="' + esc(state.roomQuery) + '" aria-label="Find room" />' +
      "  </div>" +
      '  <div class="dc-chips">' +
      FILTERS.map(function (f) {
        return '<button class="dc-chip' + (state.roomFilter === f[0] ? " active" : "") +
          '" data-rfilter="' + f[0] + '" type="button">' + f[1] +
          "<small>" + counts[f[0]] + "</small></button>";
      }).join("") +
      "  </div>" +
      "</div>" +
      '<div class="dc-grid" id="dc-room-grid"></div>' +
      '<div class="dc-legend">' +
      '  <span><i class="lg-pending"></i>Not inspected</span>' +
      '  <span><i class="lg-ok"></i>Clear</span>' +
      '  <span><i class="lg-issues"></i>Open issues</span>' +
      '  <span><i class="lg-critical"></i>High severity</span>' +
      "</div>";

    p.innerHTML = html;

    var closeBtn = el("mnt-close-round");
    if (closeBtn) closeBtn.addEventListener("click", closeRound);

    p.querySelectorAll("[data-rfilter]").forEach(function (chip) {
      chip.addEventListener("click", function () {
        state.roomFilter = chip.dataset.rfilter;
        p.querySelectorAll("[data-rfilter]").forEach(function (c) {
          c.classList.toggle("active", c.dataset.rfilter === state.roomFilter);
        });
        renderRoomGrid();
      });
    });

    var search = el("dc-room-search");
    if (search) {
      search.addEventListener("input", function () {
        state.roomQuery = this.value.trim();
        renderRoomGrid();
      });
    }

    renderRoomGrid();
  }

  // Grid re-renders on its own so typing in the search box never loses focus.
  function renderRoomGrid() {
    var grid = el("dc-room-grid");
    if (!grid) return;
    var st = state.status || { rooms: [] };
    var q = state.roomQuery.toLowerCase();

    var rows = st.rooms.filter(function (r) {
      var s = roomState(r);
      if (state.roomFilter === "pending" && s !== "pending") return false;
      if (state.roomFilter === "done" && s !== "ok") return false;
      if (state.roomFilter === "issues" && s !== "issues" && s !== "critical") return false;
      if (q && String(r.room).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });

    if (!rows.length) {
      grid.innerHTML = '<div class="dc-empty" style="grid-column:1/-1">' +
        (q ? "No room matches “" + esc(state.roomQuery) + "”" : "Nothing in this filter") +
        "</div>";
      return;
    }

    grid.innerHTML = rows.map(function (r) {
      var s = roomState(r);
      var tag = "pending";
      if (s === "critical") tag = r.open_issues + " open ⚠";
      else if (s === "issues") tag = r.open_issues + " open";
      else if (s === "ok") tag = (r.score != null ? r.score + "%" : "done");
      return '<button type="button" class="dc-room ' + s + '" data-room="' + esc(r.room) +
        '" title="' + esc((r.category || "") + (r.inspected_by ? " · by " + r.inspected_by : "")) + '">' +
        '<span class="dc-room-no">' + esc(r.room) + "</span>" +
        '<span class="dc-room-tag">' + esc(tag) + "</span>" +
        "</button>";
    }).join("");

    grid.querySelectorAll(".dc-room").forEach(function (cell) {
      cell.addEventListener("click", function () {
        var room = cell.dataset.room;
        if (cell.classList.contains("pending")) {
          if (!can("maintenance.inspect")) {
            notify("You don't have permission to inspect rooms", "error");
            return;
          }
          openInspectForm(room);
        } else {
          // Already inspected — show the read-only record (who/when/results);
          // re-inspection is offered from inside the viewer.
          renderInspectionView(state.openRound, room, pane("dashboard"), loadOverview);
        }
      });
    });
  }

  // Inline form instead of window.prompt() — native dialogs are silently
  // blocked in some installed-PWA / WebView contexts, which made the button
  // appear dead.
  function renderStartForm() {
    var box = el("dc-start-box");
    if (!box) return;
    var def = "Deep Check " + new Date().toLocaleDateString("en-IN", {
      month: "long", year: "numeric",
    });
    box.innerHTML =
      '<div class="dc-card">' +
      '  <div class="dc-section" style="margin-top:0"><h3>Start a new round</h3></div>' +
      '  <div class="dc-startform">' +
      '    <input type="text" class="form-control" id="mnt-round-name" maxlength="80" value="' + esc(def) + '" />' +
      '    <button class="dc-btn dc-btn-success" id="mnt-round-go" type="button">Start</button>' +
      '    <button class="dc-btn dc-btn-ghost" id="mnt-round-cancel" type="button">Cancel</button>' +
      "  </div>" +
      "</div>";
    el("mnt-round-go").addEventListener("click", function () {
      var name = el("mnt-round-name").value;
      post("/maintenance/rounds/start", { name: name })
        .then(function () { notify("Round started", "success"); loadOverview(); })
        .catch(function (e) { notify(e.message, "error"); });
    });
    el("mnt-round-cancel").addEventListener("click", renderDashboard);
    el("mnt-round-name").focus();
  }

  // Two-step confirm on the button itself instead of window.confirm().
  function closeRound() {
    var btn = el("mnt-close-round");
    if (!btn) return;
    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1";
      btn.classList.add("armed");
      var cov = state.status ? state.status.coverage : null;
      btn.textContent = cov && cov.inspected < cov.total
        ? "Only " + cov.inspected + "/" + cov.total + " done — tap to confirm"
        : "Tap again to close";
      setTimeout(function () {
        if (btn.isConnected) {
          btn.dataset.armed = "";
          btn.classList.remove("armed");
          btn.textContent = "Close round";
        }
      }, 4000);
      return;
    }
    post("/maintenance/rounds/" + state.openRound.id + "/close")
      .then(function () { notify("Round closed", "success"); loadOverview(); })
      .catch(function (e) { notify(e.message, "error"); });
  }

  // ── inspection form ─────────────────────────────────────────────────────

  function openInspectForm(room) {
    state.inspectRoom = room;
    state.inspectDraft = {};
    // Prefill from an existing inspection in this round (re-inspection).
    api("/maintenance/inspections/" + state.openRound.id + "/" + encodeURIComponent(room))
      .then(function (json) {
        if (json.inspection && json.inspection.items) {
          json.inspection.items.forEach(function (it) {
            state.inspectDraft[it.item_id] = {
              status: it.status, severity: it.severity || "medium", note: it.note || "",
            };
          });
        }
        applyDraftOverlay();   // unsaved local draft wins over the server copy
        renderInspectForm();
      })
      .catch(function () { applyDraftOverlay(); renderInspectForm(); });
  }

  function decidedCount() {
    return state.inspectItems.filter(function (it) {
      var d = state.inspectDraft[it.id];
      return d && (d.status === "ok" || d.status === "issue");
    }).length;
  }

  function refreshInspectProgress() {
    var s = el("dc-inspect-progress");
    if (!s) return;
    var done = decidedCount();
    var total = state.inspectItems.length;
    s.textContent = (state.roomCats[state.inspectRoom] || "room") +
      " · " + done + " of " + total + " checked";
  }

  function renderInspectForm() {
    var p = pane("inspect");
    var room = state.inspectRoom;
    state.inspectItems = itemsForRoom(room);

    var html =
      '<div class="dc-subhead">' +
      '  <button class="dc-iconbtn" id="mnt-inspect-back" type="button" aria-label="Back"><i class="fas fa-arrow-left"></i></button>' +
      '  <div class="dc-subhead-txt">' +
      '    <div class="dc-subhead-title">Room ' + esc(room) + "</div>" +
      '    <div class="dc-subhead-sub" id="dc-inspect-progress"></div>' +
      "  </div>" +
      (state.inspectItems.length
        ? '  <button class="dc-btn dc-btn-soft dc-btn-sm" id="mnt-all-ok" type="button">All OK</button>'
        : "") +
      "</div>";

    // Items render in the admin's chosen order (Checklist tab drag handle) —
    // no department grouping. The category still routes issues to the
    // right worker in the Issues tab.
    if (!state.inspectItems.length) {
      html += emptyState("📋", "Checklist is empty",
        "An admin needs to add items in the Checklist tab first.");
    } else {
      html += '<div class="dc-checklist">';
      state.inspectItems.forEach(function (it) {
        var d = state.inspectDraft[it.id] || {};
        var isOk = d.status === "ok";
        var isIssue = d.status === "issue";
        var sev = d.severity || "medium";
        html +=
          '<div class="dc-item' + (isOk ? " is-ok" : "") + (isIssue ? " is-issue" : "") +
          '" data-item="' + esc(it.id) + '">' +
          '  <div class="dc-item-top">' +
          '    <span class="dc-item-ico">' + esc(it.icon || "•") + "</span>" +
          '    <span class="dc-item-label">' + esc(it.label) + "</span>" +
          '    <span class="dc-seg">' +
          '      <button type="button" class="dc-ok-btn' + (isOk ? " sel-ok" : "") + '">OK</button>' +
          '      <button type="button" class="dc-issue-btn' + (isIssue ? " sel-issue" : "") + '">Problem</button>' +
          "    </span>" +
          "  </div>" +
          '  <div class="dc-item-detail">' +
          '    <div class="dc-sevs">' +
          SEVERITIES.map(function (s) {
            return '<button type="button" class="dc-sev' + (sev === s ? " active" : "") +
              '" data-sev="' + s + '">' + SEV_LABEL[s] + "</button>";
          }).join("") +
          "    </div>" +
          '    <input type="text" class="form-control dc-note" maxlength="300"' +
          '      placeholder="What’s wrong? (e.g. remote missing)" value="' + esc(d.note || "") + '" />' +
          "  </div>" +
          "</div>";
      });
      html += "</div>";
    }

    html +=
      '<div class="dc-actionbar">' +
      '  <button class="dc-btn dc-btn-ghost" id="mnt-inspect-cancel" type="button">Cancel</button>' +
      (state.inspectItems.length
        ? '  <button class="dc-btn dc-btn-success wide" id="mnt-inspect-submit" type="button">Submit inspection</button>'
        : "") +
      "</div>";

    p.innerHTML = html;

    // Show the inspect pane — it is a focused sub-flow, not a tab.
    var modal = el("maintenance-modal");
    modal.querySelectorAll(".dc-pane").forEach(function (x) {
      x.classList.toggle("active", x.id === "dc-pane-inspect");
    });
    modal.querySelectorAll("[data-mtab]").forEach(function (b) { b.classList.remove("active"); });
    setFocusMode(true);
    setSubtitle("Inspecting room " + room);
    var body = el("dc-body");
    if (body) body.scrollTop = 0;
    refreshInspectProgress();

    function backToDashboard() { switchTab("dashboard"); }
    el("mnt-inspect-back").addEventListener("click", backToDashboard);
    el("mnt-inspect-cancel").addEventListener("click", backToDashboard);

    var allOk = el("mnt-all-ok");
    if (allOk) allOk.addEventListener("click", function () {
      state.inspectItems.forEach(function (it) {
        state.inspectDraft[it.id] = { status: "ok", severity: "medium", note: "" };
      });
      saveDraft();
      renderInspectForm();
    });

    p.querySelectorAll(".dc-item").forEach(function (row) {
      var id = row.dataset.item;
      function draft() {
        return (state.inspectDraft[id] =
          state.inspectDraft[id] || { status: null, severity: "medium", note: "" });
      }
      row.querySelector(".dc-ok-btn").addEventListener("click", function () {
        draft().status = "ok";
        row.classList.add("is-ok");
        row.classList.remove("is-issue");
        row.querySelector(".dc-ok-btn").classList.add("sel-ok");
        row.querySelector(".dc-issue-btn").classList.remove("sel-issue");
        saveDraft();
        refreshInspectProgress();
      });
      row.querySelector(".dc-issue-btn").addEventListener("click", function () {
        draft().status = "issue";
        row.classList.add("is-issue");
        row.classList.remove("is-ok");
        row.querySelector(".dc-issue-btn").classList.add("sel-issue");
        row.querySelector(".dc-ok-btn").classList.remove("sel-ok");
        saveDraft();
        refreshInspectProgress();
        var note = row.querySelector(".dc-note");
        if (note) note.focus();
      });
      row.querySelectorAll(".dc-sev").forEach(function (sevBtn) {
        sevBtn.addEventListener("click", function () {
          draft().severity = sevBtn.dataset.sev;
          row.querySelectorAll(".dc-sev").forEach(function (b) {
            b.classList.toggle("active", b === sevBtn);
          });
          saveDraft();
        });
      });
      row.querySelector(".dc-note").addEventListener("input", function (e) {
        draft().note = e.target.value;
        saveDraft();
      });
    });

    var submitBtn = el("mnt-inspect-submit");
    if (submitBtn) submitBtn.addEventListener("click", submitInspection);
  }

  function submitInspection() {
    var missing = state.inspectItems.filter(function (it) {
      var d = state.inspectDraft[it.id];
      return !d || (d.status !== "ok" && d.status !== "issue");
    });
    if (missing.length) {
      notify("Please mark every item — " + missing.length + " unchecked (or use All OK first)", "error");
      // Take the operator straight to the first unmarked item.
      var first = pane("inspect").querySelector('[data-item="' + missing[0].id + '"]');
      if (first && first.scrollIntoView) first.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    var items = state.inspectItems.map(function (it) {
      var d = state.inspectDraft[it.id];
      return {
        item_id: it.id, status: d.status,
        severity: d.status === "issue" ? d.severity : null,
        note: d.status === "issue" ? d.note : "",
      };
    });
    var btn = el("mnt-inspect-submit");
    btn.disabled = true;
    btn.textContent = "Submitting…";
    post("/maintenance/inspect", {
      round_id: state.openRound.id, room: state.inspectRoom, items: items,
    })
      .then(function (json) {
        clearDraft();
        var n = json.inspection.issues_created;
        notify(
          "Room " + state.inspectRoom + " inspected — score " +
          json.inspection.score + "%" + (n ? ", " + n + " issue(s) logged" : ""),
          n ? "info" : "success"
        );
        state._issuesLoaded = false;   // issue list is stale now
        switchTab("dashboard");
      })
      .catch(function (e) {
        notify(e.message, "error");
        btn.disabled = false;
        btn.textContent = "Submit inspection";
      });
  }

  // ── issues ──────────────────────────────────────────────────────────────

  var TRADES = {
    electrical: "⚡ Electrical",
    washroom:   "🔧 Plumbing",
    furniture:  "🪚 Carpentry",
    appliances: "📺 Appliances",
    general:    "🧱 General",
  };
  var STATUS_LABEL = { open: "Open", fixed: "To verify", verified: "Done" };

  function loadIssues() {
    var p = pane("issues");
    var hasCache = !!state._issuesLoaded;
    if (hasCache) renderIssues();
    else p.innerHTML = skeleton(4);
    api("/maintenance/issues")
      .then(function (json) {
        state.issues = json.issues || [];
        state._issuesLoaded = true;
        renderIssues();
      })
      .catch(function (e) {
        if (hasCache) notify(e.message, "error");
        else p.innerHTML = emptyState("⚠️", "Couldn't load issues", e.message);
      });
  }

  // In-place update — no refetch, no full-pane flicker from the network.
  function applyIssueUpdate(updated) {
    for (var i = 0; i < state.issues.length; i++) {
      if (state.issues[i].id === updated.id) { state.issues[i] = updated; break; }
    }
    renderIssues();
  }
  function removeIssueLocal(id) {
    state.issues = state.issues.filter(function (i) { return i.id !== id; });
    renderIssues();
  }

  // One compact "who did what" line: reporter → fixer → verifier.
  function whoLine(iss) {
    var parts = ['📝 <b>' + esc((iss.reported_by || {}).name || "?") + "</b> " +
      fmtWhen(iss.reported_at)];
    if (iss.status === "fixed" || iss.status === "verified") {
      parts.push('🔧 <b>' + esc((iss.fixed_by || {}).name || "?") + "</b> " +
        fmtWhen(iss.fixed_at) + (iss.cost != null ? " ₹" + iss.cost : "") +
        (iss.fix_note ? ' "' + esc(iss.fix_note) + '"' : ""));
    }
    if (iss.status === "verified") {
      parts.push('✅ <b>' + esc((iss.verified_by || {}).name || "?") + "</b> " +
        fmtWhen(iss.verified_at));
    }
    return parts.join('<span class="dc-who-sep">→</span>');
  }

  function renderIssues() {
    var p = pane("issues");
    var all = state.issues;

    function nStatus(s) {
      if (s === "all") return all.length;
      return all.filter(function (i) { return i.status === s; }).length;
    }

    setSubtitle(nStatus("open") + " open · " + nStatus("fixed") + " awaiting verification");

    var html =
      '<div class="dc-issuebar">' +
      '  <select class="form-control" id="mnt-trade-sel" aria-label="Filter by worker">' +
      '    <option value="all">👷 All workers</option>' +
      CATEGORIES.map(function (c) {
        return '<option value="' + c + '"' + (state.issueTrade === c ? " selected" : "") +
          ">" + TRADES[c] + "</option>";
      }).join("") +
      "  </select>" +
      '  <div class="dc-scroller">' +
      [["open", "Open"], ["fixed", "To verify"], ["verified", "Done"], ["all", "All"]]
        .map(function (c) {
          return '<button type="button" class="dc-chip' +
            (state.issueFilter === c[0] ? " active" : "") +
            '" data-filter="' + c[0] + '">' + c[1] + "<small>" + nStatus(c[0]) + "</small></button>";
        }).join("") +
      "  </div>" +
      (can("maintenance.inspect")
        ? '  <button class="dc-btn dc-btn-primary dc-btn-sm" id="mnt-log-issue" type="button">＋ Log</button>'
        : "") +
      "</div>" +
      '<div class="dc-logform" id="mnt-log-issue-form"></div>';

    var visible = all.filter(function (i) {
      if (state.issueFilter !== "all" && i.status !== state.issueFilter) return false;
      if (state.issueTrade !== "all" &&
          (TRADES[i.category] ? i.category : "general") !== state.issueTrade) return false;
      return true;
    });
    visible.sort(function (a, b) {
      return (b.reported_at || "") < (a.reported_at || "") ? -1 : 1;
    });

    if (!visible.length) {
      html += emptyState("🎉", "Nothing here", "No issues match this filter.");
    } else {
      html += '<div class="dc-issues">';
      visible.forEach(function (iss) {
        var trade = TRADES[iss.category] ? iss.category : "general";
        var acts = "";
        if (iss.status === "open" && can("maintenance.issue.fix")) {
          acts += '<button type="button" class="dc-act fix dc-qfix">✓ Mark fixed</button>';
        }
        if (iss.status === "fixed" && can("maintenance.issue.verify")) {
          acts += '<button type="button" class="dc-act fix dc-qverify">✓✓ Verify</button>';
        }
        if ((iss.status === "fixed" || iss.status === "verified") && can("maintenance.issue.verify")) {
          acts += '<button type="button" class="dc-act warn dc-qreopen">↩ Reopen</button>';
        }
        if (can("maintenance.manage")) {
          acts += '<button type="button" class="dc-act del dc-qdel' +
            (acts ? " dc-act-ml" : "") + '" title="Delete">🗑</button>';
        }

        html +=
          '<article class="dc-issue sev-' + esc(iss.severity || "low") + '" data-issue="' + esc(iss.id) + '">' +
          '  <div class="dc-issue-head">' +
          '    <span class="dc-roompill">' + esc(iss.room) + "</span>" +
          '    <div class="dc-issue-main">' +
          '      <div class="dc-issue-title">' + esc(iss.item_label) +
          '        <span class="dc-issue-trade">' + TRADES[trade] + "</span>" +
          "      </div>" +
          (iss.description ? '<p class="dc-issue-note">' + esc(iss.description) + "</p>" : "") +
          "    </div>" +
          '    <span class="dc-status st-' + esc(iss.status) + '">' +
          (STATUS_LABEL[iss.status] || iss.status) + "</span>" +
          "  </div>" +
          '  <div class="dc-issue-who">' + whoLine(iss) + "</div>" +
          (acts ? '<div class="dc-issue-acts">' + acts + "</div>" : "") +
          "</article>";
      });
      html += "</div>";
    }
    p.innerHTML = html;

    el("mnt-trade-sel").addEventListener("change", function (e) {
      state.issueTrade = e.target.value;
      renderIssues();
    });
    p.querySelectorAll("[data-filter]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.issueFilter = btn.dataset.filter;
        renderIssues();
      });
    });
    var logBtn = el("mnt-log-issue");
    if (logBtn) logBtn.addEventListener("click", toggleLogIssueForm);

    p.querySelectorAll(".dc-issue").forEach(function (row) {
      var id = row.dataset.issue;

      var qfix = row.querySelector(".dc-qfix");
      if (qfix) qfix.addEventListener("click", function () {
        qfix.disabled = true;
        post("/maintenance/issues/" + id + "/fix", { note: "", cost: null })
          .then(function (json) { applyIssueUpdate(json.issue); })
          .catch(function (err) { notify(err.message, "error"); qfix.disabled = false; });
      });

      var qverify = row.querySelector(".dc-qverify");
      if (qverify) qverify.addEventListener("click", function () {
        qverify.disabled = true;
        post("/maintenance/issues/" + id + "/verify")
          .then(function (json) { applyIssueUpdate(json.issue); })
          .catch(function (err) { notify(err.message, "error"); qverify.disabled = false; });
      });

      var qreopen = row.querySelector(".dc-qreopen");
      if (qreopen) qreopen.addEventListener("click", function () {
        qreopen.disabled = true;
        post("/maintenance/issues/" + id + "/reopen", { reason: "" })
          .then(function (json) { applyIssueUpdate(json.issue); })
          .catch(function (err) { notify(err.message, "error"); qreopen.disabled = false; });
      });

      var qdel = row.querySelector(".dc-qdel");
      if (qdel) qdel.addEventListener("click", function () {
        if (qdel.dataset.armed !== "1") {
          qdel.dataset.armed = "1";
          qdel.classList.add("armed");
          qdel.textContent = "Tap to confirm";
          setTimeout(function () {
            if (qdel.isConnected) {
              qdel.dataset.armed = "";
              qdel.classList.remove("armed");
              qdel.textContent = "🗑";
            }
          }, 3000);
          return;
        }
        qdel.disabled = true;
        _fetch("/maintenance/issues/" + id, { method: "DELETE" })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (!j.success) throw new Error(j.message);
            removeIssueLocal(id);
          })
          .catch(function (err) { notify(err.message, "error"); qdel.disabled = false; });
      });
    });
  }

  function toggleLogIssueForm() {
    var box = el("mnt-log-issue-form");
    if (box.classList.contains("show")) { box.classList.remove("show"); return; }
    var roomOpts = roomNumbers().map(function (r) {
      return '<option value="' + esc(r) + '">' + esc(r) + "</option>";
    }).join("");
    box.innerHTML =
      '<select class="form-control" id="mnt-new-room" aria-label="Room"><option value="">Room…</option>' + roomOpts + "</select>" +
      '<input type="text" class="form-control" id="mnt-new-item" maxlength="80" placeholder="What is broken? (e.g. Kettle)" />' +
      '<select class="form-control" id="mnt-new-sev" aria-label="Severity">' +
      SEVERITIES.map(function (s) {
        return '<option value="' + s + '"' + (s === "medium" ? " selected" : "") + ">" + SEV_LABEL[s] + "</option>";
      }).join("") +
      "</select>" +
      '<select class="form-control" id="mnt-new-cat" aria-label="Worker">' +
      CATEGORIES.map(function (c) {
        return '<option value="' + c + '">' + (TRADES[c] || c) + "</option>";
      }).join("") +
      "</select>" +
      '<input type="text" class="form-control wide" id="mnt-new-desc" maxlength="300" placeholder="Details (optional)" />' +
      '<button class="dc-btn dc-btn-primary dc-btn-block wide" id="mnt-new-save" type="button">Log issue</button>';
    box.classList.add("show");
    el("mnt-new-save").addEventListener("click", function () {
      var room = el("mnt-new-room").value;
      if (!room) { notify("Pick a room", "error"); return; }
      post("/maintenance/issues", {
        room: room,
        item_label: el("mnt-new-item").value,
        severity: el("mnt-new-sev").value,
        category: el("mnt-new-cat").value,
        description: el("mnt-new-desc").value,
      })
        .then(function (json) {
          state.issues.unshift(json.issue);   // in-place, no refetch
          renderIssues();
        })
        .catch(function (e) { notify(e.message, "error"); });
    });
  }

  // ── analytics ───────────────────────────────────────────────────────────

  function loadAnalytics() {
    var p = pane("analytics");
    if (state.analytics) renderAnalytics();
    else p.innerHTML = skeleton(2, true);
    api("/maintenance/analytics")
      .then(function (json) { state.analytics = json.analytics; renderAnalytics(); })
      .catch(function (e) {
        if (state.analytics) notify(e.message, "error");
        else p.innerHTML = emptyState("⚠️", "Couldn't load analytics", e.message);
      });
  }

  function bars(rows, getLabel, getCount) {
    var max = rows.reduce(function (m, r) { return Math.max(m, getCount(r)); }, 0) || 1;
    return '<div class="dc-bars">' + rows.map(function (r) {
      var c = getCount(r);
      return (
        '<div class="dc-bar">' +
        '  <span class="dc-bar-label" title="' + esc(getLabel(r)) + '">' + esc(getLabel(r)) + "</span>" +
        '  <span class="dc-bar-track"><span class="dc-bar-fill" style="width:' +
        Math.round((100 * c) / max) + '%"></span></span>' +
        '  <span class="dc-bar-count">' + c + "</span>" +
        "</div>"
      );
    }).join("") + "</div>";
  }

  function renderAnalytics() {
    var a = state.analytics;
    var p = pane("analytics");
    if (!a) { p.innerHTML = emptyState("📊", "No data yet", ""); return; }

    setSubtitle("All-time maintenance analytics");

    var html =
      '<div class="dc-kpis dc-kpis-6">' +
      '  <div class="dc-kpi ' + (a.counts.open ? "warn" : "good") + '"><div class="dc-kpi-num">' + a.counts.open + '</div><div class="dc-kpi-lbl">Open</div></div>' +
      '  <div class="dc-kpi"><div class="dc-kpi-num">' + a.counts.fixed + '</div><div class="dc-kpi-lbl">To verify</div></div>' +
      '  <div class="dc-kpi good"><div class="dc-kpi-num">' + a.counts.verified + '</div><div class="dc-kpi-lbl">Verified</div></div>' +
      '  <div class="dc-kpi"><div class="dc-kpi-num">' + (a.avg_fix_hours != null ? a.avg_fix_hours + "h" : "—") + '</div><div class="dc-kpi-lbl">Avg fix time</div></div>' +
      '  <div class="dc-kpi"><div class="dc-kpi-num">₹' +
      Number(a.total_cost || 0).toLocaleString("en-IN") + '</div><div class="dc-kpi-lbl">Repair spend</div></div>' +
      '  <div class="dc-kpi"><div class="dc-kpi-num">' + a.total_inspections + '</div><div class="dc-kpi-lbl">Inspections</div></div>' +
      "</div>";

    var problemRooms = a.rooms
      .filter(function (r) { return r.total_issues > 0; })
      .sort(function (x, y) { return y.total_issues - x.total_issues; })
      .slice(0, 10);
    html += '<div class="dc-section"><h3>Rooms with most issues</h3><span>top 10</span></div>';
    html += problemRooms.length
      ? bars(problemRooms,
          function (r) {
            return "Room " + r.room + (r.high_open ? " ⚠" : "") +
              (r.last_score != null ? " · " + r.last_score + "%" : "");
          },
          function (r) { return r.total_issues; })
      : emptyState("✅", "No issues recorded yet", "");

    html += '<div class="dc-section"><h3>Most-failing items</h3></div>';
    html += (a.top_failing_items || []).length
      ? bars(a.top_failing_items,
          function (r) { return r.label; },
          function (r) { return r.count; })
      : emptyState("✅", "No failures recorded yet", "");

    var cats = Object.keys(a.category_breakdown || {}).map(function (k) {
      return { label: CAT_LABELS[k] || k, count: a.category_breakdown[k] };
    }).sort(function (x, y) { return y.count - x.count; });
    html += '<div class="dc-section"><h3>Failures by category</h3></div>';
    html += cats.length
      ? bars(cats, function (r) { return r.label; }, function (r) { return r.count; })
      : emptyState("✅", "Nothing yet", "");

    p.innerHTML = html;
  }

  // ── checklist editor (admin) ────────────────────────────────────────────

  function renderChecklistEditor() {
    var p = pane("checklist");
    p.innerHTML = skeleton(4);
    setSubtitle("Checklist template");
    api("/maintenance/checklist?all=1")
      .then(function (json) {
        state.categories = json.categories || state.categories;
        drawEditor(json.items || []);
      })
      .catch(function (e) {
        p.innerHTML = emptyState("⚠️", "Couldn't load the checklist", e.message);
      });

    function scopeSummary(cats) {
      if (!cats || !cats.length || cats.indexOf("all") !== -1) return "🏷 All rooms";
      return "🏷 " + (cats.length <= 2 ? cats.join(", ") : cats.length + " categories");
    }

    function drawEditor(items) {
      var html =
        '<div class="dc-section" style="margin-top:0.25rem"><h3>Checklist template</h3>' +
        "<span>items appear in this order during inspection — drag ⠿ to reorder</span></div>";
      if (!items.length) {
        html += emptyState("📋", "No checklist items yet",
          "Tap “Add item” below to create your first one.");
      }
      html += '<div class="dc-tpl">';
      items.forEach(function (it, i) {
        var cats = it.room_categories || ["all"];
        html +=
          '<div class="dc-tpl-row' + (it.active ? "" : " inactive") + '" data-idx="' + i +
          '" data-cats="' + esc(JSON.stringify(cats)) + '">' +
          '  <button type="button" class="dc-tpl-drag" title="Drag to reorder" aria-label="Reorder">⠿</button>' +
          '  <input type="text" class="form-control dc-tpl-icon" value="' + esc(it.icon || "") + '" title="Icon" aria-label="Icon" />' +
          '  <input type="text" class="form-control dc-tpl-label" maxlength="80" value="' + esc(it.label) + '" placeholder="Item name" aria-label="Item name" />' +
          '  <div class="dc-tpl-meta">' +
          '    <select class="form-control dc-tpl-cat" aria-label="Worker">' +
          CATEGORIES.map(function (c) {
            return '<option value="' + c + '"' + (it.category === c ? " selected" : "") + ">" + (TRADES[c] || c) + "</option>";
          }).join("") +
          "    </select>" +
          '    <button type="button" class="dc-tplbtn dc-tpl-scope" title="Which room categories this applies to">' +
          scopeSummary(cats) + "</button>" +
          '    <button type="button" class="dc-tplbtn dc-tpl-toggle" title="Enable/disable">' +
          (it.active ? "🟢 On" : "⚪ Off") + "</button>" +
          '    <button type="button" class="dc-tplbtn dc-tpl-del" title="Remove">🗑</button>' +
          "  </div>" +
          '  <div class="dc-tpl-cats">' +
          '    <span class="dc-chip dc-cat-chip' + (cats.indexOf("all") !== -1 ? " active" : "") +
          '" data-cat="all">All rooms</span>' +
          state.categories.map(function (c) {
            return '<span class="dc-chip dc-cat-chip' +
              (cats.indexOf(c) !== -1 ? " active" : "") + '" data-cat="' + esc(c) + '">' +
              esc(c) + "</span>";
          }).join("") +
          "  </div>" +
          "</div>";
      });
      html += "</div>";
      html +=
        '<div class="dc-actionbar">' +
        '  <button class="dc-btn dc-btn-ghost" id="mnt-tpl-add" type="button">＋ Add item</button>' +
        (items.length
          ? '  <button class="dc-btn dc-btn-ghost" id="mnt-tpl-clear" type="button">Clear all</button>'
          : "") +
        '  <button class="dc-btn dc-btn-primary wide" id="mnt-tpl-save" type="button">Save checklist</button>' +
        "</div>";
      p.innerHTML = html;

      function collect() {
        return Array.prototype.map.call(
          p.querySelectorAll(".dc-tpl-row"),
          function (row, i) {
            var src = items[Number(row.dataset.idx)] || {};
            var cats;
            try { cats = JSON.parse(row.dataset.cats || '["all"]'); }
            catch (_) { cats = ["all"]; }
            return {
              id: src.id,
              icon: row.querySelector(".dc-tpl-icon").value,
              label: row.querySelector(".dc-tpl-label").value,
              category: row.querySelector(".dc-tpl-cat").value,
              active: !row.classList.contains("inactive"),
              order: i,
              room_categories: cats,
            };
          }
        );
      }

      p.querySelectorAll(".dc-tpl-row").forEach(function (row) {
        var scopeBtn = row.querySelector(".dc-tpl-scope");
        var chipBox = row.querySelector(".dc-tpl-cats");
        scopeBtn.addEventListener("click", function () {
          chipBox.classList.toggle("show");
        });
        chipBox.querySelectorAll(".dc-cat-chip").forEach(function (chip) {
          chip.addEventListener("click", function () {
            var cats;
            try { cats = JSON.parse(row.dataset.cats || '["all"]'); }
            catch (_) { cats = ["all"]; }
            var c = chip.dataset.cat;
            if (c === "all") {
              cats = ["all"];
            } else {
              cats = cats.filter(function (x) { return x !== "all"; });
              var at = cats.indexOf(c);
              if (at === -1) cats.push(c); else cats.splice(at, 1);
              if (!cats.length) cats = ["all"];
            }
            row.dataset.cats = JSON.stringify(cats);
            chipBox.querySelectorAll(".dc-cat-chip").forEach(function (ch) {
              ch.classList.toggle("active", cats.indexOf(ch.dataset.cat) !== -1);
            });
            scopeBtn.innerHTML = scopeSummary(cats);
          });
        });
        row.querySelector(".dc-tpl-toggle").addEventListener("click", function () {
          items = collect();
          items[Array.prototype.indexOf.call(p.querySelectorAll(".dc-tpl-row"), row)].active =
            row.classList.contains("inactive"); // flipping
          drawEditor(items);
        });
        row.querySelector(".dc-tpl-del").addEventListener("click", function () {
          items = collect();
          items.splice(Array.prototype.indexOf.call(p.querySelectorAll(".dc-tpl-row"), row), 1);
          drawEditor(items);
        });
      });

      // ── drag & drop reordering (mouse + touch) ─────────────────────────
      // The row becomes draggable only while the ⠿ handle is pressed, so
      // text inputs and selects inside the row keep working normally.
      // collect() reads rows in DOM order, so the moved layout is what
      // gets saved.
      var dragRow = null;
      function settleDrag() {
        if (!dragRow) return;
        dragRow.classList.remove("dragging");
        dragRow.draggable = false;
        dragRow = null;
        items = collect();
        drawEditor(items);
      }
      p.querySelectorAll(".dc-tpl-row").forEach(function (row) {
        var handle = row.querySelector(".dc-tpl-drag");

        handle.addEventListener("mousedown", function () { row.draggable = true; });
        row.addEventListener("dragstart", function (e) {
          dragRow = row;
          row.classList.add("dragging");
          e.dataTransfer.effectAllowed = "move";
          try { e.dataTransfer.setData("text/plain", ""); } catch (_) {}
        });
        row.addEventListener("dragover", function (e) {
          if (!dragRow || dragRow === row) return;
          e.preventDefault();
          var rect = row.getBoundingClientRect();
          var after = e.clientY > rect.top + rect.height / 2;
          row.parentNode.insertBefore(dragRow, after ? row.nextSibling : row);
        });
        row.addEventListener("dragend", settleDrag);

        // Touch devices: HTML5 DnD doesn't fire, so reorder manually.
        handle.addEventListener("touchstart", function (e) {
          e.preventDefault();
          dragRow = row;
          row.classList.add("dragging");
        }, { passive: false });
        handle.addEventListener("touchmove", function (e) {
          if (!dragRow) return;
          e.preventDefault();
          var t = e.touches[0];
          var elem = document.elementFromPoint(t.clientX, t.clientY);
          var target = elem && elem.closest ? elem.closest(".dc-tpl-row") : null;
          if (!target || target === dragRow) return;
          var rect = target.getBoundingClientRect();
          var after = t.clientY > rect.top + rect.height / 2;
          target.parentNode.insertBefore(dragRow, after ? target.nextSibling : target);
        }, { passive: false });
        handle.addEventListener("touchend", settleDrag);
      });

      var clearBtn = el("mnt-tpl-clear");
      if (clearBtn) clearBtn.addEventListener("click", function () {
        if (clearBtn.dataset.armed !== "1") {
          clearBtn.dataset.armed = "1";
          clearBtn.textContent = "Remove all items?";
          setTimeout(function () {
            if (clearBtn.isConnected) {
              clearBtn.dataset.armed = "";
              clearBtn.textContent = "Clear all";
            }
          }, 3000);
          return;
        }
        drawEditor([]);   // still needs Save checklist to persist
      });
      el("mnt-tpl-add").addEventListener("click", function () {
        items = collect();
        items.push({ id: null, icon: "", label: "", category: "general",
                     active: true, room_categories: ["all"] });
        drawEditor(items);
      });
      el("mnt-tpl-save").addEventListener("click", function () {
        var payload = collect().filter(function (it) { return it.label.trim(); });
        post("/maintenance/checklist", { items: payload })   // empty list allowed
          .then(function () { notify("Checklist saved", "success"); renderChecklistEditor(); })
          .catch(function (e) { notify(e.message, "error"); });
      });
    }
  }

  // ── history (rounds → per-room inspectors → inspection record) ─────────

  function loadHistory() {
    var p = pane("history");
    if (state._rounds) renderHistory(state._rounds);
    else p.innerHTML = skeleton(3);
    api("/maintenance/rounds")
      .then(function (json) {
        state._rounds = json.rounds || [];
        renderHistory(state._rounds);
      })
      .catch(function (e) {
        if (state._rounds) notify(e.message, "error");
        else p.innerHTML = emptyState("⚠️", "Couldn't load history", e.message);
      });
  }

  function renderHistory(rounds) {
    var p = pane("history");
    setSubtitle(rounds.length + " inspection round" + (rounds.length === 1 ? "" : "s"));
    if (!rounds.length) {
      p.innerHTML = emptyState("🗂️", "No inspection rounds yet",
        "Rounds you close will be archived here.");
      return;
    }
    var html = '<div class="dc-section" style="margin-top:0.25rem"><h3>Inspection rounds</h3>' +
      "<span>tap for the per-room record</span></div>";
    html += '<div class="dc-rounds">';
    rounds.forEach(function (r) {
      html +=
        '<div class="dc-round" data-round="' + esc(r.id) + '">' +
        '  <div class="dc-round-main">' +
        '    <div class="dc-round-name">' + esc(r.name) +
        '      <span class="dc-pill ' + (r.status === "open" ? "warnp" : "ok") + '">' +
        (r.status === "open" ? "in progress" : "closed") + "</span>" +
        "    </div>" +
        '    <div class="dc-round-meta">' +
        "Started " + fmtDate(r.created_at) + " by " + esc((r.created_by || {}).name || "?") +
        (r.status === "closed"
          ? " · Ended " + fmtDate(r.closed_at) + " by " + esc((r.closed_by || {}).name || "?")
          : "") +
        "<br>" + r.rooms_inspected + "/" + r.rooms_total + " rooms · " +
        r.issues_found + " issue(s) found" +
        "    </div>" +
        "  </div>" +
        '  <span class="dc-round-chev"><i class="fas fa-chevron-right"></i></span>' +
        "</div>";
    });
    html += "</div>";
    p.innerHTML = html;
    p.querySelectorAll(".dc-round").forEach(function (card) {
      card.addEventListener("click", function () {
        for (var i = 0; i < rounds.length; i++) {
          if (rounds[i].id === card.dataset.round) { renderRoundDetail(rounds[i]); return; }
        }
      });
    });
  }

  function renderRoundDetail(rnd) {
    var p = pane("history");
    p.innerHTML = skeleton(4);
    api("/maintenance/rounds/" + rnd.id + "/status")
      .then(function (json) {
        var rooms = (json.rooms || []).filter(function (r) { return r.inspected; });
        var html =
          '<div class="dc-subhead">' +
          '  <button class="dc-iconbtn" id="mnt-hist-back" type="button" aria-label="Back"><i class="fas fa-arrow-left"></i></button>' +
          '  <div class="dc-subhead-txt">' +
          '    <div class="dc-subhead-title">' + esc(rnd.name) + "</div>" +
          '    <div class="dc-subhead-sub">' + fmtDate(rnd.created_at) + " → " +
          (rnd.status === "closed" ? fmtDate(rnd.closed_at) : "ongoing") + "</div>" +
          "  </div>" +
          "</div>";
        if (!rooms.length) {
          html += emptyState("🚪", "No rooms were inspected in this round", "");
        } else {
          html += '<div class="dc-section" style="margin-top:0.25rem"><h3>Inspected rooms</h3>' +
            "<span>tap for the full record</span></div>";
          html += '<div class="dc-rows">';
          rooms.forEach(function (r) {
            html +=
              '<div class="dc-row" data-room="' + esc(r.room) + '">' +
              "  <b>Room " + esc(r.room) + "</b>" +
              '  <span class="dc-pill ' + (r.issue_count ? "warnp" : "ok") + '">' +
              (r.score != null ? r.score + "%" : "—") + "</span>" +
              "  <span>" + r.issue_count + " issue(s)</span>" +
              '  <span class="dc-row-by">' + esc(r.inspected_by || "?") +
              " · " + fmtWhen(r.inspected_at) + "</span>" +
              "</div>";
          });
          html += "</div>";
        }
        p.innerHTML = html;
        el("mnt-hist-back").addEventListener("click", loadHistory);
        p.querySelectorAll(".dc-row").forEach(function (row) {
          row.addEventListener("click", function () {
            renderInspectionView(rnd, row.dataset.room, p, function () {
              renderRoundDetail(rnd);
            });
          });
        });
      })
      .catch(function (e) {
        p.innerHTML = emptyState("⚠️", "Couldn't load this round", e.message);
      });
  }

  // Read-only inspection record: who, when, item-by-item results.
  // Used from History and from the dashboard grid (inspected rooms).
  function renderInspectionView(rnd, room, target, onBack) {
    target.innerHTML = skeleton(4);
    api("/maintenance/inspections/" + rnd.id + "/" + encodeURIComponent(room))
      .then(function (json) {
        var ins = json.inspection;
        if (!ins) {
          target.innerHTML = emptyState("🔍", "No inspection record found", "");
          return;
        }
        var canRe = rnd.status === "open" && state.openRound &&
          state.openRound.id === rnd.id && can("maintenance.inspect");
        var html =
          '<div class="dc-subhead">' +
          '  <button class="dc-iconbtn" id="mnt-view-back" type="button" aria-label="Back"><i class="fas fa-arrow-left"></i></button>' +
          '  <div class="dc-subhead-txt">' +
          '    <div class="dc-subhead-title">Room ' + esc(room) +
          (ins.score != null ? " — " + ins.score + "%" : "") + "</div>" +
          '    <div class="dc-subhead-sub">' +
          esc((ins.inspected_by || {}).name || "?") + " · " + fmtWhen(ins.inspected_at) +
          " · " + (ins.ok_count || 0) + " OK / " + (ins.issue_count || 0) + " problem(s)</div>" +
          "  </div>" +
          (canRe
            ? '  <button class="dc-btn dc-btn-primary dc-btn-sm" id="mnt-view-reinspect" type="button">Re-inspect</button>'
            : "") +
          "</div>" +
          '<div class="dc-record">';
        (ins.items || []).forEach(function (it) {
          html +=
            '<div class="dc-record-row">' +
            '  <span class="dc-record-label">' + esc(it.label) + "</span>" +
            (it.status === "ok"
              ? '<span class="dc-pill ok">OK</span>'
              : '<span class="dc-pill bad">' + esc(SEV_LABEL[it.severity] || it.severity || "issue") + "</span>" +
                (it.note ? '<span class="dc-record-note">' + esc(it.note) + "</span>" : "")) +
            "</div>";
        });
        html += "</div>";
        target.innerHTML = html;
        el("mnt-view-back").addEventListener("click", onBack);
        var re = el("mnt-view-reinspect");
        if (re) re.addEventListener("click", function () { openInspectForm(room); });
      })
      .catch(function (e) {
        target.innerHTML = emptyState("⚠️", "Couldn't load the record", e.message);
      });
  }

  // ── bootstrap ───────────────────────────────────────────────────────────

  function bind() {
    var btn = el("quick-maintenance-btn");
    if (btn) {
      btn.addEventListener("click", function () {
        var menu = document.querySelector(".quick-action-menu");
        if (menu) menu.classList.remove("show");
        var dd = el("rooms-filter-more-dropdown");
        if (dd) dd.classList.remove("show");
        openModal();
      });
    }
  }

  function start() {
    if (!window.CibaraAuth) { setTimeout(start, 100); return; }
    window.CibaraAuth.ready().then(function () {
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", bind);
      } else {
        bind();
      }
    });
  }
  start();

  window.openMaintenanceModal = openModal;
})();
