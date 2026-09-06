/* ──────────────────────────────────────────────────────────────────────────
 * Cleaning and inspection photos for rooms 200-228
 *
 * Three steps can ask for photos instead of (or on top of) a checklist,
 * each behind an admin switch in Settings (mirrors services/room_photos.py):
 *   inspection  manager approves a cleaned room      (inspection_photos, on)
 *   cleaning    housekeeping marks a room cleaned    (cleaning_photos, off)
 *   service     a mid-stay service clean is done; only the photo matching
 *               what was asked (room → bed, bathroom → washroom); follows
 *               the switch of whoever marks it done.
 * Admin is never asked. The server enforces the same rules, so the modal is
 * the convenience, not the gate.
 *
 * Wiring:
 *   • room-cleaning.js markRoomAsCleaned() → RoomPhotos.wantsPhotoCheck(room, ctx)
 *     and RoomPhotos.open({...}) instead of a checklist; on approve it calls
 *     completeRoomCleaning(room, { photos, notes }).
 *   • script.js _applyHousekeepingDone() does the same for context "service"
 *     and sends photos/notes with /toggle_housekeeping.
 *   • Viewing: RoomPhotos.renderStrip(hostId, source, room) puts the latest
 *     set (thumbnails, who, when, note) into the check-in modal (for the
 *     selected room), the checkout modal (the stay's prep photos) and the
 *     bill modal after checkout (from the bill's copied stay_timeline).
 *     Room details use detailRows / detailCard for the full list; "History"
 *     opens a viewer over /room_photos (last 7 days, names from metadata).
 *
 * Grid: RoomPhotos.cardBadge(info, room) adds a camera badge to a room card
 * that has photos; tapping it opens the history viewer.
 *
 * Capture: tapping a tile opens an in-page camera (getUserMedia) with one
 * shutter button, so the shot is used the moment it is taken; there is no
 * "retake / use photo" screen. Tapping a finished tile shoots again. On a
 * non-secure origin (plain http over the LAN) or when the camera is refused,
 * the tile falls back to the file picker. Each photo is compressed in the
 * browser (1280px JPEG q0.72 plus a 320px thumbnail) and held locally;
 * uploads happen only when the approve button is pressed, so retakes and
 * cancelled checks never reach Storage.
 * Retention is handled by the server.
 * ────────────────────────────────────────────────────────────────────────── */
(function () {
  "use strict";

  const KINDS = [
    { key: "washroom", label: "Washroom", icon: "fa-shower" },
    { key: "bed",      label: "Room & bed", icon: "fa-bed" },
  ];
  const ROOM_MIN = 200, ROOM_MAX = 228;
  const MAX_DIM = 1280, JPEG_Q = 0.72, THUMB_DIM = 320, THUMB_Q = 0.6;
  const CONTEXT = {
    inspection: { title: "Photo check", approve: "Ready for check-in ✓",
                  hint: "Take both photos after inspecting the room." },
    cleaning:   { title: "Cleaning photos", approve: "Mark as cleaned ✓",
                  hint: "Take both photos after cleaning the room." },
    service:    { title: "Service clean", approve: "Mark as done ✓",
                  hint: "Take a photo of what was cleaned." },
  };

  // files[kind] = {blob, thumb} captured locally; nothing is uploaded until
  // the approve button is pressed, so retakes never reach Storage.
  const state = { room: null, context: "inspection", kinds: KINDS, files: {}, busy: {}, onApprove: null };

  // ── Policy (mirrors services/room_photos.py) ─────────────────────────────
  function isPhotoRoom(room) {
    const n = parseInt(room, 10);
    return n >= ROOM_MIN && n <= ROOM_MAX;
  }

  // Settings switches. script.js keeps _uiConfigState live via the settings
  // listener; before it exists the server-rendered initial config applies.
  function uiConfig() {
    return (typeof _uiConfigState !== "undefined" && _uiConfigState) ||
           window.__initialUIConfig || {};
  }

  // Which switch governs this user: managers follow inspection_photos,
  // housekeeping follows cleaning_photos, admin is never asked.
  function switchOn() {
    const a = window.CibaraAuth || {};
    const cfg = uiConfig();
    if (a.isManager && a.isManager()) return cfg.inspection_photos !== false;
    if (a.isHousekeeping && a.isHousekeeping()) return !!cfg.cleaning_photos;
    return false;
  }

  function wantsPhotoCheck(room, context) {
    if (!isPhotoRoom(room) || !switchOn()) return false;
    const a = window.CibaraAuth || {};
    if (context === "inspection") return !!(a.isManager && a.isManager());
    if (context === "cleaning")   return !!(a.isHousekeeping && a.isHousekeeping());
    return context === "service";
  }

  function kindsFor(context, serviceType) {
    if (context !== "service") return KINDS;
    return KINDS.filter(function (k) { return k.key === (serviceType === "room" ? "bed" : "washroom"); });
  }

  // ── Image compression ────────────────────────────────────────────────────
  async function loadBitmap(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: "from-image" }); }
      catch (_e) { /* fall through to <img> */ }
    }
    return new Promise(function (resolve, reject) {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("Could not read photo")); };
      img.src = url;
    });
  }

  function toJpeg(source, maxDim, quality) {
    const w = source.width, h = source.height;
    const scale = Math.min(1, maxDim / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        blob ? resolve(blob) : reject(new Error("Could not compress photo"));
      }, "image/jpeg", quality);
    });
  }

  // Full-size for evidence, thumbnail for lists: both from one decode.
  async function compress(file) {
    const bmp = await loadBitmap(file);
    const blob = await toJpeg(bmp, MAX_DIM, JPEG_Q);
    const thumb = await toJpeg(bmp, THUMB_DIM, THUMB_Q);
    if (bmp.close) bmp.close();
    return { blob: blob, thumb: thumb };
  }

  // ── Upload ───────────────────────────────────────────────────────────────
  async function upload(room, context, kind, files) {
    const fd = new FormData();
    fd.append("room", room);
    fd.append("context", context);
    fd.append("kind", kind);
    fd.append("photo", files.blob, kind + ".jpg");
    fd.append("thumb", files.thumb, kind + "_t.jpg");
    const resp = await apiFetch("/upload_room_photo", { method: "POST", body: fd });
    const data = await resp.json().catch(function () { return {}; });
    if (!resp.ok || !data.success) throw new Error(data.message || "Upload failed");
    return { url: data.url, thumb: data.thumb || "" };
  }

  // ── Modal ────────────────────────────────────────────────────────────────
  function el(id) { return document.getElementById(id); }

  function ensureModal() {
    if (el("photo-check-modal")) return;
    const tiles = KINDS.map(function (k) {
      return (
        '<label class="rp-tile" data-kind="' + k.key + '">' +
        '<input type="file" accept="image/*" capture="environment" hidden>' +
        '<img class="rp-preview" alt="" hidden>' +
        '<span class="rp-icon"><i class="fas ' + k.icon + '"></i></span>' +
        '<span class="rp-label">' + k.label + "</span>" +
        '<span class="rp-status">Tap to take photo</span>' +
        '<span class="rp-check"><i class="fas fa-check"></i></span>' +
        "</label>"
      );
    }).join("");
    document.body.insertAdjacentHTML("beforeend",
      '<div class="modal-backdrop" id="photo-check-modal">' +
      '<div class="modal-content" style="max-width:420px">' +
      '<div class="modal-header" style="padding:1rem 1.5rem">' +
      '<h2 style="font-size:1.1rem">Room <span id="photo-check-room"></span> · <span id="photo-check-title"></span></h2>' +
      '<button class="close-btn" aria-label="Close">&times;</button></div>' +
      '<div class="modal-body" style="padding:1rem 1.5rem">' +
      '<p class="rp-hint" id="photo-check-hint"></p>' +
      '<div class="rp-tiles">' + tiles + "</div>" +
      '<textarea id="photo-check-notes" class="rp-notes" rows="2" maxlength="500" ' +
      'placeholder="Anything to note? (AC, stains, missing items…)"></textarea>' +
      '<p class="rp-error" id="photo-check-error" hidden></p>' +
      "</div>" +
      '<div class="modal-footer" style="padding:1rem 1.5rem;gap:.5rem">' +
      '<button class="action-btn btn-secondary rp-cancel" style="flex:1">Cancel</button>' +
      '<button class="action-btn btn-success" id="photo-check-approve" style="flex:1" disabled>Ready for check-in ✓</button>' +
      "</div></div></div>");
    injectStyles();

    const modal = el("photo-check-modal");
    modal.querySelector(".close-btn").addEventListener("click", close);
    modal.querySelector(".rp-cancel").addEventListener("click", close);
    modal.querySelectorAll(".rp-tile").forEach(function (tile) {
      const input = tile.querySelector("input");
      // Tap = shoot. With the in-page camera the shot is taken on the
      // shutter tap and used immediately (no "retake / use photo" screen
      // from the phone's camera app). Tapping a finished tile shoots again.
      tile.addEventListener("click", function (e) {
        if (!cameraAvailable()) return;      // let the <input> open the picker
        e.preventDefault();
        openCamera(tile);
      });
      input.addEventListener("change", function () {
        const file = input.files && input.files[0];
        input.value = "";                     // same photo again must re-trigger
        if (file) onPick(input.closest(".rp-tile"), file);
      });
    });
    el("photo-check-approve").addEventListener("click", approve);
  }

  // ── In-page camera ───────────────────────────────────────────────────────
  // getUserMedia needs a secure context (https, or localhost). On plain http
  // over the LAN it is unavailable and the tile falls back to the file
  // picker, where the phone's camera app shows its own confirm screen.
  let cam = null;   // { stream, tile }

  function cameraAvailable() {
    return !!(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  function ensureCamera() {
    if (el("rp-cam")) return;
    document.body.insertAdjacentHTML("beforeend",
      '<div id="rp-cam" class="rp-cam" hidden>' +
      '<video id="rp-cam-video" class="rp-cam-video" playsinline autoplay muted></video>' +
      '<div class="rp-cam-top"><span id="rp-cam-label"></span>' +
      '<button type="button" class="rp-cam-close" aria-label="Close">&times;</button></div>' +
      '<div class="rp-cam-bottom">' +
      '<button type="button" class="rp-cam-pick" id="rp-cam-pick">Gallery</button>' +
      '<button type="button" class="rp-cam-shutter" id="rp-cam-shutter" aria-label="Take photo"></button>' +
      '<span class="rp-cam-spacer"></span></div></div>');
    const box = el("rp-cam");
    box.querySelector(".rp-cam-close").addEventListener("click", closeCamera);
    el("rp-cam-shutter").addEventListener("click", shoot);
    el("rp-cam-pick").addEventListener("click", function () {
      const tile = cam && cam.tile;
      closeCamera();
      if (tile) tile.querySelector("input").click();
    });
  }

  async function openCamera(tile) {
    ensureCamera();
    const label = KINDS.find(function (k) { return k.key === tile.dataset.kind; });
    el("rp-cam-label").textContent = "Room " + state.room + " · " + (label ? label.label : "");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1440 } },
        audio: false,
      });
      cam = { stream: stream, tile: tile };
      const video = el("rp-cam-video");
      video.srcObject = stream;
      el("rp-cam").hidden = false;
      await video.play().catch(function () {});
    } catch (_e) {
      // Permission refused or no camera: the picker still works.
      closeCamera();
      tile.querySelector("input").click();
    }
  }

  function closeCamera() {
    if (cam && cam.stream) cam.stream.getTracks().forEach(function (t) { t.stop(); });
    const video = el("rp-cam-video");
    if (video) video.srcObject = null;
    const box = el("rp-cam");
    if (box) box.hidden = true;
    cam = null;
  }

  function shoot() {
    if (!cam) return;
    const video = el("rp-cam-video");
    const tile = cam.tile;
    if (!video.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    closeCamera();
    canvas.toBlob(function (blob) {
      if (blob) onPick(tile, blob);
      else showError("Could not capture the photo, try again");
    }, "image/jpeg", 0.92);
  }

  function setTile(tile, status, opts) {
    opts = opts || {};
    tile.querySelector(".rp-status").textContent = status;
    tile.classList.toggle("rp-tile--done", !!opts.done);
    tile.classList.toggle("rp-tile--busy", !!opts.busy);
    const img = tile.querySelector(".rp-preview");
    if (opts.preview) { img.src = opts.preview; img.hidden = false; }
    if (opts.clear) { img.removeAttribute("src"); img.hidden = true; }
  }

  function showError(msg) {
    const p = el("photo-check-error");
    p.textContent = msg || "";
    p.hidden = !msg;
  }

  function refreshApprove() {
    const ready = state.kinds.every(function (k) { return !!state.files[k.key]; });
    const busy = Object.keys(state.busy).some(function (k) { return state.busy[k]; });
    el("photo-check-approve").disabled = !ready || busy;
  }

  async function onPick(tile, file) {
    const kind = tile.dataset.kind;
    showError("");
    state.busy[kind] = true;
    refreshApprove();
    setTile(tile, "Processing…", { busy: true });
    try {
      const files = await compress(file);
      state.files[kind] = files;
      setTile(tile, "Ready · tap to retake", { done: true, preview: URL.createObjectURL(files.thumb) });
    } catch (e) {
      delete state.files[kind];
      setTile(tile, "Failed · tap to try again", { clear: true });
      showError(e.message || "Could not read the photo");
    } finally {
      state.busy[kind] = false;
      refreshApprove();
    }
  }

  // Upload everything now, then complete the step. If any upload fails the
  // modal stays open with the photos still in hand, so nothing is lost and
  // no half-set reaches the server.
  async function approve() {
    const btn = el("photo-check-approve");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Uploading…";
    showError("");
    try {
      const photos = {};
      for (const k of state.kinds) {
        const stored = await upload(state.room, state.context, k.key, state.files[k.key]);
        photos[k.key] = stored.url;
        photos[k.key + "_thumb"] = stored.thumb;
      }
      const payload = { photos: photos, notes: (el("photo-check-notes").value || "").trim() };
      const ok = await (state.onApprove
        ? state.onApprove(payload)
        : completeRoomCleaning(state.room, payload));
      if (ok !== false) close();
    } catch (e) {
      showError(e.message || "Upload failed, please try again");
    } finally {
      btn.textContent = label;
      refreshApprove();
    }
  }

  // open({ room, context, serviceType, onApprove })
  //   context     "inspection" (default) | "cleaning" | "service"
  //   serviceType "room" | "bathroom", service context only
  //   onApprove   async ({photos, notes}) => boolean; defaults to
  //               completeRoomCleaning(room, payload)
  function open(opts) {
    if (typeof opts !== "object") opts = { room: opts };
    ensureModal();
    state.room = String(opts.room);
    state.context = CONTEXT[opts.context] ? opts.context : "inspection";
    state.kinds = kindsFor(state.context, opts.serviceType);
    state.onApprove = typeof opts.onApprove === "function" ? opts.onApprove : null;
    state.files = {};
    state.busy = {};
    const c = CONTEXT[state.context];
    el("photo-check-room").textContent = state.room;
    el("photo-check-title").textContent = c.title;
    el("photo-check-hint").textContent = c.hint;
    el("photo-check-approve").textContent = c.approve;
    el("photo-check-notes").value = "";
    showError("");
    const wanted = state.kinds.map(function (k) { return k.key; });
    document.querySelectorAll("#photo-check-modal .rp-tile").forEach(function (t) {
      t.hidden = wanted.indexOf(t.dataset.kind) === -1;
      setTile(t, "Tap to take photo", { clear: true });
    });
    document.querySelector("#photo-check-modal .rp-tiles").classList.toggle("rp-tiles--single", wanted.length === 1);
    refreshApprove();
    el("photo-check-modal").classList.add("show");
  }

  function close() {
    const m = el("photo-check-modal");
    if (m) m.classList.remove("show");
  }

  // ── Viewing (room details + lightbox with recent history) ────────────────
  function esc(v) {
    return String(v == null ? "" : v).replace(/[<&>"']/g, function (c) {
      return { "<": "&lt;", "&": "&amp;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmt(at) {
    const d = new Date(String(at || "").replace(" ", "T"));
    return isNaN(d.getTime()) ? String(at || "") :
      d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  }

  // Audit trail from the room's stay_timeline: every inspection approval
  // that carried photos, newest first. Prep events survive check-in
  // (services/stay_timeline.prep_only keeps them), so this is available
  // for the whole stay; at checkout the timeline is copied onto the bill.
  function photoEvents(info) {
    const tl = Array.isArray((info || {}).stay_timeline) ? info.stay_timeline : [];
    return tl
      .filter(function (e) { return e && e.photos && (e.photos.washroom || e.photos.bed); })
      .sort(function (a, b) { return String(b.at || "").localeCompare(String(a.at || "")); });
  }

  function thumbs(p) {
    return KINDS.filter(function (k) { return p[k.key]; }).map(function (k) {
      return '<a href="' + esc(p[k.key]) + '" target="_blank" rel="noopener">' +
        '<img class="rp-thumb" src="' + esc(p[k.key + "_thumb"] || p[k.key]) + '" alt="' + k.label +
        '" title="' + k.label + '" loading="lazy"></a>';
    }).join("");
  }

  const ACTION_LABEL = {
    "room.inspection.approve": "Inspected",
    "room.cleaning.complete": "Cleaned",
    "room.service_cleaning.done": "Service clean",
  };

  function who(ev) {
    return String((ev && (ev.byName || ev.by)) || "").trim();
  }

  // Summary-row markup for a VACANT room in script.js's room-details view:
  // the latest pair with who / when. Empty when nothing is on file.
  function detailRows(info, room) {
    const p = (info || {}).last_inspection_photos;
    if (!p || !(p.washroom || p.bed)) return "";
    const by = who(p);
    return (
      '<div class="summary-row rp-row" data-rp-room="' + esc(room) + '">' +
      '<div class="summary-label">Inspection photos</div>' +
      '<div class="summary-value"><span class="rp-thumbs">' + thumbs(p) + "</span>" +
      '<span class="rp-when">' + esc(fmt(p.at)) + (by ? " \u00b7 " + esc(by) : "") + "</span>" +
      '<span class="rp-more">History</span></div></div>'
    );
  }

  // Full card for an OCCUPIED room: every photo set taken for this stay's
  // preparation, each with inspector and time, plus the history link.
  function detailCard(info, room) {
    const events = photoEvents(info);
    const latest = (info || {}).last_inspection_photos;
    if (!events.length && !(latest && (latest.washroom || latest.bed))) return "";
    const rows = (events.length ? events : [latest]).map(function (ev) {
      const p = ev.photos || ev;
      const by = who(ev);
      const what = ACTION_LABEL[ev.action] || "Photos";
      const svc = ev.service ? " (" + esc(ev.service) + ")" : "";
      return (
        '<div class="summary-row"><div class="summary-label">' +
        esc(what) + svc + '<br><span class="rp-when">' + esc(fmt(ev.at)) +
        (by ? " \u00b7 " + esc(by) : "") + "</span>" +
        (ev.notes ? '<br><span class="rp-note">\u201c' + esc(ev.notes) + "\u201d</span>" : "") +
        '</div><div class="summary-value"><span class="rp-thumbs">' + thumbs(p) + "</span></div></div>"
      );
    }).join("");
    return (
      '<div class="summary-card" style="margin-bottom:0">' +
      '<div class="summary-title">Cleaning & inspection photos (this stay)</div>' +
      rows +
      '<div class="summary-row rp-row" data-rp-room="' + esc(room) + '">' +
      '<div class="summary-label"></div><div class="summary-value"><span class="rp-more">All photos from the last 7 days</span></div></div>' +
      "</div>"
    );
  }

  // Small camera badge for the room card (grid). Shown on any 200-block room
  // that has photos on file for the current cycle; tapping it opens the
  // photo history without going through the card's own tap action.
  function cardBadge(info, room) {
    if (!isPhotoRoom(room)) return "";
    const p = (info || {}).last_inspection_photos;
    const has = photoEvents(info).length > 0 || !!(p && (p.washroom || p.bed));
    if (!has) return "";
    return '<button type="button" class="rp-card-badge" data-rp-room="' + esc(room) +
           '" title="Cleaning photos" aria-label="Cleaning photos"><i class="fas fa-camera"></i></button>';
  }

  document.addEventListener("click", function (e) {
    const badge = e.target.closest(".rp-card-badge");
    if (!badge) return;
    e.stopPropagation();
    e.preventDefault();
    openViewer(badge.dataset.rpRoom);
  }, true);

  // Compact strip for the check-in / checkout / bill modals: the latest
  // photo set with who / when, thumbnails, and (optionally) the History
  // link. `source` is anything carrying stay_timeline and/or
  // last_inspection_photos: a room from `rooms`, or a bill record.
  // Renders nothing for rooms outside 200-228 or with no photos on file.
  function renderStrip(hostId, source, room, opts) {
    const host = el(hostId);
    if (!host) return;
    opts = opts || {};
    const events = photoEvents(source);
    const latest = events[0] || ((source || {}).last_inspection_photos &&
      Object.assign({ action: "room.inspection.approve" }, (source || {}).last_inspection_photos,
                    { photos: (source || {}).last_inspection_photos }));
    if (!isPhotoRoom(room) || !latest || !(latest.photos.washroom || latest.photos.bed)) {
      host.innerHTML = "";
      host.hidden = true;
      return;
    }
    injectStyles();
    const by = who(latest);
    const what = ACTION_LABEL[latest.action] || "Photos";
    const more = events.length > 1 ? " · " + events.length + " sets" : "";
    host.hidden = false;
    host.innerHTML =
      '<div class="rp-strip' + (opts.history === false ? "" : " rp-row") + '" data-rp-room="' + esc(room) + '">' +
      '<span class="rp-thumbs">' + thumbs(latest.photos) + "</span>" +
      '<span class="rp-strip-text"><b>' + esc(what) + "</b> " + esc(fmt(latest.at)) +
      (by ? " · " + esc(by) : "") + more +
      (latest.notes ? '<br><span class="rp-note">\u201c' + esc(latest.notes) + "\u201d</span>" : "") +
      "</span>" +
      (opts.history === false ? "" : '<span class="rp-more">History</span>') +
      "</div>";
  }

  // The check-in modal's room dropdown can change after it opens.
  document.addEventListener("change", function (e) {
    if (e.target && e.target.id === "checkin-room-dropdown") {
      const room = e.target.value;
      renderStrip("checkin-room-photos", (window.rooms || {})[room], room);
    }
  });

  async function openViewer(room) {
    injectStyles();
    let box = el("rp-viewer");
    if (!box) {
      document.body.insertAdjacentHTML("beforeend",
        '<div id="rp-viewer" class="rp-viewer" hidden>' +
        '<div class="rp-viewer-head"><span id="rp-viewer-title"></span>' +
        '<button class="rp-viewer-close" aria-label="Close">&times;</button></div>' +
        '<div class="rp-viewer-body" id="rp-viewer-body"></div></div>');
      box = el("rp-viewer");
      box.querySelector(".rp-viewer-close").addEventListener("click", function () { box.hidden = true; });
      box.addEventListener("click", function (e) { if (e.target === box) box.hidden = true; });
    }
    el("rp-viewer-title").textContent = "Room " + room + " · recent inspection photos";
    const body = el("rp-viewer-body");
    body.innerHTML = '<p class="rp-hint">Loading…</p>';
    box.hidden = false;
    try {
      const resp = await apiFetch("/room_photos?room=" + encodeURIComponent(room));
      const data = await resp.json();
      const photos = (data && data.photos) || [];
      if (!photos.length) { body.innerHTML = '<p class="rp-hint">No photos in the last 7 days.</p>'; return; }
      body.innerHTML = photos.map(function (ph) {
        const k = KINDS.find(function (x) { return x.key === ph.kind; }) || { label: ph.kind };
        const ctx = ph.context && ph.context !== "inspection" ? " · " + esc(ph.context) : "";
        return (
          '<figure class="rp-fig"><a href="' + esc(ph.url) + '" target="_blank" rel="noopener">' +
          '<img src="' + esc(ph.thumb || ph.url) + '" alt="' + esc(k.label) + '" loading="lazy"></a>' +
          "<figcaption>" + esc(k.label) + ctx + " · " + esc(fmt(ph.at)) +
          (ph.byName ? " · " + esc(ph.byName) : "") + "</figcaption></figure>"
        );
      }).join("");
    } catch (_e) {
      body.innerHTML = '<p class="rp-hint">Could not load photos.</p>';
    }
  }

  document.addEventListener("click", function (e) {
    if (e.target.closest("a")) return;            // thumbnail → full image
    const row = e.target.closest(".rp-row");
    if (row) openViewer(row.dataset.rpRoom);
  });

  // ── Styles ───────────────────────────────────────────────────────────────
  function injectStyles() {
    if (el("room-photos-styles")) return;
    const css =
      ".rp-hint{margin:0 0 .75rem;font-size:.82rem;color:var(--gray)}" +
      ".rp-tiles{display:grid;grid-template-columns:1fr 1fr;gap:.75rem}" +
      ".rp-tile{position:relative;aspect-ratio:1/1;border:2px dashed #cbd5e1;border-radius:14px;" +
        "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.3rem;" +
        "cursor:pointer;overflow:hidden;background:#f8fafc;text-align:center;padding:.5rem;" +
        "-webkit-tap-highlight-color:transparent}" +
      ".rp-tile:active{transform:scale(.98)}" +
      ".rp-tile--done{border:2px solid var(--success)}" +
      ".rp-preview{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}" +
      ".rp-tile--done .rp-preview,.rp-tile--busy .rp-preview{opacity:.9}" +
      ".rp-icon{font-size:1.6rem;color:var(--primary)}" +
      ".rp-label{font-weight:700;font-size:.9rem;color:#1e293b}" +
      ".rp-status{font-size:.7rem;color:var(--gray)}" +
      ".rp-tile--done .rp-icon,.rp-tile--done .rp-label,.rp-tile--busy .rp-icon,.rp-tile--busy .rp-label{display:none}" +
      ".rp-tile--done .rp-status,.rp-tile--busy .rp-status{position:absolute;left:0;right:0;bottom:0;" +
        "padding:.35rem;background:rgba(15,23,42,.65);color:#fff;font-weight:600}" +
      ".rp-check{position:absolute;top:8px;right:8px;width:24px;height:24px;border-radius:50%;" +
        "background:var(--success);color:#fff;display:none;align-items:center;justify-content:center;font-size:.75rem}" +
      ".rp-tile--done .rp-check{display:flex}" +
      ".rp-tiles--single{grid-template-columns:1fr;max-width:220px;margin:0 auto}" +
      ".rp-notes{width:100%;box-sizing:border-box;margin-top:.75rem;padding:.55rem .7rem;border:1px solid #cbd5e1;" +
        "border-radius:10px;font:inherit;font-size:.85rem;resize:vertical}" +
      ".rp-note{font-size:.75rem;color:#334155;font-style:italic}" +
      ".rp-strip-host[hidden]{display:none}" +
      ".rp-card-badge{position:absolute;bottom:6px;right:6px;width:22px;height:22px;border-radius:50%;border:0;" +
        "background:var(--primary);color:#fff;font-size:.65rem;display:flex;align-items:center;justify-content:center;" +
        "cursor:pointer;z-index:2;box-shadow:0 1px 3px rgba(0,0,0,.25)}" +
      ".rp-strip{display:flex;align-items:center;gap:.6rem;padding:.5rem .7rem;margin:0 0 .8rem;" +
        "background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;font-size:.78rem;color:#334155}" +
      ".rp-strip .rp-thumb{width:44px;height:44px;border-radius:8px}" +
      ".rp-strip-text{flex:1 1 auto;min-width:0;line-height:1.3}" +
      ".rp-strip .rp-more{margin-left:0;flex-shrink:0}" +
      ".rp-error{margin:.6rem 0 0;font-size:.8rem;color:var(--danger)}" +
      ".rp-cam{position:fixed;inset:0;z-index:10001;background:#000;display:flex;flex-direction:column}" +
      ".rp-cam[hidden]{display:none}" +
      ".rp-cam-video{flex:1 1 auto;width:100%;height:100%;object-fit:cover;background:#000}" +
      ".rp-cam-top{position:absolute;top:0;left:0;right:0;display:flex;justify-content:space-between;align-items:center;" +
        "padding:calc(.6rem + env(safe-area-inset-top)) 1rem .6rem;color:#fff;font-weight:700;" +
        "background:linear-gradient(rgba(0,0,0,.55),transparent)}" +
      ".rp-cam-close{background:none;border:0;color:#fff;font-size:2rem;line-height:1;cursor:pointer}" +
      ".rp-cam-bottom{position:absolute;bottom:0;left:0;right:0;display:grid;grid-template-columns:1fr auto 1fr;" +
        "align-items:center;padding:1rem 1.5rem calc(1.4rem + env(safe-area-inset-bottom));" +
        "background:linear-gradient(transparent,rgba(0,0,0,.6))}" +
      ".rp-cam-shutter{width:74px;height:74px;border-radius:50%;background:#fff;border:5px solid rgba(255,255,255,.45);" +
        "background-clip:padding-box;cursor:pointer;-webkit-tap-highlight-color:transparent}" +
      ".rp-cam-shutter:active{transform:scale(.92)}" +
      ".rp-cam-pick{justify-self:start;background:rgba(255,255,255,.18);color:#fff;border:0;border-radius:20px;" +
        "padding:.5rem .9rem;font-weight:600;cursor:pointer}" +
      ".rp-row{cursor:pointer}" +
      ".rp-thumbs{display:inline-flex;gap:4px;vertical-align:middle;margin-right:.4rem}" +
      ".rp-thumb{width:36px;height:36px;object-fit:cover;border-radius:6px;border:1px solid #e2e8f0}" +
      ".rp-when{font-size:.75rem;color:var(--gray)}" +
      ".rp-more{display:inline-block;margin-left:.5rem;font-size:.72rem;font-weight:600;color:var(--primary);text-decoration:underline}" +
      ".rp-viewer{position:fixed;inset:0;z-index:10000;background:rgba(15,23,42,.88);display:flex;" +
        "flex-direction:column;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)}" +
      ".rp-viewer[hidden]{display:none}" +
      ".rp-viewer-head{display:flex;justify-content:space-between;align-items:center;color:#fff;" +
        "padding:.8rem 1rem;font-weight:700}" +
      ".rp-viewer-close{background:none;border:0;color:#fff;font-size:1.8rem;line-height:1;cursor:pointer}" +
      ".rp-viewer-body{overflow:auto;padding:0 1rem 1rem;display:grid;gap:.8rem;" +
        "grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}" +
      ".rp-fig{margin:0;background:#fff;border-radius:10px;overflow:hidden}" +
      ".rp-fig img{display:block;width:100%;aspect-ratio:4/3;object-fit:cover}" +
      ".rp-fig figcaption{padding:.4rem .6rem;font-size:.75rem;color:#334155}" +
      ".rp-viewer .rp-hint{color:#e2e8f0;padding:1rem}";
    const style = document.createElement("style");
    style.id = "room-photos-styles";
    style.textContent = css;
    document.head.appendChild(style);
  }

  window.RoomPhotos = {
    isPhotoRoom: isPhotoRoom,
    wantsPhotoCheck: wantsPhotoCheck,
    kindsFor: kindsFor,
    open: open,
    close: close,
    detailRows: detailRows,
    detailCard: detailCard,
    renderStrip: renderStrip,
    cardBadge: cardBadge,
    openViewer: openViewer,
  };
})();
