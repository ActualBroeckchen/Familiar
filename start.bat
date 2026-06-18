@echo off
REM Proto-Familiar launcher (Windows) - double-click to run.
REM
REM Responsibilities, in order:
REM   1. Detect & recycle any stale Proto-Familiar instance holding
REM      the configured port (via PID file + Win32_Process+CommandLine
REM      heuristic matching this project dir).
REM   2. Trigger install.bat if node_modules, phylactery\.venv, or unruh\.venv is missing.
REM   3. Prime PATH so the spawned node sees uv (Phylactery + Unruh)
REM      — the MCP children thalamus.js spawns.
REM   4. Launch node server.js detached via PowerShell, write PID file,
REM      wait for the port to come up, open the browser.
REM
REM Stop with stop.bat — kills every node.exe whose CommandLine
REM references server.js in this dir, not just the tracked PID.
REM
REM The system-tray launcher (Proto-Familiar.vbs -> tray.ps1) is the
REM canonical Windows path; this .bat is for terminal users.

setlocal EnableDelayedExpansion
set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
if "%PORT%"=="" set "PORT=8742"
set "URL=http://localhost:%PORT%"
REM TAILSCALE=1 seeds the in-UI "Access from other devices" toggle to ON when
REM .proto-familiar-config.json doesn't exist yet. Once you've used the in-UI
REM toggle, that file is the source of truth and this env var is ignored.
if "%TAILSCALE%"=="" set "TAILSCALE=0"
set "PID_FILE=%SCRIPT_DIR%\.proto-familiar.pid"
set "LOG_FILE=%SCRIPT_DIR%\.proto-familiar.log"

REM Detect existing/stale Proto-Familiar instances. The previous logic
REM filtered Win32_Process by CommandLine matching the project root —
REM but PowerShell's Start-Process -WorkingDirectory does NOT put the
REM cwd into Win32_Process.CommandLine, so that filter NEVER matched
REM in practice and orphans never got killed. (Same bug was the upstream
REM cause of "node.exe sticks around after Quit, blocks updates" reports.)
REM
REM Replacement: the PID file is the canonical "started by our launcher"
REM signal. We trust it. For port collisions where the PID file doesn't
REM cover the owner, we fall back to "kill the port owner if it looks
REM like node.exe + server.js" — same disposition as stop.bat and
REM tray.ps1's Stop-StrayServerProcesses.
set "EXISTING_PID="
set "PID_ALIVE=0"
if exist "%PID_FILE%" (
  set /p EXISTING_PID=<"%PID_FILE%"
  tasklist /FI "PID eq !EXISTING_PID!" 2>nul | find "!EXISTING_PID!" >nul
  if not errorlevel 1 set "PID_ALIVE=1"
)
set "PORT_LISTENING=0"
powershell -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient('127.0.0.1', %PORT%); $c.Close(); exit 0 } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 set "PORT_LISTENING=1"

REM Who owns the port right now? Empty if free.
set "PORT_OWNER="
for /f %%P in ('powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue ^| Select-Object -First 1 -ExpandProperty OwningProcess)" 2^>nul') do set "PORT_OWNER=%%P"

REM Happy path: our tracked PID owns the port. Already running, just open.
if "!PID_ALIVE!"=="1" if "!PORT_LISTENING!"=="1" if "!PORT_OWNER!"=="!EXISTING_PID!" (
  echo Proto-Familiar already running ^(PID !EXISTING_PID!^) on port %PORT%.
  goto :open_browser
)

REM Port held by something OTHER than our tracked PID — an orphan from
REM a previous launcher run whose Stop failed to kill node, or a parallel
REM instance from a different checkout. Reclaim if it looks like one of
REM ours; refuse and report otherwise so we don't kill an unrelated app.
if "!PORT_LISTENING!"=="1" if defined PORT_OWNER if not "!PORT_OWNER!"=="!EXISTING_PID!" (
  for /f "delims=" %%C in ('powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter \"ProcessId=!PORT_OWNER!\" -ErrorAction SilentlyContinue; if ($p -and $p.Name -match '^node(\.exe)?$' -and $p.CommandLine -match 'server\.js') { 'ours' } else { 'foreign' }" 2^>nul') do set "OWNER_KIND=%%C"
  if "!OWNER_KIND!"=="ours" (
    echo Reclaiming port %PORT% from orphaned node.exe ^(PID !PORT_OWNER!^)...
    taskkill /PID !PORT_OWNER! /T /F >nul 2>nul
    set "PORT_LISTENING=0"
  ) else (
    echo [ERROR] Port %PORT% is held by PID !PORT_OWNER!, which does not look like Proto-Familiar.
    echo         Stop that process, or set PORT=^<other^> in this shell and re-run start.bat.
    pause
    exit /b 1
  )
)

REM Tracked PID is alive but isn't on the port (crashed, restarted to a
REM different port, or hung mid-shutdown). Reap it so the new launch
REM doesn't leave a duplicate node.exe lingering.
if "!PID_ALIVE!"=="1" if "!PORT_LISTENING!"=="0" (
  echo Found stale Proto-Familiar process ^(PID !EXISTING_PID!^) not on port %PORT% — restarting.
  taskkill /PID !EXISTING_PID! /T /F >nul 2>nul
  del "%PID_FILE%" >nul 2>nul
)

REM Trigger the installer if it hasn't completed here. The
REM .pf-install-complete marker (written at the end of a successful
REM install) is the reliable signal — node_modules can exist from a
REM manual `npm install` without the installer having run, which would
REM leave the Desktop/Start Menu shortcuts uncreated.
REM Also retriggers when either Python venv is missing so the Familiar
REM doesn't silently degrade if the user deletes a .venv directory.
set "NEED_INSTALL=0"
if not exist "%SCRIPT_DIR%\.pf-install-complete" set "NEED_INSTALL=1"
if not exist "%SCRIPT_DIR%\node_modules" set "NEED_INSTALL=1"
if exist "%SCRIPT_DIR%\unruh\pyproject.toml" if not exist "%SCRIPT_DIR%\unruh\.venv" set "NEED_INSTALL=1"
if exist "%SCRIPT_DIR%\phylactery\pyproject.toml" if not exist "%SCRIPT_DIR%\phylactery\.venv" set "NEED_INSTALL=1"
if "!NEED_INSTALL!"=="1" (
  echo Running installer to complete setup...
  call "%SCRIPT_DIR%\install.bat"
)

REM Prime PATH for the MCP children thalamus.js spawns (Phylactery + Unruh
REM both use uv). Node itself may have just been installed by install.bat
REM above (or by a winget run whose PATH change this console predates).
REM Node LTS now ships from winget as an archive package shimmed under
REM %LOCALAPPDATA%\Microsoft\WinGet\Links, so prime that (and the MSI
REM dirs) before launching, mirroring the installer's refresh.
where node >nul 2>nul
if errorlevel 1 (
  set "PATH=%LOCALAPPDATA%\Microsoft\WinGet\Links;%LOCALAPPDATA%\Programs\nodejs;%ProgramFiles%\nodejs;%PATH%"
)
where uv >nul 2>nul
if errorlevel 1 (
  if exist "%USERPROFILE%\.local\bin\uv.exe" set "PATH=%USERPROFILE%\.local\bin;%PATH%"
)

echo Starting Proto-Familiar on %URL% ^(log: %LOG_FILE%^) ...
pushd "%SCRIPT_DIR%"
REM Launch detached; capture PID via PowerShell.
for /f %%P in ('powershell -NoProfile -Command "$p = Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory '%SCRIPT_DIR%' -WindowStyle Hidden -RedirectStandardOutput '%LOG_FILE%' -RedirectStandardError '%LOG_FILE%.err' -PassThru; $p.Id"') do set "NEW_PID=%%P"
popd
echo !NEW_PID! > "%PID_FILE%"
echo Started PID !NEW_PID!.

REM Wait for port
for /l %%i in (1,1,30) do (
  powershell -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient('127.0.0.1', %PORT%); $c.Close(); exit 0 } catch { exit 1 }" >nul 2>nul
  if not errorlevel 1 goto :open_browser
  timeout /t 1 /nobreak >nul
)

:open_browser
echo Opening %URL% ...
start "" "%URL%"
echo.
echo Done. Double-click stop.bat to shut down.
echo Trouble? See docs\troubleshooting.md
timeout /t 3 >nul
endlocal
