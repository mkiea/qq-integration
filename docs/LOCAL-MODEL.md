# 本地模型（Ollama / 任意 OpenAI 兼容端点）

> 目的：让 QQ 这一侧可以跑**本机模型**，同时桌面端继续用云端模型 —— 两条线互不干扰。
> 研究时最要紧的是"同一条数据由哪个模型产生"能查得到，所以本文最后有归因说明。

## 1. 它靠什么接（别自己造轮子）

dsh 已经有现成的多提供方适配器：`@deepseek-ai/dsh-llm-pi-ai`，由 `@deepseek-ai/dsh-base`
**默认挂上**（休眠状态、零路由）。给它一份 provider 声明，路由就活了。

声明写在 profile 的 `cordis.patch.yml`（`~/.dsh/profiles/web/cordis.patch.yml`）：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      ollama:
        displayName: 本机 Ollama
        api: openai-completions
        baseURL: http://127.0.0.1:11434/v1
        models:
          - id: "qwen2.5:7b"
            name: Qwen2.5 7B Q4
            contextWindow: 32768
```

要点：

- `api` 必须写 `openai-completions`。自托管路由**没有目录默认值**，不写会被拒。
- `models` 必须非空。它是**整体替换**该路由的目录（不是追加）。
- **不要**写 `apiKeyEnv`。本机 Ollama 不收密钥；写了反而会走
  "已配置但无密钥"的语义（那是给需要鉴权的网关用的）。
- 设置面板「模型」页写的是同一个位置，两种改法等价。改完要重启宿主才生效。

## 2. 只让 QQ 走本地，桌面端不动

插件有两个配置键：

```yaml
- id: dsh-qq-onebot-bridge
  name: dsh-qq-onebot-bridge
  config:
    provider: ollama
    model: "qwen2.5:7b"
```

两者都留空 = 跟随宿主默认（`agent-default-model`，通常是云端）。
填了 = **这一侧覆盖**，QQ 用本地、桌面端仍用云端。

自检（私聊给机器人发）：

```
!model
```

会分开报三行 —— 实际生效 / 插件配置 / 宿主默认 —— 并说明来源。
纯读，不建会话、不发请求、不花 token。排查时先看这一条，比翻日志快。

> 为什么三个数要分开报：`provider` 为空**不等于**"默认"，它是"交给宿主决定"。
> 本地模型接不上时，第一件要分清的事就是"插件写错了"还是"宿主默认变了"。

## 3. 本机实测数据（2026-10-31，4060 Laptop 8GB + 33GB 内存）

| 模型 | 参数 | 体积 | 上下文 | 备注 |
|---|---|---|---|---|
| qwen2.5:1.5b | 1.5B | 1GB | 32k | 冒烟测试 |
| qwen2.5:3b | 3.1B | 2GB | 32k | 最快，中文一般 |
| qwen2.5:7b | 7.6B | 5GB | 32k | **能全进 8GB 显存，日常首选** |
| gemma4:12b | 11.9B | 8GB | 256k | 卡在显存边缘 |
| qwen3.6:latest | 36B | 24GB | 256k | 只能 CPU，很慢 |

实测结论（`qwen2.5:3b`，`/v1/chat/completions`）：

- **首次请求 42 秒** —— 那是把模型加载进显存，不是推理慢
- **热态请求 0.37 秒** —— 比云端还快
- **function calling 正常**：能返回标准 `tool_calls` + `finish_reason: "tool_calls"`

所以插件侧的命令、工具链在本地模型上是**可用**的，不需要降级。

## 4. 真正的代价是"换模型"，不是"跑模型"

8GB 显存同时只放得下一个模型。场景 A 用 7B、场景 B 用 12B，来回切一次就是
**重新加载几十秒** —— 这个代价比推理本身高两个数量级。

研究相关的建议：

- **一个实验周期只用一个模型**，别在 QQ 和桌面端挂不同模型（会互相踢出显存）。
- 需要常驻就设 `OLLAMA_KEEP_ALIVE=-1`（默认 5 分钟卸载），代价是显存一直被占着。
- 要对比多个模型，**分批次跑**（跑完 A 的全部样本，再换 B），不要逐条交替跑 ——
  后者每次都在付加载代价，且会让"耗时"这个变量混进结果。

## 5. 研究归因：这条回复是谁生成的

建会话时桥会往事件流写一条 `stage=model`：

```
本会话模型：ollama / qwen2.5:7b（插件配置覆盖）
data: { provider: "ollama", model: "qwen2.5:7b", overridden: true }
```

只在**建会话 / 恢复 / fork** 时写一次 —— 会话内模型不会变，每回合写一遍只会
把 trace 刷满，反而看不出哪条是切换点。要按模型切分数据，用这条事件当分界。

`overridden` 这个字段是刻意的：`false` 表示"跟随宿主默认"，那么**改宿主默认
会让历史数据的归因一起变**；`true` 表示这一侧的模型是钉死的。做长期实验应该用 `true`。

## 6. 已知边界

- 插件本身**不调模型**：它把消息转给宿主 agent，模型路由是宿主的事。所以"适配"
  能做的只有两件 —— 声明路由、说清来源。模型能力（上下文、工具调用、多模态）
  由模型自己决定，插件不猜、也不静默降级。
- 本地模型没有联网能力，`WebSearch` 类工具不可用（宿主层决定，非插件）。
- 写这份文档时只验到 `qwen2.5:3b` 的裸端点；`qwen3.6` 的 reasoning 字段形状
  没验过，若要用它的 thinking 需要另加 `compat.thinkingFormat`，**未验证前不要写进配置**。
