#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEEPCODEX_STATE_ROOT="${DEEPCODEX_STATE_ROOT:-$HOME/Library/Application Support/deepcodex}"
TRANSLATOR_URL="${TRANSLATOR_URL:-http://127.0.0.1:8282}"
TRANSLATOR_LOG="${TRANSLATOR_LOG:-$DEEPCODEX_STATE_ROOT/adaptive-translator.log}"
TRANSLATOR_PID_FILE="${TRANSLATOR_PID_FILE:-$DEEPCODEX_STATE_ROOT/adaptive-translator.pid}"
TRANSLATOR_WATCH_PID_FILE="${TRANSLATOR_WATCH_PID_FILE:-$DEEPCODEX_STATE_ROOT/adaptive-translator-watch.pid}"
TRANSLATOR_PROFILE_PATH="${TRANSLATOR_PROFILE_PATH:-$DEEPCODEX_STATE_ROOT/codex-home-deepseek-app/provider-profile.json}"
UPSTREAM_URL="${UPSTREAM_URL:-https://api.deepseek.com/v1}"
DEEPCODEX_WATCH_GRACE_SECONDS="${DEEPCODEX_WATCH_GRACE_SECONDS:-10}"

mkdir -p "$DEEPCODEX_STATE_ROOT"
echo "$$" > "$TRANSLATOR_WATCH_PID_FILE"

log() {
  printf '[watch] %s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$TRANSLATOR_LOG"
}

translator_alive() {
  curl -fsS "$TRANSLATOR_URL/health" >/dev/null 2>&1
}

ui_alive() {
  ps -axo command= \
    | grep -F "/Applications/Codex.app/Contents/MacOS/Codex" \
    | grep -F -- "--user-data-dir=" \
    | grep -F "Application Support/deepcodex/" \
    >/dev/null 2>&1
}

start_translator() {
  if [ -z "${UPSTREAM_API_KEY:-}" ]; then
    log "UPSTREAM_API_KEY is missing; cannot start translator"
    return 1
  fi

  if [ -f "$TRANSLATOR_PID_FILE" ]; then
    local old_pid
    old_pid="$(cat "$TRANSLATOR_PID_FILE" 2>/dev/null || true)"
    if [ -n "$old_pid" ] && ps -p "$old_pid" >/dev/null 2>&1; then
      kill "$old_pid" >/dev/null 2>&1 || true
    fi
  fi

  log "starting translator at $TRANSLATOR_URL"
  (
    cd "$ROOT"
    exec env \
      UPSTREAM_URL="$UPSTREAM_URL" \
      UPSTREAM_API_KEY="$UPSTREAM_API_KEY" \
      TRANSLATOR_PROFILE_PATH="$TRANSLATOR_PROFILE_PATH" \
      "$ROOT/scripts/start-adaptive-translator.sh"
  ) >> "$TRANSLATOR_LOG" 2>&1 < /dev/null &
  echo "$!" > "$TRANSLATOR_PID_FILE"
}

stop_translator() {
  if [ -f "$TRANSLATOR_PID_FILE" ]; then
    local pid
    pid="$(cat "$TRANSLATOR_PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ]; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  fi
}

cleanup() {
  stop_translator
  rm -f "$TRANSLATOR_WATCH_PID_FILE"
}
trap cleanup EXIT INT TERM

start_time="$(date +%s)"
seen_ui=0

while true; do
  if ui_alive; then
    seen_ui=1
  else
    if [ "$seen_ui" = "1" ]; then
      log "deepcodex UI exited; stopping translator watcher"
      exit 0
    fi

    now="$(date +%s)"
    if [ $((now - start_time)) -gt "$DEEPCODEX_WATCH_GRACE_SECONDS" ]; then
      log "deepcodex UI did not appear during startup grace; stopping translator watcher"
      exit 0
    fi
  fi

  if ! translator_alive; then
    start_translator || true
  fi

  sleep 1
done
