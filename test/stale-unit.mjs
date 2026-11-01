/**
 * 「控制台进程比代码旧」的检测（2026-11-01 夜，一晚被咬两次）。
 *
 * 现象（真机两次）：
 *   ① 面板上出现新按钮 → 点下去回「未知接口」（路由在内存里，是旧的）；
 *   ② 新 UI 按新结构读旧服务端的数据 → 显示「标准块 0/5」+「缺五个必填块」，
 *      而人设其实是完整的 —— 这不是报错，是**看起来正常的错**。
 *
 * 判据：源文件的 mtime 有没有超过进程启动时间。
 * 这个套件钉四件事：
 *   A 文件比进程新 ⇒ stale
 *   B 文件比进程旧 ⇒ 不 stale（不能天天误报，否则提示会被无视）
 *   C 1 秒容忍窗口（启动瞬间自己写过文件不算旧）
 *   D 真的从 HTTP 拿得到（`/api/status.build`）——只测纯函数，等于没测到用户看到的东西
 */
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectStale } from '../control/lib/staleness.mjs'
import { createControlServer, createToken } from '../control/lib/server.mjs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const root = mkdtempSync(join(tmpdir(), 'qq-stale-'))
const statOf = (times) => (file) => {
  if (!(file in times)) { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error }
  return { mtimeMs: times[file] }
}

// ---------- A/B/C. 纯函数 ----------
{
  const started = 1_000_000
  const stale = detectStale({ files: ['a.js'], startedAt: started, stat: statOf({ 'a.js': started + 60_000 }) })
  check('A 文件比进程新 ⇒ stale', stale.stale === true && stale.newestFile === 'a.js', JSON.stringify(stale))
  check('A 数出了几个文件更新', stale.newerCount === 1, String(stale.newerCount))

  const fresh = detectStale({ files: ['a.js'], startedAt: started, stat: statOf({ 'a.js': started - 60_000 }) })
  check('B 文件比进程旧 ⇒ 不 stale', fresh.stale === false, JSON.stringify(fresh))

  const edge = detectStale({ files: ['a.js'], startedAt: started, stat: statOf({ 'a.js': started + 300 }) })
  check('C 1 秒内不算旧（启动瞬间写过文件不误报）', edge.stale === false, JSON.stringify(edge))

  const multi = detectStale({
    files: ['a.js', 'b.js', 'gone.js'],
    startedAt: started,
    stat: statOf({ 'a.js': started + 1000, 'b.js': started + 9000 }),
  })
  check('C 取最新那个文件报给用户', multi.newestFile === 'b.js', JSON.stringify(multi))
  check('C 读不到的文件被跳过，不算更新', multi.newerCount === 1 && multi.checked === 2, JSON.stringify(multi))

  const none = detectStale({ files: [], startedAt: started, stat: statOf({}) })
  check('C 没有可看的文件时不误报', none.stale === false && none.checked === 0, JSON.stringify(none))
}

// ---------- D. 真的能从 /api/status 拿到 ----------
{
  const uiFile = join(root, 'ui.html')
  writeFileSync(uiFile, '<h1>t</h1>')
  const api = { status: async () => ({ ok: true, fake: 1 }) }
  const token = createToken()
  const server = createControlServer({ config: { ports: { control: 0 } }, token, api, ui: '<h1>t</h1>', uiFile })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const url = (path) => `http://127.0.0.1:${port}${path}?token=${encodeURIComponent(token)}`

  const before = await (await fetch(url('/api/status'))).json()
  check('D 服务起来了且 status 里带 build', before?.build !== undefined, JSON.stringify(Object.keys(before ?? {})))
  check('D 刚启动时不是 stale', before.build.stale === false, JSON.stringify(before.build))
  check('D 原有字段没被覆盖', before.fake === 1, String(before.fake))

  // 把 ui.html 的 mtime 推到未来 —— 等价于"重启前又改了一版界面"
  const future = new Date(Date.now() + 60_000)
  utimesSync(uiFile, future, future)
  const after = await (await fetch(url('/api/status'))).json()
  check('D ★ 代码比进程新时 stale=true', after.build.stale === true, JSON.stringify(after.build))
  check('D 报出的就是刚改的那个文件', String(after.build.newestFile).endsWith('ui.html'), String(after.build.newestFile))

  await new Promise((resolve) => server.close(resolve))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
try { rmSync(root, { recursive: true, force: true }) } catch {}
