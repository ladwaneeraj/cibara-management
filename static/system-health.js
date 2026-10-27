/*
 * system-health.js — admin-only "System health" page for the classic UI.
 *
 * Presentation only. Reads GET /api/v2/admin/metrics (which require_permission
 * logs.view enforces server-side) and turns the raw per-route snapshot into
 * plain-language insights a non-developer can act on. It changes no data.
 *
 * The snapshot shape (see backend/cibara_api/core/metrics.py snapshot()):
 *   { success, since, uptime_s,
 *     routes: [{ route, count, errors, avg_ms, p50_ms, p95_ms, max_ms,
 *                reads, writes, reads_per_call }],
 *     totals: { requests, reads, writes } }
 *
 * Opened from the "System health" card in Settings:
 *   window.CibaraSystemHealth.open();
 */
(function (global) {
  "use strict";

  var MODAL_ID = "system-health-modal";
  var BODY_ID = "system-health-body";
  var METRICS_URL = "/api/v2/admin/metrics";
  var REFRESH_MS = 30000;

  // Speed buckets, in p95 milliseconds. Tunable — these are judgement calls,
  // not server truth: "fast" feels instant, "slow" is worth a look.
  var FAST_MAX_MS = 200;
  var OK_MAX_MS = 600;

  // A screen is only called "slow" for the status banner once it has a few
  // calls behind it, so one cold-start request doesn't raise a false alarm.
  var SLOW_MIN_CALLS = 5;

  // How many screens to list in the table (busiest first). Firestore can have
  // 100+ distinct routes; the owner only needs the ones that matter.
  var MAX_ROWS = 12;

  // Rough Google Firestore price, USD per 100k document operations, converted
  // to INR. Deliberately approximate and clearly labelled in the UI — it is a
  // guide, not the actual bill, and only covers reads/writes since the last
  // restart. Update if Google's pricing or the rupee rate moves materially.
  var USD_PER_100K_READS = 0.036;
  var USD_PER_100K_WRITES = 0.108;
  var INR_PER_USD = 84;

  var _timer = null;

  // Friendly names for the raw, normalised route strings. Anything not listed
  // falls back to a tidied version of the path, so the table is never empty.
  var LABELS = {
    "/get_data": "Dashboard",
    "/get_bills": "Bills list",
    "/api/v2/bills": "Bills list",
    "/api/v2/dashboard": "Dashboard",
    "/checkout": "Checkout",
    "/checkin": "Check-in",
    "/add_bill_payment": "Bill payment",
    "/render_bill_pdf": "Bill PDF",
    "/get_customer": "Customer lookup",
    "/reports": "Reports",
    "/revenue_report": "Revenue report",
    "/reports/gstr1_summary": "GSTR-1 report",
    "/get_settlements": "Settle later",
    "/get_ota_settlements": "OTA settlements",
    "/renew_rent": "Renew stay",
    "/add_on": "Add-on charge",
    "/api/v2/admin/metrics": "System health"
  };

  function esc(s) {
    if (global.escHtml) return global.escHtml(s);
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function label(route) {
    if (LABELS[route]) return LABELS[route];
    var r = String(route || "").replace(/^\/+/, "").replace(/\/:id/g, "").replace(/[/_]+/g, " ").trim();
    if (!r) return "Home";
    return r.charAt(0).toUpperCase() + r.slice(1);
  }

  function num(n) {
    try { return Number(n || 0).toLocaleString("en-IN"); } catch (e) { return String(n || 0); } // eslint-disable-line no-unused-vars
  }

  function formatUptime(secs) {
    secs = Math.max(0, Math.floor(secs || 0));
    var d = Math.floor(secs / 86400);
    var h = Math.floor((secs % 86400) / 3600);
    var m = Math.floor((secs % 3600) / 60);
    if (d > 0) return d + "d " + h + "h";
    if (h > 0) return h + "h " + m + "m";
    return m + "m";
  }

  function speedBucket(p95) {
    if (p95 < FAST_MAX_MS) return "fast";
    if (p95 < OK_MAX_MS) return "ok";
    return "slow";
  }

  function estCostInr(reads, writes) {
    var usd = (reads / 100000) * USD_PER_100K_READS + (writes / 100000) * USD_PER_100K_WRITES;
    var inr = usd * INR_PER_USD;
    if (inr <= 0) return "₹0";
    if (inr < 1) return "≈ ₹" + inr.toFixed(2);
    return "≈ ₹" + Math.round(inr).toLocaleString("en-IN");
  }

  // Automated uptime/health probes (e.g. Cloud Monitoring hitting
  // /api/v2/health every few minutes from several regions) are not a staff
  // "screen". Excluded from this view so they can't masquerade as the busiest
  // screen or pad the table / totals.
  function isProbeRoute(route) {
    var p = String(route || "");
    return p === "/api/v2/health" || /\/(health|healthz|ready|readyz|livez)$/.test(p);
  }

  // Pure: snapshot -> everything the view needs. No DOM, no network — so the
  // interpretation is easy to reason about and test in isolation.
  function deriveInsights(snap) {
    var routes = ((snap && snap.routes) || []).filter(function (r) {
      return r && !isProbeRoute(r.route);
    });
    var totals = (snap && snap.totals) || { requests: 0, reads: 0, writes: 0 };

    var failedActions = 0;
    var busiest = null, heaviest = null, slowest = null;
    for (var i = 0; i < routes.length; i++) {
      var r = routes[i];
      failedActions += r.errors || 0;
      if (!busiest || r.count > busiest.count) busiest = r;
      if (!heaviest || r.reads > heaviest.reads) heaviest = r;
      if (!slowest || r.p95_ms > slowest.p95_ms) slowest = r;
    }

    var slowConcern = slowest && slowest.count >= SLOW_MIN_CALLS && slowest.p95_ms >= OK_MAX_MS
      ? slowest : null;

    var status;
    if (failedActions > 0) {
      status = {
        level: "bad", icon: "fa-exclamation-triangle",
        title: failedActions === 1 ? "1 action failed" : failedActions + " actions failed",
        sub: "Something went wrong since the last update. The table below shows where."
      };
    } else if (slowConcern) {
      status = {
        level: "warn", icon: "fa-clock",
        title: "Running, but one screen is slow",
        sub: "“" + label(slowConcern.route) + "” is slower than the rest. Everything else is fine."
      };
    } else {
      status = {
        level: "ok", icon: "fa-check",
        title: "Everything is running smoothly",
        sub: "No failures. Speeds are normal across every screen."
      };
    }

    var rows = routes.slice().sort(function (a, b) { return b.count - a.count; }).slice(0, MAX_ROWS);

    return {
      status: status,
      uptime_s: (snap && snap.uptime_s) || 0,
      failedActions: failedActions,
      requests: totals.requests || 0,
      reads: totals.reads || 0,
      writes: totals.writes || 0,
      costInr: estCostInr(totals.reads || 0, totals.writes || 0),
      busiest: busiest,
      heaviest: heaviest,
      slowest: slowest,
      rows: rows,
      shown: rows.length,
      total: routes.length
    };
  }

  function tile(labelTxt, value, cls, note) {
    return '<div class="sh-tile">' +
      '<div class="sh-tile-label">' + esc(labelTxt) + "</div>" +
      '<div class="sh-tile-val ' + (cls || "") + '">' + esc(value) + "</div>" +
      '<div class="sh-tile-note">' + esc(note) + "</div></div>";
  }

  function insightRow(variant, html) {
    return '<div class="sh-insight sh-insight--' + variant + '">' + html + "</div>";
  }

  function render(data) {
    var d = deriveInsights(data);

    var html = '<div class="sh-wrap">';

    html += '<div class="sh-banner sh-banner--' + d.status.level + '">' +
      '<span class="sh-banner-ico"><i class="fas ' + d.status.icon + '"></i></span>' +
      '<div><div class="sh-banner-title">' + esc(d.status.title) + "</div>" +
      '<div class="sh-banner-sub">' + esc(d.status.sub) + "</div></div></div>";

    html += '<div class="sh-tiles">';
    html += tile("Running without a restart", formatUptime(d.uptime_s), "", "Resets each time the app updates");
    html += tile("Failed actions", num(d.failedActions),
      d.failedActions > 0 ? "sh-bad" : "sh-good", "Anything above 0 is worth a look");
    html += tile("Things people did", num(d.requests), "", "Screens opened, bills, check-ins…");
    html += tile("Est. database cost so far", d.costInr, "", "Rough guide, since last restart");
    html += "</div>";

    var insights = "";
    if (d.busiest && d.busiest.count > 0) {
      insights += insightRow("blue",
        "<b>Busiest screen:</b> " + esc(label(d.busiest.route)) +
        " — opened " + num(d.busiest.count) + " times. This is where your staff spend their day.");
    }
    if (d.heaviest && d.heaviest.reads > 0) {
      insights += insightRow("amber",
        "<b>Heaviest on the database:</b> " + esc(label(d.heaviest.route)) +
        ". Using it a lot is what grows your Google bill.");
    }
    if (d.slowest && d.slowest.count > 0) {
      insights += insightRow(d.slowest.p95_ms >= OK_MAX_MS ? "red" : "blue",
        "<b>Slowest to open:</b> " + esc(label(d.slowest.route)) +
        " takes about " + (d.slowest.p95_ms >= 1000
          ? (d.slowest.p95_ms / 1000).toFixed(1) + "s"
          : Math.round(d.slowest.p95_ms) + "ms") + " at its slowest.");
    }
    if (insights) {
      html += '<div class="sh-section-title"><i class="fas fa-lightbulb" style="color:#d97706"></i> What this tells you</div>' +
        '<div class="sh-insights">' + insights + "</div>";
    }

    html += '<div class="sh-section-title">Every screen, busiest first</div>';
    html += '<div class="sh-table">' +
      '<div class="sh-trow sh-thead"><div>Screen</div>' +
      '<div class="sh-tr-right">Times used</div>' +
      '<div class="sh-tr-right">Speed</div>' +
      '<div class="sh-tr-right">Failures</div></div>';
    for (var i = 0; i < d.rows.length; i++) {
      var r = d.rows[i];
      var b = speedBucket(r.p95_ms);
      var badge = b === "fast" ? "Fast" : (b === "ok" ? "OK" : "Slow");
      var fails = r.errors || 0;
      html += '<div class="sh-trow"><div>' + esc(label(r.route)) + "</div>" +
        '<div class="sh-tr-right">' + num(r.count) + "</div>" +
        '<div class="sh-tr-right"><span class="sh-badge sh-badge--' + b + '">' + badge + "</span></div>" +
        '<div class="sh-tr-right ' + (fails > 0 ? "sh-fail-n" : "sh-fail-0") + '">' + num(fails) + "</div></div>";
    }
    html += "</div>";

    if (d.total > d.shown) {
      html += '<div class="sh-tile-note" style="text-align:center">Showing the ' +
        d.shown + " busiest of " + d.total + " screens.</div>";
    }

    html += '<div class="sh-foot">All figures are since the app last updated (' +
      formatUptime(d.uptime_s) + " ago), not all-time. This page is read-only — " +
      "nothing here can change a bill or any data.</div>";

    html += "</div>";

    var body = document.getElementById(BODY_ID);
    if (body) body.innerHTML = html;
  }

  function showState(iconClass, message, withRetry) {
    var body = document.getElementById(BODY_ID);
    if (!body) return;
    body.innerHTML = '<div class="sh-state"><i class="fas ' + iconClass + '"></i>' +
      esc(message) +
      (withRetry ? '<div><button class="sh-retry" onclick="window.CibaraSystemHealth && window.CibaraSystemHealth.refresh();">Try again</button></div>' : "") +
      "</div>";
  }

  function fetchAndRender() {
    var btn = document.querySelector("#" + MODAL_ID + " .sh-refresh");
    if (btn) btn.classList.add("sh-spin");

    var fetcher = global.apiFetch || global.fetch;
    fetcher(METRICS_URL, { headers: { Accept: "application/json" } })
      .then(function (res) {
        if (res.status === 401 || res.status === 403) {
          showState("fa-lock", "System health is available to admins only.", false);
          return null;
        }
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        if (data.success === false) throw new Error(data.message || "Failed to load");
        render(data);
      })
      .catch(function (err) {
        if (global.console) console.warn("[system-health] load failed:", err);
        showState("fa-wifi", "Couldn't load right now.", true);
      })
      .then(function () {
        if (btn) btn.classList.remove("sh-spin");
      });
  }

  function open() {
    var modal = document.getElementById(MODAL_ID);
    if (!modal) return;
    // Stack the health sheet on top of Settings (higher z-index). "Back" just
    // hides it and reveals Settings underneath, already unlocked — no second
    // manager-password prompt.
    modal.classList.add("show");
    showState("fa-spinner fa-spin", "Loading…", false);
    fetchAndRender();
    if (_timer) clearInterval(_timer);
    _timer = setInterval(fetchAndRender, REFRESH_MS);
  }

  function close() {
    var modal = document.getElementById(MODAL_ID);
    if (modal) modal.classList.remove("show");
    if (_timer) { clearInterval(_timer); _timer = null; }
  }

  function refresh() {
    fetchAndRender();
  }

  global.CibaraSystemHealth = {
    open: open,
    close: close,
    refresh: refresh,
    deriveInsights: deriveInsights
  };
})(window);
