# 配置文档缺口（2026-11-05 机械核对）

> 工具：`tools/verify-config-doc.mjs`（可复现）
> 方法：从 README 配置表抽「键 | 默认值」，从 `lib/index.js` 的 zod schema 抽实际默认值，逐项对比。
> **不抽样、不靠肉眼**；只比能机械判定的标量（数组/对象/多行值记「跳过」，不当成一致）。

## 一、核对结果

```
README 配置表 137 项 | schema 293 项
逐项比过 136 项 | 跳过（复杂值）1 项
默认值不一致：2 处 → 已修
schema 有、README 没写：157 项
```

**覆盖率 137/293 ≈ 47%**：有一半配置项在 README 里查不到。

## 二、已修的 2 处默认值不一致

| 键 | README 原值 | 代码实际 | 处理 |
|---|---|---|---|
| `memoryMaxEntries` | `30` | **`60`** | README 改为 60 |
| `voiceReadingEnabled` | `true` | **`false`** | README 改为 false |

> 这两个都是"读了会配错"的项：按 README 写 30，记忆窗口只有实际的一半；
> 按 README 以为默认开着语音朗读，实际是关的。

## 三、157 项未文档化（按域分组）

| 域 | 项数 | 关键项 |
|---|---|---|
| **主动通道** | 9 | `proactiveEnabled` `proactiveTickSeconds` `proactiveUsers` `proactiveDryRun` `oneSentencePerMessage` |
| **群运营** | 19 | `groupOpsEnabled` `nativeSignEnabled` `opsKickEnabled` `opsInvitePolicyEnabled` `requestSyncEnabled` `adminWatchEnabled` |
| **互动** | 18 | `engageEnabled` `pokeBackEnabled` `typingEnabled` `emojiLikeEnabled` `reactionStatsEnabled` `sendLikeEnabled` `markReadEnabled` |
| **视频/图片帧** | 15 | `cardVideoWatchEnabled` `videoFrameEnabled` `videoSpeechEnabled` `gifFrameExtract` `ffmpegPath` |
| **内容/卡片** | 10 | `cardLookEnabled` `ytDlpPath` `redPacketNotice` `biliCookie` `qqMediaCacheRoots` |
| **播报/推送** | 12 | `webhookEnabled` `broadcastEnabled` `notifyEnabled` `notifyPushUrl` |
| **自愈** | 4 | `autoHealEnabled` `autoHealCommand` `autoHealMaxPerHour` |
| **安全/出网** | 11 | `allowBrowserOrigin` `egressAllowHosts` `linkReadAllowAnyHost` `taintDryRunEnabled` `fileTransferEnabled` `inboundLocalPathRoots` |
| **记忆/摘要** | 3 | `memoryArchiveEntries` `groupMemoryPerSpeaker` `summaryEnabled` |
| **管理/权限** | 4 | `botQqAllowed` `adminUsers` `adminUins` `adminEnabled` |
| **语音** | 9 | `ttsBaseUrl` `ttsModel` `ttsAllowedHosts` `voiceToolEnabled` `sttProvider` |
| **其他/内部** | 43 | `forwardExpandEnabled` `historyQueryEnabled` `ocrEnabled` `groupFileEnabled` `voteEnabled` `todoEnabled` `hostStuckWarnMs` `ownedWaitPollMs` |

## 四、优先级（我的判断，不是事实）

| 级别 | 判据 | 例子 |
|---|---|---|
| 🔴 **该写** | 用户会主动想开的**功能开关** | `proactiveEnabled`（主动开口）、`groupOpsEnabled`（群运营）、`videoFrameEnabled`、`broadcastEnabled`、`autoHealEnabled` |
| 🟡 **该写** | 影响**安全/隐私**的 | `allowBrowserOrigin`、`egressAllowHosts`、`fileTransferEnabled`、`inboundLocalPathRoots`、`taintDryRunEnabled` |
| ⚪ **不必写** | 内部实现/调参 | `hostStuckWarnMs`、`ownedWaitPollMs`、`ownedForkAfterMs`、`sendIntervalMs`、`ignoreSelf` |

## 五、为什么会有这个缺口

按时间线看，README 配置表是**分批加的**：核心对话/语音/记忆类写得早且全，
后来快速加的功能（主动通道、群运营、视频、自愈、webhook）**只写了 schema 和 CHANGELOG，没回填 README**。

> 这不是"文档没写"，是**"新功能默认不进配置表"**这个习惯造成的。
> 建议：以后加配置项时，**同一个 commit 里**往 README 表格补一行 —— 工具 `verify-config-doc.mjs` 可以在 CI 里当门禁。
