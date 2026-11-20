/**
 * loops.js —— 她手上还悬着的事，收成一张统一的清单（1.0.7，A）
 *
 * 原来这些「没结的事」散在五个地方，各自只在一个场景里用：
 *   - 好奇：她自己问出来、一直没答案的问题（lib/curiosity.js）
 *   - 卡住的求助：问过但没人答、答了没兑现（lib/proactive.js 的 looseEnds）
 *   - 便条：还开着、没划掉的那些（notes.json）
 *   - 约定：还没到或还没做的（appointments.json）
 *   - 疤：她拒绝过、后来退了半步、至今没想通（derive 的 scars）
 *
 * 这一版只做「收拢」：给后面的新材料比对（C）和提醒去重（D）一个统一的入口，
 * 不改任何现有输出。清单本身不给她看——她看到的还是原来那些段落。
 *
 * 边界：
 *   - 只读，不写盘；任何一路读失败都跳过，不抛（记录坏了不该连累整张清单）。
 *   - 不排序她的价值判断：按时间倒序，让「最近还悬着的」排前面。
 *   - 文本按码点截到 80 字；超过 20 条只留最近的 20 条。
 */

import { curiosityOf } from './curiosity.js'
import { looseEnds } from './proactive.js'
import { readNotes } from './note.js'
import { readAppointments, openAppointments, momentOf } from './appoint.js'

export const LOOPS_MAX = 20
const LOOPS_TEXT_MAX = 80

function clipText(s, n = LOOPS_TEXT_MAX) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return [...t].length > n ? `${[...t].slice(0, n).join('')}…` : t
}

function msOf(v, fallback) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const t = Date.parse(String(v ?? ''))
  return Number.isFinite(t) ? t : fallback
}

/**
 * 把还悬着的事收成一张表。
 *
 * @param {object} o
 * @param {string} [o.root] 数据根目录（不传就读默认 ~/.dsh-fish）
 * @param {Array} [o.events] 事件流
 * @param {object|null} [o.model] deriveSelf 的结果（疤从这来）
 * @param {number} [o.now]
 * @returns {Promise<Array<{kind: string, id: string, text: string, at: number}>>}
 */
export async function openLoops({ root, events = [], model = null, now = Date.now() } = {}) {
  const out = []

  for (const q of curiosityOf(events, now)) {
    out.push({ kind: 'curiosity', id: '', text: q.text, at: msOf(q.at, now) })
  }

  try {
    for (const l of looseEnds(events, { now })) {
      out.push({ kind: 'ask', id: String(l?.id ?? ''), text: l?.text, at: now })
    }
  } catch { /* 这一路坏了只少几条，不挡整张清单 */ }

  try {
    for (const n of await readNotes(root)) {
      if (n?.status !== 'open') continue
      out.push({ kind: 'note', id: String(n.id ?? ''), text: n.text, at: msOf(n.created, now) })
    }
  } catch { /* 同上 */ }

  try {
    const list = await readAppointments(root)
    for (const a of openAppointments(list, { now })) {
      out.push({ kind: 'appoint', id: String(a?.id ?? ''), text: a?.what, at: msOf(a?.at ?? momentOf(a) ?? a?.due, now) })
    }
  } catch { /* 同上 */ }

  for (const s of model?.scars ?? []) {
    if (!s || s.resolvedAt) continue
    out.push({ kind: 'scar', id: String(s.id ?? ''), text: s.quote, at: msOf(s.since, now) })
  }

  const seen = new Set()
  return out
    .map((x) => ({ ...x, text: clipText(x.text) }))
    .filter((x) => {
      if (!x.text) return false
      const k = `${x.kind}\u0000${x.text}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .sort((a, b) => b.at - a.at)
    .slice(0, LOOPS_MAX)
}
