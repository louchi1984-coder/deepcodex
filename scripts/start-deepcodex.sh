#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEEPCODEX_STATE_ROOT="${DEEPCODEX_STATE_ROOT:-$HOME/Library/Application Support/deepcodex}"
CODEX_HOME_DIR="${CODEX_HOME_DIR:-$DEEPCODEX_STATE_ROOT/codex-home-deepseek-app}"
ELECTRON_USER_DATA="${ELECTRON_USER_DATA:-$CODEX_HOME_DIR/electron-user-data-adaptive}"
DEEPCODEX_WORKSPACE="${DEEPCODEX_WORKSPACE:-}"
DEEPCODEX_PROJECTS_ROOT="${DEEPCODEX_PROJECTS_ROOT:-$HOME/Documents/deepcodex}"
TRANSLATOR_URL="${TRANSLATOR_URL:-http://127.0.0.1:8282}"
TRANSLATOR_LOG="${TRANSLATOR_LOG:-$DEEPCODEX_STATE_ROOT/adaptive-translator.log}"
TRANSLATOR_PID_FILE="${TRANSLATOR_PID_FILE:-$DEEPCODEX_STATE_ROOT/adaptive-translator.pid}"
TRANSLATOR_WATCH_PID_FILE="${TRANSLATOR_WATCH_PID_FILE:-$DEEPCODEX_STATE_ROOT/adaptive-translator-watch.pid}"
DEEP_CODEX_ENV_FILE="${DEEP_CODEX_ENV_FILE:-$DEEPCODEX_STATE_ROOT/.deepcodex.env}"
SETUP_LAST_LOG="${DEEP_CODEX_SETUP_LAST_LOG:-$DEEPCODEX_STATE_ROOT/.deepcodex-setup-last.log}"
SETUP_UI_SCRIPT="$ROOT/scripts/deepcodex-setup-ui.mjs"
SETUP_UI_BIN="${DEEPCODEX_SETUP_UI_BIN:-$ROOT/scripts/DeepCodexSetup}"
DEEPCODEX_APP_BUNDLE="${DEEPCODEX_APP_BUNDLE:-/Applications/deepcodex.app}"
PROVIDER_PROFILE_PATH="${DEEPCODEX_PROVIDER_PROFILE:-$CODEX_HOME_DIR/provider-profile.json}"
GLOBAL_CODEX_HOME="${GLOBAL_CODEX_HOME:-$HOME/.codex}"
SHARED_CONFIG_SYNC="$ROOT/scripts/sync-shared-codex-config.mjs"
DEEPCODEX_REGISTRATION_SYNC="$ROOT/scripts/sync-deepcodex-plugin-registrations.mjs"
PLUGIN_HOST_SYNC_SCRIPT="$ROOT/scripts/sync-shared-codex-plugin-host.mjs"
SIDECAR_SYNC_SCRIPT="$ROOT/scripts/sync-shared-codex-sidecars.mjs"
CONFIG_TEMPLATE_PATH="${DEEPCODEX_CONFIG_TEMPLATE:-$ROOT/codex-home-deepseek-app/config.adaptive-oneapi.toml}"
MODEL_CATALOG_TEMPLATE_PATH="${DEEPCODEX_MODEL_CATALOG_TEMPLATE:-$ROOT/codex-home-deepseek-app/deepseek-model-catalog.json}"
TRANSLATOR_WATCH_SCRIPT="$ROOT/scripts/deepcodex-translator-watch.sh"
LOCAL_CODEX_API_KEY="${LOCAL_CODEX_API_KEY:-sk-codex-deepseek-local}"
DEEPCODEX_DISPLAY_NAME="${DEEPCODEX_DISPLAY_NAME:-娄老师说的对}"

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

alert() {
  /usr/bin/osascript - "$1" <<'APPLESCRIPT' >/dev/null 2>&1 || true
on run argv
  display alert "deepcodex" message (item 1 of argv) as critical
end run
APPLESCRIPT
}

if [ -z "$CODEX_BIN" ] || [ ! -x "$CODEX_BIN" ]; then
  alert "未找到 Codex Desktop。请先安装 Codex Desktop，或在启动 deepcodex 前设置 CODEX_BIN。

Codex Desktop was not found. Install Codex Desktop first, or set CODEX_BIN before launching deepcodex."
  exit 1
fi

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  alert "未找到 Node.js。请安装 Node.js，或在启动 deepcodex 前设置 NODE_BIN。

Node.js was not found. Install Node.js or set NODE_BIN before launching deepcodex."
  exit 1
fi

read_deepseek_key() {
  if [ -n "${DEEPSEEK_API_KEY:-}" ]; then
    printf '%s\n' "$DEEPSEEK_API_KEY"
    return 0
  fi
  if [ -f "$DEEP_CODEX_ENV_FILE" ]; then
    awk -F= '/^DEEPSEEK_API_KEY=./ { print substr($0, index($0, "=") + 1); exit }' "$DEEP_CODEX_ENV_FILE"
    return 0
  fi
}

save_deepseek_key() {
  local key="$1"
  mkdir -p "$(dirname "$DEEP_CODEX_ENV_FILE")"
  if [ ! -f "$DEEP_CODEX_ENV_FILE" ]; then
    touch "$DEEP_CODEX_ENV_FILE"
  fi
  local tmp="$DEEP_CODEX_ENV_FILE.tmp.$$"
  awk -v key="$key" '
    BEGIN { done = 0 }
    /^DEEPSEEK_API_KEY=/ {
      if (!done) {
        print "DEEPSEEK_API_KEY=" key
        done = 1
      }
      next
    }
    { print }
    END {
      if (!done) print "DEEPSEEK_API_KEY=" key
    }
  ' "$DEEP_CODEX_ENV_FILE" > "$tmp"
  mv "$tmp" "$DEEP_CODEX_ENV_FILE"
  chmod 600 "$DEEP_CODEX_ENV_FILE" >/dev/null 2>&1 || true
}

clear_deepseek_key() {
  local file tmp
  for file in "$DEEP_CODEX_ENV_FILE"; do
    if [ ! -f "$file" ]; then
      continue
    fi
    tmp="$file.tmp.$$"
    awk '!/^DEEPSEEK_API_KEY=/' "$file" > "$tmp" || true
    mv "$tmp" "$file"
    chmod 600 "$file" >/dev/null 2>&1 || true
  done
}

sync_global_rules() {
  if [ -d "$GLOBAL_CODEX_HOME/rules" ]; then
    mkdir -p "$CODEX_HOME_DIR/rules"
    cp -R "$GLOBAL_CODEX_HOME/rules/." "$CODEX_HOME_DIR/rules/" 2>/dev/null || true
  fi
}

seed_runtime_defaults() {
  mkdir -p "$CODEX_HOME_DIR"
  if [ -f "$CONFIG_TEMPLATE_PATH" ] && [ ! -f "$CODEX_HOME_DIR/config.adaptive-oneapi.toml" ]; then
    cp "$CONFIG_TEMPLATE_PATH" "$CODEX_HOME_DIR/config.adaptive-oneapi.toml"
  fi
  if [ -f "$MODEL_CATALOG_TEMPLATE_PATH" ] && [ ! -f "$CODEX_HOME_DIR/deepseek-model-catalog.json" ]; then
    cp "$MODEL_CATALOG_TEMPLATE_PATH" "$CODEX_HOME_DIR/deepseek-model-catalog.json"
  fi
}

normalize_projectless_root_hints() {
  mkdir -p "$DEEPCODEX_PROJECTS_ROOT"
  "$NODE_BIN" - "$CODEX_HOME_DIR/.codex-global-state.json" "$HOME/Documents/Codex" "$DEEPCODEX_PROJECTS_ROOT" <<'NODE'
const fs = require("fs");
const [statePath, oldRoot, newRoot] = process.argv.slice(2);
let state = {};
try {
  state = JSON.parse(fs.readFileSync(statePath, "utf8"));
} catch {
  process.exit(0);
}

let changed = false;

const hints = state["thread-workspace-root-hints"];
if (hints && typeof hints === "object") {
  for (const [threadId, root] of Object.entries(hints)) {
    if (root === oldRoot) {
      hints[threadId] = newRoot;
      changed = true;
    }
  }
}

if (changed) {
  fs.writeFileSync(statePath, JSON.stringify(state));
}
NODE
}

mkdir -p "$DEEPCODEX_STATE_ROOT"
mkdir -p "$DEEPCODEX_PROJECTS_ROOT"
seed_runtime_defaults
normalize_projectless_root_hints
"$NODE_BIN" "$PLUGIN_HOST_SYNC_SCRIPT" "$CODEX_HOME_DIR" "$GLOBAL_CODEX_HOME" >/dev/null 2>&1 || true

trust_workspace() {
  local workspace="$1"
  "$NODE_BIN" - "$CODEX_HOME_DIR/config.toml" "$workspace" <<'NODE'
const fs = require("fs");
const [configPath, workspace] = process.argv.slice(2);
let text = "";
try { text = fs.readFileSync(configPath, "utf8"); } catch {}
const escaped = workspace.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const header = `[projects."${escaped}"]`;
if (!text.includes(header)) {
  const block = `${text.trimEnd()}\n\n${header}\ntrust_level = "trusted"\n`;
  fs.writeFileSync(configPath, block);
}
NODE
}

write_pseudo_login_auth() {
  mkdir -p "$CODEX_HOME_DIR"
  "$NODE_BIN" - "$CODEX_HOME_DIR/auth.json" "$DEEPCODEX_DISPLAY_NAME" <<'NODE'
const fs = require("fs");
const [authPath, displayName] = process.argv.slice(2);
const b64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const fakeJwt = (payload) => `${b64url({ alg: "none", typ: "JWT" })}.${b64url(payload)}.deepcodex`;
const now = Math.floor(Date.now() / 1000);
const accountId = "deepcodex-local-account";
const userId = "deepcodex-local-user";
const profile = {
  email: displayName,
  email_verified: true,
  name: displayName,
};
fs.writeFileSync(authPath, JSON.stringify({
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: {
    id_token: fakeJwt({
      iss: "https://auth.openai.com",
      aud: ["app_deepcodex_local"],
      sub: userId,
      iat: now,
      exp: now + 365 * 24 * 60 * 60,
      email: displayName,
      email_verified: true,
      name: displayName,
      "https://api.openai.com/auth": {
        user_id: userId,
        chatgpt_user_id: userId,
        chatgpt_account_id: accountId,
        chatgpt_account_user_id: `${userId}__${accountId}`,
        chatgpt_plan_type: "prolite",
        localhost: true,
        groups: [],
        organizations: []
      }
    }),
    access_token: fakeJwt({
      iss: "https://auth.openai.com",
      aud: ["https://api.openai.com/v1"],
      sub: userId,
      iat: now,
      nbf: now,
      exp: now + 365 * 24 * 60 * 60,
      scp: ["openid", "profile", "email", "offline_access"],
      "https://api.openai.com/profile": profile,
      "https://api.openai.com/auth": {
        user_id: userId,
        chatgpt_user_id: userId,
        chatgpt_account_id: accountId,
        chatgpt_account_user_id: `${userId}__${accountId}`,
        chatgpt_plan_type: "prolite",
        localhost: true
      }
    }),
    refresh_token: "rt_deepcodex_local",
    account_id: accountId
  },
  last_refresh: new Date().toISOString()
}, null, 2) + "\n");
NODE
  chmod 600 "$CODEX_HOME_DIR/auth.json" >/dev/null 2>&1 || true
}

auth_file_valid() {
  [ -s "$CODEX_HOME_DIR/auth.json" ] || return 1
  "$NODE_BIN" - "$CODEX_HOME_DIR/auth.json" >/dev/null 2>&1 <<'NODE'
const fs = require("fs");
const [authPath] = process.argv.slice(2);
const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
if (
  auth.auth_mode !== "chatgpt" ||
  !auth.tokens?.access_token ||
  !auth.tokens?.id_token ||
  auth.tokens?.refresh_token !== "rt_deepcodex_local" ||
  auth.tokens?.account_id !== "deepcodex-local-account"
) {
  process.exit(1);
}
NODE
}

if ! auth_file_valid; then
  clear_deepseek_key
fi

if [ -z "${UPSTREAM_API_KEY:-}" ]; then
  UPSTREAM_API_KEY="$(read_deepseek_key | tr -d '[:space:]')"
  export UPSTREAM_API_KEY
fi

write_pseudo_login_auth

if [ -z "${UPSTREAM_API_KEY:-}" ]; then
  if [ ! -f "$SETUP_UI_SCRIPT" ]; then
    alert "DeepCodex setup 页面不存在。请检查：
$SETUP_UI_SCRIPT

DeepCodex setup page is missing. Check:
$SETUP_UI_SCRIPT"
    exit 1
  fi
  if [ -x "$SETUP_UI_BIN" ]; then
    SETUP_COMMAND=("$SETUP_UI_BIN" "$ROOT")
  else
    SETUP_COMMAND=("$NODE_BIN" "$SETUP_UI_SCRIPT")
  fi
  set +e
  UPSTREAM_API_KEY="$(NODE_BIN="$NODE_BIN" DEEPCODEX_PROVIDER_PROFILE="$PROVIDER_PROFILE_PATH" "${SETUP_COMMAND[@]}" 2>"$SETUP_LAST_LOG" | tr -d '[:space:]')"
  SETUP_STATUS="$?"
  set -e
  if [ "$SETUP_STATUS" -eq 130 ]; then
    exit 0
  fi
  if [ "$SETUP_STATUS" -eq 0 ] && [ -n "$UPSTREAM_API_KEY" ]; then
    save_deepseek_key "$UPSTREAM_API_KEY"
    export UPSTREAM_API_KEY
    if [ -d "$DEEPCODEX_APP_BUNDLE" ]; then
      (
        sleep 1
        open -n -a "$DEEPCODEX_APP_BUNDLE" >/dev/null 2>&1 || true
      ) >/dev/null 2>&1 &
      # Keep the first-run launcher alive briefly so macOS permission prompts
      # attached to this chain do not disappear before the user can click them.
      sleep 8
      exit 0
    fi
  else
    SETUP_ERROR="$(tail -12 "$SETUP_LAST_LOG" 2>/dev/null | sed 's/"/'\''/g' || true)"
    if [ -z "$SETUP_ERROR" ]; then
      SETUP_ERROR="未提供 DeepSeek API key。 / No DeepSeek API key was provided."
    fi
    alert "$(printf '首次设置失败 / First setup failed:\n\n%s\n\n日志 / Logs:\n%s' "$SETUP_ERROR" "$SETUP_LAST_LOG")"
    exit 1
  fi
fi

if ! curl -fsS "$TRANSLATOR_URL/health" >/dev/null 2>&1; then
  echo "Starting adaptive translator at $TRANSLATOR_URL ..."
  : > "$TRANSLATOR_LOG"
fi

watch_pid="$(cat "$TRANSLATOR_WATCH_PID_FILE" 2>/dev/null || true)"
if [ -z "$watch_pid" ] || ! ps -p "$watch_pid" >/dev/null 2>&1; then
  nohup env \
    DEEPCODEX_STATE_ROOT="$DEEPCODEX_STATE_ROOT" \
    TRANSLATOR_URL="$TRANSLATOR_URL" \
    TRANSLATOR_LOG="$TRANSLATOR_LOG" \
    TRANSLATOR_PID_FILE="$TRANSLATOR_PID_FILE" \
    TRANSLATOR_WATCH_PID_FILE="$TRANSLATOR_WATCH_PID_FILE" \
    UPSTREAM_URL="${UPSTREAM_URL:-https://api.deepseek.com/v1}" \
    UPSTREAM_API_KEY="$UPSTREAM_API_KEY" \
    TRANSLATOR_PROFILE_PATH="$PROVIDER_PROFILE_PATH" \
    "$TRANSLATOR_WATCH_SCRIPT" \
    >> "$TRANSLATOR_LOG" 2>&1 < /dev/null &
fi

for _ in $(seq 1 45); do
  if curl -fsS "$TRANSLATOR_URL/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -fsS "$TRANSLATOR_URL/health" >/dev/null 2>&1; then
  TRANSLATOR_ERROR="$(tail -20 "$TRANSLATOR_LOG" 2>/dev/null || true)"
  echo "Adaptive translator did not become ready. Check $TRANSLATOR_LOG" >&2
  alert "$(printf '翻译层启动失败 / Translator failed to start:\n\n%s\n\n日志 / Logs:\n%s' "$TRANSLATOR_ERROR" "$TRANSLATOR_LOG")"
  exit 1
fi

mkdir -p "$CODEX_HOME_DIR" "$ELECTRON_USER_DATA"
PREVIOUS_CONFIG_FILE=""
if [ -f "$CODEX_HOME_DIR/config.toml" ] && [ ! -f "$CODEX_HOME_DIR/config.toml.before-adaptive-oneapi" ]; then
  cp "$CODEX_HOME_DIR/config.toml" "$CODEX_HOME_DIR/config.toml.before-adaptive-oneapi"
fi
if [ -f "$CODEX_HOME_DIR/config.toml" ]; then
  PREVIOUS_CONFIG_FILE="$CODEX_HOME_DIR/config.toml.deepcodex-prev.$$"
  cp "$CODEX_HOME_DIR/config.toml" "$PREVIOUS_CONFIG_FILE"
fi
cp "$CODEX_HOME_DIR/config.adaptive-oneapi.toml" "$CODEX_HOME_DIR/config.toml"
"$NODE_BIN" - "$CODEX_HOME_DIR/config.toml" "$CODEX_HOME_DIR/deepseek-model-catalog.json" <<'NODE'
const fs = require("fs");
const [configPath, catalogPath] = process.argv.slice(2);
let text = fs.readFileSync(configPath, "utf8");
text = text.replace(/__DEEPCODEX_MODEL_CATALOG__/g, catalogPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"'));
fs.writeFileSync(configPath, text);
NODE

if [ -f "$GLOBAL_CODEX_HOME/config.toml" ]; then
  "$NODE_BIN" "$SHARED_CONFIG_SYNC" "$GLOBAL_CODEX_HOME/config.toml" "$CODEX_HOME_DIR/config.toml"
fi
if [ -f "$SIDECAR_SYNC_SCRIPT" ]; then
  "$NODE_BIN" "$SIDECAR_SYNC_SCRIPT" "$GLOBAL_CODEX_HOME" "$CODEX_HOME_DIR" "$GLOBAL_CODEX_HOME/config.toml" "$CODEX_HOME_DIR/config.toml" >/dev/null 2>&1 || true
fi

if [ -n "$PREVIOUS_CONFIG_FILE" ] && [ -f "$PREVIOUS_CONFIG_FILE" ]; then
  "$NODE_BIN" - "$CODEX_HOME_DIR/config.toml" "$PREVIOUS_CONFIG_FILE" <<'NODE'
const fs = require("fs");
const [targetPath, previousPath] = process.argv.slice(2);

function splitBlocks(text) {
  const blocks = [];
  let current = { header: null, lines: [] };
  for (const line of text.split(/\r?\n/)) {
    if (/^\[[^\]]+\]\s*$/.test(line)) {
      blocks.push(current);
      current = { header: line.trim(), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  blocks.push(current);
  return blocks;
}

function render(blocks) {
  return blocks
    .map((block) => block.lines.join("\n").replace(/\n+$/g, ""))
    .filter(Boolean)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd() + "\n";
}

function readTopLevelValue(text, key) {
  const match = text.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, "m"));
  return match ? match[1].trim() : null;
}

function setTopLevelValue(text, key, value) {
  if (!value) return text;
  const line = `${key} = ${value}`;
  const re = new RegExp(`^${key}\\s*=.*$`, "m");
  if (re.test(text)) return text.replace(re, line);
  const anchor = /^model_reasoning_effort\s*=.*$/m;
  if (anchor.test(text)) return text.replace(anchor, (m) => `${m}\n${line}`);
  return `${line}\n${text}`;
}

const previous = fs.readFileSync(previousPath, "utf8");
let target = fs.readFileSync(targetPath, "utf8");

for (const key of ["approval_policy", "sandbox_mode", "default_permissions"]) {
  target = setTopLevelValue(target, key, readTopLevelValue(previous, key));
}

const previousBlocks = splitBlocks(previous);
const targetBlocks = splitBlocks(target);
const preserveBlock = (block) => Boolean(block.header && (
  /^\[projects\./.test(block.header) ||
  /^\[permissions\./.test(block.header)
));
const preserved = previousBlocks.filter(preserveBlock);
const kept = targetBlocks.filter((block) => !preserveBlock(block));
fs.writeFileSync(targetPath, render([...kept, ...preserved]));
NODE
  if [ -f "$DEEPCODEX_REGISTRATION_SYNC" ]; then
    "$NODE_BIN" "$DEEPCODEX_REGISTRATION_SYNC" "$CODEX_HOME_DIR/config.toml" "$PREVIOUS_CONFIG_FILE" "$GLOBAL_CODEX_HOME/config.toml" >/dev/null 2>&1 || true
  fi
  rm -f "$PREVIOUS_CONFIG_FILE"
fi

# deepcodex should not start the DeepSeek code worker MCP by default.
# Users can still enable it manually in their own Codex environment, but this
# local patch keeps deepcodex startup lean and avoids unnecessary Downloads
# access prompts from that MCP path.
"$NODE_BIN" - "$CODEX_HOME_DIR/config.toml" <<'NODE'
const fs = require("fs");
const [configPath] = process.argv.slice(2);
let text = fs.readFileSync(configPath, "utf8");
const blockRe = /(\[mcp_servers\.deepseek-code-worker\][\s\S]*?enabled\s*=\s*)(true|false)/;
if (blockRe.test(text)) {
  text = text.replace(blockRe, "$1false");
  fs.writeFileSync(configPath, text);
}
NODE

sync_global_rules

echo "Launching deepcodex through adaptive translator."
echo "  Codex base: $TRANSLATOR_URL"
echo "  upstream:   ${UPSTREAM_URL:-https://api.deepseek.com/v1}"
echo "  CODEX_HOME: $CODEX_HOME_DIR"
if [ -n "$DEEPCODEX_WORKSPACE" ]; then
  mkdir -p "$DEEPCODEX_WORKSPACE"
  trust_workspace "$DEEPCODEX_WORKSPACE"
  echo "  workspace:  $DEEPCODEX_WORKSPACE"
  exec env CODEX_HOME="$CODEX_HOME_DIR" "$CODEX_BIN" --user-data-dir="$ELECTRON_USER_DATA" "$DEEPCODEX_WORKSPACE"
else
  echo "  workspace:  <Codex default>"
  exec env CODEX_HOME="$CODEX_HOME_DIR" "$CODEX_BIN" --user-data-dir="$ELECTRON_USER_DATA"
fi
