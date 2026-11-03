# install-mailbox-watch.ps1
# Register / unregister a scheduled task that watches the phone-bridge mailbox
# and pops a Windows toast whenever the phone leaves a new message.
#
#   powershell -ExecutionPolicy Bypass -File install-mailbox-watch.ps1
#   powershell -ExecutionPolicy Bypass -File install-mailbox-watch.ps1 -Remove

param(
    [switch]$Remove,
    [int]$IntervalMinutes = 2
)

$ErrorActionPreference = 'Stop'

$TaskName = 'phone-mailbox-watch'
$Root     = $PSScriptRoot
$Node     = 'C:\Program Files\nodejs\node.exe'
$Script   = Join-Path $Root 'watch-mailbox.mjs'

if ($Remove) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Unregistered task: $TaskName"
    } else {
        Write-Host "Task not found: $TaskName"
    }
    return
}

if (-not (Test-Path $Script)) { throw "Missing script: $Script" }
if (-not (Test-Path $Node))   { throw "Missing node:   $Node" }

$action = New-ScheduledTaskAction -Execute $Node -Argument ('"' + $Script + '"') -WorkingDirectory $Root

$t1 = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$t2 = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
        -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

$settings.Hidden = $true

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($t1, $t2) `
    -Settings $settings -Principal $principal `
    -Description 'Watch phone-bridge mailbox and show a toast when the phone sends a message' -Force | Out-Null

Write-Host "Registered task: $TaskName (every $IntervalMinutes min + at logon)"

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 4

Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State | Format-List
Get-ScheduledTaskInfo -TaskName $TaskName | Select-Object LastRunTime, LastTaskResult, NextRunTime | Format-List
