/**
 * 控制台的「人设」面板：读写 cwd/AGENTS.md（2026-11-01，用户报「人设设置没了啊」）。
 *
 * 这个功能天生带危险：它往磁盘上写东西。所以判据不能只测"能存能读"，
 * 必须同时钉住**它写不到别处**、**写坏了能退**：
 *
 *   A 没有文件时读到 exists:false（不能报错，那会让面板看起来是坏的）
 *   B 存了能原样读回（包括中文、换行、行尾空格）
 *   C 第二次保存会留下备份，且备份内容是**上一版**
 *   D 超过上限时**拒绝，并且原文件一个字都没动** —— 这条最重要：
 *     "先截断再校验"是这类功能的经典写法，一旦那样，超限保存就等于把人设清空了
 *   E 路径钉死在 cwd/AGENTS.md：调用方没有传路径的地方，文本里写 `../` 也不会跑到别处
 */
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSupervisor } from '../control/lib/supervisor.mjs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const root = mkdtempSync(join(tmpdir(), 'qq-persona-'))
const makeSup = (cwd) => createSupervisor({ cwd, logs: {}, ports: { control: 0, host: 0 } })

// ---------- A. 文件不存在时不是错误 ----------
{
  const cwd = mkdtempSync(join(root, 'a-'))
  const sup = makeSup(cwd)
  const r = sup.personaRead()
  check('A 读不存在的文件返回 ok:true（不报错）', r.ok === true, JSON.stringify(r).slice(0, 100))
  check('A 明确告诉调用方"还不存在"', r.exists === false)
  check('A 路径指向 cwd 下的 AGENTS.md', String(r.file).endsWith('AGENTS.md'), r.file)
  check('A 文本是空串而不是 undefined', r.text === '')
}

// ---------- B. 原样存、原样读 ----------
{
  const cwd = mkdtempSync(join(root, 'b-'))
  const sup = makeSup(cwd)
  const body = '# 人设\n\n她说话短，带点傲娇。\n   \n结尾有个空格 '
  const w = sup.personaWrite(body)
  check('B 保存成功', w.ok === true, JSON.stringify(w).slice(0, 120))
  check('B 文件真的落到 cwd/AGENTS.md', existsSync(join(cwd, 'AGENTS.md')))
  const r = sup.personaRead()
  check('B 读回来和写进去逐字相同（含中文/空行/行尾空格）', r.text === body, JSON.stringify(r.text.slice(0, 50)))
  check('B 字节数对得上', r.bytes === Buffer.byteLength(body, 'utf8'), `${r.bytes}`)
  check('B 行数对得上', r.lines === body.split('\n').length, `${r.lines}`)
}

// ---------- C. 第二次保存留备份，且备份是上一版 ----------
{
  const cwd = mkdtempSync(join(root, 'c-'))
  const sup = makeSup(cwd)
  sup.personaWrite('第一版')
  const w2 = sup.personaWrite('第二版')
  check('C 第二次保存带回了备份路径', typeof w2.backup === 'string' && w2.backup !== '', String(w2.backup))
  const backups = readdirSync(cwd).filter((name) => name.startsWith('AGENTS.backup-'))
  check('C 目录里确实有备份文件', backups.length === 1, JSON.stringify(backups))
  if (backups.length > 0) {
    check('C 备份里是**上一版**内容', readFileSync(join(cwd, backups[0]), 'utf8') === '第一版')
  }
  check('C 正文件是这一版', readFileSync(join(cwd, 'AGENTS.md'), 'utf8') === '第二版')
}

// ---------- D. 超限拒绝，且不动原文件（最重要） ----------
{
  const cwd = mkdtempSync(join(root, 'd-'))
  const sup = makeSup(cwd)
  sup.personaWrite('原本的人设')
  const huge = 'x'.repeat(61 * 1024)
  const r = sup.personaWrite(huge)
  check('D 超限时被拒绝', r.ok === false, JSON.stringify(r).slice(0, 120))
  check('D 拒绝理由说清了是"太大"', /KB|大/.test(String(r.reason ?? '')), String(r.reason ?? ''))
  check('D ★ 原文件一个字都没动', readFileSync(join(cwd, 'AGENTS.md'), 'utf8') === '原本的人设')
  check('D ★ 也没有留下半截备份', readdirSync(cwd).filter((n) => n.startsWith('AGENTS.backup-')).length === 0)
}

// ---------- E. 路径钉死 ----------
{
  const cwd = mkdtempSync(join(root, 'e-'))
  const outside = join(cwd, '..', 'outside-target.md')
  const sup = makeSup(cwd)
  // 文本里带着路径穿越的写法 —— 它只是**内容**，不该被当成目标路径
  sup.personaWrite('../../outside-target.md')
  check('E 只写了 cwd 下的 AGENTS.md', existsSync(join(cwd, 'AGENTS.md')))
  check('E 没有写到 cwd 之外', !existsSync(outside))
  const r = sup.personaRead()
  check('E 读的也是同一个文件（内容就是那段字面量）', r.text === '../../outside-target.md')
}

// ---------- F. 没配 cwd 时给得出的理由，而不是崩 ----------
{
  const sup = createSupervisor({ logs: {}, ports: { control: 0, host: 0 } })
  const r = sup.personaRead()
  check('F 没有 cwd 时如实说不知道文件在哪', r.ok === false && /数据目录|cwd/.test(String(r.reason ?? '')), String(r.reason ?? ''))
  const w = sup.personaWrite('随便')
  check('F 写也一样被挡住', w.ok === false)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
try { rmSync(root, { recursive: true, force: true }) } catch {}
