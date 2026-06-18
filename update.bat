@echo off
REM Proto-Familiar one-click updater (Windows) - double-click to run.
REM
REM For installs made by downloading the ZIP rather than `git clone`: the
REM installer can't `git pull` those, so this fetches the latest code from
REM GitHub and lays it over the current folder, then runs install.bat for
REM dependencies + database migrations.
REM
REM Your data is preserved. settings.json, logs\, saved tomes, and the
REM Unruh + Phylactery databases are NOT part of the download, so copying
REM the new files over the old ones can't touch them. install.bat also
REM auto-backs up tomes\, logs\, settings, and phylactery\data\ into
REM .pf-backups\ before doing anything.
REM
REM If you installed with `git clone`, you don't need this - just re-run
REM install.bat; it does `git pull` for you.

setlocal EnableExtensions EnableDelayedExpansion
set "SCRIPT_DIR=%~dp0"
set "DEST=%SCRIPT_DIR:~0,-1%"
REM BRANCH defaults to `main`. Override to test a feature branch BEFORE
REM it lands on main:
REM   set BRANCH=my-feature-branch
REM   update.bat
REM GitHub's archive endpoint accepts branch names with slashes verbatim.
if "%BRANCH%"=="" set "BRANCH=main"
set "REPO_ZIP=https://github.com/ScarletPrinceEury/Proto-Familiar/archive/refs/heads/%BRANCH%.zip"

REM A git checkout should update via install.bat's git pull, not an overlay.
if exist "%DEST%\.git" (
  echo This is a git checkout - just run install.bat; it updates via git pull.
  pause
  exit /b 0
)

REM Refuse to overlay files while Proto-Familiar is still running. robocopy
REM can't overwrite source files that node.exe has open (server.js, loaded
REM modules), so the update would partially-succeed and the running process
REM would keep serving the old code — exactly the "previous version in the
REM corner after update" symptom. We use stop.bat (which knows how to kill
REM the tracked PID and the port owner) so the update can proceed cleanly.
set "PF_PORT=8742"
if not "%PROTO_FAMILIAR_PORT%"=="" set "PF_PORT=%PROTO_FAMILIAR_PORT%"
for /f %%R in ('powershell -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient('127.0.0.1', [int]'%PF_PORT%'); $c.Close(); 'busy' } catch { 'free' }" 2^>nul') do set "PORT_STATE=%%R"
if "%PORT_STATE%"=="busy" (
  echo Proto-Familiar is still running on port %PF_PORT% — stopping it
  echo before applying the update so file replacements can land...
  call "%DEST%\stop.bat" >nul 2>nul
  for /f %%R in ('powershell -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient('127.0.0.1', [int]'%PF_PORT%'); $c.Close(); 'busy' } catch { 'free' }" 2^>nul') do set "PORT_STATE=%%R"
  if "!PORT_STATE!"=="busy" (
    echo [ERROR] Could not stop Proto-Familiar — something is still on port %PF_PORT%.
    echo         Right-click the tray icon and choose Quit, or open Task Manager,
    echo         find node.exe, end task, then re-run update.bat.
    pause
    exit /b 1
  )
)

set "TMP=%TEMP%\pf_update_%RANDOM%%RANDOM%"
mkdir "%TMP%" 2>nul

if not "%BRANCH%"=="main" (
  echo Updating from branch "%BRANCH%" ^(non-default - set BRANCH=main to switch back^).
)

echo Downloading the latest Proto-Familiar...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing -Uri '%REPO_ZIP%' -OutFile '%TMP%\pf.zip' } catch { exit 1 }"
if errorlevel 1 (
  echo [ERROR] Download failed - check your internet connection.
  rmdir /s /q "%TMP%" 2>nul
  pause
  exit /b 1
)

echo Extracting...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Expand-Archive -Force -LiteralPath '%TMP%\pf.zip' -DestinationPath '%TMP%\x' } catch { exit 1 }"
if errorlevel 1 (
  echo [ERROR] Could not extract the download.
  rmdir /s /q "%TMP%" 2>nul
  pause
  exit /b 1
)

REM Find the extracted top-level folder rather than hardcoding the name,
REM so a repo/branch rename doesn't silently break the updater.
set "SRC="
for /d %%D in ("%TMP%\x\Proto-Familiar-*") do set "SRC=%%D"
if not defined SRC (
  echo [ERROR] Unexpected archive layout - aborting without changing anything.
  rmdir /s /q "%TMP%" 2>nul
  pause
  exit /b 1
)
if not exist "%SRC%\package.json" (
  echo [ERROR] Unexpected archive layout - aborting without changing anything.
  rmdir /s /q "%TMP%" 2>nul
  pause
  exit /b 1
)

REM Never copy the updater scripts over themselves - a running script that
REM gets overwritten mid-run can misbehave. You keep your current ones.
del "%SRC%\update.bat" "%SRC%\update.sh" "%SRC%\update.command" 2>nul

echo Applying update - your settings, memories, tomes, and logs are preserved...
REM robocopy /E copies all subfolders; WITHOUT /MIR or /PURGE it never
REM deletes anything already in the destination, so user data, node_modules,
REM and the Python venv all stay. User data isn't in the download anyway.
robocopy "%SRC%" "%DEST%" /E /NFL /NDL /NJH /NJS /NP >nul
REM robocopy exit codes 0-7 are success; 8+ is a real failure.
if errorlevel 8 (
  echo [ERROR] Copy failed.
  rmdir /s /q "%TMP%" 2>nul
  pause
  exit /b 1
)

rmdir /s /q "%TMP%" 2>nul

echo Running install.bat for dependencies + database migrations...
REM Tell install.bat it's running under the updater so it doesn't print
REM the "not a git checkout - use update.bat" warning back at us.
set "PF_FROM_UPDATER=1"
call "%DEST%\install.bat"

echo.
echo === Update complete. Restart Proto-Familiar to use the new version. ===
echo.
pause
endlocal
