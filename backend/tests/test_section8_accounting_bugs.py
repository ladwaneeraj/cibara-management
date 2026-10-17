"""
Executable, decision-ready documentation of the CLAUDE.md §8 accounting bugs.

Each test asserts the CORRECT behaviour and is marked xfail with its §8
reference, so the suite stays green while giving an at-a-glance list:

    pytest -rx backend/tests/test_section8_accounting_bugs.py

shows one XFAIL per bug with the reason. NONE of these change accounting logic;
they only observe it. When a bug is fixed the matching test XPASSes — the signal
to drop the xfail and promote it to a normal regression test.

These are OWNER DECISIONS (CLAUDE.md §8): do not "fix" them from here.
"""
from __future__ import annotations

import datetime
import uuid

import pytest

from config import create_credit_note, recompute_bill_gst


# ── §8.2 — credit note mis-routes tax to IGST for an out-of-state recipient ──
@pytest.mark.xfail(
    reason="§8.2: create_credit_note routes CN tax to IGST when "
           "recipient_state_code != '29'. Hotel accommodation place of supply "
           "is ALWAYS the hotel (KA-29), so a CN must reverse CGST+SGST, never "
           "IGST — like every other bill path (config.py ~1616).",
    strict=False,
)
def test_section8_2_credit_note_is_cgst_sgst_not_igst_for_out_of_state():
    # A B2B recipient in Maharashtra (state 27). The original invoice charged
    # CGST+SGST (place of supply KA-29); the credit note must reverse the same.
    bill_data = {
        "bill_number": "CC/2026/10/00001",
        "recipient_state_code": "27",            # out of state
        "recipient_state": "Maharashtra",
        "recipient_gstin": "27ABCDE1234F1Z5",
        "guest_name": "Out Of State Co",
        "gst_rate": 5,
        "checkout_time": "2026-10-01 12:00:00",
    }
    cn = create_credit_note(
        bill_id="BILL_8_2",
        bill_data=bill_data,
        cn_date=datetime.date(2026, 10, 2),
        reason="cancellation",
        reason_text="full cancellation — documents §8.2",
        credit_taxable=1142.86,
        credit_cgst=28.57,
        credit_sgst=28.57,
        credit_total=1200.0,
    )
    assert cn is not None, "create_credit_note returned None (test setup issue)"
    # CORRECT: CGST+SGST reversed, zero IGST.
    assert cn["credit_amount_igst"] == 0, "CN wrongly routed to IGST (§8.2)"
    assert cn["credit_amount_cgst"] + cn["credit_amount_sgst"] == pytest.approx(57.14, abs=0.02)


# ── §8.3 — total credit across CNs on one invoice isn't capped at its value ──
@pytest.mark.xfail(
    reason="§8.3: nothing caps the sum of credit notes against one invoice at "
           "the invoice value. Two full-value CNs on a ₹1,200 bill both succeed, "
           "so ₹2,400 of credit is issued against ₹1,200 of supply.",
    strict=False,
)
def test_section8_3_cumulative_credit_capped_at_invoice_value():
    bill_data = {
        "bill_number": "CC/2026/10/00083",
        "recipient_state_code": "29",
        "guest_name": "Capped Co",
        "gst_rate": 5,
        "total_amount": 1200,
        "checkout_time": "2026-10-01 12:00:00",
    }
    kw = dict(bill_id="BILL_8_3", bill_data=bill_data, cn_date=datetime.date(2026, 10, 2),
              reason="cancellation", credit_taxable=1142.86, credit_cgst=28.57,
              credit_sgst=28.57, credit_total=1200.0)
    cn1 = create_credit_note(reason_text="first full CN", idempotency_key="k83a", **kw)
    assert cn1 is not None, "first CN should succeed (test setup)"
    cn2 = create_credit_note(reason_text="second full CN — exceeds invoice", idempotency_key="k83b", **kw)
    # CORRECT: the second CN would take cumulative credit to ₹2,400 > ₹1,200, so
    # it must be refused (or clamped). It currently succeeds unchecked.
    assert cn2 is None, "a CN that pushes cumulative credit past the invoice value should be refused (§8.3)"


# ── §8.5 — recompute_bill_gst re-prices a transferred stay at the final rate ──
@pytest.mark.xfail(
    reason="§8.5: recompute_bill_gst reads bill['pre_transfer_charges'] at the "
           "TOP LEVEL, but checkout stores the pre-transfer segment nested, so "
           "it is absent → every night of a transferred stay is re-priced at "
           "the final room's rate (wrong GST).",
    strict=False,
)
def test_section8_5_transferred_stay_keeps_pre_transfer_rates_on_recompute():
    # 3-night transferred stay: 2 nights @ ₹900 (exempt) in the first room,
    # then moved to a ₹5,000 room for night 3 (18%).
    pre_transfer = [{"days": 2, "price": 900, "total": 1800, "from_room": "101"}]
    base = {
        "checkin_time": "2026-10-01 12:00",
        "days_stayed": 3,
        "room_price_per_night": 5000,
        "room": "207",
        "services": [],
        "discounts": 0,
        "room_charges_total": 1800 + 5000,
        "recipient_state_code": "29",
    }
    # Reference: what recompute SHOULD produce if the pre-transfer segment were
    # honoured (i.e. present where it looks).
    correct = recompute_bill_gst({**base, "pre_transfer_charges": pre_transfer})
    # As checkout actually stores the bill — no TOP-LEVEL pre_transfer_charges.
    as_stored = recompute_bill_gst(dict(base))

    # CORRECT: a transferred stay recomputes to the same (pre-transfer-aware) GST
    # however the segment is stored. It does not — nights 1-2 get taxed at 18%.
    assert round(as_stored["gst_amount"]) == round(correct["gst_amount"]), \
        "transferred stay re-priced at the final rate on recompute (§8.5)"


# ── §8.1 — /collect_settlement commits the money before the Section-34 check ──
@pytest.mark.xfail(
    reason="§8.1: /collect_settlement commits the payment + totals + settlement "
           "(batch.commit, routes/settlements.py:284) BEFORE the Section-34 "
           "credit-note window check (:418). A CN-discount on an invoice past the "
           "30-Nov deadline returns 409 section34_warning with the settlement "
           "ALREADY marked paid; the client's acknowledge-and-retry then trips the "
           "ALREADY_PAID guard (:171), so the bill is never updated and no credit "
           "note is ever issued.",
    strict=False,
)
def test_section8_1_collect_settlement_acknowledge_retry_issues_credit_note(client, admin):
    from tests.conftest import DB
    from tests.test_parity import V2Driver

    d = V2Driver(client, admin)
    # Pay-later stay: ₹1,200 with ₹200 taken at the desk → ₹1,000 pending, and a
    # real (numbered) bill linked to the settlement.
    d.checkin("201", name="B2B Guest", mobile="9800000001", guests=2,
              price=1200, paid=200, payment="cash")
    d.checkout("201", settle_later=True, notes="pays on return")

    bill_id, _bill = next(iter(DB.dump("bills").items()))
    # Age the invoice past the Section 34(2) 30-Nov deadline so a CN discount
    # needs acknowledge_section34_window. Only the stored checkout_time changes;
    # no money or tax field is touched.
    DB.collection("bills").document(bill_id).update({"checkout_time": "2023-10-01 12:00:00"})
    sid = client.get("/api/v2/settlements", headers=admin).json()["settlements"][0]["id"]

    body = {
        "payment_mode": "cash",
        "discount_amount": 100,
        "discount_type": "credit_note",
        "discount_reason": "Section 15(3)(b) discount agreed at check-in",
    }
    # First attempt: the server warns about the Section-34 window (409) — but the
    # payment and the settlement have already been committed by this point.
    client.post(f"/api/v2/settlements/{sid}/collect",
                headers={**admin, "X-Op-Id": uuid.uuid4().hex}, json=body)
    # The client acknowledges the warning and retries, exactly as the UI would.
    retry = client.post(f"/api/v2/settlements/{sid}/collect",
                        headers={**admin, "X-Op-Id": uuid.uuid4().hex},
                        json={**body, "acknowledge_section34_window": True})

    # CORRECT: the acknowledged retry collects the balance and issues the CN.
    assert retry.json().get("success") is True, \
        "acknowledge-and-retry returns ALREADY_PAID; bill never updated (§8.1)"
    assert DB.dump("credit_notes"), "no credit note issued after acknowledged retry (§8.1)"


# ── §8.4 — /add_bill_payment credit_note discount reverses the tax twice ──────
@pytest.mark.xfail(
    reason="§8.4: /add_bill_payment with discount_type='credit_note' BOTH rewrites "
           "the invoice's own GST (recompute_bill_gst on the post-discount folio, "
           "routes/billing.py:1426) AND issues a credit note for the same discount "
           "(:1512) — the output tax is reversed twice. It also skips the GST "
           "month-lock check on that path and runs its 'needs GSTIN or reason' "
           "validation only after every write.",
    strict=False,
)
def test_section8_4_add_bill_payment_credit_note_reverses_tax_once(client, admin):
    from tests.conftest import DB
    from tests.test_parity import V2Driver

    d = V2Driver(client, admin)
    # A taxable pay-later stay (AC room → 5% slab), ₹2,100 with ₹100 taken →
    # ₹2,000 pending and a numbered invoice that actually charged GST.
    d.checkin("205", name="GST Guest", mobile="9800000002", guests=3,
              price=2100, paid=100, payment="cash", is_ac=True)
    d.checkout("205", settle_later=True, notes="")

    bill_id, bill = next(iter(DB.dump("bills").items()))
    gst_before = int(bill.get("gst_amount") or 0)

    client.post("/add_bill_payment", headers={**admin, "X-Op-Id": uuid.uuid4().hex},
                json={"bill_id": bill_id, "amount": 0, "discount": 200,
                      "discount_type": "credit_note",
                      "discount_reason": "Section 15(3)(b) discount agreed at check-in"})

    after = DB.dump("bills")[bill_id]
    # CORRECT: a Section-34 credit note reverses the output tax; the ORIGINAL
    # tax invoice is the filed document and must NOT also be re-written, or the
    # discount's tax is reversed twice (once on the bill, once on the CN).
    assert int(after.get("gst_amount") or 0) == gst_before, \
        "invoice GST rewritten AND a CN issued for the same discount — double reversal (§8.4)"
    assert DB.dump("credit_notes"), "setup: a credit note should be issued for the credit_note discount"


# ── §8.6 — /reports undercounts check-ins (counts only rooms occupied now) ────
@pytest.mark.xfail(
    reason="§8.6: /reports counts check-ins by scanning CURRENT room state "
           "(get_all_rooms, routes/reports.py:492), so a guest who checked in AND "
           "out within the range is no longer in any room and is not counted — the "
           "day's check-ins are undercounted. (renewals=len(renewal payments) can "
           "likewise double-count a stay renewed more than once.)",
    strict=False,
)
def test_section8_6_reports_counts_checked_out_stays(client, admin):
    from tests.conftest import DB
    from tests.test_parity import V2Driver

    d = V2Driver(client, admin)
    d.checkin("210", name="Day Guest", mobile="9800000006", guests=1,
              price=450, paid=450, payment="cash")
    # The day the stay was created, taken from the room doc so the report range
    # matches the check-in regardless of timezone.
    day = DB.dump("rooms")["210"]["checkin_time"][:10]
    d.checkout("210")  # same-day checkout → room vacated, checkin_time cleared

    r = client.post("/reports", headers={**admin, "X-Op-Id": uuid.uuid4().hex},
                    json={"start_date": day, "end_date": day}).json()
    assert r.get("success") is True, r
    # CORRECT: one guest checked in that day → the check-in count is 1, whether
    # or not they have since checked out.
    assert r["checkins"] == 1, \
        "a checked-out stay is dropped from the check-in count (§8.6)"
