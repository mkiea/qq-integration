@echo off
title QQ 语音合成服务 (edge-tts :8977)
setlocal
rem 两个解释器都装了 edge-tts：优先用系统 Python（不随 WorkBuddy 升级而变），
rem 找不到时回退到 WorkBuddy 自带的那个。
set "SYSPY=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
set "WBPY=%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe"
if exist "%SYSPY%" (
  set "PY=%SYSPY%"
) else if exist "%WBPY%" (
  set "PY=%WBPY%"
) else (
  echo 没找到 Python 解释器，无法启动。
  pause
  exit /b 1
)
echo 用 %PY% 启动语音服务，端口 8977
echo 关掉这个窗口 = 停止语音服务（机器人会退回只发文字）
echo.
"%PY%" "%~dp0server.py" --port 8977
echo.
echo 服务已退出。
pause
