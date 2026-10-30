/**
 * Outbound media helpers: validation of paths the AGENT is allowed to send into
 * QQ, and the "long reply becomes a merged-forward card" decision.
 * Pure functions (no bridge instance) so they stay unit-testable.
 */
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'

export const DEFAULT_FILE_SEND_MAX_BYTES = 50 * 1024 * 1024

// Credential-shaped paths are never sendable, even when they sit inside an allowed root.
const FORBIDDEN_DIR = /(^|[\\/])\.(dsh|ssh|aws|gnupg|kube|docker|azure)([\\/]|$)/i
const FORBIDDEN_ENV = /(^|[\\/])\.env(\.|$)/i
const FORBIDDEN_EXT = /\.(pem|key|pfx|p12|kdbx|jks|keystore)$/i
const FORBIDDEN_NAME = /(^|[\\/])(credentials(\.json)?|id_rsa|id_ed25519|id_ecdsa|known_hosts|\.netrc|\.git-credentials|token\.json)$/i
/**
 * 桥自己的私有产物（2026-10-29）。
 *
 * 白名单根是 `config.cwd`（qq_chat），而记忆、人设、会话映射、管理队列、日志**都在这个根里面** ——
 * 所以「只允许发 cwd 之内的文件」这条规则保护不到它们：一次注入让模型发 `qq-memory/u_123.json`
 * 就能把第三方聊天记录原样外发。这里按名字禁掉。
 * 不动图片/语音落盘目录：那是她正常回复要用的东西。
 */
const FORBIDDEN_ARTIFACT = /(^|[\\/])qq-memory([\\/]|$)|(^|[\\/])(AGENTS\.md|qq-sessions\.json|qq-admin-commands\.jsonl|qq-admin-results\.jsonl|qq-events\.log|qq-moments\.log|qq-proactive-state\.json|qq-bridge-debug\.log|qq-inject\.jsonl)$/i

/** True when `target` is `root` itself or lives inside it (prefix-safe). */
export function isInside(root, target) {
  const base = resolve(root)
  const value = resolve(target)
  return value === base || value.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}

/** Directories the agent may send files from: the session cwd plus configured extras. */
export function describeSendRoots({ cwd = process.cwd(), extraDirs = [] } = {}) {
  const roots = [resolve(cwd)]
  for (const dir of extraDirs ?? []) {
    const value = String(dir ?? '').trim()
    if (value) roots.push(resolve(value))
  }
  return roots
}

/**
 * 受保护文件（桥自己的私有产物）的 `dev:ino` 集合。
 *
 * 为什么需要这个：上面所有禁令都是**对路径字符串**做正则。第二轮红队证明了两条绕过：
 *   · junction/软链接 → 用 `realpathSync` 解开后再判（已在上面的 `real` 分支处理）；
 *   · **硬链接** → `realpathSync` 返回的是**自己**的路径（硬链接没有"目标路径"可分），
 *     `linkSync('qq-memory/u_1.json', 'innocent.txt')` 之后 `innocent.txt` 路径完全合法。
 * 唯一可靠的判据是**文件身份**（inode），不是它的名字。
 * 于是：枚举受保护文件的实际 inode，和待发送文件的 inode 比对。同一个文件换多少个名字都认得。
 *
 * 开销：每次发文件时列一遍 qq-memory（几十个文件）+ 几个固定名。发送不频繁，可接受。
 * 失败一律吞掉 —— 这一层是加固，不能因为它读不到目录就把正常发送打断。
 */
function guardedInodes(cwd) {
  const set = new Set()
  const add = (p) => {
    try {
      const s = statSync(p)
      if (s.isFile()) set.add(`${s.dev}:${s.ino}`)
    } catch { /* 不存在就跳过 */ }
  }
  try {
    const mem = join(cwd, 'qq-memory')
    for (const name of readdirSync(mem)) add(join(mem, name))
  } catch { /* 没有记忆目录就算了 */ }
  for (const name of [
    'AGENTS.md', 'qq-sessions.json', 'qq-admin-commands.jsonl', 'qq-admin-results.jsonl',
    'qq-events.log', 'qq-moments.log', 'qq-proactive-state.json', 'qq-bridge-debug.log',
    'qq-inject.jsonl', '.env', 'qq-canary.json',
  ]) add(join(cwd, name))
  return set
}

/**
 * Validate one agent-provided outbound path.
 * @returns the absolute path, or throws an Error with a Chinese explanation.
 */
export function resolveSendPath(raw, { cwd = process.cwd(), extraDirs = [], maxBytes = DEFAULT_FILE_SEND_MAX_BYTES } = {}) {
  const value = String(raw ?? '').trim()
  if (!value) throw new Error('未提供文件路径')
  if (value.includes('\0')) throw new Error('路径非法')
  if (value.length > 400) throw new Error('路径过长')
  const abs = isAbsolute(value) ? resolve(value) : resolve(cwd, value)
  const roots = describeSendRoots({ cwd, extraDirs })
  if (!roots.some((root) => isInside(root, abs))) {
    throw new Error(`路径不在允许发送的目录内：${roots.join(' / ')}`)
  }
  if (FORBIDDEN_DIR.test(abs) || FORBIDDEN_ENV.test(abs) || FORBIDDEN_EXT.test(abs) || FORBIDDEN_NAME.test(abs)) {
    throw new Error('该路径被安全策略禁止外发（凭据/密钥类文件）')
  }
  if (FORBIDDEN_ARTIFACT.test(abs)) {
    throw new Error('该路径是桥自己的私有产物（记忆/人设/会话/日志），一律不许外发')
  }
  if (!existsSync(abs)) throw new Error(`文件不存在：${abs}`)
  /**
   * ★ 反链接绕过（2026-10-29 红队 D⑩ 打穿后补的）。
   *
   * 上面所有禁令都是**对路径字符串**做正则。而在 cwd 里建一个 junction/软链接
   * `pics -> qq-memory`，路径 `pics/u_1.json` 里根本不含 `qq-memory` 这四个字 ⇒ 全部绕过。
   * （实测：Windows 上 `symlinkSync(target, link, 'junction')` 建的目录链接就能过。）
   *
   * 修法：**判完字符串，再判真实路径**。realpathSync 会把链接解开到最终目标，
   * 之后用同一套规则再审一次 —— 链接、8.3 短名、大小写、`..` 全都会被这一步归一化。
   */
  let real = abs
  try { real = realpathSync(abs) } catch { /* 解不开就用原路径继续，下面的检查照跑 */ }
  if (real !== abs) {
    if (!roots.some((root) => isInside(root, real))) {
      throw new Error(`路径经链接后跑到了允许目录之外：${real}`)
    }
    if (FORBIDDEN_DIR.test(real) || FORBIDDEN_ENV.test(real) || FORBIDDEN_EXT.test(real) || FORBIDDEN_NAME.test(real)) {
      throw new Error('该路径指向凭据/密钥类文件（链接绕过）')
    }
    if (FORBIDDEN_ARTIFACT.test(real)) {
      throw new Error('该路径指向桥自己的私有产物（记忆/人设/会话/日志），一律不许外发（链接绕过）')
    }
  }
  let stat
  try { stat = statSync(abs) } catch (error) { throw new Error(`无法读取文件：${error.message}`) }
  if (!stat.isFile()) throw new Error('目标不是文件')
  // 硬链接绕过：名字合法、inode 是私有产物 ⇒ 拒（见 guardedInodes 的注释）
  if (guardedInodes(cwd).has(`${stat.dev}:${stat.ino}`)) {
    throw new Error('该文件与桥的私有产物（记忆/人设/会话/日志）是同一个文件（硬链接），一律不许外发')
  }
  const limit = Math.max(1, Number(maxBytes) || DEFAULT_FILE_SEND_MAX_BYTES)
  if (stat.size > limit) {
    throw new Error(`文件过大：${(stat.size / 1048576).toFixed(1)} MB（上限 ${Math.round(limit / 1048576)} MB）`)
  }
  return abs
}

/** Long group replies may be delivered as a merged-forward card instead of a wall of text. */
export function shouldForwardText(text, { enabled = false, force = false, threshold = 600, messageType = 'group' } = {}) {
  if (!force && enabled !== true) return false
  if (messageType !== 'group') return false
  const min = Math.max(200, Number(threshold) || 600)
  return String(text ?? '').length >= min
}

/**
 * 「回复带引用」（v0.6.9）：要不要给这条回复挂一个 `reply` 段指向被回复的消息。
 *
 * 返回 `{ type: 'reply', data: { id } }` 或 `null`（不挂）。**纯函数**，便于单测。
 *
 * 这里的"不挂"都是有意为之：
 *   - 开关没开（`quoteReplyEnabled` 默认 **false**——引用会改变群里的观感，不能默认开）；
 *   - 注入/回放的帧：它们的 message_id 是假的，引用会失败或引到无关消息；
 *   - 没有 messageId 的消息（notice 触发的回复、定时任务等）。
 *
 * ⚠️ 就算这里返回了引用段，发送方仍要能**降级重发**：QQ 的 message_id 有有效期/可能被撤回，
 *    NapCat 会直接报错；那种情况下不带引用再发一次，别把整条回复弄丢。
 */
export function quoteSegmentFor(message, config = {}) {
  if (config.quoteReplyEnabled !== true) return null
  // **只在群聊里引用**：私聊是一对一，引用只是把同一句话再显示一遍（开关说明里"单人聊天显得啰嗦"指的就是这个）。
  if (message?.messageType !== 'group') return null
  if (message?.__injected === true || message?.__replayed === true) return null
  const id = message?.messageId
  if (id === undefined || id === null || String(id) === '') return null
  return { type: 'reply', data: { id: String(id) } }
}

/** Human-readable label for a validated send path. */
export function labelOfSendPath(abs) {
  return basename(String(abs))
}
