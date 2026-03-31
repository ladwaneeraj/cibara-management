import os

bind = f"0.0.0.0:{os.environ.get('PORT', 8080)}"

# gthread: each worker spawns multiple OS threads.
# This app is almost entirely I/O-bound (Firestore network calls), so threads
# are cheap and effective here — they release the GIL while waiting on network.
# workers=2 × threads=8 → up to 16 concurrent requests per container,
# meaning checkin/checkout/addon calls no longer queue behind each other.
worker_class   = 'gthread'
workers        = 2
threads        = 8

timeout        = 300
graceful_timeout = 30
keepalive      = 5

accesslog = '-'
errorlog  = '-'
loglevel  = 'info'
