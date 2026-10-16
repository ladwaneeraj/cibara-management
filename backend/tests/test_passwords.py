"""The real Identity Toolkit client (the rest of the suite uses a fake)."""
import httpx
import pytest

from cibara_api.security import passwords



class _Resp:
    def __init__(self, status, body):
        self.status_code = status
        self._b = body

    def json(self):
        return self._b


@pytest.fixture
def verify():
    from tests.conftest import REAL_VERIFY
    return REAL_VERIFY


def test_success_returns_uid(verify, monkeypatch):
    seen = {}

    def fake_post(url, params=None, json=None, headers=None, timeout=None):
        seen.update(url=url, params=params, json=json, headers=headers)
        return _Resp(200, {"localId": "UID123", "idToken": "x"})
    monkeypatch.setattr(httpx, "post", fake_post)
    assert verify("Neeraj", "pw123456").auth_uid == "UID123"
    assert seen["url"].endswith("/accounts:signInWithPassword")
    assert seen["json"]["email"] == "neeraj@cibara.internal"
    assert seen["params"]["key"]  # the active env's web API key


@pytest.mark.parametrize("code,status", [("INVALID_LOGIN_CREDENTIALS", 401), ("USER_DISABLED", 403),
                                         ("TOO_MANY_ATTEMPTS_TRY_LATER : Access disabled", 429), ("WEIRD", 401)])
def test_error_mapping(verify, monkeypatch, code, status):
    monkeypatch.setattr(httpx, "post", lambda *a, **k: _Resp(400, {"error": {"message": code}}))
    with pytest.raises(passwords.PasswordCheckError) as e:
        verify("neeraj", "pw123456")
    assert e.value.status == status


def test_network_error(verify, monkeypatch):
    def boom(*a, **k):
        raise httpx.ConnectError("down")
    monkeypatch.setattr(httpx, "post", boom)
    with pytest.raises(passwords.PasswordCheckError) as e:
        verify("neeraj", "pw123456")
    assert e.value.status == 503


def test_referer_header_when_configured(verify, monkeypatch):
    from cibara_api.settings import get_settings
    monkeypatch.setattr(get_settings(), "PUBLIC_ORIGIN", "https://erp.example.com")
    seen = {}

    def fake_post(url, params=None, json=None, headers=None, timeout=None):
        seen.update(headers)
        return _Resp(200, {"localId": "U"})
    monkeypatch.setattr(httpx, "post", fake_post)
    verify("a1", "pw123456")
    assert seen["Referer"] == "https://erp.example.com/"
