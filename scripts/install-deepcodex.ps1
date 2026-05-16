#Requires -Version 5.1
param(
    [string]$InstallTarget = (Join-Path $env:LOCALAPPDATA "deepcodex"),
    [string]$CodexExe = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ROOT = Split-Path -Parent $PSScriptRoot
$LAUNCHER_SRC = Join-Path $ROOT "src\deepcodex-launcher-win.cs"
$PREBUILT_LAUNCHER = Join-Path $ROOT "build\DeepCodex.exe"
$BRAND_ASAR_SCRIPT = Join-Path $ROOT "scripts\brand-patched-asar.mjs"
$PATCH_EXE_ICON_SCRIPT = Join-Path $ROOT "scripts\patch-exe-icon.ps1"

function Find-NodeBin {
    if ($env:NODE_BIN -and (Test-Path -LiteralPath $env:NODE_BIN)) { return $env:NODE_BIN }
    $found = Get-Command "node.exe" -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
    $codexNode = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin\node.exe"
    if (Test-Path -LiteralPath $codexNode) { return $codexNode }
    return $null
}

function Find-CodexBin {
    if ($CodexExe -and (Test-Path -LiteralPath $CodexExe)) { return $CodexExe }
    if ($env:CODEX_BIN -and (Test-Path -LiteralPath $env:CODEX_BIN)) { return $env:CODEX_BIN }
    foreach ($name in @("OpenAI.Codex", "OpenAI.Codex_8wekyb3d8bbwe")) {
        try {
            $pkg = Get-AppxPackage -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($pkg) {
                foreach ($rel in @("app\Codex.exe", "Codex.exe")) {
                    $candidate = Join-Path $pkg.InstallLocation $rel
                    if (Test-Path -LiteralPath $candidate) { return $candidate }
                }
            }
        } catch {}
    }
    foreach ($candidate in @(
        (Join-Path $env:LOCALAPPDATA "OpenAI\Codex\app\Codex.exe"),
        (Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin\codex.exe"),
        (Join-Path $env:PROGRAMFILES "OpenAI\Codex\app\Codex.exe")
    )) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    $found = Get-Command "Codex.exe" -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
    $found = Get-Command "codex.exe" -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
    return $null
}

function Find-CSharpCompiler {
    $found = Get-Command "csc.exe" -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
    foreach ($candidate in @(
        (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
        (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
    )) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return $null
}

function Test-InstallTargetInUse {
    param([string]$InstallRoot)
    if (-not (Test-Path -LiteralPath $InstallRoot)) { return $false }
    $resolved = (Resolve-Path -LiteralPath $InstallRoot).Path
    $escaped = [WildcardPattern]::Escape($resolved)
    try {
        $matches = Get-CimInstance Win32_Process -ErrorAction Stop |
            Where-Object {
                ($_.ExecutablePath -and $_.ExecutablePath -like "$escaped*") -or
                ($_.CommandLine -and $_.CommandLine -like "*$resolved*")
            } |
            Where-Object { [int]$_.ProcessId -ne $PID }
        return @($matches).Count -gt 0
    } catch {
        return $false
    }
}

function Copy-CodexAppForPatch {
    param([string]$CodexBin, [string]$InstallRoot)
    $sourceAppRoot = Split-Path -Parent $CodexBin
    $targetAppRoot = Join-Path $InstallRoot "codex-patched-app"
    if (-not (Test-Path -LiteralPath (Join-Path $sourceAppRoot "resources\app.asar"))) {
        Write-Warning "Codex app.asar was not found under $sourceAppRoot; DeepCodex will launch the original Codex host."
        return $null
    }

    if (Test-Path -LiteralPath $targetAppRoot) {
        Remove-Item -LiteralPath $targetAppRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Path $targetAppRoot -Force | Out-Null
    Copy-Item -Path (Join-Path $sourceAppRoot "*") -Destination $targetAppRoot -Recurse -Force

    $asar = Join-Path $targetAppRoot "resources\app.asar"
    $exe = Join-Path $targetAppRoot "Codex.exe"
    if ((Test-Path -LiteralPath $BRAND_ASAR_SCRIPT) -and (Test-Path -LiteralPath $asar)) {
        $previousErrorActionPreference = $ErrorActionPreference
        try {
            $brandLog = Join-Path $InstallRoot "brand-patched-asar.log"
            $brandErr = Join-Path $InstallRoot "brand-patched-asar.err.log"
            $ErrorActionPreference = "Continue"
            & $NODE_BIN $BRAND_ASAR_SCRIPT $asar $exe > $brandLog 2> $brandErr
            $brandExitCode = $LASTEXITCODE
            $ErrorActionPreference = $previousErrorActionPreference
            if ($brandExitCode -ne 0) {
                Write-Warning "Could not patch Codex branding in app.asar. See $brandLog"
            }
        } catch {
            if ($previousErrorActionPreference) { $ErrorActionPreference = $previousErrorActionPreference }
            Write-Warning "Could not patch Codex branding in app.asar: $($_.Exception.Message)"
        }
    }

    $icon = Join-Path $runtimeDir "assets\deepcodex.ico"
    $resourceIcon = Join-Path $targetAppRoot "resources\icon.ico"
    if ((Test-Path -LiteralPath $icon) -and (Test-Path -LiteralPath (Split-Path -Parent $resourceIcon))) {
        Copy-Item -LiteralPath $icon -Destination $resourceIcon -Force
    }
    if ((Test-Path -LiteralPath $icon) -and (Test-Path -LiteralPath $exe) -and (Test-Path -LiteralPath $PATCH_EXE_ICON_SCRIPT)) {
        try {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PATCH_EXE_ICON_SCRIPT -ExePath $exe -IconPath $icon | Out-Null
        } catch {
            Write-Warning "Could not patch Codex.exe icon resource: $($_.Exception.Message)"
        }
    }
    return $targetAppRoot
}

function Clear-DeepCodexPatchBackups {
    param([string]$TargetAppRoot)
    if (-not (Test-Path -LiteralPath $TargetAppRoot)) { return }
    Get-ChildItem -LiteralPath $TargetAppRoot -Recurse -Force -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "*.bak" -or $_.Name -like "*.pending" } |
        Remove-Item -Force -ErrorAction SilentlyContinue
}

$NODE_BIN = Find-NodeBin
if (-not $NODE_BIN) {
    throw "Node.js was not found. Install Node.js or set NODE_BIN."
}

$CODEX_BIN = Find-CodexBin
if (-not $CODEX_BIN) {
    throw "Codex Desktop was not found. Install Codex first, or pass -CodexExe / set CODEX_BIN."
}

$runtimeDir = Join-Path $InstallTarget "runtime"
New-Item -ItemType Directory -Path $InstallTarget -Force | Out-Null
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null

if (Test-InstallTargetInUse -InstallRoot $InstallTarget) {
    throw "DeepCodex is currently running from $InstallTarget. Close DeepCodex first, then run install-windows.bat again."
}

foreach ($dir in @("scripts", "translator", "assets", "codex-home-deepseek-app")) {
    $src = Join-Path $ROOT $dir
    $dst = Join-Path $runtimeDir $dir
    if (Test-Path -LiteralPath $src) {
        New-Item -ItemType Directory -Path $dst -Force | Out-Null
        Copy-Item -Path (Join-Path $src "*") -Destination $dst -Recurse -Force
    }
}

Remove-Item -LiteralPath (Join-Path $runtimeDir "translator\tests") -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $runtimeDir "scripts\__pycache__") -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $runtimeDir "translator\tools\__pycache__") -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $runtimeDir "scripts\install-deepcodex-app.sh") -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $runtimeDir "scripts\DeepCodexSetup.swift") -Force -ErrorAction SilentlyContinue

$CODEX_BIN | Set-Content -LiteralPath (Join-Path $InstallTarget "codex-bin.txt") -Encoding utf8 -NoNewline

$patchedAppRoot = Copy-CodexAppForPatch -CodexBin $CODEX_BIN -InstallRoot $InstallTarget
if ($patchedAppRoot) {
    Clear-DeepCodexPatchBackups -TargetAppRoot $patchedAppRoot
}

$launcherExe = Join-Path $InstallTarget "DeepCodex.exe"
$launcherIcon = Join-Path $runtimeDir "assets\deepcodex.ico"
if (-not (Test-Path -LiteralPath $LAUNCHER_SRC)) {
    throw "Windows launcher source was not found: $LAUNCHER_SRC"
}
$csc = Find-CSharpCompiler
if ($csc) {
    if (Test-Path -LiteralPath $launcherIcon) {
        & $csc /nologo /target:winexe /out:$launcherExe /win32icon:$launcherIcon /reference:System.Windows.Forms.dll $LAUNCHER_SRC
    } else {
        & $csc /nologo /target:winexe /out:$launcherExe /reference:System.Windows.Forms.dll $LAUNCHER_SRC
    }
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $launcherExe)) {
        throw "Failed to compile DeepCodex.exe."
    }
} elseif (Test-Path -LiteralPath $PREBUILT_LAUNCHER) {
    Copy-Item -LiteralPath $PREBUILT_LAUNCHER -Destination $launcherExe -Force
} else {
    throw "C# compiler csc.exe was not found and build\DeepCodex.exe is missing."
}

$startScript = Join-Path $runtimeDir "scripts\start-deepcodex.ps1"
function New-DeepCodexShortcut {
    param([string]$ShortcutPath)
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($ShortcutPath)
    $shortcut.TargetPath = $launcherExe
    $shortcut.Arguments = ""
    $shortcut.WorkingDirectory = $InstallTarget
    $shortcut.Description = "DeepCodex - Codex Desktop + DeepSeek"
    if (Test-Path -LiteralPath $launcherIcon) {
        $shortcut.IconLocation = "$launcherIcon,0"
    }
    $shortcut.Save()
}

$desktop = [Environment]::GetFolderPath("Desktop")
if ($desktop) {
    New-DeepCodexShortcut (Join-Path $desktop "DeepCodex.lnk")
}
$startMenuDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\DeepCodex"
New-Item -ItemType Directory -Path $startMenuDir -Force | Out-Null
New-DeepCodexShortcut (Join-Path $startMenuDir "DeepCodex.lnk")

Write-Host "DeepCodex installed."
Write-Host "  Launcher:$launcherExe"
Write-Host "  Runtime: $runtimeDir"
Write-Host "  Codex:   $CODEX_BIN"
if ($patchedAppRoot) {
    Write-Host "  Patched: $patchedAppRoot"
} else {
    Write-Host "  Patched: not available; using original Codex host"
}
Write-Host "Launch DeepCodex.exe, or use the Desktop / Start Menu shortcut."
