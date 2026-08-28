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

const MAX_DOC_PHOTOS = 3;

// ── Module state ─────────────────────────────────────────────────────────────
let _currentCheckinCustomer = null;
let _docStream               = null;
let _docCapturedBlobs        = [];   // [{blob, url}, …] — committed on check-in submit
let _mobileDebounceTimer     = null;
let _nameDebounceTimer       = null;
let _viewerCurrentIdx        = 0;
let _viewerUrls              = [];

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

window.uploadPendingDocIfAny = async function (mobile) {
  if (!_docCapturedBlobs.length) return true;
  // Fix 14: prevent re-entry if a previous call is still in-flight
  if (_checkinUploadLock) return false;
  const digits = (mobile || '').replace(/\D/g, '');
  if (digits.length !== 10) return true;

  _checkinUploadLock = true;
  try {
    const items = [..._docCapturedBlobs];
    // Parallel uploads are safe now: the server appends URLs with an atomic
    // ArrayUnion (create/AlreadyExists handles the brand-new-customer race),
    // so concurrent photos can no longer drop each other's URL. Wall-clock
    // for a multi-photo check-in is max(photo) instead of sum(photos).
    const results = await Promise.all(items.map(async (item, i) => {
      const form = new FormData();
      form.append('mobile',   digits);
      form.append('document', item.blob, `doc_${Date.now()}_${i}.jpg`);
      const res  = await apiFetch('/upload_customer_document', { method: 'POST', body: form });
      const data = await res.json();
      if (!data.success) {
        _notify('ID document upload failed: ' + (data.message || 'unknown'), 'error');
        return false;
      }
      URL.revokeObjectURL(item.url);
      return true;
    }));
    if (results.some(ok => !ok)) return false;
    _docCapturedBlobs = [];
    return true;
  } catch (err) {
    _notify('ID document upload error: ' + err.message, 'error');
    return false;
  } finally {
    _checkinUploadLock = false;
  }
};

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
  newInput?.addEventListener('change', function() {
    const files = Array.from(this.files || []);
    if (!files.length) return;

    let added = 0;
    for (const file of files) {
      if (_docCapturedBlobs.length >= MAX_DOC_PHOTOS) break;
      const url = URL.createObjectURL(file);
      _docCapturedBlobs.push({ blob: file, url });
      added++;
    }

    if (added === 0) {
      _notify(`Maximum ${MAX_DOC_PHOTOS} photos already selected`, 'warning');
    } else if (_docCapturedBlobs.length >= MAX_DOC_PHOTOS && files.length > added) {
      _notify(`Maximum ${MAX_DOC_PHOTOS} photos reached — only ${added} added`, 'warning');
    }

    _renderCheckoutPendingStrip();
    // Reset so the same file can be re-selected if needed
    this.value = '';
  });
};

/**
 * Apply a scanned-document effect to a canvas in-place.
 *
 * Steps (all done in a single pixel loop):
 *   1. Grayscale — removes colour noise from phone photos of documents.
 *   2. Contrast boost — makes text darker and background whiter,
 *      mimicking the output of a real document scanner.
 *   3. Brightness nudge — lifts midtones so off-white paper reads as white.
 */
function _applyScanEffect(canvas) {
  const ctx  = canvas.getContext('2d');
  const imgd = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d    = imgd.data;

  // Tuning constants
  const CONTRAST   = 1.9;   // >1 = more contrast; 1.0 = no change
  const BRIGHTNESS = 18;    // additive lift in [0,255]; 0 = no change

  for (let i = 0; i < d.length; i += 4) {
    // 1. Perceptual grayscale (ITU-R BT.601 luma coefficients)
    let v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

    // 2. Contrast: pivot around 128
    v = (v - 128) * CONTRAST + 128;

    // 3. Brightness nudge
    v += BRIGHTNESS;

    // Clamp to [0, 255]
    v = v < 0 ? 0 : v > 255 ? 255 : v;

    d[i] = d[i + 1] = d[i + 2] = v;
    // d[i+3] (alpha) is left unchanged
  }

  ctx.putImageData(imgd, 0, 0);
}

/**
 * Resize, apply scan effect, and compress an image Blob to JPEG.
 * Caps the longest side at MAX_SIDE px.
 * Falls back to the original Blob on any error.
 */
async function _compressImage(blob) {
  const MAX_SIDE = 1280;
  const QUALITY  = 0.88;   // slightly higher — grayscale compresses well anyway
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
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);

      // Apply scan effect after drawing
      _applyScanEffect(canvas);

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

async function _uploadCheckoutDoc(file) {
  // Compress before sending — reduces a 5 MB phone photo to ~200–350 KB
  const compressed = await _compressImage(file);
  const form = new FormData();
  form.append('mobile',   _checkoutMobile);
  form.append('document', compressed, `checkout_doc_${Date.now()}.jpg`);

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

  if (!_docCapturedBlobs.length) {
    strip.style.display = 'none';
    thumbEl.innerHTML   = '';
    return;
  }

  // Update count badge
  const n = _docCapturedBlobs.length;
  if (countBadge) countBadge.textContent = `${n} photo${n !== 1 ? 's' : ''}`;

  thumbEl.innerHTML = '';
  _docCapturedBlobs.forEach((item, i) => {
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
    img.addEventListener('click', () => openPhotoViewer(_docCapturedBlobs.map(b => b.url), i, ''));

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
      _docCapturedBlobs.splice(i, 1);
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
  if (!_docCapturedBlobs.length) return;

  _checkoutUploadLock = true;
  const uploadBtn = document.getElementById('checkout-pending-upload-btn');
  if (uploadBtn) { uploadBtn.disabled = true; uploadBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…'; }

  try {
    const items = [..._docCapturedBlobs];
    // Upload all files in parallel — the Firestore transaction inside
    // upload_document uses ArrayUnion + optimistic retry, so concurrent
    // writes to the same customer doc are safe and much faster than sequential.
    const results = await Promise.all(items.map(item => _uploadCheckoutDoc(item.blob)));
    const allOk   = results.every(Boolean);

    // Revoke object URLs for successfully uploaded items
    items.forEach((item, i) => { if (results[i]) URL.revokeObjectURL(item.url); });

    if (allOk) {
      _docCapturedBlobs = [];
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
  _docCapturedBlobs.forEach(item => URL.revokeObjectURL(item.url));
  _docCapturedBlobs = [];
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
        <div class="ms-name">${_fmtName(c.name) || '(No name)'}</div>
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

function _applyPendingSettlementAlert(customer) {
  const alertEl   = document.getElementById('checkin-pending-settlement-alert');
  const detailsEl = document.getElementById('checkin-pending-settlement-details');
  const dateEl    = document.getElementById('checkin-pending-settlement-date');
  if (!alertEl) return;

  if (customer && customer.has_pending_settlement && customer.pending_settlement_amount) {
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

function _hidePendingSettlementAlert() {
  const alertEl = document.getElementById('checkin-pending-settlement-alert');
  if (alertEl) alertEl.style.display = 'none';
  const detailsEl = document.getElementById('checkin-pending-settlement-details');
  if (detailsEl) detailsEl.textContent = '';
  const dateEl = document.getElementById('checkin-pending-settlement-date');
  if (dateEl) dateEl.textContent = '';
}

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
    img.src           = url;
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

function _drawGuide(progress) {
  const overlay = document.getElementById('doc-scan-overlay');
  if (!overlay) return;
  const ctx = overlay.getContext('2d');
  const W   = overlay.width  || 640;
  const H   = overlay.height || 360;

  ctx.clearRect(0, 0, W, H);

  // Guide rectangle — computed so it always fits and keeps the correct shape.
  // On a portrait phone frame (W < H) cards get their width from W; pages from H.
  let gW, gH;
  if (_docType === 'card') {
    // ID / Aadhaar card: landscape credit-card ratio 85.6 × 53.98 mm = 1.586 : 1
    // Try width-led first
    gW = W * 0.86;
    gH = gW / 1.586;
    // If card is taller than 78% of frame, shrink height-led instead
    if (gH > H * 0.78) {
      gH = H * 0.78;
      gW = gH * 1.586;
    }
  } else {
    // A4 / long document: portrait 0.707 : 1  (width : height)
    // Try height-led first so it fills the vertical space
    gH = H * 0.88;
    gW = gH * 0.707;
    // If wider than 80% of frame, shrink width-led
    if (gW > W * 0.80) {
      gW = W * 0.80;
      gH = gW / 0.707;
    }
  }

  const gX = (W - gW) / 2;
  const gY = (H - gH) / 2;

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

  // Downscale at capture: ID documents stay perfectly readable at 1280px
  // on the long edge, and upload time scales with pixel count. A 4K camera
  // frame at q=0.90 produced 1.5-4 MB JPEGs; capped at 1280px the same shot
  // is ~150-350 KB — the upload stops dominating check-in time.
  const MAX_EDGE = 1280;
  const srcW = feed.videoWidth  || 1280;
  const srcH = feed.videoHeight || 720;
  const _scale = Math.min(1, MAX_EDGE / Math.max(srcW, srcH));
  const canvas  = document.createElement('canvas');
  canvas.width  = Math.round(srcW * _scale);
  canvas.height = Math.round(srcH * _scale);
  const ctx     = canvas.getContext('2d');
  ctx.drawImage(feed, 0, 0, canvas.width, canvas.height);

  // Apply scanned-document look
  _applyScannedLook(ctx, canvas.width, canvas.height);

  canvas.toBlob(blob => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);

    // Push to blobs array immediately (so "Add Another" works)
    _docCapturedBlobs.push({ blob, url });

    // Show in modal preview
    const prevImg = document.getElementById('doc-preview-img');
    if (prevImg) prevImg.src = url;

    const feedSec    = document.getElementById('doc-cam-modal-feed-section');
    const previewSec = document.getElementById('doc-cam-modal-preview-section');
    if (feedSec)    feedSec.style.display    = 'none';
    if (previewSec) { previewSec.style.display = 'flex'; previewSec.style.flexDirection = 'column'; }

    stopDocStream();

    // Update "Add Another" button visibility in preview
    const addAnotherBtn = document.getElementById('doc-add-photo-btn');
    if (addAnotherBtn) {
      addAnotherBtn.style.display = _docCapturedBlobs.length < MAX_DOC_PHOTOS ? 'flex' : 'none';
    }
  }, 'image/jpeg', 0.85);
}

function _applyScannedLook(ctx, w, h) {
  const d        = ctx.getImageData(0, 0, w, h);
  const px       = d.data;
  const contrast = 1.35;
  for (let i = 0; i < px.length; i += 4) {
    const lum  = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
    px[i]      = px[i]     * 0.7 + lum * 0.3;
    px[i + 1]  = px[i + 1] * 0.7 + lum * 0.3;
    px[i + 2]  = px[i + 2] * 0.7 + lum * 0.3;
    px[i]      = Math.min(255, Math.max(0, (px[i]     - 128) * contrast + 128));
    px[i + 1]  = Math.min(255, Math.max(0, (px[i + 1] - 128) * contrast + 128));
    px[i + 2]  = Math.min(255, Math.max(0, (px[i + 2] - 128) * contrast + 128));
  }
  ctx.putImageData(d, 0, 0);
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

async function onDocFileSelected() {
  const file = document.getElementById('doc-file-input')?.files[0];
  if (!file || _docCapturedBlobs.length >= MAX_DOC_PHOTOS) return;
  // Compress BEFORE queueing — a raw phone photo is 3-8 MB; capped at
  // 1280px JPEG it's ~150-350 KB. This path previously uploaded the
  // ORIGINAL file and was the single slowest part of photo check-ins.
  // _compressImage falls back to the original blob on any error.
  const blob = await _compressImage(file);
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

function openPhotoViewer(urls, startIdx, mobile) {
  if (!urls || !urls.length) return;
  _viewerUrls       = urls;
  _viewerCurrentIdx = startIdx || 0;
  _viewerMobile     = (mobile || '').replace(/\D/g, '');

  _setText('doc-viewer-count', `${urls.length} photo${urls.length !== 1 ? 's' : ''} on file`);

  const thumbsEl = document.getElementById('doc-viewer-thumbs');
  if (thumbsEl) {
    thumbsEl.innerHTML = '';
    urls.forEach((url, i) => {
      const img     = document.createElement('img');
      img.src       = url;
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

  const viewer = document.getElementById('doc-photo-viewer');
  if (viewer) viewer.style.display = 'flex';
}

function setViewerPhoto(idx) {
  _viewerCurrentIdx = idx;
  const url = _viewerUrls[idx];
  const mainImg  = document.getElementById('doc-viewer-main-img');
  if (mainImg)  mainImg.src = url;
  const openLink = document.getElementById('doc-viewer-open-link');
  if (openLink) openLink.href = url;
  document.querySelectorAll('.doc-thumb').forEach((el, i) => el.classList.toggle('active', i === idx));
}

function navigateViewer(delta) {
  setViewerPhoto((_viewerCurrentIdx + delta + _viewerUrls.length) % _viewerUrls.length);
}

function closePhotoViewer() {
  const viewer = document.getElementById('doc-photo-viewer');
  if (viewer) viewer.style.display = 'none';
}

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
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-trash-alt"></i> Delete &amp; Retake'; }
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
        <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_fmtName(c.name) || '(No name)'}</div>
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
          <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_fmtName(c.name) || '(No name)'}</div>
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
