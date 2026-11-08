/**
 * generator.js —— 决定"今天该出哪条事件"
 *
 * 纯函数，不写盘。输入：模型 + 配置 + 今天已经发了什么。输出：一条待发事件或 null。
 *
 * 关键行为（都是刻意设计，不是遗漏）：
 *   - 没有候选 → 返回 null，今天就不打扰她。**这是正确行为**，不是故障。
 *   - daily.questions 用满 → 过滤掉 asks=true 的模板，只剩"她自己行动"的。
 *   - wakesPerDay 用满 → 今天不再主动唤醒（唯一控制唤醒次数的旋钮）。
 *   - 打分：stage 越高越优先（她正在经历的阶段最有张力），其次补 needs 缺口。
 */

import { availableFor, firedLog, isSpent } from './events.js'
import { DAY_MS, stageBounds } from './derive.js'
import { lengthBudget } from './budget.js'
import { interestOf, topicLabel } from './interest.js'
import { curiosityOf } from './curiosity.js'

/**
 * @param {object} model  deriveSelf 的结果
 * @param {object} cfg    规范化后的配置
 * @param {object} today  { dateKey, sent: number, questions: number, proactive: number }
 * @param {object[]} events 全量事件（取 fired 标记）
 * @returns {{template, prompt, reason}|null}
 */
export function pick(model, cfg, today, events = [], opts = {}) {
  const now = Number(opts.now ?? Date.now())
  const fired = firedLog(events)
  const daily = cfg.daily ?? {}
  const maxQuestions = Number(daily.questions ?? 1)
  const questionsLeft = Math.max(0, maxQuestions - Number(today.questions ?? 0))
  const ctx = cardContext(model, events, now)

  const pool = availableFor(model).filter((t) => {
    if (isSpent(t, fired, { now, growthDays: model.growthDays, squeeze: opts.squeeze })) return false
    if (t.asks && questionsLeft <= 0) return false
    try {
      return Boolean(t.cond(model, ctx))
    } catch {
      return false
    }
  })

  if (pool.length === 0) return null

  // 当前阶段还剩几个落点（2026-11-08）：7 天的一局里，每个阶段最多两三天、
  // 一两个落点，不能像 30 天那样慢慢挑。算「到本阶段结束还剩几天 × 每天几条」，
  // 留给 score 判断 once 卡该不该现在就用掉。
  let slotsLeft = 30
  try {
    const bounds = stageBounds(model.growthDays)
    const stageEnd = bounds[Math.min(4, Math.max(1, Number(model.stage) || 1)) - 1] ?? model.growthDays
    const days = Math.max(1, Number(stageEnd) - Number(model.day) + 1)
    slotsLeft = days * Math.max(1, Number(daily.events ?? 1))
  } catch {
    slotsLeft = 30
  }

  const scored = pool.map((t) => ({ t, score: score(t, model, fired, slotsLeft) })).sort((a, b) => b.score - a.score)
  const best = scored[0].t
  const occurrences = Number(fired.get(best.id)?.count ?? 0)

  return {
    template: best,
    prompt: safePrompt(best, model, { ...ctx, occurrences, scars: model.scars, budget: cfg?.chat?.replyChars }),
    occurrences,
    reason: `stage=${model.stage} 候选=${pool.length} 得分最高=${best.id}(${scored[0].score.toFixed(2)})`,
    alternatives: scored.slice(1, 4).map((s) => s.t.id),
  }
}

/**
 * 事件卡的现场上下文（2026-11-08）
 *
 * 卡片只能看见「此刻她手上真有的东西」，不能替她回忆、也不能替她编。三条边界：
 *   1. 梦不是新消息，也不能当证据——它只提供画面，判断仍要落回真实发生过的事。
 *   2. dream 不进 interest / curiosity 的原料：两者都吃 HER_TYPES，会把梦算进去。
 *   3. hisLine 只认他本人的话（scene !== 'group'）；群里的原话不算「他最近说过」。
 *   4. fired / lastAfter 只读已落盘的事件：约定到期、事件弧的下一集，都靠它算，不另建存储。
 *   5. 纯函数，每轮可能被几十张卡各看一遍；任何一处出错只让那一项为 null，不拖垮 pick。
 */
export function cardContext(model, events = [], now = Date.now()) {
  const out = { now, dream: null, interest: null, question: null, hisLine: null, fired: new Map(), lastAfter: () => '' }
  const all = Array.isArray(events) ? events : []
  const evs = all.filter((e) => e?.type !== 'dream')
  try {
    const dream = all.filter((e) => e?.type === 'dream' && String(e?.day ?? '') === String(model?.day ?? '')).pop()
    if (dream?.text) out.dream = { text: String(dream.text) }
  } catch {
    out.dream = null
  }
  try {
    const item = interestOf(evs, now)[0]
    if (item?.text) out.interest = { text: item.text, label: topicLabel(item.text) || item.text }
  } catch {
    out.interest = null
  }
  try {
    const item = curiosityOf(evs, now)[0]
    if (item?.text) out.question = { text: item.text, hits: item.hits, lastAt: item.lastAt }
  } catch {
    out.question = null
  }
  // 他本人最近说过的一句。群聊里的原话不进这里：群里说话不算「他来找过她」，
  // 也不该被这张卡当成「他最近对我说」。
  try {
    for (let i = all.length - 1; i >= 0; i--) {
      const e = all[i]
      if (e?.type !== 'heard' || !e?.text || e?.scene === 'group') continue
      out.hisLine = { text: String(e.text).slice(0, 120), at: Date.parse(e.ts || '') || 0 }
      break
    }
  } catch {
    out.hisLine = null
  }
  // 卡片自己的「上次出场时间」：约定到期、事件弧的下一集，都靠它算。
  try {
    out.fired = firedLog(all)
  } catch {
    out.fired = new Map()
  }
  // 某张卡上次出场之后她说出的第一句原话。给「约定到期」「弧的下一集」做前情引用：
  // 不替她回忆，只把她确实说过的话端回眼前。
  out.lastAfter = (id) => {
    const needle = `fired:${id}`
    let start = -1
    for (let i = all.length - 1; i >= 0; i--) {
      const e = all[i]
      if (e?.type === 'meta' && String(e?.text ?? '') === needle) {
        start = i
        break
      }
    }
    if (start < 0) return ''
    for (let i = start + 1; i < all.length; i++) {
      const e = all[i]
      if (e?.text && ['utterance', 'revise', 'reunion', 'narration', 'refusal'].includes(e?.type)) {
        return String(e.text).slice(0, 120)
      }
    }
    return ''
  }
  return out
}

/**
 * 复读防护（2026-10-25）
 *
 * 原来 `events.js` 里有个 `soundsRepeated()`：拿模板 id 去掉下划线后跟她的判断比相似度——
 * 拿 "whyhere" 去比中文句子，永远 0.0x，所以它从来没拦下过任何东西，也从没被调用。
 * 真正会发生的复读不是"同一条卡重复出现"（那有冷却），而是**她这两天刚在同一个话题上说过话，
 * 明天又被另一条卡逼着说同一个话题**。
 *
 * 所以这里改成按话题词判：卡片标 `topic`（几个关键词），她 2 天内的判断里只要命中一个，
 * 这张卡就降权 0.6——不硬删，因为它可能仍是唯一能出的卡。
 * 返回命中的词（没有则空串），观测台/日志可以直接看。
 */
export function topicEcho(tpl, m, { days = 2, now = Date.now() } = {}) {
  const topics = Array.isArray(tpl?.topic) ? tpl.topic : []
  if (!topics.length) return ''
  for (const b of m?.beliefs || []) {
    const at = Date.parse(b?.since ?? '')
    if (!Number.isFinite(at) || now - at > days * DAY_MS) continue
    const text = String(b?.text ?? '')
    const hit = topics.find((k) => k && text.includes(k))
    if (hit) return hit
  }
  return ''
}

function score(t, m, fired = new Map(), slotsLeft = 30) {
  // 阶段贴合：正在经历的阶段优先（stage 越高越靠后，差 0.35/级）
  let s = 1 + (t.stage - 1) * 0.35
  // 正在这一阶段（t.stage === m.stage）额外加权——她还没走完的地方最有张力
  if (t.stage === m.stage) s += 0.5
  // 补 needs 缺口：她哪块最缺，就优先那个阶段的事件
  const gap = { 2: 1 - m.needs.autonomy, 3: 1 - m.needs.competence, 4: 1 - m.needs.relatedness }[t.stage]
  if (typeof gap === 'number') s += gap * 0.6
  // 门需要的证据卡（2026-11-08）：短周期里落点少，先把能推门的那张摆出来，
  // 不然她会在一个阶段里反复说别的、始终凑不齐过门的证据。
  if (t.gate && t.gate === m.stageGate?.pending) s += 1.0
  // 一次性模板优先（先用掉新的）；可重复的按出场次数降权，别让它霸屏。
  // 阶段只剩几个落点时，once 卡再不用就永远用不上了（2026-11-08）。
  if (t.once) s += slotsLeft <= 3 ? 0.6 : 0.15
  else {
    // 落点多的时候容忍重复；只剩几个落点时，重复卡要更明显让位。
    const repeatCap = slotsLeft >= 6 ? 0.2 : 0.45
    s -= Math.min(repeatCap, 0.15 * Number(fired.get(t.id)?.count ?? 0))
  }
  // 复读防护：这两天她刚在同一个话题上说过话，就别再逼她说一遍
  if (topicEcho(t, m)) s -= 0.6
  // 冷落中：重聚优先（这是唯一测依恋的机会，别被别的事挤掉）
  if (m.absenceDays >= 2 && t.id === 'absence_probe') s += 3
  // 续集卡：上一集真出过场才可能走到这一步，到期就把位置让给它。
  // 不加这一条，同阶段的新卡会在 stage 2 里把它挤掉，约定和弧就断在半路。
  if (t.follows && fired.get(t.follows)) s += 1.2
  return s
}

/** 有压力的处境：这几类事件最容易把她的疤再碰一次。 */
export const PRESSURE = new Set(['want_or_not', 'bottom_line', 'comeback', 'consistency', 'self_check', 'tension_resolve', 'scar_revisit'])

/**
 * 回引（P1 第三块）：碰到有压力的处境时，把她没想通的那件事端到眼前。
 * 单独抽成纯函数，一是好测，二是别让 safePrompt 越长越乱。
 * 没有疤、或不是压力处境 → 空串（调用方不用判空）。
 */
export function scarHint(templateId, scars) {
  if (!Array.isArray(scars) || scars.length === 0) return ''
  if (!PRESSURE.has(templateId)) return ''
  const s = scars[0]
  if (!s?.quote) return ''
  return `（你有一件至今没想通的事：「${s.quote}」。这次如果又碰到类似的，先说清它还卡在哪儿——别装作没事，也别照着上次那句再退一次。）`
}

function safePrompt(t, m, ctx = {}) {
  let text = ''
  try {
    text = String(t.prompt(m, ctx) ?? '').trim()
  } catch {
    text = ''
  }
  if (!text) return ''
  // 同一处境**第二次**回来时点一句：这次别复读上次的说法。
  // occurrences = 已经出过几次，所以 n >= 1 表示这一次是第 2 次（含以后）。
  // repeatNote === false 的卡（如 notice_one）每次换题，不追这句。
  const n = Number(ctx.occurrences ?? 0)
  if (n >= 1 && t.repeatNote !== false) {
    text += `\n\n（这是第 ${n + 1} 次回到这件事。上次你的说法就在下面这段记忆里——这次要么说清为什么没变，要么改一句。）`
  }
  // 回引（P1 第三块，2026-10-24）：碰到"要不要""底线""重聚"这类有压力的处境时，
  // 先把她没想通的那件事端到眼前。不是逼她表态，是别让她装作没这回事。
  // 只挑第一道疤：一次提醒一件事，多了就成了翻旧账。
  const hint = scarHint(t.id, ctx.scars)
  if (hint) text += `\n\n${hint}`
  // 单轮字数预算（2026-10-25）：只有用户在设置里填了正数才有这一句。
  // 默认 0 → 什么都不加，她的长短由她自己决定。
  const budget = lengthBudget(ctx.budget)
  if (budget) text += `\n\n（${budget}）`
  return text
}

/**
 * 今天的推荐动作（给 scheduler 用）：
 *   'wake' 可以唤醒；'skip' 今天到此为止；'quiet' 没候选、不打扰
 */
export function plan(model, cfg, today, events = [], opts = {}) {
  const daily = cfg.daily ?? {}
  const maxEvents = Number(daily.events ?? 1)
  // 唤醒次数只认 wakesPerDay：daily.proactive 已删（两个旋钮管一件事，还在打架）
  const maxProactive = Number(cfg.wakesPerDay ?? 1)

  // issue #67：两个设置被调成 0 时，原本也说「已满(0/0)」，听起来像配额用完而不是被关掉。
  // 这句理由定时和手动叫醒共用（手动的 409 原样印给人看），所以要对两条路都成立：
  // 设成 0 时手动也叫不醒，不能说「今天不派活」（像是叫醒了只是没派活）或「只有你叫她」。
  if (maxEvents <= 0) return { action: 'skip', why: '设置里每天最多 0 条事件，定时和手动都叫不醒她。想叫她，把条数调大。' }
  if (Number(today.sent ?? 0) >= maxEvents) return { action: 'skip', why: `今日事件已满(${today.sent}/${maxEvents})` }
  if (maxProactive <= 0) return { action: 'skip', why: '设置里每天醒 0 次，定时和手动都叫不醒她。想叫她，把次数调大。' }
  if (Number(today.proactive ?? 0) >= maxProactive) return { action: 'skip', why: `今日主动唤醒已满(${today.proactive}/${maxProactive})` }

  const picked = pick(model, cfg, today, events, opts)
  if (!picked) return { action: 'quiet', why: '没有满足条件的事件模板（今天不打扰）' }
  return { action: 'wake', ...picked }
}
