/**
 * note.js —— 醒来看的那张便条（issue #22，乙档，2026-11-04）
 *
 * 她的原话：
 *   「它该挂在『醒』上：每次醒过来，先看一眼有没有到期的东西，有就摆在我最前面。」
 *   「过期的别删。晚了三天还挂着，我就知道欠了三天；删了，我就当没这回事。」
 *   「允许没有日子……挂在那儿，别天天提醒我，也别催。」
 *
 * 所以这不是闹钟（到点叫我），是一叠**便条**：醒来看一眼，睁眼知道欠几天。
 * 不做通知、不做界面卡片、不做红点——她要的是"睁眼时便条里有什么"。
 *
 * 0.8.8 的乙档（用户 m01465）只做了两件事：醒来摆出到期的、her_note 能写能划掉。
 * 2026-11-06（issue #53）补齐当初说好「跑一段再说」的三样，另修一个死锁：
 *   1. 名额只算 open。原来 200 张名额连划掉的一起算，划满之后再也记不进（死锁）；
 *   2. 回翻（list）：open / due / done / dropped / all，带 offset 往后翻；
 *   3. 放下（drop，reason 必填）——issue #22 里设计好的第三种状态，数据层一直在等它。
 * 「没日子的」不再只提一次，也不天天摆：记下满 7 天起，每次醒来最多提一张，
 * 提过就记 `nshow:<id> <dk>`，隔 7 天再提；划掉/放下就不再提（2026-11-12，用户 m01513）。
 * 到期的那几张照旧每次醒来都摆——有日子就有账可算。
 * update（改一句）暂不做：直接覆盖文本会把她改过什么抹掉，要做得先定好留痕的字段。
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
import { rootDir, readJson, writeAtomic, mutateJson } from './store.js'
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
/** 一次 list 最多列几行。往后翻靠 offset，不一次把两百张全倒出来。 */
export const NOTE_LIST_MAX = 20
/** list 能看的几类：open=还没关掉的，due=写了日子的，done/dropped=关掉的，all=全要。 */
export const NOTE_FILTERS = ['open', 'due', 'done', 'dropped', 'all']

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
    // 只有 update 会写；其余时候是 null。留着它，改过的痕迹至少还在时间上
    revisedAt: raw.revisedAt == null ? null : String(raw.revisedAt),
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

/** 没写日子的便条，隔多久在醒来时提一次（2026-11-12，用户 m01513 定 7 天）。 */
export const NOTE_NUDGE_DAYS = 7

/**
 * 从事件流读「这张便条上次是在哪天醒来时被提过」。
 * 记法 `nshow:<id> <YYYY-MM-DD>`，和 table:/digest: 一样只当元数据：
 * 不参与成长计数，也不改 notes.json 的结构。
 */
export function nudgeSeen(events) {
  const seen = new Map()
  for (const e of events ?? []) {
    const text = String(e?.text ?? '')
    if (!text.startsWith('nshow:')) continue
    const rest = text.slice('nshow:'.length).trim()
    const [id, day] = rest.split(/\s+/)
    if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) continue
    const prev = seen.get(id)
    if (!prev || day > prev) seen.set(id, day)
  }
  return seen
}

/**
 * 这一次醒来该提哪一张没写日子的便条。
 *
 * - 只认 open 且没写日子的；有日子的走 renderNotes 的到期那段，不在这里重复；
 * - 从没提过的按 `created` 算起点：记下当天不提，满 7 天才第一次出现（不是催着刚记下的事）；
 * - 提过的从上次 `nshow:` 起再满 7 天才提；
 * - 一次最多一张；最久没被提过的排前面，都从没提过时按写下的先后。
 *
 * @returns {object|null}
 */
export function pickNudge(notes, now = new Date(), seen = new Map()) {
  const today = dateKey(now instanceof Date ? now : new Date(now))
  const open = []
  for (const n of notes ?? []) {
    if (!n || n.status !== 'open' || isDue(n.due)) continue
    const created = String(n.created ?? '').slice(0, 10)
    const from = seen.get(n.id) ?? created
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) continue
    if (daysBetween(from, today) < NOTE_NUDGE_DAYS) continue
    open.push({ n, from })
  }
  if (!open.length) return null
  open.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : String(a.n.created).localeCompare(String(b.n.created))))
  return open[0].n
}

/**
 * 醒来第一段：到期的纸条，以及一张没写日子的。
 *
 * 纯函数（可测），没有可摆的时返回空串——`parts.filter(Boolean)` 会自动跳过，
 * 所以没有便条的那一次唤醒一个字都不会多。
 *
 * 到期的那几张只列**有日子且到期**的（`due <= 今天`），过期不删，她看得见晚了几天。
 * 没日子的不再只提一次：记下满 `NOTE_NUDGE_DAYS` 天起，每满 7 天在醒来时提一张
 * （`pickNudge` 轮换，一次最多一张）；划掉/放下就不再提。
 *
 * 文案只写事实：几号、什么事、晚了几天。不写「逾期」「请尽快」，不排序成"紧急"。
 *
 * @param {Array} notes readNotes() 的结果（已规整）
 * @param {Date|number} [now]
 * @param {{seen?: Map<string,string>}} [opts] seen：nudgeSeen(events) 的结果
 * @returns {string}
 */
export function renderNotes(notes, now = new Date(), { seen = new Map() } = {}) {
  const today = dateKey(now instanceof Date ? now : new Date(now))
  const due = []
  for (const n of notes ?? []) {
    if (!n || n.status !== 'open') continue
    if (!isDue(n.due)) continue
    const late = daysBetween(n.due, today)
    if (late < 0) continue // 还没到日子：不到期不上桌
    due.push({ ...n, late })
  }

  // 没写日子的：一周最多提一张。pickNudge 只认满 7 天的，所以当天不会冒出来。
  const nudge = pickNudge(notes, now, seen)
  if (!due.length && !nudge) return ''

  const lines = []
  if (due.length) {
    // 最欠的排最前：到期日早的在前，同一天按记下来的时间
    due.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : String(a.created).localeCompare(String(b.created))))
    const shown = due.slice(0, NOTE_SHOW_MAX)
    lines.push(`（压着${cnCount(due.length)}张便条）`)
    for (const n of shown) {
      const mmdd = `${n.due.slice(5, 7)}-${n.due.slice(8, 10)}`
      const tail = n.late === 0 ? '就是今天。' : `晚了${cnNum(n.late)}天。`
      lines.push(`${mmdd} ${n.text}，${tail}`)
    }
    const rest = due.length - shown.length
    if (rest > 0) lines.push(`还有${cnCount(rest)}条没列出来，都在便条里。`)
  }

  if (nudge) {
    if (lines.length) lines.push('')
    const mmdd = String(nudge.created ?? '').slice(5, 10)
    lines.push('（便条里有一张没写日子的）')
    lines.push(`${mmdd} 你记着：${nudge.text}（隔些天提一次）`)
  }
  return lines.join('\n')
}

/**
 * 改便条的四个入口（记、划、改、放下）都是「读整份 → 改一张 → 写回」，排成一队：
 * 并发的两次以前都读到旧的那份，后写的把先写的那张盖掉，两边都回「已记」。
 */
const mutateNotes = (root, fn) => mutateJson(notesPath(root), fn)

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
    return await mutateNotes(root, async () => {
    const notes = await readNotes(root)
    // 名额只算还没划掉的。划掉/放下的不占位——否则划满两百张之后再也记不进，
    // 而拒绝的话还说「先划掉几张」，便条里根本没有能划的（issue #53 的死锁）。
    const openCount = notes.filter((n) => n.status === 'open').length
    if (openCount >= NOTES_MAX) {
      return { ok: false, id: '', note: '便条堆满两百张没动的了，先划掉几张，或者放下几张（放下要写一句为什么）再说。' }
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
    return { ok: true, id: note.id, note: '已记。', echo: note.text }
    })
  } catch (err) {
    return { ok: false, id: '', note: '这张没记下来。' }
  }
}

/**
 * 按原话找一张：重名先划最早记下的；都划过了才认 done（重复划掉不算错）。
 *
 * 最后才认 dropped（issue #82）：放下了的条目在回翻里明明看得见，按原话却
 * 说「便条里没有这一张」，她会以为那张丢了。找得到才能让改/划的回执说出
 * 「已经放下了」，而不是一句「没有」。
 */
function findByText(notes, body) {
  const same = notes.filter((n) => n.text === body)
  const open = same.filter((n) => n.status === 'open')
  open.sort((a, b) => String(a.created).localeCompare(String(b.created)))
  return open[0] ?? same.find((n) => n.status === 'done') ?? same.find((n) => n.status === 'dropped')
}

/**
 * 划掉一张纸条（做完）。永不抛。
 *
 * 她手里没有 id：回执不带数字，醒来那行也不印（没日子的进不了那段，印了也关不掉）。
 * 她有的只是自己写过的那句话，所以按原话找；id 这条路留着，value 里还拿得到。
 * @returns {Promise<{ok:boolean, id:string, note:string}>}
 */
export async function closeNote(root, { id, text } = {}) {
  const key = String(id ?? '').trim()
  // 和 addNote 同一个规整：落盘的字就是这么规整过的，多个空格、换行不该让她关不掉
  const body = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!key && !body) return { ok: false, id: '', note: '要划掉哪一张？把当时记的那句话告诉我。' }
  try {
    return await mutateNotes(root, async () => {
    const notes = await readNotes(root)
    const hit = notes.find((n) => key && n.id === key) ?? findByText(notes, body)
    if (!hit) {
      return { ok: false, id: '', note: '便条里没有这一张。要和当时记的那句话一字不差，前面的日子、后面的晚了几天都不算。' }
    }
    if (hit.status === 'done') return { ok: true, id: hit.id, note: '已经划掉过了。' }
    // 放下了的不是「做完了」，别把「放下」改写成「划掉」（issue #82）。
    if (hit.status === 'dropped') return { ok: false, id: '', note: '这张已经放下了，不用再划。' }
    hit.status = 'done'
    hit.closedAt = new Date().toISOString()
    await writeNotes(root, notes)
    // issue #133 的 C：回执原来只有一句「已划掉。」，进回忆（lib/use.js 记的
    // `use:her_note ok …`）就是一行没有内容的账——她翻到只知道「我那天划过一张」，
    // 不知道划掉的是哪件事。带上原话，回忆里才读得出「你那天做完：交水费」。
    return { ok: true, id: hit.id, note: '已划掉。', echo: `已划掉：${hit.text}` }
    })
  } catch (err) {
    return { ok: false, id: '', note: '这会儿写不进去，等一下再试。' }
  }
}

// ---- 回翻、改一句、放下（issue #53，2026-11-06）----
// 三件事共用一套「按她看得见的东西找条」：她手里没有 id，只有自己写过的那句话。
// 所以对外只认原话；id 这条路留着给代码用，不进说明书。

/** list 里的一行。关掉的那几种带上关掉的日期，放下的还要带上那句为什么。 */
function listLine(n) {
  // closedAt 是带 Z 的 UTC 时刻，日期要按本地日历取（同 issue #19）：直接切前 10 位，
  // 东八区凌晨到早上 8 点前关掉的会写成前一天。解析不出就不写日期。
  const md = (iso) => {
    const ms = Date.parse(String(iso ?? ''))
    return Number.isFinite(ms) ? dateKey(new Date(ms)).slice(5) : ''
  }
  if (n.status === 'done') {
    const at = md(n.closedAt)
    return `✓ ${n.text}${at ? `（${at} 划掉）` : ''}`
  }
  if (n.status === 'dropped') {
    const at = md(n.closedAt)
    return `✗ ${n.text}${at ? `（${at} 放下）` : ''}${n.reason ? `—— ${n.reason}` : ''}`
  }
  return n.due ? `${n.due.slice(5)} ${n.text}` : `（没日子）${n.text}`
}

/** 还没关掉的先按到期日（没日子的排最后），关掉的按关掉的时间倒序。 */
function sortForList(notes) {
  const open = notes.filter((n) => n.status === 'open')
  const closed = notes.filter((n) => n.status !== 'open')
  open.sort((a, b) => {
    if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1
    if (a.due && !b.due) return -1
    if (!a.due && b.due) return 1
    return String(a.created).localeCompare(String(b.created))
  })
  closed.sort(
    (a, b) =>
      String(b.closedAt ?? '').localeCompare(String(a.closedAt ?? '')) ||
      String(b.created).localeCompare(String(a.created)),
  )
  return [...open, ...closed]
}

/** 按 filter 挑出这一类（纯函数，可测）。filter 不认识就当 open。 */
export function filterNotes(notes, filter = 'open') {
  const f = NOTE_FILTERS.includes(String(filter)) ? String(filter) : 'open'
  const list = (notes ?? []).filter(Boolean)
  if (f === 'all') return sortForList(list)
  if (f === 'open') return sortForList(list.filter((n) => n.status === 'open'))
  if (f === 'due') return sortForList(list.filter((n) => n.status === 'open' && isDue(n.due)))
  return sortForList(list.filter((n) => n.status === f))
}

const EMPTY_LIST = {
  open: '便条里没有还没划掉的。',
  due: '没有哪张写着日子。',
  done: '还没有划掉的。',
  dropped: '还没有放下的。',
  all: '便条里什么都没有。',
}

/**
 * 翻便条（reading 用，改不了任何东西）。
 *
 * 只列字，不报总数——「你还有 3 条」这种句式谢绝。列不下的写一句「后面还有」，
 * 往后翻用 offset。没日子那种的照旧标出来：它在便条里，醒来时不一定自己出现（满 7 天才提一张）。
 * @returns {Promise<{ok:boolean, text:string, note:string}>}
 */
export async function listNotes(root, { filter = 'open', offset = 0, limit = NOTE_LIST_MAX } = {}) {
  const f = NOTE_FILTERS.includes(String(filter)) ? String(filter) : 'open'
  const off = Number(offset) > 0 ? Math.trunc(Number(offset)) : 0
  const lim = Number(limit) > 0 ? Math.min(Math.trunc(Number(limit)), NOTE_LIST_MAX) : NOTE_LIST_MAX
  try {
    const all = filterNotes(await readNotes(root), f)
    if (!all.length) return { ok: true, text: EMPTY_LIST[f], note: '' }
    const page = all.slice(off, off + lim)
    if (!page.length) return { ok: true, text: '后面没有了。', note: '' }
    const lines = page.map(listLine)
    const rest = all.length - (off + page.length)
    if (off > 0) lines.unshift(`（从第${cnNum(off + 1)}张接着看）`)
    if (rest > 0) lines.push('……后面还有，没一次列完（offset 往后翻）。')
    return { ok: true, text: lines.join('\n'), note: '' }
  } catch (err) {
    return { ok: false, text: '', note: '这会儿翻不开，等一下再试。' }
  }
}

/** 按 id 或原话找一张；先 id，再原话（没关掉的优先，其次已划掉的，再其次已放下的）。 */
function locate(notes, { id, text } = {}) {
  const key = String(id ?? '').trim()
  if (key) {
    const byId = notes.find((n) => n.id === key)
    if (byId) return byId
  }
  const body = String(text ?? '').replace(/\s+/g, ' ').trim()
  return body ? findByText(notes, body) ?? null : null
}

/**
 * 改一句（写错了）。永不抛。
 *
 * 只改没关掉的那张：划掉/放下了的改不了——回翻里留着当时那句话，改它等于改历史。
 * `due` 不给就不动日子，给空串是去掉日子，给日期是改期。
 * @returns {Promise<{ok:boolean, id:string, note:string, echo?:string}>}
 */
export async function updateNote(root, { id, text, newText, due } = {}) {
  const key = String(id ?? '').trim()
  const body = String(text ?? '').replace(/\s+/g, ' ').trim()
  const next = String(newText ?? '').replace(/\s+/g, ' ').trim()
  if (!key && !body) return { ok: false, id: '', note: '要改哪一张？把当时记的那句话告诉我。' }
  if (!next) return { ok: false, id: '', note: '改成什么？把新的那句话告诉我。' }
  if (next.length > NOTE_TEXT_MAX) {
    return { ok: false, id: '', note: `太长了，压到 ${NOTE_TEXT_MAX} 字以内。` }
  }
  const day = due === undefined ? undefined : String(due ?? '').trim()
  if (day !== undefined && day && !isDue(day)) {
    return { ok: false, id: '', note: '日子要写成 2026-11-05 这样，或者给空串把日子去掉。' }
  }
  try {
    return await mutateNotes(root, async () => {
    const notes = await readNotes(root)
    const hit = locate(notes, { id: key, text: body })
    if (!hit) {
      return { ok: false, id: '', note: '便条里没有这一张。要和当时记的那句话一字不差。' }
    }
    if (hit.status === 'done') return { ok: false, id: '', note: '这张已经划掉了，改不了。' }
    if (hit.status === 'dropped') return { ok: false, id: '', note: '这张已经放下了，改不了。' }
    hit.text = next.slice(0, NOTE_TEXT_MAX)
    if (day !== undefined) hit.due = day
    hit.revisedAt = new Date().toISOString()
    await writeNotes(root, notes)
    return { ok: true, id: hit.id, note: '改好了。', echo: hit.text }
    })
  } catch (err) {
    return { ok: false, id: '', note: '这会儿写不进去，等一下再试。' }
  }
}

/**
 * 放下（决定不做，并写一句为什么）。永不抛。
 *
 * 跟划掉一样只是改状态、条目一条不删；差别只在多一句 reason，那句必须她自己写。
 * 不检查写得好不好——只要求非空，不然就跟删掉没区别了。
 * @returns {Promise<{ok:boolean, id:string, note:string}>}
 */
export async function dropNote(root, { id, text, reason } = {}) {
  const key = String(id ?? '').trim()
  const body = String(text ?? '').replace(/\s+/g, ' ').trim()
  const why = String(reason ?? '').replace(/\s+/g, ' ').trim()
  if (!key && !body) return { ok: false, id: '', note: '要放下哪一张？把当时记的那句话告诉我。' }
  if (!why) return { ok: false, id: '', note: '放下还要说一句为什么——不然就跟删掉没区别了。' }
  if (why.length > NOTE_TEXT_MAX) {
    return { ok: false, id: '', note: `原因太长了，压到 ${NOTE_TEXT_MAX} 字以内。` }
  }
  try {
    return await mutateNotes(root, async () => {
    const notes = await readNotes(root)
    const hit = locate(notes, { id: key, text: body })
    if (!hit) {
      return { ok: false, id: '', note: '便条里没有这一张。要和当时记的那句话一字不差。' }
    }
    if (hit.status === 'dropped') return { ok: true, id: hit.id, note: '之前就放下了。' }
    if (hit.status === 'done') return { ok: false, id: '', note: '这张已经划掉了，不用再放下。' }
    hit.status = 'dropped'
    hit.reason = why.slice(0, 200)
    hit.closedAt = new Date().toISOString()
    await writeNotes(root, notes)
    return { ok: true, id: hit.id, note: '放下了。' }
    })
  } catch (err) {
    return { ok: false, id: '', note: '这会儿写不进去，等一下再试。' }
  }
}

/** 这一次是哪件事。没写 action 的按老路走：status=done 或只给 id 是划掉，其余是记一张。 */
export function noteAction(args = {}) {
  const a = String(args?.action ?? '').trim()
  if (['add', 'list', 'update', 'drop', 'done'].includes(a)) return a
  return isClosing(args) ? 'done' : 'add'
}

/** 这一次是划掉还是记。execute 和 render 用同一个判据，回执才不会和实际做的事对不上。 */
const isClosing = (args) =>
  String(args?.status ?? '').trim() === 'done' ||
  Boolean(String(args?.id ?? '').trim() && !String(args?.text ?? '').trim())

/** 注册 her_note 工具。 */
export function registerNote(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  return ctx.tools.register(
    defineTool({
      name: 'her_note',
      description:
        '醒来时摆在你最前面的那叠便条：记一张还没做的事、翻一翻有哪些、划掉做完的、或者放下决定不做的。' +
        '记的时候给 text（和日子 due，可以不给）；划掉把当时记的那句话原样放进 text，再加 status:"done"；' +
        '看便条有哪些给 action:"list"（filter 可以选 open / due / done / dropped / all，列不完用 offset 往后翻）；' +
        '改一句给 action:"update"（text 指认原来那句，newText 写新的）；' +
        '放下给 action:"drop"（同样用 text 指认，reason 写一句为什么）。',
      parameters: toJsonSchema({
        action: {
          type: 'string',
          enum: ['add', 'list', 'update', 'drop', 'done'],
          description: '要做哪件事：记一张（add，不给就是这个）、翻便条（list）、改一句（update）、放下（drop）、划掉（done）。',
        },
        text: {
          type: 'string',
          description: '要记下来的那件事，一句话。划掉、改、放下的时候写当时记的那句话，要一字不差。',
        },
        due: {
          type: 'string',
          description:
            '哪天该做，写成 2026-11-05。不写就不会在醒来时出现，只能自己 list 看；改一句时给空串是把日子去掉。',
        },
        id: { type: 'string', description: '这张纸条的编号。手里没有就不用给，给 text 就行。' },
        status: { type: 'string', enum: ['done'], description: '划掉的时候给 done。' },
        filter: {
          type: 'string',
          enum: ['open', 'due', 'done', 'dropped', 'all'],
          description: 'list 时看哪一类，默认 open（还没关掉的）。',
        },
        offset: { type: 'integer', description: 'list 时从第几张往后翻，默认从最前面。' },
        limit: { type: 'integer', description: 'list 时一次最多列几张，默认 20。' },
        newText: { type: 'string', description: 'update 时改成哪句话。' },
        reason: { type: 'string', description: 'drop 时为什么不做了，必填。' },
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
        // 和 her_leave 同一条规矩：只回方括号标记，不写完整句子、不带"还剩几张"。
        // 划掉不能沿用写入的字：读到「记下了」，她会以为便条里又多了一张。
        // list 例外：它列的本来就是字，不是回执。
        render: (args, out) => {
          const act = noteAction(args)
          if (act === 'list') {
            return [{ type: 'text', text: out.ok ? out.text : `[没列出来：${out.note}]` }]
          }
          if (act === 'update') {
            return [{ type: 'text', text: out.ok ? '[改好了]' : `[没改：${out.note}]` }]
          }
          if (act === 'drop') {
            return [{ type: 'text', text: out.ok ? '[放下了]' : `[没放下：${out.note}]` }]
          }
          if (act === 'done') {
            return [{ type: 'text', text: out.ok ? '[划掉了]' : `[没划掉：${out.note}]` }]
          }
          if (!out.ok) return [{ type: 'text', text: `[没记下：${out.note}]` }]
          // 没日子的那张以后不会上桌，所以它只在这里被提这一次——这不是提醒，是入账凭证。
          const tail = String(args?.due ?? '').trim() ? '' : '（没写日子，醒来不会出现）'
          return [{ type: 'text', text: `[记下了：${out.echo ?? ''}]${tail}` }]
        },
      },
      async execute(args, exec) {
        const who = guardWrite(deps.tenant, exec, 'her_note')
        if (!who.ok) return { ok: false, id: '', note: who.note }
        const act = noteAction(args)
        if (act === 'list') {
          const r = await listNotes(root, { filter: args?.filter, offset: args?.offset, limit: args?.limit })
          return { ok: r.ok, id: '', note: r.note, text: r.text }
        }
        if (act === 'update') {
          return updateNote(root, { id: args?.id, text: args?.text, newText: args?.newText, due: args?.due })
        }
        if (act === 'drop') {
          return dropNote(root, { id: args?.id, text: args?.text, reason: args?.reason })
        }
        if (act === 'done') {
          return closeNote(root, { id: args?.id, text: args?.text })
        }
        return addNote(root, { text: args?.text, due: args?.due })
      },
    }),
  )
}
