/**
 * 语音转文字：走 **DSH 自带的**语音服务（本地 SenseVoice），不把音频发到任何云端。
 *
 * DSH 0.2.0-rc.2 的实验性「语音输入」bundle 提供宿主服务 `speechToText`：
 *   resolve({ audio, language, providerId? }) -> spec
 *   transcribe(spec, signal) -> { text, audioSeconds, inferenceSeconds }
 * 其中 audio 必须是 **16 kHz 单声道 PCM16 WAV**（平台用 validateWave 校验），所以我们统一用 ffmpeg 转一道，
 * 不赌 QQ/NapCat 给的格式（silk / amr / 任意采样率的 wav 都见过）。
 *
 * 这个文件不碰全局状态、不自己 spawn 进程（ffmpeg 调用通过 `run` 注入），所以单测可以直接喂假数据。
 */
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeSilk as silkDecode, isSilkBuffer } from './silk.js'

/** DSH 语音服务在宿主里的服务名（cordis service id）。 */
export const DSH_SPEECH_SERVICE = 'speechToText'

/** 这个功能的默认语言：auto = 让 SenseVoice 自己判（中英混说也稳）。 */
export const DEFAULT_STT_LANGUAGE = 'auto'

/**
 * 秒数 → `m:ss` / `h:mm:ss`（时间轴前缀用，2026-11-01）。
 * @param {number} seconds
 * @returns {string}
 */
export function formatClock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/**
 * 把「几段带时间点的转写」拼成一条**时间轴**（2026-11-01）。
 *
 * 存在的理由：长视频没法整段转写（音轨 15.9MB / 单次 4MiB 上限），只能在全片采几小段。
 * 采样之后每段必须**带上它在片中的位置**，否则她会把第 14 分钟说的话当成开头说的 ——
 * 这种错比"没看到"更糟，因为它听起来完全合理。
 *
 * ★ 超预算时**按段均分字数**，不砍尾巴。
 * 砍尾巴会让她以为"视频就到这里"，而事实是我们没说后面。统一截到每段
 * `maxChars / 段数` 个字符，时间轴仍然覆盖全片，只是每段说得短些 ——
 * 这是唯一不会把"覆盖不足"伪装成"内容结束"的截法。
 *
 * @param {{at: number, text: string}[]} parts
 * @param {{ maxChars?: number }} [options] 0/不传 = 不截
 * @returns {{ text: string, segments: number, lastAt: number, truncated: boolean }}
 */
export function speechTimeline(parts, { maxChars = 0 } = {}) {
  const items = (Array.isArray(parts) ? parts : [])
    .map((p) => ({
      at: Math.max(0, Number(p?.at) || 0),
      text: String(p?.text ?? '').replace(/\s+/g, ' ').trim(),
    }))
    .filter((p) => p.text !== '')
    .sort((a, b) => a.at - b.at)
  if (items.length === 0) return { text: '', segments: 0, lastAt: 0, truncated: false }

  const budget = Number(maxChars) > 0 ? Math.floor(Number(maxChars) / items.length) : 0
  let truncated = false
  const lines = items.map((p) => {
    let body = p.text
    if (budget > 0 && body.length > budget) {
      truncated = true
      body = `${body.slice(0, Math.max(1, budget - 1))}…`
    }
    return `[${formatClock(p.at)}] ${body}`
  })
  return {
    text: lines.join('\n'),
    segments: lines.length,
    lastAt: items[items.length - 1].at,
    truncated,
  }
}

/**
 * 检查一段字节是不是"16 kHz 单声道 PCM16 WAV"——DSH 那边会用同一个标准校验，
 * 我们在本地先看一眼，能给出比"provider 报错"更好懂的原因。
 * @param {Buffer} buffer
 * @returns {{ ok: boolean, reason?: string, sampleRate?: number, channels?: number, bits?: number }}
 */
export function inspectWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 46) return { ok: false, reason: '音频太短，不像是完整录音' }
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return { ok: false, reason: '不是 WAV（没找到 RIFF/WAVE 头）' }
  }
  // 下面逐条对齐平台的 validateWave：它是**严格**检查（不做块遍历），
  // 所以这里也必须严格，否则会出现"本地过了、平台抛 Invalid speech WAV"（2026-10-04 真机事故）。
  if (buffer.toString('ascii', 12, 16) !== 'fmt ') return { ok: false, reason: 'WAV 头不规范：fmt 块不在偏移 12' }
  if (buffer.readUInt32LE(16) !== 16) return { ok: false, reason: 'WAV 头不规范：fmt 块长度不是 16' }
  if (buffer.readUInt16LE(20) !== 1) return { ok: false, reason: 'WAV 不是 PCM 编码' }
  const channels = buffer.readUInt16LE(22)
  if (channels !== 1) return { ok: false, reason: `声道数 ${channels}，需要单声道`, channels }
  const sampleRate = buffer.readUInt32LE(24)
  if (sampleRate !== 16000) return { ok: false, reason: `采样率 ${sampleRate}，需要 16000`, sampleRate }
  if (buffer.readUInt32LE(28) !== 32000) return { ok: false, reason: 'WAV 字节率不是 32000（16kHz×单声道×16 位）' }
  if (buffer.readUInt16LE(32) !== 2) return { ok: false, reason: 'WAV 块对齐不是 2' }
  const bits = buffer.readUInt16LE(34)
  if (bits !== 16) return { ok: false, reason: `位深 ${bits}，需要 16 位`, bits }
  if (buffer.toString('ascii', 36, 40) !== 'data') {
    return { ok: false, reason: 'WAV 的 data 块不在偏移 36（多半多了元数据块，例如 ffmpeg 默认写的 LIST）' }
  }
  if (buffer.readUInt32LE(4) !== buffer.length - 8) return { ok: false, reason: 'WAV 的 RIFF 长度与文件长度不一致' }
  if (buffer.readUInt32LE(40) !== buffer.length - 44) return { ok: false, reason: 'WAV 的 data 长度与文件长度不一致' }
  if ((buffer.length - 44) % 2 !== 0) return { ok: false, reason: 'WAV 的音频数据长度是奇数' }
  return { ok: true, channels, sampleRate, bits }
}

/**
 * 把任意 WAV 重写成**规范形态**：44 字节头 + 音频数据（`fmt ` 在 12、`data` 必须在 36）。
 *
 * 为什么自己来做：ffmpeg 默认会写 `LIST/INFO` 元数据块，`data` 的偏移就不是 36，
 * 平台的校验会直接抛 `Invalid speech WAV`。不管 ffmpeg 怎么写，这里都只抽 fmt + data 并按规范重建。
 * @param {Buffer} buffer
 * @returns {Buffer}
 */
export function canonicalizeWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) throw new Error('音频太短，不像是完整录音')
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV（没找到 RIFF/WAVE 头）')
  }
  let fmt = null
  let data = null
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = buffer.subarray(offset + 8, Math.min(buffer.length, offset + 8 + size))
    if (id === 'fmt ') fmt = body
    else if (id === 'data') data = body
    offset += 8 + size + (size % 2)
  }
  if (!fmt) throw new Error('WAV 里没有 fmt 块')
  if (!data || data.length === 0) throw new Error('WAV 里没有音频数据（data 块是空的）')
  if (fmt.length < 16) throw new Error('WAV 的 fmt 块不完整')
  if (fmt.readUInt16LE(0) !== 1) throw new Error('WAV 不是 PCM 编码，转写只接受 PCM16')
  const channels = fmt.readUInt16LE(2)
  const sampleRate = fmt.readUInt32LE(4)
  const bits = fmt.readUInt16LE(14)
  if (channels !== 1 || sampleRate !== 16000 || bits !== 16) {
    throw new Error(`WAV 规格不对（声道 ${channels} / 采样率 ${sampleRate} / 位深 ${bits}），需要 16kHz 单声道 16 位`)
  }
  // 平台要求音频数据长度为偶数；多出半个字节就截掉。
  const pcm = data.length % 2 === 0 ? data : data.subarray(0, data.length - 1)
  const out = Buffer.alloc(44 + pcm.length)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + pcm.length, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(16000, 24)
  out.writeUInt32LE(32000, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(pcm.length, 40)
  pcm.copy(out, 44)
  return out
}

/** 默认的 ffmpeg 执行器（可注入，方便单测）。 */
function runFfmpeg(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error) => (error ? reject(error) : resolve()))
  })
}

/**
 * 裸 PCM16 → 规范的 44 字节 WAV 容器。
 *
 * 之所以自己拼头而不用 ffmpeg：SILK 那条路（见下）解出来就是 16 kHz 单声道 PCM16，
 * 直接封头即可 —— 少一次进程调用，也少一个「ffmpeg 不可用就听不见」的失败点。
 *
 * @param {Buffer} pcm
 * @param {{ sampleRate?: number, channels?: number, bits?: number }} [options]
 * @returns {Buffer}
 */
export function pcmToWav(pcm, { sampleRate = 16000, channels = 1, bits = 16 } = {}) {
  if (!Buffer.isBuffer(pcm) || pcm.length === 0) throw new Error('PCM 数据是空的')
  const blockAlign = (channels * bits) / 8
  // 半字节尾巴会让平台判 "音频数据长度是奇数"，这里先截齐。
  const body = pcm.length % blockAlign === 0 ? pcm : pcm.subarray(0, pcm.length - (pcm.length % blockAlign))
  const out = Buffer.alloc(44 + body.length)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + body.length, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(channels, 22)
  out.writeUInt32LE(sampleRate, 24)
  out.writeUInt32LE(sampleRate * blockAlign, 28)
  out.writeUInt16LE(blockAlign, 32)
  out.writeUInt16LE(bits, 34)
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(body.length, 40)
  body.copy(out, 44)
  return out
}

/**
 * 把任意音频转成 16 kHz 单声道 PCM16 WAV。
 *
 * ★ 2026-11-01：**SILK 走自己的路，不过 ffmpeg**。
 *
 * 起因是"她听不见语音"这件事查到底，发现是两个独立的坑叠在一起：
 *   ① QQ 语音文件名叫 `.amr`，内容是 SILK（`\x02#!SILK_V3`）；
 *   ② 本机 ffmpeg **没有** silk 解码器（`-decoders | grep silk` 为空），
 *      对上面那种文件直接报 `Invalid data found when processing input`。
 * 所以只要还让 ffmpeg 去解，这条路就永远走不通 —— 换成 `silk-wasm` 的 decode，
 * 它还能顺带把 24 kHz 重采样成 16 kHz，一次到位。
 *
 * ffmpeg 仍然负责**其他**格式（mp3/wav/ogg/真 amr…），行为与以前完全一致。
 *
 * @param {object} options
 * @param {Buffer} options.buffer 原始音频
 * @param {string} [options.ext] 原始扩展名（决定临时文件名，ffmpeg 主要靠内容嗅探）
 * @param {string} [options.ffmpegPath]
 * @param {string} options.tmpDir 临时文件目录（必须已存在或可创建）
 * @param {number} [options.maxSeconds] 只取开头这么多秒（0/不传=整段）。
 *   给**视频音轨**用：一段 40 分钟的录屏整段转成 WAV 是 ~75 MB，
 *   而我们要的只是"这视频在讲什么"——取开头一分钟就够，且能把耗时压在秒级。
 *   它是**输出侧**选项（`-t`），和 `-map_metadata` 一样放在 `-i` 之后。
 * @param {Function} [options.run] 执行器（默认 execFile 的 Promise 包装）
 * @param {Function} [options.decodeSilk] SILK 解码器（默认 silk-wasm，可注入）
 * @returns {Promise<Buffer>}
 */
export async function toWav16k({ buffer, ext = 'amr', ffmpegPath = 'ffmpeg', tmpDir, maxSeconds = 0, run = runFfmpeg, decodeSilk = silkDecode }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('语音内容是空的，没法转写')

  // —— SILK 分支：按内容判定，不看扩展名（14 个真实样本全是 SILK，扩展名五花八门）——
  if (isSilkBuffer(buffer)) {
    let pcm
    try {
      pcm = await decodeSilk(buffer, { sampleRate: 16000 })
    } catch (error) {
      throw new Error(`SILK 解码失败：${String(error?.message ?? error).slice(0, 90)}`)
    }
    // 语音消息都是几秒到几十秒，没有截断需求；SILK 分支不支持 maxSeconds 是**有意的**
    // （语音消息整段就是全部内容，截了反而是丢话）。
    const wav = pcmToWav(pcm, { sampleRate: 16000, channels: 1, bits: 16 })
    const check = inspectWav(wav)
    if (!check.ok) throw new Error(`SILK 解出来的音频不符合要求：${check.reason}`)
    return wav
  }

  mkdirSync(tmpDir, { recursive: true })
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const input = join(tmpDir, `stt-${stamp}.${String(ext || 'amr').replace(/[^a-z0-9]/gi, '') || 'amr'}`)
  const output = join(tmpDir, `stt-${stamp}.wav`)
  writeFileSync(input, buffer)
  try {
    // 关键：`-map_metadata -1` 与 `-fflags +bitexact` 都是**输出侧**选项，必须放在 `-i` 之后！
    // （2026-10-04 真机事故：我一开始放在 -i 前，ffmpeg 直接 Command failed —— 输入选项里没有它们。）
    // 作用是别让 ffmpeg 写 LIST/INFO 元数据块（那会让 data 偏移不是 36，平台判 Invalid speech WAV）；
    // 即便它还是写了，下面 canonicalizeWav 也会兜住。
    await run(ffmpegPath, ['-y', '-i', input,
      '-map_metadata', '-1', '-fflags', '+bitexact',
      ...(Number(maxSeconds) > 0 ? ['-t', String(Math.max(1, Math.floor(Number(maxSeconds))))] : []),
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', output], { timeout: 60_000 })
    // 规范化失败（例如 ffmpeg 产物规格不对）也要用同一个前缀报出来，调用方/测试看的是这句。
    let wav
    try {
      wav = canonicalizeWav(readFileSync(output))
    } catch (error) {
      throw new Error(`转出来的音频不符合要求：${String(error?.message ?? error)}`)
    }
    const check = inspectWav(wav)
    if (!check.ok) throw new Error(`转出来的音频不符合要求：${check.reason}`)
    return wav
  } catch (error) {
    if (String(error?.message ?? '').includes('不符合要求')) throw error
    throw new Error(`ffmpeg 转 16kHz WAV 失败：${String(error?.message ?? error).slice(0, 90)}`)
  } finally {
    try { unlinkSync(input) } catch { /* best effort */ }
    try { unlinkSync(output) } catch { /* best effort */ }
  }
}

/**
 * 确保本地识别 provider 已经准备好（模型在本地、worker 已热）。
 *
 * 为什么必须有这一步（2026-10-29 实测）：宿主里**没有任何东西**会替我们准备 ——
 * `api-speech-to-text` 得有人手动调 /speech/prepare，
 * `client-ui-voice-input` 得有人点麦克风按钮。我们刻意不装那两个（QQ 桥用不上），
 * 于是第一次发语音时 provider 还停在 'unprepared'，
 * transcribe 直接抛 "Prepare the local speech provider before recording"。
 *
 * 所以这里把「准备」变成隐式的：没准备好就准备，等好了再转写。
 * 首次准备会下载约 239MB 模型（int8），慢是正常的 —— 超时给到 1 小时
 * （sensevoice 插件自己的 prepareTimeoutMs 默认也是 36e5 = 1 小时）。
 *
 * @param {object} options
 * @param {object|undefined} options.service 宿主服务（`ctx.get('speechToText')`）
 * @param {AbortSignal} [options.signal] 外部取消
 * @param {number} [options.timeoutMs] 准备阶段的独立超时（转写本身另有 120 秒）
 * @param {Function} [options.onProgress] 进度回调（收到 preparation 状态快照）
 * @returns {Promise<void>} 解析完成即表示 provider 已就绪
 */
export async function ensurePrepared(service, { signal, timeoutMs = 60 * 60_000, onProgress } = {}) {
  if (!service || typeof service.snapshot !== 'function' || typeof service.prepare !== 'function') {
    throw new Error('DSH 的语音转文字没启用：宿主里找不到 speechToText 服务（检查 profile 是否装了 speech-to-text 与 speech-to-text-sensevoice）')
  }
  let providerId = ''
  try {
    providerId = String(service.snapshot()?.selection?.providerId ?? '')
  } catch (error) {
    throw new Error(`读语音服务状态失败：${String(error?.message ?? error).slice(0, 80)}`)
  }
  if (providerId === '') throw new Error('语音服务没有选中的识别提供方（defaultProvider 没配？）')

  const ready = (snap) => {
    const provider = (snap?.providers ?? []).find((p) => p.id === providerId)
    return provider?.preparation ?? null
  }
  const isUsable = (phase) => phase === 'ready' || phase === 'standby'

  // 已经就绪就不用等（绝大多数时候走这条路）。
  const current = ready(service.snapshot())
  if (isUsable(current?.phase)) return

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('语音模型准备超时')), timeoutMs)
  const watcher = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  try {
    // prepare 是「开始或加入」语义（幂等），重复调不会重复下载。
    service.prepare(providerId, {})
    for await (const snap of service.follow(watcher)) {
      const state = ready(snap)
      const phase = state?.phase
      if (onProgress) { try { onProgress(state) } catch { /* 进度回调不该影响主流程 */ } }
      if (isUsable(phase)) return
      if (phase === 'failed') {
        throw new Error(`准备语音模型失败：${String(state?.message ?? '未知原因').slice(0, 120)}`)
      }
      if (phase === 'cancelled') throw new Error('语音模型准备被取消')
    }
    throw new Error('语音模型准备超时')
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

/**
 * 用 DSH 自带的语音服务转写。
 * @param {object} options
 * @param {object|undefined} options.service 宿主服务（`ctx.get('speechToText')`）
 * @param {Buffer} options.wav 16 kHz 单声道 PCM16 WAV
 * @param {string} [options.language]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string>} 转写文本
 */
export async function transcribeViaDsh({ service, wav, language = DEFAULT_STT_LANGUAGE, signal }) {
  if (!service || typeof service.resolve !== 'function' || typeof service.transcribe !== 'function') {
    throw new Error('DSH 的语音转文字没启用：请把 @deepseek-ai/dsh-experimental-speech-to-text 与 @deepseek-ai/dsh-experimental-speech-to-text-sensevoice 加进 profile 并重启')
  }
  const check = inspectWav(wav)
  if (!check.ok) throw new Error(`音频不符合 DSH 语音服务的要求：${check.reason}`)
  // 先准备再转写：没有这一步，provider 停在 unprepared 时 transcribe 会直接抛
  // "Prepare the local speech provider before recording"（2026-10-29 实测）。
  await ensurePrepared(service, { signal })
  const spec = service.resolve({ audio: new Uint8Array(wav), language })
  const transcript = await service.transcribe(spec, signal ?? AbortSignal.timeout(120_000))
  const text = String(transcript?.text ?? '').trim()
  if (text === '') throw new Error('DSH 语音服务返回了空文本（可能是录音太短或没人说话）')
  return text
}

/** 把 DSH 语音服务的异常翻译成用户看得懂的中文原因。 */
export function explainDshError(error) {
  const message = String(error?.message ?? error)
  // 我们自己抛的中文原因已经能直接给人看了，别再套一层模板（否则会出现
  // "首次使用要下载本地语音模型：准备语音模型失败：…" 这种叠套）。
  if (/[一-龥]/.test(message)) return message.slice(0, 140)
  if (/download|prepare|preparation|model/i.test(message)) {
    return `首次使用要下载本地语音模型：${message.slice(0, 80)}`
  }
  if (/unavailable|not registered|unknown provider/i.test(message)) {
    return `DSH 里没有可用的本地识别提供方（检查 profile 是否装了 speech-to-text-sensevoice）：${message.slice(0, 60)}`
  }
  if (/language/i.test(message)) return `这个语言 DSH 的本地识别不支持：${message.slice(0, 60)}`
  return `DSH 语音转文字失败：${message.slice(0, 90)}`
}
