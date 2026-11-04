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
  return { audio: Buffer.from(await response.arrayBuffer()), format: 'mp3' }
}

export async function synthesizeTts(config, text, { voice = '' } = {}) {
  if (config.ttsProvider === 'openai') {
    const base = String(config.ttsBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
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
    return { audio: Buffer.from(await response.arrayBuffer()), format: 'mp3' }
  }
  if (config.ttsProvider === 'local') {
    // Local GPT-SoVITS api_v2: POST /tts returns raw wav bytes (or a JSON error).
    const base = String(config.ttsLocalUrl || 'http://127.0.0.1:9880').replace(/\/+$/, '')
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
    return { audio: Buffer.from(await response.arrayBuffer()), format: 'wav' }
  }
  // Azure Speech REST (SSML)
  const chosen = voice || config.ttsVoice || 'zh-CN-XiaoxiaoNeural'
  return synthesizeAzure(config, buildAzureSsml(text, chosen, config.ttsStyle || ''))
}

/**
 * 唱一段（只有 Azure 支持：pitch 要靠 SSML 调）。
 *
 * 其它 provider 直接抛错并说清原因 —— 不要悄悄退化成"平读"，
 * 那样用户会以为是音色不对，而不是"这个 provider 压根不支持唱"。
 */
export async function synthesizeSong(config, lyrics, { voice = '' } = {}) {
  if (config.ttsProvider !== 'azure') {
    throw new Error(`当前 ttsProvider=${config.ttsProvider || 'azure'} 不支持唱（pitch 只有 Azure 的 SSML 能调）。要唱就把 ttsProvider 改成 azure`)
  }
  if (!config.ttsApiKey) throw new Error('没配 ttsApiKey，唱不了')
  const chosen = voice || config.ttsVoice || 'zh-CN-XiaoxiaoNeural'
  return synthesizeAzure(config, buildSongSsml(lyrics, chosen, config.ttsStyle || ''))
}
