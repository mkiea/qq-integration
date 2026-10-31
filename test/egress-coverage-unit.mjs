/**
 * 出网「覆盖率」回归（2026-10-31 红队 K②/K⑤ 之后补）。
 *
 * 背景：`fetchGuarded` 早在 10-31 早些时候就有了，但只被三处调用。红队随后用
 * `downloadTo`（第 4 条独立下载路径，6 个调用点）打穿了两条：
 *   · 302 跳到内网主机仍被真实请求（只校验首跳）
 *   · 5 MiB 整包落盘（先 arrayBuffer 再比大小）
 *
 * 教训不是「那两行写错了」，而是**策略挂在一个函数上、而调用点没被审计**。
 * 所以这个测试同时钉两件事：
 *   A. 行为：fetchGuarded 的每跳校验 / 限额 / 错误带服务端理由 / content-type 透出 / headers 透传
 *   B. 接线：`lib/` 里**不允许**再出现「外部输入 URL + 裸 fetch」的组合（静态扫描）
 *
 * B 是粗的，但正是它能在下次有人顺手写 `await fetch(url)` 时立刻变红 —— 比"记得审计"可靠。
 */
import { createServer } from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertEgress, fetchGuarded } from '../lib/egress.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) } else { failed++; console.log('FAIL', name, extra) }
}

// ── 本地服务：故意提供 302 / 400 / 图片 / 回显头 ──────────────────────
const server = createServer((req, res) => {
  if (req.url === '/400') {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ retcode: -5503010, retmsg: 'invalid rkey', retryflag: 1 }))
    return
  }
  if (req.url === '/png') {
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]))
    return
  }
  if (req.url === '/echo-headers') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ referer: req.headers.referer ?? '', ua: req.headers['user-agent'] ?? '' }))
    return
  }
  if (req.url === '/r-denied') {
    // 302 到内网地址：第二跳必须被拒
    res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' })
    res.end()
    return
  }
  res.writeHead(404).end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

// ── A. 行为 ───────────────────────────────────────────────────────────
{
  // A1 非 2xx 要把服务端理由带出来（Q: 上层靠 invalid rkey 决定回退路径）
  let message = ''
  try {
    await fetchGuarded(`${base}/400`)
  } catch (error) {
    message = error.message
  }
  check('400 时抛错', message !== '')
  check('错误里带 QQ 的 retmsg', message.includes('invalid rkey'), message)
  check('错误里带 retcode', message.includes('-5503010'), message)

  // A2 content-type 要透出（downloadTo 靠它猜扩展名）
  const png = await fetchGuarded(`${base}/png`)
  check('content-type 被返回', png.contentType === 'image/png', png.contentType)
  check('返回体完整', png.buffer.length === 8, `${png.buffer.length} 字节`)

  // A3 自定义 headers 要真的送出去（cardlook 的 B 站接口依赖 Referer）
  const echoed = await fetchGuarded(`${base}/echo-headers`, {
    headers: { referer: 'https://www.bilibili.com/', 'user-agent': 'rin-test' },
  })
  const parsed = JSON.parse(echoed.buffer.toString('utf8'))
  check('自定义 Referer 送达', parsed.referer === 'https://www.bilibili.com/', parsed.referer)
  check('自定义 UA 送达', parsed.ua === 'rin-test', parsed.ua)

  // A4 302 到内网：拒绝发生在第二跳（这是 K② 的核心）
  let hops2 = ''
  try {
    await fetchGuarded(`${base}/r-denied`)
  } catch (error) {
    hops2 = error.message
  }
  check('302 到云元数据地址被拒', hops2.includes('169.254.169.254'), hops2)
  check('错误里说明是「IP 字面量」类拒绝', hops2.includes('IP'), hops2)

  // A5 反向对照：白名单内的正常请求必须走得通（否则上面全部成立也毫无意义）
  const ok = await fetchGuarded(`${base}/png`)
  check('白名单内请求正常', ok.bytes === 8, `${ok.bytes} 字节`)
  check('assertEgress 对 127.0.0.1 放行', assertEgress(`${base}/png`).ok === true)
}

// ── B. 接线：lib/ 里不许再有「外部输入 URL + 裸 fetch」 ────────────────
{
  const read = (name) => readFileSync(join(ROOT, 'lib', name), 'utf8')

  /** 取顶层函数体（`async function name(` → 下一个行首 `}`）。 */
  function topLevelBody(source, decl) {
    const start = source.indexOf(decl)
    if (start < 0) return null
    const end = source.indexOf('\n}', start)
    return end < 0 ? source.slice(start) : source.slice(start, end + 2)
  }

  const bridge = read('bridge.js')
  const downloadToBody = topLevelBody(bridge, 'async function downloadTo')
  check('找得到 downloadTo', downloadToBody !== null)
  if (downloadToBody !== null) {
    check('downloadTo 不再裸 fetch（K② K⑤）', !downloadToBody.includes('await fetch('), downloadToBody.slice(0, 60))
    check('downloadTo 走 fetchGuarded', downloadToBody.includes('fetchGuarded'))
    check('downloadTo 保留 `download ` 错误前缀（trace 可读性）', downloadToBody.includes('download ${'))
  }

  const faces = read('faces.js')
  check('faces.addRemoteImage 不再裸 fetch', !/addRemoteImage[\s\S]{0,600}await fetch\(/.test(faces))
  check('faces 走 fetchGuarded', faces.includes('fetchGuarded'))

  const cardlook = read('cardlook.js')
  check('cardlook 不再裸 fetch（卡片链接是外部输入）', !cardlook.includes('await fetch('))
  check('cardlook 走 fetchGuarded', cardlook.includes('fetchGuarded'))

  /**
   * 语音下载也在 bridge.js 里（`#downloadVoice` 附近的 url 分支）。
   * 用「voice download」这段错误文本作锚点，断言它附近没有裸 fetch。
   */
  check('语音 url 下载不再裸 fetch', !/voice download[\s\S]{0,120}await fetch\(/.test(bridge))

  // 反向对照：允许存在的裸 fetch 是为了「主人自己配的服务地址」，不该被误判成漏洞。
  const tts = read('tts.js')
  check('tts.js 仍可裸 fetch（配置的服务地址，非外部输入）', tts.includes('await fetch('))
}

server.close()
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
