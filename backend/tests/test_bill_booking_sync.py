"""Collecting money on a bill must keep the linked booking card in step.

Repro for the dashboard bug: a booking checked in with a part-advance shows
"Partially Paid" on its room card forever, because payments land on the bill
doc (add_bill_payment) while the booking card reads the booking doc's own
paid_amount / balance. The booking is linked to its bill by stay_id == bill_id.
"""
import config

TODAY = __import__("datetime").datetime.now(config.IST).strftime("%Y-%m-%d")


def _seed(bill_id, *, total, paid, balance):
    """A live stay: bill with an outstanding balance + its booking doc."""
    config.bills_ref.document(bill_id).set({
        "status": "draft", "room": "201", "guest_name": "Ravi",
        "bill_number": "CC/2026/11/00167", "checkin_time": f"{TODAY} 12:00",
        "total_amount": total, "payment_cash": paid, "payment_online": 0,
        "balance": balance,
    })
    config.bookings_ref.document("bk1").set({
        "stay_id": bill_id, "room": "201", "status": "checked_in",
        "booking_source": "web", "total_amount": total,
        "paid_amount": paid, "balance": balance,
    })


def _booking():
    return config.bookings_ref.document("bk1").get().to_dict()


def test_full_settle_marks_booking_fully_paid(client, admin):
    _seed("stay_full", total=1200, paid=500, balance=700)
    r = client.post("/api/v2/bills/stay_full/payments", headers=admin,
                    json={"amount": 700, "payment_mode": "cash"})
    assert r.status_code == 200 and r.json()["success"]
    b = _booking()
    # Card shows "Fully Paid" only when paid_amount == total_amount.
    assert b["paid_amount"] == 1200 and b["balance"] == 0


def test_partial_payment_lowers_booking_balance(client, admin):
    _seed("stay_part", total=1200, paid=500, balance=700)
    r = client.post("/api/v2/bills/stay_part/payments", headers=admin,
                    json={"amount": 300, "payment_mode": "online"})
    assert r.status_code == 200 and r.json()["success"]
    b = _booking()
    assert b["paid_amount"] == 800 and b["balance"] == 400


def test_walkin_bill_without_booking_doc_is_a_noop(client, admin):
    # No booking doc for this stay — the sync must not error.
    config.bills_ref.document("stay_walkin").set({
        "status": "draft", "room": "202", "guest_name": "Sita",
        "checkin_time": f"{TODAY} 12:00", "total_amount": 900,
        "payment_cash": 0, "payment_online": 0, "balance": 900,
    })
    r = client.post("/api/v2/bills/stay_walkin/payments", headers=admin,
                    json={"amount": 900, "payment_mode": "cash"})
    assert r.status_code == 200 and r.json()["success"]
