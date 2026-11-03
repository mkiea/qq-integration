/**
 * 主动通道的失败退避（2026-11-03 夜）。
 *
 * 为什么要测：断网时"发 → 失败 → 额度还回去 → 再发"每 60 秒循环一次
 * （真机 20–22 点：39 次通道启动、17 次"没发出去、额度还回去了"）。
 * 根因不是发送逻辑，而是**失败没有留痕** —— 回滚把这次尝试还原成"没发生过"。
 *
 * 判据（跑之前写死）：
 *   B1 退避表：0 次不退化、1→2 分、2→5 分、3→15 分、≥4→60 分封顶
 *   B2 刚失败时在退避中（remaining > 0）
 *   B3 过了窗口就可以试（remaining = 0）
 *   B4 老账（有失败计数但没有 lastFailedAt）不永久卡死
 *   B5 源码级：回滚分支真的写了 failedAttempts（防回退）
 *   B6 源码级：评估前有退避闸（防回退）
 *   B7 源码级：多进程检测会返回 false 并让位（防回退）
 */
import { readFileSync } from 'node:fs'
import { proactiveBackoffMs, proactiveInBackoff } from '../lib/bridge.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const MIN = 60_000

// ---------- B1 退避表 ----------
check('B1 没失败 ⇒ 不退避', proactiveBackoffMs(0) === 0, String(proactiveBackoffMs(0)))
check('B1 undefined/负数 ⇒ 不退避', proactiveBackoffMs(undefined) === 0 && proactiveBackoffMs(-3) === 0)
check('B1 第 1 次 ⇒ 2 分钟', proactiveBackoffMs(1) === 2 * MIN, String(proactiveBackoffMs(1)))
check('B1 第 2 次 ⇒ 5 分钟', proactiveBackoffMs(2) === 5 * MIN, String(proactiveBackoffMs(2)))
check('B1 第 3 次 ⇒ 15 分钟', proactiveBackoffMs(3) === 15 * MIN, String(proactiveBackoffMs(3)))
check('B1 第 4 次以后 ⇒ 60 分钟封顶', proactiveBackoffMs(4) === 60 * MIN && proactiveBackoffMs(99) === 60 * MIN,
  String(proactiveBackoffMs(99)))

// ---------- B2/B3 窗口内外 ----------
const now = 1_800_000_000_000
{
  const st = { failedAttempts: 1, lastFailedAt: now - 30_000 }   // 30 秒前失败过一次
  const r = proactiveInBackoff(st, now)
  check('B2 刚失败 ⇒ 仍在退避（剩约 90 秒）', r.failures === 1 && Math.abs(r.remaining - 90_000) < 1000, JSON.stringify(r))
}
{
  const st = { failedAttempts: 1, lastFailedAt: now - 3 * MIN }  // 3 分钟前（窗口 2 分钟已过）
  const r = proactiveInBackoff(st, now)
  check('B3 过了窗口 ⇒ 可以再试', r.remaining === 0, JSON.stringify(r))
}
{
  const st = { failedAttempts: 4, lastFailedAt: now - 30 * MIN } // 4 次失败，30 分钟前
  const r = proactiveInBackoff(st, now)
  check('B3 4 次失败 / 30 分钟前 ⇒ 还要等 30 分钟', Math.abs(r.remaining - 30 * MIN) < 1000, JSON.stringify(r))
}

// ---------- B4 老账 ----------
{
  const r = proactiveInBackoff({ failedAttempts: 5 }, now)
  check('B4 有失败计数但没有 lastFailedAt ⇒ 不永久卡死', r.remaining === 0, JSON.stringify(r))
}

// ---------- B5–B7 源码级（防回退） ----------
const src = readFileSync(new URL('../lib/bridge.js', import.meta.url), 'utf8')
// 注意要取**方法定义**（行首缩进 + #），不是调用点 this.#proactiveRollback(...)
const rbAt = src.indexOf('\n  #proactiveRollback(')
const rollbackBody = rbAt < 0 ? '' : src.slice(rbAt, rbAt + 2500)
check('B5 ★回滚分支写了 failedAttempts（循环的根源就在这）', /failedAttempts:\s*failures/.test(rollbackBody))
check('B5 回滚不再只写"额度已还回去"', /退避 \$\{backoffSec\}/.test(rollbackBody))
const evalBody = src.slice(src.indexOf('async #proactiveEvaluate('), src.indexOf('async #proactiveEvaluate(') + 1600)
check('B6 ★评估前有退避闸', /proactiveInBackoff\(/.test(evalBody) && /return/.test(evalBody))
check('B7 ★多进程检测返回 false 时本 tick 让位', /if \(this\.#proactiveCheckSoleWriter\(\) === false\)/.test(src))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
