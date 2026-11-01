/**
 * bilibili.js —— "刷 B 站"的基础能力（2026-11-01）
 *
 * 两个入口：
 *   · `fetchPopular` —— 热门榜（`x/web-interface/popular`，**匿名可用**，实测 code:0）
 *   · `searchBilibili` —— 搜索。**不能直接调搜索接口**：`x/web-interface/search/type`
 *     匿名请求现在返回的是**HTML 风控页**而不是 JSON（2026-11-01 实测），
 *     要过就得做 wbi 签名（B 站 2023 起）或带登录 cookie。
 *     所以这里借 yt-dlp 的 `bilisearch` 拿 id（它自己处理签名），再用 **详情接口**补标题 —— 
 *     详情接口 `x/web-interface/view` 匿名可用（实测 code:0）。
 *
 * 边界：只读公开数据，不登录、不点赞、不投币、不发弹幕。要"刷"到能互动是另一个量级的事情
 * （要 cookie、要风控对抗），不在这一层的范围里。
 */
import { fetchGuarded } from './egress.js'
import { resolveYtDlp } from './videofetch.js'

/** B 站接口需要的 Referer/UA —— 不带会被当成爬虫（实测不带 Referer 直接给 HTML 风控页）。 */
const BILI_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  referer: 'https://www.bilibili.com/',
}

const HOSTS = ['bilibili.com', 'hdslb.com']

/** 调一个返回 `{code, data}` 的 B 站接口，code ≠ 0 时抛错（带 code 与 message，便于定位）。 */
async function biliJson(url, { timeoutMs = 15_000 } = {}) {
  const { buffer, contentType } = await fetchGuarded(url, {
    headers: BILI_HEADERS,
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
  if (parsed?.code !== 0) throw new Error(`B 站接口 code=${parsed?.code} ${parsed?.message ?? ''}`.trim())
  return parsed.data
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
 * 搜视频。
 *
 * 走 yt-dlp 的 `bilisearch` 拿 aid（它处理 wbi 签名），再用详情接口补标题/UP/时长/播放。
 * 详情接口一次一个，所以 limit 默认给 5 —— 再多就变成一串串行请求，用户等不起。
 */
export async function searchBilibili(keyword, { limit = 5, timeoutMs = 20_000, ytDlp = null } = {}) {
  const query = String(keyword ?? '').trim()
  if (query === '') throw new Error('关键词为空')
  const size = Math.min(10, Math.max(1, Number(limit) || 5))
  const runner = ytDlp ?? await resolveYtDlp({})
  if (runner === null) throw new Error('搜索需要 yt-dlp（匿名搜索接口已被 B 站风控）；配 ytDlpPath 或 ytDlpPython')

  const args = [
    ...runner.prefix,
    '--no-warnings', '--flat-playlist',
    '--print', '%(url)s',
    // 官方支持的搜索前缀：bilisearchN:关键词
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
