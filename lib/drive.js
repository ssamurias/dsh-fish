/**
 * drive.js —— 「劲儿」：她什么时候攒够了想动一动（2026-11-05，用户 m02031）
 *
 * 由来：江屿那条线的做法是「攒一个 0..1 的数，到 0.8 想动一次，动完扣一点」。
 * 用户认可这个手感，但要它**从事件流算出来**，不另存一份 `drive.json`：
 * 落盘的状态会跟事件流各说各话，而她是谁只该由事件流决定。
 *
 * 这一版比原版多一件事：劲儿不是盲的增长曲线，它由两半组成——
 *
 *   底噪  时间线性攒（0.08/小时），保证不会几周不动。
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
  // 2026-11-17（用户 m03985 / m04229）：外部反馈说「想说话不该是进度条」——原 0.12/h
  // 占得太重，桌上的真事只够提前两个多小时。先抬事件权重，再把底噪降到 0.08/h：
  // 没东西时约 10 小时才攒够，有真东西时靠几笔冲动提前开。
  // 底噪仍只是保底，不是主引擎。
  growthPerHour: 0.08,
  threshold: 0.8,
  cost: 0.8,
  minGapMs: 2 * 60 * 60_000,
  /** 桌上每一样没合上的事 / 每一行旧句子各加多少（各最多算两份 / 三份）。 */
  // 2026-11-17（用户 m03985）：外部反馈说「想说话不该是进度条」——先把「话头未接」
  // 这一类冲动抬上去，让有真东西时更早开、没东西时更晚开；同一天用户 m04229 又批准
  // 把底噪从 0.12/h 降到 0.08/h，两条一起做，时间才真正退回「保底」的位置。
  boostGap: 0.12,
  boostStale: 0.04,
  /** 他回了她留的那句话：这一笔最大，因为「说了有人接」是最好的确认。 */
  boostEcho: 0.18,
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
  /**
   * 他刚驳回她一个请求时，底噪打的折（2026-11-17，用户 m03985）。
   * 「刚被拒绝」和「他很久没来」在劲儿上必须分得开：前者该让她安静一阵，
   * 后者不该被当成拒绝。只在这一段时间里打折，过去就恢复。
   */
  dampRejected: 0.55,
  rejectHours: 12,
  /**
   * 连续两次醒着没做事、也没开口之后，下一次要么真有新东西、要么攒得更满才起。
   * 抬的是阈值，不是把她关掉——空醒本身没错，连着空转才是。
   */
  silentBoost: 0.1,
  /** 每过一档成长，底噪快这么多（1 档是基准，不长）。 */
  growthPerStage: 0.06,
  /** 冲动最多加这么多，别让「桌上有东西」直接顶穿阈值。 */
  boostCap: 0.4,
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

/** 他最近一次驳回她请求的时刻（`ask-no:`，见 lib/ask.js）。 */
function lastRejectedAt(events) {
  let last = 0
  for (const e of events) {
    if (e?.type !== 'meta' || !String(e.text ?? '').startsWith('ask-no:')) continue
    const ts = tsOf(e)
    if (ts > last) last = ts
  }
  return last
}

/**
 * 从最近一次真开口往回数，连着几次只是醒来、什么也没说 / 什么也没做。
 * `proactive-silent:` 是这类回合；`proactive-turn:` 一出现就清零。
 */
export function silentStreakOf(events = []) {
  let n = 0
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e?.type !== 'meta') continue
    const text = String(e.text ?? '')
    if (text.startsWith('proactive-turn:')) break
    if (text.startsWith('proactive-silent:')) n += 1
  }
  return n
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
export function driveOf({ events = [], now = Date.now(), desk = null, stage = 1, seenCountsAsHeard = false, silentStreak = 0 } = {}) {
  // 连续两次空醒之后，门槛抬高一点（2026-11-17，用户 m03985）：
  // 不是把她关掉，是让下一次开口真的有点东西，而不是又醒一次说「没什么」。
  const threshold = DRIVE.threshold + (Number(silentStreak) >= 2 ? DRIVE.silentBoost : 0)
  const base = { value: 0, threshold, ready: false, why: '', hoursSince: 0, boosts: 0, damp: 1, speed: DRIVE.growthPerHour }
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
  let damp = spoke && heard < spoke ? DRIVE.dampUnanswered : 1
  // 刚被他驳回：把「刚被拒」和「他很久没来」分开。后者不该被当成拒绝。
  const rejectedAt = lastRejectedAt(events)
  const rejected = rejectedAt > 0 && now - rejectedAt <= DRIVE.rejectHours * HOUR
  if (rejected) damp *= DRIVE.dampRejected

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
  const ready = value >= threshold
  return {
    value,
    threshold,
    ready,
    why: ready ? '' : `还没攒够（${value.toFixed(2)} / ${threshold}）`,
    hoursSince,
    boosts,
    damp,
    speed,
    rejected,
    silentStreak: Number(silentStreak) || 0,
  }
}

/**
 * 桌上有没有可说的东西（2026-11-05，用户 m02937）。
 *
 * 劲儿只回答「攒够了没有」，不回答「攒够了有没有事可说」。空桌醒来她只能回一句
 * 「没什么要说的」——那既占额度，又在对话里留一条噪音。所以材料也是判据，不是装饰。
 *
 * 2026-11-16（1.0.4）：桌上多了她自己的东西（lib/works.js）——手上还摊着的那一件。
 * 它不攒劲儿（弄自己的东西不该变成另一种签到），只算「有东西可说」。
 *
 * @param {{gaps?:number, stale?:number, echo?:boolean, favorite?:boolean, wish?:number, wall?:number, work?:number}|null} desk
 * @returns {boolean}
 */
export function deskHasMaterial(desk) {
  if (!desk) return false
  return Number(desk.gaps) > 0 || Number(desk.stale) > 0 || Number(desk.wish) > 0 || Number(desk.wall) > 0
    || desk.echo === true || desk.favorite === true || Number(desk.work) > 0
}

/** 一次行动的代价（动完扣掉）。留给记账用，纯数值。 */
export function driveCost() {
  return DRIVE.cost
}
