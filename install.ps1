# dsh-edge-cdp: wire the plugin into a profile and migrate the browser profile.
#
# Two steps, each one checks before it acts and stops on failure:
#
#   1. Wire the plugin into the web profile: dependencies + dsh.profile.bundles
#      + a node_modules junction.
#   2. Migrate the old workspace's browser profile (about 1 GB of login state)
#      into the plugin's own var/ directory.
#
# Why the user runs this by hand: both steps write outside the agent's DSH file
# sandbox (~/.dsh and dsh-edge-workspace\var). The agent cannot reach them, and
# deliberately was not given a way to bypass the sandbox.
#
# Usage (a normal PowerShell window):
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
#
#   -SkipProfileMigration   wire only, do not move the profile
#   -SourceProfile <path>   where the old profile lives
#   -KeepSourceProfile      never print the delete hint (default keeps it anyway)
#   -DryRun                 report what would happen, change nothing
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less file as ANSI,
# so a CJK literal in a .ps1 breaks the parse. Docs stay Chinese, code stays
# ASCII. Keep it that way.

[CmdletBinding()]
param(
    [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\web'),
    [string]$PluginDir = 'C:\D\dsh\dsh-plugins\dsh-edge-cdp',
    [string]$SourceProfile = 'C:\D\dsh\dsh-edge-workspace\var\profile',
    [switch]$SkipProfileMigration,
    [switch]$KeepSourceProfile,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Say  { param([string]$Text) Write-Host $Text }
function Ok   { param([string]$Text) Write-Host "[ OK ] $Text" -ForegroundColor Green }
function Warn { param([string]$Text) Write-Host "[WARN] $Text" -ForegroundColor Yellow }
function Fail { param([string]$Text) Write-Host "[FAIL] $Text" -ForegroundColor Red; exit 1 }
function Step { param([string]$Text) Write-Host "`n--- $Text ---" -ForegroundColor Cyan }

# --- 0. sanity -------------------------------------------------------------
Step 'preflight'

if (-not (Test-Path -LiteralPath $PluginDir)) { Fail "plugin directory not found: $PluginDir" }
$pluginManifestPath = Join-Path $PluginDir 'package.json'
if (-not (Test-Path -LiteralPath $pluginManifestPath)) { Fail "plugin manifest not found: $pluginManifestPath" }
$pluginManifest = Get-Content -LiteralPath $pluginManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($pluginManifest.name -ne 'dsh-edge-cdp') { Fail "unexpected plugin name: $($pluginManifest.name)" }
Ok "plugin $($pluginManifest.name)@$($pluginManifest.version) at $PluginDir"

if (-not (Test-Path -LiteralPath $ProfileDir)) { Fail "profile directory not found: $ProfileDir" }
$profileManifestPath = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path -LiteralPath $profileManifestPath)) { Fail "profile manifest not found: $profileManifestPath" }
Ok "profile at $ProfileDir"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { Fail 'node not found in PATH (need >= 22)' }
$nodeVersion = (& node -v).TrimStart('v')
if ([int]($nodeVersion.Split('.')[0]) -lt 22) { Fail "node $nodeVersion is too old (need >= 22 for global WebSocket)" }
Ok "node $nodeVersion"

# --- 1. wire the plugin into the profile -----------------------------------
Step 'wire plugin into profile'

$backup = "$profileManifestPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
$original = Get-Content -LiteralPath $profileManifestPath -Raw -Encoding UTF8
$manifest = $original | ConvertFrom-Json

$alreadyDependency = $manifest.dependencies.PSObject.Properties.Name -contains 'dsh-edge-cdp'
$alreadyBundle = @($manifest.dsh.profile.bundles) -contains 'dsh-edge-cdp'

if ($alreadyDependency -and $alreadyBundle) {
    Ok 'already wired (dependencies + bundles)'
}
elseif ($DryRun) {
    Say "would add dependency dsh-edge-cdp -> $PluginDir"
    Say 'would append dsh-edge-cdp to dsh.profile.bundles'
}
else {
    # Edit the JSON text rather than round-tripping the object: a ConvertTo-Json
    # round trip would reorder keys and rewrite unrelated formatting in a file
    # the user maintains by hand.
    Copy-Item -LiteralPath $profileManifestPath -Destination $backup
    Ok "backup: $backup"

    $text = $original
    if (-not $alreadyDependency) {
        $urlPath = ($PluginDir -replace '\\', '/')
        $text = $text -replace '("dependencies"\s*:\s*\{)', "`$1`n    `"dsh-edge-cdp`": `"file:///$urlPath`","
    }
    if (-not $alreadyBundle) {
        $text = $text -replace '("bundles"\s*:\s*\[)([^\]]*?)(\s*\])', "`$1`$2,`n        `"dsh-edge-cdp`"`$3"
    }
    $parsed = $text | ConvertFrom-Json   # parse before writing: never leave invalid JSON behind
    if (-not $parsed.dependencies.'dsh-edge-cdp') { Fail 'dependency edit did not apply' }
    if (-not (@($parsed.dsh.profile.bundles) -contains 'dsh-edge-cdp')) { Fail 'bundle edit did not apply' }
    [System.IO.File]::WriteAllText($profileManifestPath, $text, (New-Object System.Text.UTF8Encoding($false)))
    Ok 'profile manifest updated'
}

# node_modules link: app-boot discovers profile plugins with
# `dirent.isSymbolicLink()`, and a junction created after the target directory
# already exists would be a plain directory instead (link silently ignored).
# So: create the link first, then verify it really is a reparse point.
$linkPath = Join-Path $ProfileDir 'node_modules\dsh-edge-cdp'
$linkIsReal = $false
if (Test-Path -LiteralPath $linkPath) {
    $item = Get-Item -LiteralPath $linkPath -Force
    $linkIsReal = ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
}

if ($linkIsReal) {
    Ok "node_modules link exists: $linkPath"
}
elseif ($DryRun) {
    Say "would create junction $linkPath -> $PluginDir"
}
else {
    if (Test-Path -LiteralPath $linkPath) {
        Warn "existing entry is a plain directory, replacing it with a junction"
        Remove-Item -LiteralPath $linkPath -Recurse -Force
    }
    $modulesDir = Join-Path $ProfileDir 'node_modules'
    New-Item -ItemType Directory -Path $modulesDir -Force | Out-Null
    # cmd's mklink is used on purpose: New-Item -ItemType Junction can no-op
    # against an existing path, which is exactly the failure seen here.
    & cmd /c "mklink /J `"$linkPath`" `"$PluginDir`"" | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "mklink failed for $linkPath" }

    # Prove it: DSH only treats a reparse point as a linked profile root.
    $item = Get-Item -LiteralPath $linkPath -Force
    if ((($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0)) {
        Fail "link was not created as a reparse point: $linkPath"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $linkPath 'lib\index.js'))) {
        Fail "link does not reach the plugin entry: $linkPath"
    }
    Ok "linked $linkPath -> $PluginDir"
}

# --- 2. migrate the browser profile ----------------------------------------
Step 'migrate browser profile'

# Runtime data lives under DSH_HOME, NOT inside the package: a git-installed
# package is replaced wholesale on upgrade, and the profile is login state.
$dataRoot = Join-Path $env:USERPROFILE '.dsh\edge-cdp'
if ($env:DSH_HOME) { $dataRoot = Join-Path $env:DSH_HOME 'edge-cdp' }
$targetProfile = Join-Path $dataRoot 'profile'
Say "data root: $dataRoot"
if ($SkipProfileMigration) {
    Warn 'skipped (-SkipProfileMigration)'
}
elseif (-not (Test-Path -LiteralPath $SourceProfile)) {
    Warn "source profile not found, nothing to migrate: $SourceProfile"
}
else {
    # A live browser holds the profile's lockfile. Copying under a live lock
    # produces a profile that cannot be opened, so refuse instead of guessing.
    $lockFile = Join-Path $SourceProfile 'lockfile'
    $lockHeld = $false
    if (Test-Path -LiteralPath $lockFile) {
        try {
            $fs = [System.IO.File]::Open($lockFile, 'Open', 'ReadWrite', 'None')
            $fs.Close()
        }
        catch { $lockHeld = $true }
    }
    if ($lockHeld) {
        if ($DryRun) {
            Warn "a browser is using $SourceProfile (lockfile held): a real run would stop here"
        }
        else {
            Fail "a browser is using $SourceProfile (lockfile is held). Close that Edge first, then re-run."
        }
    }

    $sourceSize = [math]::Round(((Get-ChildItem -LiteralPath $SourceProfile -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum) / 1GB, 2)
    Say "source: $SourceProfile ($sourceSize GB)"
    Say "target: $targetProfile"

    if ($DryRun) {
        Say 'would copy source profile to target (source is kept)'
    }
    elseif (Test-Path -LiteralPath $targetProfile) {
        $targetSize = [math]::Round(((Get-ChildItem -LiteralPath $targetProfile -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum) / 1GB, 2)
        Warn "target already exists ($targetSize GB), leaving it alone"
    }
    else {
        $started = Get-Date
        Copy-Item -LiteralPath $SourceProfile -Destination $targetProfile -Recurse -Force
        $copied = [math]::Round(((Get-ChildItem -LiteralPath $targetProfile -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum) / 1GB, 2)
        $elapsed = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
        Ok "copied $copied GB in $elapsed s"
        if ($copied -lt ($sourceSize * 0.95)) { Fail "copy looks incomplete ($copied GB vs $sourceSize GB)" }
    }

    if (-not $KeepSourceProfile) {
        Warn 'source kept on purpose. Delete it by hand only after the plugin has started a browser successfully:'
        Say  "        Remove-Item -LiteralPath '$SourceProfile' -Recurse -Force"
    }
}

# --- 3. result -------------------------------------------------------------
Step 'result'
if ($DryRun) {
    Say 'dry run: nothing was changed'
}
else {
    Ok 'wiring complete'
    Say ''
    Say 'Next:'
    Say '  1. Restart DSH so the plugin loads (server-side code is not hot-reloaded).'
    Say '  2. In a session, ask for edge_status - it should report state "down".'
    Say '  3. Then edge_start - a visible Edge window must appear.'
    Say '  4. Confirm with edge_status that state is "running" and ours is true.'
    Say ''
    Say 'If step 3 fails, the browser log is under:'
    Say "  $(Join-Path $PluginDir 'var\logs')"
}
exit 0
