"""
Route wiring for routes/analytics.py — GET /analytics/overview (and, below,
the nightly snapshot ingest). The Firestore fetchers are replaced with seeded
fakes; what is under test is permission gating, window validation, caching,
the projections, and that the response carries aggregates only.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(_HERE)
for _p in (_REPO, _HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from flask import Flask  # noqa: E402

import config  # noqa: E402
from routes import analytics as an  # noqa: E402
from services import auth_service  # noqa: E402

IST = config.IST


def _today():
    return datetime.now(IST).date()


def _d(offset: int) -> str:
    return (_today() + timedelta(days=offset)).isoformat()


ADMIN = {"userId": "admin", "name": "Admin", "role": "admin"}
MANAGER = {"userId": "mgr", "name": "Mgr", "role": "manager"}


@pytest.fixture
def app_client(monkeypatch):
    app = Flask(__name__)
    app.register_blueprint(an.analytics_bp)
    an._CACHE.clear()

    state = {"user": ADMIN, "calls": {"bills": 0}}
    monkeypatch.setattr(auth_service, "load_current_user", lambda: state["user"])

    rooms = {
        "101": {"status": "occupied", "active_bill_id": "s1",
                "checkin_time": f"{_d(-1)} 12:00", "room_price_per_night": 1000},
        "102": {"status": "vacant"},
    }

    def fake_bills(*_a, **_k):
        state["calls"]["bills"] += 1
        return [{"id": "b1", "status": "completed", "room": "102",
                 "checkin_time": f"{_d(-5)} 12:00", "checkout_time": f"{_d(-3)} 10:00",
                 "room_charges_total": 3000, "booking_source": "normal",
                 "payment_source": "hotel"}]

    monkeypatch.setattr(an, "get_all_rooms", lambda: rooms)
    monkeypatch.setattr(an, "_fetch_bills", fake_bills)
    monkeypatch.setattr(an, "_fetch_payments", lambda *a, **k: [
        {"method": "cash", "type": "checkin", "amount": 1500, "date": _d(-1)}])
    monkeypatch.setattr(an, "_fetch_bookings", lambda *a, **k: [
        {"check_in_date": _d(2), "check_out_date": _d(4), "status": "confirmed",
         "room": "102", "total_amount": 2000, "booking_date": _d(-3)}])
    monkeypatch.setattr(an, "_fetch_commission_expenses", lambda *a, **k: [])
    monkeypatch.setattr(an, "_fetch_snapshots", lambda *a, **k: [])
    return app.test_client(), state


def _get(c, frm=None, to=None, **extra):
    q = {"from": frm or _d(-6), "to": to or _d(0), **extra}
    return c.get("/analytics/overview", query_string=q)


def test_overview_ok_and_shape(app_client):
    c, _ = app_client
    r = _get(c)
    assert r.status_code == 200
    body = r.get_json()
    assert body["success"] is True
    for k in ("window", "overview", "channel_mix", "pace", "seasonality",
              "los_leadtime", "findings", "generated_at"):
        assert k in body
    assert body["overview"]["occupancy"]["room_count"] == 2
    assert body["overview"]["collections"]["cash"] == 1500
    assert body["pace"]["horizons"]["7"]["occupied_room_nights"] >= 2


def test_overview_has_no_raw_bill_or_payment_arrays(app_client):
    c, _ = app_client
    body = _get(c).get_json()
    assert not ({"bills", "payments", "stays", "bookings", "rooms"} & set(body))
    blob = json.dumps(body)
    for raw in ('"b1"', '"s1"', '"stay_id"', '"checkin_time"', '"room_charges_total"'):
        assert raw not in blob
    assert len(blob) < 20_000        # aggregates only: stays small


def test_overview_requires_login_and_analytics_permission(app_client):
    c, state = app_client
    state["user"] = None
    assert _get(c).status_code == 401
    state["user"] = MANAGER
    assert _get(c).status_code == 403
    state["user"] = ADMIN
    assert _get(c).status_code == 200


@pytest.mark.parametrize("params,code", [
    ({"from": "nope", "to": "2026-10-01"}, 400),
    ({"from": "2026-10-02", "to": "2026-10-01"}, 400),
    ({"from": "2025-01-01", "to": "2026-10-01"}, 400),      # > max window
    ({}, 400),
])
def test_overview_validates_window(app_client, params, code):
    c, _ = app_client
    assert c.get("/analytics/overview", query_string=params).status_code == code


def test_overview_caches_per_window_and_fresh_bypasses(app_client):
    c, state = app_client
    _get(c)
    _get(c)
    assert state["calls"]["bills"] == 1
    _get(c, fresh="1")
    assert state["calls"]["bills"] == 2
    _get(c, frm=_d(-3))                      # a different window is a different key
    assert state["calls"]["bills"] == 3


def test_overview_future_to_is_capped_at_today(app_client):
    c, _ = app_client
    body = _get(c, to=_d(10)).get_json()
    assert body["window"]["to"] == _d(0)


def test_overview_fetch_failure_is_a_clean_500(app_client, monkeypatch):
    c, _ = app_client

    def boom(*_a, **_k):
        raise RuntimeError("firestore down")

    monkeypatch.setattr(an, "_fetch_bills", boom)
    r = _get(c)
    assert r.status_code == 500 and r.get_json()["success"] is False


# ── POST /analytics/snapshot (nightly ingest) ───────────────────────────

class _SnapDocRef:
    def __init__(self, store, id_):
        self.store, self.id = store, id_

    def set(self, data, *a, **k):
        self.store.writes.append((self.id, data))
        self.store.docs[self.id] = data


class _SnapColl:
    def __init__(self):
        self.docs, self.writes = {}, []

    def document(self, id_):
        return _SnapDocRef(self, id_)


@pytest.fixture
def snap_client(app_client, monkeypatch):
    c, state = app_client
    coll = _SnapColl()
    monkeypatch.setattr(an, "snapshots_ref", coll)
    monkeypatch.setenv("ANALYTICS_INGEST_SECRET", "s3cret")
    monkeypatch.delenv("AGODA_INGEST_SECRET", raising=False)
    monkeypatch.delenv("MMT_INGEST_SECRET", raising=False)
    state["user"] = None      # the scheduler carries no JWT
    return c, state, coll


def test_snapshot_with_secret_writes_one_doc_for_today(snap_client):
    c, _, coll = snap_client
    r = c.post("/analytics/snapshot", headers={"X-Ingest-Secret": "s3cret"})
    assert r.status_code == 200 and r.get_json()["success"] is True
    assert len(coll.writes) == 1
    doc_id, doc = coll.writes[0]
    assert doc_id == _today().isoformat() == doc["date"]
    assert set(doc["horizons"]) == {"7", "14", "30"}       # Firestore map keys are strings
    assert set(doc["horizons"]["7"]) == {"occupancy_pct", "on_books_revenue"}
    assert doc["room_count"] == 2
    # in-house 101 (planned out on a linked booking? none) holds tonight + booking +2..+4
    assert doc["horizons"]["7"]["on_books_revenue"] == 1000 + 2000


def test_snapshot_is_idempotent_overwrites_same_date(snap_client):
    c, _, coll = snap_client
    for _ in range(2):
        assert c.post("/analytics/snapshot",
                      headers={"X-Ingest-Secret": "s3cret"}).status_code == 200
    assert len(coll.docs) == 1 and len(coll.writes) == 2


@pytest.mark.parametrize("headers", [{}, {"X-Ingest-Secret": "wrong"}, {"X-Ingest-Secret": ""}])
def test_snapshot_rejects_missing_or_wrong_secret(snap_client, headers):
    c, _, coll = snap_client
    r = c.post("/analytics/snapshot", headers=headers)
    assert r.status_code in (401, 403)
    assert coll.writes == []


def test_snapshot_with_no_secret_configured_needs_a_login(snap_client, monkeypatch):
    c, state, coll = snap_client
    monkeypatch.delenv("ANALYTICS_INGEST_SECRET")
    assert c.post("/analytics/snapshot",
                  headers={"X-Ingest-Secret": "anything"}).status_code in (401, 403)
    assert coll.writes == []
    state["user"] = ADMIN                      # an admin may trigger it by hand
    assert c.post("/analytics/snapshot").status_code == 200
    assert len(coll.writes) == 1


def test_snapshot_manager_is_forbidden(snap_client):
    c, state, coll = snap_client
    state["user"] = MANAGER
    assert c.post("/analytics/snapshot").status_code == 403
    assert coll.writes == []


def test_snapshot_shared_scheduler_secret_fallback(snap_client, monkeypatch):
    c, _, coll = snap_client
    monkeypatch.delenv("ANALYTICS_INGEST_SECRET")
    monkeypatch.setenv("MMT_INGEST_SECRET", "shared")
    assert c.post("/analytics/snapshot",
                  headers={"X-Ingest-Secret": "shared"}).status_code == 200
    assert len(coll.writes) == 1


# ── projections: every Firestore read uses .select() ────────────────────

class _Q:
    """Records the chain a fetcher builds; stream() yields canned docs."""

    def __init__(self, docs=()):
        self.docs, self.selected, self.filters = list(docs), None, []

    def where(self, *a, **k):
        self.filters.append(k.get("filter") or a)
        return self

    def select(self, fields):
        self.selected = list(fields)
        return self

    def limit(self, *_a):
        return self

    def stream(self):
        return iter(self.docs)


class _Doc:
    def __init__(self, id_, data):
        self.id, self._d = id_, data

    def to_dict(self):
        return dict(self._d)


def test_every_fetcher_uses_a_projection(monkeypatch):
    q = _Q([_Doc("b1", {"status": "completed"})])
    monkeypatch.setattr(an, "bills_ref", q)
    monkeypatch.setattr(an, "bookings_ref", q)
    monkeypatch.setattr(an, "expenses_ref", q)
    monkeypatch.setattr(an, "payments_ref", q)
    monkeypatch.setattr(an, "snapshots_ref", q)
    t = _today()
    bills = an._fetch_bills(t - timedelta(days=5), t)
    assert bills[0]["id"] == "b1"                      # doc id folded in
    assert {"checkin_time", "checkout_time", "status", "room_charges_total",
            "room_price_per_night", "payment_source", "booking_source",
            "ota_commission_gst", "cancelled_by_revert",
            "superseded_by_revert"} <= set(q.selected)
    for fetch, args in ((an._fetch_bookings, (t, t)), (an._fetch_payments, (t, t)),
                        (an._fetch_commission_expenses, (t, t)), (an._fetch_snapshots, (t,))):
        q.selected = None
        fetch(*args)
        assert q.selected, f"{fetch.__name__} did not project"
