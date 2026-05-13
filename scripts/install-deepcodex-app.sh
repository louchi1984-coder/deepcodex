#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_APP="$ROOT/deepcodex.app"
TARGET_APP="${DEEPCODEX_INSTALL_TARGET:-/Applications/deepcodex.app}"
RUNTIME_DIR="$SOURCE_APP/Contents/Resources/runtime"
TARGET_PARENT="$(dirname "$TARGET_APP")"
LAUNCHER_SRC="$ROOT/src/deepcodex-launcher.c"

find_codex_bin() {
  if [ -n "${CODEX_BIN:-}" ] && [ -x "$CODEX_BIN" ]; then
    printf '%s\n' "$CODEX_BIN"
    return 0
  fi

  local candidate
  for candidate in \
    "/Applications/Codex.app/Contents/MacOS/Codex" \
    "$HOME/Applications/Codex.app/Contents/MacOS/Codex"; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  if command -v mdfind >/dev/null 2>&1; then
    while IFS= read -r candidate; do
      candidate="$candidate/Contents/MacOS/Codex"
      if [ -x "$candidate" ]; then
        printf '%s\n' "$candidate"
        return 0
      fi
    done < <(mdfind 'kMDItemCFBundleIdentifier == "com.openai.codex"' 2>/dev/null || true)
  fi

  return 1
}

CODEX_BIN="$(find_codex_bin || true)"

if [ ! -d "$SOURCE_APP" ]; then
  echo "deepcodex.app not found: $SOURCE_APP" >&2
  exit 1
fi

if [ ! -d "$TARGET_PARENT" ] || [ ! -w "$TARGET_PARENT" ]; then
  echo "Target directory is not writable: $TARGET_PARENT" >&2
  echo "Run this script from an admin account, or set DEEPCODEX_INSTALL_TARGET to a writable .app path." >&2
  exit 1
fi

if [ ! -f "$LAUNCHER_SRC" ]; then
  echo "Launcher source not found: $LAUNCHER_SRC" >&2
  exit 1
fi

if [ -z "$CODEX_BIN" ] || [ ! -x "$CODEX_BIN" ]; then
  echo "Codex Desktop is required but could not be found automatically." >&2
  echo "Install Codex Desktop first, or set CODEX_BIN to the Codex executable path, then run this installer again." >&2
  exit 1
fi

clang -Wall -Wextra -O2 "$LAUNCHER_SRC" -o "$SOURCE_APP/Contents/MacOS/CodexDeepSeekLauncher"
cp "$SOURCE_APP/Contents/MacOS/CodexDeepSeekLauncher" "$SOURCE_APP/Contents/MacOS/DeepCodexLauncher"

rm -rf "$RUNTIME_DIR"
mkdir -p "$RUNTIME_DIR/codex-home-deepseek-app"
/usr/bin/ditto "$ROOT/scripts" "$RUNTIME_DIR/scripts"
/usr/bin/ditto "$ROOT/translator" "$RUNTIME_DIR/translator"
/usr/bin/ditto "$ROOT/assets" "$RUNTIME_DIR/assets"
cp "$ROOT/codex-home-deepseek-app/config.adaptive-oneapi.toml" "$RUNTIME_DIR/codex-home-deepseek-app/config.adaptive-oneapi.toml"
cp "$ROOT/codex-home-deepseek-app/deepseek-model-catalog.json" "$RUNTIME_DIR/codex-home-deepseek-app/deepseek-model-catalog.json"
rm -rf "$RUNTIME_DIR/translator/tests" "$RUNTIME_DIR/scripts/__pycache__" "$RUNTIME_DIR/translator/tools/__pycache__"
rm -f "$RUNTIME_DIR/scripts/install-deepcodex-app.sh" "$RUNTIME_DIR/scripts/DeepCodexSetup.swift"

rm -rf "$TARGET_APP"
/usr/bin/ditto "$SOURCE_APP" "$TARGET_APP"
/usr/bin/codesign --force --deep --sign - "$TARGET_APP" >/dev/null 2>&1
/usr/bin/xattr -dr com.apple.quarantine "$TARGET_APP" >/dev/null 2>&1 || true
/usr/bin/touch "$TARGET_APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$TARGET_APP" >/dev/null 2>&1 || true

echo "Installed deepcodex:"
echo "  $TARGET_APP"
