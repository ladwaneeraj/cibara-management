import os

# Server socket
bind = f"0.0.0.0:{os.environ.get('PORT', 10000)}"
backlog = 128  # Reduced from 256

# CRITICAL: Only 1 worker on free tier
workers = 1
worker_class = 'gevent'
worker_connections = 100  # Reduced from 10
timeout = 120  # Reduced to 2 minutes
graceful_timeout = 20  # Reduced
keepalive = 2

# AGGRESSIVE worker recycling to prevent memory leaks
max_requests = 25  # Reduced from 50
max_requests_jitter = 3

# Minimal logging
accesslog = None
errorlog = '-'
loglevel = 'error'

# Process naming
proc_name = 'lodge_mgmt'

# Server mechanics
daemon = False
preload_app = False
worker_tmp_dir = '/dev/shm'  # Use shared memory instead of /tmp

# Memory optimization
limit_request_line = 4096
limit_request_fields = 50
limit_request_field_size = 8190