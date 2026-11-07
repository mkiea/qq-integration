/**
 * 离线重放守卫的单元测试 —— 2026-11-07。
 *
 * 这个模块的判断直接影响「会不会刷屏」，而它的失败模式是**静默**的：
 * 阈值写错不会报错，只会让 203 条重放全部回出去，或者把正常聊天全吞掉。
 * 所以每条边界都用固定 `now` 钉住，不依赖真实时钟。
 */
import { createReplayGuard } from '../lib/replay-guard.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// ------------------------------------------------ 1. 正常节奏：一条都不拦
{
  const g = createReplayGuard({ windowMs: 5000, burst: 6, silenceMs: 20_000 })
  let blocked = 0
  for (let i = 0; i < 5; i += 1) {
    if (g.inspect('u:1', 1000 + i * 1000).block) blocked += 1
  }
  check('5 秒内 5 条：全部放行', blocked === 0, `blocked=${blocked}`)
}

// ------------------------------------------------ 2. 批量重放：第 6 条开始拦
{
  const g = createReplayGuard({ windowMs: 5000, burst: 6, silenceMs: 20_000 })
  const t0 = 10_000
  for (let i = 0; i < 5; i += 1) g.inspect('u:1', t0)
  const sixth = g.inspect('u:1', t0)
  check('第 6 条触发 burst', sixth.block === true && sixth.reason === 'replay-burst', JSON.stringify(sixth))
  check('burst 时给出 until', Number(sixth.until) === t0 + 20_000, String(sixth.until))
}

// ------------------------------------------------ 3. 静默期：一律拦，到期自动放行
{
  const g = createReplayGuard({ windowMs: 5000, burst: 2, silenceMs: 20_000 })
  const t0 = 0
  g.inspect('u:1', t0)
  g.inspect('u:1', t0) // 第 2 条触发
  const during = g.inspect('u:1', t0 + 1000)
  check('静默期内拦截', during.block === true && during.reason === 'replay-silence', JSON.stringify(during))
  check('静默期最后一毫秒仍拦', g.inspect('u:1', t0 + 19_999).block === true)
  check('静默期结束后放行', g.inspect('u:1', t0 + 20_001).block === false)
}

// ------------------------------------------------ 4. 窗口外的旧记录不累计
{
  const g = createReplayGuard({ windowMs: 5000, burst: 3, silenceMs: 20_000 })
  g.inspect('a', 0)
  g.inspect('a', 100)
  // 6000 > 5000，前两条都应被清掉，这一条不算「第 3 条」
  const r = g.inspect('a', 6000)
  check('窗口外不累计', r.block === false, JSON.stringify(r))
}

// ------------------------------------------------ 5. 会话之间互不影响
{
  const g = createReplayGuard({ windowMs: 5000, burst: 3, silenceMs: 20_000 })
  g.inspect('a', 0)
  g.inspect('a', 0)
  g.inspect('a', 0) // a 被静默
  check('a 已被静默', g.inspect('a', 1).block === true)
  check('b 不受影响', g.inspect('b', 1).block === false)
}

// ------------------------------------------------ 6. 空 key / reset
{
  const g = createReplayGuard({ windowMs: 5000, burst: 2 })
  check('空 key 不拦', g.inspect('', 0).block === false)
  check('null key 不拦', g.inspect(null, 0).block === false)
  check('空 key 不建状态', g.size() === 0, String(g.size()))

  g.inspect('x', 0)
  g.inspect('x', 0)
  check('reset 后重新计数', (g.reset(), g.inspect('x', 0).block === false))
}

// ------------------------------------------------ 7. burst 边界（1 = 持续静默，别这样配）
{
  const g = createReplayGuard({ windowMs: 5000, burst: 1, silenceMs: 1000 })
  check('burst=1：第一条就拦', g.inspect('u', 0).block === true)
  check('burst=1：静默后仍拦', g.inspect('u', 500).block === true)
  // burst=1 时静默结束后的第一条又会立刻凑满 1 条 ⇒ 继续静默（这是边界语义，不是 bug）
  check('burst=1：静默结束后第一条再次触发', g.inspect('u', 1001).block === true)
}

// ------------------------------------------------ 8. 默认阈值（防止常量改了文档没同步）
{
  const g = createReplayGuard() // 全默认
  let blocked = 0
  for (let i = 0; i < 9; i += 1) {
    if (g.inspect('d', i * 100).block) blocked += 1
  }
  check('默认阈值：9 条全部放行（真人连发不该被吞）', blocked === 0, `blocked=${blocked}`)
  check('默认阈值：第 10 条触发', g.inspect('d', 1000).block === true)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
