/**
 * 来源登记（1.0，2026-11-12）
 *
 * 契约定了「一条素材长什么样」，这里定「有哪些来源、各自是哪一类」。
 *
 * 为什么要有这一层：来源分级不能由来源自己说。B 站是 `fact`（它有可核对的事实项：
 * 时长、UP 主、播放量）；知乎回答、贴吧帖子是 `opinion`（只有观点）；小说是
 * `fiction`（只能当素材）。这一层就是那张表。
 *
 * 现在的状态：
 *   - `bili` 是内置来源，走自己的 `toMaterial()`（数据是 `absorb()` 抓的）；
 *   - 外面的插件可以在设置里登记一个来源（名字 + 它自己的工具名 + 类别），
 *     但**接进来还需要一个收口工具**（还没做，见 `docs/素材契约.md` 末尾）。
 *     在那之前，登记只是登记，不会自动把第三方内容变成素材。
 */

import { KIND_GRADE, SOURCE_KINDS, coerceMaterial, fromPlainText, materialFromToolText } from './contract.js'

/** 内置来源。`tool` 为空表示不走外部工具、由本插件自己抓。 */
export const BUILTIN_SOURCES = Object.freeze([{ name: 'bili', kind: 'fact', tool: '' }])

function clean(v, max) {
  return String(v ?? '').trim().slice(0, max)
}

/**
 * 设置里登记的来源 → 干净的清单。
 *
 * 不合规的条目直接跳过（不抛错）：一份设置不该因为写错一个名字就整个失效。
 * 重名取先出现的那个——先登记的那份是用户明确的意图。
 *
 * @param {Array|undefined} list
 * @returns {{ name: string, kind: string, tool: string }[]}
 */
export function normalizeSources(list) {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || typeof raw !== 'object') continue
    const name = clean(raw.name, 40)
    if (!name || seen.has(name.toLowerCase())) continue
    const kind = SOURCE_KINDS.includes(raw.kind) ? raw.kind : 'opinion'
    const tool = clean(raw.tool, 80)
    seen.add(name.toLowerCase())
    out.push({ name, kind, tool })
  }
  return out
}

/** 按名字找来源（不分大小写）。找不到返回 null。 */
export function findSource(sources, name) {
  const want = String(name ?? '').trim().toLowerCase()
  if (!want) return null
  return (sources ?? []).find((s) => String(s?.name ?? '').toLowerCase() === want) ?? null
}

/** 内置 + 设置里登记的（内置的同名优先，不让设置覆盖 B 站的分级）。 */
export function allSources(config) {
  const extra = normalizeSources(config?.tools?.sources)
  const names = new Set(BUILTIN_SOURCES.map((s) => s.name.toLowerCase()))
  return [...BUILTIN_SOURCES, ...extra.filter((s) => !names.has(s.name.toLowerCase()))]
}

/**
 * 一次来源读取的结果 → 一条素材。
 *
 * 三种情况：
 *   ① 对象且合规 → 按契约转成素材；
 *   ② 字符串且是契约 JSON → 同上；
 *   ③ 其他字符串 → 包成观点级素材（进得了系统，但不算证据）。
 *
 * 返回 null 表示这条读取没有可用内容。
 *
 * @param {unknown} raw 来源返回的原始结果
 * @param {{ name?: string, kind?: string, now?: number }} [o]
 */
export function sourceMaterial(raw, o = {}) {
  const name = clean(o.name, 40) || 'unknown'
  const kind = SOURCE_KINDS.includes(o.kind) ? o.kind : 'opinion'
  const at = o.now ?? Date.now()

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = coerceMaterial(raw, { source: name, kind, now: at })
    return r.ok ? r.material : null
  }
  if (typeof raw === 'string') {
    const parsed = materialFromToolText(raw, { source: name, kind, now: at })
    if (parsed) return parsed
    const text = raw.trim()
    if (!text) return null
    return fromPlainText({ source: name, kind, text, at, key: `${name}:${text.slice(0, 40)}` })
  }
  return null
}

/** 这套来源里，某一类最多能拿到几级（给渲染/统计用，不给她看）。 */
export function gradeCeilingOf(kind) {
  return KIND_GRADE[kind] ?? KIND_GRADE.opinion
}
