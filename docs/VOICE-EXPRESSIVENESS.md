# 说话怎么才生动：文献与工程实践

> 写于 2026-11-08。起因：语音被评「助手腔」；调了 rate/pitch 之后仍不对，
> 最后一句还出现「音调怪异」。本文把「生动」拆成可核对的能力项，并给出不依赖拍参数的结论。
>
> 口径：【官方】= 厂商文档/仓库 README 明写；【论文】= 同行评议论文摘要/正文；
> 【社区】= 第三方实测文章（数字互相矛盾，仅作参考）；【推算】= 我按接口与硬件推的，未实测。

## 0. 一句话结论

**我们现在的链路有硬天花板**：edge-tts 官方已移除自定义 SSML，只剩 `rate` / `volume` / `pitch`
三个**整段标量**——插不了停顿、做不了句级/词级韵律、没有情感 style。
「生动」不是把这三个数调对，而是三件事：**显式韵律约束、副语言、上下文情感**，三者都要模型侧支持。

## 1. edge-tts 到底能调什么【官方】

- PyPI `edge-tts 7.2.8` 与仓库 README 都写明：**自定义 SSML 支持已移除**。原因是微软服务端
  只接受 Edge 浏览器自己能生成的 SSML —— 单个 `<speak>` → 单个 `<voice>` → 单个 `<prosody>`，
  里面是转义后的纯文本。
- 因此可用的定制面只有三个参数，且都是整段：
  - `rate`：百分比，如 `+8%`
  - `volume`：百分比，如 `-10%`
  - `pitch`：频率，如 `-2Hz`
- 【推算】这意味着 `<break>`、`<mstts:express-as>`、句级 pitch 变化**都不可能**。
  我们做的 E 版「逐句合成再拼 mp3」是在绕过这个限制，代价是句间硬切——见 §6。

## 2. Azure SSML 能做什么【官方】

- `mstts:express-as` 支持 `style`（cheerful / sad / whispering / gentle / affectionate 等）、
  `styledegree`（0.01–2，默认 1）、`role`（年龄/性别扮演）。
- 支持 `<prosody rate/pitch/volume>`、`<break time>`、`<emphasis>`。
- 限制：style 与 role 只对**部分神经音色**生效，要按 voice list 查；无效 style 会被整段忽略。
- 【社区】某配音实测文章给的甜区：`styledegree 0.6–0.9`（<0.5 像念稿，>1.2 像话剧）、
  `rate 0.88–0.95`、转折前 `break 0.3s`、重点后 `0.5s`。这些是经验值，不是官方规范。

## 3. 论文怎么说「人味」从哪来【论文】

| 论文 | 关键结论 |
|---|---|
| **Context-Adaptive Emotional Speech Synthesis**（ChinaMM 2026） | 当前 TTS（含 CosyVoice2）**缺乏上下文约束时会「回归均值」**：生成统计上安全但平均、平的语调。给出显式韵律/副语言约束后，F0 曲线、重音、停顿才会跟着语境走。 |
| **FillerSpeech**（EMNLP 2025） | 人味很大程度来自 **filler**（嗯 / 啊 / 那个）。filler 自带音高与时长，需要专门控制；论文用 LLM 预测插入位置。 |
| **NVSpeech**（ICASSP 2026） | 中文副语言 6 类：叹气、清嗓、笑、停顿、啧、吸气。48,430 句人工标注 + 174,179 句自动标注；零样本 TTS 微调后可在**任意 token 位置**插入副语言。 |
| **SynParaSpeech**（ICASSP 2026） | 118.75 小时中文副语言数据；CosyVoice2 经 SFT + DPO，副语言质量 PMOS **1.88 → 3.46**。 |
| **Word-Level Emotional Expression Control**（NeurIPS） | utterance 级情感不够，词级才自然；**分段合成会产生边界不连续**，需要 transition smoothing。语速也能用 prompt token 插值做词级控制。 |

⇒ 三条共同结论：
1. 「平」不是 bug，是**缺少显式约束**时的默认行为（回归均值）。
2. 副语言（笑/叹气/呼吸/填充词）是自然度的大头，且**必须由模型生成**，不是后期能加的。
3. 分段拼接一定有接缝，需要平滑；所以「逐句合成再拼」不是免费的。

## 4. 三条可落地路线

| 路线 | 能做到什么 | 成本 | 主要风险 |
|---|---|---|---|
| **A. Azure SSML** | style + styledegree + break + emphasis，句级韵律 | 要 key；代码已支持 `ttsProvider=azure`，只需改 `buildAzureSsml` | 按量计费；style 受音色限制；国内区可用性要确认 |
| **B. CosyVoice2-0.5B（本地）** | 零样本克隆 + **instruct 情感/方言/语速/音量**；首包 ~150ms | Apache-2.0；0.5B 推理约 4–8GB 显存（8GB 贴边）；Windows 部署麻烦（Python 3.10 + pynini） | 环境折腾；中文韵律仍不如专门微调 |
| **C. GPT-SoVITS（本地，已有代码）** | 3–10s 参考音频克隆；**情绪/语速很大程度由参考音频决定** | 已有 `ttsProvider=local` 与 `buildLocalTtsRequest`；4GB 可训 | 参考音频的底噪/混响会被学进去；换情绪要换参考音频 |
| **D. edge-tts + 文本层设计** | 短句、语气词、省略号、控制句长；rate/pitch 小幅变化 | 零成本，今天就能做 | 天花板低：只能改「念什么」，改不了「怎么念」 |

## 5. 推荐顺序

1. **有 Azure key** → 走 A。改动最小、效果最确定：`buildAzureSsml` 加 `<break>`、
   按句包 `<mstts:express-as style=... styledegree=0.7>`，`rate` 收到 `-5% ~ +2%`。
2. **没有 key、想本地** → 走 C。代码已经支持 `ttsProvider: local`，缺的只是把 GPT-SoVITS
   跑起来 + 准备**不同情绪的参考音频**（平静/撒娇/生气各一条），按回复情绪选参考。
3. **追求最好、能折腾** → 走 B（CosyVoice2 instruct）。8GB 卡能跑 0.5B，但 Windows 部署要单开
   Python 3.10 环境。
4. **无论走哪条，D 都要做**：现在 `ttsMaxChars=120` 是硬截断，长句被砍会显得急；
   短句 + 语气词 + 省略号是唯一零成本的「像人」手段。

## 6. 关于「最后一句音调怪异」

不是音高参数没调好。E 版是**逐句合成 + mp3 字节拼接**，句间没有淡入淡出；
最后一句开头没有气口、前一句结尾没有留白，听起来就会「突然接上」。
NeurIPS 那篇专门做 transition smoothing，说明这是公认问题，不是我们独有的实现瑕疵。

⇒ 结论：**不要在拼接版上继续调参数**。要么整段合成（放弃句级变化），要么换支持 SSML/instruct 的后端。

## 7. 怎么评估（别再凭感觉）

- 主观：同一句台词做 4–6 个版本，盲听打分（MOS 1–5），至少 20 条；问「像不像人在说话」而不是「好不好听」。
- 客观（论文常用）：UTMOS（自然度预测）、emo2vec 情感识别准确率。
- 我们的实际判据只有一条：**还会不会被说「助手腔」**。

## 8. 与现有代码的接入点

- `lib/tts.js`
  - `buildAzureSsml()`：加 `<break>` / `<mstts:express-as>` / `<prosody>`（A 路线）
  - `synthesizeTts()` 的 `openai` 分支：把 `rate`/`pitch`/`volume` 传给本地服务（C/D 路线）
  - `buildLocalTtsRequest()`：加 `speed_factor` / `text_split_method`（GPT-SoVITS api_v2）
- `qq_chat/tts-server/server.py`
  - `synthesize()` 目前只收 `rate`；要支持 `pitch`/`volume` 才能用满 edge-tts 的能力
- 配置项建议：`ttsStyle`（已有）、`ttsStyleDegree`、`ttsRate`、`ttsPitch`、`ttsBreakMs`

## 9. 来源

- edge-tts PyPI 7.2.8 / README（自定义 SSML 已移除，仅 rate/volume/pitch）
- Microsoft Learn：`speech-synthesis-markup-voice`（express-as / styledegree / prosody / break）
- arXiv 2412.10117（CosyVoice 2：instruct 情感、流式、零样本）
- OpenReview/NeurIPS：Word-Level Emotional Expression Control in Zero-Shot TTS
- ACL Anthology 2025.emnlp-main.1730（FillerSpeech）
- ICASSP 2026：NVSpeech、SynParaSpeech
- ChinaMM 2026：Context-Adaptive Emotional Speech Synthesis（regression to the mean）
- 【社区】FlowPix / TrueSight 的 Azure 调参甜区（仅参考，未复核）
