# 注册 / 卸载 phone-bridge 开机自启计划任务
#
# 用法（本机没有 pwsh，只有 Windows PowerShell 5.1）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-autostart.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-autostart.ps1 -Remove
#
# ★注意★ 重新注册会终止正在运行的实例，连带杀掉作为其子进程的 node server.mjs。
#   也就是说：跑这个脚本会短暂断线。请在动手前确认断线窗口，或先跟主人说一声。
#
# 注册出来的任务与线上一致：wscript.exe 跑 run-silent.vbs（无窗口），
# 两个触发器（登录时 + 每 5 分钟自愈），多实例策略 IgnoreNew。
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$TaskName = 'phone-bridge'
$Root = $PSScriptRoot
$Vbs = Join-Path $Root 'run-silent.vbs'
$IntervalMinutes = 5

if ($Remove) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "已卸载计划任务: $TaskName"
    } else {
        Write-Host "没有找到计划任务: $TaskName"
    }
    return
}

if (-not (Test-Path $Vbs)) { throw "缺少启动器: $Vbs" }

$action = New-ScheduledTaskAction -Execute 'C:\windows\System32\wscript.exe' `
    -Argument "`"$Vbs`"" -WorkingDirectory $Root

# 触发器一：登录时
$t1 = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
# 触发器二：每 5 分钟兜底自愈
#   不能用 [TimeSpan]::MaxValue —— PS 5.1 会溢出，用天数表达
$t2 = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew
# 无窗口：任务计划程序启动控制台程序时会先弹一个 console 再隐藏，
# 观感就是「闪一下」。wscript + SW_HIDE 才是真的不闪。
$settings.Hidden = $true

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $t1, $t2 `
    -Settings $settings -Principal $principal `
    -Description '手机↔电脑 MCP 桥（phone-bridge）：让手机上的 RikkaHub 能操作这台电脑' -Force | Out-Null

Write-Host "已注册计划任务: $TaskName（登录时 + 每 $IntervalMinutes 分钟自愈，无窗口）"
Write-Host "立即试跑一次…"
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 5
$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host ("LastTaskResult: {0}" -f $info.LastTaskResult)
Write-Host "自检：看 bridge.log 里有没有 launcher 行，没有就是启动器没跑起来。"
