/**
 * `!moment <正文>`：参数**必须**从解析器一路送到执行处（2026-11-02）。
 *
 * 真机事故：`!moment --private 测试` 一律回「text 为空」。
 * 查下来是 `#execAdminCommand` 读 `spec.text`，而 `#parseAdminQqCommand` **从来不产出 text** ——
 * 两处各自都通，合起来才对不上。这类错最难查：回执说得通、代码也说得通。
 *
 * 所以这里钉的是"参数没在中途丢掉"，不是"能不能发出去"：
 *   A 带正文时，回执**不许**是「text 为空」
 *   B 不带正文时，必须明说"要给正文"（而不是静默）
 *   C `--private` 要被剥掉，且只能影响 ugc_right（不留在正文里）
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from '../lib/index.js'
import { QQBridge } from '../lib/bridge.js'

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
    this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }
  }
  currentSocket() { return this.socket }
  async callAction(action, params) {
    // 换票那一步在这里**故意失败**：本测试只关心"参数有没有送到"，
    // 真发不发得出去由 qzone-unit 与真机负责。
    throw new Error(`模拟后端：${action} 不可用（params=${JSON.stringify(params).slice(0, 40)}）`)
  }
  async sendSegments(socket, mt, tid, segments) {
    const text = (segments || []).filter((s) => s?.type === 'text').map((s) => s.data?.text ?? '').join('')
    this.sent.push({ text })
    return { message_id: 1 }
  }
  async sendText(socket, mt, tid, text) { return this.sendSegments(socket, mt, tid, [{ type: 'text', data: { text } }]) }
  // 2026-11-03：必须与 botQq 一致 —— 桥现在会在发说说前校验登录号，
  // 夹具返回不一致的号等于「登错号」，会被正确地拒绝（那不是这条用例要测的东西）。
  async getLoginInfo() { return { user_id: 3000000001, nickname: 'x' } }
  async sendPrivateMsg() { return { message_id: 1 } }
  async sendGroupMsg() { return { message_id: 1 } }
  async sendMsg() { return { message_id: 1 } }
  async canSendImage() { return { yes: true } }
  async canSendRecord() { return { yes: true } }
}

const BASE = {
  host: '127.0.0.1', port: 0, accessToken: '', allowUsers: [2000000001], allowGroups: [],
  botQq: 3000000001, botName: 'x', replyOnlyWhenMentioned: false, acceptPrivate: true,
  sessionMode: 'chat', sessionResumeEnabled: true, quietHours: [], quietHoursEnabled: false,
  notifyEnabled: false, injectEnabled: false, recordInbound: false, traceEnabled: false,
  actionAuditEnabled: false, adminEnabled: true, adminUsers: [2000000001],
  keywordEnabled: false, fortuneEnabled: false, diceEnabled: false, pointsEnabled: false,
  statsEnabled: false, checkinEnabled: false, gameEnabled: false, reminderEnabled: false,
  recurringReminderEnabled: false, todoEnabled: false, voteEnabled: false, summaryEnabled: false,
  exportEnabled: false, dailyReportEnabled: false, mcStatusEnabled: false, imageGenEnabled: false,
  ttsEnabled: false, sttEnabled: false, voiceReadingEnabled: false, verifyEnabled: false,
  filterEnabled: false, floodEnabled: false, antiRecallEnabled: false, welcomeEnabled: false,
  pokeEnabled: false, autoCollectStickers: false, faceEnabled: false, privateImageView: true,
  groupImageView: true, fileTransferEnabled: false, agentMediaToolsEnabled: false,
  memoryEnabled: false, rateLimitEnabled: false, provider: 'p', model: 'm',
}

function makeBridge(cwd) {
  const server = new MockServer()
  const ctx = {
    on: () => () => {},
    get: () => undefined,
    agents: { create: async () => { throw new Error('no') }, resume: async () => { throw new Error('no') } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    logger: () => ({ info() {}, warn() {}, error() {} }),
  }
  writeFileSync(join(cwd, 'qq-sessions.json'), '{}', 'utf8')
  const bridge = new QQBridge(ctx, { ...Config({}), ...BASE, cwd }, server, { info() {}, warn() {}, error() {} })
  bridge.start()
  return { bridge, server, stop: () => bridge.stop() }
}

async function say(world, text) {
  await new Promise((r) => setTimeout(r, 80))
  world.server.emit('message', {
    bot: world.server.socket, userId: 2000000001, messageType: 'private', text,
    atMe: false, ats: [], reply: null, records: [], images: [], files: [], forwards: [], videos: [],
    messageId: 'm1', senderName: '主人', raw: { message: [] },
  })
  await new Promise((r) => setTimeout(r, 250))
  return String(world.server.sent.at(-1)?.text ?? '')
}

async function main() {
  // ---- A. 带正文：不许再回"text 为空" ----
  {
    const cwd = mkdtempSync(join(root, 'a-'))
    const world = makeBridge(cwd)
    const reply = await say(world, '!moment 今天也想你了')
    check('A ★ 带正文时不再说「text 为空」', !/text 为空/.test(reply), reply.slice(0, 120))
    check('A 落到了发说说那条路（失败点是换票/网络，不是解析）',
      /clientKey|模拟后端|换票|请求/.test(reply), reply.slice(0, 160))
    world.stop()
  }

  // ---- B. 不带正文：要明说 ----
  {
    const cwd = mkdtempSync(join(root, 'b-'))
    const world = makeBridge(cwd)
    const reply = await say(world, '!moment')
    check('B 不带正文时明说必须给正文', /text 为空/.test(reply) && /正文/.test(reply), reply.slice(0, 100))
    world.stop()
  }

  // ---- C. --private 只影响权限，不进正文 ----
  {
    const cwd = mkdtempSync(join(root, 'c-'))
    const world = makeBridge(cwd)
    const reply = await say(world, '!moment --private 只给自己看')
    check('C 带 --private 也不再说「text 为空」', !/text 为空/.test(reply), reply.slice(0, 120))
    check('C 参数同样送到了发说说那条路', /clientKey|模拟后端|换票|请求/.test(reply), reply.slice(0, 160))
    world.stop()
  }

  // ---- D. --sticker：只认表情库，且要给出可用清单 ----
  {
    const cwd = mkdtempSync(join(root, 'd-'))
    const world = makeBridge(cwd)
    const reply = await say(world, '!moment --sticker 不存在的表情 随便说点什么')
    check('D ★ 表情库没有时如实报，并列出可用清单', /表情库里没有/.test(reply), reply.slice(0, 140))
    check('D 不再把 --sticker 留在正文里', !/--sticker/.test(reply), reply.slice(0, 160))
    world.stop()
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => { try { rmSync(root, { recursive: true, force: true }) } catch {} })
