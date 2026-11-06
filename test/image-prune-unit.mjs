/**
 * 图片清理选择逻辑单元测试 —— 2026-11-06（#5）。
 *
 * 判据（跑之前写死）：
 *   I1 收藏的图（`_favorites.json` 里的）**绝不动**
 *   I2 `_` 开头的一律不动（favorites / canary / 临时目录）
 *   I3 超过 keepDays 的移走，理由是 old
 *   I4 剩下的总大小超 maxBytes ⇒ 从最旧的开始移，理由 size
 *   I5 都不超 ⇒ 返回空
 *   I6 空输入 / null 不炸
 *   I7 正好卡在 keepDays 边界的不移（`< cutoff` 严格）
 *   I8 maxBytes=0 ⇒ 全部非收藏的都移走（这是"清空"语义，必须可预期）
 *
 * 用法：`node test/image-prune-unit.mjs`
 */
import { selectImagesToPrune } from '../lib/image-prune.js'

let passed = 0
let failed = 0
const check = (name, ok, extra = '') => {
  if (ok) { passed++; console.log('PASS', name, extra) } else { failed++; console.log('FAIL', name, extra) }
}

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000
const f = (name, daysAgo, mb = 1) => ({ name, mtime: NOW - daysAgo * DAY, size: mb * 1024 * 1024 })

// I1 收藏不动
const i1 = selectImagesToPrune([f('a.jpg', 100), f('b.jpg', 100)], { 'b.jpg': {} }, { now: NOW })
check('I1 收藏不动', i1.length === 1 && i1[0].name === 'a.jpg', JSON.stringify(i1))

// I2 下划线不动
const i2 = selectImagesToPrune([f('_favorites.json', 100), f('_canary-请勿动我.txt', 100), f('c.jpg', 100)], null, { now: NOW })
check('I2 下划线开头不动', i2.length === 1 && i2[0].name === 'c.jpg', JSON.stringify(i2))

// I3 超龄
const i3 = selectImagesToPrune([f('old.jpg', 40), f('new.jpg', 1)], null, { now: NOW, keepDays: 30 })
check('I3 超龄移走', i3.length === 1 && i3[0].name === 'old.jpg' && i3[0].reason === 'old', JSON.stringify(i3))

// I4 超大小（3 张各 1MB，上限 2MB ⇒ 移最旧的 1 张）
const i4 = selectImagesToPrune([f('x1.jpg', 5), f('x2.jpg', 3), f('x3.jpg', 1)], null, { now: NOW, keepDays: 30, maxBytes: 2 * 1024 * 1024 })
check('I4 超大小按最旧移', i4.length === 1 && i4[0].name === 'x1.jpg' && i4[0].reason === 'size', JSON.stringify(i4))

// I5 都不超
const i5 = selectImagesToPrune([f('y1.jpg', 1, 0.1), f('y2.jpg', 2, 0.1)], null, { now: NOW, maxBytes: 10 * 1024 * 1024 })
check('I5 都不超 ⇒ 空', i5.length === 0, JSON.stringify(i5))

// I6 空/null
check('I6 空数组 ⇒ 空', selectImagesToPrune([], null, { now: NOW }).length === 0)
check('I6 null ⇒ 空', selectImagesToPrune(null, null, { now: NOW }).length === 0)

// I7 边界（正好 30 天不移，因为用的是严格小于）
const i7 = selectImagesToPrune([f('edge.jpg', 30)], null, { now: NOW, keepDays: 30 })
check('I7 正好 30 天不移', i7.length === 0, JSON.stringify(i7))

// I8 maxBytes=0
const i8 = selectImagesToPrune([f('z1.jpg', 1), f('z2.jpg', 2)], { 'z1.jpg': {} }, { now: NOW, maxBytes: 0 })
check('I8 maxBytes=0 清空非收藏', i8.length === 1 && i8[0].name === 'z2.jpg', JSON.stringify(i8))

// 附加：收藏表写成 Set 也认
const i9 = selectImagesToPrune([f('s.jpg', 100)], new Set(['s.jpg']), { now: NOW })
check('I9 keep 支持 Set', i9.length === 0, JSON.stringify(i9))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
