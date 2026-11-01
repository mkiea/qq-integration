/**
 * Supervision primitives for the standalone QQ bot console.
 *
 * Every function is pure or takes its side effects by injection (`exec`, `spawn`,
 * `readFile`, `now`) so the whole layer is unit-testable without touching the
 * real machine, and the console can never invent a target it was not configured
 * to touch (see `assertKillAllowed`).
 */
import { execFile, spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PORT_LABELS, configWarnings } from './config.mjs'
import { describeStatus, parseListenerPid, stopPlan, waylayLaunchCommand, waylayLogPath, waylayQrPath, WAYLAY_BAT_HINT } from '../../lib/waylay-launch.js'
// `lib/panel.js` 没有任何 import（纯函数模块），所以从这里取写入规则不会形成循环依赖。
// 复用它的 `normalizeDataDir` / `upsertPatchValue` 是刻意的：**同一套规则只许有一份**，
// 否则「面板里能填的值，控制台向导拒收」这类分裂迟早出现，而且两边都觉得自己是对的。
import { normalizeDataDir, upsertPatchValue } from '../../lib/panel.js'
// 系统选文件夹窗口：实现住在零依赖的 `lib/dir-pick.js`，宿主面板与控制台向导共用同一份。
import { pickFolderDialog } from '../../lib/dir-pick.js'
// 人设标准格式：结构/预算/校验。住在 `lib/` 是因为它描述的是**宿主怎么读这个文件**，
// 不是控制台的界面逻辑（宿主侧的预算、截断顺序都在那份定义里）。
import { PERSONA_BLOCKS, PERSONA_BUDGET_BYTES, PERSONA_TEMPLATE, analyzePersona } from '../../lib/persona-spec.js'
import { createTraceTailer, filterEvents, formatChain, groupChains, readRuntime, readTraceFile, summarizeEvents } from './trace.mjs'
import { formatDiagnose, runDiagnose } from './diagnose.mjs'
import { buildZip, fileEntry } from './zip.mjs'
import { createReplayer } from './replay.mjs'
import { buildAcceptance, formatAcceptance } from './acceptance.mjs'
import { groupsView as groupsReport, jobsView as jobsReport, perfReport } from './perf.mjs'
import { redactByKind, redactionNote } from './redact.mjs'
import { appendCappedLine, moveToTrash } from '../../lib/store.js'
import { countLines, describeFrame, parseInjectionLine, readInbox } from '../../lib/inbox.js'
import { HistoryArchive } from '../../lib/archive.js'

/** Plugin repo root, derived from this file's location (control/lib/… → repo). */
export function defaultPluginRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

// ---------------------------------------------------------------- parsing ----

/**
 * Parse `netstat -ano` output into rows.
 * @returns {{proto:string, localPort:number, remotePort:number, state:string, pid:number}[]}
 */
export function parseNetstat(text) {
  const rows = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s*(TCP|UDP)\s+(\S+)\s+(\S+)\s*(LISTENING|ESTABLISHED|TIME_WAIT|CLOSE_WAIT|SYN_SENT|UDP)?\s+(\d+)\s*$/i.exec(line)
    if (!match) continue
    const [, proto, local, remote, state, pid] = match
    rows.push({
      proto: proto.toUpperCase(),
      localPort: portOf(local),
      remotePort: portOf(remote),
      state: (state ?? '').toUpperCase(),
      pid: Number(pid),
    })
  }
  return rows
}

/** `127.0.0.1:3080` / `[::]:6700` / `0.0.0.0:0` → 3080 / 6700 / 0 */
export function portOf(address) {
  const match = /:(\d+)$/.exec(String(address ?? ''))
  return match ? Number(match[1]) : 0
}

/** `tasklist /FO CSV /NH` 的解析（parseTasklist）在 lib/waylay-launch.js（v0.8.0 起）。 */

/** Combine netstat + tasklist into one row per watched port. */
export function summarizePorts(netstatRows, taskMap, ports, labels = {}) {
  return Object.entries(ports).map(([name, port]) => {
    const listeners = netstatRows.filter((row) => row.localPort === port && row.state === 'LISTENING')
    const established = netstatRows.filter((row) => row.localPort === port && row.state === 'ESTABLISHED')
    const owner = listeners[0]
    return {
      name,
      label: labels[name] ?? name,
      port,
      listening: listeners.length > 0,
      pid: owner?.pid ?? 0,
      process: owner ? (taskMap.get(owner.pid) ?? '') : '',
      established: established.length,
    }
  })
}

// ------------------------------------------------------------------ reads ----

/** Last `lines` lines of a file (missing/locked files yield an empty list). */
export function tailLines(file, lines = 200, { readFile = readFileSync } = {}) {
  try {
    const text = readFile(file, 'utf8')
    const all = String(text).split(/\r?\n/)
    return all.slice(Math.max(0, all.length - Math.max(1, lines)))
  } catch {
    return []
  }
}

/**
 * The 3080 console URL with its token, parsed out of the host's stdout log.
 * The log is appended to across host restarts, so the LAST match is the token
 * of the currently running host (taking the first would yield a stale 401).
 */
export function extractHostUrl(logText) {
  const matches = [...String(logText ?? '').matchAll(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+)/g)]
  if (matches.length === 0) return ''
  const last = matches[matches.length - 1]
  return `http://127.0.0.1:${last[1]}/?token=${last[2]}`
}

/** QR-code freshness（登录二维码通用，v0.8.0 起读 Waylay 的 qrcode.png）。 */
export function qrStatus(file, now = Date.now(), { stat = statSync } = {}) {
  try {
    const info = stat(file)
    const ageSeconds = Math.max(0, Math.round((now - info.mtimeMs) / 1000))
    return { exists: true, ageSeconds, fresh: ageSeconds < 300, mtimeMs: info.mtimeMs, error: '' }
  } catch (error) {
    // 区分"文件不存在"和"存在但读不到"（EBUSY/EACCES/EPERM）。
    // 一律当成"不存在"会把真实原因掩盖成"NapCat 没在运行"（审查提的 O1）。
    const code = error?.code ?? ''
    if (code === 'ENOENT' || code === 'ENOTDIR') return { exists: false, ageSeconds: -1, fresh: false, mtimeMs: 0, error: '' }
    return { exists: false, ageSeconds: -1, fresh: false, mtimeMs: 0, error: `${code || 'stat 失败'}：${error?.message ?? ''}`.slice(0, 160) }
  }
}

/** 二维码超过这个秒数就认为过期（QQ 的码大约 1～2 分钟失效，这里给宽一点）。 */
export const QR_STALE_SECONDS = 300

/**
 * v0.8.0：NapCat 的启动 / 加载器判定（原 lib/napcat-launch.js）随 NapCat 一起退场。
 * 这里只留仍在用的纯函数（住在 waylay-launch.js）：parseTasklist 与 QQ 客户端识别。
 */
import { parseTasklist, QQ_CLIENT_RE } from '../../lib/waylay-launch.js'

// ---------------------------------------------------------------- actions ----

/** Default execFile wrapper (promise, never throws). */
export function run(command, args, { timeoutMs = 15000, exec = execFile } = {}) {
  return new Promise((resolve) => {
    exec(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: error === null || error === undefined, code: error?.code ?? 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), message: error?.message ?? '' })
    })
  })
}

/** Snapshot of ports + processes used by the UI. */
export async function inspect({ ports, labels = {}, exec } = {}) {
  const [netstat, tasklist] = await Promise.all([
    run('netstat', ['-ano'], { exec }),
    run('tasklist', ['/FO', 'CSV', '/NH'], { exec }),
  ])
  const rows = parseNetstat(netstat.stdout)
  const tasks = parseTasklist(tasklist.stdout)
  const summary = summarizePorts(rows, tasks, ports, labels)
  const entries = [...tasks.entries()].map(([pid, name]) => ({ pid, name }))

  // v0.8.0：NapCat 加载器判定已随 NapCat 退场。QQ 客户端列表仅作**保护性展示**
  // （个人 QQ 客户端永远不在可杀名单里）；被注入的那个 QQ 由 waylay 端口行识别。
  const qqClients = entries.filter((entry) => QQ_CLIENT_RE.test(entry.name))

  const host = summary.find((item) => item.name === 'host')
  return {
    ports: summary,
    processes: {
      host: { running: Boolean(host?.listening), pid: host?.listening ? host.pid : 0 },
      qqClients,
      tts: entries.filter((entry) => /^pythonw?\.exe$/i.test(entry.name)),
    },
    botOnline: (summary.find((item) => item.name === 'onebot')?.established ?? 0) > 0,
    scannedAt: Date.now(),
  }
}

/** Launch a detached process with its stdout/stderr appended to log files. */
export function startDetached({ command, args = [], cwd, outFile, errFile, spawnImpl = spawn }) {
  if (!command) throw new Error('缺少可执行文件路径')
  const stdio = ['ignore', 'ignore', 'ignore']
  let outFd = null
  let errFd = null
  try {
    if (outFile) { outFd = openSync(outFile, 'a'); stdio[1] = outFd }
    if (errFile) { errFd = openSync(errFile, 'a'); stdio[2] = errFd }
  } catch {
    /* 日志文件打不开就退化成丢弃输出，进程照常启动 */
  }
  const child = spawnImpl(command, args, { cwd, detached: true, windowsHide: true, stdio })
  child.unref?.()
  if (outFd !== null) closeSync(outFd)
  if (errFd !== null) closeSync(errFd)
  return { pid: child.pid ?? 0 }
}

/**
 * Guard rail: only PIDs that currently own a watched port or the GPT-SoVITS
 * process may be killed. The personal QQ client is NOT killable (its name alone
 * never qualifies), which is deliberate. v0.8.0：NapCat 加载器分支随 NapCat 退场。
 */
export function assertKillAllowed(pid, { snapshot, ports, allowedNames = ['node.exe', 'python.exe', 'pythonw.exe'] } = {}) {
  const target = Number(pid)
  if (!Number.isFinite(target) || target <= 0) return { ok: false, reason: 'PID 非法' }
  if (target === process.pid) return { ok: false, reason: '拒绝杀掉控制台自身' }
  const ownsPort = (snapshot?.ports ?? []).some((item) => item.pid === target && (ports ? Object.values(ports).includes(item.port) : true))
  if (ownsPort) return { ok: true, reason: 'occupies a watched port' }
  const tts = (snapshot?.processes?.tts ?? []).some((entry) => entry.pid === target && /^pythonw?\.exe$/i.test(entry.name))
  if (tts) return { ok: true, reason: 'GPT-SoVITS process' }
  const name = (snapshot?.ports ?? []).find((item) => item.pid === target)?.process ?? ''
  if (name && allowedNames.includes(name.toLowerCase())) return { ok: true, reason: `known executable ${name}` }
  return { ok: false, reason: `PID ${target} 不属于受管端口或已知进程，拒绝操作（个人 QQ 客户端不受管）` }
}

/** Kill a process tree (Windows: taskkill /T /F). */
export async function killTree(pid, { exec } = {}) {
  return run('taskkill', ['/PID', String(pid), '/T', '/F'], { exec })
}

/** Whether a path exists (injectable for tests). */
export function fileExists(file, { exists = existsSync } = {}) {
  return Boolean(file) && exists(file)
}

// ------------------------------------------------------------ supervisor ----
// ------------------------------------------------------------ supervisor ----

/** Config fields the UI/API is allowed to read (no secrets live here anyway). */
export function publicConfig(config) {
  return {
    cwd: config.cwd,
    nodeExe: config.nodeExe,
    dshBin: config.dshBin,
    waylayBat: config.waylayBat,
    ttsBat: config.ttsBat,
    logs: { ...config.logs },
    ports: { ...config.ports },
  }
}
/**
 * The real supervisor: every action re-inspects the machine first, so a stale
 * PID can never be killed and a busy port is reported instead of half-started.
 */
/**
 * 「自己重启自己」的后台命令（纯函数，可单测）。
 *
 * 为什么要等一会儿：新进程要 bind 同一个端口，而旧进程还没退干净 ⇒ EADDRINUSE，
 * 新进程拉起来立刻死，而且**死得静默**（detached、没有终端，没人看得见）。
 * Windows 上没有 `sleep`；`timeout` 需要交互式控制台，detached 下会直接报错。
 * 所以用 `ping -n <n> 127.0.0.1 >nul` 空转——它不依赖网络可达，只借它数秒。
 *
 * argv 直接照抄当前进程：宿主就是这么起来的（`node <bin.js> web --no-open`），
 * 比拿配置里的 `dshBin` 猜一个"应该一样"的路径可靠（猜错就是拉不起来还不报错）。
 */
export function relaunchPlan({
  execPath = process.execPath,
  argv = process.argv,
  delaySec = 5,
  comspec = process.env.ComSpec || 'cmd.exe',
  outFile = '',
  errFile = '',
} = {}) {
  if (!execPath) return { ok: false, reason: '拿不到当前 node 路径（process.execPath），不猜' }
  const args = (Array.isArray(argv) ? argv : []).slice(1).filter((a) => typeof a === 'string' && a !== '')
  if (args.length === 0) return { ok: false, reason: '拿不到宿主启动参数（process.argv），不猜' }
  const q = (s) => (/[\s"]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s))
  const wait = Math.max(1, Math.min(60, Math.round(Number(delaySec) || 5)))
  let tail = [q(execPath), ...args.map(q)].join(' ')
  if (outFile) tail += ` >> ${q(outFile)}`
  if (errFile) tail += ` 2>> ${q(errFile)}`
  const command = `ping -n ${wait + 1} 127.0.0.1 >nul & ${tail}`
  return { ok: true, file: comspec, args: ['/c', command], command }
}


/**
 * 在文件管理器里打开一个目录（零依赖，用系统自带的）。
 *
 * ⚠️ `explorer.exe` 即使成功也常返回 **1**，所以这里**不看退出码**：
 * 看退出码会把"其实打开了"报成失败（反过来更糟——那种"报成功但没开"只有用户看得见）。
 * 这里只保证"进程起来了"；真正的验证是用户自己看到窗口。
 */
export function openFolderDefault(target) {
  const platform = process.platform
  const [command, args] = platform === 'win32'
    ? ['explorer.exe', [target]]
    : platform === 'darwin'
      ? ['open', [target]]
      : ['xdg-open', [target]]
  try {
    spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false }).unref?.()
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: `打开文件夹失败：${error?.message ?? error}` }
  }
}

/**
 * 原子写一份配置文件：先写同目录临时文件，再 `rename` 过去。
 *
 * 为什么不直接 `writeFileSync`：宿主会读这份 patch。写到一半被打断就是**半份 YAML**，
 * 下次启动直接拒载——而这个后果要等到**下次重启**才显形，那时候已经看不出是哪一步坏的。
 */
export function writeFileAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, text, 'utf8')
  try {
    renameSync(tmp, file)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* 临时文件清不掉也别盖住真错误 */ }
    throw error
  }
}

/**
 * 目标目录的**现状**（给向导看，不是给判据用）。
 *
 * 为什么要专门报这个：用户点「就用这个」的时候，他并不知道那个目录里已经有东西。
 * 「空目录」和「已经有 200 天的聊天记录」在界面上长得一样，选错一次就是把记忆接到别人身上
 * （或者看着像"记忆全丢了"）。所以把 `qq-*` 条目和 `qq-canary.json` 都数出来给他看。
 */
export function describeDataDir(target, { readdir = readdirSync, stat = statSync } = {}) {
  const path = String(target ?? '')
  if (path === '') return { path: '', exists: false, qqEntries: [], qqCount: 0, hasCanary: false }
  let exists = false
  try { exists = stat(path).isDirectory() } catch { exists = false }
  if (!exists) return { path, exists: false, qqEntries: [], qqCount: 0, hasCanary: false }
  let names = []
  try { names = readdir(path) } catch { names = [] }
  const qqAll = names.filter((name) => String(name).startsWith('qq-'))
  return {
    path,
    exists: true,
    // 只列前 12 个：向导是"让人看一眼就知道"，不是文件管理器
    qqEntries: qqAll.slice(0, 12).sort(),
    qqCount: qqAll.length,
    hasCanary: qqAll.includes('qq-canary.json'),
  }
}

export function createSupervisor(config, deps = {}) {
  // delaySec：自重启时"等端口释放"的秒数（可注入，单测不真等 5 秒）
  const { exec, spawnImpl, now = () => Date.now(), fetchJson: injectedFetchJson, delaySec = 5 } = deps
  // 打开文件夹要能注入（单测里绝不许真弹资源管理器）
  const openFolder = deps.openFolder ?? openFolderDefault
  const inspectNow = () => inspect({ ports: config.ports, labels: PORT_LABELS, exec })
  let replayer = null   // 每个 supervisor 一份，避免跨实例共享沙箱状态
  let diagnoseCache = null   // { at, value }：体检结果的短时缓存
  let lastReplaySummary = null   // 验收台要看"最近一次回放"的证据
  let lastExportSummary = null   // 验收台要看"最近一次导出"的证据

  const portRow = (snapshot, name) => (snapshot.ports ?? []).find((item) => item.name === name)

  /**
   * ★ Waylay 单实例锁（2026-10-30 用户实测：连点几次「一键启动」就开出好几个 QQ，
   * 几个 QQ 抢同一个号登录，互相把对方踢下线）。
   *
   * 为什么单靠端口判据不够：二维码/登录阶段 QQ **不监听 13000**，端口判据看不见它，
   * 所以每点一次都会再注入一个。这里在启动成功后落一个带时间戳的锁文件：
   *   · 5 分钟内再点 → 直接拒绝（提示正在等扫码）
   *   · 扫码登录成功（13000 起来）→ waylayStatus 顺手删锁
   *   · 「停止 Waylay」/「全部停止」→ 删锁
   */
  const WAYLAY_LOCK_TTL_MS = 5 * 60 * 1000
  const waylayLockFile = () => (config.waylayBat ? join(dirname(config.waylayBat), '.waylay-launch.json') : '')
  function readWaylayLock() {
    const file = waylayLockFile()
    if (!file) return null
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      if (!data || typeof data.at !== 'number') return null
      return { ...data, file, ageMs: now() - data.at }
    } catch {
      return null
    }
  }
  function writeWaylayLock(pid) {
    const file = waylayLockFile()
    if (!file) return
    try {
      writeFileSync(file, JSON.stringify({ at: now(), pid: pid ?? 0, uin: config.waylayUin || '' }), 'utf8')
    } catch { /* 锁写不进去不应该挡住启动本身 */ }
  }
  function clearWaylayLock() {
    const file = waylayLockFile()
    if (!file || !existsSync(file)) return
    try {
      unlinkSync(file)
    } catch { /* 删不掉就算了，TTL 之后自然过期 */ }
  }

  async function status() {
    const snapshot = await inspectNow()
    const hostLog = tailLines(config.logs?.hostOut, 120, deps).join('\n')
    return {
      ...snapshot,
      // 运行时快照一并返回：面板只发一个轮询请求，避免和 SSE 抢 HTTP/1.1 的并发名额。
      runtime: runtime(),
      hostUrl: extractHostUrl(hostLog),
      hostStartedHint: /dsh web: http:\/\/127\.0\.0\.1/.test(hostLog),
      qr: qrStatus(waylayQrPath(config.waylayBat), now(), deps),
      // Waylay 状态与面板一起返回：页面一次轮询就够，不用为它多发一个请求
      waylay: await waylayStatus(),
      warnings: configWarnings(config),
      config: publicConfig(config),
    }
  }

  async function startHost() {
    if (!config.nodeExe || !config.dshBin) return { ok: false, reason: '未配置 nodeExe / dshBin，无法启动宿主' }
    const snapshot = await inspectNow()
    const busy = ['host', 'onebot'].map((name) => portRow(snapshot, name)).filter((row) => row?.listening)
    if (busy.length > 0) {
      return { ok: false, reason: `端口被占用：${busy.map((row) => `${row.port}←${row.process || '未知'}#${row.pid}`).join('、')}`, snapshot }
    }
    try {
      const { pid } = startDetached({
        command: config.nodeExe,
        args: [config.dshBin, 'web', '--no-open'],
        cwd: config.cwd || undefined,
        outFile: config.logs?.hostOut,
        errFile: config.logs?.hostErr,
        spawnImpl,
      })
      return { ok: true, pid, reason: '' }
    } catch (error) {
      return { ok: false, reason: `启动失败：${error.message}` }
    }
  }

  /** Kill whatever occupies one watched port (guard-railed). */
  async function freePort(name) {
    const snapshot = await inspectNow()
    const row = portRow(snapshot, name)
    if (!row) return { ok: false, reason: `未知端口名：${name}` }
    if (!row.listening) return { ok: false, reason: `${row.label}（${row.port}）当前没有监听进程` }
    const guard = assertKillAllowed(row.pid, { snapshot, ports: config.ports })
    if (!guard.ok) return { ok: false, reason: guard.reason }
    const result = await killTree(row.pid, { exec })
    return { ok: result.ok, reason: result.ok ? `已结束 PID ${row.pid}（${row.process || '未知'}）` : `结束失败：${result.stderr || result.message}`, pid: row.pid }
  }

  async function stopHost() {
    const snapshot = await inspectNow()
    const host = portRow(snapshot, 'host')
    if (!host?.listening) return { ok: false, reason: '宿主未在运行' }
    /**
     * ★ 2026-10-30：控制台挂进宿主之后，**宿主就是当前进程**。
     * 这时候再走 `killTree` 等于让 taskkill 结束自己（能成，但是硬杀：日志不落盘、连接全断）。
     * 所以识别出来交给调用方**优雅退出**——`self:true` 就是这个信号。
     */
    if (host.pid === process.pid) {
      return { ok: true, self: true, pid: host.pid, reason: '宿主就是当前进程（控制台挂在宿主里）—— 响应发出后退出' }
    }
    const guard = assertKillAllowed(host.pid, { snapshot, ports: config.ports })
    if (!guard.ok) return { ok: false, reason: guard.reason }
    const result = await killTree(host.pid, { exec })
    return { ok: result.ok, reason: result.ok ? `宿主已停止（PID ${host.pid}）` : '停止失败' }
  }

  /**
   * 重启宿主。
   *
   * ★ 同一个原因：「自己重启自己」不能是"杀掉再拉一个"——进程一死，后面的代码就不存在了。
   * 所以自己那条路是：先派一个**后台** cmd，等端口释放后按**原 argv** 重新拉起（宿主就是
   * `node <bin.js> web --no-open` 这么起来的，照抄 argv 比拿配置里的 dshBin 猜路径可靠），
   * 再让本进程优雅退出。独立控制台（不在宿主里）仍走老的"停 → 等 → 起"。
   */
  async function restartHost() {
    const snapshot = await inspectNow()
    const host = portRow(snapshot, 'host')
    if (host?.pid === process.pid) {
      const plan = relaunchPlan({
        delaySec,
        outFile: config.logs?.hostOut,
        errFile: config.logs?.hostErr,
      })
      if (plan.ok !== true) return { ok: false, self: true, reason: plan.reason }
      try {
        const spawned = spawnImpl(plan.file, plan.args, { detached: true, stdio: 'ignore', windowsHide: true })
        spawned?.unref?.()
      } catch (error) {
        return { ok: false, self: true, reason: `派后台重启任务失败：${error.message}` }
      }
      return {
        ok: true, self: true, restarting: true,
        reason: `已派后台任务：等 ${config.ports.host} 释放后按原命令重启宿主。这个页面会断开约 ${delaySec} 秒，刷新即可`,
      }
    }
    const stopped = await stopHost()
    await new Promise((resolve) => { setTimeout(resolve, 1500) })
    const started = await startHost()
    return { ok: started.ok, reason: `${stopped.reason}；${started.reason}` }
  }


  /**
   * 登录二维码：控制台直接画出图片，并说清"这张码是几秒前生成的"。
   * 为什么要显示新鲜度：Waylay 只在 QQ 侧产出新码时写一次文件，过期后文件就不再变化，
   * 光看"文件存在"会误以为还能扫（实测：文件是 8 分钟前的旧码）。
   */
  /**
   * 登录二维码：控制台直接画出图片，并说清"这张码是几秒前生成的"。
   * 为什么要显示新鲜度：NapCat 只在 QQ 侧产出新码时镜像一次，过期后文件就不再变化，
   * 光看"文件存在"会误以为还能扫（实测：文件是 8 分钟前的旧码）。
   */
  function qr({ maxBytes = 512 * 1024 } = {}) {
    const file = waylayQrPath(config.waylayBat) ?? ''
    const info = qrStatus(file, now(), deps.stat ? { stat: deps.stat } : undefined)
    const base = { ...info, path: file, staleSeconds: QR_STALE_SECONDS }
    if (!info.exists) {
      return {
        ok: true,
        ...base,
        dataUrl: '',
        hint: info.error
          ? `读取二维码文件失败（${info.error}）——不是"没有二维码"，请检查文件是否被占用/权限`
          : '还没有二维码文件：Waylay 没在运行，或还没走到登录界面（快登成功时不产码）',
      }
    }
    try {
      // 先看大小再读：坏掉/超大的文件不该被整块读进内存（这也是审计里补的一刀）。
      const size = (deps.stat ? deps.stat(file) : statSync(file)).size
      if (Number.isFinite(size) && size > maxBytes) {
        return { ok: true, ...base, dataUrl: '', hint: `二维码文件过大（${Math.round(size / 1024)} KB），请在文件管理器里打开：${file}` }
      }
      const buffer = (deps.readFile ?? readFileSync)(file)
      if (buffer.length > maxBytes) {
        return { ok: true, ...base, dataUrl: '', hint: `二维码文件过大（${Math.round(buffer.length / 1024)} KB），请在文件管理器里打开：${file}` }
      }
      // 只认真正的 PNG（8 字节魔数）；否则把任意文件当图片回给前端（审查提的 O2）。
      const isPng = buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
      if (!isPng) {
        return { ok: true, ...base, dataUrl: '', hint: `这个文件不是 PNG 图片（${file}），请确认 waylayBat 指向的目录里有 qrcode.png` }
      }
      // ★ 过期的码不给图（2026-10-30 用户拍板：「失效的没啥用」）：
      // 旧码扫了只会失败，还让人以为登录坏了。这里直接空图 + 说清在等新码，
      // 面板每几秒轮询，Waylay 一写出新 qrcode.png 就自动换成最新的。
      if (!info.fresh) {
        return {
          ok: true,
          ...base,
          dataUrl: '',
          hint: `二维码已过期（${info.ageSeconds >= 60 ? Math.round(info.ageSeconds / 60) + ' 分钟' : info.ageSeconds + ' 秒'}前生成），扫了也没用——等 Waylay 出下一张（这里会自动换）；一直不出就「停止」再「启动 Waylay」`,
        }
      }
      const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`
      const hint = `这张二维码是 ${info.ageSeconds} 秒前生成的，请尽快扫（QQ 的码约 1～2 分钟失效）`
      return { ok: true, ...base, dataUrl, hint }
    } catch (error) {
      return { ok: true, ...base, dataUrl: '', hint: `读取二维码失败：${error.message}` }
    }
  }

  /**
   * 让 Waylay **主动重新出一张登录码**（2026-10-30 用户原话：「刷新二维码其实不管用」——
   * 之前那个按钮只是重读 qrcode.png，文件不会变，当然没用）。
   * Waylay 的 `/api/refresh-qr` 会走 QQ 的 requestQRCode 真正请求新码，之后 qrcode.png 才会更新。
   */
  async function refreshQr() {
    const doFetch = injectedFetchJson ?? fetchJson
    const url = `http://127.0.0.1:${config.ports.waylay}/api/refresh-qr`
    const result = await doFetch(url, 5000)
    if (result.ok === true && result.json?.ok === true) {
      return { ok: true, reason: '已让 Waylay 重新出码，几秒后这里会自动换上最新的一张' }
    }
    if (result.json?.ok === false) {
      return { ok: false, reason: 'Waylay 没能生成新码：QQ 侧可能还没走到登录界面（等它到扫码那一步再试）' }
    }
    return { ok: false, reason: `请求失败：${result.reason || 'Waylay 未响应'}——13000 没在跑？先在「概览」启动 Waylay` }
  }

  // ──────────────────────────────────────────────────────────── Waylay（现在真正在用的后端）
  //
  // 与 NapCat 的根本区别：Waylay 没有独立进程，它通过 NapCat 的 DLL 注入进 QQ，跑在 QQ.exe 里面。
  // 所以这里没有"结束 napcat 加载器"那种精细目标，只有一个：**结束那个监听 13000 的 QQ**。
  // 判据全在 `lib/waylay-launch.js` 的 stopPlan()（拿不到 PID / 进程名不是 QQ / 目标是控制台自己
  // 三条都拒），这个文件只负责执行，不负责决定杀谁。

  /** GET 一个本地 JSON，超时就当失败（绝不因为状态接口慢而卡住整个面板）。 */
  function fetchJson(url, timeoutMs = 2500) {
    return new Promise((resolve) => {
      let settled = false
      const done = (value) => { if (!settled) { settled = true; resolve(value) } }
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
   * 刻意**分成两个字段**：`listening`（端口在听）和 `loggedIn`（登录态）。
   * 实测过这两者会分离：17:45 被顶号重登后端口一直在听、`logged_in` 却是 false，
   * 发消息返回 1006501 网络连接异常。只看端口会得出"一切正常"的错误结论。
   *
   * HTTP 客户端可注入（`deps.fetchJson`）：否则单测会真的去打 13000，
   * 结果取决于机器上有没有服务在跑——那种测试等于没测。
   */
  async function waylayStatus() {
    const doFetch = injectedFetchJson ?? fetchJson
    const snapshot = await inspectNow()
    const row = portRow(snapshot, 'waylay')
    const listening = Boolean(row?.listening)
    // 登录成功、13000 起来了 ⇒ 启动锁使命结束，删掉（否则 5 分钟内换号重启会被自己挡住）
    if (listening) clearWaylayLock()
    const base = {
      listening,
      port: config.ports.waylay,
      pid: row?.pid ?? null,
      process: row?.process ?? '',
      bat: config.waylayBat || '',
      logPath: waylayLogPath(config.waylayBat),
      qrPath: waylayQrPath(config.waylayBat),
      live: null,
      loggedIn: null,
      uptimeSec: null,
      uin: '',
      nickname: '',
      reverseClients: null,
      text: '',
      level: 'off',
      reason: '',
    }
    if (!listening) {
      base.text = config.waylayBat
        ? 'Waylay 未运行（13000 没有监听）'
        : `Waylay 未配置入口（waylayBat）：${WAYLAY_BAT_HINT}`
      return base
    }
    const live = await doFetch(`http://127.0.0.1:${config.ports.waylay}/api/status`)
    if (!live.ok || !live.json) {
      base.level = 'warn'
      base.reason = live.reason || '状态接口无响应'
      base.text = `端口 ${config.ports.waylay} 在听，但状态接口没响应（${base.reason}）——可能正在启动或已卡死`
      return base
    }
    const box = live.json
    const described = describeStatus({
      listening: true,
      pid: base.pid,
      loggedIn: box.logged_in === true,
      uptimeSec: Number(box.uptime_sec),
    })
    return {
      ...base,
      live: box,
      loggedIn: box.logged_in === true,
      uptimeSec: Number.isFinite(Number(box.uptime_sec)) ? Number(box.uptime_sec) : null,
      uin: String(box.uin ?? ''),
      nickname: String(box.nickname ?? ''),
      reverseClients: Number.isFinite(Number(box.onebot?.reverse_clients)) ? Number(box.onebot.reverse_clients) : null,
      level: described.level,
      text: described.text,
      reason: '',
    }
  }

  /** 启动 Waylay：跑入口 bat（内部注入 QQ），注入器返回后 QQ 在后台继续跑、不出窗口是正常的。 */
  async function startWaylay() {
    if (!config.waylayBat) return { ok: false, reason: `未配置 Waylay 入口（waylayBat）：${WAYLAY_BAT_HINT}` }
    if (!fileExists(config.waylayBat, deps)) return { ok: false, reason: `入口脚本不存在：${config.waylayBat}` }
    const snapshot = await inspectNow()
    const row = portRow(snapshot, 'waylay')
    if (row?.listening) {
      return { ok: false, reason: `Waylay 已在运行（${row.port} ← ${row.process || '未知'}#${row.pid}）。要换账号请用「重启登录」` }
    }
    const command = waylayLaunchCommand(config.waylayBat, { uin: config.waylayUin })
    if (!command) return { ok: false, reason: '无法生成启动命令' }
    // 单实例锁：二维码阶段 13000 不监听，端口判据拦不住重复点击（会开出好几个 QQ）
    const lock = readWaylayLock()
    if (lock && lock.ageMs < WAYLAY_LOCK_TTL_MS) {
      const ago = Math.max(1, Math.round(lock.ageMs / 1000))
      return {
        ok: false,
        launching: true,
        reason: `上一次启动请求还没完成（${ago} 秒前，通常在等扫码登录）——不再拉起新的 QQ，避免几个 QQ 抢同一个号互相踢下线。`
          + `确实没起来的话：先「全部停止」清掉启动锁，再启动一次`,
        lock: { at: lock.at, ageSeconds: ago },
      }
    }
    try {
      const { pid } = startDetached({
        command: command.file,
        args: command.args,
        cwd: command.cwd,
        spawnImpl,
      })
      writeWaylayLock(pid)
      return {
        ok: true,
        pid,
        reason: `已请求启动（QQ 号 ${config.waylayUin || '未指定'}）。注入器返回后 QQ 在后台继续跑，看不到窗口是正常的；`
          + `登录二维码在 ${waylayQrPath(config.waylayBat) || '（未配置）'}，或直接开 http://127.0.0.1:${config.ports.waylay}/qrcode`,
      }
    } catch (error) {
      return { ok: false, reason: `启动失败：${error.message}` }
    }
  }

  /**
   * 停止 Waylay = 结束那个被注入的 QQ。
   *
   * 目标只来自 `portRow(snapshot,'waylay')`（监听 13000 的进程），不来自镜像名、不来自猜测。
   * 用户自己另外开的 QQ 不监听 13000，因此不会被打到。
   */
  async function stopWaylay() {
    const snapshot = await inspectNow()
    const row = portRow(snapshot, 'waylay')
    const verdict = stopPlan({
      pid: row?.listening ? row.pid : null,
      processName: row?.process ?? '',
      selfPid: process.pid,
    })
    // 「停」的语义包含「放弃这次启动」：无论有没有目标，都把启动锁清掉
    clearWaylayLock()
    if (!verdict.ok) return { ok: false, reason: verdict.reason }
    const result = await killTree(verdict.plan.pid, { exec })
    return result.ok
      ? { ok: true, reason: `已结束被注入的 QQ（${row?.process || 'QQ'}#${verdict.plan.pid}），Waylay 随之停止` }
      : { ok: false, reason: `结束失败：${result.reason || '未知原因'}` }
  }

  async function startTts() {
    if (!config.ttsBat) return { ok: false, reason: '未配置本地语音启动脚本（ttsBat）' }
    try {
      const { pid } = startDetached({
        command: 'cmd.exe',
        args: ['/c', 'start', '', config.ttsBat],
        cwd: config.cwd || undefined,
        spawnImpl,
      })
      return { ok: true, pid, reason: '已请求启动本地语音' }
    } catch (error) {
      return { ok: false, reason: `启动失败：${error.message}` }
    }
  }

  async function stopTts() {
    const snapshot = await inspectNow()
    const row = portRow(snapshot, 'tts')
    if (!row?.listening) return { ok: false, reason: `本地语音未在运行（${row?.port ?? config.ports?.tts ?? 8977} 无监听）` }
    // 只杀占用语音端口的那个进程，绝不动其它 python。
    const result = await freePort('tts')
    return result
  }

  async function stopAll() {
    const results = []
    for (const [label, action] of [['宿主', stopHost], ['Waylay', stopWaylay], ['本地语音', stopTts]]) {
      try {
        const result = await action()
        results.push(`${label}：${result.ok ? '已停止' : result.reason}`)
      } catch (error) {
        results.push(`${label}：异常 ${error.message}`)
      }
    }
    return { ok: true, reason: results.join('；') }
  }

  /**
   * 一键启动（总控页）：Waylay → DSH 宿主 → 本地语音（可选）。
   * 顺序有讲究：Waylay 先起（QQ 登录慢，先排队），宿主后起时桥能立刻接上反向 WS。
   * 已在运行的项直接跳过（startHost 对"端口被占用"会报错，这里提前判掉）；
   * 单项失败不中断后面的步骤，每步结果原样汇总给面板。
   */
  async function startAll() {
    const steps = []
    const launch = async (name, isUp, action) => {
      if (isUp) {
        steps.push({ name, ok: true, skipped: true, reason: '已在运行' })
        return
      }
      try {
        const result = await action()
        steps.push({ name, ok: result?.ok === true, reason: result?.reason || (result?.ok ? '已启动' : '失败') })
      } catch (error) {
        steps.push({ name, ok: false, reason: `异常：${error.message}` })
      }
    }
    let snapshot = await inspectNow()
    await launch('Waylay', Boolean(portRow(snapshot, 'waylay')?.listening), startWaylay)
    snapshot = await inspectNow()
    await launch('DSH 宿主', Boolean(portRow(snapshot, 'host')?.listening), startHost)
    if (config.ttsBat) {
      snapshot = await inspectNow()
      await launch('本地语音', Boolean(portRow(snapshot, 'tts')?.listening), startTts)
    } else {
      steps.push({ name: '本地语音', ok: true, skipped: true, reason: '未配置（可选）' })
    }
    const ok = steps.every((step) => step.ok)
    return { ok, steps, reason: steps.map((step) => `${step.name}：${step.reason}`).join('；') }
  }

  // ------------------------------------------------------------ debugging ----

  /** Recent trace events (the bridge's decision stream), filtered. */
  function traceEvents(options = {}) {
    const events = readTraceFile(config.logs?.trace ?? '', { readFile: deps.readFile })
    return filterEvents(events, { limit: options.limit ?? 300, chatKey: options.chatKey ?? '', level: options.level ?? '', stage: options.stage ?? '', traceId: options.traceId ?? '', ok: options.ok ?? null })
  }

  /** Full decision chain for one trace id. */
  function traceChain(traceId, { limit = 500 } = {}) {
    const events = readTraceFile(config.logs?.trace ?? '', { readFile: deps.readFile })
    const filtered = events.filter((event) => event.id === traceId).slice(-limit)
    const chain = groupChains(filtered)[0] ?? null
    return chain ? { ...chain, timeline: formatChain(chain) } : null
  }

  /** Latest runtime snapshot written by the bridge plugin. */
  function runtime() {
    const data = readRuntime(config.logs?.runtime ?? '', { readFile: deps.readFile })
    if (!data) return null
    return {
      updatedAt: data.updatedAt,
      ageSeconds: Math.round((now() - (data.updatedAt ?? 0)) / 1000),
      pid: data.pid,
      version: data.version,
      uptimeSeconds: data.uptimeSeconds,
      sessions: data.sessions ?? [],
      sessionCount: data.sessionCount ?? 0,
      reminders: data.reminders ?? 0,
      votes: data.votes ?? 0,
      games: data.games ?? 0,
      joinsPending: data.joinsPending ?? 0,
      features: data.features ?? {},
      // 离线回放要用线上真实的决策配置（白名单等），随快照一起带出去
      replayHints: data.replay ?? null,
      inbox: data.inbox ?? null,
      injection: data.injection ?? null,
      // 桥写出的定时任务/自愈/webhook 描述性字段（v0.5.5「控制台看得见」用；绝无密钥）
      jobs: data.jobs ?? null,
      // 桥写出的**生效**归档目录（插件的 historyArchiveDir 住在 profile 里，控制台读不到）
      archive: data.archive ?? null,
      gate: data.gate ?? {},
      trace: data.trace ?? {},
      // 白名单已放行、但还没说过话的人/群（桥算好的差集）。控制台据此显示
      // 「已放行，等首条消息」——否则「加了人却没有新会话」在界面上完全无从判断。
      whitelistPending: data.whitelistPending ?? null,
      // 数据根目录（桥算好的绝对路径）+ 是否显式配置过。
      // 控制台用它显示「东西存在哪／一键打开」，并在没配置时给出提示。
      dataDir: data.dataDir ?? null,
    }
  }

  /**
   * 「打开数据根目录」：在资源管理器里打开她存放记忆/聊天记录/金丝雀的那个目录。
   *
   * 路径优先级：运行快照里的 `dataDir.path` → 控制台自己配的 `dataRoot` → `cwd`。
   * **先看快照**是因为快照是桥写的，代表真正在用的那个目录；控制台配置可能是旧的
   * （改完插件配置没重启控制台时两者会不一致，而"打开了错的目录"比"打不开"更难发现）。
   *
   * 目录不存在就**如实报错**，不替用户创建：打开一个新建的空目录，用户会以为数据丢了，
   * 而真正的原因往往是他把 dataDir 填错了——这时候需要看到路径，不是一个空文件夹。
   */
  function openDataDir() {
    const fromRuntime = runtime()?.dataDir?.path ?? ''
    const target = String(fromRuntime || config.dataRoot || config.cwd || '').trim()
    if (!target) {
      return { ok: false, reason: '还不知道数据根目录在哪：既没有运行快照，也没配 cwd' }
    }
    if (!isAbsolute(target)) {
      return { ok: false, reason: `数据根目录不是绝对路径：${target}（相对路径会随启动目录漂移，拒绝打开）` }
    }
    let isDir = false
    try { isDir = statSync(target).isDirectory() } catch { isDir = false }
    if (!isDir) {
      return { ok: false, reason: `目录不存在：${target} —— 桥还没往里写过东西，或者 dataDir 填错了` }
    }
    const result = openFolder(target)
    if (result?.ok === false) return { ok: false, reason: result.reason ?? '打开文件夹失败' }
    return { ok: true, path: target, source: fromRuntime ? 'runtime' : 'config', reason: `已打开 ${target}` }
  }

  /**
   * 把 `dataDir` 写进 **profile 的 `cordis.patch.yml`**（向导与面板共用同一份配置）。
   *
   * ## 为什么控制台要自己写这个文件
   *
   * 控制台的配置是 `qq-control.json`，插件的配置是 profile 的 `cordis.patch.yml` —— **两份**。
   * 很容易图省事把 `dataDir` 写进自己那份，然后看起来"设好了"，而插件压根没读到。
   * 那种失败**不报错**：面板显示一个路径、桥用另一个路径，只有用户翻聊天记录时才发现不对。
   * 所以这里直接写插件那一份，规则复用 `lib/panel.js`（`normalizeDataDir` + `upsertPatchValue`），
   * 保证「面板能填的」和「向导能填的」**是同一套校验**。
   *
   * ## 几条刻意的"不做"
   *
   * · **不创建目标目录**：只报告它存不存在。替用户建一个空目录，他会以为数据丢了；
   * · **不搬旧数据**：连金丝雀一起搬是**语义动作**（旧 canary 作废 = 把"泄露过"洗白），
   *   不能由"换个目录"这种动作顺带完成。这里只把该搬什么说清楚；
   * · **不重启宿主**：重启由用户手动触发（项目铁律）。返回里只说清"重启后生效"。
   */
  /**
   * 弹系统选文件夹窗口，只**选**不写（写完是 `setDataDir` 的事）。
   *
   * 为什么把"选"和"写"拆成两步：向导里那个输入框是给人复核的——
   * 直接写就成了"点一下即生效"，而选错目录的代价是记忆接到别处。让他看一眼再确认。
   */
  async function browseDataDir() {
    const startDir = runtime()?.dataDir?.path || config.dataRoot || config.cwd || ''
    const picked = await pickFolderDialog({
      startDir,
      ...(deps.pickExecFile ? { execFileImpl: deps.pickExecFile } : {}),
      ...(deps.platform ? { platform: deps.platform } : {}),
    })
    if (picked.ok !== true) return { ok: false, reason: picked.reason }
    return { ok: true, path: picked.path, reason: `选中 ${picked.path}` }
  }

  function setDataDir(value) {
    const checked = normalizeDataDir(value)
    if (checked.ok !== true) return { ok: false, reason: checked.reason, value: '' }
    const patchFile = String(config.patchFile ?? '')
    if (patchFile === '') {
      return { ok: false, reason: '不知道插件配置在哪：控制台没拿到 profile 名或 DSH_HOME（qq-control.json 里可填 profile）' }
    }
    const readPatch = deps.readPatchFile ?? ((file) => (existsSync(file) ? readFileSync(file, 'utf8') : ''))
    const writePatch = deps.writePatchFile ?? writeFileAtomic
    let yamlText = ''
    try {
      yamlText = String(readPatch(patchFile) ?? '')
    } catch (error) {
      return { ok: false, reason: `读不到 ${patchFile}：${error?.message ?? error}` }
    }
    const written = upsertPatchValue(yamlText, 'dataDir', checked.value)
    if (written?.ok !== true) return { ok: false, reason: written?.reason ?? '写入失败（patch 结构看不懂，宁可不写）' }
    if (written.changed === true) {
      try {
        writePatch(patchFile, written.yaml)
      } catch (error) {
        return { ok: false, reason: `写不进去 ${patchFile}：${error?.message ?? error}` }
      }
    }
    const target = describeDataDir(checked.value)
    const currentPath = runtime()?.dataDir?.path ?? String(config.dataRoot ?? '')
    const current = currentPath && currentPath !== target.path ? describeDataDir(currentPath) : null
    const warnings = []
    if (target.exists && target.qqCount > 0 && target.hasCanary !== true) {
      warnings.push('目标目录里有 qq-* 但没有 qq-canary.json：她会在那里生成一个新的金丝雀，以前贴出去的旧哨兵串就再也认不出来了')
    }
    if (current?.hasCanary === true && target.exists !== true) {
      warnings.push(`当前目录有金丝雀，新目录还不存在：搬数据时务必把 ${current.path} 下的 qq-canary.json 一起拷过去`)
    }
    if (target.exists !== true) {
      warnings.push('这个目录还不存在：宿主第一次往里写文件时会自己建（旧数据不会自动搬过来）')
    }
    return {
      ok: true,
      changed: written.changed === true,
      value: checked.value,
      profile: String(config.profile ?? ''),
      patchFile,
      target,
      current,
      warnings,
      reason: written.changed === true
        ? `已写入 ${patchFile}，**重启宿主后生效**`
        : '配置里已经是这个值（没有改动）',
    }
  }

  /** One-click diagnosis (the automated "why is it silent" checklist). */
  async function diagnose(force = false) {
    const nowMs = now()
    // 体检要跑 netstat+tasklist：5 秒内复用同一份，避免面板与验收台同时刷新时重复扫进程
    if (!force && diagnoseCache && nowMs - diagnoseCache.at < 5000) return diagnoseCache.value
    const snapshot = await inspectNow()
    const events = traceEvents({ limit: 400 })
    const report = runDiagnose({
      config: { ...config, auditLog: config.logs?.audit ?? '' },
      snapshot,
      runtime: runtime(),
      events,
      now: now(),
      files: deps,
    })
    const value = { ok: report.summary.blockers === 0, report, text: formatDiagnose(report) }
    diagnoseCache = { at: nowMs, value }
    return value
  }

  /**
   * Diagnostic bundle: logs + effective config + snapshot + diagnosis, as a zip.
   *
   * `redact: true` 走"分享安全"通路：QQ 号按位掩码、消息原文只留长度——因为这些
   * 文件（事件流/录制/日志）天然含用户数据，而这个包的使用场景就是发给别人。
   */
  async function exportBundle({ redact = false } = {}) {
    const diagnosis = await diagnose()
    const entries = []
    const take = (file, name, tailBytes) => {
      const entry = fileEntry(file, { name, tailBytes, readFile: deps.readFile ?? readFileSync, stat: deps.stat ?? statSync })
      if (!entry) return
      entries.push(redact ? { ...entry, data: redactByKind(entry.name, String(entry.data)) } : entry)
    }
    take(config.logs?.trace, 'qq-trace.jsonl', 1024 * 1024)
    take(config.logs?.audit, 'qq-actions.log', 256 * 1024)
    take(config.logs?.bridge, 'qq-bridge-debug.log', 256 * 1024)
    take(config.logs?.hostOut, 'qq-host-out.log', 128 * 1024)
    take(config.logs?.hostErr, 'qq-host-err.log', 128 * 1024)
    take(config.logs?.runtime, 'qq-runtime.json')
    entries.push({ name: 'diagnose.json', data: JSON.stringify(redact ? redactByKind('x.json', JSON.stringify(diagnosis.report, null, 2)) : diagnosis.report, null, 2) })
    entries.push({ name: 'diagnose.txt', data: redact ? redactByKind('x.log', diagnosis.text) : diagnosis.text })
    const environment = {
      generatedAt: new Date(now()).toISOString(),
      controlConfig: publicConfig(config),
      ports: (await inspectNow()).ports,
      runtime: runtime(),
      traceSummary: summarizeEvents(traceEvents({ limit: 2000 })),
    }
    entries.push({ name: 'environment.json', data: JSON.stringify(redact ? JSON.parse(redactByKind('x.json', JSON.stringify(environment))) : environment, null, 2) })
    if (redact) entries.push({ name: 'REDACTED.json', data: JSON.stringify(redactionNote(), null, 2) })
    const buffer = buildZip(entries, { now: new Date(now()) })
    lastExportSummary = {
      at: now(), entries: entries.length, bytes: buffer.length, redacted: redact,
      filename: `qq-diagnose${redact ? '-redacted' : ''}-${new Date(now()).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.zip`,
    }
    return { ok: true, entries: entries.length, bytes: buffer.length, buffer, filename: lastExportSummary.filename }
  }

  // ------------------------------------------------------------ 验收台 ----

  /** 体检包里会收集的产物（验收台据它判断"可导出"）。 */
  function exportSources() {
    return [
      { name: '事件流', file: config.logs?.trace },
      { name: '写操作审计', file: config.logs?.audit },
      { name: '桥调试日志', file: config.logs?.bridge },
      { name: '宿主 stdout', file: config.logs?.hostOut },
      { name: '运行快照', file: config.logs?.runtime },
    ].map((entry) => ({ name: entry.name, present: Boolean(entry.file) && existsSync(entry.file) }))
  }

  /** 回放沙箱数量（`qq-replay/run-*`，不含回收站）。 */
  function sandboxCount() {
    if (!config.cwd) return 0
    try {
      return readdirSync(join(config.cwd, 'qq-replay'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== '_trash').length
    } catch {
      return 0
    }
  }

  /**
   * v0.4「一切皆可调试」6 条硬约束的实时验收：每条都用**现有产物**算证据，
   * 不达标时直接说明该点哪里。
   */
  async function acceptance() {
    const report = buildAcceptance({
      events: traceEvents({ limit: 500 }),
      runtime: runtime(),
      inbox: inboxList({ limit: 1 }),
      lastReplay: lastReplaySummary,
      lastExport: lastExportSummary,
      diagnosis: await diagnose(),
      exportSources: exportSources(),
      sandboxCount: sandboxCount(),
      now: now(),
    })
    return { ok: report.ok, report, text: formatAcceptance(report), verdict: report.verdict, totals: report.totals }
  }

  // -------------------------------------------------- 录制 / 回放 / 注入 ----

  const inboxFile = () => config.logs?.inbox || (config.cwd ? join(config.cwd, 'qq-inbox.jsonl') : '')
  const injectFile = () => config.logs?.inject || (config.cwd ? join(config.cwd, 'qq-inject.jsonl') : '')
  const trashDir = () => (config.cwd ? join(config.cwd, 'qq-trash') : '')

  /** Recently recorded inbound frames (what the bridge actually received). */
  function inboxList({ limit = 50 } = {}) {
    const file = inboxFile()
    const present = Boolean(file) && existsSync(file)
    const all = present ? readInbox(file, { limit: 500 }) : []
    const capped = all.slice(-Math.min(500, Math.max(1, Number(limit) || 50)))
    return {
      file,
      exists: present,
      recorded: all.length,
      queued: countLines(injectFile()),
      entries: capped.map((entry, index) => ({
        index: all.length - capped.length + index,
        ts: entry.ts,
        at: new Date(entry.ts).toLocaleString('zh-CN', { hour12: false }),
        kind: entry.kind,
        text: describeFrame(entry),
        messageId: entry.frame?.messageId ?? '',
        chatKey: entry.frame?.groupId ? `g:${entry.frame.groupId}` : (entry.frame?.userId ? `u:${entry.frame.userId}` : ''),
        frame: entry.frame,
      })),
    }
  }

  /** Offline dry-run replay of recorded (or hand-made) frames. */
  async function replay({ entries = null, indices = null, limit = 5, replyText = '', overrides = {}, budgetMs = 20000 } = {}) {
    const list = Array.isArray(entries) && entries.length > 0 ? entries : selectEntries(indices, limit)
    if (list.length === 0) return { ok: false, reason: '没有可回放的记录（qq-inbox.jsonl 为空或未启用录制）' }
    const replayer = replayerFor()
    const hints = runtime()?.replayHints ?? null
    let report
    try {
      report = await replayer.run({ entries: list, replyText, overrides, hints, budgetMs, maxEntries: 20 })
    } catch (error) {
      return { ok: false, reason: `回放执行失败：${error.message}` }
    }
    lastReplaySummary = {
      at: now(),
      ok: report.ok,
      reason: report.reason ?? '',
      durationMs: report.durationMs,
      totals: report.totals,
      safety: report.safety,
      sandbox: report.sandbox,
      entries: (report.results ?? []).length,
    }
    return { ok: report.ok, reason: report.ok ? '' : (report.reason ?? '回放中有条目出错'), report, text: report.text, totals: report.totals, warnings: report.warnings, sandbox: report.sandbox }
  }

  function selectEntries(indices, limit) {
    const all = inboxList({ limit: 500 }).entries
    if (!all.length) return []
    if (Array.isArray(indices) && indices.length > 0) {
      const wanted = new Set(indices.map((index) => Number(index)).filter((index) => Number.isInteger(index) && index >= 0))
      return all.filter((item) => wanted.has(item.index)).slice(0, 20)
    }
    return all.slice(-Math.min(20, Math.max(1, Number(limit) || 5)))
  }

  function replayerFor() {
    if (!replayer) {
      replayer = createReplayer({
        pluginRoot: config.pluginRoot || defaultPluginRoot(),
        sourceCwd: config.cwd || '',
        botQq: runtime()?.replayHints?.botQq ?? 0,
        logger: deps.logger ?? console,
        deps,
      })
    }
    return replayer
  }

  /**
   * Queue one synthetic frame for the live bridge's injector. The line is validated
   * with the exact same parser the bridge uses, so a bad spec is rejected here with
   * a Chinese reason instead of silently doing nothing later.
   */
  function inject(spec = {}) {
    const file = injectFile()
    if (!file) return { ok: false, reason: '未配置注入文件路径（控制台配置缺少 cwd）' }
    const botQq = runtime()?.replayHints?.botQq ?? 0
    let parsed
    try {
      parsed = parseInjectionLine(JSON.stringify(spec), { botQq })
    } catch (error) {
      return { ok: false, reason: `注入参数不合法：${error.message}` }
    }
    const run = runtime()
    if (run && run.injection && run.injection.enabled === false) {
      // 不静默失败：通道没开就直说，并给出该改哪个开关。
      return { ok: false, reason: '桥的注入通道当前未开启（需在插件配置里打开 injectEnabled=true 并重启宿主）', parsed: parsed.frame }
    }
    const line = JSON.stringify({ ...spec, __queuedAt: Date.now() })
    if (!appendCappedLine(file, line, { maxBytes: 1024 * 1024, keepBytes: 128 * 1024 })) {
      return { ok: false, reason: `写入注入文件失败：${file}` }
    }
    return {
      ok: true,
      reason: `已入队（桥每 ${run?.injection?.intervalMs ?? 2000}ms 轮询一次，dry-run=${run?.injection?.dryRun !== false ? '开' : '关'}）`,
      file,
      preview: describeFrame({ kind: parsed.kind, frame: parsed.frame }),
      dryRun: run?.injection?.dryRun !== false,
    }
  }

  /** Clear the injection queue (moved to the local trash, never deleted). */
  function clearQueue() {
    const file = injectFile()
    if (!file || !existsSync(file)) return { ok: false, reason: '注入队列本来就是空的' }
    const moved = moveToTrash(file, trashDir())
    return moved
      ? { ok: true, reason: `注入队列已移入回收站：${moved}` }
      : { ok: false, reason: `无法移动 ${file}（可能被占用，已保持原样）` }
  }

  /**
   * 历史归档目录。优先级：运行快照里桥自己写出的生效目录 > 控制台配置的显式覆盖 > <cwd>/qq-history。
   * 为什么先看快照：`historyArchiveDir` 是**插件**的配置键，住在 profile 的 cordis.patch.yml 里，
   * 控制台进程读不到；只看控制台配置就会在用户自定义目录时显示 0 个文件还自称"群里 /找 用的就是它"。
   */
  function archiveDir() {
    const fromRuntime = runtime()?.archive
    if (fromRuntime && typeof fromRuntime.dir === 'string' && fromRuntime.dir.trim() !== '') return fromRuntime.dir
    const candidate = typeof config.historyArchiveDir === 'string' && config.historyArchiveDir.trim() !== ''
      ? config.historyArchiveDir
      // 兼容早期控制台里可能写过的旧键（插件 schema 里没有 historyDir，仅作回落）
      : (typeof config.historyDir === 'string' && config.historyDir.trim() !== '' ? config.historyDir : '')
    return candidate || join(config.cwd || process.cwd(), 'qq-history')
  }

  /** 「群资产」页：归档概览（文件数/体积/最早最新/回收目录）。只读本机文件，不碰宿主进程。 */
  function archiveStats() {
    const dir = archiveDir()
    try {
      const archive = new HistoryArchive({ dir })
      const stats = archive.stats()
      let trashDirs = []
      try {
        const trashRoot = join(config.cwd || process.cwd(), 'qq-trash')
        trashDirs = existsSync(trashRoot) ? readdirSync(trashRoot).sort().slice(-7) : []
      } catch { /* 回收目录不可读就当没有 */ }
      return { ok: true, ...stats, dir, exists: existsSync(dir), trashDirs }
    } catch (error) {
      return { ok: false, reason: `读取归档失败：${error.message}`, dir }
    }
  }

  /**
   * 归档检索：刻意复用插件同一套 HistoryArchive，控制台里搜出来的口径与群里 `/找` 完全一致。
   */
  function archiveSearch(query, { days = 7, limit = 20, chatKey = '' } = {}) {
    const keyword = String(query ?? '').trim()
    if (keyword === '') return { ok: false, reason: '请给出关键词' }
    try {
      const archive = new HistoryArchive({ dir: archiveDir() })
      const result = archive.search(keyword, { days, limit, chatKey })
      return { ok: true, query: keyword, days, limit, chatKey, ...result }
    } catch (error) {
      return { ok: false, reason: `检索失败：${error.message}` }
    }
  }

  /**
   * 「性能」面板（v0.5.5）：把 trace 事件喂给纯计算模块 control/lib/perf.mjs，
   * 得到 P50/P95 端到端延迟、阶段耗时画像与失败画像。控制台自己不做统计口径的二次发明。
   */
  function perf({ limit = 5000, chatKey = '', windowMinutes = 0 } = {}) {
    const events = readTraceFile(config.logs?.trace ?? '', { readFile: deps.readFile })
    const cutoff = windowMinutes > 0 ? now() - windowMinutes * 60_000 : 0
    const scoped = cutoff > 0 ? events.filter((event) => Number(event?.ts) >= cutoff) : events
    const capped = scoped.slice(-Math.max(100, Math.min(20000, Number(limit) || 5000)))
    return { ok: true, ...perfReport(capped, { chatKey, now: now() }), windowMinutes }
  }

  /** 「定时任务」面板：播报任务 / webhook 来源 / 掉线自愈 / 注入队列。 */
  function jobsView() {
    return { ok: true, ...jobsReport(runtime(), { now: now() }) }
  }

  /** 「群配置」面板：每个群的生效开关 + 白名单 + 最近回合 + 挂在该群上的定时任务。 */
  function groups() {
    return { ok: true, ...groupsReport(runtime(), { now: now() }) }
  }

  /**
   * 「人设」面板：读写数据目录下的 `AGENTS.md`（2026-11-01，用户报「人设设置没了啊」）。
   *
   * 为什么只认这一个文件：人设本体就是 DSH 的 `AGENTS.md`（README 第 616 行写明本插件
   * **不内置人设**，灵魂由人设文件/记忆提供）。做成通用文件编辑器等于给控制台开一个
   * 任意文件写入的口子，所以路径在这里**钉死**，不接受调用方传任何路径参数。
   *
   * 保存前一定留备份：人设是手写长文，一次误覆盖就是几小时的活。
   */
  function personaFile() {
    const cwd = String(config.cwd ?? '').trim()
    return cwd ? join(cwd, 'AGENTS.md') : ''
  }

  /**
   * 「人设库」：`cwd/personas/*.md`，每次一份完整的、可切换的人设（2026-11-01 夜）。
   *
   * 为什么要一个目录而不是"多份 AGENTS.md"：宿主只认 `cwd/AGENTS.md` 这一个文件名
   * （`dsh-agent-instructions` 的候选名固定），所以**只有它生效**。
   * 于是模型是：`personas/` 放所有备选，切换 = 把选中的那份复制成 `AGENTS.md`，
   * 旧 `AGENTS.md` 照例先备份。这样"谁是当前人设"永远只有一个答案，不会出现
   * 两份文件都觉得自己生效。
   */
  function personaDir() {
    const file = personaFile()
    return file ? join(dirname(file), 'personas') : ''
  }

  /**
   * 人设名只许"像文件名"：不允许斜杠、不允许以点开头、不允许 `..`。
   *
   * 这条是**安全边界**，不是洁癖：名字会拼成路径，`../../AGENTS.md` 这种写法
   * 等于给控制台开一个任意文件写入的口子（人设面板的注释里写过同一条理由）。
   */
  function validPersonaName(name) {
    const value = String(name ?? '').trim()
    if (value === '' || value.length > 40) return ''
    if (value.startsWith('.')) return ''
    if (/[\\/:*?"<>|]/.test(value)) return ''
    if (value.includes('..')) return ''
    return value
  }

  function personaPathOf(name) {
    const dir = personaDir()
    const safe = validPersonaName(name)
    if (!dir || safe === '') return ''
    return join(dir, `${safe}.md`)
  }

  /** 两个字符串内容是否相同（用哈希比，别拿整段文本比——人设是几 KB 的长文）。 */
  function sameText(a, b) {
    return createHash('sha1').update(String(a ?? ''), 'utf8').digest('hex')
      === createHash('sha1').update(String(b ?? ''), 'utf8').digest('hex')
  }

  /**
   * 列出所有人设 + 当前生效的那份。
   *
   * 「哪份在生效」用**内容比对**判定，不看文件名也不看时间戳：
   * 用户完全可能手改 `AGENTS.md` 而没动 `personas/`，那时"上次切换的是哪份"就是历史，
   * 只有"内容相同"才是事实。比对不上就如实说"当前是散装内容，不属于任何一份"。
   */
  function personaList() {
    const file = personaFile()
    const dir = personaDir()
    if (!file) return { ok: false, reason: '还没配置数据目录（cwd），不知道人设放哪' }
    let activeText = ''
    let activeInfo = null
    try {
      if (existsSync(file)) {
        activeText = readFileSync(file, 'utf8')
        const st = statSync(file)
        activeInfo = { file, bytes: st.size, updatedAt: st.mtimeMs }
      }
    } catch { activeInfo = null }
    const rows = []
    if (dir && existsSync(dir)) {
      let names = []
      try { names = readdirSync(dir).filter((name) => name.endsWith('.md')) } catch { names = [] }
      for (const entry of names) {
        const full = join(dir, entry)
        try {
          const text = readFileSync(full, 'utf8')
          const st = statSync(full)
          rows.push({
            name: entry.replace(/\.md$/, ''),
            file: full,
            bytes: st.size,
            updatedAt: st.mtimeMs,
            active: activeInfo !== null && sameText(text, activeText),
          })
        } catch { /* 读不了的单项跳过，不让整个列表失败 */ }
      }
    }
    rows.sort((a, b) => (Number(b.active) - Number(a.active)) || a.name.localeCompare(b.name, 'zh'))
    return { ok: true, dir, active: activeInfo, rows, activeMatched: rows.some((row) => row.active) }
  }

  /** 把编辑框里的内容另存为一份人设（**不动** AGENTS.md）。 */
  function personaSaveAs(name, text, { overwrite = false } = {}) {
    const full = personaPathOf(name)
    if (full === '') return { ok: false, reason: '人设名不合法（不能为空、不能带 / \\ : * ? " < > |，不能以点开头，不能含 ..）' }
    const body = String(text ?? '')
    if (body.trim() === '') return { ok: false, reason: '内容是空的，不存' }
    if (Buffer.byteLength(body, 'utf8') > 60 * 1024) return { ok: false, reason: '人设超过 60 KB，控制台不接这么大的文件' }
    if (existsSync(full) && overwrite !== true) {
      return { ok: false, reason: `已经有一份叫「${validPersonaName(name)}」的人设了。勾上"覆盖同名"再存，或者换个名字。` }
    }
    try {
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, body, 'utf8')
    } catch (error) {
      return { ok: false, reason: `存不下来：${error.message}` }
    }
    return { ok: true, name: validPersonaName(name), file: full, bytes: Buffer.byteLength(body, 'utf8') }
  }

  /**
   * 切换当前人设：把选中的那份复制成 `AGENTS.md`，旧内容先备份。
   *
   * 顺序是"先备份旧 AGENTS.md，再写新的"——反过来一旦写失败，人就没了。
   */
  function personaActivate(name) {
    const file = personaFile()
    const full = personaPathOf(name)
    if (!file) return { ok: false, reason: '还没配置数据目录（cwd），不知道人设放哪' }
    if (full === '') return { ok: false, reason: '人设名不合法' }
    if (!existsSync(full)) return { ok: false, reason: `没有这份人设：${validPersonaName(name)}` }
    let text = ''
    try { text = readFileSync(full, 'utf8') } catch (error) { return { ok: false, reason: `读不了 ${full}：${error.message}` } }
    let backup = ''
    try {
      if (existsSync(file)) {
        backup = personaBackupName(dirname(file))
        writeFileSync(backup, readFileSync(file))
      }
      writeFileSync(file, text, 'utf8')
    } catch (error) {
      return { ok: false, reason: `切换失败：${error.message}` }
    }
    return {
      ok: true, name: validPersonaName(name), file, backup, bytes: Buffer.byteLength(text, 'utf8'),
      note: '已切换。宿主逐轮对账，下一轮就是新的人设；旧的那份已经备份。',
    }
  }

  /**
   * 把当前 `AGENTS.md` 收进人设库（"存下来以后还能切回来"）。
   * 不带名字时按时间戳起一个，免得用户为了起名卡住。
   */
  function personaArchiveCurrent(name = '') {
    const file = personaFile()
    if (!file || !existsSync(file)) return { ok: false, reason: '当前还没有 AGENTS.md，没得存' }
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch (error) { return { ok: false, reason: `读不了：${error.message}` } }
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const fallback = `人设-${stamp}`
    return personaSaveAs(validPersonaName(name) || fallback, text, { overwrite: false })
  }

  function personaRead() {
    const file = personaFile()
    if (!file) return { ok: false, reason: '还没配置数据目录（cwd），不知道人设文件放哪' }
    if (!existsSync(file)) return { ok: true, file, exists: false, text: '', bytes: 0, lines: 0, analysis: analyzePersona('') }
    try {
      const text = readFileSync(file, 'utf8')
      const st = statSync(file)
      return {
        ok: true, file, exists: true, text,
        bytes: st.size, lines: text.split('\n').length, updatedAt: st.mtimeMs,
        // 校验跟着读一起回：面板不用再多打一次接口，也不会出现"文字是新的、结论是旧的"。
        analysis: analyzePersona(text),
      }
    } catch (error) {
      return { ok: false, reason: `读不了 ${file}：${error.message}` }
    }
  }

  /** 标准骨架 + 每块的"要回答什么/别写什么"。面板拿它做提示，不落盘。 */
  function personaTemplate() {
    return {
      ok: true,
      template: PERSONA_TEMPLATE,
      budgetBytes: PERSONA_BUDGET_BYTES,
      blocks: PERSONA_BLOCKS.map(({ id, title, required, targetBytes, ask, avoid }) => ({ id, title, required, targetBytes, ask, avoid })),
    }
  }

  /**
   * 备份文件名的时间戳：**本地时间**，且同秒不撞名。
   *
   * 原来用 `toISOString()`：那是 UTC，比本地时间早 8 小时，备份文件名看着"更旧"，
   * 排查时容易把先后顺序读反。更要紧的是同一秒内保存两次会算出同一个名字 ——
   * 第二份备份把第一份**覆盖**掉，而人设是手写长文，那份被盖掉的往往就是要找的那版。
   */
  function personaBackupName(dir, at = new Date()) {
    const pad = (n) => String(n).padStart(2, '0')
    const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`
      + `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
    let candidate = join(dir, `AGENTS.backup-${stamp}.md`)
    for (let i = 2; existsSync(candidate); i += 1) {
      candidate = join(dir, `AGENTS.backup-${stamp}-${i}.md`)
    }
    return candidate
  }

  /** 列出现有备份（新的在前）。只读，不删 —— 备份是用户的退路，删它不属于"顺手清理"。 */
  function personaBackups() {
    const file = personaFile()
    const dir = file ? dirname(file) : ''
    if (!dir || !existsSync(dir)) return []
    let names = []
    try { names = readdirSync(dir).filter((name) => /^AGENTS\.backup-.+\.md$/.test(name)) } catch { return [] }
    const rows = names.map((name) => {
      const full = join(dir, name)
      try {
        const st = statSync(full)
        return { name, bytes: st.size, updatedAt: st.mtimeMs }
      } catch { return null }
    }).filter((row) => row !== null)
    // 排序按**写入时间**，不按文件名：同秒撞名时文件名是 `…-212645.md` 和 `…-212645-2.md`，
    // 而 `-`(0x2d) 小于 `.`(0x2e)，纯字典序会把后写的那份排到前面 —— 顺序反了。
    rows.sort((a, b) => (b.updatedAt - a.updatedAt) || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
    return rows
  }

  /** 读一份备份的正文。名字已在 server 层校验过形状，这里再 basename 一次防穿越。 */
  function personaBackupText(name) {
    const file = personaFile()
    const dir = file ? dirname(file) : ''
    const base = basename(String(name ?? ''))
    if (!dir || base !== String(name ?? '') || !/^AGENTS\.backup-[^\\/]+\.md$/.test(base)) {
      return { ok: false, reason: '备份名不合法' }
    }
    const full = join(dir, base)
    try {
      const text = readFileSync(full, 'utf8')
      return { ok: true, name: base, text, bytes: Buffer.byteLength(text, 'utf8') }
    } catch (error) {
      return { ok: false, reason: `读不了 ${base}：${error.message}` }
    }
  }

  function personaWrite(text) {
    const file = personaFile()
    if (!file) return { ok: false, reason: '还没配置数据目录（cwd），不知道人设文件放哪' }
    const body = String(text ?? '')
    // 上限要对齐控制台的 MAX_BODY_BYTES（64 KiB）：写成更大的值只会让用户在
    // 「保存」时收到一个 413，而不是在这里就被告知"太大了"。
    // ⚠️ 用**字节**不是字符数：`body.length` 对中文只有实际字节的 1/3，
    // 按字符判会让 180 KB 的中文混过去，最后由 HTTP 层吐一个 413。
    const maxBytes = 60 * 1024
    const size = Buffer.byteLength(body, 'utf8')
    if (size > maxBytes) return { ok: false, reason: `人设 ${Math.round(size / 1024)} KB，超过控制台 ${Math.round(maxBytes / 1024)} KB 的上限` }
    let backup = ''
    try {
      if (existsSync(file)) {
        backup = personaBackupName(dirname(file))
        writeFileSync(backup, readFileSync(file))
      }
      writeFileSync(file, body, 'utf8')
    } catch (error) {
      return { ok: false, reason: `保存失败：${error.message}` }
    }
    /**
     * `note` 说的是**宿主实际怎么用这个文件**，不能拍脑袋。
     *
     * 事实（`@deepseek-ai/dsh-agent-instructions`，本 profile 已挂、`maxBytes: 32768`）：
     *   - 会话建立时读一次基线；
     *   - 之后**每轮**都会对账，文件变了就补一条「Updated instructions from: …」的更新块；
     *   - 内容是作为 instruction 段**追加**进 system 的（`<system-reminder>` 包着），
     *     不替换宿主自己的基础指令；
     *   - 有 32 KiB 预算，**超过会截断/省略**（还会在提示里写一行 budget 说明）。
     * 所以"要重开会话才生效"是错的（那是没核实前的推测），真正需要提醒的是预算。
     */
    // 预算从 persona-spec 里取，别在这里再写一遍 32 —— 两处常数一旦漂移，
    // 「保存时说没超、读取时说超了」这种自相矛盾就会出现。
    const budget = PERSONA_BUDGET_BYTES
    const bytes = Buffer.byteLength(body, 'utf8')
    const note = bytes > budget
      ? `已保存 ${bytes} 字节，但宿主的人设预算只有 ${Math.round(budget / 1024)} KiB —— 超出的部分会被截断，她只能看到前半段。建议拆成多个文件或精简。`
      : `已保存。宿主人设预算 ${Math.round(budget / 1024)} KiB，当前用到 ${bytes} 字节。改动会在下一轮生效（宿主逐轮对账）。`
    return { ok: true, file, backup, bytes, note }
  }

  return {
    status, startHost, stopHost, restartHost, freePort, startTts, stopTts, stopAll, startAll, qr,
    // Waylay：v0.8.0 起唯一的后端
    waylayStatus, startWaylay, stopWaylay, refreshQr,
    traceEvents, traceChain, runtime, diagnose, exportBundle, acceptance,
    inboxList, replay, inject, clearQueue, archiveStats, archiveSearch,
    perf, jobsView, groups, openDataDir, setDataDir, browseDataDir,
    // 人设读写（只认 cwd/AGENTS.md，见 personaFile 的注释）；backups 只读不删
    personaRead, personaWrite, personaBackups, personaBackupText, personaTemplate,
    // 人设库：personas/*.md 是备选，AGENTS.md 是唯一生效的那份
    personaList, personaSaveAs, personaActivate, personaArchiveCurrent,
    // 每个调用方（每个 SSE 连接）拿一份独立 tailer：共用模块级单例会让两个面板互相"偷"事件，
    // 也会让同一进程里的第二个 supervisor 读到别人的事件文件。
    tailer: () => createTraceTailer(config.logs?.trace ?? ''),
    logFile: (name) => {
      if (name === 'trace') return config.logs?.trace ?? ''
      if (name === 'runtime') return config.logs?.runtime ?? ''
      if (name === 'audit') return config.logs?.audit ?? ''
      return config.logs?.[name] ?? ''
    },
  }
}
