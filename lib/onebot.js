/**
 * OneBot v11 transport: reverse-WebSocket server.
 *
 * The plugin listens on 127.0.0.1:<port>; a OneBot implementation
 * (LLOneBot / OpenShamrock / NapCat / Lagrange / go-cqhttp) connects TO us
 * using its `ws-reverse://` configuration. Every accepted connection is one
 * bot instance.
 */
import { EventEmitter } from 'node:events'
import { WebSocketServer } from 'ws'

const ACTION_TIMEOUT_MS = 10_000

/**
 * 哪些 action 算"往聊天里写东西"，需要走出站间隔（`sendIntervalMs`）。
 *
 * 白名单而不是黑名单：OneBot 的 action 有一百多个，将来还会加。
 * 黑名单漏掉一个新的发送方法 = 它静默不受限；白名单漏掉一个 = 它只是没被限速，
 * 而且下次有人补测试就会发现。**未知默认当查询**是更安全的错法。
 */
const OUTBOUND_MESSAGE_ACTIONS = new Set([
  'send_msg',
  'send_group_msg',
  'send_private_msg',
  'send_group_forward_msg',
  'send_private_forward_msg',
])

/**
 * 文本 @ 匹配（v0.5.9 真机抓到）。
 *
 * 背景：`replyOnlyWhenMentioned` 原本只看 `at` 段。但**有些 QQ 客户端把 @机器人 发成纯文本**
 * ——正文里就是字面 `@昵称`，一个 `at` 段都没有（真机实测：同一群里别人发的 @ 是真 at 段、
 * 能被识别；用户自己发的那条 `ats=[]`、正文是 `@机器人昵称 /打卡名册`）。结果就是
 * 用户明明 @ 了机器人，桥却当成"没 @"**静默丢掉**，群里一个字都不回。
 *
 * 这里按名字做字面量匹配（不用正则：昵称里可能有 `.` `+` `(` 等元字符）。
 * 命中返回那个名字（便于写进 trace 说清是哪条规则放行的），否则返回空串。
 */
export function mentionsByName(text, names) {
  const value = String(text ?? '')
  if (value === '' || !value.includes('@')) return ''
  for (const raw of names ?? []) {
    const name = String(raw ?? '').trim()
    if (name === '') continue
    if (value.includes(`@${name}`)) return name
  }
  return ''
}

/**
 * 把正文里的 `@机器人名` 去掉（配套 `mentionsByName` 使用）。
 *
 * 为什么需要：命令是按**行首**锚定匹配的（`^[\/／]命令`）。客户端把 @ 发成纯文本时，
 * 正文长这样：`@机器人昵称 /打卡名册`——光把门禁放行还不够，`/打卡名册` 不在行首，
 * 命令依然认不出来（会当成聊天内容丢给模型）。这里把那个 @名字 连同后面的空白去掉，
 * 于是 `/打卡名册` 回到行首。名字不匹配时原样返回。
 */
export function stripMentionName(text, name) {
  const value = String(text ?? '')
  const needle = `@${String(name ?? '').trim()}`
  if (value === '' || needle === '@') return value
  const idx = value.indexOf(needle)
  if (idx === -1) return value
  return `${value.slice(0, idx)} ${value.slice(idx + needle.length)}`.replace(/\s+/g, ' ').trim()
}

/** CQ 码副作用转义还原：`&#44;` → `,`、`&#91;` → `[` …（JSON 与 XML 两种卡片都要用）。 */
function unescapeCqText(value) {
  return String(value)
    .replace(/&#44;/g, ',').replace(/&#91;/g, '[').replace(/&#93;/g, ']')
    .replace(/&#10;/g, '\n').replace(/&amp;/g, '&')
}

/** XML 实体还原（`&lt;` 等）。只处理常见五个 + 数字实体，别的一律原样。 */
function decodeXmlEntities(value) {
  return String(value)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
}

/**
 * QQ 结构化 XML 卡片 → 同样的形状。
 *
 * 为什么两种都要支持：小程序卡片在 OneBot 实现之间不统一 —— 有的给 `json` 段，
 * 有的给 `lightapp`，还有的给 `xml` 段（QQ 原生的 `<msg>` 结构）。只处理 json 的话，
 * 万一这台机器上的实现发的是 xml，修了等于没修。抽不到标题/摘要就返回 null（保持原行为）。
 */
function parseXmlCard(xml) {
  const readTag = (name) => {
    const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml)
    if (match === null) return ''
    return decodeXmlEntities(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).replace(/\s+/g, ' ').trim()
  }
  const title = readTag('title')
  const desc = readTag('summary') || readTag('brief')
  if (title === '' && desc === '') return null
  return { app: '', prompt: '', title, desc, url: readTag('url') }
}

/**
 * QQ 卡片（小程序 / 分享）→ 一行可读文字（2026-10-29 真机）。
 *
 * 为什么要有这个：`json` / `lightapp` / `xml` 段以前**完全没有分支**，于是一条
 * 「只发一张小程序卡片」的消息解析出来就是 `text=''`、又没图没文件没转发，
 * 在 `onebot.js` 的「无内容就 return」那道闸（frame→message）就被整条丢掉了 ——
 * 连 trace 都没有。用户看到的是：他发了卡片，她一个字都没收到，后面还反问「哪来的视频」。
 *
 * 能拿到的只有卡片自带的文字元数据（`prompt` / `meta.*.title` / `meta.*.desc` / XML 的
 * `<title>` `<summary>`），拿不到卡片里面的内容（视频、封面、点进去的页面）。
 * 所以这里只做「如实转述」：读不出来就说读不出来，绝不编成「我看到了」。
 *
 * @param {unknown} data - OneBot 段里的 `data`（`{data: '<json|xml>'}` / 直接对象）
 * @returns {{app: string, prompt: string, title: string, desc: string, url: string}|null}
 */
export function parseCardPayload(data) {
  let payload = data
  // NapCat / LLOneBot：`segment.data = { data: '<json 字符串>' }`；也有直接把对象塞进 data 的。
  if (payload !== null && typeof payload === 'object' && 'data' in payload) payload = payload.data
  if (payload !== null && typeof payload === 'object' && 'payload' in payload) payload = payload.payload
  if (typeof payload === 'string') {
    const unescaped = unescapeCqText(payload)
    if (unescaped.trimStart().startsWith('<')) return parseXmlCard(unescaped)
    try {
      payload = JSON.parse(unescaped)
    } catch {
      return null
    }
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null

  const str = (value) => (typeof value === 'string' ? value.trim() : '')
  const app = str(payload.app)
  const prompt = str(payload.prompt)
  let title = ''
  let desc = ''
  let url = ''
  const meta = payload.meta
  if (meta !== null && typeof meta === 'object' && !Array.isArray(meta)) {
    for (const detail of Object.values(meta)) {
      if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) continue
      if (title === '') title = str(detail.title)
      if (desc === '') desc = str(detail.desc)
      if (url === '') url = str(detail.qqdocurl) || str(detail.jumpUrl) || str(detail.url)
    }
  }
  /**
   * 🔴 顺序不能反：顶层 `desc` 常常只是**类型名**（`"QQ小程序"`），而真正有信息量的摘要
   * （谁发的 / 来自哪个 app）在 `meta.*.desc` 里。先取顶层就会把后者永久盖掉 ——
   * 真机那张卡片顶层 desc 正是 "QQ小程序"，照原样拼出来只剩个类型名。
   */
  if (desc === '') desc = str(payload.desc)
  if (title === '' && desc === '') {
    // 音乐/投票之类的卡片把标题放在 meta 之外时兜底
    title = str(payload.title)
  }
  /**
   * 按字段名取到的链接**也要过资源过滤**（2026-11-01）。
   * 真机：`meta.detail_1.url` 有时直接是 `https://…/v.mp4` —— 那是媒体资源，
   * 不是"可以读一页文字的页面"，交给她读只会得到一堆二进制。
   */
  if (url !== '' && isAssetUrl(url)) url = ''
  /**
   * 按字段名没取到链接时，再在整份 payload 里兜底找一个页面链接。
   * 各家卡片字段名不统一，只靠 `qqdocurl/jumpUrl/url` 会漏掉一部分平台。
   */
  if (url === '') url = findPageUrl(meta !== null && typeof meta === 'object' ? meta : payload)
  return { app, prompt, title, desc, url }
}

/** 判断一个 URL 是不是**资源**（图片/音频/样式），资源链接不算"卡片指向的页面"。 */
function isAssetUrl(url) {
  const path = String(url ?? '').toLowerCase().split('?')[0].split('#')[0]
  if (/\.(png|jpe?g|gif|webp|bmp|svg|ico|mp4|m4a|mp3|amr|silk|css|js|woff2?)$/.test(path)) return true
  // 常见 CDN：头像、封面、静态资源。它们出现在卡片里但没有"可读页面"的意义。
  return /qlogo\.cn|qpic\.cn|gtimg\.com|myqcloud\.com|hdslb\.com\/bfs|\.byteimg\.com/.test(path)
}

/**
 * 兜底：在 payload 里**任意深度**找第一个「看起来是页面」的 http(s) 链接。
 *
 * 为什么需要：QQ 各家卡片的字段名不统一 —— B 站是 `meta.detail_1.qqdocurl`，
 * 新闻卡常是 `meta.news.jumpUrl`，小程序可能是 `meta.detail_1.url`，
 * 还有些直接把链接塞在 `preview` / `tag` / 深层数组里。按字段名枚举永远漏。
 *
 * 边界：只找**第一个**，且跳过资源链接（`isAssetUrl`）—— 卡片里常同时有封面图和页面链接，
 * 抓错就会把"封面 URL"当成"用户分享的东西"。
 *
 * @param {unknown} node
 * @param {number} depth
 * @returns {string}
 */
function findPageUrl(node, depth = 0) {
  if (depth > 6 || node === null || typeof node !== 'object') return ''
  const values = Array.isArray(node) ? node : Object.values(node)
  for (const value of values) {
    if (typeof value === 'string') {
      const match = /https?:\/\/[^\s"'<>\\]+/i.exec(value)
      if (match !== null && !isAssetUrl(match[0])) return match[0]
    } else if (value !== null && typeof value === 'object') {
      const hit = findPageUrl(value, depth + 1)
      if (hit !== '') return hit
    }
  }
  return ''
}

/**
 * 把 {@link parseCardPayload} 的结果拼成一行给模型看的文字。
 *
 * 形态刻意和 QQ 自己引用时显示的一致（`[QQ小程序]标题`）—— 用户和模型看到的是同一个名字，
 * 排查时不用在两套说法之间翻译。
 *
 * @param {ReturnType<typeof parseCardPayload>} card
 * @returns {string} 空串 = 这个 payload 不是卡片或完全没内容（调用方据此决定是否当空消息处理）
 */
export function formatCardText(card) {
  if (card === null || card === undefined) return ''
  const { app, prompt, title, desc } = card
  const isMini = app.includes('miniapp')
  const kind = isMini ? 'QQ小程序' : '卡片'
  let line = prompt
  if (line === '') line = title !== '' ? `[${kind}]${title}` : `[${kind}]`
  /**
   * ⚠️ 追加 metadata 一律用**括号**，不能用冒号。
   *
   * 真机（2026-10-29 17:52 那张 B 站视频卡片）：`prompt` 是 `[QQ小程序]给盲猫改了猫墙轨道后`，
   * 而 `meta.detail_1.title` 是 **平台名** `哔哩哔哩`。用冒号拼出来是
   * `[QQ小程序]给盲猫改了猫墙轨道后：哔哩哔哩` —— 读起来像「标题：哔哩哔哩」，
   * 把平台名冒充成标题。括号形态「（哔哩哔哩）」才读得出"这是来源"。
   */
  if (title !== '' && !line.includes(title)) line += `（${title}）`
  // 「QQ小程序」这类类型名当摘要时没有信息量，别拼成 `[QQ小程序]标题（QQ小程序）`
  if (desc !== '' && desc !== kind && !line.includes(desc)) line += `（${desc}）`
  if (line === `[${kind}]` || line === '') return ''
  return line
}

/** 段/ CQ 码里的卡片文字；不是卡片或读不出来时返回空串。 */
export function cardTextOf(data) {
  return formatCardText(parseCardPayload(data))
}

/**
 * 从**原始帧**里再捞一次卡片的结构化字段（2026-10-29）。
 *
 * 为什么不改造 `parseMessage` 的返回值：`#onFrame` 已经把整帧作为 `message.raw` 透传给下游了，
 * 桥那边随时能二次抽取。多一个返回字段要改 30 多处调用点的形状校验，收益不成比例。
 *
 * 只取**第一张**能读出来的卡片：一条消息里塞多张卡片的场景没出现过，
 * 而"取第一张"至少是确定的（取"最有内容的那张"就得引入打分的任意性）。
 *
 * @param {unknown} rawMessage - OneBot 帧里的 `message`（数组段或 CQ 码字符串）
 * @returns {{app: string, prompt: string, title: string, desc: string, url: string}|null}
 */
export function extractCard(rawMessage) {
  const accept = (data) => {
    const card = parseCardPayload(data)
    if (card === null) return null
    // 一个字都拼不出来的 payload 不是"卡片"，别让下游拿它去搜网
    return cardTextOf(data) === '' ? null : card
  }
  if (typeof rawMessage === 'string') {
    for (const match of rawMessage.matchAll(/\[CQ:(?:json|lightapp|xml),([^\]]*)\]/g)) {
      const dataField = /(?:^|,)data=([\s\S]*)$/.exec(match[1])
      if (dataField === null) continue
      const card = accept(dataField[1])
      if (card !== null) return card
    }
    return null
  }
  if (Array.isArray(rawMessage)) {
    for (const segment of rawMessage) {
      if (!segment || typeof segment !== 'object') continue
      if (segment.type !== 'json' && segment.type !== 'lightapp' && segment.type !== 'xml') continue
      const card = accept(segment.data)
      if (card !== null) return card
    }
  }
  return null
}

export function parseMessage(rawMessage, botQq) {
  let text = ''
  const ats = []
  const records = []
  const images = []
  const files = []
  /**
   * 视频段（2026-10-29）。
   *
   * 和卡片是同一类病：`parseMessage` 里以前**根本没有 `video` 分支**，
   * 用户发一段视频解析出来 `text=''`、又没图没文件没转发 ⇒ 在 `#onFrame` 那道
   * 「无内容就 return」的闸上整条丢掉，连 trace 都没有。她那边就是"我什么都没收到"。
   *
   * OneBot v11 的实现之间字段不统一，这里三个都留着：
   * `url` 是能下载的地址（优先用），`path` 是 bot 本机路径（同机时可省一次下载），
   * `file` 在 NapCat 里常常只是文件名或 `xxx.mp4` 这种标识。
   */
  const videos = []
  // 合并转发（聊天记录）卡片：本身没有可读内容，只有 id，要靠 get_forward_msg 展开。
  // 以前这里完全没有 forward 分支，于是「只发一张转发卡片」的消息在 #onFrame 就被整条丢掉，
  // 连 trace 都没有——违反「无静默分支必带 reason」。
  const forwards = []
  let reply = null
  if (typeof rawMessage === 'string') {
    const atRe = /\[CQ:at,qq=(\d+)(?:,name=([^\]]*))?\]/g
    let match
    while ((match = atRe.exec(rawMessage)) !== null) ats.push(Number(match[1]))
    const replyMatch = /\[CQ:reply,id=([^,\]]+)(?:,text=([^\]]*))?\]/.exec(rawMessage)
    if (replyMatch) reply = { messageId: replyMatch[1], text: replyMatch[2] ?? '' }
    const videoRe = /\[CQ:video,([^\]]*)\]/g
    while ((match = videoRe.exec(rawMessage)) !== null) {
      const pick = (key) => {
        const found = new RegExp(`(?:^|,)${key}=([^,\\]]+)`).exec(match[1])
        return found ? found[1] : ''
      }
      videos.push({ file: pick('file'), url: pick('url'), path: pick('path'), duration: pick('duration') })
    }
    const recordRe = /\[CQ:record,([^\]]*)\]/g
    while ((match = recordRe.exec(rawMessage)) !== null) {
      const file = /(?:^|,)file=([^,\]]+)/.exec(match[1])
      const url = /(?:^|,)url=([^,\]]+)/.exec(match[1])
      records.push({ file: file ? file[1] : '', url: url ? url[1] : '' })
    }
    const imageRe = /\[CQ:(image|mface),([^\]]*)\]/g
    while ((match = imageRe.exec(rawMessage)) !== null) {
      const url = /(?:^|,)url=([^,\]]+)/.exec(match[2])
      const file = /(?:^|,)file=([^,\]]+)/.exec(match[2])
      const path = /(?:^|,)path=([^,\]]+)/.exec(match[2])
      // 与数组分支同一口径：url 可能缺 rkey 下不下来，file/path 是本地兜底（见数组分支的注释）
      images.push({
        kind: match[1],
        url: url ? url[1] : '',
        file: file ? file[1] : '',
        path: path ? path[1] : '',
        fileId: '',
      })
    }
    const fileRe = /\[CQ:file,([^\]]*)\]/g
    while ((match = fileRe.exec(rawMessage)) !== null) {
      const pick = (key) => {
        const found = new RegExp(`(?:^|,)${key}=([^,\\]]+)`).exec(match[1])
        return found ? found[1] : ''
      }
      files.push({
        name: pick('name'),
        url: pick('url'),
        file: pick('file'),
        // NapCat 私聊文件 url 为空时靠这两个字段救（get_file 要 file_id，path 可直接读本机）
        fileId: pick('file_id'),
        path: pick('path'),
      })
    }
    const forwardRe = /\[CQ:forward,([^\]]*)\]/g
    while ((match = forwardRe.exec(rawMessage)) !== null) {
      const id = /(?:^|,)id=([^,\]]+)/.exec(match[1])
      if (id) forwards.push({ id: id[1] })
    }
    text = stripCq(rawMessage.replace(/\[CQ:at[^\]]*\]/g, ' ').replace(/\[CQ:reply[^\]]*\]/g, ' '))
    /**
     * CQ 码字符串形态的卡片（`[CQ:json,data={...}]`）：`stripCq` 会把它整段削掉，
     * 于是又变成空文本。这里单独捞一遍，转成可读文字。
     * 注意 CQ 参数是把 JSON 塞在 `data=` 后面、并做 `&#44;` 这类转义，所以正则要吃到 `]` 为止，
     * 解转义交给 {@link parseCardPayload}。
     */
    for (const match of rawMessage.matchAll(/\[CQ:(?:json|lightapp|xml),([^\]]*)\]/g)) {
      const dataField = /(?:^|,)data=([\s\S]*)$/.exec(match[1])
      if (dataField === null) continue
      const cardText = cardTextOf(dataField[1])
      if (cardText !== '') text = `${text} ${cardText}`.trim()
    }
  } else if (Array.isArray(rawMessage)) {
    const parts = []
    for (const segment of rawMessage) {
      if (!segment || typeof segment !== 'object') continue
      if (segment.type === 'text') parts.push((segment.data && segment.data.text) ?? '')
      else if (segment.type === 'at') ats.push(Number((segment.data && segment.data.qq) ?? 0))
      else if (segment.type === 'reply') {
        // seq / root 是给冷缓存回源用的附加线索（2026-11-02 早）：
        // 实测 sourceMsgIdInRecords 不是 msgId，按 id 查内核永远空，只能按 seq 兜。
        reply = {
          messageId: segment.data?.id ?? '',
          text: segment.data?.text ?? '',
          seq: segment.data?.seq ?? '',
          root: segment.data?.root ?? '',
        }
      } else if (segment.type === 'record') {
        records.push({
          file: segment.data?.file ?? '',
          url: segment.data?.url ?? '',
          path: segment.data?.path ?? '',
        })
      } else if (segment.type === 'image' || segment.type === 'mface') {
        images.push({
          kind: segment.type,
          url: segment.data?.url ?? '',
          file: segment.data?.file ?? '',
          /**
           * `path` / `file_id` 以前被丢掉了（只留 url/file/summary）——和 2026-10-29 私聊文件
           * 那次是同一个坑，只是这次轮到图片：真机 2026-10-30 的图片 url 是
           * `gchat.qpic.cn/download?appid=1406&fileid=…&spec=0`，**缺 rkey**，QQ 直接回
           * `{"retcode":-5503010,"retmsg":"invalid rkey"}` ⇒ HTTP 400，而图片其实早就被 QQ
           * 下载到本地缓存里了。多留两个字段，就多两条不依赖网络的取图路子。
           */
          path: segment.data?.path ?? '',
          fileId: segment.data?.file_id ?? '',
          summary: segment.data?.summary ?? '',
        })
      } else if (segment.type === 'file') {
        files.push({
          name: segment.data?.name ?? '',
          url: segment.data?.url ?? '',
          file: segment.data?.file ?? '',
          // 只留 name/url/file 会把 NapCat 的 file_id / path 丢掉——
          // 私聊文件段 url 为空（真机实证 2026-10-29），没这两字段就永远「没有可下载链接」。
          fileId: segment.data?.file_id ?? '',
          path: segment.data?.path ?? '',
          size: segment.data?.size ?? segment.data?.file_size ?? '',
        })
      } else if (segment.type === 'forward') {
        const id = segment.data?.id
        if (id !== undefined && id !== null && String(id) !== '') forwards.push({ id: String(id) })
      } else if (segment.type === 'video') {
        videos.push({
          file: segment.data?.file ?? '',
          url: segment.data?.url ?? '',
          path: segment.data?.path ?? '',
          duration: segment.data?.duration ?? '',
        })
      } else if (segment.type === 'json' || segment.type === 'lightapp' || segment.type === 'xml') {
        /**
         * 小程序 / 分享卡片：里面没有可读正文，只有卡片自带的文字元数据。
         * 不转成文字的话这条消息会变成空文本 → 被当成"空文本且无可用媒体"整条丢掉，
         * 她的上下文里连"你发了一张卡片"都不存在（2026-10-29 真机就是这样）。
         */
        const cardText = cardTextOf(segment.data)
        if (cardText !== '') parts.push(cardText)
      }
    }
    text = parts.join(' ')
  }
  return { text: text.replace(/\s+/g, ' ').trim(), ats, records, images, files, forwards, videos, reply }
}

function stripCq(text) {
  // Keep CQ:at with names readable; drop image/face/etc. payload noise.
  return String(text)
    .replace(/\[CQ:at,qq=(\d+)(?:,name=([^\]]*))?\]/g, (_m, qq, name) => name ? `@${name}` : `@${qq}`)
    .replace(/\[CQ:[^\]]+\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Parse a OneBot v11 notice frame into a normalized shape (poke / member in-out / recall / ...). */
export function parseNotice(frame) {
  if (!frame || frame.post_type !== 'notice') return null
  return {
    noticeType: frame.notice_type ?? '',
    subType: frame.sub_type ?? '',
    groupId: frame.group_id !== undefined ? Number(frame.group_id) : undefined,
    userId: frame.user_id !== undefined ? Number(frame.user_id) : undefined,
    targetId: frame.target_id !== undefined ? Number(frame.target_id) : undefined,
    operatorId: frame.operator_id !== undefined ? Number(frame.operator_id) : undefined,
    messageId: frame.message_id !== undefined ? frame.message_id : undefined,
    duration: frame.duration !== undefined ? Number(frame.duration) : undefined,
    selfId: frame.self_id !== undefined ? Number(frame.self_id) : undefined,
    // v0.5.3 互动：真机探针确认过的字段（group_msg_emoji_like / notify.poke / notify.input_status）。
    likes: Array.isArray(frame.likes) ? frame.likes : undefined,
    isAdd: frame.is_add !== undefined ? frame.is_add !== false : undefined,
    messageSeq: frame.message_seq !== undefined ? frame.message_seq : undefined,
    senderId: frame.sender_id !== undefined ? Number(frame.sender_id) : undefined,
    eventType: frame.event_type !== undefined ? Number(frame.event_type) : undefined,
    statusText: frame.status_text !== undefined ? String(frame.status_text) : undefined,
    // v0.5.8 权限自愈：group_admin 的「设/撤」在 **sub_type** 里（'set' / 'unset'），
    // 真机探针确认该事件**没有** set 布尔字段；其它 notice 类型下为 undefined。
    adminSet: frame.notice_type === 'group_admin' ? frame.sub_type !== 'unset' : undefined,
  }
}

/** Parse a OneBot v11 request frame (group join / friend add) into a normalized shape. */
export function parseRequest(frame) {
  if (!frame || frame.post_type !== 'request') return null
  return {
    requestType: frame.request_type === 'friend' ? 'friend' : 'group',
    subType: frame.sub_type ?? 'add',
    userId: frame.user_id !== undefined ? Number(frame.user_id) : 0,
    groupId: frame.group_id !== undefined ? Number(frame.group_id) : 0,
    comment: String(frame.comment ?? ''),
    flag: String(frame.flag ?? ''),
    selfId: frame.self_id !== undefined ? Number(frame.self_id) : undefined,
  }
}

/**
 * 识别 QQ 的「邀请你加入群聊」分享消息（v0.7.21）。
 *
 * 真机取证（`qq-inbox.jsonl` 2026-10-29 22:31:39）：群邀请有**两种到达形态** ——
 *   ① OneBot 的 `request(group/invite)` 事件：带 `flag`，桥能 `/同意 N` 真批；
 *   ② QQ 客户端的**邀请分享消息**：成了一条普通私聊文本
 *      `[链接]邀请你加入群聊（邀请你加入群聊“音游病情交流地”，进入可查看详情。）`
 *
 * 第②种**没有 flag**，`set_group_add_request` 用不上，桥批不了；但它绝不能当普通话处理 ——
 * 否则她只会顺口答一句（实测回了 15 字），主人那边永远看不到"有人在邀请你进群"。
 * 这个函数只做一件事：认出来 + 抠出群名。是不是要提示主人、要不要在回复里说明，
 * 由桥决定（纯函数，好测）。
 */
export function matchGroupInviteShare(text) {
  const raw = String(text ?? '')
  if (raw === '' || !raw.includes('邀请你加入群聊')) return null
  // 群名在中文引号/英文引号/书名号里都可能出现，取第一个能匹配的
  const m = /邀请你加入群聊\s*[“"「《]([^”"」》]{1,60})[”"」》]/.exec(raw)
    ?? /[“"「《]([^”"」》]{1,60})[”"」》]\s*[，,)]/.exec(raw)
  return {
    groupName: m ? m[1].trim() : '',
    // 是否带 `[链接]` 前缀（QQ 分享消息的渲染特征），仅用于文案区分
    shared: raw.startsWith('[链接]'),
  }
}

export class OneBotServer extends EventEmitter {
  #wss = null
  #starting = null
  #connections = new Map()
  #echo = 0
  /** accessToken 为空这件事只提示一次，免得每条连接刷一行日志。 */
  #warnedNoToken = false
  #pending = new Map()
  /**
   * 从事件里学到的"我自己是谁"（2026-11-01）。
   *
   * 为什么需要：`config.botQq` 的默认值是 0，而 0 在 `#onFrame` 里的语义是
   * **"不知道我是谁 ⇒ 群里每条消息都当 @ 了我"**。那是个宽方向兜底：
   * 一旦 `replyOnlyWhenMentioned` 开着，群里任何人说任何话她都会接 —— 刷屏，然后被风控。
   * OneBot 每条消息事件都带 `self_id`，白给的身份，不应该再靠用户手填。
   *
   * 只学一次（第一个带 self_id 的帧），之后即使换号也不用管：换号会换连接。
   */
  #learnedSelfId = 0
  /** `botQq` 没配时反复提示"只能靠兜底"会很吵，这条也只提示一次。 */
  #warnedNoSelfId = false

  constructor(config, logger) {
    super()
    this.config = config
    this.logger = logger
    /**
     * Dry-run mode (v0.4 debugging): while on, action calls are recorded and
     * stubbed instead of being sent, so a synthetic frame can run through the real
     * pipeline with zero QQ side effects.
     *
     * `enabled === true` intercepts EVERY call (used by offline replay, which has
     * no real socket at all). Passing a scope object — `{ chatKey }` — intercepts
     * only calls that target that chat, so a debug window can never swallow a real
     * user's reply in another conversation.
     */
    this.dryRun = false
    this.dryRunScope = null
    this.dryRunCalls = []
  }

  /** Turn dry-run on/off (optionally scoped to one chat); returns the previous value. */
  setDryRun(enabled, scope = null) {
    const previous = { enabled: this.dryRun, scope: this.dryRunScope }
    this.dryRun = enabled === true
    this.dryRunScope = this.dryRun && scope && typeof scope === 'object' ? { ...scope } : null
    if (this.dryRun) this.dryRunCalls = []
    return previous
  }

  /** Does this call belong to the scoped chat? (no scope → every call does) */
  #inDryRunScope(params) {
    if (!this.dryRun) return false
    const scope = this.dryRunScope
    if (!scope) return true
    if (scope.groupId && Number(params?.group_id) === Number(scope.groupId)) return true
    if (scope.userId && Number(params?.user_id) === Number(scope.userId)) return true
    return false
  }

  /** Every action that WOULD have been sent while dry-run was on. */
  takeDryRunCalls() {
    const calls = this.dryRunCalls.slice()
    this.dryRunCalls = []
    return calls
  }

  /**
   * 启动反向 WS 监听。
   *
   * **永不抛、永不挂、可重复调用**：返回 `{ ok: true }` 或 `{ ok: false, code, reason }`。
   * 端口被占（web 宿主与官方桌面端同时跑同一份配置时必然发生）在旧实现里是两连击：
   * `this.emit('error', …)` 没有订阅者 → EventEmitter 直接**抛出**未捕获错误（历史上那次
   * EADDRINUSE 崩溃就是这么来的），而等 `'listening'` 的 Promise 永远不 resolve → 宿主启动卡死。
   * 现在两种情况都变成"如实返回失败"，由上层决定怎么降级（见 lib/index.js 的退避重试）。
   *
   * ⚠️ 幂等：已经在监听时**直接返回 ok:true，绝不去关掉一个健康实例**。
   * 旧实现只关闭"还没绑上"的那个，于是"先超时（ETIMEDOUT）、后重试"这条路上，
   * 第二次 `start()` 会把**已经绑定的 socket 变成孤儿**：端口一直被占、桥却没起来，
   * 日志还反过来赖"端口被另一个进程占用"（对抗性审查实测复现：start→ok、
   * 再 start→EADDRINUSE、`stop()` 之后端口仍然占着）。并发调用也复用同一个 Promise。
   */
  start({ timeoutMs = 5000 } = {}) {
    if (this.#wss && this.#wss.address() !== null) return Promise.resolve({ ok: true, already: true })
    if (this.#starting) return this.#starting
    // 风险提示放在**开始监听之前**，不是等第一条连接进来：端口一开就已经暴露了，
    // 没人连的那些时间里它同样开着。等有人连再说，等于把"一直没人来"这段静默掉了。
    if (!this.config.accessToken && !this.#warnedNoToken) {
      this.#warnedNoToken = true
      this.logger.warn('OneBot 未配置 accessToken：本机任意进程都能连上反向 WS。Origin 闸只能挡住浏览器发起的连接，挡不住本机的原生进程——需要更强的隔离就配一个 token。')
    }
    const { host, port } = this.config
    // 上一次尝试留下的实例：它没在监听（否则上面就返回了），关掉不泄漏。
    if (this.#wss) {
      try { this.#wss.close() } catch {}
      this.#wss = null
    }
    this.#wss = new WebSocketServer({ host, port })
    const wss = this.#wss
    wss.on('error', (error) => {
      this.logger.error(`OneBot server error: ${error.message}`)
      // EventEmitter 的 'error' 事件没有订阅者会**抛出**：只有真有人订阅时才 emit。
      if (this.listenerCount('error') > 0) this.emit('error', error)
      else this.emit('server-error', error)
    })
    wss.on('connection', (socket, request) => this.#accept(socket, request))
    const promise = new Promise((resolve) => {
      if (wss.address() !== null) return resolve({ ok: true })
      let settled = false
      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        wss.off('listening', onListening)
        wss.off('error', onBindError)
        this.#starting = null
        // 没绑上的实例就地关掉：既不留悬挂的 Server，也不让下一次 start() 关错对象。
        if (result.ok !== true && wss.address() === null) {
          try { wss.close() } catch {}
        }
        resolve(result)
      }
      const onListening = () => {
        this.logger.info(`OneBot reverse-WS listening on ws://${host}:${port}`)
        finish({ ok: true })
      }
      const onBindError = (error) => finish({ ok: false, code: error.code ?? '', reason: String(error.message ?? '监听失败') })
      const timer = setTimeout(() => {
        // 超时 ≠ 没绑上：慢机器上可能刚好在超时后才绑成功，先看 address() 再定结论。
        finish(wss.address() !== null
          ? { ok: true, late: true }
          : { ok: false, code: 'ETIMEDOUT', reason: `监听 ws://${host}:${port} 超时（${timeoutMs}ms）` })
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      wss.once('listening', onListening)
      wss.once('error', onBindError)
    })
    this.#starting = promise
    return promise
  }

  async stop() {
    for (const socket of this.#connections.values()) {
      try { socket.close(1000, 'bridge shutdown') } catch {}
    }
    this.#connections.clear()
    if (this.#wss) await new Promise((resolve) => this.#wss.close(() => resolve()))
    this.#wss = null
  }

  #accept(socket, request) {
    /**
     * ① Origin 闸（2026-10-31，外部审计 S1/S2）。
     *
     * 为什么这条能挡攻击、又不误伤任何合法客户端：
     *   · 浏览器发起 WebSocket 时**一定会**带 `Origin`（握手就是一次 HTTP 请求，浏览器
     *     按规范加，页面脚本改不了它）；
     *   · OneBot 实现（NapCat / Waylay / LLOneBot…）是原生进程，用 `ws` 库连，**默认不发**。
     *
     * 所以「带 Origin 就拒」的区分度是干净的。不加这条的话，用户访问任意恶意网页，
     * 页面里一句 `new WebSocket('ws://127.0.0.1:6700')` 就能连上来伪造事件——
     * 浏览器不受同源策略约束，`127.0.0.1` 也不例外，而 accessToken 默认是**空**的。
     *
     * 要包一层浏览器客户端的人把 `allowBrowserOrigin` 打开即可，那时请**同时**配 accessToken。
     */
    const remote = String(request?.socket?.remoteAddress ?? '')
    const origin = String(request?.headers?.origin ?? '')
    if (origin !== '' && this.config.allowBrowserOrigin !== true) {
      this.logger.warn(`OneBot connection rejected (browser Origin ${origin}) — 这是网页发起的连接；原生 OneBot 客户端不带 Origin。确实需要浏览器接就打开 allowBrowserOrigin`)
      /**
       * **发事件，不只是打日志**（2026-10-31 实测发现问题）。
       *
       * `ctx.logger` 的输出不进 `qq-host-out.log` / `qq-host-err.log`——那两个文件里
       * 连启动时必打的 `QQ bridge ready` 都没有，说明它走的是 dsh 自己的通道。
       * 也就是说：只调 `logger.warn`，"被拒了"这件事用户**很可能根本看不见**——
       * 那和静默拒绝没有区别。
       *
       * 所以改成发事件，由 bridge 写进 `qq-trace.jsonl`：控制台的实时事件流和 `/为什么`
       * 读的就是它。日志保留（有 dsh 日志面板的人还能看到），但可观测性不再依赖它。
       */
      this.emit('connection-rejected', { reason: 'browser-origin', origin, remote })
      socket.close(4003, 'browser origin not allowed')
      return
    }

    const token = extractBearer(request)
    if (this.config.accessToken && token !== this.config.accessToken) {
      this.logger.warn(`OneBot connection rejected (bad access token) from ${remote}`)
      this.emit('connection-rejected', { reason: 'bad-token', origin, remote })
      socket.close(4001, 'invalid access token')
      return
    }
    // accessToken 为空时**不是静默放行**——提示在 start() 里发（端口一开就发，不等有人连）。
    const id = `${request.socket.remoteAddress}:${Date.now()}:${++this.#echo}`
    this.#connections.set(id, socket)
    this.logger.info(`OneBot bot connected (${this.#connections.size} active)`)
    socket.on('message', (data) => this.#onFrame(socket, data))
    socket.on('close', () => {
      this.#connections.delete(id)
      this.logger.info(`OneBot bot disconnected (${this.#connections.size} active)`)
      this.emit('bot-disconnect', socket)
    })
    socket.on('error', () => {})
    this.emit('bot-connect', socket)
  }

  #onFrame(socket, data) {
    let frame
    try { frame = JSON.parse(String(data)) } catch { return }
    if (frame.echo !== undefined) {
      const pending = this.#pending.get(String(frame.echo))
      if (pending) {
        this.#pending.delete(String(frame.echo))
        pending(frame)
      }
      return
    }
    if (frame.post_type === 'message' && frame.message_type) {
      const userId = Number(frame.user_id)
      const messageType = frame.message_type === 'group' ? 'group' : 'private'
      const groupId = messageType === 'group' ? Number(frame.group_id) : undefined
      /**
       * ① 认自己是谁（2026-11-01）。
       *
       * OneBot 的每条消息事件都带 `self_id`，不需要用户去设置页手填 QQ 号。
       * 以前 `botQq` 默认 0，而 0 在下面的 `atMe` 里等于「群里每条消息都算 @ 了我」——
       * 配上 `replyOnlyWhenMentioned` 就是"群里谁说话她都接"，刷屏→风控。
       */
      const selfId = Number(frame.self_id)
      if (Number.isFinite(selfId) && selfId > 0 && this.#learnedSelfId !== selfId) {
        const first = this.#learnedSelfId === 0
        this.#learnedSelfId = selfId
        if (first) this.logger.info(`OneBot 学到自己的 QQ 号：${selfId}（来自事件 self_id；配置项 botQq 留 0 即可）`)
      }
      const botQq = this.selfQq
      /**
       * ② 自己发的消息不再是"用户说的话"（`ignoreSelf`，默认开）。
       *
       * 宿主是否把机器人自己发的消息回推给插件，取决于 OneBot 端的实现和配置。
       * 一旦回推而这里不过滤，就成了一条自问自答的闭环：她发 → 收到 → 再发 → …
       * 圈一旦转起来消息量瞬间拉满，是最容易被风控的打法。
       * 过滤放在**解析之前**：省掉一次没意义的 CQ 解析。
       */
      if (this.config.ignoreSelf !== false && botQq > 0 && userId === botQq) return
      if (this.config.ignoreSelf !== false && botQq === 0 && !this.#warnedNoSelfId) {
        this.#warnedNoSelfId = true
        this.logger.warn('OneBot 没能确定自己的 QQ 号（配置 botQq=0 且事件里没有 self_id）：这条路上既挡不住"她自己发的消息"，群里也会把每条消息都当成 @ 了她')
      }
      const parsed = parseMessage(frame.message, botQq)
      // 转发卡片也算"有内容"：否则「只发一张聊天记录卡片」的消息会在这里被静默丢掉（连 trace 都没有）。
      // 「有内容」的判据要把所有能处理的载体都算上。视频以前不在这句里 ——
      // 结果一条视频消息在 frame→message 就被丢掉，和她当年"什么都没收到"的卡片是同一个病。
      if ((parsed.text === '' && parsed.records.length === 0 && parsed.images.length === 0 && parsed.files.length === 0 && parsed.forwards.length === 0 && parsed.videos.length === 0) || !Number.isFinite(userId)) return
      const atMe = messageType === 'group'
        ? (botQq === 0 || parsed.ats.includes(botQq))
        : false
      this.emit('message', {
        bot: socket,
        userId,
        messageType,
        groupId,
        text: parsed.text,
        atMe,
        ats: parsed.ats,
        reply: parsed.reply,
        records: parsed.records,
        images: parsed.images,
        files: parsed.files,
        forwards: parsed.forwards,
        videos: parsed.videos,
        messageId: frame.message_id,
        senderName: (frame.sender && (frame.sender.card || frame.sender.nickname)) || '',
        raw: frame,
      })
    }
    if (frame.post_type === 'notice') {
      const notice = parseNotice(frame)
      if (notice && Number.isFinite(notice.userId)) {
        this.emit('notice', { bot: socket, ...notice })
      }
    }
    if (frame.post_type === 'request') {
      const request = parseRequest(frame)
      if (request && Number.isFinite(request.userId)) {
        this.emit('request', { bot: socket, ...request })
      }
    }
  }

  sendText(socket, messageType, targetId, text) {
    return this.sendSegments(socket, messageType, targetId, [{ type: 'text', data: { text } }])
  }

  /** Send a message as an array of CQ segments (text/face/image). */
  sendSegments(socket, messageType, targetId, segments) {
    const action = messageType === 'group' ? 'send_group_msg' : 'send_private_msg'
    const params = { message: segments }
    if (messageType === 'group') params.group_id = targetId
    else params.user_id = targetId
    return this.#call(socket, action, params)
  }

  /** 她所在的群列表（群号/群名/人数）——测群聊时拿群号、管理员端做群可视化都用它。 */
  getGroupList(socket) {
    return this.#call(socket, 'get_group_list', {})
  }

  /** 单个群的详情（群名/人数/上限）。 */
  getGroupInfo(socket, groupId) {
    return this.#call(socket, 'get_group_info', { group_id: Number(groupId) })
  }

  /**
   * int64 消息 id → 能安全放进 JSON 的参数（2026-11-01）。
   *
   * ★ 这是 `getMsg` 那个精度事故的**同源**缺陷，只是还没被触发：
   * `delete_msg` / `set_essence_msg` / `set_msg_emoji_like` 原来一律
   * `Number(messageId)`，遇到 19 位的真机 id 就静默变成另一个数（见 `getMsg` 注释），
   * 后果是"撤回失败"或**撤错一条**、表情回应打到别的消息上 —— 而这些都不会报错。
   *
   * 口径：能无损表示成 number 就给 number（保持旧行为，绝大多数 id 走这条），
   * 不能就原样给字符串（唯一不丢精度的形态）。
   */
  #idParam(value) {
    const raw = String(value ?? '').trim()
    const asNumber = Number(raw)
    return raw !== '' && Number.isFinite(asNumber) && String(asNumber) === raw ? asNumber : raw
  }

  /**
   * 对外的一次 action 调用（调试入口）。
   *
   * 给管理员的 `!probe <action>` 用：让主人能在 QQ 里直接探测**后端支持什么**，
   * 不必为了一个字段去翻别人的源码、也不必重启后猜。
   * 与内部 `#call` 同一套超时/错误语义，只多一层"能传任意 action"的口子 ——
   * 因此**只允许管理员指令那条路调用**，不对 HTTP 或插件外部暴露。
   */
  async callAction(socket, action, params = {}) {
    return this.#call(socket, String(action), params ?? {})
  }

  /**
   * Fetch the full content of a message by id (for quote/reply resolution).
   *
   * ★ 2026-11-01：**message_id 必须按字符串发**，绝不能 `Number()` 一下。
   *
   * 真机事故：用户引用一条卡片，日志只有 `quote resolve: got=null segments=0`，
   * 无论引用什么她都看不到内容。根因不在卡片、也不在权限 —— 是**精度**：
   * QQ 的消息 id 是 int64，真机值 `7703053729802896443`（19 位），
   * 远超 `Number.MAX_SAFE_INTEGER`(9007199254740991)，`Number()` 会**静默**改掉低几位
   * （→ `7703053729802896000`），于是 get_msg 去查一个**根本不存在的 id**，返回 null。
   * 这个错不会抛异常、日志也只写"没取到"，所以看起来永远像"消息太旧/权限不够"。
   *
   * 兼容：先按字符串查；只有「数字能无损表示」（≤15 位的旧式 id）时才回退成数字再试一次。
   * 大 id 没有退路 —— 用 Number 重试等于拿同一个错 id 再查一遍。
   */
  async getMsg(socket, messageId, peer = null) {
    const raw = String(messageId ?? '').trim()
    if (raw === '') throw new Error('get_msg: message_id 是空的')
    const asNumber = Number(raw)
    const lossless = Number.isFinite(asNumber) && String(asNumber) === raw
    /**
     * `_peer` 是给**后端**用的附加线索（OneBot v11 没有这个字段，多一个键不影响兼容）：
     * 有的实现（Waylay）的 `get_msg` 只查内存缓存，重启后历史全冷；
     * 带上会话身份它才有可能回源内核去取。别的实现会忽略这个键。
     */
    const extra = peer && (peer.targetId ?? '') !== ''
      ? {
        _peer: {
          chatType: peer.messageType === 'group' ? 2 : 1,
          peerUid: String(peer.targetId),
          // 附加线索：实测 `sourceMsgIdInRecords` 不是 msgId（按 id 查内核永远空且不报错），
          // 所以把 seq 也传下去，让后端可以用"按 seq 取"那条路兜。
          ...(peer.seq ? { seq: String(peer.seq) } : {}),
        },
      }
      : {}
    let firstError = null
    try {
      const msg = await this.#call(socket, 'get_msg', { message_id: raw, ...extra })
      if (msg) return msg
    } catch (error) {
      firstError = error
    }
    if (!lossless) {
      // 大 id 没有第二条路：把真实错误抛出去，别吞成"没取到"
      if (firstError) throw firstError
      return null
    }
    // 有的实现只认 number；能无损转换时再问一次（字符串那次可能是 null 而不是抛错）
    return this.#call(socket, 'get_msg', { message_id: asNumber, ...extra })
  }

  /** Fetch a voice record (optionally converted) — resolves to data.base64. */
  getRecord(socket, file, outFormat = 'mp3') {
    return this.#call(socket, 'get_record', { file, out_format: outFormat })
  }

  /**
   * 拿私聊文件的下载地址/本地路径（2026-10-29）。
   *
   * NapCat 的私聊 file 段 `url` 常常是空的（真机实证：`{"name":"","url":"","file":"123.txt"}`），
   * 光靠事件里那点字段根本存不了文件。NapCat 提供了 `get_file` 动作：
   * 传 `file_id`（有的版本叫 `file`），返回 `{ file, url, path, file_name, base64? }`。
   * params 里没有 group_id/user_id ⇒ 注入 dry-run 不会拦它（与 get_record 同理）。
   */
  getFile(socket, fileId) {
    return this.#call(socket, 'get_file', { file_id: fileId })
  }

  /**
   * 用文件名换图片的**本地缓存路径**（2026-10-30）。
   *
   * 真机取证：私聊图片段给的 url 是 `gchat.qpic.cn/download?appid=1406&fileid=…&spec=0`，
   * 里面**没有 rkey**，下载必然 `{"retcode":-5503010,"retmsg":"invalid rkey"}` ⇒ HTTP 400，
   * 但那张图其实早被 QQ 自己下载到本地缓存了（`nt_data/Pic|Emoji/…/Ori/<md5>.jpg`）。
   * Waylay（NapCat 系）实现了 `get_image`：传 `file`（图片段的 fileName），
   * 返回 `{ file: '<本地绝对路径>', file_size, filename }`；取不到时 `file` 为空串。
   * 与 `get_file` 同一个理由不含 group_id/user_id ⇒ 注入 dry-run 不会拦它。
   */
  getImage(socket, file) {
    return this.#call(socket, 'get_image', { file })
  }

  /** The most recently connected open bot socket (for delayed sends after reconnects). */
  currentSocket() {
    for (const socket of this.#connections.values()) {
      if (socket.readyState === socket.OPEN) return socket
    }
    return null
  }

  /**
   * 当前认定的"我自己"是谁：显式配置优先，其次是从消息事件里学到的 `self_id`，都没有才是 0。
   *
   * 0 是"不知道"，不是"没有自己"。`#onFrame` 里 0 会让每一条群消息都被当成 @ 了机器人，
   * 所以这个 getter 的存在就是为了让那个兜底尽量用不上。
   */
  get selfQq() {
    const configured = Number(this.config?.botQq ?? 0)
    if (Number.isFinite(configured) && configured > 0) return configured
    return this.#learnedSelfId
  }

  /** 学到的 self_id（只读，给测试和诊断用；不含配置值）。 */
  get learnedSelfId() {
    return this.#learnedSelfId
  }

  /** Mute (or unmute) a group member (durationSeconds 0 = unmute). */
  setGroupBan(socket, groupId, userId, durationSeconds) {
    return this.#call(socket, 'set_group_ban', { group_id: groupId, user_id: userId, duration: durationSeconds })
  }

  /** Kick a member out of a group. */
  setGroupKick(socket, groupId, userId) {
    return this.#call(socket, 'set_group_kick', { group_id: groupId, user_id: userId })
  }

  // ---- write actions (gate them through ActionGate before calling) ----

  /** Recall a message. */
  deleteMsg(socket, messageId) {
    return this.#call(socket, 'delete_msg', { message_id: this.#idParam(messageId) })
  }

  /** Set a member's group card (nickname inside the group). */
  setGroupCard(socket, groupId, userId, card) {
    return this.#call(socket, 'set_group_card', { group_id: groupId, user_id: userId, card: String(card ?? '') })
  }

  /** Set a member's special title (needs owner rights). */
  setGroupSpecialTitle(socket, groupId, userId, title, duration = -1) {
    return this.#call(socket, 'set_group_special_title', {
      group_id: groupId, user_id: userId, special_title: String(title ?? ''), duration,
    })
  }

  /** Whole-group mute on/off. */
  setGroupWholeBan(socket, groupId, enable) {
    return this.#call(socket, 'set_group_whole_ban', { group_id: groupId, enable: Boolean(enable) })
  }

  /** Leave (or dismiss, when owner) a group. */
  setGroupLeave(socket, groupId, isDismiss = false) {
    return this.#call(socket, 'set_group_leave', { group_id: groupId, is_dismiss: Boolean(isDismiss) })
  }

  /** Add a message to the group's essence list. */
  setEssenceMsg(socket, messageId) {
    return this.#call(socket, 'set_essence_msg', { message_id: this.#idParam(messageId) })
  }

  deleteEssenceMsg(socket, messageId) {
    return this.#call(socket, 'delete_essence_msg', { message_id: this.#idParam(messageId) })
  }

  /** Publish a group notice (NapCat exposes it as `_send_group_notice`). */
  sendGroupNotice(socket, groupId, content, image = '') {
    const params = { group_id: groupId, content: String(content ?? '') }
    if (image) params.image = image
    return this.#call(socket, '_send_group_notice', params)
  }

  /** Emoji reaction on a message (NapCat extension; failures are non-fatal). */
  setMsgEmojiLike(socket, messageId, emojiId = 128077) {
    return this.#call(socket, 'set_msg_emoji_like', { message_id: this.#idParam(messageId), emoji_id: Number(emojiId) || 128077 })
  }

  // ---- 互动（v0.5.3「点一下就完事」）----
  // 下面每个 action 名都由真机静态探针逐一确认过：NapCat bootmain/napcat.mjs
  // （QQ 9.9.32-50969）里存在同名 action，参数形状与这里一致。

  /** 群聊戳一戳（NapCat 的 group_poke 与 friend_poke 共用一套参数）。 */
  groupPoke(socket, groupId, userId) {
    return this.#call(socket, 'group_poke', { group_id: Number(groupId), user_id: Number(userId) })
  }

  /** 私聊戳一戳。 */
  friendPoke(socket, userId) {
    return this.#call(socket, 'friend_poke', { user_id: Number(userId) })
  }

  /**
   * 私聊「正在输入」状态（1=正在输入，2=停止输入）。
   * 真机探针：NapCat 的 set_input_status 只拼 C2C 会话，群聊没有这个能力。
   */
  setInputStatus(socket, userId, eventType = 1) {
    return this.#call(socket, 'set_input_status', { user_id: String(userId), event_type: Number(eventType) || 1 })
  }

  /** 谁给这条消息点了表情（NapCat 扩展；返回 { emoji_like_list: [{ user_id, nick_name }] }）。 */
  getEmojiLikes(socket, messageId, emojiId = '128077', { groupId = 0, emojiType = '', count = 50 } = {}) {
    const params = { message_id: String(messageId), emoji_id: String(emojiId), count: Number(count) || 50 }
    if (groupId) params.group_id = String(groupId)
    if (emojiType !== '') params.emoji_type = String(emojiType)
    return this.#call(socket, 'get_emoji_likes', params)
  }

  /** 给某人点赞（QQ 客户端上限就是 10 次；频率过快会返回 1400）。 */
  sendLike(socket, userId, times = 1) {
    return this.#call(socket, 'send_like', { user_id: String(userId), times: Number(times) || 1 })
  }

  /** 标记群会话已读（真机探针：NapCat 按会话标记，不接受单条消息 ID）。 */
  markGroupMsgAsRead(socket, groupId) {
    return this.#call(socket, 'mark_group_msg_as_read', { group_id: String(groupId) })
  }

  /** 标记私聊会话已读。 */
  markPrivateMsgAsRead(socket, userId) {
    return this.#call(socket, 'mark_private_msg_as_read', { user_id: String(userId) })
  }

  // ---- 群运营工具箱（v0.5.4「群运营工具箱」）----
  // action 名与参数形状同样来自真机静态探针（NapCat bootmain/napcat.mjs，QQ 9.9.32-50969）。

  /** 原生群打卡（QQ 的「群签到」，与插件本地的 /签到 积分游戏无关）。 */
  groupSign(socket, groupId) {
    return this.#call(socket, 'set_group_sign', { group_id: String(groupId) })
  }

  /** @全体剩余次数（探针返回 can_at_all / remain_at_all_count_for_group / remain_at_all_count_for_uin）。 */
  getGroupAtAllRemain(socket, groupId) {
    return this.#call(socket, 'get_group_at_all_remain', { group_id: String(groupId) })
  }

  /** 群禁言名单（探针返回 [{ user_id, nickname, shut_up_time }]）。 */
  getGroupShutList(socket, groupId) {
    return this.#call(socket, 'get_group_shut_list', { group_id: String(groupId) })
  }

  /** 群详细信息（扩展）：字段名比 get_group_info 多，能拿到群描述/问题等。 */
  getGroupInfoEx(socket, groupId) {
    return this.#call(socket, 'get_group_info_ex', { group_id: String(groupId) })
  }

  /** 被忽略的入群申请与邀请。 */
  getGroupIgnoredNotifies(socket) {
    return this.#call(socket, 'get_group_ignored_notifies', {})
  }

  /** 批量踢人（原生一次多个 QQ；userIds 必须是字符串数组）。 */
  kickGroupMembers(socket, groupId, userIds, rejectAddRequest = false) {
    return this.#call(socket, 'set_group_kick_members', {
      group_id: String(groupId),
      user_id: (Array.isArray(userIds) ? userIds : [userIds]).map((id) => String(id)),
      reject_add_request: rejectAddRequest === true,
    })
  }

  /** 群待办：设置 / 完成 / 取消（三者共用 { group_id, message_id? / message_seq? }）。 */
  groupTodo(socket, kind, { groupId, messageId = '', messageSeq = '' } = {}) {
    const action = kind === 'complete' ? 'complete_group_todo' : kind === 'cancel' ? 'cancel_group_todo' : 'set_group_todo'
    const params = { group_id: String(groupId) }
    if (String(messageSeq).trim() !== '') params.message_seq = String(messageSeq).trim()
    if (String(messageId).trim() !== '') params.message_id = String(messageId).trim()
    return this.#call(socket, action, params)
  }

  /** 修改群名 / 群备注 / 群头像。 */
  setGroupProfile(socket, kind, { groupId, value = '' } = {}) {
    if (kind === 'remark') return this.#call(socket, 'set_group_remark', { group_id: String(groupId), remark: String(value) })
    if (kind === 'portrait') return this.#call(socket, 'set_group_portrait', { group_id: String(groupId), file: String(value) })
    return this.#call(socket, 'set_group_name', { group_id: String(groupId), group_name: String(value) })
  }

  /** 群成员功能权限（局部更新：没传的项保持不变，与探针文档一致）。 */
  setGroupMemberPermissions(socket, params) {
    return this.#call(socket, 'set_group_member_permissions', params)
  }

  /** 新成员是否可见最近聊天记录。 */
  setGroupNewMemberHistoryVisibility(socket, groupId, visible) {
    return this.#call(socket, 'set_group_new_member_history_visibility', { group_id: String(groupId), visible: visible === true })
  }

  /**
   * 设置 / 取消群管理员。
   *
   * ⚠️ 真机探针（v0.5.8）：`enable` **省略时 NapCat 按 false 处理**（`!!undefined === false`），
   * 也就是"少传一个字段"会静默把人**撤**成普通成员。所以这里永远显式传布尔值，
   * 绝不做成"可选参数"。
   */
  setGroupAdmin(socket, groupId, userId, enable) {
    return this.#call(socket, 'set_group_admin', {
      group_id: String(groupId),
      user_id: String(userId),
      enable: enable === true,
    })
  }

  /**
   * 群成员邀请策略（探针：policy 只接受四个字面量）。
   * 取值：disabled / require_approval / no_approval / no_approval_under_100。
   */
  setGroupMemberInvitePolicy(socket, groupId, policy) {
    return this.#call(socket, 'set_group_member_invite_policy', { group_id: String(groupId), policy: String(policy) })
  }

  /**
   * 群加群方式（add_type 是 QQ 的裸数字，NapCat 官方 schema 只写「加群方式: number」、
   * 没有枚举；探针确认只有 4/5 会连问题/答案一起写：4 带答案、5 只写问题）。
   * 因此问题/答案只在 4/5 时随请求发出，其它取值绝不夹带（否则等于往群设置里写脏字段）。
   */
  setGroupAddOption(socket, groupId, addType, { question = '', answer = '' } = {}) {
    const type = Number(addType)
    const params = { group_id: String(groupId), add_type: type }
    if (type === 4 || type === 5) {
      params.group_question = String(question ?? '')
      params.group_answer = type === 4 ? String(answer ?? '') : ''
    }
    return this.#call(socket, 'set_group_add_option', params)
  }

  /** 群打卡名册（探针：{ group_id } → [{ user_id, nick, time, rank }]，rank 可能是小数）。 */
  getGroupSignedList(socket, groupId) {
    return this.#call(socket, 'get_group_signed_list', { group_id: String(groupId) })
  }

  /**
   * 群系统消息（入群申请 / 被邀请）。探针：`count` 非可选但有 default=50，
   * 返回 `{ invited_requests, InvitedRequest, join_requests }`——后两者是**同一个数组引用**。
   * 元素里的 `request_id` 就是 `set_group_add_request` 要比对的 `flag`（探针：
   * `find(i => i.seq === flag)`，而 `request_id: +i.seq`）。
   */
  getGroupSystemMsg(socket, count = 50) {
    return this.#call(socket, 'get_group_system_msg', { count: Number(count) || 50 })
  }

  /** 可疑好友申请列表（探针：实际字段是 flag(uid) / uin / nick / msg / group_code / time）。 */
  getDoubtFriendsAddRequest(socket, count = 50) {
    return this.#call(socket, 'get_doubt_friends_add_request', { count: Number(count) || 50 })
  }

  /**
   * 处理可疑好友申请。
   * ⚠️ 真机探针：NapCat 的 handler **完全忽略 `approve`**（源码注释「该字段没有语义 仅做保留
   * 强制为True」）——也就是这条路**只能同意**，传 false 也一样放行。所以这里不提供拒绝参数，
   * 调用方必须在文案里说清楚。
   */
  setDoubtFriendsAddRequest(socket, flag) {
    return this.#call(socket, 'set_doubt_friends_add_request', { flag: String(flag) })
  }

  /** 移动群文件（探针：需要 file_id + 当前父目录 + 目标父目录）。 */
  moveGroupFile(socket, groupId, fileId, currentParent, targetParent) {
    return this.#call(socket, 'move_group_file', {
      group_id: String(groupId),
      file_id: String(fileId),
      current_parent_directory: String(currentParent ?? ''),
      target_parent_directory: String(targetParent),
    })
  }

  /** 重命名群文件。 */
  renameGroupFile(socket, groupId, fileId, currentParent, newName) {
    return this.#call(socket, 'rename_group_file', {
      group_id: String(groupId),
      file_id: String(fileId),
      current_parent_directory: String(currentParent ?? ''),
      new_name: String(newName),
    })
  }

  /** 删除群文件。 */
  deleteGroupFile(socket, groupId, fileId) {
    return this.#call(socket, 'delete_group_file', { group_id: String(groupId), file_id: String(fileId) })
  }

  /** 新建群文件目录（兼容字段 folder_name / name 二选一，这里用 folder_name）。 */
  createGroupFileFolder(socket, groupId, folderName) {
    return this.#call(socket, 'create_group_file_folder', { group_id: String(groupId), folder_name: String(folderName) })
  }

  /** 上传图片到群相册（探针确认 action 名是 upload_image_to_qun_album）。 */
  uploadImageToQunAlbum(socket, groupId, albumId, albumName, file) {
    return this.#call(socket, 'upload_image_to_qun_album', {
      group_id: String(groupId),
      album_id: String(albumId),
      album_name: String(albumName ?? ''),
      file: String(file),
    })
  }

  /** Approve/reject a group join (or invite) request. */
  setGroupAddRequest(socket, flag, subType, approve, reason = '') {
    return this.#call(socket, 'set_group_add_request', {
      flag, sub_type: subType === 'invite' ? 'invite' : 'add', approve: Boolean(approve), reason: String(reason ?? ''),
    })
  }

  /** Approve/reject a friend request. */
  setFriendAddRequest(socket, flag, approve, remark = '') {
    return this.#call(socket, 'set_friend_add_request', { flag, approve: Boolean(approve), remark: String(remark ?? '') })
  }

  /** Send a local file into a group / private chat. */
  uploadFile(socket, messageType, targetId, file, name = '', folder = '') {
    const action = messageType === 'group' ? 'upload_group_file' : 'upload_private_file'
    const params = { file, name: name || undefined }
    if (messageType === 'group') {
      params.group_id = targetId
      if (folder) params.folder = folder
    } else {
      params.user_id = targetId
    }
    return this.#call(socket, action, params)
  }

  /** Send a merged-forward ("chat record") card built from node segments. */
  sendForwardMsg(socket, messageType, targetId, nodes) {
    if (messageType === 'group') {
      return this.#call(socket, 'send_group_forward_msg', { group_id: targetId, messages: nodes })
    }
    return this.#call(socket, 'send_private_forward_msg', { user_id: targetId, messages: nodes })
  }

  // ---- read-only actions ----

  /** Fetch a merged-forward message's node list (used to expand recalled cards). */
  getForwardMsg(socket, id) {
    return this.#call(socket, 'get_forward_msg', { message_id: String(id), id: String(id) })
  }

  /** Full group member list (single call is expensive — cache on the caller side). */
  getGroupMemberList(socket, groupId, noCache = false) {
    return this.#call(socket, 'get_group_member_list', { group_id: groupId, no_cache: Boolean(noCache) })
  }

  getGroupMemberInfo(socket, groupId, userId, noCache = true) {
    return this.#call(socket, 'get_group_member_info', { group_id: groupId, user_id: userId, no_cache: Boolean(noCache) })
  }

  /** 机器人自己的登录信息（读）：`{ user_id, nickname }`——用来认"文本 @机器人名"。 */
  getLoginInfo(socket) {
    return this.#call(socket, 'get_login_info', {})
  }

  getGroupInfo(socket, groupId, noCache = true) {
    return this.#call(socket, 'get_group_info', { group_id: groupId, no_cache: Boolean(noCache) })
  }

  getFriendList(socket) {
    return this.#call(socket, 'get_friend_list', {})
  }

  getGroupHonorInfo(socket, groupId, type = 'all') {
    return this.#call(socket, 'get_group_honor_info', { group_id: groupId, type })
  }

  getGroupNotice(socket, groupId) {
    return this.#call(socket, '_get_group_notice', { group_id: groupId })
  }

  getEssenceMsgList(socket, groupId) {
    return this.#call(socket, 'get_essence_msg_list', { group_id: groupId })
  }

  /** Recent history of a group (used for stats backfill / recall recovery). */
  getGroupMsgHistory(socket, groupId, messageSeq = 0, count = 20) {
    return this.#call(socket, 'get_group_msg_history', { group_id: groupId, message_seq: messageSeq, count })
  }

  /** Fetch recent messages of a private chat (NapCat extension; read-only). */
  getFriendMsgHistory(socket, userId, messageSeq = 0, count = 20) {
    return this.#call(socket, 'get_friend_msg_history', { user_id: Number(userId), message_seq: Number(messageSeq) || 0, count: Number(count) || 20 })
  }

  /** Group file list of the root folder (read-only). */
  getGroupRootFiles(socket, groupId) {
    return this.#call(socket, 'get_group_root_files', { group_id: Number(groupId) })
  }

  /** Group file list of one folder (read-only). */
  getGroupFilesByFolder(socket, groupId, folderId) {
    return this.#call(socket, 'get_group_files_by_folder', { group_id: Number(groupId), folder_id: String(folderId ?? '') })
  }

  /** Temporary download URL of one group file (read-only). */
  getGroupFileUrl(socket, groupId, fileId, busid = 0) {
    return this.#call(socket, 'get_group_file_url', { group_id: Number(groupId), file_id: String(fileId ?? ''), busid: Number(busid) || 0 })
  }

  /** OCR an image the bot can already read (NapCat extension; read-only). */
  ocrImage(socket, image) {
    return this.#call(socket, 'ocr_image', { image: String(image ?? '') })
  }

  /** Group album list (NapCat extension; read-only). */
  getQunAlbumList(socket, groupId) {
    return this.#call(socket, 'get_qun_album_list', { group_id: Number(groupId) })
  }

  getVersionInfo(socket) {
    return this.#call(socket, 'get_version_info', {})
  }

  getStatus(socket) {
    return this.#call(socket, 'get_status', {})
  }

  /**
   * 发 QQ 空间说说（NapCat 扩展 action：send_qzone_msg）。
   * 返回 { tid }（删除用 delete_qzone_msg）。
   * ugc_right=1 = 全部好友可见（主人 2026-10-28 拍板：她是个活人，不是只有你能看）。
   * 走 #call ⇒ 自动吃 dry-run 拦截（注入窗口/离线回放绝不会真发）。
   */
  sendQzoneMsg(socket, content, images = []) {
    return this.#call(socket, 'send_qzone_msg', { content, images, ugc_right: 1 })
  }

  /**
   * 出站发送的最小间隔（2026-11-01）。
   *
   * 为什么要：她的回复天然是多段（短句为主），一次回合可能连发 3–4 条；
   * 主动通道的"说说"、管理回执、转发卡片又可能同时到达。
   * 对 QQ 服务端来说那是一串**紧挨着的**写操作 —— 成熟桥一致把它当成风控诱因，
   * 普遍做法是给写操作之间塞一个固定间隔（`sendIntervalMs`，0 = 不限）。
   *
   * 只闸**发消息**，不闸查询：查询不触发风控，给它加延迟只会让界面变钝。
   * 串行化用一条 Promise 链：并发发送同时进来时，只按链上的顺序依次放行，
   * 否则"同时算间隔"等于没算（两个并发各自看到 lastSendAt 是同一个旧值）。
   */
  #sendChain = Promise.resolve()
  #lastSendAt = 0

  #throttleSend() {
    // 这里不写 `this.config?.x`：static-unit 用 `config\.<键>` 扫"配了不生效的死键"，
    // 可选链会让它扫不到，于是这条配置被误报成死键。同文件其它地方也一律直接取属性。
    const gap = Number(this.config.sendIntervalMs ?? 0)
    if (!Number.isFinite(gap) || gap <= 0) return Promise.resolve()
    this.#sendChain = this.#sendChain.then(async () => {
      const wait = this.#lastSendAt + gap - Date.now()
      if (wait > 0) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, wait)
          if (typeof timer.unref === 'function') timer.unref()
        })
      }
      this.#lastSendAt = Date.now()
    }).catch(() => {})
    return this.#sendChain
  }

  async #call(socket, action, params) {
    // 调试用 dry-run：只记录，不发送（注入器与离线回放走这条路，绝不会有 QQ 副作用）。
    // 带 scope 时只拦该会话的调用——注入窗口不能连坐其它会话里真人的回复。
    if (this.#inDryRunScope(params)) {
      this.dryRunCalls.push({ action, params, at: Date.now() })
      return Promise.resolve({ message_id: `dry-${this.dryRunCalls.length}`, dryRun: true })
    }
    // 只对"往聊天里写东西"的 action 限速（见 #throttleSend 的注释）。dry-run 已经提前返回，不受影响。
    if (OUTBOUND_MESSAGE_ACTIONS.has(action)) await this.#throttleSend()
    const echo = `qq-${++this.#echo}`
    const frame = JSON.stringify({ action, params, echo })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(echo)
        reject(new Error(`OneBot action ${action} timed out`))
      }, ACTION_TIMEOUT_MS)
      this.#pending.set(echo, (response) => {
        clearTimeout(timer)
        if (response && response.status === 'ok' && response.retcode === 0) resolve(response.data)
        else reject(new Error(`OneBot action ${action} failed: ${JSON.stringify(response)}`))
      })
      if (socket.readyState === socket.OPEN) socket.send(frame)
      else {
        clearTimeout(timer)
        this.#pending.delete(echo)
        console.error(`[qq-bridge] OneBot send failed: action=${action} readyState=${socket.readyState}`)
        reject(new Error('OneBot connection closed'))
      }
    })
  }
}

function extractBearer(request) {
  const header = request.headers && request.headers.authorization
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim()
  return ''
}
