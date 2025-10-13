import os

# Server socket
bind = f"0.0.0.0:{os.environ.get('PORT', 10000)}"
backlog = 128

# CRITICAL: Only 1 worker on free tier
workers = 1
worker_class = 'sync'
worker_connections = 5
timeout = 300  # 5 minutes for slow Firebase
graceful_timeout = 30
keepalive = 5

# Worker recycling
max_requests = 50
max_requests_jitter = 10

# Logging
accesslog = None
errorlog = '-'
loglevel = 'warning'

# Process naming
proc_name = 'lodge_mgmt'

# Server mechanics
daemon = False
preload_app = True  # Preload for faster startup
worker_tmp_dir = '/dev/shm'

# Memory limits
limit_request_line = 4096
limit_request_fields = 50
limit_request_field_size = 8190