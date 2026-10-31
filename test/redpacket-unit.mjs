/**
 * Unit tests for lib/redpacket.js — "看得见"那一半。
 *
 * 不许把「抢」写进断言以外的地方：本模块**只识别**，所以测试也只验证识别。
 * 词表是独立封闭的，这里逐条钉住"算"与"不算"的边界 —— 尤其是
 * 「我发了个红包」这种普通聊天**不能**被判成红包消息（误判一次，之后真假就分不清了）。
 */
import { GRAB_UNAVAILABLE_REASON, describeRedPacket, detectRedPacket } from '../lib/redpacket.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// ---- 1) 结构化卡片：app 带 redpacket 就算 ----
const card = { app: 'com.tencent.mobileqq.redpacket', prompt: '[QQ红包]恭喜发财', title: '恭喜发财', desc: '', url: '' }
const byCard = detectRedPacket({ card, text: '' })
check('红包卡片（app=…redpacket）被认出', byCard.isRedPacket === true && byCard.hit === 'card', JSON.stringify(byCard))
check('卡片文案进 title', byCard.title === '恭喜发财', byCard.title)
check('普通红包的类型是「红包」', byCard.kind === '红包', byCard.kind)

// ---- 2) 只有文本：必须带方括号才算 ----
const byText = detectRedPacket({ text: '[QQ红包]恭喜发财，大吉大利' })
check('文本强标记 [QQ红包] 被认出', byText.isRedPacket === true && byText.hit === 'text', JSON.stringify(byText))
check('裸说「红包」不算红包消息', detectRedPacket({ text: '我发了个红包，你去看看' }).isRedPacket === false)
check('「红包我不抢」不算', detectRedPacket({ text: '红包我不抢，你们先' }).isRedPacket === false)
check('无关文本不算', detectRedPacket({ text: '今天天气不错' }).isRedPacket === false)

// ---- 3) 原始 JSON 兜底：卡片归一化会丢字段，标记可能只在 meta 里 ----
const rawOnly = detectRedPacket({ raw: '{"app":"com.tencent.miniapp_01","meta":{"detail_1":{"title":"微信红包","qqurl":"https://h5.qzone.qq.com/redpacket/x"}}}' })
check('标记只在原始 JSON 里也能认出', rawOnly.isRedPacket === true && rawOnly.hit === 'card', JSON.stringify(rawOnly))

// ---- 4) 类型分辨 ----
check('口令红包', detectRedPacket({ text: '[口令红包]恭喜发财', card: null }).kind === '口令红包')
check('专属红包', detectRedPacket({ text: '[专属红包]给你留的', card: null }).kind === '专属红包')
const tie = detectRedPacket({ raw: '{"app":"com.tencent.mobileqq.redpacket"}', text: '[口令红包] 恭喜发财' })
check('卡片 + 口令文本：类型按"口令"认（更具体优先）', tie.kind === '口令红包', JSON.stringify(tie))

// ---- 5) 空/坏输入不炸 ----
for (const bad of [undefined, null, {}, { card: null, text: '' }, { text: null, raw: null }]) {
  let ok = true
  let result = null
  try { result = detectRedPacket(bad) } catch { ok = false }
  check(`空/坏输入不抛错（${JSON.stringify(bad ?? null)}）`, ok && result?.isRedPacket === false)
}

// ---- 6) 描述文案 ----
check('describeRedPacket 带类型与标题', describeRedPacket(byCard) === '红包「恭喜发财」', describeRedPacket(byCard))
check('describeRedPacket 没标题就只说类型', describeRedPacket(byText) === '红包', describeRedPacket(byText))
check('describeRedPacket 对非红包返回空串', describeRedPacket({ isRedPacket: false }) === '')
/**
 * 文案红线：可以写"发现"，**绝不能写"已领取/已抢"** —— 桥根本没有这个能力，
 * 写了就是骗人（也会让后续排查以为功能存在）。
 */
const allText = [describeRedPacket(byCard), describeRedPacket(byText), GRAB_UNAVAILABLE_REASON].join(' ')
check('★文案里不出现"已领取/已抢到"', !/已领取|已抢|领取成功/.test(allText), allText)
check('★不可用原因说清"注入层没有接口"', GRAB_UNAVAILABLE_REASON.includes('注入层') && GRAB_UNAVAILABLE_REASON.includes('OneBot'), GRAB_UNAVAILABLE_REASON)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
