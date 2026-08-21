"""
Reconcile a room's `balance` counter against the payments ledger.

WHAT `room.balance` IS
  A running counter on the room document, incremented when a charge is booked
  as "Later" and decremented when a payment is applied against it. It is NOT
  derived from the ledger, and nothing recomputes it.

  The invoice does not use it. `config.create_bill_record` derives its own:
      balance = total_amount - cash - online - ota + refunds
  So a drifted counter never reaches a bill. It does, however, block checkout:
  static/settle-later-fix.js:93 refuses to check a guest out while
  `room.balance > 0`, which is how the drift becomes visible.

WHAT THIS SCRIPT DOES
  Rebuilds the balance from the ledger using the SAME arithmetic as
  create_bill_record, prints it next to the stored counter, and (with --apply)
  writes the derived value onto the room.

  It repairs to the LEDGER, not to zero. If the guest genuinely owes money the
  script says so and refuses to clear it. Zeroing a counter that is telling the
  truth would let a real debt walk out of the building.

  totals/current_totals.balance is adjusted by the same delta in the same
  batch, because that document is the sum of the per-room counters and would
  otherwise drift in the opposite direction.

USAGE
  # survey every occupied room (read-only):
  python -m scripts.repair_room_balance --all

  # one room, dry run -- ALWAYS start here:
  python -m scripts.repair_room_balance --room 200

  # apply:
  python -m scripts.repair_room_balance --room 200 --apply

SAFETY
  * Dry run by default. Nothing is written without --apply.
  * Refuses when the derived balance is HIGHER than the stored one (that means
    money is genuinely outstanding) unless --force is passed.
  * Refuses on a stay with a mid-stay room transfer, where nights are split
    across rate segments and the day count cannot be re-derived here safely.
  * Writes a balance_repair_audit document recording before, after and the
    full derivation, so the edit is never invisible.
  * Never touches payments, add-ons, discounts or the bill.

Exit code 0 = ok, non-zero = nothing found / refused.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone


_REFUND_TYPES = ("refund", "checkout_refund", "manual_refund",
                 "booking_cancel_refund")
_EXCLUDE_FROM_RECEIPTS = _REFUND_TYPES + ("discount", "expense")


def _derive(room_no: str, room_doc: dict, payment_service):
    """Rebuild the stay's balance from the ledger.

    Mirrors config.create_bill_record (config.py:988-1096). Returns
    (derived_balance, breakdown_dict, blocking_reason_or_None).
    """
    guest = room_doc.get("guest") or {}
    checkin_time = room_doc.get("checkin_time") or ""
    if not guest or not checkin_time:
        return None, {}, "room has no live stay (missing guest or checkin_time)"

    try:
        checkin_dt = datetime.strptime(checkin_time, "%Y-%m-%d %H:%M")
    except (ValueError, TypeError):
        return None, {}, f"unparseable checkin_time {checkin_time!r}"

    stay_id = room_doc.get("active_bill_id")
    rows = payment_service.query_payments_for_stay(
        room_no, guest.get("name", ""), checkin_dt, stay_id=stay_id
    ) or []

    cash = sum(r.get("amount", 0) for r in rows
               if r.get("method") == "cash"
               and r.get("type") not in _EXCLUDE_FROM_RECEIPTS)
    online = sum(r.get("amount", 0) for r in rows
                 if r.get("method") == "online"
                 and r.get("type") not in _EXCLUDE_FROM_RECEIPTS)
    ota = sum(r.get("amount", 0) for r in rows
              if r.get("method") == "ota"
              and r.get("type") not in _EXCLUDE_FROM_RECEIPTS)
    refunds = sum(r.get("amount", 0) for r in rows
                  if r.get("type") in _REFUND_TYPES)
    discounts = sum(r.get("amount", 0) for r in rows
                    if r.get("type") == "discount")

    services_total = sum(
        r.get("amount", 0) for r in rows
        if r.get("type") == "addon" and payment_service.is_live_charge(r)
    )

    # Room charges. Only the no-transfer path is re-derived here; a transfer
    # splits the stay into rate segments whose day counts come from calendar
    # dates the checkout flow owns, and guessing them would silently misprice.
    if guest.get("pre_transfer_charges") and guest.get("last_transfer_date"):
        return None, {}, ("stay had a mid-stay room transfer -- rate segments "
                          "cannot be re-derived here; check out via the app "
                          "and correct the bill instead")

    price = int(guest.get("price", 0) or 0)
    renewal_count = int(room_doc.get("renewal_count", 0) or 0)
    offset = int(guest.get("transfer_day_offset", 0) or 0)
    days = (renewal_count + 1) - offset
    room_charges_total = price * days

    total_amount = room_charges_total + services_total - discounts
    derived = total_amount - cash - online - ota + refunds

    return derived, {
        "guest_name":         guest.get("name", ""),
        "checkin_time":       checkin_time,
        "stay_id":            stay_id,
        "nights":             days,
        "room_price":         price,
        "room_charges_total": room_charges_total,
        "services_total":     services_total,
        "discounts":          discounts,
        "total_amount":       total_amount,
        "payment_cash":       cash,
        "payment_online":     online,
        "payment_ota":        ota,
        "refunds":            refunds,
        "ledger_rows":        len(rows),
    }, None


def _print_report(room_no, stored, derived, bd, reason):
    print(f"--- Room {room_no} " + "-" * 46)
    if reason:
        print(f"    SKIPPED: {reason}")
        print()
        return
    print(f"    guest              : {bd['guest_name']}")
    print(f"    check-in           : {bd['checkin_time']}")
    print(f"    ledger rows        : {bd['ledger_rows']}")
    print(f"    room  {bd['nights']} x Rs.{bd['room_price']:<10} = Rs.{bd['room_charges_total']}")
    print(f"    services                    = Rs.{bd['services_total']}")
    print(f"    discounts                   = Rs.{bd['discounts']}")
    print(f"    TOTAL CHARGES               = Rs.{bd['total_amount']}")
    print(f"    received cash/online/ota     = Rs.{bd['payment_cash']} / "
          f"Rs.{bd['payment_online']} / Rs.{bd['payment_ota']}")
    print(f"    refunds                     = Rs.{bd['refunds']}")
    print()
    print(f"    stored room.balance         = Rs.{stored}")
    print(f"    derived from ledger         = Rs.{derived}")
    drift = stored - derived
    print(f"    DRIFT                       = Rs.{drift}"
          f"{'   <-- needs repair' if drift else '   (clean)'}")
    print()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--room", help="Room number to reconcile")
    ap.add_argument("--all", action="store_true",
                    help="Survey every occupied room (read-only, ignores --apply)")
    ap.add_argument("--apply", action="store_true",
                    help="Write the derived balance. Default is a dry run.")
    ap.add_argument("--force", action="store_true",
                    help="Allow a write that INCREASES the balance (real money owed)")
    args = ap.parse_args()

    from config import db, rooms_ref, totals_ref
    from services import payment_service
    from google.cloud import firestore as _fs

    if args.all:
        bad = 0
        for snap in rooms_ref.stream():
            rd = snap.to_dict() or {}
            if rd.get("status") != "occupied":
                continue
            derived, bd, reason = _derive(snap.id, rd, payment_service)
            stored = int(rd.get("balance", 0) or 0)
            if reason is None and stored == derived:
                continue          # clean, stay quiet
            bad += 1
            _print_report(snap.id, stored, derived, bd, reason)
        print(f"{bad} occupied room(s) need attention.")
        return 0

    if not args.room:
        print("Give --room <n>, or --all for a survey.")
        return 2

    room_no = str(args.room)
    snap = rooms_ref.document(room_no).get()
    if not snap.exists:
        print(f"Room {room_no} not found.")
        return 1
    rd = snap.to_dict() or {}
    stored = int(rd.get("balance", 0) or 0)

    derived, bd, reason = _derive(room_no, rd, payment_service)
    _print_report(room_no, stored, derived, bd, reason)
    if reason:
        return 1

    drift = stored - derived
    if drift == 0:
        print("Counter already agrees with the ledger. Nothing to do.")
        return 0

    if drift < 0 and not args.force:
        print(f"REFUSED: the ledger says Rs.{derived} is owed, which is MORE "
              f"than the Rs.{stored} on the counter.")
        print("That is real money outstanding, not drift. Collect it in the "
              "app, or pass --force if you are certain.")
        return 1

    if not args.apply:
        print(f"DRY RUN -- room.balance would go Rs.{stored} -> Rs.{derived}, "
              f"and totals/current_totals.balance would move by Rs.{-drift}.")
        print("Re-run with --apply to write.")
        return 0

    # ── Write ─────────────────────────────────────────────────────────────
    # Room gets an absolute value (we just computed the truth); the shared
    # totals doc gets an Increment, because other rooms write to it
    # concurrently and an absolute write there would clobber them.
    batch = db.batch()
    batch.update(rooms_ref.document(room_no), {"balance": derived})
    batch.update(totals_ref.document("current_totals"),
                 {"balance": _fs.Increment(-drift)})
    batch.commit()

    try:
        db.collection("balance_repair_audit").document().set({
            "room":            room_no,
            "stay_id":         bd.get("stay_id"),
            "guest_name":      bd.get("guest_name"),
            "balance_before":  stored,
            "balance_after":   derived,
            "drift":           drift,
            "derivation":      bd,
            "repaired_at":     datetime.now(timezone.utc).isoformat(),
            "source":          "scripts.repair_room_balance",
        })
    except Exception as e:
        print(f"WARNING: audit row failed to write ({e}). The repair itself "
              f"was committed.")

    print(f"DONE. room {room_no} balance Rs.{stored} -> Rs.{derived}. "
          f"totals adjusted by Rs.{-drift}.")
    print("Reopen the room in the app; checkout should no longer be blocked.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
