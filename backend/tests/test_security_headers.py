"""Security response headers: classic-UI CSP, HSTS gating, and the always-on
hardening headers. The SPA CSP (/app) is covered implicitly by middleware; here
we focus on the classic path and the API."""


def test_common_hardening_headers_present(client):
    r = client.get("/api/v2/health")
    h = {k.lower(): v for k, v in r.headers.items()}
    assert h.get("x-content-type-options") == "nosniff"
    assert h.get("referrer-policy") == "strict-origin-when-cross-origin"
    assert h.get("x-frame-options") == "SAMEORIGIN"


def test_api_json_has_no_csp_but_is_no_store(client):
    r = client.get("/api/v2/health")
    names = {k.lower() for k in r.headers}
    assert "content-security-policy" not in names
    assert r.headers.get("cache-control") == "no-store"


def test_hsts_absent_off_cloud_run(client):
    # K_SERVICE is unset in tests → not Cloud Run → no HSTS (http localhost).
    r = client.get("/api/v2/health")
    assert "strict-transport-security" not in {k.lower() for k in r.headers}


def test_classic_html_page_gets_classic_csp(client):
    # Classic mode (default): "/login" falls through to the Flask login page.
    r = client.get("/login")
    ctype = r.headers.get("content-type", "")
    if r.status_code == 200 and ctype.startswith("text/html"):
        csp = r.headers.get("content-security-policy", "")
        assert csp, "classic HTML page should carry a CSP"
        assert "frame-ancestors 'self'" in csp
        assert "object-src 'none'" in csp
        # classic policy pins the origins the classic UI actually loads
        assert "tile.openstreetmap.org" in csp
        assert "'unsafe-inline'" in csp  # legacy inline scripts/handlers
