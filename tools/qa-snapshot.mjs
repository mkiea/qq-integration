#!/usr/bin/env node
/**
 * 验收快照（2026-11-02）：把"最近 N 分钟发生了什么"打成一段可以直接贴回去的东西。
 *
 * 为什么要有它：验收清单里的判定全靠日志，而日志有三处（桥 debug、trace、Waylay），
 * 每次都让人自己去三个文件里 grep，等于把成本转嫁给用户。这个脚本只读不写，
 * 输出分成四块：入站、各阶段成败、引用/转发的细节行、Waylay 侧的内核调用。
 *
 * 用法：
 *   node tools/qa-snapshot.mjs            # 最近 10 分钟
 *   node tools/qa-snapshot.mjs 30         # 最近 30 分钟
 *   node tools/qa-snapshot.mjs 30 --all   # 连没用到的 stage 也列出来
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')

/** 数据目录：优先环境变量，其次仓库同级常见的 qq_chat，最后回落到当前目录。 */
function findDataDir() {
  const candidates = [
    process.env.QQ_DATA_DIR,
    join(repo, '..', 'qq_chat'),
    join(repo, '..'),
    process.cwd(),
  ].filter(Boolean)
  for (const dir of candidates) {
    if (existsSync(join(dir, 'qq-trace.jsonl'))) return dir
  }
  return ''
}

const args = process.argv.slice(2)
const minutes = Math.max(1, Number(args.find((a) => /^\d+$/.test(a))) || 10)
const showAll = args.includes('--all')
const since = Date.now() - minutes * 60_000

const dataDir = findDataDir()
if (dataDir === '') {
  console.error('找不到数据目录（里面应该有 qq-trace.jsonl）。可以设环境变量 QQ_DATA_DIR 指过去。')
  process.exit(2)
}

function readJsonl(file) {
  if (!existsSync(file)) return []
  const rows = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try { rows.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
  }
  return rows
}

function readTail(file, count) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-count)
}

const time = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })

// ---- 1. trace：入站与各阶段 ----
const events = readJsonl(join(dataDir, 'qq-trace.jsonl')).filter((e) => (e.ts ?? 0) >= since)
console.log(`\n== 数据目录 ${dataDir} ==`)
console.log(`== 时间窗：最近 ${minutes} 分钟，trace 事件 ${events.length} 条 ==\n`)

const inbound = events.filter((e) => e.stage === 'inbound')
console.log(`【入站】${inbound.length} 条`)
for (const e of inbound.slice(-12)) {
  const d = e.data ?? {}
  console.log(`  ${time(e.ts)}  ${d.atMe ? '@我 ' : ''}${String(d.text ?? '').slice(0, 40)}`
    + `${Array.isArray(d.images) && d.images.length ? ` [图${d.images.length}]` : ''}`
    + `${Array.isArray(d.records) && d.records.length ? ` [语音${d.records.length}]` : ''}`
    + `${Array.isArray(d.forwards) && d.forwards.length ? ` [转发${d.forwards.length}]` : ''}`)
}

const stages = new Map()
for (const e of events) {
  if (!e.stage || e.stage === 'inbound') continue
  if (!stages.has(e.stage)) stages.set(e.stage, { ok: 0, bad: 0, last: null, lastBad: null })
  const slot = stages.get(e.stage)
  if (e.ok === false) { slot.bad += 1; slot.lastBad = e } else slot.ok += 1
  slot.last = e
}
console.log('\n【各阶段】成功 / 失败')
const interesting = ['quote', 'forward', 'sticker', 'record', 'card', 'vision', 'reply', 'gate', 'drop']
for (const [stage, slot] of [...stages].sort((a, b) => b[1].ok + b[1].bad - (a[1].ok + a[1].bad))) {
  if (!showAll && !interesting.includes(stage) && slot.bad === 0) continue
  const bad = slot.lastBad ? `  最近失败：${String(slot.lastBad.reason ?? '').slice(0, 90)}` : ''
  console.log(`  ${stage.padEnd(10)} ${String(slot.ok).padStart(3)} / ${String(slot.bad).padStart(3)}${bad}`)
}

// ---- 2. 桥日志里的细节行（引用/转发/图片下载） ----
const bridgeLog = join(dataDir, 'qq-bridge-debug.log')
const detail = readTail(bridgeLog, 4000)
  .filter((line) => /quote resolve|quote image|forward|sticker|\brecord\b/.test(line))
  .slice(-10)
console.log('\n【桥日志细节】')
if (detail.length === 0) console.log('  （这 4000 行里没有引用/转发/表情/语音相关记录）')
for (const line of detail) console.log('  ' + line.replace(/^\[[^\]]*\]\s*/, '').slice(0, 140))

// ---- 3. Waylay 侧（内核调用） ----
const injectLog = join(repo, '..', '_tmp', 'rin-inject', 'rin-inject.log')
const kernel = readTail(injectLog, 3000)
  .filter((line) => /\[get_msg\]|\[forward\]|\[history\]|\[reply-element\]/.test(line))
  .slice(-10)
console.log('\n【Waylay 内核调用】')
if (kernel.length === 0) console.log('  （没有 get_msg / forward / history 记录 —— 说明这轮没走到回源那一步）')
for (const line of kernel) console.log('  ' + line.replace(/^\[[^\]]*\]\s*/g, '').slice(0, 150))

console.log('\n把上面整段贴回来就行。')
