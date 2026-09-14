<#
.SYNOPSIS
  Starts the Microsoft Store Codex client with the self-built engine and the compatibility proxy.

.DESCRIPTION
  - Never modifies WindowsApps or permanent environment variables.
  - CODEX_CLI_PATH / CODEX_APP_SERVER_FORCE_CLI live only in this PowerShell session.
  - Provider credentials are handled once by set-provider-key.ps1 (Windows DPAPI, current user).
  - The compatibility proxy is ensured before the client starts. It is restarted on the port the
    config already points at (which keeps running sessions working); only when that port is held by
    something else, and no client is running, does the launcher move to a free port and rewrite the
    provider's base_url.

.NOTES
  Close every ChatGPT window before a first start: the client is single-instance and an already
  running instance keeps the old engine and the old environment.
#>
param(
    # Path to the patched engine. When omitted, an in-tree build is looked for and, failing that,
    # the script explains what to pass.
    [string]$CodexExe,
    [string]$KeyPath = "$env:USERPROFILE\.codex\deepseek-key.dpapi",
    [string]$ConfigPath = "$env:USERPROFILE\.codex\config.toml",
    [string]$ProviderId = 'deepseek',
    [int]$ProxyPort = 8899,
    [string]$ProxyLogPath = "$env:USERPROFILE\.codex\proxy-log.jsonl",
    # Start the client and return immediately; the client keeps the environment it inherited.
    [switch]$Detach,
    # Check engine, key, proxy, and provider config, then exit without starting anything.
    [switch]$ValidateOnly,
    # Only make sure the compatibility proxy is running, then exit. Revives it while a client is open.
    [switch]$ProxyOnly,
    # Skip the proxy (subagent tasks will not reach the provider).
    [switch]$SkipProxy,
    # Do not start the session watchdog that restarts the proxy if it disappears.
    [switch]$NoWatchdog
)
$ErrorActionPreference = 'Stop'

# Resolve the engine: explicit parameter first, then the usual in-tree build next to this checkout.
if (-not $CodexExe) {
    # Prefer a release build: that is what install-engine.ps1 produces and it runs noticeably faster.
    # A debug build stays usable as the fallback for development.
    $engineRoots = @(
        (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'codex-rs\target'),
        (Join-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))) 'codex-rs\target')
    )
    $candidates = foreach ($root in $engineRoots) {
        (Join-Path $root 'release\codex.exe')
        (Join-Path $root 'debug\codex.exe')
    }
    $CodexExe = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $CodexExe) {
        throw "Patched engine not found. Build it with tools\install-engine.ps1, or pass -CodexExe <path to codex.exe>."
    }
}

function Test-StoredProviderKey {
    param([string]$Path, [int]$MinimumLength = 20)
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    try {
        $protected = [System.IO.File]::ReadAllText($Path)
        $secure = ConvertTo-SecureString -String $protected
        $value = [System.Management.Automation.PSCredential]::new('provider', $secure).GetNetworkCredential().Password
        $secure.Dispose()
    } catch {
        return $false
    }
    return ($value.Length -ge $MinimumLength -and $value -eq $value.Trim())
}

function Test-ProxyHealth {
    param([int]$Port)
    try {
        $response = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/__proxy/health" -TimeoutSec 3
        return ($response.ok -eq $true -and $response.proxy -eq 'codex-multiprovider-proxy')
    } catch {
        return $false
    }
}

function Start-CompatibilityProxy {
    param([int]$Port, [string]$LogPath)
    $script = Join-Path $PSScriptRoot 'deepseek-proxy.mjs'
    if (-not (Test-Path -LiteralPath $script)) { throw "proxy script not found: $script" }
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { throw 'node was not found on PATH; install Node.js or pass -SkipProxy' }
    Start-Process -FilePath $node -ArgumentList @(
        $script, '--port', "$Port", '--downgrade-agent-messages', '--log', $LogPath
    ) -WindowStyle Hidden
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 500
        if (Test-ProxyHealth -Port $Port) { return $true }
    }
    return $false
}

# Reads only the provider's base_url out of the config, without printing anything else.
function Get-ProviderBaseUrl {
    param([string]$ConfigPath, [string]$ProviderId)
    if (-not (Test-Path -LiteralPath $ConfigPath)) { return $null }
    $text = [System.IO.File]::ReadAllText($ConfigPath)
    $sectionPattern = '(?ms)^\[model_providers\.' + [regex]::Escape($ProviderId) + '\]\s*(.*?)(?=^\[|\z)'
    $match = [regex]::Match($text, $sectionPattern)
    if (-not $match.Success) { return $null }
    $url = [regex]::Match($match.Groups[1].Value, '(?m)^\s*base_url\s*=\s*"([^"]+)"')
    if ($url.Success) { return $url.Groups[1].Value }
    return $null
}

# Rewrites only the provider's base_url, keeping a timestamped backup of the config.
function Set-ProviderBaseUrl {
    param([string]$ConfigPath, [string]$ProviderId, [string]$Url)
    $text = [System.IO.File]::ReadAllText($ConfigPath)
    $sectionPattern = '(?ms)(^\[model_providers\.' + [regex]::Escape($ProviderId) + '\]\s*)(.*?)(?=^\[|\z)'
    $match = [regex]::Match($text, $sectionPattern)
    if (-not $match.Success) { throw "provider section not found in $ConfigPath" }
    $section = $match.Groups[2].Value
    if ($section -notmatch '(?m)^\s*base_url\s*=') { throw "base_url not found in [model_providers.$ProviderId]" }
    $updatedSection = [regex]::Replace($section, '(?m)^(\s*base_url\s*=\s*)"[^"]*"', ('$1"' + $Url + '"'), 1)
    $start = $match.Groups[2].Index
    $updated = $text.Substring(0, $start) + $updatedSection + $text.Substring($start + $match.Groups[2].Length)
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    Copy-Item -LiteralPath $ConfigPath -Destination "$ConfigPath.bak-$stamp" -Force
    [System.IO.File]::WriteAllText($ConfigPath, $updated, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-LoopbackPort {
    param([string]$Url)
    if (-not $Url) { return $null }
    $match = [regex]::Match($Url, '^http://127\.0\.0\.1:(\d+)/?$')
    if ($match.Success) { return [int]$match.Groups[1].Value }
    return $null
}

function Find-FreePort {
    param([int]$Preferred, [int]$Attempts = 20)
    for ($candidate = $Preferred; $candidate -lt ($Preferred + $Attempts); $candidate++) {
        try {
            $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $candidate)
            $listener.Start()
            $listener.Stop()
            return $candidate
        } catch {
            continue
        }
    }
    return $null
}

function Get-WatchdogState {
    param([int]$Port)
    $lock = Join-Path $env:USERPROFILE ".codex\proxy-watchdog-$Port.json"
    if (-not (Test-Path -LiteralPath $lock)) { return $null }
    try { $info = Get-Content -LiteralPath $lock -Raw | ConvertFrom-Json } catch { return $null }
    $alive = $null -ne (Get-Process -Id $info.pid -ErrorAction SilentlyContinue)
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    # The watchdog rewrites the lock every interval; a stale one means it is gone.
    $fresh = ($nowMs - [int64]$info.updatedAt) -lt 60000
    if ($alive -and $fresh) { return $info }
    return $null
}

function Start-ProxyWatchdog {
    param([int]$Port, [string]$ProxyLogPath)
    $script = Join-Path $PSScriptRoot 'proxy-watchdog.mjs'
    if (-not (Test-Path -LiteralPath $script)) { throw "watchdog script not found: $script" }
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { throw 'node was not found on PATH; install Node.js' }
    Start-Process -FilePath $node -ArgumentList @(
        $script, '--port', "$Port", '--interval-ms', '10000', '--client-process', 'ChatGPT',
        '--proxy-script', (Join-Path $PSScriptRoot 'deepseek-proxy.mjs'), '--proxy-log', $ProxyLogPath
    ) -WindowStyle Hidden
}

# Returns the port the proxy is serving on, starting or moving it when needed.
function Ensure-CompatibilityProxy {
    param(
        [int]$PreferredPort,
        [string]$LogPath,
        [string]$ConfigPath,
        [string]$ProviderId,
        [bool]$ClientRunning
    )
    if (Test-ProxyHealth -Port $PreferredPort) { return @{ Port = $PreferredPort; Moved = $false; Started = $false } }

    # Restart in place first: the port is free after a crash, and running sessions still point at it.
    if (Start-CompatibilityProxy -Port $PreferredPort -LogPath $LogPath) {
        return @{ Port = $PreferredPort; Moved = $false; Started = $true }
    }

    if ($ClientRunning) {
        throw "Port $PreferredPort is held by another program and cannot be reused. Close all ChatGPT windows so the launcher can move the proxy to a free port and update the provider base_url."
    }

    $freePort = Find-FreePort -Preferred ($PreferredPort + 1)
    if (-not $freePort) { throw "No free loopback port found near $PreferredPort for the compatibility proxy." }
    if (-not (Start-CompatibilityProxy -Port $freePort -LogPath $LogPath)) {
        throw "The compatibility proxy did not become healthy on port $freePort."
    }
    $newUrl = "http://127.0.0.1:$freePort"
    Set-ProviderBaseUrl -ConfigPath $ConfigPath -ProviderId $ProviderId -Url $newUrl
    return @{ Port = $freePort; Moved = $true; Started = $true; Url = $newUrl }
}

$clientProcesses = @(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue)
$clientRunning = $clientProcesses.Count -gt 0

$keyOk = Test-StoredProviderKey -Path $KeyPath
$providerBaseUrl = Get-ProviderBaseUrl -ConfigPath $ConfigPath -ProviderId $ProviderId
$configPort = Get-LoopbackPort -Url $providerBaseUrl
$preferredPort = if ($configPort) { $configPort } else { $ProxyPort }
$preferredUrl = "http://127.0.0.1:$preferredPort"
$proxyHealthy = if ($SkipProxy) { $null } else { Test-ProxyHealth -Port $preferredPort }
$providerPointsAtProxy = ($providerBaseUrl -eq $preferredUrl)

if ($ValidateOnly) {
    Write-Host "engine            : $(if (Test-Path -LiteralPath $CodexExe) { $CodexExe } else { "MISSING ($CodexExe)" })"
    Write-Host "stored key        : $(if ($keyOk) { "usable ($KeyPath)" } else { "missing or unusable ($KeyPath)" })"
    Write-Host "provider base_url : $(if ($providerBaseUrl) { $providerBaseUrl } else { '(not found)' })"
    Write-Host "proxy health      : $(if ($SkipProxy) { 'skipped' } elseif ($proxyHealthy) { "healthy on $preferredUrl" } else { "not running on $preferredUrl" })"
    $watchdogState = if ($SkipProxy) { $null } else { Get-WatchdogState -Port $preferredPort }
    Write-Host "watchdog          : $(if ($SkipProxy) { 'skipped' } elseif ($watchdogState) { "running (pid $($watchdogState.pid))" } else { 'not running' })"
    Write-Host "client running    : $clientRunning"
    if (-not $providerPointsAtProxy -and -not $SkipProxy) {
        Write-Host "action needed     : set [model_providers.$ProviderId] base_url = `"$preferredUrl`""
    }
    if ($keyOk -and (Test-Path -LiteralPath $CodexExe) -and ($SkipProxy -or ($proxyHealthy -and $providerPointsAtProxy))) {
        Write-Host 'result            : ready'
        exit 0
    }
    Write-Host 'result            : not ready'
    exit 1
}

if (-not (Test-Path -LiteralPath $CodexExe)) {
    throw "Self-built engine not found: $CodexExe (build it with: cargo build -p codex-cli --bin codex)"
}

if ($ProxyOnly) {
    if ($SkipProxy) { Write-Host 'Proxy is skipped by request.'; exit 0 }
    $result = Ensure-CompatibilityProxy -PreferredPort $preferredPort -LogPath $ProxyLogPath -ConfigPath $ConfigPath -ProviderId $ProviderId -ClientRunning $clientRunning
    if ($result.Moved) {
        Write-Host "Port $preferredPort was unusable; proxy moved to $($result.Url) and the provider base_url was updated (config backed up)."
    } else {
        Write-Host "Compatibility proxy is healthy on http://127.0.0.1:$($result.Port)"
    }
    exit 0
}

$setKey = Join-Path $PSScriptRoot 'set-provider-key.ps1'
if ($keyOk) {
    Write-Host "Using stored provider key: $KeyPath"
} elseif (Test-Path -LiteralPath $KeyPath) {
    Write-Warning "The stored key at $KeyPath is unusable (truncated or undecryptable); storing it again."
    & $setKey -Path $KeyPath
} else {
    Write-Host 'No stored provider key yet; storing it once (hidden input).'
    & $setKey -Path $KeyPath
}

if (-not $SkipProxy) {
    if ($proxyHealthy) {
        Write-Host "Compatibility proxy already healthy on $preferredUrl"
        $activePort = $preferredPort
    } else {
        Write-Host "Ensuring compatibility proxy on $preferredUrl ..."
        $result = Ensure-CompatibilityProxy -PreferredPort $preferredPort -LogPath $ProxyLogPath -ConfigPath $ConfigPath -ProviderId $ProviderId -ClientRunning $clientRunning
        $activePort = $result.Port
        if ($result.Moved) {
            Write-Host "Port $preferredPort was unusable; proxy moved to $($result.Url) and the provider base_url was updated (config backed up)."
            $providerBaseUrl = $result.Url
            $providerPointsAtProxy = $true
        } else {
            Write-Host 'Compatibility proxy is up.'
        }
    }
    if (-not $providerPointsAtProxy) {
        Write-Warning "[model_providers.$ProviderId] base_url is '$providerBaseUrl', not '$preferredUrl'. Subagent tasks would reach the provider unfixed; set base_url = `"$preferredUrl`" in $ConfigPath."
    }
    if (-not $NoWatchdog) {
        $watchdog = Get-WatchdogState -Port $activePort
        if ($watchdog) {
            Write-Host "Watchdog already running (pid $($watchdog.pid)); it restarts the proxy on the same port and exits with the client."
        } else {
            Start-ProxyWatchdog -Port $activePort -ProxyLogPath $ProxyLogPath
            Write-Host 'Watchdog started: restarts the proxy on the same port if it disappears, and exits when the client exits.'
        }
    }
}

if ($clientRunning) {
    throw "ChatGPT is already running ($($clientProcesses.Count) processes). Close all ChatGPT windows, then run this script again. (The compatibility proxy has already been checked or restarted.)"
}

# Session-only engine override.
$env:CODEX_CLI_PATH = $CodexExe
$env:CODEX_APP_SERVER_FORCE_CLI = '1'

$package = Get-AppxPackage -Name OpenAI.Codex
if ($null -eq $package) { throw 'OpenAI.Codex is not installed for this user.' }

$client = "$($package.InstallLocation)\app\ChatGPT.exe"
Write-Host "Engine : $CodexExe"
Write-Host "Client : $client"
if ($Detach) {
    Start-Process -FilePath $client | Out-Null
    Write-Host 'Client started; this window can be closed. The proxy keeps running in the background.'
} else {
    Write-Host 'Starting. Keep this window open while you use the client.'
    & $client
}
