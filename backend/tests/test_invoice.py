"""
Invoice layout v2: same money as the legacy renderer, Rule 46 fields present,
PDF renders with the rupee glyph, and the legacy path stays one switch away.
"""
import io
import re
from datetime import datetime

import pytest

import config
from routes import billing as B

from cibara_api.invoice import render as R

CHECKIN = datetime(2026, 8, 1, 14, 0)


def make_bill(*, nights=1, rate=900, room="101", services=None, discount=0, cash=0, online=0, ota=0,
              refunds=0, refund_cash=0, refund_online=0, segments=None, invoice_type="B2C",
              recipient_gstin="", bill_number="CC/2026/08/00001", guest="Test Guest", folio=True,
              status="completed"):
    """Same construction as tests/test_bill_scenarios.make_bill (create_bill_record shape)."""
    services = services or []
    accom = [s for s in services if s.get("accommodation_charge")]
    daily = []
    if folio:
        daily = config.compute_daily_folio(
            checkin_dt=CHECKIN, days_stayed=nights, room_price_per_night=rate, current_room_no=room,
            accommodation_services=accom, pre_transfer_charges=segments or [],
            discount_on_accom=discount, recipient_state_code="29")
    room_total = (sum(s.get("total", 0) for s in (segments or []))
                  + rate * (nights - sum(s.get("days", 0) for s in (segments or []))))
    non_accom = sum(s.get("price", 0) for s in services if not s.get("accommodation_charge"))
    accom_total = sum(e["day_total"] for e in daily) if daily else \
        room_total + sum(s.get("price", 0) for s in accom) - discount
    total = round(accom_total + non_accom, 2)
    gst = round(sum(e["day_gst_amount"] for e in daily), 2) if daily else 0
    taxable = round(sum(e["day_taxable"] for e in daily), 2) if daily else 0
    rates = {e["day_gst_rate"] for e in daily} if daily else {config._slab_for_value(rate)}
    return {
        "id": "t", "bill_number": bill_number, "guest_name": guest, "guest_mobile": "9999999999",
        "room": room, "guest_count": 2, "checkin_time": CHECKIN.strftime("%Y-%m-%d %H:%M"),
        "checkout_time": "2026-08-%02d 11:00" % min(1 + nights, 28), "days_stayed": nights,
        "room_price_per_night": rate, "room_charges_total": room_total, "room_segments": segments or [],
        "services": services, "services_total": sum(s.get("price", 0) for s in services),
        "discounts": discount, "gst_rate": max(rates), "gst_amount": gst, "accommodation_taxable": taxable,
        "total_amount": total, "payment_cash": cash, "payment_online": online, "payment_ota": ota,
        "refunds": refunds, "refund_cash": refund_cash, "refund_online": refund_online,
        "balance": round(total - cash - online - ota + refunds, 2), "invoice_type": invoice_type,
        "recipient_gstin": recipient_gstin, "recipient_legal_name": "Acme Pvt Ltd" if recipient_gstin else "",
        "recipient_state": "Karnataka", "recipient_state_code": "29", "daily_folio": daily, "status": status,
    }


WATER = {"item": "Water 1L", "quantity": 2, "unit_price": 20, "price": 40}
LAUNDRY = {"item": "Laundry", "quantity": 1, "unit_price": 100, "price": 100}
MISC = {"item": "Key deposit", "quantity": 1, "unit_price": 200, "price": 200}   # no HSN → exempt
EXTRA_BED = {"item": "Extra Bed", "quantity": 1, "unit_price": 300, "price": 300,
             "accommodation_charge": True, "applied_on_day": 1}
AC = {"item": "AC Charge", "quantity": 1, "unit_price": 300, "price": 300,
      "accommodation_charge": True, "applied_on_day": 1}

SCENARIOS = {
    "walk-in 5%": dict(nights=1, rate=1200, cash=1200),
    "exempt only": dict(nights=1, rate=900, cash=900),
    "extra bed pushes into tax": dict(nights=1, rate=900, services=[EXTRA_BED], cash=1200),
    "3 nights + extras + discount": dict(nights=3, rate=1500, services=[WATER, LAUNDRY], discount=250,
                                         cash=2000, online=1000),
    "slab crossing 5/18": dict(nights=2, rate=7400, services=[AC], cash=15100),
    "18% B2B": dict(nights=2, rate=8200, invoice_type="B2B", recipient_gstin="29ABCDE1234F1Z5"),
    "mixed taxable + exempt": dict(nights=1, rate=1200, services=[MISC], cash=1400),
    "room transfer": dict(nights=4, rate=1200, segments=[{"from_room": "101", "days": 2, "price": 1000,
                                                          "total": 2000}], cash=10000),
    "OTA + desk extras": dict(nights=2, rate=1500, ota=3000, cash=140, services=[WATER, LAUNDRY]),
    "overpaid then refunded": dict(nights=1, rate=1200, cash=1500, refunds=300, refund_cash=300),
    "long stay": dict(nights=12, rate=1300, services=[WATER], online=15640),
    "pre-folio legacy bill": dict(nights=2, rate=1200, services=[WATER], folio=False, cash=2440),
}


def _legacy_grand_total(html: str) -> float:
    return float(re.search(r"GRAND TOTAL.*?([\d.]+)</td>", html, re.S).group(1))


def _v2_total(html: str) -> float:
    m = re.search(r"Invoice Total</td><td[^>]*>&#8377; ([\d,.]+)", html)
    return float(m.group(1).replace(",", ""))


@pytest.mark.parametrize("name", list(SCENARIOS))
def test_money_matches_legacy_and_foots(name):
    b = make_bill(**SCENARIOS[name])
    legacy_html = B._legacy_build_bill_html(b, view="consolidated")
    for view in ("consolidated", "detailed"):
        html = B._build_bill_html(b, view=view)
        assert 'data-layout="v2"' in html
        assert _v2_total(html) == pytest.approx(_legacy_grand_total(legacy_html), abs=0.005), name
        assert _v2_total(html) == pytest.approx(b["total_amount"], abs=0.005)
        # particulars net to the total without an adjustment line
        lines, discount, _ = R.particulars(b, view)
        assert round(sum(l.amount for l in lines) - discount, 2) == pytest.approx(b["total_amount"], abs=0.005), name
        assert "Rounding adjustment" not in html
    # the tax figures printed are bill_tax_breakup's, i.e. what GSTR-1 files
    bt = config.bill_tax_breakup(b)
    html = B._build_bill_html(b)
    for key in ("cgst", "sgst", "tax", "taxable"):
        if bt[key]:
            assert R.inr(bt[key]) in html, (name, key)
    taxable = sum(r["taxable"] for r in bt["rows"] if r["rate"] > 0)
    assert round(taxable + bt["exempt_value"] + bt["tax"], 2) == pytest.approx(b["total_amount"], abs=0.05)


def test_rule46_fields_present():
    b = make_bill(nights=2, rate=8200, invoice_type="B2B", recipient_gstin="29ABCDE1234F1Z5",
                  bill_number="CC/2026/08/00077")
    b["recipient_address"] = "12 MG Road\nBengaluru"
    html = B._build_bill_html(b)
    for needle in (B.SUPPLIER_NAME, B.SUPPLIER_GSTIN, "CC/2026/08/00077", "Invoice Date",
                   "29ABCDE1234F1Z5", "Acme Pvt Ltd", "12 MG Road, Bengaluru", "996311", "18%",
                   "Place of Supply", "Karnataka (29)", "Reverse Charge", "<b>No</b>", "CGST", "SGST",
                   "Authorised Signatory", "ORIGINAL FOR RECIPIENT", "Rupees Sixteen Thousand Four Hundred Only"):
        assert needle in html, needle


@pytest.mark.parametrize("scenario,title", [
    ("walk-in 5%", "TAX INVOICE"), ("exempt only", "BILL OF SUPPLY"),
    ("mixed taxable + exempt", "INVOICE-CUM-BILL OF SUPPLY"), ("18% B2B", "TAX INVOICE"),
])
def test_document_title_by_supply(scenario, title):
    b = make_bill(**SCENARIOS[scenario])
    bt = config.bill_tax_breakup(b)
    assert R.document_title(b, bt, "by_supply", "2026-01-01")[0] == title
    assert R.document_title(b, bt, "by_supply", "")[0] == "TAX INVOICE"            # default: off
    assert R.document_title(b, bt, "by_supply", "2027-01-01")[0] == "TAX INVOICE"  # issued before cut-over
    assert R.document_title(b, bt, "tax_invoice", "2026-01-01")[0] == "TAX INVOICE"


def test_mixed_supply_to_registered_recipient_stays_tax_invoice():
    b = make_bill(nights=1, rate=1200, services=[MISC], invoice_type="B2B", recipient_gstin="29ABCDE1234F1Z5")
    assert R.document_title(b, config.bill_tax_breakup(b), "by_supply", "2026-01-01")[0] == "TAX INVOICE"


def test_cancelled_bill_shows_banner_and_no_tax():
    b = make_bill(nights=1, rate=1200, cash=1200, status="cancelled")
    b.update(cancel_kind="manual", cancelled_by_name="Asha", cancel_reason="Duplicate stay entry")
    html = B._build_bill_html(b)
    assert "CANCELLED" in html and "no tax is payable" in html


def test_guest_supplied_text_is_escaped():
    b = make_bill(nights=1, rate=1200, guest='<img src=x onerror="alert(1)">',
                  services=[{"item": "<script>x</script>", "quantity": 1, "unit_price": 10, "price": 10}])
    html = B._build_bill_html(b)
    assert "<script>x" not in html and "<img src=x" not in html
    assert "&lt;script&gt;" in html


def test_amount_in_words_and_indian_grouping():
    assert R.amount_in_words(0) == "Rupees Zero Only"
    assert R.amount_in_words(1200) == "Rupees One Thousand Two Hundred Only"
    assert R.amount_in_words(123456.78) == \
        "Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Seventy Eight Paise Only"
    assert R.amount_in_words(10_000_000) == "Rupees One Crore Only"
    assert R.amount_in_words(99.995) == "Rupees One Hundred Only"
    assert R.inr(12345678.5) == "1,23,45,678.50" and R.inr(999) == "999.00" and R.inr(-1500) == "-1,500.00"


def test_upi_qr_only_when_money_is_due(monkeypatch):
    R.branding.cache_clear()
    monkeypatch.setenv("UPI_VPA", "cibara@okaxis")
    try:
        due = make_bill(nights=1, rate=1200, cash=200)
        paid = make_bill(nights=1, rate=1200, cash=1200)
        assert "Scan to pay" in B._build_bill_html(due) and "data:image/png;base64," in B._build_bill_html(due)
        assert "Scan to pay" not in B._build_bill_html(paid)
    finally:
        monkeypatch.delenv("UPI_VPA")
        R.branding.cache_clear()
    assert "Scan to pay" not in B._build_bill_html(make_bill(nights=1, rate=1200, cash=200))


def test_logo_and_signature_files_are_embedded(tmp_path, monkeypatch):
    png = (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15"
           b"\xc4\x89\x00\x00\x00\rIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82")
    (tmp_path / "logo.png").write_bytes(png)
    (tmp_path / "signature.png").write_bytes(png)
    (tmp_path / "branding.json").write_text('{"terms": ["Check-out by 11 AM."], "email": "desk@example.com"}')
    monkeypatch.setattr(R, "BRAND_DIR", tmp_path)
    R.branding.cache_clear()
    try:
        html = B._build_bill_html(make_bill(nights=1, rate=1200, cash=1200))
        assert html.count("data:image/png;base64,") == 2
        assert "Check-out by 11 AM." in html and "desk@example.com" in html
    finally:
        R.branding.cache_clear()


def test_pdf_renders_with_rupee_glyph_and_one_page():
    from pypdf import PdfReader
    from xhtml2pdf import pisa
    b = make_bill(**SCENARIOS["3 nights + extras + discount"])
    doc = B._build_pdf_html(B._build_bill_html(b, view="consolidated"))
    # No @font-face: xhtml2pdf would copy the font to a temp file, which Windows can't reopen.
    assert "@font-face" not in doc and "font-family: DejaVuSans" in doc and "inv-style" not in doc
    buf = io.BytesIO()
    assert pisa.CreatePDF(doc, dest=buf).err == 0
    reader = PdfReader(io.BytesIO(buf.getvalue()))
    text = reader.pages[0].extract_text()
    assert len(reader.pages) == 1
    assert "₹" in text and b["bill_number"] in text and "TAX INVOICE" in text


def test_credit_note_pdf_keeps_its_own_renderer():
    doc = B._build_pdf_html('<div class="b-bill-wrap">CN ₹ 100</div>')
    assert "b-lodge-name" in doc and "Rs. 100" in doc   # legacy CSS + legacy rupee substitution


def test_layout_switch_off_leaves_legacy(monkeypatch):
    from cibara_api.settings import get_settings
    monkeypatch.setattr(get_settings(), "INVOICE_LAYOUT", "legacy")
    assert R.install() is False


def test_bill_html_endpoint_serves_v2(client, admin):
    from tests.test_parity import V2Driver
    V2Driver(client, admin).checkin("201", name="ravi", mobile="9876543210", guests=1, price=1200, paid=1200,
                                    payment="cash")
    r = client.post("/api/v2/rooms/201/checkout", headers=admin, json={})
    assert r.status_code == 200, r.text
    bills = client.get("/api/v2/bills", headers=admin, params={"start": "2020-01-01", "end": "2030-12-31"}).json()
    bid = bills["bills"][0]["id"]
    h = client.get(f"/api/v2/bills/{bid}/html", headers=admin).json()
    assert h["success"] and 'data-layout="v2"' in h["html"] and "TAX INVOICE" in h["html"]


def _storage_url(path, bucket=None):
    from urllib.parse import quote
    from tests.fakes import fake_firebase as F
    return (f"https://firebasestorage.googleapis.com/v0/b/{bucket or F.FAKE_BUCKET.name}/o/"
            f"{quote(path, safe='')}?alt=media&token=abc")


def _bill_with_pdf(pdf_url, number="CC/2026/10/00001"):
    from tests.conftest import DB
    DB.collection("bills").document("billpdf").set({"bill_number": number, "pdf_url": pdf_url, "status": "completed"})
    return "billpdf"


def test_stored_pdf_is_served_as_a_file(client, admin, staff):
    from tests.fakes import fake_firebase as F
    F.FAKE_BUCKET.blob("bills/CC_2026_10_00001.pdf").upload_from_string(b"%PDF-1.4 test", "application/pdf")
    bid = _bill_with_pdf(_storage_url("bills/CC_2026_10_00001.pdf"))
    r = client.get(f"/api/v2/bills/{bid}/pdf-file", headers=admin)
    assert r.status_code == 200 and r.content == b"%PDF-1.4 test"
    assert r.headers["content-type"] == "application/pdf" and r.headers["cache-control"] == "no-store"
    assert 'filename="Invoice-CC_2026_10_00001.pdf"' in r.headers["content-disposition"]
    assert client.get(f"/api/v2/bills/{bid}/pdf-file", headers=staff).status_code == 403


@pytest.mark.parametrize("url", [
    "https://evil.example.com/v0/b/cibara-dev.firebasestorage.app/o/bills%2Fx.pdf",
    _storage_url("customers/id-proof.jpg"),
    _storage_url("bills/../customers/x.pdf"),
    _storage_url("bills/x.pdf", bucket="someone-else"),
    "http://firebasestorage.googleapis.com/v0/b/cibara-dev.firebasestorage.app/o/bills%2Fx.pdf",
])
def test_stored_pdf_rejects_other_objects(client, admin, url):
    bid = _bill_with_pdf(url)
    assert client.get(f"/api/v2/bills/{bid}/pdf-file", headers=admin).status_code == 400


def test_stored_pdf_missing_is_404(client, admin):
    assert client.get("/api/v2/bills/nosuchbill/pdf-file", headers=admin).status_code == 404
    bid = _bill_with_pdf(_storage_url("bills/CC_9.pdf"))
    assert client.get(f"/api/v2/bills/{bid}/pdf-file", headers=admin).status_code == 404
    bid = _bill_with_pdf("")
    assert client.get(f"/api/v2/bills/{bid}/pdf-file", headers=admin).status_code == 404


def test_discount_beyond_accommodation_is_labelled_not_round_off():
    b = make_bill(nights=1, rate=1200, services=[LAUNDRY, WATER], discount=1250)
    html = B._build_bill_html(b)
    assert _v2_total(html) == pytest.approx(b["total_amount"], abs=0.005)
    m = re.search(r"<tr><td>(Round-off|Less: discount on other items|Adjustment)</td><td[^>]*>([^<]+)</td>", html)
    if m and m.group(1) == "Round-off":
        assert float(m.group(2).split()[-1].replace(",", "")) < 1.0
