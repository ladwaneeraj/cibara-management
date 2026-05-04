/* ─────────────────────────────────────────────────────────────────────────
 * Frontend auth + role-based UI gating.
 *
 * Loads early in index.html (before script.js / register.js / etc.) so
 * downstream scripts can call window.CibaraAuth.userCan(...).
 *
 * Responsibilities
 * ────────────────
 *   1. Initialise Firebase Auth (using config served from /firebase-config.js).
 *   2. Maintain currentUser (userId, name, role) in memory.
 *   3. Attach the current ID token to every fetch() call to /api/* and
 *      same-origin Flask routes via a fetch wrapper.
 *   4. Redirect to /login if no user is signed in.
 *   5. Force logout after IDLE_TIMEOUT_MS of no interaction (24 hours).
 *   6. Apply role-based DOM hiding:
 *        - elements with data-perm="<key>" hidden when user lacks the perm
 *        - elements with data-roles="admin,manager" hidden otherwise
 *        - elements with data-hide-roles="housekeeping" hidden for those roles
 *   7. Expose userCan(perm) + currentUser() + logout().
 * ──────────────────────────────────────────────────────────────────── */

(function (global) {
  "use strict";

  // ── Constants ─────────────────────────────────────────────────────────
  const IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
  const IDLE_CHECK_INTERVAL_MS = 60 * 1000;    // re-check every minute
  const LAST_ACTIVITY_KEY = "cibara_last_activity";
  const LOGIN_PATH = "/login";

  // ── State ─────────────────────────────────────────────────────────────
  let _user = null;          // {userId, name, role}
  let _idToken = null;
  let _ready = false;
  let _readyResolvers = [];
  let _idleTimerId = null;
  let _firebaseAuth = null;

  // ── Public API container (populated below) ────────────────────────────
  const api = {};

  // ── Helpers ───────────────────────────────────────────────────────────
  function currentUser() {
    return _user ? Object.assign({}, _user) : null;
  }

  function userCan(permission) {
    if (!_user) return false;
    return global.CibaraPermissions.roleHasPermission(_user.role, permission);
  }

  function isAdmin() {
    return _user && _user.role === "admin";
  }

  function isManager() {
    return _user && _user.role === "manager";
  }

  function isHousekeeping() {
    return _user && _user.role === "housekeeping";
  }

  function ready() {
    if (_ready) return Promise.resolve(currentUser());
    return new Promise(function (resolve) {
      _readyResolvers.push(resolve);
    });
  }

  function _markReady() {
    _ready = true;
    const resolvers = _readyResolvers.slice();
    _readyResolvers = [];
    resolvers.forEach(function (r) {
      try { r(currentUser()); } catch (_) { /* ignore */ }
    });
  }

  function _redirectToLogin() {
    if (window.location.pathname === LOGIN_PATH) return;
    // Preserve where they tried to go so we can return after login (future)
    window.location.replace(LOGIN_PATH);
  }

  // ── Idle timer ────────────────────────────────────────────────────────
  function _recordActivity() {
    try {
      localStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now()));
    } catch (_) {
      /* localStorage may be disabled */
    }
  }

  function _checkIdle() {
    let last;
    try {
      last = parseInt(localStorage.getItem(LAST_ACTIVITY_KEY) || "0", 10);
    } catch (_) {
      last = 0;
    }
    if (!last) {
      _recordActivity();
      return;
    }
    if (Date.now() - last > IDLE_TIMEOUT_MS) {
      console.info("Cibara: idle timeout reached, forcing logout");
      logout("Your session expired after 24 hours of inactivity.");
    }
  }

  function _startIdleTimer() {
    _recordActivity();
    if (_idleTimerId) clearInterval(_idleTimerId);
    _idleTimerId = setInterval(_checkIdle, IDLE_CHECK_INTERVAL_MS);
    // Reset the timer on any meaningful interaction
    ["mousedown", "keydown", "touchstart", "wheel", "click"].forEach(function (ev) {
      window.addEventListener(ev, _recordActivity, { passive: true });
    });
    // Also reset on focus/visibility (the user came back to the tab)
    window.addEventListener("focus", _recordActivity);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") {
        _checkIdle();
        _recordActivity();
      }
    });
  }

  // ── Logout ────────────────────────────────────────────────────────────
  function logout(reason) {
    try {
      localStorage.removeItem(LAST_ACTIVITY_KEY);
      sessionStorage.removeItem("cibara_login_ts");
    } catch (_) { /* ignore */ }

    const finish = function () {
      if (reason) {
        try {
          sessionStorage.setItem("cibara_logout_msg", reason);
        } catch (_) { /* ignore */ }
      }
      _redirectToLogin();
    };

    if (_firebaseAuth && _firebaseAuth.currentUser) {
      _firebaseAuth.signOut().then(finish).catch(finish);
    } else {
      finish();
    }
  }

  // ── Fetch wrapper — attach Bearer token automatically ─────────────────
  function _shouldAttachToken(url) {
    // Attach to same-origin requests only (string or URL).
    try {
      const u = typeof url === "string" ? new URL(url, window.location.origin) : url;
      return u.origin === window.location.origin;
    } catch (_) {
      // Relative URLs are same-origin
      return true;
    }
  }

  function _wrapFetch() {
    const originalFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      init = init || {};
      const url = typeof input === "string" ? input : (input && input.url);
      if (_idToken && url && _shouldAttachToken(url)) {
        const headers = new Headers(
          (init.headers) || (input && input.headers) || {}
        );
        if (!headers.has("Authorization")) {
          headers.set("Authorization", "Bearer " + _idToken);
        }
        init.headers = headers;
      }
      return originalFetch(input, init).then(function (resp) {
        // Auto-handle 401s — token expired / revoked → bounce to login
        if (resp.status === 401 && _shouldAttachToken(url)) {
          logout("Your session ended. Please sign in again.");
        }
        return resp;
      });
    };
  }

  // ── Role-based DOM gating ─────────────────────────────────────────────
  // data-perm="payment.edit"      → hide if user lacks that permission
  // data-roles="admin,manager"     → hide if user's role NOT in list
  // data-hide-roles="housekeeping" → hide if user's role IN list
  function applyRoleGating(root) {
    root = root || document;
    if (!_user) return;

    const role = _user.role;

    root.querySelectorAll("[data-perm]").forEach(function (el) {
      const perm = el.getAttribute("data-perm");
      if (!userCan(perm)) {
        el.setAttribute("hidden", "");
        el.style.display = "none";
      }
    });

    root.querySelectorAll("[data-roles]").forEach(function (el) {
      const allowed = (el.getAttribute("data-roles") || "")
        .split(",")
        .map(function (s) { return s.trim(); })
        .filter(Boolean);
      if (allowed.length && allowed.indexOf(role) === -1) {
        el.setAttribute("hidden", "");
        el.style.display = "none";
      }
    });

    root.querySelectorAll("[data-hide-roles]").forEach(function (el) {
      const blocked = (el.getAttribute("data-hide-roles") || "")
        .split(",")
        .map(function (s) { return s.trim(); })
        .filter(Boolean);
      if (blocked.indexOf(role) !== -1) {
        el.setAttribute("hidden", "");
        el.style.display = "none";
      }
    });
  }

  // Watch for dynamically added DOM nodes and gate them too.
  function _startMutationGating() {
    const obs = new MutationObserver(function (records) {
      records.forEach(function (r) {
        r.addedNodes.forEach(function (n) {
          if (n.nodeType === 1) {
            applyRoleGating(n);
          }
        });
      });
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // ── Profile dropdown wiring ────────────────────────────────────────────
  // The dropdown markup lives in templates/index.html. Here we just:
  //   1. Populate the avatar + name + role.
  //   2. Toggle the menu on profile-button click.
  //   3. Wire each menu item to its action.
  //   4. Close the menu on outside click / Escape.
  function _wireProfileMenu() {
    const btn = document.getElementById("profile-btn");
    const menu = document.getElementById("profile-menu");
    if (!btn || !menu) return;

    const initial = (_user.name || _user.userId || "?").charAt(0).toUpperCase();
    const nameStr = _user.name || _user.userId;

    const avatarTop = document.getElementById("profile-avatar");
    const avatarMenu = document.getElementById("profile-menu-avatar");
    const nameEl = document.getElementById("profile-menu-name");
    const roleEl = document.getElementById("profile-menu-role");
    if (avatarTop) avatarTop.textContent = initial;
    if (avatarMenu) avatarMenu.textContent = initial;
    if (nameEl) nameEl.textContent = nameStr;
    if (roleEl) roleEl.textContent = _user.role;

    function openMenu() {
      menu.hidden = false;
      btn.setAttribute("aria-expanded", "true");
    }
    function closeMenu() {
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
    }
    function toggleMenu(e) {
      e.stopPropagation();
      if (menu.hidden) openMenu(); else closeMenu();
    }

    btn.addEventListener("click", toggleMenu);

    // Close on outside click
    document.addEventListener("click", function (ev) {
      if (menu.hidden) return;
      if (!menu.contains(ev.target) && !btn.contains(ev.target)) closeMenu();
    });

    // Close on Escape
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && !menu.hidden) {
        closeMenu();
        btn.focus();
      }
    });

    // Wire menu items
    const changePwItem = document.getElementById("profile-menu-change-password");
    const settingsItem = document.getElementById("profile-menu-settings");
    const usersItem = document.getElementById("profile-menu-users");
    const logsItem = document.getElementById("profile-menu-logs");
    const signoutItem = document.getElementById("profile-menu-signout");

    if (changePwItem) {
      changePwItem.addEventListener("click", function () {
        closeMenu();
        _openChangePasswordModal();
      });
    }

    if (settingsItem) {
      settingsItem.addEventListener("click", function () {
        closeMenu();
        if (typeof window.openSettingsModal === "function") {
          window.openSettingsModal();
        }
      });
    }

    if (usersItem) {
      usersItem.addEventListener("click", function () {
        closeMenu();
        if (window.CibaraAdmin && typeof window.CibaraAdmin.open === "function") {
          window.CibaraAdmin.open("users");
        }
      });
    }

    if (logsItem) {
      logsItem.addEventListener("click", function () {
        closeMenu();
        if (window.CibaraAdmin && typeof window.CibaraAdmin.open === "function") {
          window.CibaraAdmin.open("logs");
        }
      });
    }

    if (signoutItem) {
      signoutItem.addEventListener("click", function () {
        closeMenu();
        logout();
      });
    }
  }

  // Legacy alias — kept so the bootstrap call below doesn't change shape.
  function _injectIdentityChip() {
    _wireProfileMenu();
  }
  // Dead code from the old bottom-left chip — wrapped so it never runs.
  function _DEAD_oldChip() {
    if (document.getElementById("cibara-identity-chip")) return;

    const chip = document.createElement("div");
    chip.id = "cibara-identity-chip";
    chip.setAttribute("style", [
      "position:fixed",
      "left:12px",
      "bottom:12px",
      "z-index:99996",
      "display:flex",
      "align-items:center",
      "gap:0",
      "padding:4px",
      "background:rgba(17,23,58,0.92)",
      "color:#fff",
      "font:600 12px/1 'Inter',system-ui,sans-serif",
      "border:1px solid rgba(255,255,255,0.12)",
      "border-radius:999px",
      "box-shadow:0 4px 14px -4px rgba(0,0,0,0.4)",
      "backdrop-filter:blur(8px)",
      "transition:gap .15s, padding .15s",
      "max-width:60vw",
    ].join(";"));

    const initial = (_user.name || _user.userId || "?").charAt(0).toUpperCase();
    chip.innerHTML =
      '<button id="cibara-id-toggle" type="button" aria-label="Account" ' +
      'style="display:grid;place-items:center;width:30px;height:30px;border:0;border-radius:50%;cursor:pointer;' +
      'background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%);color:#fff;font-size:12px;font-weight:700;">' +
      initial +
      "</button>" +
      '<div id="cibara-id-details" style="display:none;align-items:center;gap:8px;padding:0 8px 0 8px;white-space:nowrap;overflow:hidden;">' +
      '<div style="display:flex;flex-direction:column;line-height:1.2;">' +
      '<span>' + escapeHtml(_user.name || _user.userId) + '</span>' +
      '<span style="font-weight:500;font-size:10px;opacity:.7;text-transform:uppercase;letter-spacing:.04em;">' +
      escapeHtml(_user.role) +
      '</span>' +
      '</div>' +
      '<button id="cibara-logout-btn" type="button" title="Sign out" ' +
      'style="background:transparent;border:0;color:#cbd5e1;cursor:pointer;padding:4px 6px;border-radius:6px;display:grid;place-items:center;">' +
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>' +
      '</svg></button>' +
      '</div>';

    document.body.appendChild(chip);

    const details = document.getElementById("cibara-id-details");
    const toggle = document.getElementById("cibara-id-toggle");

    function openChip() {
      details.style.display = "flex";
      chip.style.gap = "4px";
    }
    function closeChip() {
      details.style.display = "none";
      chip.style.gap = "0";
    }

    toggle.addEventListener("click", function (e) {
      e.stopPropagation();
      if (details.style.display === "none") openChip(); else closeChip();
    });

    // Click outside → collapse
    document.addEventListener("click", function (ev) {
      if (!chip.contains(ev.target)) closeChip();
    });

    document.getElementById("cibara-logout-btn").addEventListener("click", function (e) {
      e.stopPropagation();
      logout();
    });
  }

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ── Change password (self-service) ────────────────────────────────────
  // Available to every signed-in role. Uses Firebase Auth client SDK to
  // reauthenticate (verifies the current password) and update. Then audits
  // the change via the backend, signs out, and bounces to /login.
  function _openChangePasswordModal() {
    if (!_firebaseAuth || !_firebaseAuth.currentUser) {
      logout();
      return;
    }

    const existing = document.getElementById("cibara-pw-modal");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "cibara-pw-modal";
    overlay.setAttribute("style", [
      "position:fixed", "inset:0", "z-index:99999",
      "display:grid", "place-items:center",
      "background:rgba(8,12,30,0.55)",
      "backdrop-filter:blur(4px)",
      "padding:16px",
      "font-family:'Inter',system-ui,sans-serif",
    ].join(";"));

    overlay.innerHTML =
      '<div role="dialog" aria-modal="true" aria-labelledby="cpw-title" style="' +
        'width:100%;max-width:380px;background:#fff;color:#1e293b;' +
        'border-radius:12px;box-shadow:0 25px 50px -12px rgba(0,0,0,0.4);' +
        'padding:20px;animation:cpw-in 0.15s ease-out;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">' +
          '<h3 id="cpw-title" style="margin:0;font-size:1.05rem;font-weight:700;letter-spacing:-.01em;">Change password</h3>' +
          '<button type="button" id="cpw-close" aria-label="Close" style="background:transparent;border:0;cursor:pointer;color:#64748b;padding:4px;border-radius:6px;font-size:18px;line-height:1;">&times;</button>' +
        '</div>' +
        '<form id="cpw-form" autocomplete="off" novalidate>' +
          '<label style="display:block;margin-bottom:10px;">' +
            '<span style="display:block;font-size:.7rem;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px;">Current password</span>' +
            '<input id="cpw-cur" type="password" required minlength="6" autocomplete="current-password" style="width:100%;padding:8px 10px;border:1px solid #e2e8f0;border-radius:8px;font:400 .9rem inherit;outline:none;">' +
          '</label>' +
          '<label style="display:block;margin-bottom:10px;">' +
            '<span style="display:block;font-size:.7rem;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px;">New password (min 6)</span>' +
            '<input id="cpw-new" type="password" required minlength="6" autocomplete="new-password" style="width:100%;padding:8px 10px;border:1px solid #e2e8f0;border-radius:8px;font:400 .9rem inherit;outline:none;">' +
          '</label>' +
          '<label style="display:block;margin-bottom:10px;">' +
            '<span style="display:block;font-size:.7rem;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px;">Confirm new password</span>' +
            '<input id="cpw-new2" type="password" required minlength="6" autocomplete="new-password" style="width:100%;padding:8px 10px;border:1px solid #e2e8f0;border-radius:8px;font:400 .9rem inherit;outline:none;">' +
          '</label>' +
          '<div id="cpw-err" hidden style="margin:8px 0 12px;padding:8px 10px;font-size:.82rem;color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;"></div>' +
          '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px;">' +
            '<button type="button" id="cpw-cancel" style="padding:8px 14px;border:1px solid #e2e8f0;background:#fff;border-radius:8px;font:600 .85rem inherit;cursor:pointer;color:#1e293b;">Cancel</button>' +
            '<button type="submit" id="cpw-submit" style="padding:8px 14px;border:0;background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%);color:#fff;border-radius:8px;font:600 .85rem inherit;cursor:pointer;">Update password</button>' +
          '</div>' +
        '</form>' +
      '</div>';

    document.body.appendChild(overlay);

    function close() { overlay.remove(); }
    overlay.addEventListener("click", function (ev) {
      if (ev.target === overlay) close();
    });
    document.getElementById("cpw-close").addEventListener("click", close);
    document.getElementById("cpw-cancel").addEventListener("click", close);

    const errEl = document.getElementById("cpw-err");
    const submitBtn = document.getElementById("cpw-submit");
    const curEl = document.getElementById("cpw-cur");
    const newEl = document.getElementById("cpw-new");
    const new2El = document.getElementById("cpw-new2");
    setTimeout(function () { curEl.focus(); }, 80);

    function showErr(msg) {
      errEl.textContent = msg;
      errEl.hidden = false;
    }

    document.getElementById("cpw-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      errEl.hidden = true;
      const cur = curEl.value;
      const next = newEl.value;
      const next2 = new2El.value;
      if (next.length < 6) return showErr("New password must be at least 6 characters.");
      if (next !== next2) return showErr("New passwords do not match.");
      if (next === cur) return showErr("New password must differ from the current one.");

      submitBtn.disabled = true;
      submitBtn.textContent = "Updating…";

      const fbUser = _firebaseAuth.currentUser;
      const provider = window.firebase && window.firebase.auth
        && window.firebase.auth.EmailAuthProvider;
      if (!fbUser || !provider) {
        showErr("Auth not available. Please sign in again.");
        submitBtn.disabled = false; submitBtn.textContent = "Update password";
        return;
      }
      const cred = provider.credential(fbUser.email, cur);

      fbUser.reauthenticateWithCredential(cred)
        .then(function () {
          return fbUser.updatePassword(next);
        })
        .then(function () {
          // Best-effort audit; don't block on failure
          try {
            fetch("/api/auth/log-password-change", { method: "POST" })
              .catch(function () { /* ignore */ });
          } catch (_) { /* ignore */ }
          submitBtn.textContent = "Done — signing out…";
          // Force re-login with the new password
          setTimeout(function () {
            close();
            logout("Password changed. Please sign in with your new password.");
          }, 600);
        })
        .catch(function (err) {
          submitBtn.disabled = false;
          submitBtn.textContent = "Update password";
          const code = (err && err.code) || "";
          if (code === "auth/wrong-password" || code === "auth/invalid-credential") {
            showErr("Current password is incorrect.");
            curEl.focus(); curEl.select();
          } else if (code === "auth/weak-password") {
            showErr("New password is too weak.");
          } else if (code === "auth/requires-recent-login") {
            showErr("Please sign out and sign back in, then try again.");
          } else {
            showErr("Could not update password. " + ((err && err.message) || ""));
          }
        });
    });

    // Inject one-time keyframes for the open animation
    if (!document.getElementById("cpw-anim-style")) {
      const s = document.createElement("style");
      s.id = "cpw-anim-style";
      s.textContent = "@keyframes cpw-in{from{opacity:0;transform:translateY(-6px);}to{opacity:1;transform:translateY(0);}}";
      document.head.appendChild(s);
    }
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────
  function _bootstrap() {
    // On the login page itself we don't run any of this.
    if (window.location.pathname === LOGIN_PATH) {
      _markReady();
      return;
    }

    if (!window.FIREBASE_CONFIG || !window.FIREBASE_CONFIG.apiKey) {
      console.error("Cibara: FIREBASE_CONFIG missing — cannot authenticate");
      _redirectToLogin();
      return;
    }

    if (!firebase.apps.length) {
      firebase.initializeApp(window.FIREBASE_CONFIG);
    }
    _firebaseAuth = firebase.auth();

    _wrapFetch();

    _firebaseAuth.onAuthStateChanged(function (fbUser) {
      if (!fbUser) {
        _user = null;
        _idToken = null;
        _redirectToLogin();
        return;
      }

      // Pull token + claims so we know the role
      fbUser
        .getIdTokenResult(true) // forceRefresh — picks up newly set claims
        .then(function (tokenResult) {
          _idToken = tokenResult.token;
          const claims = tokenResult.claims || {};
          _user = {
            userId: claims.userId || (fbUser.email || "").split("@")[0] || fbUser.uid,
            name: claims.name || fbUser.displayName || claims.userId || fbUser.uid,
            role: claims.role || null,
          };
          if (!_user.role) {
            console.warn("Cibara: user has no role claim — refusing access");
            logout("Your account is not configured. Contact an administrator.");
            return;
          }

          // Schedule a token refresh ~5 min before expiry so calls don't 401
          const expMs = (claims.exp || 0) * 1000;
          if (expMs > 0) {
            const refreshIn = Math.max(60_000, expMs - Date.now() - 5 * 60_000);
            setTimeout(function () {
              fbUser.getIdToken(true).then(function (t) { _idToken = t; })
                .catch(function () { /* will retry next API call */ });
            }, refreshIn);
          }

          _startIdleTimer();
          _markReady();

          // Apply gating once DOM is ready
          if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", function () {
              applyRoleGating();
              _startMutationGating();
              _injectIdentityChip();
              document.body.setAttribute("data-role", _user.role);
            });
          } else {
            applyRoleGating();
            _startMutationGating();
            _injectIdentityChip();
            document.body.setAttribute("data-role", _user.role);
          }

          // Verify the user against our backend (lastLoginAt + active check)
          fetch("/api/auth/me").then(function (r) {
            if (r.status === 403) {
              logout("Your account has been disabled.");
            }
          }).catch(function () { /* non-fatal */ });
        })
        .catch(function (e) {
          console.error("Cibara: failed to load token claims", e);
          logout();
        });
    });
  }

  // ── Wire up ───────────────────────────────────────────────────────────
  api.userCan = userCan;
  api.currentUser = currentUser;
  api.isAdmin = isAdmin;
  api.isManager = isManager;
  api.isHousekeeping = isHousekeeping;
  api.logout = logout;
  api.ready = ready;
  api.applyRoleGating = applyRoleGating;
  // Expose token getter for code that needs to construct its own requests
  // (e.g. WebSockets, EventSource). Returns the most recent token.
  api.getIdToken = function () { return _idToken; };

  global.CibaraAuth = api;

  _bootstrap();
})(window);
