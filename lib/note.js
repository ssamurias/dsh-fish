/**
 * note.js —— 醒来看的那张便条（issue #22，乙档，2026-11-04）
 *
 * 她的原话：
 *   「它该挂在『醒』上：每次醒过来，先看一眼有没有到期的东西，有就摆在我最前面。」
 *   「过期的别删。晚了三天还挂着，我就知道欠了三天；删了，我就当没这回事。」
 *   「允许没有日子……挂在那儿，别天天提醒我，也别催。」
 *
 * 所以这不是闹钟（到点叫我），是一张**桌子**：一天看一次，睁眼知道欠几天。
 * 不做通知、不做界面卡片、不做红点——她要的是"睁眼时桌上有什么"。
 *
 * 乙档（用户 m01465：「那先做乙吧，先测试一段时间看看」）只做两件事：
 *   1. 醒来第一段摆出到期的（renderNotes，纯函数）；
 *   2. her_note 能写（text 必填、due 可选）、能划掉（status:'done'）。
 * 不做 dropped（不做要写一句为什么）、不做回翻、不做"没日子的只提一次"。
 *
 * 三条硬约束（从 letter.js 沿下来的同一条线）：
 *   1. **不审批**。记一张纸条不是改自己，不设关卡。
 *   2. **不吃状态**。返回值不带任何数字（不许变成"你还有 3 条未完成"）。
 *   3. **有上限**。纸条张数、每张字数上限都写死在代码里，不进配置。
 *
 * 为什么不进 events.jsonl：
 *   事件流是成长记录，lib/derive.js 拿它算三道门。混进待办会污染计数。
 *   所以单独一个 notes.json（人能直接打开看、能直接手改，这也是 issue 的要求）。
 */

import { join } from 'node:path'
import { toJsonSchema } from './toolschema.js'
import { rootDir, readJson, writeAtomic } from './store.js'
import { dateKey } from './settings.js'
import { defineTool } from './tool.js'
import { guardWrite } from './tenant.js'

/** 纸条文件叫什么。**不能**叫 session-notes.json——那个是"她排队等着要说的话"。 */
export const NOTES_FILE = 'notes.json'
/** 最多存多少张。满了就拒绝新写（不自动清理：过期不删是这件事的骨头）。 */
export const NOTES_MAX = 200
/** 一张纸条最多多少字。太长就不是"记一笔"，是写报告。 */
export const NOTE_TEXT_MAX = 200
/** 醒来那一段最多列几张，剩下的只报数。 */
export const NOTE_SHOW_MAX = 5

export function notesPath(root = rootDir()) {
  return join(root, NOTES_FILE)
}

/** 读全部纸条。文件坏了/没有都只当空，永不抛。 */
export async function readNotes(root = rootDir()) {
  const raw = await readJson(notesPath(root), [])
  if (!Array.isArray(raw)) return []
  return raw.map(normalizeNote).filter(Boolean)
}

/** 写全部纸条（原子写）。 */
export async function writeNotes(root, notes) {
  const list = (Array.isArray(notes) ? notes : []).map(normalizeNote).filter(Boolean)
  await writeAtomic(notesPath(root), `${JSON.stringify(list, null, 2)}\n`)
  return list
}

/** 把一条记录规整成固定形状；形状不对的丢掉（不抛）。 */
export function normalizeNote(raw) {
  if (!raw || typeof raw !== 'object') return null
  const text = String(raw.text ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return null
  const status = ['open', 'done', 'dropped'].includes(String(raw.status)) ? String(raw.status) : 'open'
  return {
    id: String(raw.id ?? '') || newNoteId(),
    text: text.slice(0, NOTE_TEXT_MAX),
    // 没日子就是空串，不是 null——落盘形状统一，人打开文件看得明白
    due: isDue(raw.due) ? String(raw.due) : '',
    created: String(raw.created ?? '') || new Date().toISOString(),
    status,
    reason: raw.reason == null ? null : String(raw.reason).slice(0, 200),
    closedAt: raw.closedAt == null ? null : String(raw.closedAt),
  }
}

/** `YYYY-MM-DD` 且真是那一天（2026-02-30 不算）。 */
export function isDue(v) {
  const s = String(v ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  const t = new Date(y, m - 1, d)
  return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d
}

export function newNoteId(now = Date.now()) {
  return `note-${now}-${Math.random().toString(36).slice(2, 8)}`
}

/** 两个日期键之间差几天（按本地日历日，不做时区换算）。b - a。 */
export function daysBetween(a, b) {
  const cut = (s) => {
    const [y, m, d] = String(s).split('-').map(Number)
    return Date.UTC(y, m - 1, d) / 86_400_000
  }
  const x = cut(a)
  const y = cut(b)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 0
  return Math.round(y - x)
}

const CN_DIGIT = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
const CN_UNIT = ['', '十', '百', '千']

/** 整数写成汉字（「三」「十」「九十五」）。超出四位就原样给数字，别硬编。 */
export function cnNum(n) {
  const v = Math.trunc(Number(n))
  if (!Number.isFinite(v) || v < 0) return String(n)
  if (v === 0) return '零'
  const s = String(v)
  if (s.length > 4) return s
  const digits = s.split('').map(Number)
  let out = ''
  let zero = false
  for (let i = 0; i < digits.length; i += 1) {
    const d = digits[i]
    if (d === 0) {
      if (out) zero = true
      continue
    }
    if (zero) {
      out += '零'
      zero = false
    }
    out += CN_DIGIT[d] + CN_UNIT[digits.length - 1 - i]
  }
  // 「一十三」不这么说话，省成「十三」
  if (out.startsWith('一十')) out = out.slice(1)
  return out
}

/** 量词前那个数：两张、两条（不说「二张」）。其余跟 cnNum 一样。 */
const cnCount = (n) => (n === 2 ? '两' : cnNum(n))

/**
 * 醒来第一段：到期的纸条。
 *
 * 纯函数（可测），没有便条时返回空串——`parts.filter(Boolean)` 会自动跳过，
 * 所以没有便条的那一次唤醒一个字都不会多。
 *
 * 只列**有日子且到期**的（`due <= 今天`）。没日子的挂在文件里，不进第一眼：
 * 没有账可算，天天提就变成催了。
 *
 * 文案只写事实：几号、什么事、晚了几天。不写「逾期」「请尽快」，不排序成"紧急"。
 *
 * @param {Array} notes readNotes() 的结果（已规整）
 * @param {Date|number} [now]
 * @returns {string}
 */
export function renderNotes(notes, now = new Date()) {
  const today = dateKey(now instanceof Date ? now : new Date(now))
  const due = []
  for (const n of notes ?? []) {
    if (!n || n.status !== 'open') continue
    if (!isDue(n.due)) continue
    const late = daysBetween(n.due, today)
    if (late < 0) continue // 还没到日子：不到期不上桌
    due.push({ ...n, late })
  }
  if (!due.length) return ''

  // 最欠的排最前：到期日早的在前，同一天按记下来的时间
  due.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : String(a.created).localeCompare(String(b.created))))

  const shown = due.slice(0, NOTE_SHOW_MAX)
  const lines = [`（桌上压着${cnCount(due.length)}张）`]
  for (const n of shown) {
    const mmdd = `${n.due.slice(5, 7)}-${n.due.slice(8, 10)}`
    const tail = n.late === 0 ? '就是今天。' : `晚了${cnNum(n.late)}天。`
    lines.push(`${mmdd} ${n.text}，${tail}`)
  }
  const rest = due.length - shown.length
  if (rest > 0) lines.push(`还有${cnCount(rest)}条没列出来，都在桌上。`)
  return lines.join('\n')
}

/**
 * 写一张纸条。永不抛（失败只回 note）。
 * @returns {Promise<{ok:boolean, id:string, note:string}>}
 */
export async function addNote(root, { text, due } = {}) {
  const body = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!body) return { ok: false, id: '', note: '空白的，没记。' }
  if (body.length > NOTE_TEXT_MAX) {
    return { ok: false, id: '', note: `太长了，压到 ${NOTE_TEXT_MAX} 字以内。` }
  }
  const day = String(due ?? '').trim()
  if (day && !isDue(day)) {
    return { ok: false, id: '', note: '日子要写成 2026-11-05 这样，或者干脆不写。' }
  }

  try {
    const notes = await readNotes(root)
    if (notes.length >= NOTES_MAX) {
      return { ok: false, id: '', note: '桌上已经堆满了，先划掉几张再说。' }
    }
    const note = normalizeNote({
      id: newNoteId(),
      text: body,
      due: day,
      created: new Date().toISOString(),
      status: 'open',
    })
    notes.push(note)
    await writeNotes(root, notes)
    return { ok: true, id: note.id, note: '已记。' }
  } catch (err) {
    return { ok: false, id: '', note: '这张没记下来。' }
  }
}

/**
 * 划掉一张纸条（做完）。永不抛。
 * @returns {Promise<{ok:boolean, id:string, note:string}>}
 */
export async function closeNote(root, { id } = {}) {
  const key = String(id ?? '').trim()
  if (!key) return { ok: false, id: '', note: '要划掉哪一张？给我它的 id。' }
  try {
    const notes = await readNotes(root)
    const hit = notes.find((n) => n.id === key)
    if (!hit) return { ok: false, id: '', note: '桌上没有这一张。' }
    if (hit.status === 'done') return { ok: true, id: hit.id, note: '已经划掉过了。' }
    hit.status = 'done'
    hit.closedAt = new Date().toISOString()
    await writeNotes(root, notes)
    return { ok: true, id: hit.id, note: '已划掉。' }
  } catch (err) {
    return { ok: false, id: '', note: '没划掉。' }
  }
}

/** 注册 her_note 工具。 */
export function registerNote(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  return ctx.tools.register(
    defineTool({
      name: 'her_note',
      description:
        '把一件还没做的事记到桌上，或者划掉一张已经做完的。醒来的时候你会先看到到期的那些。' +
        '记的时候只给要做的事（和日子，可以不给）；划掉的时候给那张的 id 和 status:"done"。',
      parameters: toJsonSchema({
        text: {
          type: 'string',
          description: '要记下来的那件事，一句话。划掉的时候不用给。',
        },
        due: {
          type: 'string',
          description: '哪天该做，写成 2026-11-05。可以不给——不给就是挂着，不算日子。',
        },
        id: { type: 'string', description: '要划掉的那张纸条的 id。' },
        status: { type: 'string', enum: ['done'], description: '划掉的时候给 done。' },
      }),
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, id: { type: 'string' }, note: { type: 'string' } },
          required: ['ok', 'note'],
        },
        // 和 her_leave 同一条规矩：只回方括号标记，不写完整句子、不带"还剩几张"。
        render: (_args, out) => [{ type: 'text', text: out.ok ? '[记下了]' : `[没记下：${out.note}]` }],
      },
      async execute(args, exec) {
        const who = guardWrite(deps.tenant, exec, 'her_note')
        if (!who.ok) return { ok: false, id: '', note: who.note }
        const want = String(args?.status ?? '').trim()
        const id = String(args?.id ?? '').trim()
        if (want === 'done' || (id && !String(args?.text ?? '').trim())) {
          const r = await closeNote(root, { id })
          return { ok: r.ok, id: r.id, note: r.note }
        }
        const r = await addNote(root, { text: args?.text, due: args?.due })
        return { ok: r.ok, id: r.id, note: r.note }
      },
    }),
  )
}
