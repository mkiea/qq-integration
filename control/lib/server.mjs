/**
 * HTTP surface of the standalone QQ bot console.
 *
 * Security model (this thing can start and kill processes, so it is deliberate):
 *   - binds 127.0.0.1 only;
 *   - every /api/* call needs the console token (query `token` or `X-Control-Token`);
 *   - a request that carries an `Origin` header must come from the console page
 *     itself, which blocks cross-site requests from any other web page;
 *   - the only kill-able PIDs are the ones the supervisor guard rail approves.
 *
 * The supervisor is injected, so the whole surface can be tested over real HTTP
 * without touching the machine.
 */
import { createServer } from 'node:http'
import { readFileSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { MANIFEST_FILE, readVersionStamp } from '../../lib/version-stamp.js'
import { tailLines } from './supervisor.mjs'
import { detectStale } from './staleness.mjs'
import { FREEABLE_PORTS, detectPaths } from './config.mjs'
import { detectTarget, readSetup, writeSetup, validateSetup, SETUP_FIELDS } from './config-target.mjs'
import { buildScenario, listScenarios } from './scenarios.mjs'
import { diffReplays } from './replaydiff.mjs'

const MAX_BODY_BYTES = 64 * 1024
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * 发行版本戳（2026-11-07）。
 *
 * 按 mtime 缓存：面板每几秒轮询一次 `/api/status`，没必要每次都读盘；
 * 但升级覆盖了 `RELEASE-MANIFEST.txt` 之后 mtime 会变 ⇒ 下一次轮询立刻读到新版本。
 * 这时页面显示的是「新版本号 + 旧进程」，正好由已有的 `build.stale` 提示条解释
 * ——两条信息互补，不是重复。
 */
let stampCache = { at: -1, value: null }
function currentStamp() {
  const path = join(REPO_ROOT, MANIFEST_FILE)
  let at = -1
  try { at = statSync(path).mtimeMs } catch { at = -1 }
  if (stampCache.value === null || stampCache.at !== at) {
    stampCache = { at, value: readVersionStamp({ repo: REPO_ROOT }) }
  }
  return stampCache.value
}
const LOG_NAMES = ['hostOut', 'hostErr', 'bridge', 'trace', 'audit', 'runtime']
const CONFIG_KEYS = ['cwd', 'dshBin', 'nodeExe', 'waylayBat', 'waylayUin', 'ttsBat']

export function createToken() {
  return randomBytes(18).toString('base64url')
}

function json(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(body)
}

function readBody(request) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    let tooLarge = false
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        // 之前直接 request.destroy()，客户端只会看到连接被重置；改成读完余量后回 413
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (tooLarge) { resolve({ __tooLarge: true }); return }
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) { resolve({}); return }
      try { resolve(JSON.parse(text)) } catch { resolve(null) }
    })
    request.on('error', () => resolve(null))
  })
}

/** Origin check: only the console page (same 127.0.0.1 port) may drive the API. */
export function originAllowed(origin, port) {
  if (!origin) return true   // curl / scripts without Origin are gated by the token instead
  try {
    const url = new URL(origin)
    const hostOk = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
    return hostOk && Number(url.port || 80) === Number(port)
  } catch {
    return false
  }
}

/**
 * @param config  resolved control config (paths + ports)
 * @param token   console token; requests must present it
 * @param api     supervisor (createSupervisor(...)) or a stub in tests
 * @param ui      HTML served at "/"
 * @param uiFile  界面文件路径：给了就按 mtime 热重载（见 currentUi）
 */
/**
 * 只拿到**请求处理函数**，不监听端口。
 *
 * ★ 2026-10-30「进程统一成一个」：控制台原来必须是独立进程（`bin/qq-control.mjs`），
 * 于是"小鲸鱼控制台"和"宿主"变成两个 node、两套地址、两个入口。现在宿主可以把这个
 * 处理函数直接挂在 `/qqai/console` 下——同一个进程、同一个地址，浏览器里只有一个页面。
 *
 * 抽出来的方式刻意最省事：`createServer` 只是把这个函数登记成 `request` 监听器，
 * 所以这里把同一段逻辑单独返回，`createControlServer` 仍然原样包一层。
 * 这样两条路（独立跑 / 挂在宿主里）**走的是同一份代码**，不会各修一份、慢慢分叉。
 */
export function createControlHandler({ config, token, api, ui = '', uiFile = '', saveConfig = null, logger = console }) {
  const port = config.ports?.control ?? 8799
  /**
   * 「进程比代码旧」的检测（2026-11-01 夜，一晚被咬两次）。
   *
   * `ui.html` 每请求读盘（所以新按钮会出现），而这些模块是启动时加载进内存的
   * （所以新接口不认、新字段不存在）。判据就是"源文件的 mtime 有没有超过进程启动时间"。
   * 只报、不自动重启 —— 控制台是能启停宿主的进程，自己悄悄重启自己太危险。
   */
  const startedAt = Date.now()
  /**
   * ⚠️ `uiFile` **故意不在这里**（2026-11-03 修）。
   *
   * `ui.html` 是每次请求按 mtime 热重载的（见下面的 currentUi），所以它"变新"**不需要重启**。
   * 之前把它算进 watchedFiles，结果每改一次界面，页面上就报"进程比代码旧"、
   * 指标条整条变灰、每一格还各贴一次"（数据陈旧）" —— 一天改五次界面就误报五次，
   * 真正的"服务端变了要重启"反而被淹没。
   *
   * 这里保留一条**独立**信息 `uiHot`：界面文件比进程新 ⇒ 说明它在热重载，不是故障。
   * 需要重启的仍然是下面这几个「启动时加载进内存」的文件。
   */
  const watchedFiles = [
    fileURLToPath(new URL('./server.mjs', import.meta.url)),
    fileURLToPath(new URL('./supervisor.mjs', import.meta.url)),
    fileURLToPath(new URL('./staleness.mjs', import.meta.url)),
    fileURLToPath(new URL('../../lib/persona-spec.js', import.meta.url)),
    fileURLToPath(new URL('../../lib/panel.js', import.meta.url)),
  ].filter((file) => file !== '')
  const build = () => {
    const report = detectStale({ files: watchedFiles, startedAt, stat: statSync })
    let uiHot = false
    if (uiFile) {
      try { uiHot = Number(statSync(uiFile)?.mtimeMs) > startedAt } catch { uiHot = false }
    }
    return { ...report, uiHot }
  }

  /**
   * 界面 HTML 的热重载。
   *
   * 原来 `ui` 是启动时 readUi() 读一次、之后永远发同一份字符串 ⇒ 改了 ui.html 之后
   * **刷新页面看不到任何变化**，必须杀掉控制台进程重开。调试界面时这特别坑：
   * 改了样式没反应，第一反应是"我改错了"，实际是服务端还端着旧快照。
   * 现在每次请求比一次 mtime，变了才重读；读失败就继续用上一份好的（别把页面变白）。
   * 只在传了 uiFile 时启用，测试里仍可只给 `ui` 字符串。
   */
  let uiSnapshot = { html: ui, at: -1 }
  function currentUi() {
    if (!uiFile) return uiSnapshot.html
    try {
      const at = statSync(uiFile).mtimeMs
      if (at !== uiSnapshot.at) uiSnapshot = { html: readFileSync(uiFile, 'utf8'), at }
    } catch { /* 暂时读不到：保持上一份 */ }
    return uiSnapshot.html
  }

  return async (request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
    const path = url.pathname

    if (request.method === 'GET' && (path === '/' || path === '/index.html')) {
      let html = currentUi()
      /**
       * 地址里没带 token 时，把「该怎么进」直接变成一条可点的链接（2026-11-01）。
       *
       * 原来这里只发一句提示「用启动控制台时窗口里打印的那行完整地址」——
       * 实际结果是用户打开 127.0.0.1:8880 看到满屏 401，以为整页挂了，
       * 得自己去 qq-control.json 翻那个 24 位 token。提示写了，但没解决问题。
       *
       * 安全性：8880 只监听 127.0.0.1，能访问它的本机进程本来就能直接读 qq-control.json；
       * 而跨源网页拿不到这个页面的 DOM（同源策略），token 不会因此被别的网站读走。
       * 代价是这一页的截图会带 token —— 页面上已经写明"别截图外发"。
       */
      if (!url.searchParams.get('token') && !request.headers['x-control-token']) {
        html = html.replace(
          '<span id="tokenQuick"></span>',
          `<div style="margin-top:10px"><a href="/?token=${encodeURIComponent(token)}" `
          + 'style="display:inline-block;padding:8px 14px;border-radius:6px;background:#2563eb;color:#fff;text-decoration:none;font-weight:600">'
          + '点这里用正确的地址打开</a>'
          + '<span class="meta" style="margin-left:10px">（链接里带着 token，别截图发出去）</span></div>'
        )
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(html)
      return
    }

    if (!path.startsWith('/api/')) {
      json(response, 404, { ok: false, reason: 'not found' })
      return
    }

    const presented = url.searchParams.get('token') ?? request.headers['x-control-token'] ?? ''
    if (presented !== token) {
      json(response, 401, { ok: false, reason: 'token 无效' })
      return
    }
    if (!originAllowed(request.headers.origin, port)) {
      json(response, 403, { ok: false, reason: 'Origin 不被允许（拒绝跨站请求）' })
      return
    }

    try {
      // ---- 首次配置向导：探测落点 + 读当前值（宿主无关）----
      if (request.method === 'GET' && path === '/api/setup/target') {
        const paths = detectPaths(config)
        const profileDir = paths.patchFile ? dirname(paths.patchFile) : ''
        const target = detectTarget({ profileDir, dataDir: paths.dataDir })
        json(response, 200, {
          ok: true,
          target: { kind: target.kind, path: target.path, label: target.label },
          fields: SETUP_FIELDS,
        })
        return
      }
      if (request.method === 'GET' && path === '/api/setup/read') {
        const paths = detectPaths(config)
        const profileDir = paths.patchFile ? dirname(paths.patchFile) : ''
        const target = detectTarget({ profileDir, dataDir: paths.dataDir })
        json(response, 200, {
          ok: true,
          target: { kind: target.kind, path: target.path, label: target.label },
          fields: SETUP_FIELDS,
          values: readSetup(target),
        })
        return
      }

      if (request.method === 'GET' && path === '/api/status') {
        json(response, 200, { ok: true, ...(await api.status()), build: build(), stamp: currentStamp() })
        return
      }
      /**
       * 人设读写（2026-11-01）。
       *
       * 只有读、写两条，路径由 supervisor 那边钉死在 `cwd/AGENTS.md`，这里不接受任何
       * 路径参数 —— 控制台不该变成一个通用文件编辑器，那等于把它变成一个写入漏洞。
       */
      if (request.method === 'GET' && path === '/api/persona') {
        if (typeof api.personaRead !== 'function') {
          json(response, 200, { ok: false, reason: '当前控制台版本不支持读人设' })
          return
        }
        json(response, 200, api.personaRead())
        return
      }
      /**
       * 人设的标准骨架 + 每节"要回答什么/别写什么"（2026-11-01 夜，用户要「标准格式」）。
       *
       * 只回文本，不落盘：点「插入骨架」是把模板填进编辑框，**保存仍然要人点**。
       */
      if (request.method === 'GET' && path === '/api/persona/template') {
        if (typeof api.personaTemplate !== 'function') {
          json(response, 200, { ok: false, reason: '当前控制台版本不支持人设骨架' })
          return
        }
        json(response, 200, api.personaTemplate())
        return
      }
      /**
       * 人设库（2026-11-01 夜，用户报「人设框没法选人设」）。
       *
       * `cwd/personas/*.md` 是备选，`cwd/AGENTS.md` 是唯一生效的那份（宿主只认这个文件名）。
       * 所以"选人设"= 把选中的复制成 AGENTS.md，旧内容先备份。
       */
      if (request.method === 'GET' && path === '/api/personas') {
        if (typeof api.personaList !== 'function') {
          json(response, 200, { ok: false, reason: '当前控制台版本不支持人设库' })
          return
        }
        json(response, 200, api.personaList())
        return
      }
      /**
       * 人设的历史备份清单（2026-11-01 夜，用户问「替换有没有备份」）。
       *
       * 只读：列文件名/大小/时间，**不提供删除、也不提供"直接回滚"**——
       * 回滚等于再写一次文件，得由用户在编辑框里看过再点保存，否则就成了
       * "点一下就换掉一个人"的按钮。前端拿到的用法是：选中一份 → 填进编辑框 → 自己确认。
       */
      if (request.method === 'GET' && path === '/api/persona/backups') {
        if (typeof api.personaBackups !== 'function') {
          json(response, 200, { ok: false, reason: '当前控制台版本不支持列人设备份' })
          return
        }
        const rows = api.personaBackups()
        json(response, 200, { ok: true, rows })
        return
      }
      /**
       * 读回一份备份的正文。名字只接受 `AGENTS.backup-*.md`（防穿越由 basename 校验兜住），
       * 拼接目录仍旧只在 `cwd` 下 —— 调用方没有"指定任意路径"的口子。
       */
      if (request.method === 'GET' && path === '/api/persona/backup') {
        if (typeof api.personaBackups !== 'function') {
          json(response, 200, { ok: false, reason: '当前控制台版本不支持读人设备份' })
          return
        }
        const name = String(url.searchParams.get('name') ?? '')
        if (!/^AGENTS\.backup-[^\\/]+\.md$/.test(name)) {
          json(response, 400, { ok: false, reason: '备份名必须是 AGENTS.backup-*.md' })
          return
        }
        const hit = api.personaBackups().find((row) => row.name === name)
        if (!hit) {
          json(response, 404, { ok: false, reason: `没有这份备份：${name}` })
          return
        }
        json(response, 200, typeof api.personaBackupText === 'function'
          ? api.personaBackupText(name)
          : { ok: false, reason: '当前控制台版本不支持读备份正文' })
        return
      }
      if (request.method === 'GET' && path === '/api/logs') {
        const name = url.searchParams.get('name') ?? 'hostOut'
        if (!LOG_NAMES.includes(name)) {
          json(response, 400, { ok: false, reason: `日志名必须是 ${LOG_NAMES.join('/')}` })
          return
        }
        const lines = Math.min(1000, Math.max(10, Number(url.searchParams.get('lines')) || 200))
        json(response, 200, { ok: true, name, lines: tailLines(api.logFile(name), lines) })
        return
      }
      if (request.method === 'GET' && path === '/api/trace') {
        const traceId = url.searchParams.get('traceId') ?? ''
        if (traceId) {
          const chain = api.traceChain(traceId)
          json(response, 200, { ok: true, traceId, chain })
          return
        }
        const okParam = url.searchParams.get('ok')
        const events = api.traceEvents({
          limit: Math.min(2000, Math.max(1, Number(url.searchParams.get('limit')) || 300)),
          chatKey: url.searchParams.get('chatKey') ?? '',
          level: url.searchParams.get('level') ?? '',
          stage: url.searchParams.get('stage') ?? '',
          ok: okParam === null || okParam === '' ? null : okParam === 'false' ? false : true,
        })
        json(response, 200, { ok: true, events, summary: api.summarize ? api.summarize(events) : undefined })
        return
      }
      if (request.method === 'GET' && path === '/api/inbox') {
        const limit = Number(url.searchParams.get('limit')) || 50
        json(response, 200, { ok: true, ...api.inboxList({ limit }) })
        return
      }
      if (request.method === 'GET' && path === '/api/archive') {
        const query = (url.searchParams.get('q') ?? '').trim()
        const days = Math.min(3650, Math.max(1, Number(url.searchParams.get('days')) || 7))
        if (query === '') {
          json(response, 200, { ok: true, ...(await api.archiveStats()) })
          return
        }
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20))
        const chatKey = (url.searchParams.get('chatKey') ?? '').trim()
        json(response, 200, { ok: true, days, ...(await api.archiveSearch(query, { days, limit, chatKey })) })
        return
      }
      if (request.method === 'GET' && path === '/api/runtime') {
        json(response, 200, { ok: true, runtime: api.runtime() })
        return
      }
      // v0.5.5「控制台看得见」：性能面板（P50/P95）、定时任务面板、群配置页。
      if (request.method === 'GET' && path === '/api/perf') {
        if (typeof api.perf !== 'function') {
          json(response, 200, { ok: false, reason: '当前控制台不支持性能面板' })
          return
        }
        const limit = Math.min(20000, Math.max(100, Number(url.searchParams.get('limit')) || 5000))
        const windowMinutes = Math.min(1440, Math.max(0, Number(url.searchParams.get('window')) || 0))
        // 必须 await：supervisor 这三个方法都是 async，直接序列化 Promise 会得到空对象（实测踩过）。
        json(response, 200, await api.perf({ limit, chatKey: (url.searchParams.get('chatKey') ?? '').trim(), windowMinutes }))
        return
      }
      if (request.method === 'GET' && path === '/api/jobs') {
        if (typeof api.jobsView !== 'function') {
          json(response, 200, { ok: false, reason: '当前控制台不支持定时任务面板' })
          return
        }
        json(response, 200, await api.jobsView())
        return
      }
      if (request.method === 'GET' && path === '/api/groups') {
        if (typeof api.groups !== 'function') {
          json(response, 200, { ok: false, reason: '当前控制台不支持群配置页' })
          return
        }
        json(response, 200, await api.groups())
        return
      }
      // 注入场景库：只返回清单（生成 spec 走 POST /api/inject 的 scenario 字段，逻辑在纯模块里测）
      if (request.method === 'GET' && path === '/api/scenarios') {
        json(response, 200, { ok: true, scenarios: listScenarios() })
        return
      }
      // 登录二维码：直接给前端 dataUrl + 新鲜度，省得再开一个端口去看图
      if (request.method === 'GET' && path === '/api/qr') {
        if (typeof api.qr !== 'function') {
          json(response, 200, { ok: false, reason: '当前控制台不支持二维码查看' })
          return
        }
        json(response, 200, await api.qr())
        return
      }
      // v0.8.0：NapCat WebUI 入口（/api/napcat/webui）已随 NapCat 退场——Waylay 的 13000 是裸 HTTP，不用拼 token。
      if (request.method === 'GET' && path === '/api/waylay') {
        if (typeof api.waylayStatus !== 'function') {
          json(response, 200, { ok: false, reason: '当前控制台不支持该接口' })
          return
        }
        json(response, 200, { ok: true, ...(await api.waylayStatus()) })
        return
      }
      if (request.method === 'GET' && path === '/api/diagnose') {
        const result = await api.diagnose()
        json(response, 200, { ok: true, ...result })
        return
      }
      if (request.method === 'GET' && path === '/api/acceptance') {
        if (typeof api.acceptance !== 'function') {
          json(response, 200, { ok: false, reason: '当前控制台不支持验收台' })
          return
        }
        const result = await api.acceptance()
        json(response, 200, { ok: result.ok, report: result.report, text: result.text, verdict: result.verdict, totals: result.totals })
        return
      }
      if (request.method === 'GET' && path === '/api/export') {
        // redact=1 → 分享安全通路：QQ 号掩码、消息原文只留长度（诊断包的使用场景就是发给别人）
        const redact = ['1', 'true', 'yes'].includes(String(url.searchParams.get('redact') ?? '').toLowerCase())
        const bundle = await api.exportBundle({ redact })
        response.writeHead(200, {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="${bundle.filename}"`,
          'content-length': String(bundle.buffer.length),
          'cache-control': 'no-store',
          'x-redacted': redact ? '1' : '0',
        })
        response.end(bundle.buffer)
        return
      }
      if (request.method === 'GET' && path === '/api/stream') {
        // Server-Sent Events: push new trace events as the bridge writes them.
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        response.write('retry: 3000\n\n')
        const tailer = api.tailer()
        let closed = false
        const timer = setInterval(() => {
          if (closed) return
          try {
            const events = tailer.poll()
            for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
            response.write(': ping\n\n')
          } catch (error) {
            logger?.warn?.(`trace stream failed: ${error.message}`)
          }
        }, 1000)
        request.on('close', () => {
          closed = true
          clearInterval(timer)
        })
        return
      }
      if (request.method === 'POST') {
        const body = await readBody(request)
        if (body?.__tooLarge === true) {
          json(response, 413, { ok: false, reason: `请求体过大（上限 ${Math.round(MAX_BODY_BYTES / 1024)} KiB）` })
          return
        }
        if (body === null) {
          json(response, 400, { ok: false, reason: '请求体不是合法 JSON 或过大' })
          return
        }
        /**
         * ★ 2026-10-30：控制台现在可以**挂在宿主进程里**（`/qqai/console`）。
         * 那样"停宿主 / 重启宿主"就是"停自己"——`supervisor` 会回 `self:true`，
         * 这里负责**先把响应发出去**再退出，否则浏览器只看到连接被重置，
         * 用户不知道到底成没成功。重启那条会先派一个后台任务等端口释放再拉起。
         */
        const exitAfterReply = (why) => {
          const leave = () => {
            logger?.info?.(`control: ${why}，进程退出`)
            process.exit(0)
          }
          if (response.writableFinished) setTimeout(leave, 60)
          else response.once('finish', () => setTimeout(leave, 160))
        }
        const actions = {
          '/api/host/start': () => api.startHost(),
          '/api/host/stop': async () => {
            const result = await api.stopHost()
            if (result?.self === true && result.ok === true) exitAfterReply('宿主停止（自己就是宿主）')
            return result
          },
          '/api/host/restart': async () => {
            if (typeof api.restartHost !== 'function') return { ok: false, reason: '当前控制台不支持重启宿主' }
            const result = await api.restartHost()
            if (result?.self === true && result.ok === true) exitAfterReply('宿主重启（自己就是宿主，已派后台任务）')
            return result
          },
          // Waylay：v0.8.0 起唯一的后端。停止 = 结束那个监听 13000 的 QQ（判据在 lib/waylay-launch.js）
          '/api/waylay/start': () => {
            if (typeof api.startWaylay !== 'function') return { ok: false, reason: '当前控制台不支持该接口' }
            return api.startWaylay()
          },
          '/api/waylay/stop': () => {
            if (typeof api.stopWaylay !== 'function') return { ok: false, reason: '当前控制台不支持该接口' }
            return api.stopWaylay()
          },
          // 让 Waylay 主动重新出一张登录码（旧按钮只是重读同一个文件，用户实测「不管用」）
          '/api/qr/refresh': () => {
            if (typeof api.refreshQr !== 'function') return { ok: false, reason: '当前控制台不支持该接口' }
            return api.refreshQr()
          },
          '/api/tts/start': () => api.startTts(),
          '/api/tts/stop': () => api.stopTts(),
          '/api/all/stop': () => api.stopAll(),
          // 总控页的一键启动（Waylay → 宿主 → 可选 TTS，单项失败不中断）
          '/api/all/start': () => {
            if (typeof api.startAll !== 'function') return { ok: false, reason: '当前控制台不支持该接口' }
            return api.startAll()
          },
          // 释放端口：只允许释放**受管端口**（FREEABLE_PORTS）。否则 token 持有者能借它
          // 杀掉任意占用者的进程（审查复现过 {"name":"control"} → 杀掉别的 8799 占用者）。
          '/api/port/free': () => {
            const name = String(body.name ?? '').trim()
            if (!FREEABLE_PORTS.includes(name)) {
              return { ok: false, reason: `只能释放受管端口：${FREEABLE_PORTS.join(' / ')}（收到「${name}」）` }
            }
            return api.freePort(name)
          },
          // 离线回放：在沙箱里跑真实管线，dry-run 拦截一切出站
          '/api/replay': () => {
            if (typeof api.replay !== 'function') return { ok: false, reason: '当前控制台不支持回放' }
            const indices = Array.isArray(body.indices) ? body.indices.slice(0, 20) : null
            const entries = Array.isArray(body.entries) ? body.entries.slice(0, 20) : null
            const overrides = body.overrides && typeof body.overrides === 'object' && !Array.isArray(body.overrides) ? body.overrides : {}
            return api.replay({
              indices,
              entries,
              limit: Number(body.limit) || 5,
              replyText: typeof body.replyText === 'string' ? body.replyText.slice(0, 500) : '',
              overrides,
              budgetMs: Math.min(60000, Math.max(1000, Number(body.budgetMs) || 20000)),
            })
          },
          // 事件注入：写一行到注入队列，桥按间隔轮询后走真实管线（默认 dry-run）
          '/api/inject': () => {
            if (typeof api.inject !== 'function') return { ok: false, reason: '当前控制台不支持注入' }
            // 场景库：传 scenario 时由纯模块生成 spec（参数校验也在那边，缺什么说什么）
            if (typeof body.scenario === 'string' && body.scenario.trim() !== '') {
              const built = buildScenario(body.scenario, body.params && typeof body.params === 'object' ? body.params : {})
              if (built.ok !== true) return built
              return api.inject(built.spec)
            }
            return api.inject(body.spec && typeof body.spec === 'object' ? body.spec : body)
          },
          // 回放 diff：同一批消息跑两次（基线 + 覆盖配置），机械地比出差异
          '/api/replay-diff': async () => {
            if (typeof api.replay !== 'function') return { ok: false, reason: '当前控制台不支持回放' }
            const indices = Array.isArray(body.indices) ? body.indices.slice(0, 20) : null
            const entries = Array.isArray(body.entries) ? body.entries.slice(0, 20) : null
            const limit = Number(body.limit) || 5
            const baselineOverrides = body.baseline && typeof body.baseline === 'object' && !Array.isArray(body.baseline) ? body.baseline : {}
            const variantOverrides = body.variant && typeof body.variant === 'object' && !Array.isArray(body.variant) ? body.variant : null
            if (variantOverrides === null || Object.keys(variantOverrides).length === 0) {
              return { ok: false, reason: '请给出要对比的配置覆盖（variant，例如 {"keywordEnabled": true}）' }
            }
            const baseline = await api.replay({ indices, entries, limit, replyText: '', overrides: baselineOverrides, budgetMs: 20000 })
            const variant = await api.replay({ indices, entries, limit, replyText: '', overrides: variantOverrides, budgetMs: 20000 })
            const diff = diffReplays(baseline, variant)
            return { ok: true, variant: variantOverrides, ...diff }
          },
          '/api/queue/clear': () => {
            if (typeof api.clearQueue !== 'function') return { ok: false, reason: '当前控制台不支持清空队列' }
            return api.clearQueue()
          },
          /**
           * 「打开数据根目录」：控制台不自己拼路径，全部交给 supervisor（它才知道
           * 快照里那个**生效**的 dataDir）。这里只转发并原样回报，避免两处算法不一致。
           */
          '/api/data-dir/open': () => {
            if (typeof api.openDataDir !== 'function') return { ok: false, reason: '当前控制台不支持打开数据目录' }
            return api.openDataDir()
          },
          /**
           * 「浏览…」：弹系统选文件夹窗口，只返回路径、**不写配置**。
           * 向导里那个输入框要让人先看一眼（选错目录的代价是把记忆接到别处）。
           */
          '/api/data-dir/browse': () => {
            if (typeof api.browseDataDir !== 'function') return { ok: false, reason: '当前控制台不支持浏览目录' }
            return api.browseDataDir()
          },
          /**
           * 「就用这个目录」：把 dataDir 写进 **profile 的 cordis.patch.yml**（向导的落地动作）。
           * 校验与写盘都在 supervisor 里（复用 `lib/panel.js` 的规则），这里只做形状检查——
           * 前端传什么就写什么是最容易出的事故：少一个 `path` 字段会把配置写成空串。
           */
          '/api/data-dir/set': () => {
            if (typeof api.setDataDir !== 'function') return { ok: false, reason: '当前控制台不支持设置数据根目录' }
            if (typeof body.path !== 'string') {
              return { ok: false, reason: `请求里缺少 path（收到 ${JSON.stringify(body?.path ?? null)}）；要清空请显式传空串` }
            }
            return api.setDataDir(body.path)
          },
          /**
           * 保存人设（2026-11-01）。
           *
           * 只收 `text`，路径不接收 —— 写哪儿由 supervisor 的 `personaFile()` 决定。
           * 这样即使控制台被恶意页面驱动，也只能改那一个人设文件，动不了别处。
           */
          '/api/persona': () => {
            if (typeof api.personaWrite !== 'function') return { ok: false, reason: '当前控制台版本不支持改人设' }
            if (typeof body.text !== 'string') {
              return { ok: false, reason: `请求里缺少 text（收到 ${JSON.stringify(body?.text ?? null)}）` }
            }
            return api.personaWrite(body.text)
          },
          /**
           * 人设库的三个动作（2026-11-01 夜）。名字只收"像名字的字符串"，路径一律由
           * supervisor 拼 —— 这里多一个参数就等于多一个写入漏洞。
           */
          '/api/personas/save': () => {
            if (typeof api.personaSaveAs !== 'function') return { ok: false, reason: '当前控制台版本不支持人设库' }
            if (typeof body.name !== 'string') return { ok: false, reason: '请求里缺少 name' }
            if (typeof body.text !== 'string') return { ok: false, reason: '请求里缺少 text' }
            return api.personaSaveAs(body.name, body.text, { overwrite: body.overwrite === true })
          },
          '/api/personas/activate': () => {
            if (typeof api.personaActivate !== 'function') return { ok: false, reason: '当前控制台版本不支持切换人设' }
            if (typeof body.name !== 'string') return { ok: false, reason: '请求里缺少 name' }
            return api.personaActivate(body.name)
          },
          '/api/personas/archive': () => {
            if (typeof api.personaArchiveCurrent !== 'function') return { ok: false, reason: '当前控制台版本不支持收进人设库' }
            return api.personaArchiveCurrent(typeof body.name === 'string' ? body.name : '')
          },
          // ---- 首次配置向导：写入（GET 的两条在文件上方，走逐条 if）----
          '/api/setup/write': () => {
            const paths = detectPaths(config)
            const profileDir = paths.patchFile ? dirname(paths.patchFile) : ''
            const target = detectTarget({ profileDir, dataDir: paths.dataDir })
            const checked = validateSetup(body)
            if (!checked.ok) return { ok: false, reason: checked.errors.join('；'), errors: checked.errors }
            return writeSetup(target, checked.values)
          },
          '/api/config': () => {
            if (typeof saveConfig !== 'function') return { ok: false, reason: '配置保存不可用' }
            const patch = {}
            for (const key of CONFIG_KEYS) if (typeof body[key] === 'string' && body[key].trim()) patch[key] = body[key].trim()
            if (body.ports && typeof body.ports === 'object') {
              patch.ports = { ...config.ports }
              for (const [name, value] of Object.entries(body.ports)) {
                const port = Number(value)
                if (Number.isInteger(port) && port >= 1 && port <= 65535) patch.ports[name] = port
              }
            }
            if (Object.keys(patch).length === 0) return { ok: false, reason: '没有可更新的字段' }
            const ok = saveConfig(patch)
            return { ok, reason: ok ? '配置已保存（重启控制台后完全生效）' : '配置写入失败' }
          },
        }
        const action = actions[path]
        if (!action) {
          json(response, 404, { ok: false, reason: '未知接口' })
          return
        }
        const result = await action()
        json(response, 200, { ok: result?.ok !== false, ...result })
        return
      }
      json(response, 405, { ok: false, reason: 'method not allowed' })
    } catch (error) {
      logger?.error?.(`control api ${path} failed: ${error.message}`)
      json(response, 500, { ok: false, reason: `内部错误：${error.message}` })
    }
  }
}

/**
 * 独立跑的那条路（`bin/qq-control.mjs`）：把同一份处理函数包成一个 http.Server。
 * 与"挂在宿主里"共用 `createControlHandler`，行为一致。
 */
export function createControlServer(options) {
  return createServer(createControlHandler(options))
}

/** Read the UI file (kept separate so the server stays testable without it). */
export function readUi(file) {
  try { return readFileSync(file, 'utf8') } catch { return '<h1>UI 文件缺失</h1>' }
}
