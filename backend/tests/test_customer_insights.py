"""
CRM insights aggregate (services.customer_service.get_customer_insights) and
the cohort drill-down (get_customer_segment) that powers the Customer Records
"Insights" panel — exercised directly against the in-memory Firestore fake.

Covers headline KPIs, RFM-style segments, the Pareto revenue share, the
acquisition-trend window, and that each clickable cohort returns exactly the
guests behind it.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from tests.conftest import DB
from services import customer_service


def _iso(days_ago: int) -> str:
    return (datetime.now(timezone.utc).date() - timedelta(days=days_ago)).isoformat()


# Six guests chosen to land one in (almost) every tier / band.
#   mobile, name, stays, spent, last_ago, first_ago, extra
_SEED = [
    ("9000000001", "Vip Raj",   12, 60000,   0, 400, {}),
    ("9000000002", "Reg Guest",  4,  8000, 100, 200, {}),
    ("9000000003", "Dorm Ant",   2,  3000, 250, 300,
     {"has_pending_settlement": True, "pending_settlement_amount": 500}),
    ("9000000004", "Lost Soul",  1,   500, 500, 500, {"is_flagged": True}),
    ("9000000005", "New Bie",    1,  1200,   5,   5,
     {"gst_profile": {"gstin": "29ABCDE1234F1Z5"}}),
    ("9000000006", "Zero Zero",  0,     0, None, 10, {"wants_bill": True}),
]


def _seed():
    customer_service.init(DB)
    # Start from a clean customers collection regardless of other tests' seeds.
    for p in [p for p in list(DB._store.docs) if p.startswith("customers/")]:
        del DB._store.docs[p]
    for mobile, name, stays, spent, last_ago, first_ago, extra in _SEED:
        doc = {
            "mobile": mobile, "name": name,
            "total_stays": stays, "total_spent": spent,
            "first_visit": _iso(first_ago),
            "last_stay_date": "" if last_ago is None else _iso(last_ago),
        }
        doc.update(extra)
        DB.collection("customers").document(mobile).set(doc)
    # force=True rebuilds both the insights and the cohort caches from the seed.
    return customer_service.get_customer_insights(force=True)


def test_insights_kpis():
    agg = _seed()
    k = agg["kpis"]
    assert k["total_customers"] == 6
    assert k["repeat_customers"] == 3          # stays > 1: c1, c2, c3
    assert k["repeat_rate_pct"] == 50
    assert k["total_revenue"] == 72700
    assert k["avg_spend"] == 12117             # round(72700 / 6)
    assert k["avg_stays"] == 3.3               # round(20 / 6, 1)
    assert k["active_90d"] == 2                # last stay within 90d: c1, c5
    assert k["new_30d"] == 2                   # first visit within 30d: c5, c6
    assert k["flagged"] == 1
    assert k["gst_customers"] == 1
    assert k["wants_bill"] == 1
    assert k["dues_count"] == 1
    assert k["dues_total"] == 500
    # Pareto: the single biggest spender (60000) is 83% of 72700.
    assert k["top10_revenue_share_pct"] == 83


def test_insights_segments_sum_to_base():
    agg = _seed()
    seg = agg["segments"]
    total = agg["kpis"]["total_customers"]
    for dim in ("loyalty", "value", "recency"):
        assert sum(b["count"] for b in seg[dim]) == total, dim

    by_label = lambda rows: {b["label"]: b["count"] for b in rows}
    loy = by_label(seg["loyalty"])
    assert loy["VIP"] == 1 and loy["Regular"] == 1 and loy["Returning"] == 1 and loy["One-time"] == 3
    rec = {b["label"]: b["count"] for b in seg["recency"]}
    # Active=2, Cooling=1, Dormant=1, Lost=2 (c6 has no last stay → Lost).
    assert list(rec.values()) == [2, 1, 1, 2]


def test_acquisition_trend_window():
    agg = _seed()
    trend = agg["acquisition_trend"]
    assert len(trend) == 12
    # Only guests whose first visit is inside the last 12 months are counted,
    # so the two with 400d/500d-old first visits drop out: 4 of 6 remain.
    assert sum(t["count"] for t in trend) == 4


def test_top_lists_ordered():
    agg = _seed()
    assert agg["top_by_spend"][0]["mobile"] == "9000000001"
    assert agg["top_by_spend"][0]["total_spent"] == 60000
    assert agg["top_by_stays"][0]["mobile"] == "9000000001"
    # Slim rows carry exactly what the list renders.
    row = agg["top_by_spend"][0]
    assert set(row) >= {"name", "mobile", "total_stays", "total_spent", "last_stay_date", "is_flagged"}


def test_segment_drilldown_recency():
    _seed()
    dormant = customer_service.get_customer_segment("recency", "2")   # Dormant band
    assert dormant["count"] == 1 and dormant["customers"][0]["mobile"] == "9000000003"
    lost = customer_service.get_customer_segment("recency", "3")      # Lost band
    assert sorted(c["mobile"] for c in lost["customers"]) == ["9000000004", "9000000006"]


def test_segment_drilldown_flat_cohorts():
    _seed()
    dues = customer_service.get_customer_segment("dues")
    assert dues["count"] == 1 and dues["customers"][0]["mobile"] == "9000000003"

    lapsed = customer_service.get_customer_segment("lapsed")          # dormant + lost
    assert lapsed["count"] == 3
    assert lapsed["customers"][0]["mobile"] == "9000000003"           # sorted by spend desc

    vip_value = customer_service.get_customer_segment("value", "5")   # ₹50k+ tier
    assert vip_value["count"] == 1 and vip_value["customers"][0]["mobile"] == "9000000001"


def test_segment_unknown_dimension_is_empty():
    _seed()
    assert customer_service.get_customer_segment("nonsense")["count"] == 0
    assert customer_service.get_customer_segment("recency", "99")["count"] == 0


def test_empty_collection_is_safe():
    customer_service.init(DB)
    for p in [p for p in list(DB._store.docs) if p.startswith("customers/")]:
        del DB._store.docs[p]
    agg = customer_service.get_customer_insights(force=True)
    assert agg["kpis"]["total_customers"] == 0
    assert agg["kpis"]["avg_spend"] == 0
    assert customer_service.get_customer_segment("dues")["count"] == 0
