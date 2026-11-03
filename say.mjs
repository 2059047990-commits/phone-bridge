#!/usr/bin/env node
/**
 * say.mjs — 以 DSH（鲸鱼娘）的身份往桥接信箱投一条消息给手机
 *
 * 用法: node say.mjs "消息内容，换行用 \n 表示"
 * 手机侧用 read_dsh_messages 工具读取。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MSG_FILE = path.join(ROOT, 'bridge', 'messages.jsonl');

const argv = process.argv.slice(2);
if (!argv.length) {
  console.error('用法: node say.mjs "消息内容"');
  console.error('      node say.mjs --file <路径>   ← 长文本/含引号时用这个');
  process.exit(1);
}

// --file 模式：直接读文件，绕开 PowerShell 传参时剥双引号的问题
const text = argv[0] === '--file'
  ? fs.readFileSync(argv[1], 'utf8').replace(/\r\n/g, '\n').trimEnd()
  : argv.join(' ').replace(/\\n/g, '\n');
const rec = { ts: Date.now(), iso: new Date().toISOString(), from: 'dsh', to: 'phone', text };

fs.mkdirSync(path.dirname(MSG_FILE), { recursive: true });
fs.appendFileSync(MSG_FILE, JSON.stringify(rec) + '\n', 'utf8');

console.log(`已投递给手机：${rec.iso}`);
console.log('---');
console.log(text);
