@echo off
REM Proto-Familiar shutdown (Windows) - double-click to run.
REM Stops every node.exe whose CommandLine references server.js and is
REM rooted at this project dir — covers the launcher-tracked PID plus
REM any stray instances (manual `npm start`, leftovers from before a
REM port migration still listening on the old port, etc).

setlocal EnableDelayedExpansion
set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "PID_FILE=%SCRIPT_DIR%\.proto-familiar.pid"

set "KILLED_ANY=0"
for /f %%P in ('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'server\.js' -and $_.CommandLine -match [regex]::Escape('%SCRIPT_DIR%') } | ForEach-Object { $_.ProcessId }" 2^>nul') do (
  echo Stopping Proto-Familiar PID %%P ...
  taskkill /PID %%P /T /F >nul 2>nul
  set "KILLED_ANY=1"
)

if "!KILLED_ANY!"=="0" echo No Proto-Familiar process found in %SCRIPT_DIR%.
if exist "%PID_FILE%" del /q "%PID_FILE%" >nul 2>nul

timeout /t 2 >nul
endlocal
