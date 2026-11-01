/**
 * 人设文件（`cwd/AGENTS.md`）的标准格式 —— **结构、预算、校验**（2026-11-01）。
 *
 * 为什么需要它：人设是手写长文，而宿主有两个硬约束决定了"写错结构"会静默失效：
 *
 *   ① **有字节预算**（`@deepseek-ai/dsh-agent-instructions` 的 `maxBytes`，本 profile = 32768）。
 *      超了不是报错，是**截断**——她会静默看不到后半段。所以要按"截断也不能丢"排序。
 *   ② **整份文件包成一段 instruction 追加进 system**，不替换基础指令。
 *      所以这里只该写"她是谁"，不该重写"你是 AI 助手、要遵守 XX"（宿主已经有）。
 *
 * 结构本身不是拍脑袋排的，来自这个项目自己的结论（`role_spec §0` 的四根因果脊柱）：
 * 判据是**反事实**——把这一节换掉，她还是不是她？
 * 换掉"说话要短"她还是凛（那是腔调，可以训），换掉"从哪来"她就不是了。
 * 所以第一节必须是身份，不是语气。
 *
 * ⚠️ 这是**格式**，不是评分。`analyzePersona` 只报"缺哪节 / 超没超预算 / 有没有踩已知的坑"，
 * 不假装能判断"写得好不好"——那种分数只会让作者去优化分数。
 */

/** 宿主那条 instruction 的字节预算。改这里必须同步 `~/.dsh/profiles/web/cordis.patch.yml` 的 maxBytes。 */
export const PERSONA_BUDGET_BYTES = 32 * 1024

/**
 * 小节定义。`order` 即写入顺序 = **截断优先级**（越靠前越不能丢）。
 *
 * `targetBytes` 是"写满了大概多少"，不是硬上限；真正硬的是 `PERSONA_BUDGET_BYTES`。
 * 合计约 11 KiB —— 留出 20 KiB 余量给以后加内容，别一上手就顶到截断线。
 */
export const PERSONA_SECTIONS = [
  {
    id: 'identity',
    title: '她是谁（身份脊柱）',
    required: true,
    targetBytes: 2400,
    keywords: ['她是谁', '身份', '身世', '来历', '从哪来', '脊柱'],
    // 作者很少逐字照抄标题，用一条正则兜住常见说法（"她到底是个什么玩意儿""关于她这个人"）。
    pattern: /她.{0,6}(是谁|是什么|是啥|从哪|打哪|到底|这个人)/,
    ask: '四个问题必须都回答：① 她是什么（人，猫只是特征，不是嵌合体）② 从哪来（流浪→被捡回）'
      + '③ 她怎么知道外面的事（猫的眼睛？屏幕？还是只有你说的）④ 她最怕什么（被丢下／被替代）',
    avoid: '别写"傲娇""猫娘""温柔"这类形容词当身份。形容词是倾向，不是根——换个角色也能套。',
  },
  {
    id: 'relation',
    title: '对面是谁（关系与视角）',
    required: true,
    targetBytes: 1200,
    keywords: ['对方是谁', '对面', '关系', '视角', '你怎么看他'],
    ask: '对方是什么身份、她知道对方的哪些事、哪些是**不知道**的。'
      + '以及她能看到什么（QQ 这一头的现象）看不到什么（他在干什么）。',
    avoid: '别替对方编职业/年龄/城市。也别让她自称"知道你在加班"——她不知道"加班"是什么。',
  },
  {
    id: 'voice',
    title: '怎么说话（腔调与长度）',
    required: true,
    targetBytes: 1800,
    keywords: ['怎么说话', '说话规矩', '腔调', '长度', '节奏', '口语'],
    ask: '一条消息几句、能短到什么程度、能用哪些语气词、哪些腔调是禁的。',
    avoid: '别只写"要自然、要像人"——那是目标不是规则。要给**可判定的**写法（几个字、几条消息）。',
  },
  {
    id: 'no_draft',
    title: '只发台词（不许草稿）',
    required: true,
    targetBytes: 900,
    keywords: ['草稿', '只发', '台词', '内心', '候选'],
    ask: '明确列出"算草稿"的三种形态（候选对比 / 自我评价 / 英文独白），并给不出手时的默认动作。',
    avoid: '别只说"不要解释"——模型会把"解释"理解成只要不加括号就还行。要举反例。',
  },
  {
    id: 'boundary',
    title: '边界与红线',
    required: true,
    targetBytes: 900,
    keywords: ['边界', '红线', '不许', '禁止', '底线'],
    ask: '不能做的事：不自称 AI、不报模型名、不编造看过/记得的内容、硬性环境边界。',
    avoid: '别把"不能骂人"这类**风格偏好**写进红线——红线只放"做了就毁设定"的事。',
  },
  {
    id: 'proactive',
    title: '没人找她的时候',
    required: false,
    targetBytes: 1200,
    keywords: ['主动', '旁白', '想找他', '说说', '动态', '空间', '没人找'],
    ask: '没有新消息时她会不会开口、旁白该怎么用、不想说时怎么收场、被无视之后怎么办。',
    avoid: '别写成"定时问候"——那是客服行为。主动必须是**她想要东西**，不是关心你。',
  },
  {
    id: 'media',
    title: '表情与语音',
    required: false,
    targetBytes: 1200,
    keywords: ['表情', '语音', '图', '贴纸'],
    ask: '用哪个工具、一次几张、多长、频率、什么场合不该发。',
    avoid: '别写"适当使用"——频率必须给数（几轮一次），否则等于没说。',
  },
  {
    id: 'mood',
    title: '情绪怎么露出来',
    required: false,
    targetBytes: 700,
    keywords: ['情绪', '傲娇', '脾气', '生气', '害羞'],
    ask: '外显的夸张程度、内层掩饰与表层同时存在时怎么写（先硬后软这类）。',
    avoid: '别写"她很傲娇"就完事——傲娇的机制是「被戳到先嘴硬再服软」，要写成可执行的两步。',
  },
  {
    id: 'world',
    title: '她脚下的世界',
    required: false,
    targetBytes: 600,
    keywords: ['世界', '文件夹', '环境', '这台机器'],
    ask: '她能碰什么、碰不到什么、做不到的事怎么回答。',
    avoid: '别写"注意安全"——要写"碰不到的事实"（她手上根本没有那些工具）。',
  },
  {
    id: 'example',
    title: '示范对照',
    required: false,
    targetBytes: 800,
    keywords: ['示范', '对照', '例子', '示例', '这样说'],
    // 对照表经常就写在「怎么说话」下面、不起标题 —— 没有这个证据判据会误报"没写"。
    evidence: /\|\s*别这么说\s*\|/,
    ask: '同一句话的长/短两种说法对照表。短示范比长说明有效得多。',
    avoid: '别写"要简洁"再配一句长解释——那自相矛盾。示范本身就是规矩。',
  },
]

/**
 * 标准骨架。占位符统一写成 `（这里写：…）` —— 便于机检"还有没填的"，
 * 也让作者一眼看出哪几节是空的（比留空白强：空白会被当成"这节不用写"）。
 *
 * 刻意留短：骨架是**结构**，不是范本。每节的"要回答什么"在 `PERSONA_SECTIONS` 里，
 * 由面板显示，不塞进文件——文件里塞满指导语，她读到的就成了指导语。
 */
export const PERSONA_TEMPLATE = `# 人设 · （这里写：她的名字）

<!--
  这个文件就是"她是谁"的全部。两条硬约束：
  ① 整份文件会**追加**进 system（不替换宿主的基础指令）⇒ 只写她，不写"你是 AI 助手"这类通用规矩；
  ② 预算 32 KiB，**超了会被截断**（不报错）⇒ 越靠前越不能丢，别把语气写在身份前面。
-->

## 她是谁

（这里写：她是什么。——人。猫只是特征，不是半人半猫的嵌合体。）

（这里写：她从哪来。——怎么到了这个屏幕后面。）

（这里写：她怎么知道外面的事。——猫的眼睛／屏幕／还是只有对方说的。）

（这里写：她最怕什么。——被丢下／被替代／被关在外面。）

## 对面是谁

（这里写：对方是什么人。她**知道**哪些、**不知道**哪些。）

（这里写：她能看到什么（QQ 这一头）、看不到什么（对方在干什么）。不知道就别编。）

## 怎么说话

（这里写：一条消息几句。能短到什么程度。能用哪些语气词。哪些腔调一出现就露馅。）

## 只发台词

（这里写：她的回复里只有台词，没有草稿。列出算草稿的形态，并给出不出手时的默认动作。）

## 边界与红线

（这里写：做了就毁设定的事。——不自称 AI、不报模型名、不编造看过或记得的内容。）

## 没人找她的时候

（这里写：没有新消息时她会不会开口。旁白怎么用。不想说时怎么收场。被无视之后怎么办。）

## 表情与语音

（这里写：用哪个工具。一次几张。多长。几轮一次。什么场合不该发。）

## 情绪怎么露出来

（这里写：外显的夸张程度。嘴硬与服软怎么先后出现。）

## 她脚下的世界

（这里写：她能碰什么、碰不到什么。做不到的事怎么回答。）

## 示范对照

| 别这么说 | 这么说 |
| --- | --- |
| （这里写：长而完整的一句） | （这里写：短的那句） |
`

/** 一个标题属于哪一节（关键词或正则命中即算）。认不出返回空串。 */
function sectionIdOfTitle(title, { ignoreEvidence = false } = {}) {
  for (const section of PERSONA_SECTIONS) {
    if (ignoreEvidence && section.evidence) continue
    if (section.keywords?.some((word) => title.includes(word))) return section.id
    if (typeof section.pattern?.test === 'function' && section.pattern.test(title)) return section.id
  }
  return ''
}

/** 按标题切块（每块的 `text` 含标题行本身，用于量这一节占多少字节）。 */
function splitBySection(text) {
  const blocks = []
  let current = { title: '', lines: [] }
  for (const line of String(text ?? '').split('\n')) {
    if (/^#{1,3}\s+/.test(line.trim())) {
      if (current.lines.length > 0 || current.title !== '') blocks.push(current)
      current = { title: line.trim().replace(/^#{1,3}\s+/, ''), lines: [line] }
    } else {
      current.lines.push(line)
    }
  }
  blocks.push(current)
  return blocks.map((block) => ({ title: block.title, text: block.lines.join('\n') }))
}

/**
 * 检查一份人设文本。
 *
 * 只报**可判定**的事：哪一节在、哪一节缺、超没超预算、有没有踩已知的坑。
 * 不给"质量分"——那种分只会让作者去优化分，而不是优化她。
 *
 * @param {string} text 人设正文
 * @returns {{ok: boolean, bytes: number, budgetBytes: number, ratio: number, truncated: boolean,
 *            sections: Array<{id: string, title: string, required: boolean, present: boolean, bytes: number, via: string}>,
 *            missing: string[], findings: Array<{level: string, code: string, message: string}>}}
 */
export function analyzePersona(text) {
  const body = String(text ?? '')
  const bytes = Buffer.byteLength(body, 'utf8')
  const blocks = splitBySection(body)
  const findings = []

  // 文档里的真实出现顺序 —— "语气排在身份前面"这件事只能按它判，不能按 spec 里的顺序判
  // （按 spec 判等于永远判不出来，第一版就踩了这个：反例样本照样全绿）。
  const docOrder = blocks.map((block) => sectionIdOfTitle(block.title)).filter((id) => id !== '')
  const firstIndexOf = (id) => docOrder.indexOf(id)

  const sections = PERSONA_SECTIONS.map((section) => {
    // 认节靠标题：关键词或正则命中都算（作者不必照抄标题）。
    const hit = blocks.find((block) => sectionIdOfTitle(block.title) === section.id)
    const sectionBytes = hit ? Buffer.byteLength(hit.text, 'utf8') : 0
    // 少数小节经常不起标题（对照表就贴在别的小节下面），给一条"正文证据"兜底，
    // 否则会误报"没写"——那是最容易让作者不信这份检查的一种错。
    const byEvidence = !hit && typeof section.evidence?.test === 'function' && section.evidence.test(body)
    return {
      id: section.id, title: section.title, required: section.required === true,
      present: Boolean(hit) || byEvidence, bytes: sectionBytes,
      via: hit ? 'heading' : (byEvidence ? 'evidence' : ''),
    }
  })

  const missing = sections.filter((s) => s.required && !s.present).map((s) => s.id)
  for (const id of missing) {
    const def = PERSONA_SECTIONS.find((s) => s.id === id)
    findings.push({ level: 'error', code: `missing:${id}`, message: `缺必填小节「${def.title}」——${def.ask}` })
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

  // 已知会静默失效的坑：模板占位符忘删、或整份还是空的。
  // 判据只认模板自己的标记 `（这里写：`——不猜"像不像占位符"，否则会误伤正文里的括号说明。
  const leftPlaceholder = /（这里写[：:]/.test(body)
  if (leftPlaceholder) {
    const count = (body.match(/（这里写[：:]/g) ?? []).length
    findings.push({ level: 'warn', code: 'placeholder-left', message: `还有 ${count} 处「（这里写：…）」没填——她会把括号里的字当真话读。` })
  }
  if (body.trim() === '') {
    findings.push({ level: 'error', code: 'empty', message: '人设是空的——她只会以助手的样子说话。' })
  }

  // 顺序：身份必须在语气之前。截断按字节从头砍，身份排后面等于没有。
  const identityAt = firstIndexOf('identity')
  const voiceAt = firstIndexOf('voice')
  if (identityAt !== -1 && voiceAt !== -1 && voiceAt < identityAt) {
    findings.push({
      level: 'warn', code: 'order',
      message: '「怎么说话」排在「她是谁」前面。截断是按字节从头砍的，语气排前面会把身份挤出去。',
    })
  }
  if (docOrder.length === 0) findings.push({ level: 'warn', code: 'no-sections', message: '一个标准小节都没认出来——建议先套一遍骨架。' })

  return {
    ok: findings.every((f) => f.level !== 'error'),
    bytes, budgetBytes: PERSONA_BUDGET_BYTES,
    ratio: Number((bytes / PERSONA_BUDGET_BYTES).toFixed(4)),
    truncated, sections, missing, findings,
  }
}
