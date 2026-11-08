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
 *      cooldownHours；到点也不一定开口（只剩功能闸门，概率那套已按 issue #67 删掉）。
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
import { deriveSelf } from './derive.js'
import { toolArrived } from './wish.js'

/** 一天的默认上限。 */
export const PROACTIVE_DEFAULTS = Object.freeze({
  enabled: false,
  maxPerDay: 2,
  minIdleHours: 6,
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
 * 「缺工具就开口要」（2026-11-05，用户 m02031；2026-11-07 撤销，用户 m01602）。
 *
 * 原来这里是一个常量 `TOOL_ASK_NOTE`，`lib/scheduler.js` 每次醒来都把它摆进正文：
 * 「如果你想到要做什么、但手上没有那件工具：直接说你要它做什么，问主人能不能给你装上」。
 *
 * 用户 2026-11-07 判定这属于「把提醒换成后台反复催她」：同一句话每天读两遍，
 * 读久了就不是她的念头，是系统的吩咐。撤掉之后换成两个位置——
 *
 *   B 撞墙才说 —— `lib/restrict.js` 的 `blockedTalk()` 末尾补一句，只在真被拦住时出现。
 *   D 交给劲儿 —— 这件事攒在 `lib/drive.js` 的劲儿里（boostWish），攒够了那一轮才醒；
 *     醒的时候它作为桌上一行出现（`lib/wish.js` 的 `wishesOf` + `lib/desk.js` 的 wishes）。
 *
 * 所以这个模块不再导出任何「常驻提醒」。留这段注释是为了让后来的人知道它为什么消失，
 * 而不是以为漏写了。
 */

/**
 * 读配置并夹紧。老配置没有 proactive 这一组，用默认值。
 * @param {object} config
 * @returns {{enabled:boolean,maxPerDay:number,minIdleHours:number,cooldownHours:number,sendTools:string[],foldSilent:boolean,idleCountsSeen:boolean}}
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
    // issue #69 / PR #76：与设置页卡面一致，1–24 小时；0 会把「安静多久」变成永远不满足
    minIdleHours: num(raw.minIdleHours, PROACTIVE_DEFAULTS.minIdleHours, 1, 24),
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

/**
 * 今天已经用 her_say 说过几次（meta `proactive-say:<dk>:<why>`）。
 *
 * 2026-11-06（issue #41）：工具描述一直写着「一天最多几次」，但 `writeSay` 读了配置
 * 只为了别的用途，从来不数——`maxPerDay` 设 0 也能连着写 8 次。这里按她自己记下的
 * 那条记账数，判据只有同一份 `maxPerDay`，不另设数字。
 *
 * 只数 `proactive-say:`，不数 `proactive-turn:`：后者是「空手回合开过几次」，
 * 前者是「她真的开口了几次」。两件事分开记（见上面 SILENT_MARK 那段）。
 */
export function saysToday(events = [], dk = '') {
  if (!dk) return 0
  let n = 0
  for (const e of events) {
    if (e?.type !== 'meta') continue
    if (String(e.text ?? '').startsWith(`proactive-say:${dk}:`)) n += 1
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
 * 她自己的冷却随处境变（2026-11-08，issue #67）。
 *
 * 2026-11-04 曾在这里用三个配置键（baseChance / gainPerHour / maxChance）算「这次开口的概率」，
 * 但那股劲儿后来由 `lib/drive.js` 的 `driveOf` 统一管，`chance` 全仓没人读——用户裁定
 * 直接删掉，不留下永不生效的数字。这里只剩冷却：刚有人跟她说过话，余温还在，不必等满。
 *
 * @returns {{cooldownHours:number}}
 */
function growthLevers(model, events = [], now = Date.now(), cfg = {}) {
  let cooldownHours = cfg.cooldownHours
  let lastHeard = 0
  for (const e of events) {
    const type = String(e?.type ?? '')
    if (type !== 'heard' && type !== 'answer') continue
    const ts = tsMs(e)
    if (!Number.isFinite(ts)) continue
    if (ts > lastHeard) lastHeard = ts
  }
  // 刚有人跟她说过话：余温还在，冷却不必等满 4 小时。
  if (lastHeard && now - lastHeard <= 86_400_000) cooldownHours = Math.min(cooldownHours, 2)
  return { cooldownHours }
}

/**
 * 这一次该不该开门。纯函数：不读文件、不掷骰子。
 * @param {object} [opts.model] 她当前的成长档案（`deriveSelf()` 的返回）。
 *   传了才启用「节奏随成长变」；不传 = 2026-11-04 之前的恒温行为。
 * @returns {{ok:boolean, why:string, idleHours:number, dk:string}}
 */
export function proactiveState({ config = {}, events = [], now = Date.now(), away = null, rested = false, model = null } = {}) {
  const cfg = proactiveConfig(config)
  const dk = dateKey(new Date(now))
  const idleHours = idleHoursOf(events, now, { countSeen: cfg.idleCountsSeen })
  const base = { idleHours, dk }
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
  // 冷却随处境变（见 growthLevers）；不传 model 时就是配置原值（老调用方行为不漂）。
  const lv = model ? growthLevers(model, events, now, cfg) : { cooldownHours: cfg.cooldownHours }
  const last = lastTurnAt(events)
  if (last && (now - last) / 3_600_000 < lv.cooldownHours) return { ...base, ok: false, why: '还在冷却里' }
  if (idleHours < cfg.minIdleHours) return { ...base, ok: false, why: '刚说过话，还不到时候' }
  return { ...base, ok: true, why: '' }
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

/**
 * 还悬着的事：她问过但没人答、答了却还没兑现（用户 m01602，2026-11-07）。
 *
 * 原来的写法只摆**没答**的 ask：一张卡只要被答过（哪怕是「以后再说」）就永远消失。
 * 2026-10-29 那张「有没有办法让我看整条视频的画面」被答「以后再说」之后，线索就断了——
 * 她再也没想起过。用户判定这属于「她开口了、被答了、然后线索消失了」。
 *
 * 现在按裁决分几种活法（窗口与 `lib/wish.js` 对齐，口径也由它给）：
 *   pending  还没答 / 放一天没人答 —— 摆 3 天，文案「你问过「…」，还没有得到答复。」
 *   later    「以后再说」 —— 摆 30 天，文案「你问过「…」（他说以后再说）。」
 *   approve  他答应了    —— 摆 14 天，文案「你问过「…」（他答应了，还没见到）。」
 *   reject   「这次不行」 —— 不摆。不同意就是不问了，再提一次就成了追问。
 *
 * 只摆事实，不写「你可以再问一次」——那是派活。
 */
export function looseEnds(events = [], { now = Date.now(), has = null } = {}) {
  const out = []
  const answers = new Map()
  for (const e of events) {
    if (e?.type !== 'answer') continue
    const id = String(e.ask?.askId ?? '')
    if (id) answers.set(id, e)
  }
  for (const e of events) {
    if (e?.type !== 'ask') continue
    // 已经到手的不再悬着（issue #58 / PR #70）：need-tool 的裁决不落实权限，
    // 他只能在卡外给，事件流里没记录，所以拿她此刻的工具名单对一遍。
    if (toolArrived(e, has)) continue
    const ans = answers.get(String(e.id ?? ''))
    // 放一天没人答的卡记成 verdict:'later' + via:'timeout'（`lib/ask.js` 为了不再反复追问），
    // 但那不是「他说以后再说」——什么都没人说。还原成 pending：3 天、还没有得到答复。
    const verdict = String(ans?.ask?.via ?? '') === 'timeout'
      ? 'pending'
      : String(ans?.ask?.verdict ?? '') || 'pending'
    // 不同意就是不问了：再提一次就成了追问。
    if (verdict === 'reject') continue
    const days = verdict === 'pending' ? 3 : verdict === 'approve' ? 14 : 30
    const ts = tsMs(e)
    if (!Number.isFinite(ts) || now - ts > days * 86_400_000) continue
    const text = String(e.text ?? '').trim()
    if (!text) continue
    const tail = verdict === 'later' ? '（他说以后再说）' : verdict === 'approve' ? '（他答应了，还没见到）' : '，还没有得到答复。'
    out.push({ id: e.id, kind: 'ask', text: `你问过「${text}」${tail}` })
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
  // 2026-11-06（issue #41）：原来写「他看得见」。宿主装了什么路由插件，这句就不一定成立
  // （有的渠道会把会话里的字挡在外面）。改成只陈述能保证的部分：字会落进这条对话。
  // 2026-11-06（PR #44）：配了 sendTools 的部署更绝——正文根本发不出去，只有调那件工具才算开口。
  if (sendTools.length > 0) lines.push(`想说什么就用 ${sendTools.join('、')}，不用等他先问。这一轮写下的正文只留在这条会话里，发不到聊天里。不想说，就什么都别写：不要写任何字，也不要解释为什么不说——这一轮没有回复也算正常。`)
  else lines.push('想说什么就说，不用等他先问——这一轮你写下的字会落进你们俩这条对话里。也可以再用 her_say 把它记进你自己的流水（refs 指回上面真实发生的事，1–6 条 id）。不想说，就什么都别写：不要写任何字，也不要解释为什么不说——这一轮没有回复也算正常。')
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
  const cfg = proactiveConfig(config)
  const dk = dateKey(new Date(now))
  // 2026-11-06（issue #41）：说明书与设置页都写着「一天最多几次」、到了上限就说不出去，
  // 但这里原来读了 config 根本没看——maxPerDay 设 0 也能一句接一句地写。
  // 现在按她自己记下的 `proactive-say:` 数到位就停。开关（enabled）只管「要不要自己开一轮」，
  // 不管这个工具本身：工具留着，她想用还是能用，这一点与 README 的说明一致。
  const said = saysToday(events, dk)
  if (said >= cfg.maxPerDay) {
    return { ok: false, note: `今天已经主动开口 ${said} 次，到上限了。明天再说；这不是工具坏了。` }
  }
  // day/stage 必须是真实的成长坐标（2026-11-06，issue #41）：原来写死 {day:1, stage:1}，
  // 而 writeDream 用的是 deriveSelf 的 model.day/model.stage。写死的那条会被
  // consistency() 当成阶段 1 的旧话去处，跟真正说过的话配不上对。
  const model = deriveSelf(events, { growthDays: config.growthDays })
  const stamp = { day: model.day, stage: model.stage, source: 'tool' }
  // appendEvent 返回的就是写进去的那条事件（不是 {ok, event}，0.7.4 那次参数错位就是栽在这），
  // 所以判空只能判返回值本身。
  const stored = await appendEvent(
    { type: 'utterance', text: `（她主动说）${body}`, refs: list, ...(sessionId ? { sessionId } : {}) },
    stamp,
    root,
  ).catch(() => null)
  if (!stored?.id) return { ok: false, note: '这条没记下。' }
  await appendEvent(
    { type: 'meta', text: `proactive-say:${dk}:${why || 'free'}` },
    { day: model.day, stage: model.stage, source: 'system' },
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
        '它只把这句话记进你自己的流水：要让他在对话里看见，得你这一轮直接写出来。',
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
        // 2026-11-06（issue #41）：原来写 `[说出去了]`。可这里只往她自己的流水里落一条，
        // 用户此刻在对话里看不看得见，取决于她这一轮有没有直接写出正文——不是这个工具决定的。
        // 回执只说它真做到的那件事。
        // 2026-11-06（PR #44）：配了 sendTools 的部署里她必须靠工具发话，所以记下的这句确实
        // 没有发给任何人，回执要说清，否则她会以为用户已经看到了。
        render: (_args, out) => [{ type: 'text', text: out.ok ? (out.recordOnly === true ? '[记下了，没有发给任何人]' : '[记下了]') : `[没记下：${out.note}]` }],
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
