/**
 * 故障注入（fault injection）—— 2026-11-04。
 *
 * 与另外三个专项的分工：
 *   · fuzz   → "喂垃圾会不会死"
 *   · stress → "能吞多快"
 *   · soak   → "跑一小时还这么快吗"
 *   · **本文件** → "**依赖坏掉的时候，是优雅失败还是崩**"
 *
 * 为什么单独写：今天真实踩到的全是这一类 —— DeepSeek API 挂了、turn 卡死、
 * 我把本地 TTS 服务 kill 掉、代理 502。其中"TTS 服务没了"最典型：
 * 它挂了以后，桥应该**消息照发、只是没有语音**，而不是整条回复失败。
 *
 * 做法：起本地假 HTTP 服务扮演"坏掉的上游"，逐种故障喂给 lib/tts.js，
 * 断言 (a) 会抛错（不静默成功）；(b) 错误信息里带得上游状态（可诊断）；
 * (c) 不永久挂住（超时兜底）。**不联网**，全部打 127.0.0.1。
 */
import { createServer } from 'node:http'
import { synthesizeTts, synthesizeSong, fetchLocalVoices, switchLocalVoice } from '../lib/tts.js'
import { matchSongFile } from '../lib/bridge.js'

let passed = 0
let failed = 0
const check = (name, ok, extra = '') => {
  if (ok) { passed++; console.log('PASS', name, extra) } else { failed++; console.log('FAIL', name, extra) }
}

const BASE_CFG = { ttsProvider: 'openai', ttsApiKey: 'test', ttsVoice: 'x', ttsModel: 'edge' }

/** 起一个假上游，行为由 handler 决定。返回 { url, close }。 */
function fakeUpstream(handler) {
  const server = createServer((req, res) => handler(req, res))
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

/** 跑一次异步调用，返回 { error } 或 { value }，并记录耗时。 */
async function attempt(fn) {
  const started = Date.now()
  try {
    const value = await fn()
    return { value, ms: Date.now() - started }
  } catch (error) {
    return { error, ms: Date.now() - started }
  }
}

// ---------- F1 上游返回 500 ----------
{
  const up = await fakeUpstream((req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('upstream exploded')
  })
  const r = await attempt(() => synthesizeTts({ ...BASE_CFG, ttsBaseUrl: `${up.url}/v1` }, '测试'))
  check('F1 TTS 上游 500 ⇒ 抛错（不静默返回空音频）', r.error !== undefined, r.error?.message ?? `returned ${r.value?.audio?.length} bytes`)
  check('F1 错误信息里带上游状态码（可诊断）', /500/.test(r.error?.message ?? ''), r.error?.message)
  await up.close()
}

// ---------- F2 上游返回 200 但内容是垃圾（2026-11-04 修复后：必须抛错）----------
{
  const up = await fakeUpstream((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"not":"audio"}')
  })
  const r = await attempt(() => synthesizeTts({ ...BASE_CFG, ttsBaseUrl: up.url + '/v1' }, '测试'))
  // 修复前：会把 JSON 当 mp3 发出去（用户收到坏语音，且 HTTP 200 让日志一切正常）
  check('F2 ★200 + 非音频内容 ⇒ 抛错（不能当音频发出去）', r.error !== undefined, r.error?.message?.slice(0, 90))
  check('F2 错误里带头部十六进制与开头文字（够定位）', /头 /.test(r.error?.message ?? '') && /不是音频/.test(r.error?.message ?? ''))
  await up.close()
}

// ---------- F3 上游挂住不响应 ⇒ 必须有超时兜底 ----------
{
  const up = await fakeUpstream(() => { /* 故意不响应 */ })
  // 注意：synthesizeTts 的超时是 60s，不能真等满。
  // 用 3 秒竞速：3 秒内若"假装成功"就是 bug；3 秒内抛错（连接被断）也算合格。
  const pending = attempt(() => synthesizeTts({ ...BASE_CFG, ttsBaseUrl: `${up.url}/v1` }, '测试'))
  const raced = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve({ stillPending: true, ms: 3000 }), 3000)),
  ])
  check('F3 上游不响应 ⇒ 3 秒内不会假装成功', raced.stillPending === true || raced.error !== undefined,
    raced.stillPending ? '仍在等（会由 60s AbortSignal 收尾）' : (raced.error ? `抛错(${raced.ms}ms)` : `返回成功(${raced.ms}ms) ← 不该`))
  await up.close()
  pending.catch(() => {})   // 关掉 server 后这个 promise 会失败，吞掉避免 unhandledRejection
}

// ---------- F4 连接被拒（服务没起） ----------
{
  // 起一个再关掉，拿到一个"确定没人监听"的端口
  const up = await fakeUpstream((req, res) => res.end(''))
  const deadUrl = up.url
  await up.close()
  const r = await attempt(() => synthesizeTts({ ...BASE_CFG, ttsBaseUrl: `${deadUrl}/v1` }, '测试'))
  check('F4 TTS 服务不在 ⇒ 抛错且信息可读', r.error !== undefined && /fetch failed|ECONNREFUSED|connect/i.test(r.error?.message ?? ''),
    r.error?.message?.slice(0, 80))
}

// ---------- F5 唱歌接口 500 ----------
{
  const up = await fakeUpstream((req, res) => {
    res.writeHead(500)
    res.end('sing broken')
  })
  const r = await attempt(() => synthesizeSong({ ...BASE_CFG, ttsBaseUrl: `${up.url}/v1` }, '小兔子乖乖'))
  check('F5 唱歌接口 500 ⇒ 抛错并带状态码', r.error !== undefined && /500/.test(r.error.message), r.error?.message?.slice(0, 80))
  await up.close()
}

// ---------- F6 音色列表 / 切换：服务不在 ----------
{
  const up = await fakeUpstream((req, res) => res.end(''))
  const deadUrl = up.url
  await up.close()
  const a = await attempt(() => fetchLocalVoices({ ...BASE_CFG, ttsBaseUrl: `${deadUrl}/v1` }))
  const b = await attempt(() => switchLocalVoice({ ...BASE_CFG, ttsBaseUrl: `${deadUrl}/v1` }, '海星'))
  check('F6a 服务不在时读列表 ⇒ 抛错（不返回空列表冒充成功）', a.error !== undefined, a.error?.message?.slice(0, 60))
  check('F6b 服务不在时切音色 ⇒ 抛错', b.error !== undefined, b.error?.message?.slice(0, 60))
}

// ---------- F7 没配 ttsBaseUrl（配置缺项） ----------
{
  const r = await attempt(() => fetchLocalVoices({ ttsProvider: 'openai' }))
  check('F7 没配 baseUrl ⇒ 抛错并说清缺什么', r.error !== undefined && /ttsBaseUrl/.test(r.error.message), r.error?.message)
}

// ---------- F8 曲库异常输入 ----------
{
  check('F8a 曲库空 ⇒ 匹配返回 null（不抛）', matchSongFile([], '任意歌名') === null)
  check('F8b 曲库名含怪字符 ⇒ 不抛', (() => {
    try { matchSongFile(['a\u0000b.mp3', ' 空格 .mp3'], '../etc/passwd'); return true } catch { return false }
  })())
}

// ---------- F9 源码级：发送失败必须留痕（不静默） ----------
{
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/bridge.js', import.meta.url), 'utf8')
  const ttsSrc = readFileSync(new URL('../lib/tts.js', import.meta.url), 'utf8')
  check('F9a ★turns 卡死有 watchdog（180s 警告 / 300s 掐断）', /TURN_STUCK_WARN_MS/.test(src) && /TURN_STUCK_ABORT_MS/.test(src))
  check('F9b ★TTS 失败会写 trace（不是只写 debug 日志）', /stage: 'tts'/.test(src))
  check('F9d ★TTS 返回内容经过音频校验（不是只看 HTTP 状态）', /export function looksLikeAudio/.test(ttsSrc))
  check('F9c ★曲库文件发不出去时也写 trace', /曲库文件不存在|曲库：当前没有可用的 OneBot 连接/.test(src))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
