/**
 * 入站 trace 必须能回答「这条到底 @ 没 @ 她」（2026-11-01）。
 *
 * 起因是一次**自己猜错**的审计：真机 trace 里两条
 *   `空文本且无可用媒体（… images=有 …）`
 * 被我判成"群图链路坏了"，还据此改宽了群图的豁免条件（那次改动本身没坏处）。
 * 但回头核对时发现：`inbound` 那一行**只记了 text，没有 atMe** —— 于是
 *   「群图被丢」和「没 @ 她、本来就该丢」
 * 两种解释都成立，结论只能靠猜。这正是纪律 114 那种「兜底 return 的名字会说谎」：
 * 理由是 `无可用媒体`，真实原因可能是 `未 @`。
 *
 * 这个文件钉四件事：
 *   ① `trace.start` 把 atMe 记进 inbound 行（三态：true / false / 未知 null）
 *   ② 群聊未 @ 的纯图 → 记 `mention`（门禁），**不是** `drop`（能力）  ← 旧版会红
 *   ③ 群聊 @ 的纯图 → 照旧进 agent，且不留 drop（反向对照，防"把 @ 门拆了"）
 *   ④ drop 的理由里带 `at=` —— 下次审计不用再猜
 *
 * No DSH host, no network, no model call.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QQBridge } from '../lib/bridge.js'
import { Config } from '../lib/index.js'
import { TraceRecorder } from '../lib/trace.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const dir = mkdtempSync(join(tmpdir(), 'qq-inbound-at-'))

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

/** 同 test/group-image-unit.mjs 的 QUIET_BASE：无关功能全部关掉，只留 trace。 */
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
      const id = String(sessionId || `qq-at-${++seq}`)
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

  async function send(msg, { expectTurn = true, waitMs = 3000, settleMs = 400 } = {}) {
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
    await new Promise((resolve) => setTimeout(resolve, 40))
  }

  return {
    bridge,
    server,
    config,
    turns,
    message,
    send,
    rows: (stage) => bridge.trace.recent({ limit: 5000, stage }),
    stop: () => bridge.stop(),
  }
}

const imageOnly = (extra = {}) => ({
  text: '',
  images: [{ kind: 'image', url: 'https://example.invalid/a.jpg', file: 'A.jpg', path: '', fileId: '' }],
  ...extra,
})

async function main() {
  // ---- ① TraceRecorder 本身：atMe 三态都要如实记 ----
  {
    const file = join(dir, 'trace-at.jsonl')
    const recorder = new TraceRecorder({ file, enabled: true, level: 'debug' })
    recorder.start({ chatKey: 'g:1', messageType: 'group', text: '在吗', atMe: true, images: 2, forwards: 0 })
    recorder.start({ chatKey: 'g:1', messageType: 'group', text: '', atMe: false })
    recorder.start({ chatKey: 'g:1', messageType: 'group', text: '' })   // 宿主没给 atMe
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
      .filter((event) => event.stage === 'inbound')
    check('inbound 行记了 atMe=true', lines[0]?.data?.atMe === true, JSON.stringify(lines[0]?.data))
    check('inbound 行记了 atMe=false', lines[1]?.data?.atMe === false, JSON.stringify(lines[1]?.data))
    check('atMe 缺失记成 null（不是 false —— 那是编造）', lines[2]?.data?.atMe === null, JSON.stringify(lines[2]?.data))
    check('inbound 行记了图片数', lines[0]?.data?.images === 2, JSON.stringify(lines[0]?.data))
  }

  // ---- ② 群聊未 @ + 纯图：记 mention（门禁），不是 drop（能力）----
  {
    const world = makeBridge()
    await world.send(world.message('', imageOnly({ atMe: false })), { expectTurn: false })
    const mention = world.rows('mention')
    const drop = world.rows('drop')
    check('未 @ 的纯图：理由是 mention 而不是 drop', mention.length === 1 && drop.length === 0,
      `mention=${mention.length} drop=${drop.length} reason=${JSON.stringify(drop[0]?.reason ?? mention[0]?.reason ?? '')}`)
    check('mention 理由说清了是 @ 门拦下的', /未 @ 机器人/.test(String(mention[0]?.reason ?? '')),
      JSON.stringify(mention[0]?.reason ?? ''))
    check('未 @ 的纯图仍然不进 agent（@ 门还在）', world.turns.length === 0, `turns=${world.turns.length}`)
    world.stop()
  }

  // ---- ③ 反向对照：@ 了就不该被这道门拦 ----
  {
    const world = makeBridge()
    await world.send(world.message('', imageOnly({ atMe: true })))
    check('@ 的纯图进 agent', world.turns.length === 1, `turns=${world.turns.length}`)
    check('@ 的纯图没有 mention/drop 记录',
      world.rows('mention').length === 0 && world.rows('drop').length === 0,
      `mention=${world.rows('mention').length} drop=${world.rows('drop').length}`)
    world.stop()
  }

  // ---- ④ 真·没有可用内容时，drop 理由要带 at= ----
  {
    const world = makeBridge()
    // 一条空文本、@ 了、也没有任何媒体的群消息：这才是真正的「没有可用内容」。
    await world.send(world.message('', { atMe: true }), { expectTurn: false })
    const drop = world.rows('drop')
    check('真·空消息仍然记 drop', drop.length === 1, `drop=${drop.length}`)
    check('drop 理由带 at= 字段（下次审计不用猜）', /at=有/.test(String(drop[0]?.reason ?? '')),
      JSON.stringify(drop[0]?.reason ?? ''))
    world.stop()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1 })
  .finally(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
