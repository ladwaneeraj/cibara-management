"""FCM web-push for owner booking alerts.

Device tokens (from staff who granted notification permission in the ERP) are
stored in Firestore ``push_tokens/{token}``; a new web booking fans a push out to
all of them via firebase-admin messaging. Best-effort and fail-open: a push
failure never affects the booking. Dead tokens are pruned on send.
"""
import logging
from datetime import datetime

import config

logger = logging.getLogger(__name__)

_COLLECTION = "push_tokens"
# FCM error codes that mean the token is permanently dead and should be removed.
_DEAD = {
    "registration-token-not-registered",
    "messaging/registration-token-not-registered",
    "invalid-registration-token",
    "invalid-argument",
}


def register_token(token: str, user_id: str = "", role: str = "") -> bool:
    """Store (or refresh) one device token for the owner/staff. Idempotent."""
    if not isinstance(token, str) or not token.strip():
        return False
    config.db.collection(_COLLECTION).document(token).set({
        "token": token,
        "user_id": user_id or "unknown",
        "role": role or "",
        "updated_at": datetime.now(config.IST).isoformat(),
    }, merge=True)
    return True


def _all_tokens() -> list:
    return [d.id for d in config.db.collection(_COLLECTION).stream()]


def send_to_all(title: str, body: str, data: dict | None = None,
                link: str = "/") -> int:
    """Push ``title``/``body`` to every stored device. Returns #delivered.

    Rendered with the lodge icon and opens the ERP at ``link`` on tap (webpush
    config), so the owner gets a branded, tappable alert instead of a bare line.
    Never raises: any failure (no messaging, no tokens, send error) returns 0.
    """
    try:
        from firebase_admin import messaging
    except Exception:  # noqa: BLE001
        return 0
    tokens = _all_tokens()
    if not tokens:
        return 0
    # Icon/badge are served by the ERP; relative URLs resolve against the FCM
    # service-worker origin (the ERP). require_interaction keeps the alert on
    # screen until the owner taps it (like a food-delivery app).
    webpush = messaging.WebpushConfig(
        notification=messaging.WebpushNotification(
            title=title, body=body,
            icon="/static/icons/icon-192.png",
            badge="/static/icons/favicon-32.png",
            tag="cibara", require_interaction=True,
        ),
        fcm_options=messaging.WebpushFCMOptions(link=link or "/"),
    )
    msg = messaging.MulticastMessage(
        tokens=tokens,
        notification=messaging.Notification(title=title, body=body),
        webpush=webpush,
        data={k: str(v) for k, v in (data or {}).items()},
    )
    try:
        resp = messaging.send_each_for_multicast(msg)
    except Exception:  # noqa: BLE001
        logger.exception("push: multicast send failed")
        return 0
    # Prune tokens FCM reports as permanently dead.
    for i, r in enumerate(resp.responses):
        if not r.success and r.exception is not None:
            code = getattr(r.exception, "code", "") or ""
            if code in _DEAD:
                try:
                    config.db.collection(_COLLECTION).document(tokens[i]).delete()
                except Exception:  # noqa: BLE001
                    pass
    return resp.success_count
