<#
.SYNOPSIS
  Stops the session watchdog and then the local compatibility proxy.

.DESCRIPTION
  The watchdog is stopped first on purpose: otherwise it would restart the proxy immediately.
  Only processes belonging to this project are touched — the watchdog is identified through its
  lock file, and the proxy through its own health marker.
#>
param(
    [int]$ProxyPort = 8899
)
$ErrorActionPreference = 'Stop'

# 1) Watchdog (identified by its lock file).
$lock = Join-Path $env:USERPROFILE ".codex\proxy-watchdog-$ProxyPort.json"
if (Test-Path -LiteralPath $lock) {
    $info = $null
    try { $info = Get-Content -LiteralPath $lock -Raw | ConvertFrom-Json } catch { $info = $null }
    if ($info -and (Get-Process -Id $info.pid -ErrorAction SilentlyContinue)) {
        Stop-Process -Id $info.pid -Force
        Write-Host "Stopped watchdog (pid $($info.pid)) watching port $ProxyPort."
    } else {
        Write-Host "Watchdog lock file was stale; removing it."
    }
    Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
} else {
    Write-Host "No watchdog lock file for port $ProxyPort."
}

# 2) Proxy (identified by its health marker).
$healthy = $false
try {
    $response = Invoke-RestMethod -Uri "http://127.0.0.1:$ProxyPort/__proxy/health" -TimeoutSec 3
    $healthy = ($response.ok -eq $true -and $response.proxy -eq 'codex-multiprovider-proxy')
} catch {
    $healthy = $false
}

if (-not $healthy) {
    Write-Host "No compatibility proxy is answering on port $ProxyPort."
    exit 0
}

$owner = (Get-NetTCPConnection -LocalPort $ProxyPort -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1).OwningProcess
if (-not $owner) {
    Write-Host "Proxy answered but no listener was found on port $ProxyPort."
    exit 0
}

Stop-Process -Id $owner -Force
Write-Host "Stopped compatibility proxy (pid $owner) on port $ProxyPort."
