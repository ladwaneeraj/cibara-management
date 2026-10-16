/*
 * Cibara Comforts — classic-UI browser error monitor.
 * -----------------------------------------------------------------------------
 * Captures window 'error' and 'unhandledrejection' and forwards a small,
 * PII-scrubbed report to POST /api/v2/client-errors, which hands it to Sentry
 * server-side (so the Sentry DSN is never on the client, and this works with no
 * CDN script under any CSP — the POST is same-origin).
 *
 * Loaded first (before every other script) so it sees their init errors too.
 * It must never throw and never recurse, so everything is wrapped and failures
 * are swallowed. PII is scrubbed here as well as on the server (defence in
 * depth): Aadhaar, Indian mobile numbers and e-mail addresses are redacted and
 * URL query strings are dropped.
 */
(function () {
  'use strict';

  var ENDPOINT = '/api/v2/client-errors';
  var MAX_REPORTS = 25; // cap per page load so an error loop can't storm the API
  var sent = 0;
  var seen = Object.create(null);

  var AADHAAR = /\b\d{4}\s?\d{4}\s?\d{4}\b/g;
  var MOBILE = /\b[6-9]\d{9}\b/g;
  var EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;

  function scrub(s) {
    if (typeof s !== 'string') return '';
    return s.replace(AADHAAR, '[redacted]').replace(MOBILE, '[redacted]').replace(EMAIL, '[redacted]');
  }

  function stripQuery(u) {
    try {
      return String(u || '').split('?')[0];
    } catch (e) {
      return '';
    }
  }

  function appVersion() {
    try {
      return (window.__initialUIConfig && window.__initialUIConfig.version) || '';
    } catch (e) {
      return '';
    }
  }

  function report(kind, message, stack, url, line, col) {
    try {
      if (sent >= MAX_REPORTS) return;
      var msg = scrub(message || '');
      var key = kind + '|' + msg + '|' + (line || '');
      if (seen[key]) return;
      seen[key] = true;
      sent += 1;

      var body = JSON.stringify({
        message: msg.slice(0, 2000),
        kind: String(kind || '').slice(0, 64),
        stack: scrub(stack || '').slice(0, 8000),
        url: stripQuery(url || (location && location.href)).slice(0, 1000),
        line: line || null,
        col: col || null,
        appVersion: String(appVersion()).slice(0, 64),
      });

      // sendBeacon survives a navigation that an error may trigger; fall back
      // to keepalive fetch. Both are fire-and-forget.
      if (navigator && typeof navigator.sendBeacon === 'function') {
        navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
      } else if (typeof fetch === 'function') {
        fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body,
          keepalive: true,
          credentials: 'same-origin',
        }).catch(function () {});
      }
    } catch (e) {
      /* the reporter must never throw */
    }
  }

  window.addEventListener('error', function (ev) {
    // Resource-load failures (img/script 404) fire 'error' with no message;
    // only report real script errors.
    if (ev && ev.message) {
      report('onerror', ev.message, ev.error && ev.error.stack, ev.filename, ev.lineno, ev.colno);
    }
  });

  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev && ev.reason;
    var msg = (r && (r.message || (r.toString && r.toString()))) || 'unhandledrejection';
    report('unhandledrejection', msg, r && r.stack, location && location.href);
  });
})();
