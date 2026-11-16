"""FCM web-push for owner booking alerts.

Device tokens (from staff who granted notification permission in the ERP) are
stored in Firestore ``push_tokens/{token}``; a new web booking fans a push out to
all of them via firebase-admin messaging. Best-effort and fail-open: a push
failure never affects the booking. Dead tokens are pruned on send.
"""
import logging
import os
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


def _app_origin() -> str:
    """Absolute https origin used as the notification tap target, if configured."""
    o = (os.getenv("PUBLIC_ORIGIN") or os.getenv("APP_ORIGIN") or "").rstrip("/")
    return o if o.startswith("https://") else ""


def send_to_all(title: str, body: str, data: dict | None = None,
                link: str = "/", actions: list | None = None) -> int:
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
    # ONE webpush NOTIFICATION message — no top-level notification, no data-only.
    #   * A data-only message is throttled / not shown when the app is
    #     backgrounded on mobile (it relies on the SW waking to render it), which
    #     is why renewals stopped arriving. A notification message is auto-shown
    #     by the OS, reliably, even with the app closed.
    #   * FCM does NOT call onBackgroundMessage for a notification message, so the
    #     SW cannot double-render it → exactly one card (the duplicate bug came
    #     from sending TWO specs: a top-level notification AND a webpush one).
    # Icon/badge/require-interaction, the tap target (data.link) and the optional
    # "Send confirmation" action (when a guest number rides in data.wa) all live
    # on this one notification; the SW's notificationclick acts on its data.
    _link = link if isinstance(link, str) and link.startswith("https://") else _app_origin()
    _data = {"link": _link or "/", **{k: str(v) for k, v in (data or {}).items()}}
    # Per-alert action buttons (e.g. "Renew now"); fall back to the "Send
    # confirmation" button whenever a guest number rides along.
    if actions:
        _actions = [messaging.WebpushNotificationAction(action=a["action"], title=a["title"])
                    for a in actions]
    elif _data.get("wa"):
        _actions = [messaging.WebpushNotificationAction(action="confirm", title="Send confirmation")]
    else:
        _actions = None
    wp = {
        "notification": messaging.WebpushNotification(
            title=title, body=body,
            icon="/static/icons/icon-192.png",
            badge="/static/icons/favicon-32.png",
            require_interaction=True,
            tag=_data.get("tag") or None,
            data=_data,
            actions=_actions,
        ),
    }
    # fcm_options.link must be an absolute https URL or the encoder drops EVERY
    # push; omit it otherwise — the SW's notificationclick opens the app anyway.
    if _link:
        wp["fcm_options"] = messaging.WebpushFCMOptions(link=_link)
    msg = messaging.MulticastMessage(tokens=tokens, webpush=messaging.WebpushConfig(**wp))
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
