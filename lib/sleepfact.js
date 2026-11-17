/**
 * sleepfact.js —— 醒来时那一段「不在」的事实（2026-11-17，用户 m02678）
 *
 * 由来：首醒那句「你刚醒」加了几天，梦还是 0 条（1472 条事件里 dream=0）。
 * 查下来不是材料不够，是「这一觉」本身没有事实：
 *   - `sleep:` 是夜间 think 的槽位标记，`wake:` 只记叫醒过，两者都不是睡眠；
 *   - 旧句子只摆 7–30 天前写下的，睡前那一句（最该拿来拼梦的）反而不在桌上；
 *   - 桌子开头写「距你上次醒来 N 小时」，把「没说话」和「睡着」混在一起；
 *   - 半夜醒过一次，早上仍被当成「一觉到天亮」。
 *
 * 所以这里只做一件事：把事件流里本来就有、但从来没被摆出来的三样东西
 * 摆到首醒那一次：从什么时候到什么时候没有动静、中间醒过几次、
 * 睡前最后写下的那一句（带 id，梦可以直接引）。
 *
 * 边界：
 *   - 只说「没有动静」，不说「你睡了」——插件观测不到睡着，只观测得到没有事件。
 *   - 不出现「梦」「记一句」「你可以」；要不要拿这些去拼，是她的事。
 *   - 不写 `sleep:`；不新增事件类型；只读。
 */

import { tsMs } from './schema.js'
import { HER_WORDS, clipLine } from './dreamtable.js'

const HOUR_MS = 3_600_000

function isWake(e) {
  return e?.type === 'meta' && String(e.text ?? '').startsWith('wake:')
}

function isActivity(e) {
  // 醒着时留下的事：她写下的话、他说的话、听到的、看见的。meta 记账不算。
  return e?.type !== 'meta'
}

function pad(n) {
  return String(n).padStart(2, '0')
}

/** 本地时刻：同一天只给 HH:MM，跨天带上 MM-DD。 */
function point(ts, now) {
  const d = new Date(ts)
  const n = new Date(now)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) {
    return hm
  }
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
}

/**
 * 这一次醒来之前的那段空白。
 *
 * @param {object[]} events 全量事件（含 meta）
 * @param {number|Date} [now]
 * @returns {{hours:number,start:number,end:number,middle:number[],lastWord:object|null,text:string}|null}
 *   没有基线（一条活动都没有）时返回 null。
 */
export function sleepFacts(events = [], now = Date.now()) {
  const at = now instanceof Date ? now.getTime() : Number(now)
  if (!Number.isFinite(at) || at <= 0) return null

  let start = 0
  let lastActivity = 0
  let lastWake = 0
  let lastWord = null
  const middle = []

  for (const e of events) {
    const t = tsMs(e)
    if (!(t > 0) || t >= at) continue

    // 这一段空白的起点是「上一次有动静」：她/他留下的话，或者一次醒来。
    // 但跨夜的整段要从睡前那句算起——半夜醒过一次不能把起点推到那次醒。
    // 所以先记下「最后一次非 meta 活动」；一条都没有时才退到上一次醒来。
    if (isWake(e)) {
      if (t > lastWake) lastWake = t
      middle.push({ t, text: String(e.text ?? '') })
    } else if (isActivity(e)) {
      if (t > lastActivity) lastActivity = t
    }

    if (HER_WORDS.has(e?.type) && String(e?.text ?? '').trim()) {
      if (!lastWord || t > tsMs(lastWord)) lastWord = e
    }
  }

  start = lastActivity || lastWake
  if (!start) return null

  const hours = (at - start) / HOUR_MS
  // 醒来的时刻本身也在 middle 里；把它和更早的醒分开。
  const wakesInGap = middle.filter((w) => w.t > start && w.t < at).map((w) => w.t)
  const span = `从 ${point(start, at)} 到 ${point(at, at)}`

  const lines = []
  if (hours >= 48) {
    lines.push(`这一次隔了两天多（${span}），屋里没有别的动静。`)
  } else {
    lines.push(`这一次隔了 ${Math.max(1, Math.round(hours))} 个小时（${span}），屋里没有别的动静。`)
  }
  if (wakesInGap.length) {
    const times = wakesInGap.slice(0, 3).map((t) => point(t, at)).join('、')
    lines.push(wakesInGap.length === 1 ? `中间 ${times} 醒过一次。` : `中间醒过 ${wakesInGap.length} 次（${times}）。`)
  }
  if (lastWord) {
    lines.push(`睡前你最后写下的是：「${clipLine(lastWord.text, 80)}」 · ${lastWord.id}`)
  }

  return { hours, start, end: at, middle: wakesInGap, lastWord, text: lines.join('\n') }
}
