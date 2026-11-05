/**
 * 从 lib/index.js 的 schema 生成「完整配置参考」表格，追加到 README。
 *
 * 规则（2026-11-05）：
 *   · 默认值**从代码读**，不手写、不猜
 *   · 说明取 `.description()` 原文（schema 里是英文），**不做机器翻译** —— 宁可留英文，
 *     也不要翻出个看着通顺但含义漂移的中文
 *   · 按域分组，组名用中文
 *   · **不写任何真实 QQ 号**：示例统一 100000001 / 2000000001
 *
 * 用法：node tools/gen-config-reference.mjs [--write]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 从模块位置推根目录（原来写死绝对路径，既换不了机器也会被 privacy 判成家目录泄露）
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const schema = readFileSync(`${ROOT}/lib/index.js`, 'utf8')
const readme = readFileSync(`${ROOT}/README.md`, 'utf8')

// ---------- 抽 schema：key / default / description ----------
/** @type {Array<{key:string, def:string, desc:string}>} */
const items = []
// 每个配置项形如：  key: z.xxx(...).default(X).description('...')  可能跨行
const re = /^ {2}([a-zA-Z][\w]*):\s*z\b([\s\S]*?)(?=\n {2}[a-zA-Z][\w]*:|\n\}\)|\n\})/gm
for (const m of schema.matchAll(re)) {
  const key = m[1]
  const body = m[2]
  const defM = /\.default\(([^)]*)\)/.exec(body)
  const descM = /\.description\(\s*(['"])([\s\S]*?)\1\s*\)/.exec(body)
  if (!defM) continue
  let desc = descM ? descM[2] : ''
  desc = desc.replace(/\\'/g, "'").replace(/\s+/g, ' ').trim()
  if (desc.length > 160) desc = `${desc.slice(0, 157)}...`
  items.push({ key, def: defM[1].trim(), desc })
}

// ---------- README 已有的键（不重复写） ----------
const documented = new Set()
{
  let inTable = false
  for (const line of readme.split('\n')) {
    if (/^\|\s*键\s*\|\s*默认\s*\|/.test(line)) { inTable = true; continue }
    if (inTable && !line.startsWith('|')) { inTable = false; continue }
    if (!inTable) continue
    const m = /^\|\s*`([a-zA-Z][\w]*)`\s*\|/.exec(line)
    if (m) documented.add(m[1])
  }
}

const missing = items.filter((it) => !documented.has(it.key))

// ---------- 分组 ----------
const GROUPS = [
  ['主动通道（proactive）', (k) => /^proactive|^oneSentence/.test(k)],
  ['群运营（groupOps / ops）', (k) => /^(groupOps|nativeSign|ops[A-Z]|requestSync|adminWatch|opsCounters)/.test(k)],
  ['互动（engage / poke / 表情回应 / 点赞）', (k) => /^(engage|poke|typing|emojiLike|reactionStats|sendLike|markRead|funEnabled)/.test(k)],
  ['视频与图片帧', (k) => /^(cardVideo|videoFrame|videoFrames|videoMaxBytes|videoSpeech|gifFrame|ffmpegPath)/.test(k)],
  ['内容与卡片（B站 / 卡片解析 / 红包）', (k) => /^(cardLook|biliCookie|webSearchHint|redPacket|groupImageView|qqMediaCacheRoots|ytDlp)/.test(k)],
  ['播报与推送（webhook / broadcast / notify）', (k) => /^(webhook|broadcast|notify)/.test(k)],
  ['自愈（autoHeal）', (k) => /^autoHeal/.test(k)],
  ['安全与出网', (k) => /^(allowBrowserOrigin|outboundRedact|egressAllowHosts|linkReadAllowAnyHost|taint|inboundLocalPathRoots|fileTransfer)/.test(k)],
  ['记忆与摘要', (k) => /^(memoryArchive|groupMemoryPerSpeaker|summaryEnabled)/.test(k)],
  ['管理与权限', (k) => /^(admin|botQqAllowed)/.test(k)],
  ['语音（TTS / STT 补充）', (k) => /^(tts|voiceTool|sttProvider|sttLanguage|sttLongVoice)/.test(k)],
  ['历史检索与群资产（v0.5 起）', (k) => /^(forwardExpand|forwardMax|forwardImageMax|memberQuery|memberListLimit|friendListEnabled|historyQuery|historyQueryLimit|reactToolEnabled|leaveGroupEnabled|ocrEnabled|ocrMaxImages|groupFile|albumEnabled|historyArchive|historySearch)/.test(k)],
  ['其他（内部 / 实验性）', () => true],
]
const buckets = new Map(GROUPS.map(([name]) => [name, []]))
for (const it of missing) {
  for (const [name, test] of GROUPS) {
    if (test(it.key)) { buckets.get(name).push(it); break }
  }
}

// ---------- 生成 Markdown ----------
const fmtDef = (v) => {
  const s = String(v).trim()
  if (s === '' ) return "`''`"
  if (s === 'true' || s === 'false') return `\`${s}\``
  if (/^-?\d+(\.\d+)?$/.test(s)) return `\`${s}\``
  if (s.startsWith('[') || s.startsWith('{')) return `\`${s}\``
  return `\`${s.replace(/^['"]|['"]$/g, '')}\``
}

const lines = []
lines.push('')
lines.push('### 完整配置参考（自动生成，2026-11-05）')
lines.push('')
lines.push('> 上表只放"日常会动"的项。**这一节是 schema 里的全部剩余项**，默认值从代码读，')
lines.push('> 说明保留 schema 原文（英文）—— 不做机器翻译，避免翻出"看着通顺但含义漂移"的中文。')
lines.push('>')
lines.push('> 由 `tools/gen-config-reference.mjs` 生成；改 schema 后重跑即可，别手改这一节。')
lines.push('> 示例里的号码一律用占位（`100000001` / `2000000001`），与真实账号无关。')
lines.push('')

let wrote = 0
for (const [name, arr] of buckets) {
  if (arr.length === 0) continue
  lines.push(`#### ${name}（${arr.length} 项）`)
  lines.push('')
  lines.push('| 键 | 默认 | 说明（schema 原文） |')
  lines.push('|---|---|---|')
  for (const it of arr) {
    const desc = it.desc === '' ? '—' : it.desc.replace(/\|/g, '\\|')
    lines.push(`| \`${it.key}\` | ${fmtDef(it.def)} | ${desc} |`)
    wrote += 1
  }
  lines.push('')
}

if (wrote === 0) {
  // 已经全补过了：不追加空节（否则每次重跑都往 README 里塞一段"0 项"的标题）
  console.log('README 已覆盖全部 schema 项，无需追加')
  process.exit(0)
}

const block = lines.join('\n')

if (!process.argv.includes('--write')) {
  console.log(`将追加 ${wrote} 项 / ${buckets.size} 组，共 ${block.split('\n').length} 行`)
  console.log('前 25 行预览：')
  console.log(block.split('\n').slice(0, 25).join('\n'))
  process.exit(0)
}

// 插在「## 用户侧（OneBot 实现）配置」之前
const anchor = '## 用户侧（OneBot 实现）配置'
if (!readme.includes(anchor)) { console.error('找不到插入锚点'); process.exit(1) }
writeFileSync(`${ROOT}/README.md`, readme.replace(anchor, `${block}\n${anchor}`), 'utf8')
console.log(`已写入 ${wrote} 项 / ${buckets.size} 组`)
