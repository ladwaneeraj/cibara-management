/* ─────────────────────────────────────────────────────────────────────────
 * Login page logic.
 *
 * Flow:
 *   1. User types userId + password.
 *   2. We map userId → "<userId>@cibara.internal" (synthetic email).
 *   3. signInWithEmailAndPassword via Firebase Auth web SDK.
 *   4. On success, redirect to "/".
 *
 * The synthetic-email domain is an implementation detail — the user
 * never sees it.
 *
 * Error messages are deliberately generic to avoid leaking which half
 * of the credential pair was wrong.
 * ──────────────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  const SYNTHETIC_DOMAIN = "cibara.internal";
  const REDIRECT_TARGET = "/";

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

  function toSyntheticEmail(userId) {
    const cleaned = String(userId || "").trim().toLowerCase();
    if (!cleaned) return "";
    return cleaned.includes("@") ? cleaned : `${cleaned}@${SYNTHETIC_DOMAIN}`;
  }

  function friendlyAuthError(err) {
    // Generic message for credential errors so we don't leak which one was wrong.
    const code = (err && err.code) || "";
    switch (code) {
      case "auth/invalid-email":
      case "auth/invalid-credential":
      case "auth/wrong-password":
      case "auth/user-not-found":
        return "Incorrect User ID or password.";
      case "auth/user-disabled":
        return "This account has been disabled. Contact an administrator.";
      case "auth/too-many-requests":
        return "Too many failed attempts. Please wait a minute and try again.";
      case "auth/network-request-failed":
        return "Network error. Check your connection and try again.";
      default:
        return "Sign-in failed. Please try again.";
    }
  }

  // ── Firebase init ─────────────────────────────────────────────────────
  if (!window.FIREBASE_CONFIG || !window.FIREBASE_CONFIG.apiKey) {
    showError("Firebase is not configured. Contact your administrator.");
    setLoading(false);
    submitBtn.disabled = true;
    return;
  }

  if (!firebase.apps.length) {
    firebase.initializeApp(window.FIREBASE_CONFIG);
  }
  const auth = firebase.auth();

  // Persist session across reloads but allow the 24-hour idle timer in the
  // main app to clear it. LOCAL persistence is the correct choice — the
  // app's own idle timer drives the actual logout.
  auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(function (e) {
    console.warn("Could not set auth persistence:", e);
  });

  // If the user is already signed in, skip straight to the app.
  auth.onAuthStateChanged(function (user) {
    if (user) {
      window.location.replace(REDIRECT_TARGET);
    }
  });

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

    const email = toSyntheticEmail(userId);
    setLoading(true);

    auth
      .signInWithEmailAndPassword(email, password)
      .then(function (cred) {
        // Force-refresh the ID token so any newly-set custom claims are
        // present immediately (relevant after a password reset).
        return cred.user.getIdToken(true);
      })
      .then(function () {
        // Mark fresh login — main app's idle timer reads this on first paint
        try {
          sessionStorage.setItem("cibara_login_ts", String(Date.now()));
        } catch (_) {
          /* sessionStorage may be unavailable in private mode */
        }
        window.location.replace(REDIRECT_TARGET);
      })
      .catch(function (err) {
        console.warn("Login failed:", err && err.code, err && err.message);
        showError(friendlyAuthError(err));
        setLoading(false);
        // Refocus the password field so the user can retype quickly
        passwordInput.value = "";
        passwordInput.focus();
      });
  });
})();
