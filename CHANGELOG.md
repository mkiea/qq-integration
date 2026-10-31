# 更新日志 / Changelog

### v0.1.0（2026-10-30）— 独立插件首版：控制台独立进程 · 端口统一 · Waylay 收编（NapCat 管理面退场）

**定位**：本插件以「QQ 集成接入」（qq-integration）之名独立发版。包名 `dsh-qq-onebot-bridge` 是 dsh 宿主的加载契约（不改）；
v0.1.0 起按自己的插件节奏维护。

**关于版本号（事实说明）**：前身分支曾一路用到 v0.7.x，但那些是魔改期间**本地自编**的版本号——上游
`cheesehaqi/dsh-qq-onebot-bridge`（基线 commit `c59ca8f`）从未发布过它们。为免与上游版本序列混淆，
本地发版自 v0.1.0 重新起号；前身阶段的逐版明细已从本文件移除（要点已并入下文，git 历史与当日快照仍可回查）。

**① 控制台回到独立进程（不依赖 dsh）**
8880 = 控制台（独立 node 进程，`control/bin/qq-control.mjs` 前台即可跑）；8799 弃用并清理（旧进程已停、端口已释放）。
宿主侧 `/qqai/console` 只剩一个 302/JSON 入口：跑着就 302 过去（token 从 qq-control.json 读出，只出现在这一次响应里），
没跑先自动拉起（普通 node 进程，桌面端补 `ELECTRON_RUN_AS_NODE=1`），`?format=json` 给桌面端拿绝对地址。
前身分支晚期的进程内直挂五件套（页面改写 / 子路径反代 / 占位 token / consoleMount / serveControl）整体退场——
API 由 8880 自己服务，不再有「两套口径各修一份」。

**② 端口统一**
`8880` 控制台（独立）｜`3080` DSH 宿主｜`6700` OneBot 反向 WS（**数据面，Waylay 来连，保留**）｜`13000` Waylay 控制台/状态｜
`8977` 语音｜`8501` 猫娘实验室；NapCat WebUI（6099）随代码一起退场。

**③ NapCat 管理面退场、数据面保留**
删 `lib/napcat-launch.js`（提权垫片 / 加载器判定 / WebUI token 拼接 / napcat 启停路由）；OneBot 协议与日志措辞等
数据面语义全部保留（Waylay 本就是 NapCat 系注入，接口相同）。`parseTasklist` / `QQ_CLIENT_RE` 搬进 `lib/waylay-launch.js`。
「绝不按镜像名杀 QQ」铁律改由三处共同钉住：`assertKillAllowed` 护栏 + Waylay 停止的按端口反查 + 两条源码级回归断言。

**④ 面板与实验室收缩**
QQ助手面板：账号入口 302 到 Waylay 13000（裸 HTTP，不再经手 token）；调试台链接按独立进程口径如实显示运行状态。
猫娘实验室（lab/）整页收缩为一个通往 8880 控制台的按钮。qq_chat 启动器新增控制台计划与 Waylay 状态行，NapCat 行退场。

**⑤ 测试**
napcat 时代断言全部按新行为重写：`control-unit` **153/0** · `settings-unit` **263/0**（新增 Waylay 启停/二维码/停止铁律与
mock 状态接口，测试结果不再随真机 13000 而变）· `console-debug-unit` **83/0** · `trace-branches-unit` **35/0**。量具修复：ui.html 双 `<script>` 块下
「面板脚本可解析」的贪婪正则必然失败（v0.7.25 起就测不出真东西），改为逐块解析。

**⑥ 「新加白名单好友没有新对话」——三处静默（2026-10-30 主人反馈）**取证链：新号 22:49:31 / 22:49:48 两条消息被 `allowUsers` 拒 → 22:50:17 才把号码写进 `cordis.patch.yml`
（热载生效，快照里 `allowUsers` 已是 3 个）→ 对方之后再没说话，而桥是**收到第一条消息才建会话**。
所以不是白名单没生效，而是「已放行」这个状态在界面上根本不存在。修三处：
① 白名单拒绝的 reason 从「私聊用户不在 allowUsers 白名单」改成**可操作**文案（带号码 + 改哪个文件的哪个键 + 热载 + 说清"对方再发一条就会建会话"）；
② `notice/friend_add` 不再落到"未处理的 notice"：写明谁加的、放行没有，未放行时私聊推给管理员（注入/回放事件不推）；
③ 运行快照新增 `whitelistPending`（allowUsers/allowGroups 减去已有会话，含磁盘 `qq-sessions.json`，
避免重启后把老会话误报成"没说过话"），控制台「运行快照」直接显示「白名单已放行、还没说过话」。
顺带修一条**本来就红**的量具：`request 未开启验证留下 reason` 断言 `=== 1`，而一次被忽略的请求会留两条事实
（分支 reason + `#notifyRequestDrop` 事件，后者同样带 `verifyEnabled=false`），改成按 `stage=request` 判"有没有"。


**⑦ 图片一律 HTTP 400 —— 缺 rkey，改四段回退（2026-10-30 主人「还有图片没下载成功」）**
真机证据：私聊图片段的 url 是 `gchat.qpic.cn/download?appid=1406&fileid=…&spec=0`，**没有 rkey**，
QQ 回 `{"retcode":-5503010,"retmsg":"invalid rkey","retryflag":1}` + HTTP 400（拿存档 url 实测四种请求头全 400）；
而同一张图早被 QQ 下到 `nt_data/{Pic,Emoji/emoji-recv}/<月>/Ori/<md5>.jpg`（实测两个文件都在盘上）。
根因不是 CDN 坏了，是**取图只有一条路**：① `#downloadMessageImages` 只调 `downloadTo(url)`、零回退；
② 图片段的 `path` / `file_id` 在解析时就被丢了（与 2026-10-29 私聊文件同一个坑）；
③ 最糟的一条：`mark('media', true, '私聊图片已落盘')` **无条件写成功** —— 四张全失败也一片绿，
主人只能从她嘴里听说"图又碎了"。
修：解析保留 `path`/`file_id`；四段回退 `url → 段内路径 → get_image 接口 → NTQQ 缓存按文件名（大小写不敏感）`；
`downloadTo` 把 QQ 的 `retmsg` 带进错误文案；`media` 事件按真实张数写（全失败 ok=false + 首条真实原因）；
新增 `qqMediaCacheRoots`（默认空 = 自动探测 Documents / OneDrive 重定向 / 老式平铺三种布局）。

**⑧ 红包：认得出来，但**不**假装抢得到（2026-10-30「顺便写一个抢红包的代码」）**
链路事实：OneBot v11 没有开红包的 action；注入层（Waylay `onebot/actions.js`）的 60 个 action 里也没有；
真能开的是 NTQQ 内核 `KernelMsgService::grabRedBag(const GrabRedBagReq&, shared_ptr<IGrabRedBagCallback>)`
—— 本机 `wrapper.node`（9.9.36-53644）里查得到这个符号，JS 侧只吃 1 个参数，但 `GrabRedBagReq` 的**字段名
二进制里没有**，猜不出来。所以本版只做"看得见"：`lib/redpacket.js` 识别普通/口令/专属红包 →
trace 记「发现…未领取」+ 运营计数 `redpacket` + 私聊提醒管理员（`redPacketNotice`，默认开）+
可选群里说一句（`redPacketNoticeInGroup`，默认关）。判定词表独立封闭，且**裸说"红包"不算**
（"我发了个红包"不是红包消息）—— 误判一次，之后真假就分不清了。

**⑨ 全量 64 套件第一次 0 失败：4 条红里有 3 条是测试自己坏了（2026-10-31「你顺便进行各类测试」）**
改前 4061 通过 / 4 失败。逐条查下来，只有 0 条是真的产品缺陷，其余都是量具在说谎：
① `inject-guard-unit` 第 201 行 TypeError 崩掉 ⇒ ②~⑨ **九组注入时序用例从来没跑到过**（注入护栏等于没测）。
   根因：`sessionIdOf` 拿 `followups` 的**数组 includes 做精确匹配**，而桥早给群消息加了
   `【昵称对你说】` 前缀 ⇒ 断言恒假 → `records.get('')` → 崩。改成子串判定，另补一条
   "标签必须还在"的断言钉住它（否则放宽后标签被删了也没人知道）。修完 41/41。
② `stt-unit` 0 覆盖。**不是"本机没装语音服务"**，是假服务缺 `snapshot`/`prepare`
   （`transcribeViaDsh` 2026-10-29 加了"先准备再转写"）⇒ 一进门就抛"没启用"，看着像环境问题。
   补形状后 30 条全跑通；顺手修两条过时断言（包名 `voice-input-bundle` → speech-to-text 两件套；
   "空文本"用例也被同一前置条件挡着）。
③ `privacy-unit` 两条自指误伤：`sk-` 正则缺词边界 ⇒ 英文连写词被从中间切出 `sk-` 当密钥（**真误报**）；
   私钥规则只认"头" ⇒ 脱敏器自己的规则与替换串必然命中。改成「头 + ≥40 字符 base64 体」，
   `!dlptest` 的故意假样例单独放行，并加断言「样例必须仍在代码里」——白名单不能变成垃圾桶。
④ 仓库根**根本没有 `.gitignore`**（这才是"运行产物被忽略"那条红的真因，之前一直归成"既有项"）：
   补 `.gitignore`（根锚定 `/qq-*` + `.*.tmp`）。顺带修匹配器两个真 bug —— 带前导 `/` 的规则被编成
   `^/qq-…`，而候选路径不带前导斜杠，**根锚定规则一个都匹配不上**；`**` 占位还原漏了 `g`。
   没有 `.gitignore` 的两种情形分开判：git 仓库里没有 = 红；解包副本（npm 打包**总是**排除它）= SKIP。
⑤ "存在却读不出"与"索引里有、工作区已删除"分开统计 —— 后者不会被提交，不构成漏检。
   混在一起报时，"我有 3 个文件删了没提交"和"扫描器坏了"是同一句话，看久了就分不清该修哪个。

⚠️ 一并记下的仓库状态漂移（**2026-10-31 已处置**：`lib/{dice,fortune,games}.js` 与三个 test 已 `git add`，
`redpacket` / `waylay-launch` 也一并补进索引）——`0cbc612` 删了这三个功能却没清文件，当时它们全是 untracked，
一次 `git add .` 就会把它们加回去；而运行时包与快照里这三个功能一直是活的。现在按主人拍板的方案收口：
**功能保留、总开关默认关**（见 ⑪）。

**⑩ 本地模型通路 + 研究归因（2026-10-31「顺便做一下模型本地模型适配」）**
接法不是自己写适配器：`llm-pi-ai` 由 `dsh-base` **默认挂载**（休眠、零路由），
profile 里给它一份 provider 声明就活。已在 `cordis.patch.yml` 加 `ollama` 路由
（`api: openai-completions`、`baseURL: http://127.0.0.1:11434/v1`、5 个模型带真实 contextWindow）。
**故意不改** `agent-default-model` —— 默认仍是云端；QQ 侧想用本地就在插件配置里填
`provider: ollama` / `model: …`，于是「QQ 走本地、桌面走云端」能同时成立（研究隔离）。
裸端点实测（`qwen2.5:3b`）：首次 **42s**（那是加载进显存）、热态 **0.37s**、
function calling 返回标准 `tool_calls` + `finish_reason:"tool_calls"`
⇒ 命令与工具链在本地模型上**可用**，不需要降级。插件侧只做两件它真能做的：
① `!model` 自检（纯读：不建会话、不发请求、不花 token；分开报
「实际生效 / 插件配置 / 宿主默认」——**空 ≠ 默认**，本地接不上时要先分清是插件写错还是宿主默认变了）；
② 建会话时写 `stage=model` 事件带 `{provider, model, overridden}`，作为**研究归因锚点**
（只在建会话/恢复/fork 写一次；每回合写会把 trace 刷满，反而看不出切换点）。
代价写在明处：8GB 显存同时只放得下一个模型，**换模型 = 重载几十秒**，比推理本身高两个数量级
⇒ 研究要按批次换模型，不要逐条交替（后者每次都在付加载代价，还会把"耗时"这个变量混进结果）。
详见 `docs/LOCAL-MODEL.md`。

**⑪ 数据根目录：能选、能看见、能一键打开（2026-10-31「要给选择文件夹存放记忆和数据的地方」/「第一次启动能选择根目录，没有创建默认的」）**

三件事被拆开做，因为它们是三种不同的失败：

① **能选** —— 面板新增「数据与备份」组（不折叠，在最后），里面是 `dataDir` 文本行 +
快捷操作里的 **「选择数据根目录…」**（弹**系统**选文件夹窗口 `FolderBrowserDialog`，
选完直接写配置，一个动作完成）。为什么必须由宿主弹窗：浏览器的 `showDirectoryPicker()` 和
`<input webkitdirectory>` **都拿不到绝对路径**，而这里要写进配置的恰恰是绝对路径。
写入前过 `normalizeDataDir`：只收绝对路径、拒 `..`、限 240 字符（Windows `MAX_PATH` 留余量）。
**相对路径会被拒**——它随启动目录漂移，结果是"一半数据在 A、一半在 B"，而界面上看不出来。
按钮只在 Windows 出现，其它平台**如实回"请直接填路径"**，不做点了没反应的按钮。

② **能看见** —— 控制台「运行快照」多一行 `数据根目录` + **「打开文件夹」**（`POST /api/data-dir/open`）。
路径优先取**运行快照里的生效值**（那是桥真正在写的目录），其次控制台配置，最后 `cwd`；
目录不存在就如实报错、**不替用户创建**（打开一个空目录，用户会以为数据丢了）。
`dataDir` 没配时显示橙色横幅：说清现在临时用的是哪个目录、去哪配、以及**换目录不会自动搬数据**
（要搬就连 `qq-canary.json` 一起拷——重新生成金丝雀，以前贴出去的旧哨兵串就再也认不出来了）。

③ **"不给默认"怎么落** —— 桥不会因为没配就不干活（那样插件直接不可用），
但启动时写一条 `stage=setup` 的 `warn` 进 trace（新增 stage 标签 `setup`），
写明"临时用 cwd 兜底 → 实际路径"。控制台横幅 + trace 警告 = 这件事**一直看得见**，
而不是安静地变成"用了一个你没选过的目录"。

**连带修的真缺陷**：控制台原来按 `cwd` 推 `qq-trace.jsonl` / `qq-runtime.json` / `qq-inbox.jsonl` /
`qq-actions.log` / `qq-inject.jsonl` 的路径，而桥这些文件全写在 `dataRoot` 下
⇒ `dataDir ≠ cwd` 时**所有面板都是空的**，而"读不到文件"和"真的没有数据"在界面上长得一模一样。
现在 `control/lib/config.mjs` 统一按 `dataDir || cwd` 推（`dataRoot`），并在目录不存在时给一条提醒。

**测试**：新增 `test/datadir-unit.mjs`（**32/0**，全部注入化，不弹任何窗口）——
写入校验 7 条、`#< CLIXML` 噪音解析 3 条（把 powershell 的警告当成路径会安静地建一个叫 `#< CLIXML` 的目录）、
弹窗四态（非 Windows / 取消 / 失败 / 超时）、`openDataDir` 六条（**非法路径与不存在的目录必须不弹窗**、
快照优先于配置、`openFolder` 的失败理由不许被吞）、控制台路径推导 3 条、面板行 3 条。
顺手修一条**一直在说谎的量具**：`console-debug-unit` 提取 ui.html 里 `/api/...` 的正则字符类没有 `-`，
`/api/replay-diff` 被截成 `/api/replay` 而后者确实存在 ⇒ **常年白通过**；新路由 `/api/data-dir/open`
才让它第一次红。现在补 `-`/`_`，并加一条"提取没有被截断"的自检——宁可红，不许看着像查过了。
断言总数 4142 → **4157**（65 个 `*-unit.mjs`），全量 **0 失败**。

**开发流程也修了一处**：仓库只有 git、**没有 `node_modules`**（37 套件会 `ERR_MODULE_NOT_FOUND`），
测试只能跑在运行时副本里；2026-10-31 实测两份副本漂了 **11 分钟 / 9 个文件**
（`dataDir` / `funEnabled` 的改动全只在运行时那份里，仓库一个字节都没有）。
新增 `tools/sync-runtime.mjs`：方向固定为**仓库 → 运行时**，只拷有差异的文件、**只拷不删**
（运行时有 `qq-control.json`、`_tmp/`、`node_modules/` 这些不在仓库里的东西），
比对**忽略 CRLF**（仓库 LF / 运行时 CRLF，按字节比会把每个文件都报成有差异）；
`--check` 用退出码表达不一致，可直接串进脚本。

**⑫ 首次启动向导：自动弹窗选数据根目录（2026-10-31「加弹窗引导吧」）**

上一版把「选数据根目录」做成了"面板里能填 + 控制台横幅提醒"，是**能用但不会主动找你**。
这一版补上真正的引导：**控制台一打开、只要还没选过，就弹一个向导**。

**判据用真实状态，不用"看过了"的标记**：`runtime.dataDir.configured === false` 才弹。
用 `localStorage` 那种标记的失败模式很具体——用户手改配置、换个浏览器、或清一次缓存，
界面就开始撒谎（"你配过了" / 明明没配却不再问）。用状态则三件事自动成立：
选完不再弹、手动清空 `dataDir` 想重选时**它自己回来**、插件版本较旧（快照没这个字段）时**不乱弹**。
（`setupDismissed` 只管"同一轮刷新里别再弹"——否则每两秒一次刷新会把窗口顶回来，用户关不掉。）

**向导里做什么**：
1. 说清为什么只能选一个目录（记忆 / 聊天记录 / 收发文件 / DLP 金丝雀都在那儿，`qq-*` 前缀）；
2. 输入框预填当前兜底目录（`= cwd`）+ **「浏览…」**（系统选文件夹窗口，**只选不写**）；
3. **「就用这个目录」** ⇒ 写进 profile 的 `cordis.patch.yml` ⇒ 告诉你**重启宿主才生效**，并给按钮。

**选完先查一遍再说话**：目标目录是空的 / 已经有 N 个 `qq-*` 条目 / 有没有 `qq-canary.json`、
目录还不存在 —— 全部如实报。「空目录」和「已经有两百天聊天记录」在界面上长得一样，
选错一次就是把记忆接到别人身上（或者看起来像"记忆全丢了"）。

**三条刻意的"不做"**（写进代码注释，防止以后被当成为完成度补上）：
· **不创建目标目录**（只报告存不存在：打开一个新建的空目录，用户会以为数据丢了）；
· **不搬旧数据**（连金丝雀一起搬是**语义动作**——旧 canary 作废等于把"泄露过"洗白，
  不能由"换个目录"顺带完成；这里只把该搬什么说清楚）；
· **不重启宿主**（重启由用户手动触发，项目铁律）。

**结构上的一点收拾**：选文件夹窗口的实现从 `lib/settings-routes.js` 搬到 **`lib/dir-pick.js`（零内部依赖）**，
`settings-routes.js` 只做 `export … from`。原因是控制台的向导也要用它，而
`settings-routes.js` 会 import `control/lib/{server,supervisor}.mjs` —— 控制台反过来 import 它就成**循环依赖**。
搬完两边**共用同一份实现**，不会出现"面板能选、控制台选不了"。

**写入路径复用同一套规则**：`control/lib/supervisor.mjs#setDataDir` 用 `lib/panel.js` 的
`normalizeDataDir` + `upsertPatchValue`，所以「面板能填的值」和「向导能收的值」**是同一套校验**。
写盘走**原子写**（临时文件 + rename）：写到一半被打断就是半份 YAML，宿主下次启动直接拒载，
而这个后果要等到下次重启才显形。控制台也因此第一次知道 `profile` / `patchFile`（从 `DSH_HOME` 推，缺省 `web`）。

**新增 3 条控制台接口**：`/api/data-dir/{open,browse,set}`（GET 侧无新增）。
`browse` 与 `set` 刻意分开：选中只是填进输入框，写入要再点一次确认。

**测试**：`test/datadir-unit.mjs` 34 → **68 条**，新增覆盖写入链路 ——
只动 `dataDir` 一个键（别的键与 `allowUsers` 原样保留）、同值再写 `changed=false` 且**不落盘**、
相对路径被拒且**一个字都没写**、patch 里没有我们条目时**追加**而不是拒绝、
读不到 patch 时报真原因、目标有 `qq-*` 但没金丝雀 / 当前有金丝雀而目标不存在 两种提醒、
**真写盘后从文件读回来逐字一致**（YAML 引号正确）、原子写不留临时文件、
浏览的三态（选中 / 取消 / 非 Windows）、条目多时只列 12 个但**计数是真的**。

**收尾时发现的一处"向导写好了，但控制台还看旧目录"**：向导写的是 profile 的
`cordis.patch.yml`，而控制台原先只认自己的 `qq-control.json`（`dataDir` 缺省空 ⇒ 退回 `cwd`）。
于是选完新目录、重启宿主之后，桥搬走了、控制台还在老地方翻 `qq-trace.jsonl` ⇒ **面板全空**，
而"读不到文件"和"真的没有数据"在界面上长得一模一样。修法：`control/lib/config.mjs#detectPaths`
改成**三级来源**（`qq-control.json` 覆盖 → profile patch → `cwd`），并回报 `dataDirSource`
（`config` / `patch` / `none`）让界面能说清"这个目录是从哪读来的"；
profile patch 读不到 / 读坏了**当没配**（控制台不能因为配置坏就起不来）。
对应新增 5 条断言：patch 生效时 `dataRoot` 跟着变、四个日志路径全部落在同一个根下、
`qq-control.json` 仍能压过 patch、两处都没配时如实标 `none`、patch 读抛异常时照常启动。
全量 **65 套件 / 4211 条断言，0 失败**。

**⑬ 推到自己的仓库：把"集成关系"写成可核对的事实（2026-10-31）**

仓库：`https://github.com/mkiea/qq-integration`（`main`）。

这次不是加功能，是把**对外身份**补齐——之前几处会让人误解本包是什么：

- **`NOTICE.md` 重写**（原来是"衍生版说明"）。现在写清三件事：
  ① 上游 MIT 来源与基线 commit（`c59ca8f`，版权行在 `LICENSE` 里原样保留）；
  ② **复用的是 OneBot v11 的传输与调用约定**（反向 WS、事件结构、action 名与参数形状），
     不含 QQ 登录/协议编解码/收发包——那些在 OneBot 实现里，本包一行都没有；
  ③ **「内置 Waylay」指的是拉起/停止/状态读取**，不是打包 Waylay 本体（连同注入 DLL 都不在仓库里）。
- **README 增「这是个集成插件」**：一张三行表说清"本包出什么 / 本包不含什么"（中文 + 英文两份）。
  顺带修掉两处把 NapCat 当受管进程写的残留（端口总览还写着 6099、"启停 NapCat 与 QQ"）。
- **`package.json` 指向本仓库**：`repository` / `homepage` / `bugs` 原来全指向上游
  ——那样任何 `npm install` 都会把人送到上游代码，而 README 与 CHANGELOG 只描述这条线。
  `files` 补 `NOTICE.md` + `LICENSE`（MIT 要求再分发必须带上），keywords 补 `waylay` / `integration`。
- **新增 `.gitattributes`**：`* text=auto eol=lf`，`.bat`/`.cmd`/`.ps1` 显式 `eol=crlf`。
  理由是 CRLF/LF **假差异**已经坑过好几轮：同一份文件在仓库是 LF、运行时副本是 CRLF，
  `diff -rq` 整文件报差异，看起来像"代码没同步"，实际语义一个字节都不差。固定成 LF 后可直接逐字节比。
  （批处理必须 CRLF 是硬要求：`cmd.exe` 对纯 LF 的 `.bat` 会让 `goto`/`if` 错乱，而且**不报错**。）
- **`.gitignore` 补 `/node_modules/`、`/qq-control.json`、`.env*`**：前两条会静默把
  第三方代码和本机配置（含 QQ 号、TTS/STT key）带进版本库，而 `git status` 看起来一切正常。

推送前核对过：161 个受版本控制的文件里没有个人绝对路径、没有密钥、没有真实 QQ 号；
`qq-control.json`（本机配置）与 `qq-*`（运行时产物）都不在库内。两副本 `--check` 一致（160 个文件）。

**⑭ 依赖改成 `link:`（跟 `dsh-forge` 一样）：从"两份副本"回到"一份"（2026-10-31）**

用户原话：「跟 forge 一样吧」。profile 的依赖从
`git+https://github.com/cheesehaqi/dsh-qq-onebot-bridge.git` 改成
`link:C:/Users/<你>/Desktop/chat role/qq-integration`；
`pnpm-lock.yaml` 里那条 pin 在 `#c59ca8f` 的记录随之消失，`pnpm-workspace.yaml` 里带提交号的
`allowBuilds` 旧条目一并删掉。

**为什么值得改**：改之前，下一次 `pnpm install` 会把运行时副本整体换回上游 0.7.22，
**我们所有改动无声消失**，而界面上没有任何提示。这是项目里唯一一条"只要别人敲一条常规命令就全没了"的隐患。

**顺手做对的三件事**：

1. **迁走运行时目录里的私货**：`qq-control.json`（含 QQ 号与控制台 token）与 `_tmp/backups/`
   原本只存在于运行时那份里，link 之后那个目录会变成符号链接、内容随之消失。
   已先备份到 `qq_chat/_local-patch/backup-runtime-20261031-1237/`，再复制进仓库并加进 `.gitignore`。
2. **`npm install` 的真实姿势**：`--omit=dev` 会 `ERESOLVE` 失败——npm 先把整棵树解出来再裁 peer，
   七个 `@deepseek-ai/dsh-*` 的区间对不上（加 `--omit=peer` 也拦不住）。可用的是
   `npm install --omit=dev --legacy-peer-deps`，只装 `ws` 一个包。
3. **`link:` 之后 peer 必须另有出路**：`link:` 装的是符号链接，Node 按**真实路径**解析 import ⇒
   从仓库往上找永远找不到 profile 的 `node_modules`，宿主启动直接
   `Cannot find package '@deepseek-ai/schemastery'`（`import('ws')` 却是好的，所以特别容易误判成"依赖装好了"）。
   修法：在插件目录建一个目录联接 `node_modules\@deepseek-ai` → profile 的 `node_modules\@deepseek-ai`（不需要管理员）。
   `dsh-forge` 能工作也是因为它自己有一份 `node_modules`。

**连带抓到两个量具缺陷**（都是"看着通过、其实没测"的那类）：

- `tools/sync-runtime.mjs` 的 `collectFiles()` **只给目录加了白名单，文件没有**：仓库根一旦出现
  `qq-control.json` / `qq-trace.jsonl`，同步就会把它们拷进**包目录**——等于把 QQ 号和消息原文
  搬进要被分发的地方。已给顶层文件同样加白名单。
- link 之后"运行时副本"就是仓库本身，`--check` 于是输出"162 个文件内容一致"——**拿自己跟自己比**。
  已加 `isSameDir()`：同一目录时明确打印「运行时目录就是仓库本身（link: 安装）⇒ 只有一份活副本，
  没有可同步的东西」，并且一个文件都不比。

**测试位置也变了**：以前"只能在运行时副本跑"，现在仓库里有 `node_modules`，直接在仓库跑。
新增 `test/sync-tool-unit.mjs`（14 条）专门守住上面两个缺陷 + 白名单 / CRLF 口径 / 只拷不删 / 环境变量覆盖。
全量 **66 套件 / 4226 条断言，0 失败**。

**⑮ 群里别人说话它不回：把"隐藏规则"变成显式开关（2026-10-31 用户报障）**

用户原话：「还有群聊其他用户跟他聊天不回应」。

**先取证，不靠猜**。`qq-trace.jsonl` 里同一分钟的记录已经说明了原因：

```
stage=inbound  ok=true   chatKey=g:<群号>  text="哦不"
stage=whitelist ok=false reason="成员不在 allowUsers 白名单（QQ <对方号> 不在里面…）"
stage=mention  ok=false reason="群聊未 @ 机器人（replyOnlyWhenMentioned=true）"
```

**两道独立的闸**，任一道不过它都一个字不回：

1. `allowGroups` 命中了，但发送者还要在 `allowUsers` 里——而 `allowUsers` 只有主人那四个号。
   于是"群里除了主人，谁说话它都不回"，症状和"它坏了"完全一样（它既不回话也不解释）。
2. 群消息还要 @ 到它（`replyOnlyWhenMentioned`，默认开）。

**改动**：新增布尔 `groupCheckMembers`（面板「AI账号与白名单」→「群内也校验成员名单」）：

- **默认 `true`** = 保留历史行为。老配置里没有这个键，若默认放行，等于"一次升级悄悄把每个白名单群的
  准入范围放大到全体成员"——这种事不能由升级替用户决定。（代码里用 `!== false` 而不是 `=== true` 兜住。）
- 关掉后：白名单群里**任何成员**都能触发它；`allowGroups`（哪个群）和 @ 门槛**都不变**，私聊也不受影响。
- trace 里的拒绝理由也改了，会把两条处置路径都写出来（加号 / 关开关），不再只说"不在白名单"。

**连带修的两处**（都属于"改了一个判据，别的地方还在用旧假设"）：

- `#replayHints()` 补上 `groupCheckMembers`。它决定白名单分支走向，不进回放提示的话，
  离线回放会按默认 `true` 重放——**结论看起来一样可信，其实重放的不是当时那次决定**。
- 运行快照 `flags.groupCheckMembers`：这个开关唯一的症状就是"群里别人说话它不回"，
  没有这一项，改完到底热载生效没有只能翻 patch 猜。

**本机配置已改**：profile 的 `cordis.patch.yml` 里写入 `groupCheckMembers: false`（走项目自己的
`upsertPatchValue` + 原子写，`js-yaml` 回读确认该键落在 `dsh-qq-onebot-bridge` 条目下、值是 `false`）。
⚠️ 但**代码要重启宿主才生效**（新逻辑在 `lib/bridge.js` 里），配置热载不会带上新代码。

**测试**：`guards-unit` 22 → **24 条**（4 条纯函数矩阵 + 2 条**端到端**）。
端到端那两条拿 `agentCalls` 当探针（假 `agents.create` 先 +1 再抛）：默认档 8→8（连 agent 都不建），
关掉后 8→9（真的进到模型这一层）——只测纯函数的话，键名写错、桥没把 config 传下去都测不出来。
`settings-unit` 的行数断言随之 89 → **90**（开关 70 → 71）。

**顺手被自己的量具抓了一次**：`privacy-unit` 报 `CHANGELOG.md` 里有本机家目录路径
（我在 ⑭ 写了 `C:/Users/<真实用户名>/…`）。已换成 `C:/Users/<你>/…`——
公开仓库里出现本机用户名是实打实的泄露，这条断言值得留着。
