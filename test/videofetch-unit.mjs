/**
 * videofetch.js 的测试（2026-11-01）。
 *
 * 这层的失败方式是**静默降级**（下载不到就当没看过视频），所以线上永远看不出 bug。
 * 只能靠单测钉住三件事：
 *   ① 参数构造对不对（`-f` 写错在 B 站上会直接报 "Requested format is not available"）；
 *   ② 站点的识别别把普通文章也当视频（否则每张卡片都白跑一次 3 秒的下载）；
 *   ③ 拿不到 yt-dlp 时返回 null 而不是抛错。
 */
import { buildYtDlpArgs, downloadVideoClip, looksLikeVideoUrl, resolveYtDlp } from '../lib/videofetch.js'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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
  check('用 bv*+ba 而不是 worst[ext=mp4]（B 站是分轨）', args.join(' ').includes('bv*[height<=360]+ba'))
  check('★ 不含会失败的 worst[ext=mp4] 写法', !args.includes('worst[ext=mp4]'))
  check('限了秒数', args.includes('--download-sections') && args.includes('*0-45'))
  check('--print after_move:filepath 用来精确拿产物', args.includes('--print') && args.includes('after_move:filepath'))
  check('ffmpeg 位置被传入', args.includes('--ffmpeg-location') && args.includes('C:\\bin'))
  check('URL 以 -- 结束参数区（防 URL 被当成选项）', args[args.length - 2] === '--' && args[args.length - 1] === 'https://www.bilibili.com/video/BV1xx')

  const noFfmpeg = buildYtDlpArgs('https://x.example/v', { outDir: 'D:\\no-such-dir' })
  check('没给 ffmpeg 目录就不加该参数', !noFfmpeg.includes('--ffmpeg-location'))
  check('默认 60 秒', noFfmpeg.includes('*0-60'))
  check('秒数非法时回退 60', buildYtDlpArgs('https://x/v', { outDir: 'o', maxSeconds: 'abc' }).includes('*0-60'))
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

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
