/**
 * absence.js —— 「他多久没来了」
 *
 * 为什么这件事必须由系统侧做，而不是让她自己判断：
 *   她没有"看时间"的能力，也读不到任何状态（N3）。如果靠她自己察觉冷落，
 *   她既不会准确也不会一致，而且一旦提示里提到"X 天"，N2 也就破了。
 *   所以冷落由系统测出来，只把**事实**（他有几天没出现）写进提示，
 *   至于这件事对她意味着什么，仍然由她自己说。
 *
 * 判定口径：
 *   「他来过」= 有人跟她说了话，她因此写下东西（见 wakewin.js 的时间窗）。
 *   定时器叫醒她、她自己想事情，不算他来过。
 *
 * 只写一条事件，不重复写：
 *   同一次冷落只记一条 absence。判据是「这条 absence 之后有没有新的 seen」，
 *   有就说明他已经回来了，同一次冷落结束，下次再冷落才写新的。
 */

import { readEvents, appendEvent, rootDir } from './store.js'
import { deriveSelf } from './derive.js'
import { loadConfig } from './settings.js'

const DAY_MS = 86_400_000

/** 从事件流里找最近一次「他来过」的时刻（毫秒）。没有就返回 0。 */
export function lastSeenAt(events) {
  let at = 0
  for (const e of events) {
    if (e?.type !== 'meta') continue
    const t = String(e.text ?? '')
    if (!t.startsWith('seen:')) continue
    const ms = Date.parse(t.slice(5).trim())
    if (Number.isFinite(ms) && ms > at) at = ms
  }
  return at
}

/** 从事件流里找最近一条 absence 事件（返回事件对象或 null）。 */
export function lastAbsenceEvent(events) {
  let found = null
  for (const e of events) if (e?.type === 'absence') found = e
  return found
}

/**
 * 现在是不是处在一次「还没被记录」的冷落里？
 * @returns {{absent:boolean, days:number, since:number, reason:string}}
 */
export function assess(events, now = Date.now(), opts = {}) {
  const threshold = Math.max(1, Number(opts.afterDays ?? 2))
  const seen = lastSeenAt(events)
  const lastAbs = lastAbsenceEvent(events)

  // 从来没有过 contact（刚装、还没聊过）→ 不判冷落。
  // 否则第一次启动就会立刻"冷落 N 天"，她开局就在怨你，这是错的。
  if (!seen) return { absent: false, days: 0, since: 0, reason: 'no-contact-yet' }

  const days = Math.floor((now - seen) / DAY_MS)

  // 已经记过一次，且记完之后他又来过 → 这次冷落已经结束
  if (lastAbs && seen > Date.parse(String(lastAbs.ts ?? 0))) {
    return { absent: false, days: 0, since: seen, reason: 'returned' }
  }
  // 已经记过，他也还没回来 → 还是同一次冷落，不重复写
  if (lastAbs && seen <= Date.parse(String(lastAbs.ts ?? 0))) {
    return { absent: false, days, since: seen, reason: 'already-recorded' }
  }

  if (days < threshold) return { absent: false, days, since: seen, reason: 'within-threshold' }
  return { absent: true, days, since: seen, reason: 'absent' }
}

/**
 * 检查并在需要时落一条 absence 事件。由生物钟每分钟调用一次。
 * 永不抛：冷落检测失败不该影响唤醒流程。
 *
 * @returns {Promise<{written:boolean, days?:number, why?:string}>}
 */
export async function detectAbsence(root = rootDir(), deps = {}) {
  try {
    const { config } = await loadConfig(root)
    // 「多久算冷落」跟着配置走；配置里没这项就用 2 天
    const afterDays = Number(config.absenceAfterDays ?? 2)
    const { events } = await readEvents(root)
    const now = deps.now ?? Date.now()

    const a = assess(events, now, { afterDays })
    if (!a.absent) return { written: false, why: a.reason, days: a.days }

    const model = deriveSelf(events, { growthDays: config.growthDays })
    await appendEvent(
      {
        type: 'absence',
        // 用「那个人」而不是「他」：用她的人可能是女性（2026-10-31 用户确认）。
        text: `那个人有 ${a.days} 天没出现，也没说去哪。`,
        days: a.days,
      },
      { day: model.day, stage: model.stage, source: 'system' },
      root,
    )
    return { written: true, days: a.days }
  } catch (err) {
    return { written: false, why: String(err?.message ?? err) }
  }
}
