/* ─────────────────────────────────────────────────────────────────────────
 * Admin: Users + Audit Log panel.
 *
 * Self-contained: injects its own styles, FAB trigger, and modal. Visible
 * only to users with role=admin. All API calls flow through fetch which
 * is wrapped by auth.js to attach the Bearer token automatically.
 * ──────────────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  const STYLE_ID = "cibara-admin-users-style";
  const FAB_ID = "cibara-admin-users-fab";
  const MODAL_ID = "cibara-admin-users-modal";

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
      #${MODAL_ID} {
        position: fixed; inset: 0; z-index: 99997; display: none;
        background: rgba(8, 12, 30, .55); backdrop-filter: blur(4px);
        align-items: center; justify-content: center; padding: 20px;
        font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      }
      #${MODAL_ID}.show { display: flex; animation: cau-fade .15s ease-out; }
      @keyframes cau-fade { from { opacity: 0; } to { opacity: 1; } }

      .cau-card {
        width: 100%; max-width: 880px; max-height: 88vh;
        background: #fff; color: #1e293b;
        border-radius: 14px; box-shadow: 0 30px 60px -20px rgba(0,0,0,.5);
        display: flex; flex-direction: column; overflow: hidden;
      }
      .cau-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 14px 18px; border-bottom: 1px solid #eef2f7;
      }
      .cau-title { margin: 0; font-size: 1.05rem; font-weight: 700; letter-spacing: -.01em; }
      .cau-tabs { display: flex; gap: 4px; padding: 0 18px; border-bottom: 1px solid #eef2f7; }
      .cau-tab {
        padding: 10px 14px; border: 0; background: transparent; cursor: pointer;
        font-size: .85rem; font-weight: 600; color: #64748b;
        border-bottom: 2px solid transparent; margin-bottom: -1px;
      }
      .cau-tab.active { color: #6366f1; border-bottom-color: #6366f1; }
      .cau-body { padding: 16px 18px; overflow: auto; }
      .cau-close {
        background: transparent; border: 0; cursor: pointer; color: #64748b;
        padding: 6px; border-radius: 6px;
      }
      .cau-close:hover { background: #f1f5f9; color: #1e293b; }

      .cau-toolbar { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
      .cau-btn {
        padding: 7px 12px; border: 1px solid #e2e8f0; background: #fff; cursor: pointer;
        border-radius: 8px; font: 600 .82rem 'Inter', sans-serif; color: #1e293b;
        display: inline-flex; align-items: center; gap: 6px;
      }
      .cau-btn:hover { background: #f8fafc; border-color: #cbd5e1; }
      .cau-btn-primary {
        background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
        color: #fff; border: 0;
        transition: filter .15s, transform .1s, box-shadow .15s;
        box-shadow: 0 4px 12px -4px rgba(99,102,241,.4);
      }
      /* Override the generic .cau-btn:hover so the gradient stays visible */
      .cau-btn-primary:hover {
        background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
        border: 0;
        filter: brightness(1.08);
        box-shadow: 0 6px 16px -4px rgba(99,102,241,.55);
        transform: translateY(-1px);
      }
      .cau-btn-primary:active { transform: translateY(0); filter: brightness(0.98); }
      .cau-btn-primary:disabled { opacity: .6; cursor: not-allowed; transform: none; }
      .cau-btn-danger { color: #dc2626; border-color: #fecaca; }
      .cau-btn-danger:hover { background: #fef2f2; }

      .cau-table { width: 100%; border-collapse: collapse; font-size: .85rem; }
      .cau-table th, .cau-table td {
        text-align: left; padding: 10px 8px; border-bottom: 1px solid #eef2f7;
      }
      .cau-table th { color: #64748b; font-weight: 600; font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; background: #f8fafc; }
      .cau-table tbody tr:hover { background: #f8fafc; }
      .cau-badge {
        display: inline-block; padding: 2px 8px; border-radius: 999px;
        font-size: .68rem; font-weight: 700; letter-spacing: .03em; text-transform: uppercase;
      }
      .cau-badge-admin { background: #ede9fe; color: #6d28d9; }
      .cau-badge-manager { background: #dbeafe; color: #1d4ed8; }
      .cau-badge-housekeeping { background: #ecfccb; color: #4d7c0f; }
      .cau-badge-inactive { background: #f1f5f9; color: #94a3b8; }

      .cau-form { display: grid; gap: 10px; max-width: 420px; }
      .cau-field { display: flex; flex-direction: column; gap: 4px; }
      .cau-label { font: 600 .75rem 'Inter', sans-serif; color: #475569; text-transform: uppercase; letter-spacing: .03em; }
      .cau-input, .cau-select {
        padding: 8px 10px; border: 1px solid #e2e8f0; border-radius: 8px;
        font: 400 .9rem 'Inter', sans-serif; color: #1e293b; outline: none;
      }
      .cau-input:focus, .cau-select:focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,.15); }

      .cau-error { color: #dc2626; font-size: .82rem; margin-top: 4px; }
      .cau-empty { padding: 32px 0; text-align: center; color: #94a3b8; font-size: .9rem; }
      .cau-loading { padding: 32px 0; text-align: center; color: #94a3b8; }

      .cau-log-row { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .78rem; }
      .cau-log-action { color: #6366f1; font-weight: 600; }

      /* ── Audit logs — single-line filter bar ─────────────────────────── */
      .cau-flt {
        background: #fff;
        border: 1px solid #eef2f7;
        border-radius: 12px;
        padding: 8px;
        margin-bottom: 14px;
      }
      .cau-flt-bar {
        display: flex; flex-wrap: wrap; align-items: center;
        gap: 6px;
      }
      .cau-flt-cell {
        position: relative;
        display: flex; align-items: center;
        flex: 0 1 auto;
      }
      .cau-flt-icon {
        position: absolute; left: 10px; top: 50%;
        transform: translateY(-50%);
        color: #94a3b8; pointer-events: none;
      }
      .cau-flt-cell input {
        padding: 8px 10px 8px 32px;
        border: 1px solid #e2e8f0; border-radius: 8px;
        font: 400 .82rem 'Inter', sans-serif; color: #1e293b;
        outline: none; background: #fff; cursor: text;
        transition: border-color .12s, box-shadow .12s;
        width: 100%;
      }
      .cau-flt-cell input::placeholder { color: #94a3b8; }
      .cau-flt-cell input:focus,
      .cau-flt-input:focus,
      .cau-flt-select:focus {
        border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,.12);
      }
      .cau-flt-cell-range { flex: 1 1 170px; min-width: 150px; max-width: 220px; }
      .cau-flt-cell-range input { cursor: pointer; }
      /* flatpickr's altInput inherits — strip its default left padding */
      .cau-flt-cell-range input.flatpickr-alt-input,
      .cau-flt-cell-range input.flatpickr-input {
        padding-left: 32px !important;
      }
      .cau-flt-cell-search { flex: 1 1 160px; min-width: 140px; }

      .cau-flt-select, .cau-flt-input {
        padding: 8px 10px;
        border: 1px solid #e2e8f0; border-radius: 8px;
        font: 400 .82rem 'Inter', sans-serif; color: #1e293b;
        outline: none; background: #fff;
        transition: border-color .12s, box-shadow .12s;
      }
      .cau-flt-select { min-width: 110px; max-width: 150px; }
      .cau-flt-input { min-width: 100px; max-width: 130px; }

      .cau-flt-toggle {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 6px 10px; border-radius: 8px;
        font: 500 .8rem 'Inter', sans-serif; color: #475569;
        cursor: pointer; user-select: none;
        background: #f8fafc;
        white-space: nowrap;
        transition: background .12s;
      }
      .cau-flt-toggle:hover { background: #f1f5f9; }
      .cau-flt-toggle input {
        margin: 0; accent-color: #6366f1;
      }

      .cau-flt-reset {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 7px 12px; border: 0; border-radius: 8px;
        background: #ede9fe; color: #6d28d9;
        font: 600 .78rem 'Inter', sans-serif; cursor: pointer;
        white-space: nowrap;
        transition: background .12s;
      }
      .cau-flt-reset:hover { background: #ddd6fe; }
      .cau-flt-count {
        display: inline-grid; place-items: center;
        min-width: 18px; height: 18px; padding: 0 5px;
        border-radius: 999px;
        background: #6d28d9; color: #fff;
        font-size: .68rem; font-weight: 700;
      }

      /* Result count */
      .cau-log-count {
        font: 600 .78rem 'Inter', sans-serif;
        color: #64748b; margin-bottom: 8px;
      }

      @media (max-width: 540px) {
        .cau-flt-chips { gap: 5px; }
        .cau-fchip, .cau-flt-chip-toggle { padding: 5px 10px; font-size: .72rem; }
      }

      /* ── Last-login pills ─────────────────────────────────────────────── */
      .cau-loginstat {
        display: inline-block; padding: 2px 8px; border-radius: 999px;
        font-size: .72rem; font-weight: 600; letter-spacing: .02em;
      }
      .cau-loginstat-fresh    { background: #dcfce7; color: #166534; }
      .cau-loginstat-stale    { background: #fef9c3; color: #854d0e; }
      .cau-loginstat-dormant  { background: #fee2e2; color: #991b1b; }
      .cau-loginstat-never    { background: #e2e8f0; color: #475569; }

      .cau-dormant-toggle {
        display: inline-flex; align-items: center; gap: 6px;
        font: 500 .82rem 'Inter', sans-serif; color: #1e293b;
        cursor: pointer; user-select: none;
      }
      .cau-toolbar-spacer { flex: 1; }
      .cau-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .cau-legend { display: inline-flex; gap: 4px; }

      @media (max-width: 600px) {
        .cau-card { max-height: 100vh; height: 100vh; max-width: 100vw; border-radius: 0; }
      }
    `;
    const styleEl = document.createElement("style");
    styleEl.id = STYLE_ID;
    styleEl.textContent = css;
    document.head.appendChild(styleEl);
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // FAB removed — the admin console is now opened from the profile dropdown
  // (via window.CibaraAdmin.open). Function kept as a no-op so any other
  // call site doesn't NPE.
  function injectFab() { /* no-op */ }

  function injectModal() {
    if (document.getElementById(MODAL_ID)) return;
    const modal = document.createElement("div");
    modal.id = MODAL_ID;
    modal.innerHTML = `
      <div class="cau-card" role="dialog" aria-modal="true" aria-labelledby="cau-title">
        <div class="cau-header">
          <h2 class="cau-title" id="cau-title">Admin Console</h2>
          <button class="cau-close" id="cau-close" aria-label="Close">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="cau-tabs" role="tablist">
          <button class="cau-tab active" data-cau-tab="users" role="tab">Users</button>
          <button class="cau-tab" data-cau-tab="create" role="tab">Add user</button>
          <button class="cau-tab" data-cau-tab="logs" role="tab">Audit logs</button>
        </div>
        <div class="cau-body">
          <div data-cau-pane="users"></div>
          <div data-cau-pane="create" hidden></div>
          <div data-cau-pane="logs" hidden></div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener("click", function (ev) {
      if (ev.target === modal) closeModal();
    });
    document.getElementById("cau-close").addEventListener("click", closeModal);

    modal.querySelectorAll(".cau-tab").forEach(function (t) {
      t.addEventListener("click", function () {
        const which = t.getAttribute("data-cau-tab");
        modal.querySelectorAll(".cau-tab").forEach(function (x) { x.classList.toggle("active", x === t); });
        modal.querySelectorAll("[data-cau-pane]").forEach(function (p) {
          p.hidden = p.getAttribute("data-cau-pane") !== which;
        });
        if (which === "users") loadUsersPane();
        else if (which === "logs") loadLogsPane();
        else if (which === "create") renderCreatePane();
      });
    });

    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && modal.classList.contains("show")) closeModal();
    });
  }

  // Open the admin console. Optional `which` selects the initial tab:
  //   "users" (default) | "create" | "logs"
  function openModal(which) {
    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;
    modal.classList.add("show");
    const tab = which === "create" || which === "logs" ? which : "users";
    const tabBtn = modal.querySelector('.cau-tab[data-cau-tab="' + tab + '"]');
    if (tabBtn) tabBtn.click();
    else loadUsersPane();
  }

  function closeModal() {
    document.getElementById(MODAL_ID).classList.remove("show");
  }

  // ── Users pane ──────────────────────────────────────────────────────────
  async function loadUsersPane() {
    const pane = document.querySelector('[data-cau-pane="users"]');
    pane.innerHTML = '<div class="cau-loading">Loading users…</div>';

    try {
      const res = await fetch("/api/users");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const body = await res.json();
      if (!body.success) throw new Error(body.message || "Failed");
      renderUsers(pane, body.users || []);
    } catch (err) {
      pane.innerHTML =
        '<div class="cau-error">Failed to load users: ' + escapeHtml(err.message) + "</div>";
    }
  }

  function roleBadge(role) {
    const cls = "cau-badge cau-badge-" + role;
    return '<span class="' + cls + '">' + escapeHtml(role) + "</span>";
  }

  // ── Last-login helpers ───────────────────────────────────────────────────
  // lastLoginAt is stored as "YYYY-MM-DD HH:MM:SS" IST. We compute a coarse
  // "days since last login" client-side. Treat parse failures as "never".
  const DORMANT_THRESHOLD_DAYS = 60;
  const STALE_THRESHOLD_DAYS = 30;

  function _daysSince(lastLoginAt) {
    if (!lastLoginAt) return null;
    const d = new Date(String(lastLoginAt).replace(" ", "T"));
    if (isNaN(d.getTime())) return null;
    return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
  }

  function _lastLoginCell(lastLoginAt) {
    const days = _daysSince(lastLoginAt);
    if (days == null) {
      return '<span class="cau-loginstat cau-loginstat-never">never</span>';
    }
    let cls = "cau-loginstat-fresh";
    if (days >= DORMANT_THRESHOLD_DAYS) cls = "cau-loginstat-dormant";
    else if (days >= STALE_THRESHOLD_DAYS) cls = "cau-loginstat-stale";
    const label = days === 0 ? "today" : (days === 1 ? "yesterday" : days + "d ago");
    return '<span class="cau-loginstat ' + cls + '" title="' + escapeHtml(lastLoginAt) +
      '">' + escapeHtml(label) + '</span>';
  }

  // UI-side filter state for the users pane
  const _usersState = { dormantOnly: false };

  function renderUsers(pane, users) {
    if (!users.length) {
      pane.innerHTML = '<div class="cau-empty">No users yet.</div>';
      return;
    }

    // Sort: never-logged-in first (most concerning), then most-stale to freshest
    const decorated = users.map(function (u) {
      return { user: u, days: _daysSince(u.lastLoginAt) };
    });
    decorated.sort(function (a, b) {
      // never (null) → very large key so it sorts to the top
      const da = a.days == null ? 1e9 : a.days;
      const db = b.days == null ? 1e9 : b.days;
      return db - da;
    });

    const visible = decorated.filter(function (d) {
      if (!_usersState.dormantOnly) return true;
      // dormant = never logged in, or >= threshold
      return d.days == null || d.days >= DORMANT_THRESHOLD_DAYS;
    });

    const dormantCount = decorated.reduce(function (n, d) {
      return n + (d.days == null || d.days >= DORMANT_THRESHOLD_DAYS ? 1 : 0);
    }, 0);

    const rows = visible
      .map(function (d) {
        const u = d.user;
        const inactive = u.isActive === false;
        return (
          '<tr data-uid="' + escapeHtml(u.userId) + '">' +
          '<td><strong>' + escapeHtml(u.userId) + '</strong>' +
          (inactive ? ' <span class="cau-badge cau-badge-inactive">disabled</span>' : '') + '</td>' +
          '<td>' + escapeHtml(u.name || "") + '</td>' +
          '<td>' + roleBadge(u.role) + '</td>' +
          '<td>' + _lastLoginCell(u.lastLoginAt) + '</td>' +
          '<td style="white-space:nowrap;">' +
            '<button class="cau-btn" data-act="reset">Reset PW</button> ' +
            '<button class="cau-btn" data-act="logout">Force logout</button> ' +
            (inactive
              ? '<button class="cau-btn" data-act="activate">Activate</button>'
              : '<button class="cau-btn cau-btn-danger" data-act="deactivate">Deactivate</button>') +
          '</td>' +
          "</tr>"
        );
      })
      .join("");

    pane.innerHTML =
      '<div class="cau-toolbar">' +
        '<button class="cau-btn" id="cau-refresh-users">Refresh</button>' +
        '<label class="cau-dormant-toggle">' +
          '<input type="checkbox" id="cau-dormant-only"' +
            (_usersState.dormantOnly ? " checked" : "") + '>' +
          ' Show dormant only ' +
          '<span class="cau-badge cau-badge-inactive">' + dormantCount + '</span>' +
        '</label>' +
        '<span class="cau-toolbar-spacer"></span>' +
        '<span class="cau-legend">' +
          '<span class="cau-loginstat cau-loginstat-fresh">< 30d</span>' +
          '<span class="cau-loginstat cau-loginstat-stale">30–60d</span>' +
          '<span class="cau-loginstat cau-loginstat-dormant">≥ 60d</span>' +
        '</span>' +
      '</div>' +
      '<table class="cau-table">' +
      '<thead><tr><th>User ID</th><th>Name</th><th>Role</th><th>Last login</th><th>Actions</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>';

    pane.querySelector("#cau-refresh-users").addEventListener("click", loadUsersPane);

    const dormantToggle = pane.querySelector("#cau-dormant-only");
    if (dormantToggle) {
      dormantToggle.addEventListener("change", function () {
        _usersState.dormantOnly = !!dormantToggle.checked;
        renderUsers(pane, users);
      });
    }

    pane.querySelectorAll("button[data-act]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const tr = btn.closest("tr");
        const uid = tr.getAttribute("data-uid");
        const act = btn.getAttribute("data-act");
        if (act === "reset") return promptResetPassword(uid);
        if (act === "logout") return forceLogout(uid);
        if (act === "deactivate") return deactivateUser(uid);
        if (act === "activate") return activateUser(uid);
      });
    });
  }

  async function promptResetPassword(userId) {
    const pw = window.prompt("New password for " + userId + " (min 6 chars):");
    if (pw === null) return;
    if (pw.length < 6) { alert("Password must be at least 6 characters."); return; }
    try {
      const res = await fetch("/api/users/" + encodeURIComponent(userId) + "/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      const body = await res.json();
      if (!body.success) throw new Error(body.message || "Failed");
      alert("Password reset for " + userId + ".");
    } catch (err) {
      alert("Reset failed: " + err.message);
    }
  }

  async function forceLogout(userId) {
    if (!confirm("Force " + userId + " to log out of all sessions?")) return;
    try {
      const res = await fetch("/api/users/" + encodeURIComponent(userId) + "/force-logout", { method: "POST" });
      const body = await res.json();
      if (!body.success) throw new Error(body.message || "Failed");
      alert(userId + " has been logged out.");
    } catch (err) { alert("Force-logout failed: " + err.message); }
  }

  async function deactivateUser(userId) {
    if (!confirm("Deactivate " + userId + "? They will not be able to sign in.")) return;
    try {
      const res = await fetch("/api/users/" + encodeURIComponent(userId), { method: "DELETE" });
      const body = await res.json();
      if (!body.success) throw new Error(body.message || "Failed");
      loadUsersPane();
    } catch (err) { alert("Deactivate failed: " + err.message); }
  }

  async function activateUser(userId) {
    try {
      const res = await fetch("/api/users/" + encodeURIComponent(userId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: true }),
      });
      const body = await res.json();
      if (!body.success) throw new Error(body.message || "Failed");
      loadUsersPane();
    } catch (err) { alert("Activate failed: " + err.message); }
  }

  // ── Create pane ─────────────────────────────────────────────────────────
  function renderCreatePane() {
    const pane = document.querySelector('[data-cau-pane="create"]');
    pane.innerHTML =
      '<form class="cau-form" id="cau-create-form" autocomplete="off">' +
        '<div class="cau-field"><label class="cau-label" for="cau-c-uid">User ID</label>' +
          '<input class="cau-input" id="cau-c-uid" required minlength="2" maxlength="31" placeholder="lowercase letters / digits"></div>' +
        '<div class="cau-field"><label class="cau-label" for="cau-c-name">Name</label>' +
          '<input class="cau-input" id="cau-c-name" placeholder="Display name"></div>' +
        '<div class="cau-field"><label class="cau-label" for="cau-c-role">Role</label>' +
          '<select class="cau-select" id="cau-c-role" required>' +
            '<option value="manager">Manager</option>' +
            '<option value="housekeeping">Housekeeping</option>' +
            '<option value="admin">Admin</option>' +
          '</select></div>' +
        '<div class="cau-field"><label class="cau-label" for="cau-c-pw">Password (min 6)</label>' +
          '<input class="cau-input" id="cau-c-pw" type="password" required minlength="6"></div>' +
        '<div id="cau-c-err" class="cau-error" hidden></div>' +
        '<button class="cau-btn cau-btn-primary" type="submit">Create user</button>' +
      '</form>';

    const form = pane.querySelector("#cau-create-form");
    const err = pane.querySelector("#cau-c-err");
    form.addEventListener("submit", async function (ev) {
      ev.preventDefault();
      err.hidden = true;
      const userId = pane.querySelector("#cau-c-uid").value.trim().toLowerCase();
      const name = pane.querySelector("#cau-c-name").value.trim() || userId;
      const role = pane.querySelector("#cau-c-role").value;
      const password = pane.querySelector("#cau-c-pw").value;
      try {
        const res = await fetch("/api/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, name, role, password }),
        });
        const body = await res.json();
        if (!body.success) throw new Error(body.message || "Failed");
        form.reset();
        alert("User " + userId + " created.");
        // Switch back to the users tab
        document.querySelector('.cau-tab[data-cau-tab="users"]').click();
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
      }
    });
  }

  // ── Logs pane ───────────────────────────────────────────────────────────
  // Cached state so re-renders preserve the user's filter selections.
  // Default range is "today" — set lazily on first render so the IST
  // boundary is correct at the moment the user opens the panel.
  const _logsState = {
    from: "",
    to: "",
    userId: "",
    action: "",
    targetCollection: "",
    targetId: "",
    q: "",
    includeArchive: false,
    limit: 200,
    users: [],
    _initialised: false,
  };

  // Local-date YYYY-MM-DD. We deliberately AVOID toISOString() because it
  // converts to UTC — for an IST browser, after 18:30 UTC (midnight IST)
  // toISOString returns the previous day, so "today" silently became
  // yesterday's date in the audit-log filter. Use local date components.
  function _todayStr() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }
  function _localYmd(d) {
    if (!(d instanceof Date)) return "";
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }
  function _ensureDefaultRange() {
    if (_logsState._initialised) return;
    _logsState._initialised = true;
    const t = _todayStr();
    _logsState.from = t;
    _logsState.to = t;
  }

  // Curated list of well-known action keys. Mirrors the action vocabulary
  // emitted by services.audit_log + the route handlers. Keep this in sync
  // (extending is harmless; missing entries just don't show in the dropdown
  // but are still searchable via the free-text box).
  const KNOWN_ACTIONS = [
    "auth.password_change",
    "user.create",
    "user.update",
    "user.deactivate",
    "user.reset_password",
    "user.force_logout",
    "room.checkin",
    "room.checkout",
    "room.checkin_time_update",
    "room.addon",
    "room.renew",
    "room.transfer",
    "room.cleaning.complete",
    "discount.apply",
    "booking.create",
    "booking.update",
    "booking.cancel",
    "booking.revert",
    "payment.add",
    "payment.refund",
    "payment.edit",
    "payment.delete",
    "payment.add_bill",
    "payment.edit_bill_service",
  ];

  // Common target collections — populated dropdown options
  const KNOWN_COLLECTIONS = [
    "users", "rooms", "bookings", "bills", "payments",
  ];

  // Detect which quick range matches the current state (so the chip stays
  // highlighted across re-renders).
  function _activeQuickRange() {
    const today = new Date(); today.setHours(0,0,0,0);
    const ymd = function (d) { return d.toISOString().split("T")[0]; };
    const t = ymd(today);
    if (!_logsState.from && !_logsState.to) return "all";
    if (_logsState.to !== t) return "";
    const from = new Date(_logsState.from + "T00:00:00");
    const days = Math.round((today - from) / 86400000);
    if (days === 0)  return "today";
    if (days === 6)  return "7d";
    if (days === 29) return "30d";
    return "";
  }

  function _filterControlsHTML() {
    _ensureDefaultRange();

    const userOptions = ['<option value="">All users</option>']
      .concat(_logsState.users.map(function (u) {
        const sel = u.userId === _logsState.userId ? " selected" : "";
        return '<option value="' + escapeHtml(u.userId) + '"' + sel + '>'
          + escapeHtml(u.name || u.userId) + '</option>';
      }))
      .join("");

    const actionOptions = ['<option value="">All actions</option>']
      .concat(KNOWN_ACTIONS.map(function (a) {
        const sel = a === _logsState.action ? " selected" : "";
        return '<option value="' + escapeHtml(a) + '"' + sel + '>' + escapeHtml(a) + '</option>';
      }))
      .join("");

    const collOptions = ['<option value="">Any target</option>']
      .concat(KNOWN_COLLECTIONS.map(function (c) {
        const sel = c === _logsState.targetCollection ? " selected" : "";
        return '<option value="' + escapeHtml(c) + '"' + sel + '>' + escapeHtml(c) + '</option>';
      }))
      .join("");

    const today = _todayStr();
    const activeCount = (
      (_logsState.userId ? 1 : 0) +
      (_logsState.action ? 1 : 0) +
      (_logsState.targetCollection ? 1 : 0) +
      (_logsState.targetId ? 1 : 0) +
      (_logsState.q ? 1 : 0) +
      ((_logsState.from !== today || _logsState.to !== today) ? 1 : 0) +
      (_logsState.includeArchive ? 1 : 0)
    );

    // ── Single-line filter bar ────────────────────────────────────────────
    // Order (left → right):
    //   Date range · Search · User · Action · Target type · Target ID · Archive · Reset
    // Default state on open: today · today (no chips needed).
    return (
      '<div class="cau-flt">' +
        '<div class="cau-flt-bar">' +
          '<div class="cau-flt-cell cau-flt-cell-range">' +
            '<svg class="cau-flt-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
              '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>' +
              '<line x1="16" y1="2" x2="16" y2="6"/>' +
              '<line x1="8" y1="2" x2="8" y2="6"/>' +
              '<line x1="3" y1="10" x2="21" y2="10"/></svg>' +
            '<input type="text" id="cau-log-range" placeholder="Date range" readonly ' +
              'data-from="' + escapeHtml(_logsState.from) + '" ' +
              'data-to="' + escapeHtml(_logsState.to) + '">' +
          '</div>' +
          '<div class="cau-flt-cell cau-flt-cell-search">' +
            '<svg class="cau-flt-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
              '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' +
            '<input type="text" id="cau-log-q" placeholder="Search…" ' +
              'value="' + escapeHtml(_logsState.q) + '">' +
          '</div>' +
          '<select id="cau-log-user" class="cau-flt-select" title="User">' + userOptions + '</select>' +
          '<select id="cau-log-action" class="cau-flt-select" title="Action">' + actionOptions + '</select>' +
          '<select id="cau-log-collection" class="cau-flt-select" title="Target type">' + collOptions + '</select>' +
          '<input type="text" id="cau-log-target-id" class="cau-flt-input" placeholder="Target ID" ' +
            'value="' + escapeHtml(_logsState.targetId) + '">' +
          '<label class="cau-flt-toggle" title="Include archived entries">' +
            '<input type="checkbox" id="cau-log-archive"' +
              (_logsState.includeArchive ? " checked" : "") + '>' +
            '<span>Archive</span>' +
          '</label>' +
          (activeCount
            ? '<button type="button" class="cau-flt-reset" id="cau-log-clear" title="Reset to today">' +
                'Reset <span class="cau-flt-count">' + activeCount + '</span></button>'
            : '') +
        '</div>' +
      '</div>'
    );
  }

  function _ymd(d) { return d.toISOString().split("T")[0]; }
  function _applyQuickRange(key) {
    const today = new Date(); today.setHours(0,0,0,0);
    const t = _ymd(today);
    if (key === "today") { _logsState.from = t; _logsState.to = t; }
    else if (key === "7d")  {
      const d = new Date(today); d.setDate(d.getDate() - 6);
      _logsState.from = _ymd(d); _logsState.to = t;
    } else if (key === "30d") {
      const d = new Date(today); d.setDate(d.getDate() - 29);
      _logsState.from = _ymd(d); _logsState.to = t;
    } else if (key === "all") {
      _logsState.from = ""; _logsState.to = "";
    }
  }

  function _readFilterControls(pane) {
    // Range comes from flatpickr-bound data attributes (set in onChange)
    const rangeEl = pane.querySelector("#cau-log-range");
    if (rangeEl) {
      _logsState.from = rangeEl.getAttribute("data-from") || "";
      _logsState.to = rangeEl.getAttribute("data-to") || "";
    }
    _logsState.userId = (pane.querySelector("#cau-log-user") || {}).value || "";
    _logsState.action = (pane.querySelector("#cau-log-action") || {}).value || "";
    _logsState.targetCollection = (pane.querySelector("#cau-log-collection") || {}).value || "";
    _logsState.targetId = (pane.querySelector("#cau-log-target-id") || {}).value.trim();
    _logsState.q = (pane.querySelector("#cau-log-q") || {}).value.trim();
    _logsState.includeArchive = !!(pane.querySelector("#cau-log-archive") || {}).checked;
  }

  // Initialise flatpickr on the audit-log range input. Idempotent — re-runs
  // safely after the filter UI is re-rendered.
  function _initLogRangePicker(pane) {
    const rangeEl = pane.querySelector("#cau-log-range");
    if (!rangeEl || !window.flatpickr) return;
    // Tear down a previous instance so re-renders don't leak listeners.
    if (rangeEl._flatpickr) {
      try { rangeEl._flatpickr.destroy(); } catch (_) { /* ignore */ }
    }
    const today = new Date(); today.setHours(0,0,0,0);
    const from = _logsState.from ? new Date(_logsState.from + "T00:00:00") : null;
    const to = _logsState.to ? new Date(_logsState.to + "T00:00:00") : null;
    flatpickr(rangeEl, {
      mode: "range",
      dateFormat: "Y-m-d",
      altInput: true,
      altFormat: "d M Y",
      maxDate: today,
      disableMobile: true,
      defaultDate: from && to ? [from, to] : [],
      onChange: function (selectedDates) {
        if (selectedDates.length === 2) {
          // Use LOCAL date components — toISOString shifts to UTC and
          // produces yesterday's date for IST users after 18:30 UTC.
          rangeEl.setAttribute("data-from", _localYmd(selectedDates[0]));
          rangeEl.setAttribute("data-to", _localYmd(selectedDates[1]));
          _readFilterControls(pane);
          _runLogsQuery(pane);
        } else if (selectedDates.length === 0) {
          rangeEl.setAttribute("data-from", "");
          rangeEl.setAttribute("data-to", "");
        }
      },
    });
  }

  function _refreshChipState(pane) {
    const active = _activeQuickRange();
    pane.querySelectorAll(".cau-fchip").forEach(function (b) {
      b.classList.toggle("cau-fchip-active", b.getAttribute("data-range") === active);
    });
  }

  function _buildLogsURL() {
    const params = new URLSearchParams();
    params.set("limit", String(_logsState.limit));
    if (_logsState.from) params.set("from", _logsState.from);
    if (_logsState.to) params.set("to", _logsState.to);
    if (_logsState.userId) params.set("userId", _logsState.userId);
    if (_logsState.action) params.set("action", _logsState.action);
    if (_logsState.targetCollection) params.set("targetCollection", _logsState.targetCollection);
    if (_logsState.targetId) params.set("targetId", _logsState.targetId);
    if (_logsState.q) params.set("q", _logsState.q);
    if (_logsState.includeArchive) params.set("include_archive", "1");
    return "/api/audit-logs?" + params.toString();
  }

  async function _ensureUsersListed() {
    if (_logsState.users.length) return;
    try {
      const res = await fetch("/api/users");
      const body = await res.json();
      if (body.success) _logsState.users = body.users || [];
    } catch (_) { /* leave dropdown with just "All users" */ }
  }

  async function loadLogsPane() {
    const pane = document.querySelector('[data-cau-pane="logs"]');
    if (!pane) return;
    await _ensureUsersListed();
    pane.innerHTML = _filterControlsHTML() +
      '<div id="cau-log-results"><div class="cau-loading">Loading logs…</div></div>';
    _wireLogFilterEvents(pane);
    _initLogRangePicker(pane);
    await _runLogsQuery(pane);
  }

  function _wireLogFilterEvents(pane) {
    const apply = pane.querySelector("#cau-log-apply");
    const clear = pane.querySelector("#cau-log-clear");

    function refreshFilterUI() {
      // Re-render only the filter container (preserves the results pane)
      const old = pane.querySelector(".cau-flt");
      if (!old) return loadLogsPane();
      const wrap = document.createElement("div");
      wrap.innerHTML = _filterControlsHTML();
      old.replaceWith(wrap.firstElementChild);
      _wireLogFilterEvents(pane);
      _initLogRangePicker(pane);
    }

    if (apply) apply.addEventListener("click", function () {
      _readFilterControls(pane);
      refreshFilterUI();
      _runLogsQuery(pane);
    });
    if (clear) clear.addEventListener("click", function () {
      const t = _todayStr();
      _logsState.from = t;
      _logsState.to = t;
      _logsState.userId = "";
      _logsState.action = "";
      _logsState.targetCollection = "";
      _logsState.targetId = "";
      _logsState.q = "";
      _logsState.includeArchive = false;
      refreshFilterUI();
      _runLogsQuery(pane);
    });

    // Auto-apply on every dropdown / input change — no Apply button.
    function applyNow() {
      _readFilterControls(pane);
      _runLogsQuery(pane);
      // Refresh just the reset-button visibility / count
      _refreshResetVisibility(pane);
    }

    ["#cau-log-user", "#cau-log-action", "#cau-log-collection", "#cau-log-archive"].forEach(function (sel) {
      const el = pane.querySelector(sel);
      if (el) el.addEventListener("change", applyNow);
    });

    // Search input + target ID: debounced live filtering
    function debouncedApply(el) {
      let _t = null;
      el.addEventListener("input", function () {
        clearTimeout(_t);
        _t = setTimeout(applyNow, 250);
      });
      el.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") { ev.preventDefault(); clearTimeout(_t); applyNow(); }
      });
    }
    const searchEl = pane.querySelector("#cau-log-q");
    if (searchEl) debouncedApply(searchEl);
    const targetIdEl = pane.querySelector("#cau-log-target-id");
    if (targetIdEl) debouncedApply(targetIdEl);
  }

  // Lightweight reset-button toggle without re-rendering the whole filter
  // bar (re-render would lose focus on the active input).
  function _refreshResetVisibility(pane) {
    const today = _todayStr();
    const activeCount = (
      (_logsState.userId ? 1 : 0) +
      (_logsState.action ? 1 : 0) +
      (_logsState.targetCollection ? 1 : 0) +
      (_logsState.targetId ? 1 : 0) +
      (_logsState.q ? 1 : 0) +
      ((_logsState.from !== today || _logsState.to !== today) ? 1 : 0) +
      (_logsState.includeArchive ? 1 : 0)
    );
    const bar = pane.querySelector(".cau-flt-bar");
    if (!bar) return;
    let resetBtn = bar.querySelector("#cau-log-clear");
    if (activeCount === 0) {
      if (resetBtn) resetBtn.remove();
      return;
    }
    if (!resetBtn) {
      resetBtn = document.createElement("button");
      resetBtn.type = "button";
      resetBtn.id = "cau-log-clear";
      resetBtn.className = "cau-flt-reset";
      resetBtn.title = "Reset to today";
      bar.appendChild(resetBtn);
      // Re-wire the click handler
      resetBtn.addEventListener("click", function () {
        const t = _todayStr();
        _logsState.from = t; _logsState.to = t;
        _logsState.userId = ""; _logsState.action = "";
        _logsState.targetCollection = ""; _logsState.targetId = "";
        _logsState.q = ""; _logsState.includeArchive = false;
        loadLogsPane(); // full refresh — picker, dropdowns, results
      });
    }
    resetBtn.innerHTML = 'Reset <span class="cau-flt-count">' + activeCount + '</span>';
  }

  async function _runLogsQuery(pane) {
    const target = pane.querySelector("#cau-log-results");
    if (target) target.innerHTML = '<div class="cau-loading">Loading…</div>';
    try {
      const res = await fetch(_buildLogsURL());
      if (!res.ok) throw new Error("HTTP " + res.status);
      const body = await res.json();
      if (!body.success) throw new Error(body.message || "Failed");
      _renderLogResults(target, body.entries || [], body.count);
    } catch (err) {
      if (target) target.innerHTML =
        '<div class="cau-error">Failed to load logs: ' + escapeHtml(err.message) + "</div>";
    }
  }

  function _renderLogResults(target, entries, count) {
    if (!entries.length) {
      target.innerHTML = '<div class="cau-empty">No audit entries match the current filters.</div>';
      return;
    }
    const rows = entries
      .map(function (e) {
        const ctx =
          (e.targetCollection ? escapeHtml(e.targetCollection) : "") +
          (e.targetId ? "/" + escapeHtml(e.targetId) : "");
        const archivedTag = e.archived
          ? ' <span class="cau-badge cau-badge-inactive">archived</span>'
          : "";
        return (
          '<tr class="cau-log-row">' +
          '<td>' + escapeHtml(e.timestamp || "") + archivedTag + '</td>' +
          '<td>' + escapeHtml(e.userId || "") + ' <small>(' + escapeHtml(e.userRole || "") + ')</small></td>' +
          '<td><span class="cau-log-action">' + escapeHtml(e.action || "") + '</span></td>' +
          '<td>' + ctx + '</td>' +
          "</tr>"
        );
      })
      .join("");
    target.innerHTML =
      '<div class="cau-log-count">' + (count != null ? count : entries.length) + ' result' +
        ((count == null ? entries.length : count) === 1 ? '' : 's') + '</div>' +
      '<table class="cau-table">' +
      '<thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>';
  }

  // ── Public API — used by the profile dropdown to open the console ──────
  window.CibaraAdmin = {
    open: function (which) {
      if (!window.CibaraAuth || !window.CibaraAuth.isAdmin || !window.CibaraAuth.isAdmin()) {
        return; // silently ignore for non-admins (menu item is hidden anyway)
      }
      openModal(which);
    },
  };

  // ── Boot ────────────────────────────────────────────────────────────────
  function start() {
    if (!window.CibaraAuth) { setTimeout(start, 60); return; }
    window.CibaraAuth.ready().then(function (user) {
      if (!user || user.role !== "admin") return; // build nothing for non-admins
      injectStyles();
      injectModal();
    });
  }

  start();
})();
