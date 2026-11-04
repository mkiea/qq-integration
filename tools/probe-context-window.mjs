#!/usr/bin/env node
/**
 * 上下文窗口探针（2026-11-04，主人问"咱有上下文压缩吗"）。
 *
 * 要回答两个不一样的问题，所以分两段：
 *
 *   A. 桥侧：`memoryEnabled` 的滚动窗口会不会失控？
 *      窗口 = 每聊天 60 行原文 + 400 行归档；超过 60 行滚动、超出归档（不丢）。
 *      这里连发 N 条，量化"文件长到多大、重启后往新会话里注多少字"。
 *
 *   B. DSH 侧：当前会话的上下文由 DSH 管，桥看不见。
 *      本探针只给出可观察的间接证据（.dsh/sessions 的文件大小），
 *      不下"DSH 压不压缩"的结论 —— 那要真会话实测才能判定。
 *
 * 安全：port 0 不监听、mock agent 不回真消息、cwd 是临时目录。
 *
 * 用法：node tools/probe-context-window.mjs [--rounds 100] [--keep]
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QQBridge } from '../lib/bridge.js'
import { Config } from '../lib/index.js'

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const ROUNDS = Math.max(10, Number(argOf('--rounds', '100')) || 100)
const KEEP = argv.includes('--keep')

let checks = 0
const failures = []
function checkA(name, ok, extra = '') {
  checks += 1
  if (ok) console.log(`   PASS ${name}${extra ? `（${extra}）` : ''}`)
  else { failures.push(name); console.log(`   FAIL ${name}${extra ? `（${extra}）` : ''}`) }
}

const root = mkdtempSync(join(tmpdir(), 'qq-ctx-'))
const injected = []
const CHAT = 2000000001

class MockServer extends EventEmitter {
  constructor() {
    super()
    this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }
  }
  currentSocket() { return this.socket }
  async sendSegments() { return { message_id: 1 } }
  async sendText() { return { message_id: 1 } }
  async callAction() { return { ok: true, messages: [] } }
  async getLoginInfo() { return { user_id: 3000000001, nickname: 'bot' } }
  async getStatus() { return { online: true } }
  async canSendImage() { return { yes: true } }
  async canSendRecord() { return { yes: true } }
  async getForwardMsg() { return { messages: [] } }
}

const ctx = {
  on: () => () => {},
  get: () => undefined,
  agents: {
    create: async ({ sessionId }) => ({
      agent: {
        id: String(sessionId), status: 'idle',
        followup(message) {
          const blocks = Array.isArray(message?.content) ? message.content : []
          injected.push(blocks.filter((b) => b?.type === 'text').map((b) => b.text).join(''))
          return Promise.resolve()
        },
        cancel() {},
      },
      sessionId: String(sessionId), dispose: async () => {},
    }),
    resume: async ({ resumeSessionId }) => ({
      agent: {
        id: String(resumeSessionId), status: 'idle',
        followup(message) {
          const blocks = Array.isArray(message?.content) ? message.content : []
          injected.push(blocks.filter((b) => b?.type === 'text').map((b) => b.text).join(''))
          return Promise.resolve()
        },
        cancel() {},
      },
      sessionId: String(resumeSessionId), dispose: async () => {},
    }),
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
  logger: () => ({ info() {}, warn() {}, error() {} }),
}

const BASE = {
  host: '127.0.0.1', port: 0, accessToken: '', allowUsers: [CHAT], allowGroups: [],
  botQq: 3000000001, botName: 'bot', replyOnlyWhenMentioned: false, acceptPrivate: true,
  sessionMode: 'chat', sessionResumeEnabled: false, quietHours: [], quietHoursEnabled: false,
  notifyEnabled: false, injectEnabled: false, recordInbound: false, traceEnabled: false,
  proactiveEnabled: false, adminEnabled: false, rateLimitEnabled: false, filterEnabled: false,
  ttsEnabled: false, voiceToolEnabled: false, provider: 'test', model: 'test',
  memoryEnabled: true,
}

let seq = 0
const msg = (text) => ({
  bot: { readyState: 1 }, userId: CHAT, messageType: 'private', text,
  atMe: false, ats: [], reply: null,
  records: [], images: [], files: [], forwards: [], videos: [],
  messageId: `ctx-${++seq}`, selfId: 3000000001,
  time: Math.floor(Date.now() / 1000), raw: null,
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function safeStop(bridge) { try { await bridge.stop?.() } catch { /* 忽略 */ } }

function inspectMemory() {
  const dir = join(root, 'qq-memory')
  if (!existsSync(dir)) return { files: 0, entries: 0, archived: 0, bytes: 0 }
  let files = 0
  let entries = 0
  let archived = 0
  let bytes = 0
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    files += 1
    const full = join(dir, f)
    bytes += statSync(full).size
    try {
      const data = JSON.parse(readFileSync(full, 'utf8'))
      const rec = Array.isArray(data) ? data : (data.history ?? data.entries ?? [])
      entries += Array.isArray(rec) ? rec.length : 0
      const arch = data?.archive ?? []
      archived += Array.isArray(arch) ? arch.length : 0
    } catch { /* 坏文件跳过 */ }
  }
  return { files, entries, archived, bytes }
}

async function makeBridge() {
  const server = new MockServer()
  const bridge = new QQBridge(ctx, { ...Config({}), ...BASE, cwd: root }, server, { info() {}, warn() {}, error() {} })
  try { await bridge.start?.() } catch { /* 继续 */ }
  return { bridge, server }
}

console.log('='.repeat(64))
console.log(`A. 桥侧：连发 ${ROUNDS} 条，看滚动窗口会不会失控`)
console.log('='.repeat(64))

let { bridge, server } = await makeBridge()
const before = inspectMemory()

for (let i = 1; i <= ROUNDS; i += 1) {
  server.emit('message', msg(`第 ${i} 条：这是一句用来占位的话，长度普通。`))
  if (i % 10 === 0) await sleep(30)
}
await sleep(800)
const after = inspectMemory()

console.log(`   发出 ${ROUNDS} 条 · 记忆文件 ${after.files} 个`)
console.log(`   记忆条目 ${before.entries} → ${after.entries}（上限 60/chat）`)
console.log(`   归档条目 ${before.archived} → ${after.archived}（上限 400/chat）`)
console.log(`   文件大小 ${(after.bytes / 1024).toFixed(1)} KB`)

server.emit('message', msg(`长消息：${'啊'.repeat(60000)}`))
await sleep(600)
const afterBig = inspectMemory()
console.log(`   再发一条 6 万字长消息后：条目 ${afterBig.entries} · 文件 ${(afterBig.bytes / 1024).toFixed(1)} KB`)

checkA('A1 记忆条目不超过窗口上限 60', after.entries <= 60, `实际 ${after.entries}`)
checkA('A2 归档不超过 400', afterBig.archived <= 400 * Math.max(1, afterBig.files), `实际 ${afterBig.archived}`)
checkA('A3 长消息没让条目数暴涨', afterBig.entries <= 60, `${afterBig.entries}`)
checkA('A4 长消息没让文件爆到几 MB', afterBig.bytes < 2 * 1024 * 1024, `${(afterBig.bytes / 1024).toFixed(1)} KB`)

await safeStop(bridge)

console.log('')
console.log('='.repeat(64))
console.log('B. 记忆注入到哪一层（这决定它占不占对话历史）')
console.log('='.repeat(64))

// 重启前先把窗口撑满，再读文件验证"窗口真的在滚动"
const filled = inspectMemory()
console.log('   重启前：history ' + filled.entries + ' 条 / archive ' + filled.archived + ' 条 / ' + (filled.bytes / 1024).toFixed(1) + ' KB')
checkA('B1 窗口上限生效（history ≤ 60）', filled.entries <= 60, filled.entries + ' 条')
checkA('B2 挤出的进归档而不是丢（archive > 0）', filled.archived > 0, filled.archived + ' 条')

// 注入层：读源码确认走 systemPrompt.section（而不是 message content）
const bsrc2 = readFileSync(new URL('../lib/bridge.js', import.meta.url), 'utf8')
const memSection = /name: 'qq-persistent-memory'/.test(bsrc2)
const viaSystem = /systemPrompt\.section\(\{[\s\S]{0,400}qq-persistent-memory/.test(bsrc2)
console.log('   注入方式：' + (memSection ? (viaSystem ? 'systemPrompt.section（system 层）' : '其它') : '未找到'))
checkA('B3 ★重启后的记忆注入走 systemPrompt.section', memSection && viaSystem)
checkA('B4 群聊与私聊措辞分开（群聊不许要求续写）', /Fragments kept from earlier in this QQ group/.test(bsrc2))

await safeStop(bridge)

console.log('C. DSH 侧的间接证据（本探针不下结论）')
console.log('='.repeat(64))
const dshSessions = 'C:/Users/SolimPurmiss/.dsh/sessions/--C-Users-SolimPurmiss-Desktop-chat~0020role-qq_chat--'
if (existsSync(dshSessions)) {
  const dirs = readdirSync(dshSessions).filter((d) => !d.startsWith('.'))
  const sizes = []
  let scanned = 0
  for (const d of dirs) {
    try {
      for (const f of readdirSync(join(dshSessions, d))) {
        sizes.push(statSync(join(dshSessions, d, f)).size)
        scanned += 1
      }
    } catch { /* 跳过 */ }
  }
  sizes.sort((a, b) => b - a)
  console.log(`   .dsh/sessions 下 ${dirs.length} 个会话目录 / ${scanned} 个文件`)
  console.log(`   最大 ${(sizes[0] / 1024).toFixed(0)} KB · 中位 ${(sizes[Math.floor(sizes.length / 2)] / 1024).toFixed(0)} KB`)
  console.log('   → 只能说明存了多少；喂给模型多少由 DSH 决定，需真会话实测')
} else {
  console.log('   没找到 .dsh/sessions 目录，跳过')
}

if (!KEEP) rmSync(root, { recursive: true, force: true })
console.log('')
console.log(`${checks} passed, ${failures.length} failed${KEEP ? `  （临时目录：${root}）` : ''}`)
process.exit(failures.length > 0 ? 1 : 0)
