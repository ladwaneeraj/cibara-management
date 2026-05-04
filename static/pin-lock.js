/* DEPRECATED — PIN lock screen has been replaced by user login (auth.js).
 * This file is kept as a no-op shim so any cached <script> reference
 * (e.g. an old service worker bundle) doesn't 404 and doesn't run the
 * legacy lock-screen DOM manipulation. The new auth flow is bootstrapped
 * from templates/index.html via /static/auth.js.
 */
(function () {
  "use strict";
  // Intentionally empty.
})();
