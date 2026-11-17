// First-party website analytics for the classic UI.
//
// Adds a "Website" view beside Analytics / Reports. Reads the same date
// pickers, calls GET /analytics/web (the aggregator fed by the website's
// /web/event ingest), and renders visitors / page views / clicks plus ranked
// breakdowns and a daily traffic chart. Self-contained (inline styles,
// Chart.js, the global apiFetch) so it adds nothing the rest of the screen
// has to know about.
(function () {
  "use strict";

  let loaded = false; // has the Website view been opened at least once

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function num(n) {
    return Math.round(n || 0).toLocaleString("en-IN");
  }

  function kpis(t) {
    function cell(accent, icon, label, value, sub) {
      return (
        '<div style="background:#fff;border:1px solid #eef0f3;border-radius:14px;padding:14px 16px;border-left:4px solid ' +
        accent +
        '"><div style="display:flex;align-items:center;gap:8px;color:#64748b;font-size:.8rem"><i class="' +
        icon +
        '"></i>' +
        label +
        '</div><div style="font-size:1.6rem;font-weight:800;margin-top:4px">' +
        value +
        "</div>" +
        (sub ? '<div style="font-size:.75rem;color:#8a8a8a;margin-top:2px">' + sub + "</div>" : "") +
        "</div>"
      );
    }
    return (
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px">' +
      cell("#2563eb", "fas fa-users", "Visitors", num(t.visitors), "Unique browsers") +
      cell("#0891b2", "fas fa-eye", "Page views", num(t.page_views), "") +
      cell("#16a34a", "fas fa-hand-pointer", "Clicks &amp; enquiries", num(t.clicks), "WhatsApp, call, book…") +
      cell("#ea580c", "fas fa-calendar-check", "Paid bookings", num(t.bookings), "Confirmed &amp; paid online") +
      cell("#15803d", "fas fa-rupee-sign", "Revenue", "₹" + num(t.revenue), "Paid online from the website") +
      cell("#7c3aed", "fas fa-bolt", "Events total", num(t.events), "") +
      "</div>"
    );
  }

  function card(title, body) {
    return (
      '<div style="background:#fff;border:1px solid #eef0f3;border-radius:14px;padding:16px;margin-top:12px">' +
      '<div style="font-weight:700;margin-bottom:10px">' +
      esc(title) +
      "</div>" +
      body +
      "</div>"
    );
  }

  function ranked(title, rows) {
    rows = rows || [];
    var max = rows.reduce(function (m, r) {
      return Math.max(m, r.value || 0);
    }, 0) || 1;
    var body = rows.length
      ? rows
          .map(function (r) {
            var pct = max ? (r.value / max) * 100 : 0;
            return (
              '<div style="margin:6px 0"><div style="display:flex;justify-content:space-between;gap:10px;font-size:.85rem">' +
              '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' +
              esc(r.name) +
              '">' +
              esc(r.name) +
              '</span><span style="font-weight:600;color:#475569">' +
              num(r.value) +
              "</span></div>" +
              '<div style="height:6px;background:#eef2f7;border-radius:4px;overflow:hidden;margin-top:3px">' +
              '<div style="height:100%;border-radius:4px;background:#2563eb;width:' +
              pct +
              '%"></div></div></div>'
            );
          })
          .join("")
      : '<div style="color:#8a8a8a;font-size:.85rem;padding:.5rem 0">No data.</div>';
    return card(title, body);
  }

  function drawTraffic(daily) {
    var canvas = document.getElementById("web-traffic-chart");
    if (!canvas || typeof Chart === "undefined") return;
    if (canvas.chart) canvas.chart.destroy();
    var labels = daily.map(function (x) {
      var p = String(x.day).split("-");
      return p.length === 3 ? p[2] + "/" + p[1] : x.day;
    });
    canvas.chart = new Chart(canvas.getContext("2d"), {
      data: {
        labels: labels,
        datasets: [
          {
            type: "bar",
            label: "Page views",
            data: daily.map(function (x) { return x.views || 0; }),
            backgroundColor: "rgba(37,99,235,.7)",
            borderColor: "#2563eb",
            borderWidth: 1,
          },
          {
            type: "line",
            label: "Visitors",
            data: daily.map(function (x) { return x.visitors || 0; }),
            borderColor: "#f59e0b",
            backgroundColor: "rgba(245,158,11,.1)",
            tension: 0.3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { position: "top" } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
      },
    });
  }

  function render(view, d) {
    var daily = d.daily || [];
    view.innerHTML =
      kpis(d.totals || {}) +
      card("Traffic by day", '<div style="height:280px"><canvas id="web-traffic-chart"></canvas></div>') +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin-top:12px">' +
      ranked("Top pages", d.top_pages) +
      ranked("Rooms viewed / clicked", d.by_room) +
      ranked("Clicks by type", d.by_event) +
      ranked("Devices", d.by_device) +
      ranked("Countries", d.by_country) +
      ranked("Cities", d.by_city) +
      ranked("Referrers", d.by_referrer) +
      "</div>";
    drawTraffic(daily);
  }

  async function loadWebAnalytics() {
    var view = document.getElementById("website-view");
    var start = (document.getElementById("report-start-date") || {}).value;
    var end = (document.getElementById("report-end-date") || {}).value;
    if (!view || !start || !end) return;
    view.innerHTML = '<div style="padding:2rem;text-align:center;color:#8a8a8a">Loading website analytics…</div>';

    var data = null;
    try {
      var resp = await apiFetch(
        "/analytics/web?from=" + encodeURIComponent(start) + "&to=" + encodeURIComponent(end),
        { method: "GET" }
      );
      if (resp.ok) {
        var d = await resp.json();
        if (d && d.success !== false) data = d;
      }
    } catch (e) {
      console.warn("Website analytics unavailable:", e);
    }

    if (!data) {
      view.innerHTML =
        '<div style="padding:2rem;text-align:center;color:#b91c1c">Website analytics couldn’t load — you need the analytics permission, or there is no data for this range yet.</div>';
      return;
    }
    render(view, data);
  }

  function init() {
    document.querySelectorAll('.view-btn[data-view="website"]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        loaded = true;
        loadWebAnalytics();
      });
    });
    // Re-run on Generate when the Website view is the one on screen.
    var apply = document.getElementById("apply-report-filter");
    if (apply) {
      apply.addEventListener("click", function () {
        var v = document.getElementById("website-view");
        if (loaded && v && !v.classList.contains("hidden")) setTimeout(loadWebAnalytics, 0);
      });
    }
  }

  if (document.readyState !== "loading") init();
  else document.addEventListener("DOMContentLoaded", init);
})();
