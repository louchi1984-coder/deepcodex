---
name: deepcodex-mac-repair
description: >-
  Repair DeepCodex on macOS when a Codex update or fresh install breaks the UI or first-setup. Use
  when, on macOS: first-setup fails with a dyld error like "DeepCodexSetup ... built for macOS 16.0
  which is newer than running OS" or "Symbol not found ... Foundation"; the app won't launch on an
  older macOS or on an Intel Mac; the icon/branding/language is wrong after a Codex update; or the
  Appearance/Settings UI is broken. Two distinct problems live here: (A) the prebuilt
  scripts/DeepCodexSetup Swift helper compiled with too-high a deployment target / arm64-only, and
  (B) the minified app.asar UI patches (scripts/brand-patched-asar.mjs) whose anchors drift per
  Codex build. This skill covers both.
---

# DeepCodex macOS repair

There are TWO separate failure classes on macOS. Identify which one first.

---

## A) First-setup dyld crash — `DeepCodexSetup` built for too-new macOS  (MOST COMMON)

**Symptom:** A native alert "首次设置失败 / First setup failed" with:
```
dyld: Symbol not found: _$sSS10FoundationE4data5using20allowLossyConversion...
Referenced from: .../DeepCodexSetup (built for macOS 16.0 which is newer than running OS)
```
or the app simply won't launch on an Intel Mac.

**Cause:** `scripts/DeepCodexSetup` is a **prebuilt** Swift binary (first-setup UI). If it was
compiled on a new macOS (Tahoe = internal version 16.0) it gets a **deployment target of 16.0**
and/or is **arm64-only**, so it crashes on macOS < 16 and on Intel. The app's
`LSMinimumSystemVersion` (12.0) is a lie when this binary requires 16.0.

**Fix — rebuild it universal with a low deployment target:**
```bash
cd <repo>
swiftc -O -target arm64-apple-macosx12.0  scripts/DeepCodexSetup.swift -o /tmp/dcs-arm64
swiftc -O -target x86_64-apple-macosx12.0 scripts/DeepCodexSetup.swift -o /tmp/dcs-x86_64
lipo -create /tmp/dcs-arm64 /tmp/dcs-x86_64 -o scripts/DeepCodexSetup
chmod +x scripts/DeepCodexSetup
```
**Verify before shipping:**
```bash
lipo -info scripts/DeepCodexSetup            # must be: x86_64 arm64
vtool -show-build scripts/DeepCodexSetup     # minos must be 12.0, NOT 16.0  (for both slices)
```
The crashing symbol (`String.data(using:allowLossyConversion:)`) is an old API (macOS 10+); the
only reason it bound to a 16.0-only symbol was the 16.0 deployment target. Lowering the target to
12.0 binds it to the symbol available on macOS 12+.

> Also confirm the launcher is fine: `scripts/install-deepcodex-app.sh` compiles
> `CodexDeepSeekLauncher` with clang `-mmacosx-version-min=12.0 -arch arm64 -arch x86_64` (already
> universal/12.0). If you change the min, change it there too.

**Rebuild the dmg + verify the bundled binaries:**
```bash
DEEPCODEX_VERSION="$(date +%Y.%m.%d)-macos12-fix" bash scripts/build-macos-dmg.sh
# mount the produced dmg, then:
vtool -show-build "<DeepCodex.app>/Contents/Resources/runtime/scripts/DeepCodexSetup"   # minos 12.0
lipo -info       "<DeepCodex.app>/Contents/Resources/runtime/scripts/DeepCodexSetup"    # x86_64 arm64
```

---

## B) Minified app.asar UI patches drifted (icon / branding / language / appearance / auth)

DeepCodex copies Codex into a patched app under `<DeepCodex.app>/Contents/Resources/runtime/...`
and **string-patches the copy's `app.asar`** via **`scripts/brand-patched-asar.mjs`** — the same
patcher used on Windows. Each patch finds a **minified** string and does an **equal-length,
space-padded** replacement. Minified anchors change on **every Codex build**; a non-matching anchor
is **silently skipped** (unless its name is in `criticalPatchNames`), so install "succeeds" while
the feature is broken.

**Symptom -> patch name** (these apply on macOS; the win32-only ones — `browser-window-icon`,
`app-user-model-id`, `windows-close`, `profile-dropdown-settings` — do not):
| Symptom | Patch name |
|---|---|
| Stuck in English / won't switch | `locale-info`, `default-locale`, `enable-i18n`, `i18n-loading-gate` |
| Appearance panel empty/broken | `appearance-settings`, `general-appearance-settings` |
| Login/onboarding gate blocks use | `auth-requirement`, `onboarding-gate` |
| Settings won't save / theme not applied | `config-write` |
| App/window name shows "Codex" | `session-title` |

`criticalPatchNames` (loud-fail if skipped): `locale-info`, `config-write`, `default-locale`,
`enable-i18n`, `auth-requirement`, `appearance-settings`.

**Diagnose:**
- Check the patcher report log under `~/Library/Application Support/deepcodex/` for
  `{written, skipped}`.
- Grep the patched asar — **`?`, `{`, `}`, `(`, `)` are regex metacharacters that cause FALSE
  NEGATIVES**; use `grep -aF` or `grep -ao '.\{20\}KEYWORD.\{40\}'` to see the real current string.

**Repair an anchor:** in `scripts/brand-patched-asar.mjs`, find the patch's `find*` + `patch*`, get
the real current string from the live asar, and **re-anchor with a regex** that locks the stable
literal and wildcards the minified parts (variable `([\w$]+)`, nested-paren args
`\((?:[^()]|\([^()]*\))*\)`). **Replacement must be <= matched length** (space-padded). Keep an
"already patched?" short-circuit.

**Rebuild + verify on a temp copy — never on a running install** (a running app locks the asar):
```bash
cp "<patched app.asar>" /tmp/app.asar && node scripts/brand-patched-asar.mjs /tmp/app.asar
# grep /tmp/app.asar to confirm; then DEEPCODEX_VERSION=... bash scripts/build-macos-dmg.sh
```

---

## macOS gotchas
- The `LSMinimumSystemVersion` in the app Info.plist (12.0) does NOT guarantee the app runs on 12.0
  — a bundled binary (`DeepCodexSetup`) with a higher deployment target overrides it. Always check
  the binaries with `vtool -show-build` / `lipo -info`, not just the plist.
- Ship **universal** (x86_64 + arm64); a Tahoe build machine defaults to arm64-only + min 16.0.
- Don't test-install while DeepCodex/Codex is running (file locks). Verify patches on a temp asar
  copy.
- "Reconnecting 1-5/5" reconnect noise is Codex's own client behavior (official Codex too); the
  translator is HTTP-only by design — not a macOS bug to fix here.
- Re-check both A and B after **every** Codex auto-update.
