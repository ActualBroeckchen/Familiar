# Proto-Familiar Windows installer
#
# Fresh install: auto-installs Node, Deno, and Git via winget (when
#   available), runs `npm install`, clones entity-core (release tag),
#   pre-caches its Deno module graph, and creates Desktop + Start Menu
#   shortcuts.
#
# Update mode: triggered automatically when node_modules\ already exists.
#   Takes a defensive backup of tomes\, logs\, entity-core data\, and
#   .proto-familiar-config.json into .pf-backups\<timestamp>\ BEFORE
#   any git op runs, then pulls latest Proto-Familiar
#   (`git pull --ff-only`), refreshes entity-core to the pinned tag,
#   and re-runs the idempotent npm install + deno cache. Node/Deno/Git
#   auto-install still runs if any is missing — the only thing skipped
#   in update mode is the shortcut creation.

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$parentDir   = Split-Path -Parent $projectRoot
# Resolve the entity-core sibling checkout. New installs land in
# `entity-core\`; older installs from before the rename used
# `entity-core-alpha\` and we keep using that in place to avoid silent
# directory moves.
$entityCoreDirNew    = Join-Path $parentDir "entity-core"
$entityCoreDirLegacy = Join-Path $parentDir "entity-core-alpha"
if (Test-Path $entityCoreDirNew) {
    $entityCoreDir    = $entityCoreDirNew
    $entityCoreDirRel = "entity-core"
} elseif (Test-Path $entityCoreDirLegacy) {
    $entityCoreDir    = $entityCoreDirLegacy
    $entityCoreDirRel = "entity-core-alpha"
} else {
    $entityCoreDir    = $entityCoreDirNew
    $entityCoreDirRel = "entity-core"
}
# Release page: https://github.com/PsycherosAI/Psycheros/releases/tag/<tag>
$entityCoreRepo = "https://github.com/PsycherosAI/Psycheros.git"
$entityCoreTag  = "entity-core-v0.2.2"
$backupRoot    = Join-Path $projectRoot ".pf-backups"

function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Refresh-Path {
    $env:Path = `
        [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + `
        [System.Environment]::GetEnvironmentVariable("Path","User")
}
function Step($msg)  { Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg)    { Write-Host "    $msg" -ForegroundColor Green }
function Warn($msg)  { Write-Host "!!  $msg" -ForegroundColor Yellow }
function Fail($msg)  { Write-Host "XX  $msg" -ForegroundColor Red; Read-Host "Press Enter to close"; exit 1 }

# Detect mode: existing node_modules => update.
$updateMode = Test-Path (Join-Path $projectRoot "node_modules")

Clear-Host
if ($updateMode) {
    Write-Host "Proto-Familiar updater (existing install detected)" -ForegroundColor Magenta
} else {
    Write-Host "Proto-Familiar installer" -ForegroundColor Magenta
}
Write-Host "Project: $projectRoot"
Write-Host ""

# --- Pre-pull data backup (update mode only) ---
# Defensive copy of at-risk dirs into .pf-backups\<timestamp>\ before any
# git op. Safety net on top of git's own protections.
$anythingBackedUp = $false
$backupDir = $null
if ($updateMode) {
    $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
    $backupDir = Join-Path $backupRoot $stamp
    # Probe BOTH the new entity-core dir and the pre-rename legacy
    # entity-core-alpha so leftover data from before the rename still
    # gets backed up.
    $sources = @(
        @{ Path = (Join-Path $projectRoot "tomes"); Rel = "tomes"; IsFile = $false },
        @{ Path = (Join-Path $projectRoot "logs");  Rel = "logs";  IsFile = $false },
        @{ Path = (Join-Path $entityCoreDirNew    "packages\entity-core\data"); Rel = "entity-core\packages\entity-core\data";       IsFile = $false },
        @{ Path = (Join-Path $entityCoreDirNew    "data");                       Rel = "entity-core\data";                            IsFile = $false },
        @{ Path = (Join-Path $entityCoreDirLegacy "packages\entity-core\data"); Rel = "entity-core-alpha\packages\entity-core\data"; IsFile = $false },
        @{ Path = (Join-Path $entityCoreDirLegacy "data");                       Rel = "entity-core-alpha\data";                      IsFile = $false },
        @{ Path = (Join-Path $projectRoot ".proto-familiar-config.json"); Rel = ".proto-familiar-config.json"; IsFile = $true },
        @{ Path = (Join-Path $projectRoot "settings.json");                Rel = "settings.json";                IsFile = $true }
    )
    foreach ($s in $sources) {
        if (-not (Test-Path $s.Path)) { continue }
        if (-not $s.IsFile -and ((Get-ChildItem $s.Path -Force | Measure-Object).Count -eq 0)) { continue }
        $dest = Join-Path $backupDir $s.Rel
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
        Copy-Item -Recurse -Force -Path $s.Path -Destination $dest
        $anythingBackedUp = $true
    }
    if ($anythingBackedUp) {
        Ok "User data backed up to $backupDir\"
        Ok "  (tomes\, logs\, entity-core data\, .proto-familiar-config.json, settings.json — restore by copying back if needed)"
    }
}

# --- Pull latest Proto-Familiar (update mode only) ---
if ($updateMode -and (Test-Path (Join-Path $projectRoot ".git")) -and (Have "git")) {
    Step "Pulling latest Proto-Familiar (git pull --ff-only)..."
    Push-Location $projectRoot
    try {
        & git pull --ff-only
        if ($LASTEXITCODE -ne 0) { Warn "git pull --ff-only failed. Work tree is unchanged." }
    } finally { Pop-Location }
}

$haveWinget = Have "winget"
if (-not $haveWinget) {
    Warn "winget not found - prerequisites must be installed manually if missing."
    Warn "  Node.js 18+:  https://nodejs.org/"
    Warn "  Deno 2+:      https://deno.com/"
    Warn "  Git:          https://git-scm.com/"
    Write-Host ""
}

# --- Node.js (install if missing, in both modes) ---
Step "Checking Node.js..."
if (-not (Have "node")) {
    if ($haveWinget) {
        Step "Installing Node.js LTS via winget (per-user, no admin needed)..."
        winget install --id OpenJS.NodeJS.LTS --scope user --silent `
            --accept-source-agreements --accept-package-agreements
        Refresh-Path
    } else {
        Fail "Node.js is required. Install from https://nodejs.org/ and re-run."
    }
}
if (-not (Have "node")) { Fail "Node.js installed but not on PATH. Close this window, open a new one, and double-click Proto-Familiar.vbs again." }
$nodeVersion = (& node -v).TrimStart("v")
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 18) { Fail "Node.js $nodeVersion detected; Proto-Familiar needs 18+." }
Ok "Node.js v$nodeVersion"

# --- Deno (install if missing, in both modes) ---
Step "Checking Deno..."
if (-not (Have "deno")) {
    if ($haveWinget) {
        Step "Installing Deno via winget..."
        try {
            winget install --id DenoLand.Deno --scope user --silent `
                --accept-source-agreements --accept-package-agreements
            Refresh-Path
        } catch { Warn "Deno install failed - entity-core will be disabled until you install it from https://deno.com/" }
    } else {
        Warn "Deno not found - entity-core will be disabled until you install it from https://deno.com/"
    }
}
if (Have "deno") { Ok "Deno present" } else { Warn "Deno missing (Proto-Familiar will still run without entity-core)" }

# --- Git (install if missing, in both modes) ---
Step "Checking Git..."
if (-not (Have "git")) {
    if ($haveWinget) {
        Step "Installing Git via winget..."
        try {
            winget install --id Git.Git --scope user --silent `
                --accept-source-agreements --accept-package-agreements
            Refresh-Path
        } catch { Warn "Git install failed - entity-core clone will be skipped." }
    }
}
if (Have "git") { Ok "Git present" } else { Warn "Git missing" }

# --- npm install (idempotent) ---
Step "Running npm install..."
Push-Location $projectRoot
try {
    & npm install
    if ($LASTEXITCODE -ne 0) { Fail "npm install failed (exit $LASTEXITCODE)." }
} finally { Pop-Location }
Ok "Dependencies up to date"

# --- entity-core: clone (install) or refresh to pinned tag (update) ---
# entity-core's runtime data\ is gitignored at both workspace and package
# root, so `git checkout <tag>` never touches user data.
Step "Setting up entity-core..."
if (Test-Path $entityCoreDir) {
    if ($updateMode -and (Test-Path (Join-Path $entityCoreDir ".git")) -and (Have "git")) {
        Step "Refreshing entity-core to tag $entityCoreTag..."
        Push-Location $entityCoreDir
        try {
            & git fetch --tags --depth 1 origin "refs/tags/${entityCoreTag}:refs/tags/${entityCoreTag}" 2>$null | Out-Null
            & git checkout --quiet $entityCoreTag
            if ($LASTEXITCODE -ne 0) { Warn "Could not refresh entity-core to $entityCoreTag. Keeping current checkout." }
            else { Ok "Refreshed to $entityCoreTag" }
        } finally { Pop-Location }
    } else {
        Ok "Already present at $entityCoreDir"
    }
} elseif (Have "git") {
    Step "Cloning $entityCoreRepo (tag $entityCoreTag) into $entityCoreDir..."
    & git clone --depth 1 --branch $entityCoreTag $entityCoreRepo $entityCoreDir
    if ($LASTEXITCODE -ne 0) {
        Warn "Tag clone failed; falling back to default branch."
        & git clone --depth 1 $entityCoreRepo $entityCoreDir
    }
    if (Test-Path $entityCoreDir) { Ok "Cloned to $entityCoreDir" } else { Warn "Clone failed - identity layer will be inactive." }
} else {
    Warn "git unavailable; skipping entity-core clone."
}

# --- entity-core dependency pre-cache (idempotent) ---
$entityCorePkg = $null
if (Test-Path (Join-Path $entityCoreDir "packages\entity-core\src\mod.ts")) {
    $entityCorePkg = Join-Path $entityCoreDir "packages\entity-core"
} elseif (Test-Path (Join-Path $entityCoreDir "src\mod.ts")) {
    $entityCorePkg = $entityCoreDir
}
if ($entityCorePkg -and (Have "deno")) {
    Step "Caching entity-core dependencies (only fetches what's new)..."
    Push-Location $entityCorePkg
    try {
        & deno cache src/mod.ts | Out-Null
        if ($LASTEXITCODE -eq 0) { Ok "entity-core dependencies cached" }
        else { Warn "deno cache failed - first server start will download deps before entity-core comes up." }
    } finally { Pop-Location }
} elseif ($entityCorePkg) {
    Warn "Skipping entity-core dep pre-cache (Deno not available). First server start will download them."
}

# --- Shortcuts (install mode only) ---
if (-not $updateMode) {
    Step "Creating Desktop and Start Menu shortcuts..."
    $launcher  = Join-Path $projectRoot "Proto-Familiar.vbs"
    $desktop   = [Environment]::GetFolderPath("Desktop")
    $startMenu = [Environment]::GetFolderPath("Programs")
    $wsh = New-Object -ComObject WScript.Shell

    foreach ($linkPath in @(
        (Join-Path $desktop   "Proto-Familiar.lnk"),
        (Join-Path $startMenu "Proto-Familiar.lnk")
    )) {
        $sc = $wsh.CreateShortcut($linkPath)
        $sc.TargetPath       = "wscript.exe"
        $sc.Arguments        = """$launcher"""
        $sc.WorkingDirectory = $projectRoot
        $sc.IconLocation     = "shell32.dll,13"
        $sc.Description      = "Proto-Familiar"
        $sc.WindowStyle      = 7  # minimized; doesn't actually show because wscript is windowless
        $sc.Save()
        Ok "  $linkPath"
    }
}

Write-Host ""
if ($updateMode) {
    Write-Host "Update complete." -ForegroundColor Green
    if ($anythingBackedUp) { Write-Host "Pre-update backup: $backupDir" -ForegroundColor Green }
} else {
    Write-Host "Install complete." -ForegroundColor Green
}
Write-Host "Launch any time via:"
Write-Host "  - Desktop shortcut: Proto-Familiar"
Write-Host "  - Start Menu:       Proto-Familiar"
Write-Host "  - Or double-click:  Proto-Familiar.vbs"
Write-Host ""
Write-Host "Trouble? See docs\troubleshooting.md"
Write-Host ""
Start-Sleep -Seconds 2
