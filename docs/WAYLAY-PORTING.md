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

## 附：我们在本地 Waylay 副本上改过哪些（`_tmp/rin-inject/` 不受版本管理，这里是**改动清单**）

> 为什么单独记一份：真正生效的是 `_tmp/rin-inject/waylay-src/onebot/*.js`（注入到 QQ 进程里），
> 而那个目录被 `.gitignore` 排除了。换机器/清目录时，**这些改动会消失**。
> 这里只记"改了什么、为什么"，实现以工作副本为准。

### 1. `actions.js` — 合并转发（聊天记录）

- `get_forward_msg` 接受三个**扩展参数**：`msg_id` / `user_id` / `group_id`（OneBot v11 之外，别的实现忽略）。
- `fetchForwardList(resId, bridge, translator, depth, context)`：有 `context` 时走
  `getMultiMsg(peer, parentMsgId, msgId)`。
  - **顶层**：`(peer, X, X)` → `result=0`、`msgList` 非空
  - **嵌套**：`(peer, 外层X, 内层Y)` → 有内容；`(peer, Y, Y)` → `result=4 Data Not Existed`
    （Y 不是真消息，只是外层载荷里的子元素编号）
  - `peer.peerUid` 私聊必须是 **uid**（`u_xxx`，用 `eventTranslator.getUidByUin` 换），群聊传群号；
    传 QQ 号会 `result=4`，很容易误判成"消息过期"
- `expandForwardNodes` 每个 record 都调 `registerImagesOf`（转发里的图要登记，否则代理 404）。
- `registerImagesOf`：md5 缺失时从 `fileName` 反推、**统一小写**（代理 key 是小写）、
  路径依次试 `getRichMediaFilePathForGuild` / `getRichMediaFilePath` / `getImagePath`、
  失败打 `[img-reg]` 日志。

### 2. `message.js` — 图片段多带 `origin_url`

`pe.originImageUrl` 原来被代理 URL 覆盖后丢掉。现在两个都给：
`url`（本地代理）与 `origin_url`（原始 CDN）。桥先试 origin、失败再试 proxy
（origin 失败通常秒回，proxy 对未登记的 key 要等 **10 秒**）。

### 3. 已知未修（有证据、但没动）

`getImageFilePath` 的兜底会扫 `~/.config/QQ` 找图 —— 那是 **Linux 路径**，
Windows 上 QQ 数据在 `Documents/Tencent Files/<uin>/nt_qq/nt_data/Pic/`。
所以 Windows 上"登记"是唯一的路，登记不上的图必然 404。补 Windows 扫描要做成
**带索引的后台扫描**（每次请求现扫太慢），还没做。
