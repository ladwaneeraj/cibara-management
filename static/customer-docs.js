/**
 * customer-docs.js  (v6)
 *
 * Check-in enhancements:
 *   1.  Mobile partial-input suggestions with stay-count badge
 *   2.  Name autocomplete with stay-count badge
 *   3.  Name mismatch warning
 *   4.  Collapsible address field
 *   5.  ID indicator dot (green=has docs, yellow=no docs, grey=unknown)
 *   6.  Camera always enabled — separate modal, bottom-sheet on mobile
 *   7.  Multiple photos (up to 3) — thumbnail strip; deferred cloud upload
 *   8.  Photo lightbox for existing + newly-captured docs
 *   9.  Flagged customer warning
 *  10.  Checkout modal: ID doc viewer in header
 */

const MAX_DOC_PHOTOS = 4;
// Single source of truth for the per-guest photo cap. register.js reads this
// off window so the Register viewer can never disagree with the check-in /
// checkout camera about how many photos a guest may have (the old mismatch —
// 4 here, 3 in register.js — made a 4-photo guest show "3 of 3 photos").
window.MAX_DOC_PHOTOS = MAX_DOC_PHOTOS;

// ── Module state ─────────────────────────────────────────────────────────────
let _currentCheckinCustomer = null;
let _docStream               = null;
let _docCapturedBlobs        = [];   // [{blob, url}, …] — committed on check-in submit
let _mobileDebounceTimer     = null;
let _nameDebounceTimer       = null;
let _viewerCurrentIdx        = 0;
let _viewerUrls              = [];

// ─────────────────────────────────────────────────────────────────────────────
// Secure ID images. ID photos are private: their links point at
// /api/v2/customers/<mobile>/id-docs/<id>/image and only work with the
// signed-in session, so they are fetched with apiFetch and shown as blob: URLs.
// `remember(customer)` keeps who-captured-what for the viewer caption.
// ─────────────────────────────────────────────────────────────────────────────
window.CibaraSecureImg = (function () {
  const cache = new Map();
  const meta  = {};
  // 1x1 transparent GIF. Secure images can't be set as a plain `src` (they
  // need an authenticated fetch), so the <img> sits src-less while that fetch
  // is in flight — and a src-less <img> with an `alt` renders the browser's
  // broken-image glyph. Parking this transparent pixel on it keeps the slot
  // clean and lets the CSS skeleton/placeholder below show through instead.
  const BLANK_PX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  // Inject the skeleton / error styles once. Self-contained here so the fix
  // ships with this file (cache-busted via asset_url) — no separate CSS edit.
  (function injectStyle() {
    if (typeof document === 'undefined' || document.getElementById('secimg-style')) return;
    const st = document.createElement('style');
    st.id = 'secimg-style';
    st.textContent =
      '@keyframes secimg-shimmer{0%{background-position:-160px 0}100%{background-position:160px 0}}' +
      'img.secimg-loading{background-color:#eef2f7;' +
      'background-image:linear-gradient(90deg,#eef2f7 0%,#f6f9fc 50%,#eef2f7 100%);' +
      'background-size:320px 100%;animation:secimg-shimmer 1.1s linear infinite}' +
      'img.secimg-error{animation:none;background:#f3f4f6 center/44% no-repeat ' +
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%239aa3af' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='5' width='18' height='14' rx='2'/%3E%3Ccircle cx='8.5' cy='11' r='2'/%3E%3Cpath d='M13 10h5M13 14h5M5.5 16c.6-1.6 2-2.4 3-2.4s2.4.8 3 2.4'/%3E%3C/svg%3E\")}";
    (document.head || document.documentElement).appendChild(st);
  })();

  const isSecure = (u) => typeof u === 'string' && u.startsWith('/api/v2/customers/');
  // Default variant is the cheap "thumb" (plain resize on the server — no
  // watermark re-encode, no Firestore view write, no audit entry). The full
  // watermarked "view" and the "original" download are CPU- and write-heavy,
  // so every caller that actually opens/enlarges a doc passes them explicitly
  // (open() and setViewerPhoto() do). An omitted variant must never land on
  // the expensive path.
  function src(url, variant) {
    if (!isSecure(url)) return Promise.resolve(url);
    const key = url + '|' + (variant || 'thumb');
    if (!cache.has(key)) {
      const p = apiFetch(url + '?variant=' + (variant || 'thumb')).then(async (r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return URL.createObjectURL(await r.blob());
      });
      p.catch(() => cache.delete(key));
      cache.set(key, p);
    }
    return cache.get(key);
  }
  function apply(img, url, variant) {
    if (!isSecure(url)) { img.src = url; return; }
    img.dataset.secureSrc = url;
    // Skeleton immediately — no broken-image flash while the authed fetch runs.
    img.classList.remove('secimg-error');
    img.classList.add('secimg-loading');
    if (!img.getAttribute('src')) img.src = BLANK_PX;
    src(url, variant).then((u) => {
      if (img.dataset.secureSrc !== url) return;   // a newer apply() superseded us
      img.src = u;
      img.classList.remove('secimg-loading', 'secimg-error');
    }).catch(() => {
      if (img.dataset.secureSrc !== url) return;
      img.src = BLANK_PX;                           // keep the pixel, never the glyph
      img.classList.remove('secimg-loading');
      img.classList.add('secimg-error');
      img.alt = 'Document unavailable';
    });
  }
  function open(url) {
    if (!isSecure(url)) { window.open(url, '_blank'); return; }
    const w = window.open('', '_blank');
    src(url, 'view').then((u) => { if (w) w.location.href = u; }).catch(() => { if (w) w.close(); });
  }
  function remember(customer) {
    ((customer && customer.id_doc_meta) || []).forEach((m) => { meta[m.url] = m; });
  }
  function caption(url) {
    const m = meta[url];
    if (!m) return '';
    let when = '';
    try {
      when = new Date(m.captured_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (_) {}
    return m.legacy ? `Older upload${when ? ' · ' + when : ''}`
                    : `Captured by ${m.captured_by || '—'}${when ? ' · ' + when : ''}`;
  }
  return { isSecure, src, apply, open, remember, caption };
})();

// Check-in and checkout keep SEPARATE trays. Sharing one array let a checkout
// wipe photos captured in an open check-in, or save one guest's photo to
// another guest.
let _checkoutTray = [];

// Fix 14: upload re-entrancy guards — prevents double-submit on rapid clicks
let _checkinUploadLock  = false;
let _checkoutUploadLock = false;

// Auto-scan state
let _scanTimer        = null;
let _scanCanvas       = null;
let _scanCtx          = null;
let _lastFramePixels  = null;
let _stableFrameCount = 0;
let _autoScanActive   = false;
let _scanLineY        = 0;       // for the sweep animation
let _docType          = 'card';  // 'card' | 'page'

const STABLE_NEEDED    = 5;   // ~1s at 200ms — relaxed for mobile
const SCAN_INTERVAL_MS = 200;

// ─────────────────────────────────────────────────────────────────────────────
// Public API — called by script.js check-in submit
// ─────────────────────────────────────────────────────────────────────────────

window.uploadPendingDocIfAny = async function (mobile, room) {
  if (!_docCapturedBlobs.length) return true;
  const digits = (mobile || '').replace(/\D/g, '');
  if (digits.length !== 10) {
    _notify('ID photo not saved — the mobile number must have 10 digits', 'error');
    return false;
  }
  // Take this guest's photos out of the tray NOW. Clearing it only after the
  // uploads finished also threw away photos already taken for the next guest.
  const items = _docCapturedBlobs.splice(0, _docCapturedBlobs.length);
  try { renderThumbStrip(); _updateAddMoreBtn(); } catch (_) {}
  try {
    // Parallel uploads are safe now: the server appends URLs with an atomic
    // ArrayUnion (create/AlreadyExists handles the brand-new-customer race),
    // so concurrent photos can no longer drop each other's URL. Wall-clock
    // for a multi-photo check-in is max(photo) instead of sum(photos).
    const results = await Promise.all(items.map(async (item, i) => {
      const ok = await _postIdDoc(digits, item.blob, 'checkin', room, i);
      if (ok) URL.revokeObjectURL(item.url);
      return ok ? null : item;
    }));
    const failed = results.filter(Boolean);
    if (!failed.length) return true;
    _retryIdDocs(digits, room, failed, 1);
    return false;
  } catch (err) {
    _notify('ID document upload error: ' + err.message, 'error');
    _retryIdDocs(digits, room, items, 1);
    return false;
  }
};

async function _postIdDoc(mobile, blob, context, room, i) {
  try {
    const form = new FormData();
    form.append('mobile',   mobile);
    form.append('document', blob, `doc_${Date.now()}_${i || 0}.jpg`);
    form.append('context',  context);
    if (room) form.append('room', String(room));
    const res  = await apiFetch('/upload_customer_document', { method: 'POST', body: form });
    const data = await res.json();
    return !!data.success;
  } catch (_) { return false; }
}

// A failed ID upload is retried in the background (3 s, 10 s, 30 s) so a
// moment of bad Wi-Fi no longer loses the guest's Aadhaar.
function _retryIdDocs(mobile, room, items, attempt) {
  if (attempt > 3) {
    _notify(`ID photo for …${mobile.slice(-4)} could not be saved. Add it again from the guest's documents.`, 'error');
    return;
  }
  setTimeout(async () => {
    const still = [];
    for (const item of items) {
      if (await _postIdDoc(mobile, item.blob, 'checkin', room)) URL.revokeObjectURL(item.url);
      else still.push(item);
    }
    if (!still.length) _notify(`ID photo for …${mobile.slice(-4)} saved after retry ✓`, 'success');
    else _retryIdDocs(mobile, room, still, attempt + 1);
  }, [3000, 10000, 30000][attempt - 1]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API — called by script.js when checkout modal opens
// ─────────────────────────────────────────────────────────────────────────────

window.populateCheckoutDocView = async function (mobile) {
  const btn = document.getElementById('checkout-doc-view-btn');
  if (!btn) return;
  btn.style.display = 'none';
  btn._docUrls = [];
  btn._mobile  = '';

  const digits = (mobile || '').replace(/\D/g, '');
  if (digits.length !== 10) return;

  try {
    const res  = await apiFetch(`/get_customer/${digits}`);
    const data = await res.json();
    if (data.success && data.customer) {
      window.CibaraSecureImg.remember(data.customer);
      const urls = data.customer.id_doc_urls || [];
      if (urls.length > 0) {
        btn._docUrls      = urls;
        btn._mobile       = digits;
        btn.style.display = 'inline-flex';
        btn.title         = `View ${urls.length} ID document${urls.length !== 1 ? 's' : ''}`;
      }
    }
  } catch (_) {}
};

// ─────────────────────────────────────────────────────────────────────────────
// Public API — checkout modal document upload
// ─────────────────────────────────────────────────────────────────────────────

let _checkoutMobile = '';
// True once the checkout upload button + file input have been wired up for
// _checkoutMobile. Guards against re-wiring (and wiping staged photos) on
// every background refresh - see initCheckoutDocAttach below.
let _checkoutDocWired = false;
// 'checkin' = normal flow (upload on submit), 'checkout' = upload immediately on Done
let _docCameraContext = 'checkin';

window.initCheckoutDocAttach = function(mobile) {
  const digits = (mobile || '').replace(/\D/g, '');

  // updateCheckoutModal() re-runs on EVERY background fetchData() refresh
  // while the checkout modal is open (it re-syncs the balance). This
  // function used to unconditionally discard the pending photos and
  // re-clone the buttons, so any refresh landing between "pick a photo"
  // and "Save to guest" silently threw the operator's photos away - the
  // upload option looked broken, especially for managers, who sit in this
  // modal adding services and taking payments (each of which triggers a
  // refresh) before saving the ID.
  //
  // Only reset when this is a genuinely NEW guest. Re-syncs for the same
  // guest are a no-op: the staged photos and their listeners survive.
  if (_checkoutDocWired && _checkoutMobile === digits) {
    _renderCheckoutPendingStrip();
    return;
  }

  // Different guest (or first open) - discard whatever was staged before.
  _discardCheckoutPending();
  _checkoutMobile = digits;
  _checkoutDocWired = true;

  // Re-wire the header camera button each time the modal opens.
  // Clone to strip any previously attached listeners.
  const uploadBtn = document.getElementById('checkout-upload-id-btn');
  const newBtn    = uploadBtn?.cloneNode(true);
  if (uploadBtn && newBtn) uploadBtn.parentNode.replaceChild(newBtn, uploadBtn);

  // Re-wire the hidden file input the same way.
  const fileInput = document.getElementById('checkout-doc-file-input');
  const newInput  = fileInput?.cloneNode(true);
  if (fileInput && newInput) fileInput.parentNode.replaceChild(newInput, fileInput);

  // Button click → trigger the file picker (no `capture` attribute, so the
  // OS shows a full sheet on mobile: Camera, Gallery, Files, etc.)
  newBtn?.addEventListener('click', () => {
    if (!_checkoutMobile) { _notify('No mobile number for this guest', 'warning'); return; }
    document.getElementById('checkout-doc-file-input')?.click();
  });

  // File(s) selected → add to pending strip (up to MAX_DOC_PHOTOS total)
  newInput?.addEventListener('change', async function() {
    const files = Array.from(this.files || []);
    this.value = '';                       // allow re-selecting the same file
    if (!files.length) return;

    let added = 0, blocked = false;
    for (const picked of files) {
      if (_checkoutTray.length >= MAX_DOC_PHOTOS) { blocked = true; break; }
      // Auto-detect → deskew → magic colour, headless (NO crop editor) — the
      // same one-tap treatment the Register upload gives a gallery photo.
      const scanned = await _autoScanIdDoc(picked);
      if (!scanned) continue;              // never null; guard kept defensively
      const url = URL.createObjectURL(scanned);
      _checkoutTray.push({ blob: scanned, url, scanned: scanned !== picked });
      added++;
      _renderCheckoutPendingStrip();
    }

    if (added === 0 && blocked) {
      _notify(`Maximum ${MAX_DOC_PHOTOS} photos already selected`, 'warning');
    } else if (blocked) {
      _notify(`Maximum ${MAX_DOC_PHOTOS} photos reached — only ${added} added`, 'warning');
    }
    _renderCheckoutPendingStrip();
  });
};

/**
 * Resize, enhance, and compress an image Blob to JPEG.
 * Caps the longest side at MAX_SIDE px.
 *
 * Enhancement is the colour-preserving sharpen + mild contrast from
 * `_applyScannedLook` — NOT the old grayscale pass, which (as its own former
 * comment admitted) greyed out and muddied small print and made a colour
 * Aadhaar look like a bad photocopy. This is only the fallback for when the
 * document scanner (magic colour) is unavailable; the scanner's output is
 * never passed through here.
 *
 * Falls back to the original Blob on any error.
 */
async function _compressImage(blob) {
  const MAX_SIDE = 1600;   // a touch larger so a 10-digit ID number stays crisp
  const QUALITY  = 0.9;
  return new Promise((resolve) => {
    const img    = new Image();
    const tmpUrl = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(tmpUrl);
      let { width, height } = img;
      if (width > MAX_SIDE || height > MAX_SIDE) {
        if (width >= height) {
          height = Math.round(height * MAX_SIDE / width);
          width  = MAX_SIDE;
        } else {
          width  = Math.round(width * MAX_SIDE / height);
          height = MAX_SIDE;
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width  = width;
      canvas.height = height;
      const cctx = canvas.getContext('2d');
      cctx.drawImage(img, 0, 0, width, height);

      // Colour-preserving crisp-up (sharpen + mild contrast), not grayscale.
      try { _applyScannedLook(cctx, width, height); } catch (_) {}

      canvas.toBlob(
        (compressed) => resolve(compressed || blob),
        'image/jpeg',
        QUALITY,
      );
    };
    img.onerror = () => { URL.revokeObjectURL(tmpUrl); resolve(blob); };
    img.src = tmpUrl;
  });
}

async function _uploadCheckoutDoc(file, alreadyProcessed) {
  // The scanner already cropped, deskewed, enhanced and sized the image, so
  // only compress (and apply the legacy grayscale look) when it did NOT run —
  // otherwise we would grayscale away the magic-colour output.
  const compressed = alreadyProcessed ? file : await _compressImage(file);
  const form = new FormData();
  form.append('mobile',   _checkoutMobile);
  form.append('document', compressed, `checkout_doc_${Date.now()}.jpg`);
  form.append('context',  'checkout');

  try {
    const res  = await apiFetch('/upload_customer_document', { method: 'POST', body: form });
    const data = await res.json();
    if (!data.success) {
      _notify('Upload failed: ' + data.message, 'error');
      return false;
    }
    return true;
  } catch (err) {
    _notify('Upload error: ' + err.message, 'error');
    return false;
  }
}

/** Render (or refresh) the pending-upload strip in the checkout modal. */
function _renderCheckoutPendingStrip() {
  const strip    = document.getElementById('checkout-pending-docs');
  const thumbEl  = document.getElementById('checkout-pending-thumbs');
  const countBadge = document.getElementById('checkout-pending-count');
  if (!strip || !thumbEl) return;

  if (!_checkoutTray.length) {
    strip.style.display = 'none';
    thumbEl.innerHTML   = '';
    return;
  }

  // Update count badge
  const n = _checkoutTray.length;
  if (countBadge) countBadge.textContent = `${n} photo${n !== 1 ? 's' : ''}`;

  thumbEl.innerHTML = '';
  _checkoutTray.forEach((item, i) => {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position: relative; flex-shrink: 0;';

    const img = document.createElement('img');
    img.src   = item.url;
    img.alt   = `Doc ${i + 1}`;
    img.style.cssText = `
      width: 58px; height: 58px; object-fit: cover; border-radius: 9px;
      border: 2px solid #c7d2fe; cursor: pointer; display: block;
      box-shadow: 0 2px 8px rgba(67,56,202,0.12);
      transition: border-color 0.15s, transform 0.15s, box-shadow 0.15s;`;
    img.title = 'Click to preview';
    img.addEventListener('mouseover', () => { img.style.borderColor = '#4338ca'; img.style.transform = 'scale(1.05)'; img.style.boxShadow = '0 4px 14px rgba(67,56,202,0.25)'; });
    img.addEventListener('mouseout',  () => { img.style.borderColor = '#c7d2fe'; img.style.transform = ''; img.style.boxShadow = '0 2px 8px rgba(67,56,202,0.12)'; });
    img.addEventListener('click', () => openPhotoViewer(_checkoutTray.map(b => b.url), i, ''));

    // Remove button
    const del = document.createElement('button');
    del.type      = 'button';
    del.innerHTML = '<i class="fas fa-times"></i>';
    del.style.cssText = `
      position: absolute; top: -5px; right: -5px;
      width: 17px; height: 17px; border-radius: 50%; border: 2px solid #f0f4ff;
      background: #6366f1; color: #fff; font-size: 0.5rem; line-height: 1;
      cursor: pointer; padding: 0; display: flex; align-items: center; justify-content: center;
      transition: background 0.15s; box-shadow: 0 1px 4px rgba(0,0,0,0.2);`;
    del.title = 'Remove';
    del.addEventListener('mouseover', () => { del.style.background = '#ef4444'; });
    del.addEventListener('mouseout',  () => { del.style.background = '#6366f1'; });
    del.addEventListener('click', () => {
      URL.revokeObjectURL(item.url);
      _checkoutTray.splice(i, 1);
      _renderCheckoutPendingStrip();
    });

    wrapper.appendChild(img);
    wrapper.appendChild(del);
    thumbEl.appendChild(wrapper);
  });

  strip.style.display = 'block';
}

/** Upload all pending checkout blobs sequentially then clear the strip. */
async function _commitCheckoutPending() {
  // Fix 14: prevent re-entry on rapid clicks
  if (_checkoutUploadLock) return;
  if (!_checkoutMobile) { _notify('No mobile linked — cannot save document', 'error'); return; }
  if (!_checkoutTray.length) return;

  _checkoutUploadLock = true;
  const uploadBtn = document.getElementById('checkout-pending-upload-btn');
  if (uploadBtn) { uploadBtn.disabled = true; uploadBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…'; }

  try {
    const items = [..._checkoutTray];
    // Upload all files in parallel — the Firestore transaction inside
    // upload_document uses ArrayUnion + optimistic retry, so concurrent
    // writes to the same customer doc are safe and much faster than sequential.
    const results = await Promise.all(items.map(item => _uploadCheckoutDoc(item.blob, item.scanned)));
    const allOk   = results.every(Boolean);

    // Revoke object URLs for successfully uploaded items
    items.forEach((item, i) => { if (results[i]) URL.revokeObjectURL(item.url); });

    // Keep only the photos that failed, so a retry never re-uploads a success.
    _checkoutTray = items.filter((_, i) => !results[i]);
    if (allOk) {
      _renderCheckoutPendingStrip();
      _notify('Documents saved to guest record ✓', 'success');
      if (typeof window.populateCheckoutDocView === 'function') {
        window.populateCheckoutDocView(_checkoutMobile);
      }
    }
  } finally {
    _checkoutUploadLock = false;
    if (uploadBtn) { uploadBtn.disabled = false; uploadBtn.innerHTML = '<i class="fas fa-cloud-upload-alt"></i> Save to guest'; }
  }
}

/** End the checkout staging session (modal closed): drop staged photos and
 *  un-arm the wiring guard so the next open re-binds cleanly. */
function _endCheckoutDocSession() {
  _discardCheckoutPending();
  _checkoutDocWired = false;
  _checkoutMobile   = '';
}

/** Discard all pending checkout blobs without uploading. */
function _discardCheckoutPending() {
  _checkoutTray.forEach(item => URL.revokeObjectURL(item.url));
  _checkoutTray = [];
  _renderCheckoutPendingStrip();
}

// ─────────────────────────────────────────────────────────────────────────────
// 1.  Mobile partial-input lookup
// ─────────────────────────────────────────────────────────────────────────────

function initMobileLookup() {
  const mobileInput = document.getElementById('guest-mobile');
  if (!mobileInput) return;

  mobileInput.addEventListener('input', function () {
    clearTimeout(_mobileDebounceTimer);
    const digits = this.value.replace(/\D/g, '');

    if (digits.length === 0) {
      hideMobileSuggestions();
      _currentCheckinCustomer = null;
      _setIndicator('grey');
      clearNameMismatch();
      return;
    }

    if (digits.length < 4) { hideMobileSuggestions(); return; }

    _mobileDebounceTimer = setTimeout(async () => {
      if (digits.length >= 10) {
        hideMobileSuggestions();
        await lookupAndFillCustomer(digits.slice(0, 10));
      } else {
        fetchMobileSuggestions(digits);
      }
    }, 180);
  });

  document.addEventListener('click', e => {
    const inp = document.getElementById('guest-mobile');
    const sug = document.getElementById('mobile-suggestions');
    if (inp && sug && !inp.contains(e.target) && !sug.contains(e.target)) hideMobileSuggestions();
  });
}

async function fetchMobileSuggestions(prefix) {
  try {
    const res  = await apiFetch('/search_customers_mobile', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix }),
    });
    const data = await res.json();
    renderMobileSuggestions(data.success ? (data.customers || []) : []);
  } catch (err) { console.error('[customer-docs] Mobile suggest error:', err); }
}

function renderMobileSuggestions(customers) {
  const sug = document.getElementById('mobile-suggestions');
  if (!sug) return;
  if (!customers.length) { hideMobileSuggestions(); return; }

  sug.innerHTML = '';
  customers.slice(0, 6).forEach(c => {
    const item = document.createElement('div');
    item.className = 'ms-row';

    // Left: name + a compact sub-line (mobile · stays · last visit).
    const stays = c.total_stays || 0;
    const sub = [c.mobile];
    if (stays > 0)        sub.push(`${stays}× stay${stays > 1 ? 's' : ''}`);
    if (c.last_stay_date) sub.push(_fmtDate(c.last_stay_date));

    // Right side: two compact stat cells — last paid (most recent stay
    // total) and total spent (lifetime). Each shows a muted "—" when it
    // can't be resolved, so the columns always line up cleanly.
    const lastPaid = Number(c.last_stay_amount || 0);
    const lifetime = Number(c.total_spent || 0);
    const cell = (val, lbl) => val > 0
      ? `<div class="ms-stat"><div class="ms-stat-val">₹${val.toLocaleString('en-IN')}</div><div class="ms-stat-lbl">${lbl}</div></div>`
      : `<div class="ms-stat"><div class="ms-stat-empty">—</div><div class="ms-stat-lbl">${lbl}</div></div>`;

    item.innerHTML = `
      <div class="ms-main">
        <div class="ms-name">${escHtml(_fmtName(c.name) || '(No name)')}</div>
        <div class="ms-sub">${sub.join(' · ')}</div>
      </div>
      <div class="ms-stats">${cell(lastPaid, 'last paid')}${cell(lifetime, 'total spent')}</div>`;

    item.addEventListener('click', () => {
      const mi = document.getElementById('guest-mobile');
      if (mi) mi.value = c.mobile;
      hideMobileSuggestions();
      lookupAndFillCustomer(c.mobile);
    });
    sug.appendChild(item);
  });
  sug.style.display = 'block';
}

function hideMobileSuggestions() {
  const sug = document.getElementById('mobile-suggestions');
  if (sug) sug.style.display = 'none';
}

async function lookupAndFillCustomer(mobile) {
  try {
    const res  = await apiFetch(`/get_customer/${mobile}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (data.success && data.customer) {
      window.CibaraSecureImg.remember(data.customer);
      _currentCheckinCustomer = data.customer;
      autoFillFromCustomer(data.customer);
      _applyIndicator(data.customer);
      _applyDocViewBtn(data.customer);
      _showCheckinStoredDocs(data.customer);
      _applyFlagAlert(data.customer);
      _applyPendingSettlementAlert(data.customer);
      _applyWantsBillNote(data.customer);
      _applyCheckinGstCard(data.customer);
    } else {
      _currentCheckinCustomer = null;
      clearNameMismatch();
      hideDocViewBtn();
      _setIndicator('yellow');
      _hideCheckinStoredDocs();
      _hideFlagAlert();
      _hidePendingSettlementAlert();
      _hideWantsBillNote();
      _hideCheckinGstCard();
    }
  } catch (err) { console.error('[customer-docs] Mobile lookup error:', err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Flag alert helpers
// ─────────────────────────────────────────────────────────────────────────────

function _applyFlagAlert(customer) {
  const alertEl  = document.getElementById('checkin-flag-alert');
  const notesEl  = document.getElementById('checkin-flag-alert-notes');
  const dateEl   = document.getElementById('checkin-flag-alert-date');
  if (!alertEl) return;

  if (customer && customer.is_flagged) {
    const notes = (customer.flag_notes || '').trim();
    if (notesEl) notesEl.textContent = notes || 'No details provided.';

    // Format flagged_at date for display
    if (dateEl) {
      const raw = customer.flagged_at || '';
      if (raw) {
        try {
          const d = new Date(raw);
          const day   = String(d.getDate()).padStart(2, '0');
          const month = d.toLocaleString('en-IN', { month: 'short' });
          const year  = d.getFullYear();
          dateEl.textContent = `Flagged on: ${day} ${month} ${year}`;
        } catch (e) {
          dateEl.textContent = '';
        }
      } else {
        dateEl.textContent = '';
      }
    }

    alertEl.style.display = 'block';
  } else {
    alertEl.style.display = 'none';
    if (notesEl) notesEl.textContent = '';
    if (dateEl)  dateEl.textContent  = '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STICKY GUEST PREFERENCES — check-in surfacing
// ─────────────────────────────────────────────────────────────────────────────
// One note here, and only a note: this guest asked for a bill on a previous
// stay, so this one produces an invoice whatever they pay with. There is
// nothing to decide, but the operator should not be surprised at checkout.
//
// The GST question deliberately does NOT live here. It moved to the checkout
// modal (see _checkoutGst in script.js), where the amount is final and the
// bill is actually being made. Asking at check-in meant the answer had to be
// parked on the room document for the length of the stay, which is both a
// stale-data hazard and the wrong moment to ask.

function _applyWantsBillNote(customer) {
  const el   = document.getElementById('checkin-wants-bill-note');
  const text = document.getElementById('checkin-wants-bill-text');
  if (!el) return;
  if (customer && customer.wants_bill) {
    if (text) text.textContent = 'Bill will be generated for this stay.';
    el.style.display = 'flex';
  } else {
    _hideWantsBillNote();
  }
}

function _hideWantsBillNote() {
  const el = document.getElementById('checkin-wants-bill-note');
  if (el) el.style.display = 'none';
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPANY BILLING (GST) — check-in offer for a returning B2B guest
// ─────────────────────────────────────────────────────────────────────────────
// Shown only when the mobile lookup finds gst_profile saved from a previous
// B2B invoice. One tap answers "same company again?" — the details are never
// retyped. The answer rides the /checkin payload (script.js reads it via
// window.getCheckinGstProfile), is re-validated server-side, and stamps the
// stay; the checkout modal's Company billing card then opens pre-selected to
// "Applied" with a final chance to flip to Personal before the invoice is
// made. Default is PERSONAL — silently inheriting a company GSTIN is the
// GSTR-1 error this card exists to prevent.

const _checkinGst = {
  profile: null,   // stored profile from the customer doc, or null
  applied: false,  // operator picked "Bill to this company"
};

function _applyCheckinGstCard(customer) {
  const p = customer && customer.gst_profile;
  if (!p || !p.gstin) { _hideCheckinGstCard(); return; }
  // The mobile lookup re-fires on every input event in the mobile field
  // (debounced), and each re-fire lands here. If this is the SAME company
  // already on the card, PRESERVE the operator's current answer — blindly
  // resetting flipped a chosen "Company" back to Personal microseconds
  // before submit, so the selection never reached the bill. The choice
  // only resets when the profile genuinely changes (different guest /
  // GSTIN) or the modal reopens (_hideCheckinGstCard via modal reset).
  const _same = !!(_checkinGst.profile && _checkinGst.profile.gstin === p.gstin);
  _checkinGst.profile = p;
  if (!_same) _checkinGst.applied = false;   // new company → explicit choice
  _setText('checkin-gst-company', (p.legal_name || p.trade_name || 'Company').trim());
  _setText('checkin-gst-gstin', p.gstin);
  _setText('checkin-gst-meta',
           p.last_used_at ? 'Last billed to this company on ' +
             _fmtGstCardDate(p.last_used_at) : '');
  _renderCheckinGstState();
  const card = document.getElementById('checkin-gst-card');
  if (card) card.style.display = 'block';
}

function _hideCheckinGstCard() {
  _checkinGst.profile = null;
  _checkinGst.applied = false;
  const card = document.getElementById('checkin-gst-card');
  if (card) card.style.display = 'none';
}

function _renderCheckinGstState() {
  const status = document.getElementById('checkin-gst-status');
  if (status) {
    status.textContent = _checkinGst.applied ? 'Company' : 'Personal';
    status.style.background = _checkinGst.applied ? '#dcfce7' : '#f3f4f6';
    status.style.color = _checkinGst.applied ? '#166534' : '#6b7280';
  }
  const applyBtn = document.getElementById('checkin-gst-apply');
  const skipBtn = document.getElementById('checkin-gst-skip');
  if (applyBtn) {
    applyBtn.style.background = _checkinGst.applied ? '#111827' : '#fff';
    applyBtn.style.color = _checkinGst.applied ? '#fff' : '#374151';
    applyBtn.style.border = _checkinGst.applied ? 'none' : '1px solid #e5e7eb';
  }
  if (skipBtn) {
    skipBtn.style.background = _checkinGst.applied ? '#fff' : '#111827';
    skipBtn.style.color = _checkinGst.applied ? '#6b7280' : '#fff';
    skipBtn.style.border = _checkinGst.applied ? '1px solid #e5e7eb' : 'none';
  }
}

function _fmtGstCardDate(raw) {
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return '';
    return String(d.getDate()).padStart(2, '0') + ' ' +
      d.toLocaleString('en-IN', { month: 'short' }) + ' ' + d.getFullYear();
  } catch (e) { return ''; }
}

// The answer, for the /checkin payload. Null means personal stay.
window.getCheckinGstProfile = function () {
  return (_checkinGst.applied && _checkinGst.profile &&
          _checkinGst.profile.gstin) ? _checkinGst.profile : null;
};

document.addEventListener('click', function (e) {
  const t = e.target && e.target.closest &&
            e.target.closest('#checkin-gst-apply, #checkin-gst-skip');
  if (!t) return;
  _checkinGst.applied = t.id === 'checkin-gst-apply';
  _renderCheckinGstState();
});

function _hideFlagAlert() {
  const alertEl = document.getElementById('checkin-flag-alert');
  if (alertEl) alertEl.style.display = 'none';
  const notesEl = document.getElementById('checkin-flag-alert-notes');
  if (notesEl) notesEl.textContent = '';
  const dateEl = document.getElementById('checkin-flag-alert-date');
  if (dateEl) dateEl.textContent = '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Pending settlement alert helpers
// ─────────────────────────────────────────────────────────────────────────────

// The settlement the banner is currently showing, so the Collect button and
// the "collected" event both know which one they are acting on.
let _checkinPendingSettlementId = null;

function _applyPendingSettlementAlert(customer) {
  const alertEl   = document.getElementById('checkin-pending-settlement-alert');
  const detailsEl = document.getElementById('checkin-pending-settlement-details');
  const dateEl    = document.getElementById('checkin-pending-settlement-date');
  const btnEl     = document.getElementById('checkin-pending-collect');
  const btnLblEl  = document.getElementById('checkin-pending-collect-label');
  if (!alertEl) return;

  _checkinPendingSettlementId =
    (customer && customer.has_pending_settlement && customer.pending_settlement_id) || null;

  // The button needs a settlement to act on (older records carry the amount
  // but no id) and the permission to take money. auth.js also hides it via
  // data-perm; this decides the rest.
  if (btnEl) {
    const _auth = window.CibaraAuth;
    const mayCollect = !!(_auth && typeof _auth.userCan === 'function' &&
                          _auth.userCan('settlement.collect'));
    const show = !!(_checkinPendingSettlementId && mayCollect &&
                    customer && customer.pending_settlement_amount);
    btnEl.style.display = show ? 'inline-flex' : 'none';
    btnEl.disabled = false;
    if (show && btnLblEl) {
      btnLblEl.textContent = 'Collect ₹' +
        Number(customer.pending_settlement_amount).toLocaleString('en-IN') + ' now';
    }
  }

  // A previous "cleared" state may have recoloured the banner; start fresh.
  const titleEl = document.getElementById('checkin-pending-settlement-title');
  alertEl.style.background = '';
  alertEl.style.borderColor = '';
  if (detailsEl) detailsEl.style.color = '';
  if (titleEl) titleEl.style.color = '';

  const _rows = (customer && Array.isArray(customer.pending_settlements))
    ? customer.pending_settlements : [];
  if (titleEl) {
    titleEl.textContent = _rows.length > 1
      ? `Pending Balance from ${_rows.length} Earlier Stays`
      : 'Pending Balance from Last Stay';
  }

  if (_rows.length > 1) {
    const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
    const parts = _rows.map(r => {
      const where = r.room ? `Room ${r.room}` : 'stay';
      const when  = r.checkout_date ? `, ${_fmtSettlementDate(r.checkout_date)}` : '';
      return `${inr(r.amount)} (${where}${when})`;
    });
    if (detailsEl) {
      detailsEl.textContent = `Outstanding: ${inr(customer.pending_settlement_total)} in total — ` +
        parts.join(' + ') + '. Please collect before check-in.';
    }
    if (dateEl) dateEl.textContent = 'Collect takes the oldest first.';
    alertEl.style.display = 'block';
  } else if (customer && customer.has_pending_settlement && customer.pending_settlement_amount) {
    const amt  = Number(customer.pending_settlement_amount).toLocaleString('en-IN');
    const room = customer.pending_settlement_room ? ` (Room ${customer.pending_settlement_room})` : '';
    if (detailsEl) detailsEl.textContent = `Outstanding: ₹${amt}${room} — please collect before check-in.`;

    if (dateEl && customer.pending_settlement_date) {
      try {
        const d     = new Date(customer.pending_settlement_date);
        const day   = String(d.getDate()).padStart(2, '0');
        const month = d.toLocaleString('en-IN', { month: 'short' });
        const year  = d.getFullYear();
        dateEl.textContent = `Checked out on: ${day} ${month} ${year}`;
      } catch (e) {
        dateEl.textContent = `Checked out on: ${customer.pending_settlement_date}`;
      }
    } else if (dateEl) {
      dateEl.textContent = '';
    }
    alertEl.style.display = 'block';
  } else {
    alertEl.style.display = 'none';
    if (detailsEl) detailsEl.textContent = '';
    if (dateEl)    dateEl.textContent    = '';
  }
}

function _fmtSettlementDate(raw) {
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return String(raw);
    return String(d.getDate()).padStart(2, '0') + ' ' +
      d.toLocaleString('en-IN', { month: 'short' }) + ' ' + d.getFullYear();
  } catch (e) { return String(raw); }
}

function _hidePendingSettlementAlert() {
  const alertEl = document.getElementById('checkin-pending-settlement-alert');
  if (alertEl) alertEl.style.display = 'none';
  const detailsEl = document.getElementById('checkin-pending-settlement-details');
  if (detailsEl) detailsEl.textContent = '';
  const dateEl = document.getElementById('checkin-pending-settlement-date');
  if (dateEl) dateEl.textContent = '';
  const btnEl = document.getElementById('checkin-pending-collect');
  if (btnEl) { btnEl.style.display = 'none'; btnEl.disabled = false; }
  _checkinPendingSettlementId = null;
}

// Collect opens the app's ONE collect-settlement modal (settle-later.js),
// which posts /collect_settlement. That route is what applies the money to
// the old invoice and closes it, so this button adds a doorway, not a second
// way to take money.
document.addEventListener('click', function (e) {
  const btn = e.target && e.target.closest && e.target.closest('#checkin-pending-collect');
  if (!btn) return;
  e.preventDefault();
  if (!_checkinPendingSettlementId) return;
  if (typeof window.showCollectSettlementModal !== 'function') {
    if (typeof showNotification === 'function') {
      showNotification('Collect is unavailable because the settlements module did not load. Refresh the page.', 'error');
    }
    return;
  }
  window.showCollectSettlementModal(_checkinPendingSettlementId);
});

// After the money is taken, correct this banner in place. The event carries
// the settled state from the server, so the banner never has to guess, and
// the cached customer record is patched too: reopening check-in for the same
// guest must not resurrect a balance that has been paid.
window.addEventListener('cibaraSettlementCollected', function (ev) {
  const d = (ev && ev.detail) || {};
  if (!d.settlement_id || d.settlement_id !== _checkinPendingSettlementId) return;

  const alertEl   = document.getElementById('checkin-pending-settlement-alert');
  const detailsEl = document.getElementById('checkin-pending-settlement-details');
  const dateEl    = document.getElementById('checkin-pending-settlement-date');
  const btnEl     = document.getElementById('checkin-pending-collect');
  const titleEl   = document.getElementById('checkin-pending-settlement-title');

  if (_currentCheckinCustomer) {
    if (d.fully_paid) {
      _currentCheckinCustomer.has_pending_settlement = false;
      _currentCheckinCustomer.pending_settlement_id = null;
      _currentCheckinCustomer.pending_settlement_amount = null;
    } else {
      _currentCheckinCustomer.pending_settlement_amount = d.remaining;
    }
  }

  // Other stays still owed: reload so the banner moves on to the next one
  // instead of announcing that everything is cleared.
  const _left = (_currentCheckinCustomer && _currentCheckinCustomer.pending_settlement_count) || 0;
  if (d.fully_paid && _left > 1 && _currentCheckinCustomer.mobile) {
    lookupAndFillCustomer(_currentCheckinCustomer.mobile);
    return;
  }

  if (d.fully_paid) {
    _checkinPendingSettlementId = null;
    if (btnEl) btnEl.style.display = 'none';
    if (alertEl) {
      alertEl.style.background = '#f0fdf4';
      alertEl.style.borderColor = '#22c55e';
    }
    if (titleEl) { titleEl.textContent = 'Last stay balance cleared'; titleEl.style.color = '#166534'; }
    if (detailsEl) {
      detailsEl.textContent = 'Collected ₹' +
        Number(d.payment_amount || 0).toLocaleString('en-IN') +
        (d.discount_amount ? ' (₹' + Number(d.discount_amount).toLocaleString('en-IN') + ' discounted)' : '') +
        '. The old bill is settled.';
      detailsEl.style.color = '#166534';
    }
    if (dateEl) { dateEl.textContent = ''; }
  } else {
    if (detailsEl) {
      detailsEl.textContent = 'Still outstanding: ₹' +
        Number(d.remaining || 0).toLocaleString('en-IN') + ' after this payment.';
    }
    const lbl = document.getElementById('checkin-pending-collect-label');
    if (lbl) lbl.textContent = 'Collect ₹' + Number(d.remaining || 0).toLocaleString('en-IN') + ' now';
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2.  Auto-fill + name mismatch
// ─────────────────────────────────────────────────────────────────────────────

function autoFillFromCustomer(customer) {
  const nameInput = document.getElementById('guest-name');
  if (nameInput) nameInput.value = _fmtName(customer.name) || '';
  if (customer.address && customer.address.trim()) expandAddress(customer.address);
  clearNameMismatch();
}

function initNameMismatchDetection() {
  document.getElementById('guest-name')?.addEventListener('input', function () {
    checkNameMismatch(this.value);
  });
}

function checkNameMismatch(currentName) {
  const warn = document.getElementById('name-mismatch-warn');
  if (!warn) return;
  if (!_currentCheckinCustomer?.name) { warn.style.display = 'none'; return; }
  const stored  = _fmtName(_currentCheckinCustomer.name).trim().toLowerCase();
  const entered = currentName.trim().toLowerCase();
  if (entered && entered !== stored) {
    warn.textContent = `⚠ Name on file: "${_fmtName(_currentCheckinCustomer.name)}"`;
    warn.style.display = 'inline';
  } else {
    warn.style.display = 'none';
  }
}

function clearNameMismatch() {
  const warn = document.getElementById('name-mismatch-warn');
  if (warn) warn.style.display = 'none';
}

// ─────────────────────────────────────────────────────────────────────────────
// 3.  Collapsible address
// ─────────────────────────────────────────────────────────────────────────────

function initAddressToggle() {
  document.getElementById('toggle-address-link')?.addEventListener('click', () => {
    const wrapper = document.getElementById('address-wrapper');
    if (!wrapper) return;
    wrapper.style.display === 'none' ? expandAddress('') : collapseAddress();
  });
}

function expandAddress(prefill) {
  const wrapper   = document.getElementById('address-wrapper');
  const icon      = document.getElementById('toggle-address-icon');
  const link      = document.getElementById('toggle-address-link');
  const addrInput = document.getElementById('guest-address');
  if (wrapper)   wrapper.style.display = 'block';
  if (icon)      icon.className        = 'fas fa-chevron-down';
  if (link)      link.childNodes[link.childNodes.length - 1].textContent = ' Address';
  if (addrInput && prefill) addrInput.value = prefill;
}

function collapseAddress() {
  const wrapper   = document.getElementById('address-wrapper');
  const icon      = document.getElementById('toggle-address-icon');
  const link      = document.getElementById('toggle-address-link');
  const addrInput = document.getElementById('guest-address');
  if (wrapper)   wrapper.style.display = 'none';
  if (icon)      icon.className        = 'fas fa-chevron-right';
  if (link)      link.childNodes[link.childNodes.length - 1].textContent = ' Add address';
  if (addrInput) addrInput.value       = '';
}

// ─────────────────────────────────────────────────────────────────────────────
// 4.  ID indicator dot
// ─────────────────────────────────────────────────────────────────────────────

function _setIndicator(state) {
  const pill = document.getElementById('doc-id-indicator');
  if (!pill) return;
  const map = {
    grey:   { text: 'ID?',   bg: '#e0e0e0', color: '#666',    title: 'Enter mobile to check ID status' },
    yellow: { text: 'No ID', bg: '#fff3cd', color: '#b45309', title: 'No ID document on file' },
    green:  { text: '✓ ID',  bg: '#d1fae5', color: '#065f46', title: 'ID document on file' },
  };
  const s = map[state] || map.grey;
  pill.textContent      = s.text;
  pill.style.background = s.bg;
  pill.style.color      = s.color;
  pill.title            = s.title;
}

function _applyIndicator(customer) {
  const hasDoc = (customer.id_doc_urls || []).length > 0 || _docCapturedBlobs.length > 0;
  _setIndicator(hasDoc ? 'green' : 'yellow');
}

// ─────────────────────────────────────────────────────────────────────────────
// 5.  View-photos button (check-in header)
// ─────────────────────────────────────────────────────────────────────────────

function _applyDocViewBtn(customer) {
  const urls = customer.id_doc_urls || [];
  urls.length > 0 ? showDocViewBtn(urls) : hideDocViewBtn();
}

// doc-view-btn removed from header — inline preview below mobile field handles this
function showDocViewBtn(_urls) {}
function hideDocViewBtn() {}

// ─────────────────────────────────────────────────────────────────────────────
// 5b.  Check-in stored doc preview (shown inline when returning guest has docs)
// ─────────────────────────────────────────────────────────────────────────────

function _showCheckinStoredDocs(customer) {
  const urls    = customer.id_doc_urls || [];
  const preview = document.getElementById('checkin-stored-doc-preview');
  const thumbs  = document.getElementById('checkin-stored-doc-thumbs');
  const viewBtn = document.getElementById('checkin-view-stored-docs-btn');

  if (!preview || !thumbs) return;

  if (urls.length === 0) { preview.style.display = 'none'; return; }

  thumbs.innerHTML = '';
  urls.forEach((url, idx) => {
    const img         = document.createElement('img');
    window.CibaraSecureImg.apply(img, url, 'thumb');
    img.alt           = `ID doc ${idx + 1}`;
    img.style.cssText = 'width:64px;height:44px;object-fit:cover;border-radius:5px;border:1px solid #a5d6a7;cursor:pointer';
    img.title         = `View document ${idx + 1}`;
    img.addEventListener('click', () => openPhotoViewer(urls, idx, customer.mobile || ''));
    thumbs.appendChild(img);
  });

  preview.style.display = 'block';

  // Wire "View all" button
  if (viewBtn) {
    viewBtn.onclick = () => openPhotoViewer(urls, 0, customer.mobile || '');
  }
}

function _hideCheckinStoredDocs() {
  const preview = document.getElementById('checkin-stored-doc-preview');
  if (preview) preview.style.display = 'none';
}

function _refreshCheckinStoredDocs(mobile) {
  if (!mobile || !_currentCheckinCustomer) return;
  // Re-fetch and re-render
  apiFetch(`/get_customer/${mobile}`)
    .then(r => r.json())
    .then(d => {
      if (d.success && d.customer) {
        _currentCheckinCustomer = d.customer;
        _showCheckinStoredDocs(d.customer);
        _applyIndicator(d.customer);
        _applyDocViewBtn(d.customer);
      } else {
        _hideCheckinStoredDocs();
      }
    }).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// 6.  Camera modal — open / close / doc type toggle
// ─────────────────────────────────────────────────────────────────────────────

function initDocCamera() {
  document.getElementById('doc-camera-btn')?.addEventListener('click', openDocCameraModal);
  document.getElementById('doc-capture-btn')?.addEventListener('click', captureDocPhoto);
  document.getElementById('doc-cancel-camera-btn')?.addEventListener('click', closeDocCameraModal);
  document.getElementById('doc-camera-modal-close')?.addEventListener('click', closeDocCameraModal);
  // Retake: stream was stopped after capture, so we must restart the camera fully
  document.getElementById('doc-retake-cam-btn')?.addEventListener('click', _retakeDocPhoto);
  document.getElementById('doc-add-photo-btn')?.addEventListener('click', _addPhotoAndRetake);
  document.getElementById('doc-use-photo-btn')?.addEventListener('click', useDocPhoto);
  document.getElementById('doc-add-more-btn')?.addEventListener('click', openDocCameraModal);
  document.getElementById('doc-file-input')?.addEventListener('change', onDocFileSelected);

  // Backdrop click closes
  document.getElementById('doc-camera-modal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('doc-camera-modal')) closeDocCameraModal();
  });

  // Doc type toggle (camera mode)
  document.getElementById('doc-type-card')?.addEventListener('click', () => _setDocType('card'));
  document.getElementById('doc-type-page')?.addEventListener('click', () => _setDocType('page'));

  // Scan button in checkin header — direct WiFi scan, no modal change needed

  // Checkout pending-upload strip buttons
  document.getElementById('checkout-pending-upload-btn')?.addEventListener('click', _commitCheckoutPending);
  document.getElementById('checkout-pending-discard-btn')?.addEventListener('click', _discardCheckoutPending);

  // Closing the checkout modal ends the staging session. initCheckoutDocAttach
  // deliberately does NOT reset on every call any more (background refreshes
  // used to wipe staged photos mid-upload), so the reset happens here instead
  // - once, on an actual close - and keeps the shared _docCapturedBlobs array
  // from leaking checkout photos into the next check-in.
  document.querySelectorAll('#checkout-modal .close-btn').forEach(btn => {
    btn.addEventListener('click', _endCheckoutDocSession);
  });
  document.getElementById('checkout-modal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('checkout-modal')) _endCheckoutDocSession();
  });

  // View-photos buttons
  document.getElementById('checkout-doc-view-btn')?.addEventListener('click', () => {
    const btn = document.getElementById('checkout-doc-view-btn');
    // mobile is stored on the button via data attr set in populateCheckoutDocView
    const mobile = btn._mobile || '';
    openPhotoViewer(btn._docUrls || [], 0, mobile);
  });

  // Photo viewer controls
  document.getElementById('doc-viewer-close')?.addEventListener('click', closePhotoViewer);
  document.getElementById('doc-photo-viewer')?.addEventListener('click', e => {
    if (e.target === document.getElementById('doc-photo-viewer')) closePhotoViewer();
  });
  document.getElementById('doc-viewer-prev')?.addEventListener('click', () => navigateViewer(-1));
  document.getElementById('doc-viewer-next')?.addEventListener('click', () => navigateViewer(+1));

  // Delete stored photo from viewer
  document.getElementById('doc-viewer-delete-btn')?.addEventListener('click', _deleteViewerPhoto);

  // Add another photo straight from the viewer — delegates to whichever screen
  // registered an add handler (the Register sets window.CibaraDocAddHandler).
  document.getElementById('doc-viewer-add-btn')?.addEventListener('click', () => {
    if (typeof window.CibaraDocAddHandler === 'function' && _viewerMobile) {
      window.CibaraDocAddHandler(_viewerMobile, Math.max(0, MAX_DOC_PHOTOS - _viewerUrls.length));
    }
  });

  // Keyboard: ← / → to flip between photos, Esc to close. Only acts while the
  // lightbox is actually open so it never swallows keys on the page behind.
  document.addEventListener('keydown', (e) => {
    const viewer = document.getElementById('doc-photo-viewer');
    if (!viewer || viewer.style.display !== 'flex') return;
    if (e.key === 'Escape')      { closePhotoViewer(); }
    else if (e.key === 'ArrowLeft'  && _viewerUrls.length > 1) { e.preventDefault(); navigateViewer(-1); }
    else if (e.key === 'ArrowRight' && _viewerUrls.length > 1) { e.preventDefault(); navigateViewer(+1); }
  });

  // Click the main image to toggle a 1:1 zoom (an ID number is often too small
  // to read in the fitted view). Pan by scrolling while zoomed.
  const mainImg = document.getElementById('doc-viewer-main-img');
  if (mainImg) {
    mainImg.style.cursor = 'zoom-in';
    mainImg.addEventListener('click', () => {
      const zoomed = mainImg.classList.toggle('doc-zoomed');
      mainImg.style.cursor = zoomed ? 'zoom-out' : 'zoom-in';
    });
  }
}

function _setDocType(type) {
  _docType = type;
  ['card', 'page'].forEach(t => {
    const btn = document.getElementById(`doc-type-${t}`);
    if (btn) btn.classList.toggle('active', t === type);
  });
  // Redraw guide immediately
  _drawGuide(0);
}

async function openDocCameraModal() {
  if (_docCapturedBlobs.length >= MAX_DOC_PHOTOS) {
    _notify(`Maximum ${MAX_DOC_PHOTOS} photos already taken`, 'warning');
    return;
  }

  stopDocStream();
  _showCameraFeedSection();

  const modal = document.getElementById('doc-camera-modal');
  if (modal) modal.classList.add('show');

  // Helper to attach stream to feed once acquired
  async function _attachStream(stream) {
    _docStream = stream;
    const feed = document.getElementById('doc-camera-feed');
    if (feed) {
      feed.srcObject = stream;
      feed.addEventListener('loadedmetadata', () => {
        setTimeout(() => { _resizeScanOverlay(); startAutoScan(); }, 80);
      }, { once: true });
    }
  }

  try {
    // Force rear camera with exact; if device has no environment camera (e.g. desktop)
    // the OverconstrainedError fallback below opens any available camera instead.
    await _attachStream(await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { exact: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    }));
  } catch (envErr) {
    // Rear camera not available — try without facing constraint (desktop / single-camera)
    try {
      await _attachStream(await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      }));
    } catch (err) {
      console.warn('[customer-docs] Camera unavailable, using file picker:', err);
      closeDocCameraModal();
      document.getElementById('doc-file-input')?.click();
    }
  }
}

function closeDocCameraModal() {
  stopAutoScan();
  stopDocStream();
  const modal = document.getElementById('doc-camera-modal');
  if (modal) modal.classList.remove('show');
}

/** Retake: discard the last captured blob and restart the camera */
async function _retakeDocPhoto() {
  // Remove the last blob that was pushed during captureDocPhoto
  if (_docCapturedBlobs.length > 0) {
    const last = _docCapturedBlobs.pop();
    URL.revokeObjectURL(last.url);
  }
  // Stream was stopped by captureDocPhoto — restart it
  _showCameraFeedSection();
  try {
    _docStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { exact: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  } catch (_) {
    // Fallback for desktop / single-camera devices
    _docStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    }).catch(err => {
      console.warn('[customer-docs] Camera unavailable on retake:', err);
      document.getElementById('doc-file-input')?.click();
      return null;
    });
  }
  if (_docStream) {
    const feed = document.getElementById('doc-camera-feed');
    if (feed) {
      feed.srcObject = _docStream;
      feed.addEventListener('loadedmetadata', () => {
        setTimeout(() => { _resizeScanOverlay(); startAutoScan(); }, 80);
      }, { once: true });
    }
  }
}

function _showCameraFeedSection() {
  const feed    = document.getElementById('doc-cam-modal-feed-section');
  const preview = document.getElementById('doc-cam-modal-preview-section');
  if (feed)    { feed.style.display    = 'flex'; feed.style.flexDirection = 'column'; }
  if (preview) { preview.style.display = 'none'; }
  _stableFrameCount = 0;
  _lastFramePixels  = null;
  _scanLineY        = 0;
  _setScanStatus('scanning');
}

/** Save current pending blob and go back to camera for another shot */
function _addPhotoAndRetake() {
  // _docCapturedBlobs already has the temp blob from captureDocPhoto
  // (it was pushed when captureDocPhoto ran)
  renderThumbStrip();
  _updateAddMoreBtn();

  // If still under limit, re-open camera
  if (_docCapturedBlobs.length < MAX_DOC_PHOTOS) {
    _showCameraFeedSection();
    startAutoScan();
    const feed = document.getElementById('doc-camera-feed');
    if (feed && _docStream) {
      feed.srcObject = _docStream;
    } else {
      openDocCameraModal();
    }
  } else {
    useDocPhoto();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7.  Auto-scan (frame stability detection)
// ─────────────────────────────────────────────────────────────────────────────

function _resizeScanOverlay() {
  const feed    = document.getElementById('doc-camera-feed');
  const overlay = document.getElementById('doc-scan-overlay');
  if (!feed || !overlay) return;
  // Use CSS display dimensions (not native video resolution) so the guide
  // draws in the same coordinate space as what the user actually sees.
  const rect = feed.getBoundingClientRect();
  const w = Math.round(rect.width)  || feed.clientWidth  || 320;
  const h = Math.round(rect.height) || feed.clientHeight || 240;
  overlay.width  = w;
  overlay.height = h;
  _drawGuide(0);
}

function startAutoScan() {
  _autoScanActive   = true;
  _scanCanvas       = document.createElement('canvas');
  _scanCanvas.width  = 160;
  _scanCanvas.height = 120;
  _scanCtx           = _scanCanvas.getContext('2d');
  _lastFramePixels   = null;
  _stableFrameCount  = 0;
  _scanLineY         = 0;
  _setScanStatus('scanning');
  _drawGuide(0);
  _scanLoop();
}

function stopAutoScan() {
  _autoScanActive = false;
  clearTimeout(_scanTimer);
}

function _scanLoop() {
  if (!_autoScanActive || !_docStream) return;

  const feed = document.getElementById('doc-camera-feed');
  if (!feed || feed.readyState < 2) {
    _scanTimer = setTimeout(_scanLoop, SCAN_INTERVAL_MS);
    return;
  }

  _scanCtx.drawImage(feed, 0, 0, 160, 120);
  const current = _scanCtx.getImageData(0, 0, 160, 120).data;
  let motion = 0, brightness = 0;
  const total = 160 * 120;

  if (_lastFramePixels) {
    for (let i = 0; i < current.length; i += 4) {
      motion     += Math.abs(current[i] - _lastFramePixels[i]);
      brightness += current[i] * 0.299 + current[i + 1] * 0.587 + current[i + 2] * 0.114;
    }
    motion /= total;
    brightness /= total;

    // Relaxed thresholds for mobile: less strict on brightness (indoor light)
    // and more tolerant of minor hand shake
    if (motion < 12 && brightness > 55) {
      _stableFrameCount = Math.min(_stableFrameCount + 1, STABLE_NEEDED);
    } else if (motion < 20) {
      _stableFrameCount = Math.max(0, _stableFrameCount - 1);
    } else {
      _stableFrameCount = 0;
    }
  }

  const progress = _stableFrameCount / STABLE_NEEDED;

  // Advance scan line when progress > 0
  if (progress > 0) {
    _scanLineY = (_scanLineY + 4) % 100;  // 0–99 percent of guide height
  }

  _drawGuide(progress);

  if (_stableFrameCount >= STABLE_NEEDED) {
    _setScanStatus('captured');
    captureDocPhoto();
    return;
  }

  _setScanStatus(progress > 0.3 ? 'hold' : 'scanning');
  _lastFramePixels = new Uint8ClampedArray(current);
  _scanTimer = setTimeout(_scanLoop, SCAN_INTERVAL_MS);
}

function _setScanStatus(state) {
  const el = document.getElementById('doc-scan-status');
  if (!el) return;
  const map = {
    scanning: { html: '<i class="fas fa-search" style="margin-right:0.3rem;font-size:0.7rem"></i>Scanning for document…', bg: 'rgba(0,0,0,0.7)' },
    hold:     { html: '<i class="fas fa-lock" style="margin-right:0.3rem;font-size:0.7rem"></i>Hold steady…',            bg: 'rgba(21,101,192,0.85)' },
    captured: { html: '<i class="fas fa-check" style="margin-right:0.3rem;font-size:0.7rem"></i>Captured!',              bg: 'rgba(25,135,84,0.9)' },
  };
  const s = map[state] || map.scanning;
  el.innerHTML          = s.html;
  el.style.background   = s.bg;
}

// Pure geometry: the guide rectangle inside a W×H box for a given doc type.
// Shared by the on-screen overlay (_drawGuide) AND the capture crop
// (_mapGuideToSource) so the saved region is EXACTLY what the operator framed.
// On a portrait phone frame (W < H) cards get their width from W; pages from H.
function _guideRect(W, H, docType) {
  let gW, gH;
  if (docType === 'card') {
    // ID / Aadhaar card: landscape credit-card ratio 85.6 × 53.98 mm = 1.586 : 1
    gW = W * 0.86;
    gH = gW / 1.586;
    if (gH > H * 0.78) { gH = H * 0.78; gW = gH * 1.586; }   // too tall → height-led
  } else {
    // A4 / long document: portrait 0.707 : 1  (width : height)
    gH = H * 0.88;
    gW = gH * 0.707;
    if (gW > W * 0.80) { gW = W * 0.80; gH = gW / 0.707; }   // too wide → width-led
  }
  return { gX: (W - gW) / 2, gY: (H - gH) / 2, gW, gH };
}

// Map the guide rectangle (display/box coordinates) to a crop rectangle in the
// camera's native pixels. The <video> is object-fit: cover, so the displayed
// frame is the source scaled up by max(boxW/vW, boxH/vH) and centre-cropped;
// this inverts that mapping. `marginFrac` grows the crop on every side so a
// card edge sitting just outside the guide is not clipped. Pure + testable.
function _mapGuideToSource(boxW, boxH, videoW, videoH, docType, marginFrac) {
  const g = _guideRect(boxW, boxH, docType);
  const scale = Math.max(boxW / videoW, boxH / videoH);   // object-fit: cover
  const offsetX = (videoW * scale - boxW) / 2;
  const offsetY = (videoH * scale - boxH) / 2;
  let sx = (g.gX + offsetX) / scale;
  let sy = (g.gY + offsetY) / scale;
  let sw = g.gW / scale;
  let sh = g.gH / scale;
  const mx = sw * (marginFrac || 0), my = sh * (marginFrac || 0);
  sx -= mx; sy -= my; sw += 2 * mx; sh += 2 * my;
  // Clamp to the real frame so we never read outside the video buffer.
  sx = Math.max(0, sx); sy = Math.max(0, sy);
  sw = Math.min(sw, videoW - sx); sh = Math.min(sh, videoH - sy);
  return { sx, sy, sw, sh };
}

function _drawGuide(progress) {
  const overlay = document.getElementById('doc-scan-overlay');
  if (!overlay) return;
  const ctx = overlay.getContext('2d');
  const W   = overlay.width  || 640;
  const H   = overlay.height || 360;

  ctx.clearRect(0, 0, W, H);

  const { gX, gY, gW, gH } = _guideRect(W, H, _docType);

  // Dim area outside guide
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  ctx.fillRect(0,  0,  W,  gY);
  ctx.fillRect(0,  gY + gH, W, H - (gY + gH));
  ctx.fillRect(0,  gY, gX,  gH);
  ctx.fillRect(gX + gW, gY, W - (gX + gW), gH);

  // Corner brackets
  const bracketLen = Math.min(gW, gH) * 0.12;
  const color      = progress > 0.5 ? '#69f0ae' : '#ffffff';
  ctx.strokeStyle  = color;
  ctx.lineWidth    = 3;
  ctx.lineCap      = 'round';

  [
    [gX,      gY,       1,  1],
    [gX + gW, gY,      -1,  1],
    [gX,      gY + gH,  1, -1],
    [gX + gW, gY + gH, -1, -1],
  ].forEach(([x, y, dx, dy]) => {
    ctx.beginPath();
    ctx.moveTo(x + dx * bracketLen, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + dy * bracketLen);
    ctx.stroke();
  });

  // Scanning sweep line (green, fades)
  if (progress > 0 && progress < 1) {
    const lineY = gY + (gH * _scanLineY / 100);
    const grad  = ctx.createLinearGradient(gX, lineY, gX + gW, lineY);
    grad.addColorStop(0,   'rgba(105,240,174,0)');
    grad.addColorStop(0.5, `rgba(105,240,174,${0.7 * progress})`);
    grad.addColorStop(1,   'rgba(105,240,174,0)');
    ctx.strokeStyle = grad;
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.moveTo(gX, lineY);
    ctx.lineTo(gX + gW, lineY);
    ctx.stroke();
  }

  // Progress bar at bottom of guide
  if (progress > 0) {
    const barH = 4;
    ctx.fillStyle = `rgba(105,240,174,${0.5 + progress * 0.4})`;
    ctx.fillRect(gX, gY + gH - barH, gW * progress, barH);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8.  Capture + scanned look + multi-photo handling
// ─────────────────────────────────────────────────────────────────────────────

function captureDocPhoto() {
  stopAutoScan();
  const feed = document.getElementById('doc-camera-feed');
  if (!feed) return;

  const videoW = feed.videoWidth  || 1280;
  const videoH = feed.videoHeight || 720;

  // Capture the WHOLE frame so the detector has the surrounding context it needs
  // to find the document's edges. Cap the long side so the JPEG encodes fast.
  const MAX_EDGE = 2200;
  const scale   = Math.min(1, MAX_EDGE / Math.max(videoW, videoH));
  const canvas  = document.createElement('canvas');
  canvas.width  = Math.max(1, Math.round(videoW * scale));
  canvas.height = Math.max(1, Math.round(videoH * scale));
  canvas.getContext('2d').drawImage(feed, 0, 0, canvas.width, canvas.height);

  // The guide box the operator framed into, as fractions of the frame. This is
  // the fallback crop when auto-detect misses, so we still keep exactly "the
  // area you framed" — never the whole desk.
  let fallbackCrop = null;
  const rect = feed.getBoundingClientRect();
  const boxW = Math.round(rect.width)  || feed.clientWidth  || videoW;
  const boxH = Math.round(rect.height) || feed.clientHeight || videoH;
  if (boxW > 0 && boxH > 0) {
    const g = _mapGuideToSource(boxW, boxH, videoW, videoH, _docType, 0.04);
    fallbackCrop = { x: g.sx / videoW, y: g.sy / videoH, w: g.sw / videoW, h: g.sh / videoH };
  }

  // Free the camera (phones only allow one user of it at a time).
  stopDocStream();

  canvas.toBlob(async (blob) => {
    if (!blob) { _notify('Could not capture the photo — try again', 'error'); _retakeDocPhoto(); return; }

    // ONE TAP: auto-detect the document → deskew → magic colour, with NO crop
    // editor. On a detection miss it crops to the guide box the operator framed.
    // The preview below (with Retake) is the review step.
    const captured = new File([blob], `id_${Date.now()}.jpg`, { type: 'image/jpeg' });
    let scanned = captured;
    if (window.CibaraDocScan && typeof window.CibaraDocScan.autoScan === 'function') {
      try {
        scanned = await window.CibaraDocScan.autoScan(captured, {
          autoDetect: true, enhance: 'magic', fallbackCrop,
        }) || captured;
      } catch (e) { console.warn('[customer-docs] autoScan failed, keeping frame:', e); scanned = captured; }
    }

    const url = URL.createObjectURL(scanned);
    _docCapturedBlobs.push({ blob: scanned, url });

    const prevImg = document.getElementById('doc-preview-img');
    if (prevImg) prevImg.src = url;

    const feedSec    = document.getElementById('doc-cam-modal-feed-section');
    const previewSec = document.getElementById('doc-cam-modal-preview-section');
    if (feedSec)    feedSec.style.display    = 'none';
    if (previewSec) { previewSec.style.display = 'flex'; previewSec.style.flexDirection = 'column'; }

    // Update "Add Another" button visibility in preview
    const addAnotherBtn = document.getElementById('doc-add-photo-btn');
    if (addAnotherBtn) {
      addAnotherBtn.style.display = _docCapturedBlobs.length < MAX_DOC_PHOTOS ? 'flex' : 'none';
    }
  }, 'image/jpeg', 0.92);
}

// Unsharp-mask sharpen + mild contrast. The old version only desaturated and
// over-boosted contrast, which greyed out and muddied small print. Here a 3×3
// box-blur is subtracted back from the original (unsharp mask) to crisp up the
// edges of text and the QR, followed by a gentle contrast lift. Colour is kept
// so the photo still looks like the card. Runs once per capture on the cropped
// region (≤1600–2000px), so the cost is a few tens of ms.
function _applyScannedLook(ctx, w, h) {
  const img = ctx.getImageData(0, 0, w, h);
  const s   = img.data;
  const blur = new Uint8ClampedArray(s.length);

  // Separable 3×3 box blur (horizontal pass then vertical) into `blur`.
  const tmp = new Float32Array(s.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = (row + x) * 4;
      const xl = x > 0 ? i - 4 : i;
      const xr = x < w - 1 ? i + 4 : i;
      tmp[i]     = (s[xl]     + s[i]     + s[xr])     / 3;
      tmp[i + 1] = (s[xl + 1] + s[i + 1] + s[xr + 1]) / 3;
      tmp[i + 2] = (s[xl + 2] + s[i + 2] + s[xr + 2]) / 3;
    }
  }
  const stride = w * 4;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const up = y > 0 ? -stride : 0;
    const dn = y < h - 1 ? stride : 0;
    for (let x = 0; x < w; x++) {
      const i = (row + x) * 4;
      blur[i]     = (tmp[i + up]     + tmp[i]     + tmp[i + dn])     / 3;
      blur[i + 1] = (tmp[i + up + 1] + tmp[i + 1] + tmp[i + dn + 1]) / 3;
      blur[i + 2] = (tmp[i + up + 2] + tmp[i + 2] + tmp[i + dn + 2]) / 3;
    }
  }

  const AMOUNT   = 0.9;    // unsharp strength
  const CONTRAST = 1.12;   // gentle, so highlights don't blow out
  for (let i = 0; i < s.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      let v = s[i + c] + AMOUNT * (s[i + c] - blur[i + c]);  // unsharp mask
      v = (v - 128) * CONTRAST + 128;                        // mild contrast
      s[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** "Done" — finalise current blob(s), close modal, render strip or show pending preview */
async function useDocPhoto() {
  if (_docCameraContext === 'checkout') {
    // Don't upload yet — move captured blobs to the pending strip in the checkout modal
    // so the user can review, add more, or discard before committing to the server.
    _docCameraContext = 'checkin'; // reset context
    closeDocCameraModal();
    _renderCheckoutPendingStrip();
    return;
  }

  // Normal check-in flow — keep blobs for upload on form submit
  renderThumbStrip();
  _updateAddMoreBtn();
  _setIndicator('green');
  closeDocCameraModal();
}

// Run one ID photo through the document scanner (static/doc-scan.js): it
// lazy-loads OpenCV, auto-detects the document's four corners (card OR long
// doc), lets the operator nudge them, deskews the quad flat, applies the
// magic-colour enhancement, and hands back a cropped JPEG — so only the
// document, not the desk behind it, is ever uploaded. Returns the processed
// File; the ORIGINAL file when the scanner is unavailable or passed it through
// (non-image); or null when the operator cancelled in the editor.
async function _scanIdDoc(file) {
  if (!file || !(window.CibaraDocScan && typeof window.CibaraDocScan.scan === 'function')) {
    return file;
  }
  try {
    return await window.CibaraDocScan.scan(file, {
      autoDetect: true,
      enhance: 'magic',
      title: 'Scan the ID',
      hint: 'The document is detected automatically — drag the dots to fix the corners, then tap “Use this”.',
    });
  } catch (e) {
    console.warn('[customer-docs] ID scan failed, keeping original:', e);
    return file;
  }
}

// Headless version of _scanIdDoc: auto-detect → deskew → magic colour with NO
// crop editor, exactly like the Register upload (see _uploadRegisterDocs in
// register.js). Falls back to a plain colour compress when the scanner is
// unavailable, and to the original file on any error. Never returns null —
// there is no editor to cancel — so the caller always gets a usable blob.
async function _autoScanIdDoc(file) {
  if (!file) return file;
  try {
    if (window.CibaraDocScan && typeof window.CibaraDocScan.autoScan === 'function') {
      return await window.CibaraDocScan.autoScan(file, { autoDetect: true, enhance: 'magic' }) || file;
    }
    if (typeof _compressImage === 'function') {
      return await _compressImage(file);
    }
  } catch (e) {
    console.warn('[customer-docs] headless ID scan failed, keeping original:', e);
  }
  return file;
}

async function onDocFileSelected() {
  const input = document.getElementById('doc-file-input');
  const picked = input?.files[0];
  if (!picked || _docCapturedBlobs.length >= MAX_DOC_PHOTOS) return;
  // Auto-detect → adjust corners → deskew → magic colour. Only the cropped
  // document is kept. Cancelling the editor adds nothing.
  const scanned = await _scanIdDoc(picked);
  if (input) input.value = '';           // let the same file be re-picked
  if (!scanned) return;                  // cancelled in the editor
  // The scanner already returns a sized, enhanced JPEG; only fall back to
  // _compressImage (3-8 MB phone photo → ~150-350 KB) when it passed the
  // original straight through (scanner unavailable / non-image).
  const blob = (scanned !== picked) ? scanned : await _compressImage(picked);
  const url = URL.createObjectURL(blob);
  _docCapturedBlobs.push({ blob, url });
  renderThumbStrip();
  _updateAddMoreBtn();
  _setIndicator('green');
}

function stopDocStream() {
  if (_docStream) { _docStream.getTracks().forEach(t => t.stop()); _docStream = null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 9.  Thumbnail strip rendering
// ─────────────────────────────────────────────────────────────────────────────

function renderThumbStrip() {
  const strip   = document.getElementById('doc-thumbs-strip');
  const preview = document.getElementById('doc-preview-container');
  if (!strip) return;

  strip.innerHTML = '';
  _docCapturedBlobs.forEach((item, idx) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'doc-strip-thumb';
    wrapper.title     = `Photo ${idx + 1} — click to view`;

    const img   = document.createElement('img');
    img.src     = item.url;
    img.alt     = `ID photo ${idx + 1}`;
    img.addEventListener('click', () => openPhotoViewer(
      _docCapturedBlobs.map(b => b.url), idx
    ));

    const removeBtn  = document.createElement('button');
    removeBtn.type   = 'button';
    removeBtn.className = 'doc-strip-thumb-remove';
    removeBtn.innerHTML = '×';
    removeBtn.title  = 'Remove this photo';
    removeBtn.addEventListener('click', e => {
      e.stopPropagation();
      URL.revokeObjectURL(item.url);
      _docCapturedBlobs.splice(idx, 1);
      renderThumbStrip();
      _updateAddMoreBtn();
      if (_docCapturedBlobs.length === 0) {
        if (preview) preview.style.display = 'none';
        _setIndicator(
          (_currentCheckinCustomer?.id_doc_urls || []).length > 0 ? 'green' : 'yellow'
        );
      }
    });

    wrapper.appendChild(img);
    wrapper.appendChild(removeBtn);
    strip.appendChild(wrapper);
  });

  if (preview) {
    preview.style.display = _docCapturedBlobs.length > 0 ? 'block' : 'none';
  }
}

function _updateAddMoreBtn() {
  const btn = document.getElementById('doc-add-more-btn');
  if (!btn) return;
  btn.style.display = _docCapturedBlobs.length < MAX_DOC_PHOTOS ? 'flex' : 'none';
}

function resetDocCaptureUI() {
  _docCapturedBlobs.forEach(item => URL.revokeObjectURL(item.url));
  _docCapturedBlobs = [];

  const strip   = document.getElementById('doc-thumbs-strip');
  const preview = document.getElementById('doc-preview-container');
  if (strip)   strip.innerHTML         = '';
  if (preview) preview.style.display   = 'none';

  const fi = document.getElementById('doc-file-input');
  if (fi) fi.value = '';

  _updateAddMoreBtn();
}

// ─────────────────────────────────────────────────────────────────────────────
// 10.  Photo viewer (lightbox for both saved and newly-captured photos)
// ─────────────────────────────────────────────────────────────────────────────

// Mobile number associated with the photos currently in the viewer
// (set when opening from a customer context so the delete button can call the API)
let _viewerMobile = '';

// Bumped on every photo switch. An image fetch that finishes after the user
// has already moved on (or opened a different guest) checks its token against
// this and bails, so a slow previous request can never paint over the photo
// now on screen.
let _viewerLoadToken = 0;

// Warm the session image cache (window.CibaraSecureImg keeps a Map of blob
// URLs) so navigating between a guest's photos — and re-opening the same
// guest — is instant. Thumbs are small, so warm them all; the heavier
// watermarked views only for the current photo and its immediate neighbours,
// to avoid asking the server to generate every watermark at once.
function _prefetchViewerImages(urls, idx) {
  const Secure = window.CibaraSecureImg;
  if (!Secure || !urls) return;
  urls.forEach((u, i) => {
    if (!Secure.isSecure(u)) return;
    Secure.src(u, 'thumb').catch(() => {});
    if (Math.abs(i - idx) <= 1) Secure.src(u, 'view').catch(() => {});
  });
}

function openPhotoViewer(urls, startIdx, mobile) {
  if (!urls || !urls.length) return;
  _viewerUrls       = urls;
  _viewerCurrentIdx = startIdx || 0;
  _viewerMobile     = (mobile || '').replace(/\D/g, '');
  _prefetchViewerImages(urls, _viewerCurrentIdx);

  _setText('doc-viewer-count', `${urls.length} photo${urls.length !== 1 ? 's' : ''} on file`);

  const thumbsEl = document.getElementById('doc-viewer-thumbs');
  if (thumbsEl) {
    thumbsEl.innerHTML = '';
    urls.forEach((url, i) => {
      const img     = document.createElement('img');
      window.CibaraSecureImg.apply(img, url, 'thumb');
      img.alt       = `Doc ${i + 1}`;
      img.className = 'doc-thumb' + (i === _viewerCurrentIdx ? ' active' : '');
      img.addEventListener('click', () => setViewerPhoto(i));
      thumbsEl.appendChild(img);
    });
    thumbsEl.style.display = urls.length > 1 ? 'flex' : 'none';
  }

  setViewerPhoto(_viewerCurrentIdx);

  const showArrows = urls.length > 1;
  _showFlex('doc-viewer-prev', showArrows);
  _showFlex('doc-viewer-next', showArrows);

  // "Add photo" is offered only when a mobile is linked, a host screen has
  // registered an add handler (register.js sets window.CibaraDocAddHandler),
  // and the guest is still under the photo cap. This is what lets the Register
  // open documents straight in this viewer and still add more without an
  // intermediate grid modal.
  const addBtn = document.getElementById('doc-viewer-add-btn');
  if (addBtn) {
    const canAdd = !!(_viewerMobile && typeof window.CibaraDocAddHandler === 'function'
                      && _viewerUrls.length < MAX_DOC_PHOTOS);
    addBtn.style.display = canAdd ? 'inline-flex' : 'none';
  }

  const viewer = document.getElementById('doc-photo-viewer');
  if (viewer) viewer.style.display = 'flex';
}

function _showViewerSpinner(show) {
  const el = document.getElementById('doc-viewer-loading');
  if (el) el.style.display = show ? 'flex' : 'none';
}

function setViewerPhoto(idx) {
  _viewerCurrentIdx = idx;
  const url = _viewerUrls[idx];
  const token = ++_viewerLoadToken;
  const mainImg  = document.getElementById('doc-viewer-main-img');
  if (mainImg) {
    // Drop any zoom from the previous photo so each one opens fitted.
    mainImg.classList.remove('doc-zoomed');
    mainImg.style.cursor = 'zoom-in';

    const Secure = window.CibaraSecureImg;
    if (Secure && Secure.isSecure(url)) {
      // Blank the previous image at once so another guest's document is never
      // left on screen while the new (watermarked, server-generated) view
      // loads. Show a spinner, then paint the small thumb the moment it is
      // ready (fast, usually cached) and sharpen to the full view after.
      mainImg.removeAttribute('src');
      mainImg.alt = '';
      mainImg.classList.add('doc-lowres');
      _showViewerSpinner(true);

      let gotFull = false;
      Secure.src(url, 'thumb').then((u) => {
        if (token !== _viewerLoadToken || gotFull) return;
        mainImg.src = u;
        _showViewerSpinner(false);
      }).catch(() => {});
      Secure.src(url, 'view').then((u) => {
        if (token !== _viewerLoadToken) return;
        gotFull = true;
        mainImg.src = u;
        mainImg.classList.remove('doc-lowres');
        _showViewerSpinner(false);
      }).catch(() => {
        if (token !== _viewerLoadToken) return;
        _showViewerSpinner(false);
        mainImg.classList.remove('doc-lowres');
        mainImg.alt = 'Could not load';
      });

      // Warm the neighbours so flipping between photos is instant.
      _prefetchViewerImages(_viewerUrls, idx);
    } else {
      // Local blob URL (a not-yet-uploaded capture) — no fetch, show it now.
      mainImg.classList.remove('doc-lowres');
      _showViewerSpinner(false);
      mainImg.src = url;
    }
  }
  const openLink = document.getElementById('doc-viewer-open-link');
  if (openLink) {
    openLink.href = window.CibaraSecureImg.isSecure(url) ? '#' : url;
    openLink.onclick = window.CibaraSecureImg.isSecure(url)
      ? (e) => { e.preventDefault(); window.CibaraSecureImg.open(url); } : null;
  }
  // Who captured this photo and when (shown under "N photos on file").
  const n = _viewerUrls.length;
  const cap = window.CibaraSecureImg.caption(url);
  _setText('doc-viewer-count', `${n} photo${n !== 1 ? 's' : ''} on file` + (cap ? ` · ${cap}` : ''));
  document.querySelectorAll('.doc-thumb').forEach((el, i) => el.classList.toggle('active', i === idx));
}

function navigateViewer(delta) {
  setViewerPhoto((_viewerCurrentIdx + delta + _viewerUrls.length) % _viewerUrls.length);
}

function closePhotoViewer() {
  const viewer = document.getElementById('doc-photo-viewer');
  if (viewer) viewer.style.display = 'none';
}

// Exposed on window so the Register screen (static/register.js, a separate
// script) can open the same lightbox instead of dumping the raw image into a
// new browser tab.
window.openPhotoViewer = openPhotoViewer;

async function _deleteViewerPhoto() {
  const urlToDelete = _viewerUrls[_viewerCurrentIdx];
  if (!urlToDelete) return;

  // If this is a locally-captured blob URL (not yet uploaded), just remove from array
  if (urlToDelete.startsWith('blob:')) {
    const blobIdx = _docCapturedBlobs.findIndex(b => b.url === urlToDelete);
    if (blobIdx !== -1) {
      URL.revokeObjectURL(_docCapturedBlobs[blobIdx].url);
      _docCapturedBlobs.splice(blobIdx, 1);
      renderThumbStrip();
      _updateAddMoreBtn();
      _notify('Photo removed', 'success');
    }
    // Update viewer or close if no more photos
    _viewerUrls.splice(_viewerCurrentIdx, 1);
    if (_viewerUrls.length === 0) { closePhotoViewer(); return; }
    _viewerCurrentIdx = Math.min(_viewerCurrentIdx, _viewerUrls.length - 1);
    openPhotoViewer(_viewerUrls, _viewerCurrentIdx, _viewerMobile);
    return;
  }

  // Stored photo — need mobile to call backend
  if (!_viewerMobile) {
    _notify('Cannot delete — no customer mobile linked to this photo', 'warning');
    return;
  }

  _showConfirmDialog({
    title:        'Delete document?',
    message:      'This will permanently remove the photo from the guest record and cannot be undone.',
    confirmLabel: 'Delete',
    iconClass:    'fa-trash-alt',
    iconColor:    '#ef5350',
    bgColor:      '#c62828',
  }, async () => {
    await _doDeleteViewerPhoto(urlToDelete);
  });
}

/** Actual deletion logic — called after the user confirms. */
async function _doDeleteViewerPhoto(urlToDelete) {
  const btn = document.getElementById('doc-viewer-delete-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Deleting…'; }

  try {
    const res  = await apiFetch('/delete_customer_document', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile: _viewerMobile, url: urlToDelete }),
    });
    const data = await res.json();

    if (data.success) {
      _notify('Document deleted', 'success');
      _viewerUrls.splice(_viewerCurrentIdx, 1);

      if (_viewerUrls.length === 0) {
        closePhotoViewer();
        // Re-check customer and update indicator
        lookupAndFillCustomer(_viewerMobile);
        return;
      }
      _viewerCurrentIdx = Math.min(_viewerCurrentIdx, _viewerUrls.length - 1);
      openPhotoViewer(_viewerUrls, _viewerCurrentIdx, _viewerMobile);

      // Refresh checkin stored docs preview if visible
      _refreshCheckinStoredDocs(_viewerMobile);
    } else {
      _notify('Delete failed: ' + data.message, 'error');
    }
  } catch (err) {
    _notify('Delete error: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-trash-alt"></i> Remove'; }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 11.  Name autocomplete with stay-count badge
// ─────────────────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────────────────
// 12.  Check-in modal lifecycle
// ─────────────────────────────────────────────────────────────────────────────

function resetCheckinDocState() {
  _docCameraContext = 'checkin';
  stopAutoScan();
  stopDocStream();
  closePhotoViewer();
  closeDocCameraModal();

  _currentCheckinCustomer = null;
  resetDocCaptureUI();
  hideDocViewBtn();
  _hideCheckinStoredDocs();
  _hideFlagAlert();
  _hidePendingSettlementAlert();
  _hideWantsBillNote();
  _hideCheckinGstCard();
  _setIndicator('grey');
  hideMobileSuggestions();
  clearNameMismatch();
  collapseAddress();

}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function _setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function _showFlex(id, visible) {
  const el = document.getElementById(id);
  if (el) el.style.display = visible ? 'flex' : 'none';
}

function _fmtDate(raw) {
  if (!raw) return '';
  try {
    return new Date(raw).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch (_) { return raw; }
}

function _notify(msg, type) {
  if (typeof showNotification === 'function') showNotification(msg, type);
}

/**
 * Show the professional confirm dialog.
 * @param {object} opts
 *   title        – heading text
 *   message      – body text
 *   confirmLabel – button label (default "Delete")
 *   iconClass    – FontAwesome class (default "fa-trash-alt")
 *   iconColor    – CSS color for icon (default "#ef5350")
 *   bgColor      – confirm button bg (default "#c62828")
 * @param {function} onConfirm  – called when user confirms
 */
function _showConfirmDialog(opts, onConfirm) {
  const dialog  = document.getElementById('confirm-dialog');
  if (!dialog) { if (confirm(opts.title + '\n' + (opts.message || ''))) onConfirm(); return; }

  document.getElementById('confirm-dialog-title').textContent   = opts.title   || 'Are you sure?';
  document.getElementById('confirm-dialog-message').textContent = opts.message || '';
  document.getElementById('confirm-dialog-icon').className      = 'fas ' + (opts.iconClass || 'fa-trash-alt');
  document.getElementById('confirm-dialog-icon').style.color    = opts.iconColor || '#ef5350';
  document.getElementById('confirm-dialog-ok').textContent      = opts.confirmLabel || 'Delete';
  document.getElementById('confirm-dialog-ok').style.background = opts.bgColor || '#c62828';

  dialog.style.display = 'flex';

  // One-shot listeners — clone buttons to remove previous listeners
  const okBtn     = document.getElementById('confirm-dialog-ok');
  const cancelBtn = document.getElementById('confirm-dialog-cancel');
  const newOk     = okBtn.cloneNode(true);
  const newCancel = cancelBtn.cloneNode(true);
  okBtn.parentNode.replaceChild(newOk, okBtn);
  cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);

  document.getElementById('confirm-dialog-ok').textContent      = opts.confirmLabel || 'Delete';
  document.getElementById('confirm-dialog-ok').style.background = opts.bgColor || '#c62828';

  document.getElementById('confirm-dialog-ok').addEventListener('click', () => {
    dialog.style.display = 'none';
    onConfirm();
  });
  document.getElementById('confirm-dialog-cancel').addEventListener('click', () => {
    dialog.style.display = 'none';
  });
  // Also close on backdrop click
  dialog.onclick = (e) => { if (e.target === dialog) dialog.style.display = 'none'; };
}

function _fmtName(name) {
  if (!name || typeof name !== 'string') return name || '';
  const parts = name.trim().split(/\s+/);
  if (parts.length < 3) return name.trim();
  return `${parts[0]} ${parts[1][0].toUpperCase()} ${parts[parts.length - 1]}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initMobileLookup();
  initNameMismatchDetection();
  initAddressToggle();
  initDocCamera();
  initBookingMobileLookup();

  document.addEventListener('checkinModalOpened', resetCheckinDocState);
  document.querySelectorAll('#checkin-modal .close-btn').forEach(btn => {
    btn.addEventListener('click', resetCheckinDocState);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Booking modal — mobile lookup (suggestions + auto-fill name + ID preview)
// ─────────────────────────────────────────────────────────────────────────────

let _bookingMobileDebounce = null;

function initBookingMobileLookup() {
  const inp = document.getElementById('booking-guest-mobile');
  if (!inp) return;

  inp.addEventListener('input', function () {
    clearTimeout(_bookingMobileDebounce);
    const digits = this.value.replace(/\D/g, '');

    if (digits.length === 0) {
      _bkHideSuggestions();
      _bkClearGuestInfo();
      return;
    }
    if (digits.length < 4) { _bkHideSuggestions(); return; }

    _bookingMobileDebounce = setTimeout(async () => {
      if (digits.length >= 10) {
        _bkHideSuggestions();
        await _bkLookupAndFill(digits.slice(0, 10));
      } else {
        _bkFetchSuggestions(digits);
      }
    }, 180);
  });

  // Close dropdown on outside click
  document.addEventListener('click', (e) => {
    const sug = document.getElementById('booking-mobile-suggestions');
    if (sug && !inp.contains(e.target) && !sug.contains(e.target)) {
      _bkHideSuggestions();
    }
  });

  // Reset guest info when booking modal is closed
  document.getElementById('new-booking-modal')
    ?.querySelector('.close-btn')
    ?.addEventListener('click', _bkClearGuestInfo);
}

async function _bkFetchSuggestions(prefix) {
  try {
    const res  = await apiFetch('/search_customers_mobile', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix }),
    });
    const data = await res.json();
    _bkRenderSuggestions(data.success ? (data.customers || []) : []);
  } catch (e) { console.error('[booking-mobile] suggest error:', e); }
}

function _bkRenderSuggestions(customers) {
  const sug = document.getElementById('booking-mobile-suggestions');
  if (!sug) return;
  if (!customers.length) { _bkHideSuggestions(); return; }

  sug.innerHTML = '';
  customers.slice(0, 6).forEach(c => {
    const item = document.createElement('div');
    item.style.cssText = 'padding:0.45rem 0.75rem;cursor:pointer;border-bottom:1px solid #f0f0f0;font-size:0.85rem;display:flex;align-items:center;gap:0.5rem;';

    const stays = c.total_stays || 0;
    const stayBadge = stays > 0
      ? `<span style="background:#e3f2fd;color:#1565c0;border-radius:10px;padding:0.1rem 0.45rem;font-size:0.7rem;font-weight:700;white-space:nowrap;flex-shrink:0;">${stays}× stays</span>`
      : '';

    const sub = [c.mobile];
    if (c.total_spent)    sub.push('₹' + Number(c.total_spent).toLocaleString('en-IN'));
    if (c.last_stay_date) sub.push(_fmtDate(c.last_stay_date));

    item.innerHTML = `
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(_fmtName(c.name) || '(No name)')}</div>
        <div style="color:#888;font-size:0.76rem;">${sub.join(' · ')}</div>
      </div>${stayBadge}`;

    item.addEventListener('mouseover', () => { item.style.background = '#f5f5f5'; });
    item.addEventListener('mouseout',  () => { item.style.background = ''; });
    item.addEventListener('click', () => {
      const mi = document.getElementById('booking-guest-mobile');
      if (mi) mi.value = c.mobile;
      _bkHideSuggestions();
      _bkLookupAndFill(c.mobile);
    });
    sug.appendChild(item);
  });
  sug.style.display = 'block';
}

function _bkHideSuggestions() {
  const sug = document.getElementById('booking-mobile-suggestions');
  if (sug) sug.style.display = 'none';
}

async function _bkLookupAndFill(mobile) {
  try {
    const res  = await apiFetch(`/get_customer/${mobile}`);
    const data = await res.json();

    if (data.success && data.customer) {
      const c = data.customer;

      // Auto-fill name if blank
      const nameInp = document.getElementById('booking-guest-name');
      if (nameInp && !nameInp.value.trim()) {
        nameInp.value = _fmtName(c.name) || '';
      }

      // Show returning guest info bar
      const stays = c.total_stays || 0;
      const staysEl = document.getElementById('booking-guest-stays');
      if (staysEl) staysEl.textContent = stays > 0 ? `${stays} stay${stays !== 1 ? 's' : ''}` : 'first visit';

      const infoBar = document.getElementById('booking-guest-info');
      if (infoBar) infoBar.style.display = 'block';

      // Show ID badge + thumbnails if docs exist
      const urls    = c.id_doc_urls || [];
      const badge   = document.getElementById('booking-id-badge');
      const thumbEl = document.getElementById('booking-doc-thumbs');

      if (urls.length > 0) {
        if (badge) badge.style.display = 'inline';

        if (thumbEl) {
          thumbEl.style.display = 'flex';
          thumbEl.innerHTML = urls.map(url => `
            <img src="${url}" alt="ID"
              style="width:56px;height:40px;object-fit:cover;border-radius:5px;
                     border:1px solid #90caf9;cursor:pointer;"
              onclick="window.open('${url}','_blank')"
              title="Click to view full size" />`
          ).join('');
        }
      } else {
        if (badge)   badge.style.display   = 'none';
        if (thumbEl) thumbEl.style.display = 'none';
      }
    } else {
      _bkClearGuestInfo();
    }
  } catch (e) { console.error('[booking-mobile] lookup error:', e); }
}

function _bkClearGuestInfo() {
  const infoBar = document.getElementById('booking-guest-info');
  if (infoBar) infoBar.style.display = 'none';
  const badge   = document.getElementById('booking-id-badge');
  if (badge)   badge.style.display   = 'none';
  const thumbEl = document.getElementById('booking-doc-thumbs');
  if (thumbEl) { thumbEl.style.display = 'none'; thumbEl.innerHTML = ''; }
}


// ─────────────────────────────────────────────────────────────────────────────
// Multi-Room Booking modal — same "previous stayed guest" lookup as the
// regular booking form above, but generalised so it can attach to any
// mobile input: the one shared-guest field, or any of the per-room fields
// (which are created dynamically as rows are added). Deliberately lighter
// than _bkLookupAndFill — just the suggestions dropdown + name auto-fill,
// no returning-guest info bar / ID thumbnails, to keep the room-row cards
// compact.
// ─────────────────────────────────────────────────────────────────────────────
function attachMultiBookingMobileLookup(mobileInput, nameInput, suggestionsEl) {
  if (!mobileInput || !suggestionsEl || mobileInput._mbLookupAttached) return;
  mobileInput._mbLookupAttached = true;

  let debounceTimer = null;

  function hideSuggestions() {
    suggestionsEl.style.display = 'none';
  }

  async function fetchSuggestions(prefix) {
    try {
      const res = await apiFetch('/search_customers_mobile', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix }),
      });
      const data = await res.json();
      renderSuggestions(data.success ? (data.customers || []) : []);
    } catch (e) { console.error('[mb-mobile] suggest error:', e); }
  }

  function renderSuggestions(customers) {
    if (!customers.length) { hideSuggestions(); return; }
    suggestionsEl.innerHTML = '';
    customers.slice(0, 6).forEach(c => {
      const item = document.createElement('div');
      item.style.cssText = 'padding:0.45rem 0.75rem;cursor:pointer;border-bottom:1px solid #f0f0f0;font-size:0.85rem;display:flex;align-items:center;gap:0.5rem;';

      const stays = c.total_stays || 0;
      const stayBadge = stays > 0
        ? `<span style="background:#e3f2fd;color:#1565c0;border-radius:10px;padding:0.1rem 0.45rem;font-size:0.7rem;font-weight:700;white-space:nowrap;flex-shrink:0;">${stays}× stays</span>`
        : '';
      const sub = [c.mobile];
      if (c.last_stay_date) sub.push(_fmtDate(c.last_stay_date));

      item.innerHTML = `
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(_fmtName(c.name) || '(No name)')}</div>
          <div style="color:#888;font-size:0.76rem;">${sub.join(' · ')}</div>
        </div>${stayBadge}`;

      item.addEventListener('mouseover', () => { item.style.background = '#f5f5f5'; });
      item.addEventListener('mouseout',  () => { item.style.background = ''; });
      item.addEventListener('click', () => {
        mobileInput.value = c.mobile;
        hideSuggestions();
        lookupAndFillName(c.mobile);
      });
      suggestionsEl.appendChild(item);
    });
    suggestionsEl.style.display = 'block';
  }

  async function lookupAndFillName(mobile) {
    try {
      const res  = await apiFetch(`/get_customer/${mobile}`);
      const data = await res.json();
      if (data.success && data.customer && nameInput && !nameInput.value.trim()) {
        nameInput.value = _fmtName(data.customer.name) || '';
      }
    } catch (e) { console.error('[mb-mobile] lookup error:', e); }
  }

  mobileInput.addEventListener('input', function () {
    clearTimeout(debounceTimer);
    const digits = this.value.replace(/\D/g, '');
    if (digits.length < 4) { hideSuggestions(); return; }
    debounceTimer = setTimeout(async () => {
      if (digits.length >= 10) {
        hideSuggestions();
        await lookupAndFillName(digits.slice(0, 10));
      } else {
        fetchSuggestions(digits);
      }
    }, 180);
  });

  document.addEventListener('click', (e) => {
    if (!mobileInput.contains(e.target) && !suggestionsEl.contains(e.target)) {
      hideSuggestions();
    }
  });
}
