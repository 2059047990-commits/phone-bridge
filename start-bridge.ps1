# phone-bridge 后台启动器（由计划任务通过 run-silent.vbs 以 SW_HIDE 调用）
#
# 健康判据（2026-10-13 妹妹的教训：端口在听 != 服务能应答）：
#   不再只看 "8790 端口被占用"，改成 GET /health 返回 200 且 body 含 "ok":true。
#   端口被占但不健康时，只杀"确实是自家 node server.mjs"的那个进程，别的进程不碰。
#
# 假死与抖动的分寸（2026-10-13 晚，回应妹妹的假死检测提案）：
#   1) 单次 /health 失败不算数——可能是瞬时卡顿，误杀会真断掉正在跑的连接。
#      必须"连续 2 次失败"（约 2 分钟）才动手。
#   2) 重启冷却 180 秒：重启后服务还没活过来时，不会每分钟再杀一遍形成重启风暴。
#   3) 状态存 bridge\.launcher-state.json（failCount / lastRestart / updated）。
$ErrorActionPreference = 'Continue'
$root      = $PSScriptRoot
$log       = Join-Path $root 'bridge.log'
$stateFile = Join-Path $root 'bridge\.launcher-state.json'
$node      = 'C:\Program Files\nodejs\node.exe'
$healthUrl = 'http://127.0.0.1:8790/health'
$failThreshold = 2      # 连续失败几次才重启
$cooldownSec   = 180    # 重启冷却（秒）
$t0 = Get-Date

# 日志统一用 UTC ISO8601，方便和手机侧对时
function Write-Log([string]$msg) {
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  $ms    = [int]((Get-Date) - $t0).TotalMilliseconds
  try { [System.IO.File]::AppendAllText($log, "[$stamp] launcher | $msg | ${ms}ms`r`n", (New-Object System.Text.UTF8Encoding($false))) } catch {}
}

function Save-State([int]$fail, [string]$lastRestart) {
  $obj = [ordered]@{
    failCount   = $fail
    lastRestart = $lastRestart
    updated     = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  }
  try { [System.IO.File]::WriteAllText($stateFile, ($obj | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false))) } catch {}
}

Write-Log "start pid=$PID"

# --- 0) 读状态 ---
$failCount   = 0
$lastRestart = ''
try {
  if (Test-Path $stateFile) {
    $j = [System.IO.File]::ReadAllText($stateFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($null -ne $j.failCount)   { $failCount = [int]$j.failCount }
    if ($null -ne $j.lastRestart) { $lastRestart = [string]$j.lastRestart }
  }
} catch { Write-Log "状态文件读取失败: $($_.Exception.Message)" }

# --- 1) /health 判活 ---
$healthy = $false
try {
  $r = Invoke-WebRequest -Uri $healthUrl -TimeoutSec 5 -UseBasicParsing
  if ($r.StatusCode -eq 200 -and $r.Content -match '"ok"\s*:\s*true') { $healthy = $true }
} catch {
  Write-Log "health 探测失败: $($_.Exception.Message)"
}

if ($healthy) {
  if ($failCount -ne 0) { Write-Log "health 恢复正常（此前连续失败 $failCount 次），计数清零" }
  Save-State 0 $lastRestart
  Write-Log "health ok:true，服务健康，直接退出"
  exit 0
}

# --- 2) health 失败：计数，看阈值与冷却 ---
$failCount++
Save-State $failCount $lastRestart
Write-Log "health 不健康（连续第 $failCount 次，阈值 $failThreshold）"

if ($failCount -lt $failThreshold) {
  Write-Log "未达阈值，本轮不动（可能是瞬时抖动）"
  exit 0
}

if ($lastRestart) {
  try {
    $lr = [datetime]::Parse($lastRestart, $null, [System.Globalization.DateTimeStyles]::AdjustToUniversal)
    $elapsed = [int]((Get-Date).ToUniversalTime() - $lr).TotalSeconds
    if ($elapsed -lt $cooldownSec) {
      Write-Log "冷却中（上次重启距今 ${elapsed}s < ${cooldownSec}s），本轮不动"
      exit 0
    }
  } catch { Write-Log "上次重启时间解析失败: $lastRestart" }
}

# --- 3) 端口被占但不健康（假死）：只清自家的 node server.mjs ---
$killed = $false
try {
  $busy = Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue
  if ($busy) {
    $owner = $busy.OwningProcess | Select-Object -First 1
    $proc  = Get-Process -Id $owner -ErrorAction SilentlyContinue
    $cl    = $null
    try { $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$owner" -ErrorAction Stop).CommandLine } catch {}
    if ($proc -and $proc.ProcessName -eq 'node' -and $cl -match 'server\.mjs') {
      Write-Log "8790 被自家 node pid=$owner 占着但不健康（疑似假死），停掉它"
      Stop-Process -Id $owner -Force
      $killed = $true
      Start-Sleep -Seconds 2
    } else {
      if (-not $cl) { Write-Log "8790 被 pid=$owner 占着但不健康，且读不到它的命令行（查询被拒或为空），无法确认归属 —— 按安全默认不动它，本轮假死自愈空转" } else { Write-Log "8790 被 pid=$owner 占着且不是自家 server.mjs，不动它" }
      exit 0
    }
  }
} catch { Write-Log "端口检查出错: $($_.Exception.Message)" }

# --- 4) 拉起服务 ---
$nowStr = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
Save-State 0 $nowStr
Set-Location $root
Write-Log "拉起 node server.mjs（killed=$killed）"
& $node (Join-Path $root 'server.mjs')
Write-Log "node 退出，exit code $LASTEXITCODE"
