/**
 * 记忆归档溢出（memory overflow）单元测试 —— 2026-11-06。
 *
 * 判据（跑之前写死）：
 *   O1 空数组 ⇒ 不建文件、不报错（不能因为"没东西"就留下空文件）
 *   O2 第一次写 3 行 ⇒ 文件里正好 3 行，内容与输入一致、顺序不变
 *   O3 第二次再写 2 行 ⇒ **追加**到 5 行（不是覆盖）
 *   O4 chatKey 里的路径字符被安全化（`u:123/abc` ⇒ `u_123_abc`），不逃出目录
 *   O5 返回的 file 是相对路径（不把绝对路径写进事件流）
 *   O6 dir 为空 ⇒ ok:false（而不是静默成功）
 *
 * 用法：`node test/memory-overflow-unit.mjs`
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { overflowName, spillArchive } from '../lib/memory-overflow.js'

let passed = 0
let failed = 0
const check = (name, ok, extra = '') => {
  if (ok) { passed++; console.log('PASS', name, extra) } else { failed++; console.log('FAIL', name, extra) }
}

const root = mkdtempSync(join(tmpdir(), 'qq-memoverflow-'))
try {
  // O1 空数组
  const empty = spillArchive({ dir: root, key: 'u_1', rows: [] })
  check('O1 空数组 ok 且 written=0', empty.ok === true && empty.written === 0)
  check('O1 不建 _overflow 目录', !existsSync(join(root, '_overflow')))

  // O2 第一次 3 行
  const rows3 = [
    { role: 'user', text: '第一句', ts: 1000 },
    { role: 'assistant', text: '第二句', ts: 2000 },
    { role: 'user', text: '第三句', ts: 3000 },
  ]
  const r1 = spillArchive({ dir: root, key: 'u_1', rows: rows3 })
  check('O2 ok 且 written=3', r1.ok === true && r1.written === 3)
  const file = join(root, '_overflow', 'u_1.jsonl')
  const lines1 = readFileSync(file, 'utf8').trimEnd().split('\n')
  check('O2 文件 3 行', lines1.length === 3, `n=${lines1.length}`)
  check('O2 内容与输入一致', JSON.stringify(lines1.map((l) => JSON.parse(l))) === JSON.stringify(rows3))
  check('O2 from/to 取自首尾', r1.from === 1000 && r1.to === 3000, `${r1.from}..${r1.to}`)

  // O3 追加而不是覆盖
  const r2 = spillArchive({ dir: root, key: 'u_1', rows: [{ role: 'user', text: '第四句', ts: 4000 }, { role: 'assistant', text: '第五句', ts: 5000 }] })
  const lines2 = readFileSync(file, 'utf8').trimEnd().split('\n')
  check('O3 追加后 5 行', r2.ok === true && lines2.length === 5, `n=${lines2.length}`)
  check('O3 最早那条还在（不是覆盖）', JSON.parse(lines2[0]).text === '第一句')

  // O4 key 安全化
  check('O4 路径字符被替换', overflowName('u:123/abc') === 'u_123_abc', overflowName('u:123/abc'))
  const r3 = spillArchive({ dir: root, key: '../../evil', rows: [{ role: 'user', text: 'x', ts: 1 }] })
  // 判据要写成"解析后仍在 _overflow 里"，不能写成"文件名不含 .."——
  // `.._.._evil.jsonl` 是**合法文件名**（`.` 保留是为了扩展名），不是穿越。
  const escaped = resolve(root, r3.file)
  check('O4 不能逃出 _overflow', dirname(escaped) === resolve(root, '_overflow'), r3.file)

  // O5 相对路径
  check('O5 file 不含绝对路径', !r3.file.includes(root) && !r3.file.includes(':'))

  // O6 空 dir
  const bad = spillArchive({ dir: '', key: 'u_1', rows: [{ role: 'user', text: 'x', ts: 1 }] })
  check('O6 空 dir ⇒ ok:false', bad.ok === false && typeof bad.error === 'string')

  // 写入失败也要返回 ok:false（用一个文件占住目录位置，让 mkdir 失败）
  const blocked = join(root, 'blocked')
  writeFileSync(blocked, 'not a dir')
  const fail = spillArchive({ dir: blocked, key: 'u_2', rows: [{ role: 'user', text: 'x', ts: 1 }] })
  check('O6 目录建不出来 ⇒ ok:false 并带 error', fail.ok === false && fail.error.length > 0, fail.error ?? '')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
