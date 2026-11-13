/**
 * doing.js —— 主动做事（2026-11-14，用户 m01237 定案）
 *
 * 她可以不只是开口，也可以自己动手做一件事。这里只做三件事：
 *   1. 判断「这一轮算不算动手回合」（scheduler 在投递前打标记）；
 *   2. 在动手回合里给消耗类工具上闸：一轮一件、一天一件、同一件隔三天、
 *      连着三次同类歇一周；
 *   3. 把真的做成的事记成 `did:`（只认工具真的返回了，不认她嘴上说做了）。
 *
 * 三条边界：
 *   - 分类不靠工具名猜。自家工具写死；外面的工具默认 effect（不拦、也不自动
 *     当消耗类摆上桌），用户可以在设置里改。宿主只把工具名给插件，看不到
 *     工具定义，所以没有「按声明自动识别」这回事——说清楚比猜一个强。
 *   - 只在动手回合生效。他自己找她说话、定时叫醒，都不经过这里。
 *   - 数字只在插件内部用，不进她的身份文档，也不回显给她。
 */

import { tsMs } from './schema.js'
import { appendEvent, readEvents } from './store.js'
import { loadConfig } from './settings.js'

export const DOING_DEFAULTS = Object.freeze({
  enabled: false,
  consumePerDay: 1,
  itemCooldownDays: 3,
  bingeLimit: 3,
  bingeRestDays: 7,
})

export const DOING_CLASSES = Object.freeze(['produce', 'consume', 'effect', 'self'])

/** 自家工具的分类。read_image 也算「看」，按消耗类算。 */
export const OWN_CLASS = Object.freeze({
  bili_look: 'consume',
  bili_watch: 'consume',
  bili_sub: 'consume',
  read_image: 'consume',
  her_diary: 'produce',
  bili_speak: 'effect',
  her_leave: 'effect',
  bring_back: 'effect',
  growth_commit: 'self',
  her_recall: 'self',
  her_note: 'self',
  her_appoint: 'self',
  her_dream: 'self',
  her_say: 'self',
  ask_owner: 'self',
  ask_pronoun: 'self',
})

const MARK_MS = 2 * 3600_000
const DID = 'did:'

/** 动手回合的标记只存在进程里；按会话分开，重启后没有标记也就不会误拦。 */
const turns = new Map()

function prune(now) {
  for (const [sid, t] of turns) if (now - t.at > MARK_MS) turns.delete(sid)
}

function num(v, fallback, lo, hi) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

/** 读设置。键都在 config.proactive 下，和「主动搭话」共用一张卡。 */
export function doingConfig(config = {}) {
  const raw = config && typeof config.proactive === 'object' && config.proactive ? config.proactive : {}
  return {
    enabled: raw.allowDoing === true,
    consumePerDay: num(raw.consumePerDay, DOING_DEFAULTS.consumePerDay, 0, 6),
    itemCooldownDays: num(raw.itemCooldownDays, DOING_DEFAULTS.itemCooldownDays, 0, 30),
    bingeLimit: num(raw.bingeLimit, DOING_DEFAULTS.bingeLimit, 2, 10),
    bingeRestDays: num(raw.bingeRestDays, DOING_DEFAULTS.bingeRestDays, 1, 60),
  }
}

/** 工具分类：设置里的覆盖优先，其次自家表，最后按 effect（不拦、不自动摆上桌）。 */
export function classOf(name, config = {}) {
  const n = String(name ?? '').trim()
  if (!n) return 'effect'
  const over = config?.proactive?.toolClasses
  if (over && typeof over === 'object' && DOING_CLASSES.includes(over[n])) return over[n]
  return OWN_CLASS[n] ?? 'effect'
}

/** 同一件事的键：优先 bvid/id/path，其次 query，最后退回工具名。 */
export function itemKey(name, args) {
  const tool = String(name ?? '').trim() || 'tool'
  let a = args
  if (typeof a === 'string') {
    try { a = JSON.parse(a) } catch { a = null }
  }
  if (!a || typeof a !== 'object') return tool
  for (const k of ['bvid', 'id', 'path', 'file', 'query', 'keyword', 'title', 'name']) {
    const v = a[k]
    if (typeof v === 'string' && v.trim()) return `${tool}:${v.trim().slice(0, 60)}`
  }
  return tool
}

export function didText({ cls, tool, ok, key }) {
  return `${DID}${cls}:${tool}:${ok ? 'ok' : 'fail'}:${key}`
}

/** `did:<cls>:<tool>:ok|fail:<key>`；key 放最后，路径里的冒号不会被切开。 */
export function parseDid(text) {
  const s = String(text ?? '')
  if (!s.startsWith(DID)) return null
  const rest = s.slice(DID.length).split(':')
  if (rest.length < 4) return null
  const [cls, tool, flag, ...key] = rest
  if (!DOING_CLASSES.includes(cls)) return null
  return { cls, tool, ok: flag === 'ok', key: key.join(':') }
}

function didOf(events = []) {
  const out = []
  for (const e of events) {
    if (e?.type !== 'meta') continue
    const d = parseDid(e.text)
    if (!d) continue
    out.push({ ...d, ts: tsMs(e) || 0 })
  }
  return out.sort((a, b) => a.ts - b.ts)
}

function localDay(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function startOfLocalDay(ms) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * 今天/最近做过什么。只数真的成功了的（ok）。
 * @returns {{consumeToday:number, byClass:Object, last:Array, lastAt:number}}
 */
export function doingUsage(events = [], now = Date.now()) {
  const all = didOf(events).filter((d) => d.ok)
  const consumeToday = all.filter((d) => d.cls === 'consume' && d.ts >= startOfLocalDay(now)).length
  const byClass = { produce: 0, consume: 0, effect: 0, self: 0 }
  for (const d of all) byClass[d.cls] = (byClass[d.cls] ?? 0) + 1
  return { consumeToday, byClass, last: all.slice(-6), lastAt: all.length ? all[all.length - 1].ts : 0 }
}

/**
 * 消耗类调用能不能放行。只看消耗类；产出/外效/自己的事不设日限。
 * @returns {{ok:true, cls:string, key:string} | {ok:false, reason:string, code:string}}
 */
export function checkDoing({ name, args, events = [], now = Date.now(), config = {} } = {}) {
  const cfg = doingConfig(config)
  const cls = classOf(name, config)
  const key = itemKey(name, args)
  const all = didOf(events).filter((d) => d.ok)

  if (cfg.consumePerDay <= 0) {
    return { ok: false, code: 'off', reason: '今天不做这样的事了。' }
  }
  const today = all.filter((d) => d.cls === 'consume' && d.ts >= startOfLocalDay(now)).length
  if (today >= cfg.consumePerDay) {
    return { ok: false, code: 'daily', reason: '今天已经做过这样的事了，明天再说。' }
  }
  const same = all.filter((d) => d.key === key && now - d.ts < cfg.itemCooldownDays * 86400_000)
  if (same.length) {
    return { ok: false, code: 'item', reason: '这件事前几天刚做过，过几天再说。' }
  }
  const tail = all.slice(-cfg.bingeLimit)
  if (tail.length >= cfg.bingeLimit && tail.every((d) => d.cls === 'consume')) {
    const last = tail[tail.length - 1].ts
    if (now - last < cfg.bingeRestDays * 86400_000) {
      return { ok: false, code: 'binge', reason: '连着做了几次，先歇几天。' }
    }
  }
  return { ok: true, cls, key }
}

/** 这一轮是不是动手回合。会话对不上或超过两小时就当没有。 */
export function doingTurnOf(sessionId, now = Date.now()) {
  const sid = String(sessionId ?? '')
  if (!sid) return null
  prune(now)
  return turns.get(sid) ?? null
}

export function markDoingTurn(sessionId, now = Date.now()) {
  if (!sessionId) return null
  prune(now)
  const t = { sessionId: String(sessionId), at: now, consumeUsed: false, calls: new Map() }
  turns.set(t.sessionId, t)
  return t
}

export function clearDoingTurn(sessionId) {
  if (sessionId) turns.delete(String(sessionId))
  else turns.clear()
}

/**
 * 她自己的记录里点到过哪件手边的工具。
 *
 * 只认「记录原文里出现了工具名」的；不列全量工具清单——那是菜单，会把
 * 处境变成派活。没点到就一个都不提。
 */
export function mentionedTools(records = [], tools = []) {
  const names = (Array.isArray(tools) ? tools : []).map((t) => String(t ?? '').trim()).filter(Boolean)
  const said = (Array.isArray(records) ? records : []).map((m) => String(m?.text ?? '')).join('\n').toLowerCase()
  if (!names.length || !said) return []
  return names.filter((n) => {
    const esc = n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^a-z0-9_])${esc}($|[^a-z0-9_])`).test(said)
  }).slice(0, 3)
}

/** 给处境用的那一句。只给许可和边界，不写「你应该做点什么」。 */
export function doingSection({ material = [], loose = [], tools = [], notes = [] } = {}) {
  const hinted = mentionedTools([...material, ...loose], tools)
  const lead = hinted.length ? `你之前提过 ${hinted.join('、')}，它们就在手边。` : ''
  // 便条只作她自己的材料：不写「到期」「该做了」，最多两张，不列清单。
  const own = (Array.isArray(notes) ? notes : [])
    .map((n) => String(n?.text ?? '').trim())
    .filter(Boolean)
    .slice(0, 2)
    .map((t) => (t.length > 40 ? `${t.slice(0, 40)}…` : t))
  const mine = own.length ? `你自己记下的：${own.join('；')}。` : ''
  return `${lead}${mine}这一轮是动手的：想做的那件事，如果手边有工具能做，就直接做，不用先把这件事说出来。手边有什么、各自能做什么，这一轮你看得到；没有对得上的，就照旧。做一件就收，不用接着做第二件；没有能做的，就什么都不做，也不用写解释。`
}

function sessionOf(exec) {
  const s = exec?.agent?.session
  if (typeof s === 'string') return s
  return String(s?.id ?? exec?.agent?.sessionId ?? exec?.session?.id ?? exec?.sessionId ?? '')
}

function argsOf(exec) {
  const a = exec?.args ?? exec?.arguments ?? exec?.call?.arguments ?? null
  if (typeof a === 'string') {
    try { return JSON.parse(a) } catch { return null }
  }
  return a
}

/**
 * 注册两个观察点。pre-execute 负责拦，result 负责记账。
 * 拿不到会话、不是动手回合、开关关着，一律 `next()` 放行——这里不是权限层。
 */
export function registerDoingHooks(ctx, { root, log = () => {} } = {}) {
  if (!ctx?.on) return () => {}
  const offs = []

  offs.push(ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      const t = doingTurnOf(sessionOf(exec))
      if (!t) return next()
      const { config } = await loadConfig(root)
      if (!doingConfig(config).enabled) return next()
      const cls = classOf(exec?.name, config)
      const key = itemKey(exec?.name, argsOf(exec))
      const ref = String(exec?.callId ?? exec?.token ?? `${exec?.name}:${Date.now()}`)
      // 消耗类之外也记一笔，好让 result 知道该写 did；但不拦。
      if (cls === 'self') return next()
      if (cls !== 'consume') {
        t.calls.set(ref, { cls, tool: String(exec?.name ?? ''), key })
        return next()
      }
      if (t.consumeUsed) {
        return { kind: 'deny', reason: '这一轮已经做过一件了，做完就收。', info: { name: 'DoingLimit', code: 'DOING_TURN' } }
      }
      const { events } = await readEvents(root)
      const verdict = checkDoing({ name: exec?.name, args: argsOf(exec), events, now: Date.now(), config })
      if (!verdict.ok) {
        log('doing', `拦下一次 ${exec?.name}：${verdict.code}`)
        return { kind: 'deny', reason: verdict.reason, info: { name: 'DoingLimit', code: verdict.code.toUpperCase() } }
      }
      t.consumeUsed = true
      t.calls.set(ref, { cls, tool: String(exec?.name ?? ''), key })
      return next()
    } catch {
      return next()
    }
  }))

  offs.push(ctx.on('tools/result', async (exec, result) => {
    try {
      const t = doingTurnOf(sessionOf(exec))
      if (!t) return
      const ref = String(exec?.callId ?? exec?.token ?? '')
      let call = t.calls.get(ref)
      if (!call && t.calls.size === 1) call = [...t.calls.values()][0]
      if (!call) return
      t.calls.delete(ref)
      const ok = !(result?.isError === true || result?.ok === false)
      await appendEvent(
        { type: 'meta', text: didText({ cls: call.cls, tool: call.tool, ok, key: call.key }) },
        { day: 0, stage: 1, source: 'system' },
        root,
      ).catch(() => {})
      log('doing', `记下 ${call.tool} ${ok ? '做成' : '没做成'}`)
    } catch { /* 观察点不改变调用结果 */ }
  }))

  return () => {
    for (const off of offs) {
      try {
        if (typeof off === 'function') off()
        else off?.off?.()
      } catch { /* ignore */ }
    }
  }
}
