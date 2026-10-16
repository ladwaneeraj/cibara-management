import time

from fastapi import HTTPException
import pytest

from cibara_api.core import metrics
from cibara_api.core.ratelimit import RateLimiter, enforce, limiter
from cibara_api.security import revocation, tokens
from tests.fakes import fake_firestore as ff
from google.cloud.firestore_v1 import transforms as T
from google.api_core import exceptions as gexc
from google.cloud.firestore_v1.base_query import FieldFilter


def test_rate_limiter_window():
    rl = RateLimiter()
    assert [rl.hit("k", 3, 60)[0] for _ in range(4)] == [True, True, True, False]
    ok, retry = rl.hit("k", 3, 60)
    assert not ok and 0 < retry <= 60
    assert rl.hit("other", 3, 60)[0]
    rl.reset("k")
    assert rl.hit("k", 3, 60)[0]


def test_rate_limiter_expires():
    rl = RateLimiter()
    rl.hit("k", 1, 0.05)
    assert not rl.hit("k", 1, 0.05)[0]
    time.sleep(0.06)
    assert rl.hit("k", 1, 0.05)[0]


def test_enforce_raises_429():
    limiter.reset()
    enforce("x", 1, 60)
    with pytest.raises(HTTPException) as e:
        enforce("x", 1, 60)
    assert e.value.status_code == 429 and "Retry-After" in e.value.headers


def test_global_rate_limit_middleware(client, monkeypatch):
    from cibara_api.settings import get_settings
    monkeypatch.setattr(get_settings(), "RATE_LIMIT_GLOBAL_PER_MIN", 3)
    codes = [client.get("/api/v2/config").status_code for _ in range(5)]
    assert codes[:3] == [200, 200, 200] and codes[-1] == 429


def test_revocation():
    revocation.clear()
    assert not revocation.is_revoked("u", 100)
    revocation.revoke("u", at=100)
    assert revocation.is_revoked("u", 100) and revocation.is_revoked("u", 99)
    assert not revocation.is_revoked("u", 101)


def test_token_roundtrip_and_type_checks():
    u = tokens.TokenUser("a", "uid1", "manager", "A")
    acc, ttl = tokens.mint_access(u)
    ref, payload = tokens.mint_refresh(u)
    assert tokens.user_from_access(acc).role == "manager" and ttl == 900
    assert tokens.decode(ref, tokens.REFRESH)["fam"] == payload["fam"]
    with pytest.raises(tokens.TokenError):
        tokens.decode(acc, tokens.REFRESH)
    assert tokens.is_our_token(acc) and not tokens.is_our_token("not.a.jwt")


def test_metrics_registry_and_normalise():
    metrics.reset()
    metrics.record("GET /x", 10, 200, 5, 1)
    metrics.record("GET /x", 30, 500, 7, 0)
    snap = metrics.snapshot()
    r = snap["routes"][0]
    assert r["count"] == 2 and r["errors"] == 1 and r["reads"] == 12 and r["max_ms"] == 30
    assert metrics.normalise_path("/bill_html/5b7cd545d080405bad50a2cf4ff4e2b7") == "/bill_html/:id"
    assert metrics.normalise_path("/staff/abc/detail") == "/staff/abc/detail"


def test_security_headers_and_error_envelope(client):
    r = client.get("/api/v2/nope")
    assert r.status_code == 404 and r.json() == {"success": False, "message": "Route not found"}
    assert r.headers["x-content-type-options"] == "nosniff"
    assert "server-timing" in r.headers and "x-request-id" in r.headers
    r = client.get("/api/v2/health")
    assert r.json()["status"] == "ok" and r.headers["cache-control"] == "no-store"


def test_classic_mode_serves_flask_root_and_login(client):
    from cibara_api.settings import get_settings
    assert get_settings().UI_MODE == "classic"
    r = client.get("/", follow_redirects=False)
    assert r.status_code == 200 and "<html" in r.text.lower()
    r = client.get("/login", follow_redirects=False)
    assert r.status_code == 200 and "<html" in r.text.lower()
    r = client.get("/app/bills", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "/"


def test_spa_mode_redirects_to_react(monkeypatch):
    from fastapi.testclient import TestClient
    from cibara_api import main
    from cibara_api.settings import get_settings
    monkeypatch.setattr(get_settings(), "UI_MODE", "spa")
    c = TestClient(main.create_app())
    r = c.get("/", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "/app/"
    r = c.get("/login", follow_redirects=False)
    assert r.headers["location"] == "/app/login?signout=1"
    r = c.get("/app/bills")
    assert r.status_code in (200, 503)
    if r.status_code == 200:
        assert "content-security-policy" in r.headers
        assert r.headers["cache-control"] == "no-cache"


def test_legacy_ui_is_served_under_legacy(client):
    r = client.get("/legacy")
    assert r.status_code == 200 and "<html" in r.text.lower()
    assert r.headers.get("x-firestore-reads") is not None


def test_public_config(client):
    c = client.get("/api/v2/config").json()
    assert c["firebase"]["projectId"] == "cibara-dev" and c["env"] == "UAT"


# ── fake firestore semantics (the parity tests depend on them) ────────────

def test_fake_transforms_and_queries():
    db = ff.FakeClient()
    ref = db.collection("c").document("a")
    ref.set({"n": 1, "arr": [1], "m": {"x": 1}})
    ref.update({"n": T.Increment(2), "arr": T.ArrayUnion([1, 2]), "m.y": 2, "gone": T.DELETE_FIELD})
    assert ref.get().to_dict() == {"n": 3, "arr": [1, 2], "m": {"x": 1, "y": 2}}
    ref.set({"m": {"z": 3}}, merge=True)
    assert ref.get().to_dict()["m"] == {"x": 1, "y": 2, "z": 3}
    with pytest.raises(gexc.NotFound):
        db.collection("c").document("missing").update({"a": 1})
    with pytest.raises(gexc.Conflict):
        ref.create({"a": 1})
    for i in range(5):
        db.collection("c").document(f"d{i}").set({"v": i, "t": "x" if i % 2 else "y"})
    q = db.collection("c").where(filter=FieldFilter("v", ">=", 2)).order_by("v", direction="DESCENDING").limit(2)
    assert [s.id for s in q.stream()] == ["d4", "d3"]
    assert [s.id for s in db.collection("c").where("t", "in", ["x"]).stream()] == ["d1", "d3"]
    assert db.collection("c").where("v", ">=", 0).count().get()[0][0].value == 5


def test_fake_precondition_and_transaction():
    db = ff.FakeClient()
    ref = db.collection("c").document("a")
    ref.set({"n": 1})
    snap = ref.get()
    ref.update({"n": 2})
    b = db.batch()
    b.update(ref, {"n": 3}, option=db.write_option(last_update_time=snap.update_time))
    with pytest.raises(gexc.FailedPrecondition):
        b.commit()

    @ff.transactional
    def txn(t):
        cur = t.get(ref).to_dict()["n"]
        t.update(ref, {"n": cur + 10})
    txn(db.transaction())
    assert ref.get().to_dict()["n"] == 12


def test_gapic_instrumentation_counts_and_passes_through():
    class Doc:
        def __init__(self, name):
            self.name = name

    class Resp:
        def __init__(self, name=""):
            self.document = Doc(name)

    class FakeGapic:
        def batch_get_documents(self, request=None, metadata=None):
            return iter([object(), object()])

        def run_query(self, request=None, metadata=None):
            return iter([Resp("a"), Resp("b"), Resp("")])

        def run_aggregation_query(self, request=None, metadata=None):
            return iter([object()])

        def commit(self, request=None, metadata=None):
            return {"ok": True}

    metrics._instrument(FakeGapic)
    g = FakeGapic()
    c, tok = metrics.start()
    try:
        it = g.batch_get_documents(request={})
        assert next(it, None) is not None        # DocumentReference.get pattern: one next()
        assert c.reads == 1
        assert len(list(g.run_query(request={}))) == 3
        assert c.reads == 3                      # 2 docs (+ the empty progress message ignored)
        list(g.run_aggregation_query(request={}))
        assert c.reads == 4                      # aggregation billed as one read
        assert g.commit(request={"writes": [1, 2, 3]}) == {"ok": True}
        assert c.writes == 3
    finally:
        metrics.stop(tok)
    assert metrics.current() is None


def test_real_gapic_class_is_wrapped():
    from google.cloud.firestore_v1.services.firestore import client as gapic
    metrics.instrument_google_client()
    assert gapic.FirestoreClient.run_query.__name__ == "run_query"
    assert gapic.FirestoreClient.run_query.__wrapped__  # functools.wraps applied


def test_conditional_static_request_with_gzip_does_not_crash(client):
    r = client.get("/static/icons/icon-192.png")
    assert r.status_code == 200
    etag = r.headers["etag"]
    r = client.get("/static/icons/icon-192.png", headers={"If-None-Match": etag, "Accept-Encoding": "gzip"})
    assert r.status_code == 304 and r.content == b"" and "content-encoding" not in r.headers
    r = client.get("/manifest.webmanifest", headers={"If-Modified-Since": "Thu, 01 Jan 2099 00:00:00 GMT",
                                                       "Accept-Encoding": "gzip"})
    assert r.status_code in (200, 304)
