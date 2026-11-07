@echo off
chcp 65001 >nul
title QQ Integration - One-click start
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem Keep every `echo` in this file ASCII-only.
rem 2026-11-07 VM test: a Chinese echo line containing full-width punctuation
rem was split by cmd.exe under chcp 65001 and its tail ran as a command
rem ("... is not recognized"). The Node-based preflight prints Chinese safely,
rem so all localized text lives there instead of in this batch file.
rem ---------------------------------------------------------------------------

rem ---- find node.exe: PATH -> standard installs -> portable layouts -> override
set "NODE_EXE="
where node >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%~dp0runtime\node.exe" set "NODE_EXE=%~dp0runtime\node.exe"
if not defined NODE_EXE if exist "%~dp0runtime\node24\node.exe" set "NODE_EXE=%~dp0runtime\node24\node.exe"
if not defined NODE_EXE if exist "%~dp0..\node.exe" set "NODE_EXE=%~dp0..\node.exe"
if not defined NODE_EXE if exist "%~dp0..\node24\node.exe" set "NODE_EXE=%~dp0..\node24\node.exe"
if not defined NODE_EXE if exist "%~dp0..\..\node.exe" set "NODE_EXE=%~dp0..\..\node.exe"
if not defined NODE_EXE if exist "%~dp0..\..\node24\node.exe" set "NODE_EXE=%~dp0..\..\node24\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\nodejs\node.exe" set "NODE_EXE=%USERPROFILE%\nodejs\node.exe"
if not defined NODE_EXE if defined QQ_BRIDGE_NODE set "NODE_EXE=%QQ_BRIDGE_NODE%"
if not defined NODE_EXE (
  echo [x] Node.js not found.
  echo     Checked: PATH, Program Files\nodejs, plugin dir, and two levels up.
  echo     Install Node 24 LTS, or point QQ_BRIDGE_NODE at your node.exe:
  echo       set QQ_BRIDGE_NODE=D:\somewhere\node.exe
  pause
  exit /b 1
)

echo [1/3] Preflight: Node / DSH CLI / pnpm / VC++ runtime / QQ / Waylay runtime
echo       node = %NODE_EXE%
"%NODE_EXE%" "%~dp0launcher\preflight.mjs"
if errorlevel 1 (
  echo.
  echo [x] Preflight reported hard failures. Fix the items above, then run again.
  pause
  exit /b 1
)

echo [2/3] Starting console and the full chain: Waylay - DSH host - optional TTS
echo       Keep this window open. Closing it does NOT stop the host.
echo.
"%NODE_EXE%" "%~dp0control\bin\qq-control.mjs" --open --start-all
if errorlevel 1 (
  echo.
  echo [x] Console exited with an error. See the output above.
  pause
)
