/**
 * 管理员指令里"偏工具"的那几条（2026-11-02 从 bridge.js 搬出来）。
 *
 * 为什么搬：bridge.js 已经 12.7k 行、308 个方法，再往里加东西就真成上帝文件了。
 * 这三条（`!probe` / `!sessions` / `!qa`）的共同点是**只读、不碰会话状态**，
 * 依赖也很薄（socket、callAction、config、sessionStore、workspaceRegistry），
 * 所以是最安全的第一块 —— 搬完由 probe-unit / sessions-admin-unit / qa-admin-unit 判定。
 *
 * 约定：返回 `null` 表示"这条不是我管的"，交回 bridge 继续往下判。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export async function handleAdminExtra({ cmd, spec }, deps) {
      /**
       * `!probe <action> [json]` —— 原样调用一个 OneBot action，结果写进
       * `<数据目录>/_debug/probe-<action>-<ts>.json`，只回一句"调用了/失败了"。
       *
       * 为什么落盘不回消息：`__introspect` 那种输出几十上百 KB，发到 QQ 里既发不出去也没法看。
       * 回执只给路径和字节数 —— 看得懂的人自己去翻。
       */
      if (cmd === 'probe') {
        const action = String(spec.action ?? '').trim()
        if (action === '') return { ok: false, cmd, error: '用法：!probe <action> [json参数]（例：!probe __introspect）' }
        if (spec.params === null) return { ok: false, cmd, error: '参数不是合法 JSON —— 记得整个对象用花括号包起来' }
        const socket = deps.socket()
        if (!socket) return { ok: false, cmd, error: 'OneBot 没连上，调不了' }
        const params = spec.params ?? {}
        const started = Date.now()
        try {
          const data = await deps.callAction(socket, action, params)
          const size = JSON.stringify(data ?? null).length
          const dir = join(deps.dataRoot(), '_debug')
          mkdirSync(dir, { recursive: true })
          const file = join(dir, `probe-${action.replace(/[^\w.-]/g, '_')}-${started}.json`)
          writeFileSync(file, JSON.stringify({ action, params, at: started, ms: Date.now() - started, data }, null, 2), 'utf8')
          return { ok: true, cmd, reason: `已调用 ${action}（${Date.now() - started}ms，结果 ${size} 字节）→ ${file}` }
        } catch (error) {
          return { ok: false, cmd, error: `${action} 调用失败：${error.message}` }
        }
      }
      /**
       * `!sessions` / `!sessions prune` —— 侧栏里那些"多余对话"（2026-11-02）。
       *
       * 事实：`#attachToWorkspace` 会把每个会话挂进「QQ」工作区，而**每个聊天历史上
       * 可能有好几个会话**（早期续接没修好时留下的、或撞写锁降级时开的）。
       * 折叠只把它们收进一个组，不会减少条数 —— 于是侧栏一展开还是一堆。
       *
       * 这里做的是**摘组**（`detachSession`），不是删会话：
       * 数据还在磁盘上，随时能被 `resume` 重新挂回来（桥上每次 create/resume 都会 attach）。
       * 删会话是不可逆的，不该由一条聊天指令完成。
       *
       * 判定依据只有一条：**当前映射里在用的会话保留，其余摘掉**。
       * 映射（`qq-sessions.json`）才是"这个聊天现在接的是哪条"的唯一真相。
       */
      if (cmd === 'sessions') {
        const registry = deps.workspaceRegistry()
        if (!registry || typeof registry.resolveByPath !== 'function') {
          return { ok: false, cmd, error: '宿主没有 workspaceRegistry，读不到工作区分组' }
        }
        const cwd = String(deps.config.cwd ?? '').trim()
        if (cwd === '') return { ok: false, cmd, error: '还没配置数据目录（cwd）' }
        const map = deps.sessionStore.read() ?? {}
        const inUse = new Set(Object.values(map).map((id) => String(id)))
        const workspace = await registry.resolveByPath(cwd)
        const attached = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds.map((id) => String(id)) : []
        if (attached.length === 0) {
          return { ok: true, cmd, reason: '「QQ」工作区里没有挂着的会话（可能宿主没这个分组功能）' }
        }
        const stale = attached.filter((id) => !inUse.has(id))
        if (spec.prune !== true) {
          return {
            ok: true, cmd,
            reason: `映射在用 ${inUse.size} 条 · 工作区挂 ${attached.length} 条 · 其中 ${stale.length} 条是旧的\n`
              + `（\`!sessions prune\` 把这 ${stale.length} 条从侧栏摘掉；只摘组，不删数据）`,
            detail: { inUse: [...inUse], attached, stale },
          }
        }
        if (stale.length === 0) return { ok: true, cmd, reason: '没有多余的会话要摘' }
        if (typeof workspace.detachSession !== 'function') {
          return { ok: false, cmd, error: '宿主的工作区对象没有 detachSession' }
        }
        let done = 0
        const failed = []
        for (const id of stale) {
          try { await workspace.detachSession(id); done += 1 } catch (error) { failed.push(`${id}: ${error.message}`) }
        }
        /**
         * `ok` 与文案必须同源：`ok:false` 时上层读的是 **`error` 字段**（`⚠️ ${error}`），
         * 写成 `reason` 会被显示成一句笼统的"指令失败" —— 那正是这套代码最忌讳的
         * "看起来失败、但看不出为什么"。
         */
        const summary = `从侧栏摘掉 ${done} 条旧会话（保留 ${inUse.size} 条在用的）`
          + (failed.length > 0 ? `\n失败 ${failed.length} 条：${failed.slice(0, 3).join('；')}` : '')
          + '\n数据没删，下次那个会话被 resume 时会自动挂回来。'
        return failed.length === 0
          ? { ok: true, cmd, reason: summary, detail: { detached: done, failed } }
          : { ok: false, cmd, error: summary, detail: { detached: done, failed } }
      }
      /**
       * `!qa` —— **能自动验的那一半**（2026-11-02，主人要"自动测试指令"）。
       *
       * 明确的分工：凡是"她答得对不对"必须人来判断（见 `docs/ACCEPTANCE.md`），
       * 这里只验**机械部分** —— 通道在不在、内核回源通不通、代理端口在不在听、会话映射脏不脏。
       * 每项都独立 try：一项炸了不影响其它项，也不许把"没验到"写成"通过"。
       */
      if (cmd === 'qa') {
        const results = []
        const record = (name, ok, detail = '') => results.push({ name, ok, detail })

        const socket = deps.socket()
        record('OneBot 通道', socket !== null, socket === null ? '没有可用的 socket' : '已连接')

        const selection = (() => {
          // ⚠️ 这里原本写的是 this.ctx —— 搬出 bridge 之后就永远是 undefined，
          // 于是「模型」这项恒报 (空)/(空)。搬运时漏改的私有访问，靠 QA 自己抓出来的。
          try { return deps.ctx?.agentDefaultModel?.currentSelection?.() ?? {} } catch { return {} }
        })()
        const provider = deps.config.provider || selection.provider || ''
        const model = deps.config.model || selection.model || ''
        record('模型', provider !== '' && model !== '', `${provider || '(空)'} / ${model || '(空)'}`)

        // 图片代理：Waylay 的本地文件代理只在 ONEBOT_WS_PORT != 0 时开；端口是我们自己在启动脚本里定的。
        const proxyPort = Number(process.env.RIN_FILE_PROXY_PORT) || 6701
        try {
          const http = await import('node:http')
          const reachable = await new Promise((resolve) => {
            // ⚠️ 别探 /file/xxx：代理对不认识的 key 会**等 10 秒**（等 NTQQ 下载）再回 404，
            // 我们的 1.5s 超时必然先到 —— 端口明明在听也会判成「没响应」。
            // 探根路径：代理对非 /file/ 请求立刻回 200 JSON。
            const req = http.request({ host: '127.0.0.1', port: proxyPort, path: '/', timeout: 1500 }, (res) => {
              res.resume()
              resolve(res.statusCode === 404 || res.statusCode === 200)
            })
            req.on('error', () => resolve(false))
            req.on('timeout', () => { req.destroy(); resolve(false) })
            req.end()
          })
          record('图片代理', reachable, reachable ? `127.0.0.1:${proxyPort} 在听` : `127.0.0.1:${proxyPort} 没响应（ONEBOT_WS_PORT 是不是 0？）`)
        } catch (error) {
          record('图片代理', false, `探测失败：${error.message}`)
        }

        // 内核回源：问一次"最近 1 条历史"。这一步通了，说明 get_xxx_msg_history 那条链是真的。
        const probeUin = spec.uin || String(deps.config.adminUsers?.[0] ?? '')
        if (socket && probeUin !== '') {
          try {
            const res = await deps.callAction(socket, 'get_friend_msg_history', { user_id: probeUin, count: 1 })
            const count = Array.isArray(res?.messages) ? res.messages.length : -1
            record('内核取历史', count >= 0, count >= 0 ? `拿到 ${count} 条` : `返回不是 messages：${JSON.stringify(res).slice(0, 80)}`)
          } catch (error) {
            record('内核取历史', false, error.message.slice(0, 100))
          }
        } else {
          record('内核取历史', false, '缺少 socket 或 uin（可写 `!qa 你的QQ号`）')
        }

        // 会话映射：只是只读统计，"脏"不算失败，只报数字。
        try {
          const map = deps.sessionStore.read() ?? {}
          const registry = deps.workspaceRegistry()
          const cwd = String(deps.config.cwd ?? '').trim()
          const inUse = new Set(Object.values(map).map((id) => String(id)))
          let attached = null
          if (registry && typeof registry.resolveByPath === 'function' && cwd !== '') {
            const workspace = await registry.resolveByPath(cwd)
            if (Array.isArray(workspace?.sessionIds)) attached = workspace.sessionIds.map((id) => String(id))
          }
          const stale = attached === null ? null : attached.filter((id) => !inUse.has(id)).length
          record('会话映射', true, `在用 ${inUse.size} 条`
            + (attached === null ? ' · 读不到工作区' : ` · 侧栏挂 ${attached.length} 条 · 旧 ${stale} 条（\`!sessions prune\` 可摘）`))
        } catch (error) {
          record('会话映射', false, error.message.slice(0, 100))
        }

        const bad = results.filter((r) => !r.ok)
        const lines = results.map((r) => `${r.ok ? '✅' : '❌'} ${r.name}：${r.detail}`)
        return {
          ok: bad.length === 0,
          cmd,
          ...(bad.length === 0 ? { reason: `自动项全过（${results.length} 项）\n${lines.join('\n')}\n\n人的部分看 docs/ACCEPTANCE.md：她答得对不对，机器判不了。` }
            : { error: `${bad.length} 项没过\n${lines.join('\n')}` }),
          checks: results,
        }
      }

  return null
}
