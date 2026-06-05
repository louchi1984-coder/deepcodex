---
name: deepcodex-mac-repair
description: >-
  Fix a broken DeepCodex UI feature on macOS IN PLACE, on the already-installed app, with no repo
  and no repackaging. Use when, after a Codex Desktop update, the DeepCodex (not official Codex) UI
  breaks: stuck in English / won't switch to Chinese, Appearance panel empty/broken, app/window name
  shows "Codex" instead of "DeepCodex", or the login/onboarding gate blocks use. DeepCodex makes
  these changes by string-patching Codex's minified app.asar; a Codex update changes that minified
  code so a patch anchor stops matching and the feature breaks. The fix is to re-anchor the patcher
  ALREADY installed inside DeepCodex.app and re-run it on the installed app — the agent does it
  directly. (Separately: a "First setup failed / built for macOS 16.0" dyld crash is NOT fixable in
  place — see the last section.) Core model/chat functionality is unaffected by UI breakage.
---

# Fix DeepCodex macOS UI (in place, no repo)

You are fixing the **installed** `/Applications/DeepCodex.app` on this machine. Do **not** look for
a git repo or rebuild a dmg. **Quit DeepCodex first** (a running app locks the files).

## 0. Locate the installed pieces
```bash
# the patched Codex asar (location varies by version — find it):
find ~/Library/Application\ Support/deepcodex "/Applications/DeepCodex.app" -name app.asar 2>/dev/null
# the patcher, already installed:
ls "/Applications/DeepCodex.app/Contents/Resources/runtime/scripts/brand-patched-asar.mjs"
```
You also need `node` (DeepCodex bundles/uses it; use system `node` or the one under the app runtime).

## 1. Which patch broke (symptom → patch name)
These asar patches apply on macOS (the win32-only ones — `browser-window-icon`,
`app-user-model-id`, `windows-close`, `profile-dropdown-settings` — do not):
| Symptom | patch name |
|---|---|
| Stuck in English / won't switch | `locale-info`, `default-locale`, `enable-i18n`, `i18n-loading-gate` |
| Appearance panel empty/broken | `appearance-settings`, `general-appearance-settings` |
| App/window name shows "Codex" | `session-title` |
| Login/onboarding blocks use | `auth-requirement`, `onboarding-gate` |
| Settings won't save / theme not applied | `config-write` |

## 2. Confirm it's a dropped anchor
Check the patch log under `~/Library/Application Support/deepcodex/` (a `brand-patched-asar*.log`
with JSON `skipped[]`). Then look at the installed asar — **grep `?` `{` `}` `(` `)` are regex
metacharacters that give FALSE NEGATIVES**; use `grep -aF` or `grep -ao '.\{20\}KEYWORD.\{40\}'`:
```bash
A="<app.asar path from step 0>"
grep -ao '.\{20\}"locale-info".\{60\}' "$A"     # see the real current minified code near the API
```

## 3. Re-anchor the INSTALLED patcher
Edit `/Applications/DeepCodex.app/Contents/Resources/runtime/scripts/brand-patched-asar.mjs`. Find
the broken patch's `find*` + `patch*`, take the real current string from step 2, and **re-anchor
with a regex** that locks the stable literal (e.g. the quoted handler name `"locale-info"`) and
wildcards the volatile minified parts:
- variable name → `([\w$]+)`   •   call args incl. nested parens → `\((?:[^()]|\([^()]*\))*\)`

The replacement must be **<= the matched length** (the patcher space-pads to keep asar offsets).
Keep the `find*` regex in sync and keep the "already patched?" short-circuit.

## 4. Re-run the patcher on the installed asar
```bash
node "/Applications/DeepCodex.app/Contents/Resources/runtime/scripts/brand-patched-asar.mjs" "<app.asar path>"
```
Already-applied patches short-circuit; your fixed one now lands. Verify with `grep -aF` for the
patched marker. Then relaunch DeepCodex and check.

## NOT fixable in place: "First setup failed / built for macOS 16.0" dyld crash
If first-setup shows `DeepCodexSetup ... built for macOS 16.0 which is newer than running OS` or a
`Symbol not found ... Foundation` dyld error, that is a **build problem in the shipped binary**
(`DeepCodexSetup` compiled with too-high a deployment target / arm64-only). The installed app does
**not** ship the Swift source, so you cannot recompile it here.
**Fix for the user: download the latest release dmg**, which ships `DeepCodexSetup` rebuilt
universal (x86_64 + arm64) with deployment target macOS 12.0:
`https://github.com/louchi1984-coder/deepcodex/releases` → `deepcodex-macos-*-macos12-fix.dmg`.

## Facts
- Don't patch while DeepCodex/Codex is running (file locks).
- The app's `LSMinimumSystemVersion` (12.0) can be a lie if a bundled binary has a higher target —
  that's the dyld case above, which needs a fresh release, not an in-place asar edit.
- "Reconnecting 1-5/5" reconnect noise is Codex's own client behavior (official Codex too); the
  HTTP path still completes. Not a bug to fix here.
- After any future Codex update, redo from step 2 — anchors can drift again.
