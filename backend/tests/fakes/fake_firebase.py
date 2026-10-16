"""
Fakes for firebase_admin.storage (bucket/blob) and firebase_admin.auth.

install() patches the REAL firebase_admin modules in place (keeping their
exception classes, which legacy code catches by name) so that importing the
legacy config.py builds the app against in-memory backends.
"""
from __future__ import annotations

import base64
import json
import time
import uuid

from . import fake_firestore as ff


# ─── storage ───────────────────────────────────────────────────────────────

class FakeBlob:
    def __init__(self, bucket, name):
        self.bucket = bucket
        self.name = name
        self.metadata = None
        self.content_type = None
        self.content_disposition = None
        self.cache_control = None
        self.size = None

    @property
    def _stored(self):
        return self.bucket._objects.get(self.name)

    def upload_from_string(self, data, content_type=None, **_kw):
        if isinstance(data, str):
            data = data.encode()
        self.content_type = content_type or self.content_type
        self.size = len(data)
        self.bucket._objects[self.name] = {
            "data": bytes(data), "metadata": dict(self.metadata or {}),
            "content_type": self.content_type,
        }

    def upload_from_file(self, fh, content_type=None, **kw):
        self.upload_from_string(fh.read(), content_type=content_type)

    def download_as_bytes(self, **_kw):
        if self._stored is None:
            from google.api_core import exceptions as gexc
            raise gexc.NotFound(self.name)
        return self._stored["data"]

    def exists(self, **_kw):
        return self._stored is not None

    def reload(self, **_kw):
        if self._stored is None:
            from google.api_core import exceptions as gexc
            raise gexc.NotFound(self.name)
        self.metadata = dict(self._stored.get("metadata") or {})
        self.content_type = self._stored.get("content_type")
        self.size = len(self._stored["data"])

    def patch(self, **_kw):
        if self._stored is not None:
            self._stored["metadata"] = dict(self.metadata or {})

    def make_public(self, **_kw):
        return None

    @property
    def public_url(self):
        return f"https://storage.fake/{self.bucket.name}/{self.name}"

    def generate_signed_url(self, *a, **kw):
        return f"https://storage.fake/signed/{self.bucket.name}/{self.name}"

    def delete(self, **_kw):
        self.bucket._objects.pop(self.name, None)


class FakeBucket:
    def __init__(self, name="cibara-dev.firebasestorage.app"):
        self.name = name
        self._objects: dict[str, dict] = {}

    def blob(self, name, **_kw):
        return FakeBlob(self, name)

    def get_blob(self, name, **_kw):
        if name not in self._objects:
            return None
        b = FakeBlob(self, name)
        b.reload()
        return b

    def copy_blob(self, blob, destination_bucket, new_name=None, **_kw):
        src = self._objects.get(blob.name)
        if src is not None:
            destination_bucket._objects[new_name or blob.name] = dict(src)
        return FakeBlob(destination_bucket, new_name or blob.name)

    def list_blobs(self, prefix="", **_kw):
        return [self.get_blob(n) for n in sorted(self._objects) if n.startswith(prefix)]


# ─── auth ──────────────────────────────────────────────────────────────────

class _UserRecord:
    def __init__(self, uid, email, password, display_name=None, disabled=False):
        self.uid = uid
        self.email = email
        self.display_name = display_name
        self.disabled = disabled
        self.custom_claims = None
        self.tokens_valid_after_timestamp = int(time.time() * 1000) - 1000
        self._password = password


class FakeAuth:
    def __init__(self):
        self.users: dict[str, _UserRecord] = {}

    def reset(self):
        self.users.clear()

    # helpers for tests / the password-verifier fake
    def check_password(self, email: str, password: str):
        for u in self.users.values():
            if u.email == email:
                if u.disabled:
                    return "USER_DISABLED", None
                if u._password != password:
                    return "INVALID_LOGIN_CREDENTIALS", None
                return None, u.uid
        return "INVALID_LOGIN_CREDENTIALS", None

    # firebase_admin.auth surface
    def create_user(self, *, email=None, password=None, display_name=None, disabled=False, uid=None, **_kw):
        from firebase_admin import auth as real
        for u in self.users.values():
            if u.email == email:
                raise real.EmailAlreadyExistsError("email exists", None, None)
        uid = uid or uuid.uuid4().hex[:28]
        rec = _UserRecord(uid, email, password, display_name, disabled)
        self.users[uid] = rec
        return rec

    def get_user(self, uid, **_kw):
        from firebase_admin import auth as real
        if uid not in self.users:
            raise real.UserNotFoundError(f"no user {uid}")
        return self.users[uid]

    def get_user_by_email(self, email, **_kw):
        from firebase_admin import auth as real
        for u in self.users.values():
            if u.email == email:
                return u
        raise real.UserNotFoundError(f"no user {email}")

    def update_user(self, uid, **kw):
        u = self.get_user(uid)
        if "password" in kw and kw["password"] is not None:
            u._password = kw["password"]
        if "display_name" in kw:
            u.display_name = kw["display_name"]
        if "disabled" in kw and kw["disabled"] is not None:
            u.disabled = bool(kw["disabled"])
        return u

    def set_custom_user_claims(self, uid, custom_claims, **_kw):
        self.get_user(uid).custom_claims = dict(custom_claims or {})

    def revoke_refresh_tokens(self, uid, **_kw):
        # Firebase stores this with second precision.
        self.get_user(uid).tokens_valid_after_timestamp = int(time.time()) * 1000

    def create_custom_token(self, uid, developer_claims=None, **_kw):
        payload = {"uid": uid, "claims": developer_claims or {}}
        return b"fake-custom." + base64.urlsafe_b64encode(json.dumps(payload).encode())

    def delete_user(self, uid, **_kw):
        self.users.pop(uid, None)

    def verify_id_token(self, token, check_revoked=False, **_kw):
        # Legacy Firebase ID tokens in tests: "fbid:<uid>"
        from firebase_admin import auth as real
        if not token or not token.startswith("fbid:"):
            raise real.InvalidIdTokenError("bad token", None, None)
        uid = token[5:]
        u = self.get_user(uid)
        claims = dict(u.custom_claims or {})
        claims.update({"uid": uid, "email": u.email})
        return claims


FAKE_DB = ff.FakeClient()
FAKE_BUCKET = FakeBucket()
FAKE_AUTH = FakeAuth()


def install():
    """Patch the real firebase_admin package so config.py initialises against fakes."""
    import firebase_admin
    from firebase_admin import auth, credentials, firestore, storage

    class _Cred(credentials.Base):
        def get_credential(self):
            return None

    credentials.Certificate = lambda *_a, **_kw: _Cred()
    firebase_admin.initialize_app = lambda *a, **kw: object()
    firebase_admin.get_app = lambda *a, **kw: object()
    firestore.client = lambda *a, **kw: FAKE_DB
    firestore.transactional = ff.transactional
    import google.cloud.firestore as gcf
    gcf.transactional = ff.transactional
    storage.bucket = lambda *a, **kw: FAKE_BUCKET
    for name in ("create_user", "get_user", "get_user_by_email", "update_user",
                 "set_custom_user_claims", "revoke_refresh_tokens", "create_custom_token",
                 "delete_user", "verify_id_token"):
        setattr(auth, name, getattr(FAKE_AUTH, name))
