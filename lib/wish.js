/**
 * wish.js —— 「够不着的那件事」（2026-11-07，用户 m01602 拍板 B + D）
 *
 * ## 由来
 *
 * `lib/proactive.js` 原来有一个常量 `TOOL_ASK_NOTE`，`lib/scheduler.js` 每次醒来都
 * 把它摆进正文：『如果你想到要做什么、但手上没有那件工具：直接说你要它做什么，
 * 问主人能不能给你装上』。用户 2026-11-07 判定这属于「把提醒换成后台反复催她」——
 * 同一句话每天读两遍，读久了就不是她的念头，是系统的吩咐。
 *
 * 拍板后的改法只有两个位置：
 *   **B** 撞墙才说 —— `lib/restrict.js` 的 `blockedTalk()` 后面补一句，成本近零。
 *   **D** 交给劲儿 —— 这件「够不着的事」攒在劲儿里，攒够了才浮一次；
 *   **C** 桌上一条 —— 浮出来的时候并进 `lib/desk.js` 那张桌子，和好奇、兴趣并排。
 *
 * 这个模块只做那一件事：把「她提过 X、X 需要某工具、手上没有」从事件流里算出来。
 *
 * ## 原料只有一处
 *
 * 她自己开的卡：`ask` 事件里 `ask.kind === 'need-tool'` 的那几条，加上它的裁决
 * （`answer` 事件，`ask.verdict` 是 approve / reject / later）。
 *
 * 不猜、不抽标签、不编主题——展示的 `subject` 与 `text` 都是她当时自己写的原话。
 * 「手上没有」在开卡那一刻成立：她当初开 `need-tool` 的卡，本身就是因为在手上找不着。
 *
 * 开卡之后就不一定了（issue #58）：need-tool 的裁决只记录、不落实权限（`lib/ask.js`），
 * 主人真要给只能在卡外面给（装插件、放开工具），事件流里不会留下「已经给了」。
 * 所以调用方拿得到她此刻的工具名单时传 `has(name)`：`subject` 正好是她手上已有的
 * 工具名，这件事就办完了，不再摆。拿不到名单就不传，照旧——宁可多摆几天，也不猜。
 *
 * ## 三种结局，三种活法
 *
 *   pending  还没答     —— 摆 3 天。没人接的话，一周后还挂着就是催了。
 *   later    「以后再说」 —— 摆 30 天。`lib/ask.js` 的注释写明这是「先放着」，不是否决。
 *   approve  他答应了   —— 摆 14 天。答应了没到，是这件事剩下的唯一一段。
 *   reject   「这次不行」 —— **不摆**。不同意就是不问了，再提一次就成了追问。
 *   timeout  放一天没人答 —— 算 pending（`via:'timeout'` 那条 answer 的 verdict 虽写 later，
 *            那是为了不再反复追问，不能借来说成「他说以后再说」）。
 *
 * 四条硬约束照旧（与 curiosity.js / desk.js 一致）：
 *   1. 不审批、不派活：只摆事实，不说「你可以去要」。
 *   2. 不吃状态：返回值只有文本，任何数字都不进正文。
 *   3. 有上限：最多 WISH_SHOW_MAX 条，原文最长 WISH_TEXT_MAX 字。
 *   4. 翻不到的不编：一条都没有就返回空数组。
 */

import { tsMs } from './schema.js'
import { similarity } from './derive.js'

/** 一次最多摆几条。多了就成了许愿清单。 */
export const WISH_SHOW_MAX = 2
/** 原话展示最长多少字。 */
export const WISH_TEXT_MAX = 60
/** 两句算同一件事的门槛，与 curiosity.js / desk.js 同一个口径。 */
export const WISH_SIMILARITY = 0.42

/** 还没答的摆几天。 */
export const WISH_PENDING_DAYS = 3
/** 「以后再说」的摆几天——那是「先放着」，不是否决。 */
export const WISH_LATER_DAYS = 30
/** 他答应了但还没到的摆几天。 */
export const WISH_APPROVE_DAYS = 14

const DAY = 86_400_000

/** `askId` → 那条 `answer` 事件。 */
function answersByAsk(events) {
  const m = new Map()
  for (const e of events ?? []) {
    if (e?.type !== 'answer') continue
    const id = String(e?.ask?.askId ?? '')
    if (id) m.set(id, e)
  }
  return m
}

/**
 * 一条 `answer` 事件对「她提过的那件事」意味着什么。
 *
 * 放一天没人答的卡，`lib/ask.js` 会记成 `verdict:'later'` + `via:'timeout'`
 * （`text` 写「一直没人答」）——那是为了不再反复追问她同一张卡，不是她答应了什么。
 * 按 later 说成「他说以后再说」是编的：什么都没人说。这里把它还原成 pending。
 */
function verdictOf(answer) {
  if (!answer) return 'pending'
  if (String(answer?.ask?.via ?? '') === 'timeout') return 'pending'
  return String(answer?.ask?.verdict ?? '') || 'pending'
}

/** 这条愿望还该活几天；返回 0 表示不再摆。 */
function lifeDays(verdict) {
  if (verdict === 'reject') return 0
  if (verdict === 'later') return WISH_LATER_DAYS
  if (verdict === 'approve') return WISH_APPROVE_DAYS
  return WISH_PENDING_DAYS
}

/**
 * 这张 need-tool 卡要的那件工具，是不是已经在她手上了（issue #58）。
 *
 * 只认 `subject` 正好是工具名——ask_owner 的参数说明让她在这里填工具名；写的是一件事、
 * 一句描述的，猜不准是不是同一样东西，按没到算。`has(name)` 也要明确返回 `true`：
 * 没传、抛错、返回别的都当不知道。
 *
 * @param {object} e `ask` 事件
 * @param {(name: string) => boolean} [has]
 */
export function toolArrived(e, has) {
  if (typeof has !== 'function') return false
  if (String(e?.ask?.kind ?? '') !== 'need-tool') return false
  const subject = String(e?.ask?.subject ?? '').trim()
  if (!subject) return false
  try {
    return has(subject) === true
  } catch {
    return false
  }
}

/** 她那句话怎么收尾——只陈述结局，不给建议。 */
export function wishTail(verdict) {
  if (verdict === 'approve') return '他答应了，还没见到'
  if (verdict === 'later') return '他说以后再说'
  if (verdict === 'reject') return '那次不行'
  return '你问过，还没有答复'
}

/**
 * 她提过、手上没有的那几件事。
 *
 * @param {Array} events 全量事件
 * @param {object} [o]
 * @param {number|Date} [o.now]
 * @param {number} [o.days] 覆盖窗口（测试用）；不传就按结局各算各的
 * @param {(name: string) => boolean} [o.has] 她此刻手上有没有这件工具（issue #58）。
 *   只有明确返回 `true` 才算到手；不传、抛错、返回别的都按「不知道」，照旧摆。
 * @returns {Array<{id:string, text:string, subject:string, verdict:string, at:number, tail:string}>}
 *   按时间从近到远
 */
export function wishesOf(events = [], { now = Date.now(), days = 0, has } = {}) {
  const at0 = now instanceof Date ? now.getTime() : Number(now) || Date.now()
  const answers = answersByAsk(events)
  const picked = []
  for (const e of events ?? []) {
    if (e?.type !== 'ask') continue
    if (String(e?.ask?.kind ?? '') !== 'need-tool') continue
    const verdict = verdictOf(answers.get(String(e.id ?? '')))
    const life = days > 0 ? days : lifeDays(verdict)
    if (life <= 0) continue
    const at = tsMs(e)
    if (!Number.isFinite(at) || at <= 0) continue
    if (at0 - at > life * DAY) continue

    const raw = String(e.text ?? '').trim()
    if (!raw) continue
    const text = raw.length > WISH_TEXT_MAX ? `${raw.slice(0, WISH_TEXT_MAX - 1)}…` : raw
    const subject = String(e?.ask?.subject ?? '').trim()
    // 要的那件工具已经在她手上了：这件事办完了，不再摆（issue #58）。
    if (toolArrived(e, has)) continue
    // 同一件事反复问过（她开两张卡）：只留最近的那一张，不摆两遍。
    if (picked.some((p) => similarity(p.subject || p.text, subject || text) >= WISH_SIMILARITY)) continue
    picked.push({ id: String(e.id ?? ''), text, subject, verdict, at, tail: wishTail(verdict) })
  }
  picked.sort((a, b) => b.at - a.at)
  return picked.slice(0, WISH_SHOW_MAX)
}

/**
 * 墙上那一行（桌子用）。
 * @param {{text:string, tail:string}} w wishesOf() 的一条
 * @returns {string}
 */
export function wishLine(w) {
  const text = String(w?.text ?? '').trim()
  if (!text) return ''
  const tail = String(w?.tail ?? '').trim()
  return tail ? `- 「${text}」（${tail}）` : `- 「${text}」`
}
