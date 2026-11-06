/**
 * Waylay 启动 / 停止的**纯逻辑**（替代 `lib/napcat-launch.js` 的角色）。
 *
 * 本模块不执行任何东西：命令怎么拼、PID 怎么认，都是纯函数，执行交给调用方
 * （`control/lib/supervisor.mjs`）。这样能脱离真实进程做单测。
 *
 * ── 与 NapCat 的三处根本差异（决定了为什么不能只换字符串）────────────────
 *
 * ① **没有独立进程。** Waylay 是通过 NapCat 的 `NapCatWinBootHook.dll` 注入进 QQ 的，
 *    跑在 **QQ.exe 内部**。所以「停止 Waylay」在物理上只有一个办法：结束那个 QQ 进程。
 *
 *    ⚠️ 这里直接撞上 `napcat-launch.js` 立的铁律：「绝不能按镜像名杀 QQ
 *    （`taskkill /IM QQ.exe` 会连用户自己的 QQ 一起杀掉）」。
 *    本模块的解法是**按端口反查 PID**：只有监听着 13000 的那个 QQ 才是被注入的，
 *    用户自己另外开的 QQ 不监听 13000，因此永远不会被误杀。
 *    `stopPlan()` 还会再核对进程名必须是 QQ 系（`qq.exe` / `qqex.exe`），双重保险。
 *
 * ② **没有加载器候选表。** NapCat 那边要在 launcher.bat / napcat.bat 之间挑（选错会秒退，
 *    见 napcat-launch.js 顶部第 ④ 条）。Waylay 只有一个入口 `rin-waylay.bat`，
 *    参数也只有 QQ 号，不需要判定。
 *
 * ③ **没有 token。** NapCat 的 WebUI 要带 token 拼 URL（要读 `bootmain/config/webui.json`）；
 *    Waylay 的控制台是 `127.0.0.1:13000` 的裸 HTTP，`/api/status` 直接给 JSON。
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Waylay 控制台 / 状态接口端口。由 `rin-launch.bat` 的 `BRIDGE_PORT` 决定。 */
export const WAYLAY_PORT = 13000

/** 注入日志：loader 与 Waylay 的 console 输出都 tee 到这里。 */
export const WAYLAY_LOG_FILE = 'rin-inject.log'

/** 二维码落盘位置（快登失败时才生成）。对应 `rin-launch.bat` 的 `RIN_QR_PATH`。 */
export const WAYLAY_QR_FILE = 'qrcode.png'

/** 双击入口（内部 `call rin-launch.bat waylay <uin>`）。 */
export const WAYLAY_ENTRY_FILE = 'rin-waylay.bat'

/** 真正的发射器：注入器 + 环境变量都在这个脚本里。 */
export const WAYLAY_LAUNCH_FILE = 'rin-launch.bat'

/** 找不到入口时给用户看的提示（别只说"路径不对"）。 */
export const WAYLAY_BAT_HINT =
  '把发行包里的 rin-inject\\ 目录放在插件目录旁边（或插件目录内），'
  + '或在 qq-control.json 里把 waylayBat 指到 rin-waylay.bat；'
  + '它内部会 call rin-launch.bat waylay <QQ号>'

/**
 * 干净机 / 发行版布局里 Waylay 运行时的候选目录。
 *
 * 2026-11-06 虚拟机「从头装一遍」实测：控制台原来只推 `<cwd>/../_tmp/rin-inject`
 * ——那是**开发机**布局。把发行版解到 `C:\...\real-install\` 之后，运行时在
 * `real-install\rin-inject`，插件在 `real-install\qq-integration`，两者是**兄弟目录**，
 * 于是「启动 Waylay」永远报"找不到入口"，只能手工填 waylayBat。
 * 这不是"用户没配"，是探测本身只认作者自己的目录形状。
 *
 * 纯字符串函数：不碰磁盘、不假定盘符，交给 `detectWaylayBat({ extra })` 去逐个 exists。
 * 顺序 = 优先级：显式配置/环境变量（在 detectWaylayBat 里）> 发行版 > 开发机。
 *
 * @param {{repo?: string, cwd?: string}} paths repo = 插件仓库根；cwd = 宿主工作目录
 * @returns {string[]} 目录绝对路径列表（去重）
 */
export function waylayRuntimeCandidates({ repo = '', cwd = '' } = {}) {
  const dirs = []
  const push = (value) => { if (value && !dirs.includes(value)) dirs.push(value) }
  if (repo) {
    push(join(repo, 'rin-inject'))                      // 运行时打进插件包内
    push(join(resolve(repo, '..'), 'rin-inject'))       // 发行版：两个包并列解压
  }
  if (cwd) {
    push(join(cwd, 'rin-inject'))                       // 数据目录内
    push(join(resolve(cwd, '..'), 'rin-inject'))        // 数据目录的兄弟
    push(join(resolve(cwd, '..'), '_tmp', 'rin-inject')) // 开发机老布局，留着兼容
  }
  return dirs
}

/** QQ 客户端的镜像名（停止前必须核对，避免误杀别的进程）。 */
export const QQ_IMAGE_RE = /^qq(ex)?\.exe$/i

/** QQ 客户端识别（v0.8.0 自 napcat-launch.js 搬来）：个人 QQ 客户端仅作保护性展示，永远不可杀。 */
export const QQ_CLIENT_RE = /^qq(ex)?\.exe$/i

/**
 * 解析 `tasklist /FO CSV /NH` 输出为 pid → 镜像名 Map。
 * 「停止」要在现场反查一次进程名（v0.8.0 自 napcat-launch.js 搬来——那是它唯一还活着的部分）。
 */
export function parseTasklist(text) {
  const map = new Map()
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const cells = line.match(/"([^"]*)"/g)
    if (!cells || cells.length < 2) continue
    const name = cells[0].replace(/"/g, '')
    const pid = Number(cells[1].replace(/"/g, ''))
    if (Number.isFinite(pid)) map.set(pid, name)
  }
  return map
}

/**
 * 探测 Waylay 入口脚本。
 *
 * 优先级：显式配置 > 环境变量 `RIN_WAYLAY_BAT` > 常见默认位置。
 * 与 NapCat 那边不同，这里**不需要在多个候选 bat 之间猜**——只有这一个入口。
 *
 * @returns {string} 绝对路径；找不到返回 ''
 */
export function detectWaylayBat({ configured = '', env = process.env, exists = existsSync, extra = [] } = {}) {
  const candidates = [
    configured,
    env.RIN_WAYLAY_BAT,
    env.RIN_HOME ? join(env.RIN_HOME, WAYLAY_ENTRY_FILE) : '',
    ...(Array.isArray(extra) ? extra : []),
  ]
  for (const raw of candidates) {
    const value = String(raw ?? '').trim()
    if (value === '') continue
    // 允许直接给目录：自动补上入口文件名
    const asFile = exists(value) && !/\.(bat|cmd)$/i.test(value) ? join(value, WAYLAY_ENTRY_FILE) : value
    try {
      if (exists(asFile)) return resolve(asFile)
    } catch { /* 权限问题也当成不存在 */ }
  }
  return ''
}

/** 入口脚本同目录下的注入日志。 */
export function waylayLogPath(batPath) {
  return batPath ? join(dirname(batPath), WAYLAY_LOG_FILE) : ''
}

/** 入口脚本同目录下的二维码。 */
export function waylayQrPath(batPath) {
  return batPath ? join(dirname(batPath), WAYLAY_QR_FILE) : ''
}

/**
 * 从 `netstat -ano` 文本里找出**监听**指定端口的 PID。
 *
 * 只认 `LISTENING` 行：注入后 QQ 会监听该端口；用户自己开的 QQ 不会。
 * 这是「停止」唯一允许的定位方式（见文件头 ① ）。
 *
 * @returns {{ pid: number, local: string } | null}
 */
export function parseListenerPid(netstatText, port = WAYLAY_PORT) {
  const text = String(netstatText ?? '')
  if (text.trim() === '') return null
  const needle = `:${port}`
  for (const line of text.split(/\r?\n/)) {
    // 形如：  TCP    0.0.0.0:13000    0.0.0.0:0    LISTENING    37256
    if (!/LISTENING/i.test(line)) continue
    if (!line.includes(needle)) continue
    const cols = line.trim().split(/\s+/)
    if (cols.length < 5) continue
    const local = cols[1] ?? ''
    // 精确到端口号边界，避免 :13000 命中 :130001
    if (!new RegExp(`:${port}$`).test(local)) continue
    const pid = Number(cols[cols.length - 1])
    if (Number.isInteger(pid) && pid > 0) return { pid, local }
  }
  return null
}

/**
 * 拼启动命令。
 *
 * 为什么用 `cmd.exe /c` 而不是直接 spawn bat：Windows 上 `.bat` 不是可执行文件，
 * spawn 直接调会 ENOENT 或静默不执行。
 *
 * @returns {{ file: string, args: string[], cwd: string } | null}
 */
export function waylayLaunchCommand(batPath, { uin = '', comspec = process.env.ComSpec || 'cmd.exe' } = {}) {
  if (!batPath) return null
  const args = ['/c', batPath]
  const uinText = String(uin ?? '').trim()
  if (/^\d{5,12}$/.test(uinText)) args.push(uinText)
  return { file: comspec, args, cwd: dirname(batPath) }
}

/**
 * 停止计划：把「要杀谁」变成一个**可审查**的对象，由调用方执行。
 *
 * 三层校验，任一不满足就返回 `ok:false` 并说明原因，绝不"尽力而为地杀一下"：
 *   1. 必须有 PID（来自 parseListenerPid，不是猜的）
 *   2. 进程名必须是 QQ 系（`qq.exe` / `qqex.exe`）
 *   3. 目标 PID 不能等于控制台自己的进程（自杀保护）
 *
 * @param {object} opts
 * @param {number|null} opts.pid          监听 13000 的 PID
 * @param {string} opts.processName       该 PID 的镜像名
 * @param {number} [opts.selfPid]         控制台自己的 PID
 * @returns {{ ok: boolean, reason: string, plan?: { file: string, args: string[], pid: number } }}
 */
export function stopPlan({ pid = null, processName = '', selfPid = null } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, reason: `没有找到监听 ${WAYLAY_PORT} 的进程——Waylay 可能已经退出，或端口被改过` }
  }
  if (pid === selfPid) {
    return { ok: false, reason: `目标 PID ${pid} 就是控制台自己，拒绝执行` }
  }
  const name = String(processName ?? '').trim()
  if (name === '') {
    return { ok: false, reason: `拿不到 PID ${pid} 的进程名，无法确认是不是 QQ，拒绝按猜测杀进程` }
  }
  if (!QQ_IMAGE_RE.test(name)) {
    return { ok: false, reason: `PID ${pid} 的进程名是「${name}」，不是 QQ 客户端；监听 ${WAYLAY_PORT} 的应该是被注入的 QQ，拒绝执行` }
  }
  return {
    ok: true,
    reason: '',
    plan: { file: 'taskkill.exe', args: ['/PID', String(pid), '/T', '/F'], pid },
  }
}

/**
 * 一句话描述当前状态，供 UI 与 CLI 摘要共用。
 * 刻意区分「端口在听」与「登录成功」——这两个不是一回事（实测过：端口在听但会话已失效）。
 */
export function describeStatus({ listening = false, pid = null, loggedIn = null, uptimeSec = null } = {}) {
  if (!listening) return { level: 'off', text: 'Waylay 未运行（13000 没有监听）' }
  const parts = [`Waylay 运行中（PID ${pid ?? '?'}`]
  if (Number.isFinite(uptimeSec)) parts.push(`，已运行 ${Math.round(uptimeSec / 60)} 分钟`)
  parts.push('）')
  let text = parts.join('')
  if (loggedIn === false) text += ' · 但会话未就绪（端口在听≠能收发）'
  else if (loggedIn === true) text += ' · 已登录'
  return { level: loggedIn === false ? 'warn' : 'ok', text }
}
