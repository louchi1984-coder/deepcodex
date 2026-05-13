#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRANSLATOR_HOST="${TRANSLATOR_HOST:-127.0.0.1}"
TRANSLATOR_PORT="${TRANSLATOR_PORT:-8282}"
UPSTREAM_URL="${UPSTREAM_URL:-https://api.deepseek.com/v1}"

find_node_bin() {
  if [ -n "${NODE_BIN:-}" ] && [ -x "$NODE_BIN" ]; then
    printf '%s\n' "$NODE_BIN"
    return 0
  fi
  local candidate
  for candidate in \
    "$(command -v node 2>/dev/null || true)" \
    "/opt/homebrew/bin/node" \
    "/usr/local/bin/node"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

NODE_BIN="$(find_node_bin || true)"

if [ ! -x "$NODE_BIN" ]; then
  echo "Node.js was not found. Install Node.js or set NODE_BIN." >&2
  exit 1
fi

if [ -z "${UPSTREAM_API_KEY:-}" ]; then
  echo "Set UPSTREAM_API_KEY to the provider API key before starting the translator." >&2
  exit 1
fi

export TRANSLATOR_HOST TRANSLATOR_PORT UPSTREAM_URL
export TRANSLATOR_PROFILE_PATH
exec "$NODE_BIN" "$ROOT/translator/adaptive-server.mjs"
