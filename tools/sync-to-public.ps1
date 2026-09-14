<#
.SYNOPSIS
  Publishes this checkout's multi-provider tooling and engine patch into the standalone public repo.

.DESCRIPTION
  The fork checkout is the source of truth: the tools under this directory are what actually runs.
  This script copies them into the standalone repository, regenerates the engine patch against the
  fork point, rebuilds the public README from the guide in this directory while keeping the public
  header/install/“not included”/license blocks, then stages everything so the diff can be reviewed
  before committing.

  Nothing is committed or pushed unless -Commit is passed.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File sync-to-public.ps1
  powershell -ExecutionPolicy Bypass -File sync-to-public.ps1 -Commit
#>
param(
    # Standalone repository that gets published.
    [string]$PublicRepo = 'E:\Projects\codex-multiprovider',
    # Fork checkout this script lives in; defaults to the repository containing this file.
    [string]$ForkRepo = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
    [string]$BaseBranch = 'main',
    [switch]$SkipReadme,
    [switch]$Commit,
    [string]$CommitMessage = 'Sync tooling and engine patch from the fork checkout'
)
$ErrorActionPreference = 'Stop'

function Assert-Path {
    param([string]$Path, [string]$What)
    if (-not (Test-Path -LiteralPath $Path)) { throw "$What not found: $Path" }
}

Assert-Path -Path (Join-Path $PublicRepo '.git') -What 'standalone repository'
Assert-Path -Path (Join-Path $ForkRepo 'multiprovider\tools') -What 'fork tooling directory'

$sourceTools = Join-Path $ForkRepo 'multiprovider\tools'
$sourceConfig = Join-Path $ForkRepo 'multiprovider\config'
$sourceGuide = Join-Path $ForkRepo 'multiprovider\README.md'
$targetTools = Join-Path $PublicRepo 'tools'
$targetConfig = Join-Path $PublicRepo 'config'
$targetPatch = Join-Path $PublicRepo 'patch\model-provider-routes.patch'
$targetReadme = Join-Path $PublicRepo 'README.md'

Write-Host '1) Copying tools and example config ...'
New-Item -ItemType Directory -Path $targetTools, $targetConfig, (Split-Path -Parent $targetPatch) -Force | Out-Null
Copy-Item (Join-Path $sourceTools '*') $targetTools -Force
if (Test-Path -LiteralPath $sourceConfig) { Copy-Item (Join-Path $sourceConfig '*') $targetConfig -Force }
Write-Host "   tools <- $sourceTools"

Write-Host '2) Regenerating the engine patch and pinning its base commit ...'
$base = (& git -C $ForkRepo merge-base $BaseBranch HEAD).Trim()
if (-not $base) { throw "could not resolve merge-base between $BaseBranch and HEAD" }
$head = (& git -C $ForkRepo rev-parse HEAD).Trim()
& git -C $ForkRepo diff --output=$targetPatch $base $head -- codex-rs
$patchInfo = Get-Item -LiteralPath $targetPatch
$patchFiles = (Select-String -LiteralPath $targetPatch -Pattern '^diff --git' | Measure-Object).Count
if ($patchFiles -eq 0) { throw "regenerated patch is empty: $targetPatch" }
Write-Host ("   base {0} -> head {1}; {2} files, {3} B" -f $base.Substring(0, 10), $head.Substring(0, 10), $patchFiles, $patchInfo.Length)

if (-not $SkipReadme) {
    Write-Host '3) Rebuilding the public README from the guide ...'
    $publicText = [System.IO.File]::ReadAllText($targetReadme)
    $guideText = [System.IO.File]::ReadAllText($sourceGuide)
    $publicHeader = $publicText.Substring(0, $publicText.IndexOf('## What the engine change adds'))
    $publicTail = $publicText.Substring($publicText.IndexOf('## Not included'))
    $guideBody = $guideText.Substring($guideText.IndexOf('## What the engine change adds'))
    $guideBody = $guideBody -replace 'multiprovider\\tools\\', 'tools\' -replace 'multiprovider/tools/', 'tools/'
    $guideBody = $guideBody -replace 'multiprovider\\config\\', 'config\' -replace 'multiprovider/config/', 'config/'
    # Keep the pinned commit in the install block in sync with the patch base.
    $publicHeader = [regex]::Replace($publicHeader, 'git checkout [0-9a-f]{7,40}', "git checkout $($base.Substring(0, 10))")
    $merged = $publicHeader + $guideBody.TrimEnd() + "`n`n" + $publicTail.TrimStart()
    [System.IO.File]::WriteAllText($targetReadme, $merged, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host '   README rebuilt (header/install/tail kept, guide body refreshed)'
} else {
    Write-Host '3) README rebuild skipped'
}

Write-Host '4) Staging in the standalone repository ...'
& git -C $PublicRepo add -A
$status = & git -C $PublicRepo status --short
$stat = & git -C $PublicRepo diff --cached --stat
if (-not $status) {
    Write-Host '   nothing changed; already in sync'
    exit 0
}
Write-Host '   staged changes:'
$status | ForEach-Object { Write-Host "     $_" }
Write-Host '   diffstat:'
$stat | ForEach-Object { Write-Host "     $_" }

if ($Commit) {
    & git -C $PublicRepo commit -m $CommitMessage | Write-Host
    Write-Host '   committed. Push with: git -C <repo> push'
} else {
    Write-Host ''
    Write-Host "Review, then commit and push:"
    Write-Host "  git -C `"$PublicRepo`" commit -m `"$CommitMessage`""
    Write-Host "  git -C `"$PublicRepo`" push"
}
