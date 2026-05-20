"""
Cash adjustments — opening balance, over/short, owner movements, etc.

Why a separate collection
-------------------------
Adjustments are NOT payments and NOT expenses. They represent real-
world cash flows that don't fit either category:

  * Opening balance when the feature first goes live
  * EOD count revealed an over/short
  * Owner pulled cash from the drawer
  * A deposit was rejected by the bank (bank_reversal)

They are signed: positive = cash drawer went up, negative = down. They
participate in `cash_on_hand_paise` and can be bundled into a deposit
just like expenses, but they're audited separately so the operator can
see them.

Permission policy
-----------------
Admin-only by default. The route layer enforces this. The reason field
is mandatory because every adjustment is, by definition, an unusual
event that needs an explanation in the audit trail.
"""

from __future__ import annotations

import logging
from datetime import date, datetime
from typing import Optional

from firebase_admin import firestore as fa_firestore

from config import IST
from services.audit_log import write_log, attribution_create

from .money import rupees_to_paise
from .schema import (
    COL_CASH_ADJUSTMENTS, AdjustmentReason,
)

logger = logging.getLogger(__name__)


_db = None
_adjustments_ref = None


def init(db) -> None:
    global _db, _adjustments_ref
    _db = db
    _adjustments_ref = db.collection(COL_CASH_ADJUSTMENTS)
    logger.info("Banking.cash_adjustments initialised")


def _ist_now_iso() -> str:
    return datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")


# ───────────────────────── Write ────────────────────────────────────

def create(
    *,
    adjustment_date: date,
    amount_paise: int,
    reason: str,
    notes: str = "",
    property_id: str = "",
) -> Optional[str]:
    """
    Create one adjustment row. `amount_paise` is signed (negative for
    cash out, positive for cash in). `reason` must be a member of
    AdjustmentReason.ALL.

    Returns the new doc ID, or None on validation failure / write error.
    """
    if _adjustments_ref is None:
        logger.error("cash_adjustments.create called before init()")
        return None
    if reason not in AdjustmentReason.ALL:
        logger.error(f"cash_adjustments.create: unknown reason {reason!r}")
        return None
    try:
        amt = int(amount_paise)
    except (TypeError, ValueError):
        logger.error("cash_adjustments.create: amount_paise must be int")
        return None
    if amt == 0:
        logger.error("cash_adjustments.create: amount cannot be zero")
        return None

    doc = {
        "adjustment_date": adjustment_date.strftime("%Y-%m-%d"),
        "amount_paise":    amt,
        "amount":          amt // 100,        # legacy display field
        "reason":          reason,
        "notes":           (notes or "")[:1000],
        "property_id":     property_id or "",
        "cash_deposit_id": None,
        "voided_at":       None,
    }
    doc.update(attribution_create())

    try:
        new_ref = _adjustments_ref.document()
        new_ref.set(doc)
    except Exception as e:
        logger.error(f"cash_adjustments.create write failed: {e}",
                     exc_info=True)
        return None

    write_log(
        "banking.adjustment.create",
        target_collection=COL_CASH_ADJUSTMENTS,
        target_id=new_ref.id,
        metadata={"reason": reason, "amount_paise": amt, "notes": notes},
    )
    return new_ref.id


def create_from_rupees(
    *,
    adjustment_date: date,
    amount_rupees,
    reason: str,
    notes: str = "",
    property_id: str = "",
) -> Optional[str]:
    """
    Convenience wrapper. Accepts a signed rupee amount (int / float /
    str / Decimal) and stores it as integer paise.
    """
    sign = -1 if str(amount_rupees).strip().startswith("-") else 1
    abs_paise = rupees_to_paise(str(amount_rupees).lstrip("-"))
    return create(
        adjustment_date=adjustment_date,
        amount_paise=sign * abs_paise,
        reason=reason,
        notes=notes,
        property_id=property_id,
    )


def void(adjustment_id: str, *, reason: str) -> bool:
    """
    Soft-delete an adjustment. Refuses to void a row already linked to
    a confirmed deposit (you'd have to reverse the deposit first).
    """
    if _adjustments_ref is None or not adjustment_id:
        return False
    try:
        snap = _adjustments_ref.document(adjustment_id).get()
        if not snap.exists:
            return False
        d = snap.to_dict() or {}
    except Exception:
        return False
    if d.get("voided_at"):
        return True   # already voided, idempotent
    if d.get("cash_deposit_id"):
        logger.error(
            f"cash_adjustments.void: row {adjustment_id} is linked to "
            f"deposit {d.get('cash_deposit_id')}; reverse the deposit "
            f"first."
        )
        return False
    try:
        _adjustments_ref.document(adjustment_id).update({
            "voided_at":    _ist_now_iso(),
            "void_reason":  (reason or "")[:200],
        })
    except Exception as e:
        logger.error(f"cash_adjustments.void write failed: {e}")
        return False
    write_log(
        "banking.adjustment.void",
        target_collection=COL_CASH_ADJUSTMENTS,
        target_id=adjustment_id,
        metadata={"reason": reason},
    )
    return True


# ───────────────────────── Read ─────────────────────────────────────

def list_recent(*, limit: int = 100,
                property_id: str = "") -> list[dict]:
    if _adjustments_ref is None:
        return []
    try:
        q = _adjustments_ref.order_by(
            "adjustment_date", direction=fa_firestore.Query.DESCENDING
        ).limit(limit)
        out = []
        for snap in q.stream():
            d = snap.to_dict() or {}
            if property_id and d.get("property_id", "") != property_id:
                continue
            d["id"] = snap.id
            out.append(d)
        return out
    except Exception as e:
        logger.warning(f"cash_adjustments.list_recent failed: {e}")
        return []


def list_undeposited(*, property_id: str = "") -> list[dict]:
    """Active adjustments not yet bundled into a deposit."""
    if _adjustments_ref is None:
        return []
    try:
        rows = []
        for snap in _adjustments_ref.stream():
            d = snap.to_dict() or {}
            if d.get("voided_at") or d.get("cash_deposit_id"):
                continue
            if property_id and d.get("property_id", "") != property_id:
                continue
            d["id"] = snap.id
            rows.append(d)
        rows.sort(key=lambda r: r.get("adjustment_date", ""))
        return rows
    except Exception as e:
        logger.warning(f"cash_adjustments.list_undeposited failed: {e}")
        return []
