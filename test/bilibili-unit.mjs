/**
 * B 站浏览（lib/bilibili.js）。
 *
 * 分三半：
 *   ① **WBI 签名**（getMixinKey / encWbi）—— 用官方文档里那组校验向量钉死，不联网；
 *   ② **纯函数**（humanDuration / humanCount / formatVideoLine / 搜索结果整形）—— 不联网；
 *   ③ **真实接口** —— 热门榜与搜索。失败时标 SKIP 并打印原因，
 *      **不算通过也不算失败**（假装通过比失败更糟）。
 */
import {
  cleanSearchTitle, encWbi, fetchPopular, formatVideoLine, getMixinKey, humanCount, humanDuration,
  normalizeSearchItem, parseDurationText, searchBilibili,
} from '../lib/bilibili.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) } else { failed++; console.log('FAIL', name, extra) }
}

/**
 * ── ⓪ WBI 签名 ──────────────────────────────────────────────────────
 *
 * 向量来自 `bilibili-API-collect` 的 `misc/sign/wbi.md`：
 *   img_key = 7cd084941338484aae1ad9425b84077c
 *   sub_key = 4932caff0ff746eab6f01bf08b70ac45
 *   params  = {foo:'114', bar:'514', zab:1919810}, wts = 1702204169
 *   ⇒ bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4
 *
 * 为什么必须钉这组：签名算错时接口**不会说"签名错"**，只会返回一个 HTML 风控页，
 * 排查起来会误以为是 IP 被封。有了固定向量，错一个字符都会当场红。
 */
{
  const IMG = '7cd084941338484aae1ad9425b84077c'
  const SUB = '4932caff0ff746eab6f01bf08b70ac45'
  const mixin = getMixinKey(IMG, SUB)
  check('★ mixin_key 命中官方示例值', mixin === 'ea1db124af3c7062474693fa704f4ff8', mixin)
  check('mixin_key 是 32 位', mixin.length === 32)

  const signed = encWbi({ foo: '114', bar: '514', zab: 1919810 }, IMG, SUB, 1702204169000)
  const expected = 'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4'
  check('★★★ encWbi 与官方向量逐字节一致', signed === expected, signed)

  check('参数按键名排序（bar 在 foo 前）', signed.startsWith('bar=514&foo=114&'), signed.slice(0, 20))
  check('wts 用的是秒级时间戳', signed.includes('wts=1702204169'), '')
  // B 站规范里 !'()* 是**剔除**不是转义 —— 漏了这步签名对不上
  const filtered = encWbi({ kw: "a!b'c(d)e*f" }, IMG, SUB, 1702204169000)
  check("★ 值里的 !'()* 被剔除（不是转义）", filtered.includes('kw=abcdef&'), filtered.split('&')[0])
  let badKey = ''
  try { encWbi({ a: 1 }, 'short', 'key', 1702204169000) } catch (error) { badKey = String(error.message) }
  check('密钥长度不对时明确报错', badKey.includes('WBI 密钥长度不对'), badKey.slice(0, 30))
}

/** ── ⓪' 搜索结果的整形 ───────────────────────────────────────────── */
{
  check('duration "3:32" → 212 秒', parseDurationText('3:32') === 212, String(parseDurationText('3:32')))
  check('duration "1:02:03" → 3723 秒', parseDurationText('1:02:03') === 3723, String(parseDurationText('1:02:03')))
  check('duration 空/非法 → 0', parseDurationText('') === 0 && parseDurationText(null) === 0)

  check('标题剥掉 <em> 高亮标签', cleanSearchTitle('猫娘<em class="keyword">教程</em>') === '猫娘教程', cleanSearchTitle('猫娘<em class="keyword">教程</em>'))
  check('标题解 HTML 实体', cleanSearchTitle('A &amp; B &quot;x&quot;') === 'A & B "x"', cleanSearchTitle('A &amp; B &quot;x&quot;'))

  const shaped = normalizeSearchItem({
    bvid: 'BV1xx', aid: 123, title: '<em>猫</em>娘', author: 'UP主', duration: '3:32', play: 12345, pubdate: 1700000000,
  })
  check('搜索项映射到 owner.name（与详情接口同形）', shaped.owner.name === 'UP主')
  check('搜索项映射到 stat.view', shaped.stat.view === 12345)
  check('搜索项时长转成秒', shaped.duration === 212)
  check('formatVideoLine 吃得下整形后的搜索项', formatVideoLine(shaped).includes('1.2万播放'), formatVideoLine(shaped))
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

  /**
   * 搜索：**不依赖 yt-dlp** 也能出结果（2026-11-01 换成 wbi 签名直连之后）。
   *
   * 这一条以前是「没有 yt-dlp 就必须给出可操作的报错」——那是因为旧实现唯一的路
   * 就是 yt-dlp。现在签名直连自己就能过风控，所以判据要跟着改：
   * 真正的回归点是"关掉 yt-dlp 仍然搜得到"。
   */
  try {
    const items = await searchBilibili('猫', { limit: 2, ytDlp: null })
    if (items.length === 0) {
      console.log('SKIP 搜索返回空列表（接口通了但没结果）—— 不算通过')
    } else {
      check('★★ 关掉 yt-dlp 也能搜到（wbi 签名直连生效）', true, `${items.length} 条`)
      check('结果字段齐全（bvid + 标题 + UP）', Boolean(items[0].bvid) && items[0].title.length > 0,
        formatVideoLine(items[0]).slice(0, 46))
    }
  } catch (error) {
    console.log(`SKIP 搜索失败（${error.message.slice(0, 70)}）—— 网络/风控问题，不算通过`)
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
