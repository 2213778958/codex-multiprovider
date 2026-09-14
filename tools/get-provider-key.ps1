<#
.SYNOPSIS
  Prints the stored provider API key on stdout for the engine's provider `auth.command`.

.DESCRIPTION
  Companion to set-provider-key.ps1. Writes the key to stdout with no trailing newline and
  nothing else, so the engine can use it as a bearer token. Exits non-zero when the key is
  missing or cannot be decrypted (for example after a Windows account change).
#>
param(
    [string]$Path = "$env:USERPROFILE\.codex\deepseek-key.dpapi"
)
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Path)) {
    [Console]::Error.WriteLine("no stored key at $Path; run set-provider-key.ps1 first")
    exit 1
}

try {
    $protected = [System.IO.File]::ReadAllText($Path)
    $secure = ConvertTo-SecureString -String $protected
    $plain = [System.Management.Automation.PSCredential]::new('provider', $secure).GetNetworkCredential().Password
    $secure.Dispose()
} catch {
    [Console]::Error.WriteLine("could not decrypt $Path for this Windows account: $($_.Exception.Message)")
    exit 1
}

if ([string]::IsNullOrWhiteSpace($plain)) {
    [Console]::Error.WriteLine("stored key at $Path is empty")
    exit 1
}

# Fail loudly instead of handing a truncated value to the provider: a short or padded value means
# the store step went wrong (for example a paste that lost characters).
if ($plain.Length -lt 20 -or $plain -ne $plain.Trim()) {
    [Console]::Error.WriteLine("stored key at $Path looks truncated ($($plain.Length) chars); re-run set-provider-key.ps1")
    exit 1
}

[Console]::Out.Write($plain)
$plain = $null
