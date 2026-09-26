"""
Guest portal (QR room service): the staff half.

The guest's phone never talks to Flask. It signs in anonymously, proves the
mobile number given at check-in, and reads/writes its own documents straight
into Firestore under firestore.rules (see the "Guest portal" section there
for the chain every guest write has to survive). This module is everything
that happens on the STAFF side of that line:

  • settings/guest_portal      on/off switch, hotel + reception details,
                               Wi-Fi, house rules, which request kinds are on
  • guestRequests/{id}         acknowledge / complete (audited, Admin SDK)
  • guestSessions/{uid}        stamped `closed` at checkout and room transfer
  • the QR image every room shows (one URL, same for all rooms)

Collections, field names and the team-per-kind mapping are mirrored in
firestore.rules and guest/app.js. Change one, change all three.
"""

from __future__ import annotations

import io
import time
from typing import Iterable, Optional

from google.cloud.firestore_v1.base_query import FieldFilter

from config import db, logger, FIREBASE_WEB_CONFIG
from services.audit_log import write_log, attribution_update

SETTINGS_DOC = "guest_portal"
REQUESTS = "guestRequests"
SESSIONS = "guestSessions"

# Order here is the order of tiles on the guest's phone.
REQUEST_KINDS: dict[str, dict] = {
    "room_service":   {"label": "Room service",     "team": "desk"},
    "housekeeping":   {"label": "Housekeeping",     "team": "housekeeping"},
    "extra_items":    {"label": "Extra items",      "team": "housekeeping"},
    "laundry":        {"label": "Laundry pickup",   "team": "housekeeping"},
    "maintenance":    {"label": "Something broken", "team": "desk"},
    "wake_up":        {"label": "Wake-up call",     "team": "desk"},
    "late_checkout":  {"label": "Late checkout",    "team": "desk"},
    "taxi":           {"label": "Taxi / cab",       "team": "desk"},
    "do_not_disturb": {"label": "Do not disturb",   "team": "housekeeping"},
    "complaint":      {"label": "Talk to manager",  "team": "desk"},
}
FEEDBACK = "guestFeedback"
HISTORY_MAX_DAYS = 90

STATUSES = ("open", "acknowledged", "done", "cancelled")
# Staff may move a request forward only; guests cancel their own via rules.
_STAFF_TRANSITIONS = {
    ("open", "acknowledged"),
    ("open", "done"),
    ("acknowledged", "done"),
}

SETTINGS_DEFAULTS: dict = {
    "enabled": False,
    "hotelName": "Cibara Comforts",
    "receptionPhone": "",
    "wifiName": "",
    "wifiPassword": "",
    "houseRules": "",
    "nearbyInfo": "",
    "whatsapp": "",
    "checkoutTime": "11:00 AM",
    # Hours a phone stays logged in after its last action (rules cap it too).
    "sessionHours": 24,
    # Where the QR points. Blank = the Firebase Hosting site of this project.
    "publicBaseUrl": "",
    "kinds": {k: True for k in REQUEST_KINDS},
}

_SETTINGS_KEYS = frozenset(SETTINGS_DEFAULTS.keys())


def _now_ms() -> int:
    return int(time.time() * 1000)


# ─── Settings ─────────────────────────────────────────────────────────────

def get_settings() -> dict:
    snap = db.collection("settings").document(SETTINGS_DOC).get()
    stored = snap.to_dict() if snap.exists else {}
    merged = dict(SETTINGS_DEFAULTS)
    merged["kinds"] = dict(SETTINGS_DEFAULTS["kinds"])
    for k, v in (stored or {}).items():
        if k == "kinds" and isinstance(v, dict):
            merged["kinds"].update({kk: bool(vv) for kk, vv in v.items() if kk in REQUEST_KINDS})
        elif k in _SETTINGS_KEYS:
            merged[k] = v
    merged["portalUrl"] = portal_url(merged)
    merged["kindMeta"] = REQUEST_KINDS
    return merged


def save_settings(patch: dict, user: Optional[dict]) -> dict:
    """Validate and merge a partial settings update. Raises ValueError."""
    if not isinstance(patch, dict):
        raise ValueError("settings payload must be an object")
    clean: dict = {}
    for key, value in patch.items():
        if key not in _SETTINGS_KEYS:
            continue
        if key == "enabled":
            clean[key] = bool(value)
        elif key == "sessionHours":
            try:
                hours = int(value)
            except (TypeError, ValueError):
                raise ValueError("sessionHours must be a whole number")
            if not 1 <= hours <= 72:
                raise ValueError("sessionHours must be between 1 and 72")
            clean[key] = hours
        elif key == "kinds":
            if not isinstance(value, dict):
                raise ValueError("kinds must be an object")
            clean[key] = {k: bool(value.get(k, True)) for k in REQUEST_KINDS}
        elif key == "publicBaseUrl":
            url = str(value or "").strip().rstrip("/")
            if url and not url.startswith("https://"):
                raise ValueError("publicBaseUrl must start with https://")
            clean[key] = url
        else:
            text = str(value or "").strip()
            limit = 2000 if key in ("houseRules", "nearbyInfo") else 120
            if len(text) > limit:
                raise ValueError(f"{key} is too long (max {limit} characters)")
            clean[key] = text
    if not clean:
        raise ValueError("nothing to update")

    before = get_settings()
    clean.update(attribution_update())
    db.collection("settings").document(SETTINGS_DOC).set(clean, merge=True)
    after = get_settings()
    write_log(
        "guest_portal.settings.update",
        target_collection="settings",
        target_id=SETTINGS_DOC,
        before={k: before.get(k) for k in clean if k in before and k != "wifiPassword"},
        after={k: after.get(k) for k in clean if k in after and k != "wifiPassword"},
        metadata={"userId": (user or {}).get("userId")},
    )
    return after


def portal_url(settings: Optional[dict] = None) -> str:
    """The one URL printed on every room's QR."""
    s = settings or get_settings()
    configured = str(s.get("publicBaseUrl") or "").strip().rstrip("/")
    if configured:
        return configured
    project = FIREBASE_WEB_CONFIG.get("projectId", "")
    return f"https://{project}.web.app"


def qr_png(url: str, box_size: int = 12) -> bytes:
    """PNG bytes of a QR for `url`. Imported lazily so the app still boots
    if the optional `qrcode` package is missing; the route reports it."""
    import qrcode  # qrcode[pil] in requirements.txt

    qr = qrcode.QRCode(
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=box_size,
        border=2,
    )
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# ─── Requests ─────────────────────────────────────────────────────────────

def _request_dict(snap) -> dict:
    d = snap.to_dict() or {}
    d["id"] = snap.id
    return d


def list_active_requests(team: Optional[str] = None) -> list[dict]:
    """Open + acknowledged requests, newest first. `team` narrows to one
    team's kinds (housekeeping sees only its own)."""
    q = db.collection(REQUESTS).where(filter=FieldFilter("active", "==", True))
    if team:
        q = q.where(filter=FieldFilter("team", "==", team))
    rows = [_request_dict(s) for s in q.stream()]
    rows.sort(key=lambda r: r.get("createdAtMs") or 0, reverse=True)
    return rows


def set_request_status(request_id: str, status: str, user: dict,
                       team_limit: Optional[str] = None) -> dict:
    """Move a guest request forward. Raises ValueError on a bad transition,
    LookupError if it does not exist, PermissionError if the caller's team
    may not touch it."""
    if status not in ("acknowledged", "done"):
        raise ValueError("status must be acknowledged or done")
    ref = db.collection(REQUESTS).document(str(request_id))
    snap = ref.get()
    if not snap.exists:
        raise LookupError("request not found")
    current = snap.to_dict() or {}
    if team_limit and current.get("team") != team_limit:
        raise PermissionError("this request belongs to another team")
    if (current.get("status"), status) not in _STAFF_TRANSITIONS:
        raise ValueError(f"cannot move a {current.get('status')} request to {status}")

    who = (user or {}).get("userId") or "system"
    now_ms = _now_ms()
    patch: dict = {"status": status, "active": status != "done"}
    if status == "acknowledged":
        patch.update({"acknowledgedBy": who, "acknowledgedAtMs": now_ms})
    else:
        patch.update({"doneBy": who, "doneAtMs": now_ms})
        if not current.get("acknowledgedBy"):
            patch.update({"acknowledgedBy": who, "acknowledgedAtMs": now_ms})
    patch.update(attribution_update())
    ref.update(patch)

    write_log(
        f"guest_request.{status}",
        target_collection=REQUESTS,
        target_id=snap.id,
        before={"status": current.get("status")},
        after={"status": status},
        metadata={
            "room": current.get("room"),
            "stay_id": current.get("stayId"),
            "kind": current.get("kind"),
        },
    )
    updated = dict(current)
    updated.update(patch)
    updated["id"] = snap.id
    return updated


def _elapsed(row: dict, start: str, end: str) -> Optional[int]:
    a, b = row.get(start), row.get(end)
    return int((b - a) / 1000) if isinstance(a, (int, float)) and isinstance(b, (int, float)) else None


def request_history(days: int = 7, team: Optional[str] = None) -> dict:
    """
    Every request of the last `days` (done and cancelled included), newest
    first, with who handled it and how long each step took, plus the stay
    ratings guests left in the same window. `team` narrows to one team's
    requests (housekeeping sees only its own).
    """
    days = max(1, min(int(days or 7), HISTORY_MAX_DAYS))
    since = _now_ms() - days * 86_400_000
    q = (db.collection(REQUESTS)
         .where(filter=FieldFilter("createdAtMs", ">=", since)))
    if team:
        q = q.where(filter=FieldFilter("team", "==", team))
    rows = []
    for snap in q.stream():
        r = _request_dict(snap)
        r["responseSec"] = _elapsed(r, "createdAtMs", "acknowledgedAtMs")
        r["completionSec"] = _elapsed(r, "createdAtMs", "doneAtMs")
        rows.append(r)
    rows.sort(key=lambda r: r.get("createdAtMs") or 0, reverse=True)

    feedback: list[dict] = []
    if not team:
        fq = db.collection(FEEDBACK).where(filter=FieldFilter("createdAtMs", ">=", since))
        feedback = [_request_dict(s) for s in fq.stream()]
        feedback.sort(key=lambda r: r.get("createdAtMs") or 0, reverse=True)

    done = [r for r in rows if r.get("status") == "done" and r.get("completionSec") is not None]
    acked = [r for r in rows if r.get("responseSec") is not None]
    summary = {
        "days": days,
        "total": len(rows),
        "done": len(done),
        "cancelled": sum(1 for r in rows if r.get("status") == "cancelled"),
        "avgResponseSec": int(sum(r["responseSec"] for r in acked) / len(acked)) if acked else None,
        "avgCompletionSec": int(sum(r["completionSec"] for r in done) / len(done)) if done else None,
        "avgRating": (round(sum(f.get("rating", 0) for f in feedback) / len(feedback), 1)
                      if feedback else None),
    }
    return {"requests": rows, "feedback": feedback, "summary": summary}


# ─── Sessions ─────────────────────────────────────────────────────────────

def close_sessions_for_room(room: Optional[str], reason: str) -> int:
    """
    Stamp every active phone session logged in for `room` as `closed`.
    The rules already refuse a phone whose room is no longer occupied by
    the number it proved; this makes the phone find out NOW (its session
    listener fires) instead of on its next tap. Best effort: never raises,
    because it runs inside checkout and room transfer.
    """
    if not room:
        return 0
    try:
        q = (db.collection(SESSIONS)
             .where(filter=FieldFilter("room", "==", str(room)))
             .where(filter=FieldFilter("status", "==", "active")))
        batch = db.batch()
        n = 0
        for snap in q.stream():
            batch.update(snap.reference, {
                "status": "closed",
                "closedAtMs": _now_ms(),
                "closedReason": reason,
            })
            n += 1
        if n:
            batch.commit()
            logger.info(f"guest_portal: closed {n} session(s) for room {room} ({reason})")
        return n
    except Exception as e:  # noqa: BLE001 — checkout must never fail on this
        logger.error(f"guest_portal.close_sessions_for_room({room}) failed: {e}", exc_info=True)
        return 0


def team_for_role(role: Optional[str]) -> Optional[str]:
    """Housekeeping only ever sees its own team; other roles see all."""
    return "housekeeping" if role == "housekeeping" else None


def kinds_for(team: Optional[str]) -> Iterable[str]:
    return [k for k, m in REQUEST_KINDS.items() if team is None or m["team"] == team]
