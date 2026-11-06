/**
 * 图片清理的**选择逻辑**（2026-11-06，#5）。
 *
 * 为什么要单独成文件：`qq-images/` 实测 73 MB / 172 个文件，半年就会到 GB 级，
 * 而它只增不减。清理又是个危险动作 —— 必须能单测"哪些会被选走、哪些绝对不动"，
 * 不能靠"跑一次看看"。
 *
 * 规则（写死）：
 *   1. `_` 开头的一律不动（`_favorites.json`、canary、`_video-tmp/` 之类）
 *   2. 收藏表里的一律不动（她标过"喜欢"的）
 *   3. 超过 `keepDays` 天的 ⇒ 移走
 *   4. 剩下的如果总大小还超过 `maxBytes` ⇒ 从最旧的开始移，直到不超
 *
 * 只做**选择**，不负责移动 —— 移动由调用方做（可以移到 `_trash/` 而不是删）。
 */

/**
 * @param {Array<{name:string,size?:number,mtime:number}>} files
 * @param {Set<string>|Record<string, unknown>|null} keep 收藏的图名
 * @param {{keepDays?:number,maxBytes?:number,now?:number}} opts
 * @returns {Array<{name:string,size:number,mtime:number,reason:'old'|'size'}>}
 */
export function selectImagesToPrune(files, keep, { keepDays = 30, maxBytes = 500 * 1024 * 1024, now = Date.now() } = {}) {
  const list = Array.isArray(files) ? files.filter((f) => f && typeof f.name === 'string') : []
  const kept = keep instanceof Set ? keep : new Set(Object.keys(keep ?? {}))
  const days = Math.max(1, Number(keepDays) || 30)
  const limit = Math.max(0, Number(maxBytes) || 0)
  const cutoff = now - days * 24 * 60 * 60 * 1000

  const candidates = list.filter((f) => !f.name.startsWith('_') && !kept.has(f.name))
  const old = new Set(candidates.filter((f) => Number(f.mtime) < cutoff).map((f) => f.name))

  // 年龄没超、但总大小超了：从最旧的开始补刀
  const rest = candidates.filter((f) => !old.has(f.name)).sort((a, b) => Number(a.mtime) - Number(b.mtime))
  let total = candidates.reduce((n, f) => n + (Number(f.size) || 0), 0)
  const tooBig = new Set()
  for (const f of rest) {
    if (total <= limit) break
    tooBig.add(f.name)
    total -= Number(f.size) || 0
  }

  return candidates
    .filter((f) => old.has(f.name) || tooBig.has(f.name))
    .map((f) => ({
      name: f.name,
      size: Number(f.size) || 0,
      mtime: Number(f.mtime) || 0,
      reason: old.has(f.name) ? 'old' : 'size',
    }))
}
