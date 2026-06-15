# Proto-Familiar - Windows system-tray app
# Left-click the tray icon to open the browser. Right-click for Start/Stop/Restart/Logs/Quit.
# Quit gracefully stops Proto-Familiar and its MCP children (Phylactery + Unruh).

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# --- Single instance ---
$mutex = New-Object System.Threading.Mutex($false, "Global\ProtoFamiliarTrayMutex_v1")
if (-not $mutex.WaitOne(0, $false)) {
    [System.Windows.Forms.MessageBox]::Show(
        "Proto-Familiar is already running. Look for the green dot in the system tray (bottom-right of the taskbar, you may need to click the ^ to reveal hidden icons).",
        "Proto-Familiar",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Information
    ) | Out-Null
    exit 0
}

# --- Paths and state ---
$script:projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$script:port        = if ($env:PORT) { $env:PORT } else { "8742" }
$script:url         = "http://localhost:$($script:port)"
$script:tailscale   = if ($env:TAILSCALE) { $env:TAILSCALE } else { "0" }
$script:pidFile     = Join-Path $script:projectRoot ".proto-familiar.pid"
$script:logFile     = Join-Path $script:projectRoot ".proto-familiar.log"
$script:logErrFile  = "$($script:logFile).err"
$script:serverProc  = $null

# --- Icons (drawn in-memory so we don't ship binary assets) ---
function New-DotIcon([System.Drawing.Color]$color) {
    $bmp = New-Object System.Drawing.Bitmap 16, 16
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $brush = New-Object System.Drawing.SolidBrush $color
    $g.FillEllipse($brush, 1, 1, 14, 14)
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(60,60,60)), 1
    $g.DrawEllipse($pen, 1, 1, 14, 14)
    $brush.Dispose(); $pen.Dispose(); $g.Dispose()
    $hicon = $bmp.GetHicon()
    [System.Drawing.Icon]::FromHandle($hicon)
}
$iconRunning  = New-DotIcon ([System.Drawing.Color]::LimeGreen)
$iconStarting = New-DotIcon ([System.Drawing.Color]::Gold)
$iconStopped  = New-DotIcon ([System.Drawing.Color]::Crimson)

# --- Tray icon + menu (declared before functions so handlers can capture them) ---
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $iconStopped
$tray.Text = "Proto-Familiar (stopped)"
$tray.Visible = $true

$menu       = New-Object System.Windows.Forms.ContextMenuStrip
$miOpen     = $menu.Items.Add("Open in browser")
$miStatus   = $menu.Items.Add("Status: stopped"); $miStatus.Enabled = $false
[void]$menu.Items.Add("-")
$miStart    = $menu.Items.Add("Start")
$miStop     = $menu.Items.Add("Stop")
$miRestart  = $menu.Items.Add("Restart")
[void]$menu.Items.Add("-")
$miLogs     = $menu.Items.Add("View logs")
$miFolder   = $menu.Items.Add("Open install folder")
[void]$menu.Items.Add("-")
$miQuit     = $menu.Items.Add("Quit (stops server)")
$tray.ContextMenuStrip = $menu

function Set-Status([string]$state) {
    switch ($state) {
        "running"  { $tray.Icon = $iconRunning;  $tray.Text = "Proto-Familiar - running on $($script:url)"; $miStatus.Text = "Status: running ($($script:url))" }
        "starting" { $tray.Icon = $iconStarting; $tray.Text = "Proto-Familiar - starting...";              $miStatus.Text = "Status: starting..." }
        "stopped"  { $tray.Icon = $iconStopped;  $tray.Text = "Proto-Familiar - stopped";                  $miStatus.Text = "Status: stopped" }
        "failed"   { $tray.Icon = $iconStopped;  $tray.Text = "Proto-Familiar - failed to start";          $miStatus.Text = "Status: failed (see logs)" }
    }
    $miStart.Enabled   = ($state -eq "stopped" -or $state -eq "failed")
    $miStop.Enabled    = ($state -eq "running" -or $state -eq "starting")
    $miRestart.Enabled = ($state -eq "running" -or $state -eq "failed")
}

function Test-Port {
    try { $c = New-Object Net.Sockets.TcpClient('127.0.0.1', [int]$script:port); $c.Close(); return $true } catch { return $false }
}

# Who owns our TCP port right now? Returns the PID or $null. Used to
# detect orphaned node.exe instances (previous Quit didn't kill them,
# so they're still bound to the port) and to verify our kill landed.
function Get-PortOwnerPid {
    try {
        $c = Get-NetTCPConnection -LocalPort ([int]$script:port) -State Listen -ErrorAction SilentlyContinue |
             Select-Object -First 1 -ExpandProperty OwningProcess
        if ($c) { return [int]$c }
    } catch {}
    return $null
}

# Read the PID we wrote when we last launched node. Returns $null if
# missing, malformed, or no longer alive. The PID file is the canonical
# "this is the instance the tray spawned" signal — more reliable than
# trying to match by command-line, because the project root is NOT in
# Win32_Process.CommandLine (it's only in the working directory, which
# Win32_Process doesn't expose). The old filter
#   $_.CommandLine -match $rootPattern
# never matched in practice — that's why Quit/Stop/Restart silently
# failed to kill node and orphaned the process across updates.
function Get-TrackedPid {
    if (-not (Test-Path $script:pidFile)) { return $null }
    try {
        # $pid is a PowerShell automatic variable (this process's own PID) —
        # using it as a local would silently shadow it everywhere else.
        $trackedId = [int](Get-Content -LiteralPath $script:pidFile -ErrorAction Stop).Trim()
        if ($trackedId -le 0) { return $null }
        $p = Get-Process -Id $trackedId -ErrorAction SilentlyContinue
        if ($p) { return $trackedId }
    } catch {}
    return $null
}

# Kill a process AND its child tree. taskkill /T traverses the parent-
# child relationship to catch the MCP children (Phylactery + Unruh, both
# python via uv) that thalamus.js spawns. Stop-Process -Force
# only calls TerminateProcess on the parent, which orphans the
# children — they'd keep running with the port released but their state
# directories locked, which itself can break a subsequent uv sync.
function Stop-ProcessTree([int]$processId) {
    try {
        & taskkill /PID $processId /T /F 2>$null | Out-Null
    } catch {}
}

function Stop-StrayServerProcesses {
    # Step 1: kill what our PID file points at. That's the canonical
    # "spawned by this tray" signal. taskkill /T /F sweeps the tree so
    # MCP children (python via uv) die with it.
    $tracked = Get-TrackedPid
    if ($tracked) { Stop-ProcessTree $tracked }

    # Step 2: wait briefly for the port to release. Without this wait,
    # Start-Server's Test-Port check immediately after Restart could
    # race the kernel's socket-cleanup and see the port as still held.
    for ($i = 0; $i -lt 25; $i++) {
        if (-not (Test-Port)) { break }
        Start-Sleep -Milliseconds 200
    }

    # Step 3: still held? Something is on the port that wasn't our
    # tracked PID — almost always an orphan from a previous tray run
    # whose Quit didn't kill node (the bug this rewrite fixes). Kill
    # the port owner if it looks like a node.exe + server.js; we don't
    # require a project-root match because Win32_Process can't see cwd
    # and the old "matches project root" filter never worked anyway.
    if (Test-Port) {
        $owner = Get-PortOwnerPid
        if ($owner) {
            try {
                $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$owner" -ErrorAction SilentlyContinue
                if ($proc -and $proc.Name -match '^node(\.exe)?$' -and $proc.CommandLine -match 'server\.js') {
                    Stop-ProcessTree $owner
                    for ($i = 0; $i -lt 25; $i++) {
                        if (-not (Test-Port)) { break }
                        Start-Sleep -Milliseconds 200
                    }
                }
            } catch {}
        }
    }

    if (Test-Path $script:pidFile) { Remove-Item $script:pidFile -ErrorAction SilentlyContinue }
}

function Start-Server {
    # Port already in use — figure out WHY before adopting it.
    #
    # Old behaviour: any port-in-use → declare "running" and bail. That
    # is exactly what made the orphan-node bug invisible: Stop failed
    # to kill node (regex bug), Start saw the port held by the orphan,
    # reported "running", and the user saw the OLD version in the UI
    # corner forever. Updates "didn't go through" because the running
    # process was still the pre-update node.
    #
    # New behaviour: if the port owner matches our PID file, that IS
    # our running instance — adopt it. Otherwise it's an orphan; kill
    # it via Stop-StrayServerProcesses and continue to a real launch.
    if (Test-Port) {
        $tracked = Get-TrackedPid
        $owner   = Get-PortOwnerPid
        if ($tracked -and $owner -and ($tracked -eq $owner)) {
            Set-Status "running"
            return
        }
        # Mismatch: a previous node.exe is squatting on the port.
        # Reclaim before we launch a new one.
        Stop-StrayServerProcesses
    }
    # Node may have just been installed by the bundled installer in this
    # same VBS session. The VBS that spawned us inherited its PATH before
    # the install ran, so our PATH predates the new Node entry. Re-read the
    # persisted PATH and prime the WinGet Links shim dir (where winget now
    # puts Node LTS — it ships as an archive package, not an MSI) so the
    # very first launch right after install works without a reboot.
    $env:PATH = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
                [System.Environment]::GetEnvironmentVariable('Path','User') + ';' + $env:PATH
    foreach ($nodeDir in @((Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links'),
                           (Join-Path $env:LOCALAPPDATA 'Programs\nodejs'),
                           (Join-Path $env:ProgramFiles  'nodejs'))) {
        if ((Test-Path $nodeDir) -and ($env:PATH -notlike "*$nodeDir*")) {
            $env:PATH = "$nodeDir;$env:PATH"
        }
    }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        [System.Windows.Forms.MessageBox]::Show(
            "Node.js is not on PATH. Run the installer (double-click Proto-Familiar.vbs while node_modules is missing, or run scripts\win\install.ps1).",
            "Proto-Familiar", "OK", "Error") | Out-Null
        return
    }
    Set-Status "starting"
    # Prime PATH for the MCP children thalamus.js spawns (Phylactery +
    # Unruh, both via uv). uv has its own resolver in thalamus.js, but if
    # it was just installed by the bundled installer in this same session,
    # the child inherits PATH from this PS process — so PATH-priming here
    # means the very first boot after install works without a reboot.
    $uvBin = Join-Path $env:USERPROFILE ".local\bin"
    if ((Test-Path (Join-Path $uvBin "uv.exe")) -and ($env:PATH -notlike "*$uvBin*")) {
        $env:PATH = "$uvBin;$env:PATH"
    }
    $env:PORT = $script:port
    $env:TAILSCALE = $script:tailscale
    try {
        $script:serverProc = Start-Process -FilePath "node" `
            -ArgumentList "server.js" `
            -WorkingDirectory $script:projectRoot `
            -WindowStyle Hidden `
            -RedirectStandardOutput $script:logFile `
            -RedirectStandardError  $script:logErrFile `
            -PassThru
        Set-Content -Path $script:pidFile -Value $script:serverProc.Id -Encoding ASCII
    } catch {
        Set-Status "failed"
        [System.Windows.Forms.MessageBox]::Show("Failed to start: $_", "Proto-Familiar", "OK", "Error") | Out-Null
        return
    }
    for ($i = 0; $i -lt 40; $i++) {
        if (Test-Port) { break }
        if ($script:serverProc.HasExited) { Set-Status "failed"; return }
        Start-Sleep -Milliseconds 500
    }
    if (Test-Port) {
        Set-Status "running"
        $tray.BalloonTipTitle = "Proto-Familiar"
        $tray.BalloonTipText  = "Running at $($script:url) - left-click the tray icon to open."
        $tray.ShowBalloonTip(2500)
    } else {
        Set-Status "failed"
    }
}

function Stop-Server {
    Set-Status "starting"  # transient
    $tray.Text = "Proto-Familiar - stopping..."
    Stop-StrayServerProcesses
    $script:serverProc = $null
    Set-Status "stopped"
}

function Open-Browser { Start-Process $script:url }

function Open-Logs {
    if (Test-Path $script:logFile) {
        Start-Process notepad.exe $script:logFile
    } else {
        [System.Windows.Forms.MessageBox]::Show("No log file yet.", "Proto-Familiar") | Out-Null
    }
}

function Open-Folder { Start-Process explorer.exe $script:projectRoot }

# --- Wire up handlers ---
$miOpen.Add_Click({ Open-Browser })
$miStart.Add_Click({ Start-Server })
$miStop.Add_Click({ Stop-Server })
$miRestart.Add_Click({ Stop-Server; Start-Server })
$miLogs.Add_Click({ Open-Logs })
$miFolder.Add_Click({ Open-Folder })
$miQuit.Add_Click({
    Stop-Server
    $tray.Visible = $false
    $tray.Dispose()
    [System.Windows.Forms.Application]::Exit()
})

# Left-click opens browser; right-click is handled automatically by ContextMenuStrip.
$tray.Add_MouseClick({
    param($s, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Open-Browser }
})

# --- Bootstrap: start server + open browser on launch ---
Start-Server
if ($tray.Text -like "*running*") { Open-Browser }

# --- Run the message loop ---
try {
    [System.Windows.Forms.Application]::Run()
} finally {
    if ($tray) { $tray.Visible = $false; $tray.Dispose() }
    $mutex.ReleaseMutex() | Out-Null
}
