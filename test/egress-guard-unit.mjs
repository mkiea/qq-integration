/**
 * 出网守卫（`lib/egress.js` 的 `fetchGuarded`）对抗测试 —— 2026-10-31。
 *
 * 这批测试是外部审计（docs/AUDIT-2026-10-31.md）里 S3 / S5 / S6 的验收。
 * 三条漏洞的共同形状是「同一套策略只盖住了部分路径」，所以这里的重点不是
 * "恶意输入被拒"，而是**同时证明三件事**：
 *
 *   1. 恶意输入被拒（否则等于没修）；
 *   2. **合法输入仍然能走通**（否则一个恒 `return false` 的假实现也能全过）；
 *   3. **拒绝发生在发请求之前**（用 fetchImpl 探针数请求次数）——
 *      "先连上再拒绝"和"根本不连"是两回事，前者已经把连接送出去了。
 *
 * 全程在本地起 HTTP 服务做靶子，不碰外网、不依赖任何真实域名。
 */
import { createServer } from 'node:http'
import { assertEgress, egressVerdict, fetchGuarded } from '../lib/egress.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

/** 起一个靶子服务，返回 { origin, written, close }。 */
async function startTarget() {
  const state = { written: 0, requests: [] }
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    state.requests.push(url.pathname)
    const path = url.pathname

    if (path === '/ok') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('hello')
      return
    }
    // 302 到云元数据地址（IP 字面量且不在白名单）—— 这就是 SSRF 的经典走法
    if (path === '/r-internal') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' })
      res.end()
      return
    }
    // 302 到自己的另一个合法路径（相对地址）—— 必须放行，否则等于把所有重定向都打死
    if (path === '/r-self') {
      res.writeHead(302, { location: '/ok' })
      res.end()
      return
    }
    // 两跳：/r-chain → /r-self → /ok
    if (path === '/r-chain') {
      res.writeHead(302, { location: '/r-self' })
      res.end()
      return
    }
    // 无限自我重定向，测 maxRedirects
    if (path === '/r-loop') {
      res.writeHead(302, { location: '/r-loop' })
      res.end()
      return
    }
    // 无限流：一直发，直到对面断开。用来证明"超限即停"不是"读完了才比大小"
    if (path === '/big') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      const chunk = Buffer.alloc(64 * 1024, 0x61)
      const timer = setInterval(() => {
        if (res.destroyed || res.writableEnded) { clearInterval(timer); return }
        state.written += chunk.length
        res.write(chunk)
      }, 2)
      res.on('close', () => clearInterval(timer))
      return
    }
    // 只回头不回体：测总时限（slowloris 那类）
    if (path === '/slow') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      const timer = setTimeout(() => { try { res.end() } catch { /* 已断 */ } }, 5000)
      res.on('close', () => clearTimeout(timer))
      return
    }
    res.writeHead(404)
    res.end()
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    origin: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function main() {
  // ---- 一、判据本身（不联网）----
  // 白名单命中：正例。没有这条，一个"永远拒绝"的实现也能让下面所有拒绝类断言通过。
  check('判据：白名单域名放行', egressVerdict('https://multimedia.nt.qq.com.cn/download?x=1').ok === true)
  check('判据：qq.com 后缀命中', egressVerdict('https://gchat.qpic.cn/x.png').ok === true)
  check('判据：陌生域名被拒', egressVerdict('https://evil.example/x').ok === false)
  check('判据：IP 字面量默认被拒', egressVerdict('http://169.254.169.254/latest/meta-data/').ok === false)
  check('判据：本机回环显式放行', egressVerdict('http://127.0.0.1:8080/x').ok === true)
  // `evilqq.com` 不能因为「以 qq.com 结尾」就命中——后缀匹配必须带点边界
  check('判据：evilqq.com 不算 qq.com', egressVerdict('https://evilqq.com/x').ok === false)
  let threw = ''
  try { assertEgress('https://evil.example/x') } catch (e) { threw = e.message }
  check('assertEgress 抛错里带原因', threw.includes('出网被拒'), threw.slice(0, 40))

  const t = await startTarget()
  try {
    // ---- 二、正常下载（正例）----
    const okRun = await fetchGuarded(`${t.origin}/ok`, { maxBytes: 1024 })
    check('正例：普通下载成功', okRun.buffer.toString() === 'hello', `bytes=${okRun.bytes}`)
    check('正例：hops 记录了实际走过的地址', okRun.hops.length === 1 && okRun.hops[0].includes('/ok'))

    // ---- 三、重定向：合法的要放行，非法的要拦 ----
    const selfRedirect = await fetchGuarded(`${t.origin}/r-self`, { maxBytes: 1024 })
    check('重定向：相对地址跳转放行且跟到了终点', selfRedirect.buffer.toString() === 'hello')
    check('重定向：hops 有 2 跳（证明真的自己跟了，不是一次性放过去）', selfRedirect.hops.length === 2, `hops=${selfRedirect.hops.length}`)

    const chain = await fetchGuarded(`${t.origin}/r-chain`, { maxBytes: 1024 })
    check('重定向：两跳链也跟得到', chain.buffer.toString() === 'hello' && chain.hops.length === 3, `hops=${chain.hops.length}`)

    // 这一条是整个 S3 的核心：跳到内网必须被拦
    let redirectErr = ''
    let redirectRequests = 0
    try {
      await fetchGuarded(`${t.origin}/r-internal`, {
        maxBytes: 1024,
        // 探针：被拒的那一跳如果真发了请求，这里会 +1
        fetchImpl: (url, init) => { redirectRequests++; return fetch(url, init) },
      })
    } catch (e) { redirectErr = e.message }
    check('重定向：302 跳到云元数据地址被拒', redirectErr.includes('出网被拒'), redirectErr.slice(0, 60))
    check('重定向：被拒的是第二跳（第一跳确实请求过）', redirectRequests === 1, `requests=${redirectRequests}`)
    check('重定向：被拒的 host 出现在错误里，便于 trace 定位', redirectErr.includes('169.254.169.254'), redirectErr.slice(0, 60))

    let loopErr = ''
    try { await fetchGuarded(`${t.origin}/r-loop`, { maxBytes: 1024, maxRedirects: 3 }) } catch (e) { loopErr = e.message }
    check('重定向：无限循环在 maxRedirects 处停', loopErr.includes('重定向超过'), loopErr.slice(0, 40))

    // ---- 四、超限即停（S6）----
    t.state.written = 0
    const t0 = Date.now()
    let bigErr = ''
    try { await fetchGuarded(`${t.origin}/big`, { maxBytes: 512 * 1024, timeoutMs: 5000 }) } catch (e) { bigErr = e.message }
    const elapsed = Date.now() - t0
    check('超限：抛错且提到上限', bigErr.includes('超过上限'), bigErr.slice(0, 50))
    check('超限：2 秒内就停手（不是读完才发现）', elapsed < 2000, `${elapsed}ms`)
    /**
     * 关键断言：服务端一共写出了多少字节。
     * 如果实现是「先 arrayBuffer 全读再比大小」，这里会一直发到测试自己超时，
     * written 会远超 maxBytes。所以这条能区分「真流式」和「假流式」。
     */
    const overshoot = t.state.written - 512 * 1024
    check('超限：服务端没有把数据全灌完（真流式）', t.state.written < 8 * 1024 * 1024, `written=${(t.state.written / 1024 / 1024).toFixed(1)}MiB overshoot=${overshoot}`)

    // ---- 五、总时限（不是每跳重置）----
    let slowErr = ''
    const s0 = Date.now()
    try { await fetchGuarded(`${t.origin}/slow`, { maxBytes: 1024, timeoutMs: 300 }) } catch (e) { slowErr = e.message }
    const slowElapsed = Date.now() - s0
    check('超时：慢速响应在 timeoutMs 附近被掐断', slowElapsed < 2000, `${slowElapsed}ms err=${slowErr.slice(0, 30)}`)

    // ---- 六、陌生域名根本不发请求 ----
    let calls = 0
    let hostErr = ''
    try {
      await fetchGuarded('https://evil.example/x', {
        maxBytes: 1024,
        fetchImpl: () => { calls++; return Promise.resolve(new Response('x')) },
      })
    } catch (e) { hostErr = e.message }
    check('陌生域名：抛错', hostErr.includes('出网被拒'), hostErr.slice(0, 40))
    check('陌生域名：**一次请求都没发**（拒绝发生在连接之前）', calls === 0, `calls=${calls}`)
  } finally {
    await t.close()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.log('FAIL 测试自身崩了：', e?.stack ?? e); process.exit(1) })
