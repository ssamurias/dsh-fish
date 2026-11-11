/**
 * health.js —— 记忆体检（0.7.6，2026-10-30 用户 m00342）
 *
 * 只读：拿账本按现在的规则算一遍，**不写事件、不改配置、不落任何盘**。
 * 给她本人看的界面里没有这些数——体检是给你（主人）偶尔想知道
 * 「她现在记得清楚吗」用的，不是她的自我指标（那会撞「不读自身数值」）。
 *
 * 报四件事：
 *   1. 两句话对不上（认知矛盾）——复用 deriveSelf 的 tensions，不另算一套口径；
 *   2. 冷掉的判断——没固化、又很久没被提起的那些，大概率正在被忘；
 *   3. 快固化的——再被提起一次 / 被检验一次就固定下来了；
 *   4. 总量——多少条记录、跨多少天、都是些什么类型。
 */

import { deriveSelf } from './derive.js'
import { parseGuardLine } from './guardlog.js'

const DAY_MS = 86_400_000

/** 超过这么多天没被提起、又没固化的判断，算「冷掉」。 */
export const STALE_DAYS = 21
/** 矛盾最多列几条。 */
export const HEALTH_TOP = 3
/** 冷掉 / 快固化各最多列几条。 */
export const HEALTH_LIST = 5
/** 类型构成最多列几行。 */
export const HEALTH_TYPES = 8

function tsOf(ev) {
  const t = Date.parse(String(ev?.ts ?? ''))
  return Number.isFinite(t) ? t : 0
}

/** 一周的窗口（S-A 的三个数都按这个窗口算，和睡前卡的「这一周」同尺度）。 */
const WEEK_MS = 7 * DAY_MS
/** 「一天内翻面」里那个「一天」。 */
const FLIP_WINDOW_MS = DAY_MS

/**
 * 拦住过几次（0.9.9 S-A）。只数 `meta` 里 `guard:rewrite` / `guard:secret` 的条数，
 * 被拦的原文**不在事件流里**，所以这里也不可能把它读出来。
 */
function guardCounts(list, from) {
  const out = { rewrite: 0, secret: 0 }
  for (const ev of list) {
    if (String(ev?.type ?? '') !== 'meta') continue
    const kind = parseGuardLine(ev?.text) // 与写入口同一处口径（lib/guardlog.js）
    if (!kind) continue
    const at = tsOf(ev)
    if (at && at < from) continue
    out[kind] += 1
  }
  return out
}

/** 改口几次，以及是「修正」还是「推翻」（S-A）。 */
function reviseStats(list, from) {
  const out = { week: 0, refined: 0, refuted: 0 }
  for (const ev of list) {
    if (String(ev?.type ?? '') !== 'revise') continue
    const at = tsOf(ev)
    if (at && at < from) continue
    out.week += 1
    if (ev?.verdict === 'refuted') out.refuted += 1
    else if (ev?.verdict === 'refined') out.refined += 1
  }
  return out
}

/**
 * 一天内翻面（S-A）：同一条旧判断在 24 小时内被改了两次、且两次方向相反。
 * 这是「认知突变」里唯一能用纯计数抓到的一类——不判断对错，只数次数。
 */
function flipCount(list, from) {
  const byTarget = new Map()
  for (const ev of list) {
    if (String(ev?.type ?? '') !== 'revise') continue
    const at = tsOf(ev)
    if (!at || at < from) continue
    const target = Array.isArray(ev?.refs) ? String(ev.refs[0] ?? '') : ''
    if (!target) continue
    const verdict = ev?.verdict === 'refuted' ? 'refuted' : ev?.verdict === 'refined' ? 'refined' : ''
    if (!verdict) continue
    if (!byTarget.has(target)) byTarget.set(target, [])
    byTarget.get(target).push({ at, verdict })
  }
  let flips = 0
  for (const rows of byTarget.values()) {
    rows.sort((a, b) => a.at - b.at)
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].at - rows[i - 1].at <= FLIP_WINDOW_MS && rows[i].verdict !== rows[i - 1].verdict) flips += 1
    }
  }
  return flips
}

/** 同一句话被说过几次时，事件流里会有几条判断——报告里只列一条，免得读起来像复读。 */
function dedupeByText(rows) {
  const seen = new Set()
  const out = []
  for (const r of rows) {
    const key = String(r.text ?? '').trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}

/**
 * @param {Array} events 事件流（只读）
 * @param {{now?:number, growthDays?:number, staleDays?:number}} opts
 */
export function examine(events = [], { now = Date.now(), growthDays = 30, staleDays = STALE_DAYS } = {}) {
  const list = Array.isArray(events) ? events.filter(Boolean) : []

  // 类型构成：meta 是系统便签（seen/react/rotate…），不是她记下的东西，不参与展示。
  const counts = new Map()
  for (const ev of list) {
    const type = String(ev?.type ?? '')
    if (!type || type === 'meta') continue
    counts.set(type, (counts.get(type) || 0) + 1)
  }
  const byType = [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
    .slice(0, HEALTH_TYPES)

  const stamps = list.map(tsOf).filter((t) => t > 0)
  const first = stamps.length ? Math.min(...stamps) : now
  const days = Math.max(0, Math.ceil((now - first) / DAY_MS))

  const weekFrom = now - WEEK_MS

  if (!list.length) {
    return {
      ok: true, empty: true, events: 0, days: 0, beliefs: 0, solid: 0,
      byType, tensions: [], stale: [], nearSolid: [], staleDays,
      tensionsTotal: 0,
      // S-A（0.9.9）：还没记录那些数的字段照给 0，别让界面按 undefined 渲染。
      guards: { rewrite: 0, secret: 0 }, revises: { week: 0, refined: 0, refuted: 0 }, flips: 0,
    }
  }

  const model = deriveSelf(list, { growthDays })
  const ranked = Array.isArray(model?.ranked) ? model.ranked : []

  // 同一对判断可能被正反各报一次（detectTensions 两个方向都会看）——按无序对去重，别让一对占两行。
  const seenPairs = new Set()
  const tensions = (Array.isArray(model?.tensions) ? model.tensions : [])
    .map((t) => ({
      a: String(t?.a?.text ?? ''),
      b: String(t?.b?.text ?? ''),
      sim: Number(t?.sim ?? 0),
    }))
    .filter((t) => {
      if (!t.a || !t.b) return false
      const key = [t.a, t.b].sort().join('\u0000')
      if (seenPairs.has(key)) return false
      seenPairs.add(key)
      return true
    })
    .slice(0, HEALTH_TOP)

  // 快固化：差一次提起（mentions 2）或差一次检验（verified 1）。
  // 掉档的那些不算"快固化"——它们不是差一口气，是已经长成过又淡了（上面那段报）。
  const nearSolid = dedupeByText(ranked
    .filter((b) => !b.solid && !b.eligible && (Number(b.mentions) >= 2 || Number(b.verified) >= 1))
    .sort((a, b) => (Number(a.mentions) + Number(a.verified)) - (Number(b.mentions) + Number(b.verified)))
    .map((b) => ({
      text: String(b.text ?? ''),
      mentions: Number(b.mentions ?? 0),
      verified: Number(b.verified ?? 0),
    })))
    .slice(0, HEALTH_LIST)
  const nearSolidText = new Set(nearSolid.map((x) => x.text))

  // 冷掉：没固化 + 形成得够久，按**最后一次被提起/检验**算（issue #67）。
  // 原来用 since（第一次说这句话的时间），昨天刚被提起的判断会同时出现在
  // 「快被忘掉」和「快固定下来」里，自相矛盾。derive 已经算好 lastTouchedAt。
  // 已在 nearSolid 里的也排除——它差一口气，不是快被忘掉。
  const stale = dedupeByText(ranked
    .filter((b) => !b.solid && !nearSolidText.has(String(b.text ?? '')))
    .map((b) => {
      const touched = Number(b.lastTouchedAt)
      const t = Number.isFinite(touched) && touched > 0 ? touched : Date.parse(String(b.since ?? ''))
      return {
        text: String(b.text ?? ''),
        since: b.since ?? null,
        days: Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / DAY_MS)) : null,
        // eligible 是 derive 新给的字段：够格固化过。老 fixture 没有就是 false。
        faded: Boolean(b.eligible),
      }
    })
    .filter((b) => b.days !== null && b.days >= staleDays)
    .sort((a, b) => b.days - a.days))
    .slice(0, HEALTH_LIST)

  return {
    ok: true,
    // 连一条判断都还没形成时，别说「一切正常」——说还太早。
    empty: ranked.length === 0,
    events: list.length,
    days,
    beliefs: ranked.length,
    // issue #67：界面印的是总数，不是列表截断后的 8 条。
    solid: Number(model?.solidTotal ?? (Array.isArray(model?.solid) ? model.solid.length : 0)),
    tensionsTotal: Number(model?.tensionsTotal ?? tensions.length),
    faded: Array.isArray(model?.faded) ? model.faded.length : 0,
    byType,
    tensions,
    stale,
    nearSolid,
    staleDays,
    solidStaleDays: Number(model?.facts?.solidStaleDays ?? 0),
    // S-A（0.9.9）：三个「本周」的数。只报数、不下结论，也不进她的 context。
    guards: guardCounts(list, weekFrom),
    revises: reviseStats(list, weekFrom),
    flips: flipCount(list, weekFrom),
  }
}
