/**
 * proactive.js —— 她主动开口（本机实验，2026-10-30，用户 m04610，只在 .dev 下启用）
 *
 * 用户要的：不等他来找她，她自己判断"现在有没有话想说"，说一句就投进
 * 他和她平时说话的那条会话里；允许她什么都不说。
 *
 * 三条设计约束（和 dream.js 同源的思路）：
 *   1. **触发不是指令**。这里只给她事实（几点、多久没人说话、这几天发生了什么、
 *      哪些话还悬着），并明确写「可以说，也可以什么都不做」。
 *      不写「你应该找他」——那会变成系统在演她。
 *   2. **她说的必须是真的**：`her_say` 要求 refs 指向事件流里真实存在的事件
 *      （1–6 条）。理由同梦：不指认材料，就等于编一句好听的话。
 *   3. **频率是上限，不是行为要求**。每天最多 maxPerDay 次、两次之间至少隔
 *      cooldownHours；概率随"多久没人说话"缓慢上升，但不保证一定触发。
 *
 * 可见性：0.9.0 起公开（工具注册、提示词段、设置页卡片三处同时打开）。
 * 公开版既没有这个工具，也不会有这个回合。这是 0.6.10 的教训——不要用
 * 「安装路径里有没有 node_modules」去猜。
 */

import { toJsonSchema } from './toolschema.js'
import { rootDir, readEvents, appendEvent } from './store.js'
import { dateKey, loadConfig, inWindow } from './settings.js'
import { defineTool } from './tool.js'
import { guardWrite } from './tenant.js'
import { logLine } from './log.js'
import { tsMs, HER_TYPES } from './schema.js'

/** 一天的默认上限。 */
export const PROACTIVE_DEFAULTS = Object.freeze({
  enabled: false,
  maxPerDay: 2,
  minIdleHours: 6,
  baseChance: 0.15,
  gainPerHour: 0.05,
  maxChance: 0.6,
  cooldownHours: 4,
})

/** 一句主动的话最长多少字。 */
export const PROACTIVE_MAX = 600
/** 一条话最多引几件事。 */
export const PROACTIVE_REFS_MAX = 6
/** 可以当材料的事件类型（她自己的话与听见的东西；不含 meta/系统记账）。 */
export const PROACTIVE_MATERIAL = Object.freeze([
  'utterance', 'revise', 'reunion', 'narration', 'refusal', 'heard',
])
/**
 * 空手回合投进对话里的那一句（2026-11-04 用户 m00428 之后）。
 *
 * 以前是「（现在没有人跟你说话。）」—— 宿主的 sessionController.prompt() 把它按真人发言
 * 画成用户气泡，用户怎么都能看见。现在改走 source.kind = 'fish-wake' 的
 * agent.followup()（见 lib/deliver.js），前端把它画成一张默认收起的折叠条，
 * 正文只在点开后出现。处境本来就走 system prompt 段，这里只留一个空投递信号。
 */
export const PROACTIVE_PING = ' '

/**
 * 「缺工具就开口要」（2026-11-05，用户 m02031）。
 *
 * 用户的诉求：她真想做某件事、但手上没有那个工具时，要敢问，而不是绕过去、
 * 或者干脆放弃。缺工具不是失败，也不是她该自己硬扛的事。
 *
 * 写法上只说路径与许可，不派活：不问「你有没有想要什么工具」——那是逼她编。
 */
export const TOOL_ASK_NOTE = '（如果你想到要做什么、但手上没有那件工具：直接说你要它做什么，' +
  '问主人能不能给你装上；也可以开一张 ask 卡问。缺工具不是失败，不用绕着走。）'

/**
 * 读配置并夹紧。老配置没有 proactive 这一组，用默认值。
 * @param {object} config
 * @returns {{enabled:boolean,maxPerDay:number,minIdleHours:number,baseChance:number,gainPerHour:number,maxChance:number,cooldownHours:number,sendTools:string[],foldSilent:boolean,idleCountsSeen:boolean}}
 */
export function proactiveConfig(config = {}) {
  const raw = config?.proactive ?? {}
  const num = (v, d, lo, hi) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return d
    return Math.min(hi, Math.max(lo, n))
  }
  return {
    enabled: raw.enabled === true,
    maxPerDay: Math.round(num(raw.maxPerDay, PROACTIVE_DEFAULTS.maxPerDay, 0, 12)),
    minIdleHours: num(raw.minIdleHours, PROACTIVE_DEFAULTS.minIdleHours, 0, 240),
    baseChance: num(raw.baseChance, PROACTIVE_DEFAULTS.baseChance, 0, 1),
    gainPerHour: num(raw.gainPerHour, PROACTIVE_DEFAULTS.gainPerHour, 0, 1),
    maxChance: num(raw.maxChance, PROACTIVE_DEFAULTS.maxChance, 0, 1),
    cooldownHours: num(raw.cooldownHours, PROACTIVE_DEFAULTS.cooldownHours, 0, 240),
    sendTools: Array.isArray(raw.sendTools) ? raw.sendTools.map((x) => String(x ?? '').trim()).filter(Boolean) : [],
    foldSilent: raw.foldSilent !== false,
    idleCountsSeen: raw.idleCountsSeen === true,
  }
}

/**
 * 静默回合的记账行前缀（2026-11-05，用户 m00803）。
 *
 * 与 `proactive-turn:` 分开记，是因为两件事在语义上完全不同：
 *   - `proactive-turn:` = 她醒过来、**真的说了话**——占额度、起冷却；
 *   - `proactive-silent:` = 她醒过来、看了一圈、没有开口——不占额度、不起冷却，
 *     但要单独限个次数（见 `SILENT_MAX_PER_DAY`），否则「一直醒、一直不说」
 *     会变成另一种刷屏：每一轮都往她的上下文里塞一段 reasoning。
 *
 * 0.8.8 及以前只有一个 `proactive-turn:`，投递成功就写（哪怕她一个字没说），
 * 于是「醒着但没话说」也吃掉当天的额度与冷却。市场插件 `dsh-speak-up` 0.2.9
 * 的 issue #8 是同一类 bug（冷却按投递算、不按她真的说话算），真机上发生过
 * 「投递成功、1 秒结束、一个字没发却吃掉整个冷却」。
 */
export const SILENT_MARK = 'proactive-silent:'

/** 一天最多允许几次静默醒来。不占 `maxPerDay`，单独封顶。 */
export const SILENT_MAX_PER_DAY = 4

/** 一次静默之后至少隔这么久才再让她醒——不然她会连着醒、连着不说。 */
export const SILENT_QUIET_HOURS = 2

/** 今天已经开过几次空手回合（meta `proactive-turn:<dk>:<ts>`）。 */
export function turnsToday(events = [], dk = '') {
  if (!dk) return 0
  let n = 0
  for (const e of events) {
    if (e?.type !== 'meta') continue
    if (String(e.text ?? '').startsWith(`proactive-turn:${dk}:`)) n += 1
  }
  return n
}

/** 上一次空手回合是什么时候（毫秒）。 */
export function lastTurnAt(events = []) {
  let at = 0
  for (const e of events) {
    if (e?.type !== 'meta') continue
    if (!String(e.text ?? '').startsWith('proactive-turn:')) continue
    const ts = tsMs(e)
    if (Number.isFinite(ts) && ts > at) at = ts
  }
  return at
}

/** 今天已经静默地醒过几次（meta `proactive-silent:<dk>:<ts>`）。 */
export function silentToday(events = [], dk = '') {
  if (!dk) return 0
  let n = 0
  for (const e of events) {
    if (e?.type !== 'meta') continue
    if (String(e.text ?? '').startsWith(`${SILENT_MARK}${dk}:`)) n += 1
  }
  return n
}

/** 上一次静默醒来是什么时候（毫秒）。 */
export function lastSilentAt(events = []) {
  let at = 0
  for (const e of events) {
    if (e?.type !== 'meta') continue
    if (!String(e.text ?? '').startsWith(SILENT_MARK)) continue
    const ts = tsMs(e)
    if (Number.isFinite(ts) && ts > at) at = ts
  }
  return at
}

/**
 * 哪些事件算「真的发生过一次对话」——idle 时钟只认这些（2026-11-01，用户 m02507）。
 *
 * 原来这里取的是**全部事件的最新一条**，于是 quiet（今天没找到模板）、watched（她看了条视频）、
 * diary（到点写日记）这些系统记账都能把「安静了多久」清零。真机实证：2026-10-30 22:03:07，
 * 她实际 17.55 小时没说过话，插件却判「刚说过话，还不到时候」。本机 441 条事件里
 * meta:quiet 占 272 条（61.7%），真正的人话只有 28 条（6.3%）。
 *
 * 算数：她自己的六种（HER_TYPES）+ 听见的话（heard）+ 别人的评论（voice）
 *       + 请求与回答（ask/answer）。
 *
 * 2026-11-05 真机（用户 m02797）：`seen:` 曾经也算，结果它被**别的会话**的用户活动
 * 误写——他在这台机器上跟别的 agent 说话，她的「安静了多久」就被清零，
 * 于是 `minIdleHours` 永远不满足，主动搭话一次都开不出来
 * （日志里 `proactive skip 刚说过话，还不到时候`，而 `idleHours` 只有 0.02）。
 * 现在 `seen:` 不进 idle：只有真的有话落进她的房间（`heard`）才算「他来过」。
 * 不算：quiet / sched / wake / fired / sleep / diary / looked / browse / watched / proactive-turn 等记账行。
 */
export const SPOKE_TYPES = Object.freeze([...HER_TYPES, 'heard', 'voice', 'ask', 'answer'])

/** 这一条事件是不是「有人真的说了话」。记账行一律不算。 */
export function countsForIdle(e) {
  // 记账行（含 seen:）一律不算——见上面 2026-11-05 那段。
  return SPOKE_TYPES.includes(String(e?.type ?? ''))
}

/**
 * 距离上一次**真的有人说话**，过了多少小时。没有记录时返回 Infinity。
 * countSeen：连 `seen:` 也算（`proactive.idleCountsSeen`），给对话不进事件流的部署用。
 */
export function idleHoursOf(events = [], now = Date.now(), { countSeen = false } = {}) {
  let last = 0
  for (const e of events) {
    const seen = countSeen && e?.type === 'meta' && String(e.text ?? '').startsWith('seen:')
    if (!seen && !countsForIdle(e)) continue
    const ts = tsMs(e)
    if (Number.isFinite(ts) && ts > last) last = ts
  }
  if (!last) return Infinity
  return Math.max(0, (now - last) / 3_600_000)
}

/**
 * 她自己开口的节奏，随成长变（2026-11-04，用户 m01466）。
 *
 * 之前这里是**恒温**的：`proactiveState()` 的签名里没有 model，于是第 3 天和第 27 天
 * 算出来的 chance 一个数都不差。成长只影响 `plan()` 派哪张卡（被叫醒时手里拿什么），
 * 完全不影响「她多久才自己想开口一次」——用户的原话是「这个自己开口的出口不该是恒温的」，
 * 他养她的目的是「有自己的性格和特点」。
 *
 * 三个杠杆全部从**已经有的事件**推出来：不写盘、不加配置项、不让她看见任何一个数。
 * 所以不撞 no-read-self（那条禁的是她读自己的数值，不是禁系统据事件做调度）。
 * `model` 为 null 时整段跳过，行为与 2026-11-04 之前一字不差——老测试都不用改。
 *
 * @returns {{baseChance:number, gainPerHour:number, maxChance:number, cooldownHours:number}}
 */
function growthLevers(model, events = [], now = Date.now(), cfg = {}) {
  const stage = Math.min(4, Math.max(1, Number(model?.stage) || 1))
  const shift = stage - 1
  let baseChance = cfg.baseChance + 0.02 * shift
  const gainPerHour = cfg.gainPerHour + 0.008 * shift
  // 封顶 0.80：再高就不是「她自己想不想」，而是「几乎一定会」——那等于把概率关掉。
  const maxChance = Math.min(0.8, cfg.maxChance + 0.06 * shift)
  let cooldownHours = cfg.cooldownHours
  let lastRevise = 0
  let lastHeard = 0
  for (const e of events) {
    const type = String(e?.type ?? '')
    if (type !== 'revise' && type !== 'heard' && type !== 'answer') continue
    const ts = tsMs(e)
    if (!Number.isFinite(ts)) continue
    if (type === 'revise') {
      if (ts > lastRevise) lastRevise = ts
    } else if (ts > lastHeard) lastHeard = ts
  }
  // 刚推翻过自己的话：有话要接着说，24 小时内更容易自己开口。
  if (lastRevise && now - lastRevise <= 86_400_000) baseChance += 0.1
  // 刚有人跟她说过话：余温还在，冷却不必等满 4 小时。
  if (lastHeard && now - lastHeard <= 86_400_000) cooldownHours = Math.min(cooldownHours, 2)
  return { baseChance, gainPerHour, maxChance, cooldownHours }
}

/**
 * 这一次该不该开门。纯函数：不读文件、不掷骰子。
 * @param {object} [opts.model] 她当前的成长档案（`deriveSelf()` 的返回）。
 *   传了才启用「节奏随成长变」；不传 = 2026-11-04 之前的恒温行为。
 * @returns {{ok:boolean, why:string, chance:number, idleHours:number, dk:string}}
 */
export function proactiveState({ config = {}, events = [], now = Date.now(), away = null, rested = false, model = null } = {}) {
  const cfg = proactiveConfig(config)
  const dk = dateKey(new Date(now))
  const idleHours = idleHoursOf(events, now, { countSeen: cfg.idleCountsSeen })
  const base = { chance: 0, idleHours, dk }
  if (!cfg.enabled) return { ...base, ok: false, why: '主动说话是关着的' }
  // 只在醒着的时间窗里：凌晨三点收到一句「我想你了」不是她自主，是她打乱了作息。
  // 配置里没有 window 时（测试/老数据）不拦，保持纯函数可测。
  const win = Array.isArray(config?.window) && config.window.length === 2 ? config.window : null
  if (win && !inWindow({ window: win }, new Date(now))) return { ...base, ok: false, why: '这个点不在她醒着的时段里' }
  if (away?.kind) return { ...base, ok: false, why: '她不在家' }
  if (rested) return { ...base, ok: false, why: '她今天请了假' }
  if (turnsToday(events, dk) >= cfg.maxPerDay) return { ...base, ok: false, why: '今天已经到上限' }
  // 静默醒来单独计数（2026-11-05，用户 m00803）：它们不占 maxPerDay，
  // 但也不能无限——一直在后台醒、一直不说话，等于把她的上下文当草稿纸。
  if (silentToday(events, dk) >= SILENT_MAX_PER_DAY) return { ...base, ok: false, why: '今天已经安静地醒过太多次了' }
  // 上一次醒来她没开口：隔开一点，别让「醒来」本身变成一种机械动作。
  const lastSilent = lastSilentAt(events)
  if (lastSilent && (now - lastSilent) / 3_600_000 < SILENT_QUIET_HOURS) return { ...base, ok: false, why: '上次醒来她没开口，隔一会儿再说' }
  // 节奏随成长变（2026-11-04，用户 m01466）；不传 model 时下面四个值就是配置原值。
  const lv = model
    ? growthLevers(model, events, now, cfg)
    : { baseChance: cfg.baseChance, gainPerHour: cfg.gainPerHour, maxChance: cfg.maxChance, cooldownHours: cfg.cooldownHours }
  const last = lastTurnAt(events)
  if (last && (now - last) / 3_600_000 < lv.cooldownHours) return { ...base, ok: false, why: '还在冷却里' }
  if (idleHours < cfg.minIdleHours) return { ...base, ok: false, why: '刚说过话，还不到时候' }
  const chance = Math.min(lv.maxChance, lv.baseChance + Math.max(0, idleHours - cfg.minIdleHours) * lv.gainPerHour)
  return { ...base, ok: true, why: '', chance }
}

/** 最近几天可以用作材料的条目（她自己的话、听见的话）。 */
export function recentMaterial(events = [], { now = Date.now(), days = 3, limit = 8 } = {}) {
  const since = now - days * 86_400_000
  const out = []
  for (const e of events) {
    if (!PROACTIVE_MATERIAL.includes(e?.type)) continue
    const ts = tsMs(e)
    if (!Number.isFinite(ts) || ts < since) continue
    const text = String(e.text ?? '').trim()
    if (!text) continue
    out.push({ id: e.id, type: e.type, ts, text })
  }
  out.sort((a, b) => b.ts - a.ts)
  return out.slice(0, limit)
}

/** 还悬着的事：她问过但没人答、出门那趟还等核对、她说了但没有人接。 */
export function looseEnds(events = [], { now = Date.now() } = {}) {
  const out = []
  const answered = new Set()
  for (const e of events) {
    if (e?.type === 'answer') {
      const id = String(e.ask?.askId ?? '')
      if (id) answered.add(id)
    }
  }
  for (const e of events) {
    if (e?.type !== 'ask') continue
    if (answered.has(String(e.id ?? ''))) continue
    const ts = tsMs(e)
    if (!Number.isFinite(ts) || now - ts > 3 * 86_400_000) continue
    out.push({ id: e.id, kind: 'ask', text: `你问过「${String(e.text ?? '').trim()}」，还没有得到答复。` })
  }
  return out.slice(0, 3)
}

/**
 * 空手回合的处境正文（走 system prompt 段，不进对话）。
 * 只写事实与许可，不写"你应该"。
 */
export function proactiveSection({ now = Date.now(), state = {}, material = [], loose = [], sendTools = [], countSeen = false } = {}) {
  const at = new Date(now)
  const hh = String(at.getHours()).padStart(2, '0')
  const mm = String(at.getMinutes()).padStart(2, '0')
  const idle = Number.isFinite(state.idleHours) ? `${state.idleHours.toFixed(1)} 小时` : '很久'
  const lines = [
    '（现在没有人跟你说话。这一轮不是谁找你，也不是日程安排的醒；是你自己醒着，想不想开口由你。）',
    `现在是 ${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${hh}:${mm}；距离上一次${countSeen ? '他来或你留下记录' : '留下记录'}已经 ${idle}。`,
  ]
  if (material.length) {
    lines.push('最近这几天你写下/听见的（要引用就指回 id，别改写事实）：')
    for (const m of material) {
      const t = m.text.length > 60 ? `${m.text.slice(0, 59)}…` : m.text
      lines.push(`- [${m.id}] ${m.type}：${t}`)
    }
  }
  if (loose.length) {
    lines.push('还有几件事悬着：')
    for (const l of loose) lines.push(`- [${l.id}] ${l.text}`)
  }
  if (sendTools.length > 0) lines.push(`想说什么就用 ${sendTools.join('、')}，不用等他先问。这一轮写下的正文只留在这条会话里，发不到聊天里。不想说，就什么都别写：不要写任何字，也不要解释为什么不说——这一轮没有回复也算正常。`)
  else lines.push('想说什么就说，不用等他先问——这一轮你写下的字会落在你们俩的对话里，他看得见。也可以再用 her_say 把它记进你自己的流水（refs 指回上面真实发生的事，1–6 条 id）。不想说，就什么都别写：不要写任何字，也不要解释为什么不说——这一轮没有回复也算正常。')
  lines.push(TOOL_ASK_NOTE)
  return lines.join('\n')
}

/** 事件流里有没有这个 id，且能不能当材料。 */
function refProblem(events, refs) {
  const byId = new Map(events.map((e) => [String(e.id ?? ''), e]))
  for (const id of refs) {
    const ev = byId.get(String(id))
    if (!ev) return `refs 里的 ${id} 在事件流里不存在；只填你翻得到的事。`
    if (!PROACTIVE_MATERIAL.includes(ev.type)) return `refs 里的 ${id} 不是你说过/听见过的话，不能当材料。`
  }
  return ''
}

/**
 * 记一句她主动说的话。
 * @returns {Promise<{ok:boolean, id?:string, note:string}>}
 */
export async function writeSay(root, { text = '', refs = [], sessionId = '', why = '', now = Date.now() } = {}) {
  const body = String(text ?? '').trim()
  if (!body) return { ok: false, note: '把想说的话写出来再记。' }
  if (body.length > PROACTIVE_MAX) return { ok: false, note: `一句最多 ${PROACTIVE_MAX} 字，说短一点。` }
  const list = (Array.isArray(refs) ? refs : []).map((x) => String(x ?? '').trim()).filter(Boolean)
  if (!list.length) return { ok: false, note: '得指回真实发生过的事：refs 填 1–6 条事件 id。' }
  if (list.length > PROACTIVE_REFS_MAX) return { ok: false, note: `一条最多引 ${PROACTIVE_REFS_MAX} 件事。` }

  const { events } = await readEvents(root)
  const problem = refProblem(events, list)
  if (problem) return { ok: false, note: problem }

  const { config } = await loadConfig(root)
  const dk = dateKey(new Date(now))
  // appendEvent 返回的就是写进去的那条事件（不是 {ok, event}，0.7.4 那次参数错位就是栽在这），
  // 所以判空只能判返回值本身。
  const stored = await appendEvent(
    { type: 'utterance', text: `（她主动说）${body}`, refs: list, ...(sessionId ? { sessionId } : {}) },
    { day: 1, stage: 1, source: 'tool' },
    root,
  ).catch(() => null)
  if (!stored?.id) return { ok: false, note: '这条没记下。' }
  await appendEvent(
    { type: 'meta', text: `proactive-say:${dk}:${why || 'free'}` },
    { day: 1, stage: 1, source: 'system' },
    root,
  ).catch(() => {})
  return { ok: true, id: stored.id, note: '记下了。' }
}

/**
 * 注册 `her_say`。0.9.0 起由 index.js 无条件调用。
 */
export function registerProactive(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  const log = deps.log ?? (() => {})

  ctx.tools.register(
    defineTool({
      name: 'her_say',
      description: [
        '你自己想开口的时候用这个：不是回复谁，是你主动说一句。',
        '必须指回真实发生过的事（refs 填 1–6 条你那几天写下/听见的事件 id）；',
        '不指认材料就等于编，写不进去。一天最多几次，说不说都可以。',
      ].join(''),
      parameters: toJsonSchema({
        type: 'object',
        properties: {
          text: { type: 'string', minLength: 1, maxLength: PROACTIVE_MAX, description: '你要说的那句话。' },
          refs: {
            type: 'array',
            minItems: 1,
            maxItems: PROACTIVE_REFS_MAX,
            items: { type: 'string' },
            description: '指回真实事件 id（1–6 条），用 her_recall 或最近记录里查到的。',
          },
          why: { type: 'string', maxLength: 80, description: '为什么现在想说（可选，只写进记录）。' },
        },
        required: ['text', 'refs'],
      }),
      output: {
        schema: toJsonSchema({
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            id: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['ok', 'note'],
        }),
        // recordOnly 只给 render 看（配了发送工具时回执换一句）
        // 2026-10-31 真机（10-30 那两轮）：这里原来直接返回字符串，宿主按 ContentBlock
        // 数组处理，`content.some` 当场抛 TypeError。她看到的工具结果是「Error: content.some
        // is not a function」——写入其实成功了，她却以为工具坏了，重试一次后放弃，一个字没说。
        // 签名同样是 (args, out)，跟 lib/keep.js:97 那些一样。
        render: (_args, out) => [{ type: 'text', text: out.ok ? (out.recordOnly === true ? '[记下了，没有发给任何人]' : '[说出去了]') : `[没记下：${out.note}]` }],
      },
      async execute(args = {}, exec) {
        const who = guardWrite(deps.tenant, exec, 'her_say')
        // 2026-10-30 真机：守卫拒绝后这里原来还往下写——日志里是「写入被拒」，
        // 事件流里却照样多一条「（她主动说）」。拒绝必须当场返回。
        if (!who.ok) return { ok: false, id: '', note: who.note || '这条没记下。' }
        const sid = who?.sessionId ?? ''
        try {
          const r = await writeSay(root, { text: args.text, refs: args.refs, why: args.why, sessionId: sid })
          if (!r.ok) logLine('info', ['her_say：没记下', r.note], root)
          // 配了发送工具的部署里，这一句确实只进了流水，回执得照实说
          const { config } = await loadConfig(root).catch(() => ({ config: {} }))
          return { ok: r.ok, id: r.id ?? '', note: r.note, ...(proactiveConfig(config).sendTools.length > 0 ? { recordOnly: true } : {}) }
        } catch (e) {
          logLine('warn', ['her_say：', e?.message ?? String(e)], root)
          return { ok: false, id: '', note: '这条没记下。' }
        }
      },
    }),
  )
  log('proactive: her_say registered')
}
