/**
 * pair.js —— 概念分化（0.9.9 S-C）
 *
 * 她以前只有一种「改口」：新话把旧话推翻或修正，旧的标成 refuted / refined。
 * 这里多一种可能：**两句话都留着**，她发现「这两句我以前当成一件事，其实差在……」。
 *
 * 为什么不和矛盾卡抢同一对（S 设计单 §4.3）：
 *   detectTensions 只收**极性相反**的一对（derive.js 里 `if (polarity(a) === polarity(b)) continue`）；
 *   本文件只收**极性相同**的一对。两个集合在构造上互补，物理上不可能重叠。
 *
 * 排序与去重**照抄 detectTensions 的口径**（sim 降序、平手按 i/j、按两句原话的无序对去重、
 * 最后 slice）——这样两个工具的「同一对」判定永远一致，将来改阈值也只有一处。
 */
import { polarity, similarity } from './derive.js'

const DAY_MS = 86_400_000

function atOf(b, fallback) {
  const t = Date.parse(String(b?.since ?? ''))
  return Number.isFinite(t) ? t : fallback
}

/**
 * @param {Array} beliefs 她当前的判断（model.ranked / model.beliefs 都行，只看 id/text/since）
 * @param {{minSim?:number, maxSim?:number, withinDays?:number, pool?:number, limit?:number, now?:number}} [o]
 * @returns {Array<{a:object,b:object,sim:number,at:string}>}
 */
export function detectDifferentiations(beliefs = [], {
  minSim = 0.5,
  maxSim = 0.9,
  withinDays = 30,
  pool = 60,
  limit = 1,
  now = Date.now(),
} = {}) {
  const list = Array.isArray(beliefs) ? beliefs.filter((b) => b && String(b.text ?? '').trim()) : []
  const n = list.length
  if (n < 2) return []

  const from = now - Math.max(1, Number(withinDays) || 30) * DAY_MS
  const pts = list.map((b, i) => ({ b, at: atOf(b, now), i })).filter((p) => p.at >= from)
  // 这张卡在醒来那条路上同步算，不能让她等：两两比一次是 O(n²)，
  // 2000 条判断实测 33 秒（2026-11-11）。只拿最近 pool 条——
  // 「两面」本来就是最近才看得出来的事，更早的那批留给矛盾卡。
  pts.sort((x, y) => y.at - x.at || x.i - y.i)
  const live = pts.slice(0, Math.max(2, Number(pool) || 60))
  // 排回账本里的先后，下面就和 detectTensions 一样按 i/j 平手。
  live.sort((x, y) => x.i - y.i)
  const hits = []

  for (let x = 0; x < live.length; x++) {
    for (let y = x + 1; y < live.length; y++) {
      const A = live[x]
      const B = live[y]
      const ta = String(A.b.text ?? '')
      const tb = String(B.b.text ?? '')
      if (ta.length < 4 || tb.length < 4) continue
      // 同极性才谈得上「两面」；异极性归矛盾卡，不在这里出现。
      if (polarity(ta) !== polarity(tb)) continue
      // 长度差太远时相似度上界到不了 minSim，先剪掉（省掉绝大多数计算）。
      const lo = Math.min(ta.length, tb.length)
      const hi = Math.max(ta.length, tb.length)
      if (hi > lo * 3) continue
      const sim = similarity(ta, tb)
      if (sim < minSim || sim > maxSim) continue
      hits.push({
        i: Math.min(A.i, B.i),
        j: Math.max(A.i, B.i),
        sim,
        item: {
          a: { id: A.b.id, text: ta, since: A.b.since },
          b: { id: B.b.id, text: tb, since: B.b.since },
          sim: Number(sim.toFixed(2)),
          at: B.b.since || A.b.since,
        },
      })
    }
  }

  // 与 detectTensions 同一套排序：相似度高的在前，平手时按在账本里的先后。
  hits.sort((x, y) => y.sim - x.sim || x.i - y.i || x.j - y.j)

  // 同一句话说过几遍时，每一遍都会和同一句配成一对——按两句原话的无序对去重。
  const seen = new Set()
  const unique = []
  for (const h of hits) {
    const a = String(h.item.a?.text ?? '')
    const b = String(h.item.b?.text ?? '')
    const key = a <= b ? `${a}\u0000${b}` : `${b}\u0000${a}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(h)
  }
  return unique.slice(0, Math.max(1, Number(limit) || 1)).map((h) => h.item)
}
