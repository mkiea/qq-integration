# NapCat 依赖的许可与公开边界

> 2026-11-05 查证。**这是读许可原文后的理解，不是法律意见。**
> 原文：`https://github.com/NapNeko/NapCatQQ/blob/main/LICENSE`
> 标题：**Limited Redistribution License for NapCat**（不是 MIT / GPL），版权 © 2024 Mlikiowa。

## 一、许可原文的五条（摘录 + 直译）

| 条 | 原文要点 | 直译 |
|---|---|---|
| 1. Usage and Reproduction | Unauthorized use, reproduction, modification, or distribution **prohibited without explicit permission** | 未经作者明确许可，禁止使用/复制/修改/分发 |
| 2. Redistribution | Redistribution **permitted**, provided the **full text of this license is included** and **source and copyright clearly stated**. Minor modifications allowed for redistribution, but **the modified code must not be publicly released** | **允许再分发**，但必须附**完整许可全文**+标注**来源与版权**；允许小改，但**改过的代码不得公开发布** |
| 3. Non-Commercial | **not to be used for any commercial purposes** | **不得用于任何商业目的** |
| 4. Additional Permissions | 未明确授予的权利须向作者申请 | 兜底条款 |
| 5. Disclaimer | 按"现状"提供，无担保 | 免责 |

## 二、我们实际依赖的是什么

只有一个**注入原语**，两个文件：

| 文件 | 大小 | 我们改过吗 |
|---|---|---|
| `NapCatWinBootMain.exe` | 34 KB | **没有**（原样调用） |
| `NapCatWinBootHook.dll` | 21 KB | **没有**（只被加载） |

**NapCat 的 OneBot 实现（`napcat.mjs` 及其依赖）我们没有加载**（主方案走 Waylay）。
所以涉及 NapCat 的部分，**只有这两个未修改的二进制**。

## 三、公开的两种做法

### 做法 A（推荐）：仓库不含二进制，只写依赖说明

- 仓库里**不放**这两个文件，README 说明「需要一个注入器」并指向 NapCat 官方发布
- 用户自己下载、自己放
- **不触发许可第 2 条**（我们没有再分发），也就没有"附许可全文/标注来源/非商用"的负担

**代价**：多一步手工（和现在装 NapCat 一样）。

### 做法 B：把这两个文件打进发布包

- ✅ 允许（第 2 条明写 permitted）
- ⚠️ **必须同时做到**：
  1. 附上**完整许可全文**（`LICENSE` 文件一起放）
  2. **标注来源**：`NapNeko/NapCatQQ` + 版权 `© 2024 Mlikiowa`
  3. **保证这两个文件未被修改**（第 2 条后半句：改过的不得公开发布）
  4. **不得商用**（第 3 条）
- ⚠️ **风险**：一旦为了自研去改这两个文件，就**不能再公开**——这和"待剥离"的目标冲突

## 四、NapCat 许可管不到的那一层

**QQ 客户端本身是腾讯的软件**。NapCat 的许可只是**它自己**给我们的授权，**授权不了腾讯的条款**。

- 腾讯《QQ 软件许可及服务协议》通常禁止反向工程、修改客户端
- 注入 QQ 进程这件事的风险，**不因 NapCat 的许可而消失**
- 这一层**由使用者/分发者自行承担**，NapCat 的第 5 条免责也明确不担保

## 五、建议（意见，不是事实）

1. **走做法 A**：仓库不含那两个二进制，只写依赖
   - 唯一合规成本最低
   - 不被"非商用"绑住（将来要商业化也不用回头改）
   - 不被"改过不得公开"卡住（将来自研注入器时不用纠结）
2. 如果确实要打包（比如为了"开箱即用"）→ **做法 B 的四项条件一条都不能少**，并在 `NOTICE` 里写清
3. **无论哪种**，README 的「风险与合规说明」都要保留现有那段（账号风控 / 内容风控 / 安全风险）

## 六、待确认（我判断不了的）

- **"公开"是指仓库源码公开，还是发布一个带二进制的安装包？** 两者的合规成本差很多。
- 若将来自研注入器替换这 55 KB → 这整份文档可以降级成"历史依赖说明"。
