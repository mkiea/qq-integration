"use strict";

const fs = require("fs");
const path = require("path");
const { oneBotToNt, resolveMediaFile, ntToOneBot, segmentsToRawMessage, registerImageFile } = require("./message");

/**
 * 把一条消息里的图片**登记进本地文件代理**（2026-11-02 下午）。
 *
 * 为什么需要：`events.js` 只在"**新收到**的图片"时调 `registerImageFile`；
 * 而引用/历史消息里的图片是**从内核查回来的**，没走过那条路 ⇒ 代理查不到 ⇒ 404。
 * 而 QQ 本地其实有那份缓存，只是没人告诉代理它在哪。
 * 登记之后，`url` 就是 `http://127.0.0.1:<port>/file/<md5>.jpg`，桥不必再去 CDN
 * 拿一个已经过期的 rkey（真机报错：`download HTTP 400（invalid rkey -5503010）`）。
 */
function registerImagesOf(rec, bridge) {
  try {
    const svc = bridge && bridge.session && typeof bridge.session.getMsgService === "function"
      ? bridge.session.getMsgService()
      : null;
    if (!svc) return;
    for (const el of (rec && rec.elements) || []) {
      const pe = el && el.picElement;
      if (!pe) continue;
      /**
       * ★ 2026-11-03 早修：两个"静默跳过"让转发里的图**一张都登记不上**，
       * 代理于是等 10 秒再 404 —— 真机表现是"转发里的图只下来一两张"，
       * 而 10 张记录要等 50 秒（每张 10 秒）。
       *
       *   ① `md5HexStr` 在**转发记录**的 picElement 上经常是空的（只有 fileName）。
       *      而 fileName 本身就是 `<MD5大写>.<ext>`，可以直接反推。
       *   ② 路径解析只试了 `getRichMediaFilePathForGuild` 一个 API，它返回空就直接放弃。
       *      内核同一族还有 `getRichMediaFilePath` / `getImagePath`，挨个试。
       *   ③ 失败**必须打日志**：原来 `catch {}` 吞掉一切，"登记成功"和"根本没登记"
       *      在日志里长得一模一样 —— 于是只能靠猜。
       */
      const md5 = String(
        pe.md5HexStr
        || (/^([0-9a-f]{32})(?=[.\-_]|$)/i.exec(String(pe.fileName || "")) || [])[1]
        || "",
      ).toLowerCase();
      if (md5 === "") {
        console.log("[img-reg] 跳过：拿不到 md5（fileName=" + String(pe.fileName || "").slice(0, 40) + "）");
        continue;
      }
      const pathInfo = {
        md5HexStr: md5,
        fileName: pe.fileName || "",
        elementType: 2,
        elementSubType: 0,
        thumbSize: 0,
        needCreate: false,
        downloadType: 1,
        file_uuid: "",
      };
      let expected = "";
      for (const api of ["getRichMediaFilePathForGuild", "getRichMediaFilePath", "getImagePath"]) {
        if (typeof svc[api] !== "function") continue;
        try {
          const got = svc[api](pathInfo);
          if (typeof got === "string" && got !== "") { expected = got; break; }
        } catch (e) { /* 换下一个 API */ }
      }
      if (expected === "") {
        console.log("[img-reg] 跳过：路径解析全空 md5=" + md5.slice(0, 8));
        continue;
      }
      const ext = (String(pe.fileName || "").match(/\.(\w{2,5})(?:[?#]|$)/) || [])[1] || "jpg";
      registerImageFile(`${md5}.${ext.toLowerCase()}`, expected);
    }
  } catch (e) {
    // 登记失败不影响消息返回，但要留痕（原来这里彻底静默）
    console.log("[img-reg] 异常：" + (e && e.message ? e.message : e));
  }
}
const { createListener } = require("../listener");

/**
 * OneBot v11 action handlers.
 * Each handler takes (params, bridge, eventTranslator) and returns the response data.
 */

/** Wrap a promise with a timeout. Rejects if the promise doesn't settle in time. */
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), ms); }),
  ]).finally(() => clearTimeout(timer));
}

const handlers = {};

// ---- Meta / Info ----

handlers.get_login_info = async (params, bridge) => {
  return {
    user_id: Number(bridge.selfInfo.uin) || 0,
    nickname: bridge.selfInfo.nickName || "",
  };
};

handlers.get_version_info = async () => {
  return {
    app_name: "waylay",
    app_version: "0.4.0",
    protocol_version: "v11",
    app_full_name: "waylay v0.4.0",
  };
};

handlers.get_status = async (params, bridge) => {
  return {
    online: !!bridge.session,
    good: !!bridge.session,
  };
};

// ---- Friend / User ----

handlers.get_friend_list = async (params, bridge, eventTranslator) => {
  // Serve from cache (populated by onBuddyListChange events)
  const cached = eventTranslator.getBuddyList();
  if (cached.size > 0) {
    const friends = [];
    for (const [uin, info] of cached) {
      friends.push({
        user_id: Number(uin) || 0,
        nickname: info.nick || info.remark || "",
        remark: info.remark || "",
      });
    }
    return friends;
  }
  // Cache empty — trigger a refresh (result arrives via listener)
  try { bridge.session?.getBuddyService().getBuddyList(true); } catch {}
  return [];
};

handlers.get_stranger_info = async (params, bridge, eventTranslator) => {
  const userId = String(params.user_id || "");
  const fallback = { user_id: Number(userId), nickname: "", sex: "unknown", age: 0 };
  if (!bridge.session) return fallback;

  // 1. Check buddy cache
  const buddy = eventTranslator.getBuddyList().get(userId);
  if (buddy?.nick) {
    return { user_id: Number(userId), nickname: buddy.nick, sex: "unknown", age: 0 };
  }
  // 2. Check group member cache (covers most Yunzai use cases)
  for (const [, members] of eventTranslator._groupMembers) {
    const member = members.get(userId);
    if (member?.nick) {
      return { user_id: Number(userId), nickname: member.nick, sex: "unknown", age: 0 };
    }
  }
  // 3. Event-based profile lookup via getUserSimpleInfo + onProfileSimpleChanged
  const uid = eventTranslator.getUidByUin(userId);
  if (uid) {
    try {
      const profilePromise = eventTranslator.waitForProfile(uid, 5000);
      bridge.session.getProfileService().getUserSimpleInfo(false, [uid]);
      const profile = await profilePromise;
      const nick = profile?.coreInfo?.nick || profile?.nick || "";
      if (nick) {
        return { user_id: Number(userId), nickname: nick, sex: "unknown", age: 0 };
      }
    } catch {}
  }
  return fallback;
};

// ---- Group ----

handlers.get_group_list = async (params, bridge, eventTranslator) => {
  // Use cached group list from onGroupListUpdate events
  const groups = eventTranslator.getGroupList();
  if (groups.length > 0) {
    return groups.map((g) => ({
      group_id: Number(g.groupCode) || 0,
      group_name: g.groupName || "",
      member_count: g.memberCount || 0,
      max_member_count: g.maxMember || 0,
    }));
  }
  // Fallback: trigger a refresh (data arrives via listener, return empty for now)
  try { bridge.session?.getGroupService().getGroupList(true); } catch {}
  return [];
};

handlers.get_group_info = async (params, bridge, eventTranslator) => {
  const groupId = String(params.group_id || "");
  const groups = eventTranslator.getGroupList();
  const g = groups.find((g) => g.groupCode === groupId);
  if (g) {
    return {
      group_id: Number(g.groupCode),
      group_name: g.groupName || "",
      member_count: g.memberCount || 0,
      max_member_count: g.maxMember || 0,
    };
  }
  return { group_id: Number(groupId), group_name: "", member_count: 0, max_member_count: 0 };
};

/**
 * Fetch group members via scene-based API.
 * Triggers getNextMemberList which delivers data via onMemberListChange listener,
 * populating the EventTranslator member cache.
 * Returns a Promise that resolves with cached data after a short delay.
 */
async function fetchGroupMembersAndWait(bridge, groupId, eventTranslator) {
  const groupService = bridge.session.getGroupService();
  try {
    const sceneId = groupService.createMemberListScene(groupId, `fetch_${Date.now()}`);
    await groupService.getNextMemberList(sceneId, undefined, 3000);
    try { groupService.destroyMemberListScene(sceneId); } catch {}
  } catch {}
  // Wait briefly for onMemberListChange events to populate cache
  await new Promise((r) => setTimeout(r, 500));
}

handlers.get_group_member_list = async (params, bridge, eventTranslator) => {
  const groupId = String(params.group_id || "");
  if (!bridge.session) return [];

  // Return from cache if populated (preloaded on startup)
  let cached = eventTranslator._groupMembers.get(groupId);
  if (!cached || cached.size === 0) {
    // Cache miss — trigger fetch and wait for listener callback
    await fetchGroupMembersAndWait(bridge, groupId, eventTranslator);
    cached = eventTranslator._groupMembers.get(groupId);
  }
  if (!cached || cached.size === 0) return [];

  const members = [];
  for (const [uin, info] of cached) {
    members.push(formatMember({
      uin, uid: info.uid, nick: info.nick, cardName: info.card,
    }, groupId));
  }
  return members;
};

handlers.get_group_member_info = async (params, bridge, eventTranslator) => {
  const groupId = String(params.group_id || "");
  const userId = String(params.user_id || "");
  if (!bridge.session) return formatMember({}, groupId);

  // Check cache first
  let member = eventTranslator.getGroupMember(groupId, userId);
  if (!member) {
    // Only fetch if the group's member cache is empty (not yet loaded)
    const groupCache = eventTranslator._groupMembers.get(groupId);
    if (!groupCache || groupCache.size === 0) {
      await fetchGroupMembersAndWait(bridge, groupId, eventTranslator);
      member = eventTranslator.getGroupMember(groupId, userId);
    }
  }
  if (member) {
    return formatMember({
      uin: userId, uid: member.uid, nick: member.nick, cardName: member.card,
    }, groupId);
  }
  return formatMember({ uin: userId }, groupId);
};

/** Register a media file with NTQQ — returns the expected path, or null. */
function registerMedia(msgService, md5, fileName, elementType) {
  const pathInfo = {
    md5HexStr: md5 || "",
    fileName: fileName || "",
    elementType,
    elementSubType: 0,
    thumbSize: 0,
    needCreate: true,
    downloadType: 1,
    file_uuid: "",
  };
  const mediaPath = msgService.getRichMediaFilePathForGuild(pathInfo);
  if (mediaPath) {
    fs.mkdirSync(path.dirname(mediaPath), { recursive: true });
  }
  return mediaPath || null;
}

function formatMember(m, groupId) {
  const role = m.role === 4 ? "owner" : m.role === 3 ? "admin" : "member";
  return {
    group_id: Number(groupId) || 0,
    user_id: Number(m.uin) || 0,
    nickname: m.nick || "",
    card: m.cardName || "",
    sex: "unknown",
    age: 0,
    area: "",
    join_time: Number(m.joinTime) || 0,
    last_sent_time: Number(m.lastSpeakTime) || 0,
    level: String(m.memberLevel || "0"),
    role,
    unfriendly: false,
    title: m.specialTitle || "",
    title_expire_time: 0,
    card_changeable: false,
    shut_up_timestamp: Number(m.shutUpTime) || 0,
  };
}

// ---- Messages ----

handlers.send_msg = async (params, bridge, eventTranslator) => {
  const messageType = params.message_type || (params.group_id ? "group" : "private");
  if (messageType === "group") {
    return handlers.send_group_msg(params, bridge, eventTranslator);
  }
  return handlers.send_private_msg(params, bridge, eventTranslator);
};

handlers.send_group_msg = async (params, bridge, eventTranslator) => {
  const groupId = String(params.group_id || "");
  const peer = { chatType: 2, peerUid: groupId, guildId: "" };
  return await sendMessage(peer, params.message, bridge, eventTranslator);
};

handlers.send_private_msg = async (params, bridge, eventTranslator) => {
  const userId = String(params.user_id || "");
  // Convert UIN to UID for NT API (C2C requires UID)
  let peerUid = eventTranslator.getUidByUin(userId);
  if (!peerUid) {
    // Try profile service
    try {
      const profileService = bridge.session.getProfileService();
      const result = await profileService.getUidByUin("FriendsServiceImpl", [userId]);
      peerUid = result?.uidInfo?.get(userId) || null;
    } catch {}
  }
  if (!peerUid) {
    // Try buddy service with getUserDetailInfoByUin
    try {
      const buddyService = bridge.session.getBuddyService();
      const buddyList = await buddyService.getBuddyList(true);
      for (const cat of buddyList?.data || []) {
        for (const buddy of cat.buddyList || []) {
          if (buddy.uin === userId) {
            peerUid = buddy.uid;
            eventTranslator.recordUinUid(userId, buddy.uid);
            break;
          }
        }
        if (peerUid) break;
      }
    } catch {}
  }
  if (!peerUid) {
    console.warn("[onebot-actions] Cannot resolve UID for UIN:", userId);
    peerUid = userId; // fallback, will likely fail
  }
  const peer = { chatType: 1, peerUid, guildId: "" };
  return await sendMessage(peer, params.message, bridge, eventTranslator);
};

async function sendMessage(peer, message, bridge, eventTranslator) {
  if (!bridge.session) throw new Error("Session not ready");

  // Build UID+name resolver for @ mentions (async pre-resolve, then sync pass to converter)
  const segments = Array.isArray(message) ? message : typeof message === "string" ? [] : [message];
  const atResolveMap = new Map(); // uin -> { uid, name }
  for (const seg of segments) {
    if (seg.type !== "at" || seg.data?.qq === "all") continue;
    const uin = String(seg.data?.qq || "");
    if (!uin || atResolveMap.has(uin)) continue;

    // 1. Check cached group member info
    if (peer.chatType === 2) {
      const member = eventTranslator.getGroupMember(peer.peerUid, uin);
      if (member?.uid) {
        atResolveMap.set(uin, { uid: member.uid, name: member.card || member.nick || null });
        continue;
      }
    }

    // 2. Check UIN→UID cache
    let uid = eventTranslator.getUidByUin(uin);

    // 3. Async fallback: profile service lookup
    if (!uid) {
      try {
        const r = await bridge.session.getProfileService().getUidByUin("FriendsServiceImpl", [uin]);
        uid = r?.uidInfo?.get(uin) || null;
        if (uid) eventTranslator.recordUinUid(uin, uid);
      } catch {}
    }

    // 4. Get display name from profile if we have uid
    let name = null;
    if (uid && peer.chatType === 2) {
      try {
        const profiles = await bridge.session.getProfileService().getUserSimpleInfo(false, [uid]);
        const p = profiles?.profileMap?.get(uid) || profiles?.get?.(uid);
        if (p) name = p.nick || p.nickName || null;
      } catch {}
    }

    atResolveMap.set(uin, { uid: uid || "", name });
  }

  const uidResolver = atResolveMap.size > 0 ? (uin) => atResolveMap.get(uin) || { uid: "", name: null } : null;
  const elements = await oneBotToNt(message, uidResolver);
  if (!elements.length) throw new Error("Empty message");

  // Resolve reply elements: convert OneBot short ID -> real NTQQ msgId
  for (const el of elements) {
    if (el.elementType === 7 && el.replyElement) {
      const shortId = Number(el.replyElement.replayMsgId);
      const realMsgId = eventTranslator.resolveShortId(shortId);
      if (realMsgId) {
        el.replyElement.replayMsgId = realMsgId;
      }
      const cached = eventTranslator.getCachedMsg(shortId);
      if (cached) {
        el.replyElement.replayMsgSeq = cached._ntMsgSeq || "0";
        el.replyElement.senderUin = String(cached.sender?.user_id || "0");
        el.replyElement.senderUinStr = String(cached.sender?.user_id || "0");
      }
    }
  }

  // Register media files with NTQQ and copy to the expected paths
  const msgService = bridge.session.getMsgService();
  for (const el of elements) {
    try {
      if (el.elementType === 2 && el.picElement?.sourcePath) {
        // Image
        const mediaPath = registerMedia(msgService, el.picElement.md5HexStr, el.picElement.fileName, 2);
        if (mediaPath) {
          fs.copyFileSync(el.picElement.sourcePath, mediaPath);
          el.picElement.sourcePath = mediaPath;
          console.log("[onebot-actions] Image registered at:", mediaPath);
        }
      } else if (el.elementType === 5 && el.videoElement?.filePath) {
        // Video — register video file and thumbnail
        const mediaPath = registerMedia(msgService, el.videoElement.videoMd5, el.videoElement.fileName, 5);
        if (mediaPath) {
          fs.copyFileSync(el.videoElement.filePath, mediaPath);
          el.videoElement.filePath = mediaPath;
          // Place thumbnail at the Thumb path
          const origThumbPath = el.videoElement.thumbPath?.get(0);
          if (origThumbPath) {
            const thumbDir = path.dirname(mediaPath).replace(/[/\\]Ori[/\\]?/, path.sep + "Thumb" + path.sep);
            const thumbFilePath = path.join(thumbDir, `${el.videoElement.videoMd5}_0.png`);
            fs.mkdirSync(path.dirname(thumbFilePath), { recursive: true });
            fs.copyFileSync(origThumbPath, thumbFilePath);
            el.videoElement.thumbPath = new Map([[0, thumbFilePath]]);
          }
          console.log("[onebot-actions] Video registered at:", mediaPath);
        }
      } else if (el.elementType === 4 && el.pttElement?.filePath) {
        // Voice/PTT
        const mediaPath = registerMedia(msgService, el.pttElement.md5HexStr, el.pttElement.fileName, 4);
        if (mediaPath) {
          fs.copyFileSync(el.pttElement.filePath, mediaPath);
          el.pttElement.filePath = mediaPath;
          console.log("[onebot-actions] Voice registered at:", mediaPath);
        }
      } else if (el.elementType === 3 && el.fileElement?.filePath) {
        // File
        const mediaPath = registerMedia(msgService, null, el.fileElement.fileName, 3);
        if (mediaPath) {
          fs.copyFileSync(el.fileElement.filePath, mediaPath);
          el.fileElement.filePath = mediaPath;
          console.log("[onebot-actions] File registered at:", mediaPath);
        }
      }
    } catch (e) {
      console.warn(`[onebot-actions] Media registration error (type ${el.elementType}):`, e.message);
    }
  }

  try {
    const msgService = bridge.session.getMsgService();
    const result = await msgService.sendMsg("0", peer, elements, new Map());
    console.log("[onebot-actions] sendMsg result:", JSON.stringify(result)?.substring(0, 200));

    // For media messages, sendMsg returns -1 immediately — the actual upload
    // happens asynchronously via BDH. The message is still created (onAddSendMsg fires).
    // We return the msgId from the result regardless.
    const msgId = result?.msgId || result?.result?.msgId || "0";
    const shortId = eventTranslator.createShortId(msgId);
    return { message_id: shortId };
  } catch (e) {
    console.error("[onebot-actions] sendMessage error:", e.message);
    /**
     * 诊断补丁（2026-10-31，语音在 QQ 9.9.36 上发不出去）。
     *
     * 原始错误只有一句 `Cannot convert undefined or null to object` —— 看不出是哪个字段。
     * 实测已知：mp3 与 silk **同样失败**（silk 文件头与 QQ 自己缓存的一致），
     * 说明不是音频格式，而是 pttElement 的某个字段在新版 QQ 上不被接受。
     *
     * 这里把堆栈 + 元素**形状**（字段名与类型，不含文件内容）打到日志，一次就能定位。
     */
    try {
      console.error("[onebot-actions] stack:", String(e.stack || "").slice(0, 1200));
      const shape = (elements || []).map((el) => ({
        elementType: el.elementType,
        keys: Object.keys(el),
        ptt: el.pttElement
          ? Object.fromEntries(Object.entries(el.pttElement).map(([k, v]) => [
            k,
            Array.isArray(v) ? `array(${v.length})` : (v instanceof Map ? "Map" : (v === null ? "null" : typeof v)),
          ]))
          : undefined,
      }));
      console.error("[onebot-actions] elements shape:", JSON.stringify(shape));
    } catch { /* 诊断失败不能盖住原错误 */ }
    throw e;
  }
}

handlers.delete_msg = async (params, bridge, eventTranslator) => {
  const shortId = Number(params.message_id);
  const msgId = eventTranslator.resolveShortId(shortId);
  if (!msgId || !bridge.session) return null;

  // Need to find the message to get peer info
  const cached = eventTranslator.getCachedMsg(shortId);
  if (cached) {
    const peer = cached.group_id
      ? { chatType: 2, peerUid: String(cached.group_id), guildId: "" }
      : { chatType: 1, peerUid: String(cached.user_id), guildId: "" };
    try {
      await bridge.session.getMsgService().recallMsg(peer, [msgId]);
    } catch (e) {
      console.error("[onebot-actions] delete_msg error:", e.message);
    }
  }
  return null;
};

handlers.get_msg = async (params, bridge, eventTranslator) => {
  /**
   * ★ 两种 id 都要认（2026-11-01 夜修）。
   *
   * 缓存是按**短 id** 建的（`createShortId` → `cacheMsg(shortId, event)`），
   * 而 **reply 段里的 `data.id` 是 NTQQ 的真实 msgId**（19 位）。
   * 原来这里 `Number(params.message_id)` 直接当短 id 查 ⇒ 19 位 id 永远查不到
   * ⇒ get_msg 恒为 null ⇒ 上层"引用内容为空"。真机 11-01 一天 8 次引用 8 次失败。
   *
   * 现在：先按短 id 查；查不到再按真实 id 反查短 id（`shortIdOf`，只读不建）。
   */
  const raw = String(params?.message_id ?? "").trim();
  let shortId = Number(raw);
  let cached = eventTranslator.getCachedMsg(shortId);
  if (!cached && raw !== "") {
    const mapped = eventTranslator.shortIdOf(raw);
    if (mapped != null) {
      shortId = mapped;
      cached = eventTranslator.getCachedMsg(shortId);
    }
  }
  // 诊断（2026-11-01 夜）：一次日志说清"要的是哪个 id、映射命中没有、缓存多大"。
  // 上线前这里是黑盒，只能靠猜 —— 上游 0.4.3 也没有任何一行日志。
  try {
    console.log(`[get_msg] raw=${raw} short=${shortId} hit=${cached ? "yes" : "no"}`
      + ` cachedSize=${eventTranslator._msgCache ? eventTranslator._msgCache.size : "?"}`
      + ` mapped=${eventTranslator.shortIdOf(raw)}`);
  } catch (e) { /* 日志失败不影响返回 */ }
  if (cached) {
    return {
      message_id: shortId,
      real_id: shortId,
      sender: cached.sender,
      time: cached.time,
      message: cached.message,
      raw_message: cached.raw_message,
    };
  }
  /**
   * ★ 冷缓存就直接问内核（2026-11-01 夜，上游没有这一层）。
   *
   * 上游只查内存缓存（5000 条 FIFO），**QQ 一重启历史全冷** —— 而"引用一条旧消息"正是
   * 最常见的用法。这里补一条回源：带上 peer 就调 `getMsgsByMsgId(peer, [id])`。
   *
   * peer 由调用方（我们的桥）随请求带上来，字段 `_peer = {chatType, peerUid}`：
   * OneBot 没有这个字段，所以别的实现会忽略它，不会因为多了个键就报错。
   * 不猜 id 空间：`getMsgsByMsgId` 收的就是**真实 msgId**，正是 reply 段给的那个。
   */
  const peer = params && params._peer;
  const peerUid = peer && (peer.peerUid || peer.peer_uid);
  if (raw !== "" && peerUid && bridge && bridge.session && typeof bridge.session.getMsgService === "function") {
    const svc = bridge.session.getMsgService();
    const chatType = Number(peer.chatType) === 2 ? 2 : 1;
    /**
     * ★ peerUid 的两种形态（2026-11-01 夜，实测对比得出）。
     *
     * 上游的其他内核调用（`recallMsg`）用的是 **uin**（`String(user_id)` / `String(group_id)`），
     * 所以我们的桥也按那个惯例传 uin。但 `getMsgsByMsgId` 要的是 **C2C 的 uid**
     * （`u_XXXX` 那串）——同一方法、同一 msgId：
     *   peerUid=`u_IIms…FBA`（uid）→ msgList 有 1 条；
     *   peerUid=`<QQ>`（uin）→ msgList 空，`result:0, errMsg:""`（不报错，只是没有）。
     * 所以按 uin→uid 映射翻一次；翻不出来再原样试（群聊那边 peerUid 就是群号，不需要翻）。
     */
    let resolved = String(peerUid);
    if (chatType === 1 && /^\d+$/.test(resolved)) {
      try {
        const uid = eventTranslator && typeof eventTranslator.getUidByUin === "function"
          ? eventTranslator.getUidByUin(resolved)
          : null;
        if (uid) resolved = String(uid);
        else console.log(`[get_msg] uid-not-found uin=${resolved}（映射表里没有这个号，仍按原值去查）`);
      } catch (e) { /* 映射失败就用原值 */ }
    }
    const peerObj = { chatType, peerUid: resolved, guildId: "" };
    /**
     * 三条只读策略依次试（2026-11-02 早）。
     *
     * 为什么不是只试一条：**实测证明 `sourceMsgIdInRecords` 不是 msgId**
     * （拿真 msgId 调 `getMsgsByMsgId` 能取到消息；拿它调永远返回空 msgList，
     * 而且 `result:0, errMsg:""` —— 静默失败，不报错）。所以按 id 取那条路对它无效，
     * 必须另外留一条"按 seq 取"。内核方法的签名在 JS 侧看不出来（全是 0 形参、走回调），
     * 与其再猜一轮，不如把三条都试一遍、**把哪条成功打进日志**。
     * 全是只读查询，失败也只是返回空，不会写任何东西。
     */
    const seq = peer && (peer.seq || peer.replayMsgSeq);
    const strategies = [
      { name: "byMsgId", run: () => svc.getMsgsByMsgId(peerObj, [raw]) },
      /**
       * ★ 参数形状是**抄 NapCat 的**（不是猜的）：2026-11-02 早读它的 bundle，
       * 构造回复元素时用的就是这一行 ——
       *   `getMsgsBySeqAndCount(peer, seq.toString(), 1, true, true)`
       * 注意三点：seq 传**字符串**、`1` 是取几条、后面两个 `true` 不能省。
       * 我们第一轮只传了 `(peer, Number(seq), 1)` —— 少了两个布尔、seq 还是数字，
       * 很可能就是它返回空的原因。
       */
      seq ? { name: "bySeq", run: () => svc.getMsgsBySeqAndCount(peerObj, String(seq), 1, true, true) } : null,
      // 保守兜底：万一上面那条在这个 QQ 版本上签名不同，退回三参再试一次（只读，无副作用）。
      seq ? { name: "bySeq3", run: () => svc.getMsgsBySeqAndCount(peerObj, String(seq), 1) } : null,
      { name: "singleMsg", run: () => svc.getSingleMsg(peerObj, raw) },
      /**
       * 最后一招：**取最新 50 条，按 seq 本地比对**（2026-11-02 中午，NapCat 反哺）。
       *
       * NapCat 的 `get_group_msg_history` 在没有 seq 时走 `getAioFirstViewLatestMsgs(peer, count)`，
       * 而本机 QQ 没有 `getMsgHistory`（introspect 查过），所以这条是这里唯一可用的"批量取"。
       * 它不依赖任何 id 语义：seq 就是回复元素里那个 seq，拿来比就行。
       */
      seq ? {
        name: "historyScan",
        run: async () => {
          const res = await svc.getAioFirstViewLatestMsgs(peerObj, 50);
          const list = (res && res.msgList) || [];
          const hit = list.find((item) => String(item && item.msgSeq) === String(seq))
            || list.find((item) => String(item && item.msgId) === raw);
          return hit ? { result: 0, errMsg: "", msgList: [hit] } : { result: 0, errMsg: `historyScan 未命中（取了 ${list.length} 条）`, msgList: [] };
        },
      } : null,
    ].filter(Boolean);
    for (const strategy of strategies) {
      try {
        const res = await strategy.run();
        const list = (res && (res.msgList || res.msgs)) || (Array.isArray(res) ? res : []);
        const rec = Array.isArray(list) ? list[0] : null;
        if (!rec) {
          console.log(`[get_msg] ${strategy.name} miss id=${raw} peer=${resolved}`
            + ` result=${res && res.result} errMsg=${JSON.stringify(res && res.errMsg)}`);
          continue;
        }
        const segments = ntToOneBot(rec.elements, rec);
        console.log(`[get_msg] kernel hit via=${strategy.name} id=${raw} peer=${resolved} segments=${segments.length}`);
        // 图片先登记进本地代理，桥才下得动（见 registerImagesOf 的注释）。
        registerImagesOf(rec, bridge);
        return {
          message_id: shortId,
          real_id: raw,
          sender: {
            user_id: Number(rec.senderUin) || 0,
            nickname: rec.sendNickName || "",
            card: rec.sendMemberName || "",
          },
          time: Number(rec.msgTime) || 0,
          message: segments,
          raw_message: segmentsToRawMessage(segments),
        };
      } catch (e) {
        console.log(`[get_msg] ${strategy.name} error id=${raw}: ${e && e.message ? e.message : e}`);
      }
    }
    console.log(`[get_msg] 三条策略全空 id=${raw} peer=${resolved} seq=${seq || "-"}`);
  }
  return null;
};

/**
 * `__msgcall` —— 调试用：直接调 NTQQ 消息服务上的一个方法（2026-11-01 夜）。
 *
 * 为什么需要：`get_msg` 的冷缓存回源要确认"调哪个方法、参数怎么排"，而方法签名
 * 在 `fn.length` 上全是 0（内核方法用回调，不用 JS 形参）。没有这个口子，
 * 每验证一种调法都要改代码 + 重启 QQ。
 *
 * 用法：`!probe __msgcall {"method":"getMsgsByMsgId","args":[{"chatType":1,"peerUid":"<uin>","guildId":""},["<msgId>"]]}`
 * 只读查询，不写任何东西。
 */
handlers.__msgcall = async (params, bridge) => {
  if (!bridge || !bridge.session) return { ok: false, error: "会话没起来" };
  /**
   * `service` 可选（2026-11-02 傍晚加）：不止能调消息服务。
   *
   * 起因：查"发说说"时发现它**不走 packet 层**，只是拿 skey/pskey 再发 HTTP；
   * 而 skey/pskey 要到别的内核服务上问（`TipOffService.getPskey`、或 profile 那边）。
   * 没有这个口子，每换一个服务都要改一次代码 + 重启 QQ。
   * 传法：service 缺省 = 消息服务；否则取 `session.get<Service>Service()`。
   */
  const wanted = String((params && params.service) || "").trim();
  let svc = null;
  if (wanted === "") {
    svc = typeof bridge.session.getMsgService === "function" ? bridge.session.getMsgService() : null;
  } else {
    const getter = `get${wanted.replace(/^NodeIKernel|Service$/g, "")}Service`;
    const fn = bridge.session[getter] || bridge.session[`get${wanted}Service`];
    if (typeof fn === "function") {
      try { svc = fn.call(bridge.session) } catch (e) { /* 下面统一报错 */ }
    }
    if (!svc) {
      const available = Object.getOwnPropertyNames(Object.getPrototypeOf(bridge.session))
        .filter((name) => /^get.*Service$/.test(name));
      return { ok: false, error: `拿不到服务：${wanted}（试过 ${getter}）`, available };
    }
  }
  if (!svc) return { ok: false, error: "没有 getMsgService" };
  const callOne = async (method, args) => {
    const name = String(method || "");
    if (name === "" || typeof svc[name] !== "function") {
      // 列**全部**方法（2026-11-02 傍晚）：过滤过的列表会把有用的方法藏起来 ——
      // 查 qzone 票据时，TicketService 的真实 API 就是被 /msg|history|query/ 这个过滤挡掉的。
      const proto = [...new Set([
        ...Object.getOwnPropertyNames(svc),
        ...Object.getOwnPropertyNames(Object.getPrototypeOf(svc)),
      ])].filter((item) => item !== "constructor");
      return { ok: false, method: name, error: `没有这个方法：${name || "(空)"}`, available: proto };
    }
    try {
      const result = await svc[name](...(Array.isArray(args) ? args : []));
      const list = (result && (result.msgList || result.msgs)) || null;
      return {
        ok: true, method: name, args,
        // 只回"有多少条 + 第一条的骨架"：整条消息带 elements 时很占地方，也读不下去。
        count: Array.isArray(list) ? list.length : undefined,
        result: result && result.result !== undefined ? result.result : undefined,
        errMsg: result && result.errMsg,
        first: Array.isArray(list) && list[0]
          ? { msgId: list[0].msgId, msgSeq: list[0].msgSeq, msgTime: list[0].msgTime, segments: (list[0].elements || []).length }
          : null,
        raw: Array.isArray(list) && list[0] ? undefined : result,
      };
    } catch (error) {
      return { ok: false, method: name, args, error: (error && error.message) || String(error) };
    }
  };
  /**
   * 两种用法（2026-11-02 早）：
   *   单发 `{method, args}`
   *   批量 `{calls: [{method, args}, …]}` —— 一次 QQ 消息里试完所有候选签名。
   * 批量是必要的：内核方法全是 0 形参（走回调），签名只能试；一次试一个太慢，
   * 而且每试一次都要等人发一条消息。
   */
  const calls = Array.isArray(params && params.calls) ? params.calls : null;
  if (calls) {
    const out = [];
    for (const call of calls.slice(0, 20)) {
      out.push(await callOne(call && call.method, call && call.args));
    }
    return { ok: true, batch: out.length, calls: out };
  }
  return callOne(params && params.method, params && params.args);
};

// ---- Forward messages ----

/**
 * Normalize a single segment to standard {type, data} format.
 * Handles flat segments like {type:"image", file:"..."} -> {type:"image", data:{file:"..."}}
 */
function normalizeSegment(seg) {
  if (typeof seg === "string") return { type: "text", data: { text: seg } };
  if (!seg || !seg.type) return null;
  // Already has a data object — standard format
  if (seg.data && typeof seg.data === "object") return seg;
  // Flat format: {type:"image", file:"...", ...} -> {type:"image", data:{file:"...", ...}}
  const { type, ...rest } = seg;
  return { type, data: rest };
}

/**
 * Extract sendable message content from a forward node.
 * Supports multiple formats used by different bot frameworks:
 *   - Standard OneBot v11: {type:"node", data:{content:[...segments]}}
 *   - Yunzai/TRSS:         {message: segment_or_array, nickname, user_id}
 *   - Flat content:        {content: segment_or_array, ...}
 */
function extractNodeContent(node) {
  if (!node) return null;

  // Standard OneBot v11 node format
  let raw = null;
  if (node.type === "node" && node.data) {
    raw = node.data.content || node.data.message;
  }
  // Yunzai format: {message: ..., nickname, user_id}
  if (raw == null && node.message !== undefined) {
    raw = node.message;
  }
  // Alternative: {content: [...]}
  if (raw == null && node.content !== undefined) {
    raw = node.content;
  }

  if (raw == null) return null;

  // Normalize to array
  if (typeof raw === "string") return [{ type: "text", data: { text: raw } }];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map(normalizeSegment).filter(Boolean);
}

/**
 * Send a real combined forward message via multiForwardMsgWithComment.
 *
 * NTQQ requires msgIds backed by real sent messages for multiForwardMsg,
 * so we stage each node to self-peer (sendMsg), capture the real msgId
 * via onAddSendMsg, then forward all at once to the target.
 *
 * On failure, falls back to sending each node individually.
 */
async function sendForwardMsg(messages, destPeer, bridge, eventTranslator) {
  if (!bridge.session) throw new Error("Session not ready");

  const selfUid = bridge.selfInfo?.uid;
  if (!selfUid) {
    console.warn("[forward] No self UID, falling back to individual send");
    return await _sendForwardFallback(messages, destPeer, bridge, eventTranslator);
  }

  const selfPeer = { chatType: 1, peerUid: selfUid, guildId: "" };
  const msgService = bridge.session.getMsgService();
  const pendingQueue = []; // FIFO: onAddSendMsg resolvers in send order
  const msgInfos = [];

  const tempListener = createListener("", {
    onAddSendMsg(msgRecord) {
      if (msgRecord?.chatType === 1 && msgRecord?.peerUid === selfUid && pendingQueue.length > 0) {
        const pending = pendingQueue.shift();
        clearTimeout(pending.timer);
        pending.resolve(msgRecord.msgId);
      }
    },
  });
  msgService.addKernelMsgListener(tempListener);

  try {
    for (const node of messages) {
      const content = extractNodeContent(node);
      if (!content || content.length === 0) continue;

      const elements = await oneBotToNt(content);
      if (!elements.length) continue;

      // Register media files with NTQQ
      for (const el of elements) {
        try {
          if (el.elementType === 2 && el.picElement?.sourcePath) {
            const mp = registerMedia(msgService, el.picElement.md5HexStr, el.picElement.fileName, 2);
            if (mp) { fs.copyFileSync(el.picElement.sourcePath, mp); el.picElement.sourcePath = mp; }
          } else if (el.elementType === 5 && el.videoElement?.filePath) {
            const mp = registerMedia(msgService, el.videoElement.videoMd5, el.videoElement.fileName, 5);
            if (mp) {
              fs.copyFileSync(el.videoElement.filePath, mp); el.videoElement.filePath = mp;
              const tp = el.videoElement.thumbPath?.get(0);
              if (tp) {
                const td = path.dirname(mp).replace(/[/\\]Ori[/\\]?/, path.sep + "Thumb" + path.sep);
                const tf = path.join(td, `${el.videoElement.videoMd5}_0.png`);
                fs.mkdirSync(path.dirname(tf), { recursive: true });
                fs.copyFileSync(tp, tf);
                el.videoElement.thumbPath = new Map([[0, tf]]);
              }
            }
          } else if (el.elementType === 4 && el.pttElement?.filePath) {
            const mp = registerMedia(msgService, el.pttElement.md5HexStr, el.pttElement.fileName, 4);
            if (mp) { fs.copyFileSync(el.pttElement.filePath, mp); el.pttElement.filePath = mp; }
          }
        } catch (e) {
          console.warn("[forward] Media registration error:", e.message);
        }
      }

      // Stage to self-peer, capture real msgId via onAddSendMsg
      const msgIdPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("onAddSendMsg timeout")), 60000);
        pendingQueue.push({ resolve, reject, timer });
      });
      await msgService.sendMsg("0", selfPeer, elements, new Map());
      const msgId = await msgIdPromise;

      const nickname = node.nickname || node.data?.name || node.data?.nickname || bridge.selfInfo.nickName || "";
      msgInfos.push({ msgId, senderShowName: nickname });
    }

    if (msgInfos.length === 0) return { message_id: 0 };

    const result = await msgService.multiForwardMsgWithComment(
      msgInfos, selfPeer, destPeer, [], new Map()
    );
    console.log(`[forward] multiForwardMsg: ${msgInfos.length} nodes -> peer=${destPeer.peerUid}, result=${result?.errMsg || result?.result}`);
    return { message_id: 0 };

  } catch (e) {
    console.error("[forward] multiForwardMsg failed:", e.message, "- falling back to individual send");
    return await _sendForwardFallback(messages, destPeer, bridge, eventTranslator);
  } finally {
    try { msgService.removeKernelMsgListener(tempListener); } catch {}
    for (const p of pendingQueue) clearTimeout(p.timer);
  }
}

/** Fallback: send each node as an individual message (not combined forward). */
async function _sendForwardFallback(messages, peer, bridge, eventTranslator) {
  let lastMsgId = 0;
  for (const node of messages) {
    const content = extractNodeContent(node);
    if (!content || content.length === 0) continue;
    try {
      const result = await sendMessage(peer, content, bridge, eventTranslator);
      if (result?.message_id) lastMsgId = result.message_id;
    } catch (e) {
      console.error("[forward] fallback node error:", e.message);
    }
  }
  return { message_id: lastMsgId };
}

handlers.send_group_forward_msg = async (params, bridge, eventTranslator) => {
  const groupId = String(params.group_id || "");
  const messages = params.messages || [];
  const destPeer = { chatType: 2, peerUid: groupId, guildId: "" };
  return await sendForwardMsg(messages, destPeer, bridge, eventTranslator);
};

handlers.send_private_forward_msg = async (params, bridge, eventTranslator) => {
  const userId = String(params.user_id || "");
  let peerUid = eventTranslator.getUidByUin(userId);
  if (!peerUid) {
    try {
      const result = await bridge.session.getProfileService().getUidByUin("FriendsServiceImpl", [userId]);
      peerUid = result?.uidInfo?.get(userId) || null;
    } catch {}
  }
  if (!peerUid) {
    console.warn("[forward] send_private_forward_msg: cannot resolve UID for:", userId);
    peerUid = userId;
  }
  const destPeer = { chatType: 1, peerUid, guildId: "" };
  const messages = params.messages || [];
  return await sendForwardMsg(messages, destPeer, bridge, eventTranslator);
};

/**
 * 合并转发（"聊天记录"）取内容 —— 原来是**空壳**：
 *
 * ```js
 * handlers.get_forward_msg = async () => ({ messages: [] });  // "Would need to fetch..."
 * ```
 *
 * 后果：她收到一条聊天记录卡片时，桥调 `get_forward_msg` 拿到空数组，
 * 于是整条消息对她等于"展开后没有可读内容"——用户看到的是"聊天记录发不过去"。
 *
 * 2026-11-02 下午补：本机 QQ **没有** `parseMessageV2`（NapCat 走的是它，查过 introspect），
 * 但有 `getMultiMsg`。内核方法全是 0 形参（走回调），签名只能试，所以这里按
 * "常见形态"依次试，并把每次的形状打进日志 —— 下一次一眼能看出哪条对。
 * 支持**嵌套聊天记录**（转发里套转发）：展开出的段里若还是 multiForward，就再取一层（最多 2 层）。
 */
/**
 * 把一条记录里的图片**真正落到本地**（2026-11-03，抄 NapCat `downloadMedia` 的参数形状）。
 *
 * 为什么必须做这一步：`registerImageFile` 只是"告诉代理文件在哪"，**并不下载**。
 * 转发记录里的图 NTQQ 从没下载过，于是：
 *   · 登记 → 路径算得出来但 `fs.existsSync` 为 false；
 *   · 代理查不到 → 干等 10 秒 → 404（真机：10 张记录卡 51 秒、只成功 1 张）；
 *   · 另寻 CDN（origin_url）→ 这台机 DNS 直接 `ENOTFOUND gchat.qpic.cn`。
 *
 * `events.js` 里有个 `_triggerImageDownloads`，但两点不够用：
 *   ① 只对**新收到的**消息调用，历史/转发记录走不到；
 *   ② 它只"发起"下载、**不等完成**，而且要求 `md5HexStr`（转发记录常常只有 fileName）。
 * 这里补上"等文件真出现"（轮询，最多 `waitMs`），任意一项失败都留日志。
 */
/**
 * 按 md5 在 QQ 的图片缓存目录里找文件（2026-11-03）。
 *
 * 只在**回调没来**时用，而且必须**有界**：只看 Documents / OneDrive 下的 Documents 两个根、
 * 每个根最多 4 个账号目录、每个账号最近 3 个月份。不做全盘搜索 —— 那会把一次收图
 * 变成几十秒的磁盘扫描。
 *
 * 为什么这条路成立：getRichMediaFilePathForGuild 给的是 "Ori/<md5>.<ext>"，
 * 即相对 nt_data/Pic/<年-月>/ 的路径，说明内核就是按这个目录结构落盘的。
 */
function findLocalPic(md5, ext) {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  if (home === "") return "";
  const roots = [path.join(home, "Documents"), path.join(home, "OneDrive", "Documents")];
  for (const root of roots) {
    const tf = path.join(root, "Tencent Files");
    let uins = [];
    try { uins = fs.readdirSync(tf) } catch (e) { continue }
    for (const uin of uins.slice(0, 4)) {
      const picRoot = path.join(tf, uin, "nt_qq", "nt_data", "Pic");
      let months = [];
      try { months = fs.readdirSync(picRoot) } catch (e) { continue }
      for (const month of months.slice(-3)) {
        const file = path.join(picRoot, month, "Ori", md5 + "." + ext);
        try { if (fs.existsSync(file)) return file } catch (e) { /* 继续 */ }
      }
    }
  }
  return "";
}

async function ensureImagesLocal(rec, bridge, waitMs = 15000) {
  const svc = bridge && bridge.session && typeof bridge.session.getMsgService === "function"
    ? bridge.session.getMsgService()
    : null;
  if (!svc || typeof svc.downloadRichMedia !== "function") return;
  const jobs = [];
  for (const el of (rec && rec.elements) || []) {
    const pe = el && el.picElement;
    if (!pe) continue;
    const md5 = String(
      pe.md5HexStr
      || (/^([0-9a-f]{32})(?=[.\-_]|$)/i.exec(String(pe.fileName || "")) || [])[1]
      || "",
    ).toLowerCase();
    if (md5 === "") { console.log("[img-dl] 跳过：无 md5"); continue }
    const ext = (String(pe.fileName || "").match(/\.(\w{2,5})(?:[?#]|$)/) || [])[1] || "jpg";
    const cacheKey = md5 + "." + ext.toLowerCase();
    const msgId = String(rec.msgId || "");
    const elementId = String(el.elementId || "");

    // ① 先算一遍"期望路径"：**只用来兜底**。本机这个内核版本返回的是
    //    相对路径（Ori\\xxx.png），不能拿来 existsSync —— 这是上一版超时的直接原因。
    const pathInfo = {
      md5HexStr: md5, fileName: pe.fileName || "",
      elementType: 2, elementSubType: 0,
      thumbSize: 0, needCreate: true, downloadType: 1, file_uuid: "",
    };
    let expected = "";
    for (const api of ["getRichMediaFilePathForGuild", "getRichMediaFilePath", "getImagePath"]) {
      if (typeof svc[api] !== "function") continue;
      try {
        const got = svc[api](pathInfo);
        if (typeof got === "string" && got !== "") { expected = got; break }
      } catch (e) { /* 试下一个 */ }
    }

    jobs.push((async () => {
      /**
       * ② 先注册等待，再发起（顺序不能反：内核可能瞬间回调，反了就永远等不到）。
       *    NapCat 的 downloadMedia 就是这么用的：callNormalEventV2 先挂监听再调用。
       */
      const waiter = (bridge && typeof bridge.waitRichMedia === "function")
        ? bridge.waitRichMedia(msgId, elementId, waitMs)
        : null;
      try {
        svc.downloadRichMedia({
          fileModelId: "0",
          downSourceType: 0,
          downloadSourceType: 0,
          triggerType: 1,
          msgId,
          // 会话类型：记录里给的优先；没有就按 peerUid 形态判 —— 私聊是 u_xxx，群聊是纯数字群号
          chatType: Number(rec.chatType) || (/^u_/.test(String(rec.peerUid || "")) ? 1 : 2),
          peerUid: String(rec.peerUid || ""),
          elementId,
          thumbSize: 0,
          downloadType: 1,
          // ★ 传空（照抄 NapCat）：让内核自己决定落盘位置，我们从回调拿绝对路径。
          //   传我们自己算的相对路径会让内核存到"相对当前工作目录"的地方，找不到也没法登记。
          filePath: "",
        });
      } catch (e) {
        console.log("[img-dl] 发起下载失败：" + (e && e.message ? e.message : e));
      }

      // ③ 等回调（权威路径）
      let realPath = "";
      let gotCallback = false;
      if (waiter) {
        const done = await waiter;
        if (done) {
          gotCallback = true;
          realPath = String(done.filePath || "");
        }
      }
      if (realPath !== "" && fs.existsSync(realPath)) { registerImageFile(cacheKey, realPath); return }

      // ④ 兜底一：回调没来或路径不可用时，用期望路径再看一眼（绝对路径时才有意义）
      if (expected !== "" && fs.existsSync(expected)) { registerImageFile(cacheKey, expected); return }

      // ⑤ 兜底二：按 md5 去 QQ 的图片缓存目录里找（有界，最多 2 根 × 4 账号 × 3 个月）
      const found = findLocalPic(md5, ext.toLowerCase());
      if (found !== "") {
        registerImageFile(cacheKey, found);
        console.log("[img-dl] 回调没给路径，但本地找到了 md5=" + md5.slice(0, 8));
        return;
      }

      console.log("[img-dl] 没拿到本地文件 md5=" + md5.slice(0, 8)
        + " 回调=" + (gotCallback ? "来了" : "没来")
        + " 回调路径=" + (realPath === "" ? "(空)" : String(realPath).slice(-40))
        + " 期望=" + (expected === "" ? "(空)" : String(expected).slice(-40)));
    })());
  }
  if (jobs.length > 0) await Promise.all(jobs);
}

// ---- rkey（QQ 图片 CDN 的时效签名）----
// 抄自 NapCat 的 rkeyManager 兜底机制。rkey 不在内核里（内核侧要走 packet 层），
// NapCat 的兜底是从第三方服务拉 {group_rkey, private_rkey, expired_time}，
// 返回值本身就带 "&rkey=" 前缀，**直接拼在 download URL 末尾**即可。
const RKEY_SERVERS = [
  "http://ss.xingzhige.com/music_card/rkey",
  "https://secret-service.bietiaop.com/rkeys",
];
const _rkeyCache = { private_rkey: "", group_rkey: "", expired_time: 0 };

/** kind: "private" | "group"。拿不到返回 ""（调用方按无 rkey 处理，不许因此失败）。 */
async function getRkeyFor(kind) {
  const now = Date.now() / 1000;
  if (_rkeyCache.expired_time > now + 60) {
    const v = kind === "group" ? _rkeyCache.group_rkey : _rkeyCache.private_rkey;
    return v || "";
  }
  for (const server of RKEY_SERVERS) {
    try {
      const res = await fetch(server, { signal: AbortSignal.timeout(8000) });
      let json = await res.json();
      if (json && typeof json === "object" && "retcode" in json) json = json.data;
      const data = json && typeof json === "object" ? (json.data ?? json) : null;
      const grk = String(data?.group_rkey ?? "");
      const prk = String(data?.private_rkey ?? "");
      const exp = Number(data?.expired_time ?? 0);
      if (grk.length <= 6 || prk.length <= 6 || exp <= 0) throw new Error("格式无效");
      _rkeyCache.group_rkey = grk;
      _rkeyCache.private_rkey = prk;
      _rkeyCache.expired_time = exp;
      const v = kind === "group" ? grk : prk;
      return v || "";
    } catch (e) {
      console.log("[rkey] 服务失败 " + server.slice(0, 40) + "：" + (e && e.message ? e.message : e));
    }
  }
  return "";
}

/** 给图片段的 origin_url 追加 rkey（幂等：已有 &rkey= 的不重复加）。 */
async function attachRkeyToImages(segments, peerUid) {
  const isPrivate = /^u_/.test(String(peerUid || ""));
  const kind = isPrivate ? "private" : "group";
  const rkey = await getRkeyFor(kind);
  if (rkey === "") return;
  for (const seg of segments || []) {
    if (!seg || seg.type !== "image" || !seg.data) continue;
    const origin = String(seg.data.origin_url ?? "");
    if (origin !== "" && !origin.includes("&rkey=")) seg.data.origin_url = origin + rkey;
  }
}

async function expandForwardNodes(records, bridge, eventTranslator, depth, peer = null, parentMsgId = "") {
  const nodes = [];
  // ★ 不要在这里等下载（2026-11-03 撤销）：
  //   ① downloadRichMedia 要**真消息**的 msgId，而转发内层是载荷编号（查不到）⇒ 内核下不了；
  //   ② 等待 15s > 桥的 action 超时 10s ⇒ get_forward_msg timed out ⇒ 桥判失败 ⇒ "被丢弃"。
  //   正路：图片段带 origin_url（原始 CDN），桥 origin 优先直接下载 —— 网络正常时秒回。
  //   registerImagesOf 保留：本地**已有缓存**的图（用户点开过）登记后代理立刻可用。
  for (const rec of records) {
    // 兜底：即使下载没成，也把"算得出的路径"登记上（本地已有缓存的图能立刻命中）
    registerImagesOf(rec, bridge);
    const segments = ntToOneBot(rec.elements || [], rec);
    // 图片的 CDN 链接必须带 rkey（时效签名），否则直接 fetch = HTTP 400（2026-11-03 实测）。
    // 失败返回 "" ⇒ 不追加，行为退回原样。
    try { await attachRkeyToImages(segments, peer ? peer.peerUid : rec.peerUid) } catch (e) { console.log("[rkey] 追加异常：" + (e && e.message ? e.message : e)) }
    const content = [];
    for (const seg of segments) {
      if (seg && seg.type === "forward" && depth < 2) {
        const resId = String((seg.data && seg.data.id) || "");
        const innerMsgId = String((seg.data && (seg.data.msg_id || seg.data.msgId)) || "");
        if (resId || innerMsgId) {
          /**
           * ★ 嵌套的关键（实测 2026-11-02 深夜）：`getMultiMsg(peer, parentMsgId, msgId)` 的
           * 第二个实参是**父卡片的 msgId**，不是内层自己的。
           *   顶层：parent == 自己（`(peer,X,X)` → count=N）
           *   嵌套：`(peer, 外层X, 内层Y)` → count=10；而 `(peer,Y,Y)` → `result=4 Data Not Existed`
           * 为什么会这样：内层那个 id **不是真消息**（`getMsgsByMsgId` 查不到，count=0），
           * 它只是外层 multi-msg 载荷里的一个子元素编号，必须挂着父 id 才能解析。
           */
          const inner = await fetchForwardList(resId || innerMsgId, bridge, eventTranslator, depth + 1,
            peer && innerMsgId ? { msgId: innerMsgId, parentMsgId: parentMsgId || "", peer } : null);
          if (inner.length > 0) {
            content.push({
              type: "node",
              data: {
                user_id: Number(rec.senderUin) || 0,
                nickname: rec.sendNickName || rec.sendMemberName || "",
                content: [{
                  type: "forward",
                  data: { id: resId, content: inner },
                }],
              },
            });
            continue;
          }
        }
      }
      content.push(seg);
    }
    nodes.push({
      type: "node",
      data: {
        user_id: Number(rec.senderUin) || 0,
        nickname: rec.sendNickName || rec.sendMemberName || "",
        time: Number(rec.msgTime) || 0,
        content,
      },
    });
  }
  return nodes;
}

async function fetchForwardList(resId, bridge, eventTranslator, depth = 1, context = null) {
  const svc = bridge && bridge.session && typeof bridge.session.getMsgService === "function"
    ? bridge.session.getMsgService()
    : null;
  if (!svc || typeof svc.getMultiMsg !== "function") {
    console.log("[forward] 没有 getMultiMsg");
    return [];
  }
  /**
   * ★ 正确的调法（2026-11-02 深夜实测确定，别再猜）：
   *   `getMultiMsg(peer, parentMsgId, msgId)` —— 三个实参，第 2、3 个**都要真 msgId**。
   *   顶层合并转发（转发里不套转发）传**同一个 msgId 两次**：实测 result=0、msgList 非空。
   *
   * 之前一直失败的原因（两条，缺一不可）：
   *   ① 第 3 个实参传的是 `true`/数字（当成 count）⇒ result=5、msgList 空，**不报错**；
   *   ② peer.peerUid 传的是 QQ 号（uin）⇒ result=4 `Data Not Existed!`。
   *      私聊必须传 uid（`u_xxx`），群聊直接传群号。
   *   拿 uin 当 peerUid 时连 `getMsgsByMsgId` 都查不到记录，会让人误以为"消息过期了"。
   */
  if (context && context.msgId && context.peer && context.peer.peerUid) {
    try {
      const parentId = context.parentMsgId || context.msgId;
      const res = await svc.getMultiMsg(context.peer, parentId, context.msgId);
      const list = (res && (res.msgList || res.messages || res.list)) || null;
      const count = Array.isArray(list) ? list.length : -1;
      console.log(`[forward] getMultiMsg(peer,parent=${parentId},msg=${context.msgId}) → result=${res && res.result} count=${count}`);
      if (Array.isArray(list) && list.length > 0) {
        return await expandForwardNodes(list, bridge, eventTranslator || null, depth, context && context.peer ? context.peer : null, context && context.msgId ? context.msgId : "");
      }
    } catch (e) {
      console.log(`[forward] 三段式 error: ${e && e.message ? e.message : e}`);
    }
  }
  // 兜底：只知道 resId 时继续试老形态（拿不到内容时至少把形状打进日志）
  const attempts = [
    { name: "getMultiMsg(resId)", args: [resId] },
    { name: "getMultiMsg(peer,resId)", args: [{ chatType: 1, peerUid: "", guildId: "" }, resId] },
    { name: "getMultiMsg(peer,resId,true)", args: [{ chatType: 1, peerUid: "", guildId: "" }, resId, true] },
  ];
  for (const attempt of attempts) {
    try {
      const res = await svc.getMultiMsg(...attempt.args);
      const list = (res && (res.msgList || res.messages || res.list)) || (Array.isArray(res) ? res : null);
      const count = Array.isArray(list) ? list.length : -1;
      console.log(`[forward] ${attempt.name} → keys=${res && typeof res === "object" ? Object.keys(res).join(",") : typeof res} count=${count}`);
      if (Array.isArray(list) && list.length > 0) return await expandForwardNodes(list, bridge, eventTranslator || null, depth, context && context.peer ? context.peer : null, context && context.msgId ? context.msgId : "");
    } catch (e) {
      console.log(`[forward] ${attempt.name} error: ${e && e.message ? e.message : e}`);
    }
  }
  return [];
}

handlers.get_forward_msg = async (params, bridge, eventTranslator) => {
  const id = String((params && (params.message_id || params.id)) || "").trim();
  if (id === "") return { messages: [], _error: "缺少 message_id" };
  /**
   * 桥会额外带三个字段（2026-11-02 深夜加）：`msg_id` / `user_id` / `group_id`。
   * 有了它们就能走上面那条正确签名；只给 resId 时只能走兜底（基本拿不到内容）。
   * 这三个是 OneBot v11 之外的扩展字段，别的后端忽略即可。
   */
  const msgId = String((params && params.msg_id) || "").trim();
  const groupId = String((params && params.group_id) || "").trim();
  const userId = String((params && params.user_id) || "").trim();
  let peer = null;
  if (groupId !== "") {
    peer = { chatType: 2, peerUid: groupId, guildId: "" };
  } else if (userId !== "") {
    let peerUid = userId;
    try {
      const uid = eventTranslator && typeof eventTranslator.getUidByUin === "function"
        ? eventTranslator.getUidByUin(userId)
        : null;
      if (uid) peerUid = String(uid);
    } catch (e) { /* 用 uin 兜底，虽然大概率 Data Not Existed */ }
    peer = { chatType: 1, peerUid, guildId: "" };
  }
  const context = msgId !== "" && peer ? { msgId, peer } : null;
  const nodes = await fetchForwardList(id, bridge, eventTranslator, 1, context);
  if (nodes.length === 0) {
    // 宁可如实报错，也不要空数组 —— 空数组在上层读作"这条聊天记录本来就是空的"
    return {
      messages: [],
      _error: `没取到内容（msg_id=${msgId || "(没给)"} peer=${peer ? peer.peerUid : "(没给)"} resId=${id.slice(0, 12)}…）`,
    };
  }
  return { messages: nodes };
};


// ---- Group admin operations ----

handlers.set_group_ban = async (params, bridge) => {
  if (!bridge.session) return null;
  try {
    bridge.session.getGroupService().setMemberShutUp(
      String(params.group_id), [{ uid: String(params.user_id), timeStamp: params.duration || 0 }]
    );
  } catch {}
  return null;
};

handlers.set_group_whole_ban = async (params, bridge) => {
  if (!bridge.session) return null;
  try {
    bridge.session.getGroupService().setGroupShutUp(String(params.group_id), params.enable !== false);
  } catch {}
  return null;
};

handlers.set_group_kick = async (params, bridge) => {
  if (!bridge.session) return null;
  try {
    bridge.session.getGroupService().kickMember(
      String(params.group_id), [String(params.user_id)], params.reject_add_request || false
    );
  } catch {}
  return null;
};


handlers.set_group_admin = async (params, bridge) => {
  if (!bridge.session) return null;
  try {
    bridge.session.getGroupService().setMemberRole(
      String(params.group_id), String(params.user_id), params.enable ? 3 : 2
    );
  } catch {}
  return null;
};

handlers.set_group_card = async (params, bridge) => {
  if (!bridge.session) return null;
  try {
    bridge.session.getGroupService().modifyMemberCardName(
      String(params.group_id), String(params.user_id), params.card || ""
    );
  } catch {}
  return null;
};

handlers.set_group_name = async (params, bridge) => {
  if (!bridge.session) return null;
  try {
    bridge.session.getGroupService().modifyGroupName(String(params.group_id), params.group_name || "");
  } catch {}
  return null;
};

handlers.set_group_leave = async (params, bridge) => {
  if (!bridge.session) return null;
  try {
    bridge.session.getGroupService().quitGroup(String(params.group_id));
  } catch {}
  return null;
};

// ---- Stubs for APIs that Yunzai calls but we can gracefully fail ----

// Debug: dump service methods
handlers.__debug = async (params, bridge) => {
  const s = bridge.session;
  if (!s) return { error: "no session" };
  const result = {};
  try {
    const msf = s.getMSFService();
    result.msfStatus = msf.getMsfStatus();
    result.serverTime = msf.getServerTime();
  } catch (e) { result.msfError = e.message; }
  try { result.sessionId = s.getSessionId(); } catch {}
  try { result.accountPath = s.getAccountPath(); } catch {}
  return result;
};

/**
 * Full introspection of wrapper.node API surface.
 * Enumerates all wrapper exports, session services, and their methods with param counts.
 */
handlers.__introspect = async (params, bridge) => {
  const result = { wrapper: {}, session: {}, listeners: {} };

  // 1. All wrapper.node top-level exports
  try {
    const wrapperKeys = Object.keys(bridge.wrapper).sort();
    for (const key of wrapperKeys) {
      const val = bridge.wrapper[key];
      const type = typeof val;
      if (type === "function") {
        // It's a class or function — enumerate static methods and prototype
        const entry = { type: "class", static: [], prototype: [] };
        // Static methods
        for (const m of Object.getOwnPropertyNames(val).filter(m => m !== "constructor" && m !== "prototype" && m !== "length" && m !== "name")) {
          const fn = val[m];
          entry.static.push({ name: m, type: typeof fn, params: typeof fn === "function" ? fn.length : undefined });
        }
        // Prototype methods (for classes instantiated via .get() or .create())
        if (val.prototype) {
          for (const m of Object.getOwnPropertyNames(val.prototype).filter(m => m !== "constructor")) {
            const fn = val.prototype[m];
            entry.prototype.push({ name: m, type: typeof fn, params: typeof fn === "function" ? fn.length : undefined });
          }
        }
        // Try .get() to get singleton instance and enumerate its methods
        try {
          const inst = val.get();
          if (inst && typeof inst === "object") {
            entry.instance = [];
            for (const m of Object.getOwnPropertyNames(Object.getPrototypeOf(inst)).filter(m => m !== "constructor")) {
              const fn = inst[m];
              entry.instance.push({ name: m, type: typeof fn, params: typeof fn === "function" ? fn.length : undefined });
            }
          }
        } catch {}
        result.wrapper[key] = entry;
      } else {
        result.wrapper[key] = { type, value: String(val).substring(0, 100) };
      }
    }
  } catch (e) { result.wrapperError = e.message; }

  // 2. Session services — discover all get*Service methods and enumerate their methods
  const s = bridge.session;
  if (s) {
    try {
      const sessionProto = Object.getOwnPropertyNames(Object.getPrototypeOf(s))
        .filter(m => m !== "constructor").sort();
      result.session._methods = sessionProto.map(m => ({
        name: m, params: typeof s[m] === "function" ? s[m].length : undefined
      }));

      // Enumerate each get*Service method
      const serviceGetters = sessionProto.filter(m => /^get\w+Service/.test(m));
      for (const getter of serviceGetters) {
        try {
          const svc = s[getter]();
          if (!svc) continue;
          const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(svc))
            .filter(m => m !== "constructor").sort();
          result.session[getter] = methods.map(m => ({
            name: m, params: typeof svc[m] === "function" ? svc[m].length : undefined
          }));
        } catch (e) {
          result.session[getter] = { error: e.message };
        }
      }
    } catch (e) { result.sessionError = e.message; }
  }

  // 3. List all known listener class names from wrapper exports
  try {
    const listenerKeys = Object.keys(bridge.wrapper).filter(k => /Listener/i.test(k));
    for (const key of listenerKeys) {
      const cls = bridge.wrapper[key];
      if (cls?.prototype) {
        result.listeners[key] = Object.getOwnPropertyNames(cls.prototype)
          .filter(m => m !== "constructor")
          .map(m => ({ name: m, params: typeof cls.prototype[m] === "function" ? cls.prototype[m].length : undefined }));
      }
    }
  } catch (e) { result.listenersError = e.message; }

  return result;
};

handlers._set_model_show = async () => null;
handlers.get_guild_service_profile = async () => { throw new Error("not supported"); };
handlers.get_online_clients = async () => ({ clients: [] });
handlers.get_cookies = async () => ({ cookies: "" });
handlers.get_csrf_token = async () => ({ token: 0 });
handlers.get_guild_list = async () => [];
/**
 * 改自己的资料 —— 原来是 `async () => null`（**静默什么都不做**：调用方以为改成功了）。
 *
 * 2026-11-02 傍晚从 NapCat 反哺：它用的是内核
 * `ProfileService.modifySelfProfile({nick, longNick, sex, birthday, location})`。
 * 本机 `NodeIKernelProfileService` 确实有 `modifySelfProfile` / `setNickName` / `setLongNick`
 * （introspect 查过），所以这条在能力范围内。
 *
 * ⚠️ 只传调用方给了的字段：NapCat 会把 sex/birthday 从当前资料补齐，我们**读不到**当前资料
 * （那是 getProfileService 的另一组方法，没验证过），所以宁可不传 ——
 * 传错的值比不传更糟（比如把性别写成 undefined）。
 */
handlers.set_qq_profile = async (params, bridge) => {
  const svc = bridge && bridge.session && typeof bridge.session.getProfileService === "function"
    ? bridge.session.getProfileService()
    : null;
  if (!svc) return null;
  const nick = String((params && params.nickname) || "").trim();
  const longNick = String((params && params.personal_note) || "").trim();
  if (nick === "" && longNick === "") return null;
  const payload = {};
  if (nick !== "") payload.nick = nick;
  if (longNick !== "") payload.longNick = longNick;
  try {
    const res = await svc.modifySelfProfile(payload);
    console.log(`[profile] modifySelfProfile ${JSON.stringify(payload)} → ${JSON.stringify(res)}`);
    return res || {};
  } catch (e) {
    console.log(`[profile] modifySelfProfile 失败: ${e && e.message ? e.message : e}`);
    return null;
  }
};
handlers.set_qq_avatar = async () => null;
handlers.send_like = async (params, bridge, eventTranslator) => {
  if (!bridge.session) return null;
  const userId = String(params.user_id || "");
  const times = Math.min(params.times || 1, 20);
  let uid = eventTranslator.getUidByUin(userId);
  if (!uid) {
    try {
      const r = await withTimeout(
        bridge.session.getProfileService().getUidByUin("FriendsServiceImpl", [userId]),
        5000
      );
      uid = r?.uidInfo?.get(userId);
      if (uid) eventTranslator.recordUinUid(userId, uid);
    } catch {}
  }
  if (!uid) return null;
  try {
    const profileLikeService = bridge.session.getProfileLikeService();
    const result = await withTimeout(
      profileLikeService.setBuddyProfileLike({
        friendUid: uid,
        sourceId: 71,
        doLikeCount: times,
        doLikeTollCount: 0,
      }),
      5000
    );
    if (result?.result !== 0) {
      console.warn("[onebot-actions] send_like failed:", result?.errMsg || "unknown error");
    }
  } catch (e) {
    console.warn("[onebot-actions] send_like error:", e.message);
  }
  return null;
};
handlers.set_group_special_title = async () => null;
handlers.send_group_sign = async () => null;
handlers.download_file = async () => ({ file: "" });
handlers.get_group_honor_info = async () => ({});
handlers.get_essence_msg_list = async () => ({ msg_list: [] });
handlers.set_essence_msg = async () => null;
handlers.delete_essence_msg = async () => null;
/**
 * Helper: call getGroupFileList and wait for the onGroupFileInfoUpdate callback.
 * Returns { files, folders } in OneBot v11 format.
 */
async function fetchGroupFiles(bridge, eventTranslator, groupCode, folderId) {
  const richMediaService = bridge.session.getRichMediaService();
  const param = {
    sortType: 1,
    fileCount: 100,
    startIndex: 0,
    sortOrder: 2,
    showOnlinedocFolder: 0,
  };
  // Only include folderId when listing a specific subfolder;
  // omitting it returns root files (empty string causes NTQQ to return nothing)
  if (folderId) param.folderId = folderId;
  const reqId = richMediaService.getGroupFileList(groupCode, param);
  // Register the wait immediately — the event fires asynchronously via the native callback
  const data = await eventTranslator.waitForGroupFileInfo(Number(reqId), 10000);
  if (data.retCode !== 0) {
    throw new Error(`getGroupFileList failed: retCode=${data.retCode}`);
  }
  const files = [];
  const folders = [];
  for (const item of data.item || []) {
    if (item.fileInfo) {
      const f = item.fileInfo;
      files.push({
        group_id: Number(groupCode) || 0,
        file_id: f.fileId || "",
        file_name: f.fileName || "",
        busid: f.busId || 0,
        file_size: Number(f.fileSize) || 0,
        upload_time: Number(f.uploadTime) || 0,
        dead_time: Number(f.deadTime) || 0,
        modify_time: Number(f.modifyTime) || 0,
        download_times: Number(f.downloadTimes) || 0,
        uploader: Number(f.uploaderUin) || 0,
        uploader_name: f.uploaderName || "",
      });
    }
    if (item.folderInfo) {
      const d = item.folderInfo;
      folders.push({
        group_id: Number(groupCode) || 0,
        folder_id: d.folderId || "",
        folder_name: d.folderName || "",
        create_time: Number(d.createTime) || 0,
        creator: Number(d.creatorUin) || 0,
        creator_name: d.creatorName || "",
        total_file_count: Number(d.totalFileCount) || 0,
      });
    }
  }
  return { files, folders };
}

handlers.get_group_file_system_info = async (params, bridge, eventTranslator) => {
  if (!bridge.session) return {};
  const groupCode = String(params.group_id || "");
  if (!groupCode) return {};
  try {
    const richMediaService = bridge.session.getRichMediaService();
    const [spaceResult, { files }] = await Promise.all([
      withTimeout(richMediaService.getGroupSpace(groupCode), 10000),
      fetchGroupFiles(bridge, eventTranslator, groupCode),
    ]);
    const space = spaceResult?.groupSpaceResult || {};
    return {
      file_count: files.length,
      limit_count: 10000,
      used_space: Number(space.usedSpace) || 0,
      total_space: Number(space.totalSpace) || 0,
    };
  } catch (e) {
    console.warn("[onebot-actions] get_group_file_system_info error:", e.message);
    return {};
  }
};

handlers.get_group_root_files = async (params, bridge, eventTranslator) => {
  if (!bridge.session) return { files: [], folders: [] };
  const groupCode = String(params.group_id || "");
  if (!groupCode) return { files: [], folders: [] };
  try {
    return await fetchGroupFiles(bridge, eventTranslator, groupCode);
  } catch (e) {
    console.warn("[onebot-actions] get_group_root_files error:", e.message);
    return { files: [], folders: [] };
  }
};

handlers.get_group_files_by_folder = async (params, bridge, eventTranslator) => {
  if (!bridge.session) return { files: [], folders: [] };
  const groupCode = String(params.group_id || "");
  const folderId = String(params.folder_id || "");
  if (!groupCode) return { files: [], folders: [] };
  try {
    return await fetchGroupFiles(bridge, eventTranslator, groupCode, folderId);
  } catch (e) {
    console.warn("[onebot-actions] get_group_files_by_folder error:", e.message);
    return { files: [], folders: [] };
  }
};

// get_group_file_url: NTQQ wrapper.node does not expose a direct file URL API.
// Returns empty — callers should use upload_group_file / download via the QQ client.
handlers.get_group_file_url = async () => ({ url: "" });
handlers.upload_group_file = async (params, bridge, eventTranslator) => {
  const groupId = String(params.group_id || "");
  const file = params.file || "";
  const name = params.name || path.basename(file) || "file";
  if (!file) throw new Error("Missing 'file' parameter");
  // Pre-validate file resolution to give specific error messages
  const resolved = await resolveMediaFile(file);
  if (!resolved) {
    if (file.startsWith("http://") || file.startsWith("https://")) {
      throw new Error(`Failed to download file from URL: ${file.substring(0, 200)}`);
    } else if (file.startsWith("file://")) {
      throw new Error(`File not found or unreadable: ${file.slice(7)}`);
    } else if (file.startsWith("base64://")) {
      throw new Error("Failed to decode base64 file data");
    } else {
      throw new Error(`File not found or unreadable: ${file}`);
    }
  }
  const peer = { chatType: 2, peerUid: groupId, guildId: "" };
  // Wrap with timeout — sendMsg may hang for large file uploads while BDH
  // processes the upload asynchronously.  Return message_id: 0 on timeout
  // so the caller always gets a deterministic response.
  try {
    return await withTimeout(
      sendMessage(peer, [{ type: "file", data: { file, name } }], bridge, eventTranslator),
      30000
    );
  } catch (e) {
    if (e.message === "timeout") {
      console.warn("[onebot-actions] upload_group_file: sendMsg timed out, file may still be uploading via BDH");
      return { message_id: 0 };
    }
    throw e;
  }
};

handlers.upload_private_file = async (params, bridge, eventTranslator) => {
  const userId = String(params.user_id || "");
  let peerUid = eventTranslator.getUidByUin(userId);
  if (!peerUid) {
    try {
      const r = await bridge.session.getProfileService().getUidByUin("FriendsServiceImpl", [userId]);
      peerUid = r?.uidInfo?.get(userId) || userId;
    } catch {}
  }
  const file = params.file || "";
  const name = params.name || path.basename(file) || "file";
  if (!file) throw new Error("Missing 'file' parameter");
  const resolved = await resolveMediaFile(file);
  if (!resolved) {
    if (file.startsWith("http://") || file.startsWith("https://")) {
      throw new Error(`Failed to download file from URL: ${file.substring(0, 200)}`);
    } else if (file.startsWith("file://")) {
      throw new Error(`File not found or unreadable: ${file.slice(7)}`);
    } else if (file.startsWith("base64://")) {
      throw new Error("Failed to decode base64 file data");
    } else {
      throw new Error(`File not found or unreadable: ${file}`);
    }
  }
  const peer = { chatType: 1, peerUid: peerUid || userId, guildId: "" };
  try {
    return await withTimeout(
      sendMessage(peer, [{ type: "file", data: { file, name } }], bridge, eventTranslator),
      30000
    );
  } catch (e) {
    if (e.message === "timeout") {
      console.warn("[onebot-actions] upload_private_file: sendMsg timed out, file may still be uploading via BDH");
      return { message_id: 0 };
    }
    throw e;
  }
};
handlers.move_group_file = async (params, bridge) => {
  if (!bridge.session) throw new Error("Session not ready");
  const groupCode = String(params.group_id || "");
  const fileId = String(params.file_id || "");
  const folderId = String(params.folder_id || params.target_folder_id || "");
  const busId = params.busid || params.bus_id || 102;
  if (!groupCode || !fileId) throw new Error("Missing group_id or file_id");
  const richMediaService = bridge.session.getRichMediaService();
  // NTQQ wrapper.node may expose moveGroupFile in newer versions
  if (typeof richMediaService.moveGroupFile === "function") {
    try {
      await withTimeout(
        richMediaService.moveGroupFile(groupCode, [busId], [fileId], folderId),
        10000
      );
      return null;
    } catch (e) {
      throw new Error(`moveGroupFile failed: ${e.message}`);
    }
  }
  throw new Error("move_group_file is not supported: NTQQ wrapper.node does not expose moveGroupFile in this QQ version");
};

handlers.delete_group_file = async (params, bridge) => {
  if (!bridge.session) return null;
  const groupCode = String(params.group_id || "");
  const fileId = String(params.file_id || "");
  const busId = params.busid || params.bus_id || 102;
  if (!groupCode || !fileId) return null;
  try {
    const richMediaService = bridge.session.getRichMediaService();
    await withTimeout(
      richMediaService.deleteGroupFile(groupCode, [busId], [fileId]),
      10000
    );
  } catch (e) {
    console.warn("[onebot-actions] delete_group_file error:", e.message);
  }
  return null;
};

handlers.create_group_file_folder = async (params, bridge) => {
  if (!bridge.session) return null;
  const groupCode = String(params.group_id || "");
  const folderName = String(params.name || params.folder_name || "");
  if (!groupCode || !folderName) return null;
  try {
    const richMediaService = bridge.session.getRichMediaService();
    await withTimeout(
      richMediaService.createGroupFolder(groupCode, folderName),
      10000
    );
  } catch (e) {
    console.warn("[onebot-actions] create_group_file_folder error:", e.message);
  }
  return null;
};

handlers.delete_group_folder = async (params, bridge) => {
  if (!bridge.session) return null;
  const groupCode = String(params.group_id || "");
  const folderId = String(params.folder_id || "");
  if (!groupCode || !folderId) return null;
  try {
    const richMediaService = bridge.session.getRichMediaService();
    await withTimeout(
      richMediaService.deleteGroupFolder(groupCode, folderId),
      10000
    );
  } catch (e) {
    console.warn("[onebot-actions] delete_group_folder error:", e.message);
  }
  return null;
};
handlers.set_friend_add_request = async (params, bridge) => {
  if (!bridge.session) return null;
  const flag = String(params.flag || "");
  const approve = params.approve !== false;
  try {
    const buddyService = bridge.session.getBuddyService();
    if (typeof buddyService.approveOrRejectFriendRequest === "function") {
      await buddyService.approveOrRejectFriendRequest(flag, approve);
    } else if (typeof buddyService.handleFriendRequest === "function") {
      await buddyService.handleFriendRequest(flag, approve);
    }
  } catch (e) {
    console.error("[onebot-actions] set_friend_add_request error:", e.message);
  }
  return null;
};

handlers.set_group_add_request = async (params, bridge) => {
  if (!bridge.session) return null;
  const flag = String(params.flag || "");
  const approve = params.approve !== false;
  const reason = params.reason || "";
  const [seq, groupCode, type] = flag.split("|");
  if (!seq || !groupCode) return null;
  try {
    const groupService = bridge.session.getGroupService();
    // Try common method names across NTQQ versions
    if (typeof groupService.operateGroupReqNotify === "function") {
      await groupService.operateGroupReqNotify(approve ? 1 : 2, { groupCode, seq, type: Number(type) || 1 }, reason);
    } else if (typeof groupService.operateGroupNotify === "function") {
      await groupService.operateGroupNotify(approve ? 1 : 2, { groupCode, seq, type: Number(type) || 1 }, reason);
    } else if (typeof groupService.handleGroupRequest === "function") {
      await groupService.handleGroupRequest(groupCode, seq, approve, reason);
    }
  } catch (e) {
    console.error("[onebot-actions] set_group_add_request error:", e.message);
  }
  return null;
};

handlers.delete_friend = async () => null;
/**
 * 历史消息 —— **原来是空壳**（`=> ({ messages: [] })`），等于对上层撒谎"这个群没历史"。
 *
 * 2026-11-02 中午从 NapCat 反哺：它的 `get_group_msg_history` 走的是
 *   `getMsgHistory(peer, msgId, count, reverseOrder)` / `getAioFirstViewLatestMsgs(peer, count)`。
 * 本机 QQ（3.2.31）**没有 `getMsgHistory`**（introspect 里查过，不存在），
 * 但有 `getAioFirstViewLatestMsgs` 和 `getMsgsBySeqAndCount`，所以：
 *   给了 message_seq 且不是 0 ⇒ 按 seq 取（与回复元素那条同源，参数抄 NapCat 的 5 参形式）
 *   没给 ⇒ 取最新 count 条
 * 两条都是只读查询。
 */
async function fetchHistory(peer, params, bridge, eventTranslator, extra = {}) {
  const svc = bridge && bridge.session && typeof bridge.session.getMsgService === "function"
    ? bridge.session.getMsgService()
    : null;
  if (!svc) return { messages: [], _error: "没有 getMsgService" };
  const count = Math.min(100, Math.max(1, Number(params && params.count) || 20));
  const rawSeq = params && params.message_seq;
  const hasSeq = rawSeq !== undefined && rawSeq !== null && String(rawSeq) !== "" && String(rawSeq) !== "0";
  let list = [];
  let via = "latest";
  try {
    if (hasSeq) {
      const res = await svc.getMsgsBySeqAndCount(peer, String(rawSeq), count, true, true);
      list = (res && res.msgList) || [];
      via = "seq";
    } else {
      const res = await svc.getAioFirstViewLatestMsgs(peer, count);
      list = (res && res.msgList) || [];
    }
  } catch (e) {
    console.log(`[history] ${via} error: ${e && e.message ? e.message : e}`);
    return { messages: [], _error: String((e && e.message) || e) };
  }
  console.log(`[history] ${via} peer=${peer.peerUid} count=${count} got=${list.length}`);
  const messages = list.map((rec) => {
    const segments = ntToOneBot(rec.elements, rec);
    // 历史消息里的图片同样要登记（代理只认登记过的 key）
    registerImagesOf(rec, bridge);
    const shortId = eventTranslator && typeof eventTranslator.createShortId === "function"
      ? eventTranslator.createShortId(rec.msgId)
      : Number(rec.msgId) || 0;
    return {
      message_id: shortId,
      real_id: String(rec.msgId || ""),
      time: Number(rec.msgTime) || 0,
      sender: {
        user_id: Number(rec.senderUin) || 0,
        nickname: rec.sendNickName || "",
        card: rec.sendMemberName || "",
      },
      message: segments,
      raw_message: segmentsToRawMessage(segments),
      post_type: "message",
      ...extra,
    };
  });
  return { messages };
}

handlers.get_friend_msg_history = async (params, bridge, eventTranslator) => {
  const uin = String((params && params.user_id) || "").trim();
  if (uin === "") return { messages: [] };
  let peerUid = uin;
  try {
    const uid = eventTranslator && typeof eventTranslator.getUidByUin === "function" ? eventTranslator.getUidByUin(uin) : null;
    if (uid) peerUid = String(uid);
  } catch (e) { /* 用 uin 兜底 */ }
  return fetchHistory({ chatType: 1, peerUid, guildId: "" }, params, bridge, eventTranslator,
    { message_type: "private", user_id: Number(uin) || 0 });
};

handlers.get_group_msg_history = async (params, bridge, eventTranslator) => {
  const groupId = String((params && params.group_id) || "").trim();
  if (groupId === "") return { messages: [] };
  return fetchHistory({ chatType: 2, peerUid: groupId, guildId: "" }, params, bridge, eventTranslator,
    { message_type: "group", group_id: Number(groupId) || 0 });
};

handlers.can_send_image = async () => ({ yes: true });
handlers.can_send_record = async () => ({ yes: true });

handlers.get_image = async (params, bridge) => {
  const file = params.file || "";
  if (!bridge.session) return { file: "" };
  try {
    const pathInfo = {
      md5HexStr: "", fileName: file, elementType: 2, elementSubType: 0,
      thumbSize: 0, needCreate: false, downloadType: 1, file_uuid: "",
    };
    const filePath = bridge.session.getMsgService().getRichMediaFilePathForGuild(pathInfo);
    if (filePath && fs.existsSync(filePath)) {
      return { file: filePath, file_size: fs.statSync(filePath).size, filename: file };
    }
  } catch {}
  return { file: "" };
};

handlers.get_record = async (params, bridge) => {
  const file = params.file || "";
  if (!bridge.session) return { file: "" };

  /**
   * ★ 2026-10-31：支持**绝对路径**，并且**返回 base64**。两个独立的坑叠在一起：
   *
   * ① 桥（跑在 dsh 宿主进程里）**读不到 workspace 之外的文件** —— 用户的 QQ 数据在
   *    `Documents\Tencent Files\…\nt_data\Ptt\…`，实测宿主里 `existsSync` 为 false，
   *    而本进程在 QQ.exe 里，`readFileSync` 正常。所以"把路径交给桥自己读"这条路走不通，
   *    必须由这里读、把内容回传。
   * ② 原来的实现用 `getRichMediaFilePathForGuild` 推路径 —— 那是**频道(guild)接口**，
   *    私聊一律返回空串，于是 `get_record` 永远拿不到东西（真机日志：`{"file":""}`）。
   *
   * 现在：参数是绝对路径就直接读盘，返回 `base64://…`（桥的 `#fetchVoiceAudio` 认这个前缀）。
   * 桥侧只会把**音频扩展名**的路径传进来（`lib/voice-path.js` 的闸门），
   * 所以这里不需要再做白名单。
   */
  if (/^([a-zA-Z]:[\\/]|\/)/.test(file) && fs.existsSync(file)) {
    try {
      const buf = fs.readFileSync(file);
      return {
        file: `base64://${buf.toString("base64")}`,
        file_size: buf.length,
        filename: path.basename(file),
      };
    } catch (e) {
      console.error("[onebot-actions] get_record read failed:", e.message);
    }
  }

  try {
    const pathInfo = {
      md5HexStr: "", fileName: file, elementType: 4, elementSubType: 0,
      thumbSize: 0, needCreate: false, downloadType: 1, file_uuid: "",
    };
    const filePath = bridge.session.getMsgService().getRichMediaFilePathForGuild(pathInfo);
    if (filePath && fs.existsSync(filePath)) {
      // 同样回 base64：宿主进程读不到这个路径，回路径等于没回
      try {
        const buf = fs.readFileSync(filePath);
        return { file: `base64://${buf.toString("base64")}`, file_size: buf.length, filename: file };
      } catch {
        return { file: filePath, file_size: fs.statSync(filePath).size, filename: file };
      }
    }
  } catch {}
  return { file: "" };
};

handlers.group_poke = async (params, bridge, eventTranslator) => {
  if (!bridge.session) return null;
  const groupId = String(params.group_id || "");
  const userId = String(params.user_id || "");
  let uid = eventTranslator.getUidByUin(userId);
  if (!uid) {
    try {
      const r = await bridge.session.getProfileService().getUidByUin("FriendsServiceImpl", [userId]);
      uid = r?.uidInfo?.get(userId);
    } catch {}
  }
  if (!uid) uid = userId;
  try {
    const groupService = bridge.session.getGroupService();
    if (typeof groupService.sendPoke === "function") {
      await groupService.sendPoke(groupId, uid);
    }
  } catch (e) {
    console.error("[onebot-actions] group_poke error:", e.message);
  }
  return null;
};
handlers.send_group_poke = handlers.group_poke;

handlers.friend_poke = async (params, bridge, eventTranslator) => {
  if (!bridge.session) return null;
  const userId = String(params.user_id || "");
  let uid = eventTranslator.getUidByUin(userId);
  if (!uid) uid = userId;
  try {
    const msgService = bridge.session.getMsgService();
    if (typeof msgService.sendPoke === "function") {
      await msgService.sendPoke(uid);
    }
  } catch (e) {
    console.error("[onebot-actions] friend_poke error:", e.message);
  }
  return null;
};

module.exports = { handlers };
