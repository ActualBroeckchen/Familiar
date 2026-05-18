@echo off
REM Proto-Familiar installer (Windows)
REM
REM Fresh install: installs Node deps, clones entity-core (release tag)
REM   as a sibling directory, pre-caches its Deno module graph.
REM Update mode: triggered when node_modules\ already exists. Takes a
REM   defensive backup of tomes\, logs\, entity-core data\, and the
REM   Tailscale toggle config into .pf-backups\<timestamp>\ BEFORE any
REM   git op, then pulls latest Proto-Familiar via `git pull --ff-only`,
REM   refreshes entity-core to the pinned tag, re-runs idempotent
REM   npm install and deno cache. Re-runs Node/Deno checks (and
REM   auto-install if needed) in both modes. Skips shortcut creation in
REM   update mode.

setlocal EnableDelayedExpansion
set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
for %%I in ("%SCRIPT_DIR%\..") do set "PARENT_DIR=%%~fI"
REM Resolve the entity-core sibling checkout. New installs land in
REM `entity-core\`; older installs from before the rename used
REM `entity-core-alpha\` and we keep using that in place to avoid
REM silent directory moves.
set "ENTITY_CORE_DIR_NEW=%PARENT_DIR%\entity-core"
set "ENTITY_CORE_DIR_LEGACY=%PARENT_DIR%\entity-core-alpha"
if exist "%ENTITY_CORE_DIR_NEW%" (
  set "ENTITY_CORE_DIR=%ENTITY_CORE_DIR_NEW%"
  set "ENTITY_CORE_DIR_REL=entity-core"
) else if exist "%ENTITY_CORE_DIR_LEGACY%" (
  set "ENTITY_CORE_DIR=%ENTITY_CORE_DIR_LEGACY%"
  set "ENTITY_CORE_DIR_REL=entity-core-alpha"
) else (
  set "ENTITY_CORE_DIR=%ENTITY_CORE_DIR_NEW%"
  set "ENTITY_CORE_DIR_REL=entity-core"
)
REM Release page: https://github.com/PsycherosAI/Psycheros/releases/tag/<tag>
set "ENTITY_CORE_REPO=https://github.com/PsycherosAI/Psycheros.git"
set "ENTITY_CORE_TAG=entity-core-v0.2.2"
set "BACKUP_ROOT=%SCRIPT_DIR%\.pf-backups"

REM --- Detect mode ---
if exist "%SCRIPT_DIR%\node_modules" (
  set "MODE=update"
  echo === Proto-Familiar updater ^(existing install detected^) ===
) else (
  set "MODE=install"
  echo === Proto-Familiar installer ===
)
echo Working dir: %SCRIPT_DIR%
echo.

REM --- Pre-pull data backup (update mode only) ---
REM Defensive copy of at-risk dirs into .pf-backups\<timestamp>\ before
REM any git op runs. Safety net on top of git's own protections.
set "ANYTHING_BACKED_UP=0"
if "!MODE!"=="update" (
  for /f "tokens=2 delims==" %%T in ('wmic os get LocalDateTime /value ^| find "="') do set "DT=%%T"
  set "STAMP=!DT:~0,8!T!DT:~8,6!Z"
  set "BACKUP_DIR=%BACKUP_ROOT%\!STAMP!"
  call :backupIfExists      "%SCRIPT_DIR%\tomes" "tomes"
  call :backupIfExists      "%SCRIPT_DIR%\logs"  "logs"
  REM Probe BOTH the new entity-core dir and the pre-rename legacy
  REM entity-core-alpha so leftover data from before the rename still
  REM gets backed up.
  call :backupIfExists      "%ENTITY_CORE_DIR_NEW%\packages\entity-core\data"    "entity-core\packages\entity-core\data"
  call :backupIfExists      "%ENTITY_CORE_DIR_NEW%\data"                          "entity-core\data"
  call :backupIfExists      "%ENTITY_CORE_DIR_LEGACY%\packages\entity-core\data" "entity-core-alpha\packages\entity-core\data"
  call :backupIfExists      "%ENTITY_CORE_DIR_LEGACY%\data"                       "entity-core-alpha\data"
  call :backupFileIfExists  "%SCRIPT_DIR%\.proto-familiar-config.json"     ".proto-familiar-config.json"
  call :backupFileIfExists  "%SCRIPT_DIR%\settings.json"                   "settings.json"
  if "!ANYTHING_BACKED_UP!"=="1" (
    echo User data backed up to !BACKUP_DIR!\
    echo   ^(tomes\, logs\, entity-core data\, .proto-familiar-config.json, settings.json — restore by copying back if needed^)
  )
)

REM --- Pull latest Proto-Familiar (update mode only) ---
if "!MODE!"=="update" if exist "%SCRIPT_DIR%\.git" (
  where git >nul 2>nul
  if not errorlevel 1 (
    echo Pulling latest Proto-Familiar ^(git pull --ff-only^)...
    pushd "%SCRIPT_DIR%"
    git pull --ff-only
    if errorlevel 1 echo [WARN] git pull --ff-only failed. Work tree is unchanged.
    popd
  )
)

REM --- Node.js check (install if missing, in both modes) ---
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed. Install Node 18+ from https://nodejs.org/ and re-run.
  pause
  exit /b 1
)
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if !NODE_MAJOR! LSS 18 (
  echo [ERROR] Node.js !NODE_MAJOR! detected. Proto-Familiar needs Node 18 or newer.
  pause
  exit /b 1
)
for /f %%v in ('node -v') do echo Node.js %%v found.

REM --- Deno check ---
where deno >nul 2>nul
if errorlevel 1 (
  echo [WARN] Deno not found. entity-core needs Deno 2+; install from https://deno.com/ if you want the identity layer.
) else (
  echo Deno found.
)

REM --- npm install (idempotent) ---
echo.
echo === Running npm install ===
pushd "%SCRIPT_DIR%"
call npm install
if errorlevel 1 (
  popd
  echo [ERROR] npm install failed.
  pause
  exit /b 1
)
popd

REM --- entity-core: clone (install) or refresh to pinned tag (update) ---
REM Note: entity-core's runtime data\ is gitignored at both workspace and
REM package root, so `git checkout <tag>` never touches user data.
if exist "%ENTITY_CORE_DIR%" (
  if "!MODE!"=="update" if exist "%ENTITY_CORE_DIR%\.git" (
    where git >nul 2>nul
    if not errorlevel 1 (
      echo Refreshing entity-core to tag %ENTITY_CORE_TAG%...
      pushd "%ENTITY_CORE_DIR%"
      git fetch --tags --depth 1 origin refs/tags/%ENTITY_CORE_TAG%:refs/tags/%ENTITY_CORE_TAG% >nul 2>nul
      git checkout --quiet %ENTITY_CORE_TAG%
      if errorlevel 1 echo [WARN] Could not refresh entity-core to %ENTITY_CORE_TAG%. Keeping current checkout.
      popd
    )
  ) else (
    echo entity-core already present at %ENTITY_CORE_DIR% - skipping clone.
  )
) else (
  where git >nul 2>nul
  if errorlevel 1 (
    echo [WARN] git not found - skipping entity-core clone. Install git or place entity-core at %ENTITY_CORE_DIR% manually.
  ) else (
    echo Cloning entity-core ^(%ENTITY_CORE_TAG%^) into %ENTITY_CORE_DIR% ...
    git clone --depth 1 --branch %ENTITY_CORE_TAG% %ENTITY_CORE_REPO% "%ENTITY_CORE_DIR%"
    if errorlevel 1 (
      echo [WARN] Tag clone failed; falling back to default branch.
      git clone --depth 1 %ENTITY_CORE_REPO% "%ENTITY_CORE_DIR%"
    )
  )
)

REM --- entity-core dependency pre-cache (idempotent) ---
set "ENTITY_CORE_PKG="
if exist "%ENTITY_CORE_DIR%\packages\entity-core\src\mod.ts" (
  set "ENTITY_CORE_PKG=%ENTITY_CORE_DIR%\packages\entity-core"
) else if exist "%ENTITY_CORE_DIR%\src\mod.ts" (
  set "ENTITY_CORE_PKG=%ENTITY_CORE_DIR%"
)
where deno >nul 2>nul
if not errorlevel 1 if defined ENTITY_CORE_PKG (
  echo Caching entity-core dependencies ^(only fetches what's new^)...
  pushd "%ENTITY_CORE_PKG%"
  deno cache src/mod.ts >nul 2>nul
  if errorlevel 1 (
    echo [WARN] deno cache failed - first server start will download deps before entity-core comes up.
  ) else (
    echo entity-core dependencies cached.
  )
  popd
)

echo.
if "!MODE!"=="update" (
  echo === Update complete ===
  if "!ANYTHING_BACKED_UP!"=="1" echo Pre-update backup: !BACKUP_DIR!
) else (
  echo === Install complete ===
)
echo   Start:     start.bat   ^(double-click^)
echo   Stop:      stop.bat    ^(double-click^)
echo   Trouble?   see docs\troubleshooting.md
echo.
pause
endlocal
goto :eof

REM --- Helper: copy directory %1 into %BACKUP_DIR%\%2 if it exists and is non-empty
:backupIfExists
if not exist "%~1" goto :eof
dir /b /a "%~1" 2>nul | findstr "." >nul
if errorlevel 1 goto :eof
if not exist "!BACKUP_DIR!\%~2" mkdir "!BACKUP_DIR!\%~2" >nul 2>nul
xcopy /e /q /h /y /i "%~1" "!BACKUP_DIR!\%~2" >nul
set "ANYTHING_BACKED_UP=1"
goto :eof

REM --- Helper: copy single file %1 into %BACKUP_DIR%\%2 if it exists
:backupFileIfExists
if not exist "%~1" goto :eof
for %%I in ("!BACKUP_DIR!\%~2") do set "DEST_DIR=%%~dpI"
if not exist "!DEST_DIR!" mkdir "!DEST_DIR!" >nul 2>nul
copy /y "%~1" "!BACKUP_DIR!\%~2" >nul
set "ANYTHING_BACKED_UP=1"
goto :eof
