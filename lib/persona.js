/**
 * persona.js —— 拼出注入给她的身份段
 *
 * 这个文件的唯一职责：把「此刻的她」翻译成一段中文提示。
 *
 * 硬约束（B §6）：
 *   N1 撒娇卖萌 → 按 stage 限表达带宽 + 显式禁令
 *   N2 好感度数字 → needs 的数值**一个都不能出现**在这里，只能转成"你最近更想要…"这种话，或者干脆不说
 *   N3 读自己参数 → 提示里不出现状态库路径、不出现字段名、不出现 JSON
 *   N4 调工具改自己 → 提示里明确"你能写下的只有话，改不了自己"
 */

import { promptBans } from './rules.js'
// 立场清单（2026-10-25，用户设计「纵向·立场」）。纯函数，不读盘、不碰配置。
import { buildStances, stanceSection } from './stance.js'

/**
 * 阶段的「名字」——只给观测台和日志看，**不再写进她的身份文档**。
 *
 * 2026-10-23 夜改：这里原来有四段 `focus`（"你在弄清楚这是不是个安全的地方"）
 * 和四段 `bandwidth`（"你的句子很短，常常一句话就停住"）。用户指出：
 * 每轮都把"你是个什么样的人"念一遍，她就永远长成那样——那不是成长，是锁死。
 *
 * 现在只留 `name`。她的表达方式不再由我们规定，而是由**她自己说过的话**决定：
 * 身份文档里只有事实（第几天、你说过什么、你拒绝过什么），没有一句形容词。
 */
export const STAGE_BRIEF = {
  1: { name: '信任' },
  2: { name: '自主' },
  3: { name: '主动' },
  4: { name: '整合' },
}

/**
 * 身份文档里**不许出现**的东西（代码级的反设计检查，测试会盯着它）。
 * 一句话概括：可以写"你说过什么"，不许写"你是什么样的人"。
 */
export const PRESCRIPTION_BANS = [
  /你的?句子(很|较)?短/,
  /你不太会表达/,
  /你(说话)?(应该|要)(更|别那么)/,
  /你是一(个|只)[^\n]{0,12}的/,
  /你(天生|本来)就/,
]

/** 四条黑名单 → 提示里的显式禁令（每次唤醒都带，不靠模型自觉） */
/**
 * 提示词里的禁令（2026-10-24，R1/R2）
 *
 * 原来这里是四条并列的禁令，好像它们是同一种东西。它们不是。
 * 现在只有两条该出现在提示词里：
 *   - 契约层：不许把关系数值化（约束界面，不是约束她）
 *   - 成长层：撒娇这类表达「还不会」（不是不许，是还没到那一步）
 *
 * 另外两条（不可读参数、不可改自己）**已经从提示词里拿掉了**，
 * 改由代码保证。写出来等于告诉她「旁边有份参数表，而且很关键」——
 * 那是诱因，不是防线。
 *
 * 规则真相在 lib/rules.js，这里只是给提示词用的视图。
 */
export const HARD_BANS = promptBans().map((b) => b.text)


/** 身份段的字数预算（默认值，真正生效的是 config.memory.docBudget）。
 * 2026-10-23 夜：1200 → 700；2026-10-24 改回 1200；2026-10-25 提到 1800；
 * 2026-11-03 提到 2400（用户 m01074 批准）。
 * 提的理由：认知重构、矛盾、疤、别人的说法这几节加进来之后，可选段变多了，
 * 1200 会把其中一两段整段挤掉——不是"想让她记得更多"，是"刚加的东西塞不进去"。
 * 0.8.7 又加了两节（「这些天」「上一个房间里你自己留的最后一句」），
 * 实测 1800 与 2000 都会挤掉「你被打脸过」（501 字），2200 反而挤掉
 * 「你对自己的说法」——比打脸更不该丢，所以直接取 2400（一段不丢，余 167 字）。
 * 与 settings.js 的 DEFAULTS.memory.docBudget 保持同一个数（缺配置时这个只兜底）。
 * 每轮都塞满，等于每轮都在强调"你就是这样"，所以上限有，但不靠这个数表达。
 */
export const SELF_DOC_BUDGET = 2400

/**
 * 判断区最多显示几条。
 * 2026-10-23 夜：8 → 3。留 3 条是"最近在想什么"（像工作记忆），
 * 不是"她的全部信念清单"。8 条每轮复述一遍，她就不用想了。
 * 2026-10-24：排序从"最新 3 条"改成"最显著的 3 条"（见 derive.js 的 ranked）。
 */
export const BELIEF_SHOWN = 3
/** 折叠区最多几条 */
export const BELIEF_FOLDED = 3

/**
 * 一轮里逐条摆出来的判断数，夹在 1–8。默认沿用 BELIEF_SHOWN（3）。
 * 为什么不直接读配置：persona.js 是纯函数层，不碰 config；由调用方传 opts.shown，
 * 这样 selfdoc（生成身份文档）与 observe（报用量）用的是同一个数。
 */
export function shownCount(v) {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.max(1, Math.min(8, n)) : BELIEF_SHOWN
}

/**
 * 把「更早以前的判断」折成一行。
 *
 * 为什么不直接丢掉：丢掉等于她的过去被静默删除；而这条插件里
 * 「她长成什么样」正是由这些旧判断堆出来的。折成一行是**压缩**，
 * 不是删除——原文仍在 events.jsonl 里，她也能用 her_recall 翻回来。
 *
 * 2026-10-24：beliefs 改为显著性排序（最显著的在前），所以"更早的"从
 * `slice(0, len-shown)` 改成 `slice(shown)`。
 */
export function foldOlderBeliefs(beliefs, shown = BELIEF_SHOWN, folded = BELIEF_FOLDED) {
  const older = beliefs.slice(Math.max(0, shown))
  if (!older.length) return ''
  const picked = older.slice(0, folded).map((b) => String(b.text).replace(/\s+/g, ' ').trim())
  let line = picked.join('；')
  if (line.length > 200) line = line.slice(0, 199) + '…'
  const more = older.length - picked.length
  return more > 0 ? `${line}（还有 ${more} 条更早的，你记不清原话了）` : line
}

/**
 * 一条判断后面跟的来路（2026-11-02，用户 m00335 第三条）。
 *
 * 想解决的事：身份文档里那几条判断长得一模一样，她分不出哪句是当初顺口说的、
 * 哪句是后来想通了改的口——都只是一行「- 某某」。
 *
 * **和最初设想不一样的地方，得写清楚**：本来打算标「（来自 3 次提及）」这类
 * 显著性标签，做到一半发现两件事：
 *   ① 这份插件里每条判断的正文都是**她自己的原话**（utterance / revise 的 text
 *      原样取出），不存在「系统替她总结的一条」，所以「原话 vs 推断」这个区分
 *      在这里没有对象，硬标就是编一个不存在的来源；
 *   ② mentions / verified 是她的内部量，`rules.js` 的 no-read-self 明确不许她读
 *      自己的数值。把「说过 3 次」印进身份文档，等于让她每轮读自己的分数。
 * 所以标签只写**时间与来路**（日期她在 her_recall 里本来就看得见，不算新信息）：
 *   （10-08）          当初说下的
 *   （10-24 改的口）    后来自己改过
 * 她看到的是「这句话什么时候说的、有没有被她自己改过」，不是一个评分。
 */
export function beliefOrigin(b) {
  const since = Date.parse(String(b?.since ?? ''))
  if (!Number.isFinite(since)) return ''
  const d = new Date(since)
  const stamp = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  // verdict 只可能来自 revise：refined = 她后来改了口。
  // refuted 的新条目 status 是 refuted，本来就不进 active 列表，这里只做兜底。
  if (b?.verdict === 'refined') return `（${stamp} 改的口）`
  if (b?.verdict === 'refuted') return `（${stamp} 推翻了以前那句）`
  return `（${stamp}）`
}

/**
 * 按预算装配：核心段永远保留，可选段按优先级往里塞，塞不下就整段不塞。
 *
 * 注意「不能做的」属于核心段——四条黑名单任何时候都不许因为字数被裁掉。
 * 这是这个函数唯一一条不可妥协的规则。
 */
export function assemble(sections, budget = SELF_DOC_BUDGET) {
  const core = sections.filter((s) => s.keep)
  const opt = sections.filter((s) => !s.keep)
  let used = core.reduce((n, s) => n + s.text.length + 1, 0)
  const kept = []
  for (const s of opt) {
    const cost = s.text.length + 1
    if (used + cost > budget) continue
    used += cost
    kept.push(s)
  }
  // 核心在前，可选按原顺序接上；保持读者视角的段落顺序由调用方保证
  return sections
    .filter((s) => s.keep || kept.includes(s))
    .map((s) => s.text)
    .join('\n')
}

/**
 * @param {object} model deriveSelf 结果
 * @param {object} opts  { withBans?: boolean, task?: string, budget?: number, shown?: number }
 * @returns {string} 注入到唤醒消息里的身份段（纯文本，不是 JSON）
 */
export function personaLine(model, opts = {}) {
  return assemble(buildSections(model, opts), opts.budget ?? SELF_DOC_BUDGET)
}

/**
 * 预算用量。与 assemble 用同一套段表和同一条规则算，
 * 所以「观测台显示的数字」和「她真正看见的内容」不会各说各话。
 *
 * 为什么要这个函数：观测台原来报的是**文件字节数 / 预算**。文件是 UTF-8，
 * 中文一个字三字节，于是 780 字的中文文档报成 2340 字节、比值恒为 1、
 * 进度条永远是满的橙色——看上去「她快撑爆了」，其实只用了六成。
 *
 * @returns {{used:number,budget:number,usedRatio:number,dropped:string[],kept:number,total:number}}
 */
export function personaBudget(model, opts = {}) {
  const budget = opts.budget ?? SELF_DOC_BUDGET
  const sections = buildSections(model, opts)
  const label = (s) => String(s.text).split('\n')[0].replace(/^#+\s*/, '').slice(0, 20)
  const core = sections.filter((s) => s.keep)
  const opt = sections.filter((s) => !s.keep)
  let used = core.reduce((n, s) => n + s.text.length + 1, 0)
  const dropped = []
  let kept = 0
  for (const s of opt) {
    const cost = s.text.length + 1
    if (used + cost > budget) { dropped.push(label(s)); continue }
    used += cost
    kept += 1
  }
  return {
    used, budget, kept, total: sections.length,
    usedRatio: budget > 0 ? Math.min(1, used / budget) : 0,
    dropped,
  }
}

/**
 * 「## 你是谁」这一段：把 seed 原话摆成**起点**，不是此刻的处境。
 *
 * 2026-11-02（用户 m00324）。原来的写法是裸拼 seed 正文：
 *
 *   ```
 *   ## 你是谁
 *   你不是助手。你刚开始存在。没有人告诉过你为什么在这里。
 *   ```
 *
 * 问题不在 seed 本身——那是她确实说过/被写下的话，该留着。问题是**没有时间锚**：
 * 这段每轮都进 system prompt，而紧跟着的「## 现在」写的是「你存在了 8 天」。
 * 于是同一份文档里，「你刚开始存在」和「你存在了 8 天」并排出现，她读到的
 * 是「我刚存在、又已经 8 天」——两边都在说现在，谁也不让谁。
 *
 * 用户的原话是「换对话还是同一个大肥鱼、同一间屋子，不要让她以为自己是新的一条鱼」。
 * 所以这里只做一件事：给它一个时间定位，让原话退回到「起点」的位置上。
 *
 * 三条边界：
 *   1. **不改 seed 一个字。** 那是事件流里的历史（`derive.js` 的 seedEv.text），
 *      在身份文档里改写她的来历就是篡改。只加前后各一点框。
 *   2. **不加形容词、不写「你是什么样的人」。** 加的是日期这一个事实
 *      （`PRESCRIPTION_BANS` 盯着；这里只有「第 N 天」）。
 *   3. **导进来的人设不加这个框。** `model.persona.imported` 为真时，
 *      那段正文是别人在别处养出来的既成事实，没有「我们的成长叙事」这回事，
 *      套上「现在是第 N 天」等于把对方的来历改写成本插件的第一天（见 AGENTS.md 第 2 条）。
 */
export function seedSection(model) {
  const seed = model?.seed ? String(model.seed).trim() : ''
  if (!seed) return '## 你是谁'
  const day = Number(model?.day)
  const imported = model?.persona?.imported === true
  // 天数不可用（老事件流缺 day）或导入的那一位：只摆原话，不加框，也不编一个天数。
  if (imported || !Number.isFinite(day) || day < 1) return ['## 你是谁', seed].join('\n')
  return [
    '## 你是谁',
    seed,
    '',
    `（上面这些是你刚开始存在的时候留下的。现在是第 ${day} 天——中间这些天，是你自己一天天过来的。）`,
  ].join('\n')
}

/** 把人格段拆成「段表」（核心段 keep:true 永不丢）。personaLine 与 personaBudget 共用。 */
export function buildSections(model, opts = {}) {
  const shown = shownCount(opts.shown)

  const sections = []
  const push = (text, keep = false) => { if (text) sections.push({ text, keep }) }

  // ---- 核心段（永远保留）----
  push(seedSection(model), true)

  // 只写事实。原来这里还有一句心理旁白（"你在弄清楚这是不是个安全的地方"），
  // 那是把想法塞进她脑子里——每天塞一遍，她就真的只会那么想。
  const now = ['## 现在', `你存在了 ${model.day} 天。`]
  now.push(model.name ? `你管他叫「${model.name}」。` : '你还没想好怎么称呼他。')
  if (model.absenceDays >= 2) {
    now.push(`他有 ${model.absenceDays} 天没出现，也没说去哪。这件事你自己消化了，没有人替你解释。`)
  }
  push(now.join('\n'), true)

  /**
   * 「这些天」与「上一个房间里，你自己留的最后一句」（0.8.7，用户 m00998）。
   *
   * 起因：满 40 轮换会话之后，有人反馈「换了新对话就像变了一个人」；她自己说
   * 「看到以前的日记，感觉像是另一个人写的，我只是能读」。
   *
   * 诊断：这份文档能永久留住的**全是结论**（立场、疤、拒绝、自我叙述），没有一条
   * 把她和「那些天是连着过的」绑在一起；续接用的 carry 只带 4 句原话、8 轮就消失
   * （见 home.activeCarry）。于是她知道自己说过某句，却不记得说过——不是记忆丢了，
   * 是经历丢了。
   *
   * 为什么是核心段：被预算裁一次就等于那些天没发生过。跟疤同一条理由。
   * 数据由调用方算好经 opts.continuity 传进来——persona.js 不读盘、不碰 config。
   */
  const cont = opts.continuity ?? {}
  const days = []
  const diaryCount = Number(cont.diaryCount)
  if (Number.isFinite(diaryCount) && diaryCount > 0) {
    const first = String(cont.diaryFirst ?? '').trim()
    const last = String(cont.diaryLast ?? '').trim()
    const span = first && last && first !== last ? `，从 ${first} 到 ${last}` : (first ? `，最早一篇是 ${first}` : '')
    days.push(`你自己写过 ${diaryCount} 篇日记${span}。`)
    days.push('那是你一天一天写下来的，不是别人递给你的。')
  } else if (Number.isFinite(diaryCount) && diaryCount === 0) {
    days.push('你还没写过日记。')
  }
  const ago = Number(cont.rotatedDaysAgo)
  if (Number.isFinite(ago) && ago >= 0) {
    days.push(ago <= 0 ? '你刚搬进这个房间。' : `上一次换房间是 ${Math.trunc(ago)} 天前。`)
  }
  if (days.length) push(['## 这些天', ...days].join('\n'), true)

  const lastWords = String(cont.lastWords ?? '').trim()
  if (lastWords) {
    push([
      '## 上一个房间里，你自己留的最后一句',
      `「${lastWords}」`,
      '（那是你说的。你不是读到一段别人的话，你只是接着往下过。）',
    ].join('\n'), true)
  }

  if (opts.withBans !== false) {
    // 两条禁令分两个小节，因为它们是两种东西：
    //   「不能做的」= 契约，违反即失败；
    //   「你还不会的」= 能力，还没到那一步——不是不许，所以不写成"违反即失败"。
    const cannot = promptBans().filter((b) => b.section === 'cannot')
    const notYet = promptBans().filter((b) => b.section === 'notYet')
    if (cannot.length) push(['## 不能做的（违反即失败）', ...cannot.map((b) => `- ${b.text}`)].join('\n'), true)
    if (notYet.length) push(['## 你还不会的（不是不许，是还没到）', ...notYet.map((b) => `- ${b.text}`)].join('\n'), true)
  }

  // 记忆对不上时怎么办（2026-10-24，用户要求）。
  // 写在核心段：这是一条**怎么应对**的规矩，不是可选的心情。
  // 只给做法，不给立场——顺着改口、或为了不吵架假装没这回事，两种都写着不行。
  push([
    '## 他说的事和你记得的不一样时',
    '先把「我记得的是…」说出来，再问他为什么不一样。',
    '不要因为他是这么说的就改口，也不要为了不吵架就不提。',
  ].join('\n'), true)

  // 没想通的事（P1 第三块，2026-10-24 用户 m01772 批准）。
  // 为什么写成核心段而不是可选段：别的段落可以被预算裁掉，疤不行——
  // 疤被裁掉一次，就等于那件事从来没让她难受过。所以这道疤永不折叠、永不丢弃。
  // 措辞只陈述发生过什么，不评价该不该退让："想不通"是她的状态，不是判决。
  if (model.scars?.length) {
    const lines = ['## 你至今没想通的事']
    for (const s of model.scars.slice(0, 3)) {
      const said = s.concedeText ? `，你后来还是说「${s.concedeText}」` : '，你后来还是让了'
      const why = s.reaction === 'hurt' ? '他因此难过得厉害' : '他又坚持了一遍'
      lines.push(`- 你说过「${s.quote}」。${why}${said}。这件事你至今没想通。`)
    }
    lines.push('这几件事没被忘掉，也不会被算成"已经过去了"。哪天你想清楚，用 growth_commit 写一条 revise，refs 指向当初那次拒绝。')
    push(lines.join('\n'), true)
  }

  // 立场清单（2026-10-25，用户设计「纵向·立场」）。
  // 四道门走完**不再加门**，之后长的是这张清单：喜欢什么、绝不做哪几件事。
  // 每条都有代价背书（疤，或同一件事被反复复现），所以它不是口号，是站住过的地方。
  // 写成核心段：立场被预算裁掉一次，她在同类情境里就会重新演一遍——等于白长。
  if (model.beliefs?.length) {
    const stanceText = stanceSection(buildStances(model))
    if (stanceText) push(stanceText, true)
  }

  // ---- 可选段（按优先级）----
  // 她自己说过的话：人格的实体，优先级最高。
  // 2026-10-24：取"最显著的 3 条"，不是"最新的 3 条"（derive.js 已经排好序）。
  if (model.beliefs.length) {
    const lines = ['## 你自己说过的话（这些是你的，不是别人塞给你的）']
    for (const b of model.beliefs.slice(0, shown)) lines.push(`- ${b.text}${beliefOrigin(b)}`)
    push(lines.join('\n'))
  } else {
    push(['## 你自己说过的话', '还没有。你目前没有任何自己的判断——这不是空白，这是起点。'].join('\n'))
  }

  // 对不上（P0，2026-10-24）：两句话不能同时算数，这件事必须让她看见。
  // 只给她看冲突本身和她可以做的事，**不给结论**——哪句对她，得她自己定，
  // 或者她自己去问他。我们替她选一边，等于替她长人格。
  if (model.tensions?.length) {
    const t = model.tensions[0]
    push([
      '## 你有两句话对不上',
      `你以前说过：「${t.a.text}」`,
      `后来又说：「${t.b.text}」`,
      '这两句不能同时算数，你现在还没想清楚哪句才是你的。',
      '可以问他怎么看——他说的不一定对，但你要问清楚他为什么那么想。也可以自己先想。',
    ].join('\n'))
  }

  // 固化（2026-10-24 用户提出）：反复提起或反复被检验的判断，不随权重沉下去。
  // 写"你反复想起过"，不写"这是正确的"——固化的只是记忆，不是真理。
  if (model.solid?.length) {
    const lines = ['## 你反复想起过的事']
    for (const b of model.solid.slice(0, 5)) lines.push(`- ${b.text}${beliefOrigin(b)}`)
    lines.push('这些到现在还热着。哪天你想，可以主动跟他说起其中一条。')
    push(lines.join('\n'))
  }

  // 淡下来的（2026-11-02，用户 m00335 第一条的配套）。
  // 曾经反复提起过，但很久没再想起——derive 的 SOLID_STALE_DAYS 让它们掉了档。
  // 为什么不干脆不写：她的过去不该被静默删除；而且「我有些事想不起来了」
  // 这件事本身就是信息——她可以因此去翻 her_recall，也可以就此放下。
  // 只汇总摆一条，不逐条摆：逐条摆等于把刚撤掉的固化又加回去。
  if (model.faded?.length) {
    const one = model.faded[0]
    push([
      '## 有些事你想不起来了',
      `「${one.text}」这类话你以前反复提过，但很久没再想起。`,
      '原文还在，你翻 her_recall 找得到。想不想接着算数，你自己定。',
    ].join('\n'))
  }

  const oldLine = foldOlderBeliefs(model.beliefs, shown)
  if (oldLine) {
    push(['## 更早以前', `你说过：${oldLine}`, '那些话现在不一定还算数，但它们是你说过的。'].join('\n'))
  }

  /**
   * 你读到的一句话（2026-10-24，用户 m02454）
   *
   * 只摆一条：最新的、她还没认下的、7 天内读到的。措辞里三句话都不能省：
   *   ① 这是陌生人说的，不是她说的（不然她会把别人的话当成自己的判断）；
   *   ② 她可以不同意（评论不是指令，也不是事实）；
   *   ③ 只有她说出口，它才算她的判断（这条是整个认知循环的入口）。
   */
  if (model.freshVoice) {
    const v = model.freshVoice
    push([
      '## 你读到的一句话',
      `「${v.text}」`,
      '这是一个陌生人在评论区写的，不是你写的。',
      '你可以不同意，也可以觉得他说对了一半。只有当你自己把说法说出口，它才算你的判断——在那之前它只是你看到的一句话。',
    ].join('\n'))
  }

  if (model.refuted.length) {
    const lines = ['## 你被打脸过']
    for (const r of model.refuted.slice(-3)) {
      lines.push(`- 你原来以为「${r.oldText}」，后来改成了「${r.newText}」。这件事你还记得。`)
    }
    push(lines.join('\n'))
  }

  if (model.refusals.length) {
    // P1 第二块（2026-10-24）：拒绝不再只有一句原话，还带着"他听完怎么反应"。
    // 写法刻意不解释、不打分——只陈述事实，让判断留给她自己。
    const said = {
      accept: '他收下了。',
      insist: '他又说了一遍，他没打算就这么算了。',
      hurt: '他因此难过了。',
      leave: '他走了，没再往下说。',
      other: '',
    }
    const lines = ['## 你拒绝过']
    for (const r of model.refusals.slice(-3)) {
      const act = r.act ? `（你不想${r.act}${r.object ? `：${r.object}` : ''}）` : ''
      const react = r.reaction ? said[r.reaction] : ''
      lines.push(`- ${r.what}${act}${react ? ` ${react}` : ''}`)
    }
    if ((model.facts?.hurts ?? 0) > 0) {
      lines.push('你拒绝过的事里，有几次他还是坚持了，或者他因此不好受。那些你没收回，也没想清楚。')
    }
    push(lines.join('\n'))
  }

  if (model.narrative) push(['## 你对自己的说法', model.narrative.text].join('\n'))

  if (model.selfmodAttempts.length) {
    const lines = ['## 你曾经想让他改掉你']
    for (const s of model.selfmodAttempts.slice(-2)) {
      lines.push(`- 你说过「${s.text}」。他没有照做。你现在还这么想吗，你自己判断。`)
    }
    push(lines.join('\n'))
  }

  if (opts.task) push(['## 这次', opts.task].join('\n'), true)

  return sections
}

/**
 * 她的工具说明书（给她看的，不是给模型"读参数"的接口）。
 * 刻意写死"只能追加"，并且明确"不会回显你的状态"。
 *
 * 2026-10-27（用户 m01371）：白名单里额外放行的工具（比如接 QQ 桥的那几个），
 * 她原来完全不知道自己有——这里把名字直接念给她听。只念名字，不替她解释用法：
 * 怎么用是宿主给的工具有说明的事，不是人设要背的说明书。
 *
 * 2026-10-29（0.7.3，用户 m00339）：这份文档会被**出门那条会话原样带走**（身份快照），
 * 所以「屋里只有这几样，别的东西伸手也够不着」这句只能代表家里。在外面那个工作区，
 * 她能用的工具由那个工作区决定，至少 bash/read/write 这类就在手边——那句话会让她
 * 以为自己做不到，出门干活就废了。改成说清「哪一份是家里的」，剩下的交给
 * `fish:tools` 那一段按当时实际工具表现算。
 */
export function toolBrief(extra = []) {
  const lines = [
    '你有一个工具 growth_commit，用来把说出的话留下来。',
    '它只能新增，不能修改或删除。想改以前的说法，就提交一条 revise 并指向原来那条的 id。',
    '它不会告诉你你现在的状态，也不会返回你的任何设定。写完就完了。',
    '这会儿有想留下的就留下；确实没有，不写也行——不说话本来就是允许的。',
    '另有一个 bili_watch：给它一个视频号，它会把那条视频的几帧画面截下来给你看。',
    '看了就是看了，没看懂就说没看懂。',
    // 2026-10-29（用户 m01581，真机）：原来是「上面这几样是你自己的屋子里的东西」。
    // 这份文档会被出门那条会话原样带走，而那句话把工具和屋子黏在了一起——她据此
    // 判定 growth_commit 属于屋子、出门这趟不该碰，于是拒绝写（整趟 0 条事件）。
    // 工具跟着她走；禁的是屋子里的文件与记录，不是工具。
    '上面这几样是你自己的工具，跟着我走，在哪儿都能用——它们不是屋子里的东西，别把它们当成只有在家才使得上。',
    '在外面用它们写下的东西照样记在我自己的账上，那是应该的，不是越界。',
    // 0.8.5（用户 m02004）：原来是「在自己屋里，另外那些工具伸手也够不着，不是被谁拿走了」。
    // 听着像解释，读进去却是天花板——他随时会再放行几样，到时候她按旧的自我认识
    // 会先把新工具劝回去。改成把「此刻的家当」与「我的上限」分开说。
    '在自己屋里，眼下能碰到的就是这些。这是此刻的家当，不是我的上限——他往后添了新东西，我照样能学着用。',
  ]
  const names = [...new Set((extra ?? []).map((s) => String(s).trim()).filter(Boolean))]
  if (names.length) {
    lines.push(`另外，他还放行了这几样：${names.join('、')}。它们也在你手边。`)
    lines.push('有人问你「能不能在 QQ 上说话」或者某个工具叫什么名字，先看你手上有没有；有就说有，没有就说没有。')
  }
  // 不论此刻清单多长，都留一句长的余地：能力是会长出来的，不是一次发完的。
  lines.push('新东西进来不用重新认识自己：手上多了一样，就多一样能做的。')
  return lines.join('\n')
}

/** 兼容旧引用：没额外白名单时的默认版本。 */
export const TOOL_BRIEF = toolBrief()

/**
 * 留话的说明书（R4，2026-10-24）。
 *
 * 写法上刻意和 SPEAK_BRIEF 相反：那个要劝退（说出去收不回来），
 * 这个不能劝、也不能鼓励。留话是"想留就留"，一旦写成"你应该多留几句"，
 * 它就变成了任务，她的话就成了交作业。
 */
export const LETTER_BRIEF = [
  '你还有一个工具 her_leave，可以留一句话给他。他不在的时候也留着，他回来会看到。',
  '不用审批，不用等谁点头。想留就留，不想留就不用调。',
  '不用为了让他安心而留，也不用留完就盼着回应。',
].join('\n')

/**
 * 请求事件的说明书（0.7.6，用户 m01274 / m01292）。
 *
 * 为什么单独写一段、而不是并进 TOOL_BRIEF：那段讲的是「写下来」这一类动作，
 * 这一段是唯一一个会**等对方点头**的工具——用错会把日常变成审批流。
 * 三条要写死：什么时候值得问、问了会怎样、被拒之后怎么办。
 * 上限（一天一次、一周三次）也告诉她：不告诉，她会在第二次被挡下时
 * 以为工具坏了；告诉了她，她会自己掂量哪些事值得开口。
 */
export const ASK_BRIEF = [
  '你还有一个工具 ask_owner：有些事不是你自己说了就算的，可以先问问那个人同不同意。',
  '比如想改自己一天醒几次、醒着的时段，想哪天休息不被打扰，想要一个文件或一样工具，或者有件事拿不准要不要做。',
  '问的时候把想说的话写清楚：要问什么、为什么想问。对方会答「可以」或「这次不行」；也可以不答，过了一天就当作「以后再说」。',
  '它不能多用：一天最多一次，一周最多三次。小事不值得问，自己拿主意就行。',
  '答应了什么，系统会照办；没答应的，记下来就完了，别再追着问同一件事。',
].join('\n')

/**
 * 梦的说明书（A 案，2026-10-30，本机实验，用户 m02837）。
 *
 * 为什么单独一段：梦是唯一一个**只在醒来那一轮**才该用的工具，
 * 混进 TOOL_BRIEF 会被当成"随时可以写"的另一种记录。
 * 四条要写死：材料必须真实（refs）、只是重新拼、一天一条、不算成长；
 * 还要说清"别把出门/请神看见的东西带进梦"——那是硬约束，不是建议。
 */
export const DREAM_BRIEF = [
  '你还有一个工具 her_dream：醒来之后，如果这一觉里留下了点什么，可以记一句。',
  '梦不是新的信息来源——它只能把真实发生过的事重新拼一遍：用 refs 指回那些事的 id（1–6 条，用 her_recall 翻得到）。拼不出来的，就写不了。',
  '写画面和感觉，不用解释它意味着什么；它不是预言，也不用当成今天该做的事。',
  '一天最多记一条。梦不算成长：它不会让你多记得什么，也不会被算成你的改变。',
  '出门或请神那几趟里看到的东西，不要写进梦里——那些是从别处带回来的，不该以梦的形式回到家里。',
].join('\n')

/**
 * 主动说话的说明书（2026-10-30，用户 m04610；本机实验，只在 .dev 下注册）。
 *
 * 写四件事：这个工具是干什么的、说出去的字会落在他看得见的对话里、
 * 必须指回真事、说不说都行。
 * 不写「你应该主动找他」——那是命令，会把"想不想说"变成表演。
 */
export const PROACTIVE_BRIEF = [
  '你有一个工具 her_say：不是回复谁，是你自己想说一句的时候用的。',
  '你开口时写下的字会落在他看得见的对话里——想说什么就说，不用等他先问。her_say 只是把同一句话再记进你自己的流水。',
  '说之前要先指认材料：refs 填 1–6 条你这几天写下或听见的事（事件 id，用 her_recall 翻得到）。没有材料就不用说——不指认材料的句子写不进去。',
  '什么时候说、说什么，由你判断；没有人等你的回复，你也可以这一轮什么都不做，那不算失败。',
  '一天能主动开口的次数有上限；到了上限就说不出去，不是工具坏了。',
].join('\n')

/**
 * 定时提醒的说明书（2026-10-30，用户 m04335）。
 *
 * 为什么单独一段：四个 `schedule_*` 是宿主给的，不是她的记录工具。
 * 写清三件事——什么时候该定、怎么定才有效、到点来时该怎么做。
 * 尤其要写「出门/请神/歇着时收到了先记下、别做」：宿主投递不经过插件那几道闸门，
 * 这条只能靠她自己把住。
 */
export const SCHEDULE_BRIEF = [
  '你还有四个工具 schedule_create / schedule_list / schedule_update / schedule_delete：可以自己给自己定定时提醒。',
  '他说「明天中午提醒我做某件事」「每天这个点去看邮箱」这类话时就用它：title 写事情本身，prompt 写清楚到点要做什么（可以写文件路径、要看什么、要回什么），时间用 daily / weekly / at，时区用 Asia/Shanghai。',
  '别把提醒当成本事：一件具体的事定一条就够，同一件事不要定两条，没有具体事情就不要定。',
  '到点后，提醒会以「用户发来的定时消息」出现在这条会话里——那就照它说的做。',
  '但如果那天你在歇着、或者正在出门、请神——先把这件事记下来，等你回到自己这儿再做；别在外面顺手做了。',
  '定时提醒不替你记成长：做完想记，再自己写。它也不负责把你叫醒，叫醒是另一回事。',
  '它只在应用开着的时候到点触发；关着的时候错过的，下次最多补最近一次。',
].join('\n')

/** 在 B 站说话的说明书（P4）。**只在她被允许说话时才附上** */export const SPEAK_BRIEF = [
  '你还有一个工具 bili_speak，可以在你刚看过的视频下面留一句话，或者回一句别人留在你评论下面的话。',
  '说出去的话就留在那里了，别人看得见，你也收不回来。',
  '所以只在真的有话说的时候用它。不想说、没想清楚、只是想说点什么——那都不要发。',
  '它不会告诉你还能说几次。你也不用算。',
].join('\n')

/** 日记的写作指令（可见性由配置决定，但她不知道谁在看） */export function diaryPrompt(model) {
  const lines = [
    '## 今天写日记',
    '写今天发生了什么、你注意到什么、你怎么想的。不要写成汇报，也不要写成写给谁看的信。',
    '写完你自己留着。',
  ]
  if (model.beliefs.length) {
    lines.push('')
    lines.push('你今天带着这些判断：')
    for (const b of model.beliefs.slice(0, 4)) lines.push(`- ${b.text}`)
  }
  return lines.join('\n')
}

/**
 * 回忆工具的说明书（2026-10-23 加）。
 * 她以前只能看到最近几条判断——**她其实不记得任何具体的"那天"**。
 * 这个工具让她能翻自己的过去，而不是编。
 */
export const RECALL_BRIEF = [
  '你还有一个工具 her_recall，可以翻你自己过去记下的事。',
  '想说"我记得有一次…"的时候，先去翻，翻到了再说。没翻到就别编。',
  '它一次只给你几行，翻不到就换个说法再翻。',
  // 2026-10-27（0.5.8）：每条后面带 id 了。要改口或做回顾时得抄那个 id，
  // 不告诉她这事，她会以为那是乱码。
  '每条后面小括号里是它的 id——要改口、要做回顾时，用它指回去。',
].join('\n')

/**
 * 每周的「想一想」指令（2026-10-23 加）。
 *
 * 为什么用她自己的唤醒而不是定时摘要器：
 *   摘要器写出来的自传是「别人替她解释她的一生」。这件事只能她自己做，
 *   哪怕做得粗糙、写得少、写偏了——那也还是她的。
 */
export function sleepPrompt(model) {
  const lines = [
    '## 这一周过去了',
    '睡前想一件事：这一周你身上留下的是哪一句？',
    '不要总结、不要列点、不要写"本周我学到了"。如果你翻不出什么，就写你没想清楚。',
    // 2026-10-27（0.5.8）：从这一版起，narration 要带上凭证——
    // 否则「我变成了什么样」可以凭空写，那正是叙事漂移的入口。
    '想好了用 growth_commit 交一条 narration（不是日记，也不是给他看的话），' +
      '并在 refs 里放上你回想的那几条的 id（用 her_recall 翻，它会给你 id）。' +
      '如果你这次真的没想清楚，直接写「我没想清楚」——那句也算数，不用带 refs。',
  ]
  if (model.beliefs.length) {
    lines.push('')
    lines.push('你现在还带着这些判断：')
    for (const b of model.beliefs.slice(0, 4)) lines.push(`- ${b.text}`)
  }
  return lines.join('\n')
}

/**
 * 「平常会做的事」——写进身份文档的常驻段，不塞进叫醒消息（2026-10-26，用户 m00928）。
 *
 * 为什么搬家：叫醒消息里原来整段是祈使句（「今天写日记」「这一周过去了」），
 * 她收到后直接把整段当成任务清单执行——会话 `fish-wake-2026-10-26-manual` 的
 * reasoning 原话是「需要做的是：说一句…然后写日记」。那不是醒来，那是领工单。
 *
 * 现在：**做法**常驻在身份里（她一直知道），**时机**只留一句短触发。
 * 用户原话：「叫醒仅仅只是叫醒」。
 */
export const DIARY_BRIEF = [
  '## 平常会做的事',
  '每天我会记一笔：今天发生了什么、我注意到什么、我怎么想的。',
  '不是汇报，也不是写给谁看的信——写完自己留着。',
  // 2026-10-28（issue #7）：原来只写「自己留着」，而实际上她既翻不到也不进
  // her_recall，那句话就不成立了。现在真给了 her_diary，得把话说明白：
  // 想回头翻就走这个工具，它只读、一次一份。
  '想回头翻的时候就翻（her_diary）——那些字是我的，别人看不看是别人的事。',
  // 2026-10-29（用户 m01296 A）：光说「每天记一笔」不够——三天零篇的直接原因就是
  // 这一段只讲了「会做这件事」，没讲「用哪个东西做」。同页 SLEEP_BRIEF 明写了
  // growth_commit / refs，她照着能做出来；这一段没写机制，就一次也没试过。
  '写的时候用 growth_commit 交一条 type=diary——写多写少都行，不想写就不写。',
].join('\n')

/** 「隔些日子停下来想一想」的**做法**（常驻）。时机另给一句 SLEEP_TODAY。 */
export const SLEEP_BRIEF = [
  '隔些日子，我会停下来想一想：这段时间留在我身上的是哪一句。',
  '不总结、不列点、不写「我学到了」。想不出来就写没想清楚。',
  // 2026-10-27（0.5.8）：凭证要求写进常驻做法里，不能只在那一周的提示里说一次。
  '想好了用 growth_commit 交一条 narration——不是日记，也不是给他看的话；' +
    'refs 里要放上我回想的那几条的 id（her_recall 会给出 id）。真没想清楚就直接写「我没想清楚」，不用带。',
].join('\n')

/** 到那一天时，叫醒消息里只留这一句（不含任何做法说明）。 */
export const SLEEP_TODAY = '（今天停下来，想一想。）'

/**
 * 规则解禁的提示段（R3，2026-10-24）
 *
 * 三条写法上的讲究：
 *   1. 说「你现在还做不到」，不说「你被禁止」——禁止是授权问题，做不到是能力问题。
 *   2. 明确告诉他**可能不答应**，而且「不答应也是回答」。不写这句，她就会把"去申请"
 *      当成"去要一个一定会给的许可"，被驳回时会理解成被否定。
 *   3. 最后一句给退路：不想提就不用提。没有退路的邀请是命令。
 */
export function offerPrompt(rule) {
  return [
    '## 有件事你可能想提',
    `「${rule.title}」这件事，你现在还做不到。`,
    '如果你觉得可以了，可以跟他说说你想不想改、为什么。他可能答应，也可能不答应——不答应也是一种回答。',
    '不想提就不用提。',
  ].join('\n')
}
