/**
 * 会话挂工作区 —— 侧边栏折叠（2026-11-01，用户提「会话折叠」）。
 *
 * QQ 里"每个群 + 每个私聊"都是一个会话，用几天侧边栏就是十几条 `qq-xxxx` 平铺。
 * 宿主有工作区注册表（`dsh-workspace`），侧边栏按工作区分组，挂上去就收成一个"QQ"。
 *
 * 这个功能的风险不在"没挂上"，在**挂的时候把会话搞挂了**：
 * 它跑在会话创建的路径上，一旦这里抛出去，用户看到的是"消息没回复"，
 * 而不是"分组没生效"——后者无所谓，前者是致命。
 *
 * 所以四条里三条是反面对照：
 *   A 有注册表 → 建会话时真的 attach，且参数是对的
 *   B 没有工作区 → 先 create 再 attach（不能因为"还没这个工作区"就放弃）
 *   C **没有注册表** → 会话照常工作（老版本宿主）
 *   D **注册表抛错** → 会话照常工作（分组失败绝不许连坐）
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

const root = mkdtempSync(join(tmpdir(), 'qq-workspace-'))

class MockServer extends EventEmitter {
  constructor() {
    super()
    this.sent = []
    this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }
  }
  currentSocket() { return this.socket }
  async sendSegments(params) { this.sent.push(params); return { message_id: 1 } }
  async getStatus() { return { online: true, good: true } }
}

const QUIET_BASE = {
  host: '127.0.0.1', port: 0, accessToken: '',
  allowUsers: [1001], allowGroups: [2002], botQq: 999, botName: '小鲸鱼',
  replyOnlyWhenMentioned: true, acceptPrivate: true, sessionMode: 'chat',
  sessionResumeEnabled: false, quietHours: [], quietHoursEnabled: false,
  notifyEnabled: false, injectEnabled: false, recordInbound: false,
  traceEnabled: true, traceLevel: 'debug', traceMemorySize: 500,
  actionAuditEnabled: false, adminEnabled: true, adminUsers: [1001],
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
  agentMediaToolsEnabled: false, rateLimitEnabled: false, memoryEnabled: false,
}

/** 造一个工作区注册表；`registry` 传 null 表示"宿主没这个服务"。 */
function makeRegistry({ existing = null, createThrows = false, attachThrows = false } = {}) {
  const calls = { resolve: [], create: [], attach: [] }
  const workspace = {
    path: '',
    async attachSession(sessionId) {
      calls.attach.push(sessionId)
      if (attachThrows) throw new Error('attach boom')
    },
  }
  const registry = {
    async resolveByPath(path) {
      calls.resolve.push(path)
      return existing ? Object.assign(existing, { path }) : null
    },
    async create(path, title) {
      calls.create.push({ path, title })
      if (createThrows) throw new Error('create boom')
      return Object.assign(workspace, { path })
    },
  }
  return { registry, calls, workspace }
}

function makeBridge({ cwd, workspaceRegistry }) {
  const server = new MockServer()
  const turns = []
  let seq = 0
  const makeCtx = () => {
    const agentCtx = { tools: { register: (t) => t }, systemPrompt: { section: (s) => s } }
    const newHandle = (sessionId, setup) => {
      const id = String(sessionId || `qq-ws-${++seq}`)
      if (typeof setup === 'function') setup(agentCtx)
      const agent = {
        id, status: 'idle',
        followup(message) {
          const blocks = Array.isArray(message?.content) ? message.content : []
          turns.push({ text: blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('') })
          return Promise.resolve()
        },
        cancel() {},
      }
      return { agent, sessionId: id, dispose: async () => {} }
    }
    return {
      on: () => () => {},
      // 宿主服务软取走的就是这个口；没有就返回 undefined（老版本宿主的样子）
      get: (name) => (name === 'workspaceRegistry' ? workspaceRegistry : undefined),
      agents: {
        create: async ({ sessionId, setup }) => newHandle(sessionId, setup),
        resume: async ({ resumeSessionId, setup }) => newHandle(resumeSessionId, setup),
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
      logger: () => ({ info() {}, warn() {}, error() {} }),
    }
  }
  const config = { ...Config({}), ...QUIET_BASE, cwd }
  const bridge = new QQBridge(makeCtx(), config, server, { info() {}, warn() {}, error() {} })
  bridge.start()
  async function send() {
    await new Promise((r) => setTimeout(r, 120))
    const before = turns.length
    server.emit('message', {
      bot: { readyState: 1 }, userId: 1001, messageType: 'group', groupId: 2002,
      text: '在吗', atMe: true, ats: [], reply: null,
      records: [], images: [], files: [], forwards: [], videos: [],
      messageId: `g${Date.now()}`, senderName: '小明', raw: { message: [] },
    })
    const deadline = Date.now() + 3000
    while (turns.length === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
    await new Promise((r) => setTimeout(r, 80))   // 等 fire-and-forget 的 attach 落地
  }
  return { send, lastTurn: () => turns.at(-1)?.text ?? '', stop: () => bridge.stop() }
}

// ---------- A. 有注册表时会挂上去 ----------
{
  const cwd = mkdtempSync(join(root, 'a-'))
  const { registry, calls } = makeRegistry()
  const world = makeBridge({ cwd, workspaceRegistry: registry })
  await world.send()
  check('A 会话照常工作', world.lastTurn() !== '')
  check('A 用 cwd 去查了工作区', calls.resolve.length === 1 && calls.resolve[0] === cwd, JSON.stringify(calls.resolve))
  check('A 把它挂上去了，且带的是会话 id', calls.attach.length === 1, JSON.stringify(calls.attach))
  world.stop()
}

// ---------- B. 还没有工作区时先建一个 ----------
{
  const cwd = mkdtempSync(join(root, 'b-'))
  const { registry, calls } = makeRegistry({ existing: null })
  const world = makeBridge({ cwd, workspaceRegistry: registry })
  await world.send()
  check('B 查不到就创建', calls.create.length === 1, JSON.stringify(calls.create))
  check('B 创建时用的是 cwd', calls.create[0]?.path === cwd)
  check('B 创建出来的名字是「QQ」', calls.create[0]?.title === 'QQ', String(calls.create[0]?.title))
  check('B 建完仍然会 attach', calls.attach.length === 1)
  world.stop()
}

// ---------- C. 宿主没有这个服务（老版本）→ 会话照常 ----------
{
  const cwd = mkdtempSync(join(root, 'c-'))
  const world = makeBridge({ cwd, workspaceRegistry: undefined })
  await world.send()
  check('C 没有注册表时会话照常工作', world.lastTurn() !== '', JSON.stringify(world.lastTurn().slice(0, 40)))
  world.stop()
}

// ---------- D. 注册表抛错 → 会话照常（分组失败不许连坐）----------
{
  const cwd1 = mkdtempSync(join(root, 'd1-'))
  const r1 = makeRegistry({ createThrows: true })
  const w1 = makeBridge({ cwd: cwd1, workspaceRegistry: r1.registry })
  await w1.send()
  check('D create 抛错时会话照常工作', w1.lastTurn() !== '')
  w1.stop()

  const cwd2 = mkdtempSync(join(root, 'd2-'))
  const r2 = makeRegistry({ existing: {} })
  // 让 attach 抛错：先建成、再挂失败，是宿主里更常见的那种失败
  r2.registry.create = async (path) => Object.assign(r2.workspace, { path })
  r2.workspace.attachSession = async () => { throw new Error('attach boom') }
  const w2 = makeBridge({ cwd: cwd2, workspaceRegistry: r2.registry })
  await w2.send()
  check('D attach 抛错时会话照常工作', w2.lastTurn() !== '')
  w2.stop()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
try { rmSync(root, { recursive: true, force: true }) } catch {}
