import os

bind = f"0.0.0.0:{os.environ.get('PORT', 8080)}"
workers = 2  # Cloud Run scales automatically
threads = 4
timeout = 300
graceful_timeout = 30
keepalive = 5

accesslog = '-'
errorlog = '-'
loglevel = 'info'
