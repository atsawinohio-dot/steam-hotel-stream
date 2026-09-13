' Starts the channel 21 control program with no console window at all.
' powershell.exe -WindowStyle Hidden still flashes a black window for a moment
' on this laptop, which looks like something crashed; wscript never shows one.
Option Explicit
Dim fso, sh, here
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & here & "\roys-event-control.ps1""", 0, False
