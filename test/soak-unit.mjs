/**
 * 稳定性测试（soak）—— 长时间定速跑，看"会不会越跑越慢 / 越跑越大"。
 *
 * 与 `stress-unit` 的分工：那个回答"能吞多快"，这个回答"跑一小时后还是这个速度吗"。
 * 真机上最折磨人的两个故障都出在这里，而且**都不会报错**：
 *   · 某个缓存表没设上限 → RSS 慢慢涨 → 半夜被系统 OOM 杀掉（表现：QQ 机器人突然没了）
 *   · 某个定时器/句柄没释放 → 事件循环越来越忙 → 回复越来越慢（表现：她越来越迟钝）
 *
 * ── 判据（跑之前写死）──────────────────────────────────────────
 *   T1 全程没有 uncaughtException / unhandledRejection
 *   T2 RSS 线性斜率 < 5 MB/分钟（短跑噪声大，所以看**斜率**不看绝对值；
 *      跑 `--seconds 300` 得到的斜率才有参考意义）
 *   T3 活跃 handle 数不增长（末值 − 峰值前的稳态 ≤ 2）
 *   T4 有界的表一直有界：`seenMessages ≤ 1000`、`recentTexts ≤ 300`
 *   T5 会话/代理表不随消息量线性增长（`agents`、`sessions` 只跟**聊天数**有关）
 *   T6 数据目录文件数不随消息量增长（状态文件是"每聊天一份"，不是"每条一份"）
 *   T7 跑完之后仍能正常回复（不是"跑着跑着自己死了"）
 *   T8 stop() 之后定时器清空
 *
 * 用法：`node test/soak-unit.mjs`（默认 20 秒，够进 CI）
 *       `node test/soak-unit.mjs --seconds 300 --rate 20`（真跑一轮 soak）
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { QQBridge } from '../lib/bridge.js'
import { Config } from '../lib/index.js'

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : fallback
}
const SECONDS = argOf('seconds', 20)
const RATE = argOf('rate', 8)
const CHATS = argOf('chats', 5)

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const MEMBERS = Array.from({ length: CHATS }, (_, i) => 2000000001 + i)
const root = mkdtempSync(join(tmpdir(), 'qq-soak-'))

const stats = { followup: 0, replied: 0, fatal: [], done: new Set() }
const emitAt = new Map()

class MockServer extends EventEmitter {
  constructor() {
    super()
    this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }
  }
  currentSocket() { return this.socket }
  async sendSegments() { stats.replied++; return { message_id: stats.replied } }
  async sendText() { stats.replied++; return { message_id: stats.replied } }
  async callAction() { return { ok: true, messages: [] } }
  async getLoginInfo() { return { user_id: 3000000001, nickname: 'bot' } }
  async getStatus() { return { online: true, good: true } }
  async canSendImage() { return { yes: true } }
  async canSendRecord() { return { yes: true } }
}

function makeCtx() {
  let seq = 0
  const newHandle = (sessionId) => {
    const id = String(sessionId || `qq-soak-${++seq}`)
    return {
      agent: {
        id,
        status: 'idle',
        followup(message) {
          stats.followup++
          const blocks = Array.isArray(message?.content) ? message.content : []
          const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('')
          const hit = /#(\d+)/.exec(text)
          if (hit) stats.done.add(Number(hit[1]))
          return Promise.resolve()
        },
        cancel() {},
      },
      sessionId: id,
      dispose: async () => {},
    }
  }
  return {
    on: () => () => {},
    get: () => undefined,
    agents: {
      create: async ({ sessionId }) => newHandle(sessionId),
      resume: async ({ resumeSessionId }) => newHandle(resumeSessionId),
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    logger: () => ({ info() {}, warn() {}, error() {} }),
  }
}

const BASE = {
  host: '127.0.0.1', port: 0, accessToken: '', allowUsers: MEMBERS, allowGroups: [100000001],
  botQq: 3000000001, botName: 'bot', replyOnlyWhenMentioned: false, acceptPrivate: true,
  sessionMode: 'chat', sessionResumeEnabled: true, quietHours: [], quietHoursEnabled: false,
  notifyEnabled: false, injectEnabled: false, recordInbound: false,
  // trace 打开：它是真实运行时的默认值，也是"会不会无限写盘"的嫌疑对象之一
  traceEnabled: true, traceLevel: 'info', actionAuditEnabled: false,
  adminEnabled: false, rateLimitEnabled: false, floodEnabled: false, filterEnabled: false,
  proactiveEnabled: false, funEnabled: false, memoryEnabled: true,
  pointsEnabled: false, statsEnabled: false, checkinEnabled: false, gameEnabled: false,
  reminderEnabled: false, todoEnabled: false, voteEnabled: false, summaryEnabled: false,
  exportEnabled: false, dailyReportEnabled: false, mcStatusEnabled: false,
  imageGenEnabled: false, ttsEnabled: false, sttEnabled: false, voiceReadingEnabled: false,
  verifyEnabled: false, antiRecallEnabled: false, welcomeEnabled: false, pokeEnabled: false,
  autoCollectStickers: false, faceEnabled: false, privateImageView: false,
  fileTransferEnabled: false, agentMediaToolsEnabled: false,
  provider: 'test', model: 'test',
}

const server = new MockServer()
/** ⚠️ 关掉离线重放守卫：这个套件是长跑压测，会连续灌消息，守卫会判成重放而静默。 */
const bridge = new QQBridge(makeCtx(), { ...Config({ replayGuardEnabled: false }), ...BASE, cwd: root }, server, { info() {}, warn() {}, error() {} })
process.on('uncaughtException', (error) => stats.fatal.push(`uncaught: ${error?.message ?? error}`))
process.on('unhandledRejection', (error) => stats.fatal.push(`unhandled: ${error?.message ?? error}`))
bridge.start()
await new Promise((r) => setTimeout(r, 60))

let nextId = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rssMb = () => Math.round(process.memoryUsage().rss / 1048576)
const handles = () => process._getActiveHandles?.().length ?? -1
const dataFiles = () => {
  // ⚠️ 只数**文件**：qq-files/qq-history/qq-images/qq-memory 是首次使用时建的目录，
  // 把目录算进去会得到每跑一次涨几个的假增长（第一版就这么误报了 T6）。
  const walk = (dir) => {
    let n = 0
    let items = []
    try { items = readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
    for (const item of items) {
      if (item.isDirectory()) n += walk(join(dir, item.name))
      else n += 1
    }
    return n
  }
  try { return walk(root) } catch { return -1 }
}
const dataBytes = () => {
  try {
    return readdirSync(root).reduce((sum, name) => {
      try { return sum + statSync(join(root, name)).size } catch { return sum }
    }, 0)
  } catch { return -1 }
}
const sentTotal = () => {
  // sentMessages 是 Map<chatKey, [{...}]>，这里只要总条数
  let n = 0
  try { for (const list of bridge.sentMessages.values()) n += list.length } catch {}
  return n
}

const samples = []
function sample() {
  samples.push({
    at: Date.now(),
    rss: rssMb(),
    handles: handles(),
    timers: bridge.timers.size,
    seen: bridge.seenMessages.size,
    recent: bridge.recentTexts.size,
    agents: bridge.agents.size,
    sessions: bridge.sessions.size,
    files: dataFiles(),
    bytes: dataBytes(),
    sent: sentTotal(),
    followup: stats.followup,
  })
}

function message(tag) {
  return {
    bot: server.socket,
    userId: MEMBERS[tag % MEMBERS.length],
    messageType: 'private',
    text: `soak 消息 #${tag}`,
    atMe: false, ats: [], reply: null,
    records: [], images: [], files: [], forwards: [], videos: [],
    messageId: `soak-${tag}`,
    senderName: '主人',
    raw: { message: [] },
  }
}

/** 最小二乘斜率（单位：每秒）。x 用秒，避免大数相减丢精度。 */
function slope(points) {
  if (points.length < 3) return 0
  const xs = points.map((p) => (p.at - points[0].at) / 1000)
  const ys = points.map((p) => p.value)
  const n = xs.length
  const sx = xs.reduce((a, b) => a + b, 0)
  const sy = ys.reduce((a, b) => a + b, 0)
  const sxy = xs.reduce((acc, x, i) => acc + x * ys[i], 0)
  const sxx = xs.reduce((acc, x) => acc + x * x, 0)
  const denom = n * sxx - sx * sx
  if (denom === 0) return 0
  return (n * sxy - sx * sy) / denom
}

// ─────────────────────────────────────────── 主循环
const loop = monitorEventLoopDelay({ resolution: 20 })
loop.enable()
sample()
const total = Math.round(SECONDS * RATE)
const t0 = Date.now()
let sent = 0
for (let i = 0; i < total; i++) {
  const tag = nextId++
  emitAt.set(tag, Date.now())
  server.emit('message', message(tag))
  sent++
  if (i % 10 === 9) sample()
  const dueAt = t0 + ((i + 1) * 1000) / RATE
  const wait = dueAt - Date.now()
  if (wait > 0) await sleep(wait)
}
// 排空
let last = -1
for (let i = 0; i < 200; i++) {
  if (stats.followup === last) break
  last = stats.followup
  await sleep(50)
}
sample()
loop.disable()

const elapsedMin = (Date.now() - t0) / 60000
const rssSlope = slope(samples.map((s) => ({ at: s.at, value: s.rss }))) * 60   // MB/min
const handleSlope = slope(samples.map((s) => ({ at: s.at, value: s.handles }))) * 60
const filesSlope = slope(samples.map((s) => ({ at: s.at, value: s.files }))) * 60
const first = samples[0]
const lastS = samples.at(-1)

console.log(`\n=== 稳定性：${SECONDS}s @ ${RATE}/秒，共 ${sent} 条，${CHATS} 个会话 ===`)
console.log(`实际用时 ${(elapsedMin * 60).toFixed(1)}s · 到模型 ${stats.followup} · 回包 ${stats.replied}`)
console.log(`RSS ${first.rss}MB → ${lastS.rss}MB（斜率 ${rssSlope.toFixed(2)} MB/分）`)
console.log(`handle ${first.handles} → ${lastS.handles}（斜率 ${handleSlope.toFixed(2)}/分）`)
console.log(`定时器 ${first.timers} → ${lastS.timers}`)
console.log(`有界表：seenMessages ${lastS.seen}（≤1000）｜recentTexts ${lastS.recent}（≤300）`)
console.log(`表规模：agents ${lastS.agents}｜sessions ${lastS.sessions}｜sentMessages ${lastS.sent}`)
console.log(`数据目录：${lastS.files} 个文件 / ${(lastS.bytes / 1024).toFixed(1)}KB（文件数斜率 ${filesSlope.toFixed(2)}/分）`)
console.log('  文件清单：' + (() => { try { return readdirSync(root).sort().join(' ') } catch { return '(读不到)' } })())
console.log(`事件循环滞后 p99=${Math.round(loop.percentile(99) / 1e6)}ms max=${Math.round(loop.max / 1e6)}ms`)

check('T1 全程没有未捕获异常/未处理拒绝', stats.fatal.length === 0, stats.fatal.slice(0, 3).join(' | '))
check('T2 ★RSS 斜率 < 5 MB/分', rssSlope < 5, `${rssSlope.toFixed(2)} MB/分（Δ +${lastS.rss - first.rss}MB）`)
check('T3 活跃 handle 不增长', lastS.handles - first.handles <= 2 && handleSlope < 1, `${first.handles} → ${lastS.handles}（斜率 ${handleSlope.toFixed(2)}/分）`)
check('T4 ★有界表一直有界（seenMessages ≤ 1000）', lastS.seen <= 1000, `seenMessages=${lastS.seen}`)
check('T4b 有界表一直有界（recentTexts ≤ 300）', lastS.recent <= 300, `recentTexts=${lastS.recent}`)
check('T5 表不随消息量线性增长（agents 只跟会话数有关）', lastS.agents <= CHATS + 2, `agents=${lastS.agents} 会话=${CHATS}`)
// 判据只看**后半程**：前一半允许建目录/建每聊天一份的状态文件（那是稳态的一次性成本），
// 稳态还在涨才是 bug（比如每条消息一个文件）。
const lateSamples = samples.slice(Math.floor(samples.length / 2))
const lateGrowth = lateSamples.length > 1 ? lateSamples.at(-1).files - lateSamples[0].files : 0
check('T6 ★稳态数据文件数不再增长（后半程）', lateGrowth <= 0, `后半程 ${lateGrowth} 个（全程 ${first.files} → ${lastS.files}）`)
check('T6b 数据体积增长受控（< 5MB）', lastS.bytes < 5 * 1024 * 1024, `${(lastS.bytes / 1024).toFixed(1)}KB`)

// T7 跑完还能不能说话
{
  const tag = nextId++
  emitAt.set(tag, Date.now())
  const before = stats.followup
  server.emit('message', message(tag))
  let ok = false
  for (let i = 0; i < 100; i++) {
    if (stats.followup > before) { ok = true; break }
    await sleep(50)
  }
  check('T7 跑完之后仍能正常回复', ok, ok ? '正常' : '5 秒内没到站')
}

// T8 停机
bridge.stop()
await sleep(300)
check('T8 stop() 之后定时器清空', bridge.timers.size === 0, `timers=${bridge.timers.size}`)

console.log(`\n${passed} passed, ${failed} failed`)
try { rmSync(root, { recursive: true, force: true }) } catch {}
process.exit(failed > 0 ? 1 : 0)
