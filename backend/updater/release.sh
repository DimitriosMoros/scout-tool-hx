#!/bin/bash
# Usage: ./release.sh 1.2.3 "What changed in this release"
# Requires: gh CLI (brew install gh  or  https://cli.github.com)

set -e

VERSION=$1
NOTES=${2:-"Bug fixes and improvements"}

if [ -z "$VERSION" ]; then
  echo "Usage: ./release.sh <version> [\"release notes\"]"
  exit 1
fi

echo "Releasing v$VERSION..."

# 1. Update version in package.json
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '$VERSION';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log('Updated package.json to v$VERSION');
"

# 2. Update version.json
cat > version.json << JSON
{
  "version": "$VERSION",
  "notes": "$NOTES",
  "date": "$(date +%Y-%m-%d)",
  "minNodeVersion": "18.0.0"
}
JSON
echo "Updated version.json"

# 3. Create the release zip (exclude node_modules, .env, data files, git)
ZIP_NAME="competitor-scout-v${VERSION}.zip"
echo "Creating $ZIP_NAME..."
zip -r "$ZIP_NAME" . \
  --exclude "*.git*" \
  --exclude "node_modules/*" \
  --exclude "backend/node_modules/*" \
  --exclude "backend/.env" \
  --exclude "backend/data/*" \
  --exclude "*.update-tmp*" \
  --exclude "$ZIP_NAME" \
  --exclude "*.bat" \
  --exclude "release.sh"

echo "Created $ZIP_NAME ($(du -sh $ZIP_NAME | cut -f1))"

# 4. Commit version files
git add package.json version.json
git commit -m "Release v$VERSION — $NOTES"
git push origin main

# 5. Create GitHub Release and upload zip
gh release create "v$VERSION" \
  "$ZIP_NAME" \
  --title "v$VERSION" \
  --notes "$NOTES"

# 6. Clean up local zip
rm "$ZIP_NAME"

echo ""
echo "✓ Released v$VERSION"
echo "  Clients will auto-update on next launch"