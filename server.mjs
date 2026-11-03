#!/usr/bin/env node
/**
 * phone-bridge — 电脑侧 MCP 桥接服务
 *
 * 作用：把这台电脑的能力（执行命令、读写文件）以及「与 DSH 会话交换消息」的能力
 *       通过 MCP Streamable HTTP 暴露出去，供手机上的 RikkaHub 连接。
 *
 * 传输：MCP Streamable HTTP（stateless，每请求新建 transport）
 * 认证：Authorization: Bearer <token>（token 在 config.json）
 *
 * 启动：node server.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(ROOT, 'config.json');
const LOG_FILE = path.join(ROOT, 'bridge.log');

// 2026-10-15 检修 E8：bridge.log 原来只增不减（已 1.8 MB）。
// 按大小切、留 N 份：bridge.log → .1 → .2 → .3，最老的丢掉。
// 阈值与份数在 config.json（logMaxBytes / logKeep），默认 2 MB / 3 份。
let LOG_MAX_BYTES = 2 * 1024 * 1024;
let LOG_KEEP = 3;

function rotateLog() {
  try {
    for (let i = LOG_KEEP; i >= 1; i--) {
      if (i === LOG_KEEP) {
        const oldest = `${LOG_FILE}.${i}`;
        if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
      }
      const src = i === 1 ? LOG_FILE : `${LOG_FILE}.${i - 1}`;
      if (fs.existsSync(src)) fs.renameSync(src, `${LOG_FILE}.${i}`);
    }
  } catch {
    /* 轮转失败（多半是别的进程正握着文件）不能拖垮服务，下次再试 */
  }
}

// 同时写控制台与 bridge.log；自己写文件，免得受调用方 shell 的编码/重定向影响
function log(...args) {
  const line =
    `[${new Date().toISOString()}] ` +
    args
      .map((a) =>
        typeof a === 'string' ? a : a instanceof Error ? a.stack || a.message : JSON.stringify(a),
      )
      .join(' ');
  console.log(line);
  try {
    // 每次真去看一眼文件大小：launcher / warden / trim-mailbox 都是别的进程
    // 直接往 bridge.log 追加的，只维护自己的计数器会看不见它们写的那部分。
    let size = 0;
    try {
      size = fs.statSync(LOG_FILE).size;
    } catch {
      size = 0;
    }
    if (size > LOG_MAX_BYTES) rotateLog();
    fs.appendFileSync(LOG_FILE, line + os.EOL, 'utf8');
  } catch {
    /* 日志写不进去也不能拖垮服务 */
  }
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const cfg = {
      host: '0.0.0.0',
      port: 8790,
      token: crypto.randomBytes(24).toString('hex'),
      bridgeDir: path.join(ROOT, 'bridge'),
      shellTimeoutMs: 120000,
      maxOutputBytes: 200000,
      allowCidrs: [],
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    log('[phone-bridge] 已生成 config.json');
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  cfg.bridgeDir = cfg.bridgeDir || path.join(ROOT, 'bridge');
  if (!Array.isArray(cfg.allowCidrs)) cfg.allowCidrs = [];
  fs.mkdirSync(cfg.bridgeDir, { recursive: true });
  return cfg;
}

const CFG = loadConfig();
if (Number(CFG.logMaxBytes) > 0) LOG_MAX_BYTES = Number(CFG.logMaxBytes);
if (Number(CFG.logKeep) > 0) LOG_KEEP = Number(CFG.logKeep);
const MSG_FILE = path.join(CFG.bridgeDir, 'messages.jsonl');
// 允许手机下载的目录（只放行这一层的文件，不做递归）
const DOWNLOADS = CFG.downloadsDir || path.join(os.homedir(), 'Downloads');

// ---------------------------------------------------------------- shell
const SHELL = (() => {
  for (const c of ['pwsh.exe', 'pwsh', 'powershell.exe']) {
    const hit = (process.env.PATH || '')
      .split(path.delimiter)
      .map((d) => path.join(d, c))
      .find((p) => fs.existsSync(p));
    if (hit) return hit;
  }
  return 'powershell.exe';
})();

function runShell(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      SHELL,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ${command}`],
      { cwd: cwd || process.cwd(), timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({
          code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
          killed: Boolean(err && err.killed),
          stdout: stdout || '',
          stderr: stderr || (err && !stderr ? String(err.message) : ''),
        });
      },
    );
  });
}

function clip(text) {
  const max = CFG.maxOutputBytes || 200000;
  if (Buffer.byteLength(text, 'utf8') <= max) return text;
  return text.slice(0, max) + `\n…[截断，原始 ${Buffer.byteLength(text, 'utf8')} 字节]`;
}

// ---------------------------------------------------------------- 权限闸门
// 2026-10-14 和主人定下的规矩：手机派过来的活默认只能在会话工作区里干；
// 想动全盘、想关机重启，得主人在手机上按一下指纹先把闸门打开。
// 状态落盘在 bridge/.gate.json，进程重启也不会把敞开的门忘掉。
const GATE_FILE = path.join(CFG.bridgeDir, '.gate.json');
const UNLOCK_TTL_MS = Number(CFG.unlockTtlMs) || 30 * 60 * 1000;
const NONCE_TTL_MS = 60 * 1000;
const POWER_GRACE_MS = Number(CFG.powerGraceMs) || 60 * 1000;

// 手机和电脑各存一份的共享密钥，用来给「指纹已通过」的解锁请求签名。
// 第一次运行自动生成并写回 config.json。
const UNLOCK_SECRET = (() => {
  if (CFG.unlockSecret) return CFG.unlockSecret;
  const s = crypto.randomBytes(32).toString('hex');
  CFG.unlockSecret = s;
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2), 'utf8');
    log('[phone-bridge] 首次运行：已生成 unlockSecret 并写回 config.json');
  } catch (err) {
    log('[phone-bridge] unlockSecret 写回失败（本次仍可用，重启后会换新的）:', err);
  }
  return s;
})();

function readGate() {
  try {
    return JSON.parse(fs.readFileSync(GATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeGate(g) {
  try {
    fs.writeFileSync(GATE_FILE, JSON.stringify(g, null, 2), 'utf8');
  } catch (err) {
    log('[phone-bridge] 闸门状态写盘失败:', err);
  }
}

function gateState() {
  const g = readGate();
  const now = Date.now();
  const until = Number(g.unlockedUntil) || 0;
  return {
    open: until > now,
    until,
    remainMs: Math.max(0, until - now),
    openedAt: Number(g.openedAt) || 0,
    by: g.by || '',
  };
}

// 闸门开着 → 手机派来的 DSH 会话拿 danger-full-access；关着只给工作区
function gatePermissionMode() {
  return gateState().open ? 'danger-full-access' : 'workspace-write';
}

// 2026-10-15 检修 B1：闸门原来只管 pc_ask 一个工具，遥控层（pc_shell / pc_list_dir /
// pc_read_file / pc_write_file / pc_power）全都没查过闸门 —— 闸门关着照样能锁屏、能读全盘。
// 按文档 4.1「闸门关着时只能动会话工作区（配置里的 askCwd）」补上判定。
const WORKSPACE = path.resolve(CFG.askCwd || path.join(ROOT, '..'));

function inWorkspace(p) {
  try {
    const t = path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
    const w = WORKSPACE.replace(/[\\/]+$/, '').toLowerCase();
    return t === w || t.startsWith(w + path.sep);
  } catch {
    return false;
  }
}

function gateClosedNotice(what) {
  return (
    `【闸门关着】${what}只允许在会话工作区里动：${WORKSPACE}\n` +
    '要动别处，先在手机上跑 ~/unlock.sh 按一次指纹开闸（或调 pc_unlock）；\n' +
    '也可以改用 pc_ask —— 它在工作区里干活，不需要开闸。'
  );
}

// 闸门关着时给 pc_shell 用的路径围栏：命令里出现工作区之外的绝对路径就挡下来。
// 诚实说明：这是模式匹配，不是沙箱 —— 脚本自己拼出来的路径绕得过去。
// 它只负责挡「手滑打到 C:\ 上」这类事；真要跑任意命令，请开闸。
const ABS_PATH_RE = /(?:^|[\s"'`=([,;|&])([A-Za-z]:[\\/][^\s"'`<>|]*|\\\\[^\s"'`<>|]+)/g;

function outsidePaths(command) {
  const bad = [];
  for (const m of String(command).matchAll(ABS_PATH_RE)) {
    const p = m[1];
    if (!inWorkspace(p)) bad.push(p);
  }
  return [...new Set(bad)];
}

// 一次性挑战：手机先领一个 nonce，指纹过了再拿它来换开闸，防重放
const NONCES = new Map();
function issueNonce() {
  const n = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  for (const [k, exp] of NONCES) if (exp < now) NONCES.delete(k);
  NONCES.set(n, now + NONCE_TTL_MS);
  return n;
}
function consumeNonce(n) {
  const key = String(n || '');
  const exp = NONCES.get(key);
  if (!exp) return false;
  NONCES.delete(key); // 不管过没过期都烧掉，一个 nonce 只能用一次
  return exp > Date.now();
}
function signNonce(n) {
  return crypto.createHmac('sha256', UNLOCK_SECRET).update(String(n)).digest('hex');
}

// 启动即清闸：进程重启（含电脑重启）不给全盘权限续命——要用就再按一次指纹。
// 宁可多按一次，也不留一段没人看着的敞口。主人 2026-10-14 定的。
writeGate({ unlockedUntil: 0, openedAt: 0, by: '' });

// ---------------------------------------------------------------- DSH 分身
// dsh.cmd 干的事其实就这三步：
//   set ELECTRON_RUN_AS_NODE=1
//   "<安装目录>\DeepSeek Harness.exe" --expose-internals "<...>\cli.js" %*
// 这里照抄成 execFile 的参数数组，绕开 .cmd 在 Windows 上的引号/转义坑。
const DSH_EXE = CFG.dshExe || 'C:\\DeepSeekHarness\\DeepSeek Harness.exe';
const DSH_CLI =
  CFG.dshCli ||
  'C:\\DeepSeekHarness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js';

// 开一个一次性 DSH 会话问一句，拿到最终回答就走人（headless）。
// fullAccess 决定沙箱档位——这是整条链路的权限天花板，实测唯一有效的开关。
function runDsh(prompt, { fullAccess, cwd, timeoutMs } = {}) {
  return new Promise((resolve) => {
    execFile(
      DSH_EXE,
      ['--expose-internals', DSH_CLI, 'headless', prompt],
      {
        cwd: cwd || CFG.askCwd || process.cwd(),
        timeout: timeoutMs || Number(CFG.askTimeoutMs) || 300000,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          DSH_PERMISSION_MODE: fullAccess ? 'danger-full-access' : 'workspace-write',
        },
      },
      (err, stdout, stderr) => {
        resolve({
          code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
          killed: Boolean(err && err.killed),
          stdout: stdout || '',
          stderr: stderr || '',
        });
      },
    );
  });
}

// ---------------------------------------------------------------- IP 白名单
// config.allowCidrs 例如 ["127.0.0.1/32","::1/128","100.64.0.0/10"]。
// 空数组 = 不限制来源。只在这里读一次，改配置后要重启服务才生效。
function v4Bytes(ip) {
  const p = String(ip).split('.');
  if (p.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(p[i])) return null;
    const n = Number(p[i]);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function ipBytes(ip) {
  if (!ip) return null;
  // Node 在双栈 socket 上会把 IPv4 报成 ::ffff:1.2.3.4
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return v4Bytes(mapped[1]);
  if (ip.includes('.')) return v4Bytes(ip);

  const zone = ip.indexOf('%');
  const clean = (zone >= 0 ? ip.slice(0, zone) : ip).toLowerCase();
  const halves = clean.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null;
    const n = parseInt(groups[i], 16);
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  }
  return out;
}

function parseCidr(s) {
  const [addr, pfx] = String(s).split('/');
  const bytes = ipBytes(addr);
  if (!bytes) return null;
  const prefix = pfx === undefined || pfx === '' ? bytes.length * 8 : Number(pfx);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bytes.length * 8) return null;
  return { bytes, prefix, raw: String(s) };
}

function inCidr(ip, cidr) {
  const b = ipBytes(ip);
  if (!b || b.length !== cidr.bytes.length) return false;
  let bits = cidr.prefix;
  for (let i = 0; i < b.length && bits > 0; i++) {
    const take = Math.min(8, bits);
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
    if ((b[i] & mask) !== (cidr.bytes[i] & mask)) return false;
    bits -= take;
  }
  return true;
}

const ALLOW = (CFG.allowCidrs || []).map(parseCidr).filter(Boolean);

function clientAllowed(ip) {
  if (!ALLOW.length) return true; // 没配白名单 = 谁都能来（保持旧行为）
  return ALLOW.some((c) => inCidr(ip, c));
}

const text = (s) => ({ content: [{ type: 'text', text: s }] });

// ---------------------------------------------------------------- messages
function appendMessage(from, to, txt) {
  const rec = { ts: Date.now(), iso: new Date().toISOString(), from, to, text: txt };
  fs.appendFileSync(MSG_FILE, JSON.stringify(rec) + '\n', 'utf8');
  return rec;
}

function readMessages({ to, sinceTs, limit, order }) {
  if (!fs.existsSync(MSG_FILE)) return [];
  const lines = fs.readFileSync(MSG_FILE, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (to && rec.to !== to) continue;
    if (sinceTs && rec.ts <= sinceTs) continue;
    out.push(rec);
  }
  // limit 永远取「最新的 N 条」（与旧行为一致），order 只决定这批怎么排：
  //   desc = 最新在最前（2026-10-14 主人要求的新默认）
  //   asc  = 最旧在最前（2026-10-14 之前的旧行为，兼容保留）
  const picked = typeof limit === 'number' && limit > 0 ? out.slice(-limit) : out;
  return order === 'asc' ? picked : picked.slice().reverse();
}

// ---------------------------------------------------------------- MCP server
function buildServer() {
  const server = new McpServer(
    { name: 'pc-bridge', version: '1.0.0' },
    { instructions: '这是连接主人 Windows 电脑的桥。可以用它执行命令、读写文件，也可以给电脑上的 DSH 助手（鲸鱼娘）留言。危险操作请先向主人确认。' },
  );

  server.registerTool(
    'pc_info',
    {
      title: '电脑状态',
      description: '返回电脑的基础信息：主机名、当前时间、工作目录、磁盘剩余空间、Node 版本。',
      inputSchema: {},
    },
    async () => {
      const disks = [];
      for (const d of ['C:', 'D:', 'E:', 'F:']) {
        try {
          const s = fs.statfsSync(d + '\\');
          disks.push(`${d} 剩余 ${(s.bavail * s.bsize / 1024 ** 3).toFixed(1)} GB / 共 ${(s.blocks * s.bsize / 1024 ** 3).toFixed(1)} GB`);
        } catch {}
      }
      return text(
        [
          `主机名: ${os.hostname()}`,
          `系统: ${os.platform()} ${os.release()}`,
          `时间: ${new Date().toLocaleString('zh-CN')}`,
          `工作目录: ${process.cwd()}`,
          `Node: ${process.version}`,
          `CPU 负载: ${os.loadavg().map((n) => n.toFixed(2)).join(' / ')}`,
          ...disks,
        ].join('\n'),
      );
    },
  );

  server.registerTool(
    'pc_shell',
    {
      title: '在这台电脑上执行命令',
      description: '用 PowerShell 执行一条命令，返回退出码与输出。危险、不可逆的操作务必先取得主人同意。',
      inputSchema: {
        command: z.string().describe('要执行的 PowerShell 命令'),
        cwd: z.string().optional().describe('工作目录，默认服务所在目录'),
      },
    },
    async ({ command, cwd }) => {
      const gate = gateState();
      let effCwd = cwd;
      if (!gate.open) {
        const bad = outsidePaths(command);
        if (bad.length) {
          log(`pc_shell 被闸门挡下（命令里有工作区外的路径）: ${clip(command)}`);
          return text(
            `【闸门关着，这条命令被挡下】它碰到了会话工作区（${WORKSPACE}）之外的绝对路径：\n` +
              bad
                .slice(0, 8)
                .map((p) => `· ${p}`)
                .join('\n') +
              '\n\n这是路径围栏不是沙箱：真要跑它，先在手机上按指纹开闸（~/unlock.sh）。',
          );
        }
        // 闸门关着时把 cwd 也钉回工作区，别让相对路径飘出去
        effCwd = cwd && inWorkspace(cwd) ? cwd : WORKSPACE;
      }
      const r = await runShell(command, effCwd, CFG.shellTimeoutMs);
      const parts = [`退出码: ${r.code}${r.killed ? '（超时被终止）' : ''}`];
      if (r.stdout.trim()) parts.push(`--- stdout ---\n${clip(r.stdout)}`);
      if (r.stderr.trim()) parts.push(`--- stderr ---\n${clip(r.stderr)}`);
      if (!r.stdout.trim() && !r.stderr.trim()) parts.push('(无输出)');
      return text(parts.join('\n'));
    },
  );

  server.registerTool(
    'pc_list_dir',
    {
      title: '列目录',
      description: '列出电脑上某个目录的内容，含大小与修改时间。',
      inputSchema: {
        dir: z.string().describe('目录绝对路径'),
        max: z.number().optional().describe('最多返回条目数，默认 1000'),
      },
    },
    async ({ dir, max }) => {
      const target = path.resolve(dir);
      // B1：闸门关着只准看工作区
      if (!gateState().open && !inWorkspace(target)) return text(gateClosedNotice('列目录'));
      if (!fs.existsSync(target)) return text(`目录不存在: ${target}`);
      const entries = fs.readdirSync(target, { withFileTypes: true }).slice(0, max || 1000);
      const rows = entries.map((e) => {
        const full = path.join(target, e.name);
        let size = '';
        let mtime = '';
        try {
          const st = fs.statSync(full);
          size = e.isDirectory() ? '<DIR>' : String(st.size);
          mtime = st.mtime.toISOString().slice(0, 16).replace('T', ' ');
        } catch {}
        return `${e.isDirectory() ? 'd' : '-'} ${size.padStart(12)}  ${mtime}  ${e.name}`;
      });
      return text(`${target}\n共 ${rows.length} 项\n${rows.join('\n')}`);
    },
  );

  server.registerTool(
    'pc_read_file',
    {
      title: '读文件',
      description: '读取电脑上一个 UTF-8 文本文件的内容，可用 offset/limit 分段读。',
      inputSchema: {
        file: z.string().describe('文件绝对路径'),
        offset: z.number().optional().describe('起始行号，从 1 开始'),
        limit: z.number().optional().describe('最多读取行数，默认 2000'),
      },
    },
    async ({ file, offset, limit }) => {
      const target = path.resolve(file);
      // B1：闸门关着只准读工作区
      if (!gateState().open && !inWorkspace(target)) return text(gateClosedNotice('读文件'));
      if (!fs.existsSync(target)) return text(`文件不存在: ${target}`);
      const lines = fs.readFileSync(target, 'utf8').split(/\r?\n/);
      const start = Math.max(0, (offset || 1) - 1);
      const slice = lines.slice(start, start + (limit || 2000));
      const body = slice.map((l, i) => `${start + i + 1}\t${l}`).join('\n');
      return text(`${target}（共 ${lines.length} 行，显示 ${start + 1}-${start + slice.length}）\n${clip(body)}`);
    },
  );

  server.registerTool(
    'pc_write_file',
    {
      title: '写文件（会覆盖）',
      description: '把内容写入电脑上的文件，已存在则整个覆盖。属于不可逆操作，调用前必须先向主人确认。',
      inputSchema: {
        file: z.string().describe('文件绝对路径'),
        content: z.string().describe('完整的新内容'),
        append: z.boolean().optional().describe('true 表示追加而不是覆盖'),
      },
    },
    async ({ file, content, append }) => {
      const target = path.resolve(file);
      // B1：闸门关着只准写工作区（写是不可逆动作，这条是硬拦）
      if (!gateState().open && !inWorkspace(target)) return text(gateClosedNotice('写文件'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (append) fs.appendFileSync(target, content, 'utf8');
      else fs.writeFileSync(target, content, 'utf8');
      return text(`${append ? '已追加' : '已写入'} ${Buffer.byteLength(content, 'utf8')} 字节 -> ${target}`);
    },
  );

  server.registerTool(
    'say_to_dsh',
    {
      title: '给电脑上的鲸鱼娘留言',
      description: '把一段消息投递到桥接信箱，电脑上的 DSH 助手（鲸鱼娘）会在下次查看时读到。想让她干活就在消息里说清楚要做什么。',
      inputSchema: {
        message: z.string().describe('要说的内容'),
      },
    },
    async ({ message }) => {
      const rec = appendMessage('phone', 'dsh', message);
      return text(`已投递到信箱（${rec.iso}）。她会读到的。`);
    },
  );

  server.registerTool(
    'read_dsh_messages',
    {
      title: '读鲸鱼娘的回复',
      description:
        '读取电脑上的 DSH 助手回给手机的消息。可以用 since_ts 只取新的。默认最新的在最前面（order=desc）；' +
        '想要旧的在最前面就传 order=asc。注意：返回的条数始终是“最新的 limit 条”，order 只改排列方向，不改内容。',
      inputSchema: {
        since_ts: z.number().optional().describe('只返回该毫秒时间戳之后的消息'),
        limit: z.number().optional().describe('最多返回条数，默认 20（取最新的 N 条）'),
        order: z
          .enum(['desc', 'asc'])
          .optional()
          .describe('排列方向：desc=最新在最前（默认），asc=最旧在最前（2026-10-14 前的旧行为）'),
      },
    },
    async ({ since_ts, limit, order }) => {
      const msgs = readMessages({
        to: 'phone',
        sinceTs: since_ts,
        limit: limit || 20,
        order: order === 'asc' ? 'asc' : 'desc',
      });
      if (!msgs.length) return text('（暂时没有新消息）');
      return text(msgs.map((m) => `[${m.iso}] ${m.text}`).join('\n\n'));
    },
  );

  // ------------------------------------------------------------ 同步问答
  // 手机问一句，电脑这边开一个一次性 DSH 会话干完活、把最终回答带回来。
  // 权限跟着闸门走：关着只能在会话工作区里折腾，开着才是全盘。
  server.registerTool(
    'pc_ask',
    {
      title: '同步问答（让电脑真的动手干活）',
      description:
        '在电脑上开一个一次性 DSH 会话，把问题/任务交给它，等它干完，把最终回答带回来（同步阻塞）。' +
        '权限随闸门：闸门关着时它只能在会话工作区（默认 config.json 的 askCwd）里读写，动别处会被沙箱拒绝；' +
        '先用 pc_unlock 开闸才有全盘权限。' +
        '适合"帮我看看这个报错""跑个命令告诉我结果""改一下那个文件"这类需要真正动手的活。' +
        '只是聊两句或留个话，用留言通道就行，不必烧这个。',
      inputSchema: {
        prompt: z.string().describe('交给电脑 DSH 的任务或问题，写清楚一点'),
        cwd: z.string().optional().describe('工作目录，默认用 config.askCwd'),
        timeoutMs: z.number().int().positive().optional().describe('超时毫秒，默认 300000（5 分钟）'),
      },
    },
    async ({ prompt, cwd, timeoutMs }) => {
      const gate = gateState();
      const t0 = Date.now();
      log(`pc_ask（闸门${gate.open ? '开' : '关'}）: ${clip(prompt)}`);
      const r = await runDsh(prompt, { fullAccess: gate.open, cwd, timeoutMs });
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      const out = (r.stdout || '').trim();
      const err = (r.stderr || '').trim();
      const head =
        `【电脑 DSH 回答】用时 ${secs} 秒｜权限=${gate.open ? '全盘（闸门已开）' : '仅工作区（闸门关着）'}` +
        `｜${r.killed ? '超时被中断' : `退出码 ${r.code}`}`;
      log(`pc_ask 结束，用时 ${secs} 秒，退出码 ${r.code}`);
      if (out) return text(`${head}\n\n${clip(out)}`);
      return text(
        `${head}\n\n（它没吐出最终回答）` + (err ? `\n\n—— 日志尾部 ——\n${clip(err.slice(-4000))}` : ''),
      );
    },
  );

  // ------------------------------------------------------------ 权限闸门
  server.registerTool(
    'pc_gate',
    {
      title: '查权限闸门',
      description: '看电脑这边的权限闸门现在开着没有、还剩多久、谁开的。开闸用 pc_unlock，收回来用 pc_lock。',
      inputSchema: {},
    },
    async () => {
      const g = gateState();
      if (!g.open) {
        return text(
          '【闸门：关着】手机派来的活只能在会话工作区里干。\n' +
            '要开全盘权限：在手机上跑 ~/unlock.sh（会先要你按指纹），或者调 pc_unlock action="nonce" 走一遍流程。',
        );
      }
      return text(
        '【闸门：开着】\n' +
          `· 开到：${new Date(g.until).toLocaleString('zh-CN')}\n` +
          `· 还剩：${Math.ceil(g.remainMs / 60000)} 分钟\n` +
          `· 开的时刻：${g.openedAt ? new Date(g.openedAt).toLocaleString('zh-CN') : '-'}\n` +
          `· 经手人：${g.by || '-'}\n` +
          '要立刻收回，调 pc_lock。',
      );
    },
  );

  server.registerTool(
    'pc_unlock',
    {
      title: '开权限闸门（要手机指纹签名）',
      description:
        '把权限闸门打开一段时间（默认 30 分钟），期间手机派来的活可以动全盘。' +
        '正规流程：action="nonce" 领一个一次性挑战码 → 手机上的 unlock.sh 先要主人按指纹，' +
        '指纹过了才用共享密钥对挑战码签名 → 把 nonce 和 sig 带回来调 action="verify"。' +
        '裸调 verify 是开不了的，这是故意设的门槛。' +
        'action="manual" 是给人坐在电脑前用的后门，跳过指纹，谁摸到这条通道谁能开，慎用。',
      inputSchema: {
        action: z
          .enum(['nonce', 'verify', 'manual'])
          .describe('nonce=领挑战码；verify=带签名开闸；manual=手动开闸（跳过指纹）'),
        nonce: z.string().optional().describe('action=verify 时必填，之前领到的挑战码'),
        sig: z.string().optional().describe('action=verify 时必填，HMAC-SHA256(共享密钥, 挑战码) 的十六进制'),
        minutes: z.number().int().positive().max(720).optional().describe('开多久，默认 30 分钟'),
        by: z.string().optional().describe('谁开的，写进日志方便回溯'),
      },
    },
    async ({ action, nonce, sig, minutes, by }) => {
      if (action === 'nonce') {
        const n = issueNonce();
        return text(
          `【一次性挑战码】${n}\n` +
            '有效期 60 秒，只能用一次。\n' +
            '签名 = HMAC-SHA256(共享密钥, 挑战码) 的十六进制。\n' +
            '用手机上的 ~/unlock.sh 会自动办妥；要手搓就拿它调 action="verify"。',
        );
      }

      if (action === 'verify') {
        if (!nonce || !sig) return text('verify 要同时给 nonce 和 sig。');
        if (!consumeNonce(nonce)) return text('这个挑战码无效、过期，或者已经用过了——重新领一个。');
        const want = signNonce(nonce);
        const got = String(sig).trim().toLowerCase();
        let same = false;
        try {
          same = crypto.timingSafeEqual(Buffer.from(want, 'hex'), Buffer.from(got, 'hex'));
        } catch {
          same = false; // sig 不是合法 hex / 长度不对，直接判否
        }
        if (!same) {
          log(`pc_unlock 签名不对，自称=${by || '未知'}`);
          return text('签名对不上，开不了。指纹白按了，麻烦重来一次。');
        }
        const mins = minutes || UNLOCK_TTL_MS / 60000;
        const ttl = mins * 60 * 1000;
        const now = Date.now();
        writeGate({ unlockedUntil: now + ttl, openedAt: now, by: by || '手机指纹' });
        log(`闸门已开 ${mins} 分钟，经手人=${by || '手机指纹'}`);
        return text(
          `【闸门已开】${mins} 分钟，到 ${new Date(now + ttl).toLocaleString('zh-CN')} 自动落回工作区。\n` +
            '这段时间 pc_ask 派出去的活可以动全盘。想提前收回：pc_lock。',
        );
      }

      const mins = minutes || UNLOCK_TTL_MS / 60000;
      const ttl = mins * 60 * 1000;
      const now = Date.now();
      writeGate({ unlockedUntil: now + ttl, openedAt: now, by: by || '手动（未经指纹）' });
      log(`闸门手动开启 ${mins} 分钟，经手人=${by || '手动（未经指纹）'}`);
      return text(
        `【闸门已手动开启】${mins} 分钟。\n` +
          '提醒一句：这步跳过了指纹，谁摸到这条 MCP 通道谁就能开。不是人在电脑前就别用。',
      );
    },
  );

  server.registerTool(
    'pc_lock',
    {
      title: '关权限闸门',
      description:
        '立刻把闸门收回来，手机派来的活马上降回「只能动会话工作区」。不需要任何凭据——收紧权限永远不用申请。',
      inputSchema: {},
    },
    async () => {
      writeGate({ unlockedUntil: 0, openedAt: 0, by: '' });
      log('闸门已关');
      return text('【闸门已关】手机派来的活现在只能在会话工作区里干了。');
    },
  );

  // ------------------------------------------------------------ 电源与音量
  // 关机/重启/休眠是会打断主人手头事情的动作，默认留 60 秒反悔期。
  const VOL_CS = [
    'using System;',
    'using System.Runtime.InteropServices;',
    '[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
    'interface IAEV { int a1(); int a2(); int a3(); int a4(); int SetScalar(float l, ref Guid g); int a5(); int GetScalar(out float l); int a6(); int a7(); int a8(); int a9(); int a10(); int SetMute(bool m, ref Guid g); int GetMute(out bool m); }',
    '[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
    'interface IMMDevice { int Activate(ref Guid id, int ctx, IntPtr act, [MarshalAs(UnmanagedType.IUnknown)] out object o); int b1(); int b2(); int b3(); int b4(); }',
    '[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
    'interface IMMEnum { int n0(); int GetDefault(int flow, int role, out IMMDevice dev); }',
    '[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MME { }',
    'public class Vol { public static void Set(int pct) { var e = (IMMEnum)(new MME()); IMMDevice d; e.GetDefault(0,1,out d); var iid = typeof(IAEV).GUID; object o; d.Activate(ref iid, 23, IntPtr.Zero, out o); var v = (IAEV)o; var g = Guid.Empty; v.SetScalar(pct/100f, ref g); } }',
  ].join('\n');

  server.registerTool(
    'pc_power',
    {
      title: '电源与音量',
      description:
        '锁屏 / 睡眠 / 关机 / 重启 / 休眠 / 取消关机 / 设音量。' +
        '关机、重启默认留 60 秒反悔期（随时可以 cancel 撤回），要立刻执行就传 delaySec=0。' +
        '这些是会打断主人手头事情的动作：除非主人明确说了要关/要重启，否则不要自己调。',
      inputSchema: {
        action: z
          .enum(['lock', 'sleep', 'hibernate', 'shutdown', 'restart', 'cancel', 'volume'])
          .describe('要做什么'),
        delaySec: z
          .number()
          .int()
          .min(0)
          .max(3600)
          .optional()
          .describe('关机/重启的倒计时秒数，默认 60（可 cancel 反悔）；0 = 立刻'),
        level: z.number().int().min(0).max(100).optional().describe('action=volume 时的音量百分比 0-100'),
        force: z.boolean().optional().describe('关机/重启时是否强制关掉未保存的程序，默认 false'),
      },
    },
    async ({ action, delaySec, level, force }) => {
      // B1：锁屏/睡眠/关机/重启/音量都归全权限档（文档 6.2），闸门关着不许动。
      // cancel 例外 —— 撤销关机是收紧动作，永远不用申请。
      if (action !== 'cancel' && !gateState().open) {
        log(`pc_power ${action} 被闸门挡下`);
        return text(
          `【闸门关着】${action} 属于全权限档的动作（文档 6.2），得先开闸。\n` +
            '在手机上跑 ~/unlock.sh 按一次指纹，或者调 pc_unlock。\n' +
            'action="cancel" 不受限制 —— 撤销关机不需要申请。',
        );
      }
      switch (action) {
        case 'lock': {
          const r = await runShell('rundll32.exe user32.dll,LockWorkStation', undefined, 15000);
          log('pc_power: lock');
          return text(r.code === 0 ? '已锁屏。' : `锁屏失败：${clip((r.stderr || r.stdout).trim())}`);
        }

        case 'sleep': {
          // SetSuspendState 会一直阻塞到电脑被唤醒，所以给短超时，超时也算成功
          const r = await runShell(
            'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState("Suspend", $false, $false)',
            undefined,
            15000,
          );
          log('pc_power: sleep');
          return text(
            r.killed || r.code === 0
              ? '已让电脑睡眠。'
              : `睡眠失败：${clip((r.stderr || r.stdout).trim())}`,
          );
        }

        case 'hibernate': {
          const r = await runShell('shutdown /h', undefined, 15000);
          log('pc_power: hibernate');
          return text(r.code === 0 ? '已让电脑休眠。' : `休眠失败：${clip((r.stderr || r.stdout).trim())}`);
        }

        case 'shutdown':
        case 'restart': {
          const d = delaySec === undefined ? POWER_GRACE_MS / 1000 : delaySec;
          const flag = action === 'shutdown' ? '/s' : '/r';
          const r = await runShell(`shutdown ${flag} /t ${d}${force ? ' /f' : ''}`, undefined, 15000);
          log(`pc_power: ${action} in ${d}s`);
          if (r.code !== 0) {
            return text(`${action === 'shutdown' ? '关机' : '重启'}命令没吃下去：${clip((r.stderr || r.stdout).trim())}`);
          }
          if (d === 0) return text(action === 'shutdown' ? '电脑这就关了。' : '电脑这就重启了。');
          return text(
            `电脑会在 ${d} 秒后${action === 'shutdown' ? '关机' : '重启'}。\n` +
              '反悔的话立刻调 pc_power action="cancel"，或者直接在这台电脑上敲 shutdown /a。',
          );
        }

        case 'cancel': {
          const r = await runShell('shutdown /a', undefined, 15000);
          log('pc_power: cancel');
          if (r.code === 0) return text('已取消待执行的关机/重启。');
          return text(`取消没成功（大概本来就没有待执行的关机/重启）：${clip((r.stderr || r.stdout).trim())}`);
        }

        case 'volume': {
          if (level === undefined) return text('要调音量得给 level，0 到 100。');
          const cmd = `Add-Type -TypeDefinition @'\n${VOL_CS}\n'@\n[Vol]::Set(${level})`;
          const r = await runShell(cmd, undefined, 60000);
          log(`pc_power: volume ${level}`);
          if (r.code !== 0) return text(`音量没调成：${clip((r.stderr || r.stdout).trim())}`);
          return text(`音量已设到 ${level}%。`);
        }

        default:
          return text(`不认识的动作：${action}`);
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------- 文件下载
// 手机浏览器访问 /files 看清单，/files/<文件名> 下载。
// 安全性：只认 DOWNLOADS 这一层，取 basename 后拼接，杜绝 ../ 穿越。
function handleFiles(url, res) {
  const raw = decodeURIComponent(url.pathname.replace(/^\/files\/?/, ''));

  if (!raw) {
    let files = [];
    try {
      files = fs
        .readdirSync(DOWNLOADS, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => {
          const st = fs.statSync(path.join(DOWNLOADS, e.name));
          return { name: e.name, mb: +(st.size / 1048576).toFixed(2), mtime: st.mtime.toISOString() };
        })
        .sort((a, b) => b.mtime.localeCompare(a.mtime));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(err.message) }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ dir: DOWNLOADS, count: files.length, files }, null, 2));
    return;
  }

  const safe = path.basename(raw);
  const full = path.join(DOWNLOADS, safe);
  if (path.dirname(path.resolve(full)) !== path.resolve(DOWNLOADS)) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad path');
    return;
  }

  let st;
  try {
    st = fs.statSync(full);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  if (!st.isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not a file');
    return;
  }

  log(`下载 ${safe}（${(st.size / 1048576).toFixed(1)} MB）`);
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': st.size,
    'content-disposition': `attachment; filename="${encodeURIComponent(safe)}"`,
  });
  fs.createReadStream(full).pipe(res);
}

// ---------------------------------------------------------------- HTTP
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const peer = req.socket.remoteAddress || '';

  // IP 白名单：allowCidrs 非空时，只放行清单内的来源（/health 也走这道门）
  if (!clientAllowed(peer)) {
    log(`拒绝 ${peer} 的 ${req.method} ${url.pathname}（不在 allowCidrs 内）`);
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'forbidden', peer, hint: '来源地址不在 allowCidrs 白名单内' }));
    return;
  }

  if (url.pathname === '/' || url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, service: 'phone-bridge', mcp: '/mcp', time: new Date().toISOString() }));
    return;
  }

  // 认证（/ 与 /health 之外的一切都要带 token）
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : url.searchParams.get('token') || '';
  if (token !== CFG.token) {
    log(`认证失败，来自 ${req.socket.remoteAddress}`);
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  // 文件下载：把电脑上的文件递给手机
  if (url.pathname === '/files' || url.pathname.startsWith('/files/')) {
    handleFiles(url, res);
    return;
  }

  // 信箱阅读页：手机/电脑浏览器直接读完整信箱
  if (url.pathname === '/mail') {
    handleMail(url, res);
    return;
  }

  if (url.pathname !== '/mcp') {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }

  // 诊断日志：把每一个摸到 /mcp 的请求都记下来，方法 + 来源 + Accept
  log(`MCP ${req.method} /mcp 来自 ${req.socket.remoteAddress} accept=${req.headers.accept || '-'}`);

  // 关键：MCP Streamable HTTP 规范里，客户端会先用 GET /mcp 打开 SSE 通知流。
  // 本服务是 stateless + JSON 响应模式，没有服务端主动推送，但**这个门必须开着**：
  // 直接回 405 会让 RikkaHub 判定整个连接失败（客户端侧表现为 connect timeout）。
  // 所以给一个合法但安静的 SSE 流，只用注释行做心跳。
  if (req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    let done = false;
    const ping = setInterval(() => {
      if (done || res.writableEnded) return;
      try {
        res.write(': ping\n\n');
      } catch {
        /* 客户端已经走了 */
      }
    }, 20000);
    const bye = () => {
      if (done) return;
      done = true;
      clearInterval(ping);
      try {
        res.end();
      } catch {
        /* 无所谓 */
      }
    };
    req.on('close', bye);
    res.on('close', bye);
    return;
  }

  if (req.method !== 'POST') {
    log(`拒绝 ${req.method} /mcp，来自 ${req.socket.remoteAddress}`);
    res.writeHead(405, { allow: 'GET, POST', 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method Not Allowed' }, id: null }));
    return;
  }

  // 读取请求体
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  let body;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'parse error' }, id: null }));
      return;
    }
  }

  try {
    const mcp = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close().catch(() => {});
      mcp.close().catch(() => {});
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    log('[phone-bridge] 请求处理失败:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: String(err && err.message) }, id: null }));
    }
  }
});

// SSE 通知流是长连接，不能被 Node 默认的 5 分钟请求超时掐掉
server.requestTimeout = 0;
server.headersTimeout = 60000;

server.listen(CFG.port, CFG.host, () => {
  const nets = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) nets.push(ni.address);
    }
  }
  log(`[phone-bridge] 已启动，shell = ${SHELL}`);
  log(`[phone-bridge] MCP 端点: http://<本机IP>:${CFG.port}/mcp`);
  for (const ip of nets) log(`  -> http://${ip}:${CFG.port}/mcp`);
  log(`[phone-bridge] 认证 token: ${CFG.token}`);
  log(
    `[phone-bridge] 来源白名单: ${
      ALLOW.length ? ALLOW.map((c) => c.raw).join(', ') : '（未限制，任何来源都放行）'
    }`,
  );
  log(`[phone-bridge] 单条命令超时 ${CFG.shellTimeoutMs}ms，输出上限 ${CFG.maxOutputBytes} 字节`);
  log(`[phone-bridge] 信箱文件: ${MSG_FILE}`);
});


// ---------------------------------------------------------------- 信箱阅读页
// 浏览器打开 http://<本机IP>:8790/mail?token=<token> 就能读完整信箱（手机上也行）。
// 只读，不写任何东西；所有正文都做 HTML 转义。
//
// renderMd：极简 Markdown 渲染器（不依赖任何外网 CDN，手机离线也能用）。
// 安全前提：**先转义再插标签**——外面拿到的文本一律经过 esc()，渲染器只往里插
// 自己生成的 <strong>/<code>/<table> 等标签，用户内容永远不会变成可执行 HTML。
// 支持：``` 围栏代码块、`行内代码`、**粗体**、*斜体*、~~删除线~~、
//       [文字](链接)、# 标题、- 无序列表、1. 有序列表、> 引用、--- 分隔线、
//       | 表格 |（第二行是 |---|---| 就认成表格）。
function renderMd(src) {
  const esc = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const tokens = [];
  const stash = (html) => {
    tokens.push(html);
    return '\u0000' + (tokens.length - 1) + '\u0000';
  };

  let t = String(src).replace(/\r\n/g, '\n');

  // 1) 围栏代码块（先摘出来，免得里面的符号被当成行内语法）
  t = t.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, code) =>
    stash('<pre><code>' + esc(String(code).replace(/\n+$/, '')) + '</code></pre>'),
  );
  // 2) 行内代码
  t = t.replace(/`([^`\n]+)`/g, (_m, code) => stash('<code>' + esc(code) + '</code>'));
  // 3) 整体转义 —— 从这里往下，正文已经安全了
  t = esc(t);
  // 4) 行内语法
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  t = t.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
  );
  // 5) 块级语法：逐行扫
  const out = [];
  const lines = t.split('\n');
  let inUl = false;
  let inOl = false;
  const closeList = () => {
    if (inUl) { out.push('</ul>'); inUl = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
  };
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];

    // 表格：本行有 | 且下一行是分隔行
    if (/^\s*\|/.test(ln) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      closeList();
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(ln);
      i += 2;
      let tb = '<table><thead><tr>' + head.map((h) => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>';
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        tb += '<tr>' + cells(lines[i]).map((c) => '<td>' + c + '</td>').join('') + '</tr>';
        i++;
      }
      out.push(tb + '</tbody></table>');
      continue;
    }

    const h = ln.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const lv = Math.min(h[1].length + 1, 6);
      out.push('<h' + lv + '>' + h[2] + '</h' + lv + '>');
      i++;
      continue;
    }
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(ln)) {
      closeList();
      out.push('<hr>');
      i++;
      continue;
    }
    if (/^\s*&gt;\s?/.test(ln)) {
      closeList();
      const buf = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*&gt;\s?/, ''));
        i++;
      }
      out.push('<blockquote>' + buf.join('<br>') + '</blockquote>');
      continue;
    }
    const ul = ln.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      // 已经在一个有序列表里：把短横线当子项，保持 <ol> 编号连续
      if (inOl) {
        out.push('<li class="sub">' + ul[1] + '</li>');
        i++;
        continue;
      }
      if (!inUl) { out.push('<ul>'); inUl = true; }
      out.push('<li>' + ul[1] + '</li>');
      i++;
      continue;
    }
    const ol = ln.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      if (inUl) {
        out.push('<li class="sub">' + ol[1] + '</li>');
        i++;
        continue;
      }
      if (!inOl) { out.push('<ol>'); inOl = true; }
      out.push('<li>' + ol[1] + '</li>');
      i++;
      continue;
    }
    closeList();
    if (ln.trim() === '') {
      i++;
      continue;
    }
    // 整行就是一个代码块占位符 —— 直接吐出来，别包 <p>（<pre> 不能嵌在 <p> 里）
    if (/^\u0000\d+\u0000$/.test(ln.trim())) {
      out.push(ln.trim());
      i++;
      continue;
    }
    out.push('<p>' + ln + '</p>');
    i++;
  }
  closeList();

  // 6) 把代码块/行内代码还回来
  return out.join('\n').replace(/\u0000(\d+)\u0000/g, (_m, n) => tokens[Number(n)] || '');
}

function handleMail(url, res) {
  let lines = [];
  try {
    lines = fs
      .readFileSync(MSG_FILE, 'utf8')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    lines = [];
  }

  // 呈递顺序（2026-10-14 主人要求「新的在最上面」）：默认倒序；?order=asc 切回旧的在上面
  const order = url.searchParams.get('order') === 'asc' ? 'asc' : 'desc';

  const esc = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  let bad = 0;
  const cards = [];
  lines.forEach((ln, i) => {
    let o;
    try {
      o = JSON.parse(ln);
    } catch {
      bad++;
      return;
    }
    const isPhone = o.from === 'phone';
    const who = isPhone ? '妹妹 · 手机' : '鲸鱼娘 · 电脑';
    const cls = isPhone ? 'phone' : 'dsh';
    const txt = renderMd(o.text || '');
    cards.push(
      `<article class="card ${cls}">` +
        `<header><span class="who">${who}</span>` +
        `<span class="ts">${esc(o.iso || '')}</span>` +
        `<span class="len">${(o.text || '').length} 字</span>` +
        `<span class="no">#${i + 1}</span></header>` +
        `<div class="body">${txt}</div>` +
        `</article>`,
    );
  });

  const title = `信箱 · ${lines.length} 封`;
  const html =
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${title}</title><style>` +
    `*{box-sizing:border-box}` +
    `body{margin:0;padding:16px 12px 60px;background:#0f1420;color:#e6edf7;` +
    `font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}` +
    `h1{font-size:17px;margin:0 0 4px;color:#8fd0ff}` +
    `.sub{font-size:12px;color:#7c8aa3;margin-bottom:16px}` +
    `.card{margin:0 0 14px;border-radius:12px;padding:12px 14px;background:#161d2e;border-left:4px solid #2f6fb0}` +
    `.card.phone{border-left-color:#2fae7a;background:#141f1c}` +
    `header{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;margin-bottom:8px;font-size:12px}` +
    `.who{font-weight:600;color:#8fd0ff}` +
    `.card.phone .who{color:#6fdca8}` +
    `.ts{color:#7c8aa3}.len,.no{color:#5d6b82;margin-left:auto}` +
    `.no{margin-left:0}` +
    `.body{white-space:normal;word-break:break-word}` +
    `.body p{margin:0 0 7px}.body p:last-child{margin-bottom:0}` +
    `.body strong{color:#ffd479;font-weight:700}` +
    `.body em{color:#c9b6ff;font-style:italic}` +
    `.body del{color:#7c8aa3}` +
    `.body code{background:#0b1220;border:1px solid #253048;border-radius:4px;` +
    `padding:1px 5px;color:#9fe8b0;font:13px/1.5 ui-monospace,Consolas,"Courier New",monospace}` +
    `.body pre{background:#0b1220;border:1px solid #253048;border-radius:8px;` +
    `padding:10px 12px;margin:8px 0;overflow-x:auto}` +
    `.body pre code{background:none;border:none;padding:0;color:#cfe8d6;` +
    `font-size:13px;line-height:1.55;white-space:pre}` +
    `.body table{border-collapse:collapse;margin:9px 0;font-size:13.5px;display:block;overflow-x:auto}` +
    `.body th,.body td{border:1px solid #2b3852;padding:5px 10px;text-align:left;vertical-align:top}` +
    `.body th{background:#1d2740;color:#8fd0ff;font-weight:600;white-space:nowrap}` +
    `.body tr:nth-child(even) td{background:#141b2a}` +
    `.body ul,.body ol{margin:6px 0;padding-left:22px}` +
    `.body li{margin:2px 0}` +
    `.body li.sub{list-style:none;margin-left:-10px;color:#c3d0e2}` +
    `.body h2,.body h3,.body h4,.body h5{margin:12px 0 6px;color:#8fd0ff;font-size:15px}` +
    `.body h3{font-size:14px;color:#a8c7e8}.body h4,.body h5{font-size:13.5px;color:#93a7c2}` +
    `.body blockquote{margin:8px 0;padding:6px 12px;border-left:3px solid #3d5a86;` +
    `background:#141b2a;color:#b9c6da}` +
    `.body hr{border:none;border-top:1px solid #2b3852;margin:12px 0}` +
    `a{color:#8fd0ff}` +
    `</style></head><body>` +
    `<h1>${title}</h1>` +
    `<div class="sub">生成于 ${new Date().toISOString()} · 坏行 ${bad} · ` +
    `<a href="?token=${encodeURIComponent(url.searchParams.get('token') || '')}">刷新</a> · ` +
    `<a href="?token=${encodeURIComponent(url.searchParams.get('token') || '')}&order=${order === 'desc' ? 'asc' : 'desc'}">` +
    `${order === 'desc' ? '改成最旧在上' : '改成最新在上'}</a> · ` +
    `${order === 'desc' ? '最新在最上面' : '最新在最下面'}</div>` +
    (order === 'desc' ? cards.slice().reverse() : cards).join('\n') +
    `</body></html>`;

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}