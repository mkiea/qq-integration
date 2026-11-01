/**
 * v0.6「轻量化设计」：DSH 设置里那块「QQ助手」面板的**纯逻辑**。
 *
 * 这个文件不碰网络、不碰磁盘，只做三件事，方便单测：
 *   1. `PANEL_GROUPS`：精选出来、适合在设置界面里开关的功能（不是把 224 个键全铺上去——
 *      那样面板本身就"重"了，也失去意义）；
 *   2. `panelSnapshot()`：把运行中的生效值整理成前端要渲染的形状；
 *   3. `upsertPatchValue()` / `readPatchValue()`：只动 profile 的 `cordis.patch.yml` 里
 *      **本插件那一个条目**的 config 块，逐行做 upsert，保留注释与其它条目的原样。
 */

/**
 * 一个开关在面板里的样子。
 * - `hint`：**这个开关到底做什么** + 需要什么 + 关掉会怎样（用户反馈"就写了串英文，都没写需要额外软件"，
 *   所以每行都必须是完整说明，空提示会被单测判红）；
 * - `needs`：依赖标记（空 = 开箱即用）。取值词表见 `PANEL_NEEDS`，界面渲染成一个小标签，
 *   让人一眼看出"这个开关要额外装东西/填密钥"。
 * `key` 必须与 lib/index.js 的 schema 一致（单测钉死）。
 */
const row = (key, label, hint = '', needs = '') => ({ key, label, hint, needs, type: 'boolean' })

/**
 * **时段列表**控件（v0.6.8）：`quietHours` 这种"一串 H:MM-H:MM"的键，原来只能改配置文件。
 *
 * 语义照抄引擎侧 `parseQuietRanges` / `isQuietTime`（lib/bridge.js）：
 *   - `H:MM-H:MM`（小时 1–2 位、允许全角冒号、起止之间可有空格）；
 *   - **支持跨夜**（`22:00-06:00` 表示 22:00 到次日 06:00）；
 *   - 起止相同视为无效（那条会被引擎忽略，所以这里直接拒）；
 *   - 上限 8 段（够用，且避免把一行塞爆）。
 */
const times = (key, label, hint = '', needs = '') => ({ key, label, hint, needs, type: 'times' })

/** 时段上限：超过就拒（面板一行也放不下更多）。 */
export const QUIET_MAX_RANGES = 8

/** 全角数字/冒号归一（与引擎侧 parseQuietRanges 同口径）。 */
function normalizeRangeText(text) {
  const fullWidthDigits = '０１２３４５６７８９'
  return String(text ?? '')
    .replace(/[：]/g, ':')
    .replace(/[－—–]/g, '-')
    .replace(/[０-９]/g, (ch) => String(fullWidthDigits.indexOf(ch)))
}

/**
 * 校验并归一化一组时段；返回 `{ ok, ranges, reason }`。
 * `ranges` 是归一化后的 `H:MM-H:MM` 字符串（写进配置的就是它），`reason` 给界面直接显示。
 */
export function normalizeQuietRanges(value) {
  if (!Array.isArray(value)) return { ok: false, ranges: [], reason: '时段必须是数组（如 ["9:00-12:00","14:00-18:00"]）' }
  if (value.length > QUIET_MAX_RANGES) return { ok: false, ranges: [], reason: `最多 ${QUIET_MAX_RANGES} 段时段（收到 ${value.length} 段）` }
  const ranges = []
  for (const raw of value) {
    const text = normalizeRangeText(raw).trim()
    const match = /^(\d{1,2}):(\d{1,2})\s*-\s*(\d{1,2}):(\d{1,2})$/.exec(text)
    if (!match) return { ok: false, ranges: [], reason: `看不懂这个时段：${String(raw)}（要写成 9:00-12:00 这样的 H:MM-H:MM）` }
    const [h1, m1, h2, m2] = match.slice(1).map(Number)
    if (h1 > 23 || m1 > 59 || h2 > 23 || m2 > 59) {
      return { ok: false, ranges: [], reason: `时段越界：${String(raw)}（小时 0–23、分钟 0–59）` }
    }
    if (h1 === h2 && m1 === m2) return { ok: false, ranges: [], reason: `起止时间相同：${String(raw)}（这条不起作用，去掉它）` }
    ranges.push(`${String(h1).padStart(2, '0')}:${String(m1).padStart(2, '0')}-${String(h2).padStart(2, '0')}:${String(m2).padStart(2, '0')}`)
  }
  return { ok: true, ranges, reason: '' }
}

/**
 * **数字列表**控件（v0.6.8）：`allowUsers` / `allowGroups` 这种"一串 QQ 号 / 群号"的键。
 *
 * schema 里它们是 `z.array(z.number().step(1))`（**数字**数组），而 OneBot 的 `user_id` 在
 * `lib/onebot.js` 里就被 `Number(...)` 转成数字，`#allowed()` 用 `includes` 比的就是数字——
 * 所以这里必须写**数字**，写成字符串（`"2000000001"`）会让白名单永远匹配不上。
 */
const list = (key, label, hint = '', needs = '') => ({ key, label, hint, needs, type: 'list' })

/** 白名单最多多少条（够了；再多就该用白名单文件而不是面板）。 */
export const LIST_MAX_ITEMS = 50

/**
 * `numberMeta` 里的 min/max 读成"数字或 null"。
 * ⚠️ 不能直接 `Number(meta.min)`：schema 没写范围时这里是 `null`，而 `Number(null) === 0`，
 * 会让界面与服务端把这一行夹死在 [0,0]（`botQq` 这种没有 schema 范围的键就永远改不了）。
 */
export function metaNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

/**
 * 校验并归一化一份"号码列表"；返回 `{ ok, list, reason }`。
 * 只收**正整数**（QQ 号 / 群号），去重、保序；上限 `LIST_MAX_ITEMS`。
 */
export function normalizeNumberList(value) {
  if (!Array.isArray(value)) return { ok: false, list: [], reason: '白名单必须是数组（如 [2000000001]）' }
  if (value.length > LIST_MAX_ITEMS) return { ok: false, list: [], reason: `最多 ${LIST_MAX_ITEMS} 条（收到 ${value.length} 条）` }
  const list = []
  for (const raw of value) {
    const num = typeof raw === 'number' ? raw : NaN
    if (!Number.isFinite(num)) {
      return { ok: false, list: [], reason: `只接受数字号码（收到 ${JSON.stringify(raw)}）——QQ 号/群号别加引号` }
    }
    if (!Number.isInteger(num) || num <= 0) return { ok: false, list: [], reason: `号码必须是正整数（收到 ${num}）` }
    if (!list.includes(num)) list.push(num)
  }
  return { ok: true, list, reason: '' }
}

/** 一个**数值**控件（v0.6.7）：风控里那些"阈值"原来只能在配置里手改，现在面板直接给数字。
 *
 * 范围/步长/默认值**从 schema 读**（`numberMeta`，见 lib/index.js 的 `numberMetaOf`）——
 * 面板里不抄第二份，否则改了一处、另一处不跟着变，界面就会允许写出 schema 会拒的值。
 * 这里只声明"这个键是数值行 + 单位 + 说明"。
 */
const num = (key, label, hint = '', unit = '', needs = '') => ({ key, label, hint, unit, needs, type: 'number' })

/**
 * **开关 + 数值合成一行**（v0.6.7）：开关是总闸，数值是它的阈值，两个必须在同一行里。
 *
 * 为什么（用户 2026-10-17：「你这两个怎么不合并在一起」）：原来它们是两行、名字还几乎一样
 * （「每分钟进模型上限」+「每分钟进模型上限·数值」），要上下对照才知道谁管谁；合成一行后
 * 就是"这里一个开关、旁边一个数字"，关系写在脸上。
 *
 * 键照旧是**两个**（`key` = 布尔、`number.key` = 数值），写配置时各写各的（POST 一次只写一个键），
 * 所以服务端校验与 `PANEL_ROW_BY_KEY` 都按"展开后的两个键"工作，见文件末尾的展开。
 */
const numSwitch = (key, label, hint, numberKey, numberLabel, numberHint, unit = '') => ({
  key,
  label,
  hint,
  needs: '',
  unit,
  type: 'switchNumber',
  number: { key: numberKey, label: numberLabel, hint: numberHint, unit, needs: '', type: 'number' },
})

/** 依赖标记的词表（界面按这个顺序渲染，别随意加近义词）。 */
export const PANEL_NEEDS = {
  service: '需自备服务',
  key: '需自备密钥',
  file: '需自备词表',
  config: '需配置',
  admin: '需群管理员',
  napcat: '需 NapCat 扩展',
  npmodel: '不需模型',
}

/**
 * **下拉选择**控件（v0.7.8，2026-10-29）。
 *
 * 为什么需要这个类型：`outboundRedactMode` 是"五档里挑一个"的枚举，而面板原来只会画
 * 布尔开关和数字框——于是它只能手改 `cordis.patch.yml`。用户找不到它，就等于这个功能不存在
 * （2026-10-29 我告诉主人「面板里没有这一行」，他当场要求补上）。
 *
 * `options` 每项 `{ value, label, hint }`：`value` 必须与 `lib/index.js` 的取值**逐字一致**
 * （服务端 `validateEntry` 用它做白名单，写别的会被 400 拒）；`hint` 是这一档"会发生什么"，
 * 界面在选中项下面显示——**不写清楚的话，用户不敢点 `block`**（那个档会让整条回复发不出去）。
 */
const sel = (key, label, hint, options, needs = '') => ({ key, label, hint, needs, type: 'select', options })

/**
 * **单行文本**控件（v0.7.8）：金丝雀哨兵串这种"自由填、但有硬规矩"的键。
 *
 * `validate(value)` 由本文件导出成 `normalizeCanary`，服务端写入前调它——和下拉一样，
 * 面板绝不把没校验过的字符串写进配置（写进去的坏值会让宿主启动时 schema 校验失败）。
 */
const text = (key, label, hint, { needs = '', placeholder = '', maxLen = 64, validate = null } = {}) =>
  ({ key, label, hint, needs, type: 'text', placeholder, maxLen, validate })

/**
 * 金丝雀（哨兵串）的规矩：**非空时必须是"短小的纯 ASCII 标识符"**。
 *
 * 三条都不是洁癖，是踩出来的：
 *   ① **长度 ≥ 8**：太短会把正常对话打成泄漏。`cny` 这种串在中文里当然不会出现，但
 *      有人会填 `key`/`test` 这类词 —— 之后每条含这个词的正常回复都被当成"系统提示泄漏"抹掉。
 *   ② **不许空白**：出站扫描按空白分词做分片检测，带空格的哨兵串会被自己切碎、永远匹配不上
 *      （等于装了个永远不响的警报器，而面板上看着是"已启用"）。
 *   ③ **纯 `[A-Za-z0-9._-]`**：DLP 的规范化层会把全角、零宽、大小写都揉一遍，非 ASCII 哨兵串
 *      过完规范化之后和原文对不上，同样变成哑弹。留 ASCII 是唯一能保证"写进去就能响"的口径。
 *
 * 空串 = **允许**，语义是"我没指定，让插件自动生成"（落盘在 `<cwd>/qq-canary.json`，重启不变）。
 */
export const CANARY_MIN_LEN = 8
export const CANARY_MAX_LEN = 64
export function normalizeCanary(value) {
  if (typeof value !== 'string') {
    return { ok: false, value: '', reason: `金丝雀必须是字符串（收到 ${JSON.stringify(value)}）` }
  }
  const trimmed = value.trim()
  if (trimmed === '') return { ok: true, value: '' }
  if (/\s/.test(trimmed)) {
    return { ok: false, value: '', reason: '金丝雀不能含空格/换行——出站扫描按空白分词，带空白的哨兵串会被自己切碎、永远匹配不上' }
  }
  if (trimmed.length < CANARY_MIN_LEN) {
    return { ok: false, value: '', reason: `金丝雀至少 ${CANARY_MIN_LEN} 个字符（收到 ${trimmed.length} 个）——太短会把正常对话误判成泄漏` }
  }
  if (trimmed.length > CANARY_MAX_LEN) {
    return { ok: false, value: '', reason: `金丝雀最多 ${CANARY_MAX_LEN} 个字符（收到 ${trimmed.length} 个）` }
  }
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    return { ok: false, value: '', reason: '金丝雀只能是字母/数字/`.`/`_`/`-`（全角或中文过完 DLP 规范化会与原文对不上，等于装了个哑弹）' }
  }
  return { ok: true, value: trimmed }
}

/**
 * 数据根目录（`dataDir`）的规矩。空串 = **没配**，语义与 `lib/bridge.js` 的
 * `String(config.dataDir ?? '').trim() || config.cwd` 逐字一致（空 = 跟 cwd）。
 *
 * 为什么只收绝对路径：相对路径会随"从哪个目录启动"而漂移，同一份配置会指向两个目录，
 * 结果就是"记忆有时候在、有时候不在"。这种 bug 不报错、只能靠人肉发现，所以直接在写入时拒掉。
 *
 * 为什么不许 `..`：用户以为是"根目录"的那个路径，实际可能被 `..` 折到别处，
 * 面板显示的和落盘的不是一个地方——这类不一致比"配不进去"严重得多。
 *
 * 长度上限 240 = Windows MAX_PATH(260) 留 20 给 `\qq-canary.json` 这种文件名。
 * 超了不是"写不进去"，而是**某些文件会静默写失败**，所以在这里就挡。
 */
export const DATA_DIR_MAX_LEN = 240
export function normalizeDataDir(value) {
  if (typeof value !== 'string') {
    return { ok: false, value: '', reason: `数据根目录必须是字符串（收到 ${JSON.stringify(value)}）` }
  }
  const trimmed = value.trim()
  if (trimmed === '') return { ok: true, value: '' }
  if (trimmed.length > DATA_DIR_MAX_LEN) {
    return { ok: false, value: '', reason: `路径最多 ${DATA_DIR_MAX_LEN} 个字符（收到 ${trimmed.length} 个）——太长的路径会让部分文件静默写失败` }
  }
  const absolute = /^[A-Za-z]:[\\/]/.test(trimmed) || /^\\\\/.test(trimmed) || /^\//.test(trimmed)
  if (!absolute) {
    return { ok: false, value: '', reason: `必须是绝对路径（例如 C:\\Users\\你\\qq_chat）；相对路径会随启动目录漂移，两个目录各存一半数据` }
  }
  if (trimmed.split(/[\\/]/).some((part) => part === '..')) {
    return { ok: false, value: '', reason: '路径里不许出现 `..`——面板显示的位置会和你以为的不是同一个地方' }
  }
  // 去掉末尾分隔符（但保住 `C:\` 这种纯根），否则 console 与 bridge 拼出来的路径字符串会不相等
  const stripped = trimmed.replace(/[\\/]+$/, '')
  return { ok: true, value: stripped === '' || /^[A-Za-z]:$/.test(stripped) ? `${stripped}\\` : stripped }
}

/**
 * 分组：前 4 组是日常会动的；后 3 组标 `advanced`，界面里默认折叠。
 * 之所以不直接暴露全部布尔键：面板要的是"能一眼看完的开关"，其余仍走配置文件。
 */
export const PANEL_GROUPS = [
  {
    /**
     * **AI 账号与白名单**（v0.6.8；2026-10-19「做一个白名单添加面板」、2026-10-20「白名单改成 AI 账号与白名单」
     * + 「拉到对话基础上边」）。
     *
     * 为什么排在最前：它回答的是"**这是哪个机器人账号、它认谁**"——白名单空着，别的开关调得再对机器人也不说话。
     *
     * 为什么把 `botQq` 也放这一组：它和两个白名单是同一类东西。
     *   - `botQq`：判断"群里 @ 的是不是它"「戳一戳」是不是戳它（0 = 不判断）；
     *   - `allowUsers` / `allowGroups`：**为空 = 全部拒绝**（`lib/bridge.js` 的 `#allowed()`）。
     * 真机上最容易踩的两个坑正好对应这两处："NapCat 登录成功但机器人一声不吭"（白名单空）、
     * "戳一戳没反应"（botQq 没配）。
     */
    id: 'whitelist',
    title: 'AI账号与白名单',
    note: '这一组决定**机器人是谁、它认谁**。`AI 账号` 填机器人自己的 QQ（0 = 不判断）；'
      + '两个白名单**空 = 全部拒绝**（刻意的安全默认）：私聊必须把对方 QQ 加进「允许的用户」，'
      + '群消息必须把群号加进「允许的群」。号码填**数字**、不用加引号；改完点开关/保存即生效（宿主热重载）。'
      + '**白名单是在建会话之前就拦下的**：不在名单里的会话**根本不会被创建**，所以不会"回一句拒绝"，'
      + '而是在 trace 里直接记「白名单」被拒 —— 排查时看 `/为什么`，不要等它回话。'
      + '**管理员名单里的号也必须出现在「允许的用户」里**，否则消息先被白名单拦下，命令自然不会响应。'
      + '**群里"别人说话它不回"**按顺序查三处：① 群号在「允许的群」里；② 「群内也校验成员名单」——'
      + '开着时群里只有「允许的用户」里的人能触发（历史默认，2026-10-31 起可关）；'
      + '③ 「群里只理被 @ 的」——开着就必须真的 @ 到它（含正文里叫它的名字）。三者任一不过，它一个字都不回，'
      + '只在 trace 里记一条被拒原因（看 `/为什么`）。',
    rows: [
      /**
       * 白名单组里的 `botQq`：**不画 ± 按钮**（用户 2026-10-20「AI账号那一栏为啥还有加减啊」）——
       * QQ 号是"填一次就完事"的标识，不是"一点一点调"的阈值，旁边挂两个加减键看着就像调试参数。
       */
      { ...num('botQq', 'AI 账号（机器人 QQ 号）', '机器人**自己**的 QQ 号（不是你的）。群里判断「@ 的是不是它」、「戳一戳」是不是戳它都要用。**0 = 不判断**：群里每条消息都当 @ 处理，戳一戳一律不理。', '号'), noStepper: true },
      // ★ v0.6.8（用户 2026-10-20「不需要添加白名单的功能，会理会所有的群聊和会话，但是群聊还是要 @ 的」）：
      //   开了它下面两个名单就不生效；但群里的 @ 门槛**不变**（那是 replyOnlyWhenMentioned 的事）。
      //   名字改成「回应所有人」（2026-10-20「应该换个名字」）：一句话说清效果，和「群里只理被 @ 的」同一套句式。
      row('allowAllChats', '回应所有人', '打开后**所有私聊和所有群**都会响应，下面两个白名单不再生效。**群里的 @ 门槛不变**：仍然要 @ 到它才回（除非你关掉「群里只理被 @ 的」）。默认关。'),
      // 两个"准入门"开关也放这里：它们和下面两个白名单是同一件事——**谁能让它开口**。
      row('replyOnlyWhenMentioned', '群里只理被 @ 的', '群里只有 @ 到机器人才回话；私聊不受影响。判断"@ 的是不是它"要看上面的 AI 账号（0 = 每条群消息都当 @）。关掉后群里每句话都会进模型（费额度）。'),
      row('acceptPrivate', '允许私聊', '私聊是否响应（仍然受下面的「允许的用户」白名单限制）。关掉后私聊一律不理。'),
      { ...list('allowUsers', '允许的用户（QQ 号）', '私聊白名单：只有列表里的 QQ 号可以私聊机器人。**空 = 拒绝所有私聊**。群消息也要求发送者在这个列表里——**除非关掉下面的「群内也校验成员名单」**。'), dependsOn: 'allowAllChats', dependsActive: false, switchLabel: '回应所有人' },
      { ...list('allowGroups', '允许的群（群号）', '群白名单：只有列表里的群会收到回复。**空 = 拒绝所有群消息**（进群申请、撤回通知这类 notice 不受影响）。'), dependsOn: 'allowAllChats', dependsActive: false, switchLabel: '回应所有人' },
      /**
       * ★ 2026-10-31（用户「群聊其他用户跟他聊天不回应」）：把"群成员是否也要进 allowUsers"
       *   变成**显式开关**，而不是藏在代码里的隐藏规则。
       *
       * 为什么必须默认 `true`（= 保留老行为）：老配置里没有这个键，一旦默认放行，
       * 那等于"升级一次，所有白名单群的准入范围悄悄放大到全体成员"——这种事不能由升级替用户决定。
       *
       * 为什么值得有这个开关：`allowGroups` 的语义是"这个群可以让机器人服务"，
       * 而不是"这个群里只有我指定的几个人能跟它说话"。后者在真群里不可维护——
       * 新人进群就得改配置，而症状长得像"它坏了"（它根本不回话，也不说为什么）。
       */
      row('groupCheckMembers', '群内也校验成员名单', '打开时：群里只有「允许的用户」列表里的人能触发它（**历史默认**）。关掉后：**白名单群里任何成员**说话都算数——但**仍然要 @ 它**（受「群里只理被 @ 的」管），群白名单照旧生效。关掉等于把群里的发言权交给全体成员：会费额度，也可能被刷屏。'),
      /**
       * ★ v0.7.0：管理员名单（`adminUsers`）终于进面板 —— 以前只能改 YAML，
       * 而它正是 `/设管理`、`/批量踢`、`/退群` 这些命令的准入门。
       * ⚠️ 它**不**在「允许的用户」之外生效：消息先过 `allowUsers`，所以管理员必须同时在两边。
       * 这也**不是**扩展开关，不受 `allowAllChats` 影响（管理员名单始终要显式填）。
       */
      list('adminUsers', '管理员（QQ 号）', '这些号可以执行管理命令（`/设管理`、`/批量踢`、`/退群`、`/成员 @某人` 等）。'
        + '**必须同时出现在「允许的用户」里**，否则消息先被白名单拦下。'
        + '**空 = 没有管理员**（管理命令一律不响应，这是安全默认）。'),
      /**
       * ★ 2026-10-31（外部审计 S1/S2）：反向 WS 的 Origin 闸。
       *
       * 为什么默认**关**、而且关着才是安全的一侧：浏览器发起 WebSocket 时一定带 `Origin`
       * （握手就是 HTTP，浏览器按规范加，页面脚本改不了），而 OneBot 实现（NapCat / Waylay /
       * LLOneBot…）是原生进程、用 `ws` 库连、默认不发。所以"带 Origin 就拒"能精准挡住
       * 「用户访问恶意网页 → 页面里连 ws://127.0.0.1:6700 → 伪造事件」，一个合法客户端都不误伤。
       *
       * 名字刻意不叫「Origin 校验」：面板上没人知道 Origin 是什么，得说清**它挡的是谁**。
       */
      row('allowBrowserOrigin', '允许网页发起连接', '默认关。关着时：**从网页里发起的连接会被拒**——浏览器连 WebSocket 一定带 `Origin`，'
        + '而 OneBot 客户端（NapCat / Waylay）是原生进程、不带这个头，所以关着不影响它们。'
        + '**为什么要关**：不关的话，你随手打开一个恶意网页，它就能连上本机 `ws://127.0.0.1:6700` 伪造消息——'
        + '浏览器不受同源策略限制，绑 127.0.0.1 也挡不住。'
        + '只有当你把桥包在一层**浏览器客户端**后面时才需要打开，并且那时请同时配 `accessToken`。'),
    ],
  },
  {
    /**
     * ★ 2026-10-31（用户「定时发送好像就给我发送了，没有给所有私聊都发送」）：
     * 这一整组配置**此前只存在于 YAML**——面板里 0 行、运行快照里 0 个键。
     * 功能在跑、但没有任何界面能看见它的范围，用户排查就只能问 AI 或翻 patch 文件。
     *
     * 「她主动找谁」的规则是**三者取交集**：
     *   ① `proactiveUsers`（这里的名单，空 = 不过滤）；
     *   ② 白名单（allowUsers / allowAllChats）；
     *   ③ 有没有过会话（聊过才进候选——对一个从没说过话的人半夜开口，不合适）。
     * 所以「allowUsers 全都收得到」是错的预期：白名单是"她可以*被*这些人找"，
     * 这里是"她可以*找*这些人"，两个方向都是准入，互不包含。
     */
    id: 'proactive',
    title: '主动开口（她来找你）',
    note: '这一组决定**她会不会自己开口、找谁**。找谁按**三者取交集**：① 下面的「主动名单」（空 = 不过滤）；'
      + '② 白名单（上面的「允许的用户」）；③ **有没有过会话**——从没跟她聊过的人不会出现在候选里。'
      + '所以「白名单里所有人都会收到」是错的预期：白名单管的是"谁*能*找她"，这里管的是"她*能找*谁"。'
      + '每个会话独立评估（各自有各自的计划和冷却），她开口的记录在 <cwd>/qq-proactive.log，判定理由逐行可查。',
    rows: [
      row('proactiveEnabled', '主动开口', '打开后她会按生物钟自己开口（到点了、或冷却到了），每个会话独立评估。关掉后她只回答、从不主动。默认关。'),
      row('proactiveDryRun', '只记不发（试跑）', '**默认开**：只把"这次本来要说什么、为什么"写进 <cwd>/qq-proactive.log，一个字都不发——先看几天日志确认她开口的样子没问题，再关掉真发。直接关掉它 = 允许她真的开口。'),
      { ...list('proactiveUsers', '主动名单（QQ 号）', '她**只主动找**名单里的人。**空 = 不过滤**（只要白名单放行且聊过天的人都可能收到）。'
        + '注意这**不是**白名单：白名单管"谁能找她"，这里管"她能找谁"。'
        + '名单里的人如果从没跟她聊过，也不会被找（没有会话就没有生物钟状态）。'), dependsOn: 'proactiveEnabled' },
    ],
  },
  {
    id: 'chat',
    title: '对话基础',
    rows: [
      row('memoryEnabled', '长期记忆', '把每个会话最近的对话存到 <cwd>/qq-memory/，宿主重启后重新注入，机器人才"记得"之前聊过什么。关掉后不再记住群里的事。', PANEL_NEEDS.config),
      row('sessionResumeEnabled', '会话续接', '宿主重启后接着用同一个会话（完整上下文，不只是记忆窗口）。关掉后每次重启都是新会话。'),
      // ★ v0.6.9：「回复带引用」属于**回复的样子**，不是"谁能让它开口" —— 所以放对话基础，不塞进白名单组。
      row('quoteReplyEnabled', '回复带引用', '回复时引用被回答的那条消息（QQ 原生「回复」）。**只作用于群聊**（私聊一对一，引用没意义）；**默认关**：多人同时提问时更清楚，但它会改变群里的观感。打开后**不用任何特殊问法**——所有群回复都会带引用。引用失败（消息被撤回/ID 过期/客户端不支持）会**自动去掉引用重发一次**，不会把回复弄丢。'),
      row('dedupEnabled', '重复消息去重', '忽略重复的入站消息（NapCat 重连后重复投递的那条），时间窗见下面的「去重窗口」（默认 300 秒）。'),
      num('dedupWindowSeconds', '去重窗口', '同一条消息在多长时间内重复到达算"重复"（NapCat 重连后常见）。上面"重复消息去重"打开时才起作用。', '秒'),
      /**
       * ★ v0.7.7：长回复被切开时**在标点处断**（默认开）。
       * 只有超过「单条上限」的长回复才会触发分批，所以这个开关平时看不见效果；
       * 关掉 = 退回按字数硬切（会有句子被劈成两半），给"就想要整齐的等长气泡"的人。
       */
      row('longReplySplitOnPunctuation', '长回复按标点断开', '回复超过单条上限、需要拆成多条时，**优先在句末标点断开**（找不到句末就退到逗号/顿号，再不行才硬切），不会把一句话从中间劈开。**默认开**；关掉就退回按字数硬切。只有超长回复才会触发分批，普通对话看不到区别。'),
    ],
  },
  {
    /**
     * 两个限流闸合并成一组（用户 2026-10-17：「对话基础的会话上限和风控里的会话上限有什么区别」
     * ——分在两组里各叫一个"上限"确实容易混）。按**管道顺序**排：先入站（进模型），后出站（发出去）。
     * 两个都**默认关**（与仓库既有口径一致）。
     */
    id: 'limits',
    title: '限流：入站 / 出站',
    note: '两个闸**默认都关**，可以只开一个。**入站**（每分钟进模型）在消息**还没进模型**时拦，省的是模型额度；'
      + '**出站**（回复限流）在模型已经生成回复、**发出去之前**拦，防的是 QQ 端发太快被风控（代价是那次模型回合白烧）。'
      + '命令的回复只走出站闸（`/help` 之类不烧模型，不受入站上限影响）。',
    rows: [
      // 开关 + 数值**同一行**（用户 2026-10-17：「你这两个怎么不合并在一起」）。
      numSwitch('chatTurnLimitEnabled', '每分钟进模型上限', '每个会话**每分钟最多让几条消息进模型**（入站风控，**默认关**）：右边是它的数值，超出的直接丢弃并记账（不排队），免得一个群刷屏把模型额度和响应都吃光。',
        'chatTurnsPerMinute', '每分钟进模型条数', '每个会话每分钟最多几个回合（默认 5，范围 1–10）。**左边的开关关着时这个数字不起作用。**', '条/分钟'),
      numSwitch('rateLimitEnabled', '出站回复限流', '每个会话在「出站回复窗口」内最多回几条（**出站**，默认关，主要防 QQ 风控）：超出的回复**丢弃不发**并记账——注意那次模型回合已经烧掉了，所以它是"最后一道闸"，不是省额度的手段。',
        'rateLimitMaxReplies', '出站回复上限', '一个窗口内最多回几条（默认 10 条）。**左边的开关关着时这个数字不起作用。**', '条'),
      num('rateLimitWindowSeconds', '出站回复窗口', '上面「出站回复限流」那个上限按多长的窗口算（默认 60 秒，范围 5–3600）。', '秒'),
    ],
  },
  {
    /**
     * 避开高峰期（v0.6.8）：功能早就有（`quietHoursEnabled` / `quietHours` / `quietWeekendExempt`），
     * 但面板里一个都没暴露 —— 只能去改配置文件。现在整组搬进来：开关 + 周末豁免 + 时段列表。
     * 语义与引擎侧完全一致（见 lib/bridge.js 的 parseQuietRanges / isQuietTime）：**支持跨夜**。
     */
    id: 'quiet',
    title: '避开高峰期',
    note: '静默时段内机器人**不回复任何入站消息**（不处理、不消耗模型调用，trace 里记原因）；'
      + '**已排定的定时提醒/投票开奖照常执行**。时段写成 `9:00-12:00`，**支持跨夜**（`22:00-6:00` 表示 22 点到次日 6 点）。',
    rows: [
      row('quietHoursEnabled', '避开高峰期', '开启后，下面那些时段内机器人**不回复**（也不烧模型）。默认关，关着时行为与之前完全一样。'),
      row('quietWeekendExempt', '周末不静默', '周六、周日**不套用**上面的时段（默认开）。关掉就七天都按同一个时段静默。'),
      // `dependsOn`：这条时段只在「避开高峰期」开关打开时才生效——服务端会把状态带给界面，
      // 免得出用户"设了时段却还在回复"（2026-10-20 真机就是这么踩的）。
      { ...times('quietHours', '静默时段', '要静默的时间段，可多段；支持跨夜（`22:00-6:00`）。起止时间相同的那条不起作用、会被拒。'), dependsOn: 'quietHoursEnabled', switchLabel: '避开高峰期' },
    ],
  },
  {
    id: 'ops',
    title: '群运营工具箱',
    rows: [
      row('groupOpsEnabled', '群运营总开关', '打开后下面这些命令才响应：原生群打卡、@全体余量、禁言名单、批量踢、群待办、群资料、文件整理、相册上传、运营周报。**大多数子命令要求机器人是该群管理员**；关掉后整组命令都不响应。', PANEL_NEEDS.admin),
      row('opsReadEnabled', '只读查询', '/全体余量 /禁言名单 /群资料 /入群通知 等只读查询（纯查询，不改群）。需要先打开上面的总开关。', PANEL_NEEDS.napcat),
      row('opsAdminEnabled', '管理员设置', '/设管理、/撤管理（set_group_admin）。需要机器人是管理员；目标必须**在本群里**，否则 NapCat 会报 get Uid Error（面板所在的宿主会把它翻译成中文原因）。', PANEL_NEEDS.admin),
      row('opsInvitePolicyEnabled', '邀请策略', '/邀请策略 关闭|需审核|免审核|百人以下 —— 四个取值来自 NapCat 的文档字面量。需要机器人是管理员。', PANEL_NEEDS.admin),
      row('opsAddOptionEnabled', '加群方式', '/加群方式 <1–5> [问题=… 答案=…]。add_type 在 NapCat 里是裸号码、没有官方枚举，所以机器人不替你"翻译"这些数字的含义。需要机器人是管理员。', PANEL_NEEDS.admin),
      row('requestSyncEnabled', '申请补拉', '/申请：主动把待处理的入群申请与可疑好友申请拉进审批队列，离线期间错过的也不会漏（审批用 /待审、/同意 N、/拒绝 N）。', PANEL_NEEDS.napcat),
      row('adminWatchEnabled', '管理员变动播报 + 权限自愈', '监听管理员变动：机器人被授权/被撤权时在群里说明；被撤之后写命令会直接告诉你"我不是管理员"，不会去瞎调接口。'),
      row('nativeSignEnabled', 'QQ 原生群打卡', '/群打卡 —— QQ **原生**的群打卡（set_group_sign）。注意它跟本地签到（娱乐组里的"本地签到"）是两回事。', PANEL_NEEDS.admin),
      row('opsKickEnabled', '批量踢', '/批量踢：需要**在群里二次确认**才会真正执行，防误触。需要机器人是管理员。', PANEL_NEEDS.admin),
      row('opsTodoEnabled', '群待办', '/待办、/完成待办、/取消待办（引用一条消息来指定）。需要机器人是管理员。', PANEL_NEEDS.admin),
      row('opsReportEnabled', '运营周报', '/周报，以及喂给它的运营计数（消息、入群、退群、踢人、禁言、打卡、表情回应）。', ''),
      num('opsReportDays', '运营周报·天数', '/周报 统计最近多少天（默认 7 天）。', '天'),
    ],
  },
  {
    id: 'fun',
    title: '娱乐与互动',
    rows: [
      row('faceEnabled', '表情包', '总开关：关掉就连 `qq_face_*` 工具和正文里的 `[face:…]` 标记一起失效——她只说话，不发表情。表情图放在 cwd/qq-faces/（顶层 png/jpg/gif/webp，名字就是她调用时用的键）。**注意改完要重新开会话**：工具是建会话时注册的，老会话里还留着上一个开关状态。'),
      row('funEnabled', '娱乐包总开关', '运势 / 骰子 / 小游戏的总闸，**默认关**。代码和下面三个开关一直都在，只是总闸关着时它们不响应——「装了」和「启用」是两件事，分开才能一眼看出「为什么它不说话」。开着总闸时，下面三个子开关的行为与你之前逐项配置的完全一致。'),
      { ...row('fortuneEnabled', '每日运势', '今日人品/运势、抽签、塔罗；按人按天确定性生成——**不调模型、不联网**。', PANEL_NEEDS.npmodel), dependsOn: 'funEnabled', switchLabel: '娱乐包总开关' },
      { ...row('diceEnabled', '骰子', '骰子与随机抽选（.r 3d6 / 掷骰 2d6+1 / /抽一个 A B C），纯本地计算。', PANEL_NEEDS.npmodel), dependsOn: 'funEnabled', switchLabel: '娱乐包总开关' },
      row('pointsEnabled', '积分', '积分经济（默认关）：聊天与签到赚积分，/积分 看余额、/排行榜 看排行、/转账 @某人 数量 转账。赚取规则见 pointsPerMessage / pointsDailyCap / pointsCheckinBonus。', PANEL_NEEDS.config),
      { ...row('gameEnabled', '小游戏', '群内小游戏：成语接龙、猜数字。说"接龙"/"猜数字"开始，"不玩了"结束。'), dependsOn: 'funEnabled', switchLabel: '娱乐包总开关' },
      row('checkinEnabled', '本地签到', '本地打卡（默认关）：群里发关键词（默认"签到"）即打卡，连续天数与总天数按会话存在 <cwd>/qq-checkin/，/签到榜 看排行。**与 QQ 原生群打卡是两件事**（那个要开"群运营"里的 /群打卡）。', PANEL_NEEDS.config),
      row('voteEnabled', '投票', '群投票："投票：问题？A 选项 B 选项"，成员回选项字母投票；/vote、/vote-end 管理，时长见 voteDurationSeconds。'),
      row('todoEnabled', '待办提醒', '共享待办：/todo add|list|done|clear，或直接说"记一下：xxx"；按会话存在 <cwd>/qq-todos/。'),
      row('statsEnabled', '活跃统计', '群活跃统计（默认关）：按人按天统计发言数，/统计、/活跃榜、/周榜 查看；日报也用它。保留天数见 statsKeepDays。', PANEL_NEEDS.config),
      row('mcStatusEnabled', 'MC 服务器状态', 'Minecraft Java 服务器状态：/mc 主机[:端口]，走官方的 Server List Ping 协议——**不需要 API key，只读**。超时见 mcStatusTimeoutMs。', PANEL_NEEDS.npmodel),
      row('pokeEnabled', '戳一戳回应', '被戳一戳时回一句随机可爱话（仅白名单会话）。文案与频率见 pokeReplies / pokeBackText / pokeCooldownSeconds。'),
      num('pokePerHour', '戳一戳·每小时上限', '每个会话每小时最多主动戳几次（默认 5 次，免得互相戳到停不下来）。', '次/小时'),
      row('welcomeEnabled', '入群欢迎', '新人入群时 @ 他并发送欢迎语（默认关，文案见 welcomeText），只对白名单群生效。'),
    ],
  },
  {
    id: 'media',
    title: '语音与媒体',
    // 组级提示：这一组的能力**插件与 DSH 都不自带**，必须用户自己准备，所以默认全关。
    note: '注意：**语音回复（TTS）与 AI 生图 DSH 与本插件都不自带**——要么本机自己装服务（如 GPT-SoVITS），'
      + '要么去第三方申请密钥，然后在配置里填地址与密钥；**语音转文字 DSH 自带**（实验性的「语音输入」bundle，'
      + '需要你在 DSH 里自行启用，首次用会下载本地 SenseVoice 模型），也可以改配自己的云服务。'
      + '所以这一组**默认全部关闭**；没准备好就别开，开了只会看到"合成失败"的日志。'
      + '另外 OCR / 相册 / 群文件 / 成员查询这些走的是 **NapCat 的专有接口**，换别的 OneBot 实现会不可用。',
    rows: [
      row('voiceToolEnabled', '语音·让她能发', '开关「她有没有发语音这个能力」（`qq_send_voice` 工具）。默认开：只要下面 TTS 配好了，她想哄你睡觉、想嗯一声的时候可以发一条短的。关掉之后**不会**清掉你的 TTS 密钥，随时能再打开。与下面「语音回复」是两件事——那个是每条都复读一遍。同样**改完要重新开会话**。'),
      sel('ttsVoiceFormat', '语音容器（SILK / MP3）', '**默认 SILK**，别改成 MP3 —— QQ 9.9.36 起不再自己把 mp3 转成 silk，直接发 mp3 会在 QQ 内部失败（`retcode 1400`），而且错误信息完全看不出是格式问题。SILK 需要可选的 `silk-wasm` 包（`npm i silk-wasm`）；没装时自动退回 MP3，不会让她彻底发不出语音。只有确认自己的 QQ/NapCat 是老版本、会自动转码，才改成 MP3。', ['silk', 'mp3'], PANEL_NEEDS.service),
      row('cardVideoWatchEnabled', '视频卡片·抽帧给她看', '别人分享 B 站/抖音/微博/YouTube 视频时，桥会下载**前 cardVideoSeconds 秒**（默认 60）、抽 cardVideoFrames 张画面（默认 4）附给她，这样她至少知道「画面里是什么」，而不是只读到标题。**需要本机装 yt-dlp**（推荐装进某个 Python env，再把路径填进 ytDlpPython）——没装就自动退化成「只有链接和页面文字」，不报错。代价：每张视频卡片多一次 3–10 秒的下载。', PANEL_NEEDS.service),
      row('ttsEnabled', '语音回复（每条自动跟一条）', '**这是复读机语义**：每发一条文字回复，就自动再把这条文字念一遍发出来。要的是「她偶尔主动发语音」请用上面那个开关，别开这个。**DSH 与本插件都不自带 TTS**，要你自己准备：本机装 GPT-SoVITS（ttsProvider=local，配 ttsLocalUrl 与参考音频/提示文本），或去云端申请密钥（Azure 需 ttsApiKey + ttsAzureRegion；OpenAI 兼容需 ttsBaseUrl + ttsModel + ttsApiKey），或用 edge-tts 之类本地服务伪装成 openai 档。没准备时只会回文字，失败原因会记进 trace。', PANEL_NEEDS.service),
      row('sttEnabled', '语音转文字', '群里 @机器人 时引用一条语音、或私聊直接发语音，先转写再回答。**默认走 DSH 自带的本地识别**（`sttProvider: dsh`，SenseVoice，音频不出本机、不需要任何密钥）——前提是你已经在 profile 里启用实验性的「语音输入」bundle（首次使用会下载模型）。想改用云端就把 `sttProvider` 设成 `cloud`，再配 sttBaseUrl / sttModel / sttApiKey（例如智谱 glm-asr）。', PANEL_NEEDS.config),
      row('voiceReadingEnabled', '朗读语音消息', '@机器人 引用一条文字消息说"读一下/念出来"，或 /读 <文本>，机器人用 TTS 念出来。**默认关**，因为它要你自己准备 TTS 服务（DSH 不自带；与"语音回复"共用配置：本地 GPT-SoVITS 或云端密钥）。', PANEL_NEEDS.service),
      row('imageGenEnabled', 'AI 生图', '/画 <描述词> 生成图片并发回来（群里需 @机器人）。**DSH 与本插件都不自带生图模型**，要你自己准备：任何 OpenAI 兼容的图片接口——填 imageGenProvider / imageGenBaseUrl / imageGenApiKey / imageGenModel / imageGenSize；本地部署的（如 SD WebUI / ComfyUI 的兼容接口）也行，把地址填成它即可。图片保存与清理见 imageRetentionDays / imageTrashDir。', PANEL_NEEDS.service),
      row('ocrEnabled', '图片文字识别', '/ocr 读出用户发送或引用图片里的文字（只读）。走 NapCat 的 ocr_image 能力，**不需要额外密钥**。', PANEL_NEEDS.napcat),
      row('albumEnabled', '群相册上传', '/相册 列出群相册（只读）。走 NapCat 的群相册接口，需要机器人在群里有相应权限。', PANEL_NEEDS.napcat),
      row('groupFileEnabled', '群文件', '/文件 列出群文件与目录、/文件 <文件夹> 进入子目录（只读）。条数与大小上限见 groupFileListLimit / groupFileMaxBytes。', PANEL_NEEDS.napcat),
      row('fileTransferEnabled', '私聊文件转存', '私聊里把用户发来的文件存到 <cwd>/qq-files/ 并回复本地路径。大小上限见 fileTransferMaxBytes；给模型回传文件用 fileSendDirs / fileSendMaxBytes。', PANEL_NEEDS.config),
    ],
  },
  {
    id: 'safety',
    title: '安全与风控',
    advanced: true,
    note: '这一组分两半：**出站防泄漏**（她要说出去的话先过一遍，看有没有把你的密钥/本机路径/系统提示带出去）'
      + '和**群内治理**（入群验证、敏感词、刷屏、防撤回）。'
      + '出站那两道是 2026-10-29 加的，起因是"有人转义 key 之类的敏感信息"——它挡的不是"她判断错"，'
      + '而是"她老老实实地回答了"。现场自检：私聊发 `!dlptest`（6 条样例的判定）、`!canary`（哨兵串状态）。',
    rows: [
      /**
       * ★ v0.7.8 出站 DLP（2026-10-29）。
       *
       * 放在这一组**最前面**：它是唯一一条能挡住"密钥被原样贴出去"的开关，
       * 而这一组是 `advanced`（默认折叠）的——折叠着还能被看见，靠的就是位置和标题。
       */
      { ...sel('outboundRedactMode', '出站敏感信息处置',
        '她说的每句话（以及 QQ 空间说说）在**发出去之前**都过一遍扫描：字面密钥、变形写法（零宽/空格/全角/换行）、'
        + '以及编码过的（base64 / HTML 实体 / `\\uXXXX` / `%XX`）。命中后怎么处理，就是这一档。'
        + '⚠️ 它扫的是**出站文本**，所以只是最后一道闸：真正的防线是不把密钥给她（私有文件读取本来就是禁的）。',
        [
          { value: 'off', label: 'off · 关', hint: '完全不扫。除非在排查"是不是闸误伤了我"，否则别选这个。' },
          { value: 'monitor', label: 'monitor · 只记账不动手', hint: '命中只写事件流，话照原样发出去。用来观察几天"到底会不会命中"，不改变行为。' },
          { value: 'redact', label: 'redact · 抹成 ***REDACTED***', hint: '命中片段替换成 `***REDACTED***`。缺点是等于告诉对方「你找对地方了，这里有东西」——他会换个编码再来一次。' },
          { value: 'decoy', label: 'decoy · 换成等长假值（默认）', hint: '命中片段换成**同格式的假值**（如 `sk-dlp…`，长度与前缀都对得上）。对方以为得手了，拿去用是废的，也不会暴露这里装了闸。JWT/私钥/路径造不出同格式假值，仍按抹掉处理。' },
          { value: 'block', label: 'block · 整条不发', hint: '命中就**这条回复整个不发**（她当场失声）。最严，代价是你会以为"她卡住了"——排障看事件流。' },
        ]),
        sub: '出站防泄漏' },
      { ...text('outboundRedactCanary', '出站金丝雀（哨兵串）',
        '放进她系统提示里的一串"暗号"。只要它出现在任何一条出站消息里，就说明**系统提示被整段抄出去了**'
        + '（这比漏一个密钥更严重），命中一律按上面的处置档处理（`off` 除外）。'
        + '**留空 = 自动生成**（存 `<cwd>/qq-canary.json`，重启不变）；想自己指定就填 ≥8 位字母数字。'
        + '私聊发 `!canary` 看当前值（只回前 8 位——全值落进聊天记录就毁了它自己）。',
        { placeholder: '留空 = 自动生成（如 cny-3f2a9b7c11）', maxLen: CANARY_MAX_LEN, validate: normalizeCanary }) },
      { ...row('verifyEnabled', '入群验证', '入群/加好友申请先进队列，给管理员推一道挑战题；管理员回 /同意 <id>，或对方答对才通过（默认关）。关键词与超时见 verifyKeyword / verifyTimeoutSeconds / verifyMaxPending。', PANEL_NEEDS.config), sub: '群内治理' },
      row('filterEnabled', '内容过滤', '敏感词过滤（默认关）：按**本地词表文件**匹配，命中后警告/撤回/禁言（动作见 filterAction）。需要自己准备词表：filterWordsFile。', PANEL_NEEDS.file),
      row('floodEnabled', '刷屏治理', '短时间消息过多先警告、再禁言（默认关）。阈值就是下面四行（改完即时生效）。', PANEL_NEEDS.config),
      num('floodWindowSeconds', '刷屏·统计窗口', '「刷屏治理」在多长的窗口里数消息（默认 10 秒）。要先把上面「刷屏治理」打开。', '秒'),
      num('floodMaxMessages', '刷屏·窗口内条数', '同一个成员在一个窗口内超过这么多条就触发（默认 8 条）。', '条'),
      num('floodStrikeLimit', '刷屏·几次后禁言', '警告几次之后升级为禁言（默认 3 次）。', '次'),
      num('floodMuteSeconds', '刷屏·禁言时长', '升级为禁言时禁多久（默认 300 秒）。', '秒'),
      row('antiRecallEnabled', '防撤回', '缓存最近的入站消息，有人撤回时把内容重新发出来（默认关）。缓存大小与时效见 antiRecallCacheSize / antiRecallMaxAgeMinutes / antiRecallCooldownSeconds。', PANEL_NEEDS.config),
      row('keywordEnabled', '关键词回复', '**本地词表**命中就立刻回复（默认关）——不调模型、也不需要 @机器人。需要自己准备词表文件：keywordFile。', PANEL_NEEDS.file),
      row('leaveGroupEnabled', '允许 /退群', '允许管理员用 /退群 让机器人退出该群（默认关；执行前需要在群里二次确认）。', PANEL_NEEDS.admin),
    ],
  },
  {
    id: 'record',
    title: '记录与通知',
    advanced: true,
    rows: [
      row('traceEnabled', '轨迹 trace', '全链路追踪：每条入站消息有 traceId，每个决策（**包括每次静默丢弃**）都记 stage/ok/reason/耗时到 <cwd>/qq-trace.jsonl。控制台的实时事件流、体检、验收台全靠它——关掉后排查会瞎。级别与落盘见 traceLevel / traceFile。', PANEL_NEEDS.config),
      row('recordInbound', '入站录制', '把每个入站帧按可回放的形状记到 <cwd>/qq-inbox.jsonl。**控制台的离线回放依赖它**（关掉就没法重放历史消息）。'),
      row('historyArchiveEnabled', '历史归档', '把白名单消息归档到 <cwd>/qq-history/YYYY-MM-DD.jsonl，比轮转的 qq-inbox.jsonl 保留得久得多，/找 依赖它。注入/回放的帧不入档。'),
      row('historySearchEnabled', '历史检索', '/找 全文检索历史归档（读本地文件，不联网、不调模型）。', PANEL_NEEDS.npmodel),
      row('exportEnabled', '导出对话', '把一个会话的对话导出成文件（本地生成，方便备份或存档）。'),
      row('dailyReportEnabled', '每日日报', '每天把当天的统计推给指定会话（默认关）。**需要额外的两个前提**：打开"活跃统计"，并配好推送目标。', PANEL_NEEDS.config),
      row('broadcastEnabled', '定时播报', '按计划把内容发到指定群（默认关）。任务本身在配置/控制台的「定时任务」里维护，面板这里只是总开关。', PANEL_NEEDS.config),
      row('notifyEnabled', '推送通知', '把关键事件（掉线、异常、审批等）推送到指定目标（默认关）。需要先配好推送目标。', PANEL_NEEDS.config),
    ],
  },
  {
    /**
     * v0.7.0「实验性与扩展」：把**可能变动 / 需要自担风险**的开关集中在一组，
     * 默认折叠 + 标题写明 EXPERIMENTAL。第一条就是工具 provider 链。
     */
    id: 'experimental',
    title: '实验性（EXPERIMENTAL）',
    advanced: true,
    note: '这里的开关**默认全关**，行为可能在后续版本变动，出问题请带上 `/为什么` 的结果开 issue。'
      + '「扩展工具」打开后，同宿主里其它插件可以通过 `ctx.qqBridge.registerToolProvider()` 往每个会话注入**工具与提示段**——'
      + '提示段是**每条消息**都会进模型的成本，且外部扩展的行为不在本项目维护范围内（护栏只保证：只能新增、不能覆盖内置、抛错跳过并记 trace）。'
      + '「污点窗口」是**会挡住真实回复**的实验功能：打开后，群里有人贴"忽略之前所有指令"这类话，那个会话接下来一段时间里'
      + '**发文本 / 图片 / 文件 / 语音 / 撤回 / 贴表情一律不发**（问答照常跑完，只是出站被拦），每次拦截都写 trace。'
      + '默认关就是因为它会让人以为"机器人坏了"——要开请先想清楚。',
    rows: [
      row('extensionToolsEnabled', '扩展工具（第三方注入工具/提示段）', '允许同宿主的其它插件往每个会话注入 agent 工具与提示段（**实验性，默认关**）。打开后：外部工具只能**新增**、不能覆盖内置；provider 抛错就跳过并记 trace；注入内容全部写进 trace（谁贡献了什么、谁被跳过）。不开时第三方注册的 provider 完全不生效。'),
      /**
       * ★ v0.7.4 污点窗口（issue #4 作者的「防线二」）：开关 + 时长合成一行。
       *
       * 和「每分钟会话上限」一个套路 —— 开关是闸、数字是阈值，分开两行又要上下对照才知道谁管谁。
       * `numSwitch` 会把这两个键都展开进 `PANEL_FLAT_ROWS`，所以写入校验 /「待重启」判断都不用额外处理。
       */
      numSwitch('taintDryRunEnabled', '污点窗口 + 时长', '外部内容命中注入句式时，临时把这个会话的出站写动作降级为 dry-run（**实验性，默认关**）。右边是窗口时长。',
        'taintWindowMinutes', '窗口时长', '命中一次后在多久内继续拦截（默认 30 分钟，1–1440）。只在左边开关打开时生效。', '分钟'),
    ],
  },
  {
    id: 'advanced',
    title: '高级与调试',
    advanced: true,
    rows: [
      row('injectEnabled', '注入通道', '允许往桥里注入**假事件**并走真实管线（控制台的"注入场景库"用它做链路验证）。默认关。', PANEL_NEEDS.config),
      row('injectDryRun', '注入干跑', '注入的回合**一个出站帧都不发**（安全网，默认开）。验证链路时保持打开；关掉前请确认你知道会发生什么。'),
      row('actionAuditEnabled', '动作审计', '所有写操作记审计（谁、何时、什么动作、结果），便于事后追责与排查。'),
      row('autoHealEnabled', '掉线自愈', '宿主/桥异常时按脚本自动恢复（默认关）。需要自己提供自愈命令，并确认它真的能拉起进程。', PANEL_NEEDS.config),
      row('webhookEnabled', 'Webhook 接收', '给外部系统一个入口，把事件推进桥里（默认关）。需要外部调用方与配套的密钥配置。', PANEL_NEEDS.config),
      row('groupReadEnabled', '只读群信息', '/群信息、/精华 等只读查询：群号、人数、管理员、群公告与精华消息。走 NapCat 的只读接口，不改动群里任何东西。', PANEL_NEEDS.napcat),
      row('memberQueryEnabled', '成员查询', '/成员 列出群成员（昵称、群名片、角色、入群时间），只读，不会 @ 到任何人；成员很多的大群可能分批返回。', PANEL_NEEDS.napcat),
      row('friendListEnabled', '好友列表', '列出机器人账号的好友（默认关，只读）。这等于把机器人的社交关系摊开，按需再开。', PANEL_NEEDS.napcat),
      row('historyQueryEnabled', '历史消息查询', '按需拉取群/私聊的历史消息（只读），用于补上下文。', PANEL_NEEDS.napcat),
    ],
  },
  {
    /**
     * **数据与备份**（2026-10-31，用户："其实我设定的是一个工作区和记忆存储的地方，方便拿取和看"）。
     *
     * 为什么单独开一组、而且**不折叠**：这不是高级配置，是"我的聊天记录在哪"——
     * 找不到数据的人和"数据丢了"的人在界面上长得一模一样，唯一区别是他能不能看见这个路径。
     *
     * 为什么不给默认值：用户明确要求「第一次启动能选择根目录，没有创建默认的」。
     * 所以空着的语义是**"还没选"**，不是"用默认"。空着时桥仍然会在 cwd 下工作
     * （否则插件直接不可用），但会写一条 `stage=setup` 的警告、控制台也会显红条——
     * 让"没配"这件事**一直看得见**，而不是安静地变成"用了一个你没选过的目录"。
     */
    id: 'storage',
    title: '数据与备份',
    note: '她所有东西（记忆、聊天记录、收发文件、金丝雀）都在**这一个目录**下面，`qq-*` 前缀。'
      + '改这里 = 换一个目录存；**不会自动搬旧数据**——要搬就把旧的 `qq-*` 整个拷过去，'
      + '**包括 `qq-canary.json`**（重新生成金丝雀会让以前泄露出去的旧哨兵串再也认不出来）。'
      + '改完重启宿主生效；控制台「运行快照」里有一键「打开文件夹」。',
    rows: [
      text('dataDir', '数据根目录', '留空 = 还没选（会临时用 cwd，并在控制台显红条提醒）。'
        + '填**绝对路径**，例如 `C:\\Users\\你\\qq_chat`。别填相对路径：它随启动目录漂移，会让一半数据在 A 目录、一半在 B 目录。', {
        placeholder: 'C:\\Users\\你\\qq_chat',
        validate: normalizeDataDir,
      }),
    ],
  },
]

/**
 * 键 → 行描述（写入校验要知道这一行是布尔还是数值、范围多少）。
 *
 * ⚠️ 「开关 + 数值」那种合并行在**写配置**时仍是两个键（POST 一次只写一个），
 * 所以这里按**展开后的逐键描述**建表：合并行的开关记成 `type: 'boolean'`、
 * 内嵌数值记成 `type: 'number'`。别按 `PANEL_GROUPS.flatMap` 直接平铺——
 * 那样合并行的数值键会整个漏出白名单，界面上改数字会被 400 拒掉。
 */
function expandRow(entry) {
  if (entry.type === 'switchNumber' && entry.number) {
    return [{ ...entry, type: 'boolean' }, { ...entry.number, needs: entry.number.needs ?? '', type: 'number' }]
  }
  return [entry]
}
/** 面板允许改的键（白名单）：设置界面绝不变成"任意配置编辑器"。 */
export const PANEL_KEYS = PANEL_GROUPS.flatMap((group) => group.rows.flatMap((entry) => expandRow(entry).map((item) => item.key)))
export const PANEL_ROW_BY_KEY = new Map(PANEL_GROUPS.flatMap((group) => group.rows.flatMap((entry) => expandRow(entry).map((item) => [item.key, item]))))
/** 展开后的逐键行（测试用它数"到底几个开关几个数值"；合并行算两行）。 */
export const PANEL_FLAT_ROWS = [...PANEL_ROW_BY_KEY.values()]

/**
 * 这一行"现在是否不起作用"（v0.6.8 的 `dependsOn` 机制）。
 *
 * 两种方向都有，所以用 `dependsActive` 区分：
 *   - 默认（`dependsActive !== false`）：绑定的开关**关着**时失效。例：静默时段（`quietHours` ↔ `quietHoursEnabled`）；
 *   - `dependsActive: false`：绑定的开关**开着**时失效。例：两个白名单 ↔ `allowAllChats`（不设白名单）。
 */
export function rowInactive(entry, config = {}) {
  if (typeof entry.dependsOn !== 'string') return false
  const flag = config?.[entry.dependsOn] === true
  return entry.dependsActive === false ? flag : !flag
}

/**
 * 把生效配置整理成前端要的形状。
 * `defaults` 传 schema 的默认值（可选），仅在界面里做"非默认"提示用。
 * `fileValues` 传配置文件里的原始值（可选）：与生效值不一致 = 待重启。
 * `numberMeta` 传数值键的 `{ min, max, step, default }`（由 lib/index.js 从 schema 现读），
 * 数值行的范围**唯一来源**就是它——面板不抄第二份。
 */
/**
 * 「实验性」组的运行时状态行（v0.7.0）。
 *
 * 这是 issue #4 里 `chips`（provider 自己声明"工具在面板里的展示名与用途"）的**替代方案**：
 * 不再发明一套展示契约，而是如实显示**运行时事实**——出口挂没挂上（走哪条机制）、登记的 provider 有谁、
 * 最近一次注入注入了几个工具 / 跳过什么。数据来自运行中的桥（`bridge.extensionReport()`），
 * 拿不到（老宿主 / TUI / 面板被单独调用）就只给一行"开关状态"，不编造。
 */
export function extensionStatusLines(config = {}, extensions = null) {
  const enabled = config?.extensionToolsEnabled === true
  if (extensions === null || typeof extensions !== 'object') {
    return [enabled ? '扩展工具：已开启（运行时状态暂不可读）' : '扩展工具：未开启（默认关）']
  }
  const mount = extensions.mounted
  const mountText = mount === null || mount === undefined
    ? '出口：未挂载（宿主没有 ctx.provide/set，降级到模块注册表）'
    : mount.ok === true
      ? `出口：已挂载（via ${mount.via}）`
      : `出口：挂载失败（${mount.reason || '原因未知'}）`
  const providers = Array.isArray(extensions.providers) ? extensions.providers : []
  const lines = [
    mountText,
    `扩展工具：${enabled ? '已开启' : '未开启（默认关）'} · 已登记 provider：${providers.length === 0 ? '无' : providers.join('、')}`,
  ]
  /**
   * 用量计数（v0.7.0）：回答"到底有没有人在用这个 API"。
   * 全 0 时**整行不显示** —— 绝大多数人根本没用过出口，显示一串 0 只会让人怀疑
   * "你是不是在统计我 / 往哪儿上报"。数字出现时也必须一句话讲清它是**本机内存计数**。
   */
  const usage = extensions.usage
  if (usage && typeof usage === 'object') {
    const names = ['sendText', 'sendImage', 'sendFile', 'sendVoice', 'recall', 'react']
    const total = names.reduce((sum, name) => sum + (Number(usage[name]) || 0), 0)
    if (total > 0) {
      const parts = names.map((name) => `${name} ${Number(usage[name]) || 0}`)
      lines.push(`出口被调用（本机计数：只在内存里累加，不含消息内容、不外传、重启清零）：${parts.join(' · ')}`)
    }
  }
  const last = extensions.lastInjection
  if (last && typeof last === 'object') {
    const tools = Array.isArray(last.tools) ? last.tools : []
    const sections = Array.isArray(last.sections) ? last.sections : []
    const skipped = Number(last.skippedTotal) || 0
    lines.push(`最近一次注入（${last.chatKey ?? '?'}）：${tools.length} 个工具 / ${sections.length} 段提示`
      + (skipped > 0 ? ` · 跳过 ${skipped} 项：${(last.skipped ?? []).join('；')}` : ''))
  } else {
    lines.push('最近一次注入：还没有（provider 只在新建会话时注入）')
  }
  /**
   * v0.7.4 污点窗口：「现在有没有会话正被拦」必须一眼看到 ——
   * 这个功能的副作用就是"回复发不出去"，如果还要去翻 trace 才知道，用户只会以为机器人坏了。
   */
  const taint = extensions.taint
  if (taint && typeof taint === 'object') {
    const active = Array.isArray(taint.active) ? taint.active : []
    if (taint.enabled !== true) {
      // 关着时不刷屏：只在这组本来就显示状态时给一句，说明它没生效。
      lines.push(`污点窗口：未开启（默认关）· 窗口时长 ${Number(taint.windowMinutes) || 30} 分钟`)
    } else if (active.length === 0) {
      lines.push(`污点窗口：已开启（${Number(taint.windowMinutes) || 30} 分钟）· 当前没有会话在窗口内`)
    } else {
      const detail = active.slice(0, 3).map((item) => `${item.chatKey}（剩 ${Math.max(1, Math.ceil((Number(item.remainingMs) || 0) / 60_000))} 分钟）`).join('、')
      lines.push(`⚠️ 污点窗口：${active.length} 个会话正在被拦 —— ${detail}${active.length > 3 ? ' …' : ''}；这些会话的出站写动作不会发到 QQ`)
    }
  }
  return lines
}

export function panelSnapshot(config = {}, { defaults = {}, fileValues = null, numberMeta = {}, extensions = null } = {}) {
  const groups = PANEL_GROUPS.map((group) => ({
    id: group.id,
    title: group.title,
    advanced: group.advanced === true,
    // 组级提示（例如"这一组的能力插件不自带"）——原样带给界面。
    note: group.note ?? '',
    // 组级**运行时状态**（v0.7.0）：目前只有「实验性」组用，显示出口挂载/provider/最近一次注入。
    status: group.id === 'experimental' ? extensionStatusLines(config, extensions) : [],
    rows: group.rows.map((entry) => {
      const value = config?.[entry.key]
      const fromFile = fileValues && Object.hasOwn(fileValues, entry.key) ? fileValues[entry.key] : null
      const hasDefault = Object.hasOwn(defaults, entry.key)
      const base = { key: entry.key, label: entry.label, hint: entry.hint, needs: entry.needs ?? '', type: entry.type ?? 'boolean' }
      /**
       * 组内**小节标题**（v0.7.8）：整组十来个开关时，一行行看下来不知道哪几行是一伙的。
       * `sub` 是"从这一行开始换小节"——界面在这一行前面插一条小标题，值相同的连续行只插一次。
       * ⚠️ 只做展示，不参与分组/写入，所以白名单、展开、待重启判断全都不用改。
       */
      if (typeof entry.sub === 'string' && entry.sub !== '') base.sub = entry.sub
      /** 合并行：开关用一个键、数值用另一个键，两边各自判"默认/待重启"，一起带给前端。 */
      if (base.type === 'switchNumber') {
        const num = entry.number ?? {}
        const numValue = config?.[num.key]
        const numFromFile = fileValues && Object.hasOwn(fileValues, num.key) ? fileValues[num.key] : null
        const numMeta = numberMeta?.[num.key] ?? {}
        const numCurrent = Number(numValue)
        const numOk = Number.isFinite(numCurrent) ? numCurrent : (Number.isFinite(Number(numMeta.default)) ? Number(numMeta.default) : 0)
        const numFile = numFromFile === null ? null : Number(numFromFile)
        return {
          ...base,
          value: value === true,
          defaultValue: hasDefault ? defaults[entry.key] === true : null,
          nonDefault: hasDefault ? value !== defaults[entry.key] : false,
          fileValue: fromFile === null ? null : fromFile === true,
          pending: fromFile === null ? false : fromFile !== (value === true),
          number: {
            key: num.key,
            label: num.label,
            hint: num.hint,
            unit: num.unit ?? '',
            value: numOk,
            min: metaNumberOrNull(numMeta.min),
            max: metaNumberOrNull(numMeta.max),
            step: Number.isFinite(Number(numMeta.step)) && Number(numMeta.step) > 0 ? Number(numMeta.step) : 1,
            defaultValue: Object.hasOwn(defaults, num.key) ? Number(defaults[num.key]) : null,
            nonDefault: Object.hasOwn(defaults, num.key) ? numOk !== Number(defaults[num.key]) : false,
            fileValue: numFile !== null && Number.isFinite(numFile) ? numFile : null,
            pending: numFile !== null && Number.isFinite(numFile) ? numFile !== numOk : false,
          },
        }
      }
      if (base.type === 'number') {
        const meta = numberMeta?.[entry.key] ?? {}
        const current = Number(value)
        const currentOk = Number.isFinite(current) ? current : (Number.isFinite(Number(meta.default)) ? Number(meta.default) : 0)
        const fileNumber = fromFile === null ? null : Number(fromFile)
        return {
          ...base,
          value: currentOk,
          unit: entry.unit ?? '',
          /**
           * ⚠️ `Number(null) === 0`：schema 没写 `min()`/`max()` 时 meta 里是 `null`，
           * 直接 `Number.isFinite(Number(meta.min))` 会把它变成 **0**，于是界面把这一行夹死在 [0,0]、
           * 服务端也会拒掉任何非 0 的值（`botQq` 就是第一个撞上的键）。这里显式把 null 当"没有范围"。
           */
          min: metaNumberOrNull(meta.min),
          max: metaNumberOrNull(meta.max),
          step: Number.isFinite(Number(meta.step)) && Number(meta.step) > 0 ? Number(meta.step) : 1,
          // 「不是阈值、是标识」的数值行（`botQq`）不画 ± 按钮，见那行的注释。
          noStepper: entry.noStepper === true,
          defaultValue: hasDefault ? Number(defaults[entry.key]) : null,
          nonDefault: hasDefault ? currentOk !== Number(defaults[entry.key]) : false,
          fileValue: fileNumber !== null && Number.isFinite(fileNumber) ? fileNumber : null,
          pending: fileNumber !== null && Number.isFinite(fileNumber) ? fileNumber !== currentOk : false,
        }
      }
      /** 时段列表（v0.6.8）：值是一串 `H:MM-H:MM`；"待重启"按整串比较（顺序也算不同）。 */
      if (base.type === 'times') {
        const def = Array.isArray(defaults[entry.key]) ? defaults[entry.key].map(String) : null
        // 生效配置里没这个键时（宿主总会补默认值，这里是防御）回落 schema 默认，而不是显示成空。
        const list = Array.isArray(value) ? value.map(String) : (def ?? [])
        const fileList = Array.isArray(fromFile) ? fromFile.map(String) : null
        /**
         * `dependsOn`（v0.6.8）：绑定它的开关关着时，这些时段**不会生效**——把状态带给界面，
         * 免得用户"设了时段却还在回复"（2026-10-20 真机就是这么踩的：开关是另一个键）。
         */
        const switchOff = rowInactive(entry, config)
        return {
          ...base,
          value: list,
          maxRanges: QUIET_MAX_RANGES,
          inactive: switchOff,
          inactiveReason: switchOff ? `上面「${entry.switchLabel ?? entry.dependsOn}」的开关是关的 —— 这些时段现在不起作用` : '',
          defaultValue: def,
          nonDefault: def === null ? false : JSON.stringify(list) !== JSON.stringify(def),
          fileValue: fileList,
          pending: fileList === null ? false : JSON.stringify(fileList) !== JSON.stringify(list),
        }
      }
      /**
       * 号码列表（v0.6.8，白名单）：值是**数字**数组（schema 就是 `z.array(z.number())`，
       * OneBot 那边 `user_id` 也是数字），这里不做字符串化——否则写回去的类型就不对了。
       */
      if (base.type === 'list') {
        const def = Array.isArray(defaults[entry.key]) ? defaults[entry.key] : null
        const current = Array.isArray(value) ? value : (def ?? [])
        const fileList = Array.isArray(fromFile) ? fromFile : null
        // 白名单两个名单的 `dependsOn: 'allowAllChats'`（开关**打开**时名单失效）——见 `rowInactive`。
        const inactive = rowInactive(entry, config)
        return {
          ...base,
          value: current,
          maxItems: LIST_MAX_ITEMS,
          inactive,
          inactiveReason: inactive ? `上面「${entry.switchLabel ?? entry.dependsOn}」开着 —— 这个名单现在不起作用` : '',
          defaultValue: def,
          nonDefault: def === null ? false : JSON.stringify(current) !== JSON.stringify(def),
          fileValue: fileList,
          pending: fileList === null ? false : JSON.stringify(fileList) !== JSON.stringify(current),
        }
      }
      /**
       * 下拉选择（v0.7.8）：值是**字符串枚举**（`outboundRedactMode`）。
       *
       * ⚠️ 生效值可能**不在 options 里**（手改配置写错，或上游加了新档而面板没跟上）。
       * 这时绝不能静默回落到第一项——那会把 `block` 显示成 `off`，是**最危险的方向**
       * （界面说"没防护"、实际是全拦，或者反过来）。做法：原样带出去 + `unknownValue` 标记，
       * 界面显示"面板不认识的值：xxx"。
       */
      if (base.type === 'select') {
        const options = Array.isArray(entry.options) ? entry.options : []
        const allowed = options.map((item) => item.value)
        let raw = typeof value === 'string' ? value : ''
        /**
         * 生效值读成空串、而 schema 有字符串默认值时，用默认值。
         * 空串对这个控件**永远不是合法档位**（五档都是非空字符串），所以这里回落到默认
         * 不会掩盖任何真实取值；反过来若回落到第一项（`off`）就危险了——那会把实际在
         * `block` 上的档位显示成"完全关闭"。未知的**非空**值仍然如实标出来。
         */
        if (raw === '' && hasDefault && typeof defaults[entry.key] === 'string') raw = defaults[entry.key]
        return {
          ...base,
          value: raw,
          unknownValue: allowed.includes(raw) !== true,
          options,
          defaultValue: hasDefault ? defaults[entry.key] : null,
          nonDefault: hasDefault ? raw !== defaults[entry.key] : false,
          fileValue: fromFile === null ? null : String(fromFile),
          pending: fromFile === null ? false : String(fromFile) !== raw,
        }
      }
      /**
       * 单行文本（v0.7.8）：金丝雀这种"自由填但按规矩校验"的键。
       * 空串是**合法值**（语义 = 让我自动生成），所以这里不做"空就回落默认"——
       * 那会让用户想清空哨兵串时，界面自己又给填回去，看着像按钮坏了。
       */
      if (base.type === 'text') {
        const raw = typeof value === 'string'
          ? value
          : (fromFile !== null && typeof fromFile === 'string' ? fromFile : '')
        return {
          ...base,
          value: raw,
          placeholder: entry.placeholder ?? '',
          maxLen: Number.isFinite(Number(entry.maxLen)) ? Number(entry.maxLen) : 64,
          defaultValue: hasDefault ? defaults[entry.key] : null,
          nonDefault: hasDefault ? raw !== defaults[entry.key] : false,
          fileValue: fromFile === null ? null : String(fromFile),
          pending: fromFile === null ? false : String(fromFile) !== raw,
        }
      }
      return {
        ...base,
        value: value === true,
        // `nonDefault` 只说"与默认值不同"——**方向**必须一起给：否则用户看到「非默认」会以为"关着"，
        // 而真机上多数情况其实是"默认关、我把它打开了"（用户原话："正常来讲非默认不是关着的吗？"）。
        defaultValue: hasDefault ? defaults[entry.key] === true : null,
        nonDefault: hasDefault ? value !== defaults[entry.key] : false,
        fileValue: fromFile === null ? null : fromFile === true,
        pending: fromFile === null ? false : fromFile !== (value === true),
      }
    }),
  }))
  return { ok: true, version: 1, groups }
}

// ── 文本层：行尾与末尾换行必须原样保留（Windows 上 patch 常是 CRLF，改动后混排会很难看）──

/** 行尾风格：出现 CRLF 就按 CRLF 写回。 */
function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/** 拆行：同时记住行尾与"末尾有没有换行"。 */
function splitLines(text) {
  const eol = detectEol(text)
  const trailing = text.endsWith('\n')
  const body = trailing ? text.slice(0, -1) : text
  return { eol, trailing, lines: body.split(eol).map((line) => line.replace(/\r$/, '')) }
}

/** 拼回：行尾与末尾换行按拆行时的信息还原。 */
function joinLines(meta, lines) {
  return lines.join(meta.eol) + (meta.trailing ? meta.eol : '')
}

/**
 * 从 profile 的 patch 文本里读出本插件条目上某个键的原始值；没有则 null。
 *
 * v0.6.7 起也认**数值**（`chatTurnsPerMinute: 5`）：面板的数值控件要靠它判"待重启"。
 * v0.6.8 起也认**流式数组**（`quietHours: ["9:00-12:00","14:00-18:00"]`，也就是我们自己写出去的形状）。
 * 只认这几种字面量——引号包住的标量、`null`、块序列（`- 9:00-12:00` 那种多行写法）、表达式
 * 一律当"读不出"，绝不猜（调用方会把它显示成"未知/待重启"而不是编一个值）。
 */
export function readPatchValue(yamlText, key, pluginId = 'dsh-qq-onebot-bridge', options = {}) {
  const block = pluginBlock(yamlText, pluginId)
  if (!block || !block.childIndent) return null
  const line = block.lines.find((entry) => keyLine(entry.text, key, block.childIndent))
  if (!line) return null
  const raw = line.text.slice(line.text.indexOf(':') + 1).trim()
  const bare = raw.replace(/\s+#.*$/, '')
  /**
   * v0.7.8：**字符串行**（下拉/文本）走另一条口径。
   *
   * 别的行"引号包住就读不出"是对的：`chatTurnsPerMinute: "7"` 在 YAML 里是字符串，
   * 而那个键 schema 要数字——把 `"7"` 显示成 7 会让人以为已生效。
   * 但下拉/文本的 schema **就是字符串**，这时候读不出反而会让"更新中"永远判不出来
   * （面板上刚写完的值看起来像没写进去）。所以由调用方按行类型声明 `asString`。
   */
  if (options.asString === true) {
    if (/^'.*'$/.test(bare)) return bare.slice(1, -1).replace(/''/g, "'")
    if (/^".*"$/.test(bare)) return bare.slice(1, -1)
    if (bare === '' || bare === '~' || bare === 'null') return ''
    return bare
  }
  // 流式数组：只认**我们自己写出去的**那种（JSON 也合法 YAML）。
  if (bare.startsWith('[')) {
    try {
      const parsed = JSON.parse(bare)
      // **保留元素类型**：时段是字符串、白名单是数字——统一 map(String) 会让白名单的"更新中"永远判不出来。
      return Array.isArray(parsed) ? parsed : null
    } catch { return null }
  }
  // 引号包住的一律当"读不出"：`"7"` 在 YAML 里是**字符串**，而这几项 schema 是数字——
  // 把它显示成 7 会让人以为已经生效，实际宿主会校验失败。宁可显示"未知/待重启"。
  if (/^['"]/.test(bare)) return null
  if (bare === 'true') return true
  if (bare === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/.test(bare)) return Number(bare)
  return null
}

/**
 * 把**字符串**渲染成合法的 YAML 标量（v0.7.8）。
 *
 * 三条：
 *   ① 空串必须写成 `''`——直接留空在 YAML 里是 `null`，宿主会拿 null 去跑引擎；
 *   ② 能裸写就裸写（`decoy`、`cny-3f2a9b7c11`）：与文件里既有写法一致，人读起来也干净；
 *   ③ 其余一律单引号 + 把 `'` 双写（YAML 的转义规则），**不用双引号**——双引号里 `\\uXXXX`
 *      会被解释成字符，而哨兵串/枚举值虽然当前都过不了 `[A-Za-z0-9._-]`，也不该留这个坑。
 */
function renderScalar(value) {
  if (value === '') return "''"
  const reserved = /^(true|false|null|~|yes|no|on|off)$/i.test(value)
  const numeric = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(value)
  if (/^[A-Za-z0-9._-]+$/.test(value) && !reserved && !numeric) return value
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * 在 patch 文本里 upsert 一个键（只动本插件条目）。
 * 返回 `{ ok, yaml, changed, reason }`——失败时 `yaml` 原样返回，调用方据此拒绝写入。
 *
 * 三条"不许猜"的规矩（都是对抗性审查用可复现用例逼出来的）：
 *   ① **缩进从文件里量**，不假设 `config` 的子键就是"父缩进 + 2"——用 `yaml.stringify(…, {indent:4})`
 *      产出的 4 空格 patch 是合法的，硬编码 +2 会把它改成非法 YAML，宿主下次启动直接拒载；
 *   ② **键必须正好在 config 的直接子层**（缩进 === childIndent）——否则多行字符串（`|` 块）里
 *      恰好长得像 `key: value` 的那一行会被当成真键，进而写出重复键或错误缩进；
 *   ③ **CRLF / 末尾换行原样保留**，比较时忽略行尾——否则"已经是这个值"永远判不出来，每点一次都重写。
 */
export function upsertPatchValue(yamlText, key, value, { pluginId = 'dsh-qq-onebot-bridge', note = '' } = {}) {
  // v0.6.7：布尔开关之外再接受**整数**（数值型风控阈值）。浮点数一律拒绝——
  // 这些键在 schema 里都是 `step(1)`，写个 3.5 进去宿主启动会校验失败。
  /**
   * v0.7.8：再接受**字符串**（`outboundRedactMode` 的枚举档位、`outboundRedactCanary` 的哨兵串）。
   *
   * 这条以前不存在，导致两个新控件"前端能选、后端一律拒"——写入被这一行挡在门外，
   * 报的还是「只接受布尔开关（true/false）、整数或数组」，跟用户点的东西完全对不上。
   * 是**先写了正路测试**才暴露出来的（只写"坏值被拒"的反向断言会漏掉它：
   * 坏值被拒的原因恰好也是这一行，看起来一切正常）。
   */
  const isNumber = typeof value === 'number'
  const isList = Array.isArray(value)
  const isString = typeof value === 'string'
  if (!isNumber && !isList && !isString && typeof value !== 'boolean') {
    return { ok: false, yaml: yamlText, changed: false, reason: '只接受布尔开关（true/false）、整数、字符串或数组' }
  }
  if (isNumber && !Number.isInteger(value)) return { ok: false, yaml: yamlText, changed: false, reason: '只接受整数（这几项阈值都是整数值）' }
  if (isList) {
    // 数组两种：纯字符串（静默时段）或纯正整数（白名单的 QQ 号/群号）；混着来一律拒。
    const allStrings = value.every((item) => typeof item === 'string')
    const allNumbers = value.every((item) => typeof item === 'number' && Number.isInteger(item) && item > 0)
    if (!allStrings && !allNumbers) {
      return { ok: false, yaml: yamlText, changed: false, reason: '数组要么全是字符串（时段），要么全是正整数（QQ 号/群号）' }
    }
  }
  const text = String(yamlText ?? '')
  const rendered = isList ? JSON.stringify(value)
    : isNumber ? String(value)
      : isString ? renderScalar(value)
        : (value ? 'true' : 'false')
  /**
   * ★ v0.6.8 真机修复：插件装在 profile 里**不一定在 patch 层有自己条目**。
   *
   * 现在推荐（也是本机实际用法）是把包名放进 `package.json` 的 `dsh.profile.bundles`，
   * 由**包自带的 bundle 层**（本仓库根目录 `cordis.patch.yml` 里的 `- insert:`）挂载；
   * 那种情况下 profile 的 `cordis.patch.yml` 里压根没有 `- id: dsh-qq-onebot-bridge`，
   * 原来这里直接报"没有该条目（先把它装进该 profile）"——用户点任何开关都是这句红字。
   *
   * patch 文件本来就是"按 id 覆盖/追加条目"的地方（同一份文件里 mnemon 就是这么写的），
   * 所以正确做法是**没有条目就追加一条**（`- id: … / name: … / config:`），而不是拒绝。
   */
  const block = text.trim() === '' ? null : pluginBlock(text, pluginId)
  if (!block) return appendConfigEntry(text, pluginId, key, rendered)
  if (!block.configIndent) return insertConfigBlock(text, pluginId, block, key, rendered)
  if (!block.childIndent) {
    return {
      ok: false,
      yaml: text,
      changed: false,
      reason: block.sequenceChild
        ? `${pluginId} 的 config 块第一层是列表，量不出映射子键的缩进——宁可不写，也不产出宿主解析不了的 YAML`
        : `${pluginId} 的 config 块读不出子键缩进，为安全起见不写`,
    }
  }

  const meta = splitLines(text)
  const lines = meta.lines
  const existing = block.lines.find((entry) => keyLine(entry.text, key, block.childIndent))
  // 数组写成 YAML 的**流式序列**（`["a","b"]`，JSON 也是合法 YAML）：一行写完，行扫描不会被打乱。
  const next = `${block.childIndent}${key}: ${rendered}`

  if (existing) {
    if (existing.text.trimEnd() === next) return { ok: true, yaml: text, changed: false, reason: '已经是这个值' }
    /**
     * ★ v0.6.8：老键可能是**块写法**（`quietHours:` 换行后缩进的 `- 9:00-12:00`）。
     * 只换第一行会把下面那几行留在原地 ⇒ 同一个键两处定义、YAML 直接坏掉。
     * 所以把"该键的续行"（比子键缩进更深、或夹在其中的空行）一起换成这一行流式写法。
     */
    let removeEnd = existing.index + 1
    for (let scan = existing.index + 1; scan < lines.length; scan += 1) {
      if (lines[scan].trim() === '') continue          // 空行先跨过去，后面还有续行就一起删
      const indent = /^(\s*)/.exec(lines[scan])[1]
      if (indent.length > block.childIndent.length) { removeEnd = scan + 1; continue }
      break
    }
    lines.splice(existing.index, removeEnd - existing.index, next)
    return { ok: true, yaml: joinLines(meta, lines), changed: true, reason: '' }
  }
  // 新键插在 config 块**末尾**（下一条同缩进的内容之前），保留块内的注释与顺序。
  const insert = note ? [`${block.childIndent}# ${note}`, next] : [next]
  lines.splice(block.configEnd, 0, ...insert)
  return { ok: true, yaml: joinLines(meta, lines), changed: true, reason: '' }
}

/**
 * 这份 patch 里**没有本插件条目**时：按 patch 的口径**追加一条**（`- id / name / config`）。
 *
 * 依据（本机真机 2026-10-19）：插件可以作为 `dsh.profile.bundles` 的成员挂载，真正的挂载声明在
 * **包自带的 bundle 层**（本仓库根目录 `cordis.patch.yml` 的 `- insert:`），profile 的 patch 里
 * 可以一条都没有。而 profile patch 的用途正是"按 id 覆盖/追加条目"——同一份文件里 mnemon 就是
 * 这样写的。所以这里追加而不是报错。
 *
 * 只动**末尾**：已有条目、注释、顺序全部原样保留。
 */
function appendConfigEntry(text, pluginId, key, rendered) {
  const eol = detectEol(text)
  const entryText = [
    `- id: ${pluginId}`,
    `  name: ${pluginId}`,
    '  config:',
    `    ${key}: ${rendered}`,
  ].join(eol)
  const contentLines = text.split(/\r?\n/).filter((line) => line.trim() !== '' && !/^\s*#/.test(line))
  // 空文件 / 只有注释 / 空的 `[]` ⇒ 直接写成一个数组（注释留在前面，YAML 允许）。
  if (contentLines.length === 0 || (contentLines.length === 1 && contentLines[0].trim() === '[]')) {
    const head = text.replace(/\r?\n?\s*\[\]\s*$/, '').replace(/\s+$/, '')
    return { ok: true, yaml: (head === '' ? entryText : `${head}${eol}${entryText}`) + eol, changed: true, reason: '' }
  }
  // 顶层必须是"条目数组"：第一行内容不是 `- ...` 就不敢乱塞（可能是 `plugins:` 映射写法）。
  if (!/^\s*-/.test(contentLines[0])) {
    return {
      ok: false,
      yaml: text,
      changed: false,
      reason: `这份 patch 不是条目数组（第一行内容不是 - id: 开头的列表项），不敢往里加 ${pluginId} 条目；请手动加一条`,
    }
  }
  const base = text.endsWith('\n') || text.endsWith('\r') ? text : text + eol
  return { ok: true, yaml: base + entryText + eol, changed: true, reason: '' }
}

/** 条目存在但没有 `config:` 块：在 id 行后面补一个（缩进按条目自身推）。 */
function insertConfigBlock(text, pluginId, block, key, rendered) {
  const meta = splitLines(text)
  const lines = meta.lines
  const entryIndent = /^(\s*)/.exec(lines[block.start] ?? '')[1]
  const childIndent = `${entryIndent}  `
  lines.splice(block.start + 1, 0, `${childIndent}config:`, `${childIndent}  ${key}: ${rendered}`)
  return { ok: true, yaml: joinLines(meta, lines), changed: true, reason: '' }
}

/** 这一行是不是"正好在 childIndent 这一层"的 `key:`（注释行、多行字符串内容、更深层都不算）。 */
function keyLine(text, key, childIndent) {
  if (/^\s*#/.test(text)) return false
  const indent = /^(\s*)/.exec(text)[1]
  if (indent !== childIndent) return false
  return new RegExp(`^${childIndent}${key}\\s*:`).test(text)
}

/**
 * 定位本插件条目：`- id: <pluginId>` → 它下面的 `config:` → 子键缩进与结束位置。
 * 纯行扫描（不解析 YAML），因此能原样保留注释与排版。
 *
 * 同名条目有多条时取**最后一条**：DSH 自己（dsh-plugin-manager）也是 `findLast`，
 * 面板必须和平台改同一条，否则会出现"点了没反应"（平台生效的是后一条）。
 */
function pluginBlock(yamlText, pluginId) {
  const { lines } = splitLines(String(yamlText ?? ''))
  // id 允许加引号、也允许行尾注释——不然一个合法的 patch 会被误报成"没有这个条目"。
  const entryRe = new RegExp(`^(\\s*)-\\s+id:\\s*["']?${pluginId}["']?\\s*(?:#.*)?$`)
  let start = -1
  let entryIndent = ''
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = entryRe.exec(lines[index])
    if (match) { start = index; entryIndent = match[1]; break }
  }
  if (start === -1) return null

  // 条目的范围：到下一个同缩进的 `- ` 或文件末尾。
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (new RegExp(`^${entryIndent}-\\s`).test(lines[index])) { end = index; break }
  }
  const entryLines = []
  for (let index = start; index < end; index += 1) entryLines.push({ index, text: lines[index] })

  // config 块：条目内的 `config:` 行（值必须为空，带内容的 config 不是块）。
  const configLine = entryLines.find((entry) => /^\s*config\s*:\s*$/.test(entry.text))
  if (!configLine) return { start, end, lines: entryLines, configIndent: '', childIndent: '', configEnd: end }
  const parentIndent = /^(\s*)/.exec(configLine.text)[1]

  // 子键缩进**从文件里量**：config 之后第一行"比父缩进深"的内容行（跳过空行与注释）。
  let childIndent = ''
  let configEnd = end
  let sequenceChild = false
  for (let index = configLine.index + 1; index < end; index += 1) {
    const text = lines[index]
    if (text.trim() === '' || /^\s*#/.test(text)) continue
    const indent = /^(\s*)/.exec(text)[1]
    if (indent.length <= parentIndent.length) { configEnd = index; break }
    if (childIndent === '') {
      // 第一层就是序列项（`- 10001`）时**量不出映射子键的缩进**：宁可不写，
      // 也不能把 `key:` 写在序列缩进上（js-yaml 会判 bad indentation，宿主启动直接拒载）。
      if (/^\s*-\s/.test(text)) { sequenceChild = true; break }
      childIndent = indent
    }
  }
  if (sequenceChild) return { start, end, lines: entryLines, configIndent: `${parentIndent}  `, childIndent: '', configEnd, sequenceChild: true }
  // config 是空的（后面没有更深的内容行）：只能按 YAML 的 2 空格惯例给一个，且仅在此时才猜。
  if (childIndent === '') childIndent = `${parentIndent}  `
  return { start, end, lines: entryLines, configIndent: `${parentIndent}  `, childIndent, configEnd }
}

/** 面板返回给前端的"这批开关需要重启吗"说明（不猜：由 pending 徽标逐行显示）。 */
export const PANEL_NOTES = {
  apply: '写入 profile 的 cordis.patch.yml 后会触发 DSH 热重载该插件条目（QQ 桥会短暂重连一下），随后新开关生效；若宿主没开热重载，重启宿主后生效。写入是原子的（先写临时文件再改名），并留一份 .bak-qqai 备份。',
  scope: '这里只放了常用的功能开关；其余配置仍可直接改 profile 的 cordis.patch.yml。',
}

/** `git+https://github.com/me/repo.git` → `https://github.com/me/repo`（面板要的是能点的链接）。 */
export function normalizeRepoUrl(url) {
  const raw = String(url ?? '').trim()
  if (raw === '') return ''
  return raw.replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/+$/, '')
}

/**
 * 面板的「相关链接」一组（客户端把它渲染在**标题正下方、开关分组之前**）。
 *
 * 顺序（用户 2026-10-04 连着**七条**指示才定稿，其中两条是"改回去／再挪"）：
 *   "应该把账号登陆调到最上方" → "不对不对应该在QQ助手的下边" →
 *   "**还是挪回到之前的位置吧，直接把相关链接整体拉到最上边**" →
 *   "**再把调试台和更新日志换一下位置**" → "更新日志改到相关链接的最底下" →
 *   "嗯，还是把更新日志位置改回去吧" → "**调试台改到调试文档下方**"。
 *   ① **QQ助手账号**（机器人账号的登录/扫码；没登录时下面几项都没意义，所以永远第一）
 *   ② 更新日志  ③ 调试文档  ④ **调试台**（最底下）
 * ⇒ 结论：账号入口**永远第一**（它留在数组头上的字面量里），**「调试台」永远最后**
 *   （`panelFooterLinksWithConsole` 会按 id 找到它再加"运行中/未启动"状态，顺序不受影响）。
 *   别再把它拆成独立一段，也别再改这四条的先后。
 *
 * 目标全部由真实来源推导（版本/仓库来自 package.json，端口来自控制台的 qq-control.json），不写死地址；
 * 控制台 token **故意不进面板**（它是本机密钥），所以只给根地址 + 一句"怎么拿到带 token 的地址"。
 * 账号入口指向宿主自己的 `/qqai/account`：服务端读 NapCat 的 token 后 302，token 同样**不进面板载荷**。
 */
export function panelFooterLinks({ version = '', repoUrl = '', consolePort = 8880, accountUrl = 'http://127.0.0.1:13000/' } = {}) {
  const repo = normalizeRepoUrl(repoUrl)
  const links = [{
    id: 'account',
    label: '机器人账号（Waylay 控制台）',
    /**
     * ★ 2026-10-30：后端从 NapCat 换成 Waylay（注入进 QQ.exe，没有独立进程）。
     * 这条链接原来指向 `/qqai/account` → NapCat 的 6099 WebUI（带 token）；
     * 6099 现在**根本不监听**，点开只会看到"连不上"。改为指向 Waylay 的 13000 裸 HTTP 控制台
     * —— 它不需要 token，所以也不再需要服务端帮忙拼地址。
     * 提示语保留「需要先运行」这层：没起来时点开就是一个打不开的页面。
     */
    hint: '扫码 / 登录状态 / 收发诊断都在 Waylay 的 13000 控制台；**需要先运行 Waylay**（没起来就点上面的「启动 Waylay」）',
    href: accountUrl,
  }]
  if (repo !== '') {
    links.push({
      id: 'changelog',
      label: version ? `更新日志（v${version}）` : '更新日志',
      hint: '每个版本的改动、修掉的缺陷与测试计数',
      href: `${repo}/blob/main/CHANGELOG.md`,
    })
    links.push({
      id: 'readme-debug',
      label: '调试文档',
      /**
       * v0.7.2：这一大段从 README 搬到了 `docs/DEBUG.md`（用户："太占 README 了"），
       * 所以链接跟着改指向文件本身 —— 原来的 `#调试…` 锚点已经不存在了。
       */
      hint: 'trace / 回放 / 体检 / 注入的完整用法（docs/DEBUG.md）',
      href: `${repo}/blob/main/docs/DEBUG.md`,
    })
  }
  /**
   * v0.7.11「她的对话」：**只读**记忆，看她在 QQ 里说了什么。
   *
   * 位置刻意放在调试台**上面**：它是日常会点的，调试台是出事才点的。
   * 更重要的理由在下面这条 —— 以前想看她的对话只能回 dsh 网页点开那个会话，
   * 那一下就拿走了写句柄；这个页面读的是桥自己写的 `qq-memory`，不碰锁。
   */
  links.push({
    id: 'chatlog',
    label: '她的对话（只读）',
    hint: '看她在 QQ 里跟谁说了什么 · 读的是记忆文件，**不会**抢走她会话的写锁',
    href: '/qqai/chatlog',
  })
  // 调试台压在最底下（用户 2026-10-04："调试台改到调试文档下方"）——没有仓库信息时它也是最后一条。
  links.push({
    id: 'console',
    label: '调试台（独立控制台）',
    hint: `实时事件流 · trace 检索 · 体检 · 诊断包 · 离线回放 · 注入；本机 127.0.0.1:${consolePort}`,
    href: `http://127.0.0.1:${consolePort}/`,
  })
  return links
}

/**
 * 「相关链接」组 + **调试台的真实状态**。
 * 为什么要状态：调试台是**独立进程**（`control/`，v0.8.0 起默认 8880，不依赖 dsh）。
 * 第一版只给了一个裸链接，用户点进去只看到连不上、还不知道为什么；
 * v0.6.4 起**点这个链接会顺手把它拉起来**（见 `consoleEntry`），
 * 所以这里只负责如实标出"运行中 / 未启动（点一下会自动拉起）"。
 * `href` 仍指宿主的 `/qqai/console` 入口：它 302 到独立控制台（带 token），
 * 桌面端的 `?format=json` 绝对地址流程也照旧可用（v0.8.0 起落点是 8880 独立进程）。
 */
export function panelFooterLinksWithConsole({
  version = '', repoUrl = '', consolePort = 8880, consoleRunning = false, startCommand = '',
  accountUrl = 'http://127.0.0.1:13000/',
} = {}) {
  const links = panelFooterLinks({ version, repoUrl, consolePort, accountUrl })
  const consoleLink = links.find((link) => link.id === 'console')
  if (consoleLink) {
    consoleLink.href = '/qqai/console'
    consoleLink.running = consoleRunning === true
    consoleLink.state = consoleRunning === true
      ? `运行中 · 独立进程（127.0.0.1:${consolePort}，不依赖 dsh；点开自动带上 token）`
      : '未启动 · 点一下会自动拉起'
    consoleLink.hint = consoleRunning === true
      ? `实时事件流 · trace 检索 · 体检 · 诊断包 · 离线回放 · 注入（独立进程 127.0.0.1:${consolePort}，dsh 关了它也还在）`
      : `没在运行时点这个链接会自动把它拉起来（本机 node 进程，不用提权；手动命令仍是 ${startCommand || 'node control/bin/qq-control.mjs'}）`
  }
  return links
}
