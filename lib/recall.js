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
 * 2026-11-08（用户 m00187）又改了三处，仍然只动排序、不碰存储：
 *   5. idf 加权：到处都是的词（事情 / 说过）不再跟罕见的词一样值分。
 *   6. 字面量整串比：`0.9.3` / `snapshot.json` 不再被切成碎片到处误撞。
 *   7. 新旧折算：字面命中相同时，昨天的先于三个月前的；判断类永不折。
 */

import { toJsonSchema } from './toolschema.js'
import { rootDir, readEvents } from './store.js'
import { deriveSelf } from './derive.js'
import { normalizeScene, localDaysAgo } from './schema.js'
import { dateKey } from './settings.js'
import { anchorOf } from './anchor.js'
import { parseWatchedLine, parseLookLine } from './whatseen.js'
import { fillOwner } from './pronoun.js'

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

/**
 * 唯一放行的 meta：工具使用经验（2026-11-07，用户 m00882）。
 *
 * 其余 meta 是系统账（看过什么、被叫醒几次、扫到几条回复），翻出来只会把
 * 她自己的经历淹掉。而 `use:` 那几条记的是「这件事我是怎么做成的」——
 * 那正好是她翻旧事时最缺的一种。
 */
export const USE_PREFIX = 'use:'
const isUseLine = (ev) => String(ev?.text ?? '').startsWith(USE_PREFIX)

/**
 * 第二类放行的 meta：她看过什么（2026-11-09 0.9.7 T3；2026-11-12 issue #133）。
 *
 * 三种记账，口径以 `lib/whatseen.js` 为准：
 *   `watched:<日期> <bvid> {json}`  —— 真抽了帧、看过画面（唯一凭证）
 *   `look:<日期> <bvid> {json}`     —— 点开过（有标题，没画面）
 *   `looked:<bvid> <标题>`          —— 在列表里看见过 / 点开过
 *
 * 原来只放行**带标题的** `looked:`。结果是 issue #133 报的那个洞：翻得到
 * 「看过标题」，翻不到「看过画面」——而后者才是她自己的经历；`look:` 与
 * 没带标题的老 `looked:`（0.9.7 前）也一起被跳过了。
 *
 * 安静刷写的 `browsed:` 仍然不放行：那一趟她没看见，是系统账。
 */
export const LOOKED_LINE = /^looked:(\S+)(?:\s+([\s\S]+))?$/
const LOOK_GENERIC = /^look:(\S+)(?:\s+([\s\S]+))?$/

/** 同一天同一条视频最多摆一行：留分量最重的那个（issue #133 的 5）。 */
const SEEN_WEIGHT = { watched: 3, look: 2, looked: 1 }

const titleOf = (info) => (info && typeof info.title === 'string' ? info.title.trim() : '')

// JSON 被截断时退回按字段抠标题：brief 档只有 40 字，`look:` 后面那整段
// 早不是一个合法对象了，但「点开的是哪条」还得读得出来（issue #133）。
const TITLE_JSON = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/
function titleFromText(text, info) {
  const title = titleOf(info)
  if (title) return title
  const m = TITLE_JSON.exec(String(text ?? ''))
  if (!m) return ''
  try {
    return JSON.parse(`"${m[1]}"`).trim()
  } catch {
    return m[1].trim()
  }
}

/** 这条「看过什么」翻成人话。三种路子要分得开，别把点开说成看过画面。 */
function seenLabel({ kind, bvid, title }) {
  const tail = title ? `：《${title}》` : `（${bvid}，当时没记下标题）`
  if (kind === 'watched') return `你那天看过画面${tail}`
  if (kind === 'look') return `你那天点开过${tail}`
  return `你那天看过${tail}`
}

/**
 * 把一条 meta 认成「她看过什么」的记录；不是就返回 null。
 * 老形状（`look:BV…`、`watched:<日期> BV…` 没带 JSON）也要认——记忆不能因为
 * 当时没记标题就凭空少一条。
 */
export function seenOf(ev) {
  if (ev?.type !== 'meta') return null
  const text = String(ev?.text ?? '').trim()
  const w = parseWatchedLine(text)
  if (w) return { kind: 'watched', dk: w.dk, bvid: w.bvid, title: titleFromText(text, w.info) }
  const k = parseLookLine(text)
  if (k) return { kind: 'look', dk: k.dk, bvid: k.bvid, title: titleFromText(text, k.info) }
  const l = LOOKED_LINE.exec(text)
  if (l) return { kind: 'looked', dk: '', bvid: l[1], title: String(l[2] ?? '').trim() }
  // v0.8.0–0.8.7 的 look: 没带日期：`look:BV…`
  const g = LOOK_GENERIC.exec(text)
  if (g) return { kind: 'look', dk: '', bvid: g[1], title: '' }
  return null
}

const isSeenLine = (ev) => Boolean(seenOf(ev))

/**
 * 素材索引（1.0.0，用户 m05089）：mat:bili:<bvid> {t,d,q:[{b,x}]}。
 * 只认能读出至少一句原话的行——读不出话的索引对她没有意义。
 */
export const MAT_LINE = /^mat:bili:(\S+)\s+(\{[\s\S]*\}$)/
function matOf(ev) {
  if (ev?.type !== 'meta') return null
  const m = MAT_LINE.exec(String(ev?.text ?? '').trim())
  if (!m) return null
  try {
    const payload = JSON.parse(m[2])
    const quotes = Array.isArray(payload?.q) ? payload.q : []
    const first = quotes.find((q) => String(q?.x ?? '').trim())
    if (!first) return null
    return {
      bvid: m[1],
      title: String(payload?.t ?? '').trim(),
      date: String(payload?.d ?? '').trim(),
      quote: String(first.x).trim(),
      by: String(first.b ?? '').trim(),
    }
  } catch {
    return null
  }
}
const isMatLine = (ev) => Boolean(matOf(ev))

/**
 * 第三类放行的 meta：她真的动过手（2026-11-14，用户 m01618）。
 *
 * `use:` 只包得住插件自己的 12 件工具；别人放行的写代码/看小说/玩游戏工具
 * 她用了也不会留下 `use:`。`did:` 是动手回合里按 tools/result 写的账，
 * 记的是「这件事是用哪件工具做的、成没成」——不放行的话，她做完就翻不到，
 * 「做过 → 记得 → 下次还做」这条回路是断的。
 *
 * 形状见 lib/doing.js：`did:<cls>:<tool>:ok|fail:<key>`。
 */
export const DID_LINE = /^did:(?:produce|consume|effect|self):([^:\s]+):(ok|fail):([\s\S]*)$/
const isDidLine = (ev) => ev?.type === 'meta' && DID_LINE.test(String(ev?.text ?? '').trim())

/** 2026-11-13 → 11 月 13 日；不是这个形状就原样返回。 */
function mmdd(dk) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dk)
  return m ? `${Number(m[2])} 月 ${Number(m[3])} 日` : dk
}

/** 这条事件进不进回忆。 */
const usable = (ev) => Boolean(ev) && (!SKIP_TYPES.has(ev.type) || isUseLine(ev) || isSeenLine(ev) || isMatLine(ev) || isDidLine(ev))

const DAY_MS = 86_400_000

/**
 * 这条只是「在对话里说过」，还是她自己认领写下的。
 *
 * `turns.js` 的 `settle()` 会把一轮里她说的话补写成 `utterance` 并打
 * `flags:['uncommitted']`，注释写的是「只留证，不当信念」。它跟
 * `growth_commit` 里认领下来的话在事件流里长得差不多，她翻旧事时
 * 分不出哪个是自己认真写下的（2026-11-04 群反馈第二条、第三条）。
 */
const chatOnly = (ev) => Array.isArray(ev?.flags) && ev.flags.includes('uncommitted')

/** 事件时刻 → 本地 HH:MM（与 report.js / inbox.js 同一口径） */
function localClock(ts) {
  // 调用方传进来的是已经 parse 过的毫秒数（searchEvents 里的 `ts`），
  // 也可能有手写 fixture 直接给 ISO 串——两种都认。
  const n = typeof ts === 'number' ? ts : Date.parse(String(ts ?? ''))
  if (!Number.isFinite(n)) return ''
  const d = new Date(n)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// 按 UTF-16 截时别把 emoji 切成半个：写进文件就是乱码。
const clip = (text, n) => (text.length > n ? text.slice(0, n - 1).replace(/[\uD800-\uDBFF]$/, '') + '…' : text)

// 一条一行：正文里的换行会把行尾的 id 挤到下一行，也会把缩进的关系行拆开。
const oneLine = (text) => text.replace(/\s+/g, ' ').trim()

/** `use:<工具> ok|fail <一句话>`——见 lib/use.js */
const USE_LINE = /^use:(\S+)\s+(ok|fail)\s*(.*)$/

/** 不是她自己写下的，要说清来路 */
function labelled(type, text, scene = '') {
  // heard 是旁听来的：明确写成「他说」，别让她误以为是自己说的。
  // 2026-11-08（用户 m00394）：群聊里他本人的那句也记，但要读得出来是在哪儿说的——
  // 不标的话，她翻到会以为那是只对她一个人说的。
  if (type === 'heard') {
    return normalizeScene(scene) === 'group' ? `{T}在群里说：${text}` : `{T}说：${text}`
  }
  // voice、answer 同理：一句是读到的陌生人的话，一句是别人回她的。
  if (type === 'voice') return `读到别人说：${text}`
  if (type === 'answer') return `回复：${text}`
  // 工具使用经验（2026-11-07，用户 m00882）：账里存的是机器写法，
  // 读出来得是一句人话——「用过 her_note，记下了：…」。
  if (type === 'meta') {
    // issue #133：三种记账翻出来都要读得成人话，而且「看过画面」和「只点开过」
    // 必须分得开——原来只有带标题的 looked: 有这一行，watched: 那条唯一凭证
    // 反而翻不到，她只好把「看过标题」说成「看过」。
    // 素材索引（1.0.0，用户 m05089）：她看过的那几句原话。
    const mat = matOf({ type, text })
    if (mat) {
      const when = mat.date ? `在 ${mmdd(mat.date)}` : '那天'
      const of = mat.title ? `《${mat.title}》` : '一条视频'
      return `你${when}看过${of}，里面有一句：「${mat.quote}」`
    }
    const seen = seenOf({ type, text })
    if (seen) return seenLabel(seen)
    // 她真的动过手（2026-11-14，用户 m01618）：`did:` 记的是工具名与做成/没成，
    // 翻出来要能当「我做过这件事」用，不能还是机器写法。
    const d = DID_LINE.exec(text)
    if (d) {
      const [, tool, head, rawKey] = d
      const key = String(rawKey ?? '').trim()
      const shown = key.startsWith(`${tool}:`) ? key.slice(tool.length + 1) : key
      if (head === 'fail') return `你用 ${tool} 试过${shown ? `：${shown}` : '一件事'}，没成`
      return `你用 ${tool} 做成了一件事${shown ? `：${shown}` : ''}`
    }
    const m = USE_LINE.exec(text)
    if (m) {
      const [, tool, head, said] = m
      // issue #133 的 C：划掉便条那行账现在带着原话（lib/note.js 的 closeNote），
      // 翻出来别写成「用过 her_note，已划掉：…」，那是操作记录的口吻；
      // 她那天是做完了一件事。
      if (tool === 'her_note' && head === 'ok' && said.startsWith('已划掉：')) {
        return `你那天做完：${said.slice('已划掉：'.length)}`
      }
      return head === 'fail' ? `用过 ${tool}，没成：${said}` : `用过 ${tool}，${said}`
    }
  }
  return text
}

/** 她说了但没认领。标在最后，所以要等截断之后再加，不然句子一长标记就被截掉了。 */
const CHAT_MARK = '｜聊天里说的'

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
 * 字面量：版本号、文件名、命令、路径、工具名（2026-11-08，用户 m00187 第 2 条）。
 *
 * 为什么单拎出来：中文二字切片会把「0.9.3的坑」切成 `0.` / `.9` / `9.` / `.3` /
 * `3的` / `的坑` 六片，把 `snapshot.json` 切成 snapshot / json。碎片到处误撞，
 * 真正记着这件事的那条反而只拿两分，被一堆不相干的条目挤到八条以外。
 * 所以先把这些「不该被切开的东西」整串抽出来，按整串比。
 */
const LITERAL_RE = /[A-Za-z0-9][A-Za-z0-9_.\-/:#]{1,}/g

export function literalsOf(text) {
  const out = new Set()
  for (const m of String(text ?? '').matchAll(LITERAL_RE)) {
    const w = m[0]
    // 纯数字不算：年份、条数、「第 3 条」到处都是，当字面量只会误伤。
    if (/^\d+$/.test(w)) continue
    // 普通英文单词不算（ok / deepseek）：它们靠整词与二字切片就够，
    // 只有带数字或分隔符的才真有「不能切开」的价值。
    if (!/[0-9._\-/:#]/.test(w)) continue
    out.add(w.toLowerCase())
  }
  return [...out]
}

/** 整串命中一个字面量值多少分：压得过一个两字切片，压不过「她问的那件事整句都在里面」。 */
export const LITERAL_BONUS = 3
/** 查询里带着字面量却一个都没对上时的折算：多半不是这一条。 */
export const LITERAL_MISS = 0.3

/** 把字面量从查询里抠掉，剩下的再切二字——免得碎片再进候选池。 */
function stripLiterals(text, lits) {
  let s = String(text ?? '')
  for (const l of lits) {
    const safe = l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    s = s.replace(new RegExp(safe, 'gi'), ' ')
  }
  return s
}

/**
 * 一个词的分量（2026-11-08，用户 m00187 第 1 条）。
 *
 * 原来「长片段算长度、两字切片算 1」，于是「事情」「说过」这种几乎每条都有的词
 * 和「疤」一样值 1 分。并列时按时间倒序排——最后赢的永远是最新的那条，
 * 三个月的真话被昨天的闲话挤掉。
 *
 * idf 的做法：越少条目里出现的词越值钱。取值压到 [0.6, 1.0]：
 * 常见词打六折，罕见词不打折。地板不再压低——压到 0.4 会把整条的分一起
 * 缩掉，显著性那 +4 就变相变重，把「她问的那件事整句都在里面」盖过去了。
 */
export const IDF_FLOOR = 0.6
export const IDF_CEIL = 1.0

function idfWeight(df, n) {
  if (!(n > 1)) return 1
  const raw = Math.log(1 + n / (1 + Math.max(0, df))) / Math.log(1 + n)
  const v = IDF_FLOOR + (IDF_CEIL - IDF_FLOOR) * raw
  return Math.min(IDF_CEIL, Math.max(IDF_FLOOR, v))
}

/**
 * 旧事该折多少（2026-11-08，用户 m00187 第 3 条）。
 *
 * 她要的是「昨天做的和三个月前说的，在字面命中相同时，昨天先」——
 * 不是「旧事消失」。所以有地板 0.55：再旧也留一半多，八条里挤得进去。
 *
 * 半衰期分两档：工具账、旁听、别人的话（meta / heard / voice）是快消品，45 天；
 * 她自己的话、日记、叙事、梦是长存的，180 天。
 * 检验、改口、拒绝、答话永不折——那几类记的是判断本身，不该因为旧了就让位。
 */
export const FRESH_FLOOR = 0.55
export const HALF_LIFE_FAST_MS = 45 * DAY_MS
export const HALF_LIFE_SLOW_MS = 180 * DAY_MS

const NEVER_FADE = new Set(['test', 'revise', 'refusal', 'answer'])

export function halfLifeOf(ev) {
  const t = String(ev?.type ?? '')
  return t === 'meta' || t === 'heard' || t === 'voice' ? HALF_LIFE_FAST_MS : HALF_LIFE_SLOW_MS
}

export function freshnessOf(ev, { now = Date.now(), ts, solid } = {}) {
  const at = Number.isFinite(ts) ? ts : Date.parse(String(ev?.ts ?? ''))
  if (!Number.isFinite(at)) return 1
  if (NEVER_FADE.has(String(ev?.type ?? ''))) return 1
  // 固化过的那几条是她的判断，不随时间让位（它另有 +3，这里不重复加）。
  if (solid?.has?.(String(ev?.id))) return 1
  const age = Math.max(0, now - at)
  return FRESH_FLOOR + (1 - FRESH_FLOOR) * Math.exp(-age / halfLifeOf(ev))
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

/**
 * 每条事件最近一次被哪条 revise 改过。
 *
 * 为什么要有（2026-11-04，issue #23）：`refCounts` 把 revise 的 refs 也数成
 * 「被检验过」，于是**被推翻的那句反而加权排到第一**——她翻到自己早就推翻的话，
 * 只能当它还算数，因为结果里 revise 和它改掉的那句毫无关系。
 */
function latestRevisions(events = []) {
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
 * @param {string} query 找什么。空 = 按时间摆最近的（`o.days` 决定窗口）
 * @param {{days?:number, limit?:number, now?:number, kind?:string, solidIds?:Set<string>|string[], weigh?:boolean}} o
 *   days: 0 或不传 = 全部；kind: 只看某一类；weigh: false = 不加显著性权重（测试/排查用）
 * @returns {{rows:{id:string,date:string,type:string,text:string,ago:number}[], total:number, truncated:boolean, timeline:boolean}}
 *   total/truncated：这次一共命中几条、摆出来的够不够（issue #133 的 B）。
 *   timeline：true = 这次没给关键词，按时间翻的。
 */
export function searchEvents(events, query, o = {}) {
  const lits = literalsOf(query)
  // 字面量先抠掉再切二字：不然 `0.9.3` 的碎片照样进候选池。
  const toks = tokensOf(stripLiterals(query, lits))
  // 一个字都没给 = 按时间翻（2026-11-12，用户 m00497）。
  // 原来这里直接返回空：她只有「猜一个关键词」一条路，想「把上周我说过的话摆出来」
  // 做不到。现在空 query 走时间线——不加分、不挑，只按时间从近到远摆。
  const timeline = !toks.length && !lits.length
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

  // 先把候选筛出来。同一份候选既用来算 df 又用来打分——两个口径必须一致，
  // 否则 idf 是拿另一批事件算出来的，词的分量就成了猜的。
  const cand = []
  for (const ev of events ?? []) {
    if (!usable(ev)) continue
    if (kind && String(ev.type) !== kind) continue
    const text = String(ev.text ?? '').trim()
    if (!text) continue
    const ts = Date.parse(ev.ts)
    if (!Number.isFinite(ts) || ts < since) continue
    cand.push({ ev, text, ts, lower: text.toLowerCase() })
  }

  // df：这批候选里有多少条出现过这个词。见 idfWeight() 上面那段。
  const df = new Map()
  for (const t of toks) {
    let hit = 0
    for (const c of cand) if (c.lower.includes(t)) hit++
    df.set(t, hit)
  }

  const scored = []
  // 时间线不打分：分数只在「她给了一个词」的时候才有意义。空 query 时下面这段
  // 整个跳过，候选按时间从近到远摆。
  if (timeline) {
    for (const { ev, text, ts } of cand) scored.push({ rank: 0, score: 0, ts, ev, text })
  }
  if (!timeline) for (const { ev, text, ts, lower } of cand) {
    let score = 0
    for (const t of toks) {
      if (!lower.includes(t)) continue
      // 长片段更值钱：两字切片只算 1，整词算它自己的长度；
      // 再乘这个词在候选里的分量——到处都有的词几乎不说明什么。
      const base = t.length >= 3 ? t.length : 1
      score += base * idfWeight(df.get(t) ?? 0, cand.length)
    }

    // 字面量按整串比，不切碎片。
    let litHits = 0
    for (const l of lits) {
      if (!lower.includes(l)) continue
      litHits++
      score += LITERAL_BONUS
    }
    if (score <= 0) continue
    // 她问的那句带着版本号 / 文件名，却一个都没对上——多半不是这一条。
    if (lits.length && litHits === 0) score *= LITERAL_MISS

    // 显著性：字面命中之后，重要/被检验过的排前面。
    // 幅度刻意压小（最多 +6）：不能盖过「她问的那件事正好在里面」。
    // 2026-11-08（用户 m00187 第 3 条）：先按新旧折一次，再叠 +4/+3。
    // 折的是「这件事多久没被提起」；必须折在显著性之前，否则 +4 一加，
    // 三个月前的和昨天的又一样重了。
    if (weigh) score *= freshnessOf(ev, { now, ts, solid })
    let rank = score
    if (weigh) {
      // 2026-11-04（群反馈第三条）：认领过的话排在自己的聊天原话前面。
      // 幅度取 +4：要压得过「只靠 solid 的认领（+3）」，又不能压过字面命中差得多的。
      // 聊天原话不给这一分，它靠字面命中自己争。
      if (!chatOnly(ev)) rank += 4
      if (solid.has(String(ev.id))) rank += 3
      // issue #23：她已经推翻的话不算「被检验过」，不管之前被引用过几次。
      // 原来 refCounts 把 revise 的 refs 也数进去，于是被推翻的旧话反而排到第一——
      // 她翻到自己早就不要的说法，只能当它还算数。
      if (revisions.get(String(ev.id))?.verdict !== 'refuted') rank += Math.min(3, refs.get(String(ev.id)) ?? 0)
    }
    scored.push({ rank, score, ts, ev, text })
  }

  // 时间线按时间；关键词按相关度，同分才看新旧。
  if (timeline) scored.sort((a, b) => b.ts - a.ts)
  else scored.sort((a, b) => b.rank - a.rank || b.ts - a.ts)

  // issue #133 的 5：同一条视频会落两三行（looked: 没日期 / look: / watched:）。
  // 全摆出来是同一条占三个名额，还让她以为那天看了三条。按 bvid 只留分量最重的
  // 那个；同分量（重复记账）只留排序靠前的第一条。
  const best = new Map()
  for (const s of scored) {
    const info = seenOf(s.ev)
    if (!info) continue
    const key = info.bvid
    const w = SEEN_WEIGHT[info.kind] ?? 0
    if (w > (best.get(key) ?? 0)) best.set(key, w)
  }
  const kept = []
  const taken = new Set()
  for (const s of scored) {
    const info = seenOf(s.ev)
    if (info) {
      const key = info.bvid
      if (taken.has(key) || (SEEN_WEIGHT[info.kind] ?? 0) < best.get(key)) continue
      taken.add(key)
    }
    kept.push(s)
  }

  // 改口关系不受 days、kind 影响：被改的那句在时间窗外，也照样引出来。
  const byId = new Map()
  if (revisions.size) {
    for (const ev of events ?? []) if (usable(ev)) byId.set(String(ev.id), ev)
  }
  const said = (ev, verdict) => ({
    id: String(ev.id ?? ''),
    verdict: verdict ?? null,
    // 引用也要说清来路：不然别人的话引出来就像她自己说过的。字数只算原话，来路另算。
    text: labelled(String(ev.type ?? ''), clip(oneLine(String(ev.text ?? '')), RECALL_BRIEF_SNIPPET), ev.scene) + (chatOnly(ev) ? CHAT_MARK : ''),
  })
  const rows = kept.slice(0, limit).map(({ ts, ev, text }) => {
    const seen = seenOf(ev)
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
      // 2026-11-04（群反馈第二条）：同一天里说过两句话，光有日期她分不清先后，
      // 更分不清哪句是后来改的口。这里补上本地时分（与报告、日记同一套口径）。
      clock: localClock(ts),
      // 按本地日历日数：同一行里的 date 走本地钟，括号里的天数要跟它对得上。
      ago: localDaysAgo(ts, now),
      type: String(ev.type ?? ''),
      // 场次（2026-11-08，用户 m00394）：群聊里他说的那句要在渲染时读得出来。
      scene: String(ev.scene ?? ''),
      // 她动手之前说的那句话（2026-11-07，用户 m00493 的 ⑤）。
      // 只对工具账算：别的行本身就是话，不需要来路。
      anchor: String(ev.type) === 'meta' ? anchorOf(events, ev.sessionId, ts) : '',
      // 聊天里随口说的，跟她自己认领写下的话分开标。heard 已经有「他说：」的先例，
      // 这边沿用同一套：能标出来源就标出来源，别让她把别人/随口当成自己写下的。
      chatOnly: chatOnly(ev),
      // 改口关系：refs 指向被改的那几条，verdict 说明是推翻还是修正。
      verdict: String(ev.verdict ?? ''),
      refs: Array.isArray(ev.refs) ? ev.refs.map(String) : [],
      // issue #23：关系单独成行，并带上对方原话开头。
      // her_recall 不能按 id 查——只给 id 她翻不到，等于还得猜。
      ...(last ? { later: said(last, last === next ? next.verdict : null) } : {}),
      ...(earlier ? { earlier: said(earlier, ev.verdict) } : {}),
      // issue #133：seen 行先翻成人话再截断。`look:`/`watched:` 后面挂着整段
      // JSON，先截再翻会把标题连 JSON 一起截坏，brief 档里只剩一个 BV 号。
      text: fillOwner(clip(oneLine(seen ? seenLabel(seen) : text), snippet)),
    }
  })
  return { rows, total: kept.length, truncated: kept.length > rows.length, timeline }
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

/**
 * 渲染成她能读的一段（不是 JSON）
 *
 * 2026-11-04（群反馈第二条、第三条）改了三处展示口径：
 *   1. 时间到分钟。原来只有日期，同一天里说过两句矛盾的话，她分不清先后。
 *   2. 改口关系写出来。revise 一直带着 verdict 与 refs，但从来没往外拿过，
 *      于是「我改口了」在回忆里跟普通的一句长得一样（日报里反而一直印着）。
 *   3. 聊天里随口说的标出来。不是不许看，是要让她知道自己当时不是在记东西。
 */
export function renderRecall(rows, o = {}) {
  if (!rows?.length) return '你翻了，没翻到。'
  const brief = Boolean(o.brief)
  // 时间线和她给了词的翻找要分开说：前者是「最近这些」，后者才是「你翻到的」。
  // 混用会让她以为没给关键词也能命中什么。
  const head = brief
    ? '有这些（只报了开头，要看全的再说一次）：'
    : (o.timeline ? '最近这些（从近到远摆的）：' : '你翻到的：')
  const lines = [head]
  for (const r of rows) {
    // id 用小括号挂在最后：她要 revise / narration 时原样抄进来。
    // 没写 id 的老调用方（测试里的手写 fixture）就不显示括号，别凭空造一个。
    const mark = r.id ? `（${r.id}）` : ''
    const ago = Number.isFinite(r.ago) && r.ago > 0 ? `（${r.ago} 天前）` : ''
    const at = r.clock ? `${r.date} ${r.clock}` : r.date
    // 来源标注（heard / voice / answer）与「聊天里说的」分开两件事：
    // 前者是这话不是她说的，后者是她说但没认领。
    let body = labelled(r.type, r.text, r.scene)
    if (brief) body = clip(body, RECALL_BRIEF_SNIPPET)
    // 当时那句话跟在后面：认得出「那次是为了什么」，就不必再猜。
    if (r.anchor) body += `——当时你在说「${r.anchor}」`
    if (r.chatOnly) body += CHAT_MARK
    // 改口关系：有对方原话就另起缩进行；手写 fixture 没有 earlier 数据时
    // 退回旧的一行式说明，别让这层信息静默消失。
    if (r.type === 'revise' && !r.earlier && !r.later) {
      // brief 档不再整体截断这段，所以 id 只报第一个，别让一条变长。
      const refs = Array.isArray(r.refs) ? r.refs : []
      const to = (brief ? refs.slice(0, 1) : refs).join(',')
      const how = r.verdict === 'refuted' ? '推翻了' : r.verdict === 'refined' ? '修正了' : r.verdict === 'confirmed' ? '仍然成立' : '改口'
      body += to ? `（${how} ${to}，那是更早说的）` : `（${how}，那是更早说的）`
    }
    lines.push(`- ${at}${ago}｜${body}${mark}`, ...relationLines(r, brief))
  }
  // issue #133 的 B：这里只摆了 top-k，原来什么都不说，于是「没翻到 / 只翻到这几条」
  // 被她读成「没有这回事」，还会被复述出去。不报条数（报数字等于催她再翻一次），
  // 只说清这不是全集，以及下结论时该怎么用。
  if (o.truncated) {
    lines.push(o.timeline
      ? '（这不是全部，只摆了最近的几条。要判断「没有」「没做过」「没看过」时，别把这份当成全集。）'
      : '（这不是全部，只摆了最相关的几条。要判断「没有」「没做过」「没看过」时，别把这份当成全集。）')
  }
  return fillOwner(lines.join('\n'))
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
        '翻你自己过去记下的事。想提"以前有一次"的时候先用它翻一翻，翻到了再说；翻不到就别编。默认翻全部时间，不只是最近。不记得关键词、只想按时间看看最近发生过什么，就只给 days、不给 query。',
      parameters: toJsonSchema({
        query: { type: 'string', required: false, description: '你想找的是什么，几个词就够。不记得关键词、只想按时间看最近的，就不传它。' },
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
          const { rows, total, truncated, timeline } = searchEvents(events, args?.query, {
            days: args?.days,
            kind: args?.kind,
            solidIds,
            // 截断放在 searchEvents 里：这样 rows 本身就是短的，
            // 渲染层不必再按栏位切一刀（两处口径会打架）。
            snippet: brief ? RECALL_BRIEF_SNIPPET : RECALL_SNIPPET,
          })
          return { found: rows.length > 0, text: renderRecall(rows, { brief, total, truncated, timeline }) }
        } catch {
          // 翻不动就说翻不动，不要装作记得
          return { found: false, text: '你翻了，没翻到。' }
        }
      },
    }),
  )
}
