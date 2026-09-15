"""
One complete set of Firebase stubs, installed before any test module imports.

THE PROBLEM THIS SOLVES
───────────────────────
Thirteen test modules each install their own `firebase_admin` stub, and they
disagree about how much of it to build. Seven install unconditionally; six
guard with `if "firebase_admin" not in sys.modules`. sys.modules is global and
pytest runs the whole suite in one process, so the FIRST module to be imported
decided what every later module got.

That made results depend on collection order. Alphabetical order happened to
work; three out of five shuffled orders failed with

    AttributeError: module 'firebase_admin.credentials' has no attribute
    'Certificate'

because a module with a minimal stub ran first and a module that imports
config.py ran after it. The same mechanism made
test_expense_marketing_permission.py pass in a full run and fail on its own:
it was relying on a stub some earlier file happened to leave behind.

WHAT THIS DOES
──────────────
Installs the union of what every module needs, before collection, and tops it
up again before each module is collected — because a module that installs its
stub unconditionally replaces the object we put there, and the next module
along would otherwise inherit whatever that one chose to build.

It only ever fills in what is MISSING. A module that wants its own Increment,
FieldFilter or ArrayUnion still gets it: this never overwrites an attribute
that is already present. Nothing here changes what any test asserts.
"""
from __future__ import annotations

import os
import sys
import types

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(_HERE)

if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

# Firebase is never reached, so the credentials only have to exist and parse.
# tests/_stub_credentials.json is in the repo for exactly this; pointing at it
# means the suite runs on a machine that has no real service-account key.
os.environ.setdefault("CIBARA_ENV", "UAT")
os.environ.setdefault("FIREBASE_KEY_FILE",
                      os.path.join(_HERE, "_stub_credentials.json"))


class _StubFieldFilter:
    def __init__(self, *args, **kwargs):
        self.args = args


class _StubSnapshot:
    exists = False

    def to_dict(self):
        return {}

    def get(self, _key, **_kw):
        return None


class _StubCollection:
    parent = None

    def document(self, *_a, **_kw):
        return self

    def get(self, *_a, **_kw):
        return _StubSnapshot()

    def set(self, *_a, **_kw):
        return None

    def update(self, *_a, **_kw):
        return None

    def stream(self, *_a, **_kw):
        return iter(())

    def where(self, *_a, **_kw):
        return self

    def limit(self, *_a, **_kw):
        return self

    def order_by(self, *_a, **_kw):
        return self


class _StubBatch:
    def set(self, *_a, **_kw):
        return None

    def update(self, *_a, **_kw):
        return None

    def delete(self, *_a, **_kw):
        return None

    def commit(self, *_a, **_kw):
        return None


class _StubClient:
    def collection(self, _name):
        return _StubCollection()

    def transaction(self):
        return None

    def batch(self):
        return _StubBatch()


def _module(name):
    """The module at `name`, created and registered if it is not there."""
    mod = sys.modules.get(name)
    if mod is None:
        mod = types.ModuleType(name)
        sys.modules[name] = mod
    return mod


def _fill(mod, **attrs):
    """Set only the attributes the module does not already have."""
    for key, value in attrs.items():
        if not hasattr(mod, key):
            setattr(mod, key, value)


def _ensure_stubs():
    fa = _module("firebase_admin")
    for sub in ("credentials", "firestore", "storage", "auth"):
        child = _module("firebase_admin.%s" % sub)
        if not hasattr(fa, sub):
            setattr(fa, sub, child)
        # A module that built its own firebase_admin may have attached a
        # child object without registering it, or the other way round. Keep
        # the two views pointing at the same thing.
        sys.modules["firebase_admin.%s" % sub] = getattr(fa, sub)

    _fill(fa, initialize_app=lambda *a, **kw: None,
          get_app=lambda *a, **kw: None)
    _fill(fa.credentials, Certificate=lambda *a, **kw: None,
          ApplicationDefault=lambda *a, **kw: None)
    _fill(fa.auth, verify_id_token=lambda *a, **kw: {})
    _fill(fa.storage,
          bucket=lambda *a, **kw: types.SimpleNamespace(
              name="stub", blob=lambda _p: None))
    # These defaults deliberately copy what the test modules already write
    # for themselves — Increment and ArrayUnion are the identity, so an
    # assertion reads the plain value. A richer stand-in here would be
    # invisible most of the time and wrong occasionally: a module that
    # imports routes.billing before some other module installs ITS stub
    # keeps whatever object was in place at import, and test_bill_cancel,
    # which asserts Increment(-500) == -500, would fail depending on order.
    # Matching the convention means it does not matter which object wins.
    _fill(fa.firestore,
          client=_StubClient,
          transactional=lambda fn: fn,
          SERVER_TIMESTAMP="STUB",
          Increment=lambda value: value,
          ArrayUnion=lambda values: values,
          ArrayRemove=lambda values: values,
          FieldFilter=_StubFieldFilter,
          DELETE_FIELD="STUB_DELETE")

    _module("google")
    _module("google.cloud")
    _module("google.cloud.firestore_v1")
    _fill(_module("google.cloud.firestore_v1.base_query"),
          FieldFilter=_StubFieldFilter)


# The app uses PEP 604 annotations (`dict | None`) in modules that do not
# carry `from __future__ import annotations`, so importing it at all needs
# Python 3.10. Running the suite on an older interpreter produces a wall of
# unrelated-looking import errors; this turns that into one sentence naming
# the actual problem. The usual cause is a `pytest` shim earlier on PATH than
# the active virtualenv — `python -m pytest` uses the interpreter you meant.
MIN_PYTHON = (3, 10)


def pytest_configure(config):          # before anything is collected
    if sys.version_info < MIN_PYTHON:
        pytest.exit(
            "This suite needs Python %d.%d or newer; it is running on %d.%d.%d "
            "(%s).\n"
            "If your virtualenv is newer than that, `pytest` is resolving to a "
            "different interpreter — run `python -m pytest tests/` instead."
            % (MIN_PYTHON[0], MIN_PYTHON[1], sys.version_info[0],
               sys.version_info[1], sys.version_info[2], sys.executable),
            returncode=1,
        )
    _ensure_stubs()


@pytest.hookimpl(tryfirst=True)
def pytest_collectstart(collector):    # before each module is imported
    _ensure_stubs()
