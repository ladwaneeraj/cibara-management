/* ============================================================================
 * modal-back.js — the Android back button closes the open modal.
 * ----------------------------------------------------------------------------
 * The app is installed as a standalone PWA and never touched the History API,
 * so the back gesture had nothing to pop and Android closed the whole app —
 * even with a modal open on top. Losing a half-filled expense or checkout form
 * to a stray back swipe is the worst version of that bug.
 *
 * How it works: while any modal is open we keep a matching number of dummy
 * entries on the history stack. Back pops one, we intercept the popstate and
 * dismiss the topmost modal instead of navigating. Close a modal the normal
 * way (X, backdrop, Escape) and we quietly retire its entry so the stack stays
 * in step. With nothing open, back behaves exactly as before.
 *
 * Modals are found by SHAPE, not by a hard-coded list of class names. Anything
 * fixed-position and large enough to be covering the screen counts. That
 * matters here: this codebase has at least eight different overlay
 * conventions (.modal-backdrop.show, .bill-modal.show, #reg-bill-overlay,
 * .bl-pay-modal-backdrop.bl-pay-open, .txn-sheet-backdrop.open, .ds-back,
 * .cm-*-overlay, inline display:flex), and a list would silently miss the
 * next one someone adds.
 *
 * Opt out with `data-no-back` on the overlay — used for progress overlays the
 * operator is not meant to dismiss.
 *
 * No dependencies. Loads standalone; does nothing on desktop browsers beyond
 * making the browser Back button close a modal, which is also correct.
 * ==========================================================================*/

(function () {
  "use strict";

  // Only elements matching this are even considered — a cheap filter before
  // the (more expensive) geometry test.
  var CANDIDATE_SELECTOR = [
    '[class*="modal"]', '[class*="overlay"]', '[class*="backdrop"]',
    '[class*="sheet"]', '[class*="popup"]', '[class*="drawer"]',
    '[id*="modal"]', '[id*="overlay"]',
    // The bill cropper's root is `.ds-back` — "back", not "backdrop" — so it
    // matched nothing above. Back then found the expense modal *underneath*
    // the open cropper and closed that instead, discarding a half-filled form
    // while the cropper stayed on screen.
    '.ds-back',
    // Explicit opt-in for anything that follows neither convention.
    '[data-modal-surface]'
  ].join(",");

  // Controls that dismiss a modal, best first. Clicking the app's own close
  // button is preferred over forcing the element hidden, because it runs
  // whatever cleanup that modal does (resetting form state, clearing caches).
  var CLOSE_SELECTOR = [
    "[data-modal-close]", ".close-btn", ".bill-close", ".cm-close-btn",
    ".lgr-panel-close", ".rp-close", ".rdoc-close", ".qc-close-btn",
    ".doc-cam-close-btn", "[data-ds-cancel]", "[data-sheet-cancel]",
    '[aria-label="Close"]', '[aria-label="close"]'
  ].join(",");

  // Classes that commonly carry "this overlay is visible".
  var OPEN_CLASSES = ["show", "open", "active", "visible", "is-open",
                      "bl-pay-open", "ns-open"];

  function isVisible(el) {
    var cs = window.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;

    // pointer-events is the reliable signal. The dominant pattern in this app
    // is `.modal-backdrop { opacity:0; pointer-events:none }` flipped to
    // `opacity:1; pointer-events:auto` by a .show class — and pointer-events
    // is not animated, so it is true the instant the class lands.
    if (cs.pointerEvents === "none") return false;

    // Opacity alone cannot be trusted while a fade is running. These modals
    // transition opacity over 0.3s, so a scan on the next animation frame saw
    // ~0 and concluded the modal was shut — which is why no history entry was
    // pushed and Back still closed the whole app.
    if (parseFloat(cs.opacity || "1") < 0.05) {
      var prop = cs.transitionProperty || "";
      var dur = parseFloat(cs.transitionDuration || "0") || 0;
      var fadingIn = dur > 0 && (prop.indexOf("opacity") !== -1 || prop.indexOf("all") !== -1);
      if (!fadingIn) return false;
    }
    return true;
  }

  /**
   * Is this element currently acting as a modal surface?
   *
   * Fixed position, visible, and either covering most of the viewport (a
   * classic centred dialog / full-screen overlay) or spanning the width at
   * the bottom (a sheet). The size floor is what keeps toasts, sticky headers
   * and dropdown panels out.
   */
  // Overlays we tried and failed to dismiss. Once an element is in here it
  // stops being guarded, so Back falls through to the browser and the
  // operator can always leave. Without this the settle pass re-pushed a guard
  // 350ms after the failed close and re-trapped them.
  var undismissable = (typeof WeakSet === "function") ? new WeakSet() : null;

  function isModalSurface(el, includeBlockers) {
    if (undismissable && undismissable.has(el)) return false;
    if (!includeBlockers && el.hasAttribute("data-no-back")) return false;
    var cs = window.getComputedStyle(el);
    if (cs.position !== "fixed") return false;
    if (!isVisible(el)) return false;

    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var vw = window.innerWidth || 1, vh = window.innerHeight || 1;
    var coversMost = r.width >= vw * 0.6 && r.height >= vh * 0.4;
    var bottomSheet = r.width >= vw * 0.85 && (vh - r.bottom) < 8 && r.height >= 80;
    return coversMost || bottomSheet;
  }

  function openModals(includeBlockers) {
    var out = [];
    var nodes = document.querySelectorAll(CANDIDATE_SELECTOR);
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      // A modal inside another open modal is not a separate surface — only
      // count outermost ones, or nested markup double-counts.
      if (isModalSurface(el, includeBlockers)) out.push(el);
    }
    return out.filter(function (el) {
      return !out.some(function (other) {
        return other !== el && other.contains(el);
      });
    });
  }

  /**
   * True when a non-dismissible overlay (a save/upload spinner) is on top.
   *
   * Such an overlay must swallow the back press outright. Merely excluding it
   * from the list let Back reach the modal beneath — cancelling and resetting
   * a form whose save request was still in flight.
   */
  function blockedByBusyOverlay() {
    var all = openModals(true);
    if (!all.length) return false;
    return all[all.length - 1].hasAttribute("data-no-back");
  }

  /**
   * Dismiss one modal, escalating until it actually goes away.
   *
   * Each strategy is verified rather than assumed: a close button may be
   * disabled mid-save, and some overlays ignore Escape.
   */
  function closeModal(el) {
    if (!el) return false;

    // 1. The modal's own close control — runs its cleanup.
    var btn = el.querySelector(CLOSE_SELECTOR);
    if (btn && !btn.disabled) {
      btn.click();
      if (!isModalSurface(el)) return true;
    }

    // 2. Escape, dispatched ON THE MODAL so it bubbles to document-level
    //    handlers with the right target. Firing it at `document` directly
    //    woke every Escape listener in the app at once and could dismiss two
    //    stacked overlays with a single back press.
    //
    //    keyCode/which are deliberately omitted: they are readonly and not
    //    part of KeyboardEventInit, so passing them does nothing but imply
    //    legacy handlers are covered when they are not.
    el.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape", code: "Escape", bubbles: true
    }));
    if (!isModalSurface(el)) return true;

    // 3. A backdrop click, for modals that close on outside-click. Dispatched
    //    on the overlay itself so handlers testing `e.target === backdrop`
    //    match.
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    if (!isModalSurface(el)) return true;

    // 4. Force it hidden. Last resort — skips the modal's cleanup, but a
    //    stuck overlay the back button cannot dismiss is worse.
    for (var i = 0; i < OPEN_CLASSES.length; i++) {
      if (el.classList.contains(OPEN_CLASSES[i])) el.classList.remove(OPEN_CLASSES[i]);
    }
    if (isModalSurface(el)) el.style.display = "none";
    return !isModalSurface(el);
  }

  // ── History bookkeeping ───────────────────────────────────────────────────

  var guards = 0;          // dummy history entries we own
  var suppress = 0;        // popstate events we caused and must ignore
  var lastCount = 0;
  var scanQueued = false;

  function pushGuard() {
    try {
      history.pushState({ __cibaraModal: guards + 1 }, "");
      guards++;
    } catch (err) {
      // iOS Safari throws SecurityError past ~100 pushState calls in 30s.
      // Losing the guard just means Back behaves as it did before this
      // module existed; an uncaught throw from a rAF callback would be worse.
      console.warn("[ModalBack] pushState refused:", err && err.message);
    }
  }

  function dropGuard() {
    if (guards <= 0) return;
    guards--;
    suppress++;
    history.back();
  }

  function sync() {
    scanQueued = false;
    var count;
    try {
      count = openModals().length;
    } catch (err) {
      // Never let a scan failure escape a rAF/observer callback and take the
      // page with it.
      console.warn("[ModalBack] scan failed:", err && err.message);
      return;
    }
    if (count === lastCount) return;

    if (count > lastCount) {
      for (var i = lastCount; i < count; i++) pushGuard();
    } else {
      // Closed by the app (X, backdrop, save). Retire the spare entries so a
      // later back press doesn't get swallowed doing nothing.
      for (var j = count; j < lastCount; j++) dropGuard();
    }
    lastCount = count;
  }

  var settleTimer = null;
  function queueSync() {
    // A second, later pass. Overlays that animate in (or are built
    // asynchronously) are not in their final state one frame after the
    // mutation that triggered this.
    //
    // NOT debounced by resetting the timer: a continuously-mutating element
    // (a spinner rewriting its inline style every frame, a progress bar)
    // would push the deadline forever and the settle pass — the one that
    // retires guards for slow-fading modals — would never run.
    if (settleTimer === null) {
      settleTimer = setTimeout(function () { settleTimer = null; sync(); }, 350);
    }

    if (scanQueued) return;
    scanQueued = true;
    // Coalesce: opening a modal can flip several attributes in one frame.
    requestAnimationFrame(sync);
  }

  window.addEventListener("popstate", function () {
    if (suppress > 0) { suppress--; return; }   // our own history.back()

    // The entry was already popped by the browser, so one fewer guard is ours.
    if (guards > 0) guards--;

    // A busy overlay (saving, uploading) swallows the press. Re-arm so the
    // next one is caught too, rather than letting it fall through and close
    // the form whose save is still running.
    if (blockedByBusyOverlay()) {
      pushGuard();
      return;
    }

    var open = openModals();
    if (!open.length) {
      // Nothing to dismiss — let the app exit / navigate as it normally would.
      lastCount = 0;
      guards = 0;              // drop any stale count; we are back at the root
      return;
    }

    var target = open[open.length - 1];
    var closed = closeModal(target);
    lastCount = openModals().length;

    // Re-arm guards for whatever is still open — but NEVER for a modal we
    // just failed to close. Doing so trapped the operator in the app: every
    // press popped a guard, failed to close, and pushed a fresh one.
    if (!closed) {
      console.warn("[ModalBack] could not dismiss", target,
                   "— leaving Back to the browser so the app stays escapable.");
      if (undismissable) undismissable.add(target);
      lastCount = openModals().length;   // recount without the stuck overlay
      guards = 0;
      while (guards < lastCount) pushGuard();
      return;
    }
    while (guards < lastCount) pushGuard();
  });

  /**
   * Filter mutations before scanning.
   *
   * The observer covers the whole document, and rendering a transaction table
   * mutates hundreds of rows. Each unfiltered batch triggered a
   * querySelectorAll of seven substring-attribute selectors plus two
   * getComputedStyle calls and a getBoundingClientRect per candidate — a
   * forced layout inside a rAF. Only fixed-position elements can be modal
   * surfaces, so cheap-reject everything else first.
   */
  function mutationCouldMatter(records) {
    for (var i = 0; i < records.length; i++) {
      var t = records[i].target;
      if (!t || t.nodeType !== 1) continue;
      if (records[i].type === "childList") return true;   // new nodes: rescan
      var cls = t.getAttribute ? (t.getAttribute("class") || "") : "";
      var id = t.id || "";
      if (/modal|overlay|backdrop|sheet|popup|drawer|ds-back/.test(cls + " " + id)) {
        return true;
      }
    }
    return false;
  }

  // Watch for any change that could show or hide an overlay.
  var obs = new MutationObserver(function (records) {
    if (mutationCouldMatter(records)) queueSync();
  });
  function start() {
    obs.observe(document.body, {
      subtree: true, childList: true,
      attributes: true, attributeFilter: ["class", "style", "hidden"]
    });
    queueSync();
  }
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);

  // Some overlays animate in; re-check shortly after load so the initial
  // count is right even if one is open at startup.
  window.addEventListener("load", queueSync);

  window.CibaraModalBack = {
    /** Currently-open modal surfaces, outermost first. */
    open: openModals,
    /** Dismiss the topmost modal, as the back button would. */
    closeTop: function () {
      var o = openModals();
      return o.length ? closeModal(o[o.length - 1]) : false;
    },
    /** Force a re-count — call after showing an overlay in an unusual way. */
    sync: queueSync,
    _state: function () { return { guards: guards, open: lastCount }; }
  };
})();
