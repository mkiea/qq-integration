/**
 * 入站本地路径准入（lib/inbound-path.js）。
 *
 * 红队 L① 用 mock OneBot 实测打穿过：伪造帧 `file = C:\...\.ssh\id_rsa` → 内容内联进她的
 * 上下文 → 按攻击者给的 name 改名落盘。修法不是"把正则写严一点"，而是**默认拒绝所有绝对路径**
 * （本机 1215 条真实帧全是纯文件名，这条分支在正常流量下从未执行过）。
 *
 * 这里正反都验：
 *   · 反：默认配置（roots 空）下任何绝对路径都进不来；`..` 与 junction 也穿不过去；
 *   · 正：**显式配了根目录后，根内的文件必须能读** —— 否则"全部拒绝"的假实现也能让上半部分全绿。
 */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { checkInboundLocalPath, looksAbsolutePath } from '../lib/inbound-path.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) } else { failed++; console.log('FAIL', name, extra) }
}

const base = mkdtempSync(join(tmpdir(), 'inbound-path-'))
const root = join(base, 'allowed-root')
const outside = join(base, 'outside')
mkdirSync(root, { recursive: true })
mkdirSync(outside, { recursive: true })

const insideFile = join(root, 'ok.txt')
writeFileSync(insideFile, 'this one is allowed')
const outsideFile = join(outside, 'secret.txt')
writeFileSync(outsideFile, 'TOP-SECRET')

// 指向根外的目录联接（Windows 上 junction 不需要管理员权限）
let linked = false
try {
  symlinkSync(outside, join(root, 'escape'), 'junction')
  linked = true
} catch { /* 建不出来就跳过这条断言（不假装通过） */ }

// ── 形状判断 ─────────────────────────────────────────────────────────
{
  check('盘符路径算绝对路径', looksAbsolutePath('C:\\x\\y.txt') === true)
  check('POSIX 风格也算', looksAbsolutePath('/tmp/x') === true)
  check('纯文件名不算绝对路径（正常流量）', looksAbsolutePath('2A24C.jpg') === false)
  check('空串不算', looksAbsolutePath('') === false)
}

// ── 默认配置：一律拒 ─────────────────────────────────────────────────
{
  const r = checkInboundLocalPath(insideFile, [])
  check('★ 默认（roots 空）拒绝对路径', r.ok === false)
  check('默认拒绝的理由是 no-roots（不是"文件不存在"）', r.reason === 'no-roots', r.reason)

  const r2 = checkInboundLocalPath('C:\\Windows\\System32\\config\\SAM', [])
  check('系统敏感路径同样被拒', r2.ok === false && r2.reason === 'no-roots')
}

// ── 配了根目录之后 ───────────────────────────────────────────────────
{
  const ok = checkInboundLocalPath(insideFile, [root])
  check('★ 根内文件放行（反向对照，防"全拒"假实现）', ok.ok === true, ok.reason)
  check('放行时返回 realpath', typeof ok.real === 'string' && ok.real.length > 0, ok.real)

  const out = checkInboundLocalPath(outsideFile, [root])
  check('根外文件被拒', out.ok === false)
  check('根外拒绝理由是 outside-roots', out.reason === 'outside-roots', out.reason)

  // `..` 穿越：字符串看起来在根内，resolve 后跑到外面
  const dotdot = join(root, '..', 'outside', 'secret.txt')
  const r3 = checkInboundLocalPath(dotdot, [root])
  check('`..` 穿越被拒', r3.ok === false, r3.reason)

  // 不存在的文件：理由要能区分开（否则排查时分不清"没配"和"没这个文件"）
  const missing = checkInboundLocalPath(join(root, 'nope.txt'), [root])
  check('不存在的文件理由为 missing', missing.reason === 'missing', missing.reason)
}

// ── 链接穿越：realpath 之后必须跑到根外 ──────────────────────────────
if (linked) {
  const viaLink = checkInboundLocalPath(join(root, 'escape', 'secret.txt'), [root])
  check('★ 经 junction 指向根外的文件被拒（realpath 后判定）', viaLink.ok === false, viaLink.reason)
  if (viaLink.real) {
    check('拒绝时 real 已解到真实路径（不在根本身下）', viaLink.real.includes(`outside${sep}`), viaLink.real)
  }
} else {
  console.log('SKIP junction 建不出来 —— 链接穿越这一条没测到（不是通过）')
}

// ── 大小写 / 尾分隔符这类"看起来不同"的等价写法 ──────────────────────
{
  const withSlash = checkInboundLocalPath(insideFile, [`${root}${sep}`])
  check('根目录带尾分隔符也能匹配', withSlash.ok === true, withSlash.reason)
}

rmSync(base, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
