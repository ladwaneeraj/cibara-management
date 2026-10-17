/*
 * Cibara Comforts — step-up re-authentication prompt (classic UI).
 * -----------------------------------------------------------------------------
 * When a money-leaving action is blocked by the server with 428
 * {code:"step_up_required"}, the fetch wrapper in auth.js calls
 * window.CibaraStepUp.authorize(action, amount). This shows a small modal asking
 * the admin to RE-ENTER THEIR OWN PASSWORD (step-up re-auth — it confirms intent
 * and protects an unattended, signed-in session; it is NOT a second-person
 * approval). On success it returns a single-use token the wrapper replays as
 * X-Step-Up-Token; on cancel it returns null and the original block is surfaced.
 */
(function () {
  'use strict';

  var LABELS = {
    cancel_bill: 'Cancel this bill',
    credit_note: 'Issue this credit note',
    bad_debt: 'Write off as bad debt',
    writeoff: 'Write off this balance',
    discount: 'Apply this discount',
    refund: 'Process this refund',
  };

  var _overlay = null;
  var _resolve = null;
  var _ctx = null;

  function _inr(n) {
    n = Number(n) || 0;
    return n ? '₹' + n.toLocaleString('en-IN') : '';
  }

  function _build() {
    var o = document.createElement('div');
    o.id = 'cibara-stepup-overlay';
    o.style.cssText =
      'position:fixed;inset:0;z-index:100000;display:none;align-items:center;' +
      'justify-content:center;background:rgba(15,23,42,.55);';
    o.innerHTML =
      '<div role="dialog" aria-modal="true" style="background:#fff;border-radius:10px;' +
        'max-width:360px;width:92%;padding:20px;box-shadow:0 10px 40px rgba(0,0,0,.25);' +
        'font-family:system-ui,sans-serif;">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">' +
          '<span aria-hidden="true" style="font-size:1.2rem;">🔒</span>' +
          '<strong id="su-title" style="font-size:1.02rem;">Admin confirmation</strong></div>' +
        '<p id="su-msg" style="margin:.2rem 0 .8rem;color:#475569;font-size:.86rem;line-height:1.35;"></p>' +
        '<input id="su-pass" type="password" autocomplete="current-password" placeholder="Your password" ' +
          'style="width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #cbd5e1;' +
          'border-radius:7px;font-size:.92rem;" />' +
        '<div id="su-err" style="color:#e11d48;font-size:.78rem;min-height:1.1em;margin:.35rem 0 .2rem;"></div>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:.4rem;">' +
          '<button id="su-cancel" type="button" style="padding:8px 14px;border:1px solid #cbd5e1;' +
            'background:#fff;border-radius:7px;cursor:pointer;font-size:.86rem;">Cancel</button>' +
          '<button id="su-ok" type="button" style="padding:8px 16px;border:0;background:#1d4ed8;' +
            'color:#fff;border-radius:7px;cursor:pointer;font-size:.86rem;font-weight:600;">Confirm</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(o);
    o.querySelector('#su-cancel').addEventListener('click', function () { _close(null); });
    o.querySelector('#su-ok').addEventListener('click', _submit);
    o.querySelector('#su-pass').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') _submit();
      if (e.key === 'Escape') _close(null);
    });
    o.addEventListener('mousedown', function (e) { if (e.target === o) _close(null); });
    return o;
  }

  function _submit() {
    var pass = _overlay.querySelector('#su-pass').value;
    var err = _overlay.querySelector('#su-err');
    var ok = _overlay.querySelector('#su-ok');
    if (!pass) { err.textContent = 'Enter your password.'; return; }
    ok.disabled = true;
    ok.textContent = 'Checking…';
    err.textContent = '';
    // Uses the wrapped window.fetch (attaches the session JWT). /api/v2/authorize
    // is not a gated route, so this never re-enters the step-up flow.
    fetch('/api/v2/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ action: _ctx.action, amount: _ctx.amount || 0, password: pass }),
    }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, j: j }; });
    }).then(function (res) {
      if (res.status === 200 && res.j && res.j.token) { _close(res.j.token); return; }
      err.textContent = (res.j && res.j.message) || 'Confirmation failed.';
      ok.disabled = false;
      ok.textContent = 'Confirm';
      var p = _overlay.querySelector('#su-pass');
      p.focus();
      p.select();
    }).catch(function () {
      err.textContent = 'Could not reach the server. Try again.';
      ok.disabled = false;
      ok.textContent = 'Confirm';
    });
  }

  function _close(token) {
    if (_overlay) _overlay.style.display = 'none';
    var r = _resolve;
    _resolve = null;
    _ctx = null;
    if (r) r(token);
  }

  // Returns a Promise<token|null>. null = the admin cancelled.
  function authorize(action, amount) {
    if (!_overlay) _overlay = _build();
    // If a prompt is already open, cancel the previous waiter.
    if (_resolve) { var prev = _resolve; _resolve = null; prev(null); }
    _ctx = { action: action, amount: Number(amount) || 0 };
    var title = LABELS[action] || 'Admin confirmation';
    var amt = _inr(_ctx.amount);
    _overlay.querySelector('#su-title').textContent = title + '?';
    _overlay.querySelector('#su-msg').textContent =
      'Re-enter your password to confirm' + (amt ? ' ' + amt : '') +
      '. Money-leaving actions need admin confirmation.';
    var pass = _overlay.querySelector('#su-pass');
    pass.value = '';
    _overlay.querySelector('#su-err').textContent = '';
    var ok = _overlay.querySelector('#su-ok');
    ok.disabled = false;
    ok.textContent = 'Confirm';
    _overlay.style.display = 'flex';
    setTimeout(function () { pass.focus(); }, 30);
    return new Promise(function (resolve) { _resolve = resolve; });
  }

  window.CibaraStepUp = { authorize: authorize };
})();
