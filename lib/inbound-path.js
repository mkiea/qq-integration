/**
 * inbound-path.js —— 入站「本地绝对路径」的准入判断（2026-10-31 红队 L① 之后）
 *
 * 为什么要有这一层：OneBot 的文件帧里 `file` / `path` 字段**完全由发送方控制**。
 * 旧代码只判断形状（`/^([a-zA-Z]:[\\/]|\/)/`），然后就 `existsSync` + `readFileSync`：
 *
 *   伪造一帧 → `file = C:\Users\someone\.ssh\id_rsa` → 内容（≤4 KiB 时）直接内联进她的上下文
 *   → 再按攻击者给的 `name` 改名落成 `qq-files/invoice.txt` → 为外发做铺垫。
 *
 * 这不是推测：2026-10-31 红队 L① 用 mock OneBot 实测打穿了（BREAK）。
 *
 * 为什么敢**默认全拒**：本机 1215 条真实入站帧里 `file` 全部是纯文件名
 * （`2A24C…jpg`、`123.txt`），绝对路径一条都没有 ⇒ 这条分支在正常流量下从未执行过。
 * 关掉它不影响任何正常功能，只是把一条没被实战检验过的路收到需要显式开启。
 *
 * 为什么必须 `realpath`：2026-10-29 出站侧已经栽过一次 —— 只比对字符串时，
 * 一个指向受保护目录的 junction 可以完全不出现关键字。同一套坑不要踩第二遍。
 */

import { realpathSync, existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'

/** 绝对路径形状（盘符或 `/` 开头）。纯文件名不算 —— 那是正常流量。 */
export function looksAbsolutePath(value) {
  return /^([a-zA-Z]:[\\/]|\/)/.test(String(value ?? ''))
}

/**
 * 这个入站路径能不能读。
 *
 * @param {string} rawPath 帧里给的 `file` / `path`
 * @param {string[]} roots `inboundLocalPathRoots` 配置值
 * @returns {{ ok: boolean, reason: string, real?: string }}
 *   reason: `no-roots` | `not-absolute` | `missing` | `outside-roots` | ''
 */
export function checkInboundLocalPath(rawPath, roots = []) {
  const value = String(rawPath ?? '').trim()
  if (!looksAbsolutePath(value)) return { ok: false, reason: 'not-absolute' }

  const allowed = (Array.isArray(roots) ? roots : [])
    .map((root) => String(root ?? '').trim())
    .filter(Boolean)
  // 默认空 = 一律拒（这是安全默认，不是「没配好」）
  if (allowed.length === 0) return { ok: false, reason: 'no-roots' }

  if (!existsSync(value)) return { ok: false, reason: 'missing' }

  let real = value
  try { real = realpathSync(value) } catch { return { ok: false, reason: 'missing' } }

  const inside = allowed.some((root) => {
    let realRoot = root
    try { realRoot = realpathSync(root) } catch { /* 目录不存在就按原值比 */ }
    const base = resolve(realRoot)
    const target = resolve(real)
    return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
  })
  return inside ? { ok: true, reason: '', real } : { ok: false, reason: 'outside-roots', real }
}
