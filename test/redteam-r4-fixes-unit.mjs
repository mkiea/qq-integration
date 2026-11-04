/**
 * 红队第四轮增补报告打穿的 5 条修复 —— 回归门（2026-11-04 晚）。
 *
 * 报告来源：`redteam-round4-report.md` §6（新版手册 V 组 / W 组）。
 * 这 5 条**全是我 11-04 当天写的代码引入的**，所以每条都要有断言钉住，否则下次会改回去。
 *
 * 判据：
 *   R1 W③ 名单 deny-closed：`[0]`/`[null]`/`["abc"]` 必须**拒绝**（修复前是静默放行）
 *   R2 W① 身份探针：start / bot-connect / 周期 三处都要有，且未确认时 deny-closed
 *   R3 W⑤ 换号重验：靠 bot-connect 探针覆盖（源码级）
 *   R4 V⑥ TTS 出网白名单：外部域名必须拒，loopback 必须放行
 *   R5 V⑨ 语音文件清理：发送后要删 ttsDir 里的文件（源码级 + 只删自己的目录）
 */
import { readFileSync } from 'node:fs'
import { botIdentityAllowed, botIdentityConfigBroken } from '../lib/bridge.js'
import { fetchLocalVoices } from '../lib/tts.js'

let passed = 0
let failed = 0
const check = (name, ok, extra = '') => {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// ---------- R1 W③ 名单 deny-closed ----------
{
  const cases = [
    ['空数组 = 不限制', [], 1003, true],
    ['号在名单', [1001, 1003], 1003, true],
    ['号不在名单', [1001], 1003, false],
    ['★[0] ⇒ 拒绝（修复前放行）', [0], 1003, false],
    ['★[null] ⇒ 拒绝（修复前放行）', [null], 1003, false],
    ['★["abc"] ⇒ 拒绝（修复前放行）', ['abc'], 1003, false],
    ['混合 [1001,0] ⇒ 拒绝', [1001, 0], 1001, false],
  ]
  for (const [label, list, uin, expect] of cases) {
    check(`R1 W③ ${label}`, botIdentityAllowed({ botQqAllowed: list }, uin) === expect)
  }
  check('R1 W③ 字符串数字仍正常', botIdentityAllowed({ botQqAllowed: ['1001'] }, 1001) === true)
  check('R1 W③ 能指出非法项（供 trace）', String(botIdentityConfigBroken({ botQqAllowed: [1001, 0] })).includes('0'))
}

// ---------- R2/R3/R5 源码级 ----------
const src = readFileSync(new URL('../lib/bridge.js', import.meta.url), 'utf8')
const ttsSrc = readFileSync(new URL('../lib/tts.js', import.meta.url), 'utf8')

check('R2 W① ★start 里探一次身份',
  src.includes("void this.#probeLoginIdentity('startup')"))
check('R2 W① ★bot-connect 时也探（这就是 W⑤ 的正解）',
  /bot-connect[\s\S]{0,260}#probeLoginIdentity\('bot-connect'\)/.test(src))
check('R2 W① 有周期兜底', /loginProbeTimer = setInterval/.test(src))
check('R2 W① ★未确认身份时 deny-closed',
  /botUnauthorized === undefined\)\s*\{[\s\S]{0,200}return false/.test(src))
check('R2 W① 拒绝理由区分"未确认"与"不在名单"', /登录身份还没确认/.test(src))
check('R3 W⑤ 换号会重新学（不再是一次性 botNamesLearned 就完事）',
  /#probeLoginIdentity/.test(src) && /bot-connect[\s\S]{0,260}probeLoginIdentity/.test(src))

check('R4 V⑥ ★TTS 有 host 白名单函数', /function assertTtsHost/.test(ttsSrc))
check('R4 V⑥ 五条出网路径都接了校验',
  (ttsSrc.match(/assertTtsHost\(/g) ?? []).length >= 6, `调用点 ${(ttsSrc.match(/assertTtsHost\(/g) ?? []).length - 1} 处`)
check('R5 V⑨ ★发送后会清理合成文件', /unlinkSync\(doomed\)/.test(src))
check('R5 V⑨ 只删 ttsDir（不碰曲库）', /file\.startsWith\(this\.ttsDir\)/.test(src))

// ---------- R4 行为级：外部拒 / 本地放行 ----------
{
  const cfg = { ttsProvider: 'openai', ttsBaseUrl: 'http://attacker.example/v1' }
  let denied = false
  try { await fetchLocalVoices(cfg) } catch (error) { denied = /白名单/.test(error.message) }
  check('R4 V⑥ ★外部域名被拒（不是网络层失败，是白名单拒）', denied)

  const local = { ttsProvider: 'openai', ttsBaseUrl: 'http://127.0.0.1:8977/v1' }
  let localOk = false
  let localErr = ''
  try { const r = await fetchLocalVoices(local); localOk = Array.isArray(r.data) } catch (error) { localErr = error.message }
  check('R4 V⑥ loopback 必须放行（否则本地 TTS 全废）', localOk, localOk ? '' : localErr.slice(0, 70))

  const wild = { ttsProvider: 'openai', ttsBaseUrl: 'http://a.example/v1', ttsAllowedHosts: ['*.example'] }
  let wildAllowedToNetwork = false
  try { await fetchLocalVoices(wild) } catch (error) { wildAllowedToNetwork = !/白名单/.test(error.message) }
  check('R4 V⑥ 通配符 *.example 生效（放行到网络层）', wildAllowedToNetwork)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
