/**
 * 发行版本戳（2026-11-07）—— 回答「我装的是哪一版」。
 *
 * 为什么不能读 package.json：它的 `version` 恒为 `0.1.0`，beta-4 / rc1 / rc2 全靠
 * git tag 区分；而发行包是 `git archive` 出来的，用户机上**没有 `.git`**，
 * `git describe` 也不可用。唯一能在干净机上稳定读到的版本，是打包时写进 zip 的
 * `RELEASE-MANIFEST.txt`。
 *
 * 三条硬要求：
 *   ① **读不到就说读不到**：缺文件/坏行返回 `source: 'none'`，绝不拿 package.json
 *      的 `0.1.0` 冒充发行版本 —— 那会让用户以为自己在最新版上。
 *   ② 只认 `release-` 前缀的 `key=value` 行。正文里出现「版本」两个字不算证据，
 *      否则清单里随便一句说明都会被解析成 tag。
 *   ③ 纯函数：不 spawn 子进程、不联网。面板每次轮询都会调它，不能有副作用，
 *      也不能因为读文件失败就把整个 `/api/status` 打挂。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const MANIFEST_FILE = 'RELEASE-MANIFEST.txt'

/**
 * 清单里认的键 → 返回对象里的字段。
 *
 * 键名带 `release-` 前缀是刻意的：清单正文有大量给人看的中文说明，
 * 前缀把「机器读的行」和「人读的段」分开，以后加字段也不会和正文撞车。
 */
export const STAMP_FIELDS = Object.freeze({
  'release-tag': 'tag',
  'release-commit': 'commit',
  'release-built-at': 'builtAt',
  'release-built-by': 'builtBy',
  'requires-rin-inject-sha256': 'rinInjectSha256',
})

/** 一个「什么都没读到」的戳。所有消费者都应当能直接吃这个对象。 */
export function emptyStamp() {
  return {
    present: false,
    tag: '',
    commit: '',
    builtAt: '',
    builtBy: '',
    rinInjectSha256: '',
    packageVersion: '',
    source: 'none',
    ignored: 0,
  }
}

/**
 * 解析清单正文。
 *
 * 容错边界（每条都有对应的单测）：
 *   · CRLF / LF 都行；行首行尾空白忽略；UTF-8 BOM 先剥掉（记事本另存会加）；
 *   · `#` 开头当注释；
 *   · 同一个键出现多次 → **先到先得**（后出现的多半是正文里的举例）；
 *   · 值里带 `=` → 保留整段（只按第一个 `=` 切）；
 *   · 未知的 `release-xxx` → 计数进 `ignored`，不抛错（老版本读新清单不炸）。
 */
export function parseManifest(text) {
  const stamp = emptyStamp()
  const seen = new Set()

  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, '').trim()
    if (line === '' || line.startsWith('#')) continue

    const eq = line.indexOf('=')
    if (eq <= 0) continue

    const key = line.slice(0, eq).trim().toLowerCase()
    const field = STAMP_FIELDS[key]
    if (!field) {
      // 只统计「看起来像机器行」的未知键，避免把中文正文也算成 ignored
      if (key.startsWith('release-') || key.startsWith('requires-')) stamp.ignored += 1
      continue
    }
    if (seen.has(field)) continue

    const value = line.slice(eq + 1).trim()
    if (value === '') continue

    stamp[field] = value
    seen.add(field)
  }

  // 只有 tag / commit 才算「有发行戳」：单独一个打包时间不能定位版本。
  stamp.present = seen.has('tag') || seen.has('commit')
  stamp.source = stamp.present ? 'manifest' : 'none'
  return stamp
}

function readPackageVersion(repo) {
  if (!repo) return ''
  try {
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
    return typeof pkg?.version === 'string' ? pkg.version : ''
  } catch {
    return ''
  }
}

/**
 * 从磁盘读戳。
 *
 * `repo` 用来找 `RELEASE-MANIFEST.txt` 和 `package.json`；`manifestPath` 可覆盖前者
 * （控制台从 `control/lib/` 往上找两级，测试里直接指到临时目录）。
 * 任何一步失败都返回 `emptyStamp()`，**不抛** —— 版本戳读不到是信息缺失，
 * 不是可以让面板整页报错的故障。
 */
export function readVersionStamp({ repo = '', manifestPath = '' } = {}) {
  const path = manifestPath || (repo ? join(repo, MANIFEST_FILE) : '')
  const base = emptyStamp()
  base.packageVersion = readPackageVersion(repo)
  if (!path) return base

  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return base
  }

  // 刻意**不**把 `path` 带出去：这个对象会原样进 `/api/status`，绝对路径里有用户名。
  // 排障需要路径时，看这里——`<仓库>/RELEASE-MANIFEST.txt` 是唯一可能的位置。
  return { ...parseManifest(text), packageVersion: base.packageVersion }
}

/**
 * 一行人类可读的描述。
 *
 * 没戳时**不许**只说一个版本号：`0.1.0` 会让人误以为是最新版，所以必须带上
 * 「（package.json，无发行戳）」这句限定。
 */
export function describeStamp(stamp) {
  const s = stamp ?? emptyStamp()
  if (s.present) {
    const head = s.tag || s.commit || '(空 tag)'
    return s.commit && s.tag ? `${head} · ${s.commit}` : head
  }
  if (s.packageVersion) return `${s.packageVersion}（package.json，无发行戳）`
  return '没有发行戳（开发副本或旧包）'
}
