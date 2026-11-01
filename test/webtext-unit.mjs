/**
 * webtext.js（HTML → 纯文本）的测试。
 *
 * 这一层最怕两件事，正反都要钉：
 *   · 把 <script> 里的代码当正文（模型会读到一堆 JS 然后胡说）；
 *   · 页面其实没内容却返回"读到了"（模型会编造梗的解释）。
 */
import { decodeEntities, formatLinkReading, htmlTitle, htmlToText } from '../lib/webtext.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) } else { failed++; console.log('FAIL', name, extra) }
}

// ── 实体解码 ─────────────────────────────────────────────────────────
{
  check('命名实体', decodeEntities('&amp; &lt; &gt; &quot;') === '& < > "', decodeEntities('&amp; &lt;'))
  check('数字实体', decodeEntities('&#65;&#66;') === 'AB')
  check('十六进制实体', decodeEntities('&#x4e2d;') === '中')
  check('未知实体原样保留（不猜）', decodeEntities('&foobar;') === '&foobar;')
  check('非法码点不炸', typeof decodeEntities('&#1114112;') === 'string')
}

// ── 标题 ─────────────────────────────────────────────────────────────
{
  check('取 title', htmlTitle('<html><head><title>猫在跑</title></head></html>') === '猫在跑')
  check('无 title 返回空串', htmlTitle('<div>无</div>') === '')
  check('title 里的实体被解码', htmlTitle('<title>A &amp; B</title>') === 'A & B')
}

// ── 正文提取：正反都验 ───────────────────────────────────────────────
{
  const html = `
    <html><head>
      <title>这个梗是怎么来的</title>
      <style>.a{color:red}</style>
      <script>var payload = 'SCRIPT_SHOULD_NOT_APPEAR';</script>
    </head>
    <body>
      <!-- COMMENT_SHOULD_NOT_APPEAR -->
      <h1>标题</h1>
      <p>第一段正文，讲的是<strong>猫</strong>和<em>键盘</em>。</p>
      <p>第二段&nbsp;正文。</p>
      <ul><li>要点一</li><li>要点二</li></ul>
      <noscript>NOSCRIPT_SHOULD_NOT_APPEAR</noscript>
    </body></html>`

  const out = htmlToText(html)
  check('★ script 内容不进正文', !out.text.includes('SCRIPT_SHOULD_NOT_APPEAR'))
  check('★ 注释不进正文', !out.text.includes('COMMENT_SHOULD_NOT_APPEAR'))
  check('★ noscript 不进正文', !out.text.includes('NOSCRIPT_SHOULD_NOT_APPEAR'))
  check('★ style 的 CSS 不进正文', !out.text.includes('color:red'))
  check('正文保留', out.text.includes('第一段正文'), out.text.slice(0, 40))
  check('行内标签不粘出空格（<strong>猫</strong> 仍是「猫」）', out.text.includes('猫和键盘') || out.text.includes('讲的是猫'), out.text)
  check('&nbsp; 变成普通空格', out.text.includes('第二段 正文'), out.text)
  check('列表项各占一行', out.text.includes('要点一\n要点二'), JSON.stringify(out.text.slice(-20)))
  check('title 被单独返回', out.title === '这个梗是怎么来的')
  check('没有连续空行', !/\n{3,}/.test(out.text))
}

// ── 截断 ─────────────────────────────────────────────────────────────
{
  const long = `<p>${'猫'.repeat(200)}</p>`
  const out = htmlToText(long, { maxChars: 50 })
  check('超长被截断', out.truncated === true && out.text.length <= 52, `${out.text.length} 字`)
  check('截断后有省略号', out.text.endsWith('……'))

  const short = htmlToText('<p>短</p>', { maxChars: 50 })
  check('未超长不标 truncated', short.truncated === false)
}

// ── 空页面：必须说"没读到"，不能假装读过 ─────────────────────────────
{
  const empty = formatLinkReading('https://example.com/x', '<html><title>空</title><body></body></html>')
  check('★ 没有正文时 ok=false', empty.ok === false)
  check('★ 明确告诉模型「你没有读到」', empty.text.includes('没有') && empty.text.includes('别假装'), empty.text.slice(0, 50))

  const real = formatLinkReading('https://example.com/x',
    `<title>梗来源</title><p>${'这是一段足够长的正文内容，用来通过 80 字的门槛判定。'.repeat(4)}</p>`)
  check('有正文时 ok=true', real.ok === true)
  check('输出带标题与链接', real.text.includes('《梗来源》') && real.text.includes('https://example.com/x'))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
