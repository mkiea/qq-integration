/**
 * 入站语音的本地路径准入（lib/voice-path.js）。
 *
 * 回归背景：用户发来的语音，桥报「无法获取语音文件（get_record、本地路径与 url 均失败）」。
 * 真机帧里 Waylay 把本地绝对路径放在 **`record.url`**、`path` 留空，而原候选只有
 * `[path, file]` ⇒ 永远读不到。这个测试第一组就是钉这件事。
 *
 * 同时钉住放宽的边界：只收音频扩展名、realpath 之后再判一次（`x.amr` 链接到 `id_rsa` 要挡住）。
 */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VOICE_EXT_RE, looksAbsolutePath, voiceLocalCandidates, voicePathVerdict } from '../lib/voice-path.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) } else { failed++; console.log('FAIL', name, extra) }
}

// ── ① 候选收集：url 必须在里面（这就是那个 bug）────────────────────────
{
  const realFrame = {
    file: '40492477f9cf82860da42a867999620b.amr',
    url: 'C:\\Users\\someone\\nt_data\\Ptt\\2026-10\\Ori\\40492477f9cf82860da42a867999620b.amr',
    path: '',
  }
  const got = voiceLocalCandidates(realFrame)
  check('★ url 里的本地路径被收进候选（回归钉）', got.some((p) => p.includes('nt_data')), JSON.stringify(got))
  check('纯文件名的 file 不进候选（走 get_record）', !got.includes(realFrame.file))
  check('只有一条候选（path 空、file 是纯名）', got.length === 1, `${got.length} 条`)

  // 顺序：path 优先，其次 file，最后 url
  const ordered = voiceLocalCandidates({
    path: 'C:\\a\\p.amr', file: 'D:\\b\\f.amr', url: 'E:\\c\\u.amr',
  })
  check('候选顺序为 path → file → url', ordered.join('|') === 'C:\\a\\p.amr|D:\\b\\f.amr|E:\\c\\u.amr', ordered.join('|'))

  check('空 record 不炸', voiceLocalCandidates(null).length === 0)
  check('全是纯文件名时没有候选', voiceLocalCandidates({ file: 'x.amr', url: 'y.amr', path: '' }).length === 0)
}

// ── ② 形状判断 ───────────────────────────────────────────────────────
{
  check('盘符路径识别为绝对路径', looksAbsolutePath('C:\\x\\y.amr') === true)
  check('POSIX 路径识别为绝对路径', looksAbsolutePath('/tmp/y.amr') === true)
  check('纯文件名不是绝对路径', looksAbsolutePath('y.amr') === false)
}

// ── ③ 准入判断：正反都验 ─────────────────────────────────────────────
{
  check('正常语音放行', voicePathVerdict('C:\\p\\x.amr').ok === true)
  check('.silk 放行', voicePathVerdict('C:\\p\\x.silk').ok === true)
  check('.mp3 放行', voicePathVerdict('C:\\p\\x.mp3').ok === true)

  const notAudio = voicePathVerdict('C:\\Users\\someone\\.ssh\\id_rsa')
  check('★ 无扩展名的密钥文件被拒', notAudio.ok === false && notAudio.reason === 'not-audio', notAudio.reason)

  const txt = voicePathVerdict('C:\\Users\\someone\\.env.txt')
  check('★ 非音频扩展名被拒', txt.ok === false && txt.reason === 'not-audio', txt.reason)

  const rel = voicePathVerdict('x.amr')
  check('相对路径不算本地语音来源', rel.ok === false && rel.reason === 'not-absolute', rel.reason)

  const big = voicePathVerdict('C:\\p\\x.amr', { size: 21 * 1024 * 1024 })
  check('超过 20MiB 被拒', big.ok === false && big.reason === 'too-large', big.reason)

  check('扩展名正则大小写不敏感', VOICE_EXT_RE.test('C:\\p\\X.SILK') === true)
}

// ── ④ realpath 之后再审一次：链接绕过 ────────────────────────────────
{
  const base = mkdtempSync(join(tmpdir(), 'voice-path-'))
  try {
    const dir = join(base, 'ptt')
    mkdirSync(dir, { recursive: true })
    const secret = join(base, 'id_rsa')
    writeFileSync(secret, 'PRIVATE KEY')
    const link = join(dir, 'evil.amr')
    let linked = false
    try { symlinkSync(secret, link); linked = true } catch { /* 无权限就跳过 */ }

    if (linked) {
      // 路径本身看着像音频 → 第一关会放行
      check('链接名 .amr 时第一关放行（说明只靠扩展名不够）', voicePathVerdict(link).ok === true)
      // 但 realpath 之后应该不再是音频 → 第二关必须拒
      const real = require('node:fs').realpathSync(link)
      check('★ realpath 后不是音频 ⇒ 被拒（链接绕过被挡住）', voicePathVerdict(real).ok === false, real)
    } else {
      console.log('SKIP 建不出符号链接 —— 这一条没测到（不是通过）')
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
