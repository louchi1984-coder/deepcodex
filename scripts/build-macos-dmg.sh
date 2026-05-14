#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${DEEPCODEX_VERSION:-$(date +%Y.%m.%d)}"
DIST_DIR="${DEEPCODEX_DIST_DIR:-$ROOT/dist}"
BUILD_ROOT="${DEEPCODEX_BUILD_ROOT:-$ROOT/.build/dmg}"
APP_NAME="DeepCodex.app"
DMG_NAME="deepcodex-macos-${VERSION}.dmg"
VOLUME_NAME="DeepCodex"

rm -rf "$BUILD_ROOT"
mkdir -p "$BUILD_ROOT/app" "$BUILD_ROOT/stage" "$DIST_DIR"

DEEPCODEX_INSTALL_TARGET="$BUILD_ROOT/app/$APP_NAME" "$ROOT/scripts/install-deepcodex-app.sh" >/dev/null

/usr/bin/ditto "$BUILD_ROOT/app/$APP_NAME" "$BUILD_ROOT/stage/$APP_NAME"
ln -s /Applications "$BUILD_ROOT/stage/Applications"

rm -f "$DIST_DIR/$DMG_NAME"
hdiutil create \
  -volname "$VOLUME_NAME" \
  -srcfolder "$BUILD_ROOT/stage" \
  -ov \
  -format UDZO \
  "$DIST_DIR/$DMG_NAME" >/dev/null

hdiutil verify "$DIST_DIR/$DMG_NAME" >/dev/null

echo "$DIST_DIR/$DMG_NAME"
