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
