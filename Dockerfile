# Base image
FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy app source
COPY . .

# Expose Cloud Run port
ENV PORT=8080
EXPOSE 8080

# Run Gunicorn using config file
CMD exec gunicorn -c gunicorn_config.py app:app
