<#
.SYNOPSIS
  Windows 一键安装：Node + DSH + QQ 桥插件

.DESCRIPTION
  面向"一台干净 Windows"的安装脚本。只做三件事，每步都先检查再做，失败不静默：
    1. 装 Node 20+（winget 优先，退回到官方 msi 下载）
    2. 装 DSH（npm 全局）
    3. 装本插件（git clone 或 zip 下载）

  刻意**不**做的事：
    · 不动 QQ / Waylay / NapCat（那是用户自己的账号与注入器，脚本无权代劳）
    · 不写任何凭据、不填 QQ 号（配置留给用户，脚本只提示该填什么）
    · 不装 Guest Additions 之类的宿主侧组件

.PARAMETER InstallDir
  插件安装位置，默认 $env:USERPROFILE\dsh-qq-onebot-bridge

.PARAMETER RepoUrl
  仓库地址，默认公开地址；私有仓库请自行替换并确保已有凭据

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
#>
[CmdletBinding()]
param(
  [string]$InstallDir = "$env:USERPROFILE\dsh-qq-onebot-bridge",
  [string]$RepoUrl = "https://github.com/mkiea/qq-integration.git",
  [string]$Profile = "web"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Say([string]$msg, [string]$kind = "info") {
  $prefix = switch ($kind) { "ok" { "[OK]  " } "warn" { "[!]   " } "fail" { "[X]   " } default { "[..]  " } }
  $color = switch ($kind) { "ok" { "Green" } "warn" { "Yellow" } "fail" { "Red" } default { "Gray" } }
  Write-Host "$prefix$msg" -ForegroundColor $color
}

function Have([string]$cmd) { $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue) }

Say "QQ 桥插件 · Windows 一键安装" 
Say "安装目录: $InstallDir"
Write-Host ""

# ---------------------------------------------------------------- 0. 环境检查
Say "检查环境"
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) { Say "以管理员运行" "ok" } else { Say "非管理员：全局 npm 安装可能失败，建议右键「以管理员身份运行」" "warn" }

try {
  $null = Invoke-WebRequest -Uri "https://registry.npmjs.org/" -TimeoutSec 8 -UseBasicParsing
  Say "网络可达（npmjs）" "ok"
} catch {
  Say "连不上 registry.npmjs.org —— 先解决网络/代理再跑本脚本" "fail"
  exit 1
}

# ---------------------------------------------------------------- 1. Node
Say "检查 Node"
$needNode = $true
if (Have "node") {
  $v = (& node -v) -replace '^v', ''
  $major = [int]($v -split '\.')[0]
  if ($major -ge 20) { Say "Node 已是 v$v" "ok"; $needNode = $false }
  else { Say "Node v$v 太旧（需要 20+）" "warn" }
}

if ($needNode) {
  Say "安装 Node LTS"
  if (Have "winget") {
    try {
      & winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
      Say "winget 安装完成（新开终端才生效）" "ok"
    } catch {
      Say "winget 失败: $($_.Exception.Message)" "warn"
    }
  } else {
    Say "没有 winget，改为下载官方 msi" "warn"
    $msi = Join-Path $env:TEMP "node-lts.msi"
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi" -OutFile $msi
    Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn" -Wait
    Say "msi 安装完成" "ok"
  }
  # 刷新本会话的 PATH，否则后面 npm 找不到
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not (Have "node")) { Say "装完仍找不到 node —— 重开一个终端再跑本脚本" "fail"; exit 1 }
  Say "Node 现在可用: $(& node -v)" "ok"
}

# ---------------------------------------------------------------- 2. DSH
Say "检查 DSH"
if (Have "dsh") {
  Say "DSH 已安装: $(& dsh --version 2>$null)" "ok"
} else {
  Say "安装 @deepseek-ai/dsh（可能要几分钟）"
  & npm install -g @deepseek-ai/dsh
  if ($LASTEXITCODE -ne 0) { Say "npm 安装失败（看上面的报错；常见原因：没有管理员权限 / 网络" "fail"; exit 1 }
  Say "DSH 安装完成" "ok"
}

# ---------------------------------------------------------------- 3. 本插件
Say "准备插件目录"
if (Test-Path (Join-Path $InstallDir ".git")) {
  Say "已存在仓库，执行 git pull"
  Push-Location $InstallDir; & git pull --ff-only; Pop-Location
} elseif (Test-Path $InstallDir) {
  Say "$InstallDir 已存在但不是 git 仓库 —— 先自行处理" "fail"; exit 1
} else {
  if (Have "git") {
    & git clone $RepoUrl $InstallDir
    if ($LASTEXITCODE -ne 0) { Say "clone 失败（私有仓库需要先配置凭据）" "fail"; exit 1 }
    Say "已 clone 到 $InstallDir" "ok"
  } else {
    Say "没有 git：请先装 Git，或手动下载仓库 zip 解到 $InstallDir" "fail"
    exit 1
  }
}

Say "注册插件到 DSH profile「$Profile」"
Push-Location $InstallDir
& dsh plugin --profile $Profile add $InstallDir
$addCode = $LASTEXITCODE
Pop-Location
if ($addCode -ne 0) { Say "dsh plugin add 失败（看上面输出）" "warn" } else { Say "插件已注册" "ok" }

# ---------------------------------------------------------------- 4. 下一步提示
Write-Host ""
Say "安装部分完成。接下来是**需要你自己填**的（脚本不代填）：" "warn"
Write-Host @"

  1) 编辑 profile 配置（不是仓库根目录那个 cordis.patch.yml）：
       $env:USERPROFILE\.dsh\profiles\$Profile\cordis.patch.yml

     最小片段：
       - id: dsh-qq-onebot-bridge
         config:
           botQq: 100000001          # ← 换成机器人的 QQ 号（占位数字）
           allowUsers: [100000001]   # ← 你自己的号（占位数字）
           allowGroups: [100000002]  # ← 要服务的群（占位数字）
           cwd: ''                   # 空 = 用默认数据目录

  2) 启动你的 OneBot 实现（Waylay / NapCat / LLOneBot 任一），
     让它反向连到 ws://127.0.0.1:6700/

  3) 启动宿主：
       dsh web --profile $Profile

  4) 验证（判据顺序很重要）：
       netstat -ano | findstr :6700     # 有 ESTABLISHED 才算接上了

  详细说明见仓库 README.md 与 docs/ONEBOT-COMPAT.md
"@ -ForegroundColor Cyan

Say "完成" "ok"
