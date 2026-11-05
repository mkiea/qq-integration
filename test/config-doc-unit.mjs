/**
 * 配置文档一致性门禁（2026-11-05）。
 *
 * 目的：让「加了配置项但没往 README 补」在 CI 里直接红，而不是等用户读文档配错。
 * 起因：README 配置表分批加，主动通道/群运营/视频/自愈/webhook 那一批只写了 schema
 * 和 CHANGELOG，没回填 README —— 覆盖率一度只有 47%（137/293）。
 *
 * 本套件是 `tools/verify-config-doc.mjs` 的薄包装：跑它、看退出码、把不一致项抄进失败信息。
 * 判定规则（与工具一致）：只比能机械判定的标量；数组/对象/多行值记「跳过」，**不当成一致**。
 *
 * 用法：node test/config-doc-unit.mjs
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

let passed = 0
let failed = 0
const check = (name, ok, extra = '') => {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// ★ 不能用 URL.pathname：路径里的空格会变成 %20，execFileSync 的 cwd 直接 ENOENT
const ROOT = fileURLToPath(new URL('..', import.meta.url))

let output = ''
let exitCode = 0
try {
  output = execFileSync(process.execPath, ['tools/verify-config-doc.mjs'], {
    cwd: ROOT, encoding: 'utf8', timeout: 60_000,
  })
} catch (error) {
  // 非零退出：stdout 里仍然有完整报告，留下当失败信息
  output = String(error.stdout ?? '')
  exitCode = typeof error.status === 'number' ? error.status : 1
}

check('配置文档核对工具能跑通（不是崩了）', output.includes('README 配置表'), exitCode === 0 ? '' : `exit=${exitCode}`)
check('★ README 与 schema 的默认值全部一致', /✅ 默认值全部一致/.test(output),
  (() => {
    const m = /❌ 默认值不一致 (\d+) 处[\s\S]{0,400}/.exec(output)
    return m ? m[0].replace(/\n/g, ' ').slice(0, 160) : ''
  })())

const missing = /schema 有、README 没写（(\d+)）/.exec(output)
check('★ 没有「schema 有、README 没写」的配置项', missing === null,
  missing ? `${missing[1]} 项未文档化 —— 跑 node tools/gen-config-reference.mjs --write 补齐` : '')

// 覆盖率读数（只打印，不判失败：允许先有缺口，但必须显式可见）
const cover = /README 配置表 (\d+) 项 \| index\.js schema (\d+) 项/.exec(output)
if (cover) console.log(`    覆盖率 ${cover[1]}/${cover[2]}`)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
