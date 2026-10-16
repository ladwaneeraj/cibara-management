"""
Old-vs-new parity: the same desk scenario is driven twice on an identical
fresh database —

  legacy : the payloads the old browser UI sent, to the old Flask paths,
           authenticated with a Firebase ID token (the old UI's auth);
  v2     : the new typed /api/v2 endpoints, authenticated with the new JWT.

The resulting bill (all money, GST and folio fields), the room, the running
totals and the payment ledger must be identical. GST, bill generation and
settle-later logic are the critical paths named in the migration brief.
"""
from __future__ import annotations

import copy
import uuid
from datetime import datetime

import pytest

from tests.conftest import DB, login, make_user

import config

_BILL_FIELDS = (
    "status", "bill_number", "room", "guest_name", "guest_mobile", "guest_count", "is_ac",
    "days_stayed", "room_price_per_night", "room_charges_total", "services_total", "discounts",
    "refunds", "refund_cash", "refund_online", "total_amount", "payment_cash", "payment_online",
    "payment_ota", "balance", "gst_rate", "accommodation_taxable", "non_accommodation_total",
    "gst_amount", "cgst_amount", "sgst_amount", "igst_amount", "sac_or_hsn", "round_off",
    "invoice_type", "recipient_gstin", "recipient_legal_name", "recipient_state_code",
    "booking_source", "payment_source", "invoice_generated", "serial_number",
)
_VOLATILE = {"day_start", "day_end", "time", "date", "applied_on_date", "created_at", "addon_uid",
             "stay_id", "idempotency_key", "createdBy", "stay_room_key", "settlement_id", "id",
             "checkout_time", "checkout_date", "checkin_time", "payment_time",
             "cash_receipt_id", "officialized_at", "receipt_issued_at", "receipt_no", "voidedAt"}


def _strip(o):
    if isinstance(o, dict):
        return {k: _strip(v) for k, v in o.items() if k not in _VOLATILE}
    if isinstance(o, list):
        return [_strip(v) for v in o]
    return o


def _ist_now():
    return datetime.now(config.IST)


class LegacyDriver:
    """Speaks exactly what static/script.js & friends sent."""

    def __init__(self, client, uid):
        self.c = client
        self.h = {"Authorization": f"Bearer fbid:{uid}"}

    def _post(self, path, body):
        r = self.c.post(path, json=body, headers={**self.h, "X-Op-Id": uuid.uuid4().hex})
        assert r.status_code == 200 and r.json().get("success") is not False, (path, r.status_code, r.text)
        return r.json()

    def checkin(self, room, *, name, mobile, guests, price, paid, payment, is_ac=False, gst_profile=None):
        return self._post("/checkin", {"room": room, "name": name, "mobile": mobile, "address": "",
                                       "price": str(price), "guests": str(guests), "payment": payment,
                                       "amountPaid": paid, "photoPath": None, "isAC": is_ac,
                                       "checkin_time": None, "gst_profile": gst_profile})

    def payment(self, room, amount, mode):
        return self._post("/checkout", {"room": room, "payment_mode": mode, "amount": amount, "is_refund": False})

    def refund(self, room, amount, mode):
        now = _ist_now()
        return self._post("/checkout", {"room": room, "name": "x", "payment_mode": mode, "amount": amount,
                                         "is_refund": True, "process_refund": True,
                                         "time": now.strftime("%H:%M"), "date": now.strftime("%Y-%m-%d")})

    def addon(self, room, item, unit, qty, method, accom=False):
        return self._post("/add_on", {"room": room, "item": item, "price": unit * qty, "unit_price": unit,
                                      "quantity": qty, "payment_method": method,
                                      "accommodation_charge": accom})

    def renew(self, room):
        n = (DB.dump("rooms")[room].get("renewal_count") or 0) + 1
        return self._post("/renew_rent", {"room": room, "renewal_count": n})

    def discount(self, room, amount, reason):
        return self._post("/apply_discount", {"room": room, "amount": amount, "reason": reason})

    def checkout(self, room, *, settle_later=False, notes="", gst_profile=None):
        snapshot = copy.deepcopy(DB.dump("rooms")[room])  # prevRoomState
        return self._post("/checkout", {"room": room, "final_checkout": True, "refund_method": None,
                                        "settle_later": settle_later, "settlement_notes": notes,
                                        "room_data": snapshot, "gst_profile": gst_profile})


class V2Driver:
    def __init__(self, client, headers):
        self.c = client
        self.h = headers

    def _post(self, path, body):
        r = self.c.post(path, json=body, headers={**self.h, "X-Op-Id": uuid.uuid4().hex})
        assert r.status_code == 200 and r.json().get("success") is not False, (path, r.status_code, r.text)
        return r.json()

    def checkin(self, room, *, name, mobile, guests, price, paid, payment, is_ac=False, gst_profile=None):
        return self._post(f"/api/v2/rooms/{room}/checkin", {
            "name": name, "mobile": mobile, "guests": guests, "price": price, "amount_paid": paid,
            "payment": payment, "is_ac": is_ac, "gst_profile": gst_profile})

    def payment(self, room, amount, mode):
        return self._post(f"/api/v2/rooms/{room}/payment", {"amount": amount, "mode": mode})

    def refund(self, room, amount, mode):
        return self._post(f"/api/v2/rooms/{room}/refund", {"amount": amount, "mode": mode})

    def addon(self, room, item, unit, qty, method, accom=False):
        return self._post(f"/api/v2/rooms/{room}/addons", {"item": item, "unit_price": unit, "quantity": qty,
                                                            "payment_method": method,
                                                            "accommodation_charge": accom})

    def renew(self, room):
        n = (DB.dump("rooms")[room].get("renewal_count") or 0) + 1
        return self._post(f"/api/v2/rooms/{room}/renew", {"renewal_count": n})

    def discount(self, room, amount, reason):
        return self._post(f"/api/v2/rooms/{room}/discount", {"amount": amount, "reason": reason})

    def checkout(self, room, *, settle_later=False, notes="", gst_profile=None):
        return self._post(f"/api/v2/rooms/{room}/checkout", {"settle_later": settle_later,
                                                              "settlement_notes": notes,
                                                              "gst_profile": gst_profile})


def _allow_next_renewal(room):
    """/renew_rent allows one renewal per IST calendar day; simulate the next day."""
    DB.collection("rooms").document(room).update({"last_renewal_date": "2000-01-01"})


GST_CO = {"gstin": "29ABCDE1234F1Z5", "legal_name": "Acme Pvt Ltd", "trade_name": "Acme",
          "address": "MG Road, Bengaluru", "state": "Karnataka", "state_code": "29"}


def s_simple(d):
    d.checkin("201", name="ravi kumar", mobile="9876543210", guests=2, price=1200, paid=1200, payment="cash")
    d.addon("201", "Water 1L", 20, 2, "cash")
    d.checkout("201")
    return "201"


def s_exempt_then_slab(d):
    d.checkin("15", name="asha", mobile="9000000001", guests=1, price=900, paid=0, payment="balance")
    d.addon("15", "Extra Bed", 300, 1, "balance", accom=True)
    d.payment("15", 1200, "online")
    d.checkout("15")
    return "15"


def s_multi_night_discount_settle_later(d):
    d.checkin("223", name="vijay", mobile="9000000002", guests=2, price=1800, paid=1000, payment="online")
    _allow_next_renewal("223")
    d.renew("223")
    _allow_next_renewal("223")
    d.renew("223")
    d.addon("223", "Water 2L", 30, 3, "balance")
    d.discount("223", 250, "Long Stay")
    d.payment("223", 2000, "cash")
    d.checkout("223", settle_later=True, notes="will pay next visit")
    return "223"


def s_overpay_refund(d):
    d.checkin("24", name="meena", mobile="9000000003", guests=2, price=500, paid=700, payment="cash")
    d.refund("24", 200, "cash")
    d.checkout("24")
    return "24"


def s_high_tariff_18pct(d):
    d.checkin("205", name="corp guest", mobile="9000000004", guests=2, price=8200, paid=8200,
              payment="online", is_ac=True)
    d.checkout("205")
    return "205"


def s_b2b_company(d):
    d.checkin("207", name="sunil", mobile="9000000005", guests=1, price=1500, paid=1500, payment="online",
              gst_profile=GST_CO)
    d.checkout("207", gst_profile=GST_CO)
    return "207"


SCENARIOS = [s_simple, s_exempt_then_slab, s_multi_night_discount_settle_later, s_overpay_refund,
             s_high_tariff_18pct, s_b2b_company]


def _outcome(room):
    bills = DB.dump("bills")
    assert len(bills) == 1, bills.keys()
    bill_id, bill = next(iter(bills.items()))
    out = {k: bill.get(k) for k in _BILL_FIELDS}
    out["daily_folio"] = _strip(bill.get("daily_folio"))
    out["services"] = _strip(bill.get("services"))
    out["room_segments"] = _strip(bill.get("room_segments"))
    out["tax_breakup"] = config.bill_tax_breakup(bill)
    r = DB.dump("rooms")[room]
    out["room"] = {k: r.get(k) for k in ("status", "cleaning_status", "balance", "guest", "active_bill_id")}
    out["totals"] = DB.dump("totals").get("current_totals")
    pays = sorted(
        (_strip({k: v for k, v in p.items() if k not in ("created_at",)}) for p in DB.dump("payments").values()),
        key=lambda p: (p.get("type") or "", p.get("method") or "", p.get("amount") or 0))
    out["payments"] = pays
    sett = list(DB.dump("settlements").values())
    out["settlements"] = [_strip({k: s.get(k) for k in ("amount", "status", "guest_name", "guest_mobile",
                                                        "room", "notes")}) for s in sett]
    return out


def _reset():
    from tests.conftest import _SEED, _SEED_META
    DB._store.docs = copy.deepcopy(_SEED)
    DB._store.meta = dict(_SEED_META)
    config.invalidate_cache()
    from routes import rooms as legacy_rooms
    legacy_rooms._invalidate_get_data_cache()


@pytest.mark.parametrize("scenario", SCENARIOS, ids=lambda f: f.__name__)
def test_bill_parity_legacy_vs_v2(client, scenario):
    rec = make_user("admin", "admin")
    s = login(client, "admin")
    v2 = V2Driver(client, {"Authorization": f"Bearer {s['access_token']}"})
    users_snapshot = copy.deepcopy(DB.dump("users"))

    _reset()
    DB.collection("users").document("admin").set(users_snapshot["admin"])
    room = scenario(LegacyDriver(client, rec.uid))
    legacy_out = _outcome(room)

    _reset()
    DB.collection("users").document("admin").set(users_snapshot["admin"])
    scenario(v2)
    v2_out = _outcome(room)

    assert v2_out == legacy_out
    # sanity: the scenario really produced a GST bill
    assert legacy_out["bill_number"].startswith("CC/")
    assert legacy_out["total_amount"] > 0


def test_known_gst_figures(client, admin):
    """Golden numbers (independent of the legacy run) for the critical formula."""
    v2 = V2Driver(client, admin)
    s_simple(v2)
    b = next(iter(DB.dump("bills").values()))
    # ₹1200 night is in the 5% slab, GST-inclusive: taxable = 1200/1.05
    assert b["total_amount"] == 1240
    assert b["accommodation_taxable"] == pytest.approx(1142.86, abs=0.01)
    assert b["gst_amount"] == pytest.approx(57.14, abs=0.01)
    assert b["cgst_amount"] == pytest.approx(28.57, abs=0.01) and b["sgst_amount"] == pytest.approx(28.57, abs=0.01)
    assert b["igst_amount"] == 0


def test_known_gst_18pct(client, admin):
    v2 = V2Driver(client, admin)
    s_high_tariff_18pct(v2)
    b = next(iter(DB.dump("bills").values()))
    assert b["total_amount"] == 8200
    assert b["accommodation_taxable"] == pytest.approx(8200 / 1.18, abs=0.01)
    assert b["gst_amount"] == pytest.approx(8200 - 8200 / 1.18, abs=0.02)


def test_exempt_night_has_no_gst(client, admin):
    v2 = V2Driver(client, admin)
    v2.checkin("2", name="low", mobile="9111111111", guests=1, price=250, paid=250, payment="cash")
    v2.checkout("2")
    b = next(iter(DB.dump("bills").values()))
    assert b["gst_amount"] == 0 and b["accommodation_taxable"] == 0
