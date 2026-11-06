#!/usr/bin/env node
/**
 * 「一键启动」的前置体检 CLI。
 *
 * 只做一件事：把 `lib/env-preflight.js` 的结论原样打给人看，并决定要不要继续启动。
 * 判据、措辞、修法全部在那个模块里，`tools/doctor.mjs` 用的是同一份 ——
 * 这样「双击启动器」和「控制台一键体检」不会给出两个互相打脸的结论。
 *
 * 退出码：0 = 没有硬失败（可以有 WARN）；1 = 有硬失败（启动器应当停下）。
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { probeEnvironment } from '../lib/env-preflight.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TAG = { ok: '[OK]  ', warn: '[!]   ', fail: '[X]   ', skip: '[-]   ' }

const { results, blockers, ok } = probeEnvironment({ repo: REPO, cwd: REPO })

console.log('')
console.log('QQ 集成接入 · 启动前检查（只读，不装不改）')
console.log('────────────────────────────────────────────────────────')
for (const item of results) {
  console.log(`${TAG[item.status] ?? '[?]   '}${item.name}${item.detail ? `  ${item.detail}` : ''}`)
  if (item.fix && item.status !== 'ok') {
    for (const line of String(item.fix).split('\n')) console.log(`        ${line}`)
  }
}
console.log('────────────────────────────────────────────────────────')
if (blockers.length === 0) {
  console.log(`没有硬失败（${results.filter((r) => r.status === 'warn').length} 项提醒）。继续启动控制台并拉起全链路…`)
} else {
  console.log(`有 ${blockers.length} 项硬失败：${blockers.map((b) => b.name).join(' / ')}`)
  console.log('按上面给的命令修好后再双击「一键启动.bat」。控制台不会在一个跑不起来的环境里假装启动成功。')
}
console.log('')

process.exit(ok ? 0 : 1)
