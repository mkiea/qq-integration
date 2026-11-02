# bridge.js 拆解方案

现状（2026-11-02 晚，搬完第一块之后）：**12,519 行 / 308 个方法**。
最大的几个方法：

| 行数 | 方法 | 说明 |
|---|---|---|
| 989 | `#onQqMessageInner` | 整条入站流水线（拦、解析、引用、卡片、记忆、投递） |
| 735 | `#handleOpsCommand` | 运维指令的实现体 |
| 389 | `constructor` | 大量配置默认值 |
| 292 | `#resolveQuoted` | 引用解析（文字/图/语音/卡片/转发/嵌套） |
| 263 | `#watchVideoFromUrl` | 看视频（下载、抽帧、字幕、总结） |
| 223 | `#onSessionEvent` | 会话事件 |

## 原则（三条，顺序不能反）

1. **先有测试，再动刀。** 每块搬之前必须先有"特征测试"：给定输入，断言**当前输出**（哪怕输出不理想）。
   没有特征测试的搬迁，等于用"我看了一遍"代替验证。
2. **机械搬迁，不改逻辑。** 一次只搬一块，搬完立刻跑该块的套件；红了就回滚，不在红的状态下继续搬。
3. **私有成员出不去。** `#x` 在类外拿不到，所以搬迁必须**显式传依赖**（见 `lib/admin-extras.js` 的 `deps`），
   不许为了省事把方法改成 public —— 那等于用可见性换方便。

## 顺序（按"依赖薄 → 依赖厚"排）

| 序号 | 目标 | 行数 | 依赖 | 风险 | 验收 |
|---|---|---|---|---|---|
| ✅ 1 | `!probe` / `!sessions` / `!qa` → `lib/admin-extras.js` | 166 | socket / callAction / config / sessionStore / dataRoot / workspaceRegistry | 低 | probe-unit、sessions-admin-unit、qa-admin-unit |
| 2 | `#resolveQuoted` → `lib/quote.js` | 292 | server.getMsg、下载、图片块、`oneLine`、config | 中 | **先补**引用特征测试（现有 quote-fallback-unit 只覆盖兜底） |
| 3 | `constructor` 的默认值 → `lib/config-defaults.js` | ~300 | 无（纯数据） | 低 | 配置相关套件 + 一次真机启动比对 runtime 快照 |
| 4 | `#handleOpsCommand` → `lib/ops-commands.js` | 735 | 面板、日志、进程、配置 | 高 | 先把 ops-bridge-unit 里没覆盖的分支补上 |
| 5 | `#onQqMessageInner` → 拆成 `intake.js` / `dispatch.js` | 989 | 几乎所有东西 | **很高** | 需要一整套"输入帧 → 事件序列"的黄金样例（现在是日志，不是断言） |

**第 5 项不要轻易开始**：它是整条流水线，任何一处语义变化都会表现为"她说话怪了"，
而那种错在单测里看不出来。要做的话，先花时间把最近 200 条真实入站帧做成 golden 测试。

## 已建立的模式（照抄即可）

`lib/admin-extras.js` 是模板：模块导出一个 `handleXxx(input, deps)`，
**返回 `null` 表示"这条不是我管的"**，交回 bridge 继续判。
好处是搬运期间 bridge 的调用点只有一行，红了能一眼看出是新模块还是老逻辑。
