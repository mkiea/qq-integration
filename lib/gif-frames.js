/**
 * GIF 多帧抽取（2026-11-06）。
 *
 * 问题：GIF 以前是**整包**按 `image/gif` 挂给附件服务的（`#imageBlocksFor`），
 * 而解码那一侧（sharp）默认只解**第一帧**。于是：
 *   · 第一帧是黑屏/白屏/标题的动图 ⇒ 她"什么都看不见"；
 *   · 动作/表情变化全丢 ⇒ 只知道"有张图"，不知道发生了什么。
 * 用户原话：「还有 gif 有的识别不出来多帧」。
 *
 * 做法：用 ffmpeg 按固定帧率抽最多 `want` 帧 JPEG，像视频抽帧那样喂多张。
 * 抽出来 **少于 2 帧** 就当作静态图（删掉残片，调用方继续走原路径），
 * 这样"单帧 GIF"不会被拆成一张重复的图。
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

let seq = 0

/**
 * @param {{file:string, outDir:string, ffmpegPath?:string, want?:number, exec?:Function, timeoutMs?:number, id?:string}} opts
 * @returns {Promise<string[]>} 帧文件路径（按文件名顺序）；失败或静态图返回 []
 */
export function extractGifFrames({ file, outDir, ffmpegPath = 'ffmpeg', want = 4, exec = execFile, timeoutMs = 30_000, id = '' } = {}) {
  return new Promise((resolve) => {
    if (typeof file !== 'string' || file === '' || typeof outDir !== 'string' || outDir === '') { resolve([]); return }
    const count = Math.max(2, Math.min(9, Number(want) || 4))
    const stem = `gif-${id || `${Date.now().toString(36)}-${(seq += 1)}`}`
    const pattern = join(outDir, `${stem}-%02d.jpg`)
    let settled = false
    const finish = (list) => {
      if (settled) return
      settled = true
      if (list.length >= 2) { resolve(list); return }
      // 抽不到 2 帧：清掉残片，别在 qq-images 里留垃圾
      for (const f of list) { try { unlinkSync(f) } catch { /* 删不掉就算了 */ } }
      resolve([])
    }
    try {
      mkdirSync(outDir, { recursive: true })
    } catch {
      resolve([])
      return
    }
    const read = () => {
      try {
        return readdirSync(outDir)
          .filter((n) => n.startsWith(`${stem}-`) && n.toLowerCase().endsWith('.jpg'))
          .map((n) => join(outDir, n))
          .filter((p) => existsSync(p))
          .sort()
      } catch {
        return []
      }
    }
    try {
      exec(
        ffmpegPath,
        [
          '-hide_banner', '-loglevel', 'error',
          '-i', file,
          // 2 fps：表情包 GIF 通常 1~3 秒，4 帧能盖住前 2 秒；再长也只取开头
          '-vf', "fps=2,scale='min(960,iw)':-2",
          '-frames:v', String(count),
          '-q:v', '4',
          '-y', pattern,
        ],
        { timeout: timeoutMs, windowsHide: true },
        () => finish(read()),
      )
    } catch {
      finish([])
    }
  })
}
