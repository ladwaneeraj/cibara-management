"""
Diagnose / repair a stay whose bill never finalised (e.g. an MMT booking
conversion that hit the old datetime crash, leaving the draft bill un-checked-out
so no invoice was generated and the row vanished from the Register).

WHAT IT DOES
  1. Locates the stay from the payment rows that carry its daily serial number.
  2. Prints the full state: room doc, bill/draft doc, booking doc, payments.
  3. (--apply) If the bill is an un-finalised DRAFT and the room is NOT still
     occupied by this stay, it finalises the draft using the SAME tested code
     the checkout flow uses (config.create_bill_record + bills_service.finalize),
     which mints the bill number and computes GST. The stay then appears in the
     Register and the invoice can be generated/printed as usual.

USAGE
  # dry run (read-only) — ALWAYS start here:
  python -m scripts.repair_mmt_stay --serial 8 --date 2026-06-05
  # apply the finalize for an orphaned draft:
  python -m scripts.repair_mmt_stay --serial 8 --date 2026-06-05 --apply

SAFETY
  • Dry run by default — no writes unless --apply is passed.
  • If the room is STILL occupied by this stay, the script refuses to finalise
    and tells you to check out normally in the app instead (that path also
    vacates the room and updates drawer totals; finalising here would leave the
    room occupied with a completed bill — inconsistent).
  • Run against UAT first if you can.

Exit code 0 = ok, non-zero = nothing found / aborted.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime


def _find_anchor_payment(db, serial: int, date_str: str):
    """Return the most identity-rich payment row carrying this serial on date."""
    col = db.collection("payments")
    rows = []
    for doc in col.where("serial_number", "==", serial).stream():
        d = doc.to_dict() or {}
        if date_str and d.get("date") != date_str:
            continue
        d["_id"] = doc.id
        rows.append(d)
    if not rows:
        return None, []
    # Prefer the check-in / conversion row (carries room, name, stay_id).
    anchor = next(
        (r for r in rows
         if r.get("type") in ("fresh_checkin", "booking_conversion")
         or r.get("is_fresh_checkin") or r.get("is_booking_conversion")),
        rows[0],
    )
    return anchor, rows


def main() -> int:
    ap = argparse.ArgumentParser(description="Diagnose/repair an un-finalised stay.")
    ap.add_argument("--serial", type=int, required=True, help="Daily serial number (e.g. 8)")
    ap.add_argument("--date", default="", help="Check-in date YYYY-MM-DD (default: today IST)")
    ap.add_argument("--apply", action="store_true", help="Actually finalise an orphaned draft")
    ap.add_argument("--checkout", default="",
                    help="Override checkout time 'YYYY-MM-DD HH:MM'. REQUIRED for walk-in "
                         "stays with no booking doc — otherwise the script assumes 'now', "
                         "which mints the bill number in the WRONG month/GST period.")
    ap.add_argument("--renewals", type=int, default=-1,
                    help="Override renewal_count (nights - 1). Use when there is no booking "
                         "doc to derive the stay length from (walk-ins). Default: auto.")
    args = ap.parse_args()

    # Side effect of importing config: Firebase + bills_service.init(db).
    from config import db, rooms_ref, bills_ref, bookings_ref, IST, create_bill_record
    from services import bills_service

    date_str = args.date or datetime.now(IST).strftime("%Y-%m-%d")

    # ── Ground-truth scan: dump everything for the date, read-only ───────────
    # This runs first so ONE command shows the full picture regardless of
    # whether the serial→payment link survived the crash.
    print(f"\n=== SCAN for {date_str} (read-only) ===")
    rs, re_ = f"{date_str} 00:00", f"{date_str} 23:59"
    print("\n[bills] (any status, checkin_time on this date):")
    n = 0
    try:
        for d in bills_ref.where("checkin_time", ">=", rs).where("checkin_time", "<=", re_).stream():
            b = d.to_dict() or {}
            n += 1
            print(f"  id={d.id[:12]} room={b.get('room')} guest={b.get('guest_name')!r} "
                  f"status={b.get('status')!r} serial={b.get('serial_number')} "
                  f"bill_no={b.get('bill_number')!r} co={b.get('checkout_time')!r} "
                  f"src={b.get('booking_source')!r}")
    except Exception as e:
        print(f"  bills scan error: {e}")
    if n == 0:
        print("  (no bills with checkin_time on this date)")

    print("\n[bookings] (MMT / checked_in):")
    try:
        for d in bookings_ref.where("booking_source", "==", "mmt").stream():
            b = d.to_dict() or {}
            if date_str not in (str(b.get("check_in_date", "")) + str(b.get("check_in_time", ""))
                                + str(b.get("actual_checkin_time", ""))):
                continue
            print(f"  id={d.id[:12]} room={b.get('room')} guest={b.get('guest_name')!r} "
                  f"status={b.get('status')!r} stay_id={str(b.get('stay_id'))[:12]} "
                  f"ci={b.get('check_in_date')} {b.get('check_in_time')}")
    except Exception as e:
        print(f"  bookings scan error: {e}")

    print("\n=== Repair MMT stay: serial #{} on {} ===\n".format(args.serial, date_str))

    anchor, rows = _find_anchor_payment(db, args.serial, date_str)
    if not anchor:
        print(f"No payment rows found for serial #{args.serial} on {date_str}.")
        print("Try a different --date, or the stay may pre-date serial tracking.")
        return 1

    room = str(anchor.get("room", ""))
    name = anchor.get("name", "")
    stay_id = anchor.get("stay_id")
    booking_id = anchor.get("booking_id")

    print(f"Stay found: room {room}, guest '{name}', stay_id={stay_id}, booking_id={booking_id}")
    print(f"Payments carrying this serial ({len(rows)}):")
    for r in rows:
        print(f"  - type={r.get('type')!r} method={r.get('method')!r} "
              f"amount={r.get('amount')} platform={r.get('platform')!r}")

    # Bill / draft doc
    bill = None
    if stay_id:
        snap = bills_ref.document(stay_id).get()
        bill = snap.to_dict() if snap.exists else None
    print("\nBill doc:")
    if not bill:
        print("  (none) — no bill/draft document exists for this stay_id.")
    else:
        print(f"  status={bill.get('status')!r} bill_number={bill.get('bill_number')!r} "
              f"checkin_time={bill.get('checkin_time')!r} "
              f"checkout_time={bill.get('checkout_time')!r} "
              f"booking_source={bill.get('booking_source')!r}")

    # Room doc
    room_snap = rooms_ref.document(room).get() if room else None
    room_doc = room_snap.to_dict() if (room_snap and room_snap.exists) else None
    occupied_by_this = bool(
        room_doc and room_doc.get("status") == "occupied"
        and str(room_doc.get("active_bill_id") or "") == str(stay_id or "")
    )
    print("\nRoom doc:")
    if not room_doc:
        print("  (none)")
    else:
        print(f"  status={room_doc.get('status')!r} active_bill_id={room_doc.get('active_bill_id')!r} "
              f"guest={(room_doc.get('guest') or {}).get('name')!r}  "
              f"=> occupied_by_this_stay={occupied_by_this}")

    # ── Decide ──────────────────────────────────────────────────────────────
    print("\n--- Diagnosis ---")
    if bill and bill.get("status") in ("completed", "checked_out", "pending_settlement"):
        print("Bill is already finalised. It should be visible in the Register.")
        print("If it isn't, RESTART the app server so the latest code is loaded.")
        return 0

    if occupied_by_this:
        print("Room is STILL OCCUPIED by this stay.")
        print("ACTION: check this room out normally in the app — that generates the")
        print("bill (your settings issue MMT room invoices) AND vacates the room.")
        print("Not finalising here, because that would leave the room occupied.")
        return 0

    if not bill:
        print("No bill/draft doc to finalise. The check-in likely failed before the")
        print("draft was created. Re-create the booking and check in again.")
        return 1

    # Orphaned draft: room not occupied by this stay, bill still a draft.
    if not args.apply:
        print("Orphaned DRAFT found (room not occupied, bill never finalised).")
        print("Re-run with --apply to finalise it and generate the bill.")
        return 0

    # ── Apply: finalise using the tested checkout code path ──────────────────
    checkin_time = bill.get("checkin_time") or f"{date_str} 12:00"

    # Pull the booking for nights / checkout date / OTA source.
    booking = {}
    if booking_id:
        try:
            _bk = bookings_ref.document(booking_id).get()
            if _bk.exists:
                booking = _bk.to_dict() or {}
        except Exception:
            booking = {}

    # Nights → renewal_count (MMT pre-charges every night at check-in, so
    # days_billed must equal the full stay length: renewal_count = nights - 1).
    renewal_count = 0
    try:
        _ci = datetime.strptime(booking.get("check_in_date", ""), "%Y-%m-%d")
        _co = datetime.strptime(booking.get("check_out_date", ""), "%Y-%m-%d")
        renewal_count = max((_co - _ci).days - 1, 0)
    except Exception:
        renewal_count = 0
    if args.renewals >= 0:
        renewal_count = args.renewals  # explicit override (walk-ins)

    # Checkout time: explicit override > booking's checkout date > now.
    # The bill number is minted in the CHECKOUT month, so for a past stay an
    # accurate checkout matters — 'now' would put it in the wrong GST period.
    if args.checkout:
        checkout_time = args.checkout
    elif booking.get("check_out_date"):
        checkout_time = f"{booking['check_out_date']} 11:00"
    else:
        checkout_time = datetime.now(IST).strftime("%Y-%m-%d %H:%M")
        print(f"WARNING: no booking doc and no --checkout given — using NOW "
              f"({checkout_time}). For a past stay pass --checkout "
              f"'YYYY-MM-DD HH:MM' so the bill lands in the correct month.")

    # Rebuild room_data from the BILL + BOOKING — NOT the live room doc, because
    # the room may have been reused by a different guest (it has here). Only
    # trust the live room doc when it still belongs to THIS stay.
    if occupied_by_this and room_doc:
        guest = room_doc.get("guest") or {}
        rc = room_doc.get("renewal_count", renewal_count)
        add_ons = room_doc.get("add_ons", [])
        bsrc = room_doc.get("booking_source", "mmt")
        psrc = room_doc.get("payment_source", "ota")
        bal = room_doc.get("balance", 0)
    else:
        guest = {
            "name": bill.get("guest_name") or name,
            "mobile": bill.get("guest_mobile", "") or anchor.get("mobile", ""),
            "price": bill.get("room_price_per_night", 0),
            "guests": bill.get("guest_count", 1),
            "balance": bill.get("balance", 0),
            "isAC": bill.get("is_ac", False),
            "payment": "ota",
        }
        rc = renewal_count
        add_ons = []
        bsrc = booking.get("booking_source", "mmt")
        psrc = booking.get("payment_source", "ota")
        bal = bill.get("balance", 0)

    room_data = {
        "guest": guest,
        "checkin_time": checkin_time,
        "balance": bal,
        "renewal_count": rc,
        "add_ons": add_ons,
        "active_bill_id": stay_id,
        "booking_source": bsrc,
        "payment_source": psrc,
    }

    print(f"\nReconstructed: guest={guest.get('name')!r} price={guest.get('price')} "
          f"renewal_count={rc} checkout={checkout_time} src={bsrc}/{psrc}")

    print("\nFinalising draft → bill (using create_bill_record + finalize)...")
    from config import BillCreationError
    try:
        bill_record = create_bill_record(room, room_data, checkout_time)
    except BillCreationError as bce:
        print(f"create_bill_record failed: {bce.reason}. Aborted.")
        if bce.bill_number:
            print(f"WARNING: bill number {bce.bill_number} was minted and is "
                  f"consumed — declare it as a cancelled document in GSTR-1 "
                  f"Table 13.")
        return 1
    bill_record["stay_id"] = stay_id
    ok = bills_service.finalize(stay_id, bill_record)
    if not ok:
        print("finalize() failed — see logs. Aborted.")
        return 1

    print(f"DONE. status={bill_record.get('status')} "
          f"bill_number={bill_record.get('bill_number')} "
          f"total_amount={bill_record.get('total_amount')}")
    print("The stay should now appear in the Register and the invoice can be printed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
