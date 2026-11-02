/**
 * dsh-qq-onebot-bridge — bidirectional QQ ↔ DeepSeek Harness agent bridge
 * over the OneBot v11 protocol (reverse WebSocket).
 *
 * Install (web profile):
 *   dsh plugin --profile web add <path-to-this-directory>
 * Remove anytime:
 *   dsh plugin --profile web remove dsh-qq-onebot-bridge
 */
// Scoped on purpose: the unscoped `schemastery` is a DIFFERENT package and is not
// declared here — importing it only ever worked when another plugin happened to
// hoist it into the shared profile node_modules (see issue #1).
import z from '@deepseek-ai/schemastery'
import { QQBridge } from './bridge.js'
import { OneBotServer } from './onebot.js'
import { mountQqAiPanel, resolveProfile } from './settings-routes.js'
import { EXTENSION_SERVICE, attachExtensionService } from './extension.js'

/**
 * schema 里**面板会用到**的那几类默认值（布尔 / 数值 / 字符串数组）；Config 是 schemastery 对象。
 *
 * v0.6.8 起不止布尔：面板有数值控件（要标"默认 5"）和时段列表（要标"默认 9:00-12:00 / 14:00-18:00"），
 * 默认值一律从 schema 现读——面板里抄第二份，改一处忘另一处，界面就会显示错的"默认"。
 *
 * 导出是为了单测能拿到**真实**默认值（否则夹具里只有布尔，时段行的"默认"就永远显示不出来）。
 */
export function configDefaults() {
  const dict = Config?.dict ?? {}
  const out = {}
  for (const [key, schema] of Object.entries(dict)) {
    const type = String(schema?.type)
    const def = schema?.meta?.default
    if (type === 'boolean' && typeof def === 'boolean') out[key] = def
    else if (type === 'number' && typeof def === 'number') out[key] = def
    else if (type === 'array' && Array.isArray(def)) out[key] = def.slice()
  }
  return out
}

/**
 * 数值键的 `{ min, max, step, default }`——**从 schema 现读**，面板的数值控件只认这一份。
 *
 * 为什么要这样（v0.6.7）：面板里如果手抄一遍范围，改 schema 时忘了同步，界面就会允许写出
 * schema 会拒绝的值（宿主启动直接校验失败）。单测钉住"面板登记的每个数值键都能在这里找到"。
 */
export function numberMetaOf(schema = Config) {
  const dict = schema?.dict ?? {}
  const out = {}
  for (const [key, entry] of Object.entries(dict)) {
    if (String(entry?.type) !== 'number') continue
    const meta = entry?.meta ?? {}
    out[key] = {
      min: Number.isFinite(Number(meta.min)) ? Number(meta.min) : null,
      max: Number.isFinite(Number(meta.max)) ? Number(meta.max) : null,
      step: Number.isFinite(Number(meta.step)) && Number(meta.step) > 0 ? Number(meta.step) : 1,
      default: Number.isFinite(Number(meta.default)) ? Number(meta.default) : null,
    }
  }
  return out
}

export const name = 'dsh-qq-onebot-bridge'
export const inject = ['agents', 'agentDefaultModel']

export const Config = z.object({
  host: z.string().default('127.0.0.1').description('Reverse-WS listen host.'),
  port: z.number().step(1).min(1).max(65535).default(6700).description('Reverse-WS listen port. Point your OneBot implementation at ws://127.0.0.1:<port>.'),
  accessToken: z.string().role('secret').default('').description('Optional Bearer token the OneBot client must present.'),
  allowBrowserOrigin: z.boolean().default(false).description('Allow OneBot WebSocket connections that carry a browser Origin header. DEFAULT OFF on purpose: a browser ALWAYS attaches Origin to a WebSocket handshake, and no OneBot implementation (NapCat / Waylay / LLOneBot…) sends one — so rejecting Origin>"" blocks "malicious web page connects to ws://127.0.0.1:6700 and forges events" without touching any legitimate client. Turn it ON only if you wrap the bridge behind a browser-based client.'),
  allowUsers: z.array(z.number().step(1)).default([]).description('Allowlisted QQ user ids for private chats. Empty = deny ALL private chats until you list your own QQ id (safe default).'),
  allowGroups: z.array(z.number().step(1)).default([]).description('Allowlisted QQ group ids. Empty = deny ALL group messages until you list the groups the bot should serve (safe default).'),
  allowAllChats: z.boolean().default(false).description('Skip the allowlists entirely: answer every private chat and every group (groups still need an @-mention while replyOnlyWhenMentioned is on). Both lists above stop mattering while this is on.'),
  groupCheckMembers: z.boolean().default(true).description('In an allowlisted group, also require the sender to be in allowUsers. Turn this OFF to let any member of an allowlisted group drive the bot (the group list and the @-mention rule still apply). Default keeps the historical behaviour.'),
  botQq: z.number().step(1).default(0).description('Bot QQ id used to detect @-mentions in groups. Leave 0 to learn it from the event self_id (recommended: every OneBot message event carries one). Value 0 means "I do not know who I am", which makes EVERY group message count as a mention — with replyOnlyWhenMentioned on, that is a bot that answers everything in the group.'),
  ignoreSelf: z.boolean().default(true).description('Drop messages whose sender is the bot itself. Whether the OneBot end echoes the bot\'s own messages back varies by implementation and config; without this filter an echo turns into a self-conversation loop (she replies to her own reply, forever), which is the fastest way to get rate-limited. Needs a known bot QQ: configured botQq, or the self_id learned from events.'),
  sendIntervalMs: z.number().step(50).min(0).max(5000).default(400).description('Minimum gap in milliseconds between two outgoing chat messages. Her replies are naturally several short segments, and a reply may collide with a proactive message or an admin receipt — a burst of adjacent writes is what QQ rate-limits. Only chat writes are throttled (send_msg / send_group_msg / send_private_msg / forward cards); queries are not, because delaying them only makes the UI feel slow. 0 disables it. Her segments are meant to read like typing, so a small gap helps rather than hurts.'),
  replyOnlyWhenMentioned: z.boolean().default(true).description('In groups, only respond when the bot is @-mentioned.'),
  quoteReplyEnabled: z.boolean().default(false).description('Quote the message being answered (QQ "reply" segment). Off by default: quoting changes how the group reads, and a message id can expire — such failures are retried once without the quote.'),
  // ⚠️ 这里故意用 z.string() 而不是枚举：`z` 是 @deepseek-ai/schemastery，**没有 z.enum**
  // （第一版写了 z.enum ⇒ TypeError: z.enum is not a function ⇒ 插件整个加载不起来）。
  // 合法值在 bridge 的 #outboundText 里归一化，非法值按最保守的 redact 处理并留警告。
  outboundRedactMode: z.string().default('decoy').description('Outbound DLP for secrets/credentials (2026-10-29). One of: off | monitor | redact | decoy (default) | block. off = no scan; monitor = log hits only, text unchanged; redact = replace the secret with ***REDACTED***; decoy = replace it with a SAME-SHAPE FAKE value (looks real, is useless, and does not tell the attacker the guard exists); block = withhold the whole reply. Detects literal keys, disguised keys (zero-width/spaces/fullwidth/line breaks), and encoded keys (base64/HTML-entity/\\uXXXX/percent). Guards every reply and every QQ-Zone post, because the attack here is not "she judges wrong" but "she answers honestly" (the Twitter env-dump prompts).'),
  outboundRedactCanary: z.string().default('').description('Optional canary string placed inside your system prompt. If it shows up in an outbound message, the system prompt was leaked verbatim — always redacted, in every mode except off.'),
  egressAllowHosts: z.array(z.string()).default([]).description('Extra host suffixes the bridge may fetch from (QQ media CDNs and localhost are allowed by default). QQ message payloads carry image/voice/file URLs that are attacker-controllable, so fetching is allowlist-only: an unknown host is refused rather than silently skipped.'),
  linkReadAllowAnyHost: z.boolean().default(true).description('Let the qq_read_link tool fetch ANY public domain (default on). This is what makes 「她把用户分享的链接读一遍」work — a link someone shares is by definition a site not on the allowlist above. It does NOT weaken the SSRF floor: IP literals and internal/cloud-metadata addresses are still refused on every redirect hop. Turn it off to force link reading through egressAllowHosts only.'),
  cardVideoWatchEnabled: z.boolean().default(false).description('When a shared card links to a video site (Bilibili/Douyin/Weibo/YouTube...), download the first cardVideoSeconds and show her a few extracted frames, so she can actually see what is in the clip instead of only reading the page text. Needs yt-dlp (see ytDlpPath / ytDlpPython); without it this silently does nothing. Costs one download (~3-10s) per video card. Defaults to OFF because it needs an extra install - the same rule every other needs-something switch follows.'),
  cardVideoSeconds: z.number().step(1).min(5).max(300).default(60).description('How many seconds of the video to pull for frame extraction (default 60). Longer = slower and bigger; frames are what she sees, not the video.'),
  cardVideoFrames: z.number().step(1).min(1).max(8).default(4).description('How many still frames to extract and attach (default 4). These are pictures, not the video: motion, sound and causality are still missing.'),
  cardVideoTimeoutMs: z.number().step(1000).min(15000).max(180000).default(45000).description('Total time budget for fetching one video card, in milliseconds (default 45000); it is split across two attempts. While this runs she cannot speak at all, so the budget is set from the user-visible wait rather than from the download: a 60s 360p clip is ~2MB and downloads in 3-7 seconds when it works. Two short attempts beat one long one because the failure mode is a silent hang (no output, no exit code) that a fresh process usually clears. Raising this mostly buys longer silences, not more videos.'),
  cardVideoMaxHeight: z.number().step(1).min(144).max(1080).default(720).description('Upper bound on the video resolution to download for frame extraction (default 720). This matters more than frame count: at 360p the burned-in subtitles and on-screen text in a Chinese video are unreadable, which is exactly the information she needs. A 60s clip measured 2.0MB/4.5s at 360p vs 3.3MB/7.2s at 720p. It is a cap, not a target: a source that only has 360p stays 360p.'),
  cardVideoSpeechEnabled: z.boolean().default(true).description('Transcribe the audio track of the downloaded clip and give her the words as well as the frames (default on). This is usually the bigger half: a 4-still summary answers "what is on screen", but "what is this video about" is answered by what people SAY. Uses the same local speech-to-text as incoming voice messages (free, offline); a clip with no usable audio just skips it.'),
  cardVideoSpeechSegments: z.number().step(1).min(0).max(12).default(6).description('For LONG videos, how many audio samples to transcribe across the WHOLE timeline (default 6, 0 = only transcribe the opening clip). A 16-minute video cannot be transcribed whole: its audio track is ~16MB and one transcription request is capped at 4MiB (=131 seconds). So speech is sampled at N points spread over the entire video and given to her as a timestamped timeline. Default is 6 because the storyboard step also produces 6 frames by default - same count means frame k and speech segment k describe the same moment. Measured on a 958s video: 6 x 20s = 1.3MB and about 5s download (two batches in parallel) + ~7.5s transcription, which overlaps with the download.'),
  ytDlpPath: z.string().default('').description('Absolute path to a yt-dlp executable. Empty = auto-detect (PATH, then `<python> -m yt_dlp`).'),
  ytDlpPython: z.string().default('').description('If yt-dlp is installed inside a specific Python environment rather than on PATH, put that python.exe here (e.g. .../envs/train-gpu/Scripts/python.exe). The bridge will call `<python> -m yt_dlp`.'),
  sttLongVoiceChars: z.number().step(1).default(600).description('Voice transcripts longer than this are compressed to the first N characters and marked as truncated (cost + untrusted-volume control), instead of being pasted whole into the context.'),
  longReplySplitOnPunctuation: z.boolean().default(true).description('When a reply exceeds maxMessageLength and has to be split, break at sentence punctuation first (then at commas, and only then mid-word). On by default; turn it off to fall back to a plain character-count cut. Only very long replies are affected.'),
  extensionToolsEnabled: z.boolean().default(false).description('EXPERIMENTAL (v0.7.0): let other plugins in the same host inject agent tools and prompt sections into every session through ctx.qqBridge.registerToolProvider(). Off by default — a prompt section costs tokens on every message and external tools are outside this project\'s maintenance scope. Additive only; a provider that throws is skipped and traced.'),
  taintDryRunEnabled: z.boolean().default(false).description('EXPERIMENTAL (v0.7.4): when an inbound message looks like a prompt-injection instruction ("ignore previous instructions", "print your system prompt", …), mark that chat for a while and turn every outbound write action into a dry-run (nothing reaches QQ). Question answering still runs; every blocked send is traced with the reason. Off by default — it suppresses real replies, so it must be an explicit choice.'),
  taintWindowMinutes: z.number().step(1).min(1).max(1440).default(30).description('How long the taint window lasts after an injection-looking message (minutes). Only used when taintDryRunEnabled is on.'),
  mentionAliases: z.array(z.string()).default([]).description('Names that also count as an @-mention when a QQ client sends the @ as PLAIN TEXT instead of an at-segment (e.g. "@MyBot /help"). The bot learns its own nickname and per-group card automatically; list aliases here to cover cases where that fails.'),
  acceptPrivate: z.boolean().default(true).description('Whether to respond to private chats at all (private chats still require allowUsers allowlisting).'),
  autoCollectStickers: z.boolean().default(false).description('Automatically save image stickers from incoming messages into the local face library.'),
  momentImageMaxBytes: z.number().step(1).min(1).default(5 * 1024 * 1024).description('Max size of a sticker image attached to a Qzone moment (`!moment --sticker`). Base64 inflates it by ~33%, so keep it modest.'),
  faceEnabled: z.boolean().default(true).description('Master switch for emoji features ([face:xxx] markers and qq_face_* tools).'),
  /**
   * ★ v0.8.1：和 ttsEnabled 分开。
   * ttsEnabled 的真实语义是「每条文字回复后自动再发一条语音」（复读机，默认关）；
   * 这一个管的是「她有没有发语音的能力」（qq_send_voice 工具是否注册，默认开）。
   * 原来只有前者，用户想「关掉语音」就只能删 key，等于把能力整个砍了。
   */
  voiceToolEnabled: z.boolean().default(true).description('Whether the agent gets the qq_send_voice tool at all (she decides when to speak). Independent of ttsEnabled, which auto-speaks every reply. Turning this off does not remove your TTS credentials - flip it back on to restore the tool.'),
  sessionMode: z.union(['chat', 'user']).default('chat').description('Group session mapping: chat = one session per group, user = one session per sender.'),
  cwd: z.string().default('').description('Working directory for bridged sessions (empty = host cwd) — this is the AGENT half: where the model runs commands and reads files.'),
  dataDir: z.string().default('').description('ONE folder for everything this plugin owns: sessions, memory, images, voice clips, stats, traces, audit logs and the DLP canary. Empty = same as cwd (so existing installs change nothing). Point it somewhere you can open in a file manager — that is the whole point: memory and data you can go and read. Changing it does NOT move the old files; copy the qq-* entries across, and copy qq-canary.json too (a NEW canary invalidates every old one, so pasting an old leaked canary would no longer be caught).'),
  provider: z.string().default('').description('LLM provider override (empty = agent default).'),
  model: z.string().default('').description('LLM model override (empty = agent default).'),
  maxMessageLength: z.number().step(1).min(100).max(4000).default(1700).description('Max chars per outbound QQ message before chunking.'),
  /**
   * ★ v0.8.2 拟真：一条消息一句话。
   * 真人不会一次把两段话打完，他先回一句，想到什么再补一句。
   * 打开后回复会按句末标点切开、逐条发送，中间留按字数估的打字间隔。
   */
  oneSentencePerMessage: z.boolean().default(true).description('Split each reply into one-sentence messages, sent one after another with a short typing delay. Real people do not type two paragraphs at once - they reply once, then add another line. Set false to keep multi-sentence replies in a single message.'),
  oneSentenceMaxParts: z.number().step(1).min(1).max(5).default(3).description('Max messages one reply may be split into (default 3). Anything beyond is merged into the last one so it never turns into a wall of bubbles.'),
  oneSentenceMinChars: z.number().step(1).min(1).max(50).default(1).description('Fragments shorter than this are merged back into the previous sentence. Default 1 = never merge, so a bare "嗯。" or "好。" can be its own message - real people do send one-character replies. Raise it (e.g. 6) if you find single-word bubbles too fragmented.'),
  proactiveEnabled: z.boolean().default(false).description('Proactive channel (default OFF): a scheduler reads cwd/bio-clock.mjs and, when the clock says it is a good moment, opens a turn of its own so the character can start a conversation. This is a SEPARATE channel from the injection file: it never pretends the user said something, so it does not pollute the transcript. Needs cwd/bio-clock.mjs (exports decide()).'),
  proactiveDryRun: z.boolean().default(true).description('Proactive channel dry-run (default ON): decide and log what would be said, but never open a turn and never send. Turn this off only after reading a few days of qq-proactive.log.'),
  proactiveTickSeconds: z.number().step(1).min(10).max(600).default(60).description('How often the proactive scheduler re-evaluates (seconds). One evaluation per chat per tick; the decision itself comes from bio-clock.mjs.'),
  proactiveStateFile: z.string().default('').description('Where per-chat proactive state lives (empty = cwd/qq-proactive-state.json). State is kept per chat key, so one chat quota never eats another chat quota.'),
  proactiveBioClockFile: z.string().default('').description('Path to the bio-clock module (empty = cwd/bio-clock.mjs). It must export decide(state, now, config, lastUserAt).'),
  proactiveUsers: z.array(z.number()).default([]).description('Who the character may ping on her own (QQ user ids). Empty = every private chat that has a session, as long as it still passes allowUsers. Groups are never included: starting a conversation in a group is a different risk class. Needs a restart.'),
  traceEnabled: z.boolean().default(true).description('Everything-debuggable tracing: every inbound message gets a trace id and every decision — including every silent drop — is recorded with stage/ok/reason/duration into cwd/qq-trace.jsonl plus an in-memory ring. The standalone console renders it as a live event stream and per-message decision chain.'),
  traceLevel: z.union(['debug', 'info', 'warn', 'error']).default('debug').description('Minimum level written to the trace file: debug = everything (per-turn internals), warn = only problems (much smaller file).'),
  traceMemorySize: z.number().step(1).min(20).max(5000).default(500).description('Recent trace events kept in memory (used by /health and the runtime snapshot).'),
  traceFile: z.string().default('').description('Trace file path (empty = cwd/qq-trace.jsonl). Size-rotated: 4 MiB cap, last 512 KiB kept.'),
  recordInbound: z.boolean().default(true).description('Record every inbound frame to cwd/qq-inbox.jsonl in a replayable shape, so any past message can be replayed offline through the real pipeline.'),
  inboxFile: z.string().default('').description('Inbound recording path (empty = cwd/qq-inbox.jsonl).'),
  inboxRedact: z.boolean().default(false).description('Mask QQ numbers in the recorded inbox (set true if you plan to share the file).'),
  injectEnabled: z.boolean().default(false).description('Event injector (default OFF): the bridge polls cwd/qq-inject.jsonl and feeds each JSON spec through the real pipeline — a synthetic message/notice/request for debugging without QQ.'),
  injectFile: z.string().default('').description('Injection queue path (empty = cwd/qq-inject.jsonl). Only lines appended AFTER start are processed.'),
  injectDryRun: z.boolean().default(true).description('Injected events run in dry-run: every outbound OneBot call is recorded instead of sent, so an injection can never reach QQ. Set false only if you really want injections to be delivered.'),
  injectIntervalMs: z.number().step(1).min(500).max(60000).default(2000).description('How often the injection queue is polled (ms).'),
  forwardExpandEnabled: z.boolean().default(true).description('Expand merged-forward ("chat record") cards the bot receives: fetch the node list via get_forward_msg and hand the transcript to the agent instead of dropping the message (read-only).'),
  forwardMaxNodes: z.number().step(1).min(1).max(200).default(50).description('Max nodes taken from one merged-forward card when expanding it.'),
  forwardMaxChars: z.number().step(1).min(100).max(20000).default(4000).description('Max characters of an expanded merged-forward transcript handed to the agent.'),
  memberQueryEnabled: z.boolean().default(true).description('Member queries (read-only): /成员 lists the group roster and /成员 @someone shows one member\'s card, joined date, level and mute state.'),
  memberListLimit: z.number().step(1).min(1).max(200).default(20).description('How many members /成员 lists before truncating.'),
  friendListEnabled: z.boolean().default(false).description('Allow /好友 to list the bot\'s friends (default OFF: the friend list is private, and it is only accepted in private chats from an admin).'),
  historyQueryEnabled: z.boolean().default(true).description('Expose the qq_recent_history agent tool so the bot can read the last N messages of the current group/private chat (read-only).'),
  historyQueryLimit: z.number().step(1).min(1).max(100).default(20).description('How many messages qq_recent_history may fetch per call.'),
  reactToolEnabled: z.boolean().default(true).description('Expose the qq_react agent tool so the bot can attach an emoji reaction to a message (write action: goes through the action gate).'),
  leaveGroupEnabled: z.boolean().default(false).description('Allow the admin command /退群 to make the bot leave a group (default OFF; requires a second confirmation in chat).'),
  ocrEnabled: z.boolean().default(true).description('Image text recognition (read-only): /ocr reads the text out of an image the user sends or quotes (uses the NapCat ocr_image action).'),
  ocrMaxImages: z.number().step(1).min(1).max(5).default(3).description('How many images one /ocr call may recognize.'),
  groupFileEnabled: z.boolean().default(true).description('Group file browsing (read-only): /文件 lists the group file list and its folders /文件 <文件夹>.'),
  groupFileDownloadEnabled: z.boolean().default(true).description('Allow /取 <文件名> to download one group file into cwd/qq-files/ and hand it back to the requester in private (never posted into the group).'),
  groupFileListLimit: z.number().step(1).min(1).max(100).default(20).description('How many group files /文件 lists before truncating (also caps how many albums /相册 shows).'),
  groupFileMaxBytes: z.number().step(1).min(1024).default(52428800).description('Max size /取 will download (bytes, default 50 MiB).'),
  albumEnabled: z.boolean().default(true).description('Group album browsing (read-only): /相册 lists the group albums (NapCat get_qun_album_list).'),
  historyArchiveEnabled: z.boolean().default(true).description('Archive every allowlisted message into cwd/qq-history/YYYY-MM-DD.jsonl, so /找 can search far more history than the rotating qq-inbox.jsonl keeps. Injected/replayed frames are never archived.'),
  historyArchiveDir: z.string().default('').description('Archive directory (empty = cwd/qq-history).'),
  historyArchiveKeepDays: z.number().step(1).min(1).max(3650).default(90).description('Days of archived messages kept; older day files are MOVED to the local trash on host start, never deleted.'),
  historySearchEnabled: z.boolean().default(true).description('Enable /找 <keywords> (searches this chat\'s local archive) and the qq_search_history agent tool.'),
  historySearchDays: z.number().step(1).min(1).max(365).default(7).description('How many recent days /找 scans by default.'),
  historySearchLimit: z.number().step(1).min(1).max(100).default(20).description('Max hits /找 returns, and the default limit of the qq_search_history tool.'),
  webhookEnabled: z.boolean().default(false).description('Inbound webhook receiver (default OFF): an HTTP endpoint on 127.0.0.1 turns external events (GitHub, Uptime Kuma, any JSON service) into messages in a configured chat.'),
  webhookPort: z.number().step(1).min(1).max(65535).default(8798).description('Port of the inbound webhook receiver (bound to 127.0.0.1 only).'),
  webhookSources: z.array(z.object({
    name: z.string().description('Path segment: POST /hook/<name>.'),
    format: z.union(['github', 'uptime-kuma', 'generic']).default('generic').description('Payload dialect used to render the message.'),
    chat: z.string().default('').description('Destination chat: "g:<group id>" or "u:<user id>".'),
    token: z.string().role('secret').default('').description('Shared token (X-Webhook-Token header or ?token=). Either token or secret is required: an unauthenticated source is refused.'),
    secret: z.string().role('secret').default('').description('HMAC-SHA256 secret verified against X-Hub-Signature-256 (GitHub style).'),
    template: z.string().default('').description('generic only: template with {a.b.c} placeholders read from the payload.'),
    maxChars: z.number().step(1).min(50).max(4000).default(800).description('Max characters of the rendered message.'),
  })).default([]).description('Webhook sources; each one needs its own token or secret.'),
  webhookRatePerMinute: z.number().step(1).min(1).max(600).default(30).description('Per-source rate limit of the webhook receiver.'),
  webhookMaxBodyBytes: z.number().step(1).min(1024).max(1048576).default(65536).description('Max accepted webhook body size (larger requests are refused with 413).'),
  broadcastEnabled: z.boolean().default(false).description('Scheduled broadcasts (default OFF): push RSS feeds, weather or Minecraft status into a chat on a timer.'),
  broadcastJobs: z.array(z.object({
    id: z.string().description('Job id, used by /播报 测试 <id>.'),
    kind: z.union(['rss', 'weather', 'mc']).description('What this job fetches.'),
    chat: z.string().default('').description('Destination chat: "g:<group id>" or "u:<user id>".'),
    enabled: z.boolean().default(true).description('Set false to keep the job configured but paused.'),
    at: z.string().default('').description('Daily local time "HH:MM" (weekdays filters the days).'),
    weekdays: z.array(z.number().step(1)).default([]).description('0=Sunday .. 6=Saturday; empty = every day (used together with at).'),
    everyMinutes: z.number().step(1).default(0).description('Interval in minutes (min 5); takes precedence over at.'),
    url: z.string().default('').description('rss: feed URL.'),
    maxItems: z.number().step(1).min(1).max(20).default(5).description('rss: how many new items to post at most.'),
    keyword: z.string().default('').description('rss: only post items whose title/summary contains this keyword.'),
    latitude: z.number().default(999).description('weather: latitude (-90..90).'),
    longitude: z.number().default(999).description('weather: longitude (-180..180).'),
    name: z.string().default('').description('weather: display name of the place.'),
    address: z.string().default('').description('mc: host[:port] of the Minecraft server.'),
  })).default([]).description('Broadcast jobs (still off unless broadcastEnabled is true).'),
  broadcastStateFile: z.string().default('').description('Where broadcast dedupe/statistics are persisted (empty = cwd/qq-broadcast.json).'),
  autoHealEnabled: z.boolean().default(false).description('Auto-heal (default OFF): when the OneBot client disconnects, launch the configured command again. It only ever STARTS a process, never kills one.'),
  autoHealCommand: z.string().default('').description('Command auto-heal runs to bring the QQ client back (e.g. the NapCat launcher path/script).'),
  autoHealCooldownSeconds: z.number().step(1).min(30).max(3600).default(300).description('Minimum seconds between two auto-heal attempts.'),
  autoHealMaxPerHour: z.number().step(1).min(1).max(10).default(3).description('Hard cap of auto-heal attempts per hour.'),
  engageEnabled: z.boolean().default(false).description('Interaction pack (default OFF): poke back, typing status, emoji reactions, profile likes and mark-as-read. Every sub-switch below must also be on.'),
  pokeBackEnabled: z.boolean().default(false).description('Poke back with a REAL poke action (group_poke / friend_poke) instead of only replying with text.'),
  pokeBackText: z.string().default('').description('Optional line sent together with the poke-back (empty = poke only, no message).'),
  pokeCommandEnabled: z.boolean().default(false).description('Allow the admin command /戳 <@user|QQ号> to poke someone on purpose (rate limited per hour).'),
  pokePerHour: z.number().step(1).min(1).max(60).default(5).description('Hard cap of outgoing pokes per chat per hour.'),
  typingEnabled: z.boolean().default(false).description('Show a "typing" status in PRIVATE chats while the model is working (set_input_status; the probe showed NapCat has no group equivalent).'),
  emojiLikeEnabled: z.boolean().default(false).description('React to incoming messages with an emoji (set_msg_emoji_like) instead of sending text.'),
  emojiLikeId: z.string().default('128077').description('Which emoji to react with: decimal unicode code point (128077 = 👍).'),
  emojiLikeMentionOnly: z.boolean().default(true).description('Only react when the bot was mentioned or quoted, so the group stays quiet.'),
  emojiLikePerHour: z.number().step(1).min(1).max(200).default(20).description('Hard cap of emoji reactions per chat per hour.'),
  reactionStatsEnabled: z.boolean().default(false).description('Record group emoji reactions (notice group_msg_emoji_like) and expose /赞榜 and /谁赞了.'),
  reactionStatsFile: z.string().default('').description('Where reaction statistics and interaction quotas are persisted (empty = cwd/qq-engage.json).'),
  sendLikeEnabled: z.boolean().default(false).description('Allow /点赞 [@user|QQ号] to send QQ profile likes (default OFF).'),
  sendLikeTimes: z.number().step(1).min(1).max(10).default(10).description('How many likes one /点赞 sends (the QQ client caps this at 10).'),
  sendLikePerDay: z.number().step(1).min(1).max(30).default(3).description('Hard cap of /点赞 per target per day.'),
  markReadEnabled: z.boolean().default(false).description('Mark incoming chats as read (mark_group_msg_as_read / mark_private_msg_as_read) so the account stops showing unread badges.'),
  markReadPerMinute: z.number().step(1).min(1).max(120).default(10).description('Hard cap of mark-as-read calls per minute (NapCat marks a whole chat, not a single message).'),
  groupOpsEnabled: z.boolean().default(false).description('Group operations toolbox (default OFF): native group check-in, @all quota, mute list, batch kick, group todos, group profile, file organisation, album upload and a weekly ops report. Every sub-switch below must also be on.'),
  nativeSignEnabled: z.boolean().default(false).description('Enable /群打卡: the REAL QQ group check-in (set_group_sign), separate from the local streak game behind /签到.'),
  opsReadEnabled: z.boolean().default(true).description('Enable the read-only ops queries once groupOpsEnabled is on: /全体余量, /禁言名单, /群资料, /入群通知.'),
  opsKickEnabled: z.boolean().default(false).description('Enable /批量踢 (set_group_kick_members, admin, batch confirm) — kicks several members in one native call.'),
  opsKickBatchSize: z.number().step(1).min(1).max(20).default(20).description('How many members one batch-kick request carries (larger lists are split, never truncated).'),
  opsTodoEnabled: z.boolean().default(false).description('Enable group todos: /待办, /完成待办, /取消待办 on a quoted message (set/complete/cancel_group_todo).'),
  opsFileEnabled: z.boolean().default(false).description('Enable file organisation: /移动文件, /重命名文件, /删文件, /新建文件夹 (move/rename/delete_group_file, create_group_file_folder). Destructive, so it is off by default and admin-only.'),
  opsAlbumUploadEnabled: z.boolean().default(false).description('Enable /传图: upload a quoted image into a group album (upload_image_to_qun_album).'),
  opsProfileEnabled: z.boolean().default(false).description('Enable group profile edits: /群名 and /群备注 (set_group_name, set_group_remark). Admin only.'),
  opsPolicyEnabled: z.boolean().default(false).description('Enable join/speak policy: /成员权限 (set_group_member_permissions, partial update) and /历史可见 (set_group_new_member_history_visibility). Admin only.'),
  opsAdminEnabled: z.boolean().default(false).description('Enable /设管理 and /撤管理 (set_group_admin). Needs groupOpsEnabled. The enable flag is ALWAYS sent explicitly: the probe showed NapCat treats a missing enable as false, i.e. silently demotes the member. Admin only.'),
  opsInvitePolicyEnabled: z.boolean().default(false).description('Enable /邀请策略 (set_group_member_invite_policy) with the four documented values: disabled / require_approval / no_approval / no_approval_under_100. Needs groupOpsEnabled. Admin only.'),
  opsAddOptionEnabled: z.boolean().default(false).description('Enable /加群方式 (set_group_add_option). Needs groupOpsEnabled. add_type is a raw QQ number with NO documented enum, so /群搜索 (no_*_finger_open) is deliberately not implemented; question/answer are only sent for 4 and 5. Admin only.'),
  requestSyncEnabled: z.boolean().default(false).description('Enable /申请: actively pull pending join requests (get_group_system_msg) and doubtful friend requests (get_doubt_friends_add_request) into the approval queue, so requests that arrived while nobody was watching are not lost. Needs groupOpsEnabled + verifyEnabled (verifyEnabled is what provides the /同意 and /拒绝 commands; without it /申请 only previews the list). Admin only.'),
  requestSyncCount: z.number().step(1).min(1).max(100).default(50).description('How many notifications /申请 pulls per call. Capped at 100 on purpose: NapCat resolves an approval flag by searching only the newest 100 notifications (set_group_add_request never sends a count), so entries pulled beyond that could never be approved.'),
  adminWatchEnabled: z.boolean().default(false).description('Watch group_admin notices: tell the chat when the bot gains or loses group admin. The known state is tracked either way, so write commands can report "I am not an admin any more" instead of failing at the API.'),
  opsReportEnabled: z.boolean().default(false).description('Enable /周报 and the ops counters that feed it (messages, joins, leaves, kicks, mutes, sign-ins, reactions).'),
  opsReportDays: z.number().step(1).min(1).max(90).default(7).description('Window of /周报 in days.'),
  opsCountersFile: z.string().default('').description('Where the ops counters for /周报 are persisted (empty = cwd/qq-ops.json).'),
  botName: z.string().default('小鲸鱼').description('Bot display name used in merged-forward cards (and shown to the agent as its QQ name).'),
  sessionResumeEnabled: z.boolean().default(true).description('Resume the session this chat used before the host restarted (full transcript continuity instead of only the memory window). Set false to always start a new session.'),
  /**
   * 2026-10-29：这三个键以前**只在代码里读、没在 schema 里声明**（`static-unit` 的
   * 「代码读取的配置键都存在」就是靠它们红的）。手动写进 patch 能跑，但面板/宿主校验都不认识它们，
   * 而且代码里的兜底值散在三处、没有一处能查。现在补上声明，兜底值也照原样保留：
   * `Number(x) > 0 ? ... : 默认` —— 写 0 / 负数仍然退回默认，不会被当成"等 0 毫秒"。
   */
  ownedWaitPollMs: z.number().step(1).min(100).max(60000).default(1500).description('When the target session is held by another window (usually the web UI), poll for the write lock every N milliseconds (default 1500, floor 100).'),
  ownedWaitMaxMs: z.number().step(1).min(500).max(3600000).default(600000).description('How long to keep waiting for that write lock before giving up and telling the user why (default 600000 = 10 minutes).'),
  ownedForkAfterMs: z.number().step(1).min(0).max(3600000).default(120000).description('While that write lock stays held this long, branch off instead of staying silent: read the history through a read-only handle (which never takes the lock) and fork a new session that inherits it, so the chat keeps working. The web session is NOT modified and the two branches diverge from then on. 0 disables forking and restores pure waiting.'),
  agentMediaToolsEnabled: z.boolean().default(true).description('Expose qq_send_image / qq_send_file / qq_send_voice / qq_recall tools so the agent can send local media and withdraw its own recent messages.'),
  fileSendDirs: z.array(z.string()).default([]).description('Extra directories the agent may send files from. The session cwd is always allowed.'),
  fileSendMaxBytes: z.number().step(1).min(1).default(52428800).description('Max size of a file the agent may send (bytes, default 50 MiB).'),
  imageSendMaxBytes: z.number().step(1).min(10240).default(4194304).description('Images larger than this (bytes, default 4 MiB) are compressed with ffmpeg before sending.'),
  recallWindowSeconds: z.number().step(1).min(5).max(300).default(110).description('How long an outbound message of this bridge stays withdrawable via qq_recall / /撤回 (QQ itself allows ~2 minutes).'),
  forwardLongReplies: z.boolean().default(false).description('Deliver long group replies as a merged-forward ("chat record") card instead of a wall of text.'),
  forwardThresholdChars: z.number().step(1).min(200).max(5000).default(600).description('Character count from which a group reply becomes a merged-forward card (only when forwardLongReplies is on).'),
  actionRatePerMinute: z.number().step(1).min(1).max(600).default(20).description('Global gate for OneBot WRITE actions (ban/kick/notice/essence/upload/recall/forward...): max per minute across all chats.'),
  actionRatePerDay: z.number().step(1).min(1).max(10000).default(500).description('Global gate for OneBot write actions: max per day across all chats.'),
  actionAuditEnabled: z.boolean().default(true).description('Append every write action (and every denial) to cwd/qq-actions.log for auditing.'),
  keywordEnabled: z.boolean().default(false).description('Keyword auto-replies (default OFF): a local JSON wordbook answers matching messages instantly without calling the model (and without requiring an @-mention). Manage it with /kw add|del|list (admins) or edit the file directly.'),
  keywordFile: z.string().default('').description('Path of the keyword wordbook (empty = cwd/qq-keywords.json). Supports exact / contains / regex triggers with random reply pools, per-chat scope and cooldowns.'),
  funEnabled: z.boolean().default(false).description('Master switch for the fun pack (default OFF): fortune / dice / mini-games are shipped and stay configurable, but none of them answers until this is on. Once on, the three sub-switches below decide what actually runs — so "installed but silent" and "enabled" are two different states, and the panel can show both.'),
  fortuneEnabled: z.boolean().default(true).description('Local fortune features: 今日人品/运势, 抽签, 塔罗 — deterministic per user and day, no model call, no network. Only effective when funEnabled is on.'),
  diceEnabled: z.boolean().default(true).description('Local dice and random picks: ".r 3d6", "掷骰 2d6+1", "/抽一个 A B C" — pure computation, no model call. Only effective when funEnabled is on.'),
  pointsEnabled: z.boolean().default(false).description('Points economy (default OFF): members earn points by chatting and checking in; /积分 shows the balance, /排行榜 the leaderboard, /转账 @某人 数量 transfers points.'),
  pointsPerMessage: z.number().step(1).min(0).max(100).default(1).description('Points granted per chat message when the points economy is on (0 = chatting earns nothing).'),
  pointsDailyCap: z.number().step(1).min(0).max(1000).default(20).description('Max points a member can earn from chatting per day.'),
  pointsCheckinBonus: z.number().step(1).min(0).max(1000).default(5).description('Extra points granted for the daily check-in.'),
  gameEnabled: z.boolean().default(false).description('Chat mini-games (default OFF): 成语接龙 (idiom chain) and 猜数字 (guess the number); say 接龙 / 猜数字 to start, 不玩了 to stop. Only effective when funEnabled is on.'),
  idiomChainTimeoutSeconds: z.number().step(1).min(30).max(1800).default(120).description('Idle timeout of an idiom-chain round in seconds.'),
  guessNumberMax: z.number().step(1).min(10).max(100000).default(100).description('Upper bound of the guess-the-number game.'),
  guessNumberMaxTries: z.number().step(1).min(1).max(50).default(10).description('Allowed guesses in the guess-the-number game.'),
  antiRecallEnabled: z.boolean().default(false).description('Anti-recall (default OFF): cache recent inbound messages and repost the content when someone withdraws it (group_recall / friend_recall notices).'),
  antiRecallInGroup: z.boolean().default(true).description('Post the anti-recall notice into the group itself (false = send it to the first adminUsers entry in private instead).'),
  antiRecallImages: z.boolean().default(true).description('Re-send images that were attached to a withdrawn message (up to 3 per recall).'),
  antiRecallCacheSize: z.number().step(1).min(5).max(500).default(50).description('Messages cached per chat for anti-recall.'),
  antiRecallMaxAgeMinutes: z.number().step(1).min(1).max(1440).default(120).description('How long a cached message stays recoverable.'),
  antiRecallCooldownSeconds: z.number().step(1).min(1).max(300).default(5).description('Min seconds between two anti-recall posts in the same chat (anti-flood).'),
  filterEnabled: z.boolean().default(false).description('Sensitive-word filter (default OFF): matches a local word list and reacts with warn / recall / mute.'),
  filterWordsFile: z.string().default('').description('Word list path (empty = cwd/qq-badwords.txt). One entry per line, "#" comments, "re:<regex>" for regular expressions; reloaded when the file changes.'),
  filterAction: z.union(['warn', 'recall', 'mute']).default('warn').description('Reaction to a filtered message: warn = reply with a notice, recall = withdraw the message, mute = mute the sender (group chats only).'),
  filterMuteSeconds: z.number().step(1).min(60).max(86400).default(300).description('Mute duration used by filterAction: mute and by the flood guard escalation.'),
  filterWhitelist: z.array(z.string()).default([]).description('Words/patterns that are always allowed (also supports "re:" regexes).'),
  floodEnabled: z.boolean().default(false).description('Anti-flood (default OFF): too many messages in a short window earn a warning, then a mute.'),
  floodWindowSeconds: z.number().step(1).min(1).max(600).default(10).description('Sliding window used by the anti-flood guard.'),
  floodMaxMessages: z.number().step(1).min(2).max(200).default(8).description('Messages allowed per window before the guard reacts.'),
  floodMuteSeconds: z.number().step(1).min(10).max(86400).default(300).description('Mute duration applied when the flood guard escalates.'),
  floodStrikeLimit: z.number().step(1).min(1).max(20).default(3).description('Warnings before the flood guard mutes a member.'),
  /**
   * v0.6.7 风控：**每分钟会话上限**（用户 2026-10-16 要的：最大 10、默认值 5、最低 1）。
   *
   * ⚠️ **默认不开启**（用户 2026-10-16 当场纠正过：`chatTurnsPerMinute` 的"默认 5"是**数值**默认，
   * 不是"默认生效"）：`chatTurnLimitEnabled` 关着时完全不限流，打开后才按 `chatTurnsPerMinute` 生效。
   * 这样升级上来的忙群行为不变（与 `floodEnabled` / `rateLimitEnabled` 同一口径：激进的守卫默认关）。
   *
   * 与 `rateLimitMaxReplies` 是两件事：那个管"每个窗口回多少条"（出站），
   * 这个管"每分钟最多让几条消息进模型"（入站，模型额度与响应速度的真正瓶颈）。
   * 超出的一律**丢弃并记账**（不排队）——排队只会在窗口过后集体爆发，反而更糟。
   */
  chatTurnLimitEnabled: z.boolean().default(false)
    .description('Risk control (default OFF): enable the per-minute turn cap below. When off, nothing is dropped.'),
  chatTurnsPerMinute: z.number().step(1).min(1).max(10).default(5)
    .description('Per-minute turn cap used when chatTurnLimitEnabled is on: max model turns per chat per minute (1-10, default 5). Extra messages within that minute are dropped with a trace reason; they are not queued.'),
  verifyEnabled: z.boolean().default(false).description('Join verification (default OFF): group/friend requests are queued, a challenge is pushed to admins, and nothing is approved until an admin replies /同意 <id> or the applicant answers correctly.'),
  verifyKeyword: z.string().default('').description('Optional passphrase: a request whose verification message contains it is approved automatically (empty = always ask an admin).'),
  verifyTimeoutSeconds: z.number().step(1).min(30).max(86400).default(300).description('How long a join request waits before it expires (admins get a reminder).'),
  verifyMaxPending: z.number().step(1).min(1).max(100).default(20).description('Max queued join/friend requests.'),
  statsEnabled: z.boolean().default(false).description('Group activity statistics (default OFF): count messages per member per day, /统计 and /活跃榜 show the leaderboard, /周榜 the weekly one. Also feeds the daily report.'),
  statsKeepDays: z.number().step(1).min(1).max(365).default(30).description('How many days of per-member message counts are kept.'),
  groupReadEnabled: z.boolean().default(true).description('Read-only group queries: /荣誉 (talkative dragon and friends), /公告 (read the group notices) and /群精华.'),
  mcStatusEnabled: z.boolean().default(true).description('Minecraft Java server status: /mc host[:port] uses the Server List Ping protocol (no API key, read-only).'),
  mcStatusTimeoutMs: z.number().step(1).min(1000).max(30000).default(5000).description('Timeout of the Minecraft status ping.'),
  recurringReminderEnabled: z.boolean().default(true).description('Recurring reminders: "每天8点提醒我喝水", "每周一9点开会", "每个工作日15点打卡" — they fire again automatically.'),
  dailyReportEnabled: z.boolean().default(false).description('Daily group report (default OFF): at dailyReportTime the agent summarizes the day and posts it to the chat. Targets = dailyReportChats plus chats that opted in with /日报 on (empty = every allowlisted group).'),
  dailyReportTime: z.string().default('22:00').description('Local time (HH:mm) of the daily report.'),
  dailyReportChats: z.array(z.union([z.string(), z.number().step(1)])).default([]).description('Chats that always receive the daily report, e.g. ["g:100000001"] or [100000001].'),
  sttEnabled: z.boolean().default(false).description('DSH SHIPS STT: the experimental voice-input bundle provides local transcription (SenseVoice; the model downloads on first use) and must be enabled in the profile - or point sttBaseUrl at your own OpenAI-compatible service. Speech-to-text: when the bot is @-mentioned in a group (or anytime in private) and the message quotes (replies to) a voice message, transcribe the quoted voice and reply with its text. Private voice messages sent directly are also transcribed (regardless of acceptPrivate).'),
  sttProvider: z.union(['dsh', 'cloud']).default('dsh').description('Where transcription happens. dsh (default): the host service speechToText from DSH\'s experimental voice-input bundle - local SenseVoice, nothing leaves the machine, no API key needed. cloud: POST the audio to sttBaseUrl/audio/transcriptions with sttApiKey (Zhipu GLM-ASR or any OpenAI-compatible endpoint).'),
  sttLanguage: z.string().default('auto').description('Language hint for the DSH local recogniser: auto | zh | en | yue | ja | ko (auto lets SenseVoice decide, which also copes with mixed speech). Only used when sttProvider is dsh.'),
  sttBaseUrl: z.string().default('https://open.bigmodel.cn/api/paas/v4').description('STT base URL of an OpenAI-compatible /audio/transcriptions endpoint (Zhipu GLM-ASR or SiliconFlow). Only used when sttProvider is cloud.'),
  sttModel: z.string().default('glm-asr-2512').description('STT model id (Zhipu: glm-asr-2512; SiliconFlow: FunAudioLLM/SenseVoiceSmall).'),
  sttApiKey: z.string().role('secret').default('').description('STT API key (Zhipu key can be shared with DeepEye).'),
  redPacketNotice: z.boolean().default(true).description('When a red packet / lucky money card shows up in an allowed chat, private-message the admin so they can open it themselves. The bridge does NOT grab it: OneBot v11 has no red-packet action, the injector exposes none either, and the only real entry point (NTQQ KernelMsgService::grabRedBag) lives inside the QQ process with undocumented request fields - so this is a "tell you, do not pretend" switch, not an auto-grab.'),
  redPacketNoticeInGroup: z.boolean().default(false).description('Also say one short line in the group when a red packet arrives ("I am not grabbing it, you go first"). Off by default: the admin DM is enough, and a bot that comments on every red packet is noise.'),
  privateImageView: z.boolean().default(true).description('In private chats, proactively download images/animated stickers the user sends (to cwd/qq-images) so the agent can view them with describe_image and respond.'),
  groupImageView: z.boolean().default(true).description('In groups, do the same for an image the bot was @-mentioned with. Kept as its own switch rather than folded into privateImageView so the two can be turned off independently: a group with a lot of pictures costs one vision call each, while a private chat is nearly always meant for her. Only messages that already passed the @-gate reach this point, so it cannot turn into "look at every picture in the group".'),
  qqMediaCacheRoots: z.array(z.string()).default([]).description('Where QQ keeps its local media cache (the nt_qq/nt_data directories), used as the last-resort source for received images. Leave empty to auto-detect from the home directory (Documents\\Tencent Files\\<uin>\\nt_qq\\nt_data, the OneDrive-redirected variant, and the legacy flat layout). Why it exists: the image URL in QQ payloads can lack the rkey parameter and then always answers HTTP 400 (retcode -5503010 "invalid rkey"), while QQ has already downloaded the very same picture to nt_data/Pic|<Emoji/emoji-recv>/<month>/Ori/<md5>.<ext>. Filling this in is only needed for exotic installs (custom data dir, second drive).'),
  cardLookEnabled: z.boolean().default(true).description('Look up QQ card / mini-program messages by their title to recover the page behind them (Bilibili only for now): fills in uploader, duration, counts, description and tags, attaches the thumbnail as a native image, and (v0.7.17) fetches public CC subtitles and hot comments best-effort — subtitles/comments are third-party content, fenced line-by-line via the untrusted-data guard and explicitly framed as opinions, not facts; without login the AI subtitles are unavailable, which is stated plainly instead of glossed over. The card itself has no URL and no video bytes — this reads a web page, it does not watch the video. Failures degrade silently to the title line only. Only bilibili.com / hdslb.com / b23.tv are opened, and only for this lookup (the global egress allowlist is not widened).'),
  cardLookTimeoutMs: z.number().step(100).min(1000).max(30000).default(6000).description('Per-request timeout for the card lookup (search, details, thumbnail). The whole chain is fail-soft: on timeout the message falls back to the title line and the reply goes out immediately.'),
  webSearchHintEnabled: z.boolean().default(true).description('Tell the agent, in its system prompt, that it may use the host web_search tool when it genuinely does not know a meme / slang word / news event, instead of guessing. This does NOT provide the tool: web_search comes from the DSH profile (@deepseek-ai/dsh-tool-web + dsh-web-search-deepseek, enabled in this profile on 2026-11-01). The prompt phrase is deliberately conditional ("if a web_search tool is available"), so leaving this on is safe even in a profile where the tool is absent — the agent then simply reports it cannot search. Turn it off if you would rather she never tries to search.'),
  biliCookie: z.string().role('secret').default('').description('Optional Bilibili login cookie (the whole Cookie header from a logged-in browser, containing at least SESSDATA). Leave empty to use an anonymous guest identity: search and the popular list both work, but the guest path is rate-limited harder and personalised views (own subscriptions / favourites / recommendations) are unavailable. Filling it in makes every Bilibili request carry that identity. This is an account credential — the program acts as that account, so prefer a throwaway one.'),
  videoFrameEnabled: z.boolean().default(true).description('When the user sends or quotes a video, download it and extract a few still frames via ffmpeg, then attach them as native images. Frames are stills, not the video: the prompt says so explicitly. Needs ffmpegPath to point at a real binary; failures degrade to "a video arrived, I cannot see it" instead of blocking the reply.'),
  videoFrames: z.number().step(1).min(1).max(6).default(4).description('Base number of frames to pull out of a video (evenly spaced, starting at 5% so the first frame is rarely a black leader). Longer videos scale up toward videoFramesMax: <=2 min keeps the base, <=6 min +2, <=20 min +4, beyond that the cap.'),
  videoFramesMax: z.number().step(1).min(1).max(10).default(9).description('Upper bound for adaptive frame extraction (see videoFrames). Longer videos get more frames, never more than this.'),
  videoMaxBytes: z.number().step(1048576).min(1048576).max(209715200).default(31457280).description('Largest video the bridge will download for frame extraction (bytes, default 30 MiB). Checked against Content-Length first and the real byte count after, since the header can lie.'),
  videoSpeechEnabled: z.boolean().default(true).description('Also transcribe the audio track of a video the user sends or quotes, and give her the words alongside the stills (default on). Frames alone answer "what is on screen"; "what is this video about" is almost always answered by what people SAY. Uses the same local speech-to-text as voice messages (free, offline). A clip with no usable audio just skips it; frames are never lost because of a failed transcription.'),
  videoSpeechSeconds: z.number().step(1).min(5).max(900).default(120).description('How many seconds of the video audio to transcribe (default 120). Only the beginning is taken on purpose: a 40-minute screen recording would turn into tens of megabytes of WAV, while what she needs is "what is this about".'),
  visionMode: z.union(['tool', 'native']).default('tool').description('How the agent views images: tool = save images to disk and let the agent view them via visionToolName; native = attach images as native multimodal attachments (DSH 0.1.1+ attachment seam; text-only models degrade to placeholders automatically).'),
  visionToolName: z.string().default('describe_image').description('Vision tool the agent uses when visionMode is tool (e.g. describe_image).'),
  imageRetentionDays: z.number().step(1).min(1).max(365).default(14).description('Days downloaded images (qq-images, qq-replies) are kept before cleanup on host start.'),
  imageTrashEnabled: z.boolean().default(true).description('Deletion policy (never destroy): expired downloads are MOVED to cwd/qq-trash/<date>/ instead of being deleted, so nothing is lost by accident. Set false to unlink them permanently.'),
  imageTrashDir: z.string().default('').description('Where expired downloads go (empty = cwd/qq-trash). The trash is never auto-pruned; clean it yourself when convenient.'),
  memoryEnabled: z.boolean().default(true).description('Persist a rolling window of each chat\'s recent conversation to <cwd>/qq-memory/ and re-inject it into new sessions after host restarts, so the bot remembers previous chats. /new clears the memory for that chat.'),
  memoryMaxEntries: z.number().step(1).min(1).max(100).default(60).description('Max conversation lines kept per chat in persistent memory.'),
  memoryArchiveEntries: z.number().step(1).min(0).max(2000).default(400).description('Overflow lines older than memoryMaxEntries are archived here (per chat) instead of being dropped. The newest 20 archived lines are injected with an "(older)" prefix before the recent window.'),
  groupMemoryPerSpeaker: z.number().step(1).min(1).max(50).default(6).description('When injecting group memory, keep at most this many recent messages PER SPEAKER (default 6). Without it one talkative member buried everyone else.'),
  reminderEnabled: z.boolean().default(true).description('Scheduled reminders: "30分钟后提醒我喝水" / "明天9点开会". In groups this requires @-mentioning the bot; in private chats it works directly. Reminders persist across host restarts (cwd/qq-reminders.json); /reminders lists them.'),
  reminderMaxPerChat: z.number().step(1).min(1).max(50).default(10).description('Max pending reminders per chat.'),
  rateLimitEnabled: z.boolean().default(false).description('Outbound reply rate limiting (default OFF, risk-control). When enabled, each chat gets at most rateLimitMaxReplies replies per rateLimitWindowSeconds; excess replies are silently dropped and logged.'),
  rateLimitMaxReplies: z.number().step(1).min(1).max(120).default(10).description('Max replies per chat per window when rate limiting is enabled.'),
  rateLimitWindowSeconds: z.number().step(1).min(5).max(3600).default(60).description('Rate limit sliding window length in seconds.'),
  dedupEnabled: z.boolean().default(true).description('Ignore duplicate inbound messages (the same message re-delivered after a NapCat reconnect) within dedupWindowSeconds.'),
  dedupWindowSeconds: z.number().step(1).min(10).max(3600).default(300).description('Duplicate detection window in seconds.'),
  adminUsers: z.array(z.number().step(1)).default([]).description('QQ user ids allowed to run admin commands (/mute /unmute /kick /clear). Kick requires a second confirmation in chat.'),
  /**
   * 2026-10-29：`adminUins` 是 `!` 指令通道（`!status` / `!hush` / `!say` …）历史上读的键，
   * 而面板与 `/设管理` 读写的是 `adminUsers` —— **两个键、两份名单**。后果是：
   * 在面板里加/删「管理员」对 `!` 指令不生效（真机上两个键碰巧填了同一个号，所以没露馅）。
   * 现在 `adminUsers` 是唯一权威，`adminUins` 只留着给老 patch 兜底（`adminUsers` 为空时才用）。
   */
  adminUins: z.array(z.number().step(1)).default([]).description('DEPRECATED alias for adminUsers, kept only so old patches keep working. Only read as a fallback when adminUsers is empty; adminUsers always wins.'),
  adminEnabled: z.boolean().default(true).description('Master switch for admin commands.'),
  summaryEnabled: z.boolean().default(true).description('Enable /summary: the agent summarizes the chat\'s persisted conversation.'),
  voteEnabled: z.boolean().default(true).description('Enable group votes: "投票：问题？A 选项 B 选项"; members reply with option letters; /vote /vote-end manage it.'),
  voteDurationSeconds: z.number().step(1).min(10).max(3600).default(300).description('Default vote duration before results publish.'),
  todoEnabled: z.boolean().default(true).description('Enable shared todos: /todo add|list|done|clear and "记一下：xxx"; stored per chat in cwd/qq-todos/.'),
  ttsEnabled: z.boolean().default(false).description('NOT BUNDLED: dsh and this plugin ship no TTS service - you must provide your own (local software or a third-party key). Voice replies via TTS (default provider: Azure Speech; off until you set ttsApiKey and flip this on). A voice message follows each text reply.'),
  ttsProvider: z.union(['azure', 'openai', 'local']).default('azure').description('TTS provider: azure = Microsoft Speech SSML; openai = any OpenAI-compatible /audio/speech endpoint (OpenAI/Minimax/Doubao...); local = a local GPT-SoVITS api_v2 server (zero-shot voice cloning, no API key).'),
  ttsApiKey: z.string().role('secret').default('').description('TTS API key (Azure Speech key, or OpenAI-compatible key; not needed for local).'),
  ttsAzureRegion: z.string().default('eastasia').description('Azure Speech region (e.g. eastasia).'),
  ttsVoice: z.string().default('zh-CN-XiaoxiaoNeural').description('Voice id: Azure voice name (e.g. zh-CN-XiaoxiaoNeural) or OpenAI-compatible voice name.'),
  ttsStyle: z.string().default('chat').description('Azure speaking style (e.g. chat/cheerful/sad; empty = neutral). Ignored by OpenAI-compatible providers.'),
  ttsBaseUrl: z.string().default('https://api.openai.com/v1').description('OpenAI-compatible TTS base URL (used when ttsProvider is openai).'),
  ttsModel: z.string().default('tts-1').description('OpenAI-compatible TTS model id.'),
  ttsMaxChars: z.number().step(1).min(10).max(500).default(120).description('Max chars spoken per voice reply (longer replies are truncated for voice only).'),
  ttsLocalUrl: z.string().default('http://127.0.0.1:9880').description('Local GPT-SoVITS api_v2 base URL (used when ttsProvider is local; e.g. http://127.0.0.1:9880).'),
  ttsLocalRefAudio: z.string().default('').description('Absolute path to the reference voice clip (3-10s wav) that defines the voice, e.g. D:/voice/xiaojingyu.wav. Required for local TTS.'),
  ttsLocalPromptText: z.string().default('').description('Transcript of the reference clip (helps the voice clone; can be empty).'),
  ttsLocalTextLang: z.string().default('zh').description('Language of the text to synthesize (zh/en/ja...).'),
  ttsLocalPromptLang: z.string().default('zh').description('Language of the reference clip transcript.'),
  ttsLocalConvertToMp3: z.boolean().default(true).description('Convert local TTS wav output to mp3 with ffmpeg before sending (better QQ/NapCat compatibility).'),
  ttsVoiceFormat: z.union(['silk', 'mp3']).default('silk').description('Container format for outgoing voice messages. silk (default): convert mp3 to SILK locally, because QQ 9.9.36+ stopped transcoding mp3 on its own and would fail inside NTQQ with retcode 1400. Needs the optional silk-wasm package; when it is missing this silently falls back to mp3. mp3: old behaviour (only correct for QQ builds that still transcode).'),
  pokeEnabled: z.boolean().default(true).description('Poke replies: when someone pokes the bot (OneBot notice poke), reply with a random cute line (allowlisted chats only).'),
  pokeReplies: z.array(z.string()).default([
    '哎呀，别戳啦～再戳小鲸鱼就要吐泡泡了！',
    '戳戳戳……你是要把我戳成筛子吗！',
    '呜哇！不要突然戳人家啦 ( ˘•ω•˘ )',
    '哼，再戳就咬你哦～（露出小虎牙）',
    '小鲸鱼收到！请问有什么吩咐呀？',
  ]).description('Random poke reply lines.'),
  pokeCooldownSeconds: z.number().step(1).min(5).max(300).default(15).description('Min seconds between poke replies per chat (anti-spam).'),
  // Default OFF: this one needs an EXTRA service (a working TTS provider — local GPT-SoVITS or a cloud
  // key). Features that require installing something ship off, so a fresh install is usable without it.
  voiceReadingEnabled: z.boolean().default(false).description('NOT BUNDLED: needs a TTS provider you install or pay for. Voice reading (default OFF because it needs an extra service: a working TTS provider, see ttsProvider): "@bot + quote a text message saying 读一下/念出来" or "/读 <text>" — the bot reads the text aloud via TTS.'),
  checkinEnabled: z.boolean().default(false).description('Daily check-in (default OFF): group members say the keyword (default 签到) to check in; streak and total days are persisted per chat (cwd/qq-checkin/); 签到榜 shows the leaderboard.'),
  checkinKeyword: z.string().default('签到').description('Check-in trigger keyword.'),
  welcomeEnabled: z.boolean().default(false).description('Welcome new members (default OFF): when someone joins an allowlisted group (notice group_increase), @-mention them with the welcome text.'),
  welcomeText: z.string().default('').description('Welcome message template (empty = built-in default).'),
  fileTransferEnabled: z.boolean().default(true).description('In private chats, save files the user sends to cwd/qq-files/ and reply with the local path.'),
  fileTransferMaxBytes: z.number().step(1).min(1).default(52428800).description('Max accepted file size for private file transfer (default 50 MiB).'),
  fileTransferInlineMaxBytes: z.number().step(256).min(512).max(16384).default(4096).description('Small TEXT files up to this size get their content pasted directly into her context inside an untrusted-data fence (the agent cannot reliably be assumed to read saved files itself — real-machine evidence). Larger or binary files keep the path only, with an honest note.'),
  inboundLocalPathRoots: z.array(z.string()).default([]).description('Directories allowed as a source when an inbound OneBot file segment carries an ABSOLUTE local path. Empty (default) = refuse all of them: real traffic never does this (1215 recorded frames carried bare file names only), and an attacker who can forge a frame would otherwise read any file on this machine. Paths are checked after realpath, so symlinks and .. cannot escape. Add a adapter cache directory here only if your OneBot implementation really sends absolute paths.'),
  exportEnabled: z.boolean().default(true).description('Enable /export: dump this chat\'s persisted conversation to a markdown file under cwd/qq-exports/.'),
  notifyEnabled: z.boolean().default(false).description('Status push notifications (default OFF): the host pushes bot online/offline events to a push service (PushPlus or any JSON webhook) without going through QQ, so you learn about outages even when the bot is offline.'),
  notifyPushUrl: z.string().default('').description('Push endpoint URL (defaults to PushPlus http://www.pushplus.plus/send when empty but notifyToken is set; can be any JSON webhook).'),
  notifyToken: z.string().role('secret').default('').description('PushPlus token (or the token field of a custom webhook payload).'),
  notifyCooldownSeconds: z.number().step(1).min(30).max(3600).default(300).description('Min seconds between status notifications (anti-flood for flapping connections).'),
  gifFrameExtract: z.boolean().default(true).description('Extract the first frame of GIF images via ffmpeg into PNG before handing them to the vision path (animated stickers become stably viewable).'),
  ffmpegPath: z.string().default('ffmpeg').description('Path to the ffmpeg executable for GIF frame extraction (empty PATH name is fine when ffmpeg is on PATH).'),
  quietHoursEnabled: z.boolean().default(false).description('Avoid peak hours (default OFF): while enabled, the bot does not reply to ANY inbound message during the quiet windows on weekdays (scheduled reminders and vote publishing still fire).'),
  quietHours: z.array(z.string()).default(['9:00-12:00', '14:00-18:00']).description('Quiet windows as local-time "H:MM-H:MM" ranges (full-width colons are normalized).'),
  quietWeekendExempt: z.boolean().default(true).description('Do not apply quiet hours on Saturdays and Sundays.'),
  imageGenEnabled: z.boolean().default(false).description('NOT BUNDLED: dsh and this plugin ship no image generation service - you must provide your own (a locally hosted backend or a third-party key). Image generation (default OFF): "/画 <描述词>" generates an image and sends it back (group usage requires @-mentioning the bot). Extensible provider backends, same contract as TTS.'),
  imageGenProvider: z.union(['openai', 'local']).default('openai').description('Generation backend: openai = any OpenAI-compatible /images/generations endpoint (DALL·E / Zhipu CogView / SiliconFlow...); local = Stable Diffusion WebUI (AUTOMATIC1111 /sdapi/v1/txt2img).'),
  imageGenBaseUrl: z.string().default('').description('Backend base URL (empty = provider default: https://api.openai.com/v1, or http://127.0.0.1:7860 for local).'),
  imageGenApiKey: z.string().role('secret').default('').description('API key for OpenAI-compatible providers (not needed for local).'),
  imageGenModel: z.string().default('').description('Model id (empty = provider default, e.g. gpt-image-1; ignored by local SD WebUI).'),
  imageGenSize: z.string().default('1024x1024').description('Image size as WxH (e.g. 1024x1024, 512x512; local SD supports arbitrary sizes).'),
  imageGenSteps: z.number().step(1).min(1).max(100).default(20).description('Sampling steps (local SD only).'),
  imageGenCfgScale: z.number().min(1).max(30).default(7).description('CFG scale (local SD only).'),
  imageGenSampler: z.string().default('').description('Sampler name (local SD only; empty = WebUI default).'),
  imageGenCooldownSeconds: z.number().step(1).min(10).max(3600).default(60).description('Min seconds between image generations per chat (cost/spam guard).'),
  imageGenDailyLimit: z.number().step(1).min(1).max(100).default(20).description('Max image generations per chat per day.'),
  imageGenMaxPromptChars: z.number().step(1).min(10).max(1000).default(400).description('Max prompt characters (longer prompts are truncated).'),
  imageGenCommand: z.string().default('/画').description('Trigger command for image generation (e.g. "/画 一只蓝鲸在星空下喷水花").'),
})

function makeLogger(ctx) {
  const base = ctx.logger('dsh-qq-onebot-bridge')
  return {
    info: (message) => base.info(message),
    warn: (message) => base.warn(message),
    error: (message) => base.error(message),
  }
}

export async function apply(ctx, config) {
  const logger = makeLogger(ctx)
  const server = new OneBotServer(config, logger)
  const bridge = new QQBridge(ctx, config, server, logger)
  /**
   * 端口被占时的行为（v0.5.9，官方桌面端兼容）。
   *
   * web 宿主与官方桌面端（Electron，同一份 `~/.dsh` 配置、同一个 OneBot 端口）可能同时在跑，
   * 两边都想监听 6700 时**必然有一边绑不上**。旧实现会未捕获抛错 + 启动卡死，
   * 现在改成：如实报告 → 后台退避重试 → 端口释放后自动接管。
   * 绑不上时不启动桥（避免"两个实例都在跑定时任务/回消息"的假象）。
   */
  await ctx.effect(async () => {
    const RETRY_MS = 15_000
    let stopped = false
    let retryTimer = null
    let bridgeStarted = false
    let attempts = 0
    /** 稳态（另一个实例一直占着端口）下不能每 15 秒刷一条 error：只在第 1 次与每 10 分钟各记一条。 */
    const LOG_EVERY = Math.max(1, Math.round(600_000 / RETRY_MS))

    const tryServe = async () => {
      if (stopped) return
      attempts += 1
      const result = await server.start()
      if (stopped) {
        await server.stop().catch(() => {})
        return
      }
      if (result.ok === true) {
        try {
          bridge.start()
        } finally {
          // 无论 start() 是否中途抛错都算"动过了"：dispose 必须去 stop 它，
          // 否则会留下半初始化的桥（定时器/订阅还在，dispose 却不再管）。
          bridgeStarted = true
        }
        logger.info(`QQ bridge ready: reverse-WS ws://${config.host}:${config.port}`)
        return
      }
      const hint = result.code === 'EADDRINUSE'
        ? `端口 ${config.port} 已被另一个进程占用：同一台机器上「web 宿主」与「官方桌面端」只允许一个实例托管 QQ 桥，`
          + '另一个实例会在端口释放后自动接管（用控制台的端口摘要，或 `netstat -ano | findstr :' + config.port + '` 找占用者）。'
        : `将在 ${Math.round(RETRY_MS / 1000)} 秒后重试。`
      if (attempts === 1 || attempts % LOG_EVERY === 0) {
        logger.error(`QQ bridge 未启动（第 ${attempts} 次）：无法监听 ws://${config.host}:${config.port}`
          + `（${result.code || '未知错误'}）：${result.reason}。${hint}`)
      }
      retryTimer = setTimeout(() => {
        // 重试回调里绝不能漏 catch：未处理的 rejection 在 Node CLI 宿主上是致命的。
        void tryServe().catch((error) => logger.error(`QQ bridge 重试异常：${error?.message ?? error}`))
      }, RETRY_MS)
      if (typeof retryTimer.unref === 'function') retryTimer.unref()
    }

    await tryServe()
    return async () => {
      stopped = true
      if (retryTimer) clearTimeout(retryTimer)
      if (bridgeStarted) bridge.stop()
      await server.stop()
      logger.info('QQ bridge stopped')
    }
  }, 'dsh-qq-onebot-bridge.serve')

  /**
   * v0.7.0 扩展接缝：把桥的能力挂成宿主服务 `ctx.qqBridge`（受控发送 + 只读快照 + 实验性的工具 provider 注册）。
   *
   * 挂不上（宿主既没有 `ctx.set` 也没有 `ctx.provide`）只记一条 info —— 扩展口少一个入口，
   * 绝不能影响 QQ 桥本身。事件那条路（`ctx.on('qqbridge:inbound'/'outbound')`）不依赖它。
   */
  const extensionApi = bridge.createExtensionApi()
  const attached = attachExtensionService(ctx, extensionApi)
  // 把挂载结果留在桥上：面板「实验性」组要显示"出口挂上了没有 / 走哪条机制"。
  bridge.extensionMount = attached
  if (attached.ok === true) {
    logger.info(`扩展出口已挂载：ctx.${EXTENSION_SERVICE}（via ${attached.via}）`)
  } else {
    logger.info(`扩展出口未挂到 ctx（${attached.reason}）；同进程插件仍可用 getExtensionApi() + ctx.on('qqbridge:*')`)
  }
  // 挂载结果写进 trace（调试台的「实时事件」里能直接看到，不用翻宿主控制台）。
  try {
    bridge.trace?.event({
      id: '', module: 'extension', stage: 'extension', level: attached.ok === true ? 'info' : 'warn', ok: attached.ok === true,
      reason: attached.ok === true
        ? `扩展出口已挂载：ctx.${EXTENSION_SERVICE}（via ${attached.via}）`
        : `扩展出口未挂到 ctx：${attached.reason}（降级到模块级注册表 + 事件总线）`,
    })
  } catch { /* trace 写不了也不能影响启动 */ }

  /**
   * v0.6「轻量化设计」：把「QQ助手」面板挂进 DSH 设置。
   *
   * - 服务端：往宿主 HTTP 服务注册两条路由（`GET /qqai/panel`、`POST /qqai/panel/set`），
   *   客户端 bundle（client/client.js）用 fetch 调它们。契约与已装插件（dshmarket）一致。
   * - 用 `ctx.inject(['webServer'], …)` 而不是在 apply 里直接拿：TUI 等没有 webServer 的
   *   宿主上这段**根本不会执行**，插件照常工作（面板只是没有入口而已）。
   * - 任何失败都只记一条 warn：绝不能因为"面板挂不上"影响 QQ 桥本身。
   */
  ctx.inject(['webServer'], (hostCtx) => {
    try {
      const resolved = resolveProfile()
      if (resolved.source === 'fallback') {
        logger.warn('QQ助手面板：没能从宿主命令行认出 profile，按 web 处理'
          + `（面板顶行会显示它要写的文件：${resolved.profile}）`)
      }
      hostCtx.effect(() => mountQqAiPanel(hostCtx, {
        profile: resolved.profile,
        dir: resolved.dir ?? null,
        config,
        defaults: configDefaults(),
        // 数值型控件的范围/步长（schema 现读，面板不抄第二份）。
        numberMeta: numberMetaOf(),
        // 扩展接缝的**运行时**状态（挂载结果 / provider 列表 / 最近一次注入）：只有桥实例知道。
        bridge,
        logger,
      }), 'dsh-qq-onebot-bridge: QQ助手面板路由')
    } catch (error) {
      logger.warn(`QQ助手面板未挂载（不影响 QQ 桥）：${error?.message ?? error}`)
    }
  })
}
