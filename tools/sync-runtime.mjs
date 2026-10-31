#!/usr/bin/env node
/**
 * 把**仓库内容**同步到**运行时副本**（dsh 真正加载的那份）。
 *
 * ## 为什么需要这个脚本
 *
 * 这个插件在实际机器上有两份活副本：
 *   · 仓库 `Desktop/chat role/qq-integration` —— 只有 git，**没有 `node_modules`**，
 *     所以在仓库里跑 `node test/*.mjs` 会 `ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-llm`；
 *   · 运行时 `~/.dsh/profiles/web/node_modules/dsh-qq-onebot-bridge` —— 能跑测试的那份。
 *
 * 于是"写在哪、测在哪"被劈成两半，靠手工拷贝维持。2026-10-31 实测它漂了：
 * 仓库落后运行时 **11 分钟、9 个文件**（`dataDir` / `funEnabled` 的改动全只在运行时那份里，
 * 仓库一个字节都没有）。这种漂移**不报错**，只会在某次重装后集体消失。
 *
 * 所以把方向固定下来：**仓库是源，运行时是产物**。
 *
 * ## 用法
 *
 *   node tools/sync-runtime.mjs            # 仓库 → 运行时（拷贝有差异的文件）
 *   node tools/sync-runtime.mjs --check    # 只比对，不写；有差异则退出码 1
 *
 * ## 两条硬规矩
 *
 * 1. **只拷不删**。运行时目录里有机器本地的东西（`qq-control.json`、`_tmp/`、`node_modules/`），
 *    删掉任何一个都会让现场坏掉，而这些都不在仓库里。
 * 2. **比对时忽略 CRLF**。仓库是 LF、运行时是 CRLF（git 的 `core.autocrlf` 造成的），
 *    按字节比会把每个文件都报成"有差异"，那等于这个检查永远在喊狼来了。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 运行时副本的位置：允许用环境变量覆盖（换机器/换 profile 时不必改代码）。 */
export function runtimeRoot({ home = process.env.USERPROFILE || process.env.HOME || '' } = {}) {
  const override = String(process.env.QQAI_RUNTIME_ROOT ?? '').trim()
  if (override !== '') return resolve(override)
  return join(home, '.dsh', 'profiles', 'web', 'node_modules', 'dsh-qq-onebot-bridge')
}

/** 不同步的东西：依赖、临时文件、机器本地配置、git 元数据。 */
const SKIP_DIRS = new Set(['node_modules', '_tmp', '.git', '_snapshots', 'qq-images', 'qq-memory', 'qq-tts', 'qq-files'])

/** 只同步这些顶层目录/文件（其余一概不碰，避免把数据和日志一起搬过去）。 */
const SYNC_ROOTS = ['lib', 'client', 'control', 'test', 'docs', 'package.json', 'cordis.patch.yml', 'README.md', 'README.en.md', 'CHANGELOG.md', 'NOTICE.md', 'LICENSE']

/** 递归列出相对路径（只走 SYNC_ROOTS，跳过 SKIP_DIRS）。 */
export function collectFiles(root, { syncRoots = SYNC_ROOTS, skipDirs = SKIP_DIRS } = {}) {
  const out = []
  const walk = (absDir, relDir) => {
    let entries = []
    try { entries = readdirSync(absDir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue
        // 顶层的非白名单目录直接跳过（例如 qq_chat 里那种数据目录）
        if (relDir === '' && !syncRoots.includes(entry.name)) continue
        walk(join(absDir, entry.name), rel)
      } else if (entry.isFile()) {
        out.push(rel)
      }
    }
  }
  walk(root, '')
  return out
}

/** 归一化换行，去掉 BOM —— 只用于**比较**，绝不用于写盘。 */
export function normalizeForCompare(text) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
}

/** 判断一个相对路径在两边的**内容**是否一致（忽略 CRLF/BOM）。 */
export function sameContent(aFile, bFile) {
  if (!existsSync(bFile)) return false
  try {
    return normalizeForCompare(readFileSync(aFile, 'utf8')) === normalizeForCompare(readFileSync(bFile, 'utf8'))
  } catch {
    // 二进制/读不了就退回按大小比（至少不会因为一条读失败把整轮同步判成"全都要拷"）
    try { return statSync(aFile).size === statSync(bFile).size } catch { return false }
  }
}

/** 主流程：返回 { copied, identical, missing }（不打印，打印交给 CLI 层）。 */
export function syncRuntime({ from = repo, to = runtimeRoot(), dryRun = false } = {}) {
  const result = { copied: [], identical: [], missing: [], to }
  if (!existsSync(to)) {
    result.missing.push(to)
    return result
  }
  for (const rel of collectFiles(from)) {
    const source = join(from, rel)
    const target = join(to, rel)
    if (sameContent(source, target)) { result.identical.push(rel); continue }
    if (!dryRun) {
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(source, target)
    }
    result.copied.push(rel)
  }
  return result
}

// ------------------------------------------------------------------ CLI ---

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check')
  const to = runtimeRoot()
  if (!existsSync(to)) {
    console.error(`找不到运行时副本：${to}`)
    console.error('装到别处时用环境变量指定：QQAI_RUNTIME_ROOT=<路径> node tools/sync-runtime.mjs')
    process.exit(2)
  }
  const result = syncRuntime({ to, dryRun: check })
  if (result.copied.length === 0) {
    console.log(`已是最新：${result.identical.length} 个文件内容一致（${relative(process.cwd(), to) || to}）`)
    process.exit(0)
  }
  const verb = check ? '需要同步' : '已同步'
  console.log(`${verb} ${result.copied.length} 个文件 → ${to}`)
  for (const rel of result.copied.slice(0, 40)) console.log(`  ${check ? '≠' : '→'} ${rel}`)
  if (result.copied.length > 40) console.log(`  …还有 ${result.copied.length - 40} 个`)
  // --check 用退出码表达"不一致"，CI/脚本可以直接串起来
  process.exit(check ? 1 : 0)
}
