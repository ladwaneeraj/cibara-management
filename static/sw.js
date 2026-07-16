/*
 * Cibara Comforts — Service Worker
 * -----------------------------------------------------------------------------
 * Deliberately conservative. This is an auth-gated app that handles bookings,
 * billing and settlements, so the SW must NEVER serve stale authenticated data
 * or interfere with the Firebase auth flow.
 *
 * Strategy:
 *   - Only same-origin GET requests are considered.
 *   - Navigations (HTML): network-first, fall back to a small offline page.
 *     Online users therefore always get fresh, correctly-authenticated HTML.
 *   - /static/ assets: stale-while-revalidate (they are versioned via ?v=).
 *   - Everything else (API responses, /uploads/, /firebase-config.js, POSTs,
 *     cross-origin Firebase calls): passed straight through to the network,
 *     never cached.
 *
 * Bump CACHE_VERSION whenever this file or the precache list changes so old
 * caches are cleaned up on activate.
 */
const CACHE_VERSION = 'v1';
const CACHE = `cibara-static-${CACHE_VERSION}`;
const OFFLINE_URL = '/static/offline.html';

const PRECACHE = [
  OFFLINE_URL,
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle same-origin GETs. Everything else goes to the network as-is.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // App navigations: network-first, offline page as fallback.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match(OFFLINE_URL))
    );
    return;
  }

  // Versioned static assets: stale-while-revalidate.
  if (url.pathname.startsWith('/static/')) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const network = fetch(req)
          .then((res) => {
            if (res && res.status === 200 && res.type === 'basic') {
              cache.put(req, res.clone());
            }
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // Uploads, API endpoints, firebase-config, etc: network only. No caching.
});
