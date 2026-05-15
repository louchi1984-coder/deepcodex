# DeepCodex Windows

DeepCodex for Windows is a small installer plus runtime patch. It reuses the user's installed Codex Desktop and generates a local patched copy under `%LOCALAPPDATA%\deepcodex`.

## Requirements

- Codex Desktop for Windows
- Node.js available as `node.exe`
- A DeepSeek API key

## Install

From the repository or release package root, double-click:

```text
install-windows.bat
```

Or run PowerShell manually:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\scripts\install-deepcodex.ps1
```

The installer copies the DeepCodex runtime to:

```text
%LOCALAPPDATA%\deepcodex\runtime
```

It also creates:

- Launcher: `%LOCALAPPDATA%\deepcodex\DeepCodex.exe`
- Desktop shortcut: `DeepCodex.lnk`
- Start Menu shortcut: `DeepCodex\DeepCodex.lnk`
- Patched Codex host: `%LOCALAPPDATA%\deepcodex\codex-patched-app`

If Codex is not detected automatically:

```powershell
.\scripts\install-deepcodex.ps1 -CodexExe "C:\Path\To\Codex.exe"
```

## Run Without Installing

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\scripts\start-deepcodex.ps1
```

Optional environment variables:

```powershell
$env:CODEX_BIN = "C:\Path\To\Codex.exe"
$env:NODE_BIN = "C:\Path\To\node.exe"
$env:DEEPSEEK_API_KEY = "sk-..."
$env:DEEPCODEX_WORKSPACE = "C:\Path\To\Project"
```

## Runtime Paths

```text
%APPDATA%\deepcodex\codex-home-deepseek-app
%APPDATA%\deepcodex\adaptive-translator.log
%APPDATA%\deepcodex\adaptive-translator.err.log
%APPDATA%\deepcodex\.deepcodex.env
```

## Notes

- The setup UI opens on first launch when no DeepSeek key has been saved.
- PowerShell 5.1 is supported.
- stdout and stderr logs are separate because Windows PowerShell cannot redirect both streams to the same file in `Start-Process`.
- The installed DeepCodex state is separate from the normal Codex state.
- DeepCodex sets `CODEX_ELECTRON_USER_DATA_PATH` so it can run while normal Codex is already open.
- Plugin folders, app tool caches, and plugin sidecars are synchronized from the normal `%USERPROFILE%\.codex` home on launch.
- DeepCodex opens a local Chrome DevTools Protocol port and injects a small renderer script to unlock the plugin entry and install buttons in the Codex UI.
- The official Codex installation is not modified. DeepCodex copies the Codex app into its own local patched folder.
