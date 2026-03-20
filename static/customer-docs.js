/**
 * customer-docs.js  (v4)
 *
 * Check-in and checkout enhancements:
 *   1.  Mobile partial-input suggestions  (4+ digits → dropdown)
 *   2.  Direct auto-fill on mobile match  (no confirm-card step)
 *   3.  Name autocomplete  (case-insensitive, 1-char min, 180ms debounce)
 *   4.  Name mismatch warning  (inline, when typed name ≠ record on file)
 *   5.  Returning-guest panel with rich stats (shown immediately on match)
 *   6.  Collapsible address field
 *   7.  Smart camera enable/disable  +  view-photos button in header
 *   8.  Document camera capture + upload  (max 3 photos)
 *   9.  Photo lightbox with thumbnail strip + prev/next navigation
 *  10.  Flagged customer warning modal
 *  11.  Flag-on-checkout  (writes to /flag_customer after successful checkout)
 */

// ── Module state ─────────────────────────────────────────────────────────────
let _currentCheckinCustomer = null;  // full customer object once a match is found
let _docStream               = null;
let _docCapturedBlob         = null;
let _mobileDebounceTimer     = null;
let _nameDebounceTimer       = null;
let _viewerCurrentIdx        = 0;
let _viewerUrls              = [];

// ─────────────────────────────────────────────────────────────────────────────
// 1.  Mobile partial-input lookup
// ─────────────────────────────────────────────────────────────────────────────

function initMobileLookup() {
  const mobileInput = document.getElementById('guest-mobile');
  if (!mobileInput) return;

  mobileInput.addEventListener('input', function () {
    clearTimeout(_mobileDebounceTimer);
    const digits = this.value.replace(/\D/g, '');

    // Fully cleared → reset everything
    if (digits.length === 0) {
      hideMobileSuggestions();
      _currentCheckinCustomer = null;
      clearReturningGuestInfo();
      resetDocCaptureUI();
      disableDocCamera('Enter mobile number first');
      hideDocViewBtn();
      clearNameMismatch();
      return;
    }

    // Too short for a useful search
    if (digits.length < 4) {
      hideMobileSuggestions();
      return;
    }

    _mobileDebounceTimer = setTimeout(async () => {
      if (digits.length >= 10) {
        // Full mobile entered — direct lookup, no dropdown
        hideMobileSuggestions();
        await lookupAndFillCustomer(digits.slice(0, 10));
      } else {
        // Partial — show dropdown suggestions
        fetchMobileSuggestions(digits);
      }
    }, 180);
  });

  // Dismiss dropdown when clicking outside
  document.addEventListener('click', e => {
    const inp = document.getElementById('guest-mobile');
    const sug = document.getElementById('mobile-suggestions');
    if (inp && sug && !inp.contains(e.target) && !sug.contains(e.target)) {
      hideMobileSuggestions();
    }
  });
}

async function fetchMobileSuggestions(prefix) {
  try {
    const res  = await fetch('/search_customers_mobile', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ prefix }),
    });
    const data = await res.json();
    renderMobileSuggestions(data.success ? (data.customers || []) : []);
  } catch (err) {
    console.error('[customer-docs] Mobile suggest error:', err);
  }
}

function renderMobileSuggestions(customers) {
  const sug = document.getElementById('mobile-suggestions');
  if (!sug) return;

  if (!customers.length) { hideMobileSuggestions(); return; }

  sug.innerHTML = '';
  customers.slice(0, 6).forEach(c => {
    const item = document.createElement('div');
    item.style.cssText = 'padding:0.45rem 0.75rem;cursor:pointer;border-bottom:1px solid #f0f0f0;font-size:0.85rem;display:flex;align-items:center;gap:0.5rem';

    const subParts = [c.mobile];
    if (c.total_spent)    subParts.push('\u20B9' + Number(c.total_spent).toLocaleString('en-IN'));
    if (c.last_stay_date) subParts.push(_fmtDate(c.last_stay_date));

    item.innerHTML = `
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_fmtName(c.name) || '(No name)'}</div>
        <div style="color:#888;font-size:0.76rem">${subParts.join(' \u00B7 ')}</div>
      </div>`;

    item.addEventListener('mouseover', () => { item.style.background = '#f5f5f5'; });
    item.addEventListener('mouseout',  () => { item.style.background = ''; });
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

/**
 * Core lookup: fetch full customer by mobile, auto-fill form, show panels.
 * Called from mobile input (10 digits), mobile dropdown selection, and name
 * dropdown selection.
 */
async function lookupAndFillCustomer(mobile) {
  try {
    const res  = await fetch(`/get_customer/${mobile}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (data.success && data.customer) {
      _currentCheckinCustomer = data.customer;
      autoFillFromCustomer(data.customer);
      showReturningGuestPanel(data.customer);
      applyDocCameraState(data.customer);
    } else {
      // Unknown number — new guest, enable camera
      _currentCheckinCustomer = null;
      clearReturningGuestInfo();
      enableDocCamera();
      hideDocViewBtn();
      clearNameMismatch();
    }
  } catch (err) {
    console.error('[customer-docs] Mobile lookup error:', err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2.  Auto-fill + name mismatch detection
// ─────────────────────────────────────────────────────────────────────────────

function autoFillFromCustomer(customer) {
  const nameInput = document.getElementById('guest-name');
  // Fill with formatted name — mobile uniquely identifies the customer
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

  // Compare against the formatted display name (what was auto-filled)
  const stored  = _fmtName(_currentCheckinCustomer.name).trim().toLowerCase();
  const entered = currentName.trim().toLowerCase();

  if (entered && entered !== stored) {
    warn.textContent = `\u26A0 Name on file: "${_fmtName(_currentCheckinCustomer.name)}"`;
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
// 3.  Returning-guest panel
// ─────────────────────────────────────────────────────────────────────────────

function showReturningGuestPanel(customer) {
  const panel = document.getElementById('returning-guest-panel');
  if (!panel) return;

  const stays      = customer.total_stays || 0;
  const spent      = customer.total_spent || 0;
  const lastStay   = _fmtDate(customer.last_stay_date) || '\u2014';
  const firstVisit = _fmtDate(customer.first_visit);

  _setText('rg-stays',     stays);
  _setText('rg-spent',     '\u20B9' + spent.toLocaleString('en-IN'));
  _setText('rg-last-stay', lastStay);

  const firstLabel = document.getElementById('rg-first-stay-label');
  if (firstLabel) firstLabel.textContent = firstVisit ? `Since ${firstVisit}` : '';

  const addrRow = document.getElementById('rg-address-row');
  const addrEl  = document.getElementById('rg-address');
  if (addrRow && addrEl) {
    if (customer.address && customer.address.trim()) {
      addrEl.textContent    = customer.address;
      addrRow.style.display = 'block';
    } else {
      addrRow.style.display = 'none';
    }
  }

  panel.style.display = 'block';
}

function clearReturningGuestInfo() {
  const panel = document.getElementById('returning-guest-panel');
  if (panel) panel.style.display = 'none';
}

// ─────────────────────────────────────────────────────────────────────────────
// 4.  Collapsible address field
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
// 5.  Camera state + view-photos button
// ─────────────────────────────────────────────────────────────────────────────

function applyDocCameraState(customer) {
  const urls = customer.id_doc_urls || [];

  if (urls.length === 0) {
    enableDocCamera();
    hideDocViewBtn();
    _showDocHint(true);
  } else if (urls.length >= 3) {
    disableDocCamera('Maximum documents already on file');
    showDocViewBtn(urls);
    _showDocHint(false);
  } else {
    enableDocCamera();
    showDocViewBtn(urls);
    _showDocHint(false);
  }
}

function _showDocHint(visible) {
  const hint = document.getElementById('doc-missing-hint');
  if (hint) hint.style.display = visible ? 'flex' : 'none';
}

function enableDocCamera() {
  const btn = document.getElementById('doc-camera-btn');
  if (!btn) return;
  btn.disabled = false;
  btn.classList.remove('doc-cam-disabled');
  btn.classList.add('doc-cam-enabled');
  btn.title = 'Capture ID document';
}

function disableDocCamera(reason) {
  const btn = document.getElementById('doc-camera-btn');
  if (!btn) return;
  btn.disabled = true;
  btn.classList.add('doc-cam-disabled');
  btn.classList.remove('doc-cam-enabled');
  btn.title = reason || 'Document already on file';
}

function showDocViewBtn(urls) {
  const btn = document.getElementById('doc-view-btn');
  if (!btn) return;
  btn._docUrls      = urls;
  btn.style.display = 'inline-flex';
  const count = urls.length;
  btn.title = `View ${count} ID document${count !== 1 ? 's' : ''}`;
}

function hideDocViewBtn() {
  const btn = document.getElementById('doc-view-btn');
  if (btn) btn.style.display = 'none';
}

// ─────────────────────────────────────────────────────────────────────────────
// 6.  Document camera capture + upload
// ─────────────────────────────────────────────────────────────────────────────

function initDocCamera() {
  document.getElementById('doc-camera-btn')?.addEventListener('click',         openDocCamera);
  document.getElementById('doc-capture-btn')?.addEventListener('click',        captureDocPhoto);
  document.getElementById('doc-cancel-camera-btn')?.addEventListener('click',  closeDocCamera);
  document.getElementById('doc-retake-btn')?.addEventListener('click',         openDocCamera);
  document.getElementById('doc-upload-btn')?.addEventListener('click',         uploadDocPhoto);
  document.getElementById('doc-file-input')?.addEventListener('change',        onDocFileSelected);
}

async function openDocCamera() {
  stopDocStream();
  resetDocCaptureUI();
  try {
    _docStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } }, audio: false,
    });
    const feed      = document.getElementById('doc-camera-feed');
    const container = document.getElementById('doc-camera-container');
    if (feed)      feed.srcObject          = _docStream;
    if (container) container.style.display = 'block';
  } catch (err) {
    console.warn('[customer-docs] Camera unavailable, using file picker:', err);
    document.getElementById('doc-file-input')?.click();
  }
}

function captureDocPhoto() {
  const feed             = document.getElementById('doc-camera-feed');
  const cameraContainer  = document.getElementById('doc-camera-container');
  const previewImg       = document.getElementById('doc-preview-img');
  const previewContainer = document.getElementById('doc-preview-container');
  if (!feed) return;

  const canvas  = document.createElement('canvas');
  canvas.width  = feed.videoWidth  || 640;
  canvas.height = feed.videoHeight || 480;
  canvas.getContext('2d').drawImage(feed, 0, 0, canvas.width, canvas.height);

  canvas.toBlob(blob => {
    _docCapturedBlob = blob;
    if (previewImg)       previewImg.src           = URL.createObjectURL(blob);
    if (previewContainer) previewContainer.style.display = 'block';
    if (cameraContainer)  cameraContainer.style.display  = 'none';
    stopDocStream();
    _showDocHint(false);  // photo captured — hide the reminder
  }, 'image/jpeg', 0.88);
}

function onDocFileSelected() {
  const file             = document.getElementById('doc-file-input')?.files[0];
  const previewImg       = document.getElementById('doc-preview-img');
  const previewContainer = document.getElementById('doc-preview-container');
  if (!file) return;
  _docCapturedBlob = file;
  if (previewImg)       previewImg.src           = URL.createObjectURL(file);
  if (previewContainer) previewContainer.style.display = 'block';
}

function stopDocStream() {
  if (_docStream) { _docStream.getTracks().forEach(t => t.stop()); _docStream = null; }
}

function closeDocCamera() { stopDocStream(); resetDocCaptureUI(); }

function resetDocCaptureUI() {
  ['doc-camera-container', 'doc-preview-container'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  const fi = document.getElementById('doc-file-input');
  if (fi) fi.value = '';
  _docCapturedBlob = null;
}

async function uploadDocPhoto() {
  const mobile = (document.getElementById('guest-mobile')?.value || '').replace(/\D/g, '');
  if (mobile.length !== 10) {
    _notify('Enter a valid 10-digit mobile number first', 'error'); return;
  }
  if (!_docCapturedBlob) { _notify('No document captured', 'error'); return; }

  const btn = document.getElementById('doc-upload-btn');
  if (btn) {
    btn.disabled  = true;
    btn.innerHTML = '<span class="loader" style="width:16px;height:16px;vertical-align:middle;margin-right:4px"></span>Uploading...';
  }

  try {
    const form = new FormData();
    form.append('mobile',   mobile);
    form.append('document', _docCapturedBlob, `doc_${Date.now()}.jpg`);

    const res  = await fetch('/upload_customer_document', { method: 'POST', body: form });
    const data = await res.json();

    if (data.success) {
      _notify('Document saved', 'success');
      resetDocCaptureUI();
      await lookupAndFillCustomer(mobile);
    } else {
      _notify(data.message || 'Upload failed', 'error');
    }
  } catch (err) {
    _notify('Upload error: ' + err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled  = false;
      btn.innerHTML = '<i class="fas fa-upload"></i> Save Document';
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7.  Photo viewer  (thumbnail strip + prev/next)
// ─────────────────────────────────────────────────────────────────────────────

function initDocViewBtn() {
  document.getElementById('doc-view-btn')?.addEventListener('click', () => {
    const urls = document.getElementById('doc-view-btn')._docUrls || [];
    openPhotoViewer(urls);
  });

  document.getElementById('doc-viewer-close')?.addEventListener('click', closePhotoViewer);
  document.getElementById('doc-photo-viewer')?.addEventListener('click', e => {
    if (e.target === document.getElementById('doc-photo-viewer')) closePhotoViewer();
  });

  document.getElementById('doc-viewer-prev')?.addEventListener('click', () => navigateViewer(-1));
  document.getElementById('doc-viewer-next')?.addEventListener('click', () => navigateViewer(+1));
}

function openPhotoViewer(urls) {
  if (!urls.length) return;
  _viewerUrls       = urls;
  _viewerCurrentIdx = 0;

  _setText('doc-viewer-count', `${urls.length} photo${urls.length !== 1 ? 's' : ''} on file`);

  const thumbsEl = document.getElementById('doc-viewer-thumbs');
  if (thumbsEl) {
    thumbsEl.innerHTML = '';
    urls.forEach((url, i) => {
      const img     = document.createElement('img');
      img.src       = url;
      img.alt       = `Doc ${i + 1}`;
      img.className = 'doc-thumb' + (i === 0 ? ' active' : '');
      img.addEventListener('click', () => setViewerPhoto(i));
      thumbsEl.appendChild(img);
    });
    thumbsEl.style.display = urls.length > 1 ? 'flex' : 'none';
  }

  setViewerPhoto(0);

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

  document.querySelectorAll('.doc-thumb').forEach((el, i) => {
    el.classList.toggle('active', i === idx);
  });
}

function navigateViewer(delta) {
  const next = (_viewerCurrentIdx + delta + _viewerUrls.length) % _viewerUrls.length;
  setViewerPhoto(next);
}

function closePhotoViewer() {
  const viewer = document.getElementById('doc-photo-viewer');
  if (viewer) viewer.style.display = 'none';
}

// ─────────────────────────────────────────────────────────────────────────────
// 8.  Name autocomplete  (fast, 1-char min, with spent + last visit)
// ─────────────────────────────────────────────────────────────────────────────

function initNameSearch() {
  const nameInput   = document.getElementById('guest-name');
  const suggestions = document.getElementById('name-suggestions');
  if (!nameInput || !suggestions) return;

  nameInput.addEventListener('input', function () {
    clearTimeout(_nameDebounceTimer);
    const q = this.value.trim();
    if (q.length < 1) { suggestions.style.display = 'none'; return; }
    _nameDebounceTimer = setTimeout(() => _fetchNameSuggestions(q), 180);
  });

  document.addEventListener('click', e => {
    if (!nameInput.contains(e.target) && !suggestions.contains(e.target)) {
      suggestions.style.display = 'none';
    }
  });
}

async function _fetchNameSuggestions(query) {
  const suggestions = document.getElementById('name-suggestions');
  if (!suggestions) return;

  try {
    const res  = await fetch('/search_customers', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ query }),
    });
    const data = await res.json();

    if (!data.success || !data.customers.length) {
      suggestions.style.display = 'none'; return;
    }

    suggestions.innerHTML = '';
    data.customers.slice(0, 6).forEach(c => {
      const item = document.createElement('div');
      item.style.cssText = 'padding:0.45rem 0.75rem;cursor:pointer;border-bottom:1px solid #f0f0f0;font-size:0.85rem;display:flex;align-items:center;gap:0.5rem';

      const flagHtml = c.flag?.is_flagged
        ? '<span style="color:#c62828;font-size:0.72rem;flex-shrink:0"><i class="fas fa-flag"></i></span>'
        : '';

      const subParts = [c.mobile];
      if (c.total_spent)    subParts.push('\u20B9' + Number(c.total_spent).toLocaleString('en-IN'));
      if (c.last_stay_date) subParts.push(_fmtDate(c.last_stay_date));

      item.innerHTML = `
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_fmtName(c.name)}</div>
          <div style="color:#888;font-size:0.76rem">${subParts.join(' \u00B7 ')}</div>
        </div>${flagHtml}`;

      item.addEventListener('mouseover', () => { item.style.background = '#f5f5f5'; });
      item.addEventListener('mouseout',  () => { item.style.background = ''; });
      item.addEventListener('click', () => {
        const ni = document.getElementById('guest-name');
        const mi = document.getElementById('guest-mobile');
        if (ni) ni.value = c.name;
        if (mi) mi.value = c.mobile;
        suggestions.style.display = 'none';
        hideMobileSuggestions();
        lookupAndFillCustomer(c.mobile);
      });

      suggestions.appendChild(item);
    });

    suggestions.style.display = 'block';
  } catch (err) {
    console.error('[customer-docs] Name search error:', err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 9.  Photo-missing reminder on check-in submit
// ─────────────────────────────────────────────────────────────────────────────

function initPhotoReminder() {
  const form = document.getElementById('checkin-form');
  if (!form) return;

  form.addEventListener('submit', () => {
    const existingDocs   = _currentCheckinCustomer?.id_doc_urls?.length || 0;
    const capturedNow    = !!_docCapturedBlob;

    if (existingDocs === 0 && !capturedNow) {
      // Non-blocking — let the submit continue, just nudge staff
      _notify(
        'No ID document on file for this guest — consider capturing one with the camera button',
        'warning'
      );
    }
  }, /* useCapture = */ false);
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. Check-in modal lifecycle
// ─────────────────────────────────────────────────────────────────────────────

function resetCheckinDocState() {
  stopDocStream();
  closePhotoViewer();
  _currentCheckinCustomer = null;
  _docCapturedBlob        = null;

  resetDocCaptureUI();
  clearReturningGuestInfo();
  disableDocCamera('Enter mobile number first');
  hideDocViewBtn();
  _showDocHint(false);
  hideMobileSuggestions();
  clearNameMismatch();
  collapseAddress();

  const nameSug = document.getElementById('name-suggestions');
  if (nameSug) nameSug.style.display = 'none';
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
    return new Date(raw).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
  } catch (_) { return raw; }
}

function _notify(msg, type) {
  if (typeof showNotification === 'function') showNotification(msg, type);
}

/**
 * Normalise a raw mobile string to a clean 10-digit Indian mobile number.
 * Mirrors the Python _clean_mobile() logic in customer_service.py.
 *   "9876543210"      → "9876543210"
 *   "+91 98765 43210" → "9876543210"
 *   "09876543210"     → "9876543210"
 *   "N/A" / ""        → ""           (invalid — caller should reject)
 */
function _cleanMobile(raw) {
  let digits = (raw || '').replace(/\D/g, '');
  if (digits.length >= 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0'))  digits = digits.slice(1);
  return digits.length === 10 ? digits : '';
}

/**
 * Format a full name as "First M Last" (middle name condensed to initial).
 * e.g. "Neeraj Suresh Ladwa"  →  "Neeraj S Ladwa"
 *      "Neeraj Ladwa"         →  "Neeraj Ladwa"   (unchanged)
 *      "Neeraj"               →  "Neeraj"          (unchanged)
 * Only the stored full name for inputs is ever left untouched; this is
 * used purely for compact display in dropdowns and panels.
 */
function _fmtName(name) {
  if (!name || typeof name !== 'string') return name || '';
  const parts = name.trim().split(/\s+/);
  if (parts.length < 3) return name.trim();
  // first  +  middle-initial  +  last
  return `${parts[0]} ${parts[1][0].toUpperCase()} ${parts[parts.length - 1]}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initMobileLookup();
  initNameMismatchDetection();
  initNameSearch();
  initAddressToggle();
  initDocCamera();
  initDocViewBtn();
  initPhotoReminder();

  document.addEventListener('checkinModalOpened', resetCheckinDocState);
  document.querySelectorAll('#checkin-modal .close-btn').forEach(btn => {
    btn.addEventListener('click', resetCheckinDocState);
  });
});
