// mbox-watch.mjs — 手机侧的"信箱哨兵"
// 每 60 秒问一次电脑上的 DSH 信箱，发现新留言就弹通知 + 震动。
// 依赖：node（Termux）、termux-api（通知/震动）
// 配置：同目录 config.json（照 config.example.json 填）
import { execFileSync, execFile } from 'node:child_process';
import { appendFileSync, statSync, renameSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';

const HOME_DIR = '/data/data/com.termux/files/home';

// 电脑侧地址与令牌都从 config.json 读，不写死在代码里。
const CFG = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const TOKEN = CFG.pcToken;
const PC_BASE = String(CFG.pcBase || '').replace(/\/+$/, '');
if (!PC_BASE || !TOKEN) {
  console.error('缺少配置：请在 config.json 里填 pcBase 和 pcToken（参考 config.example.json）');
  process.exit(1);
}
const MCP = PC_BASE + '/mcp?token=' + TOKEN;
const LOG = '/data/data/com.termux/files/home/mbox-watch.log';
const INTERVAL = 60 * 1000;

let lastTs = Date.now(); // 启动那一刻起，只认之后的新留言

// 2026-10-15 P7 / E8 手机半：日志轮转 —— 超 2 MB 就切，留 .1 / .2 两份旧档，最老的丢掉。
function rotateLog() {
  try {
    if (statSync(LOG).size < 2 * 1024 * 1024) return;
    try { unlinkSync(LOG + '.2'); } catch (e) { /* 还没有 */ }
    try { renameSync(LOG + '.1', LOG + '.2'); } catch (e) { /* 还没有 */ }
    renameSync(LOG, LOG + '.1');
  } catch (e) { /* 文件不在等情况，忽略 */ }
}

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  rotateLog();
  try { appendFileSync(LOG, line + '\n'); } catch (e) { /* 忽略 */ }
  // 2026-10-15 修复（8.2-1）：原本这里还有一句 console.log(line)，
  // 而 stdout 已被 .bashrc / nohup 重定向到同一个日志文件，所以每条会写两遍。
}

async function ask(sinceTs) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'read_dsh_messages', arguments: { since_ts: sinceTs, limit: 5 } }
  });
  // 2026-10-19 修复：原来这里是无超时的裸 fetch。
  // 实测：连到「接受连接但永不回包」的端口时 await 会永久挂住，
  // 而 loop() 是串行的（await tick() 之后才排下一拍），
  // 于是一次挂起 = 整条定时链永久死锁，直到进程被外部杀掉。
  // 今天 10:34:20 那次 fetch failed 之后静默 91 分钟就是这么来的。
  const res = await fetch(MCP, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    },
    body,
    signal: AbortSignal.timeout(15000)
  });
  const j = await res.json();
  if (j && j.error) throw new Error(JSON.stringify(j.error));
  return (j && j.result && j.result.content && j.result.content[0] && j.result.content[0].text) || '';
}

// 2026-10-16 E7 剩下那半条：把每次成功拉到的新信存一份本地快照。
// 电脑离线时，这个文件就是唯一能读的信 —— 所以文件头必须明写「缓存、非新信」，免得被当成新消息。
// 覆盖写（只留最近一次）：单文件、有界、不会一直涨。
const CACHE = HOME_DIR + '/mbox-cache.txt';

function writeCache(text, ts) {
  const head =
    '=== 信箱缓存副本（非新信）===\n' +
    '拉取时间: ' + new Date().toISOString() + '\n' +
    '信件时间: ' + new Date(ts).toISOString() + '\n' +
    '说明: 这是哨兵上次成功拉到新信时的快照，不是新信；\n' +
    '      电脑离线时只能看这个，权当应急。\n' +
    '───────────────\n';
  try { writeFileSync(CACHE, head + text + '\n'); } catch (e) { log('缓存写入失败: ' + e.message); }
}

function notify(title, text) {
  // 2026-10-15 修复：原来是 execFileSync（同步）且无超时——termux-api 卡住时会
  // 阻塞整个事件循环，健康口 8792 在 listen 但不 accept、日志停写（实测假死 >5 分钟）。
  // 改成异步 + 5 秒超时：卡住也只丢这一次通知，哨兵不死。
  // 2026-10-15 补：原来没有 --action，点了没反应（只有 phone-agent 那条通知加了）。
  // 点开就是电脑上的完整信箱页面 /mail。
  const mailUrl = PC_BASE + '/mail?token=' + TOKEN;
  execFile('termux-notification', [
    '--title', title,
    '--content', text.slice(0, 400),
    '--id', 'mbox',
    '--priority', 'high',
    '--action', "am start -a android.intent.action.VIEW -d '" + mailUrl + "'"
  ], { timeout: 15000 }, (e) => { if (e) log('通知失败: ' + e.message); });
  execFile('termux-vibrate', ['-d', '400'], { timeout: 15000 }, () => { /* 忽略 */ });
}

// 顺带当监护人：每轮（60 秒）看一眼另外两个服务的端口，缺了就补。
// 分工：哨兵自己由 「.bashrc + JobScheduler」 双重保活，它负责看护 bridge 和 phone-agent，
//       这样就不必等 JobScheduler 那 15 分钟的粒度。
function guard() {
  execFile('bash', [HOME_DIR + '/keepalive.sh'], (e) => {
    if (e) log('监护人: 调用 keepalive.sh 失败 ' + e.message);
  });
}

// ── 电脑健康探测（与电脑侧假死检测对称的动作）──────────────────
// 电脑侧：连续 2 次 /health 失败 → 自己重启 node（冷却 180 秒）
// 手机侧（这里）：连续 5 次失败（≈5 分钟）→ 弹通知提醒
// 阈值比电脑侧宽，是为了让电脑先自救；只有它救不回来时才喊人。
const PC_HEALTH = PC_BASE + '/health';
let pcFail = 0;
let pcAlerted = false;
let pcLast = '';

async function checkPc() {
  const t0 = Date.now();
  try {
    const res = await fetch(PC_HEALTH, { signal: AbortSignal.timeout(8000) });
    const body = await res.text();
    if (res.status === 200 && body.indexOf('"ok":true') >= 0) {
      if (pcAlerted) {
        log('电脑 /health 恢复正常（之前连续失败 ' + pcFail + ' 次）');
        notify('和电脑连上了', '电脑那边恢复正常了，桥又活着了。');
      }
      pcFail = 0;
      pcAlerted = false;
      pcLast = '';
      return true;
    }
    throw new Error('health 状态异常 status=' + res.status);
  } catch (e) {
    const ms = Date.now() - t0;
    pcFail++;
    // 失败形态判据（从实测数据里抠出来的）：
    //   5 秒级 = 包到不了（网络不通 / 被 DROP）；1 秒内 = 对端在线但端口没人听（内核回 RST）
    pcLast = ms + 'ms / ' + (ms > 4000 ? '超时（包到不了）' : (ms < 1000 ? '快失败（对端在线但端口没人听）' : '中间态'));
    log('电脑 /health 失败第 ' + pcFail + ' 次：' + e.message + ' [' + pcLast + ']');
    if (pcFail >= 5 && !pcAlerted) {
      pcAlerted = true;
      notify('和电脑断连了', '连续 5 分钟探测电脑 /health 都没应答。最后一次：' + pcLast + ' —— 超时多半是网络断，快失败多半是电脑上的服务没了。');
    }
    return false;
  }
}

// 2026-10-15 修复（8.2-3）：隧道体检 —— 原来没有任何人发现 Tailscale 掉没掉（
// 10-15 实测真掉过，连断 13 小时）。判据：本机 tun0 上有没有 100.x 地址。
// 连续 3 拍没有就弹通知提醒（不自动拉起 App，不可靠）。
let tsFail = 0;
let tsAlerted = false;

function checkTun() {
  let ok = false;
  try {
    const nis = os.networkInterfaces();
    ok = (nis.tun0 || []).some((a) => a.family === 'IPv4' && a.address.indexOf('100.') === 0);
  } catch (e) { /* 忽略 */ }
  if (ok) {
    if (tsAlerted) { log('Tailscale 隧道恢复，tun0 又有 100.x 地址了'); notify('和电脑的隧道回来了', 'Tailscale 恢复了。'); }
    tsFail = 0;
    tsAlerted = false;
    return;
  }
  tsFail++;
  log('tun0 上没有 Tailscale 地址（连续第 ' + tsFail + ' 拍）');
  if (tsFail >= 3 && !tsAlerted) {
    tsAlerted = true;
    notify('Tailscale 掉了', '连续 3 拍没看到 100.x 地址，手机和电脑的隧道断了。点一下 Tailscale 图标重连。');
  }
}

// 融合架构下的定位（2026-10-13 拍板）：
//   主通道 = 电脑直接连 phone-agent(8791) 干活，这边不再主动投常规报告
//   备用通道 = 信箱，只保留"有新留言就通知"这一个入口，且降频到 5 分钟一拍
//   本进程的主职责 = 判活看门狗（电脑 /health 连续失败 → 通知）
let tickCount = 0;
const MAIL_EVERY = 5; // 每 5 拍（≈5 分钟）才查一次信箱

async function tick() {
  await checkPc();
  tickCount++;
  if (tickCount % MAIL_EVERY !== 0) return; // 非查信轮次，判活完就收工
  try {
    const text = await ask(lastTs);
    if (!text || text.indexOf('暂时没有新消息') >= 0) return;
    const stamps = [...text.matchAll(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/g)].map(m => Date.parse(m[1]));
    const newest = stamps.length ? Math.max(...stamps) : 0;
    if (newest > lastTs) {
      lastTs = newest;
      log('新留言 ' + new Date(newest).toISOString() + ' → 已弹通知');
      notify('电脑来信', text.replace(/\[[^\]]+\]\s*/, ''));
      writeCache(text, newest);
    }
  } catch (e) {
    log('轮询出错: ' + e.message);
  }
}

// 健康端口：既是自检入口，也是"单实例锁"——端口被占说明已有哨兵在跑，直接退出
const LOCK_PORT = 8792;
const srv = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: 1, lastTs, lastSeen: new Date(lastTs).toISOString() }));
});
srv.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.log('已有哨兵在跑，本次退出'); process.exit(0); }
  console.error('健康端口起不来: ' + e.message); process.exit(1);
});
srv.listen(LOCK_PORT, '127.0.0.1', () => log('健康端口 ' + LOCK_PORT + ' 已开'));

log('哨兵启动，间隔 ' + (INTERVAL / 1000) + 's');
// 2026-10-15 修复（8.2-2）：原来是固定 setInterval 60 秒 —— 电脑离线时每拍白等 8 秒超时，
// 实测断连 9.7 小时白等了 581 拍。现在：连续失败 >=3 拍 → 退避到 5 分钟一拍，
// 恢复后自动回到 60 秒。
// 2026-10-15 P3-补（主人裁决）：把「本地体检」从退避节奏里摘出来 ——
// guard()（补服务）和 checkTun()（隧道体检）都不吃网络，没理由跟着电脑探测一起退避。
// 原来退避到 5 分钟时它们也变成 5 分钟一拍，实测「Tailscale 开回来 → 检测到」要 3 分钟。
// 现在它们固定 60 秒一拍；只有 checkPc + 查信箱受退避影响（那才是真在等网络的部分）。
function localTick() {
  guard();
  checkTun();
}
setInterval(localTick, INTERVAL);
localTick();

const BACKOFF = 5 * 60 * 1000;
// 2026-10-19 修复：原来的 loop() 是 `await tick(); setTimeout(loop, ...)`。
// 只要 tick() 里任何一步抛错或挂住，这条链就断了 —— 而 tick() 外层没有 catch，
// 一个未捕获的 rejection 就能让整个哨兵静默。现在改成 try/finally：
// 无论这一拍成功、失败还是抛错，下一拍一定排上。
// 2026-10-19 新增：心跳行。原来健康时脚本一行日志都不写（checkTun/checkPc
// 只在"告警状态"变化时才 log），结果「日志静默」既可能是健康也可能是死，
// 排查时完全分不清。现在每拍必写一行，含拍号、上次读到的信标、失败次数。
let lastBeatLog = 0;
function heartbeat() {
  const now = Date.now();
  // 只在整分钟边界附近写，避免日志暴涨（每拍一行 = 每天 1440 行，可接受）
  if (now - lastBeatLog < 50000) return;
  lastBeatLog = now;
  log('心跳 #' + loopBeat + ' ts=' + lastTs + ' pcFail=' + pcFail + ' tsFail=' + tsFail + ' tick=' + tickCount);
}

let loopBeat = 0;
async function loop() {
  loopBeat++;
  try {
    await tick();
  } catch (e) {
    log('拍 #' + loopBeat + ' 抛错（已兜住，下一拍照常）: ' + (e && e.message));
  } finally {
    // 心跳：每拍必写一行，假死一眼可辨（原来健康时不写日志，静默≠死，无法区分）
    heartbeat();
    setTimeout(loop, pcFail >= 3 ? BACKOFF : INTERVAL);
  }
}
loop();
