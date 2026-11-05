/**
 * 配置目标（宿主无关的接缝）—— 2026-11-05。
 *
 * ⚠️ 设计前提（主人明确纠正过）：**这个桥不一定是 DSH 的插件**。
 *    DSH 只是"当下好用的宿主"，将来可能换自研宿主。
 *    所以向导只负责**收集配置**，往哪儿写由本模块决定 ——
 *    不要在向导 UI 或 API 里写死 `cordis.patch.yml`。
 *
 * 目前的两种落点：
 *   · dsh-patch  ：DSH profile 的 `cordis.patch.yml`（现在能直接生效）
 *   · bare-json  ：`<dataDir>/qq-config.json`（宿主无关的纯配置，留给将来的自研宿主）
 *
 * 加新宿主：在 DETECTORS 里加一条，返回 { kind, path, label }，其余不用动。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { readPatchValue, upsertPatchValue, normalizeNumberList } from '../../lib/panel.js'

/**
 * 向导字段 = **直接取 `lib/panel.js` 的 whitelist 组**，不另抄一份。
 *
 * 为什么（2026-11-05 被抓）：我先自己写了一份 SETUP_FIELDS，后来才发现
 * `lib/settings-routes.js` 的 `/qqai/panel` 早就有这一组，**而且踩坑说明写得比我的详细**
 * （"空列表 = 全部拒绝"、"管理员名单的人也必须出现在允许的用户里"…）。
 * 两份定义迟早会分叉 —— 面板里改了措辞，向导还是旧的，用户看到两套说法。
 *
 * 现在只保留「向导要哪几个键」这一个事实，标签/说明一律来自 PANEL_GROUPS。
 */
import { PANEL_GROUPS } from '../../lib/panel.js'

const WHITELIST_GROUP = PANEL_GROUPS.find((group) => group.id === 'whitelist')
const ROW_BY_KEY = new Map(
  (WHITELIST_GROUP?.rows ?? []).flatMap((entry) => {
    const key = entry.key
    return key ? [[key, entry]] : []
  }),
)

/** 向导只问四个键，顺序固定；标签与说明从面板定义里取。 */
export const SETUP_KEYS = ['botQq', 'allowUsers', 'allowGroups', 'cwd']

export const SETUP_FIELDS = SETUP_KEYS.map((key) => {
  const row = ROW_BY_KEY.get(key)
  return {
    key,
    label: row?.label ?? key,
    hint: row?.hint ?? row?.note ?? '',
    type: key === 'botQq' ? 'number' : key === 'cwd' ? 'path' : 'numberList',
    required: key === 'botQq' || key === 'allowUsers',
  }
})

// ---------------------------------------------------------------- 探测

/**
 * 逐个探测可写的落点，返回第一个可用的。
 * @returns {{kind:string,path:string,label:string,available:boolean,reason?:string}}
 */
export function detectTarget({ profileDir, profile = 'web', dataDir } = {}) {
  const candidates = []

  // ① DSH profile 的 patch 文件
  if (profileDir) {
    const patchPath = join(profileDir, 'cordis.patch.yml')
    candidates.push({
      kind: 'dsh-patch',
      path: patchPath,
      label: 'DSH profile（cordis.patch.yml）',
      available: existsSync(patchPath),
      reason: existsSync(patchPath) ? '' : '该 profile 下没有 cordis.patch.yml（DSH 还没建过这个 profile？）',
    })
  }

  // ② 宿主无关的纯 JSON
  const base = dataDir || process.cwd()
  candidates.push({
    kind: 'bare-json',
    path: join(base, 'qq-config.json'),
    label: '独立 JSON（宿主无关）',
    available: true,
  })

  return candidates.find((c) => c.available) ?? candidates[candidates.length - 1]
}

/**
 * 白名单输入归一化：接受数组，也接受「100000001, 100000002」这种手填。
 * `normalizeNumberList` 返回的是 `{ok, list, reason}`，**不是数组** —— 别按数组用（踩过）。
 */
function parseList(input) {
  if (Array.isArray(input)) return normalizeNumberList(input)
  const parts = String(input ?? '')
    .split(/[,，\s]+/)
    .filter(Boolean)
    .map((piece) => Number(piece))
  return normalizeNumberList(parts)
}

// ---------------------------------------------------------------- 读

/** 读当前值（读不到就是空，不抛）。 */
export function readSetup(target) {
  const empty = { botQq: '', allowUsers: [], allowGroups: [], cwd: '' }
  try {
    if (target.kind === 'dsh-patch') {
      const text = readFileSync(target.path, 'utf8')
      const num = (key) => {
        const raw = readPatchValue(text, key)
        const n = Number(raw)
        return Number.isInteger(n) && n > 0 ? String(n) : ''
      }
      const list = (key) => parseList(readPatchValue(text, key)).list
      return { botQq: num('botQq'), allowUsers: list('allowUsers'), allowGroups: list('allowGroups'), cwd: readPatchValue(text, 'cwd') ?? '' }
    }
    if (target.kind === 'bare-json') {
      if (!existsSync(target.path)) return empty
      const json = JSON.parse(readFileSync(target.path, 'utf8'))
      return {
        botQq: json.botQq ? String(json.botQq) : '',
        allowUsers: parseList(json.allowUsers).list,
        allowGroups: parseList(json.allowGroups).list,
        cwd: json.cwd ?? '',
      }
    }
  } catch (error) {
    // ★ 不再静默：以前这里直接 return empty，结果"读挂了"和"还没配过"长得一模一样
    //   （2026-11-05 踩过：parseList 定义被我删了 → ReferenceError 被吞 → 面板显示空值，
    //    我以为是配置没写进去，白查了半小时）。配置坏了不该白屏，但必须留下证据。
    return { ...empty, error: `读取配置失败: ${error.message}` }
  }
  return empty
}

// ---------------------------------------------------------------- 校验

/** 校验并归一化向导提交的值；返回 { ok, values, errors }。 */
export function validateSetup(input = {}) {
  const errors = []
  const botQq = Number(input.botQq)
  if (!Number.isInteger(botQq) || botQq <= 0) errors.push('机器人 QQ 号必须是正整数')

  const usersParsed = parseList(input.allowUsers)
  if (!usersParsed.ok) errors.push(`白名单：${usersParsed.reason}`)
  else if (usersParsed.list.length === 0) errors.push('白名单不能为空 —— 空列表意味着所有私聊都会被拒绝')

  const groupsParsed = parseList(input.allowGroups)
  if (!groupsParsed.ok) errors.push(`群白名单：${groupsParsed.reason}`)
  const cwd = String(input.cwd ?? '').trim()
  if (cwd && !isAbsolute(cwd)) errors.push('数据目录要写绝对路径（例如 C:\\qq-data）')

  return {
    ok: errors.length === 0,
    errors,
    values: { botQq, allowUsers: usersParsed.list, allowGroups: groupsParsed.list, cwd },
  }
}

// ---------------------------------------------------------------- 写

/**
 * 写入配置。**每个 kind 一个分支**，改宿主只加分支、不改调用方。
 * @returns {{ok:boolean, reason:string, kind:string, path:string}}
 */
export function writeSetup(target, values) {
  try {
    if (target.kind === 'dsh-patch') {
      /**
       * 先比较**值**再决定写不写。
       * 只比文本不够：`allowGroups: [ 1, 2 ]` 和 `[1,2]` 值一样、文本不同，
       * 每次点保存都会改文件 ⇒ 宿主热重载 ⇒ 桥白重连一次。
       */
      const current = readSetup(target)
      const same =
        Number(current.botQq) === values.botQq &&
        current.allowUsers.join(',') === values.allowUsers.join(',') &&
        current.allowGroups.join(',') === values.allowGroups.join(',') &&
        String(current.cwd ?? '') === String(values.cwd ?? '')
      if (same) {
        return { ok: true, reason: '配置没有变化，未写入', kind: target.kind, path: target.path }
      }
      const before = readFileSync(target.path, 'utf8')
      /**
       * ★ `upsertPatchValue` 返回的是 `{ ok, yaml, changed, reason }`，**不是字符串**。
       *   （2026-11-05 踩过：直接把它当 text 传 writeFileSync ⇒
       *    'The "data" argument must be of type string'。）
       */
      let text = before
      const steps = [
        // ★ 必须传 number：upsertPatchValue 只有 typeof === 'number' 才裸写，
        //   传字符串会走 renderScalar 加引号 ⇒ 写成 '375...' ⇒ readPatchValue 遇到引号返回 null（踩过）
        ['botQq', values.botQq],
        ['allowUsers', values.allowUsers],
        ['allowGroups', values.allowGroups],
      ]
      if (values.cwd) steps.push(['cwd', values.cwd])
      for (const [key, value] of steps) {
        const step = upsertPatchValue(text, key, value)
        if (!step || step.ok === false) {
          return { ok: false, reason: `写入 ${key} 失败: ${step?.reason ?? '未知原因'}`, kind: target.kind, path: target.path }
        }
        text = step.yaml
      }
      if (text === before) {
        return { ok: true, reason: '内容没有变化，未写入', kind: target.kind, path: target.path }
      }
      writeFileSync(`${target.path}.bak-setup`, before, 'utf8')
      writeFileSync(target.path, text, 'utf8')
      return { ok: true, reason: '已写入 DSH profile（宿主会热重载，桥会短暂重连）', kind: target.kind, path: target.path }
    }

    if (target.kind === 'bare-json') {
      mkdirSync(dirname(target.path), { recursive: true })
      const payload = {
        _comment: '宿主无关的桥配置。由控制台向导写入；将来的自研宿主可直接读这个文件。',
        botQq: values.botQq,
        allowUsers: values.allowUsers,
        allowGroups: values.allowGroups,
        cwd: values.cwd || '',
      }
      writeFileSync(target.path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      return {
        ok: true,
        reason: '已写入独立 JSON。注意：当前 DSH 宿主还不会读它 —— 需要在 DSH 的 cordis.patch.yml 里引用，或等自研宿主的读取器',
        kind: target.kind,
        path: target.path,
      }
    }

    return { ok: false, reason: `未知的配置落点: ${target.kind}`, kind: target.kind, path: target.path }
  } catch (error) {
    return { ok: false, reason: `写入失败: ${error.message}`, kind: target.kind, path: target.path }
  }
}
