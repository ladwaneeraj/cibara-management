import os

# Server socket
bind = f"0.0.0.0:{os.environ.get('PORT', 10000)}"
backlog = 256

# CRITICAL: Only 1 worker on free plan
workers = 1
worker_class = 'sync'
worker_connections = 10
timeout = 300  # 5 minutes
graceful_timeout = 30
keepalive = 2

# Aggressive worker recycling
max_requests = 50
max_requests_jitter = 5

# Minimal logging
accesslog = None
errorlog = '-'
loglevel = 'error'

# Process naming
proc_name = 'lodge_management'

# Server mechanics
daemon = False
preload_app = False
worker_tmp_dir = '/tmp'