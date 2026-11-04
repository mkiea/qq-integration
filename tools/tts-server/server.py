#!/usr/bin/env python3
"""edge-tts → OpenAI 兼容 /v1/audio/speech 适配器。

为什么要有这一层：
  dsh-qq-onebot-bridge 的语音发送只认三种 provider——azure / openai / 本地 GPT-SoVITS。
  前两种要 key，第三种要参考音频 + 一整套 SoVITS 服务。本机都没有。
  而 edge-tts（微软 Edge 的在线朗读接口）**免费、无需 key**，正好可以伪装成
  openai 这一档：桥 POST {model, voice, input}，这里回 mp3 二进制。

端口 8977（避开 6700 桥 / 3080-3060 web / 11434 ollama）。
用法：
  python server.py [--port 8977]
健康检查：GET /health  →  {"ok": true}
"""

import argparse
import asyncio
import json
import os
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import edge_tts

PORT_DEFAULT = 8977
MAX_CHARS = 400  # 桥那边 ttsMaxChars 默认 120，这里只是兜底防滥用

STATE_DIR = os.path.dirname(os.path.abspath(__file__))
VOICE_FILE = os.path.join(STATE_DIR, "voice.txt")

"""
★ DeepSeek 网页版「朗读」那四种音色，在这里一对一对上微软的同档音色。

事实前提（2026-10-28 核实）：DeepSeek 网页端/App 在 2026-09-15 全量推送了朗读功能，
四音色叫贝壳/白浪/海星/暗潮（英文名 Mira/Echo/Stella/Tide）。**这是网页前端功能，
官方从没开进 API**，所以拿不到它的端点，也就没法直接"复用"那段声音。
能做的是同一档技术的等价物——edge-tts 调的就是微软 Azure 的神经网络 TTS，
和 DeepSeek 那四款是同一代技术，差别只在具体音色。

对照关系按官方给的八个字性格描述挑：
  贝壳 百变活泼（女）→ Xiaoyi   语调起伏大、偏少女
  白浪 明朗坚定（男）→ Yunxi    干净通透的年轻男声
  海星 俏皮甜美（女）→ Xiaoxiao 甜、软、治愈
  暗潮 低沉浑厚（男）→ Yunjian  低磁、纪录片腔
语速也按性格微调："贝壳"快一点显活泼，"暗潮"慢一点显沉。
"""
DEEPSEEK_STYLE = {
    "贝壳": ("zh-CN-XiaoyiNeural", "+8%"),
    "白浪": ("zh-CN-YunxiNeural", "+4%"),
    "海星": ("zh-CN-XiaoxiaoNeural", "+2%"),
    "暗潮": ("zh-CN-YunjianNeural", "-4%"),
}

# 其余别名（英文短名，保持向后兼容）→ edge 的真实 voice id
VOICES = {
    "xiaoyi": ("zh-CN-XiaoyiNeural", "+6%"),      # 活泼女声
    "xiaoxiao": ("zh-CN-XiaoxiaoNeural", "+2%"),  # 温柔女声
    "xiaochen": ("zh-CN-XiaochenNeural", "+0%"),  # 慵懒女声
    "xiaohan": ("zh-CN-XiaohanNeural", "+0%"),    # 软糯女声
    "yunxi": ("zh-CN-YunxiNeural", "+4%"),        # 年轻男声
    "yunjian": ("zh-CN-YunjianNeural", "-4%"),    # 低沉男声
    "alloy": ("zh-CN-XiaoyiNeural", "+8%"),       # openai 风格别名
    "nova": ("zh-CN-XiaoxiaoNeural", "+2%"),
}
ALL_VOICES = {**DEEPSEEK_STYLE, **VOICES}

DEFAULT_VOICE_NAME = "贝壳"
DEFAULT_RATE = "+6%"

# False = 忽略桥传来的 voice，一律用本服务选中的音色（默认）。
# 桥的 ttsVoice 写在 cordis.patch.yml 里，跟着它走的话每次换音色都得改配置 + 热重载 QQ 桥。
RESPECT_REQUEST_VOICE = False

# 当前生效的音色名（启动时从 voice.txt 读，运行时可被 POST /voice 改）
current_name = DEFAULT_VOICE_NAME


def load_voice_name() -> str:
    """上次选的音色。文件不存在/内容不认识就退回默认，不报错。"""
    try:
        with open(VOICE_FILE, "r", encoding="utf-8") as handle:
            name = handle.read().strip()
        return name if name in ALL_VOICES else DEFAULT_VOICE_NAME
    except OSError:
        return DEFAULT_VOICE_NAME


def save_voice_name(name: str) -> None:
    try:
        with open(VOICE_FILE, "w", encoding="utf-8") as handle:
            handle.write(name)
    except OSError as error:
        log(f"保存音色失败（不影响本次生效）：{error}")


def resolve_voice(name: str) -> tuple:
    """别名或完整 voice id → (voice_id, rate)。认不出来就用当前音色。"""
    key = str(name or "").strip()
    if key in ALL_VOICES:
        return ALL_VOICES[key]
    # 已经是完整 voice id（zh-CN-XXXNeural）就原样用，语速取默认
    if key.startswith("zh-") or "-" in key:
        return (key, DEFAULT_RATE)
    return ALL_VOICES.get(current_name, ALL_VOICES[DEFAULT_VOICE_NAME])



def synthesize(text: str, voice: str, rate: str) -> bytes:
    """把文本合成成 mp3 字节。edge-tts 是异步的，这里一请求一 loop（量很小）。"""
    async def run() -> bytes:
        communicate = edge_tts.Communicate(text, voice, rate=rate)
        buf = bytearray()
        async for chunk in communicate.stream():
            if chunk.get("type") == "audio" and chunk.get("data"):
                buf.extend(chunk["data"])
        return bytes(buf)

    return asyncio.run(run())


# --------------------------------------------------------------------------
# 唱歌（2026-11-04）
#
# edge-tts 的 pitch 是**整段参数**（"+20Hz"），没有 SSML，所以做不到"一句一个音高"
# 在一次请求里完成。做法是：逐句合成、每句给不同的 pitch、然后把 mp3 **字节拼接**。
#
# 拼接能成立的前提（不是猜的）：
#   · edge-tts 输出固定为 24kHz / 48kbps / mono 的 MPEG 帧流，参数一致；
#   · MPEG 帧流天然可顺序解码，播放器读到下一帧就继续播（不存在"只播第一段"的问题，
#     那只发生在带独立容器头/timeline 的格式，如 mp4/m4a）。
# 代价：句间没有淡入淡出，是硬切 —— 听感上像"一句一句唱"，不像连贯的乐句。
# 没有 ffmpeg 可用来做交叉淡化（本机确认没装），所以先接受这个限制。
# --------------------------------------------------------------------------

# 旋律：Hz 偏移。中文女声基频约 200Hz，+20Hz ≈ 一个半音多一点。
# 六句一循环，听起来有起伏但不会飘太高。
MELODY_HZ = [0, 20, 40, 20, 60, 40]
SING_MAX_LINES = 60
SING_MAX_CHARS_PER_LINE = 40
SING_MAX_CHARS = 2000


def split_lyrics(lyrics: str, max_lines: int = SING_MAX_LINES,
                 max_chars: int = SING_MAX_CHARS_PER_LINE) -> list:
    """切句：先按换行、再按标点；丢空句；超长硬切；最多 max_lines 句。

    与桥侧 `lib/tts.js` 的 splitLyricLines 保持同一套判据（那侧有单测）。
    两边各写一份是有意的：服务可能被别的前端直接用，不该依赖 Node 那套代码。
    """
    chunks = []
    for para in str(lyrics or "").splitlines():
        for piece in re.split(r"[，。！？；、,.!?;]+", para):
            text = piece.strip()
            if not text:
                continue
            while len(text) > max_chars:
                chunks.append(text[:max_chars])
                text = text[max_chars:]
            if text:
                chunks.append(text)
            if len(chunks) >= max_lines:
                return chunks[:max_lines]
    return chunks[:max_lines]


def synthesize_line(text: str, voice: str, rate: str, pitch: str) -> bytes:
    async def run() -> bytes:
        communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
        buf = bytearray()
        async for chunk in communicate.stream():
            if chunk.get("type") == "audio" and chunk.get("data"):
                buf.extend(chunk["data"])
        return bytes(buf)

    return asyncio.run(run())


def synthesize_song(lyrics: str, voice: str, rate: str) -> tuple:
    """逐句合成并拼接。返回 (mp3 字节, 实际句数, 跳过的句数)。"""
    lines = split_lyrics(lyrics)
    if not lines:
        raise ValueError("歌词是空的")
    out = bytearray()
    sung = 0
    skipped = 0
    for index, line in enumerate(lines):
        pitch = f"+{MELODY_HZ[index % len(MELODY_HZ)]}Hz"
        try:
            chunk = synthesize_line(line, voice, rate, pitch)
        except Exception as error:  # noqa: BLE001
            log(f"sing line failed ({index}): {error}")
            skipped += 1
            continue
        if not chunk:
            skipped += 1
            continue
        out.extend(chunk)
        sung += 1
    if sung == 0:
        raise RuntimeError("每一句都合成失败了")
    return bytes(out), sung, skipped


class Handler(BaseHTTPRequestHandler):
    server_version = "edge-tts-openai/1.0"

    def _send(self, code: int, body: bytes, content_type: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, payload: dict) -> None:
        self._send(code, json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?")[0].rstrip("/")
        if path in ("/health", ""):
            self._json(200, {
                "ok": True,
                "engine": "edge-tts",
                "current": current_name,
                "voiceId": ALL_VOICES[current_name][0],
                "voices": list(ALL_VOICES.keys()),
                "deepseekStyle": {k: v[0] for k, v in DEEPSEEK_STYLE.items()},
            })
            return
        if path == "/v1/audio/voices":
            self._json(200, {
                "current": current_name,
                "data": [
                    {"id": name, "voice": voice_id, "rate": rate, "style": "deepseek" if name in DEEPSEEK_STYLE else "extra"}
                    for name, (voice_id, rate) in ALL_VOICES.items()
                ],
            })
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        global current_name
        path = self.path.split("?")[0].rstrip("/")

        # 换音色：改的是**本服务的状态**，不动 dsh 配置。
        # 改 cordis.patch.yml 的 ttsVoice 会触发桥热重载（QQ 短暂断线），
        # 换个音色不该付这个代价，所以走这里。
        if path == "/voice":
            try:
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length > 0 else b"{}"
                body = json.loads(raw.decode("utf-8") or "{}")
            except Exception as error:  # noqa: BLE001
                self._json(400, {"ok": False, "reason": f"bad json: {error}"})
                return
            name = str(body.get("voice") or "").strip()
            if name not in ALL_VOICES:
                self._json(400, {"ok": False, "reason": f"没有这个音色：{name or '(空)'}", "available": list(ALL_VOICES.keys())})
                return
            current_name = name
            save_voice_name(name)
            log(f"voice switched -> {name} ({ALL_VOICES[name][0]})")
            self._json(200, {"ok": True, "current": current_name, "voiceId": ALL_VOICES[name][0]})
            return

        if path not in ("/v1/audio/speech", "/audio/speech", "/v1/audio/sing", "/sing"):
            self._json(404, {"error": {"message": "not found"}})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length > 0 else b"{}"
            body = json.loads(raw.decode("utf-8") or "{}")
        except Exception as error:  # noqa: BLE001
            self._json(400, {"error": {"message": f"bad json: {error}"}})
            return

        # ---- 唱歌（2026-11-04）：歌词 → 逐句不同 pitch → mp3 拼接 ----
        if path in ("/v1/audio/sing", "/sing"):
            lyrics = str(body.get("lyrics") or body.get("input") or "").strip()
            if not lyrics:
                self._json(400, {"error": {"message": "lyrics is required"}})
                return
            if len(lyrics) > SING_MAX_CHARS:
                lyrics = lyrics[:SING_MAX_CHARS]
            if RESPECT_REQUEST_VOICE:
                voice_id, voice_rate = resolve_voice(body.get("voice") or "")
            else:
                voice_id, voice_rate = ALL_VOICES.get(current_name, ALL_VOICES[DEFAULT_VOICE_NAME])
            rate = str(body.get("rate") or voice_rate)
            started = time.time()
            try:
                audio, sung, skipped = synthesize_song(lyrics, voice_id, rate)
            except Exception as error:  # noqa: BLE001
                log(f"sing failed: {error}")
                self._json(502, {"error": {"message": f"sing failed: {error}"}})
                return
            log(f"sing ok voice={voice_id} lines={sung} skipped={skipped} bytes={len(audio)} {time.time() - started:.2f}s")
            # 句数用响应头带出去，桥那边可以写进回执（"唱了 7 句，跳过 1 句"）
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Content-Length", str(len(audio)))
            self.send_header("X-Sing-Lines", str(sung))
            self.send_header("X-Sing-Skipped", str(skipped))
            self.end_headers()
            self.wfile.write(audio)
            return

        text = str(body.get("input") or "").strip()
        if not text:
            self._json(400, {"error": {"message": "input is required"}})
            return
        if len(text) > MAX_CHARS:
            text = text[:MAX_CHARS]

        # 默认**忽略**桥传来的 voice，用本服务选中的音色。
        # 桥那边 ttsVoice 固定写在 cordis.patch.yml 里，跟着它走的话每次换音色都得改配置 + 热重载。
        # 想让桥的 voice 生效就设 RESPECT_REQUEST_VOICE = True。
        if RESPECT_REQUEST_VOICE:
            voice_id, voice_rate = resolve_voice(body.get("voice") or "")
        else:
            voice_id, voice_rate = ALL_VOICES.get(current_name, ALL_VOICES[DEFAULT_VOICE_NAME])
        rate = str(body.get("rate") or voice_rate)
        voice = voice_id
        started = time.time()
        try:
            audio = synthesize(text, voice, rate)
        except Exception as error:  # noqa: BLE001
            log(f"synth failed: {error}")
            self._json(502, {"error": {"message": f"edge-tts failed: {error}"}})
            return
        if not audio:
            log("synth returned empty audio")
            self._json(502, {"error": {"message": "edge-tts returned empty audio"}})
            return

        log(f"ok voice={voice} chars={len(text)} bytes={len(audio)} {time.time() - started:.2f}s")
        self._send(200, audio, "audio/mpeg")

    def log_message(self, fmt: str, *args) -> None:  # 默认会往 stderr 刷每一行，降噪
        return


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


def main() -> None:
    global current_name
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=PORT_DEFAULT)
    parser.add_argument("--voice", type=str, default="", help="启动时指定音色（贝壳/白浪/海星/暗潮 或 xiaoyi…），不给就读 voice.txt")
    args = parser.parse_args()

    if args.voice.strip() in ALL_VOICES:
        current_name = args.voice.strip()
        save_voice_name(current_name)
    else:
        current_name = load_voice_name()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    voice_id, voice_rate = ALL_VOICES[current_name]
    log(f"edge-tts bridge listening on http://127.0.0.1:{args.port}  (POST /v1/audio/speech)")
    log(f"当前音色：{current_name} → {voice_id}  rate={voice_rate}   换音色：POST /voice {{\"voice\":\"海星\"}}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("bye")
        sys.exit(0)


if __name__ == "__main__":
    main()
