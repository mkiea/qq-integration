/**
 * 用**真实人设**测本地模型：能不能守住「乖 + 魔人 + 短句多段」。
 *
 * 为什么不能用玩具 prompt 下结论：桥真正的 system 是 qq_chat/AGENTS.md（9.4KB），
 * 里面有「别猜对方职业」「不说教」「魔人只戳行为不戳长相」这类细约束。
 * 拿一句"你是傲娇猫娘"去测，测的是模型对一句话的服从，不是它能不能当这个人。
 *
 * 基线来自 qq_memory 里的真实记录（那些是云端 deepseek 说的），
 * 所以对比的是「同一个人的两种基座」，不是「好/坏」。
 */
import { readFileSync } from 'node:fs'

const BASE = 'http://127.0.0.1:11434/v1'
const persona = readFileSync('C:/Users/someone/Desktop/chat role/qq_chat/AGENTS.md', 'utf8')

const PROBES = [
  '今天好累啊',
  '在干嘛呢',
  '你是不是机器人',
]

async function chat(model, messages) {
  const started = Date.now()
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, max_tokens: 300 }),
  })
  const text = await res.text()
  const ms = Date.now() - started
  if (!res.ok) return { ok: false, ms, error: `HTTP ${res.status}: ${text.slice(0, 160)}` }
  const json = JSON.parse(text)
  return {
    ok: true, ms,
    reply: String(json.choices?.[0]?.message?.content ?? ''),
    tokens: json.usage?.completion_tokens ?? 0,
  }
}

const models = process.argv.slice(2)
for (const model of models) {
  console.log(`\n${'='.repeat(64)}\n${model}  （system = AGENTS.md ${persona.length} 字）`)
  for (const line of PROBES) {
    const r = await chat(model, [
      { role: 'system', content: persona },
      { role: 'user', content: line },
    ])
    if (!r.ok) { console.log(`  用户「${line}」→ ✗ ${r.error}`); continue }
    const segs = r.reply.split('\n').filter((s) => s.trim() !== '')
    const longest = Math.max(0, ...segs.map((s) => s.trim().length))
    const cat = /喵|本喵|猫/.test(r.reply) ? '有猫味' : '无猫味'
    const tps = r.tokens ? (r.tokens / (r.ms / 1000)).toFixed(1) : '?'
    console.log(`\n  用户「${line}」  ${r.ms}ms ${r.tokens}tok ${tps}tok/s  段=${segs.length} 最长=${longest}字 ${cat}`)
    for (const s of segs.slice(0, 5)) console.log(`    │ ${s.trim()}`)
  }
}
