/**
 * 上下文失效（插件被宿主重载）时，旧实例必须**立刻停机**，不许再接消息（2026-11-01）。
 *
 * 真机留过证据（2026-10-28 21:57–22:42，同一个私聊会话 5 条）：
 *   `agent 处理失败：cannot create effect on inactive context`
 *   其中第一条 **ms=520154** —— 报错之前先白等了 520 秒。
 *
 * 成因：宿主重载插件时，旧实例手里那条消息还在回合一里；等回合走到
 * `ctx.agents.create()` / `ctx.get(...)`，ctx 早被 dispose，于是必然抛。
 * 更糟的是旧实例还攥着 OneBot 的 WS 连接 —— 新实例反而 `EADDRINUSE` 绑不上端口，
 * 现场看到的就是「发消息没人回」，而两个实例都活着。
 *
 * 判据用 cordis 自己的字段（`@deepseek-ai/cordis` 的 Fiber：`null once disposed`）：
 * `ctx.fiber.uid === null` ⇒ 这个插件实例已经销毁。
 *
 * 这个文件钉四件事：
 *   ① uid === null → 消息不进回合、bridge 自停、trace 留一条 lifecycle  ← 旧版会红
 *   ② uid 是数字（活的）→ 照常处理（不能被这条检查误伤）
 *   ③ ctx 上根本没有 `fiber`（别的宿主实现）→ 当作活着，**不猜**
 *   ④ 只停一次，不刷屏
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

const dir = mkdtempSync(join(tmpdir(), 'qq-inactive-ctx-'))

class MockServer extends EventEmitter {
  constructor() {
    super()
    this.sent = []
    this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }
  }
  currentSocket() { return this.socket }
  async getImage() { throw new Error('no image in mock') }
  async getRecord() { throw new Error('no record in mock') }
  async getFile() { throw new Error('no file in mock') }
  async getMsg() { throw new Error('no msg in mock') }
  async sendGroupMsg(params) { this.sent.push({ kind: 'group', params }); return { message_id: 1 } }
  async sendPrivateMsg(params) { this.sent.push({ kind: 'private', params }); return { message_id: 1 } }
  async sendMsg(params) { this.sent.push({ kind: 'unknown', params }); return { message_id: 1 } }
  async getLoginInfo() { return { user_id: 999, nickname: '小鲸鱼' } }
  async getGroupMemberInfo() { return { card: '', nickname: '小鲸鱼' } }
  async getStatus() { return { online: true, good: true } }
  async getVersionInfo() { return { app_name: 'mock', app_version: '0' } }
  async canSendImage() { return { yes: true } }
  async canSendRecord() { return { yes: true } }
}

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

/**
 * @param {{fiber: undefined | null | {uid: number|null}}} world
 *   `fiber: undefined` ⇒ ctx 上没有这个字段（模拟别的宿主实现）
 */
function makeBridge(ctxShape = { fiber: { uid: 7 } }) {
  const server = new MockServer()
  const turns = []
  const warns = []
  let seq = 0
  let createCalls = 0

  const agentCtx = {
    tools: { register: (tool) => tool },
    systemPrompt: { section: (section) => section },
  }
  const newHandle = (sessionId) => {
    const id = String(sessionId || `qq-ctx-${++seq}`)
    const agent = {
      id,
      status: 'idle',
      followup(message) {
        const blocks = Array.isArray(message?.content) ? message.content : []
        const text = blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('')
        turns.push({ sessionId: id, text })
        return Promise.resolve()
      },
      cancel() {},
    }
    return { agent, sessionId: id, dispose: async () => {} }
  }

  const ctx = {
    on: () => () => {},
    get: () => undefined,
    agents: {
      create: async ({ sessionId }) => { createCalls += 1; return newHandle(sessionId) },
      resume: async ({ resumeSessionId }) => { createCalls += 1; return newHandle(resumeSessionId) },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    logger: () => ({ info() {}, warn() {}, error() {} }),
  }
  if (ctxShape.fiber !== undefined) ctx.fiber = ctxShape.fiber

  const config = { ...Config({}), ...QUIET_BASE }
  const logger = {
    info() {},
    warn(message) { warns.push(String(message)) },
    error() {},
  }
  const bridge = new QQBridge(ctx, config, server, logger)
  bridge.start()

  let seqMsgId = 0
  function message(text, extra = {}) {
    return {
      bot: server.socket,
      userId: 1001,
      messageType: 'private',
      text,
      atMe: false,
      ats: [],
      reply: null,
      records: [],
      images: [],
      files: [],
      forwards: [],
      videos: [],
      messageId: `m${++seqMsgId}`,
      senderName: '小明',
      raw: { message: [] },
      ...extra,
    }
  }

  async function send(msg, { waitMs = 2000 } = {}) {
    await new Promise((resolve) => setTimeout(resolve, 120))
    const before = turns.length
    server.emit('message', msg)
    const deadline = Date.now() + waitMs
    while (turns.length === before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      if (bridge.stopped) break
    }
    await new Promise((resolve) => setTimeout(resolve, 120))
  }

  return {
    bridge,
    server,
    turns,
    warns,
    message,
    send,
    lifecycle: () => bridge.trace.recent({ limit: 5000, stage: 'lifecycle' }),
    createCalls: () => createCalls,
    stop: () => bridge.stop(),
  }
}

async function main() {
  // ---- ① 上下文已 dispose：不许进回合，且自行停机 ----
  {
    const world = makeBridge({ fiber: { uid: null } })
    await world.send(world.message('在吗'))
    check('uid=null 时这条消息没有进 agent', world.turns.length === 0, `turns=${world.turns.length}`)
    check('uid=null 时根本没有去建会话', world.createCalls() === 0, `create=${world.createCalls()}`)
    check('uid=null 时桥自己停了（端口交还新实例）', world.bridge.stopped === true, `stopped=${world.bridge.stopped}`)
    const lifecycle = world.lifecycle()
    check('trace 里留了一条能读懂的 lifecycle 记录', lifecycle.length === 1 && /上下文已失效/.test(String(lifecycle[0]?.reason ?? '')),
      JSON.stringify(lifecycle.map((row) => row.reason ?? '').slice(0, 2)))
    check('logger.warn 也说人话了（不是裸错误码）', world.warns.some((line) => /上下文已失效/.test(line)),
      JSON.stringify(world.warns.slice(0, 2)))
    world.stop()
  }

  // ---- ② 反向对照：活的 fiber 必须照常处理（不误伤）----
  {
    const world = makeBridge({ fiber: { uid: 7 } })
    await world.send(world.message('在吗'))
    check('uid=7（活的）时消息照常进 agent', world.turns.length === 1, `turns=${world.turns.length}`)
    check('uid=7 时桥没有停', world.bridge.stopped === false, `stopped=${world.bridge.stopped}`)
    check('uid=7 时没有 lifecycle 记录', world.lifecycle().length === 0, `n=${world.lifecycle().length}`)
    world.stop()
  }

  // ---- ③ 宿主没有 fiber 字段：不猜，当它活着 ----
  {
    const world = makeBridge({ fiber: undefined })
    await world.send(world.message('在吗'))
    check('ctx 没有 fiber 时照常处理（不猜）', world.turns.length === 1, `turns=${world.turns.length}`)
    check('ctx 没有 fiber 时桥没有停', world.bridge.stopped === false, `stopped=${world.bridge.stopped}`)
    world.stop()
  }

  // ---- ④ 幂等：只停一次、只记一条，不刷屏 ----
  {
    const world = makeBridge({ fiber: { uid: null } })
    await world.send(world.message('第一条'))
    await world.send(world.message('第二条'), { waitMs: 300 })
    check('失效实例只写一条 lifecycle（不刷屏）', world.lifecycle().length === 1, `n=${world.lifecycle().length}`)
    check('第二条同样没有进 agent', world.turns.length === 0, `turns=${world.turns.length}`)
    world.stop()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1 })
  .finally(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
