<#
.SYNOPSIS
  在**当前用户**桌面创建/刷新「QQ 集成接入」快捷方式（幂等）。

.DESCRIPTION
  为什么要有它：发行包解压后，用户拿到的是一个文件夹；要求他每次进到
  `qq-integration\` 里双击 `.bat` 不现实。首次运行时自动放一个桌面入口，
  之后双击桌面图标即可。

  三条约束（都是踩过的）：
    · **幂等**：重复运行只覆盖同一个 .lnk，不会堆出「快捷方式 (2).lnk」；
    · **不阻塞启动**：拿不到桌面（无 Desktop 目录 / 组策略重定向失败）时只报错，
      绝不 `exit 1` 把启动流程带停 —— 快捷方式是便利，不是前置条件；
    · **不写注册表、不请求管理员**：只往 `[Environment]::GetFolderPath('Desktop')` 写一个文件，
      这样 OneDrive 重定向桌面、多用户机器都能落到"这个用户看得见"的位置。

  参数都是显式传入的（`%~f0` / `%~dp0`），脚本里不写死任何机器路径。

.PARAMETER TargetBat
  要指向的启动脚本（调用方传 `%~f0`，即正在运行的那个 .bat 的绝对路径）。

.PARAMETER WorkDir
  快捷方式的「起始位置」（调用方传 `%~dp0`）。

.PARAMETER Name
  桌面图标显示名，默认「QQ 集成接入」。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File launcher\make-shortcut.ps1 -TargetBat "C:\x\一键启动.bat" -WorkDir "C:\x"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$TargetBat,
  [Parameter(Mandatory = $true)][string]$WorkDir,
  [string]$Name = 'QQ 集成接入'
)

$ErrorActionPreference = 'Stop'

try {
  if (-not (Test-Path -LiteralPath $TargetBat)) { throw "目标脚本不存在：$TargetBat" }
  if (-not (Test-Path -LiteralPath $WorkDir)) { throw "工作目录不存在：$WorkDir" }

  $desktop = [Environment]::GetFolderPath('Desktop')
  if ([string]::IsNullOrWhiteSpace($desktop)) { throw '拿不到桌面路径（GetFolderPath 返回空）' }
  if (-not (Test-Path -LiteralPath $desktop)) { throw "桌面目录不存在：$desktop" }

  $lnk = Join-Path $desktop ($Name + '.lnk')
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($lnk)
  $shortcut.TargetPath = $TargetBat
  $shortcut.WorkingDirectory = $WorkDir
  $shortcut.Description = 'QQ 集成接入 · 一键启动'
  $shortcut.WindowStyle = 1
  $shortcut.Save()

  # 读回来核一次：CreateShortcut + Save 失败时不一定抛异常，只看"文件在不在"会假绿。
  $check = $shell.CreateShortcut($lnk)
  Write-Output ("SHORTCUT=" + $lnk)
  Write-Output ("EXISTS=" + (Test-Path -LiteralPath $lnk))
  Write-Output ("TARGET_OK=" + ($check.TargetPath -eq $TargetBat))
  Write-Output ("WORKDIR_OK=" + ($check.WorkingDirectory.TrimEnd('\') -eq $WorkDir.TrimEnd('\')))
} catch {
  Write-Output ("SHORTCUT_FAIL=" + $_.Exception.Message)
  exit 1
}
