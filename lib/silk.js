/**
 * silk.js —— mp3 → SILK（QQ 语音的真实容器格式）
 *
 * 为什么需要这一层（2026-10-31 实机取证，不是推测）：
 *
 * QQ 的语音消息只认 SILK 编码。**旧版 QQ 会自动转**：给 mp3，它自己转成 silk 再发，
 * 缓存文件体积会明显缩小（实测 12240 → 4954、22608 → 10536），文件头是 `#!SILK_V3`。
 * **QQ 9.9.36 起不再自动转**：它把 mp3 原样放进 `nt_data/Ptt/<月>/Ori/<md5>.mp3`
 * （体积不变），然后在组装消息时崩在 NTQQ 内部，返回
 * `retcode 1400 · Cannot convert undefined or null to object` —— 这个错误信息完全看不出
 * "格式不对"，所以只能靠对比缓存文件头才能定位。
 *
 * 实测对照（同一段 3.19 秒语音）：
 *   · mp3  19152 字节 → 发送失败（缓存里就是 mp3，体积不变）
 *   · silk 10601 字节 → 文件头 `\x02#!SILK_V3`，与 QQ 自己缓存的语音同格式
 *
 * 为什么用 silk-wasm 而不是 ffmpeg：ffmpeg **不能编码 silk**（只能解码/转 amr），
 * 所以这一步绕不开一个 silk 编码器。silk-wasm 是纯 WASM，无原生编译依赖，105ms 转完
 * 一条 3 秒语音。
 *
 * 为什么是**可选**依赖：老版本 QQ / 部分 NapCat 版本仍然收 mp3 并自己转。
 * 装不上 silk-wasm 时这里返回 null，调用方照旧发 mp3 —— 也就是回到改动前的行为，
 * 不会因为缺一个包就让她彻底不能发语音。
 */

import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'

/** SILK 文件的前 9 个字节（第 10 位是 `\x1b` 之类，不参与判断）。 */
export const SILK_MAGIC = '#!SILK_V3'

/** QQ 语音的采样率：QQ 自己缓存的 silk 都是 24000Hz 单声道。 */
export const SILK_SAMPLE_RATE = 24000

/**
 * 这个文件是不是 SILK（用来在测试和排查时判定"到底转没转成功"）。
 * @param {Buffer|Uint8Array} data
 */
export function looksLikeSilk(data) {
  if (!data || data.length < 10) return false
  // 前 1 字节是帧头标记（实测 0x02），从第 2 字节开始是 ASCII magic。
  return Buffer.from(data.slice(1, 10)).toString('latin1') === SILK_MAGIC
}

let encoderPromise = null

/**
 * 懒加载 silk-wasm（可选依赖）。
 *
 * 不用顶层 import：装了才加载，没装时整个模块照样能被 import —— 否则 `import 'silk-wasm'`
 * 失败会让**整个 bridge 起不来**，那是比"发不出语音"严重得多的故障。
 *
 * @returns {Promise<((data: Uint8Array, sampleRate: number) => Promise<{data: Uint8Array, duration: number}>) | null>}
 */
async function loadEncoder() {
  if (encoderPromise === null) {
    encoderPromise = (async () => {
      try {
        const mod = await import('silk-wasm')
        // CJS 包经 dynamic import 后，命名导出可能挂在 default 上，两种都接。
        const encode = mod?.encode ?? mod?.default?.encode
        return typeof encode === 'function' ? encode : null
      } catch {
        return null
      }
    })()
  }
  return encoderPromise
}

/** silk-wasm 装没装（面板/诊断用，不去真的转一次）。 */
export async function silkEncoderAvailable() {
  return (await loadEncoder()) !== null
}

function runFfmpeg(ffmpegPath, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { timeout: timeoutMs }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`${error.message}${stderr ? `：${String(stderr).slice(-200)}` : ''}`))
      else resolve()
    })
  })
}

/**
 * 把 mp3 转成 silk。**失败返回 null，不抛错** —— 调用方（发语音）要能照旧降级发 mp3。
 *
 * @param {string} mp3File 源文件（TTS 刚写出来的 mp3）
 * @param {{ ffmpegPath?: string, timeoutMs?: number }} options
 * @returns {Promise<{file: string, bytes: number, durationMs: number} | null>}
 */
export async function toSilk(mp3File, { ffmpegPath = 'ffmpeg', timeoutMs = 60_000 } = {}) {
  const encode = await loadEncoder()
  if (encode === null) return null
  if (!existsSync(mp3File)) return null

  // ffmpeg 只负责 mp3 → 单声道 24k WAV（silk-wasm 接受 WAV，也接受裸 pcm_s16le）。
  const wav = mp3File.replace(/\.mp3$/i, '') + '.silk-src.wav'
  const out = mp3File.replace(/\.mp3$/i, '') + '.silk'
  try {
    await runFfmpeg(ffmpegPath, [
      '-y', '-i', mp3File,
      '-ar', String(SILK_SAMPLE_RATE), '-ac', '1', '-f', 'wav', wav,
    ], timeoutMs)
    const { data, duration } = await encode(readFileSync(wav), 0)
    const silk = Buffer.from(data)
    if (!looksLikeSilk(silk)) throw new Error('编码结果不是 SILK（文件头不符）')
    writeFileSync(out, silk)
    return { file: out, bytes: silk.length, durationMs: Number(duration) || 0 }
  } catch {
    return null
  } finally {
    // 中间 WAV 不留：它是纯临时产物，留在 qq-tts/ 里只会越攒越多。
    try { unlinkSync(wav) } catch { /* 没生成就算了 */ }
  }
}
