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
 */
export function pickDisputes(comments = [], { max = 2 } = {}) {
  const out = []
  const seen = new Set()
  for (const c of comments) {
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
  for (const c of pack.disputes ?? []) {
    const text = String(c?.text ?? '').trim()
    if (text) quotes.push({ by: '评论', kind: 'dissent', grade: GRADE.OPINION, text, like: Number(c?.like) || 0 })
  }
  for (const d of pack.danmaku ?? []) {
    const text = String(d?.text ?? '').trim()
    if (text) quotes.push({ by: '弹幕', kind: 'danmaku', grade: GRADE.OPINION, text })
  }

  return {
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
}

/** 一条素材里、某一级的所有原话（供将来按级别挑引文用，不在渲染里直接暴露级别） */
export function quotesOf(material, grade) {
  const list = material?.quotes ?? []
  return grade === undefined ? list : list.filter((q) => q.grade === grade)
}