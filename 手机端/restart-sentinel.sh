#!/data/data/com.termux/files/usr/bin/bash
# 重启哨兵（加载新代码用）。脚本自身的 cmdline 里没有服务名，不会误杀自己。
H=/data/data/com.termux/files/home

pkill -f "node $H/mbox-watch.mjs" 2>/dev/null
sleep 1

cd "$H" || exit 1
nohup node "$H/mbox-watch.mjs" >> "$H/mbox-watch.log" 2>&1 &
sleep 4

if (echo > /dev/tcp/127.0.0.1/8792) 2>/dev/null; then
    echo "哨兵已重启 ✓"
else
    echo "哨兵没起来 ✗"
    tail -5 "$H/mbox-watch.log"
fi
echo "--- 日志尾 ---"
tail -3 "$H/mbox-watch.log"
