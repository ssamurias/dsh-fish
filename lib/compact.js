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
 *    所以这两种节点**不盖**，而是把这一轮切成几段，各段分别折（`runs`）。
 *
 * ## 为什么是「几段」而不是「一整段」
 *
 * 一次叫醒里，宿主自己会往这一轮里追加 `system/message`（处境段变了 → 提示词变了 →
 * 投影提交一次）。如果「区间里有投影就整轮放弃」，那真机上几乎每一轮都会放弃，等于白写。
 * `dsh-proactive` 0.3.2 也是这么处理的：把它自己写的事件切成连续 run，遇到别人的就断开。
 * 这里的边界是：宿主的投影、runtime-context 快照、任何不是这次投递的 user/message。
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
 * 一段里至少要有这么多字符才值得折。墓碑本身 70 来字；再加上宿主写事件、多一次 append，
 * 折一段只有一句话的区间是净亏。宁可留着。
 */
export const MIN_RUN_CHARS = 200

/** 一条事件里真正占篇幅的内容（字符串本身，不算 JSON 的括号和键名）。 */
function dataSize(value, depth = 0) {
  if (depth > 6 || value == null) return 0
  if (typeof value === 'string') return value.length
  if (Array.isArray(value)) return value.reduce((n, v) => n + dataSize(v, depth + 1), 0)
  if (typeof value === 'object') return Object.values(value).reduce((n, v) => n + dataSize(v, depth + 1), 0)
  return 0
}

/**
 * 算这次折叠要盖住哪几段。纯函数：不改事件、不碰会话。
 *
 * @param {Array} events 这一轮的会话事件（含投递进来的那条 ping）
 * @param {{startSeq:number, endSeq:number, rpcId?:string}} opts
 *   `startSeq` = ping 的 seq，`endSeq` = `turn/end` 的 seq − 1。
 *   传了 `rpcId` 时会核对区间里每一条 user/message 都是这次投递，认不出就当边界。
 * @returns {null|{runs:Array<{startSeq:number,endSeq:number,sourceEventSeqs:number[],shadowed:number}>,shadowed:number}}
 *   返回 null = 这一轮没什么可折（原因写在调用方的日志里，这里保持纯）。
 *   `runs` 可能有多段：宿主的投影/快照/别人的话把它们隔开，各段单独替换。
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
  inRange.sort((a, b) => Number(a.seq) - Number(b.seq))

  // 这一段能不能盖：宿主的投影、快照、别人的话都不能，但不必整轮放弃——它们当边界。
  const owned = (e) => {
    const type = String(e?.type ?? '')
    if (type === 'system/message' || type === 'developer/message') return false
    if (type === 'user/message') {
      if (!isSurfaceEvent(e)) return false
      const kind = String(e?.data?.source?.kind ?? '')
      const rid = String(e?.data?.source?.rpcId ?? '')
      if (kind === 'runtime-context') return false
      if (kind !== FISH_SOURCE_KIND) return false
      if (rpcId && rid !== rpcId) return false
    }
    return isSurfaceEvent(e)
  }

  const runs = []
  let cur = null
  for (const e of inRange) {
    const type = String(e?.type ?? '')
    // 宿主的投影、快照、别人的话：不能盖，当边界把这一轮切开。
    const boundary = type === 'system/message' || type === 'developer/message' ||
      (type === 'user/message' && !owned(e))
    if (boundary) {
      cur = null
      continue
    }
    // 日志类事件（turn/start、step/end……）既不能盖也不是边界：跳过，别把一段切成两段。
    if (!owned(e)) continue
    if (!cur) {
      cur = { nodes: [], chars: 0 }
      runs.push(cur)
    }
    cur.nodes.push(Number(e.seq))
    cur.chars += String(e.type).length + dataSize(e.data)
  }

  const picked = runs.filter((r) => r.chars >= MIN_RUN_CHARS)
  if (picked.length === 0) return null
  return {
    runs: picked.map((r) => ({
      startSeq: r.nodes[0],
      endSeq: r.nodes[r.nodes.length - 1],
      sourceEventSeqs: r.nodes,
      shadowed: r.nodes.length,
    })),
    shadowed: picked.reduce((n, r) => n + r.nodes.length, 0),
  }
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
/**
 * 她这句是不是「没什么要说的」（2026-11-05，用户 m02937）。
 *
 * 一个回合总得产出点什么，所以「不想说」在文本界面上常常变成一句元话语。
 * 这不是开口：记账时按静默处理、整轮折掉。判据故意做窄——短、且开头就交代
 * 「这一轮/今天没什么要说的」，避免把真话误判。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeNothingSaid(text) {
  const t = String(text ?? '').trim()
  if (!t || t.length > 60) return false
  if (/^(这一轮|这一回合|今天|这会儿|这次)[^。！？]{0,30}(没什么|没有|没)(什么)?(可)?(要|想|好)?说/.test(t)) return true
  return /^(没什么|没有)(什么)?(可)?(想|要)?说的/.test(t) && t.length <= 40
}

export function followWake(ctx, { rpcId = '', timeoutMs = WAKE_FOLLOW_TIMEOUT_MS, log } = {}) {
  const rid = String(rpcId ?? '')
  const events = []
  let session = null
  let startSeq = -1
  let spoke = false
  let said = ''
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
      said,
      startSeq,
      endSeq: -1,
      events,
      session,
      why: 'timeout',
      ...outcome,
    })
  }

  // 同一个宿主里别的会话也有事件流：认领之后只收这一条会话的，别把别人的 seq 折进来。
  const sameSession = (a, b) => {
    if (!a || !b) return false
    if (a === b) return true
    const ida = a.header?.id ?? a.id
    const idb = b.header?.id ?? b.id
    return Boolean(ida) && ida === idb
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
      // 认领之后：只跟这一条会话。别的会话的转轮、turn/end 都是噪声。
      if (session && s && !sameSession(session, s)) return
      if (seq <= startSeq) return
      if (String(event?.type ?? '') === 'turn/end') {
        finish({ ok: true, endSeq: seq - 1, session: session ?? s ?? null })
        return
      }
      events.push(event)
      if (String(event?.type ?? '') === 'assistant/message') {
        const text = assistantText(event?.data)
        if (text) {
          spoke = true
          said = said ? said + String.fromCharCode(10) + text : text
        }
      }
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
 * 真的把一段折起来。
 *
 * @param {object} session 宿主的会话对象（`followWake` 交回来的那个）
 * @param {object} run `planWakeCompaction()` 返回的 `runs` 里的一段
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
