#!/usr/bin/env node
/**
 * adb-bridge — 电脑侧 MCP 服务：用无线 ADB 直接控制主人的 Android 手机
 *
 * 传输：MCP Streamable HTTP（stateless，每个请求新建 transport）
 * 认证：Authorization: Bearer <token>
 * 监听：默认 127.0.0.1:8793（只给本机 DSH 用，不对局域网暴露）
 *
 * 启动：node adb-bridge.mjs
 *
 * 前置：手机开发者选项里「无线调试」已打开，且本机 adb 与该手机
 *       完成过一次配对（adb pair）。配对密钥存在 ~/.android/adbkey，
 *       手机重启后【无需重新配对】，只要 adb connect 到新端口即可。
 *
 * 端口会变。端口变了就跑 adb_discover：它让手机自己扫本机 localhost
 * （电脑侧扫描不可靠），再逐个 adb connect 试，成功者写回 adb-config.json。
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
const CONFIG_PATH = path.join(ROOT, 'adb-config.json');
const LOG_FILE = path.join(ROOT, 'adb.log');
const ADB_TMP = path.join(ROOT, '.adb-tmp');

const VERSION = '1.0.0';

// ---------------------------------------------------------------- 日志

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + os.EOL, 'utf8');
  } catch {
    /* 日志写不进去也不能影响服务 */
  }
}

// ---------------------------------------------------------------- 配置

function defaultConfig() {
  return {
    host: '127.0.0.1',
    port: 8793,
    token: 'ab_' + crypto.randomBytes(16).toString('hex'),
    adbPath: 'adb',
    target: '',
    phoneAgent: { url: '', token: '' },
    shotsDir: path.join(ROOT, 'adb-shots'),
    knownNonAdbPorts: [],
    commandTimeoutMs: 120000,
    pairedHost: '',
  };
}

function loadConfig() {
  let cfg = defaultConfig();
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      Object.assign(cfg, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
    } else {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
      log('已生成默认 adb-config.json');
    }
  } catch (err) {
    log('读配置失败，用默认值：', String(err && err.message));
  }
  return cfg;
}

const CFG = loadConfig();

function saveConfig(patch) {
  Object.assign(CFG, patch);
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2), 'utf8');
  } catch (err) {
    log('写配置失败：', String(err && err.message));
  }
}

try {
  fs.mkdirSync(CFG.shotsDir, { recursive: true });
} catch { /* ignore */ }
try {
  fs.mkdirSync(ADB_TMP, { recursive: true });
} catch { /* ignore */ }

// ---------------------------------------------------------------- adb 调用

let TARGET = CFG.target || '';

function adbRun(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      CFG.adbPath,
      args,
      {
        timeout: timeoutMs || CFG.commandTimeoutMs || 120000,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        // adb 默认往 %TEMP% 写 adb.log；这台机器的默认 Temp 曾因权限导致
        // daemon 起不来，所以固定给一个自己的目录。ADB_MDNS=0 关掉 mDNS
        // 自动发现（在这个网络下没响应，只会拖慢启动）。
        env: { ...process.env, TEMP: ADB_TMP, TMP: ADB_TMP, ADB_MDNS: '0' },
      },
      (err, stdout, stderr) => {
        let code = 0;
        if (err) code = typeof err.code === 'number' ? err.code : 1;
        resolve({
          ok: !err,
          code,
          stdout: stdout || '',
          stderr: (stderr || '') + (err && !stderr ? String(err.message) : ''),
        });
      },
    );
  });
}

async function listDevices() {
  const r = await adbRun(['devices'], 20000);
  return r.stdout
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const parts = l.split(/\s+/);
      return { serial: parts[0], state: parts[1] || '?' };
    });
}

const deviceOk = (list, serial) => list.some((d) => d.serial === serial && d.state === 'device');

/** 确保有一台可用设备；不在就重连。返回 serial。 */
async function ensureDevice() {
  if (!TARGET) {
    const devs = await listDevices();
    const first = devs.find((d) => d.state === 'device' && d.serial !== 'emulator-5554');
    if (first) {
      TARGET = first.serial;
      log('自动选中设备', TARGET);
      return TARGET;
    }
    throw new Error(
      '没有已连接的设备。手机「无线调试」打开了吗？端口可能变了，跑 adb_discover 自动找。',
    );
  }

  const devs = await listDevices();
  if (deviceOk(devs, TARGET)) return TARGET;

  const c = await adbRun(['connect', TARGET], 25000);
  const joined = (c.stdout + ' ' + c.stderr).trim();
  const devs2 = await listDevices();
  if (deviceOk(devs2, TARGET)) return TARGET;

  throw new Error(
    `连不上 ${TARGET}：${joined || '(无输出)'}\n` +
      `端口可能变了（手机重启 / 重开无线调试都会变）。跑 adb_discover 自动找新端口。`,
  );
}

/** 跑一条手机 shell 命令。用 exec-out，避开 shell 的 PTY 换行转换。 */
async function sh(cmd, timeoutMs) {
  const t = await ensureDevice();
  const r = await adbRun(['-s', t, 'exec-out', cmd], timeoutMs || 60000);
  return { ...r, text: r.stdout.replace(/\r\n/g, '\n') };
}

// ---------------------------------------------------------------- 手机 agent（用于端口自愈）

let rpcId = 1;

async function phoneTool(name, args) {
  if (!CFG.phoneAgent || !CFG.phoneAgent.url) throw new Error('配置里没写 phoneAgent.url');
  const body = {
    jsonrpc: '2.0',
    id: rpcId++,
    method: 'tools/call',
    params: { name, arguments: args || {} },
  };
  const res = await fetch(CFG.phoneAgent.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer ' + CFG.phoneAgent.token,
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  // 服务端可能回 SSE（data: {...}）也可能回裸 JSON
  const jsonText = raw.startsWith('data:')
    ? raw.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
    : raw;
  const parsed = JSON.parse(jsonText);
  if (parsed.error) throw new Error('手机 agent 报错：' + JSON.stringify(parsed.error));
  const content = parsed.result && parsed.result.content;
  if (Array.isArray(content)) return content.map((c) => c.text || '').join('\n');
  return JSON.stringify(parsed.result);
}

// ---------------------------------------------------------------- 工具实现

const M = (s) => ({ content: [{ type: 'text', text: String(s) }] });
const ERR = (s) => ({ content: [{ type: 'text', text: String(s) }], isError: true });

function wrap(fn) {
  return async (args) => {
    try {
      return await fn(args || {});
    } catch (err) {
      log('工具失败：', String(err && err.stack ? err.stack : err));
      return ERR(String(err && err.message ? err.message : err));
    }
  };
}

const KEYCODES = {
  HOME: 3, BACK: 4, CALL: 5, ENDCALL: 6,
  UP: 19, DOWN: 20, LEFT: 21, RIGHT: 22,
  VOLUME_UP: 24, VOLUME_DOWN: 25, POWER: 26, CAMERA: 27, CLEAR: 28,
  A: 29, B: 30, C: 31, D: 32, E: 33, F: 34, G: 35, H: 36, I: 37, J: 38,
  K: 39, L: 40, M: 41, N: 42, O: 43, P: 44, Q: 45, R: 46, S: 47, T: 48,
  U: 49, V: 50, W: 51, X: 52, Y: 53, Z: 54,
  COMMA: 55, PERIOD: 56, ALT_LEFT: 57, ALT_RIGHT: 58, SHIFT_LEFT: 59, SHIFT_RIGHT: 60,
  TAB: 61, SPACE: 62, SYM: 63, EXPLORER: 64, ENVELOPE: 65, ENTER: 66, DEL: 67,
  GRAVE: 68, MINUS: 69, EQUALS: 70, LEFT_BRACKET: 71, RIGHT_BRACKET: 72,
  BACKSLASH: 73, SEMICOLON: 74, APOSTROPHE: 75, SLASH: 76, AT: 77, NUM: 78,
  HEADSETHOOK: 79, FOCUS: 80, PLUS: 81, MENU: 82, NOTIFICATION: 83, SEARCH: 84,
  MEDIA_PLAY_PAUSE: 85, MEDIA_STOP: 86, MEDIA_NEXT: 87, MEDIA_PREVIOUS: 88,
  MEDIA_REWIND: 89, MEDIA_FAST_FORWARD: 90, MUTE: 91, PAGE_UP: 92, PAGE_DOWN: 93,
  ESCAPE: 111, FORWARD_DEL: 112, CTRL_LEFT: 113, CTRL_RIGHT: 114, CAPS_LOCK: 115,
  SCROLL_LOCK: 116, META_LEFT: 117, META_RIGHT: 118, FUNCTION: 119, SYSRQ: 120,
  BREAK: 121, MOVE_HOME: 122, MOVE_END: 123, INSERT: 124,
  APP_SWITCH: 187, ASSIST: 219, VOICE_ASSIST: 231,
  BRIGHTNESS_DOWN: 220, BRIGHTNESS_UP: 221,
};

function resolveKey(key) {
  if (/^\d+$/.test(String(key))) return String(key);
  const k = String(key).toUpperCase().replace(/^KEYCODE_/, '');
  if (KEYCODES[k] !== undefined) return String(KEYCODES[k]);
  return k; // 交给 adb 自己解析
}

/** input text 的转义：空格要写成 %s，shell 特殊字符加反斜杠。 */
function escapeInputText(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/ /g, '%s')
    .replace(/([()<>|;&*~^"'`$!?{}[\]])/g, '\\$1');
}

async function screenshotTo(localPath, opts = {}) {
  const t = await ensureDevice();
  const remote = '/sdcard/.adbshot.png';
  const local = localPath || path.join(CFG.shotsDir, `shot-${Date.now()}.png`);
  await adbRun(['-s', t, 'shell', `screencap -p ${remote}`], 40000);
  const pull = await adbRun(['-s', t, 'pull', remote, local], 60000);
  await adbRun(['-s', t, 'shell', `rm -f ${remote}`], 20000);
  if (!fs.existsSync(local)) {
    throw new Error('截图没拉到：' + (pull.stderr || pull.stdout));
  }
  const size = fs.statSync(local).size;
  if (size < 1000) throw new Error(`截图文件只有 ${size} 字节，像是黑屏/失败`);
  return { local, size, opts };
}

// ---------------------------------------------------------------- uiautomator

// 界面上有持续动画（视频、进度圈、WebView 重绘）时，uiautomator 会一直等不到
// idle state，直接报 "could not get idle state" 而且不落文件。把三档动画时长临时
// 设为 0 是最有效的解法；用完必须还原，所以这里返回一个还原函数。
async function calmAnimations(serial) {
  const keys = ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale'];
  const saved = {};
  for (const k of keys) {
    const r = await adbRun(['-s', serial, 'shell', `settings get global ${k}`], 15000);
    saved[k] = (r.stdout || '').trim() || '1.0';
  }
  for (const k of keys) await adbRun(['-s', serial, 'shell', `settings put global ${k} 0`], 15000);
  return async () => {
    for (const k of keys) {
      await adbRun(['-s', serial, 'shell', `settings put global ${k} ${saved[k]}`], 15000);
    }
  };
}

// dump 不出来时的兜底：至少报出当前焦点窗口与栈顶 Activity，别让调用者瞎猜。
async function currentWindowBrief(serial) {
  const w = await adbRun(
    ['-s', serial, 'shell', 'dumpsys window | grep -E "mCurrentFocus|mFocusedApp"'],
    30000,
  );
  const a = await adbRun(
    ['-s', serial, 'shell', 'dumpsys activity activities | grep -E "topResumedActivity|mResumedActivity"'],
    30000,
  );
  return [w.stdout.trim(), a.stdout.trim()].filter(Boolean).join('\n');
}

function parseUiXml(xml) {
  const nodes = [];
  const re = /<node\b([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = {};
    const ar = /([\w-]+)="([^"]*)"/g;
    let a;
    while ((a = ar.exec(m[1]))) attrs[a[1]] = a[2];
    const bounds = attrs.bounds || '';
    const bm = bounds.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    let center = null;
    if (bm) {
      const [x1, y1, x2, y2] = bm.slice(1).map(Number);
      center = [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)];
    }
    const text = attrs.text || '';
    const desc = attrs['content-desc'] || '';
    const clickable = attrs.clickable === 'true';
    const scrollable = attrs.scrollable === 'true';
    const important = clickable || scrollable || text || desc;
    if (!important) continue;
    nodes.push({
      text,
      desc,
      id: attrs['resource-id'] || '',
      cls: (attrs.class || '').split('.').pop(),
      clickable,
      scrollable,
      enabled: attrs.enabled === 'true',
      checked: attrs.checked === 'true',
      selected: attrs.selected === 'true',
      focused: attrs.focused === 'true',
      bounds,
      center,
    });
  }
  return nodes;
}

// ---------------------------------------------------------------- 构建 MCP server

function buildServer() {
  const server = new McpServer(
    { name: 'adb-bridge', version: VERSION },
    {
      instructions:
        '通过无线 ADB 直接控制主人的 Android 手机（一加 Ace 5 Pro，Android 16，屏幕 1264x2780）。\n' +
        '常用套路：先用 adb_status 看通不通，连不上就 adb_discover；\n' +
        '要看清屏幕先 adb_screenshot（返回本地 png 路径，直接读图）；\n' +
        '要点击先用 adb_ui 拿到元素坐标，再 adb_tap，比盲猜坐标靠谱。\n' +
        'adb_connect 的端口会变（手机重启/重开无线调试都变），不需要重新配对。',
    },
  );

  // ---- adb_status
  server.registerTool(
    'adb_status',
    {
      title: 'ADB 通道状态',
      description:
        '查看当前 ADB 连接状态：本机 adb 版本、已连接设备列表、当前目标、手机型号/系统/屏幕。',
      inputSchema: {},
    },
    wrap(async () => {
      const ver = await adbRun(['version'], 15000);
      let devs = [];
      let devErr = '';
      try {
        devs = await listDevices();
      } catch (e) {
        devErr = String(e && e.message);
      }
      const lines = [];
      lines.push('adb: ' + ver.stdout.trim().split(/\r?\n/)[0]);
      lines.push('目标: ' + (TARGET || '(未设置)'));
      lines.push(
        '设备: ' +
          (devs.length ? devs.map((d) => `${d.serial} [${d.state}]`).join(', ') : '(无)'),
      );
      if (devErr) lines.push('设备枚举错误: ' + devErr);

      let info = '';
      try {
        const t = await ensureDevice();
        const r = await sh(
          'echo "$(getprop ro.product.model)|$(getprop ro.build.version.release)|$(wm size|head -1)"',
          30000,
        );
        info = r.text.trim();
        lines.push('已连通: ' + t);
        lines.push('手机: ' + info);
      } catch (e) {
        lines.push('连通性: ✗ ' + String(e && e.message));
      }
      return M(lines.join('\n'));
    }),
  );

  // ---- adb_shell
  server.registerTool(
    'adb_shell',
    {
      title: '在手机上跑 shell 命令',
      description:
        '在手机的 Android shell（uid=2000 shell）里执行命令并回显输出。适合查文件、看进程、读属性。' +
        '注意 adbd 是 shell 权限，读不到别的应用私有数据，也拿不到 root。',
      inputSchema: {
        command: z.string().describe('要执行的 shell 命令，例如 ls -l /sdcard'),
        timeoutMs: z.number().optional().describe('超时毫秒，默认 60000'),
      },
    },
    wrap(async ({ command, timeoutMs }) => {
      const r = await sh(command, timeoutMs || 60000);
      const out = (r.text || '') + (r.stderr ? '\n[stderr] ' + r.stderr : '');
      return r.ok || r.text ? M(out || '(无输出)') : ERR('命令失败 (exit ' + r.code + ')：\n' + out);
    }),
  );

  // ---- adb_screenshot
  server.registerTool(
    'adb_screenshot',
    {
      title: '手机截图',
      description:
        '截取手机当前屏幕，保存到电脑本地 png，返回绝对路径（用 read_image 就能看）。' +
        '可选 fileName 指定文件名（不带路径）。',
      inputSchema: {
        fileName: z.string().optional().describe('文件名，例如 now.png；默认按时间戳生成'),
      },
    },
    wrap(async ({ fileName }) => {
      const local = fileName
        ? path.join(CFG.shotsDir, fileName.replace(/[\\/]/g, '_'))
        : undefined;
      const r = await screenshotTo(local);
      return M(`截图已保存: ${r.local}\n大小: ${r.size} 字节`);
    }),
  );

  // ---- adb_tap
  server.registerTool(
    'adb_tap',
    {
      title: '点击坐标',
      description: '在手机屏幕上点一下。x/y 是屏幕物理像素坐标（屏幕 1264x2780）。',
      inputSchema: {
        x: z.number().describe('横坐标'),
        y: z.number().describe('纵坐标'),
      },
    },
    wrap(async ({ x, y }) => {
      const r = await sh(`input tap ${Math.round(x)} ${Math.round(y)}`, 30000);
      return r.ok ? M(`已点击 (${Math.round(x)}, ${Math.round(y)})`) : ERR('点击失败: ' + r.stderr);
    }),
  );

  // ---- adb_swipe
  server.registerTool(
    'adb_swipe',
    {
      title: '滑动',
      description: '从 (x1,y1) 滑到 (x2,y2)，durationMs 控制快慢（默认 300；快速滑=翻页/甩动，慢速滑=拖动）。',
      inputSchema: {
        x1: z.number(),
        y1: z.number(),
        x2: z.number(),
        y2: z.number(),
        durationMs: z.number().optional().describe('滑动时长毫秒，默认 300'),
      },
    },
    wrap(async ({ x1, y1, x2, y2, durationMs }) => {
      const d = durationMs || 300;
      const r = await sh(
        `input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${Math.round(d)}`,
        40000,
      );
      return r.ok ? M(`已滑动 (${x1},${y1}) → (${x2},${y2})，${d}ms`) : ERR('滑动失败: ' + r.stderr);
    }),
  );

  // ---- adb_key
  server.registerTool(
    'adb_key',
    {
      title: '按键',
      description:
        '发送按键事件。key 可以是名字（HOME / BACK / ENTER / POWER / APP_SWITCH / VOLUME_UP / ' +
        'MEDIA_PLAY_PAUSE / DELETE …）或直接用 keycode 数字。',
      inputSchema: {
        key: z.string().describe('按键名或 keycode 数字'),
        repeat: z.number().optional().describe('重复次数，默认 1'),
      },
    },
    wrap(async ({ key, repeat }) => {
      const code = resolveKey(key);
      const n = Math.max(1, Math.min(50, Math.floor(repeat || 1)));
      for (let i = 0; i < n; i++) {
        const r = await sh(`input keyevent ${code}`, 30000);
        if (!r.ok) return ERR('按键失败: ' + r.stderr);
      }
      return M(`已发送 keyevent ${code}${n > 1 ? ` ×${n}` : ''}`);
    }),
  );

  // ---- adb_text
  server.registerTool(
    'adb_text',
    {
      title: '输入文字',
      description:
        '往当前聚焦的输入框键入文字（空格自动转义）。中文/emoji 用 input text 打不进去，' +
        '中文请改用 adb_clipboard + 长按粘贴，或用手机侧的输入法。',
      inputSchema: {
        text: z.string().describe('要输入的文字（建议 ASCII）'),
      },
    },
    wrap(async ({ text }) => {
      const r = await sh(`input text '${escapeInputText(text)}'`, 40000);
      return r.ok ? M(`已输入 ${text.length} 个字符`) : ERR('输入失败: ' + r.stderr);
    }),
  );

  // ---- adb_ui
  server.registerTool(
    'adb_ui',
    {
      title: '读取界面元素',
      description:
        'dump 当前界面的控件树，返回可点击/有文字的元素的坐标中心点。盲点坐标前先看这个。' +
        '参数 filter 可按文字或 id 关键字过滤。' +
        '界面有持续动画时会 dump 不出来（uiautomator 等不到 idle），此时传 calm:true。',
      inputSchema: {
        filter: z.string().optional().describe('只看文字/描述/id 含该关键字的元素'),
        includeAll: z.boolean().optional().describe('true = 连不可点击的纯文本也返回'),
        raw: z.boolean().optional().describe('true = 额外返回原始 XML 文件路径'),
        calm: z.boolean().optional().describe(
          'true = dump 之前临时把系统动画时长设为 0（视频/动画界面上 dump 不出来时用），结束后自动还原',
        ),
      },
    },
    wrap(async ({ filter, includeAll, raw, calm }) => {
      const t = await ensureDevice();
      fs.mkdirSync(CFG.shotsDir, { recursive: true });
      const remote = '/sdcard/.uidump.xml';
      const local = path.join(CFG.shotsDir, `ui-${Date.now()}.xml`);

      // uiautomator 要等界面进入 idle 才肯 dump，碰上持续动画/视频就直接失败。
      // 对策三件套：多轮重试 × 不看判词、文件照拉 × 全失败就报兜底信息。
      const tried = [];
      let xml = '';
      let restore = null;
      try {
        if (calm) restore = await calmAnimations(t);
        for (let i = 0; i < 3 && !xml; i++) {
          await adbRun(['-s', t, 'shell', 'rm -f ' + remote], 15000);
          const cmd = `uiautomator dump ${i === 0 ? '' : '--compressed '}${remote}`.replace(/\s+/g, ' ').trim();
          const d = await adbRun(['-s', t, 'shell', cmd], 60000);
          const verdict =
            (d.stdout + d.stderr).trim().split('\n').filter(Boolean).pop() || `(退出码 ${d.code})`;
          // 有的 ROM 明明报错却还是把文件写了，所以别信判词，直接试着拉回来
          const pull = await adbRun(['-s', t, 'pull', remote, local], 40000);
          if (fs.existsSync(local)) {
            const c = fs.readFileSync(local, 'utf8');
            if (/<hierarchy/i.test(c)) xml = c;
            else tried.push(`${verdict} ｜ 拉回来的文件里没有 <hierarchy>`);
            try { fs.unlinkSync(local); } catch { /* ignore */ }
          } else {
            tried.push(`${verdict}${pull.stderr ? ' ｜ ' + pull.stderr.trim().split('\n')[0] : ''}`);
          }
          if (!xml && i < 2) await new Promise((r) => setTimeout(r, 1200));
        }
      } finally {
        if (restore) { try { await restore(); } catch { /* ignore */ } }
        await adbRun(['-s', t, 'shell', 'rm -f ' + remote], 15000);
      }

      if (!xml) {
        const brief = await currentWindowBrief(t);
        return ERR(
          'uiautomator 三轮都没能 dump 出界面 —— 界面上有持续动画（视频、进度圈、WebView 重绘）时，\n' +
          '它等不到 idle state 就会这样，不是权限问题。\n\n' +
          '三轮判词：\n  · ' + tried.join('\n  · ') + '\n\n' +
          '当前界面（兜底，无坐标）：\n' + (brief || '(也没读出来)') + '\n\n' +
          '可以试：① 先把界面退回静态（比如按 HOME）再调；' +
          '② 传 calm:true 让它临时关掉系统动画再 dump（会自动还原）；' +
          '③ 用 adb_screenshot 看图，或 adb_shell 直接跑 dumpsys。',
        );
      }

      let nodes = parseUiXml(xml);
      if (!includeAll) nodes = nodes.filter((n) => n.clickable || n.scrollable);
      if (filter) {
        const f = filter.toLowerCase();
        nodes = nodes.filter(
          (n) =>
            n.text.toLowerCase().includes(f) ||
            n.desc.toLowerCase().includes(f) ||
            n.id.toLowerCase().includes(f),
        );
      }
      const shown = nodes.slice(0, 120);
      const lines = shown.map((n) => {
        const label = n.text || n.desc || n.id || n.cls;
        const tags = [n.clickable ? 'click' : '', n.scrollable ? 'scroll' : ''].filter(Boolean).join('+');
        return `(${n.center ? n.center.join(',') : '?'}) ${tags || '-'} "${label}"${n.id ? ' #' + n.id.split('/').pop() : ''}`;
      });
      let out = `元素 ${nodes.length} 个${shown.length < nodes.length ? `（只列前 ${shown.length}）` : ''}：\n` + lines.join('\n');
      if (raw) {
        fs.writeFileSync(local, xml, 'utf8');
        out += `\n\nXML: ${local}`;
      }
      return M(out || '(没读到元素)');
    }),
  );

  // ---- adb_apps
  server.registerTool(
    'adb_apps',
    {
      title: '应用管理',
      description:
        'action=list 列出已安装包（third=true 只看第三方）；current=看当前前台应用；' +
        'start=启动包名；stop=强杀包名；info=看包的版本与路径。',
      inputSchema: {
        action: z.enum(['list', 'current', 'start', 'stop', 'info']).describe('操作类型'),
        pkg: z.string().optional().describe('包名，start/stop/info 需要'),
        third: z.boolean().optional().describe('list 时只看第三方应用'),
        filter: z.string().optional().describe('list 时按关键字过滤包名'),
      },
    },
    wrap(async ({ action, pkg, third, filter }) => {
      if (action === 'list') {
        const r = await sh(`pm list packages ${third ? '-3' : ''}`, 40000);
        let lines = r.text.split('\n').map((l) => l.replace(/^package:/, '').trim()).filter(Boolean);
        if (filter) lines = lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase()));
        return M(`共 ${lines.length} 个包：\n` + lines.slice(0, 300).join('\n'));
      }
      if (action === 'current') {
        const r = await sh(
          'dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity" | head -3',
          40000,
        );
        const w = await sh('dumpsys window | grep -E "mCurrentFocus" | head -3', 40000);
        return M('activity: ' + r.text.trim() + '\nwindow: ' + w.text.trim());
      }
      if (!pkg) throw new Error('这个 action 需要 pkg 参数');
      if (action === 'start') {
        const r = await sh(
          `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1 2>&1 | tail -3`,
          40000,
        );
        return M(`启动 ${pkg}：\n` + r.text.trim());
      }
      if (action === 'stop') {
        const r = await sh(`am force-stop ${pkg}`, 30000);
        return M(`已强杀 ${pkg}` + (r.stderr ? ' ' + r.stderr : ''));
      }
      const r = await sh(`dumpsys package ${pkg} | grep -E "versionName|codePath" | head -4`, 40000);
      return M(r.text.trim() || '(没查到)');
    }),
  );

  // ---- adb_pull / adb_push
  server.registerTool(
    'adb_pull',
    {
      title: '从手机取文件',
      description: '把手机上的文件/目录拉到电脑。remote 例如 /sdcard/DCIM/a.jpg；local 省略则放到 ./adb-shots。',
      inputSchema: {
        remote: z.string().describe('手机上的路径'),
        local: z.string().optional().describe('电脑上的目标路径'),
      },
    },
    wrap(async ({ remote, local }) => {
      const t = await ensureDevice();
      const dest = local || path.join(CFG.shotsDir, path.basename(remote));
      const r = await adbRun(['-s', t, 'pull', remote, dest], 300000);
      if (/1 file pulled|files pulled/i.test(r.stdout + r.stderr)) {
        return M(`已拉到 ${dest}\n` + r.stdout.trim());
      }
      return ERR('拉取失败：\n' + (r.stdout + '\n' + r.stderr).trim());
    }),
  );

  server.registerTool(
    'adb_push',
    {
      title: '往手机推文件',
      description: '把电脑上的文件推到手机。local 必须是电脑上的绝对路径。',
      inputSchema: {
        local: z.string().describe('电脑上的文件绝对路径'),
        remote: z.string().describe('手机上的目标路径，例如 /sdcard/Download/'),
      },
    },
    wrap(async ({ local, remote }) => {
      const t = await ensureDevice();
      if (!fs.existsSync(local)) throw new Error('电脑上没有这个文件：' + local);
      const r = await adbRun(['-s', t, 'push', local, remote], 300000);
      if (/1 file pushed|files pushed/i.test(r.stdout + r.stderr)) {
        return M(`已推到 ${remote}\n` + r.stdout.trim());
      }
      return ERR('推送失败：\n' + (r.stdout + '\n' + r.stderr).trim());
    }),
  );

  // ---- adb_connect
  server.registerTool(
    'adb_connect',
    {
      title: '连接指定端口',
      description:
        '手动连到 host:port（例如 100.x.y.z:5555）。已经配对过就不用再配对，' +
        '手机重启后换个端口照样连。端口不确定就用 adb_discover。',
      inputSchema: {
        address: z.string().optional().describe('host:port，默认用配置里的 pairedHost + 5555'),
      },
    },
    wrap(async ({ address }) => {
      let addr = address;
      if (!addr) {
        const host = CFG.pairedHost || (CFG.target || '').split(':')[0];
        if (!host) throw new Error('没给地址，配置里也没有 pairedHost');
        addr = host + ':5555';
      }
      const r = await adbRun(['connect', addr], 30000);
      const joined = (r.stdout + ' ' + r.stderr).trim();
      const devs = await listDevices();
      if (deviceOk(devs, addr)) {
        TARGET = addr;
        saveConfig({ target: addr });
        return M(`已连接并写回配置：${addr}\n` + joined);
      }
      return ERR(`连 ${addr} 失败：\n` + joined + '\n\n设备列表：' + JSON.stringify(devs));
    }),
  );

  // ---- adb_discover
  server.registerTool(
    'adb_discover',
    {
      title: '自动找手机 adb 端口',
      description:
        '无线调试端口变了、连不上时用这个自愈：让手机自己扫本机 localhost 找出监听端口，' +
        '排除已知的非 adb 端口后逐个试连，成功的写回配置。需要手机 Termux 里的 phone-agent 在线。',
      inputSchema: {
        from: z.number().optional().describe('扫描起始端口，默认 1024'),
        to: z.number().optional().describe('扫描结束端口，默认 65535'),
      },
    },
    wrap(async ({ from, to }) => {
      const lo = from || 1024;
      const hi = to || 65535;
      const script = '/data/data/com.termux/files/home/scan-local.mjs';
      log('发现流程：让手机自扫', lo, hi);
      const out = await phoneTool('phone_sh', {
        command: `node ${script} ${lo} ${hi}`,
        timeoutMs: 300000,
      });
      const m = String(out).match(/open=\[([^\]]*)\]/);
      if (!m) throw new Error('手机扫描没回预期格式：\n' + String(out).slice(0, 2000));
      const all = m[1].split(',').map((s) => s.trim()).filter(Boolean).map(Number);
      const skip = new Set(CFG.knownNonAdbPorts || []);
      const host = CFG.pairedHost || (CFG.target || '').split(':')[0];
      if (!host) throw new Error('配置里没有 pairedHost，没法拼地址');
      const cands = all.filter((p) => p > 1024 && !skip.has(p));
      log('候选端口:', cands);

      const tried = [];
      for (const p of cands) {
        const addr = `${host}:${p}`;
        const r = await adbRun(['connect', addr], 12000);
        const joined = (r.stdout + ' ' + r.stderr);
        tried.push(`${addr} → ${joined.trim().split('\n')[0]}`);
        if (/connected to/i.test(joined)) {
          const devs = await listDevices();
          if (deviceOk(devs, addr)) {
            TARGET = addr;
            saveConfig({ target: addr });
            // 把这次没用上的新端口记进排除表，下次少扫一点
            const extra = cands.filter((q) => q !== p);
            saveConfig({ knownNonAdbPorts: Array.from(new Set([...(CFG.knownNonAdbPorts || []), ...extra])) });
            return M(`找到并连接成功：${addr}\n已写回 adb-config.json\n\n尝试记录：\n` + tried.join('\n'));
          }
        }
      }
      return ERR(
        `扫到这些监听端口：${all.join(', ')}\n` +
          `排除已知非 adb 后试了 ${cands.length} 个，都没连上。\n\n` +
          tried.join('\n') +
          '\n\n可能是手机「无线调试」被关了，或者 adbd 没监听在外面。',
      );
    }),
  );

  // ---- adb_clipboard
  server.registerTool(
    'adb_clipboard',
    {
      title: '手机剪贴板',
      description:
        '读/写手机剪贴板。写完之后一般要长按输入框再点「粘贴」，因为 ADB 没法直接把中文塞进输入框。',
      inputSchema: {
        action: z.enum(['get', 'set']).describe('get 读取，set 写入'),
        text: z.string().optional().describe('set 时要写的内容'),
      },
    },
    wrap(async ({ action, text }) => {
      if (!CFG.phoneAgent || !CFG.phoneAgent.url) {
        if (action === 'get') {
          const r = await sh('cmd clipboard get 2>/dev/null || echo "(Android 不支持 shell 读剪贴板)"', 30000);
          return M(r.text.trim());
        }
        throw new Error('写剪贴板需要 phone-agent 在线');
      }
      if (action === 'get') {
        return M(await phoneTool('phone_clipboard_get', {}));
      }
      return M(await phoneTool('phone_clipboard_set', { text: text || '' }));
    }),
  );

  return server;
}

// ---------------------------------------------------------------- HTTP 层

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const peer = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: 'adb-bridge', target: TARGET, devices: undefined }));
    return;
  }

  // 只允许本机
  if (!['127.0.0.1', '::1', 'localhost'].includes(peer)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('forbidden');
    return;
  }

  const auth = req.headers.authorization || '';
  if (auth !== 'Bearer ' + CFG.token) {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('unauthorized');
    return;
  }

  if (url.pathname !== '/mcp') {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }

  // GET：SSE 长连接（DSH 客户端会先 GET 探活，必须留着并定期心跳）
  if (req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const hb = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { clearInterval(hb); }
    }, 20000);
    req.on('close', () => clearInterval(hb));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'text/plain' });
    res.end('method not allowed');
    return;
  }

  // POST：收集 body
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'parse error' }, id: null }));
      return;
    }
    try {
      const mcp = buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => { transport.close().catch(() => {}); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log('处理请求失败：', String(err && err.stack ? err.stack : err));
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: String(err && err.message) }, id: null }));
      }
    }
  });
});

server.requestTimeout = 0;
server.headersTimeout = 60000;
server.keepAliveTimeout = 120000;

server.listen(CFG.port, CFG.host, () => {
  log(`adb-bridge v${VERSION} 已监听 http://${CFG.host}:${CFG.port}/mcp`);
  log('目标设备:', TARGET || '(未设置)');
  log('adb:', CFG.adbPath);
  // 启动时顺手探一次，方便看日志判断通不通（失败不影响服务起来）
  ensureDevice()
    .then((t) => log('启动自检：已连通', t))
    .catch((e) => log('启动自检失败：', String(e && e.message)));
});

process.on('SIGINT', () => { log('收到 SIGINT，退出'); process.exit(0); });
process.on('SIGTERM', () => { log('收到 SIGTERM，退出'); process.exit(0); });
