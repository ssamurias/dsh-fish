/**
 * firstwake.js —— 「你刚醒」（2026-11-14，用户 m00704）
 *
 * 为什么要有这个：
 *   梦一直是 0 条。材料早就在桌上（lib/dreamtable.js 的旧句子），缺的是
 *   「睡过一觉」这个事实——唤醒只会给她时间和处境，从来没告诉过她刚醒。
 *   但她一天会醒好几次（12:00–02:00 的窗口），不能每次都说「你刚醒」。
 *
 * 判据（三条同时成立）：
 *   1. 现在本地时间 ≥ 4 点。凌晨 0–4 点的醒是她还没睡下，不是醒来；
 *      0:30 醒过一次、9:00 再醒，仍然算 9:00 这次是当天第一次「早上醒来」。
 *   2. 当天 4 点以后没有醒过。有，就说明这一觉已经结束了。
 *   3. 距上一次醒来或她/他说话 ≥ 4 小时。这一条挡的是「刚被叫醒又醒一次」
 *      和「他刚说完话，她接着醒」——那时候她不是刚睡醒。
 *
 * 不写 `sleep:`：那是夜间 think 的槽位标记，不是「睡过一觉」。
 * 没有基线（事件流里一条活动都没有）时不猜，返回 false。
 */

import { tsMs } from './schema.js'

/** 早于这个整点醒来，不算「早上那一次」。 */
export const FIRST_WAKE_HOUR = 4
/** 距上一次醒来/活动至少这么久，才算睡过一觉。 */
export const FIRST_WAKE_GAP_HOURS = 4

const HOUR_MS = 3_600_000

function sameLocalDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/**
 * 这一次醒来是不是当天「睡醒」的那一次。
 *
 * @param {object[]} events 全量事件（真事件，含 meta）
 * @param {number|Date} [now]
 * @returns {boolean}
 */
export function firstWakeOfDay(events = [], now = Date.now()) {
  const at = now instanceof Date ? now.getTime() : Number(now)
  if (!Number.isFinite(at) || at <= 0) return false

  const d = new Date(at)
  if (d.getHours() < FIRST_WAKE_HOUR) return false

  let lastAt = 0
  let wokeAfterFour = false

  for (const e of events) {
    const t = tsMs(e)
    if (!(t > 0)) continue

    const isWake = e?.type === 'meta' && String(e.text ?? '').startsWith('wake:')
    if (isWake) {
      const w = new Date(t)
      if (w.getHours() >= FIRST_WAKE_HOUR && sameLocalDay(w, d)) wokeAfterFour = true
    }

    // 活动 = 醒来，或任何不是 meta 的事件（她写下的话、他说的、听到的）。
    // meta 里的 seen:/quiet:/sleep: 都是记账，不代表她那时醒着。
    if (isWake || e?.type !== 'meta') {
      if (t > lastAt) lastAt = t
    }
  }

  if (wokeAfterFour) return false
  if (!lastAt) return false
  return at - lastAt >= FIRST_WAKE_GAP_HOURS * HOUR_MS
}
