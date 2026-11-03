#!/data/data/com.termux/files/usr/bin/bash
# keepalive.sh —— 手机侧「机械值守」
# 调用者：mbox-watch.mjs 每分钟调一次 + Android JobScheduler 每 15 分钟唤醒一次
# 职责：
#   ① 三个服务缺了就补
#   ② 定时任务丢了就补注册
#   ③ 盯电量 / 存储，异常才提醒，且每天最多一次（分级告警：小事不说话，大事才吵）
#   ④ 每天早上 8:00 一份状态晨报
# 设计原则：不猜、不刷屏、只在真动手或真有事时留痕
H=/data/data/com.termux/files/home
LOG=$H/keepalive.log
FLAGDIR=$H/.watchdog-flags
mkdir -p "$FLAGDIR"
TODAY=$(date +%Y-%m-%d)
HHMM=$((10#$(date +%H%M)))

alive() { (echo > /dev/tcp/127.0.0.1/"$1") 2>/dev/null; }

changed=""

# ── ① 服务自愈 ────────────────────────────────────────────────
for spec in "8787 bridge.py python3" "8791 phone-agent.mjs node" "8792 mbox-watch.mjs node"; do
    set -- $spec
    port=$1; file=$2; runner=$3
    if ! alive "$port"; then
        nohup $runner "$H/$file" >> "$H/${file%.*}.log" 2>&1 &
        changed="$changed $file"
    fi
done

# ── ② 定时任务自愈（实测：Termux 反复重启后系统会把这些任务抹掉）────
# 想加自己的定时脚本，照下面这个形状抄一份、改 --job-id 和文件名即可。
has_job() { termux-job-scheduler -p 2>/dev/null | grep -q "$1"; }
if ! has_job keepalive.sh; then
    termux-job-scheduler -s "$H/keepalive.sh" --job-id 1 --period-ms 900000 --persisted true --network any >/dev/null 2>&1
    changed="$changed job-keepalive"
fi
# if ! has_job my-task.sh; then
#     termux-job-scheduler -s "$H/my-task.sh" --job-id 2 --period-ms 900000 --persisted true --network any >/dev/null 2>&1
#     changed="$changed job-mytask"
# fi

# ── ③ 电量 / 存储（读一次，后面晨报也用）────────────────────────
BATTJSON=$(timeout 10 termux-battery-status 2>/dev/null)
PCT=$(echo "$BATTJSON" | grep -o '"percentage": *[0-9]*' | grep -o '[0-9]*$')
AVAILK=$(df /data 2>/dev/null | tail -1 | awk '{print $4}')
AVAILH=$(df -h /data 2>/dev/null | tail -1 | awk '{print $4}')

# 告警一：电量 < 15% 且没在充电（每天最多一次）
if [ -n "$PCT" ] && [ "$PCT" -lt 15 ] && echo "$BATTJSON" | grep -q "UNPLUGGED"; then
    if [ ! -f "$FLAGDIR/lowbat-$TODAY" ]; then
        termux-notification --title "手机快没电了" \
            --content "电量 ${PCT}%，而且没在充电。值守在看着，但该充电了。" \
            --id watchdog-batt --priority high
        termux-vibrate -d 300 2>/dev/null
        touch "$FLAGDIR/lowbat-$TODAY"
    fi
fi

# 告警二：可用空间 < 5G（每天最多一次）
if [ -n "$AVAILK" ] && [ "$AVAILK" -lt 5242880 ]; then
    if [ ! -f "$FLAGDIR/lowdisk-$TODAY" ]; then
        termux-notification --title "手机存储快满了" \
            --content "只剩 ${AVAILH} 可用。值守提醒一次，怎么收拾看你自己。" \
            --id watchdog-disk --priority high
        touch "$FLAGDIR/lowdisk-$TODAY"
    fi
fi

# ── ④ 每天 8:00 晨报（REPORT_FORCE=1 可手动触发一次做测试）──────
# 窗口放宽：8:00 之后「第一次跑到」就发（防止夜里深度休眠错过 8:00-8:06 的窄窗口）
if [ "$HHMM" -ge 800 ] || [ -n "$REPORT_FORCE" ]; then
    if [ ! -f "$FLAGDIR/report-$TODAY" ] || [ -n "$REPORT_FORCE" ]; then
        s1=$(alive 8787 && echo 在 || echo 缺)
        s2=$(alive 8791 && echo 在 || echo 缺)
        s3=$(alive 8792 && echo 在 || echo 缺)
        jobs=$(termux-job-scheduler -p 2>/dev/null | grep -c "Pending Job")
        fixed=$(grep -c "^$TODAY" "$LOG" 2>/dev/null || echo 0)
        pcfail=$(grep -c "电脑 /health 失败" "$H/mbox-watch.log" 2>/dev/null || echo 0)
        mail=$(grep -c "^$TODAY" "$H/mbox-watch.log" 2>/dev/null || echo 0)
        termux-notification --title "手机值守 · $TODAY 晨报" \
            --content "服务 8787/8791/8792：$s1/$s2/$s3；定时任务 ${jobs} 条在岗；电量 ${PCT:-?}%；存储剩 ${AVAILH:-?}；今天补过 ${fixed} 次；电脑探测失败 ${pcfail} 次。" \
            --id watchdog-report
        touch "$FLAGDIR/report-$TODAY"
    fi
fi

# ── ⑤ 状态快照（每 10 分钟写一次，供电脑侧或随时查看）─────────
if [ $((10#$(date +%M) % 10)) -eq 0 ]; then
    {
        echo "更新时间: $(date '+%Y-%m-%d %H:%M:%S')"
        echo "服务: 8787=$(alive 8787 && echo 在 || echo 缺) 8791=$(alive 8791 && echo 在 || echo 缺) 8792=$(alive 8792 && echo 在 || echo 缺)"
        echo "定时任务: $(termux-job-scheduler -p 2>/dev/null | grep -c 'Pending Job') 条"
        echo "电量: ${PCT:-?}%  存储可用: ${AVAILH:-?}"
        echo "今天补过: $(grep -c "^$TODAY" "$LOG" 2>/dev/null) 次"
    } > "$H/watchdog-status.txt" 2>/dev/null
fi

# ── ⑥ 只有真动手才写日志 ──────────────────────────────────────
if [ -n "$changed" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') 补起:$changed" >> "$LOG"
fi
