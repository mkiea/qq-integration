/**
 * 入站语音：SILK → 16 kHz WAV 的单测（2026-11-01）。
 *
 * 这份测试是"她听不见语音"这件事查到底之后固化的，钉死三个**实测出来的事实**，
 * 每一个都对应一次真实的失败：
 *
 * ① QQ 语音的文件名写着 `.amr`，内容是 SILK（`\x02#!SILK_V3`）；
 * ② `silk-wasm` 的 `decode` **要求保留** 0x02 首字节（剥掉反而全部失败）；
 * ③ 本机 ffmpeg **没有** silk 解码器 —— 所以这条路不能经过 ffmpeg。
 *
 * 没有依赖任何外部文件：SILK fixture 用 `silk-wasm` 自己编码生成。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { decodeSilk, looksLikeSilk, normalizeSilk } from '../lib/silk.js'
import { formatClock, inspectWav, pcmToWav, speechTimeline, toWav16k } from '../lib/stt.js'

let passed = 0
let failed = 0
const check = (name, ok, extra = '') => {
  if (ok) { passed += 1; console.log(`PASS ${name}${extra ? '  ' + extra : ''}`) }
  else { failed += 1; console.log(`FAIL ${name}${extra ? '  ' + extra : ''}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'stt-silk-'))

/** 造一段 1 秒 24 kHz 单声道 PCM16 正弦波，再编码成 SILK（带 0x02 首字节，与 QQ 一致）。 */
async function makeSilk(seconds = 1, sampleRate = 24000) {
  const { encode } = await import('silk-wasm')
  const frames = Math.round(seconds * sampleRate)
  const pcm = Buffer.alloc(frames * 2)
  for (let i = 0; i < frames; i += 1) {
    // 440 Hz 正弦，避免纯静音被某些解码器优化掉
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000), i * 2)
  }
  const { data } = await encode(pcm, sampleRate)
  return Buffer.from(data)
}

try {
  const silk = await makeSilk(1)

  // —— ① SILK 的形状：首字节 0x02 + `#!SILK_V3` ——
  check('encode 产物首字节是 0x02（与 QQ 缓存一致）', silk[0] === 0x02, `0x${silk[0].toString(16)}`)
  check('looksLikeSilk 认得出它', looksLikeSilk(silk) === true)
  check('normalizeSilk 对带首字节的输入原样返回', normalizeSilk(silk).equals(silk))

  const stripped = silk.subarray(1)
  check('剥掉首字节后 looksLikeSilk 变成 false（判定只认带前缀的形状）', looksLikeSilk(stripped) === false)
  const rePrefixed = normalizeSilk(stripped)
  check('★ normalizeSilk 会给裸 #!SILK_V3 补回 0x02', rePrefixed[0] === 0x02 && rePrefixed.length === silk.length)

  // —— ② decode 的重采样：直接出 16 kHz ——
  const pcm16 = await decodeSilk(silk, { sampleRate: 16000 })
  check('decodeSilk 能解出 PCM', pcm16.length > 0, `${pcm16.length} 字节`)
  const seconds = pcm16.length / 2 / 16000
  check('★ 解出来的时长接近 1 秒（证明确实重采样到 16 kHz）', seconds > 0.8 && seconds < 1.2, `${seconds.toFixed(2)}s`)
  const pcm24 = await decodeSilk(silk, { sampleRate: 24000 })
  check('24 kHz 与 16 kHz 的样本数比值是 1.5', Math.abs(pcm24.length / pcm16.length - 1.5) < 0.02, `${(pcm24.length / pcm16.length).toFixed(3)}`)

  // —— ③ 剥掉首字节会失败（这条是"按通行说法做就会踩"的那个坑）——
  // ⚠️ 这里必须**绕过 decodeSilk 的前置检查**直接打 silk-wasm 的 decode，
  // 否则测到的只是"被 looksLikeSilk 挡住了"，而不是"silk-wasm 解不开"——
  // 两件事看起来都是失败，但只有后者能证明"不能剥"这个结论。
  const silkWasm = await import('silk-wasm')
  let rawFailed = false
  let rawMessage = ''
  try {
    await silkWasm.decode(new Uint8Array(stripped), 16000)
  } catch (error) {
    rawFailed = true
    rawMessage = String(error?.message ?? error)
  }
  check('★ silk-wasm 直接解剥掉 0x02 的字节会失败（证明"不能剥"）', rawFailed, rawMessage.slice(0, 40))
  check('带 0x02 的同一段字节能被 silk-wasm 解开（对照组）', (await silkWasm.decode(new Uint8Array(silk), 16000)).data.length > 0)

  // 非 SILK 输入要被明确拒绝，别让它一路走到"转出来是噪音"
  let rejected = ''
  try {
    await decodeSilk(Buffer.from('not a silk file at all', 'utf8'))
  } catch (error) { rejected = String(error?.message ?? error) }
  check('非 SILK 输入被拒绝', rejected.includes('不是 SILK'), rejected.slice(0, 30))

  // —— ④ pcmToWav：头必须是规范 44 字节 ——
  const wav = pcmToWav(pcm16, { sampleRate: 16000 })
  const info = inspectWav(wav)
  check('pcmToWav 产物通过 inspectWav（DSH 的严格校验）', info.ok === true, info.reason ?? '')
  check('WAV 长 = 44 + PCM 长', wav.length === 44 + pcm16.length)

  const oddPcm = Buffer.concat([pcm16, Buffer.from([0x01])])
  const oddWav = pcmToWav(oddPcm, { sampleRate: 16000 })
  check('奇数长度的 PCM 被截齐（否则平台判"数据长度是奇数"）', inspectWav(oddWav).ok === true)

  // —— ⑤ toWav16k：SILK 走自己的路，**不碰 ffmpeg** ——
  let ffmpegTouched = false
  const run = async () => { ffmpegTouched = true }
  const out = await toWav16k({ buffer: silk, ext: 'amr', tmpDir: dir, run })
  check('toWav16k 对 SILK 输出合法 WAV', inspectWav(out).ok === true)
  check('★★★ SILK 分支完全没有调用 ffmpeg（本机 ffmpeg 无 silk 解码器）', ffmpegTouched === false)

  // 文件名写着 .amr 也要按内容走 SILK 分支
  const outAmr = await toWav16k({ buffer: silk, ext: 'amr', tmpDir: dir, run })
  check('扩展名 .amr 不影响判定（只看 magic）', inspectWav(outAmr).ok === true)

  /**
   * ★ 裸 `#!SILK_V3`（没有 0x02）也要能走通。
   *
   * 这条是回归测试：`isSilkBuffer` 出现之前，`toWav16k` 用严格的 `looksLikeSilk` 判定，
   * 裸文件在进 `decodeSilk` 之前就被判成"不是 SILK"，而为它准备好的
   * `normalizeSilk`（补前缀）**永远轮不到执行** —— 修一层补出来的死锁。
   */
  let strayFfmpeg = false
  const outBare = await toWav16k({
    buffer: stripped, ext: 'amr', tmpDir: dir,
    run: async () => { strayFfmpeg = true },
  })
  check('★★ 裸 #!SILK_V3（无 0x02）也能解（normalizeSilk 补前缀生效）', inspectWav(outBare).ok === true)
  check('裸 SILK 同样没有落到 ffmpeg', strayFfmpeg === false)

  // —— ⑥ 非 SILK 仍然走 ffmpeg（不能把老路弄坏）——
  let ffmpegArgs = null
  const fakeRun = async (cmd, args) => {
    ffmpegArgs = { cmd, args }
    // 假装 ffmpeg 成功：把输出位置写一个合法 WAV
    const target = args[args.length - 1]
    const { writeFileSync } = await import('node:fs')
    writeFileSync(target, pcmToWav(pcm16, { sampleRate: 16000 }))
  }
  const wavPath = await toWav16k({ buffer: Buffer.from('ID3 fake mp3 bytes'), ext: 'mp3', tmpDir: dir, run: fakeRun, ffmpegPath: 'C:/fake/ffmpeg.exe' })
  check('非 SILK（mp3）仍然走 ffmpeg', ffmpegArgs !== null && ffmpegArgs.cmd === 'C:/fake/ffmpeg.exe')
  check('ffmpeg 参数里有人 16k 单声道 PCM16', ffmpegArgs?.args?.join(' ').includes('-ar 16000'), ffmpegArgs?.args?.slice(0, 4).join(' '))
  check('非 SILK 分支的产物也合法', inspectWav(wavPath).ok === true)

  // 注入假解码器，验证失败原因能被翻译成中文
  let decodeError = ''
  try {
    await toWav16k({ buffer: silk, ext: 'amr', tmpDir: dir, decodeSilk: async () => { throw new Error('boom') } })
  } catch (error) { decodeError = String(error?.message ?? error) }
  check('SILK 解码失败时给出中文原因', decodeError.includes('SILK 解码失败'), decodeError.slice(0, 40))

  // 空缓冲
  let emptyError = ''
  try {
    await toWav16k({ buffer: Buffer.alloc(0), ext: 'amr', tmpDir: dir })
  } catch (error) { emptyError = String(error?.message ?? error) }
  check('空音频被拒绝', emptyError.includes('空的'), emptyError.slice(0, 30))
} finally {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
}

/**
 * ── ⑦ ffmpeg 路（视频音轨）：mp4 → 16kHz WAV 必须过 inspectWav ────────
 *
 * ★ 这是 2026-11-01 真机事故固化成的一条断言，别再让它回归：
 *
 * 我给"视频音轨转写"另写了一份 ffmpeg 抽音轨（`-ar 16000 -ac 1 -c:a pcm_s16le`），
 * 真机报 **「WAV 的 data 块不在偏移 36（多半多了元数据块，例如 ffmpeg 默认写的 LIST）」**。
 * 原因：ffmpeg 默认会往 wav 里写 `LIST/INFO` 元数据块，`data` 就不在 36；
 * 而 DSH 的 `inspectWav` 是**严格按偏移**校验的（对齐平台 validateWave，不做块遍历）。
 * `toWav16k` 早就处理过（`-map_metadata -1 -fflags +bitexact` + `canonicalizeWav` 兜底），
 * 我却另起了一份更简陋的 —— 同一个规矩写两遍，第二遍必然漏。
 *
 * 所以这条测试测的不是"能转"，而是"转出来的东西**规格合法**"：
 * 只断言退出码 0 是不够的，那不覆盖 data 偏移。
 */
{
  const { execFile } = await import('node:child_process')
  const { existsSync, writeFileSync } = await import('node:fs')
  const { homedir } = await import('node:os')
  const ffmpegPath = [process.env.RIN_FFMPEG, join(homedir(), '.dsh', 'bin', 'ffmpeg.exe')]
    .filter(Boolean).find((p) => existsSync(p)) ?? ''
  const dir = mkdtempSync(join(tmpdir(), 'stt-ffmpeg-'))
  try {
    if (ffmpegPath === '') {
      console.log('SKIP ffmpeg 路（本机没找到 ffmpeg）')
    } else {
      const mp4 = join(dir, 'clip.mp4')
      const made = await new Promise((resolve) => {
        execFile(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
          '-i', 'testsrc=duration=2:size=320x240:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
          '-shortest', '-y', mp4], { timeout: 60_000 }, (error) => resolve(error === null))
      })
      if (!made) {
        console.log('SKIP ffmpeg 路（造样例失败）')
      } else {
        const raw = await toWav16k({ buffer: (await import('node:fs')).readFileSync(mp4), ext: 'mp4', ffmpegPath, tmpDir: dir })
        const check1 = inspectWav(raw)
        check('★★ mp4 音轨转出来必须过 inspectWav（data 必须在偏移 36）', check1.ok === true, check1.reason ?? '')
        check('★ 转出来是 16kHz 单声道 16bit', raw.readUInt32LE(24) === 16000 && raw.readUInt16LE(22) === 1 && raw.readUInt16LE(34) === 16)
        // 反向对照：故意把 LIST 块塞回去，证明这条校验真的看得见（不是恒真）
        const withList = Buffer.concat([
          raw.subarray(0, 36),
          Buffer.from('LIST'), Buffer.from([4, 0, 0, 0]), Buffer.from('INFO'),
          raw.subarray(36),
        ])
        withList.writeUInt32LE(withList.length - 8, 4)
        check('★★ 反向对照：多一个 LIST 块时 inspectWav 必须报错（证明这条闸有分辨力）',
          inspectWav(withList).ok === false, inspectWav(withList).reason ?? '')

        /**
         * `maxSeconds`：视频音轨只取开头 N 秒（2026-11-01）。
         *
         * 为什么必须测：一段 40 分钟的录屏整段转 WAV 是几十 MB、耗时几十秒，
         * 而我们要的只是"这视频在讲什么"。不加这个闸，`#showVideo` 会在
         * 用户发长视频时悄悄卡住很久 —— 而且**不报错**，只是慢。
         *
         * 验收口径用 data 块字节数（偏移 40），不是"看起来短了"：
         * 16k 单声道 16bit ⇒ 每秒 32000 字节，2 秒应当≈64000。
         */
        const long = join(dir, 'long.mp4')
        const madeLong = await new Promise((resolve) => {
          execFile(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
            '-i', 'testsrc=duration=6:size=160x120:rate=5', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
            '-shortest', '-y', long], { timeout: 60_000 }, (error) => resolve(error === null))
        })
        if (!madeLong) {
          console.log('SKIP maxSeconds 那条（造 6 秒样例失败）')
        } else {
          const bytes = (await import('node:fs')).readFileSync(long)
          const full = await toWav16k({ buffer: bytes, ext: 'mp4', ffmpegPath, tmpDir: dir })
          const cut = await toWav16k({ buffer: bytes, ext: 'mp4', ffmpegPath, tmpDir: dir, maxSeconds: 2 })
          const fullBytes = full.readUInt32LE(40)
          const cutBytes = cut.readUInt32LE(40)
          check('★★ maxSeconds=2 真的截断（data 块≈64000 字节，2 秒 × 32000）',
            cutBytes > 50_000 && cutBytes < 80_000, `cut=${cutBytes}`)
          // 对称性：不传就是整段，必须明显更长 —— 否则"截断"可能只是碰巧短
          check('★★ 不传 maxSeconds 时是整段（明显长于截断版，证明闸不是恒真）',
            fullBytes > cutBytes * 2, `full=${fullBytes} cut=${cutBytes}`)
          check(' 截断版仍过 inspectWav（截断不能破坏 WAV 规格）', inspectWav(cut).ok === true, inspectWav(cut).reason ?? '')
        }
      }
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

/**
 * 全片台词时间轴（2026-11-01 晚）。
 *
 * 这个纯函数的唯一职责是**别让台词和它的时间位置脱钩**：
 * 长视频只能在全片采样几小段，一旦时间戳错位，她会把第 14 分钟说的话当成开头说的 ——
 * 那种错听起来完全合理，比"没看到"更难发现。所以这几条钉的是位置和截断语义。
 */
{
  check('formatClock 0 秒 → 0:00', formatClock(0) === '0:00', formatClock(0))
  check('formatClock 65 秒 → 1:05（补零）', formatClock(65) === '1:05', formatClock(65))
  check('formatClock 超过 1 小时带小时位', formatClock(3661) === '1:01:01', formatClock(3661))
  check('formatClock 负数/NaN 归 0（不产生 -1:-1）', formatClock(-5) === '0:00' && formatClock(NaN) === '0:00')

  check('speechTimeline 空输入 → 空文本 0 段', speechTimeline([]).text === '' && speechTimeline([]).segments === 0)
  check('speechTimeline 全是空白 → 也算空', speechTimeline([{ at: 3, text: '   ' }]).segments === 0)

  const two = speechTimeline([{ at: 0, text: '开头' }, { at: 65, text: '中间' }])
  check('★ 每段带 [分:秒] 前缀（台词与位置不脱钩）',
    two.text === '[0:00] 开头\n[1:05] 中间', JSON.stringify(two.text))
  check('★ lastAt 取最后一段的位置（上层用它说"覆盖到第几分钟"）', two.lastAt === 65, String(two.lastAt))

  const shuffled = speechTimeline([{ at: 300, text: '后' }, { at: 10, text: '前' }])
  check('★ 乱序输入按时间排好（否则时间轴会倒着走）',
    shuffled.text === '[0:10] 前\n[5:00] 后', JSON.stringify(shuffled.text))

  /**
   * ★★★ 截断必须**按段均分**，不能砍尾巴。
   *
   * 砍尾巴的后果：她看到最后一段停在 8:50，会以为"视频就到这里"，
   * 而事实是 8:50 之后还有 7 分钟我们没给她。那是把"我们没覆盖"伪装成"内容结束"。
   * 均分之后时间轴仍然覆盖到片尾，只是每段说得短些 —— 这是唯一诚实的截法。
   */
  const long = [
    { at: 0, text: '甲'.repeat(100) },
    { at: 600, text: '乙'.repeat(100) },
  ]
  const capped = speechTimeline(long, { maxChars: 20 })
  const cappedLines = capped.text.split('\n')
  check('★★★ 超预算时两段都还在（不是砍掉后半条时间轴）', cappedLines.length === 2, `lines=${cappedLines.length}`)
  check('★★★ 且最后一段的时间戳仍是片尾位置（覆盖到 10:00）', capped.lastAt === 600, String(capped.lastAt))
  check('★★ 每段被压到预算的一半以内', cappedLines.every((l) => l.length <= 20), cappedLines.map((l) => l.length).join(','))
  check(' 截断被标出来（truncated=true，上层可据此说明）', capped.truncated === true)

  // 反向对照：不传 maxChars 就一点都不截 —— 证明上面那条截断闸不是恒真
  const uncapped = speechTimeline(long)
  check('★★ 反向对照：不传 maxChars 时不截断（证明截断闸有分辨力）',
    uncapped.truncated === false && uncapped.text.includes('甲'.repeat(100)), `len=${uncapped.text.length}`)
}

console.log(`\n${passed} passed, ${failed} failed`)
assert.equal(failed, 0)
