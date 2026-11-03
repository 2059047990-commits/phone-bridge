' Launch adb-bridge hidden (called by scheduled task "adb-bridge").
'
' Three rules learned the hard way -- do NOT break them:
'  1) NO non-ASCII characters anywhere in this file, not even in comments.
'     WSH parses .vbs as ANSI/GBK; UTF-8 Chinese comments get mis-decoded.
'     Paths must be derived at runtime from ScriptFullName.
'  2) powershell.exe must be an absolute path. The task environment PATH cannot
'     resolve the bare name, and WScript.Shell.Run fails SILENTLY while still
'     returning exit code 0 -- the task looks successful but nothing starts.
'  3) Do NOT pass -WindowStyle Hidden to powershell here. With SW_HIDE from
'     sh.Run the window is already invisible, and adding -WindowStyle Hidden
'     makes PowerShell exit without ever running the script (rc 0, no log line,
'     no service). Verified 2026-10-13 by A/B test.
Option Explicit
Dim fso, sh, base, psExe, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base
psExe = sh.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
cmd = """" & psExe & """ -NoProfile -ExecutionPolicy Bypass -File """ & base & "\start-adb-bridge.ps1"""
' args: (command, windowStyle 0 = SW_HIDE, wait False)
sh.Run cmd, 0, False
