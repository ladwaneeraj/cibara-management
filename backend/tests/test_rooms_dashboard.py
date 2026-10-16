import uuid
from datetime import datetime, timedelta

import pytest

from tests.conftest import DB
from tests.test_parity import V2Driver

import config
from cibara_api.routers import dashboard as dash


def _post(client, h, path, body):
    return client.post(path, json=body, headers={**h, "X-Op-Id": uuid.uuid4().hex})


def test_dashboard_shape_for_admin(client, admin):
    V2Driver(client, admin).checkin("201", name="ravi", mobile="9876543210", guests=2, price=1500,
                                    paid=1000, payment="cash")
    r = client.get("/api/v2/dashboard", headers=admin)
    assert r.status_code == 200
    d = r.json()
    ids = [x["id"] for x in d["rooms"]]
    assert ids == sorted(ids, key=lambda s: int(s))  # numeric order
    room = next(x for x in d["rooms"] if x["id"] == "201")
    assert room["status"] == "occupied" and room["balance"] == 500
    assert room["_renewal"]["day"] == 1 and room["_renewal"]["due"] is False
    assert room["category"] == "premium"
    assert d["stats"]["occupied"] == 1 and d["stats"]["balances_total"] == 500
    assert d["today_summary"]["cash"] == 1000
    assert "totals" in d and d["totals"]["cash"] == 1000
    assert int(r.headers["x-firestore-reads"]) > 0


def test_dashboard_hides_money_from_housekeeping(client, staff):
    d = client.get("/api/v2/dashboard", headers=staff).json()
    assert d["success"] is True
    assert "totals" not in d and "today_summary" not in d and "logs" not in d
    assert len(d["rooms"]) > 0


def test_renewal_status_rule():
    now = datetime(2026, 10, 6, 14, 0)
    occ = {"status": "occupied", "guest": {"name": "x"}, "checkin_time": "2026-10-05 13:00", "renewal_count": 0}
    st = dash.renewal_status(occ, now)
    assert st["due"] is True and st["day"] == 1
    occ["renewal_count"] = 1
    st = dash.renewal_status(occ, now)
    assert st["due"] is False and st["day"] == 2 and st["minutes_left"] == 23 * 60
    assert dash.renewal_status({"status": "vacant"}, now)["due"] is False


def test_stats_counts_service_cleaning_and_skips_mmt_prepaid():
    now = datetime(2026, 10, 6, 10, 0)
    rooms = [
        {"status": "vacant"},
        {"status": "cleaning"},
        {"status": "occupied", "guest": {"payment": "ota"}, "balance": 0, "service_cleaning": {"room": True},
         "checkin_time": "2026-10-06 09:00"},
        {"status": "occupied", "guest": {"payment": "cash"}, "balance": 300, "checkin_time": "2026-10-04 09:00",
         "renewal_count": 0},
    ]
    for r in rooms:
        r["_renewal"] = dash.renewal_status(r, now)
    s = dash.compute_stats(rooms, now)
    assert s == {"vacant": 1, "occupied": 2, "cleaning": 2, "balances_total": 300, "balances_count": 1,
                 "renewals_due": 1, "total": 4}


def test_checkin_validation_errors(client, admin):
    r = _post(client, admin, "/api/v2/rooms/201/checkin",
              {"name": "x", "mobile": "12345", "guests": 1, "price": 100, "payment": "cash"})
    assert r.status_code == 422 and r.json()["message"].startswith("mobile")
    r = _post(client, admin, "/api/v2/rooms/201/checkin",
              {"name": "x", "mobile": "9999999999", "guests": 1, "price": 100, "payment": "balance",
               "amount_paid": 50})
    assert r.status_code == 422 and "Pay Later" in r.json()["message"]
    r = _post(client, admin, "/api/v2/rooms/201/checkin",
              {"name": "x", "mobile": "9999999999", "guests": 1, "price": 100, "payment": "upi"})
    assert r.status_code == 422  # arbitrary strings can no longer become totals fields


def test_checkin_forces_ac_off_outside_premium(client, admin):
    V2Driver(client, admin).checkin("207", name="a", mobile="9999999999", guests=1, price=450, paid=450,
                                    payment="cash", is_ac=True)
    assert DB.dump("rooms")["207"]["guest"]["isAC"] is False


def test_occupied_room_rejected_by_legacy_logic(client, admin):
    d = V2Driver(client, admin)
    d.checkin("201", name="a", mobile="9999999999", guests=1, price=1200, paid=1200, payment="cash")
    r = _post(client, admin, "/api/v2/rooms/201/checkin",
              {"name": "b", "mobile": "9888888888", "guests": 1, "price": 1200, "payment": "cash",
               "amount_paid": 1200})
    assert r.json()["success"] is False and "already occupied" in r.json()["message"]


def test_duplicate_submit_guard_passes_through(client, admin):
    body = {"name": "dup", "mobile": "9999999999", "guests": 1, "price": 1200, "payment": "cash",
            "amount_paid": 1200}
    op = uuid.uuid4().hex
    r1 = client.post("/api/v2/rooms/201/checkin", json=body, headers={**admin, "X-Op-Id": op})
    r2 = client.post("/api/v2/rooms/201/checkin", json=body, headers={**admin, "X-Op-Id": op})
    assert r1.json()["success"] is True
    assert r2.json().get("replayed") is True  # exact replay, nothing written twice
    assert DB.dump("totals")["current_totals"]["cash"] == 1200


def test_refund_uses_ist_date(client, admin):
    d = V2Driver(client, admin)
    d.checkin("24", name="m", mobile="9000000003", guests=2, price=500, paid=700, payment="cash")
    d.refund("24", 200, "cash")
    refunds = [p for p in DB.dump("payments").values() if p.get("type") == "manual_refund"]
    assert refunds and refunds[0]["date"] == datetime.now(config.IST).strftime("%Y-%m-%d")


def test_checkout_blocks_unpaid_balance(client, admin):
    d = V2Driver(client, admin)
    d.checkin("201", name="a", mobile="9999999999", guests=1, price=1200, paid=0, payment="balance")
    r = _post(client, admin, "/api/v2/rooms/201/checkout", {})
    assert r.json() == {"success": False, "message": "Please clear the balance before checkout"}


def test_settle_later_flow_creates_settlement(client, admin):
    d = V2Driver(client, admin)
    d.checkin("201", name="a", mobile="9999999999", guests=1, price=1200, paid=200, payment="cash")
    d.checkout("201", settle_later=True, notes="next week")
    bill = next(iter(DB.dump("bills").values()))
    assert bill["status"] == "pending_settlement" and bill["balance"] == 1000
    sett = next(iter(DB.dump("settlements").values()))
    assert sett["amount"] == 1000 and sett["status"] == "pending"
    r = client.get("/api/v2/settlements", headers=admin).json()
    assert r["count"] == 1 and r["total_due"] == 1000
    sid = r["settlements"][0]["id"]
    c = _post(client, admin, f"/api/v2/settlements/{sid}/collect", {"payment_mode": "cash", "payment_amount": 1000})
    assert c.json()["success"] is True, c.json()
    assert c.json()["fully_paid"] is True
    assert client.get("/api/v2/settlements", headers=admin).json()["count"] == 0
    assert client.get("/api/v2/settlements?status=paid", headers=admin).json()["count"] == 1


def test_cleaning_cycle(client, admin, staff):
    d = V2Driver(client, admin)
    d.checkin("5", name="a", mobile="9999999999", guests=1, price=250, paid=250, payment="cash")
    d.checkout("5")
    assert DB.dump("rooms")["5"]["status"] == "cleaning"
    r = _post(client, staff, "/api/v2/rooms/5/cleaned", {})
    assert r.json()["success"] is True
    assert DB.dump("rooms")["5"]["cleaning_status"] == "ready_to_inspect"
    assert _post(client, staff, "/api/v2/rooms/5/ready", {}).status_code == 403
    r = _post(client, admin, "/api/v2/rooms/5/ready", {"checklist": {"room_ready": True}})
    assert r.json()["success"] is True
    assert DB.dump("rooms")["5"]["status"] == "vacant"


def test_housekeeping_request_toggle(client, admin):
    d = V2Driver(client, admin)
    d.checkin("201", name="a", mobile="9999999999", guests=1, price=1200, paid=1200, payment="cash")
    assert _post(client, admin, "/api/v2/rooms/201/housekeeping", {}).status_code == 422
    r = _post(client, admin, "/api/v2/rooms/201/housekeeping", {"room_clean": True})
    assert r.json()["success"] is True
    assert DB.dump("rooms")["201"]["service_cleaning"]["room"] is True


def test_history_and_customer_lookup(client, admin):
    d = V2Driver(client, admin)
    d.checkin("201", name="ravi", mobile="9876543210", guests=1, price=1200, paid=1200, payment="cash")
    room = DB.dump("rooms")["201"]
    r = client.get("/api/v2/rooms/201/history", headers=admin,
                   params={"name": room["guest"]["name"], "checkin_time": room["checkin_time"],
                           "stay_id": room["active_bill_id"]}).json()
    assert r["success"] and sum(p["amount"] for p in r["cash"]) == 1200
    c = client.get("/api/v2/customers/lookup", headers=admin, params={"mobile": "9876543210"}).json()
    assert c["success"] and c["customer"]["mobile"] == "9876543210"
    s = client.get("/api/v2/customers/suggest", headers=admin, params={"prefix": "98765"}).json()
    assert s["success"] and len(s["customers"]) == 1


def test_transfer_same_category(client, admin):
    d = V2Driver(client, admin)
    d.checkin("201", name="a", mobile="9999999999", guests=2, price=1200, paid=1200, payment="cash")
    r = _post(client, admin, "/api/v2/rooms/201/transfer", {"new_room": "202"})
    assert r.json()["success"] is True and r.json()["cross_category"] is False
    rooms = DB.dump("rooms")
    assert rooms["202"]["status"] == "occupied" and rooms["201"]["status"] == "cleaning"


def test_room_numbers(client, admin):
    r = client.get("/api/v2/rooms/numbers", headers=admin).json()
    assert r["success"] and "201" in r["rooms"]


@pytest.mark.parametrize("path", ["/api/v2/rooms/../etc/checkin", "/api/v2/rooms/a%20b/checkin"])
def test_room_id_validation(client, admin, path):
    r = client.post(path, json={}, headers=admin)
    assert r.status_code in (404, 422)


def test_dashboard_upcoming_bookings_passthrough(client, admin):
    tomorrow = (datetime.now(config.IST) + timedelta(hours=2)).strftime("%Y-%m-%d")
    DB.collection("bookings").document("bk1").set({
        "room": "203", "guest_name": "Arrival", "check_in_date": tomorrow, "check_in_time": "23:59",
        "check_out_date": tomorrow, "status": "confirmed", "paid_amount": 0, "total_amount": 1000})
    d = client.get("/api/v2/dashboard?fresh=true", headers=admin).json()
    assert isinstance(d["upcoming"], dict)


def test_tariffs_come_from_server_table(client, staff):
    t = client.get("/api/v2/rooms/tariffs", headers=staff).json()["tariffs"]
    assert t["201"]["prices"]["2"] == 1200 and t["201"]["prices"]["3"] == 1500 and t["201"]["ac_surcharge"] == 600
    assert t["207"]["ac_surcharge"] == 0 and t["207"]["prices"]["1"] == 450
    assert t["221"]["prices"]["2"] == 1000
    assert t["25"]["default_guests"] == 2 and t["1"]["default_guests"] == 1


def test_settlements_native_filter_matches_legacy(client, admin):
    from tests.conftest import DB as _DB
    for i, st in enumerate(["pending", "partial", "paid", "cancelled", "pending"]):
        _DB.collection("settlements").document(f"s{i}").set({
            "id": f"s{i}", "guest_name": f"G{i}", "guest_mobile": "9", "room": "201", "amount": 100 * (i + 1),
            "checkout_date": f"2026-10-0{i + 1}", "checkout_time": "10:00", "status": st})
    legacy_all = client.get("/get_pending_settlements", headers=admin).json()["settlements"]
    want_open = sorted(r["id"] for r in legacy_all if r["status"] in ("pending", "partial"))
    got = client.get("/api/v2/settlements", headers=admin).json()
    assert sorted(r["id"] for r in got["settlements"]) == want_open
    assert got["total_due"] == 100 + 200 + 500
    assert [r["id"] for r in got["settlements"]] == ["s4", "s1", "s0"]  # newest first
    assert client.get("/api/v2/settlements?status=all", headers=admin).json()["count"] == 5
    assert client.get("/api/v2/settlements?status=cancelled", headers=admin).json()["count"] == 1


def test_photo_upload_facade(client, admin, staff):
    from tests.test_parity import V2Driver
    V2Driver(client, admin).checkin("210", name="a", mobile="9999999999", guests=1, price=450, paid=450, payment="cash")
    V2Driver(client, admin).checkout("210")
    import io
    jpeg = b"\xff\xd8\xff\xe0" + b"0" * 2000
    r = client.post("/api/v2/rooms/210/photos", headers=staff,
                    data={"kind": "washroom", "context": "cleaning"},
                    files={"photo": ("w.jpg", io.BytesIO(jpeg), "image/jpeg"), "thumb": ("t.jpg", io.BytesIO(jpeg), "image/jpeg")})
    assert r.status_code == 200, r.text
    assert r.json()["success"] and r.json()["url"]
    bad = client.post("/api/v2/rooms/210/photos", headers=staff, data={"kind": "washroom"},
                      files={"photo": ("w.gif", io.BytesIO(b"GIF89a"), "image/gif")})
    assert bad.status_code == 400
    big = client.post("/api/v2/rooms/210/photos", headers=staff, data={"kind": "bed"},
                      files={"photo": ("w.jpg", io.BytesIO(b"0" * (3 * 1024 * 1024 + 10)), "image/jpeg")})
    assert big.status_code == 413
