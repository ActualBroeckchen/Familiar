@echo off
REM Proto-Familiar launcher (Windows) - double-click to run.

setlocal EnableDelayedExpansion
set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
if "%PORT%"=="" set "PORT=3000"
set "URL=http://localhost:%PORT%"
set "PID_FILE=%SCRIPT_DIR%\.proto-familiar.pid"
set "LOG_FILE=%SCRIPT_DIR%\.proto-familiar.log"

REM Already running?
if exist "%PID_FILE%" (
  set /p EXISTING_PID=<"%PID_FILE%"
  tasklist /FI "PID eq !EXISTING_PID!" 2>nul | find "!EXISTING_PID!" >nul
  if not errorlevel 1 (
    echo Proto-Familiar already running ^(PID !EXISTING_PID!^).
    goto :open_browser
  )
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
