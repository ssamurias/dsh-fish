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
 * 铁律：这里**只读**会话事件、只写 home.json / talk-recent.json / 一条 meta，
 * 不动对话本身。任何失败都吞掉——记账出错不能连累她说话。
 */

import { rootDir, readEvents, appendEvent } from './store.js'
import { loadConfig, dateKey } from './settings.js'
import { parseWatchIntent } from './intent.js'
import { homeStatus, bumpTurns, rotateTalkSession, adoptTalkSession } from './home.js'
import { addExchange } from './talkmem.js'
import { newHerEventsSince } from './inbox.js'
import { HER_TYPES } from './schema.js'
import { refreshSelfDoc } from './selfdoc.js'
import { growthDay, stageOf } from './derive.js'
import { hearTurn } from './hear.js'

/**
 * 我们自己 prompt 进去的消息，rpcId 会带这些前缀。
 * 只是"多一道保险"：真正的判据是 clientTimeZone（见 classifyMessage）。
 */
const PLUGIN_RPC = /^(wake|say|boot|report|letter|sleep|nudge|probe|turn|sys)[-_]/i

/** 一条 user 消息最多记这么多字（talkmem 会再截到 160，这里只是别让整段注入进内存） */
export const TURN_TEXT_MAX = 2000
/** 一轮里连着打好几句时，最多合并这么多条 */
const TURN_MSGS_MAX = 5

/**
 * 这条 user 消息是谁写的？
 * @returns {'human'|'plugin'|'context'|'unknown'}
 */
export function classifyMessage(data) {
  const src = data?.source
  if (!src || typeof src !== 'object') return 'context'
  if (src.kind !== 'user') return 'context'
  const rid = String(src.rpcId ?? '')
  if (rid && PLUGIN_RPC.test(rid)) return 'plugin'
  // 客户端（桌面/网页侧栏）打的字一定带时区——宿主从浏览器那边取的。
  // 没有时区的 user 消息分不清是"老客户端"还是"别的插件灌的"，宁可少算一轮。
  if (src.clientTimeZone) return 'human'
  return 'unknown'
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
  if (typeof blocks === 'string') return blocks.trim()
  if (!Array.isArray(blocks)) {
    return typeof data.text === 'string' ? data.text.trim() : ''
  }
  const parts = []
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    if (b.type !== 'text') continue
    if (typeof b.text === 'string' && b.text.trim()) parts.push(b.text)
  }
  return parts.join('\n').trim()
}

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
      if (!home.rotatedFrom || home.rotatedFrom !== sessionId) return
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
      await addExchange(root, { me: p.msgs.join('\n'), her }).catch(() => {})
      const turns = await bumpTurns(root, 1)
      const { config } = await loadConfig(root).catch(() => ({ config: null }))
      // A2（2026-10-30，用户 m00112）：每 hearEvery 轮，把他说的**一句原话**记下来。
      // 放在换会话判断之前：这一轮已经结完账，换不换会话都该记。
      // 用 after.events 算成长日——这时还没写 heard，差一天也不会差在这一条上。
      const day = growthDay(after.events)
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
      const st = await homeStatus(root)
      const rot = await rotateTalkSession(ctx, { root, wsId: st.wsId, log })
      if (!rot.ok) {
        log(`turns · 聊满 ${turns} 轮，该换会话但没换成：${rot.why}`)
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
        if (classifyMessage(event?.data) !== 'human') return
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
