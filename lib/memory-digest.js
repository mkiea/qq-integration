/**
 * 总纲记忆的**出处校验闸**（2026-11-06）。
 *
 * 为什么需要：本地 `qwen2.5:7b` 在 300 条输入上会编 —— 实测它写出
 * 「最近在做什么：看动画」，而输入里根本没有"动画"两个字；还把**对方**说的
 * 「在弄虚拟机呢」写成「她喜欢的东西：虚拟机」。
 *
 * 光在 prompt 里写"不要编造"没用（纪律：别先改 prompt）。所以加一道**事后闸**：
 * 每个条目拿去和「她说过的话」比 2 字片段覆盖率，低于阈值就丢掉并记账。
 *
 * 判据写死（跑之前定）：
 *   · 条目长度 < 3 字 ⇒ 放行（"画画""糖果"太短，判不了）
 *   · 2 字片段覆盖率 ≥ 0.30 ⇒ 有据
 *   · 否则 ⇒ 丢弃，进 `dropped`
 */
export function bigrams(text) {
  const clean = String(text ?? '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '')
  const out = []
  for (let i = 0; i < clean.length - 1; i++) out.push(clean.slice(i, i + 2))
  return out
}

/**
 * 把行数组切成固定大小的块（分批摘要用）。
 *
 * 为什么要分批：单次塞 300 条给 7B 已经退化（实测编造 + 漏项），
 * 一次性塞 460 条更不行。分批后每次只有 ~80 行，模型稳定得多。
 *
 * @returns {string[][]} 块数组；输入为空时返回空数组（不是 `[[]]`）
 */
export function chunkLines(lines, size = 80) {
  const list = Array.isArray(lines) ? lines : []
  const n = Math.max(1, Number(size) || 1)
  const out = []
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n))
  return out
}

export function groundingRatio(item, corpus) {
  const grams = bigrams(item)
  if (grams.length === 0) return 1
  const hit = grams.filter((g) => corpus.includes(g)).length
  return hit / grams.length
}

/**
 * 过滤无出处条目。汇总文本里只处理 `- 类别：条目、条目` 形式的行，
 * 其余（标题、引用块）原样保留。
 *
 * @returns {{text:string, dropped:Array<{item:string,ratio:number}>}}
 */
export function filterFabricated(summary, corpus, { threshold = 0.3 } = {}) {
  const dropped = []
  const out = []
  for (const raw of String(summary ?? '').split(/\r?\n/)) {
    const line = raw.trimEnd()
    const m = /^-\s*([^：:]+)[：:]\s*(.+)$/.exec(line.trim())
    if (!m) { out.push(line); continue }
    const items = m[2].split(/[、，,；;]/).map((s) => s.trim()).filter(Boolean)
    const good = items.filter((item) => {
      if (item.length < 3) return true
      const ratio = groundingRatio(item, corpus)
      if (ratio < threshold) { dropped.push({ item, ratio }); return false }
      return true
    })
    out.push(`- ${m[1]}：${good.length ? good.join('、') : '无'}`)
  }
  return { text: out.join('\n'), dropped }
}
