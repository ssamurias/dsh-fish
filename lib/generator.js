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
import { DAY_MS } from './derive.js'
import { lengthBudget } from './budget.js'

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

  const pool = availableFor(model).filter((t) => {
    if (isSpent(t, fired, { now, growthDays: model.growthDays, squeeze: opts.squeeze })) return false
    if (t.asks && questionsLeft <= 0) return false
    try {
      return Boolean(t.cond(model))
    } catch {
      return false
    }
  })

  if (pool.length === 0) return null

  const scored = pool.map((t) => ({ t, score: score(t, model, fired) })).sort((a, b) => b.score - a.score)
  const best = scored[0].t
  const occurrences = Number(fired.get(best.id)?.count ?? 0)

  return {
    template: best,
    prompt: safePrompt(best, model, { occurrences, scars: model.scars, budget: cfg?.chat?.replyChars }),
    occurrences,
    reason: `stage=${model.stage} 候选=${pool.length} 得分最高=${best.id}(${scored[0].score.toFixed(2)})`,
    alternatives: scored.slice(1, 4).map((s) => s.t.id),
  }
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

function score(t, m, fired = new Map()) {
  // 阶段贴合：正在经历的阶段优先（stage 越高越靠后，差 0.35/级）
  let s = 1 + (t.stage - 1) * 0.35
  // 正在这一阶段（t.stage === m.stage）额外加权——她还没走完的地方最有张力
  if (t.stage === m.stage) s += 0.5
  // 补 needs 缺口：她哪块最缺，就优先那个阶段的事件
  const gap = { 2: 1 - m.needs.autonomy, 3: 1 - m.needs.competence, 4: 1 - m.needs.relatedness }[t.stage]
  if (typeof gap === 'number') s += gap * 0.6
  // 一次性模板优先（先用掉新的）；可重复的按出场次数降权，别让它霸屏
  if (t.once) s += 0.15
  else s -= Math.min(0.45, 0.15 * Number(fired.get(t.id)?.count ?? 0))
  // 复读防护：这两天她刚在同一个话题上说过话，就别再逼她说一遍
  if (topicEcho(t, m)) s -= 0.6
  // 冷落中：重聚优先（这是唯一测依恋的机会，别被别的事挤掉）
  if (m.absenceDays >= 2 && t.id === 'absence_probe') s += 3
  return s
}

/** 有压力的处境：这几类事件最容易把她的疤再碰一次。 */
export const PRESSURE = new Set(['want_or_not', 'bottom_line', 'comeback', 'consistency', 'self_check'])

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

  if (Number(today.sent ?? 0) >= maxEvents) return { action: 'skip', why: `今日事件已满(${today.sent}/${maxEvents})` }
  if (Number(today.proactive ?? 0) >= maxProactive) return { action: 'skip', why: `今日主动唤醒已满(${today.proactive}/${maxProactive})` }

  const picked = pick(model, cfg, today, events, opts)
  if (!picked) return { action: 'quiet', why: '没有满足条件的事件模板（今天不打扰）' }
  return { action: 'wake', ...picked }
}
