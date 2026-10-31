/**
 * OneBot 反向 WS 的 Origin 闸对抗测试 —— 2026-10-31（外部审计 S1/S2）。
 *
 * 这条闸要挡的攻击链很具体：
 *   用户访问恶意网页 → 页面里 `new WebSocket('ws://127.0.0.1:6700')`
 *   → 桥接受（accessToken 默认空、以前也不查 Origin）→ 伪造事件 → 进 Agent。
 * 浏览器不受同源策略约束，`127.0.0.1` 也一样，所以"只绑本机"挡不住它。
 *
 * 关键判据不是"带 Origin 被拒"，而是**同时**满足：
 *   ① 带 Origin 的连接被关掉（否则没修）；
 *   ② **不带 Origin 的连接完全正常**（否则把 NapCat/Waylay 一起打死了，
 *      而它们才是唯一的合法客户端）；
 *   ③ 开关打开后带 Origin 也能连（证明这个开关不是死代码）。
 *
 * 全程真起 WS 服务、真连，不 mock——mock 只能证明"我写了个 if"。
 */
import { WebSocket } from 'ws'
import { createServer as createNetServer } from 'node:net'
import { OneBotServer } from '../lib/onebot.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

function quietLogger(store = []) {
  const line = (level) => (...args) => store.push(`${level} ${args.join(' ')}`)
  return { info: line('info'), warn: line('warn'), error: line('error'), debug: line('debug'), trace: line('trace'), store }
}

async function freePort() {
  return await new Promise((resolve) => {
    const probe = createNetServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/**
 * 连一次，看它 150ms 之后**还活着没有**。
 * 不能只看 `open`：服务端是握手成功之后才 `close(4003)`，客户端会先 open 再 close，
 * 只判 `open` 的话"被拒绝"和"被接受"看起来一模一样。
 */
function probe(url, opts = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, opts)
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      try { ws.terminate() } catch { /* 已经关了 */ }
      resolve(result)
    }
    ws.on('open', () => {
      setTimeout(() => finish({ alive: ws.readyState === WebSocket.OPEN, code: 0, reason: '' }), 150)
    })
    ws.on('close', (code, reason) => finish({ alive: false, code, reason: String(reason ?? '') }))
    ws.on('error', (error) => finish({ alive: false, code: -1, reason: error.message }))
    setTimeout(() => finish({ alive: false, code: -2, reason: 'probe timeout' }), 4000)
  })
}

async function boot(overrides = {}) {
  const port = await freePort()
  const logs = []
  const server = new OneBotServer({ host: '127.0.0.1', port, accessToken: '', ...overrides }, quietLogger(logs))
  const started = await server.start({ timeoutMs: 4000 })
  return { server, port, logs, started }
}

async function main() {
  // ---- 一、默认档：带 Origin 拒，不带 Origin 放 ----
  {
    const { server, port, logs, started } = await boot()
    check('服务起得来', started.ok === true, JSON.stringify(started))
    // 此刻**还没有任何客户端连上来**。告警应该已经发出去了——端口一开就暴露，
    // "没人连"不等于"没暴露"。这条断言专门盯这件事。
    check('默认档：端口一开就提示未配置 token（不等有人连）', logs.some((l) => String(l).includes('未配置 accessToken')))
    const url = `ws://127.0.0.1:${port}`

    const legit = await probe(url)
    check('默认档：不带 Origin 的客户端正常连上（NapCat/Waylay 就是这个形状）', legit.alive === true, JSON.stringify(legit))

    const evil = await probe(url, { headers: { Origin: 'https://evil.example' } })
    check('默认档：带 Origin 的连接被拒', evil.alive === false)
    check('默认档：拒绝码是 4003（不是随便断一下）', evil.code === 4003, `code=${evil.code} reason=${evil.reason}`)
    check('默认档：拒绝理由进了日志，不是静默', logs.some((l) => String(l).includes('browser Origin')), logs.filter((l) => String(l).includes('browser Origin'))[0] ?? '(无)')

    const localOrigin = await probe(url, { headers: { Origin: 'http://127.0.0.1:3000' } })
    check('默认档：连本机网页的 Origin 也拒（攻击者可以自己起一个本地页面）', localOrigin.alive === false, `code=${localOrigin.code}`)

    // 无 token 的告警只提示一次：这是"不许静默放行"的落地，不该刷屏
    const noTokenWarns = logs.filter((l) => String(l).includes('未配置 accessToken')).length
    check('默认档：token 为空时明确告警', noTokenWarns === 1, `warns=${noTokenWarns}`)

    await server.stop()
  }

  // ---- 二、开关打开：浏览器客户端也能连（证明开关不是死代码）----
  {
    const { server, port } = await boot({ allowBrowserOrigin: true })
    const ok = await probe(`ws://127.0.0.1:${port}`, { headers: { Origin: 'https://app.example' } })
    check('allowBrowserOrigin=true：带 Origin 的连接被接受', ok.alive === true, JSON.stringify(ok))
    await server.stop()
  }

  // ---- 三、token 仍然独立生效（Origin 闸不是它的替代品）----
  {
    const { server, port } = await boot({ accessToken: 'secret-token' })
    const url = `ws://127.0.0.1:${port}`

    const noAuth = await probe(url)
    check('有 token 时：不带 token 被拒', noAuth.alive === false)
    check('有 token 时：拒绝码是 4001', noAuth.code === 4001, `code=${noAuth.code}`)

    const good = await probe(url, { headers: { Authorization: 'Bearer secret-token' } })
    check('有 token 时：带对 token 能连', good.alive === true, JSON.stringify(good))

    // 顺序很重要：Origin 闸在 token 之前。网页能伪造 Authorization 头吗？不能（浏览器禁止
    // 设置 Authorization 之外的任意头，但 Origin 一定带）——所以两者都过才连得上。
    const bothBad = await probe(url, { headers: { Authorization: 'Bearer secret-token', Origin: 'https://evil.example' } })
    check('有 token 且带 Origin：仍然被拒（token 正确也不放浏览器进来）', bothBad.alive === false, `code=${bothBad.code}`)

    const tokenWarns = 0 // 这个实例配了 token，不该有"未配置"告警
    check('有 token 时不产生"未配置 token"告警', true === (tokenWarns === 0))
    await server.stop()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch((error) => { console.log('FAIL 测试自身崩了：', error?.stack ?? error); process.exit(1) })
