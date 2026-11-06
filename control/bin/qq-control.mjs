#!/usr/bin/env node
/**
 * Standalone QQ bot console — its own process, its own port, no DSH dependency.
 *
 *   node control/bin/qq-control.mjs [--port 8799] [--open] [--start-all] [--print-config]
 *
 * `--start-all` 是给根目录「一键启动.bat」用的：监听成功后直接调 `api.startAll()`，
 * 把 Waylay → DSH 宿主 → 可选本地语音的每步结果打到同一个窗口里。
 * 它**不绕过**面板的启动逻辑（单实例锁、端口预检、停止护栏都还在），只是省掉一次点击。
 *
 * The console only ever touches 127.0.0.1 and requires its token, which is
 * printed on startup (and reused from qq-control.json between runs).
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createToken, createControlServer, readUi } from '../lib/server.mjs'
import { loadControlConfig, saveControlConfig, PORT_LABELS, configWarnings } from '../lib/config.mjs'
import { createSupervisor } from '../lib/supervisor.mjs'
import { openPanel } from '../lib/open.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
// 配置文件位置：--config > QQ_CONTROL_CONFIG 环境变量 > 仓库根目录（默认，双击 bat 即可用）。
// 若以后作为 npm 包装到只读的 node_modules 里，可用前两者指向可写位置。
const configFile = resolve(argOf('config', process.env.QQ_CONTROL_CONFIG || join(repoRoot, 'qq-control.json')))
const uiFile = join(here, '..', 'ui.html')

function argOf(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--') ? process.argv[index + 1] : fallback
}
const wantsOpen = process.argv.includes('--open')
const wantsPrint = process.argv.includes('--print-config')
const wantsStartAll = process.argv.includes('--start-all')
const portOverride = Number(argOf('port', '0'))

const { config } = loadControlConfig(configFile)
/**
 * ★ `--port` 只是**本次运行**的临时覆盖，绝不写回配置文件。
 * 2026-10-30 事故：为了测试用 `--port 18881` 起了一次，CLI 把覆盖值存进了
 * qq-control.json；之后桌面启动器照旧打开 8880 ⇒ 页面 ERR_CONNECTION_REFUSED，
 * 排查半天才发现是「一次性参数被持久化」。
 */
const diskControlPort = config.ports.control
if (Number.isInteger(portOverride) && portOverride > 0) config.ports.control = portOverride

// 控制台 token 持久化：同一个文件里保存，避免每次都要从日志里找 URL。
config.token = config.token || createToken()
// 落盘一律用「文件里的端口」，不是这次的覆盖值
const persist = () => saveControlConfig(configFile, { ...config, ports: { ...config.ports, control: diskControlPort } })
persist()

if (wantsPrint) {
  console.log(JSON.stringify(config, null, 2))
  process.exit(0)
}

const api = createSupervisor(config)
const server = createControlServer({
  config,
  token: config.token,
  api,
  ui: readUi(uiFile),
  uiFile,
  saveConfig: (patch) => {
    Object.assign(config, patch)
    if (patch.ports) config.ports = { ...config.ports, ...patch.ports }
    // 同样不把 --port 覆盖写回（面板只保存路径类配置，不会带端口）
    return persist()
  },
})

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`✖ 控制台端口 ${config.ports.control} 已被占用，请先释放或改用 --port <其它端口>`)
    process.exit(2)
  }
  console.error(`✖ 控制台启动失败：${error.message}`)
  process.exit(1)
})

server.listen(config.ports.control, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${config.ports.control}/?token=${config.token}`
  console.log('🐧 QQ 集成接入 · 控制台已启动')
  console.log(`   控制台：${url}`)
  console.log(`   配置文件：${configFile}`)
  console.log(`   受管端口：${Object.entries(config.ports).map(([name, port]) => `${PORT_LABELS[name] ?? name}=${port}`).join('  ')}`)
  console.log(`   宿主命令：${config.nodeExe} ${config.dshBin} web --no-open`)
  const warnings = configWarnings(config)
  if (warnings.length > 0) {
    console.log('   ⚠️ 配置提醒：')
    for (const warning of warnings) console.log(`      · ${warning}`)
  }
  console.log('   按 Ctrl+C 退出（不影响已启动的宿主）')
  if (wantsOpen) {
    const opened = openPanel(url)
    console.log(opened.ok
      ? `   已用${opened.mode === 'app' ? '应用窗口' : '默认浏览器'}打开控制面板`
      : '   未能自动打开窗口，请手动访问上面的地址')
  }
  if (wantsStartAll) {
    console.log('   正在拉起全链路（Waylay → DSH 宿主 → 可选本地语音）…')
    // 不 await：控制台是前台进程，这里 await 会把窗口卡住，用户看不到逐步结果。
    // 单项失败不中断其它步骤（startAll 自己保证），所以只如实打印，不改写结论。
    void Promise.resolve()
      .then(() => api.startAll())
      .then((result) => {
        for (const step of result?.steps ?? []) {
          const tag = step.ok ? '[OK]  ' : '[X]   '
          console.log(`   ${tag}${step.name}${step.skipped ? '（跳过）' : ''}：${step.reason}`)
        }
        console.log(result?.ok
          ? '   全链路启动请求已完成；端口与登录态以控制台「概览」为准（端口在听 ≠ 已登录）。'
          : '   ⚠️ 有步骤没起来，上面列了原因；控制台已打开，修好后可再点「一键启动」。')
      })
      .catch((error) => console.log(`   ⚠️ 一键启动异常：${error?.message ?? error}`))
  }
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n控制台已退出（宿主进程保持运行）')
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 500)
  })
}
