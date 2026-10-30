#!/usr/bin/env node
/**
 * 从 bridge.js 里整块切掉一个类方法（按名字）。
 *
 * 为什么需要工具：bridge.js 一万行，手改行号必然错位；而方法边界靠"缩进回到 2 空格 +
 * 独占一行的 `}`" 就能稳定判定（这个文件里所有类方法都是这个形状）。
 *
 * ⚠️ bridge.js 是 **CRLF**（10233 行全是 \r\n）。按 '\n' 切出来的每行尾部都带 \r，
 *    于是 `lines[i] === '  }'` 永远为假 —— 第一版就是这么"找不到方法"的。
 *    这里按 /\r?\n/ 切、写回时再还原成原来的换行符。
 *
 * 用法：
 *   node tools/cut-method.mjs list                    列出所有方法名与行号区间
 *   node tools/cut-method.mjs find   "#handleDice"    只看某个方法前几行
 *   node tools/cut-method.mjs cut    "#handleDice"    切掉（默认 dry-run，加 --apply 才写盘）
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'

const FILE = 'lib/bridge.js'
const raw = readFileSync(FILE, 'utf8')
const crlf = raw.includes('\r\n')
const lines = raw.split(/\r?\n/)

/** 找 `  #name(` / `  async #name(` 开头的方法，返回 [start, end]（0 基，含端点行） */
function locate(name) {
  const head = new RegExp(`^  (async )?${name.replace(/[#*]/g, '\\$&')}\\s*\\(`)
  // 只认方法定义：行尾必须是 `{` 或 `) {`，避免误命中调用点 `this.#handleXxx(...)`
  const start = lines.findIndex((line) => head.test(line) && /\{\s*$/.test(line))
  if (start < 0) return null
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i] === '  }') return [start, i]
  }
  return null
}

const [, , action = 'list', rawName = ''] = process.argv
const apply = process.argv.includes('--apply')

if (action === 'list') {
  const seen = new Set()
  lines.forEach((line, index) => {
    const match = line.match(/^  (?:async )?(#[A-Za-z0-9_]+|[A-Za-z_][A-Za-z0-9_]*)\s*\(.*\{\s*$/)
    if (!match || seen.has(match[1])) return
    const range = locate(match[1])
    if (!range) return
    seen.add(match[1])
    console.log(`${String(range[0] + 1).padStart(6)}-${String(range[1] + 1).padStart(6)}  ${String(range[1] - range[0] + 1).padStart(5)} 行  ${match[1]}`)
  })
  process.exit(0)
}

if (rawName === '') {
  console.error('要指定方法名，例如 cut "#handleDice"')
  process.exit(2)
}
const range = locate(rawName)
if (!range) {
  console.error(`没找到方法 ${rawName}`)
  process.exit(1)
}
const [start, end] = range
const removed = end - start + 1
console.log(`${rawName}: 行 ${start + 1}..${end + 1}（共 ${removed} 行）`)
if (action === 'find') {
  console.log(lines.slice(start, Math.min(end + 1, start + 8)).join('\n'))
  process.exit(0)
}
if (!apply) {
  console.log('（dry-run）加 --apply 才会真的删')
  process.exit(0)
}
copyFileSync(FILE, `${FILE}.bak-cut`)
writeFileSync(FILE, [...lines.slice(0, start), ...lines.slice(end + 1)].join(crlf ? '\r\n' : '\n'))
console.log(`已删除 ${removed} 行；备份 ${FILE}.bak-cut`)
