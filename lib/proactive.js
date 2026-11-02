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
 * 可见性：工具注册、提示词段、设置页卡片三处共用 devModeSync 的判据，
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
import { randomUUID } from 'node:crypto'

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
/** 空手回合落进对话里的那一句。只说明"没人跟你说话"，不布置任务。 */
export const PROACTIVE_TRIGGER = '（现在没有人跟你说话。）'

/**
 * 读配置并夹紧。老配置没有 proactive 这一组，用默认值。
 * @param {object} config
 * @returns {{enabled:boolean,maxPerDay:number,minIdleHours:number,baseChance:number,gainPerHour:number,maxChance:number,cooldownHours:number}}
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
  }
}

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

/**
 * 哪些事件算「真的发生过一次对话」——idle 时钟只认这些（2026-11-01，用户 m02507）。
 *
 * 原来这里取的是**全部事件的最新一条**，于是 quiet（今天没找到模板）、watched（她看了条视频）、
 * diary（到点写日记）这些系统记账都能把「安静了多久」清零。真机实证：2026-10-30 22:03:07，
 * 她实际 17.55 小时没说过话，插件却判「刚说过话，还不到时候」。本机 441 条事件里
 * meta:quiet 占 272 条（61.7%），真正的人话只有 28 条（6.3%）。
 *
 * 算数：她自己的六种（HER_TYPES）+ 听见的话（heard）+ 别人的评论（voice）
 *       + 请求与回答（ask/answer）+ 以 seen: 开头的 meta（「他来过」）。
 * 不算：quiet / sched / wake / fired / sleep / diary / looked / browse / watched / proactive-turn 等记账行。
 */
export const SPOKE_TYPES = Object.freeze([...HER_TYPES, 'heard', 'voice', 'ask', 'answer'])

/** 这一条事件是不是「有人真的说了话」。记账行一律不算。 */
export function countsForIdle(e) {
  const type = String(e?.type ?? '')
  if (type === 'meta') return String(e?.text ?? '').startsWith('seen:')
  return SPOKE_TYPES.includes(type)
}

/** 距离上一次**真的有人说话**，过了多少小时。没有记录时返回 Infinity。 */
export function idleHoursOf(events = [], now = Date.now()) {
  let last = 0
  for (const e of events) {
    if (!countsForIdle(e)) continue
    const ts = tsMs(e)
    if (Number.isFinite(ts) && ts > last) last = ts
  }
  if (!last) return Infinity
  return Math.max(0, (now - last) / 3_600_000)
}

/**
 * 这一次该不该开门。纯函数：不读文件、不掷骰子。
 * @returns {{ok:boolean, why:string, chance:number, idleHours:number, dk:string}}
 */
export function proactiveState({ config = {}, events = [], now = Date.now(), away = null, rested = false } = {}) {
  const cfg = proactiveConfig(config)
  const dk = dateKey(new Date(now))
  const idleHours = idleHoursOf(events, now)
  const base = { chance: 0, idleHours, dk }
  if (!cfg.enabled) return { ...base, ok: false, why: '主动说话是关着的' }
  // 只在醒着的时间窗里：凌晨三点收到一句「我想你了」不是她自主，是她打乱了作息。
  // 配置里没有 window 时（测试/老数据）不拦，保持纯函数可测。
  const win = Array.isArray(config?.window) && config.window.length === 2 ? config.window : null
  if (win && !inWindow({ window: win }, new Date(now))) return { ...base, ok: false, why: '这个点不在她醒着的时段里' }
  if (away?.kind) return { ...base, ok: false, why: '她不在家' }
  if (rested) return { ...base, ok: false, why: '她今天请了假' }
  if (turnsToday(events, dk) >= cfg.maxPerDay) return { ...base, ok: false, why: '今天已经到上限' }
  const last = lastTurnAt(events)
  if (last && (now - last) / 3_600_000 < cfg.cooldownHours) return { ...base, ok: false, why: '还在冷却里' }
  if (idleHours < cfg.minIdleHours) return { ...base, ok: false, why: '刚说过话，还不到时候' }
  const chance = Math.min(cfg.maxChance, cfg.baseChance + Math.max(0, idleHours - cfg.minIdleHours) * cfg.gainPerHour)
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
export function proactiveSection({ now = Date.now(), state = {}, material = [], loose = [] } = {}) {
  const at = new Date(now)
  const hh = String(at.getHours()).padStart(2, '0')
  const mm = String(at.getMinutes()).padStart(2, '0')
  const idle = Number.isFinite(state.idleHours) ? `${state.idleHours.toFixed(1)} 小时` : '很久'
  const lines = [
    '（现在没有人跟你说话。这一轮不是谁找你，也不是日程安排的醒；是你自己醒着，想不想开口由你。）',
    `现在是 ${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${hh}:${mm}；距离上一次留下记录已经 ${idle}。`,
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
  lines.push('想说什么就说，不用等他先问——这一轮你写下的字会落在你们俩的对话里，他看得见。也可以再用 her_say 把它记进你自己的流水（refs 指回上面真实发生的事，1–6 条 id）。不想说，就这一轮什么都别做，不算失败。')
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
 * 注册 `her_say`。只在 devModeSync 为真时由 index.js 调用。
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
        // 2026-10-31 真机（10-30 那两轮）：这里原来直接返回字符串，宿主按 ContentBlock
        // 数组处理，`content.some` 当场抛 TypeError。她看到的工具结果是「Error: content.some
        // is not a function」——写入其实成功了，她却以为工具坏了，重试一次后放弃，一个字没说。
        // 签名同样是 (args, out)，跟 lib/keep.js:97 那些一样。
        render: (_args, out) => [{ type: 'text', text: out.ok ? '[说出去了]' : `[没记下：${out.note}]` }],
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
          return { ok: r.ok, id: r.id ?? '', note: r.note }
        } catch (e) {
          logLine('warn', ['her_say：', e?.message ?? String(e)], root)
          return { ok: false, id: '', note: '这条没记下。' }
        }
      },
    }),
  )
  log('proactive: her_say registered')
}

/**
 * 找到那一轮空手回合的「触发语」在会话里的 seq。
 *
 * 为什么按 rpcId 找：prompt 的 requestId 是 `proactive-<ts>`，宿主会把它原样写进
 * `source.rpcId`；按文本匹配容易被她把这句话复述一遍骗过去（2026-10-30 m05007）。
 */
export function findTriggerSeq(events = [], rpcId = '') {
  if (!rpcId) return 0
  for (const ev of Array.isArray(events) ? events : []) {
    if (ev?.type !== 'user/message') continue
    const src = ev?.data?.source ?? {}
    if (String(src.rpcId ?? '') === String(rpcId)) return Number(ev?.seq) || 0
  }
  return 0
}

/**
 * 替换用的空 system 节点。
 *
 * **必须带 `id`**：宿主 v4 格式的 `assertV4SystemMessageFields` 会校验
 * `string(message.id, 'system message id', true)`，缺了就抛
 * `format v4 system message id requires a string with content`。
 * 更狠的是它在**写盘时**才校验：`Session.append()` 同步成功并返回 seq，
 * 200ms 后 drain 到 `encodeEventBatch` 才抛，那一批被塞回 buffer 并置
 * `drainPaused = true` —— 那条会话从此再也写不进任何事件（2026-11-01
 * 真机：她会话文件停在 14:53:31，之后她那一轮的回复全丢）。
 * 宿主自己的 `createSystemMessage()` 也是这么给的（createMessage 注入 randomUUID）。
 *
 * **还必须带 `source`**（2026-11-02 补，用户 m01140 报的会话打不开就是这个）：
 * v4 加载期 `assertV4MessageSources` 要求每条消息的 `source.kind` 是
 * 「producer-owned」的——非空字符串且不等于 `'plugin'`，缺了抛
 * `format v4 message requires a producer-owned source kind`，
 * 一条坏节点就让**整条会话打不开**（`stored session ... is corrupt`）。
 * 宿主自己造空 system 节点时写的就是 `{ kind: 'system-prompt' }`，
 * 这里照抄（`absence` / `resident` 这类「不是谁说的话」在内核里也归这一类）。
 */
function hiddenMessage() {
  return { id: randomUUID(), role: 'system', content: [], source: { kind: 'system-prompt' } }
}

/**
 * 扫描事件流，算出「此刻有没有开着的回合/步骤」。
 *
 * 这是 2026-11-02 那次事故的直接教训（用户 m01140/m01418：「跟大肥鱼说话」那条
 * 会话打不开，报 `system/message does not match an open turn and step`）。
 *
 * 宿主 v4 的 `Relationships.requireStep` 硬性要求：`system/message` 属
 * `STEP_EVENT_TYPES`，写进去时 `data.turn`/`data.step` 必须等于**那一刻正开着**的
 * turn/step；`turn/end` 之后再 append 一律抛，而这条错在**加载期**触发，
 * 一条坏节点就能让整条对话打不开。
 *
 * 以前的写法是「按目标消息所在的回合填 turn/step」——看着更诚实，但回合早就结束了，
 * 填得再准也是往已关闭的回合里写。正确做法是：只在有回合开着的时候写，并且
 * **填当下开着的那个 turn/step**（replace 的目标在哪个回合无所谓，surface 允许）。
 */
export function openTurnOf(events = []) {
  let turn = 0
  let step = 0
  let turnOpen = false
  let stepOpen = false
  for (const ev of Array.isArray(events) ? events : []) {
    switch (ev?.type) {
      case 'turn/start':
        turn = Number(ev?.data?.turn) || turn
        turnOpen = true
        stepOpen = false
        step = 0
        break
      case 'turn/end':
        turnOpen = false
        stepOpen = false
        step = 0
        break
      case 'step/start':
        step = Number(ev?.data?.step) || step
        stepOpen = true
        break
      case 'step/end':
        stepOpen = false
        break
      default:
        break
    }
  }
  const open = turnOpen && stepOpen && turn > 0 && step > 0
  return { open, turn, step }
}

/** 待收的触发语（rpcId）：回合外写不了，等下一轮开起来再收。 */
const pendingHides = []
const PENDING_MAX = 20
/** 待收的历史遗留触发语（按 seq，来自补扫）：同样要等回合开着才能写。 */
const pendingSeqs = []

function rememberHide(rpcId) {
  if (!rpcId || pendingHides.includes(rpcId)) return
  pendingHides.push(rpcId)
  if (pendingHides.length > PENDING_MAX) pendingHides.shift()
}

function forgetHide(rpcId) {
  const i = pendingHides.indexOf(rpcId)
  if (i >= 0) pendingHides.splice(i, 1)
}

/** 仅供测试：看还有哪些没收走。 */
export function pendingHidesOf() {
  return { rpcIds: pendingHides.slice(), seqs: pendingSeqs.slice() }
}

/** 仅供测试：清空待收队列（每个用例之间互不影响）。 */
export function resetPendingHides() {
  pendingHides.length = 0
  pendingSeqs.length = 0
}

/**
 * 把触发语从对话里收走：追加一个空 system 节点，用 surface replace 盖掉那条 user/message。
 *
 * 为什么只能事后盖：宿主没有「模型看得见、用户看不见」的 prompt 通道；`surfaceOp`
 * 只有 append / replace，空 content 的 system 节点不投影任何消息（插件文档原文）。
 * 回合结束前不动它——turn 正在跑的时候改 surface，等于在别人走路时抽地板。
 */
export function hideTrigger(session, { rpcId = '', log } = {}) {
  if (!session || !rpcId) return false
  if (typeof session.snapshotEvents !== 'function' || typeof session.append !== 'function') return false
  try {
    const events = session.snapshotEvents(0)
    const seq = findTriggerSeq(events, rpcId)
    if (!seq) {
      log?.('proactive hide skipped', `找不到 ${rpcId}`)
      forgetHide(rpcId)
      return false
    }
    // 回合没开着就不能写（写进去的是坏节点，会让整条对话打不开）。
    // 记下来，等她下一轮开起来再收——见 openTurnOf 的注释。
    const open = openTurnOf(events)
    if (!open.open) {
      rememberHide(rpcId)
      log?.('proactive hide deferred', `${rpcId} 等下一轮再收`)
      return false
    }
    session.append(
      'system/message',
      { turn: open.turn, step: open.step, message: hiddenMessage() },
      // sourceEventSeqs 是宿主记账用的：没有它，替换节点不知道自己是替谁的，
      // 客户端那条消息还会留在 surface 上（2026-10-31 读宿主 RuntimeContextProjection 的写法）。
      { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] },
    )
    forgetHide(rpcId)
    return true
  } catch (e) {
    log?.('proactive hide failed', e?.message ?? String(e))
    return false
  }
}

/**
 * 把攒着的触发语在**新一轮开起来之后**收掉。
 *
 * 为什么要有这一步：回合结束后写不了（宿主要求 turn/step 正好开着），
 * 所以 `hideTrigger` 在回合外只能记账。这个函数由 scheduler 在 `step/start`
 * 时调一次，把上一轮欠下的收尾补上。
 *
 * 只收这一条会话里的、还在等的那几条；收不动就继续等，不抛。
 */
export function flushPendingHides(session, { log } = {}) {
  if (!session || (!pendingHides.length && !pendingSeqs.length)) return 0
  let done = 0
  for (const rpcId of pendingHides.slice()) {
    if (hideTrigger(session, { rpcId, log })) done += 1
    else break
  }
  // 补扫攒下的那批：现在有回合开着了，交给 sweepTriggers 真写（它自己会再判一次）。
  if (pendingSeqs.length) {
    const swept = sweepTriggers(session, { log })
    if (swept > 0) {
      pendingSeqs.length = 0
      done += swept
    }
  }
  if (done) log?.('proactive flush', `补收了 ${done} 条触发语`)
  return done
}

/**
 * 补扫：把历史里遗留的触发语一并收走。
 *
 * 为什么需要它：`hideTrigger` 只有在那一轮回合正常结束时才跑得到；在修好之前触发的
 * 那几轮（2026-10-30 23:03、2026-10-31 15:01）已经把「（现在没有人跟你说话。）」写进
 * 了会话历史，光靠新代码不会自己消失——用户重启后仍然看得见。
 * 这里按**正文完全相等**认（不是包含），避免误伤她复述这句话的正当发言。
 */
export function sweepTriggers(session, { text = PROACTIVE_TRIGGER, log } = {}) {
  if (!session || typeof session.snapshotEvents !== 'function' || typeof session.append !== 'function') return 0
  try {
    const events = session.snapshotEvents(0)
    // 回合没开着就一条都不能写（写进去的是「回合外的 system/message」，
    // 加载期整条对话打不开——2026-11-02 用户 m01418 那次就是这么炸的）。
    // 攒下来，等下一轮 `step/start` 由 flushPendingHides 补收。
    const open = openTurnOf(events)
    if (!open.open) {
      const pending = collectTriggers(events, { text })
      if (pending.length) {
        for (const seq of pending) if (!pendingSeqs.includes(seq)) pendingSeqs.push(seq)
        if (pendingSeqs.length > PENDING_MAX) pendingSeqs.splice(0, pendingSeqs.length - PENDING_MAX)
        log?.('proactive sweep deferred', `${pending.length} 条等下一轮再收`)
      }
      return 0
    }
    // 已经被收走过的别再收一次：否则每次启动都会往历史里多叠一个空节点。
    const replaced = new Set()
    for (const ev of Array.isArray(events) ? events : []) {
      const op = ev?.data?.surfaceOp ?? ev?.surfaceOp
      if (op?.op === 'replace' && op.startSeq) replaced.add(Number(op.startSeq))
    }
    const targets = collectTriggers(events, { text })
    let done = 0
    for (const seq of targets) {
      session.append(
        'system/message',
        { turn: open.turn, step: open.step, message: hiddenMessage() },
        { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] },
      )
      done += 1
    }
    if (done) log?.('proactive sweep', `收走了 ${done} 条遗留触发语`)
    return done
  } catch (e) {
    log?.('proactive sweep failed', e?.message ?? String(e))
    return 0
  }
}

/**
 * 找出历史里还没被收走的触发语（正文完全相等，不误伤她复述）。
 * 抽出来是因为 sweepTriggers 和「回合外攒着」两条路径都要用同一套判据。
 */
function collectTriggers(events, { text = PROACTIVE_TRIGGER } = {}) {
  const replaced = new Set()
  for (const ev of Array.isArray(events) ? events : []) {
    const op = ev?.data?.surfaceOp ?? ev?.surfaceOp
    if (op?.op === 'replace' && op.startSeq) replaced.add(Number(op.startSeq))
  }
  const out = []
  for (const ev of Array.isArray(events) ? events : []) {
    if (ev?.type !== 'user/message') continue
    const seq = Number(ev?.seq) || 0
    if (!seq || replaced.has(seq)) continue
    const parts = Array.isArray(ev?.data?.content) ? ev.data.content : []
    const body = parts.map((p) => (p?.type === 'text' ? String(p.text ?? '') : '')).join('').trim()
    if (body === String(text).trim()) out.push(seq)
  }
  return out.sort((a, b) => a - b)
}
