/**
 * TTS synthesis: Azure Speech (SSML), any OpenAI-compatible /audio/speech endpoint,
 * or a local GPT-SoVITS api_v2 server (zero-shot voice cloning).
 * Returns { audio: Buffer, format: 'mp3' | 'wav' }.
 *
 * 2026-11-04 加了「唱歌」：不是真正的歌声合成（Azure 没有 singing 风格），
 * 而是把歌词切成一句一个 `<s>`、每句套不同的 pitch/rate —— **一次合成、不拼音频**。
 * 为什么不做多段拼接：mp3 每段都有自己的头，直接 concat 很多播放器只播第一段。
 */

/**
 * 常用中文音色（Azure）。不是全表 —— Azure 有几百个，全列出来没法选。
 * 挑的是听感差异明显的；`!音色 <完整名字>` 仍然可以直接填表外的。
 */
export const VOICE_CATALOG = [
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', tag: '女 · 温暖自然（默认）' },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊', tag: '女 · 活泼年轻' },
  { id: 'zh-CN-XiaochenNeural', name: '晓辰', tag: '女 · 随性闲聊' },
  { id: 'zh-CN-XiaohanNeural', name: '晓涵', tag: '女 · 温柔沉稳' },
  { id: 'zh-CN-XiaomengNeural', name: '晓梦', tag: '女 · 俏皮' },
  { id: 'zh-CN-XiaomoNeural', name: '晓墨', tag: '女 · 成熟' },
  { id: 'zh-CN-XiaoruiNeural', name: '晓睿', tag: '女 · 清冷' },
  { id: 'zh-CN-XiaoshuangNeural', name: '晓双', tag: '女童 · 童声' },
  { id: 'zh-CN-YunxiNeural', name: '云希', tag: '男 · 阳光少年' },
  { id: 'zh-CN-YunyangNeural', name: '云扬', tag: '男 · 新闻播报' },
  { id: 'zh-CN-YunjianNeural', name: '云健', tag: '男 · 沉稳解说' },
  { id: 'zh-CN-YunxiaNeural', name: '云夏', tag: '男童 · 童声' },
]

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function buildAzureSsml(text, voice, style) {
  const styleAttr = style ? ` style="${escapeXml(style)}"` : ''
  return `<speak version="1.0" xml:lang="zh-CN"><voice name="${escapeXml(voice)}"${styleAttr}>${escapeXml(text)}</voice></speak>`
}

/**
 * 把歌词切成"一句一行"。
 *
 * 先按换行切，再按中英文句读切；丢掉空句；单句超过 40 字硬切一次
 * （Azure 对超长 `<s>` 的韵律处理反而更平，切短了起伏才明显）。
 * 上限 60 句：再长就是拿 TTS 当播放器了，请求体也会很大。
 */
export function splitLyricLines(lyrics, { maxLines = 60, maxCharsPerLine = 40 } = {}) {
  const raw = String(lyrics ?? '')
  const chunks = []
  for (const para of raw.split(/\r?\n/)) {
    for (const piece of para.split(/[，。！？；、,.!?;]+/)) {
      let text = piece.trim()
      if (text === '') continue
      while (text.length > maxCharsPerLine) {
        chunks.push(text.slice(0, maxCharsPerLine))
        text = text.slice(maxCharsPerLine)
      }
      if (text !== '') chunks.push(text)
      if (chunks.length >= maxLines) return chunks.slice(0, maxLines)
    }
  }
  return chunks.slice(0, maxLines)
}

/**
 * 唱腔 SSML。
 *
 * 旋律用 pitch 百分比循环 —— 不是真正的歌，但比平读有明显起伏；
 * `rate="-8%"` 让每句慢一点，不然串起来太赶。句间不加 `<break>`：
 * Azure 的 `<s>` 自带停顿，硬加会拖。
 */
export function buildSongSsml(lyrics, voice, style) {
  const lines = splitLyricLines(lyrics)
  if (lines.length === 0) throw new Error('歌词是空的')
  const melody = ['+0%', '+6%', '+12%', '+6%', '+19%', '+12%']
  const body = lines
    .map((text, index) => {
      const pitch = melody[index % melody.length]
      return `<s><prosody pitch="${pitch}" rate="-8%">${escapeXml(text)}</prosody></s>`
    })
    .join('')
  const styleAttr = style ? ` style="${escapeXml(style)}"` : ''
  return `<speak version="1.0" xml:lang="zh-CN"><voice name="${escapeXml(voice)}"${styleAttr}>${body}</voice></speak>`
}

/** Build the JSON body for a GPT-SoVITS api_v2 POST /tts request (pure, testable). */
export function buildLocalTtsRequest(config, text) {
  return {
    text,
    text_lang: config.ttsLocalTextLang || 'zh',
    ref_audio_path: config.ttsLocalRefAudio || '',
    prompt_text: config.ttsLocalPromptText || '',
    prompt_lang: config.ttsLocalPromptLang || 'zh',
    media_type: 'wav',
    streaming_mode: 0,
  }
}

/** Azure SSML 合成的公共部分（语音/唱歌只差 SSML）。 */
async function synthesizeAzure(config, ssml) {
  const region = config.ttsAzureRegion || 'eastasia'
  const response = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': config.ttsApiKey,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'dsh-qq-onebot-bridge',
    },
    body: ssml,
    signal: AbortSignal.timeout(60000),
  })
  if (!response.ok) throw new Error(`Azure TTS HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 120)}`)
  { const audio = Buffer.from(await response.arrayBuffer()); assertAudio(audio, 'mp3', 'Azure TTS'); return { audio, format: 'mp3' } }
}

export async function synthesizeTts(config, text, { voice = '' } = {}) {
  if (config.ttsProvider === 'openai') {
    const base = String(config.ttsBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
    assertTtsHost(base, config, 'OpenAI 兼容 TTS')
    const response = await fetch(`${base}/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.ttsApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: config.ttsModel || 'tts-1', voice: voice || config.ttsVoice || 'alloy', input: text }),
      signal: AbortSignal.timeout(60000),
    })
    if (!response.ok) throw new Error(`TTS HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 120)}`)
    { const audio = Buffer.from(await response.arrayBuffer()); assertAudio(audio, 'mp3', 'OpenAI 兼容 TTS'); return { audio, format: 'mp3' } }
  }
  if (config.ttsProvider === 'local') {
    // Local GPT-SoVITS api_v2: POST /tts returns raw wav bytes (or a JSON error).
    const base = String(config.ttsLocalUrl || 'http://127.0.0.1:9880').replace(/\/+$/, '')
    assertTtsHost(base, config, '本地 GPT-SoVITS')
    const response = await fetch(`${base}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildLocalTtsRequest(config, text)),
      signal: AbortSignal.timeout(120000),
    })
    if (!response.ok) {
      let detail = ''
      try { detail = (await response.json()).message ?? '' } catch { detail = await response.text().catch(() => '') }
      throw new Error(`本地 TTS HTTP ${response.status}: ${String(detail).slice(0, 120)}`)
    }
    { const audio = Buffer.from(await response.arrayBuffer()); assertAudio(audio, 'wav', '本地 GPT-SoVITS'); return { audio, format: 'wav' } }
  }
  // Azure Speech REST (SSML)
  const chosen = voice || config.ttsVoice || 'zh-CN-XiaoxiaoNeural'
  return synthesizeAzure(config, buildAzureSsml(text, chosen, config.ttsStyle || ''))
}

/**
 * TTS 出网白名单（V⑥ 修复，2026-11-04）。
 *
 * 判据：loopback 永远放行；其余 host 必须在 `ttsAllowedHosts` 里（支持 `*.example.com` 通配）。
 * 抛错信息里带 host，但不带完整 URL（URL 里可能已经有密钥）。
 */
function assertTtsHost(rawUrl, config, where) {
  let url
  try { url = new URL(rawUrl) } catch { throw new Error(`${where}：ttsBaseUrl 不是合法 URL`) }
  const host = url.hostname.toLowerCase()
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]' || host.endsWith('.localhost')
  if (loopback) return
  const allow = (Array.isArray(config.ttsAllowedHosts) ? config.ttsAllowedHosts : []).map((s) => String(s).toLowerCase().trim()).filter(Boolean)
  const hit = allow.some((rule) => rule === host
    || (rule.startsWith('*.') && host.endsWith(rule.slice(1)))
    || host.endsWith('.' + rule))
  if (!hit) {
    throw new Error(`${where}：拒绝访问 ${host} —— 不在 TTS 出网白名单 ttsAllowedHosts 里`
      + `（当前允许：${allow.join('、') || '（空）'}；loopback 永远允许）`)
  }
}

/** 响应体大小上限（V⑤/K⑤ 的同类防护：一条语音不该超过这个量级）。 */
const TTS_MAX_AUDIO_BYTES = 32 * 1024 * 1024

async function readAudio(response, where) {
  const len = Number(response.headers?.get?.('content-length') ?? 0)
  if (len > TTS_MAX_AUDIO_BYTES) throw new Error(`${where}：响应 ${(len / 1048576).toFixed(1)}MB 超过上限 32MB`)
  const buf = Buffer.from(await response.arrayBuffer())
  if (buf.length > TTS_MAX_AUDIO_BYTES) throw new Error(`${where}：响应 ${(buf.length / 1048576).toFixed(1)}MB 超过上限 32MB`)
  return buf
}

/**
 * 校验返回的字节**确实是音频**（2026-11-04，故障注入测试抓到的洞）。
 *
 * 起因：上游返回 `HTTP 200` + 一段 JSON（比如限流提示、错误对象）时，
 * 原实现会把它当 mp3 直接发给 QQ —— 用户收到一条"坏掉的语音"，
 * 而且因为 HTTP 是 200，日志里一切正常，**根本查不出来**。
 *
 * 判据只看文件头（够用且不依赖第三方解码器）：
 *   mp3  → `ID3` 或 MPEG 帧同步（0xFF 后高 3 位全 1）
 *   wav  → `RIFF`
 *   ogg/opus → `OggS`
 */
export function looksLikeAudio(buffer, format = 'mp3') {
  if (!buffer || buffer.length < 4) return false
  const b = buffer
  if (format === 'wav') return b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
  if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return true   // OggS
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return true                    // ID3
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return true                            // MPEG 帧同步
  return false
}

/** 断言音频有效，否则抛错（带上头部十六进制，够定位又不至于把正文全吐出来）。 */
function assertAudio(buffer, format, where) {
  if (looksLikeAudio(buffer, format)) return
  const head = Buffer.from(buffer ?? []).subarray(0, 16).toString('hex').replace(/(..)/g, '$1 ').trim()
  const text = Buffer.from(buffer ?? []).subarray(0, 60).toString('utf8').replace(/\s+/g, ' ')
  throw new Error(`${where} 返回的不是音频（${buffer?.length ?? 0} 字节，头 ${head}，开头文字「${text}」）`
    + ' —— 上游很可能回了错误 JSON 而不是音频')
}

/**
 * 唱一段。
 *
 * 两个后端（2026-11-04 扩）：
 *   · azure  —— SSML 逐句 pitch（真能调音高）
 *   · 本地 openai 兼容服务 —— POST `{base}/audio/sing`，由服务自己逐句合成再拼接
 *     （本机 `qq_chat/tts-server/server.py` 就是这个：edge-tts 逐句 + mp3 帧流拼接）
 *
 * 其它 provider 直接抛错并说清原因 —— 不要悄悄退化成"平读"，
 * 那样用户会以为是音色不对，而不是"这个后端压根不支持唱"。
 */
export async function synthesizeSong(config, lyrics, { voice = '' } = {}) {
  if (config.ttsProvider === 'azure') {
    if (!config.ttsApiKey) throw new Error('没配 ttsApiKey，唱不了')
    const chosen = voice || config.ttsVoice || 'zh-CN-XiaoxiaoNeural'
    return synthesizeAzure(config, buildSongSsml(lyrics, chosen, config.ttsStyle || ''))
  }
  // 本地 OpenAI 兼容服务：它有 /audio/sing（逐句不同 pitch + 拼接），交给它做
  const root = localRoot(config)
  if (root !== '') assertTtsHost(root, config, '本地服务唱歌')
  if (root === '') throw new Error(`当前 ttsProvider=${config.ttsProvider || '（空）'} 不支持唱：没配 ttsBaseUrl（指向本地语音服务），Azure 之外的后端要用本地服务唱`)
  const response = await fetch(`${root}/v1/audio/sing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lyrics: String(lyrics ?? ''), voice }),
    signal: AbortSignal.timeout(180000),   // 逐句合成，比单句慢得多
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`本地服务唱失败 HTTP ${response.status}: ${String(detail).slice(0, 160)}`)
  }
  const sung = Buffer.from(await response.arrayBuffer())
  assertAudio(sung, 'mp3', '本地服务唱歌')
  return { audio: sung, format: 'mp3' }
}

/**
 * 本地语音服务的根地址：`http://127.0.0.1:8977/v1` → `http://127.0.0.1:8977`。
 * 那个服务的路由是 `/v1/audio/*` 与 `/voice`，两个前缀不统一，所以这里拆开。
 */
function localRoot(config) {
  return String(config.ttsBaseUrl || '').trim().replace(/\/+$/, '').replace(/\/v1$/i, '')
}

/** 列出本地服务提供的音色（`GET /v1/audio/voices`）。返回 `{ current, data[] }`。 */
export async function fetchLocalVoices(config) {
  const root = localRoot(config)
  if (root !== '') assertTtsHost(root, config, '读音色列表')
  if (root === '') throw new Error('没配 ttsBaseUrl，读不到本地服务的音色列表')
  const response = await fetch(`${root}/v1/audio/voices`, { signal: AbortSignal.timeout(8000) })
  if (!response.ok) throw new Error(`读音色列表 HTTP ${response.status}`)
  const data = await response.json()
  return { current: String(data?.current ?? ''), data: Array.isArray(data?.data) ? data.data : [] }
}

/** 切换本地服务的音色（`POST /voice`）。它会把选择记进 voice.txt，重启也保留。 */
export async function switchLocalVoice(config, name) {
  const root = localRoot(config)
  if (root !== '') assertTtsHost(root, config, '切音色')
  if (root === '') throw new Error('没配 ttsBaseUrl，切不了音色')
  const response = await fetch(`${root}/voice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voice: String(name ?? '') }),
    signal: AbortSignal.timeout(8000),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data?.ok !== true) {
    const available = Array.isArray(data?.available) ? data.available.join('、') : ''
    throw new Error(`切换失败：${data?.reason ?? `HTTP ${response.status}`}${available ? `（可用：${available}）` : ''}`)
  }
  return { current: String(data?.current ?? name), voiceId: String(data?.voiceId ?? '') }
}
