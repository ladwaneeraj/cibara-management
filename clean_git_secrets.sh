#!/bin/bash
# ============================================================
# clean_git_secrets.sh
# Run this ONCE on your local machine to permanently remove
# static/firebase-config.js from ALL git history, then
# force-push the clean history to GitHub.
#
# Requirements: git (any version), internet access to GitHub
# ============================================================

set -e

echo "🔍 Checking for sensitive file in history..."
COUNT=$(git log --all --oneline -- static/firebase-config.js | wc -l)
echo "   Found in $COUNT commit(s)"

if [ "$COUNT" -eq 0 ]; then
  echo "✅ Already clean — nothing to do."
  exit 0
fi

echo ""
echo "⚠️  This will REWRITE git history. All teammates must re-clone after this."
read -p "   Type 'yes' to continue: " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "Aborted."
  exit 1
fi

echo ""
echo "🧹 Removing static/firebase-config.js from all commits..."
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch --force --index-filter \
  "git rm --cached --ignore-unmatch static/firebase-config.js" \
  --prune-empty --tag-name-filter cat -- --all

echo ""
echo "🗑️  Cleaning up old refs..."
git for-each-ref --format="delete %(refname)" refs/original | git update-ref --stdin
git reflog expire --expire=now --all
git gc --prune=now --aggressive

echo ""
echo "📤 Force-pushing clean history to GitHub..."
git push origin --force --all
git push origin --force --tags

echo ""
echo "✅ Done! The Firebase config is no longer in git history."
echo ""
echo "🔑 Next steps:"
echo "   1. Go to Google Cloud Console → APIs & Services → Credentials"
echo "   2. REGENERATE your Firebase Web API Key (the old one is now public)"
echo "   3. Set these env vars in Cloud Run:"
echo "      FIREBASE_WEB_API_KEY=<new key>"
echo "      FIREBASE_AUTH_DOMAIN=cibara-software-61512.firebaseapp.com"
echo "      FIREBASE_PROJECT_ID=cibara-software-61512"
echo "      FIREBASE_STORAGE_BUCKET=cibara-software-61512.firebasestorage.app"
echo "      FIREBASE_MESSAGING_SENDER_ID=117552649945"
echo "      FIREBASE_APP_ID=1:117552649945:web:5d4983739b1a8c077e50c8"
echo "      FIREBASE_MEASUREMENT_ID=G-5VY26JYPN0"
echo "      LODGE_PIN=<your 4-6 digit PIN>"
echo "      API_KEY=<your backend API key>"
echo "      MANAGER_PASSWORD=<your manager password>"
