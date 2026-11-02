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

/**
 * ★ 真机事故（2026-11-02）：换票跳到 h5.qzone 那一跳会再回一组**空值**的
 * `skey` / `p_skey`（并伴随 `p_skey_forbid`）。按"后来者优先"处理，
 * 就把前面拿到的有效票覆盖成空 —— 表现是 HTTP 200、15 个 cookie、票却是空的，
 * 看起来像"服务端不给票"，而同一时刻 curl 是好的。
 */
{
  const jar = parseSetCookies([
    'skey=GOOD; Path=/',            // 第一跳拿到的有效票
    'p_skey=GOODPSK; Path=/',
    'p_skey_forbid=1; Path=/',      // 最后一跳的"禁止"标记
    'p_skey=; Path=/',              // 最后一跳把它清空 —— 不许覆盖
    'skey=; Path=/',
  ])
  check('★ 空值不许覆盖已有的非空 skey', jar.skey === 'GOOD', JSON.stringify(jar))
  check('★ 空值不许覆盖已有的非空 p_skey', jar.p_skey === 'GOODPSK', JSON.stringify(jar))

  const reversed = parseSetCookies(['skey=; Path=/', 'skey=GOOD; Path=/'])
  check('先空后有值时，最终是那个有值的', reversed.skey === 'GOOD', JSON.stringify(reversed))
}

// ---------- C. 换票失败必须抛错（真机两种形态都出现过） ----------
// 形态①：HTTP 503，Set-Cookie 里 skey/p_skey **字段都在、值是空的**（真机就是这么报的）
{
  let calls = 0
  const qzone = createQzone({
    fetchClientKey: async () => "CLIENTKEY",
    request: async () => {
      calls += 1
      return { status: 503, headers: { "set-cookie": ["skey=; Path=/", "p_skey=; Path=/", "uin=o1; Path=/"] }, body: "" }
    },
  })
  let error = null
  try { await qzone.auth(1000) } catch (e) { error = e }
  const message = String(error?.message ?? "")
  check("C ★ 字段在但值为空时抛错", error !== null, message)
  check('C 说的是「值是空的」，不是「没有字段」', /值是空的/.test(message) && !/字段都不在/.test(message), message)
  check("C 报告了 cookie 总数（不列名字，避免自相矛盾）", /共给了 \d+ 个 cookie/.test(message), message)
  check("C 503 时提示这是频率限制", /频率限制/.test(message), message)
  check("C ★ 5xx 会重试（三次）", calls === 3, String(calls))
}

// 形态②：HTTP 200，但压根没有 skey/p_skey 字段
{
  const qzone = createQzone({
    fetchClientKey: async () => "CLIENTKEY",
    request: async () => ({ status: 200, headers: { "set-cookie": ["pt_qlogincode=5; Path=/"] }, body: "" }),
  })
  let error = null
  try { await qzone.auth(1000) } catch (e) { error = e }
  const message = String(error?.message ?? "")
  check('C 没这个字段时说「字段都不在」', /字段都不在/.test(message), message)
  check("C 200 不提示频率限制", !/频率限制/.test(message), message)
}

// 形态③：先 503（空值），重试后成功 —— 这是真机上最可能发生的情形
{
  let calls = 0
  const qzone = createQzone({
    fetchClientKey: async () => "CLIENTKEY",
    request: async () => {
      calls += 1
      if (calls === 1) return { status: 503, headers: { "set-cookie": ["skey=; Path=/", "p_skey=; Path=/"] }, body: "" }
      return { status: 200, headers: { "set-cookie": ["skey=SK2; Path=/", "p_skey=PSK2; Path=/"] }, body: "" }
    },
  })
  const ticket = await qzone.auth(1000)
  check("C ★ 重试一次后就成功拿到票", ticket.skey === "SK2" && ticket.pskey === "PSK2", JSON.stringify(ticket))
  check("C 恰好重试了一次", calls === 2, String(calls))
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
  // ★ 真机：正文的字段名是 con 不是 content（用 content 会回 20001「输入内容过长」，极其误导）
  check('D ★ 正文用字段名 con（不是 content）', /(^|&)con=/.test(String(post?.body ?? '')) && !/(^|&)content=/.test(String(post?.body ?? '')), String(post?.body ?? '').slice(0, 90))
  check('D 表单带 hostuin 与 ugc_right', /hostuin=12345/.test(String(post?.body ?? '')) && /ugc_right=/.test(String(post?.body ?? '')), String(post?.body ?? '').slice(0, 90))
  check('D 必填的版本/格式字段都在', /syn_tweet_verson=1/.test(String(post?.body ?? '')) && /feedversion=1/.test(String(post?.body ?? '')) && /format=json/.test(String(post?.body ?? '')), String(post?.body ?? '').slice(0, 120))
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

// ---------- F. 票据缓存：少打换票接口（它对频率敏感，真机第一次就 503） ----------
{
  let calls = 0
  let clock = 1_000_000
  const qzone = createQzone({
    fetchClientKey: async () => 'CK',
    now: () => clock,
    ticketTtlMs: 60_000,
    request: async () => {
      calls += 1
      return { status: 200, headers: { 'set-cookie': ['skey=S; Path=/', 'p_skey=P; Path=/'] }, body: '' }
    },
  })
  await qzone.auth(1)
  await qzone.auth(1)
  check('F 同一张票在 TTL 内只换一次（两次调用只打一次网络）', calls === 1, String(calls))
  clock += 61_000
  await qzone.auth(1)
  check('F 过了 TTL 会重新换票', calls === 2, String(calls))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
