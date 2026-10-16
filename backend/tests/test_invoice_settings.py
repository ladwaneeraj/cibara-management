import io

import pytest
from PIL import Image

from routes import billing as B
from tests.conftest import DB
from tests.fakes import fake_firebase as F
from cibara_api.invoice import render as R
from tests.test_invoice import make_bill


def _png(w=40, h=20, fmt="PNG"):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (10, 20, 30)).save(buf, format=fmt)
    return buf.getvalue()


@pytest.fixture(autouse=True)
def _fresh():
    R.branding.cache_clear()
    yield
    R.branding.cache_clear()


def test_admin_sets_text_and_upi_and_invoice_uses_them(client, admin):
    r = client.put("/api/v2/settings/invoice", headers=admin, json={
        "email": "desk@cibara.in", "terms": ["Check-out 11 AM", "  "], "upi_vpa": "cibara@okaxis",
        "upi_payee_name": "Cibara Comforts", "signatory_label": "Manager"})
    assert r.status_code == 200, r.text
    s = r.json()["settings"]
    assert s["terms"] == ["Check-out 11 AM"] and s["upi_vpa"] == "cibara@okaxis"
    html = B._build_bill_html(make_bill(nights=1, rate=1200, cash=200))
    assert "desk@cibara.in" in html and "Check-out 11 AM" in html and "Manager" in html
    assert "Scan to pay" in html and "cibara@okaxis" in html
    acts = [d["action"] for d in DB.dump("audit_logs").values()]
    assert "settings.invoice_update" in acts


def test_bad_upi_id_rejected(client, admin):
    r = client.put("/api/v2/settings/invoice", headers=admin, json={"upi_vpa": "not a vpa"})
    assert r.status_code == 422


def test_manager_cannot_change_invoice_settings(client, manager):
    assert client.put("/api/v2/settings/invoice", headers=manager, json={}).status_code == 403
    assert client.post("/api/v2/settings/invoice/images/logo", headers=manager,
                       files={"file": ("l.png", _png(), "image/png")}).status_code == 403


@pytest.mark.parametrize("kind", ["logo", "signature", "upi_qr"])
def test_upload_preview_and_remove_image(client, admin, kind):
    big = _png(2000, 1000, "JPEG")
    r = client.post(f"/api/v2/settings/invoice/images/{kind}", headers=admin,
                    files={"file": ("x.jpg", big, "image/jpeg")})
    assert r.status_code == 200, r.text
    assert r.json()["images"][kind]["set"] is True
    stored = F.FAKE_BUCKET._objects[f"branding/{kind}.png"]["data"]
    img = Image.open(io.BytesIO(stored))
    assert img.format == "PNG" and max(img.size) <= 800           # re-encoded + downscaled
    assert client.get(f"/api/v2/settings/invoice/images/{kind}", headers=admin).content == stored
    html = B._build_bill_html(make_bill(nights=1, rate=1200, cash=200))   # balance due
    assert "data:image/png;base64," in html
    r = client.delete(f"/api/v2/settings/invoice/images/{kind}", headers=admin)
    assert r.status_code == 200 and r.json()["images"][kind]["set"] is False
    assert client.get(f"/api/v2/settings/invoice/images/{kind}", headers=admin).status_code == 404


def test_static_upi_qr_used_only_without_upi_id(client, admin):
    client.post("/api/v2/settings/invoice/images/upi_qr", headers=admin,
                files={"file": ("q.png", _png(), "image/png")})
    due = B._build_bill_html(make_bill(nights=1, rate=1200, cash=200))
    paid = B._build_bill_html(make_bill(nights=1, rate=1200, cash=1200))
    assert "Scan to pay" in due and "Scan to pay" not in paid


@pytest.mark.parametrize("payload", [b"not an image", b"GIF89a" + b"\x00" * 50])
def test_non_images_rejected(client, admin, payload):
    r = client.post("/api/v2/settings/invoice/images/logo", headers=admin,
                    files={"file": ("x.png", payload, "image/png")})
    assert r.status_code == 400


def test_too_large_upload_rejected(client, admin):
    r = client.post("/api/v2/settings/invoice/images/logo", headers=admin,
                    files={"file": ("x.png", b"0" * (2 * 1024 * 1024 + 10), "image/png")})
    assert r.status_code == 413
