# NOTICE —— 来源、集成关系与改动声明

## 一句话定位

本包是**集成插件**，不是 QQ 协议实现：它把三样外部件接起来——

```
OneBot 实现（Waylay / NapCat / LLOneBot / OpenShamrock / Lagrange / go-cqhttp）
        │  反向 WebSocket
        ▼
本插件 dsh-qq-onebot-bridge（OneBot v11 传输层 + 会话编排 + 控制台）
        │  ctx.agents.create / followup
        ▼
DSH agent 会话
```

**本仓库不含 QQ 协议代码，也不打包任何第三方二进制。**

## 一、衍生来源（上游 MIT）

本包是 **`dsh-qq-onebot-bridge` 的衍生版本**，不是从零编写。

- 上游：`git+https://github.com/cheesehaqi/dsh-qq-onebot-bridge.git`
- 本衍生版基于的提交：`c59ca8fefed18e3d3e320aa8e8923ff1f2d33110`（上游版本 0.7.22）
- 上游许可证：MIT（见 `LICENSE`，**原文保留未改**，上游版权行也未改写）

上游实现的那部分，本包**照搬并继续维护**：OneBot v11 反向 WebSocket 传输层
（`lib/onebot.js`：事件分发、action 调用、@ 解析、合并转发）、大量群功能模块
（播报 / 订阅源 / 归档检索 / 积分 / 群成员画像 / 入站 webhook 等）、以及控制台的骨架。

### 为什么衍生

上游是通用的 QQ ↔ DSH agent 桥，功能面很宽。本项目只需要"一个能和 QQ 上的角色说话、
并且**能被调试**的桥"，所以：

1. 去掉与本项目无关的功能模块；
2. 用 **Waylay** 替换 NapCat 作为 QQ 接入端（NapCat 已于 2026-10-30 退场）；
3. 版本号从 `0.1.0` 重新起算 —— **不再沿用上游 0.7.x 的版本线**，避免与上游混淆。

## 二、复用的 OneBot 代码边界

- **复用**：OneBot v11 的**传输与调用约定**——反向 WS 握手、事件 JSON 结构、
  `send_group_msg` / `get_msg` / `get_record` / `set_group_ban` 等 action 名与参数形状。
  这些名字来自真机静态探针（读 OneBot 实现的 `bootmain` 导出），不是为了兼容而猜的。
- **不包含**：QQ 登录、协议编解码、发包收包。那些在 OneBot 实现里，本包一行都没有。
- 因此：**换一个 OneBot 实现（只要说 v11）本包照样能用**——它认的是协议，不是某个实现。

## 三、内置 Waylay 集成的边界

「内置 Waylay」指的是**拉起 / 停止 / 状态读取**这三件事做进了控制台与面板，**不是把 Waylay 打包进来**：

| 是本包的东西 | 不是本包的东西 |
|---|---|
| `lib/waylay-launch.js`：入口探测、命令行拼装、PID 反查、停止计划 | `rin-waylay.bat` / `rin-launch.bat`（用户侧安装） |
| 控制台 `/api/waylay`、`/api/waylay/start`、`/api/waylay/stop` | Waylay 本体与其注入 DLL（`NapCatWinBootHook.dll`） |
| 状态判据：**监听 13000 的进程就是被注入的那个 QQ** | 官方 `QQ.exe`（腾讯） |

三条与 NapCat 时代的根本差异（也是为什么不能只换个字符串）：

1. **没有独立进程**：Waylay 注入进 `QQ.exe` 内部运行，所以「停止」在物理上只能结束那个 QQ ——
   本包按**端口反查 PID**（只认 13000），并核对进程名是 QQ 系，**绝不按镜像名杀 QQ**；
2. **没有加载器候选表**：只有一个入口，不需要在 `launcher.bat` / `napcat.bat` 之间猜；
3. **没有 token**：13000 是裸 HTTP，`/api/status` 直接给 JSON，不拼 token 进 URL。

Waylay 的许可证与使用条款由它自己的作者规定，**本包不代替、也不转授**。
它属于第三方非官方客户端，使用风险见 `README.md` 末尾的「风险」一节。

## 四、MIT 要求

上游版权声明在 `LICENSE` 中完整保留。任何再分发都必须带上同一份 `LICENSE` 与本文件。

## 五、与上游的差异记录在哪

- `CHANGELOG.md` 里 v0.7.x 的条目是**上游历史 + 此前在 node_modules 里做的本地补丁**，保留作为参考；
  本包自己的版本从 `0.1.0` 开始，另起一节记。
- 上游 README 未随包提供（避免读者把本包当成上游发布）；本包 `README.md` 只写它自己的用法。
