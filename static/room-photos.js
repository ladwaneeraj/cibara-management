/* ──────────────────────────────────────────────────────────────────────────
 * Inspection photos for rooms 200-228 (manager flow)
 *
 * When a MANAGER approves one of these rooms as ready for check-in, the
 * Quality Check becomes two photos, washroom and room/bed, instead of the
 * tick-box list. Both must be uploaded before "Ready for check-in" is
 * enabled, and the server (routes/rooms.py → services/room_photos.py)
 * enforces the same rule, so this modal is the convenience, not the gate.
 * Admin and housekeeping keep the existing checklist modals. An admin can
 * switch the whole thing off in Settings (ui_config.inspection_photos), in
 * which case managers get the checklist too.
 *
 * Wiring:
 *   • room-cleaning.js markRoomAsCleaned() calls RoomPhotos.wantsPhotoCheck(room)
 *     first and, if true, RoomPhotos.open(room) instead of a checklist modal.
 *   • On approve it calls completeRoomCleaning(room, { photos }), which
 *     forwards the URLs to /mark_room_ready_for_checkin.
 *   • script.js's room-details view calls RoomPhotos.detailRows(info) for a
 *     vacant room (latest pair, who, when) and RoomPhotos.detailCard(info)
 *     for an occupied one (every photo set taken for this stay's prep, from
 *     stay_timeline); "History" opens a viewer over /room_photos, which
 *     lists the last 7 days with the inspector's name from blob metadata.
 *
 * Photos are compressed in the browser (longest side 1280px, JPEG q0.72,
 * roughly 150-300 KB) before upload; the server keeps 6 per room for 7
 * days and prunes the rest automatically.
 * ────────────────────────────────────────────────────────────────────────── */
(function () {
  "use strict";

  const KINDS = [
    { key: "washroom", label: "Washroom", icon: "fa-shower" },
    { key: "bed",      label: "Room & bed", icon: "fa-bed" },
  ];
  const ROOM_MIN = 200, ROOM_MAX = 228;
  const MAX_DIM = 1280, JPEG_Q = 0.72;

  const state = { room: null, urls: {}, busy: {} };

  // ── Policy (mirrors services/room_photos.py) ─────────────────────────────
  function isPhotoRoom(room) {
    const n = parseInt(room, 10);
    return n >= ROOM_MIN && n <= ROOM_MAX;
  }

  // Admin switch (Settings → "Photo check for rooms 200-228"), flag
  // ui_config.inspection_photos. script.js keeps _uiConfigState live via the
  // settings listener; before it exists the server-rendered initial config
  // applies. Default is on. The server checks the same flag.
  function featureOn() {
    const cfg = (typeof _uiConfigState !== "undefined" && _uiConfigState) ||
                window.__initialUIConfig || {};
    return cfg.inspection_photos !== false;
  }

  function wantsPhotoCheck(room) {
    const a = window.CibaraAuth;
    return featureOn() && !!(a && a.isManager && a.isManager()) && isPhotoRoom(room);
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

  async function compress(file) {
    const bmp = await loadBitmap(file);
    const w = bmp.width, h = bmp.height;
    const scale = Math.min(1, MAX_DIM / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    if (bmp.close) bmp.close();
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        blob ? resolve(blob) : reject(new Error("Could not compress photo"));
      }, "image/jpeg", JPEG_Q);
    });
  }

  // ── Upload ───────────────────────────────────────────────────────────────
  async function upload(room, kind, blob) {
    const fd = new FormData();
    fd.append("room", room);
    fd.append("kind", kind);
    fd.append("photo", blob, kind + ".jpg");
    const resp = await apiFetch("/upload_room_photo", { method: "POST", body: fd });
    const data = await resp.json().catch(function () { return {}; });
    if (!resp.ok || !data.success) throw new Error(data.message || "Upload failed");
    return data.url;
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
      '<h2 style="font-size:1.1rem">Room <span id="photo-check-room"></span> · Photo check</h2>' +
      '<button class="close-btn" aria-label="Close">&times;</button></div>' +
      '<div class="modal-body" style="padding:1rem 1.5rem">' +
      '<p class="rp-hint">Take both photos after cleaning. They are kept for 7 days.</p>' +
      '<div class="rp-tiles">' + tiles + "</div>" +
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
    modal.querySelectorAll(".rp-tile input").forEach(function (input) {
      input.addEventListener("change", function () {
        const file = input.files && input.files[0];
        input.value = "";                     // same photo again must re-trigger
        if (file) onPick(input.closest(".rp-tile"), file);
      });
    });
    el("photo-check-approve").addEventListener("click", approve);
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
    const ready = KINDS.every(function (k) { return !!state.urls[k.key]; });
    const busy = Object.keys(state.busy).some(function (k) { return state.busy[k]; });
    el("photo-check-approve").disabled = !ready || busy;
  }

  async function onPick(tile, file) {
    const kind = tile.dataset.kind;
    showError("");
    state.busy[kind] = true;
    refreshApprove();
    setTile(tile, "Uploading…", { busy: true });
    try {
      const blob = await compress(file);
      setTile(tile, "Uploading…", { busy: true, preview: URL.createObjectURL(blob) });
      state.urls[kind] = await upload(state.room, kind, blob);
      setTile(tile, "Done · tap to retake", { done: true });
    } catch (e) {
      delete state.urls[kind];
      setTile(tile, "Failed · tap to try again", { clear: true });
      showError(e.message || "Upload failed");
    } finally {
      state.busy[kind] = false;
      refreshApprove();
    }
  }

  async function approve() {
    const btn = el("photo-check-approve");
    btn.disabled = true;
    try {
      const ok = await completeRoomCleaning(state.room, { photos: Object.assign({}, state.urls) });
      if (ok) close();
    } finally {
      refreshApprove();
    }
  }

  function open(room) {
    ensureModal();
    state.room = String(room);
    state.urls = {};
    state.busy = {};
    el("photo-check-room").textContent = state.room;
    showError("");
    document.querySelectorAll("#photo-check-modal .rp-tile").forEach(function (t) {
      setTile(t, "Tap to take photo", { clear: true });
    });
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
        '<img class="rp-thumb" src="' + esc(p[k.key]) + '" alt="' + k.label + '" title="' + k.label + '"></a>';
    }).join("");
  }

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
      return (
        '<div class="summary-row"><div class="summary-label">' +
        esc(fmt(ev.at)) + (by ? '<br><span class="rp-when">by ' + esc(by) + "</span>" : "") +
        '</div><div class="summary-value"><span class="rp-thumbs">' + thumbs(p) + "</span></div></div>"
      );
    }).join("");
    return (
      '<div class="summary-card" style="margin-bottom:0">' +
      '<div class="summary-title">Inspection photos before this stay</div>' +
      rows +
      '<div class="summary-row rp-row" data-rp-room="' + esc(room) + '">' +
      '<div class="summary-label"></div><div class="summary-value"><span class="rp-more">All photos from the last 7 days</span></div></div>' +
      "</div>"
    );
  }

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
        return (
          '<figure class="rp-fig"><a href="' + esc(ph.url) + '" target="_blank" rel="noopener">' +
          '<img src="' + esc(ph.url) + '" alt="' + esc(k.label) + '" loading="lazy"></a>' +
          "<figcaption>" + esc(k.label) + " · " + esc(fmt(ph.at)) +
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
      ".rp-error{margin:.6rem 0 0;font-size:.8rem;color:var(--danger)}" +
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
    open: open,
    close: close,
    detailRows: detailRows,
    detailCard: detailCard,
    openViewer: openViewer,
  };
})();
