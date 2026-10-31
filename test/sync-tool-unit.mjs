/**
 * `tools/sync-runtime.mjs` 的单元测试 —— 2026-10-31。
 *
 * 这个脚本是**量具**：它的结论是"两份副本一致 / 不一致"。量具说谎比不量更糟——
 * 尤其是 2026-10-31 把 profile 的依赖换成 `link:` 之后，"运行时副本"只是一个
 * 指向仓库的符号链接，拿自己跟自己比会得到"162 个文件全部一致"。看着像核过了，
 * 实际一份都没核。所以这里钉住四件事：
 *
 *   1. 白名单与排除：只同步源码，不搬 `node_modules` / `_tmp` / 数据文件；
 *   2. 比对口径：CRLF / BOM 不算差异（否则每次都是"全都要拷"，等于永远在喊狼来了）；
 *   3. **只拷不删**：目标里的机器本地文件不能因为"源里没有"就消失；
 *   4. **同一目录必须自报 `alias`**：不比对、不拷贝，也不许输出一致性的数字。
 *
 * 全部在临时目录里跑，不碰真实 profile。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectFiles, isSameDir, normalizeForCompare, runtimeRoot, sameContent, syncRuntime } from '../tools/sync-runtime.mjs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const temps = []
function tempDir(prefix = 'qqai-sync-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}
function write(file, text) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text, 'utf8')
}

// ------------------------------------------------ 1. 白名单 / 排除

const src = tempDir()
write(join(src, 'lib', 'a.js'), 'export const a = 1\n')
write(join(src, 'control', 'ui.html'), '<html></html>\n')
write(join(src, 'README.md'), '# hi\n')
// 以下都不该被同步
write(join(src, 'node_modules', 'ws', 'index.js'), 'module.exports = {}\n')
write(join(src, '_tmp', 'backups', 'bridge.js.bak'), 'old\n')
write(join(src, 'qq-trace.jsonl'), '{"x":1}\n')
write(join(src, 'tools', 'sync-runtime.mjs'), '// tool\n')
write(join(src, 'qq-control.json'), '{"waylayUin":"10001"}\n')

const collected = collectFiles(src)
check('只收白名单里的源码（lib/control/README）',
  collected.includes('lib/a.js') && collected.includes('control/ui.html') && collected.includes('README.md'),
  collected.join(','))
check('不收 node_modules / _tmp / 运行产物 / 本机配置',
  !collected.some((rel) => /^(node_modules|_tmp|tools)\//.test(rel) || /^qq-/.test(rel)),
  collected.filter((rel) => /^(node_modules|_tmp|tools)\//.test(rel) || /^qq-/.test(rel)).join(',') || '(干净)')

// ------------------------------------------------ 2. 比对口径

check('normalizeForCompare 抹掉 CRLF 与 BOM',
  normalizeForCompare('\uFEFFa\r\nb\r\n') === 'a\nb\n',
  JSON.stringify(normalizeForCompare('\uFEFFa\r\nb\r\n')))

const lfFile = join(tempDir(), 'lf.txt')
const crlfFile = join(tempDir(), 'crlf.txt')
write(lfFile, 'a\nb\n')
write(crlfFile, 'a\r\nb\r\n')
check('同样的内容、不同换行 ⇒ 算一致（否则每轮都在报假差异）', sameContent(lfFile, crlfFile) === true)
write(crlfFile, 'a\r\nc\r\n')
check('内容真的不同 ⇒ 算不一致（别把"忽略换行"做成"忽略内容"）', sameContent(lfFile, crlfFile) === false)
check('目标不存在 ⇒ 算不一致（不是"没有差异"）', sameContent(lfFile, join(tempDir(), 'nope.txt')) === false)

// ------------------------------------------------ 3. 只拷不删

const from = tempDir()
const to = tempDir()
write(join(from, 'lib', 'new.js'), 'v2\n')
write(join(to, 'lib', 'keep.js'), 'machine-local\n')     // 目标独有
write(join(to, 'qq-control.json'), '{"waylayUin":"10001"}\n') // 目标独有（本机配置）

const result = syncRuntime({ from, to })
check('差异文件被拷过去，内容逐字一致',
  readFileSync(join(to, 'lib', 'new.js'), 'utf8') === 'v2\n', result.copied.join(','))
check('目标独有的文件**一个都没被删**（只拷不删）',
  existsSync(join(to, 'lib', 'keep.js')) && existsSync(join(to, 'qq-control.json')),
  '')
check('幂等：再跑一次没有要拷的', syncRuntime({ from, to }).copied.length === 0)

// ------------------------------------------------ 4. 同一目录必须自报 alias

const aliasRoot = tempDir()
write(join(aliasRoot, 'lib', 'x.js'), 'x\n')
const aliasLink = join(tempDir(), 'linked')
symlinkSync(aliasRoot, aliasLink, 'junction')
check('isSameDir 认得符号链接/目录联接', isSameDir(aliasRoot, aliasLink) === true, aliasLink)
check('两个不同目录 ⇒ 不是同一份', isSameDir(aliasRoot, tempDir()) === false)

const aliasResult = syncRuntime({ from: aliasRoot, to: aliasLink })
check('同一目录 ⇒ alias=true 且**一个文件都不比**（拿自己比自己不算核过）',
  aliasResult.alias === true && aliasResult.copied.length === 0 && aliasResult.identical.length === 0,
  JSON.stringify({ alias: aliasResult.alias, identical: aliasResult.identical.length }))

// ------------------------------------------------ 5. 目标缺失 / 环境变量

const lacking = syncRuntime({ from: aliasRoot, to: join(tempDir(), 'not-installed') })
check('运行时还没装 ⇒ 报 missing，而不是静默成功',
  lacking.missing.length === 1 && lacking.copied.length === 0, lacking.missing[0] ?? '(空)')

const before = process.env.QQAI_RUNTIME_ROOT
process.env.QQAI_RUNTIME_ROOT = 'D:/elsewhere/plugin'
const overridden = runtimeRoot()
if (before === undefined) delete process.env.QQAI_RUNTIME_ROOT
else process.env.QQAI_RUNTIME_ROOT = before
check('QQAI_RUNTIME_ROOT 可以覆盖运行时位置（换机器不必改代码）',
  overridden.replace(/\\/g, '/').endsWith('D:/elsewhere/plugin'), overridden)

// ------------------------------------------------ 清理
for (const dir of temps) {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录清不掉不影响结论 */ }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
