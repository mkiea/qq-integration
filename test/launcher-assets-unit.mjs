/**
 * 启动器资产守卫（2026-11-07）。
 *
 * 三个都是**真机上已经踩过**的坑，靠人肉 review 拦不住：
 *   ① `.bat` 里出现中文全角标点（；：），在 `chcp 65001` 下被 cmd.exe 拆行，
 *      尾段当命令执行 → 窗口报 `'...' is not recognized`；
 *   ② `.bat` 存成 LF-only，`if (...)` 块会把行粘在一起；
 *   ③ `.ps1` 存成「UTF-8 无 BOM」时，Windows PowerShell 5.1 按 ANSI 读，
 *      中文全成乱码 —— 而 5.1 是干净机器上的默认解释器。
 *
 * 另外钉住「桌面快捷方式」这一步真的接在启动流程里（功能做在文件里、没接线 = 没做）。
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const batPath = join(REPO, '一键启动.bat')
const psPath = join(REPO, 'launcher', 'make-shortcut.ps1')
const preflight = join(REPO, 'launcher', 'preflight.mjs')

check('一键启动.bat 存在', existsSync(batPath), batPath)
check('launcher/make-shortcut.ps1 存在', existsSync(psPath), psPath)
check('launcher/preflight.mjs 存在', existsSync(preflight), preflight)

const batBytes = existsSync(batPath) ? readFileSync(batPath) : Buffer.alloc(0)
const batText = batBytes.toString('utf8')

// ① BOM 会让 `@echo off` 变成「﻿@echo off」，cmd 直接报错
check('bat 不带 UTF-8 BOM（否则第一行就不是 @echo off 了）', batBytes.subarray(0, 3).toString('hex') !== 'efbbbf')

// ② CRLF only
const lf = [...batBytes].filter((b) => b === 10).length
const crlf = batBytes.toString('latin1').split('\r\n').length - 1
check('bat 全 CRLF（无裸 LF）', lf === crlf, `LF=${lf} CRLF=${crlf}`)

// ③ 每一行 echo 必须是纯 ASCII（中文一律交给 Node 侧打印）
const echoLines = batText.split(/\r?\n/).filter((line) => /^\s*echo[\s.]/i.test(line))
const badEcho = echoLines.filter((line) => /[^\x00-\x7F]/.test(line))
check('bat 的 echo 行全部是 ASCII（中文全角标点会被 cmd 拆行）',
  badEcho.length === 0, badEcho.slice(0, 2).join(' | ') || `${echoLines.length} 行`)

// ④ 快捷方式那一步真的接在启动流程里，且用 %~f0 / %~dp0（不写死路径）
check('bat 调用了 launcher\\make-shortcut.ps1',
  /launcher\\make-shortcut\.ps1/.test(batText), '')
check('bat 只传目录（-WorkDir "%~dp0"），不让中文文件名过 argv',
  /-WorkDir\s+"%~dp0"/.test(batText) && !/-TargetBat/.test(batText), '')

if (existsSync(psPath)) {
  const psBytes = readFileSync(psPath)
  const psText = psBytes.toString('utf8')
  check('make-shortcut.ps1 带 UTF-8 BOM（PowerShell 5.1 才不会把中文读成乱码）',
    psBytes.subarray(0, 3).toString('hex') === 'efbbbf')
  check('用 GetFolderPath(Desktop)，不吃 OneDrive/重定向桌面的亏',
    /GetFolderPath\(\s*'Desktop'\s*\)/.test(psText), '')
  check('用 WScript.Shell CreateShortcut（.lnk 的标准做法）',
    /CreateShortcut\(/.test(psText) && /WScript\.Shell/.test(psText), '')
  check('幂等：固定文件名，重复运行只覆盖同一个 .lnk',
    /Join-Path \$desktop \(\$Name \+ '\.lnk'\)/.test(psText), '')
  check('失败只报错不中断启动（不 exit 1 之前先写 SHORTCUT_FAIL）',
    /SHORTCUT_FAIL=/.test(psText), '')
  check('★会自己从目录里找唯一的 *.bat（-TargetBat 可选，中文名不过 argv）',
    /Get-ChildItem[^\n]*-Filter '\*\.bat'/.test(psText) && /\$TargetBat = ''/.test(psText), '')
  check('★WorkDir 先 TrimEnd 去掉尾斜杠（带尾斜杠会让 CreateShortcut 抛 Illegal characters）',
    /\$WorkDir = \$WorkDir\.TrimEnd\('\\'\)/.test(psText), '')

  // 图标：脚本同目录的 .ico，不写死 shell32.dll 索引（猜索引=显示成别的图案）
  const ico = join(REPO, 'launcher', 'qq-integration.ico')
  check('launcher/qq-integration.ico 存在', existsSync(ico), ico)
  if (existsSync(ico)) {
    const ib = readFileSync(ico)
    check('ico 头合法（00 00 01 00）', ib.subarray(0, 4).toString('hex') === '00000100')
    const frames = ib.readUInt16LE(4)
    check('ico 是多尺寸（>= 4 帧，16px 才不至于糊）', frames >= 4, `${frames} 帧`)
  }
  check('快捷方式用同目录 .ico（$PSScriptRoot，随包走）',
    /\$PSScriptRoot/.test(psText) && /qq-integration\.ico/.test(psText), '')
  check('读回来核对 IconLocation（不只看"设过了"）',
    /ICON_OK=/.test(psText), '')
}

// 安装脚本也要接这一棒（否则只有手动双击 bat 的人才有桌面图标）
const install = readFileSync(join(REPO, 'scripts', 'install-windows.ps1'), 'utf8')
check('install-windows.ps1 也创建桌面快捷方式',
  /make-shortcut\.ps1/.test(install) && /TargetBat/.test(install), '')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
