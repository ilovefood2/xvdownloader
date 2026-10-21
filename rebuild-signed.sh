#!/usr/bin/env bash
#
# Rebuild the macOS app + Safari extension, signed with your free Apple
# Development team, and reinstall it to /Applications. Run this after changing
# any extension source, or ~once a year when the free signing certificate
# expires (Safari will start refusing the extension when it does).
#
# Usage:  ./rebuild-signed.sh
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJ="$HERE/XcodeProject/X Video Downloader"
TEAM="${DEVELOPMENT_TEAM:-FS95BL2JJ6}"   # Kelvin Jiang (Personal Team)
APP_NAME="X Video Downloader"

# 1. If you edited files under Extension/, refresh the copy Xcode builds from.
if [ -d "$HERE/Extension" ] && [ -d "$PROJ/X Video Downloader/Shared (Extension)/Resources" ]; then
  DEST="$PROJ/X Video Downloader/Shared (Extension)/Resources"
  echo "==> Syncing Extension/ → project resources"
  rsync -a --delete "$HERE/Extension/" "$DEST/"
fi

echo "==> Quitting the running app"
osascript -e "quit app \"$APP_NAME\"" 2>/dev/null || true
sleep 1

echo "==> Building (signed, team $TEAM)"
cd "$PROJ"
xcodebuild -scheme "$APP_NAME (macOS)" -configuration Debug \
  -destination 'generic/platform=macOS' \
  -allowProvisioningUpdates \
  CODE_SIGN_STYLE=Automatic \
  DEVELOPMENT_TEAM="$TEAM" \
  MACOSX_DEPLOYMENT_TARGET=12.0 \
  build >/tmp/xvd-signed-build.log 2>&1 \
  && echo "   build OK" \
  || { echo "   BUILD FAILED — see /tmp/xvd-signed-build.log"; tail -20 /tmp/xvd-signed-build.log; exit 1; }

BUILT=$(find ~/Library/Developer/Xcode/DerivedData/X_Video_Downloader-*/Build/Products/Debug \
  -maxdepth 1 -name "$APP_NAME.app" 2>/dev/null | head -1)
test -n "$BUILT" || { echo "Could not locate built app"; exit 1; }

echo "==> Installing to /Applications"
rm -rf "/Applications/$APP_NAME.app"
cp -R "$BUILT" "/Applications/$APP_NAME.app"
codesign -dv "/Applications/$APP_NAME.app" 2>&1 | grep -iE 'TeamIdentifier|adhoc' || true
open "/Applications/$APP_NAME.app"
echo "==> Done. If Safari doesn't pick it up, quit & reopen Safari once."
