/** 模块依赖审计：谁引用了谁，哪些模块没人引用。 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'

const dirs = ['lib', 'control', 'client', 'test', 'tools']
const files = []
function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p) }
    else if (/\.(js|mjs|html)$/.test(e.name)) files.push(p)
  }
}
for (const d of dirs) if (existsSync(d)) walk(d)

const texts = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]))
const libs = readdirSync('lib').filter((f) => f.endsWith('.js'))

const rows = []
for (const f of libs) {
  const name = basename(f, '.js')
  const re = new RegExp(`['"/]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.js['"]`)
  const users = []
  for (const [file, txt] of texts) {
    if (basename(file) === f) continue
    if (re.test(txt)) users.push(file)
  }
  const prod = users.filter((x) => !x.startsWith('test') && !x.startsWith('tools'))
  rows.push({ f, size: statSync(join('lib', f)).size, users, prod })
}

const orphan = rows.filter((r) => r.users.length === 0)
const testOnly = rows.filter((r) => r.users.length > 0 && r.prod.length === 0)

console.log(`=== 完全没人引用 (${orphan.length}) ===`)
for (const r of orphan) console.log(`  ${r.f}  ${r.size}B`)
console.log(`\n=== 只有测试/工具在用，产品代码不引用 (${testOnly.length}) ===`)
for (const r of testOnly) console.log(`  ${r.f}  <- ${r.users.join(', ')}`)
console.log(`\n=== 单引用者（可能是耦合点） ===`)
for (const r of rows.filter((x) => x.prod.length === 1)) {
  console.log(`  ${r.f}  <- ${r.prod[0]}`)
}
