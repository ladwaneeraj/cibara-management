/* ─────────────────────────────────────────────────────────────────────────
 * Frontend auth + role-based UI gating.
 *
 * Loads early in index.html (before script.js / register.js / etc.) so
 * downstream scripts can call window.CibaraAuth.userCan(...).
 *
 * Responsibilities
 * ────────────────
 *   1. Restore the session from the server: POST /api/v2/auth/refresh uses the
 *      HttpOnly refresh cookie set at sign-in and returns a 15-minute access
 *      token (kept in memory only) plus the user's identity and role.
 *   2. Sign the Firebase SDK in with the custom token from that response, so
 *      google_sync.js listeners run under firestore.rules exactly as before.
 *   3. Attach the access token to every same-origin fetch() via a wrapper;
 *      on 401 refresh once (single flight) and retry with the same X-Op-Id.
 *   4. Redirect to /login when the server says the session is over. A server
 *      that cannot be reached is NOT a sign-out: the page keeps retrying.
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
  let _idToken = null;       // our access JWT (in memory only)
  let _authUid = null;       // Firebase uid of the signed-in user
  let _refreshTimer = null;
  let _refreshInflight = null;
  let _rawFetch = window.fetch.bind(window); // unwrapped, for /api/v2/auth calls
  const AUTH_API = "/api/v2/auth";
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
    // Some UI (e.g. the room grid's role-gated "Ready" button) renders
    // conditionally on userCan(...). Those renderers may have run before
    // the token claims resolved and produced an incomplete view. Fire a
    // one-shot signal so listeners can re-render now that the role is
    // known. This is what previously required a manual page refresh.
    try {
      window.dispatchEvent(new CustomEvent("cibaraAuthReady", {
        detail: currentUser()
      }));
    } catch (_) { /* older runtimes without CustomEvent */ }
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
  let _loggingOut = false;
  function logout(reason, fromOtherTab) {
    if (_loggingOut) return;
    _loggingOut = true;
    if (!fromOtherTab) _broadcast("logout");
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

    if (_refreshTimer) clearTimeout(_refreshTimer);
    _idToken = null;
    // End the server session (clears the refresh cookie and retires its
    // token family), then the Firebase session used by the live listeners.
    if (fromOtherTab) {
      // The tab that signed out already ended the server + Firebase session.
      finish();
      return;
    }
    const serverLogout = _rawFetch(AUTH_API + "/logout", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: "{}",
    }).catch(function () { /* already gone / offline */ });
    serverLogout.then(function () {
      if (_firebaseAuth && _firebaseAuth.currentUser) {
        return _firebaseAuth.signOut().catch(function () {});
      }
    }).then(finish, finish);
  }

  // ── Session (JWT) ─────────────────────────────────────────────────────
  // Result of a refresh: "ok" | "denied" (server ended the session) |
  // "unavailable" (server/Firebase unreachable — keep the session, retry).
  // ── Cross-tab sync ──────────────────────────────────────────────────
  // All tabs share one refresh cookie. Signing out in one tab, or a different
  // user signing in on the same PC, must not leave another tab acting as the
  // previous user.
  let _channel = null;
  try { _channel = new BroadcastChannel("cibara-auth"); } catch (_) { _channel = null; }
  function _broadcast(type) {
    const msg = { type: type, at: Date.now() };
    try { if (_channel) _channel.postMessage(msg); } catch (_) { /* ignore */ }
    try { localStorage.setItem("cibara_auth_event", JSON.stringify(msg)); } catch (_) { /* ignore */ }
  }
  function _onAuthEvent(msg) {
    if (!msg || window.location.pathname === LOGIN_PATH) return;
    if (msg.type === "logout" && _user) logout(null, true);
    // Someone signed in on another tab (maybe a different user): pick up the
    // new session now; _applySession reloads this page if the user changed.
    if (msg.type === "login" && _user) _refreshSession(false);
  }
  if (_channel) _channel.onmessage = function (ev) { _onAuthEvent(ev.data); };
  window.addEventListener("storage", function (ev) {
    if (ev.key !== "cibara_auth_event" || !ev.newValue) return;
    let msg = null;
    try { msg = JSON.parse(ev.newValue); } catch (_) { return; }
    // auth.js also posts on the channel; login.js (the sign-in page) only
    // writes storage. Avoid handling the same logout twice.
    if (_channel && msg && msg.type === "logout") return;
    _onAuthEvent(msg);
  });

  function _applySession(s) {
    const u = s.user || {};
    if (_user && u.userId && u.userId !== _user.userId) {
      // Another tab signed in as someone else: this page's role gating,
      // identity chip and listeners belong to the previous user. Start over.
      _idToken = null;
      window.location.reload();
      return;
    }
    _idToken = s.access_token;
    _authUid = u.authUid || _authUid;
    _user = { userId: u.userId, name: u.name || u.userId, role: u.role || null };
    if (_refreshTimer) clearTimeout(_refreshTimer);
    const inSec = Math.max(30, (s.expires_in || 900) - 60);
    _refreshTimer = setTimeout(function again() {
      _refreshSession(false).then(function (r) {
        if (r === "unavailable") _refreshTimer = setTimeout(again, 30000);
        else if (r === "denied") logout("Your session ended. Please sign in again.");
      });
    }, inSec * 1000);
  }

  function _refreshSession(withFirebase) {
    if (_refreshInflight) return _refreshInflight;
    _refreshInflight = _rawFetch(AUTH_API + "/refresh" + (withFirebase ? "?firebase=true" : ""), {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json", "Accept": "application/json" }, body: "{}",
    }).then(function (r) {
      if (r.status === 401 || r.status === 403) {
        return r.json().catch(function () { return {}; }).then(function (b) {
          _deniedMessage = (b && b.message) || null;
          return "denied";
        });
      }
      if (!r.ok) return "unavailable";
      return r.json().then(function (s) {
        _applySession(s);
        _lastSession = s;
        return "ok";
      });
    }).catch(function () {
      return "unavailable";
    }).then(function (res) {
      _refreshInflight = null;
      return res;
    });
    return _refreshInflight;
  }
  let _deniedMessage = null;
  let _lastSession = null;
  // Whether the Firebase SDK sign-in (for live Firestore listeners) succeeded.
  // False when the custom token is rejected or Firebase is unreachable, so the
  // app can skip attaching listeners that would only be refused — see
  // google_sync.js. Set once, before ready() resolves.
  let _realtimeOk = false;

  // Sign the Firebase SDK in as the same user (custom token), so Firestore
  // listeners are authorised by firestore.rules. Resolves either way: a
  // failure only means live updates fall back to manual refresh.
  function _signInFirebase(customToken) {
    if (!_firebaseAuth) return Promise.resolve(false);
    return new Promise(function (resolve) {
      const off = _firebaseAuth.onAuthStateChanged(function (fbUser) {
        off();
        resolve(fbUser);
      });
    }).then(function (fbUser) {
      if (!customToken) return !!(fbUser && fbUser.uid === _authUid);
      const signOutFirst = fbUser ? _firebaseAuth.signOut() : Promise.resolve();
      return signOutFirst
        .then(function () { return _firebaseAuth.signInWithCustomToken(customToken); })
        .then(function () { return true; });
    }).catch(function (e) {
      console.warn("Cibara: realtime sign-in failed — live updates unavailable", e);
      return false;
    });
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

  // One-shot refresh after a 401. Resolves "ok" | "denied" | "unavailable".
  function _refreshToken() {
    return _refreshSession(false);
  }

  function _wrapFetch() {
    const originalFetch = _rawFetch;

    // Build the request with our current token attached.
    function _attach(init, url) {
      init = init || {};
      if (_idToken && url && _shouldAttachToken(url)) {
        const headers = new Headers(init.headers || {});
        headers.set("Authorization", "Bearer " + _idToken);
        init.headers = headers;
      }
      return init;
    }

    window.fetch = function (input, init) {
      let url = typeof input === "string" ? input : (input && input.url);
      const sameOrigin = _shouldAttachToken(url);

      // Manual-refresh cache-bypass: the header refresh button sets
      // window.__forceFresh for the duration of the refresh. For same-origin
      // GET/HEAD requests we append a _t=<ts> cache-buster and set no-store,
      // so neither the browser HTTP cache nor the server-side /get_data
      // payload cache can serve stale data. POST loaders (Bills/Register/
      // Bookings) are never browser-cached, so they are unaffected.
      if (sameOrigin && window.__forceFresh) {
        const _m = ((init && init.method) || "GET").toUpperCase();
        if (_m === "GET" || _m === "HEAD") {
          init = Object.assign({}, init || {});
          init.cache = "no-store";
          if (typeof input === "string") {
            input += (input.indexOf("?") === -1 ? "?" : "&") + "_t=" + Date.now();
            url = input;
          }
        }
      }

      // Non-same-origin or no token: just pass through.
      if (!sameOrigin) return originalFetch(input, init);

      const _sendInit = Object.assign({}, init || {});
      return _guardedSend(input, _sendInit, url).then(function (resp) {
        return _maybeStepUp(resp, input, _sendInit, url);
      });
    };

    // Step-up re-auth: a money-leaving action blocked with 428 → prompt the
    // admin for their password (step-up.js), then replay the SAME request with
    // the returned single-use token. The same init is reused so the X-Op-Id is
    // preserved; the blocked request never executed, so this is its first real
    // attempt. One replay only — a second 428 is surfaced to the caller.
    function _maybeStepUp(resp, input, init, url) {
      if (!resp || resp.status !== 428) return resp;
      if (!window.CibaraStepUp || typeof window.CibaraStepUp.authorize !== "function") return resp;
      return resp.clone().json().then(function (body) {
        if (!body || body.code !== "step_up_required") return resp;
        return window.CibaraStepUp.authorize(body.action, body.amount).then(function (token) {
          if (!token) return resp; // cancelled → surface the block
          const headers = new Headers(init.headers || {});
          headers.set("X-Step-Up-Token", token);
          init.headers = headers;
          return _guardedSend(input, init, url);
        });
      }).catch(function () { return resp; });
    }

    // Send with the token attached; on 401 refresh ONCE and retry.
    // Common causes of the 401:
    //   - cached token expired between sign-in and now (Firebase
    //     rolled it 1h ago and our scheduled refresh hadn't run yet)
    //   - backend revocation-check RPC blipped (transient)
    //   - admin force-logged-out the user (refresh will fail → bounce)
    function _sendWithAuth(input, init, url) {
      const attachedInit = _attach(Object.assign({}, init), url);

      return originalFetch(input, attachedInit).then(function (resp) {
        if (resp.status !== 401) return resp;

        return _refreshToken().then(function (result) {
          if (result === "unavailable") {
            // Server unreachable: keep the session, report a transient error.
            return new Response(JSON.stringify({
              success: false,
              message: "Cannot reach the server right now. Please try again.",
            }), { status: 503, headers: { "Content-Type": "application/json" } });
          }
          if (result !== "ok") {
            // The server ended the session (disabled / force-logout / expired).
            console.warn("Cibara: session refresh denied after 401, signing out");
            logout(_deniedMessage && _deniedMessage !== "Not signed in"
              ? _deniedMessage : (_user ? "Your session ended. Please sign in again." : null));
            return resp;
          }
          // Brief delay so the new token's IAT is comfortably after any
          // server-side revocation-cache timestamp (avoids a spurious
          // second 401 right after a force-logout window).
          return new Promise(function (resolve) { setTimeout(resolve, 250); })
            .then(function () {
              // Same init object → same X-Op-Id header, so the server
              // treats this retry as the SAME operation, never a second one.
              const retryInit = _attach(Object.assign({}, init), url);
              return originalFetch(input, retryInit).then(function (retryResp) {
                if (retryResp.status === 401) {
                  console.warn("Cibara: still 401 after refresh+retry, signing out");
                  logout("Your session ended. Please sign in again.");
                }
                return retryResp;
              });
            });
        });
      });
    }

    // ── Duplicate-write guard (client half) ───────────────────────────────
    // Three things, all generic, so every money button in the app is
    // covered without touching its handler:
    //   1. Every mutating request carries a fresh X-Op-Id. The server keeps
    //      the first answer, so a retry of the SAME request (the 401 path
    //      above, a flaky network) is answered without doing the work twice.
    //   2. An identical write already in flight (same method+url+body) is
    //      coalesced: the second caller gets a copy of the first response.
    //      This is what a double-click on a button that awaits fetch looks
    //      like from here.
    //   3. If the server still answers 409 duplicate_suspected (same intent
    //      seconds apart, e.g. via the optimistic queue or a second device),
    //      a sub-2s repeat is dropped as a double-click; anything older asks
    //      the operator and re-sends with X-Force-Duplicate on "yes".
    const _inFlight = new Map(); // key → Promise<Response> (unconsumed copy)
    const DOUBLE_CLICK_MS = 2000;

    function _mutationKey(init, url) {
      const m = ((init && init.method) || "GET").toUpperCase();
      if (m === "GET" || m === "HEAD") return null;
      if (typeof init.body !== "string") return null; // uploads etc.
      return m + " " + url + " " + init.body;
    }

    function _newOpId() {
      if (window.crypto && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
      }
      return "op_" + Date.now() + "_" + Math.random().toString(16).slice(2);
    }

    function _jsonResponse(obj) {
      return new Response(JSON.stringify(obj), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }

    function _guardedSend(input, init, url) {
      const key = _mutationKey(init, url);
      if (!key) return _sendWithAuth(input, init, url);

      const pending = _inFlight.get(key);
      if (pending) {
        console.warn("Cibara: identical write already in flight, coalescing:", url);
        return pending.then(function (r) { return r.clone(); });
      }

      const headers = new Headers(init.headers || {});
      if (!headers.has("X-Op-Id")) headers.set("X-Op-Id", _newOpId());
      init.headers = headers;

      const p = _sendWithAuth(input, init, url).then(function (resp) {
        return _resolveDuplicate(resp, input, init, url);
      });
      // Store an unconsumed copy; each coalesced caller clones from it.
      const stored = p.then(function (r) { return r.clone(); });
      _inFlight.set(key, stored);
      const clear = function () { _inFlight.delete(key); };
      p.then(clear, clear);
      return p;
    }

    function _resolveDuplicate(resp, input, init, url) {
      if (resp.status !== 409) return resp;
      return resp.clone().json().then(function (data) {
        if (!data || !data.duplicate_suspected) return resp;
        const ago = Number(data.seconds_ago) || 0;
        if (ago * 1000 < DOUBLE_CLICK_MS) {
          console.warn("Cibara: double-click dropped for", url);
          return _jsonResponse({
            success: false, duplicate: true,
            message: "Duplicate click ignored — this was already recorded.",
          });
        }
        return _confirmDuplicate(ago).then(function (yes) {
          if (!yes) {
            return _jsonResponse({
              success: false, duplicate: true,
              message: "Skipped — not recorded a second time.",
            });
          }
          const forced = Object.assign({}, init);
          const h = new Headers(init.headers || {});
          h.set("X-Force-Duplicate", "1");
          h.set("X-Op-Id", _newOpId());
          forced.headers = h;
          return _sendWithAuth(input, forced, url);
        });
      }, function () { return resp; });
    }

    // Small self-contained dialog (auth.js loads on every page, so it
    // cannot depend on index-page CSS). Resolves false on every dismissal.
    function _confirmDuplicate(secondsAgo) {
      return new Promise(function (resolve) {
        const wrap = document.createElement("div");
        wrap.setAttribute("role", "dialog");
        wrap.setAttribute("aria-modal", "true");
        wrap.style.cssText =
          "position:fixed;inset:0;z-index:100000;display:flex;align-items:center;" +
          "justify-content:center;background:rgba(15,23,42,.55);padding:16px;";
        wrap.innerHTML =
          '<div style="background:#fff;border-radius:14px;max-width:360px;width:100%;' +
          'padding:20px 20px 16px;font-family:inherit;box-shadow:0 20px 50px rgba(0,0,0,.25)">' +
          '<div style="font-weight:700;font-size:1.05rem;color:#1a202c;margin-bottom:6px">' +
          "Record this again?</div>" +
          '<div style="font-size:.9rem;color:#4a5568;line-height:1.45">' +
          "The same entry was already saved " + Math.round(secondsAgo) +
          " seconds ago. Save it a second time?</div>" +
          '<div style="display:flex;gap:8px;margin-top:16px">' +
          '<button type="button" data-act="no" style="flex:1;padding:10px;border:1px solid #cbd5e0;' +
          'background:#fff;border-radius:10px;font-weight:600;cursor:pointer">No, keep one</button>' +
          '<button type="button" data-act="yes" style="flex:1;padding:10px;border:0;' +
          'background:#e63946;color:#fff;border-radius:10px;font-weight:600;cursor:pointer">' +
          "Yes, record again</button></div></div>";
        function done(v) { wrap.remove(); document.removeEventListener("keydown", onKey); resolve(v); }
        function onKey(e) { if (e.key === "Escape") done(false); }
        wrap.addEventListener("click", function (e) {
          const act = e.target && e.target.getAttribute && e.target.getAttribute("data-act");
          if (act) done(act === "yes");
          else if (e.target === wrap) done(false);
        });
        document.addEventListener("keydown", onKey);
        document.body.appendChild(wrap);
      });
    }
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
  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ── Change password (self-service) ────────────────────────────────────
  // Available to every signed-in role. POST /api/v2/auth/password verifies
  // the current password, updates it in Firebase Auth, ends every session of
  // this user and writes the audit entry. Then we sign out and bounce to /login.
  function _openChangePasswordModal() {
    if (!_user) {
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

      fetch(AUTH_API + "/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_password: cur, new_password: next }),
      })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (b) {
            return { ok: r.ok && b.success !== false, body: b };
          });
        })
        .then(function (res) {
          if (!res.ok) {
            submitBtn.disabled = false;
            submitBtn.textContent = "Update password";
            showErr((res.body && (res.body.message || res.body.detail)) || "Could not update password.");
            curEl.focus(); curEl.select();
            return;
          }
          submitBtn.textContent = "Done — signing out…";
          setTimeout(function () {
            close();
            logout("Password changed. Please sign in with your new password.");
          }, 600);
        })
        .catch(function () {
          submitBtn.disabled = false;
          submitBtn.textContent = "Update password";
          showErr("Cannot reach the server. Please try again.");
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

    if (typeof firebase !== "undefined" && window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey) {
      if (!firebase.apps.length) {
        firebase.initializeApp(window.FIREBASE_CONFIG);
      }
      _firebaseAuth = firebase.auth();
    } else {
      console.error("Cibara: Firebase SDK or config missing — live updates disabled");
    }

    _wrapFetch();
    // Expose apiFetch as a bare global so legacy modules can call it
    // directly. It's just window.fetch with auth-token wrapping applied
    // by _wrapFetch(). Calls made before this point fall back to fetch.
    window.apiFetch = function (input, init) {
      return window.fetch(input, init);
    };

    let _attempt = 0;
    function _start() {
      _refreshSession(true).then(function (result) {
        if (result === "denied") {
          // No (valid) session. Drop any Firebase session left over from the
          // old sign-in flow too, so the login page does not bounce back.
          _user = null;
          _idToken = null;
          const goLogin = function () {
            if (_deniedMessage && _deniedMessage !== "Not signed in") {
              try { sessionStorage.setItem("cibara_logout_msg", _deniedMessage); } catch (_) { /* ignore */ }
            }
            _redirectToLogin();
          };
          if (_firebaseAuth) _firebaseAuth.signOut().then(goLogin, goLogin);
          else goLogin();
          return;
        }
        if (result === "unavailable") {
          // Keep the cookie; retry with back-off (2s, 4s, … max 30s).
          _attempt += 1;
          console.warn("Cibara: server unreachable while restoring the session, retrying");
          setTimeout(_start, Math.min(30000, 2000 * Math.pow(2, _attempt - 1)));
          return;
        }
        if (!_user || !_user.role) {
          logout("Your account is not configured. Contact an administrator.");
          return;
        }
        const tokenP = (_lastSession && _lastSession.firebase_custom_token)
          ? Promise.resolve(_lastSession.firebase_custom_token)
          : fetch(AUTH_API + "/firebase-token")
              .then(function (r) { return r.ok ? r.json() : {}; })
              .then(function (b) { return (b && b.firebase_custom_token) || null; })
              .catch(function () { return null; });
        tokenP.then(_signInFirebase).then(function (realtimeOk) {
          _realtimeOk = !!realtimeOk;
          _startIdleTimer();
          _markReady();

          const gate = function () {
            applyRoleGating();
            _startMutationGating();
            _injectIdentityChip();
            document.body.setAttribute("data-role", _user.role);
          };
          if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", gate);
          } else {
            gate();
          }

          // Verify the user against our backend (active check) — unchanged.
          fetch("/api/auth/me").then(function (r) {
            if (r.status === 403) {
              logout("Your account has been disabled.");
            }
          }).catch(function () { /* non-fatal */ });
        });
      });
    }
    _start();
  }

  // ── Public API ────────────────────────────────────────────────────────────
  // Exposed under window.CibaraAuth — used by every role-gated widget in
  // the rest of the app (admin-users.js, bills.js, register.js, etc.).
  // Every method tolerates being called before token claims have loaded.

  // Kick off the actual auth flow. Defines `window.apiFetch`, registers
  // onAuthStateChanged, schedules token refresh, wires the profile menu.
  // Skip on the login page itself (handled inside _bootstrap).
  try {
    _bootstrap();
  } catch (e) {
    console.error("Cibara: _bootstrap failed:", e);
  }

  window.CibaraAuth = Object.freeze({
    currentUser:     currentUser,
    getCurrentUser:  currentUser,    // alias for legacy callers
    isAdmin:         isAdmin,
    isManager:       isManager,
    isHousekeeping:  isHousekeeping,
    userCan:         userCan,
    ready:           ready,
    realtimeAvailable: function () { return _realtimeOk; },
    logout:          logout,
    applyRoleGating: applyRoleGating,
  });
})(window);
