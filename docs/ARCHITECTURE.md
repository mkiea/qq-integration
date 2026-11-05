# 架构（事实清单）

> 2026-11-05 整理。**每一条都经过实机验证或读源码确认**，不是凭记忆写的。
> 用途：我（助理）在讨论时容易把碎片讲串，这份文档是基准；主人也可以拿它纠正我。

---

## 一、进程与端口（实机验证）

| 进程 | 是什么 | 端口 | 谁监听 |
|---|---|---|---|
| **QQ.exe**（8 个进程） | 官方 NTQQ，机器人账号登在这里 | — | — |
| **NapCat**（在 QQ 进程内） | DLL 注入的 OneBot 实现，**不是独立程序** | — | — |
| **DSH 宿主**（Electron） | DeepSeek Harness，插件运行的地方 | **3080** | 它自己 |
| **桥**（插件） | `lib/bridge.js`，跑在 DSH 里，**不是独立进程** | **6700** | **桥**（反向 WS 的**服务端**） |
| **控制台**（node） | 独立进程，不依赖 DSH | **8880** | 它自己 |
| 本地 TTS（Python） | edge-tts 逐句合成，按需启动 | 8977 | 它自己 |
| Waylay 控制台 | 扫码登录页，可选 | 13000 | 它自己 |

### 最容易误解的一点

**6700 是桥在监听，NapCat 主动连上来**（反向 WebSocket 的语义）。

```
NapCat（QQ 进程内）──主动连接──▶ 桥（DSH 插件，:6700）
```

不是"NapCat 提供服务、桥去连它"。`netstat` 里 6700 的 LISTENING 属于 `node.exe`（桥），
`ESTABLISHED` 那条也由桥持有。

### 第二个易误解点

**3080 的监听 socket 在 `netstat` 里看不见**（DSH 桌面端在应用容器/子进程里）。
但 HTTP 请求有响应（401）。所以判断宿主死没死**不能用 netstat**，
要用 `curl --noproxy '*' http://127.0.0.1:3080/` 看有没有 HTTP 响应。

---

## 二、启动顺序（顺序错了会看到各种"没反应"）

```
① 退出 QQ（托盘也退）
② 跑 _tmp\rin-inject\rin-launch.bat     ← 注入 NapCat，6700 才出现
③ 启动 DeepSeek Harness（桌面端）       ← 3080 + 桥插件
④ （可选）启动控制台 control\启动控制台.bat
```

**Waylay 不是 DSH 面板里的按钮**，是独立 bat。它做的事：
`NapCatWinBootHook.dll` 读 `NAPCAT_PATCH_PACKAGE` 当模板、`NAPCAT_LOAD_PATH` 当目标，
把 `package.json` 的 `main` **在内存里**换掉 —— 磁盘不动，所以 QQ 的完整性校验不会触发。

---

## 三、代码分层

### 桥插件 `lib/`（59 个模块）

| 层 | 模块 | 职责 |
|---|---|---|
| **接入** | `onebot.js` | 反向 WS 协议、帧解析、连接管理 |
| | `history.js` | 最近消息查询（`get_group_msg_history`） |
| | `actions.js` | **写操作门禁**：禁言/踢人/撤回等高风险动作的准入 |
| **核心** | `bridge.js` | **13384 行 / lib 合计 32461 行**，一个类管所有会话：路由、会话映射、回合记账、记忆、闸门链、主动通道、语音编排 |
| | `index.js` | 插件入口（配置 schema + 生命周期） |
| | `chatlog.js` | 只读对话视图（把 memory 渲染成人看的） |
| **安全** | `egress.js` | 出网域名白名单（防 SSRF） |
| | `redact.js` | DLP 脱敏（密钥/身份证等） |
| | `taint.js` | 污点跟踪（不可信内容标记） |
| | `untrusted.js` | 不可信内容的围栏 |
| | `filter.js` | 敏感词过滤 |
| | `inbound-path.js` | 入站本地绝对路径准入（红队 L① 之后加的） |
| | `canary`（在 bridge 里） | 金丝雀：system prompt 里埋哨兵串，出站时校验 |
| **能力** | 语音 | `tts.js` `stt.js` `silk.js` `voice-path.js` |
| | 互动 | `dice.js` `fortune.js` `checkin.js` `games.js` `engage.js` |
| | 外部 | `bilibili.js` `imagegen.js` `mcping.js` `cardlook.js` `webtext.js` `videofetch.js` |
| | 群务 | `faces.js` `assets.js` `members.js` `grouptools.js` `forward.js` |
| | 播报 | `broadcast.js` `feed.js` `webhook.js` `webhookfmt.js` |
| **数据** | `archive.js` | 按天分片的消息归档 |
| | `inbox.js` | 入站记录（可复现） |
| | `store.js` `stats.js` | KV 存储 / 计数 |
| | `trace.js` `why.js` | 事件追踪 / "为什么没回" |
| **运维** | `panel.js` `admin-extras.js` | 面板数据 / 管理命令 |
| | `waylay-launch.js` | 注入器启动逻辑 |
| | `verify.js` `extension.js` `dir-pick.js` | 一致性校验 / 扩展接缝 / 选目录 |

### 控制台 `control/`（14 个模块，独立进程）

| 模块 | 职责 |
|---|---|
| `server.mjs` | HTTP 服务 + `x-control-token` 鉴权 + Origin 校验 |
| `supervisor.mjs` | 进程/端口监视（含 2026-11-05 加的 TCP probe 兜底） |
| `diagnose.mjs` `acceptance.mjs` | 诊断 / 验收检查项 |
| `perf.mjs` `staleness.mjs` | 性能面板 / 过期检测 |
| `replay.mjs` `replaydiff.mjs` `scenarios.mjs` | 回放 / 回放差异 / 场景 |
| `config.mjs` `redact.mjs` `trace.mjs` `zip.mjs` `open.mjs` | 配置 / 脱敏 / trace 读取 / 打包 / 打开 |

---

## 四、数据文件（`qq_chat/` 下）

| 文件 | 内容 | 谁写 |
|---|---|---|
| `qq-trace.jsonl` | **全部事件**（入站/回复/闸门/错误），排查主要看这个 | 桥 |
| `qq-inbox.jsonl` | 入站消息原文 | 桥 |
| `qq-sessions.json` | chatKey → DSH sessionId 映射 | 桥 |
| `qq-runtime.json` | 运行快照（uptime/会话数/登录状态），**控制台面板读它** | 桥 |
| `qq-proactive-state.json` | 主动开口的账（每日配额/欠条） | 桥 |
| `qq-canary.json` | 金丝雀串（泄露检测用，**换目录不搬等于洗白**） | 桥 |
| `qq-host-health.json` | 宿主健康 | 桥 |
| `qq-memory/<key>.json` | **每聊天的滚动记忆**：`{history[≤60], archive[≤400]}` | 桥 |
| `qq-voices/` | TTS 产物（`ttsDir`，发完 60 秒删）+ `songs/`（曲库，**不删**） | 桥 / 用户 |
| `qq-files/` `qq-images/` | 入站文件 / 图片 | 桥 |
| `qq-history/` | 归档分片（按天） | `archive.js` |

---

## 五、五条"我不会再讲错"的事实

1. **桥不是独立进程**，是 DSH 的插件；它死了通常意味着宿主也死了。
2. **NapCat 不是独立程序**，是注入进 QQ 的 DLL；QQ 一重启就要重新注入。
3. **6700 由桥监听**，NapCat 是客户端（反向 WS）。
4. **对话上下文完全在 DSH**，桥只传当前一条消息；桥只做"滚动记忆"（截断+归档，不总结）。
5. **控制台的 8880 是独立进程**，它能活着而宿主已经死了——这时页面能打开但没数据。
