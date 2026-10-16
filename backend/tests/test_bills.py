import uuid
from datetime import datetime, timedelta

from tests.conftest import DB
from tests.test_parity import V2Driver

import config

TODAY = datetime.now(config.IST).strftime("%Y-%m-%d")


def _seed_bills(n, day=TODAY, start_minute=0, **extra):
    """Insert n finalized bills directly (fast) with distinct checkout times."""
    for i in range(n):
        m = start_minute + i
        bid = f"seed{day.replace('-', '')}{m:05d}"
        DB.collection("bills").document(bid).set({
            "status": "completed", "bill_number": f"CC/{day[:4]}/{day[5:7]}/{m + 1:05d}",
            "room": str(200 + (i % 7)), "guest_name": f"Guest {m}", "guest_mobile": f"98{m:08d}",
            "checkin_time": f"{day} 00:00", "checkout_time": f"{day} {m // 60 % 24:02d}:{m % 60:02d}",
            "days_stayed": 1, "total_amount": 1000 + i, "payment_cash": 1000 + i, "payment_online": 0,
            "balance": 0, "room_charges_total": 1000 + i, "services_total": 0, "discounts": 0,
            "gst_rate": 5, "accommodation_taxable": round((1000 + i) / 1.05, 2),
            "gst_amount": round((1000 + i) - (1000 + i) / 1.05, 2), "invoice_type": "B2C", **extra})


def test_list_paginates_without_gaps_or_duplicates(client, admin):
    _seed_bills(130)
    seen, cursor, pages = [], None, 0
    while True:
        params = {"start": TODAY, "end": TODAY, "limit": 50}
        if cursor:
            params["cursor"] = cursor
        r = client.get("/api/v2/bills", headers=admin, params=params).json()
        assert r["success"]
        seen += [b["id"] for b in r["bills"]]
        pages += 1
        cursor = r["next_cursor"]
        if not cursor:
            break
    assert pages == 3
    assert len(seen) == len(set(seen)) == 130
    cts = [DB.dump("bills")[i]["checkout_time"] for i in seen]
    assert cts == sorted(cts, reverse=True)


def test_list_ties_on_same_minute(client, admin):
    for i in range(12):
        DB.collection("bills").document(f"tie{i:02d}").set({
            "status": "completed", "bill_number": f"CC/2026/10/{i:05d}", "room": "201",
            "guest_name": "T", "checkin_time": f"{TODAY} 00:00", "checkout_time": f"{TODAY} 10:00",
            "total_amount": 100, "payment_cash": 100, "balance": 0})
    got, cursor = [], None
    while True:
        params = {"start": TODAY, "end": TODAY, "limit": 5}
        if cursor:
            params["cursor"] = cursor
        r = client.get("/api/v2/bills", headers=admin, params=params).json()
        got += [b["id"] for b in r["bills"]]
        cursor = r["next_cursor"]
        if not cursor:
            break
    assert sorted(got) == [f"tie{i:02d}" for i in range(12)] and len(got) == 12


def test_list_excludes_drafts_and_placeholder_numbers(client, admin):
    _seed_bills(3)
    DB.collection("bills").document("draft1").set({"status": "draft", "bill_number": None, "room": "1",
                                                   "checkin_time": f"{TODAY} 01:00"})
    DB.collection("bills").document("nobill").set({"status": "completed", "bill_number": "-", "room": "1",
                                                   "checkin_time": f"{TODAY} 01:00",
                                                   "checkout_time": f"{TODAY} 02:00"})
    DB.collection("bills").document("manualcancel").set({
        "status": "cancelled", "cancel_kind": "manual", "bill_number": "CC/2026/10/09999", "room": "1",
        "checkin_time": f"{TODAY} 01:00", "checkout_time": f"{TODAY} 03:00", "total_amount": 500})
    r = client.get("/api/v2/bills", headers=admin, params={"start": TODAY, "end": TODAY}).json()
    ids = {b["id"] for b in r["bills"]}
    assert "draft1" not in ids and "nobill" not in ids and "manualcancel" in ids
    cancelled = next(b for b in r["bills"] if b["id"] == "manualcancel")
    assert cancelled["gst"] == {"tax": 0, "taxable": 0, "label": "-"}


def test_list_filters_and_search(client, admin):
    _seed_bills(10)
    DB.collection("bills").document("b2b").set({
        "status": "pending_settlement", "bill_number": "CC/2026/10/00777", "room": "207",
        "guest_name": "Acme Guest", "guest_mobile": "9111111111", "invoice_type": "B2B",
        "checkin_time": f"{TODAY} 00:00", "checkout_time": f"{TODAY} 09:30", "total_amount": 2000,
        "payment_cash": 500, "payment_online": 500, "balance": 1000})
    q = lambda **kw: client.get("/api/v2/bills", headers=admin,  # noqa: E731
                                params={"start": TODAY, "end": TODAY, **kw}).json()["bills"]
    assert [b["id"] for b in q(type="b2b")] == ["b2b"]
    assert [b["id"] for b in q(type="settle_later")] == ["b2b"]
    assert [b["id"] for b in q(payment="pending")] == ["b2b"]
    assert [b["id"] for b in q(payment="split")] == ["b2b"]
    assert [b["id"] for b in q(q="acme")] == ["b2b"]
    assert [b["id"] for b in q(q="00777")] == ["b2b"]
    assert len(q(payment="cash")) == 10


def test_summary_matches_legacy_tally_math(client, admin):
    _seed_bills(4)
    DB.collection("bills").document("due").set({
        "status": "completed", "bill_number": "CC/2026/10/00500", "room": "201", "guest_name": "D",
        "checkin_time": f"{TODAY} 00:00", "checkout_time": f"{TODAY} 05:00", "total_amount": 1000,
        "payment_cash": 200, "payment_online": 300, "balance": 500})
    s = client.get("/api/v2/bills/summary", headers=admin, params={"start": TODAY, "end": TODAY}).json()["summary"]
    assert s["invoices"] == 5
    # static/bills.js renderTally: a bill with balance > 0 adds nothing to
    # Cash/UPI (its 200 cash + 300 online part-payments are excluded).
    assert s["cash"] == sum(1000 + i for i in range(4))
    assert s["online"] == 0
    assert s["revenue"] == sum(1000 + i for i in range(4))  # bills with balance <= 0
    assert s["pending_count"] == 1 and s["pending_amount"] == 500


def test_manager_is_clamped_to_three_days(client, admin, manager):
    old = (datetime.now(config.IST) - timedelta(days=10)).strftime("%Y-%m-%d")
    _seed_bills(2, day=old)
    _seed_bills(2)
    a = client.get("/api/v2/bills", headers=admin, params={"start": old, "end": TODAY}).json()
    m = client.get("/api/v2/bills", headers=manager, params={"start": old, "end": TODAY}).json()
    assert len(a["bills"]) == 4 and len(m["bills"]) == 2
    assert m["range"]["from"] > old


def test_staff_cannot_see_bills(client, staff):
    assert client.get("/api/v2/bills", headers=staff, params={"start": TODAY, "end": TODAY}).status_code == 403


def test_bill_detail_html_pdf_and_actions(client, admin, manager):
    V2Driver(client, admin).checkin("201", name="ravi", mobile="9876543210", guests=1, price=1200, paid=1200,
                                    payment="cash")
    V2Driver(client, admin).checkout("201")
    bill_id = next(iter(DB.dump("bills")))
    lst = client.get("/api/v2/bills", headers=admin, params={"start": TODAY, "end": TODAY}).json()["bills"]
    assert lst[0]["id"] == bill_id and lst[0]["gst"]["label"] == "5%"
    assert lst[0]["gst"]["tax"] == round(config.bill_tax_breakup(DB.dump("bills")[bill_id])["tax"], 2)

    d = client.get(f"/api/v2/bills/{bill_id}", headers=admin).json()["bill"]
    assert d["id"] == bill_id and d["tax_breakup"]["rows"]
    h = client.get(f"/api/v2/bills/{bill_id}/html", headers=admin, params={"view": "consolidated"}).json()
    assert h["success"] and "b-bill-wrap" in h["html"]
    pdf = client.post(f"/api/v2/bills/{bill_id}/pdf", headers=admin, json={"force": True}).json()
    assert pdf["success"] and pdf["pdf_url"].startswith("https://")

    g = client.patch(f"/api/v2/bills/{bill_id}/guest", headers=manager,
                     json={"guest_name": "Ravi K", "guest_mobile": "9876500000"}).json()
    assert g["success"] and DB.dump("bills")[bill_id]["guest_name"] == "Ravi K"
    assert client.patch(f"/api/v2/bills/{bill_id}/gst", headers=manager,
                        json={"recipient_gstin": "29ABCDE1234F1Z5"}).status_code == 403
    gst = client.patch(f"/api/v2/bills/{bill_id}/gst", headers=admin,
                       json={"recipient_gstin": "29abcde1234f1z5", "recipient_legal_name": "Acme"}).json()
    assert gst["success"] and gst["invoice_type"] == "B2B"
    act = client.post(f"/api/v2/bills/{bill_id}/activity", headers=manager, json={"kind": "print"}).json()
    assert act["success"]
    audit = client.get(f"/api/v2/bills/{bill_id}/audit", headers=admin).json()
    assert audit["success"]


def test_cancel_bill_requires_admin_and_reason(client, admin, manager):
    V2Driver(client, admin).checkin("201", name="dup", mobile="9876543210", guests=1, price=1200, paid=0,
                                    payment="balance")
    V2Driver(client, admin).payment("201", 1200, "cash")
    V2Driver(client, admin).checkout("201")
    bill_id = next(iter(DB.dump("bills")))
    body = {"reason": "Duplicate room entry by mistake", "confirm": True}
    assert client.post(f"/api/v2/bills/{bill_id}/cancel", headers=manager, json=body).status_code == 403
    assert client.post(f"/api/v2/bills/{bill_id}/cancel", headers=admin,
                       json={"reason": "short", "confirm": True}).status_code == 422
    r = client.post(f"/api/v2/bills/{bill_id}/cancel", headers={**admin, "X-Op-Id": uuid.uuid4().hex}, json=body)
    data = r.json()
    # money was received → legacy refuses with HAS_RECEIPTS unless receipts are removed
    assert data["success"] is False and data["code"] == "HAS_RECEIPTS"


def test_bill_payment_maps_bad_debt_flag(client, admin, monkeypatch):
    from cibara_api.routers import bills as bills_router
    seen = {}

    async def fake_forward(p, request, method, path, **kw):
        seen.update(kw.get("json") or {})
        from fastapi.responses import JSONResponse
        return JSONResponse({"success": True})
    monkeypatch.setattr(bills_router, "forward", fake_forward)
    r = client.post("/api/v2/bills/abc/payments", headers=admin,
                    json={"amount": 0, "discount": 100, "bad_debt": True, "discount_reason": "write off"})
    assert r.status_code == 200 and seen["is_bad_debt"] is True and "bad_debt" not in seen
    assert client.post("/api/v2/bills/abc/payments", headers=admin, json={}).status_code == 400


def test_credit_notes_and_gst_endpoints(client, admin):
    r = client.get("/api/v2/credit-notes", headers=admin, params={"start": TODAY, "end": TODAY}).json()
    assert r["success"] and r["count"] == 0
    assert client.get("/api/v2/gst/recipients", headers=admin).json()["success"]
    locks = client.get("/api/v2/gst/locks", headers=admin).json()
    assert locks["success"] and len(locks["locks"]) > 0
