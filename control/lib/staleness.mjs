/**
 * 「控制台进程比代码旧」的检测（2026-11-01 夜）。
 *
 * 由来：一晚之内被同一个坑咬了两次。`ui.html` 是**每次请求从磁盘读**的（为了改样式能立刻看到），
 * 而 `server.mjs` / `supervisor.mjs` / `lib/persona-spec.js` 是**启动时加载进内存**的。
 * 于是重启之前，页面上的新按钮已经在了、点下去却回 `未知接口`；更糟的是新 UI 读旧服务端的
 * 数据结构（要 `analysis.blocks`，旧服务端只给 `analysis.sections`），面板就会显示
 * 「标准块 0/5」+「缺五个必填块」—— 而人设其实是完整的。
 *
 * 那种界面不是"报错"，是**看起来正常的错**：谁都会以为工具坏了（这次连我自己都先怀疑代码）。
 * 所以这里只做一件事：把"代码比进程新"这件事算出来、摆到页面上。
 *
 * 刻意**不自动重启**：控制台是会启停宿主进程的东西，自己悄悄重启自己，
 * 万一新进程起不来就没人能救。判断交给人，动作也交给人。
 */

/**
 * @param {{files?: string[], startedAt?: number, stat?: (file: string) => {mtimeMs: number}, toleranceMs?: number}} options
 * @returns {{stale: boolean, startedAt: number, newestFile: string, newestAt: number, newerCount: number, checked: number}}
 */
export function detectStale({ files = [], startedAt = 0, stat = null, toleranceMs = 1000 } = {}) {
  const statFn = typeof stat === 'function' ? stat : null
  let newestFile = ''
  let newestAt = 0
  let newerCount = 0
  let checked = 0
  for (const file of files) {
    if (!file || statFn === null) continue
    let mtimeMs = 0
    try { mtimeMs = Number(statFn(file)?.mtimeMs) || 0 } catch { continue }
    checked += 1
    if (mtimeMs > startedAt + toleranceMs) newerCount += 1
    if (mtimeMs > newestAt) { newestAt = mtimeMs; newestFile = file }
  }
  return {
    // 只有"文件比进程新"才算旧代码；容忍 1 秒，避免启动瞬间自己刚写过文件就误报。
    stale: newerCount > 0,
    startedAt,
    newestFile,
    newestAt,
    newerCount,
    checked,
  }
}
