/**
 * webtext.js —— 把网页 HTML 变成她能读的纯文本（2026-11-01）
 *
 * 为什么要自己做一层：QQ 卡片里那条链接（B 站/抖音/微博/公众号…）本身就是**外部输入**，
 * 而她需要知道"这链接里写了什么"才能听懂梗。dsh 自带的 web 工具是给桌面端场景的，
 * QQ 侧要复用同一套出网白名单（`lib/egress.js` 的 `fetchGuarded`），所以抓取与瘦身都在这里。
 *
 * 刻意**不做**的事：
 *   · 不解析 JS（拿到的就是首屏 HTML；SPA 站点给的文字可能很少 —— 如实返回"几乎没有正文"，
 *     不要编）；
 *   · 不保留样式/脚本/内联 JSON —— 它们占体积且对理解毫无帮助；
 *   · 不做正文抽取算法（Readability 那种）—— 一个正则清洗在本场景足够，
 *     引入打分反而会出现"这段为什么被丢"的不可解释性。
 */

/** 实体解码表。只覆盖 HTML 里高频出现的那几个，其余保持原样（宁可留 `&foo;` 也不猜错）。 */
const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
  '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–', '&hellip;': '…', '&middot;': '·',
  '&ldquo;': '“', '&rdquo;': '”', '&lsquo;': '‘', '&rsquo;': '’', '&copy;': '©',
}

/** 取 `<title>` 的内容（没有就返回空串）。 */
export function htmlTitle(html) {
  const m = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(String(html ?? ''))
  return m === null ? '' : decodeEntities(m[1]).replace(/\s+/g, ' ').trim()
}

/** 解码常见实体 + 数字实体。 */
export function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeChar(parseInt(dec, 10)))
    .replace(/&[a-z]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? entity)
}

function safeChar(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  try { return String.fromCodePoint(code) } catch { return '' }
}

/**
 * HTML → 纯文本。
 *
 * @param {string} html
 * @param {{ maxChars?: number }} options
 * @returns {{ title: string, text: string, truncated: boolean, chars: number }}
 */
export function htmlToText(html, { maxChars = 6000 } = {}) {
  const raw = String(html ?? '')
  const title = htmlTitle(raw)

  let body = raw
    // 整块丢掉：脚本、样式、内联 JSON、SVG、注释
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // 块级元素收成换行，行内标签直接去掉（否则「<b>猫</b>在跑」会变成「猫 在跑」）
    .replace(/<\s*(?:br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/\s*(?:p|div|li|tr|h[1-6]|section|article|header|footer|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')

  body = decodeEntities(body)
    // 全角空格与不换行空格统一成普通空格
    .replace(/[\u00a0\u3000]/g, ' ')
    // 压缩行内空白，但保留换行结构
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line, index, arr) => line !== '' || (index > 0 && arr[index - 1] !== ''))
    .join('\n')
    .trim()

  const truncated = body.length > maxChars
  if (truncated) body = `${body.slice(0, maxChars)}……`
  return { title, text: body, truncated, chars: body.length }
}

/** 拼成给她看的一段。**不是正文时要说清**，别让模型把空页面当"看过了"。 */
export function formatLinkReading(url, html, { maxChars = 6000 } = {}) {
  const { title, text, truncated, chars } = htmlToText(html, { maxChars })
  if (text.length < 80) {
    return {
      ok: false,
      text: `这个链接几乎取不到正文（${chars} 字${title === '' ? '' : `，标题「${title}」`}）。`
        + '可能是纯图片/视频页、需要登录、或者正文是脚本渲染出来的 —— 你**没有**读到它的内容，别假装读过。',
    }
  }
  const head = title === '' ? `链接：${url}` : `《${title}》\n链接：${url}`
  const tail = truncated ? '\n（正文过长，已截断）' : ''
  return { ok: true, text: `${head}\n\n${text}${tail}` }
}
