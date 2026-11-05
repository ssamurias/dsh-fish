/**
 * curiosity.js —— 她惦记着、还没合上的口子（2026-11-05，主观能动性 步 0）
 *
 * 为什么先做这个，而不是先做「劲儿」：
 *   用户 m01512 的原话——「先把桌子摆满（好奇 + 回音）→ 再上劲儿 → 最后才做兴趣排序」。
 *   劲儿只管「该不该醒」；桌上没有东西，醒得再准也只是空醒。
 *
 * 这一版只做两件事，都是**纯派生**：不改调用点、不加工具、不落盘。
 *
 *   1. 好奇：她自己问出来、之后没有答案的问题。
 *      数据只有一处——她自己的话（HER_TYPES 里的 utterance/narration/dream…），
 *      只留证的不算（isProofOnly：没认领的聊天行、想改自己的话）。
 *      不问模型、不抽标签、不编主题：展示的就是她的**原话**，最近一次那句。
 *      同一件事反复问 → 归成一个口子（字符相似度聚类，用 derive.js 里现成的 similarity）。
 *
 *   2. 回音：她上次留的话，他有没有来看到。
 *      数据也是现成的：`meta letter:<dk>:<id>` 是她留话（lib/letter.js），
 *      `meta seen:<ISO>` 是他来过（lib/capture.js / lib/say.js）。两条一夹就有答案。
 *
 * 四条硬约束照旧：
 *   1. 不审批、不派活：这里只把事实摆出来，不说「你可以去想想」。
 *   2. 不吃状态：返回值只有文本，任何数字都不进。
 *   3. 有上限：最多列 CURIOSITY_SHOW_MAX 条，原文最长 CURIOSITY_TEXT_MAX 字。
 *   4. 翻不到的不编：一个字都没有就返回空串，一个字都不多。
 */

import { isProofOnly, similarity } from './derive.js'
import { HER_TYPES, tsMs } from './schema.js'

/** 一次醒来最多摆几个口子。多了就成了清单，不是惦记。 */
export const CURIOSITY_SHOW_MAX = 3
/** 原话展示最长多少字（太长的句子不是问题，是一段话）。 */
export const CURIOSITY_TEXT_MAX = 60
/** 太短的句子不当问题（「在吗」「为什么」这种单独成句的多半是碎片）。 */
export const CURIOSITY_MIN_CHARS = 8
/** 两句算「同一件事」的相似度门槛。0.42 是拿她真实说过的话试出来的：再低会把不同的事并成一团。 */
export const CURIOSITY_SIMILARITY = 0.42
/** 半衰期（天）：上个礼拜问的，这个礼拜还剩一半分量。 */
export const CURIOSITY_HALF_DAYS = 7
/** 低于这个分量的不摆（什么都不留，比摆一堆两个月前的强）。 */
export const CURIOSITY_MIN_WEIGHT = 0.15
/** 回音最多提一句。 */
export const ECHO_HOURS = 72

const HER = new Set(HER_TYPES)
/**
 * 「这句话是问出来的」怎么认：句末是问号、句首是疑问词、或者她自己说了「想弄明白」。
 *
 * 早先的写法是「句子里出现『有没有 / 为什么』就算」。拿她真实的 746 条事件试跑，
 * 摆出来的三条里有两条是陈述句（「区别在拼完之后有没有一句是自己的」）——
 * 那等于替她认领了一个她没问过的问题。所以收紧成三种形状；
 * 第三种是拿她真实数据校准出来的：她的问句几乎不带问号，真正像「惦记」的是
 * 「我想弄清这句话为什么成立」「想知道明天醒来，还是不是这个我」这一类自述。
 */
const QUESTION_TAIL = /[？?]\s*$/
const QUESTION_HEAD = /^(为什么|怎么|到底|是不是|有没有|能不能|要不要|想知道|我想知道|我在想|我不明白|弄不明白|搞不懂|一直没弄明白)/
const QUESTION_SELF = /(想知道|想弄清|弄不明白|搞不懂|我在想)/

/** 把一段话切成句子：保留句末标点（问号要用来认「这是不是一句问话」）。 */
function sentences(text) {
  return String(text ?? '')
    .split(/(?<=[。！？!?；;\n])/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 一句里只留给人看的部分：去掉句末标点与空白。 */
function bare(s) {
  return String(s ?? '').replace(/[。！？!?；;，,、\s]+$/u, '').trim()
}

/**
 * 她问过的句子，按时间顺序。
 * @returns {Array<{text:string, at:number}>}
 */
export function questionsOf(events = []) {
  const out = []
  for (const e of events ?? []) {
    if (!e || !HER.has(e.type)) continue
    // 聊天里随口问的一句不是她惦记的口子，问的多半还是对面的人；
    // 想改自己的话有它自己的去处（events.js 的 selfmodAttempts）。
    if (isProofOnly(e)) continue
    const at = tsMs(e)
    for (const s of sentences(e.text)) {
      const q = bare(s)
      if (q.length < CURIOSITY_MIN_CHARS) continue
      if (!QUESTION_TAIL.test(s) && !QUESTION_HEAD.test(q) && !QUESTION_SELF.test(q)) continue
      out.push({ text: q.length > CURIOSITY_TEXT_MAX ? `${q.slice(0, CURIOSITY_TEXT_MAX)}…` : q, at })
    }
  }
  return out.sort((a, b) => a.at - b.at)
}

/**
 * 把「她反复问到过的事」聚成口子。
 *
 * 写法说明：不抽关键词、不做主题归类——只用字符相似度把她自己的两句话并起来。
 * 宁可少归并（同一个口子出现两条），也不要编一个她没说的主题出来。
 *
 * @param {Array} events
 * @param {number|Date} [now]
 * @returns {Array<{text:string, hits:number, lastAt:number, weight:number}>}
 */
export function curiosityOf(events = [], now = Date.now()) {
  const at0 = now instanceof Date ? now.getTime() : Number(now)
  const clusters = []
  for (const q of questionsOf(events)) {
    let hit = null
    for (const c of clusters) {
      if (similarity(q.text, c.text) >= CURIOSITY_SIMILARITY) { hit = c; break }
    }
    if (hit) {
      hit.hits += 1
      hit.text = q.text // 用最近一次的原话，不用第一次的（人会越问越清楚）
      hit.lastAt = q.at
    } else {
      clusters.push({ text: q.text, hits: 1, lastAt: q.at })
    }
  }
  const out = []
  for (const c of clusters) {
    const ageDays = Math.max(0, (at0 - c.lastAt) / 86400000)
    const weight = Math.min(c.hits, 4) / 4 * Math.pow(2, -ageDays / CURIOSITY_HALF_DAYS)
    if (weight < CURIOSITY_MIN_WEIGHT) continue
    out.push({ ...c, weight })
  }
  out.sort((a, b) => (b.weight - a.weight) || (b.lastAt - a.lastAt))
  return out
}

/** 几天前 / 今天 / 昨天——不给小时数，那不是她会算的东西。 */
function agoText(at, at0) {
  const days = Math.floor(Math.max(0, at0 - at) / 86400000)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  return `${days} 天前`
}

/**
 * 一句话摆在醒来那一刻。
 * 只写事实：问过什么、问过几次、最近一次什么时候。不写「要弄明白」「值得想想」。
 *
 * @param {Array} items curiosityOf() 的结果
 * @param {number|Date} [now]
 * @returns {string}
 */
export function renderCuriosity(items = [], now = Date.now()) {
  const list = (items ?? []).filter(Boolean).slice(0, CURIOSITY_SHOW_MAX)
  if (!list.length) return ''
  const at0 = now instanceof Date ? now.getTime() : Number(now)
  const lines = ['你自己问过、还没答案的几件事：']
  for (const it of list) {
    const times = it.hits > 1 ? `问过 ${it.hits} 次，最近一次是${agoText(it.lastAt, at0)}` : agoText(it.lastAt, at0)
    lines.push(`- 「${it.text}」（${times}）`)
  }
  return lines.join('\n')
}

/** 她最近一次留话（`meta letter:<dk>:<id>`）的时间；没留过就是 0。 */
export function lastLeaveAt(events = []) {
  let at = 0
  for (const e of events ?? []) {
    if (e?.type !== 'meta') continue
    if (!String(e.text ?? '').startsWith('letter:')) continue
    const ts = tsMs(e)
    if (Number.isFinite(ts) && ts > at) at = ts
  }
  return at
}

/** 他最近一次来过（`meta seen:<ISO>`）的时间；没来过就是 0。 */
export function lastSeenAt(events = []) {
  let at = 0
  for (const e of events ?? []) {
    if (e?.type !== 'meta') continue
    const t = String(e.text ?? '')
    if (!t.startsWith('seen:')) continue
    const ts = Date.parse(t.slice(5))
    if (Number.isFinite(ts) && ts > at) at = ts
  }
  return at
}

/**
 * 回音：她留的话，他到底来看到没有。
 *
 * 只在一件事上给一句：留过话、而且这件事还没老到没意义（ECHO_HOURS 内）。
 * 没留过话 → 空串；留过但已经过去很久 → 也空串（旧账不催）。
 *
 * @param {Array} events
 * @param {number|Date} [now]
 * @returns {string}
 */
export function renderEcho(events = [], now = Date.now()) {
  const at0 = now instanceof Date ? now.getTime() : Number(now)
  const leave = lastLeaveAt(events)
  if (!leave) return ''
  const age = at0 - leave
  if (age < 0 || age > ECHO_HOURS * 3600000) return ''
  const seen = lastSeenAt(events)
  if (seen >= leave) return '你上次留的那句话，他后来来过了。'
  return '你上次留的那句话，他还没来过。'
}
