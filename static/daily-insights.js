/* ──────────────────────────────────────────────────────────────────────────
 * Daily Insights — admin-only operations analytics, rendered INLINE in the
 * Rooms tab (#di-inline) below the room cards whenever the "Cleaning"
 * filter is active.
 *
 * Backed by GET /insights/summary (routes/insights.py, requires
 * analytics.view — server-enforced; the container is also hidden
 * client-side via data-perm).
 *
 * Layout is deliberately minimal: 4 headline stats, one trend chart, and
 * collapsible sections for everything deeper. For a single-day window the
 * day detail (funnel, hourly, staff, log) renders directly — it IS the
 * content. Sections are plain button-toggled divs, not native <details>,
 * so other click handlers on the page can't swallow the toggle.
 *
 * Responses are cached client-side per window (60s) so flipping presets
 * back and forth renders instantly; the server keeps its own cache too.
 *
 * Day = IST calendar day (12:00 AM → 12:00 AM), same as all other reports.
 * Charts use the global Chart.js already loaded by index.html.
 * ──────────────────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  var CACHE_TTL_MS = 60 * 1000;
  var CACHE_MAX = 8;

  var state = {
    from: null,          // user-selected window start (YYYY-MM-DD)
    to: null,            // user-selected window end
    preset: "today",
    data: null,          // current /insights/summary payload
    leadOffset: 0,       // hidden lead day(s) fetched only for pairing
    selectedDate: null,  // day shown in the day-detail section
    charts: {},          // Chart.js instances keyed by name
    loading: false,
    open: { insights: true, days: false },  // section state across renders
  };

  var viewCache = {};        // "from|to" -> {payload, ts}
  var viewCacheKeys = [];    // insertion order for eviction

  // ── helpers ─────────────────────────────────────────────────────────────

  function _fetch(url, opts) {
    return typeof apiFetch === "function" ? apiFetch(url, opts) : fetch(url, opts);
  }

  function api(url) {
    return _fetch(url)
      .then(function (res) { return res.json(); })
      .then(function (json) {
        if (!json.success) throw new Error(json.message || "Request failed");
        return json;
      });
  }

  function notify(msg, type) {
    if (typeof showNotification === "function") showNotification(msg, type || "info");
    else alert(msg);
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function ymd(d) {
    var y = d.getFullYear(),
        m = String(d.getMonth() + 1).padStart(2, "0"),
        dd = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + dd;
  }

  function addDays(ymdStr, n) {
    var d = new Date(ymdStr + "T00:00:00");
    d.setDate(d.getDate() + n);
    return ymd(d);
  }

  function fmtDateLabel(ymdStr) {
    try {
      return new Date(ymdStr + "T00:00:00").toLocaleDateString("en-IN", {
        weekday: "short", day: "numeric", month: "short",
      });
    } catch (_) { return ymdStr; }
  }

  function fmtMin(m) {
    if (m == null) return "—";
    m = Math.round(m);
    if (m < 60) return m + "m";
    return Math.floor(m / 60) + "h " + String(m % 60).padStart(2, "0") + "m";
  }

  function fmtTime(ts) {
    if (!ts) return "—";
    var hm = String(ts).slice(11, 16).split(":");
    if (hm.length !== 2) return esc(ts);
    var h = parseInt(hm[0], 10), ap = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return h + ":" + hm[1] + " " + ap;
  }

  function inr(n) {
    return "₹" + Math.round(n || 0).toLocaleString("en-IN");
  }

  function visibleDays() {
    return state.data ? state.data.days.slice(state.leadOffset) : [];
  }

  function dayByDate(date) {
    if (!state.data) return null;
    for (var i = 0; i < state.data.days.length; i++) {
      if (state.data.days[i].date === date) return state.data.days[i];
    }
    return null;
  }

  // ── panel shell ─────────────────────────────────────────────────────────

  function ensurePanel() {
    var host = document.getElementById("di-inline");
    if (!host || host.dataset.diReady) return host;
    host.dataset.diReady = "1";
    host.innerHTML =
      '<div class="di-bar">' +
      '  <span class="di-title">Insights</span>' +
      '  <span class="di-spin hidden" id="di-spin"></span>' +
      '  <span class="di-bar-controls">' +
      '    <button class="di-chip active" data-preset="today">Today</button>' +
      '    <button class="di-chip" data-preset="yesterday">Yesterday</button>' +
      '    <button class="di-chip" data-preset="7d">7d</button>' +
      '    <button class="di-chip" data-preset="30d">30d</button>' +
      '    <input type="text" id="di-date" placeholder="Pick date" aria-label="Pick a date" />' +
      '    <button class="di-icon-btn" id="di-refresh" title="Refresh">' +
      '      <i class="fas fa-sync-alt"></i></button>' +
      "  </span>" +
      "</div>" +
      '<div id="di-body"><div class="di-empty">Loading…</div></div>';

    host.querySelectorAll(".di-chip[data-preset]").forEach(function (btn) {
      btn.addEventListener("click", function () { applyPreset(btn.dataset.preset); });
    });
    var dateInput = host.querySelector("#di-date");
    if (window.flatpickr) {
      // Same picker/config family as the audit-log and banking filters.
      flatpickr(dateInput, {
        dateFormat: "Y-m-d",
        altInput: true,
        altFormat: "d M Y",
        maxDate: "today",       // no future days
        disableMobile: true,
        onChange: function (dates) {
          // Local date components — toISOString would shift IST to
          // yesterday's date after 18:30 UTC.
          if (dates.length === 1) applyDate(ymd(dates[0]));
        },
      });
    } else {
      // Fallback: native picker if the flatpickr CDN didn't load.
      dateInput.type = "date";
      dateInput.max = ymd(new Date());
      dateInput.addEventListener("change", function () {
        if (dateInput.value) applyDate(dateInput.value);
      });
    }
    host.querySelector("#di-refresh").addEventListener("click", function () {
      load(true);
    });
    return host;
  }

  function showPanel() {
    var host = ensurePanel();
    if (!host) return;
    host.classList.remove("hidden");
    if (!state.from) applyPreset("today");
    else load(false);
  }

  function hidePanel() {
    var host = document.getElementById("di-inline");
    if (host) host.classList.add("hidden");
  }

  function applyPreset(preset) {
    var today = ymd(new Date());
    state.preset = preset;
    if (preset === "yesterday") {
      state.from = addDays(today, -1); state.to = state.from;
    }
    else if (preset === "7d") { state.from = addDays(today, -6); state.to = today; }
    else if (preset === "30d") { state.from = addDays(today, -29); state.to = today; }
    else { state.preset = "today"; state.from = today; state.to = today; }
    syncControls();
    load(false);
  }

  // Single-date picker → view exactly that day.
  function applyDate(dateStr) {
    state.preset = null;
    state.from = dateStr;
    state.to = dateStr;
    syncControls();
    load(false);
  }

  function syncControls() {
    document.querySelectorAll("#di-inline .di-chip[data-preset]").forEach(function (b) {
      b.classList.toggle("active", b.dataset.preset === state.preset);
    });
    var di = document.getElementById("di-date");
    // Show the date only when viewing a single day; ranges leave it blank.
    if (di) {
      var v = state.from === state.to ? (state.from || "") : "";
      if (di._flatpickr) di._flatpickr.setDate(v, false);  // no onChange loop
      else di.value = v;
    }
  }

  function setBusy(busy) {
    var spin = document.getElementById("di-spin");
    var body = document.getElementById("di-body");
    if (spin) spin.classList.toggle("hidden", !busy);
    if (body) body.classList.toggle("di-busy", busy);
  }

  // ── data loading (with a small client-side window cache) ────────────────

  function cacheGet(key) {
    var hit = viewCache[key];
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.payload;
    return null;
  }

  function cachePut(key, payload) {
    if (!viewCache[key]) {
      viewCacheKeys.push(key);
      while (viewCacheKeys.length > CACHE_MAX) {
        delete viewCache[viewCacheKeys.shift()];
      }
    }
    viewCache[key] = { payload: payload, ts: Date.now() };
  }

  function adopt(payload) {
    state.data = payload;
    state.leadOffset = 0;
    for (var i = 0; i < payload.days.length; i++) {
      if (payload.days[i].date < state.from) state.leadOffset++;
    }
    var vis = visibleDays();
    if (!state.selectedDate || !vis.some(function (d) { return d.date === state.selectedDate; })) {
      state.selectedDate = vis.length ? vis[vis.length - 1].date : null;
    }
    render();
  }

  function load(fresh) {
    if (state.loading) return;
    // Fetch one extra lead day so cycles pair across the window start.
    var fetchFrom = addDays(state.from, -1);
    var key = fetchFrom + "|" + state.to;

    if (!fresh) {
      var cached = cacheGet(key);
      if (cached) { adopt(cached); return; }   // instant preset flips
    }

    state.loading = true;
    setBusy(true);
    var body = document.getElementById("di-body");
    if (!state.data && body) body.innerHTML = '<div class="di-empty">Loading…</div>';

    api("/insights/summary?from=" + fetchFrom + "&to=" + state.to +
        (fresh ? "&fresh=1" : ""))
      .then(function (json) {
        cachePut(key, json);
        adopt(json);
      })
      .catch(function (err) {
        if (body) {
          body.innerHTML = '<div class="di-empty">Could not load insights.<br><small>' +
            esc(err.message) + "</small></div>";
        }
      })
      .then(function () {
        state.loading = false;
        setBusy(false);
      });
  }

  // ── rendering ───────────────────────────────────────────────────────────

  function render() {
    var d = state.data;
    if (!d) return;
    var body = document.getElementById("di-body");
    if (!body) return;

    var vis = visibleDays();
    var single = vis.length === 1;
    var html = "";
    html += renderLive(d.live && d.live.pending || []);
    html += renderStats(vis);
    if (!single) {
      html += '<div class="di-chart-wrap"><canvas id="di-trend-chart"></canvas></div>';
    }

    if (!vis.length) {
      html += '<div class="di-empty">No data in this range.</div>';
    } else if (single) {
      // One-day window: the day detail IS the content — show it directly.
      html += '<div class="di-sec"><div class="di-sec-head di-static">Details</div>' +
        '<div class="di-sec-body">' + renderDayContent(vis, false) + "</div></div>";
    } else {
      html += '<div class="di-sec"><button type="button" class="di-sec-head" data-sec="days">' +
        'Day-by-day<span class="di-caret' + (state.open.days ? " open" : "") + '">›</span></button>' +
        '<div class="di-sec-body' + (state.open.days ? "" : " hidden") + '" id="di-sec-days">' +
        renderDayContent(vis, true) + "</div></div>";
    }

    html += renderInsightsSection(d.insights || []);
    html += '<div class="di-footnote">History from audit log · day = midnight–midnight IST · ' +
      "updated " + esc((d.generated_at || "").slice(11, 16)) + "</div>";

    body.innerHTML = html;
    bindSections(single);
    if (!single) drawTrendChart();
    if (single || state.open.days) drawHourlyChart();
  }

  function renderLive(pending) {
    if (!pending.length) return "";
    var chips = pending.map(function (p) {
      var overdue = (p.elapsed_min || 0) >= 60;
      return '<span class="di-live-chip' + (overdue ? " overdue" : "") + '">' +
        esc(p.room) + " · " + fmtMin(p.elapsed_min) + "</span>";
    }).join("");
    return '<div class="di-live"><span class="di-live-label">Cleaning now</span>' +
      chips + "</div>";
  }

  function renderStats(vis) {
    var sum = function (k) {
      return vis.reduce(function (a, d) { return a + (d[k] || 0); }, 0);
    };
    var durations = [];
    vis.forEach(function (d) {
      d.cycles.forEach(function (c) {
        if (c.total_min != null && !c.stale) durations.push(c.total_min);
      });
    });
    var avgTat = durations.length
      ? durations.reduce(function (a, b) { return a + b; }, 0) / durations.length
      : null;
    var medTat = null;
    if (durations.length) {
      var sorted = durations.slice().sort(function (a, b) { return a - b; });
      var mid = Math.floor(sorted.length / 2);
      medTat = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }
    var revenue = vis.reduce(function (a, d) { return a + ((d.revenue || {}).net || 0); }, 0);
    var occVals = vis.filter(function (d) { return d.occupancy; })
                     .map(function (d) { return d.occupancy.occupancy_pct; });
    var occAvg = occVals.length
      ? occVals.reduce(function (a, b) { return a + b; }, 0) / occVals.length
      : null;

    var stat = function (num, label) {
      return '<div class="di-stat"><div class="di-stat-num">' + num +
        '</div><div class="di-stat-label">' + label + "</div></div>";
    };
    var html = '<div class="di-stats">' +
      stat(sum("cleanings"), "rooms cleaned") +
      stat(fmtMin(avgTat), "avg turnaround") +
      stat(sum("checkouts"), "check-outs") +
      stat(inr(revenue), "collected") +
      "</div>";

    var bits = [sum("checkins") + " check-ins"];
    if (medTat != null) bits.push("median " + fmtMin(medTat));
    if (occAvg != null) bits.push(occAvg.toFixed(0) + "% occupancy");
    var slow = sum("slow_cleanings");
    if (slow) bits.push(slow + " slow");
    html += '<div class="di-substats">' + esc(bits.join("  ·  ")) + "</div>";
    return html;
  }

  function renderInsightsSection(insights) {
    if (!insights.length) return "";
    var items = insights.map(function (ins) {
      return '<div class="di-insight ' + esc(ins.level) + '">' +
        "<span>" + esc(ins.text) + "</span></div>";
    }).join("");
    return '<div class="di-sec"><button type="button" class="di-sec-head" data-sec="insights">' +
      'Insights <span class="di-count">' + insights.length + "</span>" +
      '<span class="di-caret' + (state.open.insights ? " open" : "") + '">›</span></button>' +
      '<div class="di-sec-body' + (state.open.insights ? "" : " hidden") + '">' +
      items + "</div></div>";
  }

  // Day detail: navigator (multi-day only) + summary line + funnel +
  // hourly chart + staff + cleaning log.
  function renderDayContent(vis, withNav) {
    var day = dayByDate(state.selectedDate) || vis[vis.length - 1];
    state.selectedDate = day.date;
    var visIdx = vis.indexOf(day);
    var html = "";

    if (withNav) {
      html += '<div class="di-daynav">' +
        '<button type="button" id="di-prev-day"' + (visIdx <= 0 ? " disabled" : "") + ">‹</button>" +
        '<span class="di-daylabel">' + fmtDateLabel(day.date) + "</span>" +
        '<button type="button" id="di-next-day"' + (visIdx >= vis.length - 1 ? " disabled" : "") + ">›</button>" +
        "</div>";

      var t = day.turnaround, rev = day.revenue || {};
      var bits = [
        day.cleanings + " cleaned",
        "avg " + fmtMin(t.avg_min),
        day.checkouts + " out",
        day.checkins + " in",
        inr(rev.net),
      ];
      if (day.occupancy) bits.push(day.occupancy.occupancy_pct.toFixed(0) + "% occ");
      html += '<div class="di-substats di-center">' + esc(bits.join("  ·  ")) + "</div>";
    }

    // funnel
    var cleanedStage = day.cycles.filter(function (c) { return c.cleaned_ts; }).length;
    var max = Math.max(day.checkouts, cleanedStage, day.cleanings, 1);
    var bar = function (label, n) {
      return '<div class="di-funnel-row"><span>' + label + "</span>" +
        '<div class="di-funnel-track"><div class="di-funnel-bar" style="width:' +
        (n / max * 100) + '%"></div></div>' +
        '<span class="di-funnel-num">' + n + "</span></div>";
    };
    html += '<div class="di-funnel">' +
      bar("Check-outs", day.checkouts) +
      bar("Cleaned", cleanedStage) +
      bar("Ready", day.cleanings) +
      "</div>";

    // hourly pattern
    html += '<div class="di-chart-wrap di-chart-sm"><canvas id="di-hourly-chart"></canvas></div>';

    // staff
    if (day.staff.length) {
      html += '<table class="di-table"><thead><tr>' +
        "<th>Staff</th><th>Cleaned</th><th>Inspected</th><th>Avg time</th>" +
        "</tr></thead><tbody>" +
        day.staff.map(function (s) {
          return "<tr><td>" + esc(s.name) + "</td><td>" + s.cleaned + "</td><td>" +
            s.inspected + "</td><td>" + fmtMin(s.avg_clean_min) + "</td></tr>";
        }).join("") + "</tbody></table>";
    }

    // cleaning log
    if (day.cycles.length) {
      html += '<table class="di-table"><thead><tr>' +
        "<th>Room</th><th>Out</th><th>Ready</th><th>Took</th><th>By</th><th></th>" +
        "</tr></thead><tbody>" +
        day.cycles.map(function (c) {
          var badge = "";
          if (c.stale) badge = '<span class="di-badge stale">stale</span>';
          else if (c.slow) badge = '<span class="di-badge slow">slow</span>';
          if (c.skipped_housekeeping)
            badge += ' <span class="di-badge onestep">one-step</span>';
          var by = c.cleaned_by || c.inspected_by || "—";
          return "<tr><td><strong>" + esc(c.room) + "</strong></td>" +
            "<td>" + fmtTime(c.checkout_ts) + "</td>" +
            "<td>" + fmtTime(c.ready_ts) + "</td>" +
            "<td>" + esc(c.total_label) + "</td>" +
            "<td>" + esc(by) + "</td>" +
            "<td>" + badge + "</td></tr>";
        }).join("") + "</tbody></table>";
    } else {
      html += '<div class="di-empty">No cleanings completed on this day.</div>';
    }
    return html;
  }

  function bindSections(single) {
    // explicit section toggles (buttons, not native <details>)
    document.querySelectorAll("#di-inline .di-sec-head[data-sec]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var sec = btn.dataset.sec;
        state.open[sec] = !state.open[sec];
        var bodyEl = btn.nextElementSibling;
        if (bodyEl) bodyEl.classList.toggle("hidden", !state.open[sec]);
        var caret = btn.querySelector(".di-caret");
        if (caret) caret.classList.toggle("open", state.open[sec]);
        if (sec === "days" && state.open[sec]) drawHourlyChart();
      });
    });

    var vis = visibleDays();
    var idx = vis.findIndex(function (d) { return d.date === state.selectedDate; });
    var prevBtn = document.getElementById("di-prev-day");
    var nextBtn = document.getElementById("di-next-day");
    if (prevBtn) prevBtn.addEventListener("click", function () {
      if (idx > 0) { state.selectedDate = vis[idx - 1].date; render(); }
    });
    if (nextBtn) nextBtn.addEventListener("click", function () {
      if (idx < vis.length - 1) { state.selectedDate = vis[idx + 1].date; render(); }
    });
  }

  // ── charts ──────────────────────────────────────────────────────────────

  function destroyChart(id) {
    if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; }
  }

  function drawTrendChart() {
    var canvas = document.getElementById("di-trend-chart");
    if (!canvas || typeof Chart === "undefined") return;
    destroyChart("trend");
    var vis = visibleDays();
    state.charts.trend = new Chart(canvas.getContext("2d"), {
      data: {
        labels: vis.map(function (d) { return fmtDateLabel(d.date); }),
        datasets: [
          {
            type: "bar",
            label: "Cleaned",
            data: vis.map(function (d) { return d.cleanings; }),
            backgroundColor: vis.map(function (d) {
              return d.date === state.selectedDate ? "#2b6cb0" : "#cbd5e0";
            }),
            borderRadius: 3,
            yAxisID: "y",
            order: 2,
          },
          {
            type: "line",
            label: "Avg turnaround (min)",
            data: vis.map(function (d) { return d.turnaround.avg_min; }),
            borderColor: "#dd6b20",
            backgroundColor: "#dd6b20",
            borderWidth: 1.5,
            spanGaps: true,
            tension: 0.3,
            pointRadius: 2,
            yAxisID: "y2",
            order: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        scales: {
          x: { grid: { display: false } },
          y: { beginAtZero: true, ticks: { precision: 0 } },
          y2: {
            beginAtZero: true, position: "right",
            grid: { drawOnChartArea: false },
          },
        },
        onClick: function (evt, elements) {
          if (!elements.length) return;
          var d = vis[elements[0].index];
          if (d) {
            state.selectedDate = d.date;
            state.open.days = true;
            render();
          }
        },
        plugins: { legend: { labels: { boxWidth: 10, font: { size: 10 } } } },
      },
    });
  }

  function drawHourlyChart() {
    var canvas = document.getElementById("di-hourly-chart");
    if (!canvas || typeof Chart === "undefined") return;
    destroyChart("hourly");
    var day = dayByDate(state.selectedDate);
    if (!day) return;
    var labels = [];
    for (var h = 0; h < 24; h++) labels.push(String(h).padStart(2, "0"));
    state.charts.hourly = new Chart(canvas.getContext("2d"), {
      type: "bar",
      data: {
        labels: labels,
        datasets: [
          { label: "Check-outs", data: day.hourly.checkouts, backgroundColor: "#fbd38d" },
          { label: "Ready", data: day.hourly.readies, backgroundColor: "#68d391" },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        scales: {
          x: { grid: { display: false } },
          y: { beginAtZero: true, ticks: { precision: 0 } },
        },
        plugins: { legend: { labels: { boxWidth: 10, font: { size: 10 } } } },
      },
    });
  }

  // ── wiring ──────────────────────────────────────────────────────────────

  // The panel follows the Rooms-tab filter chips: visible while the
  // "Cleaning" filter is active, hidden otherwise.
  function bind() {
    document.querySelectorAll(".filter-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (btn.dataset.filter === "cleaning") showPanel();
        else hidePanel();
      });
    });
    var active = document.querySelector('.filter-btn.active[data-filter="cleaning"]');
    if (active) showPanel();
  }

  function start() {
    if (!window.CibaraAuth) { setTimeout(start, 100); return; }
    window.CibaraAuth.ready().then(function () {
      // Server enforces analytics.view; skip wiring entirely for non-admins.
      if (!window.CibaraAuth.userCan("analytics.view")) return;
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", bind);
      } else {
        bind();
      }
    });
  }
  start();

  window.openDailyInsights = showPanel;
})();
