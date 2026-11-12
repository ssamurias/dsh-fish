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
 *
 * ## 「手上没有」不能只看事件（issue #58，2026-11-08）
 *
 * 这条前提一开始只有半句：她开 `need-tool` 卡就是因为当时找不着。可是 `lib/ask.js`
 * 文件头第 2 条写明，`need-tool` 的裁决**只记录、不落实任何权限**——他真要给，
 * 只能在卡外面给（装插件、把她要的名字加进白名单），事件流里一个字都不会记。
 * 于是卡上答过「可以」、工具也真到手了，桌上照样摆 14 天「他答应了，还没见到」；
 * 超时那种还会摆 3 天「你问过，还没有答复」。这句话当时就是错的，而且通过
 * `driveDesk.wish` 给劲儿记一笔，一件已经办完的事还会推她醒。
 *
 * 所以 `wishesOf` 现在收一个可选的 `has`：她此刻手上真正放行的工具名。
 * 对得上的那几条不再摆，也不进劲儿。拿不到这份清单（收窄关着/还没注册）
 * 就不传——那时她能看见全部工具，宁可不判，也不能把「不知道」当成「没有」。
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

/**
 * subject 里认工具名的最短长度（issue #83）。
 * 短名字（`her`、`bili`）在中文句子里太容易撞上，只认 4 个字以上的。
 */
const TOOL_NAME_MIN = 4

/** subject 开头可以先有的空白和左引号、左括号（「`her_note`：…」「「her_note」…」也算写在最前面）。 */
const HEAD_OPENERS = /^[\s`'"“‘「『《〈【[(（<]+/

/**
 * 剥掉标点之后，开头还可能是「用 / 就」这类前缀（issue #109）：
 * 「用 her_note 记长一点的东西」「就是 bili_look 能看整条的」——说的是手上已有的工具。
 *
 * 不放「像」：`像 bash 那样能跑 python 的东西` 是拿手上的工具作比较，要的是另一样东西
 * （#102 的用例），放行会把「还没有的东西」误判成到手。
 */
const HEAD_PREFIX = /^(?:(?:就是|用|就)\s*)+/

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
 * 这件东西现在是不是已经在她手上了（issue #58）。
 *
 * `has` 三种写法都认：函数（按名字判）、Set、名字数组。传空/不传一律当「查不了」，
 * 返回 false —— 查不了就不剔，宁可多摆一条，也不把已经说出口的事再催一遍。
 * 判的时候顺手接住异常：一个坏掉的判断不该拖垮一次唤醒。
 */
function toolInHand(has, name) {
  const n = String(name ?? '').trim()
  if (!n || !has) return false
  try {
    if (typeof has === 'function') return has(n) === true
    if (has instanceof Set) return has.has(n)
    if (Array.isArray(has)) return has.includes(n)
  } catch { /* 判不了就当没有 */ }
  return false
}

/**
 * subject 开头点到的那个工具名；没有就返回空串（issue #83）。
 *
 * 0.9.5 只认「subject 正好等于工具名」。可真实数据里她常写成
 * 「her_note 的读取：列出还没划掉的那些」——一句描述里带着工具名，
 * 精确比对就永远对不上，卡照样摆满 14 天（issue #83 实测）。
 *
 * 这里再认一种：subject **开头**是一个完整的工具名。只认开头，不在句子中间找：
 * 收窄关着时 `has` 是她这一局看得见的全部工具，里面有宿主的 `read`、`edit`、`bash`、
 * `grep`、`glob` 这类正好 4 个字的名字。她要一样新东西时常拿手上的作比较——
 * 「能看 PDF 里图片的工具（read 只给我文字）」「像 bash 那样能跑 python 的东西」
 * 「能 edit 图片的工具」——句子里点到的是她已经有的，要的是还没有的。
 * 在整句里找名字，这些卡一开就被当成到手，从桌子、劲儿、主动回合三处一起撤掉；
 * 长名一样会撞（「能看整条视频的（bili_look 只给几张截图）」）。
 * `ask_owner` 的 subject 说明本来就教她「要工具时把工具名写在最前面」，按开头认正好对得上。
 *
 * 边界：
 *   - 开头的空白和左引号、左括号先跳过（「`her_note`：…」也算）；
 *   - 只认 TOOL_NAME_MIN 个字符以上的名字，短名在中文句子里太容易误撞；
 *   - 名字后面不能紧挨字母/数字/下划线（`her_note` 不该被 `her_notes` 命中）；
 *   - 命中多个时取最长的那个（`bili_look` 与 `bili_look_at` 都对得上时以后者为准）。
 * `has` 是函数时列不出名单，只能按整句比——猜不了就不猜，宁可多摆几天。
 */
function toolNamedIn(has, subject) {
  if (!subject) return ''
  if (toolInHand(has, subject)) return subject
  if (!(has instanceof Set) && !Array.isArray(has)) return ''
  const head = subject.toLowerCase().replace(HEAD_OPENERS, '').replace(HEAD_PREFIX, '')
  let hit = ''
  for (const raw of has instanceof Set ? [...has] : has) {
    const name = String(raw ?? '').trim().toLowerCase()
    if (name.length < TOOL_NAME_MIN) continue
    if (!head.startsWith(name)) continue
    if (/[a-z0-9_]/.test(head[name.length] ?? '')) continue
    if (name.length > hit.length) hit = name
  }
  return hit
}

/**
 * 这张卡要的东西是不是已经在她手上了（issue #58 / #83）。
 *
 * 认两种写法：`subject` 正好是工具名，或 `subject` 开头是一个工具名
 * （「某工具：做什么」）。剩下的（纯描述、没点名的、只在句子中间拿手上的东西作比较的）
 * 猜不准是不是同一样东西，宁可多摆几天。查不了（`has` 没传/抛错）也照旧摆。
 */
export function toolArrived(e, has) {
  if (String(e?.type ?? '') !== 'ask') return false
  if (String(e?.ask?.kind ?? '') !== 'need-tool') return false
  const subject = String(e?.ask?.subject ?? '').trim()
  return Boolean(toolNamedIn(has, subject))
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
 * @param {((name:string)=>boolean)|Set<string>|string[]} [o.has]
 *   她此刻手上有的工具名。不传就不查（老调用点行为不变）
 * @returns {Array<{id:string, text:string, subject:string, verdict:string, at:number, tail:string}>}
 *   按时间从近到远
 */
export function wishesOf(events = [], { now = Date.now(), days = 0, has = null } = {}) {
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
    // 已经到手的不再摆（issue #58 / #83）：卡上答「可以」不发权限，他只能在卡外给，
    // 事件流里没有这条记录，所以按她此刻的白名单对一遍——整句是工具名、或句子开头是工具名都算。
    if (toolNamedIn(has, subject)) continue
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
