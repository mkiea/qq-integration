/**
 * 干净机前置体检：**量具**，不是一个"看起来很像安装器"的打印脚本。
 *
 * 2026-11-06 在 Win11 虚拟机做「从零下载 DSH + QQ + Waylay」时，一共撞上六个
 * 文档里没写、CLI 也不报错的坑：
 *   ① Node 22 + dsh 0.2.2-rc.1 ⇒ `dsh --version` / `plugin add` 全部 **RC=0 但零输出**；
 *      真因是该版 package.json 写了 `engines.node >=24.9.0`，CLI 在旧解释器里静默退出。
 *   ② `dsh plugin --profile web add` 硬依赖系统 `pnpm`，干净机没有 → exit 1。
 *   ③ Waylay 注入器缺 VC++ 运行库（MSVCP140/VCRUNTIME140）→ 弹窗后进程消失，
 *      13000 永远不监听；官方 vc_redist 静默安装还可能卡在 UAC。
 *   ④ QQ 客户端没装 / 版本与注入 profile 不符。
 *   ⑤ 发行包里没有 Waylay 运行时（rin-inject），控制台只认开发机 `_tmp` 布局。
 *   ⑥ 宿主那份 18.5KB 的 cordis.patch.yml 带本机绝对路径与凭据，不能随包发布。
 *
 * ①②③④⑤ 都能在**动手装之前**查出来，所以做成可注入 I/O 的纯逻辑：
 * 同样的函数既给 `launcher/preflight.mjs`（双击时跑）、也给 `tools/doctor.mjs`
 * （一键体检），避免两处各写一份、慢慢漂移成两个结论。
 *
 * 硬要求（与本项目其它量具一致）：
 *   · **不许把「探测不到」说成「没装」**：失败原样带出 stderr / exit code，并给可复制的修法；
 *   · **两个方向都要验**：健康机必须 PASS、干净机必须 FAIL，只测一边等于恒返回绿；
 *   · 只读：不安装、不写文件、不启动任何进程（除了为探测版本而执行的 `--version`）。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { detectWaylayBat, waylayRuntimeCandidates } from './waylay-launch.js'

/** 注入器需要的 VC++ 2015-2022 运行库（缺任何一个都可能弹窗后静默退出）。 */
export const VC_RUNTIME_DLLS = [
  'MSVCP140.dll', 'VCRUNTIME140.dll', 'VCRUNTIME140_1.dll',
]

/** QQNT 默认安装位置候选（不写死盘符；用环境变量拼）。 */
export function qqExeCandidates({ env = process.env } = {}) {
  const dirs = [
    env['ProgramFiles'], env['ProgramFiles(x86)'],
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs') : '',
  ].filter(Boolean)
  const out = []
  for (const dir of dirs) {
    out.push(join(String(dir), 'Tencent', 'QQNT', 'QQ.exe'))
  }
  const custom = String(env.QQ_EXE_PATH ?? '').trim()
  if (custom !== '') out.unshift(custom)
  return [...new Set(out)]
}

/**
 * 从 `engines.node` 里取最低版本。只认 `>=x.y.z` / `^x.y.z` / 裸 `x.y.z`，
 * 复杂的 `||` 区间返回 null（宁可说「没读懂」，也不假装判过了）。
 */
export function parseMinNode(engine) {
  const text = String(engine ?? '').trim()
  if (text === '') return null
  if (text.includes('||') || text.includes(' - ')) return null
  const hit = /(?:>=|\^|~)?(\d+)\.(\d+)\.(\d+)/.exec(text)
  return hit ? `${hit[1]}.${hit[2]}.${hit[3]}` : null
}

/** 三段式版本比较，允许带 v / -rc 后缀。 */
export function versionAtLeast(current, min) {
  const parts = (text) => String(text ?? '').replace(/^v/, '').split(/[.-]/).slice(0, 3).map(Number)
  const a = parts(current)
  const b = parts(min)
  if (a.length < 3 || b.length < 3 || a.some(Number.isNaN) || b.some(Number.isNaN)) return true
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return true
    if (a[i] < b[i]) return false
  }
  return true
}

function defaultRun(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 15_000,
    shell: process.platform === 'win32',
    windowsHide: true,
  })
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    out: String(result.stdout ?? '').trim(),
    err: String(result.stderr ?? '').trim(),
    error: result.error ? String(result.error.message ?? result.error) : '',
  }
}

/**
 * 跑一遍前置条件。
 *
 * @param {object} opts 全部可注入，便于用假环境做「干净机必须 FAIL」的单测。
 * @returns {{ results: Array, blockers: Array, ok: boolean }}
 *   results 每项：{ id, name, status: 'ok'|'warn'|'fail'|'skip', detail, fix }
 */
export function probeEnvironment({
  env = process.env,
  platform = process.platform,
  nodeVersion = process.versions.node,
  repo = '',
  cwd = '',
  profile = 'web',
  /**
   * 控制台找到的宿主入口（`@deepseek-ai/dsh/lib/bin.js`）。
   * `null` = 不检查（保持 6 项，单测里那些假环境不需要它）；
   * 传字符串 = 多查一项「控制台能不能真的把宿主拉起来」。
   * 由调用方用 `control/lib/config.mjs` 的 `detectPaths()` 算出来 —— 这里有意的
   * 不做第二套探测逻辑：两套早晚漂移成「体检说能起、控制台说起不来」。
   */
  dshBinPath = null,
  exists = existsSync,
  readFile = readFileSync,
  run = defaultRun,
} = {}) {
  const results = []
  const push = (item) => results.push(item)
  const home = env.USERPROFILE || env.HOME || ''
  const dshHome = String(env.DSH_HOME ?? '').trim() || (home ? join(home, '.dsh') : '')
  const patchFile = dshHome ? join(dshHome, 'profiles', profile, 'cordis.patch.yml') : ''

  // ---- 1. DSH CLI 到底能不能跑（VM 里最会骗人的一项：RC=0 但一行都不输出）
  const dsh = run('dsh', ['--version'])
  const dshOut = String(dsh.out ?? '').trim()
  if (!dsh.ok || dshOut === '') {
    const why = dsh.error || (dsh.status !== 0 ? `exit=${dsh.status}` : '零输出') || '零输出'
    push({
      id: 'dsh-cli', name: 'DSH CLI 可执行', status: 'fail',
      detail: `dsh --version 没给出版本号（${why}）${dsh.err ? ` · ${dsh.err.slice(0, 120)}` : ''}`,
      fix: '⚠️ Node 22 + dsh 0.2.2-rc.1 的实测症状就是「exit 0、零输出、profile 没建」。'
        + '先看下面那项 engines；装 Node >= 24.9.0 后重新 npm i -g @deepseek-ai/dsh，别把 RC=0 当成功。',
    })
  } else {
    push({ id: 'dsh-cli', name: 'DSH CLI 可执行', status: 'ok', detail: dshOut.split(/\r?\n/)[0].slice(0, 60), fix: '' })
  }

  // ---- 2. 当前 Node 与**已装那版 DSH 的 engines** 是否相容（不写死全局门槛）
  let enginesRaw = ''
  let dshVersion = ''
  try {
    const root = String(run('npm', ['root', '-g']).out ?? '').trim().split(/\r?\n/).pop()
    if (root !== '') {
      const pkgText = String(readFile(join(root, '@deepseek-ai', 'dsh', 'package.json'), 'utf8') ?? '')
      const pkg = JSON.parse(pkgText)
      enginesRaw = String(pkg.engines?.node ?? '')
      dshVersion = String(pkg.version ?? '')
    }
  } catch { /* 读不到就照实说读不到，不猜 */ }
  const minNode = parseMinNode(enginesRaw)
  if (minNode === null) {
    push({
      id: 'dsh-engines', name: 'Node 与 DSH engines 相容', status: 'ok',
      detail: enginesRaw === ''
        ? `dsh ${dshVersion || '?'} 未声明 engines.node（该版本不做下限约束）；当前 Node v${nodeVersion}`
        : `engines.node = ${enginesRaw}（区间写法，跳过自动判定）；当前 Node v${nodeVersion}`,
      fix: '',
    })
  } else {
    const compatible = versionAtLeast(nodeVersion, minNode)
    push({
      id: 'dsh-engines', name: 'Node 与 DSH engines 相容',
      status: compatible ? 'ok' : 'fail',
      detail: `dsh ${dshVersion || '?'} 要求 >= ${minNode}，当前 Node v${nodeVersion}`,
      fix: compatible ? '' : '装官方 Node 24 LTS（https://nodejs.org/），重开终端后重装 dsh。'
        + '这一项不修，后面所有 dsh 子命令都会「成功」地什么都不做。',
    })
  }

  // ---- 3. pnpm：只有「插件还没注册」时才是硬依赖
  const registered = patchFile !== '' && exists(patchFile)
  const pnpm = run('pnpm', ['--version'])
  const pnpmOut = String(pnpm.out ?? '').trim()
  if (pnpm.ok && pnpmOut !== '') {
    push({ id: 'pnpm', name: 'pnpm 可用', status: 'ok', detail: pnpmOut.split(/\r?\n/)[0].slice(0, 40), fix: '' })
  } else {
    push({
      id: 'pnpm', name: 'pnpm 可用', status: registered ? 'warn' : 'fail',
      detail: registered
        ? `插件已注册（${patchFile} 存在），pnpm 缺失只影响以后重新注册`
        : `插件尚未注册，而 dsh plugin add 硬依赖 pnpm（${pnpm.error || pnpm.err.slice(0, 80) || '无输出'}）`,
      fix: registered ? '' : 'npm i -g pnpm（干净机实测 corepack enable pnpm 首次联网拉包容易卡住，'
        + '更稳的是直接 npm i -g pnpm 或随发行包带一份便携 pnpm）。装完重新执行 dsh plugin --profile web add <插件目录>。',
    })
  }

  // ---- 4. VC++ 运行库（Waylay 注入器的硬依赖；非 Windows 跳过）
  if (platform !== 'win32') {
    push({ id: 'vcruntime', name: 'VC++ 运行库', status: 'skip', detail: '非 Windows，跳过', fix: '' })
  } else {
    // 不写死系统目录兜底：那是本机真实路径（隐私套件会拦），而且
    // 拿不到 SystemRoot 时猜一个盘符只会把「没探测到」说成「装好了」。
    const systemRoot = String(env.SystemRoot || env.windir || '').trim()
    if (systemRoot === '') {
      push({ id: 'vcruntime', name: 'VC++ 运行库', status: 'skip', detail: '拿不到 SystemRoot，跳过', fix: '' })
    } else {
      const sys32 = join(systemRoot, 'System32')
      const missing = VC_RUNTIME_DLLS.filter((dll) => !exists(join(sys32, dll)))
      if (missing.length === 0) {
        push({ id: 'vcruntime', name: 'VC++ 运行库', status: 'ok', detail: `${VC_RUNTIME_DLLS.length} 个 DLL 齐`, fix: '' })
      } else {
        push({
          id: 'vcruntime', name: 'VC++ 运行库', status: 'fail',
          detail: `缺 ${missing.join(' / ')}（查 ${sys32}）`,
          fix: '装官方 VC++ 2015-2022 Redistributable x64：'
            + 'https://aka.ms/vs/17/release/vc_redist.x64.exe 。'
            + 'VM 实测：缺它时注入器弹 DLL 错误框后消失，13000 永远不监听；'
            + '别用「把宿主 System32 的 DLL 侧加载过去」当正式修法（那只是测试绕路）。',
        })
      }
    }
  }

  // ---- 5. QQ 客户端
  const qqPaths = qqExeCandidates({ env })
  const qqFound = qqPaths.find((p) => exists(p)) ?? ''
  push({
    id: 'qq', name: 'QQNT 客户端', status: qqFound ? 'ok' : 'warn',
    detail: qqFound || `没在 ${qqPaths.length} 个常见位置找到 QQ.exe`,
    fix: qqFound ? '' : '从 https://im.qq.com/pcqq 安装 Windows 版 QQNT；'
      + 'Waylay 对 QQNT 版本敏感，换大版本后要重验注入 profile。'
      + '装在非默认位置时设 QQ_EXE_PATH 指到 QQ.exe。',
  })

  // ---- 6. Waylay 运行时（发行版布局由 waylay-launch.js 统一推）
  // 空路径不要 resolve：resolve('') 会悄悄变成 process.cwd()，凭空多出一批候选，
  // 让「找不到」在恰好跑对目录时假变「找到了」。
  const waylay = detectWaylayBat({
    configured: '',
    env,
    exists,
    extra: waylayRuntimeCandidates({ repo: repo ? resolve(repo) : '', cwd: cwd ? resolve(cwd) : '' }),
  })
  push({
    id: 'waylay-runtime', name: 'Waylay 运行时', status: waylay ? 'ok' : 'warn',
    detail: waylay || '没找到 rin-waylay.bat',
    fix: waylay ? '' : '把发行包里的 rin-inject\\ 目录放在插件目录旁边（或插件目录内），'
      + '或在 qq-control.json 里填 waylayBat。'
      + '插件仓库本身不打包第三方二进制（见 NOTICE.md），运行时是单独的发行件（Apache-2.0）。',
  })

  // ---- 7. 控制台能不能真的把宿主拉起来（可选：只有调用方算出了 dshBinPath 才查）
  if (dshBinPath !== null) {
    const bin = String(dshBinPath ?? '').trim()
    const found = bin !== '' && exists(bin)
    push({
      id: 'dsh-bin', name: '控制台能启动宿主（bin.js）', status: found ? 'ok' : 'fail',
      detail: found ? bin : (bin === '' ? '没找到 @deepseek-ai/dsh/lib/bin.js' : `文件不存在：${bin}`),
      fix: found ? '' : '控制台「启动宿主」需要这个路径。用便携 Node 装的话正常在 '
        + '<node 目录>\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js；'
        + '装在别处就在 qq-control.json 里填 dshBin。这一项不修，Waylay 起来了也没有宿主接消息。',
    })
  }

  const blockers = results.filter((item) => item.status === 'fail')
  return { results, blockers, ok: blockers.length === 0 }
}
