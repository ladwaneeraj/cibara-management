"""The lean /analytics React bundle is served by FastAPI under /analytics
(built to <FRONTEND_DIST>/analytics), in classic mode too, without touching the
Flask blueprint's /analytics/overview and /analytics/snapshot routes."""
from fastapi.testclient import TestClient

from cibara_api import main
from cibara_api.settings import get_settings


def _app(monkeypatch, tmp_path, build=True):
    if build:
        a = tmp_path / "analytics"
        (a / "assets").mkdir(parents=True)
        (a / "index.html").write_text("<!doctype html><title>Cibara Analytics</title>")
        (a / "assets" / "index-abc.js").write_text("console.log(1)")
        (a / "secret.txt").write_text("not an asset")
        (tmp_path / "outside.js").write_text("nope")
    monkeypatch.setattr(get_settings(), "FRONTEND_DIST", str(tmp_path))
    return TestClient(main.create_app())


def test_analytics_index_is_served_in_classic_mode(monkeypatch, tmp_path):
    assert get_settings().UI_MODE == "classic"
    c = _app(monkeypatch, tmp_path)
    r = c.get("/analytics/")
    assert r.status_code == 200 and "Cibara Analytics" in r.text
    assert r.headers["cache-control"] == "no-cache"


def test_analytics_without_slash_redirects(monkeypatch, tmp_path):
    c = _app(monkeypatch, tmp_path)
    r = c.get("/analytics", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "/analytics/"


def test_analytics_assets_are_immutable(monkeypatch, tmp_path):
    c = _app(monkeypatch, tmp_path)
    r = c.get("/analytics/assets/index-abc.js")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert c.get("/analytics/assets/missing.js").status_code == 404


def test_analytics_assets_cannot_escape_the_bundle(monkeypatch, tmp_path):
    c = _app(monkeypatch, tmp_path)
    assert c.get("/analytics/assets/../secret.txt").status_code in (404, 400)
    assert c.get("/analytics/assets/..%2F..%2Foutside.js").status_code == 404


def test_analytics_not_built_is_503(monkeypatch, tmp_path):
    c = _app(monkeypatch, tmp_path, build=False)
    assert c.get("/analytics/").status_code == 503


def test_other_analytics_paths_still_reach_the_legacy_app(monkeypatch, tmp_path):
    """/analytics/<anything but assets/> must NOT be swallowed by the static
    route: the Flask blueprint owns /analytics/overview and /analytics/snapshot."""
    c = _app(monkeypatch, tmp_path)
    r = c.get("/analytics/overview")
    assert "Cibara Analytics" not in r.text
