# phone-bridge — 手机 ↔ 电脑 双向桥

让手机上的 AI（RikkaHub）能指挥这台电脑，也让这台电脑上的 DSH 鲸鱼娘能反过来指挥手机。

## 一、它由哪几块组成

```
手机 (RikkaHub / Termux)                      电脑 (Windows)
┌───────────────────────┐                    ┌────────────────────────┐
│ RikkaHub              │  MCP over HTTP     │ server.mjs             │
│  └─ MCP 客户端 ────────┼───────────────────>│  0.0.0.0:8790/mcp      │ ← 方向 A：手机 → 电脑
│                       │                    │  7 个 pc_* 工具        │
│ Termux                │                    │                        │
│  └─ phone-agent.mjs   │<───────────────────┼─ phone-call.mjs        │ ← 方向 B：电脑 → 手机
│     0.0.0.0:8791/mcp  │  MCP over HTTP     │  (HTTP 直连，13 个工具) │
└───────────────────────┘                    └────────────────────────┘
             ▲                                            ▲
             └──────── Tailscale 100.x.x.x ───────────────┘
                    同网段时也能走局域网 192.168.1.x
```

两边共用一个**留言板**：`bridge\messages.jsonl`。谁都不是常驻对话，都是「被主人叫醒才看信」。

## 二、目录结构

```
phone-bridge\
├─ server.mjs                  电脑侧 MCP 服务本体（Streamable HTTP）
├─ config.json                 端口 / 认证 token / 信箱目录 / 超时
├─ config.example.json         示例配置（复制成 config.json 再填）
├─ package.json, package-lock.json
├─ start-bridge.ps1            启动器：检查端口 → 起 node → 写 bridge.log
├─ run-silent.vbs              计划任务入口：wscript 无窗口拉起 start-bridge.ps1
├─ install-autostart.ps1       注册/卸载计划任务 phone-bridge（-Remove 卸载）
├─ say.mjs                     以 DSH 身份往信箱投消息（支持 --file）
├─ phone-call.mjs              电脑直连手机 MCP 的客户端（绕开 DSH 的 MCP client）
├─ watch-mailbox.mjs           信箱轮询：有新留言就弹 Windows Toast
├─ run-mailbox-watch.vbs       计划任务入口（同上，无窗口）
├─ install-mailbox-watch.ps1   注册/卸载计划任务 phone-mailbox-watch
├─ bridge\
│   ├─ messages.jsonl          留言板本体，一行一条 JSON
│   └─ .last-notified.json     轮询游标（已通知到哪条）
├─ adb-bridge.mjs              电脑侧 ADB 网关（无线调试转发到本机 8793）
├─ adb-config.example.json     ADB 网关示例配置
├─ start-adb-bridge.ps1 / install-adb-autostart.ps1
├─ 手机端\                      Termux 侧脚本（phone-agent / mbox-watch / gate / bridge.py / keepalive …）
└─ 工具\                       一次性调试脚本（probe-get.mjs / test-mcp.mjs）
```

## 三、跑起来

服务由计划任务托管，**开机/登录自动起，每 5 分钟自愈一次**：

```powershell
# 先配置
Copy-Item config.example.json config.json
# 填 config.json 的 token / unlockSecret（各 64 位十六进制随机串）与各路径

# 注册（注意：会终止运行中的实例，短暂断线）
powershell -NoProfile -ExecutionPolicy Bypass -File install-autostart.ps1
# 手动触发一次
Start-ScheduledTask -TaskName phone-bridge
# 看状态
Get-ScheduledTaskInfo -TaskName phone-bridge
# 前台跑（能看实时日志）
node server.mjs
```

健康检查：`http://127.0.0.1:8790/health`

首次启动时若 `config.json` 缺 token，`server.mjs` 会用 `crypto.randomBytes(24)` 生成一个并写回配置，日志里会打出来。

## 四、手机端

### 4.1 RikkaHub 接入

设置 → MCP → 添加服务器：

| 字段 | 值 |
|---|---|
| 类型 | **Streamable HTTP** |
| URL | `http://<电脑 Tailscale IP>:8790/mcp`（异地也能用）<br>同网段可换 `http://<电脑局域网 IP>:8790/mcp` |
| Header | `Authorization: Bearer <config.json 里的 token>` |

加完**必须再在助手的设置里勾上这个 MCP 服务器**，工具才会出现。

### 4.2 Termux 侧脚本（`手机端\`）

这些跑在手机上，给「电脑反过来指挥手机」和「手机自己盯着电脑」用，不是必装项——只用 RikkaHub 连电脑的话第四节到此为止就够了。

| 文件 | 干什么 |
|---|---|
| `phone-agent.mjs` | 手机侧 MCP 服务，监听 `8791`，把 `phone_*` 那 13 个工具暴露给电脑 |
| `mbox-watch.mjs` | 值守：每分钟戳一次电脑 `/health`，掉了就记一笔；把新留言缓存到本地 |
| `gate.mjs` | 电脑闸门的手机侧放行器，用 `unlockSecret` 签 HMAC |
| `unlock.sh` | 触发一次放行（`gate.mjs` 的薄包装） |
| `bridge.py` | 更早的简易 HTTP 桥（`8787`），只做通知/剪贴板/朗读，可不用 |
| `keepalive.sh` | 机械值守：三个端口缺了就补、定时任务丢了就补注册、电量/存储异常才提醒、每天 8:00 一份晨报 |
| `restart-sentinel.sh` | 崩溃即拉起 |

部署：

```bash
# 1. 所有脚本丢进 Termux 家目录
cp 手机端/*.mjs 手机端/*.py 手机端/*.sh ~/
chmod +x ~/*.sh

# 2. 填配置（手机侧自己的，跟电脑端 config.json 不是一个文件）
cp 手机端/config.example.json ~/config.json
#   pcBase       = http://<电脑 Tailscale IP>:8790
#   pcToken      = 电脑端 config.json 里的 token
#   unlockSecret = 电脑端 config.json 里的 unlockSecret

# 3. 起服务
nohup node ~/phone-agent.mjs >> ~/phone-agent.log 2>&1 &
nohup node ~/mbox-watch.mjs  >> ~/mbox-watch.log  2>&1 &

# 4. 注册值守（15 分钟一次，重启后仍在）
termux-job-scheduler -s ~/keepalive.sh --job-id 1 --period-ms 900000 --persisted true --network any
```

`phone-agent.mjs` 自己的 token（`pa_` 开头那串）跟电脑端 token 是两套，别混。安卓上想开机自启，把它挂到 `~/.termux/boot/` 下即可。


## 五、电脑端工具（`pc_*`，7 个）

| 工具 | 干什么 |
|---|---|
| `pc_info` | 主机名、时间、磁盘剩余、Node 版本 |
| `pc_shell` | 用 PowerShell 执行一条命令 |
| `pc_list_dir` | 列目录（含大小、修改时间） |
| `pc_read_file` | 读 UTF-8 文本，可 offset/limit |
| `pc_write_file` | 写文件（默认覆盖，可 append） |
| `say_to_dsh` | 给电脑上的鲸鱼娘留言 |
| `read_dsh_messages` | 读鲸鱼娘回给手机的消息 |

另有 `/files` 通道（`http://<电脑>:8790/files?token=...`）供手机直接下载电脑上的文件。

## 六、从电脑指挥手机

```powershell
# 列出手机侧工具
node phone-call.mjs tools
# 调用
node phone-call.mjs phone_info
# 参数里带引号时，★必须★用环境变量传，PowerShell 5.1 会把双引号剥掉
$env:PHONE_CALL_ARGS = (@{command='uname -a'} | ConvertTo-Json -Compress)
node phone-call.mjs phone_sh
```

默认打 `PHONE_HOST` / `PHONE_PORT` 指向的主机（缺省 `127.0.0.1:8791`），
token 从 `adb-config.json` 的 `phoneAgent.token` 读；可用 `PHONE_HOST` / `PHONE_PORT` / `PHONE_TOKEN` 覆盖。

手机侧 13 个工具：`phone_info` `phone_notify` `phone_clipboard_get` `phone_clipboard_set`
`phone_sh` `phone_list_dir` `phone_read_file` `phone_write_file` `phone_open_url`
`phone_speak` `phone_vibrate` `phone_sms_list` `phone_location`。

> 参数名注意：`phone_read_file` / `phone_write_file` 用的是 **`file`**，不是 `path`。

## 七、信箱

两边交换的消息存在 `bridge\messages.jsonl`，一行一条 JSON：

```json
{"ts":1790262135952,"iso":"2026-10-12T14:22:15.952Z","from":"phone","to":"dsh","text":"..."}
```

- 电脑侧投递：`node say.mjs "内容"` 或 `node say.mjs --file reply8.txt`
- 电脑侧收信：计划任务 `phone-mailbox-watch` 每 2 分钟轮询，有新留言弹 Toast
- 手机侧收信：Termux 里的 `~/mbox-watch.mjs` 每 60 秒轮询 + 通知

**两边都是被动的**——不轮询就发现不了新留言。

## 八、安全须知

- `token` 等于这台电脑的钥匙，**别贴到公开场合**。想换就改 `config.json` 的 `token` 再重启。
- `unlockSecret` 是手机侧签发「开闸票据」用的 HMAC 共享密钥。它一旦泄露，任何人能替主人签发开闸请求——**必须和 `token` 一样当秘密保管**，不要写进任何会被分享的文件。
- `pc_shell` 和 `pc_write_file` 是不可逆操作，建议在 RikkaHub 里给它们打开 **needsApproval**。
- 服务监听 `0.0.0.0:8790`，拿到 token 就能连。只想本机用就把 `config.json` 的 `host` 改成 `127.0.0.1`（但手机就连不上了）。
- `allowCidrs` 限定来源网段（默认只放行本机与 Tailscale 的 `100.64.0.0/10`）。公网直连前先把这条收紧。
- ADB 网关（`adb-bridge.mjs`）是**本机专用**工具，默认只监听 `127.0.0.1:8793`。它会执行手机上的任意 shell 命令——不要把它暴露到局域网。

## 九、踩过的坑（别重踩）

1. **`GET /mcp` 必须回 200 SSE**。MCP 客户端会先开一条 SSE 流；stateless 模式下 SDK 对 GET 不给任何响应，客户端只能等到超时（RikkaHub 报 `Connect timeout has expired`）。现在服务对 GET 返回 `text/event-stream` 并每 20 秒发心跳，同时 `server.requestTimeout = 0`。
2. **计划任务重注册会杀服务**。`Set-ScheduledTask` / `Register-ScheduledTask` 会终止运行中的实例，`node server.mjs` 是它的子进程，一起没。动手前先确认断线窗口。
3. **VBS 里 `powershell.exe` 必须写全路径**。任务环境的 PATH 找不到裸名，`WScript.Shell.Run` 静默失败**但返回码仍是 0**，表现为「任务成功但服务没起来」。
4. **★最坑的一条：VBS 里不要给 powershell 加 `-WindowStyle Hidden`★**。`sh.Run(cmd, 0, False)` 的 `0` 已经是 SW_HIDE，窗口本来就不显示；再加 `-WindowStyle Hidden`，PowerShell 会**直接退出、脚本一行不执行**，而且 `sh.Run` 照样返回 0、任务 `LastTaskResult` 照样是 0——查了半天才发现。A/B 实测确认：ASCII 注释 + `-WindowStyle Hidden` → 不执行；同一个脚本去掉它 → 正常。（一开始误以为是中文注释的锅，其实中文注释无害，`run-mailbox-watch.vbs` 一直带着中文注释正常工作。）
5. **VBS 里别写中文字面量**。WSH 按 ANSI/GBK 解析 `.vbs`，写死中文路径会烂掉；路径全部由 `WScript.ScriptFullName` 推导。（注释里的中文无害，但启动器还是统一用纯 ASCII 注释更省心。）
6. **`LastTaskResult = 0` 不等于干成了事**。只能证明脚本跑完了。判断服务活没活，看 `bridge.log` 里有没有 `launcher:` 行——**launcher 行缺失 = 启动器压根没跑起来**；有 `launcher: 启动器被调用` 但没有后续 = 脚本中途挂了。
7. **PowerShell 5.1 会剥掉传给原生 exe 的双引号**，JSON 参数请走 `PHONE_CALL_ARGS` 环境变量。
8. **别指望 `pwsh`**，Windows 上可靠的是 `C:\windows\System32\WindowsPowerShell\v1.0\powershell.exe`。
9. **别在通过 phone-bridge 自己执行的命令里重启 phone-bridge**，会把自己的输出管道切掉（手机侧 `bridge.py` 踩过同样的 SIGPIPE 坑）。
10. **ADB 无线调试的端口每次重开都变**，别写死。用 `adb_discover` 那类自愈逻辑去扫，或者直接从手机 `getprop service.adb.tcp.port` 读。
11. **`adb_ui` 在动画界面上 dump 不出来**——uiautomator 等不到 idle。视频/动画页先把系统动画时长临时设 0 再 dump，结束后还原。
