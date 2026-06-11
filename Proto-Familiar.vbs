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

  ' Verify the installer actually completed. The .pf-install-complete
  ' marker is only written on successful exit; its absence means the
  ' installer either failed (and showed its own MessageBox) or never
  ' got to run at all (which happens on AppLocker / WDAC machines
  ' where -ExecutionPolicy Bypass is overridden by Group Policy and
  ' PowerShell silently refuses to execute the file).
  '
  ' In the "never ran" case, install.ps1 wrote nothing — no transcript,
  ' no MessageBox — so the user would otherwise just see the tray icon
  ' silently fail to appear. Catch it here with a VBS-level MessageBox
  ' so the user gets at least one clear actionable line.
  If Not fso.FileExists(installMarker) Then
    Dim errMsg, installLogPath
    installLogPath = scriptDir & "\.proto-familiar-install.log"
    errMsg = "Proto-Familiar setup did not complete." & vbCrLf & vbCrLf
    If fso.FileExists(installLogPath) Then
      errMsg = errMsg & "See the install log for details:" & vbCrLf & _
                        installLogPath & vbCrLf & vbCrLf & _
                        "(open it in Notepad — it usually names the failing step)"
    Else
      errMsg = errMsg & "No install log was written, which usually means" & vbCrLf & _
                        "PowerShell scripts are blocked on this machine" & vbCrLf & _
                        "(AppLocker, WDAC, or corporate policy — common on" & vbCrLf & _
                        "work-issued laptops)." & vbCrLf & vbCrLf & _
                        "Workarounds:" & vbCrLf & _
                        "  - Try install.bat from a Command Prompt instead" & vbCrLf & _
                        "  - Ask IT to allow PowerShell in this folder" & vbCrLf & _
                        "  - Install on a personal machine"
    End If
    MsgBox errMsg, vbCritical + vbOKOnly, "Proto-Familiar"
    WScript.Quit 1
  End If
End If

' Launch the tray app fully hidden. The user only sees the tray icon.
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & trayPs1 & """", 0, False
