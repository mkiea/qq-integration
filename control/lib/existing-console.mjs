/**
 * 「这个端口上是不是我自己」——第二次双击启动器时的判据（2026-11-07）。
 *
 * 为什么不能只看端口：8880 被占用可能是三件完全不同的事，
 *   ① 上一次双击留下的同一个控制台 ⇒ 该**直接开面板**，报错只会让人以为坏了；
 *   ② 另一份安装目录里的控制台 ⇒ token 不同，该警告「那是别人」；
 *   ③ 完全不相干的程序 ⇒ 该警告，并尽量说清是谁。
 * 只看 `EADDRINUSE` 会把这三件事压成一句「端口被占用，请先释放」。
 *
 * 判据用**自己的 token** 打一次探针：
 * token 是本机 `qq-control.json` 里 24 字节随机串，别的进程猜不到 ⇒
 * `200 + ok:true` 就是自己。这比 PID / 锁文件可靠：锁文件会因崩溃残留，
 * PID 会被系统复用，而「知道 token」这件事无法伪造。
 *
 * ★ 探针必须**轻**：`/api/status` 要跑 netstat + tasklist、还要探 13000，
 * 实测冷启动 1.6 秒。拿它当探针，超时一紧就会把「自己」判成「别人」。
 * 所以先打 `/api/ping`（只回 pid/build/stamp）；只有遇到**旧版本**（404 或 405，
 * 后者是 server 对未知路由的兜底）才回退到 `/api/status`，那时多等 3.5 秒是兼容
 * 旧包必须付的成本。
 *
 * 只连 127.0.0.1，不联网。
 */

export const PING_TIMEOUT_MS = 800
/** 旧版本回退用。实测 `/api/status` 冷启动 1.64s，取两倍余量。 */
export const LEGACY_TIMEOUT_MS = 3500

function panelUrl(port, token) {
  return `http://127.0.0.1:${port}/?token=${encodeURIComponent(String(token ?? ''))}`
}

async function requestJson(fetchImpl, url, timeoutMs) {
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    let body = null
    try { body = await response.json() } catch { body = null }
    return { status: response.status, body }
  } catch (error) {
    const code = error?.cause?.code || error?.code || ''
    return { error, code }
  }
}

/**
 * 探测端口上的东西是什么。
 *
 * 返回值（`kind` 是唯一需要分支的字段）：
 *   `none`            没人监听（ECONNREFUSED）⇒ 可以放心启动
 *   `self`            同一个控制台（token 对上了）⇒ 直接开面板
 *   `foreign-console` 是本协议的控制台，但 token 不匹配 ⇒ 另一个实例，警告
 *   `other-service`   HTTP 200/其它状态，但不是控制台接口 ⇒ 别的程序，警告
 *   `unknown`         超时/网络错误，判不了 ⇒ **仍然尝试启动**，别拿猜测挡路
 *
 * `legacy: true` 表示对方是**没有 `/api/ping` 的旧版本**，靠 `/api/status` 认出来的。
 */
export async function probeExistingConsole({
  port,
  token,
  fetchImpl = globalThis.fetch,
  pingTimeoutMs = PING_TIMEOUT_MS,
  legacyTimeoutMs = LEGACY_TIMEOUT_MS,
} = {}) {
  const numericPort = Number(port)
  if (!Number.isInteger(numericPort) || numericPort <= 0) {
    return { kind: 'none', reason: '端口无效，跳过探测' }
  }
  if (typeof fetchImpl !== 'function') {
    // 老 Node 没有全局 fetch。判不了不等于没人，交给后面的 listen 去撞。
    return { kind: 'unknown', reason: '当前 Node 没有 fetch，跳过探测' }
  }

  const base = `http://127.0.0.1:${numericPort}`
  const auth = `token=${encodeURIComponent(String(token ?? ''))}`
  const ping = await requestJson(fetchImpl, `${base}/api/ping?${auth}`, pingTimeoutMs)

  if (ping.status === 200 && ping.body?.ok === true) {
    return {
      kind: 'self',
      httpStatus: 200,
      url: panelUrl(numericPort, token),
      legacy: false,
      pid: Number(ping.body.pid) || null,
      build: ping.body.build ?? null,
      stamp: ping.body.stamp ?? null,
    }
  }
  if (ping.status === 401 || ping.status === 403) {
    return { kind: 'foreign-console', httpStatus: ping.status, url: panelUrl(numericPort, token) }
  }
  if (ping.status === 404 || ping.status === 405) {
    /**
     * 旧版本控制台：没有 `/api/ping`。回退到 `/api/status`，慢一次但能认出来。
     *
     * ⚠️ **405 也是「不认识这个路径」**：server 的兜底是
     * `json(405, { reason: 'method not allowed' })` —— 所有 `if (method && path)`
     * 都没匹配上时回的就是它，不是 404。2026-11-07 实测：一台 11-06 16:32 起的
     * 控制台对 `GET /api/ping` 回 **405**，只判 404 就会把它误报成「别的程序」。
     * 探测固定用 GET，所以 405 只可能意味着「没有这个 GET 路由」。
     */
    const legacy = await requestJson(fetchImpl, `${base}/api/status?${auth}`, legacyTimeoutMs)
    if (legacy.status === 200 && legacy.body?.ok === true) {
      return {
        kind: 'self',
        httpStatus: 200,
        url: panelUrl(numericPort, token),
        legacy: true,
        pid: Number(legacy.body.pid) || null,
        build: legacy.body.build ?? null,
        stamp: legacy.body.stamp ?? null,
      }
    }
    if (legacy.status === 401 || legacy.status === 403) {
      return { kind: 'foreign-console', httpStatus: legacy.status, url: panelUrl(numericPort, token) }
    }
    if (legacy.status) {
      return { kind: 'other-service', httpStatus: legacy.status, url: panelUrl(numericPort, token) }
    }
    if (legacy.code === 'ECONNREFUSED') return { kind: 'none', reason: '端口没人监听' }
    return { kind: 'unknown', reason: legacy.code || legacy.error?.name || '探测失败' }
  }
  if (ping.status) {
    return {
      kind: 'other-service',
      httpStatus: ping.status,
      url: panelUrl(numericPort, token),
      reason: ping.status === 200 ? '端口上有 HTTP 服务，但不是控制台接口' : `HTTP ${ping.status}`,
    }
  }
  if (ping.code === 'ECONNREFUSED') return { kind: 'none', reason: '端口没人监听' }
  return { kind: 'unknown', reason: ping.code || ping.error?.name || '探测失败' }
}

/**
 * 让**已经在跑**的控制台执行一次「一键启动」。
 *
 * 为什么不在本地再起一份：`startAll` 里的端口预检用的是那一份进程的配置与锁，
 * 另起一个进程去拉会绕过它。复用已有实例的 HTTP 接口，语义和面板上点按钮完全一致。
 */
export async function triggerStartAll({
  port,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
} = {}) {
  if (typeof fetchImpl !== 'function') return { ok: false, reason: '当前 Node 没有 fetch' }
  const url = `http://127.0.0.1:${port}/api/all/start?token=${encodeURIComponent(String(token ?? ''))}`
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` }
    return await response.json()
  } catch (error) {
    return { ok: false, reason: error?.message || '请求失败' }
  }
}
