/**
 * 鲁棒性测试（fuzz / robustness）—— 2026-11-02 夜。
 *
 * 前两类回答"快不快、稳不稳"，这一类回答"**喂垃圾会不会死**"。
 * 真实 QQ 上会遇到的垃圾都是有来源的：别人发一条 120KB 的粘贴、群名片里塞 NUL、
 * 转发卡片缺字段、后端版本升级后某个段少一个键、自己发的消息被回推导致重复 id。
 * 这些**不会**在正常测试里出现，但它们在真机上只需要一次就能让进程没了。
 *
 * ── 判据（跑之前写死）──────────────────────────────────────────
 *   F1 `parseMessage` 面对任何畸形输入都返回对象（不抛、不返回 undefined）
 *   F2 桥面对任何畸形消息都不产生 uncaughtException / unhandledRejection
 *   F3 每一轮畸形之后，发一条正常消息仍然能到模型（不是"默默死了"）
 *   F4 超长文本被截断处理，且单条处理时间 < 2s（不许卡死事件循环）
 *   F5 重复 messageId 被去重，但**不连累**后面的正常消息
 *   F6 全流程结束后仍能停机、定时器清空
 *
 * 用法：`node test/fuzz-unit.mjs`
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QQBridge } from '../lib/bridge.js'
import { Config } from '../lib/index.js'
import { parseMessage } from '../lib/onebot.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const root = mkdtempSync(join(tmpdir(), 'qq-fuzz-'))
const stats = { followup: 0, fatal: [] }
const done = new Set()

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
          stats.followup++
          const blocks = Array.isArray(message?.content) ? message.content : []
          const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('')
          const hit = /#(\d+)/.exec(text)
          if (hit) done.add(Number(hit[1]))
          return Promise.resolve()
        },
        cancel() {},
      },
      sessionId: String(sessionId), dispose: async () => {},
    }),
    resume: async ({ resumeSessionId }) => ({
      agent: { id: String(resumeSessionId), status: 'idle', followup: () => { stats.followup++; return Promise.resolve() }, cancel() {} },
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
  notifyEnabled: false, injectEnabled: false, recordInbound: false, traceEnabled: false,
  proactiveEnabled: false, adminEnabled: false, rateLimitEnabled: false, filterEnabled: false,
  forwardMaxNodes: 30, forwardMaxChars: 2000,
  provider: 'test', model: 'test',
}

const server = new MockServer()
const bridge = new QQBridge(ctx, { ...Config({}), ...BASE, cwd: root }, server, { info() {}, warn() {}, error() {} })
process.on('uncaughtException', (error) => stats.fatal.push(`uncaught: ${error?.message ?? error}`))
process.on('unhandledRejection', (error) => stats.fatal.push(`unhandled: ${error?.message ?? error}`))
bridge.start()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 畸形原始帧：直接喂 parseMessage。 */
const BAD_FRAMES = [
  ['null', null],
  ['undefined', undefined],
  ['字符串', 'not-an-array'],
  ['数字', 42],
  ['空数组', []],
  ['元素是 null', [null, null]],
  ['元素是数字', [1, 2, 3]],
  ['text 无 data', [{ type: 'text' }]],
  ['text 的 data 是 null', [{ type: 'text', data: null }]],
  ['text 是对象', [{ type: 'text', data: { text: { a: 1 } } }]],
  ['image 无 url', [{ type: 'image', data: {} }]],
  ['at 的 qq 非数字', [{ type: 'at', data: { qq: 'abc' } }]],
  ['forward 无 id', [{ type: 'forward', data: {} }]],
  ['forward 的 data 是 null', [{ type: 'forward', data: null }]],
  ['reply 缺字段', [{ type: 'reply', data: {} }]],
  ['face 无 id', [{ type: 'face', data: {} }]],
  ['未知段类型', [{ type: 'weird-new-type', data: { x: 1 } }]],
  ['段里带 NUL', [{ type: 'text', data: { text: 'a\u0000b' } }]],
  ['孤立代理对', [{ type: 'text', data: { text: '\uD800' } }]],
  ['1MB 文本', [{ type: 'text', data: { text: 'x'.repeat(1024 * 1024) } }]],
  ['嵌套 500 层数组', (() => { let v = [{ type: 'text', data: { text: 'deep' } }]; for (let i = 0; i < 500; i++) v = [v]; return v })()],
]

{
  let okCount = 0
  for (const [label, frame] of BAD_FRAMES) {
    try {
      const out = parseMessage(frame, 3000000001)
      if (out && typeof out === 'object' && typeof out.text === 'string' && Array.isArray(out.forwards)) okCount++
      else { console.log(`  ✗ ${label} 返回形状不对：`, JSON.stringify(out)?.slice(0, 80)) }
    } catch (error) {
      console.log(`  ✗ ${label} 抛了：${error.message}`)
    }
  }
  check('F1 ★parseMessage 面对全部畸形帧都返回合法对象', okCount === BAD_FRAMES.length, `${okCount}/${BAD_FRAMES.length}`)
}

/** 畸形入站消息：直接喂桥（这是后端解析完之后的那一层）。 */
const tag = { n: 9000 }

function badMessage(overrides) {
  return {
    bot: server.socket,
    userId: 2000000001,
    messageType: 'private',
    text: '',
    atMe: false, ats: [], reply: null,
    records: [], images: [], files: [], forwards: [], videos: [],
    messageId: `fz-${++tag.n}`,
    senderName: '主人',
    raw: { message: [] },
    ...overrides,
  }
}

const BAD_MESSAGES = [
  ['userId 是 NaN', { userId: Number.NaN }],
  ['userId 是负数', { userId: -1 }],
  ['userId 是字符串', { userId: '2000000001' }],
  ['userId 是对象', { userId: { evil: true } }],
  ['userId 是 Infinity', { userId: Number.POSITIVE_INFINITY }],
  ['messageType 未知', { messageType: 'channel' }],
  ['groupId 是 null', { messageType: 'group', groupId: null }],
  ['text 是 null', { text: null }],
  ['text 是对象', { text: { a: 1 } }],
  ['text 带 NUL', { text: 'a\u0000b\u0000c' }],
  ['ats 不是数组', { ats: 'not-array' }],
  ['forwards 元素是 null', { forwards: [null, 1, 'x'] }],
  ['forwards 里 forward 缺 id', { forwards: [{ msgId: 'M1' }] }],
  ['images 元素是 null', { images: [null, 1] }],
  ['reply 是字符串', { reply: 'reply' }],
  ['reply 是缺字段的对象', { reply: {} }],
  ['records 元素缺 path', { records: [{ file: '' }] }],
  ['senderName 100KB', { senderName: '名'.repeat(50_000) }],
  ['messageId 为空', { messageId: '' }],
  ['message 整个是空对象', {}],
]

{
  for (const [label, overrides] of BAD_MESSAGES) {
    try {
      server.emit('message', badMessage(overrides))
    } catch (error) {
      stats.fatal.push(`emit(${label}): ${error.message}`)
    }
  }
  // 超大文本单独测耗时（F4）
  const big = 'y'.repeat(120 * 1024)
  const t0 = Date.now()
  server.emit('message', badMessage({ text: big, messageId: `fz-big-${Date.now()}` }))
  await sleep(50)
  const ms = Date.now() - t0
  await sleep(600)

  check('F2 ★畸形消息没有引发未捕获异常', stats.fatal.length === 0, stats.fatal.slice(0, 3).join(' | '))
  check('F4 120KB 文本不卡死（单条 < 2s）', ms < 2000, `${ms}ms`)

  // F3：畸形之后还能不能正常干活
  const before = stats.followup
  const probeTag = 9999
  server.emit('message', badMessage({ text: `正常探针 #${probeTag}`, messageId: 'fz-probe-ok' }))
  let ok = false
  for (let i = 0; i < 100; i++) {
    if (stats.followup > before || done.has(probeTag)) { ok = true; break }
    await sleep(50)
  }
  check('F3 ★畸形消息之后仍能正常处理新消息', ok, `${before} → ${stats.followup}`)
}

// F5：重复 messageId 去重，但不连累后续
{
  const dup = { messageId: `fz-dup-${Date.now()}`, text: '重复消息' }
  const before = stats.followup
  server.emit('message', badMessage({ ...dup }))
  await sleep(200)
  const afterFirst = stats.followup
  server.emit('message', badMessage({ ...dup, text: '重复消息（第二次）' }))
  await sleep(200)
  const afterSecond = stats.followup
  check('F5 重复 messageId 被去重（第二条不再进模型）', afterSecond === afterFirst, `${before} → ${afterFirst} → ${afterSecond}`)

  const beforeProbe = stats.followup
  server.emit('message', badMessage({ text: '去重之后的探针', messageId: `fz-after-dup-${Date.now()}` }))
  await sleep(400)
  check('F5b 去重不连累后面的正常消息', stats.followup > beforeProbe, `${beforeProbe} → ${stats.followup}`)
}

// F6：停机
{
  bridge.stop()
  await sleep(300)
  check('F6 全流程之后能正常停机（定时器清空）', bridge.timers.size === 0, `timers=${bridge.timers.size}`)
}

console.log(`\n${passed} passed, ${failed} failed`)
try { rmSync(root, { recursive: true, force: true }) } catch {}
process.exit(failed > 0 ? 1 : 0)
