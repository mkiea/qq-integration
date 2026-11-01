/**
 * int64 消息 id 不许丢精度（2026-11-01）。
 *
 * 为什么单独一个套件：这是**用户唯一能看到的症状是"引用卡片看不到"**的那类事故 ——
 * 代码不报错、日志只说"没取到"，看起来永远像"消息太旧 / 权限不够"。
 * 真机取证：
 *   quote resolve: id=7703053729802896443 got=null segments=0 types=[]
 *   Number('7703053729802896443') → 7703053729802896000   ← 低几位被静默改掉
 * QQ 消息 id 是 int64，19 位值远超 `Number.MAX_SAFE_INTEGER`，`Number()` 之后
 * `get_msg` 去查一个**根本不存在的 id**，于是永远返回 null。
 *
 * 所以这里测的不是"能取到消息"，而是**发到线上那一帧里的 id 字符串有没有被改过**：
 *   A. 真 WebSocket 往返 —— 断言帧里 `params.message_id` 是原样的字符串，且能取回内容；
 *   B. 失败必须抛错，不能被吞成"没取到"（吞了就等于重新制造同一个静默故障）；
 *   C. 能无损表示的小 id 仍要能回退成 number（旧行为不许被这次修改弄坏）；
 *   D. dry-run 记录的其他四个调用点（撤回 / 精华 / 取消精华 / 表情回应）同样不许改数。
 * B、C 是 A 的反面对照：只有 A 过，说明不了"这条路会失败"也不会"会回退"。
 */
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { OneBotServer } from '../lib/onebot.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const BIG_ID = '7703053729802896443'
const SMALL_ID = '1234567890'

// 先钉死"这个 bug 是真的"：否则下面的断言可能只是在测一个不存在的问题
check('★★ 前提：19 位 id 用 Number 转换会丢精度（这就是那个 bug）',
  String(Number(BIG_ID)) !== BIG_ID, `Number → ${String(Number(BIG_ID))}`)
check(' 对照：10 位 id 用 Number 转换无损（说明不是所有 id 都坏）',
  String(Number(SMALL_ID)) === SMALL_ID)

const PORT = 16900 + Math.floor(Math.random() * 90)
const logger = { info() {}, warn() {}, error() {} }
const server = new OneBotServer({ host: '127.0.0.1', port: PORT, accessToken: '', botQq: 999 }, logger)

let botSocket = null
server.on('bot-connect', (socket) => { botSocket = socket })
await server.start()

const client = new WebSocket(`ws://127.0.0.1:${PORT}`)
await once(client, 'open')
await new Promise((resolve) => setTimeout(resolve, 80))

/**
 * 假 NapCat：记录每一帧，并按 `mode` 决定怎么回。
 *   · 'ok'     —— 回 {status:'ok', retcode:0, data:{message:[...]}}
 *   · 'null'   —— 回 {status:'ok', retcode:0, data:null}（"查不到"，不抛错）
 *   · 'fail'   —— 回 {status:'failed', retcode:100}（服务端明确拒绝）
 */
const frames = []
let mode = 'ok'
const okData = { message: [{ type: 'text', data: { text: '被引用的那条' } }] }
client.on('message', (raw) => {
  let frame = null
  try { frame = JSON.parse(String(raw)) } catch { return }
  if (!frame || frame.action === undefined) return
  frames.push(frame)
  if (frame.action !== 'get_msg') return
  const reply = mode === 'fail'
    ? { status: 'failed', retcode: 100, data: null, echo: frame.echo }
    : { status: 'ok', retcode: 0, data: mode === 'null' ? null : okData, echo: frame.echo }
  client.send(JSON.stringify(reply))
})

// ---- A. 大 id：帧里的 id 必须是原样字符串，且能取回内容 ----
mode = 'ok'
frames.length = 0
const got = await server.getMsg(botSocket, BIG_ID)
check('★ get_msg 发出去了（有帧）', frames.length === 1, JSON.stringify(frames.map((f) => f.action)))
check('★★ 帧里的 message_id 是「字符串」而不是数字',
  typeof frames[0]?.params?.message_id === 'string', typeof frames[0]?.params?.message_id)
check('★★ 帧里的 message_id 与原始 19 位值逐字符相同（没被 Number 改过）',
  frames[0]?.params?.message_id === BIG_ID, frames[0]?.params?.message_id)
check(' 取回了引用内容', got?.message?.[0]?.data?.text === '被引用的那条')

// ---- B. 反面对照：服务端拒绝时必须抛错，不许吞成 null ----
mode = 'fail'
frames.length = 0
let threw = null
try {
  await server.getMsg(botSocket, BIG_ID)
} catch (error) {
  threw = error
}
check('★★ 大 id 取不到时必须抛错（不能吞成"没取到"）',
  threw !== null && /get_msg/.test(String(threw?.message)), String(threw?.message ?? '没有抛错'))
check('★ 失败时没有拿数字再去查一遍（大 id 用 Number 重试等于查同一个错 id）',
  frames.length === 1, `frames=${frames.length}`)

// ---- C. 小 id 的旧行为：字符串查不到 → 回退成数字再查一次 ----
mode = 'null'
frames.length = 0
const retried = await server.getMsg(botSocket, SMALL_ID)
const sent = frames.map((f) => f.params?.message_id)
check('★ 小 id 先按字符串查，查不到再按数字查一次（共 2 帧）', frames.length === 2, JSON.stringify(sent))
check(' 第二帧确实是 number（兼容只认 number 的实现）',
  typeof sent[1] === 'number' && sent[1] === 1234567890, `${typeof sent[1]}:${sent[1]}`)
check(' 两次都没结果时返回 null（不是抛错）', retried === null)

// ---- D. 其他四个 call site（dry-run 只记录不发送，正好能读原始 params）----
server.setDryRun(true)
server.dryRunCalls = []
await server.deleteMsg(botSocket, BIG_ID).catch(() => {})
await server.setEssenceMsg(botSocket, BIG_ID).catch(() => {})
await server.deleteEssenceMsg(botSocket, BIG_ID).catch(() => {})
await server.setMsgEmojiLike(botSocket, BIG_ID, 128077).catch(() => {})
const byAction = new Map(server.dryRunCalls.map((c) => [c.action, c.params]))
for (const action of ['delete_msg', 'set_essence_msg', 'delete_essence_msg', 'set_msg_emoji_like']) {
  const param = byAction.get(action)?.message_id
  check(`★★ ${action} 的 message_id 不许被改数（19 位必须原样）`, param === BIG_ID, String(param))
}

// 对称性对照：小 id 在同样的调用点上仍应是 number（旧行为没被改坏）
server.dryRunCalls = []
await server.deleteMsg(botSocket, SMALL_ID).catch(() => {})
const smallParam = server.dryRunCalls[0]?.params?.message_id
check(' 对照：小 id 走 delete_msg 仍发 number（不是字符串）',
  typeof smallParam === 'number' && smallParam === 1234567890, `${typeof smallParam}:${smallParam}`)

// 空 id 不许静默：否则又会变成"什么都看不到且没有原因"
let emptyThrew = false
try { await server.getMsg(botSocket, '  ') } catch { emptyThrew = true }
check('★ 空 message_id 直接报错（不静默返回 null）', emptyThrew)

await server.stop()
try { client.close() } catch { /* 关闭失败不影响判定 */ }
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
