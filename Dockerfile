# Use Python 3.9 slim image
FROM python:3.9-slim

# Set working directory
WORKDIR /app

# Copy requirements first for better caching
COPY requirements.txt .

# Install dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY . .

# Set environment
ENV PORT=8080
EXPOSE 8080

# Run with gunicorn
CMD exec gunicorn --bind 0.0.0.0:${PORT} --workers 4 --threads 2 --timeout 120 app:app