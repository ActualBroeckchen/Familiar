# Proto-Familiar Windows installer
# Auto-installs Node, Deno, and Git via winget when available, runs `npm install`,
# clones entity-core-alpha, and creates Desktop + Start Menu shortcuts.

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$parentDir   = Split-Path -Parent $projectRoot
$entityCoreDir = Join-Path $parentDir "entity-core-alpha"
$entityCoreRepo = "https://github.com/PsycherosAI/Psycheros.git"
$entityCoreTag  = "entity-core-v0.2.2"

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

Clear-Host
Write-Host "Proto-Familiar installer" -ForegroundColor Magenta
Write-Host "Project: $projectRoot"
Write-Host ""

$haveWinget = Have "winget"
if (-not $haveWinget) {
    Warn "winget not found - prerequisites must be installed manually if missing."
    Warn "  Node.js 18+:  https://nodejs.org/"
    Warn "  Deno 2+:      https://deno.com/"
    Warn "  Git:          https://git-scm.com/"
    Write-Host ""
}

# --- Node.js ---
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

# --- Deno (recommended) ---
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

# --- Git ---
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

# --- npm install ---
Step "Installing Proto-Familiar dependencies (npm install)..."
Push-Location $projectRoot
try {
    & npm install
    if ($LASTEXITCODE -ne 0) { Fail "npm install failed (exit $LASTEXITCODE)." }
} finally { Pop-Location }
Ok "Dependencies installed"

# --- entity-core clone ---
Step "Setting up entity-core-alpha..."
if (Test-Path $entityCoreDir) {
    Ok "Already present at $entityCoreDir"
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

# --- Shortcuts ---
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

Write-Host ""
Write-Host "Install complete." -ForegroundColor Green
Write-Host "Launch any time via:"
Write-Host "  - Desktop shortcut: Proto-Familiar"
Write-Host "  - Start Menu:       Proto-Familiar"
Write-Host "  - Or double-click:  Proto-Familiar.vbs"
Write-Host ""
Start-Sleep -Seconds 2
