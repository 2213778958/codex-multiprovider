<#
.SYNOPSIS
  Stores a provider API key once, encrypted with Windows DPAPI (current user only).

.DESCRIPTION
  The key is written to a DPAPI-protected file that only your Windows account can decrypt.
  It is never written to the registry, to a plaintext file, or to the shell profile.
  `get-provider-key.ps1` reads it back for the engine's `[model_providers.<id>.auth]` command.

  The value is validated before it is stored: a paste that loses characters (a common failure in
  minimized consoles or when the window is not focused) is rejected and prompted again instead of
  being saved silently.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File set-provider-key.ps1
#>
param(
    [string]$Path = "$env:USERPROFILE\.codex\deepseek-key.dpapi",
    [string]$Prompt = 'Provider API key (hidden; stored DPAPI-encrypted for this Windows account)',
    [int]$MinimumLength = 20
)
$ErrorActionPreference = 'Stop'

$plain = $null
while ($true) {
    $secure = Read-Host $Prompt -AsSecureString
    $plain = [System.Management.Automation.PSCredential]::new('provider', $secure).GetNetworkCredential().Password
    $secure.Dispose()

    if ([string]::IsNullOrWhiteSpace($plain) -or $plain.Length -lt $MinimumLength) {
        Write-Warning "That does not look like a full API key (got $($plain.Length) character(s); expected at least $MinimumLength). Paste the whole key. Ctrl+C aborts."
        continue
    }
    if ($plain -ne $plain.Trim()) {
        Write-Warning 'The pasted value starts or ends with whitespace; paste only the key. Ctrl+C aborts.'
        continue
    }
    break
}

$directory = Split-Path -Parent $Path
if ($directory -and -not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}

# ConvertFrom-SecureString without -Key uses DPAPI scoped to the current user.
$protected = ConvertFrom-SecureString -SecureString (ConvertTo-SecureString -String $plain -AsPlainText -Force)
[System.IO.File]::WriteAllText($Path, $protected, (New-Object System.Text.UTF8Encoding($false)))

$masked = $plain.Substring(0, [Math]::Min(3, $plain.Length)) + '...' + $plain.Substring($plain.Length - 4)
$length = $plain.Length
$plain = $null

Write-Host "Stored (DPAPI, current user only): $Path"
Write-Host "Value: $masked (length $length)"
Write-Host 'Point your provider config at get-provider-key.ps1, for example:'
Write-Host @"

[model_providers.deepseek.auth]
command = "powershell"
args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "$((Resolve-Path -LiteralPath $PSScriptRoot).Path)\get-provider-key.ps1", "-Path", "$Path"]
"@
