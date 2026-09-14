<#
.SYNOPSIS
  Creates a desktop shortcut for the multi-provider launcher, reusing the installed app's icon.

.DESCRIPTION
  The icon is referenced from the installed Microsoft Store package at runtime; no OpenAI asset is
  copied into this repository or into the shortcut folder, so nothing brand-related is redistributed.
  Re-run this script after a client update if the shortcut's icon goes blank, because Store package
  paths contain the package version.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File make-shortcut.ps1
#>
param(
    [string]$Name = 'ChatGPT (DeepSeek engine)',
    [string]$Launcher = (Join-Path $PSScriptRoot 'start-desktop-deepseek.ps1'),
    [string]$Destination = [Environment]::GetFolderPath('Desktop')
)
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Launcher)) { throw "launcher not found: $Launcher" }

$package = Get-AppxPackage -Name OpenAI.Codex
if ($null -eq $package) { throw 'OpenAI.Codex is not installed for this user.' }

# Prefer the app icon shipped in the package's resources folder.
$iconCandidates = @(
    (Join-Path $package.InstallLocation 'app\resources\chatgpt-app-dark.ico'),
    (Join-Path $package.InstallLocation 'app\resources\chatgpt-app-light.ico'),
    (Join-Path $package.InstallLocation 'app\resources\icon-chatgpt.ico')
)
$icon = $iconCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

$shortcutPath = Join-Path $Destination "$Name.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = (Get-Command powershell).Source
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$Launcher`" -Detach"
$shortcut.WorkingDirectory = Split-Path -Parent $Launcher
# Normal window: the launcher may need to prompt for the API key the first time. With -Detach the
# console closes immediately when no input is needed.
$shortcut.WindowStyle = 1
$shortcut.Description = 'Unofficial launcher: starts ChatGPT with the self-built Codex engine. Not affiliated with or endorsed by OpenAI.'
if ($icon) { $shortcut.IconLocation = "$icon,0" }
$shortcut.Save()

Write-Host "Shortcut : $shortcutPath"
Write-Host "Target   : powershell -File `"$Launcher`" -Detach"
if ($icon) { Write-Host "Icon     : $icon (referenced from the installed package, not copied)" }
else { Write-Host 'Icon     : none found in the package; the default PowerShell icon will be used.' }
