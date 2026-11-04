/**
 * dreamtable.js —— 醒来时摊在桌上的旧句子（2026-11-05，「摆料」）
 *
 * 由来：梦做出来之后一条都没发生过（726 条事件里 dream = 0）。查下去有两层原因：
 *   1. 她从没遇到过「可以做梦」的时刻——叫醒只会给她处境，处境里从来没有"睡过一觉"；
 *   2. 更硬的一层：梦的说明书让她「用 her_recall 翻 refs」，而她会话里 45 次工具
 *      调用中 her_recall 是 0 次。翻 → 挑 1–6 个 id → 写，三步都要她凭空发起，
 *      而梦没有收益、不推进成长日，所以她每次都走 growth_commit。
 *
 * 所以这里不做提醒，只做摆料：把她自己写下的、正在淡掉的几行字摆到醒来时看得见的地方。
 * 提醒解决的是意愿，摆料解决的是材料——她不是不知道可以做，是手上没有东西可拼。
 *
 * 三条边界（沿用 dream.js 的四条硬约束）：
 *   - 只用她自己说过的话（utterance / revise / reunion / narration / refusal），
 *     别人的话、系统记录一律不进；refs 的合法性因此天然满足。
 *   - 出门/请神那几趟写下的事件不摆（与 writeDream 的拒绝规则同源）。
 *   - 只陈述事实，不给台词、不派活：不出现「梦」「记一句」「你可以」。
 */

/** 一句话要淡多久才值得被摆出来。太新的还热着，太旧的可能她已经不认了。 */
export const STALE_MIN_DAYS = 7
export const STALE_MAX_DAYS = 30
/** 摆几行。少了拼不起来，多了就成了清单。 */
export const TABLE_MIN = 3
export const TABLE_MAX = 5
/** 隔了这么久才算「睡了一觉」。她的窗口是 12:00–02:00，一天醒两次。 */
export const GAP_HOURS = 6

/** 能当材料的类型，与 dream.js 的 HER_WORDS 同源。 */
export const HER_WORDS = new Set(['utterance', 'revise', 'reunion', 'narration', 'refusal'])

const DAY_MS = 86_400_000

/**
 * 正在淡掉的那几行。
 *
 * 「淡」的判据是**之后再没人引用过它**：梦、回想、被重提，都算被捡起来了，
 * 捡起来的话还在她身上，不该被摆成旧纸。只用时间判断会摆出一堆她刚说过的话。
 *
 * @param {Array} events 事件流
 * @param {{now?:number, minDays?:number, maxDays?:number, limit?:number, tripSessions?:Set<string>|string[]}} opts
 * @returns {Array<{id:string,ts:string,day:any,type:string,text:string,days:number}>}
 */
export function staleLines(events = [], opts = {}) {
  const now = Number(opts.now ?? Date.now())
  const minDays = Number(opts.minDays ?? STALE_MIN_DAYS)
  const maxDays = Number(opts.maxDays ?? STALE_MAX_DAYS)
  const limit = Math.max(0, Number(opts.limit ?? TABLE_MAX))
  const trips = opts.tripSessions instanceof Set
    ? opts.tripSessions
    : new Set((opts.tripSessions ?? []).map((s) => String(s ?? '')).filter(Boolean))

  // 每个 id 最后一次被引用的时刻。只有"晚于它自己"的引用才算把它捡起来。
  const citedAt = new Map()
  for (const e of events) {
    const t = Date.parse(e?.ts ?? '')
    if (!Number.isFinite(t)) continue
    for (const r of Array.isArray(e?.refs) ? e.refs : []) {
      const id = String(r ?? '')
      if (!id) continue
      if (!(citedAt.get(id) >= t)) citedAt.set(id, t)
    }
  }

  const rows = []
  for (const e of events) {
    if (!HER_WORDS.has(e?.type)) continue
    if (trips.has(String(e?.sessionId ?? ''))) continue
    const t = Date.parse(e?.ts ?? '')
    if (!Number.isFinite(t)) continue
    const days = (now - t) / DAY_MS
    if (days < minDays || days > maxDays) continue
    const text = String(e?.text ?? '').trim()
    if (!text) continue
    if ((citedAt.get(String(e.id)) ?? 0) > t) continue
    rows.push({ id: String(e.id), ts: e.ts, day: e.day ?? null, type: e.type, text, days })
  }

  // 离现在近的排前面：先摆还认得出来的，再摆更旧的。
  rows.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
  return rows.slice(0, limit)
}

/** 摆出来的每一行最多这么长。摆料不是资料库：留一句能认出是自己说的，就够了。 */
export const LINE_CLIP = 100

/** 本地日期，只到日。摆料里不需要分钟。 */
function shortDay(ts) {
  const d = new Date(ts)
  if (!Number.isFinite(d.getTime())) return ''
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 截到一行读得完的长度；截过就留一个省略号，不改动中间的字。 */
export function clipLine(text, max = LINE_CLIP) {
  const t = String(text ?? '').trim().replace(/\s*\n+\s*/g, ' ')
  if (t.length <= max) return t
  return `${t.slice(0, max).trimEnd()}…`
}

/**
 * 拼成唤醒消息里的一段。不够三行就整段不要——两句话拼不出什么，
 * 只剩"系统在展示存货"的味道。
 *
 * 措辞纪律：只写她在哪儿看见什么。「可以」「想想」「记一句」这类词一个都不出现。
 */
export function renderTable(rows = [], { gapHours = 0 } = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.id && String(r.text ?? '').trim())
  if (list.length < TABLE_MIN) return ''
  const head = gapHours >= 1 ? `这次隔了 ${Math.round(gapHours)} 个小时。` : ''
  const lines = list.slice(0, TABLE_MAX).map((r) => {
    const when = shortDay(r.ts)
    return `- 「${clipLine(r.text)}」${when ? ` · ${when}` : ''} · ${r.id}`
  })
  return [head, '你写下的几行字还摊在那儿，这些天再没被提起过：', '', ...lines]
    .filter((x) => x !== '')
    .join('\n')
}

/**
 * 这次醒来该不该摆、摆什么（纯函数，便于测）。
 *
 * `shownToday` 而不是「今天第一次醒」：当天第一次醒如果离上一次只隔了两三个小时，
 * 那这一天就再也等不到摆料了。改成按 `table:<dk>` 记账「今天已经摆过」，
 * 晚一点那次合格的醒来还能补上（2026-11-05 晚改）。
 *
 * @param {{rows?:Array, gapHours?:number, shownToday?:boolean, dreamedToday?:boolean}} opts
 * @returns {string} 空串表示这次不摆
 */
export function tableFor(opts = {}) {
  if (opts.dreamedToday) return ''
  if (opts.shownToday) return ''
  const gap = Number(opts.gapHours ?? 0)
  if (!(gap >= GAP_HOURS)) return ''
  return renderTable(opts.rows ?? [], { gapHours: gap })
}

/** 上一次叫醒到现在隔了多久（小时）。没有记录就返回 0。 */
export function hoursSinceLastWake(events = [], now = Date.now()) {
  let last = 0
  for (const e of events) {
    if (e?.type !== 'meta') continue
    if (!String(e.text ?? '').startsWith('wake:')) continue
    const t = Date.parse(e?.ts ?? '')
    if (Number.isFinite(t) && t > last) last = t
  }
  if (!last) return 0
  return Math.max(0, (Number(now) - last) / 3_600_000)
}
