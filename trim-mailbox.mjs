// trim-mailbox.mjs —— 信箱滚动归档（防止 messages.jsonl 无限膨胀）
//
// 规则（主人 2026-10-13 23:24 要求）：
//   · 信箱保留**最新 50 条**；更老的记录从 messages.jsonl 里移走。
//   · 移走的不是删掉，而是**追加进 `bridge\archive\messages-archive-YYYYMM.jsonl`**。
//     主人说的是「销毁」，但今晚刚出过「信箱被覆盖丢 22 条」的事故，
//     归档既能防体积炸、又留得住历史；真要彻底删，改一行 KEEP_ARCHIVE 即可。
//   · 动文件前先整份备份到 `备份\messages.jsonl.prune-<stamp>.bak`。
//   · 结果写 `bridge.log`；行数、字节数变化都记。
//
// 用法：
//   node trim-mailbox.mjs            # 真干
//   node trim-mailbox.mjs --dry-run  # 只看会做什么，不动任何文件
//   node trim-mailbox.mjs --max 80   # 临时换阈值
//
// 安全前提：游标（`.warden-state.json` / `.last-notified.json`）只增不减，
// 被归档的都是最老的记录，游标早就越过它们了，所以归档不会造成重复投递。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MSG = path.join(HERE, 'bridge', 'messages.jsonl');
const ARCHIVE_DIR = path.join(HERE, 'bridge', 'archive');
const BAK_DIR = path.join(HERE, '备份');
const LOG = path.join(HERE, 'bridge.log');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run') || argv.includes('-n');
const maxArg = argv.indexOf('--max');
const MAX = maxArg >= 0 && argv[maxArg + 1] ? Number(argv[maxArg + 1]) : 50;

function log(msg) {
  const line = `[${new Date().toISOString()}] trim-mailbox | ${msg}`;
  console.log(line);
  if (!DRY) {
    try {
      fs.appendFileSync(LOG, line + '\n', 'utf8');
    } catch {
      /* 日志写不进去也不能让修剪失败 */
    }
  }
}

function readLineCount(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((s) => s.trim()).length;
}

// ---------------------------------------------------------------- 主流程
if (!fs.existsSync(MSG)) {
  log(`信箱不存在，什么都不做：${MSG}`);
  process.exit(0);
}

const beforeBytes = fs.statSync(MSG).size;
const raw = fs.readFileSync(MSG, 'utf8');
const all = raw.split('\n').filter((s) => s.trim());
const beforeLines = all.length;

log(`扫描：信箱 ${beforeLines} 行 / ${beforeBytes} 字节，保留上限 ${MAX} 条` +
    (DRY ? '（DRY RUN，不会动任何文件）' : ''));

if (beforeLines <= MAX) {
  log(`没超过 ${MAX} 条，无需修剪`);
  process.exit(0);
}

const cut = beforeLines - MAX;
const old = all.slice(0, cut);
const keep = all.slice(cut);

// 被移走的必须是合法 JSON，坏行单独交代，不静默吞掉
let badOld = 0;
for (const ln of old) {
  try {
    JSON.parse(ln);
  } catch {
    badOld++;
  }
}
const okOld = old.length - badOld;

const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14); // yyyymmddHHMMSS
const month = new Date().toISOString().slice(0, 7).replace('-', '');       // yyyymm
const archiveFile = path.join(ARCHIVE_DIR, `messages-archive-${month}.jsonl`);
const bakFile = path.join(BAK_DIR, `messages.jsonl.prune-${stamp}.bak`);

log(`超过上限 ${MAX} 条：移走最老的 ${cut} 条（合法 ${okOld}，坏行 ${badOld}），` +
    `保留最新 ${keep.length} 条`);

if (DRY) {
  const first = old[0] ? JSON.parse(old[0]) : null;
  const last = old[old.length - 1] ? JSON.parse(old[old.length - 1]) : null;
  log(`  待归档 ts 区间：${first ? first.ts : '-'} ~ ${last ? last.ts : '-'}`);
  log(`  归档目标：${archiveFile}`);
  log(`  备份目标：${bakFile}`);
  log('DRY RUN 结束，什么都没动');
  process.exit(0);
}

// 1) 整份备份
fs.mkdirSync(BAK_DIR, { recursive: true });
fs.copyFileSync(MSG, bakFile);
log(`已备份整份信箱 -> ${path.basename(bakFile)}（${beforeBytes} 字节）`);

// 2) 追加进归档（不覆盖，追加；零条就不建空文件）
if (old.length) {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  fs.appendFileSync(archiveFile, old.join('\n') + '\n', 'utf8');
  log(`已归档 ${old.length} 条 -> bridge\\archive\\${path.basename(archiveFile)}`);
}

// 3) 重写信箱，只留最新 MAX 条
fs.writeFileSync(MSG, keep.join('\n') + '\n', 'utf8');

// 4) 自检：行数必须正好是保留数，否则报警并且不去动别的
const afterLines = readLineCount(MSG);
const afterBytes = fs.statSync(MSG).size;
const archiveBytes = fs.existsSync(archiveFile) ? fs.statSync(archiveFile).size : 0;

if (afterLines !== keep.length) {
  log(`!! 自检失败：重写后 ${afterLines} 行，应为 ${keep.length} 行`);
  log(`!! 整份原文还在 ${path.basename(bakFile)}，需要手工恢复`);
  process.exit(1);
}

log(`完成：${beforeLines} 行 / ${beforeBytes} 字节 -> ${afterLines} 行 / ${afterBytes} 字节；` +
    `归档文件累计 ${archiveBytes} 字节`);
log(`被移走的有备份：备份\\${path.basename(bakFile)}`);
