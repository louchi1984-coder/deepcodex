---
name: deepcodex-win-repair
description: >-
  Fix a broken DeepCodex UI feature on Windows IN PLACE, on the already-installed app, with no repo
  and no repackaging. Use when, after a Codex Desktop update, the DeepCodex (not official Codex)
  taskbar/window icon is wrong or missing, the Settings menu won't open, the UI is stuck in English
  / won't switch to Chinese, the Appearance panel is empty/broken, or the window/app name shows
  "Codex" instead of "DeepCodex". DeepCodex makes these UI changes by string-patching Codex's
  minified app.asar; a Codex update changes that minified code so a patch anchor stops matching and
  the feature breaks. The fix is to re-anchor the patcher that is ALREADY installed on this machine
  and re-run it on the installed app — the agent does this directly, the user needs nothing but
  this running DeepCodex install plus an agent. Core model/chat functionality is unaffected by this.
---

# Fix DeepCodex Windows UI (in place, no repo)

You are fixing the **installed** DeepCodex on this machine. Do **not** look for a git repo, do
**not** rebuild a zip. Everything you need is already installed.

## 0. Prereqs on this machine
- The installed app: `%LOCALAPPDATA%\deepcodex\`
- The patched Codex copy whose asar you will fix:
  `%LOCALAPPDATA%\deepcodex\codex-patched-app\resources\app.asar`
- The patcher (already installed): `%LOCALAPPDATA%\deepcodex\runtime\scripts\brand-patched-asar.mjs`
- `node` (DeepCodex requires it). If `node` isn't on PATH, find `node.exe` and use its full path.
- **Quit DeepCodex completely first** (right-click tray → exit). A running app locks the asar.

In Git Bash these paths are `/c/Users/<you>/AppData/Local/deepcodex/...`.

## 1. Which patch broke (symptom → patch name)
| Symptom | patch name |
|---|---|
| Taskbar/window icon wrong on the running app | `browser-window-icon` (+ `app-user-model-id`) |
| Taskbar identity / name not DeepCodex | `app-user-model-id` |
| Settings menu won't open | `profile-dropdown-settings` |
| Appearance panel empty/broken | `appearance-settings`, `general-appearance-settings` |
| Stuck in English / won't switch | `locale-info`, `default-locale`, `enable-i18n`, `i18n-loading-gate` |
| Name shows "Codex" | `session-title`, `app-user-model-id` |
| Login/onboarding blocks use | `auth-requirement`, `onboarding-gate` |
| Settings won't save / theme not applied | `config-write` |

## 2. Confirm it's a dropped anchor
Check the patch's own log first:
`%LOCALAPPDATA%\deepcodex\brand-patched-asar.log` → JSON `skipped[]` lists patches whose anchor
didn't match. The broken feature's patch is there.

Then look at the actual installed asar. **grep `?` `{` `}` `(` `)` are regex metacharacters and
give FALSE NEGATIVES** — use `grep -aF` (fixed string) or `grep -ao` with a plain keyword:
```bash
A=/c/Users/<you>/AppData/Local/deepcodex/codex-patched-app/resources/app.asar
grep -aF 'setAppUserModelId(`DeepCodex`)' "$A"          # already-patched marker present?
grep -ao '.\{20\}setAppUserModelId.\{40\}' "$A"          # the REAL current minified call
grep -ao '.\{20\}autoHideMenuBar.\{30\}' "$A"            # original icon anchor still there?
```

## 3. Re-anchor the INSTALLED patcher
Edit `%LOCALAPPDATA%\deepcodex\runtime\scripts\brand-patched-asar.mjs`. Find the broken patch's
`find*` + `patch*` functions. Use the real current string (from step 2) and **re-anchor with a
regex** that locks the stable literal and wildcards the volatile minified parts:
- variable name → `([\w$]+)`   •   call args incl. one level of nested parens → `\((?:[^()]|\([^()]*\))*\)`

Example (the AUMID anchor drifted from `n.app.setAppUserModelId(t.b(x))` to
`r.app.setAppUserModelId(n.E(S))`):
```js
const re = /process\.platform===`win32`&&([\w$]+)\.app\.setAppUserModelId\((?:[^()]|\([^()]*\))*\)/;
const m = re.exec(text);
const replacement = `${m[1]}.app.setAppUserModelId(\`DeepCodex\`)`;
return text.slice(0,m.index) + replacement + " ".repeat(m[0].length-replacement.length) + text.slice(m.index+m[0].length);
```
Rules:
- The replacement must be **<= the matched length** (the patcher space-pads to keep asar offsets;
  if longer, shorten it, e.g. drop a redundant `process.platform===\`win32\`&&` guard).
- Keep the `find*` detection regex in sync with `patch*`, and keep the "already patched?"
  short-circuit so re-running is safe.

## 4. Re-run the patcher on the installed asar
```bash
cd /c/Users/<you>/AppData/Local/deepcodex/codex-patched-app
node "/c/Users/<you>/AppData/Local/deepcodex/runtime/scripts/brand-patched-asar.mjs" \
  "resources/app.asar" "Codex.exe"
```
It re-applies all patches; already-applied ones short-circuit, your fixed one now lands. The EXE
asar-hash step just warns on this Codex build (it doesn't embed the hash as ASCII) — that's fine,
this build doesn't enforce asar integrity.

Verify it took (use `grep -aF`, not a regex):
```bash
grep -aF 'setAppUserModelId(`DeepCodex`)' resources/app.asar    # for the AUMID example
```

## 5. Refresh + relaunch
```bash
ie4uinit.exe -show          # refresh icon cache
```
Restart Explorer (or just relaunch), then open DeepCodex and check.

## Don'ts / facts
- Don't patch while DeepCodex is running (file locks → broken copy).
- Taskbar running icon = `BrowserWindow({ icon })`. The recipe is BrowserWindow `icon:\`icon.ico\``
  + keep `setAppUserModelId(\`DeepCodex\`)` + the existing `icon.ico`. `icon:\`icon.ico\`` is a
  relative path resolved against the app root, so `icon.ico` must exist next to `Codex.exe` (the
  installer puts it there and in `resources\`).
- "Reconnecting 1-5/5" / `404 ws://127.0.0.1:8282/responses` is Codex's own WebSocket-transport
  retry (official Codex shows it too as "request timed out"); it falls back to HTTP and the answer
  still comes. Not something to fix here.
- After any future Codex update, redo from step 2 — anchors can drift again.
