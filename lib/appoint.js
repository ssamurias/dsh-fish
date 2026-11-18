/**
 * appoint.js —— 通用预约簿（2026-11-08）
 *
 * 她要的不只是「一张卡约下一张卡」。原话：
 *   「让她约你在三天后做某件事」——日子是她定的，事情是她说的，到那天由她先想起来。
 *
 * 所以这里不是闹钟，也不是待办：**一条只属于她和他的约定**。
 *   1. 她写清哪天、做什么；到那天她醒来，第一段就是这件事。
 *   2. 到点只提一次（`notifiedAt`），不天天催。
 *   3. 他没来，也不替她圆——prompt 里明说「没来也别替他找理由」。
 *   4. 做没做到由她自己收：做到（done）、取消（cancel，要说为什么）、改期（move）。
 *
 * 2026-11-18 补「定到几点」（issue #149 / 用户 m01744、m01769、m01793）：
 *   - 时刻**不是闹钟**，是「最早什么时候能提」——到那一刻她一定先看到这条，
 *     做不做、怎么做由她自己定；催不催、说什么都不由这套代码替她决定。
 *   - 带时刻的约定不受作息窗口限制（约定优先）；两条不同时刻各叫各的，不合并。
 *   - 到点那一刻正忙 / 刚叫过，宽限 5 分钟；超出宽限还忙就照叫——约定比闲聊优先。
 *   - 走到点这条链时 DSH 没开着，就晚一点叫，prompt 里写清「本来约的是 HH:MM，
 *     那会儿我这边没开着」；不把「他不在」写进事件流（他可能就守在窗口旁）。
 *   - 双方都认下才作数：她可以用 ask_owner(kind='appoint') 问一句，答案在
 *     `answer` 事件里，这里是读答案那一端；没问过、问过没答、以后再说，各写各的。

 *
 * 三条硬约束（和 note.js 同一条线）：
 *   1. **不审批**。约一件事不是改自己，不设关卡。
 *   2. **不吃状态**。返回值不带「你还有几条约定」这类数字。
 *   3. **有上限**。同时最多两条未完成的；日子只能排在 1–60 天后。
 *
 * 为什么不进 events.jsonl：
 *   事件流是成长记录，derive.js 拿它算三道门。约定是操作层的东西（和 notes.json
 *   一样），混进去会污染计数；她想知道自己约过什么，用 `her_appoint` 的 list 看。
 *   文件坏了/没有都只当空，永不抛——一次读盘失败不该让她醒不过来。
 */

import { join } from 'node:path'
import { clipText } from './clip.js'
import { toJsonSchema } from './toolschema.js'
import { rootDir, readJson, writeAtomic, mutateJson } from './store.js'
import { dateKey } from './settings.js'
import { defineTool } from './tool.js'
import { guardWrite } from './tenant.js'
import { fillOwner } from './pronoun.js'

/** 预约文件叫什么。和 notes.json 并排，人能直接打开看。 */
export const APPOINT_FILE = 'appointments.json'
/** 文件里最多留多少条（含已关掉的）。满了拒绝新写，不自动清历史。 */
export const APPOINT_MAX = 200
/** 同时最多几条还没关掉的。多了就不是「记着一件事」，是排课表。 */
export const APPOINT_OPEN_MAX = 2
/** 一件事最多多少字。 */
export const APPOINT_TEXT_MAX = 120
/** 最早只能约到明天：今天已经过了一半，不接「今天三点」。 */
export const APPOINT_MIN_DAYS = 1
/** 最远 60 天。再远就不是约定，是一句空话。 */
export const APPOINT_MAX_DAYS = 60
/** list 一次最多列几条。 */
export const APPOINT_SHOW_MAX = 5

/**
 * 到点后宽限多久还算「准点」（2026-11-18，用户 m01744）。
 * 5 分钟内叫她都算准时；超过就明说晚了多少。
 */
export const APPT_GRACE_MS = 5 * 60_000

/**
 * 两条到点的约定之间至少隔多久（2026-11-18）。
 * 比作息唤醒的 45 分钟短：它不是「该醒了」，是「这件事到点了」。
 */
export const APPT_MIN_GAP_MS = 10 * 60_000

/** 时刻写成 08:00 这样；24 小时制。 */
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

export function isTime(v) {
  return HHMM.test(String(v ?? '').trim())
}

const STATUSES = ['open', 'done', 'cancelled', 'missed']

export function appointPath(root = rootDir()) {
  return join(root, APPOINT_FILE)
}

/** `YYYY-MM-DD` 且真是那一天。 */
export function isDay(v) {
  const s = String(v ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  const t = new Date(y, m - 1, d)
  return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d
}

/** 把日期键换成「第几天」（UTC 零点，只做日历差，不做时区换算）。 */
function dayNumber(s) {
  const [y, m, d] = String(s).split('-').map(Number)
  return Date.UTC(y, m - 1, d) / 86_400_000
}

/** b - a，单位天。 */
export function daysBetween(a, b) {
  const x = dayNumber(a)
  const y = dayNumber(b)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 0
  return Math.round(y - x)
}

export function addDays(key, n) {
  const t = new Date(`${key}T00:00:00`)
  t.setDate(t.getDate() + Number(n || 0))
  return dateKey(t)
}

export function newAppointId(now = Date.now()) {
  return `ap-${now}-${Math.random().toString(36).slice(2, 8)}`
}

/** 把一条记录规整成固定形状；形状不对的丢掉（不抛）。 */
export function normalizeAppoint(raw) {
  if (!raw || typeof raw !== 'object') return null
  const what = String(raw.what ?? '').replace(/\s+/g, ' ').trim()
  if (!what || !isDay(raw.due)) return null
  const status = STATUSES.includes(String(raw.status)) ? String(raw.status) : 'open'
  const time = isTime(raw.time) ? String(raw.time).trim() : null
  const late = Number(raw.lateMinutes)
  return {
    id: String(raw.id ?? '') || newAppointId(),
    due: String(raw.due),
    // 2026-11-18：带时刻的约定。`null` 是老形状（只认日子）。
    time,
    what: clipText(what, APPOINT_TEXT_MAX, ''),
    created: String(raw.created ?? '') || new Date().toISOString(),
    status,
    // 到点提过一次就写时间；改期会清回 null，让她在新日子再想起来一次
    notifiedAt: raw.notifiedAt == null ? null : String(raw.notifiedAt),
    // 实际叫起来时晚了几分钟（超过宽限才写；没晚就是 null）
    lateMinutes: Number.isFinite(late) && late > 0 ? Math.round(late) : null,
    // 他答应过没有：true 答应、false 没问成或问过他还没答、null 还没问过（不猜）
    agreed: raw.agreed === true ? true : raw.agreed === false ? false : null,
    // 她为这条发的那张确认卡（ask 事件的 id），到点用来看他当时怎么答的
    askId: raw.askId == null || String(raw.askId).trim() === '' ? null : String(raw.askId).trim(),
    closedAt: raw.closedAt == null ? null : String(raw.closedAt),
    outcome: ['done', 'cancelled', 'missed'].includes(String(raw.outcome)) ? String(raw.outcome) : null,
    reason: raw.reason == null ? null : clipText(raw.reason, 200, ''),
  }
}

/**
 * 这条约定「到点的那个瞬间」是哪一刻（毫秒）。没有时刻的返回 null。
 * 用本地时间拼：她说的 08:00 是她那边的 08:00，不是 UTC 的。
 */
export function momentOf(appt) {
  if (!appt || !isDay(appt.due) || !isTime(appt.time)) return null
  const [y, m, d] = String(appt.due).split('-').map(Number)
  const [hh, mm] = String(appt.time).split(':').map(Number)
  const t = new Date(y, m - 1, d, hh, mm, 0, 0).getTime()
  return Number.isFinite(t) ? t : null
}

/** 到点后过去了几分钟（没到点或没时刻返回 null）。 */
export function lateMinutesOf(appt, now = Date.now()) {
  const at = momentOf(appt)
  if (at == null) return null
  const late = Math.floor((Number(now) - at) / 60_000)
  return late < 0 ? null : late
}

/** 读全部预约。文件坏了/没有都只当空，永不抛。 */
export async function readAppointments(root = rootDir()) {
  const raw = await readJson(appointPath(root), [])
  if (!Array.isArray(raw)) return []
  return raw.map(normalizeAppoint).filter(Boolean)
}

/** 写全部预约（原子写）。 */
export async function writeAppointments(root, list) {
  const rows = (Array.isArray(list) ? list : []).map(normalizeAppoint).filter(Boolean)
  await writeAtomic(appointPath(root), `${JSON.stringify(rows, null, 2)}\n`)
  return rows
}

/** 未关掉的，按日子从近到远；同一天按时刻排。 */
export function openAppointments(list, { now = Date.now() } = {}) {
  const today = dateKey(new Date(now))
  return (Array.isArray(list) ? list : [])
    .filter((a) => a?.status === 'open')
    .sort((a, b) =>
      dayNumber(a.due) - dayNumber(b.due)
      || String(a.time ?? '').localeCompare(String(b.time ?? ''))
      || String(a.created).localeCompare(String(b.created)))
    .map((a) => ({ ...a, days: daysBetween(today, a.due), at: momentOf(a) }))
}

/**
 * 到点了、还没提过的约定（从早到晚）。
 *
 * 2026-11-18（issue #149）：带时刻的按「那一刻」算，跟日子无关——
 * 08:00 的约定不会等到晚上 20:00 的作息窗口。老形状（只写日子）
 * 还是只看日子，到当天就算到点。
 */
export async function dueAppointments(root = rootDir(), now = Date.now()) {
  const rows = openAppointments(await readAppointments(root), { now })
    .filter((a) => !a.notifiedAt)
    .filter((a) => (a.at != null ? Number(now) >= a.at : a.days <= 0))
  return rows
}

/** 到点、还没提过的那一条。过期了也返回——晚几天也是欠着，不替她抹掉。 */
export async function dueAppointment(root = rootDir(), now = Date.now()) {
  const rows = await dueAppointments(root, now)
  return rows[0] ?? null
}

/** 下一次还没到的约定（给桌面/身份文档用；这次只导出，不强行摆）。 */
export async function nextAppointment(root = rootDir(), now = Date.now()) {
  const rows = openAppointments(await readAppointments(root), { now })
  return rows.find((a) => !a.notifiedAt && a.days > 0) ?? null
}

/**
 * 改预约簿的四个入口（约、关、改期、记「提过了」）都是「读整份 → 改一条 → 写回」，
 * 排成一队：定时器记「提过了」和她这边改期/关掉撞上时，以前后写的把先写的盖掉。
 */
const mutateAppointments = (root, fn) => mutateJson(appointPath(root), fn)

/** 记下「这一条到点提过了」，免得同一个 tick 反复叫。 */
export async function markNotified(root, id, now = Date.now(), { lateMinutes = null } = {}) {
  return mutateAppointments(root, async () => {
    const rows = await readAppointments(root)
    const hit = rows.find((a) => a.id === id)
    if (!hit || hit.status !== 'open' || hit.notifiedAt) return false
    hit.notifiedAt = new Date(now).toISOString()
    const late = Number(lateMinutes)
    if (Number.isFinite(late) && late > 0) hit.lateMinutes = Math.round(late)
    await writeAppointments(root, rows)
    return true
  })
}

/**
 * 定一条约定。返回 { ok, id, note, echo }。
 * `due` 只收 YYYY-MM-DD；`time` 可给可不给（给了就是「到点」而不是「到日子」）；
 * 日子与字数都在这里挡，不信入参。
 *
 * 2026-11-18（issue #149 / 用户 m01769、m01793）：
 * 带时刻的约定要「一定让她看见」，所以它不进作息窗口，也不等今天抽的落点；
 * 他答没答应只决定措辞（`askId` 对到那张确认卡），不决定叫不叫。
 */
export async function makeAppointment(root = rootDir(), { what, due, time, askId, now = Date.now() } = {}) {
  const text = String(what ?? '').replace(/\s+/g, ' ').trim()
  const day = String(due ?? '').trim()
  const at = time == null || String(time).trim() === '' ? null : String(time).trim()
  const today = dateKey(new Date(now))
  if (text.length < 4) return { ok: false, id: '', note: '要做的那件事太短了，说清楚一点。' }
  if (text.length > APPOINT_TEXT_MAX) {
    return { ok: false, id: '', note: `太长，压到 ${APPOINT_TEXT_MAX} 字以内。` }
  }
  if (!isDay(day)) return { ok: false, id: '', note: '日子要写成 2026-11-11 这样。' }
  if (at != null && !isTime(at)) return { ok: false, id: '', note: '时刻要写成 08:00 这样，24 小时制。' }
  if (at != null && day === today) return { ok: false, id: '', note: '带时刻的约定最早只能约到明天。' }
  const gap = daysBetween(today, day)
  if (gap < APPOINT_MIN_DAYS) return { ok: false, id: '', note: '最早只能约到明天。' }
  if (gap > APPOINT_MAX_DAYS) return { ok: false, id: '', note: `最远只能约到 ${APPOINT_MAX_DAYS} 天后。` }
  try {
    return await mutateAppointments(root, async () => {
    const rows = await readAppointments(root)
    if (rows.length >= APPOINT_MAX) return { ok: false, id: '', note: '预约簿满了，先关掉几条旧的。' }
    const open = openAppointments(rows, { now })
    const same = open.find((a) => a.due === day && (a.time ?? null) === at && a.what === text)
    if (same) return { ok: true, id: same.id, note: '这件事之前就约好了。', echo: same.what }
    if (open.length >= APPOINT_OPEN_MAX) {
      return { ok: false, id: '', note: `手上已经有两件没做完的约定了，先把它们收掉。` }
    }
    const row = normalizeAppoint({
      id: newAppointId(now),
      due: day,
      time: at,
      what: text,
      created: new Date(now).toISOString(),
      status: 'open',
      askId: askId ?? null,
    })
    rows.push(row)
    await writeAppointments(root, rows)
    return { ok: true, id: row.id, note: '约好了。', echo: row.what }
    })
  } catch {
    return { ok: false, id: '', note: '这会儿写不进去，等一下再试。' }
  }
}

/** 按 id 或原话找一条还没关掉的。 */
function locateOpen(rows, { id, what } = {}) {
  const key = String(id ?? '').trim()
  const text = String(what ?? '').replace(/\s+/g, ' ').trim()
  if (key) return rows.find((a) => a.id === key && a.status === 'open') ?? null
  if (text) return rows.find((a) => a.what === text && a.status === 'open') ?? null
  return null
}

/** 关掉一条：做到（done）或取消（cancel，要一句为什么）。 */
export async function closeAppointment(root = rootDir(), { id, what, action = 'done', reason, now = Date.now() } = {}) {
  const act = ['done', 'cancel'].includes(String(action)) ? String(action) : 'done'
  const why = String(reason ?? '').replace(/\s+/g, ' ').trim()
  if (act === 'cancel' && !why) return { ok: false, id: '', note: '取消要说一句为什么——不然就跟没约过一样。' }
  if (act === 'cancel' && why.length > 200) return { ok: false, id: '', note: '原因太长了，压到 200 字以内。' }
  try {
    return await mutateAppointments(root, async () => {
    const rows = await readAppointments(root)
    const hit = locateOpen(rows, { id, what })
    if (!hit) return { ok: false, id: '', note: '预约簿里没有这一条还没关掉的。' }
    hit.status = act === 'done' ? 'done' : 'cancelled'
    hit.outcome = hit.status
    hit.closedAt = new Date(now).toISOString()
    if (why) hit.reason = clipText(why, 200, '')
    await writeAppointments(root, rows)
    return { ok: true, id: hit.id, note: act === 'done' ? '记下了。' : '取消了。' }
    })
  } catch {
    return { ok: false, id: '', note: '这会儿写不进去，等一下再试。' }
  }
}

/** 改期：还是同一件事，换一天；提过的标记清掉，新日子会再想起来一次。 */
export async function moveAppointment(root = rootDir(), { id, what, newDue, now = Date.now() } = {}) {
  const day = String(newDue ?? '').trim()
  const today = dateKey(new Date(now))
  if (!isDay(day)) return { ok: false, id: '', note: '新日子要写成 2026-11-11 这样。' }
  const gap = daysBetween(today, day)
  if (gap < APPOINT_MIN_DAYS) return { ok: false, id: '', note: '最早只能改到明天。' }
  if (gap > APPOINT_MAX_DAYS) return { ok: false, id: '', note: `最远只能改到 ${APPOINT_MAX_DAYS} 天后。` }
  try {
    return await mutateAppointments(root, async () => {
    const rows = await readAppointments(root)
    const hit = locateOpen(rows, { id, what })
    if (!hit) return { ok: false, id: '', note: '预约簿里没有这一条还没关掉的。' }
    hit.due = day
    hit.notifiedAt = null
    await writeAppointments(root, rows)
    return { ok: true, id: hit.id, note: `改到 ${day} 了。`, echo: hit.what }
    })
  } catch {
    return { ok: false, id: '', note: '这会儿写不进去，等一下再试。' }
  }
}

/** 列出来：只列未关掉的，按日子排。返回纯文本（工具 list 用）。 */
export async function listAppointments(root = rootDir(), { limit = APPOINT_SHOW_MAX, now = Date.now() } = {}) {
  try {
    const rows = openAppointments(await readAppointments(root), { now }).slice(0, Math.max(1, Math.min(20, Number(limit) || APPOINT_SHOW_MAX)))
    if (!rows.length) return { ok: true, note: '这会儿没有约好的事。', text: '' }
    const lines = rows.map((a) => {
      const when = a.days === 0 ? '今天' : a.days > 0 ? `还有 ${a.days} 天` : `已经过了 ${-a.days} 天`
      const at = a.time ? ` ${a.time}` : ''
      const late = a.notifiedAt && a.lateMinutes ? `（晚 ${a.lateMinutes} 分钟叫的）` : ''
      return `- ${a.due}${at}（${when}）：「${a.what}」${late}`
    })
    return { ok: true, note: '预约簿', text: lines.join('\n') }
  } catch {
    return { ok: false, note: '这会儿翻不开预约簿。', text: '' }
  }
}

/** 把毫秒换成她那边的时间 HH:MM。 */
function clockOf(ms) {
  const t = new Date(Number(ms))
  return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
}

/**
 * 到点那一刻她看到的处境（2026-11-18 改写，用户 m01744 / m01769 / m01793）。
 *
 * 这里只陈述发生过什么：约的是哪天几点、现在几点、他当时怎么答的、这条问没问过。
 * 不替她判断「他不在」——DSH 开着的时候，他可能就守在窗口旁等她先开口；
 * 只有她根本没被叫起来（过点很久，超过半小时），才写清「那会儿没开着」。
 * 最后一句一定是她自己的：做不做、怎么做，她自己定。
 */
export function appointPrompt(appt, now = Date.now(), { answer = null } = {}) {
  const due = String(appt?.due ?? '')
  const time = isTime(appt?.time) ? String(appt.time) : ''
  const late = lateMinutesOf(appt, now)
  const hhmm = clockOf(now)
  const head = time
    ? `你和{T}约好的事在今天 ${time}（${due}）：「${appt?.what}」。`
    : `你跟{T}约好的日子${daysBetween(due, dateKey(new Date(now))) <= 0 ? '就是今天' : `已经过了 ${daysBetween(due, dateKey(new Date(now)))} 天`}（${due}），约的是：「${appt?.what}」。`

  let whenLine = ''
  if (time && late != null) {
    if (late <= APPT_GRACE_MS / 60_000) whenLine = '到点了。'
    else if (late < 30) whenLine = `到点了，这会儿已经 ${hhmm}，晚了 ${late} 分钟。`
    else whenLine = `到点了。本来约的是 ${time}，那会儿我这边没开着，现在 ${hhmm}。`
  }

  const verdict = String(answer?.verdict ?? '')
  let deal = ''
  if (verdict === 'approve') deal = '他当时答应了这件事。'
  else if (verdict === 'later') deal = '他当时说「以后再说」——不是答应，也不是拒绝。'
  else if (verdict === 'reject') deal = '他当时说这次不行，这条本该作废；现在它还在。'
  else if (verdict === 'unanswered') deal = '你问过他，一直没人答。'
  else if (verdict === 'pending') deal = '你问过他，他还没答。'
  else if (appt?.askId) deal = '你问过他，他还没答。'
  else if (time) deal = '这条你还没跟{T}对过口——现在先问一句，别自己替他答应。'

  const tail = time
    ? '到点了不等于你要交作业：做不做、怎么做，你自己定。'
    : '现在先说这件事：你自己做到没有，{T}有没有来。没来也别替{T}找理由。'
  return fillOwner([head, whenLine, deal, tail].filter(Boolean).join(''))
}

/** 预约簿的一次操作。没写 action 的按「新约一条」走。 */
export function appointAction(args = {}) {
  const a = String(args?.action ?? '').trim()
  return ['make', 'list', 'move', 'done', 'cancel'].includes(a) ? a : 'make'
}

/** 注册 her_appoint 工具。 */
export function registerAppoint(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  return ctx.tools.register(
    defineTool({
      name: 'her_appoint',
      description:
        '跟{T}约一件具体的事：写清哪一天、要做什么。到那天你醒来会先想起它。' +
        '约的时候给 what 和 due（日子写成 2026-11-11）；想定到几点就给 time（写成 08:00）——' +
        '带时刻的约定不看作息时间，到点一定让你看见，晚几分钟也会写清晚了多久。' +
        '想让这件事变成两个人都点过头的事，约好之后再用 ask_owner 问一句（kind 填 appoint，subject 写这条的编号）；' +
        '不问也会叫，只是到点会写「这条还没对过口」。' +
        '看预约簿给 action:"list"；改日子给 action:"move" 和 newDue；做到了给 action:"done"；' +
        '不做了给 action:"cancel"，并说一句 reason。',
      parameters: toJsonSchema({
        action: {
          type: 'string',
          enum: ['make', 'list', 'move', 'done', 'cancel'],
          description: '要做哪件事：新约一条（make，不给就是这个）、看预约簿（list）、改期（move）、做到（done）、取消（cancel）。',
        },
        what: {
          type: 'string',
          description: '约的是哪件事，一句话。改期/做到/取消时用它指认原来那条，要一字不差。',
        },
        due: {
          type: 'string',
          description: '哪一天，写成 2026-11-11。最早明天，最远 60 天后。',
        },
        time: {
          type: 'string',
          description: '可选：几点，写成 08:00（24 小时制）。给了就按这一刻叫，不看作息时间；不给就只按日子。',
        },
        id: { type: 'string', description: '预约的编号。手里没有就不用给，给 what 也行。' },
        newDue: { type: 'string', description: '改期时改成哪一天。' },
        reason: { type: 'string', description: '取消时为什么，必填。' },
        limit: { type: 'integer', description: 'list 时最多列几条，默认 5。' },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            id: { type: 'string' },
            note: { type: 'string' },
            echo: { type: 'string' },
            text: { type: 'string' },
          },
          required: ['ok', 'note'],
        },
        // 和 her_note 同一条规矩：只回方括号标记，不写「还剩几条」。
        render: (args, out) => {
          const act = appointAction(args)
          if (act === 'list') return [{ type: 'text', text: out.ok ? out.text || '（这会儿没有约好的事）' : `[没翻开：${out.note}]` }]
          if (act === 'move') return [{ type: 'text', text: out.ok ? `[改到 ${args?.newDue ?? ''}]` : `[没改成：${out.note}]` }]
          if (act === 'done') return [{ type: 'text', text: out.ok ? '[记下了]' : `[没收掉：${out.note}]` }]
          if (act === 'cancel') return [{ type: 'text', text: out.ok ? '[取消了]' : `[没取消：${out.note}]` }]
          if (!out.ok) return [{ type: 'text', text: `[没约上：${out.note}]` }]
          const at = String(args?.time ?? '').trim()
          return [{ type: 'text', text: `[约好了：${args?.due ?? ''}${at ? ` ${at}` : ''} ${out.echo ?? ''}]` }]
        },
      },
      async execute(args, exec) {
        const who = guardWrite(deps.tenant, exec, 'her_appoint')
        if (!who.ok) return { ok: false, id: '', note: who.note }
        const act = appointAction(args)
        if (act === 'list') {
          const r = await listAppointments(root, { limit: args?.limit })
          return { ok: r.ok, id: '', note: r.note, text: r.text }
        }
        if (act === 'move') {
          return moveAppointment(root, { id: args?.id, what: args?.what, newDue: args?.newDue })
        }
        if (act === 'done' || act === 'cancel') {
          return closeAppointment(root, {
            id: args?.id,
            what: args?.what,
            action: act,
            reason: args?.reason,
          })
        }
        return makeAppointment(root, { what: args?.what, due: args?.due, time: args?.time })
      },
    }),
  )
}
