/**
 * gapwall.js —— 「这件事你试过，手上没有能用的」（2026-11-07，用户 m00493 的 ②）。
 *
 * 她撞过墙（工具被挡、没有那样东西），那件事如果还悬着，就该留在桌上。
 * 原来只有 ask 卡（`lib/wish.js`）会摆，撞墙本身没人记得——她下一轮醒来又
 * 从头想一遍「我好像试过」，却想不起试的是什么。
 *
 * 三条口径：
 *   1. 只认自己说出口的那句「做不到」（`blockedTalk()` 的固定开头），不猜。
 *   2. 主题取她当时那句话（`lib/anchor.js`）；没有来路就不摆，不编。
 *   3. 7 天、最多 1 条；与 wish 去重（同一件事不摆两行）。
 */

import { anchorOf } from './anchor.js'
import { similarity } from './derive.js'

/** 撞墙摆多久。 */
export const GAPWALL_DAYS = 7
/** 一次最多摆几条。 */
export const GAPWALL_SHOW_MAX = 1
/** 相似到这个程度算同一件事。与 curiosity / desk 同一口径。 */
export const GAPWALL_SIMILARITY = 0.42
/** `blockedTalk()` 的固定开头（见 lib/restrict.js）。 */
export const GAPWALL_PREFIX = '这件事我做不到'

const DAY_MS = 86_400_000
const USE_LINE = /^use:(\S+)\s+(ok|fail)\s*(.*)$/

/**
 * 从事件流里找出「撞过墙、还悬着」的那件事。
 *
 * @param {object[]} events
 * @param {{now?:number, days?:number}} [o]
 * @returns {{text:string, ts:number, days:number}[]}
 */
export function gapwallsOf(events, { now = Date.now(), days = GAPWALL_DAYS } = {}) {
  const at0 = Number(now)
  if (!Number.isFinite(at0)) return []
  const since = at0 - Math.max(1, Number(days) || GAPWALL_DAYS) * DAY_MS
  const found = []
  for (const ev of Array.isArray(events) ? events : []) {
    if (ev?.type !== 'meta') continue
    const m = USE_LINE.exec(String(ev.text ?? ''))
    if (!m || m[2] !== 'fail') continue
    if (!String(m[3] ?? '').trim().startsWith(GAPWALL_PREFIX)) continue
    const at = Date.parse(String(ev.ts ?? ''))
    if (!Number.isFinite(at) || at < since || at > at0) continue
    const text = anchorOf(events, ev.sessionId, at)
    if (!text) continue
    found.push({ text, ts: at, days: Math.max(0, Math.floor((at0 - at) / DAY_MS)) })
  }
  // 同一件事撞过几次只留最近一次（比如反复要同一件东西）。
  found.sort((a, b) => b.ts - a.ts)
  const picked = []
  for (const w of found) {
    if (picked.some((p) => similarity(p.text, w.text) >= GAPWALL_SIMILARITY)) continue
    picked.push(w)
  }
  return picked.slice(0, GAPWALL_SHOW_MAX)
}

/** 几天前 / 今天——与 desk.js 同一口径，不给小时数。 */
export function gapwallTail(days) {
  const d = Math.max(0, Number(days) || 0)
  return d > 0 ? `${d} 天前` : '今天'
}

/** 桌上那一行。 */
export function gapwallLine(w) {
  const text = String(w?.text ?? '').trim()
  if (!text) return ''
  return `- 「${text}」（这件事你试过，手上没有能用的·${gapwallTail(w.days)}）`
}
