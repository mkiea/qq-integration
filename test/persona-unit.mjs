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

// ---------- G. 备份名用本地时间，同一秒两次保存不互相覆盖（2026-11-01 夜加） ----------
/**
 * 原来用 `new Date().toISOString()`：那是 **UTC**，比本地时间早 8 小时 ——
 * 备份文件名看着"更旧"，排查时会把先后顺序读反。
 * 更要紧的是同一秒内连续保存会算出同一个名字，第二份把第一份**覆盖**掉，
 * 而人设是手写长文，被盖掉的往往就是要找的那版。
 */
{
  const cwd = mkdtempSync(join(root, 'g-'))
  const sup = makeSup(cwd)
  sup.personaWrite('第一版')
  sup.personaWrite('第二版')
  sup.personaWrite('第三版')     // 与上一行同在这一秒内
  const backups = readdirSync(cwd).filter((n) => n.startsWith('AGENTS.backup-'))
  check('G ★ 同一秒连续保存留下两份备份（不互相覆盖）', backups.length === 2, JSON.stringify(backups))
  const contents = backups.map((n) => readFileSync(join(cwd, n), 'utf8')).sort()
  check('G ★ 两份备份分别是上一版和上上版', contents.includes('第一版') && contents.includes('第二版'), JSON.stringify(contents))
  check('G 正文件仍是最后一版', readFileSync(join(cwd, 'AGENTS.md'), 'utf8') === '第三版')

  // 本地时间：备份名的时分秒应当贴近"现在"的本地钟，而不是 UTC（差 8 小时）。
  const stamp = (backups[0].match(/AGENTS\.backup-(\d{8})-(\d{6})/) ?? [])
  if (stamp.length === 3) {
    const at = new Date(Number(stamp[1].slice(0, 4)), Number(stamp[1].slice(4, 6)) - 1, Number(stamp[1].slice(6, 8)),
      Number(stamp[2].slice(0, 2)), Number(stamp[2].slice(2, 4)), Number(stamp[2].slice(4, 6)))
    const driftMin = Math.abs(Date.now() - at.getTime()) / 60000
    check('G ★ 备份名里的时间是本地时间（不是 UTC）', driftMin < 5, `drift=${driftMin.toFixed(1)}min name=${backups[0]}`)
  } else {
    check('G 备份名形如 AGENTS.backup-YYYYMMDD-HHMMSS.md', false, backups[0])
  }
}

// ---------- H. 列备份 / 读备份正文（新增的两条只读接口） ----------
{
  const cwd = mkdtempSync(join(root, 'h-'))
  const sup = makeSup(cwd)
  sup.personaWrite('一')
  sup.personaWrite('二')
  sup.personaWrite('三')
  // 旧版没有这两个接口：直接崩会把后面的 G/I 也带走，所以先判存在再往下测。
  const hasApi = typeof sup.personaBackups === 'function' && typeof sup.personaBackupText === 'function'
  check('H 有「列备份 / 读备份正文」两个只读接口', hasApi, typeof sup.personaBackups)
  if (!hasApi) {
    check('H 列出两份备份', false, '接口不存在')
    check('H 新写的排在前面（按写入时间，不是字典序）', false, '接口不存在')
    check('H 每行带字节数', false, '接口不存在')
    check('H 读得回备份正文', false, '接口不存在')
    check('H 读正文不会删掉备份', false, '接口不存在')
    check('H 拒绝带路径的备份名（防穿越）', false, '接口不存在')
    check('H 拒绝不存在的备份名', false, '接口不存在')
  } else {
  const rows = sup.personaBackups()
  check('H 列出两份备份', rows.length === 2, JSON.stringify(rows.map((r) => r.name)))
  // 排序按写入时间。同秒撞名时文件名是 …-212645.md / …-212645-2.md，纯字典序会把后写的排前面。
  check('H 新写的排在前面（按写入时间，不是字典序）', rows[0].updatedAt >= rows[1].updatedAt, rows.map((r) => r.name + '@' + r.updatedAt).join(' > '))
  check('H 每行带字节数', rows.every((r) => typeof r.bytes === 'number' && r.bytes > 0), JSON.stringify(rows[0]))
  const text = sup.personaBackupText(rows[0].name)
  check('H 读得回备份正文', text.ok === true && text.text === '二', JSON.stringify(text).slice(0, 80))
  check('H 读正文不会删掉备份', sup.personaBackups().length === 2)
  check('H 拒绝带路径的备份名（防穿越）', sup.personaBackupText('../AGENTS.md').ok === false)
  check('H 拒绝不存在的备份名', sup.personaBackupText('AGENTS.backup-19990101-000000.md').ok === false)
  }
}

// ---------- I. note 说的是宿主的真实预算，不是"要重开会话" ----------
{
  const cwd = mkdtempSync(join(root, 'i-'))
  const sup = makeSup(cwd)
  const ok = sup.personaWrite('短人设')
  check('I 正常大小：note 说下一轮生效', /下一轮/.test(String(ok.note ?? '')), String(ok.note ?? ''))
  check('I 正常大小：note 不再声称"要重开会话"', !/重开/.test(String(ok.note ?? '')), String(ok.note ?? ''))
  // 宿主 agent-instructions 的 maxBytes=32768：超了会被截断，这才是真正要提醒的
  const big = sup.personaWrite('啊'.repeat(18000))    // 54000 字节，未超 60KB 硬上限
  check('I 超过 32 KiB 预算时保存成功但仍带警告', big.ok === true, JSON.stringify(big).slice(0, 80))
  check('I ★ 超预算时 note 明说会被截断', /截断/.test(String(big.note ?? '')), String(big.note ?? ''))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
try { rmSync(root, { recursive: true, force: true }) } catch {}
