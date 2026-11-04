/**
 * drive.js —— 「劲儿」：她什么时候攒够了想动一动（2026-11-05，用户 m02031）
 *
 * 由来：江屿那条线的做法是「攒一个 0..1 的数，到 0.8 想动一次，动完扣 0.55」。
 * 用户认可这个手感，但要它**从事件流算出来**，不另存一份 `drive.json`：
 * 落盘的状态会跟事件流各说各话，而她是谁只该由事件流决定。
 *
 * 这一版比原版多一件事：劲儿不是盲的增长曲线，它由两半组成——
 *
 *   底噪  时间线性攒（0.12/小时），保证不会几周不动。
 *   冲动  桌上真有事（没合上的问题、旧句子）、他回了她留的话，各自加一小笔；
 *         反过来，她上次开口没人接，攒得就慢（Horvitz 的打扰成本）。
 *
 * 一条硬规矩：**只算，不管「说什么」**。劲儿只回答「这一轮开不开」，
 * 开口说什么仍由她自己决定；也不写任何数值进提示词（四条黑名单第三条）。
 *
 * 纯函数：不读文件、不写文件、不掷骰子（随机留给调用方）。
 */

/** 攒得多快、到多少算攒够、动一次扣多少、两次之间最少隔多久。 */
export const DRIVE = Object.freeze({
  growthPerHour: 0.12,
  threshold: 0.8,
  cost: 0.55,
  minGapMs: 40 * 60_000,
  /** 桌上每一样没合上的事 / 每一行旧句子各加多少（各最多算两份 / 三份）。 */
  boostGap: 0.06,
  boostStale: 0.04,
  /** 他回了她留的那句话：这一笔最大，因为「说了有人接」是最好的确认。 */
  boostEcho: 0.12,
  /** 上次开口没人接时，底噪打的折。 */
  dampUnanswered: 0.7,
  /** 冲动最多加这么多，别让「桌上有东西」直接顶穿阈值。 */
  boostCap: 0.3,
})

const HOUR = 3_600_000
const DAY = 86_400_000

function tsOf(e) {
  const t = Number(e?.ts ?? e?.time ?? e?.at)
  if (Number.isFinite(t) && t > 0) return t
  const d = Date.parse(String(e?.iso ?? e?.date ?? ''))
  return Number.isFinite(d) ? d : 0
}

/** 她为「这一轮」写过账的时刻（动过手、或只是醒了一下）。 */
function lastActionAt(events) {
  let last = 0
  for (const e of events) {
    if (e?.type !== 'meta') continue
    const text = String(e.text ?? '')
    if (!text.startsWith('drive-spend:') && !text.startsWith('proactive-turn:') && !text.startsWith('proactive-silent:')) continue
    const ts = tsOf(e)
    if (ts > last) last = ts
  }
  return last
}

/** 他最近一次真的跟她说过话的时刻（她「听见」的那种）。 */
function lastHeardAt(events) {
  let last = 0
  for (const e of events) {
    const type = String(e?.type ?? '')
    if (type !== 'heard' && type !== 'answer') continue
    const ts = tsOf(e)
    if (ts > last) last = ts
  }
  return last
}

/** 她最近一次真的开口的时刻。 */
function lastSpokeAt(events) {
  let last = 0
  for (const e of events) {
    if (e?.type !== 'meta') continue
    if (!String(e.text ?? '').startsWith('proactive-turn:')) continue
    const ts = tsOf(e)
    if (ts > last) last = ts
  }
  return last
}

/**
 * 算这一刻的劲儿。
 *
 * @param {object} o
 * @param {object[]} o.events  全量事件
 * @param {number} [o.now]
 * @param {{gaps?:number, stale?:number, favorite?:boolean, echo?:boolean}} [o.desk]
 *   桌上此刻有什么（由 deskFor / curiosity 那边算好传进来，这里不重复算）。
 * @returns {{value:number, threshold:number, ready:boolean, why:string,
 *   hoursSince:number, boosts:number, damp:number}}
 */
export function driveOf({ events = [], now = Date.now(), desk = null } = {}) {
  const base = { value: 0, threshold: DRIVE.threshold, ready: false, why: '', hoursSince: 0, boosts: 0, damp: 1 }
  const last = lastActionAt(events)
  if (!last) return { ...base, why: '还没有任何记录，不急着动' }

  const hoursSince = Math.max(0, (now - last) / HOUR)
  // 刚动过：哪怕攒得快，也得隔开一点——两次冲动贴在一起就不像冲动了。
  if (now - last < DRIVE.minGapMs) {
    return { ...base, hoursSince, why: '刚动过，还没到 40 分钟' }
  }

  // 上次开口没人接：底噪打折（不是惩罚，只是「说了也没人接」这件事本身的重量）。
  const spoke = lastSpokeAt(events)
  const heard = lastHeardAt(events)
  const damp = spoke && heard < spoke ? DRIVE.dampUnanswered : 1

  const gaps = Math.max(0, Number(desk?.gaps) || 0)
  const stale = Math.max(0, Number(desk?.stale) || 0)
  // 桌上东西越多，这一笔越重——但每样都有上限，总加也不会顶穿阈值（boostCap）。
  const boosts = Math.min(
    DRIVE.boostCap,
    DRIVE.boostGap * Math.min(gaps, 2) + DRIVE.boostStale * Math.min(stale, 3) + (desk?.echo ? DRIVE.boostEcho : 0),
  )

  const value = Math.min(1, hoursSince * DRIVE.growthPerHour * damp + boosts)
  const ready = value >= DRIVE.threshold
  return {
    value,
    threshold: DRIVE.threshold,
    ready,
    why: ready ? '' : `还没攒够（${value.toFixed(2)} / ${DRIVE.threshold}）`,
    hoursSince,
    boosts,
    damp,
  }
}

/** 一次行动的代价（动完扣掉）。留给记账用，纯数值。 */
export function driveCost() {
  return DRIVE.cost
}
