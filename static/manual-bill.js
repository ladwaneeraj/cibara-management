/* ────────────────────────────────────────────────────────────────────────────
 * Manual bill — operator-authored ("serial-wise generated") bill.
 *
 * A button in the Register toolbar opens a mobile-first modal where an admin
 * enters check-in date, check-out time, room, tariff, guest name/number and
 * one or more dated payment rows. POSTs to /manual_bill/create, which builds a
 * REAL bill (serial, GST, totals, sequential number) exactly like a checkout,
 * so it lands in the register, transactions and reports on the chosen dates.
 * Admin-only (button gated on payment.edit; server enforces it too).
 * ──────────────────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  var _busy = false;

  function $(id) { return document.getElementById(id); }
  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function rup(n) { return "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN"); }
  function notify(msg, kind) {
    if (typeof showNotification === "function") showNotification(msg, kind);
    else if (kind === "error") alert(msg);
  }
  function ymd(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
      "-" + String(d.getDate()).padStart(2, "0");
  }
  function todayStr() { return ymd(new Date()); }
  function yesterdayStr() {
    var d = new Date();
    d.setDate(d.getDate() - 1);
    return ymd(d);
  }
  function canManage() {
    return !!(window.CibaraAuth &&
      typeof window.CibaraAuth.userCan === "function" &&
      window.CibaraAuth.userCan("payment.edit"));
  }

  var _payRowSeq = 0;
  function payRowHtml(preset) {
    preset = preset || {};
    var id = "mb-pay-" + (++_payRowSeq);
    return (
      '<div class="mb-payrow" data-row="' + id + '">' +
      '<input type="date" class="mb-pay-date" value="' + esc(preset.date || todayStr()) + '" max="' + todayStr() + '">' +
      '<input type="number" class="mb-pay-amt" min="1" inputmode="numeric" placeholder="Amount ₹" value="' + esc(preset.amount || "") + '">' +
      '<select class="mb-pay-method">' +
      '<option value="cash">Cash</option>' +
      '<option value="online">Online</option>' +
      "</select>" +
      '<button type="button" class="mb-pay-del" title="Remove"><i class="fas fa-times"></i></button>' +
      "</div>"
    );
  }

  function open() {
    if (!canManage()) { notify("Manual bills are admin-only", "error"); return; }
    var ov = $("mb-overlay");
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "mb-overlay";
      ov.innerHTML = '<div class="mb-sheet" id="mb-sheet" role="dialog" aria-modal="true"></div>';
      document.body.appendChild(ov);
      ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    }
    ov.classList.add("show");
    document.body.style.overflow = "hidden";
    render();
  }
  function close() {
    var ov = $("mb-overlay");
    if (ov) ov.classList.remove("show");
    document.body.style.overflow = "";
  }

  function render() {
    var t = todayStr();
    $("mb-sheet").innerHTML =
      '<div class="mb-hdr"><div class="mb-grab"></div>' +
      '<h3><i class="fas fa-file-invoice-dollar"></i> Manual bill</h3>' +
      '<button type="button" class="mb-x" id="mb-x"><i class="fas fa-times"></i></button></div>' +
      '<div class="mb-body">' +
      '<p class="mb-note"><i class="fas fa-info-circle"></i> Creates a real bill (serial, GST &amp; totals) on the dates you choose. It shows in the register, transactions and reports — it does not change today\'s live cash counter.</p>' +

      '<div class="mb-grid">' +
      '<label class="mb-field mb-col2"><span>Guest name *</span>' +
      '<input type="text" id="mb-name" autocomplete="off" placeholder="Full name"></label>' +
      '<label class="mb-field"><span>Mobile</span>' +
      '<input type="tel" id="mb-mobile" inputmode="numeric" placeholder="10-digit"></label>' +
      '<label class="mb-field"><span>Room *</span>' +
      '<input type="text" id="mb-room" placeholder="e.g. 101"></label>' +

      '<label class="mb-field"><span>Check-in date *</span>' +
      '<input type="date" id="mb-ci-date" max="' + t + '"></label>' +
      '<label class="mb-field"><span>Check-in time</span>' +
      '<input type="time" id="mb-ci-time" value="12:00"></label>' +
      '<label class="mb-field"><span>Check-out date *</span>' +
      '<input type="date" id="mb-co-date" max="' + t + '"></label>' +
      '<label class="mb-field"><span>Check-out time</span>' +
      '<input type="time" id="mb-co-time" value="11:00"></label>' +

      '<label class="mb-field"><span>Price / night (₹) *</span>' +
      '<input type="number" id="mb-price" min="1" inputmode="numeric" placeholder="0"></label>' +
      '<label class="mb-field"><span>Persons</span>' +
      '<input type="number" id="mb-guests" min="1" value="1"></label>' +
      '<label class="mb-check"><input type="checkbox" id="mb-ac"> AC room</label>' +
      '<label class="mb-check mb-col2"><input type="checkbox" id="mb-genbill" checked> Generate bill number (GST invoice)</label>' +
      "</div>" +

      '<div class="mb-calc" id="mb-calc"></div>' +

      '<div class="mb-sec">Payments <small>(add the dates money was received — leave empty for an unpaid stay)</small></div>' +
      '<div id="mb-payrows"></div>' +
      '<button type="button" class="mb-add-pay" id="mb-add-pay"><i class="fas fa-plus"></i> Add payment</button>' +
      '<div class="mb-balance" id="mb-balance"></div>' +

      '<button type="button" class="mb-submit" id="mb-submit"><i class="fas fa-check"></i> Create bill</button>' +
      "</div>";

    // Default to a 1-night past stay: check-in yesterday, check-out today
    // (both ≤ today, so the default state is always valid).
    var y = yesterdayStr();
    $("mb-ci-date").value = y;
    $("mb-co-date").value = t;
    // One payment row prefilled, dated at check-in
    $("mb-payrows").innerHTML = payRowHtml({ date: y });

    $("mb-x").addEventListener("click", close);
    $("mb-add-pay").addEventListener("click", function () {
      $("mb-payrows").insertAdjacentHTML("beforeend", payRowHtml({ date: $("mb-co-date").value }));
      recalc();
    });
    $("mb-payrows").addEventListener("click", function (e) {
      var del = e.target.closest(".mb-pay-del");
      if (del) { del.closest(".mb-payrow").remove(); recalc(); }
    });
    ["mb-price", "mb-ci-date", "mb-co-date"].forEach(function (id) {
      $(id).addEventListener("input", recalc);
    });
    $("mb-payrows").addEventListener("input", recalc);
    $("mb-submit").addEventListener("click", submit);
    recalc();
  }

  function nights() {
    var ci = $("mb-ci-date").value, co = $("mb-co-date").value;
    if (!ci || !co) return 0;
    var a = new Date(ci + "T00:00:00"), b = new Date(co + "T00:00:00");
    var d = Math.round((b - a) / 86400000);
    return Math.max(1, isNaN(d) ? 1 : d);
  }
  function paidTotal() {
    var sum = 0;
    document.querySelectorAll("#mb-payrows .mb-payrow").forEach(function (r) {
      sum += parseInt(r.querySelector(".mb-pay-amt").value, 10) || 0;
    });
    return sum;
  }

  function recalc() {
    var price = parseInt($("mb-price").value, 10) || 0;
    var n = nights();
    var roomCharges = price * n;
    var calc = $("mb-calc");
    if (calc) {
      calc.innerHTML = price > 0
        ? "<span>" + n + " night" + (n !== 1 ? "s" : "") + " × " + rup(price) +
          "</span><b>Room charges " + rup(roomCharges) + "</b>" +
          "<small>GST is computed by slab on save</small>"
        : "";
    }
    var bal = $("mb-balance");
    if (bal) {
      var paid = paidTotal();
      var balance = roomCharges - paid;
      bal.innerHTML =
        "<span>Paid " + rup(paid) + "</span>" +
        '<span class="' + (balance > 0 ? "mb-due" : "mb-clear") + '">Balance ' +
        (balance < 0 ? "−" : "") + rup(Math.abs(balance)) + "</span>";
    }
  }

  function submit() {
    if (_busy) return;
    var payments = [];
    var bad = false;
    document.querySelectorAll("#mb-payrows .mb-payrow").forEach(function (r) {
      var amt = parseInt(r.querySelector(".mb-pay-amt").value, 10) || 0;
      var date = r.querySelector(".mb-pay-date").value;
      var method = r.querySelector(".mb-pay-method").value;
      if (amt > 0) {
        if (!date) bad = true;
        payments.push({ amount: amt, method: method, date: date });
      }
    });
    if (bad) { notify("Every payment needs a date", "error"); return; }

    var body = {
      guest_name: $("mb-name").value.trim(),
      guest_mobile: $("mb-mobile").value.trim(),
      room: $("mb-room").value.trim(),
      guest_count: parseInt($("mb-guests").value, 10) || 1,
      is_ac: $("mb-ac").checked,
      generate_bill_number: $("mb-genbill") ? $("mb-genbill").checked : true,
      room_price: parseInt($("mb-price").value, 10) || 0,
      checkin_date: $("mb-ci-date").value,
      checkin_time: $("mb-ci-time").value || "12:00",
      checkout_date: $("mb-co-date").value,
      checkout_time: $("mb-co-time").value || "11:00",
      payments: payments,
    };
    if (!body.guest_name) return notify("Enter the guest name", "error");
    if (!body.room) return notify("Enter the room number", "error");
    if (body.room_price <= 0) return notify("Enter the price per night", "error");
    if (!body.checkin_date || !body.checkout_date) return notify("Pick check-in and check-out dates", "error");

    _busy = true;
    var btn = $("mb-submit");
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating…';
    apiFetch("/manual_bill/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json(); })
      .then(function (resp) {
        _busy = false;
        if (resp && resp.success) {
          notify(resp.message || "Manual bill created", "success");
          close();
          // Jump the register to the check-in date so the new row is visible,
          // then reload.
          try {
            var si = $("start-date"), ei = $("end-date");
            if (si && ei) { si.value = body.checkin_date; ei.value = body.checkin_date; }
          } catch (e) { /* ignore */ }
          if (typeof window.reloadRegister === "function") window.reloadRegister();
          if (typeof window.refreshTransactionsView === "function") window.refreshTransactionsView();
        } else {
          notify((resp && resp.message) || "Could not create bill", "error");
          btn.disabled = false;
          btn.innerHTML = '<i class="fas fa-check"></i> Create bill';
        }
      })
      .catch(function (e) {
        _busy = false;
        notify("Error: " + e.message, "error");
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-check"></i> Create bill';
      });
  }

  // The register toolbar is built dynamically by register.js (buildHTML),
  // which renders the button with an inline onclick calling this global.
  // Exposing it here means we don't depend on the button existing at
  // DOMContentLoaded. A direct listener is also attached as a fallback for
  // any static button that happens to be present.
  window.openManualBill = open;
  document.addEventListener("DOMContentLoaded", function () {
    var btn = $("manual-bill-btn");
    if (btn && !btn.getAttribute("onclick")) btn.addEventListener("click", open);
  });
})();
