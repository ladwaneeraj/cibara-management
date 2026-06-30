/* ===========================================================================
 * optimistic.js — UI-first writes with rollback + per-key ordering.
 * ---------------------------------------------------------------------------
 * Problem this solves:
 *   The write handlers (add service, add payment, check-in) used to
 *   `await` the network call and only update the screen afterwards, so the
 *   button sat on "Processing…" for the whole round-trip.
 *
 * What this does:
 *   1. Updates the screen IMMEDIATELY (apply()), capturing a snapshot.
 *   2. Persists in the BACKGROUND, in order, per key (e.g. room number).
 *   3. On failure: rolls the screen back to the snapshot and alerts loudly.
 *
 * Money safety:
 *   - Per-key FIFO ordering: "add service" reaches the server before a
 *     later "checkout" for the same room, so the bill can't miss it.
 *   - rollback-on-failure: a dropped write reverts the UI — never a silent
 *     book-corrupting success.
 *   - Callers keep the trigger button disabled until the returned promise
 *     settles for money-creating actions, so a double-click can't double-post.
 *
 * Kill-switch (instant rollback to old behaviour, no redeploy):
 *   - window.CIBARA_OPTIMISTIC = false            // for the page
 *   - localStorage.setItem('CIBARA_OPTIMISTIC','0')  // sticky, per browser
 *   When off, writes persist FIRST and the screen updates only on success
 *   (exactly today's behaviour). rollback() is never called in that mode.
 * ======================================================================== */
(function () {
  "use strict";

  // key -> tail Promise of that key's FIFO chain
  var _queues = new Map();

  function _enqueue(key, job) {
    var prev = _queues.get(key) || Promise.resolve();
    // Run `job` after `prev` settles, regardless of prev's outcome.
    var next = prev.then(job, job);
    // Store a swallowed copy as the tail so one rejection doesn't poison the
    // chain or surface as an unhandled rejection. Return the real promise.
    _queues.set(key, next.then(function () {}, function () {}));
    return next;
  }

  function newOpId() {
    if (window.crypto && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return "op_" + Date.now() + "_" + Math.random().toString(16).slice(2);
  }

  function _optimisticEnabled() {
    try {
      if (window.CIBARA_OPTIMISTIC === false) return false;
      if (localStorage.getItem("CIBARA_OPTIMISTIC") === "0") return false;
    } catch (e) {
      /* localStorage may throw in private mode — default to enabled */
    }
    return true;
  }

  function _toast(msg, type, ms) {
    if (typeof window.showNotification === "function") {
      window.showNotification(msg, type, ms);
    } else {
      (type === "error" ? console.error : console.log)(msg);
    }
  }

  function _cap(s) {
    s = String(s || "");
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /**
   * optimisticWrite(opts) -> Promise<result>
   *
   *   key       : serialization key, e.g. room number (required)
   *   apply     : () => snapshot      mutate local state + re-render NOW;
   *                                   return whatever rollback() needs (required)
   *   rollback  : (snapshot) => void  restore state + re-render on failure (required)
   *   request   : (opId) => Promise<Response>   perform the network write (required)
   *   onSuccess : (result) => void    optional; reconcile with server truth
   *   onError   : (err)    => void    optional; runs in addition to rollback
   *   label     : string for toasts ("payment", "service", ...) (optional)
   *
   * The returned promise rejects on failure; callers that touch the button
   * should attach `.then(fn, fn)` / `.catch().finally()` to re-enable it.
   */
  function optimisticWrite(opts) {
    opts = opts || {};
    var key = opts.key;
    var apply = opts.apply;
    var rollback = opts.rollback;
    var request = opts.request;
    var onSuccess = opts.onSuccess;
    var onError = opts.onError;
    var label = opts.label || "change";
    var opId = newOpId();

    if (typeof apply !== "function" || typeof request !== "function") {
      return Promise.reject(new Error("optimisticWrite: apply and request are required"));
    }

    async function _persist() {
      var resp = await request(opId);
      if (!resp || !resp.ok) {
        throw new Error("HTTP " + (resp ? resp.status : "no response"));
      }
      var result = await resp.json();
      if (!result || !result.success) {
        throw new Error((result && result.message) || "Server rejected the write");
      }
      return result;
    }

    // ── Kill-switch OFF: legacy behaviour (persist first, patch on success) ──
    if (!_optimisticEnabled()) {
      return _enqueue(key, async function () {
        var result = await _persist();
        try { apply(); } catch (e) { console.error("apply() after success failed:", e); }
        if (onSuccess) onSuccess(result);
        return result;
      }).catch(function (err) {
        _toast(_cap(label) + " failed: " + err.message, "error");
        throw err;
      });
    }

    // ── Optimistic: patch now, persist in background, rollback on failure ──
    var snapshot;
    try {
      snapshot = apply();
    } catch (e) {
      console.error("optimisticWrite apply() failed:", e);
      _toast("Could not update " + label + ": " + e.message, "error");
      return Promise.reject(e);
    }

    return _enqueue(key, async function () {
      try {
        var result = await _persist();
        if (onSuccess) onSuccess(result);
        return result;
      } catch (err) {
        console.error("optimisticWrite[" + label + "] failed:", err);
        try {
          if (typeof rollback === "function") rollback(snapshot);
        } catch (e2) {
          console.error("optimisticWrite rollback failed:", e2);
        }
        if (onError) onError(err);
        _toast(
          _cap(label) + " was NOT saved (" + err.message + "). " +
            "The screen has been reverted — please retry.",
          "error",
          8000
        );
        throw err;
      }
    });
  }

  /**
   * enqueue(key, job) — run a job through a room's FIFO chain.
   * Used by checkout so it waits for any pending add-service / add-payment
   * writes for the same room before finalizing the bill.
   */
  function enqueue(key, job) {
    return _enqueue(key, job);
  }

  /** pendingFor(key) — promise that settles when the key's queue drains. */
  function pendingFor(key) {
    return _queues.get(key) || Promise.resolve();
  }

  window.optimisticWrite = optimisticWrite;
  window.newOpId = newOpId;
  window.cibaraWrites = { enqueue: enqueue, pendingFor: pendingFor };
})();
