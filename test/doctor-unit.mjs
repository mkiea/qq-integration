/**
 * `tools/doctor.mjs` 的测试 —— 2026-10-31。
 *
 * 体检工具是**量具**，量具说谎比不量更糟。这个项目里已经吃过一次同类亏
 * （`sync-runtime --check` 报"162 个文件一致"，其实是符号链接在跟自己比）。
 * 所以这里不测"输出好不好看"，只钉两件事：
 *
 *   ① 在一台**什么都没装的机器**上，它必须报 FAIL —— 用一个空的 `DSH_HOME`
 *      模拟那个环境。只测"本机能 PASS"是没用的：一个恒返回 PASS 的假实现同样能过。
 *   ② `--json` 的输出必须是合法 JSON（贴 issue / 反馈时要能直接给出去）。
 *
 * 另外：本机跑不了真正的虚拟机安装测试（WSL 被安全策略封禁、Hyper-V 要管理员、
 * 没有第三方虚拟化），所以「干净环境」这件事只能用环境变量降到"干净 profile"这一层。
 * 这个降级**测不到**的：全新 Windows 缺 VC++ 运行时、缺 Node、路径含中文/空格、
 * 非管理员账户、杀软拦截。那部分只能靠别人在真机上跑 `node tools/doctor.mjs` 反馈。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DOCTOR = join(REPO, 'tools', 'doctor.mjs')

function runDoctor(args, envOverrides = {}) {
  const result = spawnSync(process.execPath, [DOCTOR, ...args], {
    cwd: REPO,
    env: { ...process.env, ...envOverrides },
    encoding: 'utf8',
    timeout: 90_000,
  })
  return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

// ---- ① 当前机器：安装区应当没有 FAIL ----
const here = runDoctor(['--install'])
check('当前机器：--install 退出码 0（安装区没有 FAIL）', here.code === 0, `code=${here.code}`)
check('当前机器：有 PASS 行（不是空跑）', here.out.includes('PASS'), here.out.split('\n').filter(Boolean).length + ' 行')
// 新增的干净机前置项必须真的出现在体检里（防止量具被悄悄摘掉后测试还全绿）
check('当前机器：体检报出 DSH CLI / Node engines / VC++ 运行库三项',
  here.out.includes('DSH CLI 可执行') && here.out.includes('Node 与 DSH engines 相容')
  && here.out.includes('VC++ 运行库'),
  here.out.split('\n').filter((l) => l.includes('干净机')).length + ' 项')

// ---- ② 假干净环境：必须报 FAIL ----
const emptyHome = mkdtempSync(join(tmpdir(), 'qqai-doctor-empty-'))
try {
  const clean = runDoctor(['--install'], { DSH_HOME: emptyHome })
  /**
   * 这条是整份测试的重点：如果 doctor 在"什么都没装"的环境里也返回 0，
   * 那它就是个摆设——任何真实故障都会被它报成"健康"。
   */
  check('空 DSH_HOME：退出码非 0（认出"没装"而不是一律 PASS）', clean.code !== 0, `code=${clean.code}`)
  check('空 DSH_HOME：明确指出找不到 profile', clean.out.includes('找到 DSH profile'), clean.out.split('\n').find((l) => l.includes('FAIL')) ?? '(无 FAIL 行)')
  /**
   * 这里刻意**不**要求它给 `dsh plugin` 命令：连 profile 目录都没有的时候，
   * 根因是"DSH 没装 / 没跑过"，此时让人去装插件是把人往错的方向指。
   * 两种状态必须分开验，否则这条测试会逼着工具给出不合场景的建议。
   */
  check('空 DSH_HOME：指出的根因是 DSH 本身没跑过', clean.out.includes('跑起来过一次'), '')

  // ---- ③ 有 profile 但没装插件：这才该给 `dsh plugin` ----
  const bareHome = mkdtempSync(join(tmpdir(), 'qqai-doctor-bare-'))
  try {
    mkdirSync(join(bareHome, 'profiles', 'web'), { recursive: true })
    writeFileSync(join(bareHome, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'profiles-web' }))
    const bare = runDoctor(['--install'], { DSH_HOME: bareHome })
    check('有 profile 但没装插件：退出码非 0', bare.code !== 0, `code=${bare.code}`)
    check('有 profile 但没装插件：给出 dsh plugin 安装命令', bare.out.includes('dsh plugin --profile'),
      bare.out.split('\n').find((l) => l.includes('dsh plugin')) ?? '(无)')
    check('有 profile 但没装插件：说明查了几个 profile', bare.out.includes('查了 1 个 profile'), '')
  } finally {
    rmSync(bareHome, { recursive: true, force: true })
  }

  // ---- ③ JSON 输出可解析 ----
  const json = runDoctor(['--install', '--json'], { DSH_HOME: emptyHome })
  let parsed = null
  try { parsed = JSON.parse(json.out) } catch { parsed = null }
  check('--json 输出是合法 JSON', parsed !== null, json.out.slice(0, 60))
  check('--json 带 counts 与 results', Boolean(parsed?.counts) && Array.isArray(parsed?.results), parsed ? JSON.stringify(parsed.counts) : '')
  check('--json 里 FAIL 计数与实际失败项一致', Boolean(parsed) && (parsed.counts.fail ?? 0) >= 1, `fail=${parsed?.counts?.fail}`)
  check('--json 每一项都带 scope/name/status', Boolean(parsed) && parsed.results.every((r) => r.scope && r.name && r.status))
} finally {
  rmSync(emptyHome, { recursive: true, force: true })
}

// ---- ④ 连通区不会因为端口没人听就崩（结论可以是 FAIL，但不能是崩）----
const net = runDoctor(['--net'])
check('--net 能跑完（不抛栈）', !net.out.includes('测试自身崩了') && (net.code === 0 || net.code === 1), `code=${net.code}`)
check('--net 明确区分桥的端口与宿主的 HTTP 口', net.out.includes('OneBot 反向 WS') && net.out.includes('DSH 宿主 HTTP'),
  net.out.split('\n').filter((l) => l.includes('OneBot') || l.includes('宿主 HTTP')).join(' | '))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
