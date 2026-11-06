<#
.SYNOPSIS
  Windows 安装：Node + DSH + QQ 桥插件，含「干净机」前置检查。

.DESCRIPTION
  面向一台干净 Windows。2026-11-06 在 Win11 虚拟机真机从零装过一遍，踩到的
  几个坑都在这里被显式挡住，而不是靠用户看文档反推：

    · DSH 0.2.2-rc.1 的 engines.node 是 >=24.9.0。Node 22 下 `dsh --version`
      和 `dsh plugin add` 都会 **exit 0、零输出、profile 一个文件都不建**。
      旧脚本只看 `RC=0` 就宣布「插件已注册」，那是假绿。
    · `dsh plugin --profile web add` 硬依赖系统 pnpm，干净机默认没有。
    · Waylay 注入器需要 VC++ 2015-2022 运行库；缺 DLL 时弹窗后静默退出。
    · 发行包里的 Waylay 运行时是**单独的发行件**（Apache-2.0），本仓库不打包
      第三方二进制；脚本只检查它在不在，不代替用户装第三方件。

  刻意**不**做的事：
    · 不填 QQ 号、不写任何凭据、不写含本机绝对路径的 cordis.patch.yml
      （那份配置随包发布会泄露作者机器信息，见 docs/CLEAN-INSTALL.md）
    · 不静默安装 VC++ Redistributable（会弹 UAC；VM 实测静默安装卡 240 秒）
    · 不动用户已有的 QQ 账号与登录态

.PARAMETER InstallDir
  插件安装位置，默认 $env:USERPROFILE\dsh-qq-onebot-bridge

.PARAMETER DshVersion
  要装的 DSH 版本，默认 0.2.2-rc.1（真实用户当前最新版本）。

.PARAMETER NodeVersion
  Node 官方 MSI 版本，默认 24.22.2（VM 实测可用的 24 LTS）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
#>
[CmdletBinding()]
param(
  [string]$InstallDir = "$env:USERPROFILE\dsh-qq-onebot-bridge",
  [string]$RepoUrl = "https://github.com/mkiea/qq-integration.git",
  [string]$Profile = "web",
  [string]$DshVersion = "0.2.2-rc.1",
  [string]$NodeVersion = "24.22.2"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Say([string]$msg, [string]$kind = "info") {
  $prefix = switch ($kind) { "ok" { "[OK]  " } "warn" { "[!]   " } "fail" { "[X]   " } default { "[..]  " } }
  $color = switch ($kind) { "ok" { "Green" } "warn" { "Yellow" } "fail" { "Red" } default { "Gray" } }
  Write-Host "$prefix$msg" -ForegroundColor $color
}
function Have([string]$cmd) { $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue) }
function Out([object[]]$lines) { ($lines | Out-String).Trim() }
function RefreshPath {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

Say "QQ 桥插件 · Windows 安装"
Say "安装目录: $InstallDir   DSH: $DshVersion   Node MSI: $NodeVersion"
Write-Host ""

# ---------------------------------------------------------------- 0. 环境
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) { Say "以管理员运行" "ok" } else { Say "非管理员：全局 npm / MSI 安装可能失败，建议右键「以管理员身份运行」" "warn" }

try {
  $null = Invoke-WebRequest -Uri "https://registry.npmjs.org/" -TimeoutSec 10 -UseBasicParsing
  Say "网络可达（npmjs）" "ok"
} catch {
  Say "连不上 registry.npmjs.org —— 先解决网络/代理再跑本脚本" "fail"
  exit 1
}

# ---------------------------------------------------------------- 1. Node（按官方 engines 判，不再写死 >=20）
$minNode = [version]"24.9.0"
if (Have "npm") {
  try {
    $engineRaw = Out @(& npm view "@deepseek-ai/dsh@$DshVersion" engines.node --json 2>&1)
    if ($engineRaw -match '(\d+)\.(\d+)\.(\d+)') {
      $minNode = [version]$Matches[0]
      Say "DSH $DshVersion 官方 engines.node = $engineRaw ⇒ 需要 Node >= $minNode" "ok"
    } else {
      Say "npm 没给出 engines.node，按已知下限 $minNode 继续（这是 VM 实测值，不是官方声明）" "warn"
    }
  } catch {
    Say "查不到官方 engines.node，按已知下限 $minNode 继续" "warn"
  }
}

$needNode = $true
if (Have "node") {
  $raw = (Out @(& node -v)) -replace '^v', ''
  try {
    $cur = [version]($raw -replace '-.*$', '')
    if ($cur -ge $minNode) { Say "Node 已是 v$raw（>= $minNode）" "ok"; $needNode = $false }
    else { Say "Node v$raw 太旧（DSH 需要 >= $minNode）；旧版下 dsh 会静默退出" "warn" }
  } catch { Say "读不懂 node -v 的输出：$raw" "warn" }
}

if ($needNode) {
  Say "下载官方 Node v$NodeVersion MSI 并安装"
  $msi = Join-Path $env:TEMP "node-v$NodeVersion-x64.msi"
  Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-x64.msi" -OutFile $msi
  Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart" -Wait
  RefreshPath
  if (-not (Have "node")) { Say "装完仍找不到 node —— 重开一个终端再跑本脚本" "fail"; exit 1 }
  $raw = (Out @(& node -v)) -replace '^v', ''
  Say "Node 现在可用: v$raw" "ok"
  try {
    if ([version]($raw -replace '-.*$', '') -lt $minNode) {
      Say "装完仍是 v$raw < $minNode —— 把 -NodeVersion 指向更高版本再跑" "fail"; exit 1
    }
  } catch { }
}

# ---------------------------------------------------------------- 2. DSH（真结果判据：CLI 必须吐出版本号）
$dshOut = ""
if (Have "dsh") { $dshOut = Out @(& dsh --version 2>&1) }
if ($dshOut -ne "") {
  Say "DSH 已安装: $dshOut" "ok"
} else {
  if (Have "dsh") { Say "dsh --version 零输出 —— Node 版本不够时的典型症状，重装一次" "warn" }
  Say "安装 @deepseek-ai/dsh@$DshVersion（全局依赖较多，实测约 10 分钟，别中途 Ctrl+C）"
  & npm install -g "@deepseek-ai/dsh@$DshVersion" --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Say "npm 安装失败（看上面的报错）" "fail"; exit 1 }
  RefreshPath
  $dshOut = Out @(& dsh --version 2>&1)
  if ($dshOut -eq "") {
    Say "重装后 dsh --version 仍然零输出。别继续：后面所有 dsh 子命令都会假成功。" "fail"
    Say "检查 node -v 是否 >= $minNode，并把这次的完整输出贴给维护者。" "warn"
    exit 1
  }
  Say "DSH 安装完成: $dshOut" "ok"
}

# ---------------------------------------------------------------- 3. pnpm（plugin add 的硬依赖）
if (-not (Have "pnpm")) {
  Say "装 pnpm（dsh plugin add 会直接调用系统 pnpm）"
  & npm install -g pnpm --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Say "pnpm 安装失败" "fail"; exit 1 }
  RefreshPath
}
$pnpmOut = Out @(& pnpm --version 2>&1)
if ($pnpmOut -eq "") {
  Say "pnpm --version 没输出（corepack 首次联网拉包常卡住）；改用 npm i -g pnpm 或带一份便携 pnpm" "fail"
  exit 1
}
Say "pnpm 可用: $pnpmOut" "ok"

# ---------------------------------------------------------------- 4. 本插件
Say "准备插件目录"
if (Test-Path (Join-Path $InstallDir ".git")) {
  Say "已存在仓库，执行 git pull"
  Push-Location $InstallDir; & git pull --ff-only; Pop-Location
} elseif (Test-Path $InstallDir) {
  Say "$InstallDir 已存在但不是 git 仓库 —— 先自行处理（或删空目录后重跑）" "fail"; exit 1
} else {
  if (Have "git") {
    & git clone $RepoUrl $InstallDir
    if ($LASTEXITCODE -ne 0) { Say "clone 失败（私有仓库需要先配置凭据）" "fail"; exit 1 }
    Say "已 clone 到 $InstallDir" "ok"
  } else {
    Say "没有 git：请装 Git，或把发行包 zip 解到 $InstallDir 后把 RepoUrl 留空重跑" "fail"
    exit 1
  }
}

# ---------------------------------------------------------------- 5. 注册插件（判据是产物，不是退出码）
Say "注册插件到 DSH profile「$Profile」"
Push-Location $InstallDir
& dsh plugin --profile $Profile add $InstallDir
$addCode = $LASTEXITCODE
Pop-Location

$dshHome = if ($env:DSH_HOME -and $env:DSH_HOME.Trim() -ne "") { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
$profileDir = Join-Path $dshHome "profiles\$Profile"
$patchFile = Join-Path $profileDir "cordis.patch.yml"
$profilePkg = Join-Path $profileDir "package.json"
$realOk = $addCode -eq 0 -and (Test-Path $patchFile) -and (Test-Path $profilePkg)
if ($realOk) {
  # PS 5.1 的 Get-Content -Raw 默认按 ANSI 读；UTF-8 without BOM 的 package.json 会读坏。
  $pkgText = Get-Content -LiteralPath $profilePkg -Raw -Encoding UTF8
  $realOk = $pkgText -match "dsh-qq-onebot-bridge"
}
if (-not $realOk) {
  Say "注册没有真正落地：exit=$addCode，patch=$([bool](Test-Path $patchFile))，profile package.json=$([bool](Test-Path $profilePkg))" "fail"
  Say "★ 别把 exit 0 当成功：Node 22 + dsh 0.2.2 的组合会 exit 0、零输出、一个文件都不建。" "warn"
  exit 1
}
Say "插件已注册（profile 依赖 + patch 文件都已核实）" "ok"

# ---------------------------------------------------------------- 6. 干净机前置体检（与控制台一键体检同一份量具）
$preflight = Join-Path $InstallDir "launcher\preflight.mjs"
if (Test-Path $preflight) {
  Say "跑一次干净机前置体检（只读）"
  & node $preflight
  if ($LASTEXITCODE -ne 0) { Say "体检有硬失败；按上面给的命令处理完，再双击「一键启动.bat」" "warn" }
} else {
  Say "没找到 launcher\preflight.mjs —— 你可能装的是旧包" "warn"
}

# ---------------------------------------------------------------- 7. 下一步
Write-Host ""
Say "安装部分完成。接下来是**需要你自己填/自己装**的：" "warn"
Write-Host @"

  1) 最小配置（只写占位数字，不要贴作者的配置）：
       $patchFile

       - id: dsh-qq-onebot-bridge
         config:
           botQq: 100000001          # ← 机器人 QQ 号
           allowUsers: [100000001]   # ← 你自己的号（空列表 = 全部拒绝）
           allowGroups: [100000002]  # ← 要服务的群
           dataDir: ''               # 空 = 跟宿主工作目录

  2) 第三方发行件（仓库里没有，也不该有）：
       · QQNT Windows 客户端   https://im.qq.com/pcqq
       · Waylay 运行时 rin-inject\（Apache-2.0）
         解压到 $InstallDir\rin-inject，或与插件目录并列；
         一键启动/控制台会自动探测，也可在 qq-control.json 里填 waylayBat。
       · 如果体检报 VC++ 运行库缺失：装官方
         https://aka.ms/vs/17/release/vc_redist.x64.exe
         别用「从别的机器拷 DLL 侧加载」当正式修法（那只是 VM 测试绕路）。

  3) 双击 $InstallDir\一键启动.bat
     它会先体检、再起控制台、再按 Waylay → DSH 宿主的顺序拉起全链路。
     只想看状态：  node $InstallDir\tools\doctor.mjs

  4) 验证判据（顺序别反）：
       netstat -ano | findstr :6700        # 有 ESTABLISHED 才算接上了
       控制台「概览」看 13000 /api/status 的 logged_in = true   # 端口在听 ≠ 已登录

  干净机完整实测记录：docs/CLEAN-INSTALL.md
"@ -ForegroundColor Cyan

Say "完成" "ok"
