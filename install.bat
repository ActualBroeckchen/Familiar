@echo off
REM Proto-Familiar installer (Windows)
REM Installs Node dependencies and clones entity-core-alpha as a sibling directory.

setlocal EnableDelayedExpansion
set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
for %%I in ("%SCRIPT_DIR%\..") do set "PARENT_DIR=%%~fI"
set "ENTITY_CORE_DIR=%PARENT_DIR%\entity-core-alpha"
set "ENTITY_CORE_REPO=https://github.com/PsycherosAI/Psycheros.git"
set "ENTITY_CORE_TAG=entity-core-v0.2.2"

echo === Proto-Familiar installer ===
echo Working dir: %SCRIPT_DIR%
echo.

REM --- Node.js check ---
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

REM --- npm install ---
echo.
echo === Installing Proto-Familiar dependencies (npm install) ===
pushd "%SCRIPT_DIR%"
call npm install
if errorlevel 1 (
  popd
  echo [ERROR] npm install failed.
  pause
  exit /b 1
)
popd

REM --- entity-core clone ---
if exist "%ENTITY_CORE_DIR%" (
  echo entity-core-alpha already present at %ENTITY_CORE_DIR% - skipping clone.
) else (
  where git >nul 2>nul
  if errorlevel 1 (
    echo [WARN] git not found - skipping entity-core clone. Install git or place entity-core-alpha at %ENTITY_CORE_DIR% manually.
  ) else (
    echo Cloning entity-core-alpha into %ENTITY_CORE_DIR% ...
    git clone --depth 1 --branch %ENTITY_CORE_TAG% %ENTITY_CORE_REPO% "%ENTITY_CORE_DIR%"
    if errorlevel 1 (
      echo [WARN] Tag clone failed; falling back to default branch.
      git clone --depth 1 %ENTITY_CORE_REPO% "%ENTITY_CORE_DIR%"
    )
  )
)

echo.
echo === Install complete ===
echo   Start: start.bat   (double-click)
echo   Stop:  stop.bat    (double-click)
echo.
pause
endlocal
