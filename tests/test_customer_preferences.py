"""
Tests for the sticky guest preferences in services/customer_service.py.

  wants_bill   guest asked for a bill before -> bill them again next time
  gst_profile  guest was invoiced B2B before -> offer the same GST details

customer_service talks to Firestore, so this drives it against a small fake
client that implements only what these functions use: collection(), document(),
get(), set(merge=). The fake reproduces Firestore's merge semantics faithfully,
including the one that actually bites: set(merge=True) merges INTO a nested map
rather than replacing it. That is why remember_gst_profile writes every key of
the profile every time, and there is a test below that fails if it stops.

The writes run on daemon threads, so each test joins them before asserting.

RUN:  pytest tests/test_customer_preferences.py -q
"""

from __future__ import annotations

import sys
import threading
import types

import pytest


# ── Stub firebase_admin before importing the module under test ─────────────
# customer_service does `from firebase_admin import firestore as _fs` purely
# for ArrayUnion/ArrayRemove in the document-upload paths, which these tests
# do not touch.
if "firebase_admin" not in sys.modules:
    _fa = types.ModuleType("firebase_admin")
    _fs = types.ModuleType("firebase_admin.firestore")
    _fs.ArrayUnion = lambda v: ("ArrayUnion", v)
    _fs.ArrayRemove = lambda v: ("ArrayRemove", v)
    _fs.SERVER_TIMESTAMP = "SERVER_TIMESTAMP"
    _fa.firestore = _fs
    sys.modules["firebase_admin"] = _fa
    sys.modules["firebase_admin.firestore"] = _fs

from services import customer_service as cs  # noqa: E402


# ── Minimal Firestore fake ─────────────────────────────────────────────────

def _deep_merge(dst: dict, src: dict) -> dict:
    """Firestore set(merge=True): maps merge key-by-key, scalars replace."""
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            _deep_merge(dst[k], v)
        else:
            dst[k] = v
    return dst


class FakeSnap:
    def __init__(self, data):
        self._data = data
        self.exists = data is not None

    def to_dict(self):
        return dict(self._data) if self._data is not None else None


class FakeDoc:
    def __init__(self, store, doc_id):
        self._store, self.id = store, doc_id

    def get(self):
        if self._store.raise_on_get:
            raise RuntimeError("simulated Firestore outage")
        return FakeSnap(self._store.docs.get(self.id))

    def set(self, patch, merge=False):
        if merge:
            cur = self._store.docs.setdefault(self.id, {})
            _deep_merge(cur, patch)
        else:
            self._store.docs[self.id] = dict(patch)
        self._store.writes.append((self.id, patch, merge))

    def update(self, patch):
        if self.id not in self._store.docs:
            raise KeyError("no such document")
        self._store.docs[self.id].update(patch)


class FakeCollection:
    def __init__(self, store):
        self._store = store

    def document(self, doc_id):
        return FakeDoc(self._store, doc_id)


class FakeDb:
    def __init__(self):
        self.docs, self.writes, self.raise_on_get = {}, [], False

    def collection(self, _name):
        return FakeCollection(self)


def _join_threads():
    """customer_service writes on daemon threads; wait for them."""
    for t in threading.enumerate():
        if t is not threading.current_thread() and t.daemon:
            t.join(timeout=5)


@pytest.fixture
def db():
    d = FakeDb()
    cs.init(d)
    yield d


MOB = "9876543210"
GST = {"gstin": "29AAAAA0000A1Z5", "legal_name": "ACME PVT LTD",
       "trade_name": "Acme", "address": "MG Road, Bengaluru",
       "state": "Karnataka", "state_code": "29"}


# ═══════════════════════════════════════════════════════════════════════════
# wants_bill
# ═══════════════════════════════════════════════════════════════════════════

def test_wants_bill_is_false_for_an_unknown_guest(db):
    assert cs.wants_bill(MOB) is False


def test_print_sets_the_preference_and_wants_bill_reads_it_back(db):
    cs.remember_bill_preference(MOB, source="print", bill_id="b1")
    _join_threads()
    assert cs.wants_bill(MOB) is True
    assert db.docs[MOB]["wants_bill_source"] == "print"


def test_whatsapp_share_sets_it_too(db):
    cs.remember_bill_preference(MOB, source="whatsapp")
    _join_threads()
    assert db.docs[MOB]["wants_bill_source"] == "whatsapp"


def test_since_is_stamped_once_and_never_moves(db):
    cs.remember_bill_preference(MOB, source="print")
    _join_threads()
    first_since = db.docs[MOB]["wants_bill_since"]

    cs.remember_bill_preference(MOB, source="whatsapp")
    _join_threads()
    assert db.docs[MOB]["wants_bill_since"] == first_since      # unchanged
    assert db.docs[MOB]["wants_bill_last_at"] > first_since      # but seen again
    assert db.docs[MOB]["wants_bill_source"] == "whatsapp"


def test_an_unknown_source_falls_back_to_print_rather_than_storing_junk(db):
    cs.remember_bill_preference(MOB, source="carrier-pigeon")
    _join_threads()
    assert db.docs[MOB]["wants_bill_source"] == "print"


@pytest.mark.parametrize("bad", ["", None, "   ", "abc"])
def test_a_missing_or_junk_mobile_writes_nothing(db, bad):
    cs.remember_bill_preference(bad)
    cs.remember_gst_profile(bad, GST)
    _join_threads()
    assert db.writes == []


def test_wants_bill_fails_closed_when_firestore_is_down(db):
    # This runs on the checkout path. A read failure must degrade to the
    # pre-existing behaviour, never raise and block a checkout.
    cs.remember_bill_preference(MOB)
    _join_threads()
    db.raise_on_get = True
    assert cs.wants_bill(MOB) is False


def test_update_customer_can_turn_the_preference_off(db):
    cs.remember_bill_preference(MOB)
    _join_threads()
    assert cs.update_customer(MOB, {"wants_bill": False}) is True
    assert db.docs[MOB]["wants_bill"] is False
    assert cs.wants_bill(MOB) is False


def test_update_customer_coerces_and_still_rejects_other_fields(db):
    cs.remember_bill_preference(MOB)
    _join_threads()
    cs.update_customer(MOB, {"wants_bill": 0, "total_spent": 999999})
    assert db.docs[MOB]["wants_bill"] is False        # coerced to a real bool
    assert db.docs[MOB].get("total_spent") != 999999  # not on the allow-list


# ═══════════════════════════════════════════════════════════════════════════
# gst_profile
# ═══════════════════════════════════════════════════════════════════════════

def test_gst_profile_round_trips(db):
    cs.remember_gst_profile(MOB, GST, bill_id="b7")
    _join_threads()
    p = db.docs[MOB]["gst_profile"]
    assert p["gstin"] == "29AAAAA0000A1Z5"
    assert p["legal_name"] == "ACME PVT LTD"
    assert p["last_bill_id"] == "b7"
    assert p["last_used_at"]


def test_a_profile_with_no_gstin_is_not_stored(db):
    cs.remember_gst_profile(MOB, {"legal_name": "ACME PVT LTD"})
    _join_threads()
    assert db.writes == []


def test_the_gstin_is_upper_cased(db):
    cs.remember_gst_profile(MOB, dict(GST, gstin="29aaaaa0000a1z5"))
    _join_threads()
    assert db.docs[MOB]["gst_profile"]["gstin"] == "29AAAAA0000A1Z5"


def test_a_new_company_does_not_inherit_the_old_ones_address(db):
    # The one that bites. set(merge=True) merges INTO the nested map, so a
    # partial second write would leave the first tenant's address and trade
    # name sitting under the new GSTIN. remember_gst_profile writes every key
    # every time precisely to stop that.
    cs.remember_gst_profile(MOB, GST)
    _join_threads()
    cs.remember_gst_profile(MOB, {"gstin": "27BBBBB1111B2Z6",
                                  "legal_name": "BETA LLP"})
    _join_threads()

    p = db.docs[MOB]["gst_profile"]
    assert p["gstin"] == "27BBBBB1111B2Z6"
    assert p["legal_name"] == "BETA LLP"
    assert p["address"] == ""        # NOT "MG Road, Bengaluru"
    assert p["trade_name"] == ""     # NOT "Acme"


def test_every_documented_key_is_present_even_when_blank(db):
    cs.remember_gst_profile(MOB, {"gstin": "29AAAAA0000A1Z5"})
    _join_threads()
    assert set(db.docs[MOB]["gst_profile"]) == set(cs._GST_PROFILE_KEYS)


def test_forget_clears_the_profile_but_leaves_the_guest(db):
    cs.remember_gst_profile(MOB, GST)
    cs.remember_bill_preference(MOB)
    _join_threads()
    assert cs.forget_gst_profile(MOB) is True
    assert db.docs[MOB]["gst_profile"] is None
    assert db.docs[MOB]["wants_bill"] is True     # unrelated, untouched


def test_the_two_preferences_are_independent(db):
    cs.remember_gst_profile(MOB, GST)
    _join_threads()
    assert db.docs[MOB].get("wants_bill") is None
    assert cs.wants_bill(MOB) is False
