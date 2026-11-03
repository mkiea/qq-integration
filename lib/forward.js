/**
 * Merged-forward ("chat record" / 合并转发) payload normalization.
 *
 * A QQ merged-forward card arrives as an OneBot v11 segment `{ type: 'forward', data: { id } }`;
 * the content itself only comes back from the `get_forward_msg` action. Different
 * implementations answer with different shapes (NapCat / OneBot v11 `{ messages: [...] }`,
 * Go-CQHTTP `{ message: [...] }`, a bare array, or a dry-run stub), so this module owns the
 * tolerant normalization plus the model-facing plain-text rendering.
 *
 * Pure functions only: no IO, no network, no timers.
 */

/** 截断时追加的提示语。 */
const TRUNCATED_MARK = '…（内容过长已截断）'

/** 段类型 → 占位文本（内容取不到时用）。 */const SEGMENT_LABELS = {
  image: '[图片]',
  mface: '[图片]',
  record: '[语音]',
  video: '[视频]',
  face: '[表情]',
  forward: '[转发记录]',
}

/**
 * 内嵌转发的**文字**渲染（2026-11-02 深夜）。
 *
 * 原来 `forward` 一律渲染成 `[转发记录]`，内层内容直接消失 —— 于是"转发里套转发"时，
 * 即使后端已经成功展开（实测 `getMultiMsg(peer, 外层, 内层)` 能拿到 10 条），
 * 到了模型眼里也只剩四个字。展开成功但看不见，等于没展开。
 *
 * 三条硬限制（纯函数，不许在这里做 IO 或无限递归）：
 *   · 只展开**一层内嵌**（外层记录 → 里面那张转发卡的内容）。再深就只写 `[转发记录]`：
 *     真实聊天记录套三层以上没有信息价值，而无限递归会把栈吃光（本模块是纯函数，崩了没人兜底）。
 *   · 每条最多 8 个节点、整块最多 600 字：内嵌内容是**被转述的数据**，不该挤掉正文。
 *   · 取不到 `content` 时老实写 `[转发记录]`，不编。
 */
function nestedForwardText(data, depth) {
  const nodes = Array.isArray(data?.content) ? data.content : null
  if (nodes === null || nodes.length === 0) return SEGMENT_LABELS.forward
  if (depth >= 1) return SEGMENT_LABELS.forward
  const parts = []
  for (const node of nodes.slice(0, 8)) {
    const d = (node && typeof node === 'object' && node.data && typeof node.data === 'object') ? node.data : node
    if (!d || typeof d !== 'object') continue
    const name = String(d.name ?? d.nickname ?? '').trim()
    const body = segmentsToTextAt(d.content !== undefined ? d.content : d.message, depth + 1)
    if (body === '') continue
    parts.push(name === '' ? body : `${name}：${body}`)
  }
  if (parts.length === 0) return SEGMENT_LABELS.forward
  const joined = parts.join(' / ')
  const clipped = joined.length > 600 ? `${joined.slice(0, 600)}…` : joined
  const more = nodes.length > 8 ? ` 等 ${nodes.length} 条` : ''
  return `[内嵌聊天记录${more}：${clipped}]`
}

/**
 * 转发节点里的**卡片/小程序**渲染（2026-11-02 深夜）。
 *
 * 原来 `segmentText` 没有 json/xml/lightapp 分支 ⇒ 命中 `default: ''` ⇒ 转发记录里
 * **整张卡片凭空消失**（不是显示成"[卡片]"，是一个字都没有）。用户看到的就是
 * "转发里有张带链接的卡，她却当没这回事"。
 *
 * 这里只做**排版层**的轻量解析（本模块是纯函数，不引 onebot.js 的完整解析器，
 * 免得形成环）。取四样：prompt / title / desc / url，一样都取不到才写 `[卡片]`。
 * 链接带上：转发里最常被追问的就是"这链接是啥"。
 */
function cardSegmentText(data) {
  const holder = (data && typeof data === 'object') ? data : {}
  const raw = typeof holder.data === 'string' ? holder.data : (typeof data === 'string' ? data : '')
  if (raw.trim() === '') return '[卡片]'
  let payload = null
  try { payload = JSON.parse(raw) } catch { return '[卡片]' }
  if (payload === null || typeof payload !== 'object') return '[卡片]'

  const str = (v) => (typeof v === 'string' ? v.trim() : '')
  const prompt = str(payload.prompt)
  const meta = (payload.meta && typeof payload.meta === 'object') ? payload.meta : {}
  const first = Object.values(meta).find((v) => v && typeof v === 'object') ?? {}
  const title = str(first.title) || str(payload.title)
  const desc = str(first.desc) || str(payload.desc)
  let url = str(first.qqdocurl) || str(first.jumpUrl) || str(first.url)
  if (url === '') {
    // 字段名各家不同，兜底扫一层（最多 5 层，防病态 payload）
    const found = []
    const walk = (value, depth) => {
      if (found.length > 0 || depth > 5 || value === null || typeof value !== 'object') return
      for (const item of Object.values(value)) {
        if (typeof item === 'string') {
          if (/^https?:\/\//.test(item) && !/\.(png|jpe?g|gif|webp|bmp|svg|ico|mp4|m4a|mp3|css|js)$/i.test(item.split('?')[0])) {
            found.push(item)
            return
          }
        } else walk(item, depth + 1)
      }
    }
    walk(meta, 0)
    url = found[0] ?? ''
  }

  let line = prompt !== '' ? prompt : (title !== '' ? `[卡片]${title}` : '[卡片]')
  if (title !== '' && !line.includes(title)) line += `（${title}）`
  if (desc !== '' && desc !== title && !line.includes(desc)) line += `（${desc}）`
  if (url !== '') line += ` <${url.length > 200 ? `${url.slice(0, 200)}…` : url}>`
  return line
}

/**
 * 单个段（segment）转纯文本。未知类型返回空串而不是抛错：
 * 真实载荷里混着 reply/json/xml/poke 等段是常态，一个看不懂的段不该毁掉整条记录。
 */
function segmentText(seg, depth = 0) {
  if (seg === null || seg === undefined) return ''
  if (typeof seg === 'string') return seg
  if (typeof seg !== 'object') return String(seg)
  const type = typeof seg.type === 'string' ? seg.type : ''
  const data = (seg.data && typeof seg.data === 'object') ? seg.data : {}
  switch (type) {
    case 'text':
      return String(data.text ?? '')
    case 'at': {
      // at 段优先用显示名（NapCat 会给 name），拿不到就退化成 QQ 号
      const name = data.name ?? data.nickname ?? data.card
      const qq = data.qq ?? data.user_id ?? data.target
      const label = (name === undefined || name === null || name === '') ? qq : name
      return `@${label === undefined || label === null || label === '' ? '' : String(label)}`
    }
    case 'file': {
      const name = data.name ?? data.file ?? data.file_name
      return (name === undefined || name === null || name === '') ? '[文件]' : `[文件 ${String(name)}]`
    }
    case 'forward':
      return nestedForwardText(data, depth)
    case 'json':
    case 'lightapp':
    case 'xml':
      return cardSegmentText(seg.data)
    default:
      return SEGMENT_LABELS[type] ?? ''
  }
}

/** 段数组（或直接的字符串）转一段展示文本：段间单空格，连续空白压缩成一个。 */
function segmentsToText(content) {
  return segmentsToTextAt(content, 0)
}

/** 带层数的版本：只在渲染内嵌转发时用到。 */
function segmentsToTextAt(content, depth) {
  if (typeof content === 'string') return collapse(content)
  if (!Array.isArray(content)) return ''
  return collapse(content.map((seg) => segmentText(seg, depth)).filter((part) => part !== '').join(' '))
}

/** 多个连续空白（含全角空格）压成单个半角空格并 trim。 */
function collapse(value) {
  return String(value ?? '').replace(/[\s\u3000]+/g, ' ').trim()
}

/** 可选的数值参数：非有限数或 < 1 时回落到默认值。 */
function positiveNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 1 ? n : fallback
}

/** 可选的字符串参数：空串/非字符串时回落到默认值。 */
function nonEmptyString(value, fallback) {
  return (typeof value === 'string' && value.trim() !== '') ? value : fallback
}

/** 归一化单个节点：兼容 v11 node 形状、Go-CQHTTP 形状、以及本仓库自己发出的卡片形状。 */
function normalizeNode(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'string') {
    const text = collapse(raw)
    if (text === '') return null
    return { name: '未知用户', userId: 0, time: 0, text }
  }
  if (typeof raw !== 'object') return null

  const data = (raw.data && typeof raw.data === 'object') ? raw.data : raw
  const sender = (raw.sender && typeof raw.sender === 'object')
    ? raw.sender
    : ((data.sender && typeof data.sender === 'object') ? data.sender : {})

  // content 与 message 谁在就用谁（v11 用 content，Go-CQHTTP 用 message）
  const content = data.content !== undefined ? data.content
    : (data.message !== undefined ? data.message
      : (raw.content !== undefined ? raw.content : raw.message))

  const nameRaw = data.name ?? data.nickname ?? sender.nickname ?? sender.card ?? sender.name
  const qqRaw = data.uin ?? data.user_id ?? sender.user_id ?? sender.uin
  const timeRaw = data.time ?? sender.time ?? raw.time
  const timeNum = Number(timeRaw)

  const text = segmentsToText(content)
  // v0.7.18（主人截图暴露：转发里的图她只看到「图片」俩字）：把 image/mface 段里
  // **带 http(s) 链接**的图片收集出来，桥层负责下载附图。本模块保持纯函数，不做 IO。
  // 文本里的 [图片] 占位保留（排版不动），附图成功与否由桥层在正文里明说。
  const images = []
  if (Array.isArray(content)) {
    for (const seg of content) {
      if (seg === null || typeof seg !== 'object') continue
      const type = typeof seg.type === 'string' ? seg.type : ''
      if (type !== 'image' && type !== 'mface') continue
      const url = String(seg.data?.url ?? '').trim()
      const origin = String(seg.data?.origin_url ?? seg.data?.originUrl ?? '').trim()
      if (!/^https?:\/\//.test(url) && !/^https?:\/\//.test(origin)) continue
      // origin 是**原始 CDN 地址**（2026-11-03）：代理 404 时桥拿它兜底。
      images.push({ kind: type, url, origin: /^https?:\/\//.test(origin) ? origin : '' })
    }
  }
  // 文本为空但字段结构可辨识时仍保留节点（空内容会在排版阶段被跳过），
  // 完全看不出是节点的对象才算坏项。
  const recognizable = content !== undefined || data.name !== undefined || data.nickname !== undefined
    || data.uin !== undefined || data.user_id !== undefined || sender.user_id !== undefined
  if (!recognizable && text === '' && images.length === 0) return null

  const name = (nameRaw === undefined || nameRaw === null || String(nameRaw).trim() === '')
    ? '未知用户'
    : collapse(nameRaw)
  const userId = Number.isFinite(Number(qqRaw)) ? Number(qqRaw) : 0

  return { name, userId, time: Number.isFinite(timeNum) ? timeNum : 0, text, images }
}

/** 从任意载荷里挖出节点数组；挖不到返回 null。 */
function nodesArray(data) {
  if (Array.isArray(data)) return data
  if (data === null || typeof data !== 'object') return null
  if (data.dryRun === true) return null
  if (Array.isArray(data.messages)) return data.messages
  if (Array.isArray(data.message)) return data.message
  return null
}

/**
 * 规范化 `get_forward_msg` 的返回载荷。
 * 容错 `{ messages: [...] }` / `{ message: [...] }` / 裸数组 / dry-run 空响应；
 * 坏项计数进 `dropped` 并跳过，绝不抛错。
 * @returns {{ nodes: Array<{ name: string, userId: number, time: number, text: string }>, dropped: number, reason: string }}
 */
export function normalizeForwardNodes(data) {
  const raw = nodesArray(data)
  if (raw === null) return { nodes: [], dropped: 0, reason: '载荷为空或不是转发内容' }

  const nodes = []
  let dropped = 0
  for (const item of raw) {
    const node = normalizeNode(item)
    if (node === null) dropped++
    else nodes.push(node)
  }
  // 数组存在但一条都没解析出来：也给出中文原因，方便上层日志与诊断页直接展示
  const reason = (nodes.length === 0 && dropped > 0) ? '转发内容无法解析' : ''
  return { nodes, dropped, reason }
}

/**
 * 判断载荷是否像一次真正的转发响应。
 * dry-run 响应（{dryRun:true}）、null、字符串、空对象、空数组都算「不是」。
 */
export function isForwardPayload(data) {
  const raw = nodesArray(data)
  return Array.isArray(raw) && raw.length > 0
}

/**
 * 把规范化后的节点排版成给模型看的纯文本。
 * @param {Array} nodes normalizeForwardNodes 的结果
 * @param {{ maxNodes?: number, maxChars?: number, title?: string }} [options]
 * @returns {{ text: string, used: number, total: number, truncated: boolean, chars: number }}
 */
export function formatForwardTranscript(nodes, options) {
  const opts = (options && typeof options === 'object') ? options : {}
  const maxNodes = positiveNumber(opts.maxNodes, 50)
  const maxChars = positiveNumber(opts.maxChars, 4000)
  const title = nonEmptyString(opts.title, '转发聊天记录')

  const list = Array.isArray(nodes) ? nodes : []
  const total = list.length

  // 内容为空的节点不占行（total 仍按传入节点数算）
  const rows = []
  for (const node of list) {
    if (node === null || typeof node !== 'object') continue
    const text = collapse(node.text)
    if (text === '') continue
    const name = (node.name === undefined || node.name === null || String(node.name).trim() === '')
      ? '未知用户'
      : collapse(node.name)
    rows.push(`${name}: ${text}`)
  }

  const nodeTruncated = rows.length > maxNodes
  const shown = nodeTruncated ? rows.slice(0, maxNodes) : rows

  const header = nodeTruncated ? `[${title} 共 ${total} 条，显示前 ${shown.length} 条]` : `[${title} 共 ${total} 条]`
  let body = shown.join('\n')

  let charTruncated = false
  if (body.length > maxChars) {
    body = body.slice(0, maxChars)
    charTruncated = true
  }

  let text = body === '' ? header : `${header}\n${body}`
  if (charTruncated) text += TRUNCATED_MARK

  return {
    text,
    used: shown.length,
    total,
    truncated: nodeTruncated || charTruncated,
    chars: text.length,
  }
}
