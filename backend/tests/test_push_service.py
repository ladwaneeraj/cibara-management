"""services.push_service: token storage + fan-out with dead-token pruning."""
from unittest.mock import MagicMock, patch

import config
from services import push_service


def test_register_token_stores_and_rejects_blank():
    assert push_service.register_token("tok1", "u1", "admin") is True
    assert push_service.register_token("", "u1") is False
    assert push_service.register_token(None) is False
    assert [d.id for d in config.db.collection("push_tokens").stream()] == ["tok1"]


def test_send_to_all_no_tokens_returns_zero():
    assert push_service.send_to_all("t", "b") == 0


def test_send_to_all_sends_and_prunes_dead_tokens():
    push_service.register_token("good", "u1")
    push_service.register_token("dead", "u2")
    from firebase_admin import messaging

    def fake_send(msg):
        responses = []
        for t in msg.tokens:  # align responses to the exact token order sent
            if t == "dead":
                exc = MagicMock(code="registration-token-not-registered")
                responses.append(MagicMock(success=False, exception=exc))
            else:
                responses.append(MagicMock(success=True, exception=None))
        return MagicMock(success_count=sum(1 for r in responses if r.success),
                         responses=responses)

    with patch.object(messaging, "send_each_for_multicast", side_effect=fake_send) as send:
        delivered = push_service.send_to_all("New booking", "body", {"booking_id": "b1"})

    assert delivered == 1
    send.assert_called_once()
    # ONE webpush notification message: reliable background display on mobile,
    # and no top-level notification (that second spec is what duplicated the
    # card). Extra data rides on the notification for the SW's click handler.
    sent = send.call_args.args[0]
    assert sent.notification is None
    note = sent.webpush.notification
    assert note.title == "New booking" and note.body == "body"
    assert note.data["booking_id"] == "b1"
    # the dead token is removed; the good one stays
    assert [d.id for d in config.db.collection("push_tokens").stream()] == ["good"]


def _capture_note(**kwargs):
    """Send one push through a mocked FCM and return the notification spec."""
    push_service.register_token("tok", "u1")
    from firebase_admin import messaging
    captured = {}

    def fake_send(msg):
        captured["note"] = msg.webpush.notification
        return MagicMock(success_count=1, responses=[MagicMock(success=True, exception=None)])

    with patch.object(messaging, "send_each_for_multicast", side_effect=fake_send):
        push_service.send_to_all("t", "b", **kwargs)
    return captured["note"]


def test_actions_param_builds_action_buttons():
    note = _capture_note(data={"room": "213"},
                         actions=[{"action": "renew", "title": "Renew now"}])
    assert [(a.action, a.title) for a in note.actions] == [("renew", "Renew now")]
    assert note.data["room"] == "213"


def test_wa_still_defaults_to_send_confirmation_button():
    note = _capture_note(data={"wa": "919876500000", "wa_text": "hi"})
    assert [(a.action, a.title) for a in note.actions] == [("confirm", "Send confirmation")]


def test_no_actions_when_none_given():
    note = _capture_note(data={"booking_id": "b1"})
    assert note.actions is None


def test_image_passthrough():
    note = _capture_note(data={"booking_id": "b1"}, image="/static/icons/notif-booking.png")
    assert note.image == "/static/icons/notif-booking.png"
    assert _capture_note(data={"booking_id": "b1"}).image is None
