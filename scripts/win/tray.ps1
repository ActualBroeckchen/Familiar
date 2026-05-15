# Proto-Familiar - Windows system-tray app
# Left-click the tray icon to open the browser. Right-click for Start/Stop/Restart/Logs/Quit.
# Quit gracefully stops both Proto-Familiar and its entity-core child process.

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
$script:port        = if ($env:PORT) { $env:PORT } else { "3000" }
$script:url         = "http://localhost:$($script:port)"
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

function Start-Server {
    if (Test-Port) { Set-Status "running"; return }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        [System.Windows.Forms.MessageBox]::Show(
            "Node.js is not on PATH. Run the installer (double-click Proto-Familiar.vbs while node_modules is missing, or run scripts\win\install.ps1).",
            "Proto-Familiar", "OK", "Error") | Out-Null
        return
    }
    Set-Status "starting"
    $env:PORT = $script:port
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
    $targetPid = $null
    if ($script:serverProc -and -not $script:serverProc.HasExited) {
        $targetPid = $script:serverProc.Id
    } elseif (Test-Path $script:pidFile) {
        $targetPid = (Get-Content $script:pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    }
    if ($targetPid) {
        Start-Process -FilePath "taskkill.exe" -ArgumentList "/PID $targetPid /T /F" -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue
    }
    Remove-Item $script:pidFile -ErrorAction SilentlyContinue
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
