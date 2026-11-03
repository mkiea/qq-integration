"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execSync, exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);

/**
 * NTQQ element <-> OneBot v11 message segment converter.
 *
 * NTQQ element types:
 *   1=Text, 2=Pic, 3=File, 4=Ptt(voice), 5=Video, 6=Face,
 *   7=Reply, 8=GrayTip, 10=Ark, 11=MarketFace, 14=Markdown,
 *   16=MultiForward, 17=InlineKeyboard
 *
 * AtType: 0=Unknown, 1=All, 2=One
 * ChatType: 1=C2C(friend), 2=Group, 100=TempC2CFromGroup
 */

const IMAGE_HTTP_HOST = "https://gchat.qpic.cn";
const TEMP_DIR = process.env.RIN_MEDIA_DIR || path.join(os.tmpdir(), "waylay-media");

// Ensure temp directory exists
try { fs.mkdirSync(TEMP_DIR, { recursive: true }); } catch {}

// ---- Image file proxy (avoids CDN rkey expiration) ----

const _imageFileCache = new Map(); // "md5.ext" -> local path
let _fileProxyBase = ""; // e.g. "http://127.0.0.1:3001"
const MAX_IMAGE_CACHE = 5000;

/** Configure the base URL for file proxy (called once from adapter start) */
function setFileProxyBase(base) {
  _fileProxyBase = base;
}

/** Register an image file path in the cache */
function registerImageFile(key, filePath) {
  _imageFileCache.set(key, filePath);
  if (_imageFileCache.size > MAX_IMAGE_CACHE) {
    const oldest = _imageFileCache.keys().next().value;
    _imageFileCache.delete(oldest);
  }
}

/** Look up a cached image file by key (md5.ext). Falls back to searching NTQQ Pic dirs. */
function getImageFilePath(key) {
  const cached = _imageFileCache.get(key);
  if (cached && fs.existsSync(cached)) return cached;

  // Fallback: search NTQQ media cache directories (Pic + Emoji)
  const qqDir = path.join(process.env.HOME || "/root", ".config", "QQ");
  try {
    for (const d of fs.readdirSync(qqDir)) {
      if (!d.startsWith("nt_qq_")) continue;
      const ntData = path.join(qqDir, d, "nt_data");
      const searchDirs = ["Pic", "Emoji/emoji-recv"];
      for (const sub of searchDirs) {
        const base = path.join(ntData, sub);
        if (!fs.existsSync(base)) continue;
        for (const month of fs.readdirSync(base)) {
          const oriDir = path.join(base, month, "Ori");
          const target = path.join(oriDir, key);
          if (fs.existsSync(target)) {
            _imageFileCache.set(key, target);
            return target;
          }
        }
      }
    }
  } catch {}
  return null;
}

/**
 * Resolve a file reference to a local path with metadata.
 * Supports: base64://..., http(s)://..., file:///..., or local path.
 * Returns { path, size, md5 } plus optional image dimensions.
 */
async function resolveMediaFile(file, defaultExt) {
  if (!file) return null;

  // base64 encoded
  if (file.startsWith("base64://")) {
    const b64 = file.slice(9);
    const buf = Buffer.from(b64, "base64");
    const md5 = crypto.createHash("md5").update(buf).digest("hex");
    const ext = defaultExt || detectImageExt(buf);
    const filePath = path.join(TEMP_DIR, `${md5}.${ext}`);
    fs.writeFileSync(filePath, buf);
    return { path: filePath, size: buf.length, md5 };
  }

  // HTTP(S) URL — download with curl (async to avoid blocking event loop)
  if (file.startsWith("http://") || file.startsWith("https://")) {
    const urlMd5 = crypto.createHash("md5").update(file).digest("hex");
    const filePath = path.join(TEMP_DIR, `${urlMd5}.tmp`);
    try {
      await execAsync(`curl -fsSL -o "${filePath}" "${file}"`, { timeout: 60000 });
      const buf = fs.readFileSync(filePath);
      const md5 = crypto.createHash("md5").update(buf).digest("hex");
      const ext = defaultExt || detectExtFromName(file) || detectImageExt(buf);
      const finalPath = path.join(TEMP_DIR, `${md5}.${ext}`);
      if (finalPath !== filePath) fs.renameSync(filePath, finalPath);
      return { path: finalPath, size: buf.length, md5 };
    } catch (e) {
      console.error("[message] Failed to download file:", e.message);
      return null;
    }
  }

  // file:// protocol
  if (file.startsWith("file://")) {
    const localPath = file.slice(7);
    if (fs.existsSync(localPath)) {
      const buf = fs.readFileSync(localPath);
      const md5 = crypto.createHash("md5").update(buf).digest("hex");
      return { path: localPath, size: buf.length, md5 };
    }
    console.warn(`[message] file:// path not found: ${localPath.substring(0, 120)}`
      + (fs.existsSync("/.dockerenv") ? " (running in Docker — mount this host path as a volume)" : ""));
    return null;
  }

  // Direct local path
  if (fs.existsSync(file)) {
    const buf = fs.readFileSync(file);
    const md5 = crypto.createHash("md5").update(buf).digest("hex");
    return { path: file, size: buf.length, md5 };
  }

  return null;
}

/** Wrapper for image files — adds dimensions and validates image data */
async function resolveImageFile(file) {
  const resolved = await resolveMediaFile(file);
  if (!resolved) return null;
  const buf = fs.readFileSync(resolved.path);
  // Reject non-image data (e.g., QQ CDN error JSON with expired rkey)
  if (!isImageData(buf)) {
    const preview = buf.toString("utf8", 0, Math.min(buf.length, 120));
    console.warn(`[message] Rejected non-image data (${buf.length} bytes): ${preview}`);
    return null;
  }
  const dim = getImageDimensions(buf);
  return { ...resolved, ...dim };
}

function isImageData(buf) {
  if (!buf || buf.length < 4) return false;
  // PNG, JPEG, GIF, WEBP, BMP
  if (buf[0] === 0x89 && buf[1] === 0x50) return true; // PNG
  if (buf[0] === 0xFF && buf[1] === 0xD8) return true; // JPEG
  if (buf[0] === 0x47 && buf[1] === 0x49) return true; // GIF
  if (buf[0] === 0x52 && buf[1] === 0x49) return true; // WEBP (RIFF)
  if (buf[0] === 0x42 && buf[1] === 0x4D) return true; // BMP
  return false;
}

function detectExtFromName(name) {
  const m = name.match(/\.(\w{2,5})(?:[?#]|$)/);
  return m ? m[1].toLowerCase() : null;
}

function detectImageExt(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "png";
  if (buf[0] === 0xFF && buf[1] === 0xD8) return "jpg";
  if (buf[0] === 0x47 && buf[1] === 0x49) return "gif";
  if (buf[0] === 0x52 && buf[1] === 0x49) return "webp";
  return "png";
}

function getImageDimensions(buf) {
  try {
    // PNG: width at offset 16, height at offset 20 (big-endian uint32)
    if (buf[0] === 0x89 && buf[1] === 0x50) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // JPEG: scan for SOF0 marker (0xFF 0xC0)
    if (buf[0] === 0xFF && buf[1] === 0xD8) {
      for (let i = 2; i < buf.length - 8; i++) {
        if (buf[i] === 0xFF && (buf[i + 1] === 0xC0 || buf[i + 1] === 0xC2)) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        }
      }
    }
  } catch {}
  return { width: 0, height: 0 };
}

// ---- NTQQ elements -> OneBot v11 segments ----

function ntToOneBot(elements, msg) {
  const segments = [];
  if (!elements || !Array.isArray(elements)) return segments;

  for (const el of elements) {
    const seg = convertElement(el, msg);
    if (seg) {
      if (Array.isArray(seg)) segments.push(...seg);
      else segments.push(seg);
    }
  }
  return segments;
}

function convertElement(el, msg) {
  // Text or At
  if (el.textElement) {
    const te = el.textElement;
    if (te.atType === 1) {
      return { type: "at", data: { qq: "all" } };
    }
    if (te.atType === 2) {
      const qq = te.atUid && te.atUid !== "0" ? te.atUid : te.content?.replace("@", "");
      return { type: "at", data: { qq: String(qq), name: te.content?.replace("@", "") } };
    }
    if (!te.content) return null;
    return { type: "text", data: { text: te.content } };
  }

  // Reply
  if (el.replyElement) {
    /**
     * 诊断（2026-11-01 夜）：把 replyElement 的字段原样打一次。
     *
     * 为什么需要：`get_msg` 恒 null 的根因还没坐实 —— 我们能看到的只有"发出去的 id
     * 查不到"，而这个 id 到底取自 `sourceMsgIdInRecords` 还是 `replayMsgId`、
     * 它是不是被引用那条消息的真实 msgId，**只有把字段打出来才知道**。
     * 上游 0.4.3 的实现与我们改之前完全一致（也只认短 id），所以这不是版本问题。
     */
    try {
      const r = el.replyElement;
      console.log("[reply-element] " + JSON.stringify({
        sourceMsgIdInRecords: r.sourceMsgIdInRecords,
        replayMsgRootMsgId: r.replayMsgRootMsgId,
        replayMsgId: r.replayMsgId,
        replyMsgId: r.replyMsgId,
        msgId: r.msgId,
        msgSeq: r.msgSeq,
        replayMsgSeq: r.replayMsgSeq,
        replayMsgRootSeq: r.replayMsgRootSeq,
        replyMsgClientSeq: r.replyMsgClientSeq,
        senderUin: r.senderUin,
        senderUidStr: r.senderUidStr,
        sourceMsgText: r.sourceMsgText,
        sourceMsgTextElemsLen: Array.isArray(r.sourceMsgTextElems) ? r.sourceMsgTextElems.length : r.sourceMsgTextElems ? 1 : 0,
        keys: Object.keys(r),
      }));
    } catch (e) { /* 打日志失败绝不能影响收消息 */ }
    return {
      type: "reply",
      data: {
        id: String(el.replyElement.sourceMsgIdInRecords || el.replyElement.replayMsgId || "0"),
        // 原文预览（有就带上）：OneBot v11 没有这个字段，多一个键对别的实现无害，
        // 对我们是"零成本拿到引用内容"的一条捷径。
        ...(el.replyElement.sourceMsgText ? { text: String(el.replyElement.sourceMsgText) } : {}),
        // 两个附加线索（2026-11-02 早）：实测 `sourceMsgIdInRecords` **不是** msgId
        // （用真 msgId 查内核能取到，用它查永远是空 msgList、而且 result:0 不报错），
        // 所以把 seq 一起给出去，让上层能用"按 seq 取"这条路。
        ...(el.replyElement.replayMsgSeq ? { seq: String(el.replyElement.replayMsgSeq) } : {}),
        ...(el.replyElement.replayMsgRootMsgId ? { root: String(el.replyElement.replayMsgRootMsgId) } : {}),
      },
    };
  }

  // Image
  if (el.picElement) {
    const pe = el.picElement;
    // 原始 CDN 地址**先留一份**（2026-11-03 早）：下面会被本地代理 URL 覆盖，
    // 而代理在"这个 key 没登记/文件不在本地"时是 10 秒后 404。
    // 留一份 origin_url，桥就有第二条路可走（rkey 对我们的新消息通常还没过期）。
    const originUrl = pe.originImageUrl
      ? (pe.originImageUrl.startsWith("http") ? pe.originImageUrl : IMAGE_HTTP_HOST + pe.originImageUrl)
      : "";
    let url = originUrl;

    // Set proxy URL for images (actual download triggered by events.js via NTQQ API)
    const md5 = pe.md5HexStr || "";
    if (md5 && _fileProxyBase) {
      const ext = detectExtFromName(pe.fileName) || "jpg";
      const cacheKey = `${md5}.${ext}`;
      url = `${_fileProxyBase}/file/${cacheKey}`;
    }

    return {
      type: "image",
      data: {
        file: pe.fileName || "",
        subType: pe.picSubType,
        url,
        origin_url: originUrl,
        file_size: String(pe.fileSize || "0"),
      },
    };
  }

  // Video
  if (el.videoElement) {
    return {
      type: "video",
      data: {
        file: el.videoElement.fileName || "",
        url: el.videoElement.filePath || "",
        file_size: String(el.videoElement.fileSize || "0"),
      },
    };
  }

  // File
  if (el.fileElement) {
    return {
      type: "file",
      data: {
        file: el.fileElement.fileName || "",
        url: el.fileElement.filePath || "",
        file_id: el.fileElement.fileUuid || "",
        file_size: String(el.fileElement.fileSize || "0"),
      },
    };
  }

  // Voice (PTT)
  if (el.pttElement) {
    return {
      type: "record",
      data: {
        file: el.pttElement.fileName || "",
        url: el.pttElement.filePath || "",
        file_size: String(el.pttElement.fileSize || "0"),
      },
    };
  }

  // Ark (JSON card / forward)
  if (el.arkElement) {
    try {
      const data = JSON.parse(el.arkElement.bytesData);
      if (data.app === "com.tencent.multimsg") {
        return { type: "forward", data: { id: msg?.msgId || "0" } };
      }
    } catch {}
    return { type: "json", data: { data: el.arkElement.bytesData } };
  }

  // Face
  if (el.faceElement) {
    const fe = el.faceElement;
    if (fe.faceType === 5 && fe.faceIndex === 1) {
      return { type: "shake", data: {} };
    }
    if (fe.faceIndex === 358) {
      return { type: "dice", data: { result: fe.resultId } };
    }
    if (fe.faceIndex === 359) {
      return { type: "rps", data: { result: fe.resultId } };
    }
    return { type: "face", data: { id: String(fe.faceIndex) } };
  }

  // MarketFace (sticker)
  if (el.marketFaceElement) {
    const mf = el.marketFaceElement;
    const dir = (mf.emojiId || "").substring(0, 2);
    return {
      type: "mface",
      data: {
        summary: mf.faceName || "",
        url: `https://gxh.vip.qq.com/club/item/parcel/item/${dir}/${mf.emojiId}/raw300.gif`,
        emoji_id: mf.emojiId,
        emoji_package_id: mf.emojiPackageId,
        key: mf.key,
      },
    };
  }

  // Markdown
  if (el.markdownElement) {
    return { type: "markdown", data: { content: el.markdownElement.content || "" } };
  }

  // MultiForward
  if (el.multiForwardMsgElement) {
    /**
     * 2026-11-02 下午改：`id` 要用 **resId**，不是外层消息的 msgId。
     *
     * 原来给的是 `msg.msgId`，于是上层拿它去 `get_forward_msg` / `getMultiMsg` 永远取不到内容
     * （展开结果恒为空 ⇒ 用户看到"聊天记录发不过去"）。`resId` 才是"这份聊天记录"的身份，
     * 内核 `getMultiMsg(resId)` 要的正是它（NapCat 构造假消息时用的也是 resId）。
     * `msg_id` 另存一份，方便排查"这条卡片本身是哪条消息"。
     */
    const resId = String(el.multiForwardMsgElement.resId || "");
    return {
      type: "forward",
      data: {
        id: resId || String((msg && msg.msgId) || "0"),
        res_id: resId,
        msg_id: String((msg && msg.msgId) || ""),
      },
    };
  }

  return null;
}

// ---- OneBot v11 segments -> NTQQ send elements ----

async function oneBotToNt(segments, uidResolver) {
  if (!Array.isArray(segments)) {
    if (typeof segments === "string") {
      return [makeTextElement(segments)];
    }
    segments = [segments];
  }

  const elements = [];
  for (const seg of segments) {
    if (typeof seg === "string") {
      elements.push(makeTextElement(seg));
      continue;
    }
    const el = await convertSegment(seg, uidResolver);
    if (el) elements.push(el);
  }
  return elements;
}

async function convertSegment(seg, uidResolver) {
  switch (seg.type) {
    case "text":
      return makeTextElement(seg.data?.text || "");

    case "at": {
      const qq = String(seg.data?.qq || "");
      if (qq === "all") {
        return {
          elementType: 1,
          elementId: "",
          textElement: { content: "@全体成员", atType: 1, atUid: "0", atTinyId: "", atNtUid: "all" },
        };
      }
      const resolved = uidResolver?.(qq);
      const uid = typeof resolved === "string" ? resolved : resolved?.uid || "";
      const name = (typeof resolved === "object" ? resolved?.name : null) || seg.data?.name || qq;
      return {
        elementType: 1,
        elementId: "",
        textElement: {
          content: `@${name}`,
          atType: 2,
          atUid: uid || qq,
          atTinyId: "",
          atNtUid: uid,
        },
      };
    }

    case "face":
      return {
        elementType: 6,
        elementId: "",
        faceElement: {
          faceIndex: parseInt(seg.data?.id) || 0,
          faceType: parseInt(seg.data?.sub_type) || 1,
          sourceType: 1,
        },
      };

    case "reply":
      return {
        elementType: 7,
        elementId: "",
        replyElement: {
          replayMsgSeq: "0",
          replayMsgId: String(seg.data?.id || "0"),
          senderUin: "0",
          senderUinStr: "0",
        },
      };

    case "image": {
      const fileRef = seg.data?.file || "";
      const resolved = await resolveImageFile(fileRef);
      if (!resolved) {
        console.warn("[message] Could not resolve image:", fileRef.substring(0, 80));
        return null;
      }
      return {
        elementType: 2,
        elementId: "",
        picElement: {
          md5HexStr: resolved.md5,
          fileSize: String(resolved.size),
          fileName: path.basename(resolved.path),
          sourcePath: resolved.path,
          original: true,
          picType: 1000,
          picSubType: 0,
          picWidth: resolved.width || 0,
          picHeight: resolved.height || 0,
          fileUuid: "",
          fileSubId: "",
          thumbFileSize: 0,
          summary: "[图片]",
        },
      };
    }

    case "video": {
      const fileRef = seg.data?.file || "";
      const resolved = await resolveMediaFile(fileRef, "mp4");
      if (!resolved) {
        console.warn("[message] Could not resolve video:", fileRef.substring(0, 80));
        return null;
      }
      // Generate thumbnail if ffmpeg is available, otherwise use placeholder
      const thumbInfo = await generateVideoThumb(resolved.path, resolved.md5);
      return {
        elementType: 5,
        elementId: "",
        videoElement: {
          fileName: path.basename(resolved.path),
          filePath: resolved.path,
          videoMd5: resolved.md5,
          thumbMd5: thumbInfo.md5,
          fileTime: await getVideoDuration(resolved.path),
          thumbPath: new Map([[0, thumbInfo.path]]),
          thumbSize: thumbInfo.size,
          thumbWidth: thumbInfo.width || 1920,
          thumbHeight: thumbInfo.height || 1080,
          fileSize: String(resolved.size),
        },
      };
    }

    case "record": {
      const fileRef = seg.data?.file || "";
      const resolved = await resolveMediaFile(fileRef, "amr");
      if (!resolved) {
        console.warn("[message] Could not resolve record:", fileRef.substring(0, 80));
        return null;
      }
      return {
        elementType: 4,
        elementId: "",
        pttElement: {
          fileName: path.basename(resolved.path),
          filePath: resolved.path,
          md5HexStr: resolved.md5,
          fileSize: String(resolved.size),
          duration: await getAudioDuration(resolved.path),
          formatType: 1,
          voiceType: 1,
          voiceChangeType: 0,
          /**
           * ★ 2026-10-31 修：这里原来给的是 `true`（boolean），而 NTQQ 这一位是 **number**。
           * 对照 NapCat 的类型定义 `canConvert2Text: number` 改成 1。
           */
          canConvert2Text: 1,
          waveAmplitudes: [0, 18, 9, 23, 16, 17, 16, 15, 44, 17, 24, 20, 14, 15, 17],
          fileSubId: "",
          playState: 1,
          autoConvertText: 0,
          storeID: 0,
          otherBusinessInfo: {},
          /**
           * ★★ 2026-10-31 真正的原因（QQ 9.9.36 起语音发不出去）。
           *
           * 出错信息是一句 `Cannot convert undefined or null to object`，看不出是哪个字段。
           * 打出来的 elements shape 显示**所有原有字段都有值、类型也对**，所以不是"某字段是
           * undefined"，而是 **NTQQ 期望一个我们没有的字段**，并对它做对象操作。
           *
           * 对照 NapCat 的 pttElement 字段表（15 个）—— 我们只有 13 个，缺的正是这两个：
           *     pttElement: [... 'autoConvertText', 'storeID', 'otherBusinessInfo'];
           * `otherBusinessInfo` 是 **object**：给它 undefined，NTQQ 一展开就抛
           * "Cannot convert undefined or null to object"，与现象完全吻合。
           *
           * （`waveAmplitudes` 保持 15 个元素：QFun 的经验是"为空时部分版本语音条不显示"，
           *   但那是显示问题，不是这次的崩溃点，先不动。）
           */
        },
      };
    }

    case "file": {
      const fileRef = seg.data?.file || "";
      const name = seg.data?.name || "";
      const resolved = await resolveMediaFile(fileRef);
      if (!resolved) {
        console.warn("[message] Could not resolve file:", fileRef.substring(0, 80));
        return null;
      }
      return {
        elementType: 3,
        elementId: "",
        fileElement: {
          fileName: name || path.basename(resolved.path),
          filePath: resolved.path,
          fileSize: String(resolved.size),
          folderId: "",
        },
      };
    }

    case "json":
      return {
        elementType: 10,
        elementId: "",
        arkElement: { bytesData: seg.data?.data || "{}", linkInfo: null, subElementType: null },
      };

    case "dice":
      return {
        elementType: 6,
        elementId: "",
        faceElement: {
          faceIndex: 358,
          faceType: 3,
          resultId: String(seg.data?.result || Math.floor(Math.random() * 6) + 1),
          packId: "1",
          stickerId: "33",
          sourceType: 1,
          stickerType: 2,
          surpriseId: "",
        },
      };

    case "rps":
      return {
        elementType: 6,
        elementId: "",
        faceElement: {
          faceIndex: 359,
          faceType: 3,
          resultId: String(seg.data?.result || Math.floor(Math.random() * 3) + 1),
          packId: "1",
          stickerId: "34",
          sourceType: 1,
          stickerType: 2,
          surpriseId: "",
        },
      };

    case "music": {
      const d = seg.data || {};
      if (d.type === "custom") {
        const ark = {
          app: "com.tencent.structmsg",
          desc: "音乐",
          view: "music",
          ver: "0.0.0.1",
          prompt: d.title || "音乐分享",
          meta: {
            music: {
              action: "", android_pkg_name: "", app_type: 1, appid: 100497308,
              desc: d.content || "", jumpUrl: d.url || "", musicUrl: d.audio || "",
              preview: d.image || "", sourceMsgId: "0", source_icon: "",
              source_url: "", tag: "音乐分享", title: d.title || "",
            },
          },
        };
        return {
          elementType: 10,
          elementId: "",
          arkElement: { bytesData: JSON.stringify(ark), linkInfo: null, subElementType: null },
        };
      }
      // QQ/163 music by ID not yet supported
      return null;
    }

    case "poke":
      // Poke is handled at the action level, not as a message element
      return null;

    default:
      return null;
  }
}

// 1x1 transparent PNG placeholder for video thumbnails when ffmpeg unavailable
const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB" +
  "Nl7BcQAAAABJRU5ErkJggg==", "base64"
);

/** Generate a video thumbnail. Uses ffmpeg if available, otherwise a placeholder. */
async function generateVideoThumb(videoPath, videoMd5) {
  const thumbPath = path.join(TEMP_DIR, `${videoMd5}_thumb.png`);
  try {
    await execAsync(
      `ffmpeg -y -i "${videoPath}" -ss 00:00:01 -vframes 1 -vf scale=320:-1 "${thumbPath}" 2>/dev/null`,
      { timeout: 10000 }
    );
    const buf = fs.readFileSync(thumbPath);
    const md5 = crypto.createHash("md5").update(buf).digest("hex");
    const dim = getImageDimensions(buf);
    return { path: thumbPath, size: buf.length, md5, ...dim };
  } catch {
    // ffmpeg not available — write placeholder
    fs.writeFileSync(thumbPath, PLACEHOLDER_PNG);
    const md5 = crypto.createHash("md5").update(PLACEHOLDER_PNG).digest("hex");
    return { path: thumbPath, size: PLACEHOLDER_PNG.length, md5, width: 1, height: 1 };
  }
}

/** Get video duration in seconds via ffprobe. Returns default if unavailable. */
async function getVideoDuration(filePath) {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}" 2>/dev/null`,
      { timeout: 5000 }
    );
    return Math.round(parseFloat(stdout.trim())) || 15;
  } catch {
    return 15;
  }
}

/** Get audio duration in seconds via ffprobe. Returns default if unavailable. */
async function getAudioDuration(filePath) {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}" 2>/dev/null`,
      { timeout: 5000 }
    );
    return Math.max(1, Math.round(parseFloat(stdout.trim()))) || 5;
  } catch {
    return 5;
  }
}

function makeTextElement(text) {
  return {
    elementType: 1,
    elementId: "",
    textElement: { content: String(text), atType: 0, atUid: "", atTinyId: "", atNtUid: "" },
  };
}

// ---- Helpers ----

/** Build raw_message string from OneBot segments */
function segmentsToRawMessage(segments) {
  return segments
    .map((s) => {
      switch (s.type) {
        case "text": return s.data.text;
        case "at": return `@${s.data.qq === "all" ? "全体成员" : s.data.name || s.data.qq}`;
        case "face": return `[表情${s.data.id}]`;
        case "image": return "[图片]";
        case "record": return "[语音]";
        case "video": return "[视频]";
        case "file": return `[文件]`;
        case "reply": return "";
        case "json": return "[JSON]";
        case "forward": return "[转发消息]";
        case "dice": return "[骰子]";
        case "rps": return "[猜拳]";
        case "shake": return "[戳一戳]";
        case "mface": return `[${s.data.summary || "表情"}]`;
        default: return `[${s.type}]`;
      }
    })
    .join("");
}

module.exports = { ntToOneBot, oneBotToNt, segmentsToRawMessage, resolveMediaFile, resolveImageFile, setFileProxyBase, getImageFilePath, registerImageFile };
