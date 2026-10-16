"""
Regression test for the Register "ID on file" icon not appearing even though
the guest's document was uploaded (reported issue).

Root cause: /batch_check_customer_docs used the register row's raw
`guest_mobile` straight as the Firestore document id. Customer documents are
keyed by the CLEANED 10-digit mobile (services.customer_service._clean_mobile),
and every other lookup in the app cleans first. Check-in stores guest.mobile
raw (routes/rooms.py), so a number entered with a +91 / space / leading 0 was
looked up under a key that does not exist — the document was on file but the
icon stayed "missing".

The fix clusters the incoming mobiles by their cleaned key for the lookup, and
answers with the ORIGINAL strings the client sent (the Register caches per-row
doc status by the raw guest_mobile, so a cleaned key would never match).

RUN:  python -m pytest tests/test_batch_check_customer_docs.py -q
"""
from __future__ import annotations

from routes.customers import _group_mobiles_by_clean


def test_formatted_numbers_clean_to_the_same_storage_key():
    # The exact failing case: the register sends a formatted number while the
    # customer doc is keyed by the bare 10 digits.
    clean_keys, clean_to_raws = _group_mobiles_by_clean(["+91 98765 43210"])
    assert clean_keys == ["9876543210"]
    # And the response must echo the ORIGINAL string so the Register's cache,
    # keyed by the raw guest_mobile, matches.
    assert clean_to_raws["9876543210"] == ["+91 98765 43210"]


def test_variants_group_under_one_lookup_key():
    raws = ["9876543210", "+919876543210", "098765 43210", "91 98765-43210"]
    clean_keys, clean_to_raws = _group_mobiles_by_clean(raws)
    # One Firestore lookup, not four.
    assert clean_keys == ["9876543210"]
    # Every original spelling is remembered so each can be echoed back.
    assert clean_to_raws["9876543210"] == raws


def test_already_clean_numbers_pass_through_unchanged():
    clean_keys, clean_to_raws = _group_mobiles_by_clean(["9876543210", "9123456780"])
    assert sorted(clean_keys) == ["9123456780", "9876543210"]
    assert clean_to_raws["9876543210"] == ["9876543210"]
    assert clean_to_raws["9123456780"] == ["9123456780"]


def test_invalid_numbers_are_dropped():
    clean_keys, clean_to_raws = _group_mobiles_by_clean(["", "   ", "12345", "abcdefghij"])
    assert clean_keys == []
    assert clean_to_raws == {}


def test_distinct_guests_stay_separate():
    clean_keys, clean_to_raws = _group_mobiles_by_clean(["+91 98765 43210", "9123456780"])
    assert sorted(clean_keys) == ["9123456780", "9876543210"]
    assert clean_to_raws["9876543210"] == ["+91 98765 43210"]
    assert clean_to_raws["9123456780"] == ["9123456780"]
