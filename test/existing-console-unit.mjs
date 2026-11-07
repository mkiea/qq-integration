/**
 * 「端口上是不是我自己」的单元测试 —— 2026-11-07。
 *
 * 这个判据的失败模式全是**方向反了也不会报错**的那种：
 *   · 把别人的控制台认成自己 ⇒ 打开面板却是个陌生实例（最糟：用户以为连上了自己的）；
 *   · 把自己的控制台认成别人 ⇒ 每次双击都弹警告，用户干脆不用启动器；
 *   · 超时当成"被占用" ⇒ 明明空闲却拒绝启动。
 * 所以三种「别人」和三种「自己」都要各钉一条，且用真 HTTP 服务，不用 mock 掉的 fetch。
 */
import { createServer } from 'node:http'
import { probeExistingConsole, triggerStartAll } from '../control/lib/existing-console.mjs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const servers = []
async function fakeServer(handler) {
  const server = createServer(handler)
  servers.push(server)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

// ------------------------------------------------ 1. 自己

{
  let seenUrl = ''
  let seenToken = ''
  const { port } = await fakeServer((req, res) => {
    seenUrl = req.url
    seenToken = new URL(req.url, 'http://127.0.0.1').searchParams.get('token') ?? ''
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      build: { stale: true, newerCount: 3 },
      stamp: { present: true, tag: 'v0.1.0-rc2' },
    }))
  })

  const probe = await probeExistingConsole({ port, token: 'tok-self' })
  check('self：kind=self', probe.kind === 'self', probe.kind)
  check('self：探测带上了 token', seenToken === 'tok-self', seenToken)
  check('self：探测打在 /api/ping（不能是慢的 /api/status）', seenUrl.startsWith('/api/ping?'), seenUrl)
  check('self：带回 build.stale（旧进程提示要用）', probe.build?.stale === true)
  check('self：带回 stamp', probe.stamp?.tag === 'v0.1.0-rc2')
  check('self：面板 URL 带 token、不带 /api', probe.url.includes('/?token=') && !probe.url.includes('/api/'), probe.url)
}

// ------------------------------------------------ 1b. 旧版本：没有 /api/ping，回退 /api/status

{
  const paths = []
  const { port } = await fakeServer((req, res) => {
    paths.push(req.url)
    if (req.url.startsWith('/api/ping')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, reason: '未知接口' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, pid: 4242, build: { stale: false } }))
  })
  const probe = await probeExistingConsole({ port, token: 't' })
  check('旧版本（ping 404）→ 回退 status 仍认出自己', probe.kind === 'self' && probe.legacy === true, `${probe.kind}/legacy=${probe.legacy}`)
  check('旧版本回退确实先打了 ping 再打 status',
    paths.some((p) => p.startsWith('/api/ping?')) && paths.some((p) => p.startsWith('/api/status?')), paths.join(' → '))
}

// ------------------------------------------------ 2. token 不对 ⇒ 另一个控制台

{
  const { port } = await fakeServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, reason: 'token 无效' }))
  })
  const probe = await probeExistingConsole({ port, token: 'tok-wrong' })
  check('401 → foreign-console', probe.kind === 'foreign-console', probe.kind)
  check('401 → 保留 httpStatus', probe.httpStatus === 401)
}

{
  const { port } = await fakeServer((req, res) => { res.writeHead(403); res.end() })
  const probe = await probeExistingConsole({ port, token: 't' })
  check('403 → foreign-console', probe.kind === 'foreign-console', probe.kind)
}

// ------------------------------------------------ 3. 别的程序

{
  const { port } = await fakeServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ hello: 'world' }))
  })
  const probe = await probeExistingConsole({ port, token: 't' })
  check('200 但不是控制台 → other-service', probe.kind === 'other-service', probe.kind)
  check('other-service 带原因', String(probe.reason).includes('不是控制台'), probe.reason)
}

{
  const { port } = await fakeServer((req, res) => { res.writeHead(500); res.end('boom') })
  const probe = await probeExistingConsole({ port, token: 't' })
  check('500 → other-service', probe.kind === 'other-service', probe.kind)
}

// ------------------------------------------------ 4. 没人 / 判不了

{
  const { server, port } = await fakeServer((req, res) => { res.writeHead(200); res.end('{}') })
  await new Promise((resolve) => server.close(resolve))
  const probe = await probeExistingConsole({ port, token: 't', pingTimeoutMs: 300 })
  check('端口关掉 → none', probe.kind === 'none', probe.kind)
}

{
  const { port } = await fakeServer(() => { /* 故意不回，模拟挂住的进程 */ })
  const started = Date.now()
  const probe = await probeExistingConsole({ port, token: 't', pingTimeoutMs: 150 })
  const elapsed = Date.now() - started
  check('不回话 → unknown（不是 none）', probe.kind === 'unknown', probe.kind)
  check('超时按设定生效（< 1s）', elapsed < 1000, `${elapsed}ms`)
}

{
  const probe = await probeExistingConsole({ port: 0, token: 't' })
  check('端口 0 → none（跳过探测）', probe.kind === 'none', probe.kind)
}

{
  const probe = await probeExistingConsole({ port: 12345, token: 't', fetchImpl: null })
  check('没有 fetch → unknown（不假装没人）', probe.kind === 'unknown', probe.kind)
}

// ------------------------------------------------ 5. token 需要 URL 编码

{
  let got = ''
  const { port } = await fakeServer((req, res) => {
    got = new URL(req.url, 'http://127.0.0.1').searchParams.get('token') ?? ''
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  await probeExistingConsole({ port, token: 'a b&c=d' })
  check('特殊字符 token 正确往返', got === 'a b&c=d', got)
}

// ------------------------------------------------ 6. 复用已有实例的「一键启动」

{
  let method = ''
  let path = ''
  const { port } = await fakeServer((req, res) => {
    method = req.method
    path = req.url
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, steps: [{ name: 'Waylay', ok: true, reason: '已启动' }] }))
  })
  const result = await triggerStartAll({ port, token: 'tok' })
  check('startAll：走 POST', method === 'POST', method)
  check('startAll：打到 /api/all/start', path.startsWith('/api/all/start?token=tok'), path)
  check('startAll：原样带回 steps', result.ok === true && result.steps[0].name === 'Waylay')
}

{
  const { port } = await fakeServer((req, res) => { res.writeHead(500); res.end() })
  const result = await triggerStartAll({ port, token: 't' })
  check('startAll 500 → ok:false 带状态码', result.ok === false && result.reason === 'HTTP 500', result.reason)
}

// ------------------------------------------------ 清理

for (const server of servers) {
  try {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  } catch { /* 已经关掉的不影响结论 */ }
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
