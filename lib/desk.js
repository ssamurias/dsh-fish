/**
 * desk.js —— 醒来时桌上摊着的东西，只有一张桌子（2026-11-05）
 *
 * 由来：两条线各自往 `wake()` 里塞清单，塞到同一轮就撞车。
 *   - `lib/curiosity.js`（commit ab21372）：她问过、还没答案的几件事 + 留话的回音。
 *   - `lib/dreamtable.js`（commit 157f41c）：7–30 天前写下、之后再没被提起的旧句子。
 * 空醒那一次两段会并排出现：一个说「你自己问过、还没答案的几件事」，紧接着又一个
 * 「你写下的几行字还摊在那儿」。同一张桌上摆两摞清单，看着像系统在盘货。
 *
 * 所以这里只做一件事：把「想知道的」与「写下的旧句子」按配额和去重并成一段。
 * 约定见维护者本地的空醒方案文档第五节（没随仓库发布）。
 *
 * 三条边界：
 *   1. **只摆事实**。不出现「你应该 / 你可以去 / 值得想想」——派活了就又变成任务清单。
 *   2. **不出现分数**。权重只用于挑哪几条，不进正文（四条黑名单的第三条）。
 *   3. **待办不并进来**。`note.js` 的便条由 `wake()` 单独摆在整段最前面
 *      （她的原话：「摆在我最前面」），并进桌子会被挤到第二段去。
 *
 * 2026-11-07（用户 m01602 拍板 B + D，显示走 C）：多一样东西上桌——
 * 「够不着的那件事」（`lib/wish.js`）。她提过想要、手上却没有的那样东西，
 * 攒在劲儿里，攒够了才摆出来一次。它不是提示，是桌上的一行字。
 */

import { clipText } from './clip.js'
import { similarity } from './derive.js'
import { wishLine } from './wish.js'
import { gapwallLine } from './gapwall.js'
import { localDaysAgo } from './schema.js'

/** 空醒时最多摆几条没合上的事。 */
export const DESK_GAP_FREE = 2
/** 普通叫醒只摆一条——有活要干的时候，桌上有一样惦记着的就够。 */
export const DESK_GAP_NORMAL = 1
/** 旧句子只在空醒时摆；有任务的那一轮不摆（摆了她也只会先干活）。 */
export const DESK_STALE_FREE = 3
/** 相似到这个程度算同一件事，只留一条。与 curiosity.js 的聚并口径一致。 */
export const DESK_SIMILARITY = 0.42
/** 一行最多这么长。 */
export const DESK_LINE_CLIP = 100

const HEAD_FREE = '桌上摊着这几样东西：'
// 2026-11-06（issue #42）：「没合上」断言了她还没得到答案，而 curiosityOf 只看
// 「她反复问过」，并不判断有没有答案。改成只说她做过的那个动作。
const HEAD_NORMAL = '桌上还有一件你反复问起的事：'

function clip(text, max = DESK_LINE_CLIP) {
  const t = String(text ?? '').trim().replace(/\s*\n+\s*/g, ' ')
  return clipText(t, max)
}

/** 几天前 / 今天 / 昨天——不给小时数。按本地日历日数，不按 24 小时整除。 */
function agoText(at, at0) {
  const days = localDaysAgo(at, at0)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  return `${days} 天前`
}

/** `MM-DD`，摆料里不需要分钟。 */
function shortDay(ts) {
  const d = new Date(ts)
  if (!Number.isFinite(d.getTime())) return ''
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 并成一段。
 *
 * @param {object} o
 * @param {Array<{text:string,hits?:number,lastAt?:number}>} o.gaps   curiosityOf() 的结果
 * @param {Array<{id:string,text:string,ts:string,days:number}>} o.stale staleLines() 的结果
 * @param {boolean} [o.free]  这一轮是不是空醒
 * @param {string} [o.favorite] interest.js 算出的「最近总回到的那件事」，空串表示没有
 * @param {Array<{text:string,subject?:string,tail?:string}>} [o.wishes]
 *   wish.js 的 wishesOf() 结果——她提过、手上没有的那几件事。可选，不传就不摆。
 * @param {Array<{text:string,ts:number,days:number}>} [o.walls]
 *   gapwall.js 的 gapwallsOf() 结果——她试过、手上没有的那样东西。可选。
 * @param {number|Date} [o.at]
 * @returns {string} 空串表示这一轮桌上什么都没有
 */
export function deskFor({ gaps = [], stale = [], free = false, favorite = '', wishes = [], walls = [], at = Date.now() } = {}) {
  const at0 = at instanceof Date ? at.getTime() : Number(at)
  const gapCap = free ? DESK_GAP_FREE : DESK_GAP_NORMAL
  const staleCap = free ? DESK_STALE_FREE : 0

  const picked = []
  for (const g of Array.isArray(gaps) ? gaps : []) {
    if (picked.length >= gapCap) break
    const text = clip(g?.text)
    if (!text) continue
    if (picked.some((p) => similarity(p.text, text) >= DESK_SIMILARITY)) continue
    const lastAt = Number(g?.lastAt ?? at0)
    const times = Number(g?.hits ?? 1) > 1
      ? `问过 ${Number(g.hits)} 次，最近一次是${agoText(lastAt, at0)}`
      : agoText(lastAt, at0)
    picked.push({ kind: 'gap', text: `- 「${text}」（${times}）` })
  }

  let staleCount = 0
  for (const s of Array.isArray(stale) ? stale : []) {
    if (staleCount >= staleCap) break
    const text = clip(s?.text)
    if (!text || !s?.id) continue
    if (picked.some((p) => similarity(p.text, text) >= DESK_SIMILARITY)) continue
    const when = shortDay(Date.parse(s.ts))
    const tail = [when, String(s.id)].filter(Boolean).join(' · ')
    picked.push({ kind: 'stale', text: `- 「${text}」${tail ? ` · ${tail}` : ''}` })
    staleCount += 1
  }

  // 反复出现的那件事排在最后：它不像「没合上的事」，更像背景里一直响的那句。
  const fav = clip(favorite)
  if (fav && !picked.some((p) => similarity(p.text, fav) >= DESK_SIMILARITY)) {
    picked.push({ kind: 'fav', text: `- 「${fav}」（最近你总说到它）` })
  }

  // 撞过墙的那件事（2026-11-07，用户 m00493 的 ②）：她试过、手上没有。
  // 排在 wish 前面：一件具体试过的事，比一句「想要」更该先被看见。
  for (const w of Array.isArray(walls) ? walls : []) {
    const text = String(w?.text ?? '').trim()
    if (!text) continue
    if (picked.some((p) => similarity(p.text, text) >= DESK_SIMILARITY)) continue
    const line = gapwallLine(w)
    if (line) picked.push({ kind: 'wall', text: line })
    break
  }

  // 够不着的那件事（2026-11-07，用户 m01602）：她自己提过、手上没有的。
  // 攒不攒够由 drive.js 的劲儿决定，这里只管把已经成立的那一行摆上来。
  for (const w of Array.isArray(wishes) ? wishes : []) {
    const text = String(w?.text ?? '').trim()
    if (!text) continue
    if (picked.some((p) => similarity(p.text, text) >= DESK_SIMILARITY)) continue
    const line = wishLine(w)
    if (line) picked.push({ kind: 'wish', text: line })
    break
  }

  if (!picked.length) return ''
  // 有旧的没合上的事才用「还有一件」；空醒给的是几样并排的东西。
  const gapOnly = picked.every((p) => p.kind === 'gap')
  const head = free || !gapOnly ? HEAD_FREE : HEAD_NORMAL
  return [head, ...picked.map((p) => p.text)].join('\n')
}
