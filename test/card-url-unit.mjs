/**
 * 卡片 → 链接 的提取（lib/onebot.js 的 parseCardPayload / findPageUrl）。
 *
 * 需求背景（2026-11-01）：用户问「所有类似的卡片都能被解析成网址吗」。
 * 答案取决于两件事：
 *   ① 各家卡片的字段名不统一 —— B 站 `meta.detail_1.qqdocurl`、新闻 `meta.news.jumpUrl`、
 *      小程序 `meta.detail_1.url`、还有塞在深层 preview 里的；
 *   ② 卡片里**总是同时有封面图**，抓错就会把"封面 CDN 链接"当成"用户分享的东西"。
 *
 * 所以这个测试的核心不是"能抓到"，而是"**抓对**"：正例要看链接对不对，
 * 反例要看封面图有没有被误当成页面。
 */
import { formatCardText, parseCardPayload } from '../lib/onebot.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) } else { failed++; console.log('FAIL', name, extra) }
}

const wrap = (meta) => ({ app: 'com.tencent.miniapp_01', meta })

// ── ① 三种常见字段名都要能取到 ───────────────────────────────────────
{
  const bili = parseCardPayload(wrap({
    detail_1: { title: '哔哩哔哩', desc: '【某某】标题', qqdocurl: 'https://b23.tv/abc123' },
  }))
  check('B 站卡：qqdocurl', bili.url === 'https://b23.tv/abc123', bili.url)

  const news = parseCardPayload(wrap({
    news: { title: '某新闻', jumpUrl: 'https://news.example.com/a/1' },
  }))
  check('新闻卡：jumpUrl', news.url === 'https://news.example.com/a/1', news.url)

  const mini = parseCardPayload(wrap({
    detail_1: { title: '小程序', url: 'https://mp.weixin.qq.com/s/xyz' },
  }))
  check('小程序卡：url', mini.url === 'https://mp.weixin.qq.com/s/xyz', mini.url)
}

// ── ② 字段名不认识时，兜底也要找得到 ─────────────────────────────────
{
  const deep = parseCardPayload(wrap({
    detail_1: {
      title: '奇怪平台',
      preview: { extra: { shareLink: 'https://odd-platform.example/v/9' } },
    },
  }))
  check('★ 未知字段名（深层 preview）也能兜底取到', deep.url === 'https://odd-platform.example/v/9', deep.url)

  const inArray = parseCardPayload(wrap({
    detail_1: { title: '数组里的链接', items: [{ pic: 'https://x.example/a.png' }, { link: 'https://x.example/page' }] },
  }))
  check('数组里、且排在图片之后的页面链接也能取到', inArray.url === 'https://x.example/page', inArray.url)
}

// ── ③ ★ 反例：封面图 / 头像不能被当成页面链接 ────────────────────────
{
  const coverOnly = parseCardPayload(wrap({
    detail_1: {
      title: '只有封面',
      preview: 'https://i0.hdslb.com/bfs/archive/abc.jpg',
      icon: 'https://q1.qlogo.cn/g?b=qq&nk=123',
    },
  }))
  check('★ 只有封面图时不返回任何链接（别把 CDN 当页面）', coverOnly.url === '', coverOnly.url)

  const withBoth = parseCardPayload(wrap({
    detail_1: {
      title: '封面 + 页面',
      preview: 'https://i0.hdslb.com/bfs/archive/abc.jpg',
      qqdocurl: 'https://www.bilibili.com/video/BV1xx',
    },
  }))
  check('封面与页面并存时给出页面链接', withBoth.url === 'https://www.bilibili.com/video/BV1xx', withBoth.url)

  const mp4 = parseCardPayload(wrap({ detail_1: { title: '视频资源', url: 'https://cdn.example.com/v.mp4' } }))
  check('★ 直接给 .mp4 资源地址时不算页面链接', mp4.url === '', mp4.url)
}

// ── ④ 与文字格式化的关系：链接不该污染那一行 ───────────────────────
{
  const card = parseCardPayload(wrap({
    detail_1: { title: '哔哩哔哩', desc: '某个视频', qqdocurl: 'https://b23.tv/abc' },
  }))
  const line = formatCardText(card)
  check('文字行保持原样（链接由桥单独追加，不塞进这一行）', !line.includes('http'), line)
  check('文字行仍能读出来', line.length > 0, line)
}

// ── ⑤ 空/异常输入不能炸 ─────────────────────────────────────────────
{
  check('空对象返回 null', parseCardPayload({}) === null || parseCardPayload({}).url === '')
  check('null 返回 null', parseCardPayload(null) === null)
  check('字符串但不是 JSON 返回 null', parseCardPayload('not json') === null)
  check('数组返回 null', parseCardPayload([1, 2]) === null)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
