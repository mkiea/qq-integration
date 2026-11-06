/**
 * 总纲出处校验闸单元测试 —— 2026-11-06。
 *
 * 用真实踩过的两个坑当判据：
 *   · 「看动画」是模型凭空编的（语料里根本没有）⇒ 必须丢
 *   · 「虚拟机」是**对方**说的（她没说过）⇒ 必须丢
 *
 * 用法：`node test/memory-digest-unit.mjs`
 */
import { bigrams, chunkLines, groundingRatio, filterFabricated } from '../lib/memory-digest.js'

let passed = 0
let failed = 0
const check = (name, ok, extra = '') => {
  if (ok) { passed++; console.log('PASS', name, extra) } else { failed++; console.log('FAIL', name, extra) }
}

// 语料：只有她说的话
const corpus = [
  '软软最喜欢草莓味的糖果了嘛',
  '今天被夸好几次，耳朵到现在还是热的',
  '答应给你画一个扎小辫子的oc',
  '谢谢妈妈呀……软软会好好收着的',
].join('\n')

// G1 有出处
const g1 = filterFabricated('- 她喜欢的东西：草莓味的糖果', corpus)
check('G1 有出处保留', g1.text.includes('草莓味的糖果') && g1.dropped.length === 0, g1.text)

// G2 编造
const g2 = filterFabricated('- 最近在做什么：看动画、画画', corpus)
check('G2 编造的「看动画」被丢', !g2.text.includes('看动画'), g2.text)
check('G2 短词「画画」放行', g2.text.includes('画画'), g2.text)
check('G2 记录 dropped', g2.dropped.some((d) => d.item === '看动画'), JSON.stringify(g2.dropped))

// G3 张冠李戴（对方的话不在语料里）
const g3 = filterFabricated('- 她喜欢的东西：虚拟机', corpus)
check('G3 对方说的「虚拟机」被丢', g3.dropped.some((d) => d.item === '虚拟机'), g3.text)

// G4 全丢 ⇒ 写「无」
const g4 = filterFabricated('- 她喜欢的东西：量子计算机', corpus)
check('G4 全丢时写「无」', /- 她喜欢的东西：无/.test(g4.text), g4.text)

// G5 非条目标题原样保留
const g5 = filterFabricated('# 标题\n\n> 引用行\n\n- 重要事件：被夸好几次', corpus)
check('G5 标题/引用行保留', g5.text.startsWith('# 标题') && g5.text.includes('> 引用行'), g5.text)
check('G5 真实事件保留', g5.text.includes('被夸好几次'), g5.text)

// G6 阈值可调：用"部分命中"的样例（语料里只有「草莓味的糖果」，没有「蛋糕」）
// ratio = 草莓/莓味/味的 3 个命中 ÷ 5 = 0.6 ⇒ 默认 0.3 放行、0.9 丢弃
const g6a = filterFabricated('- 她喜欢的东西：草莓味的蛋糕', corpus)
check('G6 阈值 0.3 时部分命中放行', g6a.dropped.length === 0, JSON.stringify(g6a.dropped))
const g6b = filterFabricated('- 她喜欢的东西：草莓味的蛋糕', corpus, { threshold: 0.9 })
check('G6 阈值 0.9 时同一句被丢', g6b.dropped.length === 1, JSON.stringify(g6b.dropped))

// G7 bigram / ratio 基础行为
check('G7 bigrams 去标点', JSON.stringify(bigrams('草莓，糖')) === JSON.stringify(['草莓', '莓糖']), JSON.stringify(bigrams('草莓，糖')))
check('G7 ratio 完全命中=1', groundingRatio('草莓味', corpus) === 1, String(groundingRatio('草莓味', corpus)))
check('G7 ratio 无命中=0', groundingRatio('看动画', corpus) === 0, String(groundingRatio('看动画', corpus)))
check('G7 空串 ratio=1（不误伤）', groundingRatio('', corpus) === 1)

// G8 chunkLines（分批摘要用）
check('G8 空数组 ⇒ 空块（不是 [[]]）', chunkLines([], 3).length === 0)
check('G8 整除', JSON.stringify(chunkLines([1, 2, 3, 4], 2)) === '[[1,2],[3,4]]')
check('G8 有余数', JSON.stringify(chunkLines([1, 2, 3], 2)) === '[[1,2],[3]]')
check('G8 size=0 兜底为 1', chunkLines([1, 2], 0).length === 2)
check('G8 非数组不炸', chunkLines(null, 5).length === 0)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
