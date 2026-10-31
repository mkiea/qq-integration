/**
 * voice-path.js —— 入站语音「本地路径」的准入判断（2026-10-31）
 *
 * 起因：用户发来的一条语音，桥报「无法获取语音文件（get_record、本地路径与 url 均失败）」。
 * 看入站原始帧才发现 Waylay 把本地绝对路径塞在 **`record.url`** 里，而 `path` 是空的：
 *
 *   records: [{ file: "40492477….amr",
 *               url:  "C:\\…\\nt_data\\Ptt\\2026-10\\Ori\\40492477….amr",
 *               path: "" }]
 *
 * 而 `#fetchVoiceAudio` 的本地路径候选只有 `[path, file]` ⇒ 永远读不到；
 * url 分支又只认 `http(s)://` ⇒ 也不匹配。三个来源全落空。
 *
 * ⚠️ 为什么这里**敢**放行绝对路径，而入站「文件」那条（`inbound-path.js`）默认全拒：
 *   · 文件的内容会**内联进她的上下文**（模型直接读到），所以必须全拒；
 *   · 语音的内容只送去 **STT 转写**，不进上下文。
 * 即便如此也不能无条件放行 —— 伪造帧可以填 `.ssh/id_rsa`，如果 STT 配的是云端服务，
 * 那就是把密钥发出去。所以这里加两道闸：
 *   ① **只收音频扩展名**（`.amr/.silk/.mp3/.wav/...`）；
 *   ② **realpath 之后再审一次**（防止建一个 `x.amr` 链接指向 `id_rsa`）。
 */

/** 语音容器扩展名。silk 是 QQ 原生的，amr 是手机录音常见格式，其余是转码后的。 */
export const VOICE_EXT_RE = /\.(amr|silk|slk|mp3|wav|ogg|m4a|pcm|aac|flac)$/i

/** 绝对路径形状（盘符或 `/` 开头）。纯文件名不算——那是 NapCat 自己的缓存名，走 get_record。 */
export function looksAbsolutePath(value) {
  return /^([a-zA-Z]:[\\/]|\/)/.test(String(value ?? ''))
}

/**
 * 这个路径看起来能不能当语音读。
 * @param {string} value
 * @param {{ maxBytes?: number }} options
 * @returns {{ ok: boolean, reason: string }}
 *   reason: `not-absolute` | `not-audio` | `too-large` | ''
 */
export function voicePathVerdict(value, { maxBytes = 20 * 1024 * 1024, size = null } = {}) {
  const p = String(value ?? '').trim()
  if (!looksAbsolutePath(p)) return { ok: false, reason: 'not-absolute' }
  if (!VOICE_EXT_RE.test(p)) return { ok: false, reason: 'not-audio' }
  if (size !== null && Number(size) > maxBytes) return { ok: false, reason: 'too-large' }
  return { ok: true, reason: '' }
}

/**
 * 从 `record` 段里收集**可能**是本地语音文件的候选路径。
 *
 * ⚠️ `url` 必须在列表里：Waylay 真的会往 url 塞本地路径（真机实证）。
 * 顺序按「最可能是真语音」排：path → file → url。
 *
 * @param {{ path?: string, file?: string, url?: string }} record
 * @returns {string[]}
 */
export function voiceLocalCandidates(record) {
  return [record?.path, record?.file, record?.url]
    .map((v) => String(v ?? '').trim())
    .filter((p) => p.length > 3 && looksAbsolutePath(p))
}
