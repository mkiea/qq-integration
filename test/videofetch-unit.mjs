/**
 * videofetch.js 的测试（2026-11-01）。
 *
 * 这层的失败方式是**静默降级**（下载不到就当没看过视频），所以线上永远看不出 bug。
 * 只能靠单测钉住三件事：
 *   ① 参数构造对不对（`-f` 写错在 B 站上会直接报 "Requested format is not available"）；
 *   ② 站点的识别别把普通文章也当视频（否则每张卡片都白跑一次 3 秒的下载）；
 *   ③ 拿不到 yt-dlp 时返回 null 而不是抛错。
 */
import { buildYtDlpArgs, downloadVideoClip, isBilibiliUrl, looksLikeVideoUrl, resolveYtDlp } from '../lib/videofetch.js'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) } else { failed++; console.log('FAIL', name, extra) }
}

// ── ① 站点识别：正反都验 ─────────────────────────────────────────────
{
  const yes = [
    'https://www.bilibili.com/video/BV1xx411c7mD',
    'https://b23.tv/abcdef',
    'https://v.douyin.com/iRxxxx/',
    'https://weibo.com/tv/show/1034:xxx',
    'https://www.youtube.com/watch?v=abc',
    'https://youtu.be/abc',
  ]
  for (const url of yes) check(`识别视频站 ${new URL(url).hostname}`, looksLikeVideoUrl(url) === true)

  const no = [
    'https://zhuanlan.zhihu.com/p/123',
    'https://some-blog.example/post/1',
    'https://github.com/x/y',
    'not-a-url',
    '',
  ]
  for (const url of no) check(`不误判为视频站 ${url || '(空)'}`, looksLikeVideoUrl(url) === false)

  // 反向对照：后缀匹配不能把 `notbilibili.com` 当成 bilibili
  check('★ 后缀匹配不会误伤相似域名', looksLikeVideoUrl('https://notbilibili.com/x') === false)
}

// ── ② 参数构造 ───────────────────────────────────────────────────────
{
  const args = buildYtDlpArgs('https://www.bilibili.com/video/BV1xx', {
    outDir: 'D:\\no-such-dir\\out', maxSeconds: 45, ffmpegDir: 'C:\\bin',
  })
  check('带 --no-playlist（别把整个合集下下来）', args.includes('--no-playlist'))
  check('用 bv*+ba 而不是 worst[ext=mp4]（B 站是分轨）', args.join(' ').includes('bv*[height<=720]+ba'))
  check('★ 不含会失败的 worst[ext=mp4] 写法', !args.includes('worst[ext=mp4]'))
  check('限了秒数', args.includes('--download-sections') && args.includes('*0-45'))
  check('--print after_move:filepath 用来精确拿产物', args.includes('--print') && args.includes('after_move:filepath'))
  check('ffmpeg 位置被传入', args.includes('--ffmpeg-location') && args.includes('C:\\bin'))
  check('URL 以 -- 结束参数区（防 URL 被当成选项）', args[args.length - 2] === '--' && args[args.length - 1] === 'https://www.bilibili.com/video/BV1xx')

  const noFfmpeg = buildYtDlpArgs('https://x.example/v', { outDir: 'D:\\no-such-dir' })
  check('没给 ffmpeg 目录就不加该参数', !noFfmpeg.includes('--ffmpeg-location'))
  check('默认 60 秒', noFfmpeg.includes('*0-60'))
  check('秒数非法时回退 60', buildYtDlpArgs('https://x/v', { outDir: 'o', maxSeconds: 'abc' }).includes('*0-60'))

  /**
   * 画质：默认 720（原来卡 360，抽出来的帧里中文字幕是糊的 —— 实测对比过）。
   * 这里钉住三件事：默认值、可配置、以及**上限做法**（`height<=N` 而不是 `height=N`）。
   */
  check('★ 默认画质上限是 720（360 的字幕糊到读不出）', noFfmpeg.join(' ').includes('height<=720'))
  check('upper bound 写法是 <= 而不是 =（片源没 720 时不能直接失败）',
    !noFfmpeg.join(' ').includes('height=720'))
  check('画质可配置', buildYtDlpArgs('https://x/v', { outDir: 'o', maxHeight: 480 }).join(' ').includes('height<=480'))
  check('画质非法值回退 720', buildYtDlpArgs('https://x/v', { outDir: 'o', maxHeight: 'abc' }).join(' ').includes('height<=720'))
  check('画质被夹在 144–1080', buildYtDlpArgs('https://x/v', { outDir: 'o', maxHeight: 9999 }).join(' ').includes('height<=1080'))
}

// ── ③ 降级路径 ───────────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'videofetch-'))
  try {
    // 没有 yt-dlp → 立刻 null，不抛错（上层据此"当没看过"）
    const none = await downloadVideoClip('https://www.bilibili.com/video/BV1xx', { outDir: dir, ytDlp: null })
    check('★ 没有 yt-dlp 时返回 null 而不是抛错', none === null)

    // 让"yt-dlp"指向一个不存在的命令，同样要 null
    const bad = await downloadVideoClip('https://www.bilibili.com/video/BV1xx', {
      outDir: dir, ytDlp: { command: 'definitely-not-yt-dlp-xyz', prefix: [] }, timeoutMs: 5000,
    })
    check('命令不存在时返回 null', bad === null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── ④ resolveYtDlp：本机装了就该找到 ────────────────────────────────
{
  /**
   * yt-dlp 常常**不在 PATH 里**（本机就装在某个 Python env 的 Scripts 下）。
   * 这里按"可能的位置"探测，而不是硬编码某个用户名 —— 探测不到就如实 SKIP，
   * 不假装通过（那样"看视频"整条路断了也发现不了）。
   */
  const candidates = [
    process.env.RIN_YTDLP_PYTHON,
    join(homedir(), '.workbuddy', 'binaries', 'python', 'envs', 'train-gpu', 'Scripts', 'python.exe'),
  ].filter(Boolean)
  const pythonPath = candidates.find((p) => existsSync(p)) ?? ''

  const found = await resolveYtDlp({ pythonPath })
  check('★ 能解析出 yt-dlp（否则"看视频"整条路都不通）', found !== null,
    found === null ? `没找到（试过 pythonPath=${pythonPath || '(空)'}）` : `${found.command} ${found.prefix.join(' ')}`.trim())

  // 反向对照：给一个不存在的路径不该被当成"找到了"
  const bogus = await resolveYtDlp({ ytDlpPath: 'C:\\nope\\yt-dlp.exe' })
  check('显式给错路径时不会误报', bogus === null || bogus.command !== 'C:\\nope\\yt-dlp.exe',
    bogus === null ? 'null' : bogus.command)
}

// ── ⑤ 死线与凭证边界（2026-11-01 事故之后补的）────────────────────────
{
  const args = buildYtDlpArgs('https://www.bilibili.com/video/BV1xx', { outDir: 'o' })
  /**
   * 事故：一次 B 站卡片下载跑满 120 秒被我们掐掉，日志里没有原因。
   * 参数侧的对策是"三道死线"，缺哪一道都可能退回到"无声卡住"：
   * 没有 socket-timeout ⇒ 连接层可以永远等；没有 --retry-sleep ⇒ yt-dlp 自己指数退避
   * （1+2+4+8…）就把预算吃光；没有 retries 上限 ⇒ 分片重试各自叠加。
   */
  check('★ 有 --socket-timeout（连接层别无限等）', args.includes('--socket-timeout') && args[args.indexOf('--socket-timeout') + 1] === '10')
  check('★ 有 --retries 上限', args.includes('--retries') && args[args.indexOf('--retries') + 1] === '1')
  check('★ retry-sleep 固定 1 秒（关掉指数退避）', args.includes('--retry-sleep') && args[args.indexOf('--retry-sleep') + 1] === '1')
  check('★ 有 --fragment-retries 上限', args.includes('--fragment-retries') && args[args.indexOf('--fragment-retries') + 1] === '1')

  // 凭证边界：biliCookie 是账号登录态，绝不能跟着别的站点出去
  check('B 站域名被识别', isBilibiliUrl('https://www.bilibili.com/video/BV1xx') === true)
  check('短链 b23.tv 被识别', isBilibiliUrl('https://b23.tv/l4bHIzO?share_source=qq') === true)
  check('★ 相似域名不算 B 站（notbilibili.com）', isBilibiliUrl('https://notbilibili.com/x') === false)
  check('★ 别的视频站不算 B 站', isBilibiliUrl('https://www.youtube.com/watch?v=1') === false)

  const withCookie = buildYtDlpArgs('https://b23.tv/l4bHIzO?x=1', { outDir: 'o', cookie: 'SESSDATA=abc; bili_jct=def' })
  check('★ 给了 cookie 且在 B 站 ⇒ 带 Cookie 头',
    withCookie.includes('--add-header') && withCookie[withCookie.indexOf('--add-header') + 1] === 'Cookie: SESSDATA=abc; bili_jct=def')

  const leak = buildYtDlpArgs('https://www.youtube.com/watch?v=1', { outDir: 'o', cookie: 'SESSDATA=abc' })
  check('★★ cookie 不会发给非 B 站（账号凭证不外流）', !leak.includes('--add-header') && !leak.join(' ').includes('SESSDATA'))

  check('没配 cookie 就不加头', !buildYtDlpArgs('https://www.bilibili.com/video/BV1xx', { outDir: 'o' }).includes('--add-header'))

  // 头注入：cookie 里混进换行 = 能塞任意额外头
  const injected = buildYtDlpArgs('https://www.bilibili.com/video/BV1xx', {
    outDir: 'o', cookie: 'SESSDATA=abc\r\nX-Evil: 1',
  })
  const header = injected[injected.indexOf('--add-header') + 1] ?? ''
  check('★★ cookie 里的换行被剥掉（防 HTTP 头注入）', !/[\r\n]/.test(header) && header.startsWith('Cookie: '),
    JSON.stringify(header))
}

// ── ⑥ 超时/空产物必须被诊断看见（而不是静默 null）─────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'videofetch-diag-'))
  /**
   * 用 node 自己当"被测程序"，是为了不引入 sleep/ping 这类平台差异。
   * ⚠️ 必须写成**脚本文件**放在 prefix，不能写成 `-e <code>`：node 会把 `-e` 之后的
   * `--download-sections` 当成自己的选项去解析，直接非零退出 —— 那样测到的是
   * "参数被 node 拒了"，不是"卡住被我们掐了"。（第一次就是这么写错的，两条全红。）
   */
  const hangScript = join(dir, 'hang.mjs')
  const quietScript = join(dir, 'quiet.mjs')
  writeFileSync(hangScript, 'setTimeout(() => {}, 8000)\n')
  writeFileSync(quietScript, 'process.exit(0)\n')
  try {
    // ① 卡住的命令 + 很短的 timeout ⇒ 必须报 timedOut，且不抛错
    const events = []
    const hung = await downloadVideoClip('https://www.bilibili.com/video/BV1xx', {
      outDir: join(dir, 'a'),
      ytDlp: { command: process.execPath, prefix: [hangScript] },
      timeoutMs: 1200,
      attempts: 1,
      onError: (info) => events.push(info),
    })
    check('★ 卡住时返回 null 而不是抛错', hung === null)
    check('★ 卡住时 onError 被调用（否则日志又只剩一句"没拿到"）', events.length === 1, `events=${events.length}`)
    check('★★ timedOut 判得出来（只认 killed，不去 message 里找 ETIMEDOUT）', events[0]?.timedOut === true,
      JSON.stringify({ killed: events[0]?.killed, signal: events[0]?.signal, stage: events[0]?.stage, exit: events[0]?.exitCode }))
    check('诊断里带完整命令（能直接复制去手工复现）', String(events[0]?.command ?? '') !== '' && Array.isArray(events[0]?.args))
    check('诊断里带参数列表且含 --download-sections', (events[0]?.args ?? []).includes('--download-sections'))

    // ② 退出码 0 但没产物 ⇒ 是另一种事故（'no-artifact'），不能与"被掐"混为一谈
    const events2 = []
    const empty = await downloadVideoClip('https://www.bilibili.com/video/BV1xx', {
      outDir: join(dir, 'b'),
      ytDlp: { command: process.execPath, prefix: [quietScript] },
      timeoutMs: 5000,
      attempts: 1,
      onError: (info) => events2.push(info),
    })
    check('空产物时返回 null', empty === null)
    check('★★ 空产物被标成 no-artifact（与超时可区分）', events2[0]?.stage === 'no-artifact',
      `stage=${events2[0]?.stage} exit=${events2[0]?.exitCode}`)
    check('空产物不算超时', events2[0]?.timedOut === false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── ⑦ 重试：第一次卡住/空手，第二次必须真的再跑一遍 ────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'videofetch-retry-'))
  const marker = join(dir, 'first-run-happened')
  /**
   * 这个"假 yt-dlp"模拟线上那 20% 的坏情况：第一次空手而归，
   * 第二次（新进程、新目录）才产出文件。
   * ★ 关键在断言"真的换了新进程"：如果实现只是把同一个进程再等一会儿，
   *   第二次仍然空手，这条测试会红。
   */
  const script = join(dir, 'flaky.mjs')
  writeFileSync(script, [
    "import { existsSync, writeFileSync } from 'node:fs'",
    `const marker = ${JSON.stringify(marker)}`,
    "if (existsSync(marker)) {",
    "  writeFileSync('clip.mp4', Buffer.alloc(2048))",
    "} else {",
    "  writeFileSync(marker, '1')",
    "}",
    '',
  ].join('\n'))
  try {
    const events = []
    const clip = await downloadVideoClip('https://www.bilibili.com/video/BV1xx', {
      outDir: join(dir, 'work'),
      ytDlp: { command: process.execPath, prefix: [script] },
      timeoutMs: 8000,
      attempts: 2,
      onError: (info) => events.push(info),
    })
    check('★★ 第一次空手、第二次成功 ⇒ 整体成功（重试真的换了新进程）', clip !== null && clip.bytes === 2048,
      JSON.stringify(clip))
    check('第一次的失败被记成第 1/2 次', events[0]?.attempt === 1 && events[0]?.attempts === 2,
      JSON.stringify({ attempt: events[0]?.attempt, attempts: events[0]?.attempts }))
    check('两次尝试各用一个独立目录（残片不会污染重试）', (clip?.file ?? '').includes('try-2'),
      String(clip?.file))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * ★ 多段采样下载的参数形状（2026-11-01 晚）。
 *
 * 这里钉的是一个**实测踩出来的静默坑**：多段下载如果用同一个 `-o` 名字，
 * yt-dlp 只保留第一段，后面每段都打印 "has already been downloaded" 然后跳过 ——
 * 退出码 0、日志正常、产物只有一段（实测 3 段 × 10 秒只得 10.01 秒）。
 * 所以断言不是"参数里有 section"，而是**文件名模板里必须带时间偏移**。
 */
{
  const sections = [{ start: 100, end: 120 }, { start: 528, end: 548 }]
  const args = buildYtDlpArgs('https://www.bilibili.com/video/BV1xx411c7mD', { outDir: 'C:/x', sections })
  const at = (flag) => args.reduce((acc, v, i) => (v === flag ? [...acc, args[i + 1]] : acc), [])

  const ranges = at('--download-sections')
  check('多段：每段一个 --download-sections', ranges.length === 2, JSON.stringify(ranges))
  check('多段：区间写成 *start-end（左闭右开的秒数）', ranges[0] === '*100-120' && ranges[1] === '*528-548', JSON.stringify(ranges))

  check('★★ 多段：输出名带 %(section_start)s（否则只有第一段落盘）',
    String(at('-o')[0]).includes('%(section_start)s'), String(at('-o')[0]))
  check('★★ 多段：--print 把时间偏移和路径一起打出来（靠文件名解析太脆）',
    String(at('--print')[0]).includes('%(section_start)s|'), String(at('--print')[0]))
  check('多段默认只要音轨（画面走缩略图，视频轨纯属白下）',
    String(at('-f')[0]).startsWith('ba'), String(at('-f')[0]))

  // 反向对照：单段仍然是原来那套，不能被多段分支污染
  const single = buildYtDlpArgs('https://www.bilibili.com/video/BV1xx411c7mD', { outDir: 'C:/x', maxSeconds: 60 })
  const sAt = (flag) => single.reduce((acc, v, i) => (v === flag ? [...acc, single[i + 1]] : acc), [])
  check('★★ 反向对照：不传 sections 时仍是单段老样子（*0-60 + clip. + 纯路径）',
    sAt('--download-sections')[0] === '*0-60'
    && String(sAt('-o')[0]).endsWith('clip.%(ext)s')
    && sAt('--print')[0] === 'after_move:filepath',
    JSON.stringify({ r: sAt('--download-sections')[0], o: sAt('-o')[0], p: sAt('--print')[0] }))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
