/**
 * pin-lock.js — Lodge PIN lock screen
 *
 * Shows a full-screen PIN entry overlay before the app is usable.
 * Verified against the server (/verify-pin). Auth state lives in
 * sessionStorage so refresh within the same tab keeps you logged in,
 * but closing the tab/browser always requires re-entry.
 *
 * Auto-locks after INACTIVITY_MS of no user interaction.
 */

(function () {
  "use strict";

  const SESSION_KEY    = "lodge_auth_ts";   // sessionStorage key
  const INACTIVITY_MS  = 30 * 60 * 1000;   // 30 minutes

  let lockTimer = null;
  let isLocked  = true;

  // ── Helpers ────────────────────────────────────────────────────────────────

  function _now() { return Date.now(); }

  function _isSessionValid() {
    const ts = parseInt(sessionStorage.getItem(SESSION_KEY) || "0", 10);
    return ts > 0 && (_now() - ts) < INACTIVITY_MS;
  }

  function _markAuthed() {
    sessionStorage.setItem(SESSION_KEY, String(_now()));
  }

  function _clearAuth() {
    sessionStorage.removeItem(SESSION_KEY);
  }

  // ── Activity tracking ─────────────────────────────────────────────────────

  function _resetTimer() {
    if (isLocked) return;
    clearTimeout(lockTimer);
    sessionStorage.setItem(SESSION_KEY, String(_now())); // refresh ts
    lockTimer = setTimeout(_autoLock, INACTIVITY_MS);
  }

  function _autoLock() {
    _clearAuth();
    _showLock("🔒 Auto-locked after 30 min of inactivity");
  }

  ["mousedown", "mousemove", "keydown", "touchstart", "scroll", "click"].forEach(
    (evt) => window.addEventListener(evt, _resetTimer, { passive: true })
  );

  // ── DOM ───────────────────────────────────────────────────────────────────

  function _buildOverlay() {
    const el = document.createElement("div");
    el.id = "pin-overlay";
    el.innerHTML = `
      <div class="pin-card">
        <div class="pin-logo">🏨</div>
        <div class="pin-title">Cibara Comforts</div>
        <div class="pin-subtitle" id="pin-subtitle">Enter PIN to continue</div>

        <div class="pin-dots">
          <span class="pin-dot" id="pd0"></span>
          <span class="pin-dot" id="pd1"></span>
          <span class="pin-dot" id="pd2"></span>
          <span class="pin-dot" id="pd3"></span>
          <span class="pin-dot" id="pd4"></span>
          <span class="pin-dot" id="pd5"></span>
        </div>

        <div class="pin-grid">
          ${[1,2,3,4,5,6,7,8,9,"",0,"⌫"].map(k =>
            k === ""
              ? `<div></div>`
              : `<button class="pin-key" data-key="${k}">${k}</button>`
          ).join("")}
        </div>

        <div class="pin-error" id="pin-error"></div>
      </div>
    `;
    return el;
  }

  function _injectStyles() {
    if (document.getElementById("pin-lock-style")) return;
    const s = document.createElement("style");
    s.id = "pin-lock-style";
    s.textContent = `
      #pin-overlay {
        position: fixed; inset: 0; z-index: 99999;
        display: flex; align-items: center; justify-content: center;
        background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      .pin-card {
        background: #1e293b;
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 20px;
        padding: 2rem 2.5rem 2.5rem;
        text-align: center;
        width: 320px;
        box-shadow: 0 25px 60px rgba(0,0,0,0.5);
      }
      .pin-logo   { font-size: 2.5rem; margin-bottom: 0.5rem; }
      .pin-title  { color: #f1f5f9; font-size: 1.25rem; font-weight: 700; margin-bottom: 0.15rem; }
      .pin-subtitle {
        color: #94a3b8; font-size: 0.82rem; margin-bottom: 1.5rem;
        min-height: 1.2em; transition: color 0.2s;
      }
      .pin-dots {
        display: flex; justify-content: center; gap: 0.75rem;
        margin-bottom: 1.75rem;
      }
      .pin-dot {
        width: 14px; height: 14px; border-radius: 50%;
        border: 2px solid #475569;
        background: transparent;
        transition: background 0.15s, border-color 0.15s;
        display: inline-block;
      }
      .pin-dot.filled { background: #38bdf8; border-color: #38bdf8; }
      .pin-dot.error  { background: #f87171; border-color: #f87171; }
      .pin-grid {
        display: grid; grid-template-columns: repeat(3, 1fr);
        gap: 0.65rem; margin-bottom: 1rem;
      }
      .pin-key {
        background: #334155; border: none; border-radius: 12px;
        color: #f1f5f9; font-size: 1.3rem; font-weight: 600;
        padding: 0.85rem 0; cursor: pointer;
        transition: background 0.15s, transform 0.1s;
        -webkit-tap-highlight-color: transparent;
      }
      .pin-key:hover  { background: #475569; }
      .pin-key:active { transform: scale(0.93); background: #38bdf8; color: #0f172a; }
      .pin-key[data-key="⌫"] { font-size: 1rem; color: #94a3b8; }
      .pin-error {
        color: #f87171; font-size: 0.8rem; min-height: 1.1em;
        margin-top: 0.5rem; font-weight: 500;
      }
      @keyframes pin-shake {
        0%,100% { transform: translateX(0); }
        20%     { transform: translateX(-8px); }
        40%     { transform: translateX(8px); }
        60%     { transform: translateX(-5px); }
        80%     { transform: translateX(5px); }
      }
      .pin-shake { animation: pin-shake 0.4s ease; }
    `;
    document.head.appendChild(s);
  }

  // ── PIN logic ─────────────────────────────────────────────────────────────

  let _pin      = "";
  let _busy     = false;
  let _overlay  = null;
  let _subtitle = null;

  function _updateDots() {
    for (let i = 0; i < 6; i++) {
      const d = document.getElementById(`pd${i}`);
      if (!d) continue;
      d.classList.toggle("filled", i < _pin.length);
      d.classList.remove("error");
    }
  }

  function _setSubtitle(msg, isError) {
    if (!_subtitle) return;
    _subtitle.textContent = msg;
    _subtitle.style.color = isError ? "#f87171" : "#94a3b8";
  }

  function _shakeCard() {
    const card = _overlay?.querySelector(".pin-card");
    if (!card) return;
    card.classList.remove("pin-shake");
    void card.offsetWidth; // reflow
    card.classList.add("pin-shake");
    for (let i = 0; i < 6; i++) {
      const d = document.getElementById(`pd${i}`);
      if (d && i < _pin.length) d.classList.add("error");
    }
    setTimeout(() => {
      for (let i = 0; i < 6; i++) {
        const d = document.getElementById(`pd${i}`);
        if (d) d.classList.remove("error");
      }
    }, 500);
  }

  async function _submitPin() {
    if (_busy || _pin.length < 4) return;
    _busy = true;
    _setSubtitle("Verifying…", false);

    try {
      const res = await fetch("/verify-pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: _pin }),
      });
      const data = await res.json();

      if (data.success) {
        _markAuthed();
        _unlock();
      } else {
        _pin = "";
        _updateDots();
        _shakeCard();
        _setSubtitle("Incorrect PIN — try again", true);
        _busy = false;
      }
    } catch {
      _pin = "";
      _updateDots();
      _setSubtitle("Network error — try again", true);
      _busy = false;
    }
  }

  function _handleKey(key) {
    if (_busy) return;
    if (key === "⌫") {
      _pin = _pin.slice(0, -1);
      _updateDots();
      _setSubtitle("Enter PIN to continue", false);
      return;
    }
    if (_pin.length >= 6) return;
    _pin += key;
    _updateDots();
    // Auto-submit when 4–6 digits entered (server decides the correct length)
    if (_pin.length >= 4) _submitPin();
  }

  // ── Show / hide overlay ───────────────────────────────────────────────────

  function _showLock(subtitle) {
    isLocked = true;
    clearTimeout(lockTimer);
    _pin  = "";
    _busy = false;

    if (!_overlay || !document.getElementById("pin-overlay")) {
      _injectStyles();
      _overlay = _buildOverlay();
      document.body.appendChild(_overlay);

      // Wire keypad buttons
      _overlay.querySelectorAll(".pin-key").forEach((btn) => {
        btn.addEventListener("click", () => _handleKey(btn.dataset.key));
      });

      // Wire keyboard
      document.addEventListener("keydown", _onKeyboard);
    } else {
      _overlay.style.display = "flex";
    }

    _subtitle = document.getElementById("pin-subtitle");
    if (subtitle) _setSubtitle(subtitle, false);
    _updateDots();
  }

  function _unlock() {
    isLocked = false;
    if (_overlay) _overlay.style.display = "none";
    document.removeEventListener("keydown", _onKeyboard);
    clearTimeout(lockTimer);
    lockTimer = setTimeout(_autoLock, INACTIVITY_MS);
  }

  function _onKeyboard(e) {
    if (e.key >= "0" && e.key <= "9") _handleKey(e.key);
    else if (e.key === "Backspace")     _handleKey("⌫");
    else if (e.key === "Enter" && _pin.length >= 4) _submitPin();
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  async function init() {
    if (_isSessionValid()) {
      // Still authed from earlier in this tab session
      isLocked = false;
      lockTimer = setTimeout(_autoLock, INACTIVITY_MS);
      return;
    }

    // Check if server is running in dev mode (no LODGE_PIN set).
    // If so, auto-unlock without showing the modal at all.
    try {
      const res  = await fetch("/verify-pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: "" }),
      });
      const data = await res.json();
      if (data.success && data.dev) {
        // Dev mode — no PIN configured on server, skip the modal
        _markAuthed();
        isLocked = false;
        lockTimer = setTimeout(_autoLock, INACTIVITY_MS);
        return;
      }
    } catch {
      // Server unreachable — still show the modal
    }

    _showLock("Enter PIN to continue");
  }

  // Expose lock function globally (e.g. for a "Lock" button in the UI)
  window.lodgeLock = function () {
    _clearAuth();
    _showLock("🔒 Locked");
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
