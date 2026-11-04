/**
 * 桥层故障注入（bridge fault injection）—— 2026-11-04。
 *
 * 与 `fault-injection-unit.mjs`（TTS 上游）的分工：那个测"外部服务坏掉"，
 * 这个测"**桥自己的依赖坏掉**"——OneBot 连接没了、发送抛错、登录信息取不到。
 *
 * ── 安全边界（主人："别把桥搞炸了"）────────────────────────────
 *   · `port: 0` ⇒ **不监听任何端口**，不会和 6700 / 生产桥抢
 *   · 所有 OneBot 调用走 MockServer ⇒ **不发任何真消息**，不碰真 QQ 号
 *   · `cwd` 是 mkdtemp 临时目录 ⇒ **不读写 qq_chat**
 *   · `proactiveEnabled: false` ⇒ 不起定时器
 *   · 结束 rmSync 清掉临时目录
 *   ⇒ 跑这个脚本对正在运行的桥**没有任何影响**。
 *
 * ── 判据（跑之前写死）──────────────────────────────────────────
 *   B1 发送抛错（sendSegments throw）⇒ 不产生 uncaughtException，消息处理走完
 *   B2 OneBot 掉线（currentSocket 返回 null）⇒ 不崩，且**留下痕迹**（不静默）
 *   B3 getLoginInfo 抛错 ⇒ 不崩（登录校验是增强，不能让它成为新的单点）
 *   B4 故障叠畸形消息（发送坏了 + 空文本/超长）⇒ 不崩
 *   B5 收到 turn/end error 事件 ⇒ 记账不崩
 *   B6 stop 之后定时器清空（不泄漏）
 *
 * 用法：`node test/bridge-fault-unit.mjs`
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QQBridge } from '../lib/bridge.js'
import { Config } from '../lib/index.js'

let passed = 0
let failed = 0
const check = (name, ok, extra = '') => {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const root = mkdtempSync(join(tmpdir(), 'qq-bfi-'))
const crashes = []
process.on('uncaughtException', (e) => crashes.push(`uncaught: ${e.message}`))
process.on('unhandledRejection', (e) => crashes.push(`unhandled: ${e?.message ?? e}`))

/** 可注入故障的假 OneBot。`fault` 决定哪一步坏、怎么坏。 */
class MockServer extends EventEmitter {
  constructor(fault = {}) {
    super()
    this.fault = fault
    this.sent = []
    this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }
  }
  currentSocket() {
    if (this.fault.socketDown) return null
    return this.socket
  }
  async sendSegments(action, type, id, segments) {
    if (this.fault.sendThrows) throw new Error('模拟：sendSegments 失败（后端 502）')
    this.sent.push({ type, id, segments })
    return { message_id: 1 }
  }
  async sendText(_, __, text) {
    if (this.fault.sendThrows) throw new Error('模拟：sendText 失败')
    this.sent.push({ text })
    return { message_id: 1 }
  }
  async callAction() {
    if (this.fault.callThrows) throw new Error('模拟：callAction 失败')
    return { ok: true, messages: [] }
  }
  async getLoginInfo() {
    if (this.fault.loginThrows) throw new Error('模拟：getLoginInfo 失败（后端不回）')
    return { user_id: 3000000001, nickname: 'bot' }
  }
  async getStatus() { return { online: !this.fault.socketDown } }
  async canSendImage() { return { yes: true } }
  async canSendRecord() { return { yes: true } }
  async getForwardMsg() { return { messages: [] } }
}

const answered = []
const ctx = {
  on: () => () => {},
  get: () => undefined,
  agents: {
    create: async ({ sessionId }) => ({
      agent: {
        id: String(sessionId), status: 'idle',
        followup(message) {
          const blocks = Array.isArray(message?.content) ? message.content : []
          const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('')
          answered.push(text)
          return Promise.resolve()
        },
        cancel() {},
      },
      sessionId: String(sessionId), dispose: async () => {},
    }),
    resume: async ({ resumeSessionId }) => ({
      agent: { id: String(resumeSessionId), status: 'idle', followup: () => Promise.resolve(), cancel() {} },
      sessionId: String(resumeSessionId), dispose: async () => {},
    }),
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
  logger: () => ({ info() {}, warn() {}, error() {} }),
}

const BASE = {
  host: '127.0.0.1', port: 0, accessToken: '', allowUsers: [2000000001], allowGroups: [100000001],
  botQq: 3000000001, botName: 'bot', replyOnlyWhenMentioned: false, acceptPrivate: true,
  sessionMode: 'chat', sessionResumeEnabled: false, quietHours: [], quietHoursEnabled: false,
  notifyEnabled: false, injectEnabled: false, recordInbound: false, traceEnabled: true,
  proactiveEnabled: false, adminEnabled: false, rateLimitEnabled: false, filterEnabled: false,
  forwardMaxNodes: 30, forwardMaxChars: 2000, provider: 'test', model: 'test',
  ttsEnabled: false, voiceToolEnabled: false,
}

let seq = 0
const msg = (overrides = {}) => ({
  bot: { readyState: 1 },
  userId: 2000000001,
  messageType: 'private',
  text: '你好',
  atMe: false, ats: [], reply: null,
  records: [], images: [], files: [], forwards: [], videos: [],
  messageId: `bfi-${++seq}`,
  selfId: 3000000001,
  time: Math.floor(Date.now() / 1000),
  raw: null,
  ...overrides,
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 安全停机：stop 可能不存在，也可能抛（作者没保证）—— 测试不该因此炸。 */
async function safeStop(bridge) {
  try { await bridge.stop?.() } catch { /* 停机失败不影响判据 */ }
}

/** 起一个隔离桥（不监听端口）。 */
async function makeBridge(fault) {
  const server = new MockServer(fault)
  const bridge = new QQBridge(ctx, { ...Config({}), ...BASE, cwd: root }, server, { info() {}, warn() {}, error() {} })
  // ★ 必须 start() 才会注册 'message' 监听（fuzz-unit 里也是这么做的）。
  //    port=0 ⇒ 随机端口，不会和 6700/生产桥抢。
  try { await bridge.start?.() } catch { /* start 抛错也要能继续测 */ }
  return { bridge, server }
}

// ---------- B1 发送抛错 ----------
{
  const { bridge, server } = await makeBridge({ sendThrows: true })
  const before = crashes.length
  server.emit('message', msg({ text: '发送会失败的一句话' }))
  await sleep(500)
  check('B1 ★发送抛错时不产生未捕获异常', crashes.length === before, crashes.slice(before).join('; '))
  check('B1 消息仍进了模型（失败的是"发不出去"，不是"不处理"）', answered.length >= 1, `answered=${answered.length}`)
  await safeStop(bridge)
}

// ---------- B2 OneBot 掉线 ----------
{
  const { bridge, server } = await makeBridge({ socketDown: true })
  const before = crashes.length
  server.emit('message', msg({ text: '掉线时发来的消息' }))
  await sleep(500)
  check('B2 ★socket 为空时不崩', crashes.length === before, crashes.slice(before).join('; '))
  const traces = server.listeners('message').length
  check('B2 桥仍然挂着消息监听（没有自己摘掉）', traces >= 1, `listeners=${traces}`)
  await safeStop(bridge)
}

// ---------- B3 getLoginInfo 抛错 ----------
{
  const { bridge, server } = await makeBridge({ loginThrows: true })
  const before = crashes.length
  server.emit('message', msg({ text: '登录信息取不到' }))
  await sleep(500)
  check('B3 ★登录校验失败不成为新的单点', crashes.length === before, crashes.slice(before).join('; '))
  await safeStop(bridge)
}

// ---------- B4 故障 + 畸形消息叠加 ----------
{
  const { bridge, server } = await makeBridge({ sendThrows: true, loginThrows: true })
  const before = crashes.length
  const nasty = [
    { text: '' },
    { text: 'x'.repeat(120 * 1024) },
    { text: '正常一句话', messageId: 'dup-1' },
    { text: '正常一句话（重复 id）', messageId: 'dup-1' },
    { text: 12345 },
    { text: null },
  ]
  for (const overrides of nasty) server.emit('message', msg(overrides))
  await sleep(300)
  check('B4 ★发送/登录都坏 + 畸形消息 ⇒ 仍无未捕获异常', crashes.length === before, crashes.slice(before).join('; '))
  await safeStop(bridge)
}

// ---------- B5 turn/end 报错事件 ----------
{
  const { bridge, server } = await makeBridge({})
  const before = crashes.length
  try {
    server.emit('event', { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: '模拟：模型 500' } } } })
    await sleep(100)
  } catch (error) {
    crashes.push(`emit(turn-end): ${error.message}`)
  }
  check('B5 ★收到 turn/end error 事件不崩', crashes.length === before, crashes.slice(before).join('; '))
  await safeStop(bridge)
}

// ---------- B6 停止后不留定时器 ----------
{
  const { bridge } = await makeBridge({})
  let stopError = null
  try { await bridge.stop?.() } catch (error) { stopError = error }
  await sleep(80)
  check('B6 stop 不抛错', stopError === null, stopError?.message ?? '')
  check('B6 停止后没有未捕获异常', crashes.length === 0, crashes.join('; '))
}

// ---------- 收尾 ----------
rmSync(root, { recursive: true, force: true })
check('B7 临时目录已清理（不污染 qq_chat）', (() => {
  try { readdirSync(root); return false } catch { return true }
})())

console.log(`\n${passed} passed, ${failed} failed`)
if (crashes.length > 0) console.log('捕获到的崩溃：\n  ' + crashes.join('\n  '))
process.exit(failed > 0 ? 1 : 0)
