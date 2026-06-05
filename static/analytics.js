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

    <!-- Billing analytics strip (hidden until /revenue_report loads) -->
    <div class="billing-panel" id="billing-panel" style="display:none">
      <div class="billing-hdr">
        <i class="fas fa-file-invoice-dollar"></i> Billing Analytics
        <span>(based on guest checkouts)</span>
      </div>
      <div class="billing-strip" id="billing-strip"></div>
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

// Update report date range display
function updateReportDateRange(startDate, endDate) {
  const dateRangeElement = document.getElementById("report-date-range");
  if (!dateRangeElement) return;

  const formatDate = (dateStr) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  };

  const formattedStart = formatDate(startDate);
  const formattedEnd = formatDate(endDate);

  dateRangeElement.textContent =
    formattedStart === formattedEnd
      ? `(${formattedStart})`
      : `(${formattedStart} to ${formattedEnd})`;
}

// Update report summary values
function updateReportSummary(data) {
  // Update summary values
  document.getElementById("report-cash-total").textContent = `₹${
    data.cash_total || 0
  }`;
  document.getElementById("report-online-total").textContent = `₹${
    data.online_total || 0
  }`;
  document.getElementById("report-refund-total").textContent = `₹${
    data.refund_total || 0
  }`;
  document.getElementById("report-expense-total").textContent = `₹${
    data.expense_total || 0
  }`;

  // FIXED: Calculate net revenue properly (Income - Expenses)
  const totalIncome = (data.cash_total || 0) + (data.online_total || 0);
  const totalExpense = data.expense_total || 0;
  const netRevenue = totalIncome - totalExpense;

  document.getElementById("report-net-revenue").textContent = `₹${netRevenue}`;
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

// Render report data – wires filters, populates category dropdown, renders
function renderCompactReportData(data) {
  const reportContent = document.getElementById("report-content");
  if (!reportContent) return;

  window.rawReportData = data;

  // Hide loading / empty state
  const loadingEl = reportContent.querySelector(".loading-indicator");
  if (loadingEl) loadingEl.classList.add("hidden");
  const emptyEl = reportContent.querySelector(".empty-state");
  if (emptyEl) emptyEl.remove();

  // Populate expense category dropdown from actual data
  const catSelect = document.getElementById("expense-category-filter");
  if (catSelect) {
    const cats = [...new Set((data.expense_logs || []).map(l => l.category || "other"))].sort();
    const capFirst = s => s.charAt(0).toUpperCase() + s.slice(1);
    catSelect.innerHTML = `<option value="all">All Categories</option>` +
      cats.map(c => `<option value="${c}">${capFirst(c.replace(/_/g," "))}</option>`).join("");
  }

  // Wire up filter controls (once). expense-type-filter is the
  // Daily/Report selector that appears alongside the category filter
  // when "Expenses Only" is the active transaction type.
  ["report-search","report-type-filter","expense-category-filter",
   "expense-type-filter","report-sort"].forEach(id => {
    const el = document.getElementById(id);
    if (el && !el._filterWired) {
      el.addEventListener(id === "report-search" ? "input" : "change", applyReportFilters);
      el._filterWired = true;
    }
  });

  // Show/hide category + expense-type filters based on transaction-type
  const typeEl = document.getElementById("report-type-filter");
  if (typeEl && !typeEl._visWired) {
    typeEl.addEventListener("change", () => {
      const catEl = document.getElementById("expense-category-filter");
      const etEl  = document.getElementById("expense-type-filter");
      const isExp = typeEl.value === "expenses";
      if (catEl) catEl.style.display = isExp ? "" : "none";
      if (etEl)  etEl.style.display  = isExp ? "" : "none";
    });
    typeEl._visWired = true;
  }

  // Reset to defaults
  const searchEl = document.getElementById("report-search");
  if (searchEl) searchEl.value = "";
  if (typeEl) { typeEl.value = "all"; }
  if (catSelect) { catSelect.value = "all"; catSelect.style.display = "none"; }
  const etEl = document.getElementById("expense-type-filter");
  if (etEl) { etEl.value = "all"; etEl.style.display = "none"; }
  const sortEl = document.getElementById("report-sort");
  if (sortEl) sortEl.value = "oldest";

  applyReportFilters();
}

// Apply filters + expense category filter and re-render
function applyReportFilters() {
  const data = window.rawReportData;
  if (!data) return;

  const reportContent = document.getElementById("report-content");
  if (!reportContent) return;

  const fmt = n => Math.round(n||0).toLocaleString("en-IN");
  const capFirst = s => (s||"other").charAt(0).toUpperCase()+(s||"other").slice(1).replace(/_/g," ");

  const search     = (document.getElementById("report-search")?.value||"").toLowerCase().trim();
  const typeFilter = document.getElementById("report-type-filter")?.value||"all";
  const catFilter  = document.getElementById("expense-category-filter")?.value||"all";
  // Daily / Report sub-filter inside Expenses. "all" = both, default.
  // Missing expense_type on a legacy row is treated as "transaction".
  const expTypeFilter = document.getElementById("expense-type-filter")?.value||"all";
  const sortOrder  = document.getElementById("report-sort")?.value||"oldest";

  // Category filter badge color map
  const catClass = { salary:"cat-badge-salary", utilities:"cat-badge-utilities",
    maintenance:"cat-badge-maintenance", supplies:"cat-badge-supplies",
    booking_commission:"cat-badge-commission" };

  function sortLogs(logs) {
    return [...logs].sort((a, b) => {
      if (sortOrder==="highest") return (b.amount||0)-(a.amount||0);
      if (sortOrder==="lowest")  return (a.amount||0)-(b.amount||0);
      const da = new Date(`${a.date||"2000-01-01"} ${a.time||"00:00"}`);
      const db = new Date(`${b.date||"2000-01-01"} ${b.time||"00:00"}`);
      return sortOrder==="newest" ? db-da : da-db;
    });
  }
  function hasSearch(log, fields) {
    return !search || fields.some(f => String(log[f]||"").toLowerCase().includes(search));
  }

  const showCash    = typeFilter==="all" || typeFilter==="cash";
  const showOnline  = typeFilter==="all" || typeFilter==="online";
  const showExp     = typeFilter==="all" || typeFilter==="expenses";
  const showRef     = typeFilter==="all" || typeFilter==="refunds";

  const cashLogs   = showCash   ? sortLogs((data.cash_logs||[]).filter(l=>hasSearch(l,["room","name","item"]))) : [];
  const onlineLogs = showOnline ? sortLogs((data.online_logs||[]).filter(l=>hasSearch(l,["room","name","item"]))) : [];
  const refLogs    = showRef    ? sortLogs((data.refund_logs||[]).filter(l=>hasSearch(l,["room","name"]))) : [];
  const expLogs    = showExp
    ? sortLogs((data.expense_logs||[]).filter(l => {
        const catOk = catFilter==="all" || (l.category||"other")===catFilter;
        // Daily / Report sub-filter. Missing field counts as "transaction"
        // so legacy expenses still show under "Daily only".
        const et = (l.expense_type || "transaction").toLowerCase();
        const etOk = expTypeFilter==="all" || et === expTypeFilter;
        return catOk && etOk && hasSearch(l,["name","description","category","paid_to"]);
      }))
    : [];

  // Count active filters for result bar
  const total = cashLogs.length + onlineLogs.length + expLogs.length + refLogs.length;
  const isFiltered = search || typeFilter!=="all" || catFilter!=="all"
                     || expTypeFilter!=="all";

  let html = "";
  if (isFiltered) {
    const filterDesc = [
      search ? `"${search}"` : "",
      typeFilter!=="all" ? typeFilter : "",
      catFilter!=="all" && showExp ? capFirst(catFilter) : "",
      expTypeFilter!=="all" && showExp
        ? (expTypeFilter === "transaction" ? "Daily" : "Report") : "",
    ].filter(Boolean).join(", ");
    html += `<div class="filter-result-bar"><i class="fas fa-filter"></i>&nbsp; <strong>${total}</strong> result${total!==1?"s":""} ${filterDesc ? `for <em>${filterDesc}</em>` : ""}</div>`;
  }

  // ---- helper to build a collapsible section ----
  function section(id, iconClass, iconColor, badgeBg, badgeColor, title, count, rows, totalAmt, amtColor) {
    const emptyMsg = search || isFiltered ? "No results match your filters" : `No ${title.toLowerCase()} in this period`;
    return `
    <div class="transaction-section">
      <h3 onclick="toggleSection('${id}')">
        <span><i class="${iconClass}" style="color:${iconColor};margin-right:0.4rem"></i>${title}</span>
        <span style="display:flex;align-items:center;gap:0.5rem">
          <span class="section-badge" style="background:${badgeBg};color:${badgeColor}">${count}</span>
          <i class="fas fa-chevron-right" id="${id}-icon"></i>
        </span>
      </h3>
      <div class="transaction-logs" id="${id}" style="display:none">
        ${rows.length ? rows.join("") + `<div class="log-item section-total"><div class="log-details"><div class="log-title">Subtotal</div></div><div class="log-amount" style="color:${amtColor}">₹${fmt(totalAmt)}</div></div>` : `<div class="log-item log-empty">${emptyMsg}</div>`}
      </div>
    </div>`;
  }

  function payRow(log) {
    return `<div class="log-item">
      <div class="log-details">
        <div class="log-title">Room ${log.room} — ${log.name}${log.item?` <span class="transaction-item">(${log.item})</span>`:""}
          ${log.type==="addon"?'<span class="expense-category-badge" style="background:#fef9c3;color:#92400e">Add-on</span>':""}
        </div>
        <div class="log-subtitle">${log.date} ${log.time||""}</div>
      </div>
      <div class="log-amount">₹${fmt(log.amount)}</div>
    </div>`;
  }

  function expRow(log) {
    const cat = log.category||"other";
    const cls = catClass[cat]||"cat-badge-other";
    const moreInfo = log.vendor_name ? `· ${log.vendor_name}` : (log.paid_to ? `· ${log.paid_to}` : "");
    return `<div class="log-item">
      <div class="log-details">
        <div class="log-title">
          ${log.name||log.description||"N/A"}
          <span class="expense-category-badge ${cls}">${capFirst(cat)}</span>
          ${log.has_gst?'<span class="expense-category-badge" style="background:#e0f2fe;color:#0369a1">GST</span>':""}
        </div>
        <div class="log-subtitle">${formatDateTime(log.date,log.time)} ${moreInfo} · ${(log.payment_method||"cash").toUpperCase()}</div>
      </div>
      <div class="log-amount" style="color:#dc2626">₹${fmt(log.amount)}</div>
    </div>`;
  }

  function refRow(log) {
    return `<div class="log-item">
      <div class="log-details">
        <div class="log-title">Room ${log.room} — ${log.name}</div>
        <div class="log-subtitle">${log.date} ${log.time||""}</div>
      </div>
      <div class="log-amount" style="color:#dc2626">₹${fmt(log.amount)}</div>
    </div>`;
  }

  if (showCash)
    html += section("cash-section","fas fa-money-bill-wave","#16a34a","#f0fdf4","#16a34a",
      "Cash Payments", cashLogs.length, cashLogs.map(payRow),
      cashLogs.reduce((s,l)=>s+(l.amount||0),0), "#1e293b");

  if (showOnline)
    html += section("online-section","fas fa-mobile-alt","#2563eb","#eff6ff","#2563eb",
      "Online / UPI Payments", onlineLogs.length, onlineLogs.map(payRow),
      onlineLogs.reduce((s,l)=>s+(l.amount||0),0), "#1e293b");

  if (showExp)
    html += section("expense-section","fas fa-receipt","#dc2626","#fef2f2","#dc2626",
      "Expenses" + (catFilter!=="all" ? ` — ${capFirst(catFilter)}` : ""),
      expLogs.length, expLogs.map(expRow),
      expLogs.reduce((s,l)=>s+(l.amount||0),0), "#dc2626");

  if (showRef)
    html += section("refund-section","fas fa-undo","#ea580c","#fff7ed","#ea580c",
      "Refunds", refLogs.length, refLogs.map(refRow),
      refLogs.reduce((s,l)=>s+(l.amount||0),0), "#dc2626");

  // Grand total – only when showing all + no filters
  if (typeFilter==="all" && !search && catFilter==="all") {
    const tCash   = cashLogs.reduce((s,l)=>s+(l.amount||0),0);
    const tOnline = onlineLogs.reduce((s,l)=>s+(l.amount||0),0);
    const tInc    = tCash + tOnline;
    const tExp    = expLogs.reduce((s,l)=>s+(l.amount||0),0);
    const tRef    = refLogs.reduce((s,l)=>s+(l.amount||0),0);
    const net     = tInc - tExp;
    html += `
    <div class="grand-total-section">
      <h3>Grand Total</h3>
      <div class="transaction-logs">
        <div class="log-item"><div class="log-details"><div class="log-title">Cash + UPI Income</div></div><div class="log-amount">₹${fmt(tInc)}</div></div>
        <div class="log-item"><div class="log-details"><div class="log-title">Total Expenses</div></div><div class="log-amount" style="color:#dc2626">₹${fmt(tExp)}</div></div>
        <div class="log-item"><div class="log-details"><div class="log-title">Total Refunds</div></div><div class="log-amount" style="color:#dc2626">₹${fmt(tRef)}</div></div>
        <div class="log-item grand-total"><div class="log-details"><div class="log-title">Net Revenue</div></div><div class="log-amount">₹${fmt(net)}</div></div>
      </div>
    </div>`;
  }

  reportContent.innerHTML = html;
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

  // Wire up apply button
  const applyReportFilterBtn = document.getElementById("apply-report-filter");
  if (applyReportFilterBtn) {
    applyReportFilterBtn.addEventListener("click", generateEnhancedReport);

    // Switch to analytics view after loading
    applyReportFilterBtn.addEventListener("click", function () {
      const analyticsBtn = document.querySelector('.view-btn[data-view="analytics"]');
      if (analyticsBtn) analyticsBtn.click();
    });
  }

  // Make global functions accessible
  window.toggleSection = toggleSection;
  window.exportToExcel = exportToExcel;
  window.applyReportFilters = applyReportFilters;
});
