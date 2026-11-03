#!/usr/bin/env node
// 公开前的最后一道闸：扫全仓库文本文件，命中任何一条敏感特征就非零退出。
// 用法：node verify-no-secrets.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'

const ROOT = process.cwd()
const SKIP_DIRS = new Set(['node_modules', '.git', 'bridge', '备份', 'adb-shots', '.adb-tmp', '_tmp', '_verify'])
const SKIP_FILES = new Set(['verify-no-secrets.mjs']) // 本脚本自带规则字面量，不扫自己

// 每条 = [说明, 正则]
const RULES = [
  ['真实 Tailscale IP', /\b100\.(?:69|104)\.\d{1,3}\.\d{1,3}\b/],
  ['真实公网 IP', /\b153\.101\.\d{1,3}\.\d{1,3}\b/],
  ['真实局域网 IP', /\b192\.168\.5\.\d{1,3}\b/],
  ['Windows 用户名', /\b20590\b/],
  ['令牌前缀 ab_/pa_/ts_', /\b(?:ab|pa|ts)_[0-9a-f]{16,}/i],
  ['裸 64 位十六进制串（疑似 token/secret）', /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/i],
  ['裸 32 位十六进制串（疑似 token/md5）', /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/i],
  ['信箱时间戳留痕 ts=1xxxxxx', /\bts=\d{10,}\b/],
  ['F: 盘个人路径', /F:\\/],
  ['C:\\Users 个人路径', /C:\\Users\\/i],
  ['明文凭据赋值', /(?:token|secret|passwd|password|apikey|api_key)\s*[:=]\s*["'][A-Za-z0-9_\-./+]{20,}["']/i]
]

// 允许的例外：这些串本身是文档里的占位符或公开范例
const ALLOW = [
  'REPLACE_WITH_',
  '100.x.y.z',
  '100.64.0.0/10'
]

const TEXT_EXT = new Set([
  '.mjs', '.js', '.cjs', '.json', '.md', '.ps1', '.vbs', '.txt', '.yml', '.yaml',
  '.py', '.sh', '.bash', '.gitignore', '', '.example'
])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue
      walk(p, out)
    } else {
      if (SKIP_FILES.has(name)) continue
      out.push({ path: p, size: st.size })
    }
  }
  return out
}

function extOf(p) {
  const i = p.lastIndexOf('.')
  return i < 0 ? '' : p.slice(i).toLowerCase()
}

const files = walk(ROOT)
const hits = []
let scanned = 0

for (const f of files) {
  const ext = extOf(f.path)
  if (!TEXT_EXT.has(ext) && !f.path.endsWith('.gitignore')) continue
  if (f.size > 2 * 1024 * 1024) continue

  let text
  try {
    text = readFileSync(f.path, 'utf8')
  } catch {
    continue
  }
  scanned++

  const lines = text.split(/\r?\n/)
  for (const [i, line] of lines.entries()) {
    let probe = line
    for (const ok of ALLOW) probe = probe.split(ok).join('')
    for (const [label, re] of RULES) {
      if (re.test(probe)) {
        hits.push({ file: relative(ROOT, f.path), line: i + 1, label, text: line.trim().slice(0, 160) })
      }
    }
  }
}

if (hits.length === 0) {
  console.log(`OK  扫描 ${scanned} 个文本文件，未命中任何敏感特征。`)
  process.exit(0)
}

console.error(`FAIL  扫描 ${scanned} 个文件，命中 ${hits.length} 处：\n`)
for (const h of hits) {
  console.error(`  ${h.file}:${h.line}  [${h.label}]`)
  console.error(`      ${h.text}`)
}
console.error('\n处理完这些再提交。若确认是文档里的占位符，往脚本的 ALLOW 列表里加。')
process.exit(1)
