/**
 * recall.js —— 让她能翻自己的过去：her_recall 工具
 *
 * 为什么要有这个（2026-10-23）：
 *   在此之前她只看得见「最近八条判断」。她其实**不记得任何具体的"那天"**。
 *   结果是两个坏处：① 她想说"我记得有一次"时只能编；② 越往后她越容易活成
 *   一张当前快照，而不是一个有过往的人。
 *
 * 设计上的硬约束（沿用 B §6 的思路）：
 *   - **只读**。它翻不出、也改不了任何东西。
 *   - **只翻她自己的事件流**，不碰配置、不碰状态文件。她翻不到自己的参数，
 *     因为参数从来就不在事件流里。
 *   - **输出封顶**：一次最多几条、每条截断。翻不到就是翻不到，不给她一整个
 *     事件流——那等于把「回忆」变成「读档」。
 *   - 返回里只有时间、类型、她自己写下的那几句。**条文后面带一个 id**：
 *     2026-10-27（0.5.8）起，她要写「我改口 / 我对自己有个说法」时必须用 refs
 *     指向具体某一条，而 refs 是要被查存在性的。没有 id，这条规则就只是逼她编。
 *     id 不是状态、不是参数——它只是「这句话在账上是第几行」。
 *
 * 2026-10-30（用户 m00112 批准 A）改了四处，都是**排序与入口**，没有动存储：
 *   1. 默认翻了全部时间。原来默认 30 天——一个月前的自己，她翻不到，
 *      这跟「事件流不能删」是矛盾的：记着，却看不见。
 *   2. 条数 5 → 8。太少时她一次只能看见最字面的几条，翻不完一个话题。
 *   3. 显著性加权：derive 里已经算好的 solid（反复提过/被检验过的判断）
 *      以及被 revise/test/answer 引用过的条目，排在同样字面命中的前面。
 *      原来「最重要」和「刚好提到这个字」同分，只按时间新旧排——等于没有排序。
 *   4. `kind` 可以只看一类（比如只听他说过的话）。不加这个参数就是全部。
 *
 * 2026-11-04（群里的三条反馈）又改了三处，还是只动读取，没有动存储：
 *   1. 行上带时刻。只到日的话，同一天的两句分不清先后。
 *   2. 改口关系写出来。原来 revise 和它改掉的那句在结果里毫无关系，她翻到自己
 *      早就推翻的话，只能当它还算数。推翻的那条还会因为「被引用过」加权，排到最前面。
 *      措辞用「推翻」不用「否掉」：derive.js 的 REFUSE_RE 认「我否掉」，她顺着工具的
 *      话说一句，就会被记成一次拒绝。
 *   3. 没认领的话（uncommitted，turns.js 补写的聊天原话）排在同样命中的后面，
 *      并标明是聊天时说的。derive.js 早就当它们「只留证」，这里一直没跟上。
 */

import { toJsonSchema } from './toolschema.js'
import { rootDir, readEvents } from './store.js'
import { deriveSelf } from './derive.js'
import { dateKey } from './settings.js'

import { defineTool } from './tool.js'

/** 一次最多给几条 */
export const RECALL_LIMIT = 8
/** 每条最多多少字 */
export const RECALL_SNIPPET = 200
/**
 * brief 档每条最多多少字（2026-11-02，用户 m00335 第二条）。
 *
 * 想解决的事：8 条 × 200 字最坏 1600 字，一次「有没有这回事」的试探性翻找
 * 也要付这个价。而多数时候她只需要知道**有没有、是哪几条**，细节可以再翻一次。
 * 所以加一个只看开头的档位：40 字够认出是哪件事，不够就当没翻到。
 */
export const RECALL_BRIEF_SNIPPET = 40
/** 默认往回翻多少天；0 = 全部 */
export const RECALL_DAYS = 0

/** 参与排序加权的类型：这些事件引用了某一条，说明那条被检验/修正/回答过 */
const REF_TYPES = new Set(['test', 'answer', 'revise'])

/** 不参与回忆的类型：这些不是「她经历的事」 */
const SKIP_TYPES = new Set(['meta'])

const DAY_MS = 86_400_000

/**
 * 没认领的话往后排多少。只够它排在字面同样命中的认领之后：
 * 两字词每个只算 1 分，再大就会盖过「她问的那件事正好在这句里」。
 */
const UNCLAIMED_PENALTY = 1

const isUnclaimed = (ev) => Array.isArray(ev?.flags) && ev.flags.includes('uncommitted')

// 按 UTF-16 截时别把 emoji 切成半个：写进文件就是乱码。
const clip = (text, n) => (text.length > n ? text.slice(0, n - 1).replace(/[\uD800-\uDBFF]$/, '') + '…' : text)

// 一条一行：正文里的换行会把行尾的 id 挤到下一行，也会把缩进的关系行拆开。
const oneLine = (text) => text.replace(/\s+/g, ' ').trim()

/** 不是她自己写下的、或只是顺口说的，要说清来路（引用时也一样） */
function labelled(type, unclaimed, text) {
  // heard 是旁听来的：明确写成「他说」，别让她误以为是自己说的。
  if (type === 'heard') return `他说：${text}`
  // voice、answer 同理：一句是读到的陌生人的话，一句是别人回她的。
  if (type === 'voice') return `读到别人说：${text}`
  if (type === 'answer') return `回复：${text}`
  // 没认领的是她说的，但只是聊天时顺口说的，不是她记下来的。
  return unclaimed ? `聊天时说的：${text}` : text
}

/** 本地 HH:MM，与 dateKey 同一口径（走本地钟） */
function clockOf(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 把查询切成可匹配的片段。
 * 中文没有空格，整串匹配会全落空——所以补上二字切片。
 */
export function tokensOf(query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return []
  const out = new Set()
  for (const part of q.split(/[\s,，。、;；:：!！?？"'“”‘’()（）\[\]【】]+/)) {
    const p = part.trim()
    if (!p) continue
    out.add(p)
    // 中文二字切片：只有 >=3 字才切，避免把两字词切成一堆单字
    if (p.length >= 3 && /[\u4e00-\u9fa5]/.test(p)) {
      for (let i = 0; i + 2 <= p.length; i++) out.add(p.slice(i, i + 2))
    }
  }
  return [...out]
}

/**
 * 每条事件被引用了几次（只数 test / answer / revise 的 refs）。
 * 这是「被检验过」的直接证据，不经过任何打分。
 */
export function refCounts(events = []) {
  const m = new Map()
  for (const ev of events ?? []) {
    if (!ev || !REF_TYPES.has(ev.type)) continue
    for (const r of Array.isArray(ev.refs) ? ev.refs : []) {
      m.set(String(r), (m.get(String(r)) ?? 0) + 1)
    }
  }
  return m
}

/** 每条事件最近一次被哪条 revise 改过。 */
export function latestRevisions(events = []) {
  const m = new Map()
  for (const ev of events ?? []) {
    if (ev?.type !== 'revise') continue
    for (const r of Array.isArray(ev.refs) ? ev.refs : []) {
      if (String(r) === String(ev.id)) continue
      const prev = m.get(String(r))
      if (!prev || !(Date.parse(ev.ts) < Date.parse(prev.ts))) m.set(String(r), ev)
    }
  }
  return m
}

/**
 * 顺着改口走到她最后的说法。那句后来也可能被改过，
 * 而她没法按 id 再翻一次，只给一跳等于把「当它还算数」往后挪了一步。
 * 走到「确认」就停：确认不是改口，再走下去会把她认下的那句说成改了。
 */
function lastSaying(ev, revisions, rowId) {
  const seen = new Set([String(rowId), String(ev.id)])
  let cur = ev
  for (;;) {
    const next = revisions.get(String(cur.id))
    if (!next || next.verdict === 'confirmed' || seen.has(String(next.id))) return cur
    seen.add(String(next.id))
    cur = next
  }
}

/**
 * 固化的那几条（derive 的 solid）。失败就当没有，绝不让检索翻不动。
 * 事件流越长算得越久，按「条数 + 最后一条 id」缓存一次。
 */
let solidCache = { key: '', ids: new Set() }
export function solidIdsOf(events = [], growthDays = 30) {
  const last = events.length ? String(events[events.length - 1]?.id ?? '') : ''
  // growthDays 也进 key：同一串事件在不同成长周期下算出的 solid 可能不同
  const key = `${growthDays}:${events.length}:${last}`
  if (solidCache.key === key) return solidCache.ids
  try {
    const m = deriveSelf(events, { growthDays })
    const ids = new Set((m.solid ?? []).map((b) => String(b.id)))
    solidCache = { key, ids }
    return ids
  } catch {
    return new Set()
  }
}

/**
 * 在事件流里找。纯函数（除了 solidIdsOf 的缓存），永不抛。
 *
 * @param {object[]} events
 * @param {string} query
 * @param {{days?:number, limit?:number, now?:number, kind?:string, solidIds?:Set<string>|string[], weigh?:boolean}} o
 *   days: 0 或不传 = 全部；kind: 只看某一类；weigh: false = 不加显著性权重（测试/排查用）
 * @returns {{rows:{id:string,date:string,clock:string,type:string,text:string,ago:number,unclaimed?:boolean,later?:{id:string,verdict:string|null,text:string},earlier?:{id:string,verdict:string|null,text:string}}[]}}
 *   later: 她后来对这条最后的说法（中间隔了几次改口时 verdict 为 null）；
 *   earlier: 这条 revise 改的是哪一句（指向多句时只报第一句，不报「还有几句」）。
 */
export function searchEvents(events, query, o = {}) {
  const toks = tokensOf(query)
  if (!toks.length) return { rows: [] }
  const now = Number(o.now ?? Date.now())
  const daysRaw = o.days === undefined || o.days === null ? RECALL_DAYS : Number(o.days)
  const days = Number.isFinite(daysRaw) ? daysRaw : RECALL_DAYS
  const limit = Math.max(1, Math.min(20, Number(o.limit ?? RECALL_LIMIT)))
  const since = days > 0 ? now - days * DAY_MS : -Infinity
  const kind = String(o.kind ?? '').trim()
  const weigh = o.weigh !== false
  // brief：只看开头。截断放在这里而不是渲染时，是为了让 renderRecall 之外的
  // 调用方（比如以后要做界面预览）也拿到同一份短文本，口径只有一个。
  const snippet = Math.max(8, Number(o.snippet ?? RECALL_SNIPPET))
  const solid = o.solidIds instanceof Set
    ? o.solidIds
    : new Set(Array.isArray(o.solidIds) ? o.solidIds.map(String) : [])
  const refs = weigh ? refCounts(events) : new Map()
  const revisions = latestRevisions(events)

  const scored = []
  for (const ev of events ?? []) {
    if (!ev || SKIP_TYPES.has(ev.type)) continue
    if (kind && String(ev.type) !== kind) continue
    const text = String(ev.text ?? '').trim()
    if (!text) continue
    const ts = Date.parse(ev.ts)
    if (!Number.isFinite(ts) || ts < since) continue

    const lower = text.toLowerCase()
    let score = 0
    for (const t of toks) {
      if (!lower.includes(t)) continue
      // 长片段更值钱：两字切片只算 1，整词算它自己的长度
      score += t.length >= 3 ? t.length : 1
    }
    if (score <= 0) continue

    // 显著性：字面命中之后，重要/被检验过的排前面。
    // 幅度刻意压小（最多 +6）：不能盖过「她问的那件事正好在里面」。
    let rank = score
    if (weigh) {
      if (solid.has(String(ev.id))) rank += 3
      // 她已经推翻的话不算「被检验过」，不管之前被引用过几次：不能让它排得更靠前。
      // 没认领的话也不靠引用加分，否则一次确认就抵掉了下面那 1 分。
      if (isUnclaimed(ev)) rank -= UNCLAIMED_PENALTY
      else if (revisions.get(String(ev.id))?.verdict !== 'refuted') rank += Math.min(3, refs.get(String(ev.id)) ?? 0)
    }
    scored.push({ rank, score, ts, ev, text })
  }

  scored.sort((a, b) => b.rank - a.rank || b.ts - a.ts)
  // 改口关系不受 days、kind 影响：被改的那句在时间窗外，也照样引出来。
  const byId = new Map()
  if (revisions.size) {
    for (const ev of events) if (ev && !SKIP_TYPES.has(ev.type)) byId.set(String(ev.id), ev)
  }
  const said = (ev, verdict) => ({
    id: String(ev.id ?? ''),
    verdict: verdict ?? null,
    text: clip(labelled(String(ev.type ?? ''), isUnclaimed(ev), oneLine(String(ev.text ?? ''))), RECALL_BRIEF_SNIPPET),
  })
  const rows = scored.slice(0, limit).map(({ ts, ev, text }) => {
    const next = revisions.get(String(ev.id))
    const last = next && lastSaying(next, revisions, ev.id)
    const earlier = ev.type === 'revise'
      ? (Array.isArray(ev.refs) ? ev.refs : []).filter((r) => String(r) !== String(ev.id)).map((r) => byId.get(String(r))).find(Boolean)
      : null
    return {
      id: String(ev.id ?? ''),
      // 2026-11-03（issue #19）：原来取 UTC 日期。她翻「那天」翻到的是隔天的日期，
      // 跟自己日记里的日期对不上。dateKey 走本地钟，与 settings 同一口径。
      date: dateKey(new Date(ts)),
      clock: clockOf(ts),
      ago: Math.max(0, Math.floor((now - ts) / DAY_MS)),
      type: String(ev.type ?? ''),
      text: clip(oneLine(text), snippet),
      ...(isUnclaimed(ev) ? { unclaimed: true } : {}),
      ...(last ? { later: said(last, last === next ? next.verdict : null) } : {}),
      ...(earlier ? { earlier: said(earlier, ev.verdict) } : {}),
    }
  })
  return { rows }
}

/**
 * 改口关系，每条一行，缩进挂在那条下面：
 * 第一行的最后一个括号始终是这条自己的 id（身份文档就是这么教她抄 id 的）。
 * 先写它改了谁，再写它后来被谁改，正好是时间顺序。brief 档不引对方的话。
 */
function relationLines(r, brief) {
  const out = []
  if (r.earlier) {
    const { verdict, text, id } = r.earlier
    const word = verdict === 'refuted' ? '这句推翻的是' : verdict === 'confirmed' ? '这句确认的是' : '这句改的是'
    out.push(`  ${word}${brief ? '' : `：${text}`}（${id}）`)
  }
  if (r.later) {
    const { verdict, text, id } = r.later
    const word = verdict === 'refuted' ? '后来你推翻了这句' : verdict === 'confirmed' ? '后来你又确认过这句' : '后来你改过这句'
    out.push(`  ${word}${brief ? '' : `${verdict === 'confirmed' ? '：' : '，改说：'}${text}`}（${id}）`)
  }
  return out
}

/** 渲染成她能读的一段（不是 JSON） */
export function renderRecall(rows, o = {}) {
  if (!rows?.length) return '你翻了，没翻到。'
  const brief = Boolean(o.brief)
  const lines = [brief ? '有这些（只报了开头，要看全的再说一次）：' : '你翻到的：']
  for (const r of rows) {
    // id 用小括号挂在最后：她要 revise / narration 时原样抄进来。
    // 没写 id 的老调用方（测试里的手写 fixture）就不显示括号，别凭空造一个。
    const mark = r.id ? `（${r.id}）` : ''
    const ago = Number.isFinite(r.ago) && r.ago > 0 ? `（${r.ago} 天前）` : ''
    let body = labelled(r.type, r.unclaimed, r.text)
    if (brief) body = clip(body, RECALL_BRIEF_SNIPPET)
    const when = r.clock ? `${r.date} ${r.clock}` : r.date
    lines.push(`- ${when}${ago}｜${body}${mark}`, ...relationLines(r, brief))
  }
  return lines.join('\n')
}

/**
 * 注册 her_recall 工具。
 * 返回值刻意不含条数、不含"还有 N 条"——那会变成"再翻一次"的诱惑。
 */
export function registerRecall(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  return ctx.tools.register(
    defineTool({
      name: 'her_recall',
      description:
        '翻你自己过去记下的事。想提"以前有一次"的时候先用它翻一翻，翻到了再说；翻不到就别编。默认翻全部时间，不只是最近。',
      parameters: toJsonSchema({
        query: { type: 'string', required: true, description: '你想找的是什么，几个词就够。' },
        days: { type: 'number', required: false, description: `只想翻最近多少天就传几天；不传（或传 0）就是全部。` },
        kind: { type: 'string', required: false, description: '只看某一类，比如 utterance（自己说的）、diary（日记）、heard（你听过的话）、voice（读到的别人的话）。不传就是全部。' },
        brief: { type: 'boolean', required: false, description: '只想先知道有没有、是哪几条，就传 true：每条只报开头几十个字，省地方。要看全的再翻一次（不传 brief）。' },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            found: { type: 'boolean' },
            text: { type: 'string' },
          },
          required: ['found', 'text'],
        },
        render: (_args, out) => [{ type: 'text', text: out.text }],
      },
      async execute(args) {
        try {
          const brief = Boolean(args?.brief)
          const { events } = await readEvents(root)
          const solidIds = solidIdsOf(events, Number(deps.growthDays ?? 30))
          const { rows } = searchEvents(events, args?.query, {
            days: args?.days,
            kind: args?.kind,
            solidIds,
            // 截断放在 searchEvents 里：这样 rows 本身就是短的，
            // 渲染层不必再按栏位切一刀（两处口径会打架）。
            snippet: brief ? RECALL_BRIEF_SNIPPET : RECALL_SNIPPET,
          })
          return { found: rows.length > 0, text: renderRecall(rows, { brief }) }
        } catch {
          // 翻不动就说翻不动，不要装作记得
          return { found: false, text: '你翻了，没翻到。' }
        }
      },
    }),
  )
}
