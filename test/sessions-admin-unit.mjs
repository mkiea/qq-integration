/**
 * `!sessions` / `!sessions prune` —— 侧栏里"多余对话"的清理（2026-11-02）。
 *
 * 背景：`#attachToWorkspace` 把每个会话挂进「QQ」工作区，但**一个聊天历史上可能有好几个会话**
 * （早期续接没修好、或撞写锁降级时开的）。折叠只把它们收进一个组，条数不变。
 *
 * 这里钉五件事，都是"错了会出事"的：
 *   A 不写 prune 就**只看不动**（一条 detach 都不许发）
 *   B 「在用」只认 `qq-sessions.json` 的映射 —— 那是"这个聊天现在接哪条"的唯一真相
 *   C prune 只摘旧的，**在用的必须留着**（摘错一条 = 下次接不回上下文）
 *   D 宿主没有 workspaceRegistry 时如实说"读不到"，而不是假装成功
 *   E detach 抛错要报出来（ok:false + 失败条数），不能吞成"已清理"
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

const root = mkdtempSync(join(tmpdir(), 'qq-sessions-'))

class MockServer extends EventEmitter {
  constructor() {
    super()
    this.sent = []
    this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }
  }
  currentSocket() { return this.socket }
  async sendSegments(socket, messageType, targetId, segments) {
    const text = (segments || []).filter((s) => s?.type === 'text').map((s) => s.data?.text ?? '').join('')
    this.sent.push({ messageType, targetId, text })
    return { message_id: 1 }
  }
  async sendText(socket, messageType, targetId, text) { return this.sendSegments(socket, messageType, targetId, [{ type: 'text', data: { text } }]) }
  async getLoginInfo() { return { user_id: 999, nickname: '小鲸鱼' } }
  async getGroupMemberInfo() { return { card: '', nickname: '小鲸鱼' } }
  async sendPrivateMsg() { return { message_id: 1 } }
  async sendGroupMsg() { return { message_id: 1 } }
  async sendMsg() { return { message_id: 1 } }
  async canSendImage() { return { yes: true } }
  async canSendRecord() { return { yes: true } }
}

const BASE = {
  host: '127.0.0.1', port: 0, accessToken: '', allowUsers: [1001], allowGroups: [],
  botQq: 999, botName: '小鲸鱼', replyOnlyWhenMentioned: false, acceptPrivate: true,
  sessionMode: 'chat', sessionResumeEnabled: true, quietHours: [], quietHoursEnabled: false,
  notifyEnabled: false, injectEnabled: false, recordInbound: false, traceEnabled: true,
  traceLevel: 'debug', traceMemorySize: 200, actionAuditEnabled: false,
  adminEnabled: true, adminUsers: [1001], keywordEnabled: false, fortuneEnabled: false,
  diceEnabled: false, pointsEnabled: false, statsEnabled: false, checkinEnabled: false,
  gameEnabled: false, reminderEnabled: false, recurringReminderEnabled: false, todoEnabled: false,
  voteEnabled: false, summaryEnabled: false, exportEnabled: false, dailyReportEnabled: false,
  mcStatusEnabled: false, imageGenEnabled: false, ttsEnabled: false, sttEnabled: false,
  voiceReadingEnabled: false, verifyEnabled: false, filterEnabled: false, floodEnabled: false,
  antiRecallEnabled: false, welcomeEnabled: false, pokeEnabled: false, autoCollectStickers: false,
  faceEnabled: false, privateImageView: true, groupImageView: true, fileTransferEnabled: false,
  agentMediaToolsEnabled: false, memoryEnabled: false, rateLimitEnabled: false,
}

/**
 * @param {object} opts
 * @param {boolean} opts.withRegistry  宿主有没有 workspaceRegistry
 * @param {string[]} opts.attached     工作区里挂着的会话
 * @param {Record<string,string>} opts.mapping  qq-sessions.json 里的映射
 * @param {string[]} opts.failDetach   这几个 id 的 detach 会抛错
 */
function makeBridge(cwd, opts) {
  const server = new MockServer()
  const detachCalls = []
  const workspace = {
    sessionIds: [...opts.attached],
    async detachSession(id) {
      detachCalls.push(id)
      if (opts.failDetach.includes(id)) throw new Error('detach 失败')
      workspace.sessionIds = workspace.sessionIds.filter((x) => x !== id)
    },
  }
  const ctx = {
    on: () => () => {},
    get: (name) => (name === 'workspaceRegistry' && opts.withRegistry
      ? { resolveByPath: async () => workspace, create: async () => workspace }
      : undefined),
    agents: { create: async () => { throw new Error('不该创建会话') }, resume: async () => { throw new Error('不该续接') } },
    agentDefaultModel: { currentSelection: () => ({ provider: 't', model: 't' }) },
    logger: () => ({ info() {}, warn() {}, error() {} }),
  }
  // 预置映射文件（数据目录下的 qq-sessions.json）
  writeFileSync(join(cwd, 'qq-sessions.json'), JSON.stringify(opts.mapping), 'utf8')
  const bridge = new QQBridge(ctx, { ...Config({}), ...BASE, cwd }, server, { info() {}, warn() {}, error() {} })
  bridge.start()
  return { bridge, server, workspace, detachCalls, stop: () => bridge.stop() }
}

async function say(world, text) {
  await new Promise((r) => setTimeout(r, 80))
  world.server.emit('message', {
    bot: world.server.socket, userId: 1001, messageType: 'private', text,
    atMe: false, ats: [], reply: null, records: [], images: [], files: [], forwards: [], videos: [],
    messageId: 'm1', senderName: '主人', raw: { message: [] },
  })
  await new Promise((r) => setTimeout(r, 200))
  return String(world.server.sent.at(-1)?.text ?? '')
}

async function main() {
  const attached = ['s-new', 's-old-1', 's-old-2']
  const mapping = { 'u:2000000001': 's-new' }

  // ---- A/B. 只看不动 ----
  {
    const cwd = mkdtempSync(join(root, 'a-'))
    const world = makeBridge(cwd, { withRegistry: true, attached, mapping, failDetach: [] })
    const reply = await say(world, '!sessions')
    check('A 报告了挂载数与旧会话数', /挂 3 条/.test(reply) && /2 条是旧的/.test(reply), reply.slice(0, 120))
    check('A ★ 没写 prune 时一条 detach 都不发', world.detachCalls.length === 0, JSON.stringify(world.detachCalls))
    world.stop()
  }

  // ---- C. prune 只摘旧的，保留在用的 ----
  {
    const cwd = mkdtempSync(join(root, 'c-'))
    const world = makeBridge(cwd, { withRegistry: true, attached, mapping, failDetach: [] })
    const reply = await say(world, '!sessions prune')
    check('C 摘掉 2 条', world.detachCalls.length === 2, JSON.stringify(world.detachCalls))
    check('C ★ 在用的那条没被摘', !world.detachCalls.includes('s-new'), JSON.stringify(world.detachCalls))
    check('C 工作区里只剩在用的那条', JSON.stringify(world.workspace.sessionIds) === '["s-new"]', JSON.stringify(world.workspace.sessionIds))
    check('C 回执说"数据没删"', /数据没删/.test(reply), reply.slice(0, 120))
    world.stop()
  }

  // ---- D. 宿主没有 registry ----
  {
    const cwd = mkdtempSync(join(root, 'd-'))
    const world = makeBridge(cwd, { withRegistry: false, attached, mapping, failDetach: [] })
    const reply = await say(world, '!sessions')
    check('D 如实说读不到工作区分组', /读不到工作区分组/.test(reply), reply.slice(0, 100))
    check('D 也没有 detach', world.detachCalls.length === 0)
    world.stop()
  }

  // ---- E. detach 抛错要报出来 ----
  {
    const cwd = mkdtempSync(join(root, 'e-'))
    const world = makeBridge(cwd, { withRegistry: true, attached, mapping, failDetach: ['s-old-2'] })
    const reply = await say(world, '!sessions prune')
    check('E 成功的那条照常摘', world.detachCalls.includes('s-old-1'))
    check('E ★ 失败被报出来（不是"已清理"）', /失败 1 条/.test(reply), reply.slice(0, 140))
    check('E 回执不是全绿（ok=false 会带 ⚠️）', /⚠️|失败/.test(reply), reply.slice(0, 60))
    world.stop()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => { try { rmSync(root, { recursive: true, force: true }) } catch {} })
