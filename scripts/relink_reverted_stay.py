"""
Repair a stay whose payments were orphaned by /revert_checkout.

THE BUG THIS REPAIRS
  BillsService.revert_to_draft cancels the original bill and mints a FRESH
  stay_id for a stay that is still running. Payments already written keep the
  OLD stay_id, so the canonical foreign key stops pointing at the live stay.

  Every fast path keys off that FK and returns as soon as it yields ANY row:
    config.create_bill_record._fetch_payments   -> the re-issued invoice
    payment_service.query_payments_for_stay Q0  -> /get_history
    routes.rooms.get_stay_payments Q0           -> Payment History modal

  So the first add-on written after a revert makes Q0 non-empty, and all of
  them then report ONLY that row. Prior rent, add-ons and receipts disappear
  from the UI and from the re-issued bill. That is under-billing, not a
  display glitch.

  routes/rooms.py now re-stamps the payments inside the revert batch, so new
  reverts are correct. This script repairs stays that were reverted BEFORE
  that fix shipped.

USAGE
  # dry run (read-only) -- ALWAYS start here:
  python -m scripts.relink_reverted_stay --room 200
  # apply:
  python -m scripts.relink_reverted_stay --room 200 --apply

  # explicit ids, when the room has already been checked out again:
  python -m scripts.relink_reverted_stay \
      --old-stay-id 638352cf... --new-stay-id 02ddb3d6... --apply

SAFETY
  * Dry run by default. Nothing is written without --apply.
  * Only the stay_id pointer is rewritten. Amounts, methods, dates, addon_uid
    and every audit field are left exactly as written.
  * restamped_from_stay_id is stamped alongside, so the original link stays
    visible in the document.
  * A payment already owned by a THIRD stay_id is never touched.
  * The cancelled predecessor bill keeps rendering from its own stored
    services / payment_* fields, so its printed copy does not change.

Exit code 0 = ok, non-zero = nothing found / aborted.
"""

from __future__ import annotations

import argparse
import sys


def _resolve_from_room(db, rooms_ref, room: str):
    """Return (old_stay_id, new_stay_id, checkin_time) for a reverted room.

    The room doc carries the CURRENT stay_id in active_bill_id. The revert
    audit collection records the pairing, so we look the successor up there
    rather than guessing.
    """
    snap = rooms_ref.document(str(room)).get()
    if not snap.exists:
        print(f"Room {room} not found.")
        return None, None, None
    rd = snap.to_dict() or {}
    new_stay_id = rd.get("active_bill_id")
    checkin_time = rd.get("checkin_time") or ""
    if not new_stay_id:
        print(f"Room {room} has no active_bill_id — is a stay running on it?")
        return None, None, checkin_time

    rows = list(
        db.collection("revert_audit")
        .where("new_stay_id", "==", new_stay_id)
        .stream()
    )
    if not rows:
        print(
            f"No revert_audit row points at stay_id={new_stay_id}. "
            f"Either this stay was never reverted, or it has been checked "
            f"out again — pass --old-stay-id / --new-stay-id explicitly."
        )
        return None, new_stay_id, checkin_time

    a = rows[0].to_dict() or {}
    return a.get("stay_id"), new_stay_id, checkin_time


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--room", help="Room number of the reverted, still-running stay")
    ap.add_argument("--old-stay-id", help="Cancelled bill's stay_id (overrides --room)")
    ap.add_argument("--new-stay-id", help="Fresh draft's stay_id (overrides --room)")
    ap.add_argument("--checkin-time", default="",
                    help='"YYYY-MM-DD HH:MM" — widens the search to legacy '
                         "rows linked only by stay_room_key")
    ap.add_argument("--apply", action="store_true", help="Actually write. Default is a dry run.")
    args = ap.parse_args()

    from config import db, rooms_ref
    from services import payment_service

    old_id = args.old_stay_id
    new_id = args.new_stay_id
    checkin = args.checkin_time

    if not (old_id and new_id):
        if not args.room:
            print("Give either --room, or both --old-stay-id and --new-stay-id.")
            return 2
        old_id, new_id, ci = _resolve_from_room(db, rooms_ref, args.room)
        checkin = checkin or ci or ""

    if not (old_id and new_id):
        return 1
    if old_id == new_id:
        print("Old and new stay_id are the same — nothing to do.")
        return 0

    print(f"old stay_id : {old_id}")
    print(f"new stay_id : {new_id}")
    print(f"room        : {args.room or '-'}")
    print(f"checkin     : {checkin or '-'}")
    print()

    # ── Show what is on each side BEFORE deciding anything ────────────────
    old_rows = payment_service.query_payments_by_stay_id(old_id) or []
    new_rows = payment_service.query_payments_by_stay_id(new_id) or []

    def _dump(label, rows):
        print(f"{label} ({len(rows)} rows)")
        for r in sorted(rows, key=lambda x: (x.get("date", ""), x.get("time", ""))):
            print(
                f"   {r.get('date','?')} {r.get('time','?')}  "
                f"{str(r.get('type','?')):<18} "
                f"{str(r.get('item') or r.get('method') or ''):<20} "
                f"Rs.{r.get('amount', 0)}"
            )
        print()

    _dump("ORPHANED on the cancelled bill:", old_rows)
    _dump("VISIBLE on the live stay:", new_rows)

    if not old_rows:
        print("Nothing is orphaned. No repair needed.")
        return 0

    if not args.apply:
        print(f"DRY RUN — {len(old_rows)} row(s) would be re-pointed to {new_id}.")
        print("Re-run with --apply to write.")
        return 0

    moved = payment_service.relink_stay_payments(
        old_id, new_id, room=str(args.room or ""), checkin_time=checkin,
    )
    if not moved:
        print("Nothing was written — see the log line above for the reason.")
        return 1

    print(f"DONE. {moved} payment row(s) re-pointed {old_id} -> {new_id}.")
    print("Re-open the room in the app; Payment History should be complete again.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
