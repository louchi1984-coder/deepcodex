#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ROOT = Split-Path -Parent $PSScriptRoot
$DEEPCODEX_STATE_ROOT = if ($env:DEEPCODEX_STATE_ROOT) { $env:DEEPCODEX_STATE_ROOT } else { Join-Path $env:APPDATA "deepcodex" }
$CODEX_HOME_DIR = if ($env:CODEX_HOME_DIR) { $env:CODEX_HOME_DIR } else { Join-Path $DEEPCODEX_STATE_ROOT "codex-home-deepseek-app" }
$ELECTRON_USER_DATA = if ($env:ELECTRON_USER_DATA) { $env:ELECTRON_USER_DATA } else { Join-Path $CODEX_HOME_DIR "electron-user-data-adaptive" }
$DEEPCODEX_PROJECTS_ROOT = if ($env:DEEPCODEX_PROJECTS_ROOT) { $env:DEEPCODEX_PROJECTS_ROOT } else { Join-Path ([Environment]::GetFolderPath("MyDocuments")) "deepcodex" }
$DEEPCODEX_WORKSPACE = if ($env:DEEPCODEX_WORKSPACE) { $env:DEEPCODEX_WORKSPACE } else { "" }
$TRANSLATOR_PORT = if ($env:TRANSLATOR_PORT) { [int]$env:TRANSLATOR_PORT } else { 8282 }
$TRANSLATOR_URL = if ($env:TRANSLATOR_URL) { $env:TRANSLATOR_URL } else { "http://127.0.0.1:$TRANSLATOR_PORT" }
$TRANSLATOR_LOG = if ($env:TRANSLATOR_LOG) { $env:TRANSLATOR_LOG } else { Join-Path $DEEPCODEX_STATE_ROOT "adaptive-translator.log" }
$TRANSLATOR_ERR_LOG = if ($env:TRANSLATOR_ERR_LOG) { $env:TRANSLATOR_ERR_LOG } else { Join-Path $DEEPCODEX_STATE_ROOT "adaptive-translator.err.log" }
$TRANSLATOR_START_LOG = Join-Path $DEEPCODEX_STATE_ROOT "adaptive-translator-start.log"
$DEEP_CODEX_ENV_FILE = if ($env:DEEP_CODEX_ENV_FILE) { $env:DEEP_CODEX_ENV_FILE } else { Join-Path $DEEPCODEX_STATE_ROOT ".deepcodex.env" }
$SETUP_OUT_LOG = Join-Path $DEEPCODEX_STATE_ROOT ".deepcodex-setup-last.out.log"
$SETUP_ERR_LOG = Join-Path $DEEPCODEX_STATE_ROOT ".deepcodex-setup-last.err.log"
$SETUP_UI_SCRIPT = Join-Path $ROOT "scripts\deepcodex-setup-ui.mjs"
$PROVIDER_PROFILE_PATH = if ($env:DEEPCODEX_PROVIDER_PROFILE) { $env:DEEPCODEX_PROVIDER_PROFILE } else { Join-Path $CODEX_HOME_DIR "provider-profile.json" }
$GLOBAL_CODEX_HOME = if ($env:GLOBAL_CODEX_HOME) { $env:GLOBAL_CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
$SHARED_CONFIG_SYNC = Join-Path $ROOT "scripts\sync-shared-codex-config.mjs"
$PLUGIN_HOST_SYNC = Join-Path $ROOT "scripts\sync-shared-codex-plugin-host.mjs"
$DEEPCODEX_PLUGINS_SYNC = Join-Path $ROOT "scripts\sync-deepcodex-plugins.mjs"
$DEEPCODEX_APP_TOOLS_SYNC = Join-Path $ROOT "scripts\sync-deepcodex-app-tools.mjs"
$DEEPCODEX_SIDECARS_SYNC = Join-Path $ROOT "scripts\sync-shared-codex-sidecars.mjs"
$DEEPCODEX_CDP_INJECT = Join-Path $ROOT "scripts\deepcodex-cdp-inject.mjs"
$DEEPCODEX_PLUGIN_UNLOCK_INJECT = Join-Path $ROOT "scripts\deepcodex-plugin-unlock-inject.js"
$DEEPCODEX_CDP_LOG = Join-Path $DEEPCODEX_STATE_ROOT "deepcodex-cdp-inject.log"
$DEEPCODEX_CDP_ERR_LOG = Join-Path $DEEPCODEX_STATE_ROOT "deepcodex-cdp-inject.err.log"
$DEEPCODEX_CDP_PORT = if ($env:DEEPCODEX_CDP_PORT) { [int]$env:DEEPCODEX_CDP_PORT } else { 58317 }
$DEEPCODEX_PLUGIN_UNLOCK = if ($env:DEEPCODEX_PLUGIN_UNLOCK) { $env:DEEPCODEX_PLUGIN_UNLOCK } else { "0" }
$CONFIG_TEMPLATE_PATH = if ($env:DEEPCODEX_CONFIG_TEMPLATE) { $env:DEEPCODEX_CONFIG_TEMPLATE } else { Join-Path $ROOT "codex-home-deepseek-app\config.adaptive-oneapi.toml" }
$MODEL_CATALOG_TEMPLATE_PATH = if ($env:DEEPCODEX_MODEL_CATALOG_TEMPLATE) { $env:DEEPCODEX_MODEL_CATALOG_TEMPLATE } else { Join-Path $ROOT "codex-home-deepseek-app\deepseek-model-catalog.json" }
$DEEPCODEX_DISPLAY_NAME = if ($env:DEEPCODEX_DISPLAY_NAME) { $env:DEEPCODEX_DISPLAY_NAME } else { -join ([char[]](64, 23044, 32769, 24072, 35828, 30340, 23545)) }
$LOCAL_CODEX_API_KEY = if ($env:LOCAL_CODEX_API_KEY) { $env:LOCAL_CODEX_API_KEY } else { "sk-codex-deepseek-local" }
$TRANSLATOR_PROC = $null

function Show-Alert {
    param([string]$Message)
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        [System.Windows.Forms.MessageBox]::Show($Message, "deepcodex", "OK", "Warning") | Out-Null
    } catch {
        Write-Warning $Message
    }
}

function Find-NodeBin {
    if ($env:NODE_BIN -and (Test-Path -LiteralPath $env:NODE_BIN)) { return $env:NODE_BIN }
    $found = Get-Command "node.exe" -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
    $nvmRoot = Join-Path $env:APPDATA "nvm"
    if (Test-Path -LiteralPath $nvmRoot) {
        $candidate = Get-ChildItem -LiteralPath $nvmRoot -Recurse -Filter node.exe -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending | Select-Object -First 1
        if ($candidate) { return $candidate.FullName }
    }
    return $null
}

function Ensure-TranslatorNodeBin {
    param([string]$SourceNodeBin)
    $binDir = Join-Path (Split-Path -Parent $ROOT) "bin"
    $target = Join-Path $binDir "deepcodex-translator.exe"
    try {
        New-Item -ItemType Directory -Path $binDir -Force | Out-Null
        $shouldCopy = -not (Test-Path -LiteralPath $target)
        if (-not $shouldCopy) {
            $sourceItem = Get-Item -LiteralPath $SourceNodeBin -ErrorAction Stop
            $targetItem = Get-Item -LiteralPath $target -ErrorAction Stop
            $shouldCopy = ($sourceItem.Length -ne $targetItem.Length)
        }
        if ($shouldCopy) {
            Copy-Item -LiteralPath $SourceNodeBin -Destination $target -Force
        }
        if (Test-Path -LiteralPath $target) { return $target }
    } catch {
        Write-Warning "Could not prepare deepcodex-translator.exe; falling back to node.exe."
    }
    return $SourceNodeBin
}

function Ensure-NodeCommandShims {
    param([string]$NodeBin)

    $nodeDir = Split-Path -Parent $NodeBin
    $installRoot = Split-Path -Parent $ROOT
    $shimDir = Join-Path $installRoot "shims"
    New-Item -ItemType Directory -Path $shimDir -Force | Out-Null

    foreach ($command in @("npm", "npx", "pnpm", "yarn")) {
        $shimPath = Join-Path $shimDir "$command.cmd"
        $targetPath = Join-Path $nodeDir "$command.cmd"
        $body = @"
@echo off
setlocal
if exist "$targetPath" (
  call "$targetPath" %*
) else (
  echo $command.cmd was not found next to node.exe: $nodeDir 1>&2
  exit /b 9009
)
exit /b %ERRORLEVEL%
"@
        Set-Content -LiteralPath $shimPath -Value $body -Encoding ASCII
    }

    $pathParts = @($shimDir)
    if ($env:Path) {
        $pathParts += ($env:Path -split ";" | Where-Object { $_ -and ($_ -ne $shimDir) })
    }
    $env:Path = ($pathParts -join ";")
    if (-not $env:PATHEXT -or (($env:PATHEXT -split ";") -notcontains ".CMD")) {
        $env:PATHEXT = ".COM;.EXE;.BAT;.CMD"
    }
    return $shimDir
}

function Find-CodexBin {
    if ($env:CODEX_BIN -and (Test-Path -LiteralPath $env:CODEX_BIN)) { return $env:CODEX_BIN }
    $patchedCodex = Join-Path (Split-Path -Parent $ROOT) "codex-patched-app\Codex.exe"
    if (Test-Path -LiteralPath $patchedCodex) { return $patchedCodex }
    $binTxt = Join-Path (Split-Path -Parent $ROOT) "codex-bin.txt"
    if (Test-Path -LiteralPath $binTxt) {
        $saved = (Get-Content -LiteralPath $binTxt -Raw).Trim()
        if ($saved -and (Test-Path -LiteralPath $saved)) { return $saved }
    }
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

function Read-DeepSeekKey {
    if ($env:DEEPSEEK_API_KEY) { return $env:DEEPSEEK_API_KEY.Trim() }
    if ($env:UPSTREAM_API_KEY) { return $env:UPSTREAM_API_KEY.Trim() }
    if (Test-Path -LiteralPath $DEEP_CODEX_ENV_FILE) {
        $line = Get-Content -LiteralPath $DEEP_CODEX_ENV_FILE -ErrorAction SilentlyContinue |
            Where-Object { $_ -match "^DEEPSEEK_API_KEY=(.+)$" } |
            Select-Object -First 1
        if ($line -match "^DEEPSEEK_API_KEY=(.+)$") { return $Matches[1].Trim() }
    }
    return ""
}

function Save-DeepSeekKey {
    param([string]$Key)
    New-Item -ItemType Directory -Path (Split-Path -Parent $DEEP_CODEX_ENV_FILE) -Force | Out-Null
    $lines = @()
    if (Test-Path -LiteralPath $DEEP_CODEX_ENV_FILE) {
        $lines = Get-Content -LiteralPath $DEEP_CODEX_ENV_FILE -ErrorAction SilentlyContinue
    }
    $written = $false
    $next = foreach ($line in $lines) {
        if ($line -match "^DEEPSEEK_API_KEY=") {
            if (-not $written) {
                "DEEPSEEK_API_KEY=$Key"
                $written = $true
            }
        } else {
            $line
        }
    }
    if (-not $written) { $next += "DEEPSEEK_API_KEY=$Key" }
    $next | Set-Content -LiteralPath $DEEP_CODEX_ENV_FILE -Encoding utf8
}

function Clear-DeepSeekKey {
    if (-not (Test-Path -LiteralPath $DEEP_CODEX_ENV_FILE)) { return }
    $next = Get-Content -LiteralPath $DEEP_CODEX_ENV_FILE -ErrorAction SilentlyContinue |
        Where-Object { ($_ -replace "^\uFEFF", "") -notmatch "^DEEPSEEK_API_KEY=" }
    $next | Set-Content -LiteralPath $DEEP_CODEX_ENV_FILE -Encoding utf8
}

function Test-PseudoLoginAuth {
    $authPath = Join-Path $CODEX_HOME_DIR "auth.json"
    if (-not (Test-Path -LiteralPath $authPath)) { return $false }
    try {
        $auth = Get-Content -LiteralPath $authPath -Raw -ErrorAction Stop | ConvertFrom-Json
        return ($auth.auth_mode -eq "chatgpt" -and
            $auth.tokens.access_token -and
            $auth.tokens.id_token -and
            $auth.tokens.refresh_token -eq "rt_deepcodex_local" -and
            $auth.tokens.account_id -eq "deepcodex-local-account")
    } catch {
        return $false
    }
}

function Test-TranslatorHealth {
    try {
        $response = Invoke-WebRequest -Uri "$TRANSLATOR_URL/health" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Write-TranslatorStartLog {
    param([string]$Message)
    try {
        $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        "$stamp $Message" | Add-Content -LiteralPath $TRANSLATOR_START_LOG -Encoding utf8
    } catch {}
}

function Open-SetupWindow {
    param([string]$Url)
    $setupProfile = Join-Path $DEEPCODEX_STATE_ROOT "setup-browser-profile"
    New-Item -ItemType Directory -Path $setupProfile -Force | Out-Null
    $browser = $null
    foreach ($candidate in @(
        (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
        (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe")
    )) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { $browser = $candidate; break }
    }
    if (-not $browser) { Start-Process $Url; return }
    $proc = Start-Process -FilePath $browser -ArgumentList @("--user-data-dir=$setupProfile", "--no-first-run", "--app=$Url", "--window-size=600,380", "--window-position=180,120", "--new-window") -PassThru
    Start-Sleep -Seconds 2
    Move-SetupWindow
}

function Move-SetupWindow {
    try {
        Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DeepCodexWin {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
"@ -ErrorAction SilentlyContinue
        $edgePids = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @("msedge.exe", "chrome.exe") -and $_.CommandLine -like "*setup-browser-profile*" } | Select-Object -ExpandProperty ProcessId)
        [DeepCodexWin]::EnumWindows({
            param($h, $l)
            $windowPid = 0
            [DeepCodexWin]::GetWindowThreadProcessId($h, [ref]$windowPid) | Out-Null
            if ($edgePids -contains [int]$windowPid -and [DeepCodexWin]::IsWindowVisible($h)) {
                $sb = New-Object System.Text.StringBuilder 256
                [DeepCodexWin]::GetWindowText($h, $sb, 256) | Out-Null
                if ($sb.ToString() -like "*DeepCodex Setup*") {
                    [DeepCodexWin]::SetWindowPos($h, [IntPtr]::Zero, 180, 120, 600, 380, 0x0040) | Out-Null
                }
            }
            return $true
        }, [IntPtr]::Zero) | Out-Null
    } catch {}
}

function Initialize-WindowProbe {
    try {
        Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DeepCodexWindowProbe {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
}
"@ -ErrorAction SilentlyContinue
        return $true
    } catch {
        return $false
    }
}

function Get-MainWindowHandleForProcess {
    param([int]$ProcessId)
    if (-not (Initialize-WindowProbe)) { return [IntPtr]::Zero }
    $script:deepCodexMainWindowHandle = [IntPtr]::Zero
    [DeepCodexWindowProbe]::EnumWindows({
        param($h, $l)
        $windowPid = 0
        [DeepCodexWindowProbe]::GetWindowThreadProcessId($h, [ref]$windowPid) | Out-Null
        $root = [DeepCodexWindowProbe]::GetAncestor($h, 2)
        if ([int]$windowPid -eq $ProcessId -and $root -eq $h -and [DeepCodexWindowProbe]::IsWindowVisible($h)) {
            $script:deepCodexMainWindowHandle = $h
            return $false
        }
        return $true
    }, [IntPtr]::Zero) | Out-Null
    $handle = $script:deepCodexMainWindowHandle
    Remove-Variable -Name deepCodexMainWindowHandle -Scope Script -ErrorAction SilentlyContinue
    return $handle
}

function Test-WindowHandleExists {
    param([IntPtr]$Handle)
    if ($Handle -eq [IntPtr]::Zero) { return $true }
    if (-not (Initialize-WindowProbe)) { return $true }
    return [DeepCodexWindowProbe]::IsWindow($Handle)
}

function Stop-SetupWindow {
    try {
        Get-CimInstance Win32_Process |
            Where-Object { $_.Name -in @("msedge.exe", "chrome.exe") -and $_.CommandLine -like "*setup-browser-profile*" } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    } catch {}
}

function Get-DeepCodexTranslatorProcesses {
    $installRoot = Split-Path -Parent $ROOT
    try {
        Get-CimInstance Win32_Process -ErrorAction Stop |
            Where-Object {
                ($_.Name -eq "node.exe" -or $_.Name -eq "deepcodex-translator.exe") -and
                $_.CommandLine -and
                $_.CommandLine -like "*adaptive-server.mjs*" -and
                ($_.CommandLine -like "*$ROOT*" -or $_.CommandLine -like "*$installRoot*")
            }
    } catch {
        @()
    }
}

function Stop-StaleDeepCodexTranslator {
    foreach ($proc in @(Get-DeepCodexTranslatorProcesses)) {
        try {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
        } catch {}
    }
}

function Get-DeepCodexOwnedProcesses {
    $installRoot = Split-Path -Parent $ROOT
    try {
        Get-CimInstance Win32_Process -ErrorAction Stop |
            Where-Object {
                $_.ProcessId -ne $PID -and
                $_.CommandLine -and
                (
                    $_.ExecutablePath -like "$installRoot*" -or
                    (
                        ($_.Name -eq "powershell.exe" -or $_.Name -eq "pwsh.exe") -and
                        $_.CommandLine -like "*-ExecutionPolicy Bypass*" -and
                        $_.CommandLine -like "*-WindowStyle Hidden*" -and
                        $_.CommandLine -like "*-File*" -and
                        $_.CommandLine -like "*start-deepcodex.ps1*" -and
                        $_.CommandLine -like "*$installRoot*"
                    ) -or
                    (
                        ($_.Name -eq "node.exe" -or $_.Name -eq "deepcodex-translator.exe") -and
                        $_.CommandLine -like "*adaptive-server.mjs*" -and
                        ($_.CommandLine -like "*$ROOT*" -or $_.CommandLine -like "*$installRoot*")
                    )
                )
            }
    } catch {
        @()
    }
}

function Stop-DeepCodexOwnedProcesses {
    param([int[]]$KeepProcessIds = @())
    foreach ($proc in @(Get-DeepCodexOwnedProcesses)) {
        if ($KeepProcessIds -contains [int]$proc.ProcessId) { continue }
        try {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
        } catch {}
    }
}

function Start-TranslatorProcess {
    param([string]$RuntimeBin)
    Write-TranslatorStartLog "starting translator with $RuntimeBin"
    try {
        $proc = Start-Process -FilePath $RuntimeBin `
            -ArgumentList @((Join-Path $ROOT "translator\adaptive-server.mjs")) `
            -WorkingDirectory $ROOT `
            -RedirectStandardOutput $TRANSLATOR_LOG `
            -RedirectStandardError $TRANSLATOR_ERR_LOG `
            -PassThru -WindowStyle Hidden
        Write-TranslatorStartLog "started pid=$($proc.Id)"
        return $proc
    } catch {
        Write-TranslatorStartLog "start failed with ${RuntimeBin}: $($_.Exception.Message)"
        return $null
    }
}

function Test-LoopbackPortAvailable {
    param([int]$Port)
    $listener = $null
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse("127.0.0.1"), $Port)
        $listener.Start()
        return $true
    } catch {
        return $false
    } finally {
        if ($listener) { $listener.Stop() }
    }
}

function Select-LoopbackPort {
    param([int]$Preferred)
    if (Test-LoopbackPortAvailable $Preferred) { return $Preferred }
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse("127.0.0.1"), 0)
    try {
        $listener.Start()
        return $listener.LocalEndpoint.Port
    } finally {
        $listener.Stop()
    }
}

function ConvertTo-ProcessArgument {
    param([string]$Value)
    if ($null -eq $Value) { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Invoke-NodeStdin {
    param([string[]]$Arguments, [string]$Script)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $script:NODE_BIN
    $psi.Arguments = (@("-") + $Arguments | ForEach-Object { ConvertTo-ProcessArgument $_ }) -join " "
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $p = [System.Diagnostics.Process]::Start($psi)
    $p.StandardInput.Write($Script)
    $p.StandardInput.Close()
    $stdout = $p.StandardOutput.ReadToEnd()
    $stderr = $p.StandardError.ReadToEnd()
    $p.WaitForExit()
    if ($p.ExitCode -ne 0) { throw "node failed: $stderr" }
    return $stdout
}

function Write-PseudoLoginAuth {
    New-Item -ItemType Directory -Path $CODEX_HOME_DIR -Force | Out-Null
    $authPath = Join-Path $CODEX_HOME_DIR "auth.json"
    Invoke-NodeStdin -Arguments @($authPath, $DEEPCODEX_DISPLAY_NAME) -Script @'
const fs = require("fs");
const [authPath, displayName] = process.argv.slice(2);
const b64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const fakeJwt = (payload) => `${b64url({ alg: "none", typ: "JWT" })}.${b64url(payload)}.deepcodex`;
const now = Math.floor(Date.now() / 1000);
const accountId = "deepcodex-local-account";
const userId = "deepcodex-local-user";
const profile = { email: displayName, email_verified: true, name: displayName };
fs.writeFileSync(authPath, JSON.stringify({
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: {
    id_token: fakeJwt({ iss: "https://auth.openai.com", aud: ["app_deepcodex_local"], sub: userId, iat: now, exp: now + 365 * 24 * 60 * 60, email: displayName, email_verified: true, name: displayName, "https://api.openai.com/auth": { user_id: userId, chatgpt_user_id: userId, chatgpt_account_id: accountId, chatgpt_account_user_id: `${userId}__${accountId}`, chatgpt_plan_type: "prolite", localhost: true, groups: [], organizations: [] } }),
    access_token: fakeJwt({ iss: "https://auth.openai.com", aud: ["https://api.openai.com/v1"], sub: userId, iat: now, nbf: now, exp: now + 365 * 24 * 60 * 60, scp: ["openid", "profile", "email", "offline_access"], "https://api.openai.com/profile": profile, "https://api.openai.com/auth": { user_id: userId, chatgpt_user_id: userId, chatgpt_account_id: accountId, chatgpt_account_user_id: `${userId}__${accountId}`, chatgpt_plan_type: "prolite", localhost: true } }),
    refresh_token: "rt_deepcodex_local",
    account_id: accountId
  },
  last_refresh: new Date().toISOString()
}, null, 2) + "\n");
'@ | Out-Null
}

function Seed-RuntimeDefaults {
    New-Item -ItemType Directory -Path $CODEX_HOME_DIR -Force | Out-Null
    if ((Test-Path -LiteralPath $CONFIG_TEMPLATE_PATH) -and (-not (Test-Path -LiteralPath (Join-Path $CODEX_HOME_DIR "config.adaptive-oneapi.toml")))) {
        Copy-Item -LiteralPath $CONFIG_TEMPLATE_PATH -Destination (Join-Path $CODEX_HOME_DIR "config.adaptive-oneapi.toml")
    }
    if ((Test-Path -LiteralPath $MODEL_CATALOG_TEMPLATE_PATH) -and (-not (Test-Path -LiteralPath (Join-Path $CODEX_HOME_DIR "deepseek-model-catalog.json")))) {
        Copy-Item -LiteralPath $MODEL_CATALOG_TEMPLATE_PATH -Destination (Join-Path $CODEX_HOME_DIR "deepseek-model-catalog.json")
    }
}

function Seed-OnboardingState {
    New-Item -ItemType Directory -Path $CODEX_HOME_DIR -Force | Out-Null
    Invoke-NodeStdin -Arguments @((Join-Path $CODEX_HOME_DIR ".codex-global-state.json")) -Script @'
const fs = require("fs");
const [statePath] = process.argv.slice(2);
let state = {};
try {
  state = JSON.parse(fs.readFileSync(statePath, "utf8"));
} catch {
  try {
    fs.copyFileSync(statePath, `${statePath}.invalid-${Date.now()}.bak`);
  } catch {}
}
if (!state || typeof state !== "object" || Array.isArray(state)) state = {};
const atoms = state["electron-persisted-atom-state"] && typeof state["electron-persisted-atom-state"] === "object"
  ? state["electron-persisted-atom-state"]
  : {};
const now = Math.floor(Date.now() / 1000);
for (const target of [state, atoms]) {
  target["electron:onboarding-override"] = "app";
  target["electron:onboarding-projectless-completed"] = true;
  target["electron:onboarding-welcome-pending"] = false;
  target["last_completed_onboarding"] = target["last_completed_onboarding"] || now;
}
delete atoms["prompt-history"];
state["electron-persisted-atom-state"] = atoms;
const next = JSON.stringify(state, null, 2);
fs.writeFileSync(statePath, `${next}\n`, "utf8");
fs.writeFileSync(`${statePath}.bak`, `${next}\n`, "utf8");
'@ | Out-Null
}

function Trust-Workspace {
    param([string]$Workspace)
    Invoke-NodeStdin -Arguments @((Join-Path $CODEX_HOME_DIR "config.toml"), $Workspace) -Script @'
const fs = require("fs");
const [configPath, workspace] = process.argv.slice(2);
let text = "";
try { text = fs.readFileSync(configPath, "utf8"); } catch {}
const escaped = workspace.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const header = `[projects."${escaped}"]`;
if (!text.includes(header)) {
  fs.writeFileSync(configPath, `${text.trimEnd()}\n\n${header}\ntrust_level = "trusted"\n`);
}
'@ | Out-Null
}

function Sync-GlobalRules {
    $source = Join-Path $GLOBAL_CODEX_HOME "rules"
    $target = Join-Path $CODEX_HOME_DIR "rules"
    if (Test-Path -LiteralPath $source) {
        New-Item -ItemType Directory -Path $target -Force | Out-Null
        Copy-Item -Path (Join-Path $source "*") -Destination $target -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$NODE_BIN = Find-NodeBin
if (-not $NODE_BIN) {
    Show-Alert "Node.js was not found. Install Node.js or set NODE_BIN before launching deepcodex."
    exit 1
}
$TRANSLATOR_NODE_BIN = Ensure-TranslatorNodeBin $NODE_BIN
$NODE_SHIM_DIR = Ensure-NodeCommandShims $NODE_BIN

$CODEX_BIN = Find-CodexBin
if (-not $CODEX_BIN) {
    Show-Alert "Codex Desktop was not found. Install Codex first, or set CODEX_BIN to Codex.exe."
    exit 1
}

New-Item -ItemType Directory -Path $DEEPCODEX_STATE_ROOT -Force | Out-Null
New-Item -ItemType Directory -Path $DEEPCODEX_PROJECTS_ROOT -Force | Out-Null
Seed-RuntimeDefaults
Seed-OnboardingState

try {
    & $NODE_BIN $PLUGIN_HOST_SYNC $CODEX_HOME_DIR $GLOBAL_CODEX_HOME | Out-Null
} catch {}

$UPSTREAM_API_KEY = Read-DeepSeekKey

if (-not $UPSTREAM_API_KEY) {
    if (-not (Test-Path -LiteralPath $SETUP_UI_SCRIPT)) {
        Show-Alert "DeepCodex setup page is missing: $SETUP_UI_SCRIPT"
        exit 1
    }

    $env:NODE_BIN = $NODE_BIN
    $env:DEEPCODEX_PROVIDER_PROFILE = $PROVIDER_PROFILE_PATH
    $env:DEEPCODEX_SETUP_SERVER_ONLY = "1"
    Remove-Item -LiteralPath $SETUP_OUT_LOG, $SETUP_ERR_LOG -Force -ErrorAction SilentlyContinue
    $setupProc = Start-Process -FilePath $NODE_BIN `
        -ArgumentList @($SETUP_UI_SCRIPT) `
        -RedirectStandardOutput $SETUP_OUT_LOG `
        -RedirectStandardError $SETUP_ERR_LOG `
        -PassThru -WindowStyle Hidden

    $setupUrl = ""
    for ($i = 0; $i -lt 25; $i++) {
        Start-Sleep -Milliseconds 400
        if (Test-Path -LiteralPath $SETUP_ERR_LOG) {
            $err = Get-Content -LiteralPath $SETUP_ERR_LOG -Raw -ErrorAction SilentlyContinue
            if ($err -match "DEEPCODEX_SETUP_URL=(http://[^\s]+)") {
                $setupUrl = $Matches[1]
                break
            }
        }
    }
    if ($setupUrl) { Open-SetupWindow $setupUrl } else { Open-SetupWindow "http://127.0.0.1:9999/" }
    $setupProc | Wait-Process -Timeout 300 -ErrorAction SilentlyContinue
    if (-not $setupProc.HasExited) {
        try { $setupProc.Kill() } catch {}
        exit 0
    }
    if ($setupProc.ExitCode -eq 0 -and (Test-Path -LiteralPath $SETUP_OUT_LOG)) {
        $UPSTREAM_API_KEY = (Get-Content -LiteralPath $SETUP_OUT_LOG -Raw).Trim()
        if ($UPSTREAM_API_KEY) { Save-DeepSeekKey $UPSTREAM_API_KEY }
    }
    if ($UPSTREAM_API_KEY) { Stop-SetupWindow }
    if (-not $UPSTREAM_API_KEY) {
        exit 0
    }
}

Write-PseudoLoginAuth

$env:UPSTREAM_API_KEY = $UPSTREAM_API_KEY
$env:UPSTREAM_URL = if ($env:UPSTREAM_URL) { $env:UPSTREAM_URL } else { "https://api.deepseek.com/v1" }
$env:TRANSLATOR_PROFILE_PATH = $PROVIDER_PROFILE_PATH
$env:TRANSLATOR_HOST = "127.0.0.1"
$TRANSLATOR_PORT = if ($env:TRANSLATOR_PORT) { [int]$env:TRANSLATOR_PORT } else { Select-LoopbackPort 8282 }
$TRANSLATOR_URL = if ($env:TRANSLATOR_URL) { $env:TRANSLATOR_URL } else { "http://127.0.0.1:$TRANSLATOR_PORT" }
$env:TRANSLATOR_PORT = "$TRANSLATOR_PORT"
$env:CODEX_ELECTRON_USER_DATA_PATH = $ELECTRON_USER_DATA
$env:DEEP_CODEX_ENV_FILE = $DEEP_CODEX_ENV_FILE
$DEEPCODEX_CDP_PORT = Select-LoopbackPort $DEEPCODEX_CDP_PORT

if (-not (Test-TranslatorHealth)) {
    Stop-StaleDeepCodexTranslator
    "" | Set-Content -LiteralPath $TRANSLATOR_LOG -Encoding utf8
    "" | Set-Content -LiteralPath $TRANSLATOR_ERR_LOG -Encoding utf8
    $TRANSLATOR_PROC = Start-TranslatorProcess $TRANSLATOR_NODE_BIN
    Start-Sleep -Milliseconds 700
    if (-not (Test-TranslatorHealth) -and ($TRANSLATOR_NODE_BIN -ne $NODE_BIN)) {
        Write-TranslatorStartLog "dedicated translator not healthy; falling back to $NODE_BIN"
        $TRANSLATOR_PROC = Start-TranslatorProcess $NODE_BIN
    }
}

$ready = $false
for ($i = 0; $i -lt 45; $i++) {
    if (Test-TranslatorHealth) { $ready = $true; break }
    Start-Sleep -Seconds 1
}
if (-not $ready) {
    $detail = if (Test-Path -LiteralPath $TRANSLATOR_ERR_LOG) { (Get-Content -LiteralPath $TRANSLATOR_ERR_LOG -Tail 25) -join "`n" } else { "" }
    if ($TRANSLATOR_PROC -and -not $TRANSLATOR_PROC.HasExited) { try { $TRANSLATOR_PROC.Kill() } catch {} }
    Show-Alert "Translator failed to start.`n`n$detail`n`nLogs: $TRANSLATOR_ERR_LOG"
    exit 1
}

New-Item -ItemType Directory -Path $CODEX_HOME_DIR, $ELECTRON_USER_DATA -Force | Out-Null
$configToml = Join-Path $CODEX_HOME_DIR "config.toml"
$backupToml = Join-Path $CODEX_HOME_DIR "config.toml.before-adaptive-oneapi"
if ((Test-Path -LiteralPath $configToml) -and (-not (Test-Path -LiteralPath $backupToml))) {
    Copy-Item -LiteralPath $configToml -Destination $backupToml
}
Copy-Item -LiteralPath (Join-Path $CODEX_HOME_DIR "config.adaptive-oneapi.toml") -Destination $configToml -Force
Invoke-NodeStdin -Arguments @($configToml, (Join-Path $CODEX_HOME_DIR "deepseek-model-catalog.json"), $TRANSLATOR_URL) -Script @'
const fs = require("fs");
const [configPath, catalogPath, translatorUrl] = process.argv.slice(2);
let text = fs.readFileSync(configPath, "utf8");
text = text.replace(/__DEEPCODEX_MODEL_CATALOG__/g, catalogPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"'));
if (translatorUrl) {
  const escaped = translatorUrl.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  text = text.replace(/^openai_base_url\s*=\s*".*"$/m, `openai_base_url = "${escaped}"`);
  text = text.replace(/^chatgpt_base_url\s*=\s*".*"$/m, `chatgpt_base_url = "${escaped}/backend-api/"`);
}
fs.writeFileSync(configPath, text);
'@ | Out-Null

$globalConfig = Join-Path $GLOBAL_CODEX_HOME "config.toml"
if (Test-Path -LiteralPath $globalConfig) {
    try { & $NODE_BIN $SHARED_CONFIG_SYNC $globalConfig $configToml | Out-Null } catch {}
}
foreach ($sync in @(
    @{ Path = $DEEPCODEX_PLUGINS_SYNC; Args = @($CODEX_HOME_DIR, $configToml, $GLOBAL_CODEX_HOME) },
    @{ Path = $DEEPCODEX_APP_TOOLS_SYNC; Args = @($CODEX_HOME_DIR, $GLOBAL_CODEX_HOME) },
    @{ Path = $DEEPCODEX_SIDECARS_SYNC; Args = @($GLOBAL_CODEX_HOME, $CODEX_HOME_DIR, $globalConfig, $configToml) }
)) {
    if (Test-Path -LiteralPath $sync.Path) {
        try { & $NODE_BIN $sync.Path @($sync.Args) | Out-Null } catch {}
    }
}
Invoke-NodeStdin -Arguments @($configToml) -Script @'
const fs = require("fs");
const [configPath] = process.argv.slice(2);
let text = fs.readFileSync(configPath, "utf8");
const blockRe = /(\[mcp_servers\.deepseek-code-worker\][\s\S]*?enabled\s*=\s*)(true|false)/;
if (blockRe.test(text)) {
  text = text.replace(blockRe, "$1false");
  fs.writeFileSync(configPath, text);
}
'@ | Out-Null
Sync-GlobalRules

$env:CODEX_HOME = $CODEX_HOME_DIR
$env:LANG = "zh_CN.UTF-8"
$env:LC_ALL = "zh_CN.UTF-8"
$codexArgs = @(
    "--remote-debugging-port=$DEEPCODEX_CDP_PORT",
    "--remote-allow-origins=http://127.0.0.1:$DEEPCODEX_CDP_PORT",
    "--lang=zh-CN"
)
if ($DEEPCODEX_WORKSPACE) {
    New-Item -ItemType Directory -Path $DEEPCODEX_WORKSPACE -Force | Out-Null
    Trust-Workspace $DEEPCODEX_WORKSPACE
    $codexArgs += $DEEPCODEX_WORKSPACE
}

Write-Host "Launching deepcodex."
Write-Host "  Codex:     $CODEX_BIN"
Write-Host "  Translator:$TRANSLATOR_URL"
Write-Host "  CODEX_HOME:$CODEX_HOME_DIR"
Write-Host "  Shims:     $NODE_SHIM_DIR"
Write-Host "  CDP:       http://127.0.0.1:$DEEPCODEX_CDP_PORT"
if ($codexArgs.Count -gt 0) {
    $codexProc = Start-Process -FilePath $CODEX_BIN -ArgumentList $codexArgs -PassThru
} else {
    $codexProc = Start-Process -FilePath $CODEX_BIN -PassThru
}
if (($DEEPCODEX_PLUGIN_UNLOCK -ne "0") -and (Test-Path -LiteralPath $DEEPCODEX_CDP_INJECT) -and (Test-Path -LiteralPath $DEEPCODEX_PLUGIN_UNLOCK_INJECT)) {
    Remove-Item -LiteralPath $DEEPCODEX_CDP_LOG, $DEEPCODEX_CDP_ERR_LOG -Force -ErrorAction SilentlyContinue
    Start-Process -FilePath $NODE_BIN `
        -ArgumentList @($DEEPCODEX_CDP_INJECT, "$DEEPCODEX_CDP_PORT", $DEEPCODEX_PLUGIN_UNLOCK_INJECT) `
        -RedirectStandardOutput $DEEPCODEX_CDP_LOG `
        -RedirectStandardError $DEEPCODEX_CDP_ERR_LOG `
        -PassThru -WindowStyle Hidden | Out-Null
} else {
    Write-Host "  Plugin UI unlock injection: disabled"
}
$mainWindowHandle = [IntPtr]::Zero
$windowProbeUntil = [DateTime]::UtcNow.AddSeconds(30)
while ($mainWindowHandle -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $windowProbeUntil -and -not $codexProc.HasExited) {
    Start-Sleep -Milliseconds 500
    $mainWindowHandle = Get-MainWindowHandleForProcess -ProcessId $codexProc.Id
}
if ($mainWindowHandle -ne [IntPtr]::Zero) {
    Write-Host "  Main window: $mainWindowHandle"
}
$clearedKeyAfterLogout = $false
$launcherPid = $PID
if ($env:DEEPCODEX_LAUNCHER_PID -match "^\d+$") {
    $launcherPid = [int]$env:DEEPCODEX_LAUNCHER_PID
}
try {
    while (-not $codexProc.HasExited) {
        Start-Sleep -Seconds 1
        if ($launcherPid -ne $PID -and -not (Get-Process -Id $launcherPid -ErrorAction SilentlyContinue)) {
            try { Stop-Process -Id $codexProc.Id -Force -ErrorAction SilentlyContinue } catch {}
            break
        }
        if ($mainWindowHandle -ne [IntPtr]::Zero -and -not (Test-WindowHandleExists -Handle $mainWindowHandle)) {
            Write-Host "DeepCodex main window closed; stopping background processes."
            try { Stop-Process -Id $codexProc.Id -Force -ErrorAction SilentlyContinue } catch {}
            break
        }
        if (-not $clearedKeyAfterLogout -and -not (Test-PseudoLoginAuth)) {
            Clear-DeepSeekKey
            $clearedKeyAfterLogout = $true
            Write-Host "DeepCodex logout detected; DeepSeek API key cleared."
        }
    }
} finally {
    if ($TRANSLATOR_PROC -and -not $TRANSLATOR_PROC.HasExited) {
        try { $TRANSLATOR_PROC.Kill() } catch {}
    }
    Stop-StaleDeepCodexTranslator
    Stop-DeepCodexOwnedProcesses -KeepProcessIds @($PID, $launcherPid)
}

