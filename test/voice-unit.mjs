/**
 * 音色 / 试听 / 唱歌（2026-11-04）。
 *
 * 判据：
 *   V1 切句：换行、标点、空句、超长硬切、上限
 *   V2 唱腔 SSML：一句一个 <s>、pitch 循环、空歌词抛错、XML 转义
 *   V3 非 azure provider 唱 → 明确抛错（不悄悄退化成平读）
 *   V4 音色清单非空且默认音色在表里
 *   V5 源码级：命令解析认中文别名、执行分支存在、唱歌不被 ttsMaxChars 截断
 */
import { readFileSync } from 'node:fs'
import { splitLyricLines, buildSongSsml, buildAzureSsml, synthesizeSong, VOICE_CATALOG } from '../lib/tts.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// ---------- V1 切句 ----------
check('V1 按换行切', JSON.stringify(splitLyricLines('第一句\n第二句')) === JSON.stringify(['第一句', '第二句']))
check('V1 按标点切', JSON.stringify(splitLyricLines('甲，乙。丙！')) === JSON.stringify(['甲', '乙', '丙']))
check('V1 空句丢掉', splitLyricLines('甲，\n\n，，乙').length === 2, JSON.stringify(splitLyricLines('甲，\n\n，，乙')))
check('V1 空输入 → 空数组', splitLyricLines('').length === 0 && splitLyricLines(null).length === 0)
{
  const long = '一'.repeat(95)
  const lines = splitLyricLines(long, { maxCharsPerLine: 40 })
  check('V1 超长句硬切成多段', lines.length === 3 && lines.every((l) => l.length <= 40), JSON.stringify(lines.map((l) => l.length)))
}
{
  const many = Array.from({ length: 80 }, (_, i) => `句${i}`).join('，')
  check('V1 上限 60 句', splitLyricLines(many).length === 60)
}

// ---------- V2 唱腔 SSML ----------
{
  const ssml = buildSongSsml('甲，乙，丙', 'zh-CN-XiaoxiaoNeural', '')
  const sCount = (ssml.match(/<s>/g) ?? []).length
  check('V2 一句一个 <s>', sCount === 3, String(sCount))
  check('V2 每句带 prosody pitch', (ssml.match(/<prosody pitch="[+\-]\d+%"/g) ?? []).length === 3)
  check('V2 是合法 speak/voice 结构', /^<speak version="1\.0"/.test(ssml) && /<voice name="zh-CN-XiaoxiaoNeural">/.test(ssml))
}
check('V2 pitch 循环（第 1 句与第 7 句相同）', (() => {
  const ssml = buildSongSsml(Array.from({ length: 7 }, (_, i) => `句${i}`).join('，'), 'v')
  const pitches = [...ssml.matchAll(/pitch="([^"]+)"/g)].map((m) => m[1])
  return pitches.length === 7 && pitches[0] === pitches[6]
})())
check('V2 空歌词抛错', (() => { try { buildSongSsml('  ', 'v'); return false } catch { return true } })())
check('V2 XML 转义（& < >）', (() => {
  const ssml = buildSongSsml('A&B<C>', 'v')
  return ssml.includes('A&amp;B&lt;C&gt;')
})())

// ---------- V3 非 azure 唱 ----------
// 2026-11-04 改：openai + 本地服务也能唱了（走 /v1/audio/sing），
// 所以这里的判据从"非 azure 一律拒绝"变成"**没配 ttsBaseUrl** 才拒绝"。
check('V3 openai 且没配 ttsBaseUrl → 明确抛错', await (async () => {
  try { await synthesizeSong({ ttsProvider: 'openai', ttsApiKey: 'x', ttsBaseUrl: '' }, '甲'); return false } catch (error) { return /没配 ttsBaseUrl|不支持唱/.test(error.message) }
})())
check('V3 azure 但没 key → 抛错（不静默）', await (async () => {
  try { await synthesizeSong({ ttsProvider: 'azure', ttsApiKey: '' }, '甲'); return false } catch (error) { return /ttsApiKey/.test(error.message) }
})())

// ---------- V4 音色清单 ----------
check('V4 清单至少 10 个', VOICE_CATALOG.length >= 10, String(VOICE_CATALOG.length))
check('V4 默认音色晓晓在表里', VOICE_CATALOG.some((v) => v.id === 'zh-CN-XiaoxiaoNeural'))
check('V4 每条都有 id/name/tag', VOICE_CATALOG.every((v) => v.id && v.name && v.tag))

// ---------- V5 源码级 ----------
const src = readFileSync(new URL('../lib/bridge.js', import.meta.url), 'utf8')
check('V5 ★中文别名（!音色/!试听/!唱）', /'音色':\s*'voice'/.test(src) && /'试听':\s*'speak'/.test(src) && /'唱':\s*'sing'/.test(src))
check('V5 三个执行分支都在', /if \(cmd === 'voice'\) \{/.test(src) && /if \(cmd === 'speak'\) \{/.test(src) && /if \(cmd === 'sing'\) \{/.test(src))
check('V5 ★唱歌不被 ttsMaxChars 截断', /options\.song === true \? 2000/.test(src))
check('V5 语音结果先发语音再回执', /if \(result\.ok === true && result\.voice\)/.test(src))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
