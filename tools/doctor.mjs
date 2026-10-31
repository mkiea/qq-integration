/**
 * 体检：一条命令分层回答"装没装上""哪一层断了"。
 *
 * 为什么要有它：这个项目的安装有三步是**环境依赖**的（`--legacy-peer-deps`、
 * `@deepseek-ai` 目录联接、`bundles` 注册），而任何一步没做都长得像"插件坏了"——
 * 要么启动报 `Cannot find package`，要么装上了但界面上找不到它。让人靠翻 README
 * 反推是哪一步没做，是把文档的债转嫁给用户。
 *
 * 设计上的两条硬要求：
 *   ① **只读**：不装、不改、不重启，跑它不会让现状变好或变坏；
 *   ② **不许把"没探测到"说成"没安装"**：失败一律原样带出错误消息，并给出可直接
 *      复制执行的修复命令。分不清"没装"和"装了但没起来"，这个工具就白做了。
 *
 * 用法：
 *   node tools/doctor.mjs              全部检查
 *   node tools/doctor.mjs --install    只查安装（不碰网络）
 *   node tools/doctor.mjs --net        只查连通
 *   node tools/doctor.mjs --json       机器可读（贴 issue 用）
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const PLUGIN_NAME = 'dsh-qq-onebot-bridge'

const argv = new Set(process.argv.slice(2))
const AS_JSON = argv.has('--json')
const ONLY_INSTALL = argv.has('--install')
const ONLY_NET = argv.has('--net')
const wantInstall = ONLY_INSTALL || !ONLY_NET
const wantNet = ONLY_NET || !ONLY_INSTALL

const results = []
function add(scope, name, status, detail = '', fix = '') {
  results.push({ scope, name, status, detail, fix })
  if (AS_JSON) return
  const tag = status === 'ok' ? 'PASS' : status === 'warn' ? 'WARN' : status === 'skip' ? 'SKIP' : 'FAIL'
  console.log(`${tag}  ${name}${detail ? '  ' + detail : ''}`)
  if (fix && status !== 'ok') {
    for (const line of fix.split('\n')) console.log(`      ${line}`)
  }
}

/** profile 根目录（`~/.dsh/profiles`），尊重 DSH_HOME。 */
function dshHome() {
  const env = process.env.DSH_HOME && String(process.env.DSH_HOME).trim() !== ''
    ? String(process.env.DSH_HOME)
    : join(homedir(), '.dsh')
  return env
}

/** 列出 `~/.dsh/profiles/*` 里实际存在的 profile 名。 */
function listProfiles() {
  const dir = join(dshHome(), 'profiles')
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/**
 * 探测一个 TCP 端口有没有在听。
 * 不能用 `curl`/`fetch`：那样探到的是"HTTP 通不通"，而这里要的是"有没有人 bind 在这个端口上"，
 * 两者在"有人听着但不应答 HTTP"时结论相反。
 */
function probePort(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolveProbe) => {
    const socket = createConnection({ port, host })
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch { /* 已经断了 */ }
      resolveProbe(result)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish({ open: true, reason: '' }))
    socket.once('timeout', () => finish({ open: false, reason: '超时（没有接受连接）' }))
    socket.once('error', (error) => finish({ open: false, reason: error.code || error.message }))
  })
}

async function httpJson(url, timeoutMs = 1200) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    const text = await response.text()
    let data = null
    try { data = JSON.parse(text) } catch { /* 不是 JSON，原样留着 */ }
    return { ok: response.ok, status: response.status, data, text: text.slice(0, 300) }
  } catch (error) {
    return { ok: false, status: 0, data: null, text: String(error?.message ?? error) }
  } finally {
    clearTimeout(timer)
  }
}

async function checkInstall() {
  if (!AS_JSON) console.log('\n== A. 安装 ==')

  // A1 Node 版本
  const major = Number(process.versions.node.split('.')[0])
  add('install', 'Node 版本', major >= 20 ? 'ok' : 'fail', `v${process.versions.node}（要求 ≥ 20）`,
    major >= 20 ? '' : '装 Node 20 或更高：https://nodejs.org/ （用的是 nvs/nvm 的话切换后重开终端）')

  // A2 本目录就是仓库
  const pkg = readJson(join(REPO, 'package.json'))
  add('install', '插件 package.json', pkg ? 'ok' : 'fail', pkg ? `${pkg.name}@${pkg.version}` : '读不到',
    pkg ? '' : `确认这个目录是插件仓库：${REPO}`)
  if (pkg && pkg.name !== PLUGIN_NAME) {
    add('install', '包名', 'fail', `是 ${pkg.name}，应为 ${PLUGIN_NAME}`,
      '包名是宿主加载契约，不能改。你可能在改过的副本里跑这个脚本。')
  }

  // A3 直接依赖能加载（`ws`）
  try {
    await import('ws')
    add('install', '依赖 ws 可加载', 'ok')
  } catch (error) {
    add('install', '依赖 ws 可加载', 'fail', String(error?.message ?? error).slice(0, 120),
      `cd "${REPO}" && npm install --omit=dev --legacy-peer-deps\n（少了 --legacy-peer-deps 会 ERESOLVE：七个 @deepseek-ai/dsh-* 的 peer 区间在 npm 里解不开）`)
  }

  // A4 官方 peer 能不能被解析到 —— link 安装最容易断在这一步
  const peerDir = join(REPO, 'node_modules', '@deepseek-ai')
  let peerDetail = '不存在'
  if (existsSync(peerDir)) {
    /**
     * 判断"这是不是个联接/符号链接"**不能用** `lstatSync().isSymbolicLink()`：
     * Windows 的目录联接（mklink /J）不是符号链接，那个判断会返回 false。
     * 可靠的做法是比 realpath：普通目录的 realpath 等于自身，联接会解析到目标。
     */
    let real = ''
    try { real = realpathSync(peerDir) } catch { real = '' }
    const target = real !== '' && real.toLowerCase() !== resolve(peerDir).toLowerCase()
      ? real
      : ''
    peerDetail = target !== ''
      ? `联接到 ${target}`
      : '是本地目录（不是联接：可能装成了实体副本，改 profile 的 peer 不会跟着变）'
  }
  if (existsSync(peerDir)) {
    add('install', `node_modules/@deepseek-ai`, 'ok', peerDetail)
  } else {
    add('install', 'node_modules/@deepseek-ai', 'warn', '不存在',
      '只有在 `link:` 安装时才需要它。做法（Windows，不需要管理员）：\n'
      + `cmd /c mklink /J "${join(REPO, 'node_modules', '@deepseek-ai')}" "%USERPROFILE%\\.dsh\\profiles\\<profile>\\node_modules\\@deepseek-ai"\n`
      + '<profile> 按你用的客户端填 web 或 desktop。')
  }

  try {
    await import('@deepseek-ai/schemastery')
    add('install', '官方 peer @deepseek-ai/schemastery 可加载', 'ok')
  } catch (error) {
    add('install', '官方 peer @deepseek-ai/schemastery 可加载', 'fail',
      String(error?.message ?? error).slice(0, 140),
      '这就是 link 安装的经典断点：Node 按**真实路径**解析 import，符号链接指向的仓库会从自己往上找，\n'
      + '永远找不到 profile 的 node_modules。修法见上一项的目录联接命令。')
  }

  // A5 哪个 profile 装了本插件
  const profiles = listProfiles()
  /** 装了本插件的 profile（后面检查 patch 时只查这几个，不然会刷一堆无关目录）。 */
  const installed = []
  if (profiles.length === 0) {
    add('install', '找到 DSH profile', 'fail', `在 ${join(dshHome(), 'profiles')} 下一个目录都没有`,
      '先确认 DSH 装好了、至少跑起来过一次（profile 目录是它建的），或设置 DSH_HOME 指向正确位置。')
  } else {
    for (const name of profiles) {
      const file = join(dshHome(), 'profiles', name, 'package.json')
      const json = readJson(file)
      if (!json) continue
      const dep = json.dependencies?.[PLUGIN_NAME]
      const bundles = json.dsh?.profile?.bundles
      const inBundles = Array.isArray(bundles) && bundles.includes(PLUGIN_NAME)
      if (dep || inBundles) installed.push({ name, dep: dep ?? '', inBundles, bundles })
    }
    if (installed.length === 0) {
      add('install', `profile 里有没有 ${PLUGIN_NAME}`, 'fail', `查了 ${profiles.length} 个 profile（${profiles.join(' / ')}），都没装`,
        '装一次：dsh plugin --profile <profile> add "<本目录>"\n（<profile> 填 web 或 desktop）')
    } else {
      for (const item of installed) {
        add('install', `profile「${item.name}」已声明依赖`, 'ok', item.dep)
        if (item.inBundles) {
          add('install', `profile「${item.name}」在 bundles 里`, 'ok')
        } else {
          add('install', `profile「${item.name}」在 bundles 里`, 'warn', '没有',
            `把 "${PLUGIN_NAME}" 加进 ${join(dshHome(), 'profiles', item.name, 'package.json')} 的 dsh.profile.bundles\n`
            + '只在"手动/本地目录安装"时需要（市场安装会自动加）。不加的话它只会出现在"已装依赖"里，不工作。')
        }
      }
    }
  }

  // A6 profile 的 patch 文件（只查装了本插件的 profile；一个都没装才退回全扫）
  const patchOwners = installed.length > 0 ? installed.map((item) => item.name) : profiles
  const patchFiles = patchOwners
    .map((name) => ({ name, file: join(dshHome(), 'profiles', name, 'cordis.patch.yml') }))
    .filter((item) => existsSync(item.file))
  if (patchFiles.length === 0) {
    add('install', 'cordis.patch.yml', 'warn', '一个都没找到',
      '没配过插件配置；要用控制台/白名单就得有一份。控制台的「安装向导」会替你写。')
  } else {
    for (const { name, file } of patchFiles) {
      const raw = readFileSync(file, 'utf8')
      const mentioned = raw.includes(PLUGIN_NAME)
      add('install', `patch 有本插件条目（${name}）`, mentioned ? 'ok' : 'warn',
        mentioned ? '' : '文件在，但里面没有本插件的条目',
        mentioned ? '' : `要么在控制台的设置面板里改一次（它会替你写），要么手工加：\n${file}\n  找到 id: ${PLUGIN_NAME} 的条目，把配置写在它的 config 下。`)
    }
  }
}

async function checkNet() {
  if (!AS_JSON) console.log('\n== B. 连通 ==')

  // 端口从控制台配置推（它知道 DEFAULT_PORTS），推不到就用已知默认值
  let ports = { host: 6700, waylay: 13000, control: 6099, onebot: 6700 }
  let dataRoot = ''
  try {
    const mod = await import(pathToFileURL(join(REPO, 'control', 'lib', 'config.mjs')).href)
    if (typeof mod.detectPaths === 'function') {
      const detected = mod.detectPaths()
      if (detected.ports) ports = { ...ports, ...detected.ports }
      dataRoot = detected.dataRoot ?? ''
    }
  } catch { /* 用默认值继续，下面照实报 */ }

  /**
   * B1 桥的 OneBot 反向 WS（Waylay 连过来的那个口）。
   *
   * ⚠️ 这里必须是 `ports.onebot`（6700），**不是** `ports.host`。`host` 是 DSH 宿主的
   * HTTP 口（3080），两个都由宿主进程监听，探错了会得到"PASS —— 反向 WS 在听"这种
   * 假结论：明明是别的服务在应答。第一版就写错过这个字段。
   */
  const onebotProbe = await probePort(ports.onebot)
  add('net', `${ports.onebot} OneBot 反向 WS（桥监听）`, onebotProbe.open ? 'ok' : 'fail',
    onebotProbe.open ? '有人在听' : `没人听：${onebotProbe.reason}`,
    onebotProbe.open ? '' : '宿主没起来 / 桥没启用。先确认 DSH 宿主在运行、且本插件在 bundles 里（见上面 A 区）。')

  // B1b DSH 宿主的 HTTP 口（它活着才有下面这些）
  const hostProbe = await probePort(ports.host)
  add('net', `${ports.host} DSH 宿主 HTTP`, hostProbe.open ? 'ok' : 'fail',
    hostProbe.open ? '宿主在跑' : `没人听：${hostProbe.reason}`,
    hostProbe.open ? '' : 'DSH 宿主没在运行。这个项目的一切都要宿主活着（桥、控制台的实时数据都靠它）。')

  // B2 Waylay
  const waylayPort = ports.waylay
  const waylayProbe = await probePort(waylayPort)
  if (!waylayProbe.open) {
    add('net', `${waylayPort} Waylay 控制台`, 'fail', `没人听：${waylayProbe.reason}`,
      'Waylay 没启动。在控制台里点「启动 Waylay」，或在配置面板确认 waylayBat 路径。')
  } else {
    add('net', `${waylayPort} Waylay 端口`, 'ok', '有人在听')
    const status = await httpJson(`http://127.0.0.1:${waylayPort}/api/status`)
    if (status.ok && status.data) {
      const loggedIn = status.data.logged_in ?? status.data.loggedIn
      add('net', 'Waylay 登录态', loggedIn === true ? 'ok' : 'warn',
        loggedIn === true ? '已登录' : `logged_in=${JSON.stringify(loggedIn)}`,
        loggedIn === true ? '' : '未登录：打开控制台的「登录」页扫码（弹窗只在未登录且有一张新码时出现）。')
    } else {
      add('net', 'Waylay /api/status', 'warn', `HTTP ${status.status || '无响应'} ${status.text.slice(0, 80)}`,
        '端口有人听但状态接口没回。可能版本不同（接口名变了），或需要 token。')
    }
  }

  // B3 控制台（独立进程，没起是正常的）
  const controlProbe = await probePort(ports.control)
  add('net', `${ports.control} 控制台`, controlProbe.open ? 'ok' : 'warn',
    controlProbe.open ? '在跑' : '没在跑（独立进程，按需启动）',
    controlProbe.open ? '' : '需要看面板时再启动：node "<本目录>\\control\\bin\\qq-control.mjs"')

  // B4 运行快照与 trace 新鲜度
  const runtimeFile = dataRoot ? join(dataRoot, 'qq-runtime.json') : ''
  const runtime = runtimeFile && existsSync(runtimeFile) ? readJson(runtimeFile) : null
  if (!runtime) {
    add('net', '运行快照 qq-runtime.json', 'warn', dataRoot ? `没找到（${runtimeFile}）` : '数据目录未知',
      '桥还没跑过、或 dataRoot 指错。数据目录看 profile 的 cordis.patch.yml 里 dataDir。')
  } else {
    const ago = Math.round((Date.now() - Number(runtime.updatedAt ?? 0)) / 1000)
    const fresh = ago >= 0 && ago < 90
    add('net', '运行快照新鲜度', fresh ? 'ok' : 'warn', `${ago} 秒前更新（pid ${runtime.pid ?? '?'}，已跑 ${Math.round(Number(runtime.uptimeSeconds ?? 0) / 60)} 分钟）`,
      fresh ? '' : '快照不是新的：宿主可能已退出（快照留在磁盘上不代表它还活着）。对照上面 6700 那一项。')
  }

  /**
   * B4b 最近一次"走完整条管线"的时间。
   *
   * 判据用运行快照里的 `recentTraces[0].startedAt`，**不看 trace 文件的 mtime**。
   * 第一版拿 mtime 当判据，报了个「6695 秒没写过」的 WARN，而同一份快照显示 30 秒前
   * 刚更新过——因为 trace 是攒在内存里批量落盘的，文件旧不等于没在收消息。
   * 量的东西和被问的问题对不上，就是量具在说谎。
   */
  const recentTraces = Array.isArray(runtime?.recentTraces) ? runtime.recentTraces : []
  const lastStartedAt = recentTraces.length ? Number(recentTraces[0].startedAt ?? 0) : 0
  if (lastStartedAt > 0) {
    const agoSeconds = Math.round((Date.now() - lastStartedAt) / 1000)
    const stages = Array.isArray(recentTraces[0].stages) ? recentTraces[0].stages.length : 0
    add('net', '最近一次消息处理', agoSeconds < 1800 ? 'ok' : 'warn',
      `${agoSeconds} 秒前（${recentTraces[0].chatKey ?? '?'} 走过 ${stages} 个阶段）`,
      agoSeconds < 1800 ? '' : '半小时没有完整回合。没人发消息是正常的；如果刚发过，用 /为什么 看是哪一道拦了。')
  } else {
    add('net', '最近一次消息处理', 'warn', '快照里还没用回合记录', '还没处理过消息，或者 trace 关了。')
  }

  // trace 文件只查"在不在"：mtime 不能当"在不在写"的判据（理由见上）
  const traceFile = dataRoot ? join(dataRoot, 'qq-trace.jsonl') : ''
  if (traceFile && existsSync(traceFile)) {
    add('net', 'trace 文件存在', 'ok', `${(statSync(traceFile).size / 1024).toFixed(0)} KB`)
  } else if (traceFile) {
    add('net', 'trace 文件存在', 'warn', `没有 ${traceFile}`, '可能 traceEnabled 关了，或还从没收过消息。')
  }

  // B5 可选依赖（没有也不影响核心）
  for (const [label, port] of [['本地模型 ollama', 11434], ['本地语音 edge-tts', ports.tts]]) {
    if (!port) continue
    const probe = await probePort(port)
    add('net', `${label}（可选，${port}）`, probe.open ? 'ok' : 'skip',
      probe.open ? '在跑' : '没跑（不影响核心功能）')
  }
}

await (wantInstall ? checkInstall() : Promise.resolve())
await (wantNet ? checkNet() : Promise.resolve())

const counts = results.reduce((acc, item) => {
  acc[item.status] = (acc[item.status] ?? 0) + 1
  return acc
}, {})

if (AS_JSON) {
  console.log(JSON.stringify({ repo: REPO, node: process.versions.node, counts, results }, null, 1))
} else {
  console.log(`\n汇总：PASS ${counts.ok ?? 0} / WARN ${counts.warn ?? 0} / FAIL ${counts.fail ?? 0} / SKIP ${counts.skip ?? 0}`)
  if ((counts.fail ?? 0) > 0) console.log('有 FAIL 的项按上面给的命令逐条处理；WARN 不一定是错，看具体说明。')
}

process.exit((counts.fail ?? 0) > 0 ? 1 : 0)
