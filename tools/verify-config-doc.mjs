/**
 * 文档与代码的配置默认值核对（2026-11-05）。
 *
 * 做法：从 README 的配置表抽「键 | 默认值」，从 lib/index.js 的 zod schema
 * 抽实际默认值，逐项对比。**不靠抽样、不靠肉眼**。
 *
 * 只比三类能机械判定的：字符串 / 数字 / 布尔 / 简单数组。
 * 复杂默认（对象、函数、多行数组）记为「跳过」并打印，不假装比过。
 *
 * 用法：node tools/verify-config-doc.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 从模块位置推根目录（原来写死绝对路径，换台机器就跑不了）
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const readme = readFileSync(`${ROOT}/README.md`, 'utf8')
const schema = readFileSync(`${ROOT}/lib/index.js`, 'utf8')

// ---------- 抽 README 表格 ----------
/** @type {Map<string, string>} key -> 原文默认值 */
const docDefaults = new Map()
let inTable = false
for (const line of readme.split('\n')) {
  if (/^\|\s*键\s*\|\s*默认\s*\|/.test(line)) { inTable = true; continue }
  if (inTable && !line.startsWith('|')) { inTable = false; continue }
  if (!inTable) continue
  const m = /^\|\s*`([a-zA-Z][\w]*)`\s*\|\s*(.*?)\s*\|/.exec(line)
  if (!m) continue
  docDefaults.set(m[1], m[2].replace(/`/g, '').trim())
}

// ---------- 抽 index.js 的 schema 默认值 ----------
/** @type {Map<string, string>} key -> 源码里的默认值表达式 */
const codeDefaults = new Map()
// 匹配形如  keyName: z.xxx(...).default(值)  或  .default(值)\n  .description
const re = /^\s{2}([a-zA-Z][\w]*):\s*z\.[\s\S]{0,600}?\.default\(([^)]*)\)/gm
for (const m of schema.matchAll(re)) {
  codeDefaults.set(m[1], m[2].trim())
}

// ---------- 归一化 ----------
const norm = (v) => String(v ?? '')
  // README 把空字符串写成「空」（比 `` 可读），这里认这个词，否则 16 项空默认值会假报不一致
  .replace(/^空$/, "''")
  .replace(/^['"]|['"]$/g, '')
  .replace(/^\[|\]$/g, '')
  .replace(/\s+/g, '')
  .toLowerCase()

const COMPARABLE = (v) => v !== '' && !/^\[\.\.\.\]$/.test(v) && v.length < 60

// ---------- 对比 ----------
const mismatch = []
const docOnly = []
const codeOnly = []
let compared = 0
let skipped = 0

for (const [key, docVal] of docDefaults) {
  const codeVal = codeDefaults.get(key)
  if (codeVal === undefined) { docOnly.push(key); continue }
  if (!COMPARABLE(docVal) || !COMPARABLE(codeVal)) { skipped += 1; continue }
  compared += 1
  if (norm(docVal) !== norm(codeVal)) mismatch.push({ key, doc: docVal, code: codeVal })
}
for (const key of codeDefaults.keys()) {
  if (!docDefaults.has(key)) codeOnly.push(key)
}

// ---------- 报告 ----------
console.log('='.repeat(66))
console.log(`README 配置表 ${docDefaults.size} 项 | index.js schema ${codeDefaults.size} 项`)
console.log(`逐项比过 ${compared} 项 | 跳过（复杂值）${skipped} 项`)
console.log('='.repeat(66))

if (mismatch.length === 0) {
  console.log('\n✅ 默认值全部一致')
} else {
  console.log(`\n❌ 默认值不一致 ${mismatch.length} 处：`)
  for (const m of mismatch) console.log(`   ${m.key.padEnd(28)} README=${m.doc.padEnd(18)} 代码=${m.code}`)
}

if (docOnly.length > 0) {
  console.log(`\n⚠️ README 有、schema 里没找到（${docOnly.length}）：`)
  console.log('   ' + docOnly.join(' '))
}
if (codeOnly.length > 0) {
  console.log(`\nℹ️ schema 有、README 没写（${codeOnly.length}）：`)
  console.log('   ' + codeOnly.join(' '))
}

console.log('')
console.log('注：只比能机械判定的标量；数组/对象/多行值记「跳过」，不当成一致。')
process.exit(mismatch.length > 0 ? 1 : 0)
