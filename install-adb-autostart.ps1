# 注册 / 卸载 adb-bridge 开机自启计划任务
#
# 用法（本机没有 pwsh，只有 Windows PowerShell 5.1）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-adb-autostart.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-adb-autostart.ps1 -Remove
#
# 与 install-autostart.ps1（phone-bridge / 8790）互为姊妹：任务名不同、VBS 不同、
# 端口不同，互不干扰。注册出来的形态一致：wscript.exe 跑 run-adb-silent.vbs（无窗口），
# 两个触发器（登录时 + 每 5 分钟自愈），多实例策略 IgnoreNew。
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$TaskName = 'adb-bridge'
$Root = $PSScriptRoot
$Vbs = Join-Path $Root 'run-adb-silent.vbs'
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
$settings.Hidden = $true

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $t1, $t2 `
    -Settings $settings -Principal $principal `
    -Description '电脑侧无线 ADB 桥（adb-bridge）：让本机 AI 能直接看屏幕、点屏幕、控制手机' -Force | Out-Null

Write-Host "已注册计划任务: $TaskName（登录时 + 每 $IntervalMinutes 分钟自愈，无窗口）"
Write-Host "立即试跑一次…"
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 6
$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host ("LastTaskResult: {0}" -f $info.LastTaskResult)
Write-Host "自检："
try {
    $h = Invoke-RestMethod -Uri http://127.0.0.1:8793/health -TimeoutSec 6
    Write-Host ("  /health -> " + ($h | ConvertTo-Json -Compress))
} catch {
    Write-Host ("  /health 失败: " + $_.Exception.Message)
    Write-Host "  看 adb-bridge-launcher.log 与 adb.log"
}
