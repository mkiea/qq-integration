/**
 * 出站发送间隔（2026-11-01）。
 *
 * 她的回复天然是多段短句，一个回合就可能连发 3–4 条；主动通道的说说、管理回执、
 * 转发卡片还可能在同一秒到达。对 QQ 服务端来说那是一串紧挨着的写操作，
 * 而"连发"是各家成熟桥公认的风控诱因 —— 通用做法就是给写操作之间塞一个固定间隔。
 *
 * 这里钉三件事，缺一条这个改动就不可信：
 *   A 间隔真的生效（3 条消息的时间戳间隔 ≥ 配置值）
 *   B 反向对照：sendIntervalMs=0 时**不**生效（否则测的可能只是"本来就很慢"）
 *   C 查询类 action 不被限速（只闸写操作；给查询加延迟纯属把界面变钝）
 *
 * 时间戳取自**客户端收到帧的时刻**，不是被测代码自己报的数 ——
 * 拿被测对象自己的计时来自证，等于让它给自己判卷。
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

const logger = { info() {}, warn() {}, error() {} }
let portSeed = 17300
const nextPort = () => portSeed + Math.floor(Math.random() * 60)

/**
 * 起 server + 客户端，并发发出 `actions` 里的每个调用，返回每个帧到达客户端的时刻。
 * @param {object} config 传给 OneBotServer 的配置
 * @param {(server: OneBotServer, socket: any) => Promise<any>[]} fire 返回一组待并发的调用
 */
async function scenario(config, fire) {
  const port = nextPort()
  const server = new OneBotServer({ host: '127.0.0.1', port, accessToken: '', botQq: 999, ...config }, logger)
  let botSocket = null
  server.on('bot-connect', (socket) => { botSocket = socket })
  await server.start()

  const client = new WebSocket(`ws://127.0.0.1:${port}`)
  await once(client, 'open')
  const arrivals = []
  client.on('message', (raw) => {
    let frame = null
    try { frame = JSON.parse(String(raw)) } catch { return }
    if (!frame || frame.echo === undefined) return
    arrivals.push({ at: Date.now(), action: frame.action })
    // 必须回，否则 #call 会一直挂到 10s 超时，测出来的"间隔"就成了超时时间。
    client.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: frame.echo }))
  })
  await new Promise((resolve) => setTimeout(resolve, 60))

  const pending = fire(server, botSocket)
  await Promise.all(pending)
  await new Promise((resolve) => setTimeout(resolve, 40))
  try { client.close() } catch {}
  await server.stop()
  return arrivals
}

const gaps = (list) => list.slice(1).map((row, index) => row.at - list[index].at)

// ---------- A. 间隔真的生效 ----------
{
  const arrivals = await scenario({ sendIntervalMs: 200 }, (server, socket) => [
    server.sendText(socket, 'group', 2002, '一'),
    server.sendText(socket, 'group', 2002, '二'),
    server.sendText(socket, 'group', 2002, '三'),
  ])
  const g = gaps(arrivals)
  check('A 三条消息都发出去了', arrivals.length === 3, `n=${arrivals.length}`)
  // 200ms 配置，实测允许 15ms 抖动（定时器精度 + 事件循环），但不允许"几乎同时"。
  check('A 相邻两条间隔 ≥ 185ms', g.every((ms) => ms >= 185), `gaps=${JSON.stringify(g)}`)
}

// ---------- B. 反向对照：0 = 不限速 ----------
{
  const arrivals = await scenario({ sendIntervalMs: 0 }, (server, socket) => [
    server.sendText(socket, 'group', 2002, '一'),
    server.sendText(socket, 'group', 2002, '二'),
    server.sendText(socket, 'group', 2002, '三'),
  ])
  const g = gaps(arrivals)
  check('B 0 = 不限速（证明 A 测的是间隔，不是"本来就慢"）',
    arrivals.length === 3 && g.every((ms) => ms < 120), `gaps=${JSON.stringify(g)}`)
}

// ---------- C. 查询类不受限速 ----------
{
  const arrivals = await scenario({ sendIntervalMs: 200 }, (server, socket) => [
    server.getGroupInfo(socket, 2002),
    server.getGroupInfo(socket, 2003),
    server.getGroupInfo(socket, 2004),
  ])
  const g = gaps(arrivals)
  check('C 查询类 action 不被限速', arrivals.length === 3 && g.every((ms) => ms < 120), `gaps=${JSON.stringify(g)}`)
  check('C 且确实是查询（不是被当成发送）',
    arrivals.every((row) => row.action === 'get_group_info'), JSON.stringify(arrivals.map((row) => row.action)))
}

// ---------- D. 间隔是"串行排队"，不是"各自睡各自的" ----------
{
  // 5 条并发：如果只是每条各睡 200ms 再发，总耗时会接近 0；正确排队的耗时应接近 4×200=800ms。
  const started = Date.now()
  const arrivals = await scenario({ sendIntervalMs: 150 }, (server, socket) => [
    server.sendText(socket, 'group', 2002, '1'),
    server.sendText(socket, 'group', 2002, '2'),
    server.sendText(socket, 'group', 2002, '3'),
    server.sendText(socket, 'group', 2002, '4'),
    server.sendText(socket, 'group', 2002, '5'),
  ])
  const total = (arrivals.at(-1)?.at ?? started) - (arrivals[0]?.at ?? started)
  check('D 并发发送按顺序排队（总跨度 ≈ 4×间隔）', arrivals.length === 5 && total >= 560,
    `span=${total}ms gaps=${JSON.stringify(gaps(arrivals))}`)
}

// ---------- E. 抖动：间隔不是固定节拍（2026-11-10） ----------
{
  /**
   * 为什么单独测：风控侧最容易识别的不是"发得多"，是"每次都一样"。
   * 固定 400ms 的间隔在日志里就是一条直线，这一条锁住"没有两次一样"。
   */
  const arrivals = await scenario({ sendIntervalMs: 120, sendJitterRatio: 0.8 }, (server, socket) => [
    ...Array.from({ length: 6 }, (_, i) => server.sendText(socket, 'group', 2002, String(i))),
  ])
  const g = gaps(arrivals)
  const min = Math.min(...g)
  const max = Math.max(...g)
  const buckets = new Set(g.map((ms) => Math.round(ms / 5)))
  check('E 抖动：6 条消息都发出去', arrivals.length === 6, `n=${arrivals.length}`)
  check('E 抖动：间隔不全一样（不是定时任务）', buckets.size >= 3, `gaps=${JSON.stringify(g)}`)
  check('E 抖动：下界仍受 sendIntervalMs 约束', min >= 110, `min=${min}ms`)
  check('E 抖动：上界不超过 gap×1.8（含定时器容差）', max <= 120 * 1.8 + 40, `max=${max}ms`)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
