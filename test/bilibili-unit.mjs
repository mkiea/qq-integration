/**
 * B 站浏览（lib/bilibili.js）。
 *
 * 分两半：
 *   ① **纯函数**（humanDuration / humanCount / formatVideoLine）—— 必须验，不联网也稳定；
 *   ② **真实接口** —— 热门榜与搜索。匿名调用会被风控（实测 412），所以这两条
 *      失败时标 SKIP 并打印原因，**不算通过也不算失败**（假装通过比失败更糟）。
 */
import { fetchPopular, formatVideoLine, humanCount, humanDuration, searchBilibili } from '../lib/bilibili.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) } else { failed++; console.log('FAIL', name, extra) }
}

// ── ① 时长 ───────────────────────────────────────────────────────────
{
  check('30 秒', humanDuration(30) === '30秒', humanDuration(30))
  check('212 秒 → 3分32秒', humanDuration(212) === '3分32秒', humanDuration(212))
  check('整分不带零秒', humanDuration(180) === '3分', humanDuration(180))
  check('超过一小时', humanDuration(3900) === '1小时5分', humanDuration(3900))
  check('0 秒 / 非法值不炸', humanDuration(0) === '0秒' && humanDuration('abc') === '0秒')
}

// ── ② 计数 ───────────────────────────────────────────────────────────
{
  check('9999 原样', humanCount(9999) === '9999', humanCount(9999))
  check('12345 → 1.2万', humanCount(12345) === '1.2万', humanCount(12345))
  check('1.2 亿', humanCount(120_000_000) === '1.2亿', humanCount(120_000_000))
  check('非法值给 0', humanCount(undefined) === '0')
}

// ── ③ 行格式：字段缺失时不能出现 `undefined` 或空段 ──────────────────
{
  const full = formatVideoLine({
    title: '某个视频', owner: { name: '某UP' }, duration: 212, stat: { view: 12345 }, bvid: 'BV1xx',
  })
  check('完整字段都在', ['某个视频', 'UP：某UP', '3分32秒', '1.2万播放', 'BV1xx'].every((s) => full.includes(s)), full)

  const bare = formatVideoLine({ title: '只有标题' })
  check('★ 缺字段时不出现 undefined', !bare.includes('undefined'), bare)
  check('缺字段时不出现连续分隔符', !bare.includes('| |') && !bare.includes(' |  '), bare)

  const noTitle = formatVideoLine({ bvid: 'BV1yy' })
  check('无标题给占位而不是空串', noTitle.startsWith('(无标题)'), noTitle)

  const zeroView = formatVideoLine({ title: 'x', stat: { view: 0 }, duration: 0 })
  check('0 播放/0 时长不显示成 0', !zeroView.includes('0播放') && !zeroView.includes('0秒'), zeroView)
}

// ── ④ 真实接口：失败要如实标注 ───────────────────────────────────────
{
  try {
    const hot = await fetchPopular({ limit: 3 })
    if (hot.length === 0) {
      console.log('SKIP 热门榜返回空列表（接口通了但没内容）—— 不算通过')
    } else {
      check('热门榜能拿到条目', hot.length > 0, `${hot.length} 条`)
      check('★ 每条都能格式化成一行', hot.every((v) => formatVideoLine(v).length > 0))
      check('条目带 bvid 或 aid', hot.every((v) => v.bvid || v.aid))
    }
  } catch (error) {
    console.log(`SKIP 热门榜请求失败（${error.message.slice(0, 60)}）—— 网络/风控问题，不算通过`)
  }

  // 搜索：没有 yt-dlp 时必须给出**可操作**的错误（而不是 "undefined"）
  try {
    await searchBilibili('猫', { limit: 1, ytDlp: null })
    // 如果本机 PATH 上真有 yt-dlp，这里可能真的搜到；两种情况都算合理
    console.log('INFO searchBilibili 在无显式 runner 时走到了 PATH 上的 yt-dlp')
  } catch (error) {
    check('★ 搜索缺 yt-dlp 时报错里点名了怎么修', /yt-dlp|ytDlp/.test(error.message), error.message.slice(0, 80))
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
