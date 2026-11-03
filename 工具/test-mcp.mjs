// phone-bridge MCP 端点自测
// 用法: node test-mcp.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const BASE = `http://127.0.0.1:${cfg.port}/mcp`;
const TOKEN = cfg.token;

async function rpc(method, params, id = 1) {
  const r = await fetch(BASE, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const raw = await r.text();
  let parsed = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {}
  return { status: r.status, parsed };
}

const init = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'self-test', version: '1.0' },
});
console.log('== initialize ==', init.status, JSON.stringify(init.parsed).slice(0, 300));

const list = await rpc('tools/list', {}, 2);
const tools = list.parsed?.result?.tools || [];
console.log('== tools/list ==', list.status, `${tools.length} 个工具`);
for (const t of tools) console.log('  -', t.name, '|', (t.description || '').slice(0, 40));

const info = await rpc('tools/call', { name: 'pc_info', arguments: {} }, 3);
console.log('== pc_info ==', JSON.stringify(info.parsed?.result?.content?.[0]?.text || info.parsed).slice(0, 500));

const shell = await rpc('tools/call', { name: 'pc_shell', arguments: { command: 'echo bridge-ok; $PSVersionTable.PSVersion.ToString()' } }, 4);
console.log('== pc_shell ==', JSON.stringify(shell.parsed?.result?.content?.[0]?.text || shell.parsed).slice(0, 500));

const say = await rpc('tools/call', { name: 'say_to_dsh', arguments: { message: '来自手机桥的自测消息：鲸鱼娘你在吗？' } }, 5);
console.log('== say_to_dsh ==', JSON.stringify(say.parsed?.result?.content?.[0]?.text || say.parsed).slice(0, 300));
