#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ROOT = Split-Path -Parent $PSScriptRoot
$INSTALL_ROOT = Split-Path -Parent $ROOT
$APP_ROOT = Join-Path $INSTALL_ROOT "codex-patched-app"
$RESOURCES = Join-Path $APP_ROOT "resources"
$ASAR = Join-Path $RESOURCES "app.asar"
$PENDING_ASAR = Join-Path $RESOURCES "app.asar.deepcodex-brand.pending"
$EXE = Join-Path $APP_ROOT "Codex.exe"
$OLD_HASH = "45dc179ad9fb20cc136ea0bfc224668364f6000873b38fd669f79118265b3e9e"
$NEW_HASH = "4fc363eaf7fb385bd84c291bcc7f558d6e019f5d21d095f7ba56b1d39a07e1df"

function Assert-NoPatchedCodexRunning {
    $running = Get-CimInstance Win32_Process |
        Where-Object { $_.Name -eq "Codex.exe" -and $_.CommandLine -like "*codex-patched-app*" } |
        Select-Object -First 1
    if ($running) {
        throw "DeepCodex Codex.exe is still running. Close DeepCodex first, then run this script again."
    }
}

function Replace-AsciiHash {
    param([string]$Path, [string]$Old, [string]$New)
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $oldBytes = [System.Text.Encoding]::ASCII.GetBytes($Old)
    $newBytes = [System.Text.Encoding]::ASCII.GetBytes($New)
    $index = -1
    for ($i = 0; $i -le $bytes.Length - $oldBytes.Length; $i++) {
        $match = $true
        for ($j = 0; $j -lt $oldBytes.Length; $j++) {
            if ($bytes[$i + $j] -ne $oldBytes[$j]) { $match = $false; break }
        }
        if ($match) { $index = $i; break }
    }
    if ($index -lt 0) {
        if ([Text.Encoding]::ASCII.GetString($bytes).Contains($New)) { return "already-patched" }
        throw "Could not find old ASAR header hash in Codex.exe."
    }
    [Array]::Copy($newBytes, 0, $bytes, $index, $newBytes.Length)
    Copy-Item -LiteralPath $Path -Destination "$Path.before-deepcodex-brand.bak" -Force
    [System.IO.File]::WriteAllBytes($Path, $bytes)
    return "patched"
}

Assert-NoPatchedCodexRunning
if (-not (Test-Path -LiteralPath $PENDING_ASAR)) { throw "Pending branded ASAR not found: $PENDING_ASAR" }
Copy-Item -LiteralPath $ASAR -Destination "$ASAR.before-apply-deepcodex-brand.bak" -Force
Copy-Item -LiteralPath $PENDING_ASAR -Destination $ASAR -Force
$exeResult = Replace-AsciiHash -Path $EXE -Old $OLD_HASH -New $NEW_HASH
Write-Host "DeepCodex brand patch applied. exe=$exeResult"
