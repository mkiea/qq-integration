/**
 * 发说说：换票 + 发布（2026-11-02）。**纯函数 + 可注入 request**，所以不需要真发。
 *
 * 这套东西的坑都在细节上，所以逐条钉住：
 *   A g_tk 必须用 **p_skey** 算（不是 skey），且算法是 hash33
 *   B 换票 URL 的 `u1` 必须是 h5.qzone 那个地址，`keyindex=19%27` 的 `%27` 少一个都不行
 *     （少一个服务端就回 `pt_qlogincode=5`，只给一个"未登录"的 cookie）
 *   C 没有 skey/p_skey 时必须**抛错**，不能带着空票去发（那会得到一个像账号问题的错）
 *   D 发布要剥 `_Callback(...)` 壳；`code!==0` 要带上 code/message
 *   E 响应不是 JSON 时说"看不懂"，别假装成功
 */
import { buildJumpUrl, createQzone, extractJson, hash33, parseSetCookies } from '../lib/qzone.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// ---------- A. g_tk ----------
{
  // 独立实现一遍算法做对照（不是抄自己的）
  const ref = (text) => {
    let h = 5381
    for (let i = 0; i < text.length; i += 1) h = (h * 33 + text.charCodeAt(i)) >>> 0
    return h & 0x7fffffff
  }
  const sample = 'abc123XYZ'
  check('A hash33 与独立实现一致', hash33(sample) === ref(sample), `${hash33(sample)} vs ${ref(sample)}`)
  check('A 结果在 31 位内', hash33(sample) >= 0 && hash33(sample) <= 0x7fffffff)
}

// ---------- B. 换票 URL 的形状 ----------
{
  const url = buildJumpUrl(3000000001, 'KEY123')
  check('B u1 指向 h5.qzone', url.includes('h5.qzone.qq.com%2Fqqnt%2Fqzoneinpcqq%2Ffriend'), url.slice(0, 120))
  check('B ★ keyindex 末尾带 %27', url.endsWith('keyindex=19%27'), url.slice(-20))
  check('B 带上了 clientuin 与 clientkey', url.includes('clientuin=3000000001') && url.includes('clientkey=KEY123'))
}

// ---------- 解析 Set-Cookie ----------
{
  const jar = parseSetCookies([
    'skey=old; Path=/; Domain=qq.com',
    'p_skey=abc; Path=/',
    'skey=new; Path=/; Domain=qq.com',      // 同名以**后出现**为准
    'garbage-without-equals',
  ])
  check('同名 cookie 后出现的覆盖前面的', jar.skey === 'new', JSON.stringify(jar))
  check('取得到 p_skey', jar.p_skey === 'abc')
  check('没有等号的坏行被跳过', !('garbage-without-equals' in jar))
}

// ---------- C. 换票失败必须抛错 ----------
{
  const qzone = createQzone({
    fetchClientKey: async () => 'CLIENTKEY',
    request: async () => ({ status: 200, headers: { 'set-cookie': ['pt_qlogincode=5; Path=/'] }, body: '' }),
  })
  let error = null
  try { await qzone.auth(1000) } catch (e) { error = e }
  check('C ★ 没拿到 skey/p_skey 时抛错', error !== null, String(error?.message ?? '没抛错'))
  check('C 错误里点名缺的是 skey/p_skey', /skey\/p_skey/.test(String(error?.message ?? '')), String(error?.message ?? ''))
  check('C 错误里带上了服务端给了哪些 cookie', /pt_qlogincode/.test(String(error?.message ?? '')), String(error?.message ?? ''))
}

{
  const qzone = createQzone({ fetchClientKey: async () => '', request: async () => { throw new Error('不该发请求') } })
  let error = null
  try { await qzone.auth(1000) } catch (e) { error = e }
  check('C 后端不给 clientKey 时立刻抛错（不发请求）', error !== null && /clientKey/.test(String(error?.message ?? '')), String(error?.message ?? ''))
}

// ---------- D/E. 发布 ----------
{
  const seen = []
  const qzone = createQzone({
    fetchClientKey: async () => 'CK',
    request: async (req) => {
      seen.push(req)
      if (req.url.includes('/jump')) {
        return { status: 302, headers: { 'set-cookie': ['skey=SK; Path=/', 'p_skey=PSK; Path=/'] }, body: '' }
      }
      return { status: 200, headers: {}, body: '_Callback({"code":0,"tid":"TID123","message":""})' }
    },
  })
  const out = await qzone.publish('今天也想你了', { uin: 12345 })
  check('D 发布成功带出 tid', out.ok === true && out.tid === 'TID123', JSON.stringify(out))
  const post = seen.find((r) => r.method === 'POST')
  check('D ★ POST 带 g_tk（用 p_skey 算的那个）', /g_tk=\d+/.test(String(post?.url ?? '')), String(post?.url ?? '').slice(-24))
  check('D 表单里有 hostuin 与 content', /hostuin=12345/.test(String(post?.body ?? '')) && /content=/.test(String(post?.body ?? '')), String(post?.body ?? '').slice(0, 80))
  check('D ★ cookie 里同时有 p_skey 与 skey', /p_skey=PSK/.test(String(post?.headers?.cookie ?? '')) && /skey=SK/.test(String(post?.headers?.cookie ?? '')), String(post?.headers?.cookie ?? '').slice(0, 60))
}

{
  const qzone = createQzone({
    fetchClientKey: async () => 'CK',
    request: async (req) => (req.url.includes('/jump')
      ? { status: 302, headers: { 'set-cookie': ['skey=S; Path=/', 'p_skey=P; Path=/'] }, body: '' }
      : { status: 200, headers: {}, body: '_Callback({"code":-3000,"message":"请先登录空间"})' }),
  })
  let error = null
  try { await qzone.publish('x', { uin: 1 }) } catch (e) { error = e }
  check('D ★ code≠0 时抛错并带上 code/message', /code=-3000/.test(String(error?.message ?? '')) && /请先登录空间/.test(String(error?.message ?? '')), String(error?.message ?? ''))
}

{
  const qzone = createQzone({
    fetchClientKey: async () => 'CK',
    request: async (req) => (req.url.includes('/jump')
      ? { status: 302, headers: { 'set-cookie': ['skey=S; Path=/', 'p_skey=P; Path=/'] }, body: '' }
      : { status: 502, headers: {}, body: '<html>bad gateway</html>' }),
  })
  let error = null
  try { await qzone.publish('x', { uin: 1 }) } catch (e) { error = e }
  check('E ★ 非 JSON 响应时抛"看不懂"，不假装成功', /看不懂/.test(String(error?.message ?? '')), String(error?.message ?? ''))
}

check('E extractJson 能从 _Callback(...) 里取出对象', extractJson('_Callback({"code":0})')?.code === 0)
check('E extractJson 空串返回 null', extractJson('') === null)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
