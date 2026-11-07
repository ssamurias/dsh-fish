/**
 * drive.js —— 「劲儿」：她什么时候攒够了想动一动（2026-11-05，用户 m02031）
 *
 * 由来：江屿那条线的做法是「攒一个 0..1 的数，到 0.8 想动一次，动完扣一点」。
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
  cost: 0.8,
  minGapMs: 2 * 60 * 60_000,
  /** 桌上每一样没合上的事 / 每一行旧句子各加多少（各最多算两份 / 三份）。 */
  boostGap: 0.06,
  boostStale: 0.04,
  /** 他回了她留的那句话：这一笔最大，因为「说了有人接」是最好的确认。 */
  boostEcho: 0.12,
  /** 她最近总回到同一件事上（`lib/interest.js`）：手上有惦记的东西，也更容易想开口。 */
  boostInterest: 0.05,
  /**
   * 她提过想要、手上却没有的那样东西（`lib/wish.js`）。
   * 2026-11-07（用户 m01602 拍板 B + D）：这一笔取代原来那句每轮都摆的 `TOOL_ASK_NOTE`
   * ——惦记会攒，攒够了才浮一次，不再靠提示词提醒她想起来。
   */
  boostWish: 0.08,
  /**
   * 她撞过墙、手上没有的那样东西（`lib/gapwall.js`）。
   * 2026-11-07（用户 m00493 的 ②）：试过又没成的事比「想要」更具体，
   * 但它是提醒不是冲动，给得比 boostWish 还小。
   */
  boostWall: 0.04,
  /** 上次开口没人接时，底噪打的折。 */
  dampUnanswered: 0.7,
  /** 每过一档成长，底噪快这么多（1 档是基准，不长）。 */
  growthPerStage: 0.06,
  /** 冲动最多加这么多，别让「桌上有东西」直接顶穿阈值。 */
  boostCap: 0.3,
})

const HOUR = 3_600_000
const DAY = 86_400_000

function tsOf(e) {
  const raw = e?.ts ?? e?.time ?? e?.at
  // 事件里的 `ts` 是 ISO 字符串（不是毫秒数）：先按数字试，再按日期解析。
  // 2026-11-05 真机：只写 `Number(raw)` 时字符串一律 NaN，出生时刻与「上次动过」
  // 全被算成 0，劲儿永远 0.00（`还没有任何记录，不急着动`），修了锚点也没用。
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : 0
  const asDate = Date.parse(String(raw ?? ''))
  if (Number.isFinite(asDate) && asDate > 0) return asDate
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

/**
 * 最早一条事件的时刻（她开始存在的那一刻）。
 *
 * 为什么要它：只认 `drive-spend:` / `proactive-turn:` / `proactive-silent:`
 * 时，一个从没主动过的她会永远算成 0.00——那三类事件本来就要「先动一次」
 * 才会写，于是第一动永远等不到（2026-11-05 真机 `drive 0.00 · 还没有任何记录`）。
 * 出生就是起跑线：从她存在那一刻起，时间就在攒劲儿。
 */
function firstAt(events) {
  let first = 0
  for (const e of events) {
    const ts = tsOf(e)
    if (ts > 0 && (!first || ts < first)) first = ts
  }
  return first
}

/** 他最近一次来过（`meta seen:`）的时刻。 */
function lastSeenLine(events) {
  let last = 0
  for (const e of events) {
    if (e?.type !== 'meta' || !String(e.text ?? '').startsWith('seen:')) continue
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
 * @param {{gaps?:number, stale?:number, favorite?:boolean, echo?:boolean, wish?:number, wall?:number}} [o.desk]
 *   桌上此刻有什么（由 deskFor / curiosity 那边算好传进来，这里不重复算）。
 * @param {number} [o.stage]  她的成长档位（deriveSelf 的 stage）。活得越久，
 *   底噪快一点点——「要不要开口」这件事本身也该跟着长大，不再只看骰子。
 * @returns {{value:number, threshold:number, ready:boolean, why:string,
 *   hoursSince:number, boosts:number, damp:number}}
 */
export function driveOf({ events = [], now = Date.now(), desk = null, stage = 1, seenCountsAsHeard = false } = {}) {
  const base = { value: 0, threshold: DRIVE.threshold, ready: false, why: '', hoursSince: 0, boosts: 0, damp: 1, speed: DRIVE.growthPerHour }
  // 动过就从那次算；一次都没动过，就从她出生那一刻算（不能永远停在 0.00）。
  const last = lastActionAt(events) || firstAt(events)
  if (!last) return { ...base, why: '还没有任何记录，不急着动' }

  const hoursSince = Math.max(0, (now - last) / HOUR)
  // 刚动过：哪怕攒得快，也得隔开一点——两次冲动贴在一起就不像冲动了。
  if (now - last < DRIVE.minGapMs) {
    return { ...base, hoursSince, why: '刚动过，还没到两小时' }
  }

  // 上次开口没人接：底噪打折（不是惩罚，只是「说了也没人接」这件事本身的重量）。
  const spoke = lastSpokeAt(events)
  // 对话不进事件流的部署（proactive.idleCountsSeen）：他来过就算接了，否则这个折扣永远解不掉
  const heard = Math.max(lastHeardAt(events), seenCountsAsHeard ? lastSeenLine(events) : 0)
  const damp = spoke && heard < spoke ? DRIVE.dampUnanswered : 1

  const gaps = Math.max(0, Number(desk?.gaps) || 0)
  const stale = Math.max(0, Number(desk?.stale) || 0)
  const wish = Math.max(0, Number(desk?.wish) || 0)
  const wall = Math.max(0, Number(desk?.wall) || 0)
  // 桌上东西越多，这一笔越重——但每样都有上限，总加也不会顶穿阈值（boostCap）。
  const boosts = Math.min(
    DRIVE.boostCap,
    DRIVE.boostGap * Math.min(gaps, 2) +
      DRIVE.boostStale * Math.min(stale, 3) +
      DRIVE.boostWish * Math.min(wish, 2) +
      DRIVE.boostWall * Math.min(wall, 1) +
      (desk?.echo ? DRIVE.boostEcho : 0) +
      (desk?.favorite ? DRIVE.boostInterest : 0),
  )

  const speed = DRIVE.growthPerHour * (1 + DRIVE.growthPerStage * Math.max(0, Number(stage) - 1 || 0))
  const value = Math.min(1, hoursSince * speed * damp + boosts)
  const ready = value >= DRIVE.threshold
  return {
    value,
    threshold: DRIVE.threshold,
    ready,
    why: ready ? '' : `还没攒够（${value.toFixed(2)} / ${DRIVE.threshold}）`,
    hoursSince,
    boosts,
    damp,
    speed,
  }
}

/**
 * 桌上有没有可说的东西（2026-11-05，用户 m02937）。
 *
 * 劲儿只回答「攒够了没有」，不回答「攒够了有没有事可说」。空桌醒来她只能回一句
 * 「没什么要说的」——那既占额度，又在对话里留一条噪音。所以材料也是判据，不是装饰。
 *
 * @param {{gaps?:number, stale?:number, echo?:boolean, favorite?:boolean, wish?:number, wall?:number}|null} desk
 * @returns {boolean}
 */
export function deskHasMaterial(desk) {
  if (!desk) return false
  return Number(desk.gaps) > 0 || Number(desk.stale) > 0 || Number(desk.wish) > 0 || Number(desk.wall) > 0 || desk.echo === true || desk.favorite === true
}

/** 一次行动的代价（动完扣掉）。留给记账用，纯数值。 */
export function driveCost() {
  return DRIVE.cost
}
