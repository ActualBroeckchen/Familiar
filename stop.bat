@echo off
REM Proto-Familiar shutdown (Windows) - double-click to run.

setlocal EnableDelayedExpansion
set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "PID_FILE=%SCRIPT_DIR%\.proto-familiar.pid"

if not exist "%PID_FILE%" (
  echo No PID file found - Proto-Familiar does not appear to be running.
  timeout /t 3 >nul
  exit /b 0
)

set /p PID=<"%PID_FILE%"
tasklist /FI "PID eq !PID!" 2>nul | find "!PID!" >nul
if errorlevel 1 (
  echo Process !PID! is not running.
) else (
  echo Stopping Proto-Familiar ^(PID !PID!^) and any child processes...
  REM /T kills the process tree so entity-core child is also stopped.
  taskkill /PID !PID! /T /F >nul 2>nul
  echo Stopped.
)

del /q "%PID_FILE%" >nul 2>nul
timeout /t 2 >nul
endlocal
