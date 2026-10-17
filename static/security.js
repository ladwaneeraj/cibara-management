/*
 * Cibara Comforts — client-side security helpers (classic UI).
 * -----------------------------------------------------------------------------
 * Loaded before every other classic script so `escHtml` is available to all of
 * them. Use it to escape ANY guest-controlled value (guest/customer name,
 * notes, remarks, free-text reasons, addresses, company names) before it goes
 * into an HTML string that is later assigned to innerHTML / insertAdjacentHTML.
 *
 *   el.innerHTML = `<div class="name">${escHtml(guest.name)}</div>`;
 *
 * Not needed for values set via textContent, for WhatsApp/plain-text messages,
 * or for URL components (use encodeURIComponent there). Several screens already
 * ship their own local esc()/_esc(); this is the shared one for the rest.
 */
(function () {
  'use strict';

  function escHtml(value) {
    if (value == null) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  window.escHtml = escHtml;
})();
