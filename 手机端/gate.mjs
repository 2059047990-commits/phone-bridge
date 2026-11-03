#!/usr/bin/env node
// 手机 → 电脑：权限闸门遥控器
//   node ~/gate.mjs status          看闸门现在什么状态
//   node ~/gate.mjs open [分钟]     按指纹 → 开闸（默认 30 分钟）
//   node ~/gate.mjs close           立刻收回
// 设计：开闸要先领一次性挑战码，指纹过了才用共享密钥签名换开闸；关闸不要凭据。
// 配置：同目录 config.json（照 config.example.json 填）
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';

const CFG = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const PC = String(CFG.pcBase || '').replace(/\/+$/, '') + '/mcp';
const TOKEN = CFG.pcToken;
const SECRET = CFG.unlockSecret;
if (!CFG.pcBase || !TOKEN || !SECRET) {
  console.error('缺少配置：请在 config.json 里填 pcBase / pcToken / unlockSecret（参考 config.example.json）');
  process.exit(1);
}

async function call(name, args) {
  const r = await fetch(PC, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${raw.slice(0, 300)}`);
  const lines = raw.split(/\r?\n/).filter((l) => l.startsWith('data:'));
  const jsonText = lines.length ? lines[lines.length - 1].slice(5).trim() : raw;
  const payload = JSON.parse(jsonText);
  if (payload.error) throw new Error(payload.error.message || 'MCP 报错');
  return (payload.result?.content || []).map((x) => x.text || '').join('\n');
}

// termux-fingerprint 实际返回：
//   {"errors":[],"failed_attempts":0,"auth_result":"AUTH_RESULT_SUCCESS"}
// auth_result 是字符串，不是对象——别照文档猜。
function fingerprint() {
  console.log('请按指纹……');
  let out;
  try {
    out = execFileSync('termux-fingerprint', [], { encoding: 'utf8' });
  } catch (e) {
    return { ok: false, why: '指纹没按成（取消或超时）：' + String(e.stdout || e.message || '').slice(0, 200) };
  }
  let j;
  try {
    j = JSON.parse(out);
  } catch {
    return { ok: false, why: '指纹工具返回看不懂：' + String(out).slice(0, 200) };
  }
  if (j.auth_result === 'AUTH_RESULT_SUCCESS') return { ok: true };
  const extra = Array.isArray(j.errors) && j.errors.length ? `，${j.errors.join(';')}` : '';
  return { ok: false, why: `指纹没过（${j.auth_result || '未知'}，失败次数 ${j.failed_attempts ?? '?'}${extra}）` };
}

const cmd = process.argv[2] || 'status';

if (cmd === 'status') {
  console.log(await call('pc_gate', {}));
} else if (cmd === 'close') {
  console.log(await call('pc_lock', {}));
} else if (cmd === 'open') {
  const minutes = Number(process.argv[3]) || 30;
  console.log('== 给电脑开权限闸门 ==');
  const nonceMsg = await call('pc_unlock', { action: 'nonce' });
  const m = /([0-9a-f]{32})/.exec(nonceMsg);
  if (!m) throw new Error('没领到挑战码：\n' + nonceMsg);
  const nonce = m[1];
  console.log('挑战码已领到。');

  const fp = fingerprint();
  if (!fp.ok) {
    console.log('✗ ' + fp.why);
    console.log('闸门没开，电脑那边权限维持原样。');
    process.exit(1);
  }
  console.log('✓ 指纹过了');

  const sig = crypto.createHmac('sha256', SECRET).update(nonce).digest('hex');
  console.log(await call('pc_unlock', { action: 'verify', nonce, sig, minutes, by: '手机指纹' }));
} else {
  console.log('用法：node ~/gate.mjs status | open [分钟] | close');
  process.exit(2);
}
