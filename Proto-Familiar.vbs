' Proto-Familiar - double-click launcher (Windows)
' Runs install on first launch, then starts the system-tray app with no console window.
Option Explicit

Dim sh, fso, scriptDir, nodeModules, installPs1, trayPs1
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodeModules = scriptDir & "\node_modules"
installPs1 = scriptDir & "\scripts\win\install.ps1"
trayPs1 = scriptDir & "\scripts\win\tray.ps1"

' First-run install: show a visible console window and wait until it finishes.
If Not fso.FolderExists(nodeModules) Then
  sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & installPs1 & """", 1, True
End If

' Launch the tray app fully hidden. The user only sees the tray icon.
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & trayPs1 & """", 0, False
