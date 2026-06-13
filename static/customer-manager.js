/**
 * customer-manager.js  — v2
 * Paginated customer list with photo upload (same flow as check-in modal).
 * Fields kept: name + mobile + document photos only.
 */

(function () {
  "use strict";

  const PAGE_SIZE  = 50;
  const MAX_PHOTOS = 3;

  /* ─── State ──────────────────────────────────────────────────────────── */
  let allRows        = [];       // rows loaded so far (for filter chips)
  let displayedRows  = [];       // rows after chip filter
  let nextCursor     = null;     // cursor for next page
  let hasMore        = false;    // more pages available
  let loadingPage    = false;
  let activeFilter   = "all";
  let searchDebounce = null;
  let currentSearch  = "";

  let currentCustomer = null;    // full customer object in detail/edit view
  let editMode        = false;

  // photo upload state for add/edit flow
  let pendingPhotos  = [];       // [{blob, localUrl}]

  /* ─── Open / Close ───────────────────────────────────────────────────── */
  window.openCustomerManager = function () {
    document.getElementById("customer-manager-overlay").classList.add("cm-open");
    document.body.style.overflow = "hidden";
    _resetAndLoad();
  };

  window.closeCustomerManager = function (e) {
    if (e && e.target !== document.getElementById("customer-manager-overlay")) return;
    document.getElementById("customer-manager-overlay").classList.remove("cm-open");
    document.body.style.overflow = "";
  };

  /* ─── Load first page ────────────────────────────────────────────────── */
  function _resetAndLoad(search) {
    allRows       = [];
    displayedRows = [];
    nextCursor    = null;
    hasMore       = false;
    currentSearch = search || "";
    document.getElementById("cm-table-body").innerHTML =
      `<tr><td colspan="6" class="cm-loading"><i class="fas fa-spinner fa-spin"></i> Loading…</td></tr>`;
    document.getElementById("cm-empty").style.display = "none";
    document.getElementById("cm-load-more-row").style.display = "none";
    _fetchPage();
  }

  async function _fetchPage() {
    if (loadingPage) return;
    loadingPage = true;
    _setLoadMoreSpinner(true);

    const params = new URLSearchParams({
      page_size: PAGE_SIZE,
      cursor: nextCursor || "",
      search: currentSearch,
    });

    try {
      const res  = await apiFetch(`/list_customers?${params}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.message || "Load failed");

      const rows = data.customers || [];
      nextCursor = data.next_cursor || null;
      hasMore    = data.has_more || false;

      allRows = allRows.concat(rows);
      _applyChipFilter();
      _updateStats();

    } catch (err) {
      if (!allRows.length) {
        document.getElementById("cm-table-body").innerHTML =
          `<tr><td colspan="6" class="cm-error"><i class="fas fa-exclamation-circle"></i> ${err.message}</td></tr>`;
      }
    } finally {
      loadingPage = false;
      _setLoadMoreSpinner(false);
      document.getElementById("cm-load-more-row").style.display =
        hasMore ? "table-row" : "none";
    }
  }

  /* ─── Search ─────────────────────────────────────────────────────────── */
  window.cmSearch = function (val) {
    document.getElementById("cm-clear-btn").style.display = val ? "flex" : "none";
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => _resetAndLoad(val), 380);
  };

  window.cmClearSearch = function () {
    const inp = document.getElementById("cm-search-input");
    inp.value = "";
    document.getElementById("cm-clear-btn").style.display = "none";
    _resetAndLoad("");
  };

  /* ─── Chip filter ────────────────────────────────────────────────────── */
  window.cmSetFilter = function (f, btn) {
    activeFilter = f;
    document.querySelectorAll(".cm-chip").forEach(c => c.classList.remove("active"));
    btn.classList.add("active");
    _applyChipFilter();
  };

  function _applyChipFilter() {
    switch (activeFilter) {
      case "flagged": displayedRows = allRows.filter(c => c.is_flagged); break;
      case "repeat":  displayedRows = allRows.filter(c => (c.total_stays || 0) > 1); break;
      case "docs":    displayedRows = allRows.filter(c => (c.doc_count || 0) > 0); break;
      default:        displayedRows = [...allRows];
    }
    _renderTable();
  }

  /* ─── Render table ───────────────────────────────────────────────────── */
  function _renderTable() {
    const tbody  = document.getElementById("cm-table-body");
    const emptyEl = document.getElementById("cm-empty");

    if (!displayedRows.length && !hasMore) {
      tbody.innerHTML = "";
      emptyEl.style.display = "flex";
      return;
    }
    emptyEl.style.display = "none";

    tbody.innerHTML = displayedRows.map(c => {
      const initials  = _initials(c.name);
      const avStyle   = _avatarStyle(c.name || c.mobile);
      const lastVisit = c.last_stay_date ? _fmtDate(c.last_stay_date) : "–";
      const docBadge  = c.doc_count > 0
        ? `<span class="cm-doc-chip"><i class="fas fa-id-card"></i> ${c.doc_count}</span>` : "";
      const flagBadge = c.is_flagged
        ? `<span class="cm-flag-chip">🚩</span>` : "";
      const repeatBadge = (c.total_stays || 0) > 1
        ? `<span class="cm-repeat-chip">🔄 ${c.total_stays}x</span>` : "";

      return `
        <tr class="cm-row ${c.is_flagged ? "cm-row-flagged" : ""}"
            onclick="openCustomerDetail('${_esc(c.mobile)}')">
          <td>
            <div class="cm-name-cell">
              <div class="cm-mini-avatar" style="${avStyle}">${initials}</div>
              <div>
                <div class="cm-guest-name">${_esc(c.name) || "<em>No name</em>"}</div>
                <div class="cm-badges">${flagBadge}${repeatBadge}${docBadge}</div>
              </div>
            </div>
          </td>
          <td>${_esc(c.mobile) || "–"}</td>
          <td><strong>${c.total_stays || 0}</strong></td>
          <td>₹${Number(c.total_spent || 0).toLocaleString("en-IN")}</td>
          <td>${lastVisit}</td>
          <td onclick="event.stopPropagation()">
            <div class="cm-action-btns">
              <button class="cm-icon-btn cm-view-btn" title="View / Edit"
                onclick="openCustomerDetail('${_esc(c.mobile)}')">
                <i class="fas fa-eye"></i>
              </button>
            </div>
          </td>
        </tr>`;
    }).join("");
  }

  /* Deterministic avatar gradient from the guest's name — gives each row
     a stable identity colour without storing anything. */
  const _AVATAR_GRADIENTS = [
    "linear-gradient(135deg,#2563eb,#3b82f6)",
    "linear-gradient(135deg,#7c3aed,#a78bfa)",
    "linear-gradient(135deg,#0d9488,#2dd4bf)",
    "linear-gradient(135deg,#d97706,#fbbf24)",
    "linear-gradient(135deg,#db2777,#f472b6)",
    "linear-gradient(135deg,#4f46e5,#818cf8)",
    "linear-gradient(135deg,#059669,#34d399)",
    "linear-gradient(135deg,#b91c1c,#f87171)",
  ];
  function _avatarStyle(seed) {
    let h = 0;
    const s = String(seed || "");
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return `background:${_AVATAR_GRADIENTS[h % _AVATAR_GRADIENTS.length]}`;
  }

  /* ─── Load more (infinite scroll trigger row) ────────────────────────── */
  window.cmLoadMore = function () { if (hasMore) _fetchPage(); };

  function _setLoadMoreSpinner(on) {
    const row = document.getElementById("cm-load-more-row");
    if (row) row.querySelector("td").innerHTML = on
      ? `<i class="fas fa-spinner fa-spin"></i> Loading…`
      : `<button class="cm-load-more-btn" onclick="cmLoadMore()">Load more</button>`;
  }

  function _updateStats() {
    document.getElementById("cm-total-count").textContent = allRows.length + (hasMore ? "+" : "");
  }

  /* ─── Detail panel ───────────────────────────────────────────────────── */
  window.openCustomerDetail = async function (mobile) {
    // Show panel immediately with spinner while loading full data
    document.getElementById("cm-detail-overlay").classList.add("cm-detail-open");
    document.getElementById("cm-detail-body").innerHTML =
      `<div class="cm-detail-loading"><i class="fas fa-spinner fa-spin"></i> Loading…</div>`;

    try {
      const res  = await apiFetch(`/get_customer/${encodeURIComponent(mobile)}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.message || "Not found");
      currentCustomer = data.customer;
      editMode        = false;
      _historyMobile  = null;  // force history re-fetch for this customer
      _renderDetailView();
    } catch (err) {
      document.getElementById("cm-detail-body").innerHTML =
        `<div class="cm-error"><i class="fas fa-exclamation-circle"></i> ${err.message}</div>`;
    }
  };

  window.closeCustomerDetail = function () {
    document.getElementById("cm-detail-overlay").classList.remove("cm-detail-open");
    currentCustomer = null;
    editMode        = false;
    pendingPhotos   = [];
  };

  function _renderDetailView() {
    const c = currentCustomer;
    document.getElementById("cm-detail-title").textContent = c.name || "Customer";

    document.getElementById("cm-edit-toggle").style.display = editMode ? "none" : "inline-flex";
    document.getElementById("cm-save-wrap").style.display   = editMode ? "flex"  : "none";

    const docs = c.id_doc_urls || [];
    const docsHTML = docs.length
      ? docs.map((url, i) => `
          <div class="cm-doc-item">
            <a href="${_esc(url)}" target="_blank">
              <img src="${_esc(url)}" alt="Doc ${i+1}"
                onerror="this.src=''; this.parentElement.innerHTML='<i class=\\'fas fa-file-image\\'></i>'" />
            </a>
            ${editMode ? `<button class="cm-doc-del-btn" onclick="cmDeleteDoc('${_esc(url)}')" title="Remove">
              <i class="fas fa-times"></i></button>` : ""}
          </div>`).join("")
      : `<p class="cm-no-docs">No documents uploaded yet</p>`;

    const uploadSlot = (editMode && docs.length < MAX_PHOTOS)
      ? `<label class="cm-doc-upload-slot" title="Add photo">
           <i class="fas fa-plus"></i><span>Add Photo</span>
           <input type="file" accept="image/*" multiple style="display:none"
             onchange="cmHandlePhotoFiles(this.files,'${_esc(c.mobile)}')" />
         </label>` : "";

    const pendingHTML = editMode && pendingPhotos.length
      ? `<div class="cm-pending-strip">
          ${pendingPhotos.map((p, i) => `
            <div class="cm-doc-item cm-pending">
              <img src="${p.localUrl}" alt="Pending ${i+1}" />
              <button class="cm-doc-del-btn" onclick="cmRemovePending(${i})">
                <i class="fas fa-times"></i></button>
            </div>`).join("")}
         </div>` : "";

    // Flag section — shows current status + action button
    const flagSection = c.is_flagged
      ? `<div class="cm-flag-alert">
           <div class="cm-flag-alert-left">
             <i class="fas fa-exclamation-triangle"></i>
             <div>
               <strong>Flagged Guest</strong>
               <p>${_esc(c.flag_notes || c.flag_reason || "No reason given")}</p>
             </div>
           </div>
           <button class="cm-unflag-btn" onclick="cmOpenFlagModal(false)">
             <i class="fas fa-flag"></i> Unflag
           </button>
         </div>`
      : `<div class="cm-flag-action-row">
           <button class="cm-flag-btn" onclick="cmOpenFlagModal(true)">
             <i class="fas fa-flag"></i> Flag this guest
           </button>
         </div>`;

    document.getElementById("cm-detail-body").innerHTML = `
      <!-- Profile -->
      <div class="cm-profile-card ${c.is_flagged ? "cm-profile-flagged" : ""}">
        <div class="cm-avatar">${_initials(c.name)}</div>
        <div class="cm-profile-info">
          ${editMode
            ? `<input id="cm-edit-name" class="cm-input cm-name-input" value="${_esc(c.name)}" placeholder="Full name" required />`
            : `<h3>${_esc(c.name) || "–"}</h3>`}
          <p><i class="fas fa-phone"></i> ${_esc(c.mobile)}</p>
        </div>
      </div>

      <!-- Stats -->
      <div class="cm-stats-row">
        <div class="cm-stat-box">
          <span class="cm-stat-val">${c.total_stays || 0}</span>
          <span class="cm-stat-label">Stays</span>
        </div>
        <div class="cm-stat-box">
          <span class="cm-stat-val">₹${Number(c.total_spent || 0).toLocaleString("en-IN")}</span>
          <span class="cm-stat-label">Total Spent</span>
        </div>
        <div class="cm-stat-box">
          <span class="cm-stat-val">${c.last_stay_date ? _fmtDate(c.last_stay_date) : "–"}</span>
          <span class="cm-stat-label">Last Visit</span>
        </div>
        <div class="cm-stat-box">
          <span class="cm-stat-val">${c.first_visit ? _fmtDate(c.first_visit) : "–"}</span>
          <span class="cm-stat-label">First Visit</span>
        </div>
      </div>

      <!-- Stay history -->
      <div class="cm-history-section">
        <button class="cm-history-toggle" id="cm-history-toggle"
          onclick="cmToggleHistory('${_esc(c.mobile)}')">
          <span><i class="fas fa-clock-rotate-left"></i> Stay History</span>
          <i class="fas fa-chevron-down" id="cm-history-caret"></i>
        </button>
        <div id="cm-history-body" class="cm-history-body" style="display:none"></div>
      </div>

      <!-- Flag section -->
      ${flagSection}

      <!-- Documents -->
      <div class="cm-docs-section">
        <h4><i class="fas fa-id-card"></i> ID Documents
          <span class="cm-doc-count">${docs.length}/${MAX_PHOTOS}</span>
        </h4>
        <div class="cm-docs-grid" id="cm-docs-grid">
          ${docsHTML}
          ${uploadSlot}
        </div>
        ${pendingHTML}
        ${editMode && pendingPhotos.length
          ? `<button class="cm-btn cm-btn-upload" onclick="cmUploadPendingPhotos('${_esc(c.mobile)}')">
               <i class="fas fa-cloud-upload-alt"></i> Upload ${pendingPhotos.length} Photo${pendingPhotos.length > 1 ? "s" : ""}
             </button>` : ""}
      </div>`;
  }

  /* ─── Stay history ───────────────────────────────────────────────────── */
  let _historyMobile = null;   // mobile whose history is currently rendered
  let _historyCssInjected = false;
  function _ensureHistoryCss() {
    if (_historyCssInjected) return;
    _historyCssInjected = true;
    const css = `
      .cm-history-section { margin: .9rem 0; }
      .cm-history-toggle { width:100%; display:flex; align-items:center; justify-content:space-between;
        background:#fff; border:1.5px solid #e2e8f0; border-radius:12px; padding:.7rem .9rem;
        font-weight:700; color:#1d4ed8; font-size:.9rem; cursor:pointer; transition:border-color .15s,box-shadow .15s; }
      .cm-history-toggle:hover { border-color:#93c5fd; box-shadow:0 2px 10px rgba(59,130,246,.12); }
      .cm-history-toggle i.fa-chevron-down { transition:transform .2s; color:#94a3b8; }
      .cm-history-body { margin-top:.6rem; display:flex; flex-direction:column; gap:.55rem; }
      .cm-history-loading,.cm-history-empty { color:#94a3b8; font-size:.85rem; padding:.7rem; text-align:center; }
      .cm-ht-wrap { overflow-x:auto; -webkit-overflow-scrolling:touch; border:1px solid #eef2f7; border-radius:12px; background:#fff; }
      .cm-ht-table { border-collapse:collapse; width:100%; min-width:560px; font-size:.76rem; }
      .cm-ht-table thead th { position:sticky; top:0; background:#f8fafc; color:#64748b; font-weight:700;
        text-transform:uppercase; letter-spacing:.03em; font-size:.62rem; text-align:left;
        padding:.5rem .55rem; border-bottom:1px solid #e2e8f0; white-space:nowrap; }
      .cm-ht-table td { padding:.5rem .55rem; border-bottom:1px solid #f1f5f9; color:#334155;
        white-space:nowrap; vertical-align:top; }
      .cm-ht-table tbody tr:last-child td { border-bottom:none; }
      .cm-ht-table tbody tr:nth-child(even) td { background:#fcfdff; }
      .cm-ht-n { text-align:right; }
      .cm-ht-c { text-align:center; }
      .cm-ht-room { font-weight:700; color:#0f172a; }
      .cm-ht-bill { display:block; color:#94a3b8; font-weight:600; font-size:.62rem; margin-top:.1rem; }
      .cm-ht-time { display:block; color:#94a3b8; font-size:.64rem; }
      .cm-ht-total { font-weight:700; color:#0f172a; }
      .cm-ht-disc span, .cm-ht-disc { color:#059669; }
      .cm-ht-method { display:block; color:#94a3b8; font-size:.6rem; text-transform:uppercase; letter-spacing:.02em; }
      .cm-ht-due { color:#be123c; font-weight:700; }
      .cm-ht-adv { color:#047857; font-weight:700; }
      .cm-ht-ok  { color:#10b981; font-weight:700; }
      .cm-ht-tag { background:#fffbeb; color:#b45309; border-radius:999px; padding:.02rem .4rem; font-size:.58rem; font-weight:700; }
      .cm-ht-hint { text-align:center; color:#cbd5e1; font-size:.66rem; margin-top:.35rem; }
      @media (min-width:560px) { .cm-ht-hint { display:none; } }`
    const tag = document.createElement("style");
    tag.id = "cm-history-styles";
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  window.cmToggleHistory = async function (mobile) {
    _ensureHistoryCss();
    const body  = document.getElementById("cm-history-body");
    const caret = document.getElementById("cm-history-caret");
    if (!body) return;

    const opening = body.style.display === "none";
    body.style.display = opening ? "block" : "none";
    if (caret) caret.style.transform = opening ? "rotate(180deg)" : "";
    // Re-fetch when opening for a guest we haven't loaded yet. Keying on the
    // mobile (not a boolean) means switching guests — or clearing the search
    // and opening someone else — never shows the previous guest's stays.
    if (!opening || _historyMobile === mobile) return;

    body.innerHTML = `<div class="cm-history-loading"><i class="fas fa-spinner fa-spin"></i> Loading stays…</div>`;
    try {
      const res  = await apiFetch(`/customer_stays/${encodeURIComponent(mobile)}`);
      const data = await res.json();
      const stays = (data && data.success) ? (data.stays || []) : [];
      _historyMobile = mobile;
      _renderHistory(stays);
    } catch (err) {
      body.innerHTML = `<div class="cm-history-empty">Couldn't load history — ${_esc(err.message)}</div>`;
    }
  };

  function _renderHistory(stays) {
    const body = document.getElementById("cm-history-body");
    if (!body) return;
    if (!stays.length) {
      body.innerHTML = `<div class="cm-history-empty">No past stays on record.</div>`;
      return;
    }
    const inr = n => "₹" + Number(n || 0).toLocaleString("en-IN");
    // Compact two-line date: "10 Jun\n19:42"
    const dcell = s => {
      if (!s) return "–";
      const [d, t] = String(s).split(" ");
      const short = _fmtDate(d).replace(/ \d{4}$/, ""); // drop the year for width
      return `${short}${t ? `<span class="cm-ht-time">${t}</span>` : ""}`;
    };
    const method = s => {
      const m = [];
      if (s.paid_cash)   m.push("Cash");
      if (s.paid_online) m.push("Online");
      return m.join("+") || "–";
    };
    const balCell = s => {
      const b = Number(s.balance || 0);
      if (b > 0) return `<span class="cm-ht-due">₹${b.toLocaleString("en-IN")}</span>`;
      if (b < 0) return `<span class="cm-ht-adv">+₹${(-b).toLocaleString("en-IN")}</span>`;
      return `<span class="cm-ht-ok">✓</span>`;
    };

    const rows = stays.map(s => {
      const paid = (s.paid_cash || 0) + (s.paid_online || 0);
      const flag = s.status === "pending_settlement"
        ? ` <span class="cm-ht-tag">settle later</span>` : "";
      return `
        <tr>
          <td class="cm-ht-room">${_esc(s.room) || "–"}${flag}
            ${s.bill_number && s.bill_number !== "-" ? `<span class="cm-ht-bill">${_esc(s.bill_number)}</span>` : ""}</td>
          <td>${dcell(s.checkin_time)}</td>
          <td>${dcell(s.checkout_time)}</td>
          <td class="cm-ht-c">${s.days}d</td>
          <td class="cm-ht-n">${inr(s.room_rate)}</td>
          <td class="cm-ht-n">${s.services_total ? inr(s.services_total) : "–"}</td>
          <td class="cm-ht-n cm-ht-disc">${s.discounts ? "−" + inr(s.discounts) : "–"}</td>
          <td class="cm-ht-n cm-ht-total">${inr(s.total_amount)}</td>
          <td class="cm-ht-n">${inr(paid)}<span class="cm-ht-method">${method(s)}</span></td>
          <td class="cm-ht-n">${balCell(s)}</td>
        </tr>`;
    }).join("");

    body.innerHTML = `
      <div class="cm-ht-wrap">
        <table class="cm-ht-table">
          <thead>
            <tr>
              <th>Room</th><th>Check-in</th><th>Check-out</th><th>Nights</th>
              <th class="cm-ht-n">Rate</th><th class="cm-ht-n">Svc</th>
              <th class="cm-ht-n">Disc</th><th class="cm-ht-n">Total</th>
              <th class="cm-ht-n">Paid</th><th class="cm-ht-n">Bal</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="cm-ht-hint"><i class="fas fa-arrows-left-right"></i> swipe to see all columns</div>`;
  }

  /* ─── Flag modal ─────────────────────────────────────────────────────── */
  window.cmOpenFlagModal = function (flagging) {
    const overlay = document.getElementById("cm-flag-modal-overlay");
    const title   = document.getElementById("cm-flag-modal-title");
    const noteRow = document.getElementById("cm-flag-note-row");
    const noteIn  = document.getElementById("cm-flag-note-input");
    const confirmBtn = document.getElementById("cm-flag-confirm-btn");

    if (flagging) {
      title.textContent = "Flag this guest";
      noteRow.style.display = "block";
      noteIn.value = "";
      noteIn.placeholder = "Reason for flagging (e.g. damaged property, did not pay)…";
      confirmBtn.className = "cm-btn cm-btn-flag-confirm";
      confirmBtn.innerHTML = `<i class="fas fa-flag"></i> Flag Guest`;
    } else {
      title.textContent = "Remove flag from guest";
      noteRow.style.display = "none";
      confirmBtn.className = "cm-btn cm-btn-unflag-confirm";
      confirmBtn.innerHTML = `<i class="fas fa-flag"></i> Confirm Unflag`;
    }
    confirmBtn.onclick = () => cmSubmitFlag(flagging);
    overlay.classList.add("cm-modal-open");
  };

  window.cmCloseFlagModal = function () {
    document.getElementById("cm-flag-modal-overlay").classList.remove("cm-modal-open");
  };

  window.cmSubmitFlag = async function (flagging) {
    const notes  = document.getElementById("cm-flag-note-input")?.value.trim() || "";
    const btn    = document.getElementById("cm-flag-confirm-btn");
    btn.disabled = true;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i>`;

    try {
      const res  = await apiFetch("/toggle_customer_flag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mobile: currentCustomer.mobile, is_flagged: flagging, flag_notes: notes }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);

      currentCustomer.is_flagged  = flagging;
      currentCustomer.flag_notes  = flagging ? notes : "";
      // sync in list
      const idx = allRows.findIndex(r => r.mobile === currentCustomer.mobile);
      if (idx !== -1) allRows[idx].is_flagged = flagging;
      _applyChipFilter();

      cmCloseFlagModal();
      _toast(flagging ? "Guest flagged 🚩" : "Flag removed ✓", flagging ? "warning" : "success");
      _renderDetailView();
    } catch (err) {
      _toast("Error: " + err.message, "error");
    } finally {
      btn.disabled = false;
    }
  };


  /* ─── Edit toggle ────────────────────────────────────────────────────── */
  window.cmToggleEdit = function () {
    editMode = !editMode;
    pendingPhotos = [];
    _renderDetailView();
  };

  /* ─── Save name change ───────────────────────────────────────────────── */
  window.cmSaveCustomer = async function () {
    const nameEl = document.getElementById("cm-edit-name");
    if (!nameEl) return;
    const name = nameEl.value.trim();
    if (!name) { _toast("Name is required", "error"); return; }

    const btn = document.getElementById("cm-save-btn");
    btn.disabled = true;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Saving…`;

    // Upload any pending photos first
    if (pendingPhotos.length) {
      await cmUploadPendingPhotos(currentCustomer.mobile, true);
    }

    try {
      const res  = await apiFetch("/update_customer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mobile: currentCustomer.mobile, name }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);

      currentCustomer.name = name;
      // update local list
      const idx = allRows.findIndex(r => r.mobile === currentCustomer.mobile);
      if (idx !== -1) allRows[idx].name = name;
      _applyChipFilter();

      editMode = false;
      pendingPhotos = [];
      _toast("Saved ✓", "success");
      _renderDetailView();
    } catch (err) {
      _toast("Save failed: " + err.message, "error");
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = `<i class="fas fa-save"></i> Save`; }
    }
  };

  /* ─── Photo handling ─────────────────────────────────────────────────── */
  window.cmHandlePhotoFiles = function (files, mobile) {
    const existing = (currentCustomer && currentCustomer.id_doc_urls || []).length;
    const slots    = MAX_PHOTOS - existing - pendingPhotos.length;
    if (slots <= 0) { _toast(`Maximum ${MAX_PHOTOS} documents reached`, "error"); return; }

    let added = 0;
    for (const file of Array.from(files)) {
      if (added >= slots) break;
      if (!file.type.startsWith("image/")) continue;
      const localUrl = URL.createObjectURL(file);
      pendingPhotos.push({ blob: file, localUrl });
      added++;
    }
    if (added > 0) _renderDetailView();
    else _toast("No valid image files selected", "error");
  };

  window.cmRemovePending = function (idx) {
    URL.revokeObjectURL(pendingPhotos[idx]?.localUrl);
    pendingPhotos.splice(idx, 1);
    _renderDetailView();
  };

  window.cmUploadPendingPhotos = async function (mobile, silent) {
    if (!pendingPhotos.length) return;

    const uploadBtn = document.querySelector(".cm-btn-upload");
    if (uploadBtn) { uploadBtn.disabled = true; uploadBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Uploading…`; }

    let uploaded = 0;
    for (const p of pendingPhotos) {
      try {
        const fd = new FormData();
        fd.append("mobile",   mobile);
        fd.append("document", p.blob, `doc_${Date.now()}.jpg`);
        const res  = await apiFetch("/upload_customer_document", { method: "POST", body: fd });
        const data = await res.json();
        if (data.success) {
          currentCustomer.id_doc_urls = currentCustomer.id_doc_urls || [];
          currentCustomer.id_doc_urls.push(data.url);
          // update doc_count in list
          const idx = allRows.findIndex(r => r.mobile === mobile);
          if (idx !== -1) allRows[idx].doc_count = currentCustomer.id_doc_urls.length;
          uploaded++;
        } else {
          if (!silent) _toast("Upload error: " + data.message, "error");
        }
      } catch (err) {
        if (!silent) _toast("Network error uploading photo", "error");
      }
    }

    // Clean up object URLs
    pendingPhotos.forEach(p => URL.revokeObjectURL(p.localUrl));
    pendingPhotos = [];

    if (!silent) {
      _toast(`${uploaded} photo${uploaded !== 1 ? "s" : ""} uploaded ✓`, "success");
      _renderDetailView();
    }
  };

  window.cmDeleteDoc = async function (url) {
    if (!currentCustomer) return;
    if (!confirm("Remove this document?")) return;

    try {
      const res  = await apiFetch("/delete_customer_document", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mobile: currentCustomer.mobile, url }),
      });
      const data = await res.json();
      if (data.success) {
        currentCustomer.id_doc_urls = (currentCustomer.id_doc_urls || []).filter(u => u !== url);
        const idx = allRows.findIndex(r => r.mobile === currentCustomer.mobile);
        if (idx !== -1) allRows[idx].doc_count = currentCustomer.id_doc_urls.length;
        _toast("Document removed", "success");
        _renderDetailView();
      } else {
        _toast("Delete failed: " + data.message, "error");
      }
    } catch (err) {
      _toast("Network error", "error");
    }
  };

  /* ─── Add Customer ───────────────────────────────────────────────────── */
  window.openAddCustomerForm = function () {
    pendingPhotos = [];
    document.getElementById("cm-add-form").reset();
    document.getElementById("cm-add-pending-photos").innerHTML = "";
    document.getElementById("cm-add-upload-btn").style.display = "none";
    document.getElementById("cm-add-overlay").classList.add("cm-add-open");
  };

  window.closeAddCustomerForm = function () {
    pendingPhotos.forEach(p => URL.revokeObjectURL(p.localUrl));
    pendingPhotos = [];
    document.getElementById("cm-add-overlay").classList.remove("cm-add-open");
  };

  window.cmAddHandlePhotos = function (files) {
    const slots = MAX_PHOTOS - pendingPhotos.length;
    let added = 0;
    for (const f of Array.from(files)) {
      if (added >= slots) break;
      if (!f.type.startsWith("image/")) continue;
      pendingPhotos.push({ blob: f, localUrl: URL.createObjectURL(f) });
      added++;
    }
    _renderAddPhotoPreviews();
    if (pendingPhotos.length >= MAX_PHOTOS)
      document.querySelector(".cm-add-photo-slot").style.display = "none";
  };

  function _renderAddPhotoPreviews() {
    const strip = document.getElementById("cm-add-pending-photos");
    strip.innerHTML = pendingPhotos.map((p, i) => `
      <div class="cm-doc-item cm-pending">
        <img src="${p.localUrl}" alt="Preview ${i+1}" />
        <button type="button" class="cm-doc-del-btn" onclick="cmAddRemovePhoto(${i})">
          <i class="fas fa-times"></i></button>
      </div>`).join("");
    document.getElementById("cm-add-upload-btn").style.display =
      pendingPhotos.length ? "block" : "none";
  }

  window.cmAddRemovePhoto = function (idx) {
    URL.revokeObjectURL(pendingPhotos[idx]?.localUrl);
    pendingPhotos.splice(idx, 1);
    _renderAddPhotoPreviews();
    if (pendingPhotos.length < MAX_PHOTOS)
      document.querySelector(".cm-add-photo-slot").style.display = "flex";
  };

  window.cmSubmitNewCustomer = async function (e) {
    e.preventDefault();
    const btn    = document.getElementById("cm-add-submit-btn");
    btn.disabled = true;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Adding…`;

    const mobile = document.getElementById("cm-add-mobile").value.trim();
    const name   = document.getElementById("cm-add-name").value.trim();

    try {
      const res  = await apiFetch("/add_customer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, mobile }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);

      // Upload photos if any
      for (const p of pendingPhotos) {
        try {
          const fd = new FormData();
          fd.append("mobile",   mobile);
          fd.append("document", p.blob, `doc_${Date.now()}.jpg`);
          await apiFetch("/upload_customer_document", { method: "POST", body: fd });
        } catch (_) {}
      }
      pendingPhotos.forEach(p => URL.revokeObjectURL(p.localUrl));
      pendingPhotos = [];

      _toast("Customer added ✓", "success");
      closeAddCustomerForm();
      _resetAndLoad(currentSearch);
    } catch (err) {
      _toast("Failed: " + err.message, "error");
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<i class="fas fa-plus"></i> Add Customer`;
    }
  };

  /* ─── Helpers ────────────────────────────────────────────────────────── */
  function _initials(name) {
    if (!name) return "?";
    return name.trim().split(/\s+/).slice(0, 2).map(w => w[0].toUpperCase()).join("");
  }
  function _fmtDate(iso) {
    try { return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }); }
    catch { return iso; }
  }
  function _esc(str) {
    if (!str) return "";
    return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }
  function _toast(msg, type) {
    if (typeof window.showNotification === "function") { window.showNotification(msg, type); return; }
    const el = document.createElement("div");
    el.className = `cm-toast cm-toast-${type}`;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.classList.add("cm-toast-show"), 10);
    setTimeout(() => { el.classList.remove("cm-toast-show"); setTimeout(() => el.remove(), 400); }, 3000);
  }

})();
