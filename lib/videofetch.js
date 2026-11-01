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
 * 是不是 B 站系域名（`bilibili.com` / 短链 `b23.tv`）。
 *
 * 单独一个函数是因为它守的**不是**功能、而是凭证边界：
 * `biliCookie` 是整个账号的登录态，只能发给 B 站。
 * 把它"顺手"传给 youtube/douyin 等于把账号送出去 —— 而这种错不会报错，
 * 只会在某天被人拿日志翻出来。所以下 Cookie 之前必须先过这一关。
 */
export function isBilibiliUrl(url) {
  let host = ''
  try { host = new URL(String(url ?? '')).hostname.toLowerCase() } catch { return false }
  return host === 'bilibili.com' || host.endsWith('.bilibili.com') || host === 'b23.tv'
}

/**
 * 构造 yt-dlp 参数。**单独抽出来是为了能单测**：
 * 这些参数一旦写错（比如 `-f` 选了 B 站没有的格式），表现是"下载失败"，
 * 而失败会被上层静默降级成"没看视频"——那种 bug 靠线上根本发现不了。
 *
 * @param {string} url
 * @param {{ outDir: string, maxSeconds?: number, maxHeight?: number, ffmpegDir?: string, cookie?: string, audioOnly?: boolean, sections?: {start: number, end: number}[] | null }} options
 * @returns {string[]}
 */
export function buildYtDlpArgs(url, { outDir, maxSeconds = 60, maxHeight = 720, ffmpegDir = '', cookie = '', audioOnly = false, sections = null } = {}) {
  const height = Math.max(144, Math.min(1080, Number(maxHeight) || 720))
  const multi = Array.isArray(sections) && sections.length > 0
  /**
   * ★ 多段采样**永远是只要音轨**，不看调用方传了什么（2026-11-01 晚）。
   *
   * 多段这条路唯一的用途是取台词（画面由平台缩略图提供），所以视频轨一定是白下的。
   * 而这个"白下"的量级很吓人：8 段 × 720p 视频轨 ≈ 30-50MB，
   * 恰好是最该被限制的那种浪费。靠调用方记得传 `audioOnly: true` 是不可靠的
   * （单测就是按"漏传"写的，一跑就红）—— 所以把它钉在函数内部。
   */
  const wantAudioOnly = audioOnly || multi
  const args = [
    '--no-warnings',
    '--no-playlist',
    /**
     * ★ 2026-11-01：**必须给死线**，否则"卡住"会静默吃掉整个回复窗口。
     *
     * 事故现场：用户在 QQ 发了一张 B 站小程序卡片，桥这边 yt-dlp 一直跑，
     * 到我们自己的 120 秒上限才被掐掉 —— 期间她一个字都说不出，
     * 而日志里**一句原因都没有**（stderr 被旧代码吞了）。
     * 用完全相同的命令手工跑却只要 4 秒。
     *
     * 教训是"无死线的外部命令"本身就是 bug，不该等它真的卡住才发现：
     *   · `--socket-timeout 10`：连接层面别等默认值，卡住就报错；
     *   · `--retries 1` + `--retry-sleep 1`：抖动还能自愈一次，但**指数退避关掉**
     *     （默认退避 1+2+4+8… 秒，攒到 120 秒就是这么来的）；
     *   · `--fragment-retries 1`：分片重试同理，别各自退避。
     * 剩下的靠**外层每次尝试一个新进程**（见 downloadVideoClip），
     * 而不是让一个已经卡住的进程自己再试 —— 卡住的进程重试还是卡住。
     */
    '--socket-timeout', '10',
    '--retries', '1',
    '--fragment-retries', '1',
    '--retry-sleep', '1',
    /**
     * 画质：默认 <=720p（2026-11-01 从 360p 提上来）。
     *
     * 为什么改：原来卡 360p 是为了省流量，但抽帧是**给她看画面**的，
     * 360p 的画面里叠加字幕、界面小字、招牌文字全是糊的 ——
     * 同一帧对比过：360p 只读得出 UP 主水印的大字，720p 连背景霓虹招牌上的字都读得出。
     * 代价实测很小：同一条 60 秒片子 2.0MB/4.5s → 3.3MB/7.2s。
     * 对"这条视频到底在说什么"来说，这点流量换到的信息量是划算的。
     *
     * ⚠️ 仍然封顶：`height<=N` 是上限不是强制，片源本身是 360p 就还是 360p（不会拉大）。
     */
    /**
     * ★ 只下音轨时优先要**低码率**那一档（2026-11-01 晚）。
     *
     * 用途是喂 ASR，16 kHz 单声道重编码之后 66kbps 和 133kbps 转出来的识别结果没有区别，
     * 而体积差一倍（同一条 958 秒片：15.19MiB vs 7.55MiB）。
     *
     * ⚠️ 但**别指望它变快**：实测 8 段换成 66kbps 后体积从 2.60MB 降到 1.28MB，
     * 耗时反而从 9.6 秒变成 10.9 秒 —— 多段下载的成本是每段一次 HTTP range + 一次
     * ffmpeg 启动（约 1.3 秒/段），不是带宽。省下的是**流量**，不是时间。
     * 对"用手机流量跑桥"的场景仍然值得，所以保留。
     *
     * 没有 `abr` 元数据的站点（或只有一档音频）会自然退回 `ba/b`。
     */
    '-f', wantAudioOnly ? 'ba[abr<=72]/ba/b' : `bv*[height<=${height}]+ba/b[height<=${height}]/b`,
    /**
     * ★ 2026-11-01 晚：`sections` 分支 = **多段采样下载**（全片台词用）。
     *
     * 起因：用户「不过好像只看了一分钟，没看完」。画面已经改走全片缩略图，
     * 台词还卡在前 60 秒。而台词没法照搬缩略图（平台不提供文字时间轴，AI 字幕要登录），
     * 所以只能自己去音轨上取几段。
     *
     * 三条实测数字决定了参数形状：
     *   · 全片音轨 15.9MB / 约 48 秒 —— 超过每次尝试的 20 秒上限，不能用；
     *   · 8 段 × 20 秒 = 2.70MB / **8.4 秒**（一次 yt-dlp 调用出 8 个文件）；
     *   · 单次转写有 4MiB 硬上限（= 131 秒音频），所以各段必须**分次**转写。
     *
     * ⚠️ 这里踩过一个**不报错**的坑，写下来别再踩：
     * 多段下载如果 `-o` 用同一个文件名（如 `seg.%(ext)s`），yt-dlp 只会保留**第一段**，
     * 后面每段都打印 `has already been downloaded` 然后跳过 —— 命令成功、退出码 0，
     * 产物却只有一段（实测 3 段 × 10 秒只得 10.01 秒）。
     * 所以多段必须用 `%(section_start)s` 进文件名，让每段各落一个文件；
     * 顺带这个字段就是**时间偏移本身**，回到上层不用猜哪段是哪段。
     */
    ...(multi
      ? sections.flatMap((s) => ['--download-sections', `*${s.start}-${s.end}`])
      : ['--download-sections', `*0-${Math.max(1, Number(maxSeconds) || 60)}`]),
    '-o', join(outDir, multi ? 'seg-%(section_start)s.%(ext)s' : 'clip.%(ext)s'),
    /**
     * 只打印最终文件路径，方便调用方精确拿到产物（不要靠猜扩展名）。
     * 多段时把时间偏移一起打出来 —— 靠文件名解析 at 太脆（小数点、负号、站点自定义名都可能变）。
     */
    '--print', multi ? 'after_move:%(section_start)s|%(filepath)s' : 'after_move:filepath',
  ]
  if (ffmpegDir !== '') args.push('--ffmpeg-location', ffmpegDir)
  /**
   * 登录态只在 B 站范围内生效（`biliCookie` 是账号凭证，详见 `isBilibiliUrl`）。
   * 走 `--add-header Cookie:` 而不是临时 cookie 文件：少一个落盘的东西要清理，
   * 而且 yt-dlp 对 header 形式的 cookie 支持很好。换行必须剥掉 ——
   * 一个带 `\n` 的"头"能注入任意额外头，那是 HTTP 头注入，不是配置错误。
   */
  if (cookie !== '' && isBilibiliUrl(url)) {
    args.push('--add-header', `Cookie: ${String(cookie).replace(/[\r\n]+/g, ' ').trim()}`)
  }
  args.push('--', String(url))
  return args
}

/**
 * 跑一个外部命令。
 *
 * cwd 显式给（默认仍是继承），理由与最初猜的那条**不同**：
 *
 * 一开始我把"手工能跑、桥里不能"归因成继承到了已删除的临时目录（spawn ENOENT）。
 * 那次归因是**错的** —— trace 里这次失败耗时 120820ms，而 spawn 失败是毫秒级的。
 * 真正发生的是 yt-dlp 自己跑满了我们的 120 秒上限（详见 buildYtDlpArgs 的死线说明）。
 *
 * 但显式 cwd 仍然保留：一是让产物路径与宿主状态解耦（outDir 由我们自己建、一定存在），
 * 二是 `--print after_move:filepath` 回的可能就是相对路径，cwd 不定就解析错。
 */
function run(command, args, timeoutMs, cwd = undefined) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, cwd }, (error, stdout, stderr) => {
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
 * ★ 2026-11-01：默认**会重试一次**（`attempts`）。原因是实测出来的，不是保险起见：
 * 同一个 URL、同一台机器、同样参数，连续跑 10 次里有 2 次 yt-dlp 会**一声不响地卡住**
 * （stdout / stderr 全空、也没有退出码，只有我们自己的超时能掐断它），
 * 而另外 8 次都在 3.5–7.2 秒内正常下完。卡住的那几次与参数组合无关
 * （`--retries 2` 单独跑卡过，"四个参数全开"反倒成功过）⇒ 是外部随机因素
 * （B 站会按次分配不同 CDN，我们拿到的那个 host 可能解析不了 / 连不上）。
 * 对这种"换个进程就大概率好了"的故障，唯一有效的处理是**换一个新进程重来**。
 *
 * @param {string} url
 * @param {{ outDir: string, maxSeconds?: number, ffmpegDir?: string, cookie?: string, ytDlp?: {command: string, prefix: string[]}, timeoutMs?: number, attempts?: number, maxBytes?: number, onError?: Function }} options
 * @returns {Promise<{ file: string, bytes: number } | null>}
 */
export async function downloadVideoClip(url, options = {}) {
  const {
    outDir,
    maxSeconds = 60,
    maxHeight = 720,
    ffmpegDir = '',
    cookie = '',
    ytDlp = null,
    /**
     * **单次尝试**的硬上限 20 秒（原 120 秒）。60 秒 360p 只有约 2MB，本机实测 3.5–7 秒下完；
     * 20 秒已经是 3 倍余量。这个数字是从用户那头算的，不是从任务那头算的 ——
     * 下载期间她一个字都说不出来，2 分钟静默比"没看到她说的那个视频"更糟。
     */
    timeoutMs = 20_000,
    attempts = 2,
    maxBytes = 40 * 1024 * 1024,
    onError = null,
    /**
     * 只下**音轨**（2026-11-01）。画面改由全片缩略图提供时，视频轨纯属白下：
     * 958 秒的视频轨约 33MB，音轨只有 6-8MB。
     */
    audioOnly = false,
  } = options
  if (ytDlp === null) return null
  mkdirSync(outDir, { recursive: true })

  const tries = Math.max(1, Math.min(3, Number(attempts) || 1))
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    /**
     * 每次尝试用**独立子目录**：被掐断的那次会留下 `clip.mp4.part`，
     * 同一个目录重来时 yt-dlp 会去"续传"这份残片，而 `--download-sections` 的残片
     * 在 ffmpeg 拼接阶段会直接报错 —— 于是"重试"变成"必然再失败一次"。
     */
    const attemptDir = tries === 1 ? outDir : join(outDir, `try-${attempt}`)
    // eslint-disable-next-line no-await-in-loop
    const got = await attemptDownload(url, {
      outDir: attemptDir, maxSeconds, maxHeight, ffmpegDir, cookie, audioOnly, ytDlp, timeoutMs, maxBytes, onError, attempt, tries,
    })
    if (got !== null) return got
  }
  return null
}

/** 单次下载尝试。成功返回产物，失败（含超时）返回 null 并把原因交给 onError。 */
async function attemptDownload(url, { outDir, maxSeconds, maxHeight, ffmpegDir, cookie, audioOnly, ytDlp, timeoutMs, maxBytes, onError, attempt, tries }) {
  mkdirSync(outDir, { recursive: true })

  const args = buildYtDlpArgs(url, { outDir, maxSeconds, maxHeight, ffmpegDir, cookie, audioOnly })
  const command = ytDlp.command
  const fullArgs = [...ytDlp.prefix, ...args]
  /**
   * ★ 2026-11-01：失败时必须能看见**为什么**。
   *
   * 之前 `if (!result.ok) return null` 把 yt-dlp 的 stderr 整个吞掉，
   * 于是桥的日志只剩一句「yt-dlp 没拿到片段」—— 而手工用**同样的参数**跑是成功的。
   * 「同样的命令一好一坏」这种问题，没有 stderr 就只能猜；所以这里把退出码、
   * 完整命令和 stderr 尾巴交给调用方去打日志（不自己打，是为了保持这个模块无日志副作用）。
   */
  const report = (stage, result) => {
    if (typeof onError !== 'function') return
    try {
      onError({
        stage,
        attempt,
        attempts: tries,
        exitCode: result?.error?.code ?? null,
        killed: result?.error?.killed === true,
        signal: result?.error?.signal ?? null,
        /**
         * ⚠️ 超时只能用 `killed` 判，**不能去 message 里找 ETIMEDOUT**。
         * `execFile` 的 `timeout` 是到期直接 SIGTERM，回调里给的是
         * `{ killed: true, signal: 'SIGTERM', code: null, message: 'Command failed: ...' }`
         * —— 里面根本没有 ETIMEDOUT 这个词（那是 spawn 失败时的 errno）。
         * 第一版这么写会得出 `timedOut: false`，而它恰恰是这轮要查的那个字段。
         * `killed` 在 execFile 里只有我们自己的 timeout 会置位，所以它就是"我们掐的"。
         */
        timedOut: result?.error?.killed === true,
        command,
        args: fullArgs,
        stdout: result?.stdout ?? '',
        stderr: String(result?.stderr ?? '').slice(-600),
        message: result?.error?.message ?? '',
      })
    } catch { /* 诊断不该影响主流程 */ }
  }

  const result = await run(command, fullArgs, timeoutMs, outDir)
  if (!result.ok) {
    report('spawn-or-exit', result)
    return null
  }

  // `--print after_move:filepath` 的输出就是产物路径；拿不到就退回扫目录
  const printed = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const candidate = printed.reverse().find((line) => line.includes('clip.') && !line.startsWith('['))
  let file = ''
  if (candidate && statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
    file = candidate
  } else {
    const found = readdirSync(outDir).filter((name) => name.startsWith('clip.'))
    if (found.length === 0) {
      // 退出码 0 但既没有 stdout 路径、目录里也没有产物 —— 与"跑了但失败"是不同的事故
      report('no-artifact', result)
      return null
    }
    file = join(outDir, found[0])
  }

  const size = statSync(file).size
  if (size === 0 || size > maxBytes) {
    if (typeof onError === 'function') {
      try { onError({ stage: 'bad-size', attempt, attempts: tries, bytes: size, maxBytes, file }) } catch { /* ignore */ }
    }
    try { unlinkSync(file) } catch { /* 删不掉也没关系 */ }
    return null
  }
  return { file, bytes: size }
}

/**
 * 按**一组时间点**从一条视频里取几小段音轨（2026-11-01 晚）。
 *
 * 和 `downloadVideoClip` 的关系：那个取"开头连续 N 秒"，这个取"全片均匀的 N 小段"。
 * 用途不同 —— 画面可以靠平台缩略图覆盖全片，台词没有等价物（B 站 AI 字幕要登录，
 * 匿名接口直接 `need_login_subtitle: true`），只能自己去音轨上采。
 *
 * 为什么必须是**一次调用多段**而不是 for 循环调 N 次：
 * 每次 yt-dlp 都要重新走一遍 B 站的解析（~2 秒），8 次就是 16 秒纯开销。
 * 一次调用带 8 个 `--download-sections` 实测 8.4 秒（2.70MB），其中解析只算一次。
 *
 * 失败语义与 `downloadVideoClip` 一致：**返回 null 不抛错**，上层降级成"只有画面"。
 * 但段数少一点**不算失败** —— 5 段比 0 段有用，多出来的是覆盖率不是正确性。
 *
 * @param {string} url
 * @param {{ outDir: string, sections: {start: number, end: number}[], ffmpegDir?: string, cookie?: string, ytDlp?: {command: string, prefix: string[]}, timeoutMs?: number, attempts?: number, maxBytes?: number, onError?: Function }} options
 * @returns {Promise<{at: number, file: string, bytes: number}[] | null>} 按 at 升序
 */
export async function downloadVideoSections(url, options = {}) {
  const {
    outDir,
    sections = [],
    ffmpegDir = '',
    cookie = '',
    ytDlp = null,
    /**
     * 单次上限 30 秒（`downloadVideoClip` 是 20 秒）。实测 8 段 2.70MB 用 8.4 秒，
     * 但那是本机白天、单条视频的数字；站点抽风时多给一点余量，
     * 否则"最该看全片的长视频"恰好最先被掐掉。
     */
    timeoutMs = 30_000,
    attempts = 2,
    maxBytes = 40 * 1024 * 1024,
    onError = null,
  } = options
  if (ytDlp === null) return null
  const list = (Array.isArray(sections) ? sections : [])
    .map((s) => ({ start: Math.max(0, Math.floor(Number(s?.start) || 0)), end: Math.ceil(Number(s?.end) || 0) }))
    .filter((s) => s.end > s.start + 1)
  if (list.length === 0) return null
  mkdirSync(outDir, { recursive: true })

  const tries = Math.max(1, Math.min(3, Number(attempts) || 1))
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    // 独立子目录：被掐断那次留下的 `.part` 会让下一轮去"续传"残片（同 downloadVideoClip 的理由）
    const attemptDir = tries === 1 ? outDir : join(outDir, `sec-${attempt}`)
    // eslint-disable-next-line no-await-in-loop
    const got = await attemptSections(url, {
      outDir: attemptDir, sections: list, ffmpegDir, cookie, ytDlp, timeoutMs, maxBytes, onError, attempt, tries,
    })
    if (got !== null) return got
  }
  return null
}

/** 单次多段下载尝试。返回已到手的段（可能少于请求数），一段都没到手才返回 null。 */
async function attemptSections(url, { outDir, sections, ffmpegDir, cookie, ytDlp, timeoutMs, maxBytes, onError, attempt, tries }) {
  mkdirSync(outDir, { recursive: true })
  const args = buildYtDlpArgs(url, { outDir, sections, ffmpegDir, cookie, audioOnly: true })
  const command = ytDlp.command
  const fullArgs = [...ytDlp.prefix, ...args]
  const report = (stage, extra = {}) => {
    if (typeof onError !== 'function') return
    try {
      onError({ stage, attempt, attempts: tries, command, args: fullArgs, ...extra })
    } catch { /* 诊断不该影响主流程 */ }
  }

  const result = await run(command, fullArgs, timeoutMs, outDir)
  /**
   * ⚠️ 退出码非 0 **不等于**一段都没下到。
   * 多段下载里只要有一段超出片长，ffmpeg 就会对那一段报错并让 yt-dlp 以非零码退出，
   * 但前面几段的文件其实已经落盘了。所以要**先扫产物再判失败**。
   */
  if (!result.ok) {
    report('spawn-or-exit', {
      exitCode: result?.error?.code ?? null,
      timedOut: result?.error?.killed === true,
      stderr: String(result?.stderr ?? '').slice(-600),
    })
  }

  /**
   * `--print after_move:%(section_start)s|%(filepath)s` 每段一行。
   * 用 `--print` 而不是解析文件名：`at` 是**语义字段**，文件名是**约定**，
   * 约定会被站点/版本改掉，而改掉时不会报错，只会让台词和画面悄悄错位。
   */
  const out = []
  for (const line of result.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const sep = line.indexOf('|')
    if (sep <= 0) continue
    const at = Number(line.slice(0, sep))
    const file = line.slice(sep + 1)
    if (!Number.isFinite(at) || file === '') continue
    const st = statSync(file, { throwIfNoEntry: false })
    // 单段体积上限：一段 20 秒音频正常 300-400KB，超过 8MB 说明站点忽略了 section 给了整片
    if (!st?.isFile() || st.size === 0 || st.size > Math.min(maxBytes, 8 * 1024 * 1024)) continue
    out.push({ at, file, bytes: st.size })
  }
  if (out.length === 0) {
    report('no-artifact', { stderr: String(result?.stderr ?? '').slice(-400) })
    return null
  }
  out.sort((a, b) => a.at - b.at)
  if (out.length < sections.length) {
    report('partial', { got: out.length, wanted: sections.length })
  }
  return out
}

