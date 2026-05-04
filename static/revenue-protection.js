/* DEPRECATED — frontend revenue masking has been replaced by role-based
 * visibility. Hardcoded PASSWORD removed (was a frontend-only check that
 * could be bypassed via dev tools). Admin role sees revenue directly;
 * other roles never see the figures because the elements are hidden via
 * data-perm="revenue.view" in markup, enforced by static/auth.js.
 *
 * No-op shim kept so cached references don't 404.
 */
(function () {
  "use strict";
})();
