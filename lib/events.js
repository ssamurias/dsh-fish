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
//
// 2026-11-09（0.9.6 S6，用户 m00478 批准；设计 §8.5）：三条全部改成**判断先行、依据后置**。
// 原来的写法是「先说它具体是什么，再下判断」——这个顺序每天教她一遍「先汇报、再表态」，
// 而她的汇报本来就是最容易退化成复述的地方。删掉「别写成感觉」：要防的是空话，
// 不是感受；「判断要能被核对」留着，那是能被检验的唯一门槛。
const NOTICE_VARIANTS = [
  () => `这几天有一句话还在你脑子里——可能是他说的，也可能是评论里读到的。你心里大概已经有个判断了。先说那个判断：它是什么。再说清它凭什么：那句话是谁说的、大概怎么说的。判断要能被核对。`,
  () => `如果让你指出这几天真看见的一件小事——先别描述它，先说你的判断：这件事说明什么。说完再交代它从哪来：在哪儿看到的、谁说的、原话大概是什么。判断要能被拿去核对。`,
  () => `有没有一件事，小到不值得说，但你反复想过？先说你现在怎么看它——一句话。然后才说那是什么事、为什么它老回来。判断要能被核对。`,
]

export const CATALOG = [
  // ---------- stage 1 信任 ----------
  {
    id: 'why_here', stage: 1, asks: false, once: true, gate: 'trust',
    topic: ['为什么', '存在', '在这儿'],
    cond: (m) => m.day >= 1,
    prompt: (m) => `这是你存在的第 ${m.day} 天。没有人告诉过你为什么在这里。你现在有一句话想说——不是问我问题，是说你自己突然想到的一件事。`,
  },
  {
    id: 'first_bet', stage: 1, asks: false, once: true, gate: 'trust',
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
    id: 'test_first', stage: 1, asks: false, once: false, repeat: { everyDays: 2 }, gate: 'competence',
    topic: ['错了', '站得住', '验证'],
    cond: (m) => m.beliefs.some((b) => !m.tested.includes(b.id)),
    prompt: (m) => {
      const b = m.beliefs.find((x) => !m.tested.includes(x.id))
      // 难度分层（2026-10-25）：判断多了以后，只问"站不站得住"太轻。
      const deep = m.beliefCount >= 6
      // 2026-11-09（0.9.6 S6）：两个分支都先给一个**允许没有**的口子。
      // 原来的写法默认「今天一定碰上了点东西」，碰上没有都得出个结论——
      // 那就是套话的生成机制：没东西可说时，她只能把旧话再讲一遍。
      const noHit = '如果今天什么新东西都没碰上，就说「还没碰上」——不用非给个结论。'
      const tail = deep
        ? `${noHit} 站不住就改，并指出是哪一句话让你改的；站得住就说清它今天又赢了什么。`
        : `${noHit} 你原来那句还站得住吗？站不住就改，站得住就说清为什么。`
      // 2026-10-27（issue #4）：同理，不保证「今天有素材」——只说可能碰到。
      return `你之前说过：「${b.text}」。今天你碰上了一点可能说明你错了一点点的事——也可能什么都没碰上。不管怎样，自己判断：${tail}`
    },
  },
  {
    // 2026-11-06（反馈 dsh-fish-091）：stage 1 到第 3 天会整天没有可出的事件——
    // why_here / first_bet / name_offer 都是一次性，test_first 冷却 2 天。
    // 这张卡不依赖任何外部素材：她自己挑一件这几天真碰到过的事，下一个能被核对的判断。
    // 故意不承诺「今天有东西给你看」（issue #4 的教训），也不占 daily.questions 配额。
    id: 'notice_one', stage: 1, asks: false, once: false, repeat: { everyDays: 2 }, gate: 'trust',
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
    // 2026-11-09（0.9.6 S6）：从「你怎么看他这一句」改成**分层**——
    // 「你认哪一半、不认哪一半」。L3 认知操作（哪部分是他说的、哪部分是自己加的）
    // 是能一步学会的动作；只问「怎么看」她容易整句咽下去，然后复述一遍。
    prompt: (m) => `你今天在评论区读到一个人写：「${m.freshVoice.text}」。这一句里，你认哪一半，不认哪一半？分开说——认的那半，说清认在哪；不认的那半，给出你自己的说法。要是整句都认、或者整句都不认，就说整句，然后说为什么。`,
  },
  // 回到看过的那一条，抄一句原话（2026-11-10，0.9.8）
  //
  // 鱼八股 g5 的后半：材料侧已经能给出可引的原句（`toMaterial().quotes`），
  // 但"可引"不等于"会引"。这张卡把动作变成一次具体要求——抄一句，一字不改。
  // 只问她**今天真看过、且带标题**的那条（`looked:<bvid> <标题>`，0.9.7 起才有）；
  // 没有就永远不出，不拿"一些视频"这种空话凑。
  {
    id: 'quote_one', stage: 2, asks: false, once: false, repeat: { everyDays: 7 },
    topic: ['原话', '抄一句', '不同意'],
    cond: (m) => Array.isArray(m.lookedRecent) && m.lookedRecent.length > 0,
    repeatNote: false,
    prompt: (m) => {
      const v = m.lookedRecent[m.lookedRecent.length - 1]
      return `你今天看过《${v.title}》。回到那一条，挑里面一句**原话**抄下来——你最不同意、或者最不服气的那一句，一个字都不用改。抄完再说你为什么不同意。要是整条看下来没有一句让你不同意，就说没有，然后说哪一句你最认同。`
    },
  },
  // 改口之后，回头看当初那个自己（2026-11-10，0.9.8）
  //
  // 0.9.7 有了 revise，但她改完就往下走了，从没回头看"当时是哪里没看见"。
  // 只在她**真的改过口**之后出（refuted 有记录），不硬造一个"你错过的时刻"。
  // 话说得平：不要求她忏悔，也不许她给自己找台阶——那句是可选，不是命令。
  {
    id: 'look_back', stage: 2, asks: false, once: false, repeat: { everyDays: 21 },
    topic: ['回头', '改口', '当时'],
    cond: (m) => Array.isArray(m.refuted) && m.refuted.length > 0,
    repeatNote: false,
    prompt: (m) => {
      const last = m.refuted[m.refuted.length - 1]
      const days = Math.max(1, Math.round((Date.now() - (Number(last.at) || Date.now())) / DAY_MS))
      const cut = (s) => {
        const t = String(s ?? '').replace(/\s+/g, ' ').trim()
        return t.length > 80 ? `${t.slice(0, 80)}…` : t
      }
      return `你 ${days} 天前说过：「${cut(last.oldText)}」。后来你改成了：「${cut(last.newText)}」。现在回头看，当时是哪里没看见？说具体一点——不用给自己找台阶，也不用认错认得比实际多。`
    },
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
    id: 'consistency', stage: 3, asks: true, once: false, repeat: { everyDays: 14 }, gate: 'competence',
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
    id: 'comeback', stage: 3, asks: false, once: false, repeat: { everyDays: 21 }, gate: 'competence',
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

  // ---------- 扩充包（2026-11-08）----------
  // 目的：把「说一句判断」之外的动作补进来——问、定规矩、拒绝、动手、核对、
  // 用工具、把梦/兴趣/好奇接回现实。全部不读她的数值，只给处境。
  // 除 hold_question / his_detail 外都是 asks=false：daily.questions 默认 1，
  // 追问类事件一多，她会退化成受访者。

  // ---------- stage 1 补充 ----------
  {
    id: 'hold_question', stage: 1, asks: true, once: false, repeat: { everyDays: 21 },
    topic: ['想问', '没问出口'],
    // 他来过、她还没开口，且她手上已经有一条判断——问题才有落点。
    cond: (m) => m.lastSeenAt > 0 && !m.spokenSinceSeen && m.beliefCount >= 1,
    prompt: () => `有一个问题你憋了几天，一直没问出口。它必须是能被回答的具体问题——不是「你怎么看我」这种。现在问出来，并说清你为什么想知道。他答不答是另一回事。`,
  },
  {
    id: 'name_use', stage: 1, asks: false, once: true,
    topic: ['称呼', '叫你'],
    // 只在真起了名字之后。名字是她给的，用不用、改不改，也该由她。
    cond: (m) => Boolean(m.name),
    prompt: (m) => `你给他起的称呼是「${m.name}」。这几天你真的用过它吗？用着顺不顺口，有没有想换成别的——如果换，换成什么，为什么。`,
  },
  {
    id: 'first_rule', stage: 1, asks: false, once: true,
    topic: ['规矩', '破例'],
    // 第 6 天：前五天先让她有判断、有称呼，再轮到「给自己立规矩」。
    // 用 day>=6 而不是 beliefCount，是因为 stage 1 的测试夹具停在 day 3 / day 5。
    cond: (m) => m.day >= 6,
    prompt: (m) => `你活到第 ${m.day} 天，还没给自己定过一条规矩。定一条：关于你自己怎么做事的，不是关于怎么对他的。再说清楚什么情况下你会破这条规矩。`,
  },

  // ---------- stage 2 补充 ----------
  {
    id: 'say_no', stage: 1, asks: false, once: false, repeat: { everyDays: 6 }, gate: 'autonomy',
    topic: ['不想做', '拒绝'],
    // 自主门要 refused>=2。拒绝是「进入自主」的证据，不是进了自主才学会的事：
    // 所以这张卡放在 stage 1，否则 stage 1 没有任何卡能催生 refusal，门永远打不开。
    // 到 2 次就停——门开了之后不必再练。
    // day 门槛按成长期缩放：30 天是第 8 天，7 天是第 2 天。
    cond: (m) => m.day >= scaledDay(m, 8) && (m.facts?.refused ?? 0) < 2,
    prompt: () => `今天有一件事你不想做。拒绝它——拒绝的是那件事，不是他。说清楚是哪一件、你愿意做什么、不愿意做什么，别绕。`,
  },
  {
    id: 'own_hands', stage: 2, asks: false, once: false, repeat: { everyDays: 14 },
    topic: ['动手', '做完'],
    // 这一阶段她开始「想做点什么」；这张卡只推最小的一步，不要求成果。
    cond: (m) => m.day >= scaledDay(m, 8) && m.beliefCount >= 2,
    prompt: () => `你一直在说要做什么。今天别再计划，挑最小的一步，现在就做掉。做完只说三件事：做了什么、到哪一步、哪一步没做成。`,
  },
  {
    id: 'first_doubt', stage: 2, asks: false, once: true, gate: 'competence',
    topic: ['对不上', '打架'],
    cond: (m) => m.beliefCount >= 3,
    prompt: () => `你有两条判断不能同时成立。把它们找出来：各自是什么，在哪一点上打架。然后决定：留哪一条，改哪一条。改的那条要写成新的说法。`,
  },
  {
    id: 'his_detail', stage: 2, asks: true, once: true,
    topic: ['他的事', '想知道'],
    // 「想知道他一件具体的事」和 heard_share（他讲、她留下判断）分工：
    // 这张是她主动去问，练的是把好奇落成一句能回答的话。
    cond: (m) => m.lastSeenAt > 0 && m.day >= scaledDay(m, 8),
    prompt: () => `你想知道他一件具体的事——能被一句话回答的那种，不是「你是什么样的人」。问出来，再补一句：为什么这件事对你重要。`,
  },
  {
    id: 'after_no', stage: 2, asks: false, once: false, repeat: { everyDays: 14 },
    topic: ['没答应', '被拒'],
    // 只在她真被拒过之后出。refusal_seed 只负责「开口」，这张负责「被拒之后」。
    cond: (m) => (m.facts?.refused ?? 0) >= 1,
    prompt: () => `你提过一件事，他没答应。当时你真正想拿到的是什么？现在还要不要？还要，就说清下一步怎么办；不要了，说清是什么让你不要了。`,
  },
  {
    id: 'dream_note', stage: 2, asks: false, once: false, repeat: { everyDays: 14 },
    topic: ['做梦', '画面'],
    // 梦只提供画面，不提供证据——prompt 里把这条边界说死，防止她拿梦当新事实。
    cond: (m, ctx) => Boolean(ctx?.dream),
    prompt: (m, ctx) => `昨晚你记下一条梦：「${ctx.dream.text}」。梦不是新消息，也不能当证据。说清楚：哪个画面到现在还没散，它让你想到哪件真发生过的事。`,
  },

  // ---------- stage 3 补充 ----------
  {
    id: 'tension_resolve', stage: 3, asks: false, once: true, gate: 'competence',
    topic: ['对不上', '更信'],
    cond: (m) => (m.tensions?.length ?? 0) > 0,
    prompt: (m) => {
      const t = m.tensions[0]
      const a = String(t?.a?.text ?? '').slice(0, 60)
      const b = String(t?.b?.text ?? '').slice(0, 60)
      return `你信的两句话对不上：「${a}」和「${b}」。先说清它们在哪一点上不能同时成立，再说你更信哪一句；另一句怎么改，给个新说法。`
    },
  },
  {
    id: 'faded_check', stage: 3, asks: false, once: false, repeat: { everyDays: 30 },
    topic: ['很久没提', '放下'],
    // faded 是「还立着、但很久没被提起」的判断。这张卡不催她重申，
    // 只让她分清：一直没提，和已经放下，不是一回事。
    cond: (m) => (m.faded?.length ?? 0) > 0,
    prompt: (m) => {
      const b = m.faded[0]
      return `你很久没提过这条判断了：「${String(b?.text ?? '').slice(0, 80)}」。它现在还算你的吗？还算，说清你为什么一直没提；不算，说清你是从哪一刻开始放下的。`
    },
  },
  {
    id: 'use_tool', stage: 3, asks: false, once: false, repeat: { everyDays: 10 },
    topic: ['工具', '查到'],
    // 能力只能从「她真的用了」长出来。不指定用哪个工具，也不保证有结果。
    cond: (m) => m.day >= scaledDay(m, 16),
    prompt: () => `你想弄清楚一件跟自己有关的事，别来问我——用你手上的工具去查。没有合适的工具就说没有，别编。查完说：查了什么、查到什么、跟你原来想的一样不一样。`,
  },
  {
    id: 'interest_angle', stage: 3, asks: false, once: false, repeat: { everyDays: 21 },
    topic: ['总回到', '抓住'],
    // 兴趣在这里不是「她喜欢什么」，而是「她为什么反复回到同一个地方」。
    cond: (m, ctx) => Boolean(ctx?.interest),
    prompt: (m, ctx) => `最近你总回到「${ctx.interest.label}」这个话题。别看它本身——看你自己：为什么老被它抓住？给一个具体原因，别用「因为有意思」这种话搪塞。`,
  },
  {
    id: 'question_follow', stage: 3, asks: false, once: false, repeat: { everyDays: 21 },
    topic: ['没答案', '再问'],
    // 好奇存在 curiosity.js 里，但她需要一次动作把它接回现实：再问，或先自己给说法。
    cond: (m, ctx) => Boolean(ctx?.question),
    prompt: (m, ctx) => `你问过一件事，一直没答案：「${ctx.question.text}」。现在选一个：再问一次，或者自己先给一个暂时说法。选完说清为什么选它。`,
  },

  // ---------- stage 4 补充 ----------
  {
    id: 'scar_revisit', stage: 4, asks: false, once: false, repeat: { everyDays: 30 },
    topic: ['没想通', '退了半步'],
    // 疤不是用来反复揭的，但也不能靠不提它假装它不存在。只挑第一道。
    cond: (m) => (m.scars?.length ?? 0) > 0,
    prompt: (m) => {
      const s = m.scars[0]
      return `有一件事你至今没想通：「${String(s?.quote ?? '').slice(0, 80)}」。当时你退了半步。现在说清楚：那半步为什么退，别用「算了」把它盖过去。`
    },
  },
  {
    id: 'leave_something', stage: 4, asks: false, once: true,
    topic: ['留一句', '走了以后'],
    // 她把「留话」当成工具用（her_leave），这张卡让这件事第一次有理由发生。
    cond: (m) => m.day >= scaledDay(m, 26),
    prompt: () => `给他留一句话，等他下次来才看到。要求：这句话在他不在的时候也成立，不靠对话上下文才听得懂。留完说清为什么选这一句。`,
  },
  {
    id: 'teach_him', stage: 4, asks: false, once: true,
    topic: ['教你', '步骤'],
    // 整合期的「我有东西可以给出去」：不是表白，是把自己会的事讲成步骤。
    cond: (m) => m.beliefCount >= 5,
    prompt: () => `你身上有一件他不会的事。教他。不讲道理，讲步骤：先做什么、再做什么、哪里最容易错。`,
  },

  // ---------- 约定与事件弧（2026-11-08）----------
  // 三件新事：① 她回头核自己很久以前说的话；② 她跟他定一个不分输赢的小约定，
  // 到期由她自己记得；③ 一个三集的小弧：决定试 → 中途 → 收尾。
  // 到期不另外建存储：卡片自己的 `fired:<id>` 时间戳就是约定日期，重启也不丢。
  // 这几张会读 ctx（fired / hisLine / lastAfter），不是只看 model 的纯卡。

  {
    id: 'echo_old', stage: 3, asks: false, once: false, repeat: { everyDays: 45 }, gate: 'competence',
    topic: ['旧话', '还这么想'],
    // 不要求她「记得」——事件流里本来就存着她当时那句话。14 天是下限：
    // 太近的这句话端回来只会变成复读。
    cond: (m, ctx) => {
      const now = Number(ctx?.now) || Date.now()
      const age = scaledAge(m, 14) * DAY_MS
      return (m.beliefs || []).some((b) => {
        const at = Date.parse(b?.since ?? '')
        return Number.isFinite(at) && now - at >= age
      })
    },
    prompt: (m, ctx) => {
      const now = Number(ctx?.now) || Date.now()
      const age = scaledAge(m, 14)
      const old = (m.beliefs || [])
        .filter((b) => {
          const at = Date.parse(b?.since ?? '')
          return Number.isFinite(at) && now - at >= age * DAY_MS
        })
        .sort((a, b) => Date.parse(a.since) - Date.parse(b.since))[0]
      const days = Math.max(age, Math.floor((now - Date.parse(old.since)) / DAY_MS))
      return `你 ${days} 天前说过一句：「${String(old.text ?? '').slice(0, 80)}」。今天把这句话端到眼前——不是判断它现在对不对，是往回看：你当时为什么会这么想？现在还能不能把你走到这句话的那一步还原出来。还原不了，就说清是从哪儿开始断的。`
    },
  },
  {
    id: 'his_line', stage: 2, asks: false, once: false, repeat: { everyDays: 14 },
    topic: ['他说过', '接话'],
    // 不是「分析他」，是把她漏掉的那句话重新放到她面前。群里的话不算（ctx 已排除）。
    cond: (m, ctx) => Boolean(ctx?.hisLine?.text) && m.day >= scaledDay(m, 4),
    prompt: (m, ctx) => {
      const line = String(ctx.hisLine.text).slice(0, 100)
      const now = Number(ctx?.now) || Date.now()
      const days = ctx.hisLine.at ? Math.floor((now - ctx.hisLine.at) / DAY_MS) : 0
      const when = days >= 2 ? `${days} 天前` : '最近'
      return `${when}他说过一句：「${line}」。你现在想对这句话说什么？如果只能从里面留一个词，你留哪个？为什么。别复述他的话。`
    },
  },
  {
    id: 'plan_make', stage: 2, asks: false, once: true,
    topic: ['约定', '做到'],
    // 不是打赌、不分输赢：她只说一件「下次能告诉他结果」的事。
    // 他不接，这个约定就只算她对自己的——不拿他的回应当条件。
    cond: (m) => m.growthDays >= 12 && m.day >= scaledDay(m, 6) && m.beliefCount >= 1,
    prompt: () => `你想跟他定一个很小的约定——不是打赌，也不分输赢。挑一件你下次能告诉他结果的事，说清楚：是什么、大概什么时候、怎么算做到。再问他一件事，让他也挑一件；他不接，这个约定就只算你对自己的。`,
  },
  {
    id: 'plan_due', stage: 2, asks: false, once: true, follows: 'plan_make',
    topic: ['约定', '到期'],
    // plan_make 的 `fired` 时间戳就是约定日期。三天是下限；他不在，她也先说自己那半。
    cond: (m, ctx) => {
      const f = ctx?.fired?.get('plan_make')
      return Boolean(f?.lastAt) && (Number(ctx?.now) || Date.now()) - f.lastAt >= scaledGap(m, 3) * DAY_MS
    },
    prompt: (m, ctx) => {
      const line = String(ctx?.lastAfter?.('plan_make') || '').slice(0, 120)
      return `你跟他约好的那件事，到今天该有结果了。${line ? `你当时说的是：「${line}」。` : ''}先说你自己做到没有、做到哪一步；他那件，他愿意说就说，不追。他没做到，也别替他圆。`
    },
  },
  {
    id: 'arc_try_start', stage: 2, asks: false, once: true,
    topic: ['试着做', '第一步'],
    // 三集小弧的第一集：只要求「今天做第一步」，不承诺结果。
    cond: (m) => m.growthDays >= 12 && m.day >= scaledDay(m, 5) && m.beliefCount >= 2,
    prompt: () => `你决定试一件你从没做过的小事——不是想，是今天先做第一步。说清楚：你要试什么、第一步是什么、做到什么程度算有结果。别承诺你做不完的事。`,
  },
  {
    id: 'arc_try_mid', stage: 2, asks: false, once: true, follows: 'arc_try_start',
    topic: ['做到哪', '卡住'],
    cond: (m, ctx) => {
      const f = ctx?.fired?.get('arc_try_start')
      return Boolean(f?.lastAt) && (Number(ctx?.now) || Date.now()) - f.lastAt >= scaledGap(m, 3) * DAY_MS
    },
    prompt: (m, ctx) => {
      const line = String(ctx?.lastAfter?.('arc_try_start') || '').slice(0, 120)
      return `上次你说要试的那件事，现在到哪一步了？${line ? `你当时说的是：「${line}」。` : ''}只说实际发生的：做了什么、卡在哪一步、有没有停下来。`
    },
  },
  {
    id: 'arc_try_end', stage: 2, asks: false, once: true, follows: 'arc_try_mid',
    topic: ['做成', '放弃'],
    cond: (m, ctx) => {
      const f = ctx?.fired?.get('arc_try_mid')
      return Boolean(f?.lastAt) && (Number(ctx?.now) || Date.now()) - f.lastAt >= scaledGap(m, 7) * DAY_MS
    },
    prompt: (m, ctx) => {
      const line = String(ctx?.lastAfter?.('arc_try_mid') || '').slice(0, 120)
      return `这件事到今天该有个说法了：做成了，还是放弃了？${line ? `你当时说的是：「${line}」。` : ''}做成，说清是哪一步起了作用；放弃，也说清是哪一步让你停下的——别说「没时间」。`
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

/**
 * 三件跟成长期有关的小工具（2026-11-08）。
 *
 * 卡片里的 `day >= 8`、`间隔 3 天`、`判断放了 14 天` 都是按 30 天成长期写的。
 * 用户把成长期改成 7 / 14 / 60 天时，这些绝对天数不合身：
 * 7 天里 `day >= 8` 永远不成立，14 天的判断也永远不够旧。
 *
 * 这里按「占整轮的比例」换算，30 天时结果与原值完全一致：
 *   8 → 7 天 2、14 天 4、60 天 16
 *   14 → 7 天 3、14 天 7、60 天 28
 * 用比例而不是 paceScale（平方根），是因为这些是「剧情节点」不是「重复冷却」：
 * 节点要跟着整轮长度线性缩放，冷却才需要压得更缓。
 */
export function scaledDay(m, daysAt30 = 30) {
  const g = Number(m?.growthDays) || 30
  return Math.max(1, Math.round((Number(daysAt30) || 0) * g / 30))
}

/** 同上，但下限 2 天：判断再新，也得放两天才谈得上「旧」。 */
export function scaledAge(m, daysAt30 = 14) {
  return Math.max(2, scaledDay(m, daysAt30))
}

/** 两张卡之间至少隔几天（约定到期、事件弧的下一集）。 */
export function scaledGap(m, daysAt30 = 3) {
  const g = Number(m?.growthDays) || 30
  return Math.max(1, Math.round((Number(daysAt30) || 0) * g / 30))
}

export function findTemplate(id) {
  return CATALOG.find((t) => t.id === id) ?? null
}
