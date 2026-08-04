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

  // Bills payload — used by BOTH the Billing Analytics strip and the
  // Revenue-by-Room-Type chart (the chart needs `is_ac` per bill to split
  // Premium / Premium AC accurately). Single network call, both consumers.
  const startDate = document.getElementById("report-start-date")?.value;
  const endDate   = document.getElementById("report-end-date")?.value;
  let billsPayload = null;
  if (startDate && endDate) {
    try {
      const resp = await apiFetch("/revenue_report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_date: startDate, end_date: endDate }),
      });
      if (resp.ok) {
        const bd = await resp.json();
        if (bd.success) {
          billsPayload = bd;
          updateBillingStrip(bd.summary);
        }
      }
    } catch (e) {
      console.warn("Billing data unavailable:", e);
    }
  }

  // Performance KPIs (Occupancy / ADR / RevPAR) — separate endpoint because
  // these are measured by night of stay, not by checkout. Best-effort: any
  // failure (no permission, no data) just leaves the strip hidden.
  if (startDate && endDate) {
    try {
      const kResp = await apiFetch("/performance_kpis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_date: startDate, end_date: endDate }),
      });
      if (kResp.ok) {
        const kd = await kResp.json();
        if (kd.success && kd.kpis) updatePerformanceStrip(kd.kpis);
      }
    } catch (e) {
      console.warn("Performance KPIs unavailable:", e);
    }
  }

  // Revenue by Room Type — runs after the bills fetch so AC attribution
  // is accurate. If the fetch failed (billsPayload === null) the chart
  // renders an empty state.
  generateRoomTypeRevenueChart(billsPayload);

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
          },
        },
      },
      scales: {
        y: { beginAtZero: true, ticks: { precision: 0 } },
      },
    },
  });
}

// ── 8-card KPI grid ──────────────────────────────────────────────────────────
function updateSummaryCards(data) {
  const grid = document.getElementById("analytics-summary");
  if (!grid) return;

  const fmt  = (n) => Math.round(n || 0).toLocaleString("en-IN");
  const cash = data.cash_total   || 0;
  const upi  = data.online_total || 0;
  const rev  = cash + upi;
  const exp  = data.expense_total || 0;
  const net  = rev - exp;
  const ref  = data.refund_total  || 0;
  const adon = data.addon_total   || 0;
  const ci   = data.checkins  || 0;
  const rn   = data.renewals  || 0;
  const stays= ci + rn;

  const startDate = document.getElementById("report-start-date")?.value;
  const endDate   = document.getElementById("report-end-date")?.value;
  let days = 1;
  if (startDate && endDate)
    days = Math.max(1, Math.round((new Date(endDate) - new Date(startDate)) / 86400000) + 1);

  const margin     = rev > 0 ? ((net / rev) * 100).toFixed(1) : "0.0";
  const netPos     = net >= 0;
  const avgDaily   = Math.round(rev / days);
  const avgStay    = stays > 0 ? Math.round(rev / stays) : 0;
  const refRate    = stays > 0 ? ((data.refund_logs?.length || 0) / stays * 100).toFixed(0) : 0;
  const txnExp     = data.transaction_expense_total || 0;
  const repExp     = data.report_expense_total      || 0;

  function card(accent, iconBg, icon, label, value, badges) {
    return `
    <div class="kpi-card" style="--kpi-accent:${accent};--kpi-icon-bg:${iconBg}">
      <div class="kpi-top">
        <div class="kpi-icon"><i class="${icon}"></i></div>
        <div class="kpi-label">${label}</div>
      </div>
      <div class="kpi-value">${value}</div>
      <div class="kpi-meta">${badges}</div>
    </div>`;
  }
  function badge(bg, color, text) {
    return `<span class="kpi-badge" style="background:${bg};color:${color}">${text}</span>`;
  }

  grid.innerHTML =
    card("#2563eb","#eff6ff","fas fa-rupee-sign","Total Revenue",`₹${fmt(rev)}`,
      badge("#f0fdf4","#16a34a",`₹${fmt(cash)} Cash`) +
      badge("#eff6ff","#2563eb",`₹${fmt(upi)} UPI`)) +

    card(netPos?"#16a34a":"#dc2626", netPos?"#f0fdf4":"#fef2f2","fas fa-chart-line","Net Profit",
      `<span style="color:${netPos?"#16a34a":"#dc2626"}">₹${fmt(net)}</span>`,
      badge(netPos?"#f0fdf4":"#fef2f2", netPos?"#16a34a":"#dc2626", `${margin}% margin`)) +

    card("#ef4444","#fef2f2","fas fa-receipt","Total Expenses",`₹${fmt(exp)}`,
      badge("#fef9c3","#854d0e",`₹${fmt(txnExp)} Daily`) +
      badge("#f3e8ff","#6b21a8",`₹${fmt(repExp)} Report`)) +

    card("#7c3aed","#f5f3ff","fas fa-calendar-day","Avg Daily Revenue",`₹${fmt(avgDaily)}`,
      badge("#f5f3ff","#7c3aed",`${days} day${days!==1?"s":""}`)) +

    card("#f59e0b","#fffbeb","fas fa-sign-in-alt","Check-ins & Renewals",`${ci}`,
      badge("#fffbeb","#b45309",`${rn} Renewals`) +
      badge("#fffbeb","#b45309",`${stays} Total Stays`)) +

    card("#0891b2","#ecfeff","fas fa-concierge-bell","Add-on Revenue",`₹${fmt(adon)}`,
      badge("#ecfeff","#0e7490",`${(data.addon_logs||[]).length} items`)) +

    card("#ea580c","#fff7ed","fas fa-undo","Refunds",`₹${fmt(ref)}`,
      badge("#fff7ed","#9a3412",`${(data.refund_logs||[]).length} txns`) +
      badge("#fff7ed","#9a3412",`${refRate}% rate`)) +

    card("#16a34a","#f0fdf4","fas fa-hand-holding-usd","Avg per Stay",`₹${fmt(avgStay)}`,
      badge("#f0fdf4","#166534",`${stays} stays`));

  // Trigger insights update
  generateInsightsSection(data, days);
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

// ── Performance strip (populated after /performance_kpis API call) ───────────
// Occupancy %, ADR and RevPAR are measured by NIGHT OF STAY, not by checkout,
// so they differ from the Billing Analytics strip by design.
function updatePerformanceStrip(kpis) {
  const panel = document.getElementById("performance-panel");
  const strip = document.getElementById("performance-strip");
  if (!panel || !strip || !kpis) return;

  const fmtMoney = (n) => Math.round(n || 0).toLocaleString("en-IN");
  const fmtNum = (n) => (n || 0).toLocaleString("en-IN");

  function bk(iconBg, iconColor, icon, lbl, val) {
    return `<div class="billing-kpi">
      <div class="billing-icon" style="background:${iconBg};color:${iconColor}">
        <i class="${icon}"></i>
      </div>
      <div>
        <div class="billing-lbl">${lbl}</div>
        <div class="billing-val">${val}</div>
      </div>
    </div>`;
  }

  // Warn (not block) when occupancy > 100% — almost always a wrong room count.
  const occColor = kpis.occupancy_over_100 ? "#dc2626" : "#1e293b";
  const occCard = `<div class="billing-kpi">
      <div class="billing-icon" style="background:#dbeafe;color:#1d4ed8">
        <i class="fas fa-bed"></i>
      </div>
      <div>
        <div class="billing-lbl">Occupancy</div>
        <div class="billing-val" style="color:${occColor}">${(kpis.occupancy_pct || 0)}%</div>
      </div>
    </div>`;

  strip.innerHTML =
    occCard +
    bk("#dcfce7","#166534","fas fa-rupee-sign","ADR",`₹${fmtMoney(kpis.adr)}`) +
    bk("#f3e8ff","#6b21a8","fas fa-chart-line","RevPAR",`₹${fmtMoney(kpis.revpar)}`) +
    bk("#fef9c3","#854d0e","fas fa-moon","Room Nights Sold", fmtNum(kpis.occupied_room_nights)) +
    bk("#e0f2fe","#0369a1","fas fa-door-open","Available Nights", fmtNum(kpis.available_room_nights)) +
    bk("#fef3c7","#92400e","fas fa-hotel","Room Revenue",`₹${fmtMoney(kpis.room_revenue)}`);

  panel.style.display = "block";

  if (kpis.occupancy_over_100) {
    console.warn(
      "Occupancy > 100% — room_count (" + kpis.room_count + ") is likely lower " +
      "than the rooms that were actually sold. Set the correct inventory."
    );
  }
}

// ── Billing strip (populated after /revenue_report API call) ─────────────────
function updateBillingStrip(summary) {
  const panel = document.getElementById("billing-panel");
  const strip = document.getElementById("billing-strip");
  if (!panel || !strip || !summary) return;

  const fmt = (n) => Math.round(n || 0).toLocaleString("en-IN");

  function bk(iconBg, iconColor, icon, lbl, val) {
    return `<div class="billing-kpi">
      <div class="billing-icon" style="background:${iconBg};color:${iconColor}">
        <i class="${icon}"></i>
      </div>
      <div>
        <div class="billing-lbl">${lbl}</div>
        <div class="billing-val">${val}</div>
      </div>
    </div>`;
  }

  strip.innerHTML =
    bk("#dbeafe","#1d4ed8","fas fa-file-invoice","Checkouts", summary.total_bills||0) +
    bk("#dcfce7","#166534","fas fa-hotel","Direct Revenue",`₹${fmt(summary.hotel_revenue)}`) +
    bk("#fef9c3","#854d0e","fas fa-globe","OTA Revenue",`₹${fmt(summary.ota_revenue)}`) +
    bk("#f3e8ff","#6b21a8","fas fa-concierge-bell","Services",`₹${fmt(summary.total_services)}`) +
    bk("#fef3c7","#92400e","fas fa-tag","Discounts Given",`₹${fmt(summary.total_discounts)}`) +
    bk("#fef2f2","#dc2626","fas fa-hourglass-half","Balance Due",`₹${fmt(summary.total_balance_due)}`);

  panel.style.display = "block";
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

// ── Revenue by Room Type Chart ────────────────────────────────────────────────
// Bar chart showing total billed revenue per room category for the selected
// date range. Uses bills (checkout-basis revenue) — not raw payments — so a
// bill's full total_amount is attributed to the category once at checkout.
//
// Categories (in roomPricing.CATEGORY_DISPLAY_ORDER):
//   Premium Room, Premium AC Room, Regular Room, Deluxe Room,
//   Single Attach, Single Non-Attach, Double Non-Attach, Party Hall
//
// AC attribution: bill.is_ac (snapshotted from guest.isAC at checkout) drives
// the Premium / Premium AC split. Active stays without a bill yet are not
// included — they'll appear once the guest checks out (consistent with the
// "Billing Analytics" strip below this chart).
//
// `billsPayload` is the full /revenue_report response. May be null if the
// fetch failed or the date range is empty — we render an empty state.
function generateRoomTypeRevenueChart(billsPayload) {
  const canvas = document.getElementById("room-type-revenue-chart");
  if (!canvas) return;

  if (canvas.chart) {
    canvas.chart.destroy();
    canvas.chart = null;
  }

  const bills = (billsPayload && Array.isArray(billsPayload.bills))
    ? billsPayload.bills
    : null;

  if (!bills || bills.length === 0) {
    showChartEmpty(canvas, "No checkouts in this period");
    return;
  }

  // roomPricing lives in script.js. Defensive guard in case load order
  // changes — analytics.js is loaded with `defer`, same as script.js,
  // but file order is not guaranteed across browsers.
  if (typeof roomPricing === "undefined" ||
      typeof roomPricing.getRoomCategoryWithAC !== "function") {
    showChartEmpty(canvas, "Room category helper not loaded");
    return;
  }

  // Aggregate total_amount per category. Skip OTA bills — those are
  // already excluded from "hotel revenue" elsewhere and including them
  // would double-count revenue MMT bills.
  // (mirrors the OTA exclusion implicit in revenue_report's hotel_revenue
  // summary: payment_source == 'ota' is OTA-billed.)
  const revenueByCategory = {};
  bills.forEach((b) => {
    if (b.payment_source === "ota") return;
    const room   = String(b.room || "");
    const isAC   = !!b.is_ac;
    const amount = Number(b.total_amount) || 0;
    if (!room || amount <= 0) return;

    const cat = roomPricing.getRoomCategoryWithAC(room, isAC);
    const key = cat.category;
    if (!revenueByCategory[key]) {
      revenueByCategory[key] = { label: cat.label, amount: 0, count: 0 };
    }
    revenueByCategory[key].amount += amount;
    revenueByCategory[key].count  += 1;
  });

  // Hide zero-revenue categories (less clutter on the chart). Sort by
  // amount descending so the highest-earning category is leftmost.
  const entries = Object.entries(revenueByCategory)
    .filter(([_, v]) => v.amount > 0)
    .sort((a, b) => b[1].amount - a[1].amount);

  if (entries.length === 0) {
    showChartEmpty(canvas, "No room revenue in this period");
    return;
  }

  const labels = entries.map(([_, v]) => v.label);
  const data   = entries.map(([_, v]) => Math.round(v.amount));
  const counts = entries.map(([_, v]) => v.count);

  // Distinct accent colour per category — matches the room-type semantics
  // loosely (premium = blue, ac = teal, deluxe = gold, etc.). Falls back
  // to neutral grey for any unknown key.
  const COLOR = {
    "premium":           "rgba(37, 99, 235, 0.75)",   // blue
    "premium-ac":        "rgba(8, 145, 178, 0.75)",    // teal
    "regular":           "rgba(124, 58, 237, 0.75)",   // purple
    "deluxe":            "rgba(245, 158, 11, 0.75)",   // amber
    "single-attach":     "rgba(22, 163, 74, 0.75)",    // green
    "single-non-attach": "rgba(132, 204, 22, 0.75)",   // lime
    "double-non-attach": "rgba(234, 88, 12, 0.75)",    // orange
    "party-hall":        "rgba(219, 39, 119, 0.75)",   // pink
    "other":             "rgba(107, 114, 128, 0.75)",  // grey
  };
  const bg = entries.map(([k, _]) => COLOR[k] || COLOR["other"]);

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
            label: function (ctx) {
              const amt = (ctx.raw || 0).toLocaleString("en-IN");
              const n   = counts[ctx.dataIndex];
              return [
                `Revenue: ₹${amt}`,
                `Bills: ${n}`,
              ];
            },
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

  view.innerHTML = `
    <!-- 8-card KPI grid -->
    <div class="kpi-grid" id="analytics-summary"></div>

    <!-- Insights panel -->
    <div class="insights-panel" id="analytics-insights">
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

    <!-- Performance strip (hidden until /performance_kpis loads) -->
    <div class="billing-panel" id="performance-panel" style="display:none">
      <div class="billing-hdr">
        <i class="fas fa-gauge-high"></i> Performance
        <span>(occupancy / ADR / RevPAR, by night of stay)</span>
      </div>
      <div class="billing-strip" id="performance-strip"></div>
    </div>

    <!-- Billing analytics strip (hidden until /revenue_report loads) -->
    <div class="billing-panel" id="billing-panel" style="display:none">
      <div class="billing-hdr">
        <i class="fas fa-file-invoice-dollar"></i> Billing Analytics
        <span>(based on guest checkouts)</span>
      </div>
      <div class="billing-strip" id="billing-strip"></div>
    </div>

    <!-- Row 1: Revenue vs Expenses + Daily Revenue -->
    <div class="chart-row chart-row-2">
      ${chartCard("revenue-expense-chart","#4361ee","fas fa-chart-area","Revenue vs Expenses", 280)}
      ${chartCard("daily-revenue-chart","#27ae60","fas fa-chart-bar","Daily Revenue — Cash vs UPI", 280)}
    </div>

    <!-- Row 2: Payment Split + Top Rooms -->
    <div class="chart-row chart-row-2">
      ${chartCard("payment-methods-chart","#0891b2","fas fa-wallet","Payment Split", 280)}
      ${chartCard("top-rooms-chart","#4361ee","fas fa-bed","Top Rooms by Revenue", 280)}
    </div>

    <!-- Row 3: Expense Categories + Expense Trend -->
    <!-- Filter scopes both expense charts in this row. Daily =
         transaction-type (drawer expenses). Report = from-account
         (off-deposit). All = both combined (legacy default). -->
    <div style="display:flex; justify-content:flex-end; align-items:center;
                gap:0.5rem; margin: 0.4rem 0 0.4rem; padding: 0 0.2rem;
                font-size:0.82rem; color:#444;">
      <i class="fas fa-filter" style="font-size:0.75rem; color:#888;"></i>
      <label for="analytics-expense-filter" style="font-weight:600;">Expense type:</label>
      <select id="analytics-expense-filter"
              style="padding:0.25rem 0.5rem; border:1px solid #d8d8d8;
                     border-radius:6px; font-size:0.82rem; height:30px;
                     background:#fff;">
        <option value="all">All</option>
        <option value="transaction" selected>Daily only</option>
        <option value="report">Report only</option>
      </select>
    </div>
    <div class="chart-row chart-row-2">
      ${chartCard("expense-categories-chart","#e63946","fas fa-tags","Expense Breakdown by Category", 280)}
      ${chartCard("expense-trend-chart","#ef4444","fas fa-receipt","Daily Expense Trend", 280)}
    </div>

    <!-- Row 4: Top Add-ons + Revenue by Room Type -->
    <div class="chart-row chart-row-2">
      ${chartCard("top-services-chart","#f59e0b","fas fa-concierge-bell","Top Add-on Services", 280)}
      ${chartCard("room-type-revenue-chart","#8b5cf6","fas fa-th-large","Revenue by Room Type", 280)}
    </div>

    <!-- Row 5a: Guest footfall heatmap (geographic, all-time). -->
    <div class="chart-card" style="height:440px">
      <div class="chart-hdr">
        <i class="chart-hdr-icon fas fa-map-marked-alt" style="color:#0ea5e9"></i>
        <span class="chart-hdr-title">Guest Footfall Heatmap</span>
      </div>
      <div class="chart-body" style="position:relative;padding:0">
        <div id="pincode-heatmap" style="position:absolute;inset:0;border-radius:8px;overflow:hidden"></div>
      </div>
    </div>

    <!-- Row 5b: Guest demographics (from ID documents — all-time, not
         date-filtered). Footfall by area + age profile for marketing /
         pricing decisions. -->
    <div class="chart-row chart-row-2">
      ${chartCard("pincode-footfall-chart","#0ea5e9","fas fa-map-marker-alt","Footfall by Area (PIN code)", 320)}
      ${chartCard("guest-age-chart","#16a34a","fas fa-users","Guest Age Distribution", 320)}
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
