@echo off
REM Proto-Familiar installer (Windows .bat fallback)
REM
REM The canonical Windows installer is scripts\win\install.ps1 (invoked
REM by Proto-Familiar.vbs). This .bat exists for users whose PowerShell
REM execution is locked down and who run .bat scripts manually instead.
REM Keeps feature parity with install.ps1 on the essentials: Node, Deno,
REM Git, uv, npm install, entity-core clone + deno cache, Unruh uv sync,
REM and Desktop/Start Menu shortcut creation. winget is the preferred
REM auto-install path when present; manual download URLs are surfaced
REM as a clear fallback otherwise.
REM
REM Fresh install: auto-installs Node / Deno / Git / uv via winget when
REM   available, runs npm install, clones entity-core (release tag),
REM   pre-caches its Deno module graph, syncs Unruh's Python venv from
REM   unruh\uv.lock, and creates Desktop + Start Menu shortcuts.
REM Update mode: triggered when node_modules\ already exists. Takes a
REM   defensive backup of tomes\, logs\, entity-core data\, and the
REM   Tailscale toggle config into .pf-backups\<timestamp>\ BEFORE any
REM   git op, then pulls latest Proto-Familiar via `git pull --ff-only`,
REM   refreshes entity-core to the pinned tag, re-runs idempotent
REM   npm install / deno cache / uv sync. Auto-install checks rerun in
REM   both modes so the system catches up to new requirements.
REM
REM Shortcut creation is idempotent and runs in both modes — it skips
REM each .lnk if it already exists, so update mode no longer silently
REM leaves shortcuts missing.
REM
REM Robustness wrapper (added 0.3.2-alpha): the first invocation
REM re-execs self with all output teed to .proto-familiar-install.log
REM and pops a Windows MessageBox at the end with status + log path.
REM This way "logs are empty" stops being a failure mode — even if the
REM user closes the console immediately, the log file + popup persist.

REM ── Robustness wrapper: tee output + final MessageBox ──────────────
if not "%PF_INSTALL_TEED%"=="1" (
  setlocal EnableDelayedExpansion
  set "PF_INSTALL_LOG=%~dp0.proto-familiar-install.log"
  set "PF_INSTALL_TEED=1"
  echo. >> "!PF_INSTALL_LOG!" 2>nul
  echo ========== Install run %date% %time% ========== >> "!PF_INSTALL_LOG!" 2>nul
  echo.
  echo Running Proto-Familiar installer. Output is being captured to:
  echo   !PF_INSTALL_LOG!
  echo.
  echo This may take 30 to 60 seconds. To watch live, open the log
  echo file above in Notepad ^(it updates as the install runs^).
  echo.
  call "%~f0" %* >> "!PF_INSTALL_LOG!" 2>&1
  set "PF_INSTALL_EXIT=!errorlevel!"
  type "!PF_INSTALL_LOG!" 2>nul | more
  call :wrapperShowResult !PF_INSTALL_EXIT! "!PF_INSTALL_LOG!"
  endlocal & exit /b %PF_INSTALL_EXIT%
)

setlocal EnableDelayedExpansion
set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

REM ── Pre-flight: OneDrive sync detection ───────────────────────────
REM OneDrive locks files mid-write while syncing them to the cloud,
REM which kills npm install (which writes thousands of small files).
REM Detect the most common failure case before it cascades into an
REM opaque error mid-install. We shell out to PowerShell here because
REM batch's path-prefix matching is too fragile for case-insensitive
REM compare against three possible env vars.
for /f "delims=" %%R in ('powershell -NoProfile -Command "$od = @($env:OneDrive, $env:OneDriveCommercial, $env:OneDriveConsumer) ^| Where-Object { $_ }; if ($od ^| Where-Object { '%SCRIPT_DIR%'.StartsWith($_, [System.StringComparison]::OrdinalIgnoreCase) }) { 'fail' } else { 'ok' }" 2^>nul') do set "ONEDRIVE_CHECK=%%R"
if "%ONEDRIVE_CHECK%"=="fail" (
  echo [ERROR] Proto-Familiar is installed under OneDrive:
  echo         %SCRIPT_DIR%
  echo         OneDrive locks files during sync, which prevents npm install
  echo         from completing here. Move Proto-Familiar out of OneDrive
  echo         ^(for example to C:\Proto-Familiar^) and re-run install.bat.
  exit /b 1
)
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
set "ENTITY_CORE_TAG=entity-core-v0.4.0"
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
  REM Timestamp via PowerShell, not wmic — wmic is removed on Windows 11
  REM 24H2+ (and was the cause of the "Invalid path" backup errors there).
  REM Format is filesystem-safe (no colons).
  for /f %%T in ('powershell -NoProfile -Command "(Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')" 2^>nul') do set "STAMP=%%T"
  if not defined STAMP set "STAMP=backup"
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
if "!MODE!"=="update" (
  if exist "%SCRIPT_DIR%\.git" (
    where git >nul 2>nul
    if not errorlevel 1 (
      echo Pulling latest Proto-Familiar ^(git pull --ff-only^)...
      pushd "%SCRIPT_DIR%"
      git pull --ff-only
      if errorlevel 1 echo [WARN] git pull --ff-only failed. Work tree is unchanged.
      popd
    )
  ) else (
    REM Skip this warning when update.bat is the caller - it just updated us.
    if not "%PF_FROM_UPDATER%"=="1" (
      echo [WARN] This folder is NOT a git checkout - it looks like a downloaded ZIP.
      echo        install.bat cannot pull updates here. To update, double-click
      echo        update.bat in this folder - it downloads the latest version and
      echo        applies it, keeping your settings and memories.
      echo        For git-based updates instead, reinstall with:
      echo          git clone https://github.com/ScarletPrinceEury/Proto-Familiar.git
    )
  )
)

REM --- Detect winget for the auto-install fallbacks below ---
set "HAVE_WINGET=0"
where winget >nul 2>nul
if not errorlevel 1 set "HAVE_WINGET=1"
if "!HAVE_WINGET!"=="0" (
  echo [WARN] winget not found - auto-install isn't possible.
  echo        Missing prereqs will be flagged with direct download URLs.
  echo.
)

REM --- Node.js check (install via winget if missing, both modes) ---
where node >nul 2>nul
if errorlevel 1 (
  if "!HAVE_WINGET!"=="1" (
    echo Node.js not found - installing LTS via winget ^(per-user, no admin needed^)...
    winget install --id OpenJS.NodeJS.LTS --scope user --silent --accept-source-agreements --accept-package-agreements
    REM Refresh PATH so the just-installed node is reachable in this session.
    REM Re-read the persisted PATH (winget writes its change to the User
    REM PATH) and prime the WinGet Links shim dir. Node LTS now ships from
    REM winget as an archive/portable package shimmed under
    REM %LOCALAPPDATA%\Microsoft\WinGet\Links — the old MSI-only paths
    REM missed it, which dead-ended the install even though Node was fine.
    for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')" 2^>nul`) do set "PATH=%%P"
    set "PATH=%LOCALAPPDATA%\Microsoft\WinGet\Links;%LOCALAPPDATA%\Programs\nodejs;%ProgramFiles%\nodejs;%PATH%"
    where node >nul 2>nul
    if errorlevel 1 (
      echo [ERROR] Node.js install ran but node still isn't on PATH.
      echo         Close this window, open a new one, and re-run install.bat.
      exit /b 1
    )
  ) else (
    echo [ERROR] Node.js is not installed and winget is unavailable.
    echo         Install Node 18+ from https://nodejs.org/ and re-run install.bat.
    exit /b 1
  )
)
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if !NODE_MAJOR! LSS 18 (
  echo [ERROR] Node.js !NODE_MAJOR! detected. Proto-Familiar needs Node 18 or newer.
  exit /b 1
)
for /f %%v in ('node -v') do echo Node.js %%v found.

REM --- Git check (install via winget if missing, both modes) ---
where git >nul 2>nul
if errorlevel 1 (
  if "!HAVE_WINGET!"=="1" (
    echo Git not found - installing via winget...
    winget install --id Git.Git --scope user --silent --accept-source-agreements --accept-package-agreements
    REM Same PATH-refresh shape as the Node step: re-read the persisted
    REM PATH plus the WinGet Links shim dir, then the classic Git cmd dir.
    for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')" 2^>nul`) do set "PATH=%%P"
    set "PATH=%LOCALAPPDATA%\Microsoft\WinGet\Links;%ProgramFiles%\Git\cmd;%PATH%"
  ) else (
    echo [WARN] Git not found and winget unavailable - entity-core clone will be skipped.
    echo        Install Git from https://git-scm.com/download/win to enable it.
  )
)

REM --- Deno check (install via winget if missing, both modes) ---
REM Look in PATH first, then in %USERPROFILE%\.deno\bin where the
REM official deno installer writes. Adding to PATH here means the
REM follow-up `deno cache` finds it without a shell restart.
if exist "%USERPROFILE%\.deno\bin\deno.exe" set "PATH=%USERPROFILE%\.deno\bin;%PATH%"
where deno >nul 2>nul
if errorlevel 1 (
  if "!HAVE_WINGET!"=="1" (
    echo Deno not found - installing via winget...
    winget install --id DenoLand.Deno --scope user --silent --accept-source-agreements --accept-package-agreements
    if exist "%USERPROFILE%\.deno\bin\deno.exe" set "PATH=%USERPROFILE%\.deno\bin;%PATH%"
    where deno >nul 2>nul
    if errorlevel 1 (
      echo [WARN] Deno install ran but deno still isn't on PATH - falling back to the official PowerShell installer.
      powershell -NoProfile -ExecutionPolicy ByPass -Command "irm https://deno.land/install.ps1 | iex" >nul 2>nul
      if exist "%USERPROFILE%\.deno\bin\deno.exe" set "PATH=%USERPROFILE%\.deno\bin;%PATH%"
    )
  ) else (
    echo Deno not found - installing via the official PowerShell script...
    powershell -NoProfile -ExecutionPolicy ByPass -Command "irm https://deno.land/install.ps1 | iex" >nul 2>nul
    if exist "%USERPROFILE%\.deno\bin\deno.exe" set "PATH=%USERPROFILE%\.deno\bin;%PATH%"
  )
)
where deno >nul 2>nul
if errorlevel 1 (
  echo [WARN] Deno still not on PATH - entity-core will be disabled until you install it from https://deno.com/.
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

REM --- uv check (auto-install if missing, in both modes) ---
REM uv is the Python package/runtime manager Unruh uses. Astral's
REM installer writes to %USERPROFILE%\.local\bin\uv.exe by default.
REM Prime PATH so the subsequent `uv sync` works without a shell restart.
if exist "%USERPROFILE%\.local\bin\uv.exe" set "PATH=%USERPROFILE%\.local\bin;%PATH%"
set "HAVE_UV=0"
where uv >nul 2>nul
if not errorlevel 1 (
  echo uv found.
  set "HAVE_UV=1"
) else (
  echo uv not found - installing via the official Astral script ^(writes to %%USERPROFILE%%\.local\bin^)...
  powershell -NoProfile -ExecutionPolicy ByPass -Command "irm https://astral.sh/uv/install.ps1 | iex" >nul 2>nul
  if exist "%USERPROFILE%\.local\bin\uv.exe" set "PATH=%USERPROFILE%\.local\bin;%PATH%"
  where uv >nul 2>nul
  if not errorlevel 1 (
    echo uv installed.
    set "HAVE_UV=1"
  ) else (
    echo [WARN] uv auto-install failed. Unruh ^(temporal context^) will be disabled until you install uv from https://docs.astral.sh/uv/.
  )
)

REM --- Unruh dependency sync (idempotent; fast when nothing changed) ---
if "!HAVE_UV!"=="1" if exist "%SCRIPT_DIR%\unruh\pyproject.toml" (
  echo Syncing Unruh dependencies ^(only fetches what's new^)...
  pushd "%SCRIPT_DIR%\unruh"
  uv sync --quiet
  if errorlevel 1 (
    echo [WARN] uv sync failed - Unruh will be disabled until this is resolved.
  ) else (
    echo Unruh dependencies synced.
    REM Apply any pending DB migrations now so a schema change shipped in
    REM this update is in place before the first chat rather than lazily
    REM on first connect. Idempotent, best-effort, non-fatal.
    REM Keep REM lines in this block free of parentheses - a bare close
    REM paren ends the block early. The parens in the python string below
    REM are safe because they sit inside double quotes.
    uv run --no-sync python -c "from unruh.db import get_conn; get_conn().close()" >nul 2>nul
    if errorlevel 1 (
      echo [WARN] Unruh DB migration step skipped - it will apply on first start.
    ) else (
      echo Unruh database up to date.
    )
  )
  popd
) else if exist "%SCRIPT_DIR%\unruh\pyproject.toml" (
  echo [WARN] Skipping Unruh dep sync ^(uv not available^). Temporal context will be disabled until uv is installed.
)

REM --- Shortcuts (idempotent - runs in both modes) ---
REM Creating .lnk files requires WScript.Shell COM, so delegate the
REM single block of PowerShell to it. Skip per-shortcut if the .lnk
REM already exists. PS execution policy is bypassed only for this
REM one-shot call; install.bat itself stays pure batch otherwise.
echo Checking Desktop and Start Menu shortcuts...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$proj = '%SCRIPT_DIR%';" ^
  "$launcher = Join-Path $proj 'Proto-Familiar.vbs';" ^
  "$wsh = New-Object -ComObject WScript.Shell;" ^
  "foreach ($linkPath in @((Join-Path ([Environment]::GetFolderPath('Desktop'))   'Proto-Familiar.lnk')," ^
  "                       (Join-Path ([Environment]::GetFolderPath('Programs'))   'Proto-Familiar.lnk'))) {" ^
  "  if (Test-Path $linkPath) { Write-Host \"    exists: $linkPath\"; continue }" ^
  "  $parent = Split-Path -Parent $linkPath;" ^
  "  if (-not $parent -or -not (Test-Path $parent)) { Write-Host \"    parent missing for $linkPath - skipped\"; continue }" ^
  "  $sc = $wsh.CreateShortcut($linkPath);" ^
  "  $sc.TargetPath = 'wscript.exe';" ^
  "  $sc.Arguments = '\"' + $launcher + '\"';" ^
  "  $sc.WorkingDirectory = $proj;" ^
  "  $sc.IconLocation = 'shell32.dll,13';" ^
  "  $sc.Description = 'Proto-Familiar';" ^
  "  $sc.WindowStyle = 7;" ^
  "  $sc.Save();" ^
  "  Write-Host \"    created: $linkPath\"" ^
  "}" 2>nul
if errorlevel 1 (
  echo [WARN] Shortcut creation failed - launch via Proto-Familiar.vbs in this folder.
)

REM Completion marker. Only reached after npm install succeeded (we
REM exit /b 1 above on failure). The launchers check for this instead
REM of node_modules to decide whether to (re)run the installer —
REM node_modules can exist without the installer having run (a manual
REM `npm install`), which would skip entity-core clone + shortcut
REM creation. The marker is the reliable "installer actually completed"
REM signal. Content is the version, for debugging.
set "PF_VERSION="
pushd "%SCRIPT_DIR%"
for /f %%v in ('node -p "require('./package.json').version" 2^>nul') do set "PF_VERSION=%%v"
popd
if not defined PF_VERSION set "PF_VERSION=unknown"
> "%SCRIPT_DIR%\.pf-install-complete" echo !PF_VERSION!

echo.
if "!MODE!"=="update" (
  echo === Update complete ===
  if "!ANYTHING_BACKED_UP!"=="1" echo Pre-update backup: !BACKUP_DIR!
) else (
  echo === Install complete ===
)
echo   Version:   Proto-Familiar v!PF_VERSION!
REM Show the branch so a wrong-branch checkout (e.g. a ZIP of main that's
REM missing newer work) is obvious right here, not a mystery later.
if exist "%SCRIPT_DIR%\.git" (
  for /f %%b in ('git -C "%SCRIPT_DIR%" rev-parse --abbrev-ref HEAD 2^>nul') do echo   Branch:    %%b
) else (
  echo   Branch:    not a git checkout - to update, double-click update.bat
)
echo   Start:     start.bat   ^(double-click^)
echo   Stop:      stop.bat    ^(double-click^)
echo   Trouble?   see docs\troubleshooting.md
echo.
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

REM --- Helper: pop a final MessageBox so a user who closes the console
REM     before the install finishes still sees the outcome + the log
REM     path. Called from the top-of-file wrapper after the inner
REM     install run returns. Args: %1=exit code, %2=log file path.
:wrapperShowResult
set "RC=%~1"
set "WLOG=%~2"
if "%RC%"=="0" (
  set "WMSG=Proto-Familiar install completed successfully."
  set "WICN=Information"
) else (
  set "WMSG=Proto-Familiar install FAILED with exit code %RC%."
  set "WICN=Error"
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop; [System.Windows.Forms.MessageBox]::Show('%WMSG%' + [Environment]::NewLine + [Environment]::NewLine + 'Log: %WLOG%', 'Proto-Familiar install', 'OK', '%WICN%') | Out-Null } catch {}" >nul 2>nul
goto :eof
