/**
 * 群聊纯图片消息不该被整条丢掉（2026-11-01）。
 *
 * 复现的是这样一条真机消息：群里 @ 她、只发一张图、不打字。
 * `bridge.js` 的空文本门里，视频写的是 `(private || atMe)`，图片写的是 `private` ——
 * 于是同一条消息，视频能进、图片被 drop。真机 trace 留了证：
 *   g:100000001 / g:100000002 都是 `images=有` 仍然 drop。
 *
 * 这个文件同时钉两件事：
 *   ① 群聊 + @ + 纯图  → 必须进 agent（修复点）
 *   ② 群聊 + 没 @ + 纯图 → 必须仍然丢弃（**反向对照**，防止"顺手把所有群图都放进来"）
 *
 * ② 不是凑数：一个只会变绿、不会变红的判据没有分辨力（纪律 112）。
 * 如果哪天有人把 @ 门拆了，② 会立刻报红。
 *
 * No DSH host, no network, no model call.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QQBridge } from '../lib/bridge.js'
import { Config } from '../lib/index.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const dir = mkdtempSync(join(tmpdir(), 'qq-group-image-'))

class MockServer extends EventEmitter {
  constructor() {
    super()
    this.sent = []
    this.calls = []
    this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }
  }
  currentSocket() { return this.socket }
  reset() { this.calls.length = 0; this.sent.length = 0 }
  count(action) { return this.calls.filter((call) => call.action === action).length }

  // 所有 media 相关动作一律"没有"：这个套件只关心"消息有没有被送进 agent"，
  // 不关心图片能不能下下来。下载失败是 fail-soft 的，不该阻断回合。
  async getImage() { throw new Error('no image in mock') }
  async getRecord() { throw new Error('no record in mock') }
  async getFile() { throw new Error('no file in mock') }
  async getMsg() { throw new Error('no msg in mock') }
  async sendGroupMsg(params) { this.sent.push({ kind: 'group', params }); return { message_id: 1 } }
  async sendPrivateMsg(params) { this.sent.push({ kind: 'private', params }); return { message_id: 1 } }
  async sendMsg(params) { this.sent.push({ kind: 'unknown', params }); return { message_id: 1 } }
  async getLoginInfo() { return { user_id: 999, nickname: '小鲸鱼' } }
  async getGroupMemberInfo() { return { card: '', nickname: '小鲸鱼' } }
  // 桥可能探测这些能力；缺了就当作不支持，让代码走"不支持"分支。
  async getStatus() { return { online: true, good: true } }
  async getVersionInfo() { return { app_name: 'mock', app_version: '0' } }
  async canSendImage() { return { yes: true } }
  async canSendRecord() { return { yes: true } }
}

/**
 * 底座照抄 test/seeing-unit.mjs 的 QUIET_BASE：只有把无关的 pack 全部关掉，
 * 才能保证"进了 agent"这件事只可能由图片那一路造成，而不是被别的功能顺手吃掉。
 * 唯一与本套件相关的差异：privateImageView 显式打开（默认也是 true）。
 */
const QUIET_BASE = {
  cwd: dir,
  host: '127.0.0.1',
  port: 0,
  accessToken: '',
  allowUsers: [1001],
  allowGroups: [2002],
  botQq: 999,
  botName: '小鲸鱼',
  replyOnlyWhenMentioned: true,
  acceptPrivate: true,
  sessionMode: 'chat',
  sessionResumeEnabled: false,
  quietHours: [],
  quietHoursEnabled: false,
  notifyEnabled: false,
  injectEnabled: false,
  recordInbound: false,
  traceEnabled: true,
  traceLevel: 'debug',
  traceMemorySize: 500,
  actionAuditEnabled: false,
  adminEnabled: true,
  adminUsers: [1001],
  keywordEnabled: false,
  fortuneEnabled: false,
  diceEnabled: false,
  pointsEnabled: false,
  statsEnabled: false,
  checkinEnabled: false,
  gameEnabled: false,
  reminderEnabled: false,
  recurringReminderEnabled: false,
  todoEnabled: false,
  voteEnabled: false,
  summaryEnabled: false,
  exportEnabled: false,
  dailyReportEnabled: false,
  mcStatusEnabled: false,
  imageGenEnabled: false,
  ttsEnabled: false,
  sttEnabled: false,
  voiceReadingEnabled: false,
  verifyEnabled: false,
  filterEnabled: false,
  floodEnabled: false,
  antiRecallEnabled: false,
  welcomeEnabled: false,
  pokeEnabled: false,
  autoCollectStickers: false,
  faceEnabled: false,
  privateImageView: true,
  groupImageView: true,
  fileTransferEnabled: false,
  agentMediaToolsEnabled: false,
  memoryEnabled: false,
  rateLimitEnabled: false,
}

function makeBridge(overrides = {}) {
  const server = new MockServer()
  const turns = []
  let seq = 0

  const makeCtx = () => {
    const agentCtx = {
      tools: { register: (tool) => tool },
      systemPrompt: { section: (section) => section },
    }
    const newHandle = (sessionId, setup) => {
      const id = String(sessionId || `qq-gimg-${++seq}`)
      if (typeof setup === 'function') setup(agentCtx)
      const agent = {
        id,
        status: 'idle',
        followup(message) {
          const blocks = Array.isArray(message?.content) ? message.content : []
          const text = blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('')
          turns.push({ sessionId: id, text, blocks })
          return Promise.resolve()
        },
        cancel() {},
      }
      return { agent, sessionId: id, dispose: async () => {} }
    }
    return {
      on: () => () => {},
      get: () => undefined,
      agents: {
        create: async ({ sessionId, setup }) => newHandle(sessionId, setup),
        resume: async ({ resumeSessionId, setup }) => newHandle(resumeSessionId, setup),
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
      logger: () => ({ info() {}, warn() {}, error() {} }),
    }
  }

  const config = { ...Config({}), ...QUIET_BASE, ...overrides }
  const logger = { info() {}, warn() {}, error() {} }
  const bridge = new QQBridge(makeCtx(), config, server, logger)
  bridge.start()

  let seqMsgId = 0
  function message(text, extra = {}) {
    return {
      bot: server.socket,
      userId: 1001,
      messageType: 'group',
      groupId: 2002,
      text,
      atMe: true,
      ats: [],
      reply: null,
      records: [],
      images: [],
      files: [],
      forwards: [],
      videos: [],
      messageId: `g${++seqMsgId}`,
      senderName: '小明',
      raw: { message: [] },
      ...extra,
    }
  }

  /**
   * 投递一条消息并等到"该发生的都发生了"。
   *
   * 原来这里是 `emit` + 固定 60ms。这个等待是**假的**：图片那条路要走
   * 出网尝试 → 失败降级 → 建会话 → 转交 agent，60ms 根本不够，
   * 于是断言永远看到空 turn，测试红了却和被测代码无关（第一版就是被这个坑住的）。
   *
   * 改成按目标轮询：
   *   · expectTurn=true  → 等 turns 真的多出一条（最多 3s）
   *   · expectTurn=false → 等固定 400ms（足够走完 drop 判定），再确认没有新 turn
   */
  async function send(msg, { expectTurn = true, waitMs = 3000, settleMs = 400 } = {}) {
    // bridge.start() 是异步的：监听器没挂上就 emit，消息会被直接丢掉（不是丢弃分支，是没人接）。
    await new Promise((resolve) => setTimeout(resolve, 120))
    const before = turns.length
    server.emit('message', msg)
    if (!expectTurn) {
      await new Promise((resolve) => setTimeout(resolve, settleMs))
      return
    }
    const deadline = Date.now() + waitMs
    while (turns.length === before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    // trace 是同步写的，这里只让出一次事件循环，让排在前面的 pending 任务收尾。
    await new Promise((resolve) => setTimeout(resolve, 40))
  }

  const lastTurn = () => turns.at(-1)?.text ?? ''
  const dropped = () => bridge.trace.recent({ limit: 5000, stage: 'drop' })

  return { bridge, server, config, turns, lastTurn, dropped, message, send, stop: () => bridge.stop() }
}

/** 一条只有图片、没有文字的消息。 */
const imageOnly = (extra = {}) => ({
  text: '',
  images: [{ kind: 'image', url: 'https://example.invalid/a.jpg', file: 'A.jpg', path: '', fileId: '' }],
  ...extra,
})

async function main() {
  // ---- ① 群聊 + @ + 纯图：必须进 agent（修复点）----
  {
    const world = makeBridge()
    await world.send(world.message('', imageOnly({ atMe: true })))
    const text = world.lastTurn()
    check('群聊 @ + 纯图 不再被丢弃（agent 收到了一个回合）', text !== '', `turn=${JSON.stringify(text.slice(0, 80))}`)
    check('群里那张图被点名要她看', /图片|动画表情/.test(text), `turn=${JSON.stringify(text.slice(0, 80))}`)
    // trace 里不该同时留一条 drop 记录 —— 那会说明有两条路径在打架。
    check('没有留下 drop 记录', world.dropped().length === 0,
      JSON.stringify(world.dropped().map((row) => row.reason ?? row.detail ?? '').slice(0, 2)))
    world.stop()
  }

  // ---- ② 反向对照：群聊 + 没 @ + 纯图：必须仍然丢弃 ----
  {
    const world = makeBridge()
    await world.send(world.message('', imageOnly({ atMe: false })), { expectTurn: false })
    check('群聊未 @ + 纯图 仍然被丢弃（@ 门还在）', world.lastTurn() === '', `turn=${JSON.stringify(world.lastTurn())}`)
    check('丢弃理由进了 trace', world.dropped().length > 0, `n=${world.dropped().length}`)
    world.stop()
  }

  // ---- ③ 私聊纯图：原有行为不能回归 ----
  {
    const world = makeBridge()
    await world.send(world.message('', imageOnly({ messageType: 'private', groupId: undefined, atMe: false })))
    check('私聊纯图仍然进 agent（私聊那一路没被改坏）', world.lastTurn() !== '', `turn=${JSON.stringify(world.lastTurn().slice(0, 60))}`)
    world.stop()
  }

  // ---- ④ 开关能单独关掉群那一侧 ----
  {
    const world = makeBridge({ groupImageView: false })
    await world.send(world.message('', imageOnly({ atMe: true })), { expectTurn: false })
    check('groupImageView=false 时群里纯图被丢弃（开关有效）', world.lastTurn() === '', `turn=${JSON.stringify(world.lastTurn())}`)
    world.stop()
  }

  // ---- ⑤ 私聊开关不影响群（两个开关真的独立）----
  {
    const world = makeBridge({ privateImageView: false, groupImageView: true })
    await world.send(world.message('', imageOnly({ atMe: true })))
    check('privateImageView=false 不影响群聊', world.lastTurn() !== '', `turn=${JSON.stringify(world.lastTurn().slice(0, 60))}`)
    world.stop()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1 })
  .finally(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
