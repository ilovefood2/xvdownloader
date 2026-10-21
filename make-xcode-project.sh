#!/usr/bin/env bash
#
# Generate the Safari Web Extension Xcode project (macOS + iOS/iPadOS) from the
# ported extension in ./Extension.
#
# Apple ships `safari-web-extension-converter` *inside Xcode*. It is the only
# supported, reliable way to produce a correct multi-target .xcodeproj — hand-
# authoring the pbxproj for a macOS-app + macOS-extension + iOS-app +
# iOS-extension project is not something you want to debug by hand. This script
# runs the converter with sensible defaults, then (optionally) drops the branded
# container-app UI from ./AppScaffold on top of what it generates.
#
# Prereqs (all on a Mac with the FULL Xcode.app, not just Command Line Tools):
#   xcode-select -p        # must point at /Applications/Xcode.app/... , not CLT
#   xcrun --find safari-web-extension-converter   # must resolve
#
# Usage:
#   ./make-xcode-project.sh
#   APP_NAME="X Video Downloader" BUNDLE_ID="com.yourname.xvideodownloader" ./make-xcode-project.sh

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$HERE/Extension"
OUT_DIR="${OUT_DIR:-$HERE/XcodeProject}"
APP_NAME="${APP_NAME:-X Video Downloader}"
BUNDLE_ID="${BUNDLE_ID:-com.example.xvideodownloader}"

echo "==> Checking toolchain"
if ! xcode-select -p 2>/dev/null | grep -q "Xcode.app"; then
  cat >&2 <<'MSG'
ERROR: The active developer directory is the Command Line Tools, not full Xcode.
       The converter ships only with Xcode.app. Install Xcode from the App Store,
       then run:
           sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
MSG
  exit 1
fi

if ! xcrun --find safari-web-extension-converter >/dev/null 2>&1; then
  echo "ERROR: safari-web-extension-converter not found in this Xcode." >&2
  exit 1
fi

echo "==> Validating extension at: $EXT_DIR"
test -f "$EXT_DIR/manifest.json" || { echo "ERROR: $EXT_DIR/manifest.json missing" >&2; exit 1; }

echo "==> Generating Xcode project (macOS + iOS) into: $OUT_DIR"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

# No --macos-only / --ios-only  => the converter emits BOTH platform targets.
xcrun safari-web-extension-converter "$EXT_DIR" \
  --app-name "$APP_NAME" \
  --bundle-identifier "$BUNDLE_ID" \
  --project-location "$OUT_DIR" \
  --no-open \
  --force \
  --copy-resources

# Apply the styling-only container-app overlay (see AppScaffold/README.md).
APP_RES="$(find "$OUT_DIR" -type d -path '*Shared (App)/Resources' | head -1)"
if [ -n "$APP_RES" ] && [ -d "$HERE/AppScaffold/Resources" ]; then
  echo "==> Applying branded overlay (Style.css, Icon.png) to: $APP_RES"
  cp "$HERE/AppScaffold/Resources/Style.css" "$APP_RES/Style.css"
  cp "$HERE/AppScaffold/Resources/Icon.png" "$APP_RES/Icon.png"
fi

echo
echo "==> Done."
echo "    Open the generated project:"
find "$OUT_DIR" -maxdepth 2 -name '*.xcodeproj' -print
echo
echo "    Next steps are in README.md (signing team, enable the extension in"
echo "    Safari > Settings > Extensions, allow it on all sites)."
echo
echo "    To brand the container-app window, copy the files from AppScaffold/"
echo "    over the Resources the converter created (see AppScaffold/README.md)."
