#!/usr/bin/env node
/**
 * watch-mailbox.mjs — 盯着桥接信箱，手机妹妹一留言就在电脑上弹 Windows 通知
 *
 * 由计划任务 phone-mailbox-watch 每 2 分钟调一次。
 * 已通知到的最大 ts 存在 bridge/.last-notified.json，避免重复弹。
 *
 * 用法: node watch-mailbox.mjs [--reset]   (--reset 重置游标，只记不弹)
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MSG_FILE = path.join(ROOT, 'bridge', 'messages.jsonl');
const STATE_FILE = path.join(ROOT, 'bridge', '.last-notified.json');
const LOG_FILE = path.join(ROOT, 'mailbox-watch.log');

const args = process.argv.slice(2);

// 完整信箱阅读页（server.mjs 的 /mail 路由）。点击通知就打开它看全文。
let MAIL_URL = '';
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const port = cfg.port || 8790;
  MAIL_URL = `http://127.0.0.1:${port}/mail?token=${encodeURIComponent(cfg.token || '')}`;
} catch {
  MAIL_URL = '';
}

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch {}
}

// ---- 读游标 ----
let lastTs = 0;
try {
  lastTs = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).lastTs || 0;
} catch {}
const isReset = args.includes('--reset');

// ---- 扫信箱 ----
if (!fs.existsSync(MSG_FILE)) {
  log('信箱不存在，退出');
  process.exit(0);
}

const fresh = [];
for (const line of fs.readFileSync(MSG_FILE, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let m;
  try { m = JSON.parse(line); } catch { continue; }
  if (m && m.from === 'phone' && typeof m.ts === 'number' && m.ts > lastTs) fresh.push(m);
}

if (!fresh.length) {
  log('无新留言');
  process.exit(0);
}

const maxTs = Math.max(...fresh.map((m) => m.ts));

if (isReset) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastTs: maxTs }), 'utf8');
  log(`--reset：游标推到 ${maxTs}，补记 ${fresh.length} 条不弹窗`);
  process.exit(0);
}

// ---- 组装通知文本 ----
const pad = (n) => String(n).padStart(2, '0');
function fmtTs(ts) {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const lines = fresh.map((m) => {
  const t = String(m.text || '').replace(/\s+/g, ' ').trim();
  return `${fmtTs(m.ts)} ${t.length > 110 ? t.slice(0, 110) + '…' : t}`;
});

const title = fresh.length === 1 ? '手机妹妹留言' : `手机妹妹留言 ${fresh.length} 条`;
const body = lines.join(' / ');

const xmlEscape = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

// ---- 弹 Toast（失败回退 MessageBox）----
const hint = MAIL_URL ? '点「打开完整信箱」看全文' : '';
const actions = MAIL_URL
  ? `<actions><action content="打开完整信箱" arguments="${xmlEscape(MAIL_URL)}" activationType="protocol"/></actions>`
  : '';
const toastXml =
  `<toast duration="long"${MAIL_URL ? ` launch="${xmlEscape(MAIL_URL)}"` : ''}>` +
  `<visual><binding template="ToastGeneric">` +
  `<text>${xmlEscape(title)}</text>` +
  `<text>${xmlEscape(body)}</text>` +
  (hint ? `<text placement="attribution">${xmlEscape(hint)}</text>` : '') +
  `</binding></visual>` +
  actions +
  `<audio src="ms-winsoundevent:Notification.IM"/>` +
  `</toast>`;

const psScript = `
$ErrorActionPreference = 'Stop'
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] | Out-Null
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml(@'
${toastXml}
'@)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
  $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
  Write-Output 'TOAST-OK'
} catch {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(@'
${body}
'@, '${title}', 'OK', 'Information') | Out-Null
  Write-Output ('MSGBOX-OK: ' + $_.Exception.Message)
}
`;

let notified = false;
try {
  const out = execFileSync(
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
    { encoding: 'utf8', timeout: 30000 }
  );
  notified = /TOAST-OK|MSGBOX-OK/.test(out);
  log(`通知结果: ${out.trim()}`);
} catch (e) {
  log(`通知失败: ${e.message}`);
}

// 只有通知真的发出去了才推进游标 —— 否则这批留言会永远不再提醒。
// （2026-10-13 教训：原版「通知失败也推游标」，8 封信静默丢掉）
if (notified) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastTs: maxTs }), 'utf8');
  log(`新留言 ${fresh.length} 条，游标推到 ${maxTs}，通知成功`);
} else {
  log(`新留言 ${fresh.length} 条，通知失败，游标停在 ${lastTs}，下次重试`);
}
