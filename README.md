# Lodge Management System

A comprehensive lodge/hotel management system built with Flask and Firebase.

## Features

- Guest check-in/check-out
- Room management
- Payment tracking
- Booking system
- Settlement management
- Reports and analytics

## Tech Stack

- **Backend:** Flask (Python)
- **Database:** Firebase Firestore
- **Storage:** Firebase Storage
- **Hosting:** Google Cloud Run
- **CI/CD:** Cloud Build + GitHub

## Deployment

Automatically deploys to Cloud Run when code is pushed to the `production` branch.

**Live URL:** https://lodge-management-xxxxx-el.a.run.app

## Local Development

1. Install dependencies:

```bash
   pip install -r requirements.txt
```

2. Add your `service-account.json` (Firebase credentials)

3. Run locally:

```bash
   python app.py
```

4. Visit: http://localhost:5000

## Project Structure

```
cibara-management/
├── app.py                 # Main Flask application
├── templates/             # HTML templates
├── static/               # CSS, JS, images
├── requirements.txt      # Python dependencies
├── Dockerfile           # Container configuration
├── cloudbuild.yaml      # CI/CD configuration
└── .gitignore          # Git ignore rules
```

## Environment Variables

Required secrets in Google Secret Manager:

- `firebase-credentials` - Base64 encoded Firebase service account
- `firebase-storage-bucket` - Firebase storage bucket URL

## License

Private - All rights reserved

```

---

## **STEP 2: Verify Your Project Structure** 📁

Your folder should look exactly like this:
```

cibara-management/
├── app.py ✅ Your Flask app
├── templates/
│ └── index.html ✅ HTML files
├── static/
│ ├── css/ ✅ Stylesheets
│ ├── js/ ✅ JavaScript
│ └── images/ ✅ Images
├── requirements.txt ✅ NEW/UPDATED
├── Dockerfile ✅ NEW/UPDATED
├── .dockerignore ✅ NEW/UPDATED
├── .gitignore ✅ NEW/UPDATED
├── cloudbuild.yaml ✅ NEW
├── README.md ✅ NEW (optional)
├── gunicorn_config.py ✅ Keep (optional)
├── render.yaml ⚠️ Keep but ignored
├── service-account.json ❌ NEVER upload to GitHub
└── firebase-creds-base64.txt ❌ NEVER upload to GitHub
