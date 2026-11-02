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

function makeBridge(cwd, overrides = {}) {
  const server = new MockServer()
  const ctx = overrides.ctx ?? {
    on: () => () => {},
    get: () => undefined,                        // 没有 workspaceRegistry
    agents: { create: async () => { throw new Error('no') }, resume: async () => { throw new Error('no') } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
    logger: () => ({ info() {}, warn() {}, error() {} }),
  }
  writeFileSync(join(cwd, 'qq-sessions.json'), JSON.stringify({ 'u:1': 's1' }), 'utf8')
  const bridge = new QQBridge(ctx, { ...Config({}), ...BASE, ...overrides.base, cwd }, server, { info() {}, warn() {}, error() {} })
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

/**
 * 按 Waylay 的真实行为冒充图片代理（E 用）：
 *   - `/file/<不认识的 key>` **不立刻回**，要挂 10 秒等 NTQQ 下载，然后才 404
 *   - 其它路径（含 `/`）立刻回 200 JSON
 * 这就是 11-02 那次误报的现场：端口明明在听，探针却用 /file/xxx，1.5s 超时先到。
 */
async function startWaylayLikeProxy(port) {
  const seen = []
  const timers = new Set()
  const hung = new Set()
  const srv = createServer((req, res) => {
    seen.push(req.url)
    if (req.url.startsWith('/file/')) {
      hung.add(res)                        // 挂住不回，模拟"等 NTQQ 下载"
      const t = setTimeout(() => { timers.delete(t); res.writeHead(404); res.end('unknown key') }, 10_000)
      timers.add(t)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  await new Promise((resolve) => srv.listen(port, '127.0.0.1', resolve))
  return {
    seen,
    close: () => new Promise((resolve) => {
      for (const t of timers) clearTimeout(t)
      for (const res of hung) { try { res.destroy() } catch {} }   // 不然 close 永远等不到
      try { srv.closeAllConnections?.() } catch {}
      srv.close(() => resolve())
    }),
  }
}

/**
 * 发一条消息，然后**等到回执真的出现**（而不是固定等 300ms）。
 * `!qa` 里有网络探测，回执可能晚到；固定等待会让断言读到上一条，变成假绿/假红。
 * 返回 `{ text, ms }`，ms 从发出到收到回执 —— E 用它证明"没有干等挂起"。
 */
async function sayUntil(world, text, pattern, timeoutMs = 6000) {
  await new Promise((r) => setTimeout(r, 80))
  const before = world.server.sent.length
  world.server.emit('message', {
    bot: world.server.socket, userId: 2000000001, messageType: 'private', text,
    atMe: false, ats: [], reply: null, records: [], images: [], files: [], forwards: [], videos: [],
    messageId: 'm1', senderName: '主人', raw: { message: [] },
  })
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50))
    const last = String(world.server.sent.at(-1)?.text ?? '')
    if (world.server.sent.length > before && pattern.test(last)) return { text: last, ms: Date.now() - t0 }
  }
  return { text: String(world.server.sent.at(-1)?.text ?? ''), ms: Date.now() - t0 }
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

  // ---- E. 端口在听但 /file/ 会挂 10 秒 —— 11-02 那次误报的现场 ----
  // 这一条是**旧版会红**：旧探针探 `/file/__qa_probe__`，撞上上面那个 10s 挂起，
  // 1.5s 超时先到 ⇒ 明明在听也报 ❌。修法是探 `/`。
  {
    const port = 17000 + Math.floor(Math.random() * 200)
    process.env.RIN_FILE_PROXY_PORT = String(port)
    const proxy = await startWaylayLikeProxy(port)
    const cwd = mkdtempSync(join(root, 'e-'))
    const world = makeBridge(cwd)
    const { text: reply, ms } = await sayUntil(world, '!qa', /图片代理/)
    check('E ★ 探针不会被 /file 的 10 秒挂起拖死', /✅ 图片代理/.test(reply), `${ms}ms · ${reply.slice(0, 160)}`)
    // ⚠️ 阈值为什么是 1000 而不是 3000：探针自带 1.5s 超时，写 <3000 是**恒真**的
    // （撞了超时也才 1554ms），那种断言等于没写。实测正常 60ms 量级、撞超时 1550ms 量级。
    check('E 回执是立刻到的（没撞 1.5s 超时）', ms < 1000, `${ms}ms`)
    check('E ★ 健康检查不走 /file/', !proxy.seen.some((p) => String(p).startsWith('/file/')), JSON.stringify(proxy.seen))
    world.stop(); await proxy.close()
  }

  // ---- F. 配置留空 ⇒ 必须回落到宿主默认模型 ----
  // 这一条是**旧版会红**：搬出 bridge 后那段还写 `this.ctx`（恒 undefined），
  // 于是 provider/model 都是空 ⇒ 报 ❌ 模型：(空) / (空)。而 A 组 BASE 里填了
  // provider/model，config 那一路先命中，怎么坏都绿 —— 所以必须单独用空配置测。
  {
    const port = 17200 + Math.floor(Math.random() * 200)
    process.env.RIN_FILE_PROXY_PORT = String(port)
    const proxy = await startFakeProxy(port)
    const cwd = mkdtempSync(join(root, 'f-'))
    const world = makeBridge(cwd, { base: { provider: '', model: '' } })
    const reply = await say(world, '!qa')
    check('F ★ 配置留空时回落到宿主默认模型', /✅ 模型：deepseek-account \/ deepseek-flash/.test(reply), reply.slice(0, 200))
    // ⚠️ 括号必须转义：`/(空)/` 是**捕获组**，匹配的是"模型：空"三字，
    // 而回执里是"模型：(空)"，中间隔着半个括号 ⇒ 这条断言永远为真，等于没写（11-02 抓到）。
    check('F 没有报 (空)', !/模型：\(空\)/.test(reply), reply.slice(0, 200))
    world.stop(); await proxy.close()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => { delete process.env.RIN_FILE_PROXY_PORT; try { rmSync(root, { recursive: true, force: true }) } catch {} })
