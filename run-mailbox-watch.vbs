' Launch mailbox watcher hidden (called by scheduled task "phone-mailbox-watch").
'
' Same three rules as run-silent.vbs -- KEEP THIS FILE PURE ASCII:
'  1) No non-ASCII bytes anywhere, not even in comments. WSH parses .vbs as
'     ANSI/GBK, so UTF-8 Chinese comments corrupt the script; wscript then
'     exits with rc 0 and does nothing at all. This silently killed the
'     mailbox watcher between 13:07 and 17:50 on 2026-10-13.
'  2) Absolute path for the interpreter. The task environment PATH cannot
'     resolve a bare name and WScript.Shell.Run fails SILENTLY while still
'     returning exit code 0 -- the task looks successful but nothing starts.
'  3) Do NOT pass an extra hidden-window flag. With SW_HIDE from sh.Run the
'     window is already invisible, and adding one makes the child exit
'     without ever running (rc 0, no log line).
Option Explicit
Dim fso, sh, base, nodeExe, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base
nodeExe = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
cmd = """" & nodeExe & """ """ & base & "\watch-mailbox.mjs"""
' args: (command, windowStyle 0 = SW_HIDE, wait False)
sh.Run cmd, 0, False
