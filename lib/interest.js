/**
 * interest.js —— 「她最近总回到哪几件事上」（2026-11-05，用户 m02031）
 *
 * 设计里说兴趣有三个来源：没答上的缺口（curiosity.js 已经在做）、反复出现的主题、
 * 反复讲同一件事之后的腻感。这个文件做后两个——不存标签、不建向量、不落盘，
 * 每次从事件流现算。
 *
 * 三条边界：
 *   1. **只读她说过的话**（`HER_TYPES`），不去猜主人喜欢什么——兴趣是她的，不是画像。
 *   2. **正文里没有分数、没有次数**。权重只决定摆哪一条（四条黑名单第三条）。
 *   3. **会腻**：同一件事刚在 24 小时内出现过，这一次的分量打对折；
 *      两周前的老话题按 14 天半衰——越久没提，越不像「最近总回到」。
 */

import { similarity } from './derive.js'
import { tsMs, HER_TYPES } from './schema.js'

/** 至少在几个不同时刻出现过，才算「反复」。 */
export const INTEREST_MIN_HITS = 2
/** 相似到这个程度算同一件事（与 curiosity/desk 的聚并口径一致，略松一点）。 */
export const INTEREST_SIMILARITY = 0.5
/** 半衰期（天）。 */
export const INTEREST_HALF_DAYS = 14
/** 同一件事刚提过，这一次打这个折。 */
export const INTEREST_FATIGUE = 0.5
/** 正文最多摆几条。 */
export const INTEREST_SHOW_MAX = 1
/** 一行最多多少字。 */
export const INTEREST_TEXT_MAX = 60

const DAY = 86_400_000

/** 切句：按句末标点切，保留句子本体。 */
function sentences(text) {
  return String(text ?? '')
    .split(/(?<=[。！？!?；;\n])/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 太短的是碎片（「嗯」「好」），太长的是整段，都不算一个「主题」。 */
function topicOk(line) {
  const n = line.length
  return n >= 8 && n <= INTEREST_TEXT_MAX
}

/**
 * 她说过、像「一件事」的句子。
 * @returns {{text:string, ts:number}[]} 按时间升序
 */
export function topicsOf(events = []) {
  const out = []
  for (const e of events) {
    if (!HER_TYPES.includes(e?.type)) continue
    const ts = tsMs(e)
    if (!Number.isFinite(ts)) continue
    for (const s of sentences(e.text)) {
      if (!topicOk(s)) continue
      out.push({ text: s.replace(/[。！？!?；;]+$/, '').trim(), ts })
    }
  }
  out.sort((a, b) => a.ts - b.ts)
  return out
}

/**
 * 反复出现的主题，按分量排序。
 *
 * @param {object[]} events
 * @param {number} [now]
 * @param {{minHits?:number}} [opts]
 * @returns {{text:string, hits:number, lastAt:number, weight:number}[]}
 */
export function interestOf(events = [], now = Date.now(), { minHits = INTEREST_MIN_HITS } = {}) {
  const items = topicsOf(events)
  const clusters = []
  for (const item of items) {
    let hit = null
    for (const c of clusters) if (similarity(c.text, item.text) >= INTEREST_SIMILARITY) { hit = c; break }
    if (hit) {
      hit.hits += 1
      // 用最近一次的原话当代表，但先比较再改时间——反了就永远都是最后一条。
      if (item.ts >= hit.lastAt) {
        hit.text = item.text
        hit.lastAt = item.ts
      }
    } else {
      clusters.push({ text: item.text, hits: 1, lastAt: item.ts, firstAt: item.ts })
    }
  }
  const out = []
  for (const c of clusters) {
    if (c.hits < minHits) continue
    const ageDays = Math.max(0, (now - c.lastAt) / DAY)
    const fresh = Math.pow(2, -ageDays / INTEREST_HALF_DAYS)
    // 腻：最近 24 小时内刚提过，分量打对折。
    const fatigue = now - c.lastAt <= DAY ? INTEREST_FATIGUE : 1
    const weight = c.hits * fresh * fatigue
    out.push({ text: c.text, hits: c.hits, lastAt: c.lastAt, weight })
  }
  out.sort((a, b) => b.weight - a.weight || b.lastAt - a.lastAt)
  return out.slice(0, INTEREST_SHOW_MAX)
}

/**
 * 摆到桌上的那一行。没有就返回空串（调用方直接不 push）。
 */
export function renderInterest(items = []) {
  const first = Array.isArray(items) ? items[0] : null
  if (!first?.text) return ''
  const text = first.text.length > INTEREST_TEXT_MAX ? `${first.text.slice(0, INTEREST_TEXT_MAX - 1)}…` : first.text
  return `最近你总回到「${text}」这件事上。`
}

/** 把兴趣当劲儿的一笔冲动：有就返回 true。 */
export function hasInterest(events = [], now = Date.now()) {
  return interestOf(events, now).length > 0
}
