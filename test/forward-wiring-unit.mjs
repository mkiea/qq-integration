/**
 * 合并转发（聊天记录）的**接线**测试 —— 2026-11-02 深夜。
 *
 * 为什么单独一个：`forward-unit` 测的是 `lib/forward.js` 里的纯函数（载荷归一化、排版），
 * 而这次坏掉的是**接线**：桥把 base64 的 `resId` 当成 `message_id` 送给后端，
 * 后端拿它去问内核，内核要的是**真 msgId + 真 peer**（私聊还是 uid 不是 QQ 号）。
 * 两者一错就 `result=5 / msgList 空`，**不报错**，用户看到的就是"聊天记录发不过去"。
 *
 * 这一组钉四件事：
 *   A 转发段里的 `msg_id` 不许在解析时丢掉
 *   B 展开时要把 `msg_id` + `user_id`（私聊）/ `group_id`（群）一起送过去
 *   C 只有 resId 的旧载荷仍然照常发（向后兼容，不许直接报错）
 *   D `lib/onebot.js` 真的把这些字段拼进 params（源码级断言：这几行被删掉时本组会红）
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { QQBridge } from '../lib/bridge.js'
import { Config } from '../lib/index.js'
import { parseMessage } from '../lib/onebot.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const here = dirname(fileURLToPath(import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'qq-fwd-wiring-'))

class MockServer extends EventEmitter {
  constructor() {
    super()
    this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }
    this.forwardCalls = []
  }
  currentSocket() { return this.socket }
  async sendSegments() { return { message_id: 1 } }
  async sendText() { return { message_id: 1 } }
  async callAction() { return { ok: true } }
  async getLoginInfo() { return { user_id: 3000000001, nickname: 'bot' } }
  async getStatus() { return { online: true, good: true } }
  async canSendImage() { return { yes: true } }
  async canSendRecord() { return { yes: true } }
  /** 记录展开调用时带的所有扩展字段。 */
  async getForwardMsg(socket, id, extra = {}) {
    this.forwardCalls.push({ id, extra })
    return { messages: [{ type: 'node', data: { name: '甲', uin: 2000000001, time: 1700000000, content: [{ type: 'text', data: { text: '记录内容' } }] } }] }
  }
}

const BASE = {
  host: '127.0.0.1', port: 0, accessToken: '', allowUsers: [2000000001], allowGroups: [100000001],
  botQq: 3000000001, botName: 'bot', replyOnlyWhenMentioned: false, acceptPrivate: true,
  sessionMode: 'chat', sessionResumeEnabled: false, quietHours: [], quietHoursEnabled: false,
  notifyEnabled: false, injectEnabled: false, recordInbound: false, traceEnabled: false,
  proactiveEnabled: false, adminEnabled: false, rateLimitEnabled: false, filterEnabled: false,
  provider: 'test', model: 'test',
}

function makeWorld() {
  const server = new MockServer()
  const ctx = {
    on: () => () => {},
    get: () => undefined,
    agents: {
      create: async ({ sessionId }) => ({
        agent: { id: String(sessionId), status: 'idle', followup: async () => {}, cancel() {} },
        sessionId: String(sessionId), dispose: async () => {},
      }),
      resume: async ({ resumeSessionId }) => ({
        agent: { id: String(resumeSessionId), status: 'idle', followup: async () => {}, cancel() {} },
        sessionId: String(resumeSessionId), dispose: async () => {},
      }),
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    logger: () => ({ info() {}, warn() {}, error() {} }),
  }
  const bridge = new QQBridge(ctx, { ...Config({}), ...BASE, cwd: root }, server, { info() {}, warn() {}, error() {} })
  bridge.start()
  return { bridge, server }
}

function message(extra = {}) {
  return {
    bot: null,
    userId: 2000000001,
    messageType: 'private',
    text: '',
    atMe: false, ats: [], reply: null,
    records: [], images: [], files: [], videos: [],
    messageId: 'm-fwd-1',
    senderName: '主人',
    raw: { message: [] },
    ...extra,
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ─────────────────────────── A/B. 私聊：带 msg_id ⇒ 三个扩展字段都要送到
{
  const world = makeWorld()
  world.server.emit('message', message({ forwards: [{ id: 'RESID_ABC', msgId: '7703573691727438381' }] }))
  await sleep(400)
  const call = world.server.forwardCalls.at(-1)
  check('A 私聊：转发卡片被展开（调了 get_forward_msg）', Boolean(call), JSON.stringify(world.server.forwardCalls))
  check('B ★私聊：把真 msg_id 送到后端', call?.extra?.msgId === '7703573691727438381', JSON.stringify(call?.extra))
  check('B 私聊：带上 user_id（后端据此换 uid）', String(call?.extra?.userId ?? '') === '2000000001', JSON.stringify(call?.extra))
  check('B 私聊：不带 group_id（别把私聊当群）', String(call?.extra?.groupId ?? '') === '', JSON.stringify(call?.extra))
  world.bridge.stop()
}

// ─────────────────────────── B2. 群聊：带 group_id
{
  const world = makeWorld()
  world.server.emit('message', message({
    messageType: 'group', groupId: 100000001, atMe: true, ats: [3000000001], text: '',
    forwards: [{ id: 'RESID_G', msgId: '7703573691727438999' }],
  }))
  await sleep(400)
  const call = world.server.forwardCalls.at(-1)
  check('B2 ★群聊：带上 group_id', String(call?.extra?.groupId ?? '') === '100000001', JSON.stringify(call?.extra))
  check('B2 群聊：msg_id 同样送到', call?.extra?.msgId === '7703573691727438999', JSON.stringify(call?.extra))
  world.bridge.stop()
}

// ─────────────────────────── C. 只有 resId 的旧载荷：不许直接放弃
{
  const world = makeWorld()
  world.server.emit('message', message({ forwards: [{ id: 'ONLY_RESID' }] }))
  await sleep(400)
  const call = world.server.forwardCalls.at(-1)
  check('C 只有 resId 时仍然去展开（向后兼容）', call?.id === 'ONLY_RESID', JSON.stringify(call))
  check('C 只有 resId 时 msgId 为空串而不是 undefined', String(call?.extra?.msgId ?? '') === '', JSON.stringify(call?.extra))
  world.bridge.stop()
}

// ─────────────────────────── D. 源码级：onebot 真的把扩展字段拼进 params
{
  const src = readFileSync(join(here, '..', 'lib', 'onebot.js'), 'utf8')
  const fn = /getForwardMsg\(socket, id, extra = \{\}\) \{[\s\S]*?\n  \}/.exec(src)?.[0] ?? ''
  check('D ★onebot.getForwardMsg 会拼 msg_id', /params\.msg_id\s*=/.test(fn), fn.slice(0, 120))
  check('D onebot.getForwardMsg 会拼 user_id', /params\.user_id\s*=/.test(fn))
  check('D onebot.getForwardMsg 会拼 group_id', /params\.group_id\s*=/.test(fn))
  check('D onebot.getForwardMsg 仍然发 message_id（老后端兼容）', /message_id:\s*String\(id\)/.test(fn))

  // 桥侧解析：forward 段必须留 msg_id，否则 A/B 全白搭
  const bridgeSrc = readFileSync(join(here, '..', 'lib', 'bridge.js'), 'utf8')
  check('D ★桥侧解析保留 forward 段的 msg_id',
    /segment\.data\?\.msg_id/.test(bridgeSrc), /segment\.data\?\.msg_id/.test(bridgeSrc) ? '' : '没找到 segment.data?.msg_id')
}

// ─────────────────────────── E. 真实解析器（lib/onebot.js parseMessage）不许丢 msg_id
// 这一组是**行为**断言，不是源码正则：直接喂一帧 OneBot 原始消息。
// 教训：一开始我只改了 bridge 里那段解析，可真实入站走的是这里，`msg_id` 在进桥之前就没了 ——
// 源码正则能钉住这一行不被删，行为断言能钉住"喂进去还在"，两个都要。
{
  const frame = [{ type: 'forward', data: { id: 'RESID_ONLY_IN_SEG', msg_id: '7703573691727438381' } }]
  const parsed = parseMessage(frame, 3000000001)
  check('E ★parseMessage 保留 forward 段的 msg_id',
    String(parsed?.forwards?.[0]?.msgId ?? '') === '7703573691727438381',
    JSON.stringify(parsed?.forwards))
  check('E parseMessage 同时保留 resId', String(parsed?.forwards?.[0]?.id ?? '') === 'RESID_ONLY_IN_SEG',
    JSON.stringify(parsed?.forwards))

  // 老后端只给 id：不许因此丢整张卡
  const oldShape = parseMessage([{ type: 'forward', data: { id: 'ONLY_ID' } }], 3000000001)
  check('E 只有 id 的老载荷仍被接受', String(oldShape?.forwards?.[0]?.id ?? '') === 'ONLY_ID',
    JSON.stringify(oldShape?.forwards))
  check('E 老载荷的 msgId 是空串而不是 undefined', String(oldShape?.forwards?.[0]?.msgId ?? '') === '',
    JSON.stringify(oldShape?.forwards))
}

console.log(`\n${passed} passed, ${failed} failed`)
try { rmSync(root, { recursive: true, force: true }) } catch {}
process.exit(failed > 0 ? 1 : 0)
