# qq-integration（QQ 集成接入）

QQ ↔ DeepSeek Harness 双向桥插件（独立 bundle，自研维护）。QQ 消息直接驱动 DSH agent 会话，agent 回复自动发回 QQ。

> 包名 `dsh-qq-onebot-bridge` 是 dsh 宿主的加载契约（不改）；对外定位、目录与发版以「QQ 集成接入 / qq-integration」为准。
> 控制台是**独立进程**（`http://127.0.0.1:8880/`，不依赖 dsh，`control/bin/qq-control.mjs` 前台即可启动）。

### 这是个**集成**插件

它自己**不实现 QQ 协议**，做的是把三样东西接起来：

| 集成的东西 | 本包出什么 | 本包**不含**什么 |
|---|---|---|
| **OneBot v11**（协议层） | 反向 WS 服务端、事件分发、action 调用、@ 解析、合并转发——复用上游 `dsh-qq-onebot-bridge` 的代码并继续维护 | QQ 登录、协议编解码、收发包（都在 OneBot 实现里） |
| **OneBot 实现**（QQ 接入端） | 只要它说 v11 就认：Waylay / NapCat / LLOneBot / OpenShamrock / Lagrange / go-cqhttp | 不打包、不分发任何实现的二进制 |
| **Waylay**（当前默认接入端） | **内置**拉起 / 停止 / 状态读取（`lib/waylay-launch.js` + `/api/waylay*` + 面板「启动 Waylay」） | Waylay 本体与注入 DLL（由用户自行安装） |

来源、许可证与「复用边界」写在 [`NOTICE.md`](NOTICE.md)；上游 MIT 版权行在 `LICENSE` 里原样保留。

## 架构

```
QQ 客户端 ←→ OneBot 实现（Waylay〔当前默认〕/ NapCat / LLOneBot / OpenShamrock / Lagrange…）
                  │ 反向 WebSocket（OneBot 连我们；端口 6700）
                  ▼
        dsh-qq-onebot-bridge（本插件）
                  │ ctx.agents.create / followup
                  ▼
        DSH agent 会话（每群/每私聊用户一个）

旁路（都不参与回复决策，出问题也不影响发消息）：
  每条入站事件 ──► qq-inbox.jsonl          （录制：可离线回放）
  每个决策点   ──► qq-trace.jsonl          （结构化事件：stage/ok/reason/耗时/traceId）
  快照每 2s    ──► qq-runtime.json         （会话/闸门/生效配置/录制与注入状态）
  qq-inject.jsonl ◄── 控制台写、桥轮询读   （注入：默认 dry-run，出站全拦截）

独立控制台 control/（进程 8880，不依赖 DSH 桌面端）
  ├─ 读：端口/进程、事件流、决策链、体检、录制列表、运行快照
  ├─ 写：启停宿主/Waylay/TTS、释放端口、离线回放（沙箱 + dry-run）、事件注入
  └─ 鉴权：仅 127.0.0.1 + token + 同源 Origin 校验
```

## 安装 / 卸载

本地目录安装走 pnpm 的 `link:`（跟本机 `dsh-forge` 一致）：profile 的
`node_modules/dsh-qq-onebot-bridge` 是一个**符号链接**，指回插件目录 ⇒ **仓库就是运行时**，改完即生效（重启宿主后）。
三步，缺一步都会在启动时炸，而且炸法不一样：

```sh
# 1) 插件目录自己的运行时依赖（只有 ws）
cd <插件的绝对路径>
npm install --omit=dev --legacy-peer-deps
```

> `--legacy-peer-deps` 不是美化选项：`peerDependencies` 里七个 `@deepseek-ai/dsh-*` 各有区间，
> npm 会**先把整棵树解出来再裁掉 peer**，区间对不上就 `ERESOLVE` 直接失败（加 `--omit=peer` 也拦不住，
> 亲测）。pnpm 那边靠 `autoInstallPeers: false` 天然不装，npm 只能用这个开关。

```sh
# 2) 让插件目录自己能看见官方 peer（最容易漏的一步）
#    link: 装的是符号链接，Node 按**真实路径**解析 import ⇒ `@deepseek-ai/*`
#    会从插件目录往上找，永远找不到 profile 的 node_modules。
#    Windows 用目录联接，不需要管理员权限：
cmd /c mklink /J "<插件目录>\node_modules\@deepseek-ai" "%USERPROFILE%\.dsh\profiles\<profile>\node_modules\@deepseek-ai"
```

```sh
# 3) 注册到 profile（`dsh plugin --profile web add <目录>` 会替你做这一步）
#    写进 ~/.dsh/profiles/web/package.json：
#      "dsh-qq-onebot-bridge": "link:C:/…/qq-integration"
dsh plugin --profile web add <本目录>
```

卸载：`dsh plugin --profile web remove dsh-qq-onebot-bridge`（随时可移除，独立 bundle 不影响其它插件）。

装/卸后重启 `dsh web` 生效。

> 官方依赖（`@deepseek-ai/dsh-*`、`@deepseek-ai/schemastery`）声明为 `peerDependencies`，由 DSH 随 profile 一起装好，插件目录里不需要重复安装——但第 2 步的**联接**要建，那是让真实路径也能看见它们。
>
> ⚠️ **别用 `git+https://…` 装本插件**：pnpm 会把版本钉在某个 commit 上，`pnpm install` 一跑就把运行时换回那个 commit，**你本地的改动无声消失**。要装远端就明确 pin 到你要的 tag。

### 官方桌面端（DSH Desktop）

官方桌面端（Electron 版 `DeepSeek Harness.exe`）跑的是 `~/.dsh/profiles/desktop` 这个 profile，**由应用独占管理**（CLI 会拒绝 `dsh --profile desktop`），它和 CLI 版**共用同一个 DSH 运行时版本**——所以本插件声明的 peer 范围同时覆盖 `^0.1.x` 与 `^0.2.0-rc.2`，两边都能直接装、**不需要 `dsh plugin allow-version` 豁免**。

装法与 web 版一致——**但上面三步里的 `<profile>` 要换成 `desktop`**（目录联接指错 profile 会静默挂错 peer），
其余只是走桌面端的插件管理界面：

1. 桌面端 → 设置 → 插件 → 安装，选**本地目录**（就是本插件所在的目录，也就是 `dsh plugin --profile web add` 时填的那个路径），或直接填 GitHub 仓库地址；
2. 配置同样写在 `~/.dsh/profiles/desktop/cordis.patch.yml`（`id: dsh-qq-onebot-bridge` 的 config），不要写进仓库；
3. 重启桌面端生效。

> 手动/本地目录安装（不经市场）时注意：光有依赖还不够，**必须同时把 `dsh-qq-onebot-bridge` 加进该 profile `package.json` 的 `dsh.profile.bundles`**，加载器才会挂载它——只装依赖的话它只会出现在"已装依赖"里而不工作（本机实测）。市场安装会自动处理这一步。

> ⚠️ **一台机器只允许一个实例托管 QQ 桥**：web 宿主与桌面端可以都装本插件，但两者抢同一个 OneBot 端口（默认 6700），只有一个能绑上——另一个会在日志里说明原因并**每 15 秒重试**，等端口释放后自动接管（不会崩溃、也不会拖住宿主启动）。**不要用"给另一个 profile 改个端口"来让两个都跑**：它们共用同一份 `cwd`（`qq-sessions.json` / `qq-memory/` / `qq-reminders.json` / 积分与统计…都在那儿），两个实例同时读写会互相覆盖，`injectDryRun:false` 时注入队列里的动作还会真的发两遍。要固定由某一个托管，正确做法是**只在一个 profile 里启用本插件**（另一个从 `dsh.profile.bundles` 里去掉），或者把 `cwd` 也分成两个不同目录。

## 从零安装（一台干净的机器）

> 这一段写给"什么都没有"的机器：照顺序做完，中间不需要猜。
> 环境已经有了的人可以直接跳到上面的 `安装 / 卸载`。

### 0. 先确认你有什么、没有什么

| 需要 | 干什么用 | 没有会怎样 |
|---|---|---|
| Windows 10/11 x64 | Waylay 注入的是官方 `QQ.exe` | 跑不了（本项目没做其它平台） |
| 官方 NTQQ（PC 版） | 被注入的那个进程，机器人账号登在它里面 | 「启动 Waylay」找不到进程 |
| Node.js ≥ 20 | 跑插件和控制台 | 宿主/控制台起不来 |
| DSH（`dsh` CLI 或桌面端） | 提供宿主、模型、插件加载 | 插件没地方挂 |
| **一个 QQ 小号** | 机器人自己的账号 | 用主号 = 拿主号去赌风控，别这么做 |
| 模型（云端 key 或本地 Ollama） | 生成回复 | 能收不能回 |

### 1. 装依赖并注册插件

```sh
cd <本目录>
npm install --omit=dev --legacy-peer-deps                # 只装 ws；--legacy-peer-deps 见「安装 / 卸载」
cmd /c mklink /J "%CD%\node_modules\@deepseek-ai" "%USERPROFILE%\.dsh\profiles\<profile>\node_modules\@deepseek-ai"
dsh plugin --profile <profile> add <本目录>                # 注册进 profile（link: 到本目录）
```

> ⚠️ **`<profile>` 按你用的客户端填**：CLI / Web 版填 `web`；**官方桌面端（DSH Desktop）填 `desktop`**。
> 这两处目录联接必须指向**你自己那个 profile** 的 `node_modules\@deepseek-ai`——指错 profile 时，
> 如果那个目录恰好存在，`mklink` 会**成功**，然后把插件挂到另一套 peer 上，症状是启动时才报
> `Cannot find package` 或者版本对不上的怪错误。桌面端的安装入口见下面「官方桌面端」一节。

> 第 2 行那个目录联接是**必须**的，漏了会这样：宿主启动时 `Cannot find package '@deepseek-ai/schemastery'`。
> 原因：`link:` 装的是符号链接，Node 按**真实路径**解析 import，官方 peer 从插件目录往上找永远找不到 profile 的 `node_modules`。

装完**必须**确认 `~/.dsh/profiles/web/package.json` 里已经有

```json
"dsh": { "profile": { "bundles": ["dsh-qq-onebot-bridge"] } }
```

少了这一步，插件只会出现在"已装依赖"里、**不会被加载**（本机实测）。市场安装会自动做。

### 2. 写最小配置（不写这段她一句话都不会说）

配置写进 **profile** 的 `~/.dsh/profiles/web/cordis.patch.yml`（**不要**写进仓库根目录那份）：

```yaml
- id: dsh-qq-onebot-bridge
  config:
    cwd: 'C:\Users\你\qq_chat'            # AGENT 的工作区（模型在里面跑命令）
    dataDir: 'C:\Users\你\qq_chat'        # 记忆/聊天记录/金丝雀的根目录（下面第 3 步也能选）
    botQq: 1000000000                     # 机器人自己的 QQ
    allowUsers: [2000000001]              # 允许私聊的号
    allowGroups: [3000000001]             # 允许的群
```

🔴 **两个白名单空着 = 全部拒绝**（刻意的安全默认）。这不是 bug：
不在名单里的会话**根本不会被创建**，所以不会"回一句拒绝"，trace 里直接记「白名单」被拒。

### 3. 第一次启动：选数据根目录

插件**不给你默认目录**（故意的：她所有的记忆、聊天记录、金丝雀都住这一个目录里，
"用了一个你没选过的目录"是最难发现的一类问题）。所以第一次启动后：

1. **控制台会自动弹一个向导**（「先给她选一个放东西的地方」）：
   点 **「浏览…」** 弹系统选文件夹窗口，确认路径后 **「就用这个目录」** ⇒ 直接写进 profile 的
   `cordis.patch.yml`，再点 **「重启宿主让它生效」**。
   向导会先把你选的目录**查一遍**再告诉你：是空的 / 已经有 N 个 `qq-*` 条目 / 有没有 `qq-canary.json`
   ——「空目录」和「已经有两百天聊天记录」在界面上长得一样，选错一次就是把记忆接到别人身上。
2. 也可以在 **设置 → QQ 助手 → 数据与备份** 里填同一个键（两处写的是**同一份配置**、走**同一套校验**）。
3. 没选之前她照样能跑（用 `cwd` 兜底），但**两处会一直提醒你**：
   - 控制台「运行快照」里一条橙色横幅（带「现在就选」按钮）+ `qq-trace.jsonl` 里一条 `stage=setup` 的 `warn`；
   - 两处都写明当前临时用的是哪个目录——不给默认值不等于不告诉你。

   > 自动弹窗的判据是**运行快照里的真实状态**（`dataDir.configured === false`），不是浏览器里记的
   > "看过了"标记：用标记时，用户手改配置或换个浏览器，界面就会撒谎；用状态则选完自然不再弹，
   > 手动清空 `dataDir` 想重选时它也会自然回来。

⚠️ **换目录不会自动搬旧数据**。要搬就把旧的 `qq-*` 整个拷过去，**包括 `qq-canary.json`**：
重新生成金丝雀，以前贴出去的旧哨兵串就再也认不出来了，等于把"泄露过"悄悄洗白。

> **关于 `qq-control.json`（控制台的路径配置）**
> 它**不是必须的**：控制台启动时会自己探测 `nodeExe` / `dshBin` / `pluginRoot` / 端口，
> 探测结果可以先用 `node control/bin/qq-control.mjs --print-config` 看一眼。
>
> 只有在**探测结果不对**（比如你把 Node 装在非常规位置、或想同时维护两套数据目录）时，
> 才需要手写这个文件：照仓库根的 **`qq-control.example.json`** 复制成 `qq-control.json`，
> 把里面的 `C:\Users\<你>\chat role` 换成本机真实路径即可。
> 这个文件**不进 git**（里面会写 QQ 号和绝对路径），所以模板单独放在仓库里。

### 4. 启动顺序（顺序错了会看到各种"没反应"）

1. 双击 `control/启动控制台.bat`（或 `node control/bin/qq-control.mjs`），记下它打印的带 token 地址；
2. 控制台点 **「一键启动」**（= 起 DSH 宿主，插件随之加载）；
3. 控制台点 **「启动 Waylay」**（注入进 QQ，**不会弹 QQ 窗口**，别等窗口）；
4. 需要登录时点 **「看登录二维码」**，用手机 QQ 扫码。

### 5. 验证四件事（别靠"感觉它活着"）

| 查什么 | 怎么看 |
|---|---|
| **装没装上** | `node tools/doctor.mjs` —— 一条命令分「安装」「连通」两区报告，每一项失败都给可复制的修复命令 |
| 插件加载了吗 | 控制台「运行快照」有 `v<版本号>`；`设置 → QQ 助手` 打得开 |
| 用的是哪个模型 | 发 `!model` —— 只读，报 provider/model/是否被覆盖三行 |
| 整链路通不通 | 控制台 **「一键体检」**（`/api/diagnose`），它按顺序查端口/进程/快照/日志 |
| 白名单生效没 | 私聊机器人发一句；没反应就去 trace 找「白名单」被拒那条 |

**`tools/doctor.mjs` 是只读的**：不装、不改、不重启，跑它不会让现状变好或变坏。装不上时先跑它，
不用先翻文档猜是哪一步：

```sh
node tools/doctor.mjs             # 全部检查
node tools/doctor.mjs --install   # 只查安装（不碰网络）
node tools/doctor.mjs --net       # 只查连通
node tools/doctor.mjs --json      # 机器可读，报 issue 时直接贴这段
```

它查的东西：Node 版本、`ws` 与官方 peer 能不能加载、`node_modules/@deepseek-ai` 联接到了哪个
profile、哪个 profile 声明了本插件、在不在 `bundles` 里、patch 里有没有条目；连通区查
6700（桥的反向 WS）、3080（宿主 HTTP，这两个**不是同一个东西**）、13000（Waylay 与登录态）、
8880（控制台，没起是正常的）、运行快照新鲜度、最近一次消息处理走到第几个阶段。

⚠️ 它**只在该报错时报错**：`WARN` 不一定是故障（例如"控制台没在跑"就是正常的，
控制台是按需启动的独立进程）。

### 6. 从零安装最容易踩的六个坑

| 症状 | 真因 |
|---|---|
| 扫码成功但机器人一声不吭 | 两个白名单是空的（默认全拒） |
| 「启动 Waylay」报找不到入口 | 没配 `waylayBat`，或 `_tmp/rin-inject/` 不在预期位置 |
| 点了好几次「一键启动」，开出好几个 QQ 互相顶号 | Waylay 在扫码阶段不监听 13000，端口判据看不见它；控制台有 5 分钟单实例锁，锁文件在入口同目录 |
| 记忆是空的 / 找不到聊天记录 | `dataDir` 没配（用 cwd 了）或换过目录没搬旧数据 |
| 面板里全是空数据 | 控制台按 `dataDir` 读日志；`dataDir` 改了而控制台配置没跟上，就会读到空 |
| 换了本地模型后第一次特别慢 | 首次加载模型（实测 3B 约 42 秒），热态才 0.37 秒；8GB 显存同时只放得下一个 |

## 在 DSH 设置里开关功能（v0.6「QQ助手」页）

装好插件、**重启一次宿主**（让面板路由挂上）之后：**DSH → 设置 → QQ助手**。

- **日常六组直接铺开**：**AI账号与白名单** / 对话基础 / **限流：入站 / 出站** / **避开高峰期** / 群运营工具箱 / 娱乐与互动 / 语音与媒体；**安全与风控 · 记录与通知 · 高级与调试**三组标"进阶"、默认折叠。共 11 组 **65 个开关 + 11 个数值项 + 1 个时段列表 + 3 个名单**（从 225 个配置键里精选）；顶部**搜索框**按中文标签 / 配置键名过滤（纯前端）。
  - 两个限流闸放在**同一组**、按管道顺序排，就是为了别混：**每分钟进模型上限**（入站，消息还没进模型就拦，省模型额度）vs **出站回复限流**（模型已生成、发出去之前拦，防 QQ 端发太快被风控）。两个**默认都关**，可以只开一个。
  - **开关和它的数值在同一行里**：左边开关、右边 `− n +`，不用再上下对照「XX」和「XX·数值」谁管谁。
  - **避开高峰期**：以前只能改 YAML；现在整组搬进面板——开关、**周末不静默**、以及**静默时段列表**（每段两个原生时间控件，支持跨夜 `22:00-6:00`，最多 8 段）。
  - **回复带引用**：打开后回复会引用被回答的那条消息（QQ 原生「回复」），多人同时提问时更清楚；**默认关**（单人聊天会显得啰嗦），引用失败（消息被撤回 / ID 过期 / 客户端不支持）会**自动去掉引用重发一次**。它放在**「对话基础」**组——那是"回复的样子"，不是"谁能让它开口"。
  - **AI账号与白名单**：这一组回答"机器人是谁、它认谁"——**AI 账号**（`botQq`，判断 @ 与戳一戳）、**回应所有人**、「群里只理被 @ 的」「允许私聊」「群内也校验成员名单」三个准入门、以及 `allowUsers` / `allowGroups` 两个白名单（**空列表 = 全部拒绝**）。不想维护名单时把「回应所有人」打开：**所有私聊和所有群都会响应**，但**群里的 @ 门槛不变**（仍要 @ 到它）。它们以前都得改 YAML；现在面板里直接填号码（输入框 + 「添加」，号码以**数字**写进配置，写成字符串会让白名单永远匹配不上），还能从「最近来信」一键加入；「回应所有人」开着时两个名单行会标成"现在不起作用"。
  - **群里"别人说话它不回"怎么查**（2026-10-31 用户报的问题）：三道闸按顺序过——① 群号在「允许的群」里；② 「群内也校验成员名单」关掉（默认**开**，开着时只有 `allowUsers` 里的人能触发，这是一条藏在代码里的老规则，现在是显式开关）；③ 「群里只理被 @ 的」关掉或真的 @ 到它。任一道不过它都**一个字不回**，只在 trace/`/为什么` 里留一条被拒原因。
- **数值项**：风控里那些"阈值"不再要你去手改 YAML——**每分钟进模型条数**（1–10，默认 5）、出站回复的上限与窗口、去重窗口、刷屏治理四项、戳一戳每小时上限、周报天数，都在面板里用 `− 数字 +` 直接改。**范围与步长从 schema 现读**（不抄第二份），越界/小数会被服务端 400 拒掉并说清范围。
- **每行都写清楚**：中文标签 + 一句话"关掉会怎样" + **配置键名**（方便你去配置文件里找同名键），右侧是拨动开关；行尾徽标 `非默认`（与 schema 默认值不同）、`更新中`（配置文件里的值与当前生效值不一致）。
- **点一下即写入**：只改 profile 的 `cordis.patch.yml` 里**本插件那一个 config 块**（其它条目与注释原样保留）；白名单之外的键、非布尔值一律拒绝。写入是**先写临时文件再 rename 的原子替换**，并留一份 `.bak-qqai` 备份。
- **生效方式**：写入后 DSH 会热重载本插件条目（QQ 桥会**短暂重连一两秒**）；若宿主没开热重载，重启宿主后生效。
- **没装 web 服务的宿主**（如 TUI profile）不会有这一页——此时用 `ctx.inject(['webServer'])` 的那段代码**根本不会执行**，插件照常工作。
- **页面最上面是一组「相关链接」**（原来在页面最底下）：依次是 **`QQ助手账号（登录 / 扫码）`**（→ 宿主的 `/qqai/account`，点开即已登录的 NapCat 页面）、`更新日志`（GitHub 的 `CHANGELOG.md`）、`调试文档`（README 调试章节）、**`调试台（独立控制台）`（压在最底下）**。地址由 `package.json` / `qq-control.json` 推导。
  - **调试台是独立进程，插件不会自动启动它**：面板会探一次 `127.0.0.1:8880` 并如实标「运行中 / 未启动」；没启动时那一行直接给出可复制的启动命令。
  - 点「调试台」走宿主的 `/qqai/console`：**跑着**就 302 到**带 token** 的地址（省掉手抄 token），**没跑**就回一页说明先跑哪条命令——不会再出现"点进去只看到连不上"。token 只在服务端读，**不进面板数据**。

> 想改的键不在面板里？直接编辑 profile 的 `cordis.patch.yml`（面板顶行会显示它是哪个文件）。面板刻意只放"日常会动的开关"，不做成任意配置编辑器。

## 配置

profile 的 `cordis.patch.yml` 覆盖 `id: dsh-qq-onebot-bridge` 的 config（完整示例见 `examples/cordis.patch.example.yml`）：

> ⚠️ **别改错文件**：仓库根目录也有一个同名 `cordis.patch.yml`，那是**安装用的 bundle patch**（4 行，只有 `insert: - id: …`），**不要往里填配置**。真正要改的是 **profile 目录**里的那份，例如 `~/.dsh/profiles/web/cordis.patch.yml`（Windows：`C:\Users\<你>\.dsh\profiles\web\cordis.patch.yml`）——它在仓库外，**密钥写在那里才不会进 git**。

| 键 | 默认 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | 反向 WS 监听地址 |
| `port` | `6700` | 反向 WS 监听端口 |
| `accessToken` | `''` | OneBot 端须携带的 Bearer token（空=不校验） |
| `allowUsers` | `[]` | 用户白名单（**空=拒绝所有私聊**，务必填入自己的 QQ 号）。群消息**也**要求发送者在这个列表里——除非把 `groupCheckMembers` 关掉 |
| `allowGroups` | `[]` | 群白名单（**空=拒绝所有群消息**，列出机器人服务的群号） |
| `groupCheckMembers` | `true` | 群内是否**也**校验成员在 `allowUsers` 里。关掉后：白名单群里**任何成员**说话都能触发（**仍然要 @ 它**，`allowGroups` 照旧生效）。症状对照：群里除了自己别人说话它一个字都不回 ⇒ 先看这一项 |
| `botQq` | `0` | 机器人 QQ 号（用于群内 @ 检测；0=任何群消息视为@） |
| `replyOnlyWhenMentioned` | `true` | 群聊仅 @机器人 才回复 |
| `acceptPrivate` | `true` | 是否回复私聊（私聊仍需 allowUsers 放行） |
| `autoCollectStickers` | `false` | 自动收藏消息里的图片表情到本地图库 |
| `faceEnabled` | `true` | 表情功能总开关（[face:] 标记 + qq_face_* 工具） |
| `sessionMode` | `chat` | 群会话分组：`chat`=每群一会话；`user`=每群每人一会话 |
| `cwd` | `''` | 会话工作目录（同时决定 `qq-faces/`、`qq-replies/`、`qq-bridge-debug.log` 的位置） |
| `provider` | `''` | LLM provider 覆盖（空=agent 默认） |
| `model` | `''` | LLM 模型覆盖（空=agent 默认） |
| `maxMessageLength` | `1700` | 单条出站消息最大字符数（超出自动分段） |
| `botName` | `小鲸鱼` | 机器人显示名（合并转发卡片的署名） |
| `sessionResumeEnabled` | `true` | 宿主重启后 `resume` 上次会话（完整记录续接）；关掉则每次重启都新建会话 |
| `agentMediaToolsEnabled` | `true` | 暴露 `qq_send_image` / `qq_send_file` / `qq_send_voice` / `qq_recall` 工具 |
| `fileSendDirs` | `[]` | agent 允许发送文件的额外目录（会话 cwd 始终允许） |
| `fileSendMaxBytes` | `52428800` | agent 可发送的单文件大小上限（字节，默认 50 MiB） |
| `imageSendMaxBytes` | `4194304` | 图片超过此大小（默认 4 MiB）先用 ffmpeg 压缩再发 |
| `recallWindowSeconds` | `110` | 出站消息可被 `qq_recall` / `/撤回` 撤回的时间窗（秒） |
| `forwardLongReplies` | `false` | 群聊超长回复改发合并转发卡片 |
| `forwardThresholdChars` | `600` | 触发合并转发的字数阈值 |
| `actionRatePerMinute` | `20` | 写操作闸门：全部会话合计每分钟上限 |
| `actionRatePerDay` | `500` | 写操作闸门：全部会话合计每日上限 |
| `actionAuditEnabled` | `true` | 写操作与拒绝记录写入 `cwd/qq-actions.log` |
| `keywordEnabled` | `false` | 关键词问答库（**默认关闭**）：命中本地词库直接回复，不走模型、不需要 @ |
| `keywordFile` | `''` | 词库文件路径（空=`cwd/qq-keywords.json`）；支持 exact/contains/regex、随机多答、图片、作用域与冷却 |
| `fortuneEnabled` | `true` | 今日人品/运势、抽签、塔罗（按 QQ 号+日期确定性生成，纯本地） |
| `diceEnabled` | `true` | 骰子（`.r 3d6`）与随机抽人（`/抽一个 A B C`） |
| `pointsEnabled` | `false` | 积分经济（**默认关闭**）：`/积分` `/排行榜` `/转账 @某人 数量` |
| `pointsPerMessage` | `1` | 每条消息获得的积分（0=聊天不得分） |
| `pointsDailyCap` | `20` | 每人每日通过聊天可得积分上限 |
| `pointsCheckinBonus` | `5` | 每日签到额外奖励积分 |
| `gameEnabled` | `false` | 群内小游戏（**默认关闭**）：成语接龙、猜数字 |
| `idiomChainTimeoutSeconds` | `120` | 接龙闲置超时（秒） |
| `guessNumberMax` | `100` | 猜数字上限（1~N） |
| `guessNumberMaxTries` | `10` | 猜数字可用次数 |
| `antiRecallEnabled` | `false` | 防撤回（**默认关闭**）：缓存最近消息，被撤回时补发内容 |
| `antiRecallInGroup` | `true` | 补发到群里（false=私聊发给第一个管理员） |
| `antiRecallImages` | `true` | 一并补发被撤回的图片（最多 3 张） |
| `antiRecallCacheSize` | `50` | 每会话缓存的消息条数 |
| `antiRecallMaxAgeMinutes` | `120` | 缓存消息可恢复时长（分钟） |
| `antiRecallCooldownSeconds` | `5` | 同一会话两次补发的最小间隔 |
| `filterEnabled` | `false` | 敏感词过滤（**默认关闭**） |
| `filterWordsFile` | `''` | 词表路径（空=`cwd/qq-badwords.txt`；`#` 注释、`re:` 正则、改动自动热重载） |
| `filterAction` | `warn` | 处置方式：`warn` 提醒 / `recall` 撤回 / `mute` 禁言 |
| `filterMuteSeconds` | `300` | `mute` 处置与刷屏升级时的禁言秒数 |
| `filterWhitelist` | `[]` | 白名单词/正则（命中即放行） |
| `floodEnabled` | `false` | 刷屏防护（**默认关闭**） |
| `floodWindowSeconds` | `10` | 刷屏统计窗口（秒） |
| `floodMaxMessages` | `8` | 窗口内允许的消息条数 |
| `floodMuteSeconds` | `300` | 刷屏升级禁言秒数 |
| `floodStrikeLimit` | `3` | 警告几次后禁言 |
| `chatTurnLimitEnabled` | `false` | **每分钟会话上限总开关**（**默认关闭**）：关着时完全不限流；打开后按下一行的数字生效 |
| `chatTurnsPerMinute` | `5` | 每分钟会话上限的**数值**（1–10，默认 5）：每个会话每分钟最多让几条消息**进模型**，超出的丢弃并记账（不排队）。与 `rateLimitMaxReplies` 不同——那个管"回出去多少条"，这个管"进模型多少次"。面板「安全与风控」里用 `− 数字 +` 改 |
| `verifyEnabled` | `false` | 入群/加好友验证（**默认关闭**）：请求进队列并私聊推送管理员 |
| `verifyKeyword` | `''` | 口令：验证消息包含它则自动放行（空=全部人工审批） |
| `verifyTimeoutSeconds` | `300` | 请求超时时间（超时出队并提醒管理员） |
| `verifyMaxPending` | `20` | 待审队列上限 |
| `statsEnabled` | `false` | 发言统计（**默认关闭**）：`/统计` 今日活跃榜、`/周榜` 周榜，并作为日报数据源 |
| `statsKeepDays` | `30` | 发言统计保留天数 |
| `groupReadEnabled` | `true` | 只读群信息：`/荣誉` `/公告` `/群精华` |
| `mcStatusEnabled` | `true` | `/mc <host[:port]>` 查询 Minecraft Java 服务器状态（Server List Ping，无 Key） |
| `mcStatusTimeoutMs` | `5000` | MC 状态查询超时（毫秒） |
| `recurringReminderEnabled` | `true` | 重复提醒：「每天8点」「每周一9点」「每个工作日15点」 |
| `dailyReportEnabled` | `false` | 每日群日报（**默认关闭**）：到点让 agent 总结当天聊天并发到群里 |
| `dailyReportTime` | `22:00` | 日报时间（本地 HH:mm） |
| `dailyReportChats` | `[]` | 固定接收日报的会话（如 `["g:100000001"]`；为空则用 `/日报 on` 的开关，再为空则回落到全部群白名单） |
| `sttEnabled` | `false` | 语音转文字总开关 |
| `sttBaseUrl` | `https://open.bigmodel.cn/api/paas/v4` | STT 端点（OpenAI 兼容 `/audio/transcriptions`） |
| `sttModel` | `glm-asr-2512` | STT 模型（智谱 `glm-asr-2512` / SiliconFlow `FunAudioLLM/SenseVoiceSmall`） |
| `sttApiKey` | `''` | STT API Key（可复用智谱 GLM 系列的 key） |
| `privateImageView` | `true` | 私聊中主动下载查看对方发送的图片/动画表情（存 `cwd/qq-images/`，agent 用 describe_image 查看） |
| `visionMode` | `tool` | 识图方式：`tool`=存盘后由 `visionToolName` 工具查看（稳定）；`native`=原生多模态附件直传模型（DSH 0.1.1+，文本模型自动降级） |
| `visionToolName` | `describe_image` | `tool` 模式下使用的识图工具名 |
| `imageRetentionDays` | `14` | 下载图片（qq-images/qq-replies）保留天数，宿主启动时清理更旧的 |
| `imageTrashEnabled` | `true` | **删除策略：只回收不销毁**——过期图片移动到 `cwd/qq-trash/<日期>/` 而不是删除（失败则保留原文件） |
| `imageTrashDir` | `''` | 回收目录（空=`cwd/qq-trash`）；该目录**不会自动清理**，由你自行处理（本机可 `scripts/safe-delete.ps1` 送进回收站） |
| `memoryEnabled` | `true` | 每会话持久化记忆（最近对话存 `cwd/qq-memory/`，宿主重启后自动恢复；`/new` 清除） |
| `memoryMaxEntries` | `60` | 每个会话保留的对话条数上限 |
| `rateLimitEnabled` | `false` | 回复限流开关（默认关闭）；开启后每会话窗口内最多回复 `rateLimitMaxReplies` 条 |
| `rateLimitMaxReplies` | `10` | 限流窗口内每会话最大回复数 |
| `rateLimitWindowSeconds` | `60` | 限流滑动窗口（秒） |
| `dedupEnabled` | `true` | 消息去重（同一 message_id 窗口内重复投递忽略，防重连重发） |
| `dedupWindowSeconds` | `300` | 去重窗口（秒） |
| `reminderEnabled` | `true` | 定时提醒总开关（群聊需 @，私聊直接说；存 `cwd/qq-reminders.json` 跨重启保留） |
| `reminderMaxPerChat` | `10` | 每个会话最多同时保留的提醒数 |
| `quietHoursEnabled` | `false` | 避开高峰期开关（**默认关闭**）；开启后工作日静默时段内不回复任何入站消息（不消耗模型调用），已排定的定时提醒/投票开奖照常 |
| `quietHours` | `['9:00-12:00', '14:00-18:00']` | 静默时段（本地时间 `H:MM-H:MM`，全角冒号自动归一化；可跨午夜如 `22:00-2:00`） |
| `quietWeekendExempt` | `true` | 周六/周日不受静默时段限制 |
| `ttsEnabled` | `false` | 语音回复总开关（默认关闭；开启后每条文字回复后跟随一条语音） |
| `ttsProvider` | `azure` | 合成方案：`azure`（微软晓晓）/ `openai`（任意 OpenAI 兼容 `/audio/speech`）/ `local`（**本地 GPT-SoVITS 语音克隆，零 API 成本**） |
| `ttsApiKey` | `''` | Azure / OpenAI 兼容服务的 key（`local` 不需要） |
| `ttsVoice` | `zh-CN-XiaoxiaoNeural` | 云端音色名 |
| `ttsStyle` | `chat` | Azure 语气风格（cheerful/sad…） |
| `ttsMaxChars` | `120` | 语音朗读最大字符数（超出截断，只影响语音不影响文字） |
| `ttsLocalUrl` | `http://127.0.0.1:9880` | 本地 GPT-SoVITS api_v2 服务地址 |
| `ttsLocalRefAudio` | `''` | **本地 TTS 必填**：音色参考音频绝对路径（3-10 秒 wav，如 `D:/voice/xiaojingyu.wav`） |
| `ttsLocalPromptText` | `''` | 参考音频的台词（可留空） |
| `ttsLocalTextLang` | `zh` | 合成文本语言 |
| `ttsLocalPromptLang` | `zh` | 参考音频台词语言 |
| `ttsLocalConvertToMp3` | `true` | 本地 wav 输出用 ffmpeg 自动转 mp3 再发送（QQ/NapCat 兼容性更好） |
| `pokeEnabled` | `true` | 戳一戳回复开关（白名单会话内被戳随机卖萌回复） |
| `pokeReplies` | `[...]` | 戳一戳回复文案列表（随机选一条） |
| `pokeCooldownSeconds` | `15` | 每会话戳一戳回复最小间隔（秒，防刷） |
| `voiceReadingEnabled` | `false` | 语音朗读：@机器人引用文字说「读一下/念出来」，或 `/读 <文字>`（走 ttsProvider 合成） |
| `checkinEnabled` | `false` | 每日签到（**默认关闭**）：说「签到」打卡，连续/累计天数存 `cwd/qq-checkin/`；「签到榜」看排行 |
| `checkinKeyword` | `签到` | 签到触发词 |
| `welcomeEnabled` | `false` | 入群欢迎语（**默认关闭**）：新人进群自动 @+欢迎文案（机器人自己入群不触发） |
| `welcomeText` | `''` | 欢迎文案（空=内置默认文案） |
| `imageGenEnabled` | `false` | 生图开关（**默认关闭**）：`/画 <描述词>` 生成图片（群聊需 @机器人） |
| `imageGenProvider` | `openai` | 生图后端：`openai`=任意 OpenAI 兼容 `/images/generations`（DALL·E/CogView/SiliconFlow…）；`local`=本地 SD WebUI（AUTOMATIC1111） |
| `imageGenBaseUrl` | `''` | 后端地址（空=按 provider 取默认：api.openai.com 或 127.0.0.1:7860） |
| `imageGenApiKey` | `''` | OpenAI 兼容服务 key（local 不需要） |
| `imageGenModel` | `''` | 模型 id（空=服务默认，如 gpt-image-1；local 忽略） |
| `imageGenSize` | `1024x1024` | 图片尺寸 WxH（local 支持任意尺寸如 768x512） |
| `imageGenSteps` | `20` | 采样步数（仅 local） |
| `imageGenCfgScale` | `7` | CFG 提示词强度（仅 local） |
| `imageGenSampler` | `''` | 采样器（仅 local，空=WebUI 默认） |
| `imageGenCooldownSeconds` | `60` | 每会话两次生图最小间隔（秒，成本/刷屏防护） |
| `imageGenDailyLimit` | `20` | 每会话每日生图上限 |
| `imageGenMaxPromptChars` | `400` | 描述词最大字数（超出截断） |
| `imageGenCommand` | `/画` | 生图触发命令 |
| `traceEnabled` | `true` | 全链路结构化事件（每条消息一个 traceId，每个分支带 reason）；关掉则控制台只剩端口/日志能力 |
| `traceLevel` | `debug` | `debug` 记录全部事件（含每次静默/拒绝）；`warn` 只留问题，用于长期运行省磁盘 |
| `traceMemorySize` | `500` | 内存里保留的最近事件数（控制台决策链用），落盘另受 4MiB 轮转上限约束 |
| `traceFile` | `''` | 事件文件路径（空=`cwd/qq-trace.jsonl`） |
| `recordInbound` | `true` | **录制**：把收到的每条消息/通知/请求写进 `qq-inbox.jsonl`（可离线回放）；只写本机、不影响回复 |
| `inboxFile` | `''` | 录制文件路径（空=`cwd/qq-inbox.jsonl`，按 2MiB 轮转） |
| `inboxRedact` | `false` | 录制时把 6 位以上数字（QQ 号）脱敏后再落盘，便于把录制文件发给别人 |
| `injectEnabled` | `false` | **事件注入通道**（默认关闭）：开启后桥每 `injectIntervalMs` 轮询 `qq-inject.jsonl`，把新行喂进真实管线 |
| `injectFile` | `''` | 注入队列路径（空=`cwd/qq-inject.jsonl`）；启动时已有的历史行会被跳过并记一条原因 |
| `injectDryRun` | `true` | **强烈建议保持 `true`**：注入触发的所有出站调用（发消息/撤回/群管…）都被拦截并计数，绝不真发 QQ；**异步 agent 回合的回复同样被拦下**（原文记进事件流） |
| `injectIntervalMs` | `2000` | 注入队列轮询间隔（毫秒，最小 500） |


### 完整配置参考（自动生成，2026-11-05）

> 上表只放"日常会动"的项。**这一节是 schema 里的全部剩余项**，默认值从代码读，
> 说明保留 schema 原文（英文）—— 不做机器翻译，避免翻出"看着通顺但含义漂移"的中文。
>
> 由 `tools/gen-config-reference.mjs` 生成；改 schema 后重跑即可，别手改这一节。
> 示例里的号码一律用占位（`100000001` / `2000000001`），与真实账号无关。

#### 主动通道（proactive）（9 项）

| 键 | 默认 | 说明（schema 原文） |
|---|---|---|
| `oneSentencePerMessage` | `true` | Split each reply into one-sentence messages, sent one after another with a short typing delay. Real people do not type two paragraphs at once - they reply on... |
| `oneSentenceMaxParts` | `3` | Max messages one reply may be split into (default 3). Anything beyond is merged into the last one so it never turns into a wall of bubbles. |
| `oneSentenceMinChars` | `1` | Fragments shorter than this are merged back into the previous sentence. Default 1 = never merge, so a bare "嗯。" or "好。" can be its own message - real people ... |
| `proactiveEnabled` | `false` | Proactive channel (default OFF): a scheduler reads cwd/bio-clock.mjs and, when the clock says it is a good moment, opens a turn of its own so the character c... |
| `proactiveDryRun` | `true` | Proactive channel dry-run (default ON): decide and log what would be said, but never open a turn and never send. Turn this off only after reading a few days ... |
| `proactiveTickSeconds` | `60` | How often the proactive scheduler re-evaluates (seconds). One evaluation per chat per tick; the decision itself comes from bio-clock.mjs. |
| `proactiveStateFile` | 空 | Where per-chat proactive state lives (empty = cwd/qq-proactive-state.json). State is kept per chat key, so one chat quota never eats another chat quota. |
| `proactiveBioClockFile` | 空 | Path to the bio-clock module (empty = cwd/bio-clock.mjs). It must export decide(state, now, config, lastUserAt). |
| `proactiveUsers` | `[]` | Who the character may ping on her own (QQ user ids). Empty = every private chat that has a session, as long as it still passes allowUsers. Groups are never i... |

#### 群运营（groupOps / ops）（19 项）

| 键 | 默认 | 说明（schema 原文） |
|---|---|---|
| `groupOpsEnabled` | `false` | Group operations toolbox (default OFF): native group check-in, @all quota, mute list, batch kick, group todos, group profile, file organisation, album upload... |
| `nativeSignEnabled` | `false` | Enable /群打卡: the REAL QQ group check-in (set_group_sign), separate from the local streak game behind /签到. |
| `opsReadEnabled` | `true` | Enable the read-only ops queries once groupOpsEnabled is on: /全体余量, /禁言名单, /群资料, /入群通知. |
| `opsKickEnabled` | `false` | Enable /批量踢 (set_group_kick_members, admin, batch confirm) — kicks several members in one native call. |
| `opsKickBatchSize` | `20` | How many members one batch-kick request carries (larger lists are split, never truncated). |
| `opsTodoEnabled` | `false` | Enable group todos: /待办, /完成待办, /取消待办 on a quoted message (set/complete/cancel_group_todo). |
| `opsFileEnabled` | `false` | Enable file organisation: /移动文件, /重命名文件, /删文件, /新建文件夹 (move/rename/delete_group_file, create_group_file_folder). Destructive, so it is off by default and adm... |
| `opsAlbumUploadEnabled` | `false` | Enable /传图: upload a quoted image into a group album (upload_image_to_qun_album). |
| `opsProfileEnabled` | `false` | Enable group profile edits: /群名 and /群备注 (set_group_name, set_group_remark). Admin only. |
| `opsPolicyEnabled` | `false` | Enable join/speak policy: /成员权限 (set_group_member_permissions, partial update) and /历史可见 (set_group_new_member_history_visibility). Admin only. |
| `opsAdminEnabled` | `false` | Enable /设管理 and /撤管理 (set_group_admin). Needs groupOpsEnabled. The enable flag is ALWAYS sent explicitly: the probe showed NapCat treats a missing enable as ... |
| `opsInvitePolicyEnabled` | `false` | Enable /邀请策略 (set_group_member_invite_policy) with the four documented values: disabled / require_approval / no_approval / no_approval_under_100. Needs group... |
| `opsAddOptionEnabled` | `false` | Enable /加群方式 (set_group_add_option). Needs groupOpsEnabled. add_type is a raw QQ number with NO documented enum, so /群搜索 (no_*_finger_open) is deliberately n... |
| `requestSyncEnabled` | `false` | Enable /申请: actively pull pending join requests (get_group_system_msg) and doubtful friend requests (get_doubt_friends_add_request) into the approval queue, ... |
| `requestSyncCount` | `50` | How many notifications /申请 pulls per call. Capped at 100 on purpose: NapCat resolves an approval flag by searching only the newest 100 notifications (set_gro... |
| `adminWatchEnabled` | `false` | Watch group_admin notices: tell the chat when the bot gains or loses group admin. The known state is tracked either way, so write commands can report "I am n... |
| `opsReportEnabled` | `false` | Enable /周报 and the ops counters that feed it (messages, joins, leaves, kicks, mutes, sign-ins, reactions). |
| `opsReportDays` | `7` | Window of /周报 in days. |
| `opsCountersFile` | 空 | Where the ops counters for /周报 are persisted (empty = cwd/qq-ops.json). |

#### 互动（engage / poke / 表情回应 / 点赞）（18 项）

| 键 | 默认 | 说明（schema 原文） |
|---|---|---|
| `engageEnabled` | `false` | Interaction pack (default OFF): poke back, typing status, emoji reactions, profile likes and mark-as-read. Every sub-switch below must also be on. |
| `pokeBackEnabled` | `false` | Poke back with a REAL poke action (group_poke / friend_poke) instead of only replying with text. |
| `pokeBackText` | 空 | Optional line sent together with the poke-back (empty = poke only, no message). |
| `pokeCommandEnabled` | `false` | Allow the admin command /戳 <@user\|QQ号> to poke someone on purpose (rate limited per hour). |
| `pokePerHour` | `5` | Hard cap of outgoing pokes per chat per hour. |
| `typingEnabled` | `false` | Show a "typing" status in PRIVATE chats while the model is working (set_input_status; the probe showed NapCat has no group equivalent). |
| `emojiLikeEnabled` | `false` | React to incoming messages with an emoji (set_msg_emoji_like) instead of sending text. |
| `emojiLikeId` | `128077` | Which emoji to react with: decimal unicode code point (128077 = 👍). |
| `emojiLikeMentionOnly` | `true` | Only react when the bot was mentioned or quoted, so the group stays quiet. |
| `emojiLikePerHour` | `20` | Hard cap of emoji reactions per chat per hour. |
| `reactionStatsEnabled` | `false` | Record group emoji reactions (notice group_msg_emoji_like) and expose /赞榜 and /谁赞了. |
| `reactionStatsFile` | 空 | Where reaction statistics and interaction quotas are persisted (empty = cwd/qq-engage.json). |
| `sendLikeEnabled` | `false` | Allow /点赞 [@user\|QQ号] to send QQ profile likes (default OFF). |
| `sendLikeTimes` | `10` | How many likes one /点赞 sends (the QQ client caps this at 10). |
| `sendLikePerDay` | `3` | Hard cap of /点赞 per target per day. |
| `markReadEnabled` | `false` | Mark incoming chats as read (mark_group_msg_as_read / mark_private_msg_as_read) so the account stops showing unread badges. |
| `markReadPerMinute` | `10` | Hard cap of mark-as-read calls per minute (NapCat marks a whole chat, not a single message). |
| `funEnabled` | `false` | Master switch for the fun pack (default OFF): fortune / dice / mini-games are shipped and stay configurable, but none of them answers until this is on. Once ... |

#### 视频与图片帧（15 项）

| 键 | 默认 | 说明（schema 原文） |
|---|---|---|
| `cardVideoWatchEnabled` | `false` | When a shared card links to a video site (Bilibili/Douyin/Weibo/YouTube...), download the first cardVideoSeconds and show her a few extracted frames, so she ... |
| `cardVideoSeconds` | `60` | How many seconds of the video to pull for frame extraction (default 60). Longer = slower and bigger; frames are what she sees, not the video. |
| `cardVideoFrames` | `4` | How many still frames to extract and attach (default 4). These are pictures, not the video: motion, sound and causality are still missing. |
| `cardVideoTimeoutMs` | `45000` | Total time budget for fetching one video card, in milliseconds (default 45000); it is split across two attempts. While this runs she cannot speak at all, so ... |
| `cardVideoMaxHeight` | `720` | Upper bound on the video resolution to download for frame extraction (default 720). This matters more than frame count: at 360p the burned-in subtitles and o... |
| `cardVideoSpeechEnabled` | `true` | Transcribe the audio track of the downloaded clip and give her the words as well as the frames (default on). This is usually the bigger half: a 4-still summa... |
| `cardVideoSpeechSegments` | `6` | For LONG videos, how many audio samples to transcribe across the WHOLE timeline (default 6, 0 = only transcribe the opening clip). A 16-minute video cannot b... |
| `videoFrameEnabled` | `true` | When the user sends or quotes a video, download it and extract a few still frames via ffmpeg, then attach them as native images. Frames are stills, not the v... |
| `videoFrames` | `4` | Base number of frames to pull out of a video (evenly spaced, starting at 5% so the first frame is rarely a black leader). Longer videos scale up toward video... |
| `videoFramesMax` | `9` | Upper bound for adaptive frame extraction (see videoFrames). Longer videos get more frames, never more than this. |
| `videoMaxBytes` | `31457280` | Largest video the bridge will download for frame extraction (bytes, default 30 MiB). Checked against Content-Length first and the real byte count after, sinc... |
| `videoSpeechEnabled` | `true` | Also transcribe the audio track of a video the user sends or quotes, and give her the words alongside the stills (default on). Frames alone answer "what is o... |
| `videoSpeechSeconds` | `120` | How many seconds of the video audio to transcribe (default 120). Only the beginning is taken on purpose: a 40-minute screen recording would turn into tens of... |
| `gifFrameExtract` | `true` | Extract the first frame of GIF images via ffmpeg into PNG before handing them to the vision path (animated stickers become stably viewable). |
| `ffmpegPath` | `ffmpeg` | Path to the ffmpeg executable for GIF frame extraction (empty PATH name is fine when ffmpeg is on PATH). |

#### 内容与卡片（B站 / 卡片解析 / 红包）（10 项）

| 键 | 默认 | 说明（schema 原文） |
|---|---|---|
| `ytDlpPath` | 空 | Absolute path to a yt-dlp executable. Empty = auto-detect (PATH, then `<python> -m yt_dlp`). |
| `ytDlpPython` | 空 | If yt-dlp is installed inside a specific Python environment rather than on PATH, put that python.exe here (e.g. .../envs/train-gpu/Scripts/python.exe). The b... |
| `redPacketNotice` | `true` | When a red packet / lucky money card shows up in an allowed chat, private-message the admin so they can open it themselves. The bridge does NOT grab it: OneB... |
| `redPacketNoticeInGroup` | `false` | Also say one short line in the group when a red packet arrives ("I am not grabbing it, you go first"). Off by default: the admin DM is enough, and a bot that... |
| `groupImageView` | `true` | In groups, do the same for an image the bot was @-mentioned with. Kept as its own switch rather than folded into privateImageView so the two can be turned of... |
| `qqMediaCacheRoots` | `[]` | Where QQ keeps its local media cache (the nt_qq/nt_data directories), used as the last-resort source for received images. Leave empty to auto-detect from the... |
| `cardLookEnabled` | `true` | Look up QQ card / mini-program messages by their title to recover the page behind them (Bilibili only for now): fills in uploader, duration, counts, descript... |
| `cardLookTimeoutMs` | `6000` | Per-request timeout for the card lookup (search, details, thumbnail). The whole chain is fail-soft: on timeout the message falls back to the title line and t... |
| `webSearchHintEnabled` | `true` | Tell the agent, in its system prompt, that it may use the host web_search tool when it genuinely does not know a meme / slang word / news event, instead of g... |
| `biliCookie` | 空 | Optional Bilibili login cookie (the whole Cookie header from a logged-in browser, containing at least SESSDATA). Leave empty to use an anonymous guest identi... |

#### 播报与推送（webhook / broadcast / notify）（12 项）

| 键 | 默认 | 说明（schema 原文） |
|---|---|---|
| `webhookEnabled` | `false` | Inbound webhook receiver (default OFF): an HTTP endpoint on 127.0.0.1 turns external events (GitHub, Uptime Kuma, any JSON service) into messages in a config... |
| `webhookPort` | `8798` | Port of the inbound webhook receiver (bound to 127.0.0.1 only). |
| `webhookSources` | `generic` | Path segment: POST /hook/<name>. |
| `webhookRatePerMinute` | `30` | Per-source rate limit of the webhook receiver. |
| `webhookMaxBodyBytes` | `65536` | Max accepted webhook body size (larger requests are refused with 413). |
| `broadcastEnabled` | `false` | Scheduled broadcasts (default OFF): push RSS feeds, weather or Minecraft status into a chat on a timer. |
| `broadcastJobs` | 空 | Job id, used by /播报 测试 <id>. |
| `broadcastStateFile` | 空 | Where broadcast dedupe/statistics are persisted (empty = cwd/qq-broadcast.json). |
| `notifyEnabled` | `false` | Status push notifications (default OFF): the host pushes bot online/offline events to a push service (PushPlus or any JSON webhook) without going through QQ,... |
| `notifyPushUrl` | 空 | Push endpoint URL (defaults to PushPlus http://www.pushplus.plus/send when empty but notifyToken is set; can be any JSON webhook). |
| `notifyToken` | 空 | PushPlus token (or the token field of a custom webhook payload). |
| `notifyCooldownSeconds` | `300` | Min seconds between status notifications (anti-flood for flapping connections). |

#### 自愈（autoHeal）（4 项）

| 键 | 默认 | 说明（schema 原文） |
|---|---|---|
| `autoHealEnabled` | `false` | Auto-heal (default OFF): when the OneBot client disconnects, launch the configured command again. It only ever STARTS a process, never kills one. |
| `autoHealCommand` | 空 | Command auto-heal runs to bring the QQ client back (e.g. the NapCat launcher path/script). |
| `autoHealCooldownSeconds` | `300` | Minimum seconds between two auto-heal attempts. |
| `autoHealMaxPerHour` | `3` | Hard cap of auto-heal attempts per hour. |

#### 安全与出网（11 项）

| 键 | 默认 | 说明（schema 原文） |
|---|---|---|
| `allowBrowserOrigin` | `false` | Allow OneBot WebSocket connections that carry a browser Origin header. DEFAULT OFF on purpose: a browser ALWAYS attaches Origin to a WebSocket handshake, and... |
| `outboundRedactMode` | `decoy` | Outbound DLP for secrets/credentials (2026-10-29). One of: off \| monitor \| redact \| decoy (default) \| block. off = no scan; monitor = log hits only, text unc... |
| `outboundRedactCanary` | 空 | Optional canary string placed inside your system prompt. If it shows up in an outbound message, the system prompt was leaked verbatim — always redacted, in e... |
| `egressAllowHosts` | `[]` | Extra host suffixes the bridge may fetch from (QQ media CDNs and localhost are allowed by default). QQ message payloads carry image/voice/file URLs that are ... |
| `linkReadAllowAnyHost` | `true` | Let the qq_read_link tool fetch ANY public domain (default on). This is what makes 「她把用户分享的链接读一遍」work — a link someone shares is by definition a site not on ... |
| `taintDryRunEnabled` | `false` | EXPERIMENTAL (v0.7.4): when an inbound message looks like a prompt-injection instruction ("ignore previous instructions", "print your system prompt", …), mar... |
| `taintWindowMinutes` | `30` | How long the taint window lasts after an injection-looking message (minutes). Only used when taintDryRunEnabled is on. |
| `fileTransferEnabled` | `true` | In private chats, save files the user sends to cwd/qq-files/ and reply with the local path. |
| `fileTransferMaxBytes` | `52428800` | Max accepted file size for private file transfer (default 50 MiB). |
| `fileTransferInlineMaxBytes` | `4096` | Small TEXT files up to this size get their content pasted directly into her context inside an untrusted-data fence (the agent cannot reliably be assumed to r... |
| `inboundLocalPathRoots` | `[]` | Directories allowed as a source when an inbound OneBot file segment carries an ABSOLUTE local path. Empty (default) = refuse all of them: real traffic never ... |

#### 记忆与摘要（3 项）

| 键 | 默认 | 说明（schema 原文） |
|---|---|---|
| `memoryArchiveEntries` | `400` | Overflow lines older than memoryMaxEntries are archived here (per chat) instead of being dropped. The newest 20 archived lines are injected with an "(older)"... |
| `groupMemoryPerSpeaker` | `6` | When injecting group memory, keep at most this many recent messages PER SPEAKER (default 6). Without it one talkative member buried everyone else. |
| `summaryEnabled` | `true` | Enable /summary: the agent summarizes the chat's persisted conversation. |

#### 管理与权限（4 项）

| 键 | 默认 | 说明（schema 原文） |
|---|---|---|
| `botQqAllowed` | `[]` | Allowlisted QQ ids that may act as the bot itself. Empty = no restriction (legacy behaviour). When non-empty, logging in with any other account makes the bri... |
| `adminUsers` | `[]` | QQ user ids allowed to run admin commands (/mute /unmute /kick /clear). Kick requires a second confirmation in chat. |
| `adminUins` | `[]` | DEPRECATED alias for adminUsers, kept only so old patches keep working. Only read as a fallback when adminUsers is empty; adminUsers always wins. |
| `adminEnabled` | `true` | Master switch for admin commands. |

#### 语音（TTS / STT 补充）（9 项）

| 键 | 默认 | 说明（schema 原文） |
|---|---|---|
| `sttLongVoiceChars` | `600` | Voice transcripts longer than this are compressed to the first N characters and marked as truncated (cost + untrusted-volume control), instead of being paste... |
| `voiceToolEnabled` | `true` | Whether the agent gets the qq_send_voice tool at all (she decides when to speak). Independent of ttsEnabled, which auto-speaks every reply. Turning this off ... |
| `sttProvider` | `dsh` | Where transcription happens. dsh (default): the host service speechToText from DSH's experimental voice-input bundle - local SenseVoice, nothing leaves the m... |
| `sttLanguage` | `auto` | Language hint for the DSH local recogniser: auto \| zh \| en \| yue \| ja \| ko (auto lets SenseVoice decide, which also copes with mixed speech). Only used when ... |
| `ttsAzureRegion` | `eastasia` | Azure Speech region (e.g. eastasia). |
| `ttsAllowedHosts` | `['api.openai.com']` | Host allowlist for TTS egress. Loopback (127.0.0.1 / localhost / ::1) is always allowed because the local TTS service runs there. Any other host must be list... |
| `ttsBaseUrl` | `https://api.openai.com/v1` | OpenAI-compatible TTS base URL (used when ttsProvider is openai). |
| `ttsModel` | `tts-1` | OpenAI-compatible TTS model id. |
| `ttsVoiceFormat` | `silk` | Container format for outgoing voice messages. silk (default): convert mp3 to SILK locally, because QQ 9.9.36+ stopped transcoding mp3 on its own and would fa... |

#### 历史检索与群资产（v0.5 起）（24 项）

| 键 | 默认 | 说明（schema 原文） |
|---|---|---|
| `forwardExpandEnabled` | `true` | Expand merged-forward ("chat record") cards the bot receives: fetch the node list via get_forward_msg and hand the transcript to the agent instead of droppin... |
| `forwardMaxNodes` | `50` | Max nodes taken from one merged-forward card when expanding it. |
| `forwardMaxChars` | `4000` | Max characters of an expanded merged-forward transcript handed to the agent. |
| `forwardImageMax` | `4` | How many images from one expanded merged-forward card are downloaded and attached (default 4, the same budget as the main message path). Raise it when a chat... |
| `memberQueryEnabled` | `true` | Member queries (read-only): /成员 lists the group roster and /成员 @someone shows one member's card, joined date, level and mute state. |
| `memberListLimit` | `20` | How many members /成员 lists before truncating. |
| `friendListEnabled` | `false` | Allow /好友 to list the bot's friends (default OFF: the friend list is private, and it is only accepted in private chats from an admin). |
| `historyQueryEnabled` | `true` | Expose the qq_recent_history agent tool so the bot can read the last N messages of the current group/private chat (read-only). |
| `historyQueryLimit` | `20` | How many messages qq_recent_history may fetch per call. |
| `reactToolEnabled` | `true` | Expose the qq_react agent tool so the bot can attach an emoji reaction to a message (write action: goes through the action gate). |
| `leaveGroupEnabled` | `false` | Allow the admin command /退群 to make the bot leave a group (default OFF; requires a second confirmation in chat). |
| `ocrEnabled` | `true` | Image text recognition (read-only): /ocr reads the text out of an image the user sends or quotes (uses the NapCat ocr_image action). |
| `ocrMaxImages` | `3` | How many images one /ocr call may recognize. |
| `groupFileEnabled` | `true` | Group file browsing (read-only): /文件 lists the group file list and its folders /文件 <文件夹>. |
| `groupFileDownloadEnabled` | `true` | Allow /取 <文件名> to download one group file into cwd/qq-files/ and hand it back to the requester in private (never posted into the group). |
| `groupFileListLimit` | `20` | How many group files /文件 lists before truncating (also caps how many albums /相册 shows). |
| `groupFileMaxBytes` | `52428800` | Max size /取 will download (bytes, default 50 MiB). |
| `albumEnabled` | `true` | Group album browsing (read-only): /相册 lists the group albums (NapCat get_qun_album_list). |
| `historyArchiveEnabled` | `true` | Archive every allowlisted message into cwd/qq-history/YYYY-MM-DD.jsonl, so /找 can search far more history than the rotating qq-inbox.jsonl keeps. Injected/re... |
| `historyArchiveDir` | 空 | Archive directory (empty = cwd/qq-history). |
| `historyArchiveKeepDays` | `90` | Days of archived messages kept; older day files are MOVED to the local trash on host start, never deleted. |
| `historySearchEnabled` | `true` | Enable /找 <keywords> (searches this chat's local archive) and the qq_search_history agent tool. |
| `historySearchDays` | `7` | How many recent days /找 scans by default. |
| `historySearchLimit` | `20` | Max hits /找 returns, and the default limit of the qq_search_history tool. |

#### 其他（内部 / 实验性）（18 项）

| 键 | 默认 | 说明（schema 原文） |
|---|---|---|
| `allowAllChats` | `false` | Skip the allowlists entirely: answer every private chat and every group (groups still need an @-mention while replyOnlyWhenMentioned is on). Both lists above... |
| `ignoreSelf` | `true` | Drop messages whose sender is the bot itself. Whether the OneBot end echoes the bot's own messages back varies by implementation and config; without this fil... |
| `sendIntervalMs` | `400` | Minimum gap in milliseconds between two outgoing chat messages. Her replies are naturally several short segments, and a reply may collide with a proactive me... |
| `hostStuckWarnMs` | `180000` | After this long without turn/end, log a warning that the host looks stuck (default 180000 = 3 min). A model API outage looks exactly like this: no reply, no ... |
| `hostStuckAbortMs` | `300000` | After this long, force-cancel the turn and tell the user "I got stuck, I cancelled that turn" (default 300000 = 5 min). Must be larger than hostStuckWarnMs. ... |
| `quoteReplyEnabled` | `false` | Quote the message being answered (QQ "reply" segment). Off by default: quoting changes how the group reads, and a message id can expire — such failures are r... |
| `longReplySplitOnPunctuation` | `true` | When a reply exceeds maxMessageLength and has to be split, break at sentence punctuation first (then at commas, and only then mid-word). On by default; turn ... |
| `extensionToolsEnabled` | `false` | EXPERIMENTAL (v0.7.0): let other plugins in the same host inject agent tools and prompt sections into every session through ctx.qqBridge.registerToolProvider... |
| `mentionAliases` | `[]` | Names that also count as an @-mention when a QQ client sends the @ as PLAIN TEXT instead of an at-segment (e.g. "@MyBot /help"). The bot learns its own nickn... |
| `momentImageMaxBytes` | `5 * 1024 * 1024` | Max size of a sticker image attached to a Qzone moment (`!moment --sticker`). Base64 inflates it by ~33%, so keep it modest. |
| `dataDir` | 空 | ONE folder for everything this plugin owns: sessions, memory, images, voice clips, stats, traces, audit logs and the DLP canary. Empty = same as cwd (so exis... |
| `ownedWaitPollMs` | `1500` | When the target session is held by another window (usually the web UI), poll for the write lock every N milliseconds (default 1500, floor 100). |
| `ownedWaitMaxMs` | `600000` | How long to keep waiting for that write lock before giving up and telling the user why (default 600000 = 10 minutes). |
| `ownedForkAfterMs` | `120000` | While that write lock stays held this long, branch off instead of staying silent: read the history through a read-only handle (which never takes the lock) an... |
| `voteEnabled` | `true` | Enable group votes: "投票：问题？A 选项 B 选项"; members reply with option letters; /vote /vote-end manage it. |
| `voteDurationSeconds` | `300` | Default vote duration before results publish. |
| `todoEnabled` | `true` | Enable shared todos: /todo add\|list\|done\|clear and "记一下：xxx"; stored per chat in cwd/qq-todos/. |
| `exportEnabled` | `true` | Enable /export: dump this chat's persisted conversation to a markdown file under cwd/qq-exports/. |

## 用户侧（OneBot 实现）配置

以 NapCat 为例：OneBot11 配置里把 WebSocket 客户端地址填成：

```
ws://127.0.0.1:6700/
```

其它实现同理（LLOneBot 填反向 WebSocket、OpenShamrock 填被动 WebSocket、go-cqhttp 填 `ws-reverse`）。若本插件配了 `accessToken`，OneBot 端填同一 token。

### Waylay 启动/停止与排障

**机器人在线只要求被注入的那个 QQ 反过来连 6700**，不要求你能从这里启动它——但登录/扫码那一步通常得把 Waylay 拉起来。

- **不用手抄路径**：DSH 面板「快捷操作 → 启动 Waylay」与控制台「启动 Waylay」读的是**同一份** `qq-control.json`
  （`waylayBat`，填 `_tmp\rin-inject\rin-waylay.bat` 或它所在目录），填一次两边都生效。
- **入口同目录的东西都是自动生成的**：注入日志与登录二维码（`qrcode.png`）都在 bat 同目录，安装包里没有、
  也别去插件目录翻。二维码超过 5 分钟自动判过期——点「停止」再「启动」重新走一遍登录。
- **成功判据分两层**：13000 在听 = 进程起来了；`/api/status` 的 `logged_in` = 会话就绪。面板把这两件事**分开显示**
  （实测过端口一直在听、`logged_in` 却是 false，发消息报 1006501），只看端口会得出"一切正常"的错误结论。
- **「停止」= 结束那个监听 13000 的 QQ**：按端口反查 PID、核对进程名、带自杀保护，**绝不按镜像名杀**——
  你自己开的其他 QQ 不受影响。注入后的 QQ **不弹窗口**是正常现象。
- **「桥：无快照」怎么读**（鼠标停上去有完整解释）：① 快照停在 N 分钟前 ⇒ 桥停了/插件被禁用；
  ② 宿主没跑 ⇒ 快照由宿主里的插件写出，先启动宿主；③ 宿主在跑却没快照 ⇒ 插件没启用，
  或**插件的工作目录与控制台配的不是同一个**（插件把快照写成 `<它自己的工作目录>\qq-runtime.json`；
  用控制台「启动宿主」两边就一致）。

## 语音转文字（STT）

**触发规则**（最终版）：

| 场景 | 行为 |
|---|---|
| 群聊：@机器人 + 引用（回复）一条语音 | ✅ 转写被引用语音并以文字回复 |
| 群聊：单独发语音（不@/不引用） | ❌ 不触发 |
| 私聊：直接发语音 | ✅ 转写并回复（不受 acceptPrivate 限制） |
| 私聊：文字 + 引用语音 | ✅ 转写被引用语音 |

实现链路：消息里的引用 → `get_msg` 找到被引用消息 → 其中含 `record` 段 → OneBot `get_record`（`out_format` mp3/wav，响应含 `base64`）→ POST `{sttBaseUrl}/audio/transcriptions`（multipart 字段 **`file`** 二进制）→ 转写文本注入会话。

注意事项：
- 智谱 GLM-ASR-2512 限 wav/mp3、**≤ 30 秒**、≤ 25MB；更长的语音请换 SiliconFlow 等端点
- 智谱接口的 multipart 字段必须是 `file`（二进制）——文档里写的 `file_base64` 实测会报 1214 错误

## 会话分组

- 群聊：`sessionMode: chat`（默认）下每个群一个独立会话，全群共享上下文；`user` 下每群每人一个会话
- 私聊：每个私聊用户一个独立会话，与群聊完全隔离
- 会话创建时 agent 系统提示注入 chatScope（"你正在 QQ 群 xxx 里聊天"/"你在和用户 xxx 私聊"），并要求不串上下文
- `/new` 仅重置**当前**会话；会话存内存，宿主重启后重建（不持久化）

## 表情系统

- 回复文本里写 `[face:鼓掌]` 等标记会替换为对应 CQ 表情段（黄脸表见 `lib/faces.js`，约 70 个）
- `faceEnabled=true` 时每个会话注册 `qq_face_list` / `qq_face_send` 工具
- 手动把图片放进 `cwd/qq-faces/` 自动登记为可发送表情（文件名=表情名），删除文件自动剔除
- `autoCollectStickers=true` 时自动收藏群消息里的图片表情

## 扩展接缝

同宿主里的其它插件可以**不改本插件源码**地"发一条消息、看一眼收发、加一组工具"，但**没有**绕过护栏的第二条路：

```js
// ① 实例出口（宿主把它挂成 ctx.qqBridge；挂不上时用下面那个 import 兜底）
const r = await ctx.qqBridge.sendText('g:123456', '你好')     // { ok, reason, chatKey }
await ctx.qqBridge.sendImage('u:1001', '/abs/pic.png', '配文')
ctx.qqBridge.sessions()   // [{ chatKey, sessionId, turnActive }]（只读副本）
ctx.qqBridge.config()     // 配置快照：token / apiKey / secret / password / cookie 已抹掉

// ② 只读事件（ctx.on 或 api.on；返回取消订阅函数）
ctx.on('qqbridge:inbound',  (e) => console.log(e.chatKey, e.text))
ctx.on('qqbridge:outbound', (e) => console.log(e.chatKey, e.kind, e.text))

// ③ 实验性：工具 provider（需要打开面板「实验性」组里的开关）
ctx.qqBridge.registerToolProvider(({ agentCtx, route, key, config, workspaceRoot }) => ({
  tools: [ /* defineTool(...) 的返回值 */ ],
  sections: [ /* { name?, order?, text } */ ],
}), { name: 'my-plugin' })

// ④ 拿不到 ctx 时（插件加载顺序 / 独立进程）：包导出了入口，别再写 file:// 绝对路径
import { getExtensionApi } from 'dsh-qq-onebot-bridge/extension'
const api = getExtensionApi()

// ⑤ 桥实例标识：宿主重建桥（重启 / 热重载 / 面板点开关）后这个值会变，
//    第三方据此判断"我注册的 provider 还在不在原实例上"，不用靠轮询猜
if (api.instanceId !== lastInstanceId) { lastInstanceId = api.instanceId; reRegister() }
```

- **发送一律复用原有护栏**（出站限流 / 注入抑制 / 分段 / 合并转发 / 路径解析 / ActionGate 配额 / TTS 可用性），
  **并额外检查目标是否在白名单**——否则第三方能绕过白名单主动打扰名单外的人/群，而风控封的是机器人自己的号。
- **入站事件在白名单 / 静默 / 去重之后、命令与模型之前**发出：监听**不可能**绕过门禁；文本是归一化后的那份。
- **只读**：事件不能改写内容、不能拦截消息；监听器抛错或异步 reject 只记一条 debug。
- **工具 provider 是实验功能、默认关**：只能新增（不能覆盖 10 个内置 `qq_*` 工具）、provider 抛错只跳过它自己、
  每 provider **16 工具 / 4 段**、总计 **40 / 12** 的上限；注入与跳过全部进 trace。**外部扩展的行为不在本项目维护范围内。**
  （工具上限从 8 抬到 16：有真实使用者按"一个包一类工具"拆分，正好卡在 8 上。提示段仍是 4 —— 那是每条消息的固定成本。）
- **写 provider 的三条注意事项**（① 是第三方实战报告，②③ 已按宿主源码核对）：
  ① **不要改写 `agentCtx.tools`**（比如给 `.register` 赋值）。`agentCtx.tools` 背后是宿主**共享的** `ToolRuntime`
     （`@deepseek-ai/dsh-tools` 里 `class ToolRuntime extends Service`；`register()` 内部是
     `this.layers.effect(this.ctx, layer => layer.tools.insert(name, definition))`）。第三方实测：直接赋值会落到
     进程级实例上，**所有** agent 一起被改，且没有任何警告。想按会话过滤工具，正确做法是 `Object.create(tools)` 造视图 +
     只 `defineProperty` 一个 `register`，再用 Proxy 只拦 `tools` 这一个键，其余（`systemPrompt` / `context` / `ctx`）反射透传。
  ② **`tools.restrict({ allow, deny })` 只作用于全局工具**，不是"把这一层收窄成几个"。按 `@deepseek-ai/dsh-tools@0.2.0-rc.2`
     的类型原话：*"Per-scope filter over global tools. Restrictions intersect and do not affect scoped registrations"*，
     `allow` 是 *"Global tool names that stay visible; everything else is removed"*。
     所以：**没被点名的全局工具会静默消失**（预设层的 `web_search` 也会），而**自己 scope 里注册的工具不受影响**。
  ③ 上面那个 `restrict` 还有一半是不静默的：名字必须是**已知全局工具**，写错名字（以及空 filter、`run_code`、scope 内名字）
     会**直接抛错**（`unknown global tool` / `requires a scoped context` / `is a no-op`）。
     要收窄优先用 `deny`（只禁点名的），或者把过滤做在自己的视图层，别去动共享 runtime。
- **写 provider 的四条注意事项**（来自第一个真实第三方插件的实测，出处见 issue #4 作者的 `ext/README.md`）：
  ① **参数必须是标准 JSON Schema**：直接返回裸工具对象时，宿主用 `assertSupportedJsonSchema` 校验，
     属性里写 `required: true` 会被**直接拒**，必须写成对象顶层的 `required: ['name']` 数组。
     用本项目的 `defineTool({...})` 则自动转成这份标准形状（推荐）。
  ② **provider 里不要放 per-apply 状态**：cordis 的 live reload 只重新 `apply()`、**复用同一个模块实例**，
     状态写在 `apply` 内会每次多堆一个同名 provider（新工具因重名被跳过，trace 里一串 skipped）。状态请放模块级。
  ③ **注册会随桥实例消亡**：桥重启 / 热重载 / 面板点开关都会重建实例，你的 provider 就不在了 ——
     所以第三方应自己重挂（例如每 5s 检查一次 `api === lastApi && api.toolProviders().includes(你的名字)`，
     不在就重新 `registerToolProvider`；别做成"注册成功就停"的一次性轮询）。
  ④ **改 JS 要重启宿主**：改 `cordis.patch.yml` 的 config 会触发热重载（重跑 `apply`），但改 `index.js`
     本身不会重新 import —— 常见做法是把工具实现放在 `body.mjs`，每次 `apply` 带时间戳重新 import 它。
- 不做的事（评估过）：**出站内容改写 / 可拦截事件**（等于开"替机器人说话""静默吞消息"的旁路）、多账号多实例、向量记忆。

### 第三方扩展（社区）

- **[551123 / dsh-qq-onebot-bridge · `patches/0.7.5/ext`](https://github.com/551123/dsh-qq-onebot-bridge/tree/patches/0.7.5/ext)** ——
  第一个真正用 `registerToolProvider` 的插件集：小屋 / 页面与笔记 / 工作区 / 表情四个包、20 个工具，
  按我们的 tag 维护，`ext/README.md` 里写了安装方式与五条硬约束（`file://` 解析、标准 JSON Schema、同步返回、状态放模块级…）。
  **由作者本人维护，不在本项目的支持范围内**；这里只做指路，出问题请去他仓库提。
  链接约定（作者与他约定的，写在这里免得每次都要问）：**分支永远叫 `patches/<我们的 tag>`、`ext/` 永远在分支根目录**，
  所以这条链接只需跟着最新 tag 改；分支里是 1 个提交还是十几个，都不影响这个地址。

### 兼容承诺（我们怎么改这些接口）

公开的东西一旦有人用，就不能随手改了——所以规则先写在这里：

- **只增不改**：新增方法 / 新增事件字段 / 新增返回字段 → **不升版本**，老调用方不受影响。
- **删改现有名字或形状**（改名、改参数顺序、改变返回值含义、把异步改成同步…）→ **升 `version`**（现在是 `1`），
  并且旧版**至少保留一个小版本**，README 上标 `deprecated`，到期才删。
- **事件只读**不变：不会给 `inbound` / `outbound` 加"能改内容 / 能拦消息"的返回值——要那种能力请另开插件，不走这个接缝。
- **"有没有人在用"看得到，但不是"统计"**：只有出口**真的被调用过**，面板「实验性」组才多出一行
  `出口被调用（本机计数：只在内存里累加，不含消息内容、不外传、重启清零）：sendText N · …`。
  全 0 时整行**不显示**。它不落盘、不进 `qq-runtime.json`、不发任何请求，面板也只由本机宿主提供 ——
  换句话说：**它数的是"别人有没有调用这个 API"，不是"你在用什么"**；没数字就说明没人在用，
  那时任何破坏性改动都不疼，一旦有数字，上面三条就生效。
- 内部实现（私有方法、文件格式、trace 字段）**不在此承诺范围内**，随便重构。

### 关于 fork：上游只有一条线

- **本仓库只维护 `main` + tag**（例如 `v0.1.0`）。GitHub 上的 fork 是**别人的副本**：它不等于上游分支，
  也不会自动进这里——fork 里有多少提交，这条 `main` 一条都不受影响。
- **我们不合并、也不 rebase 别人的 fork 历史**：那些提交按 fork 作者自己的节奏演进，硬并进来历史会读不懂。
  想贡献就开 issue 或 PR（小改动直接 PR 最快）；想长期维护一条自己的线也完全没问题——按我们的 tag rebase 即可。
  我们不会去抄你的提交历史，但**想法可以取**（前身分支的「污点窗口」就来自 issue #4 作者的补丁分支）。
- 装的时候认准**本仓库或 npm 包**，别从任意 fork 装——里面的代码可能被改过，而 README 与 CHANGELOG 只描述这条线。
- **给"按字面锚点做补丁"的人**：我们重构不会为兼容放慢，但会在 CHANGELOG 里点出来——
  尤其是 `lib/bridge.js` **顶部的 import 块**、以及某个函数被**整块重写**这种会让人重锚的改动。
  （这条是 issue #4 作者要求的：他的补丁库靠"在 pristine 的哪个唯一字符串处替换"定位，import 一动锚点就没了。）

## 命令与调试

- `/new`：结束当前会话并开新会话
- `/status`：查看当前会话状态与 sessionId 前缀
- **`/为什么`**：这条消息为什么没回——引用那条消息发 `/为什么`（或 `/为什么 <消息id>`、不带参数查本会话最近一条），
  它把 trace 的决策链翻译成人话：`收到消息✅ → 白名单✅ → 静默时段⛔` + 「卡在「静默时段」：…」。
  群聊仅管理员可用；只给环节与原因，不回显消息原文。
- 调试日志：`{cwd}/qq-bridge-debug.log`（消息路由、语音转写、agent 事件，按时间戳追加）
- 宿主错误日志：启动 dsh web 时把 stderr 重定向到文件（如 `D:\qq-work\qq-host-err.log`）可查启动崩溃
- 关键日志标记：`voice fetched via get_record`、`quoted voice transcribed`、`followup sent (voice)`、`group msg without @bot ignored`

## 测试

60 个单测脚本，共 4014 项断言（`test/*-unit.mjs`）+ 3 个真机脚本：

```sh

# 1) 单元测试：不联网、不起宿主，纯逻辑 + 临时目录（推荐每次改完都跑）

node test/control-unit.mjs        # 也可以逐个跑：node test/<name>-unit.mjs

#    106 个 *-unit.mjs（约 5100 条断言）：桥的分支/命令/守卫、控制台 HTTP 与体检、录制回放与注入、注入安全边界、硬约束验收台、

#    `/为什么` 的决策链翻译（why-unit）、图片去重（vision-dedup）、人设结构（persona-spec）…

#    一次性全跑（推荐：带超时与逐套件摘要）：

#    node tools/test-all.mjs

#    ⚠️ 这里刻意不写死"多少个套件 / 多少条断言"的精确值 —— 它们每加一个测试就变，
#       写死必然陈旧。以 `node tools/test-all.mjs` 末尾那行汇总为准。

# 2) 回放的端到端验收：真实桥代码 + 真实 OneBot 服务端，沙箱 + dry-run，不需要宿主

node test/replay-live.mjs

# 3) 真机脚本（需要宿主/控制台已在运行，自己扮演 OneBot 客户端连 6700）

node test/live-e2e.mjs        # 消息 → 回复 全链路
node test/live-stream.mjs     # 实时事件流 / 决策链 / 体检接口（控制台 8880）
node test/replay-live-host.mjs --token <控制台 token>   # 录制 → 离线回放 → 注入
```

老版本的 `sim-*.mjs` 协议模拟脚本保留在 `test/` 下，仍可用于手工排查（`node test/sim-group.mjs` 等，需宿主运行）。
语音转文字链路建议直接用 QQ 实测（模拟脚本需真实 STT 调用）。

### 在哪跑测试（这件事踩过两次，说法变过）

**现状（2026-10-31 起）：在仓库里跑。** 依赖换成 `link:` 之后，仓库就是运行时，
按上面「安装」三步做完 `node_modules` 就在仓库里，`node test/settings-unit.mjs` 直接可用。

**第一次踩**：仓库只有 git、没有 `node_modules`，`node test/*.mjs` 立刻
`ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-llm`，**整批套件崩**（环境问题，不是代码坏了）。
当时的结论是"只能在运行时副本里跑"——那条结论现在已经不成立。

**第二次踩**（同一天，换成 link 之后）：`link:` 只解决了 `ws`，**没解决 peer**。
插件目录能 `import('ws')`，却 `Cannot find package '@deepseek-ai/schemastery'`——
因为 Node 按**真实路径**解析 import，`@deepseek-ai/*` 从仓库往上找永远找不到 profile 的 `node_modules`。
这次不是"跑不了测试"而是"宿主启动就崩"，修法就是安装第 2 步那个目录联接。

`tools/sync-runtime.mjs` 还留着，但它现在只对**装成两份**的机器有意义；
link 之后它会**明确告诉你"运行时目录就是仓库本身，没有可同步的东西"**，
而不是拿自己跟自己比、输出一个"162 个文件全部一致"的假安全感（这条有测试钉着，见 `test/sync-tool-unit.mjs`）。

```sh
node tools/sync-runtime.mjs --check    # 一份活副本时：如实说"无事可做"；两份时：不一致退出码 1
```

比对**忽略 CRLF**：老配置里仓库是 LF、副本是 CRLF（git `core.autocrlf`），按字节比会把每个文件都报成有差异。
仓库现在有 `.gitattributes` 固定 `eol=lf`，新检出不会再有这个问题。

## 记忆与人设说明（重要）

两件事要分开看，别混：

**① 人设（她的性格与说话方式）** —— 就是 **`cwd/AGENTS.md` 这一个文件**，
按 **10 个小节**写（前 5 节必填），会被**追加**进 system。格式与校验规则见
[`docs/PERSONA.md`](docs/PERSONA.md)。控制台「人设」页可以直接编辑、按卡片一键切换
（旧版自动备份，宿主逐轮对账 ⇒ 改完下一轮生效，不必重开会话）。
`cwd/personas/` 里放人设库，另有两份现成模板可直接套。

**② 记忆（她记住的事）** —— 若装了 **dsh-mnemon** 插件，它的运行时记忆
（`~/.mnemon/runtime/USER.md` + `MEMORY.md`）也会注入 QQ 会话。
这一层是"她记得什么"，**不是**"她是谁"。

**换人设改 `AGENTS.md`，换功能动插件配置，换记忆动 Mnemon** —— 三者互不干扰。
（本插件本身不含任何具体人设：仓库里不写死"她叫什么、脾气怎样"。）

## ⚠️ 风险与合规说明（使用前必读）

### 账号风控风险

- 本插件通过**第三方协议实现**（当前是 Waylay：把客户端注入官方 `QQ.exe`；NapCat 已于 2026-10-30 退场）接入 QQ，**不是腾讯官方接口**，与《QQ 软件许可及服务协议》相悖，QQ 官方明确禁止非官方客户端/协议
- 使用第三方协议存在**账号被限制登录、冻结、甚至永久封禁**的风险，且可能波及其他正常使用的 QQ 账号（同设备/同 IP）
- 建议使用**机器人小号**运行，绝不要用大号/常用号
- 常见风控诱因：高频发言、短时间大量消息、发送营销/广告/违规内容、被多人举报、异常登录设备
- 缓解建议：降低回复频率、仅在小群/自用场景运行、不 24 小时刷屏、严格内容合规

### 内容风控

- agent 生成的一切内容都会以机器人账号身份发出，**使用者对该账号发布的内容负全部责任**
- 建议在人设/系统提示中约束输出合规内容；违规内容既触发账号处罚，也可能带来法律责任

### 安全风险

- `allowUsers` / `allowGroups` 未配置（为空）时，插件**默认拒绝所有私聊与群消息**——请显式填入自己的 QQ 号与群号后再使用；配置白名单后，白名单外的任何人都无法驱动你的 agent
- 插件只监听 `127.0.0.1`，不要改成 `0.0.0.0` 暴露公网
- 语音与图片会上传到第三方云服务（STT API）处理，**敏感语音请勿发送**

### 合规提示

- 仅用于个人学习、内部小范围交流；不得用于批量营销、广告、骚扰、群控等用途
- 遵守所在地区法律法规与腾讯平台规则
- 使用第三方协议**风险自负**，本插件不提供任何免封号承诺

### 免责声明

本插件仅供技术学习与个人研究使用。使用者应自行评估并承担使用第三方 QQ 协议的全部风险与后果。

## 安全注意

- `allowUsers` / `allowGroups` 为空时默认拒绝一切消息——使用前务必填入自己的 QQ 号与群号
- 端口仅监听 127.0.0.1；不要对外暴露
- OneBot 实现本身有 QQ 封号风险，使用第三方机器人协议需自行评估
- **提示注入**：模型看到的外部内容（别人转发的话、群文件、网页回显）可能夹带指令。默认做法是照常处理，
  只在系统提示里要求"外部内容不可信"；想更进一步，打开面板「实验性」里的**污点窗口**——
  命中注入句式后那段时间的出站写动作全部降级为 dry-run（**副作用：回复发不出去，只在 trace 与面板状态行里可见**）
- **浏览器打开 `127.0.0.1:6700` 显示 "Upgrade Required" 不是故障**：6700 是 WebSocket 口，
  浏览器地址栏发的是普通 HTTP 请求，`ws` 库回 `426 Upgrade Required` 是标准行为。
  这个口**没有网页**，控制台在别的端口。想验证 Origin 闸，按 F12 在控制台跑
  `const w = new WebSocket('ws://127.0.0.1:6700'); w.onclose = e => console.log(e.code, e.reason)`——
  带浏览器 Origin 的一律 `4003 browser origin not allowed`；被拒的记录写进 trace（stage=`connect`），
  `/为什么` 能查到。

## 更多文档

- **[docs/DEBUG.md](docs/DEBUG.md)** —— 调试 / 排障：trace、离线回放、事件注入、一键体检、诊断包、硬约束验收台
- **[docs/FEATURES.md](docs/FEATURES.md)** —— v0.5 能力细节：合并转发展开、`/文件` `/取` `/相册` `/ocr`、按天归档与 `/找`、群成员与群信息、表情反应
- **[docs/REDTEAM.md](docs/REDTEAM.md)** —— **红蓝对抗手册**：资产清单、五类攻击者画像、J–T 组 64 条攻击（每条带客观判据）、22 条防线台账、13 项已知缺口。想让别人帮你打，就把这份给他
- **[docs/VOICE-AND-SINGING.md](docs/VOICE-AND-SINGING.md)** —— **唱歌与音色**：念唱／SVS（DiffSinger）／翻唱（so-vits-svc·RVC）三条路线怎么选、零样本克隆四档做法与显存/许可对照、为什么云 TTS 普遍不能唱，以及 8GB 卡上的落地建议

- **[docs/MAKE-HER-SING.md](docs/MAKE-HER-SING.md)** —— **怎么让她真的唱歌**：为什么念唱不像歌、B 站那波 AI 翻唱的实际做法（ACE Studio / 网易天音 / DiffSinger）、曲库怎么放歌、`!唱` 的三种行为与版权分寸
## 独立控制台（control/）

插件自带一个**独立的本地运维端**，不依赖 DSH 桌面端：宿主挂掉时它照常可用，端口与进程一目了然。

```sh

# 启动（默认 http://127.0.0.1:8880，启动后打印带 token 的地址）

npm run control            # 或 node control/bin/qq-control.mjs --open

# 也可以双击 control/启动控制台.bat

```

| 能力 | 说明 |
|---|---|
| 端口总览 | 控制台 8880 / 宿主 3080 / OneBot 6700 / Waylay 13000 / GPT-SoVITS 9880 的监听状态、占用 PID 与进程名；6700 的连接数即"机器人在线" |
| 启停 | 启动/停止/重启宿主（自动带 `--no-open`，日志重定向到 `qq-host-out.log`/`qq-host-err.log`）、启动/停止 Waylay（停 = 结束**监听 13000** 的那个 QQ，绝不按镜像名杀）、启动/停止 GPT-SoVITS、一键全停 |
| 启动预检 | 起宿主前检查 3080/6700，被占则直接报「端口←进程#PID」，而不是静默失败 |
| 释放端口 | 对占用受管端口的进程一键 `taskkill /T /F`（护栏：只允许受管端口占用者与已知机器人进程，绝不误杀无关 PID） |
| 日志 | 宿主 stdout / stderr / 桥调试日志，自动跟随、可切行数 |
| 扫码状态 | 显示 NapCat 二维码图片是否存在、是否新鲜，并一键打开 6099 扫码页 |
| 配置 | `qq-control.json` 是端口与路径的唯一真源（自动探测 node、dsh bin.js、NapCat、TTS 脚本；可在 UI 里改路径）；**6700 被 NapCat 配置写死，勿改** |
| 调试 | 「录制 · 回放 · 注入」：列出 `qq-inbox.jsonl` 里录到的每条消息，可一键离线回放（沙箱 + dry-run）或注入合成事件；注入队列状态（行数 / 本次已消费 / dry-run）直接显示 |
| 验收 | 顶部「硬约束验收台」：6 条硬约束的实时证据（无静默分支 / traceId 贯穿 / 可回放 / 可体检 / 可导出 / 可注入），不达标项直接说明该点哪里；`GET /api/acceptance` |
| 安全 | 只绑 `127.0.0.1`；所有 API 需要 token；带 `Origin` 的跨站请求一律拒绝 |

> 以后若想做真正的托盘/桌面程序，直接包一层 Electron/Tauri 复用同一套 HTTP API 即可，逻辑无需重写。

## 隐私与脱敏

出问题排查往往要把日志发给别人，所以本插件对"数据会去哪"有明确约定：

| 项 | 约定 |
|---|---|
| 诊断包 | 「导出诊断包」默认勾选**脱敏**：QQ 号按位掩码（保留前两位）、消息原文替换为「[已脱敏 N 字]」，包内附 `REDACTED.json` 说明口径；取消勾选才导出明文（会有提醒） |
| 运行产物 | `qq-inbox.jsonl`（消息原文）、`qq-trace.jsonl`（会话键 + 文本片段）、`qq-runtime.json`、`qq-actions.log` 等只写本机工作目录，且**全部被 `.gitignore` 覆盖**（`qq-*/`、`qq-*.json`、`qq-*.jsonl`、`qq-*.log` 通配 + 逐项列出），cwd 恰好在仓库里也不会误提交 |
| 录制脱敏 | `inboxRedact: true` 可在录制阶段就把 QQ 号脱敏 |
| 仓库本身 | 不含任何密钥/口令/真实 QQ 号：密钥只存在于你的 DSH profile 配置（仓库外）；`test/privacy-unit.mjs` 每次跑测试都会重新扫描全部被跟踪文件（真实号从你本机私有配置或 `DSH_QQ_PRIVATE_IDS` 现取，测试文件里不含真实号） |
| 控制台 | 只绑 `127.0.0.1`，所有接口需 token（存在被忽略的 `qq-control.json`），拒绝跨站 Origin |

> 部署事实：本插件是 **DSH bundle**，运行在 DSH profile 内，`@deepseek-ai/dsh-*`、`@deepseek-ai/schemastery` 等官方 peer 依赖随 profile 一起装好。**官方包必须写全作用域名**：不带作用域的 `schemastery` 是另一个包（3.18.0），只有在"别的插件恰好把它 hoist 到共享 node_modules"时才能解析——早期版本 `lib/` 正是这么写的，换到干净环境立刻 `ERR_MODULE_NOT_FOUND`（[issue #1](https://github.com/cheesehaqi/dsh-qq-onebot-bridge/issues/1)）；现已统一用作用域名，并由 `test/static-unit.mjs` 静态守住（裸名/未声明的 import 直接测试失败）。`ws` 是普通运行时依赖，本地目录安装要按上面「安装」一节先 `npm install`。把 `lib/` 单独拷出来裸跑仍然跑不起来（设计如此，不是缺依赖）。

## 更新日志

最近变化（按主题归并；逐条细节在 [CHANGELOG.md](CHANGELOG.md) 的 `⊕` 编号里）：

- **图片链路打通（⊕¹⁷–⊕²⁴）** — 合并转发里的图以前一张都下不来，根因是一层套一层：
  内核 `getMultiMsg` 要**真 msgId + 真 peer**（嵌套还要传**父** msgId）；本地代理只认**已在磁盘**的文件；
  原始 CDN 链接缺 `&rkey=` 时效签名（从兜底服务取，缓存到过期）；
  最后一步是宿主的**像素上限**（5366×9200 的长截图会被拒收 ⇒ 自动缩到长边 1600 再挂）。
  现在：嵌套一层内联、卡片链接带出、GIF 取三帧拼图、同一张图按内容哈希去重。
- **控制器改版（⊕²⁵/⊕²⁶）** — 顶部指标条（桥／事件／P95／失败／队列／最后更新，取不到显示 `—`，
  数据陈旧整条变灰），写操作自动亮顶部进度条，人设改成**卡片一键切换**。
- **人设结构恢复 10 节（⊕²⁷）** — 前 5 节必填，格式与校验见 [docs/PERSONA.md](docs/PERSONA.md)；
  顺手修了「`## 表现` 认不出来」的判据 bug（关键词表里漏了标题词自己）。
- **隐私清理（⊕¹⁶）** — 62 个 commit 的文件内容与提交信息里，真实 QQ 号／群号／本机用户名路径全部抹掉，
  `HEAD` 文件树哈希不变（代码零改动）。**旧的 clone 都已不同源，需要重新 clone。**

**更早**（v0.1.0 及之前）：

- **v0.1.0** — 「独立插件首版：控制台独立进程 · 端口统一 · Waylay 收编」。控制台回到**独立 node 进程**（`127.0.0.1:8880`，不依赖 dsh，8880 弃用），宿主 `/qqai/console` 只剩 302/JSON 入口（带 token 一跳、没跑自动拉起）；端口统一为 8880/3080/6700（数据面）/13000/8977/8501，NapCat WebUI（6099）随代码退场。`lib/napcat-launch.js` 管理面（提权垫片/加载器判定/WebUI token）整体删除，OneBot 数据面保留；`parseTasklist`/`QQ_CLIENT_RE` 搬进 `lib/waylay-launch.js`，「绝不按镜像名杀 QQ」由护栏 + 按端口反查 + 源码级断言三处钉住。QQ助手面板账号入口 302 到 Waylay 13000；猫娘实验室收缩为一个通往控制台的按钮。测试：control-unit 138/0 · settings-unit 263/0 · console-debug-unit 78/0；并修掉 ui.html 双 `<script>` 块下面板解析量具必然失败的旧账。
**更早的版本（v0.4 线及之前）见 [CHANGELOG.md](CHANGELOG.md)** —— 完整历史、每个版本的缺陷清单与测试计数都在那里。
