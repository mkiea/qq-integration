/**
 * 接线守卫：视频「看得到画面 / 听得到说话」的两条入口都必须真的接着。
 *
 * ## 为什么需要这个文件（它不是行为测试，是**接线**测试）
 *
 * 2026-11-01 用户的原话是「引用卡片看不到，以及没有发送语音和字幕之类的」。
 * 查下去发现是三件独立的事，其中两件的形态完全一样：
 *
 *   · `#watchVideoFromUrl` 早就写好了、跑得好好的，但**只接在"用户直接发卡片"那条路上**；
 *     用户**引用**一张卡片时走的是 `#resolveQuoted`，那里只做了页面反查 ——
 *     同一个能力在另一条路上就是不存在。
 *   · 视频音轨转写在 `#watchVideoFromUrl` 里实现了，但用户**直接发**或**引用**一段
 *     QQ 视频走的是 `#showVideo`，那里只抽帧、一句话都没有。
 *
 * 两个都不会报错、都不会崩，表现出来只是"她好像没看见 / 没听见"。
 * 这种"能力在 A 路有、B 路没有"的缺口，行为测试很难覆盖（要真 yt-dlp + 真模型），
 * 但**接线**是可以用源码级断言钉住的 —— 而且钉住的正是**实际发生过的那次回归**。
 *
 * 因此本文件的定位写清楚：**它只证明"调用点存在"，不证明"跑起来对"**。
 * 真正的行为验证靠真机重启后跑一遍（见 CHANGELOG 的验收步骤）。
 * 同类的"防漏改"守卫本仓库已有先例（test/extension-unit.mjs 的工具名清单）。
 *
 * ⚠️ 为什么不直接跑行为：`#watchVideoFromUrl` 内部自己调 `resolveYtDlp()`，
 * 没有注入缝；而 Windows 上 `execFile` 不能执行 `.cmd`/`.bat` 假替身
 * （Node 明确要求 `shell: true`），所以"假 yt-dlp"只能在
 * `downloadVideoClip` 这一层注入（见 test/videofetch-unit.mjs），到不了桥里。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

/**
 * 仓库里的 .js 是 **CRLF**（git core.autocrlf），而下面按 `\n  }\n` 找方法结尾。
 * 不归一化的话 `indexOf` 永远返回 -1，`body()` 会一路切到文件末尾 ——
 * 断言于是"全都通过"，但通过的原因是可笑的（它匹配的是整个文件）。
 * 这个坑本身不报错，所以必须先在这里掐掉。
 */
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'bridge.js'), 'utf8')
  .replace(/\r\n/g, '\n')

/** 取某个方法体（从 `async #name(` 到下一个顶格 `  }`），只看方法内出现的调用。 */
function body(method) {
  const start = source.indexOf(`async ${method}(`)
  if (start < 0) return ''
  const end = source.indexOf('\n  }\n', start)
  return end < 0 ? '' : source.slice(start, end)
}

const quoted = body('#resolveQuoted')
const showVideo = body('#showVideo')
const watchUrl = body('#watchVideoFromUrl')
const cardContent = body('#cardVideoContent')

// ---- ① 引用卡片：必须走同一条"看视频"实现 ----
check('★ #resolveQuoted 真的存在（下面几条断言的前提；方法改名要同步改这里）',
  quoted !== '', `长度 ${quoted.length}`)
check('★★ 引用的卡片会调 #cardVideoContent（抽帧 + 音轨），不是只做页面反查',
  quoted.includes('#cardVideoContent'))
check(' 引用路径的抽帧调用带了 skipSpeech（有 CC 字幕时别再跑一遍 ASR）',
  /#cardVideoContent\(card,\s*\{\s*skipSpeech/.test(quoted))
check('★ 引用路径仍保留页面反查（画面与文字是互补，不是替代）',
  quoted.includes('#enrichCard'))

// ---- ② 主消息路径不能被这次重构弄丢 ----
check('★★ #cardVideoContent 一共有**两个**调用点（主路径 + 引用路径），少一个就是漏接线',
  (source.match(/this\.#cardVideoContent\(card,/g) ?? []).length === 2,
  String((source.match(/this\.#cardVideoContent\(card,/g) ?? []).length))
check('★ 主路径那个调用点不在 #resolveQuoted 里（否则就只剩引用一条路了）',
  (source.slice(0, source.indexOf('async #resolveQuoted(')).match(/this\.#cardVideoContent\(card,/g) ?? []).length === 1)
check('★ #cardVideoContent 本体只此一份（没有第二份"更差的实现"）',
  (source.match(/async #cardVideoContent\(/g) ?? []).length === 1)

// ---- ③ 原生视频（直接发 / 引用）：必须把音轨也转出来 ----
check('★ #showVideo 真的存在', showVideo !== '', `长度 ${showVideo.length}`)
check('★★ #showVideo 会调 #speechFromMedia（否则用户发一段真人视频，她只看到几张脸、一句台词都没有）',
  showVideo.includes('#speechFromMedia'))
check('★★ 卡片那条（#watchVideoFromUrl）也走同一个 #speechFromMedia（"同一个规矩只写一遍"）',
  watchUrl.includes('#speechFromMedia'))
check('★ #speechFromMedia 本体只此一份（转码规格只有 toWav16k 一处定义）',
  (source.match(/async #speechFromMedia\(/g) ?? []).length === 1)

// ---- ④ 转写失败不许连坐画面 ----
check(' 转写发生在抽帧之后（先保住画面，再花时间做识别）',
  showVideo.indexOf('await this.#speechFromMedia') > showVideo.indexOf('const frames = []'))
check('★ 转写调用在 #showVideo 里是 `await` 且结果被兜住（失败只少一段台词，不抛给她）',
  /const got = await this\.#speechFromMedia/.test(showVideo))
check(' 引用路径里视频失败写明"不要假装看过画面"（而不是静默少一段）',
  quoted.includes('不要假装看过画面'))

// ---- ⑤ 开关确实读的是配置，不是写死 ----
check('★ 引用路径的抽帧受 cardVideoWatchEnabled 控制',
  quoted.includes('cardVideoWatchEnabled'))
check('★ 原生视频的转写受 videoSpeechEnabled 控制（关掉就不再等她转写）',
  showVideo.includes('videoSpeechEnabled'))
check('★ 卡片转写同时受主开关与自身开关约束（一个总闸，面板只暴露一个）',
  watchUrl.includes('videoSpeechEnabled') && watchUrl.includes('cardVideoSpeechEnabled'))
check('★★ 一条消息里最多两张卡片，但抽帧只给第一张跑（否则静默时间翻倍）',
  quoted.includes('quotedVideoTried') && /!quotedVideoTried/.test(quoted))

// ---- ⑥ 长视频：全片台词采样必须真的接上（2026-11-01 晚） ----
/**
 * 用户原话：「不过好像只看了一分钟，没看完」。画面改走全片缩略图之后，
 * 台词还卡在前 60 秒 —— 这个文件钉的就是"采样这条线真的接着"。
 *
 * 这里断言的**不是** `#timelineSpeech` 存在（那太弱），而是三件会静默失效的事：
 *   ① 它只在长视频上走，短视频仍用原来那段连续片段（否则短视频白付 8 次固定开销）；
 *   ② 走采样时**不再下连续片段**（`needClip`），否则两个都跑、静默时间翻倍；
 *   ③ 它调的是多段下载（`downloadVideoSections`），不是单段（`downloadVideoClip`）。
 */
const timeline = body('#timelineSpeech')
/**
 * 实现体在 `#timelineSpeechInner`（外层 `#timelineSpeech` 只是异常兜底）。
 * 两个都要看：外层证明"有兜底"，内层证明"真的有干活"。
 */
const timelineInner = body('#timelineSpeechInner')
check('★ #timelineSpeech 真的存在（长视频全片台词采样的入口）', timeline !== '', `长度 ${timeline.length}`)
check('★ #timelineSpeechInner 是真正的实现体（下载+转写都在这里）',
  timelineInner !== '', `长度 ${timelineInner.length}`)
check('★★ 外层兜异常：采样出任何意外都只丢台词，不连坐 6 张已裁好的画面',
  timeline.includes('try') && timeline.includes('catch') && /text: ''/.test(timeline))
check('★★ #watchVideoFromUrl 会调 #timelineSpeech（否则长视频台词永远只有开头）',
  watchUrl.includes('#timelineSpeech'))
check('★ 实现体走多段下载 downloadVideoSections（不是单段 clip）',
  timelineInner.includes('downloadVideoSections') && !timelineInner.includes('downloadVideoClip'))
check('★★ 采样前有闸：timelineWanted 同时要求「有全片画面」和「片长超过窗口」',
  /const timelineWanted = useBoard && speechWanted && speechSegments > 0 && fullSeconds > seconds \+ 10/.test(watchUrl),
  '')
check('★★★ 走采样时不再下连续片段（needClip 里排除了 timelineWanted）',
  /const needClip = !useBoard \|\| \(speechWanted && !timelineWanted\)/.test(watchUrl))
check('★★ 段数配置 0 必须真的关掉（不能用 `Number(x) || 6` —— 0 是 falsy 会被吃掉）',
  !/cardVideoSpeechSegments\)\s*\|\|/.test(watchUrl) && /Number\.isFinite\(rawSegments\)/.test(watchUrl))
check('★ 时间点优先复用缩略图那批（第 k 张画面和第 k 段台词说同一时刻）',
  /times:\s*board\.times/.test(watchUrl))
check('★ 两批「下完就转」是真并行（Promise.all 包着下载+转写）',
  timelineInner.includes('Promise.all') && /Promise\.all\(batches\.map/.test(timelineInner))
check('★ 采样失败不连坐画面（实现体返回空文本 + note，不 return null）',
  /return empty\(/.test(timelineInner) && !/return null/.test(timelineInner))
check('★ 台词两种形态要分开写（cover.kind）——混成一句就又变成"她说自己看完了"',
  cardContent.includes("cover.kind === 'timeline'") && cardContent.includes('speechCover'))

// ---- ⑦ mapLimit：并发池的纯函数行为 ----
const { mapLimit } = await import('../lib/bridge.js')
{
  const seen = []
  let live = 0
  let peak = 0
  const items = [5, 1, 4, 2, 3]
  const out = await mapLimit(items, 2, async (n) => {
    live += 1
    peak = Math.max(peak, live)
    seen.push(n)
    // 故意让后面的更快完成：结果顺序必须按**输入顺序**，不是完成顺序
    await new Promise((r) => setTimeout(r, n * 4))
    live -= 1
    return n * 10
  })
  check('★ 结果按输入顺序返回（不是完成顺序）', JSON.stringify(out) === '[50,10,40,20,30]', JSON.stringify(out))
  check('★ 同时运行数不超过 limit', peak <= 2, `peak=${peak}`)
  check('  空数组直接返回空', (await mapLimit([], 3, async () => 1)).length === 0)
  check('  limit 大于长度时也正常', (await mapLimit([1, 2], 9, async (n) => n)).length === 2)
  let threw = false
  try { await mapLimit([1, 2], 2, async () => { throw new Error('x') }) } catch { threw = true }
  check('★ 任务抛错向上抛（不偷偷吞掉 —— 要不要吞是调用方的事）', threw)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
