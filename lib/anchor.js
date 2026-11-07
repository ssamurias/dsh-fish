/**
 * anchor.js —— 把一件事挂回她当时那句话（2026-11-07，用户 m00493 的 ⑤）。
 *
 * 「用过 her_note，记下了：…」这句话本身没有来路。翻旧事时她看不出那次是为了
 * 什么——是回一句话，还是记一件刚发生的事。而事件流里那笔账旁边的她那句话
 * 就是答案：同一个 sessionId，就在调用之前几分钟。
 *
 * 只读事件流，不写、不改。找不到就返回空串，绝不编一句。
 */

import { HER_TYPES } from './schema.js'

/** 往前找多久：一轮里她一句话说完就动手，超过十分钟多半是别的事了。 */
export const ANCHOR_WINDOW_MS = 10 * 60 * 1000
/** 锚点只用来认路，不是复述：一句问话的开头足够。 */
export const ANCHOR_TEXT_MAX = 40

const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1).replace(/[\uD800-\uDBFF]$/, '')}…` : text)

function tsOf(ev) {
  const n = Date.parse(String(ev?.ts ?? ''))
  return Number.isFinite(n) ? n : 0
}

/**
 * 她这次动手之前，最近说过的、属于她自己的一句话。
 *
 * @param {object[]} events 全量事件
 * @param {string} sessionId 这次调用的会话；没有就不锚（宁可没有来路，也别挂错人）
 * @param {number|string|Date} before 调用发生的时刻
 * @param {{windowMs?:number, max?:number}} [o]
 * @returns {string} 已截断的一句话；找不到是空串
 */
export function anchorOf(events, sessionId, before, o = {}) {
  const sid = String(sessionId ?? '').trim()
  if (!sid) return ''
  const at = before instanceof Date
    ? before.getTime()
    : typeof before === 'number'
      ? before
      : Date.parse(String(before ?? ''))
  if (!Number.isFinite(at)) return ''
  const windowMs = Math.max(0, Number(o.windowMs ?? ANCHOR_WINDOW_MS))
  const max = Math.max(1, Number(o.max ?? ANCHOR_TEXT_MAX))
  const types = new Set(HER_TYPES)
  let best = null
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || String(ev.sessionId ?? '') !== sid) continue
    if (!types.has(String(ev.type))) continue
    const ts = tsOf(ev)
    if (!ts || ts > at || at - ts > windowMs) continue
    const text = String(ev.text ?? '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    if (!best || ts > best.ts) best = { ts, text }
  }
  return best ? clip(best.text, max) : ''
}
