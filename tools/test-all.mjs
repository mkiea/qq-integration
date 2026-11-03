#!/usr/bin/env node
/**
 * 跑全部测试套件（2026-11-02）。
 *
 * 为什么要有这个：`test/` 下 115 个套件没有统一入口，直接 `for f in test/*.mjs` 会遇到
 * `live-*` / `sim-*` / `replay-live*` —— 它们**要一个活着的宿主**（真 QQ + Waylay + WS）。
 * 没有宿主时它们不是"失败"，是**一直等到超时**。2026-11-02 我就是这么被卡了 10 分钟
 * 才被系统杀掉，且那一刻看不到任何进度。
 *
 * 三条设计取舍：
 *   ① **跳过的要念出来**（不是静默少跑几个）—— `silence !== empty`。
 *   ② 归类只按**文件名前缀**，不猜内容；猜错就会把该跑的跑丢了。
 *   ③ 每个套件独立计时 + 独立超时，超时按"卡死"报（❌ HANG），不混进 FAIL 里装成断言失败。
 *
 * 用法：
 *   node tools/test-all.mjs            只跑不需要宿主的
 *   node tools/test-all.mjs --live     全都跑（要宿主；没有就报 HANG）
 *   node tools/test-all.mjs --filter qa  只跑文件名含 qa 的
 */
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const testDir = join(repo, 'test')

const argv = process.argv.slice(2)
const withLive = argv.includes('--live')
const filterArg = (() => {
  const i = argv.indexOf('--filter')
  return i >= 0 ? String(argv[i + 1] ?? '') : ''
})()
const timeoutArg = (() => {
  const i = argv.indexOf('--timeout')
  return i >= 0 ? Number(argv[i + 1]) : 0
})()

/**
 * 需要活宿主的套件。
 *
 * ⚠️ 别用 `replay-live` 当前缀：`replay-live.mjs` 是**离线回放**（喂固定素材、不需要宿主），
 * 只有 `replay-live-host.mjs` 才要连真的。前缀规则一宽就会把该跑的悄悄跑丢 ——
 * 而"悄悄跑丢"和"通过了"在终端上长得一模一样。
 */
const LIVE_PREFIXES = ['live-', 'sim-']
const LIVE_EXACT = ['replay-live-host.mjs']

const isLive = (name) => LIVE_EXACT.includes(name) || LIVE_PREFIXES.some((p) => name.startsWith(p))

function runOne(file, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, [file], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    let killed = false
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL') }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, killed, ms: Date.now() - started })
    })
  })
}

/** 从套件输出里抓 `N passed, M failed`，抓不到就是 null（不许假装 0）。 */
function tally(out) {
  const m = [...out.matchAll(/(\d+) passed, (\d+) failed/g)].pop()
  return m ? { passed: Number(m[1]), failed: Number(m[2]) } : null
}

const all = readdirSync(testDir).filter((f) => f.endsWith('.mjs')).sort()
const targets = all.filter((f) => (filterArg === '' ? true : f.includes(filterArg)))
const skipped = withLive ? [] : targets.filter(isLive)
const toRun = targets.filter((f) => !skipped.includes(f))

// 超时默认值：最慢的离线套件约 25s（ops-bridge），给 4 倍余量。
const timeoutMs = timeoutArg > 0 ? timeoutArg * 1000 : 120_000

/**
 * 单套件超时覆盖（2026-11-03）：`stress-unit` 默认就要跑 90 秒左右（突发 5000 条 + 顺序 300 条），
 * 全量并发时会被 120s 的通用上限杀掉，**表现成"卡死"，看起来像代码坏了**。
 * 它不是卡死，是本来就慢 —— 所以给它单独放宽，而不是把通用上限抬到所有人都等。
 */
const TIMEOUT_OVERRIDE = {
  'stress-unit.mjs': 300_000,
  'soak-unit.mjs': 180_000,
  // 2026-11-03：单跑 4.4s，但全量时机器一忙就被 120s 通用上限判成"卡死"（实测发生过一次）。
  // 它本身没有任何等待逻辑，慢只可能是被别的套件/宿主进程挤到——给够余量，别制造假故障。
  'inbound-at-trace-unit.mjs': 180_000,
}

console.log(`共 ${all.length} 个套件；本次跑 ${toRun.length} 个，跳过 ${skipped.length} 个（要活宿主）`)
if (skipped.length > 0) console.log(`跳过：${skipped.join(' ')}`)
console.log('')

const fails = []
const hangs = []
let suites = 0
let assertions = 0

for (const name of toRun) {
  const r = await runOne(join(testDir, name), TIMEOUT_OVERRIDE[name] ?? timeoutMs)
  const t = tally(r.out)
  suites++
  if (t) assertions += t.passed + t.failed
  if (r.killed) {
    hangs.push(name)
    console.log(`❌ HANG  ${String(r.ms / 1000).padStart(5)}s  ${name}   （超时被杀，通常是要活宿主）`)
    continue
  }
  if (r.code === 0) {
    console.log(`PASS  ${String(r.ms / 1000).padStart(5)}s  ${name}${t ? `  ${t.passed} passed` : ''}`)
  } else {
    fails.push({ name, out: r.out })
    const detail = t ? `${t.passed} passed, ${t.failed} failed` : `exit ${r.code}`
    console.log(`FAIL  ${String(r.ms / 1000).padStart(5)}s  ${name}  ${detail}`)
  }
}

console.log('')
if (fails.length > 0) {
  console.log(`===== 失败 ${fails.length} 个 —— 每条的具体 FAIL 行如下 =====`)
  for (const f of fails) {
    console.log(`\n--- ${f.name} ---`)
    const lines = f.out.split(/\r?\n/).filter((l) => l.startsWith('FAIL'))
    console.log(lines.length > 0 ? lines.join('\n') : f.out.split(/\r?\n/).slice(-15).join('\n'))
  }
}

console.log('')
console.log(`套件：${suites - fails.length - hangs.length} 绿 / ${fails.length} 红 / ${hangs.length} 卡死；断言累计 ${assertions}`)
if (skipped.length > 0) console.log(`未跑（要活宿主，加 --live 才跑）：${skipped.join(' ')}`)
if (hangs.length > 0) console.log(`卡死（没等到结论，不算通过）：${hangs.join(' ')}`)

process.exitCode = fails.length + hangs.length > 0 ? 1 : 0
