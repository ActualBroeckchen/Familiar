@echo off
REM Familiar one-click updater (Windows) - double-click to run.
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
set "REPO_SLUG=ActualBroeckchen/Familiar"
set "REPO_ZIP=https://github.com/%REPO_SLUG%/archive/refs/heads/%BRANCH%.zip"

REM A git checkout should update via install.bat's git pull, not an overlay.
if exist "%DEST%\.git" (
  echo This is a git checkout - just run install.bat; it updates via git pull.
  pause
  exit /b 0
)

REM Refuse to overlay files while Familiar is still running. robocopy
REM can't overwrite source files that node.exe has open (server.js, loaded
REM modules), so the update would partially-succeed and the running process
REM would keep serving the old code — exactly the "previous version in the
REM corner after update" symptom. We use stop.bat (which knows how to kill
REM the tracked PID and the port owner) so the update can proceed cleanly.
REM PORT is the variable every other script (start.bat, start.sh, server.js)
REM reads; PROTO_FAMILIAR_PORT is kept as a legacy fallback.
set "PF_PORT=8742"
if not "%PROTO_FAMILIAR_PORT%"=="" set "PF_PORT=%PROTO_FAMILIAR_PORT%"
if not "%PORT%"=="" set "PF_PORT=%PORT%"
for /f %%R in ('powershell -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient('127.0.0.1', [int]'%PF_PORT%'); $c.Close(); 'busy' } catch { 'free' }" 2^>nul') do set "PORT_STATE=%%R"
set "WAS_RUNNING=0"
if "%PORT_STATE%"=="busy" (
  set "WAS_RUNNING=1"
  echo Familiar is still running on port %PF_PORT% — stopping it
  echo before applying the update so file replacements can land...
  call "%DEST%\stop.bat" >nul 2>nul
  for /f %%R in ('powershell -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient('127.0.0.1', [int]'%PF_PORT%'); $c.Close(); 'busy' } catch { 'free' }" 2^>nul') do set "PORT_STATE=%%R"
  if "!PORT_STATE!"=="busy" (
    echo [ERROR] Could not stop Familiar — something is still on port %PF_PORT%.
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

echo Downloading the latest Familiar...
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
REM so a repo/branch rename (or a differently-named fork) doesn't silently
REM break the updater — any single top-level dir with a package.json is it.
set "SRC="
for /d %%D in ("%TMP%\x\*") do if exist "%%D\package.json" set "SRC=%%D"
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

REM Update the updater scripts too - but SAFELY. cmd reads a running batch
REM file from disk as it goes, so overwriting update.bat mid-run corrupts
REM this very execution. Stage the new copies as *.pfnew now; a detached
REM helper swaps them into place AFTER this script exits (see the very end).
REM Without this, download installs keep a stale updater forever, so a fix
REM to the update flow itself never reaches the people who need it.
for %%F in (update.bat update.sh update.command) do (
  if exist "%SRC%\%%F" copy /y "%SRC%\%%F" "%DEST%\%%F.pfnew" >nul 2>nul
)
REM Drop them from the source so the bulk overlay below can't overwrite the
REM script we're currently running.
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

REM Restart the server if it was running before the update, so the new code
REM actually takes effect (a stopped-but-not-restarted install leaves the ward
REM staring at an app that never comes back, or an old process if they relaunch
REM the wrong way). start.bat launches a fresh server and reopens the browser.
if "%WAS_RUNNING%"=="1" (
  echo.
  echo Restarting Familiar so the new version takes effect...
  call "%DEST%\start.bat"
  echo.
  echo === Update complete - Familiar restarted on the new version. ===
  echo     Reload the browser tab if it doesn't refresh on its own.
) else (
  echo.
  echo === Update complete. Start Familiar to use the new version. ===
)
echo.
pause
REM Swap the staged updater scripts into place AFTER this script exits: a
REM detached helper waits a beat for cmd to release update.bat, then renames
REM the .pfnew files over the old ones. The next update run uses the fresh
REM updater. Harmless when nothing was staged.
start "" /min cmd /c "timeout /t 2 /nobreak >nul & for %%F in (update.bat update.sh update.command) do if exist "%DEST%\%%F.pfnew" move /y "%DEST%\%%F.pfnew" "%DEST%\%%F" >nul 2>nul"
endlocal
