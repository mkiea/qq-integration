/**
 * `qq_read_link` 的出网放开（2026-11-01）。
 *
 * 需求是「她能把用户分享的链接读一遍」，而链接按定义就是白名单外的站点。
 * 所以给 `egressVerdict` / `fetchGuarded` 加了 `allowAnyHost`。
 *
 * 这个开关的**唯一底线**是：SSRF 不能因此回来。所以断言分两半 ——
 *   ① 开了之后陌生**域名**必须放行（否则功能等于没做）；
 *   ② 开了之后内网/云元数据/环回 **IP 字面量仍必须拒**（这是那半条底线）。
 */
import { egressVerdict, fetchGuarded } from '../lib/egress.js'
import { createServer } from 'node:http'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) } else { failed++; console.log('FAIL', name, extra) }
}

// ── ① 开关打开：陌生域名放行 ─────────────────────────────────────────
{
  const v = egressVerdict('https://some-random-blog.example/posts/1', { allowAnyHost: true })
  check('★ 开了 allowAnyHost：陌生域名放行', v.ok === true, v.reason)

  const blog = egressVerdict('https://space.bilibili.com/123', { allowAnyHost: true })
  check('放行理由写清了是那个开关', blog.ok === true && /allowAnyHost|任意公网域名/.test(blog.reason), blog.reason)
}

// ── ② 开关关闭（默认）：陌生域名仍然拒 ───────────────────────────────
{
  const v = egressVerdict('https://some-random-blog.example/posts/1')
  check('默认仍然拒绝陌生域名', v.ok === false && /白名单/.test(v.reason), v.reason)

  const v2 = egressVerdict('https://some-random-blog.example/posts/1', { allowAnyHost: false })
  check('显式 false 也拒', v2.ok === false)
}

// ── ③ ★ 底线：开了开关也必须拦内网 ───────────────────────────────────
{
  const cases = [
    ['http://169.254.169.254/latest/meta-data/', '云元数据（AWS/腾讯云）'],
    ['http://127.0.0.1:8880/qqai/panel', '本机回环（非白名单端口也用同一判断）'],
    ['http://192.168.1.1/admin', '局域网'],
    ['http://10.0.0.5/', '内网 10/8'],
    ['http://[::1]/', 'IPv6 回环'],
    ['http://2130706433/', '十进制写法的 127.0.0.1'],
    ['http://0x7f000001/', '十六进制写法的 127.0.0.1'],
  ]
  for (const [url, label] of cases) {
    const v = egressVerdict(url, { allowAnyHost: true })
    check(`★ allowAnyHost 仍拒 ${label}`, v.ok === false, v.reason)
  }

  /**
   * 反向对照：**默认模式**（媒体下载）必须仍然放行回环。
   * 本地 TTS（127.0.0.1:8977）、控制台、QQ 图片缓存都靠这一条；
   * 只收紧读链接那个场景，别把既有功能一起打死。
   */
  const loopDefault = egressVerdict('http://127.0.0.1:8977/v1/audio/speech')
  check('反向对照：默认模式仍放行回环（本地 TTS 依赖它）', loopDefault.ok === true, loopDefault.reason)
}

// ── ④ fetchGuarded 真的把开关透传下去了 ──────────────────────────────
{
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<title>ok</title><p>hello</p>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  /**
   * 用**同一个回环 URL** 在两种模式下跑，结果必须不同 —— 这是"开关真的透传到内部"的证据。
   * （不能拿一个陌生域名来测：本地环境没法为它起服务，会变成"因为连不上所以通过"。）
   */
  const got = await fetchGuarded(`${base}/x`, { maxBytes: 4096, timeoutMs: 5000 })
  check('默认模式能正常读本地服务', got.buffer.length > 0, `${got.buffer.length} 字节`)

  let denied = ''
  try {
    await fetchGuarded(`${base}/x`, { allowAnyHost: true, maxBytes: 4096, timeoutMs: 5000 })
  } catch (error) {
    denied = error.message
  }
  check('★ 同一 URL 在 allowAnyHost 模式下被拒（证明开关透传生效）', /回环/.test(denied), denied)

  // 反向：即使开了 allowAnyHost，302 跳到云元数据地址仍然要被拦
  const redirectServer = createServer((req, res) => {
    if (req.url === '/to-meta') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' })
      res.end()
      return
    }
    res.writeHead(200).end('ok')
  })
  await new Promise((resolve) => redirectServer.listen(0, '127.0.0.1', resolve))
  const rbase = `http://127.0.0.1:${redirectServer.address().port}`
  /**
   * 逐跳校验的回归：首跳用回环（默认模式放行），第二跳跳云元数据必须被拦。
   * 这里**故意不加 allowAnyHost** —— 加了首跳就被拒，测不到"第二跳"这一层
   * （那其实更安全，但会让这条断言失去意义）。
   */
  let message = ''
  try {
    await fetchGuarded(`${rbase}/to-meta`, { maxBytes: 4096, timeoutMs: 5000 })
  } catch (error) {
    message = error.message
  }
  check('★ 302 到云元数据在第二跳被拦（逐跳校验）', /169\.254\.169\.254/.test(message), message)

  server.close()
  redirectServer.close()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
