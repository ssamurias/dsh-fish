/**
 * speechanchor.js —— 说话设置「纠正鱼八股」要用的那一小段（1.0，用户 m04784）
 *
 * 只做一件事：把最近几天里**能被引用的东西**按时间挑出来，最多 3 条，
 * 写成一小段附在身份文档末尾。**不按语义匹配**——挂错的代价是引一句
 * 她没说过的话，比不说更糟（2026-11-13 用户 m04784：按时间取，不按语义）。
 *
 * 这段**不占「身份段字数」预算**：它由 personaLine 在 assemble 之后追加，
 * 预算算的是她自己长出来的那部分，这里是从事件流里临时取的素材。
 *
 * 没有素材时不编：段里直说「最近没有能引的东西」。
 */

const DAY_MS = 24 * 60 * 60 * 1000

export const ANCHOR_DAYS = 7
export const ANCHOR_MAX = 3
export const ANCHOR_TEXT_MAX = 60
export const ANCHOR_TITLE_MAX = 40

function cut(s, max) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function dateOf(ts) {
  const at = typeof ts === 'number' ? ts : Date.parse(String(ts ?? ''))
  if (!Number.isFinite(at)) return ''
  const d = new Date(at)
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

function within(ts, from, now) {
  const at = typeof ts === 'number' ? ts : Date.parse(String(ts ?? ''))
  return Number.isFinite(at) && at >= from && at <= now
}

/**
 * 最近能引的素材，按时间从新到旧。
 *
 * 只认四种来路（可信度从高到低，但排序**按时间**，不按可信度）：
 *   heard    他私下说过的原话（群里不算）
 *   belief   她自己认领过的判断
 *   looked   她点开看过的视频标题
 *
 * 字幕只留了 `subs:` 索引（没有正文），要引原句得她自己去查，
 * 所以这里不摆——摆了也没有内容可引。
 */
export function recentAnchors(model, { now = Date.now(), days = ANCHOR_DAYS, limit = ANCHOR_MAX } = {}) {
  const from = now - days * DAY_MS
  const out = []

  for (const h of Array.isArray(model?.recentHeard) ? model.recentHeard : []) {
    if (String(h?.scene ?? '') === 'group') continue
    const text = cut(h?.text, ANCHOR_TEXT_MAX)
    if (!text || !within(h?.at, from, now)) continue
    out.push({ kind: 'heard', at: Number(h.at), date: dateOf(h.at), text })
  }

  for (const b of Array.isArray(model?.beliefs) ? model.beliefs : []) {
    if (b?.status !== 'active') continue
    const text = cut(b?.text, ANCHOR_TEXT_MAX)
    if (!text || !within(b?.since, from, now)) continue
    out.push({ kind: 'belief', at: Date.parse(String(b.since)), date: dateOf(b.since), text })
  }

  for (const v of Array.isArray(model?.lookedRecent) ? model.lookedRecent : []) {
    const title = cut(v?.title, ANCHOR_TITLE_MAX)
    if (!title || !within(v?.at, from, now)) continue
    out.push({ kind: 'looked', at: Number(v.at), date: dateOf(v.at), text: title })
  }

  // 1.0.0（用户 m05089）：她看过的视频里、真正记下来的那几句原话。
  // 这比标题强——标题只能说明「看过」，原话才能被引。每条只取第一句，
  // 免得同一来源连着占三条。
  for (const m of Array.isArray(model?.materials) ? model.materials : []) {
    const q = (Array.isArray(m?.quotes) ? m.quotes : []).find((x) => String(x?.text ?? '').trim())
    if (!q) continue
    const text = cut(q.text, ANCHOR_TEXT_MAX)
    if (!text || !within(m?.at, from, now)) continue
    out.push({
      kind: 'material',
      at: Number(m.at),
      date: dateOf(m.at),
      text,
      title: cut(m?.title, ANCHOR_TITLE_MAX),
      by: String(q?.by ?? '').trim(),
    })
  }

  // 同一句话只留一条；按时间从新到旧，取前 limit 条。
  const seen = new Set()
  return out
    .sort((a, b) => b.at - a.at)
    .filter((x) => {
      const k = `${x.kind}:${x.text}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .slice(0, Math.max(1, limit))
}

/**
 * 写成身份文档末尾那一段。没有素材时也给规则，不编内容。
 * `{T}` 由 personaLine 出口统一填成代词。
 */
export function anchorSection(model, opts = {}) {
  const items = recentAnchors(model, { now: opts.now, days: opts.days, limit: opts.limit })
  const lines = [
    '## 关于把话说到具体处',
    '{T}私下跟你说话的时候：能挂到具体一句上就挂——{T}刚说的那句、你以前说过的、你看过的那条。',
    '挂不上就直说「这个我接不上」，别用「确实」「有道理」这类放哪都成立的话收尾。',
    '这只是优先，不是每次都得引。',
    '',
  ]
  if (items.length === 0) {
    lines.push('（最近没有能引的东西。想不出就直说，别编一句来引。）')
  } else {
    lines.push('最近几天能引的有：')
    for (const it of items) {
      if (it.kind === 'heard') lines.push(`- {T} ${it.date}说过：「${it.text}」`)
      else if (it.kind === 'belief') lines.push(`- 你 ${it.date}说过：「${it.text}」`)
      else if (it.kind === 'material') lines.push(`- 你看过《${it.title}》里的一句：「${it.text}」（${it.date}）`)
      else lines.push(`- 你看过：《${it.text}》（${it.date}）`)
    }
    lines.push('')
    lines.push('这些是最近几天的，能用就用，用不上别硬套。')
  }
  return lines.join('\n')
}

