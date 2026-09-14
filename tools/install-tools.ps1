<#
.SYNOPSIS
  Installs the provider key scripts into %USERPROFILE%\.codex, where the provider config expects them.

.DESCRIPTION
  The engine obtains its token by running a command whose path is pinned in config.toml. That path
  has to stay stable for as long as sessions are alive, because the engine snapshots the provider
  configuration per thread: pointing it at a path inside this checkout means every running session
  breaks the moment the checkout moves, is deleted, or switches branch (and deleting a previously
  installed copy has the same effect).

  So the config references ~/.codex and this script is the installer. Run it after editing the
  scripts here.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install-tools.ps1
  powershell -ExecutionPolicy Bypass -File install-tools.ps1 -Check   # report without copying
#>
param(
    [string]$Target = "$env:USERPROFILE\.codex",
    # Report what would change without copying anything.
    [switch]$Check
)
$ErrorActionPreference = 'Stop'

$scripts = @('set-provider-key.ps1', 'get-provider-key.ps1')
$changed = 0
foreach ($name in $scripts) {
    $source = Join-Path $PSScriptRoot $name
    if (-not (Test-Path -LiteralPath $source)) { throw "missing source script: $source" }
    $destination = Join-Path $Target $name

    $upToDate = (Test-Path -LiteralPath $destination) -and
        ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -eq
         (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash)
    if ($upToDate) {
        Write-Host "up to date : $destination"
        continue
    }

    $changed += 1
    if ($Check) {
        Write-Host "would copy : $source -> $destination"
    } else {
        Copy-Item -LiteralPath $source -Destination $destination -Force
        Write-Host "installed  : $source -> $destination"
    }
}

if ($changed -eq 0) {
    Write-Host 'Nothing to do; the installed copies already match this checkout.'
} elseif ($Check) {
    Write-Host "Run again without -Check to install $changed file(s)."
} else {
    Write-Host "Installed $changed file(s). Running sessions keep using the path their config pins, which is now up to date."
}
