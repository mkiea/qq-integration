/**
 * `!probe <action> [json]` —— 管理员在 QQ 里直接调一个 OneBot action（2026-11-01 夜）。
 *
 * 为什么要有这个口子：查"引用为什么解析不出来"时，能看到的只有"我们发了个 id、后端说没有"，
 * 而**后端到底支持什么、字段叫什么**只能一个个试。没这个入口，每试一次都要改代码 + 重启 QQ
 * （两分钟起），一晚上就没了。
 *
 * 钉五件事（都是"错了会出事"的地方）：
 *   A 不带 action 只报用法，**不发请求**
 *   B 正常调用：参数原样透传、结果落盘到 `<数据目录>/_debug/`
 *   C 非法 JSON：报错，**不发请求**（把半截 JSON 发给后端只会得到更难懂的错误）
 *   D **非管理员发的 `!probe` 不生效**（这是唯一一条能调用任意 action 的入口，门必须关死）
 *   E 后端抛错时如实说"调用失败"，并且不留下半份结果文件
 */
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
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

const root = mkdtempSync(join(tmpdir(), 'qq-probe-'))

class MockServer extends EventEmitter {
  constructor() {
    super()
    this.sent = []
    this.actionCalls = []
    this.actionResult = { ok: 1 }
    this.actionError = null
    this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }
  }
  currentSocket() { return this.socket }
  async callAction(socket, action, params) {
    this.actionCalls.push({ action, params })
    if (this.actionError) throw new Error(this.actionError)
    return this.actionResult
  }
  async getImage() { throw new Error('no image in mock') }
  async getRecord() { throw new Error('no record in mock') }
  async getFile() { throw new Error('no file in mock') }
  async getMsg() { throw new Error('no msg in mock') }
  // 桥的回执走 sendSegments/sendText（见 lib/onebot.js），mock 里必须实现，否则回执发不出去、
  // 测试会看到'没有回执'而误判成'指令没生效'。
  async sendSegments(socket, messageType, targetId, segments) {
    const text = (segments || []).filter((seg) => seg?.type === 'text').map((seg) => seg.data?.text ?? '').join('')
    this.sent.push({ messageType, targetId, text })
    return { message_id: 1 }
  }
  async sendText(socket, messageType, targetId, text) { return this.sendSegments(socket, messageType, targetId, [{ type: 'text', data: { text } }]) }
  async sendPrivateMsg(params) { this.sent.push({ kind: 'private', params }); return { message_id: 1 } }
  async sendGroupMsg(params) { this.sent.push({ kind: 'group', params }); return { message_id: 1 } }
  async sendMsg(params) { this.sent.push({ kind: 'unknown', params }); return { message_id: 1 } }
  async getLoginInfo() { return { user_id: 999, nickname: '小鲸鱼' } }
  async getGroupMemberInfo() { return { card: '', nickname: '小鲸鱼' } }
  async getStatus() { return { online: true, good: true } }
  async getVersionInfo() { return { app_name: 'mock', app_version: '0' } }
  async canSendImage() { return { yes: true } }
  async canSendRecord() { return { yes: true } }
}

const QUIET_BASE = {
  cwd: root,
  host: '127.0.0.1',
  port: 0,
  accessToken: '',
  allowUsers: [1001, 2002],
  allowGroups: [],
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
  adminUsers: [1001],          // 管理员只有 1001
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

function makeBridge(cwd, overrides = {}) {
  const server = new MockServer()
  const turns = []
  const ctx = {
    on: () => () => {},
    get: () => undefined,
    agents: {
      create: async ({ sessionId }) => ({ agent: { followup: (m) => { turns.push(m); return Promise.resolve() }, cancel() {} }, sessionId, dispose: async () => {} }),
      resume: async ({ resumeSessionId }) => ({ agent: { followup: (m) => { turns.push(m); return Promise.resolve() }, cancel() {} }, sessionId: resumeSessionId, dispose: async () => {} }),
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    logger: () => ({ info() {}, warn() {}, error() {} }),
  }
  const config = { ...Config({}), ...QUIET_BASE, cwd, ...overrides }
  const bridge = new QQBridge(ctx, config, server, { info() {}, warn() {}, error() {} })
  bridge.start()

  let seq = 0
  function message(text, extra = {}) {
    return {
      bot: server.socket, userId: 1001, messageType: 'private', text,
      atMe: false, ats: [], reply: null, records: [], images: [], files: [], forwards: [], videos: [],
      messageId: `m${++seq}`, senderName: '主人', raw: { message: [] }, ...extra,
    }
  }
  async function send(msg) {
    await new Promise((resolve) => setTimeout(resolve, 120))
    server.emit('message', msg)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return { bridge, server, turns, message, send, stop: () => bridge.stop() }
}

const debugDir = (cwd) => join(cwd, '_debug')
const probeFiles = (cwd) => (existsSync(debugDir(cwd)) ? readdirSync(debugDir(cwd)).filter((n) => n.startsWith('probe-')) : [])

async function main() {
  // ---- A. 不带 action：只报用法，不发请求 ----
  {
    const cwd = mkdtempSync(join(root, 'a-'))
    const world = makeBridge(cwd)
    await world.send(world.message('!probe'))
    const reply = world.server.sent.at(-1)?.text ?? ''
    check('A 回执里给了用法', /用法/.test(String(reply)), JSON.stringify(String(reply).slice(0, 80)))
    check('A ★ 没有真的调用后端', world.server.actionCalls.length === 0, JSON.stringify(world.server.actionCalls))
    world.stop()
  }

  // ---- B. 正常调用：参数原样透传 + 结果落盘 ----
  {
    const cwd = mkdtempSync(join(root, 'b-'))
    const world = makeBridge(cwd)
    world.server.actionResult = { message: [{ type: 'text', data: { text: '被引用的那句话' } }] }
    await world.send(world.message('!probe get_msg {"message_id":"7703053729802896443"}'))
    const call = world.server.actionCalls.at(-1)
    check('B 调用了指定的 action', call?.action === 'get_msg', JSON.stringify(call))
    check('B 参数原样透传（字符串 id 没被转成数字）',
      String(call?.params?.message_id) === '7703053729802896443', JSON.stringify(call?.params))
    const files = probeFiles(cwd)
    check('B 结果落在 <cwd>/_debug/ 下', files.length === 1, JSON.stringify(files))
    if (files.length === 1) {
      const saved = JSON.parse(readFileSync(join(debugDir(cwd), files[0]), 'utf8'))
      check('B 文件里有 action / params / data 三样',
        saved.action === 'get_msg' && saved.params?.message_id === '7703053729802896443'
        && saved.data?.message?.[0]?.data?.text === '被引用的那句话', JSON.stringify(saved).slice(0, 120))
      check('B 文件名带 action 名（人看得懂）', files[0].includes('get_msg'), files[0])
    }
    world.stop()
  }

  // ---- C. 非法 JSON：报错且不发请求 ----
  {
    const cwd = mkdtempSync(join(root, 'c-'))
    const world = makeBridge(cwd)
    await world.send(world.message('!probe get_msg {bad json'))
    const reply = String(world.server.sent.at(-1)?.text ?? '')
    check('C 明说参数不是合法 JSON', /JSON/.test(reply), JSON.stringify(reply.slice(0, 80)))
    check('C ★ 半截参数没有被发出去', world.server.actionCalls.length === 0, JSON.stringify(world.server.actionCalls))
    check('C 也没有留下结果文件', probeFiles(cwd).length === 0)
    world.stop()
  }

  // ---- D. 非管理员：整条指令不生效 ----
  {
    const cwd = mkdtempSync(join(root, 'd-'))
    const world = makeBridge(cwd)
    await world.send(world.message('!probe __introspect', { userId: 2002 }))   // 在 allowUsers 里，但**不是** adminUsers
    check('D ★ 非管理员调用不了任意 action', world.server.actionCalls.length === 0, JSON.stringify(world.server.actionCalls))
    check('D 也没有留下结果文件', probeFiles(cwd).length === 0)
    world.stop()
  }

  // ---- E. 后端抛错：如实报错，不留半份文件 ----
  {
    const cwd = mkdtempSync(join(root, 'e-'))
    const world = makeBridge(cwd)
    world.server.actionError = 'OneBot action __nope failed: {"status":"failed","retcode":1404}'
    await world.send(world.message('!probe __nope'))
    const reply = String(world.server.sent.at(-1)?.text ?? '')
    check('E 回执说"调用失败"', /失败/.test(reply), JSON.stringify(reply.slice(0, 100)))
    check('E 把后端的话带回来了（不是一句"出错了"）', /1404|retcode/.test(reply), JSON.stringify(reply.slice(0, 140)))
    check('E 不留下半份结果文件', probeFiles(cwd).length === 0)
    world.stop()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1 })
  .finally(() => { try { rmSync(root, { recursive: true, force: true }) } catch {} })
