/**
 * bilibili.js —— "刷 B 站"的基础能力（2026-11-01）
 *
 * 两个入口：
 *   · `fetchPopular` —— 热门榜（`x/web-interface/popular`，**匿名可用**，实测 code:0）
 *   · `searchBilibili` —— 搜索。**匿名直连搜索接口会拿到 HTML 风控页**（2026-11-01 实测），
 *     所以要过三道门（2026-11-01 查过 B 站社区与几个开源实现的通行做法）：
 *
 *   ① **WBI 签名**（B 站 2023 起）。`wts` 时间戳 + 按 key 排序的查询串 + `mixin_key` 求 MD5
 *      得 `w_rid`。`mixin_key` 由 `/x/web-interface/nav` 里的 `wbi_img.img_url/sub_url`
 *      两个 32 位串按 64 位表重排、截前 32 位得到；密钥每日轮换，缓存 6 小时。
 *   ② **访客身份 Cookie**。B 站搜索 WAF 要求带 `buvid3`；`/x/frontend/finger/spi`
 *      能匿名换到 `b_3/b_4`，不需要任何登录凭据。
 *   ③ **像搜索页的 Referer**。走 `https://search.bilibili.com/all?keyword=…`，
 *      而不是首页 —— 只带 `www.bilibili.com` 仍会被拦。
 *
 *   签名路径失败时自动降级到 yt-dlp 的 `bilisearch`（它自己处理签名），
 *   再用详情接口补字段 —— 也就是改这一版之前的唯一路径，保留作兜底。
 *
 * 边界：只读公开数据，不登录、不点赞、不投币、不发弹幕。要"刷"到能互动是另一个量级的事情
 * （要 cookie、要风控对抗），不在这一层的范围里。
 */
import { createHash } from 'node:crypto'

import { fetchGuarded } from './egress.js'
import { resolveYtDlp } from './videofetch.js'

/** B 站接口需要的 Referer/UA —— 不带会被当成爬虫（实测不带 Referer 直接给 HTML 风控页）。 */
const BILI_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  referer: 'https://www.bilibili.com/',
}

const HOSTS = ['bilibili.com', 'hdslb.com']

/**
 * WBI 的 64 位重排表。全站固定的常量（`bilibili-API-collect` 的 `misc/sign/wbi.md`），
 * 不是每天变的 —— 每天变的是 `img_key`/`sub_key` 这对原料。
 */
const MIXIN_KEY_ENC_TAB = Object.freeze([
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
])

/** WBI 密钥的有效期。官方每日轮换，缓存 6 小时是社区通行值（不必每次请求都换）。 */
const WBI_TTL_MS = 6 * 60 * 60_000

/** 把 64 位原料按表重排、截前 32 位 —— 这就是 mixin_key。 */
export function getMixinKey(imgKey, subKey) {
  const raw = `${String(imgKey ?? '')}${String(subKey ?? '')}`
  let out = ''
  for (const index of MIXIN_KEY_ENC_TAB) {
    if (index >= raw.length) continue
    out += raw[index]
  }
  return out.slice(0, 32)
}

/**
 * 生成带 `w_rid` / `wts` 的查询串。**纯函数**（`now` 可注入）⇒ 可以用官方文档里的
 * 校验向量做单测，不必联网。
 *
 * 三个容易写错的地方，逐条对上官方说明：
 *   · 参数要**按键名排序**再拼；
 *   · 值里 `!'()*` 这几个字符要**剔除**（不是转义）；
 *   · `wts` 参与签名，且必须是**秒**级时间戳。
 *
 * @param {Record<string, string|number>} params
 * @param {string} imgKey
 * @param {string} subKey
 * @param {number} [now] 毫秒时间戳（默认取当前时间，单测用固定值）
 * @returns {string} 形如 `a=1&wts=…&w_rid=…`
 */
export function encWbi(params, imgKey, subKey, now = Date.now()) {
  const mixinKey = getMixinKey(imgKey, subKey)
  if (mixinKey.length !== 32) throw new Error('WBI 密钥长度不对（nav 接口返回的 img_key/sub_key 可能变了）')
  const wts = Math.round(now / 1000)
  const merged = { ...params, wts }
  const query = Object.keys(merged)
    .sort()
    .map((key) => {
      // `!'()*` 在 B 站的签名规范里是**过滤**而不是百分号编码，漏掉这一步签名对不上
      const value = String(merged[key] ?? '').replace(/[!'()*]/g, '')
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    })
    .join('&')
  const wRid = createHash('md5').update(`${query}${mixinKey}`).digest('hex')
  return `${query}&w_rid=${wRid}`
}

/** 调一个返回 `{code, data}` 的 B 站接口；`code ≠ 0` 时抛错（带 code 与 message，便于定位）。 */
async function biliJson(url, { timeoutMs = 15_000, headers = BILI_HEADERS, allowNonZero = false } = {}) {
  const { buffer, contentType } = await fetchGuarded(url, {
    headers,
    extra: HOSTS,
    maxBytes: 2 * 1024 * 1024,
    timeoutMs,
  })
  const body = buffer.toString('utf8')
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    // 风控页是 HTML —— 这时最有用的一句话是"被风控了"，而不是 "Unexpected token <"
    throw new Error(`B 站返回的不是 JSON（多半被风控）：${contentType || '无 content-type'}，开头 ${body.slice(0, 40)}`)
  }
  if (parsed?.code !== 0 && !allowNonZero) {
    throw new Error(`B 站接口 code=${parsed?.code} ${parsed?.message ?? ''}`.trim())
  }
  return allowNonZero ? parsed : parsed.data
}

/** 缓存：`img_key`/`sub_key` 与访客 cookie 都用同一条 TTL。 */
const wbiCache = { at: 0, imgKey: '', subKey: '' }
/**
 * 同一时刻只允许一次 nav 在飞（**在途去重**）。
 *
 * ★ 2026-11-01 深夜加的，原因是这个 TTL 缓存有个洞：缓存只存"已完成的"，不存
 * "正在进行的"。`cardlook.js` 的字幕与 AI 总结现在**并行**发出去，两个都要密钥，
 * 于是冷启动时会各打一次 nav —— 在"收到消息 → 她开口"之间白花 300ms。
 * 缺陷形状与纪律"能检测 ≠ 已检测"同族：缓存命中率看着 100%，并发首帧就是漏的。
 */
let wbiPending = null
const buvidCache = { at: 0, cookie: '' }

/**
 * 拿 WBI 密钥。
 *
 * ⚠️ `nav` 在未登录时 `code` 是 **-101**，但 `data.wbi_img` 照样有值 ——
 * 所以这里必须 `allowNonZero`，否则会把"没登录"当成"拿不到密钥"而白白降级。
 *
 * ★ 2026-11-01 深夜导出：`cardlook.js` 的 AI 总结（`view/conclusion/get`）也要签名。
 * **不另写一份** —— 密钥有缓存（`wbiCache`），写两份就会有两份缓存、两套 TTL，
 * 而"两份实现里第二份必然漏"是本项目踩过两次的坑。
 */
export async function getWbiKeys(timeoutMs = 15_000) {
  if (wbiCache.imgKey !== '' && Date.now() - wbiCache.at < WBI_TTL_MS) return wbiCache
  if (wbiPending !== null) return wbiPending
  wbiPending = (async () => {
    const raw = await biliJson('https://api.bilibili.com/x/web-interface/nav', { timeoutMs, allowNonZero: true })
    const imgUrl = String(raw?.data?.wbi_img?.img_url ?? '')
    const subUrl = String(raw?.data?.wbi_img?.sub_url ?? '')
    const pick = (url) => (/([0-9a-f]{32})\.png/i.exec(url)?.[1] ?? '')
    const imgKey = pick(imgUrl)
    const subKey = pick(subUrl)
    if (imgKey === '' || subKey === '') throw new Error('nav 接口没给出 wbi_img（B 站接口可能又改了）')
    wbiCache.at = Date.now()
    wbiCache.imgKey = imgKey
    wbiCache.subKey = subKey
    return wbiCache
  })()
  try {
    return await wbiPending
  } finally {
    // 无论成败都要放开，否则一次失败会把密钥永久锁死（后面所有调用都拿到同一个 rejected）
    wbiPending = null
  }
}

/**
 * 拿访客身份 cookie（`buvid3`/`buvid4`）。
 *
 * 这是搜索能不能过的**第二道门**：B 站搜索 WAF 会检查 cookie 里有没有 `buvid3`，
 * 光有签名没有它，照样 412。`/x/frontend/finger/spi` 匿名就能换，不需要登录。
 * 拿不到也不算致命（有些时段不带也能过），所以失败只返回空串。
 */
async function getBuvidCookie(timeoutMs = 10_000) {
  if (buvidCache.cookie !== '' && Date.now() - buvidCache.at < WBI_TTL_MS) return buvidCache.cookie
  try {
    const data = await biliJson('https://api.bilibili.com/x/frontend/finger/spi', { timeoutMs })
    const b3 = String(data?.b_3 ?? '').trim()
    const b4 = String(data?.b_4 ?? '').trim()
    if (b3 === '') return ''
    buvidCache.at = Date.now()
    buvidCache.cookie = `buvid3=${b3}${b4 === '' ? '' : `; buvid4=${b4}`}`
    return buvidCache.cookie
  } catch {
    return ''
  }
}

/** 搜索返回的 `duration` 是 `"3:32"` / `"1:02:03"`，而详情接口给的是秒数 —— 统一成秒。 */
export function parseDurationText(text) {
  const parts = String(text ?? '').trim().split(':').map((n) => Number(n) || 0)
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n))) return 0
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

/** 搜索结果的标题带 `<em class="keyword">` 高亮标签，要剥掉；顺便解 HTML 实体。 */
export function cleanSearchTitle(title) {
  return String(title ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
}

/**
 * 把搜索接口的一条结果**整形**成与 `view` 接口一致的结构。
 * 抽成纯函数是为了能单测（真实响应里字段名与详情接口不同：`author` vs `owner.name`）。
 */
export function normalizeSearchItem(item) {
  const bvid = String(item?.bvid ?? '').trim()
  const aid = Number(item?.aid) || Number(item?.id) || 0
  return {
    bvid,
    aid,
    title: cleanSearchTitle(item?.title),
    owner: { name: String(item?.author ?? '').trim() },
    duration: parseDurationText(item?.duration),
    stat: { view: Number(item?.play) || 0 },
    pubdate: Number(item?.pubdate) || 0,
    desc: String(item?.description ?? '').trim(),
  }
}

/**
 * 走 wbi 签名的搜索。失败（含 412）会抛，由调用方决定是否降级。
 *
 * @param {string} userCookie 可选的登录态 Cookie（`SESSDATA=…`）。**不做模块级状态**，
 *   免得"配了 B 站号"这件事变成隐式全局副作用 —— 由调用方从配置里读、逐次传进来。
 */
async function searchViaWbi(query, size, timeoutMs, userCookie = '') {
  const keys = await getWbiKeys(timeoutMs)
  const params = {
    search_type: 'video',
    keyword: query,
    page: 1,
    page_size: Math.min(50, Math.max(1, size)),
  }
  const signed = encWbi(params, keys.imgKey, keys.subKey)
  const url = `https://api.bilibili.com/x/web-interface/wbi/search/type?${signed}`
  // ③ 第三道门：Referer 要像"从搜索页点进来的"，首页 Referer 仍会被拦
  const headers = {
    ...BILI_HEADERS,
    referer: `https://search.bilibili.com/all?keyword=${encodeURIComponent(query)}`,
  }
  // 有登录 cookie 就用登录身份（自带 buvid3 时不再叠访客身份，免得两套身份打架）
  const cookieParts = []
  if (userCookie !== '') cookieParts.push(userCookie)
  if (!/buvid3=/i.test(userCookie)) {
    const buvid = await getBuvidCookie(timeoutMs)
    if (buvid !== '') cookieParts.push(buvid)
  }
  if (cookieParts.length > 0) headers.cookie = cookieParts.join('; ')
  const data = await biliJson(url, { timeoutMs, headers })
  const list = Array.isArray(data?.result) ? data.result : []
  return list.map(normalizeSearchItem).filter((item) => item.bvid !== '' || item.aid > 0).slice(0, size)
}

/** 把秒数说成人话（`212` → `3分32秒`）。 */
export function humanDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  if (total < 60) return `${total}秒`
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m < 60) return s === 0 ? `${m}分` : `${m}分${s}秒`
  const h = Math.floor(m / 60)
  return `${h}小时${m % 60}分`
}

/** 播放量说成人话（`12345` → `1.2万`）。 */
export function humanCount(value) {
  const n = Number(value) || 0
  if (n < 10_000) return String(n)
  if (n < 100_000_000) return `${(n / 10_000).toFixed(1)}万`
  return `${(n / 100_000_000).toFixed(1)}亿`
}

/**
 * 一条视频 → 一行文字。**纯函数**，单独抽出来是为了能单测格式（不联网）。
 * @param {{bvid?: string, aid?: number, title?: string, owner?: {name?: string}, duration?: number, stat?: {view?: number}}} item
 */
export function formatVideoLine(item) {
  const title = String(item?.title ?? '').trim() || '(无标题)'
  const up = String(item?.owner?.name ?? '').trim()
  const bvid = String(item?.bvid ?? '').trim()
  const parts = [title]
  if (up !== '') parts.push(`UP：${up}`)
  const duration = Number(item?.duration)
  if (Number.isFinite(duration) && duration > 0) parts.push(humanDuration(duration))
  const view = Number(item?.stat?.view)
  if (Number.isFinite(view) && view > 0) parts.push(`${humanCount(view)}播放`)
  if (bvid !== '') parts.push(bvid)
  return parts.join(' | ')
}

/** 热门榜。 */
export async function fetchPopular({ limit = 8, timeoutMs = 15_000 } = {}) {
  const size = Math.min(20, Math.max(1, Number(limit) || 8))
  const data = await biliJson(`https://api.bilibili.com/x/web-interface/popular?ps=${size}&pn=1`, { timeoutMs })
  const list = Array.isArray(data?.list) ? data.list : []
  return list.slice(0, size)
}

/**
 * yt-dlp 兜底：`bilisearchN:关键词` 拿 aid（它自己处理签名），再用详情接口补字段。
 * 详情接口一次一个 ⇒ 串行请求，limit 大了会很慢，所以只在签名路径失败时走。
 */
async function searchViaYtDlp(query, size, timeoutMs, ytDlp) {
  const runner = ytDlp ?? await resolveYtDlp({})
  if (runner === null) return []
  const args = [
    ...runner.prefix,
    '--no-warnings', '--flat-playlist',
    '--print', '%(url)s',
    `bilisearch${size}:${query}`,
  ]
  const { stdout } = await new Promise((resolve) => {
    import('node:child_process').then(({ execFile }) => {
      execFile(runner.command, args, { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }, (_err, out) => {
        resolve({ stdout: String(out ?? '') })
      })
    })
  })
  const ids = stdout.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /bilibili\.com\/video\//.test(line))
    .map((line) => (/\/av(\d+)/.exec(line)?.[1] ?? ''))
    .filter(Boolean)
  if (ids.length === 0) return []

  const items = []
  for (const aid of ids.slice(0, size)) {
    try {
      items.push(await biliJson(`https://api.bilibili.com/x/web-interface/view?aid=${aid}`, { timeoutMs: 8000 }))
    } catch { /* 单条取不到就跳过，不要因为一个视频挂掉整次搜索 */ }
  }
  return items
}

/**
 * 搜视频。**先走 wbi 签名直连，失败再降级 yt-dlp**。
 *
 * 顺序不能反：签名路径一次请求就拿到标题/UP/时长/播放（字段齐、快），
 * 而 yt-dlp 那条要 N+1 次请求（每个 aid 再查一次详情），慢一个数量级。
 *
 * @param {string} keyword
 * @param {{ limit?: number, timeoutMs?: number, ytDlp?: object|null, cookie?: string }} [options]
 *   `cookie` 是可选的 B 站登录态（配了 `biliCookie` 才有）。留空就用匿名访客身份。
 */
export async function searchBilibili(keyword, { limit = 5, timeoutMs = 20_000, ytDlp = null, cookie = '' } = {}) {
  const query = String(keyword ?? '').trim()
  if (query === '') throw new Error('关键词为空')
  const size = Math.min(10, Math.max(1, Number(limit) || 5))

  let wbiError = null
  try {
    const items = await searchViaWbi(query, size, timeoutMs, cookie)
    if (items.length > 0) return items
  } catch (error) {
    // 412 / HTML 风控页 / 密钥变了都走这里 —— 不直接冒泡，因为还有 yt-dlp 这条路
    wbiError = error
  }

  const fallback = await searchViaYtDlp(query, size, timeoutMs, ytDlp)
  if (fallback.length > 0) return fallback
  if (wbiError) throw new Error(`B 站搜索失败（签名直连与 yt-dlp 都没成）：${String(wbiError.message).slice(0, 100)}`)
  return []
}
