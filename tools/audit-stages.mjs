/** 功能分支审计：代码里声明了哪些 stage，真机 trace 里实际跑过哪些。 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'

const declared = new Map()   // stage -> [文件:行]
for (const f of readdirSync('lib').filter((x) => x.endsWith('.js'))) {
  const lines = readFileSync(`lib/${f}`, 'utf8').split('\n')
  lines.forEach((line, i) => {
    // mark('x') / mark("x") / trace.step('x') / .step('x'
    for (const m of line.matchAll(/(?:mark|step)\(\s*'([a-z][a-z0-9-]*)'/g)) {
      if (!declared.has(m[1])) declared.set(m[1], [])
      declared.get(m[1]).push(`${f}:${i + 1}`)
    }
  })
}

const TRACE = 'C:/Users/someone/Desktop/chat role/qq_chat/qq-trace.jsonl'
const seen = new Map()
if (existsSync(TRACE)) {
  for (const line of readFileSync(TRACE, 'utf8').trim().split('\n')) {
    let j
    try { j = JSON.parse(line) } catch { continue }
    seen.set(j.stage, (seen.get(j.stage) ?? 0) + 1)
  }
}

const all = [...new Set([...declared.keys(), ...seen.keys()])].sort()
const never = all.filter((s) => !seen.has(s))
const onlyOnce = all.filter((s) => seen.get(s) === 1)

console.log(`代码里声明的 stage：${declared.size} 个`)
console.log(`真机 trace 出现过的 stage：${seen.size} 个`)
console.log(`\n=== 声明了但真机从未出现（${never.length}）===`)
for (const s of never) console.log(`  ${s.padEnd(22)} ${declared.get(s)?.slice(0, 2).join(', ') ?? '(只在数据里)'}`)
console.log(`\n=== 只跑过 1 次（${onlyOnce.length}）===`)
for (const s of onlyOnce) console.log(`  ${s}`)
console.log('\n=== 真机里出现过、按次数排 ===')
for (const [s, n] of [...seen].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)}  ${s}`)
}
