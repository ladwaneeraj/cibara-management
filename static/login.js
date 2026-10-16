/* ─────────────────────────────────────────────────────────────────────────
 * Login page logic.
 *
 * Flow:
 *   1. User types userId + password.
 *   2. POST /api/v2/auth/login checks the password against Firebase Auth on
 *      the server (same "<userId>@cibara.internal" account as before),
 *      applies the per-IP / per-account attempt limits, and sets the
 *      HttpOnly refresh cookie.
 *   3. On success, redirect to "/". The main app (auth.js) restores the
 *      session from that cookie and signs the Firebase SDK in for live sync.
 *
 * Error messages come from the server and are deliberately generic so they
 * don't leak which half of the credential pair was wrong.
 * ──────────────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  const REDIRECT_TARGET = "/";
  const LOGIN_API = "/api/v2/auth/login";

  // ── DOM refs ──────────────────────────────────────────────────────────
  const form = document.getElementById("login-form");
  const userIdInput = document.getElementById("user-id");
  const passwordInput = document.getElementById("password");
  const errorBox = document.getElementById("login-error");
  const submitBtn = document.getElementById("login-submit");
  const togglePwBtn = document.getElementById("toggle-password");

  // ── Helpers ───────────────────────────────────────────────────────────
  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.hidden = false;
    userIdInput.setAttribute("aria-invalid", "true");
    passwordInput.setAttribute("aria-invalid", "true");
  }

  function clearError() {
    errorBox.textContent = "";
    errorBox.hidden = true;
    userIdInput.removeAttribute("aria-invalid");
    passwordInput.removeAttribute("aria-invalid");
  }

  function setLoading(on) {
    submitBtn.disabled = on;
    submitBtn.classList.toggle("is-loading", on);
    userIdInput.disabled = on;
    passwordInput.disabled = on;
  }

  function friendlyError(status, body) {
    const msg = body && (body.message || body.detail);
    if (typeof msg === "string" && msg) return msg;
    if (status === 401) return "Incorrect User ID or password.";
    if (status === 403) return "This account has been disabled. Contact an administrator.";
    if (status === 429) return "Too many failed attempts. Please wait a minute and try again.";
    if (status >= 500) return "Sign-in service is unreachable. Please try again.";
    return "Sign-in failed. Please try again.";
  }

  // Message left by the main app when it signed the user out
  // (idle timeout, password change, account disabled, …).
  try {
    const m = sessionStorage.getItem("cibara_logout_msg");
    if (m) {
      sessionStorage.removeItem("cibara_logout_msg");
      errorBox.textContent = m;
      errorBox.hidden = false;
    }
  } catch (_) { /* storage blocked */ }

  // ── Password visibility toggle ────────────────────────────────────────
  togglePwBtn.addEventListener("click", function () {
    const showing = passwordInput.type === "text";
    passwordInput.type = showing ? "password" : "text";
    togglePwBtn.setAttribute("aria-pressed", String(!showing));
    togglePwBtn.setAttribute("aria-label", showing ? "Show password" : "Hide password");
    // Keep focus in the password field for keyboard users
    passwordInput.focus();
  });

  // Clear errors as soon as the user edits anything
  [userIdInput, passwordInput].forEach(function (el) {
    el.addEventListener("input", clearError);
  });

  // ── Submit ────────────────────────────────────────────────────────────
  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    clearError();

    const userId = userIdInput.value.trim();
    const password = passwordInput.value;

    if (!userId || !password) {
      showError("Please enter your User ID and password.");
      return;
    }
    if (userId.length < 2 || password.length < 6) {
      showError("Incorrect User ID or password.");
      return;
    }

    setLoading(true);

    fetch(LOGIN_API, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ user_id: userId, password: password }),
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (b) {
          return { status: r.status, ok: r.ok, body: b };
        });
      })
      .then(function (res) {
        if (!res.ok) {
          showError(friendlyError(res.status, res.body));
          setLoading(false);
          passwordInput.value = "";
          passwordInput.focus();
          return;
        }
        // Mark fresh login — main app's idle timer reads this on first paint
        try {
          sessionStorage.setItem("cibara_login_ts", String(Date.now()));
        } catch (_) {
          /* sessionStorage may be unavailable in private mode */
        }
        // Tell any open app tabs: a (possibly different) user just signed in.
        try { localStorage.setItem("cibara_auth_event", JSON.stringify({ type: "login", at: Date.now() })); } catch (_) {}
        window.location.replace(REDIRECT_TARGET);
      })
      .catch(function () {
        showError("Network error. Check your connection and try again.");
        setLoading(false);
      });
  });
})();
