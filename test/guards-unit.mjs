/**
 * Bridge-level tests for the moderation pack: anti-recall, sensitive words and
 * the flood guard. Drives a real QQBridge through a mock OneBot server, so no
 * DSH host, no network and no model calls are involved.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QQBridge, allowsChat } from '../lib/bridge.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

class MockServer extends EventEmitter {
  constructor() {
    super()
    this.sent = []
    this.calls = []
    this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }
  }

  sendSegments(_bot, messageType, targetId, segments) {
    this.sent.push({ messageType, targetId, segments })
    return Promise.resolve({ message_id: this.sent.length })
  }

  sendText(_bot, messageType, targetId, text) {
    return this.sendSegments(_bot, messageType, targetId, [{ type: 'text', data: { text } }])
  }

  setGroupBan(_socket, groupId, userId, duration) {
    this.calls.push({ action: 'ban', groupId, userId, duration })
    return Promise.resolve({})
  }

  deleteMsg(_socket, messageId) {
    this.calls.push({ action: 'delete', messageId })
    return Promise.resolve({})
  }

  currentSocket() { return this.socket }
  uploadFile() { return Promise.resolve({}) }
  sendForwardMsg() { return Promise.resolve({ message_id: 9999 }) }
  getMsg() { return Promise.resolve({ message: [] }) }
}

const dir = mkdtempSync(join(tmpdir(), 'qq-guards-test-'))
const wordsFile = join(dir, 'qq-badwords.txt')
writeFileSync(wordsFile, ['# 测试词表', '广告', 're:加\\s*群\\s*送'].join('\n'), 'utf8')

const config = {
  cwd: dir,
  host: '127.0.0.1',
  port: 0,
  allowUsers: [1001, 1002, 1003],
  allowGroups: [2002],
  botQq: 999,
  botName: '小鲸鱼',
  replyOnlyWhenMentioned: true,
  acceptPrivate: true,
  autoCollectStickers: false,
  faceEnabled: false,
  sessionMode: 'chat',
  maxMessageLength: 1700,
  dedupEnabled: true,
  dedupWindowSeconds: 300,
  memoryEnabled: false,
  reminderEnabled: false,
  adminEnabled: true,
  adminUsers: [1001],
  voteEnabled: false,
  todoEnabled: false,
  summaryEnabled: false,
  exportEnabled: false,
  checkinEnabled: false,
  quietHoursEnabled: false,
  imageGenEnabled: false,
  ttsEnabled: false,
  sttEnabled: false,
  sessionResumeEnabled: false,
  agentMediaToolsEnabled: false,
  actionAuditEnabled: false,
  keywordEnabled: false,
  fortuneEnabled: false,
  diceEnabled: false,
  pointsEnabled: false,
  gameEnabled: false,
  pokeEnabled: false,
  welcomeEnabled: false,
  antiRecallEnabled: true,
  antiRecallInGroup: true,
  antiRecallImages: true,
  antiRecallCacheSize: 10,
  antiRecallMaxAgeMinutes: 120,
  antiRecallCooldownSeconds: 1,
  filterEnabled: true,
  filterWordsFile: wordsFile,
  filterAction: 'warn',
  filterMuteSeconds: 300,
  filterWhitelist: ['加群送福利社'],
  floodEnabled: true,
  floodWindowSeconds: 10,
  floodMaxMessages: 3,
  floodMuteSeconds: 60,
  floodStrikeLimit: 2,
  fileSendDirs: [],
  fileSendMaxBytes: 52428800,
  imageSendMaxBytes: 4194304,
  recallWindowSeconds: 110,
  forwardLongReplies: false,
  forwardThresholdChars: 600,
  actionRatePerMinute: 60,
  actionRatePerDay: 1000,
  rateLimitEnabled: false,
}

let agentCalls = 0
const ctx = {
  on: () => () => {},
  get: () => undefined,
  agents: { create: async () => { agentCalls++; throw new Error('agent should not be created in these tests') } },
  agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
  logger: () => ({ info() {}, warn() {}, error() {} }),
}

const server = new MockServer()
const bridge = new QQBridge(ctx, config, server, { info() {}, warn() {}, error() {} })
bridge.start()

let seq = 0
function groupMessage(text, extra = {}) {
  return {
    bot: server.socket,
    userId: 1002,
    messageType: 'group',
    groupId: 2002,
    text,
    atMe: true,
    ats: [],
    reply: null,
    records: [],
    images: [],
    files: [],
    messageId: `g${++seq}`,
    senderName: '小明',
    raw: { message: [] },
    ...extra,
  }
}

async function send(message) {
  const before = server.sent.length
  server.emit('message', message)
  await new Promise((resolve) => setTimeout(resolve, 30))
  return server.sent.slice(before).map((item) => item.segments.map((segment) => segment.data?.text ?? `[${segment.type}]`).join('')).join('\n')
}

// ---- 防撤回 ----
const first = groupMessage('今晚八点开黑', { messageId: 'r1' })
await send(first)
server.emit('notice', { bot: server.socket, noticeType: 'group_recall', groupId: 2002, userId: 1002, operatorId: 1002, messageId: 'r1' })
await new Promise((resolve) => setTimeout(resolve, 40))
const recallPost = server.sent.map((item) => item.segments.map((s) => s.data?.text ?? '').join('')).join('\n')
check('撤回后补发内容', recallPost.includes('撤回') && recallPost.includes('今晚八点开黑'), recallPost.trim().slice(-40))

// 撤回自己（机器人）的消息不补发
const beforeBotsRecall = server.sent.length
await send(groupMessage('机器人自己的话', { messageId: 'r2' }))
server.emit('notice', { bot: server.socket, noticeType: 'group_recall', groupId: 2002, userId: 999, operatorId: 999, messageId: 'r2' })
await new Promise((resolve) => setTimeout(resolve, 40))
check('机器人自己撤回不补发', server.sent.length === beforeBotsRecall + 1, `${server.sent.length - beforeBotsRecall} 条`)

// 未缓存的消息撤回：静默
const beforeUnknown = server.sent.length
server.emit('notice', { bot: server.socket, noticeType: 'group_recall', groupId: 2002, userId: 1002, operatorId: 1002, messageId: 'not-cached' })
await new Promise((resolve) => setTimeout(resolve, 40))
check('未缓存消息撤回静默', server.sent.length === beforeUnknown)

// ---- 敏感词（刷屏守卫先关掉，避免抢占判定）----
config.floodEnabled = false
const callsBeforeFilter = agentCalls
const hitWord = await send(groupMessage('这个广告太烦了'))
check('敏感词命中被拦下（不再进模型）', hitWord.includes('敏感词') && agentCalls === callsBeforeFilter, hitWord.trim())
const hitRegex = await send(groupMessage('快加群送皮肤'))
check('正则词条命中', hitRegex.includes('敏感词'), hitRegex.trim())
const whitelisted = await send(groupMessage('加群送福利社'), { messageId: 'w1' })
check('白名单放行（进入模型前的其它分支）', !whitelisted.includes('敏感词'), whitelisted.trim().slice(0, 30))
const adminBypass = await send(groupMessage('我是管理员发广告', { userId: 1001 }))
check('管理员豁免敏感词', !adminBypass.includes('敏感词'), adminBypass.trim().slice(0, 30))

// filterAction: recall
config.filterAction = 'recall'
const recalled = await send(groupMessage('再发一次广告', { messageId: 'r3' }))
check('filterAction=recall 撤回消息', recalled.includes('已撤回') && server.calls.some((call) => call.action === 'delete' && call.messageId === 'r3'), recalled.trim())

// filterAction: mute
config.filterAction = 'mute'
const muted = await send(groupMessage('还要发广告', { messageId: 'r4' }))
check('filterAction=mute 禁言', muted.includes('禁言') && server.calls.some((call) => call.action === 'ban' && call.userId === 1002 && call.duration === 300), muted.trim())
config.filterAction = 'warn'

// ---- 刷屏（敏感词关掉，单看守卫）----
const floodUser = 1003
config.filterEnabled = false
config.floodEnabled = true
const floodLines = []
for (let i = 0; i < 6; i++) floodLines.push(await send(groupMessage(`刷屏${i}`, { userId: floodUser, messageId: `f${i}` })))
const warned = floodLines.filter((line) => line.includes('刷屏会被禁言')).length
const floodMuted = floodLines.some((line) => line.includes('冷静'))
check('刷屏先警告', warned >= 1, `warn=${warned}`)
check('连续刷屏后被禁言', floodMuted && server.calls.some((call) => call.action === 'ban' && call.userId === floodUser && call.duration === 60), JSON.stringify(server.calls.filter((c) => c.action === 'ban')))

// ---- 词表热重载 ----
config.floodEnabled = false
config.filterEnabled = true
writeFileSync(wordsFile, '新敏感词\n', 'utf8')
const reloaded = await send(groupMessage('这里出现新敏感词'))
check('词表改动后热重载', reloaded.includes('敏感词'), reloaded.trim())

/**
 * ★ v0.6.8（用户 2026-10-20「不需要添加白名单的功能，会理会所有的群聊和会话，但是群聊还是要 @ 的」）：
 *   白名单判定抽成纯函数 `allowsChat`，这里把矩阵钉死。
 *   ⚠️ "群里仍然要 @" 是 `replyOnlyWhenMentioned` 的事，**不在**这个函数里——所以这里只确认放行/拒绝。
 */
{
  const base = { allowUsers: [1001], allowGroups: [2002], allowAllChats: false }
  const priv = (userId) => ({ messageType: 'private', userId })
  const grp = (groupId, userId) => ({ messageType: 'group', groupId, userId })
  check('白名单：私聊命中放行、没命中拒绝',
    allowsChat(base, priv(1001)) === true && allowsChat(base, priv(1003)) === false)
  check('白名单：群命中放行；成员不在 allowUsers 时拒绝；群不在 allowGroups 时拒绝',
    allowsChat(base, grp(2002, 1001)) === true
    && allowsChat(base, grp(2002, 1003)) === false
    && allowsChat(base, grp(9999, 1001)) === false)
  check('白名单全空 = 全部拒绝（安全默认）',
    allowsChat({ allowUsers: [], allowGroups: [], allowAllChats: false }, priv(1001)) === false
    && allowsChat({ allowUsers: [], allowGroups: [], allowAllChats: false }, grp(2002, 1001)) === false)
  check('★回应所有人：所有私聊与所有群都放行（名单为空也一样）',
    allowsChat({ allowUsers: [], allowGroups: [], allowAllChats: true }, priv(1003)) === true
    && allowsChat({ allowUsers: [], allowGroups: [], allowAllChats: true }, grp(9999, 1003)) === true)
  check('回应所有人不影响"验证期答题放行"的语义（verifyPending 仍按实参走）',
    allowsChat({ allowUsers: [], allowGroups: [], allowAllChats: false }, priv(1004), { verifyPending: true }) === true
    && allowsChat({ allowUsers: [], allowGroups: [], allowAllChats: false }, priv(1004), { verifyPending: false }) === false)

  /**
   * ★ 2026-10-31（用户「群聊其他用户跟他聊天不回应」）：
   *   群成员是否也要进 `allowUsers`，从"藏在代码里的规则"变成显式开关 `groupCheckMembers`。
   *
   * 三条必须钉住的东西：
   *   ① 默认（配置里**没有**这个键）= 老行为 ⇒ 不校验就没有回归；
   *   ② 关掉 ⇒ 白名单群里任何成员都放行，但**群白名单照旧**、私聊不受影响；
   *   ③ 关掉也**不能**把"群里没 @ 也回"带出来 —— 那是 replyOnlyWhenMentioned 的事，不在这个函数里。
   */
  check('默认（没有 groupCheckMembers 键）⇒ 沿用老行为：群成员仍要在 allowUsers 里',
    allowsChat(base, grp(2002, 1003)) === false
    && allowsChat({ ...base, groupCheckMembers: true }, grp(2002, 1003)) === false)
  check('关掉 groupCheckMembers ⇒ 白名单群里任何成员都放行',
    allowsChat({ ...base, groupCheckMembers: false }, grp(2002, 1003)) === true,
    '')
  check('关掉成员校验**不**放松群白名单：名单外的群仍然拒绝',
    allowsChat({ ...base, groupCheckMembers: false }, grp(9999, 1003)) === false)
  check('关掉成员校验**不**影响私聊：陌生人私聊照样拒绝',
    allowsChat({ ...base, groupCheckMembers: false }, priv(1003)) === false)
  check('allowUsers 为空 + 关掉成员校验 ⇒ 群里照样放行（不再有"名单空=谁都不行"的死结）',
    allowsChat({ allowUsers: [], allowGroups: [2002], allowAllChats: false, groupCheckMembers: false }, grp(2002, 1003)) === true)
}

/**
 * ★ 端到端复核（2026-10-31 用户「群聊其他用户跟他聊天不回应」）。
 *
 * 只测纯函数不够：键名写错、桥没把这个 config 传下去、或者门禁顺序不对，
 * `allowsChat` 那几行照样全绿。这里拿 `agentCalls` 当探针 ——
 * `ctx.agents.create` 会**先 +1 再抛**，所以"计数涨了"就等于"真的过了白名单与 @ 两道闸、
 * 进到模型这一层了"，不需要真模型。
 */
{
  bridge.config.groupCheckMembers = true
  const beforeStrict = agentCalls
  await send(groupMessage('在吗', { userId: 3003, atMe: true }))
  check('端到端·默认档：群成员不在 allowUsers ⇒ 连 agent 都不建（历史行为没被改掉）',
    agentCalls === beforeStrict, `agentCalls ${beforeStrict}→${agentCalls}`)

  bridge.config.groupCheckMembers = false
  const beforeOpen = agentCalls
  await send(groupMessage('在吗', { userId: 3003, atMe: true }))
  check('端到端·关掉成员校验：陌生人 @ 它也能进到模型这一层（就是这次要的行为）',
    agentCalls === beforeOpen + 1, `agentCalls ${beforeOpen}→${agentCalls}`)
  bridge.config.groupCheckMembers = true
}

bridge.stop()
rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
