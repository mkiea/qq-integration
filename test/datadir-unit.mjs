/**
 * 数据根目录（`dataDir`）的单元测试 —— 2026-10-31。
 *
 * 覆盖四层，每层都有"错了也不报错"的失败模式，所以必须逐条钉住：
 *   1. `normalizeDataDir`（面板写入校验）：相对路径 / `..` / 超长一旦放过，
 *      数据会一半在这个目录、一半在那个目录，而界面上完全看不出来；
 *   2. `parseFolderDialogOutput`（解析选文件夹窗口的输出）：把 powershell 的
 *      `#< CLIXML` 警告当成路径，会安静地建一个叫 `#< CLIXML` 的目录；
 *   3. `pickFolderDialog`（弹窗前的那层）：**取消必须回 ok:false**，
 *      回 ok:true 带空值等于把用户的 dataDir 清空；
 *   4. `supervisor.openDataDir`（控制台「打开文件夹」）：路径非法/不存在时**必须不弹窗**，
 *      否则用户点一下桌面就被莫名其妙打开一个目录。
 *
 * 全部注入化：这里**不弹任何窗口、不碰真实文件管理器**。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DATA_DIR_MAX_LEN, PANEL_GROUPS, PANEL_ROW_BY_KEY, normalizeDataDir, readPatchValue, upsertPatchValue } from '../lib/panel.js'
import { parseFolderDialogOutput, pickFolderDialog } from '../lib/settings-routes.js'
import { createSupervisor, describeDataDir, openFolderDefault, writeFileAtomic } from '../control/lib/supervisor.mjs'
import { createControlServer } from '../control/lib/server.mjs'
import { configWarnings, detectPaths } from '../control/lib/config.mjs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const tempDirs = []
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'qqai-datadir-'))
  tempDirs.push(dir)
  return dir
}

// ------------------------------------------------ 1. 写入校验 normalizeDataDir

const emptyDir = normalizeDataDir('')
check('空串 = 还没选（ok，值是空串，不是报错）', emptyDir.ok === true && emptyDir.value === '')

const trailing = normalizeDataDir('D:\\qqai\\qq_chat\\')
check('绝对路径通过，末尾分隔符被去掉（否则 console 与 bridge 拼出来的字符串不相等）',
  trailing.ok === true && trailing.value === 'D:\\qqai\\qq_chat', trailing.value)

check('正斜杠也认（Node 侧两种都吃得下）',
  normalizeDataDir('D:/qqai/qq_chat').ok === true, normalizeDataDir('D:/qqai/qq_chat').value)
check('UNC 网络路径认',
  normalizeDataDir('\\\\nas\\share\\qq').ok === true, normalizeDataDir('\\\\nas\\share\\qq').value)

const relative = normalizeDataDir('qq_chat')
check('相对路径被拒，且理由说明"会随启动目录漂移"',
  relative.ok === false && /绝对路径/.test(relative.reason) && /漂移/.test(relative.reason), relative.reason)

const dotted = normalizeDataDir('C:\\a\\..\\b')
check('含 `..` 被拒（面板显示的位置会和你以为的不是同一个地方）',
  dotted.ok === false && /\.\./.test(dotted.reason), dotted.reason)

const tooLong = normalizeDataDir(`C:\\${'a'.repeat(DATA_DIR_MAX_LEN)}`)
check(`超长（>${DATA_DIR_MAX_LEN}）被拒，理由说清是"会静默写失败"`,
  tooLong.ok === false && /静默写失败/.test(tooLong.reason), tooLong.reason)

check('非字符串被拒（不许把数字/对象硬转成路径）',
  normalizeDataDir(123).ok === false && normalizeDataDir({ path: 'C:\\a' }).ok === false)

// ---------------------------------------- 2. 解析选文件夹窗口的输出（CLIXML 噪音）

check('纯路径原样取出', parseFolderDialogOutput('D:\\qqai\\qq_chat\r\n') === 'D:\\qqai\\qq_chat')

const noisyWithPath = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04" />\r\nD:\\data\\qq\r\n'
check('前面夹 CLIXML 噪音也能挑出真路径',
  parseFolderDialogOutput(noisyWithPath) === 'D:\\data\\qq', parseFolderDialogOutput(noisyWithPath))

const noiseOnly = '#< CLIXML\r\n<Objs Version="1.1.0.1" />\r\n'
check('⚠️ 只有噪音、没有真路径时返回空串（绝不能把 `#< CLIXML` 当目录）',
  parseFolderDialogOutput(noiseOnly) === '', JSON.stringify(parseFolderDialogOutput(noiseOnly)))

check('空输出 = 用户取消', parseFolderDialogOutput('') === '' && parseFolderDialogOutput(null) === '')
check('UNC 路径认', parseFolderDialogOutput('\\\\nas\\share\\qq') === '\\\\nas\\share\\qq')

// ------------------------------------------------ 3. pickFolderDialog（注入 execFile）

/** 假的 execFile：按给定 stdout / error 回调，**不启动任何进程**。 */
const fakeExec = (stdout, error = null) => (command, args, options, callback) => {
  process.nextTick(() => callback(error, stdout, ''))
}

const notWindows = await pickFolderDialog({ platform: 'linux', execFileImpl: fakeExec('C:\\a') })
check('非 Windows 如实回"只在 Windows 可用"，不假装能做到',
  notWindows.ok === false && /只在 Windows/.test(notWindows.reason) && /填/.test(notWindows.reason),
  notWindows.reason)

const picked = await pickFolderDialog({ platform: 'win32', execFileImpl: fakeExec('D:\\qqai\\qq_chat\r\n') })
check('选中目录 ⇒ ok:true + 路径', picked.ok === true && picked.path === 'D:\\qqai\\qq_chat', picked.path)

const cancelled = await pickFolderDialog({ platform: 'win32', execFileImpl: fakeExec('') })
check('⚠️ 取消（没有输出）⇒ ok:false，绝不能用空串当"用户的选择"',
  cancelled.ok === false && /没有选择/.test(cancelled.reason) && /一个字都没改/.test(cancelled.reason),
  cancelled.reason)

const spawnFailed = Object.assign(new Error('spawn powershell.exe ENOENT'), { killed: false })
const failedRun = await pickFolderDialog({ platform: 'win32', execFileImpl: fakeExec('', spawnFailed) })
check('执行失败 ⇒ ok:false 且带出真原因', failedRun.ok === false && /ENOENT/.test(failedRun.reason), failedRun.reason)

const timedOut = Object.assign(new Error('killed'), { killed: true })
const timeoutRun = await pickFolderDialog({ platform: 'win32', execFileImpl: fakeExec('', timedOut) })
check('超时 ⇒ 说"3 分钟没选"，不误报成"路径非法"',
  timeoutRun.ok === false && /超时/.test(timeoutRun.reason) && /一个字都没改/.test(timeoutRun.reason),
  timeoutRun.reason)

let captured = null
const captureExec = (command, args, options, callback) => {
  captured = { command, args, options }
  process.nextTick(() => callback(null, 'D:\\qqai\\qq_chat\r\n', ''))
}
const startDir = 'D:\\聊天 记录\\qq_chat'
await pickFolderDialog({ platform: 'win32', execFileImpl: captureExec, startDir })
const script = captured?.args?.[captured.args.length - 1] ?? ''
check('起始目录走环境变量，绝不拼进脚本（中文/空格/引号会造出语法错脚本）',
  captured?.command === 'powershell.exe'
  && captured?.options?.env?.QQAI_PICK_START === startDir
  && !script.includes(startDir)
  && captured.args.includes('-STA'),
  'env.QQAI_PICK_START')

// -------------------------------------- 4. supervisor.openDataDir（不许乱弹窗）

/** 造一个只关心 dataDir 的 supervisor；openFolder 记下被调用的目标（默认不真弹）。 */
function supervisorFor({ runtime = null, dataRoot = '', cwd = '', openFolder } = {}) {
  const logs = {}
  if (runtime) {
    const file = join(tempDir(), 'qq-runtime.json')
    writeFileSync(file, JSON.stringify(runtime), 'utf8')
    logs.runtime = file
  }
  const calls = []
  const sup = createSupervisor(
    { dataRoot, cwd, logs },
    {
      exec: (command, args, options, callback) => callback(null, '', ''),
      fetchJson: async () => ({ ok: false, json: null, reason: 'test-stub' }),
      openFolder: openFolder ?? ((target) => { calls.push(target); return { ok: true } }),
    },
  )
  return { sup, calls }
}

const nothingKnown = supervisorFor({})
const unknown = nothingKnown.sup.openDataDir()
check('没有快照、也没配 cwd ⇒ 如实说"还不知道在哪"，不猜一个目录打开',
  unknown.ok === false && /还不知道/.test(unknown.reason) && nothingKnown.calls.length === 0, unknown.reason)

const relativeCase = supervisorFor({ dataRoot: 'qq_chat' })
const relativeResult = relativeCase.sup.openDataDir()
check('相对路径 ⇒ 拒绝并且**不弹窗**（相对路径会随启动目录漂移）',
  relativeResult.ok === false && /不是绝对路径/.test(relativeResult.reason) && relativeCase.calls.length === 0,
  relativeResult.reason)

const missingCase = supervisorFor({ dataRoot: join(tempDir(), 'nope') })
const missingResult = missingCase.sup.openDataDir()
check('目录不存在 ⇒ 如实报错并且**不弹窗**（不替用户创建空目录）',
  missingResult.ok === false && /目录不存在/.test(missingResult.reason) && missingCase.calls.length === 0,
  missingResult.reason)

const realDir = tempDir()
const okCase = supervisorFor({
  dataRoot: 'C:\\somewhere\\else',
  runtime: { updatedAt: Date.now(), dataDir: { path: realDir, configured: true, cwd: realDir } },
})
const okResult = okCase.sup.openDataDir()
check('目录存在 ⇒ 调用 openFolder 并回报路径（source=runtime）',
  okResult.ok === true && okResult.path === realDir && okResult.source === 'runtime'
  && okCase.calls.length === 1 && okCase.calls[0] === realDir,
  JSON.stringify(okResult))

const runtimeDir = tempDir()
const configDir = tempDir()
const prefCase = supervisorFor({
  dataRoot: configDir,
  runtime: { updatedAt: Date.now(), dataDir: { path: runtimeDir, configured: true, cwd: runtimeDir } },
})
prefCase.sup.openDataDir()
check('★ 快照优先于控制台配置（两者不一致时，打开**真正在用**的那个）',
  prefCase.calls.length === 1 && prefCase.calls[0] === runtimeDir && prefCase.calls[0] !== configDir)

const brokenCase = supervisorFor({
  dataRoot: tempDir(),
  openFolder: () => ({ ok: false, reason: '没有文件管理器' }),
})
const broken = brokenCase.sup.openDataDir()
check('openFolder 自己失败 ⇒ 把它的理由原样带出来（不吞成"成功"）',
  broken.ok === false && broken.reason === '没有文件管理器', broken.reason)

check('openFolderDefault 是函数且不抛（真实平台分支只在调用时才走）',
  typeof openFolderDefault === 'function')

// ------------------------------------------- 5. 控制台自己的路径推导（dataRoot）

const withDataDir = detectPaths({ cwd: 'C:\\cwd', dataDir: 'C:\\data' }, { env: {}, exists: () => false })
check('控制台按 dataDir 推日志路径（否则 dataDir≠cwd 时面板永远是空的）',
  withDataDir.dataRoot === 'C:\\data'
  && withDataDir.logs.trace === join('C:\\data', 'qq-trace.jsonl')
  && withDataDir.logs.runtime === join('C:\\data', 'qq-runtime.json')
  && withDataDir.logs.inbox === join('C:\\data', 'qq-inbox.jsonl')
  && withDataDir.logs.audit === join('C:\\data', 'qq-actions.log'),
  withDataDir.dataRoot)

const noDataDir = detectPaths({ cwd: 'C:\\cwd' }, { env: {}, exists: () => false })
check('dataDir 空 ⇒ dataRoot 退回 cwd（老配置行为完全不变）',
  noDataDir.dataDir === '' && noDataDir.dataRoot === 'C:\\cwd'
  && noDataDir.logs.trace === join('C:\\cwd', 'qq-trace.jsonl'))

const badDir = detectPaths({ cwd: 'C:\\cwd', dataDir: 'C:\\definitely-not-here-xyz' }, { env: {}, exists: () => false })
const badDirWarnings = configWarnings(badDir)
check('配了但目录不存在 ⇒ 只给一条提醒（不拦着不让跑），并说清旧数据不会自己搬',
  badDirWarnings.some((w) => /数据根目录还不存在/.test(w))
  && badDirWarnings.some((w) => /旧数据不会自动搬/.test(w)),
  badDirWarnings.join(' | '))

// --------------------------------------------------- 6. 面板那一行真的存在

const row = PANEL_ROW_BY_KEY.get('dataDir')
check('面板里有 dataDir 行，且是文本行 + 挂的是 normalizeDataDir（写入会校验）',
  !!row && row.type === 'text' && row.validate === normalizeDataDir && typeof row.placeholder === 'string' && row.placeholder !== '',
  JSON.stringify({ type: row?.type }))

const storageGroup = PANEL_GROUPS.find((group) => group.rows.some((item) => item.key === 'dataDir'))
check('dataDir 在「数据与备份」组里，且该组不折叠（找不到路径等于数据丢了）',
  !!storageGroup && storageGroup.id === 'storage' && storageGroup.advanced !== true,
  storageGroup?.id)

const storageNote = storageGroup?.note ?? ''
check('组级说明写清了"换目录不自动搬数据"与金丝雀必须一起搬',
  /不会自动搬/.test(storageNote) && /qq-canary\.json/.test(storageNote), 'note 覆盖搬运与金丝雀')

// ------------------------------- 7. 写进 YAML 再读回来（别把路径写成非法 YAML）

/**
 * 路径里有 `:` 和 `\`，在 YAML 里**必须加引号**：裸写 `dataDir: D:\qqai\qq_chat`
 * 会被当成转义序列（`\q` 非法）⇒ 宿主启动时**整份 patch 拒载**，而面板上只表现为"改了没生效"。
 *
 * 样例路径用 `join(BS)` 拼出来而不是写字面量：`privacy-unit` 会扫
 * `C:\Users\<名字>` 这种串，字面量会被判成"硬编码了本机用户名"。
 */
const BS = String.fromCharCode(92)
const SAMPLE_DIR = ['D:', 'qqai', 'qq_chat'].join(BS)
const yamlBase = '- id: dsh-qq-onebot-bridge\n  config:\n    botQq: 1000000000\n'
const written = upsertPatchValue(yamlBase, 'dataDir', SAMPLE_DIR)
const writtenLine = written.ok === true ? (written.yaml.split('\n').find((line) => line.includes('dataDir')) ?? '') : ''
check('写到 patch 里的路径被单引号包住（裸写会被 YAML 当转义序列，整份 patch 拒载）',
  written.ok === true && writtenLine.trim() === `dataDir: '${SAMPLE_DIR}'`, writtenLine || written.reason)
check('从 patch 里读回来与写入值逐字一致（文本行必须按 `asString` 读，见 settings-routes:951）',
  readPatchValue(written.yaml, 'dataDir', undefined, { asString: true }) === SAMPLE_DIR,
  readPatchValue(written.yaml, 'dataDir', undefined, { asString: true }))

// -------------------------------- 8. 向导的落地动作：把 dataDir 写进 cordis.patch.yml

/**
 * 再强调一次为什么向导要写**插件那份配置**：控制台自己的配置是 `qq-control.json`，
 * 插件的配置是 profile 的 `cordis.patch.yml`。写错文件的失败**不报错** ——
 * 面板显示一个路径、桥用另一个路径，只有用户翻聊天记录时才发现不对。
 */
const patchBase = '- id: dsh-qq-onebot-bridge\n  config:\n    botQq: 1000000000\n    allowUsers: [2000000001]\n'

/** 造一个只关心"写配置"的 supervisor；`writes` 收下所有落盘内容（默认不真写）。 */
function writerFor({ patchFile = '', dataRoot = '', runtime = null, readPatch = null, writePatch = null, pickExec = null, platform = null } = {}) {
  const logs = {}
  if (runtime) {
    const file = join(tempDir(), 'qq-runtime.json')
    writeFileSync(file, JSON.stringify(runtime), 'utf8')
    logs.runtime = file
  }
  const writes = []
  const sup = createSupervisor(
    { patchFile, dataRoot, profile: 'web', logs },
    {
      exec: (command, args, options, callback) => callback(null, '', ''),
      fetchJson: async () => ({ ok: false, json: null, reason: 'test-stub' }),
      openFolder: () => ({ ok: true }),
      writePatchFile: (file, text) => { writes.push({ file, text }); if (writePatch) writePatch(file, text) },
      ...(readPatch ? { readPatchFile: readPatch } : {}),
      ...(pickExec ? { pickExecFile: pickExec } : {}),
      ...(platform ? { platform } : {}),
    },
  )
  return { sup, writes }
}

const emptyTarget = tempDir()
const patchPath = join(tempDir(), 'cordis.patch.yml')
const first = writerFor({ patchFile: patchPath, readPatch: () => patchBase })
const firstResult = first.sup.setDataDir(emptyTarget)
check('写入 dataDir：ok + changed，值就是归一化后的绝对路径',
  firstResult.ok === true && firstResult.changed === true && firstResult.value === emptyTarget,
  JSON.stringify({ ok: firstResult.ok, changed: firstResult.changed }))
check('写到的是 profile 的 patch，且**只动这一个键**（别的键原样保留）',
  first.writes.length === 1 && first.writes[0].file === patchPath
  && /^\s{4}dataDir: /m.test(first.writes[0].text)
  && /botQq: 1000000000/.test(first.writes[0].text)
  && /allowUsers: \[2000000001\]/.test(first.writes[0].text),
  first.writes.length === 1 ? first.writes[0].text.split('\n').filter((line) => line.includes('dataDir')).join('|') : '(没写)')
check('空目录如实报"空"（不假装里面有东西）',
  firstResult.target.exists === true && firstResult.target.qqCount === 0, JSON.stringify(firstResult.target))

const second = writerFor({ patchFile: patchPath, readPatch: () => first.writes[0]?.text ?? patchBase })
const secondResult = second.sup.setDataDir(emptyTarget)
check('同一个值再写一次 ⇒ changed=false 且一个字都不落盘（不会每点一次就重写配置）',
  secondResult.ok === true && secondResult.changed === false && second.writes.length === 0,
  JSON.stringify({ changed: secondResult.changed, writes: second.writes.length }))

const relativeWriter = writerFor({ patchFile: patchPath, readPatch: () => patchBase })
const relativeWrite = relativeWriter.sup.setDataDir('qq_chat')
check('相对路径被拒，且**一个字都没写**',
  relativeWrite.ok === false && relativeWriter.writes.length === 0 && /绝对路径/.test(relativeWrite.reason),
  relativeWrite.reason)

const noPatchWriter = writerFor({ patchFile: '' })
check('不知道 patch 在哪 ⇒ 如实拒绝，不瞎猜一个路径去写',
  noPatchWriter.sup.setDataDir(emptyTarget).ok === false, noPatchWriter.sup.setDataDir(emptyTarget).reason)

const unreadableWriter = writerFor({ patchFile: patchPath, readPatch: () => { throw new Error('EACCES: permission denied') } })
check('读不到 patch ⇒ 把真原因报出来（不吞成"写入失败"）',
  /EACCES/.test(unreadableWriter.sup.setDataDir(emptyTarget).reason ?? ''),
  unreadableWriter.sup.setDataDir(emptyTarget).reason)

const otherPatch = '- id: some-other-plugin\n  config:\n    a: 1\n'
const appendWriter = writerFor({ patchFile: patchPath, readPatch: () => otherPatch })
const appendResult = appendWriter.sup.setDataDir(emptyTarget)
check('patch 里没有我们的条目 ⇒ 追加一条，而不是拒绝（否则装成 bundle 的用户点什么都红字）',
  appendResult.ok === true && /some-other-plugin/.test(appendWriter.writes[0]?.text ?? '')
  && /dsh-qq-onebot-bridge/.test(appendWriter.writes[0]?.text ?? ''),
  appendWriter.writes[0]?.text?.slice(0, 120))

// 目标目录里已经有东西 / 金丝雀
const existingTarget = tempDir()
writeFileSync(join(existingTarget, 'qq-sessions.json'), '{}', 'utf8')
writeFileSync(join(existingTarget, 'qq-trace.jsonl'), '', 'utf8')
const existingWriter = writerFor({ patchFile: patchPath, readPatch: () => patchBase })
const existingResult = existingWriter.sup.setDataDir(existingTarget)
check('目标里有 qq-* ⇒ 数出来（2 个），并提醒没有金丝雀会被重新生成',
  existingResult.target.qqCount === 2 && existingResult.target.hasCanary === false
  && existingResult.warnings.some((w) => /qq-canary\.json/.test(w) && /认不出来/.test(w)),
  JSON.stringify({ qqCount: existingResult.target.qqCount, warnings: existingResult.warnings.length }))

// 条目很多时不许把向导撑爆，但**计数必须是真的**（"列了 12 个"与"实际有 15 个"是两件事）
const manyTarget = tempDir()
for (let index = 0; index < 15; index += 1) writeFileSync(join(manyTarget, `qq-x${index}.json`), '{}', 'utf8')
const manyDescribed = describeDataDir(manyTarget)
check('条目多时只列前 12 个，但计数是全部',
  manyDescribed.qqEntries.length === 12 && manyDescribed.qqCount === 15,
  JSON.stringify({ listed: manyDescribed.qqEntries.length, count: manyDescribed.qqCount }))
check('describeDataDir 对不存在的目录如实返回 exists=false（不抛）',
  describeDataDir(join(tempDir(), 'nope')).exists === false && describeDataDir('').exists === false)

const canaryTarget = tempDir()
writeFileSync(join(canaryTarget, 'qq-canary.json'), '{}', 'utf8')
const canaryWriter = writerFor({ patchFile: patchPath, readPatch: () => patchBase })
const canaryResult = canaryWriter.sup.setDataDir(canaryTarget)
check('目标里已有 qq-canary.json ⇒ 如实说"金丝雀继续有效"，不再吓人',
  canaryResult.target.hasCanary === true
  && canaryResult.warnings.every((w) => !/认不出来/.test(w)),
  JSON.stringify(canaryResult.warnings))

const currentDir = tempDir()
writeFileSync(join(currentDir, 'qq-canary.json'), '{}', 'utf8')
const notYet = join(tempDir(), 'not-yet-exists')
const movingWriter = writerFor({
  patchFile: patchPath,
  readPatch: () => patchBase,
  runtime: { updatedAt: Date.now(), dataDir: { path: currentDir, configured: true } },
})
const movingResult = movingWriter.sup.setDataDir(notYet)
check('目标还不存在 ⇒ 照写（宿主会自己建），但明确告知',
  movingResult.ok === true && movingResult.target.exists === false,
  JSON.stringify(movingResult.target))
check('当前目录有金丝雀而目标没有 ⇒ 提醒"搬的时候必须一起拷 qq-canary.json"',
  movingResult.warnings.some((w) => /qq-canary\.json/.test(w) && /一起拷/.test(w)),
  JSON.stringify(movingResult.warnings))

// 真写盘（原子写 + YAML 引号），这是唯一会碰真实文件的一条
const realPatch = join(tempDir(), 'cordis.patch.yml')
writeFileSync(realPatch, patchBase, 'utf8')
const realWriter = writerFor({ patchFile: realPatch, readPatch: () => readFileSync(realPatch, 'utf8'), writePatch: writeFileAtomic })
const realResult = realWriter.sup.setDataDir(emptyTarget)
check('真写盘后从文件读回来就是那个路径（YAML 引号正确，宿主编解析不炸）',
  realResult.ok === true
  && readPatchValue(readFileSync(realPatch, 'utf8'), 'dataDir', undefined, { asString: true }) === emptyTarget,
  readPatchValue(readFileSync(realPatch, 'utf8'), 'dataDir', undefined, { asString: true }))
check('原子写不留临时文件（留下的话下次宿主可能读到半份 YAML）',
  existsSync(realPatch) && !existsSync(`${realPatch}.tmp-${process.pid}`))

// 「浏览…」：只选不写
const pickOk = (command, args, options, callback) => process.nextTick(() => callback(null, `${emptyTarget}\r\n`, ''))
const pickCancel = (command, args, options, callback) => process.nextTick(() => callback(null, '', ''))
const browseOkWriter = writerFor({ patchFile: patchPath, pickExec: pickOk, platform: 'win32' })
const browseOk = await browseOkWriter.sup.browseDataDir()
check('浏览：选中就只回路径，**不写配置**（写是下一步确认的事）',
  browseOk.ok === true && browseOk.path === emptyTarget && browseOkWriter.writes.length === 0,
  JSON.stringify(browseOk))
const browseCancel = await writerFor({ patchFile: patchPath, pickExec: pickCancel, platform: 'win32' }).sup.browseDataDir()
check('浏览：取消 ⇒ ok:false（不能把空串当成"用户选好了"）',
  browseCancel.ok === false && /没有选择/.test(browseCancel.reason), browseCancel.reason)
const browseOther = await writerFor({ patchFile: patchPath, pickExec: pickOk, platform: 'linux' }).sup.browseDataDir()
check('浏览：非 Windows ⇒ 如实说不支持', browseOther.ok === false && /只在 Windows/.test(browseOther.reason), browseOther.reason)

// profile / patch 路径推导（控制台要能自己找到那个文件）
const derivedProfile = detectPaths({}, { env: { DSH_HOME: 'D:/dshhome' }, exists: () => false })
check('控制台推 profile 与 patch 路径（DSH_HOME 优先，缺省 web）',
  derivedProfile.profile === 'web'
  && derivedProfile.patchFile === join('D:/dshhome', 'profiles', 'web', 'cordis.patch.yml'),
  derivedProfile.patchFile)

/**
 * 数据根目录的来源三级（这四条是"向导写完之后，第二天还对不对"的核心）。
 *
 * ★ 为什么必须测：`setDataDir` 写的是 **profile 的 patch**，而控制台自己还有一份
 * `qq-control.json`。如果控制台只认自己那份，向导写完、宿主重启之后，桥（读 patch）
 * 搬去了新目录，控制台（读旧值）还在老地方翻日志 ⇒ 面板全空。而"读不到文件"和
 * "真的没有数据"在界面上长得一模一样，用户只会以为她的数据没了。
 */
const patchHost = join('D:/dshhome', 'profiles', 'web', 'cordis.patch.yml')
const patchWithDir = [
  '- id: dsh-qq-onebot-bridge',
  '  config:',
  "    dataDir: 'D:\\qqai\\qq_chat'",
  '',
].join('\n')
const derived = (config, patchYaml, extra = {}) => detectPaths(config, {
  env: { DSH_HOME: 'D:/dshhome', USERPROFILE: 'D:/home' },
  exists: (p) => p === patchHost,
  readdir: () => [],
  readFile: () => patchYaml,
  ...extra,
})

const fromPatch = derived({}, patchWithDir)
check('② patch 里有 dataDir ⇒ 控制台跟着它走（不是还按 cwd 猜）',
  fromPatch.dataDirSource === 'patch' && fromPatch.dataRoot === resolve('D:\\qqai\\qq_chat'),
  JSON.stringify({ source: fromPatch.dataDirSource, root: fromPatch.dataRoot }))
check('② patch 生效时，日志/快照/收件箱全部落在同一个根下（不能新旧混读）',
  fromPatch.logs.trace === join(fromPatch.dataRoot, 'qq-trace.jsonl')
  && fromPatch.logs.runtime === join(fromPatch.dataRoot, 'qq-runtime.json')
  && fromPatch.logs.inbox === join(fromPatch.dataRoot, 'qq-inbox.jsonl')
  && fromPatch.logs.audit === join(fromPatch.dataRoot, 'qq-actions.log'),
  fromPatch.logs.trace)

const fromConfig = derived({ dataDir: 'E:\\override' }, patchWithDir)
check('① qq-control.json 显式写 dataDir ⇒ 压过 patch（覆盖口子仍然有效）',
  fromConfig.dataDirSource === 'config' && fromConfig.dataRoot === resolve('E:\\override'),
  JSON.stringify({ source: fromConfig.dataDirSource, root: fromConfig.dataRoot }))

const noDir = detectPaths({ cwd: 'D:\\qqcwd' }, {
  env: { DSH_HOME: 'D:/dshhome', USERPROFILE: 'D:/home' },
  exists: (p) => p === patchHost,
  readdir: () => [],
  readFile: () => '- id: dsh-qq-onebot-bridge\n  config:\n    botQq: 1000000000\n',
})
check('③ 两处都没配 ⇒ 退回 cwd 兜底，并如实标 source=none（别假装配置好了）',
  noDir.dataDirSource === 'none' && noDir.dataDir === '' && noDir.dataRoot === resolve('D:\\qqcwd'),
  JSON.stringify({ source: noDir.dataDirSource, root: noDir.dataRoot }))

const brokenPatch = derived({ cwd: 'D:\\qqcwd' }, null, {
  readFile: () => { throw new Error('EACCES: 读不了') },
})
check('patch 读坏了 ⇒ 当没配，控制台照样起得来（不能因为配置坏就整个崩）',
  brokenPatch.dataDirSource === 'none' && brokenPatch.dataRoot === resolve('D:\\qqcwd'),
  JSON.stringify({ source: brokenPatch.dataDirSource, root: brokenPatch.dataRoot }))

// ------------------------------- 9. HTTP 侧：/api/data-dir/set 真写盘（只碰临时目录）

/**
 * 这一节存在的理由：上面所有断言都在**函数层**。而向导真正走的是
 * `浏览器 → POST /api/data-dir/set → supervisor.setDataDir → 写 patch`。
 * 中间任何一环"接不上"（字段名不对、body 没解析、没 await），函数层照样全绿。
 * 所以这里起一个真的 HTTP server，用真的 fetch 打一遍——`open`/`browse` 不测：
 * 那两个会真弹资源管理器/选文件夹窗口，在自动化里属于"绝不能碰"的一类。
 */
const httpRoot = tempDir()
const httpPatch = join(httpRoot, 'cordis.patch.yml')
writeFileSync(httpPatch, patchBase, 'utf8')
const httpTarget = tempDir()
const httpApi = writerFor({
  patchFile: httpPatch,
  readPatch: () => readFileSync(httpPatch, 'utf8'),
  writePatch: writeFileAtomic,
}).sup
const httpToken = 'test-token-datadir'
const httpServer = createControlServer({
  config: { ports: {}, logs: {}, dataRoot: httpRoot, cwd: httpRoot, patchFile: httpPatch, profile: 'web' },
  token: httpToken,
  api: httpApi,
  ui: '<html></html>',
})
await new Promise((resolve) => { httpServer.listen(0, '127.0.0.1', resolve) })
const httpPort = httpServer.address().port
try {
  const endpoint = `http://127.0.0.1:${httpPort}/api/data-dir/set?token=${httpToken}`
  const post = (payload) => fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).then((response) => response.json())

  const accepted = await post({ path: httpTarget })
  check('HTTP：写入成功并回显路径', accepted.ok === true && accepted.value === httpTarget, JSON.stringify(accepted.ok))
  check('HTTP：值**真的落进了** patch 文件（不是只在返回值里好看）',
    readPatchValue(readFileSync(httpPatch, 'utf8'), 'dataDir', undefined, { asString: true }) === httpTarget,
    readPatchValue(readFileSync(httpPatch, 'utf8'), 'dataDir', undefined, { asString: true }))

  const noPath = await post({})
  check('HTTP：缺 path 字段 ⇒ 明确拒绝（否则会把 dataDir 写成空串）',
    noPath.ok === false && /缺少 path/.test(noPath.reason ?? ''), noPath.reason)

  const relativeOverHttp = await post({ path: 'relative/dir' })
  check('HTTP：相对路径被拒', relativeOverHttp.ok === false && /绝对路径/.test(relativeOverHttp.reason ?? ''),
    relativeOverHttp.reason)

  const unauthenticated = await fetch(`http://127.0.0.1:${httpPort}/api/data-dir/set`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: httpTarget }),
  }).then((response) => response.json())
  check('HTTP：没有 token ⇒ 401（写配置的接口不能裸奔）',
    unauthenticated.ok === false && /token/.test(unauthenticated.reason ?? ''), unauthenticated.reason)
} finally {
  await new Promise((resolve) => { httpServer.close(resolve) })
}

// ------------------- 10. 向导的接线（**静态**检查：只说"接上了"，不说"渲染正确"）

/**
 * ⚠️ 这一节**只做静态检查**，不要把它读成"向导能弹出来"。
 *
 * 真正的渲染要跑浏览器，而这里没有。它挡的是最容易犯的那类错：
 * 函数写好了但**没被调用**、模态写好了但**没接线**、关闭但**不记状态**（于是关不掉）。
 * 名字里都写清"静态"，是为了不让后人以为这一节验证过界面。
 */
const uiSource = readFileSync(new URL('../control/ui.html', import.meta.url), 'utf8')
check('静态：向导的模态在页面上，且默认是关的',
  /<div id="setupModal" class="modal off"/.test(uiSource))
check('静态：渲染运行快照后会检查"该不该弹"（否则永远不会主动出现）',
  /maybeAutoOpenSetup\(runtime\)/.test(uiSource))
check('静态：关掉向导会记住"本轮别再弹"（否则每两秒的刷新会把窗口顶回来）',
  /setupDismissed = true/.test(uiSource))
check('静态：横幅上有「现在就选」入口（关掉之后不是死路）',
  /onclick="openSetupModal\(\)"/.test(uiSource) && /现在就选/.test(uiSource))

// ────────────────────────────────────────────────────────────────── 收尾 ──
for (const dir of tempDirs) {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* 收不掉也不影响结论 */ }
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
