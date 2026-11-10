/**
 * 体检里的「QQ 登录态」与「连上桥」降级（2026-11-10）。
 *
 * 背景：真机踩过——登录态失效/账号被风控时，6700 的 TCP 还挂着，
 * 旧逻辑三项体检全绿，实际一条消息都收不到。这里锁住三件事：
 *   ① waylay.loggedIn === false ⇒ bot-online 不能算 ok（TCP 在也不算）；
 *   ② 风控 168 ⇒ qq-login 是 error，且提示去安全中心、别反复扫码；
 *   ③ 已登录 / 未运行 两种状态各自给对结论。
 */
import { runDiagnose } from '../control/lib/diagnose.mjs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const now = Date.now()
const files = {
  exists: () => true,
  readFile: () => '',
  stat: () => ({ mtimeMs: now, isFile: () => true }),
}
const config = {
  nodeExe: 'node.exe',
  dshBin: 'bin.js',
  cwd: '.',
  logs: { runtime: 'qq-runtime.json' },
}
const snapshot = {
  ports: [
    { name: 'host', port: 3080, listening: true, pid: 1, process: 'node' },
    { name: 'onebot', port: 6700, listening: true, pid: 2, process: 'node', established: 1 },
    { name: 'tts', port: 8977, listening: false },
  ],
}
const runtime = { updatedAt: now, version: '0.1.0', sessionCount: 0, features: {} }

const run = (waylay) => runDiagnose({ config, snapshot, runtime, events: [], waylay, now, files })
const pick = (report, id) => report.checks.find((entry) => entry.id === id)

// ① 风控：TCP 在，但 bot-online 必须降级；qq-login 报 168
const blocked = run({ listening: true, loggedIn: false, loginError: { code: 168, message: '你的账号近期存在安全风险，部分功能使用受限' } })
const botBlocked = pick(blocked, 'bot-online')
const loginBlocked = pick(blocked, 'qq-login')
check('风控：bot-online 不因 TCP 连接而判 ok', botBlocked.ok === false, botBlocked.detail)
check('风控：detail 说明连接是假的', /未登录/.test(botBlocked.detail) && /假的/.test(botBlocked.detail), botBlocked.detail)
check('风控：qq-login 存在且是 error', Boolean(loginBlocked) && loginBlocked.ok === false && loginBlocked.severity === 'error', JSON.stringify(loginBlocked))
check('风控：detail 带 168 与原文', /168/.test(loginBlocked.detail) && /安全风险/.test(loginBlocked.detail), loginBlocked.detail)
check('风控：hint 指向安全中心且劝退反复扫码', /安全/.test(loginBlocked.hint) && /别一直点刷新|反复扫码/.test(loginBlocked.hint), loginBlocked.hint)

// ② 普通未登录（没有错误码）：warn，不是 error
const pending = run({ listening: true, loggedIn: false, loginError: null })
const loginPending = pick(pending, 'qq-login')
check('待扫码：qq-login 是 warn', loginPending.ok === false && loginPending.severity === 'warn', JSON.stringify(loginPending))
check('待扫码：hint 让去扫码', /二维码/.test(loginPending.hint), loginPending.hint)

// ③ 登录态失效（code 3）：error，带原文
const stale = run({ listening: true, loggedIn: false, loginError: { code: 3, message: '登录态已失效，请重新登录' } })
const loginStale = pick(stale, 'qq-login')
check('失效：qq-login 是 error 且带原因', loginStale.ok === false && loginStale.severity === 'error' && /登录态已失效/.test(loginStale.detail), JSON.stringify(loginStale))

// ④ 已登录：qq-login ok，bot-online 回到正常判断
const okState = run({ listening: true, loggedIn: true, uin: '3753306415', nickname: '猪猪鱼' })
const loginOk = pick(okState, 'qq-login')
const botOk = pick(okState, 'bot-online')
check('已登录：qq-login ok 且带 uin', loginOk.ok === true && /3753306415/.test(loginOk.detail), loginOk.detail)
check('已登录：bot-online ok', botOk.ok === true, botOk.detail)

// ⑤ Waylay 未运行：warn，提示启动
const off = run({ listening: false })
const loginOff = pick(off, 'qq-login')
check('未运行：qq-login 是 warn', loginOff.ok === false && loginOff.severity === 'warn', JSON.stringify(loginOff))
check('未运行：hint 让启动 Waylay', /启动 Waylay/.test(loginOff.hint), loginOff.hint)

// ⑥ 没传 waylay（老调用方）：不应该凭空多出 qq-login，也不能崩
const legacy = run(undefined)
check('兼容：没传 waylay 时没有 qq-login 项', pick(legacy, 'qq-login') === undefined)
check('兼容：没传 waylay 时 bot-online 仍按 TCP 判', pick(legacy, 'bot-online').ok === true, pick(legacy, 'bot-online').detail)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
