/**
 * 素材契约（1.0，2026-11-12 用户 m03699）
 *
 * ## 这是什么
 *
 * 一个**可选**的返回形状：外面的插件（知乎、贴吧、新闻、小说……）如果愿意按它返回，
 * 她拿到的就不是「一段文本」，而是一条**素材**——有出处、有原话、有分级，
 * 于是「她说的话能不能挂到具体一句上」这件事，才轮得到这些来源。
 *
 * ## 为什么是「认领制」
 *
 * 不改现有通路：不按形状返回的工具，一切照旧（她照样调得动、照样是普通文本）。
 * 只有按形状返回、并且被本插件接住的那一条，才升级成素材。
 * 所以已接入的插件不需要重接，也不会因为这份契约改变行为。
 *
 * ## 三条由插件这边定的规则
 *
 *   1. **分级由我们定**：第三方只能声明 `kind`（事实 / 观点 / 虚构），
 *      不能自己声明「我这是几级证据」。它声明 fact，也只能让 quote 拿到 1 级；
 *      没有可核对的锚（`url` 或同条素材里的事实项）就降回 2 级。
 *   2. **可核对由我们核**：`canVerify` 不看第三方怎么说，只看有没有事实项。
 *   3. **渲染与防护由我们走**：文本一字不改，但要过 `debrief()` 那层牌子，
 *      并且只标「谁写的」，不给她看等级数字。
 *
 * ## 形状
 *
 * ```json
 * {
 *   "dshFishMaterial": 1,
 *   "source": "zhihu",
 *   "key": "https://example.com/a/1",
 *   "at": "2026-11-12",
 *   "title": "为什么……",
 *   "kind": "opinion",
 *   "facts": [{ "label": "作者", "value": "某人", "url": "…" }],
 *   "quotes": [{ "text": "原话，一个字都不用改", "kind": "answer", "by": "答主：某人" }]
 * }
 * ```
 *
 * 约束（超出即拒或截断，不静默丢一半）：
 *   - `source` 1–40 字，`key` 1–200 字；
 *   - `facts` ≤ 20 条、`quotes` ≤ 40 条，每条正文 ≤ 500 字；
 *   - 总正文 ≤ 20000 字；
 *   - 重复原话去重；空素材（既无事实也无原话）直接拒。
 *
 * 全文见 `docs/素材契约.md`。
 */

/** 契约版本。第三方按这个数字声明自己按哪一版返回。 */
export const CONTRACT_VERSION = 1

/** 形状标记：有它就能被认出来，没有也可以按字段判断。 */
export const CONTRACT_MARK = 'dshFishMaterial'

/** 第三方只能声明这三类。 */
export const SOURCE_KINDS = Object.freeze(['fact', 'opinion', 'fiction'])

/** 类别 → 它最多能拿到的级别（数字越小越硬）。 */
export const KIND_GRADE = Object.freeze({ fact: 1, opinion: 2, fiction: 3 })

/** 硬上限。 */
export const LIMITS = Object.freeze({
  body: 20000,
  facts: 20,
  quotes: 40,
  text: 500,
  title: 200,
  source: 40,
  key: 200,
  by: 40,
  kind: 20,
})

const GRADES = new Set([1, 2, 3])

/** 只去首尾空白、不乱动中间的字——原文一个字都不改。 */
function clean(v, max) {
  return String(v ?? '').trim().slice(0, max)
}

/** 标题这类展示用字段可以压空白。 */
function flat(v, max) {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function kindOf(raw, fallback) {
  if (SOURCE_KINDS.includes(raw?.kind)) return raw.kind
  if (SOURCE_KINDS.includes(fallback)) return fallback
  return 'opinion'
}

/**
 * 把第三方返回的对象校验、规范化成一条素材。
 *
 * 不抛错：校验不过就返回 `{ ok: false, problems }`，调用方照旧按普通文本处理。
 * 能修的就修（截断、去重、降级），修不了才拒——拒的时候也把原因带上。
 *
 * @param {object} raw 第三方返回的对象
 * @param {{ source?: string, kind?: string, now?: number }} [o]
 * @returns {{ ok: boolean, material: object|null, problems: string[] }}
 */
export function coerceMaterial(raw, o = {}) {
  const problems = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, material: null, problems: ['not-an-object'] }
  }

  const source = clean(o.source ?? raw.source, LIMITS.source)
  if (!source) problems.push('missing-source')
  const key = clean(raw.key, LIMITS.key)
  if (!key) problems.push('missing-key')
  // 来路和身份缺一样就不收。没有来路的素材，她引用时就分不清是谁说的；
  // 没有 key 的素材，去重、回看和「同一件事」都挂不上——宁可退回普通文本。
  if (!source || !key) return { ok: false, material: null, problems }

  const declared = clean(raw.kind, LIMITS.kind)
  if (declared && !SOURCE_KINDS.includes(declared)) problems.push('bad-kind')
  const kind = kindOf(raw, o.kind)
  const ceiling = KIND_GRADE[kind]

  const facts = []
  const factList = Array.isArray(raw.facts) ? raw.facts : []
  if (factList.length > LIMITS.facts) problems.push('too-many-facts')
  for (const f of factList) {
    if (facts.length >= LIMITS.facts) break
    if (!f || typeof f !== 'object') continue
    const value = clean(f.value, LIMITS.text)
    if (!value) continue
    const label = flat(f.label, LIMITS.by)
    const url = clean(f.url, 500)
    facts.push({ label, value, grade: 1, ...(url ? { url } : {}) })
  }

  const quotes = []
  const seen = new Set()
  const quoteList = Array.isArray(raw.quotes) ? raw.quotes : []
  if (quoteList.length > LIMITS.quotes) problems.push('too-many-quotes')
  for (const q of quoteList) {
    if (quotes.length >= LIMITS.quotes) break
    if (!q || typeof q !== 'object') continue
    const text = clean(q.text, LIMITS.text)
    if (!text || seen.has(text)) continue
    seen.add(text)
    // 声明的级别不能比「它说自己是哪一类」更硬：观点不能自称证据。
    let grade = Number.isInteger(q.grade) ? q.grade : ceiling
    if (!GRADES.has(grade)) grade = ceiling
    if (grade < ceiling) {
      grade = ceiling
      problems.push('grade-clamped')
    }
    const url = clean(q.url, 500)
    // 1 级必须有锚：自己的 url，或同条素材里的事实项；否则降回观点。
    if (grade === 1 && !url && facts.length === 0) {
      grade = 2
      problems.push('fact-without-anchor')
    }
    const by = flat(q.by, LIMITS.by) || source
    const qkind = flat(q.kind, LIMITS.kind) || 'body'
    const like = Number(q.like)
    quotes.push({
      by,
      kind: qkind,
      grade,
      text,
      ...(url ? { url } : {}),
      ...(Number.isFinite(like) && like > 0 ? { like } : {}),
    })
  }

  if (!facts.length && !quotes.length) {
    problems.push('empty')
    return { ok: false, material: null, problems }
  }

  const total = quotes.reduce((n, q) => n + q.text.length, 0) + facts.reduce((n, f) => n + f.value.length, 0)
  if (total > LIMITS.body) {
    problems.push('too-long')
    return { ok: false, material: null, problems }
  }

  return {
    ok: true,
    problems,
    material: {
      source,
      key,
      at: raw.at ?? o.at ?? null,
      title: flat(raw.title, LIMITS.title),
      kind,
      tags: Array.isArray(raw.tags) ? raw.tags.map((t) => flat(t, 40)).filter(Boolean).slice(0, 12) : [],
      facts,
      quotes,
      // 不看它怎么说，只看有没有事实项。
      canVerify: raw.canVerify === false ? false : facts.length > 0,
      blocked: raw.blocked ?? undefined,
    },
  }
}

/**
 * 工具的返回值（字符串）→ 素材。认不出来就返回 null（调用方按普通文本走）。
 *
 * 只认「整段就是一个 JSON 对象」这一种：不猜、不从散文里抠 JSON，
 * 免得把一段真的在聊天的文本误判成素材。
 */
export function materialFromToolText(text, o = {}) {
  const s = String(text ?? '').trim()
  if (!s || (s[0] !== '{' && s[0] !== '[')) return null
  let raw = null
  try {
    raw = JSON.parse(s)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!(Array.isArray(raw.quotes) || Array.isArray(raw.facts) || raw[CONTRACT_MARK])) return null
  const r = coerceMaterial(raw, o)
  return r.ok ? r.material : null
}

/**
 * 任意一段文本 → 素材（观点级）。
 *
 * 给「没按契约返回、但内容值得留下」的来源用：它不算证据，但至少能被引用、
 * 能进统计、能在以后被翻出来。正文放 `body`，不硬塞成原话（截断会丢字）。
 */
export function fromPlainText({ source = '', kind = 'opinion', text = '', at = null, key = '' } = {}) {
  const body = String(text ?? '').trim()
  if (!body || !source) return null
  const grade = KIND_GRADE[kind] ?? KIND_GRADE.opinion
  return {
    source: clean(source, LIMITS.source),
    key: clean(key, LIMITS.key) || `${clean(source, LIMITS.source)}:${body.slice(0, 40)}`,
    at,
    title: '',
    kind,
    tags: [],
    facts: [],
    quotes: [],
    body: body.slice(0, LIMITS.body),
    canVerify: false,
    blocked: undefined,
  }
}

/**
 * 一条素材渲染成她能看的几行（给将来的非 B 站来源用；B 站那条仍走 `renderMaterial`）。
 *
 * 只标「谁写的」，不出现「几级」「可信度」这类字——等级是给渲染流程看的，
 * 不是给她看的标签。
 */
export function renderMaterialText(material) {
  if (!material) return ''
  const lines = []
  const title = material.title ? `《${material.title}》` : ''
  const when = material.at ? ` · ${String(material.at).slice(0, 10)}` : ''
  lines.push(`${title}${title ? ' · ' : ''}来源：${material.source}${when}`)
  for (const f of material.facts ?? []) {
    lines.push(`  ${f.label ? `${f.label}：` : ''}${f.value}`)
  }
  if (material.body) lines.push(material.body)
  for (const q of material.quotes ?? []) {
    lines.push(`  ${q.by}：「${q.text}」`)
  }
  return lines.join('\n')
}
