#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ROOT = Split-Path -Parent $PSScriptRoot
$STATE_ROOT = if ($env:DEEPCODEX_STATE_ROOT) { $env:DEEPCODEX_STATE_ROOT } else { Join-Path $env:APPDATA "deepcodex" }
$NODE_BIN_FILE = Join-Path $STATE_ROOT "node-bin.txt"
$NODE_BIN = if (Test-Path -LiteralPath $NODE_BIN_FILE) { (Get-Content -Raw -LiteralPath $NODE_BIN_FILE).Trim() } else { "node" }
$PORT = if ($env:DEEPCODEX_CDP_PORT) { [int]$env:DEEPCODEX_CDP_PORT } else { 58317 }
$INJECTOR = Join-Path $ROOT "scripts\deepcodex-cdp-inject.mjs"
$UNLOCK_SCRIPT = Join-Path $ROOT "scripts\deepcodex-plugin-unlock-inject.js"
$START_SCRIPT = Join-Path $ROOT "scripts\start-deepcodex.ps1"

function Test-PortOpen([int]$Port) {
    try {
        $client = New-Object Net.Sockets.TcpClient
        $iar = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(500, $false)) {
            $client.Close()
            return $false
        }
        $client.EndConnect($iar)
        $client.Close()
        return $true
    } catch {
        return $false
    }
}

if (Test-PortOpen $PORT) {
    & $NODE_BIN $INJECTOR "$PORT" $UNLOCK_SCRIPT
    exit $LASTEXITCODE
}

$env:DEEPCODEX_PLUGIN_UNLOCK = "1"
& $START_SCRIPT
