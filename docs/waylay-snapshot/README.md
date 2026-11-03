# Waylay 改动快照（不是上游，仅供恢复与对照）

这三个文件是**当时真正在跑**的 Waylay 副本（注入进 QQ 进程的那一份），
不是从上游下载的原版，也不是可以直接 `npm install` 的包。

## 为什么放这里

真正生效的后端代码在 `_tmp/rin-inject/waylay-src/`，而 `_tmp` 被 `.gitignore` 排除。
换句话说：**换机器、清临时目录、重装注入器，里面那些修复就全没了** ——
包括 rkey 图片下载、合并转发的父 msgId、图片登记这些花了好几轮才试出来的东西。

上游的 Waylay 更新一次，我们的改动也要重打一次。所以：
- 文字说明（改了什么、为什么）在 [`../WAYLAY-PORTING.md`](../WAYLAY-PORTING.md) 的「附」一节；
- 代码的**完整生效版本**放这里，用来对照 / 逐个函数往回搬。

## 对应关系

| 这里的文件 | 在注入器里的位置 |
|---|---|
| `bridge.js` | `_tmp/rin-inject/waylay-src/bridge.js` |
| `onebot/actions.js` | `_tmp/rin-inject/waylay-src/onebot/actions.js` |
| `onebot/message.js` | `_tmp/rin-inject/waylay-src/onebot/message.js` |

其它文件（`server.js`、`adapter.js`、`events.js`、`listener.js`、`index.js` 等）我们没有改动，
所以不在这里 —— 需要时从上游取。

## 这三份里有哪些是我们加的（按文件）

**`onebot/actions.js`**
- `get_forward_msg` 接受扩展参数 `msg_id` / `user_id` / `group_id`
- `fetchForwardList(... context)`：`getMultiMsg(peer, parentMsgId, msgId)` 的三段式调用
  （顶层＝自己传自己；嵌套＝传外层 msgId）
- `expandForwardNodes`：整层并行下载、`registerImagesOf`、内嵌转发的父 id 传递
- `registerImagesOf`：md5 从 `fileName` 反推、统一小写、三个路径 API 兜底、失败打 `[img-reg]`
- `ensureImagesLocal`：`downloadRichMedia` + 等落地（**当前未启用**，原因见函数注释）
- `findLocalPic`：按 md5 在 `Documents/Tencent Files/<uin>/nt_qq/nt_data/Pic/<月>/Ori/` 找（有界）
- `getRkeyFor` / `attachRkeyToImages` / `RKEY_SERVERS`：图片 CDN 的 `&rkey=` 时效签名

**`onebot/message.js`**
- 图片段多带 `origin_url`（`pe.originImageUrl` 原来被代理 URL 覆盖后丢掉了）

**`bridge.js`**
- `_richMediaWaiters` / `waitRichMedia()` 与 `_onEvent` 里对
  `onRichMediaDownloadComplete` 的分发（等内核下载回调拿绝对路径）

## 怎么用

1. 需要恢复时：把这里的文件按上表覆盖回去，再重启 QQ（注入器在启动时读取）。
2. 上游更新后：不要整份覆盖。用 `docs/WAYLAY-PORTING.md` 的清单，
   逐条把上面这些函数搬到新版里 —— 整份覆盖会把上游的新修复一起盖掉。
3. 判断"我们的版本有没有落后"：比较 `_tmp/rin-inject/waylay-src/` 与这里的文件；
   两者不一致说明本机又改过、而快照没更新（那就该更新快照并提交）。
