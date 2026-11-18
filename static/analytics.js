// Module-level filter for the two expense charts. Default = "transaction"
// (daily expenses only) — matches what most operators want to see day-to-
// day. The user can switch to "all" or "report" via the dropdown above
// the expense-charts row.
let _expenseTypeFilter = "transaction";

// Last data snapshot the charts rendered against, kept so the filter-
// change handler can re-render without forcing the whole report to
// reload from the server.
let _lastAnalyticsData = null;

// Apply the current filter to a list of expense_logs. Treats missing
// expense_type as "transaction" so legacy expenses from before that
// field existed still show under the Daily filter.
function _filterExpensesByType(expLogs) {
  if (!expLogs) return [];
  if (_expenseTypeFilter === "all") return expLogs;
  return expLogs.filter((l) => {
    const t = (l.expense_type || "transaction").toLowerCase();
    return t === _expenseTypeFilter;
  });
}

function setupChartDefaults() {
  // Disable animations globally
  Chart.defaults.animation = false;
  Chart.defaults.animations = {
    colors: false,
    numbers: false,
  };
  Chart.defaults.transitions = {
    active: {
      animation: {
        duration: 0,
      },
    },
    resize: {
      animation: {
        duration: 0,
      },
    },
  };

  // Set default options for all charts
  Chart.defaults.responsive = true;
  Chart.defaults.maintainAspectRatio = false;
  Chart.defaults.plugins.tooltip.animation = false;
  Chart.defaults.plugins.tooltip.animationDuration = 0;
}

// Initialize analytics components
function initializeAnalytics() {
  // Setup chart defaults
  setupChartDefaults();

  // Setup view toggle buttons
  const viewButtons = document.querySelectorAll(".view-btn");
  if (viewButtons.length) {
    viewButtons.forEach((btn) => {
      btn.addEventListener("click", function () {
        // Update active button
        viewButtons.forEach((b) => b.classList.remove("active"));
        this.classList.add("active");

        // Show corresponding view
        const viewToShow = this.dataset.view;
        const views = document.querySelectorAll(".view-content");
        views.forEach((view) => {
          view.classList.add("hidden");
        });

        const targetView = document.getElementById(`${viewToShow}-view`);
        if (targetView) {
          targetView.classList.remove("hidden");
        }
      });
    });
  }

  // Initialize date pickers with default values (current month)
  const today = new Date();
  const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  const startDateInput = document.getElementById("report-start-date");
  const endDateInput = document.getElementById("report-end-date");

  if (startDateInput && endDateInput) {
    startDateInput.valueAsDate = startOfMonth;
    endDateInput.valueAsDate = today;
  }

  // Initialize analytics view with empty chart containers
  initializeAnalyticsView();
}

// Generate all analytics charts, KPI cards, insights, and billing strip
async function generateAnalytics(reportData) {
  if (!reportData) return;

  // Reset any "no data" placeholders from previous render
  document.querySelectorAll(".chart-empty-msg").forEach(el => el.remove());
  document.querySelectorAll(".chart-body canvas").forEach(c => { c.style.display = ""; });

  // KPI cards + insights
  updateSummaryCards(reportData);

  // Stash the data so the expense-filter dropdown can re-render the two
  // expense charts without re-fetching the whole report.
  _lastAnalyticsData = reportData;

  // Charts that work off the payment-based reportData alone
  generateRevenueExpenseChart(reportData);
  generateDailyRevenueChart(reportData);
  generatePaymentMethodsChart(reportData);
  generateTopRoomsChart(reportData);
  generateExpenseCategoriesChart(reportData);
  generateExpenseTrendChart(reportData);
  generateTopServicesChart(reportData);

  // Wire the expense-type filter dropdown — re-renders just the two
  // expense charts on change. Done after the report's first render so
  // the dropdown element exists in the DOM. Idempotent — re-binding on
  // each report load is fine.
  const _expFilterEl = document.getElementById("analytics-expense-filter");
  if (_expFilterEl && !_expFilterEl.dataset.wired) {
    _expFilterEl.dataset.wired = "1";
    _expFilterEl.value = _expenseTypeFilter;
    _expFilterEl.addEventListener("change", () => {
      _expenseTypeFilter = _expFilterEl.value || "all";
      if (_lastAnalyticsData) {
        generateExpenseCategoriesChart(_lastAnalyticsData);
        generateExpenseTrendChart(_lastAnalyticsData);
      }
    });
  }

  // Register-basis analytics — the single source of truth for money and
  // footfall: occupancy / ADR / RevPAR, outstanding, collected-revenue mix
  // (incl. room revenue by category, replacing the old bills-based chart),
  // channel mix, pace, guest segmentation and the "Where to focus" panel.
  // One cached, admin-only call (/analytics/overview); best-effort — any
  // failure (no permission, no data) leaves the register sections hidden.
  const startDate = document.getElementById("report-start-date")?.value;
  const endDate   = document.getElementById("report-end-date")?.value;
  if (startDate && endDate) {
    await loadBusinessAnalytics(startDate, endDate);
  }

  // Guest demographics (pincode footfall + age) — all-time, independent of
  // the date filter, sourced from ID-document OCR. Best-effort: any failure
  // (no permission, no data, OCR off) just leaves an empty-state card.
  loadDemographicsCharts();
}

// ── Guest demographics: footfall by pincode + age distribution ───────────────
async function loadDemographicsCharts() {
  const pinCanvas = document.getElementById("pincode-footfall-chart");
  const ageCanvas = document.getElementById("guest-age-chart");
  if (!pinCanvas && !ageCanvas) return;

  let agg = null;
  try {
    const resp = await apiFetch("/customer_analytics", { method: "GET" });
    if (resp.ok) {
      const d = await resp.json();
      if (d && d.success) agg = d;
    }
  } catch (e) {
    console.warn("Demographics unavailable:", e);
  }

  if (!agg) {
    if (pinCanvas) showChartEmpty(pinCanvas, "Guest demographics unavailable");
    if (ageCanvas) showChartEmpty(ageCanvas, "Guest demographics unavailable");
    setHeatmapMessage("Guest demographics unavailable");
    return;
  }
  generatePincodeFootfallChart(agg);
  generateGuestAgeChart(agg);
  generatePincodeHeatmap(agg);
}

// Keep one Leaflet map instance + its layers across re-renders.
let _heatMap = null;
let _heatLayer = null;
let _heatMarkers = null;

function setHeatmapMessage(msg) {
  const el = document.getElementById("pincode-heatmap");
  if (!el || _heatMap) return; // don't stomp a live map
  el.innerHTML =
    `<div style="display:flex;height:100%;align-items:center;justify-content:center;
      color:#8a8a8a;font-size:0.9rem;text-align:center;padding:1rem">
      <div><i class="fas fa-map-marked-alt" style="font-size:1.6rem;opacity:0.5"></i>
      <div style="margin-top:0.5rem">${msg}</div></div></div>`;
}

function generatePincodeHeatmap(agg) {
  const el = document.getElementById("pincode-heatmap");
  if (!el) return;

  if (typeof L === "undefined") {
    setHeatmapMessage("Map library still loading — click Apply again");
    return;
  }

  // The analytics view is rebuilt on each Apply, so the map div may be a new
  // element. If our cached map is bound to a detached/old node, tear it down.
  if (_heatMap && _heatMap.getContainer() !== el) {
    try { _heatMap.remove(); } catch (e) {}
    _heatMap = null; _heatLayer = null; _heatMarkers = null;
  }

  const points = (agg.geo_points || []);
  if (points.length === 0) {
    const msg = !agg.geo_available
      ? "PIN-code map data not installed — run scripts/build_pincode_geo.py (a city-level seed is bundled)"
      : (agg.ocr_enabled
          ? "No locatable PIN codes yet — upload guest IDs or run the backfill"
          : "ID-OCR is turned off (set GEMINI_API_KEY / ID_OCR_ENABLED)");
    setHeatmapMessage(msg);
    return;
  }

  // Init the map once.
  if (!_heatMap) {
    el.innerHTML = "";
    _heatMap = L.map(el, { scrollWheelZoom: false, attributionControl: true })
      .setView([22.5, 80], 4); // centred on India
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: "&copy; OpenStreetMap",
    }).addTo(_heatMap);
  }

  // Clear previous data layers.
  if (_heatLayer) { _heatMap.removeLayer(_heatLayer); _heatLayer = null; }
  if (_heatMarkers) { _heatMap.removeLayer(_heatMarkers); _heatMarkers = null; }

  const maxGuests = points.reduce((m, p) => Math.max(m, p.guests), 0) || 1;

  // Heat layer — intensity weighted by guest count (normalised 0..1).
  if (typeof L.heatLayer === "function") {
    const heatData = points.map((p) => [p.lat, p.lon, p.guests / maxGuests]);
    _heatLayer = L.heatLayer(heatData, { radius: 28, blur: 20, maxZoom: 10 })
      .addTo(_heatMap);
  }

  // Circle markers for precise hover/click detail (sized by footfall).
  _heatMarkers = L.layerGroup();
  points.forEach((p) => {
    const r = 5 + 18 * Math.sqrt(p.guests / maxGuests);
    L.circleMarker([p.lat, p.lon], {
      radius: r, color: "#0369a1", weight: 1,
      fillColor: "#0ea5e9", fillOpacity: 0.55,
    })
      .bindPopup(
        `<strong>${p.place || p.pincode}</strong><br>PIN ${p.pincode}` +
        `${p.state ? "<br>" + p.state : ""}` +
        `<br>${p.guests} guest${p.guests === 1 ? "" : "s"}` +
        `${p.visits ? " · " + p.visits + " visits" : ""}`
      )
      .addTo(_heatMarkers);
  });
  _heatMarkers.addTo(_heatMap);

  // Fit to the spread of points, and fix sizing now the container is visible.
  try {
    const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lon]));
    if (bounds.isValid()) _heatMap.fitBounds(bounds.pad(0.2), { maxZoom: 9 });
  } catch (e) { /* keep default India view */ }
  setTimeout(() => { try { _heatMap.invalidateSize(); } catch (e) {} }, 200);
}

function generatePincodeFootfallChart(agg) {
  const canvas = document.getElementById("pincode-footfall-chart");
  if (!canvas) return;
  if (canvas.chart) { canvas.chart.destroy(); canvas.chart = null; }

  const rows = (agg.pincodes || []).slice(0, 15); // top 15 areas
  if (rows.length === 0) {
    const hint = agg.ocr_enabled
      ? "No PIN codes extracted yet — upload guest IDs or run the backfill"
      : "ID-OCR is turned off (set GEMINI_API_KEY / ID_OCR_ENABLED)";
    showChartEmpty(canvas, hint);
    return;
  }

  const labels = rows.map((r) => r.pincode);
  const values = rows.map((r) => r.guests);

  const ctx = canvas.getContext("2d");
  canvas.chart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Guests",
        data: values,
        backgroundColor: "rgba(14, 165, 233, 0.75)",
        borderColor: "#0ea5e9",
        borderWidth: 1,
      }],
    },
    options: {
      indexAxis: "y", // horizontal bars — PIN codes read better stacked
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => {
              const r = rows[c.dataIndex] || {};
              return ` ${r.guests} guest${r.guests === 1 ? "" : "s"}` +
                     (r.visits ? ` · ${r.visits} visits` : "");
            },
          },
        },
      },
      scales: {
        x: { beginAtZero: true, ticks: { precision: 0 } },
      },
    },
  });
}

function generateGuestAgeChart(agg) {
  const canvas = document.getElementById("guest-age-chart");
  if (!canvas) return;
  if (canvas.chart) { canvas.chart.destroy(); canvas.chart = null; }

  const age = agg.age || {};
  const buckets = age.buckets || [];
  const total = age.count || 0;

  // Reflect the average age in the card header.
  const titleEl = canvas.closest(".chart-card")?.querySelector(".chart-hdr-title");
  if (titleEl) {
    titleEl.textContent = age.average != null
      ? `Guest Age Distribution — avg ${age.average} yrs (${total})`
      : "Guest Age Distribution";
  }

  if (total === 0) {
    const hint = agg.ocr_enabled
      ? "No ages extracted yet — upload guest IDs or run the backfill"
      : "ID-OCR is turned off (set GEMINI_API_KEY / ID_OCR_ENABLED)";
    showChartEmpty(canvas, hint);
    return;
  }

  const labels = buckets.map((b) => b.label);
  const values = buckets.map((b) => b.count);

  const bucketGuests = age.bucket_guests || {};

  const ctx = canvas.getContext("2d");
  canvas.chart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Guests",
        data: values,
        backgroundColor: "rgba(22, 163, 74, 0.7)",
        borderColor: "#16a34a",
        borderWidth: 1,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => {
              const pct = total ? ((c.raw / total) * 100).toFixed(0) : 0;
              return ` ${c.raw} guests (${pct}%)`;
            },
            afterLabel: (c) => (c.raw > 0 ? "Click to view guests" : ""),
          },
        },
      },
      scales: {
        y: { beginAtZero: true, ticks: { precision: 0 } },
      },
      onHover: (evt, elements, chart) => {
        chart.canvas.style.cursor = elements.length ? "pointer" : "default";
      },
      onClick: (evt, elements) => {
        if (!elements.length) return;
        const label = labels[elements[0].index];
        _openAgeBucketPopover(label, bucketGuests[label] || [], evt.native);
      },
    },
  });
}

// ── Age bucket drill-down: bar click → guest list → existing Customer
// detail modal (docs + stay history, from customer-manager.js). ───────────
let _ageBucketPopoverEl = null;

function _closeAgeBucketPopover() {
  if (_ageBucketPopoverEl) {
    _ageBucketPopoverEl.remove();
    _ageBucketPopoverEl = null;
  }
  document.removeEventListener("mousedown", _ageBucketPopoverOutsideClick, true);
}

function _ageBucketPopoverOutsideClick(e) {
  if (_ageBucketPopoverEl && !_ageBucketPopoverEl.contains(e.target)) {
    _closeAgeBucketPopover();
  }
}

function _ageEsc(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function _openAgeBucketPopover(label, guests, nativeEvent) {
  _closeAgeBucketPopover();
  if (!guests.length) return;

  const rowsHTML = guests.map((g) => `
    <div class="age-pop-row" data-mobile="${_ageEsc(g.mobile)}">
      <span class="age-pop-name">${_ageEsc(g.name || "Unnamed guest")}</span>
      <span class="age-pop-mobile">${_ageEsc(g.mobile)}</span>
    </div>`).join("");

  const el = document.createElement("div");
  el.className = "age-pop";
  el.innerHTML = `
    <div class="age-pop-hdr">
      <span>${_ageEsc(label)} · ${guests.length} guest${guests.length === 1 ? "" : "s"}</span>
      <button class="age-pop-close" type="button" aria-label="Close">&times;</button>
    </div>
    <div class="age-pop-list">${rowsHTML}</div>`;
  document.body.appendChild(el);
  _ageBucketPopoverEl = el;

  // Position near the click, then clamp inside the viewport.
  const pad = 8;
  let left = nativeEvent.clientX + pad;
  let top = nativeEvent.clientY + pad;
  const rect = el.getBoundingClientRect();
  if (left + rect.width > window.innerWidth - pad) left = window.innerWidth - rect.width - pad;
  if (top + rect.height > window.innerHeight - pad) top = window.innerHeight - rect.height - pad;
  el.style.left = `${Math.max(pad, left)}px`;
  el.style.top = `${Math.max(pad, top)}px`;

  el.querySelector(".age-pop-close").addEventListener("click", _closeAgeBucketPopover);
  el.querySelectorAll(".age-pop-row").forEach((row) => {
    row.addEventListener("click", () => {
      const mobile = row.getAttribute("data-mobile");
      _closeAgeBucketPopover();
      if (typeof window.openCustomerDetail === "function") {
        window.openCustomerDetail(mobile);
      }
    });
  });

  // Defer so the click that opened the popover doesn't immediately close it.
  setTimeout(() => document.addEventListener("mousedown", _ageBucketPopoverOutsideClick, true), 0);
}

// ── Hero KPI grid ────────────────────────────────────────────────────────────
// Money tiles render now from the payment report (collected cash+UPI, never
// bills). The register tiles (Outstanding / Occupancy / ADR / RevPAR / Footfall)
// are placeholders with stable value ids, filled by patchRegisterTiles() once
// /analytics/overview lands.
function heroTile(accent, icon, label, valueHtml, metaHtml, valueId) {
  return `
    <div class="hero-tile" style="--accent:${accent}">
      <div class="hero-ic"><i class="${icon}"></i></div>
      <div class="hero-lbl">${label}</div>
      <div class="hero-val"${valueId ? ` id="${valueId}"` : ""}>${valueHtml}</div>
      <div class="hero-meta"${valueId ? ` id="${valueId}-meta"` : ""}>${metaHtml || ""}</div>
    </div>`;
}

function updateSummaryCards(data) {
  const grid = document.getElementById("analytics-summary");
  if (!grid) return;

  const fmt  = (n) => "₹" + Math.round(n || 0).toLocaleString("en-IN");
  const cash = data.cash_total   || 0;
  const upi  = data.online_total || 0;
  const ref  = data.refund_total || 0;
  const collected = cash + upi;          // all receipts, not just billed
  const exp  = data.expense_total || 0;
  const net  = collected - ref - exp;    // money actually left after refunds+expenses
  const netPos = net >= 0;
  const txnExp = data.transaction_expense_total || 0;
  const repExp = data.report_expense_total      || 0;

  const startDate = document.getElementById("report-start-date")?.value;
  const endDate   = document.getElementById("report-end-date")?.value;
  let days = 1;
  if (startDate && endDate)
    days = Math.max(1, Math.round((new Date(endDate) - new Date(startDate)) / 86400000) + 1);

  grid.innerHTML =
    heroTile("#16a34a","fas fa-indian-rupee-sign","Collected Revenue", fmt(collected),
      `<span><b>${fmt(cash)}</b> cash</span><span><b>${fmt(upi)}</b> UPI</span>`) +

    heroTile("#f59e0b","fas fa-hourglass-half","Outstanding", "…", "register — loading", "hero-outstanding") +

    heroTile("#ef4444","fas fa-receipt","Expenses", fmt(exp),
      `<span><b>${fmt(txnExp)}</b> daily</span><span><b>${fmt(repExp)}</b> report</span>`) +

    heroTile(netPos ? "#2563eb" : "#dc2626","fas fa-chart-line","Net (after refunds)",
      `<span style="color:${netPos ? "#15803d" : "#dc2626"}">${fmt(net)}</span>`,
      `<span>−${fmt(ref)} refunds</span>`) +

    heroTile("#2563eb","fas fa-bed","Occupancy", "…", "register — loading", "hero-occ") +
    heroTile("#166534","fas fa-rupee-sign","ADR", "…", "per occupied night", "hero-adr") +
    heroTile("#6b21a8","fas fa-gauge-high","RevPAR", "…", "per available night", "hero-revpar") +
    heroTile("#b45309","fas fa-right-to-bracket","Check-ins (footfall)", "…", "register — loading", "hero-footfall");

  // Insights panel (payment basis)
  generateInsightsSection(data, days);
}

// Fill the register hero tiles once /analytics/overview is available.
function patchRegisterTiles(data) {
  const fmt = (n) => "₹" + Math.round(n || 0).toLocaleString("en-IN");
  const set = (id, val, meta) => {
    const v = document.getElementById(id);
    const m = document.getElementById(id + "-meta");
    if (v) v.innerHTML = val;
    if (m && meta != null) m.innerHTML = meta;
  };
  const occ  = (data.overview && data.overview.occupancy) || {};
  const out  = data.outstanding || {};
  const g    = data.guests || {};
  const vp   = (data.kpi_comparison && data.kpi_comparison.vs_prior) || {};
  const footfall = (g.new || 0) + (g.returning || 0) + (g.unidentified || 0);

  const occColor = occ.occupancy_over_100 ? "#dc2626" : "";
  set("hero-occ", `<span style="color:${occColor}">${occ.occupancy_pct || 0}%</span>`,
      `${(occ.occupied_room_nights || 0).toLocaleString("en-IN")} of ${(occ.available_room_nights || 0).toLocaleString("en-IN")} nights ${anDeltaBadge(vp.occupancy_pct, "pts")}`);
  set("hero-adr", fmt(occ.adr), `per occupied night ${anDeltaBadge(vp.adr, "pct")}`);
  set("hero-revpar", fmt(occ.revpar), `per available night ${anDeltaBadge(vp.revpar, "pct")}`);
  set("hero-outstanding", fmt(out.total),
      `<span><b>${fmt(out.in_house)}</b> in-house</span><span><b>${fmt(out.settle_later)}</b> settle-later</span>`);
  set("hero-footfall", `${footfall.toLocaleString("en-IN")}`,
      `${g.new || 0} new · ${g.returning || 0} returning · avg stay ${g.avg_los_nights || 0}n`);
}

// ── Key Insights panel (6 cells) ─────────────────────────────────────────────
function generateInsightsSection(data, dayCount) {
  const el = document.getElementById("analytics-insights");
  if (!el) return;

  const fmt = (n) => Math.round(n || 0).toLocaleString("en-IN");
  const cash = data.cash_total || 0;
  const upi  = data.online_total || 0;
  const rev  = cash + upi;
  const allPay = [...(data.cash_logs||[]), ...(data.online_logs||[])];

  // Best day by revenue
  const dayRev = {};
  allPay.forEach(l => { dayRev[l.date] = (dayRev[l.date]||0) + l.amount; });
  const bestDay = Object.entries(dayRev).sort((a,b)=>b[1]-a[1])[0];
  let bestDayStr = "—";
  if (bestDay) {
    const [,m,d] = bestDay[0].split("-");
    bestDayStr = `${d}/${m}  ₹${fmt(bestDay[1])}`;
  }

  // Worst day
  const worstDay = Object.entries(dayRev).sort((a,b)=>a[1]-b[1])[0];
  let worstDayStr = "—";
  if (worstDay && worstDay[0] !== bestDay?.[0]) {
    const [,m,d] = worstDay[0].split("-");
    worstDayStr = `${d}/${m}  ₹${fmt(worstDay[1])}`;
  }

  // Top room
  const roomRev = {};
  allPay.forEach(l => { if(l.room) roomRev[l.room]=(roomRev[l.room]||0)+l.amount; });
  const topRoom = Object.entries(roomRev).sort((a,b)=>b[1]-a[1])[0];
  const topRoomStr = topRoom ? `Room ${topRoom[0]}  ₹${fmt(topRoom[1])}` : "—";

  // Cash vs UPI
  const cashPct = rev>0 ? Math.round((cash/rev)*100) : 0;

  // Top expense category
  const expCat = {};
  (data.expense_logs||[]).forEach(l=>{ const c=l.category||"other"; expCat[c]=(expCat[c]||0)+l.amount; });
  const topExp = Object.entries(expCat).sort((a,b)=>b[1]-a[1])[0];
  const topExpStr = topExp
    ? `${topExp[0].charAt(0).toUpperCase()+topExp[0].slice(1)}  ₹${fmt(topExp[1])}`
    : "None";

  // Expense ratio
  const expRatio = rev>0 ? ((data.expense_total||0)/rev*100).toFixed(0) : 0;

  // Busiest day of week
  const dayNames=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const dowCount={};
  allPay.forEach(l=>{ if(l.date){ const d=new Date(l.date).getDay(); dowCount[d]=(dowCount[d]||0)+1; }});
  const busiest=Object.entries(dowCount).sort((a,b)=>b[1]-a[1])[0];
  const busiestStr = busiest ? `${dayNames[+busiest[0]]} (${busiest[1]} txns)` : "—";

  // Most-paid-by-cash vs UPI guest
  const cashGuests={}, upiGuests={};
  (data.cash_logs||[]).forEach(l=>{ if(l.name) cashGuests[l.name]=(cashGuests[l.name]||0)+l.amount; });
  (data.online_logs||[]).forEach(l=>{ if(l.name) upiGuests[l.name]=(upiGuests[l.name]||0)+l.amount; });
  const topCashGuest=Object.entries(cashGuests).sort((a,b)=>b[1]-a[1])[0];
  const topUpiGuest =Object.entries(upiGuests).sort((a,b)=>b[1]-a[1])[0];
  const guestStr = topCashGuest ? topCashGuest[0].split(" ")[0]+" ₹"+fmt(topCashGuest[1]) : "—";

  function cell(iconBg, iconColor, icon, lbl, val) {
    return `<div class="insight-cell">
      <div class="insight-icon-wrap" style="background:${iconBg};color:${iconColor}">
        <i class="${icon}"></i>
      </div>
      <div>
        <div class="insight-lbl">${lbl}</div>
        <div class="insight-val">${val}</div>
      </div>
    </div>`;
  }

  el.innerHTML = `
    <div class="insights-hdr">
      <i class="fas fa-lightbulb"></i> Key Insights
      <span class="hdr-sub">${dayCount} day${dayCount!==1?"s":""} period</span>
    </div>
    <div class="insights-cells">
      ${cell("#fef9c3","#b45309","fas fa-trophy","Best Revenue Day",bestDayStr)}
      ${cell("#dbeafe","#1d4ed8","fas fa-bed","Top Earning Room",topRoomStr)}
      ${cell("#dcfce7","#166534","fas fa-exchange-alt","Cash vs UPI",`${cashPct}% Cash / ${100-cashPct}% UPI`)}
      ${cell("#fef2f2","#dc2626","fas fa-arrow-up","Top Expense Category",topExpStr)}
      ${cell("#f3e8ff","#7c3aed","fas fa-fire","Busiest Day of Week",busiestStr)}
      ${cell("#e0f2fe","#0369a1","fas fa-percentage","Expense Ratio",`${expRatio}% of Revenue`)}
    </div>`;
}

// A small up/down delta badge for the hero tiles. `d` is {change, pct} from
// kpi_comparison; when pct is null (no base period / no data) nothing is shown.
// `unit` is "pts" for occupancy (change is percentage points) or "pct" for money.
function anDeltaBadge(d, unit) {
  if (!d || d.pct === null || d.pct === undefined) return "";
  const up = (unit === "pts" ? d.change : d.pct) >= 0;
  const color = up ? "#15803d" : "#dc2626";
  const arrow = up ? "▲" : "▼";
  const txt = unit === "pts" ? `${Math.abs(d.change)} pts` : `${Math.abs(d.pct)}%`;
  return `<span class="hero-delta" style="color:${color}">${arrow} ${txt} vs prev</span>`;
}

// ── Business analytics (populated after /analytics/overview) ─────────────────
// One admin-only, cached call drives: the performance strip's comparison, the
// "Where to focus" panel, channel mix, demand patterns, forward pace, guest
// segmentation and cancellations. All backend aggregation — no raw rows reach
// the browser. Guest-controlled text (names, cancel reasons) is escaped.
function anMoney(n) { return "₹" + Math.round(n || 0).toLocaleString("en-IN"); }

// Backend caps the read window at 366 days (_MAX_WINDOW_DAYS); clamp a longer
// selection to the most recent year so the section still loads instead of the
// request 400-ing and the panels silently staying blank.
const BIZ_MAX_DAYS = 366;

function anAddDays(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

async function loadBusinessAnalytics(startDate, endDate) {
  let from = startDate, clamped = false;
  const spanDays = Math.round(
    (Date.parse(endDate + "T00:00:00Z") - Date.parse(startDate + "T00:00:00Z")) / 86400000) + 1;
  if (spanDays > BIZ_MAX_DAYS) {
    from = anAddDays(endDate, -(BIZ_MAX_DAYS - 1));
    clamped = true;
  }

  let data = null;
  try {
    const resp = await apiFetch(
      `/analytics/overview?from=${encodeURIComponent(from)}&to=${encodeURIComponent(endDate)}`,
      { method: "GET" });
    if (resp.ok) {
      const d = await resp.json();
      if (d && d.success) data = d;
    }
  } catch (e) {
    console.warn("Business analytics unavailable:", e);
  }
  if (!data) {
    const biz = document.getElementById("biz-analytics");
    if (biz) biz.style.display = "none";
    renderFocusPanel([], "Business analytics couldn’t load for this range — try a shorter period.");
    return;
  }
  const note = clamped
    ? `Business analytics below covers the last ${BIZ_MAX_DAYS} days (${from} to ${endDate}); the report above uses your full selection.`
    : "";

  // Fill the register hero tiles (Outstanding / Occupancy / ADR / RevPAR /
  // Footfall) with period-over-period deltas.
  patchRegisterTiles(data);

  renderFocusPanel(data.findings, note);

  const biz = document.getElementById("biz-analytics");
  if (biz) biz.style.display = "block";
  renderWeekdayDemand(data.seasonality);
  renderSeasonality(data.seasonality);
  renderRoomCategoryRevenue(data.room_category_revenue);
  renderChannelMix(data.channel_mix);
  renderGuestMix(data.guests);
  renderForwardPace(data.pace);
  renderTopGuests(data.guests);
  renderLosChart(data.los_leadtime);
  renderCancellations(data.cancellations);
}

// "Where to focus" — prioritised, plain-English recommendations (findings).
function renderFocusPanel(findings, note) {
  const panel = document.getElementById("focus-panel");
  if (!panel) return;
  const items = Array.isArray(findings) ? findings : [];
  const tone = { good: ["#dcfce7", "#166534"], warn: ["#fef2f2", "#b91c1c"], info: ["#e0f2fe", "#075985"] };
  let body = "";
  if (items.length === 0) {
    body = note ? "" : `<div class="focus-empty">No urgent issues — occupancy, booking pace and channel mix look healthy for this period.</div>`;
  } else {
    body = items.map((f) => {
      const [bg, fg] = tone[f.level] || tone.info;
      return `<div class="focus-item" style="border-left:3px solid ${fg}">
        <span class="focus-ic" style="background:${bg};color:${fg}"><i class="fas fa-${f.icon || "lightbulb"}"></i></span>
        <span class="focus-txt">${escHtml(f.text || "")}</span></div>`;
    }).join("");
  }
  const noteHtml = note ? `<div class="focus-note">${escHtml(note)}</div>` : "";
  panel.innerHTML =
    `<div class="focus-hdr"><i class="fas fa-bullseye"></i> Where to focus</div>
     ${noteHtml}
     <div class="focus-items">${body}</div>`;
  panel.style.display = "block";
}

function renderWeekdayDemand(seasonality) {
  const canvas = document.getElementById("weekday-demand-chart");
  if (!canvas) return;
  if (canvas.chart) { canvas.chart.destroy(); canvas.chart = null; }
  const rows = (seasonality && seasonality.weekday) || [];
  const vals = rows.map((r) => r.occupancy_pct || 0);
  if (!rows.length || vals.every((v) => v === 0)) {
    showChartEmpty(canvas, "No stay data in this period");
    return;
  }
  const minPos = Math.min(...vals.filter((v) => v > 0));
  const colors = vals.map((v) => (v > 0 && v === minPos ? "#f59e0b" : "#2563eb")); // weakest day amber
  canvas.chart = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: { labels: rows.map((r) => r.weekday.slice(0, 3)),
            datasets: [{ label: "Occupancy %", data: vals, backgroundColor: colors }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: (c) => ` ${c.raw}% occupancy · ADR ${anMoney(rows[c.dataIndex].adr)}` } } },
      scales: { y: { beginAtZero: true, ticks: { callback: (v) => v + "%" } } },
    },
  });
}

function renderSeasonality(seasonality) {
  const canvas = document.getElementById("seasonality-chart");
  if (!canvas) return;
  if (canvas.chart) { canvas.chart.destroy(); canvas.chart = null; }
  const rows = (seasonality && seasonality.months) || [];
  if (!rows.length) { showChartEmpty(canvas, "No trend data"); return; }
  canvas.chart = new Chart(canvas.getContext("2d"), {
    data: { labels: rows.map((r) => r.month), datasets: [
      { type: "line", label: "Occupancy %", data: rows.map((r) => r.occupancy_pct || 0),
        borderColor: "#7c3aed", backgroundColor: "rgba(124,58,237,.1)", yAxisID: "y", tension: 0.3, fill: true },
      { type: "line", label: "RevPAR", data: rows.map((r) => r.revpar || 0),
        borderColor: "#16a34a", yAxisID: "y1", tension: 0.3 },
    ] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: true } },
      scales: {
        y: { position: "left", beginAtZero: true, ticks: { callback: (v) => v + "%" } },
        y1: { position: "right", beginAtZero: true, grid: { drawOnChartArea: false },
              ticks: { callback: (v) => "₹" + v } },
      },
    },
  });
}

function renderChannelMix(mix) {
  const canvas = document.getElementById("channel-mix-chart");
  if (!canvas) return;
  if (canvas.chart) { canvas.chart.destroy(); canvas.chart = null; }
  const rows = (mix && mix.channels) || [];
  if (!rows.length) { showChartEmpty(canvas, "No channel data in this period"); return; }
  canvas.chart = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: { labels: rows.map((r) => r.channel), datasets: [
      { label: "Net revenue", data: rows.map((r) => r.net || 0), backgroundColor: "#0891b2" },
      { label: "Commission", data: rows.map((r) => r.commission || 0), backgroundColor: "#f87171" },
    ] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: true },
        tooltip: { callbacks: { afterBody: (its) => {
          const r = rows[its[0].dataIndex];
          return `Net ADR ${anMoney(r.net_adr)} · ${r.share_pct}% of revenue · ${r.room_nights} nights`;
        } } } },
      scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { callback: (v) => "₹" + v } } },
    },
  });
}

function renderGuestMix(g) {
  const canvas = document.getElementById("guest-mix-chart");
  if (!canvas) return;
  if (canvas.chart) { canvas.chart.destroy(); canvas.chart = null; }
  g = g || {};
  const data = [g.new || 0, g.returning || 0, g.unidentified || 0];
  if (data.reduce((a, b) => a + b, 0) === 0) {
    showChartEmpty(canvas, "No guest check-ins in this period");
    return;
  }
  canvas.chart = new Chart(canvas.getContext("2d"), {
    type: "doughnut",
    data: { labels: ["New", "Returning", "Unidentified"],
            datasets: [{ data, backgroundColor: ["#38bdf8", "#16a34a", "#cbd5e1"] }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, cutout: "60%",
      plugins: {
        legend: { position: "bottom" },
        title: { display: true, text: `${g.returning_pct || 0}% returning · avg stay ${g.avg_los_nights || 0} nights` },
      },
    },
  });
}

function renderForwardPace(pace) {
  const body = document.getElementById("forward-pace-body");
  if (!body) return;
  const hz = (pace && pace.horizons) || {};
  const row = (h) => {
    const v = hz[h] || hz[String(h)];
    if (!v) return "";
    const d = v.delta;
    const badge = (d && d.occupancy_pct != null)
      ? ` <span style="color:${d.occupancy_pct >= 0 ? "#15803d" : "#dc2626"};font-size:.72rem">
          ${d.occupancy_pct >= 0 ? "▲" : "▼"} ${Math.abs(d.occupancy_pct)} pts vs last wk</span>`
      : "";
    return `<div style="display:flex;justify-content:space-between;align-items:baseline;padding:.5rem 0;border-bottom:1px solid #f0f0f0">
      <div><div style="font-weight:600">Next ${h} nights</div>
        <div style="font-size:.78rem;color:#64748b">${v.occupied_room_nights}/${v.available_room_nights} room-nights booked</div></div>
      <div style="text-align:right"><div style="font-size:1.2rem;font-weight:700">${v.occupancy_pct || 0}%</div>
        <div style="font-size:.78rem;color:#64748b">${anMoney(v.on_books_revenue)}${badge}</div></div></div>`;
  };
  const html = [7, 30].map(row).join("");
  body.innerHTML = html || `<div class="focus-empty">Nothing on the books for the days ahead.</div>`;
}

function renderTopGuests(g) {
  const body = document.getElementById("top-guests-body");
  if (!body) return;
  const rows = (g && g.top_guests) || [];
  if (!rows.length) { body.innerHTML = `<div class="focus-empty">No identified guests in this period.</div>`; return; }
  body.innerHTML = rows.map((r, i) =>
    `<div style="display:flex;justify-content:space-between;align-items:center;padding:.4rem .2rem;border-bottom:1px solid #f3f3f3">
      <div style="display:flex;gap:.5rem;align-items:center;min-width:0">
        <span style="width:20px;height:20px;border-radius:50%;background:#fde68a;color:#92400e;font-size:.72rem;font-weight:700;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto">${i + 1}</span>
        <span style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(r.name || "")}</span></div>
      <div style="text-align:right;flex:0 0 auto"><div style="font-weight:700">${anMoney(r.revenue)}</div>
        <div style="font-size:.72rem;color:#64748b">${r.visits} visit${r.visits === 1 ? "" : "s"} · ${r.nights} nights</div></div></div>`
  ).join("");
}

function renderLosChart(ll) {
  const canvas = document.getElementById("los-chart");
  if (!canvas) return;
  if (canvas.chart) { canvas.chart.destroy(); canvas.chart = null; }
  const rows = (ll && ll.los) || [];
  const total = rows.reduce((a, r) => a + (r.count || 0), 0);
  if (total === 0) { showChartEmpty(canvas, "No stays in this period"); return; }
  canvas.chart = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: { labels: rows.map((r) => r.bucket + (r.bucket === "1" ? " night" : " nights")),
            datasets: [{ label: "Stays", data: rows.map((r) => r.count || 0), backgroundColor: "#f59e0b" }] },
    options: { responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
  });
}

function renderCancellations(cx) {
  const body = document.getElementById("cancellations-body");
  if (!body) return;
  cx = cx || {};
  if (!cx.total) { body.innerHTML = `<div class="focus-empty">No check-ins to measure cancellations against.</div>`; return; }
  const reasons = (cx.top_reasons || []).map((r) =>
    `<div style="display:flex;justify-content:space-between;font-size:.82rem;padding:.2rem 0">
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(r.reason || "")}</span>
      <span style="font-weight:600">${r.count}</span></div>`).join("");
  const rateColor = cx.rate_pct >= 15 ? "#dc2626" : "#1e293b";
  body.innerHTML =
    `<div style="display:flex;gap:1rem;align-items:baseline;margin-bottom:.5rem">
      <div style="font-size:1.6rem;font-weight:800;color:${rateColor}">${cx.rate_pct || 0}%</div>
      <div style="font-size:.82rem;color:#64748b">${cx.cancelled} of ${cx.total} stays cancelled</div></div>
     ${reasons ? `<div style="border-top:1px solid #f0f0f0;padding-top:.4rem">
       <div style="font-size:.72rem;color:#8a8a8a;text-transform:uppercase;letter-spacing:.3px;margin-bottom:.2rem">Top reasons</div>${reasons}</div>` : ""}`;
}

// Revenue & Expense Chart (Line Chart)
function generateRevenueExpenseChart(data) {
  const chartCanvas = document.getElementById("revenue-expense-chart");
  if (!chartCanvas) return;

  // Clear any existing chart
  if (chartCanvas.chart) {
    chartCanvas.chart.destroy();
  }

  // Create datasets based on dates
  const dates = [
    ...new Set([
      ...(data.cash_logs || []).map((log) => log.date),
      ...(data.online_logs || []).map((log) => log.date),
      ...(data.expense_logs || []).map((log) => log.date),
    ]),
  ].sort();

  // Calculate daily totals
  const revenueData = dates.map((date) => {
    const cashTotal = (data.cash_logs || [])
      .filter((log) => log.date === date)
      .reduce((sum, log) => sum + log.amount, 0);

    const onlineTotal = (data.online_logs || [])
      .filter((log) => log.date === date)
      .reduce((sum, log) => sum + log.amount, 0);

    return cashTotal + onlineTotal;
  });

  const expenseData = dates.map((date) => {
    return (data.expense_logs || [])
      .filter((log) => log.date === date)
      .reduce((sum, log) => sum + log.amount, 0);
  });

  // Format dates for display
  const formattedDates = dates.map((date) => {
    const [year, month, day] = date.split("-");
    return `${day}/${month}`;
  });

  // Create chart
  const ctx = chartCanvas.getContext("2d");
  chartCanvas.chart = new Chart(ctx, {
    type: "line",
    data: {
      labels: formattedDates,
      datasets: [
        {
          label: "Revenue",
          data: revenueData,
          borderColor: "#4361ee",
          backgroundColor: "rgba(67, 97, 238, 0.1)",
          tension: 0.3,
          fill: true,
        },
        {
          label: "Expenses",
          data: expenseData,
          borderColor: "#e63946",
          backgroundColor: "rgba(230, 57, 70, 0.1)",
          tension: 0.3,
          fill: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      hover: {
        animationDuration: 0,
      },
      responsiveAnimationDuration: 0,
      onResize: null,
      plugins: {
        legend: {
          position: "top",
        },
        tooltip: {
          callbacks: {
            label: function (context) {
              return `${context.dataset.label}: ₹${context.raw}`;
            },
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            callback: function (value) {
              return "₹" + value;
            },
          },
        },
      },
    },
  });
}

// Top 10 Rooms Chart (Bar Chart)
function generateTopRoomsChart(data) {
  const chartCanvas = document.getElementById("top-rooms-chart");
  if (!chartCanvas) return;

  // Clear any existing chart
  if (chartCanvas.chart) {
    chartCanvas.chart.destroy();
  }

  // Combine all room logs
  const allRoomLogs = [...(data.cash_logs || []), ...(data.online_logs || [])];

  // Calculate revenue per room
  const roomRevenue = {};
  allRoomLogs.forEach((log) => {
    if (!roomRevenue[log.room]) {
      roomRevenue[log.room] = 0;
    }
    roomRevenue[log.room] += log.amount;
  });

  // Sort rooms by revenue and get top 10
  const topRooms = Object.entries(roomRevenue)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const roomNumbers = topRooms.map((room) => `Room ${room[0]}`);
  const roomValues = topRooms.map((room) => room[1]);

  // Create chart
  const ctx = chartCanvas.getContext("2d");
  chartCanvas.chart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: roomNumbers,
      datasets: [
        {
          label: "Revenue",
          data: roomValues,
          backgroundColor: "rgba(67, 97, 238, 0.7)",
          borderColor: "#4361ee",
          borderWidth: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      hover: {
        animationDuration: 0,
      },
      responsiveAnimationDuration: 0,
      onResize: null,
      plugins: {
        legend: {
          display: false,
        },
        tooltip: {
          callbacks: {
            label: function (context) {
              return `Revenue: ₹${context.raw}`;
            },
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            callback: function (value) {
              return "₹" + value;
            },
          },
        },
      },
    },
  });
}

// Payment Methods Chart (Pie Chart)
function generatePaymentMethodsChart(data) {
  const chartCanvas = document.getElementById("payment-methods-chart");
  if (!chartCanvas) return;

  // Clear any existing chart
  if (chartCanvas.chart) {
    chartCanvas.chart.destroy();
  }

  // Calculate totals by payment method
  const cashTotal = (data.cash_logs || []).reduce(
    (sum, log) => sum + log.amount,
    0
  );
  const onlineTotal = (data.online_logs || []).reduce(
    (sum, log) => sum + log.amount,
    0
  );

  // Create chart
  const ctx = chartCanvas.getContext("2d");
  chartCanvas.chart = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: ["Cash", "Online"],
      datasets: [
        {
          data: [cashTotal, onlineTotal],
          backgroundColor: [
            "rgba(39, 174, 96, 0.7)",
            "rgba(41, 128, 185, 0.7)",
          ],
          borderColor: ["#27ae60", "#2980b9"],
          borderWidth: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      hover: {
        animationDuration: 0,
      },
      responsiveAnimationDuration: 0,
      onResize: null,
      plugins: {
        legend: {
          position: "top",
        },
        tooltip: {
          callbacks: {
            label: function (context) {
              const total = cashTotal + onlineTotal;
              const percentage = ((context.raw / total) * 100).toFixed(1);
              return `${context.label}: ₹${context.raw} (${percentage}%)`;
            },
          },
        },
      },
    },
  });
}

// Expense Categories Chart (Pie Chart)
function generateExpenseCategoriesChart(data) {
  const chartCanvas = document.getElementById("expense-categories-chart");
  if (!chartCanvas) return;

  // Clear any existing chart
  if (chartCanvas.chart) {
    chartCanvas.chart.destroy();
  }

  // Group expenses by category — respects the Daily/Report/All filter
  // selected via the dropdown above the expense charts row.
  const expenseCategories = {};
  _filterExpensesByType(data.expense_logs || []).forEach((log) => {
    const category = log.category || "Other";
    if (!expenseCategories[category]) {
      expenseCategories[category] = 0;
    }
    expenseCategories[category] += log.amount;
  });

  // Sort categories by amount
  const sortedCategories = Object.entries(expenseCategories).sort(
    (a, b) => b[1] - a[1]
  );

  const categoryLabels = sortedCategories.map(
    (cat) => cat[0].charAt(0).toUpperCase() + cat[0].slice(1)
  );
  const categoryValues = sortedCategories.map((cat) => cat[1]);

  // Generate colors
  const backgroundColors = [
    "rgba(230, 57, 70, 0.7)",
    "rgba(241, 196, 15, 0.7)",
    "rgba(142, 68, 173, 0.7)",
    "rgba(231, 76, 60, 0.7)",
    "rgba(26, 188, 156, 0.7)",
    "rgba(52, 152, 219, 0.7)",
    "rgba(155, 89, 182, 0.7)",
    "rgba(52, 73, 94, 0.7)",
  ];

  const borderColors = [
    "#e63946",
    "#f1c40f",
    "#8e44ad",
    "#e74c3c",
    "#1abc9c",
    "#3498db",
    "#9b59b6",
    "#34495e",
  ];

  // Create chart
  const ctx = chartCanvas.getContext("2d");
  chartCanvas.chart = new Chart(ctx, {
    type: "pie",
    data: {
      labels: categoryLabels,
      datasets: [
        {
          data: categoryValues,
          backgroundColor: backgroundColors.slice(0, categoryValues.length),
          borderColor: borderColors.slice(0, categoryValues.length),
          borderWidth: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      hover: {
        animationDuration: 0,
      },
      responsiveAnimationDuration: 0,
      onResize: null,
      plugins: {
        legend: {
          position: "right",
          labels: {
            boxWidth: 12,
            padding: 10,
          },
        },
        tooltip: {
          callbacks: {
            label: function (context) {
              const total = categoryValues.reduce((a, b) => a + b, 0);
              const percentage = ((context.raw / total) * 100).toFixed(1);
              return `${context.label}: ₹${context.raw} (${percentage}%)`;
            },
          },
        },
      },
    },
  });
}

// Daily Revenue Breakdown (Bar Chart) - NEW CHART
function generateDailyRevenueChart(data) {
  const chartCanvas = document.getElementById("daily-revenue-chart");
  if (!chartCanvas) return;

  // Clear any existing chart
  if (chartCanvas.chart) {
    chartCanvas.chart.destroy();
  }

  // Create datasets based on dates
  const dates = [
    ...new Set([
      ...(data.cash_logs || []).map((log) => log.date),
      ...(data.online_logs || []).map((log) => log.date),
    ]),
  ].sort();

  // Calculate daily totals by payment method
  const cashData = dates.map((date) => {
    return (data.cash_logs || [])
      .filter((log) => log.date === date)
      .reduce((sum, log) => sum + log.amount, 0);
  });

  const onlineData = dates.map((date) => {
    return (data.online_logs || [])
      .filter((log) => log.date === date)
      .reduce((sum, log) => sum + log.amount, 0);
  });

  // Format dates for display
  const formattedDates = dates.map((date) => {
    const [year, month, day] = date.split("-");
    return `${day}/${month}`;
  });

  // Create chart
  const ctx = chartCanvas.getContext("2d");
  chartCanvas.chart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: formattedDates,
      datasets: [
        {
          label: "Cash",
          data: cashData,
          backgroundColor: "rgba(39, 174, 96, 0.7)",
          borderColor: "#27ae60",
          borderWidth: 1,
        },
        {
          label: "Online",
          data: onlineData,
          backgroundColor: "rgba(41, 128, 185, 0.7)",
          borderColor: "#2980b9",
          borderWidth: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      hover: {
        animationDuration: 0,
      },
      responsiveAnimationDuration: 0,
      onResize: null,
      plugins: {
        legend: {
          position: "top",
        },
        tooltip: {
          callbacks: {
            label: function (context) {
              return `${context.dataset.label}: ₹${context.raw}`;
            },
          },
        },
      },
      scales: {
        x: {
          stacked: true,
        },
        y: {
          stacked: true,
          beginAtZero: true,
          ticks: {
            callback: function (value) {
              return "₹" + value;
            },
          },
        },
      },
    },
  });
}

// Top Services/Add-ons Chart (Horizontal Bar) - NEW CHART
// Show "no data" placeholder inside a chart canvas container
function showChartEmpty(canvas, message) {
  const parent = canvas.parentElement;
  canvas.style.display = "none";
  const existing = parent.querySelector(".chart-empty-msg");
  if (!existing) {
    const el = document.createElement("div");
    el.className = "chart-empty-msg";
    el.innerHTML = `<i class="fas fa-chart-bar"></i><span>${message}</span>`;
    parent.appendChild(el);
  }
}

function generateTopServicesChart(data) {
  const chartCanvas = document.getElementById("top-services-chart");
  if (!chartCanvas) return;

  // Clear any existing chart
  if (chartCanvas.chart) {
    chartCanvas.chart.destroy();
    chartCanvas.chart = null;
  }

  // Group add-ons by type
  const serviceRevenue = {};
  (data.addon_logs || []).forEach((log) => {
    const serviceName = log.item || log.description || "Other";
    if (!serviceRevenue[serviceName]) {
      serviceRevenue[serviceName] = 0;
    }
    serviceRevenue[serviceName] += (log.amount || 0);   // stored as "amount" in payments collection
  });

  // Sort services by revenue and get top 8
  const topServices = Object.entries(serviceRevenue)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  if (topServices.length === 0) {
    showChartEmpty(chartCanvas, "No add-on services recorded in this period");
    return;
  }

  const serviceNames = topServices.map((service) => service[0]);
  const serviceValues = topServices.map((service) => service[1]);

  // Create chart
  const ctx = chartCanvas.getContext("2d");
  chartCanvas.chart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: serviceNames,
      datasets: [
        {
          label: "Revenue",
          data: serviceValues,
          backgroundColor: "rgba(255, 159, 28, 0.7)",
          borderColor: "#ff9f1c",
          borderWidth: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      hover: {
        animationDuration: 0,
      },
      responsiveAnimationDuration: 0,
      onResize: null,
      indexAxis: "y",
      plugins: {
        legend: {
          display: false,
        },
        tooltip: {
          callbacks: {
            label: function (context) {
              return `Revenue: ₹${context.raw}`;
            },
          },
        },
      },
      scales: {
        x: {
          beginAtZero: true,
          ticks: {
            callback: function (value) {
              return "₹" + value;
            },
          },
        },
      },
    },
  });
}

// ── Room Revenue by Category (register basis) ─────────────────────────────────
// Bar chart of room (accommodation) charges grouped by rate category for the
// selected window, from /analytics/overview (data.room_category_revenue).
// Register basis — in-house stays count too, not just finalised bills — so it
// replaces the old bills/checkout "Revenue by Room Type" chart. The register
// map has no Premium-AC split (AC is a price toggle within Premium).
function renderRoomCategoryRevenue(rows) {
  const canvas = document.getElementById("room-type-revenue-chart");
  if (!canvas) return;
  if (canvas.chart) { canvas.chart.destroy(); canvas.chart = null; }

  rows = (rows || []).filter((r) => (r.revenue || 0) > 0);
  if (rows.length === 0) {
    showChartEmpty(canvas, "No room revenue in this period");
    return;
  }

  const LABEL = {
    "premium": "Premium", "regular": "Regular", "deluxe": "Deluxe",
    "single-attach": "Single Attach", "single-non-attach": "Single Non-Attach",
    "double-non-attach": "Double Non-Attach", "party-hall": "Party Hall", "other": "Other",
  };
  const COLOR = {
    "premium":           "rgba(37, 99, 235, 0.75)",   // blue
    "regular":           "rgba(124, 58, 237, 0.75)",   // purple
    "deluxe":            "rgba(245, 158, 11, 0.75)",   // amber
    "single-attach":     "rgba(22, 163, 74, 0.75)",    // green
    "single-non-attach": "rgba(132, 204, 22, 0.75)",   // lime
    "double-non-attach": "rgba(234, 88, 12, 0.75)",    // orange
    "party-hall":        "rgba(219, 39, 119, 0.75)",   // pink
    "other":             "rgba(107, 114, 128, 0.75)",  // grey
  };
  const labels = rows.map((r) => LABEL[r.category] || r.category);
  const data   = rows.map((r) => Math.round(r.revenue || 0));
  const bg     = rows.map((r) => COLOR[r.category] || COLOR["other"]);

  const ctx = canvas.getContext("2d");
  canvas.chart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Revenue",
        data,
        backgroundColor: bg,
        borderWidth: 0,
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `Room charges: ₹${(ctx.raw || 0).toLocaleString("en-IN")}`,
          },
        },
      },
      scales: {
        x: {
          ticks: {
            // Long labels like "Single Non-Attach" can collide on narrow
            // screens — let Chart.js wrap automatically.
            autoSkip: false,
            maxRotation: 30,
            minRotation: 0,
          },
        },
        y: {
          beginAtZero: true,
          ticks: {
            callback: (v) => "₹" + (v >= 1000 ? (v / 1000).toFixed(0) + "k" : v),
          },
        },
      },
    },
  });
}

// ── Expense Trend Chart (bar + cumulative line) ───────────────────────────────
function generateExpenseTrendChart(data) {
  const canvas = document.getElementById("expense-trend-chart");
  if (!canvas) return;
  if (canvas.chart) canvas.chart.destroy();

  // Respect the Daily/Report/All filter shared with the Breakdown chart.
  const expLogs = _filterExpensesByType(data.expense_logs || []);
  if (expLogs.length === 0) {
    canvas.chart = null;
    showChartEmpty(canvas, "No expense records in this period");
    return;
  }

  const dates = [...new Set(expLogs.map(l => l.date))].sort();
  const daily = dates.map(d => expLogs.filter(l => l.date === d).reduce((s,l) => s+(l.amount||0), 0));

  // Cumulative
  const cumul = [];
  daily.reduce((acc, v, i) => { cumul[i] = acc + v; return cumul[i]; }, 0);

  const labels = dates.map(d => { const [,m,day]=d.split("-"); return `${day}/${m}`; });

  const ctx = canvas.getContext("2d");
  canvas.chart = new Chart(ctx, {
    type: "bar",        // root type required for mixed charts in Chart.js v3+
    data: {
      labels,
      datasets: [
        {
          type: "bar",
          label: "Daily",
          data: daily,
          backgroundColor: "rgba(239,68,68,0.55)",
          borderColor: "#ef4444",
          borderWidth: 1,
          borderRadius: 4,
          yAxisID: "y",
        },
        {
          type: "line",
          label: "Cumulative",
          data: cumul,
          borderColor: "#f97316",
          backgroundColor: "rgba(249,115,22,0.08)",
          borderWidth: 2,
          pointRadius: 3,
          tension: 0.35,
          fill: true,
          yAxisID: "y1",
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { position: "top" },
        tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ₹${(ctx.raw||0).toLocaleString("en-IN")}` } },
      },
      scales: {
        y:  { beginAtZero: true, ticks: { callback: v => "₹"+v } },
        y1: { position: "right", beginAtZero: true, ticks: { callback: v => "₹"+v }, grid: { drawOnChartArea: false } },
      },
    },
  });
}

// ── Full analytics view HTML (new layout) ────────────────────────────────────
function initializeAnalyticsView() {
  const view = document.getElementById("analytics-view");
  if (!view) return;

  function chartCard(id, iconColor, icon, title, height = 270) {
    return `<div class="chart-card" style="height:${height}px">
      <div class="chart-hdr">
        <i class="chart-hdr-icon ${icon}" style="color:${iconColor}"></i>
        <span class="chart-hdr-title">${title}</span>
      </div>
      <div class="chart-body"><canvas id="${id}"></canvas></div>
    </div>`;
  }

  // Section header: uppercase label + thin rule + muted sublabel.
  function section(icon, title, sub) {
    return `<div class="an-section"><i class="${icon}"></i><span class="an-section-t">${title}</span>${
      sub ? `<span class="an-section-s">${sub}</span>` : ""}<span class="an-section-rule"></span></div>`;
  }

  view.innerHTML = `
    <style>
      /* Analytics v2 — register-basis dashboard. Money = collected cash+UPI,
         never bills. Tokens kept local so the rest of the classic UI is untouched. */
      .an-wrap{--an-line:#e6e8ef;--an-muted:#6b7280;--an-ink:#0f1d36}
      .an-section{display:flex;align-items:center;gap:.55rem;margin:1.5rem 0 .7rem}
      .an-section>i{color:var(--an-ink);font-size:.9rem}
      .an-section-t{font-size:.8rem;font-weight:800;letter-spacing:.8px;text-transform:uppercase;color:var(--an-ink)}
      .an-section-s{font-size:.76rem;color:var(--an-muted)}
      .an-section-rule{flex:1;height:1px;background:var(--an-line)}
      .hero-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:.7rem}
      @media(max-width:1100px){.hero-grid{grid-template-columns:repeat(2,1fr)}}
      @media(max-width:560px){.hero-grid{grid-template-columns:1fr}}
      .hero-tile{position:relative;background:#fff;border:1px solid var(--an-line);border-radius:12px;
        padding:.85rem .95rem .8rem;box-shadow:0 1px 2px rgba(16,24,40,.04);overflow:hidden}
      .hero-tile::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--accent)}
      .hero-ic{position:absolute;top:.8rem;right:.85rem;color:var(--accent);opacity:.9;font-size:1rem}
      .hero-lbl{font-size:.72rem;font-weight:600;letter-spacing:.3px;color:var(--an-muted);text-transform:uppercase}
      .hero-val{font-size:1.5rem;font-weight:800;color:var(--an-ink);line-height:1.15;margin-top:.2rem}
      .hero-meta{margin-top:.3rem;font-size:.74rem;color:var(--an-muted);display:flex;flex-wrap:wrap;gap:.35rem}
      .hero-meta b{font-weight:700;color:#334155}
      .hero-delta{font-size:.72rem;font-weight:700}
      .focus-panel{background:#fff;border:1px solid var(--an-line);border-radius:12px;padding:0.9rem 1rem;margin:1rem 0 0;box-shadow:0 1px 2px rgba(16,24,40,.04)}
      .focus-hdr{font-weight:700;font-size:0.95rem;color:#1e293b;margin-bottom:0.6rem}
      .focus-hdr i{color:#2563eb;margin-right:0.4rem}
      .focus-items{display:flex;flex-direction:column;gap:0.45rem}
      .focus-item{display:flex;align-items:flex-start;gap:0.6rem;padding:0.5rem 0.6rem;background:#fafbfc;border-radius:6px}
      .focus-ic{width:26px;height:26px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;font-size:0.8rem;flex:0 0 auto}
      .focus-txt{font-size:0.86rem;color:#334155;line-height:1.35}
      .focus-empty{font-size:0.86rem;color:#64748b;padding:0.3rem 0.1rem}
      .focus-note{font-size:0.8rem;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:0.4rem 0.55rem;margin-bottom:0.55rem}
    </style>
    <div class="an-wrap">

    <!-- Hero KPIs: money = collected cash+UPI; register occupancy + outstanding -->
    <div class="hero-grid" id="analytics-summary"></div>

    <!-- Where to focus (prioritised recommendations from /analytics/overview) -->
    <div class="focus-panel" id="focus-panel" style="display:none"></div>

    <!-- Insights panel (payment basis) -->
    <div class="insights-panel" id="analytics-insights" style="margin-top:1rem">
      <div class="insights-hdr"><i class="fas fa-lightbulb"></i> Key Insights <span class="hdr-sub">Tap Apply to load</span></div>
      <div class="insights-cells">
        <div class="insight-cell"><div class="insight-icon-wrap" style="background:#fef9c3;color:#b45309"><i class="fas fa-trophy"></i></div><div><div class="insight-lbl">Best Day</div><div class="insight-val">—</div></div></div>
        <div class="insight-cell"><div class="insight-icon-wrap" style="background:#dbeafe;color:#1d4ed8"><i class="fas fa-bed"></i></div><div><div class="insight-lbl">Top Room</div><div class="insight-val">—</div></div></div>
        <div class="insight-cell"><div class="insight-icon-wrap" style="background:#dcfce7;color:#166534"><i class="fas fa-exchange-alt"></i></div><div><div class="insight-lbl">Cash vs UPI</div><div class="insight-val">—</div></div></div>
        <div class="insight-cell"><div class="insight-icon-wrap" style="background:#fef2f2;color:#dc2626"><i class="fas fa-arrow-up"></i></div><div><div class="insight-lbl">Top Expense</div><div class="insight-val">—</div></div></div>
        <div class="insight-cell"><div class="insight-icon-wrap" style="background:#f3e8ff;color:#7c3aed"><i class="fas fa-fire"></i></div><div><div class="insight-lbl">Busiest Day</div><div class="insight-val">—</div></div></div>
        <div class="insight-cell"><div class="insight-icon-wrap" style="background:#e0f2fe;color:#0369a1"><i class="fas fa-percentage"></i></div><div><div class="insight-lbl">Expense Ratio</div><div class="insight-val">—</div></div></div>
      </div>
    </div>

    <!-- SECTION: Money (collected cash & UPI, expenses — never bills) -->
    ${section("fas fa-indian-rupee-sign", "Money", "collected cash &amp; UPI · expenses")}
    <div class="chart-row chart-row-2">
      ${chartCard("revenue-expense-chart","#4361ee","fas fa-chart-area","Collected vs Expenses", 280)}
      ${chartCard("daily-revenue-chart","#27ae60","fas fa-chart-bar","Daily Collected — Cash vs UPI", 280)}
    </div>
    <div class="chart-row chart-row-2">
      ${chartCard("payment-methods-chart","#0891b2","fas fa-wallet","Payment Split", 280)}
      ${chartCard("top-rooms-chart","#4361ee","fas fa-bed","Top Rooms by Collection", 280)}
    </div>
    <!-- Expense filter scopes both expense charts. Daily = drawer expenses;
         Report = off-deposit; All = both. -->
    <div style="display:flex; justify-content:flex-end; align-items:center;
                gap:0.5rem; margin: 0.5rem 0 0.4rem; padding: 0 0.2rem;
                font-size:0.82rem; color:#444;">
      <i class="fas fa-filter" style="font-size:0.75rem; color:#888;"></i>
      <label for="analytics-expense-filter" style="font-weight:600;">Expense type:</label>
      <select id="analytics-expense-filter"
              style="padding:0.25rem 0.5rem; border:1px solid #d8d8d8;
                     border-radius:6px; font-size:0.82rem; height:30px; background:#fff;">
        <option value="all">All</option>
        <option value="transaction" selected>Daily only</option>
        <option value="report">Report only</option>
      </select>
    </div>
    <div class="chart-row chart-row-2">
      ${chartCard("expense-categories-chart","#e63946","fas fa-tags","Expense Breakdown by Category", 280)}
      ${chartCard("expense-trend-chart","#ef4444","fas fa-receipt","Daily Expense Trend", 280)}
    </div>

    <!-- Everything below is register basis (/analytics/overview); hidden until it loads -->
    <div id="biz-analytics" style="display:none">
      ${section("fas fa-bed", "Occupancy &amp; footfall", "register basis — actual stays")}
      <div class="chart-row chart-row-2">
        ${chartCard("weekday-demand-chart","#2563eb","fas fa-calendar-week","Occupancy by Day of Week", 280)}
        ${chartCard("seasonality-chart","#7c3aed","fas fa-chart-line","12-Month Trend — Occupancy & RevPAR", 280)}
      </div>
      <div class="chart-row chart-row-2">
        <div class="chart-card" style="height:auto;min-height:220px">
          <div class="chart-hdr"><i class="chart-hdr-icon fas fa-calendar-plus" style="color:#0369a1"></i>
            <span class="chart-hdr-title">On the Books — Forward Occupancy</span></div>
          <div class="chart-body" id="forward-pace-body" style="padding:0.6rem 1rem"></div>
        </div>
        ${chartCard("los-chart","#f59e0b","fas fa-moon","Length of Stay", 260)}
      </div>

      ${section("fas fa-layer-group", "Revenue mix", "room charges by category · channels · add-ons")}
      <div class="chart-row chart-row-2">
        ${chartCard("room-type-revenue-chart","#8b5cf6","fas fa-th-large","Room Revenue by Category", 280)}
        ${chartCard("channel-mix-chart","#0891b2","fas fa-share-nodes","Channel Mix — Net Revenue & ADR", 280)}
      </div>
      <div class="chart-row chart-row-2">
        ${chartCard("top-services-chart","#f59e0b","fas fa-concierge-bell","Top Add-on Services", 280)}
        ${chartCard("guest-mix-chart","#16a34a","fas fa-user-check","New vs Returning Guests", 280)}
      </div>

      ${section("fas fa-user-group", "Guests", "top spenders · cancellations")}
      <div class="chart-row chart-row-2">
        <div class="chart-card" style="height:auto;min-height:220px">
          <div class="chart-hdr"><i class="chart-hdr-icon fas fa-crown" style="color:#b45309"></i>
            <span class="chart-hdr-title">Top Guests by Revenue</span></div>
          <div class="chart-body" id="top-guests-body" style="padding:0.4rem 0.6rem"></div>
        </div>
        <div class="chart-card" style="height:auto;min-height:220px">
          <div class="chart-hdr"><i class="chart-hdr-icon fas fa-ban" style="color:#dc2626"></i>
            <span class="chart-hdr-title">Cancellations</span></div>
          <div class="chart-body" id="cancellations-body" style="padding:0.6rem 1rem"></div>
        </div>
      </div>
    </div>

    <!-- SECTION: Where guests come from (ID-document origin, all-time) -->
    ${section("fas fa-map-location-dot", "Where guests come from", "guest home PIN codes · all-time")}
    <div class="chart-card" style="height:440px">
      <div class="chart-hdr">
        <i class="chart-hdr-icon fas fa-map-marked-alt" style="color:#0ea5e9"></i>
        <span class="chart-hdr-title">Guest Origin Map</span>
      </div>
      <div class="chart-body" style="position:relative;padding:0">
        <div id="pincode-heatmap" style="position:absolute;inset:0;border-radius:8px;overflow:hidden"></div>
      </div>
    </div>
    <div class="chart-row chart-row-2">
      ${chartCard("pincode-footfall-chart","#0ea5e9","fas fa-map-marker-alt","Footfall by Area (PIN code)", 320)}
      ${chartCard("guest-age-chart","#16a34a","fas fa-users","Guest Age Distribution", 320)}
    </div>

    </div>
  `;
}

// Helper function to format date to DD-MM-YYYY HH:MM - MOVED TO GLOBAL SCOPE FOR EXCEL EXPORT
function formatDateTime(dateStr, timeStr) {
  if (!dateStr) return "N/A";

  try {
    const [year, month, day] = dateStr.split("-");
    const formattedDate = `${day}-${month}-${year}`;

    if (timeStr) {
      return `${formattedDate} ${timeStr}`;
    } else {
      return formattedDate;
    }
  } catch (e) {
    return dateStr;
  }
}

// Updated report generation to support both analytics and detailed reports
async function generateEnhancedReport() {
  const startDate = document.getElementById("report-start-date")?.value;
  const endDate = document.getElementById("report-end-date")?.value;

  if (!startDate || !endDate) {
    showNotification("Please select both start and end dates", "error");
    return;
  }

  if (new Date(startDate) > new Date(endDate)) {
    showNotification("Start date must be before end date", "error");
    return;
  }

  // Show loading indicators
  const analyticsView = document.getElementById("analytics-view");
  const reportsView = document.getElementById("reports-view");
  const reportContent = document.getElementById("report-content");

  if (analyticsView) {
    analyticsView.innerHTML = `
      <div class="loading-indicator" style="padding: 3rem;">
        <span class="loader"></span>
        <p>Generating analytics...</p>
      </div>
    `;
  }

  if (reportContent) {
    const loadingIndicator = reportContent.querySelector(".loading-indicator");
    const emptyState = reportContent.querySelector(".empty-state");

    if (emptyState) emptyState.classList.add("hidden");
    if (loadingIndicator) loadingIndicator.classList.remove("hidden");
  }

  try {
    const response = await apiFetch("/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        start_date: startDate,
        end_date: endDate,
      }),
    });

    if (!response.ok) {
      throw new Error(`Server responded with status: ${response.status}`);
    }

    const data = await response.json();

    if (data.success) {
      // Store the data globally for Excel export
      window.reportData = data;

      // Update date range in the report summary
      updateReportDateRange(startDate, endDate);

      // Update the report summary values
      updateReportSummary(data);

      // Generate charts for analytics view
      initializeAnalyticsView(); // Reset charts first
      generateAnalytics(data);

      // Render detailed reports for reports view
      renderCompactReportData(data);
    } else {
      showNotification(data.message || "Error generating report", "error");
    }
  } catch (error) {
    console.error("Error fetching report:", error);
    showNotification(`Error generating report: ${error.message}`, "error");

    // Restore views on error
    if (analyticsView) {
      initializeAnalyticsView();
    }

    if (reportContent) {
      const loadingIndicator =
        reportContent.querySelector(".loading-indicator");
      const emptyState = reportContent.querySelector(".empty-state");

      if (loadingIndicator) loadingIndicator.classList.add("hidden");
      if (emptyState) {
        emptyState.classList.remove("hidden");
        emptyState.innerHTML = `
          <i class="fas fa-exclamation-circle fa-3x"></i>
          <p>Error generating report. Please try again.</p>
        `;
      }
    }
  }
}

// Track the generated range for the meta line + CSV filename
let _rptRange = { start: null, end: null };

// Store the generated range (meta line is rendered by updateReportSummary)
function updateReportDateRange(startDate, endDate) {
  _rptRange.start = startDate;
  _rptRange.end = endDate;
}

// Update the summary stat cards + meta line for the revamped Reports view
function updateReportSummary(data) {
  const fmtR = (n) => "\u20b9" + Math.round(Math.abs(n || 0)).toLocaleString("en-IN");
  const setTxt = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };

  const cash = data.cash_total || 0;
  const online = data.online_total || 0;
  const refunds = data.refund_total || 0;
  const expenses = data.expense_total || 0;
  // Net = money in − money out. Refunds are cash handed back, so they
  // subtract too (the old view ignored them in Net; that was misleading).
  const net = cash + online - refunds - expenses;

  setTxt("report-cash-total", fmtR(cash));
  setTxt("report-online-total", fmtR(online));
  setTxt("report-refund-total", fmtR(refunds));
  setTxt("report-expense-total", fmtR(expenses));
  setTxt("report-net-revenue", (net < 0 ? "\u2212" : "") + fmtR(net));

  setTxt("rpt-sub-cash", (data.cash_logs || []).length + " entries");
  setTxt("rpt-sub-online", (data.online_logs || []).length + " entries");
  setTxt("rpt-sub-ref", (data.refund_logs || []).length + " entries");
  setTxt(
    "rpt-sub-exp",
    "Daily " + fmtR(data.transaction_expense_total || 0) +
      " \u00b7 Report " + fmtR(data.report_expense_total || 0)
  );

  // Meta line: date range · check-ins · renewals · add-ons note
  const meta = document.getElementById("rpt-meta");
  if (meta) {
    const fmtD = (ds) => {
      try {
        return new Date(ds + "T00:00:00").toLocaleDateString("en-IN", {
          day: "numeric", month: "short", year: "numeric",
        });
      } catch (e) { return ds; }
    };
    const bits = [];
    if (_rptRange.start && _rptRange.end) {
      bits.push(
        '<span><i class="far fa-calendar-alt"></i>' +
        (_rptRange.start === _rptRange.end
          ? fmtD(_rptRange.start)
          : fmtD(_rptRange.start) + " \u2192 " + fmtD(_rptRange.end)) +
        "</span>"
      );
    }
    bits.push('<span><i class="fas fa-door-open"></i>' + (data.checkins || 0) + " check-ins</span>");
    bits.push('<span><i class="fas fa-sync-alt"></i>' + (data.renewals || 0) + " renewals</span>");
    if (data.addon_total) {
      bits.push(
        '<span><i class="fas fa-concierge-bell"></i>Add-ons ' + fmtR(data.addon_total) +
        " (included in Cash/Online)</span>"
      );
    }
    meta.innerHTML = bits.join("");
  }
}

// Excel Export Function - FIXED: Removed duplicate formatDateTime function
function exportToExcel() {
  if (!window.reportData) {
    showNotification("No report data available for export", "error");
    return;
  }

  // Check if XLSX is available
  if (typeof XLSX === "undefined") {
    showNotification(
      "Excel export library not loaded. Please refresh the page and try again.",
      "error"
    );
    return;
  }

  try {
    const data = window.reportData;
    const startDate = document.getElementById("report-start-date")?.value || "N/A";
    const endDate = document.getElementById("report-end-date")?.value || "N/A";

    // Create a new workbook
    const workbook = XLSX.utils.book_new();

    // Summary Sheet
    const summaryData = [
      ["LODGE MANAGEMENT REPORT"],
      [`Report Period: ${startDate} to ${endDate}`],
      [""],
      ["REVENUE SUMMARY"],
      ["Cash Payments", data.cash_total || 0],
      ["Online Payments", data.online_total || 0],
      ["Total Income", (data.cash_total || 0) + (data.online_total || 0)],
      [""],
      ["EXPENSE SUMMARY"],
      ["Total Expenses", data.expense_total || 0],
      [""],
      ["NET SUMMARY"],
      [
        "Net Revenue",
        (data.cash_total || 0) +
          (data.online_total || 0) -
          (data.expense_total || 0),
      ],
      ["Total Refunds", data.refund_total || 0],
      ["Check-ins", data.checkins || 0],
      ["Renewals", data.renewals || 0],
    ];

    const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
    XLSX.utils.book_append_sheet(workbook, summarySheet, "Summary");

    // Cash Payments Sheet
    if (data.cash_logs && data.cash_logs.length > 0) {
      const cashData = [
        ["Room", "Guest Name", "Amount", "Date", "Time", "Item"],
      ];
      data.cash_logs.forEach((log) => {
        cashData.push([
          log.room || "N/A",
          log.name || "N/A",
          log.amount || 0,
          formatDateTime(log.date, null),
          log.time || "N/A",
          log.item || "",
        ]);
      });
      const cashSheet = XLSX.utils.aoa_to_sheet(cashData);
      XLSX.utils.book_append_sheet(workbook, cashSheet, "Cash Payments");
    }

    // Online Payments Sheet
    if (data.online_logs && data.online_logs.length > 0) {
      const onlineData = [
        ["Room", "Guest Name", "Amount", "Date", "Time", "Item"],
      ];
      data.online_logs.forEach((log) => {
        onlineData.push([
          log.room || "N/A",
          log.name || "N/A",
          log.amount || 0,
          formatDateTime(log.date, null),
          log.time || "N/A",
          log.item || "",
        ]);
      });
      const onlineSheet = XLSX.utils.aoa_to_sheet(onlineData);
      XLSX.utils.book_append_sheet(workbook, onlineSheet, "Online Payments");
    }

    // Expenses Sheet - SORTED BY FORM TIME (OLDEST FIRST, LATEST LAST)
    if (data.expense_logs && data.expense_logs.length > 0) {
      // Sort expenses by date and time from the form - OLDEST FIRST
      const sortedExpenses = [...data.expense_logs].sort((a, b) => {
        const dateTimeA = new Date(`${a.date} ${a.time || "00:00"}`);
        const dateTimeB = new Date(`${b.date} ${b.time || "00:00"}`);
        return dateTimeA - dateTimeB; // Oldest first, latest last
      });

      const expenseData = [
        [
          "Date",
          "Time",
          "Category",
          "Description",
          "Amount",
          "Payment Method",
          "Type",
        ],
      ];
      sortedExpenses.forEach((log) => {
        expenseData.push([
          formatDateTime(log.date, null),
          log.time || "N/A",
          (log.category || "other").charAt(0).toUpperCase() +
            (log.category || "other").slice(1),
          log.name || log.description || "N/A",
          log.amount || 0,
          (log.payment_method || "cash").toUpperCase(),
          (log.expense_type || "transaction").charAt(0).toUpperCase() +
            (log.expense_type || "transaction").slice(1),
        ]);
      });
      const expenseSheet = XLSX.utils.aoa_to_sheet(expenseData);
      XLSX.utils.book_append_sheet(workbook, expenseSheet, "Expenses");
    }

    // Refunds Sheet
    if (data.refund_logs && data.refund_logs.length > 0) {
      const refundData = [
        [
          "Room",
          "Guest Name",
          "Amount",
          "Date",
          "Time",
          "Payment Mode",
          "Note",
        ],
      ];
      data.refund_logs.forEach((log) => {
        refundData.push([
          log.room || "N/A",
          log.name || "N/A",
          log.amount || 0,
          log.date || "N/A",
          log.time || "N/A",
          log.payment_mode || "cash",
          log.note || "",
        ]);
      });
      const refundSheet = XLSX.utils.aoa_to_sheet(refundData);
      XLSX.utils.book_append_sheet(workbook, refundSheet, "Refunds");
    }

    // Generate filename with current date
    const now = new Date();
    const filename = `Lodge_Report_${startDate}_to_${endDate}_${now.getFullYear()}-${String(
      now.getMonth() + 1
    ).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}.xlsx`;

    // Save the file
    XLSX.writeFile(workbook, filename);

    showNotification("Excel report exported successfully!", "success");
  } catch (error) {
    console.error("Error exporting to Excel:", error);
    showNotification("Error exporting to Excel: " + error.message, "error");
  }
}

// Store raw report data globally for client-side filtering
window.rawReportData = null;

// ═══════════════════════════════════════════════════════════════════════════
// REPORTS VIEW — unified transaction-style report
//
// Renders cash / online / expense / refund rows in ONE chronological list
// styled like the Transactions tab (same row tints, pills and badges —
// .transaction-tag styles are injected globally by transaction-tracking.js).
// All filtering / sorting / grouping is client-side over window.rawReportData;
// expense rows carry admin-only inline Edit / Delete wired to
// PATCH|DELETE /expense/<doc_id> — the same endpoints the Transactions tab
// uses. The Analytics view is untouched.
// ═══════════════════════════════════════════════════════════════════════════

// Filter/sort state. Preserved across re-renders and background refreshes
// (e.g. after a delete) so the operator doesn't lose their place; the
// Reset button clears everything back to defaults.
const _rptState = {
  type: "all",      // all | cash | online | expenses | refunds
  search: "",
  sort: "newest",   // newest | oldest | highest | lowest
  cat: "all",       // expense category
  scope: "all",     // all | transaction (Daily) | report (From-account)
  gstOnly: false,
  min: null,        // amount range — applies to every row type
  max: null,
};

const _RPT_KIND2TYPE = { cash: "cash", online: "online", expense: "expenses", refund: "refunds" };

const _RPT_CAT_CLASS = {
  salary: "cat-badge-salary", utilities: "cat-badge-utilities",
  maintenance: "cat-badge-maintenance", supplies: "cat-badge-supplies",
  booking_commission: "cat-badge-commission",
};

function _rptEsc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function _rptFmt(n) { return Math.round(Math.abs(n || 0)).toLocaleString("en-IN"); }
function _rptCap(s) {
  s = String(s || "other");
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
}

// Same GST rule as the Transactions tab / GST export (_carries_gst server-side)
function _rptCarriesGst(log) {
  if (!log) return false;
  if (log.has_gst === true) return true;
  const g = parseFloat(log.gst_amount || 0) || 0;
  const c = parseFloat(log.commission_gst || 0) || 0;
  return g > 0 || c > 0;
}

// Sortable timestamp from the row's date + time strings. ISO "T" form so
// Safari parses it too; falls back to date-only, then 0.
function _rptTs(log) {
  const d = log.date || "2000-01-01";
  let t = String(log.time || "00:00").slice(0, 8);
  if (t.length === 5) t += ":00";
  let ts = new Date(d + "T" + t).getTime();
  if (isNaN(ts)) ts = new Date(d + "T00:00:00").getTime();
  return isNaN(ts) ? 0 : ts;
}

// Flatten the /reports payload into one unified row list.
// addon_logs are NOT added separately — add-on payments already appear
// inside cash_logs / online_logs (they'd double-count otherwise).
function _rptBuildRows(data) {
  const rows = [];
  const push = (log, kind) =>
    rows.push({ log: log, kind: kind, ts: _rptTs(log), amount: Number(log.amount) || 0 });
  (data.cash_logs || []).forEach((l) => push(l, "cash"));
  (data.online_logs || []).forEach((l) => push(l, "online"));
  (data.expense_logs || []).forEach((l) => push(l, "expense"));
  (data.refund_logs || []).forEach((l) => push(l, "refund"));
  return rows;
}

// Does a row pass the current filters? skipType=true ignores the type chip
// (used to compute per-chip counts).
function _rptMatches(row, skipType) {
  const s = _rptState;
  if (!skipType && s.type !== "all" && _RPT_KIND2TYPE[row.kind] !== s.type) return false;
  if (s.min != null && row.amount < s.min) return false;
  if (s.max != null && row.amount > s.max) return false;

  const log = row.log;
  if (row.kind === "expense") {
    if (s.cat !== "all" && (log.category || "other") !== s.cat) return false;
    const et = (log.expense_type || "transaction").toLowerCase();
    if (s.scope !== "all" && et !== s.scope) return false;
    if (s.gstOnly && !_rptCarriesGst(log)) return false;
  }
  if (s.search) {
    const fields = row.kind === "expense"
      ? [log.description, log.name, log.category, log.paid_to, log.vendor_name, log.invoice_number]
      : [log.room, log.name, log.item, log.note];
    if (!fields.some((f) => String(f || "").toLowerCase().includes(s.search))) return false;
  }
  return true;
}

function _rptSortRows(rows) {
  const s = _rptState.sort;
  rows.sort(function (a, b) {
    if (s === "highest") return b.amount - a.amount || b.ts - a.ts;
    if (s === "lowest") return a.amount - b.amount || a.ts - b.ts;
    return s === "oldest" ? a.ts - b.ts : b.ts - a.ts;
  });
  return rows;
}

// "Added by / Collected by" chip — same resolution as the Transactions tab.
function _rptByChip(log) {
  let name = "";
  if (log.createdBy && window.CibaraUsers && typeof window.CibaraUsers.nameOf === "function") {
    name = window.CibaraUsers.nameOf(log.createdBy) || "";
  } else if (log.created_by && log.created_by.name && log.created_by.name !== "system") {
    name = log.created_by.name;
  }
  if (!name) return "";
  return ' <span class="txn-added-by"><i class="fas fa-user"></i> ' + _rptEsc(name) + "</span>";
}

function _rptCanManageExpense() {
  return !!(window.CibaraAuth &&
    typeof window.CibaraAuth.userCan === "function" &&
    window.CibaraAuth.userCan("expense.manage"));
}

// DD-MM-YYYY for subtitles (flat sort modes where there's no day header)
function _rptDMY(dateStr) {
  if (!dateStr) return "—";
  const p = String(dateStr).split("-");
  return p.length === 3 ? p[2] + "-" + p[1] + "-" + p[0] : dateStr;
}

function _rptDayLabel(dateStr) {
  try {
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  } catch (e) { return dateStr; }
}

// One unified row. showDate=true adds the date to the subtitle (flat modes).
function _rptRowHtml(row, showDate) {
  const log = row.log;
  const amt = _rptFmt(row.amount);
  const when = (showDate ? _rptDMY(log.date) + " · " : "") + (log.time || "—");
  const by = _rptByChip(log);

  if (row.kind === "cash" || row.kind === "online") {
    const pill = row.kind === "cash"
      ? '<span class="transaction-tag cash-tag">Cash</span>'
      : '<span class="transaction-tag online-tag">Online</span>';
    const addon = log.item
      ? ' <span class="rpt-badge rpt-badge-addon">Add-on: ' + _rptEsc(log.item) + "</span>"
      : "";
    const renewal = log.type === "renewal"
      ? ' <span class="transaction-tag continue-tag">Renewal</span>' : "";
    return (
      '<div class="rpt-row rpt-row-' + row.kind + '">' +
        '<div class="log-details">' +
          '<div class="log-title">Room ' + _rptEsc(log.room || "—") + " — " + _rptEsc(log.name || "N/A") + addon + "</div>" +
          '<div class="log-subtitle">' + pill + renewal + " " + _rptEsc(when) + by + "</div>" +
        "</div>" +
        '<div class="log-amount rpt-amt-in">+₹' + amt + "</div>" +
      "</div>"
    );
  }

  if (row.kind === "refund") {
    return (
      '<div class="rpt-row rpt-row-refund">' +
        '<div class="log-details">' +
          '<div class="log-title">Room ' + _rptEsc(log.room || "—") + " — " + _rptEsc(log.name || "N/A") + "</div>" +
          '<div class="log-subtitle"><span class="transaction-tag refund-tag">Refund</span> ' +
            _rptEsc((log.payment_mode || "cash").toUpperCase()) + " · " + _rptEsc(when) +
            (log.note ? " · " + _rptEsc(log.note) : "") + by +
          "</div>" +
        "</div>" +
        '<div class="log-amount rpt-amt-out">−₹' + amt + "</div>" +
      "</div>"
    );
  }

  // ── Expense row ──────────────────────────────────────────────────────────
  const cat = log.category || "other";
  const catCls = _RPT_CAT_CLASS[cat] || "cat-badge-other";
  const scope = (log.expense_type || "transaction") === "report"
    ? '<span class="rpt-badge rpt-badge-report">Report</span>'
    : '<span class="rpt-badge rpt-badge-daily">Daily</span>';
  const gst = _rptCarriesGst(log)
    ? '<span class="rpt-badge rpt-badge-gst">GST' +
      (log.gst_amount ? " ₹" + _rptFmt(log.gst_amount) : "") + "</span>"
    : "";
  const split = log.split_group_id
    ? '<span class="rpt-badge rpt-badge-split" title="Split-payment expense — legs share one invoice">Split</span>'
    : "";
  const invoice = log.invoice_photo_url
    ? ' <a href="' + _rptEsc(log.invoice_photo_url) + '" target="_blank" rel="noopener" title="View invoice"' +
      ' style="color:#3182ce;font-size:0.78rem;text-decoration:none;"><i class="fas fa-file-image"></i></a>'
    : "";
  const pill = (log.payment_method || "cash").toLowerCase() === "online"
    ? '<span class="transaction-tag online-tag">Online</span>'
    : '<span class="transaction-tag cash-tag">Cash</span>';
  const who = log.vendor_name || log.paid_to || "";

  let actions = "";
  if (_rptCanManageExpense() && log._doc_id) {
    actions =
      '<div class="rpt-row-actions">' +
        '<button type="button" class="rpt-exp-edit-btn" data-doc-id="' + _rptEsc(log._doc_id) + '" title="Edit expense">' +
          '<i class="fas fa-pen"></i></button>' +
        '<button type="button" class="rpt-exp-del-btn" data-doc-id="' + _rptEsc(log._doc_id) + '"' +
          ' data-amount="' + _rptEsc(log.amount || 0) + '"' +
          ' data-description="' + _rptEsc(log.description || log.name || "") + '"' +
          ' title="Delete expense"><i class="fas fa-trash"></i></button>' +
      "</div>";
  }

  return (
    '<div class="rpt-row rpt-row-expense">' +
      '<div class="log-details">' +
        '<div class="log-title"><strong>' + _rptEsc(log.description || log.name || "N/A") + "</strong> " +
          '<span class="expense-category-badge ' + catCls + '">' + _rptEsc(_rptCap(cat)) + "</span> " +
          scope + " " + gst + " " + split + invoice +
        "</div>" +
        '<div class="log-subtitle">' + pill + " " + _rptEsc(when) +
          (who ? " · " + _rptEsc(who) : "") + by +
        "</div>" +
      "</div>" +
      '<div class="log-amount rpt-amt-out">−₹' + amt + "</div>" +
      actions +
    "</div>"
  );
}

// Human-readable description of the active filters (for the result bar)
function _rptFilterDesc() {
  const s = _rptState;
  const parts = [];
  if (s.search) parts.push('"' + s.search + '"');
  if (s.type !== "all") parts.push(s.type);
  if (s.cat !== "all") parts.push(_rptCap(s.cat));
  if (s.scope !== "all") parts.push(s.scope === "transaction" ? "Daily" : "Report");
  if (s.gstOnly) parts.push("GST only");
  if (s.min != null || s.max != null) {
    parts.push("₹" + (s.min != null ? _rptFmt(s.min) : "0") + "–" + (s.max != null ? _rptFmt(s.max) : "∞"));
  }
  return parts.join(", ");
}

function _rptIsFiltered() {
  const s = _rptState;
  return !!(s.search || s.type !== "all" || s.cat !== "all" || s.scope !== "all" ||
    s.gstOnly || s.min != null || s.max != null);
}

// ── Main render — filters, counts, grouping, list ───────────────────────────
function applyReportFilters() {
  const data = window.rawReportData;
  const content = document.getElementById("report-content");
  if (!data || !content) return;

  const s = _rptState;
  const eligible = _rptBuildRows(data).filter(function (r) { return _rptMatches(r, true); });

  // Per-chip counts (all filters applied EXCEPT the type chip itself)
  const counts = { all: eligible.length, cash: 0, online: 0, expenses: 0, refunds: 0 };
  eligible.forEach(function (r) { counts[_RPT_KIND2TYPE[r.kind]]++; });
  ["all", "cash", "online", "expenses", "refunds"].forEach(function (t) {
    const el = document.getElementById("rpt-n-" + t);
    if (el) el.textContent = counts[t];
  });

  // Chip + summary-card active states
  document.querySelectorAll("#rpt-type-chips .rpt-chip").forEach(function (c) {
    c.classList.toggle("active", c.dataset.type === s.type);
  });
  document.querySelectorAll("#rpt-summary .rpt-stat[data-type]").forEach(function (c) {
    c.classList.toggle("active", c.dataset.type === s.type);
  });

  // Advanced-filter affordances: expense-only controls make no sense while
  // a non-expense chip is active (they'd filter nothing visible).
  const expControlsOff = s.type !== "all" && s.type !== "expenses";
  ["expense-category-filter", "expense-type-filter"].forEach(function (id) {
    const el = document.getElementById(id);
    if (el) el.disabled = expControlsOff;
  });
  const gstWrap = document.querySelector(".rpt-gst-toggle");
  if (gstWrap) gstWrap.classList.toggle("rpt-disabled", expControlsOff);
  const dot = document.getElementById("rpt-filter-dot");
  if (dot) dot.hidden = !(s.cat !== "all" || s.scope !== "all" || s.gstOnly || s.min != null || s.max != null);

  // Rows for the list = eligible + type chip
  const rows = s.type === "all"
    ? eligible.slice()
    : eligible.filter(function (r) { return _RPT_KIND2TYPE[r.kind] === s.type; });
  _rptSortRows(rows);

  // In / out totals for the current view
  let inSum = 0, outSum = 0;
  rows.forEach(function (r) {
    if (r.kind === "cash" || r.kind === "online") inSum += r.amount;
    else outSum += r.amount;
  });

  // Result bar
  const bar = document.getElementById("rpt-result-bar");
  if (bar) {
    const desc = _rptFilterDesc();
    bar.classList.remove("hidden");
    bar.innerHTML =
      "<span><strong>" + rows.length + "</strong> transaction" + (rows.length !== 1 ? "s" : "") +
      (desc ? " for <em>" + _rptEsc(desc) + "</em>" : "") + "</span>" +
      '<span class="rpt-in">In +₹' + _rptFmt(inSum) + "</span>" +
      '<span class="rpt-out">Out −₹' + _rptFmt(outSum) + "</span>" +
      '<span>Net ' + (inSum - outSum < 0 ? "−" : "") + "₹" + _rptFmt(inSum - outSum) + "</span>" +
      (_rptIsFiltered()
        ? '<button type="button" class="rpt-clear-link" id="rpt-result-clear">Clear filters</button>'
        : "");
  }

  // Empty state
  if (!rows.length) {
    content.innerHTML =
      '<div class="rpt-list"><div class="rpt-empty"><i class="fas fa-inbox"></i>' +
      "<p>" + (_rptIsFiltered() ? "No transactions match your filters" : "No transactions in this period") + "</p>" +
      (_rptIsFiltered() ? "<small>Try widening the search or resetting filters.</small>" : "") +
      "</div></div>";
    return;
  }

  // Build list — grouped by day for date sorts, flat for amount sorts
  const grouped = s.sort === "newest" || s.sort === "oldest";
  let html = '<div class="rpt-list">';
  if (grouped) {
    // Per-day in/out subtotals
    const dayTotals = {};
    rows.forEach(function (r) {
      const d = r.log.date || "—";
      if (!dayTotals[d]) dayTotals[d] = { in: 0, out: 0 };
      if (r.kind === "cash" || r.kind === "online") dayTotals[d].in += r.amount;
      else dayTotals[d].out += r.amount;
    });
    let curDay = null;
    rows.forEach(function (r) {
      const d = r.log.date || "—";
      if (d !== curDay) {
        curDay = d;
        const t = dayTotals[d];
        html +=
          '<div class="rpt-day-hdr"><i class="far fa-calendar"></i> ' + _rptEsc(_rptDayLabel(d)) +
          '<span class="rpt-day-totals">' +
            (t.in ? '<span class="rpt-in">+₹' + _rptFmt(t.in) + "</span>" : "") +
            (t.out ? '<span class="rpt-out">−₹' + _rptFmt(t.out) + "</span>" : "") +
          "</span></div>";
      }
      html += _rptRowHtml(r, false);
    });
  } else {
    rows.forEach(function (r) { html += _rptRowHtml(r, true); });
  }
  html += "</div>";
  content.innerHTML = html;
}

// ── Entry point after /reports returns ──────────────────────────────────────
function renderCompactReportData(data) {
  const content = document.getElementById("report-content");
  if (!content) return;

  window.rawReportData = data;

  const loadingEl = content.querySelector(".loading-indicator");
  if (loadingEl) loadingEl.classList.add("hidden");
  const emptyEl = content.querySelector(".empty-state");
  if (emptyEl) emptyEl.remove();

  // Populate the expense-category dropdown from actual data, preserving the
  // current selection when that category still exists in the new range.
  const catSelect = document.getElementById("expense-category-filter");
  if (catSelect) {
    const cats = Array.from(new Set((data.expense_logs || []).map(function (l) { return l.category || "other"; }))).sort();
    catSelect.innerHTML = '<option value="all">All categories</option>' +
      cats.map(function (c) { return '<option value="' + _rptEsc(c) + '">' + _rptEsc(_rptCap(c)) + "</option>"; }).join("");
    if (cats.indexOf(_rptState.cat) !== -1) catSelect.value = _rptState.cat;
    else { _rptState.cat = "all"; catSelect.value = "all"; }
  }

  _rptWireControls();
  applyReportFilters();
}

// ── Reset all filters to defaults ───────────────────────────────────────────
function _rptResetFilters() {
  _rptState.type = "all"; _rptState.search = ""; _rptState.sort = "newest";
  _rptState.cat = "all"; _rptState.scope = "all"; _rptState.gstOnly = false;
  _rptState.min = null; _rptState.max = null;
  const set = function (id, val) { const el = document.getElementById(id); if (el) el.value = val; };
  set("report-search", ""); set("report-sort", "newest");
  set("expense-category-filter", "all"); set("expense-type-filter", "all");
  set("rpt-min-amt", ""); set("rpt-max-amt", "");
  const gst = document.getElementById("rpt-gst-only"); if (gst) gst.checked = false;
  const clr = document.getElementById("rpt-search-clear"); if (clr) clr.hidden = true;
  applyReportFilters();
}

// ── One-time control wiring (idempotent) ────────────────────────────────────
let _rptWired = false;
function _rptWireControls() {
  if (_rptWired) return;
  _rptWired = true;

  // Type chips + summary stat cards (stat cards toggle back to All)
  document.addEventListener("click", function (e) {
    const chip = e.target.closest("#rpt-type-chips .rpt-chip");
    if (chip) { _rptState.type = chip.dataset.type; applyReportFilters(); return; }
    const stat = e.target.closest("#rpt-summary .rpt-stat[data-type]");
    if (stat && window.rawReportData) {
      _rptState.type = _rptState.type === stat.dataset.type ? "all" : stat.dataset.type;
      applyReportFilters();
    }
  });

  // Search (debounced) + clear button
  const search = document.getElementById("report-search");
  const searchClear = document.getElementById("rpt-search-clear");
  if (search) {
    let timer = null;
    search.addEventListener("input", function () {
      if (searchClear) searchClear.hidden = !search.value;
      clearTimeout(timer);
      timer = setTimeout(function () {
        _rptState.search = search.value.toLowerCase().trim();
        applyReportFilters();
      }, 180);
    });
  }
  if (searchClear) {
    searchClear.addEventListener("click", function () {
      if (search) search.value = "";
      searchClear.hidden = true;
      _rptState.search = "";
      applyReportFilters();
    });
  }

  // Sort
  const sort = document.getElementById("report-sort");
  if (sort) {
    sort.value = _rptState.sort;
    sort.addEventListener("change", function () { _rptState.sort = sort.value; applyReportFilters(); });
  }

  // Advanced filters toggle
  const moreBtn = document.getElementById("rpt-more-filters-btn");
  const adv = document.getElementById("rpt-adv");
  if (moreBtn && adv) {
    moreBtn.addEventListener("click", function () { adv.hidden = !adv.hidden; });
  }

  // Advanced filter inputs
  const cat = document.getElementById("expense-category-filter");
  if (cat) cat.addEventListener("change", function () { _rptState.cat = cat.value; applyReportFilters(); });
  const scope = document.getElementById("expense-type-filter");
  if (scope) scope.addEventListener("change", function () { _rptState.scope = scope.value; applyReportFilters(); });
  const gst = document.getElementById("rpt-gst-only");
  if (gst) gst.addEventListener("change", function () { _rptState.gstOnly = gst.checked; applyReportFilters(); });
  const minA = document.getElementById("rpt-min-amt");
  const maxA = document.getElementById("rpt-max-amt");
  const amtChanged = function () {
    const mn = parseFloat(minA && minA.value);
    const mx = parseFloat(maxA && maxA.value);
    _rptState.min = isNaN(mn) ? null : mn;
    _rptState.max = isNaN(mx) ? null : mx;
    applyReportFilters();
  };
  if (minA) minA.addEventListener("input", amtChanged);
  if (maxA) maxA.addEventListener("input", amtChanged);

  // Reset buttons (toolbar + result-bar link, the latter is re-rendered so delegate)
  const clearBtn = document.getElementById("rpt-clear-filters");
  if (clearBtn) clearBtn.addEventListener("click", _rptResetFilters);
  document.addEventListener("click", function (e) {
    if (e.target.closest("#rpt-result-clear")) _rptResetFilters();
  });

  // Export menu
  const expBtn = document.getElementById("rpt-export-btn");
  const expMenu = document.getElementById("rpt-export-menu");
  if (expBtn && expMenu) {
    expBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      expMenu.hidden = !expMenu.hidden;
    });
    document.addEventListener("click", function (e) {
      if (!expMenu.hidden && !e.target.closest(".rpt-export-wrap")) expMenu.hidden = true;
    });
    const xlsx = document.getElementById("rpt-export-xlsx");
    if (xlsx) xlsx.addEventListener("click", function () { expMenu.hidden = true; exportToExcel(); });
    const csv = document.getElementById("rpt-export-csv");
    if (csv) csv.addEventListener("click", function () { expMenu.hidden = true; _rptExportCsv(); });
  }

  // Expense Edit / Delete — event delegation, admin-gated
  document.addEventListener("click", function (e) {
    const editBtn = e.target.closest(".rpt-exp-edit-btn");
    if (editBtn) {
      e.preventDefault();
      const log = _rptFindExpense(editBtn.getAttribute("data-doc-id"));
      if (!log) {
        if (typeof showNotification === "function") showNotification("Could not find expense — regenerate the report.", "error");
        return;
      }
      if (typeof window.openExpenseEditModal === "function") window.openExpenseEditModal(log);
      return;
    }

    const delBtn = e.target.closest(".rpt-exp-del-btn");
    if (delBtn) {
      e.preventDefault();
      _rptDeleteExpense(delBtn);
    }
  });
}

function _rptFindExpense(docId) {
  if (!docId || !window.rawReportData) return null;
  return (window.rawReportData.expense_logs || []).find(function (l) { return l._doc_id === docId; }) || null;
}

// ── Delete an expense from the report list ──────────────────────────────────
function _rptDeleteExpense(btn) {
  const docId = btn.getAttribute("data-doc-id");
  const log = _rptFindExpense(docId);
  if (!docId || !log) return;

  if (!_rptCanManageExpense()) {
    if (typeof showNotification === "function") showNotification("Only admins can delete expenses", "error");
    return;
  }

  const desc = log.description || log.name || "this expense";
  const splitNote = log.split_group_id
    ? "\n\nThis is a SPLIT expense — all its payment legs will be deleted together."
    : "";
  if (!confirm('Delete "' + desc + '" (₹' + _rptFmt(log.amount) + ")?" + splitNote + "\n\nThis cannot be undone.")) return;

  btn.disabled = true;
  apiFetch("/expense/" + encodeURIComponent(docId), { method: "DELETE" })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data && data.success) {
        // Remove locally (all legs for a split — the server deletes the group)
        const raw = window.rawReportData;
        if (raw && Array.isArray(raw.expense_logs)) {
          raw.expense_logs = raw.expense_logs.filter(function (l) {
            if (log.split_group_id) return l.split_group_id !== log.split_group_id;
            return l._doc_id !== docId;
          });
          _rptRecomputeExpenseTotals(raw);
          updateReportSummary(raw);
          applyReportFilters();
        }
        if (typeof showNotification === "function") showNotification(data.message || "Expense deleted", "success");
        // Keep the Transactions tab's caches honest too
        if (typeof window.refreshTransactionsView === "function") window.refreshTransactionsView();
      } else {
        if (typeof showNotification === "function") showNotification((data && data.message) || "Delete failed", "error");
        btn.disabled = false;
      }
    })
    .catch(function (err) {
      console.error("report delete expense error:", err);
      if (typeof showNotification === "function") showNotification("Error: " + err.message, "error");
      btn.disabled = false;
    });
}

// Recompute the expense-side totals after a local mutation so the summary
// cards stay consistent without a refetch. Mirrors the server's arithmetic.
function _rptRecomputeExpenseTotals(data) {
  let txn = 0, rep = 0;
  (data.expense_logs || []).forEach(function (l) {
    const amt = Number(l.amount) || 0;
    if ((l.expense_type || "transaction") === "report") rep += amt;
    else txn += amt;
  });
  data.transaction_expense_total = txn;
  data.report_expense_total = rep;
  data.expense_total = txn + rep;
  data.total_revenue = (data.cash_total || 0) + (data.online_total || 0) -
    (data.refund_total || 0) - txn;
}

// Called by expense.js after an expense is added/edited while a report is on
// screen — re-pulls the report so both Reports and Analytics reflect it.
window.refreshReportsView = function () {
  if (!window.rawReportData) return;
  if (typeof generateEnhancedReport === "function") generateEnhancedReport();
};

// ── CSV export of the CURRENT filtered view ─────────────────────────────────
function _rptExportCsv() {
  const data = window.rawReportData;
  if (!data) {
    if (typeof showNotification === "function") showNotification("Generate a report first", "error");
    return;
  }
  const s = _rptState;
  let rows = _rptBuildRows(data).filter(function (r) { return _rptMatches(r, false); });
  _rptSortRows(rows);

  const q = function (v) {
    v = String(v == null ? "" : v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const lines = ["Type,Date,Time,Room,Guest / Description,Category,Scope,Method,GST Amount,Vendor / Paid To,Amount"];
  rows.forEach(function (r) {
    const log = r.log;
    const isExp = r.kind === "expense";
    const out = r.kind === "expense" || r.kind === "refund";
    lines.push([
      q(r.kind), q(log.date || ""), q(log.time || ""),
      q(isExp ? "" : log.room || ""),
      q(isExp ? (log.description || log.name || "") : (log.name || "") + (log.item ? " (" + log.item + ")" : "")),
      q(isExp ? log.category || "other" : ""),
      q(isExp ? (log.expense_type || "transaction") : ""),
      q(log.method || log.payment_method || log.payment_mode || ""),
      q(isExp ? (parseFloat(log.gst_amount || 0) || 0) : ""),
      q(isExp ? (log.vendor_name || log.paid_to || "") : ""),
      (out ? "-" : "") + (Number(log.amount) || 0),
    ].join(","));
  });

  const range = (_rptRange.start || "start") + "_to_" + (_rptRange.end || "end");
  // \uFEFF BOM so Excel opens the ₹/Unicode text correctly
  const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "Report_" + range + (_rptIsFiltered() ? "_filtered" : "") + ".csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
  if (typeof showNotification === "function") {
    showNotification("CSV exported (" + rows.length + " rows)", "success");
  }
}

// Function to toggle collapsible sections
function toggleSection(sectionId) {
  const section = document.getElementById(sectionId);
  const icon = document.getElementById(sectionId + "-icon");

  if (section && icon) {
    if (section.style.display === "none") {
      section.style.display = "block";
      icon.className = "fas fa-chevron-down";
    } else {
      section.style.display = "none";
      icon.className = "fas fa-chevron-right";
    }
  }
}

// Initialize date preset buttons (Today / This Week / This Month / Last Month)
function initializeDatePresets() {
  const presetBtns = document.querySelectorAll(".preset-btn");
  presetBtns.forEach((btn) => {
    btn.addEventListener("click", function () {
      presetBtns.forEach((b) => b.classList.remove("active"));
      this.classList.add("active");

      const preset = this.dataset.preset;
      const today = new Date();
      let startDate, endDate;

      if (preset === "today") {
        startDate = endDate = today;
      } else if (preset === "week") {
        startDate = new Date(today);
        startDate.setDate(today.getDate() - 6); // Last 7 days
        endDate = today;
      } else if (preset === "month") {
        startDate = new Date(today.getFullYear(), today.getMonth(), 1);
        endDate = today;
      } else if (preset === "last-month") {
        startDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        endDate = new Date(today.getFullYear(), today.getMonth(), 0);
      }

      // Use local date (not UTC) to avoid IST timezone offset issues
      const fmt = (d) => {
        const y   = d.getFullYear();
        const m   = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        return `${y}-${m}-${day}`;
      };
      const startInput = document.getElementById("report-start-date");
      const endInput = document.getElementById("report-end-date");
      if (startInput) startInput.value = fmt(startDate);
      if (endInput) endInput.value = fmt(endDate);
    });
  });

  // Clear "active" preset when user manually changes dates
  const dateInputs = document.querySelectorAll("#report-start-date, #report-end-date");
  dateInputs.forEach((input) => {
    input.addEventListener("change", () => {
      presetBtns.forEach((b) => b.classList.remove("active"));
    });
  });
}

// Initialize Analytics on document load
document.addEventListener("DOMContentLoaded", function () {
  // Set up chart defaults to prevent resizing
  setupChartDefaults();

  // Initialize analytics components
  initializeAnalytics();

  // Initialize date preset buttons
  initializeDatePresets();

  // Wire up apply button. NOTE: Generate no longer force-switches to the
  // Analytics view — whichever view (Analytics / Reports) is active stays.
  const applyReportFilterBtn = document.getElementById("apply-report-filter");
  if (applyReportFilterBtn) {
    applyReportFilterBtn.addEventListener("click", generateEnhancedReport);
  }

  // Wire the revamped Reports view controls once (chips, search, sort,
  // advanced filters, export menu, expense edit/delete delegation).
  _rptWireControls();

  // Make global functions accessible
  window.toggleSection = toggleSection;
  window.exportToExcel = exportToExcel;
  window.applyReportFilters = applyReportFilters;
});
