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
    $codexBinRoot = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin"
    if (Test-Path -LiteralPath $codexBinRoot) {
        $candidate = Get-ChildItem -LiteralPath $codexBinRoot -Recurse -Filter node.exe -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending | Select-Object -First 1
        if ($candidate) { return $candidate.FullName }
    }
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
    return @(Get-BlockingInstallTargetProcesses -InstallRoot $InstallRoot).Count -gt 0
}

function Test-IsDeepCodexTranslatorProcess {
    param($Process, [string]$InstallRoot)
    if (-not $Process) { return $false }
    if ($Process.Name -ne "node.exe" -and $Process.Name -ne "deepcodex-translator.exe") { return $false }
    $commandLine = if ($Process.CommandLine) { [string]$Process.CommandLine } else { "" }
    $exePath = if ($Process.ExecutablePath) { [string]$Process.ExecutablePath } else { "" }
    if ($commandLine -like "*adaptive-server.mjs*" -and $commandLine -like "*$InstallRoot*") { return $true }
    if ($Process.Name -eq "deepcodex-translator.exe" -and $exePath -like "$InstallRoot*") { return $true }
    return $false
}

function Stop-StaleDeepCodexTranslator {
    param([string]$InstallRoot)
    try {
        Get-CimInstance Win32_Process -ErrorAction Stop |
            Where-Object { Test-IsDeepCodexTranslatorProcess $_ $InstallRoot } |
            ForEach-Object {
                Write-Host "Stopping stale DeepCodex translator pid=$($_.ProcessId)"
                Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            }
    } catch {}
}

function Get-LoopbackPortOwnerProcesses {
    param([int]$Port)
    $pids = @()
    try {
        $pids = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
            Select-Object -ExpandProperty OwningProcess -Unique)
    } catch {
        try {
            $lines = @(netstat -ano -p tcp | Select-String -Pattern (":$Port\s"))
            foreach ($line in $lines) {
                $parts = ($line.ToString().Trim() -split "\\s+")
                if ($parts.Count -ge 5 -and $parts[3] -eq "LISTENING") { $pids += [int]$parts[4] }
            }
            $pids = @($pids | Select-Object -Unique)
        } catch {
            $pids = @()
        }
    }
    foreach ($ownerPid in $pids) {
        try {
            Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid" -ErrorAction Stop
        } catch {}
    }
}

function Stop-DeepCodexTranslatorOnPort {
    param([int]$Port, [string]$InstallRoot)
    foreach ($proc in @(Get-LoopbackPortOwnerProcesses $Port)) {
        if (Test-IsDeepCodexTranslatorProcess $proc $InstallRoot) {
            Write-Host "Stopping stale DeepCodex translator on port $Port pid=$($proc.ProcessId)"
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
}

function Get-InstallTargetProcesses {
    param([string]$InstallRoot)
    if (-not (Test-Path -LiteralPath $InstallRoot)) { return @() }
    $resolved = (Resolve-Path -LiteralPath $InstallRoot).Path
    $escaped = [WildcardPattern]::Escape($resolved)
    try {
        Get-CimInstance Win32_Process -ErrorAction Stop |
            Where-Object {
                [int]$_.ProcessId -ne $PID -and
                (
                    ($_.ExecutablePath -and $_.ExecutablePath -like "$escaped*") -or
                    ($_.CommandLine -and $_.CommandLine -like "*$resolved*")
                )
            }
    } catch {
        @()
    }
}

function Get-BlockingInstallTargetProcesses {
    param([string]$InstallRoot)
    Get-InstallTargetProcesses -InstallRoot $InstallRoot |
        Where-Object { -not (Test-IsDeepCodexTranslatorProcess $_ $InstallRoot) }
}

function Stop-InstallTargetProcesses {
    param([string]$InstallRoot)
    $processes = @(Get-BlockingInstallTargetProcesses -InstallRoot $InstallRoot)
    foreach ($proc in $processes) {
        try {
            Write-Host "Stopping running DeepCodex process pid=$($proc.ProcessId) name=$($proc.Name)"
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
        } catch {}
    }

    if ($processes.Count -gt 0) {
        Start-Sleep -Milliseconds 800
    }
}

function Copy-DirectoryWithRobocopy {
    param([string]$Source, [string]$Destination)
    if (-not (Get-Command robocopy.exe -ErrorAction SilentlyContinue)) {
        Copy-Item -Path (Join-Path $Source "*") -Destination $Destination -Recurse -Force
        return
    }

    & robocopy.exe $Source $Destination /E /R:1 /W:1 /NFL /NDL /NP /NJH /NJS | Out-Null
    $exitCode = $LASTEXITCODE
    if ($exitCode -ge 8) {
        throw "robocopy failed with exit code $exitCode while copying $Source to $Destination"
    }
}

function Copy-CodexAppForPatch {
    param([string]$CodexBin, [string]$InstallRoot)
    $sourceAppRoot = Split-Path -Parent $CodexBin
    $targetAppRoot = Join-Path $InstallRoot "codex-patched-app"
    $patchOkMarker = Join-Path $InstallRoot "codex-patched-app.ok"
    if (-not (Test-Path -LiteralPath (Join-Path $sourceAppRoot "resources\app.asar"))) {
        Write-Warning "Codex app.asar was not found under $sourceAppRoot; DeepCodex will launch the original Codex host."
        return $null
    }

    Remove-Item -LiteralPath $patchOkMarker -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $targetAppRoot) {
        Remove-Item -LiteralPath $targetAppRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Path $targetAppRoot -Force | Out-Null
    Copy-DirectoryWithRobocopy -Source $sourceAppRoot -Destination $targetAppRoot

    $asar = Join-Path $targetAppRoot "resources\app.asar"
    $exe = Join-Path $targetAppRoot "Codex.exe"
    if (-not ((Test-Path -LiteralPath $exe) -and (Test-Path -LiteralPath $asar))) {
        Remove-Item -LiteralPath $targetAppRoot -Recurse -Force -ErrorAction SilentlyContinue
        throw "Copied Codex host is incomplete. Missing Codex.exe or resources\app.asar under $targetAppRoot"
    }

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
                Write-Warning "Could not patch Codex branding in app.asar. See $brandLog. Keeping the local Codex host copy."
            }
        } catch {
            if ($previousErrorActionPreference) { $ErrorActionPreference = $previousErrorActionPreference }
            Write-Warning "Could not patch Codex branding in app.asar: $($_.Exception.Message). Keeping the local Codex host copy."
        }
    }

    $icon = Join-Path $runtimeDir "assets\deepcodex.ico"
    $resourceIcon = Join-Path $targetAppRoot "resources\icon.ico"
    if ((Test-Path -LiteralPath $icon) -and (Test-Path -LiteralPath (Split-Path -Parent $resourceIcon))) {
        Copy-Item -LiteralPath $icon -Destination $resourceIcon -Force
    }
    # The browser-window-icon asar patch sets BrowserWindow icon to the relative path
    # `icon.ico`, which Electron resolves against the process working dir (the app root
    # next to Codex.exe). Without a copy here the running window/taskbar icon is not found.
    $appRootIcon = Join-Path $targetAppRoot "icon.ico"
    if ((Test-Path -LiteralPath $icon) -and (Test-Path -LiteralPath $targetAppRoot)) {
        Copy-Item -LiteralPath $icon -Destination $appRootIcon -Force
    }
    if ((Test-Path -LiteralPath $icon) -and (Test-Path -LiteralPath $exe) -and (Test-Path -LiteralPath $PATCH_EXE_ICON_SCRIPT)) {
        try {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PATCH_EXE_ICON_SCRIPT -ExePath $exe -IconPath $icon | Out-Null
        } catch {
            Write-Warning "Could not patch Codex.exe icon resource: $($_.Exception.Message)"
        }
    }
    # Refresh the Windows icon cache so the patched taskbar/window icon shows immediately.
    try { & ie4uinit.exe -show | Out-Null } catch {}
    "ok" | Set-Content -LiteralPath $patchOkMarker -Encoding ASCII -NoNewline
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

Stop-InstallTargetProcesses -InstallRoot $InstallTarget

if (Test-InstallTargetInUse -InstallRoot $InstallTarget) {
    throw "DeepCodex is still running from $InstallTarget. Close DeepCodex first, then run install-windows.bat again."
}

Stop-StaleDeepCodexTranslator -InstallRoot $InstallTarget
Stop-DeepCodexTranslatorOnPort -Port 8282 -InstallRoot $InstallTarget

foreach ($dir in @("scripts", "translator", "assets")) {
    $src = Join-Path $ROOT $dir
    $dst = Join-Path $runtimeDir $dir
    if (Test-Path -LiteralPath $src) {
        New-Item -ItemType Directory -Path $dst -Force | Out-Null
        Copy-Item -Path (Join-Path $src "*") -Destination $dst -Recurse -Force
    }
}

$codexHomeSrc = Join-Path $ROOT "codex-home-deepseek-app"
$codexHomeDst = Join-Path $runtimeDir "codex-home-deepseek-app"
New-Item -ItemType Directory -Path $codexHomeDst -Force | Out-Null
foreach ($file in @("config.adaptive-oneapi.toml", "deepseek-model-catalog.json")) {
    $src = Join-Path $codexHomeSrc $file
    if (Test-Path -LiteralPath $src) {
        Copy-Item -LiteralPath $src -Destination (Join-Path $codexHomeDst $file) -Force
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
