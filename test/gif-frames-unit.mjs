/**
 * GIF 抽帧单元测试 —— 2026-11-06。
 *
 * 判据（跑之前写死）：
 *   G1 抽出 ≥2 帧 ⇒ 按文件名顺序返回（不是按写入顺序）
 *   G2 只抽出 1 帧 ⇒ 返回空，且**残片被删掉**（别在 qq-images 里留垃圾）
 *   G3 file / outDir 为空 ⇒ 空，不抛
 *   G4 want 被夹在 2..9（看传给 ffmpeg 的 -frames:v）
 *   G5 exec 直接抛错 ⇒ 空，不抛
 *   G6 抽出的文件扩展名不是 .jpg 的（别的杂文件）不算
 *
 * 用法：`node test/gif-frames-unit.mjs`
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractGifFrames } from '../lib/gif-frames.js'

let passed = 0
let failed = 0
const check = (name, ok, extra = '') => {
  if (ok) { passed++; console.log('PASS', name, extra) } else { failed++; console.log('FAIL', name, extra) }
}

const root = mkdtempSync(join(tmpdir(), 'qq-gifframes-'))

/** 造一个"ffmpeg"：按 pattern 写 N 个假帧，并把参数记下来 */
const fakeFfmpeg = (frames, { throwOnCall = false } = {}) => {
  const calls = []
  const exec = (command, args, options, callback) => {
    calls.push({ command, args })
    if (throwOnCall) throw new Error('boom')
    const pattern = args[args.length - 1]
    for (let i = 1; i <= frames; i++) {
      writeFileSync(pattern.replace('%02d', String(i).padStart(2, '0')), 'x')
    }
    // 再塞一个杂文件，验证不会被算进去（必须是**不以 .jpg 结尾**的，否则它本来就是帧）
    writeFileSync(`${pattern.replace('%02d', '99')}.txt`, 'x')
    callback(null, '', '')
  }
  exec.calls = calls
  return exec
}

try {
  // G1 多帧
  const dir1 = join(root, 'a')
  const r1 = await extractGifFrames({ file: 'in.gif', outDir: dir1, exec: fakeFfmpeg(3), id: 't1' })
  check('G1 三帧按序返回', r1.length === 3 && r1[0].endsWith('t1-01.jpg') && r1[2].endsWith('t1-03.jpg'), JSON.stringify(r1.map((p) => p.split(/[\\/]/).pop())))

  // G2 单帧 ⇒ 空 + 残片删掉
  const dir2 = join(root, 'b')
  const r2 = await extractGifFrames({ file: 'in.gif', outDir: dir2, exec: fakeFfmpeg(1), id: 't2' })
  const left2 = existsSync(dir2) ? readdirSync(dir2).filter((n) => n.startsWith('t2-')) : []
  check('G2 单帧返回空', r2.length === 0, JSON.stringify(r2))
  check('G2 残片被删', left2.length === 0, JSON.stringify(left2))

  // G3 空参数
  check('G3 空 file ⇒ 空', (await extractGifFrames({ file: '', outDir: join(root, 'c') })).length === 0)
  check('G3 空 outDir ⇒ 空', (await extractGifFrames({ file: 'in.gif', outDir: '' })).length === 0)

  // G4 want 夹取
  const dir4 = join(root, 'd')
  const exec4 = fakeFfmpeg(2)
  await extractGifFrames({ file: 'in.gif', outDir: dir4, exec: exec4, want: 99, id: 't4' })
  const args4 = exec4.calls[0].args
  check('G4 want=99 被夹到 9', args4[args4.indexOf('-frames:v') + 1] === '9', JSON.stringify(args4))
  const dir4b = join(root, 'd2')
  const exec4b = fakeFfmpeg(2)
  await extractGifFrames({ file: 'in.gif', outDir: dir4b, exec: exec4b, want: 1, id: 't4b' })
  const args4b = exec4b.calls[0].args
  check('G4 want=1 被抬到 2', args4b[args4b.indexOf('-frames:v') + 1] === '2', JSON.stringify(args4b.filter((x) => x === '2' || x === '-frames:v')))

  // G5 exec 抛错
  const dir5 = join(root, 'e')
  const r5 = await extractGifFrames({ file: 'in.gif', outDir: dir5, exec: fakeFfmpeg(3, { throwOnCall: true }), id: 't5' })
  check('G5 exec 抛错 ⇒ 空不抛', Array.isArray(r5) && r5.length === 0, JSON.stringify(r5))

  // G6 只认 .jpg
  const dir6 = join(root, 'f')
  const r6 = await extractGifFrames({ file: 'in.gif', outDir: dir6, exec: fakeFfmpeg(2), id: 't6' })
  check('G6 杂文件不算', r6.every((p) => p.endsWith('.jpg')), JSON.stringify(r6))
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
