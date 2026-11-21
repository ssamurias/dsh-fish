/**
 * speechanchor.js —— 说话设置「纠正鱼八股」要用的那一小段（1.0，用户 m04784）
 *
 * 只做一件事：把最近几天里**能被引用的东西**按时间挑出来，写成一小段附在
 * 身份文档末尾。**不按语义匹配**——挂错的代价是引一句她没说过的话，比不说
 * 更糟（2026-11-13 用户 m04784：按时间取，不按语义）。
 *
 * 1.0.7（issue #165）：原来四类素材同池、按时间取前 3 条。真机跑下来 heard
 * （{T}私下说过的原话）几乎每次都占满，belief（她自己认领过的判断）长期被挤掉——
 * 这段提示本来是为了让她说话有据可依，结果她自己的判断一次都显不出来。现在拆成
 * 两档：「最近能引的」（heard / looked / material，最多 2 条）与「你自己认领过的」
 * （belief，最多 2 条），各自按时间取。
 *
 * 同一版还修了一条更硬的：belief 原来用 `since`（这条判断第一次被说出口的时间）
 * 卡 7 天窗口，站住超过七天的判断永远进不来。现在按「最近一次被提起 / 被检验」
 * 的时间算，窗口对齐 derive.js 的 SOLID_STALE_DAYS（90 天）——没被提起满 90 天的
 * 判断本来就已经不成其为固化了。
 *
 * 这段**不占「身份段字数」预算**：它由 personaLine 在 assemble 之后追加，
 * 预算算的是她自己长出来的那部分，这里是从事件流里临时取的素材。
 *
 * 没有素材时不编：段里直说「最近没有能引的东西」。
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** 读到的那些（{T}说过的原话、看过的视频）：仍然只认最近几天。 */
export const ANCHOR_DAYS = 7
/**
 * 她自己认领过的判断：判断不是几天的东西。窗口对齐 derive.js 的 SOLID_STALE_DAYS，
 * 超过这个天数没被提起 / 没被检验的判断，deriveSelf 自己也会让它失去固化。
 */
export const ANCHOR_BELIEF_DAYS = 90
export const ANCHOR_MAX = 3
/** 「最近能引的」这一档最多几条（issue #165）。 */
export const ANCHOR_READ_MAX = 2
/** 「你自己认领过的」这一档最多几条（issue #165）。 */
export const ANCHOR_BELIEF_MAX = 2
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
 * 一条判断「最近还在」的时刻：优先取被提起 / 被检验的时间（deriveSelf 算好的
 * lastTouchedAt），没有就退回它第一次被说出口的时间。
 */
function beliefAt(b) {
  const touched = Number(b?.lastTouchedAt) || Number(b?.lastVerifiedAt) || Number(b?.lastMentionAt) || 0
  if (touched) return touched
  return typeof b?.since === 'number' ? b.since : Date.parse(String(b?.since ?? ''))
}

/**
 * 最近能引的素材，按时间从新到旧。
 *
 * 只认四种来路：heard / belief / looked / material。排序**按时间，不按可信度**。
 *
 * `kinds` 是可选的：传了就只留这几类（`['belief']`、`['heard','looked','material']`）。
 * 不传时行为与 1.0.7 一致——四类同池、按时间取前 `limit` 条，所以老调用方不用改。
 *
 * 字幕只留了 `subs:` 索引（没有正文），要引原句得她自己去查，
 * 所以这里不摆——摆了也没有内容可引。
 */
export function recentAnchors(
  model,
  { now = Date.now(), days = ANCHOR_DAYS, limit = ANCHOR_MAX, kinds, beliefDays = ANCHOR_BELIEF_DAYS } = {},
) {
  const from = now - days * DAY_MS
  const beliefFrom = now - beliefDays * DAY_MS
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
    const at = beliefAt(b)
    if (!text || !Number.isFinite(at) || at < beliefFrom || at > now) continue
    out.push({ kind: 'belief', at, date: dateOf(at), text })
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

  const pool = Array.isArray(kinds) && kinds.length ? out.filter((x) => kinds.includes(x.kind)) : out

  // 同一句话只留一条；按时间从新到旧，取前 limit 条。
  const seen = new Set()
  return pool
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
  const now = opts.now
  const days = opts.days
  // 两档各自取（issue #165）：heard 再勤也挤不掉她自己的判断。
  const reads = recentAnchors(model, { now, days, limit: ANCHOR_READ_MAX, kinds: ['heard', 'looked', 'material'] })
  const beliefs = recentAnchors(model, { now, days, limit: ANCHOR_BELIEF_MAX, kinds: ['belief'] })
  const lines = [
    '## 关于把话说到具体处',
    '{T}私下跟你说话的时候：能挂到具体一句上就挂——{T}刚说的那句、你以前说过的、你看过的那条。',
    '挂不上就直说「这个我接不上」，别用「确实」「有道理」这类放哪都成立的话收尾。',
    '这只是优先，不是每次都得引。',
    '',
  ]
  if (reads.length === 0 && beliefs.length === 0) {
    lines.push('（最近没有能引的东西。想不出就直说，别编一句来引。）')
    return lines.join('\n')
  }
  if (reads.length) {
    lines.push('最近能引到的：')
    for (const it of reads) {
      if (it.kind === 'heard') lines.push(`- {T} ${it.date}说过：「${it.text}」`)
      else if (it.kind === 'material') lines.push(`- 你看过《${it.title}》里的一句：「${it.text}」（${it.date}）`)
      else lines.push(`- 你看过：《${it.text}》（${it.date}）`)
    }
    lines.push('')
  }
  if (beliefs.length) {
    lines.push('你自己认领过的：')
    for (const it of beliefs) lines.push(`- ${it.date}：「${it.text}」`)
    lines.push('')
  }
  lines.push('这些都能用就用，用不上别硬套。')
  return lines.join('\n')
}
