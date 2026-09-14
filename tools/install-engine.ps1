<#
.SYNOPSIS
  Clones the upstream Codex engine at the pinned commit, applies the multi-provider patch, and builds it.

.DESCRIPTION
  One command, from nothing to a patched codex.exe. The script:

    1. checks that the tools that cannot be installed for you are present (git, cargo);
    2. clones openai/codex at the exact commit the patch was generated against, so the patch applies
       cleanly instead of failing against a moved upstream;
    3. applies patch\model-provider-routes.patch;
    4. builds codex-rs with `cargo build -p codex-cli --bin codex`;
    5. prints the path of the engine binary and the next steps.

  Use -EnginePath to patch an existing checkout instead of cloning. The checkout must be at the
  pinned commit and have no modified files.

  What it cannot do for you: Node.js and the compatibility proxy, the provider API key, and the
  client launch configuration. Those live in the README; this script stops once the engine builds.

.PARAMETER EnginePath
  Existing upstream checkout to patch. Omit to clone a fresh one under -WorkDir.

.PARAMETER WorkDir
  Where to clone the engine when -EnginePath is not given. Defaults to .\codex-engine.

.PARAMETER Profile
  Cargo profile to build. Defaults to release because that is what the client should run.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install-engine.ps1
  powershell -ExecutionPolicy Bypass -File install-engine.ps1 -EnginePath C:\src\codex
#>
param(
    [string]$EnginePath,
    [string]$WorkDir,
    [ValidateSet('release', 'debug')]
    [string]$Profile = 'release'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# The upstream commit this patch was generated against. Keep in sync with README.md and
# .github/workflows/patch-applies.yml; the script verifies the checkout matches before patching.
$PinnedSha = '1715e55076737158ba61d43158ede504de6d4ce1'
$UpstreamUrl = 'https://github.com/openai/codex.git'
$PatchPath = Join-Path $PSScriptRoot '..\patch\model-provider-routes.patch'

function Write-Step {
    param([string]$Message)
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Message)
    Write-Host "    $Message" -ForegroundColor Green
}

function Write-Note {
    param([string]$Message)
    Write-Host "    $Message"
}

function Test-Tool {
    param([string]$Name, [string]$InstallHint)
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) {
        throw "$Name was not found on PATH. $InstallHint"
    }
    Write-Note "$Name -> $($command.Source)"
}

function Invoke-Git {
    param([string[]]$Arguments, [string]$What)
    & git @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$What failed (git exit code $LASTEXITCODE)."
    }
}

Write-Step 'Checking the tools this script cannot install for you'
Test-Tool -Name 'git' -InstallHint 'Install Git from https://git-scm.com/download/win.'
Test-Tool -Name 'cargo' -InstallHint 'Install Rust from https://rustup.rs, then reopen this shell so PATH is refreshed.'
Test-Tool -Name 'rustc' -InstallHint 'Install Rust from https://rustup.rs, then reopen this shell so PATH is refreshed.'
# `rustc --version` prints only "rustc <version> (<sha> <date>)" and never names the platform, so the
# host triple has to come from -vV. Checking --version for "msvc" warns on every correct toolchain.
$rustcVerbose = ((& rustc -vV) 2>&1) -join "`n"
$rustcVersion = [regex]::Match($rustcVerbose, '(?m)^release:\s*(.+)$').Groups[1].Value.Trim()
$hostTriple = [regex]::Match($rustcVerbose, '(?m)^host:\s*(.+)$').Groups[1].Value.Trim()
Write-Note "rustc: $rustcVersion (host $hostTriple)"
if ($hostTriple -notmatch 'msvc') {
    throw "this toolchain targets '$hostTriple', but the engine has to be built for a Windows MSVC target. Install the MSVC toolchain with: rustup default stable-msvc"
}

if (-not (Test-Path -LiteralPath $PatchPath)) {
    throw "patch not found at $PatchPath. Run this script from inside the repository checkout."
}
Write-Note "patch: $((Resolve-Path -LiteralPath $PatchPath).Path)"

if (-not $EnginePath) {
    if (-not $WorkDir) { $WorkDir = Join-Path (Get-Location).Path 'codex-engine' }
    Write-Step "Cloning openai/codex at the pinned commit into $WorkDir"
    if (Test-Path -LiteralPath $WorkDir) {
        throw "$WorkDir already exists. Remove it, or pass -EnginePath to patch an existing checkout."
    }
    # A shallow clone of the default branch keeps the download small; the pinned commit is then
    # fetched by SHA, which is the only way to get a commit that is not at the tip.
    Invoke-Git -What 'git init' -Arguments @('init', '--quiet', $WorkDir)
    Invoke-Git -What 'adding the upstream remote' -Arguments @('-C', $WorkDir, 'remote', 'add', 'origin', $UpstreamUrl)
    Invoke-Git -What 'fetching the pinned commit' -Arguments @('-C', $WorkDir, 'fetch', '--depth', '1', 'origin', $PinnedSha)
    Invoke-Git -What 'checking out the pinned commit' -Arguments @('-C', $WorkDir, 'checkout', '--quiet', '--detach', 'FETCH_HEAD')
    $EnginePath = (Resolve-Path -LiteralPath $WorkDir).Path
} else {
    $EnginePath = (Resolve-Path -LiteralPath $EnginePath).Path
    Write-Step "Using the existing checkout at $EnginePath"
    if (-not (Test-Path -LiteralPath (Join-Path $EnginePath 'codex-rs\Cargo.toml'))) {
        throw "$EnginePath does not look like the Codex repository (codex-rs\Cargo.toml is missing)."
    }
}

Write-Step 'Verifying the checkout is the commit the patch expects'
$actualSha = (& git -C $EnginePath rev-parse HEAD).Trim()
if ($actualSha -ne $PinnedSha) {
    throw "checked out $actualSha but the patch needs $PinnedSha. Run: git -C `"$EnginePath`" checkout $PinnedSha"
}
Write-Ok "HEAD is $PinnedSha"

$dirty = @(& git -C $EnginePath status --porcelain)
if ($dirty.Count -gt 0) {
    throw 'the checkout has uncommitted changes. Commit or discard them first, so this script cannot overwrite your work.'
}
Write-Ok 'the checkout is clean'

Write-Step 'Applying the patch'
# --check first, so a mismatch is reported before anything is touched. git talks progress on stderr,
# which PowerShell renders as an error block; capture both streams and only surface them on failure.
$checkOutput = & git -C $EnginePath apply --check $PatchPath 2>&1
if ($LASTEXITCODE -ne 0) {
    $checkOutput | ForEach-Object { Write-Host "    $_" }
    throw 'the patch does not apply to this checkout. Nothing was modified.'
}
Invoke-Git -What 'applying the patch' -Arguments @('-C', $EnginePath, 'apply', $PatchPath)
Write-Ok "$(@(& git -C $EnginePath status --porcelain).Count) files patched"

Write-Step "Building the engine (-p codex-cli --bin codex, profile $Profile)"
Write-Note 'the first build downloads and compiles the whole Rust workspace and takes a while'
$cargoArguments = @('build', '-p', 'codex-cli', '--bin', 'codex')
if ($Profile -eq 'release') { $cargoArguments += '--release' }
Push-Location (Join-Path $EnginePath 'codex-rs')
try {
    & cargo @cargoArguments
    if ($LASTEXITCODE -ne 0) {
        throw "cargo build failed (exit code $LASTEXITCODE). The patch is applied; rerun cargo in $EnginePath\codex-rs to see the full error."
    }
}
finally {
    Pop-Location
}

$engineBinary = Join-Path $EnginePath "codex-rs\target\$Profile\codex.exe"
if (-not (Test-Path -LiteralPath $engineBinary)) {
    throw "the build reported success but $engineBinary is missing."
}
$sizeMb = [math]::Round((Get-Item -LiteralPath $engineBinary).Length / 1MB, 1)

Write-Step 'Done'
Write-Ok "engine: $engineBinary ($sizeMb MB)"
Write-Host ''
Write-Host 'Next steps (all of them are in README.md):' -ForegroundColor Cyan
Write-Host "  1. Point the client at it:        `$env:CODEX_CLI_PATH = '$engineBinary'"
Write-Host '  2. Store the provider key once:   tools\set-provider-key.ps1'
Write-Host '  3. Merge the model catalogs:      tools\merge-model-catalogs.mjs  (needs Node.js)'
Write-Host '  4. Add the provider blocks to %USERPROFILE%\.codex\config.toml (config\example.config-snippet.toml)'
Write-Host '  5. Start the desktop client through tools\start-desktop-deepseek.ps1'
