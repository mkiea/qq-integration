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
 *
 * `allowAnyHost`（2026-11-01 新增）：放行**任意公网域名**，只给「读用户分享的链接」用
 * （`qq_read_link`）。注意它**不动 SSRF 底线** —— IP 字面量与内网/云元数据地址
 * 在下面单独一段里先被判掉，无论开关如何都不放行。
 *
 * @returns {{ ok: boolean, host: string, reason: string }}
 */
export function egressVerdict(rawUrl, options = {}) {
  const { allowAnyHost = false } = options
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

  /**
   * ★ 读链接模式（`allowAnyHost`）**额外**拦住本机回环 —— 必须放在 IP 判断**之前**，
   * 否则 `looksIp` 那段会先按白名单把 127.0.0.1 放行，永远走不到这里。
   *
   * 为什么两个场景口径不同：回环在默认白名单里是有理由的（本地 TTS/图片服务 127.0.0.1:8977
   * 要靠它下载）；但「用户分享的链接」永远不可能是 127.0.0.1 —— 放行就等于让她能读
   * `http://127.0.0.1:8880/qqai/panel` 这类本机控制台接口，把"读网页"变成"内网探测"。
   */
  if (allowAnyHost && (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost'))) {
    return { ok: false, host, reason: 'qq_read_link 不访问本机回环（用户分享的链接不会是 127.0.0.1）' }
  }

  // IP 字面量（含十进制/十六进制写法、IPv6）单独处理：默认一律拒，只放行名单里明确列出的
  const looksIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
    || /^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,}$/i.test(host)
    || /^\d+$/.test(host)
    || /^0x[0-9a-f]+$/i.test(host)
  if (looksIp) {
    if (list.includes(host)) return { ok: true, host, reason: '本机回环（白名单显式放行）' }
    return { ok: false, host, reason: '目标是 IP 字面量：内网 / 云元数据地址不作为出网目标（防 SSRF）' }
  }

  // ★ 显式放开任意公网域名（IP 已在上一步被拦掉，这里只会是域名）
  if (allowAnyHost) return { ok: true, host, reason: '允许任意公网域名（qq_read_link 显式开启）' }

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
  if (!verdict.ok) {
    // 消息里必须带 host：`reason` 是按**类别**写的（"IP 字面量"、"域名不在白名单"），
    // 不带具体地址的话，trace 里只能看到"某次出网被拒"，看不出被拒的是
    // `169.254.169.254` 还是 `192.168.1.1`——那正是排查 SSRF 时唯一想知道的东西。
    throw new Error(`出网被拒：${verdict.host || '(没有 host)'} —— ${verdict.reason}`)
  }
  return verdict
}

function sizeText(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`
  if (n >= 1024) return `${Math.round(n / 1024)} KiB`
  return `${n} 字节`
}

/**
 * 读响应体的前 `limit` 个字节（给错误信息用）。
 *
 * 为什么不直接 `response.text()`：4xx 的 body 绝大多数是小的 JSON，但**不能假设**——
 * 一个恶意的 400 可以带 10GB 的 body，`text()` 会把它全读进内存。这里用 reader 只取
 * 一块就 `cancel()`，既拿到理由又不吃内存。
 */
async function bodyPreview(response, limit = 200) {
  try {
    const reader = response.body?.getReader()
    if (!reader) return ''
    const { value } = await reader.read()
    await reader.cancel().catch(() => {})
    if (!value) return ''
    return Buffer.from(value).subarray(0, limit).toString('utf8')
  } catch {
    return ''
  }
}

/**
 * 带守卫的下载：**每一跳**都过白名单，读到超限立刻停。
 *
 * 为什么要抽成一个函数、而不是在各调用点各改一遍：群里 `/取` 文件、入站图片/语音下载、
 * `get_file` 回退这三条路径原先各写了一遍 `fetch`，结果是**只有两条加了 assertEgress、
 * 三条全都是先 `arrayBuffer()` 再比大小**。同一个策略写三遍就必然漏一遍——这是结构问题，
 * 不是笔误。补第一处的时候如果不把另两处收进来，下次再加一条下载路径还会漏。
 *
 * 三件事在这里一次做完：
 *
 *   ① 校验不只做第一跳。`fetch` 默认 `redirect:'follow'`，一个 302 跳到 `127.0.0.1`
 *      就绕过了对初始域名的检查（SSRF 的经典走法）。这里用 `redirect:'manual'` 自己跟，
 *      **每跳都查**。
 *   ② 边读边计数，超过 `maxBytes` 立刻中止。先全读再比大小等于没有上限——一个声称
 *      10GB 的响应会先把内存吃满。这里能做到的是"不累积"：单块仍然受 TCP 缓冲限制
 *      （通常 16KB～1MB），但 10GB 那种攻击进不来。
 *   ③ 超时是**整个下载**的总时限（不是每跳重置），所以慢速灌数据（slowloris）也挡得住。
 *
 * 被拒时抛出的错误里带 host 与原因，调用方要把它写进 trace/log——不许静默跳过。
 *
 * @returns {{ buffer: Buffer, bytes: number, hops: string[], finalUrl: string, contentType: string }}
 */
export async function fetchGuarded(rawUrl, options = {}) {
  const {
    maxBytes = 50 * 1024 * 1024,
    timeoutMs = 90_000,
    maxRedirects = 5,
    extra,
    headers,
    // 只给「读用户分享的链接」用：放行任意公网域名，内网 IP 仍由 egressVerdict 拦掉
    allowAnyHost = false,
    fetchImpl = fetch,
  } = options

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('下载超时')), timeoutMs)
  const hops = []
  let current = String(rawUrl ?? '')
  try {
    for (let i = 0; i <= maxRedirects; i++) {
      // 每一跳都查（这就是"重定向绕过"的修法）。抛错里带 host，方便在 trace 里定位是哪一跳被拒。
      assertEgress(current, { extra, allowAnyHost })
      hops.push(current)
      const response = await fetchImpl(current, {
        redirect: 'manual',
        signal: controller.signal,
        // 需要自带 headers 的调用方（B 站接口要 Referer/UA）也走这里，别再自己写 fetch
        ...(headers ? { headers } : {}),
      })

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) throw new Error(`重定向 ${response.status} 但响应里没有 Location`)
        // 丢掉这一跳的 body，否则连接挂在那里等（undici 会一直占着）
        try { await response.body?.cancel() } catch { /* 已经关了 */ }
        current = new URL(location, current).toString() // 相对地址按当前跳解析成绝对
        continue
      }
      if (!response.ok) {
        /**
         * 非 2xx 要把**服务端的理由**带出来（2026-10-31 红队 K② 修）。
         *
         * 起因：`downloadTo` 原来自己读响应体，从 QQ 的 400 里抠出
         * `{"retcode":-5503010,"retmsg":"invalid rkey"}` —— 上层靠 `invalid rkey` 决定
         * 「这张图的 url 废了，去 get_image / 本地缓存另找一条路」。换成 fetchGuarded 后
         * 如果只抛 `HTTP 400`，那条回退就永远不会触发，表现为「她看不见图」且不报错。
         *
         * 所以这里把 body 前 200 字节附在错误里，格式与原 `downloadTo` 一致：
         * `HTTP 400（invalid rkey -5503010）`。
         */
        const preview = await bodyPreview(response)
        let detail = ''
        try {
          const parsed = JSON.parse(preview)
          const retmsg = String(parsed?.retmsg ?? '').trim()
          const retcode = parsed?.retcode ?? ''
          if (retmsg !== '') detail = `（${retmsg}${retcode === '' ? '' : ` ${retcode}`}）`
        } catch {
          if (preview.trim() !== '') detail = `（${preview.trim().slice(0, 60)}）`
        }
        throw new Error(`HTTP ${response.status}${detail}`)
      }

      const reader = response.body?.getReader()
      const contentType = String(response.headers.get('content-type') ?? '')
      if (!reader) return { buffer: Buffer.alloc(0), bytes: 0, hops, finalUrl: current, contentType }

      const chunks = []
      let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > maxBytes) {
          controller.abort()
          try { await reader.cancel() } catch { /* 已经关了 */ }
          throw new Error(`响应超过上限 ${sizeText(maxBytes)}：读到 ${sizeText(total)} 就中止了`)
        }
        chunks.push(value)
      }
      return { buffer: Buffer.concat(chunks, total), bytes: total, hops, finalUrl: current, contentType }
    }
    throw new Error(`重定向超过 ${maxRedirects} 次，可能是被套住了`)
  } finally {
    clearTimeout(timer)
  }
}

