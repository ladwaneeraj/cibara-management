"""Error-monitoring layer: PII scrubbing, DSN gating, and the browser-error
sink. No network and no DSN, so Sentry stays disabled throughout."""
from cibara_api.core import observability as obs


def test_scrub_text_redacts_aadhaar_mobile_email():
    assert obs.scrub_text("Aadhaar 1234 5678 9012 done") == "Aadhaar [redacted] done"
    assert obs.scrub_text("aadhaar 123456789012") == "aadhaar [redacted]"
    assert obs.scrub_text("call 9876543210 now") == "call [redacted] now"
    assert obs.scrub_text("mail a.b+x@foo.co.in please") == "mail [redacted] please"


def test_scrub_text_leaves_non_pii_numbers():
    # 9 digits is not a mobile; a bill total is not Aadhaar.
    assert obs.scrub_text("id 123456789") == "id 123456789"
    assert obs.scrub_text("total 1234.56") == "total 1234.56"


def test_scrub_event_drops_body_cookies_and_redacts_headers_and_query():
    event = {
        "request": {
            "data": {"mobile": "9876543210", "password": "hunter2"},
            "cookies": {"cibara_rt": "secret"},
            "headers": {"Authorization": "Bearer abc", "User-Agent": "UA/1"},
            "query_string": "mobile=9876543210",
            "url": "https://host/api/x?mobile=9876543210",
        },
        "extra": {"note": "guest 9876543210, aadhaar 1234 5678 9012"},
    }
    out = obs.scrub_event(event)
    assert "data" not in out["request"]
    assert "cookies" not in out["request"]
    assert out["request"]["headers"]["Authorization"] == obs.REDACTED
    assert out["request"]["headers"]["User-Agent"] == "UA/1"
    assert out["request"]["query_string"] == ""
    assert out["request"]["url"] == "https://host/api/x"
    assert "9876543210" not in out["extra"]["note"]
    assert obs.REDACTED in out["extra"]["note"]


def test_scrub_event_redacts_sensitive_keys_anywhere():
    out = obs.scrub_event({"extra": {"token": "t", "x-api-key": "k", "ok": "v"}})
    assert out["extra"]["token"] == obs.REDACTED
    assert out["extra"]["x-api-key"] == obs.REDACTED
    assert out["extra"]["ok"] == "v"


def test_disabled_by_default_is_noop():
    assert obs.is_enabled() is False
    assert obs.report_browser_error({"message": "boom"}) is False
    obs.capture_exception(RuntimeError("x"))  # must not raise


def test_init_sentry_noop_without_dsn():
    class S:
        SENTRY_DSN = ""
        SENTRY_ENVIRONMENT = ""
        SENTRY_RELEASE = ""
        SENTRY_TRACES_SAMPLE_RATE = 0.0

    assert obs.init_sentry(S()) is False
    assert obs.is_enabled() is False


def test_client_errors_endpoint_accepts_and_returns_204(client):
    r = client.post("/api/v2/client-errors", json={
        "message": "TypeError: x is undefined",
        "kind": "onerror",
        "stack": "at foo (app.js:1:2)",
        "url": "https://host/legacy?mobile=9876543210",
        "line": 1, "col": 2, "appVersion": "2.0.0",
    })
    assert r.status_code == 204


def test_client_errors_endpoint_rejects_oversized_payload(client):
    r = client.post("/api/v2/client-errors", json={"message": "x" * 5000})
    # Pydantic max_length -> 422 envelope from the validation handler.
    assert r.status_code == 422
    assert r.json()["success"] is False
