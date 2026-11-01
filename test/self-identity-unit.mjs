/**
 * 她自己是谁 + 别跟自己说话（2026-11-01）。
 *
 * 两个缺陷同一条根：
 *   ① `config.botQq` 默认 0，而 0 在 `#onFrame` 里等于「群里每条消息都算 @ 了我」。
 *      配上 `replyOnlyWhenMentioned=true`，这个组合的意思就是"群里谁说句话她都接"——
 *      对爱说话的群等于刷屏，而刷屏是最快被风控的打法。
 *   ② 主路径不区分"谁发的"。宿主是否把机器人自己发的消息回推给插件，取决于 OneBot 端；
 *      一旦回推而这里不过滤，就是 她发 → 收到 → 再发 的闭环。
 *
 * 修法用的是白给的信息：OneBot 每条消息事件都带 `self_id`，不需要用户手填 QQ 号。
 *
 * 这个套件全部走**真 WebSocket 往返**（同 test/onebot-id-unit.mjs 的路子），
 * 因为 `#onFrame` 是私有方法，绕过去测等于测了个别的函数。
 *
 * 每条正向断言都配一条反向对照 —— 只会变绿的判据没有分辨力（纪律 112）：
 *   A 学到 self_id / B 没配也能用        ↔ C 显式配置优先
 *   D 自己发的消息被丢                    ↔ E ignoreSelf=false 时仍会进
 *   F 群里不 @ 就不算 @（修复点）          ↔ G 真 @ 了仍然算
 *   H 事件里没有 self_id 时退回旧兜底      （说明兜底还在，只是不再是唯一路径）
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
let portSeed = 17100
const nextPort = () => portSeed + Math.floor(Math.random() * 60)

/**
 * 起一个 OneBotServer + 一条真 WS 连接，投递若干帧，收回所有 emit 出来的 message。
 * @returns {{got: Array<object>, server: OneBotServer, selfQq: number, stop: Function}}
 */
async function scenario(config, frames) {
  const port = nextPort()
  const server = new OneBotServer({ host: '127.0.0.1', port, accessToken: '', ...config }, logger)
  const got = []
  server.on('message', (message) => got.push(message))
  await server.start()
  const client = new WebSocket(`ws://127.0.0.1:${port}`)
  await once(client, 'open')
  await new Promise((resolve) => setTimeout(resolve, 60))
  for (const frame of frames) {
    client.send(JSON.stringify(frame))
    // 帧是逐条处理的，给一点时间让 emit 落地
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
  await new Promise((resolve) => setTimeout(resolve, 60))
  const selfQq = server.selfQq
  try { client.close() } catch {}
  await server.stop()
  return { got, server, selfQq }
}

/** 一条群消息帧。`at` 给 true 时带一个指向 `atQq` 的 at 段。 */
function groupFrame({ selfId = 999, userId = 1001, text = '在吗', at = false, atQq = 999 } = {}) {
  const message = [{ type: 'text', data: { text } }]
  if (at) message.unshift({ type: 'at', data: { qq: String(atQq) } })
  const frame = {
    post_type: 'message',
    message_type: 'group',
    group_id: 2002,
    user_id: userId,
    message,
    message_id: `m${Math.random().toString(36).slice(2, 8)}`,
    sender: { nickname: '小明' },
  }
  // 显式给 null 表示"这个实现不上报 self_id"，和"没这个字段"要能分开测。
  if (selfId !== null) frame.self_id = selfId
  return frame
}

// ---------- A. 从事件里学到自己是谁 ----------
{
  const { got, selfQq } = await scenario({ botQq: 0 }, [groupFrame({ selfId: 999 })])
  check('A 从 self_id 学到自己的 QQ 号（配置留 0 也能用）', selfQq === 999, `selfQq=${selfQq}`)
  check('A 群消息照常上报', got.length === 1, `n=${got.length}`)
}

// ---------- B. 学到之后，"没 @ 我"不再算 @ ----------
{
  const { got } = await scenario({ botQq: 0 }, [groupFrame({ selfId: 999, at: false })])
  check('B 群里没 @ 她 ⇒ atMe=false（这就是之前刷屏的根）',
    got.length === 1 && got[0].atMe === false, `atMe=${got[0]?.atMe}`)
}

// ---------- C. 反向对照：真 @ 了仍然算 @ ----------
{
  const { got } = await scenario({ botQq: 0 }, [groupFrame({ selfId: 999, at: true, atQq: 999 })])
  check('C 群里真 @ 她 ⇒ atMe=true（没有把 @ 一起改坏）',
    got.length === 1 && got[0].atMe === true, `atMe=${got[0]?.atMe}`)
}

// ---------- D. 自己发的消息被丢掉 ----------
{
  const { got } = await scenario({ botQq: 0 }, [
    groupFrame({ selfId: 999, userId: 999, text: '我自己说的', at: false }),
  ])
  check('D ignoreSelf 默认开 ⇒ 自己发的群消息不产生回合', got.length === 0, `n=${got.length}`)
}

// ---------- E. 反向对照：关掉 ignoreSelf 就仍然会进 ----------
{
  const { got } = await scenario({ botQq: 0, ignoreSelf: false }, [
    groupFrame({ selfId: 999, userId: 999, text: '我自己说的', at: true }),
  ])
  check('E ignoreSelf=false ⇒ 自己发的消息仍然进来（开关有效，不是永远丢）', got.length === 1, `n=${got.length}`)
}

// ---------- F. 显式配置优先于学到的值 ----------
{
  const { selfQq, got } = await scenario({ botQq: 777 }, [groupFrame({ selfId: 999, at: true, atQq: 777 })])
  check('F 显式 botQq=777 时以配置为准', selfQq === 777, `selfQq=${selfQq}`)
  check('F 且 @ 777 才算 @', got.length === 1 && got[0].atMe === true, `atMe=${got[0]?.atMe}`)
}

// ---------- G. 事件里没有 self_id 时退回旧兜底（并且不崩） ----------
{
  const { selfQq, got } = await scenario({ botQq: 0 }, [groupFrame({ selfId: null, at: false })])
  check('G 没有 self_id ⇒ selfQq 仍是 0（不瞎猜）', selfQq === 0, `selfQq=${selfQq}`)
  check('G 且退回旧兜底：此时群消息仍算 @（这是已知的宽方向兜底，不是修复目标）',
    got.length === 1 && got[0].atMe === true, `atMe=${got[0]?.atMe}`)
}

// ---------- H. 私聊不受 @ 逻辑影响 ----------
{
  const { got } = await scenario({ botQq: 0 }, [{
    post_type: 'message', message_type: 'private', user_id: 1001, self_id: 999,
    message: [{ type: 'text', data: { text: '私聊' } }],
    message_id: 'p1', sender: { nickname: '小明' },
  }])
  check('H 私聊 atMe 恒为 false（没被群那套逻辑污染）', got.length === 1 && got[0].atMe === false, `atMe=${got[0]?.atMe}`)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
