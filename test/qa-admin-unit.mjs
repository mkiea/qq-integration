/**
 * `!qa` —— 能自动验的那一半（2026-11-02，主人要"自动测试指令"）。
 *
 * 分工必须清楚：**她答得对不对，机器判不了**（见 `docs/ACCEPTANCE.md` 的人工清单）；
 * 这条指令只验机械部分：通道、模型、图片代理端口、内核回源、会话映射。
 *
 * 钉四件事：
 *   A 全绿时 ok:true 且逐项列出（不是只说"通过"）
 *   B 有一项挂了 ⇒ ok:false，且**具体哪项、为什么**要写在回执里
 *   C 图片代理没开时要报 ❌ 并提示 `ONEBOT_WS_PORT`，**不许**当成"没这项"跳过
 *   D 内核回源失败要如实报（这条链是引用/聊天记录的命根子）
 */
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
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

const root = mkdtempSync(join(tmpdir(), 'qq-qa-'))

class MockServer extends EventEmitter {
  constructor() {
    super()
    this.sent = []
    this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }
    this.historyResult = { messages: [{ message_id: 1 }] }
    this.historyError = null
    this.calls = []
  }
  currentSocket() { return this.socket }
  async callAction(socket, action, params) {
    this.calls.push({ action, params })
    if (action === 'get_friend_msg_history') {
      if (this.historyError) throw new Error(this.historyError)
      return this.historyResult
    }
    return { ok: true }
  }
  async sendSegments(socket, messageType, targetId, segments) {
    const text = (segments || []).filter((s) => s?.type === 'text').map((s) => s.data?.text ?? '').join('')
    this.sent.push({ text })
    return { message_id: 1 }
  }
  async sendText(socket, mt, tid, text) { return this.sendSegments(socket, mt, tid, [{ type: 'text', data: { text } }]) }
  async getLoginInfo() { return { user_id: 999, nickname: 'x' } }
  async sendPrivateMsg() { return { message_id: 1 } }
  async sendGroupMsg() { return { message_id: 1 } }
  async sendMsg() { return { message_id: 1 } }
  async canSendImage() { return { yes: true } }
  async canSendRecord() { return { yes: true } }
}

const BASE = {
  host: '127.0.0.1', port: 0, accessToken: '', allowUsers: [2000000001], allowGroups: [],
  botQq: 999, botName: 'x', replyOnlyWhenMentioned: false, acceptPrivate: true,
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
  memoryEnabled: false, rateLimitEnabled: false, provider: 'deepseek-account', model: 'deepseek-flash',
}

function makeBridge(cwd) {
  const server = new MockServer()
  const ctx = {
    on: () => () => {},
    get: () => undefined,                        // 没有 workspaceRegistry
    agents: { create: async () => { throw new Error('no') }, resume: async () => { throw new Error('no') } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
    logger: () => ({ info() {}, warn() {}, error() {} }),
  }
  writeFileSync(join(cwd, 'qq-sessions.json'), JSON.stringify({ 'u:1': 's1' }), 'utf8')
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
  await new Promise((r) => setTimeout(r, 300))
  return String(world.server.sent.at(-1)?.text ?? '')
}

/** 起一个只会回 404 的本地服务，冒充图片代理。 */
async function startFakeProxy(port) {
  const srv = createServer((req, res) => { res.writeHead(404); res.end('nope') })
  await new Promise((resolve) => srv.listen(port, '127.0.0.1', resolve))
  return { close: () => new Promise((resolve) => srv.close(resolve)) }
}

async function main() {
  // ---- A. 全绿 ----
  {
    const port = 16700 + Math.floor(Math.random() * 200)
    process.env.RIN_FILE_PROXY_PORT = String(port)
    const proxy = await startFakeProxy(port)
    const cwd = mkdtempSync(join(root, 'a-'))
    const world = makeBridge(cwd)
    const reply = await say(world, '!qa')
    check('A 全绿时逐项列出', /✅ OneBot 通道/.test(reply) && /✅ 图片代理/.test(reply) && /✅ 内核取历史/.test(reply), reply.slice(0, 200))
    check('A 明确说"人的部分机器判不了"', /机器判不了|ACCEPTANCE/.test(reply), reply.slice(0, 240))
    check('A 内核历史确实被问过', world.server.calls.some((c) => c.action === 'get_friend_msg_history'), JSON.stringify(world.server.calls))
    world.stop(); await proxy.close()
  }

  // ---- B/D. 内核回源失败 ----
  {
    const port = 16750 + Math.floor(Math.random() * 200)
    process.env.RIN_FILE_PROXY_PORT = String(port)
    const proxy = await startFakeProxy(port)
    const cwd = mkdtempSync(join(root, 'b-'))
    const world = makeBridge(cwd)
    world.server.historyError = 'OneBot action get_friend_msg_history failed: {"retcode":1404}'
    const reply = await say(world, '!qa')
    check('B 失败时带 ⚠️', /⚠️/.test(reply), reply.slice(0, 80))
    check('D ★ 内核失败被点名', /❌ 内核取历史/.test(reply), reply.slice(0, 200))
    check('D 带回了后端原话', /1404/.test(reply), reply.slice(0, 200))
    world.stop(); await proxy.close()
  }

  // ---- C. 图片代理没开 ----
  {
    const deadPort = 16900 + Math.floor(Math.random() * 50)   // 没人听
    process.env.RIN_FILE_PROXY_PORT = String(deadPort)
    const cwd = mkdtempSync(join(root, 'c-'))
    const world = makeBridge(cwd)
    const reply = await say(world, '!qa')
    check('C ★ 代理没开时点名失败', /❌ 图片代理/.test(reply), reply.slice(0, 200))
    check('C 提示 ONEBOT_WS_PORT', /ONEBOT_WS_PORT/.test(reply), reply.slice(0, 220))
    world.stop()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => { delete process.env.RIN_FILE_PROXY_PORT; try { rmSync(root, { recursive: true, force: true }) } catch {} })
