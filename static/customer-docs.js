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
  const digits = (mobile || '').replace(/\D/g, '');
  if (digits.length !== 10) return true;

  try {
    for (const item of _docCapturedBlobs) {
      const form = new FormData();
      form.append('mobile',   digits);
      form.append('document', item.blob, `doc_${Date.now()}.jpg`);
      const res  = await fetch('/upload_customer_document', { method: 'POST', body: form });
      const data = await res.json();
      if (!data.success) {
        _notify('ID document upload failed: ' + (data.message || 'unknown'), 'error');
        return false;
      }
    }
    _docCapturedBlobs = [];
    return true;
  } catch (err) {
    _notify('ID document upload error: ' + err.message, 'error');
    return false;
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

  const digits = (mobile || '').replace(/\D/g, '');
  if (digits.length !== 10) return;

  try {
    const res  = await fetch(`/get_customer/${digits}`);
    const data = await res.json();
    if (data.success && data.customer) {
      const urls = data.customer.id_doc_urls || [];
      if (urls.length > 0) {
        btn._docUrls      = urls;
        btn.style.display = 'inline-flex';
        btn.title         = `View ${urls.length} ID document${urls.length !== 1 ? 's' : ''}`;
      }
    }
  } catch (_) {}
};

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
    const res  = await fetch('/search_customers_mobile', {
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
    item.style.cssText = 'padding:0.45rem 0.75rem;cursor:pointer;border-bottom:1px solid #f0f0f0;font-size:0.85rem;display:flex;align-items:center;gap:0.5rem';

    const stays     = c.total_stays || 0;
    const stayBadge = stays > 0
      ? `<span style="background:#e3f2fd;color:#1565c0;border-radius:10px;padding:0.1rem 0.45rem;font-size:0.7rem;font-weight:700;white-space:nowrap;flex-shrink:0;">${stays}× stays</span>`
      : '';

    const sub = [c.mobile];
    if (c.total_spent)    sub.push('₹' + Number(c.total_spent).toLocaleString('en-IN'));
    if (c.last_stay_date) sub.push(_fmtDate(c.last_stay_date));

    item.innerHTML = `
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_fmtName(c.name) || '(No name)'}</div>
        <div style="color:#888;font-size:0.76rem">${sub.join(' · ')}</div>
      </div>${stayBadge}`;

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

async function lookupAndFillCustomer(mobile) {
  try {
    const res  = await fetch(`/get_customer/${mobile}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (data.success && data.customer) {
      _currentCheckinCustomer = data.customer;
      autoFillFromCustomer(data.customer);
      _applyIndicator(data.customer);
      _applyDocViewBtn(data.customer);
    } else {
      _currentCheckinCustomer = null;
      clearNameMismatch();
      hideDocViewBtn();
      _setIndicator('yellow');
    }
  } catch (err) { console.error('[customer-docs] Mobile lookup error:', err); }
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

function showDocViewBtn(urls) {
  const btn = document.getElementById('doc-view-btn');
  if (!btn) return;
  btn._docUrls      = urls;
  btn.style.display = 'inline-flex';
  btn.title         = `View ${urls.length} ID document${urls.length !== 1 ? 's' : ''}`;
}

function hideDocViewBtn() {
  const btn = document.getElementById('doc-view-btn');
  if (btn) btn.style.display = 'none';
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

  // Doc type toggle
  document.getElementById('doc-type-card')?.addEventListener('click', () => _setDocType('card'));
  document.getElementById('doc-type-page')?.addEventListener('click', () => _setDocType('page'));

  // View-photos buttons
  document.getElementById('doc-view-btn')?.addEventListener('click', () => {
    openPhotoViewer(document.getElementById('doc-view-btn')._docUrls || []);
  });
  document.getElementById('checkout-doc-view-btn')?.addEventListener('click', () => {
    openPhotoViewer(document.getElementById('checkout-doc-view-btn')._docUrls || []);
  });

  // Photo viewer controls
  document.getElementById('doc-viewer-close')?.addEventListener('click', closePhotoViewer);
  document.getElementById('doc-photo-viewer')?.addEventListener('click', e => {
    if (e.target === document.getElementById('doc-photo-viewer')) closePhotoViewer();
  });
  document.getElementById('doc-viewer-prev')?.addEventListener('click', () => navigateViewer(-1));
  document.getElementById('doc-viewer-next')?.addEventListener('click', () => navigateViewer(+1));
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

  const canvas  = document.createElement('canvas');
  canvas.width  = feed.videoWidth  || 1280;
  canvas.height = feed.videoHeight || 720;
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
  }, 'image/jpeg', 0.90);
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

/** "Done" — finalise current blob (already in array), close modal, render strip */
function useDocPhoto() {
  renderThumbStrip();
  _updateAddMoreBtn();
  _setIndicator('green');
  closeDocCameraModal();
}

function onDocFileSelected() {
  const file = document.getElementById('doc-file-input')?.files[0];
  if (!file || _docCapturedBlobs.length >= MAX_DOC_PHOTOS) return;
  const url = URL.createObjectURL(file);
  _docCapturedBlobs.push({ blob: file, url });
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

function openPhotoViewer(urls, startIdx) {
  if (!urls || !urls.length) return;
  _viewerUrls       = urls;
  _viewerCurrentIdx = startIdx || 0;

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

// ─────────────────────────────────────────────────────────────────────────────
// 11.  Name autocomplete with stay-count badge
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
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();
    if (!data.success || !data.customers.length) { suggestions.style.display = 'none'; return; }

    suggestions.innerHTML = '';
    data.customers.slice(0, 6).forEach(c => {
      const item = document.createElement('div');
      item.style.cssText = 'padding:0.45rem 0.75rem;cursor:pointer;border-bottom:1px solid #f0f0f0;font-size:0.85rem;display:flex;align-items:center;gap:0.5rem';

      const flagHtml  = c.flag?.is_flagged
        ? '<span style="color:#c62828;font-size:0.72rem;flex-shrink:0"><i class="fas fa-flag"></i></span>' : '';
      const stays     = c.total_stays || 0;
      const stayBadge = stays > 0
        ? `<span style="background:#e3f2fd;color:#1565c0;border-radius:10px;padding:0.1rem 0.45rem;font-size:0.7rem;font-weight:700;white-space:nowrap;flex-shrink:0;">${stays}× stays</span>` : '';

      const sub = [c.mobile];
      if (c.total_spent)    sub.push('₹' + Number(c.total_spent).toLocaleString('en-IN'));
      if (c.last_stay_date) sub.push(_fmtDate(c.last_stay_date));

      item.innerHTML = `
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_fmtName(c.name)}</div>
          <div style="color:#888;font-size:0.76rem">${sub.join(' · ')}</div>
        </div>${stayBadge}${flagHtml}`;

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
  } catch (err) { console.error('[customer-docs] Name search error:', err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// 12.  Check-in modal lifecycle
// ─────────────────────────────────────────────────────────────────────────────

function resetCheckinDocState() {
  stopAutoScan();
  stopDocStream();
  closePhotoViewer();
  closeDocCameraModal();

  _currentCheckinCustomer = null;
  resetDocCaptureUI();
  hideDocViewBtn();
  _setIndicator('grey');
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
    return new Date(raw).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch (_) { return raw; }
}

function _notify(msg, type) {
  if (typeof showNotification === 'function') showNotification(msg, type);
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
  initNameSearch();
  initAddressToggle();
  initDocCamera();

  document.addEventListener('checkinModalOpened', resetCheckinDocState);
  document.querySelectorAll('#checkin-modal .close-btn').forEach(btn => {
    btn.addEventListener('click', resetCheckinDocState);
  });
});
