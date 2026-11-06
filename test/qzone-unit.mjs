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



// ---------- G. 带图的说说：先传图拿 richval，再带 richtype/richval 发布 ----------
{
  const posts = []
  const qzone = createQzone({
    fetchClientKey: async () => 'CK',
    request: async (req) => {
      if (req.url.includes('/jump')) {
        return { status: 302, headers: { 'set-cookie': ['skey=S; Path=/', 'p_skey=P; Path=/'] }, body: '' }
      }
      if (req.url.includes('cgi_upload_image')) {
        return { status: 200, headers: {}, body: '<script>frameElement.callback({"code":0,"data":{"albumid":"ALB","lloc":"LL","type":2,"height":800,"width":600}})</script>' }
      }
      posts.push(req)
      return { status: 200, headers: {}, body: '_Callback({"code":0,"tid":"T1"})' }
    },
  })
  const out = await qzone.publish('看图', { uin: 42, images: ['BASE64DATA'] })
  check('G 带图发布成功', out.ok === true && out.tid === 'T1', JSON.stringify(out))
  const body = String(posts.at(-1)?.body ?? '')
  check('G ★ 表单带上 richtype=1', /richtype=1/.test(decodeURIComponent(body)), body.slice(0, 120))
  check('G ★ richval 是「逗号开头 + albumid/lloc/type/宽高」的形状',
    /richval=%2CALB%2CLL%2CLL%2C2%2C800%2C600%2C%2C800%2C600/.test(body), body.slice(0, 200))
}

{
  const qzone = createQzone({
    fetchClientKey: async () => 'CK',
    request: async (req) => {
      if (req.url.includes('/jump')) return { status: 302, headers: { 'set-cookie': ['skey=S; Path=/', 'p_skey=P; Path=/'] }, body: '' }
      return { status: 200, headers: {}, body: '<script>frameElement.callback({"code":-100,"message":"上传失败"})</script>' }
    },
  })
  let error = null
  try { await qzone.publish('x', { uin: 1, images: ['B64'] }) } catch (e) { error = e }
  check('G ★ 传图失败时要抛错并带 code/message', /传图失败/.test(String(error?.message ?? '')) && /-100/.test(String(error?.message ?? '')), String(error?.message ?? ''))
}



// ---------- H. 说说正文里的 [img:名字] 标记（2026-11-02 夜） ----------
import { splitMomentMarkers, proactiveMomentPrompt } from '../lib/bridge.js'
{
  const one = splitMomentMarkers('今天不想说话 [img:贴-委屈]')
  check('H 剥掉标记，正文干净', one.text === '今天不想说话', JSON.stringify(one))
  check('H 收到一个表情名', one.stickers.length === 1 && one.stickers[0] === '贴-委屈', JSON.stringify(one.stickers))

  const face = splitMomentMarkers('哼 [face:贴-盯] 不理你了')
  check('H [face:x] 也一并丢掉（Qzone 里没有黄脸的位置）', !/\[face/.test(face.text) && face.stickers.length === 0, JSON.stringify(face))

  const onlyMarker = splitMomentMarkers('[img:贴-乖笑]')
  check('H ★ 只有标记时不许把正文变成空（退回原文）', onlyMarker.text === '[img:贴-乖笑]', JSON.stringify(onlyMarker))

  const many = splitMomentMarkers('a [img:一] b [img:二]')
  check('H 多个标记都收下来（调用方只取第一张）', many.stickers.length === 2, JSON.stringify(many.stickers))

  // ---- [pic:] 真图标记（2026-11-06，主人：「添加炫耀（QQ空间发送图片）」）----
  const picLatest = splitMomentMarkers('晒一下 [pic:最近]')
  check('H [pic:最近] → 最近 1 张', picLatest.pics.length === 1 && picLatest.pics[0] === 1, JSON.stringify(picLatest))
  check('H [pic:] 也从正文里剥掉', picLatest.text === '晒一下', JSON.stringify(picLatest.text))

  // ★ 语义（2026-11-06 改）：`[pic:N]` = 取**最近 N 张**，不是"第 N 张"
  const pic2 = splitMomentMarkers('看看 [pic:2]')
  check('H [pic:2] → 取最近 2 张', pic2.pics.length === 1 && pic2.pics[0] === 2, JSON.stringify(pic2))

  const pic9 = splitMomentMarkers('摊开 [pic:9]')
  check('H [pic:9] 在平台上限内（≤9）', pic9.pics[0] === 9, JSON.stringify(pic9))

  const pic10 = splitMomentMarkers('超上限 [pic:10]')
  check('H [pic:10] 超上限当没写', pic10.pics.length === 0, JSON.stringify(pic10))

  const picOut = splitMomentMarkers('无效 [pic:99]')
  check('H 越界（99）当没写', picOut.pics.length === 0, JSON.stringify(picOut))

  // ---- [pic:喜欢] = 只取标过喜欢的（2026-11-06，主人：「发她真正喜欢的吧」）----
  const fav1 = splitMomentMarkers('晒一下 [pic:喜欢]')
  check('H [pic:喜欢] 解析为 -1（标记「只取喜欢的」）', fav1.pics.length === 1 && fav1.pics[0] === -1, JSON.stringify(fav1))
  const fav2 = splitMomentMarkers('晒 [pic:fav]')
  check('H [pic:fav] 同义', fav2.pics[0] === -1, JSON.stringify(fav2))
  const zero = splitMomentMarkers('无效 [pic:0]')
  check('H [pic:0] 被拒（0 既不是张数也不是喜欢）', zero.pics.length === 0, JSON.stringify(zero))

  const plain = splitMomentMarkers('就是想说句话')
  check('H 没标记就纯文字（不是每条都要配图）', plain.pics.length === 0 && plain.stickers.length === 0, JSON.stringify(plain))

  const both = splitMomentMarkers('图 [pic:1] 表情 [img:开心]')
  check('H [pic:] 与 [img:] 共存', both.pics[0] === 1 && both.stickers[0] === '开心', JSON.stringify(both))

  // ---- 旁白：有真图时才提 [pic:]，且明确说"别每条都配" ----
  const hintYes = proactiveMomentPrompt(new Date('2026-11-06T20:00:00'), [], true)
  const hintNo = proactiveMomentPrompt(new Date('2026-11-06T20:00:00'), [], false)
  check('H 有图时旁白提示 [pic:最近]', hintYes.includes('[pic:最近]'), hintYes.slice(-120))
  check('H 没图时不提 [pic:]（免得她写出取不到的标记）', !hintNo.includes('[pic:最近]'), hintNo.slice(-80))
  check('H 旁白明确说"别每条都配"', hintYes.includes('别每条都配'), hintYes.slice(-120))
}

{
  const withStickers = proactiveMomentPrompt(new Date('2026-11-02T20:00:00'), ['贴-乖笑'])
  check('H 旁白在有表情时提示写法与可用清单', /\[img:名字\]/.test(withStickers) && /贴-乖笑/.test(withStickers), withStickers.split('\n').pop())
  const without = proactiveMomentPrompt(new Date('2026-11-02T20:00:00'), [])
  check('H 旁白在没有表情时不提配图（别让她写一个不存在的名字）', !/\[img:/.test(without), without.split('\n').pop())
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
