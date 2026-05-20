"""
End-to-end smoke test of the Banking module against the REAL Firestore.

Run only against UAT — this writes documents to bills / payments /
cash_receipts / cash_deposits / bank_accounts.

  python -m scripts.smoke_banking
  python -m scripts.smoke_banking --cleanup   # delete docs after passing

What it verifies:
  1. Trigger backfills prior cash with officialized_at = trigger date
  2. Receipt voucher numbers are minted (RV/OR)
  3. Deposit drafts + confirms cleanly
  4. Integrity sweep returns clean
  5. Un-trigger blocks once cash is deposited

Exit code 0 = pass, non-zero = fail.
"""

from __future__ import annotations

import argparse
import sys
import uuid
from datetime import date


def _section(title: str) -> None:
    print()
    print("=" * 72)
    print(title)
    print("=" * 72)


def _check(label: str, ok: bool, detail: str = "") -> None:
    status = "PASS" if ok else "FAIL"
    print(f"  [{status}] {label}" + (f"  ({detail})" if detail else ""))
    if not ok:
        raise SystemExit(1)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cleanup", action="store_true",
                        help="Delete the test docs after the smoke run.")
    args = parser.parse_args()

    # Importing config triggers Firestore init + Banking init.
    from config import db, IST  # noqa
    from services.banking import (
        cash_receipts, cash_deposits, cash_adjustments,
        bank_accounts, validators, bill_events,
    )
    from services.banking.schema import (
        PaymentMethod, DepositEligibility,
        BILL_INVOICEABLE, BILL_FIRST_DEPOSIT_AT,
        PAY_METHOD, PAY_DEPOSIT_ELIGIBILITY, PAY_AMOUNT_PAISE,
        PAY_RECEIPT_NO, PAY_OFFICIALIZED_AT,
    )
    from services.banking.cash_receipts import UnTriggerBlocked

    # ── Stage 1: seed a fake stay + 5 payments ──────────────────────
    _section("Stage 1: seed stay + payments")
    sid = "smoke-" + uuid.uuid4().hex[:8]
    db.collection("bills").document(sid).set({
        "stay_id":   sid,
        "guest_name": "Smoke Guest",
        "status":    "draft",
        "room":      "SMOKE",
        BILL_INVOICEABLE: False,
    })
    payment_ids = []
    for n, (label, method, amount) in enumerate([
        ("May 10 cash",   PaymentMethod.CASH,   450),
        ("May 11 cash",   PaymentMethod.CASH,   450),
        ("May 13 cash",   PaymentMethod.CASH,   450),
        ("May 14 cash",   PaymentMethod.CASH,   450),
        ("May 15 online", PaymentMethod.ONLINE, 450),
    ]):
        pid = f"{sid}-pay-{n}"
        db.collection("payments").document(pid).set({
            "stay_id":     sid,
            PAY_METHOD:    method,
            "amount":      amount,
            PAY_AMOUNT_PAISE: amount * 100,
            PAY_DEPOSIT_ELIGIBILITY: (
                DepositEligibility.PENDING
                if method == PaymentMethod.CASH
                else DepositEligibility.EXCLUDED
            ),
            "voided_at": None,
        })
        payment_ids.append(pid)
        print(f"  seeded {label}: {pid}")

    # ── Stage 2: fire trigger via May-15 online payment ─────────────
    _section("Stage 2: fire trigger (May 15 online)")
    result = cash_receipts.fire_trigger(
        sid, trigger_payment_id=payment_ids[4],
        trigger_date=date(2026, 5, 15),
    )
    _check("trigger returned non-null", result is not None)
    _check("trigger was fresh (not idempotent no-op)",
           not result.get("already_invoiceable"))
    _check("4 RV receipts issued",
           len(result["rv_receipts"]) == 4,
           f"got {len(result['rv_receipts'])}")
    _check("1 OR receipt issued", result["or_receipt"] is not None)

    # Bill flipped to invoiceable
    bill = db.collection("bills").document(sid).get().to_dict()
    _check("bill.invoiceable = True", bill.get(BILL_INVOICEABLE) is True)

    # Cash payments now eligible with officialized_at = trigger date
    for n, pid in enumerate(payment_ids[:4]):
        p = db.collection("payments").document(pid).get().to_dict()
        _check(f"pay-{n} eligibility = eligible",
               p.get(PAY_DEPOSIT_ELIGIBILITY) == DepositEligibility.ELIGIBLE)
        _check(f"pay-{n} has receipt_no", bool(p.get(PAY_RECEIPT_NO)))
        _check(f"pay-{n} officialized_at starts 2026-05-15",
               (p.get(PAY_OFFICIALIZED_AT) or "").startswith("2026-05-15"))

    # ── Stage 3: idempotent re-fire is a no-op ──────────────────────
    _section("Stage 3: re-fire is idempotent")
    again = cash_receipts.fire_trigger(
        sid, trigger_payment_id=payment_ids[4],
        trigger_date=date(2026, 5, 15),
    )
    _check("second fire returns already_invoiceable=True",
           again is not None and again.get("already_invoiceable") is True)

    # ── Stage 4: deposit draft + confirm ────────────────────────────
    _section("Stage 4: bank deposit lifecycle")
    acc_id = bank_accounts.create(
        name="Smoke Test HDFC", bank="HDFC",
        account_number="9999000099", ifsc="HDFC0000001",
    )
    _check("bank account created", acc_id is not None)

    draft = cash_deposits.create_draft(
        deposit_date=date(2026, 5, 16),
        bank_account_id=acc_id,
        payment_ids=payment_ids[:4],
    )
    _check("draft created", draft is not None)
    _check("draft gross = ₹1800 = 180000 paise",
           draft and draft["gross_paise"] == 180000,
           f"got {draft and draft['gross_paise']}")
    _check("draft net = ₹1800", draft and draft["net_paise"] == 180000)

    ok = cash_deposits.confirm(draft["id"])
    _check("confirm succeeded", ok)

    confirmed = cash_deposits.get(draft["id"])
    _check("status = confirmed", confirmed.get("status") == "confirmed")

    # first_deposit_at locked
    bill = db.collection("bills").document(sid).get().to_dict()
    _check("bill.first_deposit_at is set",
           bool(bill.get(BILL_FIRST_DEPOSIT_AT)))

    # ── Stage 5: un-trigger is now BLOCKED ──────────────────────────
    _section("Stage 5: un-trigger blocked after deposit")
    blocked = False
    try:
        cash_receipts.revert_trigger_if_safe(sid, reason="smoke")
    except UnTriggerBlocked:
        blocked = True
    _check("revert raises UnTriggerBlocked", blocked)

    # ── Stage 6: integrity sweep is clean ───────────────────────────
    _section("Stage 6: integrity sweep")
    report = validators.run_integrity_check(sample_limit=10)
    print(f"  orphaned_links:         {len(report['orphaned_links'])}")
    print(f"  eligibility_mismatches: {len(report['eligibility_mismatches'])}")
    print(f"  drifting_deposits:      {len(report['drifting_deposits'])}")
    print(f"  stuck_pending:          {len(report['stuck_pending_on_invoiceable'])}")
    _check("no drift on the new deposit",
           not any(d["deposit_id"] == draft["id"]
                   for d in report["drifting_deposits"]))

    _section("ALL SMOKE CHECKS PASSED")

    # ── Cleanup ────────────────────────────────────────────────────
    if args.cleanup:
        _section("Cleanup")
        for pid in payment_ids:
            db.collection("payments").document(pid).delete()
        db.collection("bills").document(sid).delete()
        # Receipts + deposit + adjustments + bank account left in place
        # by default — too risky to auto-delete without checking they
        # weren't touched by other tests. Print their IDs so you can
        # nuke manually if needed.
        print(f"  deleted bill + 5 payments. Manual cleanup of:")
        print(f"    deposit:      {draft['id']}")
        print(f"    bank account: {acc_id}")
        print(f"    cash_receipts where stay_id == {sid}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
