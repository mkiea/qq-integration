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
import { chunkLines, filterFabricated } from '../lib/memory-digest.js'

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
/**
 * `--deep`：分批摘要（2026-11-06）。
 *
 * 单次输入塞满 history+archive 时 7B 会退化（实测编造/漏项），所以改成
 * **每 80 行摘一次 → 再把所有小块合并**。慢（约 3~6 分钟），但能把 archive
 * 那 400 条早期记忆也吃进来。默认关，验证过再考虑设成默认。
 */
const DEEP = process.argv.includes('--deep')
const CHUNK_SIZE = 80
const MODEL = process.argv.includes('--model')
  ? process.argv[process.argv.indexOf('--model') + 1]
  : 'qwen2.5:7b'

/** 每个对话取最近多少条（全取会超上下文，而且旧对话参考价值低） */
const PER_CHAT = 40
/**
 * 再从 `archive` 里取多少条「更早」的（2026-11-06 补）。
 *
 * ⚠️ 这是原来的真缺口：`renderChat` 只读 `history`（最近 60 条里的后 40），
 * 而 `archive` 那 400 条**一条都没进过总纲** —— 等于她只记得最近几天，
 * 更早的喜欢/经历被 `history` 窗口挤出去以后，就再也进不了总纲了。
 * 取尾部 20 条（离现在最近的早期记录），带「（更早）」标记，避免和 history 混淆。
 *
 * ⚠️ 2026-11-06 实测后**暂时归零**：设成 20（输入 300 条）时 7B 明显退化 ——
 * 第一次编出「看动画」（输入里没有），第二次只写 69 字、把真实事件写成「无」。
 * 想覆盖早期记忆，正确路子是**分批摘要**（每个对话单独摘 → 再合并成总纲），
 * 不是把单次输入加长。等分批版落地再打开。
 */
const PER_ARCHIVE = 0

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
  const arch = Array.isArray(json.archive) ? json.archive : []
  /**
   * 「更早」只取**她自己说的话**（2026-11-06 第二次修）。
   *
   * 第一次把 archive 的双方发言都喂进去，模型立刻把**对方**说的「在弄虚拟机呢」
   * 写成「她喜欢的东西：虚拟机」——张冠李戴。总纲要的是"她是什么样的人"，
   * 对方的话只对理解上下文有用，对"她本人"没有证据力，早期部分干脆不带。
   */
  // ⚠️ `slice(-0)` 等于 `slice(0)` —— 会把整个 archive 全吞进来（实测过：247 条）。
  // PER_ARCHIVE=0 时必须显式给空数组，不能用负索引。
  const early = PER_ARCHIVE > 0 ? arch.filter((m) => m.role === 'assistant').slice(-PER_ARCHIVE) : []
  // 「更早」在前、「最近」在后：让模型按时间顺序读，和它自己写摘要的习惯一致。
  const picked = [...early.map((m) => ({ ...m, early: true })), ...hist.slice(-PER_CHAT)]
  const lines = picked.map((m) => {
    const who = m.role === 'assistant' ? '她' : '对方'
    const text = String(m.text ?? '').replace(/\s+/g, ' ').slice(0, 120)
    return `${m.early === true ? '（更早）' : ''}${who}: ${text}`
  })
  // 校验用的语料：**只有她说的话**才算"关于她"的证据。
  const herText = [...early, ...hist.slice(-PER_CHAT)].filter((m) => m.role === 'assistant').map((m) => String(m.text ?? '')).join('\n')
  return { kind, id: basename(file, '.json'), lines, herText, earlyCount: early.length, updatedAt: json.updatedAt }
}

function callOllama(prompt, model) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      prompt,
      stream: false,
      // num_ctx 从 8192 提到 16384：现在每个对话多带 20 条「更早」，5 个对话约 +100 行
      options: { temperature: 0.1, num_predict: 400, num_ctx: 16384 },
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

**只写她（「她:」开头的那几行）说过的话。**
「对方:」说的话是别人在讲自己的事，**不算她的经历**——
上一版就是把对方说的"在弄虚拟机呢"写成了"她喜欢虚拟机"，这是错的。

记录里标了「（更早）」的是更早以前的事，和最近的混在一起按事实写就行，不用标注时间。

要求：
- 只写这些记录里**真实出现**的，不要推测、不要编造
- 总字数不超过 250 字

输出格式（**严格照抄这个形状，不要用子列表**）：
- 她喜欢的东西：条目1、条目2、条目3
- 重要事件：条目1、条目2、条目3

一类只能有一行；没有内容就写「- 她喜欢的东西：无」。
**不要**输出只有「- 无」的行，**不要**用「  - 」缩进子项，**不要**加编号。

${chats.map((c) => `【${c.kind} ${c.id}】\n${c.lines.join('\n')}`).join('\n\n')}
`

/** 读一个记忆文件的**全部**历史（archive 在前、history 在后），并附「她说过的话」语料。 */
function readAllTurns(file) {
  const json = JSON.parse(readFileSync(file, 'utf8'))
  const arch = Array.isArray(json.archive) ? json.archive : []
  const hist = Array.isArray(json.history) ? json.history : []
  const all = [...arch, ...hist]
  const lines = all.map((m) => {
    const who = m.role === 'assistant' ? '她' : '对方'
    return `${who}: ${String(m.text ?? '').replace(/\s+/g, ' ').slice(0, 120)}`
  })
  const herText = all.filter((m) => m.role === 'assistant').map((m) => String(m.text ?? '')).join('\n')
  return { lines, herText, turns: all.length }
}

const CHUNK_PROMPT = (kind, id, chunk, index, total) => `下面是「软软」和别人的一段聊天记录（${kind} ${id}，第 ${index}/${total} 段）。
只提取**她自己**说过的事实：
- 「她:」开头的是她说的，可以提取
- 「对方:」开头的是别人在讲自己的事，**不算她的经历**，不要写

每条一行，用「- 」开头，最多 5 条；没有就输出「- 无」。
不要编造，记录里没有的不要写。

${chunk.join('\n')}
`

const REDUCE_PROMPT = (bullets) => `下面是分批从聊天记录里提取的、关于「软软」的事实（可能有重复）。
请合并去重，输出最终总纲：

- 她喜欢的东西：条目1、条目2
- 重要事件：条目1、条目2

要求：
- **只合并已有事实，不要新增**
- 两类各一行，总字数不超过 250 字
- 没有内容的类别写「- 类别：无」

${bullets.join('\n')}
`

/**
 * 分批摘要（`--deep`）：每个对话按 80 行切块 → 每块单独摘 → 最后合并。
 * 每块都过一遍出处校验（对照**这个文件里她说的话**），不合格的条目不进池子。
 */
async function deepSummarize(files, chats, model) {
  const pool = []
  for (let i = 0; i < files.length; i++) {
    const chat = chats[i]
    const { lines, herText, turns } = readAllTurns(files[i])
    const chunks = chunkLines(lines, CHUNK_SIZE)
    console.log(`  ${chat.kind} ${chat.id}: ${turns} 条 → ${chunks.length} 块`)
    for (let k = 0; k < chunks.length; k++) {
      let out
      try {
        out = await callOllama(CHUNK_PROMPT(chat.kind, chat.id, chunks[k], k + 1, chunks.length), model)
      } catch (error) {
        console.log(`    第 ${k + 1} 块失败，跳过：${error.message}`)
        continue
      }
      const gate = filterFabricated(out, herText)
      if (gate.dropped.length > 0) console.log(`    第 ${k + 1} 块丢弃 ${gate.dropped.length} 条无出处`)
      const kept = gate.text.split('\n').filter((line) => line.startsWith('- ') && !/：\s*无\s*$/.test(line))
      pool.push(...kept)
    }
  }
  if (pool.length === 0) return '- 无'
  // `--dump-pool`：调试用，看每块到底提出了什么（不写文件时也能看）
  if (process.argv.includes('--dump-pool')) {
    console.log(`  池子里 ${pool.length} 条：`)
    for (const line of pool) console.log(`    ${line}`)
    process.exit(0)  // 只看池子，不覆盖 _self.md
  }
  console.log(`  合并 ${pool.length} 条事实…`)
  return await callOllama(REDUCE_PROMPT(pool), model)
}

const files = listMemoryFiles()
if (files.length === 0) {
  console.error(`没有找到记忆文件：${MEMORY_DIR}`)
  process.exit(1)
}

const chats = files.map(renderChat)
const totalLines = chats.reduce((n, c) => n + c.lines.length, 0)
console.log(`读取 ${chats.length} 个对话，共 ${totalLines} 条（最近 ${PER_CHAT} 条 + 更早 ${PER_ARCHIVE} 条）`)
for (const c of chats) console.log(`  ${c.kind} ${c.id}: ${c.lines.length} 条（其中更早 ${c.earlyCount} 条）`)

if (DRY) {
  console.log('\n--- 输入预览（前 20 行）---')
  console.log(PROMPT(chats).split('\n').slice(0, 20).join('\n'))
  process.exit(0)
}

const t0 = Date.now()
let summary
try {
  if (DEEP) {
    console.log(`\n分批摘要（每块 ${CHUNK_SIZE} 行，含 archive）…`)
    summary = await deepSummarize(files, chats, MODEL)
  } else {
    console.log(`\n调用 ${MODEL} 摘要中…`)
    summary = await callOllama(PROMPT(chats), MODEL)
  }
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

/**
 * 出处校验（2026-11-06）：prompt 里写"不要编造"不够，7B 照样编。
 * 语料只取**她说的话** —— 对方的话对"她本人"没有证据力。
 */
const corpus = chats.map((c) => c.herText).join('\n')
const checked = filterFabricated(summary, corpus)
if (checked.dropped.length > 0) {
  console.log(`出处校验：丢掉 ${checked.dropped.length} 条无出处条目：${checked.dropped.map((d) => `${d.item}(${d.ratio.toFixed(2)})`).join('、')}`)
} else {
  console.log('出处校验：全部条目都有出处')
}
summary = checked.text

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
