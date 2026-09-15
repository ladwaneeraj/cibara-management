"""
Nightly-rate segments on an active stay: where a mid-stay price change starts.

Rent is charged onto room.balance one night at a time: night 1 at check-in,
every later night by /renew_rent at whatever guest.price is at that moment.
The checkout folio must bill each night at the rate it was charged at, so when
the rate changes mid-stay the nights before the change are frozen into
guest.pre_transfer_charges as {days, price, total, from_room} segments, and
guest.transfer_day_offset counts the nights those segments cover. Nights after
the offset bill at guest.price.

Three writers share that bookkeeping: a room shift (/transfer_room), an add-on
that raises the nightly rate (/add_on with apply_to_all_nights) and an admin
price change (/edit_room_price). This module is the arithmetic for the last
two. It is pure (no Firestore, no Flask) so every rule is testable directly.

static/script.js carries a twin, window.CibaraRateChange, so the price modal
can show the outcome (or the refusal) before anything is sent. The server
stays authoritative. tests/rate_change_cases.json runs against both, so a
change here needs the same change there, plus a case, in the same commit.

Notation used throughout:
    A       nights charged so far = renewal_count + 1
    offset  guest.transfer_day_offset, nights covered by earlier segments
    C       the night the clock is in, in 24h cycles from check-in
    B       the boundary: nights 1..B keep the rates they were charged at,
            night B+1 onward bills at the new price
"""
from datetime import datetime

EFFECTIVE_CHOICES = ("today", "tomorrow")

# Marks segments written by /edit_room_price. Only these may be reopened by a
# later change on the same stay (see plan_rate_change), and the checkout
# modal reads it to say that a new price has not started yet.
RATE_CHANGE_KIND = "rate_change"


class RateChangeError(ValueError):
    """The change would misbill the stay. The message is written for the
    operator and is shown as is."""


def current_night(checkin_time, now):
    """The night the clock is in, 1-based: floor((now - check-in) / 24h) + 1.

    Rent renews every 24h from the check-in time, not at midnight, so night 2
    starts exactly 24h after check-in. `now` is a naive IST datetime, the same
    convention /transfer_room uses. Returns None when checkin_time cannot be
    parsed, so the caller can fall back to the nights charged.
    """
    try:
        checkin = datetime.strptime(str(checkin_time or "")[:16], "%Y-%m-%d %H:%M")
    except ValueError:
        return None
    return max(1, int((now - checkin).total_seconds() // 86400) + 1)


def accrued_nights(renewal_count):
    """Nights charged onto room.balance so far: night 1 funded at check-in,
    one more per /renew_rent.

    This, not the wall clock, is what the folio bills. Renewals are clicked by
    the desk (once per calendar day), so a stay can sit in its third 24h cycle
    with only two nights charged. Billing the cycle nobody renewed would bill
    money the balance never carried; the pending-rent prompt is what closes
    that gap, not the invoice.
    """
    return int(renewal_count or 0) + 1


def nights_at_current_price(renewal_count, transfer_day_offset):
    """Nights the checkout folio bills at guest.price.

    Everything up to guest.transfer_day_offset is already frozen into
    guest.pre_transfer_charges at the rate it was charged at, so what remains
    at the current price is simply the charged nights minus the frozen ones.
    One formula for every stay, transferred or not.

    Clamped at 0. A stay whose offset ran past the charged nights (a room
    shift recorded while renewals were behind) bills its segments and nothing
    more, rather than a negative number of nights.

    Deliberately NOT a count of calendar days since the room shift. That count
    knows only about the shift, so it re-bills every night a later price
    change froze into a segment, and it under-bills whenever renewals outpace
    calendar days (a 23:00 check-in renews before the date rolls over).
    """
    return max(0, accrued_nights(renewal_count) - int(transfer_day_offset or 0))


def shift_segment_days(renewal_count, transfer_day_offset, completed_cycles):
    """Nights a room shift freezes into a segment at the room being left.

    The nights that belong to the old room are the 24h cycles completed there
    (`completed_cycles` counted from check-in, minus the cycles earlier
    segments already cover). The cycle in progress belongs to the new room:
    it bills at the new rate and /transfer_room moves the balance by the
    difference.

    Capped at the nights actually charged, for the reason in
    accrued_nights(): cycles the desk never renewed were never charged, and
    freezing them would push transfer_day_offset past the charged nights and
    bill segments for money the balance never carried.

    /transfer_room calls this. It is here so the rule has one home, shared
    with nights_at_current_price(), which bills whatever it leaves behind.
    """
    return max(0, min(int(completed_cycles or 0), accrued_nights(renewal_count))
                  - int(transfer_day_offset or 0))


def guest_fields(price, segments, offset):
    """The guest.* fields a rate change writes.

    last_transfer_date and transfer_day_prebilled are cleared. Both were
    read by the checkout folio, which counted the current rate's nights by
    calendar date since the room shift whenever last_transfer_date was set.
    That count billed nights frozen into a segment a second time, so it is
    gone: the folio now counts nights_at_current_price() for every stay.
    They are cleared here anyway. A price change starts a new current
    segment at the rate boundary, not at the room shift, so the shift date
    no longer describes it, and nothing downstream can revive a date-based
    count from a stale field. Both are only ever read for truthiness, so
    None does the job of deleting them.
    """
    return {
        "price": price,
        "pre_transfer_charges": segments,
        "transfer_day_offset": offset,
        "last_transfer_date": None,
        "transfer_day_prebilled": None,
    }


def _close_at(guest, room, boundary, kind=None):
    """guest's segments, plus nights offset+1..boundary frozen at
    guest.price when there are any. The input is not modified."""
    price = int(guest.get("price") or 0)
    offset = int(guest.get("transfer_day_offset") or 0)
    segments = [dict(s) for s in (guest.get("pre_transfer_charges") or [])]
    days = boundary - offset
    if days > 0:
        segment = {"days": days, "price": price, "total": price * days,
                   "from_room": room}
        if kind:
            segment["kind"] = kind
        segments.append(segment)
    return segments


def freeze_current_rate(guest, room, boundary, new_price, kind=None):
    """Close the current rate at night `boundary` and move to `new_price`.

    Returns the guest fields to write. The offset never moves backwards:
    nights already inside a segment stay there, because the folio has no
    other record of the rate they were charged at.
    """
    offset = int(guest.get("transfer_day_offset") or 0)
    return guest_fields(new_price, _close_at(guest, room, boundary, kind),
                        max(offset, boundary))


def plan_rate_change(room, guest, renewal_count, new_price, effective, night):
    """Where a new nightly price starts and what it does to the balance.

    effective "today" starts it on the night the clock is in (C), "tomorrow"
    on the next one. `night` is C from current_night(); None (check-in time
    unreadable) falls back to A, the nights charged.

    Nights before the boundary keep the rates they were charged at. Nights
    already charged from the boundary on are re-priced, so the balance moves
    by the difference and stays equal to what the folio will bill. Later
    renewals charge guest.price, which is the new price.

    Choosing "today" after "tomorrow" was set earlier on the same stay
    reopens that frozen night: trailing segments written by an earlier price
    change on this room are shrunk back to the boundary and their nights
    re-priced too. Any other trailing segment (a room shift, or an add-on
    that raised the rate and already charges its uplift for that night) is
    final, so the new price cannot start inside it.

    Raises RateChangeError, with a message for the operator, whenever the
    change cannot be placed without guessing.
    """
    if effective not in EFFECTIVE_CHOICES:
        raise ValueError(f"effective must be one of {EFFECTIVE_CHOICES}")

    old_price = int(guest.get("price") or 0)
    offset = int(guest.get("transfer_day_offset") or 0)
    segments = [dict(s) for s in (guest.get("pre_transfer_charges") or [])]
    accrued = accrued_nights(renewal_count)
    clock = night or accrued
    boundary = clock - 1 if effective == "today" else clock

    seg_days = [int(s.get("days") or 0) for s in segments]
    if min(seg_days, default=0) < 0 or sum(seg_days) != offset:
        raise RateChangeError(
            "This stay's earlier price changes do not add up, so the new "
            "price cannot be placed safely. Correct the tariff from the "
            "bill's Edit Price after checkout.")
    if boundary > accrued:
        if effective == "tomorrow" and boundary == accrued + 1:
            raise RateChangeError(
                f"Tonight's rent (night {clock}) has not been renewed yet. "
                "Renew it first, then set the new price from tomorrow.")
        raise RateChangeError(
            f"Rent has been charged up to night {accrued}, but the stay is "
            f"on night {clock}. Renew the pending rent first, then set the "
            "new price.")
    if offset > accrued:
        raise RateChangeError(
            f"Earlier price changes cover {offset} nights, but rent has been "
            f"charged for only {accrued}. Renew the pending rent first, then "
            "set the new price.")

    if boundary >= offset:
        if new_price == old_price:
            raise RateChangeError("That is already the current price.")
        segments = _close_at(guest, room, boundary, RATE_CHANGE_KIND)
        delta = (new_price - old_price) * (accrued - boundary)
    else:
        delta = (new_price - old_price) * (accrued - offset)
        cursor = offset
        while cursor > boundary:
            seg = segments[-1]
            days = int(seg.get("days") or 0)
            if days == 0:
                segments.pop()
                continue
            price = int(seg.get("price") or 0)
            if str(seg.get("from_room")) != str(room):
                raise RateChangeError(
                    f"Night {cursor} is billed at Room {seg.get('from_room')}'s "
                    "rate from the room shift, so the new price can start "
                    f"from night {cursor + 1} at the earliest.")
            if seg.get("kind") != RATE_CHANGE_KIND:
                raise RateChangeError(
                    f"Night {cursor} was re-rated when an add-on raised the "
                    "nightly price, so the new price can start from night "
                    f"{cursor + 1} at the earliest.")
            take = min(days, cursor - boundary)
            delta += (new_price - price) * take
            cursor -= take
            if take == days:
                segments.pop()
            else:
                seg["days"] = days - take
                seg["total"] = price * (days - take)

    return {
        "boundary": boundary,
        "first_new_night": boundary + 1,
        "nights_repriced": accrued - boundary,
        "balance_delta": delta,
        "segments": segments,
        "offset": boundary,
    }
