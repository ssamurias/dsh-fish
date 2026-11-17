/**
 * cue.js —— 他一开口，碰到她有过判断的话题，就把那句旧话摆到她眼前（1.0.4）
 *
 * 这不是「近三天」那种常驻频道。它只在**他这一句话**碰到某个 topic 时出现，
 * 随这一轮结束就消失；不占身份文档、不每轮都摆、也不替她判对错。
 *
 * 设计边界：
 *   - 只认她自己的判断（deriveSelf 的 active beliefs），且 topic 必须真的在他这句话里；
 *   - 最多 1 条，按 topic 判断的 since 取最近；
 *   - 只给她原话和日期，加一句「只是当时说过，不代表现在也这么想」；
 *   - 「规矩」不摆：规矩是硬约束，不是可对照的旧判断；
 *   - 拿不到最新派生（进程刚起、还没写过身份文档）就不摆，不猜。
 *
 * 为什么用 memory 里的最新派生，而不是每句话都重算事件流：
 *   身份文档每次写盘都会 deriveSelf 一次，结果已经是最新的；他一开口只要同步
 *   匹配文本即可。cueFor 第一次求值后把结果缓存到这一轮结束，避免她这一轮中途
 *   写下的新判断反过来被当成「旧话」。
 */

import { dateKey } from './settings.js'
import { lastDerived } from './derive.js'

const RULE_TOPIC = '规矩'
const OLD_TEXT_MAX = 80
/** 兜底过期：turn/end 丢了、进程刚起，也不让上一句的 cue 一直挂着。 */
export const CUE_TTL_MS = 15 * 60_000

const latestText = new Map()
const latestAt = new Map()
const cueCache = new Map()

/** 他一开口就记下这句话（同步，能在宿主组装提示词之前跑到）。 */
export function rememberHuman(sessionId, text, { at = Date.now() } = {}) {
  const sid = String(sessionId ?? '')
  const t = String(text ?? '').trim()
  if (!sid) return
  if (!t) {
    latestText.delete(sid)
    latestAt.delete(sid)
    cueCache.delete(sid)
    return
  }
  latestText.set(sid, t)
  latestAt.set(sid, at)
  cueCache.delete(sid)
}

/** 这一轮结束（或他离开）就撤掉，免得下一轮还挂着上一句的旧话。 */
export function clearHuman(sessionId) {
  const sid = String(sessionId ?? '')
  latestText.delete(sid)
  latestAt.delete(sid)
  cueCache.delete(sid)
}

/** 这一轮要摆的那一行；没有就空串。同步，可安全给 systemPrompt.section 的 text()。 */
export function cueFor(sessionId, { now = Date.now(), model } = {}) {
  const sid = String(sessionId ?? '')
  if (!sid) return ''
  const text = latestText.get(sid) ?? ''
  if (!text) return ''
  const at = latestAt.get(sid) ?? 0
  if (now - at > CUE_TTL_MS) {
    latestText.delete(sid)
    latestAt.delete(sid)
    cueCache.delete(sid)
    return ''
  }
  if (cueCache.has(sid)) return cueCache.get(sid)
  let line = ''
  try {
    line = cueLineFrom(model === undefined ? lastDerived() : model, text)
  } catch {
    line = ''
  }
  cueCache.set(sid, line)
  return line
}

/**
 * 纯函数：从派生结果和他这句话里找一条旧判断。
 * @param {object|null} model deriveSelf 的结果
 * @param {string} text 他这一句
 * @param {{ now?: number }} [opts]
 * @returns {string} 空串表示不摆
 */
export function cueLineFrom(model, text, { now = Date.now() } = {}) {
  const t = String(text ?? '').trim()
  if (!t) return ''
  const lower = t.toLowerCase()
  const hits = (model?.beliefs ?? []).filter((b) => {
    if (!b || b.status !== 'active') return false
    const topic = String(b.topic ?? '').trim()
    if (!topic || topic === RULE_TOPIC) return false
    // 单字 topic 太容易撞（「好」「人」），不拿它当 cue。
    if ([...topic].length < 2) return false
    return lower.includes(topic.toLowerCase())
  })
  if (!hits.length) return ''
  hits.sort((a, b) => (Date.parse(b.since) || 0) - (Date.parse(a.since) || 0))
  const b = hits[0]
  const said = String(b.text ?? '').replace(/\s+/g, ' ').trim()
  if (!said) return ''
  const clipped = [...said].length > OLD_TEXT_MAX
    ? `${[...said].slice(0, OLD_TEXT_MAX).join('')}…`
    : said
  const at = Date.parse(b.since)
  const when = Number.isFinite(at) ? dateKey(new Date(at)).slice(5) : ''
  const stamp = when ? `（${when}）` : ''
  return [
    '## 这一句碰到的旧话',
    `- 你以前说过：「${clipped}」${stamp}。只是你当时说过，不代表现在也这么想。`,
  ].join('\n')
}
