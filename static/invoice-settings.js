/* ─────────────────────────────────────────────────────────────────────────
 * Settings → Invoice & payments (admins, settings.update).
 *
 * Edits what prints on every invoice without a deploy:
 *   - logo, authorised signature, static UPI QR image (PNG/JPEG ≤ 2 MB)
 *   - UPI ID + payee (a QR with the exact amount due is printed when set;
 *     the uploaded QR image is used only when no UPI ID is set)
 *   - contact e-mail / website, signatory label, thank-you line, terms
 * Backend: /api/v2/settings/invoice (backend/cibara_api/routers/invoice_settings.py).
 * Self-contained: builds its own dialog, like the dialogs in auth.js.
 * ──────────────────────────────────────────────────────────────────── */
(function () {
  "use strict";
  const API = "/api/v2/settings/invoice";
  const KINDS = [
    ["logo", "Logo", "Shown at the top left of every invoice."],
    ["signature", "Authorised signature", "Printed above “Authorised Signatory”. Use a transparent PNG if you can."],
    ["upi_qr", "UPI QR image", "Used only when no UPI ID is set below (it cannot carry the amount)."],
  ];

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  async function jsonOrThrow(r) {
    let b = {};
    try { b = await r.json(); } catch (_) { /* empty */ }
    if (!r.ok || b.success === false) {
      const d = b.detail;
      throw new Error(b.message || (typeof d === "string" ? d : (d && d[0] && d[0].msg)) || ("Request failed (" + r.status + ")"));
    }
    return b;
  }

  const S = "font:400 .88rem inherit;width:100%;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;box-sizing:border-box";
  const L = "display:block;font-size:.7rem;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.04em;margin:10px 0 4px";

  function imageBlock(kind, label, hint) {
    return '<div style="display:flex;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid #f1f5f9">' +
      '<div data-prev="' + kind + '" style="width:96px;height:56px;border:1px dashed #cbd5e1;border-radius:8px;display:grid;place-items:center;overflow:hidden;background:#f8fafc;color:#94a3b8;font-size:.72rem;flex-shrink:0">None</div>' +
      '<div style="flex:1;min-width:0"><div style="font-weight:600;font-size:.88rem">' + label + '</div>' +
      '<div style="font-size:.75rem;color:#64748b">' + hint + "</div>" +
      '<div style="display:flex;gap:6px;margin-top:6px">' +
      '<label style="padding:5px 10px;border:1px solid #cbd5e1;border-radius:7px;font-size:.78rem;font-weight:600;cursor:pointer">Upload' +
      '<input type="file" accept="image/png,image/jpeg" data-up="' + kind + '" style="display:none"></label>' +
      '<button type="button" data-rm="' + kind + '" style="padding:5px 10px;border:1px solid #fecaca;color:#b91c1c;background:#fff;border-radius:7px;font-size:.78rem;font-weight:600;cursor:pointer">Remove</button>' +
      "</div></div></div>";
  }

  async function open() {
    const old = document.getElementById("inv-set-modal");
    if (old) old.remove();
    const wrap = document.createElement("div");
    wrap.id = "inv-set-modal";
    wrap.setAttribute("style", "position:fixed;inset:0;z-index:100000;display:grid;place-items:center;background:rgba(15,23,42,.55);padding:16px;font-family:inherit");
    wrap.innerHTML =
      '<div role="dialog" aria-modal="true" aria-labelledby="inv-set-title" style="width:100%;max-width:560px;max-height:92vh;overflow:auto;background:#fff;color:#1e293b;border-radius:14px;box-shadow:0 25px 50px -12px rgba(0,0,0,.4)">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;padding:16px 18px;border-bottom:1px solid #e2e8f0">' +
      '<h3 id="inv-set-title" style="margin:0;font-size:1.05rem">Invoice &amp; payments</h3>' +
      '<button type="button" data-close aria-label="Close" style="border:0;background:none;font-size:22px;cursor:pointer;color:#64748b">&times;</button></div>' +
      '<div style="padding:4px 18px 8px">' + KINDS.map(function (k) { return imageBlock(k[0], k[1], k[2]); }).join("") +
      '<label style="' + L + '" for="inv-vpa">UPI ID (prints a QR with the exact amount due)</label>' +
      '<input id="inv-vpa" style="' + S + '" placeholder="e.g. cibaracomforts@okaxis" autocomplete="off">' +
      '<label style="' + L + '" for="inv-payee">UPI payee name</label><input id="inv-payee" style="' + S + '" maxlength="60">' +
      '<div style="display:flex;gap:10px"><div style="flex:1"><label style="' + L + '" for="inv-email">E-mail on invoice</label><input id="inv-email" style="' + S + '" maxlength="120"></div>' +
      '<div style="flex:1"><label style="' + L + '" for="inv-web">Website</label><input id="inv-web" style="' + S + '" maxlength="120"></div></div>' +
      '<label style="' + L + '" for="inv-sign">Signatory label</label><input id="inv-sign" style="' + S + '" maxlength="60" placeholder="Authorised Signatory">' +
      '<label style="' + L + '" for="inv-thanks">Thank-you line</label><input id="inv-thanks" style="' + S + '" maxlength="200">' +
      '<label style="' + L + '" for="inv-terms">Terms &amp; conditions (one per line, up to 10)</label><textarea id="inv-terms" rows="4" style="' + S + ';resize:vertical"></textarea>' +
      '<div id="inv-set-err" role="alert" hidden style="margin-top:10px;padding:8px 10px;font-size:.82rem;color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;border-radius:8px"></div>' +
      '<div id="inv-set-ok" hidden style="margin-top:10px;padding:8px 10px;font-size:.82rem;color:#166534;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px"></div>' +
      "</div>" +
      '<div style="display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid #e2e8f0;background:#f8fafc;border-radius:0 0 14px 14px">' +
      '<button type="button" data-close style="padding:8px 14px;border:1px solid #cbd5e1;background:#fff;border-radius:8px;font-weight:600;cursor:pointer">Close</button>' +
      '<button type="button" id="inv-set-save" style="padding:8px 14px;border:0;background:#2449d8;color:#fff;border-radius:8px;font-weight:600;cursor:pointer">Save</button></div></div>';
    document.body.appendChild(wrap);

    const $ = function (id) { return wrap.querySelector("#" + id); };
    const err = $("inv-set-err"), ok = $("inv-set-ok");
    function msg(e, o) {
      err.hidden = !e; err.textContent = e || "";
      ok.hidden = !o; ok.textContent = o || "";
    }
    function close() { wrap.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    wrap.addEventListener("click", function (e) { if (e.target === wrap || e.target.hasAttribute("data-close")) close(); });

    async function preview(kind, isSet) {
      const box = wrap.querySelector('[data-prev="' + kind + '"]');
      if (!isSet) { box.textContent = "None"; return; }
      try {
        const r = await fetch(API + "/images/" + kind + "?t=" + Date.now());
        if (!r.ok) throw new Error();
        const url = URL.createObjectURL(await r.blob());
        box.innerHTML = '<img alt="" style="max-width:100%;max-height:100%" src="' + url + '">';
      } catch (_) { box.textContent = "Saved"; }
    }

    function fillImages(data) {
      KINDS.forEach(function (k) { preview(k[0], data.images && data.images[k[0]] && data.images[k[0]].set); });
    }

    function fill(data) {
      const s = data.settings || {};
      $("inv-vpa").value = s.upi_vpa || "";
      $("inv-payee").value = s.upi_payee_name || "";
      $("inv-email").value = s.email || "";
      $("inv-web").value = s.website || "";
      $("inv-sign").value = s.signatory_label || "";
      $("inv-thanks").value = s.thank_you || "";
      $("inv-terms").value = (s.terms || []).join("\n");
      KINDS.forEach(function (k) { preview(k[0], data.images && data.images[k[0]] && data.images[k[0]].set); });
    }

    try {
      fill(await jsonOrThrow(await fetch(API)));
    } catch (e) {
      msg(e.message);
    }

    $("inv-set-save").addEventListener("click", async function () {
      msg();
      const btn = this;
      btn.disabled = true; btn.textContent = "Saving…";
      try {
        const body = {
          upi_vpa: $("inv-vpa").value.trim(), upi_payee_name: $("inv-payee").value.trim(),
          email: $("inv-email").value.trim(), website: $("inv-web").value.trim(),
          signatory_label: $("inv-sign").value.trim(), thank_you: $("inv-thanks").value.trim(),
          terms: $("inv-terms").value.split("\n").map(function (t) { return t.trim(); }).filter(Boolean).slice(0, 10),
        };
        fill(await jsonOrThrow(await fetch(API, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        })));
        msg(null, "Saved. New and regenerated invoice PDFs will use these settings.");
      } catch (e) {
        msg(e.message);
      } finally {
        btn.disabled = false; btn.textContent = "Save";
      }
    });

    wrap.querySelectorAll("[data-up]").forEach(function (input) {
      input.addEventListener("change", async function () {
        const f = input.files && input.files[0];
        input.value = "";
        if (!f) return;
        msg();
        if (f.size > 2 * 1024 * 1024) { msg("Image must be 2 MB or smaller."); return; }
        const fd = new FormData();
        fd.append("file", f, f.name);
        try {
          // images only: keep any unsaved text edits in the form
          fillImages(await jsonOrThrow(await fetch(API + "/images/" + input.getAttribute("data-up"), { method: "POST", body: fd })));
          msg(null, "Image saved.");
        } catch (e) { msg(e.message); }
      });
    });
    wrap.querySelectorAll("[data-rm]").forEach(function (b) {
      b.addEventListener("click", async function () {
        msg();
        try {
          fillImages(await jsonOrThrow(await fetch(API + "/images/" + b.getAttribute("data-rm"), { method: "DELETE" })));
          msg(null, "Image removed.");
        } catch (e) { msg(e.message); }
      });
    });
    setTimeout(function () { $("inv-vpa").focus(); }, 50);
  }

  window.CibaraInvoiceSettings = { open: open, _esc: esc };
})();
