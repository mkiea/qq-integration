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

let decoderPromise = null

/** 懒加载 silk-wasm 的 decode（与 encode 同一份 WASM，但分开缓存，谁没装都不互相拖累）。 */
async function loadDecoder() {
  if (decoderPromise === null) {
    decoderPromise = (async () => {
      try {
        const mod = await import('silk-wasm')
        const decode = mod?.decode ?? mod?.default?.decode
        return typeof decode === 'function' ? decode : null
      } catch {
        return null
      }
    })()
  }
  return decoderPromise
}

/** SILK 解码器装没装（面板/诊断用）。 */
export async function silkDecoderAvailable() {
  return (await loadDecoder()) !== null
}

/**
 * 「这是不是一段 SILK」的**宽容**判定：**带不带 0x02 首字节都算**。
 *
 * 与 `looksLikeSilk` 的分工必须说清楚，否则会写出死锁：
 *   · `looksLikeSilk` = **严格**（只认 `\x02#!SILK_V3`，即 QQ 与 silk-wasm encode 的形状），
 *     既有代码（编码后的自检、voice-silk 单测）依赖它的语义，不能改；
 *   · 本函数 = **宽容**，用于"要不要走 SILK 解码分支"这个决策。
 *
 * 为什么需要宽容版：`normalizeSilk` 会给裸 `#!SILK_V3` 补上 0x02，但如果先用严格版判定，
 * 裸文件在进入 `decodeSilk` 之前就被判成"不是 SILK"了 —— 补前缀的代码**永远轮不到执行**。
 * （2026-11-01 写测试时发现的，属于"修一层补出来的死锁"。）
 *
 * @param {Buffer|Uint8Array} data
 */
export function isSilkBuffer(data) {
  if (!data || data.length < 10) return false
  if (looksLikeSilk(data)) return true
  return Buffer.from(data.slice(0, 9)).toString('latin1') === SILK_MAGIC
}

/**
 * 把缓冲整理成 decode 期望的形状：**首字节必须是 0x02/0x03 帧头**。
 *
 * QQ 缓存的就是 `\x02#!SILK_V3…`；万一遇到不带首字节的裸 `#!SILK_V3`，补一个 0x02
 * （silk-wasm 的 encode 产物正是这个形状，decode 也只认这个形状）。
 */
export function normalizeSilk(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 10) return buffer
  if (buffer[0] === 0x02 || buffer[0] === 0x03) return buffer
  if (buffer.toString('latin1', 0, 9) === SILK_MAGIC) {
    return Buffer.concat([Buffer.from([0x02]), buffer])
  }
  return buffer
}

/**
 * SILK → 16 kHz 单声道 PCM16（裸字节，没有容器头）。
 *
 * ★ 2026-11-01 实机取证（14 个真实样本逐个跑，不是查文档得出的）：
 *
 * ① **必须保留首字节**。QQ 缓存的文件是 `\x02#!SILK_V3…`。按「QQ 多塞了一个字节、
 *    要剥掉」的通行说法（dsh-voice-transcribe / pilk 那条路）做，剥掉后 **14/14 全部**
 *    报 `silk decoding failure`；保留首字节则 **14/14 成功**。
 *    原因：silk-wasm 自己的 `encode` 产物也以 `\x02` 开头，它的 `decode` 与之对称。
 *    ⇒ 「要不要剥」取决于解码器，不是取决于文件。
 *
 * ② **文件名完全不可信**。14 个样本里 12 个叫 `.amr`、2 个叫 `.silk`、4 个连扩展名都没有，
 *    内容**全是** SILK。所以只按 magic 判定，不看扩展名。
 *
 * ③ **decode 自带重采样**。传 16000 就直接输出 16 kHz（实测 1 秒语音：
 *    24000→46080 字节、16000→30720 字节，比值正好 1.5）。
 *    这一条把整条链路从「需要 ffmpeg、且 ffmpeg 得能解 silk」降成「只需要 WASM」——
 *    而本机那份 ffmpeg **恰恰没有** silk 解码器（`-decoders | grep silk` 为空，
 *    直接转报 `Invalid data found when processing input`）。
 *
 * @param {Buffer|Uint8Array} buffer SILK 原始字节
 * @param {{ sampleRate?: number }} [options]
 * @returns {Promise<Buffer>} 指定采样率的单声道 PCM16 裸数据
 */
export async function decodeSilk(buffer, { sampleRate = 16000 } = {}) {
  const decode = await loadDecoder()
  if (decode === null) {
    throw new Error('没有装上 SILK 解码器（可选依赖 silk-wasm 缺失）：装回去才能听语音')
  }
  if (!isSilkBuffer(buffer)) throw new Error('不是 SILK（文件头不是 #!SILK_V3）')
  const { data } = await decode(new Uint8Array(normalizeSilk(buffer)), sampleRate)
  const pcm = Buffer.from(data)
  if (pcm.length === 0) throw new Error('SILK 解出来是空的（录音太短或文件损坏）')
  return pcm
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
