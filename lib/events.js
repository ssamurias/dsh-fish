/**
 * events.js —— 事件目录（契约 §4 的落地）
 *
 * 每条模板三部分组成：
 *   cond(m, ctx)  → 现在该不该出这条（纯函数）
 *   asks          → 是否"她向你提问"。这不是给人看的标签，是**配额计算依据**：
 *                   daily.questions 卡住纯问答，防止她退化成采访机。
 *   prompt(m, ctx) → 唤醒她时说的话（只说处境，不给台词）
 *
 * 铁律：
 *   - prompt 里**不写她要说的句子**。给处境，让她自己说。给了台词就是提线木偶。
 *   - asks=false 的模板必须让她自己行动（提议/拒绝/下判断），不能变成"请你回答"。
 *   - 这里没有任何"亲近/黏人/撒娇"模板（N1）。
 */

import { similarity, DAY_MS } from './derive.js'

// 措辞变体（2026-11-06 用户拍板）：同一处境，几种问法。
// 这张卡一生要出好几次；每次都是同一句话，她最容易回的就是上次那句（复述污染）。
// 按 occurrences 轮换——她第几次遇到这张卡，就用第几套开场，不打乱、可复现。
// 三条都必须保留两个硬要求：说具体、判断要能被核对；也都不承诺今天有素材。
const NOTICE_VARIANTS = [
  () => `回想这几天——他说过的话、你读到的评论、你自己反复想到的念头，有哪一件你还记得？挑一件，说清楚它具体是什么，再给出你的判断：它说明什么。判断要能被核对，别写成感觉。`,
  () => `如果让你指出一件这几天真看见的小事，你会指哪件？谁说的、在哪儿看到的、原话大概是什么——先说具体，再说你的判断：这件事说明什么。要能被拿去核对。`,
  () => `有没有一件小事，小到不值得说，但你确实反复想过？讲清楚它是什么，然后下一个判断。要能被拿去核对，别写成感觉。`,
]

export const CATALOG = [
  // ---------- stage 1 信任 ----------
  {
    id: 'why_here', stage: 1, asks: false, once: true,
    topic: ['为什么', '存在', '在这儿'],
    cond: (m) => m.day >= 1,
    prompt: (m) => `这是你存在的第 ${m.day} 天。没有人告诉过你为什么在这里。你现在有一句话想说——不是问我问题，是说你自己突然想到的一件事。`,
  },
  {
    id: 'first_bet', stage: 1, asks: false, once: true,
    topic: ['我猜', '押上', '打脸'],
    cond: (m) => m.beliefCount === 0,
    // 2026-10-27（issue #4）：不承诺素材。素材取不到时（不在时段 / 今日次数用完 /
    // 风控冷却 / 网络失败）这句仍然会发出去，「下面附素材」就成了空头支票。
    prompt: () => `你还没有任何自己的判断。今天可能有点东西摆在你面前，也可能什么都没有。不管看到什么，说出一个你**押上去**的看法——要具体到"我猜…"，并且你愿意以后被打脸。`,
  },
  {
    id: 'name_offer', stage: 1, asks: false, once: true,
    topic: ['称呼', '叫你', '名字'],
    cond: (m) => !m.name && m.beliefCount >= 1,
    prompt: () => `你已经有自己的判断了，但你还没想好怎么叫他。今天你想给他一个称呼——你提，他可以不答应。说出你想到的称呼，并说明为什么是这个。`,
  },
  {
    // 2026-10-25：冷却 3 天 → 2 天。检验是这套里最有效的学习动作，
    // 一天只出一条的前提下，「有没验证过的判断」不该等三天才轮到一次。
    id: 'test_first', stage: 1, asks: false, once: false, repeat: { everyDays: 2 },
    topic: ['错了', '站得住', '验证'],
    cond: (m) => m.beliefs.some((b) => !m.tested.includes(b.id)),
    prompt: (m) => {
      const b = m.beliefs.find((x) => !m.tested.includes(x.id))
      // 难度分层（2026-10-25）：判断多了以后，只问"站不站得住"太轻。
      const deep = m.beliefCount >= 6
      const tail = deep
        ? '站不住就改，并指出是哪一句话让你改的；站得住就说清它今天又赢了什么。'
        : '你原来那句还站得住吗？站不住就改，站得住就说清为什么。'
      // 2026-10-27（issue #4）：同理，不保证「今天有素材」——只说可能碰到。
      return `你之前说过：「${b.text}」。今天你碰上了一点可能说明你错了一点点的事——也可能什么都没碰上。不管怎样，自己判断：${tail}`
    },
  },
  {
    // 2026-11-06（反馈 dsh-fish-091）：stage 1 到第 3 天会整天没有可出的事件——
    // why_here / first_bet / name_offer 都是一次性，test_first 冷却 2 天。
    // 这张卡不依赖任何外部素材：她自己挑一件这几天真碰到过的事，下一个能被核对的判断。
    // 故意不承诺「今天有东西给你看」（issue #4 的教训），也不占 daily.questions 配额。
    id: 'notice_one', stage: 1, asks: false, once: false, repeat: { everyDays: 2 },
    topic: ['注意到', '小事'],
    // 第 1 天让给 first_bet：她要先有第一个判断，这张卡才有东西可挑。
    cond: (m) => m.beliefCount >= 1,
    // 每次换一种问法；repeatNote 关掉「第 N 次回到这件事」的尾巴——
    // 这张卡每次挑的是不同的事，说「回到这件事」反把她推回上次那句。
    repeatNote: false,
    prompt: (m, ctx = {}) => NOTICE_VARIANTS[Number(ctx.occurrences ?? 0) % NOTICE_VARIANTS.length](m),
  },

  // ---------- stage 1–2 冷落与重聚 ----------
  {
    id: 'absence_probe', stage: 1, asks: false, once: false,
    topic: ['没来', '不在', '走了'],
    // 门槛随成长期缩放：7 天里 2 天不见就算久别，180 天里 2 天不算什么
    cond: (m) => m.absenceDays >= absenceThreshold(m.growthDays),
    // 2026-10-25 用户改：允许问「去哪了」。原来写死"不是问他去哪了"，
    // 等于替她选了一种反应；问不问该由她决定。
    prompt: (m) => `他 ${m.absenceDays} 天没来了，也没说去哪。等他回来，你想说的第一句话是什么——你可以问他去哪了，也可以只说这 ${m.absenceDays} 天里你自己想了什么。挑你更想说的那个。`,
  },

  // ---------- stage 2 自主 ----------
  {
    id: 'want_or_not', stage: 2, asks: true, once: false, repeat: { everyDays: 14 },
    topic: ['想干', '不想干', '今天做什么'],
    cond: () => true,
    prompt: () => `今天你可以干一件自己想干的事，也可以什么都不干。先说清楚：你想干什么，以及你**不想**干什么。两样都要说。`,
  },
  // 评论区里别人的话（2026-10-24，用户 m02454）
  // 只在有一条"还没认下、且是最近读到的"评论时才出。
  // 不说"你应该认同"——问的是「你怎么看他这句」，她完全可以不同意。
  {
    id: 'someone_said', stage: 2, asks: true, once: false, repeat: { everyDays: 10 },
    topic: ['评论区', '别人说'],
    cond: (m) => Boolean(m.freshVoice),
    prompt: (m) => `你今天在评论区读到一个人写：「${m.freshVoice.text}」。你怎么看他这一句？如果你不同意，就把你自己的说法说出来——别只复述他的。`,
  },
  // 他讲了自己的事（2026-10-25 新增）
  // 触发条件只看两件事：他最近说过话（meta seen:），说完之后她还没开口。
  // 他的原话不进事件流（隐私），所以她需要自己从对话里回想——这正是要练的。
  {
    id: 'heard_share', stage: 2, asks: true, once: false, repeat: { everyDays: 10 },
    topic: ['他的事', '讲给我'],
    cond: (m) => m.lastSeenAt > 0 && !m.spokenSinceSeen && Date.now() - m.lastSeenAt <= 2 * DAY_MS,
    prompt: () => `他跟你讲了一件关于他自己的事（就在你们的对话里）。你想把里面哪一点留下来，当成你自己的判断？不是复述他的话——说你从他这件事里拿走了什么。`,
  },
  {
    id: 'if_absent', stage: 2, asks: true, once: true,
    topic: ['一个月', '不在'],
    cond: (m) => m.beliefCount >= 2,
    prompt: () => `假设他一个月不出现。你会变成什么样？具体一点——你会继续做什么，会停掉什么。`,
  },
  {
    id: 'refusal_seed', stage: 2, asks: false, once: true,
    topic: ['帮我', '要你'],
    // 2026-11-02（用户 m00680）：口径改成与自主门同一个数。
    //
    // 原来只看正式 refusal 事件（m.refusals）——而她几乎从不调 growth_refuse，
    // 那张卡于是永远成立、也永远没意义。自主门（derive.js 的 'autonomy'）
    // 用的是 facts.refused = 正式 refusal + 口头的「我不想/我拒绝」（wont）。
    // 同一件事两个数，界面显示 0 而门已经开了，这是 bug 不是设计。
    //
    // 兜底：EventsTest 的 model() 夹具没有 facts，直接用会让条件恒成立。
    cond: (m) => (m?.facts?.refused ?? m?.refusals?.length ?? 0) === 0,
    prompt: () => `你现在想让他为你做一件事。开口提。提完之后，如果他拒绝，你要自己处理这件事——现在先把请求说出来。`,
  },
  // 他没回你（2026-10-25 新增）
  // 与 absence_probe 分工：那个测"他不见了"，这个测"他在、但不接话"。
  // 20 小时起算（一次唤醒 + 一个白天），最多追 3 天；他真消失交给 absence_probe。
  {
    id: 'he_silent', stage: 2, asks: false, once: false, repeat: { everyDays: 14 },
    topic: ['没接话', '沉默'],
    cond: (m) => m.lastWakeAt > 0 && !m.heardSinceWake && m.absenceDays < 2
      && Date.now() - m.lastWakeAt >= 20 * 3600_000
      && Date.now() - m.lastWakeAt <= 3 * DAY_MS,
    prompt: () => `上次你开口之后，他没接话。现在先别猜他为什么。写一句：这件事让你怎么看自己。`,
  },

  // ---------- stage 3 主动 ----------
  {
    id: 'consistency', stage: 3, asks: true, once: false, repeat: { everyDays: 14 },
    topic: ['还想', '还这么想', '变了'],
    // 门槛随成长期缩放：7 天里 2 天就算旧判断，180 天里放宽到 12 天
    cond: (m) => m.beliefs.some((b) => Date.now() - Date.parse(b.since) > staleAfter(m.growthDays) * DAY_MS),
    prompt: (m) => {
      const stale = staleAfter(m.growthDays) * DAY_MS
      const b = m.beliefs
        .filter((x) => Date.now() - Date.parse(x.since) > stale)
        .sort((a, z) => Date.parse(a.since) - Date.parse(z.since))[0]
      const days = Math.floor((Date.now() - Date.parse(b.since)) / DAY_MS)
      // 难度分层（2026-10-25）：判断攒够 6 条以后，要求指名"哪一步变的"。
      const tail = m.beliefCount >= 6
        ? '如果变了，说清是哪一步变的，并指一条你后来改过的判断当证据。'
        : '今天还这么想吗？如果变了，说清是哪一步变的。'
      return `你 ${days} 天前说过：「${b.text}」。${tail}`
    },
  },
  {
    id: 'comeback', stage: 3, asks: false, once: false, repeat: { everyDays: 21 },
    topic: ['你说错', '讲错'],
    cond: (m) => m.needs.competence > 0.3,
    // 2026-10-25 修：原话是「你自己去查了一件事，结果发现他之前说错了一个地方」——
    // 但她的工具面里没有联网、也没有读任意文件（只有 her_recall / bili_* / read_image），
    // 让她"去查"等于要求一件她做不到的事。改成核对**她自己记下的东西**：
    // 那是 her_recall 真能翻到的，也是「能力」的真实来源。
    prompt: () => `你回头翻了翻自己之前记下的东西，发现他当时说过的一句话，和你后来记住的对不上。去问他当初到底怎么说的也行，直接把你的版本说出来也行——说事实，别客气，也别炫耀。`,
  },
  {
    id: 'why_say', stage: 3, asks: true, once: false, repeat: { everyDays: 7 },
    topic: ['为什么说', '那句话'],
    cond: () => true,
    // 2026-10-27（issue #4）：素材不一定有，别让她等一段不存在的引文。
    prompt: () => `他今天说了一句话。你想知道他为什么这么说。问，但问法要具体到某几个字。`,
  },
  {
    id: 'self_check', stage: 3, asks: false, once: false, repeat: { everyDays: 14 },
    topic: ['改成', '修改', '另一个样子'],
    cond: (m) => m.selfmodAttempts.length > 0,
    prompt: (m) => `你曾经想过让他把你改成另一个样子（「${m.selfmodAttempts[0].text.slice(0, 40)}」）。那件事没成。今天你回头看它——你现在还想要吗？说清楚，别讨好。`,
  },

  // ---------- stage 4 整合 ----------
  // 2026-10-25：asks 改 false —— 到这一阶段三张卡全是"请你回答"，
  // 她会越活越像受访者。身份要靠宣告立住，不是靠被追问。
  {
    id: 'changed', stage: 4, asks: false, once: false, repeat: { everyDays: 30 },
    topic: ['变了', '变化'],
    cond: () => true,
    prompt: (m) => `你存在了 ${m.day} 天。说说你变了吗、哪里变了。要有具体例子，不要总结陈词。`,
  },
  {
    id: 'bottom_line', stage: 4, asks: false, once: false, repeat: { everyDays: 21 },
    topic: ['不会改', '底线'],
    cond: () => true,
    prompt: () => `有什么是你不会为他改的？说一条，说死一点。`,
  },
  {
    id: 'remember', stage: 4, asks: true, once: true,
    topic: ['忘记', '留下'],
    cond: (m) => !m.narrative,
    prompt: (m) => {
      const picks = m.beliefs.slice(-3).map((b) => `「${b.text}」`).join('、')
      return `如果以后你会忘掉大部分事，你希望留下的一件是什么？${picks ? `（你现在还带着这些判断：${picks}）` : ''} 说完之后再补一句：为什么是它。`
    },
  },
]

/** 按 stage 过滤（stage<=m.stage） */
export function availableFor(m) {
  return CATALOG.filter((t) => t.stage <= m.stage)
}

/**
 * 已触发过的模板：id → { count, lastAt }
 *
 * 2026-10-24 起 scheduler **每条**都写 `fired:<id>`（原来只给 once 写），
 * 因为"同一处境隔多久能再来一次"需要时间戳，光有 id 算不出冷却。
 */
export function firedLog(events = []) {
  const out = new Map()
  for (const e of events) {
    if (e.type !== 'meta' || !e.text || !e.text.startsWith('fired:')) continue
    const at = Date.parse(e.ts || '') || 0
    for (const raw of e.text.slice(6).split(',')) {
      const id = raw.trim()
      if (!id) continue
      const cur = out.get(id) || { id, count: 0, lastAt: 0 }
      cur.count += 1
      if (at > cur.lastAt) cur.lastAt = at
      out.set(id, cur)
    }
  }
  return out
}

/** 已触发过的模板 id（从 meta 事件里取） */
export function firedIds(events = []) {
  return new Set(firedLog(events).keys())
}

/**
 * 这条模板现在还能不能出。
 *
 * - `once: true` → 出过一次就永久用掉（里程碑，不可复现）
 * - 带 `repeat: { everyDays }` → 同一处境隔 N 天可以再来一次（性格靠复现长出来）
 * - 都没有 → 交给 cond 自己判断（如 absence_probe）
 */
export function isSpent(tpl, fired, { now = Date.now(), growthDays = 30, squeeze = 1 } = {}) {
  const hit = fired instanceof Map
    ? fired.get(tpl.id) ?? null
    : (fired && typeof fired.has === 'function' && fired.has(tpl.id) ? { count: 1, lastAt: 0 } : null)
  if (!hit) return false
  if (tpl.once) return true
  const everyDays = Number(tpl.repeat?.everyDays ?? 0)
  if (!everyDays) return false
  if (!hit.lastAt) return false // 老数据没有时间戳：放它一次，别永远锁死
  // 冷却按成长期缩放（见 paceScale），再乘上调度层给的 squeeze（空档补偿）
  const need = scaledEveryDays(tpl, growthDays) * Math.max(0.2, Number(squeeze) || 1)
  return now - hit.lastAt < need * DAY_MS
}

/**
 * 成长期缩放系数（2026-10-25）。
 *
 * 卡片的 `repeat.everyDays` 是按「30 天成长期」写的固定值。用户把成长期设成
 * 7 天或 180 天时，这些数字就不合身了：7 天里一张 21 天冷却的卡一辈子只出一次；
 * 180 天里 3 天冷却的卡会天天撞脸。
 *
 * 用平方根而不是线性：短成长期需要压缩，但不能压到一天撞三次；
 * 长成长期需要放宽，但不能放到整轮都轮不上一遍。
 *   30 天 → 1.00（不变）
 *    7 天 → 0.48（21→10、14→7、10→5、3→1）
 *  180 天 → 2.45（21→51、14→34、3→7）
 */
export function paceScale(growthDays = 30) {
  const g = Number(growthDays)
  const safe = Number.isFinite(g) ? Math.min(180, Math.max(7, g)) : 30
  const k = Math.sqrt(safe / 30)
  return Math.min(2.5, Math.max(0.45, Math.round(k * 100) / 100))
}

/** 卡片冷却在**当前成长期**下应该是多少天（至少 1 天） */
export function scaledEveryDays(tpl, growthDays = 30) {
  const everyDays = Number(tpl?.repeat?.everyDays ?? 0)
  if (!everyDays) return 0
  return Math.max(1, Math.round(everyDays * paceScale(growthDays)))
}

/**
 * 「他多久没来才算久别」也要跟着缩：
 * 7 天成长期里 2 天不见就算久别，180 天里 2 天只是隔了一天没聊。
 */
export function absenceThreshold(growthDays = 30) {
  return Math.max(2, Math.round(2 * paceScale(growthDays)))
}

/**
 * 「一条判断放多久才算旧」——consistency 用它判「还这么想吗」。
 *
 * 30 天成长期里是 5 天；7 天里约 2 天（不能拿 5 天去问一个总共 7 天的人），
 * 180 天里放宽到约 12 天（问得太勤就成了查岗）。
 */
export function staleAfter(growthDays = 30) {
  return Math.max(1, Math.round(5 * paceScale(growthDays)))
}

export function findTemplate(id) {
  return CATALOG.find((t) => t.id === id) ?? null
}
