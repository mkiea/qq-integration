/**
 * 人设的「标准格式」：结构、预算、校验（2026-11-01 夜，用户要「给人设弄个标准格式」）。
 *
 * 判据不能只是"模板能生成"，那谁都能过。这里钉的是**这份格式自己站不站得住**：
 *
 *   A 骨架本身逐条通过自己的校验（只允许"占位符没填"这一条已知提示）
 *   B 骨架的字节数离预算还有很大余量（一上手就顶到截断线，等于格式设计失败）
 *   C 骨架的小节顺序 = 截断优先级：身份在语气之前（含**反例**：把语气提前必须报 `order`）
 *   D 校验能分辨"缺"与"有"：残缺文本报出准确的缺项，完整文本不误报
 *   E 认节不靠逐字照抄标题（作者用同义标题也算）
 *   F 对照表没起标题也算写了（`evidence`）—— 误报"没写"最容易让人不信这份检查
 *   G 预算与占位符两条提示的方向是对的：不超不报、超了必报
 */
import { PERSONA_BUDGET_BYTES, PERSONA_SECTIONS, PERSONA_TEMPLATE, analyzePersona } from '../lib/persona-spec.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const REQUIRED = PERSONA_SECTIONS.filter((s) => s.required).map((s) => s.id)

// ---------- A. 骨架自己必须过自己的校验 ----------
{
  const a = analyzePersona(PERSONA_TEMPLATE)
  check('A 骨架没有必填缺口', a.missing.length === 0, JSON.stringify(a.missing))
  check('A 骨架不超预算', a.truncated === false, `${a.bytes}/${a.budgetBytes}`)
  const errors = a.findings.filter((f) => f.level === 'error')
  check('A 骨架没有任何 error 级问题', errors.length === 0, JSON.stringify(errors.map((f) => f.code)))
  const codes = a.findings.map((f) => f.code)
  check('A 骨架唯一的问题就是"占位符还没填"', codes.length === 1 && codes[0] === 'placeholder-left', JSON.stringify(codes))
  check('A 骨架每一节都被认出来了', a.sections.every((s) => s.present), JSON.stringify(a.sections.filter((s) => !s.present).map((s) => s.id)))
}

// ---------- B. 骨架要留足余量 ----------
{
  const bytes = Buffer.byteLength(PERSONA_TEMPLATE, 'utf8')
  check('B 骨架小于预算的 25%（写作时还有得写）', bytes < PERSONA_BUDGET_BYTES * 0.25, `${bytes} / ${PERSONA_BUDGET_BYTES}`)
  // 目标字节合计也要能装进预算，否则"照着目标写"最后一定被截断
  const targetSum = PERSONA_SECTIONS.reduce((sum, s) => sum + s.targetBytes, 0)
  check('B 按各节目标字节写满，仍然装得下预算', targetSum < PERSONA_BUDGET_BYTES, `${targetSum} / ${PERSONA_BUDGET_BYTES}`)
  check('B 必填小节的目标字节合计不超过预算的一半', PERSONA_SECTIONS.filter((s) => s.required)
    .reduce((sum, s) => sum + s.targetBytes, 0) < PERSONA_BUDGET_BYTES * 0.5)
}

// ---------- C. 顺序 = 截断优先级 ----------
{
  const ids = PERSONA_SECTIONS.map((s) => s.id)
  check('C 第一节必须是身份（截断从头砍）', ids[0] === 'identity', ids.join(','))
  check('C 「怎么说话」排在「她是谁」之后', ids.indexOf('voice') > ids.indexOf('identity'))
  check('C 必填的五节都在前六位', REQUIRED.every((id) => ids.indexOf(id) < 6), JSON.stringify(REQUIRED.map((id) => ids.indexOf(id))))

  // 反例：把语气写到最前面，必须报 order
  const swapped = analyzePersona([
    '## 怎么说话', '一条只发一句。', '',
    '## 她是谁', '她是人，猫只是特征。', '',
    '## 对面是谁', '一个网友。', '',
    '## 只发台词', '没有草稿。', '',
    '## 边界与红线', '不自称 AI。',
  ].join('\n'))
  check('C ★ 反例：语气排在身份前面会被点名', swapped.findings.some((f) => f.code === 'order'),
    JSON.stringify(swapped.findings.map((f) => f.code)))
}

// ---------- D. 缺 / 不缺，必须分得开 ----------
{
  const full = analyzePersona(PERSONA_TEMPLATE)
  check('D 完整骨架不报 missing', full.missing.length === 0, JSON.stringify(full.missing))

  // 只留"怎么说话"：五个必填里应当报出四个
  const partial = analyzePersona('## 怎么说话\n\n一条只发一句。\n')
  check('D 残缺文本报出缺项', partial.missing.length === 5 - 1, JSON.stringify(partial.missing))
  check('D 残缺文本 ok=false', partial.ok === false)
  check('D 报出来的缺项里没有"怎么说话"（它在）', !partial.missing.includes('voice'), JSON.stringify(partial.missing))

  const empty = analyzePersona('')
  check('D 空文本单独报 empty', empty.findings.some((f) => f.code === 'empty'), JSON.stringify(empty.findings.map((f) => f.code)))
  check('D 空文本 ok=false', empty.ok === false)

  const blank = analyzePersona('   \n\n  ')
  check('D 只有空白也等于空', blank.findings.some((f) => f.code === 'empty'))
}

// ---------- E. 认节不靠逐字照抄 ----------
{
  const renamed = analyzePersona([
    '## 她到底是个什么玩意儿', '她是人。', '',
    '## 对面坐的是谁', '一个网友。', '',
  ].join('\n'))
  check('E 同义标题也认得出身份', renamed.sections.find((s) => s.id === 'identity')?.present === true,
    JSON.stringify(renamed.sections.map((s) => `${s.id}:${s.present}`)))
  check('E 同义标题也认得出关系', renamed.sections.find((s) => s.id === 'relation')?.present === true)
}

// ---------- F. 对照表没起标题也算写了 ----------
{
  const withTable = analyzePersona([
    '## 怎么说话', '',
    '| 别这么说 | 这么说 |', '| --- | --- |', '| 我在家里等你回来呢 | 等你呢 |',
  ].join('\n'))
  const example = withTable.sections.find((s) => s.id === 'example')
  check('F 贴在别的小节下面的对照表也算「示范对照」', example?.present === true, JSON.stringify(example))
  check('F 走的是 evidence 而不是标题', example?.via === 'evidence', String(example?.via))

  const withoutTable = analyzePersona('## 怎么说话\n\n一条一句。\n')
  check('F 反向对照：没有表格就不该报有', withoutTable.sections.find((s) => s.id === 'example')?.present === false)
}

// ---------- G. 预算与占位符两条提示 ----------
{
  const small = analyzePersona('## 她是谁\n\n她是人。\n')
  check('G 小文件不报预算问题', !small.findings.some((f) => /budget/.test(f.code)), JSON.stringify(small.findings.map((f) => f.code)))

  const big = analyzePersona('## 她是谁\n\n' + '她'.repeat(PERSONA_BUDGET_BYTES))
  check('G ★ 超预算必报 over-budget', big.findings.some((f) => f.code === 'over-budget'), JSON.stringify(big.findings.map((f) => f.code)))
  check('G over-budget 是 error 级', big.findings.find((f) => f.code === 'over-budget')?.level === 'error')
  check('G 超预算时 truncated=true', big.truncated === true)

  // 注意单位：budget 是**字节**，一个汉字 3 字节。第一版按字符数算，直接冲到 over-budget，
  // 于是 near-budget 永远测不到（这是典型的把量纲搞混）。
  const near = analyzePersona('## 她是谁\n\n' + '她'.repeat(Math.floor(PERSONA_BUDGET_BYTES * 0.8 / 3)))
  check('G 75% 以上报 near-budget', near.findings.some((f) => f.code === 'near-budget'), JSON.stringify(near.findings.map((f) => f.code)))

  const left = analyzePersona('## 她是谁\n\n（这里写：她从哪来。）\n')
  check('G ★ 没填的占位符会被数出来', left.findings.some((f) => f.code === 'placeholder-left'), JSON.stringify(left.findings.map((f) => f.code)))
  check('G 占位符提示里带处数', /1 处/.test(String(left.findings.find((f) => f.code === 'placeholder-left')?.message ?? '')),
    String(left.findings.find((f) => f.code === 'placeholder-left')?.message ?? ''))

  // 正文里正常的括号说明不该被当成占位符（误报会让作者不再信这份检查）
  const normal = analyzePersona('## 她是谁\n\n她是人（不是助手），猫只是特征。\n')
  check('G 反向对照：普通括号说明不报占位符', !normal.findings.some((f) => f.code === 'placeholder-left'),
    JSON.stringify(normal.findings.map((f) => f.code)))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
