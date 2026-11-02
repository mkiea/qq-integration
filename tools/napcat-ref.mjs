#!/usr/bin/env node
/**
 * 把 NapCat 里某个 action 的**实现片段**打出来（2026-11-02）。
 *
 * 用途：Waylay 有一批 handler 是空壳（`return { messages: [] }` 这种），而 NapCat 在同一个
 * QQ 版本上是能用的。要"移植"，第一步是看清它**调了哪个内核方法、参数怎么排** ——
 * 这些是事实（方法名 + 实参形状），不是文学创作；实现仍然自己写，不抄代码。
 *
 * 用法：
 *   node tools/napcat-ref.mjs                       # 列出所有 action 名
 *   node tools/napcat-ref.mjs GetForwardMsg         # 打这个 action 的实现
 *   node tools/napcat-ref.mjs get_group_file_url    # OneBot 名也认
 *   node tools/napcat-ref.mjs GetForwardMsg --raw   # 连同 class 声明一起打（默认只打 _handle）
 *
 * NapCat 位置：环境变量 NAPCAT_BUNDLE，或默认 Desktop/NapCat/shell/napcat.mjs。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const bundle = process.env.NAPCAT_BUNDLE || join(homedir(), 'Desktop', 'NapCat', 'shell', 'napcat.mjs')
if (!existsSync(bundle)) {
  console.error(`找不到 NapCat ${bundle}（可用 NAPCAT_BUNDLE 指过去）`)
  process.exit(2)
}
const source = readFileSync(bundle, 'utf8')
const want = process.argv[2] || ''
const raw = process.argv.includes('--raw')

/** action 名 → OneBot 字符串，来自 `Xxx: "get_msg"` 那张映射表。 */
const nameMap = new Map()
for (const m of source.matchAll(/(\w+):\s*"(get_[a-z_]+|send_[a-z_]+|set_[a-z_]+|delete_[a-z_]+|can_[a-z_]+|upload_[a-z_]+|download_[a-z_]+|_?[a-z_]+)"\s*,/g)) {
  nameMap.set(m[1], m[2])
}
const oneBotToKey = new Map([...nameMap].map(([key, ob]) => [ob, key]))
/** 只保留"看着像 OneBot action"的那批（映射表旁边还有一堆无关对象字面量，别一起列出来）。 */
const ACTION_NAMES = [...nameMap].filter(([, ob]) => /^(get|send|set|delete|can|upload|download|_)[a-z_]{2,}$/.test(ob))

if (want === '') {
  console.log(`bundle: ${bundle}`)
  console.log(`映射到 OneBot 名的 action 共 ${ACTION_NAMES.length} 个，例如：`)
  for (const [key, ob] of ACTION_NAMES.slice(0, 40)) console.log(`  ${ob.padEnd(28)} ← ${key}`)
  console.log('\n想看实现：node tools/napcat-ref.mjs <action 名>')
  process.exit(0)
}

const key = oneBotToKey.get(want) || want
// 每个 action 是一个 class：`class Xxx extends ue { actionName = re.<key>; ... }`
const marker = `actionName = re.${key}`
const at = source.indexOf(marker)
if (at < 0) {
  console.error(`没找到 action：${want}（对应 key ${key}）`)
  const near = [...nameMap].filter(([k]) => k.toLowerCase().includes(want.toLowerCase())).slice(0, 10)
  if (near.length) {
    console.error('相近的：')
    for (const [k, ob] of near) console.error(`  ${ob} ← ${k}`)
  }
  process.exit(1)
}
const start = source.lastIndexOf('class ', at)
const end = source.indexOf('\nclass ', at)
const block = source.slice(raw ? start : at, end < 0 ? source.length : end)
console.log(`// ${want} → ${key}（${Math.round(block.length / 1024)} KB）\n`)
console.log(block)
