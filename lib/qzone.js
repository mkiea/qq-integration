/**
 * 发 QQ 空间说说 —— 自己实现，不依赖后端的 `send_qzone_msg`（2026-11-02）。
 *
 * ## 为什么自己实现
 *
 * Waylay 没有 `send_qzone_msg`。一度以为要 packet 协议层，读了 NapCat 的实现才发现
 * **它是普通 HTTP**：先拿票据，再 POST 表单。
 *
 * ## 票据怎么来（这是唯一有技术含量的一步）
 *
 * 1. 内核 `TicketService.forceFetchClientKey("")` → `clientKey`（96 字符，1800 秒有效）。
 *    ⚠️ 这个服务**只有三个方法**（addKernelTicketListener / removeKernelTicketListener /
 *    forceFetchClientKey）—— 没有 getSKey / getPSkey，别再去猜。
 * 2. 拿 clientKey 去 `ssl.ptlogin2.qq.com/jump`，**u1 必须是 h5.qzone 那个地址**，
 *    并且 `keyindex` 后面带一个 `%27`（上游就是这么写的，缺了它只回 `pt_qlogincode=5`
 *    而不给 skey —— 这一步踩了很久）。
 * 3. 从响应的 Set-Cookie 里取 `skey` / `p_skey`，`g_tk` 用 **p_skey** 算（hash33）。
 *
 * 实测：这样拿到的 cookie 能读到自己的说说列表（`code:0`），说明票是真的。
 *
 * ## 边界
 *
 * - 只发**纯文字**；带图要先上传拿 richval，另说。
 * - 凭据只在内存里活一次请求，不落盘、不打日志。
 */

/** QQ 的 g_tk：把字符串按 33 进制滚动散列，取低 31 位。 */
export function hash33(text) {
  let hash = 5381
  for (const ch of String(text ?? '')) hash += (hash << 5) + ch.charCodeAt(0)
  return hash & 0x7fffffff
}

/**
 * 拼换票 URL。
 *
 * `keyindex=19%27` 里的 `%27` 不是笔误：去掉它服务端就回 `pt_qlogincode=5`（未登录态），
 * 这是读 NapCat 的实现时发现的、**唯一**有效的形状。u1 也必须指向 h5.qzone 那个地址。
 */
export function buildJumpUrl(uin, clientKey) {
  const u1 = 'https%3A%2F%2Fh5.qzone.qq.com%2Fqqnt%2Fqzoneinpcqq%2Ffriend%3Frefresh%3D0%26clientuin%3D0%26darkMode%3D0'
  return `https://ssl.ptlogin2.qq.com/jump?ptlang=1033&clientuin=${encodeURIComponent(uin)}`
    + `&clientkey=${encodeURIComponent(clientKey)}&u1=${u1}&keyindex=19%27`
}

/** 从一组 Set-Cookie 头里取名字 → 值。同名以**后出现**的为准（跳转链上会被刷新）。 */
export function parseSetCookies(headers) {
  const out = {}
  for (const raw of headers ?? []) {
    const first = String(raw).split(';')[0]
    const at = first.indexOf('=')
    if (at <= 0) continue
    const name = first.slice(0, at).trim()
    const value = first.slice(at + 1).trim()
    if (name !== '') out[name] = value
  }
  return out
}

/**
 * 两件事：拿 cookie、发说说。
 *
 * `request` 可注入（测试用）：签名 `async ({url, method, headers, body}) => ({status, headers, body})`，
 * `headers` 是对象，返回的 `headers` 允许是 `set-cookie` 数组或普通对象。
 */
export function createQzone({ request, fetchClientKey, logger = () => {} }) {
  /** 换票：clientKey → {skey, pskey, uin, cookie}。 */
  async function auth(uin) {
    const clientKey = String(await fetchClientKey()).trim()
    if (clientKey === '') throw new Error('后端没给 clientKey（TicketService.forceFetchClientKey 返回空）')
    const jump = await request({ url: buildJumpUrl(uin, clientKey), method: 'GET', headers: { 'user-agent': 'Mozilla/5.0 QQ/9.9.9' } })
    const cookies = parseSetCookies(jump?.headers?.['set-cookie'])
    const skey = cookies.skey ?? ''
    const pskey = cookies.p_skey ?? ''
    if (skey === '' || pskey === '') {
      throw new Error(`换票失败：没拿到 skey/p_skey（HTTP ${jump?.status}，字段 ${Object.keys(cookies).join(',') || '无'}）`)
    }
    return {
      uin: String(uin),
      skey,
      pskey,
      gtk: hash33(pskey),
      cookie: `p_uin=o${uin}; p_skey=${pskey}; skey=${skey}; uin=o${uin}`,
    }
  }

  /** 发一条纯文字说说。返回 `{ok, tid, code, message}`；失败抛错（调用方决定怎么报）。 */
  async function publish(text, { uin, ugcRight = 1 } = {}) {
    const body = String(text ?? '').trim()
    if (body === '') throw new Error('正文是空的')
    const ticket = await auth(uin)
    const form = new URLSearchParams({
      hostuin: ticket.uin,
      content: body,
      ugcRight: String(ugcRight),
    }).toString()
    const url = `https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=${ticket.gtk}`
    const res = await request({
      url,
      method: 'POST',
      headers: {
        cookie: ticket.cookie,
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'Mozilla/5.0 QQ/9.9.9',
        referer: `https://user.qzone.qq.com/${ticket.uin}`,
      },
      body: form,
    })
    // 返回是一个 `_Callback({...})` 包裹：剥壳再判 code。
    const raw = String(res?.body ?? '')
    const json = extractJson(raw)
    if (json === null) {
      logger(`qzone publish: 响应不是 JSON（HTTP ${res?.status}，前 120 字 ${raw.slice(0, 120)}）`)
      throw new Error(`发布返回看不懂（HTTP ${res?.status}）`)
    }
    if (Number(json.code) !== 0) throw new Error(`发布失败：code=${json.code} message=${json.message ?? ''}`)
    return { ok: true, tid: String(json.tid ?? json.data?.tid ?? ''), code: Number(json.code) }
  }

  return { auth, publish }
}

/** `_Callback({...})` → 对象；纯 JSON 也认。取不出来返回 null（调用方要如实报错）。 */
export function extractJson(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return null
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(raw.slice(start, end + 1)) } catch { return null }
}

/**
 * 真正的 HTTP 实现（默认用这个）：自动跟跳转、把每一跳的 Set-Cookie 都收下来。
 *
 * 为什么要自己跟跳转：换票那一步是 302 链，skey 常常出现在**中间某一跳**的 Set-Cookie 上；
 * 只读第一跳的响应头会漏掉它（踩过：只看到 pt_qlogincode）。
 */
export function nodeRequest({ maxRedirects = 5 } = {}) {
  return async function request({ url, method = 'GET', headers = {}, body = null }) {
    const { request: httpsRequest } = await import('node:https')
    const { URL: NodeURL } = await import('node:url')
    let target = url
    let currentMethod = method
    let currentBody = body
    const jar = []
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const parsed = new NodeURL(target)
      const response = await new Promise((resolve, reject) => {
        const req = httpsRequest({
          host: parsed.host,
          path: `${parsed.pathname}${parsed.search}`,
          method: currentMethod,
          headers: {
            ...headers,
            ...(currentMethod === 'POST' && currentBody !== null
              ? { 'content-length': Buffer.byteLength(currentBody) }
              : {}),
          },
          rejectUnauthorized: true,
          timeout: 20_000,
        }, (res) => {
          let text = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => { text += chunk })
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }))
        })
        req.on('error', reject)
        req.on('timeout', () => { req.destroy(new Error('qzone 请求超时')) })
        if (currentMethod === 'POST' && currentBody !== null) req.write(currentBody)
        req.end()
      })
      const setCookie = response.headers?.['set-cookie']
      if (Array.isArray(setCookie)) jar.push(...setCookie)
      const location = response.headers?.location
      if (response.status >= 300 && response.status < 400 && location) {
        target = new NodeURL(location, target).toString()
        // 302 之后浏览器会退化成 GET：换票链里正是靠这一跳把 cookie 种下来的。
        currentMethod = 'GET'
        currentBody = null
        continue
      }
      return { status: response.status, headers: { ...response.headers, 'set-cookie': jar }, body: response.body }
    }
    return { status: 0, headers: { 'set-cookie': jar }, body: '' }
  }
}
