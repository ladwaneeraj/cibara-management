/* ============================================================================
 * doc-scan.js — crop a photographed bill down to just the bill.
 * ----------------------------------------------------------------------------
 * A phone photo of an invoice is nearly always shot at an angle, on a desk,
 * with the keyboard and half a cup of tea in frame. This module lets the
 * operator mark the four corners of the paper and then flattens that
 * quadrilateral into a straight rectangle — the same perspective correction a
 * dedicated scanner app performs.
 *
 * Corners are placed by hand rather than auto-detected. Automatic edge
 * detection needs OpenCV.js, which is ~8 MB to pull down on a phone on mobile
 * data, and it still fails on the common case here: a white bill lying on a
 * pale counter. A drag-and-tap that always works beats a one-tap that
 * sometimes doesn't and needs this UI as a fallback anyway.
 *
 * No dependencies. Public API:
 *
 *     CibaraDocScan.scan(file) -> Promise<File|null>
 *
 *         Opens the editor over the page. Resolves with a new JPEG File
 *         containing the cropped, deskewed bill, or null if the operator
 *         cancelled. Non-image files resolve immediately with the original,
 *         so a PDF invoice passes straight through untouched.
 *
 *     CibaraDocScan.isSupported() -> boolean
 *
 * Everything happens on the device; only the cropped image is uploaded.
 * ==========================================================================*/

(function () {
  "use strict";

  // Longest edge of the produced image. ~A4 at 200dpi. Big enough for a CA to
  // read a line item, small enough to upload on a weak connection.
  var MAX_OUTPUT_EDGE = 1800;
  // Longest edge kept from the ORIGINAL photo before warping. A phone camera
  // hands over 12MP; warping that on the main thread is seconds of frozen UI
  // for detail the capped output throws away regardless.
  var MAX_SOURCE_EDGE = 2200;
  var JPEG_QUALITY = 0.88;
  // Corner handle hit radius in CSS pixels — generous, this is a finger.
  var HANDLE_HIT = 26;
  var HANDLE_DRAW = 11;

  function isSupported() {
    return typeof document !== "undefined" &&
      !!document.createElement("canvas").getContext &&
      typeof Promise !== "undefined";
  }

  // ── Geometry ──────────────────────────────────────────────────────────────

  /**
   * Solve the 3x3 homography H mapping four source points to four destination
   * points, returned as the 8 free coefficients (h33 fixed at 1).
   *
   * Each correspondence contributes two rows to an 8x8 system; we solve it by
   * Gaussian elimination with partial pivoting. Eight unknowns is small enough
   * that an explicit solver is clearer — and quicker — than pulling in a
   * matrix library.
   */
  function solveHomography(src, dst) {
    var a = [], b = [], i;
    for (i = 0; i < 4; i++) {
      var sx = src[i].x, sy = src[i].y, dx = dst[i].x, dy = dst[i].y;
      a.push([sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy]);
      b.push(dx);
      a.push([0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy]);
      b.push(dy);
    }

    var n = 8, j, k;
    for (i = 0; i < n; i++) {
      // Partial pivot — keeps the elimination stable when a corner sits on an
      // axis and produces a near-zero leading coefficient.
      var piv = i;
      for (k = i + 1; k < n; k++) {
        if (Math.abs(a[k][i]) > Math.abs(a[piv][i])) piv = k;
      }
      if (piv !== i) {
        var tr = a[i]; a[i] = a[piv]; a[piv] = tr;
        var tb = b[i]; b[i] = b[piv]; b[piv] = tb;
      }
      var d = a[i][i];
      if (Math.abs(d) < 1e-12) return null;      // degenerate quad
      for (j = i; j < n; j++) a[i][j] /= d;
      b[i] /= d;
      for (k = 0; k < n; k++) {
        if (k === i) continue;
        var f = a[k][i];
        if (!f) continue;
        for (j = i; j < n; j++) a[k][j] -= f * a[i][j];
        b[k] -= f * b[i];
      }
    }
    return b;   // [h11 h12 h13 h21 h22 h23 h31 h32]
  }

  function dist(p, q) {
    var dx = p.x - q.x, dy = p.y - q.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Output size for a quad: the longer of each opposing edge pair, so nothing
   * in the original is squeezed. Scaled down to MAX_OUTPUT_EDGE if needed.
   * Corner order is [top-left, top-right, bottom-right, bottom-left].
   */
  function outputSize(q) {
    var w = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
    var h = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
    w = Math.max(Math.round(w), 16);
    h = Math.max(Math.round(h), 16);
    var longest = Math.max(w, h);
    if (longest > MAX_OUTPUT_EDGE) {
      var s = MAX_OUTPUT_EDGE / longest;
      w = Math.round(w * s);
      h = Math.round(h * s);
    }
    return { w: w, h: h };
  }

  /**
   * Warp the quad `q` out of `srcCanvas` into a w x h rectangle.
   *
   * Inverse mapping with bilinear sampling: walk every destination pixel, push
   * it back through H into the source, and interpolate. Forward mapping would
   * leave holes wherever the transform stretches.
   */
  function warp(srcCanvas, q, w, h) {
    // No attributes here: getContext returns the EXISTING context and ignores
    // them on a second call, so passing willReadFrequently was a no-op. The
    // hint is set on the first call, in loadToCanvas.
    var sctx = srcCanvas.getContext("2d");
    var sw = srcCanvas.width, sh = srcCanvas.height;
    var sdata = sctx.getImageData(0, 0, sw, sh).data;

    // Destination-to-source, so solve with the roles reversed.
    var H = solveHomography(
      [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }], q);
    if (!H) return null;

    var out = new ImageData(w, h);
    var o = out.data;
    var h11 = H[0], h12 = H[1], h13 = H[2],
        h21 = H[3], h22 = H[4], h23 = H[5],
        h31 = H[6], h32 = H[7];

    for (var y = 0; y < h; y++) {
      var yb = y + 0.5;
      // Increments along a row are constant, so hoist the y terms.
      var nxB = h12 * yb + h13, nyB = h22 * yb + h23, dnB = h32 * yb + 1;
      for (var x = 0; x < w; x++) {
        var xb = x + 0.5;
        var den = h31 * xb + dnB;
        if (den === 0) den = 1e-9;
        var fx = (h11 * xb + nxB) / den;
        var fy = (h21 * xb + nyB) / den;

        var di = (y * w + x) << 2;
        if (fx < 0 || fy < 0 || fx > sw - 1 || fy > sh - 1) {
          // Outside the photo — a corner dragged past the edge. White, so it
          // reads as paper rather than a black band.
          o[di] = o[di + 1] = o[di + 2] = 255; o[di + 3] = 255;
          continue;
        }

        var x0 = fx | 0, y0 = fy | 0;
        var x1 = x0 + 1 > sw - 1 ? x0 : x0 + 1;
        var y1 = y0 + 1 > sh - 1 ? y0 : y0 + 1;
        var ax = fx - x0, ay = fy - y0;
        var w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay),
            w01 = (1 - ax) * ay,       w11 = ax * ay;
        var i00 = (y0 * sw + x0) << 2, i10 = (y0 * sw + x1) << 2,
            i01 = (y1 * sw + x0) << 2, i11 = (y1 * sw + x1) << 2;

        o[di]     = sdata[i00]     * w00 + sdata[i10]     * w10 + sdata[i01]     * w01 + sdata[i11]     * w11;
        o[di + 1] = sdata[i00 + 1] * w00 + sdata[i10 + 1] * w10 + sdata[i01 + 1] * w01 + sdata[i11 + 1] * w11;
        o[di + 2] = sdata[i00 + 2] * w00 + sdata[i10 + 2] * w10 + sdata[i01 + 2] * w01 + sdata[i11 + 2] * w11;
        o[di + 3] = 255;
      }
    }

    var oc = document.createElement("canvas");
    oc.width = w; oc.height = h;
    oc.getContext("2d").putImageData(out, 0, 0);
    return oc;
  }

  // ── Automatic edge detection (optional, lazy OpenCV.js) ─────────────────────
  // OpenCV.js is ~8 MB, so it is fetched ONLY when a caller passes autoDetect
  // (ID capture), never for the plain bill crop — those stay manual and light.
  // Everything here is best-effort: any failure resolves to null and the manual
  // corner editor takes over, so a capture is never blocked by a detection miss
  // or a CDN hiccup. Cached by the service worker after the first load.
  var CV_URL = "https://docs.opencv.org/4.x/opencv.js";
  var _cvPromise = null;

  function ensureCv() {
    if (_cvPromise) return _cvPromise;
    _cvPromise = new Promise(function (resolve, reject) {
      function ready() { return window.cv && window.cv.Mat; }
      if (ready()) { resolve(); return; }
      var settled = false;
      var timer = setTimeout(function () { finish(false, new Error("opencv load timeout")); }, 25000);
      function finish(ok, err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (ok) resolve(); else reject(err);
      }
      var s = document.createElement("script");
      s.src = CV_URL;
      s.async = true;
      s.onload = function () {
        var cv = window.cv;
        if (!cv) { finish(false, new Error("opencv missing after load")); return; }
        // Builds differ: a Promise, an already-initialised module, or one that
        // signals readiness through onRuntimeInitialized. Handle all three.
        if (typeof cv.then === "function") {
          cv.then(function (c) { window.cv = c; finish(true); }, function (e) { finish(false, e); });
          return;
        }
        if (cv.Mat) { finish(true); return; }
        cv.onRuntimeInitialized = function () { finish(true); };
        var poll = setInterval(function () {
          if (ready()) { clearInterval(poll); finish(true); }
        }, 100);
      };
      s.onerror = function () { finish(false, new Error("opencv failed to load")); };
      document.head.appendChild(s);
    });
    return _cvPromise;
  }

  // Order four points as [top-left, top-right, bottom-right, bottom-left] — the
  // corner order warp() and the editor expect.
  function orderQuad(pts) {
    var bySum = pts.slice().sort(function (a, b) { return (a.x + a.y) - (b.x + b.y); });
    var byDiff = pts.slice().sort(function (a, b) { return (a.y - a.x) - (b.y - b.x); });
    return [bySum[0], byDiff[0], bySum[3], byDiff[3]]; // TL, TR, BR, BL
  }

  /**
   * Detect the largest convex 4-sided paper/card contour in `srcCanvas`.
   * Resolves with four source-pixel corners [TL,TR,BR,BL], or null when nothing
   * confident is found (cluttered background, low contrast) — the caller then
   * falls back to the manual editor. Works for a card or a long document alike:
   * it simply takes the biggest quadrilateral in frame.
   */
  function detectQuad(srcCanvas) {
    return ensureCv().then(function () {
      var cv = window.cv;
      var mats = [];
      function M(m) { mats.push(m); return m; }
      try {
        var src = M(cv.imread(srcCanvas));
        var area = src.rows * src.cols;
        var gray = M(new cv.Mat());
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        var blur = M(new cv.Mat());
        cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
        var edges = M(new cv.Mat());
        cv.Canny(blur, edges, 60, 180);
        var kernel = M(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5)));
        cv.dilate(edges, edges, kernel);
        var contours = M(new cv.MatVector());
        var hierarchy = M(new cv.Mat());
        cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

        var minArea = 0.18 * area;   // ignore anything smaller than ~18% of frame
        var best = null, bestArea = minArea;
        for (var i = 0; i < contours.size(); i++) {
          var c = contours.get(i);
          var a = cv.contourArea(c);
          if (a > bestArea) {
            var peri = cv.arcLength(c, true);
            var approx = new cv.Mat();
            cv.approxPolyDP(c, approx, 0.02 * peri, true);
            if (approx.rows === 4 && cv.isContourConvex(approx)) {
              bestArea = a;
              if (best) best.delete();
              best = approx;
            } else {
              approx.delete();
            }
          }
          c.delete();
        }
        if (!best) return null;
        var p = best.data32S;   // [x0,y0, x1,y1, x2,y2, x3,y3]
        best.delete();
        return orderQuad([
          { x: p[0], y: p[1] }, { x: p[2], y: p[3] },
          { x: p[4], y: p[5] }, { x: p[6], y: p[7] },
        ]);
      } catch (e) {
        console.warn("[DocScan] detect failed:", e);
        return null;
      } finally {
        mats.forEach(function (m) {
          if (m && typeof m.delete === "function") { try { m.delete(); } catch (_e) { /* freed */ } }
        });
      }
    }).catch(function (e) {
      console.warn("[DocScan] OpenCV unavailable, falling back to manual crop:", e);
      return null;
    });
  }

  // ── "Magic colour" enhancement ──────────────────────────────────────────────
  // Per-channel auto-levels: stretch each channel between its 0.5% and 99.5%
  // percentiles, which whitens the paper and deepens the ink while keeping real
  // colour (stamps, holograms, a photo on an ID), then a mild global contrast
  // lift. The Adobe-scan "magic colour" look, in one pixel pass, no OpenCV.
  function magicColor(canvas) {
    var ctx = canvas.getContext("2d");
    var w = canvas.width, h = canvas.height, n = w * h;
    if (!n) return;
    var img = ctx.getImageData(0, 0, w, h), d = img.data;
    var hr = new Uint32Array(256), hg = new Uint32Array(256), hb = new Uint32Array(256);
    for (var i = 0; i < d.length; i += 4) { hr[d[i]]++; hg[d[i + 1]]++; hb[d[i + 2]]++; }
    var cut = n * 0.005;
    function bounds(hist) {
      var lo = 0, hi = 255, c = 0, j;
      for (j = 0; j < 256; j++) { c += hist[j]; if (c >= cut) { lo = j; break; } }
      c = 0;
      for (j = 255; j >= 0; j--) { c += hist[j]; if (c >= cut) { hi = j; break; } }
      if (hi - lo < 16) { lo = 0; hi = 255; }   // near-flat channel: leave it be
      return [lo, hi];
    }
    function lut(b) {
      var lo = b[0], range = b[1] - b[0], C = 1.14, t = new Uint8ClampedArray(256);
      for (var v = 0; v < 256; v++) {
        var s = (v - lo) * 255 / range;
        s = (s - 128) * C + 128;
        t[v] = s < 0 ? 0 : s > 255 ? 255 : s;
      }
      return t;
    }
    var lr = lut(bounds(hr)), lg = lut(bounds(hg)), lb = lut(bounds(hb));
    for (i = 0; i < d.length; i += 4) {
      d[i] = lr[d[i]]; d[i + 1] = lg[d[i + 1]]; d[i + 2] = lb[d[i + 2]];
    }
    ctx.putImageData(img, 0, 0);
  }

  // ── Image loading ─────────────────────────────────────────────────────────

  /**
   * Decode `file` into a canvas, honouring EXIF orientation. Phone cameras
   * routinely store a landscape sensor read plus a "rotate 90" tag; ignoring
   * it lands a sideways bill in Storage.
   */
  function loadToCanvas(file) {
    return new Promise(function (resolve, reject) {
      function draw(bmpOrImg, w, h) {
        // Downscale before anything else. The warp reads back and rewrites
        // every pixel on the main thread; at 12MP that is a ~48MB readback
        // plus millions of divides, which freezes a mid-range Android for
        // seconds. Nothing downstream benefits from more than this — the
        // output is capped at MAX_OUTPUT_EDGE anyway.
        var scale = Math.min(1, MAX_SOURCE_EDGE / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * scale));
        var ch = Math.max(1, Math.round(h * scale));

        var c = document.createElement("canvas");
        c.width = cw; c.height = ch;
        // willReadFrequently on the FIRST getContext call keeps the canvas
        // CPU-backed, so warp()'s getImageData is not a GPU readback.
        var ctx2 = c.getContext("2d", { willReadFrequently: true });
        if (!ctx2) throw new Error("Canvas unavailable for this image size.");
        ctx2.drawImage(bmpOrImg, 0, 0, cw, ch);
        resolve(c);
      }
      if (typeof createImageBitmap === "function") {
        createImageBitmap(file, { imageOrientation: "from-image" })
          .then(function (bmp) {
            try {
              draw(bmp, bmp.width, bmp.height);
            } finally {
              // Decoded pixels live outside the JS heap and are not reclaimed
              // promptly; ten receipts in a session is ten full-res decodes.
              if (typeof bmp.close === "function") bmp.close();
            }
          })
          .catch(fallback);
      } else {
        fallback();
      }
      function fallback() {
        // <img> applies EXIF orientation itself in every current browser.
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () {
          URL.revokeObjectURL(url);
          try {
            draw(img, img.naturalWidth, img.naturalHeight);
          } catch (err) {
            // getContext("2d") returns null past iOS Safari's canvas ceiling,
            // so this throws inside an event handler — outside the promise
            // chain. Unhandled, `await scan(file)` never settled and the
            // attach flow hung with no error and no way to retry.
            reject(err);
          }
        };
        img.onerror = function () {
          URL.revokeObjectURL(url);
          reject(new Error("Could not read that image."));
        };
        img.src = url;
      }
    });
  }

  // ── Editor UI ─────────────────────────────────────────────────────────────

  var STYLE_ID = "cibara-docscan-styles";
  var CSS = [
    ".ds-back{position:fixed;inset:0;z-index:5000;background:#0f172a;",
    "  display:flex;flex-direction:column;touch-action:none;}",
    ".ds-bar{display:flex;align-items:center;justify-content:space-between;",
    "  gap:10px;padding:10px 14px;background:#111827;color:#e5e7eb;flex:0 0 auto;}",
    ".ds-title{font:600 .9rem 'Inter',system-ui,sans-serif;}",
    ".ds-hint{font:500 .74rem 'Inter',system-ui,sans-serif;color:#9ca3af;",
    "  padding:0 14px 9px;background:#111827;flex:0 0 auto;}",
    ".ds-stage{flex:1 1 auto;position:relative;display:flex;align-items:center;",
    "  justify-content:center;overflow:hidden;padding:8px;}",
    ".ds-canvas{max-width:100%;max-height:100%;touch-action:none;",
    "  box-shadow:0 4px 24px rgba(0,0,0,.5);}",
    ".ds-foot{display:flex;gap:8px;padding:10px 14px calc(10px + env(safe-area-inset-bottom));",
    "  background:#111827;flex:0 0 auto;}",
    ".ds-btn{flex:1;padding:12px 10px;border-radius:10px;border:1px solid #374151;",
    "  background:#1f2937;color:#e5e7eb;font:600 .86rem 'Inter',system-ui,sans-serif;",
    "  cursor:pointer;}",
    ".ds-btn:active{background:#374151;}",
    ".ds-btn.primary{background:#2563eb;border-color:#2563eb;color:#fff;}",
    ".ds-btn.primary:active{background:#1d4ed8;}",
    ".ds-btn[disabled]{opacity:.6;cursor:wait;}",
    ".ds-btn.ghost{flex:0 0 auto;padding:12px 16px;}",
    ".ds-detect{position:absolute;top:12px;left:50%;transform:translateX(-50%);",
    "  background:rgba(37,99,235,.92);color:#fff;pointer-events:none;",
    "  font:600 .74rem 'Inter',system-ui,sans-serif;padding:6px 13px;border-radius:999px;}",
    ".ds-detect[hidden]{display:none;}"
  ].join("");

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function openEditor(srcCanvas, resolve, opts) {
    opts = opts || {};
    ensureStyles();

    var back = document.createElement("div");
    back.className = "ds-back";
    back.innerHTML =
      '<div class="ds-bar">' +
        '<span class="ds-title"></span>' +
        '<button type="button" class="ds-btn ghost" data-ds-full>Whole photo</button>' +
      '</div>' +
      '<div class="ds-hint"></div>' +
      '<div class="ds-stage"><canvas class="ds-canvas"></canvas>' +
        '<div class="ds-detect" data-ds-detect hidden>Finding edges…</div>' +
      '</div>' +
      '<div class="ds-foot">' +
        '<button type="button" class="ds-btn" data-ds-cancel>Cancel</button>' +
        '<button type="button" class="ds-btn primary" data-ds-done>Use this</button>' +
      '</div>';
    // textContent, not innerHTML, so a caller-supplied label can never inject.
    back.querySelector(".ds-title").textContent = opts.title || "Crop the bill";
    back.querySelector(".ds-hint").textContent = opts.hint ||
      "Drag the four dots onto the corners of the bill. Everything outside them is removed.";
    document.body.appendChild(back);
    // Stop the page behind from scrolling under the editor on iOS.
    var prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    var canvas = back.querySelector(".ds-canvas");
    var ctx = canvas.getContext("2d");
    var stage = back.querySelector(".ds-stage");

    // Display scale: fit the photo inside the stage at device pixel ratio.
    var view = { scale: 1, w: 0, h: 0 };
    // Corners in SOURCE image coordinates, clockwise from top-left.
    var quad = null;
    var dragIdx = -1;
    // Which pointer owns the drag. touch-action:none means a pinch arrives as
    // two independent pointer streams; without this the second finger stole
    // dragIdx and the first finger's moves then wrote to the WRONG corner,
    // teleporting it across the image.
    var dragPointer = null;

    function clampPt(p) {
      return {
        x: Math.min(Math.max(p.x, 0), srcCanvas.width),
        y: Math.min(Math.max(p.y, 0), srcCanvas.height)
      };
    }

    function resetQuad() {
      // Auto-detected corners, when the caller supplied them, else a sensible
      // 8% inset. Most photos frame the document roughly centred, so the inset
      // is a short drag rather than a fresh placement.
      if (opts.initialQuad && opts.initialQuad.length === 4) {
        quad = opts.initialQuad.map(clampPt);
        return;
      }
      var ix = srcCanvas.width * 0.08, iy = srcCanvas.height * 0.08;
      quad = [
        { x: ix,                     y: iy },
        { x: srcCanvas.width - ix,   y: iy },
        { x: srcCanvas.width - ix,   y: srcCanvas.height - iy },
        { x: ix,                     y: srcCanvas.height - iy }
      ];
    }

    function layout() {
      var availW = stage.clientWidth - 16;
      var availH = stage.clientHeight - 16;
      if (availW <= 0 || availH <= 0) return;
      var s = Math.min(availW / srcCanvas.width, availH / srcCanvas.height, 1);
      view.scale = s;
      view.w = Math.round(srcCanvas.width * s);
      view.h = Math.round(srcCanvas.height * s);
      var dpr = window.devicePixelRatio || 1;
      canvas.style.width = view.w + "px";
      canvas.style.height = view.h + "px";
      canvas.width = Math.round(view.w * dpr);
      canvas.height = Math.round(view.h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      redraw();
    }

    function toView(p) { return { x: p.x * view.scale, y: p.y * view.scale }; }

    function redraw() {
      ctx.clearRect(0, 0, view.w, view.h);
      ctx.drawImage(srcCanvas, 0, 0, view.w, view.h);

      var v = quad.map(toView);

      // Dim everything outside the quad so the selection reads instantly.
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, view.w, view.h);
      ctx.moveTo(v[0].x, v[0].y);
      for (var k = 3; k >= 1; k--) ctx.lineTo(v[k].x, v[k].y);
      ctx.closePath();
      ctx.fillStyle = "rgba(6,10,20,.55)";
      ctx.fill("evenodd");
      ctx.restore();

      ctx.beginPath();
      ctx.moveTo(v[0].x, v[0].y);
      for (var i = 1; i < 4; i++) ctx.lineTo(v[i].x, v[i].y);
      ctx.closePath();
      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 2;
      ctx.stroke();

      for (var j = 0; j < 4; j++) {
        ctx.beginPath();
        ctx.arc(v[j].x, v[j].y, HANDLE_DRAW, 0, Math.PI * 2);
        ctx.fillStyle = dragIdx === j ? "#0ea5e9" : "rgba(255,255,255,.95)";
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = "#0284c7";
        ctx.stroke();
      }
    }

    function pointerPos(ev) {
      var r = canvas.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    }

    function onDown(ev) {
      if (dragPointer !== null) return;      // already dragging with another finger
      var p = pointerPos(ev);
      var best = -1, bestD = HANDLE_HIT;
      for (var i = 0; i < 4; i++) {
        var d = dist(p, toView(quad[i]));
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best < 0) return;
      dragIdx = best;
      dragPointer = ev.pointerId;
      try { canvas.setPointerCapture(ev.pointerId); } catch (_e) { /* not capturable */ }
      ev.preventDefault();
      redraw();
    }

    function onMove(ev) {
      if (dragIdx < 0 || ev.pointerId !== dragPointer) return;
      var p = pointerPos(ev);
      // Clamp into the photo — a corner outside it only produces white fill.
      quad[dragIdx] = {
        x: Math.min(Math.max(p.x / view.scale, 0), srcCanvas.width),
        y: Math.min(Math.max(p.y / view.scale, 0), srcCanvas.height)
      };
      ev.preventDefault();
      redraw();
    }

    function onUp(ev) {
      if (dragIdx < 0 || ev.pointerId !== dragPointer) return;
      dragIdx = -1;
      dragPointer = null;
      try { canvas.releasePointerCapture(ev.pointerId); } catch (_e) { /* already released */ }
      redraw();
    }

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);

    var onResize = function () { layout(); };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);

    var settled = false;
    function close(result) {
      if (settled) return;
      settled = true;
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      back.remove();
      resolve(result);
    }

    function onKey(e) { if (e.key === "Escape") close(null); }
    document.addEventListener("keydown", onKey);

    back.querySelector("[data-ds-cancel]").addEventListener("click", function () {
      close(null);
    });

    // Escape hatch: the photo is already tightly framed, or the bill has no
    // clean rectangular border to trace. Take it as-is.
    back.querySelector("[data-ds-full]").addEventListener("click", function () {
      quad = [
        { x: 0, y: 0 },
        { x: srcCanvas.width, y: 0 },
        { x: srcCanvas.width, y: srcCanvas.height },
        { x: 0, y: srcCanvas.height }
      ];
      redraw();
    });

    var doneBtn = back.querySelector("[data-ds-done]");
    doneBtn.addEventListener("click", function () {
      doneBtn.disabled = true;
      doneBtn.textContent = "Working…";
      // Yield a frame so the button state paints before the warp blocks.
      setTimeout(function () {
        var size = outputSize(quad);
        var outCanvas = null;
        try {
          outCanvas = warp(srcCanvas, quad, size.w, size.h);
        } catch (err) {
          console.error("[DocScan] warp failed:", err);
        }
        if (!outCanvas) {
          // Degenerate quad (three corners collinear, or all four stacked).
          doneBtn.disabled = false;
          doneBtn.textContent = "Use this";
          if (typeof showNotification === "function") {
            showNotification("Those corners don't form a shape — spread them out.", "error");
          }
          return;
        }
        if (opts.enhance === "magic") {
          try { magicColor(outCanvas); } catch (e) { console.warn("[DocScan] enhance failed:", e); }
        }
        outCanvas.toBlob(function (blob) {
          if (!blob) {
            // toBlob yields null when the encoder fails — a very large photo,
            // or memory pressure. null is this module's "operator cancelled"
            // signal, so returning it here silently attached nothing while the
            // operator believed the receipt was saved. Surface it instead.
            console.error("[DocScan] toBlob returned null (encode failed)");
            doneBtn.disabled = false;
            doneBtn.textContent = "Use this";
            if (typeof showNotification === "function") {
              showNotification("Could not save the crop — try a smaller photo.", "error");
            }
            return;
          }
          close(blob);
        }, "image/jpeg", JPEG_QUALITY);
      }, 30);
    });

    resetQuad();

    // Auto-detection runs in parallel so the editor opens instantly. When it
    // resolves we snap the corners onto the detected document; a miss (null)
    // just leaves the inset guess for the operator to drag.
    if (opts.detectPromise) {
      var chip = back.querySelector("[data-ds-detect]");
      if (chip) chip.hidden = false;
      opts.detectPromise.then(function (detected) {
        if (chip) chip.hidden = true;
        if (settled) return;
        if (detected && detected.length === 4) {
          quad = detected.map(clampPt);
          redraw();
        }
      }).catch(function () { if (chip) chip.hidden = true; });
    }

    // Two frames: one for the stage to get its height, one to draw into it.
    requestAnimationFrame(function () { requestAnimationFrame(layout); });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * scan(file, opts) -> Promise<File|null>
   *   opts.autoDetect  — lazy-load OpenCV.js and pre-place the corners on the
   *                      detected document (card or long doc). Falls back to the
   *                      manual inset on any miss or load failure.
   *   opts.enhance     — "magic" applies the magic-colour auto-levels to the
   *                      cropped output; omit to keep the photo's own colours.
   *   opts.title/hint  — editor labels (default: bill wording).
   * With no opts this behaves exactly as before (manual crop, no enhancement).
   */
  function scan(file, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      if (!file) { resolve(null); return; }

      // PDFs and anything non-image pass straight through — there is nothing
      // to crop, and a supplier emailing a PDF invoice is perfectly normal.
      if (!/^image\//i.test(file.type || "")) { resolve(file); return; }
      if (!isSupported()) { resolve(file); return; }

      loadToCanvas(file).then(function (srcCanvas) {
        openEditor(srcCanvas, function (blob) {
          if (!blob) { resolve(null); return; }
          var base = (file.name || "invoice").replace(/\.[^.]+$/, "");
          resolve(new File([blob], base + "-scan.jpg", {
            type: "image/jpeg",
            lastModified: Date.now()
          }));
        }, {
          title: opts.title,
          hint: opts.hint,
          enhance: opts.enhance,
          // Detection runs in parallel; the editor opens immediately and snaps
          // the corners in when it resolves.
          detectPromise: opts.autoDetect ? detectQuad(srcCanvas) : null
        });
      }).catch(function (err) {
        console.error("[DocScan] could not open image:", err);
        // Never block the upload because cropping failed — send the original.
        resolve(file);
      });
    });
  }

  /**
   * autoScan(file, opts) -> Promise<File|null>
   * Headless: NO corner editor. Auto-detects the document, deskews + enhances,
   * and resolves with the cropped File — for the live camera, where the operator
   * already framed the document in the guide box and a second crop screen is
   * just friction.
   *   opts.autoDetect   — run OpenCV detection (else skip straight to fallback).
   *   opts.enhance      — "magic" applies magic-colour to the output.
   *   opts.fallbackCrop — {x,y,w,h} as FRACTIONS (0-1) of the image, used when
   *                       detection misses — e.g. the camera guide box, so we
   *                       still keep "the area you framed". Omit → whole image.
   */
  function autoScan(file, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      if (!file) { resolve(null); return; }
      if (!/^image\//i.test(file.type || "")) { resolve(file); return; }
      if (!isSupported()) { resolve(file); return; }

      loadToCanvas(file).then(function (srcCanvas) {
        function finish(outCanvas) {
          if (opts.enhance === "magic") {
            try { magicColor(outCanvas); } catch (e) { console.warn("[DocScan] enhance failed:", e); }
          }
          outCanvas.toBlob(function (blob) {
            if (!blob) { resolve(file); return; }
            var base = (file.name || "id").replace(/\.[^.]+$/, "");
            resolve(new File([blob], base + "-scan.jpg", { type: "image/jpeg", lastModified: Date.now() }));
          }, "image/jpeg", JPEG_QUALITY);
        }
        function cropFallback() {
          var fc = opts.fallbackCrop;
          if (fc) {
            var x = Math.max(0, Math.round(fc.x * srcCanvas.width));
            var y = Math.max(0, Math.round(fc.y * srcCanvas.height));
            var w = Math.min(srcCanvas.width - x, Math.round(fc.w * srcCanvas.width));
            var h = Math.min(srcCanvas.height - y, Math.round(fc.h * srcCanvas.height));
            if (w > 8 && h > 8) {
              var cc = document.createElement("canvas");
              cc.width = w; cc.height = h;
              cc.getContext("2d").drawImage(srcCanvas, x, y, w, h, 0, 0, w, h);
              finish(cc);
              return;
            }
          }
          finish(srcCanvas);
        }
        if (opts.autoDetect) {
          detectQuad(srcCanvas).then(function (q) {
            if (q && q.length === 4) {
              var size = outputSize(q);
              var wc = warp(srcCanvas, q, size.w, size.h);
              if (wc) { finish(wc); return; }
            }
            cropFallback();
          }).catch(cropFallback);
        } else {
          cropFallback();
        }
      }).catch(function (err) {
        console.error("[DocScan] autoScan failed:", err);
        resolve(file);   // never block the capture
      });
    });
  }

  window.CibaraDocScan = { scan: scan, autoScan: autoScan, isSupported: isSupported };
})();
