"""
Tax invoice v2 — layout only.

What a Rule 46 (CGST Rules, 2017) tax invoice must carry, and where it is here:

  (a) supplier name, address, GSTIN ............ header (routes.billing.SUPPLIER_*)
  (b) serial number, ≤16 chars, unique per FY .. "Invoice No" (CC/YYYY/MM/NNNNN, 16 chars)
  (c) date of issue ............................ "Invoice Date" (checkout time)
  (d) recipient name/address/GSTIN if registered "Billed to" (B2B block)
  (e) unregistered, value ≥ ₹50,000: name, address, state .. "Billed to" prints the
      captured address/state for any bill that has them
  (f)(g)(h) HSN/SAC, description, quantity ..... particulars table
  (i)(j) total value, taxable value after discount .. tax table + totals
  (k)(l) rate and amount of CGST/SGST(/IGST) ... tax table
  (m) place of supply + state (inter-state) .... "Place of Supply: Karnataka (29)"
  (o) reverse charge ........................... "Reverse Charge: No"
  (q) signature / digital signature ............ signature block (image if provided)

Money is never recomputed here:
  * the payable total is the stored `total_amount`;
  * the tax table is `config.bill_tax_breakup(bill)` — the same rows the
    GSTR-1 export files;
  * particulars are the stored folio / services figures (GST-inclusive, as
    charged), grouped exactly like the legacy renderer's consolidated and
    detailed views (`routes.billing._group_folio`, `_resolve_view_mode`).
If those three ever disagree by a paisa, a visible Round-off / Adjustment line
makes the document foot instead of hiding the gap (and it is logged).

Document title (INVOICE_TITLE_RULE):
  "by_supply" (default) — all supplies taxable → TAX INVOICE; all exempt →
      BILL OF SUPPLY (Rule 49); mixed to an unregistered guest →
      INVOICE-CUM-BILL OF SUPPLY (Rule 46A); mixed to a registered recipient →
      TAX INVOICE with exempt lines marked.
  "tax_invoice" — always TAX INVOICE (the legacy behaviour).
Confirm the rule with your CA; it changes only the heading.
"""
from __future__ import annotations

import base64
import html as _html
import io
import json
import logging
import os
import re
import urllib.parse
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("cibara_api.invoice")

_HERE = Path(__file__).resolve().parent
FONT_DIR = _HERE / "fonts"
BRAND_DIR = Path(os.environ.get("INVOICE_BRAND_DIR") or (_HERE / "brand"))
MARKER = 'data-layout="v2"'


# ── small helpers ──────────────────────────────────────────────────────────

def _f(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _e(v) -> str:
    """Escape text that came from a person (guest names, items, addresses)."""
    return _html.escape(str(v if v is not None else ""), quote=True)


def inr(v: float) -> str:
    """12345678.5 → '1,23,45,678.50' (Indian digit grouping)."""
    v = round(_f(v), 2)
    neg = v < 0
    whole, frac = f"{abs(v):.2f}".split(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        head = re.sub(r"(\d)(?=(\d{2})+$)", r"\1,", head)
        whole = f"{head},{tail}"
    return f"{'-' if neg else ''}{whole}.{frac}"


_ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
         "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen",
         "Eighteen", "Nineteen"]
_TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]


def _two(n: int) -> str:
    return _ONES[n] if n < 20 else (_TENS[n // 10] + (" " + _ONES[n % 10] if n % 10 else ""))


def _three(n: int) -> str:
    h, r = divmod(n, 100)
    parts = []
    if h:
        parts.append(_ONES[h] + " Hundred")
    if r:
        parts.append(_two(r))
    return " ".join(parts)


def _indian_words(n: int) -> str:
    if n == 0:
        return "Zero"
    out = []
    crore, n = divmod(n, 10_000_000)
    lakh, n = divmod(n, 100_000)
    thousand, n = divmod(n, 1000)
    if crore:
        out.append(_indian_words(crore) + " Crore")
    if lakh:
        out.append(_two(lakh) + " Lakh")
    if thousand:
        out.append(_two(thousand) + " Thousand")
    if n:
        out.append(_three(n))
    return " ".join(out)


def amount_in_words(amount: float) -> str:
    """1234.5 → 'Rupees One Thousand Two Hundred Thirty Four and Fifty Paise Only'."""
    amount = round(abs(_f(amount)), 2)
    rupees = int(amount)
    paise = int(round((amount - rupees) * 100))
    if paise == 100:
        rupees, paise = rupees + 1, 0
    words = f"Rupees {_indian_words(rupees)}"
    if paise:
        words += f" and {_two(paise)} Paise"
    return words + " Only"


def _fmt_dt(s) -> str:
    from routes.billing import _fmt_bill_dt
    try:
        return _fmt_bill_dt(s) if s else "-"
    except Exception:
        return str(s or "-")


# ── branding ───────────────────────────────────────────────────────────────

# Invoice settings live in Firestore (settings/invoice_branding, editable by an
# admin in Settings → Invoice & payments) with images in Storage
# (branding/<kind>.png). branding.json and env vars are the defaults under them.
SETTINGS_DOC = ("settings", "invoice_branding")
IMAGE_KINDS = ("logo", "signature", "upi_qr")
_BRAND_TTL = 300.0
_brand_cache: dict = {}


def _settings_doc() -> dict:
    try:
        import config as C
        snap = C.db.collection(SETTINGS_DOC[0]).document(SETTINGS_DOC[1]).get()
        return (snap.to_dict() or {}) if snap.exists else {}
    except Exception as e:
        log.warning("invoice settings unreadable (%s) — using defaults", e)
        return {}


def _storage_image(path: str) -> str:
    try:
        from firebase_admin import storage as fb_storage
        data = fb_storage.bucket().blob(path).download_as_bytes()
        return "data:image/png;base64," + base64.b64encode(data).decode()
    except Exception as e:
        log.warning("invoice image %s unavailable: %s", path, e)
        return ""


def branding() -> dict:
    """Effective invoice branding: settings doc > env vars > branding.json.
    Cached for 5 minutes; saving settings calls branding.cache_clear()."""
    import time
    hit = _brand_cache.get("v")
    if hit and time.monotonic() - hit[0] < _BRAND_TTL:
        return hit[1]
    data: dict = {}
    p = BRAND_DIR / "branding.json"
    try:
        data = json.loads(p.read_text("utf-8"))
    except FileNotFoundError:
        pass
    except Exception as e:  # never break an invoice on a bad config file
        log.warning("branding.json unreadable (%s) — using defaults", e)
    upi = dict(data.get("upi") or {})
    if os.environ.get("UPI_VPA"):
        upi["vpa"] = os.environ["UPI_VPA"].strip()
    if os.environ.get("UPI_PAYEE_NAME"):
        upi["payee_name"] = os.environ["UPI_PAYEE_NAME"].strip()
    doc = _settings_doc()
    for k in ("email", "website", "thank_you", "signatory_label"):
        if doc.get(k):
            data[k] = doc[k]
    if doc.get("terms"):
        data["terms"] = list(doc["terms"])
    if doc.get("upi_vpa"):
        upi["vpa"] = doc["upi_vpa"]
    if doc.get("upi_payee_name"):
        upi["payee_name"] = doc["upi_payee_name"]
    data["upi"] = upi
    data.setdefault("terms", [])
    data.setdefault("signatory_label", "Authorised Signatory")
    data.setdefault("thank_you", "")
    for kind in IMAGE_KINDS:
        path = doc.get(f"{kind}_path")
        data[kind] = (_storage_image(path) if path else "") or _image_data_uri(kind)
    _brand_cache["v"] = (time.monotonic(), data)
    return data


branding.cache_clear = _brand_cache.clear  # type: ignore[attr-defined]


def _image_data_uri(stem: str) -> str:
    for ext, mime in (("png", "image/png"), ("jpg", "image/jpeg"), ("jpeg", "image/jpeg")):
        p = BRAND_DIR / f"{stem}.{ext}"
        if p.is_file():
            return f"data:{mime};base64," + base64.b64encode(p.read_bytes()).decode()
    return ""


def _upi_qr(vpa: str, payee: str, amount: float, note: str) -> str:
    """UPI 'pay' intent as a PNG data URI (any UPI app can scan it)."""
    params = {"pa": vpa, "pn": payee or vpa, "am": f"{amount:.2f}", "cu": "INR", "tn": note}
    uri = "upi://pay?" + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
    try:
        import qrcode
        img = qrcode.make(uri, box_size=6, border=1)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception as e:
        log.warning("UPI QR generation failed: %s", e)
        return ""


# ── particulars (what was charged, GST-inclusive) ─────────────────────────

@dataclass
class Line:
    desc: str
    sub: str
    code: str
    rate: float | None    # GST %; 0 → Exempt; None → not applicable
    qty: float
    unit: float
    amount: float


def _rate_label(rate) -> str:
    if rate is None:
        return "&mdash;"
    return "Exempt" if rate <= 0 else f"{rate:g}%"


def _consolidate_services(svc_list: list) -> list:
    """Same merge rule as the legacy renderer: name + unit price."""
    grouped: dict = {}
    for s in svc_list:
        name = (s.get("item") or "Service").strip()
        qty = int(s.get("quantity", 1) or 1)
        if qty <= 0:
            qty = 1
        m = re.search(r"\s*[x×]\s*(\d+)\s*$", name, re.I)
        if m:
            n = int(m.group(1))
            name = name[:m.start()].strip() or "Service"
            if qty <= 1 and n > 1:
                qty = n
        u = s.get("unit_price")
        unit = float(u) if u is not None else (_f(s.get("price")) / qty)
        key = (name.lower(), round(unit, 2))
        if key not in grouped:
            merged = dict(s)
            merged.update({"item": name, "quantity": qty, "unit_price": unit, "price": _f(s.get("price"))})
            grouped[key] = merged
        else:
            grouped[key]["quantity"] += qty
            grouped[key]["price"] += _f(s.get("price"))
    return list(grouped.values())


def _short_date(s) -> str:
    from routes.billing import _fmt_day_date
    return _e(_fmt_day_date(s)) if s else ""


def particulars(b: dict, view: str | None = None) -> tuple[list[Line], float, float]:
    """→ (lines, discount, accommodation_total). Amounts are as charged (incl. GST)."""
    from routes import billing as B
    import config as C

    sac = getattr(C, "ACCOMMODATION_SAC", "996311")
    lines: list[Line] = []
    discount = 0.0
    folio = b.get("daily_folio")
    folio = folio if isinstance(folio, list) else []
    services = b.get("services") or []

    if folio:
        mode = B._resolve_view_mode(b, view)
        blocks = (B._group_folio(folio) if mode == "consolidated"
                  else [{"kind": "day", "entries": [e]} for e in folio])
        for blk in blocks:
            ents = blk["entries"]
            if blk["kind"] == "run":
                first, last, n = ents[0], ents[-1], len(ents)
                addon_gross = lambda e: sum(_f(a.get("price")) for a in (e.get("addons") or [])  # noqa: E731
                                            if isinstance(a, dict))
                names, seen = [], set()
                for a in (first.get("addons") or []):
                    if isinstance(a, dict):
                        nm = str(a.get("item") or "Service").strip()
                        if nm and nm.lower() not in seen:
                            seen.add(nm.lower())
                            names.append(nm)
                desc = f"Room Rent (incl. {', '.join(names)})" if names else "Room Rent"
                lines.append(Line(
                    desc=_e(desc),
                    sub=f"Room {_e(first.get('room') or b.get('room', ''))} &middot; "
                        f"{_short_date(first.get('day_start'))} to {_short_date(last.get('day_start'))}",
                    code=sac, rate=_f(first.get("day_gst_rate")), qty=n,
                    unit=_f(first.get("base_rate")) + addon_gross(first),
                    amount=sum(_f(e.get("base_rate")) + addon_gross(e) for e in ents)))
                discount += sum(_f(e.get("discount_allocated")) for e in ents)
            else:
                e = ents[0]
                rate = _f(e.get("day_gst_rate"))
                lines.append(Line(
                    desc="Room Rent",
                    sub=f"Room {_e(e.get('room') or b.get('room', ''))} &middot; Night {e.get('day_index', 1)}"
                        f" &middot; {_short_date(e.get('day_start'))}",
                    code=sac, rate=rate, qty=1, unit=_f(e.get("base_rate")), amount=_f(e.get("base_rate"))))
                for a in (e.get("addons") or []):
                    if not isinstance(a, dict):
                        continue
                    q = int(a.get("quantity", 1) or 1)
                    lines.append(Line(
                        desc=_e(a.get("item") or "Service"), sub=f"Night {e.get('day_index', 1)}",
                        code=sac, rate=rate, qty=q,
                        unit=_f(a.get("unit_price") or a.get("price")), amount=_f(a.get("price"))))
                discount += _f(e.get("discount_allocated"))
        accom_total = sum(_f(e.get("day_total")) for e in folio)
        # A bill-level discount larger than the accommodation share sits on services.
        discount += max(0.0, round(_f(b.get("discounts")) - discount, 2))
    else:
        days = int(b.get("days_stayed") or 1) or 1
        gst_rate = _f(b.get("gst_rate"))
        segs = b.get("room_segments") or []
        new_fmt = bool(segs and "room" in segs[0])
        room_charges = _f(b.get("room_charges_total")) or _f(b.get("room_price_per_night") or b.get("room_rent")) * days
        if new_fmt and len(segs) > 1:
            for sg in segs:
                n = int(sg.get("nights") or 0)
                if n > 0:
                    lines.append(Line("Room Rent", f"Room {_e(sg.get('room', ''))}", sac,
                                      C._slab_for_value(_f(sg.get("rate"))), n, _f(sg.get("rate")),
                                      _f(sg.get("total"))))
        elif segs and not new_fmt:
            for sg in segs:
                n = int(sg.get("days") or 0)
                if n > 0:
                    lines.append(Line("Room Rent", f"Room {_e(sg.get('from_room', ''))}", sac,
                                      C._slab_for_value(_f(sg.get("price"))), n, _f(sg.get("price")),
                                      _f(sg.get("total"))))
            cd = int(b.get("current_room_days") or 0)
            if cd > 0:
                lines.append(Line("Room Rent", f"Room {_e(b.get('current_room') or b.get('room', ''))}", sac,
                                  C._slab_for_value(_f(b.get("current_room_price"))), cd,
                                  _f(b.get("current_room_price")), _f(b.get("current_room_total"))))
        else:
            lines.append(Line("Room Rent", f"Room {_e(b.get('room', ''))}", sac, gst_rate, days,
                              room_charges / days, room_charges))
        for s in _consolidate_services([s for s in services if s.get("accommodation_charge")]):
            lines.append(Line(_e(s.get("item")), "Accommodation extra", sac, gst_rate,
                              s.get("quantity", 1), _f(s.get("unit_price")), _f(s.get("price"))))
        discount = _f(b.get("discounts"))
        accom_total = sum(l.amount for l in lines)

    for s in _consolidate_services([s for s in services if not s.get("accommodation_charge")]):
        hsn, rate, _cat = C.infer_service_tax(s)
        lines.append(Line(_e(s.get("item")), "", hsn or "", float(rate) if hsn else 0.0,
                          s.get("quantity", 1), _f(s.get("unit_price")), _f(s.get("price"))))
    return lines, round(discount, 2), round(accom_total, 2)


# ── title ──────────────────────────────────────────────────────────────────

def document_title(b: dict, breakup: dict, rule: str = "by_supply", since: str = "") -> tuple[str, str]:
    """→ (title, note under the title).

    `since` (YYYY-MM-DD): the supply-based titles apply only to bills checked
    out on or after this date. Empty → never (always TAX INVOICE). An invoice
    already issued must not come back under the same number with a different
    document type when its PDF is regenerated, so this is a dated cut-over.
    """
    if rule != "by_supply" or (b.get("status") or "").lower() == "cancelled":
        return "TAX INVOICE", ""
    if not since or str(b.get("checkout_time") or "")[:10] < since:
        return "TAX INVOICE", ""
    taxed = any(r["rate"] > 0 and r["tax"] > 0 for r in breakup["rows"])
    exempt = _f(breakup.get("exempt_value")) > 0
    registered = b.get("invoice_type") == "B2B" and (b.get("recipient_gstin") or "").strip()
    if taxed and exempt and not registered:
        return "INVOICE-CUM-BILL OF SUPPLY", "Taxable and exempt supplies (Rule 46A)"
    if not taxed and (exempt or _f(b.get("total_amount")) > 0):
        return "BILL OF SUPPLY", "Exempt supply &mdash; no GST charged"
    return "TAX INVOICE", ""


# ── the document ───────────────────────────────────────────────────────────

_CSS = """
.inv-doc{font-family:"DejaVu Sans",Arial,Helvetica,sans-serif;color:#1f2937;font-size:9pt;line-height:1.35;
 max-width:820px;margin:0 auto;background:#fff}
.inv-doc table{width:100%;border-collapse:collapse}
.inv-doc td,.inv-doc th{vertical-align:top}
.inv-head td{padding:0}
.inv-brand-name{font-size:17pt;font-weight:bold;color:#0f1d36;letter-spacing:.5px}
.inv-brand-sub{font-size:8.5pt;color:#4b5563;margin-top:1px}
.inv-gstin{font-size:8.5pt;color:#0f1d36;font-weight:bold;margin-top:3px}
.inv-title-box td{text-align:center}
.inv-title-box td.inv-title{font-size:12pt;font-weight:bold;color:#ffffff;background-color:#0f1d36;letter-spacing:1.5px;padding:6px 6px 4px 6px}
.inv-title-box td.inv-title-note{font-size:7.5pt;color:#0f1d36;background-color:#eef2f7;padding:3px 6px 1px 6px}
.inv-title-box td.inv-copy{font-size:7pt;color:#4b5563;background-color:#eef2f7;letter-spacing:1px;padding:3px 6px 2px 6px}
.inv-rule{height:3px;background-color:#f9a825;margin:6px 0 6px 0;font-size:1pt;line-height:3px}
.inv-meta td{border:1px solid #d1d5db;padding:5px 7px 3px 7px;width:33.33%}
.inv-meta-h{font-size:7pt;font-weight:bold;color:#6b7280;letter-spacing:1px;margin-bottom:3px}
.inv-kv{font-size:8.5pt;margin-bottom:1px}
.inv-kv b{color:#111827}
.inv-items{margin-top:8px}
.inv-items th{background-color:#0f1d36;color:#ffffff;font-size:7.5pt;font-weight:bold;padding:5px 5px;
 text-align:left;border:1px solid #0f1d36}
.inv-items td{border-bottom:1px solid #e5e7eb;padding:3px 5px 2px 5px;font-size:8.5pt}
.inv-items tr.inv-alt td{background-color:#f8fafc}
.inv-items th.inv-c{text-align:center}
.inv-items th.inv-r{text-align:right}
.inv-r{text-align:right}
.inv-c{text-align:center}
.inv-sub{font-size:7pt;color:#6b7280}
.inv-items tr.inv-less td{color:#047857}
.inv-items tr.inv-tot td{font-weight:bold;background-color:#eef2f7;border-top:1.5px solid #0f1d36}
.inv-sec{font-size:7.5pt;font-weight:bold;color:#0f1d36;letter-spacing:1px;margin:10px 0 3px 0}
.inv-tax th{background-color:#eef2f7;color:#0f1d36;font-size:7.5pt;padding:4px 5px;border:1px solid #cbd5e1;text-align:left}
.inv-tax th.inv-c{text-align:center}
.inv-tax th.inv-r{text-align:right}
.inv-tax td{border-bottom:1px solid #e5e7eb;padding:3px 5px 2px 5px;font-size:8pt}
.inv-tax tr.inv-tot td{font-weight:bold;background-color:#f8fafc;border-top:1.5px solid #64748b}
.inv-totals{border:1px solid #d1d5db}
.inv-totals td{padding:3px 8px 2px 8px;font-size:8.5pt;border-bottom:1px solid #eef2f7}
.inv-totals tr.inv-grand td{font-size:10.5pt;font-weight:bold;color:#ffffff;background-color:#0f1d36;padding:5px 8px 4px 8px}
.inv-words{font-size:7.5pt;color:#374151;margin-top:4px}
.inv-pay{border:1px solid #d1d5db}
.inv-pay td{padding:3px 8px 2px 8px;font-size:8.5pt;border-bottom:1px solid #eef2f7}
.inv-due td{color:#b91c1c;font-weight:bold}
.inv-box{border:1px solid #d1d5db;padding:6px 8px}
.inv-qr{text-align:center;font-size:7.5pt;color:#374151}
.inv-terms{font-size:7.5pt;color:#4b5563;margin:0 0 0 0;padding-left:14px}
.inv-sign td{padding:0;vertical-align:bottom}
.inv-sign-line{border-top:1px solid #6b7280;padding-top:3px;font-size:8pt;color:#374151;text-align:center}
@media print{.inv-doc,.inv-doc *{-webkit-print-color-adjust:exact;print-color-adjust:exact}.inv-doc{max-width:none}}
.inv-foot{border-top:1px solid #e5e7eb;margin-top:6px;padding-top:3px;font-size:7pt;color:#6b7280;text-align:center}
"""


def build_invoice_html(b: dict, view: str | None = None) -> str:
    """Drop-in replacement for routes.billing._build_bill_html."""
    from routes import billing as B
    import config as C
    from ..settings import get_settings

    brand = branding()
    breakup = C.bill_tax_breakup(b)
    st = get_settings()
    title, title_note = document_title(b, breakup, st.INVOICE_TITLE_RULE, st.INVOICE_TITLE_BY_SUPPLY_FROM)
    lines, discount, _accom_total = particulars(b, view)

    total = round(_f(b.get("total_amount")) or (sum(l.amount for l in lines) - discount), 2)
    lines_net = round(sum(l.amount for l in lines) - discount, 2)
    adjust = round(total - lines_net, 2)
    if abs(adjust) >= 0.01:
        log.warning("invoice %s: particulars %.2f vs total %.2f (adjustment %.2f)",
                    b.get("bill_number"), lines_net, total, adjust)

    # ── header ──
    logo = (f'<img src="{brand["logo"]}" style="height:54px;width:auto;margin-right:10px" alt="" />'
            if brand.get("logo") else "")
    contact = " &middot; ".join(x for x in (f"Ph: {B.SUPPLIER_PHONE}",
                                            _e(brand.get("email") or ""), _e(brand.get("website") or "")) if x)
    header = f"""
<table class="inv-head"><tr>
 <td style="width:64%">
  <table><tr>
   {'<td style="width:64px">' + logo + '</td>' if logo else ''}
   <td>
    <div class="inv-brand-name">{B.SUPPLIER_NAME}</div>
    <div class="inv-brand-sub">{B.SUPPLIER_ENTITY}<br/>{B.SUPPLIER_ADDRESS}<br/>{contact}</div>
    <div class="inv-gstin">GSTIN: {B.SUPPLIER_GSTIN} &nbsp;&middot;&nbsp; State: {B.PLACE_OF_SUPPLY_STATE} ({B.PLACE_OF_SUPPLY_CODE})</div>
   </td>
  </tr></table>
 </td>
 <td style="width:36%">
  <table class="inv-title-box">
   <tr><td class="inv-title">{title}</td></tr>
   {f'<tr><td class="inv-title-note">{title_note}</td></tr>' if title_note else ''}
   <tr><td class="inv-copy">ORIGINAL FOR RECIPIENT</td></tr>
  </table>
 </td>
</tr></table>
<div class="inv-rule">&nbsp;</div>"""

    # ── invoice / recipient / stay ──
    inv_type = b.get("invoice_type", "B2C")
    gstin = (b.get("recipient_gstin") or "").strip()
    addr = (b.get("recipient_address") or "").strip().replace("\n", ", ")
    r_state = (b.get("recipient_state") or "").strip()
    r_code = (b.get("recipient_state_code") or "").strip()
    if inv_type == "B2B" and gstin:
        billed = [("Name", b.get("recipient_legal_name") or b.get("guest_name"))]
        if b.get("recipient_trade_name"):
            billed.append(("Trade name", b.get("recipient_trade_name")))
        billed.append(("GSTIN", gstin))
    else:
        billed = [("Name", b.get("guest_name") or "-"), ("Mobile", b.get("guest_mobile") or "-")]
    if addr:
        billed.append(("Address", addr))
    if r_state and (inv_type != "B2C" or addr):
        billed.append(("State", f"{r_state} ({r_code or '-'})"))
    if inv_type == "B2B" and gstin and b.get("guest_name"):
        billed.append(("Guest", b.get("guest_name")))

    def kv(rows):
        return '<div class="inv-kv">' + "<br/>".join(f'{k}: <b>{_e(v)}</b>' for k, v in rows) + "</div>"

    meta = f"""
<table class="inv-meta"><tr>
 <td><div class="inv-meta-h">INVOICE DETAILS</div>
  {kv([("Invoice No", b.get("bill_number") or "N/A"), ("Invoice Date", _fmt_dt(b.get("checkout_time"))),
       ("Place of Supply", f"{B.PLACE_OF_SUPPLY_STATE} ({B.PLACE_OF_SUPPLY_CODE})"), ("Reverse Charge", "No")])}
 </td>
 <td><div class="inv-meta-h">BILLED TO{' (REGISTERED)' if inv_type == 'B2B' and gstin else ''}</div>{kv(billed)}</td>
 <td><div class="inv-meta-h">STAY DETAILS</div>
  {kv([("Room", b.get("room") or "-"), ("Guests", b.get("guest_count") or 1),
       ("Check-in", _fmt_dt(b.get("checkin_time"))), ("Check-out", _fmt_dt(b.get("checkout_time"))),
       ("Nights", b.get("days_stayed") or 1)])}
 </td>
</tr></table>"""

    # ── particulars ──
    rows = []
    for i, l in enumerate(lines, 1):
        qty = f"{l.qty:g}" if isinstance(l.qty, (int, float)) else _e(l.qty)
        alt = ' class="inv-alt"' if i % 2 == 0 else ""
        sub = f' <span class="inv-sub">&middot; {l.sub}</span>' if l.sub else ""
        rows.append(
            f'<tr{alt}>'
            f'<td class="inv-c">{i}</td>'
            f'<td>{l.desc}{sub}</td>'
            f'<td class="inv-c">{_e(l.code) or "&mdash;"}</td>'
            f'<td class="inv-c">{_rate_label(l.rate)}</td>'
            f'<td class="inv-r">{qty}</td>'
            f'<td class="inv-r">{inr(l.unit)}</td>'
            f'<td class="inv-r">{inr(l.amount)}</td></tr>')
    if discount > 0:
        rows.append(f'<tr class="inv-less"><td></td><td colspan="5">Less: Discount (reduces taxable value, '
                    f'Sec. 15(3)(a) CGST Act)</td><td class="inv-r">- {inr(discount)}</td></tr>')
    if abs(adjust) >= 0.01:
        rows.append(f'<tr><td></td><td colspan="5">Rounding adjustment</td>'
                    f'<td class="inv-r">{"+" if adjust > 0 else "-"} {inr(abs(adjust))}</td></tr>')
    rows.append(f'<tr class="inv-tot"><td></td><td colspan="5" class="inv-r">Total (inclusive of GST)</td>'
                f'<td class="inv-r">&#8377; {inr(total)}</td></tr>')
    items = f"""
<table class="inv-items">
 <thead><tr>
  <th class="inv-c" style="width:5%">#</th><th style="width:39%">Description</th>
  <th class="inv-c" style="width:10%">HSN/SAC</th><th class="inv-c" style="width:8%">GST</th>
  <th class="inv-r" style="width:8%">Qty</th><th class="inv-r" style="width:14%">Rate (&#8377;)</th>
  <th class="inv-r" style="width:16%">Amount (&#8377;)</th>
 </tr></thead>
 <tbody>{''.join(rows)}</tbody>
</table>"""

    # ── tax computation (authoritative) ──
    show_igst = _f(breakup.get("igst")) > 0
    trs = []
    for r in breakup["rows"]:
        half = f' <span class="inv-sub">@{r["rate"] / 2:g}%</span>' if r["rate"] > 0 else ""
        trs.append(
            f'<tr><td>{_e(r["hsn"])}</td><td>{_e(r["description"])}</td>'
            f'<td class="inv-c">{_rate_label(r["rate"])}</td>'
            f'<td class="inv-r">{inr(r["taxable"])}</td>'
            f'<td class="inv-r">{inr(r["cgst"])}{half}</td><td class="inv-r">{inr(r["sgst"])}{half}</td>'
            + (f'<td class="inv-r">{inr(r["igst"])}</td>' if show_igst else "")
            + f'<td class="inv-r">{inr(r["tax"])}</td></tr>')
    w = ("11%", "21%", "9%", "15%", "15%", "15%", "14%") if not show_igst else \
        ("10%", "17%", "8%", "13%", "13%", "13%", "13%", "13%")
    heads = ["HSN/SAC", "Description", "GST rate", "Taxable value", "CGST", "SGST"] + \
            (["IGST"] if show_igst else []) + ["Total tax"]
    th = "".join(f'<th class="{"inv-r" if i >= 3 else ("inv-c" if i == 2 else "")}" style="width:{w[i]}">{h}</th>'
                 for i, h in enumerate(heads))
    if b.get("status") == "cancelled":
        tax_html = '<div class="inv-box" style="color:#991b1b">Cancelled invoice &mdash; no tax is payable.</div>'
    elif trs:
        tax_html = f"""
<table class="inv-tax">
 <thead><tr>{th}</tr></thead>
 <tbody>{''.join(trs)}
  <tr class="inv-tot"><td colspan="3" class="inv-r">Total</td><td class="inv-r">{inr(breakup["taxable"])}</td>
   <td class="inv-r">{inr(breakup["cgst"])}</td><td class="inv-r">{inr(breakup["sgst"])}</td>
   {f'<td class="inv-r">{inr(breakup["igst"])}</td>' if show_igst else ''}<td class="inv-r">{inr(breakup["tax"])}</td></tr>
 </tbody>
</table>"""
    else:
        tax_html = ""

    # ── totals ──
    taxable_value = round(sum(r["taxable"] for r in breakup["rows"] if r["rate"] > 0), 2)
    exempt_value = _f(breakup.get("exempt_value"))
    tax_total = _f(breakup.get("tax"))
    round_off = round(total - (taxable_value + exempt_value + tax_total), 2)
    if b.get("status") == "cancelled":
        round_off = 0.0
    trows = []
    if taxable_value:
        trows.append(("Taxable value", inr(taxable_value)))
    if exempt_value:
        trows.append(("Exempt / nil-rated value", inr(exempt_value)))
    if _f(breakup.get("cgst")):
        trows.append(("CGST", inr(breakup["cgst"])))
    if _f(breakup.get("sgst")):
        trows.append(("SGST", inr(breakup["sgst"])))
    if show_igst:
        trows.append(("IGST", inr(breakup["igst"])))
    if abs(round_off) >= 1.0:
        # Service rows in the tax breakup are pre-discount; a discount larger
        # than the accommodation share (or on a pre-folio bill) lands here.
        trows.append(("Less: discount on other items" if round_off < 0 else "Adjustment",
                      f'{"+" if round_off > 0 else "-"} {inr(abs(round_off))}'))
    elif abs(round_off) >= 0.01:
        trows.append(("Round-off", f'{"+" if round_off > 0 else "-"} {inr(abs(round_off))}'))
    totals = ("<table class=\"inv-totals\">"
              + "".join(f'<tr><td>{k}</td><td class="inv-r">{v}</td></tr>' for k, v in trows)
              + f'<tr class="inv-grand"><td>Invoice Total</td><td class="inv-r">&#8377; {inr(total)}</td></tr>'
              + "</table>"
              + f'<div class="inv-words">{amount_in_words(total)}</div>')

    # ── payments ──
    cash, online, ota = _f(b.get("payment_cash")), _f(b.get("payment_online")), _f(b.get("payment_ota"))
    refunds, rc, ro = _f(b.get("refunds")), _f(b.get("refund_cash")), _f(b.get("refund_online"))
    paid = cash + online + ota
    balance = _f(b.get("balance"))
    prow = []
    if cash:
        prow.append(("Cash", inr(cash), ""))
    if online:
        prow.append(("UPI / Online", inr(online), ""))
    if ota:
        prow.append(("Prepaid via OTA (MMT)", inr(ota), ""))
    prow.append(("Total paid", inr(paid), "font-weight:bold"))
    if refunds:
        if rc:
            prow.append(("Refunded (cash)", "- " + inr(rc), ""))
        if ro:
            prow.append(("Refunded (UPI)", "- " + inr(ro), ""))
        if not rc and not ro:
            prow.append(("Refunded", "- " + inr(refunds), ""))
        prow.append(("Net collected", inr(paid - refunds), "font-weight:bold"))
    overpaid = round((paid - refunds) - total, 2)
    pay_html = "<table class=\"inv-pay\">" + "".join(
        f'<tr><td style="{st}">{k}</td><td class="inv-r" style="{st}">&#8377; {v}</td></tr>' for k, v, st in prow)
    if balance > 0 and b.get("status") != "cancelled":
        pay_html += f'<tr class="inv-due"><td>Balance due</td><td class="inv-r">&#8377; {inr(balance)}</td></tr>'
    elif overpaid > 0.5:
        pay_html += f'<tr class="inv-due"><td>Overpaid &mdash; refund due</td><td class="inv-r">&#8377; {inr(overpaid)}</td></tr>'
    pay_html += "</table>"

    qr_html = ""
    upi = brand.get("upi") or {}
    if balance > 0 and upi.get("vpa") and b.get("status") != "cancelled":
        qr = _upi_qr(upi["vpa"], upi.get("payee_name") or "", balance,
                     f"Invoice {b.get('bill_number') or ''}".strip())
        if qr:
            qr_html = (f'<div class="inv-qr"><img src="{qr}" style="width:84px;height:84px" alt="UPI QR" />'
                       f'<br/><b>Scan to pay</b><br/>&#8377; {inr(balance)}<br/>{_e(upi["vpa"])}</div>')
    elif balance > 0 and brand.get("upi_qr") and b.get("status") != "cancelled":
        # Uploaded static QR (e.g. the bank's printed QR): no amount inside it,
        # so the amount due is printed under it.
        qr_html = (f'<div class="inv-qr"><img src="{brand["upi_qr"]}" style="width:84px;height:84px" alt="UPI QR" />'
                   f'<br/><b>Scan to pay</b><br/>&#8377; {inr(balance)}</div>')

    summary = f"""
<table style="margin-top:8px"><tr>
 <td style="width:{'36%' if qr_html else '50%'};padding:0">
  <div class="inv-sec">PAYMENT DETAILS</div>{pay_html}
 </td>
 {f'<td style="width:18%;padding:18px 0 0 0">{qr_html}</td>' if qr_html else '<td style="width:4%;padding:0">&nbsp;</td>'}
 <td style="width:46%;padding:0">
  <div class="inv-sec">INVOICE SUMMARY</div>{totals}
 </td>
</tr></table>"""

    terms = brand.get("terms") or []
    terms_html = ("<div class=\"inv-sec\">TERMS &amp; CONDITIONS</div><ol class=\"inv-terms\">"
                  + "".join(f"<li>{_e(t)}</li>" for t in terms) + "</ol>") if terms else ""
    sig_img = (f'<div style="height:44px"><img src="{brand["signature"]}" style="height:42px;width:auto" alt="" /></div>'
               if brand.get("signature") else '<div style="height:30px">&nbsp;</div>')
    sign = f"""
<table class="inv-sign" style="margin-top:6px"><tr>
 <td style="width:35%">
  <div style="font-size:8pt">&nbsp;</div>{'<div style="height:44px">&nbsp;</div>' if brand.get("signature") else '<div style="height:30px">&nbsp;</div>'}
  <div class="inv-sign-line">Guest signature</div>
 </td>
 <td style="width:25%">&nbsp;</td>
 <td style="width:40%;text-align:center">
  <div style="font-size:8pt;color:#374151">For {B.SUPPLIER_NAME}</div>
  {sig_img}
  <div class="inv-sign-line">{_e(brand.get("signatory_label") or "Authorised Signatory")}</div>
 </td>
</tr></table>"""

    foot_lines = ["Certified that the particulars given above are true and correct.",
                  "This is a computer-generated invoice."]
    if brand.get("thank_you"):
        foot_lines.insert(0, _e(brand["thank_you"]))
    footer = '<div class="inv-foot">' + "<br/>".join(foot_lines) + "</div>"

    return (f'<div class="b-bill-wrap inv-doc" {MARKER}><style id="inv-style">{_CSS}</style>'
            f'{B._cancelled_banner(b)}{header}{meta}{items}'
            f'<div class="inv-sec">TAX COMPUTATION (HSN/SAC-WISE)</div>{tax_html}'
            f'{summary}{terms_html}{sign}{footer}</div>')


# ── PDF wrapper ────────────────────────────────────────────────────────────

_FONT_NAME = "DejaVuSans"
_fonts_ok: bool | None = None


def _register_fonts() -> bool:
    """Register DejaVu Sans (has the ₹ glyph) with ReportLab, once.

    Registered directly instead of through CSS @font-face: xhtml2pdf copies an
    @font-face file to a NamedTemporaryFile and re-opens it by name, which
    Windows refuses ("Permission denied … tmpXXXX.ttf"). Registering the file
    path with ReportLab avoids the temp copy on every OS.
    """
    global _fonts_ok
    if _fonts_ok is not None:
        return _fonts_ok
    reg, bold = FONT_DIR / "DejaVuSans.ttf", FONT_DIR / "DejaVuSans-Bold.ttf"
    try:
        from reportlab.lib.fonts import addMapping
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
        from xhtml2pdf import default as x_default
        pdfmetrics.registerFont(TTFont(_FONT_NAME, str(reg)))
        bold_name = _FONT_NAME
        if bold.is_file():
            bold_name = _FONT_NAME + "-Bold"
            pdfmetrics.registerFont(TTFont(bold_name, str(bold)))
        for b_, i_, n_ in ((0, 0, _FONT_NAME), (1, 0, bold_name), (0, 1, _FONT_NAME), (1, 1, bold_name)):
            addMapping(_FONT_NAME, b_, i_, n_)
        for alias in ("dejavusans", "dejavu sans", "dejavu"):
            x_default.DEFAULT_FONT[alias] = _FONT_NAME
        _fonts_ok = True
    except Exception as e:  # missing file / library: fall back to Helvetica + "Rs."
        log.warning("invoice font registration failed (%s) — PDFs will print 'Rs.'", e)
        _fonts_ok = False
    return _fonts_ok


def build_pdf_document(html_body: str) -> str:
    """Full HTML document for xhtml2pdf from a v2 fragment."""
    m = re.search(r'<style id="inv-style">(.*?)</style>', html_body, re.S)
    css = m.group(1) if m else _CSS
    body = html_body.replace(m.group(0), "") if m else html_body
    has_font = _register_fonts()
    if not has_font:  # no font with ₹ → same fallback as the legacy renderer
        body = body.replace("\u20b9", "Rs.").replace("&#8377;", "Rs.")
    family = _FONT_NAME if has_font else "Helvetica"
    css = css.replace('font-family:"DejaVu Sans",Arial,Helvetica,sans-serif', f"font-family:{family}")
    return f"""<!DOCTYPE html>
<html><head><meta charset="UTF-8"/>
<style>
@page {{ size: A4 portrait; margin: 11mm 11mm 15mm 11mm;
  @frame footer {{ -pdf-frame-content: inv-page-footer; bottom: 6mm; margin-left: 11mm; margin-right: 11mm; height: 6mm; }} }}
body {{ font-family: {family}; font-size: 9pt; color: #1f2937; }}
{css}
#inv-page-footer {{ font-size: 7pt; color: #9ca3af; text-align: right; }}
</style></head>
<body>
<div id="inv-page-footer">Page <pdf:pagenumber/> of <pdf:pagecount/></div>
{body}
</body></html>"""


# ── install ────────────────────────────────────────────────────────────────

_installed = False


def install() -> bool:
    """Swap the legacy bill renderer for v2 (idempotent). Returns True if active."""
    global _installed
    from ..settings import get_settings
    if get_settings().INVOICE_LAYOUT.lower() != "v2":
        log.info("invoice layout: legacy (INVOICE_LAYOUT=%s)", get_settings().INVOICE_LAYOUT)
        return False
    if _installed:
        return True
    from routes import billing as B

    legacy_pdf = B._build_pdf_html
    B._legacy_build_bill_html = B._build_bill_html   # kept for comparison / rollback tools

    def _pdf_html(html_body: str) -> str:
        if MARKER in html_body:
            return build_pdf_document(html_body)
        return legacy_pdf(html_body)  # credit notes keep their own renderer

    B._build_bill_html = build_invoice_html
    B._build_pdf_html = _pdf_html
    _installed = True
    log.info("invoice layout: v2 installed")
    return True
