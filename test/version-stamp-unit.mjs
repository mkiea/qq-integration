/**
 * 发行版本戳的单元测试 —— 2026-11-07。
 *
 * 这个模块唯一的职责是「别把版本说错」，而它的失败模式全是**静默**的：
 *   · 缺清单时退回 package.json 的 0.1.0 ⇒ 用户以为自己在最新版；
 *   · 把正文里的 `tag=` 当版本 ⇒ 升级提示指向一个不存在的版本；
 *   · 键名大小写/空格差一点 ⇒ 读出空值，界面上只显示「—」，没人知道是解析坏了。
 * 所以每条容错边界都要钉住，且**反向用例**（不该被采纳的写法）比正向更重要。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeStamp, emptyStamp, parseManifest, readVersionStamp } from '../lib/version-stamp.js'

const HERE = dirname(fileURLToPath(import.meta.url))

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const tempDirs = []
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'qqai-stamp-'))
  tempDirs.push(dir)
  return dir
}

const GOOD = [
  'qq-integration / QQ 集成接入 — 发行包清单',
  '生成时间：2026-11-07 14:53:06',
  'release-tag=v0.1.0-rc2',
  'release-commit=6f3aa45',
  'release-built-at=2026-11-07T14:53:06+08:00',
  'release-built-by=mkrelease.py',
  'requires-rin-inject-sha256=0e1c3c44561f743e',
  '',
  '本包（不含第三方二进制）：',
  '  qq-integration/一键启动.bat          双击入口',
].join('\r\n')

// ------------------------------------------------ 1. 正常清单

{
  const s = parseManifest(GOOD)
  check('完整清单：present', s.present === true)
  check('完整清单：tag', s.tag === 'v0.1.0-rc2', s.tag)
  check('完整清单：commit', s.commit === '6f3aa45', s.commit)
  check('完整清单：builtAt', s.builtAt === '2026-11-07T14:53:06+08:00', s.builtAt)
  check('完整清单：builtBy', s.builtBy === 'mkrelease.py', s.builtBy)
  check('完整清单：rin-inject sha256', s.rinInjectSha256 === '0e1c3c44561f743e', s.rinInjectSha256)
  check('完整清单：source=manifest', s.source === 'manifest')
  check('完整清单：正文不产生 ignored', s.ignored === 0, String(s.ignored))
}

// ------------------------------------------------ 2. 反向用例：不该被采纳的写法

{
  // 正文里假设有一句"旧版本 tag=v0.1.0"——没有 release- 前缀，必须不认
  const s = parseManifest('旧版本 tag=v0.1.0-fake\n本包 version=9.9.9\n')
  check('无 release- 前缀的 tag 不采纳', s.tag === '' && s.present === false, s.tag)
  check('无 release- 前缀时 source=none', s.source === 'none')
}

{
  // 只有打包时间：能定位"什么时候打的"，定位不了"哪一版"
  const s = parseManifest('release-built-at=2026-11-07T14:53:06+08:00\n')
  check('只有 built-at 不算有发行戳', s.present === false)
  check('只有 built-at 时 tag 为空', s.tag === '')
  check('只有 built-at 时仍保留时间', s.builtAt.startsWith('2026-11-07'))
}

{
  // 只有 commit：也算能定位版本（tag 可能没打，但 commit 是真凭据）
  const s = parseManifest('release-commit=abc1234\n')
  check('只有 commit 也算有戳', s.present === true)
  check('只有 commit 时 describe 用 commit', describeStamp(s) === 'abc1234', describeStamp(s))
}

// ------------------------------------------------ 3. 解析容错

{
  const s = parseManifest('release-tag=v1\nrelease-tag=v2\n')
  check('重复键先到先得', s.tag === 'v1', s.tag)
}

{
  const s = parseManifest('  Release-Tag  =  v9  \n')
  check('键大小写不敏感 + 空白忽略', s.tag === 'v9', s.tag)
}

{
  const s = parseManifest('\uFEFFrelease-tag=v-with-bom\n')
  check('UTF-8 BOM 被剥掉', s.tag === 'v-with-bom', s.tag)
}

{
  const s = parseManifest('release-built-by=a=b\n')
  check('值里的 = 保留', s.builtBy === 'a=b', s.builtBy)
}

{
  const s = parseManifest('# release-tag=commented-out\n')
  check('# 注释行不采纳', s.tag === '' && s.present === false)
}

{
  const s = parseManifest('release-channel=beta\nrelease-tag=v3\n')
  check('未知 release- 键计数但不炸', s.ignored === 1 && s.tag === 'v3', `ignored=${s.ignored}`)
}

{
  const s = parseManifest('')
  check('空文件 → source=none', s.source === 'none' && s.present === false)
  check('空文件 → describe 说没有戳', describeStamp(s).includes('没有发行戳'))
}

{
  const s = parseManifest(null)
  check('null 不抛', s.source === 'none')
}

// ------------------------------------------------ 4. readVersionStamp：磁盘与降级

{
  const dir = tempDir()
  writeFileSync(join(dir, 'RELEASE-MANIFEST.txt'), GOOD, 'utf8')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.0' }), 'utf8')
  const s = readVersionStamp({ repo: dir })
  check('磁盘：读到 tag', s.tag === 'v0.1.0-rc2', s.tag)
  check('磁盘：packageVersion 一并带回', s.packageVersion === '0.1.0', s.packageVersion)
  // /api/status 会原样返回这个对象；带绝对路径出去等于把用户名发给浏览器和截图。
  check('磁盘：不把绝对路径带出去', !('path' in s), JSON.stringify(Object.keys(s)))
}

{
  // 最常见的真实情形：npm 安装 / 开发副本，没有清单
  const dir = tempDir()
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.0' }), 'utf8')
  const s = readVersionStamp({ repo: dir })
  check('无清单：present=false', s.present === false)
  check('无清单：不把 0.1.0 当 tag', s.tag === '')
  check('无清单：仍然带 packageVersion', s.packageVersion === '0.1.0')
  check('无清单：source=none', s.source === 'none')
  const text = describeStamp(s)
  check('无清单：描述带「无发行戳」限定', text.includes('无发行戳'), text)
  check('无清单：描述不出现「最新」', !text.includes('最新'), text)
}

{
  const s = readVersionStamp({ repo: join(tmpdir(), 'qqai-does-not-exist-' + Date.now()) })
  check('目录不存在：不抛且降级', s.present === false && s.source === 'none')
}

{
  const dir = tempDir()
  const custom = join(dir, 'MY-MANIFEST.txt')
  writeFileSync(custom, 'release-tag=v-custom\n', 'utf8')
  const s = readVersionStamp({ manifestPath: custom })
  check('manifestPath 覆盖 repo', s.tag === 'v-custom', s.tag)
}

// ------------------------------------------------ 5. describeStamp

{
  const s = { ...emptyStamp(), present: true, tag: 'v0.1.0-rc2', commit: '6f3aa45' }
  check('describe：tag · commit', describeStamp(s) === 'v0.1.0-rc2 · 6f3aa45', describeStamp(s))
}

{
  const s = { ...emptyStamp(), present: true, tag: '', commit: 'abc1234' }
  check('describe：无 tag 不出现空括号', describeStamp(s) === 'abc1234', describeStamp(s))
}

{
  check('describe：null 不抛', describeStamp(null).includes('没有发行戳'))
  check('emptyStamp 每次是新对象', emptyStamp() !== emptyStamp())
}

// ------------------------------------------------ 6. 接线检查（不是渲染检查）
//
// 版本戳的消费点有四个：启动器首行 / doctor / 控制台顶栏 / /api/status。
// 这里只钉住"代码有没有接上"，**不**证明浏览器里画对了 —— 那需要真起控制台看 DOM。
// 局限写在名字里，免得以后把这几条当成视觉验收。

{
  const UI = readFileSync(join(HERE, '..', 'control', 'ui.html'), 'utf8')
  check('接线：ui.html 有 brandStamp 容器', UI.includes('id="brandStamp"'))
  check('接线：render 调用了 renderBrandStamp', UI.includes('renderBrandStamp(status?.stamp)'))
  check('接线：老服务端无 stamp 时早返回', UI.includes('if (!el || !stamp) return;'))

  const DOCTOR = readFileSync(join(HERE, '..', 'tools', 'doctor.mjs'), 'utf8')
  check('接线：doctor 有「发行版本戳」一项', DOCTOR.includes("'发行版本戳'"))

  const PRE = readFileSync(join(HERE, '..', 'launcher', 'preflight.mjs'), 'utf8')
  check('接线：启动器首行打印版本', PRE.includes('版本：${describeStamp('))

  const SERVER = readFileSync(join(HERE, '..', 'control', 'lib', 'server.mjs'), 'utf8')
  check('接线：/api/status 返回 stamp', SERVER.includes('stamp: currentStamp()'))
}

// ------------------------------------------------ 清理

for (const dir of tempDirs) {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录，删不掉不影响结论 */ }
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
