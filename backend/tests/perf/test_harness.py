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


def test_get_data_reads_counted_across_threads(client, admin):
    """/get_data fetches rooms/totals/payments/expenses in a ThreadPoolExecutor.
    The per-request counter (and thus the X-Firestore-Reads header) must see
    those reads — i.e. equal the fake's thread-complete ground-truth total —
    otherwise production read monitoring is blind to the busiest screen."""
    from tests.fakes import fake_firebase as F
    store = F.FAKE_DB._store
    r0 = store.read_count
    resp = client.get("/get_data", params={"fresh": "1"}, headers=admin)
    assert resp.status_code == 200, resp.text
    ground_truth = store.read_count - r0
    header = int(resp.headers.get("X-Firestore-Reads", "-1"))
    assert ground_truth >= 10, f"expected a real rooms scan, got {ground_truth}"
    assert header == ground_truth, f"header {header} != ground-truth {ground_truth} reads"


def _reads(resp) -> int:
    return int(resp.headers.get("X-Firestore-Reads", "-1"))


def test_tariffs_cache_survives_room_cache_invalidation(client, admin):
    """With the flag on, /rooms/tariffs must keep serving without a rooms
    re-scan even after a checkin/payment invalidates the shared 30s rooms
    cache — tariffs only needs the static room list + pure pricing."""
    import config
    from cibara_api.settings import get_settings
    from cibara_api.routers import rooms as rr

    s = get_settings()
    old = s.PERF_TARIFFS_CACHE
    s.PERF_TARIFFS_CACHE = True
    rr._clear_tariffs_cache()
    try:
        r1 = client.get("/api/v2/rooms/tariffs", headers=admin)
        assert r1.status_code == 200, r1.text
        config.invalidate_cache()  # simulate a checkin/payment write
        r2 = client.get("/api/v2/rooms/tariffs", headers=admin)
        assert r2.status_code == 200, r2.text
        assert _reads(r2) == 0, "cached tariffs must not re-scan rooms"
        assert r2.json()["tariffs"] == r1.json()["tariffs"], "cached payload must match"
    finally:
        s.PERF_TARIFFS_CACHE = old
        rr._clear_tariffs_cache()


def test_tariffs_flag_off_rescans_after_invalidation(client, admin):
    """Control: with the flag off, the same sequence re-scans rooms, proving
    the cache (not some other layer) is what removes the reads."""
    import config
    from cibara_api.settings import get_settings
    from cibara_api.routers import rooms as rr

    s = get_settings()
    old = s.PERF_TARIFFS_CACHE
    s.PERF_TARIFFS_CACHE = False
    rr._clear_tariffs_cache()
    try:
        client.get("/api/v2/rooms/tariffs", headers=admin)  # warm config cache
        config.invalidate_cache()
        r2 = client.get("/api/v2/rooms/tariffs", headers=admin)
        assert r2.status_code == 200, r2.text
        assert _reads(r2) >= 1, "flag off must re-scan rooms after invalidation"
    finally:
        s.PERF_TARIFFS_CACHE = old
        rr._clear_tariffs_cache()


def test_get_room_numbers_light_avoids_full_scan(client, admin):
    """/get_room_numbers only needs room IDs, but streamed every full room doc
    (~47 reads). With PERF_ROOM_NUMBERS_LIGHT on it must use list_documents()
    (no per-doc reads) and return the identical room list."""
    import os
    from tests.fakes import fake_firebase as F
    store = F.FAKE_DB._store

    prev = os.environ.get("PERF_ROOM_NUMBERS_LIGHT")
    try:
        os.environ["PERF_ROOM_NUMBERS_LIGHT"] = "0"  # legacy full stream
        r0 = store.read_count
        off = client.get("/get_room_numbers", headers=admin)
        reads_off = store.read_count - r0

        os.environ["PERF_ROOM_NUMBERS_LIGHT"] = "1"  # light path
        r1 = store.read_count
        on = client.get("/get_room_numbers", headers=admin)
        reads_on = store.read_count - r1

        assert off.status_code == 200 and on.status_code == 200
        assert reads_off >= 10, f"legacy path should scan all rooms, got {reads_off}"
        assert reads_on == 0, f"light path should read no documents, got {reads_on}"
        assert on.json()["rooms"] == off.json()["rooms"], "room list must be identical"
        assert on.json()["first_floor"] == off.json()["first_floor"]
        assert on.json()["second_floor"] == off.json()["second_floor"]
    finally:
        if prev is None:
            os.environ.pop("PERF_ROOM_NUMBERS_LIGHT", None)
        else:
            os.environ["PERF_ROOM_NUMBERS_LIGHT"] = prev


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
