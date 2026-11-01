/**
 * 入站图片「落盘延迟」修复的单测（2026-11-01）。
 *
 * 修的是什么：用户报「表情包有时候用户会发图片过来，然后就识别不到了」。
 * 真机取证 —— 三条失败样本的文件 mtime 全都**晚于**失败日志：
 *   `411F….jpg` 晚 1.19 秒｜`E8BB….gif` 晚 0.10 秒｜`C3E7….jpg` 晚 0.05 秒
 * 而它们所在路径正是我们扫的 `Pic/<月>/Ori` 与 `Emoji/emoji-recv/<月>/Ori`。
 * ⇒ 不是路径错，是**问得太早**。原来的实现问一次就判死。
 *
 * 这组测试要钉两件事：
 *   ① 缓存文件名匹配看**主干**（扩展名、大小写、大小写与路径前缀都不该是判据）；
 *   ② 等待轮询**真的会等** —— 用假时钟 + 一条反向对照（`waitMs=0` 必须找不到）。
 * 第 ② 条是关键：只测"晚到的文件最终能找到"是测不出"没等"的，
 * 因为把 waitMs 设成 0 也照样能过（如果测试本身也用了假时钟的 bug）。
 */
import { imageStemOf, matchCachedImageName, waitForInboundImage } from '../lib/bridge.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) } else { failed++; console.log('FAIL', name, extra) }
}

/** 真机里失败过的那三个文件名（原样照抄，别改大小写）。 */
const REAL_FAILED = [
  'E8BB3A3F261B87686526F7C31F5340A5.gif',
  'C3E753BAAE3567DAE24AA16E9963A4BF.jpg',
  'C0BDD329745EFECBE879D448D3B7CF92.jpg',
]

// ── ① 主干提取 ───────────────────────────────────────────────
{
  check('★ 大写 hex + .gif 的主干被小写化',
    imageStemOf(REAL_FAILED[0]) === 'e8bb3a3f261b87686526f7c31f5340a5', imageStemOf(REAL_FAILED[0]))
  check('★ 带目录前缀也能取主干（有的实现给完整路径）',
    imageStemOf('C:\\QQ\\nt_data\\Pic\\2026-11\\Ori\\ABC123.jpg') === 'abc123')
  check('★ 没有扩展名但主干是 16 位以上 hex ⇒ 认（QQ 里确实有这种名字）',
    imageStemOf('E8BB3A3F261B87686526F7C31F5340A5') === 'e8bb3a3f261b87686526f7c31f5340a5')
  check('★ 普通中文名 + 图片扩展名也认',
    imageStemOf('表情1.JPG') === '表情1')
  check('★ 既不是图片名也不是 hash ⇒ 空串（别拿乱七八糟的名字去扫盘）',
    imageStemOf('abc') === '' && imageStemOf('') === '' && imageStemOf(null) === '')
}

// ── ② 缓存名匹配 ─────────────────────────────────────────────
{
  check('★★ 大小写不同 → 命中（Windows 不区分，但我们也不能靠它）',
    matchCachedImageName(REAL_FAILED[0], 'e8bb3a3f261b87686526f7c31f5340a5.gif'))
  check('★★ 扩展名不同 → 命中（主干是内容 hash，同一张图）',
    matchCachedImageName(REAL_FAILED[0], 'e8bb3a3f261b87686526f7c31f5340a5.jpg'))
  check('★ 缓存里那条不是图片扩展名 → 不命中（避免读到 .db / .tmp）',
    !matchCachedImageName(REAL_FAILED[0], 'e8bb3a3f261b87686526f7c31f5340a5.db'))
  check('★ 主干不同 → 不命中（不能"差不多就认"）',
    !matchCachedImageName(REAL_FAILED[0], 'e8bb3a3f261b87686526f7c31f5340a6.gif'))
  check('  三个真机文件名逐个自匹配',
    REAL_FAILED.every((name) => matchCachedImageName(name, name.toLowerCase())))
}

// ── ③ 等待轮询：假时钟下"第 N 轮才出现" ───────────────────────────
/**
 * 造一个「第 `appearAt` 轮才出现在缓存里」的假世界，时钟由 `sleepImpl` 推进，
 * 所以不必真等 2 秒，也不依赖真实时间（CI 上不会飘）。
 */
function fakeWorld({ appearAt = Infinity, ask = null, waitMs = 2000, pollMs = 250, askThrows = false } = {}) {
  let t = 0
  let round = 0
  const sleeps = []
  const findCache = () => {
    round += 1
    return round >= appearAt ? '/cache/hit.jpg' : ''
  }
  const askImage = askThrows
    ? async () => { throw new Error('boom') }
    : (ask === null ? null : async () => ask)
  return {
    sleeps,
    get round() { return round },
    run: () => waitForInboundImage({
      fileName: REAL_FAILED[0],
      askImage,
      findCache,
      waitMs,
      pollMs,
      now: () => t,
      sleepImpl: async (ms) => { sleeps.push(ms); t += ms },
    }),
  }
}

{
  const world = fakeWorld({ appearAt: 3 })
  const got = await world.run()
  check('★★★ 文件第 3 轮才落盘 ⇒ 仍然拿到（这就是"有时候看不到"的修法）',
    got.path === '/cache/hit.jpg' && got.source === 'cache', `rounds=${got.rounds}`)
  check('★★ 确实等了两次（不是"扫一次就返回"）',
    world.sleeps.length === 2 && world.sleeps.every((ms) => ms === 250), JSON.stringify(world.sleeps))

  /**
   * ★ 反向对照：把预算设成 0 ⇒ 只问一次 ⇒ **必须找不到**。
   * 没有这一条，上面那条即使实现根本不等也可能"过"（比如假世界自己在推进时间）。
   */
  const once = fakeWorld({ appearAt: 3, waitMs: 0 })
  const onceGot = await once.run()
  check('★★★ 反向对照：预算 0 ⇒ 只问一次 ⇒ 拿不到（证明上一条真的靠"等"）',
    onceGot.path === '' && once.sleeps.length === 0, `rounds=${onceGot.rounds}`)

  const never = fakeWorld({ appearAt: Infinity })
  const neverGot = await never.run()
  check('★★ 一直不出现 ⇒ 失败理由里**写明等过**（否则下次看日志会以为只问了一次）',
    neverGot.path === '' && neverGot.notes.some((n) => n.includes('等了 2000ms')),
    neverGot.notes.join(' | '))

  const world8 = fakeWorld({ appearAt: 99, waitMs: 2000 })
  const got8 = await world8.run()
  check('★ 轮数有上界（2 秒 / 250ms ⇒ 最多 8 次 sleep，不会无限等）',
    world8.sleeps.length === 8 && got8.path === '', `sleeps=${world8.sleeps.length}`)
}

// ── ④ 等待轮询：get_image 优先，且失败理由不刷屏 ──────────────────
{
  const hit = fakeWorld({ ask: '/qq/cache/x.jpg', appearAt: Infinity })
  const got = await hit.run()
  check('★★ get_image 有路径 ⇒ 直接用它，一轮就返回',
    got.path === '/qq/cache/x.jpg' && got.source === 'get_image' && got.rounds === 1)
  check('★ get_image 命中时不该再扫缓存（少一次盘扫）', hit.sleeps.length === 0)

  const boom = fakeWorld({ askThrows: true, appearAt: Infinity })
  const boomGot = await boom.run()
  check('★★ get_image 每轮都抛错 ⇒ 理由只记一条（8 轮同样的话只会刷屏）',
    boomGot.notes.filter((n) => n.includes('boom')).length === 1, boomGot.notes.join(' | '))

  const empty = await waitForInboundImage({ fileName: '', findCache: () => '/x.jpg' })
  check('★ 没有文件名 ⇒ 立刻返回，一次都不扫（不打空转）',
    empty.rounds === 0 && empty.path === '' && empty.notes.length === 0)

  const noAsk = fakeWorld({ appearAt: 1 })
  const noAskGot = await noAsk.run()
  check('★ 没有 get_image 通道时也能只靠缓存拿到',
    noAskGot.path === '/cache/hit.jpg' && noAskGot.source === 'cache')
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
