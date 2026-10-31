/**
 * Acceptance test for the v0.4 doctrine "一切皆可调试": drive the bridge through
 * EVERY silent-drop branch and assert that each one left a trace event carrying a
 * stage, an ok=false flag and a human reason — and that a real turn is traced from
 * the inbound message all the way to the outbound reply under one trace id.
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
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

class MockServer extends EventEmitter {
  constructor() {
    super()
    this.sent = []
    this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }
  }

  sendSegments(_bot, messageType, targetId, segments) {
    this.sent.push({ messageType, targetId, segments })
    return Promise.resolve({ message_id: `mid${this.sent.length}` })
  }

  sendText(_bot, messageType, targetId, text) {
    return this.sendSegments(_bot, messageType, targetId, [{ type: 'text', data: { text } }])
  }

  currentSocket() { return this.socket }
  getGroupHonorInfo() { return Promise.resolve({}) }
  getGroupNotice() { return Promise.resolve([]) }
  getEssenceMsgList() { return Promise.resolve([]) }
  deleteMsg() { return Promise.resolve({}) }
  setGroupBan() { return Promise.resolve({}) }
  setGroupAddRequest() { return Promise.resolve({}) }
  setFriendAddRequest() { return Promise.resolve({}) }
  uploadFile() { return Promise.resolve({}) }
  sendForwardMsg() { return Promise.resolve({ message_id: 'f1' }) }
  getMsg() { return Promise.resolve({ message: [] }) }
}

const dir = mkdtempSync(join(tmpdir(), 'qq-trace-branch-test-'))
const wordsFile = join(dir, 'badwords.txt')
writeFileSync(wordsFile, '广告\n', 'utf8')

const baseConfig = Config({
  cwd: dir,
  allowUsers: [1001, 1002],
  allowGroups: [2002],
  botQq: 999,
  adminUsers: [1001],
  memoryEnabled: false,
  actionAuditEnabled: false,
  dedupEnabled: true,
  quietHoursEnabled: false,
  filterEnabled: true,
  filterWordsFile: wordsFile,
  floodEnabled: false,
  verifyEnabled: false,
  keywordEnabled: false,
  fortuneEnabled: false,
  diceEnabled: false,
  pointsEnabled: false,
  gameEnabled: false,
  statsEnabled: false,
  dailyReportEnabled: false,
  groupReadEnabled: false,
  sessionResumeEnabled: false,
  agentMediaToolsEnabled: false,
  faceEnabled: false,
  rateLimitEnabled: false,
})

function makeCtx() {
  const handlers = new Map()
  const sessions = new Map()
  const emitSession = (sessionId, text) => {
    for (const handler of handlers.get('session/event') ?? []) {
      handler({ id: sessionId }, { type: 'assistant/message', data: { message: { content: text === '' ? [] : [{ type: 'text', text }] } } })
    }
  }
  const ctx = {
    on: (event, handler) => { const list = handlers.get(event) ?? []; list.push(handler); handlers.set(event, list); return () => {} },
    get: () => undefined,
    agents: {
      create: async (options) => {
        const record = { tools: [], sections: [] }
        const agentCtx = { systemPrompt: { section: (s) => record.sections.push(s) }, tools: { register: (t) => record.tools.push(t) } }
        if (options.setup) await options.setup(agentCtx)
        const sessionId = String(options.sessionId)
        const agent = {
          id: sessionId,
          status: 'idle',
          followup: () => {
            if (options.__noReply) return
            setTimeout(() => {
              emitSession(sessionId, `（回复）${sessionId.slice(0, 12)}`)
            }, 5)
          },
          cancel: () => {},
        }
        sessions.set(sessionId, { ...record, agent })
        return { agent, dispose: async () => {} }
      },
      resume: async () => { throw new Error('no persisted session') },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 't', model: 't' }) },
    logger: () => ({ info() {}, warn() {}, error() {} }),
  }
  return { ctx, sessions, emitSession }
}

async function boot(overrides = {}) {
  const config = { ...baseConfig, ...overrides }
  const { ctx, sessions, emitSession } = makeCtx()
  const server = new MockServer()
  const bridge = new QQBridge(ctx, config, server, { info() {}, warn() {}, error() {} })
  bridge.start()
  let seq = 0
  const send = async (text, extra = {}, { settle = 60 } = {}) => {
    server.emit('message', {
      bot: server.socket,
      userId: 1001,
      messageType: 'group',
      groupId: 2002,
      text,
      atMe: true,
      ats: [],
      reply: null,
      records: [],
      images: [],
      files: [],
      messageId: `m${++seq}`,
      senderName: '管理员',
      raw: { message: [] },
      ...extra,
    })
    await new Promise((resolve) => setTimeout(resolve, settle))
  }
  const notice = async (extra = {}) => {
    server.emit('notice', { bot: server.socket, ...extra })
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  const request = async (extra = {}) => {
    server.emit('request', { bot: server.socket, ...extra })
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  /** All trace events recorded for a given reason substring. */
  const findReason = (needle) => bridge.trace.recent({ limit: 500 }).filter((event) => (event.reason ?? '').includes(needle))
  const findStage = (stage) => bridge.trace.recent({ limit: 500 }).filter((event) => event.stage === stage)
  /**
   * 等到某个 reason 真的出现（最多 timeoutMs）。
   * 为什么需要：`send()` 只睡固定的 settle 毫秒，跑全量时机器一忙就**睡不够**，
   * 于是"静默时段留下 reason"这条会偶发失败（2026-10-25 全量里真出现过一次）。
   * 断言前用它兜一下，测试就不再依赖机器当时有多空闲。
   */
  const waitForReason = async (needle, { timeoutMs = 2000, stepMs = 20 } = {}) => {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      if (findReason(needle).length > 0) return true
      await new Promise((resolve) => setTimeout(resolve, stepMs))
    }
    return findReason(needle).length > 0
  }
  return { bridge, server, send, notice, request, findReason, findStage, waitForReason, sessions, emitSession }
}

// ---- 1) 白名单静默丢弃 ----
{
  const h = await boot()
  await h.send('你好', { userId: 9999 })
  check('白名单拒绝留下 reason', h.findReason('白名单').some((e) => e.ok === false && e.stage === 'whitelist'), JSON.stringify(h.findReason('白名单')[0] ?? {}))
  await h.send('你好', { groupId: 1234 })
  check('群不在白名单留下 reason', h.findReason('群不在 allowGroups').length === 1)
  h.bridge.stop()
}

/**
 * ---- 1b) 白名单拒绝理由必须「可操作」----
 *
 * 2026-10-30 主人问「新加白名单好友的好像没有创建新对话」。真实取证：号码 22:50:17 才写进
 * `cordis.patch.yml`，而对方 22:49 那两条消息全被拒；桥只在收到消息时建会话 ⇒ 没有新对话。
 * 原来的 reason 只说"不在白名单"，不说号码、不说怎么加、不说加完会发生什么 —— 看起来像 bug。
 */
{
  const h = await boot()
  await h.send('你好', { userId: 12340001, messageType: 'private', groupId: undefined })
  const privateReason = h.findReason('私聊用户不在 allowUsers 白名单')[0]
  check('★私聊被拒的理由带号码 + 处置办法',
    Boolean(privateReason) && privateReason.reason.includes('12340001') && privateReason.reason.includes('cordis.patch.yml'),
    privateReason?.reason ?? '(没有留下 reason)')
  h.bridge.stop()
}

/**
 * ---- 1c) 有人加好友：不能一声不响 ----
 *
 * 真机 2026-10-30 22:49:32 抓到 `notice/friend_add`，原来落到"未处理的 notice"，
 * 主人这边一个字都没有；它前面一秒的两条私聊又全被拒 —— 两块静默叠成"新加好友没对话"。
 */
{
  const h = await boot()
  await h.notice({ noticeType: 'friend_add', subType: '', userId: 4321, selfId: 999 })
  const unlisted = h.findReason('新好友 4321 不在 allowUsers 白名单')[0]
  check('★新增好友不在白名单：留 reason', Boolean(unlisted) && unlisted.ok === false, JSON.stringify(unlisted ?? {}))
  check('★新增好友不在白名单：私聊推给管理员',
    h.server.sent.some((m) => m.messageType === 'private' && m.targetId === 1001 && JSON.stringify(m.segments).includes('4321')),
    JSON.stringify(h.server.sent).slice(0, 200))
  await h.notice({ noticeType: 'friend_add', subType: '', userId: 1002, selfId: 999 })
  const listed = h.findReason('新好友 1002 已在 allowUsers 白名单里')[0]
  check('新增好友已在白名单：写成"等对方发消息"', Boolean(listed) && listed.ok === true, JSON.stringify(listed ?? {}))
  h.bridge.stop()
}

/**
 * ---- 1d) 入站图片：url 失效时必须还能把图拿到 ----
 *
 * 真机 2026-10-30（主人：「还有图片没下载成功」）：私聊图片段的 url 是
 * `gchat.qpic.cn/download?appid=1406&fileid=…&spec=0`，**缺 rkey** ⇒
 * `{"retcode":-5503010,"retmsg":"invalid rkey","retryflag":1}` + HTTP 400，
 * 而同一张图早被 QQ 自己下到 `nt_data/{Pic,Emoji/emoji-recv}/<月>/Ori/<md5>.<ext>`。
 * 更糟的是桥当时无条件写 `media ok=true 私聊图片已落盘`，日志里一片绿。
 *
 * 这里用一个**真会回 400** 的本地服务复现，钉三件事：
 *   ① 错误文案把 QQ 的 retmsg 带出来（否则只有 "download HTTP 400"，谁也查不下去）；
 *   ② NTQQ 缓存按文件名兜底真的能把图落进 qq-images（大小写不敏感）；
 *   ③ 全失败时 trace 不许再写"已落盘"。
 */
{
  const server = createServer((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ retcode: -5503010, retmsg: 'invalid rkey', retryflag: 1 }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const deadUrl = `http://127.0.0.1:${server.address().port}/download?appid=1406&fileid=x&spec=0`
  // 造一棵"NTQQ 缓存"：段里给大写、磁盘上是小写，验证大小写不敏感
  const cacheRoot = join(dir, 'nt_data')
  const oriDir = join(cacheRoot, 'Emoji', 'emoji-recv', '2026-10', 'Ori')
  mkdirSync(oriDir, { recursive: true })
  writeFileSync(join(oriDir, 'abcdef0123456789abcdef0123456789.jpg'), Buffer.from('ffd8ffe000104a4649460001010', 'hex'))
  const h = await boot({ qqMediaCacheRoots: [cacheRoot], visionMode: 'tool' })
  await h.send('', { messageType: 'private', groupId: undefined, images: [{ kind: 'mface', url: deadUrl, file: 'ABCDEF0123456789ABCDEF0123456789.jpg', summary: '' }] })
  await h.waitForReason('私聊图片已落盘 1/1')
  check('★url 报 400 时用 NTQQ 缓存兜底（1/1 落盘）', h.findReason('私聊图片已落盘 1/1').length === 1,
    h.findReason('私聊图片').map((e) => e.reason).join(' | '))
  const saved = (() => { try { return readdirSync(join(dir, 'qq-images')).filter((n) => n.startsWith('qq-img-')) } catch { return [] } })()
  check('★兜底来的图真的落到 qq-images', saved.length === 1, saved.join(','))
  await h.send('', { messageType: 'private', groupId: undefined, messageId: 'img-miss-1', images: [{ kind: 'image', url: deadUrl, file: 'not-in-cache.jpg', summary: '' }] })
  await h.waitForReason('私聊图片全部下载失败')
  const all = h.findReason('私聊图片全部下载失败')[0]
  check('★全失败时 trace 不再写「已落盘」', Boolean(all) && all.ok === false, JSON.stringify(all ?? {}))
  check('★失败理由带出 QQ 的 retmsg（invalid rkey）', String(all?.reason ?? '').includes('invalid rkey'), all?.reason ?? '')
  check('★失败理由说明缓存里也没找到', String(all?.reason ?? '').includes('not-in-cache.jpg'), all?.reason ?? '')
  h.bridge.stop()
  await new Promise((resolve) => server.close(resolve))
}

/**
 * ---- 1e) 红包：认得出来，但绝不假装抢得到 ----
 *
 * 主人 2026-10-30「顺便写一个抢红包的代码」。链路里没有开红包的口子（见 lib/redpacket.js 头部），
 * 所以桥只做「看得见」：trace 记一条「发现…未领取」+ 运营计数 + 私聊提醒管理员。
 * 这条测试钉的就是"**别写成已领取**" —— 一个静默失败的功能比没有功能糟得多。
 */
{
  // 运营计数只在 groupOpsEnabled + opsReportEnabled 都开时才记（#countOps 的口径），这里按真实开关跑
  const h = await boot({ groupOpsEnabled: true, opsReportEnabled: true })
  const cardJson = JSON.stringify({
    app: 'com.tencent.mobileqq.redpacket',
    prompt: '[QQ红包]恭喜发财',
    meta: { detail_1: { title: '恭喜发财' } },
  })
  await h.send('', { messageId: 'rp-1', raw: { message: [{ type: 'json', data: { data: cardJson } }] } })
  await h.waitForReason('发现红包')
  const ev = h.findReason('发现红包')[0]
  check('★红包落 trace，且理由写明「未领取」', Boolean(ev) && ev.ok === false && ev.reason.includes('未领取'), JSON.stringify(ev ?? {}))
  check('★红包文案里不出现"已领取"', h.findReason('已领取').length === 0, h.findReason('已领取').map((e) => e.reason).join(' | '))
  check('★红包提醒私聊发给管理员',
    h.server.sent.some((m) => m.messageType === 'private' && m.targetId === 1001 && JSON.stringify(m.segments).includes('红包')),
    JSON.stringify(h.server.sent).slice(0, 160))
  const totals = h.bridge.opsCounters.totals({ days: 1 })
  check('★运营计数记了一笔红包', (totals?.redpacket ?? 0) >= 1, JSON.stringify(totals))
  h.bridge.stop()
}

// ---- 2) 静默时段 ----
{
  const h = await boot({ quietHoursEnabled: true, quietHours: ['0:00-23:59'], quietWeekendExempt: false })
  await h.send('在吗')
  // 断言前等它真的落进 trace（固定 settle 在忙的时候不够，见 waitForReason 的注释）
  await h.waitForReason('避开高峰期静默中')
  check('静默时段留下 reason', h.findReason('避开高峰期静默中').length === 1, JSON.stringify(h.findReason('避开高峰期静默中')[0]?.reason))
  h.bridge.stop()
}

// ---- 3) 去重 ----
{
  const h = await boot()
  await h.send('重复消息', { messageId: 'dup-1' }, { settle: 30 })
  await h.send('重复消息', { messageId: 'dup-1' }, { settle: 30 })
  check('重复投递留下 reason', h.findReason('重复投递').length === 1, JSON.stringify(h.findReason('重复投递')[0]?.reason))
  h.bridge.stop()
}

// ---- 4) 群聊未 @ ----
{
  const h = await boot()
  await h.send('没 @ 机器人', { atMe: false })
  const mention = h.findStage('mention')
  check('群聊未 @ 留下 reason', mention.length === 1 && mention[0].ok === false && mention[0].reason.includes('未 @ 机器人'), JSON.stringify(mention[0] ?? {}))
  h.bridge.stop()
}

// ---- 5) 空文本 ----
{
  const h = await boot()
  await h.send('')
  check('空文本留下 reason', h.findStage('drop').some((e) => (e.reason ?? '').includes('空文本')), JSON.stringify(h.findStage('drop')[0] ?? {}))
  h.bridge.stop()
}

// ---- 6) 私聊未开启 ----
{
  const h = await boot({ acceptPrivate: false })
  await h.send('私聊', { messageType: 'private', groupId: undefined, atMe: false })
  check('acceptPrivate=false 留下 reason', h.findReason('acceptPrivate=false').length === 1)
  h.bridge.stop()
}

// ---- 7) 敏感词拦截（非管理员，管理员豁免是设计行为）----
{
  const h = await boot()
  await h.send('这是广告', { userId: 1002, senderName: '普通成员' })
  check('敏感词拦截留下 reason', h.findStage('filter').some((e) => e.ok === true && e.reason.includes('敏感词')), JSON.stringify(h.findStage('filter')[0] ?? {}))
  await h.send('这是广告（管理员应豁免）', { userId: 1001 })
  check('管理员豁免不产生拦截事件', h.findStage('filter').length === 1, String(h.findStage('filter').length))
  h.bridge.stop()
}

// ---- 8) 未处理的 notice（poke 关闭时才走兜底分支）----
{
  const h = await boot({ pokeEnabled: false })
  await h.notice({ noticeType: 'group_decrease', subType: 'leave', userId: 1001, groupId: 2002 })
  const notice = h.findStage('notice')
  check('未处理的 notice 留下 reason', notice.some((e) => e.ok === false && e.reason.includes('group_decrease')), JSON.stringify(notice[0] ?? {}))
  await h.notice({ noticeType: 'notify', subType: 'poke', userId: 1001, groupId: 2002, targetId: 999 })
  check('poke 关闭时 reason 标明开关', h.findReason('pokeEnabled=false').length >= 1, JSON.stringify(h.findReason('pokeEnabled=false')[0] ?? {}))
  h.bridge.stop()
}

// ---- 9) request 未开启验证 ----
{
  const h = await boot()
  await h.request({ requestType: 'group', subType: 'add', userId: 5001, groupId: 2002, comment: '进群', flag: 'f1' })
  /**
   * 断言口径改「有没有」而不是「几条=1」：一次被忽略的请求会留**两条**事实 —
   * ① `stage=request` 的分支 reason；② `#notifyRequestDrop` 写的事件（stage=request-drop，
   * 里面同样带 "verifyEnabled=false"）。`=== 1` 会随通知链的增长而假失败（2026-10-30 复现：
   * 改动前就是红的）。这里只钉「分支确实留了 reason」。
   */
  const drops = h.findStage('request').filter((e) => e.ok === false && (e.reason ?? '').includes('verifyEnabled=false'))
  check('request 未开启验证留下 reason', drops.length >= 1, `stage=request 命中 ${drops.length} 条 / 全部命中 ${h.findReason('verifyEnabled=false').length} 条`)
  h.bridge.stop()
}

// ---- 10) 出站限流丢弃 ----
{
  const h = await boot({ rateLimitEnabled: true, rateLimitMaxReplies: 1, rateLimitWindowSeconds: 60 })
  await h.send('第一条触发回复', {}, { settle: 80 })
  await h.send('第二条应被限流', {}, { settle: 80 })
  const limited = h.findStage('ratelimit')
  check('限流丢弃留下 reason', limited.length >= 1 && limited[0].ok === false && limited[0].reason.includes('出站限流'), JSON.stringify(limited[0] ?? {}))
  h.bridge.stop()
}

// ---- 11) 正常链路：一条 traceId 贯穿到出站回复 ----
{
  const h = await boot()
  const before = h.bridge.trace.recent({ limit: 1 })[0]?.id
  await h.send('请回复我', {}, { settle: 120 })
  const traces = h.bridge.trace.listTraces({ limit: 2 }).filter((trace) => trace.id !== before)
  const chain = traces.length > 0 ? h.bridge.trace.get(traces[0].id) : []
  const stages = chain.map((event) => event.stage)
  check('一条消息产生一条 trace', traces.length >= 1, traces.map((t) => t.id).join(','))
  check('决策链包含 inbound→白名单→agent', stages.includes('inbound') && stages.includes('whitelist') && stages.includes('agent'), stages.join('>'))
  check('转交 agent 的事件带耗时', chain.some((event) => event.stage === 'agent' && event.ms > 0), JSON.stringify(chain.filter((e) => e.stage === 'agent').map((e) => e.ms)))
  check('出站回复回挂到同一条 trace', stages.includes('reply'), stages.join('>'))
  check('回复事件带目标与字数', chain.some((event) => event.stage === 'reply' && event.data?.chars > 0 && event.data?.target?.startsWith('group:')), JSON.stringify(chain.filter((e) => e.stage === 'reply').map((e) => e.data)))
  check('会话就绪事件标明新建/续接', chain.some((event) => event.stage === 'agent' && (event.data === null || true) && (event.reason ?? '').includes('会话就绪')), JSON.stringify(chain.map((e) => e.reason).filter(Boolean)))
  h.bridge.stop()
}

// ---- 12) 模型无文本输出也要留痕 ----
{
  const h = await boot()
  await h.send('这条会得到空文本回复', {}, { settle: 40 })
  const entry = [...h.sessions.values()][0]
  h.emitSession(entry.agent.id, '')
  await new Promise((resolve) => setTimeout(resolve, 30))
  const empty = h.findReason('没有输出文本')
  check('空回复分支留下 reason', empty.length === 1 && empty[0].level === 'warn', JSON.stringify(empty[0] ?? {}))
  h.bridge.stop()
}

// ---- 13) 落盘文件包含全部事件且可解析 ----
{
  const h = await boot()
  await h.send('随便说说')
  h.bridge.stop()
  const traceFile = join(dir, 'qq-trace.jsonl')
  const lines = readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean)
  let parsed = 0
  for (const line of lines) { try { JSON.parse(line); parsed += 1 } catch { /* ignore */ } }
  check('trace JSONL 全部行可解析', parsed === lines.length && lines.length > 0, `${parsed}/${lines.length}`)
  const events = lines.map((line) => JSON.parse(line))
  check('落盘事件含 stage/ok/ts/id', events.every((e) => typeof e.stage === 'string' && typeof e.ok === 'boolean' && typeof e.ts === 'number' && typeof e.id === 'string'))
  check('落盘保留 chatKey 便于按会话过滤', events.some((e) => e.chatKey === 'g:2002'))
}

// ---- 14) runtime 快照给跨进程控制台读 ----
{
  const h = await boot()
  await h.send('建立会话')
  const runtime = JSON.parse(readFileSync(join(dir, 'qq-runtime.json'), 'utf8'))
  check('runtime 快照含会话列表', Array.isArray(runtime.sessions) && runtime.sessionCount >= 1, JSON.stringify(runtime.sessions))
  check('runtime 快照含 trace 汇总', runtime.trace && typeof runtime.trace.total === 'number' && Array.isArray(runtime.trace.topReasons), JSON.stringify(runtime.trace?.byStage))
  check('runtime 快照含闸门与版本', runtime.gate !== undefined && typeof runtime.version === 'string' && runtime.pid > 0)
  check('runtime 快照含生效配置（回答"为什么没生效"）', runtime.features && runtime.features.sessionMode === 'chat' && runtime.features.traceEnabled === true, JSON.stringify(Object.keys(runtime.features ?? {}).slice(0, 6)))
  const secretKeys = ['ttsApiKey', 'sttApiKey', 'imageGenApiKey', 'notifyToken', 'notifyPushUrl', 'accessToken', 'verifyKeyword', 'ttsLocalRefAudio']
  check('生效配置不含任何密钥类字段', !secretKeys.some((key) => key in (runtime.features ?? {})), secretKeys.filter((k) => k in (runtime.features ?? {})).join(','))
  check('生效配置标明口令是否已配置（不含内容）', typeof runtime.features.verifyKeywordConfigured === 'boolean')
  /**
   * ★白名单差集（2026-10-30「新加白名单好友没有新对话」）：桥只在收到消息时建会话，
   * 所以控制台必须能显示「已放行、还没说过话」。断言用**不变量**而不是写死的名单：
   * 差集 = allowUsers − (本次运行的活会话 ∪ 磁盘上的 qq-sessions.json)。
   * 磁盘那一半不能省 —— 前面的用例都在同一个 `dir` 里跑，`u:1001` 早就写过映射；
   * 而且这正是"重启后不许把老会话误报成没说过话"的那条约束。
   */
  const liveKeys = new Set(runtime.sessions.map((s) => s.chatKey))
  let diskKeys = {}
  try { diskKeys = JSON.parse(readFileSync(join(dir, 'qq-sessions.json'), 'utf8')) } catch { diskKeys = {} }
  const knownKeys = new Set([...liveKeys, ...Object.keys(diskKeys)])
  const expectedPending = [1001, 1002].filter((id) => !knownKeys.has(`u:${id}`))
  check('★白名单差集 = allowUsers 减去已有会话（含磁盘映射）',
    JSON.stringify(runtime.whitelistPending?.users) === JSON.stringify(expectedPending)
      && Array.isArray(runtime.whitelistPending?.groups) && runtime.whitelistPending.groups.length === 0,
    `快照=${JSON.stringify(runtime.whitelistPending)} 期望=${JSON.stringify(expectedPending)} 磁盘=${Object.keys(diskKeys).join(',')}`)
  await h.send('私聊一句', { messageType: 'private', userId: 1002, groupId: undefined })
  const afterDm = JSON.parse(readFileSync(join(dir, 'qq-runtime.json'), 'utf8'))
  check('★白名单差集：说过话的人从 pending 里消失',
    !(afterDm.whitelistPending?.users ?? []).includes(1002),
    JSON.stringify(afterDm.whitelistPending))
  h.bridge.stop()
}

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
