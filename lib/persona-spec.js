/**
 * 人设文件（`cwd/AGENTS.md`）的标准格式 —— **结构、预算、校验**（2026-11-01，当晚简化过一次）。
 *
 * ## 为什么是这个形状（两条硬约束 + 三条别人的经验）
 *
 * 硬约束（本机实测）：
 *   ① 整份文件**追加**进 system，不替换基础指令 ⇒ 只写"她"，不写通用助手规矩；
 *   ② 有字节预算（`@deepseek-ai/dsh-agent-instructions` 的 `maxBytes`，本 profile = 32768），
 *      超了**按字节从头截断且不报错** ⇒ 越靠前越不能丢。
 *
 * 别人的经验（Character Card V1/V2 那套，SillyTavern 生态的事实标准）：
 *   ① **必填字段很少**：V1 六个（name/description/personality/scenario/first_mes/mes_example），
 *      V2 加的全是可选槽位；没有一家要求作者填十几节。
 *   ② **`description` 是主干，建议 1500 字符以内**；`mes_example`（对话示例）性价比最高 ——
 *      这与本项目纪律 68「示范端 ≫ 提示端」（36.8 → 17.5）是同一件事。
 *   ③ **别把"不要…"堆成清单**：负面指令的效力明显弱于正面描述，经验比例约 3:1；
 *      同一句重复三遍也不会更有效。红线之外一律"说她怎么做"。
 *
 * ## 所以：10 节 → **5 块**（必填 3）
 *
 * 上一版按"每一件事一节"切了 10 节，写起来像填表，作者要先读懂分类才能动笔 ——
 * 那是给评审看的结构，不是给人写人设用的。现在按**写到哪一段**来切：
 *   她是谁（含对面是谁）｜怎么说（含示范）｜红线（含世界边界）｜表现（表情语音情绪）｜主动
 *
 * ⚠️ 这是**格式**，不是评分。`analyzePersona` 只报可判定的事（缺块 / 超预算 / 占位符 / 顺序 /
 * 红线条数 / 负面清单密度），不假装能判断"写得好不好"——那种分只会让作者去优化分。
 */

/** 宿主那条 instruction 的字节预算。改这里必须同步 `~/.dsh/profiles/web/cordis.patch.yml` 的 maxBytes。 */
export const PERSONA_BUDGET_BYTES = 32 * 1024

/**
 * 五块定义。`order` 即写入顺序 = **截断优先级**（越靠前越不能丢）。
 *
 * `targetBytes` 是"写满了大概多少"，不是硬上限；五块合计约 8 KiB，
 * 离 32 KiB 留 4 倍余量 —— 一上手就顶到截断线，等于格式设计失败。
 */
export const PERSONA_BLOCKS = [
  {
    id: 'who',
    title: '她是谁（身份脊柱）',
    required: true,
    targetBytes: 2400,
    keywords: ['她是谁', '身份', '身世', '来历', '从哪来', '脊柱'],
    // 作者很少逐字照抄标题，用一条正则兜住常见说法（"她到底是个什么玩意儿""关于她这个人"）。
    pattern: /她.{0,6}(是谁|是什么|是啥|从哪|打哪|到底|这个人)/,
    ask: '四个问题都要答：① 她是什么（人；猫只是特征）② 从哪来 ③ 她怎么知道外面的事 ④ 她最怕什么。',
    avoid: '别用"傲娇/温柔/猫娘"当身份：形容词是倾向，换个角色也能套。',
  },
  {
    id: 'other',
    title: '对面是谁',
    required: true,
    targetBytes: 1200,
    keywords: ['对面是谁', '对方是谁', '对面', '他知道', '知道哪些', '看不到'],
    ask: '他知道哪些、不知道哪些、能看到什么；她不知道的就不许编（这条决定她会不会露馅）。',
    avoid: '别把对方写成全知全能——他看不见的才是戏。',
  },
  {
    id: 'voice',
    title: '怎么说话',
    required: true,
    targetBytes: 1800,
    keywords: ['怎么说话', '怎么说', '说话', '腔调', '长度', '口癖', '节奏', '口语'],
    ask: '一条几句、能短到哪、口癖、哪些腔调一出现就露馅。',
    avoid: '别写"要自然、要像人"（那是目标不是规则）；别用一串"不要…"代替示范。',
  },
  {
    id: 'lines',
    title: '只发台词',
    required: true,
    targetBytes: 900,
    keywords: ['只发台词', '台词', '草稿', '默认动作', '不出手'],
    ask: '哪些算草稿（不该发出去的思考）、不出手时的默认动作是什么。',
    avoid: '别写成"想清楚再发"——那是要求，不是可执行的规则。',
  },
  {
    id: 'rules',
    title: '边界与红线',
    required: true,
    targetBytes: 900,
    keywords: ['边界', '红线', '底线', '不许', '禁止'],
    ask: '不超过 5 条，只放"做了就毁设定"的事（不自称 AI、不编造看过或记得的内容、硬性环境边界）。',
    avoid: '别把风格偏好（不能骂人、别说方言）塞进红线；也别写成二十条禁令。',
  },
  {
    id: 'initiative',
    title: '没人找她的时候',
    required: false,
    targetBytes: 1200,
    keywords: ['没人找', '主动', '旁白', '想找他', '动态', '空间', '被无视'],
    ask: '没有新消息时会不会开口、旁白怎么用、不想说时怎么收场、被无视之后怎么办。',
    avoid: '别写成"定时问候"——那是客服行为。',
  },
  {
    id: 'show',
    title: '表情与语音',
    required: false,
    targetBytes: 1200,
    keywords: ['表情与语音', '表情', '语音', '张数', '时长', '工具'],
    ask: '用哪个工具、几轮一次、语音多长、图片几张上限。',
    avoid: '别写"适当使用"——频率要给数（几轮一次），否则等于没说。',
  },
  {
    id: 'emotion',
    title: '情绪怎么露出来',
    required: false,
    targetBytes: 700,
    keywords: ['情绪', '外显', '嘴硬', '服软', '露出来'],
    ask: '外显夸张度、嘴硬与服软的先后顺序、上来快还是下去慢。',
    avoid: '别写"该生气时生气"——那种句子什么角色都能用。',
  },
  {
    id: 'world',
    title: '她脚下的世界',
    required: false,
    targetBytes: 600,
    keywords: ['世界', '能碰', '碰不到', '环境', '现实'],
    ask: '能碰什么、碰不到什么（会不会出门、有没有钱、认不认字）。',
    avoid: '别和"红线"混着写：那是不许做的事，这是做不到的事。',
  },
  {
    id: 'demo',
    title: '示范对照',
    required: false,
    targetBytes: 800,
    keywords: ['示范对照', '对照', '示例', '长短'],
    ask: '一张长短对照表（别这么说 → 这么说），3–5 行；这是给模仿用的，不是给检查用的。',
    avoid: '别用"不要…"列表代替对照表——示范比禁令好使。',
  },
]

/**
 * 标准骨架（约 1 KB）。
 *
 * 占位符统一写成 `（这里写：…）`，便于机检"还有没填的"，也让作者一眼看出哪几块是空的。
 * 刻意留短：骨架是**结构**，不是范本。每块"要回答什么"在 `PERSONA_BLOCKS` 里、由面板显示；
 * 塞进文件里的话，她读到的就成了指导语。
 */
export const PERSONA_TEMPLATE = `# 人设 · （这里写：她的名字）

<!--
  只写她。这份文件会**追加**进 system，不替换宿主的基础指令；
  预算 32 KiB，超了按字节从头截断（不报错）⇒ 越靠前越不能丢。
  十节结构：前五节必填，后五节按需。每节"要回答什么"面板上会提示。
-->

## 1. 她是谁（身份脊柱）

（这里写：她是什么。——人；猫只是特征，不是嵌合体。）

（这里写：从哪来。）

（这里写：她怎么知道外面的事。——猫的眼睛／屏幕／只有你说的。）

（这里写：她最怕什么。）

## 2. 对面是谁

（这里写：他知道哪些、不知道哪些、能看到什么。）

（这里写：她不知道的就不许编——这条决定她会不会露馅。）

## 3. 怎么说话

（这里写：一条几句。能短到哪。口癖。哪些腔调一出现就露馅。）

## 4. 只发台词

（这里写：哪些算草稿、不该发出去。）

（这里写：不出手时的默认动作是什么。）

## 5. 边界与红线

（这里写：不超过 5 条，只放"做了就毁设定"的事。）

## 6. 没人找她的时候

（这里写：没消息时会不会开口、旁白怎么用、被无视之后。）

## 7. 表情与语音

（这里写：用哪个工具、几轮一次、语音多长、图片几张。）

## 8. 情绪怎么露出来

（这里写：外显夸张度、嘴硬与服软的先后。）

## 9. 她脚下的世界

（这里写：能碰什么、碰不到什么。）

## 10. 示范对照

| 别这么说 | 这么说 |
| --- | --- |
| （这里写：长而完整的一句） | （这里写：短的那句） |
`

/**
 * 这一行是不是一个"块标题"？
 *
 * ⚠️ **不能只认 `#`**：真机踩过 —— 从网页/文档复制进来时 markdown 的 `#` 会整片丢掉，
 * 于是 `## 1. 她是谁（身份脊柱）` 变成 `1. 她是谁（身份脊柱）`，
 * 上一版按 `^#` 切块 ⇒ 五块全认不出，面板报"缺三个必填块"，而人设其实是完整的。
 * （作者第一反应一定是"这工具有问题"，而且他是对的。）
 *
 * 判据放宽到三条，任一命中即算标题：
 *   ① `#` 开头（正常 markdown）
 *   ② `1.` / `1、` 这种编号开头且很短 —— 这是导出成纯文本后标题最常见的残留
 *   ③ 很短、不以句末标点结尾、且包含某一块的关键词
 * 正文句子通常长、且以「。？！」结尾，不会误判。
 */
function looksLikeTitle(line, title) {
  const raw = line.trim()
  if (raw === '') return false
  if (/^#{1,6}\s+/.test(raw)) return true
  if (title === '' || title.length > 30) return false
  if (/[。！？；]$/.test(title)) return false
  if (/^\d+[.、)．]\s*\S/.test(raw.trim())) return title.length <= 24
  return PERSONA_BLOCKS.some((block) => block.keywords.some((word) => title.includes(word)))
}

/** 去掉 `#` 与 `1.` 这类前缀，只留标题文字。 */
function titleTextOf(line) {
  return line.trim().replace(/^#{1,6}\s*/, '').replace(/^\d+[.、)．]\s*/, '').trim()
}

/** 按标题切块（每块的 `text` 含标题行本身，用于量这一块占多少字节）。 */
function splitByBlock(text) {
  const blocks = []
  let current = { title: '', lines: [] }
  for (const line of String(text ?? '').split('\n')) {
    const title = titleTextOf(line)
    if (looksLikeTitle(line, title)) {
      if (current.lines.length > 0 || current.title !== '') blocks.push(current)
      current = { title, lines: [line] }
    } else {
      current.lines.push(line)
    }
  }
  blocks.push(current)
  return blocks.map((block) => ({ title: block.title, text: block.lines.join('\n') }))
}

/** 一个标题属于哪一块（关键词或正则命中即算）。认不出返回空串。 */
function blockIdOfTitle(title) {
  for (const block of PERSONA_BLOCKS) {
    if (block.keywords?.some((word) => title.includes(word))) return block.id
    if (typeof block.pattern?.test === 'function' && block.pattern.test(title)) return block.id
  }
  return ''
}

/**
 * 数"负面说法"的处数：不要 / 不许 / 不准 / 禁止 / 不能 / 别。
 *
 * 为什么要数：负面指令的效力明显弱于正面描述（同一句重复几遍也不会更强），
 * 而中文人设最容易写成"别这样、不要那样"的清单。这里只数**红线之外**的块 ——
 * 红线本来就是禁令区，数它没有意义。
 *
 * ⚠️ 中文里的"别"是歧义字：特别/区别/分别/性别/类别/个别/告别/级别/识别 都不算否定。
 * 先把这些词剔掉再数，否则一份正常的人设会被判成"满篇禁令"（第一次实现就误报了）。
 */
const BIE_HOMOGRAPHS = /特别|区别|分别|类别|性别|个别|告别|离别|级别|识别|鉴别|别处|别的|别人/g
export function countNegative(text) {
  const cleaned = String(text ?? '').replace(BIE_HOMOGRAPHS, '')
  return (cleaned.match(/不要|不许|不准|禁止|不能|别/g) ?? []).length
}

/**
 * 检查一份人设文本。
 *
 * 只报**可判定**的事；不给"质量分"。
 *
 * @param {string} text 人设正文
 * @returns {{ok: boolean, bytes: number, budgetBytes: number, ratio: number, truncated: boolean,
 *            blocks: Array<{id: string, title: string, required: boolean, present: boolean, bytes: number, via: string}>,
 *            missing: string[], findings: Array<{level: string, code: string, message: string}>}}
 */
export function analyzePersona(text) {
  const body = String(text ?? '')
  const bytes = Buffer.byteLength(body, 'utf8')
  const rawBlocks = splitByBlock(body)
  const findings = []

  // 文档里的真实出现顺序 —— "语气排在身份前面"这件事只能按它判，不能按定义表里的顺序判
  // （按定义判等于永远判不出来，第一版就踩过：反例样本照样全绿）。
  const docOrder = rawBlocks.map((block) => blockIdOfTitle(block.title)).filter((id) => id !== '')

  const blocks = PERSONA_BLOCKS.map((block) => {
    const hit = rawBlocks.find((raw) => blockIdOfTitle(raw.title) === block.id)
    const blockBytes = hit ? Buffer.byteLength(hit.text, 'utf8') : 0
    // 对照表经常贴在"怎么说"下面、不起自己的标题 —— 这一块靠标题就够，不必再用正文证据。
    return {
      id: block.id, title: block.title, required: block.required === true,
      present: Boolean(hit), bytes: blockBytes,
      via: hit ? 'heading' : '',
    }
  })

  const missing = blocks.filter((b) => b.required && !b.present).map((b) => b.id)
  for (const id of missing) {
    const def = PERSONA_BLOCKS.find((b) => b.id === id)
    findings.push({ level: 'error', code: `missing:${id}`, message: `缺必填块「${def.title}」——${def.ask}` })
  }

  const truncated = bytes > PERSONA_BUDGET_BYTES
  if (truncated) {
    findings.push({
      level: 'error', code: 'over-budget',
      message: `超过宿主预算 ${Math.round(PERSONA_BUDGET_BYTES / 1024)} KiB（当前 ${bytes} 字节）——超出部分会被截断，她看不到。`,
    })
  } else if (bytes > PERSONA_BUDGET_BYTES * 0.75) {
    findings.push({
      level: 'warn', code: 'near-budget',
      message: `已用掉预算的 ${Math.round(bytes / PERSONA_BUDGET_BYTES * 100)}%（${bytes}/${PERSONA_BUDGET_BYTES} 字节），再写就要溢出了。`,
    })
  }

  // 占位符只认模板自己的标记 `（这里写：`——不猜"像不像占位符"，否则会误伤正文里的括号说明。
  const placeholderCount = (body.match(/（这里写[：:]/g) ?? []).length
  if (placeholderCount > 0) {
    findings.push({ level: 'warn', code: 'placeholder-left', message: `还有 ${placeholderCount} 处「（这里写：…）」没填——她会把括号里的字当真话读。` })
  }
  if (body.trim() === '') {
    findings.push({ level: 'error', code: 'empty', message: '人设是空的——她只会以助手的样子说话。' })
  }

  // 顺序：身份必须在最前。截断按字节从头砍，身份排后面等于没有。
  const whoAt = docOrder.indexOf('who')
  if (whoAt > 0) {
    findings.push({
      level: 'warn', code: 'order',
      message: '有别的块排在「她是谁」前面。截断是按字节从头砍的，语气/表现排前面会把身份挤出去。',
    })
  }

  // 红线：不超过 5 条（经验值：规则一多，模型只会记住其中三条）。
  const rulesBlock = rawBlocks.find((raw) => blockIdOfTitle(raw.title) === 'rules')
  if (rulesBlock) {
    const bullets = rulesBlock.text.split('\n').filter((line) => /^\s*[-*]\s+/.test(line)).length
    if (bullets > 5) {
      findings.push({
        level: 'warn', code: 'too-many-rules',
        message: `红线里有 ${bullets} 条。经验上限是 5 条 —— 条数一多，她只会记住其中三条，其余等于没写。`,
      })
    }
  }

  // 负面清单：红线之外的块里"不要/别/不许"太多，就是白熊效应那一类失效写法。
  for (const raw of rawBlocks) {
    const id = blockIdOfTitle(raw.title)
    if (id === '' || id === 'rules') continue
    const negatives = countNegative(raw.text)
    if (negatives >= 5) {
      findings.push({
        level: 'warn', code: 'negative-heavy',
        message: `「${raw.title}」里有 ${negatives} 处"不要/别/不许"。负面清单的效力弱于正面描述（经验比例约 3:1），建议改成说她**怎么做**，或者换成一句示范。`,
      })
    }
  }

  if (docOrder.length === 0) findings.push({ level: 'warn', code: 'no-blocks', message: '一个标准块都没认出来——建议先套一遍骨架。' })

  return {
    ok: findings.every((f) => f.level !== 'error'),
    bytes, budgetBytes: PERSONA_BUDGET_BYTES,
    ratio: Number((bytes / PERSONA_BUDGET_BYTES).toFixed(4)),
    truncated, blocks, missing, findings,
  }
}
