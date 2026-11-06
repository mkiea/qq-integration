#!/usr/bin/env node
/**
 * 总纲记忆生成器（2026-11-06）。
 *
 * 主人：「要不要写一个总纲记忆，来结合一下各个对话的记忆」
 *      +「我推荐 2+本地模型总结（？）」
 *      +「偏好是根据记忆推出来的吧，写进人设会不会太突兀了」
 *
 * 为什么需要：
 *   `qq-memory/` 是**按对话分文件**的（`u_<QQ>.json` / `g_<群>.json`）。
 *   「她喜欢兔兔」这类事**跨所有对话**，但每个文件只记得"跟这个人聊了什么"。
 *   总纲 = 她的**自我记忆**（我经历了什么、我喜欢什么），不是"我跟谁聊了什么"。
 *
 * 为什么用本地模型：
 *   实测 `qwen2.5:7b` 摘要 25 条对话耗时 8.7s，提取的偏好/事件/称呼全部准确、
 *   无编造。5 个文件约 2–3 分钟，每天一次可接受。**不花云端 token。**
 *
 * 输出：`qq-memory/_self.md`（`_` 开头 ⇒ 不会被当成对话记录读回去）
 *
 * 用法：
 *   node scripts/self-memory.mjs                # 生成
 *   node scripts/self-memory.mjs --dry          # 只看输入，不调模型
 *   node scripts/self-memory.mjs --model qwen2.5:3b
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join, basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { request as httpRequest } from 'node:http'

/**
 * 数据目录：别再写死本机绝对路径（2026-11-06，隐私套件抓到 `C:/Users/<用户名>/…`）。
 *
 * 优先级：`--data-dir` > `QQ_DATA_DIR` > **相对脚本位置推导**。
 * 脚本在 `qq-integration/scripts/`，仓库旁边就是 `qq_chat/` ⇒ `../../qq_chat`。
 * 桥 spawn 时传的 cwd 已经是 dataRoot，但这里不依赖 cwd —— 手动运行也照样对。
 */
const DATA_ROOT = process.argv.includes('--data-dir')
  ? process.argv[process.argv.indexOf('--data-dir') + 1]
  : (process.env.QQ_DATA_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'qq_chat'))
const MEMORY_DIR = join(DATA_ROOT, 'qq-memory')
const OUT_FILE = join(MEMORY_DIR, '_self.md')
const DRY = process.argv.includes('--dry')
const MODEL = process.argv.includes('--model')
  ? process.argv[process.argv.indexOf('--model') + 1]
  : 'qwen2.5:7b'

/** 每个对话取最近多少条（全取会超上下文，而且旧对话参考价值低） */
const PER_CHAT = 40

function listMemoryFiles() {
  try {
    return readdirSync(MEMORY_DIR)
      .filter((n) => /^[ug]_\d+\.json$/.test(n))
      .map((n) => join(MEMORY_DIR, n))
  } catch {
    return []
  }
}

/** 把一份记忆文件渲染成可读的对话行（带说话人区分） */
function renderChat(file) {
  const json = JSON.parse(readFileSync(file, 'utf8'))
  const kind = basename(file).startsWith('g_') ? '群聊' : '私聊'
  const hist = Array.isArray(json.history) ? json.history : []
  const picked = hist.slice(-PER_CHAT)
  const lines = picked.map((m) => {
    const who = m.role === 'assistant' ? '她' : '对方'
    const text = String(m.text ?? '').replace(/\s+/g, ' ').slice(0, 120)
    return `${who}: ${text}`
  })
  return { kind, id: basename(file, '.json'), lines, updatedAt: json.updatedAt }
}

function callOllama(prompt, model) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { temperature: 0.2, num_predict: 600, num_ctx: 8192 },
    })
    const req = httpRequest(
      { host: '127.0.0.1', port: 11434, path: '/api/generate', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
        res.on('end', () => {
          try {
            const json = JSON.parse(data)
            resolve(String(json.response ?? ''))
          } catch (e) { reject(e) }
        })
      },
    )
    req.on('error', reject)
    req.setTimeout(300000, () => { req.destroy(new Error('ollama 超时')) })
    req.write(body)
    req.end()
  })
}

const PROMPT = (chats) => `下面是一个叫「软软」的小女孩和几个人的聊天片段。
请提取**关于她自己**的信息（不是"谁说了什么"，而是"她是什么样的人、经历了什么"）：

1. **她喜欢的东西**（她明确说过喜欢/想要/觉得好的）
2. **重要事件**（收到过什么、答应过什么、发生过什么）
（**不要**写"她跟谁是什么关系/称呼什么"——那部分每个对话的 u_*.json 自己带着，
混进总纲会让她在所有人面前叫错称呼）

要求：
- 只写这些记录里**真实出现**的，不要推测、不要编造
- 每条一行，用「- 」开头
- 总字数不超过 250 字
- 没有内容的类别写「- 无」

${chats.map((c) => `【${c.kind} ${c.id}】\n${c.lines.join('\n')}`).join('\n\n')}
`

const files = listMemoryFiles()
if (files.length === 0) {
  console.error(`没有找到记忆文件：${MEMORY_DIR}`)
  process.exit(1)
}

const chats = files.map(renderChat)
const totalLines = chats.reduce((n, c) => n + c.lines.length, 0)
console.log(`读取 ${chats.length} 个对话，共 ${totalLines} 条（每个取最近 ${PER_CHAT} 条）`)
for (const c of chats) console.log(`  ${c.kind} ${c.id}: ${c.lines.length} 条`)

if (DRY) {
  console.log('\n--- 输入预览（前 20 行）---')
  console.log(PROMPT(chats).split('\n').slice(0, 20).join('\n'))
  process.exit(0)
}

const prompt = PROMPT(chats)
console.log(`\n调用 ${MODEL} 摘要中…`)
const t0 = Date.now()
let summary
try {
  summary = await callOllama(prompt, MODEL)
} catch (error) {
  console.error(`摘要失败：${error.message}`)
  console.error('（ollama 没起？或者模型名不对。检查：curl 127.0.0.1:11434/api/tags）')
  process.exit(1)
}
const seconds = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`完成，耗时 ${seconds}s，输出 ${Array.from(summary).length} 字`)

/**
 * 兜底：把"关系/称呼"行滤掉。
 * 7B 不一定听话（实测第一版就把"爸爸""妈妈"合并成一句"称呼爸爸为爸爸"），
 * 而这类信息每份 `u_*.json` 都带着 —— 总纲里重复它就是噪音，还可能让人叫错。
 */
const RELATION = /关系|称呼|叫.*爸|叫.*妈|亲疏/
const filtered = summary
  .split('\n')
  .filter((line) => !RELATION.test(line))
  .join('\n')
  .trim()
if (filtered !== summary.trim()) {
  console.log('（已滤掉关系/称呼相关行——那部分不归总纲）')
}
summary = filtered

const stamp = new Date().toISOString()
const doc = `# 软软的总纲记忆

> 由 \`scripts/self-memory.mjs\` 从 ${chats.length} 个对话的最近记录里提取（本地 ${MODEL}，${stamp}）。
> **这是她的"自我记忆"，不是人设** —— 内容全部来自她真实说过的话，会随对话变化。
> 不要手工往这里加"设定"，那部分归 \`AGENTS.md\`。

${summary.trim()}

---
源文件：${chats.map((c) => `${c.kind} ${c.id}(${c.lines.length}条)`).join('、')}
`

writeFileSync(OUT_FILE, doc, 'utf8')
console.log(`已写入 ${OUT_FILE}`)
