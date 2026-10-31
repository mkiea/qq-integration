/**
 * Control-console configuration: one source of truth for every port and every
 * executable the console manages. Everything is auto-detected with overrides,
 * so the same file works on another machine without editing code.
 *
 * Config file: <repo>/qq-control.json   (machine-local, git-ignored)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, parse, resolve } from 'node:path'
import { detectWaylayBat, WAYLAY_BAT_HINT, WAYLAY_PORT } from '../../lib/waylay-launch.js'
// 读 profile `cordis.patch.yml` 里那个 dataDir。`lib/panel.js` 自身零 import，不会成环；
// 走它的 `readPatchValue` 而不是自己 split 冒号，是因为 YAML 值里的盘符/引号会被简单解析切错。
import { readPatchValue } from '../../lib/panel.js'

/** Ports the console cares about. 6700 is pinned by the OneBot client config. */
export const DEFAULT_PORTS = {
  control: 8880,   // this console itself (127.0.0.1 only) —— v0.8.0 弃用 8799
  host: 3080,      // dsh web host: bot console UI + HTTP API
  onebot: 6700,    // reverse WebSocket the bridge listens on (Waylay connects)
  waylay: WAYLAY_PORT,   // Waylay 控制台 / 状态接口（13000）
  tts: 8977,       // local voice service (edge-tts，tts-server/启动语音服务.cmd；旧 GPT-SoVITS 用 9880)
}

/** Human-readable labels used by the UI and the CLI summary. */
export const PORT_LABELS = {
  control: '控制台（独立进程，不依赖 dsh）',
  host: 'DSH 宿主（机器人控制台）',
  onebot: 'OneBot 反向 WS（桥监听）',
  waylay: 'Waylay 控制台（二维码 / 状态）',
  tts: '本地语音（edge-tts）',
}

/** Ports the console is allowed to free by killing the occupying process. */
export const FREEABLE_PORTS = ['host', 'onebot', 'waylay', 'tts']

const DEFAULTS = {
  cwd: '',
  /**
   * 数据根目录（插件配置键同名）。空 = 跟 `cwd`。
   *
   * ★ 为什么控制台也必须知道它：`qq-trace.jsonl` / `qq-runtime.json` / `qq-inbox.jsonl` /
   * `qq-actions.log` / `qq-inject.jsonl` 全部由桥写在 **dataRoot** 下面（`lib/bridge.js`
   * 里那些 `join(this.dataRoot, 'qq-…')`）。控制台若还按 `cwd` 推，`dataDir` 一旦不等于
   * `cwd`，所有面板都会变成"空的"——而"读不到文件"和"真的没有数据"在界面上长得一样。
   */
  dataDir: '',
  /**
   * 向导要写的是**插件配置**（profile 的 `cordis.patch.yml`），所以控制台必须知道 profile 名。
   *
   * 为什么不 import `lib/settings-routes.js` 的 `profileDirOf`：那个模块反过来 import
   * `control/lib/server.mjs` 和 `control/lib/supervisor.mjs`，在这里 import 它会形成**循环依赖**
   * （Node 的 ESM 循环会在求值顺序上炸，且报错位置离真因很远）。这里只有三行路径拼接，
   * 语义与 `profileDirOf` 逐字一致（`DSH_HOME` 优先，否则 `~/.dsh`）。
   */
  profile: 'web',
  nodeExe: '',
  dshBin: '',
  waylayBat: '',
  waylayUin: '',
  ttsBat: '',
  pluginRoot: '',
  logs: { hostOut: '', hostErr: '', bridge: '' },
  extraDirs: [],
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      if (existsSync(candidate)) return resolve(candidate)
    } catch { /* ignore */ }
  }
  return ''
}

/** Newest `@deepseek-ai/dsh` bin.js under the usual npx cache roots. */
export function detectDshBin({ roots = [], readdir = readdirSync, exists = existsSync } = {}) {
  const found = []
  for (const root of roots) {
    if (!root) continue
    let entries = []
    try { entries = readdir(root, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const candidate = join(root, entry.name, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      if (exists(candidate)) found.push(candidate)
    }
  }
  if (found.length === 0) return ''
  found.sort((a, b) => {
    try { return statSync(b).mtimeMs - statSync(a).mtimeMs } catch { return 0 }
  })
  return resolve(found[0])
}

/**
 * npx cache roots worth probing, derived from the ENVIRONMENT and the location of
 * the running node — never from a hardcoded absolute path (a published plugin must
 * not carry the author's `C:\Users\<name>` or `D:\...` layout).
 */
export function npxCacheRoots({ env = process.env, execPath = process.execPath } = {}) {
  const home = env.USERPROFILE || env.HOME || ''
  const localAppData = env.LOCALAPPDATA || (home ? join(home, 'AppData', 'Local') : '')
  const roamingAppData = env.APPDATA || (home ? join(home, 'AppData', 'Roaming') : '')
  const roots = []
  const push = (value) => { if (value && !roots.includes(value)) roots.push(value) }
  // 1) 显式覆盖优先
  for (const key of ['DSH_NPX_CACHE', 'npm_config_cache', 'NPM_CONFIG_CACHE']) {
    const value = env[key]
    if (!value) continue
    push(value.endsWith('_npx') ? value : join(value, '_npx'))
  }
  // 2) npm 默认缓存位置
  if (localAppData) push(join(localAppData, 'npm-cache', '_npx'))
  if (roamingAppData) push(join(roamingAppData, 'npm-cache', '_npx'))
  // 3) 以 node 自身位置为锚：<node>\..\_npx、<node>\node_cache\_npx、<盘>:\nodejs\node_cache\_npx
  try {
    const nodeDir = dirname(execPath)
    const driveRoot = parse(execPath).root
    push(join(nodeDir, '_npx'))
    push(join(nodeDir, 'node_cache', '_npx'))
    if (driveRoot) {
      push(join(driveRoot, 'nodejs', 'node_cache', '_npx'))
      push(join(driveRoot, 'node_cache', '_npx'))
    }
  } catch { /* 拿不到 node 位置就只用环境变量 */ }
  return roots
}

/** Fill in everything that can be discovered on this machine. */
export function detectPaths(config = {}, { env = process.env, exists = existsSync, readdir = readdirSync, readFile = readFileSync } = {}) {
  const home = env.USERPROFILE || env.HOME || ''
  const localAppData = env.LOCALAPPDATA || (home ? join(home, 'AppData', 'Local') : '')
  // cwd 只能来自配置或环境变量（默认当前目录）：插件不该假设任何人的工作目录路径
  const cwd = config.cwd || env.DSH_QQ_CWD || process.cwd()
  /** profile 名：只做"是个目录名"的粗校验，别把整条路径当名字写进 join（会跳出 profiles/ 之外）。 */
  const profile = String(config.profile ?? '').trim() || 'web'
  const dshHome = env.DSH_HOME && String(env.DSH_HOME).trim() !== '' ? String(env.DSH_HOME) : join(home || '', '.dsh')
  // 向导写的就是这个文件；读写都在 supervisor.setDataDir 里，这里只负责算路径
  const patchFile = config.patchFile || (dshHome ? join(dshHome, 'profiles', profile, 'cordis.patch.yml') : '')
  /**
   * 数据根目录：桥把 `qq-*` 全写在这里，所以控制台读日志/快照也必须来这里读。
   *
   * 来源**三级**，越靠前越优先：
   *   ① `qq-control.json` 里显式写的 `dataDir`（覆盖用，一般不用填）；
   *   ② **profile 的 `cordis.patch.yml` 里的 `dataDir`** —— 向导和设置面板写的就是它；
   *   ③ `cwd`（老配置的兜底，与 `lib/bridge.js` 的 `this.dataRoot` 逐字一致）。
   *
   * 为什么要有 ②：向导写完 patch 之后，桥就换到新目录去了。如果控制台只认自己的
   * `qq-control.json`，它还会去旧目录读日志 ⇒ **面板全空**，而"读不到文件"和"真的没有数据"
   * 在界面上长得一模一样。让控制台读**同一份配置**，就不存在"两个地方各记一个目录"。
   *
   * 读不到/读坏了都当空（`readPatchValue` 永不抛），继续落到 ③ —— 控制台不能因为配置坏了就起不来。
   */
  const dataDirFromPatch = () => {
    if (patchFile === '') return ''
    try {
      if (!exists(patchFile)) return ''
      const raw = readPatchValue(String(readFile(patchFile, 'utf8') ?? ''), 'dataDir', undefined, { asString: true })
      return typeof raw === 'string' ? raw.trim() : ''
    } catch {
      return ''
    }
  }
  const dataDirFromConfig = String(config.dataDir ?? '').trim()
  const dataDirFromFile = dataDirFromConfig !== '' ? '' : dataDirFromPatch()
  const dataDirRaw = dataDirFromConfig !== '' ? dataDirFromConfig : dataDirFromFile
  // 'config' = qq-control.json 覆盖；'patch' = profile 的 cordis.patch.yml；'none' = 还在吃 cwd 兜底
  const dataDirSource = dataDirFromConfig !== '' ? 'config' : (dataDirFromFile !== '' ? 'patch' : 'none')
  const dataRoot = dataDirRaw === '' ? cwd : resolve(dataDirRaw)

  const dshBin = firstExisting([
    config.dshBin,
    env.DSH_WEB_BIN,
    detectDshBin({ roots: npxCacheRoots({ env }), readdir, exists }),
    join(localAppData, 'Programs', 'DSH Desktop', 'resources', 'app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ])

  // Waylay 入口：真正在用的那条路。只有一个入口、不需要挑加载器。
  // 默认位置按本项目的标准布局推：cwd 是 qq_chat，注入目录在它的兄弟 _tmp/rin-inject。
  // 推不到就让用户填一次 waylayBat（写进 qq-control.json），不必改代码。
  const detectedWaylay = detectWaylayBat({
    configured: config.waylayBat,
    env,
    exists,
    extra: cwd ? [join(cwd, '..', '_tmp', 'rin-inject')] : [],
  })
  const waylayBat = detectedWaylay === '' ? '' : resolve(detectedWaylay)
  const ttsBat = firstExisting([
    config.ttsBat,
    // 自家语音服务（edge-tts）：cwd 下的 tts-server/启动语音服务.cmd
    cwd ? join(cwd, 'tts-server', '启动语音服务.cmd') : '',
    // 旧 GPT-SoVITS 布局兜底
    cwd ? join(cwd, 'GPT-SoVITS', 'TTS控制.bat') : '',
  ])

  return {
    ...DEFAULTS,
    ...config,
    cwd,
    // dataDir 原样保留（空 = 没配），dataRoot 是**生效值**：界面上要同时说清这两件事
    dataDir: dataDirRaw,
    dataRoot,
    // 这个目录是从哪读来的：'config'（qq-control.json 覆盖）/ 'patch'（profile 的 cordis.patch.yml）
    dataDirSource,
    profile,
    patchFile,
    nodeExe: config.nodeExe || process.execPath,
    dshBin,
    waylayBat,
    waylayUin: String(config.waylayUin ?? '').trim(),
    ttsBat,
    logs: {
      hostOut: config.logs?.hostOut || (dataRoot ? join(dataRoot, 'qq-host-out.log') : ''),
      hostErr: config.logs?.hostErr || (dataRoot ? join(dataRoot, 'qq-host-err.log') : ''),
      bridge: config.logs?.bridge || (dataRoot ? join(dataRoot, 'qq-bridge-debug.log') : ''),
      trace: config.logs?.trace || (dataRoot ? join(dataRoot, 'qq-trace.jsonl') : ''),
      audit: config.logs?.audit || (dataRoot ? join(dataRoot, 'qq-actions.log') : ''),
      runtime: config.logs?.runtime || (dataRoot ? join(dataRoot, 'qq-runtime.json') : ''),
      // 录制（收到的每条消息）与注入队列（控制台写、桥轮询读）
      inbox: config.logs?.inbox || (dataRoot ? join(dataRoot, 'qq-inbox.jsonl') : ''),
      inject: config.logs?.inject || (dataRoot ? join(dataRoot, 'qq-inject.jsonl') : ''),
    },
    ports: { ...DEFAULT_PORTS, ...(config.ports ?? {}) },
    extraDirs: Array.isArray(config.extraDirs) ? config.extraDirs : [],
  }
}

/** Load a config file (missing/corrupt files fall back to auto-detection). */
export function loadControlConfig(file, options = {}) {
  let raw = {}
  try { raw = JSON.parse(readFileSync(file, 'utf8')) ?? {} } catch { raw = {} }
  return { file, config: detectPaths(raw, options) }
}

export function saveControlConfig(file, config) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/** Non-fatal problems worth showing in the UI (missing binaries, bad ports). */
export function configWarnings(config) {
  const warnings = []
  for (const [name, value] of Object.entries(config.ports ?? {})) {
    if (!Number.isInteger(value) || value < 1 || value > 65535) warnings.push(`端口配置非法：${name}=${value}`)
  }
  if (!config.nodeExe) warnings.push('找不到 node 可执行文件（nodeExe）')
  else if (!existsSync(config.nodeExe)) warnings.push(`node 可执行文件不存在：${config.nodeExe}`)
  if (!config.dshBin) warnings.push('找不到 dsh bin.js（无法启动宿主，可用 dshBin 手动指定）')
  else if (!existsSync(config.dshBin)) warnings.push(`dsh bin.js 不存在：${config.dshBin}`)
  if (!config.waylayBat) warnings.push(`找不到 Waylay 入口（waylayBat）：${WAYLAY_BAT_HINT}`)
  if (!config.cwd) warnings.push('未设置宿主工作目录（cwd）')
  /**
   * 配了数据根目录但那个目录不存在：这不是错误（桥会在第一次写文件时自己建），但**必须说出来**，
   * 因为旧数据不会跟过来——用户会看到"记忆全空了"而完全不知道是换了目录。
   */
  if (config.dataDir) {
    try {
      if (!existsSync(config.dataDir)) warnings.push(`数据根目录还不存在：${config.dataDir}（会新建；旧数据不会自动搬过来）`)
    } catch { /* 路径非法就算了，上面 dataDir 的提示已经够用 */ }
  }
  return warnings
}
