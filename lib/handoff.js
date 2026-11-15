/**
 * 换房间时的那一页「上次停在这」（2026-11-15，用户 m01722 拍板）。
 *
 * 为什么单独拎出来、不写进身份文档：
 *   以前「上次说到这」是写进 `她的身份.md` 的，8 轮 / 3 天才消失。那段时间里
 *   她每一轮都读到同一段，久了就变成新的固定人设——不是「刚才」，是「档案」。
 *   现在它只在一个时刻出现：换房间之后、他开口的第一轮。那一轮结束就撤。
 *
 * 为什么结构是「最后两句 → 还挂着的事 → 再往前」：
 *   让人察觉「换了个人」的不是忘事，是语气断掉——新房间第一句回到「在吗？我在」。
 *   语气靠最后一两句原话接，所以那两句放最前、不裁剪、不总结；事情放中间；
 *   更早的原话放最后，只是补上下文，不是主体。整页不超过 HANDOFF_LIMIT 字。
 *
 * 为什么不写进 events.jsonl：和便条、约定同一个理由——它是操作层的一页纸，
 * 不是她长出来的东西；混进成长记录会污染 derive 的三道门。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { paths } from './store.js'
import { readNotes } from './note.js'
import { readAppointments } from './appoint.js'
import { recentExchanges } from './talkmem.js'
import { fillOwner } from './pronoun.js'
import { clipText } from './clip.js'

/** 一页最多多少字。超了就截——它不是档案，是「刚才」。 */
export const HANDOFF_LIMIT = 400

/** 还没划掉的便条最多摆几条、约定最多摆几条。 */
const NOTES_MAX = 2
const APPOINTS_MAX = 1
/** 每条摆多长。 */
const OPEN_TEXT_MAX = 40
/** 「再往前」最多补几轮原话（不含最后那一条）。 */
const EARLIER_TURNS = 2

// 「这一次该不该出现」是内存里的一个开关，不落盘：
// 落盘就要考虑「重启之后还算不算这一次」，而它本来就只活在这一轮里。
const armed = new Set()

/** 他开口了：这一轮把交接页摆出来。 */
export function armHandoff(sessionId) {
  const sid = String(sessionId ?? '')
  if (sid) armed.add(sid)
}

/** 这一轮要不要摆。 */
export function handoffArmed(sessionId) {
  return armed.has(String(sessionId ?? ''))
}

/** 这一轮过完了：撤掉，以后不再出现。 */
export function disarmHandoff(sessionId) {
  armed.delete(String(sessionId ?? ''))
}

/** 测试用：把开关清干净，免得污染同一个进程里的别的用例。 */
export function resetHandoff() {
  armed.clear()
}

/** 读 home.json 里存着的那页交接（没换过房就是空串）。同步读，供 system prompt 用。 */
export function handoffTextSync(root = '') {
  try {
    const raw = JSON.parse(readFileSync(join(paths(root).root, 'home.json'), 'utf8'))
    return String(raw?.carry ?? '').trim()
  } catch {
    return ''
  }
}

function dayOf(ms) {
  const d = new Date(Number(ms) || 0)
  if (!Number.isFinite(d.getTime())) return ''
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

function dueOf(due) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(due ?? ''))
  if (!m) return ''
  return `${Number(m[2])} 月 ${Number(m[3])} 日`
}

/**
 * 把一页交接拼出来。纯函数，不读盘——读盘的部分在 buildHandoff 里。
 *
 * @param {object} o
 * @param {Array<{at?: string, me?: string, her?: string}>} o.exchanges 按时间先后
 * @param {Array<object>} o.notes 便条
 * @param {Array<object>} o.appointments 约定
 * @param {string} [o.room] 换到了哪儿（群里 / 书房），空就不写
 * @param {number} [o.now]
 * @returns {string}
 */
export function renderHandoff({ exchanges = [], notes = [], appointments = [], room = '', now = Date.now() } = {}) {
  const rows = (Array.isArray(exchanges) ? exchanges : []).filter((e) => e && (e.me || e.her))
  const parts = []

  // 1) 最后两句：语气就靠这两句接。不总结，只截长度。
  const head = rows[rows.length - 1]
  if (head) {
    const lines = []
    if (head.me) lines.push(`{T}最后说的是：「${clipText(String(head.me), 100, '…')}」`)
    if (head.her) lines.push(`你最后说的是：「${clipText(String(head.her), 100, '…')}」`)
    if (lines.length) parts.push(lines.join('\n'))
  }

  // 2) 还挂着的事：写内容，不写「你还有 N 条」——那是催办，note.js / appoint.js
  //    从第一天起就把它当硬约束禁掉了。
  const hanging = []
  const openNotes = (Array.isArray(notes) ? notes : [])
    .filter((n) => n && n.status === 'open' && String(n.text ?? '').trim())
    .slice(0, NOTES_MAX)
  for (const n of openNotes) {
    hanging.push(`- 你自己记着「${clipText(String(n.text), OPEN_TEXT_MAX, '…')}」——还没划掉`)
  }
  const openAppoints = (Array.isArray(appointments) ? appointments : [])
    .filter((a) => a && a.status === 'open' && String(a.what ?? '').trim())
    .slice(0, APPOINTS_MAX)
  for (const a of openAppoints) {
    const due = dueOf(a.due)
    hanging.push(`- 你和{T}约的「${clipText(String(a.what), OPEN_TEXT_MAX, '…')}」——${due ? `日子是 ${due}，` : ''}还没到`)
  }
  if (hanging.length) parts.push(['还挂着的事：', ...hanging].join('\n'))

  // 3) 再往前两轮：只补上下文，不是主体。
  const earlier = rows.slice(Math.max(0, rows.length - 1 - EARLIER_TURNS), -1)
  if (earlier.length) {
    const lines = []
    for (const e of earlier) {
      const at = dayOf(Date.parse(String(e.at ?? '')))
      const me = clipText(String(e.me ?? ''), 40, '…')
      const her = clipText(String(e.her ?? ''), 40, '…')
      lines.push(`- ${at ? `${at} ` : ''}{T}说：「${me}」${her ? `；你说：「${her}」` : ''}`)
    }
    parts.push(['再往前：', ...lines].join('\n'))
  }

  if (!parts.length && !room) return ''
  const head2 = room ? [`## 上次停在这（${room}）`] : ['## 上次停在这']
  const text = [
    ...head2,
    '（这些是你换窗口之前的事。下面都是原话，没有替你总结。）',
    '',
    ...(room ? [`这次换到了${room}。`] : []),
    ...parts.flatMap((p, i) => (i ? ['', p] : [p])),
  ].join('\n')
  return fillOwner(clipText(text, HANDOFF_LIMIT, '…'))
}

/**
 * 从盘上读齐材料，拼一页交接。轮换（home.rotateTalkSession）与「认领新窗口」
 * （ensureTalkSessionOnce → adoptLiveSession）都走这里，保证两条路给出同一页。
 *
 * @param {string} root
 * @param {{ turns?: number, room?: string }} [o] turns = 带几轮原话
 */
export async function buildHandoff(root, { turns = 4, room = '' } = {}) {
  const want = Math.max(0, Math.trunc(Number(turns) || 0))
  const exchanges = want > 0 ? await recentExchanges(root, want).catch(() => []) : []
  const notes = await readNotes(root).catch(() => [])
  const appointments = await readAppointments(root).catch(() => [])
  return renderHandoff({ exchanges, notes, appointments, room })
}
