/**
 * hook.js —— 素材旁边的那一行钩子（0.9.6，S2）。
 *
 * 目的：让「她自己说过的话」在**具体的一条素材**旁边重新出现，而不是每轮把身份文档念一遍。
 * 2026-10-23 删掉 focus 段的原因是「每轮念一遍你是什么样的人 = 锁死」；钩子走的是另一条路：
 * 那句话只在**对得上的那一条材料**出现时才回来，而且必须是可核对的原话。
 *
 * 三段判据（设计 §8.2）：
 *   一级：实体对得上（UP 主名 / 标题原文 / 三个字以上的标签 / 他刚说过的那句）→ 可引她的原话
 *   二级：词面重合（标题的二元组有一半以上出现在她说过的话里）→ 只说「有点像」，**永不引原话**
 *   三级：对不上 → 一个字都不加
 *
 * 为什么二级不引原话：挂错时唯一的伤害是「引用了她没说过的话」；二级不引，就只剩一行提示。
 * 这是它敢用低精度的前提，也是钩子可以挂在「可能不相干」的素材上的安全边界。
 *
 * 时间跨度：只挂 7 天以前说过的话。昨天刚说、今天又摆回眼前，那不是回声，是复读。
 */

import { clipText } from './clip.js'
import { DAY_MS } from './derive.js'

/** 只挂 7 天以前的话（设计 §8.2 的阈值）。 */
export const HOOK_MIN_AGE_DAYS = 7
/** 二级阈值。2026-11-09 用户把这件事交给我定：0.5 起步，按 meta 里的命中率调。 */
export const LEVEL2_MIN = 0.5
/** 引原话时最多引多少字（长了就不是回落，是背书）。 */
const QUOTE_MAX = 60
/** 标题整串比对至少这么长，否则「标题」等于一个词。 */
const TITLE_MIN = 6
/** 标签至少三个字才当实体：两个字的标签（游戏/日常）几乎每条都中。 */
const TAG_MIN = 3

const pad2 = (n) => String(n).padStart(2, '0')

/** `10 月 30 日`（她的时间感是日历，不是毫秒）。 */
export function hookDate(ts) {
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return ''
  const d = new Date(n)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

function grams(text) {
  const t = String(text ?? '').replace(/\s+/g, '')
  const m = new Map()
  for (let i = 0; i < t.length - 1; i += 1) {
    const g = t.slice(i, i + 2)
    m.set(g, (m.get(g) ?? 0) + 1)
  }
  return { n: Math.max(0, t.length - 1), m }
}

/**
 * 词面重合度：短的一方有多少二元组出现在长的一方里。
 *
 * 不用 derive.similarity（Dice）做二级判据：标题十几字、她的话几十上百字，
 * Dice 的分母是两边长度之和，**再像也上不了 0.5**（数学上做不到）。
 * 这里换成「短边的覆盖率」，阈值 0.5 的含义才真的是「标题有一半的词在她那句话里」。
 */
export function overlap(a, b) {
  const A = grams(a)
  const B = grams(b)
  if (!A.n || !B.n) return 0
  let inter = 0
  for (const [g, c] of A.m) {
    const d = B.m.get(g)
    if (d) inter += Math.min(c, d)
  }
  return Math.min(1, inter / Math.min(A.n, B.n))
}

function clip(text, max = QUOTE_MAX) {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ')
  return clipText(t, max)
}

function packText(p) {
  const v = p?.video ?? {}
  return [v.title, p?.desc, ...(Array.isArray(p?.comments) ? p.comments.map((c) => c.text) : [])]
    .filter(Boolean)
    .join('\n')
}

/** 她说过的、可以回引的那些（判断 + 疤）。 */
function pastWords(model) {
  const out = []
  for (const b of Array.isArray(model?.beliefs) ? model.beliefs : []) {
    const text = String(b?.text ?? '').trim()
    if (!text) continue
    out.push({ text, ts: Date.parse(b?.since ?? '') || 0 })
  }
  for (const s of Array.isArray(model?.scars) ? model.scars : []) {
    const text = String(s?.text ?? '').trim()
    if (!text) continue
    out.push({ text, ts: Date.parse(s?.since ?? s?.at ?? '') || 0 })
  }
  return out
}

/**
 * 给每条素材挑一个钩子。
 *
 * @param {object} model deriveSelf 出来的模型（只用 beliefs / scars）
 * @param {object[]} packs absorb 出来的素材
 * @param {number} [now]
 * @param {{hisLine?: {text: string}, level2?: number}} [o]
 * @returns {Map<string, {level: 1|2, text: string, why: string}>} bvid → 钩子
 */
export function buildHooks(model, packs, now = Date.now(), o = {}) {
  const hooks = new Map()
  const words = pastWords(model)
  if (!words.length || !Array.isArray(packs) || !packs.length) return hooks

  const min2 = Number(o.level2 ?? LEVEL2_MIN)
  const hisLine = String(o.hisLine?.text ?? '').trim()
  const used = new Set()

  for (const p of packs) {
    const bvid = String(p?.video?.bvid ?? '').trim()
    if (!bvid) continue

    const up = String(p?.video?.up ?? '').trim()
    const title = String(p?.video?.title ?? '').trim()
    const tags = (Array.isArray(p?.tags) ? p.tags : []).map((t) => String(t).trim()).filter(Boolean)

    // ---- 一级：实体对得上 ----
    // 先收全部候选再排序：同一句话在一批里只用一次，但**不能因为第一句被用过就不挂了**——
    // 要往下找下一个没用过的候选（否则两条素材各对上一句话时，第二条会莫名降级或消失）。
    const cands = []
    for (const w of words) {
      const ageOk = !w.ts || now - w.ts >= HOOK_MIN_AGE_DAYS * DAY_MS
      if (!ageOk) continue

      let rank = 0
      if (up.length >= 2 && w.text.includes(up)) rank = 3
      else if (title.length >= TITLE_MIN && w.text.includes(title)) rank = 3
      else if (tags.some((t) => t.length >= TAG_MIN && w.text.includes(t))) rank = 1
      if (!rank) continue
      cands.push({ rank, ts: w.ts, text: w.text })
    }
    cands.sort((a, b) => b.rank - a.rank || b.ts - a.ts)
    const pick = cands.find((c) => !used.has(c.text))

    // 「他刚说的那句」：素材正文里真的出现了他刚说过的话。没有日期可写，单独一种说法。
    if (!pick && hisLine.length >= TITLE_MIN && packText(p).includes(hisLine)) {
      hooks.set(bvid, { level: 1, why: 'hisLine', text: `↳ {T}提过这件事：「${clip(hisLine)}」` })
      continue
    }

    if (pick) {
      used.add(pick.text)
      const date = hookDate(pick.ts)
      hooks.set(bvid, {
        level: 1,
        why: 'entity',
        text: `↳ 你${date ? ` ${date}` : ''}说过：「${clip(pick.text)}」`,
      })
      continue
    }

    // ---- 二级：词面像，但一个字都不引 ----
    let sim = 0
    for (const w of words) {
      if (used.has(w.text)) continue
      const ageOk = !w.ts || now - w.ts >= HOOK_MIN_AGE_DAYS * DAY_MS
      if (!ageOk) continue
      const s = overlap(title, w.text)
      if (s > sim) sim = s
    }
    if (sim >= min2) {
      hooks.set(bvid, {
        level: 2,
        why: 'similar',
        sim,
        text: '↳ 这条和你以前想过的事有点像。（你可以用 her_recall 翻翻）',
      })
    }
    // 三级：不加任何行
  }

  return hooks
}

/** 一次投递里各级钩子各有几个（写 meta `hook:<level>` 用）。 */
export function hookStats(hooks) {
  const st = { 1: 0, 2: 0 }
  for (const h of hooks?.values?.() ?? []) st[h.level] += 1
  return st
}
