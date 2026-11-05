# 接别的 OneBot 实现（NapCat / LLOneBot / OpenShamrock / Lagrange / go-cqhttp）

> 2026-11-05。**桥本身是标准 OneBot 11 的「反向 WebSocket 服务端」，与具体实现无关。**
> Waylay 只是**默认**，不是唯一。

## 一、桥和实现的分工

```
任意 OneBot 11 实现 ──主动连──▶ 桥（:6700，反向 WS 服务端）
      ↑                              │
   它负责：协议翻译                它负责：路由/会话/记忆/闸门/工具
   （QQ ↔ OneBot 帧）              （与是哪个实现无关）
```

**判据**：只要 6700 上有 `ESTABLISHED`，桥就工作。**谁连上来的它不关心**。

## 二、接一个新实现：三步

### ① 在实现侧填反向 WS 地址

```
ws://127.0.0.1:6700/
```

| 实现 | 填在哪 |
|---|---|
| **NapCat** | 配置 → 网络配置 → 添加「WebSocket 客户端」，地址填上面这条 |
| **LLOneBot** | 设置 → 反向 WebSocket → 同上 |
| **OpenShamrock** | 填「被动 WebSocket」 |
| **Lagrange** | 配置 `implementations` → `ws-reverse` |
| **go-cqhttp** | `config.yml` 里 `servers[].ws-reverse.universal` |

### ② token 两边一致

桥侧 `accessToken` 非空时，实现侧填同一个 token。**空 = 不校验**（本机自用常见，但不安全）。

### ③ 配白名单

```yaml
allowUsers: [100000001]     # 你的号（占位）
allowGroups: [100000002]    # 要服务的群（占位）
```

⚠️ **空列表 = 全部拒绝**（不是"全部允许"）——这是最容易踩的一条。

## 三、接 NapCat 时的三个特有情况

### 1. 控制台的「启动 Waylay」按钮用不上

控制台把 **13000** 当作"Waylay 在跑"的信号。用 NapCat 时：

- `:13000` **永远不会出现** → 面板会显示「Waylay 未运行」
- **这不是故障**，忽略即可
- 桥的工作状态看 **`onebot` 那一行（6700 established）**，不是看 13000

### 2. NapCat 自己的启动方式

```bat
Desktop\NapCat\shell\launcher-user.bat
```

（这就是 `rin-waylay.bat` 注释里写的 fallback：回到 stock NapCat，可能要重新扫码登录）

### 3. NapCat 的许可

**不是 MIT**，是 `Limited Redistribution License for NapCat`（© 2024 Mlikiowa）：

- 再分发**允许**，但必须附**完整许可全文** + 标注**来源与版权**
- **改过的代码不得公开发布**
- **不得商用**

> 所以本项目**不打包 NapCat 的任何二进制**，只写"可以接"。详见 [LICENSING.md](LICENSING.md)。

## 四、协议层已经处理掉的实现差异

`lib/onebot.js` 里对这些差异有显式分支（不是"碰巧能跑"）：

| 差异 | 处理 |
|---|---|
| `segment.data` 有两种形态 | NapCat/LLOneBot 是 `{ data: '<json 字符串>' }`，也有直接塞对象的 → 两种都认 |
| `file` 字段语义不同 | NapCat 里常常只是文件名或 `xxx.mp4` 标识 → 不假设它是完整路径 |
| 私聊文件 `url` 为空 | 靠 `file_id` / `path` 走 `get_file` 兜底（`path` 可直接读本机） |
| 引用段的 id 空间 | 各实现对 `reply` 段 id 的解释不同（Waylay 有短 id 映射表，见 `waylay-src/PATCHES.md` ①） |

**没有覆盖到的**：某个实现私有扩展的段类型（`mface`、`markdown` 等）会被当成未知段跳过——桥的选择是**跳过而不是崩**。

## 五、验证接上了没有

```bash
# ① 6700 上有没有连接（关键判据）
netstat -ano | findstr :6700

# ② 桥有没有收到事件
tail -f qq_chat/qq-bridge-debug.log

# ③ 控制台看 onebot 行（别看 waylay 行）
curl -s --noproxy '*' -H "x-control-token: <token>" http://127.0.0.1:8880/api/status
```

**判据顺序很重要**：`onebot` 有 `established` = 通了。`waylay` 行只反映 Waylay 自己的控制台，与他人无关。

## 六、我不确定的部分

- **Lagrange / go-cqhttp** 的实际填法我只按它们的公开文档写，**没在本机验过**（本机只有 Waylay + NapCat）
- 某个实现如果**只支持正向 WebSocket**（桥去连它），本桥**不支持**——它是反向 WS 服务端
