"""
request_guard — server-side protection against duplicate money writes.

Why this exists
───────────────
On 15-09-2026 a manager double-clicked "Add Payment" on Room 27. The
payments collection already had a 5-second idempotency check, so only ONE
payment doc was written — but the room balance and the day totals had
already been decremented TWICE by the time that check ran. The guest then
showed a ₹500 refund owed. The lesson: the duplicate check must run BEFORE
the first write of the request, not inside one of the writers.

What this does
──────────────
`@guard_duplicate_submit()` wraps a JSON POST route with two checks. Both
are backed by a single Firestore collection (`request_guard`) so they hold
across gunicorn workers and across devices; an in-process dict would not.

1. Exact replay — same `op_id` (header `X-Op-Id`, or `op_id` in the body).
   The stored response of the first request is returned as-is. This covers
   the auth-401 retry in apiFetch and any network-level retry: the server
   does the work once, the client can ask as many times as it likes.

2. Same-intent repeat — same route + same body (volatile fields stripped)
   within `window_seconds`. Returns HTTP 409 with `duplicate_suspected`
   and `seconds_ago`. The client either drops it (a double-click, under
   ~2s) or asks the operator to confirm and re-sends with
   `X-Force-Duplicate: 1`. The claim is a Firestore transaction, so two
   simultaneous requests cannot both pass.

If the wrapped route fails (exception, non-2xx, or `success: false`), the
fingerprint claim is released so the operator can retry at once.

Fails OPEN: if Firestore itself errors during a check, the request goes
through. Losing a payment is worse than the rare duplicate this would let
past, and the writers' own 5s check still stands behind it.

Docs in `request_guard` carry `expires_at`; enable a Firestore TTL policy
on that field so the collection does not grow forever.
"""
from __future__ import annotations

import functools
import hashlib
import json
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from flask import jsonify, request

logger = logging.getLogger(__name__)

COLLECTION = "request_guard"
DEFAULT_WINDOW_SECONDS = 8
RESPONSE_TTL = timedelta(days=1)

# Keys that differ between two clicks that mean the same thing.
VOLATILE_KEYS = frozenset({
    "op_id", "force_duplicate", "idempotency_key",
    "time", "date", "timestamp", "client_ts", "_t",
    "room_data",  # client snapshot of the room; changes after the 1st write
})

_OP_ID_RE = re.compile(r"[^A-Za-z0-9_\-]")

_db = None


def _get_db():
    global _db
    if _db is None:
        from config import db  # lazy: config initialises Firebase on import
        _db = db
    return _db


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── Fingerprinting ────────────────────────────────────────────────────────

def canonical_body(body: dict) -> str:
    """Stable JSON of the body with volatile keys removed."""
    cleaned = {k: v for k, v in body.items() if k not in VOLATILE_KEYS}
    return json.dumps(cleaned, sort_keys=True, separators=(",", ":"),
                      default=str)


def fingerprint(path: str, body: dict) -> str:
    raw = f"{path}|{canonical_body(body)}"
    return "fp_" + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:24]


def _op_doc_id(op_id: str) -> str:
    return "op_" + _OP_ID_RE.sub("", str(op_id))[:80]


# ── Firestore access (each is small so tests can monkeypatch them) ────────

def _claim_fingerprint(fp: str, path: str, window_seconds: int) -> Optional[float]:
    """
    Atomically claim `fp`. Returns None when the claim is ours (proceed),
    or the age in seconds of a still-live earlier claim (reject).
    """
    from firebase_admin import firestore

    db = _get_db()
    ref = db.collection(COLLECTION).document(fp)
    now = _now()

    @firestore.transactional
    def _txn(txn):
        snap = ref.get(transaction=txn)
        if snap.exists:
            at = (snap.to_dict() or {}).get("at")
            if isinstance(at, datetime):
                if at.tzinfo is None:
                    at = at.replace(tzinfo=timezone.utc)
                age = (now - at).total_seconds()
                if 0 <= age < window_seconds:
                    return age
        txn.set(ref, {
            "kind": "fingerprint", "path": path, "at": now,
            "expires_at": now + RESPONSE_TTL,
        })
        return None

    return _txn(db.transaction())


def _release_fingerprint(fp: str) -> None:
    try:
        _get_db().collection(COLLECTION).document(fp).delete()
    except Exception as e:  # noqa: BLE001
        logger.warning("request_guard: release %s failed: %s", fp, e)


def _lookup_op(op_id: str) -> Optional[dict]:
    snap = _get_db().collection(COLLECTION).document(_op_doc_id(op_id)).get()
    if not snap.exists:
        return None
    return snap.to_dict() or None


def _store_op(op_id: str, path: str, status: int, body: dict) -> None:
    now = _now()
    _get_db().collection(COLLECTION).document(_op_doc_id(op_id)).set({
        "kind": "op", "path": path, "status": status, "body": body,
        "at": now, "expires_at": now + RESPONSE_TTL,
    })


# ── Response helpers ──────────────────────────────────────────────────────

def _split(rv) -> tuple[Any, int]:
    """Flask view return value -> (response_obj, status_code)."""
    if isinstance(rv, tuple):
        resp = rv[0]
        status = rv[1] if len(rv) > 1 and isinstance(rv[1], int) else 200
        return resp, status
    return rv, getattr(rv, "status_code", 200)


def _json_of(resp) -> Optional[dict]:
    try:
        data = resp.get_json(silent=True)
    except Exception:  # noqa: BLE001
        return None
    return data if isinstance(data, dict) else None


def _succeeded(status: int, body: Optional[dict]) -> bool:
    if status >= 400:
        return False
    if body is not None and body.get("success") is False:
        return False
    return True


# ── The decorator ─────────────────────────────────────────────────────────

def guard_duplicate_submit(window_seconds: int = DEFAULT_WINDOW_SECONDS):
    """
    Wrap a JSON POST route. Place it directly above `def` (innermost) so
    authentication decorators run first and an unauthenticated request
    never consumes a claim.
    """
    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            body = request.get_json(silent=True)
            if not isinstance(body, dict):
                return fn(*args, **kwargs)  # form/multipart posts: not ours

            path = request.path
            op_id = request.headers.get("X-Op-Id") or body.get("op_id")
            force = (request.headers.get("X-Force-Duplicate") == "1"
                     or body.get("force_duplicate") is True)

            # 1. Exact replay of a request we already answered.
            if op_id:
                try:
                    cached = _lookup_op(op_id)
                except Exception as e:  # noqa: BLE001
                    logger.warning("request_guard: op lookup failed: %s", e)
                    cached = None
                if cached and isinstance(cached.get("body"), dict):
                    logger.info("request_guard: replaying op %s on %s", op_id, path)
                    replay = dict(cached["body"])
                    replay["replayed"] = True
                    return jsonify(replay), int(cached.get("status") or 200)

            # 2. Same intent, seconds apart.
            fp = None
            if not force:
                fp = fingerprint(path, body)
                try:
                    age = _claim_fingerprint(fp, path, window_seconds)
                except Exception as e:  # noqa: BLE001
                    logger.warning("request_guard: claim failed (open): %s", e)
                    age, fp = None, None
                if age is not None:
                    logger.warning(
                        "request_guard: duplicate submit on %s (%.1fs ago) "
                        "rejected; body=%s", path, age, canonical_body(body))
                    return jsonify(
                        success=False, duplicate_suspected=True,
                        seconds_ago=round(age, 1),
                        message=(f"This exact entry was already submitted "
                                 f"{age:.0f}s ago."),
                    ), 409

            try:
                rv = fn(*args, **kwargs)
            except Exception:
                if fp:
                    _release_fingerprint(fp)
                raise

            resp, status = _split(rv)
            data = _json_of(resp)
            if not _succeeded(status, data):
                if fp:
                    _release_fingerprint(fp)
            elif op_id and data is not None:
                try:
                    _store_op(op_id, path, status, data)
                except Exception as e:  # noqa: BLE001
                    logger.warning("request_guard: op store failed: %s", e)
            return rv

        return wrapper
    return decorator
