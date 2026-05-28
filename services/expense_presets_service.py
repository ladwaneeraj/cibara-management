"""
Expense Presets Service — admin-managed quick-pick tiles per expense category.

Purpose
───────
Operators add the same expenses repeatedly (e.g. "Ramu salary",
"Electricity bill", "Cleaning supplies"). Free-text descriptions
diverge over time, which breaks category roll-ups and search.

This service stores a small, admin-curated list of preset items
per category. The frontend renders them as clickable tiles inside
the expense modal. Operators still retain free-text entry — tiles
are an accelerator, not a constraint.

Data model
──────────
Firestore collection: `expense_presets`
Document id          : category key (e.g. "salary", "utilities", ...)
Document fields      :
    {
      "category":   <str>,                 # mirrors doc id, for query convenience
      "items":      [                      # ordered list (insertion order preserved)
          {
            "id":             <uuid-12 hex>,
            "name":           <str>,        # display label on the tile
            "default_amount": <int|null>,   # optional, auto-fills amount on click
            "created_at":     <ISO>,
            "updated_at":     <ISO>,
          },
          ...
      ],
      "updated_at": <ISO>,
      "updated_by": <userId or "system">,
    }

Design notes
────────────
• Storing items inline as an array (rather than a sub-collection) keeps
  reads to a single document per category. Lists are expected to stay
  small (< a few dozen items); arrays are the right shape here.
• `id` is a stable per-item UUID so update / delete by id is O(n) but
  unambiguous even if two items share the same name.
• All writes are sync. These are admin actions, not hot paths.
• Reads cache nothing here — caching belongs to the client.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

_COLLECTION_NAME = "expense_presets"

_presets_ref = None
_db = None

# Sentinel used by update_item to distinguish "argument omitted" from
# "argument explicitly set to None". Defined at module scope so the
# identity is stable across reimports.
_NOT_PROVIDED = object()

# Whitelist of category keys we accept. Mirrors the <select> options in
# the expense modal. Keeping this server-side prevents stray writes from
# creating bogus category documents.
ALLOWED_CATEGORIES = frozenset({
    "salary",
    "rent",
    "utilities",
    "petty_cash",
    "purchase",
    "maintenance",
    "sanitary",
    "booking_commission",
    "others",
})


def init(db):
    """Call once at app startup to inject the Firestore client."""
    global _presets_ref, _db
    _db = db
    _presets_ref = db.collection(_COLLECTION_NAME)
    logger.info("ExpensePresetsService initialised (%s collection)", _COLLECTION_NAME)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalise_name(name: str) -> str:
    """Trim whitespace and collapse internal runs. Keeps case."""
    if not isinstance(name, str):
        return ""
    return " ".join(name.split())


def _coerce_amount(raw) -> Optional[int]:
    """Return an int amount, or None if blank / invalid / non-positive.

    Presets allow no default amount (e.g. utilities vary monthly) so
    None is a valid stored value. We deliberately reject 0 and negatives
    — those signal a typo, not a real default.
    """
    if raw is None or raw == "":
        return None
    try:
        v = int(raw)
        return v if v > 0 else None
    except (TypeError, ValueError):
        return None


def _validate_category(category: str) -> bool:
    return isinstance(category, str) and category in ALLOWED_CATEGORIES


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------

def list_all() -> dict:
    """
    Return a dict of  {category: [items]}  for every category that has
    a presets document. Missing categories simply aren't keyed.

    Empty dict on error / before init — callers should treat that as
    "no presets configured" rather than failing the whole UI.
    """
    if _presets_ref is None:
        return {}
    try:
        result = {}
        for doc in _presets_ref.stream():
            data = doc.to_dict() or {}
            items = data.get("items") or []
            # Defensive: ensure shape on read, in case an older doc
            # slipped in without all fields.
            cleaned = []
            for it in items:
                if not isinstance(it, dict):
                    continue
                cleaned.append({
                    "id":             it.get("id") or "",
                    "name":           it.get("name") or "",
                    "default_amount": it.get("default_amount"),
                })
            result[doc.id] = cleaned
        return result
    except Exception as e:
        logger.error("ExpensePresetsService list_all failed: %s", e)
        return {}


def get_category(category: str) -> list:
    """Return the items list for a single category, or [] if missing."""
    if _presets_ref is None or not _validate_category(category):
        return []
    try:
        snap = _presets_ref.document(category).get()
        if not snap.exists:
            return []
        data = snap.to_dict() or {}
        return list(data.get("items") or [])
    except Exception as e:
        logger.error("ExpensePresetsService get_category(%s) failed: %s", category, e)
        return []


# ---------------------------------------------------------------------------
# Write
# ---------------------------------------------------------------------------

def add_item(category: str, name: str, default_amount=None,
             *, actor: str = "system") -> dict:
    """
    Append a new item to the category list.

    Returns {"success": bool, "item": <item dict>, "message": <str>}.
    """
    if _presets_ref is None:
        return {"success": False, "message": "Service not initialised"}
    if not _validate_category(category):
        return {"success": False, "message": f"Unknown category: {category}"}

    clean_name = _normalise_name(name)
    if not clean_name:
        return {"success": False, "message": "Name is required"}
    if len(clean_name) > 80:
        return {"success": False, "message": "Name too long (max 80 chars)"}

    amount = _coerce_amount(default_amount)

    doc_ref = _presets_ref.document(category)
    try:
        snap = doc_ref.get()
        items = []
        if snap.exists:
            items = list((snap.to_dict() or {}).get("items") or [])

        # Reject case-insensitive duplicate names within the same
        # category — keeps the tile grid tidy.
        lower = clean_name.lower()
        if any(_normalise_name(it.get("name", "")).lower() == lower for it in items):
            return {"success": False, "message": "An item with this name already exists"}

        new_item = {
            "id":             uuid.uuid4().hex[:12],
            "name":           clean_name,
            "default_amount": amount,
            "created_at":     _now_iso(),
            "updated_at":     _now_iso(),
        }
        items.append(new_item)

        doc_ref.set({
            "category":   category,
            "items":      items,
            "updated_at": _now_iso(),
            "updated_by": actor,
        }, merge=False)

        return {"success": True, "item": new_item}

    except Exception as e:
        logger.error("ExpensePresetsService add_item failed: %s", e)
        return {"success": False, "message": str(e)}


def update_item(category: str, item_id: str, *, name=None,
                default_amount=_NOT_PROVIDED, actor: str = "system") -> dict:
    """
    Update name and/or default_amount of an existing item.

    Pass name=None to leave the name unchanged. default_amount uses a
    sentinel ("_NOT_PROVIDED") because  None  is itself a valid new value
    (clears the default).
    """
    if _presets_ref is None:
        return {"success": False, "message": "Service not initialised"}
    if not _validate_category(category):
        return {"success": False, "message": f"Unknown category: {category}"}
    if not item_id:
        return {"success": False, "message": "item_id is required"}

    doc_ref = _presets_ref.document(category)
    try:
        snap = doc_ref.get()
        if not snap.exists:
            return {"success": False, "message": "Category has no presets yet"}

        items = list((snap.to_dict() or {}).get("items") or [])
        idx = next((i for i, it in enumerate(items) if it.get("id") == item_id), -1)
        if idx == -1:
            return {"success": False, "message": "Item not found"}

        current = dict(items[idx])

        if name is not None:
            clean_name = _normalise_name(name)
            if not clean_name:
                return {"success": False, "message": "Name cannot be empty"}
            if len(clean_name) > 80:
                return {"success": False, "message": "Name too long (max 80 chars)"}
            # Block rename collisions (case-insensitive) against OTHER items.
            lower = clean_name.lower()
            for j, it in enumerate(items):
                if j != idx and _normalise_name(it.get("name", "")).lower() == lower:
                    return {"success": False, "message": "Another item already uses this name"}
            current["name"] = clean_name

        # Distinguish "not provided" from "explicitly set to None"
        if default_amount is not _NOT_PROVIDED:
            current["default_amount"] = _coerce_amount(default_amount)

        current["updated_at"] = _now_iso()
        items[idx] = current

        doc_ref.set({
            "category":   category,
            "items":      items,
            "updated_at": _now_iso(),
            "updated_by": actor,
        }, merge=False)

        return {"success": True, "item": current}

    except Exception as e:
        logger.error("ExpensePresetsService update_item failed: %s", e)
        return {"success": False, "message": str(e)}


def delete_item(category: str, item_id: str, *, actor: str = "system") -> dict:
    if _presets_ref is None:
        return {"success": False, "message": "Service not initialised"}
    if not _validate_category(category):
        return {"success": False, "message": f"Unknown category: {category}"}

    doc_ref = _presets_ref.document(category)
    try:
        snap = doc_ref.get()
        if not snap.exists:
            return {"success": False, "message": "Category has no presets yet"}

        items = list((snap.to_dict() or {}).get("items") or [])
        new_items = [it for it in items if it.get("id") != item_id]
        if len(new_items) == len(items):
            return {"success": False, "message": "Item not found"}

        doc_ref.set({
            "category":   category,
            "items":      new_items,
            "updated_at": _now_iso(),
            "updated_by": actor,
        }, merge=False)

        return {"success": True}

    except Exception as e:
        logger.error("ExpensePresetsService delete_item failed: %s", e)
        return {"success": False, "message": str(e)}
