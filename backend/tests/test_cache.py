"""Phase 3 shared cache: the backend interface, the Redis adapter (via
fakeredis), default-off selection, and the rate limiter using a shared backend."""
import fakeredis

from cibara_api.core import cache, ratelimit


def _fake_redis_backend():
    return cache.RedisBackend("", client=fakeredis.FakeStrictRedis(decode_responses=True))


def test_default_is_no_shared_backend():
    # REDIS_URL is unset in the test env → in-process state.
    cache.reset_backend_cache()
    assert cache.get_shared_backend() is None


def test_memory_backend_kv_and_counter():
    b = cache.MemoryBackend()
    b.set("k", "v", 60)
    assert b.get("k") == "v"
    assert b.getdel("k") == "v"
    assert b.get("k") is None          # single read-and-delete
    assert b.getdel("missing") is None
    assert b.incr("c", 60) == 1
    assert b.incr("c", 60) == 2
    assert b.healthy() is True


def test_redis_backend_kv_counter_and_getdel():
    b = _fake_redis_backend()
    b.set("k", "v", 60)
    assert b.get("k") == "v"
    assert b.getdel("k") == "v"
    assert b.get("k") is None
    assert b.incr("c", 60) == 1
    assert b.incr("c", 60) == 2
    assert b.healthy() is True


def test_ratelimiter_uses_shared_backend(monkeypatch):
    backend = cache.MemoryBackend()
    monkeypatch.setattr(cache, "get_shared_backend", lambda: backend)
    lim = ratelimit.RateLimiter()
    for _ in range(3):
        ok, _ = lim.hit("user:x", 3, 60)
        assert ok is True
    ok, retry = lim.hit("user:x", 3, 60)   # 4th in the window → blocked
    assert ok is False
    assert retry > 0
    # a different key is independent
    assert lim.hit("user:y", 3, 60)[0] is True


def test_ratelimiter_degrades_to_inprocess_on_backend_error(monkeypatch):
    class Broken:
        def incr(self, *a):
            raise RuntimeError("redis down")
    monkeypatch.setattr(cache, "get_shared_backend", lambda: Broken())
    lim = ratelimit.RateLimiter()
    # A Redis error never hard-fails: it falls through to the in-process limiter,
    # which still enforces (so we don't crash, but we don't stop limiting either).
    assert lim.hit("k", 2, 60)[0] is True
    assert lim.hit("k", 2, 60)[0] is True
    assert lim.hit("k", 2, 60)[0] is False  # 3rd over the in-process limit
