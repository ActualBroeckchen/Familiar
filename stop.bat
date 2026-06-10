@echo off
REM Proto-Familiar shutdown (Windows) - double-click to run.
REM
REM Selection logic (matches tray.ps1's Stop-StrayServerProcesses):
REM   1. The PID written to .proto-familiar.pid — that's the canonical
REM      "spawned by our launcher" signal.
REM   2. If the port is still held after that kill, the PID listening
REM      on the port if it looks like a node.exe + server.js — catches
REM      orphans from earlier tray runs whose Quit failed.
REM
REM The previous filter (CommandLine matches the project root path) is
REM gone because Start-Process -WorkingDirectory does NOT put the cwd
REM into Win32_Process.CommandLine — only into the (Win32-invisible)
REM cwd — so the old filter NEVER matched and stop.bat silently killed
REM nothing. Same bug was the upstream cause of "node.exe lingers across
REM updates" reports.

setlocal EnableDelayedExpansion
set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "PID_FILE=%SCRIPT_DIR%\.proto-familiar.pid"
set "PORT=8742"
if not "%PROTO_FAMILIAR_PORT%"=="" set "PORT=%PROTO_FAMILIAR_PORT%"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$pidFile = '%PID_FILE%'; $port = [int]'%PORT%'; $killed = $false;" ^
  "function Test-Port { try { $c = New-Object Net.Sockets.TcpClient('127.0.0.1', $port); $c.Close(); $true } catch { $false } }" ^
  "function Stop-Tree($id) { try { & taskkill /PID $id /T /F 2>$null | Out-Null } catch {} }" ^
  "if (Test-Path $pidFile) {" ^
  "  try {" ^
  "    $tid = [int](Get-Content -LiteralPath $pidFile -ErrorAction Stop).Trim();" ^
  "    if ($tid -gt 0 -and (Get-Process -Id $tid -ErrorAction SilentlyContinue)) {" ^
  "      Write-Host \"Stopping Proto-Familiar PID $tid (from PID file)...\";" ^
  "      Stop-Tree $tid; $killed = $true" ^
  "    }" ^
  "  } catch {}" ^
  "}" ^
  "for ($i = 0; $i -lt 25; $i++) { if (-not (Test-Port)) { break }; Start-Sleep -Milliseconds 200 }" ^
  "if (Test-Port) {" ^
  "  $owner = $null;" ^
  "  try { $owner = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue ^| Select-Object -First 1 -ExpandProperty OwningProcess } catch {};" ^
  "  if ($owner) {" ^
  "    $proc = Get-CimInstance Win32_Process -Filter \"ProcessId=$owner\" -ErrorAction SilentlyContinue;" ^
  "    if ($proc -and $proc.Name -match '^node(\\.exe)?$' -and $proc.CommandLine -match 'server\\.js') {" ^
  "      Write-Host \"Reclaiming port $port from orphaned node.exe PID $owner...\";" ^
  "      Stop-Tree $owner; $killed = $true" ^
  "    } else {" ^
  "      Write-Host \"Port $port held by PID $owner but it doesn't look like Proto-Familiar.\";" ^
  "      if ($proc) { Write-Host (\"  Name: \" + $proc.Name); Write-Host (\"  CommandLine: \" + $proc.CommandLine) }" ^
  "    }" ^
  "  }" ^
  "}" ^
  "if (-not $killed) { Write-Host \"No Proto-Familiar process found.\" }" ^
  "if (Test-Path $pidFile) { Remove-Item $pidFile -ErrorAction SilentlyContinue }"

timeout /t 2 >nul
endlocal
