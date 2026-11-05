/**
 * 向导（control/lib/config-target.mjs）的鲁棒性测试 —— 2026-11-05。
 *
 * 设计原则：
 *   · **不碰真实配置**：全部在 mkdtemp 出来的临时目录里跑
 *   · 每类都先写清判据（期望什么），再看实际
 *   · 覆盖四类：输入校验 / 文件异常 / 并发 / 幂等
 *
 * 用法：node test/setup-robust-unit.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateSetup, readSetup, writeSetup, detectTarget } from '../control/lib/config-target.mjs'

let passed = 0
let failed = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log('PASS', name) }
  else { failed++; failures.push(`${name} — ${detail}`); console.log('FAIL', name, '|', detail) }
}

const tmp = mkdtempSync(join(tmpdir(), 'setup-robust-'))
const patch = join(tmp, 'cordis.patch.yml')
const YAML_HEAD = `- id: dsh-qq-onebot-bridge
  name: dsh-qq-onebot-bridge
  config:
    botQq: 100000001
    allowUsers: [100000002]
    allowGroups: [100000003]
`
function resetYaml(text = YAML_HEAD) { writeFileSync(patch, text, 'utf8') }
const target = { kind: 'dsh-patch', path: patch }

// ============================================================ 一、输入校验
console.log('\n--- 一、输入校验（期望：该拒的必须拒）---')
const badInputs = [
  ['botQq 空', { botQq: '', allowUsers: '100000002' }],
  ['botQq 0', { botQq: '0', allowUsers: '100000002' }],
  ['botQq 负数', { botQq: '-5', allowUsers: '100000002' }],
  ['botQq 非数字', { botQq: 'abc', allowUsers: '100000002' }],
  ['botQq 小数', { botQq: '1.5', allowUsers: '100000002' }],
  ['botQq 注入式', { botQq: '1; rm -rf /', allowUsers: '100000002' }],
  ['allowUsers 空', { botQq: '100000001', allowUsers: '' }],
  ['allowUsers 非数字', { botQq: '100000001', allowUsers: 'abc' }],
  ['allowUsers 负数', { botQq: '100000001', allowUsers: '-1' }],
  ['cwd 相对路径', { botQq: '100000001', allowUsers: '100000002', cwd: '../../etc' }],
]
for (const [label, input] of badInputs) {
  const r = validateSetup(input)
  check(`拒绝 ${label}`, r.ok === false, r.ok ? '竟然通过了' : '')
}

// 该通过的
const goodInputs = [
  ['正常值', { botQq: '100000001', allowUsers: '100000002, 100000003' }],
  ['中文逗号', { botQq: '100000001', allowUsers: '100000002，100000003' }],
  ['空格分隔', { botQq: '100000001', allowUsers: '100000002 100000003' }],
  ['数组形式', { botQq: '100000001', allowUsers: [100000002, 100000003] }],
  ['数字形式 botQq', { botQq: 100000001, allowUsers: [100000002] }],
]
for (const [label, input] of goodInputs) {
  const r = validateSetup(input)
  check(`接受 ${label}`, r.ok === true, r.ok ? '' : r.errors.join(';'))
}

// 去重
{
  const r = validateSetup({ botQq: '100000001', allowUsers: '100000002,100000002,100000002' })
  check('重复号码去重', r.ok && r.values.allowUsers.length === 1, JSON.stringify(r.values.allowUsers))
}

// 数量上限（normalizeNumberList 的 LIST_MAX_ITEMS）
{
  const many = Array.from({ length: 200 }, (_, i) => 200000001 + i).join(',')
  const r = validateSetup({ botQq: '100000001', allowUsers: many })
  check('超量白名单被拒', r.ok === false, r.ok ? `接受了 ${r.values.allowUsers.length} 条` : '')
}

// ============================================================ 二、文件异常
console.log('\n--- 二、文件异常（期望：不崩，且能说清原因）---')

// 2.1 文件不存在
{
  const missing = { kind: 'dsh-patch', path: join(tmp, 'nope.yml') }
  const v = readSetup(missing)
  check('文件不存在时返回空值而非崩溃', v.botQq === '' && Array.isArray(v.allowUsers), JSON.stringify(v))
}

// 2.2 空文件
{
  resetYaml('')
  const v = readSetup(target)
  check('空文件不崩', v.botQq === '', JSON.stringify(v).slice(0, 80))
}

// 2.3 乱码 / 非 YAML
{
  resetYaml('%%% not yaml at all \x00\x01 ###\n\t- broken: [\n')
  const v = readSetup(target)
  check('乱码文件不崩', typeof v.botQq === 'string', JSON.stringify(v).slice(0, 80))
}

// 2.4 块存在但键缺失
{
  resetYaml('- id: dsh-qq-onebot-bridge\n  config:\n    otherKey: 1\n')
  const v = readSetup(target)
  check('键缺失返回空值', v.botQq === '' && v.allowUsers.length === 0, JSON.stringify(v))
}

// 2.5 没有本插件条目
{
  resetYaml('- id: some-other-plugin\n  config:\n    botQq: 1\n')
  const v = readSetup(target)
  check('无本插件条目返回空值', v.botQq === '', JSON.stringify(v))
}

// 2.6 写入到只读文件（Windows 上 chmod 未必生效，用只读属性试）
{
  resetYaml()
  let readOnlyWorked = false
  try { chmodSync(patch, 0o444); readOnlyWorked = true } catch { /* 平台不支持 */ }
  if (readOnlyWorked) {
    const r = writeSetup(target, { botQq: 100000009, allowUsers: [100000002], allowGroups: [], cwd: '' })
    // 两种都可接受：要么明确失败，要么管理员权限下成功（不崩即合格）
    check('只读文件：不崩（成功或明确失败都算）', typeof r.ok === 'boolean', JSON.stringify(r).slice(0, 100))
    try { chmodSync(patch, 0o644) } catch { /* ignore */ }
  } else {
    check('只读文件：平台不支持 chmod，跳过', true)
  }
}

// 2.7 写入后文件仍是合法结构（键还在原位）
{
  resetYaml()
  writeSetup(target, { botQq: 100000001, allowUsers: [100000002, 100000003], allowGroups: [], cwd: '' })
  const text = readFileSync(patch, 'utf8')
  check('写入后 id 行仍存在', text.includes('- id: dsh-qq-onebot-bridge'))
  check('写入后 config 块仍存在', /config:/.test(text))
  const v = readSetup(target)
  check('写入后能读回同一组值', v.botQq === '100000001' && v.allowUsers.length === 2, JSON.stringify(v))
}

// ============================================================ 三、幂等
console.log('\n--- 三、幂等（期望：同值重复写，文件字节不变）---')
{
  resetYaml()
  const vals = { botQq: 100000001, allowUsers: [100000002], allowGroups: [100000003], cwd: '' }
  writeSetup(target, vals)
  const first = readFileSync(patch, 'utf8')
  for (let i = 0; i < 3; i++) writeSetup(target, vals)
  const last = readFileSync(patch, 'utf8')
  check('同值写 4 次后文件不变', first === last, `${first.length} → ${last.length} 字节`)
}

// ============================================================ 四、并发
console.log('\n--- 四、并发（期望：不产生损坏文件）---')
{
  resetYaml()
  const vals = { botQq: 100000001, allowUsers: [100000002], allowGroups: [], cwd: '' }
  // 同步写 20 次（模拟快速连点；Node 单线程，真正的并发在 HTTP 层用队列）
  for (let i = 0; i < 20; i++) writeSetup(target, vals)
  const text = readFileSync(patch, 'utf8')
  const v = readSetup(target)
  check('20 次连续写后仍可读', v.botQq === '100000001', JSON.stringify(v))
  check('20 次连续写后结构未损坏', text.split('\n').filter((l) => /^- id:/.test(l)).length === 1,
    `id 行 ${text.split('\n').filter((l) => /^- id:/.test(l)).length} 个`)
}

// ============================================================ 五、探测
console.log('\n--- 五、落点探测（期望：优先 dsh-patch，无则回落 bare-json）---')
{
  const t1 = detectTarget({ profileDir: tmp, dataDir: tmp })
  resetYaml()
  const t2 = detectTarget({ profileDir: tmp, dataDir: tmp })
  check('有 patch 文件 → 选 dsh-patch', t2.kind === 'dsh-patch', t2.kind)
  const t3 = detectTarget({ profileDir: join(tmp, 'no-such-dir'), dataDir: tmp })
  check('无 patch 文件 → 回落 bare-json', t3.kind === 'bare-json', t3.kind)
  check('探测结果带可读标签', typeof t3.label === 'string' && t3.label.length > 0, t3.label)
}

// ============================================================ 收尾
try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('\n失败明细：')
  for (const f of failures) console.log('  ·', f)
}
process.exit(failed > 0 ? 1 : 0)
