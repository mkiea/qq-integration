/**
 * `lib/waylay-launch.js` 的单测。零依赖、不碰真实进程。
 *
 * 重点不是"能跑通"，而是**每条拒绝路径都真的会拒**：
 * 这个模块唯一的破坏性动作是结束进程，判据写松了就会误杀用户的 QQ。
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  detectWaylayBat, parseListenerPid, waylayLaunchCommand, stopPlan,
  describeStatus, waylayLogPath, waylayQrPath,
  WAYLAY_PORT, WAYLAY_ENTRY_FILE, WAYLAY_LOG_FILE, WAYLAY_QR_FILE,
} from '../lib/waylay-launch.js'

// ---------------------------------------------------------------- detectWaylayBat
test('detectWaylayBat: 显式配置优先', () => {
  const got = detectWaylayBat({
    configured: 'D:/x/rin-waylay.bat',
    env: { RIN_WAYLAY_BAT: 'D:/y/rin-waylay.bat' },
    exists: (p) => p === 'D:/x/rin-waylay.bat' || p === 'D:/y/rin-waylay.bat',
  })
  assert.match(got, /rin-waylay\.bat$/)
  assert.ok(got.includes('x'), `应取 configured，实际 ${got}`)
})

test('detectWaylayBat: 配置落空时退到环境变量', () => {
  const got = detectWaylayBat({
    configured: 'D:/nope/rin-waylay.bat',
    env: { RIN_WAYLAY_BAT: 'D:/y/rin-waylay.bat' },
    exists: (p) => p === 'D:/y/rin-waylay.bat',
  })
  assert.ok(got.includes('y'), `应取环境变量，实际 ${got}`)
})

test('detectWaylayBat: 给目录时自动补文件名', () => {
  // 注意：path.join 在 Windows 产出反斜杠，假 exists 要归一化路径再比，
  // 否则测的是"斜杠方向"而不是"补文件名"这件事（第一版就栽在这儿）。
  const norm = (p) => String(p).replace(/\\/g, '/')
  const got = detectWaylayBat({
    configured: 'D:/dir',
    exists: (p) => ['D:/dir', 'D:/dir/rin-waylay.bat'].includes(norm(p)),
  })
  assert.ok(got.endsWith(WAYLAY_ENTRY_FILE), `应补成 ${WAYLAY_ENTRY_FILE}，实际 ${got}`)
})

test('detectWaylayBat: 全都找不到就返回空串（不抛）', () => {
  assert.equal(detectWaylayBat({ configured: '', env: {}, exists: () => false }), '')
})

// ---------------------------------------------------------------- parseListenerPid
const NETSTAT = [
  '  TCP    0.0.0.0:13000          0.0.0.0:0              LISTENING       37256',
  '  TCP    127.0.0.1:6700         0.0.0.0:0              LISTENING       33344',
  '  TCP    127.0.0.1:6700         127.0.0.1:56573        ESTABLISHED     33344',
  '  TCP    0.0.0.0:130000         0.0.0.0:0              LISTENING       99999',
].join('\r\n')

test('parseListenerPid: 找到监听 13000 的 PID', () => {
  assert.deepEqual(parseListenerPid(NETSTAT).pid, 37256)
})

test('parseListenerPid: 不吃 ESTABLISHED 行', () => {
  const onlyEstablished = '  TCP    127.0.0.1:13000        127.0.0.1:50000        ESTABLISHED     1234'
  assert.equal(parseListenerPid(onlyEstablished), null)
})

test('parseListenerPid: 端口边界——130000 不能算 13000', () => {
  const wrong = '  TCP    0.0.0.0:130000         0.0.0.0:0              LISTENING       99999'
  assert.equal(parseListenerPid(wrong), null)
})

test('parseListenerPid: IPv6 地址也能认', () => {
  const v6 = '  TCP    [::1]:13000            [::]:0                 LISTENING       4242'
  assert.equal(parseListenerPid(v6).pid, 4242)
})

test('parseListenerPid: 空输入返回 null', () => {
  assert.equal(parseListenerPid(''), null)
  assert.equal(parseListenerPid(null), null)
})

// ---------------------------------------------------------------- waylayLaunchCommand
test('waylayLaunchCommand: 用 cmd /c 包住 bat（spawn 不能直接跑 bat）', () => {
  const c = waylayLaunchCommand('D:/d/rin-waylay.bat', { uin: '12340001', comspec: 'cmd.exe' })
  assert.equal(c.file, 'cmd.exe')
  assert.deepEqual(c.args, ['/c', 'D:/d/rin-waylay.bat', '12340001'])
  assert.equal(c.cwd, 'D:/d')
})

test('waylayLaunchCommand: 非法 QQ 号不传（避免命令行注入 / 传错参数）', () => {
  for (const bad of ['', 'abc', '12', '12340001 & calc', '-q 123', '  ']) {
    const c = waylayLaunchCommand('D:/d/rin-waylay.bat', { uin: bad })
    assert.equal(c.args.length, 2, `"${bad}" 不该被当成参数，实际 ${JSON.stringify(c.args)}`)
  }
})

test('waylayLaunchCommand: 没有 bat 就返回 null', () => {
  assert.equal(waylayLaunchCommand(''), null)
})

// ---------------------------------------------------------------- stopPlan（最重要）
test('stopPlan: 正常情况给出 taskkill /PID（不是 /IM）', () => {
  const r = stopPlan({ pid: 37256, processName: 'QQ.exe', selfPid: 100 })
  assert.equal(r.ok, true)
  assert.deepEqual(r.plan.args, ['/PID', '37256', '/T', '/F'])
  assert.ok(!r.plan.args.includes('/IM'), '绝不能用 /IM 按镜像名杀')
})

test('stopPlan: 拿不到 PID 就拒（不猜）', () => {
  for (const pid of [null, 0, -1, 1.5, NaN]) {
    const r = stopPlan({ pid, processName: 'QQ.exe' })
    assert.equal(r.ok, false, `pid=${pid} 应被拒`)
    assert.match(r.reason, /没有找到/)
  }
})

test('stopPlan: 进程名不是 QQ 就拒（防误杀）', () => {
  for (const name of ['node.exe', 'chrome.exe', 'explorer.exe', '']) {
    const r = stopPlan({ pid: 123, processName: name })
    assert.equal(r.ok, false, `进程名 "${name}" 应被拒`)
  }
})

test('stopPlan: 目标是自己就拒（自杀保护）', () => {
  const r = stopPlan({ pid: 500, processName: 'QQ.exe', selfPid: 500 })
  assert.equal(r.ok, false)
  assert.match(r.reason, /控制台自己/)
})

test('stopPlan: qqex.exe 也算 QQ 系（国际版）', () => {
  assert.equal(stopPlan({ pid: 7, processName: 'QQEx.exe' }).ok, true)
  assert.equal(stopPlan({ pid: 7, processName: 'qq.exe' }).ok, true)
})

// ---------------------------------------------------------------- 路径与文案
test('路径拼接：日志与二维码都在 bat 同目录', () => {
  assert.ok(waylayLogPath('D:/d/rin-waylay.bat').endsWith(WAYLAY_LOG_FILE))
  assert.ok(waylayQrPath('D:/d/rin-waylay.bat').endsWith(WAYLAY_QR_FILE))
  assert.equal(waylayLogPath(''), '')
})

test('describeStatus: 区分"端口在听"与"能收发"', () => {
  assert.equal(describeStatus({ listening: false }).level, 'off')
  const warn = describeStatus({ listening: true, pid: 37256, loggedIn: false })
  assert.equal(warn.level, 'warn')
  assert.match(warn.text, /端口在听≠能收发/)
  const ok = describeStatus({ listening: true, pid: 1, loggedIn: true, uptimeSec: 600 })
  assert.equal(ok.level, 'ok')
  assert.match(ok.text, /10 分钟/)
})

test('WAYLAY_PORT 与控制台默认 13000 一致', () => {
  assert.equal(WAYLAY_PORT, 13000)
})
