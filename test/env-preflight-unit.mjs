/**
 * `lib/env-preflight.js` 的单测：**量具必须两个方向都有分辨力**。
 *
 * 只测「健康机 PASS」没用——一个恒返回 ok 的假实现同样能过。所以这里钉死：
 *  ① 模拟 2026-11-06 那台干净 VM（Node 22 + dsh 0.2.2 + 无 pnpm + 无 VC++ + 无 QQ
 *     + 无 Waylay 运行时）必须报出**具体哪几项** FAIL，而不是笼统一句「环境不对」；
 *  ② 模拟修好之后的同一台机器必须全绿；
 *  ③ 纯函数（版本比较 / engines 解析 / QQ 路径）单独验边界；
 *  ④ 真机上必须能跑出 6 项结构化结果，不许抛栈。
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  probeEnvironment, parseMinNode, versionAtLeast, qqExeCandidates, VC_RUNTIME_DLLS,
} from '../lib/env-preflight.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const norm = (p) => String(p ?? '').replace(/\\/g, '/').toLowerCase()
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 造一台可切换状态的假机器：所有 I/O 都走注入，不碰真实进程/磁盘。 */
function fakeMachine({ healthy = false } = {}) {
  const env = {
    USERPROFILE: 'C:/Users/tester',
    SystemRoot: 'C:/Windows',
    ProgramFiles: 'C:/Program Files',
    'ProgramFiles(x86)': 'C:/Program Files (x86)',
    DSH_HOME: 'C:/Users/tester/.dsh',
  }
  const present = new Set()
  if (healthy) {
    for (const key of [
      'C:/Users/tester/.dsh/profiles/web/cordis.patch.yml',
      'C:/Program Files/Tencent/QQNT/QQ.exe',
      'C:/real-install/rin-inject',
      'C:/real-install/rin-inject/rin-waylay.bat',
    ]) present.add(norm(key))
    for (const dll of VC_RUNTIME_DLLS) present.add(norm(`C:/Windows/System32/${dll}`))
  }
  const run = (command, args) => {
    const key = `${command} ${(args ?? []).join(' ')}`
    if (command === 'dsh') {
      return healthy
        ? { ok: true, status: 0, out: '0.2.2-rc.1', err: '', error: '' }
        // ★ VM 实测最阴的一种：`RC=0`、零输出、profile 根本没建
        : { ok: true, status: 0, out: '', err: '', error: '' }
    }
    if (command === 'npm') return { ok: true, status: 0, out: 'C:/npm-global', err: '', error: '' }
    if (command === 'pnpm') {
      return healthy
        ? { ok: true, status: 0, out: '11.8.0', err: '', error: '' }
        : { ok: false, status: null, out: '', err: "'pnpm' 不是内部或外部命令", error: 'ENOENT' }
    }
    throw new Error(`意外的命令 ${key}`)
  }
  return {
    env,
    platform: 'win32',
    nodeVersion: healthy ? '24.22.2' : '22.14.0',
    repo: 'C:/real-install/qq-integration',
    cwd: 'C:/real-install/qq_chat',
    exists: (p) => present.has(norm(p)),
    readFile: () => JSON.stringify({ version: '0.2.2-rc.1', engines: { node: '>=24.9.0' } }),
    run,
  }
}

// ---------------------------------------------------------------- ① 干净机必须 FAIL
const dirty = probeEnvironment(fakeMachine({ healthy: false }))
const dirtyIds = dirty.results.filter((r) => r.status === 'fail').map((r) => r.id)
check('干净机：整体判定为不通过', dirty.ok === false, JSON.stringify(dirtyIds))
for (const id of ['dsh-cli', 'dsh-engines', 'pnpm', 'vcruntime']) {
  check(`干净机：${id} 被判为 FAIL`, dirtyIds.includes(id), JSON.stringify(dirtyIds))
}
check('干净机：RC=0 零输出被当成失败，而不是「成功」',
  dirty.results.find((r) => r.id === 'dsh-cli')?.detail.includes('零输出') === true,
  dirty.results.find((r) => r.id === 'dsh-cli')?.detail)
check('干净机：每项 FAIL 都带可执行的修法',
  dirty.results.filter((r) => r.status === 'fail').every((r) => String(r.fix).length > 10))
check('干净机：QQ / Waylay 缺失是 WARN 不是 FAIL（接别的 OneBot 实现也合法）',
  dirty.results.find((r) => r.id === 'qq')?.status === 'warn'
  && dirty.results.find((r) => r.id === 'waylay-runtime')?.status === 'warn')

// ---------------------------------------------------------------- ② 修好之后必须 PASS
const healthy = probeEnvironment(fakeMachine({ healthy: true }))
check('修好的同一台机器：整体通过', healthy.ok === true,
  JSON.stringify(healthy.results.filter((r) => r.status === 'fail').map((r) => r.id)))
check('修好的机器：Waylay 运行时从「插件兄弟目录」被找到',
  healthy.results.find((r) => r.id === 'waylay-runtime')?.detail.includes('rin-waylay.bat') === true,
  healthy.results.find((r) => r.id === 'waylay-runtime')?.detail)
check('修好的机器：pnpm 报出真实版本号',
  healthy.results.find((r) => r.id === 'pnpm')?.detail.includes('11.8.0') === true)
check('两台机器结果项数一致（不因状态不同而少报几项）',
  dirty.results.length === healthy.results.length && healthy.results.length === 6,
  `${dirty.results.length} / ${healthy.results.length}`)
check('每项都有 id / name / status / detail',
  healthy.results.every((r) => r.id && r.name && r.status && typeof r.detail === 'string'))

// ---------------------------------------------------------------- ③ 纯函数边界
check('parseMinNode: >=24.9.0', parseMinNode('>=24.9.0') === '24.9.0')
check('parseMinNode: 裸版本号', parseMinNode('24.9.0') === '24.9.0')
check('parseMinNode: 复杂区间宁可返回 null（不假装判过）', parseMinNode('>=20 || >=22') === null)
check('parseMinNode: 空值', parseMinNode('') === null && parseMinNode(undefined) === null)
check('versionAtLeast: 22 < 24.9', versionAtLeast('22.14.0', '24.9.0') === false)
check('versionAtLeast: 24.22 > 24.9（按段比，不是按字符串比）', versionAtLeast('24.22.2', '24.9.0') === true)
check('versionAtLeast: 相等算通过', versionAtLeast('24.9.0', '24.9.0') === true)
check('qqExeCandidates: 用 env 拼路径，不带作者用户名',
  qqExeCandidates({ env: { ProgramFiles: 'D:/PF' } }).every((p) => !p.includes('SolimPurmiss')))
check('qqExeCandidates: QQ_EXE_PATH 可覆盖且排在最前',
  qqExeCandidates({ env: { ProgramFiles: 'D:/PF', QQ_EXE_PATH: 'E:/my/QQ.exe' } })[0] === 'E:/my/QQ.exe')

// ---------------------------------------------------------------- ④ 真机能跑完（不抛栈）
const real = probeEnvironment({ repo: REPO, cwd: REPO })
check('真机：产出 6 项结构化结果', real.results.length === 6, `${real.results.length} 项`)
check('真机：blockers 与 fail 项一致',
  real.blockers.length === real.results.filter((r) => r.status === 'fail').length,
  `blockers=${real.blockers.map((b) => b.id).join(',')}`)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
