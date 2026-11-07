/**
 * 「登录后离线消息重放」守卫（2026-11-07）。
 *
 * 起因：换号重登之后，Waylay 把离线/历史消息一次性补推，实测**一分钟涌入 203 条**，
 * 插件逐条当新消息处理 ⇒ 拉出 262 条回复 ⇒ 用户看到刷屏。
 *
 * 为什么不能按消息时间戳判断：Waylay 的 message 事件**不透传 `time` 字段**
 * （实测 204 条里 0 条带），所以「早于登录时间就跳过」这条路走不通。
 * 能依赖的只有**涌入速率**：私聊不可能 5 秒发 6 条，历史消息重放必然瞬间成批。
 *
 * 为什么不做到「一条都不回」：消息是逐条到达的，第 10 条才知道这是批量，
 * 前 9 条已经进了处理流程。所以设计成「前 9 条照常，第 10 条起静默 20 秒」——
 * 203 条重放最多回 9 条，而不是全放过去。要更严格就把 burst 调小
 * （但 6 会误伤真实对话，见下面 REPLAY_BURST 的注释）。
 *
 * 只对**私聊**生效：活跃群里 5 秒 6 条是正常聊天，误伤代价太大。
 */

export const REPLAY_WINDOW_MS = 5000
/**
 * 阈值从 6 提到 10（2026-11-07 当天调）：6 条就会误伤真实对话——
 * `commands-unit` 里「8 条快速提问」被吞了 3 条。真人连发 6~8 条很常见，
 * 而离线重放是 200 条量级，两者之间有很大空间。宁可漏拦（多回几条），
 * 也不要让正常聊天被静默。
 */
export const REPLAY_BURST = 10
export const REPLAY_SILENCE_MS = 20_000
/**
 * 换号后自动武装守卫的时长（2026-11-07 用户拍板：默认关，账号不一致时再主动开）。
 *
 * 为什么是「换号触发」而不是「一直开着」：历史消息补推只在登录号变化时发生，
 * 平时开着只会为它付误伤代价。所以默认关，检测到 self 号变了才武装 10 分钟。
 * 10 分钟足够覆盖「换号 → 补推 200 条」这一段；再长也没有意义。
 */
export const REPLAY_ARM_MS = 10 * 60_000

/**
 * @param {{windowMs?: number, burst?: number, silenceMs?: number}} opts
 */
export function createReplayGuard({
  windowMs = REPLAY_WINDOW_MS,
  burst = REPLAY_BURST,
  silenceMs = REPLAY_SILENCE_MS,
} = {}) {
  /** chatKey -> { times: number[], until: number } */
  const state = new Map()

  return {
    /**
     * @returns {{ block: true, reason: string, until?: number } | { block: false }}
     */
    inspect(chatKey, now = Date.now()) {
      const key = String(chatKey ?? '')
      if (key === '') return { block: false }

      let entry = state.get(key)
      if (!entry) {
        entry = { times: [], until: 0 }
        state.set(key, entry)
      }

      // 静默期内一律拦；静默期结束会自然放行，不需要额外清理
      if (now < entry.until) {
        return { block: true, reason: 'replay-silence', until: entry.until }
      }

      // 只保留窗口内的时间戳，避免数组无限增长
      entry.times = entry.times.filter((t) => now - t < windowMs)
      entry.times.push(now)

      if (entry.times.length >= burst) {
        entry.until = now + silenceMs
        entry.times = []
        return { block: true, reason: 'replay-burst', until: entry.until }
      }
      return { block: false }
    },

    /** 会话数（诊断/测试用）。 */
    size() {
      return state.size
    },

    reset() {
      state.clear()
    },
  }
}
