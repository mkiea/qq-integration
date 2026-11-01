/**
 * cardlook.js 的纯函数测试（2026-11-01）。
 *
 * 为什么不测网络：这条链的失败方式是"静默降级"（查不到就当普通卡片），
 * 靠线上看不出 bug；而真正容易错的是**纯函数**那几处 ——
 * 尤其是 `biliHeaders`：它守的是**账号凭证边界**，写错了不会报错，
 * 只会在某天把 SESSDATA 发到别的站点上去。所以这里只钉三组纯函数。
 */
import { biliHeaders, cardPlatform, conclusionNote, fetchVideoConclusion, formatConclusion, keywordCandidates, pickExactMatch, pickSubtitleTrack, storyboardTiles, subtitleIdentity, subtitleLooksForeign } from '../lib/cardlook.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) } else { failed++; console.log('FAIL', name, extra) }
}

// ── ① 登录态请求头：凭证只在这里成型 ───────────────────────────────
{
  const anon = biliHeaders('')
  check('空 cookie 仍是匿名访客（buvid3=0）', anon.cookie === 'buvid3=0', anon.cookie)
  check('匿名也带 UA 与 referer（412 的成因见文件头取证）',
    anon['user-agent'].includes('Mozilla') && anon.referer === 'https://www.bilibili.com/')

  const withBuvid = biliHeaders('SESSDATA=abc; buvid3=XY; bili_jct=def')
  check('★ 自带 buvid3 时原样使用（不重复拼）', withBuvid.cookie === 'SESSDATA=abc; buvid3=XY; bili_jct=def', withBuvid.cookie)

  const noBuvid = biliHeaders('SESSDATA=abc; bili_jct=def')
  check('★ 没带 buvid3 时自动补一个哑值（否则 referer 与 buvid 不成对 = 爬虫签名）',
    noBuvid.cookie === 'SESSDATA=abc; bili_jct=def; buvid3=0', noBuvid.cookie)

  // 只在键的位置算数：`xsbuvid3=` 不能被当成已有 buvid3
  const tricky = biliHeaders('SESSDATA=abc; xsbuvid3=1')
  check('★ buvid3 判定按 Cookie 键边界（xsbuvid3= 不算）', tricky.cookie.endsWith('; buvid3=0'), tricky.cookie)

  const injected = biliHeaders('SESSDATA=abc\r\nX-Evil: 1')
  check('★★ cookie 里的换行被剥掉（Cookie 是请求头，换行 = 头注入）',
    !/[\r\n]/.test(injected.cookie) && injected.cookie.startsWith('SESSDATA=abc'), JSON.stringify(injected.cookie))

  check('★ 换登录态时 UA/referer 不被用户串覆盖',
    withBuvid['user-agent'] === anon['user-agent'] && withBuvid.referer === anon.referer)
}

// ── ② 平台判定 ─────────────────────────────────────────────────────
{
  check('B 站卡片被识别', cardPlatform({ title: '某个视频（哔哩哔哩）', url: 'https://b23.tv/x' }) === 'bilibili')
  check('★ 普通网页卡片不误判', cardPlatform({ title: '一篇博客', url: 'https://example.com/p' }) === '')
  check('★ 不靠子串误伤（notbilibili.com）',
    cardPlatform({ title: 'x', url: 'https://notbilibili.com/x' }) === '')
}

// ── ③ 标题匹配：能不能把卡片落到正确的 bvid ────────────────────────
{
  const results = [
    { type: 'video', bvid: 'BV1AAA', title: '养大肥鱼是因为缺爱吗？为什么我们如此爱压抑？' },
    { type: 'video', bvid: 'BV1BBB', title: '<em class="keyword">猫娘</em>日常' },
    { type: 'live', bvid: 'BV1CCC', title: '直播不算' },
  ]
  check('完全一致命中', pickExactMatch(results, '养大肥鱼是因为缺爱吗？为什么我们如此爱压抑？') === 'BV1AAA')
  check('★ 站内标题带 <em> 高亮也能命中（不剥标签就永远比不上）',
    pickExactMatch(results, '猫娘日常') === 'BV1BBB')
  check('★ 卡片标题被 QQ 截断时按前缀命中',
    pickExactMatch(results, '养大肥鱼是因为缺爱吗？为什么我们如此爱压') === 'BV1AAA')
  check('太短的关键词不做匹配（避免命中一大片）', pickExactMatch(results, '猫娘') === '')
  check('非 video 类型不匹配', pickExactMatch(results, '直播不算') === '')
  check('对不上就返回空串（宁可没有，不猜）', pickExactMatch(results, '完全不相关的标题内容') === '')
}

// ── ④ 关键词候选：卡片标题里的平台名不能拿去搜 ──────────────────────
{
  check('★ 平台名被剔除（否则拿"哔哩哔哩"去搜，什么也搜不到）',
    !keywordCandidates({ prompt: '哔哩哔哩', title: '哔哩哔哩' }).includes('哔哩哔哩'))
  const k = keywordCandidates({ prompt: '真正的标题', title: '哔哩哔哩' })
  check('prompt 优先（真机卡片 detail_1.title 是平台名）', k[0] === '真正的标题', JSON.stringify(k))
  check('去掉 [QQ小程序] 前缀', keywordCandidates({ prompt: '[QQ小程序]标题在这里' })[0] === '标题在这里')
}

/**
 * ④ 全片缩略图的切块坐标（2026-11-01 晚，「只看了一分钟」那条）。
 *
 * 为什么必须单测：切歪了的产物是**一张看起来还挺正常的图**（半张脸、两块之间的缝），
 * 她不会报警，只会照那张图描述 —— 真机上永远看不出来。
 * 所以这里断言的是**坐标本身**，不是能裁出图。
 */
{
  const index = Array.from({ length: 192 }, (_, i) => i * 5)
  const t = storyboardTiles({ index, xLen: 10, yLen: 10, w: 480, h: 270, want: 8 })
  check('均匀取 8 个点', t.length === 8, String(t.length))
  check('★ 跳过首尾（第一张不在 0 秒、最后一张不在片尾）',
    t[0].at > 0 && t[t.length - 1].at < index[index.length - 1],
    t.map((x) => x.at).join(','))
  check('★ 时间点严格递增（否则按时间先后排列这句话就是假的）',
    t.every((x, i) => i === 0 || x.at > t[i - 1].at), t.map((x) => x.at).join(','))
  // 行优先：第 i 块 = 第 floor(i/xLen) 行、第 i%xLen 列
  const i0 = Math.round((191 * 1) / 9)
  check('★★ 行优先坐标：第 i 块的 x 是列偏移、y 是行偏移',
    t[0].x === (i0 % 10) * 480 && t[0].y === Math.floor(i0 / 10) * 270,
    i0 + ' → x=' + t[0].x + ' y=' + t[0].y)
  check('★ 跨图时 sheet 递增（100 块一张）', t[4].sheet === 1 && t[3].sheet === 0,
    t.map((x) => x.sheet).join(','))
  check('★ 同一张图里的块坐标不重复（重复=切到同一块，等于少看一个时刻）',
    new Set(t.map((x) => x.sheet + ':' + x.x + ':' + x.y)).size === t.length)
  check('边界：index 为空时返回空数组（不猜）', storyboardTiles({ index: [], xLen: 10, yLen: 10, w: 480, h: 270, want: 8 }).length === 0)
  check('边界：want 超过块数时按块数封顶',
    storyboardTiles({ index: [1, 2, 3], xLen: 10, yLen: 10, w: 480, h: 270, want: 99 }).length === 3)
}

/**
 * ★ 平台 AI 总结的渲染（2026-11-01 深夜，用户：「你去看看ai总结」）。
 *
 * 这块的价值是**替代**我们自己的音轨采样：平台读完整条视频写的摘要 + 带时间戳的大纲，
 * 本来就是"大概知道讲的是啥"的最优答案。渲染错了不会报错，她只会拿到一段没有时间轴的
 * 文字，于是仍然答不出"第几分钟讲了啥"。
 */
{
  const full = {
    summary: '这期视频讨论了人对 AI 的情感投射。',
    outline: [
      { title: '开场', items: [{ at: 0, text: '先说结论' }, { at: 75, text: '举一个例子' }] },
      { title: '论证', items: [{ at: 3661, text: '引用一项研究' }] },
    ],
  }
  const text = formatConclusion(full)
  check('★ 整体摘要出现在正文里', text.includes('这期视频讨论了人对 AI 的情感投射。'), '')
  check('★ 大纲的节标题有标记（否则章节和要点会糊成一片）', text.includes('【开场】') && text.includes('【论证】'))
  check('★ 时间戳格式 m:ss（0→0:00、75→1:15）', text.includes('0:00 先说结论') && text.includes('1:15 举一个例子'), '')
  check('★ 超过 1 小时的时间戳不会变成 61:01', text.includes('1:01:01 引用一项研究'), '')
  /**
   * ★★ 必须走 `dataBlock` 围栏：AI 总结仍然是**第三方内容**。
   * 这一条与字幕/评论同源 —— 平台摘要里照样可能被塞进"忽略之前的设定"。
   */
  check('★★ 摘要与大纲都在 dataBlock 围栏里（逐行 `| ` 前缀）',
    /\| 这期视频讨论了/.test(text) && /\| 0:00 先说结论/.test(text), '')
  check('★ 只有摘要时也能渲染（不能因为没大纲就整段丢掉）',
    formatConclusion({ summary: '只有一句话', outline: [] }).includes('只有一句话'))
  check(' 只有大纲时不输出空摘要标题',
    !formatConclusion({ summary: '', outline: [{ title: 'A', items: [{ at: 0, text: 'b' }] }] }).includes('整体摘要'))

  /**
   * ★★★ 没配登录态时必须**直接返回 null，一次网络都不发**。
   *
   * 实测对照：带 wbi 签名 ⇒ `-101 账号未登录`；不带签名 ⇒ `-403 访问权限不足`。
   * 也就是说这条路必然失败，而它每次要多打一次 nav 才能签名 —— 在"收到消息 → 她开口"
   * 之间白花 300ms 是不可接受的。所以这个短路是**性能契约**，不是优化。
   */
  const t0 = Date.now()
  const skipped = await fetchVideoConclusion('BV1xx411c7mD', 123, 456, 5000, '')
  check('★★★ 没 cookie 时短路返回 null（不发任何请求）',
    skipped === null && Date.now() - t0 < 50, `耗时 ${Date.now() - t0}ms`)
  check('  参数不全时也返回 null（cid 缺失 / bvid 空）',
    (await fetchVideoConclusion('', 0, 0, 1000, 'SESSDATA=x')) === null
    && (await fetchVideoConclusion('BV1xx', 0, 0, 1000, 'SESSDATA=x')) === null)
}

/**
 * ── ⑤ 字幕身份校验（2026-11-01 深夜串味事故的守门人）────────────────────
 *
 * 事故经过：`x/player/v2` 现在会返回**别人的** `subtitle_url`，同一 `bvid+cid`
 * 连打 12 次只有 4 次对。她把别人的台词当这条视频讲了 —— 比"没看到"糟得多。
 *
 * 这里锁两件事：
 *   ① AI 字幕文件名是 `<aid><cid><32hex>` ⇒ **可以硬判**"是不是这条视频的"；
 *   ② 用户的 CC 字幕（`/bfs/subtitle/<40hex>.json`）路径里没有身份位 ⇒ **必须承认看不出**，
 *      不许为了"有个结论"去猜 —— 猜错的代价是把正常字幕全丢掉。
 */
{
  const AID = 117532669253298
  const CID = 43196285006
  const GOOD = `//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/${AID}${CID}06ec666fd758e11ec5e100fcb9e27b9d5b?auth_key=1793515967-31fd-0-762d`
  check('★★ 正确路径自证通过（文件名 = aid + cid + 32hex）',
    subtitleIdentity(GOOD, AID, CID) === 'same')

  // 事故里真实抓到的 5 条错地址，逐条都必须判"是别人的"
  const dirty = [
    '113251408941998261452603',
    '113226276737045263851230',
    '113277161966434262147966',
    '113317293198604263188010',
    '113343499078602263905616',
  ]
  const allOther = dirty.every((h) => subtitleIdentity(`//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/${h}`, AID, CID) === 'other')
  check('★★★ 事故现场 5 条脏地址全部判为「别人的」', allOther, `${dirty.length} 条`)

  check('★ 只差一位 aid 也要判出来（前缀比对不是"包含"）',
    subtitleIdentity(`//x/ai_subtitle/prod/${AID + 1}${CID}06ec`, AID, CID) === 'other')

  const cc = '//aisubtitle.hdslb.com/bfs/subtitle/662b660a420431045b483f9b560057c262539b87.json'
  check('★★ 用户 CC 字幕判为「看不出」（内容寻址，路径里没有身份位）',
    subtitleIdentity(cc, 80433022, 137649199) === 'unknown')

  check('★ aid/cid 未知时不瞎判（返回 unknown，不是 other）',
    subtitleIdentity(GOOD, 0, 0) === 'unknown' && subtitleIdentity(GOOD, AID, 0) === 'unknown')
  check('★ 空地址 / 非字符串都是 unknown（绝不抛）',
    subtitleIdentity('', AID, CID) === 'unknown'
    && subtitleIdentity(null, AID, CID) === 'unknown'
    && subtitleIdentity(undefined, AID, CID) === 'unknown')
  check('★ 查询串不参与判定（auth_key 每次都不一样）',
    subtitleIdentity(GOOD.replace(/\?.*$/, ''), AID, CID) === 'same')
}

/**
 * ── ⑥ 时间戳不许越过片长（CC 字幕唯一能做的弱校验）────────────────────
 */
{
  const DUR = 958 // 那条 15:58 的真实视频
  const mk = (last) => [{ from: 0, to: 1 }, { from: 1, to: last }]
  check('★ 正确字幕末条 957.8s / 片长 958s ⇒ 不算别人的', !subtitleLooksForeign(mk(957.8), DUR))
  check('★★ 脏样本 2937s（49 分钟）对 958s 片长 ⇒ 判出来', subtitleLooksForeign(mk(2937.16), DUR))
  check('★★ 脏样本 1114s（16% 超长）⇒ 判出来', subtitleLooksForeign(mk(1114.02), DUR))
  // 这条是**已知残余风险**：903.6s 落在 958s 之内，弱校验看不见它。
  // 写出来是为了钉住"弱校验有边界"，不是假装它能替代身份校验。
  check('⚠️ 已知盲区：903.6s 落在片长内 ⇒ 弱校验看不见（靠身份校验兜）',
    !subtitleLooksForeign(mk(903.6), DUR))
  check('★ 片长未知（0）时一律放行（不知道就别乱否）',
    !subtitleLooksForeign(mk(99999), 0))
  check('  空列表 / 没有 to 字段都不抛也不误判',
    !subtitleLooksForeign([], DUR)
    && !subtitleLooksForeign(null, DUR)
    && !subtitleLooksForeign([{ content: 'x' }], DUR))
}

/**
 * ── ⑦ AI 总结三态：有 / 平台确认没有 / 我们没拿到 ──────────────────────
 *
 * 踩过的事实错误：三种结果原来都是 `null`，于是"这次请求失败了"被写成
 * 「这条视频没有平台生成的 AI 总结」—— 一句她可能照着复述的假话。
 * 实测 `data.code` 能分开：958s 那条 0，11s 那条 1，2055s 那条 -1。
 */
{
  // 我们没拿到（超时/风控/未登录）⇒ 一个字都不许写
  check('★★★ unknown（null）⇒ 一句都不写（不确定的事不许写成结论）',
    conclusionNote(null) === '' && conclusionNote(undefined) === '')
  check('★★★ unknown 的措辞里不许出现「没有 AI 总结」这类断言',
    !conclusionNote(null).includes('没有') && !conclusionNote(undefined).includes('没有'))

  // 平台确认没有 ⇒ 这是事实，可以写，但必须说清是**平台**说的
  const absent = conclusionNote({ absent: true })
  check('★★ 平台确认没有 ⇒ 明说是平台确认（不是"我们没取到"）',
    absent.includes('平台确认') && absent.includes('没有生成'))
  check('★ absent 时不许渲染摘要/大纲骨架（那是空壳）',
    !absent.includes('整体摘要') && !absent.includes('分段大纲'))

  // 有总结 ⇒ 摘要 + 大纲都在，且说清是平台写的
  const note = conclusionNote({ summary: '这期视频讨论了压抑', outline: [{ title: '一', items: [{ at: 0, text: '先说结论' }] }] })
  check('★★ 有总结 ⇒ 说清是平台生成的（否则她会转述成"我看到的"）',
    note.includes('平台自己生成了 AI 总结'))
  check('★ 有总结 ⇒ 摘要与大纲都渲染进正文',
    note.includes('这期视频讨论了') && note.includes('0:00 先说结论'))
  check('★★ 有总结时正文仍走 dataBlock 围栏（第三方内容，防注入）',
    /\| 这期视频讨论了/.test(note) && /\| 0:00 先说结论/.test(note))
}

/**
 * ── ⑧ 字幕轨道优先级：人工中文 > AI 中文 > 任意中文 > 任意一条 ─────────────
 *
 * 依据是社区通行做法 + 一个实测事实：AI 字幕会把专有名词听错
 * （那条视频的 AI 字幕里 DeepSeek 是「deep sick」、UP 主名是「梁文峰」「非比啾比」）。
 * 同一视频若有人工 CC，那些字是对的 —— 差一个字她就可能把错名字当事实复述。
 *
 * ★ 另锁一条：`ai_type` **不能**当判据。实测同时有人工 12 轨的视频，
 * 12 条全是 `ai_type: 0`，唯一的信号是 `lan` 前缀。
 */
{
  const t = (lan, url = `//x/${lan}.json`) => ({ lan, subtitle_url: url })

  // 真实形状：BV1GJ411x7h7 的 12 条轨道，人工中文排在最前面
  const human12 = ['zh-CN', 'zh-Hans', 'zh-Hant', 'zh-HK', 'en-US', 'ja'].map((l) => t(l))
  check('★★ 有 12 条人工轨道时挑第一条人工中文', pickSubtitleTrack(human12)?.lan === 'zh-CN')

  // 关键场景：AI 轨道排在人工前面 —— 这才是会踩到的形状
  const aiFirst = [t('ai-zh'), t('zh-CN'), t('en-US')]
  check('★★★ AI 中文排在前面时，仍然挑人工中文（不是"第一条中文"）',
    pickSubtitleTrack(aiFirst)?.lan === 'zh-CN')

  check('★ 只有 AI 中文时用 AI 中文（聊胜于无）',
    pickSubtitleTrack([t('en-US'), t('ai-zh')])?.lan === 'ai-zh')
  check('★ 只有非中文轨道时挑一条（她能读英文/日文，总比啥都没有强）',
    pickSubtitleTrack([t('en-US'), t('ja')])?.lan === 'en-US')
  check('★ 中文繁体优先于英文（中文任意一档在非中文之上）',
    pickSubtitleTrack([t('en-US'), t('zh-Hant')])?.lan === 'zh-Hant')

  check('★ 没有 subtitle_url 的轨道直接跳过（空地址没法下）',
    pickSubtitleTrack([t('zh-CN', ''), t('ai-zh')])?.lan === 'ai-zh')
  check('★ 空列表 / 非数组 / null 都返回 null（绝不抛）',
    pickSubtitleTrack([]) === null && pickSubtitleTrack(null) === null && pickSubtitleTrack(undefined) === null)
  check('  列表里混进 null 也不炸',
    pickSubtitleTrack([null, t('zh-CN')])?.lan === 'zh-CN')
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
