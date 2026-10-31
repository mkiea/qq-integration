/**
 * redpacket.js —— 认出 QQ 红包消息（2026-10-30）
 *
 * 【先说清楚：能做什么、不能做什么】
 *
 * 能：认出「这条消息里有个红包」，分辨类型（普通 / 口令 / 专属）、带出标题；落 trace、记一次
 *     运营计数、（可选）提醒管理员。**这一段全是本地判断，跑得通、测得动。**
 *
 * 不能：替她点开。不是偷懒，是链路上没有这个口子 ——
 *   ① OneBot v11 协议里没有开红包的 action；
 *   ② 注入层（Waylay，`_tmp/rin-inject/waylay-src/onebot/actions.js`）的 60 个 action 里没有；
 *   ③ 真正能开红包的是 NTQQ 内核：
 *      `KernelMsgService::grabRedBag(const GrabRedBagReq&, shared_ptr<IGrabRedBagCallback>)`
 *      —— 这个符号我在本机 `wrapper.node`（version 9.9.36-53644，117 MB）里查到了，
 *      JS 侧只吃 1 个参数，但 `GrabRedBagReq` 的**字段名**二进制里没有，猜不出来。
 * ⇒ 所以这里只做「看得见」，绝不假装「抢得到」：**宁可少一个功能，也不要一个静默失败的功能**。
 *    真要做，下一步是在注入层加一个 handler，然后拿一个真红包调一次、按报错反推字段名。
 */

/**
 * 卡片里能证明"这是红包"的标记（app / view / 原始 JSON 一起按子串匹配，不区分大小写）。
 * 词表是**独立封闭**的（不从我们自己拼出来的文案反推），改词表就等于改判定，必须同步跑测试。
 */
const CARD_MARKS = ['redpacket', 'redbag', 'red_bag', 'qredpacket']

/**
 * 文本侧的**强标记**：必须带方括号才算。
 * 裸的"红包"两个字不算 —— 「我发了个红包」「红包我不抢」这类普通聊天不是红包消息，
 * 靠包含关系判会把整段对话判成红包，噪音比漏判更难查（判错一次就再也分不清真假）。
 */
const TEXT_PREFIXES = ['[QQ红包]', '[口令红包]', '[专属红包]', '[红包]']

/** 类型判定：更具体的先认（口令 > 专属 > 普通）。 */
const KIND_RULES = [
  ['口令红包', '口令'],
  ['专属红包', '专属'],
]

/**
 * 为什么不能自动抢 —— 写成常量，避免各处文案各说一套。
 */
export const GRAB_UNAVAILABLE_REASON = '注入层没有开红包的接口（Waylay 的 action 表里没有 grab / pick 相关项），OneBot v11 也没有这个协议'

/**
 * 判断一条消息里是不是红包。
 *
 * @param {{card?: object|null, text?: string, raw?: string}} input
 *   card = `extractCard()` 的结果（可能为 null）；text = 解析出的文本；
 *   raw = 原始段/JSON 字符串（卡片归一化会丢字段，红包标记可能只藏在 meta 里）。
 * @returns {{isRedPacket: boolean, kind: string, title: string, hit: ''|'card'|'text'}}
 */
export function detectRedPacket(input = {}) {
  // 默认参数只兜 `undefined`，兜不住 `null`（调用方从 `message.raw` 里取值，null 很常见）
  const src = input ?? {}
  const card = src.card ?? null
  const text = String(src.text ?? '')
  const blob = `${String(src.raw ?? '')} ${card === null ? '' : JSON.stringify(card)}`.toLowerCase()
  const cardHit = CARD_MARKS.some((mark) => blob.includes(mark))
  const textHit = TEXT_PREFIXES.find((prefix) => text.includes(prefix)) ?? ''
  if (!cardHit && textHit === '') return { isRedPacket: false, kind: '', title: '', hit: '' }
  const haystack = `${blob} ${text}`
  const kind = KIND_RULES.find(([, needle]) => haystack.includes(needle))?.[0] ?? '红包'
  const title = [card?.title, card?.prompt]
    .map((value) => String(value ?? '').trim())
    .find((value) => value !== '') ?? ''
  return { isRedPacket: true, kind, title, hit: cardHit ? 'card' : 'text' }
}

/** 一行话（trace / 提醒用）。只写"发现"，**绝不写"已领取"**。 */
export function describeRedPacket(info) {
  if (info === null || info === undefined || info.isRedPacket !== true) return ''
  const kind = info.kind === '' ? '红包' : info.kind
  return info.title === '' ? kind : `${kind}「${info.title}」`
}
