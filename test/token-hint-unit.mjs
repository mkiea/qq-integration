/**
 * 地址里没带 token 时，页面要给出**可点的**正确链接（2026-11-01）。
 *
 * 起因：用户打开 `127.0.0.1:8880`（没带 token），看到满屏
 * `GET /api/status?token= 401 (Unauthorized)`，判断"好像寄了"。
 * 服务端其实一直是好的 —— 只是前端拿不到 token，每个接口都被 401 挡回来。
 *
 * 页面原本就有一句提示（「请用启动控制台时窗口里打印的那行完整地址」），
 * **提示写了，但没解决问题**：用户还得自己知道去 `qq-control.json` 里翻那个 24 位串。
 * 所以改成服务端在无 token 时把提示换成一个可点的链接。
 *
 * 安全性论证（为什么敢把 token 放进页面）：
 *   · 8880 只监听 127.0.0.1，能访问它的本机进程本来就能直接读 `qq-control.json`；
 *   · 跨源网页拿不到这个页面的 DOM（同源策略），token 不会被别的网站读走。
 * 但代价是这一页的截图会带 token，所以页面上同时写了「别截图发出去」。
 *
 * 三类断言，缺一条这个改动就不可信：
 *   A 无 token → 有可点链接（修复点）
 *   B 带 token → **不**再注入（否则页面自己指向自己，越点越乱）
 *   C /api/* 无 token → 仍然是 401（**安全不能被这次改动松掉**）
 * C 是这个套件里最重要的一条：把 token 写进页面很容易顺手把鉴权也放宽，
 * 那样"方便"就变成了"谁来都能控制机器人"。
 */
import { once } from 'node:events'
import { createControlServer } from '../control/lib/server.mjs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const TOKEN = 'unit-token-7f3a9c'
const server = createControlServer({
  config: { ports: { control: 0 } },
  token: TOKEN,
  // `api` 是个对象，路由按名字取方法（`api.status()` 等），不是单个函数。
  api: { status: async () => ({ ok: true, socketUp: false, sessions: [] }) },
  uiFile: 'control/ui.html',
  logger: { info() {}, warn() {}, error() {} },
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const port = server.address().port

const get = async (path) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`)
  return { status: res.status, body: await res.text() }
}

// ---------- A. 没带 token 时给可点链接 ----------
{
  const res = await get('/')
  check('A 无 token 也能打开页面（200，不是 401 白屏）', res.status === 200, `status=${res.status}`)
  check('A 占位被替换掉了', !res.body.includes('<span id="tokenQuick"></span>'))
  check('A 页面里有带真 token 的可点链接', res.body.includes(`/?token=${TOKEN}`))
  const link = /<a href="(\/\?token=[^"]+)"[^>]*>([^<]+)</.exec(res.body)
  check('A 链接文案是人话（不是"点击这里"以外的技术词）', Boolean(link) && link[2].includes('打开'), link ? link[2] : '(没找到链接)')
  check('A 同时提醒了别截图外发', res.body.includes('别截图'))
}

// ---------- B. 带 token 时不注入（避免自我指向） ----------
{
  const res = await get(`/?token=${TOKEN}`)
  check('B 带 token 打开正常', res.status === 200, `status=${res.status}`)
  check('B 不再注入链接（页面不该自己指向自己）', !res.body.includes('点这里用正确的地址打开'))
}

// ---------- C. 鉴权没被这次改动松掉 ----------
{
  const res = await get('/api/status')
  check('C /api/status 无 token 仍然是 401', res.status === 401, `status=${res.status}`)
  const bad = await get('/api/status?token=wrong-token')
  check('C 带了错 token 也是 401', bad.status === 401, `status=${bad.status}`)
  const ok = await get(`/api/status?token=${TOKEN}`)
  check('C 带对 token 才放行', ok.status === 200, `status=${ok.status}`)
}

// ---------- D. 页面本身不该把 token 写进别的请求里 ----------
{
  const res = await get('/')
  // 允许出现一次（那条链接），但不该出现第二次（比如被塞进每个 fetch 的模板里）
  const hits = res.body.split(`/?token=${TOKEN}`).length - 1
  check('D token 只出现在那一条链接里', hits === 1, `出现 ${hits} 次`)
}

server.close()
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
