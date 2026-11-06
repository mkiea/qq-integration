@echo off
chcp 65001 >nul
title QQ 集成接入 - 一键启动
cd /d "%~dp0"

rem ── 找 node.exe：PATH -> 常见安装位置 -> 便携版 -> 环境变量覆盖 ──
set "NODE_EXE="
where node >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%~dp0runtime\node24\node.exe" set "NODE_EXE=%~dp0runtime\node24\node.exe"
if not defined NODE_EXE if exist "%~dp0..\node24\node.exe" set "NODE_EXE=%~dp0..\node24\node.exe"
if not defined NODE_EXE if defined QQ_BRIDGE_NODE set "NODE_EXE=%QQ_BRIDGE_NODE%"
if not defined NODE_EXE (
  echo [x] 没找到 node.exe。装 Node 24 LTS，或把 QQ_BRIDGE_NODE 指到本机 node.exe。
  pause
  exit /b 1
)

echo [1/3] 启动前检查（Node / DSH / pnpm / VC++ / QQ / Waylay 运行时）
"%NODE_EXE%" "%~dp0launcher\preflight.mjs"
if errorlevel 1 (
  echo.
  echo [x] 前置检查有硬失败，已停下。修好上面列出的项再双击本文件。
  pause
  exit /b 1
)

echo [2/3] 启动控制台并拉起全链路（Waylay - DSH 宿主 - 可选本地语音）
echo     控制台窗口保持开着；关掉它不会影响已经起来的宿主。
echo.
"%NODE_EXE%" "%~dp0control\bin\qq-control.mjs" --open --start-all
if errorlevel 1 (
  echo.
  echo [x] 控制台退出时报错，见上面的输出。
  pause
)
