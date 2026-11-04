#!/usr/bin/env node
/**
 * 真机长跑分析（soak analysis）—— 2026-11-04。
 *
 * 与 `test/soak-unit.mjs` 的分工：那个是**离线模拟**（自己造负载、造时钟），
 * 这个读的是**真机上跑出来的日志**，回答"这几天她累不累、有没有慢性病"。
 *
 * 它不联网、不启桥、只读 `qq_chat/` 下的文件，所以可以随时在生产机上跑。
 *
 * 用法：
 *   node tools/analyze-soak.mjs                     # 默认读 <cwd 上级>/qq_chat
 *   node tools/analyze-soak.mjs --dir D:/path/qq_chat
 *   node tools/analyze-soak.mjs --days 3            # 只看最近 3 天
 *
 * 输出七节：跨度 / 按天 / 失败归并 / 失败率趋势 / 消息配对 / 卡死与重启 / 慢性重复。
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const dir = argOf('--dir', join(process.cwd(), '..', 'qq_chat'))
const days = Number(argOf('--days', '0')) || 0
const TRACE = join(dir, 'qq-trace.jsonl')
const RUNTIME = join(dir, 'qq-runtime.json')

if (!existsSync(TRACE)) {
  console.error(`读不到 ${TRACE}（用 --dir 指定 qq_chat 目录）`)
  process.exit(1)
}

// ---------- 读 trace ----------
const lines = readFileSync(TRACE, 'utf8').trim().split('\n')
const events = []
for (const line of lines) {
  if (line.trim() === '') continue
  let j
  try { j = JSON.parse(line) } catch { continue }
  if (!j.ts) continue
  events.push(j)
}
events.sort((a, b) => a.ts - b.ts)

const cutoff = days > 0 ? events[events.length - 1].ts - days * 86400_000 : 0
const rows = events.filter((e) => e.ts >= cutoff)

const fmt = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
const pct = (n, d) => d === 0 ? '—' : `${(n / d * 100).toFixed(1)}%`

// ---------- ① 跨度 ----------
const first = rows[0].ts
const last = rows[rows.length - 1].ts
const spanH = (last - first) / 3600_000
console.log('='.repeat(64))
console.log(`① 跨度：${fmt(first)} → ${fmt(last)}  =  ${spanH.toFixed(1)} 小时（${(spanH / 24).toFixed(1)} 天）`)
console.log(`   事件 ${rows.length} 条 | 文件 ${(statSync(TRACE).size / 1024 / 1024).toFixed(1)} MB | 目录 ${dir}`)
if (existsSync(RUNTIME)) {
  try {
    const rt = JSON.parse(readFileSync(RUNTIME, 'utf8'))
    console.log(`   当前进程 uptime ${((rt.uptimeSeconds ?? 0) / 3600).toFixed(1)} 小时 | 版本 ${rt.version} | 会话 ${rt.sessionCount ?? 0}`)
  } catch { /* 快照坏了不影响分析 */ }
}

// ---------- ② 按天 ----------
const byDay = new Map()
for (const e of rows) {
  const d = new Date(e.ts).toLocaleDateString('zh-CN')
  const cur = byDay.get(d) ?? { n: 0, fail: 0 }
  cur.n += 1
  if (e.ok === false) cur.fail += 1
  byDay.set(d, cur)
}
console.log('\n② 按天：条数 / 失败 / 失败率')
for (const [d, v] of byDay) {
  console.log(`   ${d}  ${String(v.n).padStart(5)}  ${String(v.fail).padStart(4)}  ${pct(v.fail, v.n).padStart(6)}`)
}

// ---------- ③ 失败归并 ----------
const fails = rows.filter((e) => e.ok === false)
const byReason = new Map()
for (const f of fails) {
  // 把数字压掉，让同类错误能归并（"第 238 回合" 和 "第 12 回合" 是一类）
  const key = `${f.stage ?? '?'} | ${String(f.reason ?? '').replace(/\d+/g, 'N').slice(0, 62)}`
  byReason.set(key, (byReason.get(key) ?? 0) + 1)
}
console.log(`\n③ 失败归并：共 ${fails.length} 条（占 ${pct(fails.length, rows.length)}），前 12 类`)
for (const [k, v] of [...byReason.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`   ${String(v).padStart(4)} × ${k}`)
}

// ---------- ④ 失败率趋势（是不是越来越差） ----------
console.log('\n④ 失败率趋势（按天，看有没有"越跑越差"）')
const dayList = [...byDay.entries()]
if (dayList.length >= 3) {
  const rates = dayList.map(([, v]) => v.n === 0 ? 0 : v.fail / v.n)
  const firstHalf = rates.slice(0, Math.floor(rates.length / 2))
  const secondHalf = rates.slice(Math.floor(rates.length / 2))
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1)
  const a1 = avg(firstHalf)
  const a2 = avg(secondHalf)
  const trend = a2 > a1 * 1.5 ? '⚠️ 后半段明显更差' : (a2 < a1 * 0.7 ? '✅ 后半段更好' : '≈ 持平')
  console.log(`   前半段均值 ${pct(a1, 1)} → 后半段 ${pct(a2, 1)}  ${trend}`)
} else {
  console.log('   天数不足 3 天，不给趋势结论')
}

// ---------- ⑤ 入站 / 回复配对 ----------
const byId = new Map()
for (const e of rows) {
  if (!e.id) continue
  if (!byId.has(e.id)) byId.set(e.id, new Map())
  byId.get(e.id).set(e.stage, e)
}
let inbound = 0
let replied = 0
let noReply = 0
for (const stages of byId.values()) {
  if (!stages.has('inbound')) continue
  inbound += 1
  const reply = stages.get('reply')
  if (reply && reply.ok !== false) replied += 1
  else noReply += 1
}
console.log('\n⑤ 入站消息与回复')
console.log(`   带 trace 的入站 ${inbound} 条 | 有成功 reply ${replied} 条（${pct(replied, inbound)}）| 无成功 reply ${noReply} 条`)

// ---------- ⑥ 卡死 / 掐断 / 重启 ----------
const stuck = rows.filter((e) => /turn-stuck|没有结束|强制中断/.test(String(e.reason ?? '') + JSON.stringify(e.data ?? {})))
const aborts = rows.filter((e) => /强制中断|turn-aborted/.test(String(e.reason ?? '') + JSON.stringify(e.data ?? {})))
const boots = rows.filter((e) => /主动通道已启动|proactive channel on/.test(String(e.reason ?? '')))
console.log('\n⑥ 卡死与重启')
console.log(`   看门狗告警 ${stuck.length} 次 | 强制掐断 ${aborts.length} 次 | 主动通道启动 ${boots.length} 次（≈ 桥重启次数）`)

// ---------- ⑦ 慢性重复（同一原因反复出现，且跨天） ----------
console.log('\n⑦ 慢性重复（同一类失败出现在 ≥2 天，说明不是偶发）')
const reasonDays = new Map()
for (const f of fails) {
  const key = `${f.stage ?? '?'} | ${String(f.reason ?? '').replace(/\d+/g, 'N').slice(0, 50)}`
  if (!reasonDays.has(key)) reasonDays.set(key, new Set())
  reasonDays.get(key).add(new Date(f.ts).toLocaleDateString('zh-CN'))
}
const chronic = [...reasonDays.entries()].filter(([, set]) => set.size >= 2).sort((a, b) => b[1].size - a[1].size)
if (chronic.length === 0) console.log('   无（所有失败都只集中在一天）')
for (const [k, set] of chronic.slice(0, 8)) console.log(`   ${set.size} 天 × ${k}`)

console.log('\n' + '='.repeat(64))
console.log('注：本工具只读日志，不改任何状态。判定"慢性"的门槛是"出现在 ≥2 天"，不是次数。')
