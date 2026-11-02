/**
 * 压力测试（stress）—— 2026-11-02 夜，主人要求"压力测试 / 稳定性 / 鲁棒性"。
 *
 * 为什么单独一个文件：`test/` 下 100+ 个套件全是**功能断言**（对/错），
 * 没有一个回答"一条消息要多久、每秒能吞多少、越跑越慢吗、内存一直涨吗"。
 * 这三件事错了不会报错，只会在真机上表现为"她突然很久不说话"或"进程半夜被 OOM 杀掉"。
 *
 * ── 打的是哪条路径（说清楚，别夸大）──────────────────────────────
 * 只打**不需要真 QQ、不需要模型**的那一段：
 *   入站形状 → 白名单/安静时段/去重/限流闸门 → 会话映射 → `agent.followup`
 * 以及**本机指令的真实回包路径**（骰子走 `sendSegments`）。
 * **不打**：模型推理、真 WS 收发、图片/语音上传 —— 那些取决于外部服务，
 * 压它们只会得到"网快/网慢"，不是这个插件的能力边界。
 *
 * ── 判据（跑之前写死）──────────────────────────────────────────
 *   S1 没有任何 uncaughtException / unhandledRejection
 *   S2 计数守恒：每条该到模型的消息都到了（丢消息是最坏的 bug —— 她"就是没理你"，
 *      而日志里什么都没有）
 *   S3 **单条服务时间** p95 < 50ms（顺序发、等下一条完成再发下一条。
 *      ⚠️ 这条不能拿"突发时的端到端延迟"来量：突发 5000 条时 p95 必然 ≈ N/吞吐，
 *      那是在量队列长度，不是在量这个系统的能力 —— 第一版就这么量，得到 p95=12.7s）
 *   S4 事件循环滞后 p99 < 200ms（超了说明有同步阻塞在热路径上，真机表现是"整机卡一下"）
 *   S5 突发 5000 条后 RSS 增量 < 150MB，且进程仍能正常回复
 *   S6 停机后没有活着的定时器
 *
 * 用法：`node test/stress-unit.mjs`｜`--burst 10000 --seq 500 --chats 20`
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
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
const BURST = argOf('burst', 5000)
const SEQ = argOf('seq', 300)
const CHATS = argOf('chats', 20)
const RATE = argOf('rate', 400)

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

/** 多聊天：白名单里放 CHATS 个人，突发时轮流打，避免"只有一个会话"的假象。 */
const MEMBERS = Array.from({ length: CHATS }, (_, i) => 2000000001 + i)
const GROUP = 100000001
const root = mkdtempSync(join(tmpdir(), 'qq-stress-'))

const stats = { followup: 0, replied: 0, latencies: [], fatal: [], seqDone: new Map() }
const emitAt = new Map()

class MockServer extends EventEmitter {
  constructor() {
    super()
    this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }
    this.sent = []
  }
  currentSocket() { return this.socket }
  async sendSegments(bot, messageType, targetId, segments) {
    stats.replied++
    this.sent.push({ at: Date.now(), targetId, segments })
    return { message_id: stats.replied }
  }
  async sendText(bot, mt, tid, text) { return this.sendSegments(bot, mt, tid, [{ type: 'text', data: { text } }]) }
  async callAction() { return { ok: true, messages: [] } }
  async getLoginInfo() { return { user_id: 3000000001, nickname: 'bot' } }
  async getStatus() { return { online: true, good: true } }
  async canSendImage() { return { yes: true } }
  async canSendRecord() { return { yes: true } }
}

/** 模型桩：`followup` 一被调用就算这条消息"到站"，顺带按 `#<序号>` 记账。 */
function makeCtx() {
  let seq = 0
  const newHandle = (sessionId) => {
    const id = String(sessionId || `qq-stress-${++seq}`)
    return {
      agent: {
        id,
        status: 'idle',
        followup(message) {
          stats.followup++
          const blocks = Array.isArray(message?.content) ? message.content : []
          const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('')
          const hit = /#(\d+)/.exec(text)
          if (hit) {
            const n = Number(hit[1])
            const started = emitAt.get(n)
            if (started !== undefined) {
              stats.latencies.push(Date.now() - started)
              stats.seqDone.set(n, Date.now())
            }
          }
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
  host: '127.0.0.1', port: 0, accessToken: '', allowUsers: MEMBERS, allowGroups: [GROUP],
  botQq: 3000000001, botName: 'bot', replyOnlyWhenMentioned: false, acceptPrivate: true,
  sessionMode: 'chat', sessionResumeEnabled: true, quietHours: [], quietHoursEnabled: false,
  notifyEnabled: false, injectEnabled: false, recordInbound: false,
  // 压测要把"随机闸门"关掉，否则大部分消息死在概率上，测到的是骰子不是吞吐
  traceEnabled: false, traceLevel: 'warn', actionAuditEnabled: false,
  adminEnabled: false, rateLimitEnabled: false, floodEnabled: false, filterEnabled: false,
  proactiveEnabled: false, funEnabled: true, diceEnabled: true, fortuneEnabled: false,
  keywordEnabled: false, pointsEnabled: false, statsEnabled: false, checkinEnabled: false,
  gameEnabled: false, reminderEnabled: false, todoEnabled: false, voteEnabled: false,
  summaryEnabled: false, exportEnabled: false, dailyReportEnabled: false, mcStatusEnabled: false,
  imageGenEnabled: false, ttsEnabled: false, sttEnabled: false, voiceReadingEnabled: false,
  verifyEnabled: false, antiRecallEnabled: false, welcomeEnabled: false, pokeEnabled: false,
  autoCollectStickers: false, faceEnabled: false, privateImageView: false,
  fileTransferEnabled: false, agentMediaToolsEnabled: false, memoryEnabled: false,
  provider: 'test', model: 'test',
}

const server = new MockServer()
const bridge = new QQBridge(makeCtx(), { ...Config({}), ...BASE, cwd: root }, server, { info() {}, warn() {}, error() {} })

// 漏一个 unhandledRejection，Node 22 默认直接杀进程：表现是"跑一半没了"，不是"有一条失败"。
process.on('uncaughtException', (error) => stats.fatal.push(`uncaught: ${error?.message ?? error}`))
process.on('unhandledRejection', (error) => stats.fatal.push(`unhandled: ${error?.message ?? error}`))

bridge.start()
await new Promise((r) => setTimeout(r, 60))

let nextId = 0
const nextTag = () => nextId++

function message(tag, extra = {}) {
  return {
    bot: server.socket,
    userId: MEMBERS[tag % MEMBERS.length],
    messageType: 'private',
    text: `压测消息 #${tag}`,
    atMe: false, ats: [], reply: null,
    records: [], images: [], files: [], forwards: [], videos: [],
    messageId: `m-${tag}`,
    senderName: '主人',
    raw: { message: [] },
    ...extra,
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pct = (list, p) => {
  if (list.length === 0) return null
  const s = [...list].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]
}
const rssMb = () => Math.round(process.memoryUsage().rss / 1048576)

/** 等某条消息"到站"（followup 被调用）或超时。 */
async function waitFor(tag, timeoutMs = 20_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (stats.seqDone.has(tag)) return true
    await sleep(1)
  }
  return false
}

/** 等排空：followup + replied 连续 3 次采样不再变化。 */
async function drain(timeoutMs = 120_000) {
  let last = -1
  let stable = 0
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const now = stats.followup + stats.replied
    if (now === last) { stable++; if (stable >= 4) return } else stable = 0
    last = now
    await sleep(50)
  }
}

// ─────────────────────────────── A. 单条服务时间（顺序：发一条、等到站、再发下一条）
// 这才是"这个系统处理一条消息要多久"。突发场景的端到端延迟 ≈ 排队长度 × 这个值，量的是队列不是能力。
{
  // 预热：第一条含建会话/建目录等一次性成本，不能算进分位
  {
    const tag = nextTag()
    emitAt.set(tag, Date.now())
    server.emit('message', message(tag))
    await waitFor(tag)
  }
  stats.latencies.length = 0
  const loop = monitorEventLoopDelay({ resolution: 5 })
  loop.enable()
  for (let i = 0; i < SEQ; i++) {
    const tag = nextTag()
    emitAt.set(tag, Date.now())
    server.emit('message', message(tag))
    const ok = await waitFor(tag)
    if (!ok) { check(`A 第 ${i} 条超时未到站`, false); break }
  }
  loop.disable()
  const p50 = pct(stats.latencies, 0.5)
  const p95 = pct(stats.latencies, 0.95)
  const p99 = pct(stats.latencies, 0.99)
  const avg = Math.round(stats.latencies.reduce((a, b) => a + b, 0) / Math.max(1, stats.latencies.length))

  console.log(`\n=== A 单条服务时间（顺序 ${SEQ} 条，${CHATS} 个会话轮转）===`)
  console.log(`avg=${avg}ms p50=${p50}ms p95=${p95}ms p99=${p99}ms max=${Math.max(...stats.latencies)}ms`)
  console.log(`→ 单会话等效上限约 ${Math.round(1000 / Math.max(1, avg))} 条/秒`)
  console.log(`事件循环滞后 p99=${Math.round(loop.percentile(99) / 1e6)}ms`)

  check('S1 顺序段没有未捕获异常', stats.fatal.length === 0, stats.fatal.slice(0, 3).join(' | '))
  check('S3 ★单条服务时间 p95 < 50ms', (p95 ?? 1e9) < 50, `p95=${p95}ms avg=${avg}ms`)
  check('S4 顺序段事件循环滞后 p99 < 200ms', loop.percentile(99) / 1e6 < 200, `p99=${Math.round(loop.percentile(99) / 1e6)}ms`)
}

// ─────────────────────────────── B. 突发：一次性灌 BURST 条（测队列与守恒，不测"单条能力"）
{
  const rssBefore = rssMb()
  const before = { followup: stats.followup, replied: stats.replied }
  const loop = monitorEventLoopDelay({ resolution: 10 })
  loop.enable()
  const t0 = Date.now()
  let commands = 0
  for (let i = 0; i < BURST; i++) {
    const tag = nextTag()
    emitAt.set(tag, Date.now())
    if (i % 10 === 9) {
      // 本机指令走**真实回包路径**（不带 #标记，否则 `1d6 #5` 解析不成骰子）
      commands++
      server.emit('message', message(tag, { text: '.r 1d6', messageId: `m-${tag}` }))
    } else {
      server.emit('message', message(tag, { messageId: `m-${tag}` }))
    }
  }
  await drain()
  const ms = Date.now() - t0
  loop.disable()
  const rssAfter = rssMb()
  const arrived = stats.followup - before.followup
  const replies = stats.replied - before.replied
  const expectModel = BURST - commands

  console.log(`\n=== B 突发 ${BURST} 条（含 ${commands} 条指令）===`)
  console.log(`排空耗时 ${ms}ms → 有效吞吐 ${Math.round((BURST / ms) * 1000)} 条/秒`)
  console.log(`到模型 ${arrived} 次 · 真实回包 ${replies} 次（期望 ≈ ${expectModel} / ${commands}）`)
  console.log(`事件循环滞后 p99=${Math.round(loop.percentile(99) / 1e6)}ms max=${Math.round(loop.max / 1e6)}ms`)
  console.log(`RSS ${rssBefore}MB → ${rssAfter}MB（+${rssAfter - rssBefore}）`)
  console.log(`吞吐下界判据：> 50 条/秒`)

  check('S1 突发期间没有未捕获异常', stats.fatal.length === 0, stats.fatal.slice(0, 3).join(' | '))
  check('S2 ★没有消息被静默吞掉（到模型 + 回包 = 发出）',
    arrived + replies === BURST, `到模型 ${arrived} + 回包 ${replies} = ${arrived + replies}，发出 ${BURST}`)
  check('S2b 指令条走的是真实回包路径', replies >= commands, `回包 ${replies} ≥ 指令 ${commands}`)
  check('S4 突发期间事件循环滞后 p99 < 200ms', loop.percentile(99) / 1e6 < 200, `p99=${Math.round(loop.percentile(99) / 1e6)}ms`)
  check('S5 突发后 RSS 增量 < 150MB', rssAfter - rssBefore < 150, `+${rssAfter - rssBefore}MB`)
  check('突发吞吐 > 50 条/秒（本机、含磁盘写）', (BURST / ms) * 1000 > 50, `${Math.round((BURST / ms) * 1000)} 条/秒`)
}

// ─────────────────────────────── C. 突发之后还能不能正常说话
{
  const tag = nextTag()
  emitAt.set(tag, Date.now())
  server.emit('message', message(tag))
  const ok = await waitFor(tag, 10_000)
  check('S5b 压测之后进程仍能正常处理新消息', ok, ok ? '正常' : '10 秒内没到站')
}

// ─────────────────────────────── D. 停机不泄漏
{
  bridge.stop()
  await sleep(300)
  check('S6 停机后没有活着的定时器把进程吊住', bridge.timers.size === 0, `timers=${bridge.timers.size}`)
}

console.log(`\n${passed} passed, ${failed} failed`)
try { rmSync(root, { recursive: true, force: true }) } catch {}
process.exit(failed > 0 ? 1 : 0)
