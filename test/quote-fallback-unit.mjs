/**
 * 引用取不到内容时，把**她最近说过的话**补给模型（2026-11-01）。
 *
 * 现场：用户引用她刚说的一句 + 一句反问（「现在呢」「你会不会统治地球」「你觉得怎么样」），
 * 桥调 `get_msg` 拿被引用消息，Waylay 回 `status:ok, data:null` ⇒ 我们这边只看到"内容为空"。
 * 于是她只被告知"引用的那条我没取到"，回一句"你说的是哪句" —— 用户以为她瞎了。
 *
 * 真机取证（`qq-bridge-debug.log`）：
 *   quote resolve: id=7703053729802896443 got=null segments=0
 *   quote resolve: id=7703124575762004508 got=null segments=0
 *   quote resolve: id=7703162560466304216 got=null segments=0
 * 而同一时段引用**别人发的**图/视频是成功的（493ms / 1017ms）。
 * NapCat 的 `MessageUnique` 是纯内存表（重启即清空），Waylay 对查不到还回 ok+null
 * 而不抛「消息不存在」—— 所以这条路必须自己有退路。
 *
 * 钉四条：
 *   A 取不到时附上她最近说过的话（修复点）
 *   B 只取 assistant，**不能把用户自己说的话当成她说的**（否则她会引用用户的话当自己的）
 *   C 解析成功时**不附**（别让模型拿两份内容去对）
 *   D 没有记忆文件时不编（宁可空着，也不许瞎猜）
 *
 * C 和 D 是反面对照：一个只在"有内容可附"时才绿的判据，会把"永远附一段废话"也判成对。
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
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

const root = mkdtempSync(join(tmpdir(), 'qq-quote-fallback-'))

class MockServer extends EventEmitter {
  constructor() {
    super()
    this.sent = []
    this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }
    this.msgResult = null      // get_msg 的返回：null = 查不到（复现现场）
  }
  currentSocket() { return this.socket }
  async getMsg() { return this.msgResult }
  async sendSegments(params) { this.sent.push(params); return { message_id: 1 } }
  async getStatus() { return { online: true, good: true } }
}

const QUIET_BASE = {
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
  keywordEnabled: false, fortuneEnabled: false, diceEnabled: false,
  pointsEnabled: false, statsEnabled: false, checkinEnabled: false,
  gameEnabled: false, reminderEnabled: false, recurringReminderEnabled: false,
  todoEnabled: false, voteEnabled: false, summaryEnabled: false,
  exportEnabled: false, dailyReportEnabled: false, mcStatusEnabled: false,
  imageGenEnabled: false, ttsEnabled: false, sttEnabled: false,
  voiceReadingEnabled: false, verifyEnabled: false, filterEnabled: false,
  floodEnabled: false, antiRecallEnabled: false, welcomeEnabled: false,
  pokeEnabled: false, autoCollectStickers: false, faceEnabled: false,
  privateImageView: false, fileTransferEnabled: false,
  agentMediaToolsEnabled: false, rateLimitEnabled: false,
  memoryEnabled: true,
}

function makeBridge({ cwd, history = null } = {}) {
  const server = new MockServer()
  const turns = []
  let seq = 0
  const makeCtx = () => {
    const agentCtx = { tools: { register: (t) => t }, systemPrompt: { section: (s) => s } }
    const newHandle = (sessionId, setup) => {
      const id = String(sessionId || `qq-qf-${++seq}`)
      if (typeof setup === 'function') setup(agentCtx)
      const agent = {
        id, status: 'idle',
        followup(message) {
          const blocks = Array.isArray(message?.content) ? message.content : []
          turns.push({ text: blocks.filter((b) => b?.type === 'text').map((b) => b.text).join(''), blocks })
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
  const config = { ...Config({}), ...QUIET_BASE, cwd }
  const logger = { info() {}, warn() {}, error() {} }
  const bridge = new QQBridge(makeCtx(), config, server, logger)
  bridge.start()

  // 预置她说过的话（memory 文件按 `#memoryFile` 的规则：非 \w- 一律换成下划线）
  if (history !== null) {
    const memDir = join(cwd, 'qq-memory')
    mkdirSync(memDir, { recursive: true })
    writeFileSync(join(memDir, 'g_2002.json'), JSON.stringify({ history, archive: [] }), 'utf8')
  }

  async function send(msg) {
    await new Promise((r) => setTimeout(r, 120))
    const before = turns.length
    server.emit('message', msg)
    const deadline = Date.now() + 3000
    while (turns.length === before && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
    }
    await new Promise((r) => setTimeout(r, 40))
  }

  return { bridge, server, send, lastTurn: () => turns.at(-1)?.text ?? '', stop: () => bridge.stop() }
}

/** 群里 @ 她 + 引用一条消息 + 一句文字。 */
const quotedMsg = (text = '现在呢') => ({
  bot: { readyState: 1 },
  userId: 1001,
  messageType: 'group',
  groupId: 2002,
  text,
  atMe: true,
  ats: [],
  reply: { messageId: '7703053729802896443', text: '' },
  records: [], images: [], files: [], forwards: [], videos: [],
  messageId: 'g1',
  senderName: '小明',
  raw: { message: [] },
})

const SELF_HISTORY = [
  { role: 'user', text: '今天干嘛了', ts: 1 },
  { role: 'assistant', text: '没干嘛，躺着呢', ts: 2 },
  { role: 'user', text: '真的假的', ts: 3 },
  { role: 'assistant', text: '骗你干嘛，本喵懒得动', ts: 4 },
]

// ---------- A. 取不到时附上她说过的话 ----------
{
  const cwd = mkdtempSync(join(root, 'a-'))
  const world = makeBridge({ cwd, history: SELF_HISTORY })
  world.server.msgResult = null          // 复现现场：get_msg 拿不到
  await world.send(quotedMsg())
  const text = world.lastTurn()
  check('A 消息进了 agent', text !== '', JSON.stringify(text.slice(0, 60)))
  check('A 告诉她"取不到原文"', /没能取到内容/.test(text))
  check('A 附上了她最近说过的话', /本喵懒得动/.test(text), JSON.stringify(text.slice(0, 160)))
  check('A 用的是"可能"而不是断言', /可能是在指其中之一/.test(text))
  check('A 提示对不上就问', /别硬猜|问他引的是哪句/.test(text))
  world.stop()
}

// ---------- B. 不能把用户说的话当成她说的 ----------
{
  const cwd = mkdtempSync(join(root, 'b-'))
  const world = makeBridge({ cwd, history: SELF_HISTORY })
  world.server.msgResult = null
  await world.send(quotedMsg())
  const text = world.lastTurn()
  check('B 用户说的「今天干嘛了」没被当成她说的', !/今天干嘛了/.test(text), JSON.stringify(text.slice(0, 160)))
  check('B 用户说的「真的假的」也没被当成她说的', !/真的假的/.test(text))
  world.stop()
}

// ---------- C. 解析成功时不附（别给两份内容） ----------
{
  const cwd = mkdtempSync(join(root, 'c-'))
  const world = makeBridge({ cwd, history: SELF_HISTORY })
  world.server.msgResult = { message: [{ type: 'text', data: { text: '被引用的那句话' } }] }
  await world.send(quotedMsg())
  const text = world.lastTurn()
  check('C 解析成功时带上了引用原文', /被引用的那句话/.test(text), JSON.stringify(text.slice(0, 120)))
  check('C 解析成功时**不再**附她说过的话', !/本喵懒得动/.test(text))
  check('C 也不再出现"取不到"', !/没能取到内容/.test(text))
  world.stop()
}

// ---------- D. 没有记忆文件时不编 ----------
{
  const cwd = mkdtempSync(join(root, 'd-'))
  const world = makeBridge({ cwd, history: null })   // 不预置记忆
  world.server.msgResult = null
  await world.send(quotedMsg())
  const text = world.lastTurn()
  check('D 仍然进 agent', text !== '', JSON.stringify(text.slice(0, 60)))
  check('D 没有凭空的"你最近说过"', !/你最近说过/.test(text), JSON.stringify(text.slice(0, 160)))
  world.stop()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
try { rmSync(root, { recursive: true, force: true }) } catch {}
