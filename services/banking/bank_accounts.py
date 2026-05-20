"""
Bank account directory.

Tiny CRUD service for the destination accounts that cash deposits go
into. Account numbers are stored masked (last-4 only) for screen
display; the unmasked number is encrypted-at-rest by Firestore — we
never log it. IFSC is stored in cleartext because it isn't sensitive.

Schema
------
    name            : str   — operator-friendly label ("HDFC Current")
    bank            : str   — bank name
    account_number  : str   — full number, server-side only
    account_no_last4: str   — derived, safe to show in UI
    ifsc            : str
    branch          : str
    is_active       : bool  — soft "archive" flag
    is_default      : bool  — at most one true per property
    property_id     : str   — multi-property scoping; "" = global
    created_at, updated_at, createdBy, lastModifiedBy
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

from firebase_admin import firestore as fa_firestore

from config import IST
from services.audit_log import attribution_create, attribution_update, write_log

from .schema import COL_BANK_ACCOUNTS

logger = logging.getLogger(__name__)


_db = None
_accounts_ref = None


def init(db) -> None:
    global _db, _accounts_ref
    _db = db
    _accounts_ref = db.collection(COL_BANK_ACCOUNTS)
    logger.info("Banking.bank_accounts initialised")


def _ist_now() -> str:
    return datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")


def _mask(account_number: str) -> str:
    """Return last-4 only; cope with weird inputs."""
    s = str(account_number or "").strip()
    return s[-4:] if len(s) >= 4 else s


# ───────────────────────── Writes ────────────────────────────────────

def create(
    *,
    name: str,
    bank: str,
    account_number: str,
    ifsc: str = "",
    branch: str = "",
    property_id: str = "",
    is_default: bool = False,
) -> Optional[str]:
    """
    Create a bank account. Returns the new doc ID, or None on failure.

    If is_default=True, any other default for the same property_id is
    unset in the same batch. At most one default per property.
    """
    if _accounts_ref is None:
        logger.error("bank_accounts.create called before init()")
        return None
    if not name or not bank or not account_number:
        logger.error("bank_accounts.create: name/bank/account_number required")
        return None

    now = _ist_now()
    doc = {
        "name":             name.strip(),
        "bank":             bank.strip(),
        "account_number":   str(account_number).strip(),
        "account_no_last4": _mask(account_number),
        "ifsc":             (ifsc or "").strip().upper(),
        "branch":           (branch or "").strip(),
        "is_active":        True,
        "is_default":       bool(is_default),
        "property_id":      property_id or "",
        "created_at":       now,
        "updated_at":       now,
    }
    doc.update(attribution_create())

    try:
        batch = _db.batch()
        new_ref = _accounts_ref.document()
        batch.set(new_ref, doc)
        if is_default:
            # Unset any existing default in this property scope
            existing = (
                _accounts_ref
                .where(filter=fa_firestore.FieldFilter(
                    "property_id", "==", property_id or ""))
                .where(filter=fa_firestore.FieldFilter("is_default", "==", True))
                .stream()
            )
            for snap in existing:
                batch.update(snap.reference, {
                    "is_default": False,
                    "updated_at": now,
                    **attribution_update(),
                })
        batch.commit()
    except Exception as e:
        logger.error(f"bank_accounts.create failed: {e}", exc_info=True)
        return None

    write_log(
        "banking.bank_account.create",
        target_collection=COL_BANK_ACCOUNTS,
        target_id=new_ref.id,
        after={"name": doc["name"], "bank": doc["bank"],
               "last4": doc["account_no_last4"]},
    )
    return new_ref.id


def update(account_id: str, fields: dict) -> bool:
    """Partial update. Mutable fields only."""
    if _accounts_ref is None or not account_id:
        return False

    mutable = {"name", "bank", "ifsc", "branch", "is_active", "is_default"}
    payload = {k: v for k, v in fields.items() if k in mutable}
    if not payload:
        return False
    payload["updated_at"] = _ist_now()
    payload.update(attribution_update())

    try:
        # Default switch: unset previous default in same property.
        if payload.get("is_default") is True:
            snap = _accounts_ref.document(account_id).get()
            if not snap.exists:
                return False
            existing = snap.to_dict() or {}
            scope = existing.get("property_id", "")
            batch = _db.batch()
            batch.update(_accounts_ref.document(account_id), payload)
            for other in (
                _accounts_ref
                .where(filter=fa_firestore.FieldFilter("property_id", "==", scope))
                .where(filter=fa_firestore.FieldFilter("is_default", "==", True))
                .stream()
            ):
                if other.id == account_id:
                    continue
                batch.update(other.reference, {
                    "is_default": False,
                    "updated_at": _ist_now(),
                    **attribution_update(),
                })
            batch.commit()
        else:
            _accounts_ref.document(account_id).update(payload)
        write_log(
            "banking.bank_account.update",
            target_collection=COL_BANK_ACCOUNTS,
            target_id=account_id,
            after=payload,
        )
        return True
    except Exception as e:
        logger.error(f"bank_accounts.update({account_id}) failed: {e}",
                     exc_info=True)
        return False


def archive(account_id: str) -> bool:
    """Soft delete by flipping is_active=False. Default flag is cleared."""
    return update(account_id, {"is_active": False, "is_default": False})


# ───────────────────────── Reads ─────────────────────────────────────

def get(account_id: str) -> Optional[dict]:
    if _accounts_ref is None or not account_id:
        return None
    try:
        snap = _accounts_ref.document(account_id).get()
        if not snap.exists:
            return None
        d = snap.to_dict() or {}
        d["id"] = snap.id
        # Defensive: never return the unmasked number out of read APIs.
        d.pop("account_number", None)
        return d
    except Exception as e:
        logger.warning(f"bank_accounts.get({account_id}) failed: {e}")
        return None


def list_active(property_id: str = "") -> list[dict]:
    """All active accounts for a property scope, default first."""
    if _accounts_ref is None:
        return []
    try:
        q = (
            _accounts_ref
            .where(filter=fa_firestore.FieldFilter(
                "property_id", "==", property_id or ""))
            .where(filter=fa_firestore.FieldFilter("is_active", "==", True))
        )
        rows = []
        for snap in q.stream():
            d = snap.to_dict() or {}
            d["id"] = snap.id
            d.pop("account_number", None)
            rows.append(d)
        rows.sort(key=lambda r: (not r.get("is_default", False),
                                 r.get("name", "").lower()))
        return rows
    except Exception as e:
        logger.warning(f"bank_accounts.list_active failed: {e}")
        return []
