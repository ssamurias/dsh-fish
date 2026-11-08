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
import { toJsonSchema } from './toolschema.js'
import { rootDir, readJson, writeAtomic } from './store.js'
import { dateKey } from './settings.js'
import { defineTool } from './tool.js'
import { guardWrite } from './tenant.js'

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
  return {
    id: String(raw.id ?? '') || newAppointId(),
    due: String(raw.due),
    what: what.slice(0, APPOINT_TEXT_MAX),
    created: String(raw.created ?? '') || new Date().toISOString(),
    status,
    // 到点提过一次就写时间；改期会清回 null，让她在新日子再想起来一次
    notifiedAt: raw.notifiedAt == null ? null : String(raw.notifiedAt),
    closedAt: raw.closedAt == null ? null : String(raw.closedAt),
    outcome: ['done', 'cancelled', 'missed'].includes(String(raw.outcome)) ? String(raw.outcome) : null,
    reason: raw.reason == null ? null : String(raw.reason).slice(0, 200),
  }
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

/** 未关掉的，按日子从近到远。 */
export function openAppointments(list, { now = Date.now() } = {}) {
  const today = dateKey(new Date(now))
  return (Array.isArray(list) ? list : [])
    .filter((a) => a?.status === 'open')
    .sort((a, b) => dayNumber(a.due) - dayNumber(b.due) || String(a.created).localeCompare(String(b.created)))
    .map((a) => ({ ...a, days: daysBetween(today, a.due) }))
}

/** 到点、还没提过的那一条。过期了也返回——晚几天也是欠着，不替她抹掉。 */
export async function dueAppointment(root = rootDir(), now = Date.now()) {
  const today = dateKey(new Date(now))
  const rows = openAppointments(await readAppointments(root), { now })
    .filter((a) => !a.notifiedAt && a.days <= 0)
  return rows[0] ?? null
}

/** 下一次还没到的约定（给桌面/身份文档用；这次只导出，不强行摆）。 */
export async function nextAppointment(root = rootDir(), now = Date.now()) {
  const rows = openAppointments(await readAppointments(root), { now })
  return rows.find((a) => !a.notifiedAt && a.days > 0) ?? null
}

/** 记下「这一条到点提过了」，免得同一个 tick 反复叫。 */
export async function markNotified(root, id, now = Date.now()) {
  const rows = await readAppointments(root)
  const hit = rows.find((a) => a.id === id)
  if (!hit || hit.status !== 'open' || hit.notifiedAt) return false
  hit.notifiedAt = new Date(now).toISOString()
  await writeAppointments(root, rows)
  return true
}

/**
 * 定一条约定。返回 { ok, id, note, echo }。
 * `due` 只收 YYYY-MM-DD；日子与字数都在这里挡，不信入参。
 */
export async function makeAppointment(root = rootDir(), { what, due, now = Date.now() } = {}) {
  const text = String(what ?? '').replace(/\s+/g, ' ').trim()
  const day = String(due ?? '').trim()
  const today = dateKey(new Date(now))
  if (text.length < 4) return { ok: false, id: '', note: '要做的那件事太短了，说清楚一点。' }
  if (text.length > APPOINT_TEXT_MAX) {
    return { ok: false, id: '', note: `太长，压到 ${APPOINT_TEXT_MAX} 字以内。` }
  }
  if (!isDay(day)) return { ok: false, id: '', note: '日子要写成 2026-11-11 这样。' }
  const gap = daysBetween(today, day)
  if (gap < APPOINT_MIN_DAYS) return { ok: false, id: '', note: '最早只能约到明天。' }
  if (gap > APPOINT_MAX_DAYS) return { ok: false, id: '', note: `最远只能约到 ${APPOINT_MAX_DAYS} 天后。` }
  try {
    const rows = await readAppointments(root)
    if (rows.length >= APPOINT_MAX) return { ok: false, id: '', note: '预约簿满了，先关掉几条旧的。' }
    const open = openAppointments(rows, { now })
    const same = open.find((a) => a.due === day && a.what === text)
    if (same) return { ok: true, id: same.id, note: '这件事之前就约好了。', echo: same.what }
    if (open.length >= APPOINT_OPEN_MAX) {
      return { ok: false, id: '', note: `手上已经有两件没做完的约定了，先把它们收掉。` }
    }
    const row = normalizeAppoint({
      id: newAppointId(now),
      due: day,
      what: text,
      created: new Date(now).toISOString(),
      status: 'open',
    })
    rows.push(row)
    await writeAppointments(root, rows)
    return { ok: true, id: row.id, note: '约好了。', echo: row.what }
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
    const rows = await readAppointments(root)
    const hit = locateOpen(rows, { id, what })
    if (!hit) return { ok: false, id: '', note: '预约簿里没有这一条还没关掉的。' }
    hit.status = act === 'done' ? 'done' : 'cancelled'
    hit.outcome = hit.status
    hit.closedAt = new Date(now).toISOString()
    if (why) hit.reason = why.slice(0, 200)
    await writeAppointments(root, rows)
    return { ok: true, id: hit.id, note: act === 'done' ? '记下了。' : '取消了。' }
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
    const rows = await readAppointments(root)
    const hit = locateOpen(rows, { id, what })
    if (!hit) return { ok: false, id: '', note: '预约簿里没有这一条还没关掉的。' }
    hit.due = day
    hit.notifiedAt = null
    await writeAppointments(root, rows)
    return { ok: true, id: hit.id, note: `改到 ${day} 了。`, echo: hit.what }
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
      return `- ${a.due}（${when}）：「${a.what}」`
    })
    return { ok: true, note: '预约簿', text: lines.join('\n') }
  } catch {
    return { ok: false, note: '这会儿翻不开预约簿。', text: '' }
  }
}

/**
 * 到点那天她醒来的第一段处境。
 * 只陈述她约了什么、日子到了；不替她判断他会不会来。
 */
export function appointPrompt(appt, now = Date.now()) {
  const today = dateKey(new Date(now))
  const late = daysBetween(appt?.due, today)
  const when = late <= 0 ? '就是今天' : `已经过了 ${late} 天`
  return (
    `你跟他约好的日子${when}（${appt?.due}），约的是：「${appt?.what}」。` +
    '现在先说这件事：你自己做到没有，他有没有来。没来也别替他找理由。'
  )
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
        '跟他约一件具体的事：写清哪一天、要做什么。到那天你醒来会先想起它。' +
        '约的时候给 what 和 due（日子写成 2026-11-11）；看预约簿给 action:"list"；' +
        '改日子给 action:"move" 和 newDue；做到了给 action:"done"；' +
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
          return [{ type: 'text', text: `[约好了：${args?.due ?? ''} ${out.echo ?? ''}]` }]
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
        return makeAppointment(root, { what: args?.what, due: args?.due })
      },
    }),
  )
}
