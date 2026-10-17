"""Secrets handling: JWT_SECRET from a mounted file (Secret Manager volume
pattern) and the legacy API_KEY redaction from the classic page (CLAUDE.md §10)."""
import pytest

from cibara_api import settings as settings_mod


def test_read_secret_file(tmp_path):
    f = tmp_path / "jwt.secret"
    f.write_text("  super-secret-value-0123456789abcdef  \n", encoding="utf-8")
    assert settings_mod._read_secret_file(str(f)) == "super-secret-value-0123456789abcdef"


def test_read_secret_file_missing_raises():
    with pytest.raises(RuntimeError):
        settings_mod._read_secret_file("/no/such/secret/file/xyz")


def test_jwt_secret_file_used_when_env_unset(tmp_path, monkeypatch):
    secret = "file-based-secret-0123456789abcdef0123456789"
    f = tmp_path / "jwt.secret"
    f.write_text(secret + "\n", encoding="utf-8")
    monkeypatch.setenv("JWT_SECRET_FILE", str(f))
    monkeypatch.delenv("JWT_SECRET", raising=False)
    settings_mod.get_settings.cache_clear()
    try:
        s = settings_mod.get_settings()
        assert s.JWT_SECRET == secret
    finally:
        # restore the cached settings for the rest of the session
        settings_mod.get_settings.cache_clear()


def test_api_key_redacted_from_classic_page(client, monkeypatch):
    key = "super-secret-integration-key-ABC123456789"
    monkeypatch.setenv("API_KEY", key)
    r = client.get("/")
    assert r.status_code == 200
    assert r.headers.get("content-type", "").startswith("text/html")
    # The key is passed to the template but redacted by the bridge after_request.
    assert key not in r.text
