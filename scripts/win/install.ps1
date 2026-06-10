# Proto-Familiar Windows installer
#
# Fresh install: auto-installs Node, Deno, Git, and uv. winget is the
#   preferred path (silent, per-user, no admin) but each tool has a
#   fallback path when winget is absent/broken — Deno + uv via their
#   official PowerShell one-liners, Node + Git via opening the
#   download page and waiting for the user to confirm. Then runs
#   `npm install`, clones entity-core (release tag), pre-caches its
#   Deno module graph, syncs Unruh's Python venv, and creates Desktop
#   + Start Menu shortcuts.
#
# Update mode: triggered automatically when node_modules\ already exists.
#   Takes a defensive backup of tomes\, logs\, entity-core data\, and
#   .proto-familiar-config.json into .pf-backups\<timestamp>\ BEFORE
#   any git op runs, then pulls latest Proto-Familiar
#   (`git pull --ff-only`), refreshes entity-core to the pinned tag,
#   and re-runs the idempotent npm install + deno cache + uv sync.
#   Node / Deno / Git / uv auto-install still runs if any is missing.
#
# Shortcut creation runs in BOTH modes — it's idempotent (skip if the
#   .lnk already exists). Previously gated on install-mode only, which
#   meant a fresh-clone-with-preserved-node_modules (common after a
#   Windows reinstall that left user dirs intact) silently skipped
#   making the Desktop / Start Menu shortcuts.
#
# Robustness layer (added in 0.4.0-alpha — bluebell-tester install
# silently failed with "logs are empty"):
#   * Every install run appends to .proto-familiar-install.log via
#     Start-Transcript, so a closed console / killed PS child still
#     leaves a visible breadcrumb the user can find without effort.
#   * Pre-flight checks catch the common silent-killer environments
#     before they cascade into a confusing downstream error — OneDrive
#     sync path, restricted PowerShell (AppLocker / WDAC / Constrained
#     Language Mode), unreachable hosts, long install paths, and
#     Mark-of-the-Web zone identifiers on a downloaded-ZIP install.
#   * Every install run ends with a Windows MessageBox showing status,
#     warnings, and the log path, so a frustrated user who closes the
#     console immediately still sees one clear actionable popup.

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
    $entityCoreDir = $entityCoreDirNew
} elseif (Test-Path $entityCoreDirLegacy) {
    $entityCoreDir = $entityCoreDirLegacy
} else {
    $entityCoreDir = $entityCoreDirNew
}
# Release page: https://github.com/PsycherosAI/Psycheros/releases/tag/<tag>
$entityCoreRepo = "https://github.com/PsycherosAI/Psycheros.git"
$entityCoreTag  = "entity-core-v0.3.2"
$backupRoot    = Join-Path $projectRoot ".pf-backups"

# ── Install log + run state ────────────────────────────────────────
# Single source of truth for the install transcript path. Every run
# appends a new banner so successive failed runs accumulate (rather
# than the previous failure getting overwritten before the user gets
# a chance to read it).
$script:installLog           = Join-Path $projectRoot ".proto-familiar-install.log"
$script:installWarnings      = @()
$script:installStatus        = 'pending'
$script:installFailureReason = ''
$script:pfVersion            = 'unknown'

try {
    Add-Content -Path $script:installLog -Value "`n========== Install run $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz')) ==========`n" -ErrorAction SilentlyContinue
    Start-Transcript -Path $script:installLog -Append -Force -ErrorAction Stop | Out-Null
} catch {
    Write-Host "(transcript unavailable: $($_.Exception.Message))" -ForegroundColor Yellow
}

function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Update-EnvPath {
    $env:Path = `
        [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + `
        [System.Environment]::GetEnvironmentVariable("Path","User")
}
function Step($msg)  { Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg)    { Write-Host "    $msg" -ForegroundColor Green }
function Warn($msg)  { Write-Host "!!  $msg" -ForegroundColor Yellow }

# Show a final-state MessageBox so a frustrated user who closes the
# console window immediately still sees the outcome + the log path.
# Falls back to a console-only summary if System.Windows.Forms can't
# be loaded (e.g. PowerShell Core on a headless server — uncommon for
# Proto-Familiar's Windows audience but worth not crashing on).
function Show-InstallSummary {
    $lines = @()
    if ($script:installStatus -eq 'success') {
        $lines += "Proto-Familiar v$($script:pfVersion) installed successfully."
    } elseif ($script:installStatus -eq 'failed') {
        $lines += "Proto-Familiar install FAILED."
        if ($script:installFailureReason) {
            $lines += ""
            $lines += "Reason:"
            $lines += $script:installFailureReason
        }
    } else {
        $lines += "Proto-Familiar install ended unexpectedly."
    }
    if ($script:installWarnings.Count -gt 0) {
        $lines += ""
        $lines += "Warnings:"
        foreach ($w in $script:installWarnings) { $lines += "  - $w" }
    }
    $lines += ""
    $lines += "Install log:"
    $lines += "  $($script:installLog)"

    $body = $lines -join "`r`n"
    Write-Host ""
    Write-Host $body
    Write-Host ""

    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        $icon = if ($script:installStatus -eq 'failed') {
            [System.Windows.Forms.MessageBoxIcon]::Error
        } elseif ($script:installWarnings.Count -gt 0) {
            [System.Windows.Forms.MessageBoxIcon]::Warning
        } else {
            [System.Windows.Forms.MessageBoxIcon]::Information
        }
        [System.Windows.Forms.MessageBox]::Show(
            $body, "Proto-Familiar install",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            $icon
        ) | Out-Null
    } catch {
        # No Forms available — console output above is the fallback.
    }
}

function Fail($msg) {
    Write-Host "XX  $msg" -ForegroundColor Red
    $script:installStatus = 'failed'
    if (-not $script:installFailureReason) { $script:installFailureReason = $msg }
    Show-InstallSummary
    try { Stop-Transcript -ErrorAction Stop | Out-Null } catch {}
    Read-Host "Press Enter to close"
    exit 1
}

# Script-scope trap for anything that throws outside a Fail call (a
# downstream .NET method failing, a third-party tool returning bad
# output, etc.). Without this, $ErrorActionPreference = "Stop" would
# kill the script silently from the user's perspective — no log
# flushed, no MessageBox, no diagnosis.
trap {
    Write-Host "XX  Unhandled error: $($_.Exception.Message)" -ForegroundColor Red
    if ($script:installStatus -ne 'failed') {
        $script:installStatus = 'failed'
        $script:installFailureReason = "Unhandled error: $($_.Exception.Message)"
    }
    Show-InstallSummary
    try { Stop-Transcript -ErrorAction Stop | Out-Null } catch {}
    exit 1
}

# ── Pre-flight checks ──────────────────────────────────────────────
# Catch the common silent-killer environments BEFORE the install
# cascades into an opaque npm / git / deno error that's hard to
# diagnose from log fragments. Hard-fail checks call Fail() with a
# clear actionable message; soft-fail checks add to
# $script:installWarnings so the final MessageBox surfaces them.
function Test-PreFlight {
    Step "Pre-flight checks..."

    # 1. OneDrive sync detection + auto-relocate offer.
    #    OneDrive locks files mid-write while syncing them to the cloud;
    #    npm install hits hundreds of small writes per second and almost
    #    always fails under OneDrive. New Win11 installs back up Documents
    #    and Desktop to OneDrive by default, so users land here by
    #    accident, not on purpose — the installer can't prevent it but
    #    CAN offer to move them out. The safe target is
    #    %LOCALAPPDATA%\Proto-Familiar: outside OneDrive's sync scope,
    #    short path (no MAX_PATH risk), user-writable without admin,
    #    persists across logouts.
    $onedriveRoots = @($env:OneDrive, $env:OneDriveCommercial, $env:OneDriveConsumer) | Where-Object { $_ -and $_.Trim() }
    $underOneDrive = $false
    foreach ($od in $onedriveRoots) {
        if ($projectRoot.StartsWith($od, [System.StringComparison]::OrdinalIgnoreCase)) {
            $underOneDrive = $true
            break
        }
    }
    if ($underOneDrive) {
        $preferredRoot = Join-Path $env:LOCALAPPDATA "Proto-Familiar"
        $canAutoRelocate = -not (Test-Path $preferredRoot)
        $relocated = $false

        if ($canAutoRelocate) {
            $promptBody = @"
Proto-Familiar is currently installed under OneDrive:
  $projectRoot

OneDrive locks files during sync, which breaks npm install. This is
the most common cause of failed Windows installs — Win11 backs up
Documents and Desktop to OneDrive by default, so most users land
here by accident.

Would you like to move it to a safe location now?
  -> $preferredRoot

The original folder stays in place so nothing is lost; you can delete
it manually once the new install is working.
"@
            try {
                Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
                $answer = [System.Windows.Forms.MessageBox]::Show(
                    $promptBody,
                    "Proto-Familiar — relocate out of OneDrive?",
                    [System.Windows.Forms.MessageBoxButtons]::YesNo,
                    [System.Windows.Forms.MessageBoxIcon]::Question
                )
            } catch {
                $answer = [System.Windows.Forms.DialogResult]::No
            }

            if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) {
                Step "Copying $projectRoot -> $preferredRoot ..."
                # robocopy excludes:
                #   .pf-backups\         — old install backups, regrowable
                #   node_modules\        — regenerated by `npm install`
                #   unruh\.venv\         — regenerated by `uv sync`
                #   __pycache__\         — generated at runtime
                #   .git\objects\pack\   — keep, but heavy; user accepts
                # /E   recurse all (incl. empty) dirs
                # /R:1 /W:1  fast retry on the few files OneDrive might still hold open
                # /NFL /NDL /NJH /NJS /NP  quieter output
                $robocopyExclude = @('.pf-backups', 'node_modules', '__pycache__', '.venv')
                $rcArgs = @($projectRoot, $preferredRoot, '/E', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
                $rcArgs += @('/XD') + ($robocopyExclude | ForEach-Object { Join-Path $projectRoot $_ })
                & robocopy @rcArgs | Out-Null
                # robocopy returns 0-7 for "completed with copy"; 8+ is failure.
                if ($LASTEXITCODE -ge 8) {
                    Fail "Could not copy Proto-Familiar to $preferredRoot (robocopy exit $LASTEXITCODE). See $($script:installLog) for the full output, then move the folder manually."
                }
                Ok "Copied to $preferredRoot."

                # Drop a marker in the old folder so the user can find it
                # again and knows it's safe to delete once the new install
                # is verified working.
                $marker = Join-Path $projectRoot "RELOCATED_TO.txt"
                try {
                    @(
                        "Proto-Familiar was relocated out of OneDrive on $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss').",
                        "",
                        "New location:",
                        "  $preferredRoot",
                        "",
                        "Once you've confirmed the new install works (Desktop shortcut launches,",
                        "Proto-Familiar opens in your browser), it's safe to delete this folder."
                    ) | Set-Content -Path $marker -Encoding UTF8 -Force
                } catch {}

                # Re-launch the installer in the new location and exit
                # cleanly. wscript suppresses the second PowerShell
                # console flash; the new install.ps1 will pop its own.
                $newLauncher = Join-Path $preferredRoot "Proto-Familiar.vbs"
                if (Test-Path $newLauncher) {
                    Start-Process "wscript.exe" -ArgumentList "`"$newLauncher`""
                    try {
                        [System.Windows.Forms.MessageBox]::Show(
                            "Proto-Familiar has been moved to:`r`n  $preferredRoot`r`n`r`nThe installer is now running there. Once Proto-Familiar is working, you can safely delete the OneDrive copy at:`r`n  $projectRoot",
                            "Proto-Familiar — relocated",
                            [System.Windows.Forms.MessageBoxButtons]::OK,
                            [System.Windows.Forms.MessageBoxIcon]::Information
                        ) | Out-Null
                    } catch {}
                    # Flush our own transcript; the new install has its own.
                    try { Stop-Transcript -ErrorAction Stop | Out-Null } catch {}
                    exit 0
                } else {
                    Fail "Copied to $preferredRoot but Proto-Familiar.vbs is missing there. Open the new folder in Explorer and run install.bat manually."
                }
            }
            # Fall through to the standard hard-fail if the user declines.
        }

        # Either the target already exists OR the user said No to the
        # relocation prompt. Either way, hard-fail with clear instructions
        # so the user can move the folder themselves and re-run.
        $existsNote = if (-not $canAutoRelocate) {
            "`r`n`r`nNote: $preferredRoot already exists. Either move/delete it first, or pick a different safe path."
        } else { "" }
        Fail @"
Proto-Familiar is installed under OneDrive:
  $projectRoot

OneDrive locks files during sync, which prevents npm install from completing.
Move Proto-Familiar out of OneDrive (for example to $preferredRoot or C:\Proto-Familiar) and re-run the installer.$existsNote
"@
    }

    # 2. Long-path warning. Windows defaults to MAX_PATH = 260 chars.
    #    Deep node_modules trees easily add 170+ chars on top of the
    #    install root, so a long base path puts us in failure territory.
    if ($projectRoot.Length -gt 90) {
        $msg = "Install path is $($projectRoot.Length) characters long: $projectRoot. Windows 260-char limit may cause npm install to fail on deeply nested deps. If install fails, move Proto-Familiar to a shorter path like C:\Proto-Familiar."
        Warn $msg
        $script:installWarnings += $msg
    }

    # 3. Restricted PowerShell. AppLocker / WDAC / Constrained Language
    #    Mode block COM and various .NET calls. Try to instantiate a
    #    benign WScript.Shell — the same COM object the shortcut block
    #    needs later — and fail fast with a clear message rather than
    #    crashing 200 lines down inside the shortcut creation step.
    try {
        $wshProbe = New-Object -ComObject WScript.Shell -ErrorAction Stop
        $null = $wshProbe.SpecialFolders.Item("Desktop")
        try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($wshProbe) | Out-Null } catch {}
    } catch {
        Fail @"
PowerShell is restricted on this machine — most likely by AppLocker, WDAC, or Constrained Language Mode.

The installer cannot create shortcuts or call .NET COM objects under these restrictions, which is common on work-issued laptops or corporate-managed devices.

If this is a work machine, ask IT to allow PowerShell scripts in the Proto-Familiar folder. If it's a personal machine, check Group Policy or antivirus settings.

Details: $($_.Exception.Message)
"@
    }

    # 4. Mark-of-the-Web auto-unblock. Files extracted from a downloaded
    #    GitHub ZIP carry a Zone.Identifier ADS that marks them as
    #    untrusted. SmartScreen / Defender will silently kill scripts
    #    with this flag in some configurations. Unblock-File strips it.
    try {
        $blocked = Get-ChildItem -Path $projectRoot -Recurse -File -ErrorAction SilentlyContinue | Where-Object {
            (Get-Item -LiteralPath $_.FullName -Stream Zone.Identifier -ErrorAction SilentlyContinue) -ne $null
        }
        if ($blocked) {
            Ok "Unblocking $($blocked.Count) project file(s) flagged by SmartScreen (Mark-of-the-Web)..."
            $blocked | Unblock-File -ErrorAction SilentlyContinue
        }
    } catch {
        Warn "Could not unblock Mark-of-the-Web on project files: $($_.Exception.Message)"
    }

    # 5. Network reachability. Each host downstream tooling fetches from
    #    is probed via TCP 443 with a 3-second timeout. Unreachable
    #    hosts add a warning but don't abort — sometimes the user has
    #    a local mirror, or a flaky host recovers between pre-flight
    #    and the actual install step.
    $hostsToProbe = @(
        @{ Name = 'github.com';         Consequence = 'entity-core clone will fail' },
        @{ Name = 'registry.npmjs.org'; Consequence = 'npm install will fail' },
        @{ Name = 'deno.land';          Consequence = 'Deno install + entity-core deps will fail' },
        @{ Name = 'astral.sh';          Consequence = 'uv install will fail (Unruh disabled)' },
        @{ Name = 'pypi.org';           Consequence = 'Unruh Python deps will fail' }
    )
    foreach ($h in $hostsToProbe) {
        $reachable = $false
        $tcp = $null
        try {
            $tcp = New-Object System.Net.Sockets.TcpClient
            $iar = $tcp.BeginConnect($h.Name, 443, $null, $null)
            $reachable = $iar.AsyncWaitHandle.WaitOne(3000) -and $tcp.Connected
        } catch { $reachable = $false }
        finally { if ($tcp) { try { $tcp.Close() } catch {} } }
        if ($reachable) {
            Ok "Network: $($h.Name) reachable"
        } else {
            $msg = "Cannot reach $($h.Name) — $($h.Consequence). Check firewall / proxy / antivirus."
            Warn $msg
            $script:installWarnings += $msg
        }
    }

    Ok "Pre-flight checks done."
}

# Detect mode: existing node_modules => update.
$updateMode = Test-Path (Join-Path $projectRoot "node_modules")

Clear-Host
if ($updateMode) {
    Write-Host "Proto-Familiar updater (existing install detected)" -ForegroundColor Magenta
} else {
    Write-Host "Proto-Familiar installer" -ForegroundColor Magenta
}
Write-Host "Project: $projectRoot"
Write-Host "Install log: $($script:installLog)"
Write-Host ""

# Pre-flight runs in both modes — same silent killers can break an
# update as a fresh install (a OneDrive move, a new corporate AV
# policy since last update, the user moved entity-core into the
# Proto-Familiar folder, etc.).
Test-PreFlight

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
} elseif ($updateMode -and -not (Test-Path (Join-Path $projectRoot ".git")) -and ($env:PF_FROM_UPDATER -ne '1')) {
    # No .git — this is a downloaded ZIP, not a clone. The installer can't
    # pull updates here, so the user would silently stay on this version.
    Warn "This folder is NOT a git checkout - it looks like a downloaded ZIP."
    Warn "  This installer can't pull updates here. To update, double-click"
    Warn "  update.bat - it downloads the latest version and applies it, keeping your data."
    Warn "  (Or reinstall with: git clone https://github.com/ScarletPrinceEury/Proto-Familiar.git)"
}

$haveWinget = Have "winget"
if (-not $haveWinget) {
    Warn "winget not found — falling back to direct installers for missing prerequisites."
    Write-Host ""
}

# Open a URL in the user's default browser and wait for them to confirm
# the install finished, then re-probe PATH. This is the fallback when
# winget is unavailable for a tool that doesn't have a clean
# PowerShell one-liner installer (Node, Git).
function Install-Via-Browser($name, $url, $probeCmd) {
    Warn "$name auto-install isn't possible without winget."
    Write-Host "Opening the $name download page in your browser..."
    Start-Process $url
    Write-Host ""
    Write-Host "Download the installer, run it, accept the defaults, then come back."
    Read-Host "Press Enter once $name is installed (or Ctrl-C to abort)"
    Update-EnvPath
    if (-not (Have $probeCmd)) {
        Warn "$name still isn't on PATH. You may need to open a new terminal and re-run this script."
    }
}

# --- Node.js (install if missing, in both modes) ---
Step "Checking Node.js..."
if (-not (Have "node")) {
    if ($haveWinget) {
        Step "Installing Node.js LTS via winget (per-user, no admin needed)..."
        winget install --id OpenJS.NodeJS.LTS --scope user --silent `
            --accept-source-agreements --accept-package-agreements
        # winget returns non-zero on real failure; if it did, fall through
        # to the browser path so the user isn't dead-ended.
        if ($LASTEXITCODE -ne 0) {
            Warn "winget Node install exited with code $LASTEXITCODE — trying direct download."
            Install-Via-Browser "Node.js LTS" "https://nodejs.org/" "node"
        } else { Update-EnvPath }
    } else {
        Install-Via-Browser "Node.js LTS" "https://nodejs.org/" "node"
    }
}
if (-not (Have "node")) { Fail "Node.js still not on PATH. Close this window, open a new one, and re-run." }
$nodeVersion = (& node -v).TrimStart("v")
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 18) { Fail "Node.js $nodeVersion detected; Proto-Familiar needs 18+." }
Ok "Node.js v$nodeVersion"

# --- Deno (install if missing, in both modes) ---
# Deno's installer writes to ~\.deno\bin\deno.exe. Prime PATH so a
# fresh install is reachable in this script without a shell restart;
# start.sh / Proto-Familiar.vbs do the same probe at launch time.
$denoUserBin = Join-Path $env:USERPROFILE ".deno\bin"
if (Test-Path (Join-Path $denoUserBin "deno.exe")) {
    $env:PATH = $denoUserBin + ";" + $env:PATH
}
Step "Checking Deno..."
if (-not (Have "deno")) {
    $installedViaWinget = $false
    if ($haveWinget) {
        Step "Installing Deno via winget..."
        winget install --id DenoLand.Deno --scope user --silent `
            --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -eq 0) {
            Update-EnvPath
            $installedViaWinget = (Have "deno")
        } else {
            Warn "winget Deno install exited with code $LASTEXITCODE — trying official installer."
        }
    }
    if (-not $installedViaWinget -and -not (Have "deno")) {
        Step "Installing Deno via the official PowerShell script (writes to ~\.deno\bin)..."
        try {
            Invoke-RestMethod https://deno.land/install.ps1 | Invoke-Expression
            if (Test-Path (Join-Path $denoUserBin "deno.exe")) {
                $env:PATH = $denoUserBin + ";" + $env:PATH
            }
        } catch { Warn "Deno auto-install failed — entity-core will be disabled until you install Deno from https://deno.com/" }
    }
}
if (Have "deno") { Ok "Deno present" } else { Warn "Deno missing (Proto-Familiar will still run without entity-core)" }

# --- Git (install if missing, in both modes) ---
Step "Checking Git..."
if (-not (Have "git")) {
    $installedViaWinget = $false
    if ($haveWinget) {
        Step "Installing Git via winget..."
        winget install --id Git.Git --scope user --silent `
            --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -eq 0) {
            Update-EnvPath
            $installedViaWinget = (Have "git")
        } else {
            Warn "winget Git install exited with code $LASTEXITCODE — trying direct download."
        }
    }
    if (-not $installedViaWinget -and -not (Have "git")) {
        Install-Via-Browser "Git for Windows" "https://git-scm.com/download/win" "git"
    }
}
if (Have "git") { Ok "Git present" } else { Warn "Git missing — entity-core clone will be skipped" }

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

# --- uv (install if missing, in both modes) ---
# uv is the Python package/runtime manager Unruh uses. Astral's installer
# writes to %USERPROFILE%\.local\bin\uv.exe by default. winget has a uv
# package too; prefer it when available for consistency with how we
# handle Node/Deno/Git, fall back to the official one-liner.
Step "Checking uv..."
$uvDefaultPath = Join-Path $env:USERPROFILE ".local\bin\uv.exe"
if (Test-Path $uvDefaultPath) {
    # Prime PATH so subsequent `uv sync` and Have "uv" see it without
    # a shell restart (symmetric to what Update-EnvPath does for winget).
    $env:PATH = (Join-Path $env:USERPROFILE ".local\bin") + ";" + $env:PATH
}
if (-not (Have "uv")) {
    if ($haveWinget) {
        Step "Installing uv via winget..."
        try {
            winget install --id astral-sh.uv --scope user --silent `
                --accept-source-agreements --accept-package-agreements
            Update-EnvPath
        } catch { Warn "winget uv install failed - trying Astral's official installer..." }
    }
    if (-not (Have "uv")) {
        Step "Installing uv via the official Astral script (writes to ~\.local\bin)..."
        try {
            Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression
            if (Test-Path $uvDefaultPath) {
                $env:PATH = (Join-Path $env:USERPROFILE ".local\bin") + ";" + $env:PATH
            }
        } catch { Warn "uv auto-install failed - Unruh (temporal context) will be disabled until you install uv from https://docs.astral.sh/uv/." }
    }
}
if (Have "uv") { Ok "uv present" } else { Warn "uv missing (Proto-Familiar will still run without Unruh)" }

# --- Unruh dependency sync (idempotent; fast when nothing changed) ---
$unruhDir = Join-Path $projectRoot "unruh"
if ((Have "uv") -and (Test-Path (Join-Path $unruhDir "pyproject.toml"))) {
    Step "Syncing Unruh dependencies (only fetches what's new)..."
    Push-Location $unruhDir
    try {
        & uv sync --quiet
        if ($LASTEXITCODE -eq 0) {
            Ok "Unruh dependencies synced"
            # Apply any pending DB migrations now (idempotent) so a schema
            # change shipped in this update is in place before the first
            # chat rather than lazily on first connect. Best-effort.
            & uv run --no-sync python -c "from unruh.db import get_conn; get_conn().close()" 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) { Ok "Unruh database up to date" }
            else { Warn "Unruh DB migration step skipped - it will apply on first start." }
        }
        else { Warn "uv sync failed - Unruh will be disabled until this is resolved." }
    } finally { Pop-Location }
} elseif (Test-Path (Join-Path $unruhDir "pyproject.toml")) {
    Warn "Skipping Unruh dep sync (uv not available). Temporal context will be disabled until uv is installed."
}

# --- Shortcuts (idempotent — runs in both modes) ---
# Previously gated on `-not $updateMode`, which silently skipped
# shortcut creation when node_modules already existed (common after a
# Windows reinstall that preserved user dirs, or if `npm install` was
# run from a terminal before the .vbs was first double-clicked). We
# now create each shortcut if and only if the .lnk file doesn't
# already exist — safe to re-run, no surprise overwrites.
Step "Checking Desktop and Start Menu shortcuts..."
$launcher  = Join-Path $projectRoot "Proto-Familiar.vbs"
$desktop   = [Environment]::GetFolderPath("Desktop")
$startMenu = [Environment]::GetFolderPath("Programs")
try {
    $wsh = New-Object -ComObject WScript.Shell
    foreach ($linkPath in @(
        (Join-Path $desktop   "Proto-Familiar.lnk"),
        (Join-Path $startMenu "Proto-Familiar.lnk")
    )) {
        if (Test-Path $linkPath) {
            Ok "  exists: $linkPath"
            continue
        }
        # GetFolderPath returns '' for unusual profiles; skip rather
        # than dropping a .lnk at the filesystem root.
        $parent = Split-Path -Parent $linkPath
        if (-not $parent -or -not (Test-Path $parent)) {
            Warn "  parent folder missing for $linkPath — skipped"
            continue
        }
        $sc = $wsh.CreateShortcut($linkPath)
        $sc.TargetPath       = "wscript.exe"
        $sc.Arguments        = """$launcher"""
        $sc.WorkingDirectory = $projectRoot
        $sc.IconLocation     = "shell32.dll,13"
        $sc.Description      = "Proto-Familiar"
        $sc.WindowStyle      = 7  # minimized; doesn't actually show because wscript is windowless
        $sc.Save()
        Ok "  created: $linkPath"
    }
} catch {
    Warn "Shortcut creation failed: $($_.Exception.Message)"
    Warn "  You can still launch via Proto-Familiar.vbs in this folder."
}

# Completion marker. Only reached after npm install succeeded (Fail
# above exits otherwise). The launchers check for this instead of
# node_modules to decide whether to (re)run the installer —
# node_modules can exist without the installer having run (a manual
# `npm install`), which would skip entity-core clone + shortcut
# creation. The marker is the reliable "installer actually completed"
# signal. Content is the version, for debugging.
$pfVersion = "unknown"
try { $pfVersion = (Get-Content (Join-Path $projectRoot "package.json") -Raw | ConvertFrom-Json).version } catch {}
try { Set-Content -Path (Join-Path $projectRoot ".pf-install-complete") -Value $pfVersion -Encoding ASCII } catch {}

Write-Host ""
if ($updateMode) {
    Write-Host "Update complete." -ForegroundColor Green
    if ($anythingBackedUp) { Write-Host "Pre-update backup: $backupDir" -ForegroundColor Green }
} else {
    Write-Host "Install complete." -ForegroundColor Green
}
# Show version + branch so it's verifiable here, and a wrong-branch
# checkout (e.g. a ZIP of main missing newer work) is obvious.
Write-Host "Version: Proto-Familiar v$pfVersion" -ForegroundColor Green
if ((Test-Path (Join-Path $projectRoot ".git")) -and (Have "git")) {
    $pfBranch = (& git -C $projectRoot rev-parse --abbrev-ref HEAD 2>$null)
    if ($pfBranch) { Write-Host "Branch:  $pfBranch" -ForegroundColor Green }
} else {
    Write-Host "Branch:  (not a git checkout - downloaded ZIP; update with update.bat)" -ForegroundColor Yellow
}
Write-Host "Launch any time via:"
Write-Host "  - Desktop shortcut: Proto-Familiar"
Write-Host "  - Start Menu:       Proto-Familiar"
Write-Host "  - Or double-click:  Proto-Familiar.vbs"
Write-Host ""
Write-Host "Trouble? See docs\troubleshooting.md"
Write-Host ""

# Final summary MessageBox + transcript flush. The MessageBox is the
# safety net for users who close the console immediately or whose
# console got hidden behind other windows — they still see one clear
# popup with status, warnings, and the log path.
$script:installStatus = 'success'
$script:pfVersion = $pfVersion
Show-InstallSummary
try { Stop-Transcript -ErrorAction Stop | Out-Null } catch {}
Start-Sleep -Seconds 2
