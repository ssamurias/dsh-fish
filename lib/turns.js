/**
 * turns.js —— 侧栏里直接跟她说话，也算一轮（issue #6，2026-10-28）
 *
 * 症状（github:ssamurias/dsh-fish#6）：
 *   在侧栏她的会话里直接打字聊天，【turns】永远不动，`chat.rotateAfter`
 *   因此永不触发——上下文一路涨到撑爆，而"聊满 N 轮换会话"这个约定形同虚设。
 *
 * 根因：`bumpTurns()` 只有一个调用点，在 `/say` 路由里（lib/say.js）。
 *       那条路是"观测台/IM 替主人递话"；用户在侧栏亲自打的字根本不经过它。
 *
 * 做法：不新开通道，只补一个**观察者**——监听宿主 `session/event`，认准
 *       "她住的那个会话"，收到一条真人打的 user 消息就记下来，等这一轮
 *       `turn/end` 再结账：
 *         1. turns + 1（home.json，观测台读的就是它）
 *         2. talkmem 记一轮原话（换会话时搬过去的那几句）
 *         3. 到 rotateAfter 就换会话，和 /say 走同一套 rotateTalkSession
 *
 * 为什么必须先认来源（真机会话事件里三种都出现过）：
 *   - 人打的       source = { kind:'user', rpcId:<uuid>, clientTimeZone:'Asia/Shanghai' }
 *   - 我们 prompt 的 source.kind 也是 'user'，但 rpcId 带 wake-/say- 前缀、**没有** clientTimeZone
 *   - 宿主拼的上下文 kind = 'runtime-context' / 'skill-catalog' / 'plugin:xxx'
 * 认错任何一种都会让轮数失真：把唤醒当人说话 → 每晚白涨一轮；
 * 把上下文当人说话 → 一轮涨好几次，rotateAfter 提前触发，她频繁失忆。
 *
 * 2026-11-03（github:ssamurias/dsh-fish#18）第四种来源：**外渠道注入**。
 * QQ 桥（dsh-qq-link）之类注入的消息 source = { kind:'qq' }，原来被第一个
 * `src.kind !== 'user'` 直接判成 context，连总线那一关都过不去——于是 turns 恒为 1、
 * `heard` 只有一条、「他来过」永远不写、冷落检测到点就误记一条「他有 N 天没出现」。
 *
 * 判据改成**机器侧黑名单**（MACHINE_KINDS）而不是人工白名单穷举：
 * 宿主的 v4 校验只要求 source.kind 是「非空、且不等于 'plugin'」的 producer-owned
 * 字符串（见 proactive.js 里 assertV4MessageSources 那段注释），所以外渠道的 kind
 * 是开放集合，任何桥都可以自己起名（qq / telegram / 别的）。认识的那几种挡掉，
 * 宿主拼的上下文按 source.form 挡掉（MACHINE_FORMS），其余一律当人——
 * 宁可多算一轮也不静默丢消息。
 *
 * 铁律：这里**基本只读**会话事件、只写 home.json / talk-recent.json / 一条 meta，
 * 不动对话本身。任何失败都吞掉——记账出错不能连累她说话。
 *
 * 2026-11-02（用户 m00680）唯一的例外：她这一轮在侧栏里说出口的原话，会以
 * `utterance` + `flags:['uncommitted']` 补写进事件流。理由见 settle() 里那段注释——
 * 拒绝判定读的是事件流里的 utterance，而侧栏聊天原本一条都不落盘。
 * 打了 uncommitted 的句子只留证，不算信念（derive.js 里与 selfmod 同一处理）。
 */

import { rootDir, readEvents, appendEvent } from './store.js'
import { loadConfig, dateKey } from './settings.js'
import { parseWatchIntent } from './intent.js'
import { homeStatus, bumpTurns, rotateTalkSession, adoptTalkSession } from './home.js'
import { addExchange } from './talkmem.js'
import { newHerEventsSince } from './inbox.js'
import { HER_TYPES, normalizeScene } from './schema.js'
import { refreshSelfDoc } from './selfdoc.js'
import { growthDay, stageOf } from './derive.js'
import { hearTurn } from './hear.js'
import { stripToolMarkup, hasToolMarkup } from './markup.js'

/**
 * 我们自己 prompt 进去的消息，rpcId 会带这些前缀。
 * 只是"多一道保险"：真正的判据是 clientTimeZone（见 classifyMessage）。
 *
 * `carry` 是换会话前请她留话那条（home.js 的 `carry-ask-`）。少了它，那条
 * 消息会掉进 `kind === 'user'` 且没有 clientTimeZone 的 `unknown` 分支：不进
 * 轮数（行为正确），但每换一次会话就往日志里多一行「认不出来源」（2026-11-06）。
 */
const PLUGIN_RPC = /^(wake|say|boot|report|letter|sleep|nudge|probe|turn|sys|carry)[-_]/i

/**
 * 宿主/我们这边自己拼的、**确定不是人打的** source.kind。
 *
 * 这张表是黑名单，不是白名单：宿主的 v4 校验不限制 kind 取值（只要非空、
 * 不等于 'plugin'），外渠道的 kind 因此是开放集合，穷举不了。表里没有的
 * 一律当人（见 classifyMessage 末尾）——issue #18 就是被"只认 user"卡死的。
 *
 * 加新条目前先想清楚：这一个 kind 会不会在**人真的说话**时出现？
 * 会，就别加——加了等于把人话静默丢掉，这正是 #18 的病灶。
 */
const MACHINE_KINDS = new Set([
  'runtime-context', // 宿主每轮拼进去的运行上下文
  'skill-catalog', // 技能清单
  'schedule', // 定时消息（schedule.test.mjs 钉着）
  'system', // 系统提示/系统插入
  'system-prompt',
  'tool', // 工具结果回灌
  'plugin', // 插件自己发的（v4 校验禁用它当消息来源，这里再兜一层）
  'assistant', // 她自己说的话，不该反过来算他来过
  // 2026-11-04（用户 m00428）：我们自己叫醒她用的来源（lib/deliver.js）。
  // 宿主的 sc.prompt() 会把这个 kind 写死成 'user'，那条只能落成用户气泡；
  // 改走 agent.followup() 之后来源由自己填，前端画成收起的折叠条。
  // 漏了这一行，她自己醒来说的话就会被记成「他来过」——冷落天数、seen、
  // turns 全被污染，她越主动，面板越显示「他刚来过」。
  'fish-wake',
  // 2026-11-05：宿主自己写进会话、又不带 source.form 的几种（带 form 的见 MACHINE_FORMS）。
  // 都是 role:'user' 的系统消息，人说话时不会用这些 kind。
  // 名单对照的是宿主 0.2.2-rc.1 的 MessageSourceMap（dsh-api-session-controller）。
  'working-directory', // 工作目录变了
  'cordis-host-runner', // 插件运行器的转告
  'ptc-mode', // 工具执行模式提示
  'user-approval', // 审批策略变了
  'compact-checkpoint', // 压缩检查点
  'goal', // /goal 的目标
  'team-message', // 队友之间的话
  'agent-message', // 子代理、队友之间转的话（form 是 relay，见下）
  // dsh-bili-humanism 给模型排的提示词（手账存完后的提问、人格审阅）。
  // 它们不是 plugin: 前缀，所以要单列，否则写一篇手账就多一条「他来过」。
  'bili-humanism-post-viewing-question',
  'bili-humanism-personality-review',
  'bili-humanism-shadow-review',
])

/**
 * 宿主拼上下文时写在 source.form 上的形态（宿主前端的 KNOWN_FORMS）。
 *
 * 宿主给模型看的上下文（time-context、model-selection、tool-jobs、plan-mode、
 * action-cards、agent-instructions、session-reference、tmux 快照……）kind 各不相同，
 * 以后还会有新的，靠列 kind 总会漏；它们的共同点是都带这个字段。
 * 漏一个的后果很重：time-context 最多十分钟一条，每条都是一次「他来过」、
 * 一次 turns +1、一条写在他名下的 heard，满 rotateAfter 换房。
 *
 * relay 故意不在表里：外渠道转述人说的话，也可能自称 relay，那种要算人。
 * 所以桥不要用这个表里的 form，用了就会被当上下文（AGENTS.md §7.2）。
 */
const MACHINE_FORMS = new Set(['snapshot', 'notice', 'catalog', 'instructions', 'recall'])

/** 一条 user 消息最多记这么多字（talkmem 会再截到 160，这里只是别让整段注入进内存） */
export const TURN_TEXT_MAX = 2000
/** 一轮里连着打好几句时，最多合并这么多条 */
const TURN_MSGS_MAX = 5

/**
 * 这条 user 消息是谁写的？
 *
 * 2026-11-03（issue #18）改成「机器黑名单」：认得的机器 kind 挡掉，其余当人。
 * 原来第一句是 `if (src.kind !== 'user') return 'context'`，外渠道（qq 之类）
 * 一律被静默降级成 context，一整条链路（turns / talkmem / heard / seen）全断。
 *
 * 为什么 kind='user' 仍要求 clientTimeZone：
 * 我们自己也会往会话里塞 kind:'user' 的消息（possess.js 的交接句、
 * sessionnote.js 的便条），它们没有 rpcId、也没有时区。放宽成「user 就算人」
 * 会把这几句交接当成「他来过」。所以 user 这一支保持原样，其余 kind 走黑名单。
 *
 * 2026-11-03（一条鱼多间房）多一档 'group'：外渠道可以在 source.scene 里
 * 声明这是群聊。群聊里的话不是他来找过她，总线那一层直接丢掉，不写 seen、
 * 不涨轮数——否则群一热闹，冷落检测就永远不触发。
 *
 * @returns {'human'|'group'|'plugin'|'context'|'unknown'}
 */
export function classifyMessage(data) {
  const src = data?.source
  if (!src || typeof src !== 'object') return 'context'
  const kind = String(src.kind ?? '')
  if (!kind) return 'context'
  // 2026-11-03（一条鱼多间房）：外渠道可以自己声明这条是群聊。
  // 群聊里的话**不是他来找过她**——群里一天几百句，要是每条都算，
  // 冷落检测就永远不会触发。所以先于 kind 判定，直接归到 'group'。
  // 桥注入时把 scene 写进 source 即可（AGENTS.md §7）；不写就等于私聊。
  if (normalizeScene(src.scene) === 'group') return 'group'
  // 宿主拼的上下文 / 定时消息 / 工具回灌 / 她自己说的话：都不是他
  if (MACHINE_KINDS.has(kind) || kind.startsWith('plugin:')) return 'context'
  if (MACHINE_FORMS.has(src.form)) return 'context'
  const rid = String(src.rpcId ?? '')
  if (rid && PLUGIN_RPC.test(rid)) return 'plugin'
  if (kind === 'user') {
    // 客户端（桌面/网页侧栏）打的字一定带时区——宿主从浏览器那边取的。
    // 没有时区的 user 消息分不清是"老客户端"还是"别的插件灌的"，宁可少算一轮。
    if (src.clientTimeZone) return 'human'
    return 'unknown'
  }
  // 两张表都没挡住的 kind = 外渠道（qq / telegram / 别的桥自己起的名字）。
  // 宿主对 kind 只要求「非空且不是 'plugin'」，穷举不了，所以默认当人。
  return 'human'
}

/**
 * 从会话事件的 data 里取正文。
 *
 * 真机形态（2026-10-28 查宿主 session 库确认）：
 *   data = { id, role:'user', content:[{type:'text',text:'…'}], source:{…} }
 * 老宿主 / 别的通道可能只给 data.text，两种都兜住。
 */
export function messageText(data) {
  if (!data || typeof data !== 'object') return ''
  if (typeof data.text === 'string' && data.text.trim()) return data.text
  const c = data.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    const parts = []
    for (const p of c) {
      if (!p) continue
      if (typeof p === 'string') parts.push(p)
      else if (typeof p.text === 'string' && (!p.type || p.type === 'text')) parts.push(p.text)
    }
    if (parts.length) return parts.join('\n')
  }
  if (typeof data.message?.content === 'string') return data.message.content
  return ''
}

/**
 * 从宿主的 `assistant/message` 事件里取**她这一轮说出口的话**。
 *
 * 真机形态（2026-11-01 查宿主 `dsh-agent-loop/lib/index.js:1098`、`:1156`）：
 *   data = {
 *     turn, step,
 *     message: { id, role:'assistant', content:[{type:'text',text:'…'},{type:'reasoning',…}] },
 *     interrupted, usage, stream,
 *   }
 * 只收 `type === 'text'` 的块——reasoning 是她脑子里的嘀咕，不是她跟他说的话，
 * 搬进「上次我们说到这」等于把她没开口的心事当原话贴过去。
 */
export function assistantText(data) {
  if (!data || typeof data !== 'object') return ''
  const blocks = data.message?.content ?? data.content
  if (typeof blocks === 'string') return stripToolMarkup(blocks)
  if (!Array.isArray(blocks)) {
    return typeof data.text === 'string' ? stripToolMarkup(data.text) : ''
  }
  const parts = []
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    if (b.type !== 'text') continue
    if (typeof b.text === 'string') {
      const t = stripToolMarkup(b.text)
      if (t) parts.push(t)
    }
  }
  return parts.join('\n').trim()
}

/**
 * 模型侧工具调用标记的清洗在 `lib/markup.js`（issue #25）。
 *
 * 这里没有内联实现，是因为读同一份 assistant 正文的地方不止一处：
 * 本文件把它写进 `utterance`，`lib/home.js` 的 `askForLastWords` 拿它当
 * 「上一个房间里她留的最后一句」。清洗只做一次、收在一个纯函数里，
 * 两边都从那儿取，才不会一边干净一边脏。
 */
function cut(s) {
  const t = String(s ?? '').trim()
  return t.length > TURN_TEXT_MAX ? t.slice(0, TURN_TEXT_MAX) + '…' : t
}

/**
 * 注册"侧栏轮数"观察者。
 *
 * @param {object} ctx 宿主 ctx（需要有 on 事件总线）
 * @param {object} deps { root, log }
 * @returns {() => void} 注销函数（停用插件时调用）
 */
export function registerTurns(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  const log = deps.log ?? (() => {})
  if (typeof ctx?.on !== 'function') return () => {}

  /** 正在等 turn/end 的那一轮：{ sessionId, msgs:[], sinceId, at } */
  let pending = null
  /** 正在异步认来源的那条人话（见 takeTurnEnd：事件跟得太紧时要等它） */
  let inflight = null
  /** 注销之后不再结账（在途的那一轮可能还没等到 turn/end） */
  let stopped = false
  /** 结账是异步的；上一轮还没结完就来了下一轮时，宁可不记也不并发写 home.json */
  let busy = false
  /**
   * 最近一次替「他来过」写的 seen 时间戳（毫秒）。
   * 只给外渠道那条路用：别的会话里他每说一句都写一条，事件流会被记账行淹掉。
   */
  let lastSeenAt = 0
  /**
   * 「认不出来源」这条日志上次打的时刻，按 kind 分开记。
   * 2026-11-04（用户 m02556）：同一个 kind 十分钟最多一行，见下面总线段。
   */
  const unknownLoggedAt = new Map()

  /**
   * 「这一轮的正文里只剩工具标记」这条日志上次打的时刻。
   * 2026-11-04（issue #25）：偶发（约 500 轮 2 次），但以后要是变多，
   * 日志里要看得出来——否则又变成「事件流里少了一句，日志里一个字都没有」。
   */
  let markupDroppedAt = 0
  /**
   * 记一条「他来过」——冷落检测（absence.js）读的就是这个。
   *
   * 2026-11-03（issue #18）从 settle() 挪到这里：原来只有「这一轮聊完并且结账成功」
   * 才写，而结账依赖 pending，pending 又依赖 classifyMessage 认得出人。外渠道判成
   * context 时一个字节都不写，于是冷落检测完全瞎掉。
   *
   * 现在口径是「他开口那一刻」：他确实说话了，这件事不以她回不回、也不以
   * 结没结账为前提（与 say.js 一致）。source 必须是 'system'——tool 侧写不了
   * 非 HER_TYPES 的类型，写成 tool 会被 schema 悄悄拒掉。
   */
  async function markSeen() {
    lastSeenAt = Date.now()
    await appendEvent(
      { type: 'meta', text: `seen:${new Date(lastSeenAt).toISOString()}` },
      // day/stage 对 seen 没有语义（derive.js 只读 text 里的时刻），
      // 与 hand: / rotate: 那两条记账行同一个写法。
      { day: 0, stage: 1, source: 'system' },
      root,
    ).catch((err) => log('turns · 他来过这件事没记上', err?.message ?? err))
  }

  /** 收到真人消息：只认"她住的那个会话"，并把这一轮开始前的事件 id 记下来 */
  async function onHuman(sessionId, data) {
    const home = await homeStatus(root)
    if (!home.sessionId) return
    if (home.sessionId !== sessionId) {
      // 2026-10-31（issue #14 第二报）：轮换之后人还在换下来那条里说话。
      //
      // 原来这里无条件 return，于是换会话那一刻起，他说的每一句都被静默丢掉：
      // 不涨轮、不记原话、也不再轮换，面板永远停在 0 / N，而日志里**一个字都没有**
      // （真机表现就是「只有那一行『换了个新会话』，之后什么都没有」）。
      //
      // 成因不复杂：插件用 API 建的会话永远是空白会话，宿主侧栏不显示它；
      // 人看不见新的，自然还在旧的里说话。0.8.4 起轮换会先叫醒新会话
      // （home.js 的 rotateTalkSession 第 4 步），但**换会话那一刻已经在说话的人**
      // 不会因为新会话出现了就自动搬过去，所以这里必须认回来。
      //
      // 判据宁窄勿宽：只认「home.json 记着的、刚被换下来的那条」（rotatedFrom）。
      // 不认任意会话——认宽了等于谁在别处跟她说一句都能把她的家搬走。
      if (!home.rotatedFrom || home.rotatedFrom !== sessionId) {
        // 2026-11-03（issue #18）：这不再是「什么都不做」。
        //
        // 外渠道（QQ 桥 / 别的桥）按我们的桥接约定**自己建 DSH 会话**（AGENTS.md §7），
        // 消息根本不落进 her 会话里。原来在这里直接 return，那些话连「他来过」
        // 都不算——面板到点落一条「他有 N 天没出现」，而人其实天天在 QQ 上聊。
        //
        // 所以：屋子不搬、轮数不涨、talkmem 不动（那些都是她的家事），
        // 只把「他来过」记下来。同一分钟里连说几句只写一条，别把事件流灌成记账。
        //
        // 2026-11-04（用户 m02566 报的刷屏）：日志原来写在这个 if **外面**，
        // 于是节流只拦住了「写事件」，没拦住打日志——他连着发三句就是三行一样的
        // 「认识的会话之外的动静」。日志重复到看不出哪条是真的，等于这条日志白写。
        // 现在挪进 if 里：每 60 秒最多一行，且只在真的落了 seen 的那一次打。
        if (Date.now() - lastSeenAt > 60_000) {
          await markSeen()
          log(`turns · 认识的会话之外的动静，只记他来过（${sessionId}）`)
        }
        return
      }
      const ok = await adoptTalkSession(root, sessionId)
      log(
        ok
          ? `turns · 他还在换下来那条会话里说话，屋子认回它（${sessionId}）`
          : `turns · 他还在换下来那条会话里说话，但认不回来（${sessionId}）`,
      )
      if (!ok) return
    }
    const text = cut(messageText(data))
    if (!text) return
    // 他递来一条视频（2026-10-28）：记一条事实 `hand:<日期> <bvid>`。
    // **不等于她看过**——评论闸门不认这一行，认的是 look:/watched:。
    // 只记 BV 号；短链在这一层不解析（要发网络请求，不该卡在她说话的路径上）。
    const want = parseWatchIntent(text)
    if (want.hasVideo && want.bvid) {
      appendEvent(
        { type: 'meta', text: `hand:${dateKey()} ${want.bvid}` },
        { day: 0, stage: 1, source: 'system' },
        root,
      ).catch(() => {})
    }
    if (!pending || pending.sessionId !== sessionId) {
      const { events } = await readEvents(root).catch(() => ({ events: [] }))
      // 这一轮的第一句人话 = 「他开头那一刻」。一轮只写一条 seen
      // （单条论：turns.test.mjs 与 p3.test.mjs 都钉着「一轮一条」）。
      await markSeen()
      pending = {
        sessionId,
        msgs: [],
        // 这一轮开始前最后一条事件：用来在 turn/end 时捞她调 growth_commit 写下的那些
        sinceId: events.length ? (events[events.length - 1].id ?? null) : null,
        // 她这一轮在侧栏里**说出口的原话**，从宿主的 assistant/message 收（见 assistantText）。
        // 2026-11-01：原来只从 events.jsonl 里 HER_TYPES 那六种取，而那只在她调
        // growth_commit 时才写 —— 她在侧栏正常聊天写的话根本不进事件流，
        // 于是 talk-recent.json 的 her 永远是空字符串，换会话时搬过去的
        // 「上次我们说到这」只有他那一半。这条通道一接，那半句才补上。
        says: [],
        // 同一条 assistant/message 可能分几步重放（interrupted / 续写会改同一个 message id）。
        // 按 message.id 去重，别把她说的一句话记成三句。
        sayIds: new Set(),
        at: Date.now(),
      }
    }
    if (pending.msgs.length < TURN_MSGS_MAX) pending.msgs.push(text)
  }

  /** turn/end：结账 */
  async function settle(p) {
    if (stopped) return
    if (busy) {
      log('turns · 上一轮还没结完，这次不记')
      return
    }
    busy = true
    try {
      const after = await readEvents(root).catch(() => ({ events: [] }))
      // sinceId 为空 = 这一轮开始前一条事件都没有 ⇒ 全算她这轮说的。
      // （不能直接把这个空值交给 newHerEventsSince：它把 null 当"全部已读"，会返回空。）
      const picked = p.sinceId
        ? newHerEventsSince(after.events, p.sinceId)
        : after.events.filter((e) => HER_TYPES.includes(e.type))
      // 两条来源合起来才是「她这一轮说了什么」：
      //   ① events.jsonl 里 HER_TYPES —— 只有她主动调 growth_commit 才有，是「她认下来的话」；
      //   ② 这一轮 assistant/message 的 text 块 —— 她在侧栏里**实际说出口的**那些。
      // 少了 ②，talk-recent.json 的 her 永远是空串，换会话时她听不到自己上一段说过什么。
      const spoken = (Array.isArray(p.says) ? p.says : []).join('\n\n').trim()
      const committed = picked.map((e) => String(e.text ?? '').trim()).filter(Boolean).join('\n\n')
      const her = [spoken, committed].filter(Boolean).join('\n\n')
      const { config } = await loadConfig(root).catch(() => ({ config: null }))
      // A2（2026-10-30，用户 m00112）：每 hearEvery 轮，把他说的**一句原话**记下来。
      // 放在换会话判断之前：这一轮已经结完账，换不换会话都该记。
      // 用 after.events 算成长日——这时还没写 heard，差一天也不会差在这一条上。
      const day = growthDay(after.events)
      // 「他来过」不在这儿写（2026-11-03 移走，见 markSeen）。
      //
      // 原来写在这里的理由是「这一轮确实聊完了才算他来过」。issue #18 证明这个口径
      // 会整条链路失灵：外渠道的消息判不成 human 就没有 pending，没有 pending 就
      // 永远走不到这一行，于是聊得再多冷落检测也看不见。现在改成他一开口
      // （onHuman 里第一句人话）就记，与 say.js「他确实说话了，不以她回不回为前提」
      // 同一口径；一轮仍然只有一条。
      // 2026-11-02（用户 m00680）：把她在侧栏里**说出口的原话**补写进事件流。
      //
      // 为什么必须补：`derive.js` 的 wontCount 只数 events.jsonl 里的 utterance，
      // 而这个观察者以前一个字节都不写事件（见文件头铁律）。于是她在侧栏里说的
      // 「我拒绝B」只进了 talk-recent.json，拒绝计数永远是 0，refusal_seed 之类
      // 靠「她有没有拒绝过」判断的事件卡永远不成立。
      //
      // 为什么打 uncommitted：她没调 growth_commit 认领这句话，就不能让它改称呼、
      // 覆盖自我叙述、参与固化（derive.js 里与 selfmod 同一处理）。它只留证。
      //
      // 只补这一轮**新**说出口的：committed 里的已经在事件流里了，重复写会重复计数。
      const fresh = spoken
        ? String(spoken)
            .split('\n\n')
            .map((s) => s.trim())
            .filter(Boolean)
            .filter((s) => !committed.includes(s))
        : []
      for (const text of fresh) {
        await appendEvent(
          { type: 'utterance', text: cut(text), flags: ['uncommitted'] },
          { day, stage: stageOf(day, Number(config?.growthDays ?? 30)), source: 'system' },
          root,
        ).catch((err) => log('turns · 她的话没记上', err?.message ?? err))
      }
      await addExchange(root, { me: p.msgs.join('\n'), her }).catch(() => {})
      const turns = await bumpTurns(root, 1)
      await hearTurn(root, {
        text: p.msgs.join('\n'),
        turns,
        day,
        stage: stageOf(day, Number(config?.growthDays ?? 30)),
        config,
        log,
      })
      const rotateAfter = Number(config?.chat?.rotateAfter ?? 0)
      if (!(rotateAfter > 0) || turns < rotateAfter) return

      // 该换会话了。换失败不算错：她还在旧会话里，下次再换。
      // from：这一轮是从哪条会话里结出来的。`/say` 那边可能刚刚换过，
      // Home 比对 home.json 之后会返回 skipped，这里就别再建第二条（0.8.8）。
      const st = await homeStatus(root)
      const rot = await rotateTalkSession(ctx, { root, wsId: st.wsId, log, from: p.sessionId })
      if (!rot.ok) {
        log(`turns · 聊满 ${turns} 轮，该换会话但没换成：${rot.why}`)
        return
      }
      if (rot.skipped) {
        log(`turns · 聊满 ${turns} 轮，但屋子已经先换过了（${rot.sessionId}），这条不再换`)
        return
      }
      // 留一条 meta：换会话这件事要能在事件流里查到（观测台/排查用）。
      // source 必须是 system——'tool' 会被 schema 拒掉。
      await appendEvent(
        { type: 'meta', text: `rotate:${turns}:${rot.sessionId}` },
        { day: 0, stage: 1, source: 'system' },
        root,
      ).catch(() => {})
      // 新会话要读到新的身份文档（「上次说到这」在里面）
      await refreshSelfDoc(root, { log }).catch(() => {})
      log(`turns · 聊满 ${turns} 轮，换了个新会话（旧 ${rot.old || '?'} → 新 ${rot.sessionId}）`)
    } catch (err) {
      log('turns · 结账失败', err?.message ?? err)
    } finally {
      busy = false
    }
  }

  /**
   * turn/end 到了：确认这一轮是她屋里的、人打的，再结账。
   *
   * 为什么要等 `inflight`：真机上这两条事件是分开来的（人话在前，turn/end
   * 在几秒后），但测试里、以及事件批量回放时可能同一拍到达——那时 onHuman
   * 还在 `await homeStatus()`，pending 还没挂上，直接看就会把这一轮漏掉。
   * 等它落定再看，只多花几毫秒，不会把别人的轮次算进来。
   */
  async function takeTurnEnd(sessionId) {
    if (!pending || pending.sessionId !== sessionId) {
      if (!inflight) return
      await inflight.catch(() => {})
      if (!pending || pending.sessionId !== sessionId) return
    }
    const p = pending
    pending = null
    await settle(p)
  }

  const off = ctx.on('session/event', (session, event) => {
    try {
      const sessionId = String(session?.header?.id ?? session?.id ?? '')
      if (!sessionId) return
      const type = String(event?.type ?? '')
      if (type === 'user/message') {
        const cls = classifyMessage(event?.data)
        if (cls === 'group') {
          // 2026-11-03（一条鱼多间房）：群聊里的话不进轮数、不写 seen。
          // 一条日志都不打——群聊一天几百条，每条打一行会把日志冲掉。
          return
        }
        if (cls !== 'human') {
          // 2026-11-03（issue #18）：unknown 以前是**悄无声息**地丢掉的。
          // 现场表现就是「明明在说话，事件流零增长，日志里一个字都没有」——
          // 报工单的人只能自己去读源码才知道哪一步断的。至少留一行。
          //
          // 2026-11-04（用户 m02556 报的刷屏）：同一个 kind 十分钟之内只打一行。
          // 留一行是为了让人知道「有东西被丢了」，留一百行只会把日志淹掉——
          // 那种情况下这条日志反而失去了它唯一的作用。
          if (cls === 'unknown') {
            const kind = String(event?.data?.source?.kind ?? '')
            const now = Date.now()
            if (now - (unknownLoggedAt.get(kind) ?? 0) > 10 * 60_000) {
              unknownLoggedAt.set(kind, now)
              log(`turns · 这条消息认不出来源，没算进轮数（kind=${kind || '空'}）`)
            }
          }
          return
        }
        inflight = onHuman(sessionId, event.data)
          .catch((err) => log('turns · 记轮失败', err?.message ?? err))
          .finally(() => {
            inflight = null
          })
        return
      }
      // 她这一轮说出口的话（2026-11-01）。原来只从 events.jsonl 取，
      // 而那里只有她调 growth_commit 才写 —— 侧栏里正常聊的话一句都拿不到。
      // 只认还在等结账的那一轮：没有 pending（唤醒轮、/say 轮）就不记，
      // 否则定时唤醒里她自己写的句子会被当成「他来过」的对话搬进下一段。
      if (type === 'assistant/message') {
        if (!pending || pending.sessionId !== sessionId) return
        if (pending.says.length >= TURN_MSGS_MAX) return
        const mid = String(event?.data?.message?.id ?? '')
        if (mid) {
          if (pending.sayIds.has(mid)) return
          pending.sayIds.add(mid)
        }
        const said = cut(assistantText(event?.data))
        if (said) pending.says.push(said)
        else if (Date.now() - markupDroppedAt > 60_000) {
          // 2026-11-04（issue #25）：这一步的正文只剩工具调用标记
          // （`</｜｜DSML｜｜ invoke>`），清洗后没有正文。她本来要说的那句话
          // 在这一步就丢了，插件补不回来——能做的只有**别把标记当她的话记进去**，
          // 并且在日志里留一行，免得以后这类事件变多了都没人发现。
          const blocks = event?.data?.message?.content
          const raw = Array.isArray(blocks) ? blocks.map((b) => String(b?.text ?? '')).join('\n') : ''
          if (hasToolMarkup(raw)) {
            markupDroppedAt = Date.now()
            log('turns · 这一步的正文只剩工具调用标记，没当成她的话')
          }
        }
        return
      }
      if (type === 'turn/end') {
        void takeTurnEnd(sessionId).catch((err) => log('turns · 结账失败', err?.message ?? err))
      }
    } catch (err) {
      log('turns · 事件处理失败', err?.message ?? err)
    }
  })

  return () => {
    stopped = true
    pending = null
    try {
      if (typeof off === 'function') off()
    } catch {
      /* ignore */
    }
  }
}
