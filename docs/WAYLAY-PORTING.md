# 从 NapCat 移植能力到 Waylay：怎么做，以及哪些**做不了**

> 结论先说：**能移植的都已经移植了**；剩下几个卡在一个硬约束上 —— NapCat 有一层
> **packet 协议层**（`core.apis.WebApi` / `PacketApi`），Waylay 没有这层，只有内核服务。
> 这不是"抄过来就行"，是"要先把那一层造出来"。

## 移植的方法（三步，都可查证）

```bash
node tools/napcat-ref.mjs get_forward_msg      # 1. 看 NapCat 怎么实现
```

2. 看它依赖什么：`core.apis.MsgApi` / `WebApi` / `PacketApi`。
3. 拿本机的内核方法表核对有没有对应能力：

```bash
node -e "const j=require('./qq_chat/_debug/probe-__introspect-*.json')"   # 或直接看下面那张表
```

方法表是 `!probe __introspect` 打出来的（104 个 wrapper 类）。**只有第 3 步过关，才值得动手写。**

## 已经移植的（有真机或桩级证据）

| 能力 | 原来 | 现在 | 证据 |
|---|---|---|---|
| `get_forward_msg`（聊天记录） | 空壳 `{messages:[]}` | 用 `getMultiMsg` 取内容，支持嵌套 | 桩测：外层 2 条 + 内层展开 |
| `get_msg` 冷缓存回源 | 只查内存缓存 | `byMsgId → bySeq(5参) → bySeq3 → singleMsg → historyScan` | 真机 `kernel hit via=bySeq` |
| `get_friend/group_msg_history` | 空壳 | `getAioFirstViewLatestMsgs` / `getMsgsBySeqAndCount` | 桩测返回真实消息 |
| 图片本地代理 | 从没开过（`ONEBOT_WS_PORT=0`） | 开 6701 + 历史图登记 | 待重启验证（真机此前报 `invalid rkey`） |

## 移植不了的（附证据）

| action | NapCat 依赖 | 本机内核有没有 | 判断 |
|---|---|---|---|
| `get_group_file_url` | `PacketApi.pkt.operation.GetGroupFileUrl` | 无 packet 层；`NodeIKernelGroupService`(242 方法) 里没有 `getGroupFileUrl` | ❌ 需自建 packet |
| `get_essence_msg_list`（群精华） | `WebApi.getGroupEssenceMsgAll` | GroupService 里**没有** essence* 方法 | ❌ 需自建 packet |
| `get_group_honor_info`（群荣誉） | `WebApi.getGroupHonorInfo` | 同上，没有 honor* 方法 | ❌ 需自建 packet |
| `download_file` | 纯 HTTP（跟内核无关） | — | ⚠️ 可写，但**没用**：桥自己就会下载，实现了也是死代码 |

「需自建 packet」的意思是：得自己组 NTQQ 的 SSO 包（加密 + 序号 + 重放），
NapCat 的那层有几千行。为了"群精华列表"这种边缘功能做这件事，收益不划算。

## 如果以后真要做

先做**一条**最小验证：用 `getMsgsBySeqAndCount` 已经能拿到带 `msgSeq/msgRandom` 的消息，
而 NapCat 拿这些去换 msgId（`nt.createUniqueMsgId`）。也就是说 **packet 层不是唯一路**：
部分能力可以退回"用内核查得到的东西 + 本地拼"来做，只是拿不到 URL/精华这类**服务端才算得出来**的数据。

判断标准很简单：**数据在本地就有吗？**
- 有（消息、历史、图片缓存）⇒ 走内核，能移植，已移植。
- 没有（下载链接、精华、荣誉 —— 都要 QQ 服务端算）⇒ 必须有 packet 层，否则做不了。
