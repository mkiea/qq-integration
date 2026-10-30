/**
 * 只读对话视图：把 `qq-memory/*.json` 渲染成「她跟谁聊了什么」（`/qqai/chatlog`）。
 *
 * **为什么要有这个**（2026-10-29「写成 dsh 插件呢」）：
 * 想看她在 QQ 里说了什么，以前唯一的办法是回 dsh 网页**点开 `qq-…` 那个会话** ——
 * 而点开就等于拿走那个会话的写句柄（dsh 的写锁对活着的持有者永不过期），
 * 桥这边随后就抢不到，她的下一句会被静默等锁拖住甚至超时。
 * 记忆文件是桥自己写的、**只读打开不涉及任何锁**，所以这个视图可以替代「点开会话」。
 *
 * **数据源刻意选 `qq-memory` 而不是 dsh 的会话日志**：
 *   ① 不碰 dsh 的写锁，连只读句柄都不需要
 *   ② 已经是「人话」（role / text / ts），不用解析事件流格式
 * 代价：只覆盖记忆窗口（`memoryMaxEntries`，默认 60 条）+ `archive` 归档，
 * **不是全部历史**。要更早的记录请直接看 dsh 会话本身；`qq-trace.jsonl` 是审计流，不是对话。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

/** 记忆目录：与 `QQBridge` 构造函数里那一行必须**逐字一致**（`config.cwd || process.cwd()`）。 */
export function memoryDirOf(config = {}, cwd = process.cwd()) {
  return join(config.cwd || cwd, 'qq-memory')
}

/** `u_2000000001.json` → `u:2000000001`（与 `#memoryFile` 的 `[^\w-] → _` 互逆）。 */
export function chatKeyFromFilename(name = '') {
  const base = String(name).replace(/\.json$/i, '')
  const at = base.indexOf('_')
  return at > 0 ? `${base.slice(0, at)}:${base.slice(at + 1)}` : base
}

/** 一条记忆记录只留这三样：谁、说了什么、什么时候。`ts` 是毫秒。 */
function normalizeEntry(raw) {
  const role = raw?.role === 'assistant' ? 'assistant' : 'user'
  const text = typeof raw?.text === 'string' ? raw.text : ''
  const ts = Number(raw?.ts) || 0
  const name = typeof raw?.name === 'string' ? raw.name : ''
  const userId = Number(raw?.userId) || 0
  return { role, text, ts, name, userId }
}

/**
 * 把 `archive`（更早的归档）与 `history`（最近 N 条）合成一条时间线。
 *
 * 两段**可能重叠**（归档时把旧条目搬进 archive，history 里那条还在），
 * 所以按 `ts + role + text` 去重；同一条消息被记两次在页面上看起来就像她自言自语。
 */
export function mergeTimeline(data, { limit = 400 } = {}) {
  const wrap = (list) => (Array.isArray(list) ? list : [])
  const all = [...wrap(data?.archive), ...wrap(data?.history)].map(normalizeEntry)
    .filter((entry) => entry.text !== '' || entry.ts !== 0)
  const seen = new Set()
  const unique = []
  for (const entry of all) {
    const key = `${entry.ts}|${entry.role}|${entry.text}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(entry)
  }
  unique.sort((a, b) => a.ts - b.ts)
  const capped = limit > 0 && unique.length > limit ? unique.slice(-limit) : unique
  return { entries: capped, total: unique.length, truncated: capped.length < unique.length }
}

/** 读一个记忆文件；读不到/坏了都返回 null（页面照常显示别的会话）。 */
export function readChatMemory(file, readFile = readFileSync, { limit = 400 } = {}) {
  try {
    const data = JSON.parse(String(readFile(file, 'utf8')))
    const { entries, total, truncated } = mergeTimeline(data, { limit })
    const last = entries.length > 0 ? entries[entries.length - 1] : null
    return {
      entries, total, truncated,
      updatedAt: Number(data?.updatedAt) || (last?.ts ?? 0),
      lastAt: last?.ts ?? 0,
      lastText: last?.text ?? '',
    }
  } catch {
    return null
  }
}

/** 列目录下所有记忆文件（它们就是"她聊过的每一个人/群"）。 */
export function listChatFiles({ memoryDir, readdir = readdirSync, stat = statSync } = {}) {
  let names = []
  try { names = readdir(memoryDir) } catch { return [] }
  const out = []
  for (const name of names) {
    if (!String(name).toLowerCase().endsWith('.json')) continue
    const file = join(memoryDir, String(name))
    let mtime = 0
    try { mtime = stat(file).mtimeMs } catch { /* 读不到 mtime 不影响列出它 */ }
    out.push({ chatKey: chatKeyFromFilename(name), file: basename(file), path: file, mtime })
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

/**
 * 一次取齐「会话列表 + 某一个会话的对话」。
 * 会话列表里带 `count/lastAt`，页面据此把最活跃的排前面，不必再请求一轮。
 */
export function buildChatLog({
  memoryDir, chatKey = '', limit = 400,
  readFile = readFileSync, readdir = readdirSync, stat = statSync,
} = {}) {
  const files = listChatFiles({ memoryDir, readdir, stat })
  const chats = files.map((entry) => {
    const memory = readChatMemory(entry.path, readFile, { limit })
    return {
      chatKey: entry.chatKey,
      count: memory?.entries.length ?? 0,
      total: memory?.total ?? 0,
      lastAt: memory?.lastAt ?? 0,
      lastText: String(memory?.lastText ?? '').slice(0, 80),
      broken: memory === null,
    }
  }).sort((a, b) => b.lastAt - a.lastAt)
  const wanted = chatKey !== '' ? chatKey : (chats[0]?.chatKey ?? '')
  const file = files.find((entry) => entry.chatKey === wanted)
  const memory = file ? readChatMemory(file.path, readFile, { limit }) : null
  return {
    chats, chatKey: wanted,
    entries: memory?.entries ?? [],
    total: memory?.total ?? 0,
    truncated: memory?.truncated === true,
    memoryDir,
  }
}

/**
 * 页面。**自包含**（零外链、零依赖），因为宿主可能连不上外网；
 * 主题跟着系统的浅色/深色走，别在暗色 dsh 里糊一块白板。
 */
export function renderChatLogHtml({ version = '', intervalMs = 4000 } = {}) {
  const refresh = Math.max(1000, Number(intervalMs) || 4000)
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>她的对话 · QQ助手</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--line:#e5e7eb;--text:#111827;--muted:#6b7280;--me:#dbeafe;--her:#fff;--accent:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--line:#262b35;--text:#e5e7eb;--muted:#9ca3af;--me:#1e3a5f;--her:#171a21;--accent:#60a5fa}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.65 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
header{position:sticky;top:0;z-index:2;display:flex;gap:.6rem;align-items:center;flex-wrap:wrap;
  padding:.6rem 1rem;background:var(--card);border-bottom:1px solid var(--line)}
h1{margin:0;font-size:.95rem;font-weight:600}
select,button{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:.3rem .5rem}
button{cursor:pointer}
.meta{color:var(--muted);font-size:.8rem}
main{max-width:52rem;margin:0 auto;padding:1rem 1rem 4rem}
.row{display:flex;margin:.5rem 0}
.row.me{justify-content:flex-end}
.bubble{max-width:78%;padding:.5rem .75rem;border-radius:12px;background:var(--her);border:1px solid var(--line);
  white-space:pre-wrap;word-break:break-word}
.row.me .bubble{background:var(--me);border-color:transparent}
.who{font-size:.75rem;color:var(--muted);margin:0 .35rem .15rem}
.when{font-size:.7rem;color:var(--muted);margin-top:.25rem}
.empty{color:var(--muted);text-align:center;margin:3rem 0}
.bad{color:#b45309}
</style></head><body>
<header>
  <h1>她的对话</h1>
  <select id="pick" aria-label="选择会话"></select>
  <span class="meta" id="stat"></span>
  <span style="flex:1"></span>
  <button id="reload" type="button">刷新</button>
</header>
<main id="list"><div class="empty">正在读记忆…</div></main>
<script>
var BASE = '/qqai/chatlog/data'
var INTERVAL = ${refresh}
var pick = document.getElementById('pick')
var list = document.getElementById('list')
var stat = document.getElementById('stat')
function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c] }) }
function when(ts){
  if (!ts) return ''
  var d = new Date(ts)
  function p(n){ return n < 10 ? '0' + n : '' + n }
  return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}
function paint(data){
  var chats = data.chats || []
  if (pick.options.length !== chats.length) {
    var keep = pick.value || data.chatKey
    pick.innerHTML = chats.map(function(c){
      var tag = c.chatKey.indexOf('g:') === 0 ? '群 ' : '私聊 '
      return '<option value="' + esc(c.chatKey) + '">' + tag + esc(c.chatKey.slice(2)) + '（' + c.count + ' 条）</option>'
    }).join('')
    pick.value = keep
    if (!pick.value && chats.length) pick.value = chats[0].chatKey
  }
  var entries = data.entries || []
  stat.textContent = '共 ' + data.total + ' 条' + (data.truncated ? '（只显示最近 ' + entries.length + ' 条）' : '')
  if (!entries.length) { list.innerHTML = '<div class="empty">这个会话还没有记忆（她还没在这里说过话）</div>'; return }
  var atBottom = (window.innerHeight + window.scrollY) >= (document.body.scrollHeight - 80)
  list.innerHTML = entries.map(function(e){
    var me = e.role === 'user'
    var who = me ? (e.name || e.userId || '他') : '她'
    return '<div class="row ' + (me ? 'me' : 'her') + '"><div style="max-width:100%">'
      + '<div class="who" style="text-align:' + (me ? 'right' : 'left') + '">' + esc(who) + '</div>'
      + '<div class="bubble">' + esc(e.text) + '</div>'
      + '<div class="when" style="text-align:' + (me ? 'right' : 'left') + '">' + when(e.ts) + '</div>'
      + '</div></div>'
  }).join('')
  if (atBottom) window.scrollTo(0, document.body.scrollHeight)
}
function load(){
  var chat = pick.value || ''
  fetch(BASE + (chat ? '?chat=' + encodeURIComponent(chat) : ''))
    .then(function(r){ return r.json() })
    .then(function(j){
      if (!j.ok) { list.innerHTML = '<div class="empty bad">' + esc(j.reason || '读不到记忆') + '</div>'; return }
      if (!pick.value && j.chatKey) { pick.value = j.chatKey }
      paint(j)
    })
    .catch(function(e){ list.innerHTML = '<div class="empty bad">请求失败：' + esc(e.message) + '</div>' })
}
pick.addEventListener('change', load)
document.getElementById('reload').addEventListener('click', load)
load()
setInterval(load, INTERVAL)
</script>
<footer style="text-align:center;padding:0 0 2rem"><span class="meta">QQ 助手${version ? ' v' + version : ''} · 只读记忆，不动任何会话锁</span></footer>
</body></html>`
}
