---
name: deepcodex-win-repair
description: >-
  Repair DeepCodex's Codex Desktop UI patches on WINDOWS when a Codex update or fresh install breaks
  them. Use when, on Windows: the taskbar/window icon is wrong or missing on the running DeepCodex
  app; the Settings menu won't open; the UI is stuck in English / won't switch to Chinese; the
  Appearance settings panel is empty/broken; the window or app name shows "Codex" instead of
  "DeepCodex"; the installer fails with "Copied Codex host is incomplete" or "old hash was not
  found"; or install seems to succeed but a UI feature is wrong. DeepCodex string-patches Codex's
  minified app.asar via scripts/brand-patched-asar.mjs, and those anchors silently stop matching
  whenever Codex changes its bundle. This skill gives the diagnose -> re-anchor -> rebuild -> verify
  workflow for the Windows package.
---

# DeepCodex Windows UI repair

## Why it breaks
Codex Desktop is a closed Electron app. DeepCodex copies it to
`%LOCALAPPDATA%\deepcodex\codex-patched-app` and **string-patches that copy's
`resources\app.asar`** (it never touches the official install). The patcher is
**`scripts/brand-patched-asar.mjs`**: each patch finds a known **minified** string and does an
**equal-length, space-padded** replacement.

Minified anchors (variable names like `n`/`r`, args like `t.b(x)`/`n.E(S)`) change on **every Codex
build**. When an anchor no longer matches, the patch is **silently skipped** (unless its name is in
`criticalPatchNames`), so the install "succeeds" while the feature is broken.

## Symptom -> patch name (patchSpecs)
| Symptom | Patch name |
|---|---|
| Taskbar / window icon wrong on running app | `browser-window-icon` (+ keep `app-user-model-id`) |
| Taskbar grouping / pinned identity not DeepCodex | `app-user-model-id` |
| Settings menu won't open | `profile-dropdown-settings` |
| Appearance panel empty/broken | `appearance-settings`, `general-appearance-settings` |
| Stuck in English / won't switch | `locale-info`, `default-locale`, `enable-i18n`, `i18n-loading-gate` |
| Name shows "Codex" not "DeepCodex" | `session-title`, `app-user-model-id` |
| Login/onboarding gate blocks use | `auth-requirement`, `onboarding-gate` |
| Settings won't save / theme not applied | `config-write` |
| App won't quit / hides to tray | `windows-close` |

`criticalPatchNames` (loud-fail if skipped): `locale-info`, `config-write`, `default-locale`,
`enable-i18n`, `auth-requirement`, `appearance-settings`. Everything else **silently skips** — that
is the dangerous set.

## Paths
- Patcher (source of truth): `scripts/brand-patched-asar.mjs`
- Installer: `scripts/install-deepcodex.ps1` ; runtime launch: `scripts/start-deepcodex.ps1`
- Patched asar: `%LOCALAPPDATA%\deepcodex\codex-patched-app\resources\app.asar`
- Patch log: `%LOCALAPPDATA%\deepcodex\brand-patched-asar.log` (+ `.err.log`)
- Source Codex (copied from): MS Store `C:\Program Files\WindowsApps\OpenAI.Codex_*\app\Codex.exe`

## Diagnose
1. Read `brand-patched-asar.log` -> JSON `{written, skipped, criticalSkipped}`. The broken
   feature's patch will be in `skipped`.
2. Confirm against the installed asar. **grep `?`, `{`, `}`, `(`, `)` are regex metacharacters and
   give FALSE NEGATIVES** — use `grep -aF` (fixed string) or `grep -ao` with a plain keyword:
   ```bash
   A=/c/Users/<u>/AppData/Local/deepcodex/codex-patched-app/resources/app.asar
   grep -aF 'setAppUserModelId(`DeepCodex`)' "$A"
   grep -ao '.\{20\}setAppUserModelId.\{40\}' "$A"   # see the ACTUAL current minified call
   grep -ao '.\{20\}autoHideMenuBar.\{30\}' "$A"
   ```

## Repair an anchor
1. Find the broken patch's `find*` + `patch*` in `scripts/brand-patched-asar.mjs`.
2. `grep -ao` the **live** asar to get the real current string (e.g. AUMID drifted from
   `n.app.setAppUserModelId(t.b(x))` to `r.app.setAppUserModelId(n.E(S))`).
3. **Re-anchor with a regex** that locks the stable literal and wildcards the volatile bits:
   - variable: `([\w$]+)`  •  call args incl. nested parens: `\((?:[^()]|\([^()]*\))*\)`
   ```js
   const re = /process\.platform===`win32`&&([\w$]+)\.app\.setAppUserModelId\((?:[^()]|\([^()]*\))*\)/;
   const m = re.exec(text);
   const replacement = `${m[1]}.app.setAppUserModelId(\`DeepCodex\`)`;
   return text.slice(0,m.index) + replacement + " ".repeat(m[0].length-replacement.length) + text.slice(m.index+m[0].length);
   ```
4. **Replacement must be <= matched length** (space-padded). If longer, shorten (e.g. drop the
   `process.platform===\`win32\`&&` guard, like existing patches).
5. Keep `find*` regex in sync, and short-circuit if already patched.

## Rebuild + verify (DO NOT test on a running install)
- A running DeepCodex **locks the asar** -> reinstalling can leave `codex-patched-app` half-copied
  and broken. **Quit DeepCodex first**, or test the patch on a temp copy:
  ```bash
  cp "$A" /tmp/app.asar && node scripts/brand-patched-asar.mjs /tmp/app.asar   # then grep /tmp/app.asar
  ```
- Package: stage from the **current repo** (NOT a stale `.build/` folder — those reuse an old
  payload), zip **flat** (one top folder, `install-windows.bat` at its root).
- Install: **fully Extract All the zip first**, then double-click `install-windows.bat`. Running the
  .bat from inside the zip preview only extracts the .bat (no `scripts/`) -> "-File ... .ps1 does
  not exist".
- After install, verify with the grep above + `brand-patched-asar.log`.

## Windows gotchas
- **Taskbar running icon = `BrowserWindow({ icon })`**, not the .exe icon resource, not AppUserModelID
  alone, not the icon cache. Working recipe: BrowserWindow `icon:\`icon.ico\`` + keep
  `setAppUserModelId(\`DeepCodex\`)` + keep the 43 KB `deepcodex.ico` + `ie4uinit.exe -show` after
  install. Don't swap the ico or touch exe icon resources.
- **`icon: \`icon.ico\`` is relative** -> resolved against the launch cwd (app root). The installer
  copies `icon.ico` to the app root AND `resources\` (`install-deepcodex.ps1`). If you see the patch
  applied but the icon still wrong, confirm `icon.ico` is at the app root.
- **EXE asar-hash patch:** MS Store Codex 26.x doesn't embed the asar hash as ASCII, so it can't be
  replaced. These builds don't enforce asar integrity, so the patcher **warns and keeps the patched
  asar** on "old hash not found" — do NOT turn it back into a throw, or fresh installs fail.
- **"Copied Codex host is incomplete"** = the copy from `WindowsApps` failed (usually because
  DeepCodex/Codex was running and locked files). Quit everything and reinstall.
- **"Reconnecting 1-5/5" / `404 ws://127.0.0.1:8282/responses`** is NOT a bug to fix here — Codex's
  own client tries a WebSocket transport and reconnects (official Codex does it too as "request
  timed out"); the translator is HTTP-only by design and the response still completes via HTTP.
- Re-run Diagnose after **every** Codex auto-update.
