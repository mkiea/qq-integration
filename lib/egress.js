/**
 * egress.js —— 出网域名白名单（2026-10-29）
 *
 * 主人：「域名的话防止点陌生链接泄露我IP」。
 *
 * 风险不是"她点开一个链接"，而是**代码替她抓**：QQ 消息里的图片/语音/文件的 url 字段
 * 都是外部输入，一句注入就能让它指向任意主机 —— 那一抓就把本机出口 IP 送出去了
 * （更糟的是 `169.254.169.254` 这种云元数据地址，能直接换出临时凭据）。
 *
 * 做法（业界口径：egress allowlist，agentmelt 2026 把它列为 ROI 最高的一条）：
 *   · 默认只放行 QQ 自己的媒体域名 + 本机回环；
 *   · 目标 host 是 **IP 字面量**时一律拒（除非明确列在名单里，用来放行 127.0.0.1 的本地服务）；
 *   · 其它域名要显式加 `egressAllowHosts` 才放行；
 *   · 拒绝是**抛出带原因的错误**，不是静默返回空 —— 否则又变成"没抓到但不报错"。
 *
 * 覆盖范围：桥自己发出的抓取（图片/语音/文件转存）。她若通过宿主自带工具出网，
 * 不经过这里 —— 那一层归宿主，别在这里假装防住了。
 */

/** QQ 媒体/CDN + 本机回环。**按后缀匹配**，所以 `a.qpic.cn` 也算命中。 */
export const DEFAULT_EGRESS_SUFFIXES = [
  'qpic.cn',
  'qq.com',
  // ⚠️ 下面这条不能省：QQ 的图片/文件真实地址是
  //   https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=...
  // 而 `qq.com` **不匹配** `qq.com.cn`（后缀匹配不会跨过 `.cn`）。
  // 少了它，重启后所有图片消息都会抓不下来 —— 而且不报错，只是"她好像看不见图"。
  'qq.com.cn',
  'gtimg.cn',
  'qlogo.cn',
  'idqqimg.com',
  'myqcloud.com',
  'localhost',
  '127.0.0.1',
  '::1',
]

let EXTRA = []

/** 由 bridge 在启动时把 config.egressAllowHosts 注进来（模块级，因为 downloadTo 是自由函数）。 */
export function setEgressExtras(list) {
  EXTRA = Array.isArray(list) ? list.map((s) => String(s ?? '').trim().toLowerCase()).filter(Boolean) : []
}

function hostList(extra) {
  const merged = [...DEFAULT_EGRESS_SUFFIXES, ...EXTRA, ...(Array.isArray(extra) ? extra : [])]
  return [...new Set(merged.map((s) => String(s ?? '').trim().toLowerCase()).filter(Boolean))]
}

/**
 * 判断这个 URL 能不能由我们主动抓。
 * @returns {{ ok: boolean, host: string, reason: string }}
 */
export function egressVerdict(rawUrl, options = {}) {
  let parsed
  try {
    parsed = new URL(String(rawUrl ?? ''))
  } catch {
    return { ok: false, host: '', reason: '不是合法 URL' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, host: parsed.hostname, reason: `只允许 http(s)，收到 ${parsed.protocol}` }
  }
  // 尾点是合法 FQDN 写法（`qq.com.` 与 `qq.com` 是同一台主机）：
  // 不剥掉就会**误拒** QQ 自己返回的带点地址；剥掉之后 `evil.com.` 仍然匹配不到白名单，
  // 所以剥尾点只放宽了合法情况，没有放宽攻击面。
  const host = String(parsed.hostname ?? '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.+$/, '')
  const list = hostList(options.extra)

  // IP 字面量（含十进制/十六进制写法、IPv6）单独处理：默认一律拒，只放行名单里明确列出的
  const looksIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
    || /^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,}$/i.test(host)
    || /^\d+$/.test(host)
    || /^0x[0-9a-f]+$/i.test(host)
  if (looksIp) {
    if (list.includes(host)) return { ok: true, host, reason: '本机回环（白名单显式放行）' }
    return { ok: false, host, reason: '目标是 IP 字面量：内网 / 云元数据地址不作为出网目标（防 SSRF）' }
  }

  const hit = list.find((suffix) => host === suffix || host.endsWith(`.${suffix}`))
  if (hit) return { ok: true, host, reason: `白名单命中：${hit}` }
  return {
    ok: false,
    host,
    reason: `域名 ${host} 不在出网白名单（防止陌生链接把本机 IP 送出去；要放开就把它加进 egressAllowHosts）`,
  }
}

/** 不合格就抛错（调用方不用自己写 if）。 */
export function assertEgress(rawUrl, options = {}) {
  const verdict = egressVerdict(rawUrl, options)
  if (!verdict.ok) throw new Error(`出网被拒：${verdict.reason}`)
  return verdict
}
