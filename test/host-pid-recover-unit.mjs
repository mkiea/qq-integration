/**
 * #8b：netstat 看不见宿主时，用命令行反查 PID —— 单元测试（2026-11-06）。
 *
 * 背景：`host.pid=0` 时 `stopHost` 拿 0 去 `assertKillAllowed` 会被判"PID 非法"，
 * 「重启宿主」按钮点了没反应。修法是反查 + **再核一次**才允许杀。
 *
 * 判据（跑之前写死）：
 *   P1 正常 stdout "1234" ⇒ 1234
 *   P2 空 stdout ⇒ 0（不是 NaN / 不是抛错）
 *   P3 非数字 ⇒ 0
 *   P4 多个 PID 只取第一个
 *   P5 verify：进程名不是 node.exe ⇒ 拒绝
 *   P6 verify：命令行不含 needle ⇒ 拒绝
 *   P7 verify：名字+命令行都对 ⇒ 允许，并回带 commandLine
 *   P8 verify：JSON 坏了 ⇒ 拒绝（不抛）
 *   P9 needle 里的引号被清掉（防注入进 PowerShell 脚本）
 *
 * 用法：`node test/host-pid-recover-unit.mjs`
 */
import { findPidByCommandLine, verifyPidByCommandLine, HOST_CMD_MATCH } from '../control/lib/supervisor.mjs'

let passed = 0
let failed = 0
const check = (name, ok, extra = '') => {
  if (ok) { passed++; console.log('PASS', name, extra) } else { failed++; console.log('FAIL', name, extra) }
}

/** 造一个只回固定 stdout 的 exec 替身，同时记下最后一次被调用的参数 */
const fakeExec = (stdout) => {
  const calls = []
  const exec = (command, args, options, callback) => {
    const done = typeof options === 'function' ? options : callback
    calls.push({ command, args })
    done(null, stdout, '')
  }
  exec.calls = calls
  return exec
}

// P1 正常
const p1 = await findPidByCommandLine(HOST_CMD_MATCH, { exec: fakeExec('1234\n') })
check('P1 正常取到 PID', p1 === 1234, String(p1))

// P2 空
const p2 = await findPidByCommandLine(HOST_CMD_MATCH, { exec: fakeExec('') })
check('P2 空输出 ⇒ 0', p2 === 0, String(p2))

// P3 非数字
const p3 = await findPidByCommandLine(HOST_CMD_MATCH, { exec: fakeExec('no such process') })
check('P3 非数字 ⇒ 0', p3 === 0, String(p3))

// P4 多个只取第一个
const p4 = await findPidByCommandLine(HOST_CMD_MATCH, { exec: fakeExec('4321\n8765\n') })
check('P4 多个取第一个', p4 === 4321, String(p4))

// P5 名字不对
const wrongName = fakeExec(JSON.stringify({ Name: 'QQ.exe', CommandLine: 'C:/x/bin.js web' }))
const p5 = await verifyPidByCommandLine(4321, HOST_CMD_MATCH, { exec: wrongName })
check('P5 非 node.exe ⇒ 拒绝', p5.ok === false && p5.reason.includes('不是 node.exe'), p5.reason)

// P6 命令行不含 needle
const wrongCmd = fakeExec(JSON.stringify({ Name: 'node.exe', CommandLine: 'C:/other/server.mjs' }))
const p6 = await verifyPidByCommandLine(4321, HOST_CMD_MATCH, { exec: wrongCmd })
check('P6 命令行不匹配 ⇒ 拒绝', p6.ok === false && p6.reason.includes('命令行不含'), p6.reason)

// P7 正常
const good = fakeExec(JSON.stringify({ Name: 'node.exe', CommandLine: 'node C:/dsh/lib/bin.js web' }))
const p7 = await verifyPidByCommandLine(4321, HOST_CMD_MATCH, { exec: good })
check('P7 名字+命令行都对 ⇒ 允许', p7.ok === true && p7.commandLine.includes('bin.js web'), JSON.stringify(p7))

// P8 JSON 坏了
const badJson = fakeExec('{not json')
const p8 = await verifyPidByCommandLine(4321, HOST_CMD_MATCH, { exec: badJson })
check('P8 坏 JSON ⇒ 拒绝(不抛)', p8.ok === false && p8.reason.includes('读不到'), p8.reason)

// P9 引号清洗
const inject = fakeExec('1\n')
await findPidByCommandLine(`bin.js' web"`, { exec: inject })
const script = inject.calls[0]?.args?.at(-1) ?? ''
check('P9 needle 里的引号被清掉', !script.includes(`'bin.js'`) && !script.includes('web"'), script.slice(0, 120))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
