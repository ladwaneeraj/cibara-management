"""Phase 3: CDN-friendly Cache-Control on classic /static assets. A versioned
(?v=) URL is immutable; an unversioned hit gets a short TTL."""


def test_static_versioned_is_immutable(client):
    r = client.get("/static/offline.html?v=12345")
    assert r.status_code == 200
    assert r.headers.get("cache-control") == "public, max-age=31536000, immutable"


def test_static_unversioned_short_ttl(client):
    r = client.get("/static/offline.html")
    assert r.status_code == 200
    assert r.headers.get("cache-control") == "public, max-age=3600"


def test_api_still_no_store(client):
    r = client.get("/api/v2/health")
    assert r.headers.get("cache-control") == "no-store"
