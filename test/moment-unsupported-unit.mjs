/**
 * 说说（QQ 空间）在当前后端不可用 —— 能力探测与降级（2026-11-01）。
 *
 * 现场：换成 Waylay 之后 `send_qzone_msg` 一律回
 *   {"status":"failed","retcode":1404,"msg":"不支持的 API","data":null}
 * 真机 3 次全败（10-31 两次、11-01 一次）。而"发说说"在主动通道里是一个**独立由头**：
 * 留着它，每一轮都要白烧一次模型调用 + 一次必然失败的 API + 一条 error trace + 一次回滚。
 *
 * 判据的关键是"分清两种失败"：
 *   · `1404 不支持的 API` = **后端没这个能力** ⇒ 停用整条由头
 *   · 网络抖动 / DLP 拦下 / 正文为空 = **这一轮没成** ⇒ 下轮照常再试
 * 混为一谈就会因为一次偶发超时把说说永久关掉。
 *
 *   A 1404 ⇒ 记住"不支持"
 *   B **别的错误（网络）⇒ 不许记成不支持**（这是 B 存在的唯一理由）
 *   C 已记下之后，`/moment` 直接给出理由，且**不再调用那个必然失败的 API**
 *   D 说话本身不受影响（停用说说不能连累正常聊天）
 */
import { EventEmitter } from 'node:events'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

const root = mkdtempSync(join(tmpdir(), 'qq-moment-'))

class MockServer extends EventEmitter {
  constructor() {
    super()
    this.sent = []
    this.momentCalls = 0
    this.momentError = null
    this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }
  }
  currentSocket() { return this.socket }
  // 真实签名是 (socket, messageType, targetId, segments) —— 四个参数。
  async sendSegments(bot, messageType, targetId, segments) {
    this.sent.push(segments)
    return { message_id: 1 }
  }
  async sendQzoneMsg() {
    this.momentCalls += 1
    if (this.momentError) throw this.momentError
    return { tid: 'tid-1' }
  }
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
  proactiveEnabled: false,
}

function makeBridge({ cwd }) {
  const server = new MockServer()
  let seq = 0
  const makeCtx = () => {
    const agentCtx = { tools: { register: (t) => t }, systemPrompt: { section: (s) => s } }
    const newHandle = (sessionId, setup) => {
      const id = String(sessionId || `qq-mm-${++seq}`)
      if (typeof setup === 'function') setup(agentCtx)
      return { agent: { id, status: 'idle', followup: async () => {}, cancel() {} }, sessionId: id, dispose: async () => {} }
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
  const bridge = new QQBridge(makeCtx(), config, server, { info() {}, warn() {}, error() {} })
  bridge.start()
  return { bridge, server, cwd }
}

/**
 * 发一条**管理员指令**，走真实生产路径：写 `qq-admin-commands.jsonl` → `adminTick()` 排空 →
 * 读 `qq-admin-results.jsonl` 里新增的那一行。
 *
 * 为什么不用"发一条 QQ 消息"：`!moment` 这类指令根本不是 QQ 消息，是控制台/命令行写进
 * 指令文件的 JSON（`#pollAdminCommands` 读 `adminTailer`）。用消息去触发，测的是另一条路。
 */
async function adminCmd(world, spec) {
  const file = join(world.cwd, 'qq-admin-commands.jsonl')
  appendFileSync(file, `${JSON.stringify({ id: `t${Date.now()}`, ...spec })}\n`, 'utf8')
  await world.bridge.adminTick()
  const results = existsSync(join(world.cwd, 'qq-admin-results.jsonl'))
    ? readFileSync(join(world.cwd, 'qq-admin-results.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
    : []
  const last = results.at(-1)
  if (!last) return {}
  try { return JSON.parse(last) } catch { return {} }
}

const MOMENT_1404 = new Error('OneBot action send_qzone_msg failed: {"status":"failed","retcode":1404,"msg":"不支持的 API","data":null}')

// ---------- A. 1404 ⇒ 记成"不支持" ----------
{
  const cwd = mkdtempSync(join(root, 'a-'))
  const world = makeBridge({ cwd })
  world.server.momentError = MOMENT_1404
  const res = await adminCmd(world, { cmd: 'moment', text: '测试一下' })
  check('A 第一次发失败时会调用一次 API', world.server.momentCalls === 1, `calls=${world.server.momentCalls}`)
  // 用宽松判等：旧版没有这个字段，`undefined !== null` 会假通过。
  check('A 记下了"这个后端不支持"', world.bridge.momentsUnsupported != null, JSON.stringify(world.bridge.momentsUnsupported))
  check('A 结果里带着失败原因', /不支持的 API|retcode/.test(String(res.error ?? '')), JSON.stringify(String(res.error ?? '').slice(0, 80)))
  world.bridge.stop()
}

// ---------- B. 别的错误不许记成"不支持" ----------
{
  const cwd = mkdtempSync(join(root, 'b-'))
  const world = makeBridge({ cwd })
  world.server.momentError = new Error('OneBot action send_qzone_msg timed out')
  await adminCmd(world, { cmd: 'moment', text: '测试一下' })
  check('B ★ 网络超时**没有**被误判成不支持', world.bridge.momentsUnsupported == null,
    JSON.stringify(world.bridge.momentsUnsupported))
  world.bridge.stop()
}

// ---------- C. 已记下之后不再白打一次 API ----------
{
  const cwd = mkdtempSync(join(root, 'c-'))
  const world = makeBridge({ cwd })
  world.server.momentError = MOMENT_1404
  await adminCmd(world, { cmd: 'moment', text: '第一次' })
  const afterFirst = world.server.momentCalls
  const res = await adminCmd(world, { cmd: 'moment', text: '第二次' })
  check('C ★ 第二次没有再调用 API', world.server.momentCalls === afterFirst, `calls ${afterFirst} -> ${world.server.momentCalls}`)
  check('C 第二次直接说明了原因', /不支持|换回支持/.test(String(res.error ?? '')), JSON.stringify(String(res.error ?? '').slice(0, 90)))
  world.bridge.stop()
}

// ---------- D. 停用说说不能连累正常聊天 ----------
{
  const cwd = mkdtempSync(join(root, 'd-'))
  const world = makeBridge({ cwd })
  world.server.momentError = MOMENT_1404
  await adminCmd(world, { cmd: 'moment', text: '先探一下' })
  const res2 = await adminCmd(world, { cmd: 'status' })
  check('D 说说不可用之后，别的指令照常工作', res2.ok === true, JSON.stringify(String(res2.reason ?? res2.error ?? '').slice(0, 80)))
  world.bridge.stop()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
try { rmSync(root, { recursive: true, force: true }) } catch {}
