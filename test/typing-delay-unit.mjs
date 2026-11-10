/**
 * 打字延迟的随机抖动（2026-11-10）。
 *
 * 原来 `typingDelayFor` 是精确的 `500 + 字数×80`，每次同样字数都是同一个毫秒数 ——
 * 在日志里就是一条直线。这里锁住：按字数增长、上下限夹紧、抖动以 1 为中心（均值不变）。
 */
import { typingDelayFor } from '../lib/bridge.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const fixed = (text, jitter = 0) => typingDelayFor(text, { rng: () => 0.5, jitter })

check('按字数增长', fixed('短') < fixed('十个字的句子啊'), `${fixed('短')} < ${fixed('十个字的句子啊')}`)
check('空文本取下限 600ms', fixed('') === 600, String(fixed('')))
check('超长文本取上限 2400ms', fixed('一'.repeat(100)) === 2400, String(fixed('一'.repeat(100))))
check('中段按 500 + 字数×80 计算', fixed('十个字的句子啊') === 500 + 6 * 80 || fixed('一二三四五六七八九十') === 1300,
  `${fixed('十个字的句子啊')} / ${fixed('一二三四五六七八九十')}`)

const base = fixed('一二三四五六七八九十')
const low = typingDelayFor('一二三四五六七八九十', { rng: () => 0, jitter: 0.2 })
const high = typingDelayFor('一二三四五六七八九十', { rng: () => 1, jitter: 0.2 })
check('抖动下限 = 基准 × 0.8', low === Math.round(base * 0.8), `${low} vs ${Math.round(base * 0.8)}`)
check('抖动上限 = 基准 × 1.2', high === Math.round(base * 1.2), `${high} vs ${Math.round(base * 1.2)}`)
check('抖动以 1 为中心（均值不变）', Math.abs((low + high) / 2 - base) <= 1, `${(low + high) / 2} vs ${base}`)

const samples = Array.from({ length: 40 }, () => typingDelayFor('一二三四五六七八九十'))
const uniq = new Set(samples)
check('默认参数下 40 次不全是同一个值', uniq.size >= 10, `uniq=${uniq.size}`)
check('默认抖动仍在 [600, 2400] 内', samples.every((ms) => ms >= 600 && ms <= 2400), JSON.stringify([Math.min(...samples), Math.max(...samples)]))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
