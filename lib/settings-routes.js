/**
 * v0.6：把「QQ助手」面板挂到 DSH 的 HTTP 服务上（客户端 bundle 用 fetch 调这里）。
 *
 * 契约照抄 DSH 自带/已装插件的做法（`dshmarket` 的 routes.js）：
 *   `host.webServer.register({ kind: 'exact', path, handler(request, response) })`
 * 因此这里只用 Node 原生 req/res，不引任何依赖（本插件零第三方依赖的原则不变）。
 *
 * 写入范围**只有 profile 的 cordis.patch.yml 里本插件那一个 config 块**，且只允许面板白名单里的
 * 布尔键；每次写入前留一份 `.bak`，写坏了也能一眼看出来（回滚就是把它拷回去）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PANEL_GROUPS, PANEL_KEYS, PANEL_NOTES, PANEL_ROW_BY_KEY, metaNumberOrNull, normalizeNumberList, normalizeQuietRanges, panelFooterLinksWithConsole, panelSnapshot, readPatchValue, upsertPatchValue,
} from './panel.js'
import { buildChatLog, memoryDirOf, renderChatLogHtml } from './chatlog.js'
import {
  WAYLAY_BAT_HINT, WAYLAY_PORT, detectWaylayBat, parseListenerPid, parseTasklist, stopPlan,
  waylayLaunchCommand, waylayLogPath, waylayQrPath,
} from './waylay-launch.js'
// 选文件夹窗口（首次启动向导与面板共用同一份实现，见 lib/dir-pick.js）
import { pickFolderDialog } from './dir-pick.js'
import { createControlHandler, createToken, readUi } from '../control/lib/server.mjs'
import { loadControlConfig, saveControlConfig } from '../control/lib/config.mjs'
import { createSupervisor } from '../control/lib/supervisor.mjs'

const PLUGIN_ID = 'dsh-qq-onebot-bridge'

/**
 * **磁盘上那一版代码的版本号**（v0.6.9）。
 *
 * ⚠️ 必须**每次现读**，不能在模块加载时缓存成常量：宿主热重载插件时复用 Node 的 ESM 模块缓存
 * （同一份 URL 不会重新求值），于是"加载时读到的版本"会永远停在宿主启动那一刻——
 * 2026-10-25 真机实测：磁盘已是 0.6.9、面板却一直报 0.6.8；前端拿它跟 `CLIENT_VERSION` 比较，
 * 还会**误报**「前端落后，请刷新页面」。现读的代价只是每次面板加载读一个几 KB 的 JSON。
 * （读不到就写 `?`，绝不让它影响面板本身。）
 */
function readPluginVersion() {
  try {
    const file = fileURLToPath(new URL('../package.json', import.meta.url))
    const version = JSON.parse(readFileSync(file, 'utf8')).version
    return typeof version === 'string' && version !== '' ? version : '?'
  } catch {
    return '?'
  }
}
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 跑一条命令并收集输出（失败不抛，返回空 stdout）。
 * 给 `tasklist` 用——只为挑出 NapCat 加载器的 PID；可注入，测试里不会真跑。
 */
function runCommand(exec, command, args, { timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    exec(command, args, { timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      resolve({ ok: error === null || error === undefined, stdout: String(stdout ?? '') })
    })
  })
}

/**
 * 起一个进程并把它的输出抓回来（提权启动 NapCat 用）。
 *
 * 🔴 **绝对不要加 `detached: true`**（2026-10-04 真机，Node 26 + Windows 实测）：
 *   同一个 powershell 命令，`detached: true` + 管道时 **exit=0、stdout/stderr 全空，而且命令压根没执行**
 *   （用落盘标记验证过：标记文件都没生成）；去掉 detached 立刻恢复正常（有输出、标记落盘）。
 *   这正是从第一版起"点了启动没反应、界面还说成功"的**总根源**——提权命令从未真正运行过。
 *   矩阵实测：
 *     A 默认           → out="hi-from-ps" ✓
 *     B 只有管道        → out="hi-from-ps" ✓
 *     C windowsHide+管道 → out="hi-from-ps" ✓
 *     D detached+管道    → out=""（且没执行）✗
 *     E D + windowsHide  → out=""（且没执行）✗  ← 插件原来用的就是这个形状
 *   为什么当时以为需要 detached：担心子进程随宿主退出被收走。其实**提权那一跳是 AppInfo 服务拉起的**
 *   （不在我们的 Job 里），我们自己的 powershell 只是发令、一秒内就退出，不需要 detached。
 * `unref()` 仍然保留：发令进程退出后不该拖着宿主的引用计数。
 */
export function spawnDetachedProcess({
  command, args = [], cwd, spawnImpl = spawn, waitMs = 6000,
} = {}) {
  if (!command) throw new Error('缺少可执行文件路径')
  return new Promise((resolve) => {
    let child = null
    try {
      child = spawnImpl(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ pid: 0, failed: true, code: -1, stdout: '', stderr: '', message: String(error?.message ?? error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    child.stdout?.on?.('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on?.('data', (chunk) => { stderr += String(chunk) })
    const finish = (extra) => {
      if (settled) return
      settled = true
      child.unref?.()
      resolve({ pid: child.pid ?? 0, failed: false, code: null, stdout, stderr, ...extra })
    }
    child.once('error', (error) => finish({ failed: true, code: -1, message: String(error?.message ?? error) }))
    child.once('exit', (code) => finish({ code: typeof code === 'number' ? code : -1 }))
    // 超时也照常放行：命令可能还挂着（比如等 UAC），我们只是不再等它。
    setTimeout(() => finish({ code: null, timedOut: true }), Math.max(500, waitMs)).unref?.()
  })
}

/** 探一下 127.0.0.1:<port> 有没有人在听（调试台是否已启动）。失败/超时都算"没在跑"，不抛。 */
export function probePort(port, { host = '127.0.0.1', timeout = 400 } = {}) {
  return new Promise((resolve) => {
    let settled = false
    const socket = connect({ host, port })
    const finish = (ok) => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeout)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/** 调试台的启动命令（可复制粘贴；路径取自插件真实位置，不写死）。 */
export function consoleStartCommand({ root = PLUGIN_ROOT } = {}) {
  return `node "${join(root, 'control', 'bin', 'qq-control.mjs')}"`
}

/**
 * 「QQ助手账号」入口：302 到 Waylay 的控制台（v0.8.0 起 NapCat WebUI 已随 NapCat 代码一起退场）。
 *
 * Waylay 的 13000 是裸 HTTP、没有 token，这个入口不再"交出密钥"——同源守卫照留：
 * 它是面板的动作入口，没理由给第三方页面用。
 *
 * `pluginRoot` 保留（历史契约，单测也注入它）；`readFile` 不再需要（没有 webui.json 可读了）。
 */
function accountEntry(request, response, { pluginRoot = PLUGIN_ROOT, waylayPort = WAYLAY_PORT } = {}) {
  const remote = String(request.socket?.remoteAddress ?? '')
  const local = remote === '' || remote === '::1' || remote.startsWith('127.') || remote.startsWith('::ffff:127.')
  if (!local) {
    sendJson(response, 403, { ok: false, reason: '账号入口只允许本机访问' })
    return
  }
  const guard = sameSiteGuard(request, { requireJson: false })
  if (!guard.ok) { sendJson(response, 403, { ok: false, reason: guard.reason }); return }
  const url = `http://127.0.0.1:${waylayPort}/`
  /**
   * `?format=json`：把地址**当数据**返回，而不是 302（客户端拿它自己开）。
   * 桌面端主窗口拒开新窗口 ⇒ 客户端先取这份 JSON，再 `window.open(绝对 http 地址)`，
   * 桌面端会把 http 地址交给系统浏览器。
   */
  if (String(request.url ?? '').includes('format=json')) {
    sendJson(response, 200, { ok: true, url })
    return
  }
  response.writeHead(302, { location: url, 'cache-control': 'no-store' })
  response.end()
}

/**
 * 调试台（`control/`）的启动计划：**纯函数**，便于单测。
 *
 * 它是个普通的 node 进程（自己解析仓库根、自己读 `qq-control.json`），所以**不需要提权、不需要垫片**——
 * 用**当前宿主的 node 本体**（`process.execPath`）去跑它的入口就行，避免依赖 PATH 里有没有 `node`。
 *
 * ⚠️ **桌面端必须补 `ELECTRON_RUN_AS_NODE=1`**（2026-10-16 真机抓到）：官方桌面端的
 * `process.execPath` 是 **Electron 本体**（`DeepSeek Harness.exe`），不设这个变量时它会把
 * 我们这支 `.mjs` 当成**一个 Electron 应用的入口**去启动——于是"启动调试台"等于又开了一个
 * 完整的 Electron 实例（实测：控制台进程的命令行就是
 * `"…\DeepSeek Harness.exe" …\control\bin\qq-control.mjs`，`Get-Process` 里显示成 DeepSeek Harness）。
 * 官方文档（Environment Variables → `ELECTRON_RUN_AS_NODE`）："Starts the process as a normal
 * Node.js process."；前提是 `runAsNode` fuse 没被关（本机实测可用：子进程报
 * `electron=44.0.0 node=24.18.1`）。CLI 宿主（`node bin.js web`）里 `process.execPath` 本来就是
 * node.exe，不需要也不该补这个变量。
 */
export function consoleLaunchPlan({ root = PLUGIN_ROOT, execPath = process.execPath, exists = existsSync, electron = Boolean(process.versions?.electron) } = {}) {
  const entry = join(root, 'control', 'bin', 'qq-control.mjs')
  if (exists(entry) !== true) return { ok: false, entry, reason: `找不到控制台入口：${entry}` }
  return { ok: true, entry, command: execPath, args: [entry], cwd: root, env: electron === true ? { ELECTRON_RUN_AS_NODE: '1' } : null, reason: '' }
}

/**
 * 起一个**长驻后台进程**（调试台用）。
 *
 * 与 `spawnDetachedProcess` 的两点区别，都是被真机教出来的：
 *   ① **不传 `detached`**：本机（Node 26 + Windows）实测带 detached 的子进程 `exit=0`、命令根本不执行；
 *   ② **`stdio: 'ignore'`**：调试台是长驻进程，抓管道会在我们不再读取之后把它的输出憋住（写满管道即阻塞）；
 *      它自己会写日志文件，不需要我们代收。
 */
export function spawnBackgroundProcess({ command, args = [], cwd, env = null, spawnImpl = spawn } = {}) {
  if (!command) throw new Error('缺少可执行文件路径')
  // `env` 只用来**追加**（例如桌面端的 `ELECTRON_RUN_AS_NODE=1`）：不覆盖宿主已有的环境，
  // 否则 PATH/代理/DSH_* 全丢，拉起来的进程会变成另一个世界。
  const child = spawnImpl(command, args, {
    cwd,
    windowsHide: true,
    stdio: 'ignore',
    ...(env && Object.keys(env).length > 0 ? { env: { ...process.env, ...env } } : {}),
  })
  child.unref?.()
  return { pid: child.pid ?? 0 }
}

/**
 * 选文件夹窗口的实现已搬到 `lib/dir-pick.js`（零内部依赖）——
 * 控制台的首次启动向导也要用它，而那个文件反过来 import 本模块会形成循环依赖。
 * 本文件只负责**转出**同一个函数（见顶部 import），调用方与测试都不用改。
 */
export { parseFolderDialogOutput, pickFolderDialog } from './dir-pick.js'

/**
 * 同源守卫：本机端口不等于"只有我能访问"——浏览器会把**第三方页面**发起的请求带到这里。
 *
 * 第二轮对抗性审查用真实 http server 证明了两个绕过口子，这里都堵掉了：
 *   ① **"没有 Content-Type 就当本机脚本放行"** —— 不带 Content-Type 的 POST 属于 CORS **简单请求**，
 *      连预检都不发，于是"要求 application/json"这道闸形同虚设。现在**必须**是 JSON
 *      （curl/脚本也一样，加 `-H 'content-type: application/json'`）。
 *   ② **"Origin 的 hostname 等于请求 Host 就信"** —— DNS rebinding（`evil.com` 解析到 127.0.0.1）
 *      正好满足；`chrome-extension://`、`file://`、`data:` 这类非 http 协议也被一并信任了。
 *      现在只放行三种：`sec-fetch-site: same-origin`（浏览器自己打的标，页面改不了）、
 *      Origin 的 scheme+host+port 与请求 Host **完全一致**、DSH 自家协议 `dsh-*://`（桌面端）。
 */
export function sameSiteGuard(request, { requireJson = true } = {}) {
  const headers = request.headers ?? {}
  const site = String(headers['sec-fetch-site'] ?? '').toLowerCase()
  if (site === 'cross-site') return { ok: false, reason: '拒绝跨站请求（sec-fetch-site: cross-site）' }
  if (requireJson) {
    const type = String(headers['content-type'] ?? '').toLowerCase()
    if (!type.includes('application/json')) {
      return { ok: false, reason: `写操作只接受 application/json（收到 ${type || '没有 Content-Type'}）` }
    }
  }
  const origin = String(headers.origin ?? '')
  if (origin === '') {
    /**
     * **导航请求（点链接 / 地址栏）不带 Origin** —— 这是 2026-10-04 真机"点了没反应"的根因：
     * 浏览器点 `<a href="/qqai/account">` 时发的是
     * `Sec-Fetch-Site: same-origin` + `Sec-Fetch-Mode: navigate`，**没有 Origin**；
     * 而这里原来只放行 `''` 与 `none`，于是正常点击被判成"来源不明的请求" → **403**，
     * 面板里「QQ助手账号」和「调试台」两个入口全点不动（我当时的 smoke 手动补了 `Origin`，
     * 正好从另一条分支出去了，所以没测出来 —— 现在测试里专门钉了导航形状的请求头）。
     *
     * 放行三种，语义都是"浏览器担保它跟本页面同源、或用户自己敲的地址"：
     *   - `same-origin`：页面里点链接（就是我们要支持的那种）
     *   - `none`：地址栏直达 / 书签
     *   - `''`：根本没有 Sec-Fetch-* 的老浏览器与 curl / 本机脚本
     * 仍然拒绝 `cross-site`（上面已拦）与 `same-site`（同站不同端口，比如本机别的服务）；
     * 注意 `Sec-Fetch-*` 是浏览器自己打的标，页面脚本改不了，所以这仍是可信信号。
     */
    if (site === '' || site === 'none' || site === 'same-origin') return { ok: true, reason: '' }
    return { ok: false, reason: `拒绝来源不明的请求（sec-fetch-site: ${site}）` }
  }
  let url = null
  try { url = new URL(origin) } catch { return { ok: false, reason: `Origin 不是合法地址：${origin}` } }
  if (url.protocol.startsWith('dsh-')) return { ok: true, reason: '' }  // 桌面端 dsh-app://
  /**
   * `sec-fetch-site: same-origin` **单独就够**：它是浏览器按*发起方 URL* 算出来的，页面脚本改不了，
   * 跨站页面打过来必然是 `cross-site`（上面已拦）。所以即使 Origin 与 Host 对不上也放行——
   * 这不是漏洞而是**有意留的口子**：反向代理部署时 Host 可能是内网地址、Origin 是公网域名，
   * 两者本来就不相等（平台自己也有 `--trusted-host` 这一档）。
   * 2026-10-04 我一度想收紧成"以 Origin 为准"，核对后**没有改**：真实浏览器发不出
   * "Origin=evil.example + same-origin 标记"这种自相矛盾的请求，改了只会误伤代理场景。
   * 测试里把这条语义显式钉住了（`sameSiteGuard` 那段）。
   */
  if (site === 'same-origin') return { ok: true, reason: '' }           // 浏览器担保的同源
  const requestHost = String(headers.host ?? '')
  const at = requestHost.lastIndexOf(':')
  const hostName = at === -1 ? requestHost : requestHost.slice(0, at)
  const hostPort = at === -1 ? '' : requestHost.slice(at + 1)
  const originPort = url.port !== '' ? url.port : (url.protocol === 'https:' ? '443' : '80')
  if (hostName !== '' && url.hostname === hostName && (hostPort === '' || hostPort === originPort)) {
    return { ok: true, reason: '' }
  }
  return { ok: false, reason: `Origin 不被允许（拒绝跨站请求）：${origin}` }
}

/** 读一个文件的最后一行（最多 200 字），给"启动脚本报了什么"用；读不到就返回空串。 */
/**
 * 把"密钥形态"的片段挡在面板之外。
 *
 * 为什么要（2026-10-06 隐私审计）：这个日志是 NapCat 自己的输出，**真机实测里面会出现
 * `[WebUi] WebUi Token: placeholder-token` 这一行**；而 `readTail` 会把"最后一行"原样贴回面板，
 * 万一那一刻恰好是 token 行，密钥就进了浏览器（截图/录屏就跟着出去了）。
 * 这里按"键名 + 值"和"URL 查询参数"两种形态打码，够用且不会误伤普通日志。
 */
export function redactSecrets(text, mask = '<已隐藏>') {
  return String(text ?? '')
    .replace(/((?:token|secret|password|passwd|api[_-]?key|access[_-]?token)\s*[:=]\s*)\S+/gi, `$1${mask}`)
    .replace(/([?&](?:token|access_token|key|apikey|api_key|secret)=)[^&\s"']+/gi, `$1${mask}`)
}

/** 读一个小 JSON（失败就返回 null）：package.json 与 qq-control.json 都用它，读不到不影响面板。 */
function readJsonSafe(file, readFile = readFileSync) {
  try { return JSON.parse(String(readFile(file, 'utf8'))) } catch { return null }
}

/** 面板底部链接的素材：版本与仓库来自 package.json，控制台端口来自 qq-control.json。 */
export function panelLinkSources({ root = PLUGIN_ROOT, readFile = readFileSync } = {}) {
  const pkg = readJsonSafe(join(root, 'package.json'), readFile)
  const control = readJsonSafe(join(root, 'qq-control.json'), readFile)
  const port = Number(control?.ports?.control)
  // v0.8.0：控制台独立进程，默认端口 8880（8799 已弃用）
  return {
    version: typeof pkg?.version === 'string' ? pkg.version : '',
    repoUrl: typeof pkg?.repository?.url === 'string' ? pkg.repository.url : '',
    consolePort: Number.isInteger(port) && port > 0 && port < 65536 ? port : 8880,
  }
}

/** 当前宿主进程 booted 的 profile（与 dshmarket 同口径：CLI 的 `--profile <name>`）。 */
export function argvProfile(argv = process.argv) {
  const flag = argv.indexOf('--profile')
  if (flag !== -1 && flag + 1 < argv.length && !String(argv[flag + 1]).startsWith('-')) return String(argv[flag + 1])
  return undefined
}

/**
 * 解析宿主真正 booted 的 profile —— **两种宿主两种传法**（真机实测）：
 *   1. CLI：`dsh web --profile desktop` → 取 `--profile` 的值；
 *   2. 官方桌面端：把 **profile 目录当位置参数**传进来，命令行长这样
 *      `"DeepSeek Harness.exe" --expose-internals <…dsh-desktop-host/lib/index.js> <…\app.asar\dsh> C:\Users\<u>\.dsh\profiles\desktop <runtime> …`
 *      —— 一个 `--profile` 都没有。v0.6 第一版只认 ①，于是在桌面端里回落成 `web`，
 *      面板会去改 **web profile** 的配置（用户看着桌面端，改的却是另一个 profile）——必须按路径认。
 *   3. 都不匹配时回落 `web`（CLI 的默认 profile）。
 * @returns {{profile: string, source: 'argv-flag'|'argv-path'|'fallback', dir?: string}}
 */
export function resolveProfile({ argv = process.argv, env = process.env, exists = existsSync } = {}) {
  // ① `--profile <name>` 与 `--profile=<name>`（commander 两种都收）
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] ?? '')
    if (arg === '--profile' && index + 1 < argv.length && !String(argv[index + 1]).startsWith('-')) {
      return { profile: String(argv[index + 1]), source: 'argv-flag' }
    }
    if (arg.startsWith('--profile=')) {
      const value = arg.slice('--profile='.length)
      if (value !== '' && !value.startsWith('-')) return { profile: value, source: 'argv-flag' }
    }
  }
  // ② 官方桌面端把 profile **目录**当位置参数传进来（v0.6 真机实测的形态）
  for (const arg of argv) {
    if (typeof arg !== 'string' || arg.startsWith('-')) continue
    const match = /^(.*[\\/]profiles[\\/]([^\\/]+))[\\/]?$/.exec(arg)
    if (match) return { profile: match[2], source: 'argv-path', dir: match[1] }
  }
  // ③ 位置参数里直接给 profile 名：**不认**。
  //    第二轮审查核对过 CLI 源码（dsh/lib/bin.js）：profile 只能靠 `--profile` 给，
  //    位置参数是"给被启动 profile 的应用"的普通参数。放宽成"名字存在就认"会把
  //    随便一个应用参数当成 profile，写到另一个配置去——宁可不认，如实回落。
  return { profile: 'web', source: 'fallback' }
}

/** profile 目录：`$DSH_HOME/profiles/<name>`（DSH_HOME 未设则 `~/.dsh`）。 */
export function profileDirOf(profile, env = process.env) {
  const home = env.DSH_HOME && String(env.DSH_HOME).trim() !== '' ? String(env.DSH_HOME) : join(homedir(), '.dsh')
  return join(home, 'profiles', profile)
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(body)
}

async function readBody(request, limitBytes = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limitBytes) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * 挂载面板路由。
 * @param host  已 `inject` 到 `webServer` 的宿主上下文
 * @param options.profile  当前 profile 名
 * @param options.config   运行中的生效配置（插件自己的 config 对象）
 * @param options.defaults schema 默认值（用于"非默认"提示）
 * @param options.numberMeta 数值键的 `{ min, max, step, default }`（schema 现读；数值控件的范围来源）
 * @param options.logger   可选日志
 */
/**
 * v0.8.0：调试台回到**独立进程**（用户：控制台不依赖 dsh、能独立打开；端口统一 8880）。
 * 原挂在宿主 /qqai/console 下的直挂版（页面改写 / 反代 / 进程内 handler）整体退场；
 * /qqai/console 只剩一个 302/JSON 入口（consoleEntry）。
 */
export function mountQqAiPanel(host, options = {}) {
  const {
    profile = 'web',
    config = {},
    defaults = {},
    numberMeta = {},
    logger = { info() {}, warn() {}, error() {} },
    readFile = readFileSync,
    writeFile = writeFileSync,
    rename = renameSync,
    copy = copyFileSync,
    exists = existsSync,
    ensureDir = (dir) => mkdirSync(dir, { recursive: true }),
    unlink = unlinkSync,
    // env 可注入：测试必须能把 profile 目录指到临时目录，**绝不能**让测试写到真实 profile。
    env = process.env,
    // profile 目录可直接指定（桌面端把目录当位置参数传进来，见 resolveProfile）。
    dir = null,
    // 底部链接可直接覆盖（测试用）；默认从 package.json / qq-control.json 推。
    links = null,
    linkSources = {},
    // 端口探测可注入（测试里用真起一个 server / 指到空端口两种分支）。
    probe = probePort,
    // 快捷操作（启动 NapCat）的副作用可注入：测试**绝不能**真的去拉进程 / 跑 tasklist。
    spawnDetached = spawnDetachedProcess,
    // 调试台一键拉起用的"长驻后台进程"与等待时长（同样可注入，单测不真起进程）。
    spawnBackground = spawnBackgroundProcess,
    consoleWaitMs = 8000,
    // 端口起来之后还等 token 落盘（真机踩到过：读早了 → 302 里没有 token → 页面全"token 无效"）。
    consoleTokenWaitMs = 3000,
    exec = execFile,
    // 二维码那条路由要读图片字节 / 看 mtime：同样可注入（测试不去摸真机磁盘）。
    readBinary = readFileSync,
    stat = statSync,
    // 启动/停止之后等多久确认 13000 的状态变化（测试里给 0，别让单测白等 8 秒）。
    waylayWaitMs = 8000,
  } = options
  const patchFile = join(dir ?? profileDirOf(profile, env), 'cordis.patch.yml')
  const sources = panelLinkSources(linkSources)

  /** 二维码新鲜度口径：超过这个秒数没动过就不再内嵌（Waylay 沿用旧后端的同一口径）。 */
  const QR_STALE_SECONDS = 300

  /**
   * ── Waylay（2026-10-30 起真正在用的后端）───────────────────────────────
   *
   * 与 NapCat 的三处根本差异决定了这里**不能只换字符串**（详见 `lib/waylay-launch.js` 文件头）：
   *   ① Waylay 被 `NapCatWinBootHook.dll` 注入进 **QQ.exe 内部**，没有独立进程
   *      ⇒「停止」物理上只有一条路：结束那个监听 13000 的 QQ；
   *   ② 只有一个入口 bat，不需要在 launcher.bat / napcat.bat 之间猜；
   *   ③ 控制台是 13000 的**裸 HTTP**，`/api/status` 直接给 JSON，没有 token 要拼。
   *
   * 因此这里**不做提权、不写垫片**：NapCat 那套提权/垫片/心跳是为了绕过"非管理员 launcher.bat 秒退"，
   * Waylay 的入口是普通 `cmd /c bat`，照搬过来只会凭空多出两个失败点。
   */
  const waylayConfig = () => {
    const root = linkSources.root ?? PLUGIN_ROOT
    const fromControl = (control) => {
      const port = Number(control?.ports?.waylay)
      const configured = String(control?.waylayBat ?? '').trim()
      const bat = detectWaylayBat({ configured, env, exists }) || configured
      return {
        port: Number.isInteger(port) && port > 0 && port < 65536 ? port : WAYLAY_PORT,
        bat,
        uin: String(control?.waylayUin ?? '').trim(),
        logFile: bat !== '' ? waylayLogPath(bat) : '',
        qrFile: bat !== '' ? waylayQrPath(bat) : '',
      }
    }
    try {
      return fromControl(JSON.parse(String(readFile(join(root, 'qq-control.json'), 'utf8'))))
    } catch {
      return fromControl(null)
    }
  }

  /** 读一个本地 JSON；超时 / 连不上都当「拿不到」，绝不让面板因为状态接口慢而卡住。 */
  function waylayFetchJson(url, timeoutMs = 2500) {
    return new Promise((resolve) => {
      let settled = false
      const done = (value) => { if (settled !== true) { settled = true; resolve(value) } }
      const req = httpRequest(url, { timeout: timeoutMs }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => {
          try { done({ ok: res.statusCode === 200, json: JSON.parse(body) }) }
          catch { done({ ok: false, json: null, reason: 'status 不是合法 JSON' }) }
        })
      })
      req.on('timeout', () => { req.destroy(); done({ ok: false, json: null, reason: 'timeout' }) })
      req.on('error', (error) => done({ ok: false, json: null, reason: error.code || error.message }))
      req.end()
    })
  }

  /**
   * Waylay 当前状态。
   *
   * 刻意把 `listening`（端口在听）与 `loggedIn`（登录态）**分成两个字段**：
   * 2026-10-30 17:45 实测二者分离 —— 被顶号后自动重登，端口一直在听、`logged_in` 始终 false，
   * 发消息返回 `1006501 网络连接异常`。只看端口会得出"一切正常"这个错误结论。
   *
   * 这里不查 `tasklist`：PID 只在「停止」那条路上现场反查一次，
   * 否则每次面板轮询都白跑一条命令。
   */
  const waylayStatus = async () => {
    const { port, bat, logFile, qrFile } = waylayConfig()
    const listening = (await probe(port).catch(() => false)) === true
    const base = {
      listening, port, bat, logFile, qrFile,
      loggedIn: null, uin: '', nickname: '', uptimeSec: null, reverseClients: null,
      qr: { fresh: false, ageSeconds: -1, url: '' },
    }
    if (listening !== true) {
      return {
        ...base,
        level: 'off',
        text: bat !== ''
          ? `Waylay 未运行（${port} 没有监听）`
          : `找不到 Waylay 入口（waylayBat）：${WAYLAY_BAT_HINT}`,
      }
    }
    const live = await waylayFetchJson(`http://127.0.0.1:${port}/api/status`)
    const json = live.ok === true && live.json && typeof live.json === 'object' ? live.json : null
    const loggedIn = json === null ? null : (json.logged_in === true)
    const uptimeSec = Number.isFinite(Number(json?.uptime_sec)) ? Number(json.uptime_sec) : null
    const reversal = Number(json?.onebot?.reverse_clients)
    // 二维码新鲜度：与 NapCat 那条同一口径（`QR_STALE_SECONDS`），只是文件位置不同。
    const qr = (() => {
      if (qrFile === '') return { fresh: false, ageSeconds: -1, url: '' }
      try {
        const ageSeconds = Math.max(0, Math.round((Date.now() - Number(stat(qrFile).mtimeMs)) / 1000))
        const fresh = ageSeconds <= QR_STALE_SECONDS
        return { fresh, ageSeconds, url: fresh ? '/qqai/waylay/qr' : '' }
      } catch { return { fresh: false, ageSeconds: -1, url: '' } }
    })()
    let text = `Waylay 运行中（${port} 在听`
    text += uptimeSec === null ? '）' : `，已运行 ${Math.round(uptimeSec / 60)} 分钟）`
    if (loggedIn === false) text += ' · 但会话未就绪（端口在听≠能收发）'
    else if (loggedIn === true) text += ' · 已登录'
    else text += `（读不到 /api/status：${live.reason ?? '未知'}）`
    return {
      ...base,
      loggedIn,
      uin: String(json?.uin ?? ''),
      nickname: String(json?.nickname ?? ''),
      uptimeSec,
      reverseClients: Number.isFinite(reversal) ? reversal : null,
      qr,
      level: loggedIn === false ? 'warn' : (loggedIn === true ? 'ok' : 'warn'),
      text,
    }
  }

  /**
   * Waylay 快捷操作：**启动** / **停止**。
   *
   * 「停止」直接撞上 `napcat-launch.js` 立的铁律：**绝不能按镜像名杀 QQ**
   * （`taskkill /IM QQ.exe` 会连用户自己开的 QQ 一起杀掉）。
   * 解法是**按端口反查 PID**：只有监听 13000 的那个 QQ 才是被注入的；
   * `stopPlan()` 再核对进程名必须是 QQ 系、且不是控制台自己，三层任一不满足就拒绝执行。
   *
   * 三道门与 NapCat 那边一致：POST、同源守卫、只允许回环来源。
   */
  const waylayAction = async (request, response, kind) => {
    if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return }
    const remote = String(request.socket?.remoteAddress ?? '')
    const local = remote === '' || remote === '::1' || remote.startsWith('127.') || remote.startsWith('::ffff:127.')
    if (!local) { sendJson(response, 403, { ok: false, reason: '这个动作只允许本机访问' }); return }
    const guard = sameSiteGuard(request)
    if (!guard.ok) { sendJson(response, 403, { ok: false, reason: guard.reason }); return }
    const { port, bat, uin } = waylayConfig()
    const waitMs = Math.max(0, Number(waylayWaitMs) || 0)
    const waitPort = async (wantListening) => {
      const deadline = Date.now() + waitMs
      let state = (await probe(port).catch(() => false)) === true
      while (Date.now() < deadline && state !== wantListening) {
        await new Promise((resolve) => { setTimeout(resolve, 500) })
        state = (await probe(port).catch(() => false)) === true
      }
      return state
    }

    if (kind === 'stop') {
      // ★ 铁律：不按镜像名。只认「监听 13000 的那个 PID」，再核对进程名。
      const netstat = await runCommand(exec, 'netstat', ['-ano'])
      const found = parseListenerPid(netstat.stdout, port)
      if (found === null) {
        const reason = `没有找到监听 ${port} 的进程——Waylay 可能已经退出，或端口被改过`
        logger.info(`QQ助手 Waylay 停止被拒：${reason}`)
        sendJson(response, 200, { ok: false, action: kind, reason, panel: await snapshot() })
        return
      }
      const names = await runCommand(exec, 'tasklist', ['/FO', 'CSV', '/NH'])
      const nameOf = parseTasklist(names.stdout)
      const plan = stopPlan({ pid: found.pid, processName: nameOf.get(found.pid) ?? '', selfPid: process.pid })
      if (plan.ok !== true) {
        logger.warn(`QQ助手 Waylay 停止被拒：${plan.reason}`)
        sendJson(response, 200, { ok: false, action: kind, reason: plan.reason, panel: await snapshot() })
        return
      }
      const result = await spawnDetached({ command: plan.plan.file, args: plan.plan.args })
      const stillListening = await waitPort(false)
      // 🔴 别盲报成功：端口还在听就是没停掉（比如权限不够），如实说。
      if (stillListening !== false) {
        const reason = `已请求结束 PID ${found.pid}（${nameOf.get(found.pid)}），但等了 ${Math.round(waitMs / 1000)} 秒 ${port} 还在听——没停掉`
        logger.warn(`QQ助手 Waylay 停止：${reason}`)
        sendJson(response, 200, { ok: false, action: kind, pid: found.pid, stopped: false, reason, panel: await snapshot() })
        return
      }
      const reason = `已结束 PID ${found.pid}（${nameOf.get(found.pid)}）· ${port} 已释放 —— 这就是被注入的那个 QQ，机器人账号随之下线`
      logger.info(`QQ助手 Waylay 停止成功（pid ${found.pid}）`)
      sendJson(response, 200, { ok: true, action: kind, pid: found.pid, stopped: true, killed: result?.pid ?? 0, reason, panel: await snapshot() })
      return
    }

    // kind === 'start'
    const launch = waylayLaunchCommand(bat, { uin })
    if (launch === null) {
      sendJson(response, 200, {
        ok: false, action: kind, started: false,
        reason: `找不到 Waylay 入口脚本（waylayBat）：${WAYLAY_BAT_HINT}`,
        panel: await snapshot(),
      })
      return
    }
    if ((await probe(port).catch(() => false)) === true) {
      const reason = `${port} 已经在听了，没有重复启动（要重登就在 QQ 里退出再进，或先点「停止」）`
      logger.info(`QQ助手 Waylay 启动：${reason}`)
      sendJson(response, 200, { ok: true, action: kind, already: true, started: true, reason, panel: await snapshot() })
      return
    }
    const result = await spawnDetached({ command: launch.file, args: launch.args })
    const complained = `${result?.stderr ?? ''}`.trim()
    if (result?.failed === true || (typeof result?.code === 'number' && result.code !== 0)) {
      const detail = (complained || `${result?.stdout ?? ''}`.trim() || result?.message || '')
        .split(/\r?\n/).filter(Boolean).slice(0, 3).join(' / ')
      const reason = `启动命令没发出去（cmd 退出码 ${result?.code}）${detail ? `：${detail}` : '，没有任何错误输出'}`
      logger.warn(`QQ助手 Waylay 启动失败：${reason}`)
      sendJson(response, 200, { ok: false, action: kind, started: false, reason, panel: await snapshot() })
      return
    }
    const started = await waitPort(true)
    if (started !== true) {
      const logTail = (() => {
        try {
          const text = String(readFile(bat !== '' ? waylayLogPath(bat) : '', 'utf8'))
          return text.split(/\r?\n/).filter(Boolean).slice(-3).join(' / ')
        } catch { return '' }
      })()
      const reason = `启动命令已发出，但等了 ${Math.round(waitMs / 1000)} 秒 ${port} 还没在听`
        + `${logTail === '' ? `（注入日志 ${waylayLogPath(bat) || '未配置'} 没有新内容）` : ` —— 注入日志最后输出：${logTail}`}`
        + '。注意：注入进 QQ 后**不会弹 QQ 窗口**，看不到界面是正常的。'
      logger.warn(`QQ助手 Waylay 启动：${reason}`)
      sendJson(response, 200, { ok: false, action: kind, started: false, pid: result?.pid ?? 0, reason, panel: await snapshot() })
      return
    }
    // 端口起来了 ≠ 登录好了：再读一次 /api/status，把真实登录态说出来。
    const after = await waylayStatus()
    const reason = after.loggedIn === true
      ? `Waylay 已起来且已登录（QQ ${after.uin || '?'}）`
      : `Waylay 已起来（${port} 在听），但会话还没就绪（${after.loggedIn === false ? '需要扫码或自动重登' : '读不到登录态'}）`
        + '。二维码会出现在下面，超过 5 分钟会自动隐藏。'
    logger.info(`QQ助手 Waylay 启动成功（pid ${result?.pid ?? 0}）`)
    sendJson(response, 200, {
      ok: true, action: kind, started: true, loggedIn: after.loggedIn, pid: result?.pid ?? 0, reason, panel: await snapshot(),
    })
  }

  /**
   * 面板内嵌二维码：`GET /qqai/waylay/qr` 直接把 Waylay 写出来的 `qrcode.png` 交给页面。
   *
   * 与 NapCat 那条（`/qqai/napcat/qr`）同一套守卫口径：只给本机 + 同源，
   * 因为它读的是本机文件。图片本身不含密钥，但没必要对外。
   */
  const waylayQrEntry = (request, response) => {
    if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }); response.end(); return }
    const remote = String(request.socket?.remoteAddress ?? '')
    const local = remote === '' || remote === '::1' || remote.startsWith('127.') || remote.startsWith('::ffff:127.')
    if (!local) { sendJson(response, 403, { ok: false, reason: '二维码只给本机看' }); return }
    const guard = sameSiteGuard(request, { requireJson: false })
    if (!guard.ok) { sendJson(response, 403, { ok: false, reason: guard.reason }); return }
    const { qrFile } = waylayConfig()
    if (qrFile === '') {
      sendJson(response, 404, { ok: false, reason: `还没有二维码：配置里没写 waylayBat，推不出路径（${WAYLAY_BAT_HINT}）` })
      return
    }
    let ageSeconds = -1
    try {
      ageSeconds = Math.max(0, Math.round((Date.now() - Number(stat(qrFile).mtimeMs)) / 1000))
    } catch { /* 读不到就当没有 */ }
    if (ageSeconds < 0) {
      sendJson(response, 404, { ok: false, reason: `还没有二维码（读不到 ${qrFile}）：先点「启动 Waylay」，等它把码写出来` })
      return
    }
    if (ageSeconds > QR_STALE_SECONDS) {
      sendJson(response, 404, { ok: false, reason: `二维码已经过期（${ageSeconds} 秒前的那张，超过 ${QR_STALE_SECONDS} 秒）——点「停止」再「启动」重新走一遍登录` })
      return
    }
    try {
      const image = readBinary(qrFile)
      response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'content-length': String(image.length) })
      response.end(image)
    } catch (error) {
      sendJson(response, 500, { ok: false, reason: `读二维码失败：${error?.message ?? error}` })
    }
  }

  /**
   * 调试台（独立控制台）的状态：**它是另一个进程，插件不会替你启动**。
   * 第一版只给了一个裸链接，用户点进去只看到连不上——现在每次读面板都探一次端口（结果缓存 2 秒，
   * 免得面板刷新时反复连），并把"没启动时该跑哪条命令"一并告诉前端。
   */
  let consoleProbe = { at: 0, running: false }
  const consoleStatus = async () => {
    if (Date.now() - consoleProbe.at < 2000) return consoleProbe
    const running = await probe(sources.consolePort).catch(() => false)
    consoleProbe = { at: Date.now(), running: running === true }
    return consoleProbe
  }
  const footerLinksFor = async () => {
    if (Array.isArray(links)) return links
    // ★ v0.8.0：控制台回到独立进程（不依赖 dsh）。running 是**真实探测**；
    //   没起来时点面板里的「调试台」会先自动拉起（/qqai/console 入口），起来后 302 进去。
    return panelFooterLinksWithConsole({
      ...sources,
      consoleRunning: (await consoleStatus()).running,
      startCommand: consoleStartCommand(linkSources.root ? { root: linkSources.root } : {}),
      // 账号入口 = Waylay 的裸 HTTP 控制台（没有 token 要拼）。
      accountUrl: `http://127.0.0.1:${waylayConfig().port}/`,
    })
  }

  /**
   * 原子写：同目录临时文件（随机名 + `wx` + 0600）→ rename 覆盖。
   * 为什么必须：写到一半崩掉会留下**撕裂的 YAML**，而 DSH 下次启动对"存在但解析不了"的 patch
   * 是**直接报错**的（loadOptionalPatches）——那等于把宿主搞挂。
   *
   * 三条被对抗性审查逼出来的规矩：
   *   ① **rename 失败绝不退化成"直接覆盖原名"**：Windows 上 rename 覆盖已存在文件会瞬时
   *      EACCES/EBUSY/EPERM（平台自己的 dsh-atomic-write 为此重试 8 次）。退化成 writeFile
   *      就等于用一条**非原子**的路径去写活配置，还与"原文件未被破坏"的说法自相矛盾。
   *      现在：重试若干次 → 仍失败就**保持原文件不动**、清掉临时文件、如实报错。
   *   ② **临时文件必须清干净**（成功/失败都不留），失败时也别改名叫 `.orphan` 攒垃圾。
   *   ③ **重试要 await，不许忙等**：这是 HTTP 处理器里的路径，同步自旋会把宿主的整个事件循环
   *      按住（实测一次失败写要 ~212ms），期间网页端所有请求都卡住。
   */
  const writeAtomic = async (file, text, { attempts = 8, waitMs = 25 } = {}) => {
    const tmp = `${file}.qqai-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`
    await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    let lastError = null
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await rename(tmp, file)
        return
      } catch (error) {
        lastError = error
        // 只有"瞬时占用"才值得重试；其余（如目录不存在）立刻放弃。
        const transient = ['EACCES', 'EBUSY', 'EPERM', 'EEXIST'].includes(error?.code)
        if (!transient) break
        await new Promise((resolve) => { setTimeout(resolve, waitMs) })
      }
    }
    try { if (exists(tmp)) await unlink(tmp) } catch { /* 清不掉也不能再抛 */ }
    throw lastError ?? new Error('rename 失败')
  }

  const readPatch = () => {
    if (!exists(patchFile)) return { yaml: null, reason: '' }
    try { return { yaml: String(readFile(patchFile, 'utf8')), reason: '' } } catch (error) {
      logger.warn(`QQ助手 面板：读不到 ${patchFile}：${error.message}`)
      // 读失败 ≠ 文件不存在：报错要说清，否则面板会说"没有配置文件"误导人。
      return { yaml: null, reason: `读配置文件失败：${error.message}` }
    }
  }

  /**
   * 分层警告：DSH 的配置是**分层叠加**的（bundle → profile patch → 家目录 patch → `--patch` 覆盖），
   * 后面的层**整体替换**前面的 config 对象。面板只写 profile 层，所以当家目录 patch 里也有本插件时，
   * 这里必须如实说出来——否则用户会看到"写入成功"却怎么点都没反应（第二轮的 P3 就是这个）。
   * 平台自己的 dsh-config-editor 遇到同样情况是直接抛错的；我们做不到那么强，至少要**说清楚**。
   */
  const hierarchyWarning = () => {
    try {
      const home = env.DSH_HOME && String(env.DSH_HOME).trim() !== '' ? String(env.DSH_HOME) : join(homedir(), '.dsh')
      const homePatch = join(home, 'cordis.patch.yml')
      if (!exists(homePatch)) return ''
      const text = String(readFile(homePatch, 'utf8'))
      if (!text.includes(PLUGIN_ID)) return ''
      return `注意：${homePatch} 里也有 ${PLUGIN_ID} 的配置。DSH 的层叠顺序里**家目录 patch 盖过 profile 层**，`
        + '所以这里写入的开关可能不生效——要改的是那一层（平台自己的配置编辑器遇到这种情况会直接拒绝写入）。'
    } catch { return '' }
  }

  /**
   * 桥的运行状态（读插件的 `qq-runtime.json` 快照）。
   *
   * 面板要回答的是「登录了没有 / 连上了没有 / 为什么不回」这三件事：
   *   - `present`：快照文件在不在（桥启动时会**强制**写一次，之后有事件才写）；
   *   - `lastInboundAt`：最近一条**入站**消息的时间（`recentTraces[0]`，有它 = QQ 那边真的连上了）；
   *   - `topReason`：最近被拦得最多的原因（白名单 / 静默 / 限流…），直接告诉用户"为什么不回"。
   * ⚠️ 快照是**按需**写的（空闲时几分钟不更新很正常），所以**不能**用"多久没更新"判断桥死不死的——
   *    只有"文件都没有"才算没跑起来。读不到就如实说读不到（不假装在线）。
   */
  const bridgeStatus = () => {
    // 与 QQBridge 的 `this.dataRoot` 同一口径：dataDir 优先，其次 cwd，最后宿主 cwd。
    // 这里少一档就会变成"桥在写、面板说没有"——两边都正常，只是看的不是一个目录。
    const dataDir = config && typeof config.dataDir === 'string' ? config.dataDir.trim() : ''
    const dir = dataDir !== ''
      ? dataDir
      : (config && typeof config.cwd === 'string' && config.cwd.trim() !== '' ? config.cwd : process.cwd())
    const file = join(dir, 'qq-runtime.json')
    try {
      if (!exists(file)) {
        return { present: false, file, reason: `还没有运行快照（${file}）——插件刚装上、没启用，或它的工作目录不是这里` }
      }
      const doc = JSON.parse(String(readFile(file, 'utf8')))
      const now = Date.now()
      const updatedAt = Number(doc?.updatedAt) || 0
      const ageSeconds = updatedAt > 0 ? Math.max(0, Math.round((now - updatedAt) / 1000)) : null
      const recent = Array.isArray(doc?.recentTraces) ? doc.recentTraces[0] : null
      const lastInboundAt = Number(recent?.startedAt) || 0
      const top = Array.isArray(doc?.trace?.topReasons) ? doc.trace.topReasons[0] : null
      return {
        present: true,
        file,
        updatedAt,
        ageSeconds,
        uptimeSeconds: Number(doc?.uptimeSeconds) || 0,
        version: typeof doc?.version === 'string' ? doc.version : '',
        // `null` = 还没收到过 NapCat 的 bot_online/bot_offline 通知（"不知道"，不是"离线"）。
        botOnline: doc?.botOnline === true ? true : (doc?.botOnline === false ? false : null),
        lastInboundAt,
        lastInboundAgoSeconds: lastInboundAt > 0 ? Math.max(0, Math.round((now - lastInboundAt) / 1000)) : null,
        traceTotal: Number(doc?.trace?.total) || 0,
        topReason: top && typeof top.reason === 'string'
          ? { reason: top.reason, count: Number(top.count) || 0 }
          : null,
        /**
         * ★ v0.6.8：**最近来信的会话**（`u:2000000001` / `g:3000000001` 这种 chatKey）。
         * 白名单面板拿它做「一键加入」——不用让用户自己去查 QQ 号/群号，直接从最近的来信里挑。
         */
        recentChats: (() => {
          const out = []
          const seen = new Set()
          for (const trace of Array.isArray(doc?.recentTraces) ? doc.recentTraces : []) {
            const chatKey = typeof trace?.chatKey === 'string' ? trace.chatKey : ''
            const match = /^([ug]):(\d+)$/.exec(chatKey)
            if (!match || seen.has(chatKey)) continue
            seen.add(chatKey)
            out.push({
              chatKey,
              kind: match[1] === 'u' ? 'user' : 'group',
              id: Number(match[2]),
              at: Number(trace?.startedAt) || 0,
            })
            if (out.length >= 8) break
          }
          return out
        })(),
      }
    } catch (error) {
      return { present: false, file, reason: `运行快照读不了：${error.message}` }
    }
  }

  /**
   * 扩展接缝的**运行时**状态（v0.7.0，面板「实验性」组下面那几行）。
   *
   * 为什么不给 issue #4 说的 `chips`（provider 声明"工具在面板里的展示名与用途"）：
   * 那要再发明一套展示契约，而工具自己的 `description` 已经写了用途。这里给的是**运行时事实**——
   * 出口挂没挂上（走哪条机制）、登记了哪些 provider、最近一次注入注入了什么 / 跳过了什么。
   * 这些只存在于**运行中的桥**里：拿不到（老宿主 / 面板被单独调用）就返回 null，界面只显示开关状态、不编造。
   */
  const reportExtensions = () => {
    try {
      return typeof options.bridge?.extensionReport === 'function' ? options.bridge.extensionReport() : null
    } catch {
      return null
    }
  }

  const snapshot = async () => {
    const { yaml, reason } = readPatch()
    const fileValues = {}
    /**
     * v0.7.8：按**行类型**决定怎么读文件里的值。下拉（`select`）与文本（`text`）的 schema 就是字符串，
     * 走默认口径会把 `decoy` / 金丝雀读成 null ⇒ 面板上刚写完的那一行永远显示不成"更新中"。
     */
    if (yaml !== null) {
      for (const key of PANEL_KEYS) {
        const rowType = PANEL_ROW_BY_KEY.get(key)?.type
        fileValues[key] = readPatchValue(yaml, key, PLUGIN_ID, { asString: rowType === 'select' || rowType === 'text' })
      }
    }
    const warning = hierarchyWarning()
    return {
      ...panelSnapshot(config, { defaults, fileValues, numberMeta, extensions: reportExtensions() }),
      // 磁盘上那一版的版本号（每次现读：热重载复用 ESM 缓存，缓存一次会永远停在宿主启动那一刻）。
      pluginVersion: readPluginVersion(),
      profile,
      patchFile,
      patchExists: yaml !== null && reason === '',
      patchReason: reason,
      notes: PANEL_NOTES,
      warnings: warning === '' ? [] : [warning],
      // 「相关链接」整组（第一条就是账号入口）——客户端把它渲染在**标题正下方、开关分组之前**。
      links: await footerLinksFor(),
      // Waylay（当前真正在用的后端）：`listening` 与 `loggedIn` 是两件事，客户端必须分开显示。
      waylay: await waylayStatus(),
      // ★ v0.6.8：「已经登录了，面板却一点反馈都没有」——面板以前只知道 NapCat 进程在不在，
      //   不知道**桥有没有连上、最近有没有收到消息、消息为什么没回**。这些全都写在插件的运行快照
      //   `qq-runtime.json` 里（桥每 2 秒最多写一次），读它就能给出人话状态。
      bridge: bridgeStatus(),
    }
  }

  /**
   * 调试台入口（v0.8.0）：控制台是**独立进程**（127.0.0.1:<consolePort>，默认 8880），不依赖 dsh。
   * 跑着就 302 过去（token 从 qq-control.json 读出，只出现在这一次响应里，不进面板载荷）；
   * 没跑就先拉起（普通 node 进程，不提权），起不来给一页说明。
   * `?format=json`：桌面端开不了新窗口，客户端拿绝对地址自己去开。
   */
  const consoleEntry = async (request, response) => {
    if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }); response.end(); return }
    const guard = sameSiteGuard(request, { requireJson: false })
    if (!guard.ok) { sendJson(response, 403, { ok: false, reason: guard.reason }); return }
    let status = await consoleStatus()
    const wantsJson = String(request.url ?? '').includes('format=json')
    // 没在跑 ⇒ **先拉起来**（用户点「调试台」的意图就是"我要用它"）。
    let attempt = null
    if (status.running !== true) {
      attempt = await ensureConsole()
      status = { at: Date.now(), running: attempt.running === true }
    }
    if (status.running) {
      const control = readJsonSafe(join(linkSources.root ?? PLUGIN_ROOT, 'qq-control.json'), readFile)
      // 刚拉起时用 `ensureConsole` 已经等到的那份 token（它等过落盘）；否则现读。
      const token = (typeof attempt?.token === 'string' && attempt.token !== '')
        ? attempt.token
        : (typeof control?.token === 'string' ? control.token : '')
      const location = `http://127.0.0.1:${sources.consolePort}/${token ? `?token=${encodeURIComponent(token)}` : ''}`
      if (wantsJson) { sendJson(response, 200, { ok: true, running: true, url: location, tokenReady: token !== '' }); return }
      response.writeHead(302, { location, 'cache-control': 'no-store' })
      response.end()
      return
    }
    const command = consoleStartCommand(linkSources.root ? { root: linkSources.root } : {})
    const why = attempt?.reason ?? '控制台没有在运行'
    if (wantsJson) {
      sendJson(response, 200, { ok: false, running: false, url: '', command, reason: why, started: attempt?.started === true, pid: attempt?.pid ?? 0 })
      return
    }
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>控制台没起来</title><style>body{font:14px/1.7 system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1.2rem;color:#111}
code{background:#f3f4f6;padding:.15rem .4rem;border-radius:4px}pre{background:#f3f4f6;padding:.8rem;border-radius:8px;overflow:auto}
h1{font-size:1.15rem}.why{background:#fff7ed;border-left:3px solid #f59e0b;padding:.5rem .8rem;border-radius:6px}</style></head><body><h1>控制台没能自动起来</h1>
<p class="why">${why.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>
<p>它是<strong>独立进程</strong>（不依赖 dsh，端口 <code>127.0.0.1:${sources.consolePort}</code>），
自动拉起失败时，在插件目录里跑这一条即可（输出会直接显示在终端里）：</p>
<pre>${command.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>
<p>起来之后再点一次面板里的「调试台」就能进去。</p>
</body></html>`
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(html)
  }

  /**
   * **一键拉起调试台**：没在跑就先起一个（普通 node 进程，不提权、不写垫片），
   * 然后等端口起来（最多 `consoleWaitMs`）再让调用方决定是 302 进去还是说明原因。
   *
   * 为什么放在入口里而不是单独一个按钮：用户点「调试台」的意图就是"我要用它"，
   * 先弹一句"请自己去终端敲命令"是多余的；**起来了再进去**才是这个链接该有的行为。
   */
  const ensureConsole = async () => {
    const plan = consoleLaunchPlan({
      ...(linkSources.root ? { root: linkSources.root } : {}),
      // 走调用方注入的 exists（单测里插件根是临时目录，没有真实入口文件）。
      exists,
    })
    if (plan.ok !== true) return { running: false, started: false, pid: 0, plan, reason: plan.reason }
    let pid = 0
    try {
      const spawned = spawnBackground(plan)
      pid = spawned.pid ?? 0
      logger.info(`QQ助手 调试台：已拉起（pid ${pid}）${plan.entry}`)
    } catch (error) {
      const reason = `拉起调试台失败：${error?.message ?? error}`
      logger.warn(`QQ助手 调试台：${reason}`)
      return { running: false, started: false, pid: 0, plan, reason }
    }
    const waited = Math.max(0, Number(consoleWaitMs) || 0)
    const deadline = Date.now() + waited
    let running = false
    while (Date.now() < deadline && running !== true) {
      await new Promise((resolve) => { setTimeout(resolve, 500) })
      running = await probe(sources.consolePort).catch(() => false)
    }
    running = running === true || await probe(sources.consolePort).catch(() => false)
    if (running) consoleProbe = { at: Date.now(), running: true }
    /**
     * **等 token 落盘**（2026-10-06 真机踩到）：控制台"开始监听"与"写 `qq-control.json`"之间
     * 有一小段窗口期，这时候读到的 token 可能是空的 ⇒ 302 少了 `?token=`，
     * 用户看到的就是"满屏 token 无效、点哪都没反应"的那版页面（看起来像"只是个页面"）。
     * 所以确认端口之后再等文件里出现 token（最多 `consoleTokenWaitMs`）。
     */
    let token = ''
    if (running) {
      const tokenDeadline = Date.now() + Math.max(0, Number(consoleTokenWaitMs) || 0)
      for (;;) {
        const control = readJsonSafe(join(linkSources.root ?? PLUGIN_ROOT, 'qq-control.json'), readFile)
        token = typeof control?.token === 'string' ? control.token : ''
        if (token !== '' || Date.now() >= tokenDeadline) break
        await new Promise((resolve) => { setTimeout(resolve, 200) })
      }
    }
    return {
      running,
      started: true,
      pid,
      token,
      plan,
      reason: running
        ? `调试台已经起来了（127.0.0.1:${sources.consolePort}${token === '' ? '；但还没读到它的 token，页面会提示 token 无效——再点一次即可' : ''}）`
        : `已经拉起进程（pid ${pid}），但等了 ${Math.round(waited / 1000)} 秒端口 ${sources.consolePort} 还没通——可能是启动时报错了，在插件目录里手动跑一次就能看到输出`,
    }
  }

  /**
   * 单键校验 + 归一化（v0.6.8 起写入口统一走这里，单键与批量两条路由共用）：
   *   - 白名单外的键直接拒；
   *   - 布尔行只收 true/false；
   *   - 数值行只收**整数**且在 schema 的 [min,max] 内（范围由 `numberMeta` 现读；拿不到就 fail closed）；
   *   - 时段行按引擎口径校验并归一化成 `HH:MM-HH:MM`。
   * 返回 `{ ok, writeValue, reason }`——`writeValue` 才是真正写进配置的值。
   */
  const validateEntry = (key, value) => {
    const entry = PANEL_ROW_BY_KEY.get(key)
    if (!PANEL_KEYS.includes(key) || entry === undefined) {
      return { ok: false, reason: `不在面板白名单里的键：${key || '(空)'}` }
    }
    if (entry.type === 'number') {
      const meta = numberMeta?.[key]
      /**
       * **范围未知就拒绝**（fail closed）：`numberMeta` 由宿主从 schema 现读传入，
       * 拿不到它说明调用方没接好——这时候"放行任意数字"等于把 schema 的校验绕过，
       * 写进配置的值会让宿主启动时直接校验失败。宁可拒绝并说清楚。
       */
      if (meta === undefined) return { ok: false, reason: `${key} 缺少范围信息（numberMeta 未接好），本次不写入` }
      const num = typeof value === 'number' ? value : NaN
      if (!Number.isFinite(num)) return { ok: false, reason: `${key} 是数值项，只接受数字（收到 ${JSON.stringify(value)}）` }
      if (!Number.isInteger(num)) return { ok: false, reason: `${key} 只接受整数（收到 ${num}）` }
      // ⚠️ 用 `metaNumberOrNull`：schema 没写 min/max 时 meta 里是 null，而 `Number(null) === 0`，
      //    直接 Number() 会把"没有范围"读成 [0,0]，于是像 `botQq` 这种键永远写不进去（真机踩过）。
      const min = metaNumberOrNull(meta.min)
      const max = metaNumberOrNull(meta.max)
      if ((min !== null && num < min) || (max !== null && num > max)) {
        const range = min !== null && max !== null ? `${min}–${max}` : (min !== null ? `≥ ${min}` : `≤ ${max}`)
        return { ok: false, reason: `${key} 超出范围：${range}（收到 ${num}）` }
      }
      return { ok: true, writeValue: num }
    }
    if (entry.type === 'times') {
      const normalized = normalizeQuietRanges(value)
      if (normalized.ok !== true) return { ok: false, reason: normalized.reason }
      return { ok: true, writeValue: normalized.ranges }
    }
    /**
     * 号码列表（v0.6.8，白名单 `allowUsers` / `allowGroups`）：只收**正整数**数组
     * （schema 是 `z.array(z.number())`，OneBot 的 user_id 也是数字——写成字符串会永远匹配不上）。
     */
    if (entry.type === 'list') {
      const normalized = normalizeNumberList(value)
      if (normalized.ok !== true) return { ok: false, reason: normalized.reason }
      return { ok: true, writeValue: normalized.list }
    }
    /**
     * 下拉选择（v0.7.8）：只收 `options` 里列出的值。
     *
     * **必须按白名单校验，不能只信前端**：这些值会写进 profile 的 patch，而宿主启动时
     * 会拿它去跑引擎——写个 `decoyy` 进去，引擎那边 `MODES` 认不出就会一路走到兜底分支，
     * 行为变成"看起来在防护、实际没防"。宁可 400 拒掉并把可选值回给用户。
     */
    if (entry.type === 'select') {
      const allowed = (Array.isArray(entry.options) ? entry.options : []).map((item) => item.value)
      if (typeof value !== 'string' || allowed.includes(value) !== true) {
        return {
          ok: false,
          reason: `${key} 只接受这几档之一：${allowed.join(' / ')}（收到 ${JSON.stringify(value)}）`,
        }
      }
      return { ok: true, writeValue: value }
    }
    /**
     * 单行文本（v0.7.8）：有 `validate` 就走它（金丝雀那三条硬规矩在 `normalizeCanary` 里，带具体原因）；
     * 没有就只做长度兜底。两种都**返回归一化后的值**——写进配置的永远是校验过的那个。
     */
    if (entry.type === 'text') {
      if (typeof entry.validate === 'function') {
        const checked = entry.validate(value)
        if (checked?.ok !== true) return { ok: false, reason: checked?.reason ?? `${key} 校验未通过` }
        return { ok: true, writeValue: checked.value }
      }
      if (typeof value !== 'string') return { ok: false, reason: `${key} 只接受字符串（收到 ${JSON.stringify(value)}）` }
      const max = Number.isFinite(Number(entry.maxLen)) ? Number(entry.maxLen) : 64
      if (value.length > max) return { ok: false, reason: `${key} 最多 ${max} 个字符（收到 ${value.length} 个）` }
      return { ok: true, writeValue: value.trim() }
    }
    if (typeof value !== 'boolean') return { ok: false, reason: '只接受布尔开关（true/false）' }
    return { ok: true, writeValue: value }
  }

  /**
   * 把一批键**一次写进** profile 的 patch（v0.6.8：合并写入）。
   * 任何一条不合法就整批拒掉（不做部分写入）；只有真的有变化才落盘 + 备份。
   * 返回 `{ ok, changed, entries, reason, status }`。
   */
  const writeEntries = async (pairs) => {
    const validated = []
    for (const pair of pairs) {
      const checked = validateEntry(pair.key, pair.value)
      if (checked.ok !== true) return { ok: false, reason: checked.reason, status: 400 }
      validated.push({ key: pair.key, value: pair.value, writeValue: checked.writeValue })
    }
    const { yaml, reason } = readPatch()
    if (yaml === null) return { ok: false, reason: reason || `这个 profile 还没有配置文件：${patchFile}`, status: 400 }
    let text = yaml
    let changed = false
    for (const item of validated) {
      const result = upsertPatchValue(text, item.key, item.writeValue, { pluginId: PLUGIN_ID })
      if (result.ok !== true) return { ok: false, reason: result.reason, status: 400 }
      text = result.yaml
      if (result.changed === true) changed = true
    }
    if (changed) {
      try {
        ensureDir(dirname(patchFile))
        copy(patchFile, `${patchFile}.bak-qqai`)
        await writeAtomic(patchFile, text)
      } catch (error) {
        return { ok: false, reason: `写入失败（原文件保持不动）：${error.message}`, status: 500 }
      }
      logger.info(`QQ助手 面板：${validated.map((item) => `${item.key} → ${JSON.stringify(item.value)}`).join('，')}`
        + `（写入 ${patchFile}，备份 .bak-qqai）`)
    }
    return { ok: true, changed, entries: validated.map((item) => ({ key: item.key, value: item.value })) }
  }

  const registrations = [
    {
      kind: 'exact',
      path: '/qqai/panel',
      // 返回 promise：宿主不关心返回值，但调用方（含单测）可以 await 到真正写完响应。
      handler: (request, response) => {
        if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }); response.end(); return undefined }
        return snapshot()
          .then((payload) => sendJson(response, 200, payload))
          .catch((error) => sendJson(response, 500, { ok: false, reason: `读取面板失败：${error?.message ?? error}` }))
      },
    },
    {
      kind: 'exact',
      path: '/qqai/account',
      // 返回 promise：宿主不关心返回值，但调用方（含单测）可以 await 到真正写完响应。
      handler: (request, response) => {
        const ask = { pluginRoot: linkSources.root ?? PLUGIN_ROOT, waylayPort: waylayConfig().port }
        try {
          return Promise.resolve(accountEntry(request, response, ask))
            .catch((error) => sendJson(response, 500, { ok: false, reason: `账号入口失败：${error?.message ?? error}` }))
        } catch (error) {
          sendJson(response, 500, { ok: false, reason: `账号入口失败：${error?.message ?? error}` })
          return undefined
        }
      },
    },
    {
      /**
       * v0.7.11：**只读对话视图**（`/qqai/chatlog`）。
       *
       * 它解决的是那个死循环：想看她在 QQ 里说了什么 → 回 dsh 网页点开 `qq-…` 会话 →
       * **点开就拿走那个会话的写句柄**（dsh 的锁对活着的持有者永不过期）→ 桥再也抢不到，
       * 她下一句被静默等锁拖住。这个页面直接读 `qq-memory/*.json`（桥自己写的），
       * 只读打开，**不涉及任何锁**，所以看它不会影响她说话。
       */
      kind: 'exact',
      path: '/qqai/chatlog',
      handler: (request, response) => {
        if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }); response.end(); return }
        const guard = sameSiteGuard(request, { requireJson: false })
        if (!guard.ok) { sendJson(response, 403, { ok: false, reason: guard.reason }); return }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        response.end(renderChatLogHtml({ version: readPluginVersion() }))
      },
    },
    {
      kind: 'exact',
      path: '/qqai/chatlog/data',
      handler: (request, response) => {
        if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }); response.end(); return }
        const guard = sameSiteGuard(request, { requireJson: false })
        if (!guard.ok) { sendJson(response, 403, { ok: false, reason: guard.reason }); return }
        let url = null
        try { url = new URL(String(request.url ?? '/'), 'http://127.0.0.1') } catch {
          sendJson(response, 400, { ok: false, reason: '请求地址解析不了' }); return
        }
        const chatKey = String(url.searchParams.get('chat') ?? '')
        const asked = Number(url.searchParams.get('limit'))
        const limit = Number.isFinite(asked) && asked > 0 ? Math.min(2000, Math.floor(asked)) : 400
        try {
          const data = buildChatLog({ memoryDir: memoryDirOf(config), chatKey, limit, readFile })
          sendJson(response, 200, { ok: true, version: readPluginVersion(), ...data })
        } catch (error) {
          logger.warn(`QQ助手 对话视图读取失败：${error?.message ?? error}`)
          sendJson(response, 500, { ok: false, reason: `读记忆失败：${error?.message ?? error}` })
        }
      },
    },
    {
      /**
       * v0.8.0：调试台 = **独立进程**（127.0.0.1:<consolePort>，默认 8880），不依赖 dsh。
       * 这里只是入口：跑着就 302 过去（带 token），没跑先自动拉起，起不来给说明页；
       * `?format=json` 给桌面端拿绝对地址。
       */
      kind: 'exact',
      path: '/qqai/console',
      handler: (request, response) => consoleEntry(request, response).catch((error) => {
        sendJson(response, 500, { ok: false, reason: `调试台入口失败：${error?.message ?? error}` })
      }),
    },
    {
      /**
       * ★ 2026-10-30 起后端只有 Waylay；v0.8.0 把 NapCat 那三条路由（/qqai/napcat/*）
       * 与 lib/napcat-launch.js 一起退场——Waylay 已接管启动/停止/二维码全链路。
       */
      kind: 'exact',
      path: '/qqai/waylay/start',
      handler: (request, response) => waylayAction(request, response, 'start')
        .catch((error) => sendJson(response, 500, { ok: false, reason: `启动 Waylay 失败：${error?.message ?? error}` })),
    },
    {
      kind: 'exact',
      path: '/qqai/waylay/stop',
      handler: (request, response) => waylayAction(request, response, 'stop')
        .catch((error) => sendJson(response, 500, { ok: false, reason: `停止 Waylay 失败：${error?.message ?? error}` })),
    },
    {
      kind: 'exact',
      path: '/qqai/waylay/qr',
      handler: (request, response) => waylayQrEntry(request, response),
    },
    {
      /**
       * ★ 2026-10-31：「选择数据根目录…」——弹一个**系统自带的选文件夹窗口**，选完直接写配置。
       *
       * 为什么必须由服务端来弹：浏览器的 `showDirectoryPicker()` 与
       * `<input webkitdirectory>` **都拿不到绝对路径**（安全限制），而这里要写进配置的
       * 恰恰就是绝对路径。面板是"宿主进程 + 浏览器前端"的结构，所以只有宿主能拿到。
       *
       * 为什么只用 PowerShell（Windows）：系统自带、零依赖。其它平台**如实回"不支持，请直接填路径"**
       * ——绝不做一个"点了没反应"的按钮。
       *
       * 取消 = `ok:false` + 明确的「已取消」，不是 `ok:true` 带空值：
       * 后者会让面板把空串当成用户的真实选择写进配置，等于把数据根目录**清空**。
       */
      kind: 'exact',
      path: '/qqai/data-dir/pick',
      handler: async (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return }
        const guard = sameSiteGuard(request)
        if (!guard.ok) { sendJson(response, 403, { ok: false, reason: guard.reason }); return }
        if (process.platform !== 'win32') {
          sendJson(response, 200, { ok: false, reason: '这个按钮只在 Windows 上可用；请直接把绝对路径填进「数据根目录」' })
          return
        }
        const startDir = String(config.cwd ?? '')
        const picked = await pickFolderDialog({ startDir })
        if (picked.ok !== true) { sendJson(response, 200, { ok: false, reason: picked.reason }); return }
        const wrote = await writeEntries([{ key: 'dataDir', value: picked.path }])
        if (wrote.ok !== true) {
          sendJson(response, wrote.status ?? 400, { ok: false, reason: wrote.reason })
          return
        }
        sendJson(response, 200, {
          ok: true,
          changed: wrote.changed === true,
          key: 'dataDir',
          value: wrote.entries[0].value,
          reason: `数据根目录 → ${wrote.entries[0].value}`,
          note: wrote.changed ? `${PANEL_NOTES.apply}；**旧数据不会自动搬**，要搬就把 qq-* 整个拷过去（含 qq-canary.json）` : '已经是这个值',
          panel: await snapshot(),
        })
      },
    },
    {
      kind: 'exact',
      path: '/qqai/panel/set',
      handler: async (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return }
        const guard = sameSiteGuard(request)
        if (!guard.ok) { sendJson(response, 403, { ok: false, reason: guard.reason }); return }
        let body
        try { body = await readBody(request) } catch (error) {
          sendJson(response, 400, { ok: false, reason: `请求体不是合法 JSON：${error.message}` })
          return
        }
        const wrote = await writeEntries([{ key: String(body?.key ?? ''), value: body?.value }])
        if (wrote.ok !== true) {
          sendJson(response, wrote.status ?? 400, { ok: false, reason: wrote.reason })
          return
        }
        const first = wrote.entries[0]
        sendJson(response, 200, {
          ok: true,
          changed: wrote.changed === true,
          key: first.key,
          value: first.value,
          profile,
          patchFile,
          note: wrote.changed ? PANEL_NOTES.apply : '已经是这个值',
          panel: await snapshot(),
        })
      },
    },
    {
      /**
       * ★ v0.6.8：**合并写入**（一次写盘 = 宿主只重载一次）。
       *
       * 为什么（用户 2026-10-19「连续开了几个开关以后就会鬼畜」）：每写一个键都触发一次插件热重载
       * （实测 ~2.3 秒/次），连点几个开关就是几次重载互相打断——面板数据来回复跳、桥也反复重连。
       * 客户端把短时间内的多次点击攒成一个批次发过来，这里**一次写进 patch**，
       * 宿主因此只重载一次。任何一条不合法就整批拒掉、**一个字都不写**（不做部分写入）。
       */
      kind: 'exact',
      path: '/qqai/panel/set-batch',
      handler: async (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return }
        const guard = sameSiteGuard(request)
        if (!guard.ok) { sendJson(response, 403, { ok: false, reason: guard.reason }); return }
        let body
        try { body = await readBody(request) } catch (error) {
          sendJson(response, 400, { ok: false, reason: `请求体不是合法 JSON：${error.message}` })
          return
        }
        const list = Array.isArray(body?.entries) ? body.entries : []
        if (list.length === 0) { sendJson(response, 400, { ok: false, reason: '这一批里没有任何键（entries 为空）' }); return }
        if (list.length > 40) { sendJson(response, 400, { ok: false, reason: `一次最多写 40 个键（收到 ${list.length} 个）` }); return }
        const wrote = await writeEntries(list.map((item) => ({ key: String(item?.key ?? ''), value: item?.value })))
        if (wrote.ok !== true) {
          sendJson(response, wrote.status ?? 400, { ok: false, reason: wrote.reason })
          return
        }
        sendJson(response, 200, {
          ok: true,
          changed: wrote.changed === true,
          count: wrote.entries.length,
          keys: wrote.entries.map((item) => item.key),
          profile,
          patchFile,
          note: wrote.changed ? PANEL_NOTES.apply : '已经是这些值',
          panel: await snapshot(),
        })
      },
    },
  ]

  const disposers = []
  try {
    for (const registration of registrations) disposers.push(host.webServer.register(registration))
  } catch (error) {
    // 注册到一半失败（比如路由撞名）必须把已注册的收回去，否则下次挂载会继续撞。
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* 回收失败也只能记一笔 */ }
    }
    throw error
  }
  return () => {
    // 必须注销：配置改动会让 DSH 重建这个插件条目（fiber 重挂），而
    // `webServer.register` 对**重复的 (kind, path) 会直接抛**——不注销的话
    // 第一次改开关就会把面板搞坏。
    for (const dispose of disposers) {
      try { dispose() } catch (error) { logger.warn(`QQ助手 面板路由注销失败：${error?.message ?? error}`) }
    }
  }
}

/** 面板分组（给控制台/文档复用）。 */
export { PANEL_GROUPS }
