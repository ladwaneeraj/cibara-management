/*
 * Browser error monitor for the SPA — mirrors static/error-monitor.js.
 *
 * Captures window 'error' and 'unhandledrejection' (and React render errors via
 * ErrorBoundary) and forwards a small, PII-scrubbed report to
 * POST /api/v2/client-errors, which hands it to Sentry server-side. The Sentry
 * DSN never reaches the client, and the POST is same-origin so it works under
 * the app's CSP (connect-src 'self') with no CDN.
 *
 * This is telemetry, not a business write, so it deliberately bypasses
 * lib/api.api() (no auth, no X-Op-Id, no refresh-retry) and is fire-and-forget.
 * It must never throw. PII (Aadhaar / Indian mobile / e-mail) is scrubbed here
 * as well as on the server.
 */
const ENDPOINT = '/api/v2/client-errors';
const MAX_REPORTS = 25;
const APP_VERSION = '2.0.0';

let sent = 0;
const seen = new Set<string>();

const AADHAAR = /\b\d{4}\s?\d{4}\s?\d{4}\b/g;
const MOBILE = /\b[6-9]\d{9}\b/g;
const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;

function scrub(s: unknown): string {
  if (typeof s !== 'string') return '';
  return s.replace(AADHAAR, '[redacted]').replace(MOBILE, '[redacted]').replace(EMAIL, '[redacted]');
}

function stripQuery(u: string): string {
  try {
    return (u || '').split('?')[0];
  } catch {
    return '';
  }
}

export function reportError(
  kind: string,
  message: string,
  stack?: string,
  url?: string,
  line?: number | null,
  col?: number | null,
): void {
  try {
    if (sent >= MAX_REPORTS) return;
    const msg = scrub(message).slice(0, 2000);
    const key = `${kind}|${msg}|${line ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    sent += 1;

    const body = JSON.stringify({
      message: msg,
      kind: kind.slice(0, 64),
      stack: scrub(stack).slice(0, 8000),
      url: stripQuery(url || window.location.href).slice(0, 1000),
      line: line ?? null,
      col: col ?? null,
      appVersion: APP_VERSION,
    });

    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
    } else if (typeof fetch === 'function') {
      void fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
        credentials: 'same-origin',
      }).catch(() => {});
    }
  } catch {
    /* the reporter must never throw */
  }
}

let installed = false;

export function installErrorMonitor(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', (ev: ErrorEvent) => {
    if (ev?.message) {
      reportError('onerror', ev.message, ev.error?.stack, ev.filename, ev.lineno, ev.colno);
    }
  });

  window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
    const r = ev?.reason as { message?: string; stack?: string; toString?: () => string } | undefined;
    const msg = (r && (r.message || (r.toString && r.toString()))) || 'unhandledrejection';
    reportError('unhandledrejection', String(msg), r?.stack, window.location.href);
  });
}
