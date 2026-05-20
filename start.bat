@echo off
REM Proto-Familiar launcher (Windows) - double-click to run.
REM
REM Responsibilities, in order:
REM   1. Detect & recycle any stale Proto-Familiar instance holding
REM      the configured port (via PID file + Win32_Process+CommandLine
REM      heuristic matching this project dir).
REM   2. Trigger install.bat if node_modules or unruh\.venv is missing.
REM   3. Prime PATH so the spawned node sees deno (entity-core) and uv
REM      (Unruh) — the MCP children thalamus.js spawns.
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

REM Already running? PID alive *and* configured port responding.
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

REM Find every node.exe process whose CommandLine references server.js
REM and whose ExecutablePath / CommandLine is rooted at this project dir.
REM Catches instances launched outside this script (manual `npm start`,
REM leftovers from before a port migration that may still be listening
REM on the old port, etc).
for /f %%P in ('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'server\.js' -and $_.CommandLine -match [regex]::Escape('%SCRIPT_DIR%') } | ForEach-Object { $_.ProcessId }" 2^>nul') do (
  if not "%%P"=="!EXISTING_PID!" (
    set "STRAY_PIDS=!STRAY_PIDS! %%P"
  ) else (
    if not "!PORT_LISTENING!"=="1" set "STRAY_PIDS=!STRAY_PIDS! %%P"
  )
)

if "!PID_ALIVE!"=="1" if "!PORT_LISTENING!"=="1" if not defined STRAY_PIDS (
  echo Proto-Familiar already running ^(PID !EXISTING_PID!^) on port %PORT%.
  goto :open_browser
)
if defined STRAY_PIDS (
  echo Killing stray Proto-Familiar processes:!STRAY_PIDS! ^(leftovers / other ports^)
  for %%P in (!STRAY_PIDS!) do taskkill /PID %%P /T /F >nul 2>nul
  set "STRAY_PIDS="
)
if "!PID_ALIVE!"=="1" (
  echo Found stale Proto-Familiar process ^(PID !EXISTING_PID!^) not on port %PORT% — restarting.
  taskkill /PID !EXISTING_PID! /T /F >nul 2>nul
  del "%PID_FILE%" >nul 2>nul
)

REM Trigger the installer if it hasn't completed here. The
REM .pf-install-complete marker (written at the end of a successful
REM install) is the reliable signal — node_modules can exist from a
REM manual `npm install` without the installer having run, which would
REM leave entity-core uncloned and the Desktop/Start Menu shortcuts
REM uncreated. node_modules + the Unruh venv stay as additional
REM triggers in case they're removed after a complete install.
set "NEED_INSTALL=0"
if not exist "%SCRIPT_DIR%\.pf-install-complete" set "NEED_INSTALL=1"
if not exist "%SCRIPT_DIR%\node_modules" set "NEED_INSTALL=1"
if exist "%SCRIPT_DIR%\unruh\pyproject.toml" if not exist "%SCRIPT_DIR%\unruh\.venv" set "NEED_INSTALL=1"
if "!NEED_INSTALL!"=="1" (
  echo Running installer to complete setup...
  call "%SCRIPT_DIR%\install.bat"
)

REM Prime PATH for the MCP children thalamus.js spawns. Deno (entity-core)
REM is spawned via a bare `deno` command with NO resolver fallback, so if
REM it was installed by the official script (writes to %USERPROFILE%\.deno\bin)
REM but the shell hasn't reloaded, the spawn fails with ENOENT and the
REM identity layer silently doesn't load. uv (Unruh) has its own resolver
REM in thalamus.js but priming here is symmetric and avoids relying on it.
REM Mirrors start.sh / Proto-Familiar.command / tray.ps1, which prime both.
where deno >nul 2>nul
if errorlevel 1 (
  if exist "%USERPROFILE%\.deno\bin\deno.exe" set "PATH=%USERPROFILE%\.deno\bin;%PATH%"
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
