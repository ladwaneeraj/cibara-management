"""
Unit tests for services/laundry_ledger.py — the pure account math behind
the laundry Billing tab. No Firestore, no Flask: plain dicts in, plain
dicts out.

Run:  pytest tests/test_laundry_ledger.py -q
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# In a full-suite run (pytest tests/), earlier test modules (e.g.
# test_expense_split.py) replace sys.modules["services"] with a stub whose
# __path__ is [] so they can import routes without Firebase. Any submodule
# import through that stub fails. If the cached "services" package cannot
# see the real services/ directory, drop it so Python re-imports the real
# one; the earlier modules keep their already-bound stub references.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_svc = sys.modules.get("services")
if _svc is not None and os.path.join(_REPO_ROOT, "services") not in list(
        getattr(_svc, "__path__", []) or []):
    del sys.modules["services"]

from services.laundry_ledger import compute_ledger


def _bill(id, start, end, amount, date=None, pieces=0, month=None):
    return {
        "id": id,
        "date": date or end,
        "bill_date": date or end,
        "month": month or start[:7],
        "period_start": start,
        "period_end": end,
        "amount": amount,
        "pieces": pieces,
    }


def _pay(id, date, amount, method="cash"):
    return {"id": id, "date": date, "time": "12:00", "amount": amount,
            "method": method, "expense_type": "transaction",
            "description": f"Laundry Payment (paid {date})"}


# ── Basics ──────────────────────────────────────────────────────────────────

def test_empty_ledger():
    out = compute_ledger({}, [], [], [])
    assert out["summary"]["balance"] == 0
    assert out["entries"] == []
    assert out["overlaps"] == []


def test_single_bill_unpaid():
    out = compute_ledger({}, [_bill("b1", "2026-06-01", "2026-06-30", 1000)],
                         [], [])
    s = out["summary"]
    assert s == {"opening": 0, "opening_settled": 0, "total_billed": 1000,
                 "total_paid": 0, "total_adjustments": 0,
                 "balance": 1000, "advance": 0}
    assert out["bills"][0]["status"] == "due"
    assert out["entries"][-1]["running_balance"] == 1000


def test_full_payment_settles():
    out = compute_ledger({}, [_bill("b1", "2026-06-01", "2026-06-30", 1000)],
                         [], [_pay("p1", "2026-07-02", 1000)])
    assert out["summary"]["balance"] == 0
    assert out["bills"][0]["status"] == "paid"


# ── Partial payments & carry-forward (the user's core complaint) ────────────

def test_partial_payment_carries_forward():
    out = compute_ledger({}, [_bill("b1", "2026-06-01", "2026-06-30", 1000)],
                         [], [_pay("p1", "2026-07-02", 400)])
    assert out["summary"]["balance"] == 600
    assert out["bills"][0]["status"] == "partial"
    assert out["bills"][0]["due"] == 600


def test_carry_forward_across_months_no_double_count():
    """
    June bill 1000, paid 400 → 600 carries. July bill 500.
    Balance must be 1100 — the 600 is NEVER re-entered anywhere.
    """
    out = compute_ledger(
        {},
        [_bill("b1", "2026-06-01", "2026-06-30", 1000),
         _bill("b2", "2026-07-01", "2026-07-31", 500)],
        [],
        [_pay("p1", "2026-07-02", 400)],
    )
    assert out["summary"]["balance"] == 1100
    # FIFO: the 400 went to June first.
    june = next(b for b in out["bills"] if b["id"] == "b1")
    july = next(b for b in out["bills"] if b["id"] == "b2")
    assert june["status"] == "partial" and june["due"] == 600
    assert july["status"] == "due"


def test_one_payment_covers_old_balance_plus_new_bill():
    """He pays 1100 at once: 600 old + 500 new — no allocation needed."""
    out = compute_ledger(
        {},
        [_bill("b1", "2026-06-01", "2026-06-30", 1000),
         _bill("b2", "2026-07-01", "2026-07-31", 500)],
        [],
        [_pay("p1", "2026-07-02", 400), _pay("p2", "2026-08-01", 1100)],
    )
    assert out["summary"]["balance"] == 0
    assert all(b["status"] == "paid" for b in out["bills"])


def test_overpayment_becomes_advance():
    out = compute_ledger({}, [_bill("b1", "2026-06-01", "2026-06-30", 1000)],
                         [], [_pay("p1", "2026-07-02", 1200)])
    s = out["summary"]
    assert s["balance"] == -200
    assert s["advance"] == 200
    assert out["entries"][-1]["running_balance"] == -200


# ── Opening balance & adjustments ───────────────────────────────────────────

def test_opening_balance_counts_once():
    out = compute_ledger(
        {"amount": 368, "date": "2026-06-01", "note": "b/f"},
        [_bill("b1", "2026-06-01", "2026-06-30", 1000)],
        [], [_pay("p1", "2026-06-15", 368)],
    )
    s = out["summary"]
    assert s["balance"] == 1000
    assert s["opening_settled"] == 368     # FIFO: opening cleared first
    assert out["entries"][0]["type"] == "opening"


def test_adjustments_signed():
    out = compute_ledger(
        {},
        [_bill("b1", "2026-06-01", "2026-06-30", 1000)],
        [{"id": "a1", "date": "2026-06-20", "amount": -100, "note": "discount"},
         {"id": "a2", "date": "2026-06-21", "amount": 50, "note": "missed towel"}],
        [_pay("p1", "2026-06-25", 500)],
    )
    assert out["summary"]["balance"] == 1000 - 100 + 50 - 500


# ── The user's actual July 2026 situation ───────────────────────────────────

def test_real_world_regression_no_368_double_count():
    """
    The exact numbers from the screenshot:
      June bill 18,418 · paid 18,050 (2 payments)  → 368 remained
      July bill 4,710  · paid 5,078                → the 368 was baked into
                                                     the old grand total
      12–21 Jul bill 3,380 · paid 3,000
    The legacy UI showed 748 because the 368 was ALSO typed into the
    period bill's Old Balance. The ledger must show 380:
      (18,418 + 4,710 + 3,380) − (18,050 + 5,078 + 3,000) = 380.
    """
    out = compute_ledger(
        {"amount": 0, "date": "", "note": ""},   # June's old_balance was 0
        [_bill("jun", "2026-06-01", "2026-06-30", 18418),
         _bill("jul", "2026-07-01", "2026-07-31", 4710),
         _bill("jul12", "2026-07-12", "2026-07-21", 3380)],
        [],
        [_pay("p1", "2026-06-15", 10000), _pay("p2", "2026-07-02", 8050),
         _pay("p3", "2026-07-14", 5078), _pay("p4", "2026-07-20", 3000)],
    )
    assert out["summary"]["balance"] == 380
    # And the overlapping July bills are flagged for the user to review.
    assert len(out["overlaps"]) == 1
    ids = {out["overlaps"][0]["a"], out["overlaps"][0]["b"]}
    assert ids == {"jul", "jul12"}


# ── Statement invariants ────────────────────────────────────────────────────

def test_running_balance_is_consistent_and_chronological():
    out = compute_ledger(
        {"amount": 200, "date": "2026-05-31", "note": "b/f"},
        [_bill("b1", "2026-06-01", "2026-06-30", 1000),
         _bill("b2", "2026-07-01", "2026-07-31", 700)],
        [{"id": "a1", "date": "2026-07-05", "amount": -50, "note": "disc"}],
        [_pay("p1", "2026-06-10", 500), _pay("p2", "2026-07-08", 900)],
    )
    entries = out["entries"]
    dates = [e["date"] for e in entries]
    assert dates == sorted(dates)
    running = 0
    for e in entries:
        running += e["effect"]
        assert e["running_balance"] == running
    assert running == out["summary"]["balance"] == 200 + 1700 - 50 - 1400


def test_same_day_bill_then_payment_orders_charge_first():
    out = compute_ledger(
        {},
        [_bill("b1", "2026-06-01", "2026-06-30", 1000, date="2026-06-30")],
        [],
        [_pay("p1", "2026-06-30", 1000)],
    )
    assert [e["type"] for e in out["entries"]] == ["bill", "payment"]
    assert out["entries"][0]["running_balance"] == 1000
    assert out["entries"][1]["running_balance"] == 0


def test_non_overlapping_bills_not_flagged():
    out = compute_ledger(
        {},
        [_bill("b1", "2026-06-01", "2026-06-30", 100),
         _bill("b2", "2026-07-01", "2026-07-31", 100),
         _bill("b3", "2026-08-01", "2026-08-15", 100)],
        [], [])
    assert out["overlaps"] == []


def test_zero_amount_and_missing_fields_are_safe():
    out = compute_ledger(
        {"amount": 0},
        [_bill("b1", "2026-06-01", "2026-06-30", 0),
         {"id": "b2", "amount": "250"}],          # stringy amount, no dates
        [{"id": "a1", "amount": None, "date": "", "note": ""}],
        [{"id": "p1", "amount": "100"}],          # stringy, no date
    )
    assert out["summary"]["balance"] == 150
    assert out["bills"][0]["status"] == "paid"    # 0-amount bill = nothing due
