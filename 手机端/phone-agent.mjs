#!/usr/bin/env node
/**
 * phone-agent — 跑在 Android / Termux 里的 MCP 服务器
 *
 * 作用：让电脑上的 DSH 助手（以及任何 MCP 客户端）能够操作这部手机。
 * 零依赖：只用 Node 内置模块，Termux 里 `pkg install nodejs` 就能跑。
 *
 * 依赖的 Termux 侧能力：
 *   pkg install nodejs termux-api      # termux-api 包 + Termux:API 应用
 *
 * 用法：
 *   node phone-agent.mjs               # 默认 0.0.0.0:8790
 *   node phone-agent.mjs --port 8790
 *   node phone-agent.mjs --token xxxx  # 指定 token（首次运行会自动生成 config.json）
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(ROOT, 'config.json');
const LOG_FILE = path.join(ROOT, 'phone-agent.log');

// ------------------------------------------------------------------ 日志
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
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch {
    /* 日志写不进去也不能拖垮服务 */
  }
}

// ------------------------------------------------------------------ 配置
function loadConfig() {
  const argv = process.argv.slice(2);
  const getArg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };

  let cfg = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      log('config.json 解析失败，按默认值重建:', err);
      cfg = {};
    }
  }

  const portArg = getArg('--port');
  const tokenArg = getArg('--token');

  const merged = {
    host: cfg.host || '0.0.0.0',
    port: portArg ? Number(portArg) : cfg.port || 8790,
    token: tokenArg || cfg.token || crypto.randomBytes(24).toString('hex'),
    shellTimeoutMs: cfg.shellTimeoutMs || 60000,
    maxOutputBytes: cfg.maxOutputBytes || 100000,
    authRequired: cfg.authRequired !== false,
  };

  const changed = JSON.stringify(merged) !== JSON.stringify(cfg);
  if (changed) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
    log('已写入 config.json');
  }
  return merged;
}

const CFG = loadConfig();

// ------------------------------------------------------------------ 执行 termux 命令
function sh(command, timeoutMs = CFG.shellTimeoutMs) {
  return new Promise((resolve) => {
    execFile(
      '/data/data/com.termux/files/usr/bin/bash',
      ['-lc', command],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT') {
          // bash 路径不对就退回 sh
          execFile('sh', ['-c', command], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (e2, o2, er2) => {
            resolve({ code: e2 ? (e2.code ?? 1) : 0, stdout: o2 || '', stderr: er2 || (e2 ? e2.message : '') });
          });
          return;
        }
        resolve({
          code: err ? (err.code ?? 1) : 0,
          stdout: stdout || '',
          stderr: stderr || (err && err.killed ? `超时（${timeoutMs}ms）已终止` : ''),
          timeout: Boolean(err && err.killed),
        });
      },
    );
  });
}

function clip(text) {
  const s = String(text ?? '');
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= CFG.maxOutputBytes) return s;
  return buf.subarray(0, CFG.maxOutputBytes).toString('utf8') + `\n…（已截断，原长 ${buf.length} 字节）`;
}

const text = (s) => ({ content: [{ type: 'text', text: clip(s) }] });
const ok = (s) => text(s);
const fail = (s) => ({ content: [{ type: 'text', text: clip(s) }], isError: true });

/** 跑一条 termux-* 命令，把结果拼成人类可读的一段话 */
async function termux(cmd, { emptyHint = '' } = {}) {
  const r = await sh(cmd);
  const out = (r.stdout || '').trim();
  const err = (r.stderr || '').trim();
  if (r.code !== 0 && !out) {
    if (/not found|No such file/i.test(err)) {
      return fail(
        `执行失败：${err}\n\n` +
          `看起来 Termux:API 没装好。请在 Termux 里执行：\n` +
          `  pkg install termux-api\n` +
          `并安装 Termux:API 应用（与 Termux 同源签名），然后重试。`,
      );
    }
    return fail(`退出码 ${r.code}\n${err || '(无输出)'}`);
  }
  if (!out && emptyHint) return text(emptyHint);
  return text(out || '(无输出)');
}

// ------------------------------------------------------------------ 工具表
const TOOLS = [
  {
    name: 'phone_info',
    description: '返回手机的基础状态：型号、Android 版本、电量、存储、网络、Termux 环境。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      // 注意：termux-api 的命令（battery-status / wifi-connectioninfo 等）不能并发调用，
      // 同时发会互相咬死（实测单跑各约 200ms，并发会卡满超时）。所以只有普通 shell 命令并行，
      // 两个 termux-api 调用改成串行。
      const [model, android, storage, uptime] = await Promise.all([
        sh('getprop ro.product.model'),
        sh('getprop ro.build.version.release'),
        sh('df -h /data/data/com.termux/files/home | tail -n 1'),
        sh('uptime'),
      ]);
      const battery = await sh('termux-battery-status');
      const net = await sh('termux-wifi-connectioninfo');
      const lines = [
        `机型: ${model.stdout.trim() || '未知'}`,
        `Android: ${android.stdout.trim() || '未知'}`,
        `Termux 家目录剩余: ${storage.stdout.trim() || '未知'}`,
        `运行时长: ${uptime.stdout.trim() || '未知'}`,
      ];
      try {
        const b = JSON.parse(battery.stdout);
        lines.push(`电量: ${b.percentage}%（${b.plugged === 'PLUGGED_AC' ? '充电中' : '未充电'}，${b.temperature}°C）`);
      } catch {
        lines.push('电量: 读不到（Termux:API 未就绪）');
      }
      try {
        const w = JSON.parse(net.stdout);
        lines.push(`WiFi: ${w.ssid ?? '未知'} | IP ${w.ip ?? '未知'} | ${w.link_speed_mbps ?? '?'} Mbps`);
      } catch {
        lines.push('WiFi: 读不到');
      }
      return ok(lines.join('\n'));
    },
  },
  {
    name: 'phone_notify',
    description:
      '在手机上弹一条通知。电脑那边的助手想主动告诉手机主人一件事时用它。支持标题、正文、以及可选的提示音/震动。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '通知标题' },
        content: { type: 'string', description: '通知正文' },
        sound: { type: 'boolean', description: '是否播放提示音，默认 true' },
        vibrate: { type: 'boolean', description: '是否震动，默认 false' },
      },
      required: ['title', 'content'],
      additionalProperties: false,
    },
    handler: async ({ title, content, sound = true, vibrate = false }) => {
      const esc = (s) => String(s).replace(/'/g, `'\\''`);
      const flags = [sound ? '--sound' : '', vibrate ? '--vibrate 300' : ''].filter(Boolean).join(' ');
      return termux(`termux-notification --title '${esc(title)}' --content '${esc(content)}' ${flags} --id phone-agent`);
    },
  },
  {
    name: 'phone_clipboard_get',
    description: '读取手机剪贴板当前内容。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => termux('termux-clipboard-get', { emptyHint: '(剪贴板是空的)' }),
  },
  {
    name: 'phone_clipboard_set',
    description: '把文字写进手机剪贴板。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要写入的文本' } },
      required: ['text'],
      additionalProperties: false,
    },
    handler: async ({ text: t }) => {
      const esc = String(t).replace(/'/g, `'\\''`);
      const r = await sh(`printf '%s' '${esc}' | termux-clipboard-set`);
      return r.code === 0 ? ok('已写入剪贴板。') : fail(`写入失败：${r.stderr || r.code}`);
    },
  },
  {
    name: 'phone_sh',
    description:
      '在手机的 Termux 环境里执行一条 shell 命令并返回输出。可以直接操作手机文件、调用 termux-* 系列命令、跑 git/node/python 等。危险或不可逆的命令请先向主人确认。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令' },
        cwd: { type: 'string', description: '工作目录，默认 Termux 家目录' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    handler: async ({ command, cwd }) => {
      const prefix = cwd ? `cd '${String(cwd).replace(/'/g, `'\\''`)}' && ` : '';
      const r = await sh(prefix + command);
      const parts = [`退出码: ${r.code}`];
      if (r.stdout.trim()) parts.push(`--- stdout ---\n${r.stdout.trimEnd()}`);
      if (r.stderr.trim()) parts.push(`--- stderr ---\n${r.stderr.trimEnd()}`);
      return r.code === 0 ? ok(parts.join('\n')) : fail(parts.join('\n'));
    },
  },
  {
    name: 'phone_list_dir',
    description: '列出手机某个目录的内容，含大小与修改时间。',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '目录绝对路径，例如 /sdcard/Download' },
      },
      required: ['dir'],
      additionalProperties: false,
    },
    handler: async ({ dir }) => {
      const esc = String(dir).replace(/'/g, `'\\''`);
      return termux(`ls -lAh --time-style=long-iso '${esc}'`, { emptyHint: '(目录是空的)' });
    },
  },
  {
    name: 'phone_read_file',
    description: '读取手机上一个 UTF-8 文本文件的内容，可用 offset/limit 分段。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '文件绝对路径' },
        offset: { type: 'number', description: '从第几行开始，默认 1' },
        limit: { type: 'number', description: '读取多少行，默认 300' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    handler: async ({ file, offset = 1, limit = 300 }) => {
      const esc = String(file).replace(/'/g, `'\\''`);
      return termux(`sed -n '${Number(offset)},${Number(offset) + Number(limit) - 1}p' '${esc}'`);
    },
  },
  {
    name: 'phone_write_file',
    description:
      '把内容写入手机上的文件（默认整个覆盖）。属于不可逆操作，调用前必须先向主人确认。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '文件绝对路径' },
        content: { type: 'string', description: '要写入的内容' },
        append: { type: 'boolean', description: 'true 则追加而不是覆盖，默认 false' },
      },
      required: ['file', 'content'],
      additionalProperties: false,
    },
    handler: async ({ file, content, append = false }) => {
      const esc = String(file).replace(/'/g, `'\\''`);
      const dir = path.posix.dirname(String(file).replace(/\\/g, '/'));
      const b64 = Buffer.from(String(content), 'utf8').toString('base64');
      const op = append ? '>>' : '>';
      const cmd =
        `mkdir -p '${dir}' && printf '%s' '${b64}' | base64 -d ${op} '${esc}' && ` +
        `wc -c < '${esc}'`;
      const r = await sh(cmd);
      return r.code === 0
        ? ok(`已写入 ${file}（${append ? '追加' : '覆盖'}），现在 ${r.stdout.trim()} 字节。`)
        : fail(`写入失败：${r.stderr || r.code}`);
    },
  },
  {
    name: 'phone_open_url',
    description: '在手机上用默认应用打开一个 URL 或 Android 应用。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要打开的 URL，例如 https://example.com' },
        app: { type: 'string', description: '可选：要启动的包名，例如 com.tencent.mm' },
      },
      additionalProperties: false,
    },
    handler: async ({ url, app }) => {
      const cmd = app
        ? `termux-open --content-type '' --chooser '' ; monkey -p '${String(app).replace(/'/g, `'\\''`)}' -c android.intent.category.LAUNCHER 1`
        : `termux-open '${String(url || '').replace(/'/g, `'\\''`)}'`;
      return termux(cmd);
    },
  },
  {
    name: 'phone_speak',
    description: '让手机用 TTS 朗读一段文字。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要朗读的文字' } },
      required: ['text'],
      additionalProperties: false,
    },
    handler: async ({ text: t }) => {
      const esc = String(t).replace(/'/g, `'\\''`);
      const r = await sh(`termux-tts-speak '${esc}'`);
      return r.code === 0 ? ok('已朗读。') : fail(`朗读失败：${r.stderr || r.code}`);
    },
  },
  {
    name: 'phone_vibrate',
    description: '让手机震动一下。',
    inputSchema: {
      type: 'object',
      properties: { durationMs: { type: 'number', description: '震动时长（毫秒），默认 500' } },
      additionalProperties: false,
    },
    handler: async ({ durationMs = 500 }) => {
      const r = await sh(`termux-vibrate -d ${Number(durationMs)}`);
      return r.code === 0 ? ok(`震动 ${durationMs}ms。`) : fail(`震动失败：${r.stderr || r.code}`);
    },
  },
  {
    name: 'phone_sms_list',
    description: '读取手机短信列表（需要授予 Termux:API 短信读取权限）。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '取多少条，默认 10' } },
      additionalProperties: false,
    },
    handler: async ({ limit = 10 }) => termux(`termux-sms-list -l ${Number(limit)}`),
  },
  {
    name: 'phone_location',
    description: '获取手机当前位置（需要定位权限，可能较慢）。',
    inputSchema: {
      type: 'object',
      properties: { provider: { type: 'string', description: 'gps / network / passive，默认 network' } },
      additionalProperties: false,
    },
    handler: async ({ provider = 'network' }) =>
      termux(`termux-location -p ${String(provider).replace(/[^a-z]/gi, '')}`),
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

// ------------------------------------------------------------------ MCP 协议
const PROTOCOL_VERSION = '2025-06-18';

async function handleRpc(msg) {
  const { id, method, params } = msg;

  // 通知类消息没有 id，不需要回响应
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') log('客户端握手完成');
    return null;
  }

  try {
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'phone-agent', version: '1.0.0' },
            instructions:
              '这是连接主人 Android 手机的桥（运行在 Termux 里）。可以读手机状态、发通知、读写剪贴板和文件、执行 Termux 命令、朗读、震动。危险操作请先向主人确认。',
          },
        };

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
          },
        };

      case 'tools/call': {
        const tool = TOOL_MAP.get(params?.name);
        if (!tool) {
          return { jsonrpc: '2.0', id, result: fail(`没有名为 ${params?.name} 的工具`) };
        }
        log(`调用工具 ${params.name}`);
        try {
          const result = await tool.handler(params?.arguments || {});
          return { jsonrpc: '2.0', id, result };
        } catch (err) {
          log(`工具 ${params.name} 抛错:`, err);
          return { jsonrpc: '2.0', id, result: fail(`工具执行出错：${err.message}`) };
        }
      }

      case 'resources/list':
        return { jsonrpc: '2.0', id, result: { resources: [] } };
      case 'prompts/list':
        return { jsonrpc: '2.0', id, result: { prompts: [] } };

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `不支持的方法: ${method}` },
        };
    }
  } catch (err) {
    log('处理请求失败:', err);
    return { jsonrpc: '2.0', id, error: { code: -32603, message: String(err?.message || err) } };
  }
}

function checkAuth(req) {
  if (!CFG.authRequired) return true;
  const hdr = req.headers['authorization'] || '';
  const want = `Bearer ${CFG.token}`;
  if (hdr.length === want.length && crypto.timingSafeEqual(Buffer.from(hdr), Buffer.from(want))) return true;
  try {
    const url = new URL(req.url, 'http://localhost');
    return url.searchParams.get('token') === CFG.token;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ HTTP
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/' || url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, service: 'phone-agent', mcp: '/mcp', time: new Date().toISOString() }));
    return;
  }

  if (url.pathname !== '/mcp') {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  if (!checkAuth(req)) {
    log(`认证失败，来自 ${req.socket.remoteAddress}`);
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  if (req.method === 'GET' || req.method === 'DELETE') {
    // 本服务是无状态的，不支持服务端推送流
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'POST' });
    res.end(JSON.stringify({ error: 'method not allowed; 本服务无状态，请用 POST' }));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'POST' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  let raw = '';
  try {
    for await (const chunk of req) raw += chunk;
  } catch (err) {
    log('读取请求体失败:', err);
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'bad request body' }));
    return;
  }

  let payload;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } }));
    return;
  }

  try {
    if (Array.isArray(payload)) {
      const results = [];
      for (const m of payload) {
        const r = await handleRpc(m);
        if (r) results.push(r);
      }
      if (results.length === 0) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(results));
      return;
    }

    const result = await handleRpc(payload);
    if (!result) {
      res.writeHead(202).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
  } catch (err) {
    log('请求处理失败:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({ jsonrpc: '2.0', id: payload?.id ?? null, error: { code: -32603, message: String(err?.message || err) } }),
      );
    }
  }
});

server.listen(CFG.port, CFG.host, () => {
  const nets = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) nets.push(ni.address);
    }
  }
  log(`[phone-agent] 已启动，Node ${process.version}`);
  log(`[phone-agent] MCP 端点: http://<手机IP>:${CFG.port}/mcp`);
  for (const ip of nets) log(`  -> http://${ip}:${CFG.port}/mcp`);
  log(`[phone-agent] 认证 token: ${CFG.token}`);
  log(`[phone-agent] 工具数: ${TOOLS.length}`);
});
