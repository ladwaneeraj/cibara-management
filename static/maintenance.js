/* ──────────────────────────────────────────────────────────────────────────
 * Deep-check maintenance UI.
 *
 * Backed by routes/maintenance.py. Managers run inspection rounds and mark
 * issues fixed; admins additionally verify fixes, edit the checklist
 * template and delete records (all enforced server-side — the checks here
 * are UX only).
 *
 * The whole modal is built dynamically (same approach as room-cleaning.js)
 * so index.html only carries the quick-action entry + this script tag.
 * Loaded with `defer` after auth.js, permissions.js and script.js.
 * ──────────────────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  var SEVERITIES = ["low", "medium", "high"];
  var CATEGORIES = ["electrical", "appliances", "washroom", "furniture", "general"];
  var CAT_LABELS = {
    electrical: "⚡ Electrical", appliances: "📺 Appliances",
    washroom: "🚿 Washroom", furniture: "🛏️ Furniture", general: "🧱 General",
  };

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
    analytics: null,
    inspectRoom: null,   // room currently being inspected
    inspectDraft: {},    // item_id -> {status, severity, note}
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

  // ── modal shell ─────────────────────────────────────────────────────────

  function ensureModal() {
    if (document.getElementById("maintenance-modal")) return;
    var tabs =
      '<button class="mnt-tab-btn active" data-mtab="dashboard">Dashboard</button>' +
      '<button class="mnt-tab-btn" data-mtab="issues">Issues</button>' +
      '<button class="mnt-tab-btn" data-mtab="history">History</button>' +
      '<button class="mnt-tab-btn" data-mtab="analytics">Analytics</button>' +
      (isAdmin()
        ? '<button class="mnt-tab-btn" data-mtab="checklist">Checklist</button>'
        : "");
    var html =
      '<div class="modal-backdrop" id="maintenance-modal">' +
      '  <div class="modal-content">' +
      '    <div class="modal-header">' +
      '      <h2>🔧 Deep Check</h2>' +
      '      <button class="close-btn" aria-label="Close">&times;</button>' +
      "    </div>" +
      '    <div class="mnt-tabs">' + tabs + "</div>" +
      '    <div class="modal-body">' +
      '      <div class="mnt-tab-pane active" id="mnt-pane-dashboard"></div>' +
      '      <div class="mnt-tab-pane" id="mnt-pane-inspect"></div>' +
      '      <div class="mnt-tab-pane" id="mnt-pane-issues"></div>' +
      '      <div class="mnt-tab-pane" id="mnt-pane-history"></div>' +
      '      <div class="mnt-tab-pane" id="mnt-pane-analytics"></div>' +
      '      <div class="mnt-tab-pane" id="mnt-pane-checklist"></div>' +
      "    </div>" +
      "  </div>" +
      "</div>";
    document.body.insertAdjacentHTML("beforeend", html);

    var modal = document.getElementById("maintenance-modal");
    modal.querySelector(".close-btn").addEventListener("click", closeModal);
    modal.addEventListener("click", function (e) {
      if (e.target === modal) closeModal();
    });
    modal.querySelectorAll(".mnt-tab-btn").forEach(function (btn) {
      btn.addEventListener("click", function () { switchTab(btn.dataset.mtab); });
    });
  }

  function switchTab(tab) {
    var modal = document.getElementById("maintenance-modal");
    modal.querySelectorAll(".mnt-tab-btn").forEach(function (b) {
      b.classList.toggle("active", b.dataset.mtab === tab);
    });
    modal.querySelectorAll(".mnt-tab-pane").forEach(function (p) {
      p.classList.toggle("active", p.id === "mnt-pane-" + tab);
    });
    if (tab === "issues") loadIssues();
    if (tab === "history") loadHistory();
    if (tab === "analytics") loadAnalytics();
    if (tab === "checklist") renderChecklistEditor();
    if (tab === "dashboard") loadOverview();
  }

  function openModal() {
    ensureModal();
    document.getElementById("maintenance-modal").classList.add("show");
    switchTab("dashboard");
  }
  function closeModal() {
    var m = document.getElementById("maintenance-modal");
    if (m) m.classList.remove("show");
  }

  // ── dashboard ───────────────────────────────────────────────────────────

  function loadOverview() {
    var pane = document.getElementById("mnt-pane-dashboard");
    // Stale-while-revalidate: paint instantly from the last payload,
    // refresh silently in the background.
    var hasCache = !!state._overviewLoaded;
    if (hasCache) renderDashboard();
    else pane.innerHTML = '<div class="mnt-empty">Loading…</div>';
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
        else pane.innerHTML = '<div class="mnt-empty">' + esc(e.message) + "</div>";
      });
  }

  function renderDashboard() {
    var pane = document.getElementById("mnt-pane-dashboard");
    var html = "";

    if (!state.openRound) {
      html +=
        '<div class="mnt-round-box" id="mnt-start-box">' +
        "  <span>No deep-check round is open.</span>" +
        (can("maintenance.inspect")
          ? '<button class="action-btn btn-primary" id="mnt-start-round">Start New Round</button>'
          : "") +
        "</div>";
      pane.innerHTML = html;
      var startBtn = document.getElementById("mnt-start-round");
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

    html +=
      '<div class="mnt-round-box">' +
      '  <span class="mnt-round-name">' + esc(state.openRound.name) + "</span>" +
      '  <div class="mnt-progress"><div class="mnt-progress-fill" style="width:' + pct + '%"></div></div>' +
      "  <span><b>" + cov.inspected + "</b>/" + cov.total + " rooms</span>" +
      (can("maintenance.inspect")
        ? '<button class="action-btn btn-secondary" id="mnt-close-round">Close Round</button>'
        : "") +
      "</div>";

    html +=
      '<div class="mnt-cards">' +
      '  <div class="mnt-card ' + (openCount ? "warn" : "good") + '"><div class="mnt-card-num">' + openCount + '</div><div class="mnt-card-lbl">Open issues</div></div>' +
      '  <div class="mnt-card ' + (highCount ? "bad" : "good") + '"><div class="mnt-card-num">' + highCount + '</div><div class="mnt-card-lbl">High severity</div></div>' +
      '  <div class="mnt-card"><div class="mnt-card-num">' + fixedCount + '</div><div class="mnt-card-lbl">Awaiting verify</div></div>' +
      '  <div class="mnt-card"><div class="mnt-card-num">' + pct + '%</div><div class="mnt-card-lbl">Coverage</div></div>' +
      "</div>";

    html += '<div class="mnt-section-title">Rooms — tap to inspect / re-inspect</div>';
    html += '<div class="mnt-room-grid">';
    st.rooms.forEach(function (r) {
      var cls = "pending", sub = "pending";
      if (r.inspected) {
        if (r.high_open > 0) { cls = "critical"; sub = r.open_issues + " open ⚠"; }
        else if (r.open_issues > 0) { cls = "issues"; sub = r.open_issues + " open"; }
        else { cls = "ok"; sub = (r.score != null ? r.score + "%" : "done"); }
      }
      html +=
        '<div class="mnt-room-cell ' + cls + '" data-room="' + esc(r.room) +
        '" title="' + esc((r.category || "") +
          (r.inspected_by ? " · by " + r.inspected_by : "")) + '">' +
        '  <div class="mnt-room-no">' + esc(r.room) + "</div>" +
        '  <div class="mnt-room-sub">' + esc(sub) + "</div>" +
        "</div>";
    });
    html += "</div>";
    pane.innerHTML = html;

    var closeBtn = document.getElementById("mnt-close-round");
    if (closeBtn) closeBtn.addEventListener("click", closeRound);
    pane.querySelectorAll(".mnt-room-cell").forEach(function (cell) {
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
          renderInspectionView(state.openRound, room,
            document.getElementById("mnt-pane-dashboard"), loadOverview);
        }
      });
    });
  }

  // Inline form instead of window.prompt() — native dialogs are silently
  // blocked in some installed-PWA / WebView contexts, which made the button
  // appear dead.
  function renderStartForm() {
    var box = document.getElementById("mnt-start-box");
    if (!box) return;
    var def = "Deep Check " + new Date().toLocaleDateString("en-IN", {
      month: "long", year: "numeric",
    });
    box.innerHTML =
      '<input type="text" class="form-control" id="mnt-round-name" maxlength="80"' +
      ' value="' + esc(def) + '" style="flex:1;min-width:150px" />' +
      '<button class="action-btn btn-success" id="mnt-round-go">Start</button>' +
      '<button class="action-btn btn-secondary" id="mnt-round-cancel">Cancel</button>';
    document.getElementById("mnt-round-go").addEventListener("click", function () {
      var name = document.getElementById("mnt-round-name").value;
      post("/maintenance/rounds/start", { name: name })
        .then(function () { notify("Round started", "success"); loadOverview(); })
        .catch(function (e) { notify(e.message, "error"); });
    });
    document.getElementById("mnt-round-cancel").addEventListener("click", renderDashboard);
    document.getElementById("mnt-round-name").focus();
  }

  // Two-step confirm on the button itself instead of window.confirm().
  function closeRound() {
    var btn = document.getElementById("mnt-close-round");
    if (!btn) return;
    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1";
      var cov = state.status ? state.status.coverage : null;
      btn.textContent = cov && cov.inspected < cov.total
        ? "End early? Only " + cov.inspected + "/" + cov.total + " done — tap to confirm"
        : "Confirm close?";
      setTimeout(function () {
        if (btn.isConnected) { btn.dataset.armed = ""; btn.textContent = "Close Round"; }
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

  function renderInspectForm() {
    var pane = document.getElementById("mnt-pane-inspect");
    var room = state.inspectRoom;
    var roomCat = state.roomCats[room] || "other";
    state.inspectItems = itemsForRoom(room);

    var html =
      '<div class="mnt-round-box">' +
      '  <button class="action-btn btn-secondary" id="mnt-inspect-back">← Back</button>' +
      '  <span class="mnt-round-name">Room ' + esc(room) +
      '    <small style="font-weight:400;color:#718096">(' + esc(roomCat) + ")</small>" +
      "  </span>" +
      '  <button class="action-btn btn-secondary" id="mnt-all-ok">All OK ✓</button>' +
      "</div>";

    // Items render in the admin's chosen order (Checklist tab ▲▼) —
    // no department grouping. The category still routes issues to the
    // right worker in the Issues tab.
    state.inspectItems.forEach(function (it) {
      var d = state.inspectDraft[it.id] || {};
      var isOk = d.status === "ok";
      var isIssue = d.status === "issue";
      html +=
        '<div class="mnt-check-row" data-item="' + esc(it.id) + '">' +
        '  <span class="mnt-check-label">' + esc(it.icon || "") + " " + esc(it.label) + "</span>" +
        '  <span class="mnt-seg">' +
        '    <button type="button" class="mnt-ok-btn' + (isOk ? " sel-ok" : "") + '">OK</button>' +
        '    <button type="button" class="mnt-issue-btn' + (isIssue ? " sel-issue" : "") + '">Problem</button>' +
        "  </span>" +
        '  <div class="mnt-issue-detail" style="display:' + (isIssue ? "flex" : "none") + '">' +
        '    <select class="form-control mnt-sev">' +
        SEVERITIES.map(function (s) {
          return '<option value="' + s + '"' + ((d.severity || "medium") === s ? " selected" : "") + ">" +
            s.charAt(0).toUpperCase() + s.slice(1) + "</option>";
        }).join("") +
        "    </select>" +
        '    <input type="text" class="form-control mnt-note" maxlength="300" ' +
        '      placeholder="What’s wrong? (e.g. remote missing)" value="' + esc(d.note || "") + '" />' +
        "  </div>" +
        "</div>";
    });

    if (!state.inspectItems.length) {
      html += '<div class="mnt-empty">Checklist is empty — an admin needs to add items in the Checklist tab first.</div>';
    }

    html +=
      '<div style="display:flex;gap:0.5rem;margin-top:1rem">' +
      '  <button class="action-btn btn-secondary" id="mnt-inspect-cancel" style="flex:1">Cancel</button>' +
      (state.inspectItems.length
        ? '<button class="action-btn btn-success" id="mnt-inspect-submit" style="flex:2">Submit Inspection</button>'
        : "") +
      "</div>";

    pane.innerHTML = html;

    // Show the hidden inspect pane
    var modal = document.getElementById("maintenance-modal");
    modal.querySelectorAll(".mnt-tab-pane").forEach(function (p) {
      p.classList.toggle("active", p.id === "mnt-pane-inspect");
    });
    modal.querySelectorAll(".mnt-tab-btn").forEach(function (b) {
      b.classList.remove("active");
    });

    function backToDashboard() { switchTab("dashboard"); }
    document.getElementById("mnt-inspect-back").addEventListener("click", backToDashboard);
    document.getElementById("mnt-inspect-cancel").addEventListener("click", backToDashboard);
    document.getElementById("mnt-all-ok").addEventListener("click", function () {
      state.inspectItems.forEach(function (it) {
        state.inspectDraft[it.id] = { status: "ok", severity: "medium", note: "" };
      });
      saveDraft();
      renderInspectForm();
    });

    pane.querySelectorAll(".mnt-check-row").forEach(function (row) {
      var id = row.dataset.item;
      function draft() {
        return (state.inspectDraft[id] =
          state.inspectDraft[id] || { status: null, severity: "medium", note: "" });
      }
      row.querySelector(".mnt-ok-btn").addEventListener("click", function () {
        draft().status = "ok";
        row.querySelector(".mnt-ok-btn").classList.add("sel-ok");
        row.querySelector(".mnt-issue-btn").classList.remove("sel-issue");
        row.querySelector(".mnt-issue-detail").style.display = "none";
        saveDraft();
      });
      row.querySelector(".mnt-issue-btn").addEventListener("click", function () {
        draft().status = "issue";
        row.querySelector(".mnt-issue-btn").classList.add("sel-issue");
        row.querySelector(".mnt-ok-btn").classList.remove("sel-ok");
        row.querySelector(".mnt-issue-detail").style.display = "flex";
        saveDraft();
      });
      row.querySelector(".mnt-sev").addEventListener("change", function (e) {
        draft().severity = e.target.value;
        saveDraft();
      });
      row.querySelector(".mnt-note").addEventListener("input", function (e) {
        draft().note = e.target.value;
        saveDraft();
      });
    });

    var submitBtn = document.getElementById("mnt-inspect-submit");
    if (submitBtn) submitBtn.addEventListener("click", submitInspection);
  }

  function submitInspection() {
    var missing = state.inspectItems.filter(function (it) {
      var d = state.inspectDraft[it.id];
      return !d || (d.status !== "ok" && d.status !== "issue");
    });
    if (missing.length) {
      notify("Please mark every item — " + missing.length + " unchecked (or use All OK first)", "error");
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
    var btn = document.getElementById("mnt-inspect-submit");
    btn.disabled = true;
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
        switchTab("dashboard");
      })
      .catch(function (e) { notify(e.message, "error"); btn.disabled = false; });
  }

  // ── issues ──────────────────────────────────────────────────────────────

  var TRADES = {
    electrical: "⚡ Electrical",
    washroom:   "🔧 Plumbing",
    furniture:  "🪚 Carpentry",
    appliances: "📺 Appliances",
    general:    "🧱 General",
  };
  var STATUS_LABEL = { open: "OPEN", fixed: "TO VERIFY", verified: "DONE" };

  function loadIssues() {
    var pane = document.getElementById("mnt-pane-issues");
    var hasCache = !!state._issuesLoaded;
    if (hasCache) renderIssues();
    else pane.innerHTML = '<div class="mnt-empty">Loading…</div>';
    api("/maintenance/issues")
      .then(function (json) {
        state.issues = json.issues || [];
        state._issuesLoaded = true;
        renderIssues();
      })
      .catch(function (e) {
        if (hasCache) notify(e.message, "error");
        else pane.innerHTML = '<div class="mnt-empty">' + esc(e.message) + "</div>";
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
    return parts.join('<span class="mnt-who-sep">→</span>');
  }

  function renderIssues() {
    var pane = document.getElementById("mnt-pane-issues");
    var all = state.issues;

    function nStatus(s) {
      if (s === "all") return all.length;
      return all.filter(function (i) { return i.status === s; }).length;
    }

    var html =
      '<div class="mnt-issues-bar">' +
      '  <select class="form-control" id="mnt-trade-sel">' +
      '    <option value="all">👷 All workers</option>' +
      CATEGORIES.map(function (c) {
        return '<option value="' + c + '"' + (state.issueTrade === c ? " selected" : "") +
          ">" + TRADES[c] + "</option>";
      }).join("") +
      "  </select>" +
      '  <div class="mnt-status-seg">' +
      [["open", "Open"], ["fixed", "To verify"], ["verified", "Done"], ["all", "All"]]
        .map(function (c) {
          return '<button class="' + (state.issueFilter === c[0] ? "active" : "") +
            '" data-filter="' + c[0] + '">' + c[1] + " " + nStatus(c[0]) + "</button>";
        }).join("") +
      "  </div>" +
      (can("maintenance.inspect")
        ? '<button class="action-btn btn-primary" id="mnt-log-issue" style="padding:0.3rem 0.7rem">＋ Log</button>'
        : "") +
      "</div>" +
      '<div id="mnt-log-issue-form" style="display:none"></div>';

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
      html += '<div class="mnt-empty">Nothing here 🎉</div>';
    } else {
      html += '<div class="mnt-ilist">';
      visible.forEach(function (iss) {
        var trade = TRADES[iss.category] ? iss.category : "general";
        html +=
          '<div class="mnt-irow" data-issue="' + esc(iss.id) + '">' +
          '  <div class="mnt-irow-line">' +
          '    <span class="mnt-dot sev-' + esc(iss.severity || "low") + '" title="' + esc(iss.severity) + '"></span>' +
          '    <span class="mnt-irow-room">' + esc(iss.room) + "</span>" +
          '    <span class="mnt-irow-label">' + esc(iss.item_label) +
          '      <small>' + TRADES[trade] + "</small>" +
          (iss.description
            ? '<span class="mnt-irow-note">· ' + esc(iss.description) + "</span>"
            : "") +
          "    </span>" +
          '    <span class="mnt-irow-status st-' + esc(iss.status) + '">' +
          (STATUS_LABEL[iss.status] || iss.status) + "</span>" +
          (iss.status === "open" && can("maintenance.issue.fix")
            ? '<button class="mnt-irow-btn fix mnt-qfix" title="Mark fixed">✓</button>'
            : "") +
          (iss.status === "fixed" && can("maintenance.issue.verify")
            ? '<button class="mnt-irow-btn fix mnt-qverify" title="Verify fix">✓✓</button>'
            : "") +
          ((iss.status === "fixed" || iss.status === "verified") && can("maintenance.issue.verify")
            ? '<button class="mnt-irow-btn warn mnt-qreopen" title="Reopen">↩</button>'
            : "") +
          (can("maintenance.manage")
            ? '<button class="mnt-irow-btn del mnt-qdel" title="Delete">🗑</button>'
            : "") +
          "  </div>" +
          '  <div class="mnt-irow-who">' + whoLine(iss) + "</div>" +
          "</div>";
      });
      html += "</div>";
    }
    pane.innerHTML = html;

    document.getElementById("mnt-trade-sel").addEventListener("change", function (e) {
      state.issueTrade = e.target.value;
      renderIssues();
    });
    pane.querySelectorAll(".mnt-status-seg button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.issueFilter = btn.dataset.filter;
        renderIssues();
      });
    });
    var logBtn = document.getElementById("mnt-log-issue");
    if (logBtn) logBtn.addEventListener("click", toggleLogIssueForm);

    pane.querySelectorAll(".mnt-irow").forEach(function (row) {
      var id = row.dataset.issue;

      var qfix = row.querySelector(".mnt-qfix");
      if (qfix) qfix.addEventListener("click", function () {
        qfix.disabled = true;
        post("/maintenance/issues/" + id + "/fix", { note: "", cost: null })
          .then(function (json) { applyIssueUpdate(json.issue); })
          .catch(function (err) { notify(err.message, "error"); qfix.disabled = false; });
      });

      var qverify = row.querySelector(".mnt-qverify");
      if (qverify) qverify.addEventListener("click", function () {
        qverify.disabled = true;
        post("/maintenance/issues/" + id + "/verify")
          .then(function (json) { applyIssueUpdate(json.issue); })
          .catch(function (err) { notify(err.message, "error"); qverify.disabled = false; });
      });

      var qreopen = row.querySelector(".mnt-qreopen");
      if (qreopen) qreopen.addEventListener("click", function () {
        qreopen.disabled = true;
        post("/maintenance/issues/" + id + "/reopen", { reason: "" })
          .then(function (json) { applyIssueUpdate(json.issue); })
          .catch(function (err) { notify(err.message, "error"); qreopen.disabled = false; });
      });

      var qdel = row.querySelector(".mnt-qdel");
      if (qdel) qdel.addEventListener("click", function () {
        if (qdel.dataset.armed !== "1") {
          qdel.dataset.armed = "1";
          qdel.classList.add("armed");
          qdel.textContent = "?";
          qdel.title = "Tap again to delete";
          setTimeout(function () {
            if (qdel.isConnected) {
              qdel.dataset.armed = "";
              qdel.classList.remove("armed");
              qdel.textContent = "🗑";
              qdel.title = "Delete";
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
    var box = document.getElementById("mnt-log-issue-form");
    if (box.style.display !== "none") { box.style.display = "none"; return; }
    var roomOpts = roomNumbers().map(function (r) {
      return '<option value="' + esc(r) + '">' + esc(r) + "</option>";
    }).join("");
    box.innerHTML =
      '<div class="mnt-form-grid">' +
      '  <select class="form-control" id="mnt-new-room"><option value="">Room…</option>' + roomOpts + "</select>" +
      '  <input type="text" class="form-control" id="mnt-new-item" maxlength="80" placeholder="What is broken? (e.g. Kettle)" />' +
      '  <select class="form-control" id="mnt-new-sev">' +
      SEVERITIES.map(function (s) {
        return '<option value="' + s + '"' + (s === "medium" ? " selected" : "") + ">" + s + "</option>";
      }).join("") +
      "  </select>" +
      '  <select class="form-control" id="mnt-new-cat">' +
      CATEGORIES.map(function (c) {
        return '<option value="' + c + '">' + (TRADES[c] || c) + "</option>";
      }).join("") +
      "  </select>" +
      '  <input type="text" class="form-control" id="mnt-new-desc" maxlength="300" placeholder="Details (optional)" style="flex:2" />' +
      '  <button class="action-btn btn-primary" id="mnt-new-save">Log</button>' +
      "</div>";
    box.style.display = "block";
    document.getElementById("mnt-new-save").addEventListener("click", function () {
      var room = document.getElementById("mnt-new-room").value;
      if (!room) { notify("Pick a room", "error"); return; }
      post("/maintenance/issues", {
        room: room,
        item_label: document.getElementById("mnt-new-item").value,
        severity: document.getElementById("mnt-new-sev").value,
        category: document.getElementById("mnt-new-cat").value,
        description: document.getElementById("mnt-new-desc").value,
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
    var pane = document.getElementById("mnt-pane-analytics");
    if (state.analytics) renderAnalytics();
    else pane.innerHTML = '<div class="mnt-empty">Crunching…</div>';
    api("/maintenance/analytics")
      .then(function (json) { state.analytics = json.analytics; renderAnalytics(); })
      .catch(function (e) {
        if (state.analytics) notify(e.message, "error");
        else pane.innerHTML = '<div class="mnt-empty">' + esc(e.message) + "</div>";
      });
  }

  function bars(rows, getLabel, getCount) {
    var max = rows.reduce(function (m, r) { return Math.max(m, getCount(r)); }, 0) || 1;
    return rows.map(function (r) {
      var c = getCount(r);
      return (
        '<div class="mnt-bar-row">' +
        '  <span class="mnt-bar-label" title="' + esc(getLabel(r)) + '">' + esc(getLabel(r)) + "</span>" +
        '  <span class="mnt-bar-track"><span class="mnt-bar-fill" style="width:' +
        Math.round((100 * c) / max) + '%"></span></span>' +
        '  <span class="mnt-bar-count">' + c + "</span>" +
        "</div>"
      );
    }).join("");
  }

  function renderAnalytics() {
    var a = state.analytics;
    var pane = document.getElementById("mnt-pane-analytics");
    if (!a) { pane.innerHTML = '<div class="mnt-empty">No data</div>'; return; }

    var html =
      '<div class="mnt-cards">' +
      '  <div class="mnt-card ' + (a.counts.open ? "warn" : "good") + '"><div class="mnt-card-num">' + a.counts.open + '</div><div class="mnt-card-lbl">Open</div></div>' +
      '  <div class="mnt-card"><div class="mnt-card-num">' + a.counts.fixed + '</div><div class="mnt-card-lbl">Awaiting verify</div></div>' +
      '  <div class="mnt-card good"><div class="mnt-card-num">' + a.counts.verified + '</div><div class="mnt-card-lbl">Verified</div></div>' +
      '  <div class="mnt-card"><div class="mnt-card-num">' + (a.avg_fix_hours != null ? a.avg_fix_hours + "h" : "—") + '</div><div class="mnt-card-lbl">Avg fix time</div></div>' +
      '  <div class="mnt-card"><div class="mnt-card-num">₹' + (a.total_cost || 0) + '</div><div class="mnt-card-lbl">Repair spend</div></div>' +
      '  <div class="mnt-card"><div class="mnt-card-num">' + a.total_inspections + '</div><div class="mnt-card-lbl">Inspections</div></div>' +
      "</div>";

    var problemRooms = a.rooms
      .filter(function (r) { return r.total_issues > 0; })
      .sort(function (x, y) { return y.total_issues - x.total_issues; })
      .slice(0, 10);
    html += '<div class="mnt-section-title">Rooms with most issues</div>';
    html += problemRooms.length
      ? bars(problemRooms,
          function (r) {
            return "Room " + r.room + (r.high_open ? " ⚠" : "") +
              (r.last_score != null ? " · " + r.last_score + "%" : "");
          },
          function (r) { return r.total_issues; })
      : '<div class="mnt-empty">No issues recorded yet</div>';

    html += '<div class="mnt-section-title">Most-failing items</div>';
    html += (a.top_failing_items || []).length
      ? bars(a.top_failing_items,
          function (r) { return r.label; },
          function (r) { return r.count; })
      : '<div class="mnt-empty">No failures recorded yet</div>';

    var cats = Object.keys(a.category_breakdown || {}).map(function (k) {
      return { label: CAT_LABELS[k] || k, count: a.category_breakdown[k] };
    }).sort(function (x, y) { return y.count - x.count; });
    html += '<div class="mnt-section-title">Failures by category</div>';
    html += cats.length
      ? bars(cats, function (r) { return r.label; }, function (r) { return r.count; })
      : '<div class="mnt-empty">Nothing yet</div>';

    pane.innerHTML = html;
  }

  // ── checklist editor (admin) ────────────────────────────────────────────

  function renderChecklistEditor() {
    var pane = document.getElementById("mnt-pane-checklist");
    pane.innerHTML = '<div class="mnt-empty">Loading…</div>';
    api("/maintenance/checklist?all=1")
      .then(function (json) {
        state.categories = json.categories || state.categories;
        drawEditor(json.items || []);
      })
      .catch(function (e) {
        pane.innerHTML = '<div class="mnt-empty">' + esc(e.message) + "</div>";
      });

    function scopeSummary(cats) {
      if (!cats || !cats.length || cats.indexOf("all") !== -1) return "🏷 All rooms";
      return "🏷 " + (cats.length <= 2 ? cats.join(", ") : cats.length + " categories");
    }

    function drawEditor(items) {
      var html =
        '<div class="mnt-section-title">Checklist template — items appear in this order during inspection (use ▲▼ to move)</div>';
      if (!items.length) {
        html += '<div class="mnt-empty">No checklist items yet — tap ＋ Add item to create your first one.</div>';
      }
      items.forEach(function (it, i) {
        var cats = it.room_categories || ["all"];
        html +=
          '<div class="mnt-tpl-row' + (it.active ? "" : " inactive") + '" data-idx="' + i +
          '" data-cats="' + esc(JSON.stringify(cats)) + '">' +
          '  <span class="mnt-tpl-btn mnt-tpl-drag" title="Drag to reorder">⠿</span>' +
          '  <input type="text" class="form-control mnt-tpl-icon" value="' + esc(it.icon || "") + '" title="Icon" />' +
          '  <input type="text" class="form-control mnt-tpl-label" maxlength="80" value="' + esc(it.label) + '" />' +
          '  <select class="form-control mnt-tpl-cat">' +
          CATEGORIES.map(function (c) {
            return '<option value="' + c + '"' + (it.category === c ? " selected" : "") + ">" + c + "</option>";
          }).join("") +
          "  </select>" +
          '  <button class="mnt-tpl-btn mnt-tpl-scope" title="Which room categories this applies to">' +
          scopeSummary(cats) + "</button>" +
          '  <button class="mnt-tpl-btn mnt-tpl-toggle" title="Enable/disable">' + (it.active ? "🟢" : "⚪") + "</button>" +
          '  <button class="mnt-tpl-btn mnt-tpl-del" title="Remove">🗑</button>' +
          '  <div class="mnt-tpl-cats" style="display:none">' +
          '    <span class="mnt-chip mnt-cat-chip' + (cats.indexOf("all") !== -1 ? " active" : "") +
          '" data-cat="all">All rooms</span>' +
          state.categories.map(function (c) {
            return '<span class="mnt-chip mnt-cat-chip' +
              (cats.indexOf(c) !== -1 ? " active" : "") + '" data-cat="' + esc(c) + '">' +
              esc(c) + "</span>";
          }).join("") +
          "  </div>" +
          "</div>";
      });
      html +=
        '<div class="mnt-tpl-actions">' +
        '  <button class="action-btn btn-secondary" id="mnt-tpl-add">＋ Add item</button>' +
        (items.length
          ? '<button class="action-btn btn-secondary" id="mnt-tpl-clear">Clear all</button>'
          : "") +
        '  <button class="action-btn btn-primary" id="mnt-tpl-save">Save Checklist</button>' +
        "</div>";
      pane.innerHTML = html;

      function collect() {
        return Array.prototype.map.call(
          pane.querySelectorAll(".mnt-tpl-row"),
          function (row, i) {
            var src = items[Number(row.dataset.idx)] || {};
            var cats;
            try { cats = JSON.parse(row.dataset.cats || '["all"]'); }
            catch (_) { cats = ["all"]; }
            return {
              id: src.id,
              icon: row.querySelector(".mnt-tpl-icon").value,
              label: row.querySelector(".mnt-tpl-label").value,
              category: row.querySelector(".mnt-tpl-cat").value,
              active: !row.classList.contains("inactive"),
              order: i,
              room_categories: cats,
            };
          }
        );
      }

      pane.querySelectorAll(".mnt-tpl-row").forEach(function (row) {
        var scopeBtn = row.querySelector(".mnt-tpl-scope");
        var chipBox = row.querySelector(".mnt-tpl-cats");
        scopeBtn.addEventListener("click", function () {
          chipBox.style.display = chipBox.style.display === "none" ? "flex" : "none";
        });
        chipBox.querySelectorAll(".mnt-cat-chip").forEach(function (chip) {
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
            chipBox.querySelectorAll(".mnt-cat-chip").forEach(function (ch) {
              ch.classList.toggle("active", cats.indexOf(ch.dataset.cat) !== -1);
            });
            scopeBtn.innerHTML = scopeSummary(cats);
          });
        });
        row.querySelector(".mnt-tpl-toggle").addEventListener("click", function () {
          items = collect();
          items[Array.prototype.indexOf.call(pane.querySelectorAll(".mnt-tpl-row"), row)].active =
            row.classList.contains("inactive"); // flipping
          drawEditor(items);
        });
        row.querySelector(".mnt-tpl-del").addEventListener("click", function () {
          items = collect();
          items.splice(Array.prototype.indexOf.call(pane.querySelectorAll(".mnt-tpl-row"), row), 1);
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
      pane.querySelectorAll(".mnt-tpl-row").forEach(function (row) {
        var handle = row.querySelector(".mnt-tpl-drag");

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
          var el = document.elementFromPoint(t.clientX, t.clientY);
          var target = el && el.closest ? el.closest(".mnt-tpl-row") : null;
          if (!target || target === dragRow) return;
          var rect = target.getBoundingClientRect();
          var after = t.clientY > rect.top + rect.height / 2;
          target.parentNode.insertBefore(dragRow, after ? target.nextSibling : target);
        }, { passive: false });
        handle.addEventListener("touchend", settleDrag);
      });

      var clearBtn = document.getElementById("mnt-tpl-clear");
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
        drawEditor([]);   // still needs Save Checklist to persist
      });
      document.getElementById("mnt-tpl-add").addEventListener("click", function () {
        items = collect();
        items.push({ id: null, icon: "", label: "", category: "general",
                     active: true, room_categories: ["all"] });
        drawEditor(items);
      });
      document.getElementById("mnt-tpl-save").addEventListener("click", function () {
        var payload = collect().filter(function (it) { return it.label.trim(); });
        post("/maintenance/checklist", { items: payload })   // empty list allowed
          .then(function () { notify("Checklist saved", "success"); renderChecklistEditor(); })
          .catch(function (e) { notify(e.message, "error"); });
      });
    }
  }

  // ── history (rounds → per-room inspectors → inspection record) ─────────

  function loadHistory() {
    var pane = document.getElementById("mnt-pane-history");
    if (state._rounds) renderHistory(state._rounds);
    else pane.innerHTML = '<div class="mnt-empty">Loading…</div>';
    api("/maintenance/rounds")
      .then(function (json) {
        state._rounds = json.rounds || [];
        renderHistory(state._rounds);
      })
      .catch(function (e) {
        if (state._rounds) notify(e.message, "error");
        else pane.innerHTML = '<div class="mnt-empty">' + esc(e.message) + "</div>";
      });
  }

  function renderHistory(rounds) {
    var pane = document.getElementById("mnt-pane-history");
    if (!rounds.length) {
      pane.innerHTML = '<div class="mnt-empty">No inspection rounds yet</div>';
      return;
    }
    var html = '<div class="mnt-section-title">Inspection rounds</div>';
    rounds.forEach(function (r) {
      html +=
        '<div class="mnt-issue-card mnt-round-card" data-round="' + esc(r.id) + '">' +
        '  <div class="mnt-issue-head">' +
        '    <span class="mnt-issue-title">' + esc(r.name) + "</span>" +
        '    <span class="mnt-badge ' + (r.status === "open" ? "st-fixed" : "st-verified") + '">' +
        (r.status === "open" ? "in progress" : "closed") + "</span>" +
        "  </div>" +
        '  <div class="mnt-issue-meta">' +
        "Started " + fmtDate(r.created_at) + " by " + esc((r.created_by || {}).name || "?") +
        (r.status === "closed"
          ? " · Ended " + fmtDate(r.closed_at) + " by " + esc((r.closed_by || {}).name || "?")
          : "") +
        " · " + r.rooms_inspected + "/" + r.rooms_total + " rooms · " +
        r.issues_found + " issue(s) found" +
        "  </div>" +
        "</div>";
    });
    pane.innerHTML = html;
    pane.querySelectorAll(".mnt-round-card").forEach(function (card) {
      card.addEventListener("click", function () {
        for (var i = 0; i < rounds.length; i++) {
          if (rounds[i].id === card.dataset.round) { renderRoundDetail(rounds[i]); return; }
        }
      });
    });
  }

  function renderRoundDetail(rnd) {
    var pane = document.getElementById("mnt-pane-history");
    pane.innerHTML = '<div class="mnt-empty">Loading…</div>';
    api("/maintenance/rounds/" + rnd.id + "/status")
      .then(function (json) {
        var rooms = (json.rooms || []).filter(function (r) { return r.inspected; });
        var html =
          '<div class="mnt-round-box">' +
          '  <button class="action-btn btn-secondary" id="mnt-hist-back">← Back</button>' +
          '  <span class="mnt-round-name">' + esc(rnd.name) + "</span>" +
          '  <span style="font-size:0.78rem;color:#4a5568">' +
          fmtDate(rnd.created_at) + " → " +
          (rnd.status === "closed" ? fmtDate(rnd.closed_at) : "ongoing") +
          "  </span>" +
          "</div>";
        if (!rooms.length) {
          html += '<div class="mnt-empty">No rooms were inspected in this round</div>';
        } else {
          html += '<div class="mnt-section-title">Inspected rooms — tap for the full record</div>';
          rooms.forEach(function (r) {
            html +=
              '<div class="mnt-hist-row" data-room="' + esc(r.room) + '">' +
              "  <b>Room " + esc(r.room) + "</b>" +
              '  <span class="mnt-badge sev">' + (r.score != null ? r.score + "%" : "—") + "</span>" +
              "  <span>" + r.issue_count + " issue(s)</span>" +
              '  <span class="mnt-hist-by">' + esc(r.inspected_by || "?") +
              " · " + fmtWhen(r.inspected_at) + "</span>" +
              "</div>";
          });
        }
        pane.innerHTML = html;
        document.getElementById("mnt-hist-back").addEventListener("click", loadHistory);
        pane.querySelectorAll(".mnt-hist-row").forEach(function (row) {
          row.addEventListener("click", function () {
            renderInspectionView(rnd, row.dataset.room, pane, function () {
              renderRoundDetail(rnd);
            });
          });
        });
      })
      .catch(function (e) {
        pane.innerHTML = '<div class="mnt-empty">' + esc(e.message) + "</div>";
      });
  }

  // Read-only inspection record: who, when, item-by-item results.
  // Used from History and from the dashboard grid (inspected rooms).
  function renderInspectionView(rnd, room, pane, onBack) {
    pane.innerHTML = '<div class="mnt-empty">Loading…</div>';
    api("/maintenance/inspections/" + rnd.id + "/" + encodeURIComponent(room))
      .then(function (json) {
        var ins = json.inspection;
        if (!ins) {
          pane.innerHTML = '<div class="mnt-empty">No inspection record found</div>';
          return;
        }
        var canRe = rnd.status === "open" && state.openRound &&
          state.openRound.id === rnd.id && can("maintenance.inspect");
        var html =
          '<div class="mnt-round-box">' +
          '  <button class="action-btn btn-secondary" id="mnt-view-back">← Back</button>' +
          '  <span class="mnt-round-name">Room ' + esc(room) +
          (ins.score != null ? ' — ' + ins.score + "%" : "") + "</span>" +
          (canRe
            ? '<button class="action-btn btn-primary" id="mnt-view-reinspect">Re-inspect</button>'
            : "") +
          "</div>" +
          '<div class="mnt-issue-meta" style="margin:0.5rem 0 0.25rem">Inspected by <b>' +
          esc((ins.inspected_by || {}).name || "?") + "</b> · " +
          fmtWhen(ins.inspected_at) + " · " + (ins.ok_count || 0) + " OK / " +
          (ins.issue_count || 0) + " problem(s)</div>";
        (ins.items || []).forEach(function (it) {
          html +=
            '<div class="mnt-check-row">' +
            '  <span class="mnt-check-label">' + esc(it.label) + "</span>" +
            (it.status === "ok"
              ? '<span class="mnt-badge st-verified">OK</span>'
              : '<span class="mnt-badge st-open">' + esc(it.severity || "issue") + "</span>" +
                (it.note
                  ? '<span style="font-size:0.8rem;color:#718096">' + esc(it.note) + "</span>"
                  : "")) +
            "</div>";
        });
        pane.innerHTML = html;
        document.getElementById("mnt-view-back").addEventListener("click", onBack);
        var re = document.getElementById("mnt-view-reinspect");
        if (re) re.addEventListener("click", function () { openInspectForm(room); });
      })
      .catch(function (e) {
        pane.innerHTML = '<div class="mnt-empty">' + esc(e.message) + "</div>";
      });
  }

  // ── bootstrap ───────────────────────────────────────────────────────────

  function bind() {
    var btn = document.getElementById("quick-maintenance-btn");
    if (btn) {
      btn.addEventListener("click", function () {
        var menu = document.querySelector(".quick-action-menu");
        if (menu) menu.classList.remove("show");
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
