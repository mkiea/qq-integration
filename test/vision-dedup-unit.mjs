/**
 * 附图去重（2026-11-03，主人要求"顺便做一下图片去重"）。
 *
 * 为什么要单独测：同一张图会从多条路径进来（主消息 / 引用 / 转发节点 / 视频帧，
 * 或者群里同一张图被转两次）。不去重就会**重复附图、重复占预算**（4 张预算里 2 张是同一张），
 * 而且模型会以为"他发了两次"。这类错不会报错，只会让她的回答莫名其妙。
 *
 * 判据（跑之前写死）：
 *   D1 同一张图（内容相同、URL 不同）只挂一次
 *   D2 不同图各自都挂上
 *   D3 去重按**内容**而不是 URL（URL 带 rkey/时间戳，每次都变）
 */
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
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

// 两张**内容不同**的 1x1 PNG
const PNG_A = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const PNG_B = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

/** 本地图片服务：/a 与 /a2 返回同一份字节（不同 URL），/b 返回另一张。 */
const server = createServer((req, res) => {
  const body = req.url === '/b' ? PNG_B : PNG_A
  res.writeHead(200, { 'content-type': 'image/png', 'content-length': body.length })
  res.end(body)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const urlA = `http://127.0.0.1:${port}/a`
const urlA2 = `http://127.0.0.1:${port}/a2`
const urlB = `http://127.0.0.1:${port}/b`

const root = mkdtempSync(join(tmpdir(), 'qq-dedup-'))
const saved = []
const turns = []

class MockServer extends EventEmitter {
  constructor() { super(); this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} } }
  currentSocket() { return this.socket }
  async sendSegments() { return { message_id: 1 } }
  async sendText() { return { message_id: 1 } }
  async callAction() { return { ok: true } }
  async getLoginInfo() { return { user_id: 3000000001, nickname: 'bot' } }
  async getStatus() { return { online: true } }
  async canSendImage() { return { yes: true } }
  async canSendRecord() { return { yes: true } }
}

const ctx = {
  on: () => () => {},
  get: (name) => (name === 'attachments'
    ? {
        saveImages: async (images) => {
          for (const img of images) saved.push({ bytes: img.data.length, name: img.name })
          return images.map((_, i) => ({ id: `att-${saved.length + i}` }))
        },
      }
    : undefined),
  agents: {
    create: async ({ sessionId }) => ({
      agent: {
        id: String(sessionId), status: 'idle',
        followup: async (message) => { turns.push(message) },
        cancel() {},
      },
      sessionId: String(sessionId), dispose: async () => {},
    }),
    resume: async ({ resumeSessionId }) => ({
      agent: { id: String(resumeSessionId), status: 'idle', followup: async (m) => { turns.push(m) }, cancel() {} },
      sessionId: String(resumeSessionId), dispose: async () => {},
    }),
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
  logger: () => ({ info() {}, warn() {}, error() {} }),
}

const BASE = {
  host: '127.0.0.1', port: 0, accessToken: '', allowUsers: [2000000001], allowGroups: [100000001],
  botQq: 3000000001, botName: 'bot', replyOnlyWhenMentioned: false, acceptPrivate: true,
  sessionMode: 'chat', sessionResumeEnabled: false, quietHours: [], quietHoursEnabled: false,
  traceEnabled: false, proactiveEnabled: false, adminEnabled: false, rateLimitEnabled: false,
  filterEnabled: false, visionMode: 'native', provider: 'test', model: 'test',
}

const bridge = new QQBridge(ctx, { ...Config({}), ...BASE, cwd: root }, new MockServer(), { info() {}, warn() {}, error() {} })
bridge.start()

const img = (url) => ({ url, file: '', path: '' })
const message = (images) => ({
  bot: null, userId: 2000000001, messageType: 'private', text: '看这几张',
  atMe: false, ats: [], reply: null,
  records: [], images, files: [], forwards: [], videos: [],
  messageId: `dedup-${Date.now()}`, senderName: '主人', raw: { message: [] },
})

bridge.server.emit('message', message([img(urlA), img(urlA2), img(urlB)]))
await new Promise((r) => setTimeout(r, 1500))

const lastTurn = turns.at(-1)
const blocks = (lastTurn?.content ?? []).filter((b) => b?.type === 'image')
check('D1 ★同一张图（URL 不同）只挂一次', blocks.length === 2, `挂了 ${blocks.length} 张`)
check('D2 不同图各自挂上', blocks.length === 2 && saved.length === 2, JSON.stringify(saved.map((s) => s.bytes)))
check('D3 去重按内容而非 URL（两条 URL 内容相同）', urlA !== urlA2 && blocks.length === 2, `${urlA !== urlA2}`)

// 第二轮：确认去重只在**本轮**生效（同一张图下一轮仍应重挂，不能被永久缓存吞掉）
saved.length = 0
bridge.server.emit('message', message([img(urlA)]))
await new Promise((r) => setTimeout(r, 1200))
check('D4 去重不跨轮（同一张图下一轮仍会挂上）', saved.length === 1, `本轮挂 ${saved.length} 张`)

bridge.stop()
server.close()
console.log(`\n${passed} passed, ${failed} failed`)
try { rmSync(root, { recursive: true, force: true }) } catch {}
process.exit(failed > 0 ? 1 : 0)
