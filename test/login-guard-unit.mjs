/**
 * 登录错号检测与回退（2026-11-03 夜，主人："我刚登错号了"）。
 *
 * 为什么这件事严重：`config.botQq` 是配置值，登录事件**不会**覆盖它。
 * 登错号时所有拿它当 uin 的地方（发说说换票、selfId 判断、@ 提及）都在对着错的号干活 ——
 * `#publishMoment` 用配置号换票、cookie 却属于另一个号，最坏是内容发到别人号的空间。
 *
 * 判据：
 *   L1 `#noteLoginIdentity` 记实际号并能识别不一致
 *   L2 发说说前**实时**查一次 get_login_info（不只信配置）
 *   L3 不一致时**拒绝发布**（回退到安全状态，不是硬发）
 *   L4 运行快照里带 login 字段（控制台/体检看得见）
 *   L5 体检有 account 项，且三种形态判定正确
 */
import { readFileSync } from 'node:fs'
import { runDiagnose } from '../control/lib/diagnose.mjs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const src = readFileSync(new URL('../lib/bridge.js', import.meta.url), 'utf8')

// ---------- L1 记录实际号 ----------
const at = src.indexOf('\n  #noteLoginIdentity(')
const body = at < 0 ? '' : src.slice(at, at + 1600)
check('L1 有 #noteLoginIdentity 方法', at > 0)
check('L1 会把实际号记进 botQqActual', /this\.botQqActual\s*=\s*actual/.test(body))
check('L1 会算出 mismatch（配置>0 且不相等）', /mismatch\s*=\s*configured\s*>\s*0\s*&&\s*actual\s*!==\s*configured/.test(body))
check('L1 只在状态变化时记一条（不刷屏）', /this\.loginMismatchKey === key/.test(body))

// ---------- L2 发说说前实时校验 ----------
const pubAt = src.indexOf('\n  async #publishMoment(')
const pub = pubAt < 0 ? '' : src.slice(pubAt, pubAt + 2600)
check('L2 ★发说说前实时问 get_login_info', /getLoginInfo\(socket\)/.test(pub))
check('L2 校验失败不阻断正常发布（只是学不到号）', /login check before moment failed/.test(pub))

// ---------- L3 不一致时拒绝 ----------
check('L3 ★不一致时抛错拒绝发布', /loginMismatch[^\n]*\n?[\s\S]{0,400}throw new Error/.test(pub)
  || /if \(this\.loginMismatch[\s\S]{0,300}throw new Error/.test(pub))
check('L3 错误里说清怎么修（换号登录 / 改 botQq）', /换个号重新登录/.test(pub))
check('L3 uin 用实际号（拿不到才退回配置）', /const uin = String\(actual \|\| configured\)/.test(pub))

// ---------- L4 快照 ----------
check('L4 ★运行快照带 login 字段', /login:\s*\{[\s\S]{0,200}configured:[\s\S]{0,200}actual:/.test(src))

// ---------- L5 体检项 ----------
{
  const base = { config: { cwd: 'C:\\x', logs: { runtime: 'C:\\x\\qq-runtime.json' } }, snapshot: { ports: [] }, events: [], now: Date.now() }
  const one = (runtime) => (runDiagnose({ ...base, runtime }).checks ?? []).find((c) => c.id === 'account')
  check('L5 无登录信息 ⇒ 绿（不算异常）', one(null)?.ok === true, one(null)?.detail)
  check('L5 一致 ⇒ 绿', one({ login: { configured: 1001, actual: 1001 } })?.ok === true)
  const bad = one({ login: { configured: 1001, actual: 2002 } })
  check('L5 ★不一致 ⇒ 红，并写清两边各是多少', bad?.ok === false && /2002/.test(bad?.detail ?? '') && /1001/.test(bad?.detail ?? ''), bad?.detail)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
