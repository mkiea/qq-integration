/**
 * 记忆归档溢出：把 `archive` 挤出去的原文**转存**下来（2026-11-06）。
 *
 * 背景：`#recordMemory` 以前用 `while (archive.length > archiveMax) archive.shift()`
 * 直接丢掉最旧的一条 —— 不落盘、不记日志。早期聊过的事从此不可逆地没了。
 *
 * 这里只做一件事：**追加写，不重写、不删除**。
 * 单独成文件是为了能单测 —— 桥里的私有方法测不到，测不到就等于没修。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** chatKey → 安全文件名（`u:123` / `g/456` 这类字符不能直接进文件名）。 */
export function overflowName(key) {
  return String(key ?? 'unknown').replace(/[^\w.-]+/g, '_') || 'unknown'
}

/**
 * 把一批被挤出的记忆行追加到 `<dir>/_overflow/<key>.jsonl`。
 *
 * @returns {{ok:boolean, written:number, file:string, from?:number, to?:number, error?:string}}
 *   `file` 是相对 `dir` 的路径（写日志用，不把绝对路径泄进事件流）。
 */
export function spillArchive({ dir, key, rows }) {
  if (typeof dir !== 'string' || dir === '') return { ok: false, written: 0, file: '', error: 'dir 为空' }
  if (!Array.isArray(rows) || rows.length === 0) return { ok: true, written: 0, file: '' }
  const name = overflowName(key)
  const file = join(dir, '_overflow', `${name}.jsonl`)
  try {
    mkdirSync(join(dir, '_overflow'), { recursive: true })
    appendFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
    return {
      ok: true,
      written: rows.length,
      file: `_overflow/${name}.jsonl`,
      from: Number(rows[0]?.ts) || 0,
      to: Number(rows[rows.length - 1]?.ts) || 0,
    }
  } catch (error) {
    return { ok: false, written: 0, file: `_overflow/${name}.jsonl`, error: String(error?.message ?? error).slice(0, 200) }
  }
}
