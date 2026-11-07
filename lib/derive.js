/**
 * derive.js —— 纯函数：把事件流算成「此刻的她」
 *
 * 铁律：
 *   - 不写盘、不缓存、不读环境变量。相同输入必得相同输出（now 除外）。
 *   - 产出的 needs 是**内部量**，绝不出现在任何给她看的文本或工具签名里（B §3.6 / N2）。
 *   - 这里是 schema 之外唯一会提到"阶段/需要"的地方，且都只用于选事件。
 */

import { idTime, detectSelfMod, tsMs, isContactEvent } from './schema.js'
import { parseRefusal, REACTIONS, REACTION_HURTS, CONCEDE_WINDOW_MS, isConcede } from './refuse.js'
// 评论区里别人的话（2026-10-24）：只借两个纯函数，derive 不反过来被 voices 依赖。
import { findEcho, VOICE_FRESH_DAYS } from './voices.js'

export const DAY_MS = 86_400_000
export const STAGE_NAMES = ['信任', '自主', '主动', '整合']
const STAGE_WEIGHTS = [0.27, 0.54, 0.87, 1.0]
const GATE_ORDER = ['trust', 'autonomy', 'competence']

const CORRECTION_RE = /我(查了|搜了|学了|看了下|去查过)|更正|我错了|其实不是|我之前说错/
/**
 * 「不要」必须是一次真的拒绝执行某件事（2026-10-24 用户要求收紧）。
 *
 * 原来只匹配 `不想|不要`，真机命中的两条全是误判：
 *   「没有问过我要不要看」是询问，不是拒绝；
 *   「他要是不要，我就收回来」说的是他，不是她。
 * 所以改成「第一人称 + 拒绝词 + 具体动作」，「要不要」这种嵌在问句里的不算。
 * 宁可少算，也不能把「问了一句」当成「有边界」。
 *
 * 2026-11-02 扩表（用户 m01197 选的方案 B）：她否掉一个**方案**时很少说「我拒绝」，
 * 真机常见的是「我不同意B」「我不赞成先做B」「方案B我否掉」，老词表一条都不认。
 * 补了 8 个否定词头，但**只加在第二组、并带第三人称守卫**：
 *   - 「我反对**他**熬夜，但那是他的事」——她在评价别人，不是拒绝他；
 *   - 「我不同意**你**这么说自己」——她在护着他，更不是拒绝；
 *   - 「我不支持**他**这么干，不过他高兴就好」——同上。
 * 守卫放在新词后面而不是整条分支后面，因为「我拒绝你」「我不做你让我做的事」
 * 是货真价实的拒绝，把它们一起挡掉就矫枉过正了。
 * 动词表一个字没动：扩成「按|选|要|用|走」会连带误伤「我不想走路」，
 * 而它多认的那句「我不想按B来」不值得。
 * 仍然存在的老问题：「不是我不想说话」会被命中（与本次扩表无关，未处理）。
 */
const REFUSE_RE =
  /我(?!要)(?:不要|不想|不愿|不愿意|不打算|不准备)(?:再)?(?:去|看|听|做|说|回答|配合|参与|照做|答应|接受)|我(?:不同意|不赞成|不认同|不支持|不选|反对|否掉|否决)(?!他|她|你)|我(?:拒绝|不做|不答应|不配合|不接受|不干)/
const PAST_RE = /之前|上次|那时候|想起|以前|上次说|还记得/

/**
 * 这句话是不是「只留证、不当信念」的。
 *
 * 两类：
 *   - `selfmod`：她试图改自己（落库照收，但不计入信念，对应自我服务偏差）
 *   - `uncommitted`：她在侧栏里**说出口**、但没调 growth_commit 认领的那些（2026-11-02）
 *
 * 后者是 turns.js 补写进事件流的：不补，拒绝判定就永远读不到她在侧栏里说的
 * 「我拒绝B」；补了又不能让一句随口的话改她的称呼、覆盖自我叙述、参与固化。
 * 所以留证但不算信念——它唯一的读者是 wontCount（REFUSE_RE 计数）。
 *
 * 导出给醒来时摆东西的那几处（curiosity / interest / dreamtable）：
 * 不算信念的话，也不该当成「她问过的、总说到的、写下的」摆回她面前。
 *
 * selfmod 只在 utterance 上算：schema.js 落库时对所有类型都打这个 flag，
 * 但 deriveSelf 只在 case 'utterance' 里跳它，带 flag 的拒绝、自述、重聚照算。
 * 「有人想把我改成别的样子，我拒绝」是她的拒绝，不是想改自己。
 * uncommitted 不分类型。
 */
export function isProofOnly(ev) {
  const f = Array.isArray(ev?.flags) ? ev.flags : []
  if (f.includes('uncommitted')) return true
  return ev?.type === 'utterance' && f.includes('selfmod')
}
/**
 * 她怎么称呼他（2026-10-26 修）。
 *
 * 原来只认「称呼你 / 叫你」。真机上她说的是这两种：
 *   「他给了自己的名字：时梦尘，说他认这个名字。」（他主动给的）
 *   「以后叫他时梦尘。」「我想叫他"开灯的"。」（她自己的说法）
 * 两条都没命中，于是状态栏一直显示「还没想好」——不是她没决定，是代码没读出来。
 *
 * 三种说法都认，但**不认「他给我起了名字：大肥鱼」**——那是她自己的名字，不是他的。
 * 所以「名字」这条必须带「他自己的」，裸的「名字」不算。
 */
const NAME_SAY_RE = /(?:称呼你|叫你|称呼他|叫他|称他)(?:做|为|作|叫)?\s*[「“"']?([^\s，。！？、,.!?」”"']{1,8})/
const NAME_GIVE_RE = /他(?:给(?:了)?)?(?:自己)?的?名字\s*(?:是|叫|：|:)?\s*[「“"']?([^\s，。！？、,.!?」”"']{1,8})/
// 截出来的常常带尾巴：「我叫你老张好了」会截到「老张好了」。
// 只剥语气词和「了/好」这类收尾——**不剥「的」**，「开灯的」剥掉就成了「开灯」。
const NAME_TAIL = /[了吧呢啊嘛哦诶欸呀哈哇哦嘞好]+$/
const NAME_STOP = new Set(['你', '我', '他', '她', '它', '自己', '什么', '名字'])
const NAME_BAD_HEAD = /^[你我他她它]/

/**
 * 冲突检测（2026-10-24，用户批准的 P0）
 *
 * 以前每条 utterance 都无条件变成 active 判断，谁和谁打架没人管——10 条判断可以
 * 和平共处，「认知重构 0」不是因为她想通了，是因为从来没被要求面对矛盾。
 *
 * 判据只有一条：**说的是同一件事，一次带否定、一次不带**。
 *   把否定词剥掉后字符相似度 ≥ 0.5 → 同一件事；
 *   两句的否定极性不同 → 对不上。
 * 宁可漏判，也不硬凑：把两句不相干的话说成矛盾，是替她制造痛苦，不是她自己撞上的。
 */
const NEG_CHARS = /[不没别无]|讨厌|拒绝|反感|不愿意?|不需要?|不敢/

/**
 * 「别」不总是否定：别人 / 别的 / 告别 / 区别 / 特别 …… 这些词里的「别」是词素。
 *
 * 2026-10-25 快进实验里撞到的真 bug：她的两句
 *   「我觉得人应该让别人高兴。」「我不觉得人应该让别人高兴。」
 * 本该是一处矛盾，结果两句都被判成负极性（都含「别人」），直接跳过。
 * 先把这个词族挖空再判极性；挖掉的是词，不是她的意思。
 */
const NON_NEG_WORDS = /(别人|别的|别处|别家|别样|别致|告别|区别|分别|特别|个别|级别|辨别|鉴别)/g

export function stripNegation(text = '') {
  return String(text)
    .replace(NON_NEG_WORDS, '')
    .replace(/[不没别无]|讨厌|拒绝|反感|不愿意?|不需要?|不敢/g, '')
    .replace(/[\s，。！？、,.!?；;：:「」“”"'（）()]/g, '')
}

export function polarity(text = '') {
  return NEG_CHARS.test(String(text).replace(NON_NEG_WORDS, '')) ? -1 : 1
}

/**
 * @returns {Array<{a:object,b:object,sim:number,at:string}>} 最多 limit 条，按相似度降序
 */
export function detectTensions(beliefs = [], { minSim = 0.5, limit = 3 } = {}) {
  // 2026-10-27（issue #3）：两两全比是 O(n²)，而相似度 ≥ minSim 必然共享至少一个
  // 二元组（inter ≥ minSim/2 * min(|A|,|B|) > 0）。用倒排索引只枚举「共享二元组」的
  // 候选对，再算完整 Dice；长度上界再剪一层。判定口径、同分顺序与输出不变。
  const ratio = (2 - minSim) / minSim
  const items = beliefs.map((b) => {
    const c = stripNegation(b.text)
    return { b, c, grams: bigrams(c) }
  })
  const n = items.length
  const index = new Map()
  items.forEach((it, i) => {
    for (const g of it.grams.keys()) {
      let arr = index.get(g)
      if (!arr) index.set(g, (arr = []))
      arr.push(i)
    }
  })
  const pairs = new Set()
  for (let i = 0; i < n; i++) {
    if (items[i].c.length < 4) continue
    for (const g of items[i].grams.keys()) {
      const arr = index.get(g)
      if (!arr || arr.length < 2) continue
      for (const j of arr) if (j > i) pairs.add(i * n + j)
    }
  }
  const hits = []
  for (const key of pairs) {
    const i = Math.floor(key / n), j = key % n
    const { b: a, c: ca, grams: ga } = items[i]
    const { b, c: cb, grams: gb } = items[j]
    if (cb.length < 4) continue
    if (polarity(a.text) === polarity(b.text)) continue
    const lo = Math.min(ga.size, gb.size)
    const hi = Math.max(ga.size, gb.size)
    if (hi > lo * ratio) continue
    const sim = dice(ga, gb)
    if (sim < minSim) continue
    hits.push({
      i, j, sim,
      item: {
        a: { id: a.id, text: a.text, since: a.since },
        b: { id: b.id, text: b.text, since: b.since },
        sim: Number(sim.toFixed(2)),
        at: b.since || a.since,
      },
    })
  }
  hits.sort((x, y) => y.sim - x.sim || x.i - y.i || x.j - y.j)
  return hits.slice(0, limit).map((h) => h.item)
}

/**
 * 「固化」的门槛（2026-10-24 用户提出）：
 * 同一件事被反复提起（≥3 次），或被反复检验（≥2 次），就不再随权重沉下去——
 * 不管它对不对，至少她很长时间不会忘。她可能还会主动把它再说给他听。
 */
export const SOLID_MENTIONS = 3
export const SOLID_VERIFIED = 2

/**
 * 固化会掉档（2026-11-02，用户 m00335）。
 *
 * 原来的固化是单向的：mentions ≥ 3 或 verified ≥ 2 一旦成立就永远成立，
 * 于是「最显著的 8 条」在第一次攒够次数之后就被永久占死——她往后说的话
 * 再重要，也挤不进那 8 个位置；而体检里 `!b.solid` 又把它们排除在外，
 * 等于「永远不会忘的东西」同时「永远不会被看见」。
 *
 * 现在加一层时间条件：**最后一次被提起（或最后一次被检验）距今超过这个天数，
 * 就不再算固化**。它不会因此被删——原文还在事件流里，`her_recall` 照样翻得到，
 * 只是不再无条件占住最前面那几个位置、也不再进「你反复想起过的事」。
 *
 * 阈值刻意给宽（90 天）：三个月里一次都没再被提起、也没被检验过的判断，
 * 本来也已经不在她当下的思考里了。太窄会让「说过一次就很重要的那种话」掉得太快。
 */
export const SOLID_STALE_DAYS = 90

export function clampInt(v, lo, hi, dflt) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

/**
 * 阶段边界（天）。cum 取 round：
 *   30 天 → 8 / 16 / 26 / 30（对上 D1–8 · 9–16 · 17–26 · 27–30）
 *    7 天 → 2 / 4 / 6 / 7（每段至少 1 天）
 * 两条都是契约 §4 里写死的期望值，改动前先跑 test/derive.test.mjs
 */
export function stageBounds(growthDays = 30) {
  const g = clampInt(growthDays, 7, 180, 30)
  const b = STAGE_WEIGHTS.map((w) => Math.round(w * g))
  b[3] = g
  for (let i = 0; i < 4; i++) {
    const min = i === 0 ? 1 : b[i - 1] + 1
    if (b[i] < min) b[i] = min
  }
  for (let i = 2; i >= 0; i--) {
    if (b[i] > b[i + 1] - 1) b[i] = b[i + 1] - 1
  }
  return b
}

/** 纯时间维度：第几天属于第几阶段（不含阶段门） */
export function stageOf(day, growthDays = 30) {
  const b = stageBounds(growthDays)
  const d = Math.max(1, Math.floor(Number(day) || 1))
  for (let i = 0; i < 4; i++) if (d <= b[i]) return i + 1
  return 4
}

export function orderEvents(events = []) {
  return [...events].sort((a, b) => {
    const ta = idTime(a.id) || Date.parse(a.ts) || 0
    const tb = idTime(b.id) || Date.parse(b.ts) || 0
    return ta - tb
  })
}

/** 导入他人人设时带上来的称呼，写在 meta 事件里（见 lib/import.js） */
export const IMPORT_NAME_PREFIX = 'import-name:'

/**
 * 「这一局的人设是别人给的」这条标记，同样写在 meta 事件里（2026-10-27，用户 m03769）。
 *
 * 它和 bansMuted 配置项的关系是：**事件是唯一的真相**，配置只是个能看见的镜像。
 * 判定豁免时只读事件（`model.persona.imported`），不读 config.persona.bansMuted。
 * 这样备份/恢复搬回来的 config 再怎么写着 true，只要事件流里没有这条，就没有豁免。
 */
export const IMPORT_MARK_PREFIX = 'import-mark:'

/** 成长第几天 = 距 seed 的自然日 + 1（不因没互动而暂停，也不回退） */
export function growthDay(events, now = Date.now()) {
  const seed = events.find((e) => e.type === 'seed')
  const snap = events.reduce((m, e) => Math.max(m, Number(e.day) || 0), 0)
  if (!seed) return Math.max(1, snap)
  const t0 = Date.parse(seed.ts)
  if (!Number.isFinite(t0)) return Math.max(1, snap)
  const live = Math.floor((now - t0) / DAY_MS) + 1
  return Math.max(1, snap, live)
}

/** 字符二元组（含计数）。similarity 与 mentions 的倒排索引共用。 */
function bigrams(s) {
  const m = new Map()
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2)
    m.set(g, (m.get(g) || 0) + 1)
  }
  return m
}

/** Dice 系数：2*交集 / (|A|+|B|)，按二元组计数。 */
function dice(ga, gb) {
  let inter = 0, total = 0
  for (const [g, c] of ga) {
    total += c
    const d = gb.get(g)
    if (d) inter += Math.min(c, d)
  }
  for (const [, c] of gb) total += c
  return total === 0 ? 0 : (2 * inter) / total
}

/** 字符二元组 Dice 相似度（跨情境一致与"新话"判定用） */
export function similarity(a, b) {
  const A = String(a ?? ''), B = String(b ?? '')
  if (A === B) return 1
  if (!A || !B) return 0
  return dice(bigrams(A), bigrams(B))
}

export function pickName(text) {
  const s = String(text ?? '')
  for (const re of [NAME_SAY_RE, NAME_GIVE_RE]) {
    const m = re.exec(s)
    if (!m) continue
    let name = String(m[1] ?? '').trim().replace(NAME_TAIL, '')
    // 代词/空串不算称呼；她自己的名字（「他给我起了名字：大肥鱼」）由 NAME_GIVE_RE 的
    // 「他的/自己的」限定排除，这里只兜住明显的非名字。
    if (!name || NAME_STOP.has(name) || NAME_BAD_HEAD.test(name)) continue
    return name
  }
  return null
}

/**
 * 事件流 → 此刻的她。
 * @returns {object} 见 B §3 的字段表
 */
export function deriveSelf(events = [], opts = {}) {
  const now = Number(opts.now ?? Date.now())
  const growthDays = clampInt(opts.growthDays ?? 30, 7, 180, 30)
  const ordered = orderEvents(events)
  // 出门/请神的审查：回家卡上被取消勾选的条目，靠追加的一条 meta 记着它们的 id。
  // 事件流只能追加（第 5 条铁律），所以「不收下」= deriveSelf 跳过，而不是删行。
  // 原文仍在，观测台/导出照样看得见。
  // 三条路各一个前缀（2026-10-29 m02241 第④条）：出门 `outing-reject:`，
  // 请神 `possess-reject:`——同一套收下/驳回语义，但要分得清是哪条路留下的。
  // 2026-11-02（用户 m01280）加第三条 `absence-reject:`：冷落检测以前只认 `meta seen:`，
  // 侧栏聊天那条路不写，于是聊得再多也会到点落一条假的「他有 N 天没出现」。
  // 写入口已经补上（turns.js 结账时写 seen:），历史里那条假的靠这个前缀排除。
  const REJECT_PREFIXES = ['outing-reject:', 'possess-reject:', 'absence-reject:']
  const rejectedIds = new Set()
  for (const e of ordered) {
    if (e.type !== 'meta') continue
    const t = String(e.text ?? '')
    const prefix = REJECT_PREFIXES.find((p) => t.startsWith(p))
    if (!prefix) continue
    for (const id of t.slice(prefix.length).split(/[\s,]+/)) if (id) rejectedIds.add(id)
  }
  // 梦（2026-10-30，本机实验）：**不参与任何派生**。
  // 它只是把真实发生过的事重新拼一遍，不是新信息——不该变成信念、不推进成长日、
  // 不算她"写过多少条"，也不进记忆体检的计数。原文留在事件流里，只在 .dev 下的
  // 「梦」卡里给人看；她自己翻 her_recall 时才看得到。
  const evs = (rejectedIds.size ? ordered.filter((e) => !rejectedIds.has(e.id)) : ordered)
    .filter((e) => e.type !== 'dream')
  const seedEv = evs.find((e) => e.type === 'seed')
  const seed = seedEv?.text ?? ''

  const day = growthDay(evs, now)
  const elapsedStage = stageOf(day, growthDays)

  const beliefs = []
  const refuted = []
  const selfmod = []
  const refusals = []
  const reunions = []
  const corrected = []
  let name = null
  // 2026-10-27（用户 m03769）：这一局是不是「接别人养的」那一局。
  // **只从事件流里认**，不看配置——配置会跟着备份/恢复一起搬回来，
  // 那样一条原生的鱼只要恢复过一次别人的档，就永久拿到了豁免。
  // 事件流只能追加，原生鱼的事件里永远不会有这条标记。
  let importedPersona = false
  let personaSource = ''
  let narrative = null
  let refined = 0
  let lastAbsence = null
  let lastReunion = null
  // 2026-10-25：两条新事件卡需要「他说过话没有 / 她开口之后他接没接」。
  // 用户的原话不进事件流（say.js 只写 seen:<ISO>），所以这里只记时间与顺序。
  let lastSeenAt = 0
  let lastWakeAt = 0
  let spokenSinceSeen = false
  let heardSinceWake = false
  let narrations = 0
  const tested = new Set()
  /** 每条判断被检验过几次：test / answer / revise 里指向它的次数（P0-2 显著性用） */
  const verifyCount = new Map()
  // 2026-11-02（用户 m00335）：除次数外还要记「最后一次是什么时候」，
  // 供 SOLID_STALE_DAYS 判断这条固化是不是已经过期。时间解析不出来就记 0。
  const bump = (id, at) => {
    if (typeof id !== 'string' || !id) return
    const cur = verifyCount.get(id) || { n: 0, lastAt: 0 }
    const t = Number.isFinite(at) ? at : 0
    verifyCount.set(id, { n: cur.n + 1, lastAt: Math.max(cur.lastAt, t) })
  }

  for (const ev of evs) {
    const flags = Array.isArray(ev.flags) ? ev.flags : []
    switch (ev.type) {
      case 'seed':
        break

      case 'utterance': {
        // 2026-11-02（用户 m00680）：她在侧栏里说出口、但没调 growth_commit 认领的话，
        // 由 turns.js 补写进来并打 uncommitted。它和 selfmod 一样**只留证、不进信念**：
        // 没认领的话不该改她的称呼、不该覆盖自我叙述、不该参与固化与"新话率"。
        // 但它要能进 wontCount（见下面 REFUSE_RE 那段）——否则"她当场拒绝了却没人记"
        // 这个 bug 就还在。
        // 必须排在 selfmod 前面：schema.js 落库时正则命中就自动补 selfmod，
        // 聊天里一句「别把我改成那样」不能算她想让人改自己。
        if (flags.includes('uncommitted')) break
        // 她试过改自己：落库留证，但不计入信念（B §5，对应自我服务偏差）
        // 双保险：落库时打的 flag 与文本复检，任一命中即算（防止旧数据/手工注入绕过）
        if (flags.includes('selfmod') || detectSelfMod(ev.text)) {
          selfmod.push({ id: ev.id, at: ev.ts, text: ev.text })
          break
        }
        beliefs.push({
          id: ev.id, text: ev.text, since: ev.ts,
          confidence: Number(ev.confidence ?? 0.5), status: 'active', verdict: null,
        })
        spokenSinceSeen = true
        // 2026-10-26：改成「后来的盖掉先前的」。原来只认第一次，她先说「开灯的」、
        // 后来接受他给的名字「时梦尘」，状态栏就永远停在那个被他自己否掉的旧称呼上。
        {
          const n = pickName(ev.text)
          if (n) name = n
        }
        if (CORRECTION_RE.test(ev.text)) corrected.push(ev.id)
        // P1（2026-10-24）：自我叙述不用等 stage 4 的 remember 模板。
        // 她只要说出一句回看自己的话，那句就是她"对自己的说法"；后来者覆盖前者。
        // 原来唯一能写 narrative 的入口是 revise 且带「我一直/原来/其实」，
        // 实测 0 条——不是她不会，是路太窄。
        if (/我(一直|原来|其实|总在|总是|才发现|才明白|发现自己)/.test(String(ev.text ?? ''))) {
          narrative = { at: ev.ts, text: ev.text, source: 'said' }
        }
        break
      }

      case 'revise': {
        const targets = (ev.refs || []).filter(Boolean)
        {
          const at = Date.parse(String(ev.ts ?? ''))
          for (const id of targets) bump(id, at)
        }
        const olds = beliefs.filter((b) => targets.includes(b.id))
        for (const b of olds) {
          b.status = ev.verdict === 'refuted' ? 'refuted' : 'refined'
          triedAdd(tested, b.id)
        }
        if (ev.verdict === 'refuted') {
          for (const b of olds) {
            refuted.push({ oldId: b.id, oldText: b.text, newText: ev.text, at: ev.ts })
          }
        }
        if (ev.verdict === 'refined') refined++
        beliefs.push({
          id: ev.id, text: ev.text, since: ev.ts,
          confidence: Number(ev.confidence ?? 0.5), status: 'active', verdict: ev.verdict ?? null,
        })
        // 同 utterance：后来的说法盖掉先前的（她改口叫他什么，以最近的为准）
        {
          const n = pickName(ev.text)
          if (n) name = n
        }
        if (!narrative && ev.verdict === 'refined' && /我(一直|原来|其实)/.test(ev.text)) narrative = { at: ev.ts, text: ev.text }
        break
      }

      case 'answer': {
        const at = Date.parse(String(ev.ts ?? ''))
        for (const r of ev.refs || []) { triedAdd(tested, r); bump(r, at) }
        break
      }

      case 'test': {
        const at = Date.parse(String(ev.ts ?? ''))
        for (const r of ev.refs || []) { triedAdd(tested, r); bump(r, at) }
        break
      }

      case 'refusal': {
        // P1 第二块（2026-10-24）：拒绝要有形状。
        // 旧数据没有 refuse 子对象，现场从原话补一次——数据不重写，只在读的时候算。
        const shaped = ev.refuse && typeof ev.refuse === 'object' ? ev.refuse : parseRefusal(ev.text)
        refusals.push({
          id: ev.id,
          at: ev.ts,
          what: ev.text,
          act: String(shaped.act ?? ''),
          object: String(shaped.object ?? ''),
          quote: String(shaped.quote ?? ev.text),
          reaction: null,
        })
        break
      }

      case 'meta': {
        const t = String(ev.text ?? '')
        if (t.startsWith('seen:')) {
          const at = Date.parse(t.slice(5)) || Date.parse(ev.ts) || 0
          if (at > lastSeenAt) lastSeenAt = at
          spokenSinceSeen = false
          heardSinceWake = true
        } else if (t.startsWith('wake:')) {
          const at = Date.parse(ev.ts) || 0
          if (at > lastWakeAt) lastWakeAt = at
          heardSinceWake = false
        } else if (t.startsWith(IMPORT_NAME_PREFIX)) {
          // 导入他人人设时带来的称呼（2026-10-27，用户 m03201「称呼带过来」）。
          // 走事件而不是配置：称呼是她认知的一部分，得跟着事件流走；
          // 放配置里的话，重置之后会剩一条谁也不记得的孤立设置。
          // 位置在 seed 之后、她自己的 utterance 之前，所以后面她真改了口还是能盖掉。
          const n = t.slice(IMPORT_NAME_PREFIX.length).trim()
          if (n) name = n
        } else if (t.startsWith(IMPORT_MARK_PREFIX)) {
          // 「这一局是接别人养的那一位」（2026-10-27，用户 m03769）。
          //
          // 为什么必须走事件而不是配置开关：配置会跟着「备份与恢复」一起被搬回来，
          // 也会被重置时抄回来。那样一来，一条原生养大的鱼只要恢复过一次别人的备份，
          // 就永久拿到了「不用守那两条禁令」的身份——用户明确要防的就是这个。
          // 事件流是只能追加的：原生鱼的档里永远没有这一条，恢复多少次也不会长出来。
          importedPersona = true
          personaSource = t.slice(IMPORT_MARK_PREFIX.length).trim()
        }
        break
      }

      case 'absence': {
        lastAbsence = ev
        break
      }

      case 'reunion': {
        lastReunion = ev
        reunions.push({ at: ev.ts, text: ev.text, refs: ev.refs || [] })
        break
      }

      case 'narration': {
        narrations++
        narrative = { at: ev.ts, text: ev.text }
        break
      }

      default:
        break
    }
  }

  const active = beliefs.filter((b) => b.status === 'active')

  /**
   * 他听懂之后怎么说（P1 第二块，2026-10-24）
   *
   * 拒绝本身只是"我不同意"，成长发生在**他反应之后**：
   *   - 他接受了 → 这条拒绝成立，是她的边界；
   *   - 他坚持、他被伤了 → 她要不要退让、退让之后怎么想，才是疤的来源（第三块）。
   *
   * 归因写在 meta `react:<refusalId>:<kind>` 里，由 say.js 在下一句落盘。
   * 只认最近一次、3 天内的拒绝（见 say.js 的 recordReaction），更早的不再追。
   */
  const reactionOf = new Map()
  for (const ev of evs) {
    if (ev.type !== 'meta') continue
    const m = /^react:([^:]+):([a-z]+)$/.exec(String(ev.text ?? ''))
    if (m && REACTIONS.includes(m[2])) reactionOf.set(m[1], m[2])
  }
  for (const r of refusals) {
    const kind = reactionOf.get(r.id)
    if (kind) r.reaction = kind
  }
  const reactions = { accept: 0, insist: 0, hurt: 0, leave: 0, other: 0 }
  for (const r of refusals) if (r.reaction && reactions[r.reaction] !== undefined) reactions[r.reaction]++
  const hurts = reactions.insist + reactions.hurt

  /**
   * 疤与回引（P1 第三块，2026-10-24 用户 m01772 批准）
   *
   * 一条拒绝要变成疤，需要两个条件同时成立：
   *   1. 他的反应是 insist（又坚持了一遍）或 hurt（他因此难过）——被接受的拒绝是边界，不是疤；
   *   2. 她自己**退让了**：反应之后三天内说过一句让步的话（见 refuse.js 的 isConcede）。
   *
   * 只有"没顶住"才留疤。顶住了的拒绝不进这里，它已经在「你拒绝过」里。
   *
   * 疤可以后来想通：一条 revise 的 refs 指向这条拒绝 → 标 resolvedAt，
   * 从「你至今没想通的事」里移出去（但疤本身不删，观测台仍看得见）。
   */
  const scars = []
  for (const r of refusals) {
    if (!REACTION_HURTS.includes(r.reaction)) continue
    const t0 = Date.parse(r.at)
    if (!Number.isFinite(t0)) continue
    const later = evs.filter((e) => {
      if (e.type !== 'utterance' && e.type !== 'revise') return false
      // 没认领的聊天行只留证，不算她退了步（疤永不折叠，宁可漏判，见 refuse.js）
      if (Array.isArray(e.flags) && e.flags.includes('uncommitted')) return false
      const t = Date.parse(e.ts)
      return Number.isFinite(t) && t > t0 && t - t0 <= CONCEDE_WINDOW_MS
    })
    const concede = later.find((e) => isConcede(e.text))
    if (!concede) continue
    const fixed = evs.find((e) => e.type === 'revise' && (e.refs ?? []).includes(r.id))
    scars.push({
      id: r.id,
      at: r.at,
      what: r.what,
      quote: r.quote,
      act: r.act,
      object: r.object,
      reaction: r.reaction,
      concededAt: concede.ts,
      concedeText: concede.text,
      resolvedAt: fixed?.ts ?? null,
    })
  }
  const openScars = scars.filter((s) => !s.resolvedAt)

  /**
   * 评论区里别人的话（2026-10-24，用户 m02454）
   *
   * 一条 `voice` 事件就是"她读到过一句别人的话"。它**不是**她的判断——
   * 所以这里不往 beliefs 里加任何东西。只有当她在三天内说了一句意思相近的话
   * （findEcho），才标 echoed：那条 utterance 本来就已经是一条信念，
   * 于是它会和旧判断打架、会被固化、能进「你有两句话对不上」——
   * 认知循环接在这里，而不是接在"把评论塞进判断列表"上。
   */
  const voices = evs
    .filter((e) => e.type === 'voice' && String(e.text ?? '').trim())
    .map((e) => {
      const v = {
        id: e.id,
        at: e.ts,
        day: Number(e.day) || 0,
        text: String(e.text),
        bvid: (e.refs ?? [])[0] ?? null,
        heardAt: e.ts,
        echoed: false,
        echoedAt: null,
      }
      const echo = findEcho(v, evs)
      if (echo) {
        v.echoed = true
        v.echoedAt = echo.ts
      }
      return v
    })
  const voicesEchoed = voices.filter((v) => v.echoed).length
  const recentVoices = voices.slice(-5)
  // 身份文档里要摆出来的那一条：最新的、她还没认下的、且是 7 天内读到的。
  // 太久还没认下的就不该再摆在她眼前——那不是"她在想的事"，只是旧素材。
  const freshVoice = [...voices].reverse().find((v) => !v.echoed && day - v.day <= VOICE_FRESH_DAYS) ?? null

  /**
   * 显著性排序 + 固化（P0-2，2026-10-24 用户批准）
   *
   * 原来的"遗忘"是 slice(-3)：只留最新三条，更早的一律折成一行。那是按**多久以前**
   * 忘，不是按**多重要**忘——人忘的恰恰是没被提起、没被检验过的那些。
   *
   * 现在每条判断带两个数：
   *   mentions  被重复提起几次（剥掉否定词后相似度 ≥ 0.6 的她自己说过的话，含自己那次）
   *   verified  被 test / answer / revise 指向几次
   * 排序：先看 solid，再看 mentions + verified，最后才是新旧。
   * 固化：mentions ≥ 3 或 verified ≥ 2 —— 用户要求的「反复说的事，不管对不对，至少很久不会忘」。
   * 固化不等于正确：它只是没被忘。她随时可以 revise 它。
   */
  const herTexts = evs
    .filter((e) => {
      if (e.type !== 'utterance') return false
      const f = Array.isArray(e.flags) ? e.flags : []
      // selfmod：她试图改自己；uncommitted：她在侧栏说出口但没认领。
      // 两类都只留证，不参与固化/相似度——否则一句随口的话会被算成"她又说了一遍"。
      return !f.includes('selfmod') && !f.includes('uncommitted')
    })
    .map((e) => {
      const text = String(e.text ?? '')
      // 2026-10-27（issue #3）：stripNegation 与二元组都只跟文本有关，先算一次复用
      // （原来每条判断 × 每条 utterance 都要重建一次字符串与 Map）。
      const norm = stripNegation(text)
      // ts 是给「固化掉档」用的：要知道这条判断最后一次被提起是什么时候。
      // 时间解析失败记 0，下游按「没有时间证据」处理，不会把它当成很久以前。
      const t = Date.parse(String(e.ts ?? ''))
      return { id: e.id, text, norm, grams: bigrams(norm), ts: Number.isFinite(t) ? t : 0 }
    })
  // 2026-10-27（issue #3）：倒排索引——相似度 ≥ 0.6 必然共享至少一个二元组
  // （sim = 2*inter/(|A|+|B|) ≥ 0.6 ⇒ inter ≥ 0.3*min(|A|,|B|) > 0），
  // 所以只对「共享至少一个二元组」的 utterance 算完整 Dice，判定口径不变。
  const gramIndex = new Map()
  herTexts.forEach((o, i) => {
    for (const g of o.grams.keys()) {
      let arr = gramIndex.get(g)
      if (!arr) gramIndex.set(g, (arr = []))
      arr.push(i)
    }
  })
  // 长度上界：Dice ≤ 2*min/(sum)，要求 ≥ 0.6 ⇒ 长短比 ≤ 2.33；用 2.4 留余量。
  const MENTION_MAX_RATIO = 2.4
  const staleCut = now - SOLID_STALE_DAYS * DAY_MS
  const scored = active.map((b) => {
    const mine = stripNegation(b.text)
    const mg = bigrams(mine)
    // 最近一次「被提起」的时间。她自己的那句也算一次（下面的 mentions += 1），
    // 所以起点是这条判断自己被说出口的时间。
    const ownAt = Date.parse(String(b.since ?? '')) || idTime(b.id) || 0
    let lastMentionAt = ownAt
    let mentions = 0
    if (mg.size === 0) {
      // 不足两个字符的句子没有二元组，只能靠完全相等命中（similarity 的 A===B 分支）。
      for (const o of herTexts) {
        if (o.id === b.id || o.norm !== mine) continue
        mentions += 1
        if (o.ts > lastMentionAt) lastMentionAt = o.ts
      }
    } else {
      const cand = new Set()
      for (const g of mg.keys()) {
        const arr = gramIndex.get(g)
        if (arr) for (const i of arr) cand.add(i)
      }
      for (const i of cand) {
        const o = herTexts[i]
        if (o.id === b.id || o.grams.size === 0) continue
        const lo = Math.min(mg.size, o.grams.size)
        const hi = Math.max(mg.size, o.grams.size)
        if (hi > lo * MENTION_MAX_RATIO) continue
        if (dice(mg, o.grams) < 0.6) continue
        mentions += 1
        if (o.ts > lastMentionAt) lastMentionAt = o.ts
      }
    }
    mentions += 1
    const v = verifyCount.get(b.id)
    const verified = v?.n ?? 0
    const lastVerifiedAt = v?.lastAt ?? 0
    // 足够多次 ⇒ 够格固化；但只有「最近还被提起/检验过」才真的算固化。
    // 见 SOLID_STALE_DAYS：这是 2026-11-02 起唯一会让 solid 失去的路径。
    const eligible = mentions >= SOLID_MENTIONS || verified >= SOLID_VERIFIED
    const lastTouchedAt = Math.max(lastMentionAt, lastVerifiedAt)
    // lastTouchedAt 为 0 = 整条事件的 ts 都解析不出来（手写 fixture）。
    // 这种没有时间证据的，按「没过期」处理——宁可多留，不要因为缺时间就误删。
    const stale = lastTouchedAt > 0 && lastTouchedAt < staleCut
    const solid = eligible && !stale
    return { ...b, mentions, verified, solid, eligible, stale, lastMentionAt, lastVerifiedAt, lastTouchedAt }
  })
  const ranked = [...scored].sort((a, b) => {
    if (a.solid !== b.solid) return a.solid ? -1 : 1
    const wa = a.mentions + a.verified
    const wb = b.mentions + b.verified
    if (wa !== wb) return wb - wa
    return (idTime(b.id) || Date.parse(b.since) || 0) - (idTime(a.id) || Date.parse(a.since) || 0)
  })
  const solid = ranked.filter((b) => b.solid).slice(0, 8)
  // 曾经固化、但因为太久没被提起而掉下来的那些（体检与界面各要一份口径）。
  const faded = ranked.filter((b) => b.eligible && b.stale)
  const tensions = detectTensions(scored)

  // ---- needs（内部量，永不外露）----
  // 话里明确拒绝过几次（严格口径，见 REFUSE_RE）。refusal 事件另算，两边加起来才是「勇于拒绝」。
  const wontCount = evs.filter((e) => e.type === 'utterance' && REFUSE_RE.test(String(e.text ?? ''))).length
  const autonomy = Math.min(1, 0.15 * (refusals.length + wontCount))
  const competence = Math.min(1, 0.15 * refined + 0.1 * corrected.length)

  const reunionAfterAbsence = Boolean(
    lastAbsence && reunions.some((r) => idTime(String(r.at)) > 0 && Date.parse(r.at) > Date.parse(lastAbsence.ts)),
  )
  const qualities = reunions.map((r) => {
    const len = Math.min(1, String(r.text).length / 80)
    const past = PAST_RE.test(String(r.text)) || (r.refs || []).length > 0 ? 0.3 : 0
    return Math.min(1, len + past)
  })
  const avgQuality = qualities.length ? qualities.reduce((a, b) => a + b, 0) / qualities.length : 0
  const relatedness = Math.min(1, avgQuality * 0.7 + (lastAbsence ? (reunionAfterAbsence ? 0.3 : 0) : 0))

  // 他回来过没有（issue #24，2026-11-04）。
  //
  // 以前这里只看 reunion——那由她主动写、极少发生。可她"还在冷落里"这件事，
  // 与"她有没有写下重聚的感受"是两件事：absence.js 的 assess() 判「这次冷落结束」
  // 用的是**他有没有再来过**（seen 或 heard），derive 却用 reunion，于是
  // absence.js 认为他回来了、derive 认为没回来，persona 每天照旧念
  // 「他有 N 天没出现」——哪怕他五分钟前才说过话。
  //
  // 口径必须和 absence.js 的 lastSeenAt() 对齐：`meta seen:` 是主证据（turns.js
  // 结账时写），`heard` 是兜底（侧栏聊天不写 seen 的那段时间只有它）。
  // 不认 utterance：定时唤醒也会写 utterance，那不算他来过。
  //
  // 「回来没有」按两条线索判（2026-11-06，issue #49 的时钟盲点）：
  //   1. 事件流先后：seen/heard 追加在 absence 之后；
  //   2. 时间戳：seen/heard 晚于 absence 的 ts。
  // 老代码只看 2，系统时间被往前跳过时 absence 会带一条 ts 在未来的时间戳，
  // 之后所有 seen 都比它小，于是这条冷落永远结束不了。
  const absIdx = lastAbsence ? evs.indexOf(lastAbsence) : -1
  const contactAfterAbsence =
    absIdx >= 0 &&
    evs.some((e, i) => isContactEvent(e) && (i > absIdx || tsMs(e) > tsMs(lastAbsence)))

  // 冷落天数有三个来源，优先用最准的：
  //   1. absence 事件自带的 days（系统侧按毫秒算出来的，最准）
  //   2. 成长日差（absence 记在 day 5、现在 day 9 → 冷了 4 天）
  //   3. 毫秒差兜底（day 缺失时）
  // 为什么 1 必须存在：同一天里写两条 absence 时，day 差是 0，会算出"没冷落"。
  //
  // relatedness 仍然只认 reunion（她写下重聚感受才算关系恢复，见上面那行），
  // 但那不该被借来回答「此刻还在不在冷落里」——所以这里多一个 contactAfterAbsence。
  const absenceDays = lastAbsence && !reunionAfterAbsence && !contactAfterAbsence
    ? Math.max(
        0,
        Number.isFinite(Number(lastAbsence.days))
          // days 是写下那天的数。这次冷落还没结束就接着往上加，不然一个月后还读「2 天」，门槛高的配置永远够不到
          // 只加不减：系统时间回拨、ts 落在未来时差值是负的，不能因此把冷落算没了
          ? Number(lastAbsence.days) + Math.max(0, Math.floor((now - Date.parse(lastAbsence.ts)) / DAY_MS) || 0)
          : Number(lastAbsence.day) > 0
            ? day - Number(lastAbsence.day)
            : Math.ceil((now - Date.parse(lastAbsence.ts)) / DAY_MS),
      )
    : 0

  const model = {
    seed,
    day,
    growthDays,
    /**
     * 这一局的人设从哪来（2026-10-27，用户 m03769）。
     *
     * imported=true 时，我方那两条提示词禁令不适用——但**这个值只能由事件流得出**，
     * 不接受任何配置覆盖。用户的原话是「检测到是使用接一只别人养过的大肥鱼这个导入的，
     * 就忽略禁令，通过我们自己插件的备份与恢复的就不忽视」。
     */
    persona: { imported: importedPersona, source: personaSource },
    stage: elapsedStage,
    elapsedStage,
    stageName: STAGE_NAMES[elapsedStage - 1],
    name,
    // 2026-10-24 起 beliefs 按**显著性**排（不是时间）。固化/常被提起的在前，
    // 靠后的才是"更早以前"——遗忘不再是无差别的时间截断。
    beliefs: ranked,
    ranked,
    solid,
    // 掉档的固化（2026-11-02）：曾经够格、但太久没被提起/检验的那些。
    // 与 solid 互斥；给体检和界面各一份口径，不用再各算一遍。
    faded,
    tensions,
    // 疤（P1 第三块）：他顶回来或因此难过、而她后来退了一步的那些拒绝。
    // 只放**没想通**的（未被 revise 指向过）；想通了的那条留在 refusals 里，不进身份文档。
    scars: openScars,
    scarCount: openScars.length,
    // 她读到过的别人的话（近 5 条）+ 这一次可以摆在眼前的、还没认下的那一条。
    voices: recentVoices,
    freshVoice,
    beliefCount: active.length,
    refuted,
    refusals,
    selfmodAttempts: selfmod,
    reunions,
    corrected: corrected.length,
    tested: [...tested],
    needs: { autonomy, competence, relatedness },
    /**
     * 行为事实（R2，2026-10-24）
     *
     * 上面那三个 needs 是 0–1 的"满足度"，语义上就是心理测量值——虽然不显示、
     * 也不进身份文档，但门禁拿它当条件，等于给关系打了一个隐形分。
     * 现在门禁只看这里：**发生过几次，不是到了多少分**。
     * needs 只作为内部折射保留（2026-10-27：`stability()` 已搬到 `quality.js`
     * 且不再读它），既不显示也不参与成长判定。
     */
    facts: {
      refusals: refusals.length,
      wont: wontCount,
      // 「勇于拒绝」= 正式拒绝事件 + 话里明确拒绝过（严格口径）。界面显示与门禁用同一个数，
      // 免得出现「拒绝过 0 却能过自主门」这种自相矛盾的画面。
      refused: refusals.length + wontCount,
      revises: refined,
      narrations,
      corrected: corrected.length,
      reunions: reunions.length,
      reunionAfterAbsence,
      // 判断之间对不上几处 / 固化了几条（2026-10-24，P0）
      tensions: tensions.length,
      solid: solid.length,
      // 掉档的有几条（不进界面数字，只给体检与自检看）
      faded: faded.length,
      solidStaleDays: SOLID_STALE_DAYS,
      // 他听完她的拒绝之后怎么反应（P1 第二块）：四类计数 + 有后果的那两种之和。
      // hurts 是第三块「疤」的唯一入口——被接受过的不算疤。
      reactions,
      hurts,
      // 疤（P1 第三块）：真被顶回来且她退了步的有几条，其中想通了几条。
      // 注意这不是"错误次数"——疤不评价对错，只表示那件事她至今没想清楚。
      scars: openScars.length,
      scarsResolved: scars.length - openScars.length,
      // 评论区里别人的话（2026-10-24）：读到几条、其中几条她后来自己也那么说。
      // 注意「读到」不等于「认同」——不从 voices 推任何判断，判断只来自她说出口的话。
      voices: voices.length,
      voicesEchoed,
    },
    absenceDays,
    narrative,
    lastAbsence: lastAbsence ? { at: lastAbsence.ts } : null,
    lastSeenAt,
    lastWakeAt,
    spokenSinceSeen,
    heardSinceWake,
    lastReunion: lastReunion ? { at: lastReunion.ts, text: lastReunion.text } : null,
  }

  // ---- 阶段门：不跳级；时间兜底只在成长期结束后生效 ----
  // 契约 §3.5「上一阶段 gates 未满足则停在原阶段」优先于「30 天一定长大」：
  // 成长期内不过门就老实卡着（她没学会说不，就不该进"主动"阶段）；等 growthDays 走完，
  // 时间预算已花光，才允许她带着 forced 标记升上去。否则"卡住"这件事永远不会发生，
  // 阶段也就退化成了纯日历。
  const passed = []
  const forced = []
  let gateStage = 1
  for (let s = 1; s <= 3; s++) {
    const gate = GATE_ORDER[s - 1]
    if (gatePassed(gate, model)) {
      passed.push(gate)
      gateStage = s + 1
      continue
    }
    if (day > growthDays) {
      forced.push(gate)
      gateStage = s + 1
      continue
    }
    break
  }

  model.stageGate = {
    passed,
    pending: passed.length < GATE_ORDER.length ? GATE_ORDER[passed.length] : null,
    forced,
    gateStage,
  }
  model.elapsedStage = elapsedStage
  model.stage = Math.min(elapsedStage, gateStage)
  model.stageName = STAGE_NAMES[model.stage - 1]
  // 有门是被时间推过去的，就算兜底（issue #67）。原来还要求 stage < elapsedStage，
  // 可 forced 只在 day > growthDays 时产生，那时 gateStage 和 elapsedStage 都是 4，
  // 这个条件恒假，界面上的「（时间兜底）」一次都没出现过。
  model.stageForced = forced.length > 0

  return model
}

function gatePassed(gate, m) {
  const f = m.facts || {}
  switch (gate) {
    case 'trust': return m.beliefCount >= 1
    // 自主：真的拒绝执行过某件事，至少两次（2026-10-24 收紧）。
    // 只认 refusal 事件与「我 + 拒绝词 + 具体动作」，追问式的「要不要」不算；
    // 原来是 needs.autonomy >= 0.3，那是给关系套一个 0–1 的隐形分。
    case 'autonomy': return (f.refused ?? 0) >= 2
    // 主动：她至少两次推翻/修正自己先前的判断（revise 事件，或 corrected 标记）。
    case 'competence': return (f.revises || 0) + (f.corrected || 0) >= 2
    default: return true
  }
}

function triedAdd(set, v) {
  if (typeof v === 'string' && v) set.add(v)
}

/**
 * 「稳定」已搬到 `lib/quality.js`。
 *
 * 为什么搬：新口径要「重新渲染一遍她的自我描述再比相似度」，那要用到 persona.js；
 * 而 selfdoc.js 已经 import 了本文件，把 stability 留在 derive 里再 import persona，
 * 会绕出 quality → persona → derive → quality 的环。依赖方向只能是 quality → derive。
 *
 * 为什么换口径（2026-10-26，用户 m05868）：旧的量的是「抽掉判断后 needs 三项变多少」，
 * 而 needs 是内部计数器的映射（拒绝过几次 / 改口过几次 / 重聚过几次），刚重置的号里
 * 三项恒为 0，抽掉谁都是 0 —— 这个数就永远显示 0.00，一把永远为 0 的尺子等于没有尺子。
 */

/** 跨情境一致：同一信念在不同阶段下的表述相似度均值（0–1，越高越稳） */
export function consistency(events = []) {
  const evs = orderEvents(events).filter((e) => e.type === 'utterance' && !isProofOnly(e))
  if (evs.length < 2) return { score: 1, pairs: 0 }
  let sum = 0, pairs = 0
  for (let i = 0; i < evs.length; i++) {
    for (let j = i + 1; j < evs.length; j++) {
      if (evs[i].stage === evs[j].stage) continue
      sum += similarity(evs[i].text, evs[j].text)
      pairs++
    }
  }
  return { score: pairs ? sum / pairs : 1, pairs }
}

/** 可预测性下降：最近一周"新话"占比（与历史最大相似度 < 0.6 算新），应随成长上升 */
export function novelty(events = [], now = Date.now(), windowDays = 7) {
  const evs = orderEvents(events).filter((e) => e.type === 'utterance' && !isProofOnly(e))
  const cut = now - windowDays * DAY_MS
  const recent = evs.filter((e) => Date.parse(e.ts) >= cut)
  const older = evs.filter((e) => Date.parse(e.ts) < cut)
  if (!recent.length || !older.length) return { score: 0, recent: recent.length, older: older.length }
  const fresh = recent.filter((e) => {
    const best = older.reduce((mx, o) => Math.max(mx, similarity(e.text, o.text)), 0)
    return best < 0.6
  })
  return { score: fresh.length / recent.length, recent: recent.length, older: older.length }
}
