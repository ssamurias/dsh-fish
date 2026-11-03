/**
 * inbox.js —— 信箱：把她说过的话聚到一处
 *
 * 为什么需要（P3）：
 *   她的原话一直躺在 events.jsonl 里，但那是个流水账——夹杂 meta、browse 记账、
 *   冷落判断。要看"她最近都说了什么"得自己过滤。信箱做两件事：
 *     ① 只挑她的话（HER_TYPES），按时间倒序，带未读标记；
 *     ② 落一份纯文本 `inbox.md`，不打开 App 也能直接看文件。
 *
 * 未读怎么算（刻意做得笨）：
 *   记住"最后一次读到哪个 id"，之后的事件都算未读。id 是 ULID，单调递增，
 *   所以按事件流里的位置比较就够，不需要时间戳——时间戳会被时区骗。
 *
 * 铁律：这个文件**只读事件流**，不写任何指向她的状态。
 *      `inbox-state.json` 记的是"人读到哪了"，是人的阅读进度，不是她的性格。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { readEvents, writeAtomic, readJson, rootDir, paths } from './store.js'
import { HER_TYPES } from './schema.js'

/** 她说的话：她自己提交的那几类。diary 不在里面（日记不进事件流）。 */
const SPEAK_TYPES = new Set(HER_TYPES)

const pad2 = (n) => String(n).padStart(2, '0')

/**
 * 事件里的 ts 是 UTC（toISOString() 带 Z），但**人要读的是他墙上的钟**。
 *
 * 2026-11-03（github:ssamurias/dsh-fish#19）：原来直接 `String(ts).slice(0,16)`，
 * 切出来的是 UTC 那一刻的字符串，东八区看小纸条永远早 8 小时（22:16 印成 14:16），
 * 而正文里她自己写的「现在十点多」又是对的，两边对不上。
 *
 * 上面那段注释说的「时间戳会被时区骗」是针对**未读判定**——那个已经改用 ULID 位置了，
 * 跟这里不冲突：未读继续按 id 比，展示必须按本地钟印。
 *
 * @returns {'YYYY-MM-DD HH:MM'} 解析不出来时返回空串（宁可少印一行时间，也不印错）
 */
function localStamp(ts) {
  const ms = Date.parse(String(ts ?? ''))
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function stateFile(root) {
  return join(paths(root).root, 'inbox-state.json')
}

/**
 * 留话的 id 集合（R4）。
 * 单独放一份在这里而不是 import letter.js：letter.js 依赖 inbox.js（写完要重写信箱文件），
 * 反过来再 import 就成了循环。这里只做字符串判断，十个字符的事，不值得引一个环。
 */
function letterIdSet(events) {
  const s = new Set()
  for (const e of events) {
    if (e?.type !== 'meta') continue
    const t = String(e.text ?? '')
    if (!t.startsWith('letter:')) continue
    const id = t.split(':')[2]
    if (id) s.add(id)
  }
  return s
}

/**
 * 从事件流里挑出她说过的话。
 *
 * `lettersOnly`（2026-10-24 用户定）：信箱只放**特意写给人的信**。
 * 理由是她说的话本来就在对话框里，全量搬一遍只是重复；一个只能看不能回、
 * 又不参与成长的列表，价值就在于「她主动留了一句」，不在于「所有记录」。
 *
 * @returns {{rows:Array, total:number, unread:number, letters:number, lastReadId:string|null}}
 *   rows 时间倒序（最新在前）；`letter=true` 表示这句是她特意留给人的。
 */
export function buildInbox(events, { lastReadId = null, limit = 200, lettersOnly = false } = {}) {
  const rows = []
  const letterOf = letterIdSet(events)
  let readUpTo = -1
  if (lastReadId) {
    const idx = events.findIndex((e) => e.id === lastReadId)
    if (idx >= 0) readUpTo = idx
  } else {
    // 从没读过：全部算未读（第一次打开信箱就该有东西看）
    readUpTo = -1
  }

  events.forEach((e, i) => {
    if (!SPEAK_TYPES.has(e.type)) return
    const isLetter = letterOf.has(e.id)
    if (lettersOnly && !isLetter) return
    rows.push({
      id: e.id,
      ts: e.ts,
      day: e.day,
      type: e.type,
      text: e.text,
      verdict: e.verdict ?? null,
      confidence: e.confidence,
      flags: Array.isArray(e.flags) ? e.flags : [],
      // R4：这句是不是「留话」。留话和独白在事件流里是同一个类型（utterance），
      // 只有这条 meta 能区分开——观测台靠它标「她留给你的」。
      letter: isLetter,
      // 未读 = 排在"读到过的最后一条"之后
      unread: i > readUpTo,
    })
  })

  rows.reverse()
  const trimmed = rows.slice(0, Math.max(1, limit))
  return {
    rows: trimmed,
    total: rows.length,
    unread: rows.filter((r) => r.unread).length,
    // 未读的留话单独数一份：观测台用它提醒"她有话留给你"，不必点开全量信箱
    letters: rows.filter((r) => r.letter && r.unread).length,
    lastReadId,
  }
}

async function readInboxState(root) {
  const s = await readJson(stateFile(root), null)
  return s && typeof s === 'object' ? s : { lastReadId: null, readAt: null }
}

/** 标记已读到最新一条（返回新的未读数，通常是 0） */
export async function markRead(root = rootDir()) {
  const { events } = await readEvents(root)
  const last = events.length ? events[events.length - 1].id : null
  const next = { lastReadId: last, readAt: new Date().toISOString() }
  await writeAtomic(stateFile(root), JSON.stringify(next, null, 2))
  return { ...next, unread: 0 }
}

/** 读信箱（含未读数）。信箱只放留话，所以她平常说的话不在这里——那些在对话框里。 */
export async function readInbox(root = rootDir(), opts = {}) {
  const { events } = await readEvents(root)
  const st = await readInboxState(root)
  return buildInbox(events, {
    lastReadId: st.lastReadId,
    limit: opts.limit ?? 200,
    lettersOnly: opts.lettersOnly ?? true,
  })
}

const TYPE_LABEL = {
  utterance: '她说的',
  revise: '认知重构',
  refusal: '她拒绝了',
  reunion: '重聚时她说的',
  narration: '她对自己说',
}

/**
 * 落一份纯文本信箱，人可以直接双击看。
 *
 * 为什么不做成 JSON：这是给人的东西。文件在 `~/.dsh-fish/inbox.md`。
 * 每次有新的话就重写（幂等，只覆盖自己这一个文件）。
 *
 * 2026-10-24 起只写**留话**：她在对话框里说的话本来就能在对话里看到，
 * 这个文件只负责「她特意留的那几句」。
 */
export async function writeInboxFile(root = rootDir(), { limit = 60 } = {}) {
  const box = await readInbox(root, { limit, lettersOnly: true })
  const lines = []
  lines.push('# 大肥鱼留给你的话')
  lines.push('')
  lines.push(`共 ${box.total} 封，未读 ${box.unread} 封。最新在上。`)
  lines.push('')
  lines.push('这里只有特意留给你的。平常说的话在对话框里，不在这儿。')
  lines.push('')
  if (!box.rows.length) {
    lines.push('> 还没有。这是起点，不是故障。')
    lines.push('')
    const empty = join(paths(root).root, 'inbox.md')
    await writeAtomic(empty, lines.join('\n'))
    return empty
  }
  for (const r of box.rows) {
    // 2026-11-03（issue #19）：走本地钟，别直接切 ISO 串——切出来是 UTC。
    const when = localStamp(r.ts)
    const label = r.type === 'utterance' && r.letter ? '她留给你的话' : (TYPE_LABEL[r.type] ?? r.type)
    const mark = r.unread ? ' ·未读' : ''
    lines.push(when ? `## ${when} · ${label}${mark}` : `## ${label}${mark}`)
    lines.push('')
    // 引用块：看起来像"她在说"，而不是一份报告
    for (const ln of String(r.text ?? '').split('\n')) lines.push(`> ${ln}`)
    if (r.type === 'revise' && r.verdict) lines.push('')
    if (r.type === 'revise' && r.verdict) lines.push(`（${r.verdict === 'refuted' ? '被推翻' : r.verdict === 'refined' ? '修正' : '仍成立'}）`)
    lines.push('')
  }
  const file = join(paths(root).root, 'inbox.md')
  await writeAtomic(file, lines.join('\n'))
  return file
}

/** 事件流里已经存在的她自己写的话（供 say/wake 判断"这轮她开没开口"） */
export function newHerEventsSince(events, sinceId) {
  const idx = sinceId ? events.findIndex((e) => e.id === sinceId) : events.length
  const from = idx >= 0 ? idx + 1 : 0
  return events.slice(from).filter((e) => SPEAK_TYPES.has(e.type))
}
