import os

# Server socket
bind = f"0.0.0.0:{os.environ.get('PORT', 5000)}"
backlog = 512

# Worker processes - ONLY 1 for free plan
workers = 1
worker_class = 'sync'
worker_connections = 50
timeout = 180
keepalive = 2

# Restart workers periodically
max_requests = 100
max_requests_jitter = 10

# Logging
accesslog = '-'
errorlog = '-'
loglevel = 'warning'

# Process naming
proc_name = 'lodge_management'

# Server mechanics
daemon = False
preload_app = False  # Don't preload on free tier