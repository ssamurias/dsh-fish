/**
 * compact.js —— 她醒过来、看了一圈、**没有开口**的那一轮，从模型看到的历史里收起来。
 *
 * 2026-11-05 用户 m00803：做「沉默不扣额度」和「静默轮折叠」两条。
 * 折叠这条的写法是照着市场插件 `dsh-proactive` 0.3.2 的 `lib/compact.js` 学的
 * （它把一次静默唤醒的 ~2.6KB 折叠成 ~70B），但这里只借**思路**，代码全用自己的：
 * 它的六个闹钟工具、framing 头、`proactive_reclaim` 都不进这里。
 *
 * ## 为什么值得做
 *
 * 空手回合里她做的全部事情是：读处境（`fish:wake` 段）→ 想一想 → 什么都没说。
 * 这一轮在会话日志里留下的是一整串 `assistant/message`（reasoning + 偶尔一句
 * 「（现在没有人跟你说话。）」式的空转），下一轮她醒过来时会**再读一遍**——
 * 她自己的上下文被自己过去几十次「想了一下、没说」慢慢塞满，换会话的时间提前，
 * 而这段时间没有任何信息价值。收起来以后模型侧只剩一行墓碑，人类对话记录一个字不动。
 *
 * ## 硬限制（宿主 0.2.x 的校验，不是我们的选择）
 *
 * 1. 能盖东西的事件只有五种：`system/message`、`developer/message`、`user/message`、
 *    `assistant/message`、`tool/result`；而且它们**必须**自带 surfaceOp。
 * 2. 替换的写法是 `{ op:'replace', startSeq, endSeq }`，两端都必须早于新事件自己的 seq。
 * 3. 原文：`surface replace: sourceEventSeqs must include every shadowed surface node` ——
 *    被盖区间里**每一个** surface 节点都得列进 `sourceEventSeqs`，少一个宿主就抛。
 * 4. `assistant/message` 永远不能带 `sourceEventSeqs`（它自己内嵌了 source stream），
 *    所以**墓碑只能是 `user/message`**。
 * 5. 不能盖宿主自己的投影：step 里的 `system/message`（system prompt 的增量投影）和
 *    `source.kind === 'runtime-context'` 的 user/message（整份上下文快照）。
 *    盖了它们，宿主下一拍会判定投影没对齐、把整份快照重发一遍——比原来更贵。
 *    这两种情况这里一律**直接放弃这轮折叠**，宁可多留着，不要动坏账本。
 *
 * ## 保守到什么程度
 *
 * 区间里只要出现一个「不是她这一轮自己写的」用户消息（比如他正好在这几十秒里打了字，
 * 或者别的插件注入了一条），就整轮不折。丢一次省钱的机会，好过把他的话藏起来。
 */

import { randomUUID } from 'node:crypto'
import { assistantText } from './turns.js'
import { fishMessage, FISH_SOURCE_KIND } from './deliver.js'

/**
 * 墓碑的指纹。日志和测试都靠它认出「这一条是折叠出来的」，不要改字面量。
 * 前缀用英文方括号，跟 `dsh-proactive` 的 `[dsh-proactive silent wake ` 同一套路，
 * 但名字必须是自己的——将来看日志时得能分清是哪家插件盖的。
 */
export const TOMBSTONE_MARKER = '[dsh-fish silent wake]'

/** 能承载 surface 的五种事件类型（宿主 `SURFACE_EVENT_TYPES`）。 */
export const SURFACE_TYPES = Object.freeze([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

const SURFACE = new Set(SURFACE_TYPES)

/** 等她的回合结束最多等这么久；超时就只记账、不折（折叠需要闭合区间）。 */
export const WAKE_FOLLOW_TIMEOUT_MS = 10 * 60_000

/** 这一条事件是不是 surface 节点（能进模型的可见历史）。 */
export function isSurfaceEvent(event) {
  return Boolean(event) && SURFACE.has(String(event.type ?? '')) && event.surfaceOp !== undefined
}

/**
 * 墓碑正文。
 *
 * 两件事必须说清，否则下一次醒来她会把这行当成「他留了一句话」：
 *   1. 这是**她自己的**一轮，不是他发的；
 *   2. 那一轮她已经看过了，没有话要说——不需要回头补。
 * 控制在 100 字以内，折叠的意义就在省。
 */
export function tombstoneText() {
  return `${TOMBSTONE_MARKER} 这一轮是她自己醒过来看了一圈，没有开口。内容已经收起，不必回头补。`
}

/**
 * 算一次折叠要盖住的区间。纯函数：不改事件、不碰会话。
 *
 * @param {Array} events 这一轮的会话事件（含投递进来的那条 ping）
 * @param {{startSeq:number, endSeq:number, rpcId?:string}} opts
 *   `startSeq` = ping 的 seq，`endSeq` = `turn/end` 的 seq − 1。
 *   传了 `rpcId` 时会核对区间里每一条 user/message 都是这次投递，认不出就放弃。
 * @returns {null|{startSeq:number,endSeq:number,sourceEventSeqs:number[],shadowed:number}}
 *   返回 null = 这一轮不折（原因写在调用方的日志里，这里保持纯）。
 */
export function planWakeCompaction(events = [], { startSeq, endSeq, rpcId = '' } = {}) {
  if (!Number.isSafeInteger(startSeq) || !Number.isSafeInteger(endSeq)) return null
  if (startSeq < 0 || endSeq < startSeq) return null
  if (!Array.isArray(events) || events.length === 0) return null

  const inRange = []
  for (const e of events) {
    const seq = Number(e?.seq)
    if (!Number.isSafeInteger(seq)) continue
    if (seq < startSeq || seq > endSeq) continue
    inRange.push(e)
  }
  if (inRange.length === 0) return null

  const shadowed = []
  for (const e of inRange) {
    const type = String(e?.type ?? '')
    // 宿主的投影：盖了它，下一拍整份快照会被重发（比不折更贵）。
    if (type === 'system/message' || type === 'developer/message') return null
    if (type === 'user/message') {
      const kind = String(e?.data?.source?.kind ?? '')
      const rid = String(e?.data?.source?.rpcId ?? '')
      // 别人的话一律不藏：他打的字、别的插件注入的都不在这个区间该被收起来。
      if (kind === 'runtime-context') return null
      if (kind !== FISH_SOURCE_KIND) return null
      if (rpcId && rid !== rpcId) return null
    }
    if (isSurfaceEvent(e)) shadowed.push(Number(e.seq))
  }
  if (shadowed.length === 0) return null
  return { startSeq, endSeq, sourceEventSeqs: shadowed, shadowed: shadowed.length }
}

/**
 * 盯住这一轮：认出投递进来的那条 ping，收到 `turn/end` 时交回结论。
 *
 * 只在 `session/event` 上读，不写会话（写交给 `compactWake`），失败一律吞掉——
 * 折叠是省钱，不能连累她的回合。
 *
 * @param {object} ctx 插件上下文（只用 `ctx.on`）
 * @param {{rpcId:string, timeoutMs?:number, log?:Function}} opts
 * @returns {{done:Promise<object>, off:Function}}
 *   `done` 解析为 `{ ok, spoke, startSeq, endSeq, events, session, why? }`；
 *   `ok:false` 表示没等到闭合区间（超时/投递没出现），调用方只记账不折。
 */
export function followWake(ctx, { rpcId = '', timeoutMs = WAKE_FOLLOW_TIMEOUT_MS, log } = {}) {
  const rid = String(rpcId ?? '')
  const events = []
  let session = null
  let startSeq = -1
  let spoke = false
  let settled = false
  let off = null
  let timer = null
  let resolveDone = () => {}
  const done = new Promise((r) => { resolveDone = r })

  const stop = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    try {
      if (typeof off === 'function') off()
      else off?.off?.()
    } catch { /* ignore */ }
    off = null
  }

  const finish = (outcome) => {
    if (settled) return
    settled = true
    stop()
    resolveDone({
      ok: false,
      spoke,
      startSeq,
      endSeq: -1,
      events,
      session,
      why: 'timeout',
      ...outcome,
    })
  }

  const onEvent = (s, event) => {
    try {
      if (settled || !event) return
      const seq = Number(event.seq)
      if (!Number.isSafeInteger(seq)) return
      if (startSeq < 0) {
        // 还没见到自己那条 ping：只认 rpcId 相同的那条投递。
        if (String(event?.type ?? '') !== 'user/message') return
        if (String(event?.data?.source?.rpcId ?? '') !== rid) return
        startSeq = seq
        session = s ?? null
        events.push(event)
        return
      }
      if (seq <= startSeq) return
      if (String(event?.type ?? '') === 'turn/end') {
        finish({ ok: true, endSeq: seq - 1, session: session ?? s ?? null })
        return
      }
      events.push(event)
      if (String(event?.type ?? '') === 'assistant/message' && assistantText(event?.data)) spoke = true
    } catch (err) {
      log?.('compact · 事件处理失败', err?.message ?? err)
    }
  }

  try {
    off = ctx?.on?.('session/event', onEvent) ?? null
  } catch (err) {
    log?.('compact · 挂监听失败', err?.message ?? err)
  }
  timer = setTimeout(() => finish({ ok: false, why: 'timeout' }), timeoutMs)
  timer?.unref?.()

  return {
    done,
    /** 主动收摊：投递失败、插件卸载、测试里提前结束都用它。 */
    off: () => finish({ ok: false, why: 'stopped' }),
  }
}

/**
 * 真的把这一轮折起来。
 *
 * @param {object} session 宿主的会话对象（`followWake` 交回来的那个）
 * @param {object} plan `planWakeCompaction()` 的结果
 * @returns {Promise<boolean>} true=替换写进去了
 */
export async function compactWake(session, plan, { log } = {}) {
  if (!plan || !session || typeof session.append !== 'function') return false
  try {
    const message = fishMessage(tombstoneText(), { rpcId: `compact-${randomUUID()}`, kind: FISH_SOURCE_KIND })
    session.append('user/message', message, {
      surfaceOp: { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq },
      // 宿主逐条核对：区间里每个 surface 节点都要在名单上，少一个就抛。
      sourceEventSeqs: plan.sourceEventSeqs,
    })
    return true
  } catch (err) {
    log?.('compact · 折叠没成', String(err?.message ?? err).slice(0, 160))
    return false
  }
}
