/**
 * 曲库匹配（2026-11-04）。
 *
 * 背景：主人听完念唱说"跟唱歌远多了"。查清楚后确认这是**路线问题**不是参数问题 ——
 * edge-tts 只能"有起伏地念"，而 B 站那波 AI 翻唱是**旋律驱动**（ACE Studio / DiffSinger：
 * MIDI + 歌词 → 人声）。所以桥这边加了"曲库"：用专业工具生成成品歌，丢进目录，
 * `!唱 歌名` 原样播。这个文件的判据就是"能不能找对歌"。
 *
 * 判据：
 *   M1 精确命中优先（`小兔子乖乖` 命中它自己，而不是先命中别的包含它的）
 *   M2 包含也能命中（`小兔子` → `小兔子乖乖.mp3`）
 *   M3 反向包含（`小兔子乖乖好` → 也能命中 `小兔子乖乖`，因为用户可能多打了字）
 *   M4 忽略大小写与扩展名
 *   M5 空输入 / 无命中 → null（不能乱播）
 *   M6 源码级：`!唱` 先查曲库再退回念唱；命中走 #sendVoiceFile 而不是合成
 */
import { readFileSync } from 'node:fs'
import { matchSongFile } from '../lib/bridge.js'

let passed = 0
let failed = 0
const check = (name, ok, extra = '') => {
  if (ok) { passed++; console.log('PASS', name, extra) } else { failed++; console.log('FAIL', name, extra) }
}

const FILES = ['小兔子乖乖.mp3', '两只老虎.mp3', 'Little Star.MP3']

// M1 精确优先
check('M1 精确命中', matchSongFile(FILES, '小兔子乖乖')?.file === '小兔子乖乖.mp3',
  JSON.stringify(matchSongFile(FILES, '小兔子乖乖')))
check('M1 精确优先于"包含"（两只老虎 vs 只）', matchSongFile(FILES, '两只老虎')?.title === '两只老虎')

// M2 包含
check('M2 部分名命中', matchSongFile(FILES, '小兔子')?.title === '小兔子乖乖')
check('M2 单个字也能命中', matchSongFile(FILES, '虎')?.title === '两只老虎')

// M3 反向包含（用户多打了字）
check('M3 反向包含', matchSongFile(FILES, '小兔子乖乖呀')?.title === '小兔子乖乖')

// M4 大小写 / 扩展名
check('M4 忽略大小写', matchSongFile(FILES, 'little star')?.title === 'Little Star')
check('M4 带扩展名也能命中', matchSongFile(FILES, '小兔子乖乖.mp3')?.title === '小兔子乖乖')

// M5 空 / 无命中
check('M5 空输入 → null', matchSongFile(FILES, '') === null && matchSongFile(FILES, '   ') === null)
check('M5 无命中 → null', matchSongFile(FILES, '完全不存在') === null)
check('M5 空库 → null', matchSongFile([], '小兔子乖乖') === null)

// M6 源码级
const src = readFileSync(new URL('../lib/bridge.js', import.meta.url), 'utf8')
const singAt = src.indexOf("if (cmd === 'sing') {")
const singBody = singAt < 0 ? '' : src.slice(singAt, singAt + 2600)
check('M6 ★!唱 先查曲库（#findSong 在合成之前）',
  singBody.includes('this.#findSong(text)') && singBody.indexOf('#findSong') < singBody.indexOf('念唱'))
check('M6 曲库命中返回 file（不是 text）', /voice: \{ file: song\.file \}/.test(singBody))
check('M6 ★命中走 #sendVoiceFile（原样播），不合成',
  /if \(result\.voice\.file\)[\s\S]{0,160}#sendVoiceFile/.test(src))
check('M6 没有歌时给出目录路径（否则用户不知道往哪放）', /把 mp3 放进：\$\{this\.#songDir\(\)\}/.test(singBody))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
