#!/usr/bin/env node
/**
 * phone-call.mjs — 从电脑直连手机 phone-agent 的 MCP 工具（HTTP，绕开 DSH 的 MCP client）
 *
 * 用法:
 *   node phone-call.mjs tools                     # 列出工具
 *   node phone-call.mjs <tool> ['<jsonArgs>']     # 调用工具
 *   node phone-call.mjs raw <method> ['<json>']   # 任意 JSON-RPC
 *
 * 例:
 *   node phone-call.mjs phone_sh "{\"command\":\"uname -a\"}"
 *   node phone-call.mjs phone_info
 *
 * 环境变量:
 *   PHONE_HOST / PHONE_PORT / PHONE_TOKEN  覆盖默认值
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// 手机端的源与 token 收在本项目内的「手机端\」子目录，按 README 下发到 Termux。
const TOKEN_FILE = path.join(ROOT, '手机端', '.phone-token.txt');

// 默认走 Tailscale（异地也能连）；换局域网地址时用 PHONE_HOST 覆盖。
const HOST = process.env.PHONE_HOST || '127.0.0.1';
const PORT = Number(process.env.PHONE_PORT || 8791);

let TOKEN = process.env.PHONE_TOKEN || '';
if (!TOKEN) {
  try { TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {
    console.error(`读不到 token，先设 PHONE_TOKEN 或写 ${TOKEN_FILE}`);
    process.exit(1);
  }
}

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params });
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 400)}`));
          try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error(`非 JSON 响应: ${buf.slice(0, 400)}`)); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(new Error('请求超时 120s')); });
    req.end(body);
  });
}

const args = process.argv.slice(2);
// PowerShell 5.1 把含双引号的参数传给原生 exe 时会剥掉引号，
// 所以支持用环境变量 PHONE_CALL_ARGS 传 JSON 参数（v2）。
if (process.env.PHONE_CALL_ARGS) args[1] = process.env.PHONE_CALL_ARGS;
const cmd = args[0];

try {
  if (!cmd || cmd === 'tools') {
    const r = await rpc('tools/list', {});
    const tools = r.result?.tools || [];
    console.log(`工具数: ${tools.length}`);
    for (const t of tools) {
      const req = t.inputSchema?.required || [];
      console.log(` - ${t.name}${req.length ? '  必填: ' + req.join(', ') : ''}`);
    }
  } else if (cmd === 'raw') {
    const method = args[1];
    const params = args[2] ? JSON.parse(args[2]) : {};
    console.log(JSON.stringify(await rpc(method, params), null, 2));
  } else {
    const params = args[1] ? JSON.parse(args[1]) : {};
    const r = await rpc('tools/call', { name: cmd, arguments: params });
    if (r.error) {
      console.log('RPC 错误:', JSON.stringify(r.error));
      process.exitCode = 1;
    } else {
      const parts = r.result?.content || [];
      for (const p of parts) {
        if (p.type === 'text') console.log(p.text);
        else console.log(JSON.stringify(p));
      }
      if (r.result?.isError) process.exitCode = 1;
    }
  }
} catch (e) {
  console.error('ERR:', e.message);
  process.exit(1);
}
