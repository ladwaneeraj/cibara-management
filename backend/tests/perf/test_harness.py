"""Performance-baseline infrastructure tests.

Guard test: the in-memory fake Firestore (tests/fakes/fake_firestore.py) must
feed per-request read/write counts with the SAME billing semantics the real
GAPIC client is instrumented with in cibara_api/core/metrics.py, so that local
performance baselines are trustworthy. The baseline harness also relies on the
ground-truth `_Store.read_count` / `write_count` totals, which must agree.

Semantics locked here (mirror metrics.py):
  • run_query / stream        → 1 read per document returned, 1 for an empty result
  • batch_get / get_all       → 1 read per document
  • single document .get()    → 1 read (present or missing)
  • run_aggregation_query     → 0 document reads (count())
  • commit                    → 1 write per mutation
"""
from cibara_api.core import metrics
from tests.fakes import fake_firestore as FF
from tests.perf.harness import Screen, run_baseline


def test_fake_counting_matches_gapic_semantics():
    db = FF.FakeClient()
    col = db.collection("widgets")
    for i, k in enumerate(("a", "b", "c")):
        col.document(k).set({"n": i})  # seeding happens before the counter starts

    store = db._store
    counter, token = metrics.start()
    try:
        r0 = store.read_count

        # stream of 3 docs -> 3 reads
        assert len(list(col.stream())) == 3
        assert counter.reads == 3
        assert store.read_count - r0 == 3

        # existing single-doc get -> +1
        col.document("a").get()
        assert counter.reads == 4

        # missing single-doc get -> +1 (Firestore bills the lookup)
        col.document("zzz").get()
        assert counter.reads == 5

        # empty query -> +1 (one read billed for an empty result)
        assert list(col.where("n", "==", 999).stream()) == []
        assert counter.reads == 6

        # get_all of 2 refs -> +2 (one read per document)
        assert len(list(db.get_all([col.document("a"), col.document("b")]))) == 2
        assert counter.reads == 8

        # count() aggregation -> +0 document reads (matches run_aggregation_query)
        before, before_store = counter.reads, store.read_count
        agg = db.collection("widgets").count().get()
        assert agg[0][0].value == 3
        assert counter.reads == before, "aggregation count() must not add document reads"
        assert store.read_count == before_store, "aggregation must not bump ground-truth reads"

        # commit of a 2-op batch -> +2 writes
        w0 = counter.writes
        batch = db.batch()
        batch.set(col.document("d"), {"n": 4})
        batch.set(col.document("e"), {"n": 5})
        batch.commit()
        assert counter.writes - w0 == 2
    finally:
        metrics.stop(token)


def test_harness_reports_reads(client, admin):
    """The baseline harness drives a classic-screen endpoint and reports the
    ground-truth Firestore read count plus a latency sample."""
    screens = [Screen(name="front_desk", method="GET", path="/get_data",
                      params={"fresh": "1"})]
    rows = run_baseline(client, admin, screens, repeats=30)
    assert len(rows) == 1
    row = rows[0]
    assert row.n == 30
    assert row.reads >= 1  # /get_data reads at least the rooms collection
