"""Web-booking settings: settings/web_config, public GET /web/config, CORS."""
import config

ORIGIN = "https://cibaracomforts.test"


def test_web_config_defaults_closed():
    config.invalidate_web_config_cache()
    cfg = config.get_web_config()
    assert cfg["online_bookings_enabled"] is False
    assert cfg["buffer"] == 1
    assert cfg["cleaning_gap_minutes"] == 120
    assert cfg["hold_ttl_minutes"] == 10


def test_category_pools():
    assert config.CATEGORY_POOLS == {
        "premium": ["200", "201", "202", "203", "204", "205", "206"],
        "deluxe": ["223", "224", "225", "226", "227"],
    }


def test_get_web_config_endpoint_public(client):
    # No Authorization header: the endpoint is public.
    r = client.get("/web/config", headers={"Origin": ORIGIN})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body == {"online_bookings_enabled": False, "cleaning_gap_minutes": 120}
    assert r.headers.get("access-control-allow-origin") == ORIGIN


def test_cors_not_granted_to_unlisted_origin(client):
    r = client.get("/web/config", headers={"Origin": "https://evil.example"})
    assert r.status_code == 200
    assert "access-control-allow-origin" not in r.headers


def test_toggle_web_config_persists(client, admin):
    r = client.post("/settings/web_config", headers=admin, json={"online_bookings_enabled": True})
    assert r.status_code == 200, r.text
    assert r.json()["config"]["online_bookings_enabled"] is True
    r = client.get("/web/config")
    assert r.json()["online_bookings_enabled"] is True
    r = client.get("/settings/web_config", headers=admin)
    assert r.json()["config"]["online_bookings_enabled"] is True


def test_web_config_post_requires_auth_and_permission(client, staff):
    assert client.post("/settings/web_config", json={"online_bookings_enabled": True}).status_code == 401
    assert client.post("/settings/web_config", headers=staff,
                       json={"online_bookings_enabled": True}).status_code == 403
    assert client.get("/web/config").json()["online_bookings_enabled"] is False
