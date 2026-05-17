@echo off
REM Proto-Familiar launcher (Windows) - double-click to run.

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

if "!PID_ALIVE!"=="1" if "!PORT_LISTENING!"=="1" (
  echo Proto-Familiar already running ^(PID !EXISTING_PID!^) on port %PORT%.
  goto :open_browser
)
if "!PID_ALIVE!"=="1" (
  echo Found stale Proto-Familiar process ^(PID !EXISTING_PID!^) not on port %PORT% — restarting.
  taskkill /PID !EXISTING_PID! /T /F >nul 2>nul
  del "%PID_FILE%" >nul 2>nul
)

if not exist "%SCRIPT_DIR%\node_modules" (
  echo Dependencies missing. Running installer first...
  call "%SCRIPT_DIR%\install.bat"
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
