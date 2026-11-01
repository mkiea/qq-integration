/**
 * videofetch.js —— 从一个**链接**把视频取到本地（2026-11-01）
 *
 * 她"看视频"这件事分两段：这段负责拿到文件，抽帧在 bridge 的 `#grabFrame`（早就有）。
 * 之前只有用户**直接发视频文件**才走得到抽帧；用户发的是链接时，那段路是断的。
 *
 * 为什么用 yt-dlp 而不是自己调 B 站接口：B 站 2023 起要 wbi 签名，抖音/微博各有一套反爬。
 * 自己实现既脆弱（平台一改版就死）又重复劳动；yt-dlp 是这几百个站点的事实标准，
 * 而且它是**外部可执行文件**——不进来就在配置里关掉，桥本身不新增 npm 依赖。
 *
 * 三个克制的地方（都是为了不让"看视频"变成一个又慢又贵的默认行为）：
 *   · 只取**前 N 秒**（默认 60）：`--download-sections`，不整片下；
 *   · 限**低分辨率**（≤360p）：抽帧只为了看清"画面里有什么"，不需要高清；
 *   · 有**大小上限**和超时：站点给个几百 MB 的流就立刻放弃，别把她的回复拖死。
 */
import { execFile } from 'node:child_process'
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 常见视频站的域名后缀（只用来决定"要不要试一下"，不是白名单）。
 *
 * ⚠️ 这里**不能放大后缀**：`zhihu.com` 会把知乎专栏文章也当成视频，
 * `qq.com` 更是几乎覆盖所有腾讯链接 —— 误判的代价是每张普通卡片都白跑一次
 * yt-dlp（3 秒起）然后失败，且失败是静默的（用户只觉得"她回得慢"）。
 * 所以只留**确定是视频**的域名，模糊的（如小红书图文笔记）宁可放过。
 */
export const VIDEO_SITE_SUFFIXES = [
  'bilibili.com', 'b23.tv', 'douyin.com', 'iesdouyin.com', 'kuaishou.com',
  'weibo.com', 'weibo.cn', 'xiaohongshu.com', 'xhslink.com', 'youtube.com', 'youtu.be',
  'v.qq.com', 'ixigua.com',
]

/** 这个链接看起来是不是视频页（决定要不要为它启动 yt-dlp）。 */
export function looksLikeVideoUrl(url) {
  let host = ''
  try { host = new URL(String(url ?? '')).hostname.toLowerCase() } catch { return false }
  return VIDEO_SITE_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}

/**
 * 构造 yt-dlp 参数。**单独抽出来是为了能单测**：
 * 这些参数一旦写错（比如 `-f` 选了 B 站没有的格式），表现是"下载失败"，
 * 而失败会被上层静默降级成"没看视频"——那种 bug 靠线上根本发现不了。
 *
 * @param {string} url
 * @param {{ outDir: string, maxSeconds?: number, ffmpegDir?: string }} options
 * @returns {string[]}
 */
export function buildYtDlpArgs(url, { outDir, maxSeconds = 60, ffmpegDir = '' } = {}) {
  const args = [
    '--no-warnings',
    '--no-playlist',
    // B 站是 dash 分轨：单给 `worst[ext=mp4]` 会报 "Requested format is not available"
    // （实测踩过）。`bv*+ba` 才是"任意画质视频 + 音频"的稳妥写法。
    '-f', 'bv*[height<=360]+ba/b[height<=360]/b',
    '--download-sections', `*0-${Math.max(1, Number(maxSeconds) || 60)}`,
    '-o', join(outDir, 'clip.%(ext)s'),
    // 只打印最终文件路径，方便调用方精确拿到产物（不要靠猜扩展名）
    '--print', 'after_move:filepath',
  ]
  if (ffmpegDir !== '') args.push('--ffmpeg-location', ffmpegDir)
  args.push('--', String(url))
  return args
}

function run(command, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: error === null, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error })
    })
  })
}

let cachedRunner = null

/**
 * 找到可用的 yt-dlp 调用方式。
 *
 * 顺序：配置里给的 → PATH 里的 `yt-dlp` → `<python> -m yt_dlp`。
 * 返回 `{ command, prefix }`，调用时拼成 `command + prefix + args`。
 *
 * @param {{ ytDlpPath?: string, pythonPath?: string }} options
 * @returns {Promise<{command: string, prefix: string[]} | null>}
 */
export async function resolveYtDlp({ ytDlpPath = '', pythonPath = '' } = {}) {
  if (cachedRunner !== null && ytDlpPath === '' && pythonPath === '') return cachedRunner
  const candidates = []
  if (ytDlpPath !== '') candidates.push({ command: ytDlpPath, prefix: [] })
  candidates.push({ command: 'yt-dlp', prefix: [] })
  if (pythonPath !== '') candidates.push({ command: pythonPath, prefix: ['-m', 'yt_dlp'] })
  candidates.push({ command: 'python', prefix: ['-m', 'yt_dlp'] })

  for (const candidate of candidates) {
    const result = await run(candidate.command, [...candidate.prefix, '--version'], 20_000)
    if (result.ok && /\d{4}\.\d{1,2}\.\d{1,2}/.test(result.stdout)) {
      if (ytDlpPath === '' && pythonPath === '') cachedRunner = candidate
      return candidate
    }
  }
  return null
}

/**
 * 下载视频的前 `maxSeconds` 秒到 `outDir`。
 *
 * **失败返回 null，不抛错** —— 上层据此"当没看过这条视频"，而不是让整轮回复挂掉。
 *
 * @param {string} url
 * @param {{ outDir: string, maxSeconds?: number, ffmpegDir?: string, ytDlp?: {command: string, prefix: string[]}, timeoutMs?: number, maxBytes?: number }} options
 * @returns {Promise<{ file: string, bytes: number } | null>}
 */
export async function downloadVideoClip(url, options = {}) {
  const {
    outDir,
    maxSeconds = 60,
    ffmpegDir = '',
    ytDlp = null,
    timeoutMs = 120_000,
    maxBytes = 40 * 1024 * 1024,
  } = options
  if (ytDlp === null) return null
  mkdirSync(outDir, { recursive: true })

  const args = buildYtDlpArgs(url, { outDir, maxSeconds, ffmpegDir })
  const result = await run(ytDlp.command, [...ytDlp.prefix, ...args], timeoutMs)
  if (!result.ok) return null

  // `--print after_move:filepath` 的输出就是产物路径；拿不到就退回扫目录
  const printed = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const candidate = printed.reverse().find((line) => line.includes('clip.') && !line.startsWith('['))
  let file = ''
  if (candidate && statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
    file = candidate
  } else {
    const found = readdirSync(outDir).filter((name) => name.startsWith('clip.'))
    if (found.length === 0) return null
    file = join(outDir, found[0])
  }

  const size = statSync(file).size
  if (size === 0 || size > maxBytes) {
    try { unlinkSync(file) } catch { /* 删不掉也没关系 */ }
    return null
  }
  return { file, bytes: size }
}
