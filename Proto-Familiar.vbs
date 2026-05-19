' Proto-Familiar - double-click launcher (Windows)
' Runs install on first launch, then starts the system-tray app with no console window.
Option Explicit

Dim sh, fso, scriptDir, nodeModules, unruhPyproject, unruhVenv, installPs1, trayPs1, installMarker, needInstall
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodeModules    = scriptDir & "\node_modules"
unruhPyproject = scriptDir & "\unruh\pyproject.toml"
unruhVenv      = scriptDir & "\unruh\.venv"
installPs1     = scriptDir & "\scripts\win\install.ps1"
trayPs1        = scriptDir & "\scripts\win\tray.ps1"
installMarker  = scriptDir & "\.pf-install-complete"

' Trigger install when the installer hasn't completed here. The
' .pf-install-complete marker (written at the end of a successful
' install) is the reliable signal — node_modules can exist from a
' manual `npm install` without the installer having run, which would
' leave entity-core uncloned and the Desktop/Start Menu shortcuts
' uncreated. node_modules + the Unruh venv stay as additional triggers.
needInstall = False
If Not fso.FileExists(installMarker) Then needInstall = True
If Not fso.FolderExists(nodeModules) Then needInstall = True
If fso.FileExists(unruhPyproject) And Not fso.FolderExists(unruhVenv) Then needInstall = True

If needInstall Then
  sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & installPs1 & """", 1, True
End If

' Launch the tray app fully hidden. The user only sees the tray icon.
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & trayPs1 & """", 0, False
