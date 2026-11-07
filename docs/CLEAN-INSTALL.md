# 干净机安装实录（2026-11-06，Win11 虚拟机）

> 这不是从 README 抄出来的「应该这么装」，是**在一台没有 Guest Additions、没有 D 盘、
> 没有 QQ / DSH / Node 24 / pnpm 的 Win11 虚拟机里，真机下载安装并打通链路**的记录。
> 数字都来自 `_tmp/vm-report.log` 与 VM 回传的日志，未做的部分明确写在最后一节。

## 0. 这次到底验的是什么

【事实】验的是「别人拿到发行包，从零装到自己电脑上能不能跑」，不是宿主已有生产链路自测。
宿主与 VM 通过 NAT 下的 `http://10.0.2.2:8900` 传文件、用 `/report?line=` 回传结果；
没有 Guest Additions，所以没有用 guestcontrol，也没有依赖共享剪贴板。

【意见】这一步不能省：宿主上 `doctor --json` 18/18 全绿只证明**这台机器**没事，
不证明部署包在干净机上能装起来。

## 1. 实测链路与结果

| 步骤 | 真实产物 / 判据 |
|---|---|
| 下载 QQ | `QQ_9.9.36_260924_x64_01.exe` 330,446,512 B；`/S` 静默安装 `RC=0`；版本 `9.9.36.53644-aff854e8` |
| 下载部署包 | `qq-integration-deploy.zip` 8,230,058 B / 3,409 条目；解压 3,397 文件 |
| 下载 Waylay 运行时 | `rin-inject.zip` 186,479 B / 57 条目（含 `waylay-src/`、`shell/` 三个注入原语、`node_modules/ws`） |
| Node | 官方便携 `node-v24.22.2-win-x64.zip` 37,754,834 B → `node -v = v24.22.2` |
| DSH | `npm i -g @deepseek-ai/dsh@0.2.2-rc.1`：`NPM_FINISH_SEC=598.9`、`changed 652 packages in 10m` |
| 插件注册 | `WEB_DEPS=dsh-qq-onebot-bridge`；`WEB_BUNDLES=...`；`cordis.patch.yml` 217 B 最小模板 |
| 起宿主 | `PORT_3080=1`、`PORT_6700=1` |
| 起 Waylay | `PORT_13000=1`、`PORT_6701=1`、`PORT_6099=0`、`WS_6700_CONNS=2`、`QQ_PROCESSES=3` |
| 日志证据 | `[onebot] Reverse WS connected to ws://127.0.0.1:6700/`、`[bridge] Login service connected, waiting for login...`、`[ui] login QR → http://0.0.0.0:13000/qrcode` |
| 二维码 | 回传 base64 还原成 147×147 PNG（592 B），三个定位角齐全 |

**`6099=0` 是硬判据**：NapCat 本体没有加载。Waylay 只借了
`NapCatWinBootMain.exe`(34 KB) + `NapCatWinBootHook.dll`(21 KB) 两个注入原语，
`RIN_MODE=waylay` 走的是 `waylay-src/index.js`。`6700` 是本插件自己监听的反向 WS 端口，
不是「6700 的 NapCat」。

## 2. 七个「不报错但装不上」的坑（本次补丁就是为它们加的闸）

### ① Node 22 + DSH 0.2.2-rc.1 ⇒ CLI 静默退出
【事实】`npm view @deepseek-ai/dsh@0.2.2-rc.1` 的 `package.json` 写着 `engines.node: ">=24.9.0"`。
VM 初始 Node 22.14.0 下，`--help / -h / version / plugin / --version / web --help`
**全部 `RC=0` 且零行输出**；`dsh plugin --profile web add` 也是 `RC=0`、零输出、
`~/.dsh` 目录被建但 0 文件、`cordis.patch.yml` 不存在、3080/6700 无监听。
2×2 交叉 A/B（新/旧 Node × 新/旧 `bin.js`）证明**只由解释器决定**，与 bin 副本无关。

【修法】`launcher/preflight.mjs` 与 `tools/doctor.mjs` 共用 `lib/env-preflight.js`：
`dsh --version` 零输出即判 FAIL，并读已装 DSH 的 `engines.node` 与当前 Node 比较
（不写死全局门槛，因为宿主装的 0.2.1-rc.3 就没声明 engines）。

### ② `dsh plugin add` 硬依赖系统 pnpm
【事实】Node 24 下真 CLI 会先打印 `initialized profile web`，随后
`'pnpm' 不是内部或外部命令`、`exit 1`。`corepack enable pnpm` 能生成 `pnpm.cmd`，
但 `pnpm --version` 首次联网拉包在 VM 上卡住；最终从宿主下发自包含 pnpm 11.8.0 +
手写 `pnpm.cmd` shim 才成功。

【修法】安装脚本显式装 `npm i -g pnpm` 并验 `--version`；体检把「插件未注册 + 无 pnpm」
判为硬失败。

### ③ VC++ 运行库缺失
【事实】注入器启动后弹 `MSVCP140.dll` / `VCRUNTIME140.dll` 缺失框，进程消失，
13000 永远不监听。官方 `vc_redist.x64.exe /install /quiet /norestart` 在 VM 卡 240 s
（疑似 UAC）。测试时用宿主 `System32` 的 20 个运行时 DLL **侧加载**到注入器 exe 同目录绕过，
`PORT_13000` 才起来。

🔴【意见】侧加载只是测试绕路，**不能当正式修法**。正式发行必须声明并引导用户安装
官方 VC++ 2015-2022 Redistributable x64。

### ④ QQ 版本与官方直链
【事实】宿主 `QQ.exe` 是 `9.9.36.53644`；官方 `windowsConfig.js` 当前给 `9.9.37`，
但那个 x64 直链用 curl 带 UA/Referer、GET/HEAD/Range 全部 403；
同域旧版能 206，`dldir1.qq.com` 的 NT 路径 404。Waylay 对 QQNT 版本敏感，
所以本次用了与宿主验证过的 9.9.36 安装包。

### ⑤ 部署包里没有启动器 / Waylay 运行时
【事实】第一版 `qq-integration-deploy.zip` 3,409 条目里：
`rin-waylay.bat` 0、`rin-launch.bat` 0、`rin-loader.js` 0、`waylay-src` 0、
`NapCatWinBoot*` 0、`launcher` 0；唯一的 `.bat` 是 `control/启动控制台.bat`，
而它只起 8880 控制台。README 写「Waylay 本体与注入 DLL（由用户自行安装）」，
`install-windows.ps1` 也明确「不动 QQ / Waylay / NapCat」。

【修法】根目录新增 `一键启动.bat`（体检 → 控制台 → `--start-all`）；
`lib/waylay-launch.js` 新增 `waylayRuntimeCandidates()` 认发行版布局；
Waylay 运行时作为**单独的发行件**随发行版提供（不塞进仓库，见 `NOTICE.md`）。

### ⑥ 宿主配置不能随包发布
【事实】宿主 `profiles/web/cordis.patch.yml` 18,524 B / 287 行，含 6 处本机绝对路径、
19 处长数字、7 处 `apiKey` 字样、37 处 `qq` 字样。整份拷进发行包会泄露作者机器与凭据形态。

【修法】发行版只带 217 B 的最小模板 `[]`；`scripts/install-windows.ps1` 与本文档给的是
**占位数字**的最小片段，不写任何真实 QQ 号 / key / 绝对路径。

### ⑦ 控制台找不到 `dshBin`（Waylay 起来了也没有宿主接消息）
【事实】2026-11-07 用重建后的包复验：`PREFLIGHT_RC=0`（六项全绿）、
`CONFIG_WAYLAYBAT=C:\Users\user\real-install-v6\rin-inject\rin-waylay.bat`（兄弟目录自动探测成立），
但 **`CONFIG_DSHBIN=` 是空的**。控制台「启动宿主」因此会直接报「未配置 nodeExe / dshBin」。

【真因】`control/lib/config.mjs` 的候选表只有 npx 缓存与 DSH Desktop，没有
「官方 zip 解压出来的便携 Node」——`<node>\node_modules\@deepseek-ai\dsh\lib\bin.js`，
而那是干净机上最常见的一种装法（npm 全局前缀就是 node 自己的目录）。

【修法】新增纯函数 `dshBinCandidates({ execPath, env })`（`<node>\node_modules`、
`<node>\..\lib\node_modules`、`%APPDATA%\npm\node_modules`），
预检再加第 7 项「控制台能启动宿主（bin.js）」；启动器与 `tools/doctor.mjs` 都改走
`loadControlConfig()`，先读 `qq-control.json` 再自动探测（手填过的机器不会被打回）。

## 3. 凭据最小化（本次真实做法）

只下发一份一次性 YAML，含 `refs/DEEPSEEK_API_KEY` 一个值（35 字符）；
不带 `browser-session/secret`、平台 token、设备 id；值没有写进任何回传日志；
宿主那份 `vmcred-*.yaml` 用完即删。

## 4. 最小配置片段（占位数字，别直接抄去用）

```yaml
- id: dsh-qq-onebot-bridge
  config:
    botQq: 100000001          # 机器人 QQ 号
    allowUsers: [100000001]   # 你自己的号；空列表 = 全部拒绝
    allowGroups: [100000002]  # 要服务的群
    dataDir: ''               # 空 = 跟宿主工作目录
```

## 5. 建议的验证顺序（别反）

1. `node launcher/preflight.mjs` —— 没有硬失败；
2. `node tools/doctor.mjs --install` —— 安装区没有 FAIL；
3. 双击 `一键启动.bat` —— 逐步打印 Waylay / DSH 宿主结果；
4. `netstat -ano | findstr :6700` —— 有 **ESTABLISHED** 才算接上；
5. `http://127.0.0.1:13000/api/status` 的 `logged_in=true` —— **端口在听 ≠ 能收发**；
6. 真发一条 QQ 消息，看 `qq-trace.jsonl` 走完各阶段。

## 6. 还没做完的（不要当成已通过）

> 这一节按 **2026-11-07 傍晚**的实测重写。11-06 版里「QQ 没登录、消息没跑通、
> 119 绿 / 5 红」三句**已经过期**，别再用。

**已经在干净机上验过的（有回传 / 截图证据）**

- ✅ **真实 QQ 登录 + 消息全链**（11-07 12:39）：`logged_in=True`、`REVERSE_CLIENTS=1`、
  `WS6700_EST=2`、`6099=0`，trace 走完 `inbound → whitelist → model → agent → reply`；
  陌生人加好友被 `allowUsers` 正确拦下。
- ✅ **发行包的版本戳**：解压后 `RELEASE-MANIFEST.txt` 里能直接读到
  `release-tag=v0.1.0-rc3`、`release-commit=bd101c4`、`release-built-at=…`
  （记事本打开，1,030 字符，UTF-8）。
- ✅ **第二次双击认出自己**：干净机先起控制台，再跑一次 `qq-control.mjs` ⇒
  **`RESULT=OK`**（退出码 0），不再报「端口被占用」。
- ✅ **全量测试**：`128 套件 / 0 红 / 0 卡死 / 5,474 断言`。

**仍然没验 / 有风险（正式版请看这几条）**

- ⚠️ **只有 1 台 VM（n=1）**，且是管理员账户、英文用户名、默认盘符、无杀软拦截。
  **非管理员 / 中文用户名 / 非默认盘 / 杀软** 这四类没验。
- ⚠️ **VC++ 运行库是官方 redist 还是早先侧加载留下的，没有取证**。干净机真缺时
  `preflight` 会 FAIL 并给下载指引，但「装完 redist 能不能起」没验过。
- ⚠️ **QQ 官网 9.9.37 直链 403**（Lego CDN 侧拒），本次用 9.9.36；官方最新版路径未验。
- ⚠️ **群聊 @、图片/GIF、语音、记忆长跑、被顶号重连**：功能本身有单测，但没在
  干净机上跑过真实链路。
- ⚠️ **换号重放守卫与新增的五个面板项**（v0.1.1）：只在单测（18 条）和宿主侧验过，
  **VM 干净机上还没跑**——验证它需要重启宿主并重新扫码登录，会影响当前会话。
- ⚠️ **GitHub Release 页面仍建不了**：`gh` 不存在、`api.github.com` 直连/代理
  `HTTP=000`（`git ls-remote` 通）。发行靠本地 `release-v0.1.1` 目录 + tag。

> `v0.1.0` 与 `v0.1.0-rc3` 的**代码完全相同**，只是 tag 名不同；
> 上面打勾的验证是在 rc3 上做的。
