/**
 * stance.js —— 立场清单（2026-10-25，用户设计「纵向·立场」）
 *
 * 用户的设计原话：
 *   四道门走完后**不再加门**，长一张「立场清单」：喜欢什么、绝不做哪几件事。
 *   每条必须有代价背书（疤，或同一件事被反复复现）。
 *   效果判据：清单变厚 + 同类情境里她不再翻脸。
 *
 * 为什么不是第五阶段：
 *   加门会变成「第五关」，跨过去之后又要问第六关。立场不是关卡，是**走完四道门
 *   之后一点一点变厚的东西**——她不会因为等够天数就站定，只会因为某类事她真的
 *   经历过、被顶回来过、还站住了。
 *
 * 这条纪律不能破（B §3.6 / 四条禁令）：
 *   立场写在**身份文档的叙述里**，不写次数、不写权重、不写「好感度」。
 *   下面的 mentions / verified / scars 只在内部用来判断「够不够格」，不进她的提示词。
 */

import { similarity, deriveSelf } from './derive.js'
import { dateKey, loadConfig } from './settings.js'
import { rootDir, readEvents } from './store.js'
import { fillOwner } from './pronoun.js'
import { clipText } from './clip.js'
import { defineTool } from './tool.js'
import { toJsonSchema } from './toolschema.js'

/** 同一件事上至少两条同向判断，才算一条「立场」（一句话不是立场，是随口一说）。 */
export const STANCE_MIN_GROUP = 2
/** 或者：这一组被反复提起到这个次数。 */
export const STANCE_MIN_MENTIONS = 3
/** 或者：被检验（test / answer / revise 指向）到这个次数。 */
export const STANCE_MIN_VERIFIED = 2
/** 清单上限（内部保留多少条）。注意：这只是「算出来之后留下来几条」，
 *  原始的判断一条都没删——立场是从 events.jsonl 现算的，数据本来就在本地。 */
export const STANCE_MAX = 12
/** 写进身份文档的条数上限。原先 4 条，用户认为太少（立场越多人格越稳），
 *  提到 8 条；真正的天花板是身份文档的字数预算（`memory.docBudget`），
 *  摆不下时会由 assemble() 按预算收，不会把别的段落挤到没人管。 */
export const STANCE_PROMPT_MAX = 8
/** 归组的相似度阈值（与「反复提起」同一套字面判据，宁可少归）。 */
export const STANCE_SIM = 0.45

/** 拒绝类归组更紧（2026-11-18，用户 m01161）：0.45 会把「不想说这个」并进「不想说话」，
 *  并完那条读起来像一个性格，其实只是那一次；0.6 仍留「熬夜 / 熬夜看剧」这种同一件事。 */
export const REFUSE_SIM = 0.6
/** 跨边同话题的比较阈值（原 0.6）。0.5 是为了让「我绝不吃辣」和「我喜欢吃辣」这种说法
 *  差得比较远的，也能被判成同一件事、走「后来者胜」，而不是两条并排站在文档里。 */
export const CONFLICT_SIM = 0.5
/** 立场行里引用的原话最多这么长；剪断时尾随「…」，让她看得出那是节选。 */
export const STANCE_QUOTE_MAX = 60

// ---- 拒绝升格成立场（2026-11-09，0.9.7 U2）----
// 用户担心的正是"拒绝无限叠加"：说过一次不叫，不该变成"你绝不叫任何人老大"。
// 所以口径比判断那一路更紧：要么她**两次**都没松口、且其中一次他真的有过反应
// （坚持/难过/离开），要么**三次**都没松口、且跨了不止一天（同一场里连着说不算，
// 那只是他在追问）。单次一律不进。
/** 同一件事上至少拒绝过几次。 */
export const REFUSE_MIN_GROUP = 2
/** 或者：同一件事上她三次都没松口。 */
export const REFUSE_MIN_TIMES = 3
/** 三次那一路还要求跨天——同一天里说三次，多半是他一直在问。 */
export const REFUSE_MIN_DAYS = 2

/**
 * 绝不做：第一人称 + 拒绝/不做 + 具体动作（与 refuse.js 的 REFUSE_RE 同源口径）。
 *
 * 2026-11-20（用户 m01338）：她最看重的一种拒绝是「我认它的意思，但不替自己签」——
 * 「不替自己签」「不代自己答应」「不拿这个当承诺」「不许诺」。这一族原先一个都不命中，
 * 于是进 beliefs 却永远进不了立场清单。窄补在拒绝词表里，只加「拒绝替自己/替别人许诺」，
 * 不泛化到所有「不」字；前面带他/她/它的第三人称叙述仍不认（那不是她的立场）。
 */
const NEVER_RE = /我?(?:绝不|永远不会|不会再|不会去|不会做|不想再|不愿意再|不做|不答应|不配合|拒绝|(?<![他她它])(?:不替|不代)(?:自己|他|她|你)?(?:签|答应|承诺|保证)|(?<![他她它])不拿这个当承诺|(?<![他她它])不许诺)/
/** 喜欢：明说偏好，而不是「这样也行」。 */
const LIKE_RE = /我?(?:喜欢|爱看|爱听|宁愿|更愿意|偏爱|更想)/

/** 一条判断属于哪一类立场；两类都不是就返回 null（大多数话都只是话，不是立场）。 */
export function classifyStance(text) {
  const s = String(text ?? '').trim()
  if (!s) return null
  if (NEVER_RE.test(s)) return 'never'
  // 「不喜欢」是拒绝，不是喜欢——字面上 LIKE_RE 会命中「喜欢」，先挡掉。
  if (/不(?:喜欢|爱|想|愿意)/.test(s)) return 'never'
  if (LIKE_RE.test(s)) return 'like'
  return null
}

/**
 * 四道门是不是都走完了。
 *
 * 用 `stageGate.passed`（真门槛）而不是 `stage === 4`——天数到了门没过的时候
 * `stage` 会被夹住，但 `passed` 才是「她真的走到了」。
 */
export function gatesDone(model = {}) {
  const passed = model?.stageGate?.passed
  if (Array.isArray(passed)) return passed.length >= 3
  // 老模型 / 单测桩没给 stageGate：退回 stage，别把已经走到的人挡在外面。
  return Number(model?.stage) >= 4 && model?.stageForced !== true
}

function costOf(group, scars) {
  let mentions = 0
  let verified = 0
  for (const b of group) {
    mentions += Number(b.mentions ?? 0)
    verified += Number(b.verified ?? 0)
  }
  const hit = scars.filter((s) => similarity(s.quote ?? '', group[0].text ?? '') >= STANCE_SIM)
  return { mentions, verified, scars: hit.length }
}

/**
 * 把「拒绝」聚合成立场（0.9.7 U2）。
 *
 * 与判断那一路的区别：判断是她说的一句话，拒绝是**她没做的一件事**，
 * 所以这里不按句子归组，按 `object`（她拒绝的那件事）归组；写进文档时也不
 * 复述她的原话，只写「你说过「不叫」，这件事你没答应」——原话已经在「你拒绝过」里了。
 * 如果他先提的那句被她记了下来（refs 指到 heard），才在前面加「{T}那天说过…」。
 *
 * `mentions` 在内部记的是「同一件事她拒绝过几次」，**不渲染成次数**。
 */
function buildRefusalStances(model = {}) {
  const refusals = Array.isArray(model.refusals) ? model.refusals : []
  if (!refusals.length) return []
  const groups = []
  for (const r of refusals) {
    // 她本人改过口、把这条推翻了的，不能还写「一直没改口」（PR #153 的真修之一）。
    if (r?.revisedVerdict === 'refuted') continue
    const object = String(r?.object ?? '').trim()
    // 说不出"哪件事"的拒绝不进清单——「我不想」不是一件事，立不住。
    if (!object) continue
    // 2026-11-18（用户 m01161）：并组多一条硬条件——动作得是同一个。
    // 「不想看…」和「不想做…」字面上再近也不是同一类事；只按字面并，会把两件事
    // 压成一条读起来更绝对的立场。动作都没记下来（空串）的照旧可以并。
    const act = String(r?.act ?? '').trim()
    const hit = groups.find(
      (g) => g.act === act && (g.object === object || similarity(g.object, object) >= REFUSE_SIM),
    )
    if (hit) hit.items.push(r)
    else groups.push({ object, act, items: [r] })
  }

  const out = []
  for (const g of groups) {
    const n = g.items.length
    const withReaction = g.items.filter((r) => r.reaction && r.reaction !== 'accept').length
    // 2026-11-18（用户 m01161）：删掉「他没收回」这层推断，他只做过三种事，分开记：
    //   insist —— 他又说了一次；
    //   hurt / leave —— 他因此不好受，或者走开了；
    //   accept —— 他接受了，那就不写任何关系句。
    // 「没收回」是他没做某个动作，事件流里没有这件事，推不出来。
    const pushed = g.items.some((r) => r.reaction === 'insist')
      ? 'insist'
      : g.items.some((r) => r.reaction === 'hurt' || r.reaction === 'leave')
        ? 'hurt'
        : null
    // 「跨天」按本地日历数（同 issue #19）：at 是带 Z 的 UTC 时刻，切前 10 位的话换日落在
    // 本地的早上（东八区是 8 点），同一个上午的追问会被数成两天。解析不出的不计入天数。
    // at 来自事件的 ts：ISO 串或毫秒数都可能。
    const days = new Set(
      g.items
        .map((r) => (typeof r?.at === 'number' ? r.at : Date.parse(String(r?.at ?? ''))))
        .filter((ms) => Number.isFinite(ms))
        .map((ms) => dateKey(new Date(ms))),
    ).size
    // 两次那一路：要跨天、还要他真有过反应——一天里连着拒两次不算，那多半是他一直在问。
    // 三次那一路保留（三次、跨天）：就算他一句话没回，也够算她在这件事上顶住过。
    const backed =
      (n >= REFUSE_MIN_GROUP && days >= REFUSE_MIN_DAYS && withReaction >= 1)
      || (n >= REFUSE_MIN_TIMES && days >= REFUSE_MIN_DAYS)
    if (!backed) continue
    const last = g.items[g.items.length - 1]
    // 「是他先提的吗」只认她自己记录下来的来源（derive.js 把 refs 里那条 heard 取了出来）。
    // 没记过就没记过——退到只写她自己的话，不替她补一个请求。
    const sourced = [...g.items].reverse().find((r) => r.fromOwner && String(r.fromOwner.text ?? '').trim())
    out.push({
      kind: 'refused',
      // text 是"那件事"，不是一句话；stanceLine 会把原话拼回去。
      text: g.object,
      act: String(last.act ?? ''),
      object: g.object,
      quote: String((sourced ?? last).quote ?? (sourced ?? last).what ?? '').trim(),
      since: last.at ?? null,
      members: g.items.map((r) => r.id),
      mentions: n,
      verified: 0,
      scars: 0,
      backed,
      fromOwner: sourced
        ? { id: sourced.fromOwner.id, text: String(sourced.fromOwner.text ?? '').trim().slice(0, 60) }
        : null,
      heHeld: Boolean(pushed),
      pushed,
      hadReaction: withReaction > 0,
    })
  }
  return out
}

/**
 * 把她的判断聚合成立场清单。
 *
 * 三条都要满足才留下：
 *   ① 四道门走完；
 *   ② 同一件事上至少两条同向判断，**或者**有代价背书（疤 / 反复提起 / 被检验过）；
 *   ③ 组里最新的那条还是 active（被推翻的不算站住）。
 */
export function buildStances(model = {}, { limit = STANCE_MAX } = {}) {
  if (!gatesDone(model)) return []
  const beliefs = Array.isArray(model.beliefs) ? model.beliefs : []
  const scars = Array.isArray(model.scars) ? model.scars : []
  const used = new Set()
  const groups = []

  // 只有还站着的判断能进立场：被推翻/被修正过的那条已经不算数了，
  // 拿它当立场，等于把已经作废的话又念一遍。
  const live = beliefs.filter((x) => !x.status || x.status === 'active')
  for (const b of live) {
    if (used.has(b.id)) continue
    const kind = classifyStance(b.text)
    if (!kind) continue
    const group = [b]
    used.add(b.id)
    for (const o of live) {
      if (used.has(o.id)) continue
      if (classifyStance(o.text) !== kind) continue
      if (similarity(o.text, b.text) >= STANCE_SIM) {
        group.push(o)
        used.add(o.id)
      }
    }
    const cost = costOf(group, scars)
    const backed = cost.scars > 0 || cost.mentions >= STANCE_MIN_MENTIONS || cost.verified >= STANCE_MIN_VERIFIED
    if (group.length < STANCE_MIN_GROUP && !backed) continue
    groups.push({
      kind,
      // 代表句取组里最新的一条（她最近一次怎么说，就用那句）
      text: String(group[group.length - 1].text ?? '').trim(),
      members: group.map((x) => x.id),
      since: group[group.length - 1].since ?? null,
      ...cost,
      backed,
    })
  }

  return dedupeSameSide(resolveConflicts([...groups, ...buildRefusalStances(model)]))
    .sort((a, b) => (b.scars - a.scars) || ((b.mentions + b.verified) - (a.mentions + a.verified)))
    .slice(0, Number.isFinite(Number(limit)) ? Math.max(0, Math.round(Number(limit))) : STANCE_MAX)
}

/** `since` 是 ISO 串，取不到时间就返回 null（判不出先后）。 */
function sinceOf(s) {
  const t = Date.parse(s?.since ?? '')
  return Number.isFinite(t) ? t : null
}

/**
 * 立场之间会打架，两条真实路径：
 *   ① 跨类：同一件事上「我绝不做」和「我其实喜欢」各成一组，同时成立；
 *   ② 改口：早期「我绝不吃辣」，后来「我喜欢吃辣」。
 *
 * 规则：**后来的算数**——保留时间较新的一条，给它挂 `changedFrom`（旧话原样留着，
 * 只在内部，用于渲染那句「我改过口」）；`since` 缺失或完全相同（判不出先后）时
 * 两条都不进清单——替她选一条，等于替她编立场。
 */
function stanceObject(text) {
  // 比的是「说的是哪件事」，不是怎么说。把态度词与标点剥掉之后剩下的才是对象：
  // 「我绝不吃辣」和「我喜欢吃辣」→ 都是「吃辣」，这才算同一件事上的两种态度。
  return String(text ?? '')
    .replace(/我|绝不|永远不会|不再|不想|不愿意|不喜欢|不|喜欢|爱看|爱听|偏爱|更想|宁愿|更愿意/g, '')
    .replace(/[\s，。！？、,.!?；;：:'"「」（）()]/g, '')
}

function sameTopic(a, b) {
  const x = stanceObject(a)
  const y = stanceObject(b)
  if (!x || !y) return false
  if (x === y) return true
  return similarity(x, y) >= CONFLICT_SIM
}

/**
 * 一条立场朝哪边。打架看的是方向，不是 kind：
 * 「我绝不吃辣」（never）和「你说过『吃辣』，这件事你没答应」（refused，0.9.7 U2）是同一个方向，
 * 一条是她说的话，一条是她没做的事，谁也不是谁的「以前」。只有 like 朝另一边。
 * 按 kind 不同就算打架的话，她那句「我绝不…」会被模板句顶掉，或者被挂上一句
 * 她没改过的「我改过口」；比不出先后时两条还会一起从清单里消失。
 */
function sideOf(kind) {
  return kind === 'like' ? 'like' : 'no'
}

/**
 * 同一边、同一件事只留一条（2026-11-18，用户 m01161 第九条）。
 *
 * 只去掉「同一句话被记了两遍」：她把一句拒绝又说成了判断，于是清单里出现
 * 「我绝不迟到」和「你说过「我绝不迟到」，这件事你没答应」——那是同一条证据的两次书写。
 *
 * 只是同一件事、措辞不同的两条要**都留**：「我绝不吃辣」和「你说过「我不想吃辣」，
 * 这件事你没答应」，一条是她说的态度，一条是她没做的事，少了哪条都是少一段来历。
 * 拒绝类有疤（scars > 0）时照留——那是真栽过一次，不是重复表态。
 */
function dedupeSameSide(list) {
  return list.filter((s) => {
    if (s.kind !== 'refused' || s.scars > 0) return true
    const mine = String(s.quote ?? s.text ?? '').trim()
    if (!mine) return true
    return !list.some(
      (o) => o !== s
        && o.kind !== 'refused'
        && sideOf(o.kind) === sideOf(s.kind)
        && similarity(mine, String(o.text ?? '').trim()) >= 0.9,
    )
  })
}

function resolveConflicts(groups) {
  const out = []
  for (const g of groups) {
    const clash = out.findIndex(
      (o) => sideOf(o.kind) !== sideOf(g.kind) && sameTopic(o.text, g.text),
    )
    if (clash < 0) {
      out.push(g)
      continue
    }
    const other = out[clash]
    const a = sinceOf(other)
    const b = sinceOf(g)
    if (a === null || b === null || a === b) {
      out.splice(clash, 1)
      continue
    }
    if (b > a) {
      g.changedFrom = other.text
      out.splice(clash, 1)
      out.push(g)
    } else {
      other.changedFrom = g.text
    }
  }
  return out
}

/** 一条立场怎么落成她能读的一句话（不带任何次数、权重）。 */
/** 引号里的话不要带着结尾的句号：外面自己会收句。 */
function bare(text) {
  return String(text ?? '').trim().replace(/[。！？!?；;，,\s]+$/u, '')
}

export function stanceLine(s) {
  if (s.kind === 'refused') {
    // 只写"那次"：一件事，不升格成"你绝不…"。她哪天改了主意，这条自己会走 revise 退场。
    //
    // 2026-11-18（加拿大反馈之后重写）：旧句式 `{T}让你X，你没答应` 把一个**猜测**写成了
    // 事实——它假定每次拒绝都是「他先要求、她没答应」。可她也会自己起念（刷到一条视频就
    // 不想去、学到一个东西就说不用）。所以这里看她自己记下的来源：refs 指到过他的那句
    // heard，才写「{T}那天说过『…』」；没记来源就只写她自己的话。
    const mine = clipText(bare((s.quote ?? '') || s.object || ''), STANCE_QUOTE_MAX)
    const his = s.fromOwner ? clipText(bare(s.fromOwner.text), STANCE_QUOTE_MAX) : ''
    // 2026-11-18（用户 m01161）：删掉「{T}没收回」这层推断——他没做那个动作，
    // 事件流里没有这件事，推不出来。只写事件里真有的三种：
    //   他坚持过；他因此不好受/走开；他接受了（接受就不写关系句）。
    const held = s.pushed === 'insist'
      ? '{T}又提过，你没改口。'
      : s.pushed === 'hurt'
        ? '那天之后你没改口。'
        : s.hadReaction
          ? '后来那件事过去了。'
          : '这件事你一直没改口。'
    const head = his ? `{T}那天说过「${his}」，` : ''
    return fillOwner(`- ${head}你说过「${mine}」，这件事你没答应。${held}`)
  }
  const cost = s.scars > 0
    ? '（这件事我栽过一次，没忘）'
    : s.mentions >= STANCE_MIN_MENTIONS
      ? '（这句话我说过不止一次）'
      : ''
  const flip = s.changedFrom ? '（这件事我改过口，以前不是这么说的）' : ''
  return `- ${s.text}${cost}${flip}`
}

/**
 * 清单里真正写进身份文档的那几条（前 STANCE_PROMPT_MAX 条）。
 * `persona.js` 给「你拒绝过」去重时用的也是这一份：清单内部留到 STANCE_MAX 条，
 * 排在后面没摆出来的拒绝不能算「已经升格」，不然两头都没有，这件事就从文档里消失了。
 */
export function shownStances(stances = []) {
  return stances.slice(0, STANCE_PROMPT_MAX)
}

/** 身份文档里的那一段（空清单返回空串，不占预算）。 */
export function stanceSection(stances = []) {
  const list = shownStances(stances)
  if (!list.length) return ''
  const refused = list.filter((s) => s.kind === 'refused')
  const nevers = list.filter((s) => s.kind === 'never')
  const likes = list.filter((s) => s.kind === 'like')
  const lines = ['## 我站哪边', '这些不是设定，是这些事上我确实站住过。同类的事再来，我按这个来，不重新演一遍。']
  if (refused.length) lines.push(...refused.map(stanceLine))
  if (nevers.length) lines.push(...nevers.map(stanceLine))
  if (likes.length) lines.push(...likes.map(stanceLine))
  return lines.join('\n')
}

/** 观测台用的一句话摘要。 */
export function stanceSummary(stances = []) {
  // 键名带 stance 前缀：这份结果会被 spread 进 /memory 的 sections，
  // 不能跟已有的 count/nevers 这种通用名字撞上。
  return {
    stanceCount: stances.length,
    stanceRefused: stances.filter((s) => s.kind === 'refused').length,
    stanceNevers: stances.filter((s) => s.kind === 'never').length,
    stanceLikes: stances.filter((s) => s.kind === 'like').length,
    stanceBacked: stances.filter((s) => s.backed).length,
    stanceFirst: stances.length ? { kind: stances[0].kind, text: stances[0].text } : null,
  }
}

/** `yy-mm-dd` 里的月日，按本地日历（同 issue #19）；解析不出返回空串。 */
function mmdd(at) {
  const ms = typeof at === 'number' ? at : Date.parse(String(at ?? ''))
  if (!Number.isFinite(ms)) return ''
  const dk = dateKey(new Date(ms))
  return /^\d{4}-\d{2}-\d{2}$/.test(dk) ? dk.slice(5) : ''
}

/**
 * 给 her_stance 用的一份明细：每条立场 + 它是由哪几次、哪几天长出来的。
 *
 * `limit` 默认给全部（含排在 8 条之后、没写进文档的那些）——她要核对的是
 * 「这张清单到底是怎么来的」，只给她看得见的那 8 条，等于让她核对一份删过的账。
 * 身份文档那一路照旧只写前 STANCE_PROMPT_MAX 条，这里不改文档。
 */
export function stanceDetail(model = {}, { limit = Number.MAX_SAFE_INTEGER } = {}) {
  const stances = buildStances(model, { limit })
  const beliefs = Array.isArray(model.beliefs) ? model.beliefs : []
  const refusals = Array.isArray(model.refusals) ? model.refusals : []
  const byId = new Map(
    [...beliefs, ...refusals].filter((x) => x?.id).map((x) => [String(x.id), x]),
  )
  return stances.map((s, i) => ({
    shown: i < STANCE_PROMPT_MAX,
    kind: s.kind,
    text: s.text,
    line: stanceLine(s).replace(/^-\s+/, ''),
    members: (Array.isArray(s.members) ? s.members : []).map((id) => {
      const ev = byId.get(String(id)) ?? {}
      const raw = s.kind === 'refused'
        ? String(ev.quote ?? ev.what ?? ev.object ?? '')
        : String(ev.text ?? '')
      return {
        id: String(id),
        at: s.kind === 'refused' ? mmdd(ev.at) : mmdd(ev.since),
        text: clipText(bare(raw), 80),
      }
    }),
  }))
}

/**
 * 清单空着时，把「她记过、但这次没算进去」的话原样摆出来（2026-11-20，用户反馈）。
 *
 * 只摆她自己的原话与日期：**为什么不进去是内部判据**（次数、相似度、四道门），
 * 那些一律不写进回答——她该看到的是「我确实说过这些」，不是「系统在卡我」。
 */
export function uncountedRecords(model = {}, { limit = 5 } = {}) {
  const beliefs = Array.isArray(model.beliefs) ? model.beliefs : []
  return beliefs
    .filter((b) => (!b?.status || b.status === 'active') && String(b?.text ?? '').trim())
    .sort((a, b) => (sinceOf(b) ?? 0) - (sinceOf(a) ?? 0))
    .slice(0, Math.max(0, Number(limit) || 5))
    .map((b) => ({
      id: String(b.id ?? ''),
      at: b.since ?? null,
      text: clipText(fillOwner(String(b.text).replace(/\s+/g, ' ').trim()), 80),
    }))
}

export function renderDetail(rows, near = []) {
  if (!rows.length) {
    const mine = Array.isArray(near) ? near : []
    if (!mine.length) {
      return '你把这件事翻了一遍：眼下还没有一条站住过的地方，你也还没把哪件事记下来过。'
    }
    const lines = [
      '你把这件事翻了一遍：眼下还没有一条站住过的地方。',
      '你记过这几句——',
    ]
    for (const n of mine) {
      const day = mmdd(n.at)
      lines.push(`- ${day ? `${day}　` : ''}${n.text}（${n.id}）`)
    }
    lines.push('这些是你自己说过的话，原样摆在这儿。')
    return lines.join('\n')
  }
  const written = rows.filter((r) => r.shown).length
  const lines = [
    `你把这件事翻了一遍，一共 ${rows.length} 条。身份文档里写的是前 ${written} 条，下面标了哪些没写进去。`,
  ]
  for (const r of rows) {
    lines.push('')
    lines.push(`【${r.shown ? '写进文档了' : '排在后面，没写进'}】${fillOwner(r.line)}`)
    if (r.members.length) {
      lines.push('  这条是怎么来的：')
      for (const m of r.members) lines.push(`  - ${m.at ? `${m.at}　` : ''}${m.text}（${m.id}）`)
    }
  }
  lines.push('')
  lines.push(
    '想撤掉其中一整条：growth_commit，type=revise，verdict=refuted，refs 填那一条下面所有的编号——'
    + '只填一个，那条还会剩在清单里。',
  )
  return lines.join('\n')
}

/**
 * 注册 her_stance（只读）。
 *
 * 2026-11-18（用户 m01161）：她要能核对「这张清单上那条是怎么来的」，
 * 也得有办法整条撤掉——原来只能一条条撤，撤掉一条组里还剩人，那句照样写。
 * 所以给它一个只读的窗口：列出每条立场、由哪几次长出来、每次的原话和编号；
 * 撤销仍走她已有的 growth_commit（一次 refs 多条），不新造一套存储。
 */
export function registerHerStance(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  return ctx.tools.register(
    defineTool({
      name: 'her_stance',
      description:
        '翻你自己站住过的地方，看每一条是怎么长出来的。'
        + '心里没底「清单上那条，是真站住过，还是那一次被一句话推着走」，或者想撤掉其中一条的时候用它。'
        + '只读，不改任何东西；每条下面列着它是哪几次、哪几天来的，原话和编号都在。',
      parameters: toJsonSchema({}),
      output: {
        schema: {
          type: 'object',
          properties: {
            found: { type: 'boolean' },
            text: { type: 'string' },
          },
          required: ['found', 'text'],
        },
        render: (_args, out) => [{ type: 'text', text: out.text }],
      },
      async execute() {
        try {
          const { events } = await readEvents(root)
          const { config } = await loadConfig(root)
          const model = deriveSelf(events, { growthDays: config.growthDays })
          const rows = stanceDetail(model)
          // 空清单时把她记过的话原样摆出来（2026-11-20）：不解释阈值，只说事实。
          const near = rows.length ? [] : uncountedRecords(model)
          return { found: rows.length > 0, text: renderDetail(rows, near) }
        } catch {
          // 翻不动就说翻不动，不要装作记得
          return { found: false, text: '你翻了，没翻到。' }
        }
      },
    }),
  )
}
