/** Unit tests for TTS helpers (no network). */
import { buildAzureSsml, buildLocalTtsRequest, normalizeSpeechText, pickProsody } from '../lib/tts.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const s = buildAzureSsml('你好 1 < 2 & "3"', 'zh-CN-XiaoxiaoNeural', 'chat')
check('SSML 含 voice 名', s.includes('name="zh-CN-XiaoxiaoNeural"'), s)
check('SSML 含 style', s.includes('style="chat"'), s)
check('XML 转义 <', s.includes('1 &lt; 2'), s)
check('XML 转义 &', s.includes('2 &amp; &quot;3&quot;'), s)
check('SSML 外层标签', s.startsWith('<speak') && s.endsWith('</speak>'), s)

const s2 = buildAzureSsml('测试', 'zh-CN-XiaoxiaoNeural', '')
check('空 style 不加属性', !s2.includes('style='), s2)

// Local GPT-SoVITS payload
const local = buildLocalTtsRequest({ ttsLocalRefAudio: 'D:/voice/xiaojingyu.wav', ttsLocalPromptText: '大家好，我是小鲸鱼', ttsLocalTextLang: 'zh', ttsLocalPromptLang: 'zh' }, '你好呀')
check('local 请求含 ref 音频路径', local.ref_audio_path === 'D:/voice/xiaojingyu.wav', JSON.stringify(local))
check('local 请求含提示文本', local.prompt_text === '大家好，我是小鲸鱼')
check('local 请求 wav + 非流式', local.media_type === 'wav' && local.streaming_mode === 0)
check('local 请求语言默认 zh', local.text_lang === 'zh' && local.prompt_lang === 'zh')
check('local 请求透传文本', local.text === '你好呀')

const localDefaults = buildLocalTtsRequest({}, '测试')
check('local 缺省值兜底', localDefaults.ref_audio_path === '' && localDefaults.text_lang === 'zh' && localDefaults.media_type === 'wav')

// 朗读文本规范化（2026-11-08）：去 markdown、换行当句读、补句末、按句截断
const norm1 = normalizeSpeechText('**重点**：`code`\n第二行')
check('规范化：去 markdown 标记', norm1 === '重点：code。第二行。', norm1)
check('规范化：换行变句号、不重复加句号', normalizeSpeechText('你好。') === '你好。', normalizeSpeechText('你好。'))
check('规范化：空文本返回空', normalizeSpeechText('   ') === '', JSON.stringify(normalizeSpeechText('   ')))
const normCut = normalizeSpeechText('第一句话。第二句话很长很长。', { maxChars: 12 })
check('规范化：按句截断，不切在词中间', normCut === '第一句话。', normCut)
check('规范化：没有句末标点时补句号', normalizeSpeechText('就这样吧') === '就这样吧。', normalizeSpeechText('就这样吧'))

// 语气 → rate/pitch（2026-11-08）。固定 rng=0.5 ⇒ 抖动项为 0，只测基础映射。
const pr = (text, jitter = true) => pickProsody(text, { rng: () => 0.5, jitter })
const q = pr('你好吗？')
check('语气：疑问句抬起、略快', q.mood === 'question' && q.rate === '+2%' && q.pitch === '+2Hz', JSON.stringify(q))
const ex = pr('太好了！')
check('语气：感叹句更快更高', ex.mood === 'exclaim' && ex.rate === '+4%' && ex.pitch === '+3Hz', JSON.stringify(ex))
const tr = pr('我……')
check('语气：拖长放慢压低', tr.mood === 'trail' && tr.rate === '-3%' && tr.pitch === '-1Hz', JSON.stringify(tr))
const sh = pr('嗯。')
check('语气：超短句放慢', sh.mood === 'short' && sh.rate === '-2%' && sh.pitch === '+0Hz', JSON.stringify(sh))
const pl = pr('今天天气不错。')
check('语气：陈述句不额外偏移', pl.mood === 'plain' && pl.rate === '+0%' && pl.pitch === '+0Hz', JSON.stringify(pl))
check('语气：格式符合 edge-tts 校验', [q, ex, tr, sh, pl].every((p) => /^[+-]\d+%$/.test(p.rate) && /^[+-]\d+Hz$/.test(p.pitch)),
  JSON.stringify([q, ex, tr, sh, pl]))
check('语气：jitter=false 时完全确定', pr('你好吗？', false).rate === '+2%' && pr('你好吗？', false).pitch === '+2Hz')
const lo = pickProsody('你好吗？', { rng: () => 0, jitter: true })
check('语气：抖动下限仍然合法', /^[+-]\d+%$/.test(lo.rate) && /^[+-]\d+Hz$/.test(lo.pitch), JSON.stringify(lo))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
