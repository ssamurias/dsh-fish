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
import { tsMs, isContactEvent } from './schema.js'

const DAY_MS = 86_400_000

/**
 * 从事件流里找最近一次「他来过」的时刻（毫秒）。没有就返回 0。
 *
 * 两类证据：
 *   1. `meta seen:<ISO>` —— 主证据。capture.js（她当场写事件）和 say.js（替主人递话）
 *      都会写；2026-11-02 起 turns.js 结账时也写（侧栏聊天也算他来过）。
 *   2. `heard` 事件 —— 兜底。它由 hear.js 在她真说过话之后写下，只可能是 system 写的
 *      （HER_TYPES 不含 heard，她伪造不了），所以同样能证明「他来过」。
 *
 * 为什么**不**认 `utterance`：定时唤醒也会让她写 utterance，而「定时器叫醒她自己想事情
 * 不算他来过」是这个模块的立身之本（见文件头）。derive 层分不出哪条是唤醒里写的。
 */
/** 最后一条「他来过」在事件流里的下标；没有就 -1。 */
export function lastContactIndex(events = []) {
  for (let i = events.length - 1; i >= 0; i--) if (isContactEvent(events[i])) return i
  return -1
}

/** 最后一条 absence 在事件流里的下标；没有就 -1。 */
export function lastAbsenceIndex(events = []) {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]?.type === 'absence') return i
  return -1
}

export function lastSeenAt(events) {
  // 取「最大时刻」而不是最后一条：导入/手写夹具里事件不保证按时间排。
  let at = 0
  for (const e of events ?? []) {
    if (!isContactEvent(e)) continue
    const ms = e?.type === 'heard' ? tsMs(e) : Date.parse(String(e.text ?? '').slice(5).trim()) || tsMs(e)
    if (ms > at) at = ms
  }
  return at
}

/** 从事件流里找最近一条 absence 事件（返回事件对象或 null）。 */
export function lastAbsenceEvent(events) {
  const i = lastAbsenceIndex(events)
  return i < 0 ? null : events[i]
}

/**
 * 现在是不是处在一次「还没被记录」的冷落里？
 * @returns {{absent:boolean, days:number, since:number, reason:string}}
 */
export function assess(events, now = Date.now(), opts = {}) {
  const threshold = Math.max(1, Number(opts.afterDays ?? 2))
  const seenIdx = lastContactIndex(events)
  const absIdx = lastAbsenceIndex(events)

  // 从来没有过 contact（刚装、还没聊过）→ 不判冷落。
  // 否则第一次启动就会立刻"冷落 N 天"，她开局就在怨你，这是错的。
  if (seenIdx < 0) return { absent: false, days: 0, since: 0, reason: 'no-contact-yet' }

  const since = lastSeenAt(events)
  // 时钟回拨、seen 落在未来时差值是负的 → 不能出现「-1 天没来」，按 0 算。
  const days = Math.max(0, Math.floor((now - since) / DAY_MS))

  if (absIdx >= 0) {
    // 「回来没有」按两条线索判：
    //   1. 事件流里的先后（seen 写在 absence 之后）——老代码只看时间戳，
    //      系统时间被往前跳过时会写下一条 ts 在未来的 absence，之后所有
    //      seen 的时间戳都比它小，于是「他回来了」永远判不出来。
    //   2. 时间戳（seen 晚于 absence 的 ts）——兼容测试/导入数据里按时间排序、
    //      但 absence 被追加在中间的情形。两条任一成立都算回来。
    const back = seenIdx > absIdx || since > tsMs(events[absIdx])
    // 已经记过一次，且记完之后他又来过 → 这次冷落已经结束。
    // 只管门槛以内：回来之后又消失够久，就是新的一次，得能再记。
    if (back && days < threshold) return { absent: false, days: 0, since, reason: 'returned' }
    // 已经记过，他也还没回来 → 还是同一次冷落，不重复写
    if (!back) return { absent: false, days, since, reason: 'already-recorded' }
  }

  if (days < threshold) return { absent: false, days, since, reason: 'within-threshold' }
  return { absent: true, days, since, reason: 'absent' }
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
