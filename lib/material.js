/**
 * 素材的统一形状（0.9.8 / M3）
 *
 * 为什么要它：她看到的东西一直是「一条 B 站 pack」——标题、简介、热评、弹幕
 * 混在一起，没有哪一句是「原话」、也没有哪句是「事实」。于是她能说的只有
 * 总结，因为材料本身没给她可以引用的句子，也没告诉她哪些能核对。
 *
 * 这里定三件事，之后所有来源（B 站、以后的小说/帖子/文件）都按同一个形状交出来：
 *   - 一条素材 = 一件事（source + key + at）；
 *   - 原话单独列（quotes[]，每句带出处与分级，不改写）；
 *   - 能不能当证据，由 grade 说清楚，不由她的语气决定。
 *
 * 分级（来源分级，不是给她看的标签）：
 *   1 = 可核对的事实（时长、UP 主、播放量、发布时间）
 *   2 = 别人说的话（简介、评论、弹幕）——只能当观点，不能当证据
 *   3 = 虚构（小说、梦、编出来的故事）——只能当素材
 *
 * 注意：grade 只用于渲染与后续判断，**不进身份文档、不打分、不出现「几级」字样**。
 */

import { coerceMaterial } from './contract.js'

/** 素材分级。冻结，防止运行期被改。 */
export const GRADE = Object.freeze({
  FACT: 1,
  OPINION: 2,
  FICTION: 3,
})

/**
 * 「不同意见」的判据。
 *
 * 只用明确的反对词，不用「但是 / 其实 / 然而」这类转折词——那三个词在正常
 * 评论里太常见，选出来的会是「随便一句带转折的话」，不是反例。
 */
const DISSENT_RE = /不同意|不认同|不敢苟同|说错|错了|反对|胡说|瞎说|未必|夸大|标题党|翻车|纠正一下|反驳|争议|其实不是|并不|太扯|不靠谱|误导/

/** 这句评论/弹幕是不是在反对 */
export function isDissent(text) {
  return DISSENT_RE.test(String(text ?? ''))
}

/**
 * 从一堆评论里挑「不同意见」。
 *
 * 为什么不多：一次素材里出现两三条反例就够她对照了；给太多，素材会变成
 * 评论区吵架现场，她的注意力会被拽到争论上，而不是那件事本身。
 * 按点赞降序挑，最多 max 条。
 *
 * 2026-11-13（issue #135）：传进来的列表来自 `sort=2`，是 B 站**热度序**，
 * 赞数并不单调（实测 30/55/44/348…）。这句「按点赞降序」从 0.9.8 起就写在
 * 注释里，代码却是照顺序取——现在真排一次，挑出来的才是「最多人赞同的那条反例」。
 */
export function pickDisputes(comments = [], { max = 2 } = {}) {
  const out = []
  const seen = new Set()
  const ranked = [...comments].sort((a, b) => (Number(b?.like) || 0) - (Number(a?.like) || 0))
  for (const c of ranked) {
    const text = String(c?.text ?? '').trim()
    if (!text || seen.has(text)) continue
    if (!isDissent(text)) continue
    seen.add(text)
    out.push({ text, like: Number(c?.like) || 0 })
    if (out.length >= max) break
  }
  return out
}

function fmtDuration(sec) {
  const n = Number(sec) || 0
  if (!n) return ''
  return `${Math.floor(n / 60)}分${String(n % 60).padStart(2, '0')}秒`
}

/**
 * 一条来源 pack → 统一形状。
 *
 * pack 是现有的 B 站素材对象（video / desc / pubdate / tags / comments / danmaku），
 * 这里只做规范化，不去抓数据、不改写任何一句话。
 *
 * @param {object} pack
 * @param {{ source?: string }} [o]
 */
export function toMaterial(pack = {}, o = {}) {
  const v = pack.video ?? {}
  const facts = []
  const dur = fmtDuration(v.duration)
  if (dur) facts.push({ label: '时长', value: dur, grade: GRADE.FACT })
  if (v.up) facts.push({ label: 'UP 主', value: String(v.up), grade: GRADE.FACT })
  if (v.view) facts.push({ label: '播放', value: String(v.view), grade: GRADE.FACT })
  if (v.like) facts.push({ label: '点赞', value: String(v.like), grade: GRADE.FACT })
  if (pack.pubdate) facts.push({ label: '发布', value: String(pack.pubdate).slice(0, 10), grade: GRADE.FACT })

  const quotes = []
  if (pack.desc) {
    quotes.push({ by: 'UP 主', kind: 'desc', grade: GRADE.OPINION, text: String(pack.desc) })
  }
  for (const c of pack.comments ?? []) {
    const text = String(c?.text ?? '').trim()
    if (text) quotes.push({ by: '评论', kind: 'comment', grade: GRADE.OPINION, text, like: Number(c?.like) || 0 })
  }
  // 置顶评论（2026-11-13，issue #135）：B 站单独放在 data.top 里，跟着一条标出来，
  // 否则她读到的评论区和网页上看到的那组不是同一组。
  for (const c of pack.pinned ?? []) {
    const text = String(c?.text ?? '').trim()
    if (text) quotes.push({ by: '评论', kind: 'pinned', grade: GRADE.OPINION, text, like: Number(c?.like) || 0 })
  }
  for (const c of pack.disputes ?? []) {
    const text = String(c?.text ?? '').trim()
    if (text) quotes.push({ by: '评论', kind: 'dissent', grade: GRADE.OPINION, text, like: Number(c?.like) || 0 })
  }
  for (const d of pack.danmaku ?? []) {
    const text = String(d?.text ?? '').trim()
    if (text) quotes.push({ by: '弹幕', kind: 'danmaku', grade: GRADE.OPINION, text })
  }

  const raw = {
    source: String(o.source ?? 'bili'),
    key: String(v.bvid ?? ''),
    at: pack.pubdate ?? null,
    title: String(v.title ?? ''),
    tags: [...(pack.tags ?? [])],
    facts,
    quotes,
    // 只有「有可核对的事实」才算能当证据。纯观点素材（以后的帖子截图）就是 false。
    canVerify: facts.length > 0,
    blocked: pack.blocked ?? undefined,
  }

  // 走一遍同一份校验：B 站不是特例，和外面的来源受同样的约束。
  // 校验不过（极少见，通常是没 bvid）就按原样交出去——不让一条素材
  // 因为校验器变严而凭空消失。
  const checked = coerceMaterial(raw, { source: raw.source, kind: 'fact' })
  return checked.ok ? checked.material : raw
}

/** 一条素材里、某一级的所有原话（供将来按级别挑引文用，不在渲染里直接暴露级别） */
export function quotesOf(material, grade) {
  const list = material?.quotes ?? []
  return grade === undefined ? list : list.filter((q) => q.grade === grade)
}

// ---------------------------------------------------------------------------
// 素材索引（1.0.0，用户 m05089）：她看过的那几句原话，落一行 meta。
//
// 为什么只存原话、不存简介全文：正文会让事件流变成另一个素材库，而且噪声
// 大（简介里常是导航、推广）。存「谁说的、哪一句」就够她以后说
// 「这个说法我以前在哪看到过」，也够体检核对「她引的那句是不是真存在」。
// ---------------------------------------------------------------------------

export const MAT_PREFIX = 'mat:bili:'
export const MAT_QUOTE_MAX = 120
export const MAT_QUOTES = 3

/**
 * 一条素材 → 一行 `mat:bili:<bvid> {t,d,q}`。
 * 没有 bvid、没有原话，就不写（不硬凑）。
 */
export function materialIndexLine(pack, { date = '' } = {}) {
  const m = toMaterial(pack)
  if (!m) return null
  const bvid = String(pack?.video?.bvid ?? '').trim()
  if (!bvid) return null
  const q = []
  for (const quote of m.quotes ?? []) {
    const text = String(quote?.text ?? '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    const one = { b: String(quote.by ?? ''), x: text.slice(0, MAT_QUOTE_MAX) }
    if (Number(quote.like) > 0) one.l = Number(quote.like)
    q.push(one)
    if (q.length >= MAT_QUOTES) break
  }
  if (!q.length) return null
  const payload = { t: String(m.title ?? '').slice(0, 120), d: String(date ?? ''), q }
  return `${MAT_PREFIX}${bvid} ${JSON.stringify(payload)}`
}

/** 已经建过索引的 bvid（同一视频不重复记）。 */
export function indexedMaterialKeys(events = []) {
  const out = new Set()
  for (const e of events ?? []) {
    if (e?.type !== 'meta') continue
    const text = String(e.text ?? '')
    if (!text.startsWith(MAT_PREFIX)) continue
    const key = text.slice(MAT_PREFIX.length).split(/\s+/, 1)[0]
    if (key) out.add(key)
  }
  return out
}