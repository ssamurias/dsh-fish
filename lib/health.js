/**
 * health.js —— 记忆体检（0.7.6，2026-10-30 用户 m00342）
 *
 * 只读：拿账本按现在的规则算一遍，**不写事件、不改配置、不落任何盘**。
 * 给她本人看的界面里没有这些数——体检是给你（主人）偶尔想知道
 * 「她现在记得清楚吗」用的，不是她的自我指标（那会撞「不读自身数值」）。
 *
 * 报四件事：
 *   1. 两句话对不上（认知矛盾）——复用 deriveSelf 的 tensions，不另算一套口径；列前几处，另给总数；
 *   2. 冷掉的判断——没固化、又很久没被提起或检验的那些，大概率正在被忘；
 *   3. 快固化的——再被提起一次 / 被检验一次就固定下来了；
 *   4. 总量——多少条记录、跨多少天、都是些什么类型。
 */

import { deriveSelf } from './derive.js'

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

  if (!list.length) {
    return {
      ok: true, empty: true, events: 0, days: 0, beliefs: 0, solid: 0,
      byType, tensions: [], stale: [], nearSolid: [], staleDays,
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
  // 掉档的那些不算"快固化"——它们不是差一口气，是已经长成过又淡了（下面「冷掉」那段报）。
  // 先算它：已经在这里的，不再报成「冷掉」（issue #67），同一句话不该同时快固定又快被忘。
  const nearAll = dedupeByText(ranked
    .filter((b) => !b.solid && !b.eligible && (Number(b.mentions) >= 2 || Number(b.verified) >= 1))
    .sort((a, b) => (Number(b.mentions) + Number(b.verified)) - (Number(a.mentions) + Number(a.verified)))
    .map((b) => ({
      text: String(b.text ?? ''),
      mentions: Number(b.mentions ?? 0),
      verified: Number(b.verified ?? 0),
    })))
  const nearTexts = new Set(nearAll.map((n) => n.text.trim()))
  const nearSolid = nearAll.slice(0, HEALTH_LIST)

  // 冷掉：没固化 + 很久没被提起，也不在上面的快固化里。
  //
  // 天数按最后一次被提起或被检验的时间算（derive 的 lastTouchedAt），不是第一次说出口的 since（issue #67）：
  // 原来 30 天前说过、昨天又说了一遍的那句，会同时出现在「冷掉」和「快固化」里。
  // lastTouchedAt 是 0 表示事件时间解析不出来（手写 fixture），退回 since。
  //
  // 2026-11-02（用户 m00335）：原来这里 filter 的是 `!b.solid`，于是**固化过的判断
  // 在体检里是隐形的**——既不会报"冷掉"，也不会报"快固化"。而 solid 原本只增不减，
  // 结果就是最早攒够次数的那批永久占着前 8 个位置、在体检里还查无此人。
  // 现在 solid 会掉档（derive 的 SOLID_STALE_DAYS），这里同步区分两种冷：
  //   faded=true  —— 曾经固化、后来淡下来的（"长成了又淡了"）
  //   faded=false —— 一直没长成的
  const stale = dedupeByText(ranked
    .filter((b) => !b.solid && !nearTexts.has(String(b.text ?? '').trim()))
    .map((b) => {
      const touched = Number(b.lastTouchedAt) > 0 ? Number(b.lastTouchedAt) : Date.parse(String(b.since ?? ''))
      return {
        text: String(b.text ?? ''),
        since: b.since ?? null,
        days: Number.isFinite(touched) ? Math.max(0, Math.floor((now - touched) / DAY_MS)) : null,
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
    // 总数，不是截断后的列表长度（issue #67）：derive 的 solid 列表最多 8 条。
    solid: Number(model?.facts?.solidTotal ?? (Array.isArray(model?.solid) ? model.solid.length : 0)),
    faded: Array.isArray(model?.faded) ? model.faded.length : 0,
    byType,
    // tensions 只列前 HEALTH_TOP 处；tensionsTotal 是按两句原话去重后的总数（derive 的 tensionsTotal）。
    tensions,
    tensionsTotal: Math.max(tensions.length, Number(model?.facts?.tensionsTotal ?? tensions.length)),
    stale,
    nearSolid,
    staleDays,
    solidStaleDays: Number(model?.facts?.solidStaleDays ?? 0),
  }
}
