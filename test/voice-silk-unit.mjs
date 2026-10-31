/**
 * mp3 → SILK 转码（lib/silk.js）。
 *
 * 这一层存在的唯一理由：QQ 9.9.36 起不再把 mp3 转成 silk，直接发 mp3 会在 NTQQ 内部
 * 报 `retcode 1400 Cannot convert undefined or null to object` —— 错误信息完全看不出是
 * 格式问题。所以测试必须**正反都验**：
 *   · 正：真 mp3 转出来的东西，文件头是 `#!SILK_V3`，而且能被 silk 解码器解回 PCM；
 *   · 反：mp3 数据本身**不能**被判成 silk（否则 looksLikeSilk 恒真，正断言就没有意义了）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { SILK_MAGIC, looksLikeSilk, silkEncoderAvailable, toSilk } from '../lib/silk.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) } else { failed++; console.log('FAIL', name, extra) }
}

/** 找一个可用的 ffmpeg：本机没有 PATH 里的 ffmpeg，所以要把项目已知落点也试一遍。 */
function findFfmpeg() {
  const candidates = [
    process.env.FFMPEG_PATH,
    join(homedir(), '.dsh', 'bin', 'ffmpeg.exe'),
    join(homedir(), '.dsh', 'bin', 'ffmpeg'),
    'ffmpeg',
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['-version'], { stdio: 'ignore', timeout: 10_000 })
      return candidate
    } catch { /* 试下一个 */ }
  }
  return null
}

// ── 1. 判据本身：正反都验 ───────────────────────────────────────────────
{
  // 真 silk 的前 10 字节（从 QQ 自己缓存的语音文件里抄的）
  const realSilkHead = Buffer.from([0x02, 0x23, 0x21, 0x53, 0x49, 0x4c, 0x4b, 0x5f, 0x56, 0x33, 0x00, 0x00])
  check('真 SILK 头被判为 silk', looksLikeSilk(realSilkHead) === true, realSilkHead.toString('latin1'))

  // MP3 帧头（0xFFF3），必须判 false —— 这条是防「恒真」假实现的对照组
  const mp3Head = Buffer.from([0xff, 0xf3, 0x64, 0xc4, 0x00, 0x00, 0x00, 0x03, 0x48, 0x00, 0x00, 0x00])
  check('MP3 头不被判为 silk', looksLikeSilk(mp3Head) === false)

  check('空数据不判为 silk', looksLikeSilk(Buffer.alloc(0)) === false)
  check('短于 10 字节不判为 silk', looksLikeSilk(Buffer.from([0x02, 0x23, 0x21])) === false)
  check('魔数常量是 #!SILK_V3', SILK_MAGIC === '#!SILK_V3')
}

// ── 2. 编码器可用性（可选依赖，装没装要说清）────────────────────────────
const encoderOk = await silkEncoderAvailable()
console.log(encoderOk ? 'INFO silk-wasm 可用，跑真实转码用例' : 'SKIP silk-wasm 未安装 —— 只跑降级用例（这不是"通过"，是没测到）')

const ffmpeg = findFfmpeg()
if (ffmpeg === null) console.log('SKIP 找不到 ffmpeg —— 真实转码用例无法执行（这不是"通过"，是没测到）')

// ── 3. 降级路径：不该抛错，只该返回 null ────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'silk-null-'))
  try {
    const missing = await toSilk(join(dir, 'does-not-exist.mp3'), { ffmpegPath: ffmpeg || 'ffmpeg' })
    check('文件不存在 ⇒ 返回 null 而不是抛错', missing === null)

    // 内容根本不是音频：ffmpeg 会失败 ⇒ 仍然是 null（调用方据此降级发 mp3）
    const junk = join(dir, 'junk.mp3')
    writeFileSync(junk, Buffer.from('this is definitely not audio'))
    const bad = await toSilk(junk, { ffmpegPath: ffmpeg || 'ffmpeg' })
    check('坏音频 ⇒ 返回 null 而不是抛错', bad === null)

    // 中间产物不该留在原目录（qq-tts/ 会被越攒越满）
    const leftovers = readdirSync(dir).filter((name) => name.includes('.silk-src.wav'))
    check('失败路径不残留中间 WAV', leftovers.length === 0, leftovers.join(','))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── 4. 真实转码（只在 ffmpeg + silk-wasm 都在时执行）────────────────────
if (encoderOk && ffmpeg !== null) {
  const dir = mkdtempSync(join(tmpdir(), 'silk-real-'))
  try {
    const mp3 = join(dir, 'tone.mp3')
    // 生成 1 秒 440Hz 单声道 24k mp3：不依赖 TTS 服务，测试可离线复现
    execFileSync(ffmpeg, [
      '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-ar', '24000', '-ac', '1', mp3,
    ], { stdio: 'ignore', timeout: 30_000 })

    const sourceBytes = readFileSync(mp3).length
    check('测试素材 mp3 已生成', sourceBytes > 0, `${sourceBytes} 字节`)

    const result = await toSilk(mp3, { ffmpegPath: ffmpeg })
    check('转码返回结果（不是 null）', result !== null && result !== undefined)

    if (result) {
      const data = readFileSync(result.file)
      check('输出文件扩展名是 .silk', result.file.endsWith('.silk'), result.file.split(/[\\/]/).pop())
      check('输出文件头是 #!SILK_V3', looksLikeSilk(data), data.subarray(0, 10).toString('latin1'))
      check('返回的字节数与实际文件一致', result.bytes === data.length, `${result.bytes} vs ${data.length}`)
      check('时长被识别出来（≈1000ms）', result.durationMs > 500 && result.durationMs < 2000, `${result.durationMs}ms`)
      /**
       * 最关键的一条：**SILK 比 MP3 小**。
       * 如果实现只是把 mp3 改了个扩展名，这条会挂 —— 它是「真的转码了」和
       * 「假装转码了」之间唯一的分界线。
       */
      check('SILK 体积确实小于源 MP3（证明真转码，不是改扩展名）', data.length < sourceBytes, `${data.length} < ${sourceBytes}`)

      // 用同库的解码器解回来：能解出 PCM 才说明不是「头部对、内容坏」
      const require = createRequire(import.meta.url)
      const { decode } = require('silk-wasm')
      const decoded = await decode(data, 24000)
      check('产物能被 SILK 解码器解回 PCM', decoded?.data?.length > 0, `${decoded?.data?.length ?? 0} 字节 PCM`)

      const leftovers = readdirSync(dir).filter((name) => name.includes('.silk-src.wav'))
      check('成功路径也不残留中间 WAV', leftovers.length === 0, leftovers.join(','))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
