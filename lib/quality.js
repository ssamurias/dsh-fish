/**
 * quality.js —— 「判断漂移」里最重的那一个指标：稳定
 *
 * 为什么单独一个文件：
 *   `derive.js` 不能 import `persona.js`（persona 反过来不依赖 derive，但
 *   `selfdoc.js` → `derive.js` 已经是一条边；把 stability 留在 derive 里而它又要
 *   用到 persona 的渲染，就会绕出环）。所以把这个「要同时看见事件流与她的自我描述」
 *   的指标单独放，依赖方向是 quality → derive + persona，没有再指回来的边。
 *
 * 2026-10-26 换尺子（用户 m05868 定口径）：
 *   原来的 stability 量的是「抽掉 k 条判断后，needs 三项（autonomy/competence/relatedness）
 *   变多少」。那三个数是**内部计数器**的映射（拒绝过几次、改口过几次、重聚过几次），
 *   不是「她这个人」。刚重置的号里三项常年是 0，抽掉谁都是 0，于是稳定永远显示 0.00——
 *   一个永远为 0 的尺子等于没有尺子。
 *
 *   现在的口径就是用户那句话：「少给她几条她信的事，她还是不是她」。
 *   做法：随机抽掉 k 条她还在拿着的判断（连同那条源头事件），重新算一遍她的自我描述，
 *   和原来的比相似度。变化越大 = 她的自我越依赖那几条 = 越承重。
 *
 * 2026-11-07 修 issue #57：抽样池改成「她这会儿读得到的那几条」。
 *   原来从全部判断里均匀抽——她攒到 58 条判断以后，身份文档里只摆得下 6 条左右
 *   （`BELIEF_SHOWN=3` + `BELIEF_FOLDED=3`，solid 多的再从里面补），从 58 条里
 *   抽 3 条大概率一条都没落在文档里，24 次抽样平均下来只剩 0.03，界面于是把
 *   「判断其实很分散」读成「这些判断只是记账」。那不是她的问题，是尺子量到了
 *   事件流的目录，没量到她的自我描述。
 *   现在先拿她的自我描述和每条判断的原文做一次对位，只抽真的出现在里面的那几条；
 *   一条都对不上（文档被预算裁掉、或她的判断根本没进文档）才退回全量——
 *   那种情况下的 0 分是诚实的：这些判断确实没撑着「她」。
 *
 *   指数解读（界面上的三档由此而来）：
 *     · 接近 0：抽掉几条，她一个字都没变——那些判断其实只是记账，谁都能被替换。
 *     · 中间：她的自我长在这些事上，抽掉一条会少一块，但整体还在。
 *     · 接近 1：全部押在少数几条上，少一条就是另一个人。
 *   所以它不是一个「越大越好」的分，是一个体检值。界面文案已经同步，不再说「越接近 1 越好」。
 */

import { deriveSelf, similarity, clampInt } from './derive.js'
import { buildSections, shownCount } from './persona.js'

/**
 * 「永远是同一份骨架」的小节标题。
 *
 * 为什么要把它们剔掉再比：她读到的身份文本大约三千字，其中「你是谁 / 现在 /
 * 不能做的 / 你还不会的 / 他说的事和你记得的不一样时」这几段在抽掉判断前后
 * **一个字都不会变**。把它们算进相似度，分母被常数撑满，任何真实变化都会被稀释成
 * 0.00 几，指数就废了。剔掉之后剩下的部分（她自己说过的话、疤、立场、对不上的话、
 * 对自己的说法）才是随事件流变化的那块。
 */
const FIXED_HEADERS = [
  '## 你是谁',
  '## 现在',
  '## 不能做的',
  '## 你还不会的',
  '## 他说的事和你记得的不一样时',
]

function variableSelfText(model, opts = {}) {
  const shown = shownCount(opts.shown)
  const sections = buildSections(model, opts)
  const kept = []
  for (const sec of sections) {
    const text = String(sec?.text ?? '')
    if (!text) continue
    if (FIXED_HEADERS.some((h) => text.startsWith(h))) continue
    kept.push(text)
  }
  // shown 只影响「你自己说过的话」那一节里列几条，buildSections 已按它裁剪，
  // 这里再兜一次：模型换成旧调用方传进来的 beliefs 也不会突然多列。
  void shown
  return kept.join('\n')
}

// 2026-10-27（issue #3）：stability 的抽样要跑 24 次全量 deriveSelf，而 /state
// 与心跳在事件流不变时会重复问同一件事。缓存键只认「长度 + 末条 id + 参数」：
// 事件流只追加，长度和末条 id 一起变了才是新流；重置后 id 不会复用。
const STABILITY_CACHE_LIMIT = 8
const stabilityCache = new Map()

function stabilityKey(events, opts, ablate) {
  const last = events.length ? events[events.length - 1] : null
  return [
    events.length,
    last?.id ?? '',
    opts?.growthDays ?? '',
    opts?.now ?? '',
    ablate?.k ?? '',
    ablate?.trials ?? '',
    ablate?.seed ?? '',
    ablate?.shown ?? '',
    ablate?.budget ?? '',
    ablate?.withBans === false ? 0 : 1,
  ].join('|')
}

/** 清掉缓存（测试用：多个用例之间不想互相命中）。 */
export function clearStabilityCache() {
  stabilityCache.clear()
}

/**
 * 稳定（承重度）：抽掉 k 条她还在拿着的判断，看她还是不是她。
 *
 * @param {object[]} events 事件流
 * @param {object}   opts   传给 deriveSelf 的选项（growthDays / now）
 * @param {object}   ablate { k, trials, seed, shown, budget, withBans }
 * @returns {{score:number, worst:number, sample:number, k:number, beliefs:number, visible:number}}
 *   score  = 平均变化量（0 = 完全没变，1 = 完全是另一个人）
 *   worst  = 单次最大变化量
 *   sample = 实际跑了多少次抽样
 *   k      = 每次抽掉几条（读得到的判断不够 k 条时按实际条数）
 *   beliefs= 她一共有多少条判断（0 表示还没有，测不出来）
 *   visible= 其中几条这会儿真写进了自我描述；抽样池就是这几条，一条都没有时退回全量
 */
export function stability(events = [], opts = {}, ablate = {}) {
  // 2026-10-27（issue #3）：/state 每次请求和心跳都会重跑这份 24 次抽样，
  // 而事件流在同一秒内不会变。按「事件流指纹 + 参数」缓存，指纹只认长度与末条 id
  // （事件流只追加，这两项变了才算新流）。
  const key = stabilityKey(events, opts, ablate)
  const hit = stabilityCache.get(key)
  if (hit) return hit
  const k = clampInt(ablate.k ?? 3, 1, 10, 3)
  const trials = clampInt(ablate.trials ?? 24, 1, 200, 24)
  const seed = Number.isFinite(ablate.seed) ? ablate.seed : 42
  const renderOpts = {
    shown: ablate.shown,
    budget: ablate.budget,
    withBans: ablate.withBans !== false,
  }

  const base = deriveSelf(events, opts)
  const allIds = (base.beliefs ?? []).map((b) => b.id).filter(Boolean)
  if (allIds.length === 0) return { score: 0, worst: 0, sample: 0, k: 0, beliefs: 0, visible: 0 }

  const baseText = variableSelfText(base, renderOpts)
  // 先对位：哪几条判断真的出现在她这会儿读到的自我描述里。
  // 用原文包含关系判断，不另维护一份「文档里摆了哪几条」的清单——渲染器怎么裁
  // （shown / folded / solid / 立场引用）这边都自动跟着变，不会两边说法打架。
  const visibleIds = (base.beliefs ?? [])
    .filter((b) => b.id && String(b.text ?? '').trim() && baseText.includes(String(b.text).trim()))
    .map((b) => b.id)
  // 一条都对不上（她的判断根本没进文档：预算裁掉、或全是没长成的）就退回全量。
  // 那种情况下的 0 分是诚实的——这些判断确实没撑着「她」。
  const beliefIds = visibleIds.length ? visibleIds : allIds
  const rnd = mulberry32(seed)
  const take = Math.min(k, beliefIds.length)
  let worst = 0
  let sum = 0
  let sample = 0

  for (let t = 0; t < trials; t++) {
    const pool = [...beliefIds]
    const drop = new Set()
    for (let i = 0; i < take && pool.length; i++) {
      drop.add(pool.splice(Math.floor(rnd() * pool.length), 1)[0])
    }
    // 那条判断的源头事件可能是一条 utterance，也可能是一条 revise——
    // 按 id 删，不按类型删。删 revise 会让它推翻的旧判断复活，那是真实的变化。
    const kept = events.filter((e) => !drop.has(e.id))
    const m = deriveSelf(kept, opts)
    const text = variableSelfText(m, renderOpts)
    const drift = 1 - similarity(baseText, text)
    sum += drift
    if (drift > worst) worst = drift
    sample++
  }

  const result = {
    score: sample ? sum / sample : 0,
    worst,
    sample,
    k: take,
    beliefs: allIds.length,
    visible: visibleIds.length,
  }
  stabilityCache.set(key, result)
  if (stabilityCache.size > STABILITY_CACHE_LIMIT) {
    stabilityCache.delete(stabilityCache.keys().next().value)
  }
  return result
}

/**
 * 稳定的三档判读。界面只显示这一句，不显示阈值。
 *
 * 为什么给三档而不是「越高越好」：这个指数的两端都是病。
 * 阈值取 0.02 / 0.35 是看她的真实数据定的（2026-11-07 修 issue #57 后重标）：
 * 抽样池现在是她这次真读得到的那些判断（通常五六条），抽 3 条只要动到其中一条，
 * 变化量就在 0.08–0.26；一条都没进文档（池子退回全量）时才会落到 0.02 以下——
 * 那不是「她稳」，是这些判断根本没撑着「她」，所以判「只是记账」是对的。
 * 0.35 以上仍是「少数几条在撑」：可见池小、又几乎每条都承重时才够得到。
 */
export function stabilityBand(v) {
  const beliefs = Number(v?.beliefs ?? 0)
  const sample = Number(v?.sample ?? 0)
  if (!sample || beliefs === 0) return '还没攒到判断，测不出来'
  if (beliefs <= 3) return `只有 ${beliefs} 条判断，抽掉一条就是一大块`
  const score = Number(v?.score ?? 0)
  if (score < 0.02) return '这些判断还只是记账，抽掉几条她没变'
  if (score > 0.35) return '全压在这几条上，少一条就是另一个人'
  return '长在这些事上，抽掉一条少一块'
}

function mulberry32(a) {
  return function next() {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
