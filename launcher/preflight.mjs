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
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { probeEnvironment } from '../lib/env-preflight.js'
import { describeStamp, readVersionStamp } from '../lib/version-stamp.js'
import { loadControlConfig } from '../control/lib/config.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TAG = { ok: '[OK]  ', warn: '[!]   ', fail: '[X]   ', skip: '[-]   ' }

/**
 * `dshBin` 由控制台自己的探测算（`detectPaths`），这里只负责把它塞进体检清单。
 * 2026-11-07 VM 实测漏过一次：Waylay 认到了、dshBin 却是空，控制台「启动宿主」直接失败。
 */
let dshBin = null
try {
  // 走 loadControlConfig：先读 qq-control.json（用户的显式配置），没有再自动探测。
  // 只用 detectPaths 会漏掉「装在非常规位置、已经手填过 dshBin」的那批机器。
  dshBin = String(loadControlConfig(join(REPO, 'qq-control.json')).config.dshBin ?? '')
} catch { dshBin = '' }

const { results, blockers, ok } = probeEnvironment({ repo: REPO, cwd: REPO, dshBinPath: dshBin })

console.log('')
console.log('QQ 集成接入 · 启动前检查（只读，不装不改）')
// 版本戳放在第一行：用户开窗口第一眼就该知道自己在跑哪一版。
// 读不到时 describeStamp 会写「无发行戳」，不会拿 package.json 的 0.1.0 冒充。
console.log(`版本：${describeStamp(readVersionStamp({ repo: REPO }))}`)
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
