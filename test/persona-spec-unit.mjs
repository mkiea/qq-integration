/**
 * 人设「标准格式」：五块结构 / 预算 / 校验（2026-11-01，当晚从 10 节简化到 5 块）。
 *
 * 判据不能只是"模板能生成"，那谁都能过。这里钉的是**这份格式自己站不站得住**：
 *
 *   A 骨架逐条通过自己的校验（只允许"占位符没填"这一条已知提示）
 *   B 骨架远离预算（一上手就顶到截断线 = 格式设计失败）
 *   C 顺序 = 截断优先级：身份在最前（含**反例**：把语气提前必须报 order）
 *   D 缺 / 不缺分得开
 *   E 认块不靠 `#`、也不靠逐字照抄标题（从网页粘进来 `#` 会整片丢 —— 真机踩过）
 *   F 红线超过 5 条要报（含边界：5 条不报、6 条报）
 *   G 负面清单：红线之外"不要/别"太多要报，且不算中文歧义字（特别/区别/性别…）
 *   H 预算三条提示方向正确（不许把字节当字符算）
 */
import { PERSONA_BLOCKS, PERSONA_BUDGET_BYTES, PERSONA_TEMPLATE, analyzePersona, countNegative } from '../lib/persona-spec.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const REQUIRED = PERSONA_BLOCKS.filter((b) => b.required).map((b) => b.id)

// ---------- A. 骨架自己必须过自己的校验 ----------
{
  const a = analyzePersona(PERSONA_TEMPLATE)
  check('A 骨架没有必填缺口', a.missing.length === 0, JSON.stringify(a.missing))
  check('A 骨架不超预算', a.truncated === false, `${a.bytes}/${a.budgetBytes}`)
  const errors = a.findings.filter((f) => f.level === 'error')
  check('A 骨架没有任何 error 级问题', errors.length === 0, JSON.stringify(errors.map((f) => f.code)))
  const codes = a.findings.map((f) => f.code)
  check('A 骨架唯一的问题就是"占位符还没填"', codes.length === 1 && codes[0] === 'placeholder-left', JSON.stringify(codes))
  check('A 骨架每一块都被认出来了', a.blocks.every((b) => b.present), JSON.stringify(a.blocks.filter((b) => !b.present).map((b) => b.id)))
  check('A 骨架没触发"红线太多"', !codes.includes('too-many-rules'), JSON.stringify(codes))
  check('A 骨架没触发"负面清单过密"', !codes.includes('negative-heavy'), JSON.stringify(codes))
}

// ---------- B. 骨架要留足余量 ----------
{
  const bytes = Buffer.byteLength(PERSONA_TEMPLATE, 'utf8')
  check('B 骨架小于预算的 10%（写起来不用先删模板）', bytes < PERSONA_BUDGET_BYTES * 0.1, `${bytes} / ${PERSONA_BUDGET_BYTES}`)
  const targetSum = PERSONA_BLOCKS.reduce((sum, b) => sum + b.targetBytes, 0)
  check('B 按各块目标字节写满，仍装得下预算', targetSum < PERSONA_BUDGET_BYTES, `${targetSum} / ${PERSONA_BUDGET_BYTES}`)
  check('B 必填五节的目标字节合计不超过预算的一半', PERSONA_BLOCKS.filter((b) => b.required)
    .reduce((sum, b) => sum + b.targetBytes, 0) < PERSONA_BUDGET_BYTES * 0.5)
  /**
   * ★ 3 → 5（2026-11-03，主人拍板恢复 10 节）。
   *
   * 旧断言「只有三块必填」描述的是 2026-11-01 那次"10 节简化成 5 块"的产物。
   * 现在按原表恢复：**前五节必填**（她是谁／对面是谁／怎么说话／只发台词／边界与红线），
   * 后五节（没人找她／表情语音／情绪／世界／示范对照）可选。
   * 所以这条断言必须跟着变 —— 它不是回归，是**约定本身变了**。
   */
  check('B ★ 前五节必填（10 节结构：后五节可选）', REQUIRED.length === 5, JSON.stringify(REQUIRED))
  check('B 必填的正好是前五节', REQUIRED.join(',') === 'who,other,voice,lines,rules', JSON.stringify(REQUIRED))
}

// ---------- C. 顺序 = 截断优先级 ----------
{
  const ids = PERSONA_BLOCKS.map((b) => b.id)
  check('C 第一块必须是身份（截断从头砍）', ids[0] === 'who', ids.join(','))
  check('C 「怎么说」排在「她是谁」之后', ids.indexOf('voice') > ids.indexOf('who'))

  const swapped = analyzePersona([
    '## 怎么说', '一条只发一句。', '',
    '## 她是谁', '她是人，猫只是特征。', '',
    '## 红线', '不自称 AI。',
  ].join('\n'))
  check('C ★ 反例：语气排在身份前面会被点名', swapped.findings.some((f) => f.code === 'order'),
    JSON.stringify(swapped.findings.map((f) => f.code)))
}

// ---------- D. 缺 / 不缺，必须分得开 ----------
{
  const partial = analyzePersona('## 怎么说\n\n一条只发一句。\n')
  // 10 节恢复后必填是 5 节：只写「怎么说话」⇒ 缺 who/other/lines/rules 共 4 项（旧值 2 是 5 块时代的）
  check('D 残缺文本报出缺项', partial.missing.length === 4, JSON.stringify(partial.missing))
  check('D 残缺文本里没有"怎么说"（它在）', !partial.missing.includes('voice'), JSON.stringify(partial.missing))
  check('D 残缺文本 ok=false', partial.ok === false)

  const empty = analyzePersona('')
  check('D 空文本单独报 empty', empty.findings.some((f) => f.code === 'empty'), JSON.stringify(empty.findings.map((f) => f.code)))
  check('D 只有空白也等于空', analyzePersona('   \n\n  ').findings.some((f) => f.code === 'empty'))
}

// ---------- E. 认块：不许只认 `#`，也不许要求照抄标题 ----------
{
  // 真机现场：从网页复制过来，`##` 整片丢了，只剩 "1. 她是谁（身份脊柱）"
  const pasted = analyzePersona([
    'QQ 聊天人格：某某',
    '你在这台机器上只做一件事。',
    '',
    '1. 她是谁（身份脊柱）',
    '她是人，猫只是特征。',
    '',
    '2. 对面是谁',
    '一个网友。',
    '',
    '3. 怎么说话',
    '一条只发一句。',
    '',
    '4. 只发台词',
    '思考不算台词。',
    '',
    '5. 边界与红线',
    '不自称 AI。',
  ].join('\n'))
  /**
   * ★ 3 → 5（2026-11-03，10 节恢复）。旧样本故意漏了「只发台词」，因为那时它是并进 voice 的；
   * 现在它是**独立必填块**，所以样本补上第 4 节，断言变成"五个必填块全认出、且不报缺项"——
   * 这才是这条用例真正想验的事：**`#` 整片丢掉时，靠编号也能把必填块认全**。
   */
  check('E ★ `#` 被吃掉时仍然认得出块', pasted.blocks.filter((b) => b.present).length === 5,
    JSON.stringify(pasted.blocks.map((b) => `${b.id}:${b.present}`)))
  check('E ★ 这种情况不该报"缺必填"', pasted.missing.length === 0, JSON.stringify(pasted.missing))

  const renamed = analyzePersona([
    '## 她到底是个什么玩意儿', '她是人。', '',
    '## 说话规矩', '一句一条。', '',
    '## 底线', '不自称 AI。',
  ].join('\n'))
  check('E 同义标题也认得出身份', renamed.blocks.find((b) => b.id === 'who')?.present === true)
  check('E 同义标题也认得出红线', renamed.blocks.find((b) => b.id === 'rules')?.present === true)
}

// ---------- F. 红线不超过 5 条 ----------
{
  const make = (n) => '## 红线\n\n' + Array.from({ length: n }, (_, i) => `- 第 ${i + 1} 条禁令`).join('\n') + '\n'
  check('F 5 条不报（边界）', !analyzePersona(make(5)).findings.some((f) => f.code === 'too-many-rules'))
  check('F ★ 6 条要报', analyzePersona(make(6)).findings.some((f) => f.code === 'too-many-rules'))
  check('F 报的是 warn 不是 error', analyzePersona(make(9)).findings.find((f) => f.code === 'too-many-rules')?.level === 'warn')
  check('F 条数写进了提示里', /9 条/.test(String(analyzePersona(make(9)).findings.find((f) => f.code === 'too-many-rules')?.message ?? '')))
}

// ---------- G. 负面清单密度 + 中文歧义字 ----------
{
  check('G countNegative 不把「特别」当否定', countNegative('特别好的区别') === 0, String(countNegative('特别好的区别')))
  check('G countNegative 数得出「不要/别」', countNegative('不要这样，别那样') === 2, String(countNegative('不要这样，别那样')))
  check('G countNegative 放过「性别/类别/个别」', countNegative('性别、类别、个别情况') === 0, String(countNegative('性别、类别、个别情况')))

  const heavy = '## 怎么说\n\n' + '不要这样。别那样。不许再问。不准敷衍。不能解释。\n'
  check('G ★ 红线之外"不要/别"过多要报', analyzePersona(heavy).findings.some((f) => f.code === 'negative-heavy'),
    JSON.stringify(analyzePersona(heavy).findings.map((f) => f.code)))

  const fine = '## 怎么说\n\n一句一条。\n不要超过两句。\n'
  check('G 反向对照：少量否定不报', !analyzePersona(fine).findings.some((f) => f.code === 'negative-heavy'))

  const rulesHeavy = '## 红线\n\n不要编造。别翻别处。不许假装。不准跑题。不能说谎。别装。\n'
  check('G 红线里全是禁令也不报（那本来就是禁令区）',
    !analyzePersona(rulesHeavy).findings.some((f) => f.code === 'negative-heavy'))
}

// ---------- H. 预算三条提示 ----------
{
  const small = analyzePersona('## 她是谁\n\n她是人。\n')
  check('H 小文件不报预算问题', !small.findings.some((f) => /budget/.test(f.code)), JSON.stringify(small.findings.map((f) => f.code)))

  const big = analyzePersona('## 她是谁\n\n' + '她'.repeat(Math.floor(PERSONA_BUDGET_BYTES / 3) + 10))
  check('H ★ 超预算必报 over-budget', big.findings.some((f) => f.code === 'over-budget'), JSON.stringify(big.findings.map((f) => f.code)))
  check('H over-budget 是 error 级', big.findings.find((f) => f.code === 'over-budget')?.level === 'error')
  check('H 超预算时 truncated=true', big.truncated === true)

  // 单位：budget 是**字节**，一个汉字 3 字节。上一版按字符算，直接冲到 over-budget，
  // 于是 near-budget 永远测不到（量纲错在测试里也一样致命）。
  const near = analyzePersona('## 她是谁\n\n' + '她'.repeat(Math.floor(PERSONA_BUDGET_BYTES * 0.8 / 3)))
  check('H 75% 以上报 near-budget', near.findings.some((f) => f.code === 'near-budget'), JSON.stringify(near.findings.map((f) => f.code)))

  const left = analyzePersona('## 她是谁\n\n（这里写：她从哪来。）\n（这里写：她怕什么。）\n')
  check('H ★ 没填的占位符会被数出来', /2 处/.test(String(left.findings.find((f) => f.code === 'placeholder-left')?.message ?? '')),
    String(left.findings.find((f) => f.code === 'placeholder-left')?.message ?? ''))
  check('H 普通括号说明不误报', !analyzePersona('## 她是谁\n\n她是人（不是助手）。\n').findings.some((f) => f.code === 'placeholder-left'))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
