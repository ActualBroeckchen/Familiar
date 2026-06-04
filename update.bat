@echo off
REM Proto-Familiar one-click updater (Windows) - double-click to run.
REM
REM For installs made by downloading the ZIP rather than `git clone`: the
REM installer can't `git pull` those, so this fetches the latest code from
REM GitHub and lays it over the current folder, then runs install.bat for
REM dependencies + database migrations.
REM
REM Your data is preserved. settings.json, logs\, saved tomes, Unruh's
REM database, and the entity-core sibling folder are NOT part of the
REM download, so copying the new files over the old ones can't touch them.
REM install.bat also auto-backs up tomes\, logs\, settings, and entity-core
REM data into .pf-backups\ before doing anything.
REM
REM If you installed with `git clone`, you don't need this - just re-run
REM install.bat; it does `git pull` for you.

setlocal EnableExtensions
set "SCRIPT_DIR=%~dp0"
set "DEST=%SCRIPT_DIR:~0,-1%"
REM BRANCH defaults to `main`. Override to test a feature branch BEFORE
REM it lands on main:
REM   set BRANCH=claude/implement-unruh-mechanism-NTpoc
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
